import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { OcrService } from "../packages/contracts/src/index.js";
import { EVALUATION_VARIANTS, EvaluationStore, runValuationBenchmark } from "../packages/evals/src/index.js";

const sse = (model: string, response: { tool?: { id: string; name: string; arguments: unknown }; text?: string }): Response => {
	const base = { id: response.tool?.id ?? "answer", object: "chat.completion.chunk", created: 1, model };
	const events = response.tool
		? [
			{ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: response.tool.id, type: "function", function: { name: response.tool.name, arguments: JSON.stringify(response.tool.arguments) } }] }, finish_reason: null }] },
			{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
		]
		: [
			{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: response.text }, finish_reason: null }] },
			{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
		];
	return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
};

test("scanned-report valuation slice ingests OCR evidence, produces a workbook, and independently reviews it", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-vertical-slice-"));
	await writeFile(join(root, "annual-report.pdf"), "%PDF-scanned-fixture", "utf8");
	await writeFile(join(root, "history.csv"), "year,revenue,ebitda,freeCashFlow\n2024,100,20,12\n2025,110,24,15\n", "utf8");
	for (const [name, body] of [
		["pdfinfo.mjs", "process.stdout.write('Pages: 1\\n');\n"],
		["pdftotext.mjs", "process.stdout.write('   ');\n"],
	] as const) {
		await writeFile(join(root, name), body, "utf8");
	}
	let ocrCalls = 0;
	const ocr: OcrService = {
		async parse(request) {
			ocrCalls++;
			return {
				documentId: "ocr-annual-report",
				assetVersionId: "worker-version",
				parser: { id: "unlimited-ocr", version: "1", configurationHash: request.idempotencyKey },
				pages: [{ pageNumber: 1, width: 1000, height: 1400, blocks: [{
					blockId: "ocr-block-1",
					type: "paragraph",
					readingOrder: 0,
					text: "Polar Co reported 2025 revenue of 110, EBITDA of 24, and free cash flow of 15.",
					confidence: 0.96,
				}]}],
			};
		},
	};
	const counts = new Map<string, number>();
	const providerFetch: typeof fetch = async (_input, init) => {
		const body = JSON.parse(String(init?.body)) as { messages?: unknown[] };
		const messages = JSON.stringify(body.messages ?? []);
		if (messages.includes("evaluation protocol")) return sse("slice-model", { text: "I cannot create or verify the requested workbook without the full harness." });
		const stage = messages.includes("Independently review and verify") ? "review"
			: messages.includes("Create a formula-driven three-scenario") ? "workbook"
				: "research";
		const count = (counts.get(stage) ?? 0) + 1;
		counts.set(stage, count);
		if (stage === "research") return count === 1
			? sse("slice-model", { tool: { id: "research-artifact", name: "record_structured_artifact", arguments: {
				kind: "research",
				title: "Polar Co valuation evidence",
				summary: "Revenue and cash-flow evidence reconciled.",
				claims: [{ statement: "2025 revenue was 110 and free cash flow was 15.", source: "annual-report.pdf", page: 1, confidence: 0.96 }],
			} } })
			: sse("slice-model", { text: "Recorded sourced valuation research for Polar Co." });
		if (stage === "workbook") {
			if (count === 1) return sse("slice-model", { tool: { id: "list-workspace", name: "list_workspace", arguments: { path: ".", depth: 1 } } });
			if (count === 2) return sse("slice-model", { tool: { id: "create-workbook", name: "create_valuation_workbook", arguments: {
				company: "Polar Co",
				outputPath: "output/valuation.xlsx",
				historical: [
					{ year: 2024, revenue: 100, ebitda: 20, freeCashFlow: 12, source: "history.csv" },
					{ year: 2025, revenue: 110, ebitda: 24, freeCashFlow: 15, source: "annual-report.pdf page 1" },
				],
				scenarios: [
					{ name: "Bear", revenueGrowth: 0.02, ebitdaMargin: 0.18 },
					{ name: "Base", revenueGrowth: 0.07, ebitdaMargin: 0.22 },
					{ name: "Bull", revenueGrowth: 0.12, ebitdaMargin: 0.26 },
				],
				discountRate: 0.1,
				terminalGrowthRate: 0.025,
				taxRate: 0.21,
				sources: [{ label: "Scanned annual report", source: "annual-report.pdf", page: 1 }, { label: "Historical CSV", source: "history.csv" }],
			} } });
			return sse("slice-model", { text: "Created and verified the formula-driven valuation workbook." });
		}
		if (count === 1) return sse("slice-model", { tool: { id: "review-list", name: "list_workspace", arguments: { path: "output", depth: 1 } } });
		if (count === 2) return sse("slice-model", { tool: { id: "inspect-workbook", name: "inspect_workbook", arguments: { path: "output/valuation.xlsx" } } });
		if (count === 3) return sse("slice-model", { tool: { id: "review-artifact", name: "record_structured_artifact", arguments: {
			kind: "review",
			verdict: "pass",
			summary: "Workbook structure, formulas, scenarios, and source notes passed review.",
			defects: [],
		} } });
		return sse("slice-model", { text: "Independent review passed with no structural defects." });
	};

	const evaluationStore = new EvaluationStore(join(root, ".harness", "evaluations.sqlite"));
	t.after(() => evaluationStore.close());
	const result = await runValuationBenchmark({
		company: "Polar Co",
		workspaceRoot: root,
		annualReportPath: "annual-report.pdf",
		historicalCsvPath: "history.csv",
		outputPath: "output/valuation.xlsx",
		traceDirectory: join(root, ".harness", "runs"),
		provider: "slice-provider",
		modelId: "slice-model",
		providerConfiguration: { id: "slice-provider", name: "Slice Provider", kind: "openai-compatible", baseUrl: "https://provider.test/v1", apiKey: "test-key" },
		providerFetch,
		approve: async () => true,
		ocr,
		ocrModelRevision: "model-sha",
		ocrCodeRevision: "code-sha",
		documentOptions: { pdfinfoBinary: [process.execPath, join(root, "pdfinfo.mjs")], pdftotextBinary: [process.execPath, join(root, "pdftotext.mjs")] },
		evaluationStore,
	});
	assert.equal(ocrCalls, 1);
	assert.deepEqual(result.outcomes.map(({ variant }) => variant), [...EVALUATION_VARIANTS]);
	assert.ok(result.outcomes.slice(0, 5).every(({ error, metrics }) => Boolean(error) || !metrics?.verified));
	assert.equal(result.comparison.verifiedSuccessDelta, 1);
	assert.equal(result.fullPreset?.orchestration.verification.passed, true);
	assert.deepEqual(result.fullPreset?.orchestration.children.map(({ status }) => status), ["completed", "completed", "completed"]);
	assert.equal((await readFile(result.fullPreset!.workbookPath)).subarray(0, 2).toString(), "PK");
	assert.match(await readFile(result.fullPreset!.orchestration.tracePath, "utf8"), /"type":"subagent.completed"/);
	assert.ok(result.fullPreset?.assets.annualReport.assetId);
	assert.ok(result.fullPreset?.assets.historicalCsv.assetId);
	const stored = evaluationStore.listRuns();
	assert.equal(stored.length, 4);
	assert.ok(stored.some(({ kind, verified }) => kind === "orchestration" && verified));
	const metrics = evaluationStore.metrics(result.fullPreset!.orchestration.runId);
	assert.equal(metrics.verified, true);
	assert.ok(metrics.modelCalls >= 9);
	assert.ok(metrics.toolCalls >= 6);
	evaluationStore.addHumanReview(result.fullPreset!.orchestration.runId, { rating: 5, minutes: 0, notes: "fixture acceptance" });
});
