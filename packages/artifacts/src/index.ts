import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface HistoricalFinancial {
	year: number;
	revenue: number;
	ebitda: number;
	freeCashFlow: number;
	source?: string;
}

export interface ValuationScenario {
	name: string;
	revenueGrowth: number;
	ebitdaMargin: number;
}

export interface SourceNote {
	label: string;
	source: string;
	page?: number;
}

export interface ValuationWorkbookSpec {
	company: string;
	outputPath: string;
	historical: HistoricalFinancial[];
	scenarios: ValuationScenario[];
	discountRate: number;
	terminalGrowthRate: number;
	taxRate?: number;
	sources: SourceNote[];
}

export interface WorkbookInspection {
	path: string;
	sheets: Array<{ name: string; rows: number; columns: number }>;
	formulas: number;
	scenarios: string[];
}

export interface WorkbookVerification {
	passed: boolean;
	checks: Array<{ id: string; passed: boolean; message: string }>;
	inspection: WorkbookInspection;
}

export interface SpreadsheetWorkerOptions {
	python?: string;
	workerPath?: string;
	timeoutMs?: number;
}

export interface PresentationSlideSpec {
	role: "title" | "content" | "summary" | "sources";
	title: string;
	bullets?: string[];
	source?: string;
	chart?: {
		title: string;
		categories: string[];
		series: Array<{ name: string; values: number[] }>;
		source: string;
	};
}

export interface PresentationDeckSpec {
	title: string;
	subtitle?: string;
	outputPath: string;
	slides: PresentationSlideSpec[];
}

export interface PresentationInspection {
	path: string;
	slides: Array<{ number: number; title: string; roles: string[]; shapes: number; textCharacters: number }>;
	roles: string[];
	overflowCount: number;
	collisionCount: number;
	chartCount: number;
	sourcedChartCount: number;
	renderedSlides: number;
}

export interface PresentationVerification {
	passed: boolean;
	checks: Array<{ id: string; passed: boolean; message: string }>;
	inspection: PresentationInspection;
}

export interface BacktestSpec {
	dataPath: string;
	outputPath: string;
	shortWindow: number;
	longWindow: number;
	trainFraction: number;
	commissionBps?: number;
	initialCapital?: number;
}

export interface BacktestInspection {
	path: string;
	rows: number;
	trades: number;
	resultHash: string;
	split: { index: number; trainEnd: string; outOfSampleStart: string };
}

export interface BacktestVerification {
	passed: boolean;
	checks: Array<{ id: string; passed: boolean; message: string }>;
	inspection: BacktestInspection;
}

const packagedWorkerPath = (name: string): string => {
	const moduleDirectory = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		resolve(moduleDirectory, `../../../services/${name}/worker.py`),
		resolve(moduleDirectory, `../../services/${name}/worker.py`),
		resolve(moduleDirectory, `../services/${name}/worker.py`),
	];
	return candidates.find(existsSync) ?? candidates[0]!;
};
const workerPath = (): string => packagedWorkerPath("spreadsheet-worker");
const presentationWorkerPath = (): string => packagedWorkerPath("presentation-worker");
const backtestingWorkerPath = (): string => packagedWorkerPath("backtesting-worker");

const pythonBinary = (explicit?: string): string => {
	if (explicit) return explicit;
	if (process.env.CODETONOMY_PYTHON) return process.env.CODETONOMY_PYTHON;
	const workerRoots = [
		process.env.CODETONOMY_WORKER_ROOT,
		process.env.CODETONOMY_HOME ? join(process.env.CODETONOMY_HOME, "workers") : undefined,
		join(homedir(), ".codetonomy", "workers"),
	].filter((value): value is string => Boolean(value));
	const candidates = workerRoots.flatMap((root) => process.platform === "win32"
		? [join(root, "artifacts", "Scripts", "python.exe")]
		: [join(root, "artifacts", "bin", "python3"), join(root, "artifacts", "bin", "python")]);
	return candidates.find(existsSync) ?? (process.platform === "win32" ? "python" : "python3");
};

