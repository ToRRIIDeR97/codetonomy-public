import { randomBytes, createHash } from "node:crypto";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { access, lstat, mkdir, readFile, realpath, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { OcrHttpService, type DocumentParseOptions } from "@agent-harness/document-ir";
import type { HybridGraphMemory } from "@agent-harness/memory-client";
import { writePrivateFile } from "./config.js";

const ENDPOINT = "http://127.0.0.1:8420";
const PROJECT_SETTINGS = ".codetonomy/project-settings.json";
const STARTUP_TIMEOUT_MS = 30_000;
const STARTUP_OUTPUT_LIMIT = 32 * 1024;
const GATEWAY_BOOTSTRAP = `
import { closeSync, openSync, readdirSync, writeFileSync } from "node:fs";
import { Server } from "node:net";
import { join } from "node:path";
const sourceRoot = process.env.CODETONOMY_MEMORY_SOURCE_ROOT;
if (!sourceRoot) throw new Error("memoryDB source root is missing");
const privateRoot = process.env.CODETONOMY_MEMORY_PRIVATE_ROOT;
if (!privateRoot) throw new Error("memoryDB private configuration root is missing");
const mustBeUnreadable = (probe) => {
  try { probe(); }
  catch { return; }
  throw new Error("memoryDB sandbox can read the private Codetonomy configuration");
};
mustBeUnreadable(() => readdirSync(privateRoot));
mustBeUnreadable(() => {
  const handle = openSync(join(privateRoot, "credentials.env"), "r");
  closeSync(handle);
});
process.chdir(sourceRoot);
const readyFile = process.env.CODETONOMY_MEMORY_READY_FILE;
const readyToken = process.env.CODETONOMY_MEMORY_READY_TOKEN;
if (!readyFile || !readyToken) throw new Error("memoryDB readiness channel is missing");
const persistIdentity = (ready, flag, exitCode) => writeFileSync(
  readyFile,
  JSON.stringify({ token: readyToken, pid: process.pid, ready, ...(Number.isInteger(exitCode) ? { exitCode } : {}) }),
  { encoding: "utf8", flag, mode: 0o600 },
);
persistIdentity(false, "wx");
process.once("exit", (exitCode) => persistIdentity(false, "w", exitCode));
const originalListen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  this.once("listening", () => {
    const address = this.address();
    if (address && typeof address === "object" && address.port === 8420) persistIdentity(true, "w");
  });
  return Reflect.apply(originalListen, this, args);
};
await import(process.argv[1]);
`;
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const runFile = promisify(execFile);

const BASE_ENVIRONMENT = new Set([
	"APPDATA", "COMSPEC", "HOME", "LANG", "LC_ALL", "LOCALAPPDATA", "PATH", "PATHEXT",
	"PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "SHELL", "SYSTEMDRIVE", "SYSTEMROOT",
	"TEMP", "TMP", "TMPDIR", "TZ", "USERPROFILE", "WINDIR",
]);
const INSTALL_ENVIRONMENT = new Set([
	...BASE_ENVIRONMENT,
	"ALL_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE",
	"NPM_CONFIG_CACHE", "NPM_CONFIG_REGISTRY", "NPM_EXECPATH",
]);

const inheritedEnvironment = (allowed: ReadonlySet<string>): NodeJS.ProcessEnv => Object.fromEntries(
	Object.entries(process.env).filter(([key, value]) => value !== undefined && allowed.has(key.toUpperCase())),
);

const LOCAL_CONFIG = `deployMode: standalone
stateBackend: local
server:
  port: 8420
  host: 127.0.0.1
memory:
  extraction:
    enabled: false
  storeBackend: sqlite
  embedding:
    provider: none
  bm25:
    enabled: true
    language: en
skill:
  enabled: false
llm:
  provider: openai
  baseUrl: http://127.0.0.1:9/v1
  apiKey: ""
  model: disabled
  timeoutMs: 1000
`;

const projectSettingsPath = async (workspaceRoot: string, create: boolean): Promise<string> => {
	const workspace = await realpath(workspaceRoot);
	const directory = join(workspace, ".codetonomy");
	try {
		const info = await lstat(directory);
		if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Project .codetonomy path must be a real directory");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return join(workspace, PROJECT_SETTINGS);
			throw error;
		}
		await mkdir(directory, { mode: 0o700 });
	}
	return join(workspace, PROJECT_SETTINGS);
};

