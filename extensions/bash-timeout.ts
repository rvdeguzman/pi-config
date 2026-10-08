import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Give model-issued bash calls a default timeout. Pi's bash tool has none, so a
 * test or server that never exits holds the session (or an unwatched subagent)
 * forever. An explicit `timeout` always wins. Pi kills the whole process tree on
 * timeout. User `!` commands are not tool calls and are unaffected.
 */
export const BASH_TIMEOUT_ENV = "PI_BASH_DEFAULT_TIMEOUT";
const DEFAULT_SECONDS = 600;

export function defaultTimeoutSeconds(raw = process.env[BASH_TIMEOUT_ENV]): number | undefined {
	if (raw === undefined || raw.trim() === "") return DEFAULT_SECONDS;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0) return DEFAULT_SECONDS;
	return value === 0 ? undefined : value; // 0 disables
}

export default function bashTimeout(pi: ExtensionAPI): void {
	const defaulted = new Set<string>();

	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash" || event.input.timeout !== undefined) return;
		const seconds = defaultTimeoutSeconds();
		if (seconds === undefined) return;
		event.input.timeout = seconds;
		defaulted.add(event.toolCallId);
	});

	pi.on("tool_result", (event) => {
		if (event.toolName !== "bash" || !defaulted.delete(event.toolCallId) || !event.isError) return;
		const text = event.content.map((part) => (part.type === "text" ? part.text : "")).join("");
		if (!/Command timed out after/.test(text)) return;
		return {
			content: [
				...event.content,
				{
					type: "text",
					text: `\n(Default ${event.input.timeout}s timeout applied because the call set none. If this command legitimately runs longer, pass a larger timeout or run it in the background and poll; if it should have finished, it is probably hanging.)`,
				},
			],
		};
	});
}
