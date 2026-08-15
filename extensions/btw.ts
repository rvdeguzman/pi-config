import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	buildSessionContext,
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	Input,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Focusable,
	type TUI,
} from "@earendil-works/pi-tui";
// ponytail: package-internal import; replace when pi exposes parent request hooks to nested completions.
import { injectBillingHeader } from "../npm/node_modules/pi-claude-auth/dist/transforms.js";

const CONFIG_PATH = join(process.env.HOME ?? "", ".pi/agent/btw-role.json");
const SYSTEM_PROMPT = `Answer the user's temporary side question using the supplied main and side conversations as context.
Be concise and direct. This is separate from the main conversation. You have no tools and must not claim to inspect or change files.`;
const TOGGLE_KEY = Key.alt("/");

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
interface Config {
	provider: string;
	model: string;
	thinkingLevel?: ThinkingLevel;
}
interface Exchange {
	question: string;
	answer?: string;
	error?: string;
}

function responseText(message: { content: Array<{ type: string; text?: string }> }): string {
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

class BtwWindow implements Focusable {
	private readonly input = new Input();
	private offset = 0;
	private pageSize = 12;
	private followEnd = true;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(
		private readonly tui: TUI,
		private readonly theme: ExtensionContext["ui"]["theme"],
		private readonly exchanges: () => Exchange[],
		private readonly status: () => string,
		private readonly model: () => string,
		private readonly submit: (question: string) => void,
		private readonly close: () => void,
	) {
		this.input.onSubmit = (value) => {
			const question = value.trim();
			if (!question) return;
			this.input.setValue("");
			this.submit(question);
		};
		this.input.onEscape = close;
	}

	private transcript(width: number): string[] {
		if (!this.exchanges().length) return [this.theme.fg("dim", "Ask a side question below.")];
		const lines: string[] = [];
		const add = (label: string, text: string, color: "accent" | "muted" | "error") => {
			lines.push(this.theme.fg(color, label));
			for (const line of text.split("\n")) {
				lines.push(...wrapTextWithAnsi(line || " ", Math.max(1, width - 2)).map((part) => `  ${part}`));
			}
		};
		for (const [index, exchange] of this.exchanges().entries()) {
			if (index) lines.push("");
			add("you", exchange.question, "muted");
			if (exchange.answer !== undefined) add("luna", exchange.answer || "(No text response)", "accent");
			else if (exchange.error) add("error", exchange.error, "error");
			else add("luna", "answering…", "accent");
		}
		return lines;
	}

	private fill(text: string, width: number): string {
		const clipped = truncateToWidth(text, width, "");
		return this.theme.bg("customMessageBg", `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`);
	}

	handleInput(data: string): void {
		if (matchesKey(data, TOGGLE_KEY) || matchesKey(data, Key.escape)) return this.close();
		if (matchesKey(data, Key.up) || matchesKey(data, Key.pageUp)) {
			this.followEnd = false;
			this.offset = Math.max(0, this.offset - (matchesKey(data, Key.pageUp) ? this.pageSize : 1));
		} else if (matchesKey(data, Key.down) || matchesKey(data, Key.pageDown)) {
			this.offset += matchesKey(data, Key.pageDown) ? this.pageSize : 1;
		} else {
			this.input.handleInput(data);
		}
		this.tui.requestRender();
	}

	render(width: number): string[] {
		const contentWidth = Math.max(1, width - 2);
		const transcript = this.transcript(contentWidth);
		this.pageSize = Math.max(5, Math.min(14, Math.floor((process.stdout.rows ?? 30) * 0.6) - 5));
		const maxOffset = Math.max(0, transcript.length - this.pageSize);
		if (this.followEnd) this.offset = maxOffset;
		else this.offset = Math.min(this.offset, maxOffset);
		const hidden = maxOffset ? `  ↑${this.offset} ↓${maxOffset - this.offset}` : "";
		const rule = this.theme.fg("borderMuted", "─".repeat(width));
		const input = this.input.render(contentWidth)[0] ?? "";
		return [
			this.fill(this.theme.fg("accent", ` btw`) + this.theme.fg("dim", `  ${this.model()}  ${this.status()}${hidden}`), width),
			rule,
			...transcript.slice(this.offset, this.offset + this.pageSize).map((line) => this.fill(` ${line}`, width)),
			rule,
			this.fill(` ${input}`, width),
			this.fill(this.theme.fg("dim", " enter send · ↑↓ scroll · alt+/ or esc close"), width),
		];
	}

	invalidate(): void {
		this.input.invalidate();
	}
}

export default function btwExtension(pi: ExtensionAPI) {
	let exchanges: Exchange[] = [];
	let status = "ready";
	let modelLabel = "luna";
	let running = false;
	let requestId = 0;
	let abortController: AbortController | undefined;
	let closeWindow: (() => void) | undefined;
	let refreshWindow: (() => void) | undefined;
	let disposed = false;

	async function showWindow(ctx: ExtensionContext): Promise<void> {
		if (closeWindow) return closeWindow();
		try {
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				const close = () => done();
				const window = new BtwWindow(
					tui,
					theme,
					() => exchanges,
					() => status,
					() => modelLabel,
					(question) => {
						close();
						void runBtw(ctx, question);
					},
					close,
				);
				closeWindow = close;
				refreshWindow = () => tui.requestRender();
				return window;
			}, {
				overlay: true,
				overlayOptions: {
					width: "68%",
					minWidth: 56,
					maxHeight: "72%",
					anchor: "top-center",
					margin: { top: 2, left: 2, right: 2 },
				},
			});
		} catch (cause) {
			if (!disposed) ctx.ui.notify(`BTW window failed: ${cause instanceof Error ? cause.message : cause}`, "error");
		} finally {
			closeWindow = undefined;
			refreshWindow = undefined;
		}
	}

	async function runBtw(ctx: ExtensionContext, question: string): Promise<void> {
		if (running) {
			status = "already answering";
			refreshWindow?.();
			return;
		}

		let config: Config;
		try {
			config = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as Config;
		} catch {
			if (disposed) return;
			status = "invalid role config";
			ctx.ui.notify(`Invalid or missing config: ${CONFIG_PATH}`, "error");
			return;
		}
		if (disposed) return;
		const model = config.provider && config.model ? ctx.modelRegistry.find(config.provider, config.model) : undefined;
		if (!model) {
			status = "unknown model";
			ctx.ui.notify(`Unknown BTW model: ${config.provider}/${config.model}`, "error");
			return;
		}

		modelLabel = config.model.replace(/^gpt-/, "");
		const exchange: Exchange = { question };
		exchanges.push(exchange);
		status = "answering…";
		running = true;
		const id = ++requestId;
		abortController = new AbortController();
		refreshWindow?.();

		const sideThread = exchanges.slice(0, -1)
			.map((item) => `User: ${item.question}\nAssistant: ${item.answer ?? `(failed: ${item.error ?? "unknown error"})`}`)
			.join("\n\n---\n\n");
		const messages = convertToLlm(
			buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages,
		);
		messages.push({
			role: "user",
			content: [{
				type: "text",
				text: sideThread ? `Temporary side conversation so far:\n\n${sideThread}\n\nCurrent side question:\n${question}` : question,
			}],
			timestamp: Date.now(),
		});

		try {
			const response = await ctx.modelRegistry.complete(model, { systemPrompt: SYSTEM_PROMPT, messages }, {
				signal: abortController.signal,
				cacheRetention: "none",
				sessionId: randomUUID(),
				...(config.thinkingLevel && config.thinkingLevel !== "off" ? { reasoningEffort: config.thinkingLevel } : {}),
				onPayload: (payload) =>
					model.provider === "anthropic" && ctx.modelRegistry.isUsingOAuth(model)
						? injectBillingHeader(payload)
						: undefined,
			});
			if (disposed || id !== requestId) return;
			if (response.stopReason === "aborted") throw new Error("Cancelled");
			if (response.stopReason === "error") throw new Error(response.errorMessage || "Request failed");
			exchange.answer = responseText(response);
			status = "ready";
			ctx.ui.notify("BTW answer ready · Alt+/ to view", "info");
		} catch (cause) {
			if (disposed || id !== requestId) return;
			exchange.error = cause instanceof Error ? cause.message : String(cause);
			status = "failed";
			ctx.ui.notify(`BTW failed: ${exchange.error}`, "error");
		} finally {
			if (id === requestId) {
				running = false;
				abortController = undefined;
				refreshWindow?.();
			}
		}
	}

	pi.on("session_start", () => {
		exchanges = [];
		status = "ready";
		modelLabel = "luna";
		disposed = false;
	});
	pi.on("session_shutdown", () => {
		disposed = true;
		abortController?.abort();
		closeWindow?.();
	});

	pi.registerShortcut(TOGGLE_KEY, {
		description: "Show or hide the BTW window",
		handler: showWindow,
	});
	pi.registerCommand("btw", {
		description: "Ask a background side question, or show/hide its window",
		handler: async (args, ctx) => {
			const question = args.trim();
			if (!question) return showWindow(ctx);
			void runBtw(ctx, question);
		},
	});
	pi.registerCommand("btw:clear", {
		description: "Cancel and clear the in-memory BTW thread",
		handler: async (_args, ctx) => {
			requestId++;
			abortController?.abort();
			abortController = undefined;
			running = false;
			exchanges = [];
			status = "ready";
			closeWindow?.();
			ctx.ui.notify("Cleared BTW thread.", "info");
		},
	});
}
