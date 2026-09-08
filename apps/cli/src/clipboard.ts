import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DocumentParseOptions } from "@agent-harness/document-ir";

const MAX_CLIPBOARD_IMAGE_BYTES = 20 * 1024 * 1024;

export interface ClipboardImage {
	data: string;
	mimeType: "image/png";
}

export interface NativeClipboard {
	getText(): Promise<string>;
	hasImage(): boolean;
	getImageBinary(): Promise<number[]>;
}

const require = createRequire(import.meta.url);
const execute = promisify(execFile);

export const loadNativeClipboard = (): NativeClipboard | undefined => {
	try {
		return require("@mariozechner/clipboard") as NativeClipboard;
	} catch {
		return undefined;
	}
};

const clipboardImage = (bytes: Buffer): ClipboardImage => {
	if (!bytes.length) throw new Error("The clipboard image is empty");
	if (bytes.length > MAX_CLIPBOARD_IMAGE_BYTES) throw new Error("Clipboard images must be 20 MiB or smaller");
	return { data: bytes.toString("base64"), mimeType: "image/png" };
};

const MAC_CLIPBOARD_SCRIPT = `set outputPath to system attribute "CODETONOMY_CLIPBOARD_PATH"
try
	set imageData to the clipboard as «class PNGf»
	set imageKind to "png"
on error
	try
		set imageData to the clipboard as TIFF picture
		set imageKind to "tiff"
	on error
		return "none"
	end try
end try
set fileReference to open for access POSIX file outputPath with write permission
try
	set eof fileReference to 0
	write imageData to fileReference
	close access fileReference
on error messageText
	try
		close access fileReference
	end try
	error messageText
end try
return imageKind`;

async function readMacClipboard(): Promise<{ image?: ClipboardImage; text?: string }> {
	const directory = await mkdtemp(join(tmpdir(), "codetonomy-system-clipboard-"));
	const raw = join(directory, "clipboard-image");
	const png = join(directory, "clipboard.png");
	try {
		const { stdout: kind } = await execute("/usr/bin/osascript", ["-e", MAC_CLIPBOARD_SCRIPT], {
			timeout: 5_000,
			maxBuffer: 64 * 1024,
			env: { ...process.env, CODETONOMY_CLIPBOARD_PATH: raw },
		});
		if (kind.trim() === "png") return { image: clipboardImage(await readFile(raw)) };
		if (kind.trim() === "tiff") {
			await execute("/usr/bin/sips", ["-s", "format", "png", raw, "--out", png], { timeout: 5_000, maxBuffer: 64 * 1024 });
			return { image: clipboardImage(await readFile(png)) };
		}
		const { stdout } = await execute("/usr/bin/pbpaste", [], { timeout: 3_000, maxBuffer: 2 * 1024 * 1024 });
		return { text: stdout };
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

export async function readClipboard(clipboard = loadNativeClipboard()): Promise<{ image?: ClipboardImage; text?: string }> {
	if (clipboard) {
		try {
			if (clipboard.hasImage()) return { image: clipboardImage(Buffer.from(await clipboard.getImageBinary())) };
			return { text: await clipboard.getText() };
		} catch (error) {
			if (process.platform !== "darwin") throw error;
		}
	}
	if (process.platform === "darwin") return readMacClipboard();
	throw new Error("Native clipboard support is unavailable in this installation");
}

export async function ocrClipboardImages(
	images: readonly ClipboardImage[],
	options: DocumentParseOptions | undefined,
	signal?: AbortSignal,
): Promise<string> {
	if (!options?.ocr || !options.ocrModelRevision || !options.ocrCodeRevision) {
		throw new Error("This model cannot read images. Start and configure Unlimited OCR first.");
	}
	const directory = await mkdtemp(join(tmpdir(), "codetonomy-clipboard-"));
	try {
		const documents = [];
		for (const [index, image] of images.entries()) {
			signal?.throwIfAborted();
			const bytes = Buffer.from(image.data, "base64");
			const path = join(directory, `image-${index + 1}-${randomUUID()}.png`);
			await writeFile(path, bytes, { mode: 0o600 });
			const parsed = await options.ocr.parse({
				requestId: randomUUID(),
				idempotencyKey: createHash("sha256").update(bytes).update(options.ocrModelRevision).update(options.ocrCodeRevision).digest("hex"),
				assetPath: path,
				pageNumber: 1,
				prompt: "document parsing.",
				imageMode: "gundam",
				settings: { maxContextTokens: 32_768, noRepeat: { ngramSize: 35, windowSize: 128 } },
				modelRevision: options.ocrModelRevision,
				parserCodeRevision: options.ocrCodeRevision,
			}, signal);
			const text = parsed.pages.flatMap(({ blocks }) => blocks.sort((left, right) => left.readingOrder - right.readingOrder).map(({ text }) => text)).filter(Boolean).join("\n");
			documents.push(`<clipboard-image index=${JSON.stringify(index + 1)} parser="unlimited-ocr">\n${text}\n</clipboard-image>`);
		}
		return documents.join("\n\n");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
