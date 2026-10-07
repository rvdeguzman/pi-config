import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { getAgentDir, SessionManager } from "@earendil-works/pi-coding-agent";

const { default: euler } = await import("../euler.ts");

function harness() {
	const session = SessionManager.inMemory(process.cwd());
	const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
	const commands = new Map<string, any>();
	const sent: Array<{ text: string; options?: unknown }> = [];
	const statuses: Array<string | undefined> = [];
	euler({
		on: (event: string, handler: any) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerTool: () => undefined,
		registerMessageRenderer: () => undefined,
		getActiveTools: () => [],
		setActiveTools: () => undefined,
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
		await emit("before_agent_start", event);
		return event.systemPromptOptions.sections.euler;
	};
	async function emit(name: string, event: unknown) {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	}
	return { session, commands, sent, statuses, ctx, prompt, emit };
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
	const playbookDir = section!.match(/^Playbook directory: (.+)$/m)?.[1];
	assert.ok(playbookDir && existsSync(join(playbookDir, "bug.md")), "Euler can locate its playbooks");

	await commands.get("euler").handler("off", ctx);
	assert.equal(await prompt(), undefined);
	assert.equal(statuses.at(-1), undefined);
	assert.equal(sent.length, 1, "on/off toggles submit nothing");
});

test("approved preferences from /corrections reach the Euler prompt", async () => {
	const dir = join(getAgentDir(), "skills", "euler");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "preferences.md"), "- UIs are utility-first; no editorial copy.\n");
	try {
		const { commands, ctx, prompt } = harness();
		await commands.get("e").handler("", ctx);
		assert.match((await prompt())!, /## User preferences\n\n- UIs are utility-first; no editorial copy\./);
	} finally {
		rmSync(join(dir, "preferences.md"));
	}
});

test("Euler state follows the active session branch; abandoned branches do not leak into it", async () => {
	const { session, commands, ctx, prompt, emit } = harness();
	const root = session.appendMessage({ role: "user", content: "start", timestamp: 1 } as any);

	await commands.get("e").handler("", ctx);
	assert.ok(await prompt());

	session.branch(root); // e.g. /tree back to before /e
	await emit("session_tree", {});
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
