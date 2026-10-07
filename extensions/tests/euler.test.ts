import assert from "node:assert/strict";
import test from "node:test";

import { SessionManager } from "@earendil-works/pi-coding-agent";

const { default: euler } = await import("../euler.ts");

function harness() {
	const session = SessionManager.inMemory(process.cwd());
	const handlers = new Map<string, (event: any, ctx: any) => any>();
	const commands = new Map<string, any>();
	const sent: Array<{ text: string; options?: unknown }> = [];
	const statuses: Array<string | undefined> = [];
	euler({
		on: (event: string, handler: any) => handlers.set(event, handler),
		registerCommand: (name: string, definition: any) => commands.set(name, definition),
		appendEntry: (type: string, data: unknown) => session.appendCustomEntry(type, data),
		sendUserMessage: (text: string, options?: unknown) => sent.push({ text, options }),
	} as any);
	const ctx = {
		hasUI: true,
		isIdle: () => true,
		sessionManager: session,
		ui: { notify: () => undefined, setStatus: (_key: string, text?: string) => statuses.push(text), theme: { fg: (_c: string, t: string) => t } },
	};
	/** The Euler section the next agent run would get, if any. */
	const prompt = async () => {
		const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
		await handlers.get("before_agent_start")!(event, ctx);
		return event.systemPromptOptions.sections.euler;
	};
	return { session, commands, sent, statuses, ctx, prompt, handlers };
}

test("/e <task> turns Euler on for the branch and submits the task once; /euler off turns it off", async () => {
	const { commands, sent, statuses, ctx, prompt } = harness();
	assert.equal(await prompt(), undefined);

	await commands.get("e").handler("  tighten the footer layout ", ctx);
	assert.deepEqual(sent, [{ text: "tighten the footer layout", options: undefined }]);
	assert.equal(statuses.at(-1), "euler");
	const section = await prompt();
	assert.match(section!, /^# Euler/);
	assert.doesNotMatch(section!, /disable-model-invocation/, "frontmatter stays out of the prompt");

	await commands.get("euler").handler("off", ctx);
	assert.equal(await prompt(), undefined);
	assert.equal(statuses.at(-1), undefined);
	assert.equal(sent.length, 1, "on/off toggles submit nothing");
});

test("Euler state follows the active session branch; abandoned branches do not leak into it", async () => {
	const { session, commands, ctx, prompt, handlers } = harness();
	const root = session.appendMessage({ role: "user", content: "start", timestamp: 1 } as any);

	await commands.get("e").handler("", ctx);
	assert.ok(await prompt());

	session.branch(root); // e.g. /tree back to before /e
	await handlers.get("session_tree")!({}, ctx);
	assert.equal(await prompt(), undefined, "a sibling branch without the toggle is plain");

	await commands.get("e").handler("", ctx);
	await commands.get("e").handler("off", ctx);
	const offLeaf = session.getLeafId()!;
	session.branch(root);
	await commands.get("e").handler("", ctx);
	assert.ok(await prompt());
	session.branch(offLeaf);
	assert.equal(await prompt(), undefined, "returning to the branch that turned Euler off keeps it off");
});
