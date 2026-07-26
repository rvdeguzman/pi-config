/**
 * Gruvbox dashboard
 *
 * Header: gradient ASCII banner (adapted from davis7's ui-customization),
 *         re-paletted to gruvbox yellow -> orange -> red, left-justified, with
 *         a stoic quote in a right-hand column.
 *         Art is toggleable with `/logo on|off|<name>`, quotes with `/quote on|off`.
 *         UI preferences persist in `~/.pi/agent/gruvbox-dashboard.json`.
 * Bottom bar: a seated status block, not a shell prompt. A hairline rule closes
 *         the transcript, then pi's own editor, then two aligned rows and an LED
 *         ticker styled after a Japanese station board:
 *
 *   ─────────────────────────────────────────────────────────────────────
 *   ╭───────────────────────────────────────────────────────────────────╮
 *   │ …                                                                 │
 *   ╰───────────────────────────────────────────────────────────────────╯
 *   termios  ▐ ▶ read footer.js… ▌                84k/200k (42%) · $0.42
 *   main · tui-look                                 claude-fable-5 · high
 *
 * The fixed columns answer *where* and *how much*. A deliberately narrow
 * station display immediately after the directory carries everything that does
 * not deserve a fixed slot (live tool activity, extension statuses, session
 * totals, the stoic quote), keeping the notices in motion without a third row.
 * `/ticker on|off|speed <cps>` controls it, and the preference persists.
 *
 * Deliberately absent: a wall clock and the `user:dir git:(branch)` shape — a
 * persistent status line is not a prompt, and neither datum ever changes.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	CustomEditor,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Rgb = [number, number, number];

const RESET = "\x1b[0m";

// --- Gruvbox (dark, bright variants) ---
const RED: Rgb = [251, 73, 52]; // #fb4934
const GREEN: Rgb = [184, 187, 38]; // #b8bb26
const YELLOW: Rgb = [250, 189, 47]; // #fabd2f  (branch, high effort)
const ORANGE: Rgb = [254, 128, 25]; // #fe8019  (ticker LEDs, accent)
const AMBER: Rgb = [215, 153, 33]; // #d79921  (medium effort)
const FG: Rgb = [235, 219, 178]; // #ebdbb2  (directory)
const FG3: Rgb = [168, 153, 132]; // #a89984  (quote body, model id)
const GRAY: Rgb = [146, 131, 116]; // #928374  (secondary info)
const BG4: Rgb = [124, 111, 100]; // #7c6f64  (separators)
const BG3: Rgb = [102, 92, 84]; // #665c54
const BG2: Rgb = [80, 73, 69]; // #504945  (hairline seat)
const BG0H: Rgb = [29, 32, 33]; // #1d2021  (ticker panel)

/** Thinking effort borrows the theme's thinking* ramp: subtle -> loud. */
const EFFORT_COLOR: Record<string, Rgb> = {
	off: BG3,
	minimal: GRAY,
	low: FG3,
	medium: AMBER,
	high: YELLOW,
	xhigh: ORANGE,
	max: RED,
};

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
const TICKER_ENABLED_BY_DEFAULT = true;
/** Columns per second. Real platform boards run slow enough to read at a glance. */
const TICKER_DEFAULT_SPEED = 8;
const TICKER_MIN_SPEED = 1;
const TICKER_MAX_SPEED = 30;
/** Total width including `▐ ` and ` ▌`; 20 columns remain for the moving notice. */
const TICKER_WIDTH = 24;
/** Below this width the station display would be unreadable, so omit it. */
const TICKER_MIN_WIDTH = 12;
const DASHBOARD_CONFIG = join(getAgentDir(), "gruvbox-dashboard.json");
let activeLogo = DEFAULT_LOGO;
let logoVisible = LOGO_ENABLED_BY_DEFAULT;
let quoteVisible = QUOTE_ENABLED_BY_DEFAULT;
let tickerVisible = TICKER_ENABLED_BY_DEFAULT;
let tickerSpeed = TICKER_DEFAULT_SPEED;

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
		const ticker = config.ticker;
		if (ticker && typeof ticker === "object") {
			const settings = ticker as Record<string, unknown>;
			if (typeof settings.enabled === "boolean") tickerVisible = settings.enabled;
			if (typeof settings.speed === "number" && Number.isFinite(settings.speed)) {
				tickerSpeed = clampSpeed(settings.speed);
			}
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
			ticker: { enabled: tickerVisible, speed: tickerSpeed },
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

function clampSpeed(speed: number) {
	return Math.min(TICKER_MAX_SPEED, Math.max(TICKER_MIN_SPEED, Math.round(speed)));
}

/** Context fill runs green -> yellow -> orange -> red, matching the theme's warning ramp. */
function heat(percent: number): Rgb {
	if (percent < 50) return GREEN;
	if (percent < 70) return YELLOW;
	if (percent < 90) return ORANGE;
	return RED;
}

/** Two-zone row: `left` flush left, `right` flush right, at least one column apart. */
function row(left: string, right: string, width: number) {
	const gap = width - visibleWidth(left) - visibleWidth(right);
	if (gap < 1) return truncateToWidth(left, width, "…");
	return left + " ".repeat(gap) + right;
}

// --- Session totals ---------------------------------------------------------
//
// Recomputed only when the session actually grows: the ticker repaints several
// times a second and walking every entry per frame would be silly.

interface Totals {
	input: number;
	output: number;
	cacheRead: number;
	cost: number;
}

let totalsCache: Totals | undefined;

function invalidateTotals() {
	totalsCache = undefined;
}

function sessionTotals(ctx: ExtensionContext): Totals {
	if (totalsCache) return totalsCache;
	const totals: Totals = { input: 0, output: 0, cacheRead: 0, cost: 0 };
	for (const entry of ctx.sessionManager.getEntries()) {
		const usage =
			entry.type === "message"
				? (entry.message as { usage?: Record<string, any> }).usage
				: entry.type === "compaction" || entry.type === "branch_summary"
					? (entry as { usage?: Record<string, any> }).usage
					: undefined;
		if (!usage) continue;
		totals.input += usage.input ?? 0;
		totals.output += usage.output ?? 0;
		totals.cacheRead += usage.cacheRead ?? 0;
		totals.cost += usage.cost?.total ?? 0;
	}
	totalsCache = totals;
	return totals;
}

// --- Ticker -----------------------------------------------------------------
//
// A station board: one amber line that scrolls its notices past a fixed window.
// Live tool activity takes the front while the agent works; when it goes quiet
// the board falls back to service information (extension statuses, session
// totals, the day's quote), exactly like a platform sign between trains.

const TICKER_SEP = "  ✦  ";
/** Blank run between the end of the notice loop and its restart. */
const TICKER_GAP = "        ";

interface Activity {
	label: string;
	startedAt: number;
	done: boolean;
}

let activity: Activity | undefined;
let working = false;
let tickerOffset = 0;
let tickerTimer: ReturnType<typeof setInterval> | undefined;
let tickerScrolls = false;

/** One-line status text, stripped of anything that would break a single row. */
function sanitizeStatus(text: string) {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/** What a tool is doing, in as few columns as the board can get away with. */
function describeTool(toolName: string, args: any): string {
	const path = typeof args?.path === "string" ? basename(args.path) : undefined;
	switch (toolName) {
		case "read":
		case "write":
		case "edit":
			return path ? `${toolName} ${path}` : toolName;
		case "bash":
			return typeof args?.command === "string"
				? `bash ${truncateToWidth(sanitizeStatus(args.command), 48, "…")}`
				: "bash";
		case "grep":
		case "find":
			return typeof args?.pattern === "string" ? `${toolName} ${args.pattern}` : toolName;
		default:
			return path ? `${toolName} ${path}` : toolName;
	}
}

function elapsed(since: number) {
	const seconds = Math.floor((Date.now() - since) / 1000);
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

/** The notices, in board order. Empty means the board stays dark. */
function tickerNotices(ctx: ExtensionContext, statuses: ReadonlyMap<string, string>): string[] {
	const notices: string[] = [];

	if (activity && (working || !activity.done)) {
		notices.push(`▶ ${activity.label} · ${elapsed(activity.startedAt)}`);
	}

	for (const [, text] of [...statuses.entries()].sort(([a], [b]) => a.localeCompare(b))) {
		const clean = sanitizeStatus(text);
		if (clean) notices.push(clean);
	}

	const totals = sessionTotals(ctx);
	if (totals.input || totals.output) {
		const parts = [`${formatTokens(totals.input)} in`, `${formatTokens(totals.output)} out`];
		if (totals.cacheRead) parts.push(`${formatTokens(totals.cacheRead)} cached`);
		notices.push(parts.join(" · "));
	}

	if (quoteVisible && currentQuote) notices.push(`“${currentQuote.text}” — ${currentQuote.author}`);

	return notices;
}

/**
 * Slice `width` visible columns out of the notice loop starting at `offset`,
 * wrapping around the end. Walks code points rather than indexing so wide
 * glyphs (CJK, emoji in a status) never split the row's width accounting.
 */
function scrollWindow(text: string, offset: number, width: number): string {
	const chars = [...text];
	if (chars.length === 0) return "";
	let out = "";
	let used = 0;
	let index = ((offset % chars.length) + chars.length) % chars.length;
	while (used < width) {
		const ch = chars[index]!;
		const w = visibleWidth(ch);
		if (used + w > width) break;
		out += ch;
		used += w;
		index = (index + 1) % chars.length;
	}
	return out + " ".repeat(width - used);
}

/** The board itself: amber notices on a dark panel, framed by LED end caps. */
function renderTicker(ctx: ExtensionContext, statuses: ReadonlyMap<string, string>, width: number) {
	tickerScrolls = false;
	if (!tickerVisible || width < TICKER_MIN_WIDTH) return undefined;

	const notices = tickerNotices(ctx, statuses);
	if (notices.length === 0) return undefined;

	const inner = width - 4; // "▐ " + " ▌"
	const text = notices.join(TICKER_SEP);
	// This is intentionally a marquee, not a static status chip: even a short
	// notice moves through the window, crosses the blank platform gap, and loops.
	tickerScrolls = true;
	const body = scrollWindow(text + TICKER_GAP, tickerOffset, inner);

	const cap = (s: string) => `\x1b[38;2;${ORANGE[0]};${ORANGE[1]};${ORANGE[2]}m${s}`;
	const panel = `\x1b[48;2;${BG0H[0]};${BG0H[1]};${BG0H[2]}m`;
	const lit = `\x1b[38;2;${ORANGE[0]};${ORANGE[1]};${ORANGE[2]}m`;
	return `${panel}${cap("▐")} ${lit}${body} ${cap("▌")}${RESET}`;
}

export default function gruvboxDashboard(pi: ExtensionAPI) {
	let headerTui: { requestRender(): void } | undefined;
	let footerTui: { requestRender(): void } | undefined;

	function install(ctx: ExtensionContext) {
		if (ctx.mode !== "tui") return;

		loadDashboardConfig();
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

		// A hairline closes the transcript and seats the editor, so the bottom of
		// the screen reads as one block instead of a prompt with a box above it.
		class SeatedEditor extends CustomEditor {
			constructor(tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager) {
				super(tui, editorTheme, keybindings);
			}

			render(width: number): string[] {
				return [fg(BG2, "─".repeat(Math.max(0, width))), ...super.render(width)];
			}
		}

		ctx.ui.setEditorComponent(
			(tui, editorTheme, keybindings) => new SeatedEditor(tui, editorTheme, keybindings),
		);

		ctx.ui.setFooter((tui, _theme, footerData) => {
			footerTui = tui;
			const unsubBranch = footerData.onBranchChange(() => tui.requestRender());
			startTicker();

			return {
				dispose() {
					unsubBranch();
					stopTicker();
					footerTui = undefined;
				},
				invalidate() {},
				render(width: number) {
					const usage = ctx.getContextUsage();
					const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
					const totals = sessionTotals(ctx);

					// Row 1 — where you are : how full the window is.
					const tokens = usage?.tokens != null ? formatTokens(usage.tokens) : "?";
					const windowTokens = contextWindow ? formatTokens(contextWindow) : "?";
					const percent = usage?.percent ?? null;
					// Each span is coloured on its own: a nested reset would drop the
					// surrounding colour mid-line.
					const contextRight =
						fg(GRAY, `${tokens}/${windowTokens} `) +
						fg(heat(percent ?? 0), `(${percent == null ? "?" : Math.round(percent)}%)`) +
						(totals.cost > 0 ? fg(BG4, " · ") + fg(GRAY, `$${totals.cost.toFixed(2)}`) : "");

					// Row 2 — which branch : which brain.
					const branch = footerData.getGitBranch();
					const sessionName = ctx.sessionManager.getSessionName();
					const placeLeft =
						(branch ? fg(YELLOW, branch) : fg(BG3, "no branch")) +
						(sessionName ? fg(BG4, " · ") + fg(GRAY, sessionName) : "");
					const effort = ctx.model?.reasoning ? pi.getThinkingLevel() : "off";
					const modelRight =
						fg(FG3, ctx.model?.id ?? "no-model") +
						fg(BG4, " · ") +
						fg(EFFORT_COLOR[effort] ?? GRAY, effort);

					// The board gets a deliberately tiny window immediately after the
					// directory. It yields first on narrow terminals so the fixed context
					// status remains readable.
					const dirText = fg(FG, dir);
					const roomForBoard = width - visibleWidth(dirText) - visibleWidth(contextRight) - 4;
					const boardWidth = Math.min(TICKER_WIDTH, roomForBoard);
					const board = renderTicker(
						ctx,
						footerData.getExtensionStatuses(),
						boardWidth,
					);
					const topLeft = board ? `${dirText}  ${board}` : dirText;

					return [row(topLeft, contextRight, width), row(placeLeft, modelRight, width)];
				},
			};
		});
	}

	// --- Ticker clock --------------------------------------------------------
	//
	// Only runs while something is actually scrolling: a board holding a short
	// static notice repaints on events like the rest of the footer.

	function startTicker() {
		stopTicker();
		if (!tickerVisible) return;
		tickerTimer = setInterval(() => {
			if (!tickerScrolls) return;
			tickerOffset += 1;
			footerTui?.requestRender();
		}, Math.round(1000 / tickerSpeed));
	}

	function stopTicker() {
		if (tickerTimer) clearInterval(tickerTimer);
		tickerTimer = undefined;
	}

	pi.on("session_start", (_event, ctx) => install(ctx));
	pi.on("session_shutdown", () => {
		stopTicker();
		footerTui = undefined;
	});

	// Board content: live tool activity while working, service info when idle.
	pi.on("agent_start", () => {
		working = true;
		tickerOffset = 0;
	});
	pi.on("agent_end", () => {
		working = false;
		activity = undefined;
		invalidateTotals();
		footerTui?.requestRender();
	});
	pi.on("tool_execution_start", (event) => {
		activity = { label: describeTool(event.toolName, event.args), startedAt: Date.now(), done: false };
		tickerOffset = 0;
		footerTui?.requestRender();
	});
	pi.on("tool_execution_end", () => {
		if (activity) activity.done = true;
	});
	pi.on("message_end", () => {
		invalidateTotals();
		footerTui?.requestRender();
	});
	pi.on("session_compact", () => invalidateTotals());

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

	pi.registerCommand("ticker", {
		description: "Station-board ticker: /ticker [on|off|speed <columns per second>]",
		getArgumentCompletions: (prefix) =>
			["on", "off", "speed"]
				.filter((name) => name.startsWith(prefix))
				.map((name) => ({ value: name, label: name })),
		handler: async (args, ctx) => {
			const [action, value] = args.trim().split(/\s+/);

			if (!action) {
				ctx.ui.notify(
					`Ticker: ${tickerVisible ? `on, ${tickerSpeed} cols/s` : "off"} — try: on, off, speed <${TICKER_MIN_SPEED}-${TICKER_MAX_SPEED}>`,
					"info",
				);
				return;
			}

			if (action === "on" || action === "off") {
				tickerVisible = action === "on";
				tickerOffset = 0;
			} else if (action === "speed") {
				const parsed = Number(value);
				if (!Number.isFinite(parsed)) {
					ctx.ui.notify(`/ticker speed needs a number (${TICKER_MIN_SPEED}-${TICKER_MAX_SPEED})`, "warning");
					return;
				}
				tickerSpeed = clampSpeed(parsed);
			} else {
				ctx.ui.notify(`Unknown ticker option "${action}" — try: on, off, speed <n>`, "warning");
				return;
			}

			const saved = saveDashboardConfig();
			startTicker();
			footerTui?.requestRender();
			ctx.ui.notify(
				`Ticker: ${tickerVisible ? `on, ${tickerSpeed} cols/s` : "off"}${saved ? "" : " (could not save preference)"}`,
				saved ? "info" : "warning",
			);
		},
	});

	pi.registerCommand("dashboard-off", {
		description: "Restore built-in header, footer, and editor",
		handler: async (_args, ctx) => {
			stopTicker();
			ctx.ui.setHeader(undefined);
			ctx.ui.setFooter(undefined);
			ctx.ui.setEditorComponent(undefined);
			ctx.ui.notify("Built-in header/footer/editor restored", "info");
		},
	});
}
