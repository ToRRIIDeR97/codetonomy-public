import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Offline experiment only. This matcher is never registered as a production tool.
async function replayEdits(): Promise<void> {
	const { editWorkspaceTool } = await import("../packages/tools/src/index.ts");
	const corpus = [
		{ id: "literal-dollar", before: "prefix old suffix", old: "old", next: "$&", expected: "prefix $& suffix" },
		{ id: "crlf", before: "prefix\r\none\r\ntwo\r\nsuffix", old: "one\ntwo", next: "new", expected: "prefix\r\nnew\r\nsuffix" },
		{ id: "mixed-endings", before: "prefix\none\r\ntwo\r\nsuffix", old: "one\ntwo", next: "new", expected: "prefix\nnew\r\nsuffix" },
		{ id: "ambiguous", before: "one\r\ntwo\r\none\r\ntwo", old: "one\ntwo", next: "new", expected: undefined },
		{ id: "unicode", before: "smart ‘quote’", old: "smart 'quote'", next: "new", expected: undefined },
		{ id: "missing", before: "untouched", old: "absent", next: "new", expected: undefined },
	];
	const root = await mkdtemp(join(tmpdir(), "toolrepair-replay-"));
	let seed = 20260903;
	const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
	const rows: Array<{ case: string; pair: number; variant: string; order: number; correct: boolean; applied: boolean; wrongRepair: boolean; durationMs: number }> = [];
	try {
		for (const fixture of corpus) for (let pair = 0; pair < 30; pair++) {
			const order = random() < 0.5 ? ["exact", "crlf-candidate"] : ["crlf-candidate", "exact"];
			for (const [index, variant] of order.entries()) {
				await writeFile(join(root, "replay.txt"), fixture.before);
				const started = performance.now();
				let applied = false;
				let oldText = fixture.old;
				if (variant === "crlf-candidate" && !fixture.before.includes(oldText) && !oldText.includes("\r")) oldText = oldText.replaceAll("\n", "\r\n");
				if (await readFile(join(root, "replay.txt"), "utf8") !== fixture.before) throw new Error("Replay state changed");
				try { await editWorkspaceTool(root).execute("replay", { path: "replay.txt", oldText, newText: fixture.next }); applied = true; }
				catch { /* Rejection is an expected result for missing or ambiguous targets. */ }
				const actual = await readFile(join(root, "replay.txt"), "utf8");
				const correct = fixture.expected === undefined ? !applied && actual === fixture.before : applied && actual === fixture.expected;
				rows.push({ case: fixture.id, pair, variant, order: index, correct, applied, wrongRepair: applied && actual !== fixture.expected, durationMs: performance.now() - started });
			}
		}
	} finally { await rm(root, { recursive: true, force: true }); }
	const report = {
		schemaVersion: 1, experiment: "offline-crlf-edit-replay", seed: 20260903, pairsPerCase: 30,
		corpusSha256: createHash("sha256").update(JSON.stringify(corpus)).digest("hex"), provider: "none", model: "none",
		cache: "local filesystem warm; no provider cache", paidRequests: 0, costUsd: 0, modelTokens: 0,
		decision: "defer", reason: "Offline correctness replay cannot establish live verified-completion non-inferiority or cost improvement. Production remains exact-only.",
		rows,
	};
	console.log(JSON.stringify(report, null, 2));
	if (rows.some(({ wrongRepair }) => wrongRepair)) process.exitCode = 1;
}

if (process.argv[2] === "--repair-live-report") {
	const { summarizeLiveRepairTrial } = await import("./repair-live-report.ts");
	await summarizeLiveRepairTrial();
} else if (process.argv[2] === "--repair-live") {
	const { runLiveRepairTrial } = await import("./repair-live-trial.ts");
	await runLiveRepairTrial();
} else if (process.argv[2] === "--repair-replay") {
	await replayEdits();
} else {
	const child = spawn(process.execPath, [resolve("apps/cli/dist/index.js"), "benchmark", ...process.argv.slice(2)], {
		stdio: "inherit", windowsHide: true,
	});
	child.once("error", (error) => { console.error(error.message); process.exitCode = 1; });
	child.once("exit", (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1; });
}
