import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { cleanupSessionResources, type Api, type AssistantMessage, type AssistantMessageEventStream, type Context, type Message, type Model, type ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { convertToLlm, SessionManager, type ExtensionCommandContext, type FileEntry } from "@earendil-works/pi-coding-agent";

/** Messages Pi can persist on a session branch. */
export type BtwMessage = Parameters<SessionManager["appendMessage"]>[0];
export interface BtwToolActivity { id: string; name: string; status: "running" | "done" | "error" }

export type BtwStatus = "running" | "complete" | "cancelled" | "error";
export interface BtwTurn {
	question: string;
	answer: string;
	status: BtwStatus;
	createdAt: number;
	updatedAt: number;
	error?: string;
	assistant?: AssistantMessage;
	/** Tool activity shown in the reader for plugin-enabled turns. */
	tools?: BtwToolActivity[];
	/** Native messages produced by a plugin-enabled turn, appended verbatim when branching. */
	messages?: BtwMessage[];
}
export interface BtwTopic {
	version: 1;
	id: string;
	sessionId: string;
	leafId: string | null;
	revision: number;
	turns: BtwTurn[];
}
export interface BtwSnapshot {
	sessionId: string;
	leafId: string | null;
	model: Model<Api>;
	thinkingLevel: ExtensionCommandContext["thinkingLevel"];
	messages: Message[];
	/** Raw header + active branch entries, for seeding a plugin-enabled side session. */
	entries: FileEntry[];
	/** Visible in-flight main text not yet persisted (no signatures/IDs/tool calls). */
	transient?: AssistantMessage;
}
export type BtwStream = (model: Model<Api>, context: Context, options: ModelsSimpleStreamOptions) => AssistantMessageEventStream;
export interface BtwRunArgs {
	snapshot: BtwSnapshot;
	topic: BtwTopic;
	turn: BtwTurn;
	instructions: string;
	signal: AbortSignal;
	sideSessionId: string;
	changed(): void;
	approve(tool: string, summary: string): Promise<boolean>;
}
export interface BtwRunResult { assistant: AssistantMessage; messages?: BtwMessage[] }
/** Runs one side turn. Must settle after `signal` aborts; resolve undefined when aborted. */
export type BtwEngine = (args: BtwRunArgs) => Promise<BtwRunResult | undefined>;
export interface BtwApproval { tool: string; summary: string; resolve(allow: boolean): void }

/** Answer-only engine: one provider stream, tool choice disabled. */
export function streamEngine(stream: BtwStream): BtwEngine {
	return async ({ snapshot, topic, turn, instructions, signal, sideSessionId, changed }) => {
		// The catalog remains available for provider/cache compatibility; none is ever executed.
		const events = stream(snapshot.model, btwContext(snapshot, topic, instructions), {
			signal, sessionId: sideSessionId,
			reasoning: snapshot.thinkingLevel === "off" ? undefined : snapshot.thinkingLevel, toolChoice: "none",
		});
		let final: AssistantMessage | undefined;
		for await (const event of events) {
			// Keep draining after cancellation so ownership is released only after forwarding ends.
			if (signal.aborted) continue;
			if (event.type === "text_delta") {
				turn.answer += event.delta;
				turn.updatedAt = Date.now();
				changed();
			} else if (event.type === "done") final = structuredClone(event.message);
			else if (event.type === "error") throw new Error(event.error.errorMessage || "Side request failed.");
		}
		if (signal.aborted) return undefined;
		if (!final) throw new Error("The side request ended without a final reply.");
		if (final.content.some(block => block.type === "toolCall")) throw new Error("The model requested a tool. No tools were executed.");
		return { assistant: final };
	};
}

/** Detached, compaction/context-edit-aware context. No AgentSession or tool execution loop. */
export function snapshotBtw(ctx: ExtensionCommandContext, streaming?: AssistantMessage): BtwSnapshot {
	if (!ctx.model) throw new Error("No model selected.");
	const messages = structuredClone(convertToLlm(ctx.sessionManager.buildSessionProjection().messages));
	if (!messages.some(message => message.role === "system")) {
		messages.unshift({ role: "system", content: ctx.getSystemPrompt(), timestamp: Date.now() });
	}
	let transient: AssistantMessage | undefined;
	if (streaming) {
		// message_end precedes persistence. Keep its visible text until the raw entry exists,
		// but never resurrect a finalized message intentionally omitted by an edit/compaction.
		const persisted = ctx.sessionManager.getBranch().some(entry => entry.type === "message" && entry.message.role === "assistant" &&
			(streaming.responseId ? entry.message.responseId === streaming.responseId :
				entry.message.timestamp === streaming.timestamp && entry.message.provider === streaming.provider && entry.message.model === streaming.model));
		const text = streaming.content.filter(block => block.type === "text").map(block => block.text).join("");
		// A partial signed reasoning item cannot safely be detached from its pending tool item.
		if (!persisted && text) {
			transient = {
				role: "assistant", content: [{ type: "text", text }], api: streaming.api, provider: streaming.provider,
				model: streaming.model, usage: structuredClone(streaming.usage), stopReason: "stop", timestamp: streaming.timestamp,
			};
			messages.push(transient);
		}
	}
	const header = ctx.sessionManager.getHeader();
	const entries: FileEntry[] = structuredClone([...(header ? [header] : []), ...ctx.sessionManager.getBranch()]);
	return {
		sessionId: ctx.sessionManager.getSessionId(), leafId: ctx.sessionManager.getLeafId(),
		model: ctx.model, thinkingLevel: ctx.thinkingLevel, messages, entries, transient,
	};
}

export function btwContext(snapshot: BtwSnapshot, topic: BtwTopic, instructions: string): Context {
	const messages = structuredClone(snapshot.messages);
	messages.push({ role: "system", content: instructions, timestamp: Date.now() });
	for (const turn of topic.turns) {
		messages.push({ role: "user", content: turn.question, timestamp: turn.createdAt });
		// Replay visible history only: do not replay old response IDs or reasoning signatures.
		if (turn.answer && turn !== topic.turns.at(-1)) {
			messages.push({
				role: "assistant", content: [{ type: "text", text: turn.answer }],
				api: snapshot.model.api, provider: snapshot.model.provider, model: snapshot.model.id,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop", timestamp: turn.updatedAt,
			});
		}
	}
	return { messages };
}

function validTopic(value: unknown, sessionId: string): value is BtwTopic {
	if (!value || typeof value !== "object") return false;
	const topic = value as BtwTopic;
	return topic.version === 1 && topic.sessionId === sessionId && typeof topic.id === "string" &&
		(topic.leafId === null || typeof topic.leafId === "string") && Number.isSafeInteger(topic.revision) &&
		topic.revision >= 0 && Array.isArray(topic.turns) && topic.turns.length > 0 && topic.turns.every(turn =>
			turn && typeof turn.question === "string" && typeof turn.answer === "string" &&
			["running", "complete", "cancelled", "error"].includes(turn.status) &&
			Number.isFinite(turn.createdAt) && Number.isFinite(turn.updatedAt) &&
			(turn.error === undefined || typeof turn.error === "string") &&
			(turn.messages === undefined || (Array.isArray(turn.messages) && turn.messages.every(message => message && typeof message.role === "string"))) &&
			(turn.tools === undefined || (Array.isArray(turn.tools) && turn.tools.every(tool => tool && typeof tool.name === "string"))) &&
			(turn.assistant === undefined || (turn.assistant?.role === "assistant" &&
				typeof turn.assistant.api === "string" && typeof turn.assistant.provider === "string" && typeof turn.assistant.model === "string" &&
				Array.isArray(turn.assistant.content) && turn.assistant.content.every(block => block && typeof block.type === "string") &&
				turn.assistant.usage && typeof turn.assistant.usage.totalTokens === "number")));
}

/** Immutable private revisions. Atomic hard-link commit refuses races without stale lock files. */
export class BtwHistory {
	readonly warnings: string[] = [];
	constructor(readonly root?: string) {}
	#directory(sessionId: string): string {
		if (!this.root) throw new Error("Ephemeral history has no directory.");
		return path.join(this.root, `session-${encodeURIComponent(sessionId)}`);
	}
	async load(sessionId: string): Promise<BtwTopic[]> {
		this.warnings.length = 0;
		if (!this.root) return [];
		const dir = this.#directory(sessionId);
		let names: string[];
		try { names = await fs.readdir(dir); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
		const topics: BtwTopic[] = [];
		for (const name of names) {
			try {
				const topicDir = path.join(dir, name);
				const revisions = (await fs.readdir(topicDir)).filter(file => /^[1-9]\d*\.json$/.test(file)).sort((a, b) => Number(b.split(".")[0]) - Number(a.split(".")[0]));
				for (const file of revisions) {
					try {
						const value: unknown = JSON.parse(await fs.readFile(path.join(topicDir, file), "utf8"));
						if (!validTopic(value, sessionId) || name !== `topic-${encodeURIComponent(value.id)}` || file !== `${value.revision}.json`) throw new Error("Invalid topic revision.");
						for (const turn of value.turns) if (turn.status === "running") {
							turn.status = "cancelled"; turn.error = "Interrupted before completion.";
						}
						topics.push(value);
						break;
					} catch (error) { this.warnings.push(`${name}/${file}: ${String(error)}`); }
				}
			} catch (error) { this.warnings.push(`${name}: ${String(error)}`); }
		}
		return topics.sort((a, b) => b.turns.at(-1)!.createdAt - a.turns.at(-1)!.createdAt);
	}
	async save(topic: BtwTopic): Promise<void> {
		if (!this.root) return;
		const dir = path.join(this.#directory(topic.sessionId), `topic-${encodeURIComponent(topic.id)}`);
		await fs.mkdir(dir, { recursive: true, mode: 0o700 });
		const revisions = (await fs.readdir(dir)).filter(file => /^[1-9]\d*\.json$/.test(file));
		const latest = revisions.reduce((latest, file) => Math.max(latest, Number(file.split(".")[0])), 0);
		const conflict = () => new Error("This BTW topic changed in another Pi process. Copy any unsaved answer, then /reload before continuing.");
		if (latest !== topic.revision) throw conflict();
		const revision = latest + 1;
		const temporary = path.join(dir, `${randomUUID()}.tmp`);
		try {
			await fs.writeFile(temporary, JSON.stringify({ ...topic, revision }), { mode: 0o600 });
			await fs.link(temporary, path.join(dir, `${revision}.json`)).catch(error => { if (error.code === "EEXIST") throw conflict(); throw error; });
			topic.revision = revision;
		} finally { await fs.rm(temporary, { force: true }); }
	}
}

/** One active side request; all caller-visible transitions retain partial output. */
export class BtwSession {
	topics: BtwTopic[] = [];
	readonly #unsaved = new Map<string, string>();
	get storageError(): string | undefined { return this.#unsaved.size ? [...this.#unsaved.values()].join("\n") : undefined; }
	readonly #listeners = new Set<() => void>();
	readonly #saves = new Map<string, Promise<void>>();
	readonly #cleanup: (sessionId: string) => void;
	cleanupError?: string;
	#active?: { topic: BtwTopic; abort: AbortController; promise: Promise<void> };
	/** Pending tool approvals; the reader shows the first. Parallel calls queue here. */
	approvals: BtwApproval[] = [];
	/** Called when a tool needs approval, so a hidden reader can tell the user. */
	onApproval?: (tool: string) => void;
	/** Called when the user chooses “always allow” for a tool. */
	onTrust?: (tool: string) => Promise<void>;
	#disposed = false;
	#closing = false;
	constructor(readonly sessionId: string, readonly history: BtwHistory, cleanup: (sessionId: string) => void = cleanupSessionResources) { this.#cleanup = cleanup; }
	get busy(): boolean { return this.#active !== undefined || this.#saves.size > 0; }
	get activeTopic(): BtwTopic | undefined { return this.#active?.topic; }
	subscribe(listener: () => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
	#changed(): void { for (const listener of this.#listeners) listener(); }
	async load(): Promise<void> { this.topics = await this.history.load(this.sessionId); }
	get unsavedTopics(): BtwTopic[] { return structuredClone(this.topics.filter(topic => this.#unsaved.has(topic.id))); }
	restoreUnsaved(topics: BtwTopic[], reason = "Recovered an unsaved answer; press r to retry saving or c to copy it."): void {
		for (const topic of topics) {
			this.topics = this.topics.filter(item => item.id !== topic.id);
			this.topics.unshift(structuredClone(topic));
			this.#unsaved.set(topic.id, reason);
		}
	}
	async flush(): Promise<void> {
		await this.#active?.promise;
		await Promise.allSettled([...this.#saves.values()]);
		for (const id of [...this.#unsaved.keys()]) { try { await this.#saveTopic(id); } catch { /* Retain this topic's error and in-memory answer. */ } }
		if (this.storageError) throw new Error(this.storageError);
	}
	retrySave(topicId: string): Promise<void> {
		if (this.#closing) return Promise.reject(new Error("This BTW session has closed."));
		return this.#saveTopic(topicId);
	}
	#saveTopic(topicId: string): Promise<void> {
		if (this.busy || this.#disposed) return Promise.reject(new Error("Wait for the side request before saving."));
		const topic = this.topics.find(item => item.id === topicId);
		if (!topic) return Promise.reject(new Error("This topic is no longer available."));
		// Reserve mutation ownership before starting async storage, just like accepting a model request.
		const operation = Promise.resolve().then(async () => {
			try { await this.history.save(topic); this.#unsaved.delete(topicId); }
			catch (error) { this.#unsaved.set(topicId, String(error instanceof Error ? error.message : error)); throw error; }
		}).finally(() => { this.#saves.delete(topicId); this.#changed(); });
		this.#saves.set(topicId, operation);
		this.#changed();
		return operation;
	}
	#approve(tool: string, summary: string, signal: AbortSignal): Promise<boolean> {
		if (signal.aborted) return Promise.resolve(false);
		const decision = Promise.withResolvers<boolean>();
		const approval: BtwApproval = {
			tool, summary,
			resolve: allow => {
				if (!this.approvals.includes(approval)) return;
				this.approvals = this.approvals.filter(item => item !== approval);
				signal.removeEventListener("abort", onAbort);
				decision.resolve(allow);
				this.#changed();
			},
		};
		const onAbort = () => approval.resolve(false);
		signal.addEventListener("abort", onAbort, { once: true });
		this.approvals.push(approval);
		this.#changed();
		try { this.onApproval?.(tool); } catch { /* Notification is best-effort. */ }
		return decision.promise;
	}
	cancel(): void {
		if (!this.#active) return;
		this.#active.abort.abort();
		const turn = this.#active.topic.turns.at(-1)!;
		if (turn.status === "running") { turn.status = "cancelled"; turn.updatedAt = Date.now(); this.#changed(); }
	}
	async dispose(): Promise<void> { if (this.#disposed) return; this.#closing = true; this.cancel(); await this.#active?.promise; try { await this.flush(); } catch { /* Caller retains/reports unsavedTopics. */ } this.#disposed = true; this.#listeners.clear(); }

	ask(snapshot: BtwSnapshot, question: string, instructions: string, engine: BtwEngine, topicId?: string): BtwTopic {
		if (this.#disposed || this.#closing) throw new Error("This BTW session has closed.");
		if (this.cleanupError) throw new Error(`BTW provider cleanup failed: ${this.cleanupError}. Run /reload before asking again.`);
		if (this.busy) throw new Error("BTW is still answering. Cancel or wait before asking another question.");
		if (snapshot.sessionId !== this.sessionId) throw new Error("The main session changed. Reopen /btw.");
		question = question.trim();
		if (!question) throw new Error("Enter a side question first.");
		let topic = topicId ? this.topics.find(item => item.id === topicId) : undefined;
		if (topicId && !topic) throw new Error("This BTW topic is no longer available.");
		if (!topic) {
			topic = { version: 1, id: randomUUID(), sessionId: this.sessionId, leafId: snapshot.leafId, revision: 0, turns: [] };
			this.topics.unshift(topic);
		}
		const turn: BtwTurn = { question, answer: "", status: "running", createdAt: Date.now(), updatedAt: Date.now() };
		topic.turns.push(turn);
		const abort = new AbortController();
		// The microtask starts after #active is assigned, even for synchronous stream failures.
		const promise = Promise.resolve().then(() => this.#run(topic, turn, snapshot, instructions, engine, abort));
		this.#active = { topic, abort, promise };
		this.#changed();
		return topic;
	}

	async #run(topic: BtwTopic, turn: BtwTurn, snapshot: BtwSnapshot, instructions: string, engine: BtwEngine, abort: AbortController): Promise<void> {
		const sideSessionId = `${this.sessionId}:btw:${topic.id}:${randomUUID()}`;
		const cancelled = Promise.withResolvers<never>();
		const onAbort = () => cancelled.reject(new Error("Cancelled"));
		// Install and handle this rejection before any awaited storage operation.
		abort.signal.addEventListener("abort", onAbort, { once: true });
		cancelled.promise.catch(() => {});
		let consumer: Promise<void> | undefined;
		try {
			await this.history.save(topic);
			if (abort.signal.aborted) throw new Error("Cancelled");
			const consume = async (): Promise<void> => {
				const result = await engine({
					snapshot, topic, turn, instructions, signal: abort.signal, sideSessionId,
					changed: () => this.#changed(), approve: (tool, summary) => this.#approve(tool, summary, abort.signal),
				});
				if (abort.signal.aborted || !result) return;
				const final = result.assistant;
				if (final.stopReason === "aborted" || final.stopReason === "error") throw new Error(final.errorMessage || "Side request failed.");
				if (final.content.some(block => block.type === "toolCall")) throw new Error("The side request ended on an unfinished tool call.");
				const answer = final.content.filter(block => block.type === "text").map(block => block.text).join("\n").trim();
				if (!answer) throw new Error("The side request returned no visible answer.");
				turn.answer = answer;
				turn.assistant = { ...final, thinkingLevel: snapshot.thinkingLevel ?? "off" };
				if (result.messages) turn.messages = structuredClone(result.messages);
				turn.status = "complete";
				if (final.stopReason === "length") turn.error = "Answer reached the model's output limit.";
			};
			consumer = consume();
			await Promise.race([consumer, cancelled.promise]);
			if (abort.signal.aborted) throw new Error("Cancelled");
		} catch (error) {
			const wasCancelled = abort.signal.aborted;
			abort.abort();
			turn.status = wasCancelled ? "cancelled" : "error";
			turn.error = turn.status === "error" ? String(error instanceof Error ? error.message : error) : undefined;
		} finally {
			abort.signal.removeEventListener("abort", onAbort);
			turn.updatedAt = Date.now();
			try { await this.history.save(topic); this.#unsaved.delete(topic.id); }
			catch (error) { this.#unsaved.set(topic.id, String(error instanceof Error ? error.message : error)); }
			this.#changed();
			// UI cancellation is immediate, but request ownership/resources remain until forwarding stops.
			await consumer?.catch(() => {});
			try { this.#cleanup(sideSessionId); }
			catch (error) { this.cleanupError = String(error instanceof Error ? error.message : error); }
			finally { this.#active = undefined; this.#changed(); }
		}
	}
}

export function btwBranchReason(ctx: ExtensionCommandContext, topic: BtwTopic): string | undefined {
	if (!ctx.isIdle() || ctx.hasPendingMessages()) return "The main agent must be idle with no queued messages.";
	if (topic.sessionId !== ctx.sessionManager.getSessionId() || topic.leafId !== ctx.sessionManager.getLeafId()) return "The main conversation moved since this question. Start a new side question.";
	if (!topic.leafId || !ctx.sessionManager.getSessionFile()) return "This answer needs a saved conversation branch point.";
	if (topic.turns.length !== 1) return "Multi-turn topics stay in BTW history; only a single answer can be branched.";
	const turn = topic.turns[0];
	if (turn.status !== "complete" || turn.assistant?.stopReason !== "stop" || turn.assistant.content.some(block => block.type === "toolCall")) return "Only a completed, non-truncated answer can be branched.";
	return undefined;
}

/** Clone the original entry path, including compaction/edit IDs, then append the real Q&A. */
export function createBtwBranch(ctx: ExtensionCommandContext, topic: BtwTopic): string {
	const reason = btwBranchReason(ctx, topic);
	if (reason) throw new Error(reason);
	const source = ctx.sessionManager.getSessionFile()!;
	const manager = SessionManager.open(source, ctx.sessionManager.getSessionDir());
	if (manager.getSessionId() !== topic.sessionId || !manager.getEntry(topic.leafId!)) throw new Error("The saved branch point is no longer available.");
	const file = manager.createBranchedSession(topic.leafId!);
	if (!file) throw new Error("Cannot create a saved BTW branch.");
	const turn = topic.turns[0];
	// Plugin-enabled turns keep their exact prompt, tool calls and results; answer-only turns are one Q&A.
	const messages: BtwMessage[] = turn.messages ?? [{ role: "user", content: turn.question, timestamp: turn.createdAt }, turn.assistant!];
	for (const message of messages) manager.appendMessage(structuredClone(message));
	manager.appendSessionInfo(`BTW: ${turn.question.split("\n")[0].slice(0, 60)}`);
	return file;
}
