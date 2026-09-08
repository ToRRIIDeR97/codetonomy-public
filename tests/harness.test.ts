import assert from "node:assert/strict";
import { link, mkdtemp, mkdir, readFile, rename, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createValuationWorkbook, verifyValuationWorkbook } from "../packages/artifacts/src/index.ts";
import { isSensitiveWorkspacePath } from "../packages/contracts/src/index.ts";
import { OcrHttpService, parseDocument } from "../packages/document-ir/src/index.ts";
import { HybridGraphMemory, LocalGraphMemory, TencentMemoryAdapter } from "../packages/memory-client/src/index.ts";
import { buildStableSystemPrompt, resolveCapabilities } from "../packages/capability-compiler/src/index.ts";
import { getPermissionProfile, PermissionGate } from "../packages/permissions/src/index.ts";
import { createHarness, projectConversation, runHarnessOrchestration } from "../packages/runtime/src/index.ts";
import { previewCheckpoint, RunCheckpoint, rewindCheckpoint } from "../packages/runtime/src/checkpoint.ts";
import { compileTask } from "../packages/task-compiler/src/index.ts";
import {
	editWorkspaceTool,
	createCodexSandboxInvocation,
	filterSandboxEnvironment,
	inspectWorkspaceTool,
	listWorkspaceTool,
	recordStructuredArtifactTool,
	delegateTasksTool,
	searchWorkspaceTool,
	runWorkspaceCommandTool,
	READ_ONLY_TOOL_IDS,
	writeWorkspaceTool,
} from "../packages/tools/src/index.ts";
import { verifyArtifacts, verifyOutput } from "../packages/verifiers/src/index.ts";

test("stable cache prefix ignores task text but run profile does not", () => {
	const first = resolveCapabilities(compileTask({ objective: "first task" }));
	const second = resolveCapabilities(compileTask({ objective: "second task" }));
	assert.equal(first.cachePrefixHash, second.cachePrefixHash);
	assert.equal(first.toolBundleHash, second.toolBundleHash);
	assert.match(first.skillPackHash, /^[0-9a-f]{64}$/);
	assert.match(first.contextPacketHash, /^[0-9a-f]{64}$/);
	assert.notEqual(first.runProfileHash, second.runProfileHash);
	const withTool = resolveCapabilities(compileTask({ objective: "first task", files: ["evidence.txt"] }));
	assert.equal(first.cachePrefixHash, withTool.cachePrefixHash);
	assert.notEqual(first.runProfileHash, withTool.runProfileHash);
	assert.deepEqual(withTool.toolIds, [
		"list_workspace", "search_workspace", "inspect_workspace", "inspect_document", "inspect_workbook", "inspect_presentation", "inspect_backtest", "record_structured_artifact",
	]);
	assert.equal(withTool.permissionProfileId, "workspace-read");
	const withOtherModel = resolveCapabilities(compileTask({ objective: "first task" }), {
		providerId: "fixture",
		modelId: "faux-2",
	});
	assert.notEqual(first.cachePrefixHash, withOtherModel.cachePrefixHash);
	const withSkill = resolveCapabilities(compileTask({ objective: "first task" }), undefined, ["app-builder"]);
	assert.equal(first.cachePrefixHash, withSkill.cachePrefixHash);
	assert.notEqual(first.runProfileHash, withSkill.runProfileHash);
	assert.ok(resolveCapabilities(compileTask({ objective: "read it", files: ["report.pdf"] })).toolIds.includes("inspect_document"));
});

test("every provider-facing tool uses an object-root JSON schema", () => {
	assert.equal((recordStructuredArtifactTool().parameters as { type?: string }).type, "object");
});

test("read-only tools are permissioned and structured inspection satisfies workspace evidence", () => {
	for (const profileId of ["workspace-read", "workspace-write"]) {
		const profile = getPermissionProfile(profileId);
		for (const toolId of READ_ONLY_TOOL_IDS) assert.equal(profile.toolDecisions[toolId], "ALLOW", `${profileId}/${toolId}`);
	}
	const task = compileTask({ objective: "Inspect the attached report", files: ["report.pdf"] });
	assert.equal(verifyOutput("The report was inspected.", undefined, { task, completedToolIds: ["inspect_document"] }).passed, true);
});

test("sensitive workspace path policy is platform-independent", () => {
	for (const path of [".env", "config/.env.production", ".ssh", ".ssh/id_ed25519", "config/secrets.yaml", "certs/server.pem", "nested\\.npmrc", ".kube/config", "nested\\.kube\\config"]) {
		assert.equal(isSensitiveWorkspacePath(path), true, path);
	}
	for (const path of ["src/environment.ts", "docs/secrets-management.md", "certs/server.pem.example", ".kube/config.example"]) {
		assert.equal(isSensitiveWorkspacePath(path), false, path);
	}
});

test("system prompt teaches the enabled tool contract without advertising unavailable tools", () => {
	const capabilities = resolveCapabilities(compileTask({ objective: "Implement the requested change" }));
	const prompt = buildStableSystemPrompt(capabilities.preset, ["inspect_workspace", "edit_workspace", "run_workspace_command"]);
	assert.match(prompt, /coding agent/);
	assert.match(prompt, /exact tool name.*one JSON object/);
	assert.match(prompt, /workspace-relative paths/);
	assert.match(prompt, /Never inspect filesystem root/);
	assert.match(prompt, /retrieved context before calling discovery tools/);
	assert.doesNotMatch(prompt, /search_workspace|list_workspace|indexed searches|architectural layers/);
	assert.match(prompt, /inspect_workspace verifies UTF-8 text/);
	assert.match(prompt, /edit_workspace requires path, exact oldText, and newText/);
	assert.match(prompt, /argv as an array/);
	assert.match(prompt, /correct the tool or arguments and retry/);
	assert.doesNotMatch(prompt, /create_presentation|create_valuation_workbook|run_backtest reads/);
});

test("explicit delegation exposes a foreground bridge and keeps child capabilities depth-one", async () => {
	const delegatedTask = compileTask({ objective: "Delegate this task to subagents" });
	assert.ok(delegatedTask.requiredCapabilities.includes("subagent-delegation"));
	const delegated = resolveCapabilities(delegatedTask);
	assert.ok(delegated.toolIds.includes("delegate_tasks"));
	assert.equal(delegated.preset.delegationPolicy.level, "L1");
	assert.match(buildStableSystemPrompt(delegated.preset, delegated.toolIds), /delegate_tasks.*nodes/);
	const childCapabilities = resolveCapabilities(delegatedTask, undefined, [], [], { delegationDepth: 1 });
	assert.ok(!childCapabilities.toolIds.includes("delegate_tasks"));
	assert.equal(childCapabilities.preset.delegationPolicy.level, "L0");

	const root = await mkdtemp(join(tmpdir(), "codetonomy-delegation-"));
	const events: Array<{ type: string; data: Record<string, unknown> }> = [];
	const result = await createHarness().run({
		objective: delegatedTask.objective,
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "fixture",
		modelId: "faux-1",
		permissionMode: "auto",
		observers: [(event) => { events.push({ type: event.type, data: event.data }); }],
	});
	assert.equal(result.verification.passed, true);
	assert.equal(events.filter(({ type }) => type === "subagent.requested").length, 2);
	assert.equal(events.filter(({ type }) => type === "subagent.completed").length, 2);
	const capabilityEvents = events.filter(({ type }) => type === "capabilities.resolved");
	assert.ok(capabilityEvents.some(({ data }) => {
		const capabilities = data.capabilities as { toolIds?: unknown } | undefined;
		return Array.isArray(capabilities?.toolIds) && capabilities.toolIds.includes("delegate_tasks");
	}));
	assert.ok(capabilityEvents.some(({ data }) => {
		const capabilities = data.capabilities as { toolIds?: unknown } | undefined;
		return Array.isArray(capabilities?.toolIds) && !capabilities.toolIds.includes("delegate_tasks");
	}));
	await assert.rejects(() => runHarnessOrchestration({
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		delegationDepth: 1,
		parentPermissionProfileId: "workspace-read",
		nodes: [{ id: "nested", objective: "Say no", presetId: "general-assistant", permissionProfileId: "workspace-read" }],
	}), /Recursive delegation is disabled/);
});

test("delegation remains approval-gated for read and write profiles", async () => {
	for (const profile of ["workspace-read", "workspace-write"] as const) {
		const gate = new PermissionGate(getPermissionProfile(profile), async () => true);
		const decision = await gate.check({ toolId: "delegate_tasks", arguments: { nodes: [] }, riskClass: "low" });
		assert.equal(decision.decision, "ASK");
		assert.equal(decision.allowed, true);
	}
	const callback = async () => ({ output: "verified", verificationPassed: true, children: [{ id: "child", status: "completed" as const, output: "bounded" }] });
	const tool = delegateTasksTool(callback);
	const output = await tool.execute("delegation", {
		nodes: [{ id: "child", objective: "Do the bounded task", presetId: "general-assistant", permissionProfileId: "workspace-read" }],
	});
	assert.match(output.content[0]?.text ?? "", /verified/);
	await assert.rejects(
		tool.execute("invalid-preset", {
			nodes: [{ id: "child", objective: "Do the bounded task", presetId: "general" as "general-assistant", permissionProfileId: "workspace-read" }],
		}),
		/Unknown delegation preset.*general-assistant/,
	);
	await assert.rejects(
		delegateTasksTool(async () => ({ output: "", verificationPassed: false, children: [] })).execute("failed-delegation", {
			nodes: [{ id: "child", objective: "Do the bounded task", presetId: "general-assistant", permissionProfileId: "workspace-read" }],
		}),
		/failed verification/,
	);
});

test("skill manifests elevate the preset and fail closed on missing requirements", () => {
	const manifest = {
		id: "writer",
		version: "1.0.0",
		dependencies: [],
		conflicts: [],
		requiredCapabilities: [],
		requiredTools: ["write_workspace"],
		requiredPermissions: ["workspace-write"],
		verifierIds: ["workspace-change"],
	};
	const capabilities = resolveCapabilities(
		compileTask({ objective: "Research the current architecture" }),
		undefined,
		["writer"],
		[manifest],
	);
	assert.equal(capabilities.preset.id, "general-worker");
	assert.ok(capabilities.toolIds.includes("write_workspace"));
	assert.ok(capabilities.verifierIds.includes("workspace-change"));
	assert.throws(
		() => resolveCapabilities(compileTask({ objective: "Explain it" }), undefined, ["bad"], [{
			...manifest,
			id: "bad",
			requiredTools: ["unavailable_tool"],
		}]),
		/Missing tools/,
	);
});

test("workspace intent activates evidence requirements without an explicit @file", () => {
	const task = compileTask({ objective: "Please scan the codebase and summarize the architecture" });
	assert.ok(task.requiredCapabilities.includes("workspace-inspection"));
	assert.ok(task.acceptanceCriteria.some(({ id }) => id === "workspace-evidence"));
});

test("research and review presets require typed provenance artifacts", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-structured-artifact-"));
	const researchTask = compileTask({ objective: "Research the company" });
	assert.equal(resolveCapabilities(researchTask).preset.id, "researcher");
	const recordedResearch = await recordStructuredArtifactTool().execute("research", {
		kind: "research",
		title: "Company research",
		summary: "Revenue increased.",
		claims: [{ statement: "Revenue increased 10%.", source: "Annual report", page: 5, confidence: 0.9 }],
	});
	const researchArtifact = (recordedResearch.details as { artifact: import("../packages/contracts/src/index.ts").RunArtifact }).artifact;
	assert.equal((await verifyArtifacts(researchTask, [researchArtifact], root)).passed, true);
	assert.equal((await verifyArtifacts(researchTask, [], root)).passed, false);

	await createValuationWorkbook(root, {
		company: "Review Co",
		outputPath: "review.xlsx",
		historical: [{ year: 2025, revenue: 1, ebitda: 0.2, freeCashFlow: 0.1 }],
		scenarios: [
			{ name: "Bear", revenueGrowth: 0, ebitdaMargin: 0.1 },
			{ name: "Base", revenueGrowth: 0.05, ebitdaMargin: 0.2 },
			{ name: "Bull", revenueGrowth: 0.1, ebitdaMargin: 0.3 },
		],
		discountRate: 0.1,
		terminalGrowthRate: 0.02,
		sources: [{ label: "Input", source: "fixture" }],
	});
	const reviewTask = compileTask({ objective: "Review and verify this workbook", files: [join(root, "review.xlsx")] });
	const reviewCapabilities = resolveCapabilities(reviewTask);
	assert.equal(reviewCapabilities.preset.id, "artifact-reviewer");
	assert.ok(!reviewCapabilities.toolIds.includes("create_valuation_workbook"));
	const recordedReview = await recordStructuredArtifactTool().execute("review", {
		kind: "review",
		verdict: "pass",
		summary: "No structural defects found.",
		defects: [],
	});
	const reviewArtifact = (recordedReview.details as { artifact: import("../packages/contracts/src/index.ts").RunArtifact }).artifact;
	assert.equal((await verifyArtifacts(reviewTask, [reviewArtifact], root)).passed, true);
});

test("coding intent requests approved writes and verifies an actual mutation", async () => {
	const task = compileTask({ objective: "Implement a new status file" });
	assert.ok(task.requiredCapabilities.includes("workspace-write"));
	assert.equal(task.riskClass, "medium");
	const gate = new PermissionGate(getPermissionProfile("workspace-write"), async () => true);
	assert.equal((await gate.check({ toolId: "write_workspace", arguments: { path: "status.txt" }, riskClass: task.riskClass })).allowed, true);
	const denied = await new PermissionGate(getPermissionProfile("workspace-write")).check({
		toolId: "write_workspace",
		arguments: { path: "status.txt" },
		riskClass: task.riskClass,
	});
	assert.equal(denied.allowed, false);
	assert.equal(denied.decision, "ASK");
	assert.equal(verifyOutput("Implemented the status file.", undefined, {
		task,
		completedToolIds: ["list_workspace", "write_workspace"],
		fileEvidence: [{ target: "status.txt", action: "write", current: true, callId: "write-status" }],
	}).passed, true);
});

test("negated write intent stays read-only while a later affirmative clause still writes", () => {
	for (const objective of [
		"Inspect this project and explain it. Do not modify any files.",
		"Review only and don't fix anything",
		"Analyze the repository without making changes",
	]) {
		const task = compileTask({ objective });
		assert.ok(!task.requiredCapabilities.includes("workspace-write"), objective);
		assert.ok(!task.acceptanceCriteria.some(({ id }) => id === "workspace-change"), objective);
		assert.equal(task.riskClass, "low", objective);
	}
	for (const objective of [
		"Do not modify generated files; fix the parser",
		"Don't edit documentation, but update the tests",
	]) assert.ok(compileTask({ objective }).requiredCapabilities.includes("workspace-write"), objective);
});

