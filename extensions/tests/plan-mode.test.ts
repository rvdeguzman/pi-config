import assert from "node:assert/strict";
import test from "node:test";

import planModeExtension from "../plan-mode/index.ts";
import { formatStepSelection, parseStepSelection, type TodoItem } from "../plan-mode/utils.ts";

type Handler = (event: any, ctx: any) => unknown;

const planItems = (): TodoItem[] => [
	{ step: 1, text: "Capture the regression baseline", completed: false },
	{ step: 2, text: "Extract the domain model", completed: false },
	{ step: 3, text: "Run architecture verification", completed: false },
];

function createHarness(entries: any[] = []) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, Handler>();
	const stateEntries: any[] = [];
	const sentMessages: any[] = [];
	const sentUserMessages: Array<{ content: string; options?: Record<string, unknown> }> = [];
	const replacementEntries: any[] = [];
	const replacementPrompts: string[] = [];
	const selectResults: Array<string | undefined> = [];
	const inputResults: Array<string | undefined> = [];
	let activeTools = ["read", "bash", "edit", "write", "todo", "herdr_subagent"];

	const pi = {
		registerFlag: () => undefined,
		getFlag: () => false,
		registerCommand: (name: string, definition: { handler: Handler }) => commands.set(name, definition.handler),
		registerShortcut: () => undefined,
		on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		getActiveTools: () => [...activeTools],
		setActiveTools: (tools: string[]) => {
			activeTools = [...tools];
		},
		appendEntry: (_customType: string, data: unknown) => stateEntries.push(structuredClone(data)),
		sendMessage: (message: unknown, options?: unknown) => sentMessages.push({ message, options }),
		sendUserMessage: (content: string, options?: Record<string, unknown>) => {
			sentUserMessages.push({ content, options });
		},
		getSessionName: () => "Architecture plan",
	};

	const ctx = {
		hasUI: true,
		ui: {
			theme: {
				fg: (_color: string, text: string) => text,
				strikethrough: (text: string) => text,
			},
			setStatus: () => undefined,
			setWidget: () => undefined,
			notify: () => undefined,
			select: async () => selectResults.shift(),
			input: async () => inputResults.shift(),
		},
		sessionManager: {
			getEntries: () => entries,
			getSessionFile: () => "/tmp/parent.jsonl",
		},
		newSession: async (options: any) => {
			await options.setup({
				appendCustomEntry: (customType: string, data: unknown) => replacementEntries.push({ customType, data }),
				appendSessionInfo: (name: string) => replacementEntries.push({ name }),
			});
			await options.withSession({ sendUserMessage: async (prompt: string) => replacementPrompts.push(prompt) });
			return { cancelled: false };
		},
	};

	planModeExtension(pi as never);
	return {
		activeTools: () => activeTools,
		commands,
		ctx,
		handlers,
		inputResults,
		replacementEntries,
		replacementPrompts,
		selectResults,
		sentMessages,
		sentUserMessages,
		stateEntries,
	};
}

test("parses, filters, and formats milestone step ranges", () => {
	const items = planItems();
	items[0]!.completed = true;
	assert.deepEqual(parseStepSelection("1-3,3", items), { steps: [2, 3] });
	assert.deepEqual(parseStepSelection("all", items), { steps: [2, 3] });
	assert.equal(parseStepSelection("3-2", items).error, "Invalid step range: 3-2.");
	assert.match(parseStepSelection("8", items).error ?? "", /plan ends at step 3/);
	assert.equal(formatStepSelection([1, 2, 3, 5, 7, 8]), "1-3,5,7-8");
});

test("implementation menu selects a range and exits plan mode before dispatch", async () => {
	const h = createHarness();
	h.selectResults.push("Implement in a fresh session (recommended)", "Enter a step range…");
	h.inputResults.push("1-2");

	await h.handlers.get("session_start")?.[0]?.({}, h.ctx);
	await h.commands.get("plan")?.("", h.ctx);
	assert.equal(h.activeTools().includes("bash"), false, "plan mode should disable implementation tools");

	await h.handlers.get("agent_end")?.[0]?.(
		{
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "text",
							text: "Plan:\n1. Capture the regression baseline\n2. Extract the domain model\n3. Run architecture verification",
						},
					],
				},
			],
		},
		h.ctx,
	);

	assert.equal(h.activeTools().includes("bash"), true, "the menu must restore implementation tools immediately");
	assert.equal(h.stateEntries.at(-1)?.enabled, false, "disabled plan mode must be persisted before dispatch");
	assert.deepEqual(h.sentUserMessages, [
		{
			content: "/implement 1-2",
			options: { deliverAs: "followUp", expandPromptTemplates: true },
		},
	]);
});

test("fresh milestone handoff carries the full plan and selected execution range", async () => {
	const todos = planItems();
	const h = createHarness([
		{
			type: "custom",
			customType: "plan-mode",
			data: { enabled: true, todos, executing: false, planText: "Plan:\n1. Baseline\n2. Domain\n3. Verify" },
		},
	]);
	await h.handlers.get("session_start")?.[0]?.({}, h.ctx);
	await h.commands.get("implement")?.("2-3", h.ctx);

	const handoff = h.replacementEntries.find((entry) => entry.customType === "plan-mode")?.data;
	assert.deepEqual(handoff.executionSteps, [2, 3]);
	assert.equal(handoff.todos.length, 3, "unselected steps must survive for later milestones");
	assert.match(h.replacementPrompts[0] ?? "", /Selected steps:\n2\. Extract the domain model\n3\. Run architecture verification/);
	assert.doesNotMatch(h.replacementPrompts[0] ?? "", /Selected steps:\n1\./);
});

test("toggling plan mode during execution pauses without discarding progress", async () => {
	const h = createHarness([
		{
			type: "custom",
			customType: "plan-mode",
			data: { enabled: false, todos: planItems(), executing: true, executionSteps: [1, 2, 3], planText: "Plan details" },
		},
	]);
	await h.handlers.get("session_start")?.[0]?.({}, h.ctx);
	await h.commands.get("plan")?.("", h.ctx);

	const state = h.stateEntries.at(-1);
	assert.equal(state.enabled, true);
	assert.equal(state.executing, false);
	assert.equal(state.todos.length, 3);
	assert.equal(state.planText, "Plan details");
	assert.equal(h.activeTools().includes("bash"), false);
});

test("completing a milestone preserves remaining steps and returns to read-only plan mode", async () => {
	const h = createHarness([
		{
			type: "custom",
			customType: "plan-mode",
			data: { enabled: false, todos: planItems(), executing: true, executionSteps: [1], planText: "Plan details" },
		},
	]);
	await h.handlers.get("session_start")?.[0]?.({}, h.ctx);
	await h.handlers.get("turn_end")?.[0]?.(
		{ message: { role: "assistant", content: [{ type: "text", text: "Baseline captured. [DONE:1] [DONE:2]" }] } },
		h.ctx,
	);
	await h.handlers.get("agent_end")?.[0]?.({ messages: [] }, h.ctx);

	const state = h.stateEntries.at(-1);
	assert.equal(state.enabled, true);
	assert.equal(state.executing, false);
	assert.deepEqual(state.executionSteps, []);
	assert.equal(state.todos[0].completed, true);
	assert.equal(state.todos[1].completed, false, "completion tags outside the selected range must be ignored");
	assert.equal(h.activeTools().includes("bash"), false, "the next milestone should begin from read-only plan mode");
	assert.match(h.sentMessages.at(-1)?.message?.content ?? "", /Remaining steps: 2-3/);
});
