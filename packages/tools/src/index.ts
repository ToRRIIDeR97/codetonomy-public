import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants, existsSync, readdirSync, statSync } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, rename, unlink } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, matchesGlob, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import {
	createPresentation,
	createValuationWorkbook,
	inspectPresentation,
	inspectWorkbook,
	runBacktest,
	verifyBacktest,
	type BacktestSpec,
	type PresentationDeckSpec,
	type ValuationWorkbookSpec,
} from "@agent-harness/artifacts";
import { isSensitiveWorkspacePath } from "@agent-harness/contracts";
import { parseDocument, type DocumentParseOptions } from "@agent-harness/document-ir";
import { BashCommandPlanner, bashPermissionTarget, bashPermissionTargets, type BashCommandPlan, type BashLeafOperation, type BashOperation, type BashToolArguments } from "./bash-driver.js";

export { BashCommandPlanner, bashOperationUsesNativeShell, bashPermissionTarget, bashPermissionTargets, parseBashCommand, planBashCommand, type BashCommandPlan, type BashLeafOperation, type BashOperation, type BashPlanReason, type BashPlanRoute, type BashToolArguments } from "./bash-driver.js";

const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_SEARCHED_FILES = 20_000;
const MAX_WORKSPACE_SCAN_ENTRIES = 100_000;
const displayPath = (path: string): string => path.replaceAll("\\", "/");
const IGNORED_DIRECTORIES = new Set([".codetonomy", ".git", ".harness", ".pnpm-store", ".reference-repos", "dist", "node_modules"]);
const PROTECTED_READ_DIRECTORIES = new Set([".agents", ".codex", ".codetonomy", ".git", ".harness", ".pnpm-store", "node_modules"]);
const assertWritablePath = (path: string): void => {
	if (path.split(/[\\/]/).some((part) => PROTECTED_READ_DIRECTORIES.has(part.toLowerCase()))) throw new Error("Path is protected from workspace writes");
	if (isSensitiveWorkspacePath(path)) throw new Error("Sensitive workspace paths are protected from agent tools");
};

export const READ_ONLY_TOOL_IDS = ["list_workspace", "search_workspace", "inspect_workspace", "inspect_document", "inspect_workbook", "inspect_presentation", "inspect_backtest", "record_structured_artifact"] as const;
export const CODING_TOOL_IDS = [...READ_ONLY_TOOL_IDS, "write_workspace", "edit_workspace", "run_workspace_command", "create_valuation_workbook", "create_presentation", "run_backtest"] as const;
export const BASH_FACADE_TARGET_IDS = ["list_workspace", "search_workspace", "inspect_workspace", "run_workspace_command"] as const;
const BASH_FACADE_TARGETS = new Set<string>(BASH_FACADE_TARGET_IDS);
export const bashFacadeProvides = (toolId: string): boolean => BASH_FACADE_TARGETS.has(toolId);

export const withBashToolFacade = (ids: string[]): string[] => {
	let added = false;
	return ids.flatMap((id) => {
		if (!BASH_FACADE_TARGETS.has(id)) return [id];
		if (added) return [];
		added = true;
		return ["bash"];
	});
};

export interface WorkspaceMutationObserver {
	before(path: string): Promise<void>;
	after(path: string): Promise<void>;
	beforeWorkspace?(): Promise<void>;
	afterWorkspace?(): Promise<string[] | void>;
	coverage?(): "captured" | "incomplete";
}

export class ToolExecutionError extends Error {
	constructor(message: string, readonly details: Record<string, unknown>, cause?: unknown) { super(message, { cause }); }
}

export interface WorkspaceSearchBackend {
	search(query: string, options: { path: string; limit: number; signal?: AbortSignal }): Promise<Array<{
		path: string;
		pageNumber?: number;
		content: string;
		contentHash?: string;
		score?: number;
		structure?: { enclosingClass?: string; symbol?: string; kind?: string; architecturalLayer?: string; owner?: string };
	}>>;
}

export interface WorkspaceClaimCandidate {
	path: string;
	architecturalLayer: string;
	symbols: string[];
	minimum: number;
	maximum: number;
	unit: "tokens" | "results";
}

export interface WorkspaceWriteScope {
	wholeWorkspace: boolean;
	paths: string[];
}

export const DELEGATABLE_PRESET_IDS = [
	"researcher",
	"artifact-reviewer",
	"general-assistant",
	"general-worker",
	"spreadsheet-agent",
	"presentation-agent",
	"backtesting-agent",
] as const;
export type DelegatablePresetId = (typeof DELEGATABLE_PRESET_IDS)[number];

export interface DelegateTasksNode {
	id: string;
	objective: string;
	presetId: DelegatablePresetId;
	permissionProfileId: "workspace-read" | "workspace-write";
	writePaths?: string[];
	dependencies?: string[];
}

export interface DelegateTasksChildResult {
	id: string;
	status: "completed" | "failed" | "skipped";
	runId?: string;
	output?: string;
	error?: string;
}

export interface DelegateTasksResult {
	output: string;
	verificationPassed: boolean;
	children: DelegateTasksChildResult[];
}

export type DelegateTasksCallback = (nodes: DelegateTasksNode[], signal?: AbortSignal) => Promise<DelegateTasksResult>;

const workspacePath = () => Type.String({
	minLength: 1,
	maxLength: 1_024,
	description: "Workspace-relative path or a path starting with /workspace.",
});

const listWorkspaceParameters = Type.Object({
	path: Type.Optional(workspacePath()),
	depth: Type.Optional(Type.Integer({ minimum: 0, maximum: 4 })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
}, { additionalProperties: false });

const searchWorkspaceParameters = Type.Object({
	query: Type.String({ minLength: 1, maxLength: 512 }),
	path: Type.Optional(workspacePath()),
	caseSensitive: Type.Optional(Type.Boolean()),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
	globs: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1_024 }), { maxItems: 32 })),
}, { additionalProperties: false });

const inspectWorkspaceParameters = Type.Object({
	path: workspacePath(),
	offset: Type.Optional(Type.Integer({ minimum: 1 })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000 })),
}, { additionalProperties: false });

const writeWorkspaceParameters = Type.Object({
	path: workspacePath(),
	content: Type.String({ maxLength: MAX_INPUT_BYTES }),
}, { additionalProperties: false });

const editWorkspaceParameters = Type.Object({
	path: workspacePath(),
	oldText: Type.String({ minLength: 1, maxLength: MAX_INPUT_BYTES }),
	newText: Type.String({ maxLength: MAX_INPUT_BYTES }),
	replaceAll: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

const runWorkspaceCommandParameters = Type.Object({
	argv: Type.Array(Type.String({ minLength: 1, maxLength: 4_096 }), { minItems: 1, maxItems: 64 }),
	cwd: Type.Optional(workspacePath()),
	timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 600 })),
}, { additionalProperties: false });

const bashParameters = Type.Object({
	command: Type.String({ minLength: 1, maxLength: 16_000 }),
	cwd: Type.Optional(workspacePath()),
	timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 600 })),
}, { additionalProperties: false });

const inspectWorkbookParameters = Type.Object({
	path: Type.String({ minLength: 1, maxLength: 1_024 }),
}, { additionalProperties: false });

const inspectDocumentParameters = Type.Object({
	path: Type.String({ minLength: 1, maxLength: 1_024 }),
}, { additionalProperties: false });

const createValuationWorkbookParameters = Type.Object({
	company: Type.String({ minLength: 1, maxLength: 160 }),
	outputPath: Type.String({ minLength: 1, maxLength: 1_024, pattern: "\\.xlsx$" }),
	historical: Type.Array(Type.Object({
		year: Type.Integer({ minimum: 1900, maximum: 2200 }),
		revenue: Type.Number(),
		ebitda: Type.Number(),
		freeCashFlow: Type.Number(),
		source: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
	}, { additionalProperties: false }), { minItems: 1, maxItems: 50 }),
	scenarios: Type.Array(Type.Object({
		name: Type.String({ minLength: 1, maxLength: 40 }),
		revenueGrowth: Type.Number({ minimum: -0.5, maximum: 1 }),
		ebitdaMargin: Type.Number({ minimum: -1, maximum: 1 }),
	}, { additionalProperties: false }), { minItems: 3, maxItems: 3 }),
	discountRate: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
	terminalGrowthRate: Type.Number({ minimum: -0.2, maximum: 1 }),
	taxRate: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
	sources: Type.Array(Type.Object({
		label: Type.String({ minLength: 1, maxLength: 500 }),
		source: Type.String({ minLength: 1, maxLength: 2_000 }),
		page: Type.Optional(Type.Integer({ minimum: 1 })),
	}, { additionalProperties: false }), { minItems: 1, maxItems: 100 }),
}, { additionalProperties: false });

const inspectPresentationParameters = Type.Object({
	path: Type.String({ minLength: 1, maxLength: 1_024, pattern: "\\.pptx$" }),
}, { additionalProperties: false });

const createPresentationParameters = Type.Object({
	title: Type.String({ minLength: 1, maxLength: 160 }),
	subtitle: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
	outputPath: Type.String({ minLength: 1, maxLength: 1_024, pattern: "\\.pptx$" }),
	slides: Type.Array(Type.Object({
		role: Type.Union([Type.Literal("title"), Type.Literal("content"), Type.Literal("summary"), Type.Literal("sources")]),
		title: Type.String({ minLength: 1, maxLength: 160 }),
		bullets: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 10 })),
		source: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
		chart: Type.Optional(Type.Object({
			title: Type.String({ minLength: 1, maxLength: 160 }),
			categories: Type.Array(Type.String({ minLength: 1, maxLength: 80 }), { minItems: 1, maxItems: 20 }),
			series: Type.Array(Type.Object({
				name: Type.String({ minLength: 1, maxLength: 80 }),
				values: Type.Array(Type.Number(), { minItems: 1, maxItems: 20 }),
			}, { additionalProperties: false }), { minItems: 1, maxItems: 6 }),
			source: Type.String({ minLength: 1, maxLength: 500 }),
		}, { additionalProperties: false })),
	}, { additionalProperties: false }), { minItems: 3, maxItems: 40 }),
}, { additionalProperties: false });

const inspectBacktestParameters = Type.Object({
	path: Type.String({ minLength: 1, maxLength: 1_024, pattern: "\\.json$" }),
}, { additionalProperties: false });

