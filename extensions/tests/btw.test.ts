import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as timers from "node:timers/promises";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider, fauxToolCall, type Api, type AssistantMessage, type AssistantMessageEventStream, type Context, type Model, type ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { getAgentDir, initTheme, ModelRuntime, SessionManager, type ExtensionAPI, type LoadExtensionsResult, type ExtensionCommandContext, type ExtensionContext, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CURSOR_MARKER, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import btw, { legacyBtwTopic } from "../btw.ts";
import { BtwHistory, BtwSession, btwBranchReason, createBtwBranch, snapshotBtw, streamEngine, type BtwEngine, type BtwSnapshot, type BtwTopic } from "../lib/btw-session.ts";
import { agentEngine, approvalGate, btwToolNames, filterBtwExtensions, loadBtwConfig, pluginName, saveBtwConfig } from "../lib/btw-agent.ts";
import { BtwDialog, type BtwDialogResult } from "../lib/btw-ui.ts";

initTheme("dark", false);
const model = { id: "test-model", provider: "test-provider", api: "openai-responses" } as Model<Api>;
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const key = { enter: "\r", esc: "\x1b", up: "\x1b[A", down: "\x1b[B", end: "\x1b[F", home: "\x1b[H" };
const usage = { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function answer(text = "side answer"): AssistantMessage {
	return { role: "assistant", content: [{ type: "text", text, textSignature: "opaque-signature" }], api: model.api, provider: model.provider, model: model.id, responseId: "opaque-response-id", usage, stopReason: "stop", timestamp: 100 };
}
function context(manager = SessionManager.inMemory()): ExtensionCommandContext {
	return { sessionManager: manager, model, thinkingLevel: "high", getSystemPrompt: () => "main instructions", isIdle: () => true, hasPendingMessages: () => false } as unknown as ExtensionCommandContext;
}
function settled(session: BtwSession): Promise<void> {
	if (!session.busy) return Promise.resolve();
	const done = Promise.withResolvers<void>();
	const unsubscribe = session.subscribe(() => { if (!session.busy) { unsubscribe(); done.resolve(); } });
	return done.promise;
}
function controlled(): ControlledRequest {
	const ready = Promise.withResolvers<{ context: Context; options: ModelsSimpleStreamOptions }>();
	const events = createAssistantMessageEventStream();
	const stream = (_model: Model<Api>, context: Context, options: ModelsSimpleStreamOptions) => { ready.resolve({ context, options }); return events; };
	return {
		ready: ready.promise, events, stream, engine: streamEngine(stream),
		delta: (text: string) => events.push({ type: "text_delta", contentIndex: 0, delta: text, partial: { ...answer(text), stopReason: "pending" } }),
		finish: (message = answer()) => events.push({ type: "done", reason: message.stopReason === "length" ? "length" : "stop", message }),
	};
}
const instructions = "Answer only; never call tools.";

async function complete(session: BtwSession, snapshot: BtwSnapshot, question = "side question", topicId?: string): Promise<BtwTopic> {
	const request = controlled();
	const topic = session.ask(snapshot, question, instructions, request.engine, topicId);
	await request.ready;
	request.finish();
	await settled(session);
	return topic;
}

test("side calls see projected context and visible in-flight text, without replaying partial signatures or executing tools", async () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "system", content: "main instructions", toolsAdded: [{ name: "write", description: "writes files", parameters: Type.Object({}) }], timestamp: 1 });
	manager.appendMessage({ role: "user", content: "old material", timestamp: 2 });
	const kept = manager.appendMessage({ role: "user", content: "wrong material", timestamp: 3 });
	manager.appendCompaction("older work summarized", kept, 100);
	manager.appendContextEdit(kept, { content: "corrected material" });
	const before = structuredClone(manager.getEntries());
	const streaming = { ...answer("currently streaming"), content: [{ type: "thinking" as const, thinking: "reasoning", thinkingSignature: "signed" }, { type: "text" as const, text: "currently streaming" }, { type: "toolCall" as const, id: "unexecuted", name: "write", arguments: {} }] };
	const snapshot = snapshotBtw(context(manager), streaming);
	const session = new BtwSession(snapshot.sessionId, new BtwHistory());
	const request = controlled();
	session.ask(snapshot, "what does that mean?", instructions, request.engine);
	const sent = await request.ready;
	assert.equal(sent.options.toolChoice, "none");
	assert.equal(sent.options.reasoning, "high");
	assert.notEqual(sent.options.sessionId, snapshot.sessionId);
	assert.match(JSON.stringify(sent.context.messages), /older work summarized/);
	assert.match(JSON.stringify(sent.context.messages), /corrected material/);
	assert.doesNotMatch(JSON.stringify(sent.context.messages), /old material|wrong material|unexecuted/);
	assert.match(JSON.stringify(sent.context.messages), /currently streaming/);
	assert.doesNotMatch(JSON.stringify(sent.context.messages), /signed|opaque-signature|opaque-response-id/);
	assert.equal(sent.context.messages[0].role, "system");
	assert.deepEqual(sent.context.messages.at(-1)?.content, "what does that mean?");
	const toolReply = { ...answer(), content: [{ type: "toolCall" as const, id: "leak", name: "write", arguments: {} }] };
	request.delta("partial answer");
	request.finish(toolReply);
	await settled(session);
	assert.equal(session.topics[0].turns[0].status, "error");
	assert.match(session.topics[0].turns[0].error!, /No tools were executed/);
	assert.equal(session.topics[0].turns[0].answer, "partial answer");
	assert.deepEqual(manager.getEntries(), before);
});

