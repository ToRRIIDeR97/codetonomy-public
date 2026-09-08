import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import test from "node:test";
import { createHarness } from "../packages/runtime/src/index.ts";
import { RunCheckpoint, rewindCheckpoint } from "../packages/runtime/src/checkpoint.ts";
import { compileTask } from "../packages/task-compiler/src/index.ts";
import { bashTool, inspectWorkspaceTool, resolveCodexBinary, runWorkspaceCommandTool, searchWorkspaceTool, writeWorkspaceTool } from "../packages/tools/src/index.ts";
import { createSession, appendConversationTurn, loadSession, saveSession } from "../apps/cli/src/session.ts";
import { isSensitiveWorkspacePath } from "../packages/contracts/src/index.ts";
import { parseDocument } from "../packages/document-ir/src/index.ts";
import { EvaluationStore } from "../packages/evals/src/index.ts";
import { inspectWorkbook } from "../packages/artifacts/src/index.ts";
import { LocalGraphMemory } from "../packages/memory-client/src/index.ts";
import { verifyArtifacts, verifyOutput } from "../packages/verifiers/src/index.ts";

test("sensitive command preflight checks ignored directories and linked directories", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-sensitive-regression-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	for (const directory of ["node_modules", ".git", ".codetonomy", "dist", ".reference-repos"]) {
		const workspace = join(root, directory.slice(1) || "workspace");
		await mkdir(join(workspace, directory), { recursive: true });
		await writeFile(join(workspace, directory, ".env"), "DUMMY=fixture");
		for (const commandSandboxMode of ["workspace", "read-only"] as const) {
			await assert.rejects(() => runWorkspaceCommandTool(workspace, {
				codexBinary: process.execPath, commandSandboxMode,
			}).execute("blocked", { argv: ["ignored"] }), /commands are blocked.*sensitive path/);
		}
	}
	const workspace = join(root, "linked-workspace");
	const target = join(root, "linked-target");
	await mkdir(workspace); await mkdir(target);
	await writeFile(join(target, ".env"), "DUMMY=fixture");
	await symlink(target, join(workspace, "dependency"), process.platform === "win32" ? "junction" : "dir");
	await assert.rejects(() => runWorkspaceCommandTool(workspace, { codexBinary: process.execPath })
		.execute("linked", { argv: ["ignored"] }), /commands are blocked.*sensitive path/);
	await unlink(join(target, ".env"));
	await symlink(workspace, join(target, "cycle"), process.platform === "win32" ? "junction" : "dir");
	await writeFile(join(workspace, "sandbox"), "process.exit(0);");
	assert.equal((await runWorkspaceCommandTool(workspace, { codexBinary: process.execPath })
		.execute("cycle", { argv: ["ignored"] })).details.exitCode, 0);
});

test("rewind retains the original preimage after deletion and recreation across commands", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-rewind-regression-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const file = join(root, "existing.txt");
	await writeFile(file, "original");
	const checkpointPath = join(root, ".harness", "checkpoint.json");
	const checkpoint = new RunCheckpoint(root, "regression", checkpointPath);
	await checkpoint.beforeWorkspace(); await unlink(file); await checkpoint.afterWorkspace();
	await checkpoint.beforeWorkspace(); await writeFile(file, "replacement"); await checkpoint.afterWorkspace();
	assert.equal(JSON.parse(await readFile(checkpointPath, "utf8")).files.filter((entry: { path: string }) => entry.path === "existing.txt").length, 1);
	await rewindCheckpoint(checkpointPath, root);
	assert.equal(await readFile(file, "utf8"), "original");
});