test("command intent requires a successful approved native-sandbox run", async () => {
	const task = compileTask({ objective: "Run npm test" });
	assert.ok(task.requiredCapabilities.includes("workspace-command"));
	const gate = new PermissionGate(getPermissionProfile("workspace-write"), async () => true);
	assert.equal((await gate.check({ toolId: "run_workspace_command", arguments: { argv: ["npm", "test"] }, riskClass: task.riskClass })).allowed, true);
	assert.equal(verifyOutput("Tests passed.", undefined, {
		task,
		completedToolIds: ["list_workspace", "run_workspace_command"],
		commandExitCodes: [0],
		commandRuns: [{ argv: ["npm", "test"], exitCode: 0 }],
	}).passed, true);
	assert.equal(verifyOutput("Tests passed.", undefined, {
		task,
		completedToolIds: ["list_workspace", "run_workspace_command"],
		commandExitCodes: [1],
	}).passed, false);
});

test("command intent recognizes explicit package-manager and test invocations", () => {
	for (const objective of ["run npm test", "npm test", "npm run lint", "pnpm test", "yarn run build", "cargo test", "pytest", "python -m pytest"]) {
		assert.ok(compileTask({ objective }).requiredCapabilities.includes("workspace-command"), objective);
	}
	assert.ok(!compileTask({ objective: "Run the analysis" }).requiredCapabilities.includes("workspace-command"));
	const task = compileTask({ objective: "run npm test" });
	assert.equal(verifyOutput("npm test completed.", undefined, { task, commandExitCodes: [] }).passed, false);
	const wrongCommand = verifyOutput("npm test completed.", undefined, { task, commandExitCodes: [0], commandRuns: [{ argv: ["echo", "ok"], exitCode: 0 }] });
	assert.equal(wrongCommand.checks.find(({ id }) => id === "command-success")?.passed, false);
	const requestedCommand = verifyOutput("npm test completed.", undefined, { task, commandExitCodes: [0], commandRuns: [{ argv: ["npm", "run", "test"], exitCode: 0 }] });
	assert.equal(requestedCommand.checks.find(({ id }) => id === "command-success")?.passed, true);
});

test("aggregate token ceilings fail closed after provider usage crosses the limit", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-spend-budget-"));
	await assert.rejects(() => createHarness().run({ objective: "Say hello", workspaceRoot: root, provider: "fixture", modelId: "faux-1", maxTotalTokens: 0 }), /maxTotalTokens/);
	const result = await createHarness().run({
		objective: "Return a concise success response",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "fixture",
		modelId: "faux-1",
		maxTotalTokens: 1,
	});
	assert.ok(result.usage.totalTokens > 1);
	assert.equal(result.verification.passed, false);
	assert.match(result.verification.checks.map(({ message }) => message).join("\n"), /Aggregate token ceiling exceeded/);
});

test("activated skills stay in the turn tail and fingerprint the run", async () => {
	const root = await mkdtemp(join(tmpdir(), "agent-harness-skill-"));
	const first = await createHarness().run({
		objective: "Apply the selected approach",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		activatedSkills: [{ id: "app-builder", instructions: "First skill revision" }],
	});
	const second = await createHarness().run({
		objective: "Apply the selected approach",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		activatedSkills: [{ id: "app-builder", instructions: "Second skill revision" }],
	});
	assert.equal(first.capabilities.cachePrefixHash, second.capabilities.cachePrefixHash);
	assert.notEqual(first.capabilities.runProfileHash, second.capabilities.runProfileHash);
	assert.deepEqual(first.capabilities.skillIds, ["app-builder"]);
	assert.match(first.output, /Activated skills: app-builder/);
	const trace = await readFile(first.tracePath, "utf8");
	assert.match(trace, /"activatedSkills":\[\{"id":"app-builder","contentHash":"[0-9a-f]{64}"\}\]/);
	assert.doesNotMatch(trace, /First skill revision/);
});

test("conversation history preserves the cache lane and fingerprints the run", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-conversation-"));
	const withoutHistory = await createHarness().run({
		objective: "Answer the follow-up",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
	});
	const withHistory = await createHarness().run({
		objective: "Answer the follow-up",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		sessionId: "session-1",
		conversation: [{ runId: "prior", objective: "What is this?", output: "A project.", timestamp: 1 }],
	});
	assert.equal(withoutHistory.capabilities.cachePrefixHash, withHistory.capabilities.cachePrefixHash);
	assert.notEqual(withoutHistory.capabilities.runProfileHash, withHistory.capabilities.runProfileHash);
	assert.match(await readFile(withHistory.tracePath, "utf8"), /"conversationTurns":1/);
});

test("Document IR uses native structure first and revisioned OCR fallback with cache", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-document-ir-"));
	await writeFile(join(root, "table.csv"), 'name,value\n"polar,bear",42\n', "utf8");
	const csv = await parseDocument(root, "table.csv");
	assert.equal(csv.pages[0]?.blocks[0]?.type, "table");
	assert.deepEqual((csv.pages[0]?.blocks[0]?.structuredData as { rows: string[][] }).rows[1], ["polar,bear", "42"]);
	assert.equal(csv.pages[0]?.blocks[0]?.provenance?.pageNumber, 1);
	const nativeCache = join(root, "native-cache");
	await parseDocument(root, "table.csv", { cacheDirectory: nativeCache });
	if (process.platform !== "win32") assert.equal((await stat(nativeCache)).mode & 0o077, 0);
	const externalNativeRoot = await mkdtemp(join(tmpdir(), "codetonomy-native-cache-outside-"));
	await rename(nativeCache, join(externalNativeRoot, "cache"));
	const nativeCacheLink = join(root, "native-cache-link");
	await symlink(externalNativeRoot, nativeCacheLink, process.platform === "win32" ? "junction" : "dir");
	await assert.rejects(() => parseDocument(root, "table.csv", { cacheDirectory: join(nativeCacheLink, "cache") }), /non-symlink/);
	await assert.rejects(() => parseDocument(root, "table.csv", { cacheDirectory: join(nativeCacheLink, "new-cache") }), /non-symlink/);
	await assert.rejects(() => stat(join(externalNativeRoot, "new-cache")), (error: NodeJS.ErrnoException) => error.code === "ENOENT");

	const cacheDirectory = join(root, "ocr-cache");
	await writeFile(join(root, "scan.pdf"), "%PDF-fixture", "utf8");
	let fetches = 0;
	let uploadedDigest = "";
	const ocrDocument = {
		documentId: "ocr-doc",
		assetVersionId: "version-1",
		parser: { id: "unlimited-ocr", version: "1", configurationHash: "config" },
		pages: [{ pageNumber: 1, width: 100, height: 200, blocks: [{
			blockId: "block-1", type: "paragraph" as const, readingOrder: 0, text: "Scanned revenue was 42.", confidence: 0.96,
			boundingBox: [0, 0, 100, 20] as [number, number, number, number],
		}] }],
	};
	const ocr = new OcrHttpService({
		endpoint: "http://127.0.0.1:10000/",
		cacheDirectory,
		cacheRoot: root,
		apiKey: "s".repeat(32),
		fetch: (async (input, init) => {
			fetches++;
			const url = String(input);
			if (init?.method === "PUT") {
				assert.match(url, /\/v1\/assets\/[a-f0-9]{64}$/);
				assert.equal(init.headers && new Headers(init.headers).get("content-type"), "application/pdf");
				uploadedDigest = url.split("/").at(-1)!;
				return Response.json({ created: true }, { status: 201 });
			}
			const wire = JSON.parse(String(init?.body)) as { asset?: { sha256?: string; mediaType?: string }; assetPath?: string };
			assert.equal(wire.assetPath, undefined);
			assert.deepEqual(wire.asset, { sha256: uploadedDigest, mediaType: "application/pdf" });
			return Response.json(ocrDocument);
		}) as typeof fetch,
	});
	const request = {
		requestId: "request-1",
		idempotencyKey: "a".repeat(64),
		assetPath: join(root, "scan.pdf"),
		pageNumber: 1,
		imageMode: "base" as const,
		settings: { maxContextTokens: 32_768, noRepeat: { ngramSize: 35, windowSize: 128 } },
		modelRevision: "model-sha",
		parserCodeRevision: "code-sha",
	};
	assert.equal((await ocr.parse(request)).pages[0]?.blocks[0]?.text, "Scanned revenue was 42.");
	assert.equal((await ocr.parse(request)).pages[0]?.blocks[0]?.text, "Scanned revenue was 42.");
	assert.equal(fetches, 2);
	let recoveryFetches = 0;
	const recoveringOcr = new OcrHttpService({
		endpoint: "http://127.0.0.1:10000/",
		apiKey: "s".repeat(32),
		fetch: (async (_input, init) => {
			recoveryFetches++;
			if (init?.method === "PUT") return Response.json({ created: true }, { status: 201 });
			return recoveryFetches === 3 ? Response.json({ error: "missing" }, { status: 404 }) : Response.json(ocrDocument);
		}) as typeof fetch,
	});
	await recoveringOcr.parse({ ...request, idempotencyKey: "d".repeat(64) });
	await recoveringOcr.parse({ ...request, idempotencyKey: "e".repeat(64) });
	assert.equal(recoveryFetches, 5);
	if (process.platform !== "win32") assert.equal((await stat(cacheDirectory)).mode & 0o077, 0);
	const cacheTarget = join(root, "cache-target");
	const linkedCache = join(root, "linked-cache");
	await mkdir(cacheTarget);
	await writeFile(join(cacheTarget, `${"b".repeat(64)}.json`), JSON.stringify({ ...ocrDocument, documentId: "outside-cache" }), "utf8");
	await symlink(cacheTarget, linkedCache, process.platform === "win32" ? "junction" : "dir");
	const symlinkedOcr = new OcrHttpService({ endpoint: "http://127.0.0.1:10000/", cacheDirectory: linkedCache, cacheRoot: root, apiKey: "s".repeat(32), fetch: (async () => Response.json(ocrDocument)) as typeof fetch });
	await assert.rejects(() => symlinkedOcr.parse({ ...request, idempotencyKey: "b".repeat(64) }), /non-symlink/);
	const nestedOutside = await mkdtemp(join(tmpdir(), "codetonomy-ocr-outside-"));
	await mkdir(join(nestedOutside, "cache"));
	await writeFile(join(nestedOutside, "cache", `${"c".repeat(64)}.json`), JSON.stringify({ ...ocrDocument, documentId: "nested-outside-cache" }), "utf8");
	const nestedLink = join(root, "nested-cache-link");
	await symlink(nestedOutside, nestedLink, process.platform === "win32" ? "junction" : "dir");
	const nestedSymlinkedOcr = new OcrHttpService({ endpoint: "http://127.0.0.1:10000/", cacheDirectory: join(nestedLink, "cache"), cacheRoot: root, apiKey: "s".repeat(32), fetch: (async () => Response.json(ocrDocument)) as typeof fetch });
	await assert.rejects(() => nestedSymlinkedOcr.parse({ ...request, idempotencyKey: "c".repeat(64) }), /non-symlink/);
	const healthy = new OcrHttpService({ endpoint: "http://127.0.0.1:10000/", apiKey: "s".repeat(32), fetch: (async () => Response.json({ status: "ok", modelRevision: "model-sha", parserCodeRevision: "code-sha" })) as typeof fetch });
	await healthy.health("model-sha", "code-sha");
	await assert.rejects(() => healthy.health("other-model", "code-sha"), /unexpected revisions/);
	await assert.rejects(() => ocr.parse({ ...request, idempotencyKey: "../outside" }), /identities/);
	assert.throws(() => new OcrHttpService({ endpoint: "http://user:secret@127.0.0.1:10000", apiKey: "s".repeat(32) }), /cannot contain credentials/);

	for (const [name, body] of [
		["pdfinfo.mjs", "process.stdout.write('Pages: 1\\n');\n"],
		["pdftotext.mjs", "process.stdout.write('   ');\n"],
	] as const) {
		await writeFile(join(root, name), body, "utf8");
	}
	ocrDocument.pages[0]!.blocks[0]!.confidence = 0.2;
	const scanned = await parseDocument(root, "scan.pdf", {
		ocr,
		ocrModelRevision: "model-sha",
		ocrCodeRevision: "code-sha",
		pdfinfoBinary: [process.execPath, join(root, "pdfinfo.mjs")],
		pdftotextBinary: [process.execPath, join(root, "pdftotext.mjs")],
	});
	assert.equal(scanned.pages[0]?.blocks[0]?.text, "Scanned revenue was 42.");
	assert.match(scanned.failures?.[0]?.message ?? "", /manual review/);
});

test("local graph memory preserves asset identity, versions, permissions, and graph-constrained RAG", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-memory-"));
	await writeFile(join(root, "company.txt"), "aurora_metric revenue grew strongly", "utf8");
	await writeFile(join(root, "other.txt"), "aurora_metric unrelated confidential fact", "utf8");
	const memory = new LocalGraphMemory({ databasePath: join(root, ".memory", "memory.db"), workspaceRoot: root, projectId: "project-1" });
	try {
		const first = await memory.ingestFile("company.txt");
		const other = await memory.ingestFile("other.txt");
		await rename(join(root, "company.txt"), join(root, "renamed.txt"));
		const renamed = await memory.ingestFile("renamed.txt");
		assert.equal(renamed.assetId, first.assetId);
		assert.equal(renamed.versionId, first.versionId);
		await writeFile(join(root, "renamed.txt"), "nebula_metric revenue declined", "utf8");
		const updated = await memory.ingestFile("renamed.txt");
		assert.notEqual(updated.versionId, first.versionId);
		const versions = memory.getVersions(first.assetId);
		assert.equal(versions.length, 2);
		assert.deepEqual(versions.map(({ current }) => current), [false, true]);
		assert.equal(memory.retrieve("aurora_metric", { assetIds: [first.assetId] }).length, 0);
		assert.equal(memory.retrieve("aurora_metric", { assetIds: [first.assetId], includeOldVersions: true })[0]?.versionId, first.versionId);
		const permitted = memory.retrieve("aurora_metric", { assetIds: [other.assetId] });
		assert.ok(permitted.length > 0 && permitted.every(({ assetId }) => assetId === other.assetId));
		assert.equal(memory.retrieve("aurora_metric", { assetIds: [] }).length, 0);
		memory.addEdge({
			fromId: first.assetId,
			toId: other.assetId,
			type: "RELATED_TO",
			confidence: 0.9,
			evidenceIds: [permitted[0]!.chunkId],
			extractorModel: "fixture",
			extractorVersion: "1",
			reviewStatus: "unreviewed",
		});
		assert.ok(memory.graphNeighbours([first.assetId], 1).some(({ toId }) => toId === other.assetId));
		const constrained = memory.retrieve("aurora_metric", { graphSeedIds: [first.assetId] });
		assert.ok(constrained.some(({ assetId }) => assetId === other.assetId));
		const packet = await memory.recall("nebula_metric", 100);
		assert.ok(packet.evidence.length > 0);
		assert.ok(packet.provenance.every((item) => (item as { versionId?: string }).versionId));
	} finally {
		memory.close();
	}
});

