import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	formatQuestionnaireResult,
	Questionnaire,
	type QuestionnaireResult,
} from "./lib/ask-questionnaire-state.ts";
import { QuestionnaireDialog, safeQuestionText } from "./lib/ask-questionnaire-ui.ts";

const OptionSchema = Type.Object({
	label: Type.String({ description: 'Display label. Put a recommendation first and append "(Recommended)".' }),
	value: Type.Optional(Type.String({ description: "Machine-readable value; defaults to the label." })),
	description: Type.Optional(Type.String({ description: "Extra detail shown below the option." })),
});

const QuestionFields = {
	question: Type.String({ description: "Question to ask." }),
	details: Type.Optional(Type.String({ description: "Context shown below the question." })),
	options: Type.Optional(Type.Array(OptionSchema, { description: "Choices; Other is automatic. Omit for free-form text." })),
	multiSelect: Type.Optional(Type.Boolean({ description: "Allow multiple selected answers." })),
};

const AskUserQuestionParams = Type.Object({
	question: Type.Optional(QuestionFields.question),
	details: QuestionFields.details,
	options: QuestionFields.options,
	multiSelect: QuestionFields.multiSelect,
	questions: Type.Optional(Type.Array(Type.Object({
		id: Type.String({ description: "Unique question identifier for matching answers." }),
		header: Type.Optional(Type.String({ description: "Short label shown in question navigation." })),
		...QuestionFields,
	}), { minItems: 1, description: "A related question chain, with navigation and final review. Do not combine with top-level question fields." })),
});

interface SharedUiLock {
	withLock<T>(fn: () => T | Promise<T>): Promise<T>;
}

// Preserve the shared popup lock used by other local extensions.
const uiGlobals = globalThis as typeof globalThis & { __piSharedUiLock?: SharedUiLock };
if (!uiGlobals.__piSharedUiLock) {
	let chain: Promise<void> = Promise.resolve();
	uiGlobals.__piSharedUiLock = {
		withLock<T>(fn: () => T | Promise<T>): Promise<T> {
			const previous = chain;
			const release = Promise.withResolvers<void>();
			chain = release.promise;
			return previous.then(fn).finally(() => release.resolve());
		},
	};
}
const sharedUiLock = uiGlobals.__piSharedUiLock;

/** Aborting a queued call returns immediately; its queued callback must still check the signal. */
async function withUiLock(
	model: Questionnaire,
	signal: AbortSignal | undefined,
	show: () => Promise<QuestionnaireResult>,
): Promise<QuestionnaireResult> {
	if (signal?.aborted) return model.result("cancelled");
	const aborted = Promise.withResolvers<QuestionnaireResult>();
	const onAbort = (): void => aborted.resolve(model.result("cancelled"));
	signal?.addEventListener("abort", onAbort, { once: true });
	const locked = sharedUiLock.withLock(() => signal?.aborted ? model.result("cancelled") : show());
	try {
		return await (signal ? Promise.race([locked, aborted.promise]) : locked);
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
}

export default function askUserQuestion(pi: ExtensionAPI): void {
	const tool: ToolDefinition<typeof AskUserQuestionParams, QuestionnaireResult> = {
		name: "ask_user_question",
		label: "ask_user_question",
		description: "Ask the user for preferences, clarification or a decision. Use question for one question, or questions for a related sequence with navigation and review. Users can select options, write custom answers, annotate any option independently, skip explicitly, or discard with saved partial input.",
		promptSnippet: "Ask a question or related question chain before proceeding when user input is needed.",
		promptGuidelines: [
			"Use exactly one input form: top-level question, or questions with unique ids.",
			"Use a chain for related questions; ask unrelated questions separately.",
			"Other is always available. Do not add a custom-input option yourself.",
			"Use multiSelect only when multiple answers are appropriate.",
			'Place recommended choices first and append "(Recommended)" to their labels.',
			"Notes are independent annotations, not selections. Read notes on unselected options too.",
			"A discarded or interrupted questionnaire returns saved partial input, not a completed confirmation. Do not infer missing answers or treat it as blanket approval.",
		],
		parameters: AskUserQuestionParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const model = new Questionnaire(params);
			let details: QuestionnaireResult;
			if (signal?.aborted) details = model.result("cancelled");
			else if (ctx.mode !== "tui" || !ctx.hasUI) {
				details = model.result("unavailable", "ask_user_question requires interactive terminal UI; RPC and headless modes do not support this questionnaire.");
			} else {
				details = await withUiLock(model, signal, () => ctx.ui.custom<QuestionnaireResult>((tui, theme, _keybindings, done) =>
					new QuestionnaireDialog(model, tui, theme, done, signal),
				));
			}
			return { content: [{ type: "text", text: formatQuestionnaireResult(details) }], details };
		},

		renderCall(args, theme) {
			const questions = args.questions;
			const title = typeof args.question === "string" ? args.question : (Array.isArray(questions) ? questions.map(question => typeof question?.header === "string" ? question.header : typeof question?.question === "string" ? question.question : "…").join(" · ") : "…");
			let text = theme.fg("toolTitle", theme.bold("ask_user_question ")) + theme.fg("muted", safeQuestionText(title));
			if (Array.isArray(questions)) text += theme.fg("dim", ` [${questions.length} questions]`);
			else if (args.multiSelect) text += theme.fg("dim", " [multi-select]");
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details;
			if (!details?.questions) {
				// Older persisted results still have the single-question answer shape.
				const first = result.content[0];
				return new Text(safeQuestionText(first?.type === "text" ? first.text : ""), 0, 0);
			}
			const lines: string[] = [];
			if (details.status !== "answered") lines.push(theme.fg("warning", safeQuestionText(details.message ?? (details.status === "discarded" ? "Discarded — returning saved answers and notes" : details.status === "cancelled" ? "Interrupted — returning saved answers and notes" : "Unavailable"))));
			for (const question of details.questions) {
				if (details.questions.length > 1) lines.push(theme.fg("muted", safeQuestionText(question.question)));
				if (question.state !== "answered") lines.push(theme.fg("dim", question.state === "skipped" ? "↷ Skipped" : "○ Unanswered"));
				for (const answer of question.answers) {
					const label = answer.type === "option" ? `${answer.index}. ${answer.label}` : answer.type === "other" ? `Other: ${answer.label}` : answer.label || "(empty response)";
					lines.push(theme.fg("success", "✓ ") + theme.fg("accent", safeQuestionText(label)));
				}
				for (const note of question.notes) lines.push(theme.fg("muted", safeQuestionText(`  ${note.label} [${note.selected ? "selected" : "not selected"}]: ${note.note}`)));
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	};
	pi.registerTool(tool);
}
