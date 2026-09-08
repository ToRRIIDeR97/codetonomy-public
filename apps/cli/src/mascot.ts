import chalk from "chalk";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { HarnessEvent } from "@agent-harness/contracts";
import { sanitizeTerminalText } from "./terminal.js";

export type MascotActivity = "idle" | "planning" | "searching" | "building" | "verifying" | "success" | "failed";

const ice = chalk.hex("#b9def5");
const border = chalk.hex("#5e9fc9");

type Pixel = " " | "W" | "I" | "S" | "N" | "G" | "R";
const PIXEL_COLOR: Record<Exclude<Pixel, " ">, string> = {
	W: "#f4fbff",
	I: "#e5e9ec",
	S: "#cbd2d8",
	N: "#111820",
	G: "#36d66b",
	R: "#ff5263",
};

const pixelFrame = (rows: string[]): string[] => {
	const width = Math.max(...rows.map((row) => row.length));
	const normalized = rows.map((row) => row.padEnd(width));
	const rendered: string[] = [];
	for (let row = 0; row < normalized.length; row += 2) {
		let line = "";
		for (let column = 0; column < width; column++) {
			const top = normalized[row]?.[column] as Pixel ?? " ";
			const bottom = normalized[row + 1]?.[column] as Pixel ?? " ";
			if (top === " " && bottom === " ") line += " ";
			else if (bottom === " ") line += chalk.hex(PIXEL_COLOR[top as Exclude<Pixel, " ">])("▀");
			else if (top === " ") line += chalk.hex(PIXEL_COLOR[bottom as Exclude<Pixel, " ">])("▄");
			else line += chalk.hex(PIXEL_COLOR[top as Exclude<Pixel, " ">]).bgHex(PIXEL_COLOR[bottom as Exclude<Pixel, " ">])("▀");
		}
		rendered.push(line.trimEnd());
	}
	return rendered;
};

const STANDING = [
	"                               ",
	"       NNNNNNNNN               ",
	"     NNWWWWWWWWWNN   NN NN     ",
	"    NWWWWWWWWWWWWWNNNWNWN      ",
	"   NWWWWWWWWWWWWWWWWWWWWWNN   ",
	"  NWWWWWWWWWWWWWWWWWWWWNWWNN  ",
	" NWWWWWWWWWWWWWWWWWWWWWWNWWN  ",
	" NWWWWWWWWWWWWWWWWWWWWWWWWWNN ",
	" NWWWWWWWWWWWWWWWWWWWWWNNNNN  ",
	" NWWWWWWWWSWWWWWWWWWWWNN       ",
	" NWWWWWWWWNNNNNWWWWWWN         ",
	" NWWWWWWN     NWWWWWWN         ",
	" NWWWWWWN     NWWWWWWN         ",
	" NWWWWWWNN    NWWWWWWNN        ",
	" NNNNNNNN     NNNNNNNN         ",
	"                               ",
];

const LOWERED = [
	"                               ",
	"       NNNNNNNNN               ",
	"     NNWWWWWWWWWNN             ",
	"    NWWWWWWWWWWWWWNN   NN NN   ",
	"   NWWWWWWWWWWWWWWWWNNNWNWN    ",
	"  NWWWWWWWWWWWWWWWWWWWWWWWNN   ",
	" NWWWWWWWWWWWWWWWWWWWWWWNWWNN  ",
	" NWWWWWWWWWWWWWWWWWWWWWWWNWWN  ",
	" NWWWWWWWWWWWWWWWWWWWWWWWWWNN  ",
	" NWWWWWWWWSWWWWWWWWWWWWNNNNN   ",
	" NWWWWWWWWNNNNNWWWWWWN          ",
	" NWWWWWWN     NWWWWWWN          ",
	" NWWWWWWN     NWWWWWWN          ",
	" NWWWWWWNN    NWWWWWWNN         ",
	" NNNNNNNN     NNNNNNNN          ",
	"                               ",
];

const withPixels = (base: string[], changes: Array<[number, number, Pixel]>): string[] => {
	const rows = base.map((row) => [...row]);
	for (const [row, column, pixel] of changes) rows[row]![column] = pixel;
	return rows.map((row) => row.join(""));
};

const FRAMES: Record<MascotActivity, string[][]> = {
	idle: [pixelFrame(STANDING), pixelFrame(withPixels(STANDING, [[5, 25, "W"]]))],
	planning: [pixelFrame(LOWERED), pixelFrame(withPixels(LOWERED, [[3, 26, "N"], [3, 27, " "]] ))],
	searching: [pixelFrame(withPixels(STANDING, [[7, 29, "S"]])), pixelFrame(withPixels(STANDING, [[7, 29, " "], [7, 30, "S"]]))],
	building: [
		pixelFrame(withPixels(STANDING, [[11, 22, " "], [12, 22, " "], [13, 22, " "], [14, 22, " "]])),
		pixelFrame(withPixels(STANDING, [[11, 22, " "], [12, 22, " "], [13, 22, " "], [14, 22, " "], [12, 24, "W"], [13, 25, "W"], [14, 25, "W"]])),
	],
	verifying: [pixelFrame(STANDING), pixelFrame(withPixels(LOWERED, [[8, 29, "G"]]))],
	success: [pixelFrame(withPixels(STANDING, [[3, 1, "N"], [4, 0, "N"], [1, 29, "G"]])), pixelFrame(withPixels(STANDING, [[2, 1, "N"], [3, 0, "N"], [1, 29, "G"]]))],
	failed: [pixelFrame(withPixels(LOWERED, [[3, 25, "S"], [1, 29, "R"]])), pixelFrame(withPixels(LOWERED, [[4, 25, "S"], [1, 29, "R"]]))],
};