test("graph-constrained retrieval improves precision on a labeled corpus", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-rag-quality-"));
	await writeFile(join(root, "relevant.txt"), "sharedneedle approved valuation evidence", "utf8");
	for (let index = 0; index < 5; index++) await writeFile(join(root, `distractor-${index}.txt`), `sharedneedle unrelated distractor ${index}`, "utf8");
	const memory = new LocalGraphMemory({ databasePath: join(root, "memory.sqlite"), workspaceRoot: root, projectId: "rag-quality" });
	try {
		const relevant = await memory.ingestFile("relevant.txt");
		for (let index = 0; index < 5; index++) await memory.ingestFile(`distractor-${index}.txt`);
		const plain = memory.retrieve("sharedneedle", { maximumResults: 10 });
		const constrained = memory.retrieve("sharedneedle", { graphSeedIds: [relevant.assetId], maximumResults: 10 });
		const precision = (rows: typeof plain) => rows.filter(({ assetId }) => assetId === relevant.assetId).length / rows.length;
		assert.ok(precision(constrained) > precision(plain));
		assert.equal(precision(constrained), 1);
	} finally { memory.close(); }
});

test("workspace indexing skips images without OCR and reuses unchanged file metadata", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-memory-incremental-"));
	const databasePath = join(root, "memory.sqlite");
	await writeFile(join(root, "picture.png"), Buffer.from([0, 1, 2, 3]));
	await writeFile(join(root, "notes.txt"), "incremental memory evidence", "utf8");
	const memory = new LocalGraphMemory({ databasePath, workspaceRoot: root, projectId: "incremental" });
	try {
		const first = await memory.ingestWorkspace();
		const database = new DatabaseSync(databasePath);
		try { database.prepare("UPDATE asset_locations SET last_seen=1 WHERE path='notes.txt'").run(); }
		finally { database.close(); }
		const second = await memory.ingestWorkspace();
		assert.deepEqual(first.map(({ path }) => path), ["notes.txt"]);
		assert.deepEqual(second.map(({ versionId, path }) => ({ versionId, path })), first.map(({ versionId, path }) => ({ versionId, path })));
		assert.equal(memory.getVersions(first[0]!.assetId).length, 1);
		const inspection = new DatabaseSync(databasePath, { readOnly: true });
		try {
			assert.equal((inspection.prepare("SELECT last_seen lastSeen FROM asset_locations WHERE path='notes.txt'").get() as { lastSeen: number }).lastSeen, 1);
			assert.equal((inspection.prepare("SELECT COUNT(*) count FROM asset_locations WHERE path='picture.png'").get() as { count: number }).count, 0);
		} finally { inspection.close(); }
		await writeFile(join(root, "notes.txt"), Buffer.from([0xff, 0xfe, 0xfd]));
		const skipped: string[] = [];
		assert.deepEqual(await memory.ingestWorkspace(undefined, ({ path, skipped: failed }) => { if (failed) skipped.push(path); }), []);
		assert.deepEqual(skipped, ["notes.txt"]);
		assert.equal(memory.retrieve("incremental").length, 0);
		await writeFile(join(root, "notes.txt"), "replacement memory evidence", "utf8");
		const replacement = await memory.ingestWorkspace();
		assert.equal(replacement.length, 1);
		assert.equal(memory.retrieve("replacement")[0]?.path, "notes.txt");
	} finally { memory.close(); }
});

test("local retrieval considers chunks beyond the former ten-thousand-row window", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-memory-window-"));
	const databasePath = join(root, "memory.sqlite");
	await writeFile(join(root, "seed.txt"), "seed", "utf8");
	const initial = new LocalGraphMemory({ databasePath, workspaceRoot: root, projectId: "window" });
	const seed = await initial.ingestFile("seed.txt");
	initial.close();
	const database = new DatabaseSync(databasePath);
	try {
		const insertChunk = database.prepare("INSERT INTO chunks(id,version_id,asset_id,page_number,block_id,content,structural_context,token_estimate,vector) VALUES(?,?,?,?,?,?,?,?,?)");
		const insertFts = database.prepare("INSERT INTO chunks_fts(chunk_id,content) VALUES(?,?)");
		const zeroVector = JSON.stringify(Array(256).fill(0));
		database.exec("BEGIN IMMEDIATE");
		for (let index = 0; index < 10_000; index++) {
			const chunkId = `chunk_${String(index).padStart(5, "0")}`;
			insertChunk.run(chunkId, seed.versionId, seed.assetId, 1, chunkId, "distractor", "", 1, zeroVector);
			insertFts.run(chunkId, "distractor");
		}
		insertChunk.run("chunk_zz-target", seed.versionId, seed.assetId, 1, "target", "needle beyond ten thousand", "", 4, zeroVector);
		insertFts.run("chunk_zz-target", "needle beyond ten thousand");
		database.exec("COMMIT");
	} finally { database.close(); }
	const memory = new LocalGraphMemory({ databasePath, workspaceRoot: root, projectId: "window" });
	try {
		assert.equal(memory.retrieve("needle", { maximumResults: 1 })[0]?.chunkId, "chunk_zz-target");
	} finally { memory.close(); }
});

test("Tencent memory adapter keeps strict isolation IDs at the HTTP boundary", async () => {
	const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
	const adapter = new TencentMemoryAdapter({
		endpoint: "http://127.0.0.1:8420/",
		apiKey: "secret",
		serviceId: "service-1",
		teamId: "team-1",
		agentId: "agent-1",
		userId: "user-1",
		sessionId: "session-1",
		fetch: (async (input, init) => {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			requests.push({ url: String(input), headers: new Headers(init?.headers), body });
			if (String(input).endsWith("/v3/conversation/add") && (body.messages as Array<{ content: string }>).some(({ content }) => content.length > 8_192)) {
				return Response.json({ code: 400, message: "messages content exceeds 8192 characters" }, { status: 400 });
			}
			return Response.json({ code: 0, data: { items: [{ fact: "remembered" }] } });
		}) as typeof fetch,
	});
	const packet = await adapter.recall("query", 100);
	assert.equal(packet.memories.length, 1);
	assert.equal(requests[0]?.headers.get("authorization"), "Bearer secret");
	assert.equal(requests[0]?.headers.get("x-tdai-service-id"), "service-1");
	assert.deepEqual({ team: requests[0]?.body.team_id, agent: requests[0]?.body.agent_id, user: requests[0]?.body.user_id, session: requests[0]?.body.session_id }, {
		team: "team-1", agent: "agent-1", user: "user-1", session: undefined,
	});
	assert.ok(requests.some(({ url }) => url.endsWith("/v3/atomic/search")));
	assert.ok(requests.some(({ url }) => url.endsWith("/v3/conversation/search")));
	await adapter.capture({ runId: "run-1", task: { objective: "remember this" }, output: "remembered" } as never);
	assert.equal(requests.at(-1)?.body.session_id, "session-1");
	assert.ok(requests.at(-1)?.url.endsWith("/v3/conversation/add"));
	const additionsBefore = requests.filter(({ url }) => url.endsWith("/v3/conversation/add")).length;
	const marked: string[] = [];
	await adapter.addWorkspaceChunks(Array.from({ length: 501 }, (_, index) => ({
		chunkId: `chunk-${index}`, assetId: "asset", versionId: "version", path: "source.ts", pageNumber: 1,
		blockId: String(index), content: `content ${index}`, score: 0, contentHash: "hash",
	})), "project", undefined, (chunkIds) => { marked.push(...chunkIds); });
	const bundleRequests = requests.filter(({ url }) => url.endsWith("/v3/conversation/add")).slice(additionsBefore);
	assert.ok(bundleRequests.length > 0 && bundleRequests.length < 501);
	assert.ok(bundleRequests.every(({ body }) => Array.isArray(body.messages) && body.messages.length <= 100));
	assert.ok(bundleRequests.flatMap(({ body }) => body.messages as Array<{ content: string }>).every(({ content }) => content.length <= 8_192));
	assert.ok(bundleRequests.flatMap(({ body }) => body.messages as Array<{ content: string }>).every(({ content }) => content.startsWith("CODETONOMY_WORKSPACE_ROUTING_CARD ")));
	assert.equal(marked.length, 501);
});

test("Tencent workspace routing cards stay compact and never upload a source body", async () => {
	const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
	const adapter = new TencentMemoryAdapter({
		endpoint: "http://127.0.0.1:8420/", apiKey: "secret", serviceId: "service", teamId: "team", agentId: "agent", userId: "user", sessionId: "session",
		fetch: (async (input, init) => {
			requests.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
			return Response.json({ code: 0, data: { items: [] } });
		}) as typeof fetch,
	});
	const source = `SOURCE_BODY_SHOULD_STAY_LOCAL ${'"quoted unicode 漢字 '.repeat(4_000)}`;
	const marked: string[] = [];
	await adapter.addWorkspaceChunks([{
		chunkId: "chunk-large-routing-card", assetId: "asset", versionId: "version", path: "data_cache/sectors.json", pageNumber: 7, blockId: "block-quoted",
		content: source, score: 0, contentHash: "hash", structure: { symbol: "sectors", kind: "object", architecturalLayer: "workspace routing" },
	}], "project", undefined, (ids) => { marked.push(...ids); });
	const messages = requests.filter(({ url }) => url.endsWith("/v3/conversation/add")).flatMap(({ body }) => body.messages as Array<{ content: string }>);
	assert.equal(messages.length, 1);
	assert.ok(Buffer.byteLength(messages[0]?.content ?? "") < 7_000);
	assert.ok(messages[0]?.content.startsWith("CODETONOMY_WORKSPACE_ROUTING_CARD "));
	assert.equal(messages[0]?.content.includes(source), false);
	const parsed = JSON.parse(messages[0]?.content.slice("CODETONOMY_WORKSPACE_ROUTING_CARD ".length) ?? "") as Array<Record<string, unknown>>;
	const record = parsed[0] ?? {};
	assert.equal("content" in record, false);
	assert.equal(record.chunkId, "chunk-large-routing-card");
	assert.deepEqual(record.path, "data_cache/sectors.json");
	assert.deepEqual(record.pageNumber, 7);
	assert.deepEqual(marked, ["chunk-large-routing-card"]);
});

test("hybrid memory indexes safe workspace text and uses Tencent retrieval with local provenance", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-hybrid-memory-"));
	await writeFile(join(root, "feature.ts"), "export const celestialNeedle = 'indexed';", "utf8");
	await writeFile(join(root, "adapter.ts"), "export class TencentMemoryAdapter {\n\n// architectural-layer: adapter input validation; owner: TencentMemoryAdapter.recall\nasync recall(query: string, tokenBudget: number) { if (tokenBudget < 1 || tokenBudget > 1_000_000) throw new Error('invalid'); }\n}\n", "utf8");
	await writeFile(join(root, "workspace.ts"), "export class HybridGraphMemory {\n\n// architectural-layer: workspace caller token-budget policy; owner: HybridGraphMemory.searchWorkspace\nasync searchWorkspace(query: string) { return this.remote.recall(query, Math.min(100_000, Math.max(1_000, 3_000))); }\n}\n", "utf8");
	await writeFile(join(root, ".env"), "CELESTIAL_SECRET=never-index", "utf8");
	const stored: unknown[] = [];
	const remote = new TencentMemoryAdapter({
		endpoint: "http://127.0.0.1:8420/", apiKey: "secret", serviceId: "project", teamId: "project", agentId: "agent", userId: "user", sessionId: "session",
		fetch: (async (input, init) => {
			const url = String(input);
			if (url.endsWith("/health")) return new Response("ok");
			const body = JSON.parse(String(init?.body)) as { messages?: unknown[] };
			if (url.endsWith("/v3/conversation/add")) stored.push(...(body.messages ?? []));
			const data = url.endsWith("/v3/conversation/search") ? { messages: stored } : { items: [] };
			return Response.json({ code: 0, data });
		}) as typeof fetch,
	});
	const local = new LocalGraphMemory({ databasePath: join(root, ".memory", "index.sqlite"), workspaceRoot: root, projectId: "project" });
	const memory = new HybridGraphMemory({ local, remote, projectId: "project" });
	try {
		const indexed = await memory.indexWorkspace();
		assert.ok(indexed.files >= 1);
		const hits = await memory.searchWorkspace("celestialNeedle", { path: "." });
		assert.equal(hits[0]?.path, "feature.ts");
		assert.ok(hits[0]?.versionId && hits[0]?.contentHash);
		const workspaceHits = await memory.searchWorkspace("Find TencentDB workspace recall token budget");
		assert.equal(workspaceHits[0]?.path, "workspace.ts");
		assert.equal(workspaceHits[0]?.structure?.owner, "HybridGraphMemory.searchWorkspace");
		assert.equal(workspaceHits[0]?.structure?.architecturalLayer, "workspace caller token-budget policy");
		assert.equal(stored.some((item) => JSON.stringify(item).includes("CELESTIAL_SECRET")), false);
		await unlink(join(root, "feature.ts"));
		await memory.indexWorkspace();
		assert.ok((await memory.searchWorkspace("celestialNeedle")).every(({ path }) => path !== "feature.ts"));
	} finally { memory.close(); }
});

test("hybrid workspace search fuses remote routing hits with exact local-only FTS hits", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-hybrid-fusion-"));
	await writeFile(join(root, "remote.ts"), "export const remoteRoutingNeedle = true;", "utf8");
	await writeFile(join(root, "local.ts"), "export const exactLocalOnlyNeedle = true;", "utf8");
	const stored: Array<{ role: string; content: string }> = [];
	const remote = new TencentMemoryAdapter({
		endpoint: "http://127.0.0.1:8420/", apiKey: "secret", serviceId: "project", teamId: "project", agentId: "agent", userId: "user", sessionId: "session",
		fetch: (async (input, init) => {
			const url = String(input);
			if (url.endsWith("/health")) return new Response("ok");
			const body = JSON.parse(String(init?.body)) as { messages?: Array<{ role: string; content: string }> };
			if (url.endsWith("/v3/conversation/add")) stored.push(...(body.messages ?? []));
			return Response.json({ code: 0, data: url.endsWith("/v3/conversation/search") ? { messages: stored.slice(0, 1).map((content) => ({ ...content, score: 1 })) } : { items: [] } });
		}) as typeof fetch,
	});
	const local = new LocalGraphMemory({ databasePath: join(root, ".memory", "index.sqlite"), workspaceRoot: root, projectId: "project" });
	const memory = new HybridGraphMemory({ local, remote, projectId: "project" });
	try {
		await memory.indexWorkspace();
		const hits = await memory.searchWorkspace("exactLocalOnlyNeedle", { limit: 12 });
		assert.ok(hits.some(({ path, content }) => path === "local.ts" && content.includes("exactLocalOnlyNeedle")));
		assert.ok(hits.every(({ content }) => !content.includes("CODETONOMY_WORKSPACE_ROUTING_CARD")));
	} finally { memory.close(); }
});

