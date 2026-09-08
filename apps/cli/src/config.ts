import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { chmod, mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	defaultModelForProvider,
	supportedModelsForProvider,
	type HarnessProviderConfiguration,
	type HarnessModelMetadata,
	type HarnessProviderKind,
} from "@agent-harness/runtime";
import { redactAuditString } from "@agent-harness/contracts";
import { readBoundedUtf8 } from "./interaction.js";

const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_CREDENTIAL_BYTES = 64 * 1024;
const MAX_MODEL_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CATALOG_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_MODELS_PER_PROVIDER = 512;
const MODELS_DEV_URL = "https://models.dev/api.json";
const SAFE_ID = /^[a-z][a-z0-9-]{0,63}$/;
const SAFE_MODEL = /^[A-Za-z0-9~][A-Za-z0-9._:/~-]{0,191}$/;
const SAFE_ENV = /^[A-Z_][A-Z0-9_]{0,127}$/;
const BUILTIN_KINDS = new Set<HarnessProviderKind>([
	"openai",
	"anthropic",
	"google",
	"deepseek",
	"openrouter",
	"opencode",
	"opencode-go",
]);
const PROVIDER_KINDS = new Set<HarnessProviderKind>([
	...BUILTIN_KINDS,
	"openai-compatible",
	"anthropic-compatible",
]);

export interface ProviderSettings {
	id: string;
	name: string;
	kind: HarnessProviderKind;
	modelId: string;
	models: string[];
	modelMetadata?: HarnessModelMetadata[];
	baseUrl?: string;
	apiKeyEnv: string;
}

export interface CodetonomyConfiguration {
	version: 1;
	defaultProvider?: string;
	showReasoning?: boolean;
	reasoningEffort?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	providers: ProviderSettings[];
}

export interface ConfigurationState {
	configuration: CodetonomyConfiguration;
	credentials: Record<string, string>;
	directory: string;
	revision?: string;
}

export interface ProviderSelection {
	provider: string;
	modelId: string;
	providerConfiguration?: HarnessProviderConfiguration;
}

export interface ProviderPreset {
	id: string;
	name: string;
	kind: HarnessProviderKind;
	baseUrl?: string;
	modelId: string;
	apiKeyEnv: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
	{ id: "openai", name: "OpenAI", kind: "openai", modelId: "gpt-5.4-mini", apiKeyEnv: "OPENAI_API_KEY" },
	{ id: "anthropic", name: "Anthropic", kind: "anthropic", modelId: "claude-sonnet-4-6", apiKeyEnv: "ANTHROPIC_API_KEY" },
	{ id: "google", name: "Google Gemini", kind: "google", modelId: "gemini-3.5-flash", apiKeyEnv: "GEMINI_API_KEY" },
	{ id: "deepseek", name: "DeepSeek", kind: "deepseek", modelId: "deepseek-v4-flash", apiKeyEnv: "DEEPSEEK_API_KEY" },
	{ id: "openrouter", name: "OpenRouter", kind: "openrouter", modelId: "~openai/gpt-mini-latest", apiKeyEnv: "OPENROUTER_API_KEY" },
	{ id: "opencode", name: "OpenCode Zen", kind: "opencode", modelId: "kimi-k2.6", apiKeyEnv: "OPENCODE_API_KEY" },
	{ id: "opencode-go", name: "OpenCode Go", kind: "opencode-go", modelId: "kimi-k2.6", apiKeyEnv: "OPENCODE_API_KEY" },
];

const MODEL_ENDPOINTS: Partial<Record<HarnessProviderKind, string>> = {
	openai: "https://api.openai.com/v1/models",
	anthropic: "https://api.anthropic.com/v1/models",
	google: "https://generativelanguage.googleapis.com/v1beta/models",
	deepseek: "https://api.deepseek.com/models",
	openrouter: "https://openrouter.ai/api/v1/models",
	opencode: "https://opencode.ai/zen/v1/models",
	"opencode-go": "https://opencode.ai/zen/go/v1/models",
};

