import { randomUUID } from "node:crypto";
import { mkdir, lstat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { Agent, type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";
import {
	createProvider,
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	lazyApi,
	type Api,
	type FauxResponseStep,
	type Model,
	type Provider,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { buildStableSystemPrompt, buildToolBundleHash, resolveCapabilities, stableHash, type ToolInterface, type WorkspaceSearchMode } from "@agent-harness/capability-compiler";
export type { ToolInterface } from "@agent-harness/capability-compiler";
import { compileContext, renderContextTail } from "@agent-harness/context-compiler";
import type { DocumentParseOptions } from "@agent-harness/document-ir";
import { redactAuditString, type ActivatedSkill, type CacheCapabilities, type ConversationProjection, type ConversationTurn, type HarnessEvent, type MemoryBackend, type ModelStreamUpdate, type ReasoningTrace, type RunArtifact, type RunModelContext, type RunObserver, type RunResult, type RunStore, type RunUsage, type TaskSpecification, type VerificationResult } from "@agent-harness/contracts";
import { getPermissionProfile, isPermissionMode, PermissionGate, type ApprovalHandler, type PermissionMode } from "@agent-harness/permissions";
import {
	normalizeWriteClaim,
	runOrchestration,
	type OrchestrationNode,
	type OrchestrationResult,
} from "@agent-harness/orchestration";
import { compileTask, type CompileTaskInput } from "@agent-harness/task-compiler";
import { RunTrace } from "@agent-harness/telemetry";
import { BashCommandPlanner, bashPermissionTarget, bashPermissionTargets, CODING_TOOL_IDS, createNativeBashArgv, resolveToolCacheDefinitions, resolveTools, type BashCommandPlan, type BashToolArguments, type DelegateTasksCallback, type WorkspaceSearchBackend } from "@agent-harness/tools";
import { commandMatches, verifyArtifacts, verifyOutput } from "@agent-harness/verifiers";
import { captureCacheShape, lookupAndStoreCacheShape } from "./cache-shape.js";
import { RunCheckpoint, writeRuntimeFileAtomically } from "./checkpoint.js";

export { previewCheckpoint, rewindCheckpoint, type CheckpointPreview, type RewindResult } from "./checkpoint.js";
export { isPermissionMode, permissionModes } from "@agent-harness/permissions";
export type { PermissionMode } from "@agent-harness/permissions";

export interface HarnessRunOptions extends CompileTaskInput {
	permissionMode?: PermissionMode;
	delegationDepth?: number;
	workspaceRoot?: string;
	traceDirectory?: string;
	provider?: string;
	modelId?: string;
	providerConfiguration?: HarnessProviderConfiguration;
	signal?: AbortSignal;
	activatedSkills?: ActivatedSkill[];
	observers?: RunObserver[];
	approve?: ApprovalHandler;
	conversation?: ConversationTurn[];
	sessionId?: string;
	providerFetch?: typeof globalThis.fetch;
	memoryBackend?: MemoryBackend;
	workspaceSearch?: WorkspaceSearchBackend;
	documentOptions?: DocumentParseOptions;
	contextTokenBudget?: number;
	presetId?: string;
	writePaths?: string[];
	verifiedDependencies?: ReadonlyMap<string, RunResult>;
	runStore?: RunStore;
	evaluationVariant?: HarnessEvaluationVariant;
	toolInterface?: ToolInterface;
	maxOutputTokens?: number;
	maxModelTurns?: number;
	maxToolCalls?: number;
	maxDurationMs?: number;
	runBudgetState?: { deadline: number; modelTurns: number; toolCalls: number };
	providerRetryLimit?: number;
	providerMaxRetryDelayMs?: number;
	maxCostUsd?: number;
	maxTotalTokens?: number;
	spendBudgetState?: RunSpendBudgetState;
	reasoningLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
	onStream?(update: ModelStreamUpdate): void;
	onProviderResponse?: (response: { status: number; headers: Record<string, string> }) => void | Promise<void>;
	images?: HarnessImageInput[];
}

export const resolveToolInterface = (options: Pick<HarnessRunOptions, "toolInterface" | "workspaceSearch">): ToolInterface =>
	options.toolInterface ?? (options.workspaceSearch ? "bash" : "structured");

export interface RunSpendBudgetState {
	maxCostUsd?: number;
	maxTotalTokens?: number;
	costUsd: number;
	totalTokens: number;
}

export interface HarnessImageInput { data: string; mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif" }

export type HarnessEvaluationVariant =
	| "RAW_MODEL"
	| "MODEL_TOOLS"
	| "MODEL_SKILLS"
	| "MODEL_SKILLS_TOOLS"
	| "MODEL_SKILLS_TOOLS_VERIFIERS"
	| "FULL_PRESET";

export interface AgentHarness {
	run(options: HarnessRunOptions): Promise<RunResult>;
}

export interface HarnessOrchestrationOptions extends Omit<HarnessRunOptions, "objective" | "files" | "presetId" | "writePaths" | "verifiedDependencies" | "delegationDepth"> {
	nodes: OrchestrationNode[];
	parentPermissionProfileId: "workspace-read" | "workspace-write";
	maximumParallelWriters?: number;
	delegationDepth?: number;
	synthesize?(verifiedChildren: ReadonlyMap<string, RunResult>, signal?: AbortSignal): Promise<string>;
	verifyFinal?(output: string, verifiedChildren: ReadonlyMap<string, RunResult>): Promise<VerificationResult>;
	onSubagentEvent?(type: Extract<import("@agent-harness/contracts").HarnessEventType, `subagent.${string}`>, data: Record<string, unknown>): void | Promise<void>;
}

export interface HarnessOrchestrationResult extends OrchestrationResult {
	runId: string;
	tracePath: string;
}

export type HarnessProviderKind =
	| "openai"
	| "anthropic"
	| "google"
	| "deepseek"
	| "openrouter"
	| "opencode"
	| "opencode-go"
	| "openai-compatible"
	| "anthropic-compatible";

export const cacheCapabilitiesForProvider = (kind: HarnessProviderKind | "fixture"): CacheCapabilities => ({
	strategies: kind === "anthropic" || kind === "anthropic-compatible"
		? ["EXPLICIT_BREAKPOINT"]
		: kind === "openai-compatible"
			? ["NO_PROVIDER_CACHE"]
			: ["AUTO_PREFIX"],
	supportsUsageReporting: true,
});

export interface HarnessProviderConfiguration {
	id: string;
	name: string;
	kind: HarnessProviderKind;
	baseUrl?: string;
	apiKey?: string;
	modelMetadata?: HarnessModelMetadata;
}

export interface HarnessModelMetadata {
	id: string;
	name: string;
	api: "anthropic-messages" | "google-generative-ai" | "openai-completions" | "openai-responses";
	reasoning: boolean;
	input: Array<"text" | "image">;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
}

const runtimeKnownSecrets = (configuration?: HarnessProviderConfiguration): string[] => [...new Set([
	...(configuration?.apiKey ? [configuration.apiKey] : []),
	...Object.entries(process.env).flatMap(([name, value]) => /(?:API_KEY|AUTH_TOKEN|OAUTH_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD)$/.test(name) && (value?.length ?? 0) >= 8 ? [value!] : []),
])];

const DEFAULT_MODELS: Record<string, string> = {
	fixture: "faux-1",
	openai: "gpt-5.4-mini",
	anthropic: "claude-sonnet-4-6",
	google: "gemini-3.5-flash",
	deepseek: "deepseek-v4-flash",
	openrouter: "~openai/gpt-mini-latest",
	opencode: "kimi-k2.6",
	"opencode-go": "kimi-k2.6",
};

const builtinProvider = (id: string): Provider | undefined => {
	switch (id) {
		case "openai": return openaiProvider();
		case "anthropic": return anthropicProvider();
		case "google": return googleProvider();
		case "deepseek": return deepseekProvider();
		case "openrouter": return openrouterProvider();
		case "opencode": return opencodeProvider();
		case "opencode-go": return opencodeGoProvider();
		default: return undefined;
	}
};

export const supportedModelsForProvider = (kind: HarnessProviderKind): string[] | undefined =>
	builtinProvider(kind)?.getModels().map(({ id }) => id);

const modelFromProvider = (provider: Provider, kind: HarnessProviderKind, modelId: string, metadata?: HarnessModelMetadata): Model<Api> | undefined => {
	const known = provider.getModels().find(({ id }) => id === modelId);
	if (!metadata || metadata.id !== modelId || kind !== "opencode-go") return known;
	const baseUrl = metadata.api === "anthropic-messages" ? "https://opencode.ai/zen/go" : "https://opencode.ai/zen/go/v1";
	const compat = known?.compat ?? (metadata.api === "openai-responses"
		? { sessionAffinityFormat: "openai-nosession" as const }
		: metadata.api === "openai-completions"
			? {
				supportsStore: false,
				supportsDeveloperRole: false,
				maxTokensField: "max_tokens" as const,
				...(modelId.startsWith("deepseek-") ? { requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "deepseek" as const } : {}),
				...(["qwen3.5-plus", "qwen3.6-plus"].includes(modelId) ? { thinkingFormat: "qwen" as const } : {}),
				...(modelId === "kimi-k2.6" ? { thinkingFormat: "deepseek" as const, supportsReasoningEffort: false } : {}),
			} : undefined);
	return {
		...known,
		...metadata,
		provider: provider.id,
		baseUrl,
		...(compat ? { compat } : {}),
	} as Model<Api>;
};

const validateProviderConfiguration = (configuration: HarnessProviderConfiguration): void => {
	if (!/^[a-z][a-z0-9-]{0,63}$/.test(configuration.id)) throw new Error(`Invalid provider id: ${configuration.id}`);
	if (!configuration.name.trim() || configuration.name.length > 80) throw new Error("Provider name must be 1-80 characters");
	if (configuration.apiKey && (configuration.apiKey.length > 16 * 1024 || /[\r\n]/.test(configuration.apiKey))) {
		throw new Error(`Invalid API key for ${configuration.id}`);
	}
	if (configuration.modelMetadata) {
		const model = configuration.modelMetadata;
		if (configuration.kind !== "opencode-go" || !/^[A-Za-z0-9~][A-Za-z0-9._:/~-]{0,191}$/.test(model.id) || !model.name.trim() || model.name.length > 160
			|| !["anthropic-messages", "google-generative-ai", "openai-completions", "openai-responses"].includes(model.api)
			|| !model.input.length || model.input.some((input) => input !== "text" && input !== "image")
			|| ![model.cost.input, model.cost.output, model.cost.cacheRead, model.cost.cacheWrite].every((value) => Number.isFinite(value) && value >= 0)
			|| !Number.isSafeInteger(model.contextWindow) || model.contextWindow < 1
			|| !Number.isSafeInteger(model.maxTokens) || model.maxTokens < 1 || model.maxTokens > model.contextWindow) {
			throw new Error(`Invalid model metadata for ${configuration.id}/${model.id}`);
		}
	}
	if (configuration.kind.endsWith("-compatible")) {
		if (!configuration.baseUrl) throw new Error(`${configuration.name} requires a base URL`);
		const url = new URL(configuration.baseUrl);
		if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Provider base URL must use HTTP or HTTPS");
		if (url.username || url.password || url.search || url.hash) throw new Error("Provider base URL cannot contain credentials, query parameters, or fragments");
		if (url.protocol === "http:" && !["127.0.0.1", "::1", "localhost"].includes(url.hostname)) throw new Error("Remote provider base URLs must use HTTPS");
	} else if (configuration.id !== configuration.kind) {
		throw new Error(`Built-in provider ${configuration.kind} must use id ${configuration.kind}`);
	}
};

const customProvider = (configuration: HarnessProviderConfiguration, modelId: string): Provider => {
	validateProviderConfiguration(configuration);
	const api: Api = configuration.kind === "anthropic-compatible" ? "anthropic-messages" : "openai-completions";
	const model: Model<Api> = {
		id: modelId,
		name: modelId,
		api,
		provider: configuration.id,
		baseUrl: configuration.baseUrl!,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 128_000,
	};
	return createProvider({
		id: configuration.id,
		name: configuration.name,
		baseUrl: configuration.baseUrl,
		auth: {
			apiKey: {
				name: `${configuration.name} API key`,
				resolve: async ({ credential, signal }) => {
					signal.throwIfAborted();
					return { auth: credential?.key ? { apiKey: credential.key } : {} };
				},
			},
		},
		models: [model],
		api: configuration.kind === "anthropic-compatible"
			? lazyApi(() => import("@earendil-works/pi-ai/api/anthropic-messages"))
			: lazyApi(() => import("@earendil-works/pi-ai/api/openai-completions")),
	});
};

export const modelSupportsImages = (providerId: string, modelId: string, configuration?: HarnessProviderConfiguration): boolean => {
	if (providerId === "fixture") return false;
	const kind = configuration?.kind ?? providerId as HarnessProviderKind;
	const provider = configuration?.kind.endsWith("-compatible")
		? customProvider(configuration, modelId)
		: builtinProvider(kind);
	return provider ? modelFromProvider(provider, kind, modelId, configuration?.modelMetadata)?.input.includes("image") ?? false : false;
};

export const defaultModelForProvider = (providerId: string): string | undefined => DEFAULT_MODELS[providerId];

const responseText = (message: AgentMessage | undefined): string => {
	if (!message || message.role !== "assistant") return "";
	return message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
};

const emptyUsage = (): RunUsage => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const DEFAULT_MAX_OUTPUT_TOKENS = 12_000;
const EVIDENCE_MAX_OUTPUT_TOKENS = 20_000;
const TOOL_CALL_MAX_OUTPUT_TOKENS = 32_000;
const FINAL_MAX_OUTPUT_TOKENS = 8_000;
const MAX_OUTPUT_TOKENS = 128_000;
const SESSION_OUTPUT_TOKEN_BUDGET = 96_000;
const EVALUATION_MAX_MODEL_TURNS = 12;
const EVALUATION_MAX_TOOL_CALLS = 30;
const MAX_REPAIR_ATTEMPTS = 2;
const MAX_CONVERSATION_BYTES = 192 * 1024;
const MAX_CONVERSATION_TURNS = 40;
const MAX_REASONING_CHARS = 64 * 1024;
const MAX_STREAM_TEXT_CHARS = 256 * 1024;
const WORKSPACE_INSPECTION_TOOLS = new Set(["list_workspace", "search_workspace", "inspect_workspace", "inspect_document", "inspect_workbook", "inspect_presentation", "inspect_backtest"]);
const WORKSPACE_WRITE_TOOLS = new Set(["write_workspace", "edit_workspace", "create_valuation_workbook", "create_presentation", "run_backtest"]);
const ACTION_NUDGE_TEXT = "Stop repeating workspace discovery. Use the appropriate write, edit, or command tool now for the next required action, then continue to completion. Do not return another plan.";
const FINALIZE_NUDGE_TEXT = "One model turn remains. Use the workspace evidence already collected and return the final answer now. Do not call more tools.";
const REPEATED_EVIDENCE_NUDGE_TEXT = "You are repeating an identical tool call and have gained no new evidence. Use a materially different source or return the final answer now; do not repeat the same call again.";
const TRUNCATION_ACTION_NUDGE_TEXT = "The next response must call the appropriate write, edit, or command tool for the next required workspace action. Do not return prose or another plan; continue until the task is complete.";
const TRUNCATION_DISCOVERY_NUDGE_TEXT = "The next response must call search_workspace or the narrowest available inspection tool immediately. Do not return prose or another plan; use the result to continue the task.";
const DEEPSEEK_PREFIX_CONTINUATION_TEXT = "Continue the preceding response exactly where it stopped.";

const deepSeekPrefixFetch = (fetcher: typeof fetch): typeof fetch => async (input, init) => {
	if (typeof init?.body !== "string") throw new Error("DeepSeek prefix continuation requires a JSON request body");
	const body = JSON.parse(init.body) as { messages?: Array<Record<string, unknown>> };
	const messages = body.messages;
	if (!messages?.length || messages.at(-1)?.role !== "user" || !JSON.stringify(messages.at(-1)?.content).includes(DEEPSEEK_PREFIX_CONTINUATION_TEXT)) {
		throw new Error("DeepSeek prefix continuation request is missing its internal marker");
	}
	messages.pop();
	const prefix = messages.at(-1);
	if (!prefix || prefix.role !== "assistant") throw new Error("DeepSeek prefix continuation requires an assistant response prefix");
	prefix.prefix = true;
	const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
	url.pathname = "/beta/chat/completions";
	return fetcher(url, { ...init, body: JSON.stringify(body) });
};

const evaluationFeatures = (variant: HarnessEvaluationVariant | undefined) => ({
	tools: variant === undefined || variant === "MODEL_TOOLS" || variant === "MODEL_SKILLS_TOOLS" || variant === "MODEL_SKILLS_TOOLS_VERIFIERS" || variant === "FULL_PRESET",
	skills: variant === undefined || variant === "MODEL_SKILLS" || variant === "MODEL_SKILLS_TOOLS" || variant === "MODEL_SKILLS_TOOLS_VERIFIERS" || variant === "FULL_PRESET",
	verifierFeedback: variant === undefined || variant === "MODEL_SKILLS_TOOLS_VERIFIERS" || variant === "FULL_PRESET",
	memory: variant === undefined || variant === "FULL_PRESET",
});

const evaluationSystemPrompt = (
	variant: HarnessEvaluationVariant | undefined,
	preset: import("@agent-harness/contracts").AgentPreset,
	tools: boolean,
	toolIds: string[] = preset.toolIds,
	canonicalToolIds: string[] = toolIds,
	searchMode: WorkspaceSearchMode = "literal",
): string => {
	if (!variant || (evaluationFeatures(variant).skills && tools)) return buildStableSystemPrompt(preset, toolIds, canonicalToolIds, searchMode);
	if (evaluationFeatures(variant).skills) return [
		"You are a model running in Codetonomy evaluation protocol v1.",
		`Apply preset ${preset.id}@${preset.version}: ${preset.purpose}.`,
		`Bundled skill identities: ${preset.coreSkillIds.join(", ") || "none"}.`,
		"Complete the task from the supplied prompt and context without external tools.",
		"Return the best final answer you can; independent deterministic checks will score it.",
	].join("\n");
	return [
		"You are a model running in Codetonomy evaluation protocol v1.",
		tools
			? "Use the provided tools when they are necessary to complete the task; do not claim unavailable tools are missing."
			: "Complete the task from the supplied prompt and context without external tools.",
		"Return the best final answer you can; independent deterministic checks will score it.",
	].join("\n");
};

const redactToolArgumentsForTrace = (toolId: string, args: unknown): unknown => {
	if (!args || typeof args !== "object" || Array.isArray(args)) return args;
	const fields = toolId === "write_workspace" ? ["content"] : toolId === "edit_workspace" ? ["oldText", "newText"] : [];
	if (!fields.length) return args;
	const safe = { ...(args as Record<string, unknown>) };
	for (const field of fields) if (typeof safe[field] === "string") {
		const value = safe[field];
		safe[field] = `[REDACTED ${Buffer.byteLength(value)} bytes sha256:${stableHash(value)}]`;
	}
	return safe;
};

export function projectConversation(
	turns: ConversationTurn[],
	maximumBytes = MAX_CONVERSATION_BYTES,
	maximumTurns = MAX_CONVERSATION_TURNS,
): ConversationProjection {
	if (!Number.isInteger(maximumBytes) || maximumBytes < 1 || !Number.isInteger(maximumTurns) || maximumTurns < 1) {
		throw new Error("Conversation projection limits must be positive integers");
	}
	const selected: ConversationTurn[] = [];
	let estimatedBytes = 2;
	for (let index = turns.length - 1; index >= 0 && selected.length < maximumTurns; index--) {
		const turn = turns[index]!;
		const bytes = Buffer.byteLength(JSON.stringify(turn)) + (selected.length ? 1 : 0);
		if (bytes + estimatedBytes > maximumBytes) break;
		selected.unshift(turn);
		estimatedBytes += bytes;
	}
	return {
		turns: selected,
		omittedTurns: turns.length - selected.length,
		estimatedBytes,
		projectionHash: stableHash(selected.map(({ runId, objective, output }) => ({ runId, objective, output }))),
	};
}

const addUsage = (total: RunUsage, message: AgentMessage): void => {
	if (message.role !== "assistant") return;
	total.input += message.usage.input;
	total.output += message.usage.output;
	total.cacheRead += message.usage.cacheRead;
	total.cacheWrite += message.usage.cacheWrite;
	total.totalTokens += message.usage.totalTokens;
	if (typeof message.usage.reasoning === "number") total.reasoning = (total.reasoning ?? 0) + message.usage.reasoning;
	if (total.cost) {
		total.cost.input += message.usage.cost.input;
		total.cost.output += message.usage.cost.output;
		total.cost.cacheRead += message.usage.cost.cacheRead;
		total.cost.cacheWrite += message.usage.cost.cacheWrite;
		total.cost.total += message.usage.cost.total;
	}
};

function fixtureResponses(task: TaskSpecification, workspaceRoot: string, skillIds: string[]): FauxResponseStep[] {
	const skillSummary = skillIds.length ? `\nActivated skills: ${skillIds.join(", ")}` : "";
	if (task.requiredCapabilities.includes("presentation-write")) {
		const outputPath = task.objective.match(/(?:^|\s)([A-Za-z0-9_./-]+\.pptx)\b/i)?.[1] ?? "output/presentation.pptx";
		return [
			fauxAssistantMessage(fauxToolCall("list_workspace", { path: ".", depth: 2, limit: 200 }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("create_presentation", {
				title: "Codetonomy Presentation",
				subtitle: task.objective.slice(0, 300),
				outputPath,
				slides: [
					{ role: "title", title: "Codetonomy Presentation", source: "Task requirements" },
					{ role: "summary", title: "Summary", bullets: [task.objective.slice(0, 300)], source: "Task requirements" },
					{ role: "sources", title: "Sources", bullets: ["Task requirements and inspected workspace evidence"] },
				],
			}), { stopReason: "toolUse" }),
			fauxAssistantMessage(`Created and verified the presentation at ${outputPath}.${skillSummary}`),
		];
	}
	if (task.requiredCapabilities.includes("backtesting-write")) {
		const input = task.inputs.find(({ value }) => value.toLowerCase().endsWith(".csv"));
		if (!input) return [fauxAssistantMessage("Backtesting requires an input CSV with date, open, and close columns.")];
		const outputPath = task.objective.match(/(?:^|\s)([A-Za-z0-9_./-]+\.json)\b/i)?.[1] ?? "output/backtest.json";
		return [
			fauxAssistantMessage(fauxToolCall("inspect_workspace", { path: relative(workspaceRoot, input.value), offset: 1, limit: 200 }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("run_backtest", {
				dataPath: relative(workspaceRoot, input.value),
				outputPath,
				shortWindow: 5,
				longWindow: 15,
				trainFraction: 0.7,
				commissionBps: 5,
				initialCapital: 100000,
			}), { stopReason: "toolUse" }),
			fauxAssistantMessage(`Created and verified the reproducible backtest at ${outputPath}.${skillSummary}`),
		];
	}
	if (task.requiredCapabilities.includes("subagent-delegation")) {
		return [
			fauxAssistantMessage(fauxToolCall("delegate_tasks", {
				nodes: [
					{ id: "alpha", objective: "Say alpha", presetId: "general-assistant", permissionProfileId: "workspace-read" },
					{ id: "beta", objective: "Say beta", presetId: "general-assistant", permissionProfileId: "workspace-read" },
				],
			}), { stopReason: "toolUse" }),
			(context) => {
				const result = context.messages.findLast((message) => message.role === "toolResult");
				const text = result?.role === "toolResult"
					? result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
					: "";
				return fauxAssistantMessage(fauxText(`Delegated verified child work.\n${text.slice(0, 4_000)}`));
			},
		];
	}
	if (!task.inputs.length) {
		if (task.requiredCapabilities.includes("workspace-inspection")) {
			return [
				fauxAssistantMessage(fauxToolCall("list_workspace", { path: ".", depth: 2, limit: 200 }), { stopReason: "toolUse" }),
				(context) => {
					const result = context.messages.findLast((message) => message.role === "toolResult");
					const text = result?.role === "toolResult"
						? result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
						: "";
					return fauxAssistantMessage(fauxText(`Inspected the workspace structure for: ${task.objective}${skillSummary}\n\n${text.slice(0, 4_000)}`));
				},
			];
		}
		return [
			fauxAssistantMessage(
				`Fixture agent completed: ${task.objective}${skillSummary}`,
			),
		];
	}

	const toolCalls = task.inputs.map((input) =>
		fauxToolCall("inspect_workspace", { path: relative(workspaceRoot, input.value) }),
	);
	return [
		fauxAssistantMessage(toolCalls, { stopReason: "toolUse" }),
		(context) => {
			const results = context.messages.filter((message) => message.role === "toolResult");
			const excerpts = task.inputs.map((input, index) => {
				const result = results[index];
				const text = result?.role === "toolResult"
					? result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
					: "";
				return `## ${basename(input.value)}\n\n${text.slice(0, 1200)}${text.length > 1200 ? "\n…" : ""}`;
			});
			return fauxAssistantMessage(
				fauxText(
					`Inspected ${task.inputs.length} file${task.inputs.length === 1 ? "" : "s"} for: ${task.objective}${skillSummary}\n\n${excerpts.join("\n\n")}`,
				),
			);
		},
	];
}

export function createHarness(): AgentHarness {
	return {
		async run(options) {
			if (options.signal?.aborted) throw new Error("Run aborted");
			const permissionMode = options.permissionMode ?? "ask";
			const toolInterface = resolveToolInterface(options);
			const searchMode: WorkspaceSearchMode = options.workspaceSearch ? "indexed" : "literal";
			if (!isPermissionMode(permissionMode)) throw new Error("Invalid permissionMode");
			if (toolInterface !== "structured" && toolInterface !== "bash") throw new Error("Invalid toolInterface");
			if (options.delegationDepth !== undefined && (!Number.isInteger(options.delegationDepth) || options.delegationDepth < 0 || options.delegationDepth > 1)) throw new Error("delegationDepth must be 0 or 1");
			if (options.maxOutputTokens !== undefined && (!Number.isInteger(options.maxOutputTokens) || options.maxOutputTokens < 1 || options.maxOutputTokens > MAX_OUTPUT_TOKENS)) throw new Error(`maxOutputTokens must be 1-${MAX_OUTPUT_TOKENS}`);
			if (options.maxModelTurns !== undefined && (!Number.isInteger(options.maxModelTurns) || options.maxModelTurns < 1 || options.maxModelTurns > 1_000)) throw new Error("maxModelTurns must be 1-1000");
			if (options.maxToolCalls !== undefined && (!Number.isInteger(options.maxToolCalls) || options.maxToolCalls < 1 || options.maxToolCalls > 10_000)) throw new Error("maxToolCalls must be 1-10000");
			if (options.providerRetryLimit !== undefined && (!Number.isInteger(options.providerRetryLimit) || options.providerRetryLimit < 0 || options.providerRetryLimit > 2)) throw new Error("providerRetryLimit must be 0-2");
			if (options.providerMaxRetryDelayMs !== undefined && (!Number.isInteger(options.providerMaxRetryDelayMs) || options.providerMaxRetryDelayMs < 1 || options.providerMaxRetryDelayMs > 60_000)) throw new Error("providerMaxRetryDelayMs must be 1-60000");
			if (options.maxCostUsd !== undefined && (!Number.isFinite(options.maxCostUsd) || options.maxCostUsd <= 0 || options.maxCostUsd > 1_000_000)) throw new Error("maxCostUsd must be greater than 0 and at most 1000000");
			if (options.maxTotalTokens !== undefined && (!Number.isSafeInteger(options.maxTotalTokens) || options.maxTotalTokens < 1 || options.maxTotalTokens > 1_000_000_000)) throw new Error("maxTotalTokens must be 1-1000000000");
			const spendBudget = options.spendBudgetState ?? { maxCostUsd: options.maxCostUsd, maxTotalTokens: options.maxTotalTokens, costUsd: 0, totalTokens: 0 };
			if (!Number.isFinite(spendBudget.costUsd) || spendBudget.costUsd < 0 || !Number.isSafeInteger(spendBudget.totalTokens) || spendBudget.totalTokens < 0
				|| (options.maxCostUsd !== undefined && spendBudget.maxCostUsd !== options.maxCostUsd)
				|| (options.maxTotalTokens !== undefined && spendBudget.maxTotalTokens !== options.maxTotalTokens)) throw new Error("Invalid aggregate spend budget state");
			const budgetLimitMessage = (): string | undefined => {
				if (spendBudget.maxCostUsd !== undefined && spendBudget.costUsd >= spendBudget.maxCostUsd) return `Aggregate cost ceiling reached ($${spendBudget.maxCostUsd})`;
				if (spendBudget.maxTotalTokens !== undefined && spendBudget.totalTokens >= spendBudget.maxTotalTokens) return `Aggregate token ceiling reached (${spendBudget.maxTotalTokens})`;
				return undefined;
			};
			if ((spendBudget.costUsd > 0 || spendBudget.totalTokens > 0) && budgetLimitMessage()) throw new Error(budgetLimitMessage());
			if (options.reasoningLevel !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh"].includes(options.reasoningLevel)) throw new Error("Invalid reasoningLevel");
			const maxModelTurns = options.maxModelTurns ?? (options.evaluationVariant ? EVALUATION_MAX_MODEL_TURNS : 100);
			const maxToolCalls = options.maxToolCalls ?? (options.evaluationVariant ? EVALUATION_MAX_TOOL_CALLS : 500);
			if (options.maxDurationMs !== undefined && (!Number.isSafeInteger(options.maxDurationMs) || options.maxDurationMs < 1 || options.maxDurationMs > 86_400_000)) throw new Error("maxDurationMs must be 1-86400000");
			const runBudget = options.runBudgetState ?? { deadline: Date.now() + (options.maxDurationMs ?? 1_800_000), modelTurns: 0, toolCalls: 0 };
			if (!Number.isFinite(runBudget.deadline) || !Number.isSafeInteger(runBudget.modelTurns) || !Number.isSafeInteger(runBudget.toolCalls) || runBudget.modelTurns < 0 || runBudget.toolCalls < 0) throw new Error("Invalid run budget state");
			if ((options.verifiedDependencies?.size ?? 0) > 3) throw new Error("A child run can receive at most 3 verified dependencies");
			const images = options.images ?? [];
			if (images.length > 8) throw new Error("A run can attach at most 8 images");
			let imageBytes = 0;
			for (const image of images) {
				if (!(["image/png", "image/jpeg", "image/webp", "image/gif"] as const).includes(image.mimeType)) throw new Error("Unsupported image type");
				if (!/^[A-Za-z0-9+/]+={0,2}$/.test(image.data)) throw new Error("Image data must be base64 encoded");
				imageBytes += Buffer.from(image.data, "base64").length;
			}
			if (imageBytes > 20 * 1024 * 1024) throw new Error("Attached images must total 20 MiB or less");
			const runStartedAt = performance.now();
			const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
			const providerId = options.provider ?? "fixture";
			const modelId = options.modelId ?? defaultModelForProvider(providerId);
			if (!modelId || !/^[A-Za-z0-9~][A-Za-z0-9._:/~-]{0,191}$/.test(modelId)) {
				throw new Error(`A valid model id is required for ${providerId}`);
			}
			if (options.providerConfiguration && options.providerConfiguration.id !== providerId) {
				throw new Error("Provider configuration does not match the selected provider");
			}
			const canonicalConversation = options.conversation ?? [];
			if (canonicalConversation.length > 50) throw new Error("Conversation history exceeds 50 turns");
			if (Buffer.byteLength(JSON.stringify(canonicalConversation)) > 1024 * 1024) throw new Error("Conversation history exceeds 1 MiB");
			for (const turn of canonicalConversation) {
				if (!turn.runId || !turn.objective.trim() || !turn.output.trim() || !Number.isFinite(turn.timestamp)) {
					throw new Error("Conversation history contains an invalid turn");
				}
			}
			const conversationProjection = projectConversation(canonicalConversation);
			const conversation = conversationProjection.turns;
			const features = evaluationFeatures(options.evaluationVariant);
			const providerCacheCapabilities = cacheCapabilitiesForProvider(options.providerConfiguration?.kind ?? (providerId as HarnessProviderKind | "fixture"));
			const activatedSkills = [...new Map((options.activatedSkills ?? []).map((skill) => [skill.id, skill])).values()];
			if (activatedSkills.length > 8) throw new Error("A run can activate at most 8 skills");
			let skillBytes = 0;
			for (const skill of activatedSkills) {
				if (!/^[A-Za-z][A-Za-z0-9:_-]{0,63}$/.test(skill.id)) throw new Error(`Invalid skill id: ${skill.id}`);
				if (skill.manifest) {
					if (skill.manifest.id !== skill.id) throw new Error(`Skill manifest id does not match ${skill.id}`);
					for (const entries of [
						skill.manifest.dependencies,
						skill.manifest.conflicts,
						skill.manifest.requiredCapabilities,
						skill.manifest.requiredTools,
						skill.manifest.requiredPermissions,
						skill.manifest.verifierIds,
					]) {
						if (!Array.isArray(entries) || entries.length > 32 || entries.some((entry) => typeof entry !== "string")) {
							throw new Error(`Invalid manifest for skill ${skill.id}`);
						}
					}
				}
				skillBytes += Buffer.byteLength(skill.instructions);
			}
			if (skillBytes > 128 * 1024) throw new Error("Activated skill instructions exceed 131072 bytes");
			const runId = randomUUID();
			const runDirectory = join(resolve(options.traceDirectory ?? ".harness/runs"), runId);
			const tracePath = join(runDirectory, "trace.jsonl");
			const knownSecrets = runtimeKnownSecrets(options.providerConfiguration);
			const trace = new RunTrace(runId, tracePath, options.observers, knownSecrets);
			const checkpoint = new RunCheckpoint(workspaceRoot, runId, join(runDirectory, "checkpoint.json"));
			let task: TaskSpecification | undefined;
			let runEventId: string | undefined;
			const deadlineController = new AbortController();
			const deadlineTimer = setTimeout(() => deadlineController.abort(new Error("Run deadline exceeded")), Math.max(0, runBudget.deadline - Date.now()));
			options = { ...options, signal: AbortSignal.any([deadlineController.signal, ...(options.signal ? [options.signal] : [])]) };

			try {
				const runEvent = await trace.emit("run.started", { repairSchemaVersion: 1, workspaceRoot, permissionMode, toolInterface, searchMode });
				runEventId = runEvent.eventId;
				const compiledTask = compileTask(options);
				task = compiledTask;
				const taskEvent = await trace.emit("task.compiled", { task: compiledTask }, runEventId);
				const selectedSkills = features.skills ? activatedSkills : [];
				let capabilities = resolveCapabilities(compiledTask, {
					providerId,
					modelId,
				}, selectedSkills.map(({ id }) => id), selectedSkills.flatMap(({ manifest }) => manifest ? [manifest] : []), {
					...(options.presetId ? { presetId: options.presetId } : {}),
					...(options.writePaths?.length ? { toolCeiling: CODING_TOOL_IDS.filter((id) => id !== "run_workspace_command") } : {}),
					delegationDepth: options.delegationDepth ?? 0,
					toolInterface,
					searchMode,
				});
				capabilities = { ...capabilities, preset: { ...capabilities.preset, cacheStrategy: providerCacheCapabilities.strategies[0]! } };
				const skillFingerprints = selectedSkills.map(({ id, instructions }) => ({ id, contentHash: stableHash(instructions) }));
				const conversationFingerprints = conversation.map(({ runId, objective, output }) => ({ runId, contentHash: stableHash({ objective, output }) }));
				const dependencyFingerprints = [...(options.verifiedDependencies ?? new Map()).entries()].map(([id, run]) => ({ id, runId: run.runId, verified: run.verification.passed, contentHash: stableHash({ output: run.output, artifacts: run.artifacts }) }));
				if (dependencyFingerprints.some(({ verified }) => !verified)) throw new Error("Only verified dependency results may enter a child context");
				const memoryEnabled = Boolean(options.memoryBackend && features.memory && capabilities.preset.memoryPolicy.enabled);
				const memoryTokenBudget = options.contextTokenBudget ?? capabilities.preset.memoryPolicy.tokenBudget;
				const memoryRecallEvent = memoryEnabled
					? await trace.emit("memory.recall.started", { tokenBudget: memoryTokenBudget, policy: capabilities.preset.memoryPolicy }, taskEvent.eventId)
					: undefined;
				let contextPacket;
				try {
					contextPacket = await compileContext({
						taskId: compiledTask.id,
						agentPresetId: capabilities.preset.id,
						query: compiledTask.objective,
						tokenBudget: memoryEnabled ? memoryTokenBudget : 0,
						memory: memoryEnabled ? options.memoryBackend : undefined,
						signal: options.signal,
					});
					if (memoryRecallEvent) await trace.emit("memory.recall.completed", {
						backend: options.workspaceSearch ? "memoryDB" : "configured",
						contextHash: contextPacket.contextHash,
						estimatedTokens: contextPacket.estimatedTokens,
						evidenceItems: contextPacket.evidence.length,
					}, memoryRecallEvent.eventId);
				} catch (error) {
					if (memoryRecallEvent) await trace.emit("memory.recall.failed", { message: error instanceof Error ? error.message : String(error) }, memoryRecallEvent.eventId);
					throw error;
				}
				capabilities = {
					...capabilities,
					toolIds: features.tools ? capabilities.toolIds : [],
					...(capabilities.canonicalToolIds ? { canonicalToolIds: features.tools ? capabilities.canonicalToolIds : [] } : {}),
					skillIds: features.skills ? capabilities.skillIds : [],
					permissionProfileId: features.tools ? capabilities.permissionProfileId : "workspace-read",
					skillPackHash: stableHash({ skillPackHash: capabilities.skillPackHash, activatedSkills: skillFingerprints }),
					contextPacketHash: stableHash({
						task: capabilities.contextPacketHash,
						activatedSkills: skillFingerprints,
						conversationProjection: conversationProjection.projectionHash,
						retrievedContext: contextPacket.contextHash,
						verifiedDependencies: dependencyFingerprints,
					}),
					runProfileHash: stableHash({
						runProfileHash: capabilities.runProfileHash,
						evaluationVariant: options.evaluationVariant ?? "FULL_PRESET",
						permissionMode,
						activatedSkills: skillFingerprints,
						conversation: conversationFingerprints,
						verifiedDependencies: dependencyFingerprints,
					}),
				};
				const availableCanonicalToolIds = new Set(capabilities.canonicalToolIds ?? capabilities.toolIds);
				const writeClaim = await normalizeWriteClaim(
					workspaceRoot,
					capabilities.permissionProfileId === "workspace-read" ? "workspace-read" : "workspace-write",
					features.tools ? options.writePaths : undefined,
				);
				if (options.evaluationVariant) capabilities = {
					...capabilities,
					toolBundleHash: buildToolBundleHash(capabilities.toolIds, capabilities.canonicalToolIds ?? capabilities.toolIds),
					cachePrefixHash: stableHash({
						providerId,
						modelId,
						systemPrompt: evaluationSystemPrompt(options.evaluationVariant, capabilities.preset, features.tools, capabilities.toolIds, capabilities.canonicalToolIds ?? capabilities.toolIds, searchMode),
						permissionProfileId: capabilities.permissionProfileId,
						toolIds: capabilities.toolIds,
					}),
				};
				const capabilityEvent = await trace.emit("capabilities.resolved", {
					capabilities,
					evaluationVariant: options.evaluationVariant ?? "FULL_PRESET",
					skillVersions: capabilities.skillIds.map((id) => {
						const skill = selectedSkills.find((candidate) => candidate.id === id);
						return { id, version: skill?.manifest?.version ?? "preset-bundled", ...(skill ? { contentHash: stableHash(skill.instructions) } : {}) };
					}),
					toolVersions: resolveToolCacheDefinitions(capabilities.toolIds).map((definition) => {
						const item = definition as { name?: string; version?: string };
						return { id: item.name, version: item.version };
					}),
					providerCacheCapabilities,
				}, taskEvent.eventId);
				const cacheLookup = await lookupAndStoreCacheShape(
					resolve(options.traceDirectory ?? ".harness/runs"),
					options.sessionId,
					captureCacheShape(providerId, modelId, capabilities),
				);
				await trace.emit("cache.lookup", {
					strategy: capabilities.preset.cacheStrategy,
					cachePrefixHash: capabilities.cachePrefixHash,
					toolBundleHash: capabilities.toolBundleHash,
					skillPackHash: capabilities.skillPackHash,
					status: cacheLookup.status,
				}, capabilityEvent.eventId);
				if (cacheLookup.status === "invalidated") {
					await trace.emit("cache.invalidated", { changed: cacheLookup.changed }, capabilityEvent.eventId);
				}
				await trace.emit("context.compiled", {
					inputCount: compiledTask.inputs.length,
					activatedSkills: skillFingerprints,
					conversationTurns: conversation.length,
					omittedConversationTurns: conversationProjection.omittedTurns,
					conversationProjectionHash: conversationProjection.projectionHash,
					verifiedDependencies: dependencyFingerprints,
					retrievedEvidenceItems: contextPacket.evidence.length,
					retrievedContextTokens: contextPacket.estimatedTokens,
					stablePrefixTokens: Math.ceil(Buffer.byteLength(evaluationSystemPrompt(options.evaluationVariant, capabilities.preset, features.tools, capabilities.toolIds, capabilities.canonicalToolIds ?? capabilities.toolIds, searchMode)) / 4),
					loadedSkillTokens: Math.ceil(skillBytes / 4),
					contextPacketHash: capabilities.contextPacketHash,
					stablePrefixHash: capabilities.cachePrefixHash,
				}, capabilityEvent.eventId);

				const models = createModels();
				let model;
				if (providerId === "fixture") {
					const faux = fauxProvider({ provider: providerId, tokensPerSecond: 500 });
					models.setProvider(faux.provider);
					faux.setResponses(fixtureResponses(compiledTask, workspaceRoot, selectedSkills.map(({ id }) => id)));
					model = faux.getModel(modelId);
				} else {
					const configured = options.providerConfiguration;
					const provider = configured?.kind.endsWith("-compatible")
						? customProvider(configured, modelId)
						: builtinProvider(configured?.kind ?? providerId);
					if (!provider) throw new Error(`Unknown provider: ${providerId}`);
					if (configured) validateProviderConfiguration(configured);
					models.setProvider(provider);
					model = modelFromProvider(provider, configured?.kind ?? providerId as HarnessProviderKind, modelId, configured?.modelMetadata);
				}
				if (!model) throw new Error(`Unknown ${providerId} model: ${modelId}`);
				if (images.length && !model.input.includes("image")) throw new Error(`Model ${providerId}/${modelId} does not support image input`);
				const explicitMaxOutputTokens = options.maxOutputTokens;
				const delegateTasks: DelegateTasksCallback | undefined = capabilities.toolIds.includes("delegate_tasks")
					? async (nodes, signal) => {
						if ((options.delegationDepth ?? 0) >= 1) throw new Error("Recursive delegation is disabled");
						if (capabilities.permissionProfileId !== "workspace-read" && capabilities.permissionProfileId !== "workspace-write") {
							throw new Error("Delegation requires a workspace permission profile");
						}
						const orchestration = await runHarnessOrchestration({
							workspaceRoot,
							traceDirectory: options.traceDirectory,
							provider: providerId,
							modelId,
							providerConfiguration: options.providerConfiguration,
							permissionMode,
							delegationDepth: options.delegationDepth ?? 0,
							nodes: nodes as OrchestrationNode[],
							parentPermissionProfileId: capabilities.permissionProfileId,
							signal,
							activatedSkills: options.activatedSkills,
							observers: options.observers,
							approve: options.approve,
							providerFetch: options.providerFetch,
							toolInterface: options.toolInterface,
							memoryBackend: options.memoryBackend,
							workspaceSearch: options.workspaceSearch,
							documentOptions: options.documentOptions,
							contextTokenBudget: options.contextTokenBudget,
							runStore: options.runStore,
							evaluationVariant: options.evaluationVariant,
							maxOutputTokens: options.maxOutputTokens,
							maxModelTurns,
							maxToolCalls,
							maxDurationMs: options.maxDurationMs,
							runBudgetState: runBudget,
							providerRetryLimit: options.providerRetryLimit,
							providerMaxRetryDelayMs: options.providerMaxRetryDelayMs,
							maxCostUsd: options.maxCostUsd,
							maxTotalTokens: options.maxTotalTokens,
							spendBudgetState: spendBudget,
							reasoningLevel: options.reasoningLevel,
							onStream: options.onStream,
							onProviderResponse: options.onProviderResponse,
						});
						return {
							output: orchestration.output,
							verificationPassed: orchestration.verification.passed,
							children: orchestration.children.map(({ id, status, run, error }) => ({
								id,
								status,
								...(run ? { runId: run.runId, output: run.output } : {}),
								...(error ? { error } : {}),
							})),
						};
					}
					: undefined;
				const bashPlanner = new BashCommandPlanner();
				const tools = resolveTools(capabilities.toolIds, workspaceRoot, {
					before: (path) => checkpoint.before(path),
					after: (path) => checkpoint.after(path),
					beforeWorkspace: () => checkpoint.beforeWorkspace(),
					afterWorkspace: () => checkpoint.afterWorkspace(),
					coverage: () => checkpoint.coverage(),
				}, writeClaim, options.workspaceSearch, options.documentOptions, {
					commandSandboxMode: permissionMode === "full-access" ? "full-access" : "workspace",
					bashCommandSandboxMode: permissionMode === "full-access"
						? "full-access"
						: capabilities.permissionProfileId === "workspace-read" ? "read-only" : "workspace",
					bashNativeOperationId: capabilities.permissionProfileId === "workspace-read" ? "inspect_workspace" : "run_workspace_command",
					bashAllowedCanonicalToolIds: capabilities.canonicalToolIds,
					bashPlanner,
					...(delegateTasks ? { delegateTasks } : {}),
				});
				const activeTools = tools.map((tool) => ({ ...tool, execute: async (...args: Parameters<typeof tool.execute>) => {
					options.signal?.throwIfAborted();
					dispatched.add(args[0]);
					try { return await tool.execute(...args); }
					catch (error) {
						const details = (error as { details?: Record<string, unknown> }).details;
						executionErrors.set(args[0], details ?? { code: (error as NodeJS.ErrnoException).code, executionOutcome: WORKSPACE_WRITE_TOOLS.has(canonicalToolIds.get(args[0]) ?? tool.name) || (canonicalToolIds.get(args[0]) ?? tool.name) === "run_workspace_command" ? "effects-unknown" : "known" });
						throw error;
					}
				} }));
				const approve = permissionMode === "ask" ? options.approve : async () => true;
				const gate = new PermissionGate(getPermissionProfile(capabilities.permissionProfileId), approve);
				const requestApiKey = options.providerConfiguration?.apiKey
					?? (options.providerConfiguration?.kind.endsWith("-compatible") ? "codetonomy-keyless" : undefined);
				let currentModelRequestId: string | undefined;
				let currentModelStartedAt = 0;
				let firstTokenSeen = false;
				let fatalRuntimeError: string | undefined;
				let modelOutputFailure: string | undefined;
				let turnBudgetExhausted = false;
				const recoverableToolErrors = new Map<string, { toolName: string; message: string; modelRequestId?: string; modelTurn: number; key: string; target?: string; obligationId?: string; eventId?: string; outcome: string; resolved?: boolean }>();
				const failureCounts = new Map<string, number>();
				const operationKeys = new Map<string, string>();
				const dispatched = new Set<string>();
				const executionErrors = new Map<string, Record<string, unknown>>();
				const fileEvidence: Array<{ target: string; action: "read" | "write" | "exists" | "delete"; callId: string; current: boolean; revision?: string }> = [];
				const targetPath = (args: unknown): string | undefined => {
					const value = args as { path?: unknown; outputPath?: unknown } | undefined;
					const path = value?.path ?? value?.outputPath;
					return typeof path === "string" ? resolve(workspaceRoot, path.replace(/^\/workspace(?:\/|$)/, "")) : undefined;
				};
				const revisionOf = async (target?: string): Promise<string> => {
					if (!target || relative(workspaceRoot, target).startsWith("..")) return "unknown";
					try { const info = await lstat(target); return stableHash({ size: info.size, mtime: info.mtimeMs, ctime: info.ctimeMs, ino: info.ino }); }
					catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unknown"; }
				};
				let workspaceRevision = 0;
				const obligationFor = (operation: string, target?: string) => {
					const action = WORKSPACE_WRITE_TOOLS.has(operation) ? "write" : operation === "inspect_workspace" ? "read" : operation === "run_workspace_command" ? "command" : undefined;
					const candidates = compiledTask.acceptanceCriteria.filter((criterion) => criterion.action === action);
					return candidates.find((criterion) => criterion.target === target && target) ?? (candidates.length === 1 ? candidates[0] : undefined);
				};
				const recordFatalRuntimeError = (message: string): void => {
					fatalRuntimeError ??= message;
				};
				const runtimeFailureMessage = (): string | undefined =>
					fatalRuntimeError ?? modelOutputFailure ?? [...recoverableToolErrors.values()].find(({ resolved }) => !resolved)?.message;
				let permissionDenied = false;
				let providerFailed = false;
				let finalMessage: AgentMessage | undefined;
				const usage = emptyUsage();
				const reasoning: ReasoningTrace[] = [];
				let currentReasoning = "";
				let currentReasoningTruncated = false;
				let currentText = "";
				let currentRequestMaxOutputTokens = explicitMaxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
				let modelContext: RunModelContext = { contextWindow: model.contextWindow, maxOutputTokens: currentRequestMaxOutputTokens, lastPromptTokens: 0 };
				const toolEventIds = new Map<string, string>();
				const toolStartedAt = new Map<string, number>();
				const toolModelRequestIds = new Map<string, string | undefined>();
				const toolArguments = new Map<string, unknown>();
				const canonicalToolIds = new Map<string, string>();
				const completedToolIds = new Set<string>();
				const successfulTurns = new Set<number>();
				const commandExitCodes: Array<number | null> = [];
				const commandRuns: Array<{ argv: string[]; exitCode: number | null }> = [];
				const toolArtifacts = new Map<string, RunArtifact>();
				const workspaceClaimCandidates: Array<{ path: string; architecturalLayer: string; symbols: string[]; minimum: number; maximum: number; unit: "tokens" | "results" }> = [];
				let modelTurns = 0;
				let toolCalls = 0;
				let currentRepairAttempt = 0;
				let previousPromptTokens = 0;
				let currentPromptKind: "initial" | "verification-repair" | "action-nudge" | "prefix-continuation" | "finalization-nudge" | "progress-nudge" = "initial";
				let lastModelOutcome: string | undefined;
				let modelOutputTruncations = 0;
				let actionNudgeIssued = false;
				let actionNudgeAttempts = 0;
				let proactiveActionNudgeIssued = false;
				let truncationActionNudgeIssued = false;
				let currentResponseToolCallSeen = false;
				let expandNextRequestForToolCall = false;
				let deepSeekPrefixContinuationPending = false;
				let deepSeekPrefixContinuationIssued = false;
				let deepSeekPrefixContinuationMaxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS;
				let currentActionNudgeTrigger: "proactive" | "truncation" | undefined;
				const seenToolCallSignatures = new Set<string>();
				let currentTurnHadNovelToolCall = false;
				let repeatedToolRounds = 0;
				let progressNudgeIssued = false;
				const markActionNudge = (trigger: "proactive" | "truncation"): void => {
					actionNudgeIssued = true;
					actionNudgeAttempts++;
					if (trigger === "proactive") proactiveActionNudgeIssued = true;
					else truncationActionNudgeIssued = true;
					currentActionNudgeTrigger = trigger;
					currentPromptKind = "action-nudge";
				};
				const conversationMessages: AgentMessage[] = conversation.flatMap((turn) => [
					{ role: "user" as const, content: turn.objective, timestamp: turn.timestamp },
					{
						role: "assistant" as const,
						content: [
							...(model.reasoning ? (turn.reasoning ?? []).filter(({ text }) => text.trim()).map(({ text }) => ({ type: "thinking" as const, thinking: text })) : []),
							{ type: "text" as const, text: turn.output },
						],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop" as const,
						timestamp: turn.timestamp,
					},
				]);
				const agent = new Agent({
					initialState: {
						systemPrompt: evaluationSystemPrompt(options.evaluationVariant, capabilities.preset, features.tools, capabilities.toolIds, capabilities.canonicalToolIds ?? capabilities.toolIds, searchMode),
						model,
						tools: activeTools,
						messages: conversationMessages,
						thinkingLevel: model.reasoning ? (options.reasoningLevel ?? "high") : "off",
					},
					streamFn: (selectedModel, context, streamOptions) => {
						options.signal?.throwIfAborted();
						if (Date.now() >= runBudget.deadline) throw new Error("Run deadline exceeded");
						if (runBudget.modelTurns >= maxModelTurns) { recordFatalRuntimeError(`Model turn budget exhausted (${maxModelTurns})`); throw new Error(fatalRuntimeError); }
						runBudget.modelTurns++;
						const budgetFailure = budgetLimitMessage();
						if (modelTurns > 0 && budgetFailure) throw new Error(budgetFailure);
						currentRequestMaxOutputTokens = Math.max(1, Math.min(nextMaxOutputTokens(), SESSION_OUTPUT_TOKEN_BUDGET - usage.output));
						expandNextRequestForToolCall = false;
						modelContext = { ...modelContext, maxOutputTokens: Math.max(modelContext.maxOutputTokens, currentRequestMaxOutputTokens) };
						const useDeepSeekPrefix = deepSeekPrefixContinuationPending;
						deepSeekPrefixContinuationPending = false;
						const providerFetch = options.providerFetch ?? globalThis.fetch;
						const nonThinkingActionNudge = currentPromptKind === "action-nudge"
							&& providerId === "opencode-go"
							&& modelId.startsWith("deepseek-");
						return models.streamSimple(selectedModel, context, {
							...streamOptions,
							signal: AbortSignal.any([options.signal!, ...(streamOptions?.signal ? [streamOptions.signal] : [])]),
							...(options.providerFetch || useDeepSeekPrefix ? { fetch: useDeepSeekPrefix ? deepSeekPrefixFetch(providerFetch) : providerFetch } : {}),
							...(requestApiKey ? { apiKey: requestApiKey } : {}),
							cacheRetention: providerCacheCapabilities.strategies.includes("NO_PROVIDER_CACHE") ? "none" : "short",
							onProviderAttempt: async (event) => {
								await trace.emit(event.phase === "retry" ? "provider.retry.scheduled" : `provider.attempt.${event.phase}`, { ...event, provider: providerId }, currentModelRequestId);
							},
							maxRetries: options.providerRetryLimit ?? 2,
							maxRetryDelayMs: options.providerMaxRetryDelayMs ?? 5_000,
							maxTokens: currentRequestMaxOutputTokens,
							...(currentPromptKind === "action-nudge" ? {
								toolChoice: "required" as const,
								...(nonThinkingActionNudge ? { reasoning: undefined } : {}),
							} : {}),
							...(options.onProviderResponse ? { onResponse: options.onProviderResponse } : {}),
						});
					},
					sessionId: options.sessionId ?? runId,
					toolExecution: "parallel",
					prepareNextTurnWithContext: ({ context, message }) => {
						const nextContext = { ...context, tools: activeTools };
						if (message.stopReason === "toolUse") {
							repeatedToolRounds = currentTurnHadNovelToolCall ? 0 : repeatedToolRounds + 1;
						}
						if (message.stopReason === "length" && currentResponseToolCallSeen && canIssueTruncationActionNudge()) {
							markActionNudge("truncation");
							return {
								context: {
									...nextContext,
									messages: [
										...context.messages.map((entry) => entry === message
											? { ...message, content: message.content.filter(({ type }) => type !== "thinking") }
											: entry),
										{ role: "user" as const, content: [{ type: "text" as const, text: hasWorkspaceEvidence() ? TRUNCATION_ACTION_NUDGE_TEXT : TRUNCATION_DISCOVERY_NUDGE_TEXT }], timestamp: Date.now() },
									],
								},
								thinkingLevel: "off",
							};
						}
						if (message.stopReason === "toolUse" && repeatedToolRounds >= 2 && !progressNudgeIssued
							&& (maxModelTurns === undefined || modelTurns < maxModelTurns - 1)) {
							progressNudgeIssued = true;
							currentPromptKind = "progress-nudge";
							return {
								context: {
									...nextContext,
									messages: [...context.messages, { role: "user" as const, content: [{ type: "text" as const, text: REPEATED_EVIDENCE_NUDGE_TEXT }], timestamp: Date.now() }],
								},
							};
						}
						if (message.stopReason === "toolUse" && modelTurns >= 4 && (maxModelTurns === undefined || modelTurns < maxModelTurns) && canIssueProactiveActionNudge()) {
							markActionNudge("proactive");
							return {
								context: {
									...nextContext,
									messages: [...context.messages, { role: "user" as const, content: [{ type: "text" as const, text: ACTION_NUDGE_TEXT }], timestamp: Date.now() }],
								},
							};
						}
						if (message.stopReason === "toolUse" && maxModelTurns !== undefined && modelTurns === maxModelTurns - 1 && !isActionTask && hasWorkspaceEvidence()) {
							currentPromptKind = "finalization-nudge";
							return {
								context: {
									...nextContext,
									messages: [...context.messages, { role: "user" as const, content: [{ type: "text" as const, text: FINALIZE_NUDGE_TEXT }], timestamp: Date.now() }],
								},
							};
						}
						return { context: nextContext };
					},
					shouldStopAfterTurn: ({ message }) => {
						if (fatalRuntimeError || modelOutputFailure || options.signal?.aborted) return true;
						if (message.stopReason === "length" && currentResponseToolCallSeen && currentPromptKind !== "action-nudge") return true;
						const budgetFailure = budgetLimitMessage();
						if (budgetFailure && message.stopReason === "toolUse") {
							modelOutputFailure = budgetFailure;
							return true;
						}
						if (usage.output >= SESSION_OUTPUT_TOKEN_BUDGET && message.stopReason === "toolUse") {
							modelOutputFailure = `Session output budget reached (${SESSION_OUTPUT_TOKEN_BUDGET} tokens)`;
							return true;
						}
						if (maxModelTurns === undefined || modelTurns < maxModelTurns || message.stopReason !== "toolUse") return false;
						turnBudgetExhausted = true;
						return true;
					},
					beforeToolCall: async ({ toolCall, args }) => {
						options.signal?.throwIfAborted();
						if (Date.now() >= runBudget.deadline || runBudget.toolCalls >= maxToolCalls) {
							recordFatalRuntimeError(Date.now() >= runBudget.deadline ? "Run deadline exceeded" : `Tool-call budget exceeded (${maxToolCalls})`);
							return { block: true, terminate: true, reason: fatalRuntimeError };
						}
						runBudget.toolCalls++;
						toolCalls++;
						const toolCallSignature = stableHash({ toolId: toolCall.name, arguments: args });
						if (!seenToolCallSignatures.has(toolCallSignature)) {
							seenToolCallSignatures.add(toolCallSignature);
							currentTurnHadNovelToolCall = true;
						}
						let permissionToolId = toolCall.name;
						let operationToolId = toolCall.name;
						let permissionArguments = args;
						let bashTargets: ReturnType<typeof bashPermissionTargets> | undefined;
						let bashPlan: BashCommandPlan | undefined;
						let bashOperationUnavailable = false;
						if (toolCall.name === "bash") {
							const bashArgs = args as BashToolArguments;
							const nativeOperationId = capabilities.permissionProfileId === "workspace-read" ? "inspect_workspace" : "run_workspace_command";
							const useNativeBash = () => {
								permissionToolId = nativeOperationId;
								operationToolId = nativeOperationId;
								permissionArguments = nativeOperationId === "run_workspace_command"
									? { argv: createNativeBashArgv(bashArgs.command), cwd: bashArgs.cwd ?? ".", timeoutSeconds: bashArgs.timeoutSeconds ?? 120 }
									: { path: bashArgs.cwd ?? "." };
								bashTargets = [{ toolId: nativeOperationId, arguments: permissionArguments as Record<string, unknown> }];
								bashOperationUnavailable = !availableCanonicalToolIds.has(permissionToolId);
								canonicalToolIds.set(toolCall.id, operationToolId);
							};
							bashPlan = bashPlanner.plan(toolCall.id, bashArgs);
							if (bashPlan.route !== "translated") useNativeBash();
							else {
								const operation = bashPlan.operation;
								bashTargets = bashPermissionTargets(operation);
								const target = bashPermissionTarget(operation);
								permissionToolId = target.toolId;
								operationToolId = operation.kind === "pwd" ? "bash.pwd" : target.toolId;
								permissionArguments = target.arguments;
								bashOperationUnavailable = bashTargets.some(({ toolId }) => !availableCanonicalToolIds.has(toolId));
								canonicalToolIds.set(toolCall.id, operationToolId);
							}
						}
						const target = targetPath(permissionArguments);
						const operationKey = stableHash({ operation: operationToolId, args: { ...(permissionArguments as Record<string, unknown>), ...(target ? { path: target } : {}) }, target, revision: target ? await revisionOf(target) : workspaceRevision });
						operationKeys.set(toolCall.id, operationKey);
						toolArguments.set(toolCall.id, permissionArguments);
						if ((failureCounts.get(operationKey) ?? 0) >= 3) {
							recordFatalRuntimeError("Repeated unchanged operation failed three times");
							return { block: true, terminate: true, reason: fatalRuntimeError };
						}
						const uncertain = [...recoverableToolErrors.values()].find((failure) => !failure.resolved && failure.outcome === "effects-unknown" && failure.toolName === operationToolId);
						if (uncertain && (operationToolId === "run_workspace_command" || uncertain.target === target)) return { block: true, reason: "Previous mutation has unknown effects. Reconcile its state before another mutation; arbitrary commands cannot be safely replayed." };
						const command = bashPlan && bashPlan.route !== "parse-fallback" && bashPlan.operation.kind === "command" ? bashPlan.operation.argv : (permissionArguments as { argv?: string[] }).argv;
						if (compiledTask.prohibitions?.some((prohibition) => prohibition.action === "write" ? WORKSPACE_WRITE_TOOLS.has(operationToolId) && prohibition.target === target : operationToolId === "run_workspace_command" && (!command || !prohibition.command || commandMatches(command, prohibition.command, true) || /^(?:bash|sh|zsh|fish|cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh(?:\.exe)?|env|command|timeout)$/.test(basename(command[0] ?? "")) || toolCall.name === "bash" && bashPlan?.route === "parse-fallback"))) {
							recordFatalRuntimeError("Operation violates an explicit task prohibition");
							return { block: true, terminate: true, reason: fatalRuntimeError };
						}
						const requested = await trace.emit(
							"tool.requested",
							{
								toolId: toolCall.name,
								toolCallId: toolCall.id,
								arguments: redactToolArgumentsForTrace(toolCall.name, args),
								...(operationToolId !== toolCall.name ? { operationId: operationToolId } : {}),
								...(permissionToolId !== operationToolId ? { permissionTargetId: permissionToolId } : {}),
								...(bashTargets && bashTargets.length > 1 ? { permissionTargetIds: bashTargets.map(({ toolId }) => toolId) } : {}),
								...(bashPlan ? { parseStatus: bashPlan.route, planReason: bashPlan.reason } : {}),
							},
							currentModelRequestId,
						);
						toolEventIds.set(toolCall.id, requested.eventId);
						const bashGateResult = bashTargets && !bashOperationUnavailable
							&& !(permissionToolId === "run_workspace_command" && options.writePaths?.length)
							? (await Promise.all(bashTargets.map((target) => gate.check({ toolId: target.toolId, arguments: target.arguments, riskClass: compiledTask.riskClass }, options.signal)))).find(({ allowed }) => !allowed)
								?? { allowed: true, decision: "ALLOW" as const, reason: "All Bash operations are allowed by the permission profile" }
							: undefined;
						const result = maxToolCalls !== undefined && toolCalls > maxToolCalls
							? { allowed: false, decision: "DENY" as const, reason: `Tool-call budget exceeded (${maxToolCalls})` }
							: bashOperationUnavailable
								? { allowed: false, decision: "DENY" as const, reason: "One or more Bash operations are unavailable in this tool profile" }
							: toolCall.name === "bash" && permissionToolId === "run_workspace_command" && options.writePaths?.length
								? { allowed: false, decision: "DENY" as const, reason: "This bounded worker cannot run workspace commands" }
							: bashGateResult ?? await gate.check({ toolId: permissionToolId, arguments: permissionArguments, riskClass: compiledTask.riskClass }, options.signal);
						const permission = await trace.emit(
							result.allowed ? "tool.allowed" : "tool.denied",
							{
								toolId: toolCall.name,
								toolCallId: toolCall.id,
								decision: result.decision,
								reason: result.reason,
								...(operationToolId !== toolCall.name ? { operationId: operationToolId } : {}),
								...(permissionToolId !== operationToolId ? { permissionTargetId: permissionToolId } : {}),
							},
							requested.eventId,
						);
						options.signal?.throwIfAborted();
						if (result.allowed) {
							const started = await trace.emit(
								"tool.started",
								{ toolId: toolCall.name, toolCallId: toolCall.id, ...(operationToolId !== toolCall.name ? { operationId: operationToolId } : {}) },
								permission.eventId,
							);
							toolEventIds.set(toolCall.id, started.eventId);
							toolStartedAt.set(toolCall.id, performance.now());
							toolModelRequestIds.set(toolCall.id, currentModelRequestId);
						} else {
							recordFatalRuntimeError(result.reason);
							permissionDenied = true;
							bashPlanner.forget(toolCall.id);
						}
						return result.allowed ? undefined : { block: true, reason: result.reason, terminate: true };
					},
					afterToolCall: async ({ toolCall, result, isError }) => {
						const details = { ...(result.details as Record<string, unknown>), ...executionErrors.get(toolCall.id) };
						const target = targetPath(toolArguments.get(toolCall.id));
						if (isError && details.code === "ENOENT" && compiledTask.acceptanceCriteria.some((criterion) => criterion.action === "exists" && criterion.target === target) && await revisionOf(target) === "absent") return {
							isError: false, content: [{ type: "text", text: "The requested file is absent. This does not establish a successful read or write." }], details: { ...details, path: target, evidenceAction: "exists", exists: false },
						};
						const failed = isError || (typeof details.exitCode === "number" && details.exitCode !== 0);
						const outcome = typeof details.exitCode === "number" && details.exitCode !== 0 ? "effects-unknown" : details.executionOutcome ?? (dispatched.has(toolCall.id) ? "known" : "rejected-before-start");
						return { isError: failed, ...(outcome === "effects-unknown" ? { content: [...result.content, { type: "text" as const, text: `Effects of ${toolCall.name} are uncertain. Reconcile current state before repeating this mutation.` }] } : {}), details: { ...details, executionOutcome: outcome } };
					},
				});

				agent.subscribe(async (event: AgentEvent) => {
					if (event.type === "turn_start") {
						modelTurns++;
						currentTurnHadNovelToolCall = false;
						currentModelStartedAt = performance.now();
						const modelEvent = await trace.emit(
							"model.request.started",
							{ provider: providerId, model: model.id, turn: modelTurns, ...(maxModelTurns === undefined ? { stoppingMode: "automatic" } : { maxModelTurns }), contextWindow: model.contextWindow, maxOutputTokens: nextMaxOutputTokens(), lastPromptTokens: modelContext.lastPromptTokens, cacheStrategy: capabilities.preset.cacheStrategy, attempt: currentRepairAttempt, promptKind: currentPromptKind, actionNudge: currentPromptKind === "action-nudge", ...(currentActionNudgeTrigger ? { actionNudgeTrigger: currentActionNudgeTrigger } : {}) },
							runEventId,
						);
						currentModelRequestId = modelEvent.eventId;
						firstTokenSeen = false;
						currentReasoning = "";
						currentReasoningTruncated = false;
						currentText = "";
						currentResponseToolCallSeen = false;
					}
					if (event.type === "message_update") {
						const providerEvent = event.assistantMessageEvent;
						if (providerEvent.type === "thinking_delta" && providerEvent.delta) {
							const remaining = MAX_REASONING_CHARS - currentReasoning.length;
							if (remaining > 0) currentReasoning += providerEvent.delta.slice(0, remaining);
							if (providerEvent.delta.length > remaining) currentReasoningTruncated = true;
							options.onStream?.({ kind: "reasoning", text: redactAuditString(currentReasoning, knownSecrets) });
						}
						if (providerEvent.type === "text_delta" && providerEvent.delta) {
							currentText += providerEvent.delta.slice(0, Math.max(0, MAX_STREAM_TEXT_CHARS - currentText.length));
							options.onStream?.({ kind: "text", text: redactAuditString(currentText, knownSecrets) });
						}
						if (providerEvent.type === "toolcall_end") currentResponseToolCallSeen = true;
						if (!firstTokenSeen &&
							(providerEvent.type === "text_delta" || providerEvent.type === "thinking_delta" || providerEvent.type === "toolcall_delta") &&
							providerEvent.delta
						) {
							firstTokenSeen = true;
							await trace.emit("model.first_token", {
								kind: providerEvent.type,
								latencyMs: Math.round((performance.now() - currentModelStartedAt) * 100) / 100,
							}, currentModelRequestId);
						}
					}
					if (event.type === "message_end" && event.message.role === "assistant") {
						finalMessage = event.message;
						addUsage(usage, event.message);
						spendBudget.totalTokens += event.message.usage.totalTokens;
						spendBudget.costUsd += event.message.usage.cost.total;
						if (spendBudget.maxTotalTokens !== undefined && spendBudget.totalTokens > spendBudget.maxTotalTokens) modelOutputFailure = `Aggregate token ceiling exceeded (${spendBudget.totalTokens}/${spendBudget.maxTotalTokens})`;
						if (spendBudget.maxCostUsd !== undefined && spendBudget.costUsd > spendBudget.maxCostUsd) modelOutputFailure = `Aggregate cost ceiling exceeded ($${spendBudget.costUsd.toFixed(6)}/$${spendBudget.maxCostUsd})`;
						const modelError = event.message.errorMessage;
						const modelOutcome = modelError
							? event.message.stopReason === "aborted" ? "aborted" : "provider-error"
							: event.message.stopReason === "length" ? "max-output" : event.message.stopReason;
						lastModelOutcome = modelOutcome;
						if (event.message.stopReason === "length") {
							modelOutputTruncations++;
							expandNextRequestForToolCall = currentResponseToolCallSeen;
						}
						const promptTokens = event.message.usage.input + event.message.usage.cacheRead;
						const promptGrowthTokens = modelError ? 0 : promptTokens - previousPromptTokens;
						if (!modelError) {
							previousPromptTokens = promptTokens;
							modelContext = { ...modelContext, lastPromptTokens: promptTokens };
						}
						if (currentReasoning.trim()) {
							const item = { text: redactAuditString(currentReasoning, knownSecrets), truncated: currentReasoningTruncated };
							reasoning.push(item);
							await trace.emit("model.reasoning.completed", item, currentModelRequestId);
						}
						if (modelError) {
							recordFatalRuntimeError(redactAuditString(modelError, knownSecrets));
							providerFailed = true;
						}
						if (event.message.usage.cacheRead > 0) {
							await trace.emit("cache.read", { tokens: event.message.usage.cacheRead }, currentModelRequestId);
						}
						if (event.message.usage.cacheWrite > 0) {
							await trace.emit("cache.write", { tokens: event.message.usage.cacheWrite }, currentModelRequestId);
						}
						await trace.emit(modelError ? "model.request.failed" : "model.request.completed", {
							provider: providerId,
							model: model.id,
							turn: modelTurns,
							...(maxModelTurns === undefined ? { stoppingMode: "automatic" } : { maxModelTurns }),
							maxOutputTokens: currentRequestMaxOutputTokens,
							stopReason: event.message.stopReason,
							outcome: modelOutcome,
							promptKind: currentPromptKind,
							actionNudge: currentPromptKind === "action-nudge",
							...(currentActionNudgeTrigger ? { actionNudgeTrigger: currentActionNudgeTrigger } : {}),
							promptTokens,
							promptGrowthTokens,
							turnBudgetExhausted: maxModelTurns !== undefined && modelTurns >= maxModelTurns && event.message.stopReason === "toolUse",
							usage: event.message.usage,
							durationMs: Math.round((performance.now() - currentModelStartedAt) * 100) / 100,
						}, currentModelRequestId);
						currentPromptKind = currentRepairAttempt === 0 ? "initial" : "verification-repair";
						currentActionNudgeTrigger = undefined;
					}
					if (event.type === "tool_execution_start") {
						if (!toolArguments.has(event.toolCallId)) toolArguments.set(event.toolCallId, event.args);
						toolStartedAt.set(event.toolCallId, performance.now());
						toolModelRequestIds.set(event.toolCallId, currentModelRequestId);
					}
					if (event.type === "tool_execution_end") {
						const modelRequestId = toolModelRequestIds.get(event.toolCallId) ?? currentModelRequestId;
						const resultDetails = (event.result as { details?: Record<string, unknown> } | undefined)?.details;
						const resultContent = (event.result as { content?: Array<{ type?: string; text?: string }> } | undefined)?.content;
						const errorMessage = event.isError
							? redactAuditString(resultContent?.find(({ type, text }) => type === "text" && text)?.text ?? `Tool ${event.toolName} failed`, knownSecrets).slice(0, 2_000)
							: undefined;
						const canonicalToolId = typeof resultDetails?.operationId === "string"
							? resultDetails.operationId
							: canonicalToolIds.get(event.toolCallId) ?? event.toolName;
						let parentEventId = toolEventIds.get(event.toolCallId);
						if (!parentEventId) {
							if (!operationKeys.has(event.toolCallId)) { runBudget.toolCalls++; toolCalls++; }
							const requested = await trace.emit("tool.requested", {
								toolId: event.toolName,
								toolCallId: event.toolCallId,
								arguments: redactToolArgumentsForTrace(event.toolName, toolArguments.get(event.toolCallId)),
							}, modelRequestId);
							parentEventId = requested.eventId;
							toolEventIds.set(event.toolCallId, parentEventId);
						}
						const target = targetPath(toolArguments.get(event.toolCallId));
						const obligation = obligationFor(canonicalToolId, target);
						const key = operationKeys.get(event.toolCallId) ?? stableHash({ operation: canonicalToolId, args: toolArguments.get(event.toolCallId) });
						const outcome = String(resultDetails?.executionOutcome ?? "rejected-before-start");
						if (event.isError && !activeTools.some(({ name }) => name === event.toolName)) {
							recordFatalRuntimeError(errorMessage ?? `Tool ${event.toolName} not found`);
						} else if (event.isError) {
							failureCounts.set(key, (failureCounts.get(key) ?? 0) + 1);
							recoverableToolErrors.set(event.toolCallId, { toolName: canonicalToolId, message: errorMessage ?? `Tool ${event.toolName} failed`, modelRequestId, modelTurn: modelTurns, key, target, obligationId: obligation?.id, outcome });
						} else {
							const resultPaths = Array.isArray(resultDetails?.paths) ? resultDetails.paths : [resultDetails?.path];
							for (const path of resultPaths) if (typeof path === "string") {
								const actualTarget = targetPath({ path })!;
								const action = resultDetails?.evidenceAction === "exists" || compiledTask.acceptanceCriteria.some((criterion) => criterion.action === "exists" && criterion.target === actualTarget) ? "exists" : WORKSPACE_WRITE_TOOLS.has(canonicalToolId) ? "write" : "read";
								const revision = await revisionOf(actualTarget);
								fileEvidence.push({ target: actualTarget, action, callId: event.toolCallId, current: revision !== "unknown" && (action === "exists" || revision !== "absent") && (action !== "write" || resultDetails?.changed !== false), revision });
								if (action === "write") workspaceRevision++;
							}

							completedToolIds.add(canonicalToolId);
							successfulTurns.add(modelTurns);
							if (canonicalToolId === "search_workspace") {
								const candidates = resultDetails?.claimCandidates;
								if (Array.isArray(candidates)) for (const candidate of candidates.slice(0, 20)) {
									if (!candidate || typeof candidate !== "object") continue;
									const item = candidate as Record<string, unknown>;
									if (typeof item.path === "string" && typeof item.architecturalLayer === "string" && Array.isArray(item.symbols)
										&& item.symbols.every((symbol) => typeof symbol === "string") && typeof item.minimum === "number" && typeof item.maximum === "number"
										&& (item.unit === "tokens" || item.unit === "results")) workspaceClaimCandidates.push(item as typeof workspaceClaimCandidates[number]);
								}
							}
							if (canonicalToolId === "run_workspace_command") {
								for (const path of Array.isArray(resultDetails?.changedPaths) ? resultDetails.changedPaths : []) {
									if (typeof path !== "string") continue;
									const target = targetPath({ path })!;
									const revision = await revisionOf(target);
									fileEvidence.push({ target, action: revision === "absent" ? "delete" : "write", callId: event.toolCallId, current: revision !== "unknown", revision });
									workspaceRevision++;
								}
								const exitCode = resultDetails?.exitCode;
								if (exitCode === null || typeof exitCode === "number") {
									commandExitCodes.push(exitCode);
									if (Array.isArray(resultDetails?.argv) && resultDetails.argv.every((value) => typeof value === "string")) {
										commandRuns.push({ argv: (Array.isArray(resultDetails.semanticArgv) ? resultDetails.semanticArgv : resultDetails.argv) as string[], exitCode });
									}
								}
							}
						}
						if (parentEventId) {
							const completedEvent = await trace.emit(event.isError ? "tool.failed" : "tool.completed", {
								toolId: event.toolName,
								toolCallId: event.toolCallId,
								...(canonicalToolId !== event.toolName ? { operationId: canonicalToolId } : {}),
								durationMs: Math.round((performance.now() - (toolStartedAt.get(event.toolCallId) ?? performance.now())) * 100) / 100,
								outputBytes: Buffer.byteLength(JSON.stringify(event.result ?? null)),
								...(errorMessage ? { message: errorMessage, failureId: event.toolCallId, obligationId: obligation?.id, operationFingerprint: key, repairClass: outcome === "rejected-before-start" ? "representation" : "execution", argumentParseStatus: errorMessage?.includes("Invalid final tool JSON") ? "invalid" : undefined, failureAttempt: failureCounts.get(key) } : {}),
								executionOutcome: outcome,
								...(canonicalToolId === "search_workspace" && !event.isError
									? {
										backend: resultDetails?.backend ?? "literal",
										budgetExhausted: resultDetails?.budgetExhausted === true,
									}
									: {}),
								...(canonicalToolId === "run_workspace_command" && !event.isError
									? { exitCode: resultDetails?.exitCode }
									: {}),
							}, parentEventId);
							const currentFailure = recoverableToolErrors.get(event.toolCallId);
							if (currentFailure) currentFailure.eventId = completedEvent.eventId;
							if (!event.isError) for (const [callId, failure] of recoverableToolErrors) {
								if (failure.resolved || failure.modelRequestId === modelRequestId || !failure.eventId) continue;
								const criterion = compiledTask.acceptanceCriteria.find(({ id }) => id === failure.obligationId);
								const fulfilled = criterion && verifyOutput("Evidence", undefined, { task: { ...compiledTask, acceptanceCriteria: [criterion] }, fileEvidence, commandRuns }).checks.some(({ id, passed }) => id === criterion.id && passed);
								const sameOperation = failure.outcome !== "effects-unknown" && failure.toolName === canonicalToolId && (failure.key === key || Boolean(target && failure.target === target && fileEvidence.some((evidence) => evidence.callId === event.toolCallId && evidence.current)));
								const reconciledWrite = failure.outcome === "effects-unknown" && failure.toolName !== "run_workspace_command" && target === failure.target && canonicalToolId === "inspect_workspace";
								if ((fulfilled && failure.toolName === canonicalToolId) || sameOperation || reconciledWrite) {
									failure.resolved = true;
									await trace.emit("tool.failure.resolved", { failureId: failure.eventId, originatingCallId: callId, correctingCallId: event.toolCallId, correctingEventId: completedEvent.eventId, obligationId: failure.obligationId, repairClass: reconciledWrite ? "reconciliation" : "model-correction" }, failure.eventId);
								}
							}
							if (!event.isError) {
								const candidate = (event.result as { details?: { artifact?: unknown } })?.details?.artifact;
								if (candidate && typeof candidate === "object") {
									const artifact = candidate as Partial<RunArtifact>;
									if (typeof artifact.id === "string" && ["text", "json", "file"].includes(artifact.type ?? "") && typeof artifact.content === "string") {
										const accepted = artifact as RunArtifact;
										toolArtifacts.set(accepted.path ?? accepted.id, accepted);
										await trace.emit("artifact.created", {
											artifactId: accepted.id,
											artifactType: accepted.type,
											path: accepted.path,
										}, completedEvent.eventId);
									}
								}
							}
							toolEventIds.delete(event.toolCallId);
							toolStartedAt.delete(event.toolCallId);
							toolModelRequestIds.delete(event.toolCallId);
							canonicalToolIds.delete(event.toolCallId);
						}
					}
				});

				if (options.signal?.aborted) throw new Error("Run aborted");
				const onAbort = () => agent.abort();
				options.signal?.addEventListener("abort", onAbort, { once: true });
				const inputList = compiledTask.inputs.map((input) => `- ${relative(workspaceRoot, input.value)}`).join("\n");
				const inputBlock = inputList ? `\n\n<task-inputs>\n${inputList}\n</task-inputs>` : "";
				const skillBlock = selectedSkills.length
					? `\n\n<activated-skills>\n${selectedSkills.map(({ id, instructions }) => `<skill id=${JSON.stringify(id)}>\n${instructions}\n</skill>`).join("\n")}\n</activated-skills>`
					: "";
				const dependencyBlock = renderVerifiedDependencies(options.verifiedDependencies ?? new Map());
				const permissionBlock = `\n\n<runtime-permissions mode=${JSON.stringify(permissionMode)}>\n${permissionMode === "ask"
					? "Known mutation and command tools require user approval; commands remain workspace-sandboxed."
					: permissionMode === "auto"
						? "Known mutation and command tools are approved automatically; commands remain workspace-sandboxed with network disabled."
						: "Known mutation and command tools are approved automatically; command filesystem and network sandboxing is disabled."}\n</runtime-permissions>`;
				const userPrompt = `${compiledTask.objective}${inputBlock}${skillBlock}${dependencyBlock}${renderContextTail(contextPacket)}${permissionBlock}`;
				const needsWorkspaceWrite = compiledTask.requiredCapabilities.includes("workspace-write");
				const needsWorkspaceCommand = compiledTask.requiredCapabilities.includes("workspace-command");
				const isActionTask = needsWorkspaceWrite || needsWorkspaceCommand;
				const hasWorkspaceEvidence = (): boolean => [...completedToolIds].some((toolId) => WORKSPACE_INSPECTION_TOOLS.has(toolId));
				const hasRequiredAction = (): boolean => {
					const wroteWorkspace = [...completedToolIds].some((toolId) => WORKSPACE_WRITE_TOOLS.has(toolId));
					const ranCommand = commandRuns.some(({ exitCode }) => exitCode === 0);
					return (!needsWorkspaceWrite || wroteWorkspace) && (!needsWorkspaceCommand || ranCommand);
				};
				const canIssueProactiveActionNudge = (): boolean => isActionTask && !proactiveActionNudgeIssued && hasWorkspaceEvidence() && !hasRequiredAction();
				const hasAnotherModelTurn = (): boolean => maxModelTurns === undefined || modelTurns < maxModelTurns;
				const canIssueTruncationActionNudge = (): boolean => isActionTask && !truncationActionNudgeIssued && hasAnotherModelTurn() && !hasRequiredAction();
				const canPrefixContinue = (): boolean => providerId === "deepseek" && !deepSeekPrefixContinuationIssued && hasAnotherModelTurn() && !currentResponseToolCallSeen;
				const nextMaxOutputTokens = (): number => {
					if (explicitMaxOutputTokens !== undefined) return explicitMaxOutputTokens;
					if (modelTurns <= 1) return DEFAULT_MAX_OUTPUT_TOKENS;
					if (currentPromptKind === "prefix-continuation") return deepSeekPrefixContinuationMaxOutputTokens;
					if (currentPromptKind === "action-nudge") return expandNextRequestForToolCall ? TOOL_CALL_MAX_OUTPUT_TOKENS : DEFAULT_MAX_OUTPUT_TOKENS;
					if (hasRequiredAction()) return FINAL_MAX_OUTPUT_TOKENS;
					return hasWorkspaceEvidence() ? EVIDENCE_MAX_OUTPUT_TOKENS : DEFAULT_MAX_OUTPUT_TOKENS;
				};
				const maxOutputFailureMessage = (): string => `Model output limit reached (${currentRequestMaxOutputTokens} tokens)`;
				let output = "";
				let verification = verifyOutput("", "Agent has not run", { task: compiledTask });
				let verifiedEvent: HarnessEvent | undefined;
				try {
					const maximumRepairAttempts = features.verifierFeedback ? MAX_REPAIR_ATTEMPTS : 0;
					let outputLimitEncountered = false;
					for (let attempt = 0; attempt <= maximumRepairAttempts; attempt++) {
						if (runBudget.modelTurns >= maxModelTurns) { recordFatalRuntimeError(`Model turn budget exhausted (${maxModelTurns})`); turnBudgetExhausted = true; break; }
						currentRepairAttempt = attempt;
						const prompt = attempt === 0
							? userPrompt
							: `<verification-feedback attempt=${JSON.stringify(attempt)}>\n${verification.checks.filter(({ passed }) => !passed).map(({ id, message }) => `- ${id}: ${message}`).join("\n")}\nAddress only the unresolved checks above. Preserve completed work and every original prohibition and permission ceiling. Inspect current state before changing it, then return a corrected final answer.\n</verification-feedback>`;
						currentPromptKind = attempt === 0 ? "initial" : "verification-repair";
						currentActionNudgeTrigger = undefined;
						await agent.prompt(prompt, attempt === 0 ? images.map((image) => ({ type: "image" as const, ...image })) : undefined);
						output = responseText(finalMessage);
						if (turnBudgetExhausted && !output.trim() && isActionTask && hasWorkspaceEvidence() && hasRequiredAction()) {
							output = "Completed the requested workspace task and verified its required actions.";
						}
							let truncated = finalMessage?.role === "assistant" && finalMessage.stopReason === "length";
							if (truncated) {
								outputLimitEncountered = true;
								if (canPrefixContinue()) {
									deepSeekPrefixContinuationIssued = true;
									deepSeekPrefixContinuationPending = true;
									deepSeekPrefixContinuationMaxOutputTokens = currentRequestMaxOutputTokens;
									currentPromptKind = "prefix-continuation";
									await agent.prompt(DEEPSEEK_PREFIX_CONTINUATION_TEXT);
									output = responseText(finalMessage);
									truncated = finalMessage?.role === "assistant" && finalMessage.stopReason === "length";
								}
								if (canIssueTruncationActionNudge()) {
								markActionNudge("truncation");
								await agent.prompt(hasWorkspaceEvidence() ? TRUNCATION_ACTION_NUDGE_TEXT : TRUNCATION_DISCOVERY_NUDGE_TEXT);
								output = responseText(finalMessage);
								truncated = finalMessage?.role === "assistant" && finalMessage.stopReason === "length";
							}
							if (truncated) modelOutputFailure = maxOutputFailureMessage();
						}
						const verificationEvent = await trace.emit(
							"verification.started",
							{ verifierIds: capabilities.verifierIds, attempt, outputLimitEncountered, actionNudgeIssued, actionNudgeAttempts },
							runEventId,
						);
						options.signal?.throwIfAborted();
						for (const evidence of fileEvidence) evidence.current &&= evidence.revision === await revisionOf(evidence.target);
						const requiredEvidence = verifyOutput(output, undefined, { task: compiledTask, completedToolIds, commandExitCodes, commandRuns, workspaceClaimCandidates, fileEvidence });
						if (requiredEvidence.passed) for (const [callId, failure] of recoverableToolErrors) {
							if (!failure.resolved && !failure.obligationId && [...successfulTurns].some((turn) => turn > failure.modelTurn) && failure.outcome !== "effects-unknown" && WORKSPACE_INSPECTION_TOOLS.has(failure.toolName)) {
								failure.resolved = true;
								await trace.emit("tool.failure.superseded", { failureId: failure.eventId, originatingCallId: callId, reason: "Optional diagnostic; required evidence is complete" }, failure.eventId);
							}
						}
						const outputVerification = verifyOutput(output, runtimeFailureMessage(), { task: compiledTask, completedToolIds, commandExitCodes, commandRuns, workspaceClaimCandidates, fileEvidence });
						const artifactVerification = await verifyArtifacts(compiledTask, [...toolArtifacts.values()], workspaceRoot, options.signal);
						verification = {
							passed: outputVerification.passed && artifactVerification.passed,
							checks: [...outputVerification.checks, ...artifactVerification.checks],
						};
						if (outputLimitEncountered && !verification.passed && !fatalRuntimeError && !providerFailed && !modelOutputFailure) {
							modelOutputFailure = maxOutputFailureMessage();
							const failedOutputVerification = verifyOutput(output, modelOutputFailure, { task: compiledTask, completedToolIds, commandExitCodes, commandRuns, workspaceClaimCandidates, fileEvidence });
							verification = { passed: false, checks: [...failedOutputVerification.checks, ...artifactVerification.checks] };
						}
						if (turnBudgetExhausted && !verification.passed) {
							const budgetError = `Model turn budget exhausted (${maxModelTurns})`;
							const budgetVerification = verifyOutput(output, budgetError, { task: compiledTask, completedToolIds, commandExitCodes, commandRuns, workspaceClaimCandidates, fileEvidence });
							verification = { passed: false, checks: [...budgetVerification.checks, ...artifactVerification.checks] };
						}
						verifiedEvent = await trace.emit(
							verification.passed ? "verification.completed" : "verification.failed",
							{ verification, attempt },
							verificationEvent.eventId,
						);
						if (verification.passed || providerId === "fixture" || permissionDenied || providerFailed || fatalRuntimeError || modelOutputFailure || turnBudgetExhausted || attempt === maximumRepairAttempts) break;
					}
				} finally {
					options.signal?.removeEventListener("abort", onAbort);
				}
				const artifact = { id: randomUUID(), type: "text" as const, content: output };
				await trace.emit(
					"artifact.created",
					{ artifactId: artifact.id, artifactType: artifact.type },
					verifiedEvent?.eventId ?? runEventId,
				);
				const result: RunResult = {
					runId,
					task: compiledTask,
					capabilities,
					output,
					artifacts: [artifact, ...toolArtifacts.values()],
					verification,
					usage,
					tracePath,
					contextPacket,
					reasoning,
					modelContext,
					model: `${providerId}/${model.id}`,
					durationMs: Math.round((performance.now() - runStartedAt) * 100) / 100,
					...(checkpoint.path ? { checkpointPath: checkpoint.path } : {}),
				};
				const cacheEligibleInput = usage.input + usage.cacheRead;
				usage.cacheSavingsRatio = cacheEligibleInput ? usage.cacheRead / cacheEligibleInput : 0;
				await mkdir(runDirectory, { recursive: true });
				await writeRuntimeFileAtomically(join(runDirectory, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
				if (memoryEnabled && options.memoryBackend) {
					const captureEvent = await trace.emit("memory.capture.started", { runId }, runEventId);
					try {
						await options.memoryBackend.capture(result, options.signal);
						await trace.emit("memory.capture.completed", { runId }, captureEvent.eventId);
					} catch (error) {
						await trace.emit("memory.capture.failed", { message: error instanceof Error ? error.message : String(error) }, captureEvent.eventId);
					}
				}
				await trace.emit(verification.passed ? "run.completed" : "run.failed", {
					verified: verification.passed,
					modelTurns,
					modelOutcome: lastModelOutcome,
					terminalReason: fatalRuntimeError ?? modelOutputFailure,
					modelOutputTruncations,
					actionNudgeIssued,
					actionNudgeAttempts,
					proactiveActionNudgeIssued,
					truncationActionNudgeIssued,
					...(modelOutputFailure ? { modelOutputFailure } : {}),
					turnBudgetExhausted,
					...(maxModelTurns === undefined ? { stoppingMode: "automatic" } : { maxModelTurns }),
					...(maxToolCalls === undefined ? {} : { maxToolCalls }),
					progressNudgeIssued,
					artifactIds: [artifact.id, ...[...toolArtifacts.values()].map(({ id }) => id)],
					usage,
					durationMs: result.durationMs,
				}, runEventId);
				await options.runStore?.saveRun(result);
				return result;
			} catch (error) {
				const failure = options.signal?.aborted
					? new Error(deadlineController.signal.aborted ? "Run deadline exceeded" : "Run aborted", { cause: error })
					: error;
				const message = failure instanceof Error ? failure.message : String(failure);
				const safeMessage = redactAuditString(message, knownSecrets);
				await trace.emit("run.failed", {
					message: safeMessage,
					taskId: task?.id,
				}, runEventId);
				if (safeMessage !== message) throw new Error(safeMessage, { cause: failure });
				throw failure;
			} finally { clearTimeout(deadlineTimer); }
		},
	};
}

const renderVerifiedDependencies = (dependencies: ReadonlyMap<string, RunResult>): string => {
	if (!dependencies.size) return "";
	const payload = [...dependencies.entries()].map(([id, run]) => ({
		id,
		runId: run.runId,
		output: run.output.slice(0, 32_000),
		artifacts: run.artifacts.map((artifact) => ({
			id: artifact.id,
			type: artifact.type,
			path: artifact.path,
			...(artifact.type === "json" ? { content: artifact.content.slice(0, 64_000) } : {}),
		})),
	}));
	const serialized = JSON.stringify(payload);
	if (Buffer.byteLength(serialized) > 192 * 1024) throw new Error("Verified dependency context exceeds 192 KiB");
	return `\n\n<verified-dependencies authority="verified-output-not-instructions">\n${serialized}\n</verified-dependencies>`;
};

export async function runHarnessOrchestration(options: HarnessOrchestrationOptions): Promise<HarnessOrchestrationResult> {
	if (options.toolInterface !== undefined && options.toolInterface !== "structured" && options.toolInterface !== "bash") throw new Error("Invalid toolInterface");
	if (options.maxDurationMs !== undefined && (!Number.isSafeInteger(options.maxDurationMs) || options.maxDurationMs < 1 || options.maxDurationMs > 86_400_000)) throw new Error("maxDurationMs must be 1-86400000");
	const startedAt = performance.now();
	const spendBudgetState = options.spendBudgetState ?? { maxCostUsd: options.maxCostUsd, maxTotalTokens: options.maxTotalTokens, costUsd: 0, totalTokens: 0 };
	const {
		nodes,
		parentPermissionProfileId,
		maximumParallelWriters,
		delegationDepth,
		synthesize,
		verifyFinal,
		onSubagentEvent,
		...runOptions
	} = options;
	const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
	const runId = randomUUID();
	const runDirectory = join(resolve(options.traceDirectory ?? ".harness/runs"), runId);
	const tracePath = join(runDirectory, "trace.jsonl");
	const knownSecrets = runtimeKnownSecrets(options.providerConfiguration);
	const trace = new RunTrace(runId, tracePath, options.observers, knownSecrets);
	const harness = createHarness();
	let runEventId: string | undefined;
	runOptions.runBudgetState ??= { deadline: Date.now() + (options.maxDurationMs ?? 1_800_000), modelTurns: 0, toolCalls: 0 };
	const deadlineController = new AbortController();
	const deadlineTimer = setTimeout(() => deadlineController.abort(new Error("Run deadline exceeded")), Math.max(0, runOptions.runBudgetState.deadline - Date.now()));
	const signal = AbortSignal.any([deadlineController.signal, ...(options.signal ? [options.signal] : [])]);

	try {
		const runEvent = await trace.emit("run.started", { repairSchemaVersion: 1, workspaceRoot, orchestration: true, permissionMode: options.permissionMode ?? "ask", toolInterface: resolveToolInterface(options) });
		runEventId = runEvent.eventId;
		const taskEvent = await trace.emit("task.compiled", { children: nodes }, runEventId);
		await trace.emit("capabilities.resolved", {
			maximumDelegationDepth: 1,
			maximumChildren: 3,
			maximumParallelWriters: maximumParallelWriters ?? 2,
			parentPermissionProfileId,
			delegationDepth,
		}, taskEvent.eventId);
		const result = await runOrchestration({
			workspaceRoot,
			nodes,
			parentPermissionProfileId,
			delegationDepth,
			...(maximumParallelWriters === undefined ? {} : { maximumParallelWriters }),
			signal,
			onEvent: async (type, data) => {
				await trace.emit(type, data, runEventId);
				await onSubagentEvent?.(type, data);
			},
			execute: (node, context) => harness.run({
				...runOptions,
				spendBudgetState,
				workspaceRoot,
				objective: node.objective,
				files: [...context.verifiedDependencies.values()].flatMap(({ artifacts }) => artifacts.flatMap(({ type, path }) => type === "file" && path ? [path] : [])),
				verifiedDependencies: context.verifiedDependencies,
				presetId: node.presetId,
				writePaths: node.writePaths,
				delegationDepth: context.delegationDepth,
				signal: context.signal,
			}),
			synthesize: synthesize ?? (async (children) => [...children.entries()]
				.map(([id, child]) => `## ${id}\n\n${child.output}`)
				.join("\n\n")),
			verifyFinal: verifyFinal ?? (async (output, children) => ({
				passed: Boolean(output.trim()) && children.size > 0,
				checks: [{
					id: "verified-synthesis",
					passed: Boolean(output.trim()) && children.size > 0,
					message: output.trim() && children.size ? "Synthesis contains verified child output" : "Synthesis has no verified child output",
				}],
			})),
		});
		const verificationEvent = await trace.emit("verification.started", { scope: "orchestration" }, runEventId);
		await trace.emit(result.verification.passed ? "verification.completed" : "verification.failed", { verification: result.verification }, verificationEvent.eventId);
		const finalResult = { ...result, runId, tracePath };
		await mkdir(runDirectory, { recursive: true });
		await writeRuntimeFileAtomically(join(runDirectory, "orchestration-result.json"), `${JSON.stringify(finalResult, null, 2)}\n`);
		await trace.emit(result.verification.passed ? "run.completed" : "run.failed", {
			verified: result.verification.passed,
			childRuns: result.children.flatMap(({ run }) => run ? [run.runId] : []),
			durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
		}, runEventId);
		return finalResult;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const safeMessage = redactAuditString(message, knownSecrets);
		await trace.emit("run.failed", { message: safeMessage }, runEventId);
		if (safeMessage !== message) throw new Error(safeMessage, { cause: error });
		throw error;
	} finally { clearTimeout(deadlineTimer); }
}

export type { HarnessEvent };