test("workspace retrieval applies path scope before ranking and normalizes nested paths", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-memory-scope-"));
	await mkdir(join(root, "scope"));
	await writeFile(join(root, "outside.ts"), "export const sharedScopedNeedle = 'outside';", "utf8");
	await writeFile(join(root, "scope", "target.ts"), "export const sharedScopedNeedle = 'inside';", "utf8");
	const remote = new TencentMemoryAdapter({
		endpoint: "http://127.0.0.1:8420/", apiKey: "secret", serviceId: "project", teamId: "project", agentId: "agent", userId: "user", sessionId: "session",
		fetch: (async (input) => String(input).endsWith("/health")
			? new Response("ok")
			: Response.json({ code: 0, data: String(input).endsWith("/v3/conversation/search") ? { messages: [] } : { items: [] } })) as typeof fetch,
	});
	const local = new LocalGraphMemory({ databasePath: join(root, ".memory", "index.sqlite"), workspaceRoot: root, projectId: "project" });
	const memory = new HybridGraphMemory({ local, remote, projectId: "project" });
	try {
		await memory.indexWorkspace();
		const localHits = local.retrieve("sharedScopedNeedle", { path: "scope", maximumResults: 100 });
		assert.ok(localHits.length > 0);
		assert.ok(localHits.every(({ path }) => path === "scope/target.ts"));
		const directoryHits = await memory.searchWorkspace("sharedScopedNeedle", { path: "scope" });
		assert.ok(directoryHits.length > 0);
		assert.ok(directoryHits.every(({ path }) => path === "scope/target.ts"));
		const fileHits = await memory.searchWorkspace("sharedScopedNeedle", { path: "scope/target.ts" });
		assert.ok(fileHits.length > 0);
		assert.ok(fileHits.every(({ path }) => path === "scope/target.ts"));
		const tool = searchWorkspaceTool(root, { search: async () => [
			{ path: "outside.ts", content: "export const sharedScopedNeedle = 'outside';" },
			{ path: "scope/target.ts", content: "export const sharedScopedNeedle = 'inside';" },
		] });
		const scoped = await tool.execute("scoped", { query: "sharedScopedNeedle", path: "scope" });
		const output = scoped.content[0]?.type === "text" ? scoped.content[0].text : "";
		assert.match(output, /scope\/target\.ts/);
		assert.doesNotMatch(output, /outside\.ts/);
	} finally { memory.close(); }
});

test("memory backends reject cross-project graph edges and bound stalled HTTP calls", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-memory-isolation-"));
	await writeFile(join(root, "shared.txt"), "isolated evidence", "utf8");
	const databasePath = join(root, ".memory", "memory.db");
	const first = new LocalGraphMemory({ databasePath, workspaceRoot: root, projectId: "project-a" });
	const second = new LocalGraphMemory({ databasePath, workspaceRoot: root, projectId: "project-b" });
	try {
		const left = await first.ingestFile("shared.txt");
		const right = await second.ingestFile("shared.txt");
		assert.notEqual(left.assetId, right.assetId);
		assert.throws(() => first.addEdge({ fromId: left.assetId, toId: right.assetId, type: "RELATED_TO", confidence: 0.9, evidenceIds: [left.versionId], extractorModel: "fixture", extractorVersion: "1", reviewStatus: "unreviewed" }), /project boundary/);
		assert.deepEqual(first.graphNeighbours([right.assetId]), []);
	} finally {
		first.close();
		second.close();
	}
	const stalled = new TencentMemoryAdapter({
		endpoint: "http://127.0.0.1:8420/",
		apiKey: "secret",
		serviceId: "service-1",
		teamId: "team-1",
		agentId: "agent-1",
		userId: "user-1",
		sessionId: "session-1",
		timeoutMs: 100,
		fetch: ((_input, init) => new Promise<Response>((resolve, reject) => {
			const fallback = setTimeout(() => resolve(Response.json({ code: 0, data: { items: [] } })), 1_000);
			init?.signal?.addEventListener("abort", () => { clearTimeout(fallback); reject(init.signal?.reason); }, { once: true });
		})) as typeof fetch,
	});
	await assert.rejects(() => stalled.recall("query", 100), /timeout|abort/i);
});

test("runtime injects bounded memory in the turn tail and captures completed runs", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-runtime-memory-"));
	let capturedRunId: string | undefined;
	const memory = {
		async recall(_query: string, tokenBudget: number) {
			return {
				taskId: "memory",
				agentPresetId: "general-worker",
				structuralContext: [{ type: "RELATED_TO", fromId: "asset-1", toId: "asset-2" }],
				evidence: [{ chunkId: "chunk-1", content: "MEMORY_ONLY_FACT", versionId: "version-1", path: "source.txt", pageNumber: 1 }],
				memories: [],
				sourceVersions: ["version-1"],
				provenance: [{ chunkId: "chunk-1", versionId: "version-1", path: "source.txt", pageNumber: 1 }],
				tokenBudget,
				estimatedTokens: 20,
				contextHash: "memory-context-hash",
			};
		},
		async capture(run: import("../packages/contracts/src/index.ts").RunResult) { capturedRunId = run.runId; },
	};
	let requestBody: Record<string, unknown> | undefined;
	const providerFetch: typeof fetch = async (_input, init) => {
		requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
		const base = { id: "memory-response", object: "chat.completion.chunk", created: 1, model: "memory-model" };
		const events = [
			{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "The remembered fact is available." }, finish_reason: null }] },
			{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
		];
		return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	const withoutMemory = resolveCapabilities(compileTask({ objective: "Answer the question" }), { providerId: "memory-provider", modelId: "memory-model" });
	const result = await createHarness().run({
		objective: "Answer the question",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "memory-provider",
		modelId: "memory-model",
		providerConfiguration: { id: "memory-provider", name: "Memory Provider", kind: "openai-compatible", baseUrl: "https://provider.test/v1", apiKey: "test-key" },
		providerFetch,
		memoryBackend: memory,
		contextTokenBudget: 100,
	});
	assert.equal(result.capabilities.cachePrefixHash, withoutMemory.cachePrefixHash);
	assert.equal(capturedRunId, result.runId);
	assert.doesNotMatch(String(requestBody?.messages ? JSON.stringify((requestBody.messages as unknown[])[0]) : ""), /MEMORY_ONLY_FACT/);
	assert.match(JSON.stringify(requestBody?.messages), /MEMORY_ONLY_FACT/);
	const trace = await readFile(result.tracePath, "utf8");
	assert.match(trace, /"type":"memory.recall.completed"/);
	assert.match(trace, /"type":"memory.capture.completed"/);
});

test("conversation projection keeps a bounded recent tail without changing canonical history", () => {
	const turns = Array.from({ length: 5 }, (_, index) => ({
		runId: `run-${index}`,
		objective: `Question ${index}`,
		output: "x".repeat(100),
		timestamp: index,
	}));
	const projection = projectConversation(turns, 500, 3);
	assert.deepEqual(projection.turns.map(({ runId }) => runId), ["run-3", "run-4"]);
	assert.equal(projection.omittedTurns, 3);
	assert.equal(turns.length, 5);
	assert.match(projection.projectionHash, /^[0-9a-f]{64}$/);
});

test("session cache diagnostics distinguish cold and warm stable prefixes", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-cache-shape-"));
	const run = () => createHarness().run({
		objective: "Answer this",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		sessionId: "stable-session",
	});
	const first = await run();
	const second = await run();
	assert.match(await readFile(first.tracePath, "utf8"), /"status":"cold"/);
	assert.match(await readFile(second.tracePath, "utf8"), /"status":"warm"/);
	if (process.platform !== "win32") {
		assert.equal((await stat(first.tracePath)).mode & 0o077, 0);
		assert.equal((await stat(join(first.tracePath, "..", "result.json"))).mode & 0o077, 0);
	}
	const changed = await createHarness().run({
		objective: "Research this topic",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		sessionId: "stable-session",
	});
	const changedTrace = await readFile(changed.tracePath, "utf8");
	assert.match(changedTrace, /"type":"cache.invalidated"/);
	assert.match(changedTrace, /"changed":\["stable-prefix"\]/);
});

test("fixture runtime executes a permission-gated tool and writes a complete trace", async () => {
	const root = await mkdtemp(join(tmpdir(), "agent-harness-"));
	const traceDirectory = join(root, "runs");
	await writeFile(join(root, "evidence.txt"), "revenue grew 12%", "utf8");
	await writeFile(join(root, "context.txt"), "costs fell 4%", "utf8");
	const streamed: string[] = [];
	const result = await createHarness().run({
		objective: "Summarize the evidence",
		files: [join(root, "evidence.txt"), join(root, "context.txt")],
		workspaceRoot: root,
		traceDirectory,
		observers: [() => { throw new Error("passive observer failure"); }],
		onStream: ({ text }) => streamed.push(text),
	});

	assert.equal(result.verification.passed, true);
	assert.match(result.output, /revenue grew 12%/);
	assert.match(result.output, /costs fell 4%/);
	assert.ok(streamed.length > 1);
	assert.match(streamed.at(-1) ?? "", /revenue grew 12%/);
	const trace = (await readFile(result.tracePath, "utf8"))
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { eventId: string; parentEventId?: string; type: string; sequence: number });
	const types = trace.map(({ type }) => type);
	for (const required of [
		"run.started",
		"task.compiled",
		"capabilities.resolved",
		"model.request.started",
		"tool.requested",
		"tool.allowed",
		"tool.started",
		"tool.completed",
		"verification.completed",
		"run.completed",
	]) {
		assert.ok(types.includes(required), `missing ${required}`);
	}
	assert.deepEqual(trace.map(({ sequence }) => sequence), trace.map((_, index) => index + 1));
	assert.ok(trace.slice(1).every(({ parentEventId }) => parentEventId), "every non-root event must have a parent");
	assert.equal(types.filter((type) => type === "model.first_token").length, 2);
	assert.equal(types.filter((type) => type === "tool.completed").length, 2);
	for (const [before, after] of [
		["model.request.completed", "tool.requested"],
		["tool.requested", "tool.allowed"],
		["tool.allowed", "tool.started"],
		["tool.started", "tool.completed"],
	] as const) {
		assert.ok(types.indexOf(before) < types.indexOf(after), `${before} must precede ${after}`);
	}
	assert.ok(result.usage.totalTokens > 0);
	assert.equal(typeof result.usage.cacheSavingsRatio, "number");
	assert.equal(typeof result.usage.cost?.total, "number");
	assert.match(await readFile(result.tracePath, "utf8"), /"durationMs":/);
});

test("permissionMode auto approves known ASK tools while ask remains fail-closed", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-permission-mode-"));
	const providerFetch = (): typeof fetch => {
		let requestCount = 0;
		return async () => {
			requestCount++;
			const base = { id: `permission-${requestCount}`, object: "chat.completion.chunk", created: 1, model: "permission-model" };
			const events = requestCount === 1
				? [
					{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "permission-list", type: "function", function: { name: "list_workspace", arguments: '{"path":"."}' } }] }, finish_reason: null }] },
					{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
				]
				: requestCount === 2
				? [
					{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "permission-write", type: "function", function: { name: "write_workspace", arguments: '{"path":"status.txt","content":"done"}' } }] }, finish_reason: null }] },
					{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
				]
				: [
					{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Wrote status.txt." }, finish_reason: null }] },
					{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
				];
			return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		};
	};
	const run = (permissionMode: "ask" | "auto") => createHarness().run({
		objective: "Implement a new status file",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "permission-provider",
		modelId: "permission-model",
		providerConfiguration: {
			id: "permission-provider",
			name: "Permission Provider",
			kind: "openai-compatible",
			baseUrl: "https://provider.test/v1",
			apiKey: "test-key",
		},
		providerFetch: providerFetch(),
		permissionMode,
	});
	const ask = await run("ask");
	assert.equal(ask.verification.passed, false);
	assert.equal(await stat(join(root, "status.txt")).then(() => true, () => false), false);
	const automatic = await run("auto");
	assert.equal(automatic.verification.passed, true);
	assert.equal(await readFile(join(root, "status.txt"), "utf8"), "done");
});

test("workspace inspection refuses link escapes", async () => {
	const root = await mkdtemp(join(tmpdir(), "agent-harness-root-"));
	const outside = await mkdtemp(join(tmpdir(), "agent-harness-outside-"));
	await mkdir(join(root, "links"));
	await writeFile(join(outside, "secret.txt"), "secret", "utf8");
	await symlink(outside, join(root, "links", "outside"), process.platform === "win32" ? "junction" : "dir");
	const tool = inspectWorkspaceTool(root);
	await assert.rejects(() => tool.execute("call", { path: "links/outside/secret.txt" }), /outside the workspace/);
});