export async function loadMemoryDbEnabled(workspaceRoot: string): Promise<boolean> {
	const path = await projectSettingsPath(workspaceRoot, false);
	try {
		const info = await lstat(path);
		if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4_096) throw new Error("Invalid project settings file");
		const parsed = JSON.parse(await readFile(path, "utf8")) as { version?: unknown; memoryDB?: unknown };
		if (parsed.version !== 1 || typeof parsed.memoryDB !== "boolean") throw new Error("Invalid project settings file");
		return parsed.memoryDB;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

export async function saveMemoryDbEnabled(workspaceRoot: string, enabled: boolean): Promise<void> {
	const path = await projectSettingsPath(workspaceRoot, true);
	await writePrivateFile(path, `${JSON.stringify({ version: 1, memoryDB: enabled }, null, 2)}\n`);
}

const limitedResponseText = async (response: Response, limit = 16 * 1024): Promise<string> => {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > limit) {
			await reader.cancel();
			throw new Error("memoryDB health response exceeded the size limit");
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
};

type GatewayHealth = "absent" | "degraded" | "ready" | "occupied";

async function gatewayHealth(signal?: AbortSignal): Promise<GatewayHealth> {
	let health: Response;
	try {
		health = await fetch(`${ENDPOINT}/health`, {
			redirect: "manual",
			signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(500)]),
		});
	} catch (error) {
		if (signal?.aborted) throw error;
		return "absent";
	}
	if (!health.ok) return "occupied";
	try {
		const document = JSON.parse(await limitedResponseText(health)) as Record<string, unknown>;
		if (
			(document.status !== "ok" && document.status !== "degraded")
			|| typeof document.version !== "string"
			|| typeof document.stores !== "object"
			|| document.stores === null
		) return "occupied";
		return document.status === "ok" ? "ready" : "degraded";
	} catch {
		return "occupied";
	}
}

const gatewayHasListener = (signal?: AbortSignal): Promise<boolean> => new Promise((resolveListener, reject) => {
	const socket = createConnection({ host: "127.0.0.1", port: 8420 });
	let settled = false;
	const finish = (result: boolean): void => {
		if (settled) return;
		settled = true;
		signal?.removeEventListener("abort", abort);
		socket.destroy();
		resolveListener(result);
	};
	const abort = (): void => {
		if (settled) return;
		settled = true;
		socket.destroy();
		reject(new Error("memoryDB startup aborted"));
	};
	if (signal?.aborted) { abort(); return; }
	signal?.addEventListener("abort", abort, { once: true });
	socket.setTimeout(500, () => finish(true));
	socket.once("connect", () => finish(true));
	socket.once("error", (error: NodeJS.ErrnoException) => finish(error.code !== "ECONNREFUSED"));
});

const waitForDelay = (milliseconds: number, signal?: AbortSignal): Promise<void> => new Promise((resolveWait, reject) => {
	const abort = () => {
		clearTimeout(timer);
		reject(new Error("memoryDB startup aborted"));
	};
	const timer = setTimeout(() => {
		signal?.removeEventListener("abort", abort);
		resolveWait();
	}, milliseconds);
	signal?.addEventListener("abort", abort, { once: true });
});

const startupError = (message: string, output: () => string, secrets: readonly string[]): Error => {
	const detail = secrets.reduce((text, secret) => text.replaceAll(secret, "[redacted]"), output().trim()).slice(-4_000);
	return new Error(`${message}${detail ? `\nmemoryDB output:\n${detail}` : ""}`);
};

