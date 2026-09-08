import type { HarnessEvent } from "@agent-harness/contracts";

export interface RepairMetrics {
	attribution: "causal-v1" | "unknown";
	eligible: number;
	resolved: number;
	unresolved: number;
	superseded: number;
	verifiedAfterRepair: boolean;
	providerAttempts: number;
}

// Historical traces remain readable; qualification explicitly opts into strict validation.
export function repairMetrics(events: HarnessEvent[], strict = false): RepairMetrics {
	const ids = new Map<string, HarnessEvent>();
	let previous = 0;
	let valid = true;
	for (const event of events) {
		if (!event.eventId || ids.has(event.eventId) || !Number.isSafeInteger(event.sequence) || event.sequence <= previous
			|| !Number.isFinite(Date.parse(event.timestamp)) || (event.parentEventId && !ids.has(event.parentEventId))) valid = false;
		ids.set(event.eventId, event);
		previous = event.sequence;
	}
	const failures = events.filter(({ type, data }) => type === "tool.failed" && typeof data.operationFingerprint === "string");
	const resolved = new Set<string>();
	const superseded = new Set<string>();
	for (const event of events.filter(({ type }) => type === "tool.failure.resolved" || type === "tool.failure.superseded")) {
		const failure = ids.get(String(event.data.failureId));
		const correction = ids.get(String(event.data.correctingEventId));
		const relationValid = failure?.type === "tool.failed" && failure.sequence < event.sequence && event.parentEventId === failure.eventId
			&& failure.data.toolCallId === event.data.originatingCallId
			&& (event.type === "tool.failure.superseded" || correction?.type === "tool.completed" && correction.sequence > failure.sequence && correction.sequence < event.sequence && correction.data.toolCallId === event.data.correctingCallId);
		if (!relationValid || resolved.has(String(event.data.failureId)) || superseded.has(String(event.data.failureId))) { valid = false; continue; }
		(event.type === "tool.failure.resolved" ? resolved : superseded).add(failure.eventId);
	}
	if (strict && !valid) throw new Error("Invalid causal trace relationships");
	const known = valid && events.some(({ type, data }) => type === "run.started" && data.repairSchemaVersion === 1);
	const terminal = events.at(-1);
	const verified = terminal?.type === "run.completed" && terminal.data.verified === true;
	return {
		attribution: known ? "causal-v1" : "unknown",
		eligible: known ? failures.length : 0,
		resolved: known ? failures.filter(({ eventId }) => resolved.has(eventId)).length : 0,
		unresolved: known ? failures.filter(({ eventId }) => !resolved.has(eventId) && !superseded.has(eventId)).length : 0,
		superseded: known ? failures.filter(({ eventId }) => superseded.has(eventId)).length : 0,
		verifiedAfterRepair: known && verified && resolved.size > 0 && failures.every(({ eventId }) => resolved.has(eventId) || superseded.has(eventId)),
		providerAttempts: events.filter(({ type }) => type === "provider.attempt.started").length,
	};
}
