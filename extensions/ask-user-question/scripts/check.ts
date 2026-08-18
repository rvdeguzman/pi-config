import assert from "node:assert/strict";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import {
	buildQuestionnaireResponse,
	Questionnaire,
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

let result: QuestionnaireResult | undefined;
const questionnaire = new Questionnaire({
	tui,
	theme,
	keybindings,
	questions,
	done: (value) => {
		result = value;
	},
});

for (let width = 0; width <= 80; width++) {
	const lines = questionnaire.component.render(width);
	for (const line of lines) {
		assert.equal(/[\r\n]/.test(line), false);
		assert.ok(visibleWidth(line) <= width, `line exceeds width ${width}`);
	}
}

const initial = questionnaire.component.render(80).map(stripTerminalSequences).join("\n");
assert.match(initial, /\[Checks\]/);
assert.match(initial, /> 1\. \[ \] Unit/);
assert.doesNotMatch(initial, /[^\x00-\x7f]/, "generated questionnaire chrome must be ASCII");

terminal.rows = 6;
questionnaire.component.handleInput(" ");
questionnaire.component.handleInput("<down>");
questionnaire.component.handleInput("<down>");
questionnaire.component.handleInput("<down>");
const shortQuestion = questionnaire.component.render(80).map(stripTerminalSequences);
assert.ok(shortQuestion.length <= terminal.rows);
assert.ok(shortQuestion.some((line) => line.includes("> Next")), "viewport must retain the active row");
questionnaire.component.handleInput("<enter>");
terminal.rows = 40;
questionnaire.component.handleInput("n");
for (const char of "ship after tests") questionnaire.component.handleInput(char);
questionnaire.component.handleInput("<enter>");
questionnaire.component.handleInput("<enter>");
terminal.rows = 4;
const shortReview = questionnaire.component.render(80).map(stripTerminalSequences);
assert.ok(shortReview.some((line) => line.includes("> Submit")), "viewport must retain the submit row");
questionnaire.component.handleInput("<enter>");
terminal.rows = 40;

assert.ok(result);
assert.equal(result.cancelled, false);
assert.deepEqual(result.answers[0]?.selected, ["Unit"]);
assert.equal(result.answers[1]?.answer, "Manual");
assert.equal(result.answers[1]?.notes, "ship after tests");
assert.match(buildQuestionnaireResponse(result).content[0]!.text, /user notes: ship after tests/);

let customResult: QuestionnaireResult | undefined;
const custom = new Questionnaire({
	tui,
	theme,
	keybindings,
	questions: [questions[1]!],
	done: (value) => {
		customResult = value;
	},
});
custom.component.handleInput("<down>");
custom.component.handleInput("<down>");
custom.component.handleInput("<enter>");
const customInput = custom.component.render(80).map(stripTerminalSequences).join("\n");
assert.doesNotMatch(customInput, /[^\x00-\x7f]/, "custom input chrome must remain ASCII");
for (const char of "custom release") custom.component.handleInput(char);
custom.component.handleInput("<enter>");
assert.equal(customResult?.answers[0]?.kind, "custom");
assert.equal(customResult?.answers[0]?.answer, "custom release");

assert.equal(validateQuestionnaire({ questions }), undefined);
assert.match(
	validateQuestionnaire({ questions: [{ ...questions[1]!, options: [questions[1]!.options[0]!] }] }) ?? "",
	/2-4 options/,
);
assert.equal("preview" in QuestionParamsSchema.properties.questions.items.properties.options.items.properties, false);

console.log("check: ASCII UI, multi-question flow, multi-select, notes, schema, and width assertions passed");
