import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isSensitiveWorkspacePath, type DocumentIR, type OcrRequest, type OcrService } from "@agent-harness/contracts";

const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
const MAX_TEXT_BYTES = 20 * 1024 * 1024;
const OCR_MEDIA_TYPES = new Map([
	[".bmp", "image/bmp"],
	[".jpeg", "image/jpeg"],
	[".jpg", "image/jpeg"],
	[".pdf", "application/pdf"],
	[".png", "image/png"],
	[".webp", "image/webp"],
]);
const TEXT_EXTENSIONS = new Set([
	".c", ".cc", ".conf", ".cpp", ".cs", ".css", ".go", ".h", ".hpp", ".html", ".java", ".js", ".json", ".jsx",
	".kt", ".lua", ".md", ".mjs", ".php", ".properties", ".py", ".rb", ".rs", ".scss", ".sh", ".sql", ".swift",
	".toml", ".ts", ".tsx", ".txt", ".vue", ".xml", ".yaml", ".yml",
]);
const PARSER_VERSION = "1.0.0";

export interface DocumentParseOptions {
	assetVersionId?: string;
	cacheDirectory?: string;
	ocr?: OcrService;
	ocrModelRevision?: string;
	ocrCodeRevision?: string;
	pdftotextBinary?: DocumentCommand;
	pdfinfoBinary?: DocumentCommand;
	signal?: AbortSignal;
}

export type DocumentCommand = string | readonly [string, ...string[]];

export interface OcrHttpServiceOptions {
	endpoint: string;
	cacheDirectory?: string;
	cacheRoot?: string;
	apiKey?: string;
	fetch?: typeof globalThis.fetch;
	maximumResponseBytes?: number;
}

const hash = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");

const isLoopback = (host: string): boolean => ["127.0.0.1", "::1", "localhost"].includes(host.toLowerCase());

