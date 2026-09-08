import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { qualifyL2Evidence, type L2EvidenceInput } from "@agent-harness/evals";

const manifestPath = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Usage: npm run qualify:l2 -- <qualification-manifest.json>");
const handle = await open(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
let text: string;
try {
	const info = await handle.stat();
	if (!info.isFile() || info.nlink !== 1 || info.size > 4 * 1024 * 1024) throw new Error("Qualification manifest must be a regular standalone file under 4 MiB");
	text = await handle.readFile("utf8");
} finally { await handle.close(); }
const manifest = JSON.parse(text) as { schemaVersion?: unknown; trials?: unknown };
if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.trials)) throw new Error("Unsupported qualification manifest");
const root = dirname(manifestPath);
const inputs: L2EvidenceInput[] = manifest.trials.map((raw) => {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid qualification trial");
	const trial = raw as Record<string, unknown>;
	if (typeof trial.resultPath !== "string" || typeof trial.expectedPresetId !== "string") throw new Error("Each qualification trial requires resultPath and expectedPresetId");
	return { resultPath: resolve(root, trial.resultPath), expectedPresetId: trial.expectedPresetId };
});
const report = await qualifyL2Evidence(inputs);
console.log(JSON.stringify(report, null, 2));
if (!report.qualification.qualified) process.exitCode = 1;
