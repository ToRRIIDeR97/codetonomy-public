import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectWorkbook } from "../packages/artifacts/src/index.ts";
import { parseDocument } from "../packages/document-ir/src/index.ts";

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

const processIsAlive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code !== "ESRCH" && code !== "ENOENT";
	}
};

const readPid = async (path: string): Promise<number> => {
	for (let attempt = 0; attempt < 200; attempt++) {
		try {
			const pid = Number((await readFile(path, "utf8")).trim());
			if (Number.isSafeInteger(pid) && pid > 0) return pid;
		} catch {}
		await delay(25);
	}
	throw new Error(`Timed out waiting for ${path}`);
};

const waitForExit = async (pid: number): Promise<void> => {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (!processIsAlive(pid)) return;
		await delay(25);
	}
	assert.equal(processIsAlive(pid), false, `process ${pid} is still alive`);
};

const killIfAlive = async (path: string): Promise<void> => {
	try {
		const pid = Number((await readFile(path, "utf8")).trim());
		if (Number.isSafeInteger(pid) && pid > 0 && processIsAlive(pid)) process.kill(pid, "SIGKILL");
	} catch {}
};

const artifactWorkerSource = `
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

if (process.argv[2] === "grandchild") {
  writeFileSync(process.argv[3], String(process.pid));
  setInterval(() => {}, 1_000);
} else {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const pidPath = join(input.workspace, "artifact-grandchild.pid");
  const grandchild = spawn(process.execPath, [fileURLToPath(import.meta.url), "grandchild", pidPath], { stdio: "ignore", windowsHide: true });
  writeFileSync(join(input.workspace, "artifact-worker.pid"), String(process.pid));
  grandchild.unref();
  setInterval(() => {}, 1_000);
}
`;

const documentParserSource = `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

if (process.argv[2] === "grandchild") {
  writeFileSync(process.argv[3], String(process.pid));
  setInterval(() => {}, 1_000);
} else if (process.argv.includes("-layout")) {
  const sourcePath = process.argv[process.argv.indexOf("-layout") + 1];
  const pidPath = join(dirname(sourcePath), "document-grandchild.pid");
  const grandchild = spawn(process.execPath, [process.argv[1], "grandchild", pidPath], { stdio: "ignore", windowsHide: true });
  writeFileSync(join(dirname(sourcePath), "document-parser.pid"), String(process.pid));
  grandchild.unref();
  setInterval(() => {}, 1_000);
} else {
  process.stdout.write("Pages: 1\\n");
}
`;

const crashingArtifactWorkerSource = `
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

if (process.argv[2] === "grandchild") {
  writeFileSync(process.argv[3], String(process.pid));
  setInterval(() => {}, 1_000);
} else {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const pidPath = join(input.workspace, "crashed-worker-grandchild.pid");
  const grandchild = spawn(process.execPath, [fileURLToPath(import.meta.url), "grandchild", pidPath], { stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
  grandchild.unref();
  setInterval(() => { if (existsSync(pidPath)) process.exit(23); }, 10);
}
`;

test("artifact workers terminate a spawned grandchild with the worker tree", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "codetonomy-artifact-process-tree-"));
	const workerPath = join(workspace, "worker.mjs");
	await writeFile(workerPath, artifactWorkerSource, "utf8");
	await writeFile(join(workspace, "input.xlsx"), "placeholder", "utf8");
	try {
		await assert.rejects(
			() => inspectWorkbook(workspace, "input.xlsx", { python: process.execPath, workerPath, timeoutMs: 2_000 }),
			/worker timed out/,
		);
		const grandchildPid = await readPid(join(workspace, "artifact-grandchild.pid"));
		await waitForExit(grandchildPid);
	} finally {
		await killIfAlive(join(workspace, "artifact-grandchild.pid"));
		await killIfAlive(join(workspace, "artifact-worker.pid"));
	}
});

test("document parsers terminate a spawned grandchild when aborted", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "codetonomy-document-process-tree-"));
	const parserPath = join(workspace, "parser.mjs");
	await writeFile(parserPath, documentParserSource, "utf8");
	await writeFile(join(workspace, "input.pdf"), "placeholder", "utf8");
	const controller = new AbortController();
	try {
		const parsing = parseDocument(workspace, "input.pdf", {
			pdfinfoBinary: [process.execPath, parserPath],
			pdftotextBinary: [process.execPath, parserPath],
			signal: controller.signal,
		});
		const grandchildPid = await readPid(join(workspace, "document-grandchild.pid"));
		controller.abort();
		const document = await parsing;
		assert.match(document.failures?.[0]?.message ?? "", /Document parsing aborted/);
		await waitForExit(grandchildPid);
	} finally {
		controller.abort();
		await killIfAlive(join(workspace, "document-grandchild.pid"));
		await killIfAlive(join(workspace, "document-parser.pid"));
	}
});

test("artifact workers reap descendants after the direct worker exits", async () => {
	const workspace = await mkdtemp(join(tmpdir(), "codetonomy-crashed-worker-tree-"));
	const workerPath = join(workspace, "worker.mjs");
	const grandchildPath = join(workspace, "crashed-worker-grandchild.pid");
	await writeFile(workerPath, crashingArtifactWorkerSource, "utf8");
	await writeFile(join(workspace, "input.xlsx"), "placeholder", "utf8");
	try {
		await assert.rejects(
			() => inspectWorkbook(workspace, "input.xlsx", { python: process.execPath, workerPath, timeoutMs: 5_000 }),
			/worker exited 23/,
		);
		const grandchildPid = await readPid(grandchildPath);
		await waitForExit(grandchildPid);
	} finally {
		await killIfAlive(grandchildPath);
	}
});