test("context snapshots are detached so later main edits cannot change an accepted side request", () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: "original", timestamp: 1 });
	const snapshot = snapshotBtw(context(manager));
	const message = manager.getLeafEntry();
	assert.equal(message?.type, "message");
	if (message?.type === "message" && message.message.role === "user") message.message.content = "mutated";
	assert.equal(snapshot.messages.at(-1)?.content, "original");
});

test("follow-ups replay only their own topic, not provider signatures or another topic", async () => {
	const snapshot = snapshotBtw(context());
	const session = new BtwSession(snapshot.sessionId, new BtwHistory());
	const first = await complete(session, snapshot, "first topic");
	await complete(session, snapshot, "unrelated topic");
	const request = controlled();
	session.ask(snapshot, "follow-up", instructions, request.engine, first.id);
	const sent = await request.ready;
	assert.match(JSON.stringify(sent.context.messages), /first topic|side answer|follow-up/);
	assert.doesNotMatch(JSON.stringify(sent.context.messages), /unrelated topic|opaque-signature|opaque-response-id/);
	assert.deepEqual(sent.context.messages.at(-1)?.content, "follow-up");
	request.finish();
	await settled(session);
	assert.equal(first.turns.length, 2);
});

test("cancellation retains partial output immediately and prevents reuse until old forwarding stops", async () => {
	const snapshot = snapshotBtw(context());
	const session = new BtwSession(snapshot.sessionId, new BtwHistory());
	const request = controlled();
	const topic = session.ask(snapshot, "question", instructions, request.engine);
	await request.ready;
	const delta = Promise.withResolvers<void>();
	const unsubscribe = session.subscribe(() => { if (topic.turns[0].answer) delta.resolve(); });
	request.delta("kept partial");
	await delta.promise;
	session.cancel();
	assert.equal(topic.turns[0].status, "cancelled");
	assert.equal(session.busy, true);
	assert.throws(() => session.ask(snapshot, "too early", instructions, request.engine), /still answering/);
	request.delta("late nonterminal event");
	await timers.setImmediate();
	assert.equal(session.busy, true);
	assert.equal(topic.turns[0].answer, "kept partial");
	request.finish(answer("late replacement"));
	await settled(session);
	assert.equal(topic.turns[0].status, "cancelled");
	assert.equal(topic.turns[0].answer, "kept partial");
	assert.equal(topic.turns[0].assistant, undefined);
	unsubscribe();
	await session.dispose();
	assert.throws(() => session.ask(snapshot, "after dispose", instructions, request.engine), /closed/);
});

test("a synchronous auth failure and an empty provider stream surface errors, not successful blank answers", async () => {
	const snapshot = snapshotBtw(context());
	const session = new BtwSession(snapshot.sessionId, new BtwHistory());
	const failed = session.ask(snapshot, "question", instructions, streamEngine(() => { throw new Error("auth unavailable"); }));
	await settled(session);
	assert.equal(failed.turns[0].status, "error");
	assert.equal(failed.turns[0].error, "auth unavailable");
	const request = controlled();
	const empty = session.ask(snapshot, "second", instructions, request.engine);
	await request.ready;
	request.events.end();
	await settled(session);
	assert.equal(empty.turns[0].status, "error");
	assert.match(empty.turns[0].error!, /without a final reply/);
});

test("overlapping side questions are rejected without recording a phantom topic", async () => {
	const snapshot = snapshotBtw(context());
	const session = new BtwSession(snapshot.sessionId, new BtwHistory());
	const request = controlled();
	session.ask(snapshot, "first", instructions, request.engine);
	assert.throws(() => session.ask(snapshot, "second", instructions, request.engine), /still answering/);
	assert.equal(session.topics.length, 1);
	session.cancel();
	await settled(session);
});

