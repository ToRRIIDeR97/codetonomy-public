import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RunResult } from "@agent-harness/contracts";
import { writeWorkspaceTool } from "../packages/tools/src/index.js";
import { runHarnessOrchestration } from "../packages/runtime/src/index.js";
import {
	normalizeWriteClaim,
	runOrchestration,
	writeClaimsOverlap,
	type OrchestrationNode,
} from "../packages/orchestration/src/index.js";

const fakeRun = (node: OrchestrationNode, passed = true): RunResult => ({
	runId: `run-${node.id}`,
	task: {
		id: `task-${node.id}`,
		objective: node.objective,
		inputs: [],
		artifactTypes: [],
		domains: [],
		requiredCapabilities: [],
		acceptanceCriteria: [],
		riskClass: "low",
	},
	capabilities: {
		preset: { id: node.presetId, version: "1", purpose: "test", coreSkillIds: [], toolIds: [], permissionProfileId: node.permissionProfileId, verifierIds: [], cacheStrategy: "AUTO_PREFIX" },
		skillIds: [],
		toolIds: [],
		permissionProfileId: node.permissionProfileId,
		verifierIds: [],
		toolBundleHash: "tools",
		skillPackHash: "skills",
		contextPacketHash: "context",
		cachePrefixHash: "cache",
		runProfileHash: "run",
	},
	output: `output ${node.id}`,
	artifacts: [],
	verification: { passed, checks: [] },
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
	tracePath: `/tmp/${node.id}.jsonl`,
});

test("write claims reject escapes, globs, and symlinks and detect parent overlap", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-claims-"));
	await mkdir(join(root, "outputs"));
	const parent = await normalizeWriteClaim(root, "workspace-write", ["outputs"]);
	const child = await normalizeWriteClaim(root, "workspace-write", ["outputs/report.md"]);
	assert.equal(writeClaimsOverlap(parent, child), true);
	assert.equal((await normalizeWriteClaim(root, "workspace-write")).wholeWorkspace, true);
	await assert.rejects(() => normalizeWriteClaim(root, "workspace-write", ["../outside"]), /outside the workspace/);
	await assert.rejects(() => normalizeWriteClaim(root, "workspace-write", ["outputs\/*.md"]), /glob/);
	if (process.platform !== "win32") {
		await symlink(tmpdir(), join(root, "linked"));
		await assert.rejects(() => normalizeWriteClaim(root, "workspace-write", ["linked/file.md"]), /symbolic link/);
	}
	const writer = writeWorkspaceTool(root, undefined, parent);
	await writer.execute("allowed", { path: "outputs/allowed.md", content: "ok" });
	await assert.rejects(() => writer.execute("denied", { path: "other/denied.md", content: "no" }), /declared write claim/);
});

test("bounded orchestration serializes its third writer and permits ordered shared paths", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-orchestration-"));
	const nodes: OrchestrationNode[] = [
		{ id: "research", objective: "Research", presetId: "researcher", permissionProfileId: "workspace-write", writePaths: ["output/research.json"] },
		{ id: "model", objective: "Model", presetId: "spreadsheet-agent", permissionProfileId: "workspace-write", writePaths: ["output/model.xlsx"] },
		{ id: "review", objective: "Review", presetId: "artifact-reviewer", permissionProfileId: "workspace-write", writePaths: ["output/model.xlsx"], dependencies: ["model"] },
	];
	let activeWriters = 0;
	let maximumWriters = 0;
	const order: string[] = [];
	const result = await runOrchestration({
		workspaceRoot: root,
		nodes,
		parentPermissionProfileId: "workspace-write",
		execute: async (node) => {
			activeWriters++;
			maximumWriters = Math.max(maximumWriters, activeWriters);
			await new Promise((resolve) => setTimeout(resolve, node.id === "model" ? 15 : 5));
			order.push(node.id);
			activeWriters--;
			return fakeRun(node);
		},
		synthesize: async (children) => [...children.keys()].join(","),
		verifyFinal: async () => ({ passed: true, checks: [] }),
	});
	assert.equal(result.verification.passed, true);
	assert.equal(maximumWriters, 2);
	assert.ok(order.indexOf("review") > order.indexOf("model"));
});

