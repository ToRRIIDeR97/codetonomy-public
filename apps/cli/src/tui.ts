import chalk from "chalk";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	Container,
	Editor,
	Markdown,
	ProcessTerminal,
	ScrollView,
	Text,
	TuiAltScreen,
	VStack,
	matchesKey,
	type EditorTheme,
	type MarkdownTheme,
} from "@earendil-works/pi-tui";
import type { HarnessEvent, RunResult, RunUsage, ToolPermissionRequest } from "@agent-harness/contracts";
import { createHarness, isPermissionMode, modelSupportsImages, previewCheckpoint, rewindCheckpoint, type PermissionMode, type ToolInterface } from "@agent-harness/runtime";
import {
	loadConfiguration,
	persistProviderSelection,
	providerCompatibilityNotice,
	resolveProviderSelection,
	saveConfiguration,
	type ProviderSelection,
} from "./config.js";
import {
	createAutocompleteProvider,
	createSlashCommands,
	discoverSkills,
	discoverWorkspaceFiles,
	loadActivatedSkills,
	parsePrompt,
	parseSlashCommand,
	routeSkills,
} from "./interaction.js";
import { mascotActivityForEvent, PolarBearWelcome } from "./mascot.js";
import { configuredDocumentOptions, loadMemoryDbEnabled, saveMemoryDbEnabled, startMemoryDb, type MemoryDbIntegration } from "./memory.js";
import { addSessionModelUsage, appendConversationTurn, createSession, generateSessionTitle, listSessions, loadSessionByPrefix, saveSession, sessionModelUsage, type SessionModelUsage } from "./session.js";
import { sanitizeTerminalText } from "./terminal.js";
import { ocrClipboardImages, readClipboard, type ClipboardImage } from "./clipboard.js";

const selectListTheme = {
	selectedPrefix: (text: string) => chalk.cyan(text),
	selectedText: (text: string) => chalk.bold(text),
	description: (text: string) => chalk.dim(text),
	scrollInfo: (text: string) => chalk.dim(text),
	noMatch: (text: string) => chalk.dim(text),
};

const editorTheme: EditorTheme = {
	borderColor: (text) => chalk.cyan(text),
	selectList: selectListTheme,
};

const markdownTheme: MarkdownTheme = {
	heading: (text) => chalk.bold.cyan(text),
	link: (text) => chalk.blue(text),
	linkUrl: (text) => chalk.dim(text),
	code: (text) => chalk.yellow(text),
	codeBlock: (text) => chalk.green(text),
	codeBlockBorder: (text) => chalk.dim(text),
	quote: (text) => chalk.italic(text),
	quoteBorder: (text) => chalk.dim(text),
	hr: (text) => chalk.dim(text),
	listBullet: (text) => chalk.cyan(text),
	bold: (text) => chalk.bold(text),
	italic: (text) => chalk.italic(text),
	strikethrough: (text) => chalk.strikethrough(text),
	underline: (text) => chalk.underline(text),
};

const eventLabel = (event: HarnessEvent): string => {
	const icon = event.type.endsWith("failed") || event.type.endsWith("denied") ? chalk.red("×") : chalk.dim("·");
	return `${icon} ${event.type}`;
};

export const formatUsage = (result: Pick<RunResult, "usage" | "modelContext">): string => {
	const context = result.modelContext;
	return context ? `${context.lastPromptTokens.toLocaleString()} / ${context.contextWindow.toLocaleString()} tokens (${Math.round(context.lastPromptTokens / context.contextWindow * 100)}%)` : "tokens —";
};

export const formatModelUsageReport = (rows: readonly SessionModelUsage[]): string => {
	if (!rows.length) return "No model usage recorded for this session";
	const totalTokens = rows.reduce((sum, row) => sum + row.usage.totalTokens, 0);
	const totalCost = rows.every(({ usage }) => usage.cost) ? rows.reduce((sum, row) => sum + row.usage.cost!.total, 0) : undefined;
	return [
		"Session model usage",
		...rows.map(({ provider, model, requests, usage }) => {
			const cacheBase = usage.input + usage.cacheRead;
			return `${provider}/${model}\n  requests ${requests.toLocaleString()} · input ${usage.input.toLocaleString()} · output ${usage.output.toLocaleString()} · cache read ${usage.cacheRead.toLocaleString()} · cache write ${usage.cacheWrite.toLocaleString()}${usage.reasoning ? ` · reasoning ${usage.reasoning.toLocaleString()}` : ""} · total ${usage.totalTokens.toLocaleString()} · cache hit ${cacheBase ? (usage.cacheRead / cacheBase * 100).toFixed(1) : "0.0"}%${usage.cost ? ` · cost $${usage.cost.total.toFixed(6)}` : ""}`;
		}),
		`All models · ${totalTokens.toLocaleString()} tokens${totalCost === undefined ? "" : ` · $${totalCost.toFixed(6)}`}`,
	].join("\n");
};

export const renderReasoningGlow = (frame: number): string => [..."Reasoning"]
	.map((character, index) => index === frame % 9 ? chalk.bold.cyan(character) : chalk.dim(character)).join("");