test("private history round-trips partial replies and refuses stale concurrent writes", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "btw-history-test-"));
	try {
		const snapshot = snapshotBtw(context());
		const history = new BtwHistory(root);
		const session = new BtwSession(snapshot.sessionId, history);
		const topic = await complete(session, snapshot);
		const [restored] = await history.load(snapshot.sessionId);
		assert.equal(restored.turns[0].answer, "side answer");
		assert.equal(restored.turns[0].assistant?.responseId, "opaque-response-id");
		const stale = structuredClone(restored);
		restored.turns[0].answer = "newer saved answer";
		await history.save(restored);
		stale.turns[0].answer = "stale answer";
		await assert.rejects(history.save(stale), /another Pi process/);
		assert.equal((await history.load(snapshot.sessionId))[0].turns[0].answer, "newer saved answer");
		const file = path.join(root, `session-${encodeURIComponent(snapshot.sessionId)}`, `topic-${topic.id}`, `${topic.revision}.json`);
		assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
		restored.turns[0].status = "running";
		restored.turns[0].answer = "interrupted partial";
		await history.save(restored);
		const [interrupted] = await history.load(snapshot.sessionId);
		assert.equal(interrupted.turns[0].status, "cancelled");
		assert.equal(interrupted.turns[0].answer, "interrupted partial");
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("a failed terminal save keeps the completed answer visibly unsaved", async () => {
	class FailingHistory extends BtwHistory {
		calls = 0;
		async save(_topic: BtwTopic): Promise<void> { if (++this.calls > 1) throw new Error("disk full"); }
	}
	const snapshot = snapshotBtw(context());
	const session = new BtwSession(snapshot.sessionId, new FailingHistory());
	const topic = await complete(session, snapshot);
	assert.equal(topic.turns[0].status, "complete");
	assert.equal(topic.turns[0].answer, "side answer");
	assert.equal(session.storageError, "disk full");
});

test("promotion preserves original compaction/edit entry IDs and native Q&A without modifying the source", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btw-branch-test-"));
	try {
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage({ role: "system", content: "main instructions", timestamp: 1 });
		const user = manager.appendMessage({ role: "user", content: "original context", timestamp: 2 });
		manager.appendMessage(answer("original assistant"));
		manager.appendCompaction("saved summary", user, 10);
		manager.appendContextEdit(user, { content: "edited context" });
		const ctx = context(manager);
		const snapshot = snapshotBtw(ctx);
		const topic = await complete(new BtwSession(snapshot.sessionId, new BtwHistory()), snapshot);
		const source = manager.getSessionFile()!;
		const bytes = await fs.readFile(source, "utf8");
		const branchFile = createBtwBranch(ctx, topic);
		assert.notEqual(branchFile, source);
		assert.equal(await fs.readFile(source, "utf8"), bytes);
		const branch = SessionManager.open(branchFile);
		assert.equal(branch.getHeader()?.parentSession, source);
		assert.deepEqual(branch.getBranch().slice(0, manager.getBranch().length), SessionManager.open(source, dir).getBranch());
		const messages = branch.buildSessionProjection().messages;
		assert.equal(messages.at(-2)?.role, "user");
		assert.deepEqual(messages.at(-2)?.content, "side question");
		assert.deepEqual(messages.at(-1), topic.turns[0].assistant);
		assert.match(JSON.stringify(messages), /saved summary|edited context/);
		manager.appendMessage({ role: "user", content: "main moved", timestamp: 3 });
		assert.match(btwBranchReason(ctx, topic)!, /moved/);
		assert.throws(() => createBtwBranch(ctx, topic), /moved/);
	} finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("promotion refuses multi-turn, truncated, cancelled and active-main answers", async () => {
	const snapshot = snapshotBtw(context());
	const topic = await complete(new BtwSession(snapshot.sessionId, new BtwHistory()), snapshot);
	const ctx = { ...context(), sessionManager: { getSessionId: () => topic.sessionId, getLeafId: () => "leaf", getSessionFile: () => "/saved" } } as unknown as ExtensionCommandContext;
	topic.leafId = "leaf";
	assert.equal(btwBranchReason(ctx, topic), undefined);
	assert.match(btwBranchReason({ ...ctx, isIdle: () => false }, topic)!, /idle/);
	topic.turns[0].assistant!.stopReason = "length";
	assert.match(btwBranchReason(ctx, topic)!, /non-truncated/);
	topic.turns[0].assistant!.stopReason = "stop";
	topic.turns.push(structuredClone(topic.turns[0]));
	assert.match(btwBranchReason(ctx, topic)!, /Multi-turn/);
	topic.turns.pop(); topic.turns[0].status = "cancelled";
	assert.match(btwBranchReason(ctx, topic)!, /completed/);
});

function dialog(session: BtwSession, topicId?: string) {
	let result: BtwDialogResult | undefined;
	const sent: string[] = [];
	const copied: string[] = [];
	const tui = { terminal: { rows: 30 }, requestRender() {} } as unknown as TUI;
	const ui = new BtwDialog(session, tui, theme, {
		ask: (question, id) => { sent.push(question); return session.ask({ ...snapshotBtw(context()), sessionId: session.sessionId }, question, instructions, controlled().engine, id); },
		copy: async text => { copied.push(text); }, branchReason: () => "Main moved; cannot branch.",
	}, value => { result = value; }, topicId);
	ui.focused = true;
	return { ui, sent, copied, result: () => result };
}

test("reader keys copy, select history, and refuse unsafe branching without injecting anything", async () => {
	const snapshot = snapshotBtw(context());
	const session = new BtwSession(snapshot.sessionId, new BtwHistory());
	const topic = await complete(session, snapshot);
	const view = dialog(session);
	view.ui.handleInput(key.enter);
	view.ui.handleInput("c");
	assert.deepEqual(view.copied, ["side answer"]);
	view.ui.handleInput("b");
	assert.match(view.ui.render(80).join("\n"), /cannot branch/);
	assert.equal(view.result(), undefined);
	view.ui.handleInput("h");
	assert.match(view.ui.render(80).join("\n"), /history/);
	view.ui.handleInput(key.enter);
	assert.equal(view.ui.topic?.id, topic.id);
	view.ui.handleInput(key.esc);
	assert.deepEqual(view.result(), { action: "close" });
});

test("editor letters type normally and Esc retains expanded pasted drafts without sending", async () => {
	const snapshot = snapshotBtw(context());
	const session = new BtwSession(snapshot.sessionId, new BtwHistory());
	const topic = await complete(session, snapshot);
	const view = dialog(session, topic.id);
	view.ui.handleInput("f");
	for (const char of "cfbhnx") view.ui.handleInput(char);
	const paste = "pasted line\n".repeat(30);
	view.ui.handleInput(`\x1b[200~${paste}\x1b[201~`);
	view.ui.handleInput(key.esc);
	assert.deepEqual(view.sent, []);
	view.ui.handleInput("f");
	view.ui.handleInput(key.enter);
	assert.deepEqual(view.sent, [`cfbhnx${paste}`.trimEnd()]);
	session.cancel(); await settled(session); view.ui.close();
});

test("narrow readers/editors sanitize terminal output, bound line widths and preserve cursor positioning", async () => {
	const snapshot = snapshotBtw(context());
	const session = new BtwSession(snapshot.sessionId, new BtwHistory());
	const topic = await complete(session, snapshot);
	topic.turns[0].answer = "\x1b[2Junsafe\t界🙂\x07";
	const view = dialog(session, topic.id);
	for (const width of [1, 2, 3, 8, 20, 80]) {
		const lines = view.ui.render(width);
		assert.ok(lines.every(line => visibleWidth(line) <= width));
		assert.ok(lines.every(line => !line.includes("\x1b[2J") && !line.includes("\t") && !line.includes("\x07")));
	}
	view.ui.handleInput("f"); view.ui.handleInput("界");
	for (const width of [1, 2, 3, 8, 20, 80]) assert.ok(view.ui.render(width).every(line => visibleWidth(line) <= width));
	assert.ok(view.ui.render(80).some(line => line.includes(CURSOR_MARKER)));
	view.ui.close();
});

test("legacy thread migration honors reset and preserves Q&A without adding it to main context", () => {
	const manager = SessionManager.inMemory();
	manager.appendCustomEntry("btw-thread-entry", { question: "discarded", answer: "old", timestamp: 1 });
	manager.appendCustomEntry("btw-thread-reset", { timestamp: 2 });
	manager.appendCustomEntry("btw-thread-entry", { question: "kept", answer: "saved", timestamp: 3 });
	const before = structuredClone(manager.getEntries());
	const migrated = legacyBtwTopic(context(manager));
	assert.deepEqual(migrated?.turns.map(turn => [turn.question, turn.answer]), [["kept", "saved"]]);
	assert.deepEqual(manager.getEntries(), before);
	assert.equal(manager.buildSessionProjection().messages.length, 0);
});

test("non-terminal BTW refuses custom UI and model work even when an RPC client has dialogs", async () => {
	let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	btw({ registerCommand: (name: string, command: { handler: typeof handler }) => { if (name === "btw") handler = command.handler; }, on: () => {} } as unknown as ExtensionAPI);
	assert.ok(handler);
	const notifications: string[] = [];
	const ctx = { mode: "rpc", hasUI: true, ui: { notify: (message: string) => notifications.push(message), custom: () => { throw new Error("RPC custom UI must not run"); } } } as unknown as ExtensionCommandContext;
	await handler("question", ctx);
	assert.match(notifications[0], /interactive terminal/);
});

test("a finalized main candidate fills the message_end persistence gap, but cannot resurrect edited-away context", () => {
	const manager = SessionManager.inMemory();
	const final = answer("latest main answer");
	const ctx = context(manager);
	assert.match(JSON.stringify(snapshotBtw(ctx, final).messages), /latest main answer/);
	const id = manager.appendMessage(final);
	assert.equal(snapshotBtw(ctx, final).messages.filter(message => message.role === "assistant").length, 1);
	manager.appendContextEdit(id, null);
	assert.doesNotMatch(JSON.stringify(snapshotBtw(ctx, final).messages), /latest main answer/);
	const reasoningOnly = { ...answer(), responseId: "not-persisted", content: [{ type: "thinking" as const, thinking: "partial", thinkingSignature: "unsafe-replay" }] };
	assert.doesNotMatch(JSON.stringify(snapshotBtw(ctx, reasoningOnly).messages), /partial|unsafe-replay/);
});

test("immutable history commits admit only one concurrent revision and ignore abandoned temporary writes", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "btw-revision-test-"));
	try {
		const snapshot = snapshotBtw(context());
		const history = new BtwHistory(root);
		const topic = await complete(new BtwSession(snapshot.sessionId, history), snapshot);
		const first = structuredClone(topic), second = structuredClone(topic);
		first.turns[0].answer = "first writer"; second.turns[0].answer = "second writer";
		const writes = await Promise.allSettled([history.save(first), history.save(second)]);
		assert.equal(writes.filter(result => result.status === "fulfilled").length, 1);
		assert.equal(writes.filter(result => result.status === "rejected").length, 1);
		const dir = path.join(root, `session-${encodeURIComponent(snapshot.sessionId)}`, `topic-${topic.id}`);
		await fs.writeFile(path.join(dir, "abandoned.tmp"), "partial write");
		const [restored] = await history.load(snapshot.sessionId);
		assert.ok(["first writer", "second writer"].includes(restored.turns[0].answer));
		assert.equal(restored.revision, topic.revision + 1);
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("a damaged topic leaves healthy history and fresh questions usable without overwriting the damaged file", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "btw-damaged-test-"));
	try {
		const snapshot = snapshotBtw(context());
		const history = new BtwHistory(root);
		const session = new BtwSession(snapshot.sessionId, history);
		const healthy = await complete(session, snapshot, "healthy question");
		const dir = path.join(root, `session-${encodeURIComponent(snapshot.sessionId)}`, "topic-damaged");
		await fs.mkdir(dir);
		const file = path.join(dir, "1.json");
		await fs.writeFile(file, "{broken");
		const next = new BtwSession(snapshot.sessionId, new BtwHistory(root));
		await next.load();
		assert.equal(next.topics[0].id, healthy.id);
		assert.match(next.history.warnings[0], /damaged/);
		assert.equal((await complete(next, snapshot, "new question")).turns[0].status, "complete");
		assert.equal(await fs.readFile(file, "utf8"), "{broken");
	} finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("unsaved answers remain flagged across another successful topic and can be retried before disposal", async () => {
	class RecoverableHistory extends BtwHistory {
		calls = 0;
		allow = false;
		saved: BtwTopic[] = [];
		async save(topic: BtwTopic): Promise<void> {
			if (++this.calls > 1 && !this.allow) throw new Error("disk full");
			this.saved.push(structuredClone(topic));
		}
	}
	const snapshot = snapshotBtw(context());
	const history = new RecoverableHistory();
	const session = new BtwSession(snapshot.sessionId, history);
	const first = await complete(session, snapshot, "unsaved answer");
	assert.equal(session.unsavedTopics[0].id, first.id);
	history.allow = true;
	await complete(session, snapshot, "second topic");
	assert.equal(session.storageError, "disk full");
	await session.dispose();
	assert.equal(session.storageError, undefined);
	assert.equal(history.saved.findLast(topic => topic.id === first.id)?.turns[0].answer, "side answer");
});

test("rejected pasted submissions restore the editor rather than erasing the user's question", () => {
	const session = new BtwSession("session", new BtwHistory());
	const submissions: string[] = [];
	const ui = new BtwDialog(session, { terminal: { rows: 30 }, requestRender() {} } as unknown as TUI, theme, {
		ask: text => { submissions.push(text); throw new Error("No model selected"); }, copy: async () => {}, branchReason: () => undefined,
	}, () => {});
	ui.focused = true; ui.handleInput("n");
	const text = "large pasted question\n".repeat(30).trimEnd();
	ui.handleInput(`\x1b[200~${text}\x1b[201~`);
	ui.handleInput(key.enter);
	assert.match(ui.render(80).join("\n"), /No model selected/);
	ui.handleInput(key.enter);
	assert.deepEqual(submissions, [text, text]);
	ui.close();
});

function extensionHarness(manager = SessionManager.inMemory()) {
	let handler!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	const listeners = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	btw({
		registerCommand: (name: string, command: { handler: typeof handler }) => { if (name === "btw") handler = command.handler; },
		on: (name: string, listener: (event: unknown, ctx: ExtensionContext) => unknown) => { listeners.set(name, listener); },
	} as unknown as ExtensionAPI);
	const requests: ControlledRequest[] = [];
	const opens = Array.from({ length: 3 }, () => Promise.withResolvers<BtwDialog>());
	let openCount = 0;
	const notices: string[] = [];
	if (!manager.getLeafId()) manager.appendMessage({ role: "user", content: "main context", timestamp: 1 });
	const ctx = { ...context(manager), mode: "tui", hasUI: true, isIdle: () => false,
		modelRegistry: { streamSimple: (chosen: Model<Api>, request: Context, options: ModelsSimpleStreamOptions) => {
			const controlledRequest = controlled(); requests.push(controlledRequest);
			return controlledRequest.stream(chosen, request, options);
		} },
		ui: { notify: (text: string) => { notices.push(text); }, custom: async <T>(factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (value: T) => void) => Component): Promise<T> => {
			const done = Promise.withResolvers<T>();
			const dialog = factory({ terminal: { rows: 30 }, requestRender() {} } as unknown as TUI, theme, {} as KeybindingsManager, done.resolve);
			assert.ok(dialog instanceof BtwDialog); dialog.focused = true; opens[openCount++].resolve(dialog);
			return done.promise;
		} },
	} as unknown as ExtensionCommandContext;
	return { handler, ctx, manager, requests, opens, notices, openCount: () => openCount, listeners };
}
interface ControlledRequest {
	ready: Promise<{ context: Context; options: ModelsSimpleStreamOptions }>;
	events: AssistantMessageEventStream;
	stream(model: Model<Api>, context: Context, options: ModelsSimpleStreamOptions): AssistantMessageEventStream;
	engine: BtwEngine;
	delta(text: string): void;
	finish(message?: AssistantMessage): void;
}

