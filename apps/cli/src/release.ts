import { createHash, verify } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const SUPPORTED_PLATFORMS = new Set(["aix", "android", "darwin", "freebsd", "haiku", "linux", "openbsd", "sunos", "win32"]);
const SUPPORTED_ARCHITECTURES = new Set(["arm", "arm64", "ia32", "loong64", "mips", "mipsel", "ppc", "ppc64", "riscv64", "s390", "s390x", "x32", "x64"]);
const RELEASE_MANIFEST_KEYS = [
	"schemaVersion",
	"name",
	"version",
	"artifact",
	"artifactSha256",
	"referencesLockSha256",
	"sourceCommit",
	"sourceTreeDirty",
	"runtime",
	"signatureAlgorithm",
] as const;

interface ReleaseManifest {
	schemaVersion: 1;
	name: string;
	version: string;
	artifact: string;
	artifactSha256: string;
	referencesLockSha256: string;
	sourceCommit: string;
	sourceTreeDirty: boolean;
	runtime: RuntimeManifest;
	signatureAlgorithm: "Ed25519";
}

interface RuntimeManifest {
	node: string;
	platform: string;
	architecture: string;
}

const readFile = async (path: string, maximum: number): Promise<Buffer> => {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.nlink !== 1 || info.size > maximum) throw new Error("Release file is invalid or oversized");
		return await handle.readFile();
	} finally { await handle.close(); }
};

const sha256 = (value: Buffer): string => createHash("sha256").update(value).digest("hex");

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validateManifest(value: unknown): asserts value is ReleaseManifest {
	if (!isRecord(value) || !hasExactKeys(value, RELEASE_MANIFEST_KEYS)) throw new Error("Release manifest is invalid");
	const runtime = value.runtime;
	if (!isRecord(runtime)
		|| !hasExactKeys(runtime, ["node", "platform", "architecture"])
		|| value.schemaVersion !== 1
		|| value.name !== "codetonomy"
		|| typeof value.version !== "string"
		|| !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.version)
		|| typeof value.artifact !== "string"
		|| basename(value.artifact) !== value.artifact
		|| value.artifact !== `${value.name}-${value.version}.tgz`
		|| typeof value.artifactSha256 !== "string"
		|| !/^[a-f0-9]{64}$/.test(value.artifactSha256)
		|| typeof value.referencesLockSha256 !== "string"
		|| !/^[a-f0-9]{64}$/.test(value.referencesLockSha256)
		|| typeof value.sourceCommit !== "string"
		|| !/^[a-f0-9]{40,64}$/.test(value.sourceCommit)
		|| typeof value.sourceTreeDirty !== "boolean"
		|| typeof runtime.node !== "string"
		|| !/^v\d+\.\d+\.\d+$/.test(runtime.node)
		|| typeof runtime.platform !== "string"
		|| !SUPPORTED_PLATFORMS.has(runtime.platform)
		|| typeof runtime.architecture !== "string"
		|| !SUPPORTED_ARCHITECTURES.has(runtime.architecture)
		|| value.signatureAlgorithm !== "Ed25519") throw new Error("Release manifest is invalid");
}

export async function verifySignedRelease(directory: string, trustedPublicKeyPath: string): Promise<{ artifact: string; sha256: string }> {
	const root = resolve(directory);
	const manifestBytes = await readFile(join(root, "release.json"), 1024 * 1024);
	const signature = Buffer.from((await readFile(join(root, "release.json.sig"), 16 * 1024)).toString("utf8").trim(), "base64url");
	const publicKey = await readFile(resolve(trustedPublicKeyPath), 64 * 1024);
	if (!verify(null, manifestBytes, publicKey, signature)) throw new Error("Release signature is invalid");
	let manifest: unknown;
	try {
		manifest = JSON.parse(manifestBytes.toString("utf8")) as unknown;
	} catch {
		throw new Error("Release manifest is invalid");
	}
	validateManifest(manifest);
	const artifact = join(root, manifest.artifact);
	const digest = sha256(await readFile(artifact, 256 * 1024 * 1024));
	if (digest !== manifest.artifactSha256) throw new Error("Release artifact checksum is invalid");
	return { artifact, sha256: digest };
}
