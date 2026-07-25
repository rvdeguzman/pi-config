/**
 * theme - Swap and hot-preview pi themes from a slash command.
 *
 * pi already loads themes (built-in `dark`/`light`, `~/.pi/agent/themes/*.json`,
 * project `.pi/themes/*.json`, packages), but the only way to change one is the
 * `/settings` menu. This adds a direct command plus a live-preview picker.
 *
 * Usage
 *   /theme                 open the picker; ↑↓ previews live, Enter keeps, Esc reverts
 *   /theme gruvbox         switch immediately (exact, prefix, or substring match)
 *   /theme next | prev     cycle through the available themes (hot-swap)
 *   alt+t                  same as bare /theme (configurable, see below)
 *
 * `ctx.ui.setTheme()` both repaints the UI and writes `theme` to
 * ~/.pi/agent/settings.json, so a kept choice survives restarts. Cancelling the
 * picker restores whatever was active when it opened.
 *
 * Caveat: pi also accepts a `"theme": "light-name/dark-name"` pair that follows the
 * terminal's appearance. Keeping a theme here pins one name and so ends that
 * auto-switching; restore it in `/settings` or settings.json.
 *
 * Settings (global ~/.pi/agent/settings.json, overridable by <cwd>/.pi/settings.json):
 *   { "themeCommand": { "shortcut": "alt+t" } }
 * Set `shortcut` to "" / false to register no keybinding.
 *
 * Editing a theme file needs no command: pi watches the active custom theme and
 * reloads it on save, so `nvim ~/.pi/agent/themes/gruvbox.json` is already a
 * hot-reload loop.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	getPackageDir,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, KeyId } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A selectable theme: `path` is undefined for the built-ins. */
export interface ThemeChoice {
	name: string;
	path?: string;
}

interface ThemeSettings {
	/** Keybinding that opens the picker. undefined = no shortcut. */
	shortcut?: string;
}