const ACTIVITY_LABELS: Record<MascotActivity, string> = {
	idle: "Ready",
	planning: "Thinking…",
	searching: "Reading…",
	building: "Writing…",
	verifying: "Verifying…",
	success: "Done",
	failed: "Error",
};

const SEARCH_TOOL = /(search|find|read|inspect|grep|glob|list|scan|query)/i;
const BUILD_TOOL = /(write|edit|patch|exec|bash|shell|code|build|create|move|delete|notebook)/i;

export function mascotActivityForEvent(event: Pick<HarnessEvent, "type" | "data">): MascotActivity | undefined {
	if (event.type === "run.completed") return "success";
	if (event.type.endsWith("failed") || event.type.endsWith("denied") || event.type.endsWith("rejected")) return "failed";
	if (event.type === "verification.started") return "verifying";
	if (event.type === "verification.completed") return "planning";
	if (event.type === "tool.started") {
		const toolId = typeof event.data.toolId === "string" ? event.data.toolId : "";
		if (SEARCH_TOOL.test(toolId)) return "searching";
		if (BUILD_TOOL.test(toolId)) return "building";
		return "building";
	}
	if (event.type === "tool.completed" || event.type === "model.request.started") return "planning";
	if (event.type === "artifact.created" || event.type === "artifact.updated") return "building";
	if (
		event.type === "run.started"
		|| event.type === "task.compiled"
		|| event.type === "capabilities.resolved"
		|| event.type === "context.compiled"
		|| event.type.startsWith("model.")
		|| event.type.startsWith("cache.")
		|| event.type.startsWith("subagent.")
	) return "planning";
	return undefined;
}

export function renderPolarBear(activity: MascotActivity, frame = 0): string[] {
	return FRAMES[activity][frame % FRAMES[activity].length]!;
}

const fit = (text: string, width: number): string => {
	const clipped = truncateToWidth(text, Math.max(0, width), "…");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
};

const centerBlock = (lines: string[], width: number): string[] => {
	const blockWidth = Math.min(width, lines.reduce((maximum, line) => Math.max(maximum, visibleWidth(line)), 0));
	const left = " ".repeat(Math.max(0, Math.floor((width - blockWidth) / 2)));
	return lines.map((line) => fit(`${left}${fit(line, blockWidth)}`, width));
};

export class PolarBearWelcome implements Component {
	private activity: MascotActivity = "idle";
	private frame = 0;
	private timer?: NodeJS.Timeout;
	private model: string;
	private workspace: string;

	constructor(
		private readonly requestRender: () => void,
		context: { model: string; workspace: string },
	) {
		this.model = sanitizeTerminalText(context.model);
		this.workspace = sanitizeTerminalText(context.workspace);
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			this.frame = (this.frame + 1) % FRAMES[this.activity].length;
			this.requestRender();
		}, 420);
		this.timer.unref();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	setActivity(activity: MascotActivity): void {
		if (activity === this.activity) return;
		this.activity = activity;
		this.frame = 0;
		this.requestRender();
	}

	setContext(context: { model: string; workspace?: string }): void {
		this.model = sanitizeTerminalText(context.model);
		if (context.workspace) this.workspace = sanitizeTerminalText(context.workspace);
		this.requestRender();
	}

	invalidate(): void {}

	render(width: number): string[] {
		const safeWidth = Math.max(4, width);
		const topPrefix = "╭─ CODETONOMY ";
		const top = `${topPrefix}${"─".repeat(Math.max(0, safeWidth - visibleWidth(topPrefix) - 1))}╮`;
		const bottom = `╰${"─".repeat(Math.max(0, safeWidth - 2))}╯`;
		const frame = renderPolarBear(this.activity, this.frame);
		const result = [border(fit(top, safeWidth))];

		if (safeWidth >= 76) {
			const leftWidth = Math.min(34, Math.max(29, Math.floor((safeWidth - 3) * 0.42)));
			const rightWidth = safeWidth - leftWidth - 3;
			const left = [
				chalk.bold("Welcome back!"),
				...centerBlock(frame, leftWidth).map((line) => line.trimEnd()),
				chalk.dim(this.model),
				chalk.dim(this.workspace),
			];
			const rule = ice("─".repeat(rightWidth));
			const right = [
				chalk.bold(ice("Tips for getting started")),
				"Ask Codetonomy to inspect, explain, or build.",
				"Type / for commands, @ for files, $ for skills.",
				"",
				rule,
				chalk.bold(ice("Polar bear activity")),
				`${this.activity === "failed" ? chalk.red("●") : this.activity === "success" ? chalk.green("●") : ice("●")} ${ACTIVITY_LABELS[this.activity]}`,
			];
			const height = Math.max(left.length, right.length);
			for (let index = 0; index < height; index++) {
				result.push(`${border("│")}${fit(left[index] ?? "", leftWidth)}${border("│")}${fit(right[index] ?? "", rightWidth)}${border("│")}`);
			}
		} else {
			const contentWidth = safeWidth - 2;
			const lines = [
				chalk.bold("Welcome back!"),
				...centerBlock(frame, contentWidth).map((line) => line.trimEnd()),
				chalk.dim(this.model),
				chalk.dim(this.workspace),
				ice("─".repeat(contentWidth)),
				`${chalk.bold(ice("Polar bear"))} · ${ACTIVITY_LABELS[this.activity]}`,
				chalk.dim("/ commands · @ files · $ skills"),
			];
			for (const line of lines) result.push(`${border("│")}${fit(line, contentWidth)}${border("│")}`);
		}

		result.push(border(fit(bottom, safeWidth)));
		return result;
	}
}
