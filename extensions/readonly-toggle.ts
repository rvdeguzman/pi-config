/**
 * Readonly Toggle Extension
 *
 * /readonly toggles a session-local readonly mode. While on, blocks tool
 * calls that write files (w: write/edit) or run shell commands (x: bash).
 * Read is always allowed (r).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	// r is always on (no read blocking exists); w/x reflect actual blocking state.
	const perms = { w: true, x: true };

	function status(ctx: { ui: { theme: any; setStatus: (k: string, v: string | undefined) => void } }) {
		const theme = ctx.ui.theme;
		const text = `r${perms.w ? "w" : "-"}${perms.x ? "x" : "-"}`;
		const allOn = perms.w && perms.x;
		ctx.ui.setStatus("readonly", theme.fg(allOn ? "dim" : "warning", text));
		pi.events.emit("readonly:changed", text);
	}

	pi.on("session_start", async (_event, ctx) => status(ctx));

	pi.registerCommand("readonly", {
		description: "Toggle readonly mode (blocks write/edit/bash)",
		handler: async (_args, ctx) => {
			const on = perms.w || perms.x;
			perms.w = perms.x = !on;
			status(ctx);
			ctx.ui.notify?.(`Readonly mode ${!on ? "ON" : "OFF"}`, "info");
		},
	});

	pi.on("tool_call", async (event) => {
		if (event.toolName === "write" || event.toolName === "edit") {
			if (!perms.w) return { block: true, reason: "Write blocked (readonly). /readonly to disable" };
		}
		if (event.toolName === "bash") {
			if (!perms.x) return { block: true, reason: "Bash blocked (readonly). /readonly to disable" };
		}
		return undefined;
	});
}