async function runWorker<T>(
	request: object,
	options: SpreadsheetWorkerOptions = {},
	signal?: AbortSignal,
	label = "Spreadsheet",
	defaultWorkerPath = workerPath(),
): Promise<T> {
	const input = `${JSON.stringify(request)}\n`;
	if (Buffer.byteLength(input) > MAX_REQUEST_BYTES) throw new Error(`${label} worker request exceeds 512 KiB`);
	if (signal?.aborted) throw new Error(`${label} operation aborted`);
	return new Promise((resolveWorker, rejectWorker) => {
		const child = spawn(pythonBinary(options.python), [options.workerPath ?? defaultWorkerPath], {
			detached: process.platform !== "win32",
			stdio: ["pipe", "pipe", "pipe"],
				env: {
					PATH: process.env.PATH,
					...(process.platform === "win32" ? {
						SystemRoot: process.env.SystemRoot,
						WINDIR: process.env.WINDIR,
						TEMP: process.env.TEMP,
						TMP: process.env.TMP,
						USERPROFILE: process.env.USERPROFILE,
						APPDATA: process.env.APPDATA,
						LOCALAPPDATA: process.env.LOCALAPPDATA,
					} : {}),
				LANG: process.env.LANG ?? "C.UTF-8",
				LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
				PYTHONNOUSERSITE: "1",
				CODETONOMY_HOME: process.env.CODETONOMY_HOME,
				CODETONOMY_WORKER_ROOT: process.env.CODETONOMY_WORKER_ROOT,
				CODETONOMY_SOFFICE_BIN: process.env.CODETONOMY_SOFFICE_BIN,
				CODETONOMY_PDFTOPPM_BIN: process.env.CODETONOMY_PDFTOPPM_BIN,
			},
			windowsHide: true,
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let outputBytes = 0;
		let errorBytes = 0;
		let failure: Error | undefined;
		let killTimer: NodeJS.Timeout | undefined;
		let killedOnExit = false;
		const killTree = (force: boolean) => {
			if (!child.pid) return;
			if (process.platform === "win32") {
				const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])], { stdio: "ignore", windowsHide: true });
				const fallback = () => { try { child.kill(force ? "SIGKILL" : "SIGTERM"); } catch {} };
				killer.once("error", fallback);
				killer.once("close", (code) => { if (code !== 0) fallback(); });
				return;
			}
			try { process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM"); } catch {}
		};
		const onParentExit = () => killTree(true);
		if (process.platform !== "win32") process.once("exit", onParentExit);
		const terminate = (error: Error) => {
			if (failure) return;
			failure = error;
			killTree(false);
			killTimer = setTimeout(() => killTree(true), 1_000);
			killTimer.unref();
		};
		child.stdout.on("data", (chunk: Buffer) => {
			outputBytes += chunk.length;
			if (outputBytes > MAX_RESPONSE_BYTES) terminate(new Error(`${label} worker response exceeds 1 MiB`));
			else stdout.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			errorBytes += chunk.length;
			if (errorBytes <= MAX_RESPONSE_BYTES) stderr.push(chunk);
		});
		const onAbort = () => terminate(new Error(`${label} operation aborted`));
		signal?.addEventListener("abort", onAbort, { once: true });
		const timeout = setTimeout(() => terminate(new Error(`${label} worker timed out`)), options.timeoutMs ?? 60_000);
		timeout.unref();
		child.once("error", (error) => { failure = error; });
		child.once("exit", () => {
			killedOnExit = true;
			killTree(true);
		});
		child.once("close", (code) => {
			clearTimeout(timeout);
			if (killTimer) clearTimeout(killTimer);
			if (!killedOnExit) killTree(true);
			process.removeListener("exit", onParentExit);
			signal?.removeEventListener("abort", onAbort);
			if (failure) {
				rejectWorker(failure);
				return;
			}
			if (code !== 0) {
				rejectWorker(new Error(Buffer.concat(stderr).toString("utf8").trim() || `${label} worker exited ${code}`));
				return;
			}
			try {
				const response = JSON.parse(Buffer.concat(stdout).toString("utf8")) as { ok?: boolean; result?: T; error?: string };
				if (!response.ok || response.result === undefined) throw new Error(response.error || `Invalid ${label.toLowerCase()} worker response`);
				resolveWorker(response.result);
			} catch (error) {
				rejectWorker(error);
			}
		});
		child.stdin.end(input);
	});
}

