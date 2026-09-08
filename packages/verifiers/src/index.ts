import { verifyBacktest, verifyPresentation, verifyValuationWorkbook } from "@agent-harness/artifacts";
import type { RunArtifact, TaskSpecification, VerificationCheck, VerificationResult } from "@agent-harness/contracts";

export interface VerificationEvidence {
	task?: TaskSpecification;
	completedToolIds?: Iterable<string>;
	commandExitCodes?: Iterable<number | null>;
	commandRuns?: Iterable<{ argv: readonly string[]; exitCode: number | null }>;
	fileEvidence?: Iterable<{ target: string; action: "read" | "write" | "exists" | "delete"; callId: string; current: boolean }>;
	workspaceClaimCandidates?: WorkspaceClaimCandidate[];
}

export interface WorkspaceClaimCandidate {
	path: string;
	architecturalLayer: string;
	symbols: string[];
	minimum: number;
	maximum: number;
	unit: "tokens" | "results";
}

const REFUSAL = /\b(?:i (?:do not|don't|cannot|can't) (?:have|access)|no (?:file|filesystem|code|repository|workspace).{0,40}tools?|(?:unable|not able) to (?:access|inspect|scan|read)|please (?:provide|share).{0,80}(?:codebase|repository|files?))\b/is;
const WORKSPACE_TOOLS = new Set(["list_workspace", "search_workspace", "inspect_workspace", "inspect_document", "inspect_workbook", "inspect_presentation", "inspect_backtest"]);
const words = (value: string): Set<string> => new Set(value.toLowerCase().match(/[a-z0-9]+/g) ?? []);
const numberIn = (output: string, value: number): boolean => new RegExp(`(?<!\\d)${value}(?!\\d)`).test(output.replaceAll(/[,_]/g, ""));

export const commandMatches = (argv: readonly string[], expected: readonly string[], allowExtraArguments = false): boolean => {
	const normalize = (values: readonly string[]) => {
		const result = [...values];
		result[0] = (result[0]?.split(/[\\/]/).at(-1) ?? "");
		if (["npm", "pnpm", "yarn", "bun"].includes(result[0]!) && result[1] === "run") result.splice(1, 1);
		return result;
	};
	const actual = normalize(argv), wanted = normalize(expected);
	return (allowExtraArguments || actual.length === wanted.length) && wanted.every((value, index) => actual[index] === value);
};

const sourceClaimCheck = (output: string, task: TaskSpecification | undefined, candidates: WorkspaceClaimCandidate[]): VerificationCheck | undefined => {
	if (!task || !/\b(?:function|method|symbol)\b/i.test(task.objective) || !/\b(?:minimum|maximum|bounds?)\b/i.test(task.objective) || !candidates.length) return undefined;
	const objectiveWords = words(task.objective);
	const ranked = candidates.map((candidate, index) => ({
		candidate,
		index,
		score: [...words(`${candidate.architecturalLayer} ${candidate.symbols.join(" ")}`)].filter((word) => objectiveWords.has(word)).length,
	})).sort((left, right) => right.score - left.score || left.index - right.index);
	const expected = ranked[0]!.candidate;
	const normalizedOutput = output.toLowerCase();
	const symbolMatched = expected.symbols.some((symbol) => {
		const normalized = symbol.toLowerCase();
		return normalizedOutput.includes(normalized) || normalizedOutput.includes(normalized.split(".").at(-1) ?? normalized);
	});
	const passed = symbolMatched && normalizedOutput.includes(expected.path.toLowerCase())
		&& numberIn(output, expected.minimum) && numberIn(output, expected.maximum);
	return {
		id: "source-grounded-claim",
		passed,
		message: passed
			? `Claim matches ${expected.architecturalLayer} in ${expected.path}`
			: `The requested layer is ${expected.architecturalLayer}: cite ${expected.symbols.join(" or ")} in ${expected.path} with exact ${expected.unit} bounds [${expected.minimum}, ${expected.maximum}]. Distinguish it from the other retrieved layers.`,
	};
};

