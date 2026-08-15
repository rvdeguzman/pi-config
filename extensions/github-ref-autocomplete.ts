import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";

const REF_RE = /(?:^|[\s"'`(<=])(?:(pr|pull|issue)(\s+))?#([1-9]\d*)$/i;

function context(text: string) {
	const match = text.match(REF_RE);
	if (!match) return null;
	const qualifier = match[1]?.toLowerCase();
	return {
		prefix: match[0].slice(match[0].indexOf(qualifier ? match[1]! : "#")),
		kind: qualifier === "issue" ? "issue" : qualifier ? "pr" : null,
		number: match[3]!,
	};
}

function provider(current: AutocompleteProvider): AutocompleteProvider {
	return {
		triggerCharacters: ["#"],
		getSuggestions(lines, cursorLine, cursorCol, options) {
			const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
			const ref = context(before);
			if (!ref) return current.getSuggestions(lines, cursorLine, cursorCol, options);

			const kinds = ref.kind ? [ref.kind] : (["pr", "issue"] as const);
			return Promise.resolve({
				prefix: ref.prefix,
				items: kinds.map((kind) => ({
					value: `${kind}://${ref.number}`,
					label: `${kind === "pr" ? "PR" : "Issue"} #${ref.number}`,
					description: `GitHub ${kind === "pr" ? "pull request" : "issue"}`,
				})),
			});
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
