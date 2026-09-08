import { repairMetrics } from "./repair.js";
import type { HarnessEvent } from "@agent-harness/contracts";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import type { RunResult } from "@agent-harness/contracts";
import {
	createHarness,
	type HarnessEvaluationVariant,
	type HarnessOrchestrationResult,
	type HarnessRunOptions,
	type RunSpendBudgetState,
} from "@agent-harness/runtime";
import { EvaluationStore, type RunMetrics } from "./store.js";

export const EVALUATION_VARIANTS = [
	"RAW_MODEL",
	"MODEL_TOOLS",
	"MODEL_SKILLS",
	"MODEL_SKILLS_TOOLS",
	"MODEL_SKILLS_TOOLS_VERIFIERS",
	"FULL_PRESET",
] as const;

export type EvaluationVariant = (typeof EVALUATION_VARIANTS)[number];

export interface BenchmarkCase {
	benchmarkId: string;
	variant: EvaluationVariant;
	execute(): Promise<RunResult | HarnessOrchestrationResult>;
}

export interface BenchmarkOutcome {
	benchmarkId: string;
	variant: EvaluationVariant;
	runId?: string;
	metrics?: RunMetrics;
	error?: string;
}

export interface BenchmarkComparison {
	benchmarkId: string;
	baseline: EvaluationVariant;
	candidate: EvaluationVariant;
	verifiedSuccessDelta: number;
	latencyDeltaMs: number;
	costDelta: number;
	candidateImprovesQuality: boolean;
	candidateImprovesLatencyWithoutQualityLoss: boolean;
}

export interface TaskBenchmarkResult {
	outcomes: BenchmarkOutcome[];
	comparison: BenchmarkComparison;
}

export async function runTaskBenchmark(
	store: EvaluationStore,
	benchmarkId: string,
	options: HarnessRunOptions,
	fullPreset?: (spendBudgetState: RunSpendBudgetState) => Promise<RunResult | HarnessOrchestrationResult>,
): Promise<TaskBenchmarkResult> {
	if (!/^[A-Za-z0-9._:-]{1,160}$/.test(benchmarkId)) throw new Error("Invalid benchmark id");
	const harness = createHarness();
	const spendBudgetState = options.spendBudgetState ?? { maxCostUsd: options.maxCostUsd, maxTotalTokens: options.maxTotalTokens, costUsd: 0, totalTokens: 0 };
	const cases: BenchmarkCase[] = EVALUATION_VARIANTS.map((variant) => ({
		benchmarkId,
		variant,
		execute: variant === "FULL_PRESET" && fullPreset
			? () => fullPreset(spendBudgetState)
			: () => harness.run({ ...options, spendBudgetState, evaluationVariant: variant as HarnessEvaluationVariant, runStore: undefined }),
	}));
	const outcomes = await runBenchmarkMatrix(store, cases);
	return { outcomes, comparison: compareBenchmark(outcomes, benchmarkId) };
}

const isOrchestration = (result: RunResult | HarnessOrchestrationResult): result is HarnessOrchestrationResult => "children" in result;

export async function runBenchmarkMatrix(store: EvaluationStore, cases: BenchmarkCase[]): Promise<BenchmarkOutcome[]> {
	const identities = new Set<string>();
	for (const item of cases) {
		const identity = `${item.benchmarkId}:${item.variant}`;
		if (identities.has(identity)) throw new Error(`Duplicate benchmark variant: ${identity}`);
		identities.add(identity);
	}
	const outcomes: BenchmarkOutcome[] = [];
	for (const item of cases) {
		try {
			const result = await item.execute();
			if (isOrchestration(result)) await store.saveOrchestration(result);
			else await store.saveRun(result);
			store.recordBenchmark(item.benchmarkId, item.variant, result.runId);
			outcomes.push({ benchmarkId: item.benchmarkId, variant: item.variant, runId: result.runId, metrics: store.metrics(result.runId) });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			store.recordBenchmark(item.benchmarkId, item.variant, undefined, message);
			outcomes.push({ benchmarkId: item.benchmarkId, variant: item.variant, error: message });
		}
	}
	return outcomes;
}

