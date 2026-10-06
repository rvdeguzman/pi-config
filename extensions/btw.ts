import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { copyToClipboard, DefaultResourceLoader, getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BtwHistory, BtwSession, btwBranchReason, createBtwBranch, snapshotBtw, streamEngine, type BtwEngine, type BtwTopic } from "./lib/btw-session.ts";
import { agentEngine, BUILTIN_TOOLS, loadBtwConfig, mainModelRuntime, pluginName, saveBtwConfig } from "./lib/btw-agent.ts";

const SELF_PATH = fileURLToPath(import.meta.url);
const prompts = new Map<string, Promise<string>>();
function prompt(name: string): Promise<string> {
	let text = prompts.get(name);
	if (!text) { text = fs.readFile(new URL(`./prompts/${name}`, import.meta.url), "utf8"); prompts.set(name, text); }
	return text;
}

/** Answer-only by default; allowlisted plugins switch to a side agent with only those plugins. */
async function btwMode(ctx: ExtensionCommandContext): Promise<{ engine: BtwEngine; instructions: string; trust?: (tool: string) => Promise<void> }> {
	const { allow, trust } = await loadBtwConfig();
	if (!allow.length) return { engine: streamEngine((model, context, options) => ctx.modelRegistry.streamSimple(model, context, options)), instructions: await prompt("btw.md") };
	const trusted = new Set(trust);
	return {
		instructions: await prompt("btw-agent.md"),
		trust: async tool => {
			trusted.add(tool);
			const latest = await loadBtwConfig();
			if (!latest.trust.includes(tool)) await saveBtwConfig({ ...latest, trust: [...latest.trust, tool] });
		},
		engine: agentEngine({
			allow, trusted, selfPath: SELF_PATH, cwd: ctx.cwd, runtime: mainModelRuntime(ctx),
			prompt: (question, template) => template.split("{{question}}").join(question),
		}),
	};
}
import { BtwDialog, safeBtwText, type BtwDialogResult } from "./lib/btw-ui.ts";

interface SharedUiLock { withLock<T>(fn: () => T | Promise<T>): Promise<T> }
const uiGlobals = globalThis as typeof globalThis & { __piSharedUiLock?: SharedUiLock };
if (!uiGlobals.__piSharedUiLock) {
	let queue = Promise.resolve();
	uiGlobals.__piSharedUiLock = { withLock<T>(fn: () => T | Promise<T>): Promise<T> {
		const result = queue.then(fn, fn);
		queue = result.then(() => {}, () => {});
		return result;
	} };
}
const sharedUiLock = uiGlobals.__piSharedUiLock;
// Plain recovery data survives /reload without retaining old runtime contexts or callbacks.
const recoveryGlobals = globalThis as typeof globalThis & { __piBtwUnsaved?: Map<string, BtwTopic[]> };
const recovery = recoveryGlobals.__piBtwUnsaved ??= new Map<string, BtwTopic[]>();

/** Preserve the previous extension's saved visible thread when first opening this replacement. */
export function legacyBtwTopic(ctx: ExtensionContext): BtwTopic | undefined {
	const turns: BtwTopic["turns"] = [];
	let lastId: string | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom") continue;
		if (entry.customType === "btw-thread-reset") { turns.length = 0; lastId = undefined; }
		if (entry.customType !== "btw-thread-entry") continue;
		const data = entry.data as { question?: unknown; answer?: unknown; timestamp?: unknown } | undefined;
		if (typeof data?.question !== "string" || typeof data.answer !== "string") continue;
		const timestamp = typeof data.timestamp === "number" ? data.timestamp : Date.parse(entry.timestamp);
		turns.push({ question: data.question, answer: data.answer, status: "complete", createdAt: timestamp, updatedAt: timestamp });
		lastId = entry.id;
	}
	return lastId && turns.length ? {
		version: 1, id: `legacy-${lastId}`, sessionId: ctx.sessionManager.getSessionId(), leafId: null, revision: 0, turns,
	} : undefined;
}

