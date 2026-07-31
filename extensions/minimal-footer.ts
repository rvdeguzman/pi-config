import { homedir } from "node:os";
import { sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export function formatTokens(count: number | null | undefined) {
	if (count == null) return "?";
	if (count < 1_000) return `${count}`;
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

export function formatFooter(ctx: ExtensionContext, width: number) {
	let cost = 0;
	let cacheHitRate: number | undefined;

	for (const entry of ctx.sessionManager.getEntries()) {
		let usage;
		if (entry.type === "message" && entry.message.role === "assistant") {
			usage = entry.message.usage;
			const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
			if (promptTokens > 0) cacheHitRate = (usage.cacheRead / promptTokens) * 100;
		} else if (entry.type === "message" && entry.message.role === "toolResult") {
			usage = entry.message.usage;
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			usage = entry.usage;
		}
		if (usage) cost += usage.cost.total;
	}

	const home = homedir();
	const cwd = ctx.cwd === home ? "~" : ctx.cwd.startsWith(home + sep) ? `~${ctx.cwd.slice(home.length)}` : ctx.cwd;
	const context = ctx.getContextUsage();
	const model = ctx.model;
	const subscription = model && (model.provider === "kimi-coding" || ctx.modelRegistry.isUsingOAuth(model));
	const cache = cacheHitRate == null ? "CH?" : `CH${cacheHitRate.toFixed(1)}%`;
	const tokens = `${formatTokens(context?.tokens)}/${formatTokens(context?.contextWindow ?? model?.contextWindow)}`;
	const percent = context?.percent == null ? "?" : `${context.percent.toFixed(1)}%`;
	const thinking = model?.reasoning ? ` • ${ctx.thinkingLevel ?? "off"}` : "";
	const left = `${cache} $${cost.toFixed(3)}${subscription ? " (sub)" : ""} ${tokens} ${percent}`;
	const right = `${model?.id ?? "no-model"}${thinking}`;
	const shownLeft = left.slice(0, width);
	const shownRight = right.slice(0, Math.max(0, width - shownLeft.length - 2));
	const padding = " ".repeat(Math.max(0, width - shownLeft.length - shownRight.length));

	return [cwd.slice(0, width), shownLeft + padding + shownRight];
}

export default function minimalFooter(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setFooter((_tui, theme) => ({
			invalidate() {},
			render: (width) => formatFooter(ctx, width).map((line) => theme.fg("dim", line)),
		}));
	});
}
