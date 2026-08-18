import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	Editor,
	type EditorTheme,
	isKeyRelease,
	isKeyRepeat,
	Key,
	matchesKey,
	type OverlayHandle,
	Text,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";

export const TOOL_NAME = "ask_user_question";
export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_HEADER_LENGTH = 16;
export const MAX_LABEL_LENGTH = 60;

const OptionSchema = Type.Object(
	{
		label: Type.String({
			maxLength: MAX_LABEL_LENGTH,
			description: `MAX ${MAX_LABEL_LENGTH} CHARACTERS. Concise display label, ideally 1-5 words.`,
		}),
		description: Type.String({ description: "What this option means or what will happen if chosen." }),
	},
	{ additionalProperties: false },
);

const QuestionSchema = Type.Object(
	{
		question: Type.String({ description: "The complete, clear question to ask." }),
		header: Type.String({
			maxLength: MAX_HEADER_LENGTH,
			description: `MAX ${MAX_HEADER_LENGTH} CHARACTERS. Short tab label, such as Library or Testing.`,
		}),
		options: Type.Array(OptionSchema, {
			minItems: MIN_OPTIONS,
			maxItems: MAX_OPTIONS,
			description: `${MIN_OPTIONS}-${MAX_OPTIONS} distinct choices. Do not add Other or Type something.`,
		}),
		multiSelect: Type.Optional(Type.Boolean({ default: false, description: "Allow more than one option." })),
	},
	{ additionalProperties: false },
);

export const QuestionParamsSchema = Type.Object(
	{
		questions: Type.Array(QuestionSchema, {
			minItems: 1,
			maxItems: MAX_QUESTIONS,
			description: `One to ${MAX_QUESTIONS} related questions.`,
		}),
	},
	{ additionalProperties: false },
);

export type OptionData = Static<typeof OptionSchema>;
export type QuestionData = Static<typeof QuestionSchema>;
export type QuestionParams = Static<typeof QuestionParamsSchema>;

export interface QuestionAnswer {
	questionIndex: number;
	question: string;
	kind: "option" | "custom" | "multi" | "notes";
	answer: string | null;
	selected?: string[];
	notes?: string;
}

export interface QuestionnaireResult {
	answers: QuestionAnswer[];
	cancelled: boolean;
	error?: "no_ui" | "invalid_input" | "no_custom_ui";
}

interface Keybindings {
	matches(data: string, name: string): boolean;
}

interface QuestionnaireConfig {
	tui: TUI;
	theme: Theme;
	keybindings: Keybindings;
	questions: QuestionData[];
	done: (result: QuestionnaireResult) => void;
}

const RESERVED_LABELS = new Set(["Other", "Type something.", "Next"]);
const editorTheme = (theme: Theme): EditorTheme => ({
	borderColor: (text) => theme.fg("muted", text),
	selectList: {
		selectedPrefix: (text) => theme.fg("accent", text),
		selectedText: (text) => theme.fg("accent", text),
		description: (text) => theme.fg("muted", text),
		scrollInfo: (text) => theme.fg("dim", text),
		noMatch: (text) => theme.fg("warning", text),
	},
});

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function sanitizeLine(value: string) {
	return value
		.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?)/g, "")
		.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, " ")
		.replace(/[\u2028\u2029]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function sanitizeBlock(value: string) {
	return value
		.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?)/g, "")
		.replace(/\r\n?/g, "\n")
		.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
		.trim();
}

function sanitizeParams(params: QuestionParams): QuestionParams {
	return {
		questions: params.questions.map((question) => ({
			...question,
			question: sanitizeLine(question.question),
			header: sanitizeLine(question.header),
			options: question.options.map((option) => ({
				label: sanitizeLine(option.label),
				description: sanitizeLine(option.description),
			})),
		})),
	};
}

export function validateQuestionnaire(params: QuestionParams) {
	if (params.questions.length < 1 || params.questions.length > MAX_QUESTIONS) {
		return `Expected 1-${MAX_QUESTIONS} questions.`;
	}
	const questions = new Set<string>();
	for (const question of params.questions) {
		if (questions.has(question.question)) return "Question text must be unique.";
		questions.add(question.question);
		if (question.options.length < MIN_OPTIONS || question.options.length > MAX_OPTIONS) {
			return `Each question needs ${MIN_OPTIONS}-${MAX_OPTIONS} options.`;
		}
		const labels = new Set<string>();
		for (const option of question.options) {
			if (RESERVED_LABELS.has(option.label)) return `Reserved option label: ${option.label}`;
			if (labels.has(option.label)) return `Duplicate option label: ${option.label}`;
			labels.add(option.label);
		}
	}
	return undefined;
}

