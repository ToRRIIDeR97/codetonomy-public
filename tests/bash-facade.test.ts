import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildStableSystemPrompt, resolveCapabilities } from "../packages/capability-compiler/src/index.ts";
import type { ToolPermissionRequest } from "../packages/contracts/src/index.ts";
import { EvaluationStore } from "../packages/evals/src/store.ts";
import { createHarness, resolveToolInterface } from "../packages/runtime/src/index.ts";
import { compileTask } from "../packages/task-compiler/src/index.ts";
import { BashCommandPlanner, bashOperationUsesNativeShell, bashPermissionTargets, bashTool, createCodexSandboxInvocation, createNativeBashArgv, parseBashCommand, planBashCommand, searchWorkspaceTool } from "../packages/tools/src/index.ts";

test("bash accelerator parser recognizes its bounded semantics-preserving subset", () => {
	assert.deepEqual(parseBashCommand({ command: "rg -niF 'two words' src", cwd: "packages" }), {
		kind: "search",
		query: "two words",
		path: "packages/src",
		exact: true,
		ignoreCase: true,
	});
	assert.deepEqual(parseBashCommand({ command: "sed -n '20,35p' src/app.ts" }), {
		kind: "read",
		mode: "sed",
		path: "src/app.ts",
		offset: 20,
		limit: 16,
	});
	assert.deepEqual(parseBashCommand({ command: "ls -la src" }), { kind: "list", path: "src", long: true, all: true });
	assert.deepEqual(parseBashCommand({ command: "npm test -- --runInBand", timeoutSeconds: 30 }), {
		kind: "command",
		argv: ["npm", "test", "--", "--runInBand"],
		cwd: ".",
		timeoutSeconds: 30,
	});
	assert.deepEqual(parseBashCommand({ command: "cat /workspace/packages/tools/src/index.ts", cwd: "/workspace/packages" }), {
		kind: "read",
		mode: "cat",
		path: "packages/tools/src/index.ts",
		offset: 1,
		limit: 2_000,
	});
	const quotedRegex = parseBashCommand({ command: String.raw`rg "\bfoo\b"` });
	assert.equal(quotedRegex.kind, "search");
	if (quotedRegex.kind === "search") assert.equal(quotedRegex.query, String.raw`\bfoo\b`);
	const liveCommands = [
		'rg -n -i "permission" packages apps services --max-count 40',
		'rg -n -i "sandbox" packages apps services --max-count 40',
		'rg -n -i "evidence" packages tests',
		"ls packages/permissions tests packages/runtime packages/tools",
		'rg -n "tool" --heading README.md 2>/dev/null || ls',
		'rg -n -i "sandbox" packages apps services tests docs',
		'rg -n -i "verification" packages apps services tests docs | head -80',
		"ls packages/permissions packages/runtime packages/tools packages/verifiers",
	];
	for (const command of liveCommands) assert.doesNotThrow(() => parseBashCommand({ command }), command);
	const multiplePaths = parseBashCommand({ command: 'rg -n -i "permission" packages apps services --max-count 40' });
	assert.equal(multiplePaths.kind, "search");
	if (multiplePaths.kind === "search") {
		assert.deepEqual(multiplePaths.paths, ["packages", "apps", "services"]);
		assert.equal(multiplePaths.maxCount, 40);
	}
	for (const command of [
		"rg token . | tail -10",
		"rg token . | xargs rm",
		"cat file > copy",
		"cat file >> copy",
		"cat < secret",
		"git status && npm test",
		"rg token &",
		"bash -c 'git status; npm test'",
		"powershell.exe -Command 'Get-ChildItem; npm test'",
		"env bash -c 'git status'",
		"busybox sh -c 'git status'",
		"echo $(whoami)",
		"echo $HOME",
		"cat ../secret",
		"cat C:\\secret.txt",
		"cat C:/secret.txt",
		"cat '//server/share/secret'",
		"cat '//?/C:/secret.txt'",
		"rg token --sort path",
	]) assert.throws(() => parseBashCommand({ command }), /bash/);
	assert.throws(() => parseBashCommand({ command: ["echo", ...Array.from({ length: 64 }, () => "x")].join(" ") }), /64-argument/);
	assert.equal(bashOperationUsesNativeShell(parseBashCommand({ command: "npm test" })), true);
	assert.equal(bashOperationUsesNativeShell(parseBashCommand({ command: String.raw`rg 'verification|evidence' packages` })), true);
	assert.deepEqual(createNativeBashArgv("printf '%s\\n' ok").slice(-4), ["--noprofile", "--norc", "-c", "printf '%s\\n' ok"]);
});

