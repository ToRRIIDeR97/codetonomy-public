#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function selectOcrBackend({
	platform = process.platform,
	architecture = process.arch,
	override = process.env.CODETONOMY_OCR_BACKEND,
	nvidiaAvailable = platform === "linux" && spawnSync("nvidia-smi", ["-L"], { stdio: "ignore", windowsHide: true }).status === 0,
} = {}) {
	if (override) {
		if (!["mlx", "sglang"].includes(override)) throw new Error("CODETONOMY_OCR_BACKEND must be sglang or mlx");
		return override;
	}
	if (platform === "darwin" && architecture === "arm64") return "mlx";
	if (platform === "linux" && nvidiaAvailable) return "sglang";
	return "external";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(selectOcrBackend());