function formatAnswer(answer: QuestionAnswer) {
	if (answer.kind === "notes") return "(unanswered)";
	if (answer.kind === "multi") return answer.selected?.length ? answer.selected.join(", ") : "(no input)";
	return answer.answer || "(no input)";
}

export function buildQuestionnaireResponse(result: QuestionnaireResult) {
	if (result.cancelled) {
		const notes = result.answers
			.filter((answer) => answer.notes)
			.map((answer) => `"${answer.question}"${answer.kind === "notes" ? " has no committed answer." : ""} user notes: ${answer.notes}.`);
		return toolResult(`User declined to answer questions${notes.length ? ` Saved context: ${notes.join(" ")}` : ""}`, result);
	}
	const answers = result.answers.map((answer) => {
		if (answer.kind === "notes") {
			return `"${answer.question}" has no committed answer. user notes: ${answer.notes}.`;
		}
		const note = answer.notes ? `. user notes: ${answer.notes}` : "";
		return `"${answer.question}"="${formatAnswer(answer)}"${note}.`;
	});
	return toolResult(
		`User provided the following questionnaire context: ${answers.join(" ")} You can now continue with this context in mind.`,
		result,
	);
}

function toolResult(text: string, details: QuestionnaireResult) {
	return { content: [{ type: "text" as const, text }], details };
}

function cursorOffset(editor: Editor) {
	const cursor = editor.getCursor();
	const lines = editor.getLines();
	let offset = cursor.col;
	for (let i = 0; i < cursor.line; i++) offset += (lines[i]?.length ?? 0) + 1;
	return offset;
}

function editorText(editor: Editor) {
	return editor.getExpandedText?.() ?? editor.getText();
}

function withCursor(value: string, offset: number) {
	const before = value.slice(0, offset);
	const [segment] = graphemes.segment(value.slice(offset));
	const raw = segment?.segment ?? "";
	const atLineEnd = raw === "\n";
	const cell = raw === "" || raw === " " || atLineEnd ? "_" : raw;
	const after = value.slice(offset + (atLineEnd ? 0 : raw.length));
	return `${before}${CURSOR_MARKER}\x1b[7m${cell}\x1b[27m${after}`;
}

function appendWrapped(lines: string[], prefix: string, text: string, width: number) {
	const contentWidth = Math.max(1, width - visibleWidth(prefix));
	const wrapped = wrapTextWithAnsi(text || " ", contentWidth);
	for (let i = 0; i < wrapped.length; i++) {
		lines.push(`${i === 0 ? prefix : " ".repeat(visibleWidth(prefix))}${wrapped[i]}`);
	}
}

const COLLAPSE_KEY = Key.ctrl("]");
const RESERVED_EDITOR_ROWS = 5; // Widget spacer + Pi editor minimum + minimal footer.

function isCollapseKey(data: string) {
	return matchesKey(data, COLLAPSE_KEY);
}

interface CollapsibleOverlayHandle {
	setHidden(hidden: boolean): void;
	isHidden(): boolean;
	isFocused(): boolean;
	focus(): void;
}

/** Coordinates the invisible input controller and the above-editor widget. */
export class QuestionnaireCollapseController {
	private handle: CollapsibleOverlayHandle | undefined;

	constructor(private readonly setWidgetVisible: (visible: boolean) => void) {}

	setHandle(handle: CollapsibleOverlayHandle) {
		this.handle = handle;
	}

	toggle() {
		const handle = this.handle;
		if (!handle) return;
		const hide = !handle.isHidden();
		this.setWidgetVisible(!hide);
		handle.setHidden(hide);
		if (!hide) handle.focus();
	}

	handleTerminalInput(data: string) {
		const handle = this.handle;
		if (!handle || (!handle.isHidden() && !handle.isFocused()) || !isCollapseKey(data)) return undefined;
		if (!isKeyRelease(data) && !isKeyRepeat(data)) this.toggle();
		return { consume: true };
	}

	dispose() {
		this.setWidgetVisible(false);
	}
}

