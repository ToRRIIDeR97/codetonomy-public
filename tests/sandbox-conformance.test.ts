import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { bashTool, createNativeBashArgv, createCodexNetworkSandboxInvocation, createCodexSandboxInvocation, normalizeWorkspaceCommandArgv, resolveCodexBinary } from "../packages/tools/src/index.ts";

const codex = resolveCodexBinary();
const available = spawnSync(codex, ["--version"], { stdio: "ignore" }).status === 0;
const sandboxRequired = process.env.CI === "true" || process.env.CODETONOMY_REQUIRE_SANDBOX === "1";
test("native Codex sandbox permits workspace writes and blocks escape and network", { skip: !available && !sandboxRequired }, async (t) => {
	assert.equal(available, true, `Codex sandbox binary is unavailable: ${codex}`);
	const parent = await mkdtemp(join(process.cwd(), ".codetonomy-sandbox-"));
	const workspace = join(parent, "workspace");
	const configurationDirectory = join(homedir(), `.codetonomy-sandbox-config-${randomUUID()}`);
	const credentials = join(configurationDirectory, "credentials.env");
	const outside = join(homedir(), `.codetonomy-sandbox-escape-${randomUUID()}`);
	t.after(async () => {
		await rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		await rm(configurationDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
		await rm(outside, { force: true });
	});
	await mkdir(workspace);
	await mkdir(configurationDirectory);
	await writeFile(credentials, "SECRET=not-readable\n", { mode: 0o600 });
	await writeFile(join(workspace, "sandbox-runtime.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; test('runtime', () => assert.equal(2 + 2, 4));\n");
	const invocation = (argv: string[]) => {
		const previous = process.env.CODETONOMY_HOME;
		process.env.CODETONOMY_HOME = configurationDirectory;
		try { return createCodexSandboxInvocation(workspace, argv); }
		finally {
			if (previous === undefined) delete process.env.CODETONOMY_HOME;
			else process.env.CODETONOMY_HOME = previous;
		}
	};
	const run = (argv: string[]) => spawnSync(codex, invocation(argv), {
		cwd: workspace,
		encoding: "utf8",
		timeout: 10_000,
	});

	const state = JSON.parse(invocation([process.execPath])[2]!) as {
		permissionProfile: { network: string; file_system: { entries: Array<{ access: string; path: { type: string; path?: string; value?: { kind?: string } } }> } };
	};
	assert.equal(state.permissionProfile.network, "restricted");
	assert.ok(state.permissionProfile.file_system.entries.some(({ access, path }) => access === "read" && path.value?.kind === "minimal"));
	assert.equal(state.permissionProfile.file_system.entries.some(({ access, path }) => access !== "deny" && path.path === credentials), false);
	assert.ok(state.permissionProfile.file_system.entries.some(({ access, path }) => access === "deny" && path.path === configurationDirectory));

	const inside = run([process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], 'ok')", "inside.txt"]);
	assert.equal(inside.status, 0, inside.stderr || inside.stdout);
	assert.equal(await readFile(join(workspace, "inside.txt"), "utf8"), "ok");

	const escaped = run([process.execPath, "-e", "require('node:fs').writeFileSync(process.argv[1], 'no')", outside]);
	assert.notEqual(escaped.status, 0);
	assert.equal(existsSync(outside), false);

	const network = run([process.execPath, "-e", "const s=require('node:net').connect(80,'1.1.1.1');s.setTimeout(2000);s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(1));s.on('timeout',()=>process.exit(1))"]);
	assert.notEqual(network.status, 0);

	const sensitiveRead = run([process.execPath, "-e", "try{process.exit(require('node:fs').readFileSync(process.argv[1],'utf8').includes('SECRET=not-readable')?1:0)}catch{process.exit(0)}", credentials]);
	assert.equal(sensitiveRead.status, 0, sensitiveRead.stderr || sensitiveRead.stdout);

	const toolchain = run([process.execPath, "-e", "import('./sandbox-runtime.test.mjs')"]);
	assert.equal(toolchain.status, 0, toolchain.stderr || toolchain.stdout);
	if (process.platform === "win32") {
		const npm = run(normalizeWorkspaceCommandArgv(["npm", "--version"]));
		assert.equal(npm.status, 0, npm.stderr || npm.stdout);
		assert.match(npm.stdout, /^\d+\.\d+\.\d+/);
	}
});

test("native Codex full-access invocation serializes the unrestricted profile", { skip: !available && !sandboxRequired }, () => {
	assert.equal(available, true, `Codex sandbox binary is unavailable: ${codex}`);
	const root = tmpdir();
	const command = [process.execPath, "-e", "console.log('ok')"];
	const invocation = createCodexSandboxInvocation(root, command, { commandSandboxMode: "full-access" });
	const state = JSON.parse(invocation[2]!) as { permissionProfile: { type: string } };
	assert.equal(state.permissionProfile.type, "disabled");
	assert.equal(invocation.includes("--sandbox-state-disable-network"), false);
	assert.deepEqual(invocation.slice(-4), ["--", ...command]);
	const executed = spawnSync(codex, invocation, { cwd: root, encoding: "utf8", timeout: 10_000 });
	assert.equal(executed.status, 0, executed.stderr || executed.stdout);
	assert.match(executed.stdout, /ok/);
});

test("native Codex read-only sandbox permits inspection and blocks workspace writes", { skip: !available && !sandboxRequired }, async (t) => {
	assert.equal(available, true, `Codex sandbox binary is unavailable: ${codex}`);
	const parent = await mkdtemp(join(process.cwd(), ".codetonomy-read-only-sandbox-"));
	const workspace = join(parent, "workspace");
	await mkdir(workspace);
	await writeFile(join(workspace, "evidence.txt"), "readable\n");
	t.after(() => rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
	const invocation = (argv: string[]) => createCodexSandboxInvocation(workspace, argv, { commandSandboxMode: "read-only" });
	const state = JSON.parse(invocation([process.execPath])[2]!) as {
		permissionProfile: { file_system: { entries: Array<{ access: string; path: { value?: { kind?: string } } }> } };
	};
	assert.ok(state.permissionProfile.file_system.entries.some(({ access, path }) => access === "read" && path.value?.kind === "project_roots"));

	const inspected = spawnSync(codex, invocation([process.execPath, "-e", "process.exit(require('node:fs').readFileSync('evidence.txt','utf8') === 'readable\\n' ? 0 : 2)"]), {
		cwd: workspace,
		encoding: "utf8",
		timeout: 10_000,
	});
	assert.equal(inspected.status, 0, inspected.stderr || inspected.stdout);

	const write = spawnSync(codex, invocation([process.execPath, "-e", "require('node:fs').writeFileSync('forbidden.txt','no')"]), {
		cwd: workspace,
		encoding: "utf8",
		timeout: 10_000,
	});
	assert.notEqual(write.status, 0);
	assert.equal(existsSync(join(workspace, "forbidden.txt")), false);
});

test("network-restricted sandbox permits only parent-visible loopback service traffic", { skip: !available && !sandboxRequired }, async () => {
	assert.equal(available, true, `Codex sandbox binary is unavailable: ${codex}`);
	const root = await mkdtemp(join(tmpdir(), "codetonomy-loopback-sandbox-"));
	const command = [process.execPath, "-e", `
const server = require("node:http").createServer((_request, response) => {
  response.end("ok");
  server.close();
});
server.listen(0, "127.0.0.1", () => console.log("PORT=" + server.address().port));
setTimeout(() => process.exit(2), 10_000).unref();
`];
	if (process.platform === "linux") {
		assert.throws(
			() => createCodexNetworkSandboxInvocation(root, command, { read: [root], write: [root] }),
			/unavailable on Linux.*cannot allow local binding while denying outbound network access/,
		);
		return;
	}
	const invocation = createCodexNetworkSandboxInvocation(root, command, { read: [root], write: [root] });
	const state = JSON.parse(invocation[2]!) as { permissionProfile: { network: string; file_system: { entries: Array<{ access: string; path: { type?: string; path?: string } }> } } };
	assert.equal(state.permissionProfile.network, "restricted");
	assert.equal(state.permissionProfile.file_system.entries.some(({ path }) => path.type === "special"), process.platform !== "win32");
	const codexDirectory = dirname(codex);
	const codexInstallation = basename(codexDirectory) === ".bin" ? dirname(codexDirectory) : codexDirectory;
	assert.ok(state.permissionProfile.file_system.entries.some(({ access, path }) => access === "read" && path.path === dirname(process.execPath)));
	if (process.platform === "win32") assert.equal(state.permissionProfile.file_system.entries.some(({ path }) => path.path === codexInstallation), false);
	if (process.platform === "darwin") assert.ok(state.permissionProfile.file_system.entries.some(({ access, path }) => access === "read" && path.path === codexInstallation));
	if (process.platform === "darwin") assert.ok(state.permissionProfile.file_system.entries.some(({ path }) => path.path === "/System/Library/OpenSSL"));
	assert.ok(invocation.includes("--sandbox-state-disable-network"));
	if (process.platform === "darwin") {
		assert.ok(invocation.includes("features.network_proxy.allow_local_binding=true"));
		assert.ok(invocation.includes("features.network_proxy.allow_upstream_proxy=false"));
	}
	const child = spawn(codex, invocation, { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
	let output = "";
	let errorOutput = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => { errorOutput += chunk; });
	try {
		const port = await new Promise<number>((resolvePort, rejectPort) => {
			const timer = setTimeout(() => rejectPort(new Error(`Sandboxed loopback server did not start: ${errorOutput}`)), 10_000);
			child.stdout.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				output += chunk;
				const match = output.match(/PORT=(\d+)/);
				if (match) { clearTimeout(timer); resolvePort(Number(match[1])); }
			});
			child.once("exit", (code) => { clearTimeout(timer); rejectPort(new Error(`Sandboxed loopback server exited ${code}: ${errorOutput}`)); });
		});
		assert.equal(await (await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(2_000) })).text(), "ok");
		const [exitCode] = await once(child, "exit");
		assert.equal(exitCode, 0, errorOutput);
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL");
	}
});

