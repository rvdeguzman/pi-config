import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CONFIG_PATH = join(process.env.HOME ?? "", ".pi/agent/commit-role.json");
const CONVENTIONAL = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)\r\n]+\))?!?: .+/;

interface Config {
	provider: string;
	model: string;
	thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

const SYSTEM_PROMPT = `Write a Conventional Commit message for the staged Git changes.

Rules:
- First line must be: type(optional-scope): concise imperative summary
- Allowed types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert
- Add a body only when it explains important context not obvious from the subject
- Describe only the supplied diff
- Output only the commit message, with no Markdown fences or commentary`;

export default function commitExtension(pi: ExtensionAPI) {
	pi.registerCommand("commit", {
		description: "Stage everything and commit with the configured commit-role model",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) throw new Error("/commit requires an interactive UI");

			let config: Config;
			try {
				config = JSON.parse(await readFile(CONFIG_PATH, "utf8")) as Config;
			} catch {
				ctx.ui.notify(`Invalid or missing config: ${CONFIG_PATH}`, "error");
				return;
			}

			if (!config.provider || !config.model) {
				ctx.ui.notify(`Config needs provider and model: ${CONFIG_PATH}`, "error");
				return;
			}
			const model = ctx.modelRegistry.find(config.provider, config.model);
			if (!model) {
				ctx.ui.notify(`Unknown commit model: ${config.provider}/${config.model}`, "error");
				return;
			}

			const root = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: ctx.cwd });
			if (root.code !== 0) {
				ctx.ui.notify("Not inside a Git repository", "error");
				return;
			}
			const cwd = root.stdout.trim();
			const staged = await pi.exec("git", ["add", "-A"], { cwd });
			if (staged.code !== 0) {
				ctx.ui.notify(staged.stderr.trim() || "git add failed", "error");
				return;
			}

			const diff = await pi.exec("git", ["diff", "--cached", "--no-ext-diff", "--no-color"], { cwd });
			if (diff.code !== 0) {
				ctx.ui.notify(diff.stderr.trim() || "Could not read staged diff", "error");
				return;
			}
			if (!diff.stdout.trim()) {
				ctx.ui.notify("Nothing to commit", "info");
				return;
			}
			const history = await pi.exec("git", ["log", "-10", "--pretty=format:%s"], { cwd });
			ctx.ui.notify(`Generating commit message with ${config.provider}/${config.model}…`, "info");

			const message: Message = {
				role: "user",
				content: [{
					type: "text",
					text: `Recent commit subjects:\n${history.stdout || "(none)"}\n\nStaged diff:\n${diff.stdout}`,
				}],
				timestamp: Date.now(),
			};
			let response;
			try {
				response = await ctx.modelRegistry.complete(
					model,
					{ systemPrompt: SYSTEM_PROMPT, messages: [message] },
					{
						cacheRetention: "none",
						sessionId: uuidv7(),
						...(config.thinkingLevel && config.thinkingLevel !== "off"
							? { reasoningEffort: config.thinkingLevel }
							: {}),
					},
				);
			} catch (error) {
				ctx.ui.notify(`Commit message generation failed: ${error instanceof Error ? error.message : error}`, "error");
				return;
			}

			const commitMessage = response.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join("\n")
				.trim()
				.replace(/^```(?:text)?\s*|\s*```$/g, "")
				.trim();
			if (!CONVENTIONAL.test(commitMessage.split("\n", 1)[0] ?? "")) {
				ctx.ui.notify(`Model returned an invalid Conventional Commit message:\n${commitMessage}`, "error");
				return;
			}
			const committed = await pi.exec("git", ["commit", "-m", commitMessage], { cwd });
			if (committed.code !== 0) {
				ctx.ui.notify(committed.stderr.trim() || committed.stdout.trim() || "git commit failed", "error");
				return;
			}
			ctx.ui.notify(committed.stdout.trim(), "info");
		},
	});
}
