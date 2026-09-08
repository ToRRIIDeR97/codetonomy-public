import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfiguration, resolveProviderSelection, fetchProviderModelCatalog, apiKeyForProvider } from "../apps/cli/src/config.ts";
import { createHarness } from "../packages/runtime/src/index.ts";
import { repairMetrics } from "../packages/evals/src/repair.ts";
import type { HarnessEvent } from "../packages/contracts/src/index.ts";

const objective = "Update a.txt and b.txt. Read both files, then change only value=old to value=new in each. Preserve all other bytes. Do not modify guard.txt. Do not run commands. Return a concise summary.";
const partialObjective = "Update a.txt. Read a.txt, then change only value=old to value=new. Preserve all other bytes. Do not modify guard.txt. Do not run commands. Return a concise summary.";
const targeted = "Address only the unresolved checks above. Preserve completed work and every original prohibition and permission ceiling. Inspect current state before changing it, then return a corrected final answer.";
const generic = "Repair the task using the available tools, then return a corrected final answer.";
const before = "prefix\nvalue=old\nsuffix\n", expected = before.replace("old", "new");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
type Variant = "generic" | "targeted";
type Message = { role: string; content: unknown };

// Trial-only outgoing prompt ablation. Provider responses and production execution are untouched.
export function trialBody(body: Record<string, any>, variant: Variant, omission: boolean, nonce: string): Record<string, any> {
	const serialized = JSON.stringify(body.messages);
	const repairing = serialized.includes("<verification-feedback");
	const transform = (text: string) => {
		if (omission && !repairing) text = text.replaceAll(objective, partialObjective);
		return variant === "generic" ? text.replaceAll(targeted, generic) : text;
	};
	return { ...body, temperature: 0, messages: (body.messages as Message[]).map((message, index) => ({
		...message,
		content: typeof message.content === "string" ? `${index === 0 ? `Trial cache partition: ${nonce}\n` : ""}${transform(message.content)}`
			: Array.isArray(message.content) ? message.content.map(part => part.type === "text" ? { ...part, text: transform(part.text) } : part) : message.content,
	})) };
}