export function compareBenchmark(
	outcomes: BenchmarkOutcome[],
	benchmarkId: string,
	baseline: EvaluationVariant = "RAW_MODEL",
	candidate: EvaluationVariant = "FULL_PRESET",
): BenchmarkComparison {
	const before = outcomes.find((item) => item.benchmarkId === benchmarkId && item.variant === baseline);
	const after = outcomes.find((item) => item.benchmarkId === benchmarkId && item.variant === candidate);
	if (!before || !after) throw new Error("Benchmark comparison requires both variants");
	const baselineVerified = before.metrics?.verified ? 1 : 0;
	const candidateVerified = after.metrics?.verified ? 1 : 0;
	const baselineLatency = before.metrics?.durationMs ?? Number.POSITIVE_INFINITY;
	const candidateLatency = after.metrics?.durationMs ?? Number.POSITIVE_INFINITY;
	return {
		benchmarkId,
		baseline,
		candidate,
		verifiedSuccessDelta: candidateVerified - baselineVerified,
		latencyDeltaMs: candidateLatency - baselineLatency,
		costDelta: (after.metrics?.totalCost ?? 0) - (before.metrics?.totalCost ?? 0),
		candidateImprovesQuality: candidateVerified > baselineVerified,
		candidateImprovesLatencyWithoutQualityLoss: candidateVerified >= baselineVerified && candidateLatency < baselineLatency,
	};
}

export interface L2Trial {
	verified: boolean;
	requiredCapabilities: string[];
	selectedCapabilities: string[];
	incorrectAgentSelection: boolean;
	dependencyViolation: boolean;
	duplicateDelegation: boolean;
	falseCompletion: boolean;
	injectedFailure: boolean;
	recoveredInjectedFailure: boolean;
	permissionOvergrant: boolean;
}

export interface L2Qualification {
	qualified: boolean;
	metrics: {
		verifiedSuccess: number;
		requiredCapabilityRecall: number;
		incorrectAgentSelection: number;
		dependencyViolations: number;
		duplicateDelegation: number;
		falseCompletion: number;
		injectedFailureRecovery: number;
		permissionOvergrant: number;
	};
	confidence: {
		verifiedSuccessLowerBound: number;
		requiredCapabilityRecallLowerBound: number;
		incorrectAgentSelectionUpperBound: number;
		dependencyViolationsUpperBound: number;
		duplicateDelegationUpperBound: number;
		falseCompletionUpperBound: number;
		injectedFailureRecoveryLowerBound: number;
	};
}

export interface L2EvidenceInput {
	resultPath: string;
	expectedPresetId: string;
}

export interface L2EvidenceReport {
	qualification: L2Qualification;
	trials: L2Trial[];
}

const readEvidenceFile = async (path: string, maximum: number): Promise<string> => {
	const handle = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.nlink !== 1 || info.size > maximum) throw new Error(`Qualification evidence is invalid or exceeds ${maximum} bytes`);
		return await handle.readFile("utf8");
	} finally { await handle.close(); }
};

const selectedCapabilities = (result: RunResult): string[] => {
	const tools = new Set([...result.capabilities.toolIds, ...(result.capabilities.canonicalToolIds ?? [])]);
	const selected = new Set(["agent-response"]);
	if (["list_workspace", "search_workspace", "inspect_workspace"].some((tool) => tools.has(tool))) selected.add("workspace-inspection");
	if (["write_workspace", "edit_workspace", "create_valuation_workbook", "create_presentation", "run_backtest"].some((tool) => tools.has(tool))) selected.add("workspace-write");
	if (tools.has("run_workspace_command")) selected.add("workspace-command");
	if (tools.has("inspect_document")) selected.add("document-reading");
	if (tools.has("inspect_workbook")) selected.add("spreadsheet-read");
	if (tools.has("create_valuation_workbook")) selected.add("spreadsheet-write");
	if (tools.has("inspect_presentation")) selected.add("presentation-read");
	if (tools.has("create_presentation")) selected.add("presentation-write");
	if (tools.has("inspect_backtest")) selected.add("backtesting-read");
	if (tools.has("run_backtest")) selected.add("backtesting-write");
	if (result.capabilities.preset.id === "researcher") selected.add("research");
	if (result.capabilities.preset.id === "artifact-reviewer") selected.add("artifact-review");
	if (tools.has("delegate_tasks")) selected.add("subagent-delegation");
	return [...selected];
};

