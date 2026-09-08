import { isPermissionMode, type PermissionMode } from "@agent-harness/permissions";
import type { ToolInterface } from "@agent-harness/runtime";

export interface CliArguments {
	command: "run" | "eval" | "benchmark" | "smoke-providers" | "dashboard" | "export" | "backup" | "restore" | "verify-release" | "prune" | "memory" | "tui" | "setup" | "help";
	objective?: string;
	files: string[];
	json: boolean;
	provider?: string;
	modelId?: string;
	company?: string;
	annualReport?: string;
	historicalCsv?: string;
	outputPath?: string;
	permissionMode?: PermissionMode;
	approveWrites?: boolean;
	runId?: string;
	destination?: string;
	publicKey?: string;
	port?: number;
	days?: number;
	keep?: number;
	replace?: boolean;
	confirmEmpty?: boolean;
	live?: boolean;
	allProviders?: boolean;
	memoryEnabled?: boolean;
	maxCostUsd?: number;
	maxTotalTokens?: number;
	maxModelTurns?: number;
	maxToolCalls?: number;
	maxDurationMs?: number;
	toolInterface?: ToolInterface;
}

const usage = `Codetonomy

Usage:
  Codetonomy                         Start the terminal UI
  Codetonomy setup                   Configure LLM providers and API keys
  Codetonomy memory [on|off|status]  Configure memoryDB for this project
  Codetonomy tui                     Start the terminal UI
  Codetonomy run [options] <task>    Run one task
	Codetonomy eval [options] <task>   Compare all six harness variants
  Codetonomy benchmark [options]     Run the scanned-report valuation slice
  Codetonomy smoke-providers [options] Run a bounded live provider probe
  Codetonomy dashboard [--port N]   View local runs and evaluation metrics
  Codetonomy export <run> <dir>      Export a reproducible, redacted run bundle
  Codetonomy backup <file>           Back up the evaluation database
	Codetonomy restore <file> [--replace] Restore a validated evaluation backup
  Codetonomy verify-release <dir> --public-key <file> Verify against a trusted release key
  Codetonomy prune [options]         Remove old run records

Options:
  --file <path>                   Add an input file (repeatable)
  --provider <id>                 Select a configured or built-in provider
  --model <id>                    Select a provider model
  --json                          Print the complete run result as JSON
  --company <name>                Company name for the valuation benchmark
  --annual-report <path>          Annual-report PDF for the benchmark
  --csv <path>                    Historical financial CSV for the benchmark
  --output <path>                 Workbook output (default: output/valuation.xlsx)
  --permission-mode <mode>       Permission mode: ask (default), auto, or full-access
  --tool-interface <interface>   Workspace tools: bash with memoryDB, otherwise structured
  --approve-writes                Deprecated alias for --permission-mode auto
  --days <n>                      Retention age for prune (default: 30)
  --keep <n>                      Minimum newest runs retained (default: 100)
  --confirm-empty                 Confirm prune is allowed to retain zero runs
  --live                          Confirm real provider requests are authorized
  --all                           Probe every configured provider instead of one --provider
  --public-key <file>             Trusted release public key (or CODETONOMY_RELEASE_PUBLIC_KEY)
  --max-cost-usd <amount>         Aggregate provider-cost ceiling for run/eval/benchmark
  --max-model-turns <n>          Model turn limit (default: 100)
  --max-tool-calls <n>           Tool call limit (default: 500)
  --max-duration-ms <n>          Run deadline in milliseconds (default: 1800000)
  --max-total-tokens <n>          Aggregate token ceiling for run/eval/benchmark
  -h, --help                      Show this help

Without saved setup, the default provider is a deterministic local fixture so
the agent, tool, permission, verifier, trace, and TUI flow can be tested without
API keys.`;

export const helpText = (): string => usage;

