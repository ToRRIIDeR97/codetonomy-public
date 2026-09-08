import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { verifyValuationWorkbook } from "@agent-harness/artifacts";
import type { OcrService, VerificationCheck } from "@agent-harness/contracts";
import type { DocumentParseOptions } from "@agent-harness/document-ir";
import { LocalGraphMemory, type AssetVersionRecord } from "@agent-harness/memory-client";
import {
	runHarnessOrchestration,
	type HarnessOrchestrationOptions,
	type HarnessOrchestrationResult,
} from "@agent-harness/runtime";
import type { EvaluationStore } from "./store.js";
import { runTaskBenchmark, type TaskBenchmarkResult } from "./benchmark.js";
export {
	EvaluationStore,
	restoreEvaluationBackup,
	type EvaluationRestoreResult,
	type RunMetrics,
	type StoredBenchmarkReport,
	type StoredRunSummary,
} from "./store.js";
export { exportRunBundle, type RunExportResult } from "./export.js";
export {
	EVALUATION_VARIANTS,
	compareBenchmark,
	qualifyL2,
	qualifyL2Evidence,
	runBenchmarkMatrix,
	runTaskBenchmark,
	type BenchmarkCase,
	type BenchmarkComparison,
	type BenchmarkOutcome,
	type EvaluationVariant,
	type L2Qualification,
	type L2EvidenceInput,
	type L2EvidenceReport,
	type L2Trial,
	type TaskBenchmarkResult,
} from "./benchmark.js";

export interface ValuationVerticalSliceOptions extends Omit<HarnessOrchestrationOptions, "nodes" | "parentPermissionProfileId" | "synthesize" | "verifyFinal" | "onSubagentEvent"> {
	company: string;
	annualReportPath: string;
	historicalCsvPath: string;
	outputPath?: string;
	projectId?: string;
	memoryDatabasePath?: string;
	documentOptions?: Omit<DocumentParseOptions, "assetVersionId">;
	ocr?: OcrService;
	ocrModelRevision?: string;
	ocrCodeRevision?: string;
	onSubagentEvent?: HarnessOrchestrationOptions["onSubagentEvent"];
	evaluationStore?: EvaluationStore;
}

export interface ValuationVerticalSliceResult {
	orchestration: HarnessOrchestrationResult;
	assets: { annualReport: AssetVersionRecord; historicalCsv: AssetVersionRecord };
	workbookPath: string;
}

export interface ValuationBenchmarkResult extends TaskBenchmarkResult {
	fullPreset?: ValuationVerticalSliceResult;
}

export async function runValuationBenchmark(options: ValuationVerticalSliceOptions & { evaluationStore: EvaluationStore; benchmarkId?: string }): Promise<ValuationBenchmarkResult> {
	let fullPreset: ValuationVerticalSliceResult | undefined;
	const benchmarkId = options.benchmarkId ?? `valuation:${options.company.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 120) || "company"}:tools-${options.toolInterface ?? "structured"}`;
	const result = await runTaskBenchmark(options.evaluationStore, benchmarkId, {
		objective: `Research ${options.company} from the supplied annual report and historical CSV, create a formula-driven three-scenario valuation workbook at ${options.outputPath ?? "output/valuation.xlsx"}, and verify it.`,
		files: [options.annualReportPath, options.historicalCsvPath],
		workspaceRoot: options.workspaceRoot,
		traceDirectory: options.traceDirectory,
		provider: options.provider,
		modelId: options.modelId,
		providerConfiguration: options.providerConfiguration,
		providerFetch: options.providerFetch,
		permissionMode: options.permissionMode,
		toolInterface: options.toolInterface,
		approve: options.approve,
		signal: options.signal,
		maxCostUsd: options.maxCostUsd,
		maxTotalTokens: options.maxTotalTokens,
	}, async (spendBudgetState) => {
		fullPreset = await runValuationVerticalSlice({ ...options, spendBudgetState, evaluationStore: undefined });
		return fullPreset.orchestration;
	});
	return { ...result, ...(fullPreset ? { fullPreset } : {}) };
}

