/**
 * Gruvbox dashboard
 *
 * Header: gradient ASCII banner (adapted from davis7's ui-customization),
 *         re-paletted to gruvbox yellow -> orange -> red, left-justified, with
 *         a stoic quote in a right-hand column.
 *         Art is toggleable with `/logo on|off|<name>`, quotes with `/quote on|off`.
 *         UI preferences persist in `~/.pi/agent/gruvbox-dashboard.json`.
 * Footer: mimics the oh-my-zsh `geoffgarside` prompt:
 *
 *   [14:23:05] rv:termios git:(main)  ctx 84k/200k (42%) · claude-fable-5 · high
 *
 * Left side follows the zsh theme (aqua user, green dir, yellow git:(...)).
 * Right side: current/max context tokens (percentage) · model id · thinking effort. No cost.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Rgb = [number, number, number];

const RESET = "\x1b[0m";

// --- Gruvbox (dark, bright variants) ---
const AQUA: Rgb = [142, 192, 124]; // #8ec07c  (zsh cyan -> user)
const GREEN: Rgb = [184, 187, 38]; // #b8bb26  (dir)
const YELLOW: Rgb = [250, 189, 47]; // #fabd2f (git:(...))
const GRAY: Rgb = [146, 131, 116]; // #928374  (right-side info)
const FG3: Rgb = [168, 153, 132]; // #a89984  (quote body)

// Header layout: art hugs the left edge, quote sits in a column to its right.
const INDENT = 2;
const GAP = 4;

// Banner gradient: yellow -> orange -> red -> orange (cycles)
const PALETTE: Rgb[] = [
	[250, 189, 47], // #fabd2f yellow
	[254, 128, 25], // #fe8019 orange
	[251, 73, 52], // #fb4934 red
	[254, 128, 25], // #fe8019 orange
];

// Banner art. Block-element glyphs only (U+2580..U+259F): unambiguous width in
// every terminal, unlike emoji/geometric shapes that render double-wide.
const LOGOS: Record<string, readonly string[]> = {
	// Berserk: the Brand of Sacrifice. Two long diagonals cross in an X, thin
	// horn-spikes rise off the upper elbows, the lower edges close into a diamond,
	// and a central spike runs through it all — crown on top, point at the bottom.
	// Geometry traced from the reference art and rasterized with half-blocks by
	// ../tools/logo/brand-render.mjs; the source mark is 0.60 w:h, so these are
	// squashed vertically to stay header-sized.
	"brand": [
		"         ▄▄         ",
		"▄▄█▀     ██     ▀█▄▄",
		"████▄▄▄  ██  ▄▄▄████",
		"   ▀▀██████████▀▀   ",
		"    ▄▄▄██████▄▄▄    ",
		"▄▄████▀▀ ██ ▀▀████▄▄",
		"████▄    ██    ▄████",
		"  ▀▀███▄▄██▄▄███▀▀  ",
		"      ▀▀████▀▀      ",
	],
	"brand-large": [
		"                              ",
		"     ▄▄      ▀██▀      ▄▄     ",
		" ▄▄██▀        ██        ▀██▄▄ ",
		"████▄         ██         ▄████",
		" ▀▀████▄▄     ██     ▄▄████▀▀ ",
		"     ▀▀████▄▄ ██ ▄▄████▀▀     ",
		"         ▀▀████████▀▀         ",
		"         ▄▄████████▄▄         ",
		"     ▄▄████▀▀ ██ ▀▀████▄▄     ",
		" ▄▄████▀▀     ██     ▀▀████▄▄ ",
		"█████         ██         █████",
		" ▀▀████▄      ██      ▄████▀▀ ",
		"     ▀████▄▄  ██  ▄▄████▀     ",
		"        ▀▀███▄██▄███▀▀        ",
		"            ▀████▀            ",
	],
// Naruto: Sharingan.
	sharingan: [
		"    ▄▄███▄▄    ",
		"  ▄██▀▀▀▀▀██▄  ",
		" ▐█▀  ▄█▄  ▀█▌ ",
		" ▐█▄  ▀█▀  ▄█▌ ",
		"  ▀██▄▄▄▄▄██▀  ",
		"    ▀▀███▀▀    ",
	],
	// Gurren Lagann: Kamina's shades.
	shades: [
		" ▄███████████▄ ",
		" ██▀▀██ ██▀▀██ ",
		" ██  ▀▀▀▀▀  ██ ",
		" ▀██▄▄▄▄▄▄▄██▀ ",
	],
	// The math symbol π (omp's brand mark).
	pi: [
		" ▀██████████▀ ",
		"  ╘██    ██   ",
		"   ██    ██   ",
		"   ██    ██   ",
		"  ▄██▄  ▄██▄  ",
	],
};

const DEFAULT_LOGO = "brand";
const LOGO_ENABLED_BY_DEFAULT = false;
const QUOTE_ENABLED_BY_DEFAULT = true;
const DASHBOARD_CONFIG = join(getAgentDir(), "gruvbox-dashboard.json");
let activeLogo = DEFAULT_LOGO;
let logoVisible = LOGO_ENABLED_BY_DEFAULT;
let quoteVisible = QUOTE_ENABLED_BY_DEFAULT;

function loadDashboardConfig() {
	try {
		const parsed: unknown = JSON.parse(readFileSync(DASHBOARD_CONFIG, "utf8"));
		if (!parsed || typeof parsed !== "object") return;
		const config = parsed as Record<string, unknown>;
		const logo = config.logo;
		if (logo && typeof logo === "object") {
			const settings = logo as Record<string, unknown>;
			if (typeof settings.name === "string" && settings.name in LOGOS) activeLogo = settings.name;
			if (typeof settings.enabled === "boolean") logoVisible = settings.enabled;
		}
		const quote = config.quote;
		if (quote && typeof quote === "object") {
			const settings = quote as Record<string, unknown>;
			if (typeof settings.enabled === "boolean") quoteVisible = settings.enabled;
		}
	} catch {
		// Missing or invalid config falls back to the defaults above.
	}
}

function saveDashboardConfig() {
	try {
		mkdirSync(dirname(DASHBOARD_CONFIG), { recursive: true });
		const config = {
			logo: { enabled: logoVisible, name: activeLogo },
			quote: { enabled: quoteVisible },
		};
		writeFileSync(DASHBOARD_CONFIG, `${JSON.stringify(config, null, "\t")}\n`);
		return true;
	} catch {
		return false;
	}
}

/** Rows below which the 2x art crowds out the conversation. */
const LARGE_LOGO_MIN_ROWS = 40;