const DEFAULT_SHORTCUT = "alt+t";

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function readJson(path: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The block is `themeCommand`, not `theme`: `theme` is pi's own string setting
 * for the active theme, and clobbering it with an object would break startup.
 */
export function readThemeSettings(cwd: string): ThemeSettings {
	const result: ThemeSettings = { shortcut: DEFAULT_SHORTCUT };
	const sources = [join(getAgentDir(), "settings.json"), join(cwd, CONFIG_DIR_NAME, "settings.json")];
	for (const source of sources) {
		const block = readJson(source)?.themeCommand;
		if (!block || typeof block !== "object") continue;
		const shortcut = (block as Record<string, unknown>).shortcut;
		if (shortcut === false || shortcut === "" || shortcut === null) result.shortcut = undefined;
		else if (typeof shortcut === "string" && shortcut.trim()) result.shortcut = shortcut.trim();
	}
	return result;
}

// ---------------------------------------------------------------------------
// Name resolution
// ---------------------------------------------------------------------------

export type Resolution =
	| { kind: "match"; name: string }
	| { kind: "none" }
	| { kind: "ambiguous"; candidates: string[] };

/**
 * Resolve user input to a theme name: exact (case-insensitive), then prefix,
 * then substring. Anything matching several themes is reported rather than
 * guessed, so `/theme gru` stays predictable as themes are added.
 */
export function resolveThemeName(input: string, names: string[]): Resolution {
	const query = input.trim().toLowerCase();
	if (!query) return { kind: "none" };

	const exact = names.find((name) => name.toLowerCase() === query);
	if (exact) return { kind: "match", name: exact };

	for (const test of [
		(name: string) => name.toLowerCase().startsWith(query),
		(name: string) => name.toLowerCase().includes(query),
	]) {
		const hits = names.filter(test);
		if (hits.length === 1) return { kind: "match", name: hits[0] };
		if (hits.length > 1) return { kind: "ambiguous", candidates: hits };
	}
	return { kind: "none" };
}

/** Step `delta` themes from `current`, wrapping. Unknown current starts at the top. */
export function cycleThemeName(names: string[], current: string | undefined, delta: number): string | undefined {
	if (names.length === 0) return undefined;
	const index = current === undefined ? -1 : names.indexOf(current);
	if (index === -1) return names[delta >= 0 ? 0 : names.length - 1];
	return names[(((index + delta) % names.length) + names.length) % names.length];
}

// ---------------------------------------------------------------------------
// Picker
// ---------------------------------------------------------------------------

/** Substring filter over theme names; empty query keeps everything. */
export function filterChoices(choices: ThemeChoice[], query: string): ThemeChoice[] {
	const q = query.trim().toLowerCase();
	if (!q) return choices;
	return choices.filter((choice) => choice.name.toLowerCase().includes(q));
}

/**
 * Where a theme comes from, for the right-hand column.
 *
 * `dark` and `light` do carry a path — inside the installed pi package — so the
 * package directory, not a missing path, is what marks a theme as built-in.
 */
export function sourceLabel(choice: ThemeChoice, home = homedir(), packageDir = getPackageDir()): string {
	if (!choice.path || choice.path.startsWith(packageDir)) return "built-in";
	return choice.path.startsWith(home) ? `~${choice.path.slice(home.length)}` : choice.path;
}

/**
 * Live-preview theme picker.
 *
 * Every cursor move applies the theme for real (`apply`), which is the whole
 * point: you judge a theme against your actual transcript, not a swatch. Enter
 * keeps the applied theme, Esc re-applies the one that was active on open.
 */
export function themePicker(
	ctx: ExtensionContext,
	choices: ThemeChoice[],
	original: string | undefined,
	apply: (name: string) => { success: boolean; error?: string },
): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		let query = "";
		let visible = choices;
		let cursor = Math.max(
			0,
			choices.findIndex((choice) => choice.name === original),
		);
		let lastApplied = original;
		let error: string | undefined;
		let settled = false;
		let cachedLines: string[] | undefined;
		let cachedWidth: number | undefined;

		function refresh(): void {
			cachedLines = undefined;
			tui.requestRender();
		}

		/** Apply the highlighted theme, unless it is already the live one. */
		function preview(): void {
			const name = visible[cursor]?.name;
			if (name === undefined || name === lastApplied) return;
			const result = apply(name);
			lastApplied = result.success ? name : lastApplied;
			error = result.success ? undefined : `${name}: ${result.error ?? "failed to load"}`;
			refresh();
		}

		function finish(kept: string | undefined): void {
			if (settled) return;
			settled = true;
			// Revert: only touch the theme if the preview actually moved.
			if (kept === undefined && original !== undefined && lastApplied !== original) apply(original);
			done(kept);
		}

		function move(delta: number): void {
			if (visible.length === 0) return;
			cursor = (((cursor + delta) % visible.length) + visible.length) % visible.length;
			preview();
		}

		function setQuery(next: string): void {
			query = next;
			visible = filterChoices(choices, query);
			cursor = Math.min(cursor, Math.max(0, visible.length - 1));
			preview();
		}

		function handleInput(data: string): void {
			if (data === "\x1b" || data === "\x03") {
				finish(undefined);
				return;
			}
			if (data === "\r" || data === "\n") {
				finish(visible[cursor]?.name);
				return;
			}
			if (data === "\x1b[A" || data === "\x10") {
				move(-1);
				return;
			}
			if (data === "\x1b[B" || data === "\x0e") {
				move(1);
				return;
			}
			if (data === "\x7f" || data === "\b") {
				if (query) setQuery(query.slice(0, -1));
				return;
			}
			// Printable single characters filter the list; escape sequences do not.
			if (data.length === 1 && data >= " " && data !== "\x7f") setQuery(query + data);
		}

		function render(width: number): string[] {
			const w = Math.max(24, width);
			if (cachedLines && cachedWidth === w) return cachedLines;
			const lines: string[] = [];
			const add = (prefix: string, text: string) => {
				const prefixWidth = visibleWidth(prefix);
				if (prefixWidth >= w) {
					lines.push(...wrapTextWithAnsi(prefix + text, w));
					return;
				}
				const wrapped = wrapTextWithAnsi(text, w - prefixWidth);
				const cont = " ".repeat(prefixWidth);
				wrapped.forEach((line, i) => lines.push(`${i === 0 ? prefix : cont}${line}`));
			};

			lines.push(theme.fg("borderAccent", "─".repeat(w)));
			const title = theme.fg("accent", theme.bold("Theme"));
			const counter = theme.fg("dim", ` ${visible.length}/${choices.length}`);
			add(" ", `${title}${counter}${query ? theme.fg("muted", `  filter: ${query}`) : ""}`);
			lines.push("");

			if (visible.length === 0) {
				add(" ", theme.fg("warning", `No theme matches "${query}"`));
			}

			// Keep the highlighted row on screen without redrawing the whole list.
			const viewport = Math.max(3, Math.min(visible.length, 12));
			const start = Math.min(Math.max(0, cursor - Math.floor(viewport / 2)), Math.max(0, visible.length - viewport));
			const nameWidth = Math.min(
				24,
				Math.max(8, ...visible.slice(start, start + viewport).map((choice) => visibleWidth(choice.name))),
			);

			for (let i = start; i < Math.min(visible.length, start + viewport); i++) {
				const choice = visible[i];
				const onCursor = i === cursor;
				const isOriginal = choice.name === original;
				const name = truncateToWidth(choice.name, nameWidth, "…").padEnd(nameWidth, " ");
				const source = truncateToWidth(sourceLabel(choice), Math.max(8, w - nameWidth - 8), "…");
				const row = `${theme.fg(onCursor ? "accent" : "text", name)}  ${theme.fg("dim", source)}`;
				add(onCursor ? theme.fg("accent", "❯ ") : "  ", isOriginal ? `${row}${theme.fg("muted", " ·")}` : row);
			}

			lines.push("");
			add(" ", swatch(theme));
			if (error) add(" ", theme.fg("error", error));
			lines.push("");
			add(" ", theme.fg("dim", "↑↓ preview · type to filter · Enter keep · Esc revert"));
			lines.push(theme.fg("borderAccent", "─".repeat(w)));

			cachedLines = lines;
			cachedWidth = w;
			return lines;
		}

		// Nothing is applied until the user moves: opening the picker is free.
		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
		};
	});
}