/** Invisible focused overlay that forwards input to the above-editor questionnaire. */
export class QuestionnaireInputController {
	readonly component = {
		wantsKeyRelease: true,
		render: (_width: number) => [] as string[],
		invalidate: () => this.questionnaire.component.invalidate(),
		handleInput: (data: string) => {
			if (isCollapseKey(data)) {
				if (!isKeyRelease(data) && !isKeyRepeat(data)) this.collapse.toggle();
				return;
			}
			if (isKeyRelease(data)) return;
			this.questionnaire.component.handleInput(data);
		},
		dispose: () => this.questionnaire.abort(),
	};

	constructor(
		private readonly questionnaire: Questionnaire,
		private readonly collapse: QuestionnaireCollapseController,
	) {}
}

/** Minimal terminal-only questionnaire. All generated chrome is plain ASCII. */
export class Questionnaire {
	private currentTab = 0;
	private submitChoice = 0;
	private inputMode = false;
	private notesMode = false;
	private readonly cursors: number[];
	private readonly checks: Set<number>[];
	private readonly answers = new Map<number, QuestionAnswer>();
	private readonly customDrafts = new Map<number, string>();
	private readonly notes = new Map<number, string>();
	private readonly inlineEditor: Editor;
	private readonly notesEditor: Editor;
	private activeLine = 0;
	private inlineWidth = 80;
	private finished = false;

	constructor(private readonly config: QuestionnaireConfig) {
		this.cursors = config.questions.map(() => 0);
		this.checks = config.questions.map(() => new Set<number>());
		this.inlineEditor = new Editor(config.tui, editorTheme(config.theme));
		this.notesEditor = new Editor(config.tui, editorTheme(config.theme));
		this.inlineEditor.disableSubmit = true;
		this.notesEditor.disableSubmit = true;
	}

	readonly component = {
		render: (width: number) => this.render(width),
		invalidate: () => this.config.tui.requestRender(),
		handleInput: (data: string) => this.handleInput(data),
	};

	private get hasReview() {
		return this.config.questions.length > 1;
	}

	private get question() {
		return this.config.questions[this.currentTab];
	}

	private get cursor() {
		return this.cursors[this.currentTab] ?? 0;
	}

	private set cursor(value: number) {
		this.cursors[this.currentTab] = value;
	}

	private itemCount(question: QuestionData) {
		return question.options.length + 1 + (question.multiSelect ? 1 : 0);
	}

	private isConfirm(data: string) {
		return (
			this.config.keybindings.matches(data, "tui.select.confirm") ||
			this.config.keybindings.matches(data, "tui.input.submit")
		);
	}

	private refresh() {
		this.config.tui.requestRender();
	}

