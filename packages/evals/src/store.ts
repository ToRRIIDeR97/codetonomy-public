import { repairMetrics, type RepairMetrics } from "./repair.js";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmodSync, lstatSync, mkdirSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { redactAuditString, redactAuditValue, type ContextPacket, type HarnessEvent, type RunResult, type RunStore } from "@agent-harness/contracts";
import type { HarnessOrchestrationResult } from "@agent-harness/runtime";

const MAX_TRACE_BYTES = 64 * 1024 * 1024;
const SQLITE_BUSY_TIMEOUT_MS = 5_000;

export interface StoredRunSummary {
	runId: string;
	parentRunId?: string;
	kind: "agent" | "orchestration";
	status: "completed" | "failed";
	verified: boolean;
	presetId?: string;
	providerId?: string;
	modelId?: string;
	startedAt?: string;
	completedAt?: string;
	durationMs?: number;
	tracePath: string;
}

export interface RunMetrics {
	runId: string;
	verified: boolean;
	durationMs: number;
	modelCalls: number;
	toolCalls: number;
	errors: number;
	totalTokens: number;
	cachedInputTokens: number;
	uncachedInputTokens: number;
	cacheSavingsRatio: number;
	cacheWriteTokens: number;
	netCacheSavings: number;
	prefixSurvivalRate: number;
	totalCost: number;
	costPerVerifiedSuccess: number | null;
	uncachedTokensPerVerifiedSuccess: number | null;
	firstPassVerified: boolean;
	repairAttempts: number;
	repair: RepairMetrics;
	requirementCoverage: number;
	artifactValidity: number;
	toolSuccessRate: number;
	toolRetryRate: number;
	duplicateToolCallRate: number;
	averageToolLatencyMs: number;
	toolOutputBytes: number;
	permissionDenials: number;
	cacheInvalidations: number;
	falseCompletion: boolean;
	humanCorrectionMinutes: number;
	stablePrefixTokens: number;
	loadedSkillTokens: number;
	retrievedContextTokens: number;
	toolResultTokens: number;
	parentTokens: number;
	childTokens: number;
	repairTokens: number;
	childTokensPercentage: number;
	evidenceItems: number;
	provenanceCoverage: number;
	errorCategories: Record<string, number>;
}

export interface StoredBenchmarkRun {
	benchmarkId: string;
	variant: string;
	runId?: string;
	error?: string;
	createdAt: string;
}

export interface StoredBenchmarkReport {
	benchmarkId: string;
	variants: Array<StoredBenchmarkRun & { metrics?: RunMetrics }>;
	verifiedSuccessDelta?: number;
	latencyDeltaMs?: number;
	costDelta?: number;
}

export interface EvaluationSummary {
	runs: number;
	verifiedRuns: number;
	verifiedRate: number;
	modelCalls: number;
	toolCalls: number;
	errors: number;
	totalTokens: number;
	cachedInputTokens: number;
	totalCost: number;
	averageDurationMs: number;
	costPerVerifiedSuccess: number | null;
}

export interface StoredRunDetails {
	run: StoredRunSummary & { output: string };
	metrics: RunMetrics;
	task?: Record<string, unknown>;
	requirements: Array<Record<string, unknown>>;
	events: Array<Record<string, unknown>>;
	toolCalls: Array<Record<string, unknown>>;
	modelCalls: Array<Record<string, unknown>>;
	errors: Array<Record<string, unknown>>;
	artifacts: Array<Record<string, unknown>>;
	verifiers: Array<Record<string, unknown>>;
	subagents: Array<Record<string, unknown>>;
	skills: string[];
	humanReviews: Array<Record<string, unknown>>;
}

export interface EvaluationRestoreResult {
	databasePath: string;
	recoveryPath?: string;
}

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

const removeSqliteSidecars = async (path: string): Promise<void> => {
	await Promise.all(["-wal", "-shm"].map((suffix) => unlink(`${path}${suffix}`).catch((error) => {
		if (!isMissing(error)) throw error;
	})));
};

const assertStandaloneDatabase = async (path: string, label: string): Promise<void> => {
	const info = await lstat(path);
	if (!info.isFile() || info.nlink !== 1) throw new Error(`${label} must be a regular standalone file`);
};

const databaseIsHealthy = (database: DatabaseSync): boolean => {
	const row = database.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined;
	return Object.values(row ?? {}).includes("ok");
};

const sealStandaloneDatabase = (path: string): void => {
	const database = new DatabaseSync(path);
	try {
		database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		database.prepare("PRAGMA journal_mode=DELETE").get();
	} finally {
		database.close();
	}
};

async function readTrace(path: string): Promise<HarnessEvent[]> {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.nlink !== 1) throw new Error("Trace must be a regular standalone file");
		if (info.size > MAX_TRACE_BYTES) throw new Error("Trace exceeds 64 MiB");
		const data = Buffer.alloc(info.size + 1);
		let length = 0;
		while (length < data.length) {
			const { bytesRead } = await handle.read(data, length, data.length - length, length);
			if (!bytesRead) break;
			length += bytesRead;
		}
		if (length > MAX_TRACE_BYTES) throw new Error("Trace exceeds 64 MiB");
		let sequence = 0;
		return data.subarray(0, length).toString("utf8").split("\n").filter(Boolean).map((line) => {
			const event = JSON.parse(line) as HarnessEvent;
			if (!event.eventId || !event.runId || !event.type || !Number.isInteger(event.sequence) || event.sequence <= sequence) throw new Error("Trace contains an invalid event envelope");
			sequence = event.sequence;
			return event;
		});
	} finally {
		await handle.close();
	}
}

const text = (value: unknown): string | null => typeof value === "string" ? value : null;
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const parseJson = (value: unknown): unknown => {
	if (typeof value !== "string") return value;
	try { return JSON.parse(value); } catch { return value; }
};
export { redactAuditValue } from "@agent-harness/contracts";

export class EvaluationStore implements RunStore {
	readonly #database: DatabaseSync;
	readonly #runDirectory: string;

