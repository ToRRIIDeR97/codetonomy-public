import { createHash, randomUUID } from "node:crypto";
import { extname, resolve } from "node:path";
import type { AcceptanceCriterion, RiskClass, TaskInput, TaskSpecification } from "@agent-harness/contracts";

export interface CompileTaskInput {
	objective: string;
	files?: string[];
	riskClass?: RiskClass;
	workspaceRoot?: string;
}

const artifactTypeByExtension: Record<string, string> = {
	".csv": "spreadsheet",
	".json": "json",
	".pdf": "document",
	".pptx": "presentation",
	".xlsx": "spreadsheet",
};

const WRITE_INTENT = /\b(add|build|change|create|delete|develop|edit|fix|generate|implement|make|modify|move|patch|refactor|remove|rename|update|write)\b/;
const WRITE_NEGATION = /\b(?:do not|don't|dont|never|no need to|not to|without)\b/;
const hasWriteIntent = (objective: string): boolean => objective
	.split(/(?:[.!?;,\n]+|\b(?:but|however|instead|then|now)\b)/)
	.some((clause) => WRITE_INTENT.test(clause) && !WRITE_NEGATION.test(clause.slice(0, clause.search(WRITE_INTENT))));

// Deliberately limited to explicit file actions and known command forms. Complex
// acceptance language is left unverified rather than inferred from tool success.
const COMMAND = /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|tests|lint|build|check|checks|typecheck|type-check)|(?:cargo|go|dotnet|mvn|gradle|swift)\s+(?:test|check|build|verify)|(?:python(?:3)?)\s+-m\s+(?:pytest|unittest)|pytest|vitest|jest|mocha|ava)\b/gi;
export function compileObligations(objective: string, workspaceRoot: string): { criteria: AcceptanceCriterion[]; prohibitions: NonNullable<TaskSpecification["prohibitions"]> } {
	const criteria: AcceptanceCriterion[] = [];
	const prohibitions: NonNullable<TaskSpecification["prohibitions"]> = [];
	for (const clause of objective.split(/(?:[;!\n]+|\.(?:\s|$)|\b(?:but|however|then)\b|\band (?=(?:read|inspect|write|create|update|edit|run|check|verify)\b))/i)) {
		const commandNegative = (index: number) => WRITE_NEGATION.test(clause.slice(0, index).toLowerCase());
		const conditional = /\b(?:if|unless|when|should|could|might|may|consider)\b/i.test(clause);
		for (const match of clause.matchAll(COMMAND)) {
			const command = match[0].trim().split(/\s+/);
			if (commandNegative(match.index)) prohibitions.push({ action: "command", command });
			else if (!conditional) criteria.push({ id: `command-${criteria.length}`, description: `Complete ${command.join(" ")} successfully`, required: true, action: "command", command, evidence: "zero-exit" });
		}
		const action = /\b(?:check|verify|determine)\b.*\b(?:exists?|absent|missing)\b/i.test(clause) ? "exists"
			: /\b(?:write|create|update|edit|modify|change|fix|patch)\b/i.test(clause) ? "write"
			: /\b(?:read|inspect|review|summarize)\b/i.test(clause) ? "read" : undefined;
		if (!action || conditional) continue;
		const actionIndex = clause.search(/\b(?:check|verify|determine|write|create|update|edit|modify|change|fix|patch|read|inspect|review|summarize)\b/i);
		const negative = WRITE_NEGATION.test(clause.slice(0, actionIndex).toLowerCase());
		for (const match of clause.matchAll(/(?:`([^`]+)`|(?<![\w./-])((?:\/|\.{1,2}\/)?(?:[\w@.-]+\/)*[\w@.-]+\.[a-zA-Z0-9]+)\b)/g)) {
			const file = match[1] ?? match[2]!;
			if (/\s/.test(file) || !file.includes(".")) continue;
			const target = resolve(workspaceRoot, file.replace(/^\/workspace\//, ""));
			if (negative) { if (action === "write") prohibitions.push({ action, target }); continue; }
			criteria.push({ id: `file-${criteria.length}`, description: `${action} ${file}`, required: true, action, target, evidence: action === "write" ? "changed-state" : action === "read" ? "read-receipt" : "file-state" });
		}
	}
	return { criteria, prohibitions };
}

export function compileTask(input: CompileTaskInput): TaskSpecification {
	const objective = input.objective.trim();
	if (!objective) throw new Error("Task objective cannot be empty");

	const obligations = compileObligations(objective, input.workspaceRoot ?? process.cwd());
	const inputs: TaskInput[] = (input.files ?? []).map((file) => ({
		id: createHash("sha256").update(resolve(input.workspaceRoot ?? process.cwd(), file)).digest("hex").slice(0, 16),
		kind: "file",
		value: resolve(input.workspaceRoot ?? process.cwd(), file),
	}));
	const extensions = inputs.map(({ value }) => extname(value).toLowerCase());
	const lower = objective.toLowerCase();
	const writeIntent = hasWriteIntent(lower);
	const genericCommand = objective.split(/[;.!?\n]/).some((clause) => !WRITE_NEGATION.test(clause.toLowerCase()) && !/\b(if|unless|when|could|should|might)\b/i.test(clause) && /\b(?:execute|lint|typecheck|type-check|compile)\b|\brun (?:the )?(?:tests?|build|checks?|suite)\b/i.test(clause));
	const commandIntent = genericCommand || obligations.criteria.some(({ action }) => action === "command");
	if (genericCommand && !obligations.criteria.some(({ action }) => action === "command")) obligations.criteria.push({ id: "unspecified-command", action: "unsupported", required: true, description: "The requested command is not explicit enough for deterministic verification" });
	const spreadsheetOutput = /\b(dcf|valuation (?:model|workbook)|workbook|spreadsheet|xlsx)\b/.test(lower) && writeIntent;
	const presentationOutput = /\b(deck|presentation|powerpoint|pptx|slides?)\b/.test(lower) && writeIntent;
	const backtestingOutput = /\b(backtest|backtesting|trading strategy)\b/.test(lower) && (writeIntent || /\b(run|execute)\b/.test(lower));
	const mutationIntent = writeIntent || backtestingOutput;
	const researchIntent = /\b(investigate|research|reconcile sources?)\b/.test(lower);
	const delegationIntent = /\b(?:delegate|delegation|subagents?|sub-agents?|child agents?|parallel agents?|orchestrate|orchestration)\b/.test(lower);
	const artifactReview = /\b(audit|review|verify|validate|inspect)\b/.test(lower)
		&& (extensions.includes(".xlsx") || extensions.includes(".pptx") || (extensions.includes(".json") && /\bbacktest/.test(lower)))
		&& !mutationIntent;
	const artifactTypes = [...new Set([
		...extensions.map((extension) => artifactTypeByExtension[extension]).filter(Boolean),
		...(spreadsheetOutput ? ["spreadsheet"] : []),
		...(presentationOutput ? ["presentation"] : []),
		...(backtestingOutput ? ["backtest"] : []),
	])] as string[];
	const workspaceIntent = mutationIntent
		|| /\b(codebase|repository|repo|workspace|project files?|source tree|code files?|implementation|existing code|tests?|package\.json|readme)\b/.test(lower)
		|| /\b(scan|inspect|search|grep|find|debug|run tests?)\b/.test(lower);
	const requiredCapabilities = [
		"agent-response",
		...(inputs.length || workspaceIntent ? ["workspace-inspection"] : []),
		...(mutationIntent ? ["workspace-write"] : []),
		...(commandIntent ? ["workspace-command"] : []),
		...(extensions.includes(".pdf") ? ["document-reading"] : []),
		...(extensions.includes(".xlsx") || (extensions.includes(".csv") && !backtestingOutput) ? ["spreadsheet-read"] : []),
		...(spreadsheetOutput ? ["spreadsheet-write"] : []),
		...(extensions.includes(".pptx") ? ["presentation-read"] : []),
		...(presentationOutput ? ["presentation-write"] : []),
		...(backtestingOutput || (extensions.includes(".json") && /\bbacktest/.test(lower)) ? ["backtesting-read"] : []),
		...(backtestingOutput ? ["backtesting-write"] : []),
		...(researchIntent ? ["research"] : []),
		...(delegationIntent ? ["subagent-delegation"] : []),
		...(artifactReview ? ["artifact-review"] : []),
	];

	return {
		id: randomUUID(),
		objective,
		inputs,
		artifactTypes,
		domains: lower.includes("financial") || lower.includes("valuation") ? ["finance"] : [],
		requiredCapabilities: [...new Set(requiredCapabilities)],
		prohibitions: obligations.prohibitions,
		acceptanceCriteria: [
			...obligations.criteria,
			{ id: "non-empty-output", description: "The agent returns a non-empty answer", required: true },
			{ id: "runtime-complete", description: "The runtime completes without a provider or tool error", required: true },
			...(inputs.length || workspaceIntent
				? [{ id: "workspace-evidence", description: "The agent inspects workspace evidence before answering", required: true }]
				: []),
			...(mutationIntent
				? [{ id: "workspace-change", description: "The agent completes an approved workspace change", required: true }]
				: []),
			...(commandIntent
				? [{ id: "command-success", description: "The agent completes a sandboxed command successfully", required: true }]
				: []),
			...(spreadsheetOutput
				? [{ id: "workbook-valid", description: "The generated workbook passes deterministic structural and formula checks", required: true }]
				: []),
			...(presentationOutput
				? [{ id: "presentation-valid", description: "The generated presentation passes structural, layout, source, and rendered-slide checks", required: true }]
				: []),
			...(backtestingOutput
				? [{ id: "backtest-valid", description: "The backtest passes data, timing, ledger, metric, split, and reproducibility checks", required: true }]
				: []),
			...(researchIntent
				? [{ id: "sourced-research", description: "Research is recorded as sourced structured claims", required: true }]
				: []),
			...(artifactReview
				? [{ id: "independent-review", description: "A read-only structured review report is recorded", required: true }]
				: []),
		],
		riskClass: input.riskClass ?? (mutationIntent || commandIntent ? "medium" : "low"),
	};
}
