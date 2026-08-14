/**
 * Provider quota status — pings Claude and Codex usage endpoints (same ones
 * notch-usage uses) and shows e.g. "cl 5h 8% · wk 19% │ cx wk 9%" in the footer.
 * Reads OAuth tokens pi already stores in ~/.pi/agent/auth.json.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REFRESH_MS = 5 * 60 * 1000;
// File cache shared across pi instances so N open sessions don't each ping.
const CACHE_PATH = join(homedir(), ".pi/agent/quota-cache.json");
const TTL: Record<string, number> = { cl: 15 * 60 * 1000, cx: 5 * 60 * 1000 };

type Win = { label: string; pct: number };
type Cache = Record<string, { at: number; wins: Win[]; backoffUntil?: number }>;

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
	if (e && (now - e.at < TTL[key] || (e.backoffUntil ?? 0) > now)) return e.wins;
	try {
		const wins = await fetcher();
		if (wins.length) cache[key] = { at: now, wins };
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
	if (u.five_hour) wins.push({ label: "5h", pct: u.five_hour.utilization ?? 0 });
	if (u.seven_day) wins.push({ label: "wk", pct: u.seven_day.utilization ?? 0 });
	return wins;
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
		if (w) wins.push({ label: codexLabel(w.limit_window_seconds), pct: w.used_percent ?? 0 });
	}
	return wins;
}

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let lastFetch = 0;

	async function refresh(ctx: ExtensionContext, force = false) {
		if (!force && Date.now() - lastFetch < 60_000) return; // throttle turn_end pings
		lastFetch = Date.now();
		const theme = ctx.ui.theme;
		const pct = (n: number) => {
			const v = Math.round(n);
			return theme.fg(v >= 90 ? "error" : v >= 70 ? "warning" : "success", `${v}%`);
		};
		// Only the active model's provider.
		const provider = ctx.model?.provider;
		const source =
			provider === "anthropic"
				? { tag: "cl", fetch: () => cached("cl", claudeWindows) }
				: provider === "openai-codex"
					? { tag: "cx", fetch: () => cached("cx", codexWindows) }
					: undefined;
		if (!source) {
			ctx.ui.setStatus("quota", undefined);
			pi.events.emit("quota:changed", "");
			return;
		}
		const wins = await source.fetch().catch(() => [] as Win[]);
		if (wins.length === 0) return; // offline/no auth: keep last shown
		const text = wins.map((w) => `${theme.fg("dim", w.label)} ${pct(w.pct)}`).join(theme.fg("dim", " · "));
		ctx.ui.setStatus("quota", `${theme.fg("dim", source.tag)} ${text}`);
		// Plain text for custom footers (e.g. minimal-footer) that replace the built-in one.
		const plain = wins.map((w) => `${w.label} ${Math.round(w.pct)}%`).join(" · ");
		pi.events.emit("quota:changed", `${source.tag} ${plain}`);
	}

	pi.on("session_start", async (_e, ctx) => {
		void refresh(ctx, true);
		clearInterval(timer);
		timer = setInterval(() => void refresh(ctx, true), REFRESH_MS);
	});

	pi.on("turn_end", async (_e, ctx) => void refresh(ctx));

	pi.on("model_select", async (_e, ctx) => void refresh(ctx, true));
}