async function waitUntilReady(child: ChildProcess, sidecarStatus: () => Promise<{ identified: boolean; ready: boolean; exitCode?: number }>, secrets: readonly string[], output: () => string, signal?: AbortSignal): Promise<void> {
	const deadline = Date.now() + STARTUP_TIMEOUT_MS;
	let spawnError: Error | undefined;
	child.once("error", (error) => { spawnError = error; });
	while (Date.now() < deadline) {
		if (signal?.aborted) throw startupError("memoryDB startup aborted", output, secrets);
		if (spawnError) throw startupError(`TencentDB memory service failed to start: ${spawnError.message}`, output, secrets);
		const sidecar = await sidecarStatus();
		if (sidecar.exitCode !== undefined) throw startupError(`TencentDB memory service exited during startup (${sidecar.exitCode})`, output, secrets);
		if (child.exitCode !== null && !sidecar.identified) throw startupError(`TencentDB memory service exited during startup (${child.exitCode})`, output, secrets);
		const remaining = deadline - Date.now();
		try {
			const health = await gatewayHealth(AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(remaining)]));
			if ((health === "ready" || health === "degraded") && sidecar.ready) return;
			if (health === "occupied") throw startupError("Port 8420 returned an invalid memoryDB health response", output, secrets);
		} catch (error) {
			if (signal?.aborted) throw startupError("memoryDB startup aborted", output, secrets);
			if (Date.now() >= deadline) break;
			if (error instanceof Error && error.message.startsWith("Port 8420")) throw error;
		}
		await waitForDelay(Math.min(200, Math.max(0, deadline - Date.now())), signal);
	}
	throw startupError(`TencentDB memory service did not become ready within ${STARTUP_TIMEOUT_MS / 1_000} seconds`, output, secrets);
}

const waitForClose = (child: ChildProcess, milliseconds: number): Promise<boolean> => new Promise((resolveClose) => {
	if (child.exitCode !== null) { resolveClose(true); return; }
	const closed = () => { clearTimeout(timer); resolveClose(true); };
	const timer = setTimeout(() => { child.removeListener("close", closed); resolveClose(false); }, milliseconds);
	timer.unref();
	child.once("close", closed);
});

const processIsAlive = (pid: number): boolean => {
	try { process.kill(pid, 0); return true; }
	catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};

const waitForPidExit = async (pid: number, milliseconds: number): Promise<boolean> => {
	const deadline = Date.now() + milliseconds;
	while (Date.now() < deadline) {
		if (!processIsAlive(pid)) return true;
		await waitForDelay(50);
	}
	return !processIsAlive(pid);
};

async function stopPidTree(pid: number): Promise<void> {
	if (!processIsAlive(pid)) return;
	try {
		if (process.platform === "win32") await runFile("taskkill", ["/PID", String(pid), "/T"], { windowsHide: true });
		else process.kill(-pid, "SIGTERM");
	} catch {
		try { process.kill(pid, "SIGTERM"); } catch { /* The process is already gone. */ }
	}
	if (await waitForPidExit(pid, 2_000)) return;
	try {
		if (process.platform === "win32") await runFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
		else process.kill(-pid, "SIGKILL");
	} catch {
		try { process.kill(pid, "SIGKILL"); } catch { /* The process is already gone. */ }
	}
	if (!await waitForPidExit(pid, 2_000)) throw new Error("memoryDB sidecar process tree did not stop");
}

async function stopChildTree(child: ChildProcess): Promise<void> {
	if (!child.pid) return;
	if (child.exitCode !== null) {
		if (process.platform === "win32") {
			try { await runFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }); }
			catch { /* Windows may already have discarded the exited root's process tree. */ }
		} else {
			try { process.kill(-child.pid, "SIGKILL"); } catch { /* The process group is already gone. */ }
		}
		return;
	}
	try {
		if (process.platform === "win32") {
			await runFile("taskkill", ["/PID", String(child.pid), "/T"], { windowsHide: true });
		} else {
			process.kill(-child.pid, "SIGTERM");
		}
	} catch { /* It may have exited between the checks. */ }
	if (process.platform === "win32" && child.exitCode === null) {
		try { child.kill("SIGTERM"); } catch { /* It may have exited between the checks. */ }
	}
	if (await waitForClose(child, 2_000)) return;
	try {
		if (process.platform === "win32") {
			await runFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
		} else {
			process.kill(-child.pid, "SIGKILL");
		}
	} catch { /* The process tree is already gone. */ }
	if (process.platform === "win32" && child.exitCode === null) {
		try { child.kill("SIGKILL"); } catch { /* It may have exited between the checks. */ }
	}
	if (!await waitForClose(child, 2_000)) throw new Error("memoryDB sidecar did not stop");
}

export interface MemoryDbIntegration {
	workspaceSearch: { search(query: string, options: { path: string; limit: number; signal?: AbortSignal }): ReturnType<HybridGraphMemory["searchWorkspace"]> };
	index(signal?: AbortSignal, onProgress?: Parameters<HybridGraphMemory["indexWorkspace"]>[1]): Promise<{ files: number; chunks: number }>;
	close(): Promise<void>;
}

