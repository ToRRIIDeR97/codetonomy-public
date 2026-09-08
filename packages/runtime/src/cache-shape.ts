import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { CompiledCapabilities } from "@agent-harness/contracts";
import { writeRuntimeFileAtomically } from "./checkpoint.js";

const MAX_SHAPE_BYTES = 16 * 1024;

export interface RuntimeCacheShape {
	version: 1;
	providerId: string;
	modelId: string;
	cachePrefixHash: string;
	toolBundleHash: string;
	skillPackHash: string;
}

export interface CacheLookup {
	status: "cold" | "warm" | "invalidated";
	changed: string[];
	path?: string;
}

export const captureCacheShape = (
	providerId: string,
	modelId: string,
	capabilities: CompiledCapabilities,
): RuntimeCacheShape => ({
	version: 1,
	providerId,
	modelId,
	cachePrefixHash: capabilities.cachePrefixHash,
	toolBundleHash: capabilities.toolBundleHash,
	skillPackHash: capabilities.skillPackHash,
});

export function compareCacheShapes(previous: RuntimeCacheShape, next: RuntimeCacheShape): string[] {
	const changed: string[] = [];
	if (previous.providerId !== next.providerId) changed.push("provider");
	if (previous.modelId !== next.modelId) changed.push("model");
	if (previous.toolBundleHash !== next.toolBundleHash) changed.push("tools");
	// Optional/task skills intentionally do not invalidate the stable prefix.
	if (previous.cachePrefixHash !== next.cachePrefixHash && !changed.length) changed.push("stable-prefix");
	return changed;
}

const validShape = (value: unknown): value is RuntimeCacheShape => {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const shape = value as Partial<RuntimeCacheShape>;
	return shape.version === 1
		&& [shape.providerId, shape.modelId, shape.cachePrefixHash, shape.toolBundleHash, shape.skillPackHash]
			.every((item) => typeof item === "string" && item.length > 0);
};

export async function lookupAndStoreCacheShape(
	traceDirectory: string,
	sessionId: string | undefined,
	next: RuntimeCacheShape,
): Promise<CacheLookup> {
	if (!sessionId) return { status: "cold", changed: [] };
	const key = createHash("sha256").update(sessionId).digest("hex");
	const path = join(dirname(resolve(traceDirectory)), "cache-shapes", `${key}.json`);
	let previous: RuntimeCacheShape | undefined;
	try {
		const raw = await readFile(path);
		if (raw.length > MAX_SHAPE_BYTES) throw new Error("Cache shape exceeds 16 KiB");
		const parsed: unknown = JSON.parse(raw.toString("utf8"));
		if (!validShape(parsed)) throw new Error("Invalid cache shape");
		previous = parsed;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await writeRuntimeFileAtomically(path, `${JSON.stringify(next, null, 2)}\n`);
	if (!previous) return { status: "cold", changed: [], path };
	const changed = compareCacheShapes(previous, next);
	return { status: changed.length ? "invalidated" : "warm", changed, path };
}
