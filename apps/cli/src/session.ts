import { createHash, randomUUID } from "node:crypto";
import { readdir, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ConversationTurn, RunUsage } from "@agent-harness/contracts";
import { readBoundedUtf8 } from "./interaction.js";
import { writePrivateFile } from "./config.js";

const MAX_SESSION_BYTES = 1024 * 1024;
const MAX_TURNS = 50;
const MAX_REASONING_ENTRIES = 1_000;
const MAX_REASONING_CHARS = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CodetonomySession {
	version: 1;
	id: string;
	workspace: string;
	createdAt: number;
	updatedAt: number;
	title?: string;
	turns: ConversationTurn[];
	modelUsage?: SessionModelUsage[];
}

export interface SessionModelUsage {
	provider: string;
	model: string;
	requests: number;
	usage: RunUsage;
}

export interface SessionSummary {
	id: string;
	title: string;
	updatedAt: number;
	turnCount: number;
}

const workspaceKey = (workspace: string): string => createHash("sha256").update(workspace).digest("hex").slice(0, 32);
const legacySessionPath = (directory: string, workspace: string): string => join(directory, "sessions", `${workspaceKey(workspace)}.json`);
const sessionDirectory = (directory: string, workspace: string): string => join(directory, "sessions", workspaceKey(workspace));
const sessionPath = (directory: string, workspace: string, id: string): string => {
	if (!UUID.test(id)) throw new Error("Invalid Codetonomy session id");
	return join(sessionDirectory(directory, workspace), `${id}.json`);
};

export const createSession = (workspace: string, now = Date.now()): CodetonomySession => ({
	version: 1,
	id: randomUUID(),
	workspace,
	createdAt: now,
	updatedAt: now,
	turns: [],
});

const cleanTitle = (value: unknown): string | undefined => {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error("Invalid Codetonomy session title");
	const title = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
	if (!title || title.length > 80) throw new Error("Invalid Codetonomy session title");
	return title;
};

const validUsage = (usage: unknown): usage is RunUsage => {
	if (!usage || typeof usage !== "object") return false;
	const value = usage as RunUsage;
	return [value.input, value.output, value.cacheRead, value.cacheWrite, value.totalTokens]
		.every((number) => Number.isFinite(number) && number >= 0)
		&& (value.reasoning === undefined || (Number.isFinite(value.reasoning) && value.reasoning >= 0))
		&& (value.cost === undefined || [value.cost.input, value.cost.output, value.cost.cacheRead, value.cost.cacheWrite, value.cost.total]
			.every((number) => Number.isFinite(number) && number >= 0));
};

const mergeUsage = (left: RunUsage, right: RunUsage): RunUsage => {
	const input = left.input + right.input;
	const cacheRead = left.cacheRead + right.cacheRead;
	return {
		input,
		output: left.output + right.output,
		cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
		totalTokens: left.totalTokens + right.totalTokens,
		...((left.reasoning !== undefined || right.reasoning !== undefined) ? { reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0) } : {}),
		...(left.cost && right.cost ? { cost: {
			input: left.cost.input + right.cost.input,
			output: left.cost.output + right.cost.output,
			cacheRead: left.cost.cacheRead + right.cost.cacheRead,
			cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
			total: left.cost.total + right.cost.total,
		} } : {}),
		cacheSavingsRatio: input + cacheRead ? cacheRead / (input + cacheRead) : 0,
	};
};

export function sessionModelUsage(session: CodetonomySession): SessionModelUsage[] {
	if (session.modelUsage) return session.modelUsage;
	const rows: SessionModelUsage[] = [];
	for (const turn of session.turns) {
		if (!turn.usage || !turn.model) continue;
		const separator = turn.model.indexOf("/");
		const provider = separator < 0 ? "unknown" : turn.model.slice(0, separator);
		const model = separator < 0 ? turn.model : turn.model.slice(separator + 1);
		const existing = rows.find((row) => row.provider === provider && row.model === model);
		if (existing) {
			existing.requests++;
			existing.usage = mergeUsage(existing.usage, turn.usage);
		} else rows.push({ provider, model, requests: 1, usage: { ...turn.usage, ...(turn.usage.cost ? { cost: { ...turn.usage.cost } } : {}) } });
	}
	return rows;
}