test("Bash planner classifies the 29 paid-run commands with stable routes and reasons", () => {
	const commands = [
		String.raw`ls -la && git log --oneline -5 2>/dev/null | head -20`,
		String.raw`rg -l -i "permission" --type ts apps packages services deployment scripts tests .harness 2>/dev/null | head -40`,
		String.raw`rg -l -i "verification evidence|verify|ledger|evidence" packages apps services tests --type ts 2>/dev/null | head -40`,
		String.raw`cat packages/permissions/src/index.ts | head -120`,
		String.raw`rg -n -i "sandbox|permission|verify|evidence" packages/runtime/src/index.ts | head -60`,
		String.raw`rg -n -i "sandbox|verification|evidence|verify" packages/tools/src/index.ts | head -60`,
		String.raw`rg -n -i "evidence|verify|verification" packages/verifiers/src/index.ts | head -60`,
		String.raw`rg -n "completedToolIds|commandRuns|evidence|verifyOutput|observer|recordTool" packages/runtime/src/index.ts | head -60`,
		String.raw`rg -n "completedToolIds|verification|evidence" packages/orchestration/src/index.ts | head -50`,
		String.raw`sed -n 1220,1270p packages/runtime/src/index.ts`,
		String.raw`rg -n "PermissionGate|permission|workspace-evidence|completedToolIds|sandbox" tests/*.test.ts | head -50`,
		String.raw`rg -n "workspace-evidence|completedToolIds|PermissionGate|denied|Approved by user|Declined" tests/*.test.ts | head -40`,
		String.raw`ls packages/permissions tests packages/tools/src packages/tools/test 2>/dev/null; rg -n "PermissionGate" packages tools tests --type ts -l 2>/dev/null | head`,
		String.raw`sed -n 1,40p packages/tools/src/bash-driver.ts; echo ---; rg -n "approve|PermissionGate|createApproval" apps/cli/src/index.ts | head`,
		String.raw`ls -la && find . -maxdepth 2 -type d -not -path '*/\.*' | head -50`,
		String.raw`cat README.md | head -100`,
		String.raw`rg -l -i "tool call|toolcall|tool_call" --type ts packages apps services tests | head -40`,
		String.raw`rg -n -i "permission" packages/runtime/src/index.ts | head -60`,
		String.raw`rg -rln "verification|evidence|verif" tests packages/verifiers packages/runtime apps/cli | head -40`,
		String.raw`cat .git && echo --- && rg -c "lny" README.md packages/verifiers/src/index.ts 2>/dev/null; echo ---; sed -n '1,60p' packages/verifiers/src/index.ts`,
		String.raw`sed -n '60,200p' packages/verifiers/src/index.ts`,
		String.raw`ls packages/permissions/src packages/tools/src packages/runtime/src; echo ---; cat packages/permissions/package.json`,
		String.raw`sed -n '800,900p' packages/runtime/src/index.ts`,
		String.raw`sed -n '1000,1240p' packages/runtime/src/index.ts`,
		String.raw`sed -n '1240,1420p' packages/runtime/src/index.ts`,
		String.raw`ls tests; echo ---; rg -n "PermissionGate|class PermissionGate" packages/permissions/src/index.ts | head; echo ---; rg -n "sandbox|network|native|codex" packages/tools/src/index.ts | head -40`,
		String.raw`sed -n '1,60p' packages/permissions/src/index.ts; sed -n '60,130p' packages/permissions/src/index.ts`,
		String.raw`sed -n '830,915p' packages/tools/src/index.ts`,
		String.raw`rg -n "completedToolIds|workspace-evidence|tool.allowed|tool.denied|PermissionGate|sandbox|run_workspace_command" tests/*.test.ts | head -50`,
	];
	const plans = commands.map((command) => planBashCommand({ command }));
	const routeCounts = plans.reduce<Record<string, number>>((counts, { route }) => ({ ...counts, [route]: (counts[route] ?? 0) + 1 }), {});
	assert.deepEqual(routeCounts, { "parse-fallback": 14, translated: 6, "semantic-native": 9 });
	assert.equal(planBashCommand({ command: String.raw`rg 'verification|evidence' packages` }).reason, "regular-expression");
	assert.equal(planBashCommand({ command: `rg permission --type ts packages` }).reason, "unsupported-option");
	assert.equal(planBashCommand({ command: `rg permission tests/*.test.ts` }).reason, "path-glob");
	const planner = new BashCommandPlanner();
	const args = { command: "sed -n '1,20p' README.md" };
	const planned = planner.plan("cached", args);
	assert.equal(planner.plan("cached", args), planned);
	assert.equal(planner.consume("cached", args), planned);
	assert.notEqual(planner.plan("cached", args), planned);
});

