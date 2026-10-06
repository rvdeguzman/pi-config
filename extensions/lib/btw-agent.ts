import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, type ModelRuntime,
	type Extension, type ExtensionAPI, type ExtensionCommandContext, type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";
import type { BtwEngine, BtwMessage, BtwRunArgs } from "./btw-session.ts";

/** Built-in tools that can be allowlisted by name. */
export const BUILTIN_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"] as const;
const READ_ONLY_BUILTINS = new Set(["read", "grep", "find", "ls"]);

/** `allow`: plugins/built-in tools BTW loads. `trust`: tools that run without asking. */
export interface BtwConfig { allow: string[]; trust: string[] }
export function btwConfigPath(agentDir = getAgentDir()): string { return path.join(agentDir, "btw.json"); }

export async function loadBtwConfig(file = btwConfigPath()): Promise<BtwConfig> {
	let raw: string;
	try { raw = await fs.readFile(file, "utf8"); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { allow: [], trust: [] }; throw error; }
	const value = JSON.parse(raw) as { allow?: unknown; trust?: unknown } | null;
	const list = (key: "allow" | "trust"): string[] => {
		const items = value?.[key] ?? [];
		if (!Array.isArray(items) || !items.every(item => typeof item === "string")) throw new Error(`${file}: "${key}" must be an array of names.`);
		return [...new Set(items.map(item => item.trim()).filter(Boolean))];
	};
	return { allow: list("allow"), trust: list("trust") };
}

export async function saveBtwConfig(config: BtwConfig, file = btwConfigPath()): Promise<void> {
	const temporary = `${file}.${process.pid}.tmp`;
	await fs.writeFile(temporary, `${JSON.stringify({ allow: config.allow, trust: config.trust }, null, 2)}\n`, { mode: 0o600 });
	await fs.rename(temporary, file);
}

/** Short, stable name for an extension: package name, or local file/directory name. */
export function pluginName(extension: Pick<Extension, "path" | "sourceInfo">): string {
	const source = extension.sourceInfo.source;
	if (/^(npm|git|https?):/.test(source)) {
		const spec = source.replace(/^(npm|git):/, "").replace(/@[^/@]*$/, "").replace(/\.git$/, "");
		return spec.split("/").filter(Boolean).at(-1) ?? source;
	}
	const base = path.basename(extension.path).replace(/\.[cm]?[jt]s$/, "");
	return base === "index" ? path.basename(path.dirname(extension.path)) : base;
}

function allowed(extension: Extension, allow: readonly string[]): boolean {
	return allow.includes(pluginName(extension)) || allow.includes(extension.sourceInfo.source);
}

/**
 * Keep only allowlisted plugins plus BTW's own inline approval gate. BTW itself never loads
 * (no recursion), and queued provider registrations are dropped: the side session shares the
 * main model runtime, so re-registering a provider there would replace the main one.
 */
export function filterBtwExtensions(base: LoadExtensionsResult, allow: readonly string[], selfPath: string): LoadExtensionsResult {
	const providers = new Set([
		...base.runtime.pendingProviderRegistrations.map(item => item.extensionPath),
		...base.runtime.pendingNativeProviderRegistrations.map(item => item.extensionPath),
	]);
	base.runtime.pendingProviderRegistrations = [];
	base.runtime.pendingNativeProviderRegistrations = [];
	return {
		...base,
		extensions: base.extensions.filter(extension => extension.path.startsWith("<inline:") ||
			(path.resolve(extension.resolvedPath) !== path.resolve(selfPath) && !providers.has(extension.path) && allowed(extension, allow))),
	};
}

/** Tools for the side session: only allowlisted built-ins plus the tools loaded plugins provide. */
export function btwToolNames(allow: readonly string[], loaded: LoadExtensionsResult): string[] {
	const names = allow.filter(name => (BUILTIN_TOOLS as readonly string[]).includes(name));
	for (const extension of loaded.extensions) names.push(...extension.tools.keys());
	return [...new Set(names)];
}