	private handleInput(data: string) {
		if (this.notesMode) return this.handleNotes(data);
		if (this.inputMode) return this.handleCustomInput(data);
		if (this.hasReview && this.currentTab === this.config.questions.length) return this.handleReview(data);

		if (this.hasReview && (matchesKey(data, Key.tab) || matchesKey(data, Key.right))) {
			this.switchTab(this.currentTab + 1);
			return;
		}
		if (this.hasReview && (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left))) {
			this.switchTab(this.currentTab - 1);
			return;
		}
		if (data === "n") {
			this.notesMode = true;
			this.notesEditor.setText(this.notes.get(this.currentTab) ?? "");
			this.notesEditor.focused = true;
			this.refresh();
			return;
		}
		if (this.config.keybindings.matches(data, "tui.select.up")) {
			this.move(-1);
			return;
		}
		if (this.config.keybindings.matches(data, "tui.select.down")) {
			this.move(1);
			return;
		}
		if (this.config.keybindings.matches(data, "tui.select.cancel")) {
			this.finish(true);
			return;
		}
		if (!this.question) return;
		if (this.question.multiSelect && data === " ") {
			this.toggleCurrent();
			return;
		}
		if (this.isConfirm(data)) this.confirmCurrent();
	}

	private handleNotes(data: string) {
		if (this.config.keybindings.matches(data, "tui.input.newLine")) {
			this.notesEditor.handleInput(data);
			this.refresh();
			return;
		}
		if (this.config.keybindings.matches(data, "tui.select.cancel") || this.isConfirm(data)) {
			const note = sanitizeBlock(editorText(this.notesEditor));
			if (note) this.notes.set(this.currentTab, note);
			else this.notes.delete(this.currentTab);
			this.notesMode = false;
			this.notesEditor.focused = false;
			this.refresh();
			return;
		}
		this.notesEditor.handleInput(data);
		this.refresh();
	}

	private handleCustomInput(data: string) {
		if (this.config.keybindings.matches(data, "tui.input.newLine")) {
			this.inlineEditor.handleInput(data);
			this.refresh();
			return;
		}
		if (this.isConfirm(data)) {
			const answer = sanitizeBlock(editorText(this.inlineEditor));
			if (!answer) return;
			this.customDrafts.set(this.currentTab, answer);
			this.checks[this.currentTab]?.clear();
			this.answers.set(this.currentTab, {
				questionIndex: this.currentTab,
				question: this.question!.question,
				kind: "custom",
				answer,
			});
			this.inputMode = false;
			this.inlineEditor.focused = false;
			this.advance();
			return;
		}
		if (this.config.keybindings.matches(data, "tui.editor.deleteToLineStart")) {
			this.inlineEditor.setText("");
			this.refresh();
			return;
		}
		if (this.config.keybindings.matches(data, "tui.select.cancel")) {
			this.finish(true);
			return;
		}

		if (this.config.keybindings.matches(data, "tui.select.up") && this.inputAtBoundary(-1)) {
			this.leaveCustom(-1);
			return;
		}
		if (this.config.keybindings.matches(data, "tui.select.down") && this.inputAtBoundary(1)) {
			this.leaveCustom(1);
			return;
		}
		this.inlineEditor.handleInput(data);
		this.refresh();
	}

	private inputAtBoundary(direction: -1 | 1) {
		const rendered = this.inlineEditor.render(Math.max(1, this.inlineWidth));
		const cursorLine = rendered.findIndex((line) => line.includes(CURSOR_MARKER));
		if (direction === -1) return cursorLine === 1 && !rendered[0]?.includes("↑");
		return cursorLine === rendered.length - 2 && !rendered[rendered.length - 1]?.includes("↓");
	}

	private handleReview(data: string) {
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
			this.switchTab(0);
			return;
		}
		if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
			this.switchTab(this.currentTab - 1);
			return;
		}
		if (
			this.config.keybindings.matches(data, "tui.select.up") ||
			this.config.keybindings.matches(data, "tui.select.down")
		) {
			this.submitChoice = this.submitChoice === 0 ? 1 : 0;
			this.refresh();
			return;
		}
		if (this.config.keybindings.matches(data, "tui.select.cancel")) {
			this.finish(true);
			return;
		}
		if (this.isConfirm(data)) this.finish(this.submitChoice === 1);
	}

	private leaveCustom(delta: number) {
		const draft = sanitizeBlock(editorText(this.inlineEditor));
		this.customDrafts.set(this.currentTab, draft);
		const existing = this.answers.get(this.currentTab);
		if (existing?.kind === "custom") {
			if (draft) this.answers.set(this.currentTab, { ...existing, answer: draft });
			else this.answers.delete(this.currentTab);
		}
		this.inputMode = false;
		this.inlineEditor.focused = false;
		this.move(delta);
	}

	private activateCustomInput() {
		const question = this.question;
		if (!question || this.cursor !== question.options.length) return;
		this.inputMode = true;
		this.inlineEditor.setText(this.customDrafts.get(this.currentTab) ?? "");
		this.inlineEditor.focused = true;
	}

	private move(delta: number) {
		if (!this.question) return;
		const count = this.itemCount(this.question);
		this.cursor = ((this.cursor + delta) % count + count) % count;
		this.activateCustomInput();
		this.refresh();
	}

	private toggleCurrent() {
		const question = this.question;
		if (!question || this.cursor >= question.options.length) return;
		const checked = this.checks[this.currentTab]!;
		if (checked.has(this.cursor)) checked.delete(this.cursor);
		else checked.add(this.cursor);
		const existing = this.answers.get(this.currentTab);
		if (existing?.kind === "custom") this.answers.delete(this.currentTab);
		else if (existing?.kind === "multi") {
			this.answers.set(this.currentTab, {
				...existing,
				selected: [...checked].sort((a, b) => a - b).map((index) => question.options[index]!.label),
			});
		}
		this.refresh();
	}

	private confirmCurrent() {
		const question = this.question;
		if (!question) return;
		if (this.cursor === question.options.length) {
			this.activateCustomInput();
			this.refresh();
			return;
		}
		if (question.multiSelect) {
			if (this.cursor < question.options.length) {
				this.toggleCurrent();
				return;
			}
			const selected = [...this.checks[this.currentTab]!]
				.sort((a, b) => a - b)
				.map((index) => question.options[index]!.label);
			this.answers.set(this.currentTab, {
				questionIndex: this.currentTab,
				question: question.question,
				kind: "multi",
				answer: null,
				selected,
			});
			this.advance();
			return;
		}
		const option = question.options[this.cursor];
		if (!option) return;
		this.answers.set(this.currentTab, {
			questionIndex: this.currentTab,
			question: question.question,
			kind: "option",
			answer: option.label,
		});
		this.advance();
	}

	private advance() {
		if (!this.hasReview) {
			this.finish(false);
			return;
		}
		this.switchTab(Math.min(this.currentTab + 1, this.config.questions.length));
	}

	private switchTab(index: number) {
		const total = this.config.questions.length + 1;
		this.currentTab = ((index % total) + total) % total;
		this.activateCustomInput();
		this.refresh();
	}

	private orderedAnswers() {
		return this.config.questions.flatMap((question, index) => {
			const answer = this.answers.get(index);
			const notes = this.notes.get(index);
			if (answer) return [{ ...answer, ...(notes ? { notes } : {}) }];
			if (!notes) return [];
			return [{
				questionIndex: index,
				question: question.question,
				kind: "notes" as const,
				answer: null,
				notes,
			}];
		});
	}

	private finish(cancelled: boolean) {
		if (this.finished) return;
		this.finished = true;
		this.inlineEditor.focused = false;
		this.notesEditor.focused = false;
		this.config.done({ answers: this.orderedAnswers(), cancelled });
	}

	abort() {
		this.finish(true);
	}

	private render(width: number) {
		const w = Math.max(0, width);
		const divider = "─".repeat(w);
		const lines: string[] = [divider];
		this.activeLine = 1;
		if (this.hasReview) this.renderTabs(lines, w);
		if (this.currentTab === this.config.questions.length) this.renderReview(lines, w);
		else this.renderQuestion(lines, w);
		lines.push(divider);
		return this.fitHeight(lines.map((line) => truncateToWidth(line, w, "")));
	}

	private fitHeight(lines: string[]) {
		const maxRows = Math.max(0, this.config.tui.terminal.rows - RESERVED_EDITOR_ROWS);
		if (maxRows === 0) return [];
		if (lines.length <= maxRows) return lines;
		if (maxRows === 1) return [lines[lines.length - 1]!];
		const top = lines[0]!;
		const bottom = lines[lines.length - 1]!;
		const body = lines.slice(1, -1);
		const available = maxRows - 2;
		if (available === 0) return [top, bottom];

		const pinTabs = this.hasReview && available >= 3;
		const pinned = pinTabs ? body.slice(0, 2) : [];
		const scrollBody = pinTabs ? body.slice(2) : body;
		const scrollRows = Math.max(1, available - pinned.length);
		const bodyAnchor = Math.max(0, this.activeLine - 1);
		const anchor = Math.max(0, bodyAnchor - (pinTabs ? 2 : 0));
		const start = Math.max(0, Math.min(anchor - Math.floor(scrollRows / 2), scrollBody.length - scrollRows));
		return [top, ...pinned, ...scrollBody.slice(start, start + scrollRows), bottom].slice(0, maxRows);
	}

	private renderTabs(lines: string[], width: number) {
		const tabs = [...this.config.questions.map((question, index) => ({
			label: `${question.header}${this.answers.has(index) ? "*" : ""}`,
			active: index === this.currentTab,
		})), { label: "Review", active: this.currentTab === this.config.questions.length }];
		const text = tabs
			.map((tab) => tab.active ? this.config.theme.fg("accent", `[${tab.label}]`) : ` ${tab.label} `)
			.join(" ");
		lines.push(truncateToWidth(text, width, ""), "");
	}

	private renderQuestion(lines: string[], width: number) {
		const question = this.question;
		if (!question) return;
		for (const line of wrapTextWithAnsi(this.config.theme.bold(question.question), Math.max(1, width))) lines.push(line);
		lines.push(this.config.theme.fg("dim", question.multiSelect ? "Choose any that apply." : "Choose one."), "");

		for (let index = 0; index < question.options.length; index++) {
			const option = question.options[index]!;
			const active = !this.notesMode && !this.inputMode && this.cursor === index;
			const selected = this.checks[this.currentTab]!.has(index);
			const choicePrefix = question.multiSelect
				? `[${selected ? "x" : " "}] `
				: `${String.fromCharCode("a".charCodeAt(0) + index)}. `;
			const prefix = `${active ? ">" : " "} ${choicePrefix}`;
			if (active) this.activeLine = lines.length;
			appendWrapped(lines, prefix, active ? this.config.theme.fg("accent", option.label) : option.label, width);
			appendWrapped(lines, " ".repeat(visibleWidth(prefix)), this.config.theme.fg("muted", option.description), width);
		}

		const customIndex = question.options.length;
		const customActive = this.cursor === customIndex;
		const customSelected = this.answers.get(this.currentTab)?.kind === "custom";
		const customChoicePrefix = question.multiSelect
			? `[${customSelected ? "x" : " "}] `
			: `${String.fromCharCode("a".charCodeAt(0) + customIndex)}. `;
		const customPrefix = `${customActive ? ">" : " "} ${customChoicePrefix}`;
		if (customActive) this.activeLine = lines.length;
		if (this.inputMode) {
			// Editor reserves one cursor column; add it back so its hidden layout matches ours.
			const contentWidth = Math.max(1, width - visibleWidth(customPrefix));
			this.inlineWidth = contentWidth + 1;
			this.inlineEditor.render(this.inlineWidth);
			const start = lines.length;
			appendWrapped(
				lines,
				customPrefix,
				withCursor(editorText(this.inlineEditor), cursorOffset(this.inlineEditor)),
				width,
			);
			const cursorLine = lines.findIndex((line, index) => index >= start && line.includes(CURSOR_MARKER));
			if (cursorLine >= 0) this.activeLine = cursorLine;
		} else {
			const draft = this.customDrafts.get(this.currentTab);
			appendWrapped(lines, customPrefix, draft || "Type something.", width);
		}

		if (question.multiSelect) {
			const nextActive = this.cursor === customIndex + 1;
			if (nextActive) this.activeLine = lines.length;
			lines.push(`${nextActive ? ">" : " "} Next`);
		}

		const note = this.notes.get(this.currentTab);
		lines.push("");
		if (this.notesMode) {
			lines.push(this.config.theme.fg("muted", "Note:"));
			const contentWidth = Math.max(1, width - 2);
			this.notesEditor.render(contentWidth + 1);
			const start = lines.length;
			appendWrapped(
				lines,
				"  ",
				withCursor(editorText(this.notesEditor), cursorOffset(this.notesEditor)),
				width,
			);
			const cursorLine = lines.findIndex((line, index) => index >= start && line.includes(CURSOR_MARKER));
			this.activeLine = cursorLine >= 0 ? cursorLine : start;
			lines.push("", this.config.theme.fg("dim", "Enter: close  Shift+Enter: newline  Esc: close"));
			return;
		}
		if (note) appendWrapped(lines, "Note: ", this.config.theme.fg("muted", note), width);
		const tabHelp = this.hasReview ? "  Tab: next" : "";
		const help = question.multiSelect
			? `Up/Down: move  Space/Enter: toggle  n: note${tabHelp}  Esc: cancel`
			: `Up/Down: move  Enter: choose  n: note${tabHelp}  Esc: cancel`;
		lines.push(this.config.theme.fg("dim", help));
	}

	private renderReview(lines: string[], width: number) {
		lines.push(this.config.theme.bold("Review answers"), "");
		for (let index = 0; index < this.config.questions.length; index++) {
			const question = this.config.questions[index]!;
			const answer = this.answers.get(index);
			appendWrapped(
				lines,
				`${question.header}: `,
				answer ? formatAnswer(answer) : this.config.theme.fg("warning", "(unanswered)"),
				width,
			);
			const note = this.notes.get(index);
			if (note) appendWrapped(lines, "  Note: ", this.config.theme.fg("muted", note), width);
		}
		lines.push("");
		this.activeLine = lines.length + this.submitChoice;
		lines.push(`${this.submitChoice === 0 ? ">" : " "} Submit`, `${this.submitChoice === 1 ? ">" : " "} Cancel`, "");
		lines.push(this.config.theme.fg("dim", "Up/Down: choose  Enter: confirm  Shift+Tab: back  Esc: cancel"));
	}
}