export function verifyOutput(output: string, runtimeError?: string, evidence: VerificationEvidence = {}): VerificationResult {
	const completedToolIds = new Set(evidence.completedToolIds ?? []);
	const commandRuns = [...(evidence.commandRuns ?? [])];
	const commands = evidence.task?.acceptanceCriteria.filter(({ action }) => action === "command") ?? [];
	const expectedCommand = commands[0]?.command;
	const commandSucceeded = commands.length > 0 && commands.every(({ command }) => command && commandRuns.some(({ argv, exitCode }) => exitCode === 0 && commandMatches(argv, command)));
	const files = [...(evidence.fileEvidence ?? [])];
	const obligationChecks: VerificationCheck[] = (evidence.task?.acceptanceCriteria ?? []).filter(({ action }) => action).map((criterion) => ({
		id: criterion.id,
		passed: criterion.action === "command"
			? Boolean(criterion.command && commandRuns.some(({ argv, exitCode }) => exitCode === 0 && commandMatches(argv, criterion.command!)))
			: files.some(({ target, action, current }) => target === criterion.target && action === criterion.action && current),
		message: `Required outcome: ${criterion.description}`,
	}));
	const sourceClaim = sourceClaimCheck(output, evidence.task, evidence.workspaceClaimCandidates ?? []);
	const checks: VerificationCheck[] = [
		{
			id: "non-empty-output",
			passed: output.trim().length > 0,
			message: output.trim() ? "Agent produced output" : "Agent output was empty",
		},
		{
			id: "runtime-complete",
			passed: !runtimeError,
			message: runtimeError ?? "Runtime completed without an error",
		},
		{
			id: "agent-completed-task",
			passed: !REFUSAL.test(output),
			message: REFUSAL.test(output) ? "Agent declined or claimed required access was unavailable" : "Agent did not refuse the task",
		},
		...(evidence.task?.requiredCapabilities.includes("workspace-inspection")
			? [{
				id: "workspace-evidence",
				passed: [...completedToolIds].some((id) => WORKSPACE_TOOLS.has(id)),
				message: [...completedToolIds].some((id) => WORKSPACE_TOOLS.has(id))
					? "Agent inspected workspace evidence"
					: "Agent answered a workspace task without inspecting workspace evidence",
			}]
			: []),
		...(evidence.task?.requiredCapabilities.includes("workspace-write")
			? [{
				id: "workspace-change",
				passed: files.some(({ action, current }) => (action === "write" || action === "delete") && current),
				message: files.some(({ action, current }) => (action === "write" || action === "delete") && current)
					? "Agent completed an approved workspace change"
					: "Agent did not complete the requested workspace change",
			}]
			: []),
		...(evidence.task?.requiredCapabilities.includes("workspace-command")
			? [{
				id: "command-success",
				passed: commandSucceeded,
				message: commandSucceeded
					? `Agent completed${expectedCommand ? ` ${expectedCommand.join(" ")}` : " a sandboxed command"} successfully`
					: `Agent did not complete${expectedCommand ? ` the requested ${expectedCommand.join(" ")}` : " a sandboxed command"} successfully`,
			}]
			: []),
		...obligationChecks,
		...(sourceClaim ? [sourceClaim] : []),
	];
	for (const criterion of evidence.task?.acceptanceCriteria ?? []) {
		if (criterion.required && !checks.some(({ id }) => id === criterion.id) && !["workbook-valid", "presentation-valid", "backtest-valid", "sourced-research", "independent-review"].includes(criterion.id)) checks.push({ id: criterion.id, passed: false, message: `Unsupported required criterion: ${criterion.description}` });
	}
	return { passed: checks.every(({ passed }) => passed), checks };
}

