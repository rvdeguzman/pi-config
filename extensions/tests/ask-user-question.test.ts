import assert from "node:assert/strict";
import test from "node:test";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionToolContext,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, type Component, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import askUserQuestion from "../ask-user-question.ts";
import {
	formatQuestionnaireResult,
	Questionnaire,
	type QuestionnaireInput,
	type QuestionnaireResult,
} from "../lib/ask-questionnaire-state.ts";
import { QuestionnaireDialog } from "../lib/ask-questionnaire-ui.ts";

const key = { down: "\x1b[B", up: "\x1b[A", right: "\x1b[C", left: "\x1b[D", enter: "\r", esc: "\x1b", tab: "\t", pageDown: "\x1b[6~" };
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;

function terminal(rows = 24) {
	const size = { rows };
	const tui = { terminal: size, requestRender: () => {} } as unknown as TUI;
	return { tui, size };
}

function type(dialog: QuestionnaireDialog, text: string): void {
	for (const char of text) dialog.handleInput(char);
}

function ui(input: QuestionnaireInput, signal?: AbortSignal) {
	const model = new Questionnaire(input);
	const { tui, size } = terminal();
	let result: QuestionnaireResult | undefined;
	const dialog = new QuestionnaireDialog(model, tui, theme, value => { result = value; }, signal);
	dialog.focused = true;
	return { model, dialog, size, result: () => result };
}

const choices = [{ label: "SQLite", value: "sqlite" }, { label: "Postgres", value: "pg" }];
const chain = {
	questions: [
		{ id: "db", question: "Database?", options: choices },
		{ id: "scope", question: "Scope?", options: [{ label: "Local" }, { label: "Shared" }] },
	],
};

interface RegisteredTool {
	execute(id: string, input: QuestionnaireInput, signal: AbortSignal | undefined, update: undefined, ctx: ExtensionToolContext): Promise<AgentToolResult<QuestionnaireResult>>;
}
interface DialogFactory<T> {
	(tui: TUI, theme: Theme, keys: KeybindingsManager, done: (value: T) => void): Component | Promise<Component>;
}

function toolHarness() {
	let tool: RegisteredTool | undefined;
	askUserQuestion({ registerTool: (registered: RegisteredTool) => { tool = registered; } } as unknown as ExtensionAPI);
	assert.ok(tool);
	const opened = Promise.withResolvers<QuestionnaireDialog>();
	const { tui } = terminal();
	let opens = 0;
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			custom: async <T>(factory: DialogFactory<T>): Promise<T> => {
				opens++;
				const result = Promise.withResolvers<T>();
				const dialog = await factory(tui, theme, {} as KeybindingsManager, result.resolve);
				assert.ok(dialog instanceof QuestionnaireDialog);
				dialog.focused = true;
				opened.resolve(dialog);
				return result.promise;
			},
		},
	} as unknown as ExtensionToolContext;
	return { tool, ctx, opened: opened.promise, opens: () => opens };
}

test("legacy single-choice calls select and submit with the original answer fields", async () => {
	const harness = toolHarness();
	const pending = harness.tool.execute("single", { question: "Database?", options: choices }, undefined, undefined, harness.ctx);
	const dialog = await harness.opened;
	dialog.handleInput(key.down);
	dialog.handleInput(key.enter);
	const result = await pending;
	assert.equal(result.details.status, "answered");
	assert.equal(result.details.question, "Database?");
	assert.equal(result.details.mode, "single-select");
	assert.deepEqual(result.details.answers, [{ type: "option", label: "Postgres", value: "pg", index: 2 }]);
	assert.match(result.content[0].type === "text" ? result.content[0].text : "", /User selected: 2\. Postgres/);
});

test("free-form input is explicitly saved, including an intentional empty response", () => {
	const nonempty = ui({ question: "Describe it" });
	nonempty.dialog.handleInput(key.enter);
	type(nonempty.dialog, "  hello  ");
	nonempty.dialog.handleInput(key.enter);
	assert.deepEqual(nonempty.result()?.answers, [{ type: "text", label: "hello", value: "hello" }]);
	const empty = ui({ question: "Anything else?" });
	empty.dialog.handleInput(key.enter);
	empty.dialog.handleInput(key.enter);
	assert.equal(empty.result()?.status, "answered");
	assert.equal(empty.result()?.answers?.[0].value, "");
});