/** omp's splash trick: double every glyph horizontally and every row vertically. */
function double(lines: readonly string[]): string[] {
	return lines.flatMap((line) => {
		let wide = "";
		for (const ch of line) wide += ch === " " ? "  " : `${ch}${ch}`;
		return [wide, wide];
	});
}

/**
 * Pick the art for the current terminal: `brand` and `pi` get a 2x treatment
 * when there's vertical room — a hand-tuned resample for the brand, the cheap
 * glyph-doubling for π (all-█ strokes, so doubling is lossless there).
 * An explicit `/logo brand-large` always wins.
 */
function resolveLogo(): readonly string[] {
	if (!logoVisible) return [];
	const lines = LOGOS[activeLogo] ?? LOGOS[DEFAULT_LOGO]!;
	if ((process.stdout.rows ?? 24) < LARGE_LOGO_MIN_ROWS) return lines;
	if (activeLogo === "brand") return LOGOS["brand-large"]!;
	if (activeLogo === "pi") return double(lines);
	return lines;
}

function fg([r, g, b]: Rgb, text: string) {
	return `\x1b[38;2;${r};${g};${b}m${text}${RESET}`;
}

function mix(a: number, b: number, amount: number) {
	return Math.round(a + (b - a) * amount);
}

function sampleGradient(position: number): Rgb {
	const wrapped = ((position % 1) + 1) % 1;
	const scaled = wrapped * PALETTE.length;
	const index = Math.floor(scaled);
	const next = (index + 1) % PALETTE.length;
	const amount = scaled - index;
	const start = PALETTE[index]!;
	const end = PALETTE[next]!;
	return [
		mix(start[0], end[0], amount),
		mix(start[1], end[1], amount),
		mix(start[2], end[2], amount),
	];
}

