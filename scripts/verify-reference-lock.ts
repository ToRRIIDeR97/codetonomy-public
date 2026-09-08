import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const lock = readFileSync(resolve("references.lock.yaml"), "utf8");
const entries = [...lock.matchAll(/^  ([a-z_]+):\n(?:.*\n)*?    commit: ([0-9a-f]{40})$/gm)];
if (entries.length !== 6) throw new Error("references.lock.yaml must contain six pinned commits");

for (const [, key, expected] of entries) {
	if (!key || !expected) continue;
	const directory = key.replaceAll("_", "-");
	const actual = execFileSync("git", ["-C", `.reference-repos/${directory}`, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	if (actual !== expected) throw new Error(`${directory}: expected ${expected}, found ${actual}`);
}

console.log("All six reference repositories match references.lock.yaml.");