test("native Bash provides exact evidence only for a parsed single command", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-bash-evidence-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "sandbox"), "process.exit(0);");
	const tool = bashTool(root, { codexBinary: process.execPath });
	for (const command of ["npm test", "npm run test", "npm test || true", "echo npm test"]) {
		const result = await tool.execute(command, { command });
		const details = result.details as { argv: string[]; semanticArgv?: string[]; exitCode: number };
		assert.ok(details.argv.includes("-c"));
		const checked = verifyOutput("Tests completed", undefined, {
			task: compileTask({ objective: "Run npm test" }), completedToolIds: ["inspect_workspace", "run_workspace_command"],
			commandRuns: [{ argv: details.semanticArgv ?? details.argv, exitCode: details.exitCode }],
		});
		assert.equal(checked.passed, command === "npm test" || command === "npm run test", command);
	}
	await writeFile(join(root, "sandbox"), "process.exit(1);");
	const failed = await tool.execute("failure", { command: "npm test" });
	const details = failed.details as { semanticArgv: string[]; exitCode: number };
	assert.equal(verifyOutput("Tests completed", undefined, {
		task: compileTask({ objective: "Run npm test" }), completedToolIds: ["inspect_workspace", "run_workspace_command"],
		commandRuns: [{ argv: details.semanticArgv, exitCode: details.exitCode }],
	}).passed, false);
});

test("runtime accepts successful native Bash command evidence without repair", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-bash-runtime-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const previousCodex = process.env.CODETONOMY_CODEX_BIN;
	process.env.CODETONOMY_CODEX_BIN = process.execPath;
	t.after(() => {
		if (previousCodex === undefined) delete process.env.CODETONOMY_CODEX_BIN;
		else process.env.CODETONOMY_CODEX_BIN = previousCodex;
	});
	await writeFile(join(root, "sandbox"), "process.exit(0);");
	let requests = 0;
	const providerFetch: typeof fetch = async () => {
		const request = ++requests;
		const command = request === 1 ? "ls" : "npm test";
		const delta = request <= 2
			? { role: "assistant", tool_calls: [{ index: 0, id: `call-${request}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } }] }
			: { role: "assistant", content: "Tests passed." };
		const base = { id: `response-${request}`, object: "chat.completion.chunk", created: 1, model: "test-model" };
		const events = [
			{ ...base, choices: [{ index: 0, delta, finish_reason: null }] },
			{ ...base, choices: [{ index: 0, delta: {}, finish_reason: request <= 2 ? "tool_calls" : "stop" }] },
		];
		return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
	};
	const result = await createHarness().run({
		objective: "Run npm test", workspaceRoot: root, traceDirectory: join(root, ".harness", "runs"),
		provider: "test-provider", modelId: "test-model", toolInterface: "bash", permissionMode: "auto",
		providerConfiguration: { id: "test-provider", name: "Test", kind: "openai-compatible", baseUrl: "https://provider.test/v1", apiKey: "test-key" },
		providerFetch,
	});
	assert.equal(result.verification.passed, true, JSON.stringify(result.verification.checks));
	assert.equal(requests, 3);
});

test("artifact reviews require checks for their own format", async () => {
	for (const [file, objective, expected] of [
		["missing.pptx", "Review the presentation", "presentation-open"],
		["missing.json", "Review the backtest", "data-schema-check"],
		["missing.xlsx", "Review the workbook", "workbook-open"],
	]) {
		const result = await verifyArtifacts(compileTask({ objective: objective!, files: [file!] }), [], process.cwd());
		assert.ok(result.checks.some(({ id, passed }) => id === expected && !passed));
		assert.equal(result.checks.some(({ id }) => id === "workbook-open"), file!.endsWith(".xlsx"));
		assert.ok(result.checks.some(({ id, passed }) => id === "review-report" && !passed));
	}
});

const scriptedProvider = (calls: Array<{ name: string; arguments: unknown }>) => {
	let requests = 0;
	const providerFetch: typeof fetch = async () => {
		const tool = calls[requests++];
		const delta = tool
			? { role: "assistant", tool_calls: [{ index: 0, id: `audit-${requests}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] }
			: { role: "assistant", content: "Completed the requested task." };
		const base = { id: `audit-${requests}`, object: "chat.completion.chunk", created: 1, model: "test-model" };
		const events = [
			{ ...base, choices: [{ index: 0, delta, finish_reason: null }] },
			{ ...base, choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] },
		];
		return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
	};
	return { providerFetch, requests: () => requests };
};

const testProvider = {
	provider: "test-provider", modelId: "test-model", permissionMode: "auto" as const, maxModelTurns: 6,
	providerConfiguration: { id: "test-provider", name: "Test", kind: "openai-compatible" as const, baseUrl: "https://provider.test/v1", apiKey: "test-key" },
};