export function addSessionModelUsage(session: CodetonomySession, provider: string, model: string, usage: RunUsage): CodetonomySession {
	const rows = sessionModelUsage(session).map((row) => ({ ...row, usage: { ...row.usage, ...(row.usage.cost ? { cost: { ...row.usage.cost } } : {}) } }));
	const existing = rows.find((row) => row.provider === provider && row.model === model);
	if (existing) {
		existing.requests++;
		existing.usage = mergeUsage(existing.usage, usage);
	} else rows.push({ provider, model, requests: 1, usage: { ...usage, ...(usage.cost ? { cost: { ...usage.cost } } : {}) } });
	return { ...session, modelUsage: rows };
}

const validateSession = (value: unknown, workspace: string): CodetonomySession => {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Codetonomy session");
	const candidate = value as Partial<CodetonomySession>;
	if (candidate.version !== 1 || typeof candidate.id !== "string" || !UUID.test(candidate.id) || candidate.workspace !== workspace
		|| !Number.isFinite(candidate.createdAt) || !Number.isFinite(candidate.updatedAt) || !Array.isArray(candidate.turns)
		|| candidate.turns.length > MAX_TURNS) throw new Error("Invalid Codetonomy session");
	if (candidate.modelUsage !== undefined && (!Array.isArray(candidate.modelUsage) || candidate.modelUsage.length > 64 || candidate.modelUsage.some((row) =>
		!row || typeof row.provider !== "string" || !row.provider || row.provider.length > 128
		|| typeof row.model !== "string" || !row.model || row.model.length > 256
		|| !Number.isInteger(row.requests) || row.requests < 1 || !validUsage(row.usage)))) throw new Error("Invalid Codetonomy session model usage");
	for (const turn of candidate.turns) {
		if (!turn || typeof turn.runId !== "string" || typeof turn.objective !== "string" || !turn.objective.trim()
			|| typeof turn.output !== "string" || !turn.output.trim() || !Number.isFinite(turn.timestamp)) {
			throw new Error("Invalid Codetonomy conversation turn");
		}
		if (turn.reasoning && (!Array.isArray(turn.reasoning) || turn.reasoning.length > MAX_REASONING_ENTRIES || turn.reasoning.some((item) =>
			!item || typeof item.text !== "string" || item.text.length > 64 * 1024 || typeof item.truncated !== "boolean"))) {
			throw new Error("Invalid Codetonomy reasoning trace");
		}
		if (turn.modelContext && (![turn.modelContext.contextWindow, turn.modelContext.maxOutputTokens, turn.modelContext.lastPromptTokens]
			.every((number) => Number.isFinite(number) && number >= 0))) throw new Error("Invalid Codetonomy model context");
		if (turn.model !== undefined && (typeof turn.model !== "string" || turn.model.length > 256)) throw new Error("Invalid Codetonomy turn model");
		if (turn.durationMs !== undefined && (!Number.isFinite(turn.durationMs) || turn.durationMs < 0)) throw new Error("Invalid Codetonomy turn duration");
	}
	return { ...(candidate as CodetonomySession), ...(cleanTitle(candidate.title) ? { title: cleanTitle(candidate.title) } : {}) };
};

const readSession = async (path: string, workspace: string): Promise<CodetonomySession> =>
	validateSession(JSON.parse(await readBoundedUtf8(path, MAX_SESSION_BYTES, "Session")), workspace);

