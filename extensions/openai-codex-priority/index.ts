import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyPriority, getPriorityEnabled, setPriorityEnabled } from "./payload.ts";

const stateFile = join(getAgentDir(), "openai-codex-priority.json");
const priorityEvent = "openai-codex-priority:changed";

export default function (pi: ExtensionAPI) {
	setPriorityEnabled(true);
	try {
		setPriorityEnabled((JSON.parse(readFileSync(stateFile, "utf8")) as { enabled?: boolean }).enabled !== false);
	} catch {}

	const publish = () => pi.events.emit(priorityEvent, getPriorityEnabled());
	pi.on("session_start", publish);

	pi.registerCommand("fast", {
		description: "Toggle OpenAI Codex fast mode (on|off|status)",
		handler: (args, ctx) => {
			const action = args.trim().toLowerCase() || "toggle";
			if (action === "status") {
				ctx.ui.notify(`OpenAI Codex fast mode: ${getPriorityEnabled() ? "ON" : "OFF"}`, "info");
				return;
			}
			if (!["on", "off", "toggle"].includes(action)) {
				ctx.ui.notify("Usage: /fast [on|off|toggle|status]", "warning");
				return;
			}

			const next = action === "toggle" ? !getPriorityEnabled() : action === "on";
			try {
				writeFileSync(stateFile, `${JSON.stringify({ enabled: next })}\n`, "utf8");
				setPriorityEnabled(next);
				publish();
				ctx.ui.notify(`OpenAI Codex fast mode: ${next ? "ON" : "OFF"}`, "info");
			} catch (error) {
				ctx.ui.notify(`Could not save fast mode: ${String(error)}`, "error");
			}
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider === "openai-codex") return applyPriority(event.payload, getPriorityEnabled());
	});
}