const secureCacheDirectory = async (cacheRoot: string, directory: string): Promise<string> => {
	const lexicalRoot = resolve(cacheRoot);
	const realRoot = await realpath(lexicalRoot);
	const outside = (path: string): boolean => path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
	let relativeDirectory = relative(lexicalRoot, resolve(directory));
	if (outside(relativeDirectory)) relativeDirectory = relative(realRoot, resolve(directory));
	if (outside(relativeDirectory)) throw new Error("Document cache directory must be inside cacheRoot");
	let current = realRoot;
	for (const component of relativeDirectory.split(sep).filter(Boolean)) {
		current = join(current, component);
		let created = false;
		try {
			await mkdir(current, { mode: 0o700 });
			created = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const info = await lstat(current);
		if (!info.isDirectory() || info.isSymbolicLink() || (typeof process.getuid === "function" && info.uid !== process.getuid())) throw new Error("Document cache path must contain only owned, non-symlink directories");
		if (created) await chmod(current, 0o700);
	}
	const info = await lstat(current);
	if (!info.isDirectory() || info.isSymbolicLink() || (typeof process.getuid === "function" && info.uid !== process.getuid())) throw new Error("Document cache directory must be an owned, non-symlink directory");
	await chmod(current, 0o700);
	return current;
};

export class OcrHttpService implements OcrService {
	readonly #endpoint: URL;
	readonly #cacheDirectory?: string;
	readonly #cacheRoot?: string;
	readonly #apiKey: string;
	readonly #fetch: typeof globalThis.fetch;
	readonly #maximumResponseBytes: number;
	readonly #uploadedAssets = new Set<string>();

	constructor(options: OcrHttpServiceOptions) {
		this.#endpoint = new URL(options.endpoint);
		if (this.#endpoint.protocol !== "https:" && !(this.#endpoint.protocol === "http:" && isLoopback(this.#endpoint.hostname))) {
			throw new Error("OCR endpoint must use HTTPS or loopback HTTP");
		}
		if (this.#endpoint.username || this.#endpoint.password || this.#endpoint.search || this.#endpoint.hash) throw new Error("OCR endpoint cannot contain credentials, query parameters, or fragments");
		if (!options.apiKey?.trim() || options.apiKey.trim().length < 32) throw new Error("OCR API key must contain at least 32 characters");
		this.#cacheDirectory = options.cacheDirectory;
		this.#cacheRoot = options.cacheRoot;
		if (this.#cacheDirectory && !this.#cacheRoot) throw new Error("OCR cacheRoot is required with cacheDirectory");
		if (this.#cacheDirectory && this.#cacheRoot) {
			const relativeCache = relative(resolve(this.#cacheRoot), resolve(this.#cacheDirectory));
			if (relativeCache.startsWith("..") || isAbsolute(relativeCache)) throw new Error("OCR cache directory must be inside cacheRoot");
		}
		this.#apiKey = options.apiKey.trim();
		this.#fetch = options.fetch ?? globalThis.fetch;
		this.#maximumResponseBytes = options.maximumResponseBytes ?? 20 * 1024 * 1024;
	}

	async parse(request: OcrRequest, signal?: AbortSignal): Promise<DocumentIR> {
		if (!request.requestId || !/^[a-f0-9]{64}$/.test(request.idempotencyKey) || !request.modelRevision || !request.parserCodeRevision) throw new Error("OCR request revisions and identities are required");
		const cacheDirectory = this.#cacheDirectory ? await secureCacheDirectory(this.#cacheRoot!, this.#cacheDirectory) : undefined;
		const cachePath = cacheDirectory ? join(cacheDirectory, `${request.idempotencyKey}.json`) : undefined;
		if (cachePath) {
			try {
				const cached = await safeFile(cacheDirectory!, basename(cachePath));
				return validateDocument(JSON.parse(cached.bytes.toString("utf8")));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		const extension = extname(request.assetPath).toLowerCase();
		const mediaType = OCR_MEDIA_TYPES.get(extension);
		if (!mediaType) throw new Error("Unsupported OCR asset type");
		const source = await safeLocalAsset(request.assetPath, signal);
		const sourceHash = hash(source);
		const uploadKey = `${sourceHash}:${mediaType}`;
		const upload = async (): Promise<void> => {
			const uploaded = await this.#fetch(new URL(`v1/assets/${sourceHash}`, this.#endpoint), {
				method: "PUT",
				headers: { "content-type": mediaType, authorization: `Bearer ${this.#apiKey}` },
				body: new Uint8Array(source.buffer, source.byteOffset, source.byteLength),
				signal,
			});
			if (!uploaded.ok) throw new Error(`OCR asset upload failed (${uploaded.status})`);
			await uploaded.body?.cancel();
			this.#uploadedAssets.add(uploadKey);
		};
		if (!this.#uploadedAssets.has(uploadKey)) await upload();
		const { assetPath: _assetPath, ...wireRequest } = request;
		const submit = () => this.#fetch(new URL("v1/ocr", this.#endpoint), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"idempotency-key": request.idempotencyKey,
				...(this.#apiKey ? { authorization: `Bearer ${this.#apiKey}` } : {}),
			},
			body: JSON.stringify({ ...wireRequest, asset: { sha256: sourceHash, mediaType } }),
			signal,
		});
		let response = await submit();
		if (response.status === 404) {
			await response.body?.cancel();
			this.#uploadedAssets.delete(uploadKey);
			await upload();
			response = await submit();
		}
		if (!response.ok) throw new Error(`OCR service failed (${response.status})`);
		if (!response.body) throw new Error("OCR service returned no body");
		const chunks: Buffer[] = [];
		let bytes = 0;
		for await (const chunk of response.body) {
			bytes += chunk.byteLength;
			if (bytes > this.#maximumResponseBytes) throw new Error("OCR response exceeds its output limit");
			chunks.push(Buffer.from(chunk));
		}
		const document = validateDocument(JSON.parse(Buffer.concat(chunks).toString("utf8")));
		if (cachePath) await atomicJson(this.#cacheRoot!, cachePath, document);
		return document;
	}

	async health(modelRevision: string, parserCodeRevision: string, signal?: AbortSignal): Promise<void> {
		const response = await this.#fetch(new URL("health", this.#endpoint), { headers: { authorization: `Bearer ${this.#apiKey}` }, signal });
		if (!response.ok || !response.body) throw new Error(`OCR health check failed (${response.status})`);
		const chunks: Buffer[] = [];
		let bytes = 0;
		for await (const chunk of response.body) {
			bytes += chunk.byteLength;
			if (bytes > 256 * 1024) throw new Error("OCR health response exceeds 256 KiB");
			chunks.push(Buffer.from(chunk));
		}
		const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
		if (payload.status !== "ok" || payload.modelRevision !== modelRevision || payload.parserCodeRevision !== parserCodeRevision) throw new Error("OCR health check returned unexpected revisions");
	}
}

async function safeLocalAsset(path: string, signal?: AbortSignal): Promise<Buffer> {
	const absolute = resolve(path);
	const lexical = await lstat(absolute);
	if (!lexical.isFile() || lexical.isSymbolicLink() || lexical.nlink !== 1) throw new Error("OCR asset must be a regular standalone file");
	const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const before = await handle.stat();
		if (!before.isFile() || before.nlink !== 1) throw new Error("OCR asset must be a regular standalone file");
		if (before.size > MAX_SOURCE_BYTES) throw new Error("OCR asset exceeds 50 MiB");
		const bytes = Buffer.alloc(before.size + 1);
		let length = 0;
		while (length < bytes.length) {
			optionsAbort(signal);
			const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
			if (!bytesRead) break;
			length += bytesRead;
		}
		const after = await handle.stat();
		if (length > MAX_SOURCE_BYTES) throw new Error("OCR asset exceeds 50 MiB");
		if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || length !== before.size) throw new Error("OCR asset changed while it was being read");
		return bytes.subarray(0, length);
	} finally {
		await handle.close();
	}
}

const validateDocument = (value: unknown): DocumentIR => {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Document IR");
	const document = value as Partial<DocumentIR>;
	if (typeof document.documentId !== "string" || typeof document.assetVersionId !== "string" || !document.parser || !Array.isArray(document.pages)) {
		throw new Error("Invalid Document IR");
	}
	if (document.pages.length > 10_000 || document.pages.some((page) => !page || !Number.isInteger(page.pageNumber) || !Array.isArray(page.blocks) || page.blocks.length > 100_000)) {
		throw new Error("Invalid Document IR pages");
	}
	return document as DocumentIR;
};

async function safeFile(workspaceRoot: string, requestedPath: string, signal?: AbortSignal): Promise<{ root: string; path: string; relativePath: string; bytes: Buffer }> {
	const root = await realpath(workspaceRoot);
	const lexical = resolve(root, requestedPath);
	const lexicalRelative = relative(root, lexical);
	if (lexicalRelative.startsWith("..") || isAbsolute(lexicalRelative)) throw new Error("Document path is outside the workspace");
	if (isSensitiveWorkspacePath(lexicalRelative)) throw new Error("Sensitive workspace paths cannot be parsed");
	const path = await realpath(lexical);
	const relativePath = relative(root, path);
	if (relativePath.startsWith("..") || isAbsolute(relativePath)) throw new Error("Document path resolves outside the workspace");
	if (isSensitiveWorkspacePath(relativePath)) throw new Error("Sensitive workspace paths cannot be parsed");
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.nlink !== 1) throw new Error("Document must be a regular standalone file");
		if (info.size > MAX_SOURCE_BYTES) throw new Error("Document exceeds 50 MiB");
		const bytes = Buffer.alloc(info.size + 1);
		let length = 0;
		while (length < bytes.length) {
			optionsAbort(signal);
			const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
			if (!bytesRead) break;
			length += bytesRead;
		}
		if (length > MAX_SOURCE_BYTES) throw new Error("Document exceeds 50 MiB");
		return { root, path, relativePath, bytes: bytes.subarray(0, length) };
	} finally {
		await handle.close();
	}
}

const optionsAbort = (signal?: AbortSignal): void => {
	if (signal?.aborted) throw new Error("Document parsing aborted");
};

const needsOcrReview = (page: DocumentIR["pages"][number]): boolean => {
	const confidence = page.blocks.flatMap((block) => typeof block.confidence === "number" ? [block.confidence] : []);
	return confidence.length > 0 && confidence.reduce((sum, value) => sum + value, 0) / confidence.length < 0.5;
};

async function atomicJson(cacheRoot: string, path: string, value: unknown): Promise<void> {
	const directory = await secureCacheDirectory(cacheRoot, dirname(path));
	const destination = join(directory, basename(path));
	const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
	const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
		await handle.sync();
		await handle.close();
		await rename(temporary, destination);
	} catch (error) {
		await handle.close().catch(() => undefined);
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
}

async function boundedProcess(program: string, args: string[], signal?: AbortSignal): Promise<{ stdout: Buffer; stderr: string }> {
	optionsAbort(signal);
	return new Promise((resolveProcess, rejectProcess) => {
		const child = spawn(program, args, {
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
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
		const onParentExit = () => killTree(true);
		if (process.platform !== "win32") process.once("exit", onParentExit);
		const stop = (error: Error) => {
			if (failure) return;
			failure = error;
			killTree(false);
			killTimer = setTimeout(() => killTree(true), 1_000);
			killTimer.unref();
		};
		child.stdout.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > MAX_TEXT_BYTES) stop(new Error("Parsed document text exceeds 20 MiB"));
			else stdout.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (Buffer.concat(stderr).length < 64 * 1024) stderr.push(chunk);
		});
		const onAbort = () => stop(new Error("Document parsing aborted"));
		signal?.addEventListener("abort", onAbort, { once: true });
		const timeout = setTimeout(() => stop(new Error("Document parser timed out")), 60_000);
		timeout.unref();
		child.once("error", (error) => { failure = error; });
		child.once("exit", () => {
			killedOnExit = true;
			killTree(true);
		});
		child.once("close", (code) => {
			clearTimeout(timeout);
			if (killTimer) clearTimeout(killTimer);
			if (!killedOnExit) killTree(true);
			process.removeListener("exit", onParentExit);
			signal?.removeEventListener("abort", onAbort);
			if (failure) rejectProcess(failure);
			else if (code !== 0) rejectProcess(new Error(Buffer.concat(stderr).toString("utf8").trim() || `Document parser exited ${code}`));
			else resolveProcess({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString("utf8") });
		});
	});
}

const parseCsv = (text: string): string[][] => {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = "";
	let quoted = false;
	for (let index = 0; index < text.length; index++) {
		const character = text[index]!;
		if (character === '"') {
			if (quoted && text[index + 1] === '"') { cell += '"'; index++; }
			else quoted = !quoted;
		} else if (character === "," && !quoted) {
			row.push(cell); cell = "";
		} else if ((character === "\n" || character === "\r") && !quoted) {
			if (character === "\r" && text[index + 1] === "\n") index++;
			row.push(cell); rows.push(row); row = []; cell = "";
		} else cell += character;
	}
	if (quoted) throw new Error("CSV contains an unterminated quote");
	if (cell || row.length) { row.push(cell); rows.push(row); }
	return rows;
};

const textBlocks = (text: string, assetVersionId: string, pageNumber: number, parserId: string): DocumentIR["pages"][number]["blocks"] => {
	const groups = text.replaceAll("\r\n", "\n").split(/\n\s*\n/).map((value) => value.trim()).filter(Boolean);
	return groups.map((value, index) => ({
		blockId: hash(`${assetVersionId}:${pageNumber}:${index}:${value}`).slice(0, 24),
		type: (/^#{1,6}\s/.test(value) || (value.length < 100 && value === value.toUpperCase())) ? "heading" as const : "paragraph" as const,
		readingOrder: index,
		text: value,
		confidence: parserId === "native-pdf" ? 0.98 : 1,
		provenance: { assetVersionId, pageNumber, parserId },
	}));
};

const commandParts = (command: DocumentCommand): { program: string; args: string[] } =>
	typeof command === "string" ? { program: command, args: [] } : { program: command[0], args: [...command.slice(1)] };

const pageCount = async (path: string, command: DocumentCommand, signal?: AbortSignal): Promise<number> => {
	try {
		const { program, args } = commandParts(command);
		const { stdout } = await boundedProcess(program, [...args, path], signal);
		const match = stdout.toString("utf8").match(/^Pages:\s+(\d+)/m);
		return match ? Math.max(1, Number(match[1])) : 1;
	} catch {
		return 1;
	}
};

export async function parseDocument(
	workspaceRoot: string,
	requestedPath: string,
	options: DocumentParseOptions = {},
): Promise<DocumentIR> {
	optionsAbort(options.signal);
	const source = await safeFile(workspaceRoot, requestedPath, options.signal);
	const sourceHash = hash(source.bytes);
	const assetVersionId = options.assetVersionId ?? `version_${sourceHash}`;
	const extension = extname(source.path).toLowerCase();
	const configurationHash = hash(JSON.stringify({ extension, parserVersion: PARSER_VERSION }));
	const cacheKey = hash(JSON.stringify({ sourceHash, assetVersionId, configurationHash, ocr: options.ocrModelRevision, ocrCode: options.ocrCodeRevision }));
	const cacheDirectory = options.cacheDirectory ? await secureCacheDirectory(workspaceRoot, options.cacheDirectory) : undefined;
	const cachePath = cacheDirectory ? join(cacheDirectory, `${cacheKey}.json`) : undefined;
	if (cachePath) {
		try {
			const cached = await safeFile(cacheDirectory!, basename(cachePath), options.signal);
			return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(cached.bytes)) as DocumentIR;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	let parserId = "native-text";
	let pages: DocumentIR["pages"] = [];
	const failures: NonNullable<DocumentIR["failures"]> = [];
	if (TEXT_EXTENSIONS.has(extension)) {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(source.bytes);
		pages = [{ pageNumber: 1, width: 0, height: 0, blocks: textBlocks(text, assetVersionId, 1, parserId) }];
	} else if (extension === ".csv") {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(source.bytes);
		const rows = parseCsv(text);
		pages = [{ pageNumber: 1, width: 0, height: 0, blocks: [{
			blockId: hash(`${assetVersionId}:csv`).slice(0, 24),
			type: "table",
			readingOrder: 0,
			text,
			structuredData: { rows },
			confidence: 1,
			provenance: { assetVersionId, pageNumber: 1, parserId },
		}] }];
	} else if (extension === ".pdf") {
		parserId = "native-pdf";
		const count = await pageCount(source.path, options.pdfinfoBinary ?? "pdfinfo", options.signal);
		let pageTexts: string[] = [];
		try {
			const { program, args } = commandParts(options.pdftotextBinary ?? "pdftotext");
			const { stdout } = await boundedProcess(program, [...args, "-layout", source.path, "-"], options.signal);
			pageTexts = stdout.toString("utf8").split("\f");
		} catch (error) {
			failures.push({ parserId, message: error instanceof Error ? error.message : String(error) });
		}
		for (let pageNumber = 1; pageNumber <= count; pageNumber++) {
			const text = pageTexts[pageNumber - 1]?.trim() ?? "";
			if (text.length >= 20 || !options.ocr) {
				pages.push({ pageNumber, width: 0, height: 0, blocks: textBlocks(text, assetVersionId, pageNumber, parserId) });
				continue;
			}
			const request: OcrRequest = {
				requestId: randomUUID(),
				idempotencyKey: hash(`${sourceHash}:${pageNumber}:${options.ocrModelRevision}:${options.ocrCodeRevision}`),
				assetPath: source.path,
				pageNumber,
				prompt: "document parsing.",
				imageMode: "base",
				settings: { maxContextTokens: 32_768, noRepeat: { ngramSize: 35, windowSize: 128 } },
				modelRevision: options.ocrModelRevision ?? "unconfigured",
				parserCodeRevision: options.ocrCodeRevision ?? "unconfigured",
			};
			try {
				const ocr = await options.ocr.parse(request, options.signal);
				const ocrPage = ocr.pages.find((page) => page.pageNumber === pageNumber) ?? ocr.pages[0];
				if (ocrPage) {
					if (needsOcrReview(ocrPage)) failures.push({ pageNumber, parserId: "ocr", message: "OCR confidence is below 0.5; manual review required" });
					pages.push({
					...ocrPage,
					pageNumber,
					blocks: ocrPage.blocks.map((block) => ({
						...block,
						provenance: { assetVersionId, pageNumber, parserId: "ocr" },
					})),
					});
				}
				else throw new Error("OCR returned no page");
			} catch (error) {
				failures.push({ pageNumber, parserId: "ocr", message: error instanceof Error ? error.message : String(error) });
				pages.push({ pageNumber, width: 0, height: 0, blocks: [] });
			}
		}
	} else if ([".png", ".jpg", ".jpeg", ".webp", ".bmp"].includes(extension) && options.ocr) {
		const request: OcrRequest = {
			requestId: randomUUID(),
			idempotencyKey: hash(`${sourceHash}:1:${options.ocrModelRevision}:${options.ocrCodeRevision}`),
			assetPath: source.path,
			pageNumber: 1,
			prompt: "document parsing.",
			imageMode: "gundam",
			settings: { maxContextTokens: 32_768, noRepeat: { ngramSize: 35, windowSize: 128 } },
			modelRevision: options.ocrModelRevision ?? "unconfigured",
			parserCodeRevision: options.ocrCodeRevision ?? "unconfigured",
		};
		const parsed = await options.ocr.parse(request, options.signal);
		for (const page of parsed.pages) if (needsOcrReview(page)) failures.push({ pageNumber: page.pageNumber, parserId: "ocr", message: "OCR confidence is below 0.5; manual review required" });
		pages = parsed.pages.map((page) => ({
			...page,
			blocks: page.blocks.map((block) => ({
				...block,
				provenance: { assetVersionId, pageNumber: page.pageNumber, parserId: "ocr" },
			})),
		}));
		parserId = "ocr";
	} else throw new Error(`Unsupported document format: ${extension || "none"}`);

	const document: DocumentIR = {
		documentId: `document_${sourceHash}`,
		assetVersionId,
		parser: { id: parserId, version: PARSER_VERSION, configurationHash },
		pages,
		...(failures.length ? { failures } : {}),
	};
	if (cachePath) await atomicJson(workspaceRoot, cachePath, document);
	return document;
}