const runBacktestParameters = Type.Object({
	dataPath: Type.String({ minLength: 1, maxLength: 1_024, pattern: "\\.csv$" }),
	outputPath: Type.String({ minLength: 1, maxLength: 1_024, pattern: "\\.json$" }),
	shortWindow: Type.Integer({ minimum: 2, maximum: 499 }),
	longWindow: Type.Integer({ minimum: 3, maximum: 500 }),
	trainFraction: Type.Number({ minimum: 0.5, maximum: 0.9 }),
	commissionBps: Type.Optional(Type.Number({ minimum: 0, maximum: 1_000 })),
	initialCapital: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
}, { additionalProperties: false });

// Keep the root an object: several OpenAI-compatible gateways reject root-level
// anyOf schemas before the model sees the request.
const recordStructuredArtifactParameters = Type.Object({
	kind: Type.Union([Type.Literal("research"), Type.Literal("review")]),
	title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
	summary: Type.String({ minLength: 1, maxLength: 10_000 }),
	claims: Type.Optional(Type.Array(Type.Object({
			statement: Type.String({ minLength: 1, maxLength: 2_000 }),
			source: Type.String({ minLength: 1, maxLength: 2_000 }),
			page: Type.Optional(Type.Integer({ minimum: 1 })),
			confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
		}, { additionalProperties: false }), { minItems: 1, maxItems: 100 })),
	verdict: Type.Optional(Type.Union([Type.Literal("pass"), Type.Literal("fail")])),
	defects: Type.Optional(Type.Array(Type.Object({
			severity: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("critical")]),
			location: Type.String({ minLength: 1, maxLength: 500 }),
			message: Type.String({ minLength: 1, maxLength: 2_000 }),
		}, { additionalProperties: false }), { maxItems: 100 })),
}, { additionalProperties: false });

const delegateTasksParameters = Type.Object({
	nodes: Type.Array(Type.Object({
		id: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" }),
		objective: Type.String({ minLength: 1, maxLength: 8_000 }),
		presetId: Type.Enum(DELEGATABLE_PRESET_IDS),
		permissionProfileId: Type.Union([Type.Literal("workspace-read"), Type.Literal("workspace-write")]),
		writePaths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1_024 }), { maxItems: 32 })),
		dependencies: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" }), { maxItems: 3 })),
	}, { additionalProperties: false }), { minItems: 1, maxItems: 3 }),
}, { additionalProperties: false });

export const toolCacheDefinitions = {
	list_workspace: {
		name: "list_workspace",
		version: "1.0.0",
		description: "List files and directories inside the workspace. Use this to discover the project structure before reading files.",
		parameters: listWorkspaceParameters,
	},
	search_workspace: {
		name: "search_workspace",
		version: "1.1.0",
		description: "Search workspace content and return relevant paths and excerpts. Use one focused query, then inspect the best matching path.",
		parameters: searchWorkspaceParameters,
	},
	inspect_workspace: {
		name: "inspect_workspace",
		version: "2.0.0",
		description: "Read a UTF-8 file inside the workspace. Use offset and limit to page through large files.",
		parameters: inspectWorkspaceParameters,
	},
	write_workspace: {
		name: "write_workspace",
		version: "1.0.0",
		description: "Create or replace a UTF-8 file inside the workspace atomically. Requires user approval.",
		parameters: writeWorkspaceParameters,
	},
	edit_workspace: {
		name: "edit_workspace",
		version: "1.0.0",
		description: "Replace exact text in an existing UTF-8 workspace file atomically. Fails on ambiguous matches unless replaceAll is true. Requires user approval.",
		parameters: editWorkspaceParameters,
	},
	run_workspace_command: {
		name: "run_workspace_command",
		version: "1.0.0",
		description: "Run an argv command from a workspace cwd with bounded output and filtered secrets. In ask/auto mode, Codex confines writes and disables network; full-access mode disables filesystem and network sandboxing. The active permission mode controls approval.",
		parameters: runWorkspaceCommandParameters,
	},
	bash: {
		name: "bash",
		version: "0.4.0",
		description: "Run Bash in the workspace. Read-only commands may be answered by a semantics-preserving workspace accelerator; commands it cannot preserve run through native Bash under the same permission gate, output bounds, and Codex sandbox.",
		parameters: bashParameters,
	},
	inspect_workbook: {
		name: "inspect_workbook",
		version: "1.0.0",
		description: "Inspect an .xlsx workbook inside the workspace and return sheet dimensions, formula count, and valuation scenario names.",
		parameters: inspectWorkbookParameters,
	},
	inspect_document: {
		name: "inspect_document",
		version: "1.0.0",
		description: "Parse a document inside the workspace into page- and block-level text with source provenance.",
		parameters: inspectDocumentParameters,
	},
	create_valuation_workbook: {
		name: "create_valuation_workbook",
		version: "1.0.0",
		description: "Create an atomic, formula-driven .xlsx valuation workbook with exactly three scenarios and source notes. Requires user approval.",
		parameters: createValuationWorkbookParameters,
	},
	inspect_presentation: {
		name: "inspect_presentation",
		version: "1.0.0",
		description: "Inspect a .pptx deck inside the workspace for slide roles, charts, likely overflow, and layout collisions.",
		parameters: inspectPresentationParameters,
	},
	create_presentation: {
		name: "create_presentation",
		version: "1.0.0",
		description: "Create an atomic, source-backed .pptx deck with required title, summary, and sources slide roles. Requires user approval.",
		parameters: createPresentationParameters,
	},
	inspect_backtest: {
		name: "inspect_backtest",
		version: "1.0.0",
		description: "Independently verify a Codetonomy backtest artifact, ledger, metrics, timing, split, and reproducibility hash.",
		parameters: inspectBacktestParameters,
	},
	run_backtest: {
		name: "run_backtest",
		version: "1.0.0",
		description: "Run a deterministic moving-average backtest from date/open/close CSV data with next-session execution and an out-of-sample split. Requires user approval.",
		parameters: runBacktestParameters,
	},
	record_structured_artifact: {
		name: "record_structured_artifact",
		version: "1.0.0",
		description: "Record a bounded structured research or independent review artifact. Research claims require source provenance; review defects require severity and exact location.",
		parameters: recordStructuredArtifactParameters,
	},
	delegate_tasks: {
		name: "delegate_tasks",
		version: "1.0.0",
		description: "Run 1-3 bounded child agents in the foreground. Each child must name a preset and permission profile; children cannot delegate further. Requires user approval because it makes additional model calls.",
		parameters: delegateTasksParameters,
	},
} as const;

const throwIfAborted = (signal?: AbortSignal): void => {
	if (signal?.aborted) throw new Error("Operation aborted");
};

const workspaceRelativeRequest = (path: string): string => path === "/workspace"
	? "."
	: path.startsWith("/workspace/") ? path.slice("/workspace/".length) : path;

async function resolveExistingInsideWorkspace(
	workspaceRoot: string,
	requestedPath: string,
): Promise<{ root: string; target: string; relativePath: string }> {
	const lexicalRoot = resolve(workspaceRoot);
	const lexicalTarget = resolve(lexicalRoot, workspaceRelativeRequest(requestedPath));
	const lexicalRelative = relative(lexicalRoot, lexicalTarget);
	if (lexicalRelative.startsWith("..") || isAbsolute(lexicalRelative)) throw new Error("Path is outside the workspace");
	const [root, target] = await Promise.all([realpath(lexicalRoot), realpath(lexicalTarget)]);
	const relativePath = relative(root, target);
	if (relativePath.startsWith("..") || isAbsolute(relativePath)) throw new Error("Path resolves outside the workspace");
	if (PROTECTED_READ_DIRECTORIES.has(relativePath.split(/[\\/]/, 1)[0] ?? "")) throw new Error("Path is protected from workspace tools");
	if (isSensitiveWorkspacePath(relativePath)) throw new Error("Sensitive workspace paths are protected from agent tools");
	return { root, target, relativePath: relativePath || "." };
}

async function readBoundedBytes(path: string, signal?: AbortSignal, maximum = MAX_INPUT_BYTES): Promise<Buffer> {
	throwIfAborted(signal);
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = await handle.stat();
		if (!info.isFile()) throw new Error("Path is not a file");
		if (info.nlink !== 1) throw new Error("Hard-linked files are not supported");
		if (info.size > maximum) throw new Error(`File exceeds ${maximum} bytes`);
		const bytes = Buffer.alloc(info.size + 1);
		let length = 0;
		while (length < bytes.length) {
			throwIfAborted(signal);
			const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
			if (!bytesRead) break;
			length += bytesRead;
		}
		if (length > maximum) throw new Error(`File exceeds ${maximum} bytes`);
		return bytes.subarray(0, length);
	} finally {
		await handle.close();
	}
}

const readBoundedFile = async (path: string, signal?: AbortSignal): Promise<string> =>
	new TextDecoder("utf-8", { fatal: true }).decode(await readBoundedBytes(path, signal));

async function resolveWritableInsideWorkspace(
	workspaceRoot: string,
	requestedPath: string,
): Promise<{ root: string; target: string; relativePath: string }> {
	const lexicalRoot = resolve(workspaceRoot);
	const target = resolve(lexicalRoot, workspaceRelativeRequest(requestedPath));
	const lexicalRelative = relative(lexicalRoot, target);
	if (!lexicalRelative || lexicalRelative.startsWith("..") || isAbsolute(lexicalRelative)) {
		throw new Error("Write path is outside the workspace or names the workspace root");
	}
	assertWritablePath(lexicalRelative);
	const root = await realpath(lexicalRoot);
	const canonicalTarget = resolve(root, lexicalRelative);
	let ancestor = dirname(canonicalTarget);
	for (;;) {
		try {
			const realAncestor = await realpath(ancestor);
			const ancestorRelative = relative(root, realAncestor);
			if (ancestorRelative.startsWith("..") || isAbsolute(ancestorRelative)) throw new Error("Write path resolves outside the workspace");
			assertWritablePath(join(ancestorRelative, relative(ancestor, canonicalTarget)));
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const parent = dirname(ancestor);
			if (parent === ancestor) throw new Error("Could not resolve a workspace ancestor");
			ancestor = parent;
		}
	}
	if (isSensitiveWorkspacePath(lexicalRelative)) throw new Error("Sensitive workspace paths are protected from agent tools");
	return { root, target: canonicalTarget, relativePath: lexicalRelative };
}

