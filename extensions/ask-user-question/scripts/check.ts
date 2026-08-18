import assert from "node:assert/strict";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_COLLAPSE_KEY,
	DEFAULT_TICKER_KEY,
	resolveCollapseKey,
	resolveOverflow,
	resolveTickerKey,
} from "../config.js";
import { QuestionnaireSession } from "../state/questionnaire-session.js";
import type { QuestionnaireState } from "../state/state.js";
import { sanitizeBlock, sanitizeLine } from "../tool/sanitize.js";
import type { QuestionData } from "../tool/types.js";
import { MultiSelectView, TICKER_SEPARATOR, tickerSlice } from "../view/components/multi-select-view.js";
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
			{
				label: "First multi-select option with a deliberately long 日本語 label",
				description: "Long enough to wrap repeatedly.",
			},
			{ label: "Second", description: "Also long enough to wrap repeatedly." },
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
	overflow: "expand",
	tickerKey: "t",
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

	applyState({ currentTab: 1, optionIndex: 0, collapsed: false, overflowMode: "expand" });
	assertWidth("expanded multi-select dialog", session.component.render(width), width);

	applyState({ overflowMode: "ticker", tickerOffset: width + 7 });
	assertWidth("ticker multi-select dialog", session.component.render(width), width);

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
	overflowMode: "expand",
	tickerOffset: 0,
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
assert.equal(sanitizeLine("up\x1b[2Athere\x1b]0;title\x07!"), "upthere!", "non-SGR CSI must not leak as text");
assert.equal(
	sanitizeBlock("# Héllo\r\n\t- one\x00\rnext\x1b[2J 🙂\n\n```ts\nconst x = 1;\n```"),
	"# Héllo\n - one\nnext 🙂\n\n```ts\nconst x = 1;\n```",
);
assert.equal(/[\x00-\x09\x0b-\x1f\x7f-\x9f\r]/.test(sanitizeBlock("ok\n")), false);

// Ticker frames: every frame fills the window, stays within it, and the loop returns home.
const longLabel = "First multi-select option with a deliberately long 日本語 label";
const tickerWidth = 20;
const period = visibleWidth(`${longLabel}${TICKER_SEPARATOR}`);
for (let offset = 0; offset < period; offset++) {
	const frame = tickerSlice(longLabel, tickerWidth, offset);
	assert.ok(visibleWidth(frame) <= tickerWidth, `ticker frame ${offset} overflows its window`);
	assert.ok(visibleWidth(frame) >= tickerWidth - 1, `ticker frame ${offset} underfills its window`);
}
assert.equal(tickerSlice(longLabel, tickerWidth, period), tickerSlice(longLabel, tickerWidth, 0));
assert.notEqual(tickerSlice(longLabel, tickerWidth, 1), tickerSlice(longLabel, tickerWidth, 0));
assert.equal(tickerSlice("short", tickerWidth, 3), "short", "a fitting label must not scroll");

// Height stability: the reserved worst case covers every focus position and never shrinks below it.
const multi = new MultiSelectView(theme, questions[1]!);
const rowCount = questions[1]!.options.length;
for (let width = 20; width <= 60; width++) {
	const reserved: number[] = [];
	for (let focus = 0; focus < rowCount; focus++) {
		multi.setProps({
			rows: questions[1]!.options.map((_, i) => ({ checked: false, active: i === focus })),
			other: { active: false, inputMode: false, inputBuffer: "", inputCursorOffset: undefined },
			nextActive: false,
			nextLabel: "Next",
			overflowMode: "expand",
			tickerOffset: 0,
		});
		assert.equal(multi.naturalHeight(width), multi.render(width).length, `height parity broke at width ${width}`);
		assert.ok(
			multi.naturalHeight(width) <= multi.maxNaturalHeight(width),
			`focus ${focus} exceeds the reserved height at width ${width}`,
		);
		reserved.push(multi.maxNaturalHeight(width));
	}
	assert.equal(new Set(reserved).size, 1, `reserved height moved with focus at width ${width}`);
}

// Malformed config values fall back instead of throwing out of the tool call.
assert.equal(resolveCollapseKey({ collapseKey: 5 as never }), DEFAULT_COLLAPSE_KEY);
assert.equal(resolveTickerKey({ tickerKey: { nope: true } as never }), DEFAULT_TICKER_KEY);
assert.equal(resolveTickerKey({ tickerKey: "ctr+]" }), DEFAULT_TICKER_KEY, "typo'd modifier must not bind");
assert.equal(resolveTickerKey({ tickerKey: " OFF " }), "off");
assert.equal(resolveTickerKey({ tickerKey: "alt+o" }), "alt+o");
assert.equal(resolveOverflow({ overflow: "ticker" }), "ticker");
assert.equal(resolveOverflow({ overflow: "nope" as never }), "expand");
assert.equal(resolveOverflow({}), "expand");

console.log("check: width fuzz, ticker, height, config and sanitizer assertions passed");
