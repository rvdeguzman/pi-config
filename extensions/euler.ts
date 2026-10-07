/**
 * Euler: a stripped-down working mode. `/e <task>` turns it on for the current
 * session branch and submits the task; while on, the Euler instructions from
 * skills/euler/SKILL.md (the single source of truth) are added to the system
 * prompt as their own section.
 *
 * State is a persisted custom entry on the session branch, so navigating the
 * tree or forking follows the branch: an abandoned branch's toggles never
 * affect the active one.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getAgentDir, stripFrontmatter, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const ENTRY_TYPE = "euler";
const STATUS_KEY = "euler";
const SECTION = "euler";
const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "euler");
const SKILL_PATH = join(SKILL_DIR, "SKILL.md");
const PLAYBOOK_DIR = join(SKILL_DIR, "playbooks");

interface BranchEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

/** The latest Euler toggle on this branch wins; no toggle means off. */
export function isEulerActive(branch: readonly BranchEntry[]): boolean {
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
			return (entry.data as { active?: unknown } | undefined)?.active === true;
		}
	}
	return false;
}

export default function euler(pi: ExtensionAPI): void {
	const active = (ctx: ExtensionContext) => isEulerActive(ctx.sessionManager.getBranch() as BranchEntry[]);

	const showStatus = (ctx: ExtensionContext, on = active(ctx)) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, on ? ctx.ui.theme.fg("accent", "euler") : undefined);
	};

	const setActive = (ctx: ExtensionContext, on: boolean) => {
		if (active(ctx) !== on) pi.appendEntry(ENTRY_TYPE, { active: on });
		showStatus(ctx, on);
	};

	pi.on("session_start", (_event, ctx) => showStatus(ctx));
	pi.on("session_tree", (_event, ctx) => showStatus(ctx));

	pi.on("before_agent_start", (event, ctx) => {
		if (!active(ctx)) return;
		// Read per run so edits to SKILL.md apply without /reload.
		const body = stripFrontmatter(readFileSync(SKILL_PATH, "utf8")).trim();
		// Approved rules from /corrections; follows the agent dir so tests stay isolated.
		const preferencesPath = join(getAgentDir(), "skills", "euler", "preferences.md");
		const preferences = existsSync(preferencesPath) ? readFileSync(preferencesPath, "utf8").trim() : "";
		event.systemPromptOptions.sections[SECTION] =
			`${body}\n\nPlaybook directory: ${PLAYBOOK_DIR}` + (preferences ? `\n\n## User preferences\n\n${preferences}` : "");
	});

	const handler = async (args: string, ctx: ExtensionContext) => {
		const input = args.trim();
		if (input === "off") {
			setActive(ctx, false);
			ctx.ui.notify("Euler off.", "info");
			return;
		}
		if (input === "status") {
			ctx.ui.notify(`Euler is ${active(ctx) ? "on" : "off"} for this session branch.`, "info");
			return;
		}
		setActive(ctx, true);
		if (!input) {
			ctx.ui.notify("Euler on.", "info");
			return;
		}
		if (ctx.isIdle()) pi.sendUserMessage(input);
		else pi.sendUserMessage(input, { deliverAs: "followUp" });
	};

	for (const name of ["e", "euler"]) {
		pi.registerCommand(name, {
			description:
				name === "e"
					? "Euler mode: /e <task> to turn on and send, /e off, /e status"
					: "Alias for /e: /euler <task>, /euler off, /euler status",
			getArgumentCompletions: (prefix: string) =>
				["off", "status"].filter((word) => word.startsWith(prefix.trim())).map((word) => ({ value: word, label: word })),
			handler,
		});
	}
}