test("bash facade falls back to native Bash for valid syntax outside the accelerator grammar", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-bash-native-"));
	const invocation = createCodexSandboxInvocation(root, createNativeBashArgv("pwd"), { commandSandboxMode: "read-only" });
	const state = JSON.parse(invocation[2]!) as { permissionProfile: { file_system: { entries: Array<{ access: string; path: { type: string; value?: { kind?: string } } }> }; network: string } };
	assert.ok(state.permissionProfile.file_system.entries.some(({ access, path }) => access === "read" && path.value?.kind === "project_roots"));
	assert.equal(state.permissionProfile.network, "restricted");
	assert.ok(invocation.includes("--sandbox-state-disable-network"));
	await writeFile(join(root, "sandbox"), "console.log(JSON.stringify(process.argv.slice(2)));\n", "utf8");
	const result = await bashTool(root, {
		codexBinary: process.execPath,
		commandSandboxMode: "read-only",
		nativeOperationId: "inspect_workspace",
		allowedCanonicalToolIds: ["inspect_workspace"],
	}).execute("native", { command: "printf '%s\\n' tests/*.ts | tail -1" });
	assert.equal((result.details as { bashKind?: string }).bashKind, "native");
	assert.equal((result.details as { parseStatus?: string }).parseStatus, "parse-fallback");
	assert.equal((result.details as { planReason?: string }).planReason, "path-glob");
	assert.equal((result.details as { operationId?: string }).operationId, "inspect_workspace");
	assert.equal((result.details as { filesystem?: string }).filesystem, "read-only");
	assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /--noprofile/);
});

test("direct Bash reads stay bounded", async () => {
 const root = await mkdtemp(join(tmpdir(), "codetonomy-bash-bounded-"));
 await writeFile(join(root, "large.txt"), "x".repeat(100_000));
 const result = await bashTool(root).execute("bounded", { command: "cat large.txt" });
 assert.equal((result.details as { truncated: boolean }).truncated, true);
 assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /truncated/);
});

test("bash keeps rg literal and exposes ranked retrieval through search_workspace", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-bash-tool-"));
	await writeFile(join(root, "README.md"), "alpha needle\nbeta\n", "utf8");
	await mkdir(join(root, "packages"));
	await writeFile(join(root, "packages", "item.ts"), "export const item = true;\n", "utf8");
	await writeFile(join(root, "sandbox"), "console.log('native literal result');");
	const queries: string[] = [];
	const backend = {
		search: async (query: string) => {
			queries.push(query);
			return [{ path: "README.md", content: "alpha needle" }];
		},
	};
	const tool = bashTool(root, { codexBinary: process.execPath });
	const ranked = await searchWorkspaceTool(root, backend).execute("ranked", { query: "where is alpha handled?" });
	assert.equal(ranked.content[0]?.type === "text" ? ranked.content[0].text : "", "README.md:1: alpha needle");
	assert.equal((ranked.details as { backend?: string }).backend, "memoryDB");
	const exact = await tool.execute("exact", { command: "rg -F 'alpha needle' ." });
	assert.match(exact.content[0]?.type === "text" ? exact.content[0].text : "", /native literal result/);
	assert.equal((exact.details as { bashKind?: string }).bashKind, "native");
	assert.deepEqual(queries, ["where is alpha handled?"]);
	const selected = await tool.execute("read", { command: "sed -n '2p' README.md" });
	assert.equal(selected.content[0]?.type === "text" ? selected.content[0].text : "", "beta");
	const listed = await tool.execute("list", { command: "ls", cwd: "/workspace/packages" });
	assert.equal(listed.content[0]?.type === "text" ? listed.content[0].text : "", "/workspace/packages/item.ts");
	const virtualRead = await tool.execute("virtual-read", { command: "cat /workspace/packages/item.ts", cwd: "/workspace/packages" });
	assert.match(virtualRead.content[0]?.type === "text" ? virtualRead.content[0].text : "", /export const item/);
	const fileScoped = await tool.execute("file-scoped", { command: "rg alpha README.md" });
	assert.equal((fileScoped.details as { bashKind?: string }).bashKind, "native");
	assert.deepEqual(queries, ["where is alpha handled?"]);
	await assert.rejects(tool.execute("missing-cwd", { command: "pwd", cwd: "/workspace/missing" }), /ENOENT/);
	await assert.rejects(
		bashTool(root, { allowedCanonicalToolIds: ["list_workspace", "search_workspace", "inspect_workspace"] }).execute("denied", { command: "npm test" }),
		/unavailable.*run_workspace_command/,
	);
});

