import assert from "node:assert/strict";
import test from "node:test";

import planModeExtension from "../plan-mode/index.ts";
import {
	TODO_CHANGED_EVENT,
	TODO_SERVICE_DISCOVER_EVENT,
	type TodoIntegrationService,
} from "../lib/todo-integration.ts";
import { formatStepSelection, parseStepSelection, type TodoItem } from "../plan-mode/utils.ts";

type Handler = (event: any, ctx: any) => unknown;

const planItems = (): TodoItem[] => [
	{ step: 1, text: "Capture the regression baseline", completed: false },
	{ step: 2, text: "Extract the domain model", completed: false },
	{ step: 3, text: "Run architecture verification", completed: false },
];

function createHarness(entries: any[] = [], todoService?: TodoIntegrationService) {
	const handlers = new Map<string, Handler[]>();
	const eventListeners = new Map<string, Array<(data: unknown) => void>>();
	const commands = new Map<string, Handler>();
	const stateEntries: any[] = [];
	const sentMessages: any[] = [];
	const sentUserMessages: Array<{ content: string; options?: Record<string, unknown> }> = [];
	const replacementEntries: any[] = [];
	const replacementPrompts: string[] = [];
	const selectResults: Array<string | undefined> = [];
	const inputResults: Array<string | undefined> = [];
	let activeTools = ["read", "bash", "edit", "write", "todo", "herdr_subagent", "herdr_worker"];

	const pi = {
		events: {
			on: (event: string, listener: (data: unknown) => void) => {
				eventListeners.set(event, [...(eventListeners.get(event) ?? []), listener]);
				return () => eventListeners.set(event, (eventListeners.get(event) ?? []).filter((item) => item !== listener));
			},
			emit: (event: string, data: unknown) => {
				for (const listener of eventListeners.get(event) ?? []) listener(data);
			},
		},
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

	if (todoService) {
		eventListeners.set(TODO_SERVICE_DISCOVER_EVENT, [(request: any) => request.accept(todoService)]);
	}

	const ctx = {
		hasUI: true,
		cwd: "/tmp/project",
		isIdle: () => true,
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
			getSessionId: () => "session-1",
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
		emitEvent: (event: string, data: unknown) => pi.events.emit(event, data),
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

test("captured plan steps create and retain linked file todos", async () => {
	const records = new Map<string, any>();
	let nextId = 1;
	const service: TodoIntegrationService = {
		async create(input) {
			const id = `0000000${nextId++}`;
			const record = {
				id,
				title: input.title,
				tags: input.tags ?? [],
				status: input.status ?? "open",
				createdAt: "2026-01-01T00:00:00.000Z",
				body: input.body ?? "",
			};
			records.set(id, record);
			return record;
		},
		async getMany(ids) {
			return ids.flatMap((id) => (records.has(id) ? [records.get(id)] : []));
		},
		async updateStatus(id, status) {
			const record = { ...records.get(id), status };
			records.set(id, record);
			return record;
		},
	};
	const h = createHarness([], service);
	h.selectResults.push("Stay in plan mode");
	await h.handlers.get("session_start")?.[0]?.({}, h.ctx);
	await h.commands.get("plan")?.("", h.ctx);
	await h.handlers.get("agent_end")?.[0]?.(
		{
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "Plan:\n1. Capture the baseline\n2. Extract the model" }],
				},
			],
		},
		h.ctx,
	);

	assert.equal(records.size, 2);
	assert.deepEqual(
		h.stateEntries.at(-1).todos.map((item: TodoItem) => item.todoId),
		["00000001", "00000002"],
	);
	assert.deepEqual(records.get("00000001").tags, ["plan-mode", "plan-step-1"]);

	// Re-emitting an unchanged/refined plan must retain links instead of duplicating todos.
	h.selectResults.push("Stay in plan mode");
	await h.handlers.get("agent_end")?.[0]?.(
		{
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "Plan:\n1. Capture the baseline\n2. Extract the model" }],
				},
			],
		},
		h.ctx,
	);
	assert.equal(records.size, 2);
});

test("plan completion closes linked todos and manual todo status changes update the plan", async () => {
	const records = new Map(
		planItems().map((item) => {
			const id = `0000000${item.step}`;
			return [
				id,
				{
					id,
					title: `${item.step}. ${item.text}`,
					tags: ["plan-mode"],
					status: "open",
					createdAt: "2026-01-01T00:00:00.000Z",
					body: "",
				},
			] as const;
		}),
	);
	const statusUpdates: string[] = [];
	const service: TodoIntegrationService = {
		async create() {
			throw new Error("unexpected create");
		},
		async getMany(ids) {
			return ids.flatMap((id) => (records.has(id) ? [records.get(id)!] : []));
		},
		async updateStatus(id, status) {
			statusUpdates.push(`${id}:${status}`);
			const record = { ...records.get(id)!, status };
			records.set(id, record);
			return record;
		},
	};
	const linkedItems = planItems();
	for (const item of linkedItems) item.todoId = `0000000${item.step}`;
	const h = createHarness(
		[
			{
				type: "custom",
				customType: "plan-mode",
				data: { enabled: false, todos: linkedItems, executing: true, executionSteps: [1], planText: "Plan" },
			},
		],
		service,
	);
	await h.handlers.get("session_start")?.[0]?.({}, h.ctx);
	await h.handlers.get("turn_end")?.[0]?.(
		{ message: { role: "assistant", content: [{ type: "text", text: "Done. [DONE:1]" }] } },
		h.ctx,
	);
	assert.deepEqual(statusUpdates, ["00000001:closed"]);

	h.emitEvent(TODO_CHANGED_EVENT, {
		cwd: "/tmp/project",
		action: "update",
		source: "tool",
		todo: { ...records.get("00000001"), status: "open" },
	});
	assert.equal(h.stateEntries.at(-1).todos[0].completed, false);
	h.emitEvent(TODO_CHANGED_EVENT, {
		cwd: "/tmp/project",
		action: "update",
		source: "tool",
		todo: { ...records.get("00000001"), status: "closed" },
	});
	assert.equal(h.stateEntries.at(-1).todos[0].completed, true);
});

test("implementation menu selects a range and exits plan mode before dispatch", async () => {
	const h = createHarness();
	h.selectResults.push("Implement in a fresh session (recommended)", "Enter a step range…");
	h.inputResults.push("1-2");

	await h.handlers.get("session_start")?.[0]?.({}, h.ctx);
	await h.commands.get("plan")?.("", h.ctx);
	assert.equal(h.activeTools().includes("bash"), false, "plan mode should disable implementation tools");
	assert.equal(h.activeTools().includes("herdr_worker"), false, "plan mode should disable fire-and-forget workers");

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
