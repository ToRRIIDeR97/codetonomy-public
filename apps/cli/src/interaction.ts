import { constants } from "node:fs";
import { glob, lstat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CombinedAutocompleteProvider,
	fuzzyFilter,
	type AutocompleteItem,
	type AutocompleteProvider,
	type SlashCommand,
} from "@earendil-works/pi-tui";
import type { ActivatedSkill, SkillManifest } from "@agent-harness/contracts";

const MAX_FILES = 5_000;
const MAX_SKILL_BYTES = 64 * 1024;
const MAX_SKILL_METADATA_BYTES = 16 * 1024;
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9:_-]{0,63}$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
const MANIFEST_LIST_KEYS: Record<string, keyof Pick<
	SkillManifest,
	"dependencies" | "conflicts" | "requiredCapabilities" | "requiredTools" | "requiredPermissions" | "verifierIds"
>> = {
	dependencies: "dependencies",
	conflicts: "conflicts",
	required_capabilities: "requiredCapabilities",
	required_tools: "requiredTools",
	required_permissions: "requiredPermissions",
	verifiers: "verifierIds",
};

export async function readBoundedUtf8(path: string, maxBytes: number, label = "File"): Promise<string> {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.nlink !== 1) throw new Error(`${label} is not a regular standalone file`);
		if (info.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
		const bytes = Buffer.alloc(maxBytes + 1);
		let length = 0;
		while (length < bytes.length) {
			const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
			if (!bytesRead) break;
			length += bytesRead;
		}
		if (length > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
	} finally {
		await handle.close();
	}
}

export interface SkillEntry {
	name: string;
	path: string;
	root: string;
	source: "workspace" | "user" | "plugin" | "builtin";
	description?: string;
	version?: string;
	manifest?: SkillManifest;
}

export interface ParsedPrompt {
	objective: string;
	files: string[];
	skillNames: string[];
}

export interface SlashCommandInput {
	name: string;
	argument: string;
}

export interface ModelCompletion {
	provider: string;
	modelId: string;
	description?: string;
}