test("indexed search defaults to Bash and preserves ranked search and verification", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-bash-runtime-"));
	await writeFile(join(root, "README.md"), "indexed project evidence\n", "utf8");
	const store = new EvaluationStore(join(root, "evaluations.sqlite"));
	t.after(() => store.close());
	const requests: Array<Record<string, unknown>> = [];
	const providerFetch: typeof fetch = async (_input, init) => {
		requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		const base = { id: `bash-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "bash-model" };
		const events = requests.length === 1
			? [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "ranked-search", type: "function", function: { name: "search_workspace", arguments: '{"query":"indexed project evidence"}' } }] }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
			]
			: [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "The evidence is in README.md." }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
			];
		return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const result = await createHarness().run({
		objective: "Inspect the workspace and find indexed project evidence",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "bash-provider",
		modelId: "bash-model",
		providerConfiguration: { id: "bash-provider", name: "Bash Provider", kind: "openai-compatible", baseUrl: "https://provider.test/v1", apiKey: "test-key" },
		providerFetch,
		workspaceSearch: { search: async () => [{ path: "README.md", content: "indexed project evidence" }] },
		runStore: store,
	});
	assert.equal(result.verification.passed, true);
	assert.ok(result.capabilities.toolIds.includes("bash"));
	assert.ok(result.capabilities.toolIds.includes("search_workspace"));
	assert.ok(!result.capabilities.toolIds.some((id) => ["list_workspace", "inspect_workspace", "run_workspace_command"].includes(id)));
	const definitions = requests[0]?.tools as Array<{ function?: { name?: string } }>;
	assert.ok(definitions.some(({ function: definition }) => definition?.name === "bash"));
	assert.ok(definitions.some(({ function: definition }) => definition?.name === "search_workspace"));
	const modelRequest = JSON.stringify(requests[0]);
	assert.doesNotMatch(modelRequest, /memoryDB/i);
	assert.match(modelRequest, /ranked project-search tool/);
	const trace = (await readFile(result.tracePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> });
	assert.ok(trace.some(({ type, data }) => type === "tool.completed" && data.toolId === "search_workspace" && data.backend === "memoryDB"));
	assert.deepEqual(store.runDetails(result.runId)?.toolCalls.map(({ toolId, operationId, parseStatus, planReason, backend }) => ({ toolId, operationId, parseStatus, planReason, backend })), [{
		toolId: "search_workspace",
		operationId: null,
		parseStatus: null,
		planReason: null,
		backend: "memoryDB",
	}]);
});

test("tool interface defaults follow the current MemoryDB state and preserve explicit overrides", () => {
	const indexed = { search: async () => [] };
	assert.equal(resolveToolInterface({}), "structured");
	assert.equal(resolveToolInterface({ workspaceSearch: indexed }), "bash");
	assert.equal(resolveToolInterface({ workspaceSearch: indexed, toolInterface: "structured" }), "structured");
	assert.equal(resolveToolInterface({ toolInterface: "bash" }), "bash");
});

test("a corrected Bash call clears an earlier translated read failure", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-bash-recovery-"));
	await writeFile(join(root, "README.md"), "# Bash recovery\n", "utf8");
	const store = new EvaluationStore(join(root, "evaluations.sqlite"));
	t.after(() => store.close());
	let request = 0;
	const providerFetch: typeof fetch = async () => {
		request++;
		const base = { id: `bash-recovery-${request}`, object: "chat.completion.chunk", created: 1, model: "bash-model" };
		const events = request === 1
			? [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "bad-bash", type: "function", function: { name: "bash", arguments: '{"command":"cat missing.txt"}' } }] }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
			]
			: request === 2
				? [
					{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "good-bash", type: "function", function: { name: "bash", arguments: '{"command":"cat README.md"}' } }] }, finish_reason: null }] },
					{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
				]
				: [
					{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "README.md contains the Bash recovery fixture." }, finish_reason: null }] },
					{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
				];
		return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	const result = await createHarness().run({
		objective: "Inspect the workspace and summarize the recovery fixture",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "bash-provider",
		modelId: "bash-model",
		providerConfiguration: { id: "bash-provider", name: "Bash Provider", kind: "openai-compatible", baseUrl: "https://provider.test/v1", apiKey: "test-key" },
		providerFetch,
		toolInterface: "bash",
		runStore: store,
	});
	assert.equal(result.verification.passed, true);
	assert.equal(request, 3);
	const calls = store.runDetails(result.runId)?.toolCalls ?? [];
	assert.ok(calls.every(({ parseStatus, planReason }) => parseStatus === "translated" && planReason === "translated-read"));
	assert.ok(calls.some(({ operationId }) => operationId === "inspect_workspace"));
});

test("bash external commands request the derived command permission", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-bash-permission-"));
	await writeFile(join(root, "README.md"), "permission fixture\n", "utf8");
	let approval: ToolPermissionRequest | undefined;
	const providerFetch: typeof fetch = async () => {
		const base = { id: "bash-permission", object: "chat.completion.chunk", created: 1, model: "bash-model" };
		const events = [
			{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "bash-command", type: "function", function: { name: "bash", arguments: '{"command":"npm test"}' } }] }, finish_reason: null }] },
			{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
		];
		return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	const result = await createHarness().run({
		objective: "Run npm test",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "bash-provider",
		modelId: "bash-model",
		maxModelTurns: 2,
		providerConfiguration: { id: "bash-provider", name: "Bash Provider", kind: "openai-compatible", baseUrl: "https://provider.test/v1", apiKey: "test-key" },
		providerFetch,
		toolInterface: "bash",
		permissionMode: "ask",
		approve: async (request) => { approval = request; return false; },
	});
	assert.equal(result.verification.passed, false);
	assert.equal(approval?.toolId, "run_workspace_command");
	assert.deepEqual(approval?.arguments, { argv: createNativeBashArgv("npm test"), cwd: ".", timeoutSeconds: 120 });
});

test("bash cannot widen a specialized preset to external commands", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-bash-ceiling-"));
	let request = 0;
	let approvalRequested = false;
	const providerFetch: typeof fetch = async () => {
		request++;
		const base = { id: `bash-ceiling-${request}`, object: "chat.completion.chunk", created: 1, model: "bash-model" };
		const events = request === 1
			? [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "bash-command", type: "function", function: { name: "bash", arguments: '{"command":"npm test"}' } }] }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
			]
			: [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Unable to run the command." }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
			];
		return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	const result = await createHarness().run({
		objective: "Create a valuation workbook",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "bash-provider",
		modelId: "bash-model",
		providerConfiguration: { id: "bash-provider", name: "Bash Provider", kind: "openai-compatible", baseUrl: "https://provider.test/v1", apiKey: "test-key" },
		providerFetch,
		toolInterface: "bash",
		permissionMode: "ask",
		approve: async () => { approvalRequested = true; return true; },
	});
	assert.equal(approvalRequested, false);
	assert.ok(!result.capabilities.canonicalToolIds?.includes("run_workspace_command"));
	const trace = (await readFile(result.tracePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> });
	assert.ok(trace.some(({ type, data }) => type === "tool.denied" && data.operationId === "run_workspace_command" && /unavailable/.test(String(data.reason))));
});

test("bash pwd is permissioned as a read but does not satisfy workspace evidence", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-bash-pwd-"));
	let request = 0;
	const providerFetch: typeof fetch = async () => {
		request++;
		const base = { id: `bash-pwd-${request}`, object: "chat.completion.chunk", created: 1, model: "bash-model" };
		const events = request === 1
			? [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "bash-pwd", type: "function", function: { name: "bash", arguments: '{"command":"pwd"}' } }] }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
			]
			: [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "The workspace is /workspace." }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
			];
		return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	const result = await createHarness().run({
		objective: "Inspect the workspace",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "bash-provider",
		modelId: "bash-model",
		providerConfiguration: { id: "bash-provider", name: "Bash Provider", kind: "openai-compatible", baseUrl: "https://provider.test/v1", apiKey: "test-key" },
		providerFetch,
		toolInterface: "bash",
	});
	assert.equal(result.verification.checks.find(({ id }) => id === "workspace-evidence")?.passed, false);
	const trace = (await readFile(result.tracePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> });
	assert.ok(trace.some(({ type, data }) => type === "tool.completed" && data.operationId === "bash.pwd"));
});

test("bash capability prompt documents the constrained facade", () => {
	const capabilities = resolveCapabilities(compileTask({ objective: "Inspect this repository" }), undefined, [], [], { toolInterface: "bash", searchMode: "literal" });
	assert.ok(capabilities.toolIds.includes("bash"));
	const prompt = buildStableSystemPrompt(capabilities.preset, capabilities.toolIds, capabilities.canonicalToolIds, "literal");
	assert.doesNotMatch(prompt, /run_workspace_command takes argv/);
	assert.doesNotMatch(prompt, /memoryDB|search_workspace|inspect_workspace/i);
	assert.match(prompt, /normal non-interactive Bash/);
	assert.match(prompt, /read-only workspace sandbox/);
	const indexed = resolveCapabilities(compileTask({ objective: "Inspect this repository" }), undefined, [], [], { toolInterface: "bash", searchMode: "indexed" });
	assert.ok(indexed.toolIds.includes("search_workspace"));
	assert.match(buildStableSystemPrompt(indexed.preset, indexed.toolIds, indexed.canonicalToolIds, "indexed"), /search_workspace is the ranked project-search tool/);
	assert.equal(capabilities.preset.delegationPolicy.level, "L0");
	const specialized = resolveCapabilities(compileTask({ objective: "Create a valuation workbook" }), undefined, [], [], { toolInterface: "bash" });
	assert.ok(!specialized.canonicalToolIds?.includes("run_workspace_command"));
	assert.notEqual(specialized.toolBundleHash, capabilities.toolBundleHash);
	const codingTask = compileTask({ objective: "Implement the requested change" });
	const fullWorker = resolveCapabilities(codingTask, undefined, [], [], { toolInterface: "bash" });
	const boundedWorker = resolveCapabilities(codingTask, undefined, [], [], {
		toolInterface: "bash",
		toolCeiling: fullWorker.canonicalToolIds?.filter((id) => id !== "run_workspace_command"),
	});
	assert.notEqual(fullWorker.toolBundleHash, boundedWorker.toolBundleHash);
	assert.match(buildStableSystemPrompt(boundedWorker.preset, boundedWorker.toolIds, boundedWorker.canonicalToolIds), /no native Bash fallback/);
	const searchOnly = resolveCapabilities(compileTask({ objective: "Find the requested code" }), undefined, [], [], {
		toolInterface: "bash",
		toolCeiling: ["search_workspace"],
	});
	assert.doesNotMatch(buildStableSystemPrompt(searchOnly.preset, searchOnly.toolIds, searchOnly.canonicalToolIds), /--files/);
	assert.match(buildStableSystemPrompt(searchOnly.preset, searchOnly.toolIds, searchOnly.canonicalToolIds), /no native Bash fallback/);
	assert.throws(
		() => resolveCapabilities(compileTask({ objective: "Run the tests" }), undefined, [], [], {
			toolInterface: "bash",
			toolCeiling: ["list_workspace", "search_workspace", "inspect_workspace"],
		}),
		/cannot satisfy: workspace-command/,
	);
});

test("system prompts resolve all four workspace interface and search profiles", () => {
	const task = compileTask({ objective: "Inspect this repository" });
	const resolvePrompt = (toolInterface: "structured" | "bash", searchMode: "literal" | "indexed") => {
		const capabilities = resolveCapabilities(task, undefined, [], [], { toolInterface, searchMode });
		return {
			prompt: buildStableSystemPrompt(capabilities.preset, capabilities.toolIds, capabilities.canonicalToolIds, searchMode),
			cachePrefixHash: capabilities.cachePrefixHash,
		};
	};
	const structuredLiteral = resolvePrompt("structured", "literal");
	const structuredIndexed = resolvePrompt("structured", "indexed");
	const bashLiteral = resolvePrompt("bash", "literal");
	const bashIndexed = resolvePrompt("bash", "indexed");

	assert.equal(new Set([structuredLiteral.prompt, structuredIndexed.prompt, bashLiteral.prompt, bashIndexed.prompt]).size, 4);
	assert.equal(new Set([structuredLiteral.cachePrefixHash, structuredIndexed.cachePrefixHash, bashLiteral.cachePrefixHash, bashIndexed.cachePrefixHash]).size, 4);
	assert.match(structuredLiteral.prompt, /bounded literal substring search/);
	assert.match(structuredIndexed.prompt, /ranked project matches/);
	assert.match(bashLiteral.prompt, /exact identifier, text fragment, or regular expression/);
	assert.match(bashIndexed.prompt, /search_workspace is the ranked project-search tool/);
	assert.doesNotMatch(bashLiteral.prompt, /memoryDB|search_workspace|inspect_workspace/i);
	assert.doesNotMatch(bashIndexed.prompt, /memoryDB|inspect_workspace/i);
});

test("indexed retrieval guidance is optional, bounded, and backend neutral", () => {
 for (const toolInterface of ["bash", "structured"] as const) {
  const capabilities = resolveCapabilities(compileTask({ objective: "Inspect this repository" }), undefined, [], [], { toolInterface, searchMode: "indexed" });
  const prompt = buildStableSystemPrompt(capabilities.preset, capabilities.toolIds, capabilities.canonicalToolIds, "indexed");
  assert.match(prompt, /unfamiliar behavior/);
  assert.match(prompt, /Known paths and exact symbols need direct reads or literal rg/);
  assert.match(prompt, /no more than four indexed searches/);
  assert.match(prompt, /Skip ranked search when the supplied evidence/);
  assert.match(prompt, /Read only the relevant range/);
  assert.doesNotMatch(prompt, /memoryDB/i);
 }
});

test("new native routes preserve original command and specialized ceilings", async () => {
 const root = await mkdtemp(join(tmpdir(), "codetonomy-bash-routes-"));
 await writeFile(join(root, "sandbox"), "console.log(JSON.stringify(process.argv.slice(2)));");
 for (const command of ["rg -F -e alpha -e beta src", "rg --files --hidden", "rg absent src | head -1 && cat a", "rg -F '\$(literal)' src"]) {
  const result = await bashTool(root, { codexBinary: process.execPath, commandSandboxMode: "read-only", allowedCanonicalToolIds: ["inspect_workspace"] }).execute(command, { command });
  const output = result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.equal(JSON.parse(output).at(-1), command);
  assert.equal((result.details as { filesystem: string }).filesystem, "read-only");
  await assert.rejects(bashTool(root, { allowedCanonicalToolIds: ["search_workspace", "list_workspace"] }).execute(command, { command }), /unavailable/);
 }
 await writeFile(join(root, ".env"), "DUMMY=synthetic");
 for (const command of ["rg --files", "rg -e alpha -e beta ."]) {
  await assert.rejects(bashTool(root, { codexBinary: process.execPath }).execute(command, { command }), /sensitive path/);
 }
});

test("native fallback rejects parsed workspace escapes and allows paths that remain inside", async () => {
	assert.equal(planBashCommand({ command: "cat ../outside.txt" }).reason, "workspace-escape");
	await assert.rejects(bashTool(process.cwd()).execute("escape", { command: "cat ../outside.txt" }), /escapes the workspace/);
	assert.doesNotThrow(() => parseBashCommand({ command: "cat ../../README.md", cwd: "packages/tools" }));
	const root = await mkdtemp(join(tmpdir(), "codetonomy-bash-full-access-"));
	await writeFile(join(root, "sandbox"), "console.log(JSON.stringify(process.argv.slice(2)));");
	const unrestricted = await bashTool(root, { codexBinary: process.execPath, commandSandboxMode: "full-access" }).execute("full-access", { command: "cat ../outside.txt" });
	assert.equal(JSON.parse(unrestricted.content[0]?.type === "text" ? unrestricted.content[0].text : "").at(-1), "cat ../outside.txt");
});