const findMemoryWorker = async (roots: readonly string[]): Promise<string | undefined> => {
	for (const root of roots) {
		const candidate = join(root, "tencent-agent-memory", "MemoryCore");
		try {
			await Promise.all([
				access(join(candidate, "src", "gateway", "server.ts")),
				access(join(candidate, "node_modules", "tsx", "dist", "loader.mjs")),
				runFile(process.execPath, [join(candidate, "node_modules", "esbuild", "bin", "esbuild"), "--version"], { env: inheritedEnvironment(BASE_ENVIRONMENT), timeout: 5_000 }),
				runFile(process.execPath, ["-e", "require('@node-rs/jieba')"], { cwd: candidate, env: inheritedEnvironment(BASE_ENVIRONMENT), timeout: 5_000 }),
			]);
			return candidate;
		}
		catch { /* Try the next managed location. */ }
	}
	return undefined;
};

export async function ensureMemoryWorker(roots: readonly string[], install: () => Promise<void>): Promise<string> {
	const existing = await findMemoryWorker(roots);
	if (existing) return existing;
	await install();
	const installed = await findMemoryWorker(roots);
	if (!installed) throw new Error("Automatic memoryDB worker installation completed without a usable worker");
	return installed;
}

const managedCodexPath = (root: string): string => {
	if (process.platform !== "win32") return join(root, "codex", "node_modules", ".bin", "codex");
	const packageName = process.arch === "arm64" ? "codex-win32-arm64" : "codex-win32-x64";
	const target = process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
	return join(root, "codex", "node_modules", "@openai", packageName, "vendor", target, "bin", "codex.exe");
};

const usableCodexSandbox = async (candidate: string): Promise<boolean> => {
	try {
		const { stdout } = await runFile(candidate, ["sandbox", "--help"], {
			env: inheritedEnvironment(BASE_ENVIRONMENT),
			timeout: 5_000,
			windowsHide: true,
		});
		return stdout.includes("--sandbox-state-json") && stdout.includes("--sandbox-state-disable-network");
	} catch { return false; }
};

export async function ensureMemorySandbox(roots: readonly string[], install: () => Promise<void>): Promise<string> {
	const explicit = process.env.CODETONOMY_CODEX_BIN?.trim();
	if (explicit) {
		const candidate = resolve(explicit);
		if (!await usableCodexSandbox(candidate)) throw new Error("CODETONOMY_CODEX_BIN does not support the required native network sandbox");
		return candidate;
	}
	for (const root of roots) {
		const candidate = managedCodexPath(root);
		if (await usableCodexSandbox(candidate)) return candidate;
	}
	await install();
	const installed = managedCodexPath(roots[0]!);
	if (!await usableCodexSandbox(installed)) throw new Error("Automatic memoryDB sandbox installation completed without a usable Codex runtime");
	return installed;
}

const installManagedWorker = async (configurationDirectory: string, workerRoot: string, action: "install-memory" | "install-codex", signal?: AbortSignal): Promise<void> => {
	const moduleDirectory = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		resolve(moduleDirectory, "../../../scripts/bootstrap-workers.mjs"),
		resolve(moduleDirectory, "../scripts/bootstrap-workers.mjs"),
	];
	let script: string | undefined;
	for (const candidate of candidates) {
		try { await access(candidate); script = candidate; break; }
		catch { /* Source and packaged layouts differ. */ }
	}
	if (!script) throw new Error("Codetonomy's bundled worker installer is missing");
	try {
		await runFile(process.execPath, [script, action], {
			signal,
			maxBuffer: 4 * 1024 * 1024,
			env: { ...inheritedEnvironment(INSTALL_ENVIRONMENT), CODETONOMY_HOME: configurationDirectory, CODETONOMY_WORKER_ROOT: workerRoot },
		});
	} catch (error) {
		const detail = error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string"
			? error.stderr.trim().slice(-4_000)
			: error instanceof Error ? error.message : String(error);
		throw new Error(`Automatic memoryDB ${action === "install-codex" ? "sandbox" : "worker"} installation failed${detail ? `: ${detail}` : ""}`, { cause: error });
	}
};

