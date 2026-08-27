/**
 * Pure utility functions for plan mode.
 * Extracted for testability.
 */

// Destructive commands blocked in plan mode
const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

// Safe read-only commands allowed in plan mode
const SAFE_PATTERNS = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*top\b/,
	/^\s*htop\b/,
	/^\s*free\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*curl\s/i,
	/^\s*wget\s+-O\s*-/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*eza\b/,
];

export function isSafeCommand(command: string): boolean {
	const isDestructive = DESTRUCTIVE_PATTERNS.some((p) => p.test(command));
	const isSafe = SAFE_PATTERNS.some((p) => p.test(command));
	return !isDestructive && isSafe;
}

export interface TodoItem {
	step: number;
	text: string;
	completed: boolean;
	todoId?: string;
}

export type StepSelectionResult = { steps: number[]; error?: undefined } | { steps?: undefined; error: string };

/** Parse selectors such as "1-3,5" against the current incomplete plan steps. */
export function parseStepSelection(selector: string, items: TodoItem[]): StepSelectionResult {
	const remaining = items.filter((item) => !item.completed);
	if (remaining.length === 0) return { error: "The plan has no incomplete steps." };

	const input = selector.trim().toLowerCase();
	if (input === "all" || input === "all remaining") {
		return { steps: remaining.map((item) => item.step) };
	}
	if (input.length === 0) return { error: "Enter a step range such as 1-3,5 or all." };

	const requested = new Set<number>();
	const maxStep = Math.max(...items.map((item) => item.step));
	for (const part of input.split(",")) {
		const token = part.trim();
		const match = token.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
		if (!match) return { error: `Invalid step selector: ${token || "(empty)"}. Use a range such as 1-3,5.` };

		const start = Number(match[1]);
		const end = Number(match[2] ?? match[1]);
		if (start < 1 || end < start) return { error: `Invalid step range: ${token}.` };
		if (start > maxStep || end > maxStep) {
			return { error: `Unknown plan step range: ${token}. The plan ends at step ${maxStep}.` };
		}
		for (let step = start; step <= end; step++) requested.add(step);
	}

	const knownSteps = new Set(items.map((item) => item.step));
	const unknown = [...requested].filter((step) => !knownSteps.has(step));
	if (unknown.length > 0) return { error: `Unknown plan step${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.` };

	const steps = remaining.filter((item) => requested.has(item.step)).map((item) => item.step);
	if (steps.length === 0) return { error: "Every selected step is already complete." };
	return { steps };
}

export function formatStepSelection(steps: number[]): string {
	if (steps.length === 0) return "";
	const sorted = [...new Set(steps)].sort((a, b) => a - b);
	const ranges: string[] = [];
	let start = sorted[0];
	let end = start;

	for (const step of sorted.slice(1)) {
		if (step === end + 1) {
			end = step;
			continue;
		}
		ranges.push(start === end ? `${start}` : `${start}-${end}`);
		start = step;
		end = step;
	}
	ranges.push(start === end ? `${start}` : `${start}-${end}`);
	return ranges.join(",");
}

export function cleanStepText(text: string): string {
	let cleaned = text
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1") // Remove bold/italic
		.replace(/`([^`]+)`/g, "$1") // Remove code
		.replace(
			/^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?/i,
			"",
		)
		.replace(/\s+/g, " ")
		.trim();

	if (cleaned.length > 0) {
		cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	}
	return cleaned;
}

export function extractTodoItems(message: string): TodoItem[] {
	const items: TodoItem[] = [];
	const headerMatch = message.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
	if (!headerMatch) return items;

	const planSection = message.slice(message.indexOf(headerMatch[0]) + headerMatch[0].length);
	const numberedPattern = /^\s*(\d+)[.)]\s+\*{0,2}([^*\n]+)/gm;

	for (const match of planSection.matchAll(numberedPattern)) {
		const text = match[2]
			.trim()
			.replace(/\*{1,2}$/, "")
			.trim();
		if (text.length > 5 && !text.startsWith("`") && !text.startsWith("/") && !text.startsWith("-")) {
			const cleaned = cleanStepText(text);
			if (cleaned.length > 3) {
				items.push({ step: items.length + 1, text: cleaned, completed: false });
			}
		}
	}
	return items;
}

export function extractDoneSteps(message: string): number[] {
	const steps: number[] = [];
	for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
		const step = Number(match[1]);
		if (Number.isFinite(step)) steps.push(step);
	}
	return steps;
}

export function markCompletedSteps(text: string, items: TodoItem[], allowedSteps?: readonly number[]): number {
	const allowed = allowedSteps ? new Set(allowedSteps) : undefined;
	const doneSteps = extractDoneSteps(text).filter((step) => !allowed || allowed.has(step));
	let completed = 0;
	for (const step of doneSteps) {
		const item = items.find((t) => t.step === step);
		if (item && !item.completed) {
			item.completed = true;
			completed++;
		}
	}
	return completed;
}