test("discard returns completed answers and independent notes on otherwise unanswered questions", async () => {
	const harness = toolHarness();
	const pending = harness.tool.execute("partial", chain, undefined, undefined, harness.ctx);
	const dialog = await harness.opened;
	dialog.handleInput(key.enter); // answer first; move to second
	dialog.handleInput("n");
	type(dialog, "avoid this");
	dialog.handleInput(key.enter);
	dialog.handleInput(key.down);
	dialog.handleInput("n");
	type(dialog, "might work");
	dialog.handleInput(key.enter);
	dialog.handleInput(key.esc);
	const result = await pending;
	assert.equal(result.details.status, "discarded");
	assert.equal(result.details.questions[0].answers[0].value, "sqlite");
	assert.equal(result.details.questions[1].state, "unanswered");
	assert.deepEqual(result.details.questions[1].answers, []);
	assert.deepEqual(result.details.questions[1].notes.map(note => [note.label, note.note, note.selected]), [
		["Local", "avoid this", false], ["Shared", "might work", false],
	]);
	const text = result.content[0].type === "text" ? result.content[0].text : "";
	assert.match(text, /Not completed or confirmed/);
	assert.match(text, /Local \[not selected\]: avoid this/);
	assert.match(text, /Unanswered/);
});

test("multi-select notes survive deselection, navigation, and custom-answer edits", () => {
	const flow = ui({ questions: [
		{ id: "db", question: "Databases?", options: choices, multiSelect: true },
		{ id: "scope", question: "Scope?" },
	] });
	const dialog = flow.dialog;
	dialog.handleInput(" ");
	dialog.handleInput("n");
	type(dialog, "keep portable");
	dialog.handleInput(key.enter);
	dialog.handleInput(" "); // deselect without removing note
	dialog.handleInput(key.down);
	dialog.handleInput(" "); // Postgres
	dialog.handleInput(key.down);
	dialog.handleInput(key.enter); // Other
	type(dialog, "DuckDB");
	dialog.handleInput(key.enter);
	dialog.handleInput(key.right);
	dialog.handleInput(key.left);
	dialog.handleInput(key.enter); // edit Other again
	dialog.handleInput("\x01"); // ctrl+a
	dialog.handleInput("\x0b"); // ctrl+k
	type(dialog, "Files");
	dialog.handleInput(key.enter);
	dialog.handleInput(key.esc);
	const result = flow.result()!;
	assert.deepEqual(result.questions[0].answers.map(answer => answer.value), ["pg", "Files"]);
	assert.deepEqual(result.questions[0].notes.map(note => [note.note, note.selected]), [["keep portable", false]]);
});

test("unsaved editor drafts reopen across navigation but never become submitted notes", () => {
	const flow = ui(chain);
	const dialog = flow.dialog;
	dialog.handleInput("n");
	type(dialog, "saved note");
	dialog.handleInput(key.enter);
	dialog.handleInput("n");
	dialog.handleInput("\x01");
	dialog.handleInput("\x0b");
	type(dialog, "unsaved replacement");
	dialog.handleInput(key.esc);
	dialog.handleInput(key.right);
	dialog.handleInput(key.left);
	dialog.handleInput("n");
	assert.match(dialog.render(80).join("\n"), /unsaved replacement/);
	dialog.handleInput(key.esc);
	dialog.handleInput(key.esc);
	assert.equal(flow.result()?.questions[0].notes[0].note, "saved note");
	assert.doesNotMatch(formatQuestionnaireResult(flow.result()!), /unsaved replacement/);
});

