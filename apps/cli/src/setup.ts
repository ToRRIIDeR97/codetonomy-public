import chalk from "chalk";
import {
	Container,
	CURSOR_MARKER,
	Input,
	ProcessTerminal,
	SelectList,
	Spacer,
	Text,
	TuiMainScreen,
	matchesKey,
	type Component,
	type Focusable,
	type SelectItem,
	type TUI,
} from "@earendil-works/pi-tui";
import {
	PROVIDER_PRESETS,
	apiKeyForProvider,
	apiKeyIsSet,
	fetchProviderModelCatalog,
	loadConfiguration,
	providerModelsUrl,
	saveConfiguration,
	validateConfiguration,
	type ConfigurationState,
	type ProviderPreset,
	type ProviderSettings,
} from "./config.js";
import { sanitizeTerminalText } from "./terminal.js";

const selectTheme = {
	selectedPrefix: (text: string) => chalk.cyan(text),
	selectedText: (text: string) => chalk.bold(text),
	description: (text: string) => chalk.dim(text),
	scrollInfo: (text: string) => chalk.dim(text),
	noMatch: (text: string) => chalk.dim(text),
};

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

class SetupInput extends Input {
	private inPaste = false;

	override handleInput(data: string): void {
		if (!this.inPaste && !data.includes(PASTE_START)) {
			super.handleInput(data);
			return;
		}
		let clean = data;
		if (clean.includes(PASTE_START)) {
			this.inPaste = true;
			const [before, ...after] = clean.split(PASTE_START);
			clean = `${before}${PASTE_START}${after.join("")}`;
		}
		const end = clean.indexOf(PASTE_END);
		const contentEnd = end === -1 ? clean.length : end;
		const start = clean.indexOf(PASTE_START);
		const prefixEnd = start === -1 ? 0 : start + PASTE_START.length;
		const prefix = clean.slice(0, prefixEnd);
		const content = clean.slice(prefixEnd, contentEnd).replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
		const suffix = end === -1 ? "" : clean.slice(end);
		if (end !== -1) this.inPaste = false;
		super.handleInput(prefix + content + suffix);
	}
}

class SecretInput extends SetupInput {
	override render(width: number): string[] {
		const available = Math.max(0, width - 2);
		const count = [...this.getValue()].length;
		const maximumBullets = Math.max(0, available - 1);
		const bullets = count <= maximumBullets
			? "•".repeat(count)
			: maximumBullets > 0 ? `…${"•".repeat(maximumBullets - 1)}` : "";
		const cursor = `${this.focused ? CURSOR_MARKER : ""}\x1b[7m \x1b[27m`;
		return [`> ${bullets}${cursor}${" ".repeat(Math.max(0, available - bullets.length - 1))}`];
	}
}

export class ModelPicker implements Component {
	private readonly items: SelectItem[];
	private readonly list: SelectList;
	private readonly selected: Set<string>;
	public onSubmit?: (models: string[]) => void;
	public onCancel?: () => void;

	constructor(private readonly models: string[], selected: string[] = []) {
		this.selected = new Set(selected.filter((model) => models.includes(model)));
		this.items = models.map((model) => ({ value: model, label: "" }));
		this.refreshLabels();
		this.list = new SelectList(this.items, Math.min(models.length, 12), selectTheme);
		this.list.onSelect = () => {
			if (this.selected.size) this.onSubmit?.(this.models.filter((model) => this.selected.has(model)));
		};
		this.list.onCancel = () => this.onCancel?.();
	}

	render(width: number): string[] {
		return this.list.render(width);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "space")) {
			const current = this.list.getSelectedItem()?.value;
			if (current) {
				if (!this.selected.delete(current)) this.selected.add(current);
				this.refreshLabels();
			}
			return;
		}
		this.list.handleInput(data);
	}

	invalidate(): void {
		this.list.invalidate();
	}

	private refreshLabels(): void {
		for (const item of this.items) item.label = `${this.selected.has(item.value) ? "[x]" : "[ ]"} ${item.value}`;
	}
}

class ProviderSetupComponent extends Container implements Focusable {
	private active?: Component;
	private activeInput?: Input;
	private _focused = false;
	private readonly original: ConfigurationState;
	private readonly state: ConfigurationState;
	private readonly updatedKeys = new Set<string>();
	private modelRequest?: AbortController;

	constructor(
		private readonly tui: TUI,
		state: ConfigurationState,
		private readonly onExit: (message: string) => void,
	) {
		super();
		this.original = structuredClone(state);
		this.state = structuredClone(state);
		this.showMain();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if (this.activeInput) this.activeInput.focused = value;
	}

	handleInput(data: string): void {
		this.active?.handleInput?.(data);
		this.tui.requestRender();
	}

