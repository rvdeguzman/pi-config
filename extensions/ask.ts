/**
 * ask - Structured clarifying questions with a tabbed picker.
 *
 * Ported from oh-my-pi's `ask` tool (packages/coding-agent/src/tools/ask.ts +
 * src/modes/components/ask-dialog.ts), adapted to pi's extension API.
 *
 * Features
 * - One dialog, one tab per question, plus a Submit tab that reviews everything
 * - Radio rows for single-select, checkbox rows for `multi: true`
 * - `n` attaches a free-text note to the highlighted option (with omp's
 *   invalidation rules: the note dies if you move the answer off that row)
 * - `recommended` index gets a " (Recommended)" suffix and starts under the cursor
 * - "Other (type your own)" free-text row, always appended automatically
 * - "Chat about this" escape hatch: returns chatRedirect instead of an answer
 * - Optional timeout auto-selects the recommended option (live countdown)
 * - Terminal notification while blocked
 * - executionMode "sequential" so two asks never fight over the UI
 *
 * Settings (global ~/.pi/agent/settings.json, overridable by <cwd>/.pi/settings.json):
 *   { "ask": { "timeout": 0, "notify": "on" } }
 * `timeout` is in SECONDS; 0 disables. `notify` is "on" | "off".
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OTHER_LABEL = "Other (type your own)";
const CHAT_LABEL = "Chat about this";
const SUBMIT_LABEL = "Submit";
const RECOMMENDED_SUFFIX = " (Recommended)";

/** Labels the runtime owns. The model must not define these itself. */
const RESERVED_LABELS = new Set([OTHER_LABEL, CHAT_LABEL, SUBMIT_LABEL]);

const MAX_TAB_CHIP_WIDTH = 16;
/** Cap wrapped question-header lines so a long question can't push the list off-screen. */
const MAX_QUESTION_ROWS = 4;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const AskOptionSchema = Type.Object({
	label: Type.String({ description: "Short display label. Keep it terse." }),
	description: Type.Optional(
		Type.String({
			description: "One-line explanation shown under the label. Put tradeoffs here, not in the label.",
		}),
	),
});

const AskQuestionSchema = Type.Object({
	id: Type.String({ description: "Stable identifier, used as the key in multi-question results." }),
	question: Type.String({ description: "The question text." }),
	header: Type.Optional(
		Type.String({ description: "Short tab chip label, e.g. 'Scope' or 'Storage'. Defaults to id." }),
	),
	options: Type.Array(AskOptionSchema, {
		description:
			"Answer options. 2-5 concise, distinct choices. Never include an 'Other' option - the UI appends one automatically.",
	}),
	multi: Type.Optional(Type.Boolean({ description: "Allow multiple selections (checkboxes). Default false." })),
	recommended: Type.Optional(
		Type.Number({ description: "Zero-based index of the recommended option. ' (Recommended)' is added for you." }),
	),
});

const AskParams = Type.Object({
	questions: Type.Array(AskQuestionSchema, {
		description: "One or more questions. Ask everything you need in a single call rather than several calls.",
	}),
});

type AskQuestion = Static<typeof AskQuestionSchema>;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

interface QuestionResult {
	id: string;
	question: string;
	options: string[];
	multi: boolean;
	selectedOptions: string[];
	customInput?: string;
	note?: string;
	timedOut?: boolean;
}

interface AskDetails {
	/** Single-question mode: flattened fields. */
	question?: string;
	options?: string[];
	multi?: boolean;
	selectedOptions?: string[];
	customInput?: string;
	note?: string;
	timedOut?: boolean;
	/** Multi-question mode. */
	results?: QuestionResult[];
	/** User chose "Chat about this" instead of answering. */
	chatRedirect?: boolean;
	questions?: string[];
}

type DialogOutcome =
	| { kind: "submit"; results: QuestionResult[] }
	| { kind: "chat" }
	| { kind: "cancel" };

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

interface AskSettings {
	/** Seconds. 0 disables. */
	timeout: number;
	notify: boolean;
}