test("review blocks unanswered questions; explicit skips permit submission and preserve notes", () => {
	const flow = ui(chain);
	const dialog = flow.dialog;
	dialog.handleInput(key.right);
	dialog.handleInput(key.right); // review
	dialog.handleInput(key.down);
	dialog.handleInput(key.down); // submit
	dialog.handleInput(key.enter);
	assert.equal(flow.result(), undefined);
	assert.match(dialog.render(100).join("\n"), /Answer or explicitly skip/);
	dialog.handleInput(key.left); // second
	dialog.handleInput("n");
	type(dialog, "leave undecided");
	dialog.handleInput(key.enter);
	for (let i = 0; i < 3; i++) dialog.handleInput(key.down); // skip
	dialog.handleInput(key.enter); // review
	dialog.handleInput(key.left);
	dialog.handleInput(key.left); // first
	dialog.handleInput(key.enter); // answer first -> second
	dialog.handleInput(key.right); // review
	dialog.handleInput(key.enter); // review reopens focused on Submit
	assert.equal(flow.result()?.status, "answered");
	assert.equal(flow.result()?.questions[1].state, "skipped");
	assert.deepEqual(flow.result()?.questions[1].answers, []);
	assert.equal(flow.result()?.questions[1].notes[0].note, "leave undecided");
});

test("review Enter revisits an answer and replacement preserves its unselected annotations", () => {
	const flow = ui(chain);
	const dialog = flow.dialog;
	dialog.handleInput("n"); type(dialog, "initial thought"); dialog.handleInput(key.enter);
	dialog.handleInput(key.enter); // answer db
	dialog.handleInput(key.enter); // answer scope -> review, focused on Submit
	dialog.handleInput(key.up); dialog.handleInput(key.up);
	dialog.handleInput(key.enter); // review db
	dialog.handleInput(key.down);
	dialog.handleInput(key.enter); // change db
	dialog.handleInput(key.right); // review, focused on Submit
	dialog.handleInput(key.enter);
	assert.equal(flow.result()?.questions[0].answers[0].value, "pg");
	assert.equal(flow.result()?.questions[0].notes[0].selected, false);
});

test("review opens focused on Submit, including after revisiting a question from review", () => {
	const flow = ui(chain);
	const dialog = flow.dialog;
	dialog.handleInput(key.enter); // answer db
	dialog.handleInput(key.enter); // answer scope -> review
	dialog.handleInput(key.up); dialog.handleInput(key.up); dialog.handleInput(key.enter); // revisit db
	dialog.handleInput("l"); dialog.handleInput("l"); // back to review
	dialog.handleInput(key.enter);
	assert.equal(flow.result()?.status, "answered");
});

test("ambiguous, empty, and malformed inputs fail before opening a popup", async () => {
	const harness = toolHarness();
	for (const input of [
		{ question: "One", questions: chain.questions },
		{ questions: [] },
		{ question: "   " },
		{ questions: [chain.questions[0], chain.questions[0]] },
		{ question: "One", options: [{ label: "  " }] },
		{ questions: chain.questions, multiSelect: false },
	]) await assert.rejects(harness.tool.execute("bad", input, undefined, undefined, harness.ctx));
	assert.equal(harness.opens(), 0);
});

test("RPC and headless modes report unavailable rather than faking a discarded response", async () => {
	const harness = toolHarness();
	for (const mode of ["rpc", "print"] as const) {
		const ctx = { ...harness.ctx, mode, hasUI: mode === "rpc" };
		const result = await harness.tool.execute("no-ui", { question: "Hello?" }, undefined, undefined, ctx);
		assert.equal(result.details.status, "unavailable");
		assert.match(result.content[0].type === "text" ? result.content[0].text : "", /requires interactive terminal UI/);
	}
	assert.equal(harness.opens(), 0);
});

test("queued abort returns without opening a stale dialog; active abort returns saved input and releases the lock", async () => {
	const first = toolHarness();
	const activeController = new AbortController();
	const active = first.tool.execute("active", { question: "Database?", options: choices }, activeController.signal, undefined, first.ctx);
	const dialog = await first.opened;
	dialog.handleInput("n"); type(dialog, "saved before abort"); dialog.handleInput(key.enter);
	const second = toolHarness();
	const queuedController = new AbortController();
	const queued = second.tool.execute("queued", chain, queuedController.signal, undefined, second.ctx);
	queuedController.abort();
	assert.equal((await queued).details.status, "cancelled");
	assert.equal(second.opens(), 0);
	activeController.abort();
	const result = await active;
	assert.equal(result.details.status, "cancelled");
	assert.equal(result.details.notes?.[0].note, "saved before abort");
	dialog.handleInput(key.enter); // closed dialog must not accept more input
	assert.equal(result.details.answers?.length, 0);
	const third = toolHarness();
	const next = third.tool.execute("next", { question: "Next?", options: choices }, undefined, undefined, third.ctx);
	(await third.opened).handleInput(key.enter);
	assert.equal((await next).details.status, "answered");
	assert.equal(second.opens(), 0);
});