export const defaultConfigurationDirectory = (): string =>
	process.env.CODETONOMY_HOME?.trim() || join(homedir(), ".codetonomy");

export const emptyConfiguration = (): CodetonomyConfiguration => ({ version: 1, providers: [] });

export function migrateConfiguration(value: unknown): unknown {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	const candidate = value as Record<string, unknown>;
	if (candidate.version !== 0) return value;
	if (!Array.isArray(candidate.providers)) throw new Error("Legacy Codetonomy configuration has invalid providers");
	return {
		version: 1,
		...(typeof candidate.default_provider === "string" ? { defaultProvider: candidate.default_provider } : {}),
		providers: candidate.providers.map((raw) => {
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Legacy Codetonomy provider is invalid");
			const provider = raw as Record<string, unknown>;
			const modelId = provider.modelId ?? provider.model;
			return {
				id: provider.id,
				name: provider.name,
				kind: provider.kind,
				modelId,
				models: provider.models ?? (typeof modelId === "string" ? [modelId] : []),
				apiKeyEnv: provider.apiKeyEnv ?? provider.api_key_env,
				...(provider.baseUrl || provider.base_url ? { baseUrl: provider.baseUrl ?? provider.base_url } : {}),
			};
		}),
	};
}

const validateUrl = (raw: string): string => {
	if (raw.length > 2_048) throw new Error("Provider base URL is too long");
	const url = new URL(raw);
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Provider base URL must use HTTP or HTTPS");
	if (url.username || url.password || url.search || url.hash) throw new Error("Provider base URL cannot contain credentials, query parameters, or fragments");
	if (url.protocol === "http:" && !["127.0.0.1", "::1", "localhost"].includes(url.hostname)) throw new Error("Remote provider base URLs must use HTTPS");
	return url.toString().replace(/\/$/, "");
};

export function providerModelsUrl(provider: Pick<ProviderSettings, "kind" | "baseUrl">): string {
	const preset = MODEL_ENDPOINTS[provider.kind];
	if (preset) return preset;
	if (!provider.baseUrl) throw new Error("Provider requires a base URL before models can be loaded");
	const url = new URL(validateUrl(provider.baseUrl));
	url.pathname = `${url.pathname.replace(/\/$/, "")}/models`;
	return url.toString();
}

export const apiKeyForProvider = (state: ConfigurationState, provider: Pick<ProviderSettings, "apiKeyEnv">): string | undefined =>
	process.env[provider.apiKeyEnv] || state.credentials[provider.apiKeyEnv];

const readBoundedResponse = async (response: Response, maximum = MAX_MODEL_RESPONSE_BYTES): Promise<string> => {
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > maximum) {
		throw new Error(`Model catalog response exceeds ${maximum} bytes`);
	}
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maximum) {
			await reader.cancel();
			throw new Error(`Model catalog response exceeds ${maximum} bytes`);
		}
		chunks.push(Buffer.from(value));
	}
	return Buffer.concat(chunks, total).toString("utf8");
};

const errorMessageFromPayload = (payload: unknown): string | undefined => {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	const record = payload as Record<string, unknown>;
	if (typeof record.message === "string") return record.message;
	if (record.error && typeof record.error === "object" && !Array.isArray(record.error)) {
		const message = (record.error as Record<string, unknown>).message;
		if (typeof message === "string") return message;
	}
	return undefined;
};

const modelsFromPayload = (payload: unknown, kind: HarnessProviderKind): string[] => {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
	const record = payload as Record<string, unknown>;
	const entries = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : [];
	const models: string[] = [];
	for (const entry of entries) {
		let id: string | undefined;
		if (typeof entry === "string") id = entry;
		else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
			const item = entry as Record<string, unknown>;
			if (
				kind === "google"
				&& Array.isArray(item.supportedGenerationMethods)
				&& !item.supportedGenerationMethods.includes("generateContent")
			) continue;
			id = typeof item.id === "string" ? item.id : typeof item.name === "string" ? item.name : undefined;
		}
		if (kind === "google" && id?.startsWith("models/")) id = id.slice("models/".length);
		if (id && SAFE_MODEL.test(id) && !models.includes(id)) models.push(id);
	}
	return models;
};

