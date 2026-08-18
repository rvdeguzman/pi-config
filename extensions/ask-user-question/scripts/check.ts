import assert from "node:assert/strict";
import { type ExtensionAPI, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, stripTerminalSequences, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import askUserQuestion, {
	buildQuestionnaireResponse,
	Questionnaire,
	QuestionnaireCollapseController,
	QuestionnaireInputController,
	QuestionParamsSchema,
	type QuestionnaireResult,
	validateQuestionnaire,
} from "../index.js";

initTheme(undefined, false);

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

const terminal = { columns: 80, rows: 40 };
const tui = { terminal, requestRender() {} } as TUI;
const keybindings = {
	matches(data: string, name: string) {
		return (
			(data === "<up>" && name === "tui.select.up") ||
			(data === "<down>" && name === "tui.select.down") ||
			(data === "<enter>" && (name === "tui.select.confirm" || name === "tui.input.submit")) ||
			(data === "<escape>" && name === "tui.select.cancel") ||
			(data === "<newline>" && name === "tui.input.newLine") ||
			(data === "<clear>" && name === "tui.editor.deleteToLineStart")
		);
	},
};

const questions = [
	{
		question: "Which checks should run?",
		header: "Checks",
		multiSelect: true,
		options: [
			{ label: "Unit", description: "Fast focused checks." },
			{ label: "Integration", description: "Slower system checks." },
		],
	},
	{
		question: "Which release mode?",
		header: "Release",
		options: [
			{ label: "Manual", description: "A person releases it." },
			{ label: "Automatic", description: "CI releases it." },
		],
	},
];

function makeQuestionnaire(
	selectedQuestions = questions,
	done: (value: QuestionnaireResult) => void = () => {},
) {
	return new Questionnaire({ tui, theme, keybindings, questions: selectedQuestions, done });
}

let result: QuestionnaireResult | undefined;
const questionnaire = makeQuestionnaire(questions, (value) => {
	result = value;
});

for (let width = 0; width <= 80; width++) {
	const lines = questionnaire.component.render(width);
	assert.ok(lines.length <= Math.max(0, terminal.rows - 5), "questionnaire must reserve editor/footer rows");
	for (const line of lines) {
		assert.equal(/[\r\n]/.test(line), false);
		assert.ok(visibleWidth(line) <= width, `line exceeds width ${width}`);
	}
}

const initialLines = questionnaire.component.render(80).map(stripTerminalSequences);
const initial = initialLines.join("\n");
assert.equal(initialLines[0], "-".repeat(80));
assert.equal(initialLines.at(-1), "-".repeat(80));
assert.match(initial, /\[Checks\]/);
assert.match(initial, /> \[ \] Unit/);
assert.match(initial, /  \[ \] Type something\./);
assert.doesNotMatch(initial, /^\s*>?\s*(?:\d+\.|[a-z]\.)\s+\[[ x]\]/m, "multi-select rows use checkbox-only prefixes");
assert.doesNotMatch(initial, /[^\x00-\x7f]/, "generated questionnaire chrome must be ASCII");

const single = makeQuestionnaire([questions[1]!]);
const singleText = single.component.render(80).map(stripTerminalSequences).join("\n");
assert.match(singleText, /> a\. Manual/);
assert.match(singleText, /  b\. Automatic/);
assert.match(singleText, /  c\. Type something\./);
assert.doesNotMatch(singleText, /\[[ x]\]/, "single-select rows never use checkbox glyphs");

let customResult: QuestionnaireResult | undefined;
const custom = makeQuestionnaire([questions[1]!], (value) => {
	customResult = value;
});
custom.component.handleInput("<down>");
custom.component.handleInput("<down>");
let customInput = custom.component.render(80);
assert.ok(customInput.some((line) => line.includes(CURSOR_MARKER)), "custom editor activates and shows its cursor on focus");
for (const char of "draft") custom.component.handleInput(char);
custom.component.handleInput("<up>");
assert.match(custom.component.render(80).map(stripTerminalSequences).join("\n"), /c\. draft/);
custom.component.handleInput("<down>");
customInput = custom.component.render(80);
assert.ok(customInput.some((line) => line.includes(CURSOR_MARKER)), "returning to a draft restores the inline cursor");
assert.match(customInput.map(stripTerminalSequences).join("\n"), /draft/);
custom.component.handleInput("<clear>");
for (const char of "custom release") custom.component.handleInput(char);
custom.component.handleInput("<enter>");
assert.equal(customResult?.answers[0]?.kind, "custom");
assert.equal(customResult?.answers[0]?.answer, "custom release");

terminal.rows = 8;
questionnaire.component.handleInput(" ");
questionnaire.component.handleInput("<down>");
questionnaire.component.handleInput("<down>");
questionnaire.component.handleInput("<down>");
const shortQuestion = questionnaire.component.render(80).map(stripTerminalSequences);
assert.ok(shortQuestion.length <= terminal.rows - 5);
assert.equal(shortQuestion[0], "-".repeat(80));
assert.equal(shortQuestion.at(-1), "-".repeat(80));
assert.ok(shortQuestion.some((line) => line.includes("> Next")), "viewport must retain the active row");
questionnaire.component.handleInput("<enter>");
terminal.rows = 40;
questionnaire.component.handleInput("n");
for (const char of "ship after tests") questionnaire.component.handleInput(char);
questionnaire.component.handleInput("<enter>");
questionnaire.component.handleInput("<enter>");
terminal.rows = 8;
const shortReview = questionnaire.component.render(80).map(stripTerminalSequences);
assert.ok(shortReview.some((line) => line.includes("> Submit")), "viewport must retain the submit row");
assert.equal(shortReview[0], "-".repeat(80));
assert.equal(shortReview.at(-1), "-".repeat(80));
questionnaire.component.handleInput("<enter>");
terminal.rows = 40;

assert.ok(result);
assert.equal(result.cancelled, false);
assert.deepEqual(result.answers[0]?.selected, ["Unit"]);
assert.equal(result.answers[1]?.answer, "Manual");
assert.equal(result.answers[1]?.notes, "ship after tests");
assert.match(buildQuestionnaireResponse(result).content[0]!.text, /user notes: ship after tests/);

let notesOnlyResult: QuestionnaireResult | undefined;
const notesOnly = makeQuestionnaire(questions, (value) => {
	notesOnlyResult = value;
});
notesOnly.component.handleInput("n");
for (const char of "prefer a staged rollout") notesOnly.component.handleInput(char);
notesOnly.component.handleInput("<enter>");
notesOnly.component.handleInput("\t");
notesOnly.component.handleInput("\t");
notesOnly.component.handleInput("<enter>");
assert.equal(notesOnlyResult?.answers.length, 1);
assert.equal(notesOnlyResult?.answers[0]?.kind, "notes");
assert.equal(notesOnlyResult?.answers[0]?.answer, null);
assert.equal(notesOnlyResult?.answers[0]?.notes, "prefer a staged rollout");
const notesOnlyText = buildQuestionnaireResponse(notesOnlyResult!).content[0]!.text;
assert.match(notesOnlyText, /has no committed answer/);
assert.match(notesOnlyText, /user notes: prefer a staged rollout/);

let cancelledWithNotes: QuestionnaireResult | undefined;
const cancelled = makeQuestionnaire(questions, (value) => {
	cancelledWithNotes = value;
});
cancelled.component.handleInput("n");
for (const char of "keep this context") cancelled.component.handleInput(char);
cancelled.component.handleInput("<enter>");
cancelled.component.handleInput("<escape>");
assert.match(buildQuestionnaireResponse(cancelledWithNotes!).content[0]!.text, /user notes: keep this context/);

let hidden = false;
let focused = true;
let focusCalls = 0;
const widgetVisibility: boolean[] = [];
const collapseQuestionnaire = makeQuestionnaire([questions[1]!]);
collapseQuestionnaire.component.handleInput("<down>");
collapseQuestionnaire.component.handleInput("<down>");
for (const char of "kept draft") collapseQuestionnaire.component.handleInput(char);
collapseQuestionnaire.component.handleInput("<up>");
collapseQuestionnaire.component.handleInput("n");
for (const char of "collapse note") collapseQuestionnaire.component.handleInput(char);
collapseQuestionnaire.component.handleInput("<enter>");
const collapse = new QuestionnaireCollapseController((visible) => widgetVisibility.push(visible));
collapse.setHandle({
	setHidden(value) {
		hidden = value;
		focused = !value;
	},
	isHidden: () => hidden,
	isFocused: () => focused,
	focus() {
		focused = true;
		focusCalls++;
	},
});
const inputController = new QuestionnaireInputController(collapseQuestionnaire, collapse);
const ctrlCloseBracket = "\x1d";
const ctrlCloseBracketRepeat = "\x1b[93;5:2u";
const ctrlCloseBracketRelease = "\x1b[93;5:3u";
assert.deepEqual(collapse.handleTerminalInput(ctrlCloseBracketRepeat), { consume: true });
assert.deepEqual(collapse.handleTerminalInput(ctrlCloseBracketRelease), { consume: true });
assert.equal(hidden, false, "repeat/release must not collapse");
assert.deepEqual(collapse.handleTerminalInput(ctrlCloseBracket), { consume: true });
assert.equal(hidden, true);
assert.equal(focused, false, "collapse returns focus away from the controller");
assert.equal(widgetVisibility.at(-1), false);
assert.equal(collapse.handleTerminalInput("editor text"), undefined, "only the toggle key is consumed while hidden");
assert.deepEqual(collapse.handleTerminalInput(ctrlCloseBracketRepeat), { consume: true });
assert.deepEqual(collapse.handleTerminalInput(ctrlCloseBracketRelease), { consume: true });
assert.equal(hidden, true, "repeat/release must not reopen");
assert.deepEqual(collapse.handleTerminalInput(ctrlCloseBracket), { consume: true });
assert.equal(hidden, false);
assert.equal(focused, true, "reopen reclaims controller focus");
assert.equal(focusCalls, 1);
assert.equal(widgetVisibility.at(-1), true);
inputController.component.handleInput("<down>");
const restoredAfterCollapse = collapseQuestionnaire.component.render(80);
assert.ok(restoredAfterCollapse.some((line) => line.includes(CURSOR_MARKER)));
const restoredText = restoredAfterCollapse.map(stripTerminalSequences).join("\n");
assert.match(restoredText, /kept draft/);
assert.match(restoredText, /collapse note/);

assert.equal(validateQuestionnaire({ questions }), undefined);
assert.match(
	validateQuestionnaire({ questions: [{ ...questions[1]!, options: [questions[1]!.options[0]!] }] }) ?? "",
	/2-4 options/,
);
assert.equal("preview" in QuestionParamsSchema.properties.questions.items.properties.options.items.properties, false);

let registeredTool: { execute: (...args: any[]) => Promise<any> } | undefined;
const fakePi = {
	registerTool(tool: { execute: (...args: any[]) => Promise<any> }) {
		registeredTool = tool;
	},
	on() {},
} as unknown as ExtensionAPI;
askUserQuestion(fakePi);
assert.ok(registeredTool);
const widgetCalls: Array<{ content: unknown; placement: unknown }> = [];
let terminalListenerRemoved = false;
let customOptions: any;
const integrationResult = await registeredTool.execute(
	"tool-call-1",
	{ questions: [questions[1]!] },
	new AbortController().signal,
	undefined,
	{
		hasUI: true,
		mode: "tui",
		ui: {
			setWidget(_key: string, content: unknown, options: { placement?: string }) {
				widgetCalls.push({ content, placement: options?.placement });
			},
			onTerminalInput() {
				return () => {
					terminalListenerRemoved = true;
				};
			},
			custom(factory: Function, options: any) {
				customOptions = options;
				return new Promise((resolve) => {
					const controller = factory(tui, theme, keybindings, resolve);
					options.onHandle({
						setHidden() {},
						isHidden: () => false,
						isFocused: () => true,
						focus() {},
						unfocus() {},
					});
					assert.deepEqual(controller.render(1), [], "focused controller overlay must paint nothing");
					controller.handleInput("<enter>");
				});
			},
		},
	},
);
assert.equal(customOptions.overlay, true);
assert.equal(customOptions.overlayOptions.width, 1);
assert.equal(customOptions.overlayOptions.maxHeight, 1);
assert.equal(widgetCalls[0]?.placement, "aboveEditor");
assert.equal(typeof widgetCalls[0]?.content, "function");
assert.equal(widgetCalls.at(-1)?.content, undefined, "questionnaire widget must be cleaned up");
assert.equal(terminalListenerRemoved, true, "raw terminal listener must be cleaned up");
assert.equal(integrationResult.details.answers[0].answer, "Manual");

console.log("check: prefixes, inline drafts, notes-only context, dividers, collapse, flow, API layout, schema, width, and height passed");
