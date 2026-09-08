import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createPresentation,
	runBacktest,
	verifyBacktest,
	verifyPresentation,
} from "../packages/artifacts/src/index.ts";
import { createHarness } from "../packages/runtime/src/index.ts";
import { compileTask } from "../packages/task-compiler/src/index.ts";
import { verifyArtifacts } from "../packages/verifiers/src/index.ts";

const reviewReport = { id: "review", type: "json" as const, content: JSON.stringify({ kind: "review", verdict: "pass", defects: [] }) };

test("presentation worker creates a rendered, sourced, collision-free deck", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "codetonomy-presentation-"));
	const inspection = await createPresentation(workspace, {
		title: "Polar Co Investment Review",
		subtitle: "Evidence-led summary",
		outputPath: "output/review.pptx",
		slides: [
			{ role: "title", title: "Polar Co Investment Review", source: "Annual report 2025" },
			{
				role: "content",
				title: "Revenue trend",
				bullets: ["Revenue expanded across the review period", "Margins remained resilient"],
				chart: {
					title: "Revenue",
					categories: ["2023", "2024", "2025"],
					series: [{ name: "Revenue", values: [100, 112, 126] }],
					source: "Historical financial CSV",
				},
			},
			{ role: "summary", title: "Investment summary", bullets: ["Growth is positive", "Validate assumptions before use"], source: "Codetonomy analysis" },
			{ role: "sources", title: "Sources", bullets: ["Annual report 2025", "Historical financial CSV"] },
		],
	});
	assert.equal(inspection.slides.length, 4);
	const verification = await verifyPresentation(workspace, "output/review.pptx", { timeoutMs: 120_000 });
	assert.equal(verification.passed, true, JSON.stringify(verification.checks));
	const review = await verifyArtifacts(compileTask({ objective: "Review the presentation", files: [join(workspace, "output/review.pptx")] }), [reviewReport], workspace);
	assert.equal(review.passed, true, JSON.stringify(review.checks));
});

test("backtesting worker separates signals from execution and reproduces its ledger", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "codetonomy-backtest-"));
	const rows = ["date,open,close"];
	for (let index = 0; index < 80; index++) {
		const day = new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10);
		const price = 100 + index * 0.25 + Math.sin(index / 4) * 3;
		rows.push(`${day},${price.toFixed(4)},${(price + Math.sin(index / 3)).toFixed(4)}`);
	}
	await writeFile(join(workspace, "prices.csv"), `${rows.join("\n")}\n`, "utf8");
	const inspection = await runBacktest(workspace, {
		dataPath: "prices.csv",
		outputPath: "output/backtest.json",
		shortWindow: 5,
		longWindow: 15,
		trainFraction: 0.7,
		commissionBps: 5,
		initialCapital: 100_000,
	});
	assert.equal(inspection.rows, 80);
	const verification = await verifyBacktest(workspace, "output/backtest.json");
	assert.equal(verification.passed, true, JSON.stringify(verification.checks));
	const review = await verifyArtifacts(compileTask({ objective: "Review the backtest", files: [join(workspace, "output/backtest.json")] }), [reviewReport], workspace);
	assert.equal(review.passed, true, JSON.stringify(review.checks));
});

test("presentation and backtesting presets reach their workers through the permission gate", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "codetonomy-artifact-agents-"));
	const presentation = await createHarness().run({
		workspaceRoot: workspace,
		objective: "Create a presentation at output/agent-deck.pptx",
		approve: async () => true,
	});
	assert.equal(presentation.capabilities.preset.id, "presentation-agent");
	assert.equal(presentation.verification.passed, true, JSON.stringify(presentation.verification.checks));
	assert.ok(presentation.artifacts.some(({ path }) => path?.endsWith("agent-deck.pptx")));

	const rows = ["date,open,close"];
	for (let index = 0; index < 50; index++) {
		const day = new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(0, 10);
		rows.push(`${day},${100 + index},${101 + index}`);
	}
	await writeFile(join(workspace, "prices.csv"), `${rows.join("\n")}\n`, "utf8");
	const backtest = await createHarness().run({
		workspaceRoot: workspace,
		objective: "Run a backtest and create output/agent-backtest.json",
		files: [join(workspace, "prices.csv")],
		approve: async () => true,
	});
	assert.equal(backtest.capabilities.preset.id, "backtesting-agent");
	assert.equal(backtest.verification.passed, true, JSON.stringify(backtest.verification.checks));
	assert.ok(backtest.artifacts.some(({ path }) => path?.endsWith("agent-backtest.json")));
});