export async function fetchProviderModels(
	provider: ProviderSettings,
	apiKey?: string,
	signal?: AbortSignal,
	fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
	const headers: Record<string, string> = { accept: "application/json" };
	if (apiKey) {
		if (provider.kind === "anthropic" || provider.kind === "anthropic-compatible") {
			headers["x-api-key"] = apiKey;
			headers["anthropic-version"] = "2023-06-01";
		} else if (provider.kind === "google") headers["x-goog-api-key"] = apiKey;
		else headers.authorization = `Bearer ${apiKey}`;
	}
	const timeout = AbortSignal.timeout(10_000);
	const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
	let response: Response;
	try {
		response = await fetchImpl(providerModelsUrl(provider), { headers, signal: requestSignal });
	} catch (error) {
		if (timeout.aborted && !signal?.aborted) throw new Error(`Timed out loading models for ${provider.name}`);
		throw error;
	}
	const text = await readBoundedResponse(response);
	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch {
		if (!response.ok) throw new Error(`Could not load ${provider.name} models (HTTP ${response.status})`);
		throw new Error(`${provider.name} returned an invalid model list`);
	}
	if (!response.ok) {
		const detail = errorMessageFromPayload(payload);
		throw new Error(`Could not load ${provider.name} models (HTTP ${response.status})${detail ? `: ${redactAuditString(detail, apiKey ? [apiKey] : [])}` : ""}`);
	}
	let models = modelsFromPayload(payload, provider.kind);
	const supported = provider.kind === "opencode-go" ? undefined : supportedModelsForProvider(provider.kind);
	if (supported) {
		const allowed = new Set(supported);
		models = models.filter((model) => allowed.has(model));
	}
	if (!models.length) throw new Error(`${provider.name} returned no usable models`);
	if (models.length > MAX_MODELS_PER_PROVIDER) throw new Error(`${provider.name} returned more than ${MAX_MODELS_PER_PROVIDER} models`);
	return models;
}

export interface ProviderModelCatalog {
	models: string[];
	metadata: HarnessModelMetadata[];
}

const finiteNonnegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const positiveInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const openCodeGoMetadata = (payload: unknown, liveModels: string[]): HarnessModelMetadata[] => {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
	const provider = (payload as Record<string, unknown>)["opencode-go"];
	if (!provider || typeof provider !== "object" || Array.isArray(provider)) return [];
	const rawModels = (provider as Record<string, unknown>).models;
	if (!rawModels || typeof rawModels !== "object" || Array.isArray(rawModels)) return [];
	const metadata: HarnessModelMetadata[] = [];
	for (const id of liveModels) {
		const raw = (rawModels as Record<string, unknown>)[id];
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		const model = raw as Record<string, unknown>;
		if (model.tool_call !== true || model.status === "deprecated") continue;
		const limits = model.limit as Record<string, unknown> | undefined;
		const costs = model.cost as Record<string, unknown> | undefined;
		const modalities = model.modalities as Record<string, unknown> | undefined;
		const providerMetadata = model.provider as Record<string, unknown> | undefined;
		if (!positiveInteger(limits?.context) || !positiveInteger(limits?.output) || limits.output > limits.context
			|| !finiteNonnegative(costs?.input) || !finiteNonnegative(costs?.output)) continue;
		const npm = providerMetadata?.npm;
		let api: HarnessModelMetadata["api"] = npm === "@ai-sdk/openai"
			? "openai-responses"
			: npm === "@ai-sdk/anthropic"
				? "anthropic-messages"
				: npm === "@ai-sdk/google"
					? "google-generative-ai"
					: "openai-completions";
		if (["minimax-m2.7", "qwen3.5-plus", "qwen3.6-plus"].includes(id)) api = "openai-completions";
		const inputs = Array.isArray(modalities?.input) && modalities.input.includes("image") ? ["text", "image"] as const : ["text"] as const;
		const name = typeof model.name === "string" && model.name.trim() && model.name.length <= 160 && !/[\u0000-\u001f\u007f-\u009f]/.test(model.name) ? model.name : id;
		metadata.push({
			id,
			name,
			api,
			reasoning: model.reasoning === true,
			input: [...inputs],
			cost: {
				input: costs.input,
				output: costs.output,
				cacheRead: finiteNonnegative(costs.cache_read) ? costs.cache_read : 0,
				cacheWrite: finiteNonnegative(costs.cache_write) ? costs.cache_write : 0,
			},
			contextWindow: limits.context,
			maxTokens: limits.output,
		});
	}
	return metadata;
};

