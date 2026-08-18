import assert from "node:assert/strict";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { QuestionnaireSession } from "../state/questionnaire-session.js";
import type { QuestionnaireState } from "../state/state.js";
import { sanitizeBlock, sanitizeLine } from "../tool/sanitize.js";
import type { QuestionData } from "../tool/types.js";
import { SubmitTabStrategy } from "../view/tab-content-strategy.js";
import type { WrappingSelectItem } from "../view/components/wrapping-select.js";

initTheme(undefined, false);

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

const questions: QuestionData[] = [
	{
		question: "Which deliberately long preview option should remain visible while the heading wraps?",
		header: "Preview",
		options: [
			{
				label: "First ZZZFOCUS option label",
				description: "A long description exercises fixed prefixes at narrow widths.",
				preview: "```text\n┌──────────────┐\n│ preview 🙂 │\n└──────────────┘\n```",
			},
			{ label: "Second", description: "Another choice." },
		],
	},
	{
		question: "Which narrow multi-select prefixes are safe?",
		header: "Multi",
		multiSelect: true,
		options: [
			{ label: "First multi-select option", description: "Long enough to wrap repeatedly." },
			{ label: "Second multi-select option", description: "Also long enough to wrap repeatedly." },
		],
	},
];

function itemsFor(question: QuestionData): WrappingSelectItem[] {
	return [
		...question.options.map((option) => ({
			kind: "option" as const,
			label: option.label,
			description: option.description,
		})),
		{ kind: "other", label: "Type something." },
		...(question.multiSelect ? [{ kind: "next" as const, label: "Next" }] : []),
	];
}

const terminal = { columns: 120, rows: 200 };
const session = new QuestionnaireSession({
	tui: { terminal, requestRender() {} } as never,
	theme,
	params: { questions },
	itemsByTab: questions.map(itemsFor),
	done() {},
	keybindings: { matches: () => false },
	editInput: async () => undefined,
	collapseKey: "ctrl+]",
});

function assertWidth(name: string, lines: string[], width: number): void {
	for (const [row, line] of lines.entries()) {
		assert.equal(/[\r\n]/.test(line), false, `${name} width ${width} row ${row} contains an embedded newline`);
		assert.ok(visibleWidth(line) <= width, `${name} width ${width} row ${row} is ${visibleWidth(line)} columns`);
	}
}

function applyState(patch: Partial<QuestionnaireState>): void {
	const internal = session as unknown as {
		state: QuestionnaireState;
		viewAdapter: { apply(state: QuestionnaireState): void };
	};
	internal.state = { ...internal.state, ...patch };
	internal.viewAdapter.apply(internal.state);
}

for (let width = 0; width <= 120; width++) {
	terminal.columns = width;
	applyState({ currentTab: 0, optionIndex: 0, collapsed: false });
	assertWidth("stacked preview dialog", session.component.render(width), width);

	applyState({ currentTab: 1, optionIndex: 0, collapsed: false });
	assertWidth("narrow multi-select dialog", session.component.render(width), width);

	applyState({ currentTab: questions.length, collapsed: false });
	assertWidth("submit dialog", session.component.render(width), width);

	applyState({ collapsed: true });
	assertWidth("collapsed hint", session.component.render(width), width);
}

// A wrapped heading must be measured in rendered rows so overflow scrolls to the focused body row.
terminal.columns = 12;
terminal.rows = 10;
applyState({ currentTab: 0, optionIndex: 0, collapsed: false });
const focusedViewport = session.component.render(12).map(stripTerminalSequences);
assert.ok(focusedViewport.some((line) => line.includes("ZZZ")), "wrapped heading displaced the focused option");

const emptyState: QuestionnaireState = {
	currentTab: questions.length,
	optionIndex: 0,
	inputMode: false,
	notesVisible: false,
	answers: new Map(),
	multiSelectChecked: new Set(),
	customDraftsByTab: new Map(),
	notesByTab: new Map(),
	submitChoiceIndex: 0,
	notesDraft: "",
	collapsed: false,
};
const submit = new SubmitTabStrategy({
	theme,
	questions,
	submitPicker: { render: () => ["Submit", "Cancel"], invalidate() {}, handleInput() {} },
});
for (let width = 0; width <= 120; width++) {
	const footerRows = submit.footerRows(emptyState).flatMap((component) => component.render(width));
	assert.equal(footerRows.length, submit.footerRowCount, `submit footer height changed at width ${width}`);
}

assert.equal(
	sanitizeLine(" \x1b[2J Héllo\r\n\tworld\x00 \u0085 \u2028🙂 "),
	"Héllo world 🙂",
);
assert.equal(sanitizeLine("a\vb\fc\x7fd\x9fe"), "a b cde");
assert.equal(
	sanitizeBlock("# Héllo\r\n\t- one\x00\rnext\x1b[2J 🙂\n\n```ts\nconst x = 1;\n```"),
	"# Héllo\n - one\nnext 🙂\n\n```ts\nconst x = 1;\n```",
);
assert.equal(/[\x00-\x09\x0b-\x1f\x7f-\x9f\r]/.test(sanitizeBlock("ok\n")), false);

console.log("check: width fuzz and sanitizer assertions passed");