test("orchestration rejects concurrent overlaps before execution and skips failed dependents", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-orchestration-failure-"));
	let executions = 0;
	await assert.rejects(() => runOrchestration({
		workspaceRoot: root,
		parentPermissionProfileId: "workspace-write",
		nodes: [
			{ id: "one", objective: "One", presetId: "general-worker", permissionProfileId: "workspace-write", writePaths: ["same"] },
			{ id: "two", objective: "Two", presetId: "general-worker", permissionProfileId: "workspace-write", writePaths: ["same/file"] },
		],
		execute: async (node) => { executions++; return fakeRun(node); },
		synthesize: async () => "",
		verifyFinal: async () => ({ passed: true, checks: [] }),
	}), /overlapping write paths/);
	assert.equal(executions, 0);

	const nodes: OrchestrationNode[] = [
		{ id: "failed", objective: "Fail", presetId: "researcher", permissionProfileId: "workspace-read" },
		{ id: "dependent", objective: "Depend", presetId: "artifact-reviewer", permissionProfileId: "workspace-read", dependencies: ["failed"] },
		{ id: "independent", objective: "Continue", presetId: "researcher", permissionProfileId: "workspace-read" },
	];
	let synthesized: string[] = [];
	const result = await runOrchestration({
		workspaceRoot: root,
		nodes,
		parentPermissionProfileId: "workspace-read",
		execute: async (node) => fakeRun(node, node.id !== "failed"),
		synthesize: async (children) => { synthesized = [...children.keys()]; return "partial"; },
		verifyFinal: async () => ({ passed: true, checks: [] }),
	});
	assert.deepEqual(synthesized, ["independent"]);
	assert.deepEqual(result.children.map(({ status }) => status), ["failed", "skipped", "completed"]);
	assert.equal(result.verification.passed, false);
});

test("runtime orchestration executes verified depth-one agent runs and emits lifecycle events", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-runtime-orchestration-"));
	const events: string[] = [];
	const result = await runHarnessOrchestration({
		workspaceRoot: root,
		traceDirectory: join(root, "runs"),
		parentPermissionProfileId: "workspace-write",
		nodes: [
			{ id: "alpha", objective: "Say alpha", presetId: "general-worker", permissionProfileId: "workspace-write", writePaths: ["output/alpha.txt"] },
			{ id: "beta", objective: "Say beta", presetId: "general-worker", permissionProfileId: "workspace-write", writePaths: ["output/beta.txt"] },
		],
		onSubagentEvent: (type) => { events.push(type); },
	});
	assert.equal(result.verification.passed, true);
	assert.deepEqual(result.children.map(({ status }) => status), ["completed", "completed"]);
	assert.equal(events.filter((type) => type === "subagent.requested").length, 2);
	assert.equal(events.filter((type) => type === "subagent.completed").length, 2);
	const trace = await readFile(result.tracePath, "utf8");
	assert.match(trace, /"type":"subagent.started"/);
	assert.match(trace, /"type":"verification.completed"/);
	assert.match(trace, /"type":"run.completed"/);
});

test("orchestration children share the root model request budget", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-shared-budget-"));
	const result = await runHarnessOrchestration({
		workspaceRoot: root, traceDirectory: join(root, ".harness"), parentPermissionProfileId: "workspace-write", maxModelTurns: 1,
		nodes: [
			{ id: "alpha", objective: "Say alpha", presetId: "general-worker", permissionProfileId: "workspace-write", writePaths: ["output/alpha.txt"] },
			{ id: "beta", objective: "Say beta", presetId: "general-worker", permissionProfileId: "workspace-write", writePaths: ["output/beta.txt"] },
		],
	});
	assert.equal(result.verification.passed, false);
	assert.equal(result.children.filter(({ status }) => status === "completed").length, 1);
});