export async function fetchProviderModelCatalog(
	provider: ProviderSettings,
	apiKey?: string,
	signal?: AbortSignal,
	fetchImpl: typeof fetch = fetch,
): Promise<ProviderModelCatalog> {
	const liveModels = await fetchProviderModels(provider, apiKey, signal, fetchImpl);
	if (provider.kind !== "opencode-go") return { models: liveModels, metadata: [] };
	const timeout = AbortSignal.timeout(10_000);
	const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
	let response: Response;
	try { response = await fetchImpl(MODELS_DEV_URL, { headers: { accept: "application/json" }, signal: requestSignal }); }
	catch (error) {
		if (timeout.aborted && !signal?.aborted) throw new Error("Timed out loading OpenCode Go compatibility metadata");
		throw error;
	}
	if (!response.ok) throw new Error(`Could not load OpenCode Go compatibility metadata (HTTP ${response.status})`);
	let payload: unknown;
	try { payload = JSON.parse(await readBoundedResponse(response, MAX_CATALOG_RESPONSE_BYTES)); }
	catch { throw new Error("models.dev returned an invalid model catalog"); }
	const metadata = openCodeGoMetadata(payload, liveModels);
	const supported = new Set(metadata.map(({ id }) => id));
	const models = liveModels.filter((id) => supported.has(id));
	if (!models.length) throw new Error("No live OpenCode Go models had verified compatibility metadata");
	return { models, metadata };
}

