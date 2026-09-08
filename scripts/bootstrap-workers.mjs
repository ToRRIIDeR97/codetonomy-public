#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { capture, npm, projectRoot, python312, requireFile, run, venvPython, versions, workerRoot } from "./worker-common.mjs";
import { selectOcrBackend } from "./ocr-backend.mjs";

if (process.platform !== "win32") {
	await run("bash", [join(projectRoot, "scripts", "bootstrap-workers.sh"), ...process.argv.slice(2)]);
	process.exit(0);
}

const fail = (message) => { throw new Error(`worker bootstrap: ${message}`); };
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const pinnedFiles = [
	["services/perception-ocr/requirements.txt", "CODETONOMY_OCR_REQUIREMENTS_SHA256"],
	["services/perception-ocr/requirements-mlx.txt", "CODETONOMY_OCR_MLX_REQUIREMENTS_SHA256"],
	["services/perception-ocr/server.py", "CODETONOMY_OCR_ADAPTER_SHA256"],
	["services/spreadsheet-worker/requirements.txt", "CODETONOMY_SPREADSHEET_REQUIREMENTS_SHA256"],
	["services/presentation-worker/requirements.txt", "CODETONOMY_PRESENTATION_REQUIREMENTS_SHA256"],
	["services/backtesting-worker/requirements.txt", "CODETONOMY_BACKTESTING_REQUIREMENTS_SHA256"],
];

function checkPinnedFiles() {
	const references = readFileSync(join(projectRoot, "references.lock.yaml"), "utf8");
	for (const [name, key] of [["codex", "CODETONOMY_CODEX_SOURCE_COMMIT"], ["unlimited_ocr", "UNLIMITED_OCR_COMMIT"], ["tencent_agent_memory", "TENCENT_MEMORY_COMMIT"]]) {
		const commit = references.match(new RegExp(`^  ${name}:\\r?\\n(?:    .+\\r?\\n)*?    commit: ([0-9a-f]+)$`, "m"))?.[1];
		if (commit !== versions[key]) fail(`${name} deployment provenance differs from references.lock.yaml`);
	}
	for (const [relative, key] of pinnedFiles) if (sha256(join(projectRoot, relative)) !== versions[key]) fail(`${relative} checksum mismatch`);
}

const managedCodexDirectory = join(workerRoot, "codex");
const windowsTarget = process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
const windowsPackage = process.arch === "arm64" ? "codex-win32-arm64" : "codex-win32-x64";
const managedCodex = join(managedCodexDirectory, "node_modules", "@openai", windowsPackage, "vendor", windowsTarget, "bin", "codex.exe");

async function checkCodex() {
	const binary = process.env.CODETONOMY_CODEX_BIN || (existsSync(managedCodex) ? managedCodex : "codex");
	let output;
	try { output = await capture(binary, ["--version"]); }
	catch { fail("Codex CLI is missing; run: node scripts/bootstrap-workers.mjs install-codex"); }
	const actual = output.split(/\s+/).at(-1);
	if (actual !== versions.CODETONOMY_CODEX_VERSION) fail(`Codex CLI ${actual} found; expected ${versions.CODETONOMY_CODEX_VERSION}`);
	console.log(`Codex CLI ${actual}: ${binary}`);
}

function checkCodexIntegrity() {
	const lockPath = requireFile(join(managedCodexDirectory, "package-lock.json"), "Managed Codex lockfile is missing");
	const actual = JSON.parse(readFileSync(lockPath, "utf8")).packages?.["node_modules/@openai/codex"]?.integrity;
	if (actual !== versions.CODETONOMY_CODEX_NPM_INTEGRITY) fail("managed Codex package integrity mismatch");
}

async function installCodex() {
	mkdirSync(managedCodexDirectory, { recursive: true });
	await run(npm.program, [...npm.prefix, "install", "--prefix", managedCodexDirectory, "--save-exact", "--no-audit", "--no-fund", `@openai/codex@${versions.CODETONOMY_CODEX_VERSION}`]);
	checkCodexIntegrity();
	await checkCodex();
}

