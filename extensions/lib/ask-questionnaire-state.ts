export interface QuestionOptionInput {
	label: string;
	value?: string;
	description?: string;
}

export interface QuestionInput {
	id?: string;
	header?: string;
	question: string;
	details?: string;
	options?: QuestionOptionInput[];
	multiSelect?: boolean;
}

export interface QuestionnaireInput {
	question?: string;
	details?: string;
	options?: QuestionOptionInput[];
	multiSelect?: boolean;
	questions?: QuestionInput[];
}

export interface QuestionOption {
	label: string;
	value: string;
	description?: string;
}

export type QuestionMode = "text" | "single-select" | "multi-select";
export type QuestionState = "unanswered" | "answered" | "skipped";
export type QuestionnaireStatus = "answered" | "discarded" | "cancelled" | "unavailable";

export interface Question {
	id: string;
	header?: string;
	question: string;
	context?: string;
	options: QuestionOption[];
	mode: QuestionMode;
}

export type QuestionAnswer =
	| { type: "text" | "other"; label: string; value: string }
	| { type: "option"; label: string; value: string; index: number };

export interface OptionNote {
	type: "option" | "other";
	label: string;
	value?: string;
	index?: number;
	note: string;
	selected: boolean;
}

export interface QuestionResult {
	id: string;
	question: string;
	context?: string;
	mode: QuestionMode;
	state: QuestionState;
	answers: QuestionAnswer[];
	notes: OptionNote[];
}

export interface QuestionnaireResult {
	status: QuestionnaireStatus;
	questions: QuestionResult[];
	// Preserve the existing single-question details interface.
	question?: string;
	context?: string;
	mode?: QuestionMode;
	state?: QuestionState;
	answers?: QuestionAnswer[];
	notes?: OptionNote[];
	message?: string;
}

function nonBlank(value: string, field: string): string {
	const text = value.trim();
	if (!text) throw new Error(`${field} must not be blank.`);
	return text;
}

export function normalizeQuestions(input: QuestionnaireInput): Question[] {
	const hasSingle = input.question !== undefined;
	const hasChain = input.questions !== undefined;
	if (hasSingle === hasChain) throw new Error("Provide either question or questions, not both.");
	if (hasChain && [input.details, input.options, input.multiSelect].some(value => value !== undefined)) {
		throw new Error("Put details, options and multiSelect inside each questions item.");
	}
	const sources: QuestionInput[] = hasChain ? input.questions! : [{
		id: "question", question: input.question!, details: input.details, options: input.options, multiSelect: input.multiSelect,
	}];
	if (sources.length === 0) throw new Error("questions must contain at least one question.");
	const ids = new Set<string>();
	return sources.map<Question>((source, index) => {
		if (hasChain && source.id === undefined) throw new Error(`Question ${index + 1} needs an id.`);
		const id = nonBlank(source.id ?? "question", "Question id");
		if (ids.has(id)) throw new Error(`Duplicate question id: ${id}`);
		ids.add(id);
		const options = (source.options ?? []).map(option => ({
			label: nonBlank(option.label, "Option label"),
			value: option.value?.trim() || option.label.trim(),
			description: option.description?.trim() || undefined,
		}));
		return {
			id,
			header: source.header?.trim() || undefined,
			question: nonBlank(source.question, "Question"),
			context: source.details?.trim() || undefined,
			options,
			mode: options.length === 0 ? "text" : source.multiSelect ? "multi-select" : "single-select",
		};
	});
}

interface SavedQuestion {
	selected: Set<number>;
	notes: Map<number, string>;
	custom?: string;
	text?: string;
	skipped: boolean;
}

/** Saved input is independent from navigation and unsaved editor drafts. */
export class Questionnaire {
	readonly questions: Question[];
	readonly isChain: boolean;
	readonly #saved: SavedQuestion[];

	constructor(input: QuestionnaireInput) {
		this.questions = normalizeQuestions(input);
		this.isChain = input.questions !== undefined;
		this.#saved = this.questions.map(() => ({ selected: new Set(), notes: new Map(), skipped: false }));
	}

	state(index: number): QuestionState {
		const saved = this.#saved[index];
		if (saved.skipped) return "skipped";
		return saved.text !== undefined || saved.selected.size > 0 ? "answered" : "unanswered";
	}

	isSelected(index: number, option: number): boolean {
		return !this.#saved[index].skipped && this.#saved[index].selected.has(option);
	}

	choose(index: number, option: number): void {
		const question = this.questions[index];
		const saved = this.#saved[index];
		if (option < 0 || option >= question.options.length) throw new Error("Invalid choice.");
		if (saved.skipped || question.mode === "single-select") saved.selected.clear();
		saved.skipped = false;
		if (question.mode === "multi-select" && saved.selected.has(option)) saved.selected.delete(option);
		else saved.selected.add(option);
	}