async function atomicWriteWorkspaceFile(
	workspaceRoot: string,
	requestedPath: string,
	content: string,
	signal?: AbortSignal,
	observer?: WorkspaceMutationObserver,
	writeScope?: WorkspaceWriteScope,
): Promise<{ path: string; bytes: number; changed: boolean }> {
	throwIfAborted(signal);
	const bytes = Buffer.byteLength(content);
	if (bytes > MAX_INPUT_BYTES) throw new Error(`Content exceeds ${MAX_INPUT_BYTES} bytes`);
	const resolved = await resolveWritableInsideWorkspace(workspaceRoot, requestedPath);
	assertWriteAllowed(resolved.target, writeScope);
	await mkdir(dirname(resolved.target), { recursive: true });
	const realParent = await realpath(dirname(resolved.target));
	const parentRelative = relative(resolved.root, realParent);
	if (parentRelative.startsWith("..") || isAbsolute(parentRelative)) throw new Error("Write path resolves outside the workspace");
	assertWritablePath(join(parentRelative, basename(resolved.target)));
	let mode = 0o644;
	let changed = true;
	try {
		const existing = await lstat(resolved.target);
		if (existing.isSymbolicLink() || !existing.isFile()) throw new Error("Write target must be a regular file");
		if (existing.nlink !== 1) throw new Error("Hard-linked files are not supported");
		mode = existing.mode & 0o777;
		changed = await readBoundedFile(resolved.target, signal) !== content;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await observer?.before(resolved.relativePath);
	const temporary = join(realParent, `.${basename(resolved.target)}.codetonomy-${randomUUID()}.tmp`);
	let primaryError: unknown;
	try {
		const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
		try {
			throwIfAborted(signal);
			await handle.writeFile(content, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		throwIfAborted(signal);
		await rename(temporary, resolved.target);
	} catch (error) {
		primaryError = error;
		throw error;
	} finally {
		await unlink(temporary).catch(() => undefined);
		try { await observer?.after(resolved.relativePath); }
		catch (error) { if (!primaryError) throw new ToolExecutionError("Write settled but checkpoint capture failed; inspect current state", { executionOutcome: "effects-unknown", rewindCoverage: "incomplete" }, error); }
	}
	return { path: resolved.relativePath, bytes, changed };
}

const pathWithin = (root: string, path: string): boolean => {
	const candidate = relative(root, path);
	return candidate === "" || (!candidate.startsWith("..") && !isAbsolute(candidate));
};

const assertWriteAllowed = (target: string, scope?: WorkspaceWriteScope): void => {
	if (!scope || scope.wholeWorkspace) return;
	if (!scope.paths.some((root) => pathWithin(root, target))) throw new Error("Write path is outside the child agent's declared write claim");
};

async function* walkWorkspace(
	root: string,
	start: string,
	maximumDepth: number,
	signal?: AbortSignal,
): AsyncGenerator<{ path: string; relativePath: string; directory: boolean; depth: number }> {
	const queue = [{ path: start, depth: 0 }];
	while (queue.length) {
		throwIfAborted(signal);
		const current = queue.shift()!;
		const directory = await opendir(current.path);
		const entries = [];
		for await (const entry of directory) entries.push(entry);
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			throwIfAborted(signal);
			if (entry.isSymbolicLink() || (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name))) continue;
			const path = join(current.path, entry.name);
			const relativePath = relative(root, path);
			if (isSensitiveWorkspacePath(relativePath)) continue;
			yield { path, relativePath, directory: entry.isDirectory(), depth: current.depth };
			if (entry.isDirectory() && current.depth < maximumDepth) queue.push({ path, depth: current.depth + 1 });
		}
	}
}

const matchesWorkspaceGlobs = (path: string, globs: readonly string[] | undefined): boolean => {
	if (!globs?.length) return true;
	const normalized = displayPath(path);
	let included = !globs.some((glob) => !glob.startsWith("!"));
	for (const rule of globs) {
		const excluded = rule.startsWith("!");
		const pattern = excluded ? rule.slice(1) : rule;
		if (!pattern) continue;
		if (matchesGlob(normalized, pattern) || (!pattern.includes("/") && matchesGlob(basename(normalized), pattern))) included = !excluded;
	}
	return included;
};

const truncateUtf8 = (value: string, maximumBytes = MAX_OUTPUT_BYTES): { text: string; truncated: boolean } => {
	const bytes = Buffer.from(value);
	if (bytes.length <= maximumBytes) return { text: value, truncated: false };
	let end = maximumBytes;
	while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end--;
	return { text: `${bytes.subarray(0, end).toString("utf8")}\n\n[Output truncated at ${maximumBytes} bytes]`, truncated: true };
};

const queryMatchOffset = (text: string, query: string): number => {
	const lower = text.toLocaleLowerCase();
	const exact = lower.indexOf(query.trim().toLocaleLowerCase());
	if (exact >= 0) return exact;
	for (const term of [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])].sort((left, right) => right.length - left.length)) {
		if (term.length < 2) continue;
		const offset = lower.indexOf(term);
		if (offset >= 0) return offset;
	}
	return -1;
};

// Adapted from Reasonix MakeSnippet: compact whitespace and center the excerpt on the query.
const queryExcerpt = (text: string, query: string, maximum = 240): string => {
	const compact = text.replaceAll(/\s+/g, " ").trim();
	if (compact.length <= maximum) return compact;
	const offset = Math.max(0, queryMatchOffset(compact, query));
	const start = Math.max(0, Math.min(offset - Math.floor(maximum / 2), compact.length - maximum));
	return `${start ? "… " : ""}${compact.slice(start, start + maximum).trim()}${start + maximum < compact.length ? " …" : ""}`;
};