export function validateConfiguration(value: unknown): CodetonomyConfiguration {
	value = migrateConfiguration(value);
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Codetonomy configuration must be an object");
	const candidate = value as Record<string, unknown>;
	if (candidate.version !== 1 || !Array.isArray(candidate.providers) || candidate.providers.length > 20) {
		throw new Error("Unsupported Codetonomy configuration");
	}
	const ids = new Set<string>();
	const providers = candidate.providers.map((raw): ProviderSettings => {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid provider configuration");
		const provider = raw as Record<string, unknown>;
		const id = typeof provider.id === "string" ? provider.id : "";
		const name = typeof provider.name === "string" ? provider.name.trim() : "";
		const kind = provider.kind as HarnessProviderKind;
		const modelId = typeof provider.modelId === "string" ? provider.modelId : "";
		const rawModels = provider.models === undefined ? [modelId] : provider.models;
		const apiKeyEnv = typeof provider.apiKeyEnv === "string" ? provider.apiKeyEnv : "";
		if (!SAFE_ID.test(id) || ids.has(id)) throw new Error(`Invalid or duplicate provider id: ${id || "(empty)"}`);
		if (!name || name.length > 80 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) throw new Error(`Invalid provider name for ${id}`);
		if (!PROVIDER_KINDS.has(kind)) throw new Error(`Invalid provider kind for ${id}`);
		if (BUILTIN_KINDS.has(kind) && id !== kind) throw new Error(`Built-in provider ${kind} must use id ${kind}`);
		if (!SAFE_MODEL.test(modelId)) throw new Error(`Invalid model id for ${id}`);
		if (!Array.isArray(rawModels) || rawModels.length === 0 || rawModels.length > MAX_MODELS_PER_PROVIDER) {
			throw new Error(`${name || id} must select between 1 and ${MAX_MODELS_PER_PROVIDER} models`);
		}
		const models = [...new Set(rawModels.map((model) => typeof model === "string" ? model : ""))];
		if (models.length !== rawModels.length || models.some((model) => !SAFE_MODEL.test(model))) {
			throw new Error(`Invalid or duplicate models for ${id}`);
		}
		if (!models.includes(modelId)) throw new Error(`Default model for ${id} must be selected`);
		let modelMetadata: HarnessModelMetadata[] | undefined;
		if (provider.modelMetadata !== undefined) {
			if (kind !== "opencode-go" || !Array.isArray(provider.modelMetadata) || provider.modelMetadata.length > models.length) {
				throw new Error(`Invalid model metadata for ${id}`);
			}
			const metadataIds = new Set<string>();
			modelMetadata = provider.modelMetadata.map((rawModel) => {
				if (!rawModel || typeof rawModel !== "object" || Array.isArray(rawModel)) throw new Error(`Invalid model metadata for ${id}`);
				const model = rawModel as Record<string, unknown>;
				const modelCost = model.cost as Record<string, unknown> | undefined;
				const inputs = model.input;
				if (typeof model.id !== "string" || !models.includes(model.id) || metadataIds.has(model.id)
					|| typeof model.name !== "string" || !model.name.trim() || model.name.length > 160 || /[\u0000-\u001f\u007f-\u009f]/.test(model.name)
					|| !["anthropic-messages", "google-generative-ai", "openai-completions", "openai-responses"].includes(String(model.api))
					|| typeof model.reasoning !== "boolean" || !Array.isArray(inputs) || !inputs.length || inputs.some((input) => input !== "text" && input !== "image")
					|| !finiteNonnegative(modelCost?.input) || !finiteNonnegative(modelCost?.output) || !finiteNonnegative(modelCost?.cacheRead) || !finiteNonnegative(modelCost?.cacheWrite)
					|| !positiveInteger(model.contextWindow) || !positiveInteger(model.maxTokens) || model.maxTokens > model.contextWindow) {
					throw new Error(`Invalid model metadata for ${id}`);
				}
				metadataIds.add(model.id);
				return {
					id: model.id,
					name: model.name,
					api: model.api as HarnessModelMetadata["api"],
					reasoning: model.reasoning,
					input: [...inputs] as HarnessModelMetadata["input"],
					cost: { input: modelCost.input, output: modelCost.output, cacheRead: modelCost.cacheRead, cacheWrite: modelCost.cacheWrite },
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
				};
			});
		}
		if (!SAFE_ENV.test(apiKeyEnv)) throw new Error(`Invalid API key variable for ${id}`);
		ids.add(id);
		const baseUrl = typeof provider.baseUrl === "string" && provider.baseUrl
			? validateUrl(provider.baseUrl)
			: undefined;
		if (kind.endsWith("-compatible") && !baseUrl) throw new Error(`${name} requires a base URL`);
		if (!kind.endsWith("-compatible") && baseUrl) throw new Error(`Built-in provider ${id} cannot override its base URL`);
		return { id, name, kind, modelId, models, apiKeyEnv, ...(baseUrl ? { baseUrl } : {}), ...(modelMetadata ? { modelMetadata } : {}) };
	});
	const defaultProvider = typeof candidate.defaultProvider === "string" ? candidate.defaultProvider : undefined;
	if (defaultProvider && !ids.has(defaultProvider)) throw new Error("Default provider is not configured");
	if (candidate.showReasoning !== undefined && typeof candidate.showReasoning !== "boolean") throw new Error("showReasoning must be a boolean");
	if (candidate.reasoningEffort !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh"].includes(String(candidate.reasoningEffort))) throw new Error("Invalid reasoning effort");
	return {
		version: 1, providers,
		...(defaultProvider ? { defaultProvider } : {}),
		...(candidate.showReasoning !== undefined ? { showReasoning: candidate.showReasoning } : {}),
		...(candidate.reasoningEffort !== undefined ? { reasoningEffort: candidate.reasoningEffort as CodetonomyConfiguration["reasoningEffort"] } : {}),
	};
}

const parseCredentials = (text: string): Record<string, string> => {
	const credentials: Record<string, string> = {};
	for (const rawLine of text.split(/\r?\n/)) {
		if (!rawLine || rawLine.startsWith("#")) continue;
		const separator = rawLine.indexOf("=");
		if (separator <= 0) throw new Error("Invalid Codetonomy credentials file");
		const key = rawLine.slice(0, separator);
		const value = rawLine.slice(separator + 1);
		if (!SAFE_ENV.test(key) || /[\r\n]/.test(value)) throw new Error("Invalid Codetonomy credential entry");
		credentials[key] = value;
	}
	return credentials;
};

const readOptional = async (path: string, maxBytes: number): Promise<string | undefined> => {
	try {
		return await readBoundedUtf8(path, maxBytes, basename(path));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
};

const configurationRevision = (configText?: string, credentialText?: string): string =>
	createHash("sha256").update(configText ?? "").update("\0").update(credentialText ?? "").digest("hex");

export async function loadConfiguration(directory = defaultConfigurationDirectory()): Promise<ConfigurationState> {
	const [configText, credentialText] = await Promise.all([
		readOptional(join(directory, "config.json"), MAX_CONFIG_BYTES),
		readOptional(join(directory, "credentials.env"), MAX_CREDENTIAL_BYTES),
	]);
	return {
		configuration: configText ? validateConfiguration(JSON.parse(configText)) : emptyConfiguration(),
		credentials: credentialText ? parseCredentials(credentialText) : {},
		directory,
		revision: configurationRevision(configText, credentialText),
	};
}

export const writePrivateFile = async (path: string, text: string): Promise<void> => {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
	let handle;
	try {
		handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
		await handle.writeFile(text, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		await rename(temporary, path);
		await chmod(path, 0o600);
	} catch (error) {
		await handle?.close().catch(() => {});
		await unlink(temporary).catch(() => {});
		throw error;
	}
};

export async function saveConfiguration(state: ConfigurationState): Promise<void> {
	const configuration = validateConfiguration(state.configuration);
	const configText = `${JSON.stringify(configuration, null, 2)}\n`;
	if (Buffer.byteLength(configText) > MAX_CONFIG_BYTES) throw new Error("Codetonomy configuration exceeds the storage limit");
	// ponytail: optimistic conflict check; add a cross-process lock if concurrent setup becomes a real workflow.
	if (state.revision) {
		const [configText, credentialText] = await Promise.all([
			readOptional(join(state.directory, "config.json"), MAX_CONFIG_BYTES),
			readOptional(join(state.directory, "credentials.env"), MAX_CREDENTIAL_BYTES),
		]);
		if (configurationRevision(configText, credentialText) !== state.revision) {
			throw new Error("Configuration changed while setup was open. Reopen Codetonomy setup and try again.");
		}
	}
	const activeCredentials = new Set(configuration.providers.map(({ apiKeyEnv }) => apiKeyEnv));
	const credentialLines = Object.entries(state.credentials)
		.filter(([key, value]) => {
			if (!SAFE_ENV.test(key) || value.length > 16 * 1024 || /[\r\n]/.test(value)) throw new Error(`Invalid credential: ${key}`);
			return value.length > 0 && activeCredentials.has(key);
		})
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, value]) => `${key}=${value}`);
	const credentialText = credentialLines.length ? `${credentialLines.join("\n")}\n` : "";
	if (Buffer.byteLength(credentialText) > MAX_CREDENTIAL_BYTES) throw new Error("Codetonomy credentials exceed the storage limit");
	await writePrivateFile(join(state.directory, "credentials.env"), credentialText);
	await writePrivateFile(join(state.directory, "config.json"), configText);
	state.configuration = configuration;
	state.revision = configurationRevision(configText, credentialText);
}