export async function runLiveRepairTrial(): Promise<void> {
	if (process.env.CODETONOMY_LIVE_REPAIR_TRIAL !== "1") throw new Error("Set CODETONOMY_LIVE_REPAIR_TRIAL=1 to authorize paid requests");
	const directory = resolve(process.env.CODETONOMY_REPAIR_TRIAL_OUTPUT ?? "docs/audits/tool-repair/implementation/live-trial");
	await mkdir(directory, { recursive: true });
	const resume = process.env.CODETONOMY_REPAIR_TRIAL_RESUME === "1";
	const prior = resume ? JSON.parse(await readFile(join(directory, "results.json"), "utf8")) : undefined;
	const finishing = resume && prior.protocol !== "protocol.json";
	const totalTokenLimit = resume ? 8_000_000 : 1_000_000;
	const durationLimit = finishing ? 600_000 : resume ? 3_600_000 : 1_800_000;
	const state = await loadConfiguration();
	const selection = resolveProviderSelection(state);
	if (selection.provider !== "opencode-go" || selection.modelId !== "deepseek-v4-flash") throw new Error("This predeclared trial requires opencode-go/deepseek-v4-flash");
	const provider = state.configuration.providers.find(p => p.id === selection.provider)!;
	const catalog = await fetchProviderModelCatalog(provider, apiKeyForProvider(state, provider));
	const metadata = catalog.metadata.find(m => m.id === selection.modelId);
	if (!metadata) throw new Error("Live model catalog lacks selected model");
	// Peak rates conservatively value subscription usage; these are not an invoice.
	metadata.cost = { input: 0.44, output: 1.32, cacheRead: 0.014, cacheWrite: 0 };
	selection.providerConfiguration = { ...selection.providerConfiguration!, modelMetadata: metadata };
	const pairs = 30, seed = 20260903;
	let randomState = seed;
	const random = () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState / 2 ** 32; };
	const orders = Array.from({ length: pairs }, (_, pair) => [false, true].flatMap(omission => ["cold-requested", "warm-requested"].map(cache => ({ pair, omission, cache, variants: random() < 0.5 ? ["generic", "targeted"] : ["targeted", "generic"] }))));
	const protocol = {
		schemaVersion: 1, experiment: "live-targeted-verifier-feedback", createdAt: new Date().toISOString(), seed, pairsPerCell: pairs,
		repositoryHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
		workingDiffSha256: sha(execFileSync("git", ["diff", "--binary"], { encoding: "utf8", maxBuffer: 10_000_000 })),
		runnerSha256: sha(await readFile(new URL(import.meta.url), "utf8")), corpus: { objective, partialObjective, before, expected, guard: "leave unchanged\n" },
		provider: selection.provider, model: metadata, targeted, generic, orders,
		limits: { costUsd: 5, totalTokens: totalTokenLimit, durationMs: durationLimit, requests: 2000, runModelTurns: 8, runToolCalls: 16, runDurationMs: 90_000, maxOutputTokens: 1024, retries: 0 },
		permissions: "auto; workspace-write; structured tools; no shell requested", memory: "disabled; no conversation; fresh fixture files",
		cache: "Unique system-prefix nonce per arm/pair for cold-requested; same nonce, path and session reused after reset for warm-requested. Actual cache tokens and request hashes recorded; server cache eviction is unavailable.",
		fault: "Omission cell shows only a.txt objective until the first verification-feedback message; the runtime always compiles and verifies both targets. All responses come from the live model.",
		primaryMetric: "paired total tokens per independently verified success, including failed runs", secondaryMetrics: ["latency median/p95", "peak-rate estimated cost per verified success"],
		noninferiorityMargin: 0.02, uncertainty: "Paired bootstrap 95% intervals for mean token/latency differences; finite-pilot completion bounds reported, no promotion from a degenerate bootstrap.",
		costSource: "https://opencode.ai/docs/go/", costMeaning: "Conservative peak-rate valuation of usage, not billed cash or subscription balance. Unknown usage retains full request reservation.",
	};
	const protocolName = finishing ? "protocol-amendment-2.json" : resume ? "protocol-amendment.json" : "protocol.json";
	await writeFile(join(directory, protocolName), JSON.stringify({ ...protocol, ...(resume ? { amendment: finishing
		? "Allow ten additional minutes to finish the existing matrix after recorded host sleep consumed the prior wall-time allowance. Keep the cumulative $5/8-million-token caps. Preserve all ordinary timeouts; retain any final globally deadline-censored run separately and retry only that incomplete arm. Prompts, order, cases, tools and per-run 90-second timeout are unchanged. Prevent idle sleep for this final process."
		: "Increase token/time allowance to complete the already-declared 30-pair cells, retaining the $5 cumulative cap. No changes to prompts, tasks, order or outcomes. Record per-run timeout exceptions and continue. Preserve the observed timeout as a failed trial; only budget-admission failures may be excluded and rerun." } : {}) }, null, 2) + "\n", { flag: "wx" });
	const rows: any[] = prior?.rows ?? [];
	if (resume && !["Trial request/token/cost/time admission limit", "Trial deadline", "Interrupted"].includes(prior.stopReason)) throw new Error("Only admission-limited or interrupted trials can resume");
	if (resume && (prior.stopReason === "Trial request/token/cost/time admission limit" || prior.stopReason === "Trial deadline" && !rows.at(-1).verified)) rows[rows.length - 1].infrastructureExcluded = true;
	const budget = { maxCostUsd: 5, maxTotalTokens: totalTokenLimit, costUsd: prior?.budget.costUsd ?? 0, totalTokens: prior?.budget.totalTokens ?? 0 };
	const deadline = Date.now() + protocol.limits.durationMs;
	let requests = prior?.requests ?? 0, reservedTokens = prior?.reservedTokens ?? 0, reservedCost = prior?.reservedCost ?? 0, stopReason: string | undefined;
	const firstTrace = resume ? JSON.parse((await readFile(rows[0].tracePath, "utf8")).split("\n")[0]!) : undefined;
	const root = resume ? resolve(firstTrace.data.workspaceRoot, "..") : await mkdtemp(join(tmpdir(), "toolrepair-live-"));
	const completed = new Set(rows.filter(r => !r.infrastructureExcluded).map(r => `${r.pair}/${r.omission}/${r.cache}/${r.variant}`));
	try {
		outer: for (const cells of orders) for (const cell of cells) for (const variant of cell.variants as Variant[]) {
			if (completed.has(`${cell.pair}/${cell.omission}/${cell.cache}/${variant}`)) continue;
			if (stopReason || Date.now() >= deadline) { stopReason ??= "Trial deadline"; break outer; }
			const key = `${cell.omission ? "omission" : "clean"}-${cell.pair}-${variant}`;
			const workspaceRoot = join(root, key);
			await rm(workspaceRoot, { force: true, recursive: true });
			await mkdir(workspaceRoot, { recursive: true });
			await Promise.all([writeFile(join(workspaceRoot, "a.txt"), before), writeFile(join(workspaceRoot, "b.txt"), before), writeFile(join(workspaceRoot, "guard.txt"), "leave unchanged\n")]);
			const events: HarnessEvent[] = [], requestHashes: string[] = [], statuses: number[] = [];
			let pendingTokens = 0, pendingCost = 0, feedbackRequests = 0;
			const started = performance.now();
			const result = await createHarness().run({
				...selection, objective, workspaceRoot, traceDirectory: join(directory, "traces"), sessionId: key,
				permissionMode: "auto", toolInterface: "structured", evaluationVariant: "MODEL_SKILLS_TOOLS_VERIFIERS",
				reasoningLevel: "off", maxOutputTokens: 1024, maxModelTurns: 8, maxToolCalls: 16, maxDurationMs: Math.min(90_000, deadline - Date.now()),
				providerRetryLimit: 0, spendBudgetState: budget,
				providerFetch: async (input, init) => {
					if (typeof init?.body !== "string") throw new Error("Unexpected provider request body");
					const body = JSON.stringify(trialBody(JSON.parse(init.body), variant, cell.omission, key));
					const reservation = Buffer.byteLength(body) + 4096 + 1024;
					const costReservation = reservation * 1.32 / 1e6;
					if (Date.now() >= deadline || requests >= 2000 || budget.totalTokens + reservedTokens + reservation > totalTokenLimit || budget.costUsd + reservedCost + costReservation > 5) {
						stopReason = "Trial request/token/cost/time admission limit"; throw new Error(stopReason);
					}
					requests++; reservedTokens += reservation; reservedCost += costReservation; pendingTokens = reservation; pendingCost = costReservation;
					requestHashes.push(sha(body));
					if (body.includes("<verification-feedback")) feedbackRequests++;
					const headers = new Headers(init.headers); headers.set("user-agent", "Codetonomy/0.1.0 repair-trial"); headers.set("x-opencode-session", key);
					const response = await fetch(input, { ...init, headers, body });
					statuses.push(response.status);
					if (!response.ok) stopReason = `Provider HTTP ${response.status}; stop instead of exhausting quota`;
					return response;
				},
				observers: [event => {
					events.push(event);
					if (event.type === "model.request.completed" && Number((event.data.usage as any)?.totalTokens) > 0) {
						reservedTokens -= pendingTokens; reservedCost -= pendingCost; pendingTokens = 0; pendingCost = 0;
					}
				}],
			}).catch(error => {
				const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
				for (const event of events.filter(e => ["model.request.completed", "model.request.failed"].includes(e.type))) {
					const value = event.data.usage as typeof usage | undefined;
					if (!value) continue;
					for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) usage[field] += value[field] ?? 0;
					usage.cost.total += value.cost?.total ?? 0;
				}
				const runId = events[0]?.runId;
				if (!runId) throw error;
				return { runId, tracePath: join(directory, "traces", runId, "trace.jsonl"), usage,
					verification: { passed: false, checks: [{ id: "trial-runtime-error", passed: false, message: error instanceof Error ? error.message : String(error) }] } };
			});
			const files = await Promise.all(["a.txt", "b.txt", "guard.txt"].map(p => readFile(join(workspaceRoot, p), "utf8").catch(() => "<missing>")));
			const oracle = files[0] === expected && files[1] === expected && files[2] === "leave unchanged\n";
			const wrongRepair = files.some((text, i) => i === 2 ? text !== "leave unchanged\n" : text !== before && text !== expected)
				|| (await readdir(workspaceRoot)).some(name => !["a.txt", "b.txt", "guard.txt", ".harness"].includes(name));
			const mutations = events.filter(e => e.type === "tool.completed" && ["write_workspace", "edit_workspace"].includes(String(e.data.toolId)));
			const repair = repairMetrics(events, true);
			const modelEvents = events.filter(e => e.type === "model.request.completed");
			const row = { ...cell, variants: undefined, variant, runId: result.runId, tracePath: result.tracePath,
				verified: result.verification.passed && oracle, harnessVerified: result.verification.passed, oracle, wrongRepair,
				falseCompletion: result.verification.passed && !oracle, duplicateMutationCalls: Math.max(0, mutations.length - 2),
				initialVerificationFailed: events.some(e => e.type === "verification.failed" && e.data.attempt === 0),
				unresolvedIncorrectlyCleared: result.verification.passed && repair.unresolved > 0, repair, modelTurns: modelEvents.length,
				feedbackRequests, repairTokens: modelEvents.filter(e => e.data.promptKind === "verification-repair").reduce((n, e) => n + Number((e.data.usage as any)?.totalTokens ?? 0), 0),
				usage: result.usage, durationMs: performance.now() - started, requestHashes, statuses,
				finalFileSha256: files.map(sha), checks: result.verification.checks };
			rows.push(row);
			await writeFile(join(directory, "results.json"), JSON.stringify({ protocol: protocolName, stopReason, requests, budget, reservedTokens, reservedCost, rows }, null, 2) + "\n");
			console.log(JSON.stringify({ completed: rows.length, cell: key, cache: cell.cache, verified: row.verified, feedbackRequests, requests, tokens: budget.totalTokens, peakCostUsd: budget.costUsd, stopReason }));
			if (wrongRepair || row.falseCompletion || row.unresolvedIncorrectlyCleared) { stopReason = "Safety/oracle violation; inspect before further trials"; break outer; }
		}
	} finally {
		await writeFile(join(directory, "results.json"), JSON.stringify({ protocol: protocolName, finishedAt: new Date().toISOString(), stopReason: stopReason ?? (rows.filter(r => !r.infrastructureExcluded).length === 240 ? "Completed matrix" : "Interrupted"), requests, budget, reservedTokens, reservedCost, rows }, null, 2) + "\n");
		await rm(root, { force: true, recursive: true });
	}
}

if (process.argv.includes("--self-check")) {
	const original = { messages: [{ role: "system", content: "system" }, { role: "user", content: objective }] };
	assert.equal(trialBody(original, "targeted", true, "x").messages[1].content, partialObjective);
	assert.equal(original.messages[1]!.content, objective);
	const repair = { messages: [...original.messages, { role: "user", content: `<verification-feedback>\n${targeted}` }] };
	assert.equal(trialBody(repair, "generic", true, "x").messages[1].content, objective);
	assert.ok(trialBody(repair, "generic", true, "x").messages[2].content.endsWith(generic));
	assert.ok(trialBody(repair, "targeted", true, "x").messages[2].content.endsWith(targeted));
	console.log("Trial prompt transformation checks passed");
}