async function collectSkillRoot(
	catalog: Map<string, SkillEntry>,
	root: string,
	pattern: string,
	source: SkillEntry["source"],
): Promise<void> {
	try {
		const realRoot = await realpath(root);
		const candidates: SkillEntry[] = [];
		for await (const match of glob(pattern, { cwd: root, exclude: ["**/node_modules/**", "**/.git/**"] })) {
			const name = basename(join(root, match, ".."));
			if (SAFE_NAME.test(name)) candidates.push({ name, path: join(root, match), root: realRoot, source });
		}
		for (let offset = 0; offset < candidates.length; offset += 32) {
			const batch = await Promise.all(candidates.slice(offset, offset + 32).map(async (entry) => {
				try {
					const resolvedPath = await realpath(entry.path);
					const rel = relative(realRoot, resolvedPath);
					if (rel.startsWith("..") || isAbsolute(rel)) return entry;
					const metadata = await readSkillMetadata(resolvedPath, entry.name);
					return {
						...entry,
						name: metadata.id,
						version: metadata.version,
						...(metadata.description ? { description: metadata.description } : {}),
						manifest: metadata,
					};
				} catch {
					return entry;
				}
			}));
			for (const entry of batch) if (!catalog.has(entry.name)) catalog.set(entry.name, entry);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

async function readSkillMetadata(path: string, defaultName: string): Promise<SkillManifest> {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.nlink !== 1) throw new Error("Skill metadata is not a regular standalone file");
		const bytes = Buffer.alloc(Math.min(info.size, MAX_SKILL_METADATA_BYTES));
		let length = 0;
		while (length < bytes.length) {
			const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
			if (!bytesRead) break;
			length += bytesRead;
		}
		return parseSkillDocument(defaultName, bytes.subarray(0, length).toString("utf8"));
	} finally {
		await handle.close();
	}
}

export async function discoverSkills(
	workspaceRoot: string,
	codexRoot = join(homedir(), ".codex"),
): Promise<SkillEntry[]> {
	const catalog = new Map<string, SkillEntry>();
	const moduleDirectory = dirname(fileURLToPath(import.meta.url));
	for (const root of [resolve(moduleDirectory, "../../../skills"), resolve(moduleDirectory, "../skills")]) {
		await collectSkillRoot(catalog, root, "*/SKILL.md", "builtin");
	}
	await collectSkillRoot(catalog, join(workspaceRoot, ".agents", "skills"), "**/SKILL.md", "workspace");
	await collectSkillRoot(catalog, join(workspaceRoot, ".codex", "skills"), "**/SKILL.md", "workspace");
	await collectSkillRoot(catalog, join(codexRoot, "skills"), "**/SKILL.md", "user");
	await collectSkillRoot(catalog, join(codexRoot, "plugins", "cache"), "**/skills/**/SKILL.md", "plugin");
	return [...catalog.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export async function discoverWorkspaceFiles(workspaceRoot: string): Promise<string[]> {
	const files: string[] = [];
	// ponytail: bounded in-memory catalog; use an fd-backed index when workspaces exceed 5,000 files.
	for await (const entry of glob("**/*", {
		cwd: workspaceRoot,
		withFileTypes: true,
		exclude: [
			"**/.codetonomy/**",
			"**/.git/**",
			"**/.harness/**",
			"**/.pnpm-store/**",
			"**/.reference-repos/**",
			"**/node_modules/**",
			"**/dist/**",
		],
	})) {
		if (!entry.isFile()) continue;
		const file = relative(workspaceRoot, join(entry.parentPath, entry.name));
		if (!CONTROL_CHARACTER.test(file)) files.push(file);
		if (files.length === MAX_FILES) break;
	}
	return files.sort();
}

export function createSlashCommands(
	skills: SkillEntry[],
	models: ModelCompletion[] = [
		{ provider: "fixture", modelId: "faux-1", description: "local fixture" },
		{ provider: "openai", modelId: "gpt-5.4-mini", description: "OpenAI" },
	],
	sessions: Array<{ id: string; title: string }> = [],
): SlashCommand[] {
	const skillCompletions = (prefix: string): AutocompleteItem[] =>
		fuzzyFilter(skills, prefix, ({ name }) => name)
			.slice(0, 20)
			.map(({ name, source, description }) => ({ value: name, label: name, description: description ?? source }));
	return [
		{ name: "help", description: "Show commands and input syntax" },
		{ name: "paste", description: "Paste an image or text from the system clipboard" },
		{ name: "status", description: "Show session configuration and last-run usage" },
		{ name: "report", description: "Show token usage by model for this session" },
		{
			name: "model",
			description: "Select the provider and model",
			argumentHint: "<provider/model>",
			getArgumentCompletions: (prefix) =>
				fuzzyFilter(
					models.map(({ provider, modelId, description }) => ({
						value: `${provider}/${modelId}`,
						label: modelId,
						description: description ?? provider,
					})),
					prefix,
					({ value }) => value,
				),
		},
		{
			name: "reasoning",
			description: "Select the model reasoning effort",
			argumentHint: "<off|minimal|low|medium|high|xhigh>",
			getArgumentCompletions: (prefix) => ["off", "minimal", "low", "medium", "high", "xhigh"]
				.filter((value) => value.includes(prefix.toLowerCase()))
				.map((value) => ({ value, label: value })),
		},
		{ name: "settings", description: "Show current session settings" },
		{ name: "config", description: "Alias for /settings" },
		{
			name: "memorydb",
			description: "Toggle indexed memory for this project",
			argumentHint: "<on|off|status>",
			getArgumentCompletions: (prefix) => ["on", "off", "status"].filter((value) => value.includes(prefix.toLowerCase())).map((value) => ({ value, label: value })),
		},
		{
			name: "permissions",
			description: "Show or change the active tool permission profile",
			argumentHint: "<ask|auto|full-access>",
			getArgumentCompletions: (prefix) => ["ask", "auto", "full-access"]
				.filter((value) => value.includes(prefix.toLowerCase()))
				.map((value) => ({ value, label: value })),
		},
		{ name: "history", description: "Show saved turns in this workspace session" },
		{
			name: "session",
			description: "List or open a previous session",
			argumentHint: "[session-id]",
			getArgumentCompletions: (prefix) => fuzzyFilter(
				sessions.map(({ id, title }) => ({ value: id.slice(0, 8), label: id.slice(0, 8), description: title })),
				prefix,
				({ value }) => value,
			),
		},
		{ name: "runs", description: "Show recent verified runs from the local trace store" },
		{ name: "dashboard", description: "Show how to open the local run dashboard" },
		{ name: "rewind", description: "Restore files and conversation from the last turn" },
		{ name: "diff", description: "Preview file changes captured for the last turn" },
		{ name: "skills", description: "List available skills", argumentHint: "[filter]", getArgumentCompletions: skillCompletions },
		{
			name: "skill",
			description: "Toggle a skill for subsequent prompts",
			argumentHint: "<name|clear>",
			getArgumentCompletions: (prefix) => [
				...(prefix === "" || "clear".includes(prefix) ? [{ value: "clear", label: "clear", description: "disable all skills" }] : []),
				...skillCompletions(prefix),
			],
		},
		{ name: "clear", description: "Clear the transcript" },
		{ name: "new", description: "Start a new local session" },
		{ name: "quit", description: "Exit Codetonomy" },
		{ name: "exit", description: "Alias for /quit" },
	];
}

export function createAutocompleteProvider(
	commands: SlashCommand[],
	skills: SkillEntry[],
	files: string[],
	workspaceRoot: string,
): AutocompleteProvider {
	const delegate = new CombinedAutocompleteProvider(commands, workspaceRoot);
	return {
		triggerCharacters: ["$"],
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
			const skillPrefix = beforeCursor.match(/(?:^|\s)(\$[A-Za-z0-9:_-]*)$/)?.[1];
			if (skillPrefix) {
				const matches = fuzzyFilter(skills, skillPrefix.slice(1), ({ name }) => name).slice(0, 20);
				return matches.length
					? {
						items: matches.map(({ name, source, description }) => ({ value: name, label: name, description: description ?? source })),
						prefix: skillPrefix,
					}
					: null;
			}

			const filePrefix = beforeCursor.match(/(?:^|\s)(@(?:"[^"]*|[^\s]*))$/)?.[1];
			if (filePrefix) {
				const query = filePrefix.startsWith('@"') ? filePrefix.slice(2) : filePrefix.slice(1);
				const matches = fuzzyFilter(files, query, (file) => file).slice(0, 20);
				return matches.length
					? {
						items: matches.map((file) => ({
							value: file.includes(" ") ? `@"${file}"` : `@${file}`,
							label: basename(file),
							description: file,
						})),
						prefix: filePrefix,
					}
					: null;
			}
			return delegate.getSuggestions(lines, cursorLine, cursorCol, options);
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			if (!prefix.startsWith("$")) return delegate.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			const line = lines[cursorLine] ?? "";
			const beforePrefix = line.slice(0, cursorCol - prefix.length);
			const replacement = `$${item.value} `;
			const updated = [...lines];
			updated[cursorLine] = beforePrefix + replacement + line.slice(cursorCol);
			return { lines: updated, cursorLine, cursorCol: beforePrefix.length + replacement.length };
		},
		shouldTriggerFileCompletion: delegate.shouldTriggerFileCompletion.bind(delegate),
	};
}

export function parseSlashCommand(raw: string): SlashCommandInput | null {
	const trimmed = raw.trim();
	if (!trimmed.startsWith("/")) return null;
	const separator = trimmed.indexOf(" ");
	return separator === -1
		? { name: trimmed.slice(1).toLowerCase(), argument: "" }
		: { name: trimmed.slice(1, separator).toLowerCase(), argument: trimmed.slice(separator + 1).trim() };
}

export function parsePrompt(raw: string, knownSkills: ReadonlySet<string>): ParsedPrompt {
	const files: string[] = [];
	const skillNames: string[] = [];
	let objective = "";

	for (let index = 0; index < raw.length;) {
		const boundary = index === 0 || /\s/.test(raw[index - 1] ?? "");
		if (boundary && raw[index] === "@") {
			let end = index + 1;
			let file = "";
			if (raw[end] === '"') {
				const quoteEnd = raw.indexOf('"', end + 1);
				if (quoteEnd === -1) throw new Error("Unterminated quoted @file path");
				file = raw.slice(end + 1, quoteEnd);
				end = quoteEnd + 1;
			} else {
				while (end < raw.length && !/\s/.test(raw[end] ?? "")) end++;
				file = raw.slice(index + 1, end);
			}
			if (!file) throw new Error("@ requires a file path");
			files.push(file);
			objective += " ";
			index = end;
			continue;
		}

		if (boundary && raw[index] === "$" && /[A-Za-z]/.test(raw[index + 1] ?? "")) {
			let end = index + 2;
			while (end < raw.length && /[A-Za-z0-9:_-]/.test(raw[end] ?? "")) end++;
			const name = raw.slice(index + 1, end);
			if (knownSkills.has(name)) skillNames.push(name);
			objective += raw.slice(index, end);
			index = end;
			continue;
		}

		objective += raw[index];
		index++;
	}

	const normalizedObjective = objective.replace(/\s+/g, " ").trim();
	if (!normalizedObjective && files.length === 0) throw new Error("A task objective is required");
	return {
		objective: normalizedObjective || "Inspect the provided files",
		files: [...new Set(files)],
		skillNames: [...new Set(skillNames)],
	};
}

const unquoteManifestValue = (value: string): string => {
	const trimmed = value.trim();
	if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (typeof parsed === "string") return parsed;
		} catch {
			throw new Error(`Invalid quoted skill manifest value: ${trimmed}`);
		}
	}
	if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replaceAll("''", "'");
	return trimmed;
};