/** One-line palette sample, rendered with whatever theme is currently live. */
function swatch(theme: ExtensionContext["ui"]["theme"]): string {
	return [
		theme.fg("accent", "accent"),
		theme.fg("success", "+ added"),
		theme.fg("error", "- removed"),
		theme.fg("warning", "warn"),
		theme.fg("syntaxKeyword", "const"),
		theme.fg("syntaxString", '"str"'),
		theme.fg("mdHeading", "# head"),
		theme.bg("userMessageBg", theme.fg("userMessageText", " you ")),
		theme.fg("muted", "muted"),
		theme.fg("dim", "dim"),
	].join(theme.fg("dim", " · "));
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

function listChoices(ctx: ExtensionContext): ThemeChoice[] {
	return ctx.ui
		.getAllThemes()
		.map((info) => ({ name: info.name, ...(info.path ? { path: info.path } : {}) }))
		.sort((a, b) => a.name.localeCompare(b.name));
}

function activeThemeName(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.ui.theme.name;
	} catch {
		return undefined;
	}
}

function switchTo(ctx: ExtensionContext, name: string): void {
	const result = ctx.ui.setTheme(name);
	if (result.success) ctx.ui.notify(`Theme: ${name}`, "info");
	else ctx.ui.notify(`Theme "${name}" failed to load: ${result.error ?? "unknown error"}`, "error");
}

