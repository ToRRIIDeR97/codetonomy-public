import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, glob, lstat, readlink, symlink, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_CHECKPOINT_BYTES = 256 * 1024 * 1024;
const MAX_CHECKPOINT_FILES = 20_000;
// ponytail: command rewind remains a bounded full-workspace snapshot; content-addressed chunk storage can wait until evidence shows this 20k-file boundary is insufficient.
const CHECKPOINT_EXCLUDES = ["**/.git/**", "**/.agents/**", "**/.codex/**", "**/.codetonomy/**", "**/.harness/**", "**/.pnpm-store/**", "**/.reference-repos/**", "**/dist/**", "**/node_modules/**"];

interface FileState {
	existed: boolean;
	mode?: number;
	sha256?: string;
	content?: string;
	kind?: "file" | "symlink";
	link?: string;
	identity?: string;
}

interface FileSnapshot extends FileState {
	path: string;
	after?: Omit<FileState, "content">;
}

interface CheckpointFile {
	version: 1;
	workspace: string;
	runId: string;
	createdAt: number;
	files: FileSnapshot[];
	coverageFailures?: Array<{ path: string; reason: string }>;
	commandScope?: boolean;
}

export interface RewindResult {
	restored: string[];
	deleted: string[];
	coverage?: "captured" | "incomplete";
	residual?: string[];
}

export interface CheckpointPreview {
	files: string[];
	diff: string;
}

const hash = (content: Buffer): string => createHash("sha256").update(content).digest("hex");

async function loadCheckpoint(checkpointPath: string, workspaceRoot: string): Promise<{ workspace: string; files: FileSnapshot[]; coverageFailures: Array<{ path: string; reason: string }> }> {
	const handle = await open(checkpointPath, constants.O_RDONLY | constants.O_NOFOLLOW);
	let raw: Buffer;
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.nlink !== 1) throw new Error("Checkpoint is not a regular standalone file");
		if (info.size > MAX_CHECKPOINT_BYTES) throw new Error(`Checkpoint exceeds ${MAX_CHECKPOINT_BYTES} bytes`);
		raw = Buffer.alloc(info.size + 1);
		let length = 0;
		while (length < raw.length) {
			const { bytesRead } = await handle.read(raw, length, raw.length - length, length);
			if (!bytesRead) break;
			length += bytesRead;
		}
		if (length > MAX_CHECKPOINT_BYTES) throw new Error(`Checkpoint exceeds ${MAX_CHECKPOINT_BYTES} bytes`);
		raw = raw.subarray(0, length);
	} finally {
		await handle.close();
	}
	const parsed = JSON.parse(raw.toString("utf8")) as Partial<CheckpointFile>;
	const workspace = await realpath(workspaceRoot);
	if (parsed.version !== 1 || parsed.workspace !== workspace || !Array.isArray(parsed.files) || parsed.files.length > MAX_CHECKPOINT_FILES) {
		throw new Error("Invalid checkpoint");
	}
	return { workspace, files: parsed.files as FileSnapshot[], coverageFailures: [...(parsed.coverageFailures ?? []), ...(parsed.commandScope ? [{ path: "<command effects outside snapshot scope>", reason: "Excluded trees and external command effects are not captured" }] : [])] };
}

async function safeTarget(workspace: string, requestedPath: string): Promise<{ root: string; target: string; path: string }> {
	const root = await realpath(workspace);
	const target = resolve(root, requestedPath);
	const path = relative(root, target);
	if (!path || path.startsWith("..") || isAbsolute(path)) throw new Error("Checkpoint path is outside the workspace");
	let ancestor = dirname(target);
	for (;;) {
		try {
			const realAncestor = await realpath(ancestor);
			if (realAncestor !== ancestor) throw new Error("Checkpoint parent path changed through a symlink");
			const rel = relative(root, realAncestor);
			if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("Checkpoint path resolves outside the workspace");
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			const parent = dirname(ancestor);
			if (parent === ancestor) throw new Error("Checkpoint path has no workspace ancestor");
			ancestor = parent;
		}
	}
	return { root, target, path };
}

