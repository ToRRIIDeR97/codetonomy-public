import { createHash, randomUUID } from "node:crypto";
import { constants, mkdirSync, realpathSync } from "node:fs";
import { glob, lstat, open, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isSensitiveWorkspacePath, type ContextPacket, type DocumentIR, type MemoryBackend, type RunResult } from "@agent-harness/contracts";
import { parseDocument, type DocumentParseOptions } from "@agent-harness/document-ir";

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const VECTOR_DIMENSIONS = 256;
const CURRENT_GRAPH_EDGES = new Set(["CONTAINS", "LOCATED_AT", "VERSION_OF", "CURRENT_VERSION", "SUPERSEDES", "GENERATED_BY", "CREATED_FOR_TASK", "DERIVED_FROM", "DEPENDS_ON", "REFERENCES", "HAS_CHUNK", "USES_SKILL", "OWNED_BY", "HAS_PERMISSION"]);
const INFERRED_GRAPH_EDGES = new Set(["MENTIONS", "SUPPORTS", "CONTRADICTS", "ASSUMES", "RELATED_TO", "MAY_DEPEND_ON"]);

export interface AssetVersionRecord {
	assetId: string;
	versionId: string;
	projectId: string;
	path: string;
	contentHash: string;
	current: boolean;
	createdAt: number;
}

export interface GraphEdgeInput {
	fromId: string;
	toId: string;
	type: string;
	confidence?: number;
	evidenceIds?: string[];
	extractorModel?: string;
	extractorVersion?: string;
	reviewStatus?: "unreviewed" | "approved" | "rejected";
}

export interface RetrievalScope {
	projectIds?: string[];
	assetIds?: string[];
	path?: string;
	includeOldVersions?: boolean;
	graphSeedIds?: string[];
	graphHops?: number;
	maximumResults?: number;
}

export interface RetrievedEvidence {
	chunkId: string;
	assetId: string;
	versionId: string;
	path: string;
	pageNumber: number;
	blockId: string;
	content: string;
	score: number;
	contentHash: string;
	structure?: CodeStructure;
}

export interface CodeStructure {
	enclosingClass?: string;
	symbol?: string;
	kind?: "class" | "function" | "method" | "interface" | "type" | "enum";
	architecturalLayer?: string;
	owner?: string;
}

export interface LocalGraphMemoryOptions {
	databasePath: string;
	workspaceRoot: string;
	projectId: string;
	documentOptions?: Omit<DocumentParseOptions, "assetVersionId">;
}

const INDEXABLE_EXTENSIONS = new Set([
	".bmp", ".c", ".cc", ".conf", ".cpp", ".cs", ".css", ".csv", ".go", ".h", ".hpp", ".html", ".java", ".jpeg", ".jpg",
	".js", ".json", ".jsx", ".kt", ".lua", ".md", ".mjs", ".pdf", ".php", ".png", ".properties", ".py", ".rb", ".rs",
	".scss", ".sh", ".sql", ".swift", ".toml", ".ts", ".tsx", ".txt", ".vue", ".webp", ".xml", ".yaml", ".yml",
]);
const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
const tokens = (value: string): string[] => value.toLowerCase().match(/[\p{L}\p{N}_]+/gu)?.filter((token) => token.length > 1) ?? [];
const estimateTokens = (value: string): number => Math.ceil(value.length / 4);
const SEARCH_STOP_WORDS = new Set(["and", "code", "file", "find", "for", "from", "name", "report", "source", "that", "the", "this", "use", "with"]);
const STRUCTURAL_INDEX_REVISION = "4";
export const TENCENT_ROUTING_SYNC_MARKER = "tencentdb-routing-v1";
const parseStructure = (value: unknown): CodeStructure | undefined => {
	if (typeof value !== "string" || !value) return undefined;
	try { return JSON.parse(value) as CodeStructure; } catch { return undefined; }
};

// Regex fallback adapted from Reasonix code_index; add tree-sitter only if these supported-language signatures prove insufficient.
const CODE_SYMBOLS: Record<string, Array<{ kind: CodeStructure["kind"]; pattern: RegExp }>> = {
	js: [
		{ kind: "class", pattern: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)\b/m },
		{ kind: "function", pattern: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/m },
		{ kind: "function", pattern: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/m },
		{ kind: "interface", pattern: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/m },
		{ kind: "type", pattern: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\b/m },
		{ kind: "enum", pattern: /^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)\b/m },
	],
	py: [
		{ kind: "class", pattern: /^\s*class\s+([A-Za-z_][\w]*)\b/m },
		{ kind: "function", pattern: /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/m },
	],
	rs: [{ kind: "function", pattern: /^\s*(?:pub(?:\([^)]*\))?\s+)?fn\s+([A-Za-z_][\w]*)\b/m }],
};

