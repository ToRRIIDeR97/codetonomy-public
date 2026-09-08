import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseArguments } from "../apps/cli/src/args.ts";
import {
	PROVIDER_PRESETS,
	fetchProviderModelCatalog,
	fetchProviderModels,
	loadConfiguration,
	providerModelsUrl,
	persistProviderSelection,
	providerCompatibilityNotice,
	resolveProviderSelection,
	saveConfiguration,
	validateConfiguration,
	migrateConfiguration,
	type ProviderSettings,
} from "../apps/cli/src/config.ts";
import {
	createAutocompleteProvider,
	createSlashCommands,
	discoverSkills,
	discoverWorkspaceFiles,
	loadActivatedSkills,
	parsePrompt,
	parseSkillDocument,
	parseSlashCommand,
	routeSkills,
} from "../apps/cli/src/interaction.ts";
import { sanitizeTerminalText } from "../apps/cli/src/terminal.ts";
import { ensureMemoryWorker, loadMemoryDbEnabled, saveMemoryDbEnabled, startMemoryDb } from "../apps/cli/src/memory.ts";
import { ModelPicker } from "../apps/cli/src/setup.ts";
import { addSessionModelUsage, appendConversationTurn, createSession, generateSessionTitle, listSessions, loadSession, loadSessionByPrefix, normalizeSessionTitle, saveSession, sessionModelUsage } from "../apps/cli/src/session.ts";
import {
	mascotActivityForEvent,
	PolarBearWelcome,
	renderPolarBear,
} from "../apps/cli/src/mascot.ts";
import { formatModelUsageReport, formatUsage, renderReasoningGlow, renderSubagentStrip } from "../apps/cli/src/tui.ts";
import { ocrClipboardImages, readClipboard } from "../apps/cli/src/clipboard.ts";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

test("CLI defaults to the terminal UI", () => {
	assert.deepEqual(parseArguments([]), { command: "tui", files: [], json: false, permissionMode: "ask" });
	assert.deepEqual(parseArguments(["setup"]), { command: "setup", files: [], json: false });
	assert.throws(() => parseArguments(["setup", "extra"]), /does not accept/);
	assert.deepEqual(parseArguments(["memory", "on"]), { command: "memory", files: [], json: false, memoryEnabled: true });
	assert.deepEqual(parseArguments(["memory", "off"]), { command: "memory", files: [], json: false, memoryEnabled: false });
	assert.deepEqual(parseArguments(["memory", "status"]), { command: "memory", files: [], json: false });
});

test("memoryDB is a project setting rather than a skill", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-project-memory-"));
	assert.equal(await loadMemoryDbEnabled(root), false);
	await saveMemoryDbEnabled(root, true);
	assert.equal(await loadMemoryDbEnabled(root), true);
	assert.deepEqual(JSON.parse(await readFile(join(root, ".codetonomy", "project-settings.json"), "utf8")), { version: 1, memoryDB: true });
	assert.ok(createSlashCommands([]).some(({ name }) => name === "memorydb"));
	assert.ok(createSlashCommands([]).some(({ name }) => name === "paste"));
});

test("memoryDB installs its managed worker automatically on first use", async () => {
	const workerRoot = await mkdtemp(join(tmpdir(), "codetonomy-managed-memory-"));
	let installs = 0;
	const install = async () => {
		installs++;
		const memoryCore = join(workerRoot, "tencent-agent-memory", "MemoryCore");
		const source = join(memoryCore, "src", "gateway");
		const runtime = join(memoryCore, "node_modules", "tsx", "dist");
		const esbuild = join(memoryCore, "node_modules", "esbuild", "bin");
		const jieba = join(memoryCore, "node_modules", "@node-rs", "jieba");
		await mkdir(source, { recursive: true });
		await mkdir(runtime, { recursive: true });
		await mkdir(esbuild, { recursive: true });
		await mkdir(jieba, { recursive: true });
		await writeFile(join(source, "server.ts"), "// managed fixture\n");
		await writeFile(join(runtime, "loader.mjs"), "// managed fixture\n");
		await writeFile(join(esbuild, "esbuild"), "console.log('0.0.0');\n");
		await writeFile(join(jieba, "index.js"), "module.exports = {};\n");
	};
	assert.equal(await ensureMemoryWorker([workerRoot], install), join(workerRoot, "tencent-agent-memory", "MemoryCore"));
	assert.equal(await ensureMemoryWorker([workerRoot], install), join(workerRoot, "tencent-agent-memory", "MemoryCore"));
	assert.equal(installs, 1);
});

const createManagedMemoryFixture = async (workerRoot: string, serverSource: string): Promise<{ memoryCore: string; source: string }> => {
	const memoryCore = join(workerRoot, "tencent-agent-memory", "MemoryCore");
	const source = join(memoryCore, "src", "gateway");
	const runtime = join(memoryCore, "node_modules", "tsx", "dist");
	const esbuild = join(memoryCore, "node_modules", "esbuild", "bin");
	const jieba = join(memoryCore, "node_modules", "@node-rs", "jieba");
	await Promise.all([
		mkdir(source, { recursive: true }),
		mkdir(runtime, { recursive: true }),
		mkdir(esbuild, { recursive: true }),
		mkdir(jieba, { recursive: true }),
	]);
	await Promise.all([
		writeFile(join(memoryCore, "package.json"), JSON.stringify({ type: "module" })),
		writeFile(join(source, "server.ts"), serverSource),
		writeFile(join(memoryCore, "node_modules", "tsx", "package.json"), JSON.stringify({ name: "tsx", type: "module", exports: "./dist/loader.mjs" })),
		writeFile(join(runtime, "loader.mjs"), "// Node 22 executes this JavaScript-compatible TypeScript fixture directly.\n"),
		writeFile(join(esbuild, "esbuild"), "console.log('0.0.0');\n"),
		writeFile(join(jieba, "package.json"), JSON.stringify({ main: "index.cjs" })),
		writeFile(join(jieba, "index.cjs"), "module.exports = {};\n"),
	]);
	return { memoryCore, source };
};

