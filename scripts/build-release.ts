import { createHash, createPublicKey, sign } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_KEY_BYTES = 64 * 1024;
const MAX_NPM_OUTPUT_BYTES = 1024 * 1024;

export interface ReleaseResult {
	directory: string;
	artifact: string;
	manifest: string;
	signature: string;
	publicKey: string;
}

const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");

function sourceState(projectRoot: string): { sourceCommit: string; sourceTreeDirty: boolean } {
	const git = (args: string[]) => {
		const result = spawnSync("git", args, { cwd: projectRoot, encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024 });
		if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
		return result.stdout.trim();
	};
	const sourceCommit = git(["rev-parse", "HEAD"]);
	if (!/^[a-f0-9]{40,64}$/.test(sourceCommit)) throw new Error("Git returned an invalid source commit");
	return { sourceCommit, sourceTreeDirty: Boolean(git(["status", "--porcelain", "--untracked-files=normal"])) };
}

async function readPrivateKey(path: string): Promise<Buffer> {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.nlink !== 1 || info.size > MAX_KEY_BYTES) throw new Error("Signing key must be a regular standalone file under 64 KiB");
		return await handle.readFile();
	} finally {
		await handle.close();
	}
}

async function runNpmPack(directory: string, projectRoot: string): Promise<string> {
	const cache = await mkdtemp(join(tmpdir(), "codetonomy-npm-cache-"));
	try {
		return await new Promise((resolvePack, rejectPack) => {
			const npmCli = process.env.npm_execpath || join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
			const child = spawn(process.execPath, [npmCli, "pack", "--json", "--pack-destination", directory], { cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, npm_config_cache: cache } });
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			let bytes = 0;
			const append = (target: Buffer[], chunk: Buffer) => {
				bytes += chunk.length;
				if (bytes > MAX_NPM_OUTPUT_BYTES) child.kill("SIGTERM");
				else target.push(chunk);
			};
			child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk));
			child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk));
			child.once("error", rejectPack);
			child.once("close", (code) => {
				if (bytes > MAX_NPM_OUTPUT_BYTES) return rejectPack(new Error("npm pack output exceeded 1 MiB"));
				if (code !== 0) return rejectPack(new Error(Buffer.concat(stderr).toString("utf8").trim() || `npm pack exited ${code}`));
				try {
					resolvePack(parseNpmPackOutput(Buffer.concat(stdout).toString("utf8")));
				} catch (error) {
					rejectPack(error);
				}
			});
		});
	} finally {
		await rm(cache, { recursive: true, force: true });
	}
}

export function parseNpmPackOutput(raw: string): string {
	const parsed = JSON.parse(raw) as unknown;
	const output = Array.isArray(parsed)
		? parsed
		: parsed && typeof parsed === "object"
			? Object.values(parsed)
			: [];
	if (output.length !== 1 || !output[0] || typeof output[0] !== "object" || typeof (output[0] as { filename?: unknown }).filename !== "string") {
		throw new Error("npm pack did not report one artifact");
	}
	return (output[0] as { filename: string }).filename;
}

export async function buildSignedRelease(outputDirectory: string, signingKeyPath: string): Promise<ReleaseResult> {
	const projectRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
	const directory = resolve(outputDirectory);
	const privateKey = await readPrivateKey(signingKeyPath);
	await mkdir(dirname(directory), { recursive: true });
	try { await lstat(directory); throw new Error("Release destination already exists"); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
	const staging = await mkdtemp(join(dirname(directory), `.${basename(directory)}.codetonomy-`));
	let committed = false;
	try {
		const artifactName = await runNpmPack(staging, projectRoot);
		const stagedArtifactPath = join(staging, basename(artifactName));
		const artifactPath = join(directory, basename(artifactName));
		const artifact = await readFile(stagedArtifactPath);
		const references = await readFile(join(projectRoot, "references.lock.yaml"));
		const packageManifest = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")) as { name: string; version: string };
		const source = sourceState(projectRoot);
		const manifestPath = join(staging, "release.json");
		const manifestBytes = Buffer.from(`${JSON.stringify({
			schemaVersion: 1,
			name: packageManifest.name,
			version: packageManifest.version,
			artifact: basename(artifactPath),
			artifactSha256: sha256(artifact),
			referencesLockSha256: sha256(references),
			...source,
			runtime: { node: process.version, platform: process.platform, architecture: process.arch },
			signatureAlgorithm: "Ed25519",
		}, null, 2)}\n`);
		await writeFile(manifestPath, manifestBytes, { mode: 0o600, flag: "wx" });
		const signaturePath = `${manifestPath}.sig`;
		const publicKeyPath = join(staging, "release-public-key.pem");
		await writeFile(signaturePath, sign(null, manifestBytes, privateKey).toString("base64url"), { mode: 0o600, flag: "wx" });
		await writeFile(publicKeyPath, createPublicKey(privateKey).export({ type: "spki", format: "pem" }), { mode: 0o644, flag: "wx" });
		await writeFile(`${stagedArtifactPath}.sha256`, `${sha256(artifact)}  ${basename(artifactPath)}\n`, { mode: 0o644, flag: "wx" });
		await rename(staging, directory);
		committed = true;
		await chmod(directory, 0o755);
		return { directory, artifact: artifactPath, manifest: join(directory, "release.json"), signature: join(directory, "release.json.sig"), publicKey: join(directory, "release-public-key.pem") };
	} finally {
		if (!committed) {
			await rm(staging, { recursive: true, force: true }).catch(() => undefined);
		}
	}
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	const outIndex = process.argv.indexOf("--out");
	const keyIndex = process.argv.indexOf("--signing-key");
	const output = outIndex >= 0 ? process.argv[outIndex + 1] : undefined;
	const key = keyIndex >= 0 ? process.argv[keyIndex + 1] : process.env.CODETONOMY_SIGNING_KEY;
	if (!output || !key) throw new Error("Usage: build-release --out <project-directory> --signing-key <ed25519-private-key.pem>");
	const result = await buildSignedRelease(output, key);
	console.log(`Signed Codetonomy release: ${result.directory}`);
}
