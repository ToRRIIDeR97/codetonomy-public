#!/usr/bin/env node
import { existsSync } from "node:fs";
import { join } from "node:path";
import { projectRoot, run, venvPython } from "./worker-common.mjs";

if (process.platform !== "win32") {
	await run("bash", [join(projectRoot, "scripts", "test-ocr.sh")]);
} else {
	const python = process.env.CODETONOMY_OCR_PYTHON || (existsSync(venvPython("perception-ocr")) ? venvPython("perception-ocr") : "python");
	const environment = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
	await run(python, [join(projectRoot, "services", "perception-ocr", "server.py"), "--self-test"], { env: environment });
	await run(python, [join(projectRoot, "services", "perception-ocr", "test_integration.py")], { env: environment });
}