const codeStructure = (path: string, source: string, block: string, offset: number): CodeStructure | undefined => {
	const extension = extname(path).slice(1).toLowerCase();
	const matchers = ["js", "jsx", "ts", "tsx"].includes(extension) ? CODE_SYMBOLS.js : CODE_SYMBOLS[extension];
	if (!matchers) return undefined;
	const before = source.slice(0, Math.max(0, offset));
	const classMatches = [...before.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)[^\{]*\{/g)];
	const enclosingClass = classMatches.findLast((match) => {
		const tail = before.slice(match.index);
		return (tail.match(/\{/g)?.length ?? 0) > (tail.match(/\}/g)?.length ?? 0);
	})?.[1];
	let kind: CodeStructure["kind"] | undefined;
	let symbol: string | undefined;
	for (const matcher of matchers) {
		const match = block.match(matcher.pattern);
		if (match?.[1]) { kind = matcher.kind; symbol = match[1]; break; }
	}
	if (!symbol && ["js", "jsx", "ts", "tsx"].includes(extension)) {
		const method = block.match(/^\s*(?:(?:public|private|protected|static|readonly|abstract|override|async|get|set)\s+)*#?([A-Za-z_$][\w$]*)\s*\([^;]*?\)\s*(?::[^={]+)?\s*\{/m);
		if (method?.[1] && !new Set(["if", "for", "while", "switch", "catch", "constructor"]).has(method[1])) {
			kind = "method"; symbol = method[1];
		}
	}
	const annotation = block.match(/architectural-layer:\s*([^;\n]+)(?:;\s*owner:\s*([^\n]+))?/i);
	const structure = {
		...(enclosingClass ? { enclosingClass } : {}),
		...(symbol ? { symbol, kind } : {}),
		...(annotation?.[1] ? { architecturalLayer: annotation[1].trim() } : {}),
		...(annotation?.[2] ? { owner: annotation[2].trim() } : {}),
	};
	return Object.keys(structure).length ? structure : undefined;
};

const workspaceSearchIntents = (query: string): string[] => {
	const queryTokens = new Set(tokens(query));
	return queryTokens.has("workspace") && ["recall", "retrieve", "search"].some((term) => queryTokens.has(term)) ? ["searchworkspace"] : [];
};

const rankWorkspaceHits = (query: string, hits: RetrievedEvidence[], limit: number): RetrievedEvidence[] => {
	hits = [...new Map(hits.map((hit) => [hit.chunkId, hit])).values()];
	const queryTokens = tokens(query);
	const intents = workspaceSearchIntents(query);
	const terms = [...new Set([...queryTokens, ...(queryTokens.includes("tencentdb") ? ["tencent", "memory"] : [])].filter((token) => token.length > 2 && !SEARCH_STOP_WORDS.has(token)))];
	const ranked = hits.map((hit) => {
		const haystack = `${hit.path}\n${JSON.stringify(hit.structure ?? {})}\n${hit.content}`.toLowerCase();
		const intentMatches = intents.filter((term) => haystack.includes(term)).length;
		const matches = terms.filter((term) => haystack.includes(term)).length;
		return { hit, intentMatches, matches, score: hit.score + (terms.length ? matches / terms.length : 0) };
	}).sort((left, right) => right.intentMatches - left.intentMatches || right.matches - left.matches || right.score - left.score || left.hit.path.localeCompare(right.hit.path));
	const perPath = new Map<string, number>();
	const selectedLayers = new Set<string>();
	const selected: RetrievedEvidence[] = [];
	for (const { hit, score } of ranked) {
		if ((perPath.get(hit.path) ?? 0) >= 2) continue;
		if (hit.structure?.architecturalLayer && selectedLayers.has(hit.structure.architecturalLayer)) continue;
		selected.push({ ...hit, score });
		perPath.set(hit.path, (perPath.get(hit.path) ?? 0) + 1);
		if (hit.structure?.architecturalLayer) selectedLayers.add(hit.structure.architecturalLayer);
		if (selected.length === limit) break;
	}
	return selected;
};
const chunksOf = (value: string, maximum = 7_000): string[] => {
	const chunks: string[] = [];
	for (let offset = 0; offset < value.length;) {
		let end = Math.min(value.length, offset + maximum);
		if (end < value.length) {
			const newline = value.lastIndexOf("\n", end);
			if (newline > offset + maximum / 2) end = newline + 1;
		}
		chunks.push(value.slice(offset, end));
		offset = end;
	}
	return chunks;
};

const vector = (value: string): number[] => {
	const result = Array<number>(VECTOR_DIMENSIONS).fill(0);
	for (const token of tokens(value)) {
		const index = createHash("sha256").update(token).digest().readUInt16BE(0) % VECTOR_DIMENSIONS;
		result[index] = (result[index] ?? 0) + 1;
	}
	const magnitude = Math.sqrt(result.reduce((sum, item) => sum + item * item, 0));
	return magnitude ? result.map((item) => item / magnitude) : result;
};

const cosine = (left: number[], right: number[]): number => left.reduce((sum, item, index) => sum + item * (right[index] ?? 0), 0);

const WORKSPACE_ROUTING_CARD_PREFIX = "CODETONOMY_WORKSPACE_ROUTING_CARD ";
const WORKSPACE_BUNDLE_PREFIX = "CODETONOMY_WORKSPACE_BUNDLE ";
const WORKSPACE_CHUNK_PREFIX = "CODETONOMY_WORKSPACE_CHUNK ";
const MAX_ROUTING_CARD_BYTES = 7_000;
const MAX_ROUTING_KEYWORDS = 24;
const boundedText = (value: string, maximum: number): string => [...value].slice(0, maximum).join("");

const routingStructure = (structure: CodeStructure | undefined): CodeStructure | undefined => {
	if (!structure) return undefined;
	const bounded = {
		...(structure.enclosingClass ? { enclosingClass: boundedText(structure.enclosingClass, 64) } : {}),
		...(structure.symbol ? { symbol: boundedText(structure.symbol, 64) } : {}),
		...(structure.kind ? { kind: structure.kind } : {}),
		...(structure.architecturalLayer ? { architecturalLayer: boundedText(structure.architecturalLayer, 96) } : {}),
		...(structure.owner ? { owner: boundedText(structure.owner, 96) } : {}),
	};
	return Object.keys(bounded).length ? bounded : undefined;
};

const routingKeywords = (chunk: RetrievedEvidence): string[] => {
	const metadata = tokens(`${chunk.path} ${chunk.blockId} ${JSON.stringify(chunk.structure ?? {})}`);
	const source = [...new Set(tokens(chunk.content))];
	const selected: string[] = [];
	const seen = new Set<string>();
	const add = (value: string): void => {
		const bounded = boundedText(value, 32);
		if (bounded.length > 1 && !seen.has(bounded) && selected.length < MAX_ROUTING_KEYWORDS) {
			seen.add(bounded);
			selected.push(bounded);
		}
	};
	metadata.forEach(add);
	if (selected.length < MAX_ROUTING_KEYWORDS && source.length) {
		const remaining = MAX_ROUTING_KEYWORDS - selected.length;
		if (source.length <= remaining) source.forEach(add);
		else {
			for (let index = 0; index < remaining; index++) add(source[Math.floor(index * (source.length - 1) / Math.max(1, remaining - 1))] ?? "");
		}
	}
	return selected;
};

interface WorkspaceRoutingCard {
	chunkId: string;
	path: string;
	pageNumber: number;
	blockId: string;
	structure?: CodeStructure;
	keywords: string[];
}

const routingCardForChunk = (chunk: RetrievedEvidence): WorkspaceRoutingCard => {
	const structure = routingStructure(chunk.structure);
	return {
		chunkId: boundedText(chunk.chunkId, 128),
		path: boundedText(chunk.path, 256),
		pageNumber: Number.isFinite(chunk.pageNumber) ? Math.max(0, Math.trunc(chunk.pageNumber)) : 0,
		blockId: boundedText(chunk.blockId, 96),
		...(structure ? { structure } : {}),
		keywords: routingKeywords(chunk),
	};
};

const serializedRoutingCard = (record: WorkspaceRoutingCard): string => `${WORKSPACE_ROUTING_CARD_PREFIX}${JSON.stringify(record)}`;

const fuseWorkspaceHits = (remote: RetrievedEvidence[], local: RetrievedEvidence[]): RetrievedEvidence[] => {
	const merged = new Map<string, RetrievedEvidence>();
	for (const hit of remote) merged.set(hit.chunkId, { ...hit, score: (Number.isFinite(hit.score) ? Math.max(0, hit.score) : 0) + 0.05 });
	for (const hit of local) {
		const previous = merged.get(hit.chunkId);
		const score = Number.isFinite(hit.score) ? Math.max(0, hit.score) : 0;
		merged.set(hit.chunkId, previous ? { ...hit, score: previous.score + score + 0.05 } : { ...hit, score });
	}
	return [...merged.values()].sort((left, right) => right.score - left.score || left.path.localeCompare(right.path) || left.chunkId.localeCompare(right.chunkId));
};

interface WorkspaceFileMetadata {
	root: string;
	path: string;
	relativePath: string;
	identity: string;
	size: number;
	mtimeNs: string;
}

interface AssetLocationState {
	assetId?: string;
	path?: string;
	fileIdentity?: string;
	size?: number;
	mtimeNs?: string;
	versionId?: string;
	contentHash?: string;
	createdAt?: number;
	hasIndex?: number;
}

interface WorkspaceManifest {
	byPath: Map<string, AssetLocationState>;
	byIdentity: Map<string, AssetLocationState>;
}

const comparablePath = (path: string): string => {
	let normalized = path;
	if (process.platform === "win32") {
		if (normalized.startsWith("\\\\?\\UNC\\")) normalized = `\\\\${normalized.slice(8)}`;
		else if (normalized.startsWith("\\\\?\\")) normalized = normalized.slice(4);
	}
	return process.platform === "win32" || process.platform === "darwin" ? normalized.toLocaleLowerCase() : normalized;
};

const outsideWorkspace = (root: string, path: string): boolean => {
	const result = relative(comparablePath(root), comparablePath(path));
	return result === ".." || result.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(result);
};

async function workspaceFileMetadata(root: string, requestedPath: string, scannedPath = false): Promise<WorkspaceFileMetadata> {
	const canonicalRoot = await realpath(root);
	const lexical = resolve(canonicalRoot, requestedPath);
	const lexicalRelative = relative(canonicalRoot, lexical).replaceAll("\\", "/");
	if (outsideWorkspace(canonicalRoot, lexical)) throw new Error("Asset path is outside the workspace");
	if (isSensitiveWorkspacePath(lexicalRelative)) throw new Error("Sensitive workspace paths cannot be indexed");
	const path = scannedPath ? lexical : await realpath(lexical);
	if (outsideWorkspace(canonicalRoot, path)) throw new Error("Asset path resolves outside the workspace");
	if (isSensitiveWorkspacePath(relative(canonicalRoot, path))) throw new Error("Sensitive workspace paths cannot be indexed");
	const relativePath = lexicalRelative;
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = await handle.stat({ bigint: true });
		if (!info.isFile() || info.nlink !== 1n) throw new Error("Asset must be a regular standalone file");
		if (info.size > BigInt(MAX_FILE_BYTES)) throw new Error("Asset exceeds 50 MiB");
		return { root: canonicalRoot, path, relativePath, identity: `${info.dev}:${info.ino}`, size: Number(info.size), mtimeNs: info.mtimeNs.toString() };
	} finally {
		await handle.close();
	}
}