test("workspace discovery lists files and searches code without following ignored or escaped paths", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-discovery-"));
	const outside = await mkdtemp(join(tmpdir(), "codetonomy-discovery-outside-"));
	await mkdir(join(root, "src"), { recursive: true });
	await mkdir(join(root, "node_modules", "ignored"), { recursive: true });
	const indexedSource = `${"irrelevant prefix ".repeat(30)}\nexport const mascot = 'polar bear semantic indexed result';\n${"irrelevant suffix ".repeat(30)}\n`;
	await writeFile(join(root, "src", "agent.ts"), indexedSource, "utf8");
	await writeFile(join(root, ".env"), "POLAR_BEAR_API_KEY=never-expose-this", "utf8");
	await writeFile(join(root, "secrets.json"), '{"token":"polar bear credential"}', "utf8");
	await mkdir(join(root, ".ssh"));
	await writeFile(join(root, ".ssh", "id_ed25519"), "polar bear private key", "utf8");
	await writeFile(join(root, "node_modules", "ignored", "secret.ts"), "polar bear secret", "utf8");
	await writeFile(join(outside, "outside.ts"), "polar bear outside", "utf8");
	await symlink(outside, join(root, "escaped"), process.platform === "win32" ? "junction" : "dir");

	const listed = await listWorkspaceTool(root).execute("list", { path: ".", depth: 2, limit: 100 });
	const listText = listed.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
	assert.match(listText, /src\/agent\.ts/);
	assert.doesNotMatch(listText, /node_modules|escaped|\.env|secrets\.json|\.ssh/);
	await mkdir(join(root, ".codetonomy"));
	await writeFile(join(root, ".codetonomy", "credentials.env"), "API_KEY=secret", "utf8");
	await assert.rejects(() => inspectWorkspaceTool(root).execute("protected", { path: ".codetonomy/credentials.env" }), /protected/);
	await assert.rejects(() => inspectWorkspaceTool(root).execute("sensitive", { path: ".env" }), /Sensitive workspace paths/);
	await assert.rejects(() => writeWorkspaceTool(root).execute("sensitive-write", { path: ".env.local", content: "SECRET=bad" }), /Sensitive workspace paths/);
	await assert.rejects(() => runWorkspaceCommandTool(root, { codexBinary: process.execPath }).execute("sensitive-command", { argv: ["ignored"] }), /commands are blocked.*sensitive path/);

	const searched = await searchWorkspaceTool(root).execute("search", { query: "polar bear" });
	const searchText = searched.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
	assert.match(searchText, /src\/agent\.ts:2/);
	assert.doesNotMatch(searchText, /never-expose|credential|private key|outside/);
	const virtualSearch = await searchWorkspaceTool(root).execute("virtual-search", { query: "polar bear", path: "/workspace/src" });
	assert.match(virtualSearch.content[0]?.type === "text" ? virtualSearch.content[0].text : "", /src\/agent\.ts:2/);
	const virtualInspect = await inspectWorkspaceTool(root).execute("virtual-inspect", { path: "/workspace/src/agent.ts", offset: 2, limit: 1 });
	assert.match(virtualInspect.content[0]?.type === "text" ? virtualInspect.content[0].text : "", /polar bear semantic indexed result/);
	const staleIndex = await searchWorkspaceTool(root, { search: async () => [{ path: ".env", content: "POLAR_BEAR_API_KEY=never-expose-this" }] }).execute("stale-sensitive-index", { query: "never-expose-this" });
	assert.doesNotMatch(staleIndex.content[0]?.type === "text" ? staleIndex.content[0].text : "", /never-expose-this/);
	const indexed = await searchWorkspaceTool(root, { search: async (_query, options) => {
		assert.equal(options.limit, 12);
		return [{ path: "src/agent.ts", content: indexedSource }];
	} }).execute("indexed", { query: "polar bear", limit: 100 });
	assert.equal((indexed.details as { backend?: string }).backend, "memoryDB");
	const indexedText = indexed.content[0]?.type === "text" ? indexed.content[0].text : "";
	assert.match(indexedText, /src\/agent\.ts:2: .*polar bear semantic indexed result/);
	assert.match(indexedText, /… .*polar bear semantic indexed result.* …/);
	assert.ok(indexedText.length < 280);
	await writeFile(join(root, "src/agent.ts"), `${indexedSource}\nMath.min(100_000, Math.max(1_000, limit * 250))\ntokenBudget < 1 || tokenBudget > 1_000_000\n`, "utf8");
	const layered = await searchWorkspaceTool(root, { search: async () => [
		{ path: "src/agent.ts", content: "Math.min(100_000, Math.max(1_000, limit * 250))", structure: { symbol: "workspaceRecallTokenBudget", architecturalLayer: "workspace caller token-budget policy", owner: "HybridGraphMemory.searchWorkspace" } },
		{ path: "src/agent.ts", content: "tokenBudget < 1 || tokenBudget > 1_000_000", structure: { symbol: "validateTencentRecallTokenBudget", architecturalLayer: "adapter input validation", owner: "TencentMemoryAdapter.recall" } },
	] }).execute("layered", { query: "workspace recall token budget" });
	const layeredText = layered.content[0]?.type === "text" ? layered.content[0].text : "";
	assert.match(layeredText, /Competing architectural layers found/);
	assert.match(layeredText, /workspace caller token-budget policy -> HybridGraphMemory\.searchWorkspace \[1000, 100000\] tokens/);
	assert.match(layeredText, /adapter input validation -> TencentMemoryAdapter\.recall \[1, 1000000\] tokens/);
	assert.equal((layered.details as { claimCandidates?: unknown[] }).claimCandidates?.length, 2);
	const budgetedTool = searchWorkspaceTool(root, { search: async () => [{ path: "src/agent.ts", content: indexedSource }] });
	for (let call = 0; call < 4; call++) await budgetedTool.execute(`budget-${call}`, { query: `query ${call}` });
	const exhausted = await budgetedTool.execute("budget-exhausted", { query: "polar bear" });
	assert.match(exhausted.content[0]?.type === "text" ? exhausted.content[0].text : "", /src\/agent\.ts:2/);
	assert.equal((exhausted.details as { backend?: string; budgetExhausted?: boolean }).backend, "literal");
	assert.equal((exhausted.details as { budgetExhausted?: boolean }).budgetExhausted, true);
	await assert.rejects(() => listWorkspaceTool(root).execute("escape", { path: "../" }), /outside the workspace/);
});

test("workspace writes are atomic, exact, and confined to the workspace", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-write-"));
	const outside = await mkdtemp(join(tmpdir(), "codetonomy-write-outside-"));
	await mkdir(join(root, "src"), { recursive: true });
	await writeWorkspaceTool(root).execute("write", { path: "src/app.ts", content: "const state = 'old';\n" });
	assert.equal(await readFile(join(root, "src", "app.ts"), "utf8"), "const state = 'old';\n");
	await writeWorkspaceTool(root).execute("virtual-write", { path: "/workspace/src/virtual.ts", content: "export {};\n" });
	assert.equal(await readFile(join(root, "src", "virtual.ts"), "utf8"), "export {};\n");
	await editWorkspaceTool(root).execute("edit", { path: "src/app.ts", oldText: "'old'", newText: "'new'" });
	assert.equal(await readFile(join(root, "src", "app.ts"), "utf8"), "const state = 'new';\n");
	await writeFile(join(root, "ambiguous.txt"), "same same", "utf8");
	await assert.rejects(
		() => editWorkspaceTool(root).execute("ambiguous", { path: "ambiguous.txt", oldText: "same", newText: "new" }),
		/2 locations/,
	);
	await symlink(outside, join(root, "escaped-write"), process.platform === "win32" ? "junction" : "dir");
	await assert.rejects(() => writeWorkspaceTool(root).execute("escape", { path: "escaped-write/output.txt", content: "secret" }), /outside the workspace/);
	await assert.rejects(
		() => writeWorkspaceTool(root).execute("escape", { path: "../secret.txt", content: "secret" }),
		/outside the workspace/,
	);
});

test("isolated spreadsheet worker creates and independently verifies a formula workbook", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-workbook-"));
	const inspection = await createValuationWorkbook(root, {
		company: "Example Co",
		outputPath: "output/valuation.xlsx",
		historical: [
			{ year: 2024, revenue: 100, ebitda: 20, freeCashFlow: 12, source: "Annual report page 10" },
			{ year: 2025, revenue: 110, ebitda: 24, freeCashFlow: 15, source: "Annual report page 11" },
		],
		scenarios: [
			{ name: "Bear", revenueGrowth: 0.02, ebitdaMargin: 0.18 },
			{ name: "Base", revenueGrowth: 0.07, ebitdaMargin: 0.22 },
			{ name: "Bull", revenueGrowth: 0.12, ebitdaMargin: 0.26 },
		],
		discountRate: 0.1,
		terminalGrowthRate: 0.025,
		taxRate: 0.21,
		sources: [{ label: "FY2025 report", source: "report.pdf", page: 11 }],
	});
	assert.equal(inspection.path, "output/valuation.xlsx");
	assert.ok(inspection.formulas >= 60);
	assert.deepEqual(inspection.scenarios, ["Bear", "Base", "Bull"]);
	assert.equal((await readFile(join(root, "output", "valuation.xlsx"))).subarray(0, 2).toString(), "PK");
	const verification = await verifyValuationWorkbook(root, "output/valuation.xlsx");
	assert.equal(verification.passed, true);
	assert.ok(verification.checks.every(({ passed }) => passed));
	await assert.rejects(
		() => createValuationWorkbook(root, {
			company: "Bad",
			outputPath: "../escape.xlsx",
			historical: [{ year: 2025, revenue: 1, ebitda: 1, freeCashFlow: 1 }],
			scenarios: [
				{ name: "A", revenueGrowth: 0, ebitdaMargin: 0 },
				{ name: "B", revenueGrowth: 0, ebitdaMargin: 0 },
				{ name: "C", revenueGrowth: 0, ebitdaMargin: 0 },
			],
			discountRate: 0.1,
			terminalGrowthRate: 0.02,
			sources: [{ label: "Source", source: "source" }],
		}),
		/outside the workspace/,
	);
});

test("spreadsheet preset produces a verified workbook artifact through the agent loop", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-workbook-agent-"));
	const task = compileTask({ objective: "Create a valuation workbook" });
	const capabilities = resolveCapabilities(task);
	assert.equal(capabilities.preset.id, "spreadsheet-agent");
	assert.ok(capabilities.verifierIds.includes("formula-reference"));
	const workbookArguments = {
		company: "Agent Example",
		outputPath: "output/agent-valuation.xlsx",
		historical: [{ year: 2025, revenue: 200, ebitda: 40, freeCashFlow: 25, source: "report.pdf page 8" }],
		scenarios: [
			{ name: "Bear", revenueGrowth: 0.01, ebitdaMargin: 0.17 },
			{ name: "Base", revenueGrowth: 0.06, ebitdaMargin: 0.21 },
			{ name: "Bull", revenueGrowth: 0.11, ebitdaMargin: 0.25 },
		],
		discountRate: 0.1,
		terminalGrowthRate: 0.02,
		sources: [{ label: "Annual report", source: "report.pdf", page: 8 }],
	};
	let requestCount = 0;
	const providerFetch: typeof fetch = async () => {
		requestCount++;
		const base = { id: `workbook-${requestCount}`, object: "chat.completion.chunk", created: 1, model: "workbook-model" };
		const tool = requestCount === 1
			? { id: "list-call", name: "list_workspace", arguments: { path: "." } }
			: { id: "workbook-call", name: "create_valuation_workbook", arguments: workbookArguments };
		const events = requestCount < 3
			? [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: tool.id, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
			]
			: [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Created and verified the three-scenario valuation workbook." }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
			];
		return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const result = await createHarness().run({
		objective: "Create a valuation workbook",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "workbook-provider",
		modelId: "workbook-model",
		providerConfiguration: {
			id: "workbook-provider",
			name: "Workbook Provider",
			kind: "openai-compatible",
			baseUrl: "https://provider.test/v1",
			apiKey: "test-key",
		},
		providerFetch,
		approve: async () => true,
	});
	assert.equal(result.verification.passed, true);
	assert.ok(result.verification.checks.some(({ id, passed }) => id === "formula-reference" && passed));
	const workbook = result.artifacts.find(({ path }) => path?.endsWith("agent-valuation.xlsx"));
	assert.ok(workbook?.path);
	assert.equal((await readFile(workbook!.path!)).subarray(0, 2).toString(), "PK");
	assert.ok(result.checkpointPath);
});

test("workspace commands use argv-only Codex sandboxing and propagate cancellation", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-command-"));
	const invocation = createCodexSandboxInvocation(root, ["npm", "test"]);
	assert.deepEqual(invocation.slice(-3), ["--", "npm", "test"]);
	const state = JSON.parse(invocation[2]!) as {
		permissionProfile: { network: string; file_system: { entries: Array<{ access: string; path: { type: string; value?: { kind?: string } } }> } };
		sandboxCwd: string;
	};
	assert.equal(state.permissionProfile.network, "restricted");
	assert.ok(state.permissionProfile.file_system.entries.some(({ access, path }) => access === "write" && path.value?.kind === "project_roots"));
	assert.match(state.sandboxCwd, /^file:/);
	assert.deepEqual(filterSandboxEnvironment({ PATH: "/bin", LANG: "C", OPENAI_API_KEY: "secret", CUSTOM_TOKEN: "secret" }), { PATH: "/bin", LANG: "C" });

	const shim = join(root, "sandbox");
	await writeFile(shim, "setInterval(() => {}, 1000);\n", "utf8");
	const abort = new AbortController();
	const execution = runWorkspaceCommandTool(root, { codexBinary: process.execPath }).execute("run", { argv: ["npm", "test"], timeoutSeconds: 30 }, abort.signal);
	setTimeout(() => abort.abort(), 20);
	await assert.rejects(() => execution, /aborted/);
});

test("workspace command checkpoints restore edited and newly created files", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-command-checkpoint-"));
	await writeFile(join(root, "existing.txt"), "before", "utf8");
	const shim = join(root, "sandbox");
	await writeFile(shim, "const fs = require('node:fs'); fs.writeFileSync('existing.txt', 'after'); fs.writeFileSync('created.txt', 'new');\n", "utf8");
	const checkpointPath = join(root, ".harness", "command.json");
	const checkpoint = new RunCheckpoint(root, "command-run", checkpointPath);
	const result = await runWorkspaceCommandTool(root, { codexBinary: process.execPath, observer: checkpoint }).execute("run", { argv: ["ignored"] });
	assert.equal((result.details as { rewindCoverage?: string }).rewindCoverage, "incomplete");
	assert.deepEqual((await previewCheckpoint(checkpointPath, root)).files, ["existing.txt", "created.txt"]);
	await rewindCheckpoint(checkpointPath, root);
	assert.equal(await readFile(join(root, "existing.txt"), "utf8"), "before");
	await assert.rejects(() => readFile(join(root, "created.txt"), "utf8"), { code: "ENOENT" });
});

test("workspace command checkpoints cover projects larger than the former 5000-file boundary", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-large-checkpoint-"));
	await mkdir(join(root, "src"));
	for (let start = 0; start < 5_100; start += 250) {
		await Promise.all(Array.from({ length: Math.min(250, 5_100 - start) }, (_, offset) => writeFile(join(root, "src", `${start + offset}.txt`), "")));
	}
	const checkpointPath = join(root, ".harness", "large.json");
	const checkpoint = new RunCheckpoint(root, "large-run", checkpointPath);
	await checkpoint.beforeWorkspace();
	await writeFile(join(root, "src", "5099.txt"), "changed");
	await checkpoint.afterWorkspace();
	assert.deepEqual((await previewCheckpoint(checkpointPath, root)).files, [join("src", "5099.txt")]);
});

test("durable checkpoints restore approved edits and reject later manual changes", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-checkpoint-"));
	const checkpointPath = join(root, ".harness", "checkpoint.json");
	await writeFile(join(root, "existing.txt"), "before", "utf8");
	const checkpoint = new RunCheckpoint(root, "run-1", checkpointPath);
	await writeWorkspaceTool(root, checkpoint).execute("edit-existing", { path: "existing.txt", content: "after" });
	await writeWorkspaceTool(root, checkpoint).execute("create-new", { path: "new.txt", content: "new" });
	assert.equal(checkpoint.path, checkpointPath);
	assert.equal(await readFile(join(root, "existing.txt"), "utf8"), "after");
	const preview = await previewCheckpoint(checkpointPath, root);
	assert.deepEqual(preview.files, ["existing.txt", "new.txt"]);
	assert.match(preview.diff, /-before[\s\S]*\+after/);
	const rewound = await rewindCheckpoint(checkpointPath, root);
	assert.deepEqual(rewound, { restored: ["existing.txt"], deleted: ["new.txt"], coverage: "captured", residual: [] });
	assert.equal(await readFile(join(root, "existing.txt"), "utf8"), "before");
	await assert.rejects(() => readFile(join(root, "new.txt"), "utf8"), { code: "ENOENT" });

	const conflictingPath = join(root, ".harness", "conflict.json");
	const conflict = new RunCheckpoint(root, "run-2", conflictingPath);
	await writeWorkspaceTool(root, conflict).execute("edit", { path: "existing.txt", content: "codetonomy" });
	await writeFile(join(root, "existing.txt"), "manual", "utf8");
	await assert.rejects(() => rewindCheckpoint(conflictingPath, root), /changed after Codetonomy/);
	assert.equal(await readFile(join(root, "existing.txt"), "utf8"), "manual");
});