export async function verifyArtifacts(
	task: TaskSpecification,
	artifacts: RunArtifact[],
	workspaceRoot: string,
	signal?: AbortSignal,
): Promise<VerificationResult> {
	const checks: VerificationCheck[] = [];
	const jsonArtifacts = artifacts.flatMap(({ type, content }) => {
		if (type !== "json") return [];
		try {
			const parsed: unknown = JSON.parse(content);
			return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? [parsed as Record<string, unknown>] : [];
		} catch {
			return [];
		}
	});
	if (task.requiredCapabilities.includes("research")) {
		const research = jsonArtifacts.find(({ kind }) => kind === "research");
		const claims = Array.isArray(research?.claims) ? research.claims : [];
		const sourced = claims.length > 0 && claims.every((claim) => {
			if (!claim || typeof claim !== "object") return false;
			const item = claim as Record<string, unknown>;
			return typeof item.statement === "string" && item.statement.trim() && typeof item.source === "string" && item.source.trim();
		});
		checks.push(
			{ id: "research-artifact", passed: Boolean(research), message: research ? "Structured research artifact recorded" : "Structured research artifact is missing" },
			{ id: "citation-support", passed: sourced, message: sourced ? "Every research claim includes source provenance" : "Research claims are missing source provenance" },
		);
	}

	const reviewing = task.requiredCapabilities.includes("artifact-review");
	const producingWorkbook = task.requiredCapabilities.includes("spreadsheet-write");
	if ((reviewing && task.requiredCapabilities.includes("spreadsheet-read")) || producingWorkbook) {
		const workbookPath = producingWorkbook
			? artifacts.find(({ type, path }) => type === "file" && path?.toLowerCase().endsWith(".xlsx"))?.path
			: task.inputs.find(({ value }) => value.toLowerCase().endsWith(".xlsx"))?.value;
		if (!workbookPath) {
			checks.push({ id: producingWorkbook ? "workbook-created" : "workbook-open", passed: false, message: "No .xlsx workbook is available for verification" });
		} else {
			try {
				const verification = await verifyValuationWorkbook(workspaceRoot, workbookPath, undefined, signal);
				if (producingWorkbook) checks.push({ id: "workbook-created", passed: true, message: `Workbook artifact created at ${verification.inspection.path}` });
				checks.push(...verification.checks);
			} catch (error) {
				checks.push({ id: "workbook-open", passed: false, message: error instanceof Error ? error.message : String(error) });
			}
		}
	}

	const producingPresentation = task.requiredCapabilities.includes("presentation-write");
	const readingPresentation = task.requiredCapabilities.includes("presentation-read");
	if (producingPresentation || readingPresentation) {
		const presentationPath = producingPresentation
			? artifacts.find(({ type, path }) => type === "file" && path?.toLowerCase().endsWith(".pptx"))?.path
			: task.inputs.find(({ value }) => value.toLowerCase().endsWith(".pptx"))?.value;
		if (!presentationPath) {
			checks.push({ id: producingPresentation ? "presentation-created" : "presentation-open", passed: false, message: "No .pptx presentation is available for verification" });
		} else {
			try {
				const verification = await verifyPresentation(workspaceRoot, presentationPath, undefined, signal);
				if (producingPresentation) checks.push({ id: "presentation-created", passed: true, message: `Presentation artifact created at ${verification.inspection.path}` });
				checks.push(...verification.checks);
			} catch (error) {
				checks.push({ id: "presentation-open", passed: false, message: error instanceof Error ? error.message : String(error) });
			}
		}
	}

	const producingBacktest = task.requiredCapabilities.includes("backtesting-write");
	const readingBacktest = task.requiredCapabilities.includes("backtesting-read");
	if (producingBacktest || readingBacktest) {
		const backtestPath = producingBacktest
			? artifacts.find(({ type, path }) => type === "file" && path?.toLowerCase().endsWith(".json"))?.path
			: task.inputs.find(({ value }) => value.toLowerCase().endsWith(".json"))?.value;
		if (!backtestPath) {
			checks.push({ id: "data-schema-check", passed: false, message: "No backtest JSON artifact is available for verification" });
		} else {
			try {
				checks.push(...(await verifyBacktest(workspaceRoot, backtestPath, undefined, signal)).checks);
			} catch (error) {
				checks.push({ id: "data-schema-check", passed: false, message: error instanceof Error ? error.message : String(error) });
			}
		}
	}
	if (reviewing) {
		const review = jsonArtifacts.find(({ kind }) => kind === "review");
		const defects = Array.isArray(review?.defects) ? review.defects : undefined;
		const valid = Boolean(review && (review.verdict === "pass" || review.verdict === "fail") && defects
			&& defects.every((defect) => defect && typeof defect === "object"
				&& typeof (defect as Record<string, unknown>).severity === "string"
				&& typeof (defect as Record<string, unknown>).location === "string"
				&& typeof (defect as Record<string, unknown>).message === "string"));
		checks.push({ id: "review-report", passed: valid, message: valid ? "Structured independent review report recorded" : "Structured independent review report is missing or invalid" });
	}
	return { passed: checks.every(({ passed }) => passed), checks };
}
