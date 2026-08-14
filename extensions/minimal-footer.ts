import { homedir } from "node:os";
import { sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export function formatTokens(count: number | null | undefined) {
	if (count == null) return "?";
	if (count < 1_000) return `${count}`;
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

export function formatFooter(ctx: ExtensionContext, width: number, priorityEnabled: boolean, quota = "") {
	let cacheHitRate: number | undefined;

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const usage = entry.message.usage;
		const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
		if (promptTokens > 0) cacheHitRate = (usage.cacheRead / promptTokens) * 100;
	}

	const home = homedir();
	const cwd = ctx.cwd === home ? "~" : ctx.cwd.startsWith(home + sep) ? `~${ctx.cwd.slice(home.length)}` : ctx.cwd;
	const context = ctx.getContextUsage();
	const model = ctx.model;
	const subscription = model && (model.provider === "kimi-coding" || ctx.modelRegistry.isUsingOAuth(model));
	const cache = cacheHitRate == null ? "CH?" : `CH${cacheHitRate.toFixed(1)}%`;
	const tokens = `${formatTokens(context?.tokens)}/${formatTokens(context?.contextWindow ?? model?.contextWindow)}`;
	const percent = context?.percent == null ? "?" : `${context.percent.toFixed(1)}%`;
	const fast = model?.provider === "openai-codex" && priorityEnabled ? "⚡" : "";
	const thinking = model?.reasoning ? ` • ${ctx.thinkingLevel ?? "off"}` : "";
	const left = `${cache}${subscription ? " (sub)" : ""} ${tokens} ${percent}${quota ? ` │ ${quota}` : ""}`;
	const right = `${fast}${model?.id ?? "no-model"}${thinking}`;
	const shownLeft = truncateToWidth(left, width, "");
	const shownRight = truncateToWidth(right, Math.max(0, width - visibleWidth(shownLeft) - 2), "");
	const padding = " ".repeat(Math.max(0, width - visibleWidth(shownLeft) - visibleWidth(shownRight)));

	return [truncateToWidth(cwd, width, ""), shownLeft + padding + shownRight];
}

export default function minimalFooter(pi: ExtensionAPI) {
	let priorityEnabled = true;
	let quota = "";
	let requestRender = () => {};
	const unsubscribe = pi.events.on("openai-codex-priority:changed", (enabled) => {
		if (typeof enabled !== "boolean") return;
		priorityEnabled = enabled;
		requestRender();
	});
	const unsubscribeQuota = pi.events.on("quota:changed", (text) => {
		if (typeof text !== "string") return;
		quota = text;
		requestRender();
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setFooter((tui, theme) => {
			requestRender = () => tui.requestRender();
			return {
				dispose: () => (requestRender = () => {}),
				invalidate() {},
				render: (width) => formatFooter(ctx, width, priorityEnabled, quota).map((line) => theme.fg("dim", line)),
			};
		});
	});

	pi.on("session_shutdown", () => {
		unsubscribe();
		unsubscribeQuota();
	});
}
