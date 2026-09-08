export type RiskClass = "low" | "medium" | "high";
export type PermissionDecision = "ALLOW" | "ASK" | "DENY";
export type CacheStrategy =
	| "AUTO_PREFIX"
	| "EXPLICIT_BREAKPOINT"
	| "NAMED_CONTEXT_OBJECT"
	| "SESSION_STATE"
	| "NO_PROVIDER_CACHE";

export interface AcceptanceCriterion {
	id: string;
	description: string;
	required: boolean;
	action?: "read" | "write" | "exists" | "command" | "unsupported";
	target?: string;
	command?: string[];
	evidence?: "read-receipt" | "changed-state" | "file-state" | "zero-exit";
}

export interface TaskInput {
	id: string;
	kind: "file" | "text" | "url";
	value: string;
}

export interface TaskSpecification {
	id: string;
	objective: string;
	inputs: TaskInput[];
	artifactTypes: string[];
	domains: string[];
	requiredCapabilities: string[];
	acceptanceCriteria: AcceptanceCriterion[];
	prohibitions?: Array<{ action: "command" | "write"; command?: string[]; target?: string }>;
	riskClass: RiskClass;
}

export interface AgentPreset {
	id: string;
	version: string;
	purpose: string;
	coreSkillIds: string[];
	toolIds: string[];
	permissionProfileId: string;
	verifierIds: string[];
	cacheStrategy: CacheStrategy;
	memoryPolicy: {
		enabled: boolean;
		currentVersionsOnly: boolean;
		graphHops: number;
		semanticSearch: boolean;
		tokenBudget: number;
	};
	delegationPolicy: {
		level: "L0" | "L1" | "L2";
		maximumDepth: number;
		maximumChildren: number;
		mayExpandPermissions: false;
	};
}

export interface CompiledCapabilities {
	preset: AgentPreset;
	skillIds: string[];
	toolIds: string[];
	canonicalToolIds?: string[];
	permissionProfileId: string;
	verifierIds: string[];
	toolBundleHash: string;
	skillPackHash: string;
	contextPacketHash: string;
	cachePrefixHash: string;
	runProfileHash: string;
}

export interface PermissionProfile {
	id: string;
	defaultDecision: PermissionDecision;
	toolDecisions: Record<string, PermissionDecision>;
}

export interface ToolPermissionRequest {
	toolId: string;
	arguments: unknown;
	riskClass: RiskClass;
}

export interface VerificationCheck {
	id: string;
	passed: boolean;
	message: string;
}

export interface VerificationResult {
	passed: boolean;
	checks: VerificationCheck[];
}

export interface RunArtifact {
	id: string;
	type: "text" | "json" | "file";
	content: string;
	path?: string;
}

export interface RunUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning?: number;
	totalTokens: number;
	cost?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cacheSavingsRatio?: number;
}

export interface SkillManifest {
	id: string;
	version: string;
	description?: string;
	dependencies: string[];
	conflicts: string[];
	requiredCapabilities: string[];
	requiredTools: string[];
	requiredPermissions: string[];
	verifierIds: string[];
}

export interface ActivatedSkill {
	id: string;
	instructions: string;
	manifest?: SkillManifest;
}

export interface ConversationTurn {
	runId: string;
	objective: string;
	output: string;
	timestamp: number;
	checkpointPath?: string;
	reasoning?: ReasoningTrace[];
	usage?: RunUsage;
	modelContext?: RunModelContext;
	model?: string;
	durationMs?: number;
}

export interface ReasoningTrace { text: string; truncated: boolean }
export interface RunModelContext { contextWindow: number; maxOutputTokens: number; lastPromptTokens: number }
export interface ModelStreamUpdate { kind: "reasoning" | "text"; text: string }

export interface ConversationProjection {
	turns: ConversationTurn[];
	omittedTurns: number;
	estimatedBytes: number;
	projectionHash: string;
}

export interface RunResult {
	runId: string;
	task: TaskSpecification;
	capabilities: CompiledCapabilities;
	output: string;
	artifacts: RunArtifact[];
	verification: VerificationResult;
	usage: RunUsage;
	tracePath: string;
	checkpointPath?: string;
	contextPacket?: ContextPacket;
	reasoning?: ReasoningTrace[];
	modelContext?: RunModelContext;
	model?: string;
	durationMs?: number;
}

export interface RunStore {
	saveRun(run: RunResult, metadata?: { parentRunId?: string; childId?: string }): Promise<void>;
}

export const HARNESS_EVENT_TYPES = [
	"run.started",
	"run.completed",
	"run.failed",
	"task.compiled",
	"capabilities.resolved",
	"context.compiled",
	"memory.recall.started",
	"memory.recall.completed",
	"memory.recall.failed",
	"memory.capture.started",
	"memory.capture.completed",
	"memory.capture.failed",
	"model.request.started",
	"model.first_token",
	"model.reasoning.completed",
	"model.request.completed",
	"model.request.failed",
	"provider.attempt.started",
	"provider.attempt.completed",
	"provider.attempt.failed",
	"provider.retry.scheduled",
	"cache.lookup",
	"cache.read",
	"cache.write",
	"cache.invalidated",
	"tool.requested",
	"tool.allowed",
	"tool.denied",
	"tool.started",
	"tool.completed",
	"tool.failed",
	"tool.failure.resolved",
	"tool.failure.superseded",
	"subagent.requested",
	"subagent.started",
	"subagent.completed",
	"subagent.failed",
	"verification.started",
	"verification.completed",
	"verification.failed",
	"artifact.created",
	"artifact.updated",
	"artifact.rejected",
] as const;

