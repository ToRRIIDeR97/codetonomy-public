#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { helpText, parseArguments } from "./args.js";
import { sanitizeTerminalText } from "./terminal.js";
import type { MemoryDbIntegration } from "./memory.js";

const createShutdownScope = (): { signal: AbortSignal; dispose(): void } => {
	const controller = new AbortController();
	const stop = (exitCode: number) => {
		process.exitCode = exitCode;
		controller.abort(new Error("Codetonomy interrupted"));
	};
	const onSigint = () => stop(130);
	const onSigterm = () => stop(143);
	process.once("SIGINT", onSigint);
	process.once("SIGTERM", onSigterm);
	return {
		signal: controller.signal,
		dispose() {
			process.removeListener("SIGINT", onSigint);
			process.removeListener("SIGTERM", onSigterm);
		},
	};
};

async function main(): Promise<void> {
	const args = parseArguments(process.argv.slice(2));
	if (args.approveWrites) process.stderr.write("Warning: --approve-writes is deprecated; use --permission-mode auto.\n");
	if (args.permissionMode === "full-access") process.stderr.write("Warning: full-access allows approved commands to access files and the network without sandbox restrictions.\n");
	if (args.command === "help") {
		console.log(helpText());
		return;
	}
	if (args.command === "setup") {
		const { startSetup } = await import("./setup.js");
		await startSetup();
		return;
	}
	if (args.command === "verify-release") {
		const { verifySignedRelease } = await import("./release.js");
		const trustedPublicKey = args.publicKey ?? process.env.CODETONOMY_RELEASE_PUBLIC_KEY;
		if (!trustedPublicKey) throw new Error("Release verification requires --public-key <trusted-key> or CODETONOMY_RELEASE_PUBLIC_KEY");
		const result = await verifySignedRelease(args.destination!, trustedPublicKey);
		console.log(sanitizeTerminalText(`Verified ${result.artifact} (${result.sha256})`));
		return;
	}
	if (args.command === "tui") {
		const { startTui } = await import("./tui.js");
		await startTui({ provider: args.provider, modelId: args.modelId, permissionMode: args.permissionMode, toolInterface: args.toolInterface });
		return;
	}

	if (args.command === "memory") {
		const { configuredDocumentOptions, loadMemoryDbEnabled, saveMemoryDbEnabled, startMemoryDb } = await import("./memory.js");
		if (args.memoryEnabled === true) {
			const shutdown = createShutdownScope();
			const { loadConfiguration } = await import("./config.js");
			const configurationState = await loadConfiguration();
			let memoryDb: MemoryDbIntegration | undefined;
			try {
				memoryDb = await startMemoryDb({
					configurationDirectory: configurationState.directory,
					workspaceRoot: process.cwd(),
					sessionId: `cli-memory-${Date.now()}`,
					documentOptions: configuredDocumentOptions(configurationState.directory),
					signal: shutdown.signal,
					onStatus: (message) => process.stderr.write(`${message}\n`),
				});
				const indexed = await memoryDb.index(shutdown.signal, ({ phase, completed, total, path }) => {
					process.stderr.write(`\rmemoryDB ${phase} ${completed}/${total}${path ? ` · ${path}` : ""}   `);
				});
				await saveMemoryDbEnabled(process.cwd(), true);
				process.stderr.write(`\rmemoryDB indexed ${indexed.files} files and ${indexed.chunks} new chunks.\n`);
			} finally {
				try { await memoryDb?.close(); }
				finally { shutdown.dispose(); }
			}
		} else if (args.memoryEnabled === false) {
			await saveMemoryDbEnabled(process.cwd(), false);
		}
		console.log(`memoryDB is ${await loadMemoryDbEnabled(process.cwd()) ? "on" : "off"} for ${resolve(process.cwd())}`);
		return;
	}
	const { loadConfiguration, resolveProviderSelection } = await import("./config.js");
	const configurationState = await loadConfiguration();
	const evaluationDatabase = join(configurationState.directory, "evaluations.sqlite");
	if (args.command === "smoke-providers") {
		const { formatProviderSmokeDiagnostic, runLiveProviderSmokes } = await import("./live-smoke.js");
		const diagnostics = await runLiveProviderSmokes(configurationState, {
			enabled: process.env.CODETONOMY_LIVE_PROVIDER_SMOKE === "1",
			...(args.provider ? { provider: args.provider } : {}),
			...(args.allProviders ? { all: true } : {}),
		});
		for (const diagnostic of diagnostics) console.log(sanitizeTerminalText(formatProviderSmokeDiagnostic(diagnostic)));
		if (diagnostics.some(({ success }) => !success)) process.exitCode = 1;
		return;
	}
	if (args.command === "dashboard") {
		const { startDashboardServer } = await import("@agent-harness/daemon");
		const dashboard = await startDashboardServer({ databasePath: evaluationDatabase, port: args.port });
		console.log(`Codetonomy dashboard: ${dashboard.url}`);
		const stop = () => void dashboard.close().finally(() => { process.exitCode = 0; });
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
		return;
	}
	if (args.command === "export" || args.command === "backup" || args.command === "restore" || args.command === "prune") {
		const { EvaluationStore, exportRunBundle, restoreEvaluationBackup } = await import("@agent-harness/evals");
		if (args.command === "restore") {
			const result = await restoreEvaluationBackup(args.destination!, evaluationDatabase, { replace: args.replace });
			console.log(sanitizeTerminalText(`Restored evaluations to ${result.databasePath}${result.recoveryPath ? `; previous database preserved at ${result.recoveryPath}` : ""}`));
			return;
		}
		const store = new EvaluationStore(evaluationDatabase);
		try {
			if (args.command === "export") {
				const lockCandidates = [join(process.cwd(), "references.lock.yaml"), resolve(dirname(fileURLToPath(import.meta.url)), "../references.lock.yaml")];
				const referencesLockPath = lockCandidates.find(existsSync);
				const result = await exportRunBundle(store, args.runId!, args.destination!, { ...(referencesLockPath ? { referencesLockPath } : {}), workspaceRoot: process.cwd() });
				console.log(sanitizeTerminalText(`Exported ${result.runIds.length} runs and ${result.files} files to ${result.path}`));
			} else if (args.command === "backup") {
				await store.backupTo(args.destination!);
				console.log(sanitizeTerminalText(`Backed up evaluations to ${args.destination}`));
			} else {
				const before = new Date(Date.now() - args.days! * 86_400_000);
				const removed = store.pruneBefore(before, args.keep);
				console.log(`Removed ${removed} run records older than ${args.days} days; kept at least ${args.keep}.`);
			}
		} finally {
			store.close();
		}
		return;
	}
	const selection = resolveProviderSelection(configurationState, args.provider, args.modelId);
	if (args.command === "benchmark") {
		const { OcrHttpService } = await import("@agent-harness/document-ir");
		const { EvaluationStore, runValuationBenchmark } = await import("@agent-harness/evals");
		if (selection.provider === "fixture") throw new Error("The valuation benchmark requires a configured LLM provider. Run Codetonomy setup first.");
		const ocrEndpoint = process.env.CODETONOMY_OCR_URL;
		const ocrModelRevision = process.env.CODETONOMY_OCR_MODEL_REVISION;
		const ocrCodeRevision = process.env.CODETONOMY_OCR_CODE_REVISION;
		const ocrToken = process.env.CODETONOMY_OCR_TOKEN;
		if (!ocrEndpoint || !ocrModelRevision || !ocrCodeRevision || !ocrToken) throw new Error("The scanned-report benchmark requires CODETONOMY_OCR_URL, CODETONOMY_OCR_TOKEN, CODETONOMY_OCR_MODEL_REVISION, and CODETONOMY_OCR_CODE_REVISION");
		const ocr = new OcrHttpService({
			endpoint: ocrEndpoint,
			cacheDirectory: join(configurationState.directory, "ocr-cache"),
			cacheRoot: configurationState.directory,
			apiKey: ocrToken,
		});
		await ocr.health(ocrModelRevision, ocrCodeRevision, AbortSignal.timeout(5_000));
		const store = new EvaluationStore(evaluationDatabase);
		const shutdown = createShutdownScope();
		try {
			const result = await runValuationBenchmark({
				company: args.company!,
				annualReportPath: args.annualReport!,
				historicalCsvPath: args.historicalCsv!,
				outputPath: args.outputPath,
				workspaceRoot: process.cwd(),
				traceDirectory: join(configurationState.directory, "runs"),
				evaluationStore: store,
				ocr,
				ocrModelRevision,
				ocrCodeRevision,
				approve: async () => true,
				permissionMode: args.permissionMode,
				toolInterface: args.toolInterface,
				maxModelTurns: args.maxModelTurns,
				maxToolCalls: args.maxToolCalls,
				maxDurationMs: args.maxDurationMs,
				maxCostUsd: args.maxCostUsd,
				maxTotalTokens: args.maxTotalTokens,
				signal: shutdown.signal,
				...selection,
			});
			if (args.json) console.log(JSON.stringify(result, null, 2));
			else {
				for (const outcome of result.outcomes) console.log(`${outcome.variant.padEnd(30)} ${outcome.error ? `error: ${outcome.error}` : outcome.metrics?.verified ? "verified" : "failed"}`);
				console.log(sanitizeTerminalText(`\nVerified quality delta: ${result.comparison.verifiedSuccessDelta}; latency delta: ${result.comparison.latencyDeltaMs} ms${result.fullPreset ? `; workbook ${result.fullPreset.workbookPath}` : ""}`));
			}
			if (!result.fullPreset?.orchestration.verification.passed) process.exitCode = 1;
		} finally {
			try { store.close(); }
			finally { shutdown.dispose(); }
		}
		return;
	}
	const { discoverSkills, loadActivatedSkills, parsePrompt, routeSkills } = await import("./interaction.js");
	const skills = await discoverSkills(process.cwd());
	const prompt = parsePrompt(args.objective ?? "", new Set(skills.map(({ name }) => name)));
	const activatedSkills = await loadActivatedSkills(skills, [
		...prompt.skillNames,
		...routeSkills(prompt.objective, skills),
	]);
	const { configuredDocumentOptions, loadMemoryDbEnabled, startMemoryDb } = await import("./memory.js");
	const documentOptions = configuredDocumentOptions(configurationState.directory);
	const shutdown = createShutdownScope();
	let memoryDb: MemoryDbIntegration | undefined;
	try {
		if (await loadMemoryDbEnabled(process.cwd())) {
			memoryDb = await startMemoryDb({
				configurationDirectory: configurationState.directory,
				workspaceRoot: process.cwd(),
				sessionId: `cli-${Date.now()}`,
				documentOptions,
				signal: shutdown.signal,
				onStatus: (message) => process.stderr.write(`${message}\n`),
			});
			const indexed = await memoryDb.index(shutdown.signal, ({ phase, completed, total, path }) => {
				if (!args.json) process.stderr.write(`\rmemoryDB ${phase} ${completed}/${total}${path ? ` · ${path}` : ""}   `);
			});
			if (!args.json) process.stderr.write(`\rmemoryDB indexed ${indexed.files} files and ${indexed.chunks} new chunks.\n`);
		}
		const { resolveToolInterface } = await import("@agent-harness/runtime");
		const toolInterface = resolveToolInterface({ toolInterface: args.toolInterface, workspaceSearch: memoryDb?.workspaceSearch });
		const integrations = {
			documentOptions,
			...(memoryDb ? { workspaceSearch: memoryDb.workspaceSearch } : {}),
		};
		const { EvaluationStore } = await import("@agent-harness/evals");
		const store = new EvaluationStore(evaluationDatabase);
		try {
			if (args.command !== "eval") {
				const { createHarness } = await import("@agent-harness/runtime");
				const result = await createHarness().run({
					objective: prompt.objective,
					files: [...new Set([...args.files, ...prompt.files])],
					traceDirectory: join(configurationState.directory, "runs"),
					activatedSkills,
					...integrations,
					permissionMode: args.permissionMode,
					toolInterface,
					maxModelTurns: args.maxModelTurns,
				maxToolCalls: args.maxToolCalls,
				maxDurationMs: args.maxDurationMs,
				maxCostUsd: args.maxCostUsd,
					maxTotalTokens: args.maxTotalTokens,
					signal: shutdown.signal,
					runStore: store,
					...(args.approveWrites ? { approve: async () => true } : {}),
					...selection,
				});
				if (args.json) console.log(JSON.stringify(result, null, 2));
				else {
					console.log(sanitizeTerminalText(result.output));
					console.log(`\n${result.verification.passed ? "verified" : "verification failed"} · trace ${sanitizeTerminalText(result.tracePath)}`);
				}
				if (!result.verification.passed) process.exitCode = 1;
				return;
			}
			const { runTaskBenchmark } = await import("@agent-harness/evals");
			const benchmarkId = `task:${createHash("sha256").update(JSON.stringify({ objective: prompt.objective, files: [...new Set([...args.files, ...prompt.files])], toolInterface })).digest("hex").slice(0, 16)}`;
			const result = await runTaskBenchmark(store, benchmarkId, {
				objective: prompt.objective,
				files: [...new Set([...args.files, ...prompt.files])],
				traceDirectory: join(configurationState.directory, "runs"),
				activatedSkills,
				...integrations,
				permissionMode: args.permissionMode,
				toolInterface,
				maxModelTurns: args.maxModelTurns,
				maxToolCalls: args.maxToolCalls,
				maxDurationMs: args.maxDurationMs,
				maxCostUsd: args.maxCostUsd,
				maxTotalTokens: args.maxTotalTokens,
				signal: shutdown.signal,
				...(args.approveWrites ? { approve: async () => true } : {}),
				...selection,
			});
			if (args.json) console.log(JSON.stringify(result, null, 2));
			else {
				for (const outcome of result.outcomes) console.log(`${outcome.variant.padEnd(30)} ${outcome.error ? `error: ${outcome.error}` : outcome.metrics?.verified ? "verified" : "failed"}`);
				console.log(`\n${result.comparison.candidateImprovesQuality ? "Full preset improved verified quality." : result.comparison.candidateImprovesLatencyWithoutQualityLoss ? "Full preset improved latency without quality loss." : "No measured improvement over the raw model."}`);
			}
			if (!result.outcomes.find(({ variant }) => variant === "FULL_PRESET")?.metrics?.verified) process.exitCode = 1;
		} finally {
			store.close();
		}
	} finally {
		try { await memoryDb?.close(); }
		finally { shutdown.dispose(); }
	}
}

main().catch((error) => {
	console.error(sanitizeTerminalText(error instanceof Error ? error.message : String(error)));
	if (!process.exitCode) process.exitCode = 1;
});

export { main };