const parseManifestList = (value: string, label: string): string[] => {
	const trimmed = value.trim();
	const entries = trimmed.startsWith("[") && trimmed.endsWith("]")
		? trimmed.slice(1, -1).split(",")
		: [trimmed];
	const parsed = entries.map(unquoteManifestValue).filter(Boolean);
	if (parsed.length > 32) throw new Error(`Skill manifest ${label} exceeds 32 entries`);
	for (const entry of parsed) {
		if (!SAFE_NAME.test(entry)) throw new Error(`Invalid ${label} entry in skill manifest: ${entry}`);
	}
	return [...new Set(parsed)];
};

export function parseSkillDocument(id: string, instructions: string): SkillManifest {
	if (!SAFE_NAME.test(id)) throw new Error(`Invalid skill id: ${id}`);
	const manifest: SkillManifest = {
		id,
		version: "0.0.0",
		dependencies: [],
		conflicts: [],
		requiredCapabilities: [],
		requiredTools: [],
		requiredPermissions: [],
		verifierIds: [],
	};
	if (!instructions.startsWith("---\n") && !instructions.startsWith("---\r\n")) return manifest;
	const lines = instructions.split(/\r?\n/);
	const end = lines.indexOf("---", 1);
	if (end === -1) throw new Error(`Skill ${id} has unterminated frontmatter`);

	for (let index = 1; index < end; index++) {
		const match = lines[index]?.match(/^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/);
		if (!match) continue;
		const key = match[1]!.toLowerCase().replaceAll("-", "_");
		const target = MANIFEST_LIST_KEYS[key];
		if (target) {
			const values: string[] = [];
			const inline = match[2]?.trim() ?? "";
			if (inline) values.push(...parseManifestList(inline, key));
			while (!inline && index + 1 < end) {
				const item = lines[index + 1]?.match(/^\s+-\s+(.+)$/);
				if (!item) break;
				values.push(...parseManifestList(item[1]!, key));
				index++;
			}
			manifest[target] = [...new Set(values)];
			continue;
		}
		if (key === "version") {
			const version = unquoteManifestValue(match[2] ?? "");
			if (!version || version.length > 32 || CONTROL_CHARACTER.test(version)) throw new Error(`Invalid version in skill ${id}`);
			manifest.version = version;
		}
		if (key === "name") {
			const name = unquoteManifestValue(match[2] ?? "");
			if (!SAFE_NAME.test(name)) throw new Error(`Invalid name in skill ${id}`);
			manifest.id = name;
		}
		if (key === "description") {
			const description = unquoteManifestValue(match[2] ?? "");
			if (description.length > 500 || CONTROL_CHARACTER.test(description)) throw new Error(`Invalid description in skill ${id}`);
			if (description) manifest.description = description;
		}
	}
	return manifest;
}

