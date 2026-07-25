/**
 * herdr-blocked: emits `herdr:blocked` so herdr shows "needs input" for pi.
 *
 * Companion to the managed herdr-agent-state.ts integration (which listens on
 * pi's event bus for `herdr:blocked` {active, label} and refcounts them).
 * Two sources of "blocked":
 *
 * 1. Dialogs — ctx.ui is one shared object across all extensions
 *    (runner.uiContext), so wrapping its blocking methods here intercepts
 *    every dialog any extension opens (pi-subagents clarify, login prompts,
 *    questionnaires, ...). Blocked while the dialog is open.
 *
 * 2. Chat questions — e.g. the grilling skill ends its turn with a question.
 *    Lifecycle-wise that is just `idle`, so on agent_settled we check whether
 *    the last assistant message ends in a question and mark blocked until the
 *    next user input or agent run.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CHANNEL = "herdr:blocked";
const PATCHED = Symbol.for("herdr-blocked.patched");

function herdrEnabled() {
	return (
		process.env.HERDR_ENV === "1" &&
		!!process.env.HERDR_SOCKET_PATH &&
		!!process.env.HERDR_PANE_ID
	);
}

function shortLabel(text: unknown, fallback: string) {
	if (typeof text !== "string" || text.trim() === "") return fallback;
	const line = text.trim().split("\n")[0]!;
	return line.length > 60 ? `${line.slice(0, 57)}...` : line;
}

/** True when the trailing lines of the assistant's reply look like a question. */
function endsWithQuestion(text: string) {
	const lines = text
		.trim()
		.split("\n")
		.map((line) => line.replace(/[*_`>\s]+$/g, "").trim())
		.filter((line) => line !== "");
	return lines.slice(-2).some((line) => line.endsWith("?"));
}

function lastAssistantText(ctx: ExtensionContext) {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i -= 1) {
		const entry = branch[i]!;
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		return entry.message.content
			.filter((block: any) => block.type === "text")
			.map((block: any) => block.text)
			.join("\n");
	}
	return "";
}

export default function herdrBlocked(pi: ExtensionAPI) {
	if (!herdrEnabled()) return;

	const emit = (active: boolean, label?: string) =>
		pi.events.emit(CHANNEL, active ? { active: true, label } : { active: false });

	// --- 1. Dialog interception ------------------------------------------------

	function wrap<T extends (...args: any[]) => Promise<any>>(fn: T, label: (args: any[]) => string): T {
		return (async (...args: any[]) => {
			emit(true, label(args));
			try {
				return await fn(...args);
			} finally {
				emit(false);
			}
		}) as T;
	}

	function patchUi(ui: any) {
		if (!ui || ui[PATCHED]) return;
		ui[PATCHED] = true;
		if (typeof ui.confirm === "function")
			ui.confirm = wrap(ui.confirm, (a) => shortLabel(a[0], "confirm"));
		if (typeof ui.input === "function")
			ui.input = wrap(ui.input, (a) => shortLabel(a[0], "input"));
		if (typeof ui.select === "function")
			ui.select = wrap(ui.select, (a) => shortLabel(a[0], "select"));
		if (typeof ui.editor === "function")
			ui.editor = wrap(ui.editor, (a) => shortLabel(a[0], "editor"));
		if (typeof ui.custom === "function")
			ui.custom = wrap(ui.custom, () => "dialog open");
	}

	// --- 2. Turn-ending chat questions ----------------------------------------

	let questionPending = false;

	function clearQuestion() {
		if (!questionPending) return;
		questionPending = false;
		emit(false);
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode === "tui") patchUi(ctx.ui);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!ctx.isIdle() || questionPending) return;
		const text = lastAssistantText(ctx);
		if (text && endsWithQuestion(text)) {
			questionPending = true;
			emit(true, "waiting for your answer");
		}
	});

	// User typed (or an extension injected input) — question is being answered.
	pi.on("input", () => clearQuestion());
	pi.on("agent_start", () => clearQuestion());
	pi.on("session_shutdown", () => clearQuestion());
}
