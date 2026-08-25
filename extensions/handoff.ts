/*
 * Handoff extension - transfer context to a new focused session
 *
 * Instead of compacting (which is lossy), handoff extracts what matters
 * for your next task and creates a new session with a generated prompt.
 *
 * Usage:
 *   /artifact [goal]
 *   /handoff <goal for new thread>
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Message, uuidv7 } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	BorderedLoader,
	convertToLlm,
	serializeConversation,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";

const SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused prompt that:

1. Summarizes relevant context from the conversation (decisions made, approaches taken, key findings)
2. Lists any relevant files that were discussed or modified
3. Clearly states the next task based on the user's goal
4. Is self-contained - the new thread should be able to proceed without the old conversation

Format your response as a prompt the user can send to start the new thread. Be concise but include all necessary context. Do not include any preamble like "Here's the prompt" - just output the prompt itself.

Example output format:
## Context
We've been working on X. Key decisions:
- Decision 1
- Decision 2

Files involved:
- path/to/file1.ts
- path/to/file2.ts

## Task
[Clear description of what to do next based on user's goal]`;

/** Shared by /handoff and /artifact: returns the generated prompt, or null if cancelled/failed. */
async function generateHandoff(ctx: ExtensionCommandContext, goal: string): Promise<string | null> {
	const messages = ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages);

	if (messages.length === 0) {
		ctx.ui.notify("No conversation to hand off", "error");
		return null;
	}

	const conversationText = serializeConversation(convertToLlm(messages));

	return await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const loader = new BorderedLoader(tui, theme, "Generating handoff prompt...");
		loader.onAbort = () => done(null);

		const doGenerate = async () => {
			const userMessage: Message = {
				role: "user",
				content: [
					{
						type: "text",
						text: `## Conversation History\n\n${conversationText}\n\n## User's Goal for New Thread\n\n${goal}`,
					},
				],
				timestamp: Date.now(),
			};

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model!);
			if (!auth.ok) {
				throw new Error(auth.error);
			}
			const response = await completeSimple(
				ctx.model!,
				{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
				{
					apiKey: auth.apiKey,
					env: auth.env,
					headers: auth.headers,
					maxTokens: 4_000,
					signal: loader.signal,
					cacheRetention: "none",
					sessionId: uuidv7(),
				},
			);

			if (response.stopReason === "aborted") {
				return null;
			}

			return response.content
				.filter((content): content is { type: "text"; text: string } => content.type === "text")
				.map((content) => content.text)
				.join("\n");
		};

		doGenerate()
			.then(done)
			.catch((error) => {
				console.error("Handoff generation failed:", error);
				done(null);
			});

		return loader;
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("artifact", {
		description: "Write the current context to .tmp/ as a Markdown handoff document",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("artifact requires interactive mode", "error");
				return;
			}
			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			const goal = args.trim() || "Snapshot the current context for later resumption. No specific next task yet.";
			const result = await generateHandoff(ctx, goal);
			if (result === null) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			const directory = join(ctx.cwd, ".tmp");
			mkdirSync(directory, { recursive: true });
			const file = join(directory, `handoff-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
			writeFileSync(file, `${result}\n`);
			ctx.ui.notify(`Wrote ${file}`, "info");
		},
	});

	pi.registerCommand("handoff", {
		description: "Transfer context to a new focused session",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("handoff requires interactive mode", "error");
				return;
			}
			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			const goal = args.trim();
			if (!goal) {
				ctx.ui.notify("Usage: /handoff <goal for new thread>", "error");
				return;
			}

			const currentSessionFile = ctx.sessionManager.getSessionFile();
			const result = await generateHandoff(ctx, goal);
			if (result === null) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			const editedPrompt = await ctx.ui.editor("Edit handoff prompt", result);
			if (editedPrompt === undefined) {
				ctx.ui.notify("Cancelled", "info");
				return;
			}

			const newSessionResult = await ctx.newSession({
				parentSession: currentSessionFile,
				withSession: async (replacementCtx) => {
					replacementCtx.ui.setEditorText(editedPrompt);
					replacementCtx.ui.notify("Handoff ready. Submit when ready.", "info");
				},
			});

			if (newSessionResult.cancelled) {
				ctx.ui.notify("New session cancelled", "info");
			}
		},
	});
}