function readJson(path: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function readAskSettings(cwd: string): AskSettings {
	const result: AskSettings = { timeout: 0, notify: true };
	const sources = [join(getAgentDir(), "settings.json"), join(cwd, CONFIG_DIR_NAME, "settings.json")];
	for (const source of sources) {
		const block = readJson(source)?.ask;
		if (!block || typeof block !== "object") continue;
		const ask = block as Record<string, unknown>;
		if (typeof ask.timeout === "number" && Number.isFinite(ask.timeout) && ask.timeout >= 0) {
			result.timeout = ask.timeout;
		}
		if (ask.notify === "off" || ask.notify === false) result.notify = false;
		if (ask.notify === "on" || ask.notify === true) result.notify = true;
	}
	return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripRecommended(label: string): string {
	return label.endsWith(RECOMMENDED_SUFFIX) ? label.slice(0, -RECOMMENDED_SUFFIX.length) : label;
}

function flatten(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function chipLabel(question: AskQuestion, index: number): string {
	const base = question.header?.trim() || question.id?.trim() || `Q${index + 1}`;
	return truncateToWidth(flatten(base), MAX_TAB_CHIP_WIDTH, "…");
}

function validRecommended(question: AskQuestion): number | undefined {
	const index = question.recommended;
	if (typeof index !== "number" || !Number.isInteger(index)) return undefined;
	return index >= 0 && index < question.options.length ? index : undefined;
}

/** Rows shown for a question: its options, then Other, then Chat about this. */
type RowKind = "option" | "other" | "chat";
interface Row {
	kind: RowKind;
	/** Stable key used to bind notes to a row. */
	key: string;
	label: string;
	description?: string;
	optionIndex?: number;
}

function buildRows(question: AskQuestion): Row[] {
	const recommended = validRecommended(question);
	const rows: Row[] = question.options.map((option, index) => ({
		kind: "option",
		key: `option:${index}`,
		label: index === recommended && !question.multi ? `${option.label}${RECOMMENDED_SUFFIX}` : option.label,
		description: option.description?.trim() || undefined,
		optionIndex: index,
	}));
	rows.push({ kind: "other", key: "other", label: OTHER_LABEL });
	rows.push({ kind: "chat", key: "chat", label: CHAT_LABEL });
	return rows;
}

// ---------------------------------------------------------------------------
// Per-question mutable state
// ---------------------------------------------------------------------------

interface QuestionState {
	selected: Set<string>;
	customInput?: string;
	note?: string;
	/** Which row the note is bound to. */
	noteRowKey?: string;
	cursor: number;
	timedOut: boolean;
}

function clearNote(state: QuestionState): void {
	state.note = undefined;
	state.noteRowKey = undefined;
}

/** Drop the note when the row it belongs to stops being the answer. */
function clearNoteIfRow(state: QuestionState, rowKey: string): void {
	if (state.noteRowKey === rowKey) clearNote(state);
}

/** Drop the note when a different row becomes the answer. */
function clearNoteUnlessRow(state: QuestionState, rowKey: string): void {
	if (state.noteRowKey !== undefined && state.noteRowKey !== rowKey) clearNote(state);
}

/** A note only survives if the row it is bound to actually ended up selected. */
function noteForAnswer(question: AskQuestion, rows: Row[], state: QuestionState): string | undefined {
	if (state.note === undefined || state.noteRowKey === undefined) return undefined;
	if (state.noteRowKey === "other") return state.customInput !== undefined ? state.note : undefined;
	const match = /^option:(\d+)$/.exec(state.noteRowKey);
	if (!match) return undefined;
	const row = rows.find((candidate) => candidate.key === state.noteRowKey);
	return row && state.selected.has(row.label) ? state.note : undefined;
}

function isAnswered(state: QuestionState): boolean {
	return state.selected.size > 0 || state.customInput !== undefined;
}

function toResult(question: AskQuestion, rows: Row[], state: QuestionState): QuestionResult {
	const result: QuestionResult = {
		id: question.id,
		question: question.question,
		options: question.options.map((option) => option.label),
		multi: question.multi === true,
		selectedOptions: Array.from(state.selected, stripRecommended),
	};
	if (state.customInput !== undefined) result.customInput = state.customInput;
	const note = noteForAnswer(question, rows, state);
	if (note?.trim()) result.note = note.trim();
	if (state.timedOut) result.timedOut = true;
	return result;
}

// ---------------------------------------------------------------------------
// Rich tabbed dialog (TUI mode)
// ---------------------------------------------------------------------------

function runRichDialog(
	ctx: ExtensionContext,
	questions: AskQuestion[],
	timeoutMs: number | undefined,
	signal: AbortSignal | undefined,
): Promise<DialogOutcome> {
	const rowsByQuestion = questions.map(buildRows);
	const chips = questions.map(chipLabel);

	// A single non-multi question submits straight from the option list; anything
	// else confirms on the Submit tab so toggles are never mistaken for confirms.
	const hasSubmitTab = questions.length > 1 || questions.some((q) => q.multi === true);
	const submitTabIndex = questions.length;
	const totalTabs = questions.length + (hasSubmitTab ? 1 : 0);

	return ctx.ui.custom<DialogOutcome>((tui, theme, _keybindings, done) => {
		const states: QuestionState[] = questions.map((question) => ({
			selected: new Set<string>(),
			cursor: validRecommended(question) ?? 0,
			timedOut: false,
		}));

		let activeTab = 0;
		let submitCursor = 0;
		let editMode: { kind: "other" | "note"; rowKey: string; label: string } | undefined;
		let cachedLines: string[] | undefined;
		let settled = false;
		let deadline: number | undefined = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
		let timeoutId: NodeJS.Timeout | undefined;
		let tickId: NodeJS.Timeout | undefined;

		const editorTheme: EditorTheme = {
			borderColor: (s) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
		};
		const editor = new Editor(tui, editorTheme);

		function refresh(): void {
			cachedLines = undefined;
			tui.requestRender();
		}

		function finish(outcome: DialogOutcome): void {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutId);
			clearInterval(tickId);
			signal?.removeEventListener("abort", onAbort);
			done(outcome);
		}

		function onAbort(): void {
			finish({ kind: "cancel" });
		}

		function collect(): QuestionResult[] {
			return questions.map((question, index) => toResult(question, rowsByQuestion[index], states[index]));
		}

		/** Timeout fired: auto-select the recommended (else first) option per unanswered question. */
		function onTimeout(): void {
			for (let index = 0; index < questions.length; index++) {
				const state = states[index];
				if (isAnswered(state)) continue;
				const question = questions[index];
				const rows = rowsByQuestion[index];
				const fallback = rows[validRecommended(question) ?? 0];
				if (fallback?.kind === "option") state.selected.add(fallback.label);
				state.timedOut = true;
			}
			finish({ kind: "submit", results: collect() });
		}

		if (timeoutMs !== undefined) {
			timeoutId = setTimeout(onTimeout, timeoutMs);
			// Repaint once a second so the countdown in the footer stays honest.
			tickId = setInterval(refresh, 1000);
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) queueMicrotask(onAbort);

		/** Any interaction cancels the timeout: the user is clearly present. */
		function cancelTimeout(): void {
			if (timeoutId === undefined) return;
			clearTimeout(timeoutId);
			clearInterval(tickId);
			timeoutId = undefined;
			tickId = undefined;
			deadline = undefined;
		}

		function allAnswered(): boolean {
			return states.every(isAnswered);
		}

		function activeRows(): Row[] {
			return rowsByQuestion[activeTab] ?? [];
		}

		function openEditor(kind: "other" | "note", row: Row): void {
			const state = states[activeTab];
			editMode = { kind, rowKey: row.key, label: stripRecommended(row.label) };
			editor.setText(
				kind === "note" ? (state.noteRowKey === row.key ? (state.note ?? "") : "") : (state.customInput ?? ""),
			);
			refresh();
		}

		editor.onSubmit = (value) => {
			if (!editMode) return;
			const state = states[activeTab];
			const question = questions[activeTab];
			const trimmed = value.trim();
			const mode = editMode;
			editMode = undefined;
			editor.setText("");

			if (mode.kind === "note") {
				if (trimmed) {
					state.note = trimmed;
					state.noteRowKey = mode.rowKey;
				} else {
					clearNoteIfRow(state, mode.rowKey);
				}
				refresh();
				return;
			}

			// "Other": empty submission clears the custom answer instead of storing "".
			if (!trimmed) {
				state.customInput = undefined;
				clearNoteIfRow(state, "other");
				refresh();
				return;
			}
			state.customInput = trimmed;
			if (!question.multi) state.selected.clear();
			clearNoteUnlessRow(state, "other");
			if (!hasSubmitTab) {
				finish({ kind: "submit", results: collect() });
				return;
			}
			advanceTab();
		};

		function advanceTab(): void {
			if (activeTab < questions.length - 1) activeTab++;
			else if (hasSubmitTab) activeTab = submitTabIndex;
			submitCursor = 0;
			refresh();
		}

		function toggleRow(row: Row): void {
			const state = states[activeTab];
			const question = questions[activeTab];

			if (row.kind === "chat") {
				finish({ kind: "chat" });
				return;
			}
			if (row.kind === "other") {
				openEditor("other", row);
				return;
			}

			if (question.multi) {
				if (state.selected.has(row.label)) {
					state.selected.delete(row.label);
					clearNoteIfRow(state, row.key);
				} else {
					state.selected.add(row.label);
					clearNoteUnlessRow(state, row.key);
				}
				refresh();
				return;
			}

			// Single-select: replace the selection outright.
			state.selected.clear();
			state.selected.add(row.label);
			state.customInput = undefined;
			clearNoteUnlessRow(state, row.key);
			if (!hasSubmitTab) {
				finish({ kind: "submit", results: collect() });
				return;
			}
			advanceTab();
		}

		function handleInput(data: string): void {
			// --- inline editor (Other / note) owns all input while open ---
			if (editMode) {
				if (matchesKey(data, Key.escape)) {
					editMode = undefined;
					editor.setText("");
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			cancelTimeout();

			// --- tab switching ---
			if (totalTabs > 1) {
				if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
					activeTab = (activeTab + 1) % totalTabs;
					refresh();
					return;
				}
				if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
					activeTab = (activeTab - 1 + totalTabs) % totalTabs;
					refresh();
					return;
				}
			}

			if (matchesKey(data, Key.escape)) {
				finish({ kind: "cancel" });
				return;
			}

			// --- Submit tab ---
			if (hasSubmitTab && activeTab === submitTabIndex) {
				if (matchesKey(data, Key.up)) {
					submitCursor = Math.max(0, submitCursor - 1);
					refresh();
					return;
				}
				if (matchesKey(data, Key.down)) {
					submitCursor = Math.min(questions.length - 1, submitCursor + 1);
					refresh();
					return;
				}
				if (matchesKey(data, Key.enter) && allAnswered()) {
					finish({ kind: "submit", results: collect() });
				}
				return;
			}

			// --- question tab ---
			const rows = activeRows();
			const state = states[activeTab];

			if (matchesKey(data, Key.up)) {
				state.cursor = (state.cursor - 1 + rows.length) % rows.length;
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				state.cursor = (state.cursor + 1) % rows.length;
				refresh();
				return;
			}

			const row = rows[state.cursor];
			if (!row) return;

			// `n` attaches a note to the highlighted row.
			if (data === "n" && row.kind !== "chat") {
				openEditor("note", row);
				return;
			}

			if (matchesKey(data, Key.enter) || (questions[activeTab].multi && matchesKey(data, Key.space))) {
				toggleRow(row);
				return;
			}

			// Number keys jump to and pick an option directly.
			if (data.length === 1 && data >= "1" && data <= "9") {
				const index = Number(data) - 1;
				const target = rows[index];
				if (target && target.kind === "option") {
					state.cursor = index;
					toggleRow(target);
				}
			}
		}

		// -------------------------------------------------------------------
		// Rendering
		// -------------------------------------------------------------------

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;

			const w = Math.max(20, width);
			const lines: string[] = [];

			const push = (text: string) => lines.push(...wrapTextWithAnsi(text, w));
			const pushIndented = (prefix: string, text: string) => {
				const prefixWidth = visibleWidth(prefix);
				if (prefixWidth >= w) {
					push(prefix + text);
					return;
				}
				const wrapped = wrapTextWithAnsi(text, w - prefixWidth);
				const cont = " ".repeat(prefixWidth);
				wrapped.forEach((line, i) => lines.push(`${i === 0 ? prefix : cont}${line}`));
			};

			lines.push(theme.fg("borderAccent", "─".repeat(w)));

			// --- tab bar ---
			if (totalTabs > 1) {
				const parts: string[] = [];
				for (let i = 0; i < questions.length; i++) {
					const answered = isAnswered(states[i]);
					const text = ` ${answered ? "■" : "□"} ${chips[i]} `;
					parts.push(
						i === activeTab
							? theme.bg("selectedBg", theme.fg("text", text))
							: theme.fg(answered ? "success" : "muted", text),
					);
				}
				if (hasSubmitTab) {
					const text = ` ✓ ${SUBMIT_LABEL} `;
					parts.push(
						activeTab === submitTabIndex
							? theme.bg("selectedBg", theme.fg("text", text))
							: theme.fg(allAnswered() ? "success" : "dim", text),
					);
				}
				pushIndented(" ", parts.join(" "));
				lines.push("");
			}

			if (hasSubmitTab && activeTab === submitTabIndex) {
				renderSubmitBody(pushIndented, w);
			} else {
				renderQuestionBody(pushIndented, w);
			}

			lines.push("");
			pushIndented(" ", theme.fg("dim", footerHint()));
			lines.push(theme.fg("borderAccent", "─".repeat(w)));

			cachedLines = lines;
			return lines;

			// ----- bodies -----

			function renderQuestionBody(add: (prefix: string, text: string) => void, innerWidth: number): void {
				const question = questions[activeTab];
				const state = states[activeTab];
				const rows = activeRows();

				const wrapped = wrapTextWithAnsi(flatten(question.question), Math.max(10, innerWidth - 2));
				for (const line of wrapped.slice(0, MAX_QUESTION_ROWS)) {
					add(" ", theme.fg("text", theme.bold(line)));
				}
				lines.push("");

				for (let i = 0; i < rows.length; i++) {
					const row = rows[i];
					const onCursor = i === state.cursor;
					const selected =
						row.kind === "option"
							? state.selected.has(row.label)
							: row.kind === "other"
								? state.customInput !== undefined
								: false;

					const cursor = onCursor ? theme.fg("accent", "❯ ") : "  ";
					const marker = rowMarker(row, question.multi === true, selected);
					const color = onCursor ? "accent" : row.kind === "option" ? "text" : "muted";
					const noted = state.note !== undefined && state.noteRowKey === row.key;
					const suffix = noted ? theme.fg("success", "  ✎ note") : "";

					add(cursor, `${marker}${theme.fg(color, row.label)}${suffix}`);

					if (row.kind === "other" && state.customInput !== undefined) {
						add("      ", theme.fg("accent", truncateToWidth(state.customInput, innerWidth - 8, "…")));
					}
					if (row.description) {
						add("      ", theme.fg("muted", row.description));
					}
				}

				if (editMode) {
					lines.push("");
					const title = editMode.kind === "note" ? `Note for ${editMode.label}:` : "Your answer:";
					add(" ", theme.fg("muted", truncateToWidth(title, innerWidth - 2, "…")));
					for (const line of editor.render(Math.max(1, innerWidth - 2))) lines.push(` ${line}`);
				}
			}

			function renderSubmitBody(add: (prefix: string, text: string) => void, innerWidth: number): void {
				add(" ", theme.fg("accent", theme.bold("Review answers")));
				lines.push("");
				for (let i = 0; i < questions.length; i++) {
					const question = questions[i];
					const state = states[i];
					const rows = rowsByQuestion[i];
					const cursor = i === submitCursor ? theme.fg("accent", "❯ ") : "  ";
					const label = theme.fg("muted", `${chips[i]}: `);

					const picked = Array.from(state.selected, stripRecommended);
					if (state.customInput !== undefined) picked.push(`(wrote) ${state.customInput}`);
					const answer = picked.length > 0 ? picked.join(", ") : theme.fg("warning", "unanswered");
					add(cursor, `${label}${theme.fg("text", truncateToWidth(answer, Math.max(8, innerWidth - 12), "…"))}`);

					const note = noteForAnswer(question, rows, state);
					if (note?.trim()) {
						add("     ", theme.fg("muted", `Note: ${truncateToWidth(flatten(note), innerWidth - 12, "…")}`));
					}
				}
				lines.push("");
				if (allAnswered()) {
					add(" ", theme.fg("success", "Enter to submit"));
				} else {
					const missing = questions
						.filter((_, i) => !isAnswered(states[i]))
						.map((_, i) => chips[i])
						.join(", ");
					add(" ", theme.fg("warning", `Unanswered: ${missing}`));
				}
			}

			function footerHint(): string {
				if (editMode) return "Enter save · Esc back";
				if (hasSubmitTab && activeTab === submitTabIndex) {
					return `↑↓ review · Enter submit · Tab/←→ tabs · Esc cancel${countdown()}`;
				}
				const pick = questions[activeTab]?.multi ? "Space/Enter toggle" : "Enter select";
				const tabs = totalTabs > 1 ? " · Tab/←→ tabs" : "";
				return `↑↓ move · ${pick} · n note${tabs} · Esc cancel${countdown()}`;
			}

			function countdown(): string {
				if (deadline === undefined) return "";
				const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
				return ` · auto in ${remaining}s`;
			}
		}

		function rowMarker(row: Row, multi: boolean, selected: boolean): string {
			if (row.kind === "chat") return theme.fg("dim", "  ");
			if (row.kind === "other") return selected ? theme.fg("success", "✎ ") : theme.fg("muted", "✎ ");
			if (multi) return selected ? theme.fg("success", "[x] ") : theme.fg("dim", "[ ] ");
			return selected ? theme.fg("success", "(•) ") : theme.fg("dim", "( ) ");
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
			dispose: () => {
				clearTimeout(timeoutId);
				clearInterval(tickId);
				signal?.removeEventListener("abort", onAbort);
			},
		};
	});
}

// ---------------------------------------------------------------------------
// Fallback dialog (RPC mode: ui.custom() is unavailable, dialogs are not)
// ---------------------------------------------------------------------------

async function runFallbackDialog(
	ctx: ExtensionContext,
	questions: AskQuestion[],
	signal: AbortSignal | undefined,
): Promise<DialogOutcome> {
	const results: QuestionResult[] = [];

	for (const question of questions) {
		const rows = buildRows(question);
		const state: QuestionState = { selected: new Set(), cursor: 0, timedOut: false };
		const opts = signal ? { signal } : undefined;

		if (question.multi) {
			// Loop until the user picks the Done sentinel.
			const DONE = "Done selecting";
			while (true) {
				const labels = rows.map((row) => {
					if (row.kind !== "option") return row.label;
					return `${state.selected.has(row.label) ? "[x] " : "[ ] "}${row.label}`;
				});
				if (state.selected.size > 0) labels.push(DONE);
				const choice = await ctx.ui.select(question.question, labels, opts);
				if (choice === undefined) return { kind: "cancel" };
				if (choice === DONE) break;
				if (choice === CHAT_LABEL) return { kind: "chat" };
				if (choice === OTHER_LABEL) {
					const input = await ctx.ui.editor(question.question);
					if (input?.trim()) state.customInput = input.trim();
					continue;
				}
				const label = choice.replace(/^\[[ x]\] /, "");
				if (state.selected.has(label)) state.selected.delete(label);
				else state.selected.add(label);
			}
		} else {
			const choice = await ctx.ui.select(
				question.question,
				rows.map((row) => row.label),
				opts,
			);
			if (choice === undefined) return { kind: "cancel" };
			if (choice === CHAT_LABEL) return { kind: "chat" };
			if (choice === OTHER_LABEL) {
				const input = await ctx.ui.editor(question.question);
				if (input === undefined) return { kind: "cancel" };
				state.customInput = input.trim() || "(no response)";
			} else {
				state.selected.add(choice);
			}
		}

		results.push(toResult(question, rows, state));
	}

	return { kind: "submit", results };
}

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

function describeAnswer(result: QuestionResult): string {
	const parts: string[] = [];
	if (result.selectedOptions.length > 0) parts.push(result.selectedOptions.join(", "));
	if (result.customInput !== undefined) parts.push(`custom: ${result.customInput}`);
	let text = parts.length > 0 ? parts.join(" | ") : "(no answer)";
	if (result.note) text += ` — note: ${result.note}`;
	if (result.timedOut) text += " (auto-selected after timeout)";
	return text;
}

function formatSubmitText(results: QuestionResult[]): string {
	if (results.length === 1) {
		const only = results[0];
		const lines: string[] = [];
		if (only.selectedOptions.length > 0) lines.push(`User selected: ${only.selectedOptions.join(", ")}`);
		if (only.customInput !== undefined) lines.push(`User provided custom input: ${only.customInput}`);
		if (lines.length === 0) lines.push("User did not select anything.");
		if (only.note) lines.push(`Note on that answer: ${only.note}`);
		if (only.timedOut) lines.push("(auto-selected after timeout — confirm before relying on it)");
		return lines.join("\n");
	}
	return ["User answers:", ...results.map((r) => `- ${r.id}: ${describeAnswer(r)}`)].join("\n");
}

// ---------------------------------------------------------------------------
// Prompt text
// ---------------------------------------------------------------------------

const TOOL_DESCRIPTION = [
	"Ask the user one or more structured clarifying questions and wait for their answer.",
	"Each question renders as an option picker: radio rows by default, checkboxes with multi: true.",
	'A free-form "Other (type your own)" row and a "Chat about this" escape hatch are appended automatically.',
	"The user can attach a free-text note to their chosen option, so read `note` on the result when present.",
].join(" ");

const PROMPT_GUIDELINES = [
	"Default to action: resolve ambiguity yourself from repo conventions, existing patterns, configs, docs, and history before calling ask.",
	"Use ask only when the options have materially different tradeoffs the user must decide; if several choices are acceptable, pick the most conservative one, proceed, and state the choice.",
	"Batch related questions into a single ask call using the questions array instead of calling ask repeatedly.",
	"Give ask 2-5 concise, distinct options with short labels; put tradeoffs in each option's description, not in the label.",
	"Set recommended on an ask question to mark your default, and multi: true only when several answers can legitimately apply at once.",
	'Never add your own "Other" option to ask — the UI always appends one.',
	"If an ask result comes back with chatRedirect, the user wants to discuss rather than pick: respond in prose and do not re-ask immediately.",
];

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function ask(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask",
		label: "Ask",
		description: TOOL_DESCRIPTION,
		promptSnippet: "Ask the user structured multiple-choice or free-form clarifying questions",
		promptGuidelines: PROMPT_GUIDELINES,
		parameters: AskParams,
		// The picker owns the terminal; two concurrent asks would clobber each other.
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const questions = params.questions;

			// --- validation (typebox can't express these) ---
			if (questions.length === 0) {
				throw new Error("ask requires at least one question. Retry with a non-empty questions array.");
			}
			const seen = new Set<string>();
			for (const question of questions) {
				if (!question.id.trim()) {
					throw new Error("Every ask question needs a non-empty id. Retry with stable ids.");
				}
				if (seen.has(question.id)) {
					throw new Error(`Duplicate ask question id "${question.id}". Retry with unique ids.`);
				}
				seen.add(question.id);
				if (question.options.length === 0) {
					throw new Error(`ask question "${question.id}" has no options. Retry with 2-5 distinct options.`);
				}
				const reserved = question.options.find((option) => RESERVED_LABELS.has(option.label));
				if (reserved) {
					throw new Error(
						`ask question "${question.id}" uses the reserved option label "${reserved.label}". ` +
							`The UI supplies "${OTHER_LABEL}" and "${CHAT_LABEL}" itself — remove it and retry.`,
					);
				}
			}

			if (!ctx.hasUI) {
				throw new Error(
					"No interactive UI is available, so the user cannot be asked. Make the most reasonable assumption, state it explicitly, and continue.",
				);
			}

			const settings = readAskSettings(ctx.cwd);
			const timeoutMs = settings.timeout > 0 ? settings.timeout * 1000 : undefined;
			if (settings.notify) ctx.ui.notify("Waiting for input", "info");

			const outcome =
				ctx.mode === "tui"
					? await runRichDialog(ctx, questions, timeoutMs, signal)
					: await runFallbackDialog(ctx, questions, signal);

			// `custom()` resolves undefined on surfaces that don't support it.
			if (!outcome || outcome.kind === "cancel") {
				ctx.abort();
				throw new Error(
					"User dismissed the question without answering. Do not assume an answer — stop and wait for their direction.",
				);
			}

			if (outcome.kind === "chat") {
				const asked = questions.map((question) => question.question);
				return {
					content: [
						{
							type: "text" as const,
							text: `User chose to chat about this instead of answering.\n\nQuestions asked:\n${asked.join("\n")}`,
						},
					],
					details: { chatRedirect: true, questions: asked } satisfies AskDetails,
				};
			}

			const results = outcome.results;
			const details: AskDetails =
				results.length === 1
					? {
							question: results[0].question,
							options: results[0].options,
							multi: results[0].multi,
							selectedOptions: results[0].selectedOptions,
							...(results[0].customInput !== undefined ? { customInput: results[0].customInput } : {}),
							...(results[0].note ? { note: results[0].note } : {}),
							...(results[0].timedOut ? { timedOut: true } : {}),
						}
					: { results };

			return {
				content: [{ type: "text" as const, text: formatSubmitText(results) }],
				details,
			};
		},

		renderCall(args, theme) {
			const questions = (args.questions as AskQuestion[] | undefined) ?? [];
			let text = theme.fg("toolTitle", theme.bold("ask "));
			if (questions.length === 1) {
				text += theme.fg("muted", flatten(questions[0].question));
			} else {
				text += theme.fg("muted", `${questions.length} questions`);
				const chips = questions.map((question, index) => chipLabel(question, index)).join(", ");
				if (chips) text += theme.fg("dim", ` (${chips})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as AskDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}

			if (details.chatRedirect) {
				return new Text(theme.fg("warning", "→ user wants to discuss instead"), 0, 0);
			}

			const rows = details.results ?? [
				{
					id: "",
					question: details.question ?? "",
					options: details.options ?? [],
					multi: details.multi ?? false,
					selectedOptions: details.selectedOptions ?? [],
					customInput: details.customInput,
					note: details.note,
					timedOut: details.timedOut,
				} satisfies QuestionResult,
			];

			const lines = rows.map((row) => {
				const tick = row.timedOut ? theme.fg("warning", "⏱ ") : theme.fg("success", "✓ ");
				const key = row.id ? `${theme.fg("accent", row.id)}: ` : "";
				const picked = [...row.selectedOptions];
				if (row.customInput !== undefined) picked.push(`${theme.fg("muted", "(wrote) ")}${row.customInput}`);
				let line = `${tick}${key}${picked.join(", ") || theme.fg("dim", "(no answer)")}`;
				if (row.note) line += `\n    ${theme.fg("muted", `✎ ${flatten(row.note)}`)}`;
				return line;
			});

			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