test("a pre-aborted call returns cancelled without creating a dialog", async () => {
	const harness = toolHarness();
	const controller = new AbortController(); controller.abort();
	const result = await harness.tool.execute("already-aborted", chain, controller.signal, undefined, harness.ctx);
	assert.equal(result.details.status, "cancelled");
	assert.equal(harness.opens(), 0);
});

test("viewport bounds survive narrow resize, control characters and scrolling to later options", () => {
	const options = Array.from({ length: 30 }, (_unused, index) => ({ label: `Choice ${index} 日本語`, description: "long description\t".repeat(20) }));
	const flow = ui({ question: "A long question ".repeat(15), options, multiSelect: true });
	flow.size.rows = 15;
	for (let i = 0; i < 29; i++) flow.dialog.handleInput(key.down);
	for (const width of [100, 30, 10, 1, 80]) {
		const lines = flow.dialog.render(width);
		assert.ok(lines.length <= 12, "dialog must fit its bounded viewport");
		assert.ok(lines.every(line => visibleWidth(line) <= width), `lines must fit width ${width}`);
		assert.ok(lines.every(line => !line.includes("\t")), "tabs must not reach the terminal");
	}
	assert.match(flow.dialog.render(80).join("\n"), /> \[ \] 30\. Choice 29/);
	flow.dialog.handleInput(key.pageDown);
	flow.dialog.handleInput(key.esc);
});

test("collapsed pasted drafts retain their full contents after backing out and reopening", () => {
	const flow = ui({ question: "Database?", options: choices });
	const paste = "x".repeat(1001);
	flow.dialog.handleInput("n");
	flow.dialog.handleInput(`\x1b[200~${paste}\x1b[201~`);
	flow.dialog.handleInput(key.esc);
	flow.dialog.handleInput("n");
	flow.dialog.handleInput(key.enter);
	flow.dialog.handleInput(key.esc);
	assert.equal(flow.result()?.notes?.[0].note, paste);
});

test("undo in a different option cannot copy another option's unfinished draft", () => {
	const flow = ui({ question: "Database?", options: choices });
	flow.dialog.handleInput("n"); type(flow.dialog, "private draft"); flow.dialog.handleInput(key.esc);
	flow.dialog.handleInput(key.down);
	flow.dialog.handleInput("n");
	flow.dialog.handleInput("\x1b[45;5u"); // Kitty Ctrl+- (undo)
	flow.dialog.handleInput(key.enter);
	flow.dialog.handleInput(key.esc);
	assert.deepEqual(flow.result()?.notes, []);
});

test("Kitty-encoded n opens the note editor without selecting the option", () => {
	const flow = ui({ question: "Database?", options: choices });
	flow.dialog.handleInput("\x1b[110u");
	type(flow.dialog, "protocol-safe note");
	flow.dialog.handleInput(key.enter);
	flow.dialog.handleInput(key.esc);
	assert.equal(flow.result()?.notes?.[0].note, "protocol-safe note");
	assert.equal(flow.result()?.notes?.[0].selected, false);
});

test("narrow terminals retain note, navigation, and discard controls in the footer", () => {
	const flow = ui(chain);
	const text = flow.dialog.render(30).join("\n");
	assert.match(text, /n note/);
	assert.match(text, /←→\/Tab/);
	assert.match(text, /Esc discard/);
	flow.dialog.handleInput(key.esc);
});

test("full question qualifiers and context remain reachable by paging, even after a narrow resize", () => {
	const flow = ui({
		question: `${"Introductory words ".repeat(40)}QUALIFIER`,
		details: `${"Supporting context ".repeat(40)}CONTEXT-END`,
		options: choices,
	});
	flow.size.rows = 15;
	const seen: string[] = [];
	for (let i = 0; i < 30; i++) {
		seen.push(...flow.dialog.render(30));
		flow.dialog.handleInput(key.pageDown);
	}
	assert.match(seen.join("\n"), /QUALIFIER/);
	assert.match(seen.join("\n"), /CONTEXT-END/);
	flow.dialog.handleInput(key.esc);
});