test("memoryDB fails closed before worker startup on Linux", { skip: process.platform !== "linux" }, async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-memory-linux-"));
	await assert.rejects(
		() => startMemoryDb({ configurationDirectory: join(root, "configuration"), workspaceRoot: join(root, "workspace"), sessionId: "linux" }),
		/unavailable on Linux.*no worker was started/,
	);
});

test("memoryDB owns its endpoint, isolates secrets, and stops its sidecar", { skip: process.platform === "linux" }, async (t) => {
	const configurationDirectory = await mkdtemp(join(homedir(), ".codetonomy-memory-boundary-"));
	const runtimeDirectory = `${configurationDirectory}-memorydb`;
	const workerRoot = join(runtimeDirectory, "workers");
	const workspaceRoot = await mkdtemp(join(tmpdir(), "codetonomy-memory-workspace-"));
	t.after(() => Promise.all([
		rm(configurationDirectory, { recursive: true, force: true }),
		rm(runtimeDirectory, { recursive: true, force: true }),
		rm(workspaceRoot, { recursive: true, force: true }),
	]));
	await writeFile(join(configurationDirectory, "credentials.env"), "OPENAI_API_KEY=file-sentinel\n");
	await createManagedMemoryFixture(workerRoot, `
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
const boundaryPath = join(process.env.TDAI_DATA_DIR, "sidecar-boundary.json");
const boundary = { environment: process.env, sourceWriteBlocked: false, configWriteBlocked: false, credentialsExposed: false, egress: "pending" };
try { writeFileSync(new URL("./sandbox-escape.txt", import.meta.url), "escape"); }
catch { boundary.sourceWriteBlocked = true; }
try { writeFileSync(process.env.TDAI_GATEWAY_CONFIG, "tampered"); }
catch { boundary.configWriteBlocked = true; }
try {
  const runtimeRoot = dirname(process.env.TDAI_DATA_DIR);
  const configurationRoot = runtimeRoot.slice(0, -"-memorydb".length);
  boundary.credentialsExposed = readFileSync(join(configurationRoot, "credentials.env"), "utf8").includes("file-sentinel");
}
catch { boundary.credentialsExposed = false; }
const persistBoundary = () => writeFileSync(boundaryPath, JSON.stringify(boundary));
persistBoundary();
const outbound = createConnection({ host: "1.1.1.1", port: 80 });
const finishEgress = (result) => {
	if (boundary.egress !== "pending") return;
	boundary.egress = result;
	outbound.destroy();
	persistBoundary();
};
outbound.setTimeout(1_000, () => finishEgress("blocked-timeout"));
outbound.once("connect", () => finishEgress("allowed"));
outbound.once("error", () => finishEgress("blocked"));
const apiKey = process.env.TDAI_GATEWAY_API_KEY;
const server = createServer((request, response) => {
	if (request.url === "/health") {
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ status: "degraded", version: "fixture", uptime: 1, stores: {} }));
		return;
	}
	if (request.url === "/v3/__codetonomy_probe") {
		response.writeHead(request.headers.authorization === \`Bearer \${apiKey}\` ? 404 : 401);
		response.end();
		return;
	}
	response.writeHead(404);
	response.end();
});
server.listen(8420, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`);
	const inherited = {
		CODETONOMY_WORKER_ROOT: process.env.CODETONOMY_WORKER_ROOT,
		OPENAI_API_KEY: process.env.OPENAI_API_KEY,
		TDAI_LLM_API_KEY: process.env.TDAI_LLM_API_KEY,
		HTTP_PROXY: process.env.HTTP_PROXY,
		NODE_OPTIONS: process.env.NODE_OPTIONS,
	};
	process.env.CODETONOMY_WORKER_ROOT = workerRoot;
	process.env.OPENAI_API_KEY = "openai-sentinel";
	process.env.TDAI_LLM_API_KEY = "tdai-sentinel";
	process.env.HTTP_PROXY = "http://proxy.invalid";
	process.env.NODE_OPTIONS = "--trace-warnings";
	let memory: Awaited<ReturnType<typeof startMemoryDb>> | undefined;
	try {
		memory = await startMemoryDb({ configurationDirectory, workspaceRoot, sessionId: "fixture" });
		const boundaryPath = join(runtimeDirectory, "data", "sidecar-boundary.json");
		let boundary: { environment: NodeJS.ProcessEnv; sourceWriteBlocked: boolean; configWriteBlocked: boolean; credentialsExposed: boolean; egress: string } | undefined;
		for (let attempt = 0; attempt < 80; attempt++) {
			boundary = JSON.parse(await readFile(boundaryPath, "utf8")) as typeof boundary;
			if (boundary?.egress !== "pending") break;
			await new Promise((resolveWait) => setTimeout(resolveWait, 25));
		}
		assert.ok(boundary);
		assert.equal(boundary.sourceWriteBlocked, true);
		assert.equal(boundary.configWriteBlocked, true);
		assert.equal(boundary.credentialsExposed, false);
		assert.match(boundary.egress, /^blocked/);
		const environment = boundary.environment;
		assert.equal(environment.OPENAI_API_KEY, undefined);
		if (process.platform === "darwin") assert.match(environment.HTTP_PROXY ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
		else assert.equal(environment.HTTP_PROXY, undefined);
		assert.notEqual(environment.HTTP_PROXY, "http://proxy.invalid");
		assert.equal(environment.NODE_OPTIONS, undefined);
		assert.equal(environment.TDAI_LLM_API_KEY, "");
		assert.equal(environment.TDAI_LLM_BASE_URL, "http://127.0.0.1:9/v1");
		assert.match(environment.NO_PROXY ?? "", /127\.0\.0\.1/);
		assert.match(environment.NO_PROXY ?? "", /localhost/);
		const configuration = await readFile(join(runtimeDirectory, "data", "gateway.yaml"), "utf8");
		assert.match(configuration, /extraction:\s+enabled: false/);
		assert.match(configuration, /skill:\s+enabled: false/);
		assert.match(configuration, /baseUrl: http:\/\/127\.0\.0\.1:9\/v1/);
		await assert.rejects(
			() => startMemoryDb({ configurationDirectory, workspaceRoot, sessionId: "second" }),
			/already running/,
		);
	} finally {
		await memory?.close();
		for (const [key, value] of Object.entries(inherited)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
	await assert.rejects(() => fetch("http://127.0.0.1:8420/health", { signal: AbortSignal.timeout(500) }));
	assert.equal((await readdir(join(runtimeDirectory, "data"))).some((name) => name.startsWith(".gateway-ready-")), false);
});

test("memoryDB fails closed when Windows sandbox ACLs expose the private configuration", { skip: process.platform !== "win32" }, async (t) => {
	const root = await mkdtemp(join(process.cwd(), ".memory-readable-config-"));
	const workerRoot = join(root, "workers");
	const configurationDirectory = join(root, "configuration");
	const workspaceRoot = join(root, "workspace");
	t.after(() => rm(root, { recursive: true, force: true }));
	await Promise.all([mkdir(configurationDirectory), mkdir(workspaceRoot)]);
	await writeFile(join(configurationDirectory, "credentials.env"), "OPENAI_API_KEY=file-sentinel\n");
	await createManagedMemoryFixture(workerRoot, "throw new Error('Tencent code must not load before the privacy check');\n");
	const previous = process.env.CODETONOMY_WORKER_ROOT;
	process.env.CODETONOMY_WORKER_ROOT = workerRoot;
	try {
		await assert.rejects(
			() => startMemoryDb({ configurationDirectory, workspaceRoot, sessionId: "readable-config" }),
			/memoryDB sandbox can read the private Codetonomy configuration/,
		);
	} finally {
		if (previous === undefined) delete process.env.CODETONOMY_WORKER_ROOT;
		else process.env.CODETONOMY_WORKER_ROOT = previous;
	}
	await assert.rejects(() => fetch("http://127.0.0.1:8420/health", { signal: AbortSignal.timeout(500) }));
});

test("memoryDB never sends its gateway token to a pre-existing listener", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-memory-impostor-"));
	const workerRoot = join(root, "workers");
	const configurationDirectory = join(root, "configuration");
	const workspaceRoot = join(root, "workspace");
	await Promise.all([mkdir(configurationDirectory), mkdir(workspaceRoot)]);
	await createManagedMemoryFixture(workerRoot, "throw new Error('the managed sidecar must not start');\n");
	const receivedAuthorization: Array<string | undefined> = [];
	const impostor = createServer((request, response) => {
		receivedAuthorization.push(request.headers.authorization);
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ status: "ok", version: "impostor", stores: {} }));
	});
	await new Promise<void>((resolveListen) => impostor.listen(8420, "127.0.0.1", resolveListen));
	const previous = process.env.CODETONOMY_WORKER_ROOT;
	process.env.CODETONOMY_WORKER_ROOT = workerRoot;
	try {
		await assert.rejects(
			() => startMemoryDb({ configurationDirectory, workspaceRoot, sessionId: "impostor" }),
			/already running on port 8420/,
		);
		assert.deepEqual(receivedAuthorization, []);
	} finally {
		if (previous === undefined) delete process.env.CODETONOMY_WORKER_ROOT;
		else process.env.CODETONOMY_WORKER_ROOT = previous;
		await new Promise<void>((resolveClose, rejectClose) => impostor.close((error) => error ? rejectClose(error) : resolveClose()));
	}
});

