import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	BorderedLoader,
	buildSessionContext,
	convertToLlm,
	getMarkdownTheme,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Key, Markdown, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
// ponytail: package-internal import; replace when pi exposes parent request hooks to nested completions.
import { injectBillingHeader } from "../npm/node_modules/pi-claude-auth/dist/transforms.js";

const CONFIG_PATH = join(process.env.HOME ?? "", ".pi/agent/btw-role.json");
const SYSTEM_PROMPT = `Answer the user's temporary side question using the supplied conversation as context.
Be concise and direct. This is separate from the main conversation. You have no tools and must not claim to inspect or change files.`;

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
interface Config {
	provider: string;
	model: string;
	thinkingLevel?: ThinkingLevel;
}

function textOf(message: { content: Array<{ type: string; text?: string }> }): string {
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

export default function btwExtension(pi: ExtensionAPI) {
	pi.registerCommand("btw", {
		description: "Ask a temporary side question with the configured lightweight model",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/btw requires interactive mode", "error");
				return;
			}

			const question = args.trim() || (await ctx.ui.input("BTW", "Ask a side question"))?.trim();
			if (!question) return;

			let config: Config;
			try {
				config = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as Config;
			} catch {
				ctx.ui.notify(`Invalid or missing config: ${CONFIG_PATH}`, "error");
				return;
			}

			const model = config.provider && config.model
				? ctx.modelRegistry.find(config.provider, config.model)
				: undefined;
			if (!model) {
				ctx.ui.notify(`Unknown BTW model: ${config.provider}/${config.model}`, "error");
				return;
			}

			const messages = convertToLlm(
				buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages,
			);
			messages.push({
				role: "user",
				content: [{ type: "text", text: question }],
				timestamp: Date.now(),
			});

			let error: string | undefined;
			const answer = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
				const loader = new BorderedLoader(tui, theme, `BTW · ${config.provider}/${config.model}`);
				loader.onAbort = () => done(null);

				ctx.modelRegistry.complete(
					model,
					{ systemPrompt: SYSTEM_PROMPT, messages },
					{
						signal: loader.signal,
						cacheRetention: "none",
						sessionId: randomUUID(),
						...(config.thinkingLevel && config.thinkingLevel !== "off"
							? { reasoningEffort: config.thinkingLevel }
							: {}),
						onPayload: (payload) =>
							model.provider === "anthropic" && ctx.modelRegistry.isUsingOAuth(model)
								? injectBillingHeader(payload)
								: undefined,
					},
				).then((response) => done(response.stopReason === "aborted" ? null : textOf(response)))
					.catch((cause) => {
						error = cause instanceof Error ? cause.message : String(cause);
						done(null);
					});

				return loader;
			}, {
				overlay: true,
				overlayOptions: { anchor: "top-center", width: "60%", minWidth: 48, maxHeight: "80%", margin: 2 },
			});

			if (answer === null) {
				ctx.ui.notify(error ? `BTW failed: ${error}` : "BTW cancelled", error ? "error" : "info");
				return;
			}

			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				const markdown = new Markdown(answer || "(No text response)", 1, 0, getMarkdownTheme());
				let offset = 0;

				return {
					render(width) {
						const body = markdown.render(width);
						const pageSize = Math.max(4, Math.floor(tui.terminal.rows * 0.65) - 4);
						offset = Math.min(offset, Math.max(0, body.length - pageSize));
						const footer = body.length > pageSize ? "↑↓/PgUp/PgDn scroll · Esc close" : "Esc close";
						return [
							theme.fg("accent", theme.bold(truncateToWidth(` BTW · ${config.provider}/${config.model}`, width))),
							...body.slice(offset, offset + pageSize),
							theme.fg("dim", truncateToWidth(` ${footer}`, width)),
						];
					},
					handleInput(data) {
						const pageSize = Math.max(4, Math.floor(tui.terminal.rows * 0.65) - 4);
						if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) done();
						else if (matchesKey(data, Key.up)) offset = Math.max(0, offset - 1);
						else if (matchesKey(data, Key.down)) offset += 1;
						else if (matchesKey(data, Key.pageUp)) offset = Math.max(0, offset - pageSize);
						else if (matchesKey(data, Key.pageDown)) offset += pageSize;
						tui.requestRender();
					},
					invalidate: () => markdown.invalidate(),
				};
			}, {
				overlay: true,
				overlayOptions: { anchor: "top-center", width: "70%", minWidth: 52, maxHeight: "80%", margin: 2 },
			});
		},
	});
}