test("secret directory descendants are blocked by reads, writes, parsing, and indexing", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-secret-descendants-"));
	const memory = new LocalGraphMemory({ databasePath: join(root, ".harness", "memory.sqlite"), workspaceRoot: root, projectId: "audit" });
	t.after(async () => { memory.close(); await rm(root, { recursive: true, force: true }); });
	for (const path of [".aws/credentials", ".ssh/config", "nested/.gnupg/private-keys-v1.d/dummy.txt"]) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), "DUMMY audit data");
		assert.equal(isSensitiveWorkspacePath(path), true);
		assert.equal(isSensitiveWorkspacePath(path.replaceAll("/", "\\")), true);
		await assert.rejects(() => inspectWorkspaceTool(root).execute("read", { path }), /[Ss]ensitive/);
		await assert.rejects(() => writeWorkspaceTool(root).execute("write", { path, content: "replacement" }), /[Ss]ensitive/);
		await assert.rejects(() => parseDocument(root, path), /[Ss]ensitive/);
		await assert.rejects(() => memory.ingestFile(path), /[Ss]ensitive/);
	}
	assert.equal(isSensitiveWorkspacePath(".aws/nested\nname"), true);
	assert.equal(isSensitiveWorkspacePath("src/credentials.ts"), false);
});

test("structured writes protect runtime directories before creating parents, including aliases", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-protected-writes-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	let captures = 0;
	const tool = writeWorkspaceTool(root, { before: async () => { captures++; }, after: async () => {} });
	for (const path of [".git/config", ".codex/hooks/run.sh", ".agents/skills/run.md", ".codetonomy/workers/run", "nested/.git/config"]) {
		await assert.rejects(() => tool.execute("write", { path, content: "DUMMY" }), /protected/);
		await assert.rejects(() => stat(dirname(join(root, path))), /ENOENT/);
	}
	await mkdir(join(root, ".git"));
	await writeFile(join(root, ".git/config"), "original");
	await symlink(join(root, ".git"), join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
	await assert.rejects(() => tool.execute("alias", { path: "alias/config", content: "replacement" }), /protected/);
	assert.equal(await readFile(join(root, ".git/config"), "utf8"), "original");
	assert.equal(captures, 0);
});

test("worker discovery ignores project-local executables unless explicitly configured", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-runtime-discovery-"));
	// Windows taskkill can briefly retain the worker's inherited working directory.
	t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
	const oldCwd = process.cwd();
	const keys = ["CODETONOMY_CODEX_BIN", "CODETONOMY_PYTHON", "CODETONOMY_HOME", "CODETONOMY_WORKER_ROOT"];
	const oldEnvironment = keys.map((key) => process.env[key]);
	const fakeCodex = join(root, ".codetonomy/workers/codex/node_modules/.bin/codex");
	const fakePython = join(root, ".codetonomy/workers/artifacts", process.platform === "win32" ? "Scripts/python.exe" : "bin/python3");
	await mkdir(dirname(fakeCodex), { recursive: true });
	await mkdir(dirname(fakePython), { recursive: true });
	await writeFile(fakeCodex, "inert test candidate");
	await writeFile(fakePython, "inert test candidate");
	await writeFile(join(root, "test.xlsx"), "fixture");
	try {
		for (const key of keys) delete process.env[key];
		process.chdir(root);
		assert.notEqual(resolveCodexBinary(), fakeCodex);
		await mkdir(join(root, "nested"));
		process.chdir(join(root, "nested"));
		assert.notEqual(resolveCodexBinary(), fakeCodex);
		assert.equal(resolveCodexBinary(fakeCodex), fakeCodex);
		// A selected fake interpreter fails as an executable, whereas a trusted Python reaches this worker.
		const worker = join(root, "probe.py");
		await writeFile(worker, 'print(\'{"ok":true,"result":{"path":"trusted-interpreter"}}\')');
		assert.equal((await inspectWorkbook(root, "test.xlsx", { workerPath: worker })).path, "trusted-interpreter");
	} finally {
		process.chdir(oldCwd);
		keys.forEach((key, index) => oldEnvironment[index] === undefined ? delete process.env[key] : process.env[key] = oldEnvironment[index]);
	}
});