export async function listSessions(directory: string, workspaceRoot: string): Promise<SessionSummary[]> {
	const workspace = await realpath(workspaceRoot);
	const paths: string[] = [legacySessionPath(directory, workspace)];
	try {
		for (const entry of await readdir(sessionDirectory(directory, workspace), { withFileTypes: true })) {
			if (entry.isFile() && UUID.test(basename(entry.name, ".json")) && entry.name.endsWith(".json")) paths.push(join(entry.parentPath, entry.name));
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const sessions = new Map<string, CodetonomySession>();
	for (const path of paths) {
		try {
			const session = await readSession(path, workspace);
			if (session.turns.length) sessions.set(session.id, session);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
		}
	}
	return [...sessions.values()]
		.sort((left, right) => right.updatedAt - left.updatedAt)
		.map((session) => ({
			id: session.id,
			title: session.title ?? session.turns[0]!.objective.replace(/\s+/g, " ").trim().slice(0, 80),
			updatedAt: session.updatedAt,
			turnCount: session.turns.length,
		}));
}

export async function loadSession(directory: string, workspaceRoot: string, id?: string): Promise<CodetonomySession> {
	const workspace = await realpath(workspaceRoot);
	if (!id) {
		try { return await readSession(legacySessionPath(directory, workspace), workspace); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return createSession(workspace);
			throw error;
		}
	}
	try { return await readSession(sessionPath(directory, workspace, id), workspace); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const legacy = await readSession(legacySessionPath(directory, workspace), workspace);
		if (legacy.id !== id) throw error;
		return legacy;
	}
}

export async function loadSessionByPrefix(directory: string, workspaceRoot: string, prefix: string): Promise<CodetonomySession> {
	if (!/^[0-9a-f-]{4,36}$/i.test(prefix)) throw new Error("Session id must be at least 4 hexadecimal characters");
	const matches = (await listSessions(directory, workspaceRoot)).filter(({ id }) => id.startsWith(prefix));
	if (!matches.length) throw new Error(`No session matches ${prefix}`);
	if (matches.length > 1) throw new Error(`Session prefix ${prefix} is ambiguous`);
	return loadSession(directory, workspaceRoot, matches[0]!.id);
}

export async function saveSession(directory: string, session: CodetonomySession): Promise<void> {
	const workspace = await realpath(session.workspace);
	const normalized = validateSession({ ...session, workspace }, workspace);
	const text = `${JSON.stringify(normalized, null, 2)}\n`;
	if (Buffer.byteLength(text) > MAX_SESSION_BYTES) throw new Error("Codetonomy session exceeds 1 MiB");
	await writePrivateFile(sessionPath(directory, workspace, normalized.id), text);
}

export function appendConversationTurn(session: CodetonomySession, turn: ConversationTurn, now = Date.now()): CodetonomySession {
	// Full reasoning remains in the run trace; bound the session copy, not the conversation.
	if (turn.reasoning) {
		const reasoning: NonNullable<ConversationTurn["reasoning"]> = [];
		let remaining = MAX_REASONING_CHARS;
		for (const [index, item] of turn.reasoning.entries()) {
			const text = item.text.slice(0, remaining);
			remaining -= text.length;
			const last = !remaining || reasoning.length === MAX_REASONING_ENTRIES - 1;
			reasoning.push({ text, truncated: item.truncated || text.length < item.text.length || (last && index < turn.reasoning.length - 1) });
			if (last) break;
		}
		turn = { ...turn, reasoning };
	}
	const turns = [...session.turns, turn].slice(-MAX_TURNS);
	const updated = { ...session, updatedAt: now, turns };
	while (Buffer.byteLength(JSON.stringify(updated, null, 2)) >= MAX_SESSION_BYTES && turns.length > 1) turns.shift();
	return updated;
}

export const normalizeSessionTitle = (output: string, fallback: string): string => {
	const generated = output.split(/\r?\n/, 1)[0]!.replace(/^\s*(?:title\s*:\s*)?["'`]|["'`]\s*$/gi, "");
	return (generated.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim()
		|| fallback.replace(/\s+/g, " ").trim()).slice(0, 80);
};

export async function generateSessionTitle(firstInput: string, runner: (prompt: string) => Promise<string>): Promise<string> {
	const fallback = firstInput.replace(/\s+/g, " ").trim();
	try {
		const output = await runner(`Return only a 3-8 word session title for this request:\n${firstInput.slice(0, 2_000)}`);
		return normalizeSessionTitle(output.startsWith("Fixture agent completed:") ? "" : output, fallback);
	} catch {
		return fallback.slice(0, 80);
	}
}
