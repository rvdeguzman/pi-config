import type { GuidanceFields } from "@juicesharp/rpiv-config";
import { loadJsonConfigWithLegacyFallback, validateGuidanceFields } from "@juicesharp/rpiv-config";

/** Key spec for the overlay collapse/expand shortcut, e.g. `"ctrl+]"` or `"alt+o"`. */
export type CollapseKeySpec = string;

export const DEFAULT_COLLAPSE_KEY: CollapseKeySpec = "ctrl+]";
export const COLLAPSE_KEY_OFF: CollapseKeySpec = "off";

/** Key spec for the label-overflow ticker toggle. Same grammar as `collapseKey`. */
export const DEFAULT_TICKER_KEY: CollapseKeySpec = "t";

/**
 * How an option label wider than its column is presented.
 * - `expand`: the focused label wraps onto extra rows (default; no animation, no timer).
 * - `ticker`: the focused label stays on one row and scrolls horizontally.
 */
export type OverflowMode = "expand" | "ticker";
export const DEFAULT_OVERFLOW: OverflowMode = "expand";

export interface AskUserQuestionConfig {
	guidance?: GuidanceFields;
	/** Starting overflow presentation for focused option labels. Defaults to `"expand"`. */
	overflow?: OverflowMode;
	/**
	 * Key that toggles the focused label between `expand` and `ticker` at runtime, in the
	 * same format as `collapseKey`. Defaults to `"t"`; pass `"off"` to disable the toggle.
	 * Only routed on question tabs while neither the notes editor nor the custom-answer
	 * input has the keyboard, so the default stays typable as ordinary text.
	 */
	tickerKey?: CollapseKeySpec;
	/**
	 * Key spec for the collapse/expand shortcut, in the same format as pi-coding-agent
	 * keybinding ids (`modifier+key`, e.g. `ctrl+]`, `alt+o`, `ctrl+shift+h`). Defaults
	 * to `"ctrl+]"`. Set this to a key that is reachable on your keyboard layout — Latin
	 * American layouts (where `]` is on the shifted layer) often want `"ctrl+}"` instead.
	 * Pass `"off"` to disable the collapse shortcut entirely.
	 */
	collapseKey?: CollapseKeySpec;
}

// Named keys accepted by pi-tui's `matchesKey` (keys.js switch on the parsed base key).
// parseKeyId lowercases the id before matching, so lowercase spellings are canonical.
const SPECIAL_KEYS = new Set([
	"escape",
	"esc",
	"enter",
	"return",
	"tab",
	"space",
	"backspace",
	"delete",
	"insert",
	"clear",
	"home",
	"end",
	"pageup",
	"pagedown",
	"up",
	"down",
	"left",
	"right",
	...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);

const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);

function isValidKeySpec(spec: string): boolean {
	// Mirror pi-tui's KeyId grammar strictly: zero or more distinct modifiers, then a
	// base key that is a single printable character or a named special key. A loose
	// check is not enough — pi-tui's `parseKeyId` takes the LAST `+`-part as the key
	// and ignores unknown parts, so a typo like `ctr+]` would silently match every
	// bare `]` keypress (and the raw terminal listener would consume them globally).
	if (!spec) return false;
	if (spec.startsWith("+") || spec.endsWith("+") || spec.includes("++")) return false;
	const parts = spec.split("+");
	const base = parts[parts.length - 1] ?? "";
	const modifiers = parts.slice(0, -1);
	if (modifiers.length !== new Set(modifiers).size) return false;
	if (!modifiers.every((m) => MODIFIERS.has(m))) return false;
	return base.length === 1 ? /[a-z0-9_\-!@#$%^&*()|~`'":;,./<>?[\]{}=\\]/.test(base) : SPECIAL_KEYS.has(base);
}

/**
 * Resolve one key-spec field against its default. `loadConfig()` is an unchecked cast over
 * user JSON, so a non-string value (e.g. `"collapseKey": 5`) reaches here — treat it like any
 * other invalid value and fall back, matching the documented "invalid values use the default"
 * behavior instead of throwing out of the tool call.
 */
function resolveKeySpec(raw: unknown, fallback: CollapseKeySpec): CollapseKeySpec {
	if (typeof raw !== "string") return fallback;
	const spec = raw.trim().toLowerCase();
	if (spec === "") return fallback;
	if (spec === COLLAPSE_KEY_OFF) return COLLAPSE_KEY_OFF;
	return isValidKeySpec(spec) ? spec : fallback;
}

export function resolveCollapseKey(config: Pick<AskUserQuestionConfig, "collapseKey">): CollapseKeySpec {
	return resolveKeySpec(config.collapseKey, DEFAULT_COLLAPSE_KEY);
}

export function resolveTickerKey(config: Pick<AskUserQuestionConfig, "tickerKey">): CollapseKeySpec {
	return resolveKeySpec(config.tickerKey, DEFAULT_TICKER_KEY);
}

export function resolveOverflow(config: Pick<AskUserQuestionConfig, "overflow">): OverflowMode {
	return config.overflow === "ticker" ? "ticker" : DEFAULT_OVERFLOW;
}

export function loadConfig(): AskUserQuestionConfig {
	return loadJsonConfigWithLegacyFallback<AskUserQuestionConfig>("rpiv-ask-user-question");
}

export { validateGuidanceFields };
