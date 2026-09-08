import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { redactAuditValue, type HarnessEvent, type HarnessEventType, type RunObserver } from "@agent-harness/contracts";

export class RunTrace {
	readonly runId: string;
	readonly path: string;
	readonly #observers: RunObserver[];
	readonly #knownSecrets: readonly string[];
	#sequence = 0;
	#write = Promise.resolve();

	constructor(runId: string, path: string, observers: RunObserver[] = [], knownSecrets: readonly string[] = []) {
		this.runId = runId;
		this.path = path;
		this.#observers = observers;
		this.#knownSecrets = knownSecrets;
	}

	async emit(type: HarnessEventType, data: Record<string, unknown> = {}, parentEventId?: string): Promise<HarnessEvent> {
		const event: HarnessEvent = {
			eventId: randomUUID(),
			runId: this.runId,
			parentEventId,
			sequence: ++this.#sequence,
			timestamp: new Date().toISOString(),
			type,
			data: redactAuditValue(data, "", this.#knownSecrets) as Record<string, unknown>,
		};
		if (type === "tool.failed") event.data.failureId = event.eventId;
		this.#write = this.#write.then(async () => {
			await mkdir(dirname(this.path), { recursive: true });
			const handle = await open(this.path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
			try {
				const info = await handle.stat();
				if (!info.isFile() || info.nlink !== 1) throw new Error("Trace path is not a regular standalone file");
				await handle.write(`${JSON.stringify(event)}\n`, undefined, "utf8");
				await chmod(this.path, 0o600);
			} finally {
				await handle.close();
			}
		});
		await this.#write;
		for (const observer of this.#observers) {
			try {
				await observer(event);
			} catch {
				// Observers are passive; trace persistence remains authoritative.
			}
		}
		return event;
	}
}