async function confinedPath(
	workspaceRoot: string,
	requestedPath: string,
	mustExist: boolean,
	label = "Workbook",
	maximumBytes = 20 * 1024 * 1024,
): Promise<{ root: string; path: string; relativePath: string }> {
	const root = await realpath(workspaceRoot);
	const path = isAbsolute(requestedPath) && mustExist ? await realpath(requestedPath) : resolve(root, requestedPath);
	const relativePath = relative(root, path);
	if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) throw new Error(`${label} path is outside the workspace`);
	let ancestor = mustExist ? path : dirname(path);
	for (;;) {
		try {
			const resolvedAncestor = await realpath(ancestor);
			const rel = relative(root, resolvedAncestor);
			if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${label} path resolves outside the workspace`);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" || mustExist) throw error;
			const parent = dirname(ancestor);
			if (parent === ancestor) throw new Error(`${label} path has no workspace ancestor`);
			ancestor = parent;
		}
	}
	if (mustExist) {
		const info = await lstat(path);
		if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error(`${label} must be a regular standalone file`);
		if (info.size > maximumBytes) throw new Error(`${label} exceeds ${Math.floor(maximumBytes / (1024 * 1024))} MiB`);
	}
	return { root, path, relativePath };
}

const workerRelativePath = (root: string, path: string): string => relative(root, path);

export async function createValuationWorkbook(
	workspaceRoot: string,
	spec: ValuationWorkbookSpec,
	options?: SpreadsheetWorkerOptions,
	signal?: AbortSignal,
): Promise<WorkbookInspection> {
	const target = await confinedPath(workspaceRoot, spec.outputPath, false);
	return runWorker<WorkbookInspection>({ operation: "create_valuation", workspace: target.root, spec: { ...spec, outputPath: workerRelativePath(target.root, target.path) } }, options, signal);
}

export async function inspectWorkbook(
	workspaceRoot: string,
	path: string,
	options?: SpreadsheetWorkerOptions,
	signal?: AbortSignal,
): Promise<WorkbookInspection> {
	const target = await confinedPath(workspaceRoot, path, true);
	return runWorker<WorkbookInspection>({ operation: "inspect", workspace: target.root, path: workerRelativePath(target.root, target.path) }, options, signal);
}

export async function verifyValuationWorkbook(
	workspaceRoot: string,
	path: string,
	options?: SpreadsheetWorkerOptions,
	signal?: AbortSignal,
): Promise<WorkbookVerification> {
	const target = await confinedPath(workspaceRoot, path, true);
	return runWorker<WorkbookVerification>({ operation: "verify_valuation", workspace: target.root, path: workerRelativePath(target.root, target.path) }, options, signal);
}

export async function createPresentation(
	workspaceRoot: string,
	spec: PresentationDeckSpec,
	options?: SpreadsheetWorkerOptions,
	signal?: AbortSignal,
): Promise<PresentationInspection> {
	const target = await confinedPath(workspaceRoot, spec.outputPath, false, "Presentation", 30 * 1024 * 1024);
	return runWorker<PresentationInspection>(
		{ operation: "create", workspace: target.root, spec: { ...spec, outputPath: workerRelativePath(target.root, target.path) } },
		options,
		signal,
		"Presentation",
		presentationWorkerPath(),
	);
}

export async function inspectPresentation(
	workspaceRoot: string,
	path: string,
	options?: SpreadsheetWorkerOptions,
	signal?: AbortSignal,
): Promise<PresentationInspection> {
	const target = await confinedPath(workspaceRoot, path, true, "Presentation", 30 * 1024 * 1024);
	return runWorker<PresentationInspection>(
		{ operation: "inspect", workspace: target.root, path: workerRelativePath(target.root, target.path) },
		options,
		signal,
		"Presentation",
		presentationWorkerPath(),
	);
}

export async function verifyPresentation(
	workspaceRoot: string,
	path: string,
	options?: SpreadsheetWorkerOptions,
	signal?: AbortSignal,
): Promise<PresentationVerification> {
	const target = await confinedPath(workspaceRoot, path, true, "Presentation", 30 * 1024 * 1024);
	return runWorker<PresentationVerification>(
		{ operation: "verify", workspace: target.root, path: workerRelativePath(target.root, target.path) },
		options,
		signal,
		"Presentation",
		presentationWorkerPath(),
	);
}

export async function runBacktest(
	workspaceRoot: string,
	spec: BacktestSpec,
	options?: SpreadsheetWorkerOptions,
	signal?: AbortSignal,
): Promise<BacktestInspection> {
	const data = await confinedPath(workspaceRoot, spec.dataPath, true, "Backtest data");
	const target = await confinedPath(workspaceRoot, spec.outputPath, false, "Backtest output");
	return runWorker<BacktestInspection>(
		{
			operation: "run",
			workspace: target.root,
			spec: {
				...spec,
				dataPath: workerRelativePath(data.root, data.path),
				outputPath: workerRelativePath(target.root, target.path),
			},
		},
		options,
		signal,
		"Backtesting",
		backtestingWorkerPath(),
	);
}

export async function verifyBacktest(
	workspaceRoot: string,
	path: string,
	options?: SpreadsheetWorkerOptions,
	signal?: AbortSignal,
): Promise<BacktestVerification> {
	const target = await confinedPath(workspaceRoot, path, true, "Backtest output");
	return runWorker<BacktestVerification>(
		{ operation: "verify", workspace: target.root, path: workerRelativePath(target.root, target.path) },
		options,
		signal,
		"Backtesting",
		backtestingWorkerPath(),
	);
}
