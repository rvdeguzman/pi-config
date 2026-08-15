import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CONTINUE_PROMPT = `<system-notice>
Continue.

- Resume the most recent intent and carry unfinished work to completion.
- If interrupted mid-step, pick it back up.
- Do not summarize or ask for confirmation; continue working.
</system-notice>`;

export default function continueShortcut(pi: ExtensionAPI) {
	pi.on("input", async (event) => {
		if (event.source === "extension" || ![".", "c"].includes(event.text.trim())) {
			return { action: "continue" };
		}

		await pi.sendMessage(
			{ customType: "manual-continue", content: CONTINUE_PROMPT, display: false },
			{ triggerTurn: true, deliverAs: "steer" },
		);
		return { action: "handled" };
	});
}