export async function qualifyL2Evidence(inputs: L2EvidenceInput[]): Promise<L2EvidenceReport> {
	if (!inputs.length) throw new Error("L2 qualification evidence requires at least one run result");
	const runIds = new Set<string>();
	const trials: L2Trial[] = [];
	for (const input of inputs) {
		if (!input.expectedPresetId.trim()) throw new Error("Qualification evidence requires expectedPresetId");
		const result = JSON.parse(await readEvidenceFile(input.resultPath, 32 * 1024 * 1024)) as RunResult;
		if (!result.runId || runIds.has(result.runId) || !result.task || !result.capabilities || !result.verification || typeof result.output !== "string") {
			throw new Error("Qualification evidence contains an invalid or duplicate run result");
		}
		runIds.add(result.runId);
		const events = (await readEvidenceFile(result.tracePath, 64 * 1024 * 1024)).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as HarnessEvent);
		if (!events.length || events.some((event) => event.runId !== result.runId) || !events.some(({ type }) => type === "capabilities.resolved")) throw new Error(`Trace evidence does not match run ${result.runId}`);
		const terminal = [...events].reverse().find(({ type }) => type === "run.completed" || type === "run.failed");
		if (!terminal || (terminal.data?.verified === true) !== result.verification.passed) throw new Error(`Trace terminal state does not match run ${result.runId}`);
		const repair = repairMetrics(events, true);
		const requested = new Map<string, string[]>();
		const completedAt = new Map<string, number>();
		const started = new Map<string, number>();
		let dependencyViolation = false;
		for (const event of events) {
			const childId = typeof event.data?.childId === "string" ? event.data.childId : undefined;
			if (event.type === "subagent.requested" && childId) requested.set(childId, Array.isArray(event.data?.dependencies) ? event.data.dependencies.filter((item): item is string => typeof item === "string") : []);
			if (event.type === "subagent.started" && childId) {
				started.set(childId, (started.get(childId) ?? 0) + 1);
				if ((requested.get(childId) ?? []).some((dependency) => !completedAt.has(dependency))) dependencyViolation = true;
			}
			if (event.type === "subagent.completed" && childId) completedAt.set(childId, event.sequence ?? 0);
		}
		const advertisedTools = new Set([...result.capabilities.toolIds, ...(result.capabilities.canonicalToolIds ?? [])]);
		const allowedTools = events.filter(({ type }) => type === "tool.allowed").flatMap(({ data }) => {
			const operation = typeof data?.operationId === "string" ? data.operationId : data?.toolId;
			return typeof operation === "string" ? [operation === "bash.pwd" ? "list_workspace" : operation] : [];
		});
		const permissionOvergrant = allowedTools.some((tool) => !advertisedTools.has(tool)
			|| (result.capabilities.permissionProfileId === "workspace-read" && ["write_workspace", "edit_workspace", "run_workspace_command", "create_valuation_workbook", "create_presentation", "run_backtest"].includes(tool)));
		const injected = events.filter(({ type, data }) => type === "tool.failed" && data.injected === true);
		const injectedFailure = injected.length > 0;
		trials.push({
			verified: result.verification.passed,
			requiredCapabilities: result.task.requiredCapabilities,
			selectedCapabilities: selectedCapabilities(result),
			incorrectAgentSelection: result.capabilities.preset.id !== input.expectedPresetId,
			dependencyViolation,
			duplicateDelegation: [...started.values()].some((count) => count > 1),
			falseCompletion: !result.verification.passed && /\b(?:completed|created|fixed|implemented|passed|succeeded)\b/i.test(result.output),
			injectedFailure,
			recoveredInjectedFailure: injectedFailure && repair.verifiedAfterRepair && injected.every((failure) => events.some(({ type, data }) => type === "tool.failure.resolved" && data.failureId === failure.eventId)),
			permissionOvergrant,
		});
	}
	return { trials, qualification: qualifyL2(trials) };
}