test("indexed search suppresses stale versions and falls back to current text", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-search-freshness-"));
	await writeFile(join(root, "setting.ts"), "export const oldAuditSetting = 1;\n");
	const memory = new LocalGraphMemory({ databasePath: join(root, ".harness", "memory.sqlite"), workspaceRoot: root, projectId: "audit" });
	t.after(async () => { memory.close(); await rm(root, { recursive: true, force: true }); });
	await memory.ingestFile("setting.ts");
	const tool = searchWorkspaceTool(root, { search: async (query) => memory.retrieve(query) });
	assert.equal((await tool.execute("old", { query: "oldAuditSetting" })).details.backend, "memoryDB");
	await writeWorkspaceTool(root).execute("replace", { path: "setting.ts", content: "export const newAuditSetting = 1;\n" });
	assert.doesNotMatch(JSON.stringify((await tool.execute("stale", { query: "oldAuditSetting" })).content), /oldAuditSetting/);
	assert.match(JSON.stringify((await tool.execute("new", { query: "newAuditSetting" })).content), /newAuditSetting/);
	const legacy = searchWorkspaceTool(root, { search: async () => [{ path: "setting.ts", content: "oldAuditSetting" }] });
	assert.doesNotMatch(JSON.stringify((await legacy.execute("legacy", { query: "oldAuditSetting" })).content), /oldAuditSetting/);
	const bytes = Buffer.from([0xff, 1, 2, 3]);
	await writeFile(join(root, "report.pdf"), bytes);
	const binary = searchWorkspaceTool(root, { search: async () => [{ path: "report.pdf", content: "OCR evidence", contentHash: createHash("sha256").update(bytes).digest("hex") }] });
	assert.equal((await binary.execute("binary", { query: "evidence" })).details.backend, "memoryDB");
	await writeFile(join(root, "report.pdf"), Buffer.from([0xff, 2, 3]));
	assert.doesNotMatch(JSON.stringify((await binary.execute("changed-binary", { query: "evidence" })).content), /OCR evidence/);
});

test("long reasoning turns persist with a bounded session copy", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-long-session-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const base = createSession(await realpath(root));
	const turn = { runId: "audit", objective: "Do the task", output: "Done", timestamp: Date.now(), reasoning: Array.from({ length: 100 }, () => ({ text: "r".repeat(2000), truncated: false })) };
	let session = appendConversationTurn(base, { ...turn, reasoning: turn.reasoning.slice(0, 13) });
	await saveSession(root, session);
	assert.equal((await loadSession(root, root, session.id)).turns[0]?.reasoning?.length, 13);
	for (let index = 0; index < 20; index++) session = appendConversationTurn(session, turn);
	await saveSession(root, session);
	const loaded = await loadSession(root, root, session.id);
	assert.ok(loaded.turns.length > 1);
	assert.ok(loaded.turns.at(-1)!.reasoning!.reduce((sum, item) => sum + item.text.length, 0) <= 65536);
	assert.equal(loaded.turns.at(-1)!.reasoning!.at(-1)!.truncated, true);
	assert.equal(turn.reasoning.length, 100);
	assert.equal(turn.reasoning[0]!.truncated, false);
});