function gradientText(text: string, phase: number) {
	const characters = [...text];
	const span = Math.max(characters.length - 1, 1);
	return characters
		.map((character, index) =>
			character === " " ? character : fg(sampleGradient(index / span + phase), character),
		)
		.join("");
}

// --- Stoic quote ----------------------------------------------------------
//
// There is no Daily Stoic API: dailystoic.com is a WordPress site with no /api
// route (its newest post is from 2023) and the daily quote ships by email only.
// The live key-free option is stoic-quotes.com — /api/quote returns one random
// quote, /api/quotes returns ten. Both 307 to the www host, so follow redirects.
// (api.themotivate365.com, stoicquotesapi.com and api.quotable.io are all dead.)
//
// The header must never wait on the network, so a pool is cached on disk and
// refreshed in the background; a bundled handful covers first run and offline.

interface Quote {
	text: string;
	author: string;
}

const QUOTE_API = "https://www.stoic-quotes.com/api/quotes";
const QUOTE_CACHE = join(homedir(), ".pi", "agent", "cache", "stoic-quotes.json");
const QUOTE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const QUOTE_MAX_WIDTH = 54;
const QUOTE_MIN_WIDTH = 26;

const FALLBACK_QUOTES: readonly Quote[] = [
	{
		text: "You could leave life right now. Let that determine what you do and say and think.",
		author: "Marcus Aurelius",
	},
	{ text: "We suffer more often in imagination than in reality.", author: "Seneca" },
	{
		text: "It is not that we have a short time to live, but that we waste a lot of it.",
		author: "Seneca",
	},
	{ text: "First say to yourself what you would be; then do what you have to do.", author: "Epictetus" },
];

let quotePool: Quote[] = [...FALLBACK_QUOTES];
let currentQuote: Quote | undefined;

/** Stable index for the day, so the quote is a daily one rather than per-render. */
function dailyIndex(count: number) {
	const day = new Date().toISOString().slice(0, 10);
	let hash = 2166136261;
	for (const ch of day) {
		hash ^= ch.charCodeAt(0);
		hash = Math.imul(hash, 16777619);
	}
	return Math.abs(hash) % Math.max(1, count);
}

function readCache(): { fetchedAt: number; quotes: Quote[] } | undefined {
	try {
		const parsed = JSON.parse(readFileSync(QUOTE_CACHE, "utf8"));
		if (Array.isArray(parsed?.quotes) && parsed.quotes.length > 0) return parsed;
	} catch {
		// no cache yet, or corrupt — fall through to the bundled quotes
	}
	return undefined;
}

function writeCache(quotes: Quote[]) {
	try {
		mkdirSync(dirname(QUOTE_CACHE), { recursive: true });
		writeFileSync(QUOTE_CACHE, JSON.stringify({ fetchedAt: Date.now(), quotes }, null, "\t"));
	} catch {
		// cache is best-effort
	}
}

/** /api/quotes hands back ten random quotes per call, so poll a few times. */
async function fetchQuotes(rounds = 4): Promise<Quote[]> {
	const seen = new Map<string, Quote>();
	for (let i = 0; i < rounds; i++) {
		const res = await fetch(QUOTE_API, { signal: AbortSignal.timeout(4000), redirect: "follow" });
		if (!res.ok) break;
		for (const raw of (await res.json()) as Quote[]) {
			if (!raw?.text || !raw?.author) continue;
			const text = raw.text.trim();
			seen.set(text, { text, author: raw.author.trim() });
		}
	}
	return [...seen.values()];
}

/** Seed from cache immediately, then top up in the background. */
function initQuotes(onRefresh: () => void) {
	const cached = readCache();
	if (cached) quotePool = cached.quotes;
	currentQuote = quotePool[dailyIndex(quotePool.length)];

	const fresh = cached && Date.now() - cached.fetchedAt < QUOTE_TTL_MS;
	if (fresh && quotePool.length >= 20) return;

	void fetchQuotes()
		.then((fetched) => {
			if (fetched.length === 0) return;
			const merged = new Map(quotePool.map((q) => [q.text, q]));
			for (const q of fetched) merged.set(q.text, q);
			quotePool = [...merged.values()];
			writeCache(quotePool);
			currentQuote = quotePool[dailyIndex(quotePool.length)];
			onRefresh();
		})
		.catch(() => {
			// offline: the bundled/cached quotes already cover us
		});
}