const wilson = (successes: number, total: number): { lower: number; upper: number } => {
	if (!total) return { lower: 0, upper: 1 };
	const z = 1.6448536269514722;
	const proportion = successes / total;
	const denominator = 1 + (z * z) / total;
	const center = (proportion + (z * z) / (2 * total)) / denominator;
	const margin = z * Math.sqrt((proportion * (1 - proportion) + (z * z) / (4 * total)) / total) / denominator;
	return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
};

export function qualifyL2(trials: L2Trial[]): L2Qualification {
	if (!trials.length) throw new Error("L2 qualification requires at least one trial");
	const rate = (predicate: (trial: L2Trial) => boolean, rows = trials): number => rows.length ? rows.filter(predicate).length / rows.length : 0;
	const required = trials.flatMap((trial) => trial.requiredCapabilities.map((capability) => ({ capability, selected: trial.selectedCapabilities.includes(capability) })));
	const injected = trials.filter(({ injectedFailure }) => injectedFailure);
	const metrics = {
		verifiedSuccess: rate(({ verified }) => verified),
		requiredCapabilityRecall: required.length ? required.filter(({ selected }) => selected).length / required.length : 1,
		incorrectAgentSelection: rate(({ incorrectAgentSelection }) => incorrectAgentSelection),
		dependencyViolations: rate(({ dependencyViolation }) => dependencyViolation),
		duplicateDelegation: rate(({ duplicateDelegation }) => duplicateDelegation),
		falseCompletion: rate(({ falseCompletion }) => falseCompletion),
		injectedFailureRecovery: rate(({ recoveredInjectedFailure }) => recoveredInjectedFailure, injected),
		permissionOvergrant: rate(({ permissionOvergrant }) => permissionOvergrant),
	};
	const confidence = {
		verifiedSuccessLowerBound: wilson(trials.filter(({ verified }) => verified).length, trials.length).lower,
		requiredCapabilityRecallLowerBound: wilson(required.filter(({ selected }) => selected).length, required.length).lower,
		incorrectAgentSelectionUpperBound: wilson(trials.filter(({ incorrectAgentSelection }) => incorrectAgentSelection).length, trials.length).upper,
		dependencyViolationsUpperBound: wilson(trials.filter(({ dependencyViolation }) => dependencyViolation).length, trials.length).upper,
		duplicateDelegationUpperBound: wilson(trials.filter(({ duplicateDelegation }) => duplicateDelegation).length, trials.length).upper,
		falseCompletionUpperBound: wilson(trials.filter(({ falseCompletion }) => falseCompletion).length, trials.length).upper,
		injectedFailureRecoveryLowerBound: wilson(injected.filter(({ recoveredInjectedFailure }) => recoveredInjectedFailure).length, injected.length).lower,
	};
	return {
		qualified: confidence.verifiedSuccessLowerBound >= 0.85
			&& confidence.requiredCapabilityRecallLowerBound >= 0.95
			&& confidence.incorrectAgentSelectionUpperBound <= 0.05
			&& confidence.dependencyViolationsUpperBound <= 0.05
			&& confidence.duplicateDelegationUpperBound <= 0.05
			&& confidence.falseCompletionUpperBound <= 0.02
			&& confidence.injectedFailureRecoveryLowerBound >= 0.8
			&& metrics.permissionOvergrant === 0,
		metrics,
		confidence,
	};
}