const sourceNumber = (value: string): number => Number(value.replaceAll("_", ""));
const claimCandidate = (hit: Awaited<ReturnType<WorkspaceSearchBackend["search"]>>[number]): WorkspaceClaimCandidate | undefined => {
	const clamp = hit.content.match(/Math\.min\(\s*([\d_]+)\s*,\s*Math\.max\(\s*([\d_]+)/s);
	const validation = hit.content.match(/\b\w+\s*<\s*([\d_]+)[\s\S]{0,100}?\b\w+\s*>\s*([\d_]+)/);
	const bounds = clamp ? { minimum: sourceNumber(clamp[2]!), maximum: sourceNumber(clamp[1]!) }
		: validation ? { minimum: sourceNumber(validation[1]!), maximum: sourceNumber(validation[2]!) } : undefined;
	const layer = hit.structure?.architecturalLayer;
	if (!bounds || !layer) return undefined;
	const localSymbol = hit.structure?.symbol
		? [hit.structure.enclosingClass, hit.structure.symbol].filter(Boolean).join(".")
		: undefined;
	return {
		path: hit.path,
		architecturalLayer: layer,
		symbols: [...new Set([hit.structure?.owner, localSymbol, hit.structure?.symbol].filter((value): value is string => Boolean(value)))],
		...bounds,
		unit: /result-count/i.test(layer) ? "results" : "tokens",
	};
};

export function listWorkspaceTool(workspaceRoot: string): AgentTool<typeof listWorkspaceParameters> {
	return {
		name: "list_workspace",
		label: "List workspace",
		description: toolCacheDefinitions.list_workspace.description,
		parameters: listWorkspaceParameters,
		executionMode: "parallel",
		async execute(_toolCallId, { path = ".", depth = 2, limit = 200 }, signal) {
			const resolved = await resolveExistingInsideWorkspace(workspaceRoot, path);
			if (!(await lstat(resolved.target)).isDirectory()) throw new Error("Path is not a directory");
			const lines: string[] = [];
			let limited = false;
			for await (const entry of walkWorkspace(resolved.root, resolved.target, depth, signal)) {
				if (lines.length === limit) {
					limited = true;
					break;
				}
				lines.push(`${displayPath(entry.relativePath)}${entry.directory ? "/" : ""}`);
			}
			const raw = lines.length ? lines.join("\n") : "(empty directory)";
			const suffix = limited ? `\n\n[Entry limit ${limit} reached]` : "";
			const output = truncateUtf8(raw + suffix);
			return { content: [{ type: "text", text: output.text }], details: { entries: lines.length, truncated: limited || output.truncated } };
		},
	};
}

export function searchWorkspaceTool(workspaceRoot: string, backend?: WorkspaceSearchBackend): AgentTool<typeof searchWorkspaceParameters> {
	let indexedSearches = 0;
	return {
		name: "search_workspace",
		label: "Search workspace",
		description: toolCacheDefinitions.search_workspace.description,
		parameters: searchWorkspaceParameters,
		executionMode: "parallel",
		async execute(_toolCallId, { query, path = ".", caseSensitive = false, limit = 100, globs }, signal) {
			const resolved = await resolveExistingInsideWorkspace(workspaceRoot, path);
			const targetInfo = await lstat(resolved.target);
			const backendPath = displayPath(resolved.relativePath) || ".";
			const inRequestedPath = (candidatePath: string): boolean => targetInfo.isDirectory()
				? backendPath === "." || candidatePath === backendPath || candidatePath.startsWith(`${backendPath}/`)
				: candidatePath === backendPath;
			let indexedBudgetExhausted = false;
			let backendFallback: "budget" | "empty" | "error" | "path-constraints" | undefined = backend && globs?.length ? "path-constraints" : undefined;
			if (backend && !caseSensitive && !globs?.length) {
				indexedBudgetExhausted = indexedSearches >= 4;
				if (indexedBudgetExhausted) backendFallback = "budget";
				if (!indexedBudgetExhausted) try {
					indexedSearches++;
					indexedBudgetExhausted = indexedSearches === 4;
					const indexedHits = (await backend.search(query, { path: backendPath, limit: Math.min(limit, 12), signal })).slice(0, Math.min(limit, 12));
					const sourceFiles = new Map<string, string | undefined>();
					const sourceHashes = new Map<string, string>();
					// Validate each source once, including binary documents with version hashes.
					for (const path of new Set(indexedHits.map((hit) => hit.path))) {
						try {
							const candidate = await resolveExistingInsideWorkspace(workspaceRoot, path);
							if (!inRequestedPath(displayPath(candidate.relativePath))) continue;
							const bytes = await readBoundedBytes(candidate.target, signal, 50 * 1024 * 1024);
							sourceHashes.set(path, createHash("sha256").update(bytes).digest("hex"));
							if (bytes.length <= MAX_INPUT_BYTES) try { sourceFiles.set(path, new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch {}
						} catch (error) { if (signal?.aborted) throw error; }
					}
					const hits = indexedHits.filter((hit) => hit.contentHash
						? sourceHashes.get(hit.path) === hit.contentHash
						: sourceFiles.get(hit.path)?.replaceAll("\r\n", "\n").includes(hit.content));
					if (hits.length) {
						const claimCandidates = hits.flatMap((hit) => claimCandidate(hit) ?? []);
						const lines = await Promise.all(hits.map(async (hit) => {
							const file = sourceFiles.get(hit.path);
							const chunkOffset = file?.indexOf(hit.content) ?? -1;
							const hitOffset = Math.max(0, queryMatchOffset(hit.content, query));
							const offset = file === undefined ? -1 : chunkOffset >= 0 ? chunkOffset + hitOffset : queryMatchOffset(file, query);
							const location = offset >= 0 ? `:${file!.slice(0, offset).split("\n").length}` : hit.pageNumber ? `:page-${hit.pageNumber}` : "";
							const symbol = hit.structure?.owner ?? [hit.structure?.enclosingClass, hit.structure?.symbol].filter(Boolean).join(".");
							const context = [hit.structure?.architecturalLayer && `layer=${hit.structure.architecturalLayer}`, symbol && `symbol=${symbol}`].filter(Boolean).join("; ");
							return `${displayPath(hit.path)}${location}: ${context ? `[${context}] ` : ""}${queryExcerpt(hit.content, query)}`;
						}));
						const layers = [...new Map(claimCandidates.map((candidate) => [candidate.architecturalLayer, candidate])).values()];
						const competing = layers.length > 1
							? `Competing architectural layers found; do not conflate them: ${layers.map(({ architecturalLayer, symbols, minimum, maximum, unit }) => `${architecturalLayer} -> ${symbols[0] ?? "unknown symbol"} [${minimum}, ${maximum}] ${unit}`).join("; ")}\n`
							: "";
						const output = truncateUtf8(competing + lines.join("\n"));
						return { content: [{ type: "text", text: output.text }], details: { backend: "memoryDB", matches: hits.length, truncated: output.truncated, budgetExhausted: indexedBudgetExhausted, claimCandidates } };
					}
					backendFallback = "empty";
				} catch { backendFallback = "error"; }
			}
			const needle = caseSensitive ? query : query.toLocaleLowerCase();
			const matches: string[] = [];
			let searchedFiles = 0;
			let limited = false;
			const candidates = targetInfo.isDirectory()
				? walkWorkspace(resolved.root, resolved.target, Number.MAX_SAFE_INTEGER, signal)
				: (async function* () { yield { path: resolved.target, relativePath: resolved.relativePath, directory: false, depth: 0 }; })();

			for await (const candidate of candidates) {
				if (candidate.directory) continue;
				if (!matchesWorkspaceGlobs(candidate.relativePath, globs)) continue;
				if (++searchedFiles > MAX_SEARCHED_FILES) {
					limited = true;
					break;
				}
				let content: string;
				try {
					content = await readBoundedFile(candidate.path, signal);
				} catch (error) {
					if (signal?.aborted) throw error;
					continue;
				}
				const lines = content.split("\n");
				for (let index = 0; index < lines.length; index++) {
					const line = lines[index] ?? "";
					const haystack = caseSensitive ? line : line.toLocaleLowerCase();
					if (!haystack.includes(needle)) continue;
					matches.push(`${displayPath(candidate.relativePath)}:${index + 1}: ${line.slice(0, 500)}`);
					if (matches.length === limit) {
						limited = true;
						break;
					}
				}
				if (limited) break;
			}
			const raw = matches.length ? matches.join("\n") : "No matches found";
			const suffix = limited ? `\n\n[Search limit reached after ${searchedFiles} files and ${matches.length} matches]` : "";
			const output = truncateUtf8(raw + suffix);
			return {
				content: [{ type: "text", text: output.text }],
				details: {
					backend: "literal",
					searchedFiles,
					matches: matches.length,
					truncated: limited || output.truncated,
					budgetExhausted: indexedBudgetExhausted,
					...(backendFallback ? { backendFallback } : {}),
				},
			};
		},
	};
}

export function inspectWorkspaceTool(workspaceRoot: string): AgentTool<typeof inspectWorkspaceParameters> {
	return {
		name: "inspect_workspace",
		label: "Inspect workspace file",
		description: toolCacheDefinitions.inspect_workspace.description,
		parameters: inspectWorkspaceParameters,
		executionMode: "parallel",
		async execute(_toolCallId, { path, offset = 1, limit = 400 }, signal) {
			const resolved = await resolveExistingInsideWorkspace(workspaceRoot, path);
			const content = await readBoundedFile(resolved.target, signal);
			const lines = content.split("\n");
			if (offset > lines.length) throw new Error(`Offset ${offset} is beyond end of file (${lines.length} lines)`);
			const selected = lines.slice(offset - 1, offset - 1 + limit);
			const output = truncateUtf8(selected.join("\n"));
			const nextOffset = offset - 1 + selected.length < lines.length ? offset + selected.length : undefined;
			const notice = nextOffset ? `\n\n[Showing lines ${offset}-${nextOffset - 1} of ${lines.length}. Continue with offset=${nextOffset}.]` : "";
			return {
				content: [{ type: "text", text: truncateUtf8(output.text + notice).text }],
				details: { path: resolved.relativePath, totalLines: lines.length, nextOffset, truncated: output.truncated || Boolean(nextOffset) },
			};
		},
	};
}

export function writeWorkspaceTool(workspaceRoot: string, observer?: WorkspaceMutationObserver, writeScope?: WorkspaceWriteScope): AgentTool<typeof writeWorkspaceParameters> {
	return {
		name: "write_workspace",
		label: "Write workspace file",
		description: toolCacheDefinitions.write_workspace.description,
		parameters: writeWorkspaceParameters,
		executionMode: "sequential",
		async execute(_toolCallId, { path, content }, signal) {
			const result = await atomicWriteWorkspaceFile(workspaceRoot, path, content, signal, observer, writeScope);
			return { content: [{ type: "text", text: `Wrote ${result.bytes} bytes to ${result.path}` }], details: result };
		},
	};
}

export function editWorkspaceTool(workspaceRoot: string, observer?: WorkspaceMutationObserver, writeScope?: WorkspaceWriteScope): AgentTool<typeof editWorkspaceParameters> {
	return {
		name: "edit_workspace",
		label: "Edit workspace file",
		description: toolCacheDefinitions.edit_workspace.description,
		parameters: editWorkspaceParameters,
		executionMode: "sequential",
		async execute(_toolCallId, { path, oldText, newText, replaceAll = false }, signal) {
			const existing = await resolveExistingInsideWorkspace(workspaceRoot, path);
			const content = await readBoundedFile(existing.target, signal);
			const occurrences = content.split(oldText).length - 1;
			if (occurrences === 0) throw new ToolExecutionError("oldText was not found in the target file; inspect the current text before correcting the edit", { executionOutcome: "rejected-before-start" });
			if (occurrences > 1 && !replaceAll) throw new ToolExecutionError(`oldText matched ${occurrences} locations; provide a unique match or set replaceAll`, { executionOutcome: "rejected-before-start" });
			const updated = replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, () => newText);
			const result = await atomicWriteWorkspaceFile(workspaceRoot, path, updated, signal, observer, writeScope);
			return {
				content: [{ type: "text", text: `Edited ${result.path} (${replaceAll ? occurrences : 1} replacement${occurrences === 1 ? "" : "s"})` }],
				details: { ...result, replacements: replaceAll ? occurrences : 1 },
			};
		},
	};
}

export type CommandSandboxMode = "read-only" | "workspace" | "full-access";

export interface SandboxCommandOptions {
	codexBinary?: string;
	observer?: WorkspaceMutationObserver;
	commandSandboxMode?: CommandSandboxMode;
	allowArgumentLineBreaks?: boolean;
	rawOutput?: boolean;
}

export const resolveCodexBinary = (explicit?: string): string => {
	if (explicit) return explicit;
	if (process.env.CODETONOMY_CODEX_BIN) return process.env.CODETONOMY_CODEX_BIN;
	const workerRoots = [
		process.env.CODETONOMY_WORKER_ROOT,
		process.env.CODETONOMY_HOME ? join(process.env.CODETONOMY_HOME, "workers") : undefined,
		join(homedir(), ".codetonomy", "workers"),
	].filter((value): value is string => Boolean(value));
	const windowsTarget = process.arch === "arm64" ? ["codex-win32-arm64", "aarch64-pc-windows-msvc"] : ["codex-win32-x64", "x86_64-pc-windows-msvc"];
	const workerCandidates = workerRoots.flatMap((root) => process.platform === "win32"
		? [join(root, "codex", "node_modules", `@openai/${windowsTarget[0]}`, "vendor", windowsTarget[1]!, "bin", "codex.exe")]
		: [join(root, "codex", "node_modules", ".bin", "codex")]);
	let desktopCandidates: string[] = [];
	if (process.platform === "win32" && process.env.LOCALAPPDATA) {
		const desktopBin = join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
		try {
			desktopCandidates = readdirSync(desktopBin, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => join(desktopBin, entry.name, "codex.exe"))
				.filter(existsSync)
				.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
		} catch {}
	}
	const candidates = [...workerCandidates, ...desktopCandidates];
	return candidates.find(existsSync) ?? "codex";
};

const sandboxRuntimeReadPaths = (): string[] => {
	const codexBinary = resolveCodexBinary();
	const codexDirectory = isAbsolute(codexBinary) ? dirname(codexBinary) : undefined;
	const codexInstallation = codexDirectory && basename(codexDirectory) === ".bin" ? dirname(codexDirectory) : codexDirectory;
	return [...new Set([
		dirname(process.execPath),
		codexInstallation,
		...(process.platform === "darwin" ? ["/System/Library/OpenSSL"] : []),
	].filter((path): path is string => Boolean(path)))];
};

const SANDBOX_ENVIRONMENT = /^(?:PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TEMP|TMP|TERM|COLORTERM|NO_COLOR|FORCE_COLOR|LANG|LC_.+|CODEX_HOME|RUST_LOG|RUST_BACKTRACE|SystemRoot|WINDIR|PATHEXT|ComSpec)$/;

export const filterSandboxEnvironment = (environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
	Object.fromEntries(Object.entries(environment).filter(([name, value]) => value !== undefined && SANDBOX_ENVIRONMENT.test(name)));

export const normalizeWorkspaceCommandArgv = (argv: string[]): string[] => {
	if (process.platform !== "win32" || !/^npm(?:\.cmd)?$/i.test(argv[0] ?? "")) return argv;
	const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
	return existsSync(npmCli) ? [process.execPath, npmCli, ...argv.slice(1)] : argv;
};

export function createCodexSandboxInvocation(
	cwd: string,
	argv: string[],
	{ commandSandboxMode = "workspace" }: Pick<SandboxCommandOptions, "commandSandboxMode"> = {},
): string[] {
	const sandboxCwd = pathToFileURL(cwd).href;
	const platformConfiguration = process.platform === "win32" ? ["-c", 'windows.sandbox="elevated"'] : [];
	if (commandSandboxMode === "full-access") {
		return [
			"sandbox",
			"--sandbox-state-json",
			JSON.stringify({
				permissionProfile: { type: "disabled" },
				codexLinuxSandboxExe: null,
				sandboxCwd,
				useLegacyLandlock: false,
			}),
			...platformConfiguration,
			"-c",
			"shell_environment_policy.inherit=core",
			"-c",
			"shell_environment_policy.ignore_default_excludes=false",
			"--",
			...argv,
		];
	}
	const protectedPaths = [".git", ".agents", ".codex", ".codetonomy", ".harness", ".pnpm-store", "node_modules"].map((name) => ({
		path: { type: "path", path: join(cwd, name) },
		access: "read",
		missing_path_behavior: "skip",
	}));
	const configurationRoot = process.env.CODETONOMY_HOME?.trim();
	const privateConfigurationPath = configurationRoot && isAbsolute(configurationRoot) ? [{
		path: { type: "path", path: resolve(configurationRoot) },
		access: "deny",
		missing_path_behavior: "skip",
	}] : [];
	const bashExecutable = resolveBashExecutable();
	const bashDirectory = isAbsolute(bashExecutable) ? dirname(bashExecutable) : undefined;
	const bashInstallationRoot = bashDirectory && basename(bashDirectory).toLowerCase() === "bin"
		? (basename(dirname(bashDirectory)).toLowerCase() === "usr" ? dirname(dirname(bashDirectory)) : dirname(bashDirectory))
		: undefined;
	const toolchainReadPaths = [...new Set([
		...(process.env.PATH ?? "").split(delimiter).map((path) => path.trim().replace(/^"|"$/g, "")),
		...sandboxRuntimeReadPaths(),
		bashDirectory,
		bashInstallationRoot,
	].filter((path): path is string => typeof path === "string" && isAbsolute(path)))].map((path) => ({
		path: { type: "path", path },
		access: "read",
		missing_path_behavior: "skip",
	}));
	const workspaceAccess = {
		path: { type: "path", path: resolve(cwd) },
		access: commandSandboxMode === "read-only" ? "read" : "write",
		missing_path_behavior: "skip",
	};
	const state = {
		permissionProfile: {
			type: "managed",
			file_system: {
				type: "restricted",
				entries: [
					{ path: { type: "special", value: { kind: "minimal" } }, access: "read" },
					...toolchainReadPaths,
					workspaceAccess,
					{ path: { type: "special", value: { kind: "project_roots" } }, access: commandSandboxMode === "read-only" ? "read" : "write" },
					...privateConfigurationPath,
					...(commandSandboxMode === "read-only" ? [] : [
						{ path: { type: "special", value: { kind: "tmpdir" } }, access: "write" },
						{ path: { type: "special", value: { kind: "slash_tmp" } }, access: "write" },
					]),
					...protectedPaths,
				],
			},
			network: "restricted",
		},
		codexLinuxSandboxExe: null,
		sandboxCwd,
		useLegacyLandlock: false,
	};
	return [
		"sandbox",
		"--sandbox-state-json",
		JSON.stringify(state),
		"--sandbox-state-disable-network",
		...platformConfiguration,
		"-c",
		"shell_environment_policy.inherit=core",
		"-c",
		"shell_environment_policy.ignore_default_excludes=false",
		"--",
		...argv,
	];
}

export function createCodexNetworkSandboxInvocation(
	cwd: string,
	argv: string[],
	paths: { read: readonly string[]; write: readonly string[]; deny?: readonly string[] },
): string[] {
	if (process.platform === "linux") {
		throw new Error("memoryDB's loopback sidecar is unavailable on Linux because the pinned native sandbox cannot allow local binding while denying outbound network access");
	}
	const entry = (path: string, access: "deny" | "read" | "write") => ({
		path: { type: "path", path: resolve(path) },
		access,
		missing_path_behavior: "skip",
	});
	const state = {
		permissionProfile: {
			type: "managed",
			file_system: {
				type: "restricted",
				entries: [
					...(process.platform === "win32" ? [] : [{ path: { type: "special", value: { kind: "minimal" } }, access: "read" }]),
					...(process.platform === "win32" ? [dirname(process.execPath)] : sandboxRuntimeReadPaths()).map((path) => entry(path, "read")),
					...(paths.deny ?? []).map((path) => entry(path, "deny")),
					...paths.read.map((path) => entry(path, "read")),
					...paths.write.map((path) => entry(path, "write")),
				],
			},
			network: "restricted",
		},
		codexLinuxSandboxExe: null,
		sandboxCwd: pathToFileURL(cwd).href,
		useLegacyLandlock: false,
	};
	const localBindingConfiguration = process.platform === "darwin" ? [
		"-c", 'default_permissions="codetonomy-sidecar"',
		"-c", 'permissions.codetonomy-sidecar.extends=":workspace"',
		"-c", "permissions.codetonomy-sidecar.network.enabled=true",
		"-c", "features.network_proxy.enabled=true",
		"-c", "features.network_proxy.enable_socks5=false",
		"-c", 'features.network_proxy.proxy_url="http://127.0.0.1:18420"',
		"-c", "features.network_proxy.allow_upstream_proxy=false",
		"-c", "features.network_proxy.allow_local_binding=true",
	] : [];
	return [
		"sandbox",
		"--sandbox-state-json",
		JSON.stringify(state),
		"--sandbox-state-disable-network",
		...(process.platform === "win32" ? ["-c", 'windows.sandbox="elevated"'] : []),
		...localBindingConfiguration,
		"-c",
		"shell_environment_policy.inherit=all",
		"-c",
		"shell_environment_policy.ignore_default_excludes=true",
		"--",
		...argv,
	];
}

async function discoverSensitiveWorkspacePaths(root: string, signal?: AbortSignal): Promise<string[]> {
	// Search exclusions are still readable by commands, so scan them and linked directories too.
	const paths: string[] = [];
	const queue = [root];
	const visited = new Set<string>();
	let scanned = 0;
	while (queue.length) {
		if (signal?.aborted) throw signal.reason ?? new Error("Command aborted");
		const directory = await realpath(queue.shift()!);
		if (visited.has(directory)) continue;
		visited.add(directory);
		for await (const entry of await opendir(directory)) {
			if (++scanned > MAX_WORKSPACE_SCAN_ENTRIES) throw new Error(`Sensitive-path scan exceeds ${MAX_WORKSPACE_SCAN_ENTRIES} workspace entries`);
			const path = join(directory, entry.name);
			if (isSensitiveWorkspacePath(relative(root, path))) paths.push(path);
			else if (entry.isSymbolicLink()) {
				const target = await realpath(path);
				if (isSensitiveWorkspacePath(target)) paths.push(path);
				else if ((await lstat(target)).isDirectory()) queue.push(target);
			} else if (entry.isDirectory()) queue.push(path);
		}
	}
	return paths;
}

async function runBoundedProcess(
	program: string,
	args: string[],
	cwd: string,
	timeoutSeconds: number,
	signal?: AbortSignal,
): Promise<{ exitCode: number | null; output: string }> {
	throwIfAborted(signal);
	return new Promise((resolveProcess, rejectProcess) => {
		const child = spawn(program, args, {
			cwd,
			detached: process.platform !== "win32",
			env: filterSandboxEnvironment(process.env),
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const chunks: Buffer[] = [];
		let bytes = 0;
		let failure: Error | undefined;
		let killTimer: NodeJS.Timeout | undefined;
		let killedOnExit = false;
		const killTree = (force: boolean) => {
			if (!child.pid) return;
			if (process.platform === "win32") {
				const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])], { stdio: "ignore", windowsHide: true });
				const fallback = () => { try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch {} };
				killer.once("error", fallback);
				killer.once("close", (code) => { if (code !== 0) fallback(); });
				return;
			}
			try { process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); } catch {}
		};
		const terminate = (error: Error) => {
			if (failure) return;
			failure = error;
			killTree(false);
			killTimer = setTimeout(() => {
				killTree(true);
			}, 1_000);
			killTimer.unref();
		};
		const onData = (chunk: Buffer) => {
			if (failure) return;
			bytes += chunk.length;
			if (bytes > MAX_OUTPUT_BYTES) {
				terminate(new Error(`Command output exceeds ${MAX_OUTPUT_BYTES} bytes`));
				return;
			}
			chunks.push(chunk);
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		const onAbort = () => terminate(new Error("Command aborted"));
		signal?.addEventListener("abort", onAbort, { once: true });
		const timeout = setTimeout(() => terminate(new Error(`Command timed out after ${timeoutSeconds} seconds`)), timeoutSeconds * 1_000);
		timeout.unref();
		child.once("error", (error) => {
			failure = error;
		});
		child.once("exit", () => {
			killedOnExit = true;
			killTree(true);
		});
		child.once("close", (exitCode) => {
			clearTimeout(timeout);
			if (killTimer) clearTimeout(killTimer);
			if (!killedOnExit) killTree(true);
			signal?.removeEventListener("abort", onAbort);
			if (failure) rejectProcess(new ToolExecutionError(`${failure.message}. Command effects may already have occurred; inspect state before retrying.`, { executionOutcome: child.pid ? "effects-unknown" : "rejected-before-start", exitCode, output: Buffer.concat(chunks).toString("utf8") }, failure));
			else resolveProcess({ exitCode, output: Buffer.concat(chunks).toString("utf8") });
		});
	});
}

export function runWorkspaceCommandTool(
	workspaceRoot: string,
	options: SandboxCommandOptions = {},
): AgentTool<typeof runWorkspaceCommandParameters> {
	return {
		name: "run_workspace_command",
		label: "Run sandboxed workspace command",
		description: toolCacheDefinitions.run_workspace_command.description,
		parameters: runWorkspaceCommandParameters,
		executionMode: "sequential",
		async execute(_toolCallId, { argv, cwd = ".", timeoutSeconds = 120 }, signal) {
			if (argv.some((argument) => argument.includes("\u0000") || (!options.allowArgumentLineBreaks && /[\r\n]/.test(argument)))) {
				throw new Error("Command arguments cannot contain control line breaks");
			}
			const resolved = await resolveExistingInsideWorkspace(workspaceRoot, cwd);
			if (!(await lstat(resolved.target)).isDirectory()) throw new Error("Command cwd is not a directory");
			const commandSandboxMode = options.commandSandboxMode ?? "workspace";
			const sensitivePaths = commandSandboxMode === "full-access" ? [] : await discoverSensitiveWorkspacePaths(resolved.root, signal);
			if (sensitivePaths.length) throw new Error(`Sandboxed workspace commands are blocked while ${sensitivePaths.length} sensitive path${sensitivePaths.length === 1 ? " is" : "s are"} present; use structured tools or explicitly authorized full-access mode`);
			const invocation = createCodexSandboxInvocation(resolved.target, normalizeWorkspaceCommandArgv(argv), { commandSandboxMode });
			const observer = commandSandboxMode === "read-only" ? undefined : options.observer;
			await observer?.beforeWorkspace?.();
			let result;
			let changedPaths: string[] | void = undefined;
			let executionError: unknown;
			try { result = await runBoundedProcess(resolveCodexBinary(options.codexBinary), invocation, resolved.target, timeoutSeconds, signal); }
			catch (error) { executionError = error; }
			try { changedPaths = await observer?.afterWorkspace?.(); }
			catch (error) {
				if (executionError instanceof ToolExecutionError) executionError.details.rewindCoverage = "incomplete";
				if (!executionError) executionError = new ToolExecutionError("Command settled but checkpoint capture failed; effects require reconciliation", { executionOutcome: "effects-unknown", exitCode: result?.exitCode, rewindCoverage: "incomplete" }, error);
			}
			if (executionError) throw executionError;
			if (!result) throw new Error("Command result missing");
			const text = options.rawOutput ? result.output : result.output.trim() || "(no output)";
			return {
				content: [{ type: "text", text: options.rawOutput ? text : `Sandboxed command exited ${result.exitCode ?? "without a code"}.\n${text}` }],
				details: { argv, cwd: resolved.relativePath, exitCode: result.exitCode, changedPaths: changedPaths ?? [], sandbox: "codex-native", filesystem: commandSandboxMode, network: commandSandboxMode === "full-access" ? "enabled" : "disabled", rewindCoverage: commandSandboxMode === "read-only" ? "captured" : observer ? observer.coverage?.() ?? "captured" : "incomplete" },
			};
		},
	};
}

const primaryBashLeaf = (operation: BashOperation): BashLeafOperation => operation.kind === "compound"
	? operation.parts[0]!.operation
	: operation;

const operationToolId = (operation: BashOperation): string => primaryBashLeaf(operation).kind === "pwd"
	? "bash.pwd"
	: bashPermissionTarget(operation).toolId;

const virtualWorkspacePath = (path: string): string => path === "." ? "/workspace" : `/workspace/${path.replaceAll("\\", "/")}`;

export const resolveBashExecutable = (): string => {
	const explicit = process.env.CODETONOMY_BASH_BIN;
	if (explicit) return explicit;
	if (process.platform !== "win32") {
		const configured = process.env.SHELL;
		if (configured && /^bash(?:\.exe)?$/i.test(basename(configured))) return configured;
		return ["/bin/bash", "/usr/bin/bash"].find(existsSync) ?? "bash";
	}
	const programFiles = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter((value): value is string => Boolean(value));
	const pathCandidates = (process.env.PATH ?? "").split(delimiter)
		.map((directory) => directory.trim().replace(/^"|"$/g, ""))
		.filter(Boolean)
		.map((directory) => join(directory, "bash.exe"));
	return [
		...programFiles.flatMap((directory) => [join(directory, "Git", "bin", "bash.exe"), join(directory, "Git", "usr", "bin", "bash.exe")]),
		...pathCandidates,
	].find(existsSync) ?? "bash";
};

export const createNativeBashArgv = (command: string): string[] => [resolveBashExecutable(), "--noprofile", "--norc", "-c", command];

const nativeBashCommandArgv = (workspaceRoot: string, argv: readonly string[]): string[] => argv.map((argument) => {
	const equals = argument.indexOf("=");
	const prefix = equals > 0 ? argument.slice(0, equals + 1) : "";
	const value = prefix ? argument.slice(equals + 1) : argument;
	if (value !== "/workspace" && !value.startsWith("/workspace/")) return argument;
	const root = resolve(workspaceRoot);
	const target = resolve(root, value === "/workspace" ? "." : value.slice("/workspace/".length));
	const resolvedRelative = relative(root, target);
	if (resolvedRelative.startsWith("..") || isAbsolute(resolvedRelative)) throw new Error("bash command argument escapes the workspace");
	return prefix + target;
});

const virtualizeBashPaths = (operation: BashLeafOperation, output: string): string => {
	if (operation.kind !== "list" && operation.kind !== "search") return output;
	return output.split("\n").filter((line) => operation.kind !== "search" || !line.startsWith("Competing architectural layers found;")).map((line) => {
		if (!line || line === "(empty directory)" || /^\[(?:Entry limit|Search limit|Output truncated)/.test(line) || line === "No matches found" || line.startsWith("Competing architectural layers found;")) return line;
		const normalized = operation.kind === "search"
			? line.replace(/^([^:]+(?::(?:\d+|page-\d+))?: )\[[^\]]+\] /, "$1")
			: line;
		return virtualWorkspacePath(normalized);
	}).join("\n");
};

const bashOperationPaths = (operation: { path: string; paths?: string[] }): string[] => operation.paths ?? [operation.path];

const textContent = (result: { content: Array<{ type: string; text?: string }> }): string => result.content[0]?.type === "text"
	? result.content[0].text ?? ""
	: "";

const stripInspectNotice = (text: string): string => text.replace(/\n\n\[Showing lines \d+-\d+ of \d+\. Continue with offset=\d+\.\]$/, "");

const BASH_FILESYSTEM_ROOT_ARGUMENT = /(?:^|[\s;&|])(?:["']\/["']|\/|["'][A-Za-z]:[\\/]["']|[A-Za-z]:[\\/])(?=$|[\s;&|])/u;

interface BashLeafExecution {
	text: string;
	details: Record<string, unknown>;
	status: 0 | 1;
}

const isHardBashFailure = (error: unknown): boolean => /(?:protected|outside the workspace|escapes the workspace|hard-linked|operation aborted|permission|sandbox)/i.test(
	error instanceof Error ? error.message : String(error),
);

const postProcessBashSearch = (operation: Extract<BashLeafOperation, { kind: "search" }>, lines: string[]): string[] => {
	let selected = lines.filter((line) => line && line !== "No matches found" && !/^\[(?:Search limit|Output truncated)/.test(line));
	if (operation.wordRegexp) {
		const escaped = operation.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const pattern = new RegExp(`\\b${escaped}\\b`, operation.ignoreCase ? "iu" : "u");
		selected = selected.filter((line) => pattern.test(line.replace(/^.*?:(?:\d+|page-\d+): /, "")));
	}
	if (operation.maxCount !== undefined) {
		const counts = new Map<string, number>();
		selected = selected.filter((line) => {
			const path = line.match(/^(.*?):(?:\d+|page-\d+): /)?.[1] ?? line;
			const count = counts.get(path) ?? 0;
			if (count >= operation.maxCount!) return false;
			counts.set(path, count + 1);
			return true;
		});
	}
	if (operation.filesWithMatches) return [...new Set(selected.map((line) => line.match(/^(.*?):(?:\d+|page-\d+): /)?.[1] ?? line))];
	if (!operation.heading) return selected;
	const grouped = new Map<string, string[]>();
	for (const line of selected) {
		const match = line.match(/^(.*?):((?:\d+|page-\d+): .*)$/);
		if (!match) continue;
		const group = grouped.get(match[1]!) ?? [];
		group.push(match[2]!);
		grouped.set(match[1]!, group);
	}
	return [...grouped].flatMap(([path, matches], index) => [...(index ? [""] : []), path, ...matches]);
};

export function bashTool(
	workspaceRoot: string,
	options: SandboxCommandOptions & { allowedCanonicalToolIds?: readonly string[]; nativeOperationId?: "inspect_workspace" | "run_workspace_command"; planner?: BashCommandPlanner } = {},
): AgentTool<typeof bashParameters> {
	const allowedCanonicalToolIds = options.allowedCanonicalToolIds ? new Set(options.allowedCanonicalToolIds) : undefined;
	const planner = options.planner ?? new BashCommandPlanner();
	const list = listWorkspaceTool(workspaceRoot);
	const literalSearch = searchWorkspaceTool(workspaceRoot);
	const inspect = inspectWorkspaceTool(workspaceRoot);
	const command = runWorkspaceCommandTool(workspaceRoot, options);
	const shell = runWorkspaceCommandTool(workspaceRoot, { ...options, allowArgumentLineBreaks: true, rawOutput: true });
	const executeNative = async (toolCallId: string, args: BashToolArguments, plan: BashCommandPlan, signal?: AbortSignal) => {
		const operationId = options.nativeOperationId ?? (options.commandSandboxMode === "read-only" ? "inspect_workspace" : "run_workspace_command");
		if (allowedCanonicalToolIds && !allowedCanonicalToolIds.has(operationId)) {
			throw new Error(`bash operation is unavailable in this tool profile: ${operationId}`);
		}
		if (options.commandSandboxMode !== "full-access" && plan.reason === "workspace-escape") throw new Error("bash path escapes the workspace");
		if (options.commandSandboxMode !== "full-access" && BASH_FILESYSTEM_ROOT_ARGUMENT.test(args.command)) {
			throw new Error("bash filesystem-root paths are unavailable in workspace mode; use a workspace-relative path");
		}
		const argv = createNativeBashArgv(args.command);
		const result = await shell.execute(toolCallId, { argv, cwd: args.cwd ?? ".", timeoutSeconds: args.timeoutSeconds ?? 120 }, signal);
		const details = result.details && typeof result.details === "object" ? result.details as Record<string, unknown> : {};
		const output = textContent(result);
		const bounded = truncateUtf8(output);
		return {
			content: [{ type: "text" as const, text: bounded.text }],
			details: {
				...details,
				...(plan.route === "semantic-native" && plan.operation.kind === "command" ? { semanticArgv: plan.operation.argv } : {}),
				truncated: details.truncated === true || bounded.truncated,
				operationId,
				bashKind: "native",
				shell: argv[0],
				parseStatus: plan.route,
				planReason: plan.reason,
			},
		};
	};
	const executeLeaf = async (toolCallId: string, operation: BashLeafOperation, signal?: AbortSignal): Promise<BashLeafExecution> => {
		if (operation.kind === "pwd") {
			const resolved = await resolveExistingInsideWorkspace(workspaceRoot, operation.cwd);
			if (!(await lstat(resolved.target)).isDirectory()) throw new Error("bash cwd is not a directory");
			return { text: virtualWorkspacePath(resolved.relativePath), details: { cwd: resolved.relativePath }, status: 0 };
		}
		if (operation.kind === "list") {
			const outputs: string[] = [];
			let entries = 0;
			let truncated = false;
			const paths = bashOperationPaths(operation);
			for (const [index, path] of paths.entries()) {
				const result = await list.execute(`${toolCallId}-${index}`, { path, depth: 0, limit: 200 }, signal);
				const details = result.details && typeof result.details === "object" ? result.details as Record<string, unknown> : {};
				entries += typeof details.entries === "number" ? details.entries : 0;
				truncated ||= details.truncated === true;
				const body = virtualizeBashPaths({ ...operation, path, paths: undefined }, textContent(result));
				outputs.push(paths.length > 1 ? `${virtualWorkspacePath(path)}:\n${body}` : body);
			}
			const notice = operation.long || operation.all ? "[deterministic path listing; protected entries hidden; -l metadata unavailable]\n" : "";
			return { text: notice + outputs.join("\n\n"), details: { entries, truncated }, status: 0 };
		}
		if (operation.kind === "files") {
			const found = new Set<string>();
			let truncated = false;
			for (const path of bashOperationPaths(operation)) {
				const resolved = await resolveExistingInsideWorkspace(workspaceRoot, path);
				const info = await lstat(resolved.target);
				if (!info.isDirectory()) {
					if (matchesWorkspaceGlobs(resolved.relativePath, operation.globs)) found.add(resolved.relativePath);
					continue;
				}
				for await (const entry of walkWorkspace(resolved.root, resolved.target, Number.MAX_SAFE_INTEGER, signal)) {
					if (entry.directory || !matchesWorkspaceGlobs(entry.relativePath, operation.globs)) continue;
					found.add(entry.relativePath);
					if (found.size >= 1_000) {
						truncated = true;
						break;
					}
				}
				if (truncated) break;
			}
			const paths = [...found].sort((left, right) => left.localeCompare(right));
			const suffix = truncated ? "\n\n[Entry limit 1000 reached]" : "";
			return { text: (paths.map(virtualWorkspacePath).join("\n") || "(empty)") + suffix, details: { entries: paths.length, truncated }, status: 0 };
		}
		if (operation.kind === "search") {
			const outputLines: string[] = [];
			const backends = new Set<string>();
			const backendFallbacks = new Set<string>();
			const claimCandidates: unknown[] = [];
			let budgetExhausted = false;
			let truncated = false;
			for (const [index, path] of bashOperationPaths(operation).entries()) {
				const result = await literalSearch.execute(`${toolCallId}-${index}`, {
					query: operation.query,
					path,
					caseSensitive: !operation.ignoreCase,
					limit: 500,
					...(operation.globs?.length ? { globs: operation.globs } : {}),
				}, signal);
				const details = result.details && typeof result.details === "object" ? result.details as Record<string, unknown> : {};
				if (typeof details.backend === "string") backends.add(details.backend);
				if (typeof details.backendFallback === "string") backendFallbacks.add(details.backendFallback);
				if (Array.isArray(details.claimCandidates)) claimCandidates.push(...details.claimCandidates);
				budgetExhausted ||= details.budgetExhausted === true;
				truncated ||= details.truncated === true;
				const body = virtualizeBashPaths({ ...operation, path, paths: undefined }, textContent(result));
				outputLines.push(...body.split("\n"));
			}
			const selected = postProcessBashSearch(operation, outputLines);
			const backend = backends.size === 1 ? [...backends][0] : backends.size ? "mixed" : "literal";
			return {
				text: selected.join("\n") || "No matches found",
				details: {
					backend,
					matches: selected.length,
					truncated,
					budgetExhausted,
					claimCandidates,
					...(backendFallbacks.size === 1 ? { backendFallback: [...backendFallbacks][0] } : backendFallbacks.size ? { backendFallback: "mixed" } : {}),
				},
				status: selected.length ? 0 : 1,
			};
		}
		if (operation.kind === "read") {
			const outputs: string[] = [];
			let lastDetails: Record<string, unknown> = {};
			for (const [index, path] of bashOperationPaths(operation).entries()) {
				const result = await inspect.execute(`${toolCallId}-${index}`, { path, offset: operation.offset, limit: operation.limit }, signal);
				lastDetails = result.details && typeof result.details === "object" ? result.details as Record<string, unknown> : {};
				const raw = textContent(result);
				outputs.push(operation.mode === "cat" ? raw : stripInspectNotice(raw));
			}
			return { text: outputs.join("\n"), details: { ...lastDetails, paths: bashOperationPaths(operation) }, status: 0 };
		}
		const result = await command.execute(toolCallId, { argv: nativeBashCommandArgv(workspaceRoot, operation.argv), cwd: operation.cwd, timeoutSeconds: operation.timeoutSeconds }, signal);
		return {
			text: textContent(result),
			details: { ...(result.details && typeof result.details === "object" ? result.details as Record<string, unknown> : {}), argv: operation.argv },
			status: 0,
		};
	};
	return {
		name: "bash",
		label: "Bash workspace facade",
		description: toolCacheDefinitions.bash.description,
		parameters: bashParameters,
		executionMode: "sequential",
		async execute(toolCallId, args: BashToolArguments, signal) {
			const plan = planner.consume(toolCallId, args);
			if (plan.route !== "translated") return executeNative(toolCallId, args, plan, signal);
			const operation = plan.operation;
			const targets = bashPermissionTargets(operation);
			const unavailable = allowedCanonicalToolIds && targets.find((target) => !allowedCanonicalToolIds.has(target.toolId));
			if (unavailable) throw new Error(`bash operation is unavailable in this tool profile: ${unavailable.toolId}`);
			if (operation.kind !== "compound") {
				const executed = await executeLeaf(toolCallId, operation, signal);
				const bounded = truncateUtf8(executed.text);
				return {
					content: [{ type: "text", text: bounded.text }],
					details: {
						...executed.details,
						truncated: executed.details.truncated === true || bounded.truncated,
						operationId: operationToolId(operation),
						bashKind: operation.kind,
						parseStatus: plan.route,
						planReason: plan.reason,
						...(operation.kind === "search" ? { exact: operation.exact } : {}),
					},
				};
			}
			const outputs: string[] = [];
			const executedKinds: string[] = [];
			let status: 0 | 1 | 2 = 0;
			let lastDetails: Record<string, unknown> = {};
			let lastError: unknown;
			let evidenceOperation: BashLeafOperation | undefined;
			for (let index = 0; index < operation.parts.length; index++) {
				const operator = index ? operation.operators[index - 1] : undefined;
				const shouldRun = !operator || operator === ";" || (operator === "&&" ? status === 0 : status !== 0);
				if (!shouldRun) continue;
				const part = operation.parts[index]!;
				try {
					const executed = await executeLeaf(`${toolCallId}-${index}`, part.operation, signal);
					status = executed.status;
					lastDetails = executed.details;
					evidenceOperation ??= part.operation;
					executedKinds.push(part.operation.kind);
					const followedByFallback = status !== 0 && operation.operators[index] === "||";
					if (!followedByFallback && executed.text) outputs.push(part.headLines === undefined ? executed.text : executed.text.split("\n").slice(0, part.headLines).join("\n"));
				} catch (error) {
					if (isHardBashFailure(error)) throw error;
					status = 2;
					lastError = error;
					executedKinds.push(part.operation.kind);
					if (!part.suppressStderr) outputs.push("bash: translated command failed");
				}
			}
			if (status === 2 && lastError) throw lastError;
			const bounded = truncateUtf8(outputs.join("\n").trim() || "(no output)");
			return {
				content: [{ type: "text", text: bounded.text }],
				details: {
					...lastDetails,
					truncated: lastDetails.truncated === true || bounded.truncated,
					operationId: operationToolId(evidenceOperation ?? operation),
					bashKind: operation.kind,
					parseStatus: plan.route,
					planReason: plan.reason,
					operations: executedKinds,
					exitStatus: status,
				},
			};
		},
	};
}

export function inspectWorkbookTool(workspaceRoot: string): AgentTool<typeof inspectWorkbookParameters> {
	return {
		name: "inspect_workbook",
		label: "Inspect workbook",
		description: toolCacheDefinitions.inspect_workbook.description,
		parameters: inspectWorkbookParameters,
		executionMode: "parallel",
		async execute(_toolCallId, { path }, signal) {
			const resolved = await resolveExistingInsideWorkspace(workspaceRoot, path);
			const inspection = await inspectWorkbook(workspaceRoot, resolved.relativePath, undefined, signal);
			return { content: [{ type: "text", text: JSON.stringify(inspection, null, 2) }], details: inspection };
		},
	};
}

export function inspectDocumentTool(workspaceRoot: string, options: DocumentParseOptions = {}): AgentTool<typeof inspectDocumentParameters> {
	return {
		name: "inspect_document",
		label: "Inspect document",
		description: toolCacheDefinitions.inspect_document.description,
		parameters: inspectDocumentParameters,
		executionMode: "parallel",
		async execute(_toolCallId, { path }, signal) {
			const resolved = await resolveExistingInsideWorkspace(workspaceRoot, path);
			const document = await parseDocument(workspaceRoot, resolved.relativePath, { ...options, signal });
			const output = truncateUtf8(JSON.stringify(document, null, 2));
			return { content: [{ type: "text", text: output.text }], details: { path: resolved.relativePath, documentId: document.documentId, pages: document.pages.length, truncated: output.truncated } };
		},
	};
}

export function createValuationWorkbookTool(
	workspaceRoot: string,
	observer?: WorkspaceMutationObserver,
	writeScope?: WorkspaceWriteScope,
): AgentTool<typeof createValuationWorkbookParameters> {
	return {
		name: "create_valuation_workbook",
		label: "Create valuation workbook",
		description: toolCacheDefinitions.create_valuation_workbook.description,
		parameters: createValuationWorkbookParameters,
		executionMode: "sequential",
		async execute(_toolCallId, input, signal) {
			const output = await resolveWritableInsideWorkspace(workspaceRoot, input.outputPath);
			assertWriteAllowed(output.target, writeScope);
			await observer?.before(output.relativePath);
			try {
				const inspection = await createValuationWorkbook(workspaceRoot, input as ValuationWorkbookSpec, undefined, signal);
				const artifact = {
					id: randomUUID(),
					type: "file" as const,
					content: JSON.stringify(inspection),
					path: join(await realpath(workspaceRoot), inspection.path),
				};
				return {
					content: [{ type: "text", text: `Created ${inspection.path} with ${inspection.formulas} formulas across ${inspection.sheets.length} sheets.` }],
					details: { path: output.relativePath, changed: true, inspection, artifact },
				};
			} finally {
				await observer?.after(output.relativePath);
			}
		},
	};
}

export function inspectPresentationTool(workspaceRoot: string): AgentTool<typeof inspectPresentationParameters> {
	return {
		name: "inspect_presentation",
		label: "Inspect presentation",
		description: toolCacheDefinitions.inspect_presentation.description,
		parameters: inspectPresentationParameters,
		executionMode: "parallel",
		async execute(_toolCallId, { path }, signal) {
			const resolved = await resolveExistingInsideWorkspace(workspaceRoot, path);
			const inspection = await inspectPresentation(workspaceRoot, resolved.relativePath, undefined, signal);
			return { content: [{ type: "text", text: JSON.stringify(inspection, null, 2) }], details: inspection };
		},
	};
}

export function createPresentationTool(
	workspaceRoot: string,
	observer?: WorkspaceMutationObserver,
	writeScope?: WorkspaceWriteScope,
): AgentTool<typeof createPresentationParameters> {
	return {
		name: "create_presentation",
		label: "Create presentation",
		description: toolCacheDefinitions.create_presentation.description,
		parameters: createPresentationParameters,
		executionMode: "sequential",
		async execute(_toolCallId, input, signal) {
			const output = await resolveWritableInsideWorkspace(workspaceRoot, input.outputPath);
			assertWriteAllowed(output.target, writeScope);
			await observer?.before(output.relativePath);
			try {
				const inspection = await createPresentation(workspaceRoot, input as PresentationDeckSpec, undefined, signal);
				const artifact = {
					id: randomUUID(),
					type: "file" as const,
					content: JSON.stringify(inspection),
					path: join(await realpath(workspaceRoot), inspection.path),
				};
				return {
					content: [{ type: "text", text: `Created ${inspection.path} with ${inspection.slides.length} slides.` }],
					details: { path: output.relativePath, changed: true, inspection, artifact },
				};
			} finally {
				await observer?.after(output.relativePath);
			}
		},
	};
}

export function inspectBacktestTool(workspaceRoot: string): AgentTool<typeof inspectBacktestParameters> {
	return {
		name: "inspect_backtest",
		label: "Inspect backtest",
		description: toolCacheDefinitions.inspect_backtest.description,
		parameters: inspectBacktestParameters,
		executionMode: "parallel",
		async execute(_toolCallId, { path }, signal) {
			const resolved = await resolveExistingInsideWorkspace(workspaceRoot, path);
			const verification = await verifyBacktest(workspaceRoot, resolved.relativePath, undefined, signal);
			return { content: [{ type: "text", text: JSON.stringify(verification, null, 2) }], details: verification };
		},
	};
}

export function runBacktestTool(
	workspaceRoot: string,
	observer?: WorkspaceMutationObserver,
	writeScope?: WorkspaceWriteScope,
): AgentTool<typeof runBacktestParameters> {
	return {
		name: "run_backtest",
		label: "Run backtest",
		description: toolCacheDefinitions.run_backtest.description,
		parameters: runBacktestParameters,
		executionMode: "sequential",
		async execute(_toolCallId, input, signal) {
			const data = await resolveExistingInsideWorkspace(workspaceRoot, input.dataPath);
			const output = await resolveWritableInsideWorkspace(workspaceRoot, input.outputPath);
			assertWriteAllowed(output.target, writeScope);
			await observer?.before(output.relativePath);
			try {
				const inspection = await runBacktest(workspaceRoot, { ...input, dataPath: data.relativePath } as BacktestSpec, undefined, signal);
				const artifact = {
					id: randomUUID(),
					type: "file" as const,
					content: JSON.stringify(inspection),
					path: join(await realpath(workspaceRoot), inspection.path),
				};
				return {
					content: [{ type: "text", text: `Created reproducible backtest ${inspection.path} from ${inspection.rows} rows.` }],
					details: { path: output.relativePath, changed: true, inspection, artifact },
				};
			} finally {
				await observer?.after(output.relativePath);
			}
		},
	};
}

export function recordStructuredArtifactTool(): AgentTool<typeof recordStructuredArtifactParameters> {
	return {
		name: "record_structured_artifact",
		label: "Record structured artifact",
		description: toolCacheDefinitions.record_structured_artifact.description,
		parameters: recordStructuredArtifactParameters,
		executionMode: "parallel",
		async execute(_toolCallId, input, signal) {
			throwIfAborted(signal);
			if (input.kind === "research" && (!input.title || !input.claims?.length)) throw new Error("Research artifacts require a title and at least one claim");
			if (input.kind === "review" && (!input.verdict || !input.defects)) throw new Error("Review artifacts require a verdict and defects array");
			const content = JSON.stringify(input);
			if (Buffer.byteLength(content) > MAX_OUTPUT_BYTES) throw new Error("Structured artifact exceeds 64 KiB");
			const artifact = { id: randomUUID(), type: "json" as const, content };
			const count = input.kind === "research" ? input.claims!.length : input.defects!.length;
			return {
				content: [{ type: "text", text: `Recorded ${input.kind} artifact with ${count} ${input.kind === "research" ? "sourced claims" : "defects"}.` }],
				details: { artifact },
			};
		},
	};
}

export function delegateTasksTool(callback: DelegateTasksCallback): AgentTool<typeof delegateTasksParameters> {
	return {
		name: "delegate_tasks",
		label: "Delegate child agents",
		description: toolCacheDefinitions.delegate_tasks.description,
		parameters: delegateTasksParameters,
		executionMode: "sequential",
		async execute(_toolCallId, { nodes }, signal) {
			throwIfAborted(signal);
			if (nodes.some(({ presetId }) => !DELEGATABLE_PRESET_IDS.includes(presetId))) throw new Error(`Unknown delegation preset; use one of: ${DELEGATABLE_PRESET_IDS.join(", ")}`);
			const result = await callback(nodes, signal);
			throwIfAborted(signal);
			if (!result.verificationPassed) throw new Error("Delegated child work failed verification");
			const children = result.children.slice(0, 3).map((child) => ({
				id: child.id,
				status: child.status,
				...(child.runId ? { runId: child.runId } : {}),
				...(child.output ? { output: truncateUtf8(child.output, 4_000).text } : {}),
				...(child.error ? { error: truncateUtf8(child.error, 1_000).text } : {}),
			}));
			const details: DelegateTasksResult = {
				output: truncateUtf8(result.output, 16_000).text,
				verificationPassed: result.verificationPassed,
				children,
			};
			const text = truncateUtf8(JSON.stringify(details, null, 2)).text;
			return { content: [{ type: "text", text }], details };
		},
	};
}

export interface ResolveToolsOptions {
	commandSandboxMode?: CommandSandboxMode;
	bashCommandSandboxMode?: CommandSandboxMode;
	bashNativeOperationId?: "inspect_workspace" | "run_workspace_command";
	delegateTasks?: DelegateTasksCallback;
	bashAllowedCanonicalToolIds?: readonly string[];
	bashPlanner?: BashCommandPlanner;
}

export function resolveTools(
	ids: string[],
	workspaceRoot: string,
	observer?: WorkspaceMutationObserver,
	writeScope?: WorkspaceWriteScope,
	searchBackend?: WorkspaceSearchBackend,
	documentOptions: DocumentParseOptions = {},
	options: ResolveToolsOptions = {},
): AgentTool[] {
	return ids.map((id) => {
		if (id === "bash") return bashTool(workspaceRoot, { observer, commandSandboxMode: options.bashCommandSandboxMode ?? options.commandSandboxMode, nativeOperationId: options.bashNativeOperationId, allowedCanonicalToolIds: options.bashAllowedCanonicalToolIds, planner: options.bashPlanner });
		if (id === "list_workspace") return listWorkspaceTool(workspaceRoot);
		if (id === "search_workspace") return searchWorkspaceTool(workspaceRoot, searchBackend);
		if (id === "inspect_workspace") return inspectWorkspaceTool(workspaceRoot);
		if (id === "inspect_document") return inspectDocumentTool(workspaceRoot, documentOptions);
		if (id === "inspect_workbook") return inspectWorkbookTool(workspaceRoot);
		if (id === "inspect_presentation") return inspectPresentationTool(workspaceRoot);
		if (id === "inspect_backtest") return inspectBacktestTool(workspaceRoot);
		if (id === "write_workspace") return writeWorkspaceTool(workspaceRoot, observer, writeScope);
		if (id === "edit_workspace") return editWorkspaceTool(workspaceRoot, observer, writeScope);
		if (id === "run_workspace_command") return runWorkspaceCommandTool(workspaceRoot, { observer, commandSandboxMode: options.commandSandboxMode });
		if (id === "create_valuation_workbook") return createValuationWorkbookTool(workspaceRoot, observer, writeScope);
		if (id === "create_presentation") return createPresentationTool(workspaceRoot, observer, writeScope);
		if (id === "run_backtest") return runBacktestTool(workspaceRoot, observer, writeScope);
		if (id === "record_structured_artifact") return recordStructuredArtifactTool();
		if (id === "delegate_tasks") {
			if (!options.delegateTasks) throw new Error("delegate_tasks requires a runtime callback");
			return delegateTasksTool(options.delegateTasks);
		}
		throw new Error(`Unknown tool: ${id}`);
	});
}

export function resolveToolCacheDefinitions(ids: string[]): unknown[] {
	return ids.map((id) => {
		const definition = toolCacheDefinitions[id as keyof typeof toolCacheDefinitions];
		if (!definition) throw new Error(`Unknown tool: ${id}`);
		return definition;
	});
}
