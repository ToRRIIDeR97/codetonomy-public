import { redactAuditString } from "@agent-harness/contracts";

export function sanitizeTerminalText(value: string): string {
	return redactAuditString(value).replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, (character) => {
		return `\\u{${character.codePointAt(0)?.toString(16).padStart(2, "0")}}`;
	});
}