test("memoryDB reports bounded sidecar output when startup fails", { skip: process.platform === "linux" }, async (t) => {
	const configurationDirectory = await mkdtemp(join(homedir(), ".codetonomy-memory-output-"));
	const runtimeDirectory = `${configurationDirectory}-memorydb`;
	const workerRoot = join(runtimeDirectory, "workers");
	const workspaceRoot = await mkdtemp(join(tmpdir(), "codetonomy-memory-output-workspace-"));
	t.after(() => Promise.all([
		rm(configurationDirectory, { recursive: true, force: true }),
		rm(runtimeDirectory, { recursive: true, force: true }),
		rm(workspaceRoot, { recursive: true, force: true }),
	]));
	await createManagedMemoryFixture(workerRoot, `
process.stderr.write("fixture sidecar failed before listening\\n");
process.exitCode = 23;
`);
	const previous = process.env.CODETONOMY_WORKER_ROOT;
	process.env.CODETONOMY_WORKER_ROOT = workerRoot;
	try {
		await assert.rejects(
			() => startMemoryDb({ configurationDirectory, workspaceRoot, sessionId: "failure" }),
			/TencentDB memory service exited during startup \(23\)[\s\S]*fixture sidecar failed before listening/,
		);
	} finally {
		if (previous === undefined) delete process.env.CODETONOMY_WORKER_ROOT;
		else process.env.CODETONOMY_WORKER_ROOT = previous;
	}
});

