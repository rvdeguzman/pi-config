import type { AutocompleteProvider } from "@earendil-works/pi-tui";

import type { ProfileRegistry } from "./subagent-profiles.ts";

export function createAgentRefAutocomplete(
	current: AutocompleteProvider,
	registry: ProfileRegistry,
): AutocompleteProvider {
	return {
		triggerCharacters: ["&"],
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
			const match = beforeCursor.match(/(?:^|\s)&([^\s&]*)$/);
			if (!match) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			const prefix = match[1] ?? "";
			const matches = (await registry.list()).filter((profile) =>
				profile.name.toLowerCase().startsWith(prefix.toLowerCase()),
			);
			if (matches.length === 0) return current.getSuggestions(lines, cursorLine, cursorCol, options);
			return {
				prefix: `&${prefix}`,
				items: matches.map((profile) => ({
					value: `&${profile.name}`,
					label: `&${profile.name}`,
				})),
			};
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			if (!prefix.startsWith("&")) return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			const currentLine = lines[cursorLine] ?? "";
			const before = currentLine.slice(0, cursorCol - prefix.length);
			const after = currentLine.slice(cursorCol).replace(/^\s+/, "");
			const insertion = `${item.value} `;
			const next = [...lines];
			next[cursorLine] = before + insertion + after;
			return {
				lines: next,
				cursorLine,
				cursorCol: before.length + insertion.length,
			};
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}
