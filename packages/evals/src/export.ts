import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { EvaluationStore } from "./store.js";

const MAX_SOURCE_BYTES = 64 * 1024 * 1024;

export interface RunExportResult {
	path: string;
	files: number;
	runIds: string[];
}

const safeName = (value: string): string => value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180) || "artifact";

async function readBounded(path: string, maximum = MAX_SOURCE_BYTES): Promise<Buffer> {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.nlink !== 1) throw new Error("Export source must be a regular standalone file");
		if (info.size > maximum) throw new Error(`Export source exceeds ${Math.floor(maximum / 1024 / 1024)} MiB`);
		const data = Buffer.alloc(info.size + 1);
		let length = 0;
		while (length < data.length) {
			const { bytesRead } = await handle.read(data, length, data.length - length, length);
			if (!bytesRead) break;
			length += bytesRead;
		}
		if (length > maximum) throw new Error("Export source grew beyond its limit");
		return data.subarray(0, length);
	} finally {
		await handle.close();
	}
}

async function writePrivate(path: string, data: string | Buffer): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
	try {
		await handle.writeFile(data);
		await handle.sync();
	} finally {
		await handle.close();
	}
}

const digest = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

export async function exportRunBundle(
	store: EvaluationStore,
	runId: string,
	destination: string,
	options: { referencesLockPath?: string; workspaceRoot?: string } = {},
): Promise<RunExportResult> {
	const requested = resolve(destination);
	try {
		await lstat(requested);
		throw new Error("Export destination already exists");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await mkdir(dirname(requested), { recursive: true, mode: 0o700 });
	const parent = await realpath(dirname(requested));
	const target = join(parent, basename(requested));
	const temporary = join(parent, `.${basename(requested)}.codetonomy-${randomUUID()}.tmp`);
	await mkdir(temporary, { mode: 0o700 });
	const files: Array<{ path: string; sha256: string; bytes: number }> = [];
	const add = async (relativePath: string, data: string | Buffer) => {
		await writePrivate(join(temporary, relativePath), data);
		files.push({ path: relativePath, sha256: digest(data), bytes: Buffer.byteLength(data) });
	};
	try {
		const runIds = store.runFamily(runId);
		for (const memberId of runIds) {
			const details = store.runDetails(memberId);
			await add(`runs/${memberId}/record.json`, `${JSON.stringify(details, null, 2)}\n`);
			const trace = store.traceRecords(memberId).map((event) => JSON.stringify(event)).join("\n");
			await add(`runs/${memberId}/trace.jsonl`, `${trace}${trace ? "\n" : ""}`);
			for (const artifact of store.artifactRecords(memberId)) {
				const stem = `${safeName(artifact.artifactId)}-${safeName(artifact.path ? basename(artifact.path) : artifact.type)}`;
				if (artifact.path && options.workspaceRoot) {
					try {
						const root = await realpath(options.workspaceRoot);
						const path = await realpath(artifact.path);
						const inside = relative(root, path);
						if (inside.startsWith("..") || isAbsolute(inside)) throw new Error("Artifact path is outside the export workspace");
						const bytes = await readBounded(path, 50 * 1024 * 1024);
						await add(`runs/${memberId}/artifacts/${stem}`, bytes);
						continue;
					} catch { /* Restored or stale paths fall back to the redacted database record. */ }
				}
				await add(`runs/${memberId}/artifacts/${stem}.${artifact.type === "json" ? "json" : "txt"}`, `${artifact.content}\n`);
			}
		}
		if (options.referencesLockPath) {
			const lock = await readBounded(options.referencesLockPath, 1024 * 1024);
			await add("references.lock.yaml", lock);
		}
		const manifest = {
			schemaVersion: 1,
			repairAttribution: "causal-v1 when present; legacy attribution unknown",
			rootRunId: runId,
			runIds,
			exportedAt: new Date().toISOString(),
			redaction: "credentials and mutable file contents removed from audit records",
			files: [...files].sort((left, right) => left.path.localeCompare(right.path)),
		};
		await add("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
		await rename(temporary, target);
		await chmod(target, 0o700);
		return { path: target, files: files.length, runIds };
	} catch (error) {
		await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
}