test("clipboard images use native paste and Unlimited OCR text fallback", async () => {
	const image = await readClipboard({
		hasImage: () => true,
		getImageBinary: async () => [...Buffer.from("png-fixture")],
		getText: async () => "unused",
	});
	assert.equal(Buffer.from(image.image!.data, "base64").toString(), "png-fixture");
	assert.deepEqual(await readClipboard({ hasImage: () => false, getImageBinary: async () => [], getText: async () => "pasted text" }), { text: "pasted text" });
	let parsedPath = "";
	const text = await ocrClipboardImages([image.image!], {
		ocrModelRevision: "model-revision",
		ocrCodeRevision: "code-revision",
		ocr: { parse: async (request) => {
			parsedPath = request.assetPath;
			assert.equal((await readFile(parsedPath)).toString(), "png-fixture");
			return {
				documentId: "clipboard",
				assetVersionId: "version",
				parser: { id: "unlimited-ocr", version: "1", configurationHash: "config" },
				pages: [{ pageNumber: 1, width: 1, height: 1, blocks: [{ blockId: "one", type: "paragraph", readingOrder: 0, text: "OCR text", confidence: 1 }] }],
			};
		} },
	});
	assert.match(text, /parser="unlimited-ocr"[\s\S]*OCR text/);
	await assert.rejects(() => stat(parsedPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
	await assert.rejects(() => ocrClipboardImages([image.image!], undefined), /configure Unlimited OCR/);
});

test("CLI parses a non-interactive run and repeated files", () => {
	assert.deepEqual(parseArguments(["run", "--file", "a.txt", "--file", "b.txt", "--provider", "openai", "--model", "gpt-5.4-mini", "--json", "summarize", "these"]), {
		command: "run",
		objective: "summarize these",
		files: ["a.txt", "b.txt"],
		json: true,
		provider: "openai",
		modelId: "gpt-5.4-mini",
		permissionMode: "ask",
	});
});

test("CLI parses a six-variant evaluation task", () => {
	assert.deepEqual(parseArguments(["eval", "--file", "README.md", "Scan", "the", "project"]), {
		command: "eval",
		files: ["README.md"],
		json: false,
		provider: undefined,
		modelId: undefined,
		permissionMode: "ask",
		objective: "Scan the project",
	});
});

test("CLI permission modes gate non-interactive writes", () => {
	assert.equal(parseArguments(["run", "--permission-mode", "auto", "write a file"]).permissionMode, "auto");
	assert.equal(parseArguments(["run", "--permission-mode", "full-access", "write a file"]).permissionMode, "full-access");
	assert.deepEqual(parseArguments(["run", "--approve-writes", "write a file"]), {
		command: "run",
		objective: "write a file",
		files: [],
		json: false,
		provider: undefined,
		modelId: undefined,
		permissionMode: "auto",
		approveWrites: true,
	});
	assert.throws(() => parseArguments(["run", "--approve-writes", "--permission-mode", "ask", "write a file"]), /only compatible/);
	assert.throws(() => parseArguments(["run", "--approve-writes", "--permission-mode", "full-access", "write a file"]), /only compatible/);
	assert.throws(() => parseArguments(["run", "--permission-mode", "invalid", "write a file"]), /requires ask, auto, or full-access/);
	assert.equal(parseArguments(["run", "--tool-interface", "bash", "inspect the project"]).toolInterface, "bash");
	assert.equal(parseArguments(["eval", "--tool-interface", "structured", "inspect the project"]).toolInterface, "structured");
	assert.throws(() => parseArguments(["run", "--tool-interface", "shell", "inspect"]), /requires structured or bash/);
	const budgeted = parseArguments(["run", "--max-cost-usd", "1.25", "--max-total-tokens", "50000", "inspect the project"]);
	assert.equal(budgeted.maxCostUsd, 1.25);
	assert.equal(budgeted.maxTotalTokens, 50_000);
	assert.throws(() => parseArguments(["run", "--max-cost-usd", "0", "inspect"]), /greater than 0/);
	assert.throws(() => parseArguments(["run", "--max-total-tokens", "1.5", "inspect"]), /integer/);
});

test("CLI benchmark accepts auto and full-access permission modes", () => {
	assert.deepEqual(parseArguments([
		"benchmark", "--company", "Polar Co", "--annual-report", "report.pdf", "--csv", "history.csv", "--approve-writes",
	]), {
		command: "benchmark",
		files: [],
		json: false,
		company: "Polar Co",
		annualReport: "report.pdf",
		historicalCsv: "history.csv",
		permissionMode: "auto",
		approveWrites: true,
	});
	assert.equal(parseArguments([
		"benchmark", "--company", "Polar Co", "--annual-report", "report.pdf", "--csv", "history.csv", "--permission-mode", "full-access",
	]).permissionMode, "full-access");
	assert.throws(() => parseArguments([
		"benchmark", "--company", "Polar Co", "--annual-report", "report.pdf", "--csv", "history.csv",
	]), /--permission-mode/);
});

test("CLI parses dashboard and evaluation data-management commands", () => {
	assert.deepEqual(parseArguments(["dashboard", "--port", "8042"]), { command: "dashboard", files: [], json: false, port: 8042 });
	assert.deepEqual(parseArguments(["export", "run-123", "bundle"]), { command: "export", files: [], json: false, runId: "run-123", destination: "bundle" });
	assert.deepEqual(parseArguments(["backup", "backup.sqlite"]), { command: "backup", files: [], json: false, destination: "backup.sqlite" });
	assert.deepEqual(parseArguments(["restore", "backup.sqlite", "--replace"]), { command: "restore", files: [], json: false, destination: "backup.sqlite", replace: true });
	assert.deepEqual(parseArguments(["prune", "--days", "14", "--keep", "50"]), { command: "prune", files: [], json: false, days: 14, keep: 50 });
	assert.throws(() => parseArguments(["prune", "--days", "0", "--keep", "0"]), /--confirm-empty/);
	assert.deepEqual(parseArguments(["prune", "--days", "0", "--keep", "0", "--confirm-empty"]), { command: "prune", files: [], json: false, days: 0, keep: 0, confirmEmpty: true });
	assert.throws(() => parseArguments(["dashboard", "--port", "70000"]), /0-65535/);
	assert.deepEqual(parseArguments(["verify-release", "release", "--public-key", "trusted.pem"]), { command: "verify-release", files: [], json: false, destination: "release", publicKey: "trusted.pem" });
});

test("live provider smoke is double-explicit and scope-bounded", () => {
	assert.throws(() => parseArguments(["smoke-providers", "--provider", "openai"]), /--live/);
	assert.throws(() => parseArguments(["smoke-providers", "--live", "--all", "--provider", "openai"]), /exactly one/);
	assert.deepEqual(parseArguments(["smoke-providers", "--live", "--provider", "openai"]), { command: "smoke-providers", files: [], json: false, live: true, provider: "openai" });
});

test("terminal output makes control sequences inert", () => {
	const malicious = "hello\u001b]0;owned\u0007\rworld";
	const sanitized = sanitizeTerminalText(malicious);
	assert.equal(sanitized, "hello\\u{1b}]0;owned\\u{07}\\u{0d}world");
	assert.equal(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(sanitized), false);
	assert.equal(sanitizeTerminalText("first\nsecond"), "first\nsecond");
	assert.equal(sanitizeTerminalText("API_KEY=plainSecretValue1234567890"), "API_KEY=[REDACTED]");
	assert.equal(sanitizeTerminalText("TOKEN=https://example.test/private"), "TOKEN=[REDACTED]");
	assert.equal(sanitizeTerminalText("failed at https://user:password@example.test/v1"), "failed at https://[REDACTED]@example.test/v1");
	assert.equal(sanitizeTerminalText('{"api_key":"plainSecretValue1234567890"}'), '{"api_key":"[REDACTED]"}');
	assert.equal(sanitizeTerminalText('{"api_key":"prefix\\"plainSecretValue1234567890"}'), '{"api_key":"[REDACTED]"}');
});

test("provider setup keeps secrets separate and resolves the saved default", async () => {
	const directory = await mkdtemp(join(tmpdir(), "codetonomy-config-"));
	await saveConfiguration({
		directory,
		configuration: {
			version: 1,
			defaultProvider: "openai",
			providers: [{
				id: "openai",
				name: "OpenAI",
				kind: "openai",
				modelId: "gpt-5.4-mini",
				models: ["gpt-5.4-mini", "gpt-5.4"],
				apiKeyEnv: "CODETONOMY_TEST_ONLY_API_KEY",
			}],
		},
		credentials: { CODETONOMY_TEST_ONLY_API_KEY: "test-secret" },
	});
	const loaded = await loadConfiguration(directory);
	assert.equal(loaded.configuration.defaultProvider, "openai");
	assert.deepEqual(loaded.configuration.providers[0]?.models, ["gpt-5.4-mini", "gpt-5.4"]);
	assert.equal(resolveProviderSelection(loaded).providerConfiguration?.apiKey, "test-secret");
	assert.equal(resolveProviderSelection(loaded, "openai", "gpt-5.4").modelId, "gpt-5.4");
	await persistProviderSelection(loaded, resolveProviderSelection(loaded, "openai", "gpt-5.4"));
	assert.equal(resolveProviderSelection(await loadConfiguration(directory)).modelId, "gpt-5.4");
	assert.throws(() => resolveProviderSelection(loaded, "openai", "gpt-5.5"), /not selected/);
	assert.doesNotMatch(await readFile(join(directory, "config.json"), "utf8"), /test-secret/);
	if (process.platform !== "win32") assert.equal((await stat(join(directory, "credentials.env"))).mode & 0o077, 0);
	assert.throws(() => validateConfiguration({
		version: 1,
		providers: [{
			id: "local",
			name: "Local",
			kind: "openai-compatible",
			modelId: "model",
			models: ["model"],
			baseUrl: "file:///tmp/model",
			apiKeyEnv: "LOCAL_API_KEY",
		}],
	}), /HTTP or HTTPS/);
	for (const baseUrl of ["https://user:secret@example.test/v1", "https://example.test/v1?token=secret", "http://example.test/v1"]) {
		assert.throws(() => validateConfiguration({ version: 1, providers: [{ id: "local", name: "Local", kind: "openai-compatible", modelId: "model", models: ["model"], baseUrl, apiKeyEnv: "LOCAL_API_KEY" }] }), /cannot contain|must use HTTPS/);
	}
	assert.deepEqual(validateConfiguration({
		version: 1,
		providers: [{
			id: "openai",
			name: "OpenAI",
			kind: "openai",
			modelId: "legacy-model",
			apiKeyEnv: "OPENAI_API_KEY",
		}],
	}).providers[0]?.models, ["legacy-model"]);
	await writeFile(join(directory, "config.json"), `${await readFile(join(directory, "config.json"), "utf8")} `, "utf8");
	await assert.rejects(() => saveConfiguration(loaded), /changed while setup was open/);
});

test("env-only built-in providers pass credentials through the redaction boundary", () => {
	const previous = process.env.OPENAI_API_KEY;
	process.env.OPENAI_API_KEY = "opaqueEnvCredentialValue123456789";
	try {
		const selection = resolveProviderSelection({ directory: "/unused", configuration: { version: 1, providers: [] }, credentials: {} }, "openai", "gpt-5.4-mini");
		assert.equal(selection.providerConfiguration?.kind, "openai");
		assert.equal(selection.providerConfiguration?.apiKey, process.env.OPENAI_API_KEY);
	} finally {
		if (previous === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = previous;
	}
});

test("legacy provider configuration migrates to the current schema", () => {
	const migrated = validateConfiguration(migrateConfiguration({
		version: 0,
		default_provider: "local",
		providers: [{
			id: "local",
			name: "Local",
			kind: "openai-compatible",
			model: "coder",
			base_url: "http://127.0.0.1:11434/v1",
			api_key_env: "LOCAL_API_KEY",
		}],
	}));
	assert.equal(migrated.version, 1);
	assert.equal(migrated.defaultProvider, "local");
	assert.deepEqual(migrated.providers[0]?.models, ["coder"]);
	assert.throws(() => validateConfiguration({ version: 2, providers: [] }), /Unsupported/);
});

test("provider model discovery uses live endpoint shapes and OpenCode presets", async () => {
	const zen = PROVIDER_PRESETS.find(({ id }) => id === "opencode")!;
	const go = PROVIDER_PRESETS.find(({ id }) => id === "opencode-go")!;
	assert.equal(providerModelsUrl({ ...zen, models: [zen.modelId] }), "https://opencode.ai/zen/v1/models");
	assert.equal(providerModelsUrl({ ...go, models: [go.modelId] }), "https://opencode.ai/zen/go/v1/models");
	assert.deepEqual(await fetchProviderModels(
		{ ...go, models: [go.modelId] },
		undefined,
		undefined,
		(async () => new Response(JSON.stringify({ data: [{ id: "kimi-k2.6" }, { id: "future-unknown-model" }] }))) as typeof fetch,
	), ["kimi-k2.6", "future-unknown-model"]);
	const dynamic = await fetchProviderModelCatalog(
		{ ...go, models: [go.modelId] },
		undefined,
		undefined,
		(async (input) => String(input) === "https://models.dev/api.json"
			? new Response(JSON.stringify({ "opencode-go": { models: {
				"kimi-k2.6": { id: "kimi-k2.6", name: "Kimi K2.6", tool_call: true, reasoning: true, modalities: { input: ["text", "image"] }, limit: { context: 262_144, output: 65_536 }, cost: { input: 0.95, output: 4, cache_read: 0.16 } },
				"future-unknown-model": { id: "future-unknown-model", name: "Future", tool_call: true, reasoning: false, provider: { npm: "@ai-sdk/openai" }, modalities: { input: ["text"] }, limit: { context: 128_000, output: 16_000 }, cost: { input: 1, output: 2 } },
			} } }))
			: new Response(JSON.stringify({ data: [{ id: "kimi-k2.6" }, { id: "future-unknown-model" }, { id: "unverified-model" }] }))) as typeof fetch,
	);
	assert.deepEqual(dynamic.models, ["kimi-k2.6", "future-unknown-model"]);
	assert.deepEqual(dynamic.metadata.map(({ id, api, cost, input }) => ({ id, api, cost, input })), [
		{ id: "kimi-k2.6", api: "openai-completions", cost: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 }, input: ["text", "image"] },
		{ id: "future-unknown-model", api: "openai-responses", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, input: ["text"] },
	]);

	const provider: ProviderSettings = {
		id: "local",
		name: "Local",
		kind: "openai-compatible",
		baseUrl: "http://127.0.0.1:11434/v1",
		modelId: "old",
		models: ["old"],
		apiKeyEnv: "LOCAL_API_KEY",
	};
	let request: { url: string; authorization?: string } | undefined;
	const models = await fetchProviderModels(provider, "secret", undefined, (async (input, init) => {
		request = { url: String(input), authorization: new Headers(init?.headers).get("authorization") ?? undefined };
		return new Response(JSON.stringify({ data: [{ id: "coder-small" }, { id: "coder-large" }] }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch);
	assert.deepEqual(models, ["coder-small", "coder-large"]);
	assert.deepEqual(request, { url: "http://127.0.0.1:11434/v1/models", authorization: "Bearer secret" });
});

test("model picker toggles checkboxes with Space and confirms with Enter", () => {
	const picker = new ModelPicker(["alpha", "beta"], ["alpha"]);
	let selected: string[] | undefined;
	picker.onSubmit = (models) => { selected = models; };
	picker.handleInput(" ");
	picker.handleInput("\u001b[B");
	picker.handleInput(" ");
	picker.handleInput("\r");
	assert.deepEqual(selected, ["beta"]);
});

test("workspace conversations persist privately and survive reload", async () => {
	const directory = await mkdtemp(join(tmpdir(), "codetonomy-session-config-"));
	const workspace = await mkdtemp(join(tmpdir(), "codetonomy-session-workspace-"));
	let session = createSession(workspace, 1);
	session = appendConversationTurn(session, {
		runId: "run-1",
		objective: "Inspect the project",
		output: "The project contains a CLI.",
		timestamp: 2,
	}, 2);
	await saveSession(directory, session);
	const loaded = await loadSession(directory, workspace, session.id);
	assert.equal(loaded.id, session.id);
	assert.deepEqual(loaded.turns, session.turns);
	const [workspaceDirectory] = await readdir(join(directory, "sessions"));
	const sessionFiles = (await readdir(join(directory, "sessions", workspaceDirectory!))).filter((file) => file.endsWith(".json"));
	assert.equal(sessionFiles.length, 1);
	if (process.platform !== "win32") assert.equal((await stat(join(directory, "sessions", workspaceDirectory!, sessionFiles[0]!))).mode & 0o077, 0);

	let second = appendConversationTurn(createSession(workspace, 3), { runId: "run-2", objective: "Review tests", output: "Tests pass.", timestamp: 4 }, 4);
	second = { ...second, title: "Review Test Coverage" };
	await saveSession(directory, second);
	assert.deepEqual((await listSessions(directory, workspace)).map(({ id }) => id), [second.id, session.id]);
	assert.equal((await loadSessionByPrefix(directory, workspace, second.id.slice(0, 8))).id, second.id);
});

test("session model report groups exact parent and subagent usage", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "codetonomy-model-report-"));
	let session = createSession(workspace, 1);
	const first = { input: 100, output: 20, cacheRead: 50, cacheWrite: 0, totalTokens: 170, cost: { input: 0.1, output: 0.02, cacheRead: 0.005, cacheWrite: 0, total: 0.125 } };
	session = addSessionModelUsage(session, "opencode-go", "deepseek-v4-flash", first);
	session = addSessionModelUsage(session, "opencode-go", "deepseek-v4-flash", { ...first, input: 200, totalTokens: 270 });
	session = addSessionModelUsage(session, "openai", "gpt-5.4-mini", { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 });
	const rows = sessionModelUsage(session);
	assert.equal(rows[0]?.requests, 2);
	assert.equal(rows[0]?.usage.input, 300);
	assert.match(formatModelUsageReport(rows), /opencode-go\/deepseek-v4-flash[\s\S]*requests 2[\s\S]*total 440[\s\S]*openai\/gpt-5\.4-mini[\s\S]*All models · 455 tokens/);
	assert.ok(createSlashCommands([]).some(({ name }) => name === "report"));
	const legacy = appendConversationTurn(createSession(workspace, 2), { runId: "legacy", objective: "Old turn", output: "Done", timestamp: 3, model: "opencode-go/deepseek-v4-flash", usage: first });
	assert.deepEqual(sessionModelUsage(legacy).map(({ provider, model, requests }) => ({ provider, model, requests })), [{ provider: "opencode-go", model: "deepseek-v4-flash", requests: 1 }]);
});

test("session titles are bounded, generated once, and fall back safely", async () => {
	let calls = 0;
	assert.equal(await generateSessionTitle("Investigate provider failures", async () => { calls++; return 'Title: "Provider Failure Review"'; }), "Provider Failure Review");
	assert.equal(calls, 1);
	assert.equal(await generateSessionTitle("Fallback request", async () => { throw new Error("offline"); }), "Fallback request");
	assert.equal(await generateSessionTitle("Fixture request", async () => "Fixture agent completed: Return only a title"), "Fixture request");
	assert.equal(normalizeSessionTitle("a".repeat(100), "fallback").length, 80);
});

test("OpenCode Go DeepSeek models show the upstream compatibility notice", () => {
	assert.match(providerCompatibilityNotice({ provider: "opencode-go", modelId: "deepseek-v4-pro" })!, /upstream reports/);
	assert.equal(providerCompatibilityNotice({ provider: "deepseek", modelId: "deepseek-v4-pro" }), undefined);
	assert.ok(createSlashCommands([], [], [{ id: "12345678-1234-4234-8234-123456789abc", title: "Prior work" }]).some(({ name }) => name === "session"));
	assert.ok(createSlashCommands([]).some(({ name }) => name === "reasoning"));
});

test("the docked footer reports exact prompt occupancy and reasoning animation advances", () => {
	assert.equal(formatUsage({
		usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 0, reasoning: 5, totalTokens: 175 },
		modelContext: { contextWindow: 1_000, maxOutputTokens: 100, lastPromptTokens: 150 },
	}), "150 / 1,000 tokens (15%)");
	assert.equal(stripTerminalSequences(renderReasoningGlow(0)), "Reasoning");
	assert.equal(stripTerminalSequences(renderReasoningGlow(8)), "Reasoning");
	assert.equal(stripTerminalSequences(renderSubagentStrip([{ id: "researcher", state: "working" }], 1)), "● 1 agent working · [main] [researcher:working]");
});

test("polar bear renders responsively and maps harness work to distinct animations", () => {
	assert.equal(mascotActivityForEvent({ type: "task.compiled", data: {} }), "planning");
	assert.equal(mascotActivityForEvent({ type: "tool.started", data: { toolId: "inspect_workspace" } }), "searching");
	assert.equal(mascotActivityForEvent({ type: "tool.started", data: { toolId: "write_file" } }), "building");
	assert.equal(mascotActivityForEvent({ type: "verification.started", data: {} }), "verifying");
	assert.equal(mascotActivityForEvent({ type: "run.completed", data: {} }), "success");
	assert.equal(mascotActivityForEvent({ type: "run.failed", data: {} }), "failed");
	assert.notDeepEqual(renderPolarBear("planning", 0), renderPolarBear("planning", 1));
	assert.notDeepEqual(renderPolarBear("searching", 0), renderPolarBear("searching", 1));
	assert.notDeepEqual(renderPolarBear("building", 0), renderPolarBear("building", 1));

	const mascot = new PolarBearWelcome(() => {}, { model: "fixture/faux-1", workspace: "~/project" });
	for (const width of [52, 92]) {
		const rendered = mascot.render(width);
		assert.ok(rendered.every((line) => visibleWidth(line) === width));
		assert.match(rendered.map(stripTerminalSequences).join("\n"), /CODETONOMY/);
	}
});

test("interactive input parses commands, quoted files, and explicit skills", () => {
	assert.deepEqual(parseSlashCommand(" /MODEL openai/gpt-5.4-mini "), {
		name: "model",
		argument: "openai/gpt-5.4-mini",
	});
	assert.deepEqual(parsePrompt('Compare @README.md @"docs/annual report.md" $app-builder', new Set(["app-builder"])), {
		objective: "Compare $app-builder",
		files: ["README.md", "docs/annual report.md"],
		skillNames: ["app-builder"],
	});
	assert.deepEqual(parsePrompt("Explain $HOME and $missing", new Set()), {
		objective: "Explain $HOME and $missing",
		files: [],
		skillNames: [],
	});
	assert.throws(() => parsePrompt('Read @"unfinished', new Set()), /Unterminated/);
});

test("skill manifests resolve dependencies and reject conflicts and cycles", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-skill-manifest-"));
	for (const name of ["base", "dependent", "conflicting", "cycle-a", "cycle-b"]) {
		await mkdir(join(root, name), { recursive: true });
	}
	await writeFile(join(root, "base", "SKILL.md"), `---
name: base
version: "1.2.0"
required_tools: [inspect_workspace]
---
Base instructions`, "utf8");
	await writeFile(join(root, "dependent", "SKILL.md"), `---
name: dependent
dependencies:
  - base
required_permissions: [workspace-read]
verifiers: [workspace-evidence]
---
Dependent instructions`, "utf8");
	await writeFile(join(root, "conflicting", "SKILL.md"), `---
conflicts: [dependent]
---
Conflict`, "utf8");
	await writeFile(join(root, "cycle-a", "SKILL.md"), `---
dependencies: [cycle-b]
---`, "utf8");
	await writeFile(join(root, "cycle-b", "SKILL.md"), `---
dependencies: [cycle-a]
---`, "utf8");
	const catalog = ["base", "dependent", "conflicting", "cycle-a", "cycle-b"].map((name) => ({
		name,
		path: join(root, name, "SKILL.md"),
		root,
		source: "workspace" as const,
	}));
	const activated = await loadActivatedSkills(catalog, ["dependent"]);
	assert.deepEqual(activated.map(({ id }) => id), ["base", "dependent"]);
	assert.equal(activated[0]?.manifest?.version, "1.2.0");
	assert.deepEqual(activated[1]?.manifest?.requiredPermissions, ["workspace-read"]);
	await assert.rejects(() => loadActivatedSkills(catalog, ["dependent", "conflicting"]), /conflicts/);
	await assert.rejects(() => loadActivatedSkills(catalog, ["cycle-a"]), /dependency cycle/);
	assert.throws(() => parseSkillDocument("bad", "---\nrequired_tools: [../../escape]\n---"), /Invalid required_tools/);
});

test("skill routing uses concise metadata and never auto-loads workspace instructions", () => {
	const catalog = [
		{
			name: "phone-agent",
			path: "/user/phone-agent/SKILL.md",
			root: "/user",
			source: "user" as const,
			description: "Place phone calls, send SMS, and manage phone numbers.",
		},
		{
			name: "repo-instructions",
			path: "/workspace/repo/SKILL.md",
			root: "/workspace",
			source: "workspace" as const,
			description: "Place phone calls, send SMS, and manage phone numbers.",
		},
		{
			name: "spreadsheet-agent",
			path: "/user/sheets/SKILL.md",
			root: "/user",
			source: "user" as const,
			description: "Create formulas and validate spreadsheet workbooks.",
		},
	];
	assert.deepEqual(routeSkills("Send an SMS to this phone number", catalog), ["phone-agent"]);
	assert.deepEqual(routeSkills("Explain this code", catalog), []);
	assert.deepEqual(routeSkills("Find the function in the codebase that clamps the token budget", [
		{ name: "recursive-context-pruning-token-budgeting", path: "/user/context/SKILL.md", root: "/user", source: "user", description: "Prune recursive context and manage token budgets." },
		{ name: "artifact-template-market-trends-report", path: "/user/report/SKILL.md", root: "/user", source: "user", description: "Create market trend report artifacts." },
	]), []);
});

test("skill metadata router reaches at least 95 percent on a labeled qualification set", () => {
	const catalog = [
		{ name: "spreadsheet-agent", description: "Create formulas and validate spreadsheet workbooks", source: "user" as const },
		{ name: "presentation-agent", description: "Create slide decks and validate presentation layouts", source: "user" as const },
		{ name: "backtesting-agent", description: "Run trading strategy backtests and validate ledgers", source: "user" as const },
		{ name: "research-agent", description: "Research evidence and produce sourced claims", source: "user" as const },
	].map((skill) => ({ ...skill, path: `/skills/${skill.name}/SKILL.md`, root: "/skills" }));
	const labeled = [
		["Build a spreadsheet workbook with formulas", "spreadsheet-agent"], ["Validate spreadsheet formulas", "spreadsheet-agent"],
		["Create a financial spreadsheet workbook", "spreadsheet-agent"], ["Inspect this spreadsheet workbook", "spreadsheet-agent"],
		["Generate spreadsheet formulas and totals", "spreadsheet-agent"], ["Create a presentation slide deck", "presentation-agent"],
		["Validate presentation slide layouts", "presentation-agent"], ["Build a presentation with charts", "presentation-agent"],
		["Review the presentation deck layout", "presentation-agent"], ["Make presentation slides", "presentation-agent"],
		["Run a backtesting strategy", "backtesting-agent"], ["Validate the backtesting trade ledger", "backtesting-agent"],
		["Build a trading strategy backtest", "backtesting-agent"], ["Review backtesting results", "backtesting-agent"],
		["Execute backtesting on market data", "backtesting-agent"], ["Research evidence for this claim", "research-agent"],
		["Produce sourced research claims", "research-agent"], ["Research and reconcile evidence", "research-agent"],
		["Investigate with sourced research", "research-agent"], ["Summarize research evidence", "research-agent"],
	] as const;
	const correct = labeled.filter(([objective, expected]) => routeSkills(objective, catalog)[0] === expected).length;
	assert.ok(correct / labeled.length >= 0.95, `${correct}/${labeled.length} correctly routed`);
});

test("Pi autocomplete serves slash commands, @files, and $skills without fd", async () => {
	const skills = [{ name: "app-builder", path: "/skills/app-builder/SKILL.md", root: "/skills", source: "user" as const }];
	const provider = createAutocompleteProvider(createSlashCommands(skills), skills, ["README.md", "docs/annual report.md"], process.cwd());
	const signal = new AbortController().signal;
	const slash = await provider.getSuggestions(["/mo"], 0, 3, { signal });
	assert.ok(slash?.items.some(({ value }) => value === "model"));
	const file = await provider.getSuggestions(["Read @annual"], 0, 12, { signal });
	assert.equal(file?.items[0]?.value, '@"docs/annual report.md"');
	const skill = await provider.getSuggestions(["Use $app"], 0, 8, { signal });
	assert.equal(skill?.items[0]?.value, "app-builder");
	assert.equal(provider.applyCompletion(["Use $app"], 0, 8, skill!.items[0]!, "$app").lines[0], "Use $app-builder ");
});

test("skill and file discovery honor workspace precedence and ignored directories", async () => {
	const root = await mkdtemp(join(tmpdir(), "agent-harness-interaction-"));
	const codexRoot = join(root, "codex-home");
	await mkdir(join(root, ".agents", "skills", "shared"), { recursive: true });
	await mkdir(join(codexRoot, "skills", "shared"), { recursive: true });
	await mkdir(join(codexRoot, "plugins", "cache", "demo", "1", "skills", "plugin-skill"), { recursive: true });
	await mkdir(join(root, "node_modules", "ignored"), { recursive: true });
	await writeFile(join(root, ".agents", "skills", "shared", "SKILL.md"), "workspace instructions", "utf8");
	await writeFile(join(codexRoot, "skills", "shared", "SKILL.md"), "user instructions", "utf8");
	await writeFile(join(codexRoot, "plugins", "cache", "demo", "1", "skills", "plugin-skill", "SKILL.md"), "plugin instructions", "utf8");
	await writeFile(join(root, "annual report.md"), "report", "utf8");
	await writeFile(join(root, "node_modules", "ignored", "secret.txt"), "skip", "utf8");

	const skills = await discoverSkills(root, codexRoot);
	assert.deepEqual(skills.map(({ name, source }) => ({ name, source })), [
		{ name: "plugin-skill", source: "plugin" },
		{ name: "shared", source: "workspace" },
	]);
	const activated = await loadActivatedSkills(skills, ["shared"]);
	assert.equal(activated[0]?.id, "shared");
	assert.equal(activated[0]?.instructions, "workspace instructions");
	assert.deepEqual(activated[0]?.manifest, {
		id: "shared",
		version: "0.0.0",
		dependencies: [],
		conflicts: [],
		requiredCapabilities: [],
		requiredTools: [],
		requiredPermissions: [],
		verifierIds: [],
	});
	const oversizedPath = join(root, "oversized-skill.md");
	await writeFile(oversizedPath, Buffer.alloc(64 * 1024 + 1));
	await assert.rejects(
		() => loadActivatedSkills([{ name: "oversized", path: oversizedPath, root, source: "workspace" }], ["oversized"]),
		/exceeds/,
	);
	if (process.platform !== "win32") {
		const linkPath = join(root, "linked-skill.md");
		await symlink(join(root, ".agents", "skills", "shared", "SKILL.md"), linkPath);
		await assert.rejects(() => loadActivatedSkills([{ name: "linked", path: linkPath, root, source: "workspace" }], ["linked"]));
		const outside = await mkdtemp(join(tmpdir(), "agent-harness-outside-skill-"));
		await writeFile(join(outside, "SKILL.md"), "outside instructions", "utf8");
		await symlink(outside, join(root, ".agents", "skills", "escaped"));
		await assert.rejects(() => loadActivatedSkills([{ name: "escaped", path: join(root, ".agents", "skills", "escaped", "SKILL.md"), root: join(root, ".agents", "skills"), source: "workspace" }], ["escaped"]), /outside its catalog root/);
	}
	const files = await discoverWorkspaceFiles(root);
	assert.ok(files.includes("annual report.md"));
	assert.ok(!files.some((file) => file.includes("node_modules")));
});
