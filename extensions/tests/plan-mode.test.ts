import assert from "node:assert/strict";
import test from "node:test";

import planModeExtension from "../plan-mode/index.ts";

type Handler = (event: any, ctx: any) => unknown;

test("implementation menu exits plan mode before dispatching its command", async () => {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, Handler>();
	const stateEntries: Array<{ enabled?: boolean }> = [];
	const sentUserMessages: Array<{ content: string; options: Record<string, unknown> }> = [];
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
		appendEntry: (_customType: string, data: { enabled?: boolean }) => stateEntries.push(data),
		sendMessage: () => undefined,
		sendUserMessage: (content: string, options: Record<string, unknown>) => {
			sentUserMessages.push({ content, options });
		},
		getSessionName: () => undefined,
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
			select: async () => "Implement in a fresh session (recommended)",
		},
		sessionManager: { getEntries: () => [] },
	};

	planModeExtension(pi as never);
	await handlers.get("session_start")?.[0]?.({}, ctx);
	await commands.get("plan")?.("", ctx);
	assert.equal(activeTools.includes("bash"), false, "plan mode should disable implementation tools");

	await handlers.get("agent_end")?.[0]?.(
		{
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "Plan:\n1. Update the implementation safely" }],
				},
			],
		},
		ctx,
	);

	assert.equal(activeTools.includes("bash"), true, "the menu must restore implementation tools immediately");
	assert.equal(stateEntries.at(-1)?.enabled, false, "disabled plan mode must be persisted before dispatch");
	assert.deepEqual(sentUserMessages, [
		{
			content: "/implement",
			options: { deliverAs: "followUp", expandPromptTemplates: true },
		},
	]);
});
