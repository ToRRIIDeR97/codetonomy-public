import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export const projectRoot = fileURLToPath(new URL("..", import.meta.url));
export const workerRoot = process.env.CODETONOMY_WORKER_ROOT || join(process.env.CODETONOMY_HOME || join(homedir(), ".codetonomy"), "workers");
export const versions = Object.fromEntries(readFileSync(join(projectRoot, "deployment", "worker-versions.env"), "utf8").split(/\r?\n/).filter((line) => line && !line.startsWith("#")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
export const venvPython = (name) => join(workerRoot, name, process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python");
export const npm = { program: process.execPath, prefix: [process.env.npm_execpath || join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")] };

export function run(program, args = [], options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(program, args, { stdio: "inherit", windowsHide: true, ...options });
		child.once("error", reject);
		child.once("close", (code, signal) => code === 0 ? resolve() : reject(new Error(`${program} exited ${code ?? signal ?? "without a status"}`)));
	});
}

export function capture(program, args = [], options = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, ...options });
		const stdout = [], stderr = [];
		child.stdout.on("data", (chunk) => stdout.push(chunk));
		child.stderr.on("data", (chunk) => stderr.push(chunk));
		child.once("error", reject);
		child.once("close", (code) => code === 0 ? resolve(Buffer.concat(stdout).toString("utf8").trim()) : reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `${program} exited ${code}`)));
	});
}

export async function python312() {
	const candidates = process.env.CODETONOMY_PYTHON312 ? [[process.env.CODETONOMY_PYTHON312, []]] : [["py", ["-3.12"]], ["python", []]];
	for (const [program, prefix] of candidates) {
		try {
			await capture(program, [...prefix, "-c", "import sys; raise SystemExit(0 if sys.version_info[:2] == (3, 12) else 1)"]);
			return { program, prefix };
		} catch {}
	}
	throw new Error("Python 3.12 is required. Set CODETONOMY_PYTHON312 to its executable path.");
}

export const requireFile = (path, message) => { if (!existsSync(path)) throw new Error(message); return path; };