export type SubagentUiState = { id: string; state: "queued" | "working" | "completed" | "failed" };
export const renderSubagentStrip = (agents: readonly SubagentUiState[], frame = 0): string => {
	if (!agents.length) return "";
	const working = agents.filter(({ state }) => state === "working").length;
	const dot = frame % 2 ? chalk.green("●") : chalk.dim("●");
	return `${working ? dot : chalk.dim("●")} ${working || agents.length} agent${(working || agents.length) === 1 ? "" : "s"} ${working ? "working" : "finished"} · [main] ${agents.map(({ id, state }) => `[${id.slice(0, 12)}:${state}]`).join(" ")}`;
};
const formatDuration = (durationMs = 0): string => durationMs < 1_000 ? `${Math.round(durationMs)}ms` : `${(durationMs / 1_000).toFixed(1)}s`;

export async function startTui(options: { provider?: string; modelId?: string; permissionMode?: PermissionMode; toolInterface?: ToolInterface } = {}): Promise<void> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("The terminal UI requires an interactive TTY");
	const tui = new TuiAltScreen(new ProcessTerminal());
	const workspaceRoot = await realpath(process.cwd());
	const [skills, workspaceFiles, configurationState, initialMemoryDbEnabled] = await Promise.all([
		discoverSkills(workspaceRoot),
		discoverWorkspaceFiles(workspaceRoot),
		loadConfiguration(),
		loadMemoryDbEnabled(workspaceRoot),
	]);
	const skillsByName = new Map(skills.map((skill) => [skill.name, skill]));
	const { EvaluationStore } = await import("@agent-harness/evals");
	const evaluationStore = new EvaluationStore(join(configurationState.directory, "evaluations.sqlite"));
	const activeSkills = new Set<string>();
	const sessionAllowedTools = new Set<string>();
	let permissionMode: PermissionMode = options.permissionMode ?? "ask";
	const toolInterface = options.toolInterface;
	let conversationSession = createSession(workspaceRoot);
	const sessionSummaries = await listSessions(configurationState.directory, workspaceRoot);
	let selection: ProviderSelection = resolveProviderSelection(configurationState, options.provider, options.modelId);
	const documentOptions = configuredDocumentOptions(configurationState.directory);
	let memoryDbEnabled = initialMemoryDbEnabled;
	let memoryDb: MemoryDbIntegration | undefined;
	let memoryDbStartPromise: Promise<MemoryDbIntegration> | undefined;
	let memoryDbStartController: AbortController | undefined;
	let memoryDbGeneration = 0;
	let lastResult: RunResult | undefined;
	let showReasoning = configurationState.configuration.showReasoning ?? false;
	let reasoningEffort = configurationState.configuration.reasoningEffort ?? "high";
	const transcript = new Container();
	const mascot = new PolarBearWelcome(() => tui.requestRender(), {
		model: `${selection.provider}/${selection.modelId}`,
		workspace: `~/${basename(workspaceRoot)}`,
	});
	const updateModelDisplay = () => mascot.setContext({ model: `${selection.provider}/${selection.modelId}` });
	const addTurn = (turn: typeof conversationSession.turns[number]) => {
		transcript.addChild(new Text(`${chalk.bold("You")}  ${sanitizeTerminalText(turn.objective)}`, 1, 1));
		for (const item of turn.reasoning ?? []) transcript.addChild(new Text(showReasoning
			? chalk.dim(`Reasoning${item.truncated ? " (truncated)" : ""}\n${sanitizeTerminalText(item.text)}`)
			: chalk.dim("Reasoning hidden · Ctrl+O to show"), 1, 1));
		transcript.addChild(new Markdown(sanitizeTerminalText(turn.output), 1, 1, markdownTheme));
		transcript.addChild(new Text(chalk.dim(`Completed · ${formatDuration(turn.durationMs)} · ${turn.model ?? "unknown model"}`), 1, 0));
	};
	const resetTranscript = (includeHistory = true) => {
		transcript.clear();
		if (includeHistory) for (const turn of conversationSession.turns.slice(-10)) addTurn(turn);
	};
	resetTranscript();
	const status = new Text(chalk.dim("ready"), 1, 0);
	const editor = new Editor(tui, editorTheme, { paddingX: 1 });
	let pendingImages: Array<ClipboardImage & { marker: string }> = [];
	let readingClipboard = false;
	const footer = new Text("", 1, 0);
	const agentStrip = new Text("", 1, 0);
	const subagents = new Map<string, SubagentUiState>();
	let agentFrame = 0;
	const updateAgentStrip = () => agentStrip.setText(renderSubagentStrip([...subagents.values()], agentFrame++));
	const updateFooter = () => {
		const previous = conversationSession.turns.at(-1);
		const usage = lastResult ?? (previous?.usage ? { usage: previous.usage, modelContext: previous.modelContext } : undefined);
		const mode = permissionMode === "full-access" ? chalk.red("FULL ACCESS") : permissionMode;
		footer.setText(chalk.dim(`${selection.provider}/${selection.modelId} · permissions ${mode} · reasoning ${reasoningEffort} · memoryDB ${memoryDbEnabled ? "on" : "off"} · ${usage ? formatUsage(usage) : "tokens —"}`));
	};
	updateFooter();
	editor.setAutocompleteProvider(createAutocompleteProvider(createSlashCommands(skills, [
		{ provider: "fixture", modelId: "faux-1", description: "local fixture" },
		...configurationState.configuration.providers.flatMap(({ id, models, name }) =>
			models.map((modelId) => ({ provider: id, modelId, description: name })),
		),
	], sessionSummaries), skills, workspaceFiles, workspaceRoot));
	tui.setLayoutRoot(new VStack([
		{ component: mascot, basis: "auto", grow: 0, shrink: 0 },
		{ component: new ScrollView(transcript, { follow: "end", primary: true, overscroll: "chain", scrollbar: "auto" }), basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: new VStack([status, editor, footer, agentStrip]), basis: "auto", grow: 0, shrink: 1, minSize: 5 },
	]));
	tui.setFocus(editor);

	let running = false;
	let stopped = false;
	let abortController: AbortController | undefined;
	let reasoningAnimation: NodeJS.Timeout | undefined;
	let liveReasoning: Text | undefined;
	let liveAnswer: Markdown | undefined;
	let liveReasoningText = "";
	let liveAnswerText = "";
	const renderLiveReasoning = () => liveReasoning?.setText(showReasoning
		? chalk.dim(`Reasoning\n${sanitizeTerminalText(liveReasoningText.slice(-4_096))}`)
		: chalk.dim("Reasoning hidden · Ctrl+O to show"));
	const streamModelDelta = ({ kind, text }: { kind: "reasoning" | "text"; text: string }) => {
		if (kind === "reasoning") {
			liveReasoningText = text;
			if (!liveReasoning) { liveReasoning = new Text("", 1, 1); transcript.addChild(liveReasoning); }
			renderLiveReasoning();
		} else {
			liveAnswerText = text;
			if (!liveAnswer) { liveAnswer = new Markdown("", 1, 1, markdownTheme); transcript.addChild(liveAnswer); }
			liveAnswer.setText(sanitizeTerminalText(liveAnswerText));
		}
		if (!stopped) tui.requestRender();
	};
	let reasoningFrame = 0;
	const stopReasoningAnimation = () => { if (reasoningAnimation) clearInterval(reasoningAnimation); reasoningAnimation = undefined; };
	const startReasoningAnimation = () => {
		stopReasoningAnimation();
		status.setText(renderReasoningGlow(reasoningFrame++));
		reasoningAnimation = setInterval(() => { status.setText(renderReasoningGlow(reasoningFrame++)); if (!stopped) tui.requestRender(); }, 110);
	};
	let activeApproval: { request: ToolPermissionRequest; resolve: (allowed: boolean) => void } | undefined;
	const approvalQueue: Array<{ request: ToolPermissionRequest; resolve: (allowed: boolean) => void }> = [];
	const renderMessage = (message: string, color: (text: string) => string = (text) => text) => {
		transcript.addChild(new Text(color(sanitizeTerminalText(message)), 1, 1));
		if (!stopped) tui.requestRender();
	};
	const ensureMemoryDb = async (sessionId: string, signal?: AbortSignal): Promise<MemoryDbIntegration> => {
		if (memoryDb) return memoryDb;
		if (!memoryDbStartPromise) {
			const generation = memoryDbGeneration;
			const startController = new AbortController();
			memoryDbStartController = startController;
			const startSignal = signal ? AbortSignal.any([signal, startController.signal]) : startController.signal;
			memoryDbStartPromise = startMemoryDb({
				configurationDirectory: configurationState.directory,
				workspaceRoot,
				sessionId,
				documentOptions,
				signal: startSignal,
				onStatus: (message) => { status.setText(chalk.yellow(message)); tui.requestRender(); },
			})
				.then(async (integration) => {
					if (generation !== memoryDbGeneration) {
						await integration.close();
						throw new Error("memoryDB startup was cancelled");
					}
					memoryDb = integration;
					return integration;
				})
				.finally(() => { memoryDbStartPromise = undefined; });
		}
		return memoryDbStartPromise;
	};
	const closeMemoryDb = (): void => {
		memoryDbGeneration++;
		memoryDbStartController?.abort();
		memoryDbStartController = undefined;
		const current = memoryDb;
		memoryDb = undefined;
		if (current) void current.close();
	};
	const refreshSessions = async () => sessionSummaries.splice(0, sessionSummaries.length, ...await listSessions(configurationState.directory, workspaceRoot));
	const showNextApproval = () => {
		if (activeApproval || !approvalQueue.length || stopped) return;
		activeApproval = approvalQueue.shift();
		if (!activeApproval) return;
		const argumentsText = JSON.stringify(activeApproval.request.arguments).slice(0, 500);
		renderMessage(`Approval required: ${activeApproval.request.toolId}\n${argumentsText}\nType y to allow once, a to allow this tool for the session, or n to deny.`, chalk.yellow);
		status.setText(chalk.yellow("approval required"));
	};
	const requestApproval = (request: ToolPermissionRequest): Promise<boolean> => new Promise((resolveApproval) => {
		if (permissionMode !== "ask") {
			resolveApproval(true);
			return;
		}
		if (sessionAllowedTools.has(request.toolId)) {
			resolveApproval(true);
			return;
		}
		approvalQueue.push({ request, resolve: resolveApproval });
		showNextApproval();
	});
	const answerApproval = (raw: string): boolean => {
		if (!activeApproval) return false;
		const answer = raw.trim().toLowerCase();
		if (!["y", "yes", "a", "always", "n", "no"].includes(answer)) {
			renderMessage("Type y to allow once, a to allow for the session, or n to deny.", chalk.yellow);
			return true;
		}
		editor.setText("");
		const approval = activeApproval;
		activeApproval = undefined;
		const allowed = answer === "y" || answer === "yes" || answer === "a" || answer === "always";
		if (answer === "a" || answer === "always") sessionAllowedTools.add(approval.request.toolId);
		approval.resolve(allowed);
		showNextApproval();
		if (!activeApproval) status.setText(chalk.yellow("running"));
		return true;
	};
	const permissionSummary = (): string => {
		const mode = permissionMode === "full-access" ? "FULL ACCESS" : permissionMode;
		const behavior = permissionMode === "ask"
			? "known write and command requests ask for approval"
			: permissionMode === "auto"
				? "known requests are approved automatically within the workspace sandbox"
				: "known requests are approved automatically with filesystem and network sandboxing disabled";
		return `Permission mode: ${mode}\n${behavior}.${permissionMode === "full-access" ? " Warning: tools can access files and the network without sandbox restrictions." : ""}${sessionAllowedTools.size ? ` Session allows: ${[...sessionAllowedTools].join(", ")}.` : ""}`;
	};
	const fullAccessWarning = "Warning: Full access is enabled. Approved tools can access files and the network without sandbox restrictions.";
	const changePermissionMode = (nextMode: PermissionMode): void => {
		if (nextMode === permissionMode) {
			renderMessage(permissionSummary(), nextMode === "full-access" ? chalk.red : chalk.dim);
			return;
		}
		sessionAllowedTools.clear();
		if (nextMode !== "ask") {
			if (activeApproval) {
				const approval = activeApproval;
				activeApproval = undefined;
				approval.resolve(true);
			}
			for (const approval of approvalQueue.splice(0)) approval.resolve(true);
		}
		permissionMode = nextMode;
		updateFooter();
		if (nextMode === "full-access") {
			renderMessage(fullAccessWarning, chalk.red);
			status.setText(chalk.red("FULL ACCESS enabled"));
		} else {
			renderMessage(`Permission mode changed to ${nextMode}${nextMode === "auto" ? " (workspace sandbox)" : ""}`);
			status.setText(chalk.dim(`permissions ${nextMode}`));
		}
		showNextApproval();
	};
	if (permissionMode === "full-access") renderMessage(fullAccessWarning, chalk.red);
	const sessionSummary = (): string => [
		`Model: ${selection.provider}/${selection.modelId}`,
		`Workspace: ${workspaceRoot}`,
		`Session: ${conversationSession.id} · ${conversationSession.turns.length} saved turns`,
		`Configuration: ${configurationState.directory}`,
		permissionSummary(),
		`MemoryDB: ${memoryDbEnabled ? "on" : "off"} (project setting)`,
		`Active skills: ${activeSkills.size ? [...activeSkills].join(", ") : "none"}`,
		...(lastResult ? [`Last run: ${lastResult.runId} · ${lastResult.usage.totalTokens} tokens · ${lastResult.verification.passed ? "verified" : "failed"}`] : []),
	].join("\n");
	const recordModelUsage = (event: HarnessEvent): void => {
		if (event.type !== "model.request.completed" && event.type !== "model.request.failed") return;
		const { provider, model, usage } = event.data as { provider?: unknown; model?: unknown; usage?: Partial<RunUsage> };
		if (typeof provider !== "string" || typeof model !== "string" || !usage
			|| ![usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) return;
		conversationSession = addSessionModelUsage(conversationSession, provider, model, usage as RunUsage);
	};
	const stop = () => {
		if (stopped) return;
		stopped = true;
		abortController?.abort();
		activeApproval?.resolve(false);
		activeApproval = undefined;
		for (const approval of approvalQueue.splice(0)) approval.resolve(false);
		mascot.stop();
		stopReasoningAnimation();
		closeMemoryDb();
		tui.stop();
		process.exitCode = 0;
	};
	const pasteClipboard = (): void => {
		if (running || readingClipboard) return;
		readingClipboard = true;
		status.setText(chalk.yellow("reading clipboard"));
		void readClipboard()
			.then(({ image, text }) => {
				if (image) {
					pendingImages = pendingImages.filter(({ marker }) => editor.getText().includes(marker));
					if (pendingImages.length >= 8) throw new Error("A prompt can attach at most 8 images");
					const marker = `[clipboard image ${pendingImages.length + 1}]`;
					pendingImages.push({ ...image, marker });
					editor.insertTextAtCursor(marker);
					status.setText(chalk.dim("clipboard image attached"));
				} else if (text) editor.insertTextAtCursor(text);
				else renderMessage("The clipboard contains no image or text", chalk.yellow);
			})
			.catch((error) => renderMessage(error instanceof Error ? error.message : String(error), chalk.red))
			.finally(() => { readingClipboard = false; if (!running) status.setText(chalk.dim("ready")); tui.requestRender(); });
	};
	const handleCommand = (raw: string): void => {
		const command = parseSlashCommand(raw);
		if (!command) return;
		editor.setText("");
		switch (command.name) {
			case "paste":
				pasteClipboard();
				break;
			case "help":
				renderMessage([
					"/help · /paste · /status · /report · /permissions [ask|auto|full-access] · /history · /session [id] · /runs · /dashboard · /diff · /rewind · /model <provider/model> · /reasoning <effort> · /memorydb <on|off|status>",
					"/skills [filter] · /skill <name|clear> · /clear · /new · /quit · Ctrl+O reasoning",
					"Permission modes: ask prompts for approval; auto approves known requests in the workspace sandbox; full-access disables filesystem and network sandboxing (use with care).",
					"Use @path or @\"path with spaces\" to attach files; /paste, Ctrl+V, or Alt+V attaches a clipboard image; use $skill-name for one prompt.",
				].join("\n"));
				break;
			case "status":
			case "settings":
			case "config":
				renderMessage(`${sessionSummary()}\nRun Codetonomy setup to manage providers and API keys.`);
				break;
			case "report":
				renderMessage(formatModelUsageReport(sessionModelUsage(conversationSession)));
				break;
			case "permissions":
				if (!command.argument) {
					renderMessage(permissionSummary(), permissionMode === "full-access" ? chalk.red : chalk.dim);
					break;
				}
				if (!isPermissionMode(command.argument)) {
					renderMessage("Permission mode must be ask, auto, or full-access", chalk.red);
					break;
				}
				changePermissionMode(command.argument);
				break;
			case "memorydb": {
				const action = command.argument.toLowerCase() || "status";
				if (action === "status") {
					renderMessage(`memoryDB is ${memoryDbEnabled ? "on" : "off"} for this project`);
					break;
				}
				if (action === "off") {
					running = true;
					void saveMemoryDbEnabled(workspaceRoot, false)
						.then(() => { memoryDbEnabled = false; closeMemoryDb(); updateFooter(); renderMessage("memoryDB disabled for this project"); })
						.catch((error) => renderMessage(error instanceof Error ? error.message : String(error), chalk.red))
						.finally(() => { running = false; status.setText(chalk.dim("ready")); tui.requestRender(); });
					break;
				}
				if (action !== "on") {
					renderMessage("MemoryDB must be on, off, or status", chalk.red);
					break;
				}
				running = true;
				status.setText(chalk.yellow("starting memoryDB"));
				const controller = new AbortController();
				abortController = controller;
				void ensureMemoryDb(conversationSession.id, controller.signal)
					.then((integration) => integration.index(controller.signal, ({ phase, completed, total, path }) => {
						status.setText(chalk.yellow(`memoryDB ${phase} ${completed}/${total}${path ? ` · ${path}` : ""}`)); tui.requestRender();
					}))
					.then(async ({ files, chunks }) => { await saveMemoryDbEnabled(workspaceRoot, true); memoryDbEnabled = true; updateFooter(); renderMessage(`memoryDB enabled · indexed ${files} files and ${chunks} new chunks`); })
					.catch((error) => { closeMemoryDb(); renderMessage(error instanceof Error ? error.message : String(error), chalk.red); })
					.finally(() => { running = false; abortController = undefined; status.setText(chalk.dim("ready")); tui.requestRender(); });
				break;
			}
			case "history":
				renderMessage(conversationSession.turns.length
					? conversationSession.turns.slice(-20).map((turn, index) => `${conversationSession.turns.length - Math.min(20, conversationSession.turns.length) + index + 1}. ${turn.objective}`).join("\n")
					: "No saved turns in this workspace session");
				break;
			case "session":
				if (!command.argument) {
					renderMessage(sessionSummaries.length
						? sessionSummaries.slice(0, 20).map(({ id, title, turnCount }) => `${id.slice(0, 8)} · ${title} · ${turnCount} turn${turnCount === 1 ? "" : "s"}`).join("\n") + "\nOpen one with /session <short-id>."
						: "No previous sessions in this workspace");
					break;
				}
				running = true;
				status.setText(chalk.yellow("loading session"));
				void loadSessionByPrefix(configurationState.directory, workspaceRoot, command.argument)
					.then((loaded) => {
						conversationSession = loaded;
						activeSkills.clear(); sessionAllowedTools.clear(); lastResult = undefined; closeMemoryDb();
						updateFooter();
						resetTranscript();
						renderMessage(`Opened ${loaded.title ?? loaded.id.slice(0, 8)} · ${loaded.id.slice(0, 8)}`);
					})
					.catch((error) => renderMessage(error instanceof Error ? error.message : String(error), chalk.red))
					.finally(() => { running = false; status.setText(chalk.dim("ready")); tui.requestRender(); });
				break;
			case "runs": {
				const runs = evaluationStore.listRuns(20);
				renderMessage(runs.length
					? runs.map((run) => `${run.verified ? "✓" : "×"} ${run.runId.slice(0, 8)} · ${run.presetId ?? run.kind} · ${run.durationMs === undefined ? "—" : `${Math.round(run.durationMs)} ms`}`).join("\n")
					: "No saved runs yet");
				break;
			}
			case "dashboard":
				renderMessage("Open the full local dashboard in another terminal with: Codetonomy dashboard");
				break;
			case "diff": {
				const checkpointPath = conversationSession.turns.at(-1)?.checkpointPath;
				if (!checkpointPath) {
					renderMessage("The last saved turn has no captured file changes");
					break;
				}
				running = true;
				status.setText(chalk.yellow("loading diff"));
				void previewCheckpoint(checkpointPath, workspaceRoot)
					.then(({ diff }) => transcript.addChild(new Markdown(`\`\`\`diff\n${sanitizeTerminalText(diff)}\n\`\`\``, 1, 1, markdownTheme)))
					.catch((error) => renderMessage(error instanceof Error ? error.message : String(error), chalk.red))
					.finally(() => {
						running = false;
						status.setText(chalk.dim("ready"));
						tui.requestRender();
					});
				break;
			}
			case "rewind": {
				const turn = conversationSession.turns.at(-1);
				if (!turn) {
					renderMessage("There is no saved turn to rewind");
					break;
				}
				running = true;
				status.setText(chalk.yellow("rewinding"));
				void (async () => {
					try {
						const result = turn.checkpointPath
							? await rewindCheckpoint(turn.checkpointPath, workspaceRoot)
							: { restored: [], deleted: [] };
						conversationSession = { ...conversationSession, updatedAt: Date.now(), turns: conversationSession.turns.slice(0, -1) };
						await saveSession(configurationState.directory, conversationSession);
						resetTranscript();
						renderMessage(`Rewound the last turn${result.restored.length || result.deleted.length ? ` · restored ${result.restored.length}, deleted ${result.deleted.length}` : " (conversation only)"}`);
					} catch (error) {
						renderMessage(error instanceof Error ? error.message : String(error), chalk.red);
					} finally {
						running = false;
						status.setText(chalk.dim("ready"));
						tui.requestRender();
					}
				})();
				break;
			}
			case "model": {
				if (!command.argument) {
					renderMessage(`Current model: ${selection.provider}/${selection.modelId}`);
					break;
				}
				const separator = command.argument.indexOf("/");
				if (separator <= 0 || separator === command.argument.length - 1) {
					renderMessage("Model must be <provider>/<model-id>", chalk.red);
					break;
				}
				const nextProvider = command.argument.slice(0, separator).toLowerCase();
				const nextModel = command.argument.slice(separator + 1);
				let nextSelection: ProviderSelection;
				try {
					nextSelection = resolveProviderSelection(configurationState, nextProvider, nextModel);
				} catch (error) {
					renderMessage(error instanceof Error ? error.message : String(error), chalk.red);
					break;
				}
				running = true;
				status.setText(chalk.yellow("saving model"));
				void persistProviderSelection(configurationState, nextSelection)
					.then(() => {
						selection = nextSelection;
						updateModelDisplay();
						updateFooter();
						renderMessage(`Model changed to ${selection.provider}/${selection.modelId}`);
						const notice = providerCompatibilityNotice(selection); if (notice) renderMessage(notice, chalk.yellow);
					})
					.catch((error) => renderMessage(error instanceof Error ? error.message : String(error), chalk.red))
					.finally(() => { running = false; status.setText(chalk.dim("ready")); tui.requestRender(); });
				break;
			}
			case "reasoning": {
				const effort = command.argument?.toLowerCase();
				if (!effort) { renderMessage(`Reasoning effort: ${reasoningEffort}`); break; }
				if (!["off", "minimal", "low", "medium", "high", "xhigh"].includes(effort)) {
					renderMessage("Reasoning effort must be off, minimal, low, medium, high, or xhigh", chalk.red);
					break;
				}
				const nextEffort = effort as typeof reasoningEffort;
				running = true;
				status.setText(chalk.yellow("saving reasoning effort"));
				configurationState.configuration = { ...configurationState.configuration, reasoningEffort: nextEffort };
				void saveConfiguration(configurationState)
					.then(() => { reasoningEffort = nextEffort; updateFooter(); renderMessage(`Reasoning effort changed to ${reasoningEffort}`); })
					.catch((error) => renderMessage(error instanceof Error ? error.message : String(error), chalk.red))
					.finally(() => { running = false; status.setText(chalk.dim("ready")); tui.requestRender(); });
				break;
			}
			case "skills": {
				const matches = command.argument
					? skills.filter(({ name }) => name.toLowerCase().includes(command.argument.toLowerCase()))
					: skills;
				const shown = matches.slice(0, 20).map(({ name, source }) => `${activeSkills.has(name) ? "✓" : "·"} ${name} (${source})`);
				renderMessage(shown.length
					? `${shown.join("\n")}${matches.length > shown.length ? `\n… ${matches.length - shown.length} more; type /skills <filter>` : ""}`
					: "No matching skills found");
				break;
			}
			case "skill": {
				if (!command.argument) {
					renderMessage(`Active skills: ${activeSkills.size ? [...activeSkills].join(", ") : "none"}`);
					break;
				}
				if (command.argument === "clear") {
					activeSkills.clear();
					renderMessage("All persistent skills disabled");
					break;
				}
				if (!skillsByName.has(command.argument)) {
					renderMessage(`Unknown skill: ${command.argument}`, chalk.red);
					break;
				}
				if (activeSkills.delete(command.argument)) renderMessage(`Disabled skill: ${command.argument}`);
				else {
					activeSkills.add(command.argument);
					renderMessage(`Enabled skill: ${command.argument}`);
				}
				break;
			}
			case "clear":
				mascot.setActivity("idle");
				resetTranscript(false);
				tui.requestRender();
				break;
			case "new": {
				activeSkills.clear();
				closeMemoryDb();
				sessionAllowedTools.clear();
				const resetPermissionMode = permissionMode === "full-access";
				if (resetPermissionMode) permissionMode = "ask";
				lastResult = undefined;
				conversationSession = createSession(conversationSession.workspace);
				updateFooter();
				mascot.setActivity("idle");
				resetTranscript(false);
				renderMessage(`New local session started${resetPermissionMode ? " · permission mode reset to ask" : ""}`);
				break;
			}
			case "quit":
			case "exit":
				stop();
				break;
			default:
				renderMessage(`Unknown command: /${command.name}. Type /help.`, chalk.red);
		}
	};
	editor.onSubmit = (raw) => {
		if (answerApproval(raw)) return;
		if (running || !raw.trim()) return;
		if (parseSlashCommand(raw)) {
			handleCommand(raw);
			return;
		}
		let prompt;
		try {
			prompt = parsePrompt(raw, new Set(skillsByName.keys()));
		} catch (error) {
			renderMessage(error instanceof Error ? error.message : String(error), chalk.red);
			return;
		}
		const submittedImages = pendingImages.filter(({ marker }) => raw.includes(marker));
		pendingImages = [];
		editor.setText("");
		transcript.addChild(new Text(`${chalk.bold("You")}  ${sanitizeTerminalText(raw)}`, 1, 1));
		running = true;
		mascot.setActivity("planning");
		mascot.start();
		const runAbortController = new AbortController();
		abortController = runAbortController;
		status.setText(chalk.yellow("running"));
		liveReasoning = undefined; liveAnswer = undefined; liveReasoningText = ""; liveAnswerText = "";
		tui.requestRender();

		const routedSkills = routeSkills(prompt.objective, skills);
		if (routedSkills.length) renderMessage(`Auto-selected skills: ${routedSkills.join(", ")}`, chalk.dim);
		void loadActivatedSkills(skills, [...activeSkills, ...prompt.skillNames, ...routedSkills])
			.then(async (activatedSkills) => {
				let objective = submittedImages.reduce((text, { marker }, index) => text.replaceAll(marker, `Attached clipboard image ${index + 1}.`), prompt.objective);
				let images: ClipboardImage[] | undefined;
				if (submittedImages.length) {
					if (modelSupportsImages(selection.provider, selection.modelId, selection.providerConfiguration)) images = submittedImages;
					else {
						status.setText(chalk.yellow("reading image with Unlimited OCR")); tui.requestRender();
						objective += `\n\n${await ocrClipboardImages(submittedImages, documentOptions, runAbortController.signal)}`;
						renderMessage(`Unlimited OCR read ${submittedImages.length} clipboard image${submittedImages.length === 1 ? "" : "s"} before the model request`, chalk.dim);
					}
				}
				const integration = memoryDbEnabled ? await ensureMemoryDb(conversationSession.id, runAbortController.signal) : undefined;
				if (integration) await integration.index(runAbortController.signal, ({ phase, completed, total }) => { status.setText(chalk.yellow(`memoryDB ${phase} ${completed}/${total}`)); tui.requestRender(); });
				return createHarness().run({
					objective,
					files: prompt.files,
					workspaceRoot,
					traceDirectory: join(configurationState.directory, "runs"),
					...selection,
					reasoningLevel: reasoningEffort,
					permissionMode,
					toolInterface,
					onStream: streamModelDelta,
					activatedSkills,
					documentOptions,
					...(images ? { images } : {}),
					...(integration ? { workspaceSearch: integration.workspaceSearch } : {}),
					signal: runAbortController.signal,
					approve: requestApproval,
					conversation: conversationSession.turns,
					sessionId: conversationSession.id,
					observers: [
					(event) => {
						if (stopped) return;
						recordModelUsage(event);
						const activity = mascotActivityForEvent(event);
						if (activity) mascot.setActivity(activity);
						if (event.type === "model.request.started") startReasoningAnimation();
						else if (event.type === "model.request.completed") stopReasoningAnimation();
						else if (event.type !== "model.first_token" && event.type !== "model.reasoning.completed") {
							if (event.type === "model.request.failed") stopReasoningAnimation();
							status.setText(eventLabel(event));
						}
						if (event.type.startsWith("subagent.")) {
							const id = typeof event.data.childId === "string" ? event.data.childId : "agent";
							const state = event.type === "subagent.requested" ? "queued"
								: event.type === "subagent.started" ? "working"
									: event.type === "subagent.completed" ? "completed" : "failed";
							subagents.set(id, { id, state }); updateAgentStrip();
						}
						tui.requestRender();
					},
					],
					runStore: evaluationStore,
				});
			})
			.then(async (result) => {
				if (stopped) return;
				lastResult = result;
				if (result.output.trim()) {
					const firstTurn = conversationSession.turns.length === 0;
					conversationSession = appendConversationTurn(conversationSession, {
						runId: result.runId,
						objective: prompt.objective,
						output: result.output,
						timestamp: Date.now(),
						...(result.checkpointPath ? { checkpointPath: result.checkpointPath } : {}),
						reasoning: result.reasoning,
						usage: result.usage,
						modelContext: result.modelContext,
						model: result.model,
						durationMs: result.durationMs,
					});
					try {
						if (firstTurn) conversationSession.title = await generateSessionTitle(prompt.objective, async (objective) => {
							const temporary = await mkdtemp(join(tmpdir(), "codetonomy-title-"));
							try {
								const titleResult = await createHarness().run({
									objective, workspaceRoot, traceDirectory: temporary, ...selection,
									evaluationVariant: "RAW_MODEL", maxOutputTokens: 24, providerRetryLimit: 0, reasoningLevel: reasoningEffort,
									observers: [recordModelUsage],
								});
								return titleResult.output;
							} finally { await rm(temporary, { recursive: true, force: true }); }
						});
						await saveSession(configurationState.directory, conversationSession);
						await refreshSessions();
					} catch (error) {
						renderMessage(`Session was not saved: ${error instanceof Error ? error.message : String(error)}`, chalk.red);
					}
				}
				mascot.setActivity(result.verification.passed ? "success" : "failed");
				if (!liveReasoning && result.reasoning?.length) for (const item of result.reasoning) transcript.addChild(new Text(showReasoning
					? chalk.dim(`Reasoning${item.truncated ? " (truncated)" : ""}\n${sanitizeTerminalText(item.text)}`)
					: chalk.dim("Reasoning hidden · Ctrl+O to show"), 1, 1));
				if (liveAnswer) liveAnswer.setText(sanitizeTerminalText(result.output));
				else transcript.addChild(new Markdown(sanitizeTerminalText(result.output), 1, 1, markdownTheme));
				transcript.addChild(new Text(chalk.dim(`Completed · ${formatDuration(result.durationMs)} · ${result.model ?? `${selection.provider}/${selection.modelId}`}`), 1, 0));
				updateFooter();
				status.setText(chalk.dim("ready"));
			})
			.catch((error) => {
				if (stopped) return;
				mascot.setActivity("failed");
				transcript.addChild(new Text(chalk.red(sanitizeTerminalText(error instanceof Error ? error.message : String(error))), 1, 1));
				status.setText(chalk.red("failed"));
			})
			.finally(() => {
				running = false;
				stopReasoningAnimation();
				abortController = undefined;
				mascot.stop();
				if (!stopped) tui.requestRender();
			});
	};

	tui.addInputListener((data) => {
		if (matchesKey(data, "ctrl+v") || matchesKey(data, "alt+v")) {
			pasteClipboard();
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+o")) {
			showReasoning = !showReasoning;
			configurationState.configuration = { ...configurationState.configuration, showReasoning };
			if (running) renderLiveReasoning(); else resetTranscript();
			renderMessage(`Reasoning traces ${showReasoning ? "shown" : "hidden"}`);
			void saveConfiguration(configurationState).catch((error) => renderMessage(`Could not save reasoning preference: ${error instanceof Error ? error.message : String(error)}`, chalk.red));
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+c")) {
			stop();
			return { consume: true };
		}
		return undefined;
	});
	tui.start();
	if (memoryDbEnabled) {
		running = true;
		status.setText(chalk.yellow("starting memoryDB"));
		void ensureMemoryDb(conversationSession.id)
			.then((integration) => integration.index(undefined, ({ phase, completed, total }) => {
				status.setText(chalk.yellow(`memoryDB ${phase} ${completed}/${total}`)); tui.requestRender();
			}))
			.then(({ files, chunks }) => renderMessage(`memoryDB ready · indexed ${files} files and ${chunks} new chunks`, chalk.dim))
			.catch((error) => { closeMemoryDb(); renderMessage(`memoryDB could not start: ${error instanceof Error ? error.message : String(error)}`, chalk.red); })
			.finally(() => { running = false; status.setText(chalk.dim("ready")); tui.requestRender(); });
	}
}