async function readState(workspace: string, path: string, includeContent: boolean, previous?: FileState): Promise<FileState> {
	const safe = await safeTarget(workspace, path);
	let handle;
	try {
		const info = await lstat(safe.target);
		if (!includeContent && info.isFile() && info.nlink === 1 && previous?.identity === `${info.dev}:${info.ino}:${info.ctimeMs}:${info.mtimeMs}`) {
			const { content: _content, ...state } = previous;
			return state;
		}
		if (info.isSymbolicLink()) return { existed: true, kind: "symlink", identity: `${info.dev}:${info.ino}:${info.ctimeMs}:${info.mtimeMs}`, link: await readlink(safe.target) };
		handle = await open(safe.target, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { existed: false };
		throw error;
	}
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.nlink !== 1) throw new Error(`Checkpoint target is not a regular standalone file: ${path}`);
		if (info.size > MAX_FILE_BYTES) {
			if (includeContent) throw new Error(`Checkpoint target exceeds ${MAX_FILE_BYTES} bytes: ${path}`);
			const digest = createHash("sha256");
			const buffer = Buffer.alloc(64 * 1024);
			let remaining = info.size;
			while (remaining > 0) {
				const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, remaining), null);
				if (!bytesRead) break;
				remaining -= bytesRead;
				digest.update(buffer.subarray(0, bytesRead));
			}
			const current = await handle.stat();
			if (remaining || current.size !== info.size || current.ctimeMs !== info.ctimeMs) throw new Error(`Checkpoint target changed during capture: ${path}`);
			return { existed: true, identity: `${info.dev}:${info.ino}:${info.ctimeMs}:${info.mtimeMs}`, mode: info.mode & 0o777, sha256: digest.digest("hex") };
		}
		const content = Buffer.alloc(info.size + 1);
		let length = 0;
		while (length < content.length) {
			const { bytesRead } = await handle.read(content, length, content.length - length, length);
			if (!bytesRead) break;
			length += bytesRead;
		}
		if (length > MAX_FILE_BYTES) throw new Error(`Checkpoint target exceeds ${MAX_FILE_BYTES} bytes: ${path}`);
		const exact = content.subarray(0, length);
		return {
			existed: true,
			identity: `${info.dev}:${info.ino}:${info.ctimeMs}:${info.mtimeMs}`,
			mode: info.mode & 0o777,
			sha256: hash(exact),
			...(includeContent ? { content: exact.toString("base64") } : {}),
		};
	} finally {
		await handle.close();
	}
}

export async function writeRuntimeFileAtomically(path: string, content: Buffer | string, mode = 0o600): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
	let handle;
	try {
		handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
		await handle.writeFile(content);
		await handle.sync();
		await handle.close();
		handle = undefined;
		await rename(temporary, path);
		await chmod(path, mode);
	} catch (error) {
		await handle?.close().catch(() => undefined);
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
}

export class RunCheckpoint {
	readonly #file: CheckpointFile;
	readonly #path: string;
	readonly #byPath = new Map<string, FileSnapshot>();
	#workspaceBefore?: Map<string, FileState>;
	#workspaceSnapshotStart = 0;

	constructor(workspace: string, runId: string, path: string) {
		this.#file = { version: 1, workspace, runId, createdAt: Date.now(), files: [] };
		this.#path = path;
	}

	get path(): string | undefined {
		return this.#file.commandScope || this.#file.files.length || this.#file.coverageFailures?.length ? this.#path : undefined;
	}