test("workspace inspection rejects oversized and invalid UTF-8 files", async () => {
	const root = await mkdtemp(join(tmpdir(), "agent-harness-input-"));
	const tool = inspectWorkspaceTool(root);
	await writeFile(join(root, "large.txt"), Buffer.alloc(2 * 1024 * 1024 + 1));
	await writeFile(join(root, "binary.txt"), Buffer.from([0xff]));
	await writeFile(join(root, "original.txt"), "linked", "utf8");
	await link(join(root, "original.txt"), join(root, "linked.txt"));
	await assert.rejects(() => tool.execute("large", { path: "large.txt" }), /exceeds/);
	await assert.rejects(() => tool.execute("binary", { path: "binary.txt" }), /valid/i);
	await assert.rejects(() => tool.execute("linked", { path: "linked.txt" }), /Hard-linked/);
});

test("verification rejects refusals and workspace answers without evidence", () => {
	const task = compileTask({ objective: "Scan the codebase" });
	const refusal = verifyOutput("I don't have access to file tools. Please provide the codebase.", undefined, { task });
	assert.equal(refusal.passed, false);
	assert.equal(refusal.checks.find(({ id }) => id === "agent-completed-task")?.passed, false);
	const unsupported = verifyOutput("The project looks healthy.", undefined, { task });
	assert.equal(unsupported.checks.find(({ id }) => id === "workspace-evidence")?.passed, false);
	const supported = verifyOutput("The project contains a runtime and CLI.", undefined, {
		task,
		completedToolIds: ["list_workspace"],
	});
	assert.equal(supported.passed, true);
});

test("verification matches exact bound claims to the requested architectural layer", () => {
	const task = compileTask({ objective: "Find the function bounding TencentDB workspace recall. Report its exact minimum and maximum bounds." });
	const workspaceClaimCandidates = [
		{ path: "packages/memory-client/src/index.ts", architecturalLayer: "workspace caller token-budget policy", symbols: ["HybridGraphMemory.searchWorkspace", "workspaceRecallTokenBudget"], minimum: 1_000, maximum: 100_000, unit: "tokens" as const },
		{ path: "packages/memory-client/src/index.ts", architecturalLayer: "adapter input validation", symbols: ["TencentMemoryAdapter.recall", "validateTencentRecallTokenBudget"], minimum: 1, maximum: 1_000_000, unit: "tokens" as const },
	];
	const wrong = verifyOutput("TencentMemoryAdapter.recall in packages/memory-client/src/index.ts accepts 1 to 1,000,000 tokens.", undefined, {
		task, completedToolIds: ["search_workspace"], workspaceClaimCandidates,
	});
	assert.equal(wrong.checks.find(({ id }) => id === "source-grounded-claim")?.passed, false);
	assert.match(wrong.checks.find(({ id }) => id === "source-grounded-claim")?.message ?? "", /workspace caller token-budget policy/);
	const correct = verifyOutput("HybridGraphMemory.searchWorkspace in packages/memory-client/src/index.ts uses 1,000 to 100,000 tokens.", undefined, {
		task, completedToolIds: ["search_workspace"], workspaceClaimCandidates,
	});
	assert.equal(correct.checks.find(({ id }) => id === "source-grounded-claim")?.passed, true);
});

test("permission ASK and DENY decisions fail closed without approval", async () => {
	for (const decision of ["ASK", "DENY"] as const) {
		const gate = new PermissionGate({ id: decision, defaultDecision: decision, toolDecisions: {} });
		const result = await gate.check({ toolId: "unknown", arguments: {}, riskClass: "high" });
		assert.equal(result.allowed, false);
		assert.equal(result.decision, decision);
	}
	const fullLike = new PermissionGate({ id: "deny", defaultDecision: "DENY", toolDecisions: {} }, async () => true);
	assert.equal((await fullLike.check({ toolId: "unknown", arguments: {}, riskClass: "high" })).allowed, false);
});

test("tool failures fail verification and the run", async () => {
	const root = await mkdtemp(join(tmpdir(), "agent-harness-failure-"));
	const result = await createHarness().run({
		objective: "Read missing evidence",
		files: [join(root, "missing.txt")],
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
	});
	assert.equal(result.verification.passed, false);
	const trace = await readFile(result.tracePath, "utf8");
	assert.match(trace, /"type":"tool.failed"/);
	assert.match(trace, /"type":"run.failed"/);
});

test("an already-aborted run stops before model execution", async () => {
	const root = await mkdtemp(join(tmpdir(), "agent-harness-abort-"));
	const abortController = new AbortController();
	abortController.abort();
	await assert.rejects(
		() => createHarness().run({
			objective: "Do not start",
			workspaceRoot: root,
			traceDirectory: join(root, "runs"),
			signal: abortController.signal,
		}),
		/Run aborted/,
	);
});

test("an OpenAI-compatible provider receives tools and completes a real tool round-trip", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-custom-provider-"));
	await writeFile(join(root, "README.md"), "# Local project\n", "utf8");
	const requests: Array<Record<string, unknown>> = [];
	const providerFetch: typeof fetch = async (_input, init) => {
		requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		const base = { id: `chat-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "coder-model" };
		const events = requests.length === 1
			? [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "list_workspace", arguments: '{"path":".","depth":1}' } }] }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
			]
			: [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "The workspace contains README.md." }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
			];
		return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const result = await createHarness().run({
			objective: "Scan the codebase and summarize it",
			workspaceRoot: root,
			traceDirectory: join(root, "runs"),
			provider: "local-llm",
			modelId: "coder-model",
			providerConfiguration: {
				id: "local-llm",
				name: "Local LLM",
				kind: "openai-compatible",
				baseUrl: "https://provider.test/v1",
				apiKey: "test-key",
			},
			providerFetch,
		});
	assert.equal(result.verification.passed, true);
	assert.match(result.output, /README\.md/);
	assert.equal(requests.length, 2);
	const tools = requests[0]?.tools as Array<{ function?: { name?: string } }>;
	assert.ok(tools.some(({ function: definition }) => definition?.name === "list_workspace"));
	const messages = requests[1]?.messages as Array<{ role?: string }>;
	assert.ok(messages.some(({ role }) => role === "tool"));
});

test("indexed search keeps the prompt-advertised listing fallback available", async () => {
	const toolNames = (request: Record<string, unknown>): string[] =>
		((request.tools ?? []) as Array<{ function?: { name?: unknown } }>)
			.flatMap(({ function: definition }) => typeof definition?.name === "string" ? [definition.name] : []);
	const response = (choices: unknown[]): Response => new Response(
		`${choices.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);

	const indexedRoot = await mkdtemp(join(tmpdir(), "codetonomy-memorydb-routing-hit-"));
	await writeFile(join(indexedRoot, "README.md"), "# Indexed project\n", "utf8");
	const indexedRequests: Array<Record<string, unknown>> = [];
	const indexedProviderFetch: typeof fetch = async (_input, init) => {
		indexedRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		const base = { id: `memorydb-hit-${indexedRequests.length}`, object: "chat.completion.chunk", created: 1, model: "memorydb-model" };
		const choices = indexedRequests.length === 1
			? [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "memorydb-search", type: "function", function: { name: "search_workspace", arguments: '{"query":"indexed project"}' } }] }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
			]
			: indexedRequests.length === 2
				? [
					{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "memorydb-write", type: "function", function: { name: "write_workspace", arguments: '{"path":"status.txt","content":"done\\n"}' } }] }, finish_reason: null }] },
					{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
				]
				: [
					{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Implemented status.txt." }, finish_reason: null }] },
					{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
				];
		return response(choices);
	};
	const indexed = await createHarness().run({
		objective: "Implement a status file in this project",
		workspaceRoot: indexedRoot,
		traceDirectory: join(indexedRoot, "runs"),
		provider: "memorydb-provider",
		modelId: "memorydb-model",
		permissionMode: "auto",
		providerConfiguration: { id: "memorydb-provider", name: "MemoryDB Provider", kind: "openai-compatible", baseUrl: "https://provider.test/v1", apiKey: "test-key" },
		providerFetch: indexedProviderFetch,
		toolInterface: "structured",
		workspaceSearch: { search: async () => [{ path: "README.md", content: "# Indexed project\n" }] },
	});
	assert.equal(indexed.verification.passed, true);
	assert.equal(indexedRequests.length, 3);
	assert.ok(toolNames(indexedRequests[0]!).includes("search_workspace"));
	assert.ok(toolNames(indexedRequests[0]!).includes("list_workspace"));
	for (const request of indexedRequests.slice(1)) {
		const names = toolNames(request);
		assert.ok(names.includes("list_workspace"));
		assert.ok(names.includes("inspect_workspace"));
		assert.ok(names.includes("write_workspace"));
	}

	const missRoot = await mkdtemp(join(tmpdir(), "codetonomy-memorydb-routing-miss-"));
	await writeFile(join(missRoot, "README.md"), "# Fallback project\n", "utf8");
	const missRequests: Array<Record<string, unknown>> = [];
	const missProviderFetch: typeof fetch = async (_input, init) => {
		missRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		const base = { id: `memorydb-miss-${missRequests.length}`, object: "chat.completion.chunk", created: 1, model: "memorydb-model" };
		const choices = missRequests.length === 1
			? [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "memorydb-miss-search", type: "function", function: { name: "search_workspace", arguments: '{"query":"not-indexed"}' } }] }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
			]
			: missRequests.length === 2
				? [
					{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "memorydb-list-fallback", type: "function", function: { name: "list_workspace", arguments: '{"path":".","depth":1}' } }] }, finish_reason: null }] },
					{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
				]
				: [
					{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "The workspace contains README.md." }, finish_reason: null }] },
					{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
				];
		return response(choices);
	};
	const miss = await createHarness().run({
		objective: "Scan the codebase and summarize it",
		workspaceRoot: missRoot,
		traceDirectory: join(missRoot, "runs"),
		provider: "memorydb-provider",
		modelId: "memorydb-model",
		providerConfiguration: { id: "memorydb-provider", name: "MemoryDB Provider", kind: "openai-compatible", baseUrl: "https://provider.test/v1", apiKey: "test-key" },
		providerFetch: missProviderFetch,
		toolInterface: "structured",
		workspaceSearch: { search: async () => [] },
	});
	assert.equal(miss.verification.passed, true);
	assert.equal(missRequests.length, 3);
	assert.ok(toolNames(missRequests[0]!).includes("list_workspace"));
	assert.ok(toolNames(missRequests[1]!).includes("list_workspace"));
});

test("a successful retry of the same tool clears a recoverable tool failure", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-tool-recovery-"));
	await writeFile(join(root, "README.md"), "# Recovery fixture\n", "utf8");
	let requestCount = 0;
	const providerFetch: typeof fetch = async () => {
		requestCount++;
		const base = { id: `recovery-${requestCount}`, object: "chat.completion.chunk", created: 1, model: "recovery-model" };
		const choices = requestCount === 1
			? [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "recovery-missing", type: "function", function: { name: "inspect_workspace", arguments: '{"path":"missing.txt"}' } }] }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
			]
			: requestCount === 2
				? [
					{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "recovery-corrected", type: "function", function: { name: "inspect_workspace", arguments: '{"path":"README.md"}' } }] }, finish_reason: null }] },
					{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
				]
				: [
					{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "The workspace contains README.md." }, finish_reason: null }] },
					{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
				];
		return new Response(`${choices.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const result = await createHarness().run({
		objective: "Scan the codebase",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "recovery-provider",
		modelId: "recovery-model",
		providerConfiguration: {
			id: "recovery-provider",
			name: "Recovery Provider",
			kind: "openai-compatible",
			baseUrl: "https://provider.test/v1",
			apiKey: "test-key",
		},
		providerFetch,
	});
	assert.equal(result.verification.passed, true);
	assert.equal(requestCount, 3);
});

test("unknown tools are traced and stop without verifier repair", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-unknown-tool-"));
	let requestCount = 0;
	const providerFetch: typeof fetch = async () => {
		requestCount++;
		const base = { id: `unknown-${requestCount}`, object: "chat.completion.chunk", created: 1, model: "unknown-model" };
		const events = [
			{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "unknown-read", type: "function", function: { name: "read_file", arguments: '{"path":"README.md"}' } }] }, finish_reason: null }] },
			{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
		];
		return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const result = await createHarness().run({
		objective: "Read README.md",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "unknown-provider",
		modelId: "unknown-model",
		providerConfiguration: {
			id: "unknown-provider",
			name: "Unknown Provider",
			kind: "openai-compatible",
			baseUrl: "https://provider.test/v1",
			apiKey: "test-key",
		},
		providerFetch,
	});
	assert.equal(requestCount, 1);
	assert.equal(result.verification.passed, false);
	assert.equal(result.verification.checks.find(({ id }) => id === "runtime-complete")?.message, "Tool read_file not found");
	const trace = await readFile(result.tracePath, "utf8");
	assert.match(trace, /"type":"tool.requested".*"toolId":"read_file"/);
	assert.match(trace, /"type":"tool.failed".*"message":"Tool read_file not found"/);
});

test("a parallel same-tool success does not hide a failed call", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-tool-parallel-failure-"));
	await writeFile(join(root, "README.md"), "# Parallel fixture\n", "utf8");
	let requestCount = 0;
	const providerFetch: typeof fetch = async () => {
		requestCount++;
		const base = { id: `parallel-${requestCount}`, object: "chat.completion.chunk", created: 1, model: "parallel-model" };
		const choices = requestCount === 1
			? [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [
					{ index: 0, id: "parallel-missing", type: "function", function: { name: "inspect_workspace", arguments: '{"path":"missing.txt"}' } },
					{ index: 1, id: "parallel-present", type: "function", function: { name: "inspect_workspace", arguments: '{"path":"README.md"}' } },
				] }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
			]
			: [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "The workspace contains README.md." }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
			];
		return new Response(`${choices.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const result = await createHarness().run({
		objective: "Scan the codebase",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "parallel-provider",
		modelId: "parallel-model",
		providerConfiguration: {
			id: "parallel-provider",
			name: "Parallel Provider",
			kind: "openai-compatible",
			baseUrl: "https://provider.test/v1",
			apiKey: "test-key",
		},
		providerFetch,
	});
	assert.equal(result.verification.passed, false);
	assert.ok(result.verification.checks.some(({ id, passed }) => id === "runtime-complete" && !passed));
});