test("a one-item chain retains its Review while standalone single questions submit directly", () => {
	const flow = ui({ questions: [{ id: "only", question: "Database?", options: choices }] });
	flow.dialog.handleInput(key.enter);
	assert.equal(flow.result(), undefined);
	assert.match(flow.dialog.render(80).join("\n"), /Review answers/);
	flow.dialog.handleInput(key.down);
	flow.dialog.handleInput(key.enter);
	assert.equal(flow.result()?.status, "answered");
	assert.equal(flow.result()?.questions[0].answers[0].value, "sqlite");
});

test("hjkl navigates choices, questions and review without consuming letters in note editors", () => {
	const flow = ui(chain);
	const dialog = flow.dialog;
	dialog.handleInput("j");
	dialog.handleInput("n"); type(dialog, "hjkl"); dialog.handleInput(key.enter);
	dialog.handleInput("k");
	dialog.handleInput("\x1b[106u"); // Kitty-encoded j
	dialog.handleInput(key.enter); // choose Postgres -> second question
	dialog.handleInput("h"); // revisit first
	dialog.handleInput("l"); // return to second
	dialog.handleInput("j"); dialog.handleInput(key.enter); // choose Shared -> review
	dialog.handleInput("k"); dialog.handleInput("j"); dialog.handleInput("k"); dialog.handleInput("k"); // review navigation from Submit
	dialog.handleInput(key.enter); // edit first answer
	dialog.handleInput("k"); dialog.handleInput(key.enter); // change to SQLite
	dialog.handleInput("l"); // review
	dialog.handleInput("j"); dialog.handleInput("j"); dialog.handleInput(key.enter);
	assert.equal(flow.result()?.status, "answered");
	assert.equal(flow.result()?.questions[0].answers[0].value, "sqlite");
	assert.equal(flow.result()?.questions[1].answers[0].value, "Shared");
	assert.equal(flow.result()?.questions[0].notes[0].note, "hjkl");
	assert.equal(flow.result()?.questions[0].notes[0].selected, false);
});

test("hjkl stays literal in custom and free-text editors, then resumes navigation on Escape", () => {
	const flow = ui({ questions: [
		{ id: "custom", question: "Database?", options: choices },
		{ id: "text", question: "Explain?" },
	] });
	const dialog = flow.dialog;
	dialog.handleInput("j"); dialog.handleInput("j"); dialog.handleInput(key.enter); // Other
	type(dialog, "hjkl"); dialog.handleInput(key.enter); // next question
	dialog.handleInput(key.enter); type(dialog, "hjkl"); dialog.handleInput(key.esc);
	dialog.handleInput("h"); dialog.handleInput("l");
	dialog.handleInput(key.enter); dialog.handleInput(key.enter); // save reopened text -> review
	dialog.handleInput("j"); dialog.handleInput("j"); dialog.handleInput(key.enter);
	assert.equal(flow.result()?.questions[0].answers[0].value, "hjkl");
	assert.equal(flow.result()?.questions[1].answers[0].value, "hjkl");
});

test("inline editors receive focus and preserve their cursor marker under bounded rendering", () => {
	const flow = ui({ question: "Note?", options: choices });
	flow.dialog.handleInput("n");
	type(flow.dialog, "日本語");
	for (const width of [1, 2, 3, 10, 30]) {
		const lines = flow.dialog.render(width);
		assert.ok(lines.every(line => visibleWidth(line) <= width), `inline editor must fit width ${width}`);
	}
	assert.ok(flow.dialog.render(30).some(line => line.includes(CURSOR_MARKER)));
	flow.dialog.focused = false;
	assert.ok(flow.dialog.render(30).every(line => !line.includes(CURSOR_MARKER)));
	flow.dialog.focused = true;
	flow.dialog.handleInput(key.esc);
	assert.ok(flow.dialog.render(30).every(line => !line.includes(CURSOR_MARKER)));
	flow.dialog.handleInput(key.esc);
});