	cancel(): void {
		this.modelRequest?.abort();
		this.onExit("Setup cancelled; no changes were saved.");
	}

	private setScreen(title: string, description: string, content: Component, hint: string, error?: string): void {
		this.clear();
		this.addChild(new Text(chalk.bold.cyan("◆ CODETONOMY SETUP"), 1, 1));
		this.addChild(new Text(chalk.bold(title), 1, 0));
		if (description) this.addChild(new Text(chalk.dim(description), 1, 0));
		if (error) this.addChild(new Text(chalk.red(sanitizeTerminalText(error)), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(content);
		this.addChild(new Spacer(1));
		this.addChild(new Text(chalk.dim(hint), 1, 1));
		this.active = content;
		this.activeInput = content instanceof Input ? content : undefined;
		if (this.activeInput) this.activeInput.focused = this.focused;
		this.tui.requestRender(true);
	}

	private showMenu(
		title: string,
		description: string,
		items: SelectItem[],
		onSelect: (value: string) => void,
		onCancel: () => void,
	): void {
		const list = new SelectList(items, Math.min(items.length, 12), selectTheme);
		list.onSelect = ({ value }) => onSelect(value);
		list.onCancel = onCancel;
		this.setScreen(title, description, list, "↑↓ navigate · Enter select · Esc back · Ctrl+C cancel");
	}

	private prompt(
		title: string,
		label: string,
		defaultValue: string,
		secret: boolean,
		onSubmit: (value: string) => void,
		onCancel: () => void,
		error?: string,
	): void {
		const input = secret ? new SecretInput() : new SetupInput();
		input.onSubmit = (value) => onSubmit(value.trim() || defaultValue);
		input.onEscape = onCancel;
		this.setScreen(
			title,
			defaultValue && !secret ? `${label}\n${chalk.dim(`Press Enter to keep: ${defaultValue}`)}` : label,
			input,
			"Enter submit · Esc go back · Ctrl+C cancel",
			error,
		);
	}

	private showMain(): void {
		const providers = this.state.configuration.providers.map((provider): SelectItem => ({
			value: `provider:${provider.id}`,
			label: `${this.state.configuration.defaultProvider === provider.id ? "★" : "·"} ${provider.name}`,
			description: `${provider.modelId} · ${provider.models.length} selected · ${apiKeyIsSet(this.state, provider) ? "key set" : provider.kind.endsWith("-compatible") ? "no stored key" : "key missing"}`,
		}));
		this.showMenu("Provider configuration", "Changes stay staged until Save and exit.", [
			...providers,
			{ value: "add", label: "Add provider", description: "OpenAI, Anthropic, Gemini, DeepSeek, OpenRouter, or OpenCode" },
			{ value: "add-openai-compatible", label: "Add OpenAI-compatible provider", description: "Ollama, vLLM, SGLang, or another endpoint" },
			{ value: "add-anthropic-compatible", label: "Add Anthropic-compatible provider", description: "custom Anthropic Messages endpoint" },
			{ value: "save", label: "Save and exit", description: "write staged configuration and credentials" },
			{ value: "cancel", label: "Cancel", description: "discard all staged changes" },
		], (value) => {
			if (value.startsWith("provider:")) this.showProvider(value.slice("provider:".length));
			else if (value === "add") this.showPresetPicker();
			else if (value === "add-openai-compatible") this.beginCustom("openai-compatible");
			else if (value === "add-anthropic-compatible") this.beginCustom("anthropic-compatible");
			else if (value === "save") this.showSaveReview();
			else this.cancel();
		}, () => this.cancel());
	}

	private showPresetPicker(): void {
		const configured = new Set(this.state.configuration.providers.map(({ id }) => id));
		const available = PROVIDER_PRESETS.filter(({ id }) => !configured.has(id));
		this.showMenu("Add provider", available.length ? "Choose a provider preset." : "All provider presets are already configured.", [
			...available.map((provider) => ({ value: provider.id, label: provider.name, description: provider.modelId })),
			{ value: "back", label: "Back" },
		], (value) => {
			if (value === "back") this.showMain();
			else this.beginPreset(PROVIDER_PRESETS.find(({ id }) => id === value)!);
		}, () => this.showMain());
	}

	private beginPreset(preset: ProviderPreset): void {
		const provider: ProviderSettings = { ...preset, models: [preset.modelId] };
		this.configureProviderModels(provider, (configured) => this.stageProvider(configured), () => this.showPresetPicker());
	}

	private beginCustom(kind: "openai-compatible" | "anthropic-compatible", error?: string): void {
		const label = kind === "openai-compatible" ? "OpenAI-compatible provider" : "Anthropic-compatible provider";
		this.prompt(`Add ${label}`, "Provider name", "", false, (name) => {
			const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64);
			if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || this.state.configuration.providers.some((provider) => provider.id === id)) {
				this.beginCustom(kind, "Use a unique name beginning with a letter.");
				return;
			}
			this.prompt(`Configure ${name}`, "Base URL", kind === "openai-compatible" ? "http://127.0.0.1:11434/v1" : "", false, (baseUrl) => {
				const provider: ProviderSettings = {
					id,
					name,
					kind,
					baseUrl,
					modelId: "unconfigured",
					models: ["unconfigured"],
					apiKeyEnv: `CODETONOMY_${id.toUpperCase().replace(/-/g, "_")}_API_KEY`,
				};
				this.configureProviderModels(provider, (configured) => this.stageProvider(configured), () => this.showMain());
			}, () => this.showMain());
		}, () => this.showMain(), error);
	}