test("provider requests use a bounded default output cap without changing the stable memory prefix", async () => {
	const run = async (label: string, maxOutputTokens?: number) => {
		const root = await mkdtemp(join(tmpdir(), `codetonomy-output-cap-${label}-`));
		const requests: Array<Record<string, unknown>> = [];
		const providerFetch: typeof fetch = async (_input, init) => {
			requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			const base = { id: `${label}-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "cap-model" };
			const events = [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Stable answer." }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
			];
			return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		};
		const memoryBackend = {
			recall: async (_query: string, tokenBudget: number) => ({
				structuralContext: [], evidence: [], memories: [], sourceVersions: [], provenance: [], tokenBudget, estimatedTokens: 0,
				contextHash: "empty-memory",
			}),
			capture: async () => {},
		};
		const result = await createHarness().run({
			objective: "Answer the question",
			workspaceRoot: root,
			traceDirectory: join(root, "runs"),
			provider: "cap-provider",
			modelId: "cap-model",
			providerConfiguration: {
				id: "cap-provider",
				name: "Cap Provider",
				kind: "openai-compatible",
				baseUrl: "https://provider.test/v1",
				apiKey: "test-key",
			},
			providerFetch,
			...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
			...(label === "on" ? { memoryBackend, contextTokenBudget: 128 } : {}),
		});
		assert.equal(result.verification.passed, true);
		return { request: requests[0]!, result };
	};
	const off = await run("off");
	const on = await run("on");
	const lower = await run("lower", 512);
	const requestMaxTokens = (request: Record<string, unknown>): number => {
		const value = request.max_tokens ?? request.max_completion_tokens;
		assert.equal(typeof value, "number");
		return value as number;
	};
	assert.equal(requestMaxTokens(off.request), 12_000);
	assert.equal(requestMaxTokens(on.request), requestMaxTokens(off.request));
	assert.equal(off.result.modelContext?.maxOutputTokens, 12_000);
	assert.equal(on.result.modelContext?.maxOutputTokens, 12_000);
	assert.equal(requestMaxTokens(lower.request), 512);
	assert.deepEqual((off.request.messages as unknown[])[0], (on.request.messages as unknown[])[0]);
	assert.deepEqual(off.request.tools, on.request.tools);
	const onUserPrompt = (on.request.messages as Array<{ role?: string; content?: unknown }>).find(({ role }) => role === "user")?.content;
	assert.doesNotMatch(JSON.stringify(onUserPrompt), /<retrieved-context/);
	assert.equal(on.result.contextPacket?.estimatedTokens, 0);
});

test("max-output is terminal and does not enter generic verification repair", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-max-output-terminal-"));
	await writeFile(join(root, "README.md"), "# Read-only fixture\n", "utf8");
	let requestCount = 0;
	const providerFetch: typeof fetch = async () => {
		requestCount++;
		const base = { id: `max-output-terminal-${requestCount}`, object: "chat.completion.chunk", created: 1, model: "max-output-model" };
		const events = requestCount === 1
			? [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "inspect-read-only", type: "function", function: { name: "list_workspace", arguments: '{"path":".","depth":1}' } }] }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
			]
			: [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Partial inspection answer" }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "length" }] },
			];
		return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const result = await createHarness().run({
		objective: "Inspect the project and explain it",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "max-output-provider",
		modelId: "max-output-model",
		providerConfiguration: { id: "max-output-provider", name: "Max Output Provider", kind: "openai-compatible", baseUrl: "https://provider.test/v1", apiKey: "test-key" },
		providerFetch,
	});
	assert.equal(requestCount, 2);
	assert.equal(result.verification.passed, false);
	assert.equal(result.verification.checks.find(({ id }) => id === "runtime-complete")?.message, "Model output limit reached (8000 tokens)");
	const trace = await readFile(result.tracePath, "utf8");
	assert.match(trace, /"outcome":"max-output"/);
	assert.match(trace, /"actionNudgeIssued":false/);
	assert.match(trace, /"proactiveActionNudgeIssued":false/);
	assert.match(trace, /"truncationActionNudgeIssued":false/);
});

test("a first-turn truncation gets one fixed-cost discovery retry before adaptive expansion", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-first-turn-rescue-"));
	await writeFile(join(root, "README.md"), "# Indexed project\n", "utf8");
	const requests: Array<Record<string, unknown>> = [];
	const providerFetch: typeof fetch = async (_input, init) => {
		requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		const base = { id: `first-turn-rescue-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "rescue-model" };
		const events = requests.length === 1
			? [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "I will plan this carefully." }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "length" }] },
			]
			: requests.length === 2
				? [
					{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "rescue-search", type: "function", function: { name: "search_workspace", arguments: '{"query":"indexed project"}' } }] }, finish_reason: null }] },
					{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
				]
				: requests.length === 3
					? [
						{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "rescue-write", type: "function", function: { name: "write_workspace", arguments: '{"path":"status.txt","content":"done\\n"}' } }] }, finish_reason: null }] },
						{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
					]
					: [
						{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Implemented status.txt." }, finish_reason: null }] },
						{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
					];
		return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const result = await createHarness().run({
		objective: "Implement a status file in this project",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "first-turn-rescue-provider",
		modelId: "rescue-model",
		permissionMode: "auto",
		providerConfiguration: { id: "first-turn-rescue-provider", name: "First-turn rescue", kind: "openai-compatible", baseUrl: "https://provider.test/v1", apiKey: "test-key" },
		providerFetch,
		workspaceSearch: { search: async () => [{ path: "README.md", content: "# Indexed project\n" }] },
	});
	assert.equal(result.verification.passed, true);
	assert.equal(await readFile(join(root, "status.txt"), "utf8"), "done\n");
	assert.deepEqual(requests.map((request) => request.max_tokens ?? request.max_completion_tokens), [12_000, 12_000, 20_000, 8_000]);
	const retryUsers = (requests[1]?.messages as Array<{ role?: string; content?: unknown }>).filter(({ role }) => role === "user");
	assert.ok(retryUsers.some(({ content }) => JSON.stringify(content).includes("must call search_workspace")));
});