function summarize(input: unknown): string {
	let text: string;
	try { text = JSON.stringify(input) ?? ""; } catch { text = String(input); }
	return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/** Inline gate in the side runtime: read-only calls run; everything else asks in the BTW panel. */
export function approvalGate(approve: BtwRunArgs["approve"], trusted: ReadonlySet<string> = new Set()) {
	return (api: ExtensionAPI) => {
		api.on("tool_call", async event => {
			if (READ_ONLY_BUILTINS.has(event.toolName) || trusted.has(event.toolName)) return undefined;
			const info = api.getAllTools().find(tool => tool.name === event.toolName);
			const builtin = info?.sourceInfo.path.startsWith("builtin:") ?? false;
			if (!builtin && info?.annotations?.readOnlyHint === true && info.annotations.destructiveHint !== true) return undefined;
			if (await approve(event.toolName, summarize(event.input))) return undefined;
			return { block: true, reason: "The user declined this tool call in BTW." };
		});
	};
}

/** Pi does not expose the main ModelRuntime to extensions; reuse it so providers/auth match exactly. */
export function mainModelRuntime(ctx: ExtensionCommandContext): ModelRuntime {
	const runtime = (ctx.modelRegistry as unknown as { runtime?: Partial<ModelRuntime> }).runtime;
	// Duck-typed: the extension loader may evaluate its own copy of the SDK module, so instanceof is unreliable.
	if (typeof runtime?.streamSimple !== "function" || typeof runtime.getModel !== "function" || typeof runtime.checkAuth !== "function") {
		throw new Error("BTW plugins need Pi's model runtime, which this Pi version does not expose. Clear the allowlist with /btw-plugins.");
	}
	return runtime as ModelRuntime;
}

export interface BtwAgentOptions {
	allow: readonly string[];
	selfPath: string;
	cwd: string;
	runtime: ModelRuntime;
	/** Live set: tools trusted mid-run apply to later calls in the same run. */
	trusted: ReadonlySet<string>;
	prompt(question: string, instructions: string): string;
}

function visibleText(message: AssistantMessage): string {
	return message.content.filter(block => block.type === "text").map(block => block.text).join("\n").trim();
}

/**
 * Plugin-enabled engine: an in-memory side AgentSession seeded with the main branch, loading only
 * allowlisted plugins (their tools and hooks). Nothing is written to the main session.
 */
export function agentEngine(options: BtwAgentOptions): BtwEngine {
	return async ({ snapshot, topic, turn, instructions, signal, changed, approve }) => {
		const loader = new DefaultResourceLoader({
			cwd: options.cwd, agentDir: getAgentDir(),
			extensionFactories: [{ name: "btw-approval", hidden: true, factory: approvalGate(approve, options.trusted) }],
			extensionsOverride: base => filterBtwExtensions(base, options.allow, options.selfPath),
		});
		await loader.reload();
		if (signal.aborted) return undefined;
		const manager = SessionManager.inMemory(options.cwd, undefined, structuredClone(snapshot.entries));
		if (snapshot.transient) manager.appendMessage(structuredClone(snapshot.transient));
		for (const previous of topic.turns.slice(0, -1)) {
			if (previous.messages) for (const message of previous.messages) manager.appendMessage(structuredClone(message));
			else if (previous.answer) {
				manager.appendMessage({ role: "user", content: previous.question, timestamp: previous.createdAt });
				manager.appendMessage({ ...(previous.assistant ?? {
					role: "assistant", api: snapshot.model.api, provider: snapshot.model.provider, model: snapshot.model.id,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop" as const, timestamp: previous.updatedAt,
				}), content: [{ type: "text", text: previous.answer }] });
			}
		}
		const seeded = manager.getEntries().length;
		const { session } = await createAgentSession({
			cwd: options.cwd, agentDir: getAgentDir(), modelRuntime: options.runtime, model: snapshot.model,
			thinkingLevel: snapshot.thinkingLevel, resourceLoader: loader, sessionManager: manager,
			tools: btwToolNames(options.allow, loader.getExtensions()),
		});
		const abort = () => { void session.abort(); };
		signal.addEventListener("abort", abort, { once: true });
		const unsubscribe = session.subscribe(event => {
			if (signal.aborted) return;
			if (event.type === "message_update" && event.message.role === "assistant") {
				turn.answer = visibleText(event.message);
				turn.updatedAt = Date.now();
				changed();
			} else if (event.type === "tool_execution_start") {
				(turn.tools ??= []).push({ id: event.toolCallId, name: event.toolName, status: "running" });
				changed();
			} else if (event.type === "tool_execution_end") {
				const tool = turn.tools?.find(item => item.id === event.toolCallId);
				if (tool) tool.status = event.isError ? "error" : "done";
				changed();
			}
		});
		try {
			if (signal.aborted) return undefined;
			await session.bindExtensions({});
			if (signal.aborted) return undefined;
			await session.prompt(options.prompt(turn.question, instructions), { expandPromptTemplates: false, source: "extension" });
			if (signal.aborted) return undefined;
			const final = session.messages.findLast((message): message is AssistantMessage => message.role === "assistant");
			if (!final) throw new Error("The side request ended without a reply.");
			const messages = manager.getEntries().slice(seeded).flatMap(entry => entry.type === "message" ? [entry.message as BtwMessage] : []);
			return { assistant: structuredClone(final), messages: structuredClone(messages) };
		} finally {
			signal.removeEventListener("abort", abort);
			unsubscribe();
			session.dispose();
		}
	};
}