test("concurrent command invocations reserve one dialog before asynchronous loading", async () => {
	const harness = extensionHarness();
	const first = harness.handler("first question", harness.ctx);
	await harness.handler("second question", harness.ctx);
	const view = await harness.opens[0].promise;
	assert.equal(harness.openCount(), 1);
	assert.match(harness.notices[0], /already open/);
	await harness.requests[0].ready;
	harness.requests[0].finish(); await settled(view.session);
	view.close(); await first;
	assert.equal(harness.openCount(), 1);
	assert.equal(view.session.topics.length, 1);
});

test("hiding returns to the main task while a side answer continues, and reopening history does not make another request", async () => {
	const harness = extensionHarness();
	const before = structuredClone(harness.manager.getEntries());
	const command = harness.handler("side question while main runs", harness.ctx);
	const view = await harness.opens[0].promise;
	assert.equal(view.session.busy, true);
	assert.match(JSON.stringify((await harness.requests[0].ready).context.messages), /main context/);
	view.handleInput("x"); await command;
	assert.equal(view.session.busy, true);
	harness.requests[0].finish(); await settled(view.session);
	const reopen = harness.handler("", harness.ctx);
	const history = await harness.opens[1].promise;
	assert.match(history.render(80).join("\n"), /history/);
	assert.equal(harness.requests.length, 1);
	history.handleInput(key.enter);
	assert.match(history.render(80).join("\n"), /side answer/);
	history.close(); await reopen;
	assert.deepEqual(harness.manager.getEntries(), before);
	await harness.listeners.get("session_shutdown")!({}, harness.ctx);
});

