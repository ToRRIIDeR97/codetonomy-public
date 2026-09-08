import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const read = (path: string) => readFile(join(process.cwd(), path), "utf8");
const run = promisify(execFile);

test("Windows OCR launcher pins revisions for the selected backend", async () => {
	const launcher = await read("scripts/run-ocr-workers.mjs");
	assert.match(launcher, /expectedModelRevision = backend === "mlx"/);
	assert.match(launcher, /pinned\("OCR_MODEL_REVISION", expectedModelRevision\)/);
	assert.match(launcher, /pinned\("OCR_CODE_REVISION", versions\.CODETONOMY_OCR_ADAPTER_SHA256\)/);
	assert.match(launcher, /must match the pinned worker configuration/);
	assert.match(launcher, /payload\.parserCodeRevision !== codeRevision/);
	if (process.platform === "win32") {
		await assert.rejects(
			() => run(process.execPath, [join(process.cwd(), "scripts", "run-ocr-workers.mjs"), "health"], {
				env: { ...process.env, OCR_SERVICE_TOKEN: "s".repeat(32), OCR_MODEL_REVISION: "untrusted-revision" },
			}),
			/must match the pinned worker configuration/,
		);
	}
});

test("MemoryCore bootstrap uses lock-aware installs with lifecycle scripts disabled", async () => {
	const posix = await read("scripts/bootstrap-workers.sh");
	const windows = await read("scripts/bootstrap-workers.mjs");
	assert.match(posix, /npm ci --prefix \"\$memory_core\" --ignore-scripts/);
	assert.match(posix, /npm install --prefix \"\$memory_core\" --ignore-scripts.*--package-lock=false/);
	assert.match(windows, /hasLockfile \? "ci" : "install"/);
	assert.match(windows, /"--ignore-scripts"/);
	assert.match(windows, /"--package-lock=false"/);
});

test("OCR startup reports dead workers and keeps model loading local", async () => {
	const launcher = await read("scripts/run-ocr-workers.sh");
	const adapter = await read("services/perception-ocr/server.py");
	assert.match(launcher, /wait_for_sglang \"\$engine_pid\"/);
	assert.match(launcher, /last probe error/);
	assert.match(launcher, /SGLang exited before readiness/);
	assert.match(launcher, /SGLang exited after readiness/);
	assert.match(launcher, /local_files_only=True/);
	assert.match(adapter, /local_files_only=True/);
	assert.match(adapter, /load\(str\(model_path\), revision=revision\)/);
	const versions = await read("deployment/worker-versions.env");
	const pinnedHash = versions.match(/^CODETONOMY_OCR_ADAPTER_SHA256=([a-f0-9]{64})$/m)?.[1];
	assert.equal(createHash("sha256").update(adapter).digest("hex"), pinnedHash);
});
