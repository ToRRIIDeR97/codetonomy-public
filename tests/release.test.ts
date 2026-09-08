import assert from "node:assert/strict";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { buildSignedRelease, parseNpmPackOutput } from "../scripts/build-release.ts";
import { selectOcrBackend } from "../scripts/ocr-backend.mjs";
import { verifySignedRelease } from "../apps/cli/src/release.ts";

const run = promisify(execFile);

test("release packaging accepts npm 10 and npm 11 JSON shapes", () => {
	assert.equal(parseNpmPackOutput('[{"filename":"codetonomy.tgz"}]'), "codetonomy.tgz");
	assert.equal(parseNpmPackOutput('{"codetonomy":{"filename":"codetonomy.tgz"}}'), "codetonomy.tgz");
});

test("OCR backend selection is deterministic and platform-specific", () => {
	assert.equal(selectOcrBackend({ platform: "darwin", architecture: "arm64", nvidiaAvailable: false }), "mlx");
	assert.equal(selectOcrBackend({ platform: "linux", architecture: "x64", nvidiaAvailable: true }), "sglang");
	assert.equal(selectOcrBackend({ platform: "win32", architecture: "x64", nvidiaAvailable: false }), "external");
	assert.equal(selectOcrBackend({ platform: "linux", architecture: "x64", nvidiaAvailable: false, override: "mlx" }), "mlx");
	assert.throws(() => selectOcrBackend({ override: "cuda" }), /must be sglang or mlx/);
});

test("signed release packaging works from a different caller cwd", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-release-cwd-"));
	const { privateKey } = generateKeyPairSync("ed25519");
	const keyPath = join(root, "release-key.pem");
	await writeFile(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
	const previousCwd = process.cwd();
	process.chdir(root);
	try {
		const release = await buildSignedRelease(join(root, "release"), keyPath);
		assert.ok((await stat(release.artifact)).isFile());
	} finally {
		process.chdir(previousCwd);
	}
});

test("failed release packaging removes its staging directory", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-release-cleanup-"));
	const { privateKey } = generateKeyPairSync("ed25519");
	const keyPath = join(root, "release-key.pem");
	await writeFile(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
	const previousNpmExecPath = process.env.npm_execpath;
	process.env.npm_execpath = join(root, "missing-npm-cli.js");
	try {
		await assert.rejects(() => buildSignedRelease(join(root, "release"), keyPath));
	} finally {
		if (previousNpmExecPath === undefined) delete process.env.npm_execpath;
		else process.env.npm_execpath = previousNpmExecPath;
	}
	assert.deepEqual((await readdir(root)).filter((entry) => entry.includes(".codetonomy-")), []);
});

test("signed release verification rejects manifest schema tampering", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-release-manifest-"));
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const keyPath = join(root, "release-key.pem");
	const trustedKeyPath = join(root, "trusted-release-key.pem");
	await writeFile(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
	await writeFile(trustedKeyPath, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o644 });
	const release = await buildSignedRelease(join(root, "release"), keyPath);
	const originalManifest = JSON.parse(await readFile(release.manifest, "utf8")) as Record<string, unknown>;
	const runtime = originalManifest.runtime as Record<string, unknown>;
	for (const tamper of [
		{ schemaVersion: 2 },
		{ name: "other-package" },
		{ version: "9.9.9" },
		{ referencesLockSha256: "invalid" },
		{ signatureAlgorithm: "RSA-SHA256" },
		{ runtime: { ...runtime, node: "not-a-node-version" } },
		{ unexpected: true },
	]) {
		const manifestBytes = Buffer.from(`${JSON.stringify({ ...originalManifest, ...tamper }, null, 2)}\n`);
		await writeFile(release.manifest, manifestBytes);
		await writeFile(release.signature, sign(null, manifestBytes, privateKey).toString("base64url"));
		await assert.rejects(() => verifySignedRelease(release.directory, trustedKeyPath), /Release manifest is invalid/);
	}
});