export type HarnessEventType = (typeof HARNESS_EVENT_TYPES)[number];

export interface HarnessEvent {
	eventId: string;
	runId: string;
	parentEventId?: string;
	sequence: number;
	timestamp: string;
	type: HarnessEventType;
	data: Record<string, unknown>;
}

export interface RunObserver {
	(event: HarnessEvent): void | Promise<void>;
}

export interface ContextPacket {
	taskId: string;
	agentPresetId: string;
	structuralContext: unknown[];
	evidence: unknown[];
	memories: unknown[];
	sourceVersions: unknown[];
	provenance: unknown[];
	tokenBudget: number;
	estimatedTokens: number;
	contextHash: string;
}

export interface CacheCapabilities {
	strategies: CacheStrategy[];
	supportsUsageReporting: boolean;
}

export interface MemoryBackend {
	recall(query: string, tokenBudget: number, signal?: AbortSignal): Promise<ContextPacket>;
	capture(run: RunResult, signal?: AbortSignal): Promise<void>;
}

export interface OcrRequest {
	requestId: string;
	idempotencyKey: string;
	assetPath: string;
	pageNumber?: number;
	prompt?: string;
	imageMode: "gundam" | "base";
	settings: {
		maxContextTokens: number;
		noRepeat: { ngramSize: number; windowSize: number };
	};
	modelRevision: string;
	parserCodeRevision: string;
}

export interface DocumentIr {
	documentId: string;
	assetVersionId: string;
	parser: {
		id: string;
		version: string;
		configurationHash: string;
	};
	pages: Array<{
		pageNumber: number;
		width: number;
		height: number;
		blocks: Array<{
			blockId: string;
			type: "heading" | "paragraph" | "table" | "formula" | "image" | "chart" | "caption" | "list";
			readingOrder: number;
			boundingBox?: [number, number, number, number];
			text?: string;
			structuredData?: unknown;
			confidence?: number;
			provenance?: {
				assetVersionId: string;
				pageNumber: number;
				parserId: string;
			};
		}>;
	}>;
	failures?: Array<{ pageNumber?: number; parserId: string; message: string }>;
}

export type DocumentIR = DocumentIr;

export interface OcrService {
	parse(request: OcrRequest, signal?: AbortSignal): Promise<DocumentIr>;
}

const SENSITIVE_WORKSPACE_PATH = /(?:^|\/)(?:(?:\.ssh|\.aws|\.gnupg)(?:\/[\s\S]*)?|\.kube\/config|\.env(?:\..*)?|\.(?:npmrc|pypirc|netrc)|(?:credentials?|secrets?)\.(?:json|ya?ml|toml|ini|conf|txt)|id_[^.\/]+|[^/]+\.(?:key|pem|p12|pfx|keystore))$/i;

export const isSensitiveWorkspacePath = (path: string): boolean =>
	SENSITIVE_WORKSPACE_PATH.test(path.replaceAll("\\", "/").replace(/^\.\//, ""));

const SENSITIVE_AUDIT_KEY = /^(?:api[_-]?key|authorization|cookie|credential|password|private[_-]?key|secret|token|content|oldText|newText)$/i;

export const redactAuditString = (value: string, knownSecrets: readonly string[] = []): string => {
	let redacted = value
		.replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}/gi, "Bearer [REDACTED]")
		.replace(/\b(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTHORIZATION|COOKIE|PASSWORD|SECRET|TOKEN)\s*[:=]\s*[^\s,;]+/gi, (match) => `${match.slice(0, match.search(/[:=]/) + 1)}[REDACTED]`)
		.replace(/((?:"|')?(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTHORIZATION|COOKIE|CREDENTIAL|PASSWORD|PRIVATE[_-]?KEY|SECRET|TOKEN)(?:"|')?\s*:\s*(["']))(?:\\.|(?!\2)[^\\\r\n])*\2/gi, "$1[REDACTED]$2")
		.replace(/([?&](?:api[_-]?key|access[_-]?token|key|signature|token)=)[^&#\s]+/gi, "$1[REDACTED]")
		.replace(/\bhttps?:\/\/[^\s/@:]+:[^\s/@]+@/gi, (match) => `${match.slice(0, match.indexOf("://") + 3)}[REDACTED]@`)
		.replace(/\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|(?:sk|key|token)-[A-Za-z0-9_-]{12,})\b/g, "[REDACTED]");
	for (const secret of new Set(knownSecrets.filter((candidate) => candidate.length >= 4))) redacted = redacted.replaceAll(secret, "[REDACTED]");
	return redacted;
};

export const redactAuditValue = (value: unknown, key = "", knownSecrets: readonly string[] = []): unknown => {
	if (SENSITIVE_AUDIT_KEY.test(key)) return "[REDACTED]";
	if (typeof value === "string") return redactAuditString(value, knownSecrets);
	if (Array.isArray(value)) return value.map((item) => redactAuditValue(item, "", knownSecrets));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [childKey, redactAuditValue(item, childKey, knownSecrets)]));
	return value;
};
