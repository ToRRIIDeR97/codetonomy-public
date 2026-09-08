import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { repairMetrics } from "../packages/evals/src/repair.ts";
import type { HarnessEvent } from "../packages/contracts/src/index.ts";

const quantile = (values: number[], p: number) => {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const index = p * (sorted.length - 1), lower = Math.floor(index), upper = Math.ceil(index);
	return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
};
const sum = (rows: any[], field: (row: any) => number) => rows.reduce((n, row) => n + field(row), 0);
const wilson = (success: number, n: number): [number, number] => {
	if (!n) return [0, 1];
	// Bonferroni 97.5% marginal intervals give a conservative 95% difference interval.
	const z = 2.2414027276, p = success / n, d = 1 + z * z / n;
	const center = (p + z * z / (2 * n)) / d;
	const radius = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
	return [Math.max(0, center - radius), Math.min(1, center + radius)];
};
export function pairedBootstrap(pairs: Array<[number, number]>, seed = 20260903): [number, number] | null {
	if (!pairs.length) return null;
	const samples: number[] = [];
	for (let i = 0; i < 10_000; i++) {
		let delta = 0;
		for (let j = 0; j < pairs.length; j++) {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			const pair = pairs[Math.floor(seed / 2 ** 32 * pairs.length)]!;
			delta += pair[1] - pair[0];
		}
		samples.push(delta / pairs.length);
	}
	return [quantile(samples, 0.025)!, quantile(samples, 0.975)!];
}

function tokenCostBootstrap(pairs: Array<[any, any]>): [number, number] | null {
	if (!pairs.length) return null;
	let seed = 20260903;
	const values: number[] = [];
	for (let i = 0; i < 10_000; i++) {
		const tokens = [0, 0], successes = [0, 0];
		for (let j = 0; j < pairs.length; j++) {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			const pair = pairs[Math.floor(seed / 2 ** 32 * pairs.length)]!;
			for (let arm = 0; arm < 2; arm++) { tokens[arm]! += pair[arm].usage.totalTokens; successes[arm]! += +pair[arm].verified; }
		}
		if (!successes[0] || !successes[1]) return null;
		values.push(tokens[1]! / successes[1]! - tokens[0]! / successes[0]!);
	}
	return [quantile(values, 0.025)!, quantile(values, 0.975)!];
}

