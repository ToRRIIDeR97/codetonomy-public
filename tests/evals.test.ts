import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { compareBenchmark, EVALUATION_VARIANTS, EvaluationStore, exportRunBundle, qualifyL2, qualifyL2Evidence, restoreEvaluationBackup, runBenchmarkMatrix, runTaskBenchmark, type L2Trial } from "../packages/evals/src/index.js";
import { startDashboardServer } from "../apps/daemon/src/index.ts";
import { createHarness } from "../packages/runtime/src/index.js";

test("evaluation store reduces canonical traces and compares benchmark variants", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-evals-"));
	const store = new EvaluationStore(join(root, "evaluations.sqlite"));
	t.after(() => store.close());
	const harness = createHarness();
	const outcomes = await runBenchmarkMatrix(store, [
		{
			benchmarkId: "valuation-fixture",
			variant: "RAW_MODEL",
			execute: () => harness.run({ objective: "Create a valuation workbook", workspaceRoot: root, traceDirectory: join(root, "runs") }),
		},
		{
			benchmarkId: "valuation-fixture",
			variant: "FULL_PRESET",
			execute: () => harness.run({ objective: "Return a concise success response", workspaceRoot: root, traceDirectory: join(root, "runs") }),
		},
	]);
	assert.equal(outcomes[0]?.metrics?.verified, false);
	assert.equal(outcomes[1]?.metrics?.verified, true);
	assert.equal(store.listRuns().length, 2);
	assert.equal(store.benchmarkRuns("valuation-fixture").length, 2);
	const comparison = compareBenchmark(outcomes, "valuation-fixture");
	assert.equal(comparison.verifiedSuccessDelta, 1);
	assert.equal(comparison.candidateImprovesQuality, true);
	assert.ok((outcomes[0]?.metrics?.modelCalls ?? 0) > 0);
	assert.equal(outcomes[1]?.metrics?.firstPassVerified, true);
	assert.equal(outcomes[1]?.metrics?.requirementCoverage, 1);
	assert.equal(outcomes[1]?.metrics?.falseCompletion, false);
	assert.equal(outcomes[0]?.metrics?.falseCompletion, true);
});

test("task benchmark executes and persists all six harness variants", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-matrix-"));
	const store = new EvaluationStore(join(root, "evaluations.sqlite"));
	t.after(() => store.close());
	const result = await runTaskBenchmark(store, "simple-fixture", {
		objective: "Return a concise success response",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
	});
	assert.deepEqual(result.outcomes.map(({ variant }) => variant), [...EVALUATION_VARIANTS]);
	assert.equal(result.outcomes.every(({ runId, metrics }) => Boolean(runId) && metrics?.verified), true);
	assert.equal(store.benchmarkRuns("simple-fixture").length, EVALUATION_VARIANTS.length);
	const raw = store.runDetails(result.outcomes[0]!.runId!);
	const full = store.runDetails(result.outcomes.at(-1)!.runId!);
	const rawCapabilities = raw.events.find(({ type }) => type === "capabilities.resolved")?.data as { capabilities?: { toolIds?: unknown[]; permissionProfileId?: string } };
	const fullCapabilities = full.events.find(({ type }) => type === "capabilities.resolved")?.data as { capabilities?: { toolIds?: unknown[] } };
	assert.deepEqual(rawCapabilities.capabilities?.toolIds, []);
	assert.equal(rawCapabilities.capabilities?.permissionProfileId, "workspace-read");
	assert.ok((fullCapabilities.capabilities?.toolIds?.length ?? 0) > 0);
});

test("L2 qualification enforces every published safety and quality threshold", () => {
	const trials: L2Trial[] = Array.from({ length: 200 }, (_, index) => ({
		verified: index < 190,
		requiredCapabilities: ["research", "spreadsheet-write"],
		selectedCapabilities: ["research", "spreadsheet-write"],
		incorrectAgentSelection: index === 199,
		dependencyViolation: index === 199,
		duplicateDelegation: index === 199,
		falseCompletion: false,
		injectedFailure: index < 100,
		recoveredInjectedFailure: index < 90,
		permissionOvergrant: false,
	}));
	const qualification = qualifyL2(trials);
	assert.equal(qualification.qualified, true);
	assert.equal(qualification.metrics.injectedFailureRecovery, 0.9);
	assert.ok(qualification.confidence.injectedFailureRecoveryLowerBound >= 0.8);
	assert.equal(qualifyL2(trials.slice(0, 20)).qualified, false);
	assert.equal(qualifyL2(trials.map((trial, index) => index === 0 ? { ...trial, permissionOvergrant: true } : trial)).qualified, false);
});

test("L2 release qualification derives trials from unique persisted run evidence", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-l2-evidence-"));
	const result = await createHarness().run({ objective: "Return a concise success response", workspaceRoot: root, traceDirectory: join(root, "runs") });
	const evidence = { resultPath: join(result.tracePath, "..", "result.json"), expectedPresetId: "general-assistant" };
	const report = await qualifyL2Evidence([evidence]);
	assert.equal(report.trials[0]?.verified, true);
	assert.equal(report.trials[0]?.incorrectAgentSelection, false);
	assert.equal(report.trials[0]?.permissionOvergrant, false);
	assert.equal(report.qualification.qualified, false);
	await assert.rejects(() => qualifyL2Evidence([evidence, evidence]), /duplicate run result/);
});