test("session navigation cancels side work, retains partial output and closes the old overlay", async () => {
	const harness = extensionHarness();
	const command = harness.handler("side question", harness.ctx);
	const view = await harness.opens[0].promise;
	await harness.requests[0].ready;
	const delta = Promise.withResolvers<void>();
	const unsubscribe = view.session.subscribe(() => { if (view.session.topics[0].turns[0].answer) delta.resolve(); });
	harness.requests[0].delta("partial before switch"); await delta.promise;
	const transition = harness.listeners.get("session_before_switch")!({}, harness.ctx);
	assert.equal(view.session.topics[0].turns[0].status, "cancelled");
	harness.requests[0].finish(answer("ignored late answer"));
	assert.equal(await transition, undefined);
	await command;
	assert.equal(view.session.topics[0].turns[0].answer, "partial before switch");
	assert.equal(view.session.busy, false);
	unsubscribe();
});

test("session movement is refused while answers are unsaved, then succeeds after retry", async t => {
	const harness = extensionHarness();
	const command = harness.handler("side question", harness.ctx);
	const view = await harness.opens[0].promise;
	await harness.requests[0].ready;
	harness.requests[0].finish(); await settled(view.session);
	const topic = view.session.topics[0];
	t.mock.method(view.session.history, "save", async () => { throw new Error("disk unavailable"); });
	await assert.rejects(view.session.retrySave(topic.id), /disk unavailable/);
	assert.deepEqual(await harness.listeners.get("session_before_switch")!({}, harness.ctx), { cancel: true });
	assert.match(harness.notices.at(-1)!, /unsaved answers/);
	assert.match(view.render(80).join("\n"), /side answer/);
	t.mock.restoreAll();
	await view.session.retrySave(topic.id);
	assert.equal(await harness.listeners.get("session_before_switch")!({}, harness.ctx), undefined);
	await command;
});

