import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	Editor,
	type Component,
	type Focusable,
	Key,
	matchesKey,
	stripTerminalSequences,
	type TUI,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Questionnaire, type QuestionnaireResult, type QuestionnaireStatus } from "./ask-questionnaire-state.ts";

export function safeQuestionText(text: string): string {
	return stripTerminalSequences(text).replace(/\t/g, "    ").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

type EditKind = "note" | "other" | "text";
interface EditTarget {
	question: number;
	kind: EditKind;
	option: number;
	key: string;
}
interface ChoiceRow {
	kind: "option" | "other" | "text" | "skip" | "next" | "review" | "submit";
	label: string;
	option?: number;
	question?: number;
	selected?: boolean;
	description?: string;
	answer?: string;
	note?: string;
}

/** Minimal terminal adapter: all saved input lives in Questionnaire, never in a render cache. */
export class QuestionnaireDialog implements Component, Focusable {
	readonly #model: Questionnaire;
	readonly #tui: TUI;
	readonly #theme: Pick<Theme, "fg">;
	readonly #done: (result: QuestionnaireResult) => void;
	#editor: Editor;
	readonly #cursors: number[];
	readonly #scrolls: number[];
	readonly #drafts = new Map<string, string>();
	#page = 0;
	#editing?: EditTarget;
	#focused = false;
	#closed = false;
	#followFocus = false;
	#bodyHeight = 1;
	#hint?: string;
	#signal?: AbortSignal;

	constructor(model: Questionnaire, tui: TUI, theme: Pick<Theme, "fg">, done: (result: QuestionnaireResult) => void, signal?: AbortSignal) {
		this.#model = model;
		this.#tui = tui;
		this.#theme = theme;
		this.#done = done;
		this.#signal = signal;
		this.#cursors = model.questions.map(() => 0).concat(0);
		this.#scrolls = model.questions.map(() => 0).concat(0);
		this.#editor = this.#createEditor();
		signal?.addEventListener("abort", this.#onAbort, { once: true });
	}

	#createEditor(): Editor {
		const theme = this.#theme;
		const editor = new Editor(this.#tui, {
			borderColor: text => theme.fg("accent", text),
			selectList: {
				selectedPrefix: text => theme.fg("accent", text),
				selectedText: text => theme.fg("accent", text),
				description: text => theme.fg("muted", text),
				scrollInfo: text => theme.fg("dim", text),
				noMatch: text => theme.fg("warning", text),
			},
		});
		editor.onSubmit = text => this.#saveEdit(text);
		return editor;
	}

	get focused(): boolean { return this.#focused; }
	set focused(value: boolean) {
		this.#focused = value;
		this.#editor.focused = value && this.#editing !== undefined;
	}

	readonly #onAbort = (): void => { this.#finish("cancelled"); };

	dispose(): void {
		this.#closed = true;
		this.#signal?.removeEventListener("abort", this.#onAbort);
		this.#editor.focused = false;
	}

	invalidate(): void { this.#editor.invalidate(); }

	#refresh(): void {
		this.#tui.requestRender();
	}

	#finish(status: QuestionnaireStatus): void {
		if (this.#closed) return;
		if (status === "answered" && !this.#model.complete) {
			this.#hint = "Answer or explicitly skip every question before submitting.";
			this.#refresh();
			return;
		}
		const result = this.#model.result(status);
		this.dispose();
		this.#done(result);
	}

	#rows(): ChoiceRow[] {
		if (this.#page === this.#model.questions.length) {
			return this.#model.result("discarded").questions.map((question, index): ChoiceRow => ({
				kind: "review",
				question: index,
				label: `${index + 1}. ${this.#model.questions[index].header ?? question.question} — ${question.state}`,
				answer: question.answers.map(answer => answer.type === "other" ? `Other: ${answer.label}` : answer.label || "(empty response)").join(", "),
				note: question.notes.map(note => `${note.label} [${note.selected ? "selected" : "not selected"}]: ${note.note}`).join("\n"),
			})).concat({ kind: "submit", label: "Submit answers" });
		}
		const question = this.#model.questions[this.#page];
		const rows: ChoiceRow[] = question.mode === "text"
			? [{ kind: "text", label: "Write your answer…", answer: this.#model.editValue(this.#page, "text") }]
			: question.options.map<ChoiceRow>((option, index) => ({
				kind: "option",
				option: index,
				label: `${index + 1}. ${option.label}`,
				description: option.description,
				selected: this.#model.isSelected(this.#page, index),
				note: this.#model.editValue(this.#page, "note", index),
			}));
		if (question.mode !== "text") rows.push({
			kind: "other",
			option: question.options.length,
			label: question.options.some(option => option.label.toLowerCase() === "other") ? "Other (custom)…" : "Other…",
			selected: this.#model.isSelected(this.#page, question.options.length),
			answer: this.#model.editValue(this.#page, "other"),
			note: this.#model.editValue(this.#page, "note", question.options.length),
		});
		rows.push({ kind: "skip", label: this.#model.state(this.#page) === "skipped" ? "Skip question [skipped]" : "Skip question" });
		if (question.mode === "multi-select") rows.push({ kind: "next", label: this.#model.isChain ? "Next →" : "Submit" });
		return rows;
	}

	#movePage(delta: number): void {
		if (!this.#model.isChain) return;
		const count = this.#model.questions.length + 1;
		this.#page = (this.#page + delta + count) % count;
		this.#hint = undefined;
		this.#followFocus = false;
	}

	#advance(): void {
		if (this.#model.state(this.#page) === "unanswered") {
			this.#hint = "Choose an answer or use Skip question.";
			return;
		}
		if (!this.#model.isChain) this.#finish("answered");
		else {
			this.#page++;
			this.#hint = undefined;
			this.#followFocus = false;
		}
	}

	#edit(kind: EditKind, option = 0): void {
		const key = `${this.#page}:${kind}:${option}`;
		this.#editing = { question: this.#page, kind, option, key };
		// Fresh editors prevent undo/paste history from leaking between targets.
		this.#editor = this.#createEditor();
		this.#editor.setText(this.#drafts.get(key) ?? this.#model.editValue(this.#page, kind, option));
		this.#editor.focused = this.#focused;
		this.#hint = undefined;
	}

	#saveEdit(text: string): void {
		const edit = this.#editing;
		if (!edit) return;
		if (edit.kind === "other" && !this.#model.saveCustom(edit.question, text)) {
			this.#hint = "Write a custom answer before saving.";
			return;
		}
		if (edit.kind === "note") this.#model.saveNote(edit.question, edit.option, text);
		if (edit.kind === "text") this.#model.saveText(edit.question, text);
		this.#drafts.delete(edit.key);
		this.#editing = undefined;
		this.#editor.focused = false;
		this.#hint = undefined;
		if (edit.kind === "text" || (edit.kind === "other" && this.#model.questions[edit.question].mode === "single-select")) this.#advance();
		this.#refresh();
	}

	handleInput(data: string): void {
		if (this.#closed) return;
		if (this.#editing) {
			if (matchesKey(data, Key.escape)) {
				this.#drafts.set(this.#editing.key, this.#editor.getExpandedText());
				this.#editing = undefined;
				this.#editor.focused = false;
				this.#hint = undefined;
			} else this.#editor.handleInput(data);
			this.#refresh();
			return;
		}
		if (matchesKey(data, Key.escape)) { this.#finish("discarded"); return; }
		if (matchesKey(data, Key.left) || matchesKey(data, "h") || matchesKey(data, Key.shift("tab"))) this.#movePage(-1);
		else if (matchesKey(data, Key.right) || matchesKey(data, "l") || matchesKey(data, Key.tab)) this.#movePage(1);
		else {
			const rows = this.#rows();
			const cursor = this.#cursors[this.#page];
			const row = rows[cursor];
			const up = matchesKey(data, Key.up) || matchesKey(data, "k");
			const down = matchesKey(data, Key.down) || matchesKey(data, "j");
			if (up || down) {
				this.#cursors[this.#page] = Math.max(0, Math.min(rows.length - 1, cursor + (up ? -1 : 1)));
				this.#followFocus = true;
				this.#hint = undefined;
			} else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
				this.#scrolls[this.#page] += (matchesKey(data, Key.pageUp) ? -1 : 1) * Math.max(1, this.#bodyHeight - 1);
				this.#followFocus = false;
			} else if (matchesKey(data, "n") && (row.kind === "option" || row.kind === "other")) this.#edit("note", row.option);
			else if (matchesKey(data, Key.space) && this.#page < this.#model.questions.length && this.#model.questions[this.#page].mode === "multi-select") {
				if (row.kind === "option") this.#model.choose(this.#page, row.option!);
				if (row.kind === "other" && !this.#model.toggleCustom(this.#page)) this.#edit("other");
			} else if (matchesKey(data, Key.enter)) {
				if (row.kind === "review") { this.#page = row.question!; this.#followFocus = true; }
				else if (row.kind === "submit") this.#finish("answered");
				else if (row.kind === "skip") { this.#model.skip(this.#page); this.#advance(); }
				else if (row.kind === "other") this.#edit("other");
				else if (row.kind === "text") this.#edit("text");
				else if (row.kind === "next") this.#advance();
				else if (this.#model.questions[this.#page].mode === "multi-select") this.#advance();
				else { this.#model.choose(this.#page, row.option!); this.#advance(); }
			}
		}
		this.#refresh();
	}

	render(width: number): string[] {
		width = Math.max(1, width);
		const height = Math.max(1, Math.floor((this.#tui.terminal.rows || 24) * 0.8));
		const theme = this.#theme;
		const question = this.#model.questions[this.#page];
		const chain = this.#model.isChain;
		const help = this.#editing
			? "Enter save · Esc back"
			: question
				? `j/k/↑↓ · ${question.mode === "multi-select" ? "Space toggle · " : ""}Enter ${question.mode === "single-select" ? "choose" : question.mode === "text" ? "edit" : "next"}${question.mode !== "text" ? " · n note" : ""}${chain ? " · h/l/←→/Tab" : ""} · Esc discard`
				: "j/k/↑↓ · Enter edit/submit · h/l/←→/Tab · Esc discard";
		const compactHelp = width < 8 ? "Esc" : width < 20
			? this.#editing ? "Enter Esc" : `jk/↑↓ ${question?.mode === "multi-select" ? "Space " : ""}Enter${question && question.mode !== "text" ? " n" : ""}${chain ? " hl/Tab" : ""} Esc`
			: `${help}${this.#editing ? "" : " · PgUp/PgDn"}`;
		const footerText = this.#hint ? `${this.#hint}\n${compactHelp}` : compactHelp;
		const footerLines = wrapTextWithAnsi(safeQuestionText(footerText), width);
		const footerBudget = Math.max(1, Math.min(footerLines.length, Math.max(1, height - 4)));
		const header: string[] = [];
		const wrap = (text: string, indent = ""): string[] => {
			const padding = indent.length < width ? indent : "";
			return wrapTextWithAnsi(safeQuestionText(text), Math.max(1, width - padding.length)).map(line => `${padding}${line}`);
		};
		if (chain) header.push(theme.fg("muted", truncateToWidth(question ? ` ${this.#page + 1}/${this.#model.questions.length} · ${safeQuestionText(question.header ?? "Question")}` : " Review answers", width)));
		const headerBudget = Math.max(0, Math.min(header.length, height - footerBudget - 3));
		const bodyBudget = Math.max(1, height - headerBudget - footerBudget - 2);
		this.#bodyHeight = bodyBudget;
		let body: string[];
		if (this.#editing) {
			const edit = this.#editing;
			const label = edit.kind === "note" ? `Note for ${question.options[edit.option]?.label ?? "Other"}` : edit.kind === "other" ? "Custom answer" : "Your answer";
			// Pi's editor cannot wrap a wide grapheme into a sub-grapheme width.
			const editorLines = this.#editor.render(Math.max(8, width));
			const cursorLine = Math.max(0, editorLines.findIndex(line => line.includes(CURSOR_MARKER)));
			const editorBudget = Math.max(1, bodyBudget - 1);
			const start = Math.max(0, cursorLine - editorBudget + 1);
			body = bodyBudget > 1 ? [theme.fg("muted", truncateToWidth(` ${safeQuestionText(label)}`, width)), ...editorLines.slice(start, start + editorBudget)] : editorLines.slice(start, start + 1);
		} else {
			const all: string[] = [];
			// Titles/context share the scrollable body: no qualifier is permanently clipped.
			if (question) {
				all.push(...wrap(question.question, " ").map(line => theme.fg("text", line)));
				if (question.context) all.push(...wrap(question.context, " ").map(line => theme.fg("muted", line)));
				all.push("");
			}
			const anchors: Array<{ start: number; end: number }> = [];
			const rows = this.#rows();
			for (const [index, row] of rows.entries()) {
				const start = all.length;
				const focused = index === this.#cursors[this.#page];
				const marker = row.selected === undefined ? "" : question?.mode === "multi-select" ? (row.selected ? "[x] " : "[ ] ") : row.selected ? "✓ " : "";
				const label = `${focused ? "> " : "  "}${marker}${row.label}`;
				all.push(...wrap(label).map(line => theme.fg(focused ? "accent" : row.selected ? "success" : "text", line)));
				if (row.description) all.push(...wrap(row.description, "     ").map(line => theme.fg("muted", line)));
				if (row.answer) all.push(...wrap(row.answer, "     ").map(line => theme.fg("muted", line)));
				if (row.note) all.push(...wrap(`Note: ${row.note}`, "     ").map(line => theme.fg("muted", line)));
				anchors.push({ start, end: all.length });
			}
			let offset = Math.max(0, this.#scrolls[this.#page]);
			const anchor = anchors[this.#cursors[this.#page]];
			if (this.#followFocus && anchor) {
				if (anchor.start < offset) offset = anchor.start;
				else if (anchor.end > offset + bodyBudget) offset = Math.min(anchor.start, anchor.end - bodyBudget);
			}
			offset = Math.max(0, Math.min(Math.max(0, all.length - bodyBudget), offset));
			this.#scrolls[this.#page] = offset;
			body = all.slice(offset, offset + bodyBudget);
			if (all.length > bodyBudget && headerBudget > 0) {
				header[0] = theme.fg("muted", truncateToWidth(`${safeQuestionText(question ? `${this.#page + 1}/${this.#model.questions.length} · ${question.header ?? "Question"}` : "Review")} · PgUp/PgDn scroll`, width));
			}
		}
		const border = theme.fg("accent", "─".repeat(width));
		const footer = footerLines.slice(0, footerBudget).map(line => theme.fg(this.#hint ? "warning" : "dim", line));
		return [border, ...header.slice(0, headerBudget), ...body, ...footer, border].slice(0, height).map(line => truncateToWidth(line, width));
	}
}