test("official DeepSeek continues one truncated prefix before issuing an executor nudge", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-deepseek-prefix-"));
	await writeFile(join(root, "README.md"), "# Prefix fixture\n", "utf8");
	const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
	const providerFetch: typeof fetch = async (input, init) => {
		const url = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		requests.push({ url, body });
		const base = { id: `deepseek-prefix-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "deepseek-v4-flash" };
		const events = requests.length === 1
			? [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "prefix-inspect", type: "function", function: { name: "list_workspace", arguments: '{"path":".","depth":1}' } }] }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
			]
			: requests.length === 2
				? [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "I inspected the project and will now " }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "apply" }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "length" }] },
			]
			: requests.length === 3
				? [
					{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "prefix-write", type: "function", function: { name: "write_workspace", arguments: '{"path":"status.txt","content":"done\\n"}' } }] }, finish_reason: null }] },
					{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
				]
				: [
					{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Implemented status.txt." }, finish_reason: null }] },
					{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
				];
		return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const result = await createHarness().run({
		objective: "Implement a status file in this project",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "deepseek",
		modelId: "deepseek-v4-flash",
		permissionMode: "auto",
		providerConfiguration: { id: "deepseek", name: "DeepSeek", kind: "deepseek", apiKey: "test-key" },
		providerFetch,
	});
	assert.equal(result.verification.passed, true);
	assert.equal(await readFile(join(root, "status.txt"), "utf8"), "done\n");
	assert.equal(requests.length, 4);
	assert.match(requests[0]!.url, /\/chat\/completions$/);
	assert.match(requests[1]!.url, /\/chat\/completions$/);
	assert.match(requests[2]!.url, /\/beta\/chat\/completions$/);
	const prefixMessages = requests[2]!.body.messages as Array<{ role: string; content?: unknown; prefix?: boolean }>;
	assert.equal(prefixMessages.at(-1)?.role, "assistant");
	assert.equal(prefixMessages.at(-1)?.prefix, true);
	assert.doesNotMatch(JSON.stringify(prefixMessages), /Continue the preceding response/);
	assert.match(requests[3]!.url, /\/chat\/completions$/);
});

test("a discovery loop gets one preemptive action reminder before the fifth turn", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-action-nudge-preemptive-"));
	await writeFile(join(root, "README.md"), "# Preemptive fixture\n", "utf8");
	let requestCount = 0;
	const requests: Array<Record<string, unknown>> = [];
	const providerFetch: typeof fetch = async (_input, init) => {
		requestCount++;
		requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		const base = { id: `action-nudge-preemptive-${requestCount}`, object: "chat.completion.chunk", created: 1, model: "action-model" };
		const events = requestCount <= 4
			? [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `inspect-${requestCount}`, type: "function", function: { name: "list_workspace", arguments: '{"path":".","depth":1}' } }] }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
			]
			: requestCount === 5
				? [
					{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "write-after-preemptive-nudge", type: "function", function: { name: "write_workspace", arguments: '{"path":"status.txt","content":"done\\n"}' } }] }, finish_reason: null }] },
					{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
				]
				: [
					{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Implemented status.txt." }, finish_reason: null }] },
					{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
				];
		return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const events: Array<{ type: string; data: Record<string, unknown> }> = [];
	const result = await createHarness().run({
		objective: "Implement a status file in this project",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "preemptive-action-provider",
		modelId: "action-model",
		permissionMode: "auto",
		providerConfiguration: { id: "preemptive-action-provider", name: "Preemptive Action Provider", kind: "openai-compatible", baseUrl: "https://provider.test/v1", apiKey: "test-key" },
		providerFetch,
		observers: [(event) => { events.push({ type: event.type, data: event.data }); }],
	});
	assert.equal(requestCount, 6);
	assert.equal(result.verification.passed, true);
	assert.equal(await readFile(join(root, "status.txt"), "utf8"), "done\n");
	const fifthTurnUsers = (requests[4]?.messages as Array<{ role?: string; content?: unknown }> | undefined)?.filter(({ role }) => role === "user") ?? [];
	assert.ok(fifthTurnUsers.some(({ content }) => JSON.stringify(content).includes("repeating workspace discovery")));
	const completed = events.filter(({ type }) => type === "model.request.completed");
	assert.deepEqual(completed.map(({ data }) => data.actionNudge), [false, false, false, false, true, false]);
	assert.deepEqual(completed.map(({ data }) => data.actionNudgeTrigger), [undefined, undefined, undefined, undefined, "proactive", undefined]);
	assert.equal(events.find(({ type }) => type === "run.completed")?.data.actionNudgeAttempts, 1);
	assert.equal(events.find(({ type }) => type === "run.completed")?.data.proactiveActionNudgeIssued, true);
	assert.equal(events.find(({ type }) => type === "run.completed")?.data.truncationActionNudgeIssued, false);
	assert.equal(events.find(({ type }) => type === "run.completed")?.data.modelOutputTruncations, 0);
});

test("a discovery reminder can be followed by a separate truncation rescue", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-action-nudge-two-stage-"));
	await writeFile(join(root, "README.md"), "# Two-stage fixture\n", "utf8");
	let requestCount = 0;
	const requests: Array<Record<string, unknown>> = [];
	const providerFetch: typeof fetch = async (_input, init) => {
		requestCount++;
		requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		const base = { id: `action-nudge-two-stage-${requestCount}`, object: "chat.completion.chunk", created: 1, model: "action-model" };
		const events = requestCount <= 4
			? [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `inspect-${requestCount}`, type: "function", function: { name: "list_workspace", arguments: '{"path":".","depth":1}' } }] }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
			]
			: requestCount === 5
				? [
					{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "I will keep planning." }, finish_reason: null }] },
					{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "length" }] },
				]
				: requestCount === 6
					? [
						{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "write-after-rescue", type: "function", function: { name: "write_workspace", arguments: '{"path":"status.txt","content":"done\\n"}' } }] }, finish_reason: null }] },
						{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
					]
						: [
							{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Implemented status.txt." }, finish_reason: null }] },
							{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
						];
		return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const events: Array<{ type: string; data: Record<string, unknown> }> = [];
	const result = await createHarness().run({
		objective: "Implement a status file in this project",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "two-stage-action-provider",
		modelId: "action-model",
		permissionMode: "auto",
		providerConfiguration: { id: "two-stage-action-provider", name: "Two-stage Action Provider", kind: "openai-compatible", baseUrl: "https://provider.test/v1", apiKey: "test-key" },
		providerFetch,
		observers: [(event) => { events.push({ type: event.type, data: event.data }); }],
	});
	assert.equal(requestCount, 7);
	assert.equal(result.verification.passed, true);
	assert.equal(await readFile(join(root, "status.txt"), "utf8"), "done\n");
	const completed = events.filter(({ type }) => type === "model.request.completed");
	assert.deepEqual(completed.filter(({ data }) => data.actionNudge).map(({ data }) => data.actionNudgeTrigger), ["proactive", "truncation"]);
	assert.equal(events.find(({ type }) => type === "run.completed")?.data.actionNudgeAttempts, 2);
	assert.equal(events.find(({ type }) => type === "run.completed")?.data.proactiveActionNudgeIssued, true);
	assert.equal(events.find(({ type }) => type === "run.completed")?.data.truncationActionNudgeIssued, true);
	assert.equal(events.find(({ type }) => type === "run.completed")?.data.modelOutputTruncations, 1);
	const rescueUsers = (requests[5]?.messages as Array<{ role?: string; content?: unknown }> | undefined)?.filter(({ role }) => role === "user") ?? [];
	assert.ok(rescueUsers.some(({ content }) => JSON.stringify(content).includes("write, edit, or command tool")));
	assert.equal(requests[5]?.tool_choice, "required");
	assert.deepEqual(requests.map((request) => request.max_tokens ?? request.max_completion_tokens), [12_000, 20_000, 20_000, 20_000, 12_000, 12_000, 8_000]);
});

test("a truncated mutation gets exactly one executor action nudge and can complete", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-action-nudge-success-"));
	await writeFile(join(root, "README.md"), "# Mutation fixture\n", "utf8");
	let requestCount = 0;
	const providerFetch: typeof fetch = async () => {
		requestCount++;
		const base = { id: `action-nudge-success-${requestCount}`, object: "chat.completion.chunk", created: 1, model: "action-model" };
		const events = requestCount === 1
			? [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "inspect-before-write", type: "function", function: { name: "list_workspace", arguments: '{"path":".","depth":1}' } }] }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
			]
			: requestCount === 2
				? [
					{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "I will plan the implementation first." }, finish_reason: null }] },
					{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "length" }] },
				]
				: requestCount === 3
					? [
						{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "write-after-nudge", type: "function", function: { name: "write_workspace", arguments: '{"path":"status.txt","content":"done\\n"}' } }] }, finish_reason: null }] },
						{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
					]
					: [
						{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Implemented status.txt." }, finish_reason: null }] },
						{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
					];
		return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const result = await createHarness().run({
		objective: "Implement a status file in this project",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "action-provider",
		modelId: "action-model",
		permissionMode: "auto",
		providerConfiguration: { id: "action-provider", name: "Action Provider", kind: "openai-compatible", baseUrl: "https://provider.test/v1", apiKey: "test-key" },
		providerFetch,
	});
	assert.equal(requestCount, 4);
	assert.equal(result.verification.passed, true);
	assert.equal(await readFile(join(root, "status.txt"), "utf8"), "done\n");
	const trace = await readFile(result.tracePath, "utf8");
	assert.match(trace, /"promptKind":"action-nudge"/);
	assert.match(trace, /"actionNudgeIssued":true/);
	assert.match(trace, /"actionNudgeAttempts":1/);
	assert.match(trace, /"actionNudgeTrigger":"truncation"/);
	assert.match(trace, /"proactiveActionNudgeIssued":false/);
	assert.match(trace, /"truncationActionNudgeIssued":true/);
	assert.match(trace, /"modelOutputTruncations":1/);
});

test("a second truncation after the action nudge fails without generic repair", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-action-nudge-repeat-"));
	await writeFile(join(root, "README.md"), "# Repeat fixture\n", "utf8");
	let requestCount = 0;
	const providerFetch: typeof fetch = async () => {
		requestCount++;
		const base = { id: `action-nudge-repeat-${requestCount}`, object: "chat.completion.chunk", created: 1, model: "repeat-model" };
		const events = requestCount === 1
			? [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "inspect-before-repeat", type: "function", function: { name: "list_workspace", arguments: '{"path":".","depth":1}' } }] }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
			]
			: [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Still planning", tool_calls: [{ index: 0, id: `truncated-write-${requestCount}`, type: "function", function: { name: "write_workspace", arguments: '{"path":"status.txt","content":"unsafe\\n"}' } }] }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "length" }] },
			];
		return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const result = await createHarness().run({
		objective: "Implement a status file in this project",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "repeat-provider",
		modelId: "repeat-model",
		permissionMode: "auto",
		providerConfiguration: { id: "repeat-provider", name: "Repeat Provider", kind: "openai-compatible", baseUrl: "https://provider.test/v1", apiKey: "test-key" },
		providerFetch,
	});
	assert.equal(requestCount, 3);
	assert.equal(result.verification.passed, false);
	assert.equal(result.verification.checks.find(({ id }) => id === "runtime-complete")?.message, "Model output limit reached (32000 tokens)");
	const trace = await readFile(result.tracePath, "utf8");
	assert.equal((trace.match(/"outcome":"max-output"/g) ?? []).length, 2);
	assert.match(trace, /"actionNudgeAttempts":1/);
	assert.match(trace, /"truncationActionNudgeIssued":true/);
	assert.doesNotMatch(trace, /"attempt":1/);
});

test("verified work at the model turn boundary succeeds and records prompt growth", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-turn-budget-success-"));
	await writeFile(join(root, "README.md"), "# Boundary fixture\n", "utf8");
	let requestCount = 0;
	const providerFetch: typeof fetch = async () => {
		requestCount++;
		const base = { id: `budget-success-${requestCount}`, object: "chat.completion.chunk", created: 1, model: "budget-model" };
		const toolCall = { index: 0, id: `budget-call-${requestCount}`, type: "function", function: { name: "list_workspace", arguments: '{"path":".","depth":1}' } };
		const events = [
			{ ...base, choices: [{ index: 0, delta: { role: "assistant", ...(requestCount === 12 ? { content: "The workspace contains README.md." } : {}), tool_calls: [toolCall] }, finish_reason: null }] },
			{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
		];
		return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const events: Array<{ type: string; data: Record<string, unknown> }> = [];
	const result = await createHarness().run({
		objective: "Scan the codebase",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "budget-provider",
		modelId: "budget-model",
		maxModelTurns: 12,
		providerConfiguration: { id: "budget-provider", name: "Budget Provider", kind: "openai-compatible", baseUrl: "https://provider.test/v1", apiKey: "test-key" },
		providerFetch,
		observers: [(event) => { events.push({ type: event.type, data: event.data }); }],
	});
	assert.equal(requestCount, 12);
	assert.equal(result.verification.passed, true);
	assert.equal(events.filter(({ type }) => type === "model.request.started").length, 12);
	const completed = events.filter(({ type }) => type === "model.request.completed");
	assert.equal(completed.at(-1)?.data.turnBudgetExhausted, true);
	assert.equal(completed.at(-1)?.data.maxOutputTokens, 8_000);
	assert.equal(typeof completed.at(-1)?.data.promptGrowthTokens, "number");
	assert.equal(events.find(({ type }) => type === "run.completed")?.data.turnBudgetExhausted, true);
});

test("verified action at the model turn boundary gets a deterministic completion", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-turn-budget-action-"));
	let requestCount = 0;
	const providerFetch: typeof fetch = async () => {
		requestCount++;
		const base = { id: `budget-action-${requestCount}`, object: "chat.completion.chunk", created: 1, model: "budget-model" };
		const toolCall = requestCount === 12
			? { index: 0, id: "budget-action-write", type: "function", function: { name: "write_workspace", arguments: '{"path":"status.txt","content":"done\\n"}' } }
			: { index: 0, id: `budget-action-list-${requestCount}`, type: "function", function: { name: "list_workspace", arguments: '{"path":".","depth":1}' } };
		const events = [
			{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [toolCall] }, finish_reason: null }] },
			{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
		];
		return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const result = await createHarness().run({
		objective: "Implement a status file in this project",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "budget-provider",
		modelId: "budget-model",
		maxModelTurns: 12,
		permissionMode: "auto",
		providerConfiguration: { id: "budget-provider", name: "Budget Provider", kind: "openai-compatible", baseUrl: "https://provider.test/v1", apiKey: "test-key" },
		providerFetch,
	});
	assert.equal(requestCount, 12);
	assert.equal(result.verification.passed, true);
	assert.equal(result.output, "Completed the requested workspace task and verified its required actions.");
	assert.equal(await readFile(join(root, "status.txt"), "utf8"), "done\n");
});

test("incomplete work at the model turn boundary fails without a repair turn", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-turn-budget-failure-"));
	let requestCount = 0;
	const providerFetch: typeof fetch = async () => {
		requestCount++;
		const base = { id: `budget-failure-${requestCount}`, object: "chat.completion.chunk", created: 1, model: "budget-model" };
		const toolCall = { index: 0, id: `budget-failure-call-${requestCount}`, type: "function", function: { name: requestCount === 12 ? "inspect_workspace" : "list_workspace", arguments: requestCount === 12 ? '{"path":"missing.txt"}' : '{"path":".","depth":1}' } };
		const events = [
			{ ...base, choices: [{ index: 0, delta: { role: "assistant", ...(requestCount === 12 ? { content: "I could not finish the inspection." } : {}), tool_calls: [toolCall] }, finish_reason: null }] },
			{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
		];
		return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const result = await createHarness().run({
		objective: "Scan the codebase",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "budget-provider",
		modelId: "budget-model",
		maxModelTurns: 12,
		providerConfiguration: { id: "budget-provider", name: "Budget Provider", kind: "openai-compatible", baseUrl: "https://provider.test/v1", apiKey: "test-key" },
		providerFetch,
	});
	assert.equal(requestCount, 12);
	assert.equal(result.verification.passed, false);
	assert.equal(result.verification.checks.find(({ id }) => id === "runtime-complete")?.message, "Model turn budget exhausted (12)");
});

test("automatic runs can finish beyond evaluation turn and tool-call budgets", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-automatic-stopping-"));
	await writeFile(join(root, "README.md"), "# Automatic stopping fixture\n", "utf8");
	let requestCount = 0;
	const providerFetch: typeof fetch = async () => {
		requestCount++;
		const base = { id: `automatic-${requestCount}`, object: "chat.completion.chunk", created: 1, model: "automatic-model" };
		const events = requestCount <= 16
			? [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [0, 1].map((index) => ({ index, id: `automatic-list-${requestCount}-${index}`, type: "function", function: { name: "list_workspace", arguments: '{"path":".","depth":1}' } })) }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
			]
			: [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "The workspace contains README.md." }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
			];
		return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const observed: Array<{ type: string; data: Record<string, unknown> }> = [];
	const result = await createHarness().run({
		objective: "Inspect and summarize this workspace",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "automatic-provider",
		modelId: "automatic-model",
		providerConfiguration: { id: "automatic-provider", name: "Automatic Provider", kind: "openai-compatible", baseUrl: "https://provider.test/v1", apiKey: "test-key" },
		providerFetch,
		observers: [(event) => { observed.push({ type: event.type, data: event.data }); }],
	});
	assert.equal(requestCount, 17);
	assert.equal(result.verification.passed, true);
	assert.equal(observed.filter(({ type }) => type === "tool.completed").length, 32);
	const completed = observed.find(({ type }) => type === "run.completed")?.data;
	assert.equal(completed?.modelTurns, 17);
	assert.equal(completed?.maxModelTurns, 100);
	assert.equal(completed?.maxToolCalls, 500);
});

test("read-only discovery gets a finalization reminder before the last turn", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-finalization-nudge-"));
	await writeFile(join(root, "README.md"), "# Finalization fixture\n", "utf8");
	const requests: Array<Record<string, unknown>> = [];
	const providerFetch: typeof fetch = async (_input, init) => {
		requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		const base = { id: `finalization-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "finalization-model" };
		const events = requests.length < 12
			? [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `list-${requests.length}`, type: "function", function: { name: "list_workspace", arguments: '{"path":".","depth":1}' } }] }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
			]
			: [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "The workspace contains README.md." }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
			];
		return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const result = await createHarness().run({
		objective: "Inspect and summarize this workspace",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "finalization-provider",
		modelId: "finalization-model",
		maxModelTurns: 12,
		providerConfiguration: { id: "finalization-provider", name: "Finalization Provider", kind: "openai-compatible", baseUrl: "https://provider.test/v1", apiKey: "test-key" },
		providerFetch,
	});
	assert.equal(requests.length, 12);
	assert.equal(result.verification.passed, true);
	assert.match(JSON.stringify(requests[11]?.messages), /One model turn remains/);
	assert.match(await readFile(result.tracePath, "utf8"), /"promptKind":"finalization-nudge"/);
});

test("a turn-12 length stop does not schedule a truncation rescue", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-turn-12-rescue-"));
	await writeFile(join(root, "README.md"), "# Turn boundary fixture\n", "utf8");
	let requestCount = 0;
	const providerFetch: typeof fetch = async () => {
		requestCount++;
		const base = { id: `turn-12-rescue-${requestCount}`, object: "chat.completion.chunk", created: 1, model: "budget-model" };
		const events = requestCount < 12
			? [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `inspect-${requestCount}`, type: "function", function: { name: "list_workspace", arguments: '{"path":".","depth":1}' } }] }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
			]
			: [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "I could not finish the implementation." }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "length" }] },
			];
		return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const events: Array<{ type: string; data: Record<string, unknown> }> = [];
	const result = await createHarness().run({
		objective: "Implement a status file in this project",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "turn-12-rescue-provider",
		modelId: "budget-model",
		maxModelTurns: 12,
		permissionMode: "auto",
		providerConfiguration: { id: "turn-12-rescue-provider", name: "Turn 12 Rescue Provider", kind: "openai-compatible", baseUrl: "https://provider.test/v1", apiKey: "test-key" },
		providerFetch,
		observers: [(event) => { events.push({ type: event.type, data: event.data }); }],
	});
	assert.equal(requestCount, 12);
	assert.equal(result.verification.passed, false);
	assert.equal(result.verification.checks.find(({ id }) => id === "runtime-complete")?.message, "Model output limit reached (20000 tokens)");
	const run = events.find(({ type }) => type === "run.failed")?.data;
	assert.equal(run?.modelTurns, 12);
	assert.equal(run?.actionNudgeAttempts, 1);
	assert.equal(run?.proactiveActionNudgeIssued, true);
	assert.equal(run?.truncationActionNudgeIssued, false);
});

test("memoryDB search keeps a stable tool schema after its fourth indexed result", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-memory-budget-"));
	await writeFile(join(root, "README.md"), "indexed project evidence\n", "utf8");
	const requests: Array<Record<string, unknown>> = [];
	const providerFetch: typeof fetch = async (_input, init) => {
		requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		const base = { id: `memory-${requests.length}`, object: "chat.completion.chunk", created: 1, model: "memory-model" };
		const events = requests.length <= 4
			? [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `search-${requests.length}`, type: "function", function: { name: "search_workspace", arguments: JSON.stringify({ query: `concept ${requests.length}` }) } }] }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
			]
			: [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "The indexed project evidence is in README.md." }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
			];
		return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	await createHarness().run({
		objective: "Inspect the workspace and find indexed project evidence",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "memory-provider",
		modelId: "memory-model",
		providerConfiguration: { id: "memory-provider", name: "Memory Provider", kind: "openai-compatible", baseUrl: "https://provider.test/v1", apiKey: "test-key" },
		providerFetch,
		workspaceSearch: { search: async () => [{ path: "README.md", content: "indexed project evidence" }] },
	});
	assert.equal(requests.length, 5);
	for (const request of requests.slice(0, 4)) {
		assert.ok((request.tools as Array<{ function?: { name?: string } }>).some(({ function: definition }) => definition?.name === "search_workspace"));
	}
	assert.ok((requests[4]?.tools as Array<{ function?: { name?: string } }>).some(({ function: definition }) => definition?.name === "search_workspace"));
});

test("deterministic verification feedback repairs a real provider run within budget", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-provider-repair-"));
	await writeFile(join(root, "README.md"), "# Repair fixture\n", "utf8");
	let requestCount = 0;
	const providerFetch: typeof fetch = async () => {
		requestCount++;
		const base = { id: `repair-${requestCount}`, object: "chat.completion.chunk", created: 1, model: "repair-model" };
		const choices = requestCount === 1
			? [
				{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "The project looks fine." }, finish_reason: null }] },
				{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
			]
			: requestCount === 2
				? [
					{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "repair-call", type: "function", function: { name: "list_workspace", arguments: '{"path":"."}' } }] }, finish_reason: null }] },
					{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
				]
				: [
					{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "The workspace contains README.md." }, finish_reason: null }] },
					{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
				];
		return new Response(`${choices.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	const result = await createHarness().run({
		objective: "Scan the codebase",
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		provider: "repair-provider",
		modelId: "repair-model",
		providerConfiguration: {
			id: "repair-provider",
			name: "Repair Provider",
			kind: "openai-compatible",
			baseUrl: "https://provider.test/v1",
			apiKey: "test-key",
		},
		providerFetch,
	});
	assert.equal(result.verification.passed, true);
	assert.equal(requestCount, 3);
	const trace = await readFile(result.tracePath, "utf8");
	assert.match(trace, /"type":"verification.failed"/);
	assert.match(trace, /"type":"verification.completed"/);
});