	private configureProviderModels(
		provider: ProviderSettings,
		onDone: (provider: ProviderSettings) => void,
		onCancel: () => void,
	): void {
		this.promptForKey(provider, () => {
			this.loadModels(provider, onDone, () => this.configureProviderModels(provider, onDone, onCancel));
		}, onCancel);
	}

	private promptForKey(provider: ProviderSettings, onDone: () => void, onCancel: () => void): void {
		const status = apiKeyIsSet(this.state, provider)
			? `${provider.apiKeyEnv} is already set. Leave blank to keep it.`
			: provider.kind.endsWith("-compatible")
				? `Enter ${provider.apiKeyEnv}, or leave blank for a keyless endpoint.`
				: `Enter ${provider.apiKeyEnv}, or leave blank to configure it later.`;
		this.prompt(`Configure ${provider.name}`, status, "", true, (apiKey) => {
			if (apiKey) {
				this.state.credentials[provider.apiKeyEnv] = apiKey;
				this.updatedKeys.add(provider.apiKeyEnv);
			}
			onDone();
		}, onCancel);
	}

	private loadModels(
		provider: ProviderSettings,
		onDone: (provider: ProviderSettings) => void,
		onCancel: () => void,
	): void {
		let endpoint: string;
		try {
			endpoint = providerModelsUrl(provider);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error), onCancel);
			return;
		}
		this.modelRequest?.abort();
		const request = new AbortController();
		this.modelRequest = request;
		this.setScreen(`Loading ${provider.name} models`, endpoint, new Text(chalk.dim("Contacting provider…"), 1, 0), "Ctrl+C cancel");
		void fetchProviderModelCatalog(provider, apiKeyForProvider(this.state, provider), request.signal).then(
			(catalog) => {
				if (request.signal.aborted) return;
				this.modelRequest = undefined;
				const { models, metadata } = catalog;
				const picker = new ModelPicker(models, provider.models);
				picker.onSubmit = (selected) => onDone({
					...provider,
					modelId: selected.includes(provider.modelId) ? provider.modelId : selected[0]!,
					models: selected,
					...(metadata.length ? { modelMetadata: metadata.filter(({ id }) => selected.includes(id)) } : {}),
				});
				picker.onCancel = onCancel;
				this.setScreen(
					`Select ${provider.name} models`,
					`${models.length} runnable models loaded from ${endpoint}`,
					picker,
					"↑↓ navigate · Space tick/untick · Enter confirm · Esc back · Ctrl+C cancel",
				);
			},
			(error) => {
				if (request.signal.aborted) return;
				this.modelRequest = undefined;
				this.showError(error instanceof Error ? error.message : String(error), onCancel);
			},
		);
	}

	private stageProvider(provider: ProviderSettings): void {
		try {
			const providers = this.state.configuration.providers.filter(({ id }) => id !== provider.id).concat(provider);
			this.state.configuration = validateConfiguration({
				...this.state.configuration,
				providers,
				defaultProvider: this.state.configuration.defaultProvider ?? provider.id,
			});
			this.showMain();
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error), () => this.showMain());
		}
	}

	private showProvider(id: string): void {
		const provider = this.state.configuration.providers.find((entry) => entry.id === id);
		if (!provider) {
			this.showMain();
			return;
		}
		const items: SelectItem[] = [
			{ value: "models", label: "Refresh and select models", description: `${provider.models.length} selected · default ${provider.modelId}` },
			...(provider.kind.endsWith("-compatible") ? [{ value: "endpoint", label: "Edit endpoint", description: provider.baseUrl }] : []),
			{ value: "key", label: "Update API key", description: provider.apiKeyEnv },
			{ value: "default", label: "Set as default", description: this.state.configuration.defaultProvider === id ? "current default" : undefined },
			{ value: "remove", label: "Remove provider" },
			{ value: "back", label: "Back" },
		];
		this.showMenu(`Manage ${provider.name}`, `${provider.kind} · ${apiKeyIsSet(this.state, provider) ? "key set" : provider.kind.endsWith("-compatible") ? "no stored key" : "key missing"}`, items, (value) => {
			if (value === "models") {
				this.loadModels(provider, (configured) => this.stageProvider(configured), () => this.showProvider(id));
			} else if (value === "endpoint") {
				this.prompt(`Edit ${provider.name}`, "Base URL", provider.baseUrl ?? "", false, (baseUrl) => {
					const updated = { ...provider, baseUrl };
					this.loadModels(updated, (configured) => this.stageProvider(configured), () => this.showProvider(id));
				}, () => this.showProvider(id));
			} else if (value === "key") {
				this.promptForKey(provider, () => this.showProvider(id), () => this.showProvider(id));
			} else if (value === "default") {
				this.state.configuration.defaultProvider = id;
				this.showProvider(id);
			} else if (value === "remove") this.confirmRemove(provider);
			else this.showMain();
		}, () => this.showMain());
	}

	private confirmRemove(provider: ProviderSettings): void {
		this.showMenu("Remove provider?", `${provider.name} will be removed when you save.`, [
			{ value: "remove", label: "Remove", description: provider.id },
			{ value: "back", label: "Back" },
		], (value) => {
			if (value !== "remove") {
				this.showProvider(provider.id);
				return;
			}
			this.state.configuration.providers = this.state.configuration.providers.filter(({ id }) => id !== provider.id);
			if (this.state.configuration.defaultProvider === provider.id) {
				this.state.configuration.defaultProvider = this.state.configuration.providers[0]?.id;
			}
			if (!this.state.configuration.providers.some(({ apiKeyEnv }) => apiKeyEnv === provider.apiKeyEnv)) {
				delete this.state.credentials[provider.apiKeyEnv];
				this.updatedKeys.add(provider.apiKeyEnv);
			}
			this.showMain();
		}, () => this.showProvider(provider.id));
	}

	private pendingSummary(): string[] {
		const before = new Map(this.original.configuration.providers.map((provider) => [provider.id, provider]));
		const after = new Map(this.state.configuration.providers.map((provider) => [provider.id, provider]));
		const added = [...after.keys()].filter((id) => !before.has(id));
		const removed = [...before.keys()].filter((id) => !after.has(id));
		const edited = [...after.keys()].filter((id) => before.has(id) && JSON.stringify(before.get(id)) !== JSON.stringify(after.get(id)));
		const defaultProvider = this.state.configuration.providers.find(({ id }) => id === this.state.configuration.defaultProvider);
		return [
			...(added.length ? [`Added: ${added.join(", ")}`] : []),
			...(edited.length ? [`Edited: ${edited.join(", ")}`] : []),
			...(removed.length ? [`Removed: ${removed.join(", ")}`] : []),
			...(this.original.configuration.defaultProvider !== this.state.configuration.defaultProvider
				? [`Default model: ${defaultProvider ? `${defaultProvider.id}/${defaultProvider.modelId}` : "fixture/faux-1"}`]
				: []),
			...(this.updatedKeys.size ? [`API keys updated: ${this.updatedKeys.size}`] : []),
		];
	}

	private showSaveReview(): void {
		const summary = this.pendingSummary();
		this.showMenu("Pending changes", summary.length ? summary.join("\n") : "No changes.", [
			{ value: "save", label: "Save and exit" },
			{ value: "back", label: "Back" },
		], (value) => {
			if (value === "back") {
				this.showMain();
				return;
			}
			this.setScreen("Saving", "Writing provider configuration and credentials…", new Text("", 1, 0), "");
			void saveConfiguration(this.state).then(
				() => this.onExit(`Setup complete. Configuration saved to ${this.state.directory}`),
				(error) => this.showError(error instanceof Error ? error.message : String(error), () => this.showSaveReview()),
			);
		}, () => this.showMain());
	}

	private showError(message: string, onBack: () => void): void {
		this.showMenu("Could not continue", sanitizeTerminalText(message), [{ value: "back", label: "Back" }], onBack, onBack);
	}
}

export async function startSetup(directory?: string): Promise<void> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Codetonomy setup requires an interactive TTY");
	const state = await loadConfiguration(directory);
	const tui = new TuiMainScreen(new ProcessTerminal());
	await new Promise<void>((resolve) => {
		let stopped = false;
		const finish = (message: string) => {
			if (stopped) return;
			stopped = true;
			tui.stop();
			console.log(sanitizeTerminalText(message));
			resolve();
		};
		const setup = new ProviderSetupComponent(tui, state, finish);
		tui.addChild(setup);
		tui.setFocus(setup);
		tui.addInputListener((data) => {
			if (!matchesKey(data, "ctrl+c")) return undefined;
			setup.cancel();
			return { consume: true };
		});
		tui.start();
	});
}