export async function persistProviderSelection(state: ConfigurationState, selection: ProviderSelection): Promise<void> {
	if (selection.provider === "fixture") state.configuration = { ...state.configuration, defaultProvider: undefined };
	else {
		const provider = state.configuration.providers.find(({ id }) => id === selection.provider);
		if (!provider || !provider.models.includes(selection.modelId)) throw new Error(`Model ${selection.provider}/${selection.modelId} is not configured`);
		state.configuration = {
			...state.configuration,
			defaultProvider: provider.id,
			providers: state.configuration.providers.map((item) => item.id === provider.id ? { ...item, modelId: selection.modelId } : item),
		};
	}
	await saveConfiguration(state);
}

export const providerCompatibilityNotice = ({ provider, modelId }: ProviderSelection): string | undefined =>
	provider === "opencode-go" && ["deepseek-v4-flash", "deepseek-v4-pro"].includes(modelId)
		? "OpenCode Go currently has upstream reports of interrupted DeepSeek V4 tool calls and long streams; start a fresh session or use direct DeepSeek if it recurs."
		: undefined;

export function resolveProviderSelection(
	state: ConfigurationState,
	requestedProvider?: string,
	requestedModel?: string,
): ProviderSelection {
	const providerId = requestedProvider
		?? process.env.CODETONOMY_PROVIDER
		?? process.env.HARNESS_PROVIDER
		?? state.configuration.defaultProvider
		?? "fixture";
	if (providerId === "fixture") return { provider: "fixture", modelId: requestedModel ?? "faux-1" };
	const configured = state.configuration.providers.find(({ id }) => id === providerId);
	if (!configured) {
		const modelId = requestedModel ?? process.env.CODETONOMY_MODEL ?? process.env.HARNESS_MODEL ?? defaultModelForProvider(providerId);
		if (!modelId) throw new Error(`Provider ${providerId} is not configured. Run Codetonomy setup.`);
		const preset = PROVIDER_PRESETS.find(({ id }) => id === providerId);
		if (!preset) throw new Error(`Provider ${providerId} is not configured. Run Codetonomy setup.`);
		const apiKey = process.env[preset.apiKeyEnv];
		return {
			provider: providerId,
			modelId,
			providerConfiguration: {
				id: preset.id,
				name: preset.name,
				kind: preset.kind,
				...(preset.baseUrl ? { baseUrl: preset.baseUrl } : {}),
				...(apiKey ? { apiKey } : {}),
			},
		};
	}
	const apiKey = process.env[configured.apiKeyEnv] ?? state.credentials[configured.apiKeyEnv];
	const modelId = requestedModel ?? process.env.CODETONOMY_MODEL ?? process.env.HARNESS_MODEL ?? configured.modelId;
	if (!configured.models.includes(modelId)) {
		throw new Error(`Model ${modelId} is not selected for ${configured.name}. Run Codetonomy setup to refresh models.`);
	}
	return {
		provider: configured.id,
		modelId,
		providerConfiguration: {
			id: configured.id,
			name: configured.name,
			kind: configured.kind,
			...(configured.baseUrl ? { baseUrl: configured.baseUrl } : {}),
			...(apiKey ? { apiKey } : {}),
			...(configured.modelMetadata?.find(({ id }) => id === modelId) ? { modelMetadata: configured.modelMetadata.find(({ id }) => id === modelId)! } : {}),
		},
	};
}

export const apiKeyIsSet = (state: ConfigurationState, provider: ProviderSettings): boolean =>
	Boolean(apiKeyForProvider(state, provider));
