import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatQuota, type QuotaPayload, type Win } from "./quota.ts";

type QuotaValue = string | readonly Win[] | QuotaPayload;

const isQuotaPayload = (v: unknown): v is QuotaPayload =>
	typeof v === "object" && v !== null && Array.isArray((v as QuotaPayload).wins);

/**
 * Render the quota text. A {@link QuotaPayload} is formatted here, at render time, so
 * the reset countdown ticks with the footer (every repaint, and at least every 2s)
 * instead of needing a repaint timer inside quota.ts. `showReset` comes from the
 * payload because this file may be a separate module copy with its own stale flag.
 */
function renderQuotaText(quota: QuotaValue): string {
	if (typeof quota === "string") return quota;
	if (isQuotaPayload(quota)) return formatQuota(quota.wins, Date.now(), quota.showReset);
	return formatQuota(quota);
}

const dirtyCache = new Map<string, { dirty: boolean; expires: number }>();

/** Uncommitted-changes flag for cwd. Not fs-watched by pi, so this stays its own 2s-cached shellout. */
export function isDirty(cwd: string, now = Date.now()) {
	const cached = dirtyCache.get(cwd);
	if (cached && cached.expires > now) return cached.dirty;

	let dirty = false;
	try {
		dirty = execSync("git status --porcelain", { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim().length > 0;
	} catch {
		// not a git repo, or git not installed → skip decoration
	}

	dirtyCache.set(cwd, { dirty, expires: now + 2000 });
	return dirty;
}

/** " (branch*)" suffix, or "" outside a repo. Branch itself comes from pi's fs-watched FooterDataProvider. */
export function formatGitSuffix(cwd: string, branch: string | null) {
	return branch ? ` (${branch}${isDirty(cwd) ? "*" : ""})` : "";
}

export function formatTokens(count: number | null | undefined) {
	if (count == null) return "?";
	if (count < 1_000) return `${count}`;
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

export function formatFooter(
	ctx: ExtensionContext,
	width: number,
	priorityEnabled: boolean,
	quota: QuotaValue = "",
	gitBranch: string | null = null,
) {
	let cacheHitRate: number | undefined;

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const usage = entry.message.usage;
		const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
		if (promptTokens > 0) cacheHitRate = (usage.cacheRead / promptTokens) * 100;
	}

	const home = homedir();
	const cwd =
		(ctx.cwd === home ? "~" : ctx.cwd.startsWith(home + sep) ? `~${ctx.cwd.slice(home.length)}` : ctx.cwd) +
		formatGitSuffix(ctx.cwd, gitBranch);
	const context = ctx.getContextUsage();
	const model = ctx.model;
	const cache = cacheHitRate == null ? "ch?" : `ch${cacheHitRate.toFixed(1)}%`;
	const tokens = `${formatTokens(context?.tokens)}/${formatTokens(context?.contextWindow ?? model?.contextWindow)}`;
	const percent = context?.percent == null ? "?" : `${context.percent.toFixed(1)}%`;
	const fast = model?.provider === "openai-codex" && priorityEnabled ? " fast" : "";
	const thinking = model?.reasoning ? ` ${ctx.thinkingLevel ?? "off"}` : "";
	const left = `${cache} ${tokens} ${percent}`;
	const right = `${model?.id ?? "no-model"}${fast}${thinking}`;
	const shownRight = truncateToWidth(right, width, "");
	const shownCwd = truncateToWidth(cwd, Math.max(0, width - visibleWidth(shownRight) - 2), "");
	const topPadding = " ".repeat(Math.max(0, width - visibleWidth(shownCwd) - visibleWidth(shownRight)));
	const shownLeft = truncateToWidth(left, width, "");
	const quotaText = renderQuotaText(quota);
	const shownQuota = truncateToWidth(quotaText, Math.max(0, width - visibleWidth(shownLeft) - (quotaText ? 2 : 0)), "");
	const padding = shownQuota ? " ".repeat(Math.max(0, width - visibleWidth(shownLeft) - visibleWidth(shownQuota))) : "";

	return [shownCwd + topPadding + shownRight, shownLeft + padding + shownQuota];
}

export default function minimalFooter(pi: ExtensionAPI) {
	let priorityEnabled = true;
	let quota: QuotaValue = "";
	let requestRender = () => {};
	const unsubscribe = pi.events.on("openai-codex-priority:changed", (enabled) => {
		if (typeof enabled !== "boolean") return;
		priorityEnabled = enabled;
		requestRender();
	});
	const unsubscribeQuota = pi.events.on("quota:changed", (value) => {
		if (typeof value !== "string" && !Array.isArray(value) && !isQuotaPayload(value)) return;
		quota = value as QuotaValue;
		requestRender();
	});
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			const unsubBranch = footerData?.onBranchChange(requestRender);
			const tick = setInterval(requestRender, 2000); // dirty flag isn't fs-watched, poll it
			return {
				dispose: () => {
					clearInterval(tick);
					unsubBranch?.();
					requestRender = () => {};
				},
				invalidate() {},
				render: (width) =>
					formatFooter(ctx, width, priorityEnabled, quota, footerData?.getGitBranch() ?? null).map((line) =>
						theme.fg("dim", line),
					),
			};
		});
	});

	pi.on("session_shutdown", () => {
		unsubscribe();
		unsubscribeQuota();
	});
}