async function openPicker(ctx: ExtensionContext): Promise<void> {
	const choices = listChoices(ctx);
	if (choices.length === 0) {
		ctx.ui.notify("No themes found.", "warning");
		return;
	}
	const original = activeThemeName(ctx);

	// ui.custom() is TUI-only; RPC still has dialogs, so fall back to a plain
	// selector there (no live preview, one apply at the end).
	if (ctx.mode !== "tui") {
		if (!ctx.hasUI) {
			ctx.ui.notify("/theme needs an interactive UI. Pass a theme name instead.", "warning");
			return;
		}
		const picked = await ctx.ui.select(
			"Theme",
			choices.map((choice) => choice.name),
		);
		if (picked !== undefined && picked !== original) switchTo(ctx, picked);
		return;
	}

	const kept = await themePicker(ctx, choices, original, (name) => ctx.ui.setTheme(name));
	if (kept === undefined) {
		ctx.ui.notify(original ? `Theme: ${original} (unchanged)` : "Theme unchanged", "info");
		return;
	}
	// setTheme already persisted the preview, so this is only the confirmation.
	ctx.ui.notify(`Theme: ${kept}`, "info");
}

function handleArgument(ctx: ExtensionContext, arg: string): void {
	const choices = listChoices(ctx);
	const names = choices.map((choice) => choice.name);
	const current = activeThemeName(ctx);

	if (arg === "next" || arg === "prev" || arg === "previous") {
		const target = cycleThemeName(names, current, arg === "next" ? 1 : -1);
		if (target === undefined) ctx.ui.notify("No themes found.", "warning");
		else switchTo(ctx, target);
		return;
	}

	const resolved = resolveThemeName(arg, names);
	if (resolved.kind === "match") {
		switchTo(ctx, resolved.name);
		return;
	}
	if (resolved.kind === "ambiguous") {
		ctx.ui.notify(`"${arg}" matches ${resolved.candidates.join(", ")}`, "warning");
		return;
	}
	ctx.ui.notify(`No theme matches "${arg}". Available: ${names.join(", ")}`, "warning");
}

function completions(ctx: ExtensionContext, prefix: string): AutocompleteItem[] {
	const current = activeThemeName(ctx);
	const items: AutocompleteItem[] = listChoices(ctx).map((choice) => ({
		value: choice.name,
		label: choice.name === current ? `${choice.name} (active)` : choice.name,
		description: sourceLabel(choice),
	}));
	items.push(
		{ value: "next", label: "next", description: "Cycle to the next theme" },
		{ value: "prev", label: "prev", description: "Cycle to the previous theme" },
	);
	const query = prefix.trim().toLowerCase();
	return query ? items.filter((item) => item.value.toLowerCase().includes(query)) : items;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function theme(pi: ExtensionAPI) {
	// getArgumentCompletions gets no ctx of its own, so keep the newest one we have
	// seen. session_start populates it before any completion request can arrive.
	let commandCtx: ExtensionContext | undefined;
	let registeredShortcut = false;

	pi.registerCommand("theme", {
		description: "Switch theme: /theme [name|next|prev], no argument opens a live-preview picker",
		getArgumentCompletions: (prefix) => {
			const ctx = commandCtx;
			return ctx ? completions(ctx, prefix) : null;
		},
		handler: async (args, ctx) => {
			commandCtx = ctx;
			const arg = args.trim();
			if (!arg) {
				await openPicker(ctx);
				return;
			}
			handleArgument(ctx, arg);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		commandCtx = ctx;
		if (!ctx.hasUI) return;
		const { shortcut } = readThemeSettings(ctx.cwd);
		if (!shortcut || registeredShortcut) return;
		registeredShortcut = true;
		pi.registerShortcut(shortcut as KeyId, {
			description: "Open the theme picker",
			handler: async (shortcutCtx) => {
				await openPicker(shortcutCtx);
			},
		});
	});
}