async function prepareRepository(directory, repository, commit) {
	mkdirSync(workerRoot, { recursive: true });
	if (!existsSync(join(directory, ".git"))) {
		if (existsSync(directory)) fail(`${directory} exists but is not a git checkout`);
		await run("git", ["clone", "--filter=blob:none", "--no-checkout", repository, directory]);
	}
	if (await capture("git", ["-C", directory, "remote", "get-url", "origin"]) !== repository) fail(`unexpected origin for ${directory}`);
	try { await capture("git", ["-C", directory, "cat-file", "-e", `${commit}^{commit}`]); }
	catch { await run("git", ["-C", directory, "fetch", "--depth", "1", "origin", commit]); }
	await run("git", ["-C", directory, "-c", "advice.detachedHead=false", "checkout", "--detach", commit]);
}

async function installMemory() {
	const directory = join(workerRoot, "tencent-agent-memory");
	await prepareRepository(directory, versions.TENCENT_MEMORY_REPOSITORY, versions.TENCENT_MEMORY_COMMIT);
	const memoryCore = join(directory, "MemoryCore");
	const hasLockfile = ["package-lock.json", "npm-shrinkwrap.json"].some((name) => existsSync(join(memoryCore, name)));
	await run(npm.program, [
		...npm.prefix,
		hasLockfile ? "ci" : "install",
		"--ignore-scripts",
		"--omit=dev",
		"--legacy-peer-deps",
		"--no-audit",
		"--no-fund",
		...(!hasLockfile ? ["--package-lock=false"] : []),
	], { cwd: memoryCore });
	requireFile(join(directory, "MemoryCore", "node_modules", "tsx", "dist", "loader.mjs"), "TencentDB Agent Memory runtime is missing");
}

async function createVenv(name, requirements) {
	const python = await python312();
	mkdirSync(workerRoot, { recursive: true });
	await run(python.program, [...python.prefix, "-m", "venv", join(workerRoot, name)]);
	await run(venvPython(name), ["-m", "pip", "install", "--disable-pip-version-check", ...requirements.flatMap((path) => ["-r", join(projectRoot, path)])]);
	await run(venvPython(name), ["-m", "pip", "check"]);
}

const installOcr = () => createVenv("perception-ocr", ["services/perception-ocr/requirements.txt"]);
async function checkPresentationPrerequisites() {
	await run(requireFile(venvPython("artifacts"), "artifact environment is missing"), [join(projectRoot, "services", "presentation-worker", "worker.py"), "--self-test"], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
}

async function installArtifacts() {
	await createVenv("artifacts", ["services/spreadsheet-worker/requirements.txt", "services/presentation-worker/requirements.txt", "services/backtesting-worker/requirements.txt"]);
	await checkPresentationPrerequisites();
}

async function verify() {
	checkPinnedFiles();
	await checkCodex();
	checkCodexIntegrity();
	if (await capture("git", ["-C", join(workerRoot, "tencent-agent-memory"), "rev-parse", "HEAD"]) !== versions.TENCENT_MEMORY_COMMIT) fail("TencentDB Agent Memory revision mismatch");
	await run(requireFile(venvPython("perception-ocr"), "OCR environment is missing"), [join(projectRoot, "services", "perception-ocr", "server.py"), "--self-test"], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
	await run(requireFile(venvPython("artifacts"), "artifact environment is missing"), ["-m", "pip", "check"]);
	await checkPresentationPrerequisites();
	console.log("Local OCR engine verification skipped: Windows uses a remote OCR worker.");
}

async function check() {
	checkPinnedFiles();
	await python312();
	await checkCodex();
	console.log(`Worker root: ${workerRoot}`);
	console.log(`OCR backend: ${selectOcrBackend()} (Windows uses a remote worker).`);
}

const actions = {
	check,
	"install-codex": installCodex,
	"install-memory": installMemory,
	"install-ocr": installOcr,
	"install-ocr-engine": () => fail("Windows uses a remote OCR worker; run this command on Apple Silicon or Linux NVIDIA"),
	"install-artifacts": installArtifacts,
	"install-sglang": () => fail("SGLang requires Linux or WSL 2"),
	"install-mlx": () => fail("MLX requires Apple Silicon"),
	verify,
	"install-all": async () => { checkPinnedFiles(); await installCodex(); await installMemory(); await installOcr(); await installArtifacts(); await verify(); },
};

try {
	const action = actions[process.argv[2] || "check"];
	if (!action) fail(`usage: bootstrap-workers.mjs ${Object.keys(actions).join("|")}`);
	await action();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