const ROUTING_STOP_WORDS = new Set([
	"agent", "and", "build", "calculate", "code", "comprehensive", "create", "dependency", "export", "for", "from", "help", "implement", "implementation", "input", "invalid", "make", "package", "preserve", "project", "requirement", "return", "script", "task", "test", "that", "the", "this", "throw", "type", "use", "value", "with", "your",
]);

const routingTokens = (text: string, stopWords = ROUTING_STOP_WORDS): Set<string> => new Set(
	text.toLowerCase().match(/[a-z0-9]+/g)?.map((token) => token.length > 5 && token.endsWith("ies") ? `${token.slice(0, -3)}y` : token.length > 4 && token.endsWith("s") ? token.slice(0, -1) : token)
		.filter((token) => token.length >= 3 && !stopWords.has(token)) ?? [],
);

const ROUTING_QUERY_STOP_WORDS = new Set([...ROUTING_STOP_WORDS, "node"]);

export function routeSkills(objective: string, catalog: SkillEntry[], limit = 1): string[] {
	if (/\b(find|locate|where|which|explain|identify)\b/i.test(objective) && /\b(code|codebase|file|function|class|method|workspace|repository|implementation|source)\b/i.test(objective)) return [];
	const objectiveTokens = routingTokens(
		objective,
		/\bn8n\b/i.test(objective) ? ROUTING_STOP_WORDS : ROUTING_QUERY_STOP_WORDS,
	);
	if (!objectiveTokens.size || limit < 1) return [];
	const matches = (token: string, candidate: string) => token === candidate
		|| (Math.min(token.length, candidate.length) >= 5 && (token.startsWith(candidate) || candidate.startsWith(token)));
	const matchCount = (candidates: Set<string>): number => [...objectiveTokens]
		.filter((token) => [...candidates].some((candidate) => matches(token, candidate))).length;
	return catalog
		.filter(({ source, description }) => source !== "workspace" && Boolean(description))
		.map((skill) => {
			const nameTokens = routingTokens(skill.name.replaceAll(/[-_:]/g, " "));
			const descriptionTokens = routingTokens(skill.description ?? "");
			const nameMatches = matchCount(nameTokens);
			const descriptionMatches = matchCount(descriptionTokens);
			const exactNameMatch = [...objectiveTokens].some((token) => token.length >= 8 && nameTokens.has(token));
			return { skill, nameMatches, descriptionMatches, exactNameMatch, score: nameMatches * 4 + descriptionMatches };
		})
		.filter(({ nameMatches, descriptionMatches, exactNameMatch, score }) =>
			score >= 5 && (exactNameMatch || descriptionMatches >= 3 || nameMatches >= 2 || (nameMatches === 1 && descriptionMatches >= 2)),
		)
		.sort((left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name))
		.slice(0, Math.min(limit, 1))
		.map(({ skill }) => skill.name);
}

