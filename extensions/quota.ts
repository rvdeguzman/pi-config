/**
 * Provider quota status — pings Claude and Codex usage endpoints (same ones
 * notch-usage uses) and shows e.g. "5h 8% wk 19%" in the footer.
 * Reads OAuth tokens pi already stores in ~/.pi/agent/auth.json.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REFRESH_MS = 5 * 60 * 1000;
// File cache shared across pi instances so N open sessions don't each ping.
const CACHE_PATH = join(homedir(), ".pi/agent/quota-cache.json");
const CACHE_VERSION = 2;
const TTL: Record<string, number> = { cc: 15 * 60 * 1000, cx: 5 * 60 * 1000, k3: 5 * 60 * 1000 };

export type Win = { label: string; pct: number; resetAt?: number };
type Cache = Record<string, { at: number; wins: Win[]; version?: number; backoffUntil?: number }>;

/** Persisted toggle: /reset hides or shows the countdown next to each window. */
const RESET_PATH = join(homedir(), ".pi/agent/quota-reset.json");
let showReset = true;
try {
	showReset = (JSON.parse(readFileSync(RESET_PATH, "utf8")) as { show?: boolean }).show !== false;
} catch {}
export const setShowReset = (on: boolean) => {
	showReset = on;
};

export function formatReset(resetAt: number | undefined, now = Date.now()): string {
	if (!showReset || resetAt == null || !Number.isFinite(resetAt)) return "";
	const minutes = Math.max(0, Math.ceil((resetAt - now) / 60_000));
	const days = Math.floor(minutes / 1_440);
	const hours = Math.floor((minutes % 1_440) / 60);
	const mins = minutes % 60;
	if (days) return `${days}d${hours ? ` ${hours}h` : ""}`;
	if (hours) return `${hours}h${mins ? ` ${mins}m` : ""}`;
	return `${mins}m`;
}

export function formatQuota(wins: readonly Win[], now = Date.now()): string {
	return wins
		.map((w) => {
			const reset = formatReset(w.resetAt, now);
			return `${w.label} ${Math.round(w.pct)}%${reset ? ` ${reset}` : ""}`;
		})
		.join(" ");
}

function loadCache(): Cache {
	try {
		return JSON.parse(readFileSync(CACHE_PATH, "utf8"));
	} catch {
		return {};
	}
}

/** Return cached windows if fresh, else fetch and update the cache. */
async function cached(key: string, fetcher: () => Promise<Win[]>): Promise<Win[]> {
	const cache = loadCache();
	const e = cache[key];
	const now = Date.now();
	if (e && ((e.version === CACHE_VERSION && now - e.at < TTL[key]) || (e.backoffUntil ?? 0) > now)) return e.wins;
	try {
		const wins = await fetcher();
		if (wins.length) cache[key] = { at: now, wins, version: CACHE_VERSION };
		else if (e) return e.wins; // fetch failed/empty: keep stale
		writeFileSync(CACHE_PATH, JSON.stringify(cache));
		return wins;
	} catch (err) {
		if ((err as Error).message === "429" && e) {
			cache[key] = { ...e, backoffUntil: now + 30 * 60 * 1000 };
			writeFileSync(CACHE_PATH, JSON.stringify(cache));
		}
		return e?.wins ?? [];
	}
}

function auth(provider: string): { access: string; accountId?: string } | undefined {
	try {
		const a = JSON.parse(readFileSync(join(homedir(), ".pi/agent/auth.json"), "utf8"))[provider];
		if (a?.access && (!a.expires || a.expires > Date.now())) return a;
	} catch {}
	return undefined;
}

async function getJson(url: string, headers: Record<string, string>): Promise<any | undefined> {
	const res = await fetch(url, {
		headers: { Accept: "application/json", ...headers },
		signal: AbortSignal.timeout(10_000),
	});
	if (res.status === 429) throw new Error("429");
	return res.ok ? res.json() : undefined;
}

async function claudeWindows(): Promise<Win[]> {
	const a = auth("anthropic");
	if (!a) return [];
	const u = await getJson("https://api.anthropic.com/api/oauth/usage", {
		Authorization: `Bearer ${a.access}`,
		"anthropic-beta": "oauth-2025-04-20",
		"User-Agent": "claude-code/2.1.0",
	});
	if (!u) return [];
	const wins: Win[] = [];
	if (u.five_hour)
		wins.push({
			label: "5h",
			pct: u.five_hour.utilization ?? 0,
			resetAt: u.five_hour.resets_at ? Date.parse(u.five_hour.resets_at) : undefined,
		});
	if (u.seven_day)
		wins.push({
			label: "wk",
			pct: u.seven_day.utilization ?? 0,
			resetAt: u.seven_day.resets_at ? Date.parse(u.seven_day.resets_at) : undefined,
		});
	return wins;
}