export async function startMemoryDb(options: {
	configurationDirectory: string;
	workspaceRoot: string;
	sessionId: string;
	documentOptions?: DocumentParseOptions;
	signal?: AbortSignal;
	onStatus?: (message: string) => void;
}): Promise<MemoryDbIntegration> {
	if (await gatewayHasListener(options.signal)) {
		throw new Error("memoryDB or another service is already running on port 8420; close it and try again");
	}
	if (process.platform === "linux") {
		throw new Error("memoryDB is unavailable on Linux until its loopback sidecar can be isolated from outbound network access; no worker was started");
	}
	const configurationDirectory = resolve(options.configurationDirectory);
	const runtimeDirectory = join(dirname(configurationDirectory), `${basename(configurationDirectory)}-memorydb`);
	const workerRoots = process.env.CODETONOMY_WORKER_ROOT?.trim()
		? [resolve(process.env.CODETONOMY_WORKER_ROOT)]
		: [join(runtimeDirectory, "workers")];
	const installRoot = workerRoots[0]!;
	const sourceRoot = await ensureMemoryWorker(workerRoots, async () => {
		options.onStatus?.("Installing the local memoryDB runtime (first use only)");
		await installManagedWorker(configurationDirectory, installRoot, "install-memory", options.signal);
		options.onStatus?.("Local memoryDB runtime installed");
	});
	const sandboxBinary = await ensureMemorySandbox(workerRoots, async () => {
		options.onStatus?.("Installing the native memoryDB network sandbox (first use only)");
		await installManagedWorker(configurationDirectory, installRoot, "install-codex", options.signal);
		options.onStatus?.("Native memoryDB network sandbox installed");
	});
	const server = join(sourceRoot, "src", "gateway", "server.ts");
	const token = randomBytes(32).toString("hex");
	if (await gatewayHasListener(options.signal)) {
		throw new Error("memoryDB or another service is already running on port 8420; close it and try again");
	}
	const dataDirectory = join(runtimeDirectory, "data");
	await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
	const gatewayConfig = join(dataDirectory, "gateway.yaml");
	await writePrivateFile(gatewayConfig, LOCAL_CONFIG);
	const readyToken = randomBytes(32).toString("hex");
	const readyFile = join(dataDirectory, `.gateway-ready-${randomBytes(16).toString("hex")}`);
	let sidecarPid: number | undefined;
	const sidecarStatus = async (): Promise<{ identified: boolean; ready: boolean; exitCode?: number }> => {
		try {
			const info = await lstat(readyFile);
			if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 256) return { identified: false, ready: false };
			const identity = JSON.parse(await readFile(readyFile, "utf8")) as Record<string, unknown>;
			if (identity.token !== readyToken || !Number.isSafeInteger(identity.pid) || (identity.pid as number) <= 0 || identity.pid === process.pid) return { identified: false, ready: false };
			sidecarPid = identity.pid as number;
			return {
				identified: true,
				ready: identity.ready === true,
				...(Number.isSafeInteger(identity.exitCode) ? { exitCode: identity.exitCode as number } : {}),
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return { identified: false, ready: false };
			throw error;
		}
	};
	const { createCodexNetworkSandboxInvocation } = await import("@agent-harness/tools");
	const tsxLoader = pathToFileURL(join(sourceRoot, "node_modules", "tsx", "dist", "loader.mjs")).href;
	const gatewayCommand = [process.execPath, "--import", tsxLoader, "--input-type=module", "--eval", GATEWAY_BOOTSTRAP, pathToFileURL(server).href];
	const sandboxArguments = createCodexNetworkSandboxInvocation(dataDirectory, gatewayCommand, {
		deny: process.platform === "win32" ? [] : [configurationDirectory],
		read: [runtimeDirectory, sourceRoot, gatewayConfig],
		write: [dataDirectory],
	});
	options.onStatus?.("Starting the local memoryDB runtime (cold Windows starts can take up to 30 seconds)");
	let startupOutput = "";
	const rememberOutput = (chunk: Buffer | string): void => {
		startupOutput = `${startupOutput}${chunk.toString()}`.slice(-STARTUP_OUTPUT_LIMIT);
	};
	const child = spawn(sandboxBinary, sandboxArguments, {
		cwd: dataDirectory,
		detached: process.platform !== "win32",
			env: {
			...inheritedEnvironment(BASE_ENVIRONMENT),
			CODETONOMY_MEMORY_PRIVATE_ROOT: configurationDirectory,
			CODETONOMY_MEMORY_READY_FILE: readyFile,
			CODETONOMY_MEMORY_READY_TOKEN: readyToken,
			CODETONOMY_MEMORY_SOURCE_ROOT: sourceRoot,
			NO_PROXY: "127.0.0.1,localhost,::1",
			TEMP: dataDirectory,
			TMP: dataDirectory,
			TMPDIR: dataDirectory,
			TDAI_DATA_DIR: dataDirectory,
			TDAI_GATEWAY_API_KEY: token,
			TDAI_GATEWAY_CONFIG: gatewayConfig,
			TDAI_LLM_API_KEY: "",
			TDAI_LLM_BASE_URL: "http://127.0.0.1:9/v1",
			TDAI_LLM_MODEL: "disabled",
			TDAI_LLM_TIMEOUT_MS: "1000",
		},
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	const stopOnParentExit = (): void => {
		if (sidecarPid) {
			if (process.platform === "win32") {
				try { execFileSync("taskkill", ["/PID", String(sidecarPid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); }
				catch { /* The sidecar is already gone. */ }
			} else {
				try { process.kill(-sidecarPid, "SIGKILL"); }
				catch { try { process.kill(sidecarPid, "SIGKILL"); } catch { /* The sidecar is already gone. */ } }
			}
		} else if (process.platform !== "win32" && child.pid) {
			try { process.kill(-child.pid, "SIGKILL"); } catch { /* The sandbox launcher is already gone. */ }
		}
	};
	process.once("exit", stopOnParentExit);
	child.stdout?.on("data", rememberOutput);
	child.stderr?.on("data", rememberOutput);
	const stopSidecar = async (): Promise<void> => {
		try {
			if (sidecarPid) await stopPidTree(sidecarPid);
		} finally {
			try { await stopChildTree(child); }
			finally {
				process.removeListener("exit", stopOnParentExit);
				await unlink(readyFile).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
			}
		}
	};
	try {
		await waitUntilReady(child, sidecarStatus, [token, readyToken], () => startupOutput, options.signal);
	} catch (error) {
		await stopSidecar();
		throw error;
	}
	options.onStatus?.("Local memoryDB runtime ready");
	const workspace = resolve(options.workspaceRoot);
	const projectId = `project-${hash(workspace).slice(0, 24)}`;
	let memory: HybridGraphMemory;
	try {
		const { HybridGraphMemory, LocalGraphMemory, TencentMemoryAdapter } = await import("@agent-harness/memory-client");
		const local = new LocalGraphMemory({
			workspaceRoot: workspace,
			projectId,
			databasePath: join(options.configurationDirectory, "memory-index", `${projectId}.sqlite`),
			documentOptions: options.documentOptions,
		});
		const remote = new TencentMemoryAdapter({
			endpoint: ENDPOINT,
			apiKey: token,
			serviceId: projectId,
			teamId: projectId,
			agentId: "codetonomy",
			userId: `local-${hash(homedir()).slice(0, 16)}`,
			sessionId: options.sessionId,
		});
		memory = new HybridGraphMemory({ local, remote, projectId });
	} catch (error) {
		await stopSidecar();
		throw error;
	}
	let indexPromise: Promise<{ files: number; chunks: number }> | undefined;
	return {
		workspaceSearch: { search: (query, searchOptions) => memory.searchWorkspace(query, searchOptions) },
		index: (signal, onProgress) => {
			if (indexPromise) return indexPromise;
			indexPromise = memory.indexWorkspace(signal, onProgress).finally(() => { indexPromise = undefined; });
			return indexPromise;
		},
		async close() {
			try { memory.close(); }
			finally { await stopSidecar(); }
		},
	};
}

export function configuredDocumentOptions(configurationDirectory: string): DocumentParseOptions | undefined {
	const endpoint = process.env.CODETONOMY_OCR_URL;
	const apiKey = process.env.CODETONOMY_OCR_TOKEN;
	const ocrModelRevision = process.env.CODETONOMY_OCR_MODEL_REVISION;
	const ocrCodeRevision = process.env.CODETONOMY_OCR_CODE_REVISION;
	if (!endpoint || !apiKey || !ocrModelRevision || !ocrCodeRevision) return undefined;
	return {
		ocr: new OcrHttpService({ endpoint, apiKey, cacheDirectory: join(configurationDirectory, "ocr-cache"), cacheRoot: configurationDirectory }),
		ocrModelRevision,
		ocrCodeRevision,
	};
}