export async function loadActivatedSkills(catalog: SkillEntry[], names: Iterable<string>): Promise<ActivatedSkill[]> {
	const byName = new Map(catalog.map((skill) => [skill.name, skill]));
	const selected = new Map<string, ActivatedSkill>();
	const loading = new Set<string>();
	const load = async (name: string): Promise<void> => {
		if (selected.has(name)) return;
		if (loading.has(name)) throw new Error(`Skill dependency cycle: ${[...loading, name].join(" -> ")}`);
		const skill = byName.get(name);
		if (!skill) throw new Error(`Unknown skill: ${name}`);
		loading.add(name);
		if ((await lstat(skill.path)).isSymbolicLink()) throw new Error(`Skill ${name} cannot be a symbolic link`);
		const [resolvedRoot, resolvedPath] = await Promise.all([realpath(skill.root), realpath(skill.path)]);
		const rel = relative(resolvedRoot, resolvedPath);
		if (rel.startsWith("..") || rel === "" || isAbsolute(rel)) {
			throw new Error(`Skill ${name} resolves outside its catalog root`);
		}
		const instructions = await readBoundedUtf8(resolvedPath, MAX_SKILL_BYTES, `Skill ${name}`);
		const manifest = parseSkillDocument(name, instructions);
		if (manifest.id !== name) throw new Error(`Skill manifest name ${manifest.id} does not match catalog name ${name}`);
		for (const dependency of manifest.dependencies) await load(dependency);
		selected.set(name, { id: name, instructions, manifest });
		loading.delete(name);
		if (selected.size > 8) throw new Error("A run can activate at most 8 skills including dependencies");
	};
	for (const name of new Set(names)) await load(name);
	for (const skill of selected.values()) {
		const conflict = skill.manifest?.conflicts.find((name) => selected.has(name));
		if (conflict) throw new Error(`Skill conflict: ${skill.id} conflicts with ${conflict}`);
	}
	return [...selected.values()];
}
