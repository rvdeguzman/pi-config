import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Editor, Key, Markdown, matchesKey, stripTerminalSequences, truncateToWidth, wrapTextWithAnsi, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import { BtwSession, type BtwTopic } from "./btw-session.ts";

export type BtwDialogResult = { action: "close" } | { action: "branch"; topic: BtwTopic };
interface BtwDialogActions {
	ask(question: string, topicId?: string): BtwTopic;
	copy(text: string): Promise<void>;
	branchReason(topic: BtwTopic): string | undefined;
}

export function safeBtwText(text: string): string {
	return stripTerminalSequences(text).replace(/\t/g, "    ").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

/** Small focused reader/history overlay. Text editing is a distinct mode, never a hotkey trap. */
export class BtwDialog implements Component, Focusable {
	#topicId?: string;
	#history: boolean;
	#cursor = 0;
	#scroll = 0;
	#followTail = true;
	#bodyHeight = 1;
	#bodyLines = 0;
	#editing?: { topicId?: string; key: string };
	#editor?: Editor;
	#drafts = new Map<string, string>();
	#focused = false;
	#closed = false;
	#hint?: string;
	#unsubscribe: () => void;
	#markdown?: { text: string; component: Markdown };
	constructor(
		readonly session: BtwSession,
		readonly tui: TUI,
		readonly theme: Theme,
		readonly actions: BtwDialogActions,
		readonly done: (result: BtwDialogResult) => void,
		topicId?: string,
	) {
		this.#topicId = topicId;
		this.#history = !topicId;
		this.#unsubscribe = session.subscribe(() => { if (!this.#closed) tui.requestRender(); });
	}
	get focused(): boolean { return this.#focused; }
	set focused(value: boolean) { this.#focused = value; if (this.#editor) this.#editor.focused = value && !!this.#editing; }
	get topic(): BtwTopic | undefined { return this.session.topics.find(topic => topic.id === this.#topicId); }
	dispose(): void { this.#closed = true; this.#unsubscribe(); if (this.#editor) this.#editor.focused = false; }
	invalidate(): void { this.#editor?.invalidate(); this.#markdown?.component.invalidate(); }
	close(): void { if (this.#closed) return; this.dispose(); this.done({ action: "close" }); }
	#refresh(): void { if (!this.#closed) this.tui.requestRender(); }
	#edit(topicId?: string): void {
		if (this.session.busy) { this.#hint = "BTW is still answering; cancel or wait first."; this.#refresh(); return; }
		const key = topicId ?? "new";
		this.#editing = { topicId, key };
		this.#editor = new Editor(this.tui, {
			borderColor: text => this.theme.fg("dim", text),
			selectList: {
				selectedPrefix: text => this.theme.fg("accent", text), selectedText: text => this.theme.fg("accent", text),
				description: text => this.theme.fg("muted", text), scrollInfo: text => this.theme.fg("dim", text), noMatch: text => this.theme.fg("warning", text),
			},
		});
		this.#editor.setText(this.#drafts.get(key) ?? "");
		this.#editor.focused = this.#focused;
		this.#editor.onSubmit = text => {
			try {
				const topic = this.actions.ask(text, this.#editing?.topicId);
				this.#drafts.delete(key);
				this.#editing = undefined;
				this.#editor!.focused = false;
				this.#topicId = topic.id;
				this.#history = false;
				this.#scroll = Number.MAX_SAFE_INTEGER;
				this.#followTail = true;
				this.#hint = undefined;
			} catch (error) {
				// Editor clears itself before onSubmit; preserve the expanded submitted draft on rejection.
				this.#editor!.setText(text);
				this.#drafts.set(key, text);
				this.#hint = String(error instanceof Error ? error.message : error);
			}
			this.#refresh();
		};
		this.#hint = undefined;
		this.#refresh();
	}

	handleInput(data: string): void {
		if (this.#closed) return;
		if (this.#editing) {
			if (matchesKey(data, Key.escape)) {
				this.#drafts.set(this.#editing.key, this.#editor!.getExpandedText());
				this.#editing = undefined;
				this.#editor!.focused = false;
				this.#refresh();
			} else this.#editor!.handleInput(data);
			return;
		}
		const approval = this.session.approvals[0];
		if (approval && (matchesKey(data, "y") || matchesKey(data, "n") || matchesKey(data, "a"))) {
			const always = matchesKey(data, "a");
			const allow = always || matchesKey(data, "y");
			approval.resolve(allow);
			this.#hint = always ? `Always allowing ${approval.tool}.` : allow ? `Allowed ${approval.tool}.` : `Declined ${approval.tool}.`;
			if (always) void this.session.onTrust?.(approval.tool).catch(error => { this.#hint = `Could not save trust: ${String(error)}`; this.#refresh(); });
			this.#refresh();
			return;
		}
		if (matchesKey(data, Key.escape)) {
			if (this.session.activeTopic?.turns.at(-1)?.status === "running") { this.session.cancel(); this.#hint = "Cancelled; partial answer retained."; this.#refresh(); }
			else this.close();
			return;
		}
		if (matchesKey(data, "x")) { this.close(); return; }
		if (matchesKey(data, "n")) { this.#edit(); return; }
		if (matchesKey(data, "h")) { this.#history = true; this.#scroll = 0; this.#hint = undefined; this.#refresh(); return; }
		if (matchesKey(data, "r")) {
			const topic = this.#history ? this.session.topics[this.#cursor] : this.topic;
			if (topic) void this.session.retrySave(topic.id).then(() => { this.#hint = "Saved."; this.#refresh(); }, error => { this.#hint = String(error); this.#refresh(); });
			return;
		}
		if (this.#history) {
			if (matchesKey(data, Key.up) || matchesKey(data, "k")) this.#cursor = Math.max(0, this.#cursor - 1);
			else if (matchesKey(data, Key.down) || matchesKey(data, "j")) this.#cursor = Math.min(Math.max(0, this.session.topics.length - 1), this.#cursor + 1);
			else if (matchesKey(data, Key.enter)) {
				this.#topicId = this.session.topics[this.#cursor]?.id;
				if (this.#topicId) { this.#history = false; this.#scroll = 0; this.#followTail = false; }
			}
			this.#refresh();
			return;
		}
		const topic = this.topic;
		if (matchesKey(data, "f") && topic) { this.#edit(topic.id); return; }
		if (matchesKey(data, "c") && topic) {
			const answer = topic.turns.at(-1)?.answer;
			if (answer) void this.actions.copy(answer).then(() => { this.#hint = "Copied answer."; this.#refresh(); }, error => { this.#hint = `Copy failed: ${String(error)}`; this.#refresh(); });
			return;
		}
		if (matchesKey(data, "b") && topic) {
			const reason = this.actions.branchReason(topic);
			if (reason) { this.#hint = reason; this.#refresh(); }
			else { this.dispose(); this.done({ action: "branch", topic: structuredClone(topic) }); }
			return;
		}
		const amount = matchesKey(data, Key.pageUp) ? -this.#bodyHeight : matchesKey(data, Key.pageDown) ? this.#bodyHeight :
			matchesKey(data, Key.up) || matchesKey(data, "k") ? -1 : matchesKey(data, Key.down) || matchesKey(data, "j") ? 1 : 0;
		if (matchesKey(data, Key.home)) { this.#scroll = 0; this.#followTail = false; }
		else if (matchesKey(data, Key.end)) { this.#scroll = Number.MAX_SAFE_INTEGER; this.#followTail = true; }
		else if (amount) {
			this.#scroll = Math.max(0, Math.min(this.#scroll, Math.max(0, this.#bodyLines - this.#bodyHeight)) + amount);
			this.#followTail = amount > 0 && this.#scroll >= this.#bodyLines - this.#bodyHeight;
		}
		this.#refresh();
	}

	render(width: number): string[] {
		width = Math.max(1, width);
		const height = Math.max(4, Math.floor((this.tui.terminal.rows || 24) * 0.75));
		const topic = this.topic;
		const latest = topic?.turns.at(-1);
		const title = this.#editing ? this.#editing.topicId ? "BTW · follow-up" : "BTW · new question" : this.#history ? "BTW · history" : `BTW · ${latest?.status ?? "answer"}`;
		const hints = this.#editing ? "Enter send · Shift+Enter newline · Esc back" : this.#history ? "j/k choose · Enter open · n new · x/Esc close" :
			"j/k scroll · PgUp/PgDn · c copy · f follow-up · b branch · h history · n new · r retry save · x hide · Esc cancel/close";
		const shortHint = this.#editing ? "Esc back" : this.session.activeTopic?.turns.at(-1)?.status === "running" ? "Esc cancel" : "Esc close";
		const fullFooter = wrapTextWithAnsi(this.theme.fg("dim", hints), width);
		const footer = width < 20 || height < 10 || fullFooter.length > Math.max(1, Math.floor(height / 3)) ?
			[this.theme.fg("dim", truncateToWidth(shortHint, width, ""))] : fullFooter;
		const pending = this.session.approvals[0];
		const approvalLines = pending ? wrapTextWithAnsi(this.theme.fg("warning", safeBtwText(
			`Allow ${pending.tool}? ${pending.summary}${this.#editing ? " — Esc, then y allow · a always · n deny" : " — y allow · a always · n deny"}`)), width).slice(0, 3) : [];
		const notice = this.session.storageError ? `Not saved: ${this.session.storageError}` : this.session.cleanupError ? `Provider cleanup failed: ${this.session.cleanupError}` : this.#hint;
		const noticeBudget = Math.max(0, Math.min(4, height - 4 - footer.length));
		const notices = [...approvalLines, ...(notice ? wrapTextWithAnsi(this.theme.fg("warning", safeBtwText(notice)), width) : [])].slice(0, noticeBudget);
		const lines = [this.theme.fg("accent", truncateToWidth(title, width, "")), this.theme.fg("dim", "─".repeat(width))];
		if (this.#editing) {
			// Editor's internal layout needs a minimum width for wide graphemes.
			const editorLines = this.#editor!.render(Math.max(8, width)).map(line => truncateToWidth(line, width, ""));
			const budget = Math.max(1, height - lines.length - footer.length - notices.length - 1);
			const cursor = Math.max(0, editorLines.findIndex(line => line.includes(CURSOR_MARKER)));
			const offset = Math.max(0, Math.min(cursor - budget + 1, editorLines.length - budget));
			lines.push(...editorLines.slice(offset, offset + budget));
		} else {
			this.#bodyHeight = Math.max(1, height - 3 - footer.length - Math.min(notices.length, 3));
			let body: string[];
			if (this.#history) {
				body = this.session.topics.map((item, index) => {
					const text = `${index === this.#cursor ? ">" : " "} ${index + 1}. ${item.turns[0].question.split("\n")[0]} · ${item.turns.at(-1)!.status}`;
					return this.theme.fg(index === this.#cursor ? "accent" : "muted", truncateToWidth(safeBtwText(text), width, "…"));
				});
				if (!body.length) body = wrapTextWithAnsi(this.theme.fg("muted", "No side questions yet. Press n or use /btw QUESTION."), width);
				if (this.#cursor < this.#scroll) this.#scroll = this.#cursor;
				if (this.#cursor >= this.#scroll + this.#bodyHeight) this.#scroll = this.#cursor - this.#bodyHeight + 1;
			} else {
				const tools = (turn: BtwTopic["turns"][number]) => turn.tools?.length ? `${turn.tools.map(tool => `\`${safeBtwText(tool.name)}\` ${tool.status === "running" ? "…" : tool.status === "error" ? "✗" : "✓"}`).join(" · ")}\n\n` : "";
				const text = topic?.turns.map(turn => `**You:** ${safeBtwText(turn.question)}\n\n${tools(turn)}${safeBtwText(turn.answer) || (turn.status === "running" ? "Answering…" : "(No answer)")}\n\n${turn.error ? `_${safeBtwText(turn.error)}_\n\n` : ""}`).join("\n---\n\n") ?? "No answer selected.";
				if (this.#markdown?.text !== text) this.#markdown = { text, component: new Markdown(text, 0, 0, getMarkdownTheme()) };
				body = this.#markdown.component.render(Math.max(8, width)).map(line => truncateToWidth(line, width, ""));
			}
			this.#bodyLines = body.length;
			if (!this.#history && this.#followTail && latest?.status === "running") this.#scroll = Number.MAX_SAFE_INTEGER;
			this.#scroll = Math.max(0, Math.min(this.#scroll, body.length - this.#bodyHeight));
			lines.push(...body.slice(this.#scroll, this.#scroll + this.#bodyHeight));
		}
		lines.push(this.theme.fg("dim", "─".repeat(width)), ...notices, ...footer);
		return lines.map(line => truncateToWidth(line, width, ""));
	}
}
