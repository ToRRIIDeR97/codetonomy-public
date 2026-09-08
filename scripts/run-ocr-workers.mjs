#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { projectRoot, run, venvPython, versions, workerRoot } from "./worker-common.mjs";

if (process.platform !== "win32") {
	await run("bash", [join(projectRoot, "scripts", "run-ocr-workers.sh"), ...process.argv.slice(2)]);
	process.exit(0);
}

const required = (name) => {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
};
const serviceToken = required("OCR_SERVICE_TOKEN");
if (serviceToken.length < 32) throw new Error("OCR_SERVICE_TOKEN must contain at least 32 characters");
const adapter = join(projectRoot, "services", "perception-ocr", "server.py");
if (createHash("sha256").update(readFileSync(adapter)).digest("hex") !== versions.CODETONOMY_OCR_ADAPTER_SHA256) throw new Error("OCR adapter checksum mismatch");
const action = process.argv[2];
const configuredBackend = process.env.CODETONOMY_OCR_BACKEND?.trim().toLowerCase();
const backend = ["adapter", "gateway"].includes(action) ? "sglang" : configuredBackend === "mlx" ? "mlx" : "sglang";
const expectedModelRevision = backend === "mlx" ? versions.UNLIMITED_OCR_MLX_MODEL_REVISION : versions.UNLIMITED_OCR_MODEL_REVISION;
const pinned = (name, expected) => {
	const value = process.env[name] || expected;
	if (value !== expected) throw new Error(`${name} must match the pinned worker configuration`);
	return value;
};
const modelRevision = pinned("OCR_MODEL_REVISION", expectedModelRevision);
const codeRevision = pinned("OCR_CODE_REVISION", versions.CODETONOMY_OCR_ADAPTER_SHA256);

if (["start", "engine", "sglang"].includes(action)) throw new Error("Windows uses a remote OCR worker; start it on Apple Silicon or Linux NVIDIA");
if (["adapter", "gateway"].includes(action)) {
	const upstreamKey = required("OCR_UPSTREAM_API_KEY");
	if (upstreamKey.length < 32 || serviceToken === upstreamKey) throw new Error("OCR tokens must be distinct and contain at least 32 characters");
	await run(venvPython("perception-ocr"), [adapter], { env: {
		...process.env,
		OCR_ENGINE: "sglang",
		OCR_MODEL_REVISION: modelRevision,
		OCR_CODE_REVISION: codeRevision,
		OCR_STORAGE_ROOT: process.env.OCR_STORAGE_ROOT || join(workerRoot, "ocr-data"),
		OCR_UPSTREAM_URL: `http://127.0.0.1:${process.env.OCR_UPSTREAM_PORT || "10000"}`,
		OCR_SERVED_MODEL: versions.UNLIMITED_OCR_SERVED_MODEL,
		OCR_HOST: "127.0.0.1",
		OCR_PORT: process.env.OCR_PORT || "10001",
	} });
} else if (action === "health") {
	const response = await fetch(`http://127.0.0.1:${process.env.OCR_PORT || "10001"}/health`, { headers: { authorization: `Bearer ${serviceToken}` }, signal: AbortSignal.timeout(5_000) });
	const payload = await response.json();
	if (!response.ok || payload.status !== "ok" || payload.modelRevision !== modelRevision || payload.parserCodeRevision !== codeRevision) throw new Error(`OCR health failed: ${JSON.stringify(payload)}`);
	console.log(JSON.stringify(payload, Object.keys(payload).sort()));
} else throw new Error("usage: run-ocr-workers.mjs start|engine|gateway|health|sglang|adapter");