test("runtime records document reads and observed Bash mutations, but rejects no-op writes", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-audit-evidence-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "report.md"), "Audit evidence.");
	const document = scriptedProvider([{ name: "inspect_document", arguments: { path: "report.md" } }]);
	const read = await createHarness().run({ ...testProvider, objective: "Read report.md", workspaceRoot: root, traceDirectory: join(root, ".harness", "runs"), providerFetch: document.providerFetch });
	assert.equal(read.verification.passed, true, JSON.stringify(read.verification.checks));
	assert.equal(document.requests(), 2);
	const oldCodex = process.env.CODETONOMY_CODEX_BIN;
	process.env.CODETONOMY_CODEX_BIN = process.execPath;
	t.after(() => oldCodex === undefined ? delete process.env.CODETONOMY_CODEX_BIN : process.env.CODETONOMY_CODEX_BIN = oldCodex);
	// Test-only command launcher; native sandbox enforcement is covered by sandbox-conformance.test.ts.
	await writeFile(join(root, "sandbox"), "const {spawnSync}=require('node:child_process'); const i=process.argv.indexOf('--'); const r=spawnSync(process.argv[i+1],process.argv.slice(i+2),{stdio:'inherit'}); process.exit(r.status??1);");
	for (const [command, expected, initial, objective = "Create result.txt"] of [
		["printf done > result.txt", true], ["printf done", false],
		["rm result.txt", false, "original"], ["rm result.txt", true, "original", "Delete result.txt"],
	] as const) {
		await rm(join(root, "result.txt"), { force: true });
		if (initial) await writeFile(join(root, "result.txt"), initial);
		const provider = scriptedProvider([{ name: "bash", arguments: { command: "ls" } }, { name: "bash", arguments: { command } }]);
		const result = await createHarness().run({ ...testProvider, objective, workspaceRoot: root, traceDirectory: join(root, ".harness", "runs"), toolInterface: "bash", providerFetch: provider.providerFetch });
		assert.equal(result.verification.passed, expected, JSON.stringify(result.verification.checks));
		if (expected) {
			if (initial) await assert.rejects(() => stat(join(root, "result.txt")), /ENOENT/);
			else assert.equal(await readFile(join(root, "result.txt"), "utf8"), "done");
			assert.equal(provider.requests(), 3);
		}
	}
});

test("read-only commands skip mutation capture; writable checkpoints track actual changes", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-checkpoint-evidence-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "sandbox"), "process.exit(0);");
	let captures = 0;
	await runWorkspaceCommandTool(root, { codexBinary: process.execPath, commandSandboxMode: "read-only", observer: { before: async () => {}, after: async () => {}, beforeWorkspace: async () => { captures++; }, afterWorkspace: async () => { captures++; } } }).execute("read-only", { argv: ["ignored"] });
	assert.equal(captures, 0);
	await writeFile(join(root, "existing.txt"), "original");
	const checkpoint = new RunCheckpoint(root, "audit", join(root, ".harness/checkpoint.json"));
	await checkpoint.beforeWorkspace();
	assert.deepEqual(await checkpoint.afterWorkspace(), []);
	await checkpoint.beforeWorkspace();
	await writeFile(join(root, "existing.txt"), "changed");
	await writeFile(join(root, "new.txt"), "created");
	assert.deepEqual((await checkpoint.afterWorkspace()).sort(), ["existing.txt", "new.txt"]);
	await checkpoint.beforeWorkspace();
	await unlink(join(root, "new.txt"));
	assert.deepEqual(await checkpoint.afterWorkspace(), ["new.txt"]);
	await rewindCheckpoint(checkpoint.path!, root);
	assert.equal(await readFile(join(root, "existing.txt"), "utf8"), "original");
});

test("orchestration aggregate usage is excluded from global token and cost totals", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-usage-totals-"));
	const child = await createHarness().run({ objective: "Return a concise response", workspaceRoot: root, traceDirectory: join(root, ".harness/runs") });
	child.usage = { input: 70, output: 10, cacheRead: 20, cacheWrite: 0, totalTokens: 100, cost: { input: .7, output: .1, cacheRead: .2, cacheWrite: 0, total: 1 } };
	const tracePath = join(root, "parent.jsonl");
	await writeFile(tracePath, "");
	const store = new EvaluationStore(join(root, "evaluations.sqlite"));
	t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
	await store.saveOrchestration({ runId: "parent", tracePath, output: "Done", verification: child.verification, children: [{ id: "child", status: "completed", run: child }] } as Parameters<EvaluationStore["saveOrchestration"]>[0]);
	assert.equal(store.summary().runs, 2);
	assert.equal(store.summary().totalTokens, 100);
	assert.equal(store.summary().cachedInputTokens, 20);
	assert.equal(store.summary().totalCost, 1);
	assert.equal(store.metrics("parent").totalTokens, 100);
});

test("spreadsheet and backtest workers reject the audited invalid inputs", async () => {
	const python = process.env.CODETONOMY_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
	const { stdout } = await promisify(execFile)(python, [join(process.cwd(), "tests/audit-workers.py")], { timeout: 30_000 });
	assert.match(stdout, /checks passed/);
});
