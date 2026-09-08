import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const manifest = readFileSync(resolve("THIRD_PARTY_REUSE.yaml"), "utf8");
for (const required of [
	"pi-agent-runtime",
	"pi-terminal-ui",
	"pi-release-packaging",
	"sglang-worker-launcher",
	"source_commit",
	"integration_method: direct_dependency",
	"integration_method: adapted_source",
	"packages/tools/package.json",
	"packages/tools/src/index.ts",
	"apps/cli/package.json",
	"scripts/build-release.ts",
	"scripts/run-ocr-workers.sh",
]) {
	if (!manifest.includes(required)) throw new Error(`THIRD_PARTY_REUSE.yaml is missing ${required}`);
}
if (existsSync(resolve("third_party")) && !manifest.includes("destination:")) {
	throw new Error("third_party/ exists without reuse manifest destinations");
}

const packageChecks: Array<[string, Record<string, string>]> = [
	["packages/runtime/package.json", { "@earendil-works/pi-agent-core": "0.84.1", "@earendil-works/pi-ai": "0.84.1" }],
	["packages/tools/package.json", { "@earendil-works/pi-agent-core": "0.84.1" }],
	["apps/cli/package.json", { "@earendil-works/pi-tui": "0.84.1" }],
];
for (const [path, expected] of packageChecks) {
	const packageManifest = JSON.parse(readFileSync(resolve(path), "utf8")) as { dependencies?: Record<string, string> };
	for (const [name, version] of Object.entries(expected)) {
		if (packageManifest.dependencies?.[name] !== version) throw new Error(`${path} must pin ${name}@${version}`);
		if (!manifest.includes(`"${name}": ${version}`)) throw new Error(`THIRD_PARTY_REUSE.yaml is missing ${name}@${version}`);
	}
}
console.log("Third-party reuse manifest covers the current integrations.");