async function kimiWindows(): Promise<Win[]> {
	const a = auth("kimi-coding");
	if (!a) return [];
	const u = await getJson("https://api.kimi.com/coding/v1/usages", {
		Authorization: `Bearer ${a.access}`,
		"User-Agent": "pi-quota",
	});
	const win = (label: string, d: any): Win | undefined => {
		const limit = Number(d?.limit);
		if (!limit) return undefined;
		const used = d?.used != null ? Number(d.used) : d?.remaining != null ? limit - Number(d.remaining) : undefined;
		if (used == null) return undefined;
		return { label, pct: (used / limit) * 100, resetAt: d?.resetTime ? Date.parse(d.resetTime) : undefined };
	};
	// ponytail: 300min = 5h session window; falls back to first window if Kimi changes duration
	const fiveH = u?.limits?.find((l: any) => l?.window?.duration === 300)?.detail ?? u?.limits?.[0]?.detail;
	return [win("5h", fiveH), win("wk", u?.usage)].filter((w): w is Win => !!w);
}

function codexLabel(seconds?: number): string {
	if (!seconds) return "?";
	if (seconds <= 6 * 3600) return "5h";
	if (seconds <= 26 * 3600) return "day";
	return "wk";
}

async function codexWindows(): Promise<Win[]> {
	const a = auth("openai-codex");
	if (!a) return [];
	const u = await getJson("https://chatgpt.com/backend-api/wham/usage", {
		Authorization: `Bearer ${a.access}`,
		...(a.accountId ? { "ChatGPT-Account-Id": a.accountId } : {}),
		"User-Agent": "pi-quota",
	});
	const wins: Win[] = [];
	for (const w of [u?.rate_limit?.primary_window, u?.rate_limit?.secondary_window]) {
		if (!w) continue;
		const resetAt =
			typeof w.reset_at === "number"
				? w.reset_at * 1000
				: typeof w.reset_after_seconds === "number"
					? Date.now() + w.reset_after_seconds * 1000
					: undefined;
		wins.push({ label: codexLabel(w.limit_window_seconds), pct: w.used_percent ?? 0, resetAt });
	}
	return wins;
}

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let countdownTimer: ReturnType<typeof setInterval> | undefined;
	let lastFetch = 0;
	let lastWins: Win[] = [];

	function renderQuota(ctx: ExtensionContext) {
		if (lastWins.length === 0) return;
		const theme = ctx.ui.theme;
		const pct = (n: number) => {
			const v = Math.round(n);
			return theme.fg(v >= 90 ? "error" : v >= 70 ? "warning" : "success", `${v}%`);
		};
		ctx.ui.setStatus(
			"quota",
			lastWins
				.map((w) => {
					const reset = formatReset(w.resetAt);
					return `${theme.fg("dim", w.label)} ${pct(w.pct)}${reset ? ` ${theme.fg("dim", reset)}` : ""}`;
				})
				.join(" "),
		);
		// Pre-formatted text for custom footers (e.g. minimal-footer) that replace the built-in
		// one: they may hold a separate module copy of showReset, so gate the countdown here.
		pi.events.emit("quota:changed", formatQuota(lastWins));
	}

	async function refresh(ctx: ExtensionContext, force = false) {
		if (!force && Date.now() - lastFetch < 60_000) return; // throttle turn_end pings
		lastFetch = Date.now();
		// Only the active model's provider.
		const provider = ctx.model?.provider;
		const source =
			provider === "anthropic"
				? () => cached("cc", claudeWindows)
				: provider === "openai-codex"
					? () => cached("cx", codexWindows)
					: provider === "kimi-coding"
						? () => cached("k3", kimiWindows)
						: undefined;
		if (!source) {
			lastWins = [];
			ctx.ui.setStatus("quota", undefined);
			pi.events.emit("quota:changed", "");
			return;
		}
		const wins = await source().catch(() => [] as Win[]);
		if (wins.length === 0) return; // offline/no auth: keep last shown
		lastWins = wins;
		renderQuota(ctx);
	}

	pi.on("session_start", async (_e, ctx) => {
		void refresh(ctx, true);
		clearInterval(timer);
		clearInterval(countdownTimer);
		timer = setInterval(() => void refresh(ctx, true), REFRESH_MS);
		countdownTimer = setInterval(() => renderQuota(ctx), 60_000);
	});

	// Without this, a session_start timer outlives its ctx across newSession/fork/
	// switchSession/reload (a fresh extension instance owns the next session) and
	// crashes pi when it next fires against the now-stale ctx.
	pi.on("session_shutdown", () => {
		clearInterval(timer);
		clearInterval(countdownTimer);
		timer = undefined;
		countdownTimer = undefined;
	});

	pi.on("turn_end", async (_e, ctx) => void refresh(ctx));

	pi.on("model_select", async (_e, ctx) => void refresh(ctx, true));

	pi.registerCommand("reset", {
		description: "Toggle quota reset countdown in the footer",
		handler: async (_args, ctx) => {
			setShowReset(!showReset);
			try {
				writeFileSync(RESET_PATH, `${JSON.stringify({ show: showReset })}\n`, "utf8");
			} catch (error) {
				ctx.ui.notify?.(`Could not save reset display: ${String(error)}`, "error");
			}
			renderQuota(ctx);
			ctx.ui.notify?.(`Quota reset countdown ${showReset ? "ON" : "OFF"}`, "info");
		},
	});
}