export async function runValuationVerticalSlice(options: ValuationVerticalSliceOptions): Promise<ValuationVerticalSliceResult> {
	const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
	const outputPath = options.outputPath ?? "output/valuation.xlsx";
	const memory = new LocalGraphMemory({
		workspaceRoot,
		projectId: options.projectId ?? `valuation-${randomUUID()}`,
		databasePath: resolve(workspaceRoot, options.memoryDatabasePath ?? ".harness/memory.sqlite"),
		documentOptions: {
			...options.documentOptions,
			...(options.ocr ? { ocr: options.ocr } : {}),
			...(options.ocrModelRevision ? { ocrModelRevision: options.ocrModelRevision } : {}),
			...(options.ocrCodeRevision ? { ocrCodeRevision: options.ocrCodeRevision } : {}),
		},
	});
	try {
		const annualReport = await memory.ingestFile(options.annualReportPath, options.signal);
		const historicalCsv = await memory.ingestFile(options.historicalCsvPath, options.signal);
		if (!memory.getChunkCount(annualReport.assetId)) throw new Error("Annual report produced no retrievable evidence; configure OCR for scanned pages");
		if (!memory.getChunkCount(historicalCsv.assetId)) throw new Error("Historical CSV produced no retrievable evidence");
		const {
			company,
			annualReportPath: _annualReportPath,
			historicalCsvPath: _historicalCsvPath,
			outputPath: _outputPath,
			projectId: _projectId,
			memoryDatabasePath: _memoryDatabasePath,
			documentOptions: _documentOptions,
			ocr: _ocr,
			ocrModelRevision: _ocrModelRevision,
			ocrCodeRevision: _ocrCodeRevision,
			onSubagentEvent,
			evaluationStore,
			...runOptions
		} = options;
		const orchestration = await runHarnessOrchestration({
			...runOptions,
			workspaceRoot,
			memoryBackend: memory,
			parentPermissionProfileId: "workspace-write",
			nodes: [
				{
					id: "research",
					objective: `Research ${company} for a valuation, reconcile the annual report and historical financial evidence, and record sourced claims.`,
					presetId: "researcher",
					permissionProfileId: "workspace-read",
				},
				{
					id: "workbook",
					objective: `Create a formula-driven three-scenario valuation workbook for ${company} at ${outputPath}, using the verified evidence and historical data with source notes.`,
					presetId: "spreadsheet-agent",
					permissionProfileId: "workspace-write",
					writePaths: [outputPath],
					dependencies: ["research"],
				},
				{
					id: "review",
					objective: "Independently review and verify the valuation workbook, inspect its formulas and required sheets, and record an exact structured verdict.",
					presetId: "artifact-reviewer",
					permissionProfileId: "workspace-read",
					dependencies: ["workbook"],
				},
			],
			onSubagentEvent,
			synthesize: async (children) => {
				const review = children.get("review");
				return review ? `${review.output}\n\nVerified workbook: ${outputPath}` : "No verified review was produced.";
			},
			verifyFinal: async (output, children) => {
				const checks: VerificationCheck[] = [
					{ id: "research-child", passed: children.has("research"), message: children.has("research") ? "Research was independently verified" : "Verified research is missing" },
					{ id: "workbook-child", passed: children.has("workbook"), message: children.has("workbook") ? "Workbook producer was independently verified" : "Verified workbook producer is missing" },
					{ id: "review-child", passed: children.has("review"), message: children.has("review") ? "Independent reviewer completed" : "Independent review is missing" },
					{ id: "final-output", passed: Boolean(output.trim()), message: output.trim() ? "Final reviewed output is present" : "Final reviewed output is empty" },
				];
				if (children.has("workbook")) {
					try {
						checks.push(...(await verifyValuationWorkbook(workspaceRoot, outputPath, undefined, options.signal)).checks);
					} catch (error) {
						checks.push({ id: "workbook-open", passed: false, message: error instanceof Error ? error.message : String(error) });
					}
				}
				return { passed: checks.every(({ passed }) => passed), checks };
			},
		});
		await evaluationStore?.saveOrchestration(orchestration);
		return { orchestration, assets: { annualReport, historicalCsv }, workbookPath: resolve(workspaceRoot, outputPath) };
	} finally {
		memory.close();
	}
}