test("reload retains unsaved answers in a fresh controller and shutdown writes a private recovery copy", async t => {
	const harness = extensionHarness();
	const command = harness.handler("preserve through reload", harness.ctx);
	const view = await harness.opens[0].promise;
	await harness.requests[0].ready;
	harness.requests[0].finish(); await settled(view.session);
	t.mock.method(view.session.history, "save", async () => { throw new Error("disk unavailable"); });
	await assert.rejects(view.session.retrySave(view.session.topics[0].id), /disk unavailable/);
	await harness.listeners.get("session_shutdown")!({}, harness.ctx);
	await command;
	const notice = harness.notices.find(message => message.includes("Recovery copy:"));
	assert.ok(notice);
	const file = notice.split("Recovery copy: ")[1];
	try {
		assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
		assert.match(await fs.readFile(file, "utf8"), /side answer/);
		const reloaded = extensionHarness(harness.manager);
		const reopen = reloaded.handler("", reloaded.ctx);
		const history = await reloaded.opens[0].promise;
		history.handleInput(key.enter);
		assert.match(history.render(80).join("\n"), /side answer/);
		assert.match(history.session.storageError!, /Recovered an unsaved answer/);
		await history.session.retrySave(history.session.topics[0].id);
		assert.equal(history.session.storageError, undefined);
		history.close(); await reopen;
	} finally { await fs.rm(path.dirname(file), { recursive: true, force: true }); }
});

test("retrying a save reserves topic mutation, so an older save cannot clear a newer failed follow-up", async () => {
	class ControlledHistory extends BtwHistory {
		fail = false;
		gate?: Promise<void>;
		async save(_topic: BtwTopic): Promise<void> { if (this.gate) await this.gate; if (this.fail) throw new Error("disk full"); }
	}
	const snapshot = snapshotBtw(context());
	const history = new ControlledHistory();
	const session = new BtwSession(snapshot.sessionId, history);
	const topic = await complete(session, snapshot);
	history.fail = true;
	await assert.rejects(session.retrySave(topic.id), /disk full/);
	history.fail = false;
	const gate = Promise.withResolvers<void>(); history.gate = gate.promise;
	const retry = session.retrySave(topic.id);
	assert.equal(session.busy, true);
	assert.throws(() => session.ask(snapshot, "racing follow-up", instructions, controlled().engine, topic.id), /still answering/);
	assert.equal(topic.turns.length, 1);
	gate.resolve(); await retry; history.gate = undefined;
	const request = controlled();
	session.ask(snapshot, "accepted follow-up", instructions, request.engine, topic.id);
	await request.ready;
	history.fail = true; request.finish(answer("newest unsaved answer")); await settled(session);
	assert.equal(session.storageError, "disk full");
	assert.equal(session.unsavedTopics[0].turns.at(-1)?.answer, "newest unsaved answer");
});