	constructor(databasePath: string) {
		databasePath = resolve(databasePath);
		mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
		this.#runDirectory = join(realpathSync(dirname(databasePath)), "runs");
		try {
			const info = lstatSync(databasePath);
			if (!info.isFile() || info.nlink !== 1) throw new Error("Evaluation database must be a regular standalone file");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		this.#database = new DatabaseSync(databasePath);
		chmodSync(databasePath, 0o600);
		this.#database.exec(`
			PRAGMA busy_timeout=${SQLITE_BUSY_TIMEOUT_MS};
			PRAGMA journal_mode=WAL;
			PRAGMA foreign_keys=ON;
			PRAGMA secure_delete=ON;
			CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
		`);
		const version = Number((this.#database.prepare("SELECT COALESCE(MAX(version),0) version FROM schema_migrations").get() as { version: number }).version);
		if (version > 4) {
			this.#database.close();
			throw new Error(`Evaluation database schema ${version} is newer than this Codetonomy build`);
		}
		if (version < 1) this.#database.exec(`
			BEGIN IMMEDIATE;
			CREATE TABLE IF NOT EXISTS runs(run_id TEXT PRIMARY KEY,parent_run_id TEXT,child_id TEXT,kind TEXT NOT NULL,status TEXT NOT NULL,verified INTEGER NOT NULL,preset_id TEXT,provider_id TEXT,model_id TEXT,started_at TEXT,completed_at TEXT,duration_ms REAL,trace_path TEXT NOT NULL,output TEXT NOT NULL,created_at TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS events(event_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,parent_event_id TEXT,sequence INTEGER NOT NULL,timestamp TEXT NOT NULL,type TEXT NOT NULL,data_json TEXT NOT NULL,FOREIGN KEY(run_id) REFERENCES runs(run_id) ON DELETE CASCADE);
			CREATE TABLE IF NOT EXISTS tasks(run_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,objective TEXT NOT NULL,risk_class TEXT NOT NULL,artifact_types_json TEXT NOT NULL,domains_json TEXT NOT NULL,FOREIGN KEY(run_id) REFERENCES runs(run_id) ON DELETE CASCADE);
			CREATE TABLE IF NOT EXISTS task_requirements(run_id TEXT NOT NULL,requirement_id TEXT NOT NULL,description TEXT NOT NULL,required INTEGER NOT NULL,passed INTEGER,PRIMARY KEY(run_id,requirement_id),FOREIGN KEY(run_id) REFERENCES runs(run_id) ON DELETE CASCADE);
			CREATE TABLE IF NOT EXISTS model_calls(event_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,parent_event_id TEXT,provider_id TEXT,model_id TEXT,started_at TEXT,completed_at TEXT,first_token_ms REAL,status TEXT,usage_json TEXT,FOREIGN KEY(run_id) REFERENCES runs(run_id) ON DELETE CASCADE);
			CREATE TABLE IF NOT EXISTS token_usage(run_id TEXT PRIMARY KEY,input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,reasoning_tokens INTEGER NOT NULL,cache_read_tokens INTEGER NOT NULL,cache_write_tokens INTEGER NOT NULL,total_tokens INTEGER NOT NULL,total_cost REAL NOT NULL,cache_savings_ratio REAL NOT NULL,FOREIGN KEY(run_id) REFERENCES runs(run_id) ON DELETE CASCADE);
			CREATE TABLE IF NOT EXISTS cache_events(event_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,type TEXT NOT NULL,status TEXT,cache_prefix_hash TEXT,changed_json TEXT,tokens INTEGER,timestamp TEXT NOT NULL,FOREIGN KEY(run_id) REFERENCES runs(run_id) ON DELETE CASCADE);
			CREATE TABLE IF NOT EXISTS tool_calls(tool_call_id TEXT NOT NULL,run_id TEXT NOT NULL,tool_id TEXT NOT NULL,requested_at TEXT NOT NULL,completed_at TEXT,decision TEXT,status TEXT NOT NULL,arguments_json TEXT NOT NULL,PRIMARY KEY(run_id,tool_call_id),FOREIGN KEY(run_id) REFERENCES runs(run_id) ON DELETE CASCADE);
			CREATE TABLE IF NOT EXISTS errors(error_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,type TEXT NOT NULL,message TEXT,timestamp TEXT NOT NULL,data_json TEXT NOT NULL,FOREIGN KEY(run_id) REFERENCES runs(run_id) ON DELETE CASCADE);
			CREATE TABLE IF NOT EXISTS subagent_runs(parent_run_id TEXT NOT NULL,child_id TEXT NOT NULL,child_run_id TEXT,status TEXT NOT NULL,preset_id TEXT,error TEXT,PRIMARY KEY(parent_run_id,child_id),FOREIGN KEY(parent_run_id) REFERENCES runs(run_id) ON DELETE CASCADE);
			CREATE TABLE IF NOT EXISTS context_packets(run_id TEXT PRIMARY KEY,context_hash TEXT NOT NULL,token_budget INTEGER NOT NULL,estimated_tokens INTEGER NOT NULL,source_versions_json TEXT NOT NULL,provenance_json TEXT NOT NULL,FOREIGN KEY(run_id) REFERENCES runs(run_id) ON DELETE CASCADE);
			CREATE TABLE IF NOT EXISTS retrieved_evidence(run_id TEXT NOT NULL,evidence_index INTEGER NOT NULL,asset_id TEXT,version_id TEXT,chunk_id TEXT,path TEXT,page_number INTEGER,content_hash TEXT,score REAL,content TEXT,PRIMARY KEY(run_id,evidence_index),FOREIGN KEY(run_id) REFERENCES runs(run_id) ON DELETE CASCADE);
			CREATE TABLE IF NOT EXISTS skill_selections(run_id TEXT NOT NULL,skill_id TEXT NOT NULL,PRIMARY KEY(run_id,skill_id),FOREIGN KEY(run_id) REFERENCES runs(run_id) ON DELETE CASCADE);
			CREATE TABLE IF NOT EXISTS artifacts(run_id TEXT NOT NULL,artifact_id TEXT NOT NULL,type TEXT NOT NULL,path TEXT,content TEXT NOT NULL,PRIMARY KEY(run_id,artifact_id),FOREIGN KEY(run_id) REFERENCES runs(run_id) ON DELETE CASCADE);
			CREATE TABLE IF NOT EXISTS verifier_results(run_id TEXT NOT NULL,verifier_id TEXT NOT NULL,passed INTEGER NOT NULL,message TEXT NOT NULL,PRIMARY KEY(run_id,verifier_id),FOREIGN KEY(run_id) REFERENCES runs(run_id) ON DELETE CASCADE);
			CREATE TABLE IF NOT EXISTS human_reviews(id INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL,rating INTEGER,minutes REAL,notes TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(run_id) REFERENCES runs(run_id) ON DELETE CASCADE);
			CREATE TABLE IF NOT EXISTS benchmark_runs(benchmark_id TEXT NOT NULL,variant TEXT NOT NULL,run_id TEXT,error TEXT,created_at TEXT NOT NULL,PRIMARY KEY(benchmark_id,variant));
			INSERT INTO schema_migrations(version,applied_at) VALUES(1,datetime('now'));
			COMMIT;
		`);
		if (version < 2) this.#database.exec(`
			BEGIN IMMEDIATE;
			ALTER TABLE model_calls ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0;
			ALTER TABLE tool_calls ADD COLUMN duration_ms REAL;
			ALTER TABLE tool_calls ADD COLUMN output_bytes INTEGER;
			INSERT INTO schema_migrations(version,applied_at) VALUES(2,datetime('now'));
			COMMIT;
		`);
		if (version < 3) this.#database.exec(`
			BEGIN IMMEDIATE;
			ALTER TABLE tool_calls ADD COLUMN operation_id TEXT;
			ALTER TABLE tool_calls ADD COLUMN parse_status TEXT;
			ALTER TABLE tool_calls ADD COLUMN backend TEXT;
			INSERT INTO schema_migrations(version,applied_at) VALUES(3,datetime('now'));
			COMMIT;
		`);
		if (version < 4) this.#database.exec(`
			BEGIN IMMEDIATE;
			ALTER TABLE tool_calls ADD COLUMN plan_reason TEXT;
			INSERT INTO schema_migrations(version,applied_at) VALUES(4,datetime('now'));
			COMMIT;
		`);
	}

	close(): void { this.#database.close(); }

	async saveRun(run: RunResult, metadata: { parentRunId?: string; childId?: string } = {}): Promise<void> {
		const events = (await readTrace(run.tracePath)).map((event) => ({ ...event, data: redactAuditValue(event.data) as Record<string, unknown> }));
		const started = events.find(({ type }) => type === "run.started");
		const terminal = events.findLast(({ type }) => type === "run.completed" || type === "run.failed");
		const firstModel = events.find(({ type }) => type === "model.request.started");
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			this.#upsertRun({
				runId: run.runId,
				parentRunId: metadata.parentRunId,
				childId: metadata.childId,
				kind: "agent",
				status: run.verification.passed ? "completed" : "failed",
				verified: run.verification.passed,
				presetId: run.capabilities.preset.id,
				providerId: text(firstModel?.data.provider) ?? undefined,
				modelId: text(firstModel?.data.model) ?? undefined,
				startedAt: started?.timestamp,
				completedAt: terminal?.timestamp,
				durationMs: number(terminal?.data.durationMs) ?? undefined,
				tracePath: run.tracePath,
				output: redactAuditString(run.output),
			});
			this.#clearDetails(run.runId);
			this.#insertEvents(run.runId, events);
			this.#database.prepare("INSERT INTO tasks(run_id,task_id,objective,risk_class,artifact_types_json,domains_json) VALUES(?,?,?,?,?,?)").run(run.runId, run.task.id, redactAuditString(run.task.objective), run.task.riskClass, JSON.stringify(run.task.artifactTypes), JSON.stringify(run.task.domains));
			const checks = new Map(run.verification.checks.map((check) => [check.id, check]));
			const requirement = this.#database.prepare("INSERT INTO task_requirements(run_id,requirement_id,description,required,passed) VALUES(?,?,?,?,?)");
			for (const item of run.task.acceptanceCriteria) requirement.run(run.runId, item.id, redactAuditString(item.description), item.required ? 1 : 0, checks.get(item.id)?.passed === undefined ? null : checks.get(item.id)!.passed ? 1 : 0);
			this.#insertModelCalls(run.runId, events);
			this.#insertToolCalls(run.runId, events);
			this.#insertCacheAndErrors(run.runId, events);
			const usage = run.usage;
			this.#database.prepare("INSERT INTO token_usage VALUES(?,?,?,?,?,?,?,?,?)").run(run.runId, usage.input, usage.output, usage.reasoning ?? 0, usage.cacheRead, usage.cacheWrite, usage.totalTokens, usage.cost?.total ?? 0, usage.cacheSavingsRatio ?? 0);
			for (const skillId of run.capabilities.skillIds) this.#database.prepare("INSERT INTO skill_selections(run_id,skill_id) VALUES(?,?)").run(run.runId, skillId);
			for (const artifact of run.artifacts) this.#database.prepare("INSERT INTO artifacts(run_id,artifact_id,type,path,content) VALUES(?,?,?,?,?)").run(run.runId, artifact.id, artifact.type, artifact.path ?? null, redactAuditString(artifact.content));
			for (const check of run.verification.checks) this.#database.prepare("INSERT INTO verifier_results(run_id,verifier_id,passed,message) VALUES(?,?,?,?)").run(run.runId, check.id, check.passed ? 1 : 0, redactAuditString(check.message));
			if (run.contextPacket) this.#insertContext(run.runId, redactAuditValue(run.contextPacket) as ContextPacket);
			this.#database.exec("COMMIT");
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	async saveOrchestration(result: HarnessOrchestrationResult): Promise<void> {
		for (const child of result.children) if (child.run) await this.saveRun(child.run, { parentRunId: result.runId, childId: child.id });
		const events = (await readTrace(result.tracePath)).map((event) => ({ ...event, data: redactAuditValue(event.data) as Record<string, unknown> }));
		const started = events.find(({ type }) => type === "run.started");
		const terminal = events.findLast(({ type }) => type === "run.completed" || type === "run.failed");
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			this.#upsertRun({ runId: result.runId, kind: "orchestration", status: result.verification.passed ? "completed" : "failed", verified: result.verification.passed, startedAt: started?.timestamp, completedAt: terminal?.timestamp, durationMs: number(terminal?.data.durationMs) ?? undefined, tracePath: result.tracePath, output: redactAuditString(result.output) });
			this.#clearDetails(result.runId);
			this.#insertEvents(result.runId, events);
			for (const child of result.children) this.#database.prepare("INSERT INTO subagent_runs(parent_run_id,child_id,child_run_id,status,preset_id,error) VALUES(?,?,?,?,?,?)").run(result.runId, child.id, child.run?.runId ?? null, child.status, child.run?.capabilities.preset.id ?? null, child.error ? redactAuditString(child.error) : null);
			for (const check of result.verification.checks) this.#database.prepare("INSERT INTO verifier_results(run_id,verifier_id,passed,message) VALUES(?,?,?,?)").run(result.runId, check.id, check.passed ? 1 : 0, redactAuditString(check.message));
			const usage = result.children.reduce((sum, child) => {
				if (!child.run) return sum;
				sum.input += child.run.usage.input; sum.output += child.run.usage.output; sum.reasoning += child.run.usage.reasoning ?? 0; sum.cacheRead += child.run.usage.cacheRead; sum.cacheWrite += child.run.usage.cacheWrite; sum.total += child.run.usage.totalTokens; sum.cost += child.run.usage.cost?.total ?? 0;
				return sum;
			}, { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
			const eligible = usage.input + usage.cacheRead;
			this.#database.prepare("INSERT INTO token_usage VALUES(?,?,?,?,?,?,?,?,?)").run(result.runId, usage.input, usage.output, usage.reasoning, usage.cacheRead, usage.cacheWrite, usage.total, usage.cost, eligible ? usage.cacheRead / eligible : 0);
			this.#database.exec("COMMIT");
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	listRuns(limit = 100): StoredRunSummary[] {
		if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("Run list limit must be 1-1000");
		return (this.#database.prepare("SELECT run_id runId,parent_run_id parentRunId,kind,status,verified,preset_id presetId,provider_id providerId,model_id modelId,started_at startedAt,completed_at completedAt,duration_ms durationMs,trace_path tracePath FROM runs ORDER BY COALESCE(started_at,created_at) DESC LIMIT ?").all(limit) as Array<Record<string, unknown>>).map((row) => ({ ...row, verified: Boolean(row.verified) }) as unknown as StoredRunSummary);
	}

	metrics(runId: string): RunMetrics {
		const row = this.#database.prepare(`SELECT r.run_id runId,r.verified verified,COALESCE(r.duration_ms,0) durationMs,(SELECT COUNT(*) FROM model_calls WHERE run_id=r.run_id OR run_id IN (SELECT run_id FROM runs WHERE parent_run_id=r.run_id)) modelCalls,(SELECT COUNT(*) FROM tool_calls WHERE run_id=r.run_id OR run_id IN (SELECT run_id FROM runs WHERE parent_run_id=r.run_id)) toolCalls,(SELECT COUNT(*) FROM errors WHERE run_id=r.run_id OR run_id IN (SELECT run_id FROM runs WHERE parent_run_id=r.run_id)) errors,COALESCE(t.total_tokens,0) totalTokens,COALESCE(t.cache_read_tokens,0) cachedInputTokens,MAX(0,COALESCE(t.input_tokens,0)-COALESCE(t.cache_read_tokens,0)) uncachedInputTokens,COALESCE(t.cache_savings_ratio,0) cacheSavingsRatio,COALESCE(t.cache_write_tokens,0) cacheWriteTokens,COALESCE(t.cache_read_tokens,0)-COALESCE(t.cache_write_tokens,0) netCacheSavings,COALESCE(t.total_cost,0) totalCost FROM runs r LEFT JOIN token_usage t ON t.run_id=r.run_id WHERE r.run_id=?`).get(runId) as Record<string, unknown> | undefined;
		if (!row) throw new Error(`Unknown run: ${runId}`);
		const verified = Boolean(row.verified);
		const verificationEvents = (this.#database.prepare("SELECT type,data_json data FROM events WHERE run_id=? AND type IN ('verification.completed','verification.failed') ORDER BY sequence").all(runId) as Array<{ type: string; data: string }>).map((event) => ({ ...event, data: parseJson(event.data) as Record<string, unknown> }));
		const attempt = (event: { data: Record<string, unknown> } | undefined): number => number(event?.data.attempt) ?? 0;
		const requirements = this.#database.prepare("SELECT COUNT(*) total,COALESCE(SUM(CASE WHEN passed=1 THEN 1 ELSE 0 END),0) passed FROM task_requirements WHERE run_id=? AND required=1").get(runId) as { total: number; passed: number };
		const verifiers = this.#database.prepare("SELECT COUNT(*) total,COALESCE(SUM(passed),0) passed FROM verifier_results WHERE run_id=?").get(runId) as { total: number; passed: number };
		const tools = this.#database.prepare("SELECT COUNT(*) total,COALESCE(SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END),0) passed,COALESCE(SUM(CASE WHEN decision='DENY' THEN 1 ELSE 0 END),0) denied,COALESCE(AVG(duration_ms),0) latency,COALESCE(SUM(output_bytes),0) outputBytes FROM tool_calls WHERE run_id=?").get(runId) as { total: number; passed: number; denied: number; latency: number; outputBytes: number };
		const duplicates = this.#database.prepare("SELECT COALESCE(SUM(count-1),0) duplicates FROM (SELECT COUNT(*) count FROM tool_calls WHERE run_id=? GROUP BY tool_id,arguments_json HAVING count>1)").get(runId) as { duplicates: number };
		const human = this.#database.prepare("SELECT COALESCE(SUM(minutes),0) minutes FROM human_reviews WHERE run_id=?").get(runId) as { minutes: number };
		const cache = this.#database.prepare("SELECT COUNT(*) invalidations FROM cache_events WHERE run_id=? AND type='cache.invalidated'").get(runId) as { invalidations: number };
		const lookups = this.#database.prepare("SELECT COUNT(*) total,COALESCE(SUM(CASE WHEN status!='invalidated' THEN 1 ELSE 0 END),0) survived FROM cache_events WHERE run_id=? AND type='cache.lookup'").get(runId) as { total: number; survived: number };
		const context = this.#database.prepare("SELECT COUNT(*) evidence,COALESCE(SUM(CASE WHEN asset_id IS NOT NULL AND version_id IS NOT NULL AND chunk_id IS NOT NULL AND content_hash IS NOT NULL THEN 1 ELSE 0 END),0) proven FROM retrieved_evidence WHERE run_id=?").get(runId) as { evidence: number; proven: number };
		const contextEvent = this.#database.prepare("SELECT data_json data FROM events WHERE run_id=? AND type='context.compiled' ORDER BY sequence DESC LIMIT 1").get(runId) as { data?: string } | undefined;
		const contextData = parseJson(contextEvent?.data) as Record<string, unknown> | undefined;
		const childUsage = this.#database.prepare("SELECT COALESCE(SUM(t.total_tokens),0) tokens FROM token_usage t JOIN runs r ON r.run_id=t.run_id WHERE r.parent_run_id=?").get(runId) as { tokens: number };
		const repairCalls = this.#database.prepare("SELECT usage_json usage FROM model_calls WHERE run_id=? AND attempt>0").all(runId) as Array<{ usage?: string }>;
		const repairTokens = repairCalls.reduce((sum, call) => sum + (number((parseJson(call.usage) as Record<string, unknown> | undefined)?.totalTokens) ?? 0), 0);
		const categories = Object.fromEntries((this.#database.prepare("SELECT type,COUNT(*) count FROM errors WHERE run_id=? GROUP BY type").all(runId) as Array<{ type: string; count: number }>).map(({ type, count }) => [type, count]));
		const first = verificationEvents.find((event) => attempt(event) === 0);
		const output = this.#database.prepare("SELECT output FROM runs WHERE run_id=?").get(runId) as { output: string };
		return {
			...(row as unknown as Omit<RunMetrics, "verified" | "costPerVerifiedSuccess" | "uncachedTokensPerVerifiedSuccess" | "firstPassVerified" | "repairAttempts" | "requirementCoverage" | "artifactValidity" | "toolSuccessRate" | "toolRetryRate" | "duplicateToolCallRate" | "averageToolLatencyMs" | "toolOutputBytes" | "permissionDenials" | "cacheInvalidations" | "prefixSurvivalRate" | "falseCompletion" | "humanCorrectionMinutes" | "stablePrefixTokens" | "loadedSkillTokens" | "retrievedContextTokens" | "toolResultTokens" | "parentTokens" | "childTokens" | "repairTokens" | "childTokensPercentage" | "evidenceItems" | "provenanceCoverage" | "errorCategories">),
			verified,
			costPerVerifiedSuccess: verified ? Number(row.totalCost) : null,
			uncachedTokensPerVerifiedSuccess: verified ? Number(row.uncachedInputTokens) : null,
			firstPassVerified: first?.type === "verification.completed",
			repairAttempts: Math.max(0, ...verificationEvents.map(attempt)),
			repair: repairMetrics(this.traceRecords(runId)),
			requirementCoverage: requirements.total ? requirements.passed / requirements.total : 1,
			artifactValidity: verifiers.total ? verifiers.passed / verifiers.total : 1,
			toolSuccessRate: tools.total ? tools.passed / tools.total : 1,
			toolRetryRate: tools.total ? duplicates.duplicates / tools.total : 0,
			duplicateToolCallRate: tools.total ? duplicates.duplicates / tools.total : 0,
			averageToolLatencyMs: tools.latency,
			toolOutputBytes: tools.outputBytes,
			permissionDenials: tools.denied,
			cacheInvalidations: cache.invalidations,
			prefixSurvivalRate: lookups.total ? lookups.survived / lookups.total : 1,
			falseCompletion: Boolean(output.output.trim()) && !verified,
			humanCorrectionMinutes: human.minutes,
			stablePrefixTokens: number(contextData?.stablePrefixTokens) ?? 0,
			loadedSkillTokens: number(contextData?.loadedSkillTokens) ?? 0,
			retrievedContextTokens: number(contextData?.retrievedContextTokens) ?? 0,
			toolResultTokens: Math.ceil(tools.outputBytes / 4),
			parentTokens: childUsage.tokens ? 0 : Number(row.totalTokens),
			childTokens: childUsage.tokens,
			repairTokens,
			childTokensPercentage: Number(row.totalTokens) ? childUsage.tokens / Number(row.totalTokens) : 0,
			evidenceItems: context.evidence,
			provenanceCoverage: context.evidence ? context.proven / context.evidence : 1,
			errorCategories: categories,
		};
	}

	summary(): EvaluationSummary {
		const row = this.#database.prepare(`SELECT COUNT(*) runs,COALESCE(SUM(verified),0) verifiedRuns,COALESCE(AVG(duration_ms),0) averageDurationMs,(SELECT COUNT(*) FROM model_calls) modelCalls,(SELECT COUNT(*) FROM tool_calls) toolCalls,(SELECT COUNT(*) FROM errors) errors,COALESCE((SELECT SUM(t.total_tokens) FROM token_usage t JOIN runs u ON u.run_id=t.run_id WHERE u.kind='agent'),0) totalTokens,COALESCE((SELECT SUM(t.cache_read_tokens) FROM token_usage t JOIN runs u ON u.run_id=t.run_id WHERE u.kind='agent'),0) cachedInputTokens,COALESCE((SELECT SUM(t.total_cost) FROM token_usage t JOIN runs u ON u.run_id=t.run_id WHERE u.kind='agent'),0) totalCost FROM runs`).get() as Record<string, number>;
		const runs = row.runs ?? 0;
		const verifiedRuns = row.verifiedRuns ?? 0;
		return {
			runs,
			verifiedRuns,
			verifiedRate: runs ? verifiedRuns / runs : 0,
			modelCalls: row.modelCalls ?? 0,
			toolCalls: row.toolCalls ?? 0,
			errors: row.errors ?? 0,
			totalTokens: row.totalTokens ?? 0,
			cachedInputTokens: row.cachedInputTokens ?? 0,
			totalCost: row.totalCost ?? 0,
			averageDurationMs: row.averageDurationMs ?? 0,
			costPerVerifiedSuccess: verifiedRuns ? (row.totalCost ?? 0) / verifiedRuns : null,
		};
	}

	runDetails(runId: string): StoredRunDetails {
		if (!/^[A-Za-z0-9-]{1,128}$/.test(runId)) throw new Error("Invalid run id");
		const row = this.#database.prepare("SELECT run_id runId,parent_run_id parentRunId,kind,status,verified,preset_id presetId,provider_id providerId,model_id modelId,started_at startedAt,completed_at completedAt,duration_ms durationMs,trace_path tracePath,output FROM runs WHERE run_id=?").get(runId) as Record<string, unknown> | undefined;
		if (!row) throw new Error(`Unknown run: ${runId}`);
		const task = this.#database.prepare("SELECT task_id taskId,objective,risk_class riskClass,artifact_types_json artifactTypes,domains_json domains FROM tasks WHERE run_id=?").get(runId) as Record<string, unknown> | undefined;
		if (task) {
			task.artifactTypes = parseJson(task.artifactTypes);
			task.domains = parseJson(task.domains);
			task.objective = redactAuditValue(task.objective);
		}
		const rows = (sql: string): Array<Record<string, unknown>> => this.#database.prepare(sql).all(runId) as Array<Record<string, unknown>>;
		const events = rows("SELECT event_id eventId,parent_event_id parentEventId,sequence,timestamp,type,data_json data FROM events WHERE run_id=? ORDER BY sequence LIMIT 2000").map((event) => ({ ...event, data: redactAuditValue(parseJson(event.data)) }));
		const toolCalls = rows("SELECT tool_call_id toolCallId,tool_id toolId,operation_id operationId,parse_status parseStatus,plan_reason planReason,backend,requested_at requestedAt,completed_at completedAt,decision,status,arguments_json arguments FROM tool_calls WHERE run_id=? ORDER BY requested_at").map((call) => ({ ...call, arguments: redactAuditValue(parseJson(call.arguments)) }));
		const artifacts = rows("SELECT artifact_id artifactId,type,path,content FROM artifacts WHERE run_id=? ORDER BY artifact_id").map(({ content, ...artifact }) => ({ ...artifact, contentPreview: redactAuditValue(typeof content === "string" ? content.slice(0, 2000) : content) }));
		return {
			run: { ...row, verified: Boolean(row.verified), output: redactAuditString(String(row.output ?? "")) } as unknown as StoredRunDetails["run"],
			metrics: this.metrics(runId),
			...(task ? { task } : {}),
			requirements: rows("SELECT requirement_id requirementId,description,required,passed FROM task_requirements WHERE run_id=? ORDER BY requirement_id").map((item) => ({ ...item, required: Boolean(item.required), passed: item.passed === null ? null : Boolean(item.passed) })),
			events,
			toolCalls,
			modelCalls: rows("SELECT provider_id providerId,model_id modelId,started_at startedAt,completed_at completedAt,first_token_ms firstTokenMs,status,usage_json usage FROM model_calls WHERE run_id=? ORDER BY started_at").map((call) => ({ ...call, usage: redactAuditValue(parseJson(call.usage)) })),
			errors: rows("SELECT type,message,timestamp,data_json data FROM errors WHERE run_id=? ORDER BY timestamp").map((item) => ({ ...item, message: redactAuditValue(item.message), data: redactAuditValue(parseJson(item.data)) })),
			artifacts,
			verifiers: rows("SELECT verifier_id verifierId,passed,message FROM verifier_results WHERE run_id=? ORDER BY verifier_id").map((item) => ({ ...item, passed: Boolean(item.passed), message: redactAuditValue(item.message) })),
			subagents: rows("SELECT child_id childId,child_run_id childRunId,status,preset_id presetId,error FROM subagent_runs WHERE parent_run_id=? ORDER BY child_id").map((item) => ({ ...item, error: redactAuditValue(item.error) })),
			skills: rows("SELECT skill_id skillId FROM skill_selections WHERE run_id=? ORDER BY skill_id").map(({ skillId }) => String(skillId)),
			humanReviews: rows("SELECT rating,minutes,notes,created_at createdAt FROM human_reviews WHERE run_id=? ORDER BY id").map((item) => ({ ...item, notes: redactAuditValue(item.notes) })),
		};
	}

	runFamily(runId: string): string[] {
		if (!this.#database.prepare("SELECT 1 FROM runs WHERE run_id=?").get(runId)) throw new Error(`Unknown run: ${runId}`);
		return [runId, ...(this.#database.prepare("SELECT run_id runId FROM runs WHERE parent_run_id=? ORDER BY child_id").all(runId) as Array<{ runId: string }>).map(({ runId: child }) => child)];
	}

	artifactRecords(runId: string): Array<{ artifactId: string; type: string; path?: string; content: string }> {
		return (this.#database.prepare("SELECT artifact_id artifactId,type,path,content FROM artifacts WHERE run_id=? ORDER BY artifact_id").all(runId) as Array<Record<string, unknown>>).map((row) => ({ artifactId: String(row.artifactId), type: String(row.type), ...(row.path ? { path: String(row.path) } : {}), content: String(redactAuditValue(row.content)) }));
	}

	traceRecords(runId: string): HarnessEvent[] {
		return (this.#database.prepare("SELECT event_id eventId,run_id runId,parent_event_id parentEventId,sequence,timestamp,type,data_json data FROM events WHERE run_id=? ORDER BY sequence").all(runId) as Array<Record<string, unknown>>).map((row) => ({
			eventId: String(row.eventId),
			runId: String(row.runId),
			...(row.parentEventId ? { parentEventId: String(row.parentEventId) } : {}),
			sequence: Number(row.sequence),
			timestamp: String(row.timestamp),
			type: String(row.type) as HarnessEvent["type"],
			data: redactAuditValue(parseJson(row.data)) as Record<string, unknown>,
		}));
	}

	async backupTo(path: string): Promise<void> {
		try {
			await lstat(path);
			throw new Error("Backup destination already exists");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		try {
			await backup(this.#database, path);
			sealStandaloneDatabase(path);
			await removeSqliteSidecars(path);
			await chmod(path, 0o600);
		} catch (error) {
			await unlink(path).catch(() => undefined);
			await removeSqliteSidecars(path).catch(() => undefined);
			throw error;
		}
	}

	pruneBefore(before: Date, keepAtLeast = 100): number {
		if (!Number.isFinite(before.getTime())) throw new Error("Retention cutoff is invalid");
		if (!Number.isInteger(keepAtLeast) || keepAtLeast < 0 || keepAtLeast > 100_000) throw new Error("keepAtLeast must be 0-100000");
		const roots = this.#database.prepare("SELECT run_id runId,trace_path tracePath,COALESCE(completed_at,created_at) completedAt FROM runs WHERE parent_run_id IS NULL ORDER BY COALESCE(completed_at,created_at) DESC").all() as Array<{ runId: string; tracePath: string; completedAt: string }>;
		const candidateRoots = roots.slice(keepAtLeast).filter(({ completedAt }) => completedAt < before.toISOString());
		const candidates = candidateRoots.flatMap((root) => [root, ...(this.#database.prepare("SELECT run_id runId,trace_path tracePath FROM runs WHERE parent_run_id=? ORDER BY child_id").all(root.runId) as Array<{ runId: string; tracePath: string }>)]);
		this.#database.exec("BEGIN IMMEDIATE");
		try {
			const remove = this.#database.prepare("DELETE FROM runs WHERE run_id=?");
			const detachBenchmark = this.#database.prepare("UPDATE benchmark_runs SET run_id=NULL,error=COALESCE(error,'run pruned') WHERE run_id=?");
			for (const { runId } of candidates) detachBenchmark.run(runId);
			for (const { runId } of [...candidates].reverse()) remove.run(runId);
			this.#database.exec("COMMIT");
			for (const { runId, tracePath } of candidates) {
				if (!/^[A-Za-z0-9-]{1,128}$/.test(runId)) continue;
				const directory = join(this.#runDirectory, runId);
				if (basename(tracePath) !== "trace.jsonl") continue;
				try {
					const rootInfo = lstatSync(this.#runDirectory);
					const directoryInfo = lstatSync(directory);
					if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) continue;
					if (realpathSync(dirname(resolve(tracePath))) !== directory) continue;
				} catch { continue; }
				for (const name of ["trace.jsonl", "result.json", "orchestration-result.json", "checkpoint.json"]) {
					try { unlinkSync(join(directory, name)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") break; }
				}
				try { rmdirSync(directory); } catch { /* Preserve non-empty or concurrently used run directories. */ }
			}
			this.#database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			return candidates.length;
		} catch (error) {
			this.#database.exec("ROLLBACK");
			throw error;
		}
	}

	addHumanReview(runId: string, review: { rating?: number; minutes?: number; notes?: string }): void {
		if (!this.#database.prepare("SELECT 1 FROM runs WHERE run_id=?").get(runId)) throw new Error(`Unknown run: ${runId}`);
		if (review.rating !== undefined && (!Number.isInteger(review.rating) || review.rating < 1 || review.rating > 5)) throw new Error("Human review rating must be 1-5");
		if (review.minutes !== undefined && (!Number.isFinite(review.minutes) || review.minutes < 0)) throw new Error("Human review minutes must be non-negative");
		this.#database.prepare("INSERT INTO human_reviews(run_id,rating,minutes,notes) VALUES(?,?,?,?)").run(runId, review.rating ?? null, review.minutes ?? null, review.notes ? redactAuditString(review.notes) : null);
	}

	recordBenchmark(benchmarkId: string, variant: string, runId?: string, error?: string): void {
		if (!/^[A-Za-z0-9._:-]{1,160}$/.test(benchmarkId) || !/^[A-Z_]{1,80}$/.test(variant)) throw new Error("Invalid benchmark identity");
		this.#database.prepare("INSERT INTO benchmark_runs(benchmark_id,variant,run_id,error,created_at) VALUES(?,?,?,?,?) ON CONFLICT(benchmark_id,variant) DO UPDATE SET run_id=excluded.run_id,error=excluded.error,created_at=excluded.created_at").run(benchmarkId, variant, runId ?? null, error ? redactAuditString(error) : null, new Date().toISOString());
	}

	benchmarkRuns(benchmarkId: string): StoredBenchmarkRun[] {
		return this.#database.prepare("SELECT benchmark_id benchmarkId,variant,run_id runId,error,created_at createdAt FROM benchmark_runs WHERE benchmark_id=? ORDER BY variant").all(benchmarkId) as unknown as StoredBenchmarkRun[];
	}

	benchmarkReports(): StoredBenchmarkReport[] {
		const ids = this.#database.prepare("SELECT DISTINCT benchmark_id benchmarkId FROM benchmark_runs ORDER BY benchmark_id").all() as Array<{ benchmarkId: string }>;
		return ids.map(({ benchmarkId }) => {
			const variants = this.benchmarkRuns(benchmarkId).map((variant) => ({
				...variant,
				...(variant.runId ? { metrics: this.metrics(variant.runId) } : {}),
			}));
			const raw = variants.find(({ variant }) => variant === "RAW_MODEL")?.metrics;
			const full = variants.find(({ variant }) => variant === "FULL_PRESET")?.metrics;
			return {
				benchmarkId,
				variants,
				...(raw && full ? {
					verifiedSuccessDelta: Number(full.verified) - Number(raw.verified),
					latencyDeltaMs: full.durationMs - raw.durationMs,
					costDelta: full.totalCost - raw.totalCost,
				} : {}),
			};
		});
	}

	#upsertRun(run: { runId: string; parentRunId?: string; childId?: string; kind: string; status: string; verified: boolean; presetId?: string; providerId?: string; modelId?: string; startedAt?: string; completedAt?: string; durationMs?: number; tracePath: string; output: string }): void {
		this.#database.prepare(`INSERT INTO runs(run_id,parent_run_id,child_id,kind,status,verified,preset_id,provider_id,model_id,started_at,completed_at,duration_ms,trace_path,output,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET parent_run_id=excluded.parent_run_id,child_id=excluded.child_id,kind=excluded.kind,status=excluded.status,verified=excluded.verified,preset_id=excluded.preset_id,provider_id=excluded.provider_id,model_id=excluded.model_id,started_at=excluded.started_at,completed_at=excluded.completed_at,duration_ms=excluded.duration_ms,trace_path=excluded.trace_path,output=excluded.output`).run(run.runId, run.parentRunId ?? null, run.childId ?? null, run.kind, run.status, run.verified ? 1 : 0, run.presetId ?? null, run.providerId ?? null, run.modelId ?? null, run.startedAt ?? null, run.completedAt ?? null, run.durationMs ?? null, run.tracePath, run.output, new Date().toISOString());
	}

	#clearDetails(runId: string): void {
		for (const table of ["events", "tasks", "task_requirements", "model_calls", "token_usage", "cache_events", "tool_calls", "errors", "subagent_runs", "context_packets", "retrieved_evidence", "skill_selections", "artifacts", "verifier_results"]) this.#database.prepare(`DELETE FROM ${table} WHERE ${table === "subagent_runs" ? "parent_run_id" : "run_id"}=?`).run(runId);
	}

	#insertEvents(runId: string, events: HarnessEvent[]): void {
		const insert = this.#database.prepare("INSERT INTO events(event_id,run_id,parent_event_id,sequence,timestamp,type,data_json) VALUES(?,?,?,?,?,?,?)");
		for (const event of events) {
			if (event.runId !== runId) throw new Error("Trace event run id does not match the stored run");
			insert.run(event.eventId, runId, event.parentEventId ?? null, event.sequence, event.timestamp, event.type, JSON.stringify(event.data));
		}
	}

	#insertModelCalls(runId: string, events: HarnessEvent[]): void {
		const insert = this.#database.prepare("INSERT INTO model_calls(event_id,run_id,parent_event_id,provider_id,model_id,started_at,completed_at,first_token_ms,status,usage_json,attempt) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
		for (const start of events.filter(({ type }) => type === "model.request.started")) {
			const related = events.filter(({ parentEventId }) => parentEventId === start.eventId);
			const terminal = related.find(({ type }) => type === "model.request.completed" || type === "model.request.failed");
			const firstToken = related.find(({ type }) => type === "model.first_token");
			insert.run(start.eventId, runId, start.parentEventId ?? null, text(start.data.provider), text(start.data.model), start.timestamp, terminal?.timestamp ?? null, number(firstToken?.data.latencyMs), terminal?.type === "model.request.failed" ? "failed" : terminal ? "completed" : "started", terminal?.data.usage ? JSON.stringify(terminal.data.usage) : null, number(start.data.attempt) ?? 0);
		}
	}

	#insertToolCalls(runId: string, events: HarnessEvent[]): void {
		const insert = this.#database.prepare("INSERT INTO tool_calls(tool_call_id,run_id,tool_id,requested_at,completed_at,decision,status,arguments_json,duration_ms,output_bytes,operation_id,parse_status,plan_reason,backend) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
		for (const requested of events.filter(({ type }) => type === "tool.requested")) {
			const callId = text(requested.data.toolCallId);
			const toolId = text(requested.data.toolId);
			if (!callId || !toolId) continue;
			const related = events.filter((event) => event.data.toolCallId === callId);
			const permission = related.find(({ type }) => type === "tool.allowed" || type === "tool.denied");
			const terminal = related.findLast(({ type }) => type === "tool.completed" || type === "tool.failed" || type === "tool.denied");
			insert.run(callId, runId, toolId, requested.timestamp, terminal?.timestamp ?? null, text(permission?.data.decision), terminal?.type === "tool.failed" || terminal?.type === "tool.denied" ? "failed" : terminal ? "completed" : related.some(({ type }) => type === "tool.started") ? "effects-unknown" : "requested", JSON.stringify(requested.data.arguments ?? {}), number(terminal?.data.durationMs), number(terminal?.data.outputBytes), text(terminal?.data.operationId) ?? text(requested.data.operationId), text(requested.data.parseStatus), text(requested.data.planReason), text(terminal?.data.backend));
		}
	}

	#insertCacheAndErrors(runId: string, events: HarnessEvent[]): void {
		const cache = this.#database.prepare("INSERT INTO cache_events(event_id,run_id,type,status,cache_prefix_hash,changed_json,tokens,timestamp) VALUES(?,?,?,?,?,?,?,?)");
		const error = this.#database.prepare("INSERT INTO errors(error_id,run_id,type,message,timestamp,data_json) VALUES(?,?,?,?,?,?)");
		for (const event of events) {
			if (event.type.startsWith("cache.")) cache.run(event.eventId, runId, event.type, text(event.data.status), text(event.data.cachePrefixHash), event.data.changed ? JSON.stringify(event.data.changed) : null, number(event.data.tokens), event.timestamp);
			if (event.type.endsWith(".failed")) error.run(event.eventId, runId, event.type, text(event.data.message), event.timestamp, JSON.stringify(event.data));
		}
	}

	#insertContext(runId: string, packet: ContextPacket): void {
		this.#database.prepare("INSERT INTO context_packets(run_id,context_hash,token_budget,estimated_tokens,source_versions_json,provenance_json) VALUES(?,?,?,?,?,?)").run(runId, packet.contextHash, packet.tokenBudget, packet.estimatedTokens, JSON.stringify(packet.sourceVersions), JSON.stringify(packet.provenance));
		const insert = this.#database.prepare("INSERT INTO retrieved_evidence(run_id,evidence_index,asset_id,version_id,chunk_id,path,page_number,content_hash,score,content) VALUES(?,?,?,?,?,?,?,?,?,?)");
		packet.evidence.forEach((raw, index) => {
			const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
			insert.run(runId, index, text(item.assetId), text(item.versionId), text(item.chunkId), text(item.path), number(item.pageNumber), text(item.contentHash), number(item.score), text(item.content));
		});
	}
}

export async function restoreEvaluationBackup(
	backupPath: string,
	databasePath: string,
	options: { replace?: boolean } = {},
): Promise<EvaluationRestoreResult> {
	const source = resolve(backupPath);
	const destination = resolve(databasePath);
	if (source === destination) throw new Error("Backup and destination must be different files");
	await assertStandaloneDatabase(source, "Backup");
	await mkdir(dirname(destination), { recursive: true, mode: 0o700 });

	let destinationExists = false;
	try {
		await assertStandaloneDatabase(destination, "Evaluation database");
		destinationExists = true;
	} catch (error) {
		if (!isMissing(error)) throw error;
	}
	if (destinationExists && !options.replace) {
		throw new Error("Evaluation database already exists; pass --replace to preserve it and restore the backup");
	}

	const temporary = join(dirname(destination), `.${basename(destination)}.restore-${randomUUID()}.tmp`);
	let recoveryPath: string | undefined;
	const backupDatabase = new DatabaseSync(source, { readOnly: true });
	try {
		if (!databaseIsHealthy(backupDatabase)) throw new Error("Backup database failed SQLite integrity checking");
		await backup(backupDatabase, temporary);
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		throw error;
	} finally {
		backupDatabase.close();
	}

	try {
		const restored = new EvaluationStore(temporary);
		restored.close();
		sealStandaloneDatabase(temporary);
		await removeSqliteSidecars(temporary);
		const validation = new DatabaseSync(temporary, { readOnly: true });
		try {
			if (!databaseIsHealthy(validation)) throw new Error("Restored database failed SQLite integrity checking");
		} finally {
			validation.close();
		}

		if (destinationExists) {
			const current = new DatabaseSync(destination);
			try {
				current.exec("PRAGMA wal_checkpoint(TRUNCATE)");
				current.prepare("PRAGMA journal_mode=DELETE").get();
				recoveryPath = `${destination}.before-restore-${Date.now()}-${randomUUID()}.sqlite`;
				await backup(current, recoveryPath);
				await chmod(recoveryPath, 0o600);
			} finally {
				current.close();
			}
			sealStandaloneDatabase(recoveryPath!);
			await removeSqliteSidecars(recoveryPath!);
			await removeSqliteSidecars(destination);
			const retired = `${destination}.replacing-${randomUUID()}`;
			await rename(destination, retired);
			try {
				await rename(temporary, destination);
			} catch (error) {
				await rename(retired, destination).catch(() => undefined);
				throw error;
			}
			await unlink(retired);
		} else {
			await rename(temporary, destination);
		}
		await chmod(destination, 0o600);
		return { databasePath: destination, ...(recoveryPath ? { recoveryPath } : {}) };
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		await removeSqliteSidecars(temporary).catch(() => undefined);
		throw error;
	}
}
