import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import minimalFooter, { formatFooter } from "../minimal-footer.ts";

test("renders the footer without cost", () => {
	const usage = {
		input: 1_700,
		output: 0,
		cacheRead: 98_300,
		cacheWrite: 0,
		reasoning: 0,
		totalTokens: 100_000,
		cost: { input: 1.158, output: 0, cacheRead: 0, cacheWrite: 0, total: 1.158 },
	};
	const ctx = {
		cwd: join(homedir(), ".pi", "agent"),
		model: { id: "gpt-5.6-sol", provider: "openai-codex", reasoning: true, contextWindow: 272_000 },
		thinkingLevel: "xhigh",
		modelRegistry: { isUsingOAuth: () => true },
		sessionManager: { getEntries: () => [{ type: "message", message: { role: "assistant", usage } }] },
		getContextUsage: () => ({ tokens: 84_864, contextWindow: 272_000, percent: 31.2 }),
	};

	const left = "CH98.3% (sub) 85k/272k 31.2%";
	const right = "⚡gpt-5.6-sol • xhigh";

	assert.deepEqual(formatFooter(ctx as never, 100, true), [
		"~/.pi/agent",
		left + " ".repeat(100 - visibleWidth(left) - visibleWidth(right)) + right,
	]);
});

test("redraws when fast mode changes", () => {
	const listeners = new Map<string, (data: unknown) => void>();
	const priorityListener = (enabled: unknown) => listeners.get("openai-codex-priority:changed")?.(enabled);
	let sessionStart: ((event: unknown, ctx: unknown) => void) | undefined;
	let footerFactory: ((tui: unknown, theme: unknown) => { dispose(): void }) | undefined;
	const pi = {
		events: {
			on: (channel: string, listener: (data: unknown) => void) => {
				listeners.set(channel, listener);
				return () => {};
			},
		},
		on: (event: string, handler: never) => {
			if (event === "session_start") sessionStart = handler;
		},
	};
	minimalFooter(pi as never);
	priorityListener(false);
	sessionStart?.({}, { mode: "tui", ui: { setFooter: (factory: never) => (footerFactory = factory) } });

	let renders = 0;
	const footer = footerFactory?.({ requestRender: () => renders++ }, { fg: (_color: string, text: string) => text });
	priorityListener(true);
	assert.equal(renders, 1);
	listeners.get("quota:changed")?.("cl 5h 12% · wk 19%");
	assert.equal(renders, 2);
	footer?.dispose();
});

test("shows lightning only when OpenAI Codex fast mode is on", () => {
	const ctx = {
		cwd: homedir(),
		model: { id: "gpt-5.6-sol", provider: "openai-codex", reasoning: false, contextWindow: 272_000 },
		modelRegistry: { isUsingOAuth: () => true },
		sessionManager: { getEntries: () => [] },
		getContextUsage: () => undefined,
	};

	const fastFooter = formatFooter(ctx as never, 106, true);
	assert.match(fastFooter[1], /⚡gpt-5\.6-sol$/);
	assert.ok(fastFooter.every((line) => visibleWidth(line) <= 106));
	assert.match(formatFooter(ctx as never, 100, false)[1], /gpt-5\.6-sol$/);
	assert.doesNotMatch(
		formatFooter({ ...ctx, model: { ...ctx.model, provider: "anthropic" } } as never, 100, true)[1],
		/⚡/,
	);
});