export const DEFAULT_TOOL_DESCRIPTION = `Ask the user one or more structured questions in a terminal questionnaire. Supports single-select, multi-select, custom answers, and per-question notes. Group related questions into one call.`;
export const DEFAULT_PROMPT_SNIPPET = `Ask the user up to ${MAX_QUESTIONS} structured questions when requirements are ambiguous`;
export const DEFAULT_PROMPT_GUIDELINES = [
	`Use ask_user_question when the request is underspecified and you need a concrete decision. Group up to ${MAX_QUESTIONS} related questions in one call.`,
	`Each question requires ${MIN_OPTIONS}-${MAX_OPTIONS} concise options with descriptions. A Type something. row is added automatically.`,
	"Set multiSelect: true when multiple answers are valid. Put a recommended option first and label it (Recommended).",
];

export default function askUserQuestion(pi: ExtensionAPI) {
	pi.registerTool({
		name: TOOL_NAME,
		label: "Ask User Question",
		description: DEFAULT_TOOL_DESCRIPTION,
		promptSnippet: DEFAULT_PROMPT_SNIPPET,
		promptGuidelines: DEFAULT_PROMPT_GUIDELINES,
		parameters: QuestionParamsSchema,

		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			if (!ctx.hasUI || ctx.mode !== "tui") {
				return toolResult("Error: UI not available", { answers: [], cancelled: true, error: "no_ui" });
			}
			const input = sanitizeParams(params);
			const validationError = validateQuestionnaire(input);
			if (validationError) {
				return toolResult(`Error: ${validationError}`, {
					answers: [],
					cancelled: true,
					error: "invalid_input",
				});
			}

			const widgetKey = `${TOOL_NAME}:${toolCallId}`;
			let questionnaire: Questionnaire | undefined;
			let overlayHandle: OverlayHandle | undefined;
			let abortRequested = signal.aborted;
			let removeTerminalInput: (() => void) | undefined;
			const setWidgetVisible = (visible: boolean) => {
				ctx.ui.setWidget(
					widgetKey,
					visible && questionnaire ? () => questionnaire!.component : undefined,
					{ placement: "aboveEditor" },
				);
			};
			const collapse = new QuestionnaireCollapseController(setWidgetVisible);
			const abort = () => {
				abortRequested = true;
				questionnaire?.abort();
			};
			signal.addEventListener("abort", abort, { once: true });

			try {
				removeTerminalInput = ctx.ui.onTerminalInput((data) => collapse.handleTerminalInput(data));
				const result = await ctx.ui.custom<QuestionnaireResult>(
					(tui, theme, keybindings, done) => {
						questionnaire = new Questionnaire({
							tui,
							theme,
							keybindings,
							questions: input.questions,
							done,
						});
						setWidgetVisible(true);
						const controller = new QuestionnaireInputController(questionnaire, collapse);
						if (abortRequested) queueMicrotask(() => questionnaire?.abort());
						return controller.component;
					},
					{
						overlay: true,
						overlayOptions: {
							anchor: "bottom-left",
							width: 1,
							maxHeight: 1,
							margin: 0,
						},
						onHandle: (handle) => {
							overlayHandle = handle;
							collapse.setHandle(handle);
						},
					},
				);
				if (!result) {
					return toolResult("Error: terminal questionnaire UI unavailable", {
						answers: [],
						cancelled: true,
						error: "no_custom_ui",
					});
				}
				return buildQuestionnaireResponse(result);
			} finally {
				signal.removeEventListener("abort", abort);
				removeTerminalInput?.();
				collapse.dispose();
				if (overlayHandle && !overlayHandle.isHidden()) overlayHandle.unfocus();
			}
		},

		renderCall(args, theme) {
			const count = Array.isArray(args.questions) ? args.questions.length : 0;
			return new Text(`${theme.fg("toolTitle", theme.bold(TOOL_NAME))} ${theme.fg("muted", `${count} question${count === 1 ? "" : "s"}`)}`, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as QuestionnaireResult | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}
			if (details.cancelled) return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			return new Text(details.answers.map((answer) => `${answer.question}: ${formatAnswer(answer)}`).join("\n"), 0, 0);
		},
	});

	// Headless children cannot ask their parent. Hide the tool instead of letting them call a dead UI.
	pi.on("before_agent_start", (_event, ctx) => {
		if (ctx.hasUI && ctx.mode === "tui") return;
		const active = pi.getActiveTools();
		if (active.includes(TOOL_NAME)) pi.setActiveTools(active.filter((name) => name !== TOOL_NAME));
	});
}
