#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { capture, run } from "./worker-common.mjs";

const directory = resolve(process.argv[2] || ".reference-repos");
mkdirSync(directory, { recursive: true });
const repositories = [
	["reasonix", "https://github.com/esengine/deepseek-reasonix.git", "main-v2", "63dae234b27fdf28b0661239bfbaa61ab14435af"],
	["pi", "https://github.com/earendil-works/pi.git", "main", "2e4d23959485279aa2da1a45103de2ea22d46395"],
	["codex", "https://github.com/openai/codex.git", "main", "4ef836f883c38ba6d39e6920f335ce6452b7de33"],
	["tencent-agent-memory", "https://github.com/TencentCloud/TencentDB-Agent-Memory.git", "feat/server_team", "4dca55c41bf11cb19b49728dbe495c8e05d25abb"],
	["unlimited-ocr", "https://github.com/baidu/Unlimited-OCR.git", "main", "d49ff64afffc1f47ab563dc1c589bc2f78808fa4"],
	["mlx-vlm", "https://github.com/Blaizzy/mlx-vlm.git", "main", "61990c9054f2bc7bb8f32541e3238b4a58fe64e5"],
];

for (const [name, repository, branch, commit] of repositories) {
	const target = resolve(directory, name);
	try { await capture("git", ["-C", target, "rev-parse", "--git-dir"]); await run("git", ["-C", target, "remote", "set-url", "origin", repository]); }
	catch { await run("git", ["clone", "--depth", "1", "--filter=blob:none", "--no-checkout", "--branch", branch, repository, target]); }
	await run("git", ["-C", target, "fetch", "--depth", "1", "origin", branch]);
	try { await capture("git", ["-C", target, "cat-file", "-e", `${commit}^{commit}`]); }
	catch { await run("git", ["-C", target, "fetch", "--depth", "1", "origin", commit]); }
	await run("git", ["-C", target, "checkout", "--detach", commit]);
}

console.log("Pinned reference commits:");
for (const [name] of repositories) console.log(`${name.padEnd(24)} ${await capture("git", ["-C", resolve(directory, name), "rev-parse", "HEAD"])}`);
