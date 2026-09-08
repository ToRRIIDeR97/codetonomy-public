import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHarness, type HarnessRunOptions } from "@agent-harness/runtime";
import type { RunResult } from "@agent-harness/contracts";
import { apiKeyForProvider, type ConfigurationState, type ProviderSettings } from "./config.js";

export type ProviderSmokeCategory = "ok" | "missing_credential" | "auth" | "rate_limit" | "quota" | "request" | "server" | "timeout" | "network" | "protocol";

export interface ProviderSmokeDiagnostic {
	provider: string;
	model: string;
	success: boolean;
	category: ProviderSmokeCategory;
	statuses: number[];
	retries: number;
	elapsedMs: number;
	firstTokenMs?: number;
	retryAfterCappedMs?: number;
	usage?: { input: number; output: number; totalTokens: number };
}

type SmokeRunner = (options: HarnessRunOptions) => Promise<RunResult>;

const retryAfterMs = (value: string | undefined): number | undefined => {
	if (!value) return undefined;
	const seconds = Number(value);
	const milliseconds = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(value) - Date.now();
	return Number.isFinite(milliseconds) && milliseconds >= 0 ? Math.min(Math.round(milliseconds), 2_000) : undefined;
};

const retryDelayMs = (retryAfter: string | undefined, retryAfterMilliseconds: string | undefined): number | undefined => {
	if (retryAfterMilliseconds !== undefined) {
		const milliseconds = Number(retryAfterMilliseconds);
		if (Number.isFinite(milliseconds) && milliseconds >= 0) return Math.min(Math.round(milliseconds), 2_000);
	}
	return retryAfterMs(retryAfter);
};

const failureCategory = (status: number | undefined, timedOut: boolean): ProviderSmokeCategory => {
	if (timedOut || status === 408) return "timeout";
	if (status === 401 || status === 403) return "auth";
	if (status === 402) return "quota";
	if (status === 429) return "rate_limit";
	if (status !== undefined && status >= 500) return "server";
	if (status !== undefined) return "request";
	return "network";
};

const smokeOne = async (state: ConfigurationState, provider: ProviderSettings, runner: SmokeRunner): Promise<ProviderSmokeDiagnostic> => {
	const apiKey = apiKeyForProvider(state, provider);
	if (!apiKey) return { provider: provider.id, model: provider.modelId, success: false, category: "missing_credential", statuses: [], retries: 0, elapsedMs: 0 };
	const directory = await mkdtemp(join(tmpdir(), "codetonomy-provider-smoke-"));
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 45_000);
	timeout.unref();
	const statuses: number[] = [];
	let firstTokenMs: number | undefined;
	let retryAfterCappedMs: number | undefined;
	const started = performance.now();
	const originalFetch = globalThis.fetch;
	// ponytail: smoke probes run sequentially; replace this process-wide interceptor before adding concurrency.
	globalThis.fetch = (async (...arguments_: Parameters<typeof fetch>) => {
		const response = await originalFetch(...arguments_);
		statuses.push(response.status);
		retryAfterCappedMs = retryDelayMs(response.headers.get("retry-after") ?? undefined, response.headers.get("retry-after-ms") ?? undefined) ?? retryAfterCappedMs;
		return response;
	}) as typeof fetch;
	try {
		let providerResponses = 0;
		const result = await runner({
			objective: "Return a concise success response.",
			workspaceRoot: directory,
			traceDirectory: join(directory, "runs"),
			provider: provider.id,
			modelId: provider.modelId,
			providerConfiguration: { id: provider.id, name: provider.name, kind: provider.kind, ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}), apiKey },
			evaluationVariant: "RAW_MODEL",
			maxOutputTokens: 256,
			providerRetryLimit: 1,
			providerMaxRetryDelayMs: 2_000,
			signal: controller.signal,
			onProviderResponse: ({ status, headers }) => {
				providerResponses++;
				if (statuses.length < providerResponses) statuses.push(status);
				const header = (name: string) => Object.entries(headers).find(([candidate]) => candidate.toLowerCase() === name)?.[1];
				retryAfterCappedMs = retryDelayMs(header("retry-after"), header("retry-after-ms")) ?? retryAfterCappedMs;
			},
			observers: [(event) => {
				if (event.type === "model.first_token" && typeof event.data.latencyMs === "number") firstTokenMs = event.data.latencyMs;
			}],
		});
		const success = Boolean(result.output.trim()) && (!statuses.length || (statuses.at(-1)! >= 200 && statuses.at(-1)! < 300));
		return {
			provider: provider.id,
			model: provider.modelId,
			success,
			category: success ? "ok" : statuses.length ? failureCategory(statuses.at(-1), controller.signal.aborted) : "protocol",
			statuses,
			retries: Math.max(0, statuses.length - 1),
			elapsedMs: Math.round(performance.now() - started),
			...(firstTokenMs !== undefined ? { firstTokenMs } : {}),
			...(retryAfterCappedMs !== undefined ? { retryAfterCappedMs } : {}),
			usage: { input: result.usage.input, output: result.usage.output, totalTokens: result.usage.totalTokens },
		};
	} catch {
		return {
			provider: provider.id,
			model: provider.modelId,
			success: false,
			category: failureCategory(statuses.at(-1), controller.signal.aborted),
			statuses,
			retries: Math.max(0, statuses.length - 1),
			elapsedMs: Math.round(performance.now() - started),
			...(firstTokenMs !== undefined ? { firstTokenMs } : {}),
			...(retryAfterCappedMs !== undefined ? { retryAfterCappedMs } : {}),
		};
	} finally {
		clearTimeout(timeout);
		globalThis.fetch = originalFetch;
		await rm(directory, { recursive: true, force: true });
	}
};

export async function runLiveProviderSmokes(
	state: ConfigurationState,
	options: { enabled: boolean; provider?: string; all?: boolean; runner?: SmokeRunner },
): Promise<ProviderSmokeDiagnostic[]> {
	if (!options.enabled) throw new Error("Set CODETONOMY_LIVE_PROVIDER_SMOKE=1 as well as --live to authorize provider requests");
	const providers = options.all ? state.configuration.providers : state.configuration.providers.filter(({ id }) => id === options.provider);
	if (!providers.length) throw new Error(`Provider ${options.provider ?? "configuration"} is not configured`);
	const runner = options.runner ?? ((runOptions) => createHarness().run(runOptions));
	const diagnostics: ProviderSmokeDiagnostic[] = [];
	for (const provider of providers) diagnostics.push(await smokeOne(state, provider, runner));
	return diagnostics;
}

export const formatProviderSmokeDiagnostic = (diagnostic: ProviderSmokeDiagnostic): string => {
	const fields = [
		diagnostic.success ? "PASS" : diagnostic.category === "missing_credential" ? "SKIP" : "FAIL",
		`${diagnostic.provider}/${diagnostic.model}`,
		`category=${diagnostic.category}`,
		`statuses=${diagnostic.statuses.join(",") || "none"}`,
		`retries=${diagnostic.retries}`,
		`elapsedMs=${diagnostic.elapsedMs}`,
		...(diagnostic.firstTokenMs !== undefined ? [`firstTokenMs=${diagnostic.firstTokenMs}`] : []),
		...(diagnostic.retryAfterCappedMs !== undefined ? [`retryAfterCappedMs=${diagnostic.retryAfterCappedMs}`] : []),
		...(diagnostic.usage ? [`tokens=${diagnostic.usage.input}/${diagnostic.usage.output}/${diagnostic.usage.totalTokens}`] : []),
	];
	return fields.join(" ");
};