test("evaluation database rejects symlinks and schemas newer than this build", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-eval-schema-"));
	const target = join(root, "target.sqlite");
	const database = new DatabaseSync(target);
	database.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES(99,datetime('now'));");
	database.close();
	assert.throws(() => new EvaluationStore(target), /newer/);
	await link(target, join(root, "linked.sqlite"));
	assert.throws(() => new EvaluationStore(join(root, "linked.sqlite")), /regular standalone/);
});

test("evaluation store waits for transient sqlite write locks", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-eval-lock-"));
	const databasePath = join(root, "evaluations.sqlite");
	const seed = new EvaluationStore(databasePath);
	seed.close();
	const holder = new DatabaseSync(databasePath);
	holder.exec("BEGIN IMMEDIATE");
	const script = [
		"import { EvaluationStore } from './packages/evals/src/index.ts';",
		"process.stdout.write('ready\\n');",
		"const store = new EvaluationStore(process.argv[1]);",
		"store.recordBenchmark('busy-test', 'RAW_MODEL');",
		"store.close();",
	].join(" ");
	const child = spawn(process.execPath, ["--import", "tsx", "--eval", script, databasePath], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
	const stderr: Buffer[] = [];
	child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
	await new Promise<void>((resolveReady, rejectReady) => {
		const timeout = setTimeout(() => rejectReady(new Error("evaluation lock test child did not start")), 5_000);
		child.once("error", rejectReady);
		child.stdout.on("data", (chunk: Buffer) => {
			if (chunk.toString().includes("ready")) {
				clearTimeout(timeout);
				resolveReady();
			}
		});
	});
	await new Promise((resolve) => setTimeout(resolve, 250));
	holder.exec("ROLLBACK");
	holder.close();
	const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveResult, rejectResult) => {
		child.once("error", rejectResult);
		child.once("exit", (code, signal) => resolveResult({ code, signal }));
	});
	assert.equal(result.code, 0, Buffer.concat(stderr).toString("utf8"));
});

test("write payloads are redacted from traces, the evaluation store, and exports", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-redaction-"));
	const marker = "CODETONOMY_SUPER_SECRET_MARKER";
	const credentialMarker = "plainSecretValue1234567890";
	const store = new EvaluationStore(join(root, "evaluations.sqlite"));
	t.after(() => store.close());
	let request = 0;
	const providerFetch: typeof fetch = async () => {
		request++;
		const base = { id: `redact-${request}`, object: "chat.completion.chunk", created: 1, model: "redaction-model" };
		const events = request === 1
			? [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "write-1", type: "function", function: { name: "write_workspace", arguments: JSON.stringify({ path: "payload.txt", content: marker }) } }] }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
			]
			: [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Created the requested file." }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
			];
		return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	const result = await createHarness().run({
		objective: `Create payload.txt with API_KEY=${credentialMarker}`,
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "redaction-provider",
		modelId: "redaction-model",
		providerConfiguration: { id: "redaction-provider", name: "Redaction Provider", kind: "openai-compatible", baseUrl: "https://provider.test/v1", apiKey: "private-key" },
		providerFetch,
		approve: async () => true,
		runStore: store,
	});
	assert.equal(await readFile(join(root, "payload.txt"), "utf8"), marker);
	assert.doesNotMatch(await readFile(result.tracePath, "utf8"), new RegExp(marker));
	assert.doesNotMatch(await readFile(result.tracePath, "utf8"), new RegExp(credentialMarker));
	assert.doesNotMatch(JSON.stringify(store.runDetails(result.runId)), new RegExp(marker));
	const exported = await exportRunBundle(store, result.runId, join(root, "exported"), { workspaceRoot: root });
	assert.doesNotMatch(await readFile(join(exported.path, "runs", result.runId, "trace.jsonl"), "utf8"), new RegExp(marker));
	const backup = join(root, "redacted.sqlite");
	await store.backupTo(backup);
	assert.doesNotMatch(await readFile(backup, "utf8"), new RegExp(credentialMarker));
});