export function parseArguments(argv: string[]): CliArguments {
	if (!argv.length) return { command: "tui", files: [], json: false, permissionMode: "ask" };
	if (argv.includes("-h") || argv.includes("--help") || argv[0] === "help") {
		return { command: "help", files: [], json: false };
	}
	if (argv[0] === "setup") {
		if (argv.length !== 1) throw new Error("Codetonomy setup does not accept arguments");
		return { command: "setup", files: [], json: false };
	}
	if (argv[0] === "memory") {
		if (argv.length === 1 || (argv.length === 2 && argv[1] === "status")) return { command: "memory", files: [], json: false };
		if (argv.length === 2 && (argv[1] === "on" || argv[1] === "off")) return { command: "memory", files: [], json: false, memoryEnabled: argv[1] === "on" };
		throw new Error("Memory requires on, off, or status");
	}
	if (argv[0] === "verify-release") {
		if (argv.length === 2) return { command: "verify-release", files: [], json: false, destination: argv[1] };
		if (argv.length === 4 && argv[2] === "--public-key" && argv[3]) return { command: "verify-release", files: [], json: false, destination: argv[1], publicKey: argv[3] };
		throw new Error("Verify-release requires <directory> and --public-key <trusted-key> (or CODETONOMY_RELEASE_PUBLIC_KEY)");
	}
	if (argv[0] === "dashboard") {
		let port: number | undefined;
		if (argv.length > 1) {
			if (argv[1] !== "--port" || !/^\d{1,5}$/.test(argv[2] ?? "") || argv.length !== 3) throw new Error("Dashboard accepts only --port <0-65535>");
			port = Number(argv[2]);
			if (port > 65_535) throw new Error("Dashboard port must be 0-65535");
		}
		return { command: "dashboard", files: [], json: false, ...(port !== undefined ? { port } : {}) };
	}
	if (argv[0] === "export" || argv[0] === "backup" || argv[0] === "restore") {
		if (argv[0] === "export" && argv.length === 3) return { command: "export", files: [], json: false, runId: argv[1], destination: argv[2] };
		if (argv[0] === "backup" && argv.length === 2) return { command: "backup", files: [], json: false, destination: argv[1] };
		if (argv[0] === "restore" && (argv.length === 2 || (argv.length === 3 && argv[2] === "--replace"))) {
			return { command: "restore", files: [], json: false, destination: argv[1], ...(argv[2] === "--replace" ? { replace: true } : {}) };
		}
		throw new Error(argv[0] === "export" ? "Export requires <run-id> <directory>" : argv[0] === "backup" ? "Backup requires <file>" : "Restore requires <file> and optionally --replace");
	}
	if (argv[0] === "prune") {
		let days = 30;
		let keep = 100;
		let confirmEmpty = false;
		for (let index = 1; index < argv.length; index++) {
			const flag = argv[index];
			if (flag === "--confirm-empty") { confirmEmpty = true; continue; }
			const value = argv[index + 1];
			if (!/^\d{1,6}$/.test(value ?? "")) throw new Error(`${flag ?? "Prune option"} requires a non-negative integer`);
			if (flag === "--days") days = Number(value);
			else if (flag === "--keep") keep = Number(value);
			else throw new Error(`Unknown prune option: ${flag}`);
			index++;
		}
		if (keep === 0 && !confirmEmpty) throw new Error("Pruning with --keep 0 requires --confirm-empty");
		return { command: "prune", files: [], json: false, days, keep, ...(confirmEmpty ? { confirmEmpty } : {}) };
	}
	if (argv[0] === "smoke-providers") {
		let provider: string | undefined;
		let live = false;
		let allProviders = false;
		for (let index = 1; index < argv.length; index++) {
			const flag = argv[index];
			if (flag === "--live") live = true;
			else if (flag === "--all") allProviders = true;
			else if (flag === "--provider") {
				const value = argv[++index];
				if (!value || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) throw new Error("--provider requires a valid provider id");
				provider = value;
			} else throw new Error(`Unknown smoke-provider option: ${flag}`);
		}
		if (!live) throw new Error("Live provider smoke requires --live");
		if (Boolean(provider) === allProviders) throw new Error("Live provider smoke requires exactly one of --provider <id> or --all");
		return { command: "smoke-providers", files: [], json: false, live, ...(provider ? { provider } : {}), ...(allProviders ? { allProviders } : {}) };
	}

	const command = argv[0] === "tui" ? "tui" : argv[0] === "benchmark" ? "benchmark" : argv[0] === "eval" ? "eval" : "run";
	const tokens = (command === "run" && argv[0] === "run") || command === "tui" || command === "benchmark" || command === "eval" ? argv.slice(1) : argv;
	const files: string[] = [];
	const objective: string[] = [];
	let json = false;
	let provider: string | undefined;
	let modelId: string | undefined;
	let company: string | undefined;
	let annualReport: string | undefined;
	let historicalCsv: string | undefined;
	let outputPath: string | undefined;
	let approveWrites = false;
	let permissionMode: PermissionMode = "ask";
	let explicitPermissionMode = false;
	let maxCostUsd: number | undefined;
	let maxTotalTokens: number | undefined;
	let toolInterface: ToolInterface | undefined;
	const limits: Pick<CliArguments, "maxModelTurns" | "maxToolCalls" | "maxDurationMs"> = {};

	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token === "--json") {
			json = true;
			continue;
		}
		if (token === "--approve-writes") {
			approveWrites = true;
			continue;
		}
		if (token === "--permission-mode") {
			const value = tokens[++index];
			if (!value || !isPermissionMode(value)) throw new Error("--permission-mode requires ask, auto, or full-access");
			if (explicitPermissionMode && value !== permissionMode) throw new Error("--permission-mode cannot specify multiple modes");
			permissionMode = value;
			explicitPermissionMode = true;
			continue;
		}
		if (token === "--tool-interface") {
			const value = tokens[++index];
			if (value !== "structured" && value !== "bash") throw new Error("--tool-interface requires structured or bash");
			toolInterface = value;
			continue;
		}
		if (token === "--max-cost-usd") {
			const value = tokens[++index];
			if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value ?? "") || Number(value) <= 0 || Number(value) > 1_000_000) throw new Error("--max-cost-usd requires a number greater than 0 and at most 1000000");
			maxCostUsd = Number(value);
			continue;
		}
		if (["--max-model-turns", "--max-tool-calls", "--max-duration-ms"].includes(token ?? "")) {
			const value = tokens[++index];
			const key = token === "--max-model-turns" ? "maxModelTurns" : token === "--max-tool-calls" ? "maxToolCalls" : "maxDurationMs";
			const maximum = key === "maxModelTurns" ? 1000 : key === "maxToolCalls" ? 10000 : 86400000;
			if (!/^[1-9]\d*$/.test(value ?? "") || Number(value) > maximum) throw new Error(`${token} requires an integer from 1 to ${maximum}`);
			limits[key] = Number(value);
			continue;
		}
		if (token === "--max-total-tokens") {
			const value = tokens[++index];
			if (!/^[1-9]\d{0,9}$/.test(value ?? "") || Number(value) > 1_000_000_000) throw new Error("--max-total-tokens requires an integer from 1 to 1000000000");
			maxTotalTokens = Number(value);
			continue;
		}
		if (token === "--file") {
			const file = tokens[++index];
			if (!file) throw new Error("--file requires a path");
			files.push(file);
			continue;
		}
		if (token === "--provider") {
			const value = tokens[++index];
			if (!value || !/^[a-z][a-z0-9-]{0,63}$/.test(value)) throw new Error("--provider requires a valid provider id");
			provider = value;
			continue;
		}
		if (token === "--model") {
			modelId = tokens[++index];
			if (!modelId) throw new Error("--model requires an id");
			continue;
		}
		if (["--company", "--annual-report", "--csv", "--output"].includes(token ?? "")) {
			const value = tokens[++index];
			if (!value) throw new Error(`${token} requires a value`);
			if (token === "--company") company = value;
			else if (token === "--annual-report") annualReport = value;
			else if (token === "--csv") historicalCsv = value;
			else outputPath = value;
			continue;
		}
		if (token?.startsWith("-")) throw new Error(`Unknown option: ${token}`);
		if (token) objective.push(token);
	}

	if (approveWrites) {
		if (explicitPermissionMode && permissionMode !== "auto") throw new Error("--approve-writes is only compatible with --permission-mode auto");
		permissionMode = "auto";
	}
	if (command === "tui") {
		if (maxCostUsd !== undefined || maxTotalTokens !== undefined || Object.keys(limits).length) throw new Error("Spend ceilings are supported by run, eval, and benchmark commands");
		return { command, files, json, provider, modelId, permissionMode, ...(toolInterface ? { toolInterface } : {}), ...(approveWrites ? { approveWrites } : {}) };
	}
	if (command === "benchmark") {
		if (objective.length) throw new Error("Benchmark accepts named options, not an objective");
		if (!company || !annualReport || !historicalCsv) throw new Error("Benchmark requires --company, --annual-report, and --csv");
		if (permissionMode === "ask") throw new Error("Benchmark creates a workbook; pass --permission-mode auto or --permission-mode full-access to authorize it");
		return {
			command,
			files,
			json,
			...limits,
			company,
			annualReport,
			historicalCsv,
			permissionMode,
			...(toolInterface ? { toolInterface } : {}),
			...(approveWrites ? { approveWrites } : {}),
			...(provider ? { provider } : {}),
			...(modelId ? { modelId } : {}),
			...(outputPath ? { outputPath } : {}),
			...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
			...(maxTotalTokens !== undefined ? { maxTotalTokens } : {}),
		};
	}
	const joined = objective.join(" ").trim();
	if (!joined) throw new Error("A task objective is required");
	return { ...limits, command, objective: joined, files, json, provider, modelId, permissionMode, ...(toolInterface ? { toolInterface } : {}), ...(approveWrites ? { approveWrites } : {}), ...(maxCostUsd !== undefined ? { maxCostUsd } : {}), ...(maxTotalTokens !== undefined ? { maxTotalTokens } : {}) };
}
