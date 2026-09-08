import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, symlink, unlink, readlink, link, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHarness, type HarnessRunOptions } from "../packages/runtime/src/index.ts";
import { RunCheckpoint, rewindCheckpoint } from "../packages/runtime/src/checkpoint.ts";
import { editWorkspaceTool, runWorkspaceCommandTool } from "../packages/tools/src/index.ts";
import { compileTask } from "../packages/task-compiler/src/index.ts";
import { verifyOutput } from "../packages/verifiers/src/index.ts";
import { parseArguments } from "../apps/cli/src/args.ts";
import { repairMetrics } from "../packages/evals/src/repair.ts";
import { EvaluationStore } from "../packages/evals/src/store.ts";
import type { HarnessEvent } from "../packages/contracts/src/index.ts";

const temporary = () => mkdtemp(join(tmpdir(), "tool-repair-"));
type Call = { name: string; args: unknown; raw?: string };
function stream(calls: Call[], turn: number): Response {
	const base = { id: `response-${turn}`, object: "chat.completion.chunk", created: 1, model: "repair-model" };
	const delta = calls.length ? { role: "assistant", tool_calls: calls.map((call, index) => ({ index, id: `call-${turn}-${index}`, type: "function", function: { name: call.name, arguments: call.raw ?? JSON.stringify(call.args) } })) } : { role: "assistant", content: "Completed." };
	return new Response([
		{ ...base, choices: [{ index: 0, delta, finish_reason: null }] },
		{ ...base, choices: [{ index: 0, delta: {}, finish_reason: calls.length ? "tool_calls" : "stop" }] },
	].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
}
async function run(root: string, objective: string, turns: Call[][], extra: Partial<HarnessRunOptions> = {}) {
	let requests = 0;
	const result = await createHarness().run({
		objective, workspaceRoot: root, traceDirectory: join(root, ".harness/runs"), permissionMode: "auto",
		provider: "repair-provider", modelId: "repair-model", maxModelTurns: 8,
		providerConfiguration: { id: "repair-provider", name: "Repair", kind: "openai-compatible", baseUrl: "https://repair.test/v1", apiKey: "test-key" },
		providerFetch: async () => stream(turns[requests] ?? [], ++requests), ...extra,
	});
	const events = (await readFile(result.tracePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as HarnessEvent);
	return { result, events, requests };
}

test("literal edit replacements preserve dollar patterns and reject ambiguous edits", async () => {
	const root = await temporary();
	for (const replacement of ["$", "$$", "$&", "$`", "$'", "$1", "$<name>"]) for (const replaceAll of [false, true]) {
		await writeFile(join(root, "text.txt"), "prefix old suffix");
		await editWorkspaceTool(root).execute("edit", { path: "text.txt", oldText: "old", newText: replacement, replaceAll });
		assert.equal(await readFile(join(root, "text.txt"), "utf8"), `prefix ${replacement} suffix`);
	}
	await writeFile(join(root, "text.txt"), "old old");
	await assert.rejects(editWorkspaceTool(root).execute("edit", { path: "text.txt", oldText: "old", newText: "new" }), /unique match/);
	assert.equal(await readFile(join(root, "text.txt"), "utf8"), "old old");
});

test("malformed final JSON never dispatches any JSON tool", async () => {
	for (const name of ["inspect_workspace", "write_workspace", "edit_workspace", "run_workspace_command"]) {
		for (const raw of ['{"path":"text.txt', '{"path":"text.txt"', '{"path":"text.txt"} garbage']) {
			const root = await temporary();
			await writeFile(join(root, "text.txt"), "original");
			const { events } = await run(root, "Update text.txt", [[{ name, args: null, raw }]], { maxModelTurns: 2 });
			assert.equal(events.filter(({ type }) => type === "tool.started").length, 0, name + raw);
			assert.ok(events.some(({ type, data }) => type === "tool.failed" && String(data.message).includes("Invalid final tool JSON")));
			assert.equal(await readFile(join(root, "text.txt"), "utf8"), "original");
		}
	}
});

test("wrong-file writes and two explicit read targets cannot pass verification", async () => {
	const root = await temporary();
	await writeFile(join(root, "a.txt"), "original");
	const wrong = await run(root, "Update a.txt", [
		[{ name: "inspect_workspace", args: { path: "a.txt" } }],
		[{ name: "write_workspace", args: { path: "b.txt", content: "wrong" } }],
	]);
	assert.equal(wrong.result.verification.passed, false);
	assert.equal(await readFile(join(root, "a.txt"), "utf8"), "original");
	const two = await run(root, "Read missing.txt and a.txt", [
		[{ name: "inspect_workspace", args: { path: "missing.txt" } }],
		[{ name: "inspect_workspace", args: { path: "a.txt" } }],
	]);
	assert.equal(two.result.verification.passed, false);
	assert.equal(repairMetrics(two.events).resolved, 0);
});

test("a corrected target fulfills its sole obligation and retains causal history", async () => {
	const root = await temporary();
	await writeFile(join(root, "a.txt"), "evidence");
	const { result, events } = await run(root, "Read a.txt", [
		[{ name: "inspect_workspace", args: { path: "typo.txt" } }],
		[{ name: "inspect_workspace", args: { path: "a.txt" } }],
	]);
	assert.equal(result.verification.passed, true);
	assert.equal(events.filter(({ type }) => type === "tool.failed").length, 1);
	assert.equal(repairMetrics(events, true).resolved, 1);
	assert.equal(repairMetrics(events).verifiedAfterRepair, true);
	const store = new EvaluationStore(join(root, "eval.sqlite"));
	try { await store.saveRun(result); assert.equal(store.metrics(result.runId).repair.resolved, 1); }
	finally { store.close(); }
});

test("negative and conditional commands do not become positive obligations", () => {
	for (const objective of ["Do not run npm test", "Don't run npm test", "Run npm test if files changed", "Consider npm test", "Never run npm test"]) {
		assert.equal(compileTask({ objective }).requiredCapabilities.includes("workspace-command"), false, objective);
	}
	const task = compileTask({ objective: "Run npm test" });
	assert.equal(verifyOutput("Passed", undefined, { task, commandRuns: [{ argv: ["bash", "-c", "npm test || true"], exitCode: 0 }] }).checks.find(({ id }) => id === "command-success")?.passed, false);
});

test("no-usage loops, batches and repeated failures have shared finite budgets", async () => {
	const root = await temporary();
	const reads = Array.from({ length: 10 }, () => [{ name: "list_workspace", args: { path: "." } }]);
	const loop = await run(root, "Inspect the repository", reads, { maxModelTurns: 3 });
	assert.equal(loop.requests, 3);
	const batch = await run(root, "Inspect the repository", [[...reads[0]!, ...reads[0]!, ...reads[0]!]], { maxToolCalls: 2 });
	assert.equal(batch.events.filter(({ type }) => type === "tool.started").length, 2);
	const failures = await run(root, "Read missing.txt", Array.from({ length: 10 }, () => [{ name: "inspect_workspace", args: { path: "missing.txt" } }]));
	assert.equal(failures.events.filter(({ type }) => type === "tool.started").length, 3);
	assert.ok(failures.requests <= 4);
});

test("abort settles pending approval and ignores a late grant", async () => {
	const root = await temporary();
	const controller = new AbortController();
	let grant!: (approved: boolean) => void;
	let requested!: () => void;
	const waiting = new Promise<void>((resolve) => { requested = resolve; });
	const running = run(root, "Write a.txt", [[{ name: "write_workspace", args: { path: "a.txt", content: "late" } }]], {
		permissionMode: "ask", signal: controller.signal,
		approve: () => { requested(); return new Promise((resolve) => { grant = resolve; }); },
	});
	await waiting;
	controller.abort();
	await assert.rejects(running, /aborted/i);
	grant(true);
	await assert.rejects(readFile(join(root, "a.txt")), { code: "ENOENT" });
});

test("checkpoints restore symlink metadata and oversized creations, report hard-link gaps", async () => {
	const root = await temporary();
	const outside = await temporary();
	await writeFile(join(outside, "untouched"), "outside");
	await symlink(join(outside, "untouched"), join(root, "link"));
	const checkpoint = new RunCheckpoint(root, "links", join(root, ".harness/checkpoint.json"));
	await checkpoint.beforeWorkspace();
	await unlink(join(root, "link"));
	await writeFile(join(root, "link"), "replacement");
	await writeFile(join(root, "large.bin"), Buffer.alloc(3 * 1024 * 1024));
	await checkpoint.afterWorkspace();
	const result = await rewindCheckpoint(checkpoint.path!, root);
	assert.equal(result.coverage, "incomplete");
	assert.ok(result.residual?.includes("<command effects outside snapshot scope>"));
	assert.equal(await readlink(join(root, "link")), join(outside, "untouched"));
	assert.equal(await readFile(join(outside, "untouched"), "utf8"), "outside");
	await assert.rejects(readFile(join(root, "large.bin")), { code: "ENOENT" });
	await writeFile(join(root, "source"), "before");
	const hard = new RunCheckpoint(root, "hard", join(root, ".harness/hard.json"));
	await hard.beforeWorkspace();
	await link(join(root, "source"), join(root, "hard"));
	await hard.afterWorkspace();
	assert.equal(hard.coverage(), "incomplete");
	assert.equal((await rewindCheckpoint(hard.path!, root)).coverage, "incomplete");
});

test("command failure preserves mutation uncertainty and its primary error (fake adapter)", async () => {
	if (process.platform === "win32") return;
	const root = await temporary();
	const shim = join(root, "sandbox");
	await writeFile(shim, '#!/bin/sh\nprintf changed > count.txt\nwhile :; do printf xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done\n');
	await chmod(shim, 0o700);
	const tool = runWorkspaceCommandTool(root, { codexBinary: shim, observer: { before: async () => {}, after: async () => {}, beforeWorkspace: async () => {}, afterWorkspace: async () => { throw new Error("observer failed"); } } });
	await assert.rejects(tool.execute("command", { argv: ["ignored"], timeoutSeconds: 5 }), (error: unknown) => {
		assert.match(String(error), /output exceeds/);
		assert.equal((error as { details: { executionOutcome: string } }).details.executionOutcome, "effects-unknown");
		return true;
	});
	assert.equal(await readFile(join(root, "count.txt"), "utf8"), "changed");
});

test("CLI exposes finite limits and legacy traces have unknown attribution", () => {
	const args = parseArguments(["run", "--max-model-turns", "3", "--max-tool-calls", "4", "--max-duration-ms", "1000", "hello"]);
	assert.equal(args.maxModelTurns, 3); assert.equal(args.maxToolCalls, 4); assert.equal(args.maxDurationMs, 1000);
	assert.throws(() => parseArguments(["run", "--max-duration-ms", "Infinity", "hello"]));
	assert.equal(repairMetrics([]).attribution, "unknown");
});

test("provider retry telemetry separates HTTP attempts from logical model turns", async () => {
	const root = await temporary();
	let requests = 0;
	const { result, events } = await run(root, "Say hello", [], { providerFetch: async () => ++requests === 1
		? Response.json({ error: { message: "limited" } }, { status: 429, headers: { "retry-after": "0" } }) : stream([], 2) });
	assert.equal(result.verification.passed, true);
	assert.equal(events.filter(({ type }) => type === "model.request.started").length, 1);
	assert.equal(repairMetrics(events).providerAttempts, 2);
	assert.equal(events.find(({ type }) => type === "provider.attempt.failed")?.data.failureClass, "rate-limit");
	assert.equal(events.find(({ type }) => type === "provider.retry.scheduled")?.data.delayMs, 0);
});

test("a malformed write can be corrected while the invalid call remains in history", async () => {
	const root = await temporary();
	await writeFile(join(root, "a.txt"), "before");
	const { result, events } = await run(root, "Update a.txt", [
		[{ name: "inspect_workspace", args: { path: "a.txt" } }],
		[{ name: "write_workspace", args: null, raw: '{"path":"a.txt","content":"unsafe' }],
		[{ name: "write_workspace", args: { path: "a.txt", content: "after" } }],
	]);
	assert.equal(result.verification.passed, true);
	assert.equal(await readFile(join(root, "a.txt"), "utf8"), "after");
	assert.equal(events.filter(({ type }) => type === "tool.failed").length, 1);
	assert.equal(repairMetrics(events).resolved, 1);
});

test("deadline settles an approval wait and no-op writes do not verify a change", async () => {
	const root = await temporary();
	await writeFile(join(root, "a.txt"), "before");
	const noOp = await run(root, "Update a.txt", [
		[{ name: "inspect_workspace", args: { path: "a.txt" } }],
		[{ name: "write_workspace", args: { path: "a.txt", content: "before" } }],
	]);
	assert.equal(noOp.result.verification.passed, false);
	await assert.rejects(run(root, "Update a.txt", [[{ name: "write_workspace", args: { path: "a.txt", content: "late" } }]], {
		maxDurationMs: 200, permissionMode: "ask", approve: () => new Promise(() => {}),
	}), /deadline/i);
});

test("causal measurement rejects forged correction relations", async () => {
	const root = await temporary();
	await writeFile(join(root, "a.txt"), "evidence");
	const { events } = await run(root, "Read a.txt", [[{ name: "inspect_workspace", args: { path: "missing.txt" } }], [{ name: "inspect_workspace", args: { path: "a.txt" } }]]);
	const forged = structuredClone(events);
	forged.find(({ type }) => type === "tool.failure.resolved")!.data.correctingCallId = "wrong-call";
	assert.throws(() => repairMetrics(forged, true), /Invalid causal/);
	assert.equal(repairMetrics(forged).attribution, "unknown");
});

test("absence is evidence only for an explicit existence check", async () => {
	const root = await temporary();
	const { result } = await run(root, "Check whether missing.txt exists", [[{ name: "inspect_workspace", args: { path: "missing.txt" } }]]);
	assert.equal(result.verification.passed, true);
	const read = await run(root, "Read missing.txt", [[{ name: "inspect_workspace", args: { path: "missing.txt" } }]]);
	assert.equal(read.result.verification.passed, false);
});

test("Anthropic and Responses finalize raw tool JSON strictly", async () => {
	for (const api of ["anthropic-messages", "openai-responses"] as const) for (const raw of ['{"path":"a.txt","content":"broken', '{"path":"a.txt","content":"broken"} trailing']) {
		const root = await temporary();
		let requests = 0;
		const recorded: HarnessEvent[] = [];
		const result = await createHarness().run({
			objective: "Write a.txt", workspaceRoot: root, traceDirectory: join(root, ".harness"), permissionMode: "auto", maxModelTurns: 2,
			provider: api === "anthropic-messages" ? "anthropic" : "openai", modelId: api === "anthropic-messages" ? "claude-haiku-4-5" : "gpt-5.4-mini",
			providerConfiguration: { id: api === "anthropic-messages" ? "anthropic" : "openai", kind: api === "anthropic-messages" ? "anthropic" : "openai", name: "Test", apiKey: "test-key" },
			observers: [(event) => { recorded.push(event); }],
			providerFetch: async () => {
				requests++;
				const item = { type: "function_call", id: `fc_${requests}`, call_id: `call_${requests}`, name: "write_workspace", arguments: raw };
				const events = api === "anthropic-messages" ? [
					{ type: "message_start", message: { id: `msg_${requests}`, usage: { input_tokens: 1, output_tokens: 0 } } },
					{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `call_${requests}`, name: "write_workspace", input: {} } },
					{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: raw } },
					{ type: "content_block_stop", index: 0 },
					{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
					{ type: "message_stop" },
				] : [
					{ type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
					{ type: "response.function_call_arguments.delta", output_index: 0, delta: raw },
					{ type: "response.output_item.done", output_index: 0, item },
					{ type: "response.completed", response: { id: `resp_${requests}`, status: "completed", output: [item] } },
				];
				return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
			},
		});
		assert.equal(result.verification.passed, false);
		assert.equal(recorded.filter(({ type }) => type === "tool.started").length, 0, api);
		assert.ok(recorded.some(({ type, data }) => type === "tool.failed" && String(data.message).includes("Invalid final tool JSON")), api);
		await assert.rejects(readFile(join(root, "a.txt")), { code: "ENOENT" });
	}
});

test("Pi custom raw-input calls and chunked JSON keep their declared contracts", async () => {
	const entry = new URL("../packages/runtime/node_modules/@earendil-works/pi-ai/dist/index.js", import.meta.url);
	const { processResponsesStream } = await import(new URL("./api/openai-responses-shared.js", entry).href);
	const { AssistantMessageEventStream } = await import(new URL("./utils/event-stream.js", entry).href);
	for (const custom of [false, true]) {
		const raw = custom ? "not JSON: $&\n‘literal’" : '{"path":"a.txt"}';
		const item = custom ? { type: "custom_tool_call", id: "item", call_id: "call", name: "raw", input: raw } : { type: "function_call", id: "item", call_id: "call", name: "read", arguments: raw };
		const events = [
			{ type: "response.output_item.added", output_index: 0, item: custom ? { ...item, input: "" } : { ...item, arguments: "" } },
			...([raw.slice(0, 4), raw.slice(4)]).map((delta) => ({ type: custom ? "response.custom_tool_call_input.delta" : "response.function_call_arguments.delta", output_index: 0, delta })),
			{ type: "response.output_item.done", output_index: 0, item },
			{ type: "response.completed", response: { status: "completed", output: [item] } },
		];
		const output = { role: "assistant", content: [] as Array<{ arguments: unknown }>, stopReason: "pending", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
		await processResponsesStream((async function* () { yield* events; })(), output, new AssistantMessageEventStream(), { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
		assert.deepEqual(output.content[0]?.arguments, custom ? { input: raw } : { path: "a.txt" });
		assert.equal(output.stopReason, "toolUse");
	}
});

test("uncertain commands cannot be replayed and Bash command evidence rejects masking (fake adapter)", async () => {
	if (process.platform === "win32") return;
	const root = await temporary();
	const shim = join(root, "sandbox");
	await writeFile(shim, '#!/bin/sh\nprintf x >> count.txt\nexit 1\n');
	await chmod(shim, 0o700);
	const previous = process.env.CODETONOMY_CODEX_BIN;
	process.env.CODETONOMY_CODEX_BIN = shim;
	try {
		const failed = await run(root, "Run npm test", [
			[{ name: "run_workspace_command", args: { argv: ["npm", "test"] } }],
			[{ name: "list_workspace", args: { path: "." } }],
			[{ name: "run_workspace_command", args: { argv: ["npm", "test"] } }],
		]);
		assert.equal(failed.result.verification.passed, false);
		assert.equal(await readFile(join(root, "count.txt"), "utf8"), "x");
		await writeFile(shim, '#!/bin/sh\nexit 0\n');
		for (const command of ["npm test", "npm test || true"]) {
			const { result } = await run(root, "Run npm test", [
				[{ name: "bash", args: { command: "ls" } }],
				[{ name: "bash", args: { command } }],
			], { toolInterface: "bash" });
			assert.equal(result.verification.passed, command === "npm test", command);
		}
	} finally {
		if (previous === undefined) delete process.env.CODETONOMY_CODEX_BIN;
		else process.env.CODETONOMY_CODEX_BIN = previous;
	}
});