test("provider resource cleanup failures release ownership and leave unsaved data available to shutdown recovery", async () => {
	class FailedHistory extends BtwHistory {
		calls = 0;
		async save(_topic: BtwTopic): Promise<void> { if (++this.calls > 1) throw new Error("disk full"); }
	}
	const snapshot = snapshotBtw(context());
	const session = new BtwSession(snapshot.sessionId, new FailedHistory(), () => { throw new AggregateError([new Error("socket failure")], "cleanup failed"); });
	await complete(session, snapshot);
	assert.equal(session.busy, false);
	assert.equal(session.cleanupError, "cleanup failed");
	assert.throws(() => session.ask(snapshot, "new question", instructions, controlled().engine), /cleanup failed.*reload/);
	await session.dispose();
	assert.equal(session.unsavedTopics[0].turns[0].answer, "side answer");
});

test("Esc cancels once, then closes the reader while cancelled transport cleanup still owns the request", async () => {
	const snapshot = snapshotBtw(context());
	const session = new BtwSession(snapshot.sessionId, new BtwHistory());
	const request = controlled();
	const topic = session.ask(snapshot, "question", instructions, request.engine);
	await request.ready;
	const view = dialog(session, topic.id);
	view.ui.handleInput(key.esc);
	assert.equal(topic.turns[0].status, "cancelled");
	assert.equal(session.busy, true);
	view.ui.handleInput(key.esc);
	assert.deepEqual(view.result(), { action: "close" });
	request.finish(); await settled(session);
});

test("plugin config validates, saves privately, and names packages/local plugins stably", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btw-config-test-"));
	try {
		const file = path.join(dir, "btw.json");
		assert.deepEqual(await loadBtwConfig(file), { allow: [], trust: [] });
		await saveBtwConfig({ allow: ["pi-exa", "read"], trust: ["web_search_exa"] }, file);
		assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
		assert.deepEqual(await loadBtwConfig(file), { allow: ["pi-exa", "read"], trust: ["web_search_exa"] });
		await fs.writeFile(file, JSON.stringify({ allow: "pi-exa" }));
		await assert.rejects(loadBtwConfig(file), /"allow" must be an array/);
	} finally { await fs.rm(dir, { recursive: true, force: true }); }
	const named = (source: string, file: string) => pluginName({ path: file, sourceInfo: { source, path: file, scope: "user", origin: "package" } });
	assert.equal(named("npm:pi-exa", "/n/pi-exa/src/index.ts"), "pi-exa");
	assert.equal(named("npm:@earendil-works/pi-voice", "/n/pi-voice/index.ts"), "pi-voice");
	assert.equal(named("git:github.com/mitsuhiko/agent-stuff@122e299", "/g/extensions/files.ts"), "agent-stuff");
	assert.equal(named("auto", "/a/extensions/openai-codex-priority/index.ts"), "openai-codex-priority");
	assert.equal(named("auto", "/a/extensions/herdr-subagent.ts"), "herdr-subagent");
});

test("only allowlisted plugins load; BTW itself and provider plugins never do, and built-ins need explicit allow", () => {
	const extension = (file: string, tools: string[] = []) => ({ path: file, resolvedPath: file, sourceInfo: { source: "auto", path: file, scope: "user", origin: "top-level" }, tools: new Map(tools.map(name => [name, {}])) });
	const base = {
		extensions: [extension("/x/pi-exa.ts", ["web_search_exa"]), extension("/x/minimal-footer.ts"), extension("/x/btw.ts"), extension("/x/oauth.ts", ["oauth_tool"]), extension("<inline:btw-approval>")],
		errors: [], runtime: { pendingProviderRegistrations: [{ name: "anthropic", config: {}, extensionPath: "/x/oauth.ts" }], pendingNativeProviderRegistrations: [] },
	} as unknown as LoadExtensionsResult;
	const kept = filterBtwExtensions(base, ["pi-exa", "btw", "oauth", "read"], "/x/btw.ts");
	assert.deepEqual(kept.extensions.map(item => item.path), ["/x/pi-exa.ts", "<inline:btw-approval>"]);
	assert.deepEqual(base.runtime.pendingProviderRegistrations, []);
	assert.deepEqual(btwToolNames(["pi-exa", "read"], kept), ["read", "web_search_exa"]);
	assert.deepEqual(btwToolNames(["pi-exa"], kept), ["web_search_exa"]);
});

test("approval gate: read-only and trusted tools run; others wait for an explicit decision", async () => {
	let handler!: (event: { toolName: string; input: unknown }) => Promise<unknown>;
	const asked: string[] = [];
	let answer = false;
	const api = {
		on: (_event: string, fn: typeof handler) => { handler = fn; },
		getAllTools: () => [
			{ name: "lookup", sourceInfo: { path: "/x/plugin.ts" }, annotations: { readOnlyHint: true } },
			{ name: "bash", sourceInfo: { path: "builtin:bash" }, annotations: { readOnlyHint: true } },
		],
	} as unknown as ExtensionAPI;
	approvalGate(async tool => { asked.push(tool); return answer; }, new Set(["trusted_tool"]))(api);
	assert.equal(await handler({ toolName: "read", input: {} }), undefined);
	assert.equal(await handler({ toolName: "lookup", input: {} }), undefined);
	assert.equal(await handler({ toolName: "trusted_tool", input: {} }), undefined);
	assert.deepEqual(await handler({ toolName: "bash", input: { command: "rm -rf x" } }), { block: true, reason: "The user declined this tool call in BTW." });
	answer = true;
	assert.equal(await handler({ toolName: "unannotated", input: {} }), undefined);
	assert.deepEqual(asked, ["bash", "unannotated"]);
});