function wrapText(text: string, width: number): string[] {
	const lines: string[] = [];
	let line = "";
	for (const word of text.split(/\s+/)) {
		if (!line) line = word;
		else if (visibleWidth(`${line} ${word}`) <= width) line += ` ${word}`;
		else {
			lines.push(line);
			line = word;
		}
	}
	if (line) lines.push(line);
	return lines;
}

/** Quote body plus a right-aligned attribution, clipped to `maxLines`. */
function quoteBlock(quote: Quote, width: number, maxLines: number): string[] {
	const wrapped = wrapText(`"${quote.text}"`, width);
	const bodyLines = Math.max(1, maxLines - 1);
	const body = wrapped.slice(0, bodyLines);
	if (wrapped.length > bodyLines) {
		body[body.length - 1] = `${truncateToWidth(body[body.length - 1]!, width - 1)}…`;
	}
	const author = `— ${quote.author}`;
	const pad = " ".repeat(Math.max(0, width - visibleWidth(author)));
	return [...body.map((line) => fg(FG3, line)), pad + fg(YELLOW, author)];
}

function shortDir(cwd: string) {
	return cwd === homedir() ? "~" : basename(cwd);
}

/** Compact token count that keeps the footer useful on narrow terminals. */
function formatTokens(count: number) {
	if (count < 1_000) return count.toString();
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

export default function gruvboxDashboard(pi: ExtensionAPI) {
	let headerTui: { requestRender(): void } | undefined;

	function install(ctx: ExtensionContext) {
		if (ctx.mode !== "tui") return;

		loadDashboardConfig();
		const user = userInfo().username;
		const dir = shortDir(ctx.cwd);

		ctx.ui.setTitle(`pi · ${dir}`);

		initQuotes(() => headerTui?.requestRender());

		ctx.ui.setHeader((tui) => {
			headerTui = tui;
			return {
				render(width: number) {
					const art = resolveLogo();
					if (art.length === 0) {
						const quoteWidth = Math.min(QUOTE_MAX_WIDTH, width - INDENT - 1);
						const quoteLines =
							quoteVisible && currentQuote && quoteWidth >= QUOTE_MIN_WIDTH
								? quoteBlock(currentQuote, quoteWidth, 4)
								: [];
						return quoteLines.length > 0
							? ["", ...quoteLines.map((line) => " ".repeat(INDENT) + line), ""]
							: [];
					}

					const artWidth = Math.max(...art.map((line) => visibleWidth(line)));
					const columnWidth = Math.min(QUOTE_MAX_WIDTH, width - INDENT - artWidth - GAP - 1);
					const quoteLines =
						quoteVisible && currentQuote && columnWidth >= QUOTE_MIN_WIDTH
							? quoteBlock(currentQuote, columnWidth, art.length)
							: [];

					const rows = Math.max(art.length, quoteLines.length);
					// Sit the quote block against the vertical middle of the art.
					const top = Math.max(0, Math.floor((rows - quoteLines.length) / 2));
					const out: string[] = [];
					for (let row = 0; row < rows; row++) {
						const artLine = (art[row] ?? "").padEnd(artWidth);
						const left = " ".repeat(INDENT) + gradientText(artLine, row * 0.045);
						const quoteLine = quoteLines[row - top];
						out.push(quoteLine ? left + " ".repeat(GAP) + quoteLine : left.replace(/ +$/, ""));
					}
					return ["", ...out, ""];
				},
				invalidate() {},
			};
		});

		ctx.ui.setFooter((tui, _theme, footerData) => {
			const unsubBranch = footerData.onBranchChange(() => tui.requestRender());
			const clock = setInterval(() => tui.requestRender(), 1000);

			return {
				dispose() {
					unsubBranch();
					clearInterval(clock);
				},
				invalidate() {},
				render(width: number) {
					// Left: [HH:MM:SS] user:dir git:(branch)
					const time = new Date().toTimeString().slice(0, 8);
					const branch = footerData.getGitBranch();
					let left = `[${time}] ${fg(AQUA, user)}:${fg(GREEN, dir)}`;
					if (branch) left += ` ${fg(YELLOW, `git:(${branch})`)}`;

					// Right: current/max context tokens (percentage) · model · effort
					const usage = ctx.getContextUsage();
					const currentTokens = usage?.tokens != null ? formatTokens(usage.tokens) : "?";
					const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
					const maxTokens = contextWindow ? formatTokens(contextWindow) : "?";
					const pct = usage?.percent != null ? `${Math.round(usage.percent)}%` : "?";
					const context = `ctx ${currentTokens}/${maxTokens} (${pct})`;
					const model = ctx.model?.id ?? "no-model";
					const effort = ctx.model?.reasoning ? pi.getThinkingLevel() : "off";
					const right = fg(GRAY, `${context} · ${model} · ${effort}`);

					const pad = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
					return [truncateToWidth(`${left}${" ".repeat(pad)}${right}`, width)];
				},
			};
		});
	}

	pi.on("session_start", (_event, ctx) => install(ctx));

	pi.registerCommand("quote", {
		description: "Toggle or draw another stoic quote (on, off, refresh)",
		getArgumentCompletions: (prefix) =>
			["on", "off", "refresh"]
				.filter((name) => name.startsWith(prefix))
				.map((name) => ({ value: name, label: name })),
		handler: async (args, ctx) => {
			const action = args.trim();
			if (action === "on" || action === "off") {
				quoteVisible = action === "on";
				const saved = saveDashboardConfig();
				headerTui?.requestRender();
				ctx.ui.notify(
					`Quote: ${action}${saved ? "" : " (could not save preference)"}`,
					saved ? "info" : "warning",
				);
				return;
			}
			if (action && action !== "refresh") {
				ctx.ui.notify(`Unknown quote option "${action}" — try: on, off, refresh`, "warning");
				return;
			}
			if (action === "refresh") {
				const fetched = await fetchQuotes().catch(() => []);
				if (fetched.length === 0) {
					ctx.ui.notify("Could not reach stoic-quotes.com", "warning");
					return;
				}
				const merged = new Map(quotePool.map((q) => [q.text, q]));
				for (const q of fetched) merged.set(q.text, q);
				quotePool = [...merged.values()];
				writeCache(quotePool);
				ctx.ui.notify(`Quote pool: ${quotePool.length}`, "info");
			}
			currentQuote = quotePool[Math.floor(Math.random() * quotePool.length)];
			headerTui?.requestRender();
		},
	});

	pi.registerCommand("logo", {
		description: `Toggle or switch the header logo (on, off, ${Object.keys(LOGOS).join(", ")})`,
		getArgumentCompletions: (prefix) =>
			["on", "off", ...Object.keys(LOGOS)]
				.filter((name) => name.startsWith(prefix))
				.map((name) => ({ value: name, label: name })),
		handler: async (args, ctx) => {
			const name = args.trim();
			if (!name) {
				const state = logoVisible ? activeLogo : "off";
				ctx.ui.notify(`Logo: ${state} — available: on, off, ${Object.keys(LOGOS).join(", ")}`, "info");
				return;
			}
			if (name === "off") {
				logoVisible = false;
			} else if (name === "on") {
				logoVisible = true;
			} else if (name in LOGOS) {
				activeLogo = name;
				logoVisible = true;
			} else {
				ctx.ui.notify(
					`Unknown logo "${name}" — try: on, off, ${Object.keys(LOGOS).join(", ")}`,
					"warning",
				);
				return;
			}
			const saved = saveDashboardConfig();
			headerTui?.requestRender();
			ctx.ui.notify(
				`Logo: ${logoVisible ? activeLogo : "off"}${saved ? "" : " (could not save preference)"}`,
				saved ? "info" : "warning",
			);
		},
	});

	pi.registerCommand("dashboard-off", {
		description: "Restore built-in header and footer",
		handler: async (_args, ctx) => {
			ctx.ui.setHeader(undefined);
			ctx.ui.setFooter(undefined);
			ctx.ui.notify("Built-in header/footer restored", "info");
		},
	});
}