test("an installed verifier accepts a correctly signed newer release", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-release-upgrade-"));
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const keyPath = join(root, "release-key.pem");
	const trustedKeyPath = join(root, "trusted-release-key.pem");
	await writeFile(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
	await writeFile(trustedKeyPath, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o644 });
	const release = await buildSignedRelease(join(root, "release"), keyPath);
	const manifest = JSON.parse(await readFile(release.manifest, "utf8")) as Record<string, unknown>;
	const upgradedArtifact = "codetonomy-99.0.0.tgz";
	await rename(release.artifact, join(release.directory, upgradedArtifact));
	const manifestBytes = Buffer.from(`${JSON.stringify({
		...manifest,
		version: "99.0.0",
		artifact: upgradedArtifact,
		referencesLockSha256: "0".repeat(64),
	}, null, 2)}\n`);
	await writeFile(release.manifest, manifestBytes);
	await writeFile(release.signature, sign(null, manifestBytes, privateKey).toString("base64url"));
	assert.equal((await verifySignedRelease(release.directory, trustedKeyPath)).artifact, join(release.directory, upgradedArtifact));
});

test("signed release installs as a self-contained Codetonomy command", async () => {
	const root = await mkdtemp(join(tmpdir(), "codetonomy-release-"));
	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const keyPath = join(root, "release-key.pem");
	const trustedKeyPath = join(root, "trusted-release-key.pem");
	await writeFile(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
	await writeFile(trustedKeyPath, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o644 });
	const release = await buildSignedRelease(join(root, "release"), keyPath);
	const listing = (await run("tar", ["-tzf", release.artifact], { timeout: 30_000 })).stdout;
	assert.match(listing, /deployment\/worker-versions\.env/);
	assert.match(listing, /docs\/production-readiness\.md/);
	assert.match(listing, /THIRD_PARTY_LICENSES\.md/);
	assert.match(listing, /scripts\/bootstrap-workers\.sh/);
	assert.match(listing, /scripts\/bootstrap-workers\.mjs/);
	assert.match(listing, /scripts\/worker-common\.mjs/);
	assert.match(listing, /scripts\/ocr-backend\.mjs/);
	assert.match(listing, /scripts\/run-ocr-workers\.sh/);
	assert.match(listing, /scripts\/run-ocr-workers\.mjs/);
	assert.match(listing, /scripts\/test-ocr\.sh/);
	assert.match(listing, /scripts\/test-ocr\.mjs/);
	assert.match(listing, /services\/perception-ocr\/requirements-mlx\.txt/);
	assert.match(listing, /services\/spreadsheet-worker\/worker\.py/);
	assert.match(listing, /services\/presentation-worker\/worker\.py/);
	assert.match(listing, /services\/backtesting-worker\/worker\.py/);
	assert.doesNotMatch(listing, /__pycache__|\.pyc$|\.whl$|\.safetensors$|\.gguf$/m);
	const launcher = await readFile(join(process.cwd(), "scripts", "run-ocr-workers.sh"), "utf8");
	assert.doesNotMatch(launcher, /--api-key/);
	assert.match(launcher, /args\.api_key = os\.environ\["OCR_UPSTREAM_API_KEY"\]/);
	assert.match(launcher, /export UNLIMITED_OCR_MODEL UNLIMITED_OCR_MODEL_REVISION UNLIMITED_OCR_SERVED_MODEL/);
	assert.match(launcher, /kill_process_tree\(os\.getpid\(\), include_parent=False\)/);
	const manifest = await readFile(release.manifest);
	const signature = Buffer.from(await readFile(release.signature, "utf8"), "base64url");
	assert.equal(verify(null, manifest, publicKey, signature), true);
	assert.equal((await verifySignedRelease(release.directory, trustedKeyPath)).artifact, release.artifact);
	const attacker = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
	await writeFile(release.publicKey, attacker);
	assert.equal((await verifySignedRelease(release.directory, trustedKeyPath)).artifact, release.artifact);
	const attackerKeyPath = join(root, "attacker-key.pem");
	await writeFile(attackerKeyPath, attacker);
	await assert.rejects(() => verifySignedRelease(release.directory, attackerKeyPath), /signature is invalid/);
	await assert.rejects(() => buildSignedRelease(release.directory, keyPath), /already exists/);
	const install = join(root, "install");
	const npmCli = process.env.npm_execpath || join(process.execPath, "..", "node_modules", "npm", "bin", "npm-cli.js");
	await run(process.execPath, [npmCli, "install", "--prefix", install, "--ignore-scripts", "--no-audit", "--no-fund", release.artifact], { timeout: 180_000, env: { ...process.env, npm_config_cache: join(root, "npm-cache") } });
	const command = join(install, "node_modules", "codetonomy", "dist", "Codetonomy.js");
	const execute = (args: string[], options: Parameters<typeof run>[2] = {}) => run(process.execPath, [command, ...args], options);
	const result = await execute(["--help"], { timeout: 30_000 });
	assert.match(result.stdout, /Codetonomy setup/);
	assert.doesNotMatch(result.stderr, /SQLite is an experimental feature/);
	assert.match((await execute(["verify-release", release.directory, "--public-key", trustedKeyPath], { timeout: 30_000 })).stdout, /Verified/);
	const environment = { ...process.env, CODETONOMY_HOME: join(root, "home") };
	await assert.rejects(() => execute(["setup"], { cwd: root, timeout: 30_000, env: environment }), /interactive TTY/);
	const installedRun = JSON.parse((await execute(["run", "--json", "Return a concise success response"], { cwd: root, timeout: 30_000, env: environment })).stdout) as { runId: string; verification: { passed: boolean } };
	assert.equal(installedRun.verification.passed, true);
	const installedPresentation = JSON.parse((await execute(["run", "--json", "--approve-writes", "Create a presentation output/installed-review.pptx"], { cwd: root, timeout: 60_000, env: environment })).stdout) as { verification: { passed: boolean } };
	assert.equal(installedPresentation.verification.passed, true);
	assert.ok((await stat(join(root, "output", "installed-review.pptx"))).size > 0);
	const evaluation = JSON.parse((await execute(["eval", "--json", "Return a concise success response"], { cwd: root, timeout: 60_000, env: environment })).stdout) as { outcomes: Array<{ variant: string; metrics?: { verified: boolean } }> };
	assert.equal(evaluation.outcomes.length, 6);
	assert.equal(evaluation.outcomes.every(({ metrics }) => metrics?.verified), true);
	const dashboard = spawn(process.execPath, [command, "dashboard", "--port", "0"], { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"] });
	const dashboardUrl = await new Promise<string>((resolveUrl, rejectUrl) => {
		let output = "";
		const timeout = setTimeout(() => rejectUrl(new Error("Installed dashboard did not start")), 10_000);
		dashboard.stdout.setEncoding("utf8");
		dashboard.stdout.on("data", (chunk: string) => {
			output += chunk;
			const match = output.match(/Codetonomy dashboard: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]{32,128})/);
			if (match) { clearTimeout(timeout); resolveUrl(match[1]!); }
		});
		dashboard.once("error", (error) => { clearTimeout(timeout); rejectUrl(error); });
		dashboard.once("exit", (code) => { clearTimeout(timeout); rejectUrl(new Error(`Installed dashboard exited ${code}`)); });
	});
	try {
		const base = new URL(dashboardUrl);
		const token = base.searchParams.get("token");
		assert.ok(token);
		base.search = "";
		assert.equal((await fetch(new URL("/health", base))).status, 200);
		assert.equal((await fetch(new URL("/api/summary", base))).status, 401);
		assert.equal((await fetch(new URL("/api/summary", base), { headers: { authorization: `Bearer ${token}` } })).status, 200);
		assert.match(await (await fetch(dashboardUrl)).text(), /Codetonomy Runs/);
	} finally {
		const exited = once(dashboard, "exit");
		dashboard.kill("SIGTERM");
		await exited;
	}
	assert.match((await execute(["export", installedRun.runId, join(root, "installed-export")], { cwd: root, timeout: 30_000, env: environment })).stdout, /Exported/);
	const backupPath = join(root, "installed-backup.sqlite");
	assert.match((await execute(["backup", backupPath], { cwd: root, timeout: 30_000, env: environment })).stdout, /Backed up/);
	assert.ok((await stat(backupPath)).size > 0);
	assert.match((await execute(["prune", "--days", "0", "--keep", "0", "--confirm-empty"], { cwd: root, timeout: 30_000, env: environment })).stdout, /Removed/);
	assert.match((await execute(["restore", backupPath, "--replace"], { cwd: root, timeout: 30_000, env: environment })).stdout, /Restored/);
	assert.match((await execute(["backup", join(root, "restored-backup.sqlite")], { cwd: root, timeout: 30_000, env: environment })).stdout, /Backed up/);
});
