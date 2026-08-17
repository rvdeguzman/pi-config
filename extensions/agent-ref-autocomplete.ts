import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const AGENTS_DIR = join(homedir(), ".pi", "agent", "agents");

function agentNames(): string[] {
	try {
		return readdirSync(AGENTS_DIR)
			.filter((f) => f.endsWith(".md"))
			.map((f) => f.slice(0, -3));
	} catch {
		return [];
	}
}

function provider(current: AutocompleteProvider): AutocompleteProvider {
	return {
		triggerCharacters: ["#"],
		getSuggestions(lines, cursorLine, cursorCol, options) {
			const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
			const match = before.match(/(?:^|[\s])#([a-zA-Z][\w-]*)?$/);
			if (!match) return current.getSuggestions(lines, cursorLine, cursorCol, options);

			const typed = (match[1] ?? "").toLowerCase();
			const items = agentNames()
				.filter((n) => n.toLowerCase().startsWith(typed))
				.map((n) => ({ value: n, label: `#${n}`, description: "subagent" }));
			if (items.length === 0) return current.getSuggestions(lines, cursorLine, cursorCol, options);

			return Promise.resolve({ prefix: `#${match[1] ?? ""}`, items });
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.addAutocompleteProvider(provider);
	});
}