test("export and prune never trust restored filesystem paths", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-path-trust-"));
	const outside = await mkdtemp(join(tmpdir(), "codetonomy-path-victim-"));
	const databasePath = join(root, "evaluations.sqlite");
	const store = new EvaluationStore(databasePath);
	const result = await createHarness().run({ objective: "Return a concise success response", workspaceRoot: root, traceDirectory: join(root, "runs"), runStore: store });
	const fakeRun = join(outside, result.runId);
	await mkdir(fakeRun);
	for (const name of ["trace.jsonl", "result.json", "orchestration-result.json", "checkpoint.json"]) await writeFile(join(fakeRun, name), "do-not-delete", "utf8");
	const victim = join(outside, "victim.txt");
	await writeFile(victim, "EXFILTRATION_MARKER", "utf8");
	const database = new DatabaseSync(databasePath);
	try {
		database.prepare("UPDATE runs SET trace_path=? WHERE run_id=?").run(join(fakeRun, "trace.jsonl"), result.runId);
		database.prepare("INSERT INTO artifacts(run_id,artifact_id,type,path,content) VALUES(?,?,?,?,?)").run(result.runId, "outside", "text", victim, "safe database record");
	} finally {
		database.close();
	}
	const bundle = await exportRunBundle(store, result.runId, join(root, "export"), { workspaceRoot: root });
	assert.equal(await readFile(join(bundle.path, "runs", result.runId, "artifacts", "outside-victim.txt.txt"), "utf8"), "safe database record\n");
	assert.equal(store.pruneBefore(new Date(Date.now() + 1_000), 0), 1);
	for (const name of ["trace.jsonl", "result.json", "orchestration-result.json", "checkpoint.json"]) assert.equal(await readFile(join(fakeRun, name), "utf8"), "do-not-delete");
	assert.equal(await readFile(victim, "utf8"), "EXFILTRATION_MARKER");
	store.close();
	assert.doesNotMatch(await readFile(databasePath, "utf8"), /safe database record/);
});

test("retention keeps and prunes orchestration families atomically", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-family-prune-"));
	const store = new EvaluationStore(join(root, "evaluations.sqlite"));
	const harness = createHarness();
	const parent = await harness.run({ objective: "Return a concise success response", workspaceRoot: root, traceDirectory: join(root, "runs") });
	const child = await harness.run({ objective: "Return a concise success response", workspaceRoot: root, traceDirectory: join(root, "runs") });
	await store.saveRun(parent);
	await store.saveRun(child, { parentRunId: parent.runId, childId: "child-1" });
	assert.equal(store.pruneBefore(new Date(Date.now() + 1_000), 1), 0);
	assert.deepEqual(store.runFamily(parent.runId), [parent.runId, child.runId]);
	assert.equal(store.pruneBefore(new Date(Date.now() + 1_000), 0), 2);
	assert.equal(store.listRuns().length, 0);
	store.close();
});

test("dashboard is loopback/authenticated and export, backup, and retention operate on the canonical store", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-eval-ops-"));
	const databasePath = join(root, "evaluations.sqlite");
	const store = new EvaluationStore(databasePath);
	const result = await createHarness().run({
		objective: "Return a concise success response",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		runStore: store,
	});
	assert.equal(store.summary().runs, 1);
	assert.equal(store.runDetails(result.runId).run.runId, result.runId);
	await writeFile(join(root, "references.lock.yaml"), "schema_version: 1\n", "utf8");
	const bundle = await exportRunBundle(store, result.runId, join(root, "export"), { referencesLockPath: join(root, "references.lock.yaml"), workspaceRoot: root });
	assert.ok(bundle.files >= 3);
	const manifest = JSON.parse(await readFile(join(bundle.path, "manifest.json"), "utf8")) as { rootRunId: string; files: unknown[] };
	assert.equal(manifest.rootRunId, result.runId);
	assert.ok(manifest.files.length >= 2);
	await store.backupTo(join(root, "backup.sqlite"));
	assert.ok((await stat(join(root, "backup.sqlite"))).size > 0);
	assert.equal(store.pruneBefore(new Date(Date.now() + 1_000), 0), 1);
	await assert.rejects(() => stat(result.tracePath), /ENOENT/);
	store.close();
	const restoredPath = join(root, "restored.sqlite");
	await restoreEvaluationBackup(join(root, "backup.sqlite"), restoredPath);
	const restored = new EvaluationStore(restoredPath);
	assert.equal(restored.listRuns().length, 1);
	restored.close();
	await assert.rejects(() => restoreEvaluationBackup(join(root, "backup.sqlite"), restoredPath), /--replace/);
	const replaced = await restoreEvaluationBackup(join(root, "backup.sqlite"), restoredPath, { replace: true });
	assert.ok(replaced.recoveryPath && (await stat(replaced.recoveryPath)).size > 0);
	assert.equal((await readdir(root)).some((name) => name.includes(".restore-") && (name.endsWith("-wal") || name.endsWith("-shm"))), false);

	const server = await startDashboardServer({ databasePath, port: 0, token: "a".repeat(32) });
	t.after(() => server.close());
	const base = new URL(server.url);
	base.search = "";
	assert.equal((await fetch(new URL("/health", base))).status, 200);
	assert.equal((await fetch(new URL("/api/runs", base))).status, 401);
	assert.equal((await fetch(new URL("/api/runs", base), { headers: { authorization: `Bearer ${server.token}` } })).status, 200);
	const benchmarkResponse = await fetch(new URL("/api/benchmarks", base), { headers: { authorization: `Bearer ${server.token}` } });
	assert.equal(benchmarkResponse.status, 200);
	assert.ok(Array.isArray(await benchmarkResponse.json()));
	const html = await (await fetch(server.url)).text();
	assert.match(html, /Codetonomy Runs|Benchmark comparisons/);
});