test("plugin BTW runs a real side agent with only allowlisted plugins, asks before tools, and branches with tool messages", async () => {
	const extensions = path.join(getAgentDir(), "extensions");
	await fs.mkdir(extensions, { recursive: true });
	const flags = globalThis as typeof globalThis & { __btwProbeStarted?: boolean; __btwNoiseStarted?: boolean };
	await fs.writeFile(path.join(extensions, "probe.ts"), `export default function (pi) {
		pi.on("session_start", () => { globalThis.__btwProbeStarted = true; });
		pi.registerTool({ name: "probe_lookup", label: "probe", description: "Look up a probe value", parameters: { type: "object", properties: { q: { type: "string" } } },
			execute: async () => ({ content: [{ type: "text", text: "probe result 42" }], details: undefined }) });
	}`);
	await fs.writeFile(path.join(extensions, "noise.ts"), `export default function (pi) {
		pi.on("session_start", () => { globalThis.__btwNoiseStarted = true; });
		pi.registerTool({ name: "noise_tool", label: "noise", description: "noise", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [], details: undefined }) });
	}`);
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "btw-agent-test-"));
	try {
		const faux = fauxProvider({ provider: "btw-faux" });
		const runtime = await ModelRuntime.create({ refreshOnCreate: false, authPath: path.join(dir, "auth.json"), modelsPath: null });
		runtime.registerNativeProvider(faux.provider);
		const fauxModel = faux.getModel() as Model<Api>;
		const seen: string[][] = [];
		const toolsOf = (context: { messages: Array<{ role: string; toolsAdded?: Array<{ name: string }> }> }) => context.messages.flatMap(message => message.role === "system" ? (message.toolsAdded ?? []).map(tool => tool.name) : []);
		faux.setResponses([
			context => { seen.push(toolsOf(context)); assert.match(JSON.stringify(context.messages), /main context marker/); return fauxAssistantMessage(fauxToolCall("probe_lookup", { q: "x" }), { stopReason: "toolUse" }); },
			context => { assert.match(JSON.stringify(context.messages), /probe result 42/); return fauxAssistantMessage("The answer is 42"); },
			() => fauxAssistantMessage(fauxToolCall("probe_lookup", { q: "y" }), { stopReason: "toolUse" }),
			context => { assert.match(JSON.stringify(context.messages), /declined/); return fauxAssistantMessage("Skipped the lookup"); },
		]);
		const manager = SessionManager.create(dir, dir);
		manager.appendMessage({ role: "user", content: "main context marker", timestamp: 1 });
		const ctx = { ...context(manager), model: fauxModel, cwd: dir } as unknown as ExtensionCommandContext;
		const session = new BtwSession(manager.getSessionId(), new BtwHistory());
		const engine = agentEngine({ allow: ["probe", "read"], trusted: new Set(), selfPath: path.resolve("extensions/btw.ts"), cwd: dir, runtime, prompt: (question, template) => template.split("{{question}}").join(question) });
		const decide = (allow: boolean) => session.subscribe(() => { session.approvals[0]?.resolve(allow); });
		let unsubscribe = decide(true);
		const topic = session.ask(snapshotBtw(ctx), "what is the probe value?", "Q: {{question}}", engine);
		await settled(session);
		unsubscribe();
		const turn = topic.turns[0];
		assert.equal(turn.status, "complete", turn.error);
		assert.equal(turn.answer, "The answer is 42");
		assert.deepEqual(turn.tools?.map(tool => [tool.name, tool.status]), [["probe_lookup", "done"]]);
		assert.ok(seen[0].includes("probe_lookup") && seen[0].includes("read"));
		assert.ok(!seen[0].includes("noise_tool") && !seen[0].includes("bash"));
		assert.equal(flags.__btwProbeStarted, true);
		assert.equal(flags.__btwNoiseStarted, undefined);
		assert.deepEqual(manager.getEntries().filter(entry => entry.type === "message").length, 1);
		const branch = SessionManager.open(createBtwBranch(ctx, topic)).buildSessionProjection().messages;
		assert.deepEqual(branch.slice(-4).map(message => message.role), ["user", "assistant", "toolResult", "assistant"]);
		assert.match(JSON.stringify(branch.at(-4)), /what is the probe value/);
		unsubscribe = decide(false);
		session.ask(snapshotBtw(ctx), "and again?", "Q: {{question}}", engine, topic.id);
		await settled(session);
		unsubscribe();
		assert.equal(topic.turns[1].status, "complete", topic.turns[1].error);
		assert.equal(topic.turns[1].answer, "Skipped the lookup");
		assert.deepEqual(topic.turns[1].tools?.map(tool => tool.status), ["error"]);
	} finally {
		delete flags.__btwProbeStarted; delete flags.__btwNoiseStarted;
		await fs.rm(path.join(extensions, "probe.ts"), { force: true });
		await fs.rm(path.join(extensions, "noise.ts"), { force: true });
		await fs.rm(dir, { recursive: true, force: true });
	}
});