export default function btw(pi: ExtensionAPI) {
	let session: BtwSession | undefined;
	let generation = 0;
	let streaming: AssistantMessage | undefined;
	let closeDialog: (() => void) | undefined;
	let dialogOwner: symbol | undefined;
	let transitioning = false;
	let loading: Promise<BtwSession> | undefined;

	async function close(): Promise<void> {
		generation++;
		streaming = undefined;
		closeDialog?.();
		closeDialog = undefined;
		const previous = session;
		session = undefined;
		await previous?.dispose();
		loading = undefined;
	}

	async function current(ctx: ExtensionCommandContext): Promise<BtwSession> {
		if (session?.sessionId === ctx.sessionManager.getSessionId()) return session;
		if (loading) return loading;
		const epoch = generation;
		const pending = (async () => {
			const next = new BtwSession(ctx.sessionManager.getSessionId(), new BtwHistory(
				ctx.sessionManager.getSessionFile() ? path.join(getAgentDir(), "btw-history") : undefined,
			));
			await next.load();
			if (next.history.warnings.length) ctx.ui.notify(safeBtwText(`Some BTW history could not load:\n${next.history.warnings.slice(0, 3).join("\n")}`), "warning");
			const recovered = recovery.get(next.sessionId);
			if (recovered) next.restoreUnsaved(recovered);
			const legacy = legacyBtwTopic(ctx);
			if (legacy && !next.topics.some(topic => topic.id === legacy.id)) {
				next.topics.push(legacy);
				try { await next.history.save(legacy); }
				catch (error) { next.restoreUnsaved([legacy], `Legacy BTW history is not saved: ${String(error)}`); }
			}
			if (epoch !== generation) { await next.dispose(); throw new Error("The session changed. Reopen /btw."); }
			session = next;
			if (recovered) recovery.delete(next.sessionId);
			return next;
		})();
		loading = pending;
		try { return await pending; } finally { if (loading === pending) loading = undefined; }
	}

	pi.registerCommand("btw", {
		description: "Answer-only side question. /btw QUESTION asks; /btw opens saved history.",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") { ctx.ui.notify("BTW requires interactive terminal mode.", "warning"); return; }
			if (transitioning) { ctx.ui.notify("The session is changing; reopen /btw afterward.", "info"); return; }
			if (dialogOwner) { ctx.ui.notify("BTW is already open. Use n for a new question or x to hide it.", "info"); return; }
			const owner = Symbol("btw-dialog");
			dialogOwner = owner;
			const epoch = generation;
			try {
				const side = await current(ctx);
				const mode = await btwMode(ctx);
				if (epoch !== generation) return;
				side.onTrust = mode.trust;
				side.onApproval = tool => { if (!closeDialog) ctx.ui.notify(`BTW wants to run ${safeBtwText(tool)}. Open /btw to allow or decline.`, "warning"); };
				const ask = (question: string, topicId?: string): BtwTopic => {
					if (transitioning || epoch !== generation || session !== side) throw new Error("The session changed. Reopen /btw.");
					return side.ask(snapshotBtw(ctx, streaming), question, mode.instructions, mode.engine, topicId);
				};
				const topic = args.trim() ? ask(args) : undefined;
				let result: BtwDialogResult = { action: "close" };
				try {
					result = await sharedUiLock.withLock(() => {
						if (epoch !== generation) return { action: "close" } as const;
						return ctx.ui.custom<BtwDialogResult>((tui, theme, _keybindings, done) => {
							const dialog = new BtwDialog(side, tui, theme, {
								ask, copy: text => copyToClipboard(safeBtwText(text)),
								branchReason: item => side.busy ? "Wait for the side answer to finish saving." : side.storageError ? "Save the answer before branching." : btwBranchReason(ctx, item),
							}, done, topic?.id ?? side.activeTopic?.id);
							closeDialog = () => dialog.close();
							return dialog;
						}, { overlay: true, overlayOptions: { anchor: "bottom-center", width: "90%", maxHeight: "80%", margin: 1 } });
					});
				} finally { if (dialogOwner === owner) closeDialog = undefined; }
				if (result.action !== "branch" || epoch !== generation) return;
				const reason = btwBranchReason(ctx, result.topic);
				if (reason) { ctx.ui.notify(reason, "warning"); return; }
				const file = createBtwBranch(ctx, result.topic);
				const switched = await ctx.switchSession(file, {
					withSession: async fresh => { fresh.ui.notify("Branched from the BTW answer. Continue here; the original session is unchanged.", "info"); },
				});
				if (switched.cancelled) ctx.ui.notify("BTW branch cancelled; the answer remains in history.", "info");
			} catch (error) {
				if (epoch === generation) ctx.ui.notify(safeBtwText(String(error instanceof Error ? error.message : error)), "error");
			} finally { if (dialogOwner === owner) { dialogOwner = undefined; closeDialog = undefined; } }
		},
	});

	pi.registerCommand("btw-plugins", {
		description: "Choose which plugins and built-in tools /btw may use (none = answer-only).",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") { ctx.ui.notify("BTW plugin selection requires interactive terminal mode.", "warning"); return; }
			try {
				const config = await loadBtwConfig();
				// Load (never bind/start) the configured extensions only to list their names and tools.
				const loader = new DefaultResourceLoader({ cwd: ctx.cwd, agentDir: getAgentDir() });
				await loader.reload();
				const loaded = loader.getExtensions();
				const providers = new Set([...loaded.runtime.pendingProviderRegistrations, ...loaded.runtime.pendingNativeProviderRegistrations].map(item => item.extensionPath));
				const plugins = new Map<string, Set<string>>();
				for (const extension of loaded.extensions) {
					if (extension.path.startsWith("<") || extension.path.startsWith("builtin:") || extension.resolvedPath === SELF_PATH || providers.has(extension.path)) continue;
					const tools = plugins.get(pluginName(extension)) ?? new Set<string>();
					for (const tool of extension.tools.keys()) tools.add(tool);
					plugins.set(pluginName(extension), tools);
				}
				const items = [
					...[...plugins].map(([name, tools]) => ({ name, detail: tools.size ? [...tools].join(", ") : "hooks/commands" })),
					...BUILTIN_TOOLS.map(name => ({ name, detail: "built-in tool" })),
				];
				const allow = new Set(config.allow);
				const DONE = "Done";
				while (true) {
					const labels = items.map(item => `${allow.has(item.name) ? "[x]" : "[ ]"} ${item.name} — ${item.detail}`);
					const choice = await ctx.ui.select("BTW plugins (Enter toggles; none = answer-only):", [DONE, ...labels]);
					if (choice === undefined || choice === DONE) break;
					const item = items[labels.indexOf(choice)];
					if (!item) break;
					if (allow.has(item.name)) allow.delete(item.name); else allow.add(item.name);
				}
				// Keep unknown entries (for example plugins not installed on this machine).
				const known = new Set(items.map(item => item.name));
				const next = [...config.allow.filter(name => !known.has(name)), ...items.map(item => item.name).filter(name => allow.has(name))];
				await saveBtwConfig({ allow: next, trust: config.trust });
				ctx.ui.notify(next.length ? `BTW can use: ${next.join(", ")}` : "BTW is answer-only (no plugins).", "info");
			} catch (error) { ctx.ui.notify(safeBtwText(String(error instanceof Error ? error.message : error)), "error"); }
		},
	});

	pi.on("session_start", () => { transitioning = false; streaming = undefined; });
	// Observe references only; detach once when accepting a question, not on every streamed token.
	pi.on("message_update", (event) => { if (event.message.role === "assistant") streaming = event.message; });
	pi.on("message_end", (event) => { if (event.message.role === "assistant") streaming = event.message; });
	pi.on("agent_end", () => { streaming = undefined; });
	pi.on("model_select", () => { session?.cancel(); });
	async function beforeMove(_event: unknown, ctx: ExtensionContext): Promise<{ cancel: true } | undefined> {
		transitioning = true;
		try {
			session?.cancel();
			try { await session?.flush(); }
			catch (error) { ctx.ui.notify(safeBtwText(`Cannot leave BTW with unsaved answers: ${String(error)}. Press r to retry or c to copy.`), "error"); return { cancel: true }; }
			if (session?.cleanupError) ctx.ui.notify(safeBtwText(`BTW provider cleanup failed: ${session.cleanupError}`), "warning");
			await close();
			return undefined;
		} finally { transitioning = false; }
	}
	pi.on("session_before_switch", beforeMove);
	pi.on("session_before_fork", beforeMove);
	pi.on("session_before_tree", beforeMove);
	pi.on("session_shutdown", async (_event, ctx) => {
		transitioning = true;
		const previous = session;
		await close();
		if (previous?.cleanupError) ctx.ui.notify(safeBtwText(`BTW provider cleanup failed: ${previous.cleanupError}`), "warning");
		const unsaved = previous?.unsavedTopics;
		if (unsaved?.length) {
			recovery.set(previous!.sessionId, unsaved);
			try {
				const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-btw-recovery-"));
				const file = path.join(dir, "answers.json");
				await fs.writeFile(file, JSON.stringify(unsaved), { mode: 0o600 });
				ctx.ui.notify(`BTW answers could not be saved normally. Recovery copy: ${file}`, "warning");
			} catch (error) { ctx.ui.notify(safeBtwText(`BTW answers remain only in memory; recovery backup failed: ${String(error)}`), "error"); }
		}
	});
}