async function readWorkspaceFile(root: string, requestedPath: string, scannedPath = false): Promise<WorkspaceFileMetadata & { bytes: Buffer }> {
	const file = await workspaceFileMetadata(root, requestedPath, scannedPath);
	const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = await handle.stat({ bigint: true });
		if (!info.isFile() || info.nlink !== 1n) throw new Error("Asset must be a regular standalone file");
		if (info.size > BigInt(MAX_FILE_BYTES)) throw new Error("Asset exceeds 50 MiB");
		const size = Number(info.size);
		const bytes = Buffer.alloc(size + 1);
		let length = 0;
		while (length < bytes.length) {
			const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
			if (!bytesRead) break;
			length += bytesRead;
		}
		if (length > MAX_FILE_BYTES) throw new Error("Asset exceeds 50 MiB");
		return { ...file, size, mtimeNs: info.mtimeNs.toString(), identity: `${info.dev}:${info.ino}`, bytes: bytes.subarray(0, length) };
	} finally {
		await handle.close();
	}
}

export class LocalGraphMemory implements MemoryBackend {
	readonly #database: DatabaseSync;
	readonly #workspaceRoot: string;
	readonly #projectId: string;
	readonly #documentOptions: Omit<DocumentParseOptions, "assetVersionId">;

	constructor(options: LocalGraphMemoryOptions) {
		mkdirSync(dirname(options.databasePath), { recursive: true, mode: 0o700 });
		this.#database = new DatabaseSync(options.databasePath);
		this.#workspaceRoot = realpathSync(options.workspaceRoot);
		this.#projectId = options.projectId;
		this.#documentOptions = options.documentOptions ?? {};
		this.#database.exec(`
			PRAGMA busy_timeout=5000;
			PRAGMA journal_mode=WAL;
			PRAGMA foreign_keys=ON;
			CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, created_at INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS asset_locations(asset_id TEXT NOT NULL, path TEXT NOT NULL, file_identity TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0, mtime_ns TEXT NOT NULL DEFAULT '', first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, PRIMARY KEY(asset_id,path), FOREIGN KEY(asset_id) REFERENCES assets(id));
			CREATE INDEX IF NOT EXISTS asset_locations_path ON asset_locations(path);
			CREATE INDEX IF NOT EXISTS asset_locations_identity ON asset_locations(file_identity);
			CREATE TABLE IF NOT EXISTS asset_versions(id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, content_hash TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL, created_at INTEGER NOT NULL, current INTEGER NOT NULL CHECK(current IN (0,1)), FOREIGN KEY(asset_id) REFERENCES assets(id));
			CREATE UNIQUE INDEX IF NOT EXISTS one_current_asset_version ON asset_versions(asset_id) WHERE current=1;
			CREATE TABLE IF NOT EXISTS chunks(id TEXT PRIMARY KEY, version_id TEXT NOT NULL, asset_id TEXT NOT NULL, page_number INTEGER NOT NULL, block_id TEXT NOT NULL, content TEXT NOT NULL, structural_context TEXT NOT NULL DEFAULT '', token_estimate INTEGER NOT NULL, vector TEXT NOT NULL, FOREIGN KEY(version_id) REFERENCES asset_versions(id));
			CREATE INDEX IF NOT EXISTS chunks_version ON chunks(version_id);
			CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(chunk_id UNINDEXED, content, tokenize='unicode61');
			CREATE TABLE IF NOT EXISTS edges(id TEXT PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL, confidence REAL, evidence_ids TEXT, extractor_model TEXT, extractor_version TEXT, review_status TEXT, created_at INTEGER NOT NULL);
			CREATE INDEX IF NOT EXISTS edges_from ON edges(from_id,type);
			CREATE INDEX IF NOT EXISTS edges_to ON edges(to_id,type);
			CREATE TABLE IF NOT EXISTS conversations(run_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, objective TEXT NOT NULL, output TEXT NOT NULL, created_at INTEGER NOT NULL);
			CREATE TABLE IF NOT EXISTS external_chunks(backend TEXT NOT NULL,chunk_id TEXT NOT NULL,indexed_at INTEGER NOT NULL,PRIMARY KEY(backend,chunk_id));
			CREATE TABLE IF NOT EXISTS memory_schema(key TEXT PRIMARY KEY,value TEXT NOT NULL);
		`);
		const locationColumns = this.#database.prepare("PRAGMA table_info(asset_locations)").all() as Array<{ name: string }>;
		try { if (!locationColumns.some(({ name }) => name === "size")) this.#database.exec("ALTER TABLE asset_locations ADD COLUMN size INTEGER NOT NULL DEFAULT 0"); } catch (error) { if (!String(error).toLowerCase().includes("duplicate column")) throw error; }
		try { if (!locationColumns.some(({ name }) => name === "mtime_ns")) this.#database.exec("ALTER TABLE asset_locations ADD COLUMN mtime_ns TEXT NOT NULL DEFAULT ''"); } catch (error) { if (!String(error).toLowerCase().includes("duplicate column")) throw error; }
		const chunkColumns = this.#database.prepare("PRAGMA table_info(chunks)").all() as Array<{ name: string }>;
		if (!chunkColumns.some(({ name }) => name === "structural_context")) this.#database.exec("ALTER TABLE chunks ADD COLUMN structural_context TEXT NOT NULL DEFAULT ''");
		const revision = (this.#database.prepare("SELECT value FROM memory_schema WHERE key='structural-index'").get() as { value?: string } | undefined)?.value;
		if (revision !== STRUCTURAL_INDEX_REVISION) {
			this.#database.exec("BEGIN IMMEDIATE");
			try {
				this.#database.exec("DELETE FROM external_chunks; DELETE FROM chunks_fts; DELETE FROM edges WHERE type='HAS_CHUNK'; DELETE FROM chunks;");
				this.#database.prepare("INSERT OR REPLACE INTO memory_schema(key,value) VALUES('structural-index',?)").run(STRUCTURAL_INDEX_REVISION);
				this.#database.exec("COMMIT");
			} catch (error) {
				this.#database.exec("ROLLBACK");
				throw error;
			}
		}
	}

	close(): void { this.#database.close(); }

	async ingestFile(requestedPath: string, signal?: AbortSignal): Promise<AssetVersionRecord> {
		return this.#ingestFile(requestedPath, signal, false);
	}

	async #ingestFile(requestedPath: string, signal: AbortSignal | undefined, scannedPath: boolean, manifest?: WorkspaceManifest): Promise<AssetVersionRecord> {
		if (signal?.aborted) throw new Error("Asset ingestion aborted");
		const metadata = await workspaceFileMetadata(this.#workspaceRoot, requestedPath, scannedPath);
		const locationSelect = `SELECT l.asset_id assetId,l.path path,l.file_identity fileIdentity,l.size size,l.mtime_ns mtimeNs,v.id versionId,v.content_hash contentHash,v.created_at createdAt,EXISTS(SELECT 1 FROM chunks c WHERE c.version_id=v.id LIMIT 1) hasIndex FROM asset_locations l JOIN assets a ON a.id=l.asset_id LEFT JOIN asset_versions v ON v.asset_id=l.asset_id AND v.current=1 WHERE a.project_id=? AND `;
		const byPath = manifest?.byPath.get(metadata.relativePath) ?? this.#database.prepare(`${locationSelect}l.path=? ORDER BY l.last_seen DESC,l.rowid DESC LIMIT 1`).get(this.#projectId, metadata.relativePath) as AssetLocationState | undefined;
		const byIdentity = byPath ? undefined : manifest?.byIdentity.get(metadata.identity) ?? this.#database.prepare(`${locationSelect}l.file_identity=? ORDER BY l.last_seen DESC,l.rowid DESC LIMIT 1`).get(this.#projectId, metadata.identity) as AssetLocationState | undefined;
		const existing = byPath ?? byIdentity;
		const assetId = existing?.assetId ?? `asset_${randomUUID()}`;
		const unchanged = Boolean(existing?.versionId && existing.fileIdentity === metadata.identity && Number(existing.size) === metadata.size && String(existing.mtimeNs ?? "") === metadata.mtimeNs);
		if (unchanged && existing?.versionId) {
			const indexed = existing.hasIndex ?? this.#database.prepare("SELECT 1 FROM chunks WHERE version_id=? LIMIT 1").get(existing.versionId);
			if (indexed && existing.contentHash) {
				if (existing.path === metadata.relativePath) return {
					assetId, versionId: existing.versionId, projectId: this.#projectId, path: metadata.relativePath,
					contentHash: existing.contentHash, current: true, createdAt: Number(existing.createdAt ?? Date.now()),
				};
			}
		}
		const file = await readWorkspaceFile(this.#workspaceRoot, requestedPath, scannedPath);
		const contentHash = sha256(file.bytes);
		const now = Date.now();
		this.#database.exec("BEGIN IMMEDIATE");
		let versionId: string;
		let current: { id: string; content_hash: string; created_at: number } | undefined;
		try {
			this.#database.prepare("INSERT OR IGNORE INTO assets(id,project_id,created_at) VALUES(?,?,?)").run(assetId, this.#projectId, now);
			if (existing?.path && existing.path !== file.relativePath && existing.assetId === assetId) {
				this.#database.prepare("DELETE FROM asset_locations WHERE asset_id=? AND path=?").run(assetId, existing.path);
				this.#database.prepare("DELETE FROM edges WHERE from_id=? AND to_id=? AND type='LOCATED_AT'").run(assetId, `path:${existing.path}`);
			}
			this.#database.prepare("INSERT INTO asset_locations(asset_id,path,file_identity,size,mtime_ns,first_seen,last_seen) VALUES(?,?,?,?,?,?,?) ON CONFLICT(asset_id,path) DO UPDATE SET file_identity=excluded.file_identity,size=excluded.size,mtime_ns=excluded.mtime_ns,last_seen=excluded.last_seen").run(assetId, file.relativePath, file.identity, file.size, file.mtimeNs, now, now);
			this.#database.prepare("DELETE FROM edges WHERE from_id=? AND type='LOCATED_AT'").run(assetId);
			this.#insertEdge({ fromId: assetId, toId: `path:${file.relativePath}`, type: "LOCATED_AT" }, false);
			current = this.#database.prepare("SELECT id,content_hash,created_at FROM asset_versions WHERE asset_id=? AND current=1").get(assetId) as typeof current;
			if (current?.content_hash === contentHash) {
				versionId = current.id;
			} else {
				versionId = `version_${randomUUID()}`;
				if (current) this.#database.prepare("UPDATE asset_versions SET current=0 WHERE id=?").run(current.id);
				this.#database.prepare("INSERT INTO asset_versions(id,asset_id,content_hash,size,mime,created_at,current) VALUES(?,?,?,?,?,?,1)").run(versionId, assetId, contentHash, file.bytes.length, extname(file.path).slice(1) || "application/octet-stream", now);
			}
			this.#database.exec("COMMIT");
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
		const missingIndex = current?.content_hash === contentHash && !this.#database.prepare("SELECT 1 FROM chunks WHERE version_id=? LIMIT 1").get(versionId);
		if (!current || current.content_hash !== contentHash || missingIndex) {
			try {
				const document = await parseDocument(file.root, file.relativePath, { ...this.#documentOptions, assetVersionId: versionId, signal });
				let source: string | undefined;
				try { source = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes).replaceAll("\r\n", "\n"); } catch { /* Binary documents have no source symbols. */ }
				this.#indexDocument(assetId, versionId, document, file.relativePath, source, current?.content_hash === contentHash ? undefined : current?.id);
			} catch (error) {
				this.#database.exec("BEGIN IMMEDIATE");
				try {
					if (current?.content_hash !== contentHash) this.#database.prepare("DELETE FROM asset_versions WHERE id=?").run(versionId);
					this.#database.prepare("UPDATE asset_locations SET size=0,mtime_ns='' WHERE asset_id=? AND path=?").run(assetId, file.relativePath);
					this.#database.exec("COMMIT");
				} catch (cleanupError) {
					this.#database.exec("ROLLBACK");
					throw new AggregateError([error, cleanupError], "Asset ingestion and rollback both failed");
				}
				throw error;
			}
		}
		return { assetId, versionId, projectId: this.#projectId, path: file.relativePath, contentHash, current: true, createdAt: now };
	}

	async ingestWorkspace(signal?: AbortSignal, onProgress?: (progress: { completed: number; total: number; path: string; skipped?: boolean; error?: string }) => void): Promise<AssetVersionRecord[]> {
		const paths: string[] = [];
		for await (const candidate of glob("**/*", {
			cwd: this.#workspaceRoot,
			exclude: ["**/.codetonomy/**", "**/.git/**", "**/.harness/**", "**/.reference-repos/**", "**/node_modules/**", "**/dist/**"],
		})) {
			const path = candidate.replaceAll("\\", "/");
			const extension = extname(path).toLowerCase();
			const image = [".png", ".jpg", ".jpeg", ".webp", ".bmp"].includes(extension);
			if (!INDEXABLE_EXTENSIONS.has(extension) || isSensitiveWorkspacePath(path) || (image && !this.#documentOptions.ocr)) continue;
			try { if ((await lstat(resolve(this.#workspaceRoot, candidate))).isFile()) paths.push(path); }
			catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code !== "ENOENT" && code !== "ENOTDIR") paths.push(path);
			}
		}
		const manifestRows = this.#database.prepare(`SELECT l.asset_id assetId,l.path path,l.file_identity fileIdentity,l.size size,l.mtime_ns mtimeNs,v.id versionId,v.content_hash contentHash,v.created_at createdAt,EXISTS(SELECT 1 FROM chunks c WHERE c.version_id=v.id LIMIT 1) hasIndex FROM asset_locations l JOIN assets a ON a.id=l.asset_id LEFT JOIN asset_versions v ON v.asset_id=l.asset_id AND v.current=1 WHERE a.project_id=? ORDER BY l.last_seen DESC,l.rowid DESC`).all(this.#projectId) as AssetLocationState[];
		const manifest: WorkspaceManifest = { byPath: new Map(), byIdentity: new Map() };
		for (const row of manifestRows) {
			if (row.path && !manifest.byPath.has(row.path)) manifest.byPath.set(row.path, row);
			if (row.fileIdentity && !manifest.byIdentity.has(row.fileIdentity)) manifest.byIdentity.set(row.fileIdentity, row);
		}
		const results: AssetVersionRecord[] = [];
		for (const [index, path] of paths.sort().entries()) {
			if (signal?.aborted) throw new Error("Workspace ingestion aborted");
			try {
				results.push(await this.#ingestFile(path, signal, true, manifest));
				onProgress?.({ completed: index + 1, total: paths.length, path });
			} catch (error) {
				if (signal?.aborted) throw error;
				// A single unsupported or malformed asset must not prevent the rest of the workspace from indexing.
				onProgress?.({ completed: index + 1, total: paths.length, path, skipped: true, error: error instanceof Error ? error.message : String(error) });
			}
		}
		const activePaths = new Set(paths);
		const staleLocations = (this.#database.prepare(`SELECT l.asset_id assetId,l.path FROM asset_locations l JOIN assets a ON a.id=l.asset_id WHERE a.project_id=?`).all(this.#projectId) as Array<{ assetId: string; path: string }>).filter(({ path }) => !activePaths.has(path));
		if (staleLocations.length) {
			this.#database.exec("BEGIN IMMEDIATE");
			try {
				const deleteLocation = this.#database.prepare("DELETE FROM asset_locations WHERE asset_id=? AND path=?");
				const deleteEdge = this.#database.prepare("DELETE FROM edges WHERE from_id=? AND to_id=? AND type='LOCATED_AT'");
				const remainingLocation = this.#database.prepare("SELECT 1 FROM asset_locations WHERE asset_id=? LIMIT 1");
				const retireVersions = this.#database.prepare("UPDATE asset_versions SET current=0 WHERE asset_id=? AND current=1");
				for (const { assetId, path } of staleLocations) {
					deleteLocation.run(assetId, path);
					deleteEdge.run(assetId, `path:${path}`);
				}
				for (const assetId of new Set(staleLocations.map(({ assetId }) => assetId))) {
					if (!remainingLocation.get(assetId)) retireVersions.run(assetId);
				}
				this.#database.exec("COMMIT");
			} catch (error) {
				this.#database.exec("ROLLBACK");
				throw error;
			}
		}
		return results;
	}

	#indexDocument(assetId: string, versionId: string, document: DocumentIR, path: string, source?: string, previousVersionId?: string): void {
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			this.#database.prepare("DELETE FROM external_chunks WHERE chunk_id IN (SELECT id FROM chunks WHERE version_id=?)").run(versionId);
			this.#database.prepare("DELETE FROM chunks_fts WHERE chunk_id IN (SELECT id FROM chunks WHERE version_id=?)").run(versionId);
			this.#database.prepare("DELETE FROM chunks WHERE version_id=?").run(versionId);
			const insertChunk = this.#database.prepare("INSERT INTO chunks(id,version_id,asset_id,page_number,block_id,content,structural_context,token_estimate,vector) VALUES(?,?,?,?,?,?,?,?,?)");
			const insertFts = this.#database.prepare("INSERT INTO chunks_fts(chunk_id,content) VALUES(?,?)");
			let sourceOffset = 0;
			let group: { pageNumber: number; blockIds: string[]; content: string; structure?: CodeStructure } | undefined;
			const flushGroup = (): void => {
				if (!group) return;
				for (const [part, chunk] of chunksOf(group.content).entries()) {
					const blockId = group.blockIds.join("+") + (part ? `:${part + 1}` : "");
					const chunkId = `chunk_${sha256(`${STRUCTURAL_INDEX_REVISION}:${versionId}:${group.pageNumber}:${blockId}`).slice(0, 32)}`;
					const structuralContext = group.structure ? JSON.stringify(group.structure) : "";
					insertChunk.run(chunkId, versionId, assetId, group.pageNumber, blockId, chunk, structuralContext, estimateTokens(chunk), JSON.stringify(vector(`${structuralContext}\n${chunk}`)));
					insertFts.run(chunkId, `${structuralContext}\n${chunk}`);
					this.#insertEdge({ fromId: versionId, toId: chunkId, type: "HAS_CHUNK" }, false);
				}
				group = undefined;
			};
			for (const page of document.pages) for (const block of page.blocks) {
				const content = block.text?.trim();
				if (!content) continue;
				const blockOffset = source ? source.indexOf(content, sourceOffset) : -1;
				if (blockOffset >= 0) sourceOffset = blockOffset + content.length;
				const structure = source ? codeStructure(path, source, content, Math.max(0, blockOffset)) : undefined;
				const sameStructure = JSON.stringify(group?.structure ?? null) === JSON.stringify(structure ?? null);
				const separator = group ? "\n\n" : "";
				if (!group || group.pageNumber !== page.pageNumber || !sameStructure || group.content.length + separator.length + content.length > 3_500) {
					flushGroup();
					group = { pageNumber: page.pageNumber, blockIds: [block.blockId], content, structure };
				} else {
					group.blockIds.push(block.blockId);
					group.content += `${separator}${content}`;
				}
			}
			flushGroup();
			this.#insertEdge({ fromId: versionId, toId: assetId, type: "VERSION_OF" }, false);
			this.#database.prepare("DELETE FROM edges WHERE from_id=? AND type='CURRENT_VERSION'").run(assetId);
			this.#insertEdge({ fromId: assetId, toId: versionId, type: "CURRENT_VERSION" }, false);
			if (previousVersionId) this.#insertEdge({ fromId: versionId, toId: previousVersionId, type: "SUPERSEDES" }, false);
			this.#database.exec("COMMIT");
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	addEdge(edge: GraphEdgeInput): string {
		const projectNodes = this.#projectNodes();
		if (!projectNodes.has(edge.fromId) || !projectNodes.has(edge.toId)) {
			throw new Error("Graph edges cannot cross the active project boundary");
		}
		return this.#insertEdge(edge, true);
	}

	#projectNodes(): Set<string> {
		const nodes = new Set<string>();
		for (const { id } of this.#database.prepare("SELECT id FROM assets WHERE project_id=? UNION SELECT v.id FROM asset_versions v JOIN assets a ON a.id=v.asset_id WHERE a.project_id=? UNION SELECT c.id FROM chunks c JOIN assets a ON a.id=c.asset_id WHERE a.project_id=?").all(this.#projectId, this.#projectId, this.#projectId) as Array<{ id: string }>) nodes.add(id);
		for (const { toId } of this.#database.prepare("SELECT e.to_id toId FROM edges e JOIN assets a ON a.id=e.from_id WHERE a.project_id=? AND e.type='LOCATED_AT'").all(this.#projectId) as Array<{ toId: string }>) nodes.add(toId);
		return nodes;
	}

	#insertEdge(edge: GraphEdgeInput, validate: boolean): string {
		if (!CURRENT_GRAPH_EDGES.has(edge.type) && !INFERRED_GRAPH_EDGES.has(edge.type)) throw new Error(`Unknown graph edge type: ${edge.type}`);
		if (validate && INFERRED_GRAPH_EDGES.has(edge.type)) {
			if (typeof edge.confidence !== "number" || edge.confidence < 0 || edge.confidence > 1 || !edge.evidenceIds?.length || !edge.extractorModel || !edge.extractorVersion || !edge.reviewStatus) {
				throw new Error("Inferred graph edges require confidence, evidence, extractor identity, and review status");
			}
		}
		const id = `edge_${sha256(JSON.stringify(edge)).slice(0, 32)}`;
		this.#database.prepare("INSERT OR REPLACE INTO edges(id,from_id,to_id,type,confidence,evidence_ids,extractor_model,extractor_version,review_status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
			.run(id, edge.fromId, edge.toId, edge.type, edge.confidence ?? null, edge.evidenceIds ? JSON.stringify(edge.evidenceIds) : null, edge.extractorModel ?? null, edge.extractorVersion ?? null, edge.reviewStatus ?? null, Date.now());
		return id;
	}

	getVersions(assetId: string): AssetVersionRecord[] {
		return (this.#database.prepare(`SELECT v.asset_id assetId,v.id versionId,a.project_id projectId,COALESCE((SELECT path FROM asset_locations WHERE asset_id=a.id ORDER BY last_seen DESC,rowid DESC LIMIT 1),'') path,v.content_hash contentHash,v.current current,v.created_at createdAt FROM asset_versions v JOIN assets a ON a.id=v.asset_id WHERE v.asset_id=? ORDER BY v.created_at`).all(assetId) as Array<Record<string, unknown>>)
			.map((row) => ({ ...row, current: Boolean(row.current) }) as unknown as AssetVersionRecord);
	}

	getChunkCount(assetId: string, currentVersionsOnly = true): number {
		const row = this.#database.prepare(`SELECT COUNT(*) count FROM chunks c JOIN asset_versions v ON v.id=c.version_id WHERE c.asset_id=? AND (?=0 OR v.current=1)`).get(assetId, currentVersionsOnly ? 1 : 0) as { count: number };
		return Number(row.count);
	}

	pendingExternalChunks(backend: string): RetrievedEvidence[] {
		return (this.#database.prepare(`SELECT c.id chunkId,c.asset_id assetId,c.version_id versionId,l.path path,c.page_number pageNumber,c.block_id blockId,c.content content,c.structural_context structuralContext,v.content_hash contentHash,0 score FROM chunks c JOIN asset_versions v ON v.id=c.version_id JOIN assets a ON a.id=c.asset_id JOIN asset_locations l ON l.rowid=(SELECT rowid FROM asset_locations WHERE asset_id=c.asset_id ORDER BY last_seen DESC,rowid DESC LIMIT 1) LEFT JOIN external_chunks x ON x.backend=? AND x.chunk_id=c.id WHERE a.project_id=? AND v.current=1 AND x.chunk_id IS NULL ORDER BY l.path,c.page_number,c.block_id`).all(backend, this.#projectId) as Array<Record<string, unknown>>).map((row) => ({
			chunkId: String(row.chunkId), assetId: String(row.assetId), versionId: String(row.versionId), path: String(row.path),
			pageNumber: Number(row.pageNumber), blockId: String(row.blockId), content: String(row.content), score: 0, contentHash: String(row.contentHash), structure: parseStructure(row.structuralContext),
		}));
	}

	markExternalChunks(backend: string, chunkIds: string[]): void {
		const insert = this.#database.prepare("INSERT OR REPLACE INTO external_chunks(backend,chunk_id,indexed_at) VALUES(?,?,?)");
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			for (const chunkId of chunkIds) insert.run(backend, chunkId, Date.now());
			this.#database.exec("COMMIT");
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	getCurrentChunk(chunkId: string): RetrievedEvidence | undefined {
		const row = this.#database.prepare(`SELECT c.id chunkId,c.asset_id assetId,c.version_id versionId,l.path path,c.page_number pageNumber,c.block_id blockId,c.content content,c.structural_context structuralContext,v.content_hash contentHash FROM chunks c JOIN asset_versions v ON v.id=c.version_id JOIN assets a ON a.id=c.asset_id JOIN asset_locations l ON l.rowid=(SELECT rowid FROM asset_locations WHERE asset_id=c.asset_id ORDER BY last_seen DESC,rowid DESC LIMIT 1) WHERE c.id=? AND a.project_id=? AND v.current=1`).get(chunkId, this.#projectId) as Record<string, unknown> | undefined;
		return row ? { chunkId: String(row.chunkId), assetId: String(row.assetId), versionId: String(row.versionId), path: String(row.path), pageNumber: Number(row.pageNumber), blockId: String(row.blockId), content: String(row.content), contentHash: String(row.contentHash), score: 0, structure: parseStructure(row.structuralContext) } : undefined;
	}

	graphNeighbours(seedIds: string[], hops = 1): Array<{ fromId: string; toId: string; type: string; confidence?: number }> {
		const permitted = this.#projectNodes();
		const visited = new Set(seedIds.filter((id) => permitted.has(id)));
		let frontier = [...visited];
		const results = new Map<string, { fromId: string; toId: string; type: string; confidence?: number }>();
		for (let depth = 0; depth < Math.max(0, Math.min(hops, 4)); depth++) {
			const next: string[] = [];
			for (const node of frontier) {
				const rows = this.#database.prepare("SELECT from_id fromId,to_id toId,type,confidence FROM edges WHERE from_id=? OR to_id=? ORDER BY type,from_id,to_id").all(node, node) as Array<{ fromId: string; toId: string; type: string; confidence: number | null }>;
				for (const row of rows) {
					if (!permitted.has(row.fromId) || !permitted.has(row.toId)) continue;
					results.set(`${row.fromId}:${row.type}:${row.toId}`, { fromId: row.fromId, toId: row.toId, type: row.type, ...(row.confidence === null ? {} : { confidence: row.confidence }) });
					for (const id of [row.fromId, row.toId]) if (!visited.has(id)) { visited.add(id); next.push(id); }
				}
			}
			frontier = next.sort();
		}
		return [...results.values()];
	}

	retrieve(query: string, scope: RetrievalScope = {}): RetrievedEvidence[] {
		const maximum = Math.max(1, Math.min(scope.maximumResults ?? 20, 100));
		const projectIds = scope.projectIds?.length ? scope.projectIds : [this.#projectId];
		if (scope.assetIds?.length === 0) return [];
		const graphNodes = scope.graphSeedIds?.length
			? new Set([...(scope.graphSeedIds ?? []), ...this.graphNeighbours(scope.graphSeedIds, scope.graphHops ?? 2).flatMap(({ fromId, toId }) => [fromId, toId])])
			: undefined;
		if (graphNodes?.size === 0) return [];
		const queryTokens = [...new Set(tokens(query))].slice(0, 20);
		if (!queryTokens.length) return [];
		const ftsQuery = queryTokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
		const placeholders = (values: readonly unknown[]) => values.map(() => "?").join(",");
		const predicates = ["(?=1 OR v.current=1)", `a.project_id IN (${placeholders(projectIds)})`];
		const parameters: Array<string | number> = [scope.includeOldVersions ? 1 : 0, ...projectIds];
		const scopePath = scope.path?.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/+$/u, "");
		if (scopePath && scopePath !== ".") {
			predicates.push("(l.path=? OR instr(l.path,?)=1)");
			parameters.push(scopePath, `${scopePath}/`);
		}
		if (scope.assetIds) {
			predicates.push(`c.asset_id IN (${placeholders(scope.assetIds)})`);
			parameters.push(...scope.assetIds);
		}
		if (graphNodes) {
			const ids = [...graphNodes];
			const nodes = placeholders(ids);
			predicates.push(`(c.asset_id IN (${nodes}) OR c.version_id IN (${nodes}) OR c.id IN (${nodes}))`);
			parameters.push(...ids, ...ids, ...ids);
		}
		const candidateLimit = Math.max(1_000, maximum * 50);
		const rows = this.#database.prepare(`SELECT c.id chunkId,c.asset_id assetId,c.version_id versionId,l.path path,c.page_number pageNumber,c.block_id blockId,c.content content,c.structural_context structuralContext,c.vector vector,v.content_hash contentHash,v.current current,a.project_id projectId,bm25(chunks_fts) ftsScore FROM chunks_fts JOIN chunks c ON c.id=chunks_fts.chunk_id JOIN asset_versions v ON v.id=c.version_id JOIN assets a ON a.id=c.asset_id JOIN asset_locations l ON l.rowid=(SELECT rowid FROM asset_locations WHERE asset_id=c.asset_id ORDER BY last_seen DESC,rowid DESC LIMIT 1) WHERE chunks_fts MATCH ? AND ${predicates.join(" AND ")} ORDER BY ftsScore,c.id LIMIT ?`).all(ftsQuery, ...parameters, candidateLimit) as Array<Record<string, unknown>>;
		const queryVector = vector(query);
		const vectorRanked = rows.map((row) => ({ row, score: cosine(queryVector, JSON.parse(String(row.vector)) as number[]) })).sort((a, b) => b.score - a.score || String(a.row.chunkId).localeCompare(String(b.row.chunkId)));
		const ftsRank = new Map(rows.map((row, index) => [String(row.chunkId), index + 1]));
		const vectorRanks = new Map(vectorRanked.filter(({ score }) => score > 0).map(({ row }, index) => [String(row.chunkId), index + 1]));
		return rows.map((row) => {
			const chunkId = String(row.chunkId);
			const lexicalRank = ftsRank.get(chunkId);
			const semanticRank = vectorRanks.get(chunkId);
			const score = (lexicalRank ? 1 / (60 + lexicalRank) : 0) + (semanticRank ? 1 / (60 + semanticRank) : 0) + (graphNodes ? 0.02 : 0);
			return {
				chunkId,
				assetId: String(row.assetId),
				versionId: String(row.versionId),
				path: String(row.path),
				pageNumber: Number(row.pageNumber),
				blockId: String(row.blockId),
				content: String(row.content),
				score,
				contentHash: String(row.contentHash),
				structure: parseStructure(row.structuralContext),
			};
		}).filter(({ score }) => score > 0).sort((left, right) => right.score - left.score || left.chunkId.localeCompare(right.chunkId)).slice(0, maximum);
	}

	async recall(query: string, tokenBudget: number, signal?: AbortSignal): Promise<ContextPacket> {
		if (signal?.aborted) throw new Error("Memory recall aborted");
		const evidence: RetrievedEvidence[] = [];
		let used = 0;
		for (const item of this.retrieve(query, { maximumResults: 100 })) {
			const cost = estimateTokens(item.content);
			if (used + cost > tokenBudget) continue;
			evidence.push(item);
			used += cost;
		}
		const provenance = evidence.map(({ chunkId, assetId, versionId, path, pageNumber, contentHash }) => ({ chunkId, assetId, versionId, path, pageNumber, contentHash }));
		const structuralContext = this.graphNeighbours([...new Set(evidence.map(({ assetId }) => assetId))], 1);
		return {
			taskId: "recall",
			agentPresetId: "unresolved",
			structuralContext,
			evidence,
			memories: [],
			sourceVersions: [...new Set(evidence.map(({ versionId }) => versionId))],
			provenance,
			tokenBudget,
			estimatedTokens: used,
			contextHash: sha256(JSON.stringify({ evidence: evidence.map(({ chunkId }) => chunkId), provenance })),
		};
	}

	async capture(run: RunResult, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) throw new Error("Memory capture aborted");
		this.#database.prepare("INSERT OR REPLACE INTO conversations(run_id,project_id,objective,output,created_at) VALUES(?,?,?,?,?)")
			.run(run.runId, this.#projectId, run.task.objective, run.output, Date.now());
	}
}

export interface TencentMemoryAdapterOptions {
	endpoint: string;
	apiKey: string;
	serviceId: string;
	teamId: string;
	agentId: string;
	userId: string;
	sessionId: string;
	fetch?: typeof globalThis.fetch;
	timeoutMs?: number;
}

// architectural-layer: adapter input validation; owner: TencentMemoryAdapter.recall
export const validateTencentRecallTokenBudget = (tokenBudget: number): void => {
	if (!Number.isInteger(tokenBudget) || tokenBudget < 1 || tokenBudget > 1_000_000) throw new Error("Tencent memory token budget is invalid");
};

// architectural-layer: adapter result-count conversion; owner: TencentMemoryAdapter.recall
export const tencentResultLimitForBudget = (tokenBudget: number): number =>
	Math.min(100, Math.max(1, Math.floor(tokenBudget / 100)));

export class TencentMemoryAdapter implements MemoryBackend {
	readonly #options: TencentMemoryAdapterOptions;
	constructor(options: TencentMemoryAdapterOptions) {
		const endpoint = new URL(options.endpoint);
		if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["127.0.0.1", "::1", "localhost"].includes(endpoint.hostname))) throw new Error("Memory endpoint must use HTTPS or loopback HTTP");
		for (const [name, value] of Object.entries(options).filter(([name]) => !["fetch", "endpoint", "timeoutMs"].includes(name))) {
			if (typeof value !== "string" || !value.trim()) throw new Error(`Tencent memory ${name} is required`);
		}
		if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 120_000)) throw new Error("Tencent memory timeout must be 100-120000 ms");
		this.#options = options;
	}

	async #post<T>(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
		const payload = JSON.stringify({ ...body, team_id: this.#options.teamId, agent_id: this.#options.agentId, user_id: this.#options.userId });
		if (Buffer.byteLength(payload) > 1024 * 1024) throw new Error("Tencent memory request exceeds 1 MiB");
		const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(this.#options.timeoutMs ?? 20_000)]);
		const response = await (this.#options.fetch ?? globalThis.fetch)(new URL(path.replace(/^\//, ""), `${this.#options.endpoint.replace(/\/$/, "")}/`), {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${this.#options.apiKey}`, "x-tdai-service-id": this.#options.serviceId },
			body: payload,
			signal: requestSignal,
		});
		if (!response.ok) throw new Error(`Tencent memory request failed (${response.status})`);
		if (!response.body) throw new Error("Tencent memory returned no body");
		const chunks: Buffer[] = [];
		let bytes = 0;
		for await (const chunk of response.body) {
			bytes += chunk.byteLength;
			if (bytes > 2 * 1024 * 1024) throw new Error("Tencent memory response exceeds 2 MiB");
			chunks.push(Buffer.from(chunk));
		}
		const text = Buffer.concat(chunks).toString("utf8");
		const envelope = JSON.parse(text) as { code?: number; message?: string; data?: T };
		if (envelope.code !== 0 || envelope.data === undefined) throw new Error(envelope.message || "Tencent memory returned an invalid response");
		return envelope.data;
	}

	async recall(query: string, tokenBudget: number, signal?: AbortSignal): Promise<ContextPacket> {
		if (!query.trim() || query.length > 16_000) throw new Error("Tencent memory query must be 1-16000 characters");
		validateTencentRecallTokenBudget(tokenBudget);
		const limit = tencentResultLimitForBudget(tokenBudget);
		const [atomic, conversations] = await Promise.all([
			this.#post<{ items?: unknown[] }>("v3/atomic/search", { query, limit }, signal),
			this.#post<{ messages?: unknown[] }>("v3/conversation/search", { query, limit }, signal),
		]);
		const memories = [...(atomic.items ?? []), ...(conversations.messages ?? [])];
		return { taskId: "recall", agentPresetId: "unresolved", structuralContext: [], evidence: [], memories, sourceVersions: [], provenance: [], tokenBudget, estimatedTokens: Math.min(tokenBudget, Buffer.byteLength(JSON.stringify(memories)) / 4), contextHash: sha256(JSON.stringify(memories)) };
	}

	async capture(run: RunResult, signal?: AbortSignal): Promise<void> {
		const bounded = [...chunksOf(run.task.objective, 8_000).map((content) => ({ role: "user", content })), ...chunksOf(run.output, 8_000).map((content) => ({ role: "assistant", content }))].slice(0, 100);
		await this.#post("v3/conversation/add", { session_id: this.#options.sessionId, messages: bounded }, signal);
	}

	async health(signal?: AbortSignal): Promise<void> {
		const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(this.#options.timeoutMs ?? 20_000)]);
		const response = await (this.#options.fetch ?? globalThis.fetch)(new URL("health", `${this.#options.endpoint.replace(/\/$/, "")}/`), { signal: requestSignal });
		if (!response.ok) throw new Error(`Tencent memory health check failed (${response.status})`);
	}

	async addWorkspaceChunks(chunks: RetrievedEvidence[], projectId: string, signal?: AbortSignal, onBatch?: (chunkIds: string[]) => void | Promise<void>): Promise<void> {
		const prefix = WORKSPACE_ROUTING_CARD_PREFIX;
		const maxRequestBytes = 700_000;
		let records: WorkspaceRoutingCard[] = [];
		let messages: Array<{ role: "user"; content: string }> = [];
		let markedChunkIds: string[] = [];
		let requestBytes = 0;
		const flushRequest = async () => {
			if (!messages.length) return;
			await this.#post("v3/conversation/add", { session_id: `workspace:${projectId}`, messages }, signal);
			await onBatch?.(markedChunkIds);
			messages = []; markedChunkIds = []; requestBytes = 0;
		};
		const flushBundle = async () => {
			if (!records.length) return;
			const content = `${prefix}${JSON.stringify(records)}`;
			const bytes = Buffer.byteLength(content);
			if (messages.length && (messages.length >= 100 || requestBytes + bytes > maxRequestBytes)) await flushRequest();
			messages.push({ role: "user", content });
			markedChunkIds.push(...records.map(({ chunkId }) => chunkId));
			requestBytes += bytes;
			records = [];
		};
		for (const chunk of chunks) {
			const record = routingCardForChunk(chunk);
			const single = serializedRoutingCard(record);
			if (Buffer.byteLength(single) >= MAX_ROUTING_CARD_BYTES) throw new Error(`Workspace routing card is too large for Tencent memory: ${chunk.path}`);
			if (records.length && Buffer.byteLength(`${prefix}${JSON.stringify([...records, record])}`) >= MAX_ROUTING_CARD_BYTES) await flushBundle();
			records.push(record);
		}
		await flushBundle();
		await flushRequest();
	}
}

const workspaceChunks = (value: unknown): Array<{ chunkId: string; score: number }> => {
	if (!value || typeof value !== "object") return [];
	const item = value as { content?: unknown; score?: unknown };
	if (typeof item.content !== "string") return [];
	const score = typeof item.score === "number" ? item.score : 0;
	if (item.content.startsWith(WORKSPACE_ROUTING_CARD_PREFIX)) {
		try {
			const parsed = JSON.parse(item.content.slice(WORKSPACE_ROUTING_CARD_PREFIX.length)) as { chunkId?: unknown } | Array<{ chunkId?: unknown }>;
			const records = Array.isArray(parsed) ? parsed : [parsed];
			return records.flatMap(({ chunkId }) => typeof chunkId === "string" ? [{ chunkId, score }] : []);
		} catch { return []; }
	}
	if (item.content.startsWith(WORKSPACE_BUNDLE_PREFIX)) {
		try {
			const records = JSON.parse(item.content.slice(WORKSPACE_BUNDLE_PREFIX.length)) as Array<{ chunkId?: unknown }>;
			return Array.isArray(records) ? records.flatMap(({ chunkId }) => typeof chunkId === "string" ? [{ chunkId, score }] : []) : [];
		} catch { return []; }
	}
	if (!item.content.startsWith(WORKSPACE_CHUNK_PREFIX)) return [];
	const header = item.content.slice(WORKSPACE_CHUNK_PREFIX.length).split("\n", 1)[0];
	if (header?.startsWith("chunk_")) return [{ chunkId: header, score }];
	try {
		const parsed = JSON.parse(header ?? "") as { chunkId?: unknown };
		return typeof parsed.chunkId === "string" ? [{ chunkId: parsed.chunkId, score }] : [];
	} catch { return []; }
};

export interface HybridGraphMemoryOptions {
	local: LocalGraphMemory;
	remote: TencentMemoryAdapter;
	projectId: string;
}

// architectural-layer: workspace caller token-budget policy; owner: HybridGraphMemory.searchWorkspace
export const workspaceRecallTokenBudget = (limit: number): number =>
	Math.min(100_000, Math.max(1_000, limit * 250));

export class HybridGraphMemory implements MemoryBackend {
	readonly #local: LocalGraphMemory;
	readonly #remote: TencentMemoryAdapter;
	readonly #projectId: string;
	constructor(options: HybridGraphMemoryOptions) {
		this.#local = options.local; this.#remote = options.remote; this.#projectId = options.projectId;
	}

	async indexWorkspace(signal?: AbortSignal, onProgress?: (progress: { phase: "local" | "remote"; completed: number; total: number; path?: string }) => void): Promise<{ files: number; chunks: number }> {
		await this.#remote.health(signal);
		const files = await this.#local.ingestWorkspace(signal, ({ completed, total, path }) => onProgress?.({ phase: "local", completed, total, path }));
		const chunks = this.#local.pendingExternalChunks(TENCENT_ROUTING_SYNC_MARKER);
		let completed = 0;
		await this.#remote.addWorkspaceChunks(chunks, this.#projectId, signal, (chunkIds) => {
			this.#local.markExternalChunks(TENCENT_ROUTING_SYNC_MARKER, chunkIds);
			completed += chunkIds.length;
			onProgress?.({ phase: "remote", completed, total: chunks.length });
		});
		return { files: files.length, chunks: chunks.length };
	}

	async searchWorkspace(query: string, options: { path?: string; limit?: number; signal?: AbortSignal } = {}): Promise<RetrievedEvidence[]> {
		const limit = Math.max(1, Math.min(options.limit ?? 12, 12));
		const scopePath = !options.path || options.path === "." ? undefined : options.path.replaceAll("\\", "/").replace(/\/+$/u, "");
		const expandedQuery = [query, ...workspaceSearchIntents(query), scopePath].filter(Boolean).join(" ");
		const inScope = ({ path }: RetrievedEvidence) => {
			const normalized = path.replaceAll("\\", "/");
			return !scopePath || normalized === scopePath || normalized.startsWith(`${scopePath}/`);
		};
		let remoteHits: RetrievedEvidence[] = [];
		try {
			const packet = await this.#remote.recall(`${WORKSPACE_ROUTING_CARD_PREFIX}${expandedQuery}`, workspaceRecallTokenBudget(limit), options.signal);
			remoteHits = packet.memories.flatMap((item) => workspaceChunks(item).flatMap((hit) => {
				const evidence = this.#local.getCurrentChunk(hit.chunkId); return evidence ? [{ ...evidence, score: hit.score }] : [];
			})).filter(inScope);
		} catch { /* Local retrieval is the availability fallback. */ }
		const localHits = this.#local.retrieve(expandedQuery, { maximumResults: Math.max(limit * 4, 50), ...(scopePath ? { path: scopePath } : {}) }).filter(inScope);
		return rankWorkspaceHits(query, fuseWorkspaceHits(remoteHits, localHits), limit);
	}

	async recall(query: string, tokenBudget: number, signal?: AbortSignal): Promise<ContextPacket> {
		let remote: ContextPacket | undefined;
		try { remote = await this.#remote.recall(query, tokenBudget, signal); } catch { /* Local retrieval is the availability fallback. */ }
		const remoteEvidence = (remote?.memories ?? []).flatMap((item) => workspaceChunks(item).flatMap((hit) => {
			const evidence = this.#local.getCurrentChunk(hit.chunkId); return evidence ? [{ ...evidence, score: hit.score }] : [];
		}));
		const source = fuseWorkspaceHits(remoteEvidence, this.#local.retrieve(query, { maximumResults: 100 }));
		const evidence: RetrievedEvidence[] = [];
		let used = 0;
		for (const item of source) { const cost = estimateTokens(item.content); if (used + cost <= tokenBudget) { evidence.push(item); used += cost; } }
		const provenance = evidence.map(({ chunkId, assetId, versionId, path, pageNumber, contentHash }) => ({ chunkId, assetId, versionId, path, pageNumber, contentHash }));
		const memories = (remote?.memories ?? []).filter((item) => workspaceChunks(item).length === 0);
		return { taskId: "recall", agentPresetId: "unresolved", structuralContext: this.#local.graphNeighbours([...new Set(evidence.map(({ assetId }) => assetId))], 1), evidence, memories, sourceVersions: [...new Set(evidence.map(({ versionId }) => versionId))], provenance, tokenBudget, estimatedTokens: Math.min(tokenBudget, used + estimateTokens(JSON.stringify(memories))), contextHash: sha256(JSON.stringify({ provenance, memories })) };
	}

	async capture(run: RunResult, signal?: AbortSignal): Promise<void> {
		await this.#local.capture(run, signal);
		await this.#remote.capture(run, signal);
	}

	close(): void { this.#local.close(); }
}