	coverage(): "captured" | "incomplete" { return this.#file.commandScope || this.#file.coverageFailures?.length ? "incomplete" : "captured"; }

	async #captureFailure(path: string, error: unknown): Promise<void> {
		(this.#file.coverageFailures ??= []).push({ path, reason: error instanceof Error ? error.message.slice(0, 300) : "Capture failed" });
		await this.#persist();
	}

	async before(path: string): Promise<void> {
		if (this.#byPath.has(path)) return;
		const workspace = await realpath(this.#file.workspace);
		this.#file.workspace = workspace;
		this.#workspaceSnapshotStart = this.#file.files.length;
		const snapshot = { path, ...(await readState(workspace, path, true)) };
		this.#file.files.push(snapshot);
		this.#byPath.set(path, snapshot);
		await this.#persist();
	}

	async after(path: string): Promise<void> {
		const snapshot = this.#byPath.get(path);
		if (!snapshot) throw new Error(`Checkpoint preimage is missing for ${path}`);
		try { snapshot.after = await readState(this.#file.workspace, path, false); }
		catch (error) { await this.#captureFailure(path, error); }
		await this.#persist();
	}

	async beforeWorkspace(): Promise<void> {
		if (this.#workspaceBefore) throw new Error("A workspace command checkpoint is already active");
		const workspace = await realpath(this.#file.workspace);
		this.#file.workspace = workspace;
		this.#workspaceSnapshotStart = this.#file.files.length;
		const paths = new Map<string, FileState>();
		for await (const entry of glob("**/*", { cwd: workspace, withFileTypes: true, exclude: CHECKPOINT_EXCLUDES })) {
			if (!entry.isFile() && !entry.isSymbolicLink()) continue;
			const path = relative(workspace, resolve(entry.parentPath, entry.name));
			paths.set(path, { existed: true });
			if (paths.size > MAX_CHECKPOINT_FILES) throw new Error(`Workspace command checkpoint exceeds ${MAX_CHECKPOINT_FILES} files`);
			try {
				let snapshot = this.#byPath.get(path);
				const state = await readState(workspace, path, !snapshot, snapshot?.after);
				paths.set(path, state);
				if (!snapshot) {
					snapshot = { path, ...state };
					this.#file.files.push(snapshot);
					this.#byPath.set(path, snapshot);
				}
			} catch (error) { await this.#captureFailure(path, error); }
		}
		this.#file.commandScope = true;
		this.#workspaceBefore = paths;
		await this.#persist();
	}

	async afterWorkspace(): Promise<string[]> {
		const before = this.#workspaceBefore;
		if (!before) throw new Error("Workspace command checkpoint was not started");
		const changed: string[] = [];
		try {
			const after = new Set<string>();
			for await (const entry of glob("**/*", { cwd: this.#file.workspace, withFileTypes: true, exclude: CHECKPOINT_EXCLUDES })) {
				if (!entry.isFile() && !entry.isSymbolicLink()) continue;
				const path = relative(this.#file.workspace, resolve(entry.parentPath, entry.name));
				after.add(path);
				if (!this.#byPath.has(path) && !before.has(path)) {
					if (this.#file.files.length === MAX_CHECKPOINT_FILES) throw new Error(`Workspace command checkpoint exceeds ${MAX_CHECKPOINT_FILES} files`);
					const snapshot = { path, existed: false };
					this.#file.files.push(snapshot);
					this.#byPath.set(path, snapshot);
				}
			}
			for (const path of new Set([...before.keys(), ...after])) {
				const snapshot = this.#byPath.get(path);
				if (snapshot) {
					try {
						snapshot.after = await readState(this.#file.workspace, path, false, before.get(path));
						const previous = before.get(path);
						if ((!before.has(path) || previous?.sha256 || previous?.kind === "symlink" || previous?.existed === false)
							&& !sameContent(previous ?? { existed: false }, snapshot.after)) changed.push(path);
					}
					catch (error) { await this.#captureFailure(path, error); }
				}
			}
			this.#file.files = this.#file.files.filter((snapshot, index) => index < this.#workspaceSnapshotStart || !snapshot.after || !sameState(snapshot, snapshot.after));
			this.#byPath.clear();
			for (const snapshot of this.#file.files) this.#byPath.set(snapshot.path, snapshot);
		} catch (error) {
			await this.#captureFailure("<workspace>", error);
		}
		this.#workspaceBefore = undefined;
		await this.#persist();
		return changed;
	}

	async #persist(): Promise<void> {
		const text = `${JSON.stringify(this.#file, null, 2)}\n`;
		if (Buffer.byteLength(text) > MAX_CHECKPOINT_BYTES) throw new Error(`Checkpoint exceeds ${MAX_CHECKPOINT_BYTES} bytes`);
		await writeRuntimeFileAtomically(this.#path, text);
	}
}

const sameContent = (left: FileState, right: FileState): boolean =>
	left.existed === right.existed && (!left.existed || (left.kind === right.kind && left.link === right.link && left.sha256 === right.sha256 && left.mode === right.mode));
const sameState = (left: FileState, right: FileState): boolean =>
	sameContent(left, right) && (!left.existed || !left.identity || !right.identity || left.identity === right.identity);

export async function rewindCheckpoint(checkpointPath: string, workspaceRoot: string): Promise<RewindResult> {
	const { workspace, files, coverageFailures } = await loadCheckpoint(checkpointPath, workspaceRoot);
	const prepared: Array<{ snapshot: FileSnapshot; target: string; staged?: string; backup: string }> = [];
	for (const snapshot of files) {
		if (!snapshot.after && coverageFailures.some(({ path }) => path === snapshot.path)) continue;
		if (!snapshot.after && coverageFailures.some(({ path }) => path === snapshot.path)) continue;
		if (!snapshot || typeof snapshot.path !== "string" || typeof snapshot.existed !== "boolean" || !snapshot.after) {
			throw new Error("Invalid checkpoint file entry");
		}
		const safe = await safeTarget(workspace, snapshot.path);
		const current = await readState(workspace, snapshot.path, false);
		if (!sameState(current, snapshot.after)) throw new Error(`Cannot rewind ${snapshot.path}: file changed after Codetonomy's edit`);
		const backup = join(dirname(safe.target), `.${basename(safe.target)}.${randomUUID()}.rewind-backup`);
		let staged: string | undefined;
		if (snapshot.existed && snapshot.kind === "symlink") {
			if (typeof snapshot.link !== "string") throw new Error("Invalid symlink preimage");
			await mkdir(dirname(safe.target), { recursive: true });
			staged = join(dirname(safe.target), `.${basename(safe.target)}.${randomUUID()}.rewind-stage`);
			await symlink(snapshot.link, staged);
		} else if (snapshot.existed) {
			if (typeof snapshot.content !== "string" || typeof snapshot.sha256 !== "string" || typeof snapshot.mode !== "number") {
				throw new Error(`Invalid checkpoint preimage for ${snapshot.path}`);
			}
			const content = Buffer.from(snapshot.content, "base64");
			if (content.length > MAX_FILE_BYTES || hash(content) !== snapshot.sha256) throw new Error(`Checkpoint preimage hash mismatch for ${snapshot.path}`);
			await mkdir(dirname(safe.target), { recursive: true });
			staged = join(dirname(safe.target), `.${basename(safe.target)}.${randomUUID()}.rewind-stage`);
			await writeRuntimeFileAtomically(staged, content, snapshot.mode);
		}
		prepared.push({ snapshot, target: safe.target, ...(staged ? { staged } : {}), backup });
	}

	const published: typeof prepared = [];
	try {
		for (const item of prepared) {
			const current = await readState(workspace, item.snapshot.path, false);
			if (!sameState(current, item.snapshot.after!)) throw new Error(`Cannot rewind ${item.snapshot.path}: file changed during rewind`);
			if (current.existed) await rename(item.target, item.backup);
			published.push(item);
			if (item.staged) await rename(item.staged, item.target);
		}
	} catch (error) {
		for (const item of [...published].reverse()) {
			await unlink(item.target).catch(() => undefined);
			await rename(item.backup, item.target).catch(() => undefined);
		}
		for (const item of prepared) if (item.staged) await unlink(item.staged).catch(() => undefined);
		throw error;
	}
	for (const item of published) await unlink(item.backup).catch(() => undefined);
	return {
		coverage: coverageFailures.length ? "incomplete" : "captured",
		residual: coverageFailures.map(({ path }) => path),
		restored: prepared.map(({ snapshot }) => snapshot).filter(({ existed }) => existed).map(({ path }) => path),
		deleted: prepared.map(({ snapshot }) => snapshot).filter(({ existed }) => !existed).map(({ path }) => path),
	};
}

const textContent = (state: FileState): string => {
	if (!state.existed) return "";
	if (state.kind === "symlink") return `symlink -> ${state.link}`;
	if (typeof state.content !== "string") throw new Error("Checkpoint content is missing");
	return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(state.content, "base64"));
};

export async function previewCheckpoint(checkpointPath: string, workspaceRoot: string): Promise<CheckpointPreview> {
	const { workspace, files, coverageFailures } = await loadCheckpoint(checkpointPath, workspaceRoot);
	const sections: string[] = coverageFailures.map(({ path, reason }) => `Incomplete rewind coverage: ${path}: ${reason}`);
	for (const snapshot of files) {
		if (!snapshot || typeof snapshot.path !== "string" || typeof snapshot.existed !== "boolean" || !snapshot.after) {
			throw new Error("Invalid checkpoint file entry");
		}
		const current = await readState(workspace, snapshot.path, true);
		const status = sameState(current, snapshot.after) ? "" : " (changed since run)";
		let before: string;
		let after: string;
		try {
			before = textContent(snapshot);
			after = textContent(current);
		} catch {
			sections.push(`--- ${snapshot.path}\n+++ ${snapshot.path}${status}\n[Binary content omitted]`);
			continue;
		}
		const removed = before.split("\n").map((line) => `-${line}`).join("\n");
		const added = after.split("\n").map((line) => `+${line}`).join("\n");
		sections.push(`--- a/${snapshot.path}\n+++ b/${snapshot.path}${status}\n@@\n${removed}\n${added}`);
	}
	const raw = sections.join("\n\n") || "No file changes were captured";
	const bytes = Buffer.from(raw);
	const diff = bytes.length <= 64 * 1024
		? raw
		: `${bytes.subarray(0, 64 * 1024).toString("utf8")}\n[Diff truncated]`;
	return { files: files.map(({ path }) => path), diff };
}