test("Bash rg fallback preserves matches and read-only enforcement", { skip: !available && !sandboxRequired }, async t => {
 const argv = createNativeBashArgv("command -v rg");
 if (spawnSync(argv[0]!, argv.slice(1), { stdio: "ignore" }).status !== 0) { t.skip("Native Bash/rg unavailable"); return; }
 const parent = await mkdtemp(join(tmpdir(), "codetonomy-bash-sandbox-"));
 const root = join(parent, "workspace");
 await mkdir(root);
 t.after(() => rm(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
 await writeFile(join(root, "evidence.txt"), "alpha\nbeta\n");
 const tool = bashTool(root, { commandSandboxMode: "read-only", codexBinary: codex });
 const matched = await tool.execute("patterns", { command: "rg -F -e alpha -e beta evidence.txt" });
 assert.equal((matched.details as { exitCode: number }).exitCode, 0);
 assert.equal(matched.content[0]?.type === "text" ? matched.content[0].text : "", "alpha\nbeta\n");
 const denied = await tool.execute("write", { command: "rg --files > forbidden.txt" });
 assert.notEqual((denied.details as { exitCode: number }).exitCode, 0);
 assert.equal(existsSync(join(root, "forbidden.txt")), false);
 await assert.rejects(tool.execute("escape", { command: "cat ../outside.txt" }), /escapes the workspace/);
});