	saveCustom(index: number, text: string): boolean {
		const answer = text.trim();
		if (!answer) return false;
		const saved = this.#saved[index];
		if (saved.skipped || this.questions[index].mode === "single-select") saved.selected.clear();
		saved.skipped = false;
		saved.custom = answer;
		saved.selected.add(this.questions[index].options.length);
		return true;
	}

	toggleCustom(index: number): boolean {
		const saved = this.#saved[index];
		if (saved.custom === undefined) return false;
		if (saved.skipped) saved.selected.clear();
		saved.skipped = false;
		const key = this.questions[index].options.length;
		if (saved.selected.has(key)) saved.selected.delete(key);
		else saved.selected.add(key);
		return true;
	}

	saveText(index: number, text: string): void {
		this.#saved[index].text = text.trim();
		this.#saved[index].skipped = false;
	}

	skip(index: number): void {
		this.#saved[index].skipped = true;
	}

	saveNote(index: number, option: number, text: string): void {
		const question = this.questions[index];
		if (option < 0 || option > question.options.length || question.mode === "text") throw new Error("Invalid note target.");
		const note = text.trim();
		if (note) this.#saved[index].notes.set(option, note);
		else this.#saved[index].notes.delete(option);
	}

	editValue(index: number, kind: "note" | "other" | "text", option = 0): string {
		const saved = this.#saved[index];
		return (kind === "note" ? saved.notes.get(option) : kind === "other" ? saved.custom : saved.text) ?? "";
	}

	get complete(): boolean {
		return this.questions.every((_question, index) => this.state(index) !== "unanswered");
	}

	result(status: QuestionnaireStatus, message?: string): QuestionnaireResult {
		if (status === "answered" && !this.complete) throw new Error("Answer or explicitly skip every question before submitting.");
		const questions: QuestionResult[] = this.questions.map((question, index) => {
			const saved = this.#saved[index];
			const state = this.state(index);
			const answers: QuestionAnswer[] = [];
			if (state === "answered") {
				if (question.mode === "text") answers.push({ type: "text", label: saved.text!, value: saved.text! });
				else for (const choice of [...saved.selected].sort((a, b) => a - b)) {
					const option = question.options[choice];
					answers.push(option
						? { type: "option", label: option.label, value: option.value, index: choice + 1 }
						: { type: "other", label: saved.custom!, value: saved.custom! });
				}
			}
			const notes: OptionNote[] = [...saved.notes].sort(([a], [b]) => a - b).map<OptionNote>(([choice, note]) => {
				const option = question.options[choice];
				return {
					type: option ? "option" : "other",
					label: option?.label ?? "Other",
					value: option?.value ?? saved.custom,
					index: option ? choice + 1 : undefined,
					note,
					selected: this.isSelected(index, choice),
				};
			});
			return { id: question.id, question: question.question, context: question.context, mode: question.mode, state, answers, notes };
		});
		const single = questions.length === 1 ? questions[0] : undefined;
		return {
			status, questions, message,
			...(single ? {
				question: single.question, context: single.context, mode: single.mode, state: single.state,
				answers: single.answers, notes: single.notes,
			} : {}),
		};
	}
}

function answerText(answer: QuestionAnswer): string {
	return answer.type === "option" ? `${answer.index}. ${answer.label}` : answer.type === "other" ? `Other: ${answer.label}` : answer.label || "(empty response)";
}

/** Model-facing text includes annotations even when no answer was selected. */
export function formatQuestionnaireResult(result: QuestionnaireResult): string {
	const sections: string[] = [];
	if (result.status === "discarded" || result.status === "cancelled") {
		sections.push(`${result.status === "discarded" ? "Questionnaire discarded" : "Questionnaire interrupted"} — returning saved partial input. Not completed or confirmed; do not infer missing answers or treat partial input as blanket approval.`);
	} else if (result.status === "unavailable") sections.push(result.message ?? "Questionnaire unavailable.");
	for (const question of result.questions) {
		const lines = [`${question.id}: ${question.question}`];
		if (question.state === "skipped") lines.push("User explicitly skipped this question.");
		else if (question.state === "unanswered") lines.push("Unanswered.");
		else lines.push(...question.answers.map(answer => `User ${answer.type === "text" ? "answered" : "selected"}: ${answerText(answer)}`));
		for (const note of question.notes) lines.push(`Note on ${note.index ? `${note.index}. ` : ""}${note.label} [${note.selected ? "selected" : "not selected"}]: ${note.note}`);
		sections.push(lines.join("\n"));
	}
	return sections.join("\n\n");
}