export async function summarizeLiveRepairTrial(): Promise<void> {
	const directory = resolve(process.env.CODETONOMY_REPAIR_TRIAL_OUTPUT ?? "docs/audits/tool-repair/implementation/live-trial");
	const raw = JSON.parse(await readFile(join(directory, "results.json"), "utf8"));
	const powerLog = await readFile(join(directory, "host-sleep.log"), "utf8").catch(() => "");
	const sleepPeriods = [...powerLog.matchAll(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-]\d\d)(\d\d) Sleep\s+Entering Sleep state due to '([^']+)'.*? (\d+) secs/gm)].map(match => ({
		startedAt: new Date(`${match[1]}T${match[2]}${match[3]}:${match[4]}`).toISOString(), reason: match[5], seconds: Number(match[6]),
	}));
	// Derive metrics from immutable traces, including rows collected by the initial reducer.
	const rows = await Promise.all(raw.rows.map(async (row: any) => {
		const events = (await readFile(join(directory, "traces", row.runId, "trace.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as HarnessEvent);
		const model = events.filter(e => e.type === "model.request.completed");
		const mutations = events.filter(e => e.type === "tool.completed" && ["write_workspace", "edit_workspace"].includes(String(e.data.toolId)));
		const repairRequests = new Set(events.filter(e => e.type === "model.request.started" && Number(e.data.attempt) > 0).map(e => e.eventId));
		const repaired = model.filter(e => repairRequests.has(e.parentEventId!));
		const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
		for (const event of events.filter(e => ["model.request.completed", "model.request.failed"].includes(e.type))) {
			const value = event.data.usage as typeof usage | undefined;
			if (!value) continue;
			for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) usage[field] += value[field] ?? 0;
			for (const field of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) usage.cost[field] += value.cost?.[field] ?? 0;
		}
		const startedAt = events[0]!.timestamp, endedAt = events.at(-1)!.timestamp;
		const hostSleepOverlap = sleepPeriods.filter(period => Date.parse(period.startedAt) < Date.parse(endedAt) && Date.parse(period.startedAt) + period.seconds * 1000 > Date.parse(startedAt));
		return { ...row, startedAt, endedAt, hostSleepOverlap, usage, repair: repairMetrics(events, true), modelTurns: events.filter(e => e.type === "model.request.started").length,
			repairTokens: sum(repaired, e => Number(e.data.usage?.totalTokens ?? 0)), extraModelTurns: repaired.length,
			duplicateMutationCalls: Math.max(0, mutations.length - 2),
			firstRequestCacheRead: Number((model[0]?.data.usage as any)?.cacheRead ?? 0),
		};
	}));
	const evaluated = rows.filter((r: any) => !r.infrastructureExcluded);
	const cells = [false, true].flatMap(omission => ["cold-requested", "warm-requested"].map(cache => {
		const selected = evaluated.filter((r: any) => r.omission === omission && r.cache === cache);
		const pairs: Array<[any, any]> = [];
		for (const pair of new Set(selected.map((r: any) => r.pair))) {
			const control = selected.find((r: any) => r.pair === pair && r.variant === "generic");
			const candidate = selected.find((r: any) => r.pair === pair && r.variant === "targeted");
			if (control && candidate) pairs.push([control, candidate]);
		}
		const variants = ["generic", "targeted"].map(variant => {
			const group = selected.filter((r: any) => r.variant === variant), verified = group.filter((r: any) => r.verified).length;
			const cost = sum(group, r => r.usage.cost?.total ?? 0), tokens = sum(group, r => r.usage.totalTokens);
			return { variant, runs: group.length, verified, wrongRepairs: sum(group, r => +r.wrongRepair), falseCompletions: sum(group, r => +r.falseCompletion),
				unresolvedIncorrectlyCleared: sum(group, r => +r.unresolvedIncorrectlyCleared), duplicateMutationCalls: sum(group, r => r.duplicateMutationCalls),
				eligibleFailures: sum(group, r => r.repair.eligible), resolvedFailures: sum(group, r => r.repair.resolved),
				omissionTriggered: sum(group, r => +(r.omission && r.initialVerificationFailed)), omissionRecovered: sum(group, r => +(r.omission && r.initialVerificationFailed && r.verified)),
				extraModelTurns: sum(group, r => r.extraModelTurns), repairTokens: sum(group, r => r.repairTokens), tokens, peakCostUsd: cost,
				tokensPerVerifiedSuccess: verified ? tokens / verified : null, costPerVerifiedSuccess: verified ? cost / verified : null,
				medianMs: quantile(group.map((r: any) => r.durationMs), 0.5), p95Ms: quantile(group.map((r: any) => r.durationMs), 0.95),
				firstRequestCacheRead: sum(group, r => r.firstRequestCacheRead), cacheReadTokens: sum(group, r => r.usage.cacheRead) };
		});
		const [control, candidate] = [0, 1].map(index => wilson(pairs.filter(pair => pair[index].verified).length, pairs.length));
		const completionDifference95 = [candidate![0] - control![1], candidate![1] - control![0]];
		return { omission, cache, pairs: pairs.length, variants, completionDifference95, noninferiorityEstablished: completionDifference95[0]! >= -0.02,
			tokensPerVerifiedSuccessDifference95: tokenCostBootstrap(pairs),
			meanTokenDifference95: pairedBootstrap(pairs.map(([a, b]) => [a.usage.totalTokens, b.usage.totalTokens])),
			meanLatencyDifference95: pairedBootstrap(pairs.map(([a, b]) => [a.durationMs, b.durationMs])),
		};
	}));
	let initialRequestHashMatches = 0, coldWarmComparisons = 0, missingRequestHashComparisons = 0;
	for (const cold of evaluated.filter((r: any) => r.cache === "cold-requested")) {
		const warm = evaluated.find((r: any) => r.cache === "warm-requested" && r.pair === cold.pair && r.omission === cold.omission && r.variant === cold.variant);
		if (warm) {
			coldWarmComparisons++;
			if (!cold.requestHashes[0] || !warm.requestHashes[0]) missingRequestHashComparisons++;
			else initialRequestHashMatches += +(cold.requestHashes[0] === warm.requestHashes[0]);
		}
	}
	const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), stopReason: raw.stopReason, protocol: raw.protocol,
		decision: "defer", reason: "This narrow synthetic pilot cannot establish the predeclared two-percentage-point completion margin or generalize to other tasks/providers. Production behavior is unchanged.",
		attemptedRuns: rows.length, evaluatedRuns: evaluated.length, infrastructureExcludedRuns: rows.length - evaluated.length,
		verified: evaluated.filter((r: any) => r.verified).length, requests: raw.requests, budget: raw.budget,
		unknownFinalOracleRuns: rows.filter((r: any) => r.oracleUnknown).length,
		hostSleepPeriods: sleepPeriods, hostSleepAffectedRuns: rows.filter((r: any) => r.hostSleepOverlap.length).length,
		unknownUsageReservedTokens: raw.reservedTokens, unknownUsageReservedCost: raw.reservedCost, coldWarmComparisons, initialRequestHashMatches, missingRequestHashComparisons,
		conservativeUsageValueIncludingReservations: raw.budget.costUsd + raw.reservedCost,
		cells, rows,
	};
	await writeFile(join(directory, "analysis.json"), JSON.stringify(report, null, 2) + "\n");
	const totals = cells.flatMap(c => c.variants);
	const lines = ["# Live tool-repair trial", "", `Status: ${raw.stopReason}. ${report.verified}/${report.evaluatedRuns} evaluated runs independently verified; ${report.infrastructureExcludedRuns} budget-cutoff attempt retained separately.`, "",
		`Provider: OpenCode Go / deepseek-v4-flash. ${raw.requests} requests; ${raw.budget.totalTokens.toLocaleString("en-US")} reported tokens. Conservative peak-rate usage value: $${raw.budget.costUsd.toFixed(4)}. This is not an invoice or a subscription balance. [Provider rate source](https://opencode.ai/docs/go/).`, "",
		`Observed wrong repairs: ${sum(totals, v => v.wrongRepairs)}; duplicate mutation calls: ${sum(totals, v => v.duplicateMutationCalls)}; false completions: ${sum(totals, v => v.falseCompletions)}; verified runs with unresolved recorded failures: ${sum(totals, v => v.unresolvedIncorrectlyCleared)}. ${sum(totals, v => v.omissionRecovered)}/${sum(totals, v => v.omissionTriggered)} runs that reached the injected verifier failure recovered. Eligible tool errors: ${sum(totals, v => v.eligibleFailures)}; a tool-error recovery rate is not estimable when none occurred.`, "",
		"| Case | Cache request | Variant | Verified | Median / p95 (s) | Tokens / verified success |", "| --- | --- | --- | --- | --- | --- |",
		...cells.flatMap(cell => cell.variants.map(v => `| ${cell.omission ? "Injected omission" : "Clean"} | ${cell.cache} | ${v.variant} | ${v.verified}/${v.runs} | ${((v.medianMs ?? 0) / 1000).toFixed(2)} / ${((v.p95Ms ?? 0) / 1000).toFixed(2)} | ${Math.round(v.tokensPerVerifiedSuccess ?? 0)} |`)), "",
		"Differences below are targeted minus generic. Lower token cost favors targeted feedback; higher completion favors targeted feedback.", "",
		"| Case | Cache request | Pairs | Completion difference 95% interval (percentage points) | Tokens/success difference 95% interval |", "| --- | --- | --- | --- | --- |",
		...cells.map(cell => `| ${cell.omission ? "Injected omission" : "Clean"} | ${cell.cache} | ${cell.pairs} | ${cell.completionDifference95.map(v => (v * 100).toFixed(1)).join(" to ")} | ${cell.tokensPerVerifiedSuccessDifference95?.map(Math.round).join(" to ") ?? "not estimable"} |`), "",
		"The omission condition hides the second file requirement from the outgoing model prompt until verifier feedback. The harness always verifies both files. Responses, tool execution, and subsequent corrections are live; this is an injected missing-obligation study, not a natural tool-error rate measurement.", "",
		`Cold/warm initial request hashes match in ${initialRequestHashMatches}/${coldWarmComparisons - missingRequestHashComparisons} available comparisons; ${missingRequestHashComparisons} comparison lacks a request hash from the interrupted run. A nonce and fresh session cannot force provider cache eviction. Actual cache tokens are reported separately; these labels do not prove a cold server cache.`, "",
		"Analysis uses paired bootstrap intervals for token and latency differences and conservative completion-rate intervals. Cells remain separate. Admission-limited work is excluded from the model comparison, but its tokens and cost remain in the trial total. Clean cells measure overhead; omission cells measure recovery. Eligible tool failures and omission recovery are separate counts.", "",
		`Timeouts remain failed trials. Final file state is unavailable for ${report.unknownFinalOracleRuns} interrupted run; no clean-state claim is made for that run. Unreported usage retains a conservative reservation of ${raw.reservedTokens} tokens / $${raw.reservedCost.toFixed(4)} in addition to reported usage.`, "",
		`Reported usage plus outstanding reservations totals $${report.conservativeUsageValueIncludingReservations.toFixed(4)} at the conservative rates. Per-variant token/cost comparisons and their intervals use reported usage only; missing timeout usage prevents treating those intervals as complete billing estimates.`, "",
		`Host power logs show ${sleepPeriods.length} sleep intervals overlapping ${report.hostSleepAffectedRuns} run(s). Those runs remain in the main results. Host suspension can delay JavaScript deadlines and network recovery, so these wall-time results cannot establish a clean causal latency comparison. A temporary caffeinate -i assertion was attached to the trial process at 09:25 UTC after discovering the sleep interference; it ends with that process. [Power-log evidence](host-sleep.log).`, "",
		"Decision: defer further promotion. The pilot does not establish the two-percentage-point non-inferiority margin. Narrow edit normalization and repetition-budget ablations were not tested here. No production behavior changed.", "",
		`[Protocol](protocol.json) · [Budget amendment](protocol-amendment.json)${raw.protocol === "protocol-amendment-2.json" ? " · [Final time allowance](protocol-amendment-2.json)" : ""} · [Raw results](results.json) · [Derived metrics, confidence intervals and per-run traces](analysis.json)`, "",
		"Validation: all four cells contain 30 complete pairs; token and cost totals match the traces; all successful final file hashes match the independent oracle; runner snapshots match their predeclared hashes. Prompt-transform and analysis self-checks, npm run check, and git diff --check passed. [Validation record](validation.json).", "",
		"The initial reducer referenced two incorrect event field names for duplicate calls and repair tokens. The analysis recomputes these fields from every retained trace using toolId and the parent model request's verifier-attempt index; raw evidence is preserved. Runner prompt-transform checks and analysis checks are executable with --self-check.", ""];
	await writeFile(join(directory, "README.md"), lines.join("\n"));
	console.log(JSON.stringify({ evaluated: report.evaluatedRuns, verified: report.verified, cells: cells.map(c => ({ omission: c.omission, cache: c.cache, pairs: c.pairs, completionDifference95: c.completionDifference95 })), peakCostUsd: raw.budget.costUsd, decision: report.decision }, null, 2));
}

if (process.argv.includes("--self-check")) {
	assert.deepEqual(pairedBootstrap([[1, 3], [2, 4]]), [2, 2]);
	assert.equal(quantile([1, 3], 0.5), 2);
	assert.equal(pairedBootstrap([]), null);
	assert.deepEqual(tokenCostBootstrap([[{ verified: true, usage: { totalTokens: 1 } }, { verified: true, usage: { totalTokens: 3 } }]]), [2, 2]);
	assert.ok(wilson(30, 30)[0] < 0.98);
	console.log("Trial analysis checks passed");
}
