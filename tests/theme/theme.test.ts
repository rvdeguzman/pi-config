/** Name resolution, cycling, and the /theme command surface. */

import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { check, checkEquals, report, test } from "../lib/harness.ts";
import { cycleThemeName, filterChoices, resolveThemeName, sourceLabel } from "../../extensions/theme.ts";
import { lastNotice, loadThemeExtension } from "./harness.ts";

const NAMES = ["dark", "gruvbox", "gruvbox-light", "light"];
const THEMES = [
	{ name: "dark" },
	{ name: "light" },
	{ name: "gruvbox", path: "/tmp/themes/gruvbox.json" },
	{ name: "gruvbox-light", path: "/tmp/themes/gruvbox-light.json" },
];

await test("resolveThemeName", () => {
	checkEquals("exact match wins", resolveThemeName("gruvbox", NAMES), { kind: "match", name: "gruvbox" });
	checkEquals("match is case-insensitive", resolveThemeName("GRUVBOX", NAMES), { kind: "match", name: "gruvbox" });
	checkEquals("unique prefix resolves", resolveThemeName("da", NAMES), { kind: "match", name: "dark" });
	checkEquals("unique substring resolves", resolveThemeName("uvbox-l", NAMES), { kind: "match", name: "gruvbox-light" });
	checkEquals("shared prefix is ambiguous", resolveThemeName("gruv", NAMES), {
		kind: "ambiguous",
		candidates: ["gruvbox", "gruvbox-light"],
	});
	checkEquals("no match reports none", resolveThemeName("nord", NAMES), { kind: "none" });
	checkEquals("blank input reports none", resolveThemeName("   ", NAMES), { kind: "none" });
	// "light" is both an exact theme and a substring of gruvbox-light: exact must win.
	checkEquals("exact beats substring", resolveThemeName("light", NAMES), { kind: "match", name: "light" });
});

await test("cycleThemeName", () => {
	check("next steps forward", cycleThemeName(NAMES, "dark", 1) === "gruvbox");
	check("next wraps at the end", cycleThemeName(NAMES, "light", 1) === "dark");
	check("prev steps backward", cycleThemeName(NAMES, "gruvbox", -1) === "dark");
	check("prev wraps at the start", cycleThemeName(NAMES, "dark", -1) === "light");
	check("unknown current starts at the top", cycleThemeName(NAMES, "nord", 1) === "dark");
	check("undefined current starts at the top", cycleThemeName(NAMES, undefined, 1) === "dark");
	check("empty list yields nothing", cycleThemeName([], "dark", 1) === undefined);
});

await test("filterChoices", () => {
	const choices = THEMES.map((info) => ({ name: info.name }));
	check("blank query keeps everything", filterChoices(choices, "  ").length === 4);
	checkEquals("substring filters", filterChoices(choices, "gruv").map((c) => c.name), ["gruvbox", "gruvbox-light"]);
	check("no match yields empty", filterChoices(choices, "nord").length === 0);
});

await test("sourceLabel names where a theme comes from", () => {
	// pi hands out real paths for dark/light too: they live inside the package.
	const builtin = join(getPackageDir(), "dist", "modes", "interactive", "theme", "dark.json");
	check("package themes are built-in", sourceLabel({ name: "dark", path: builtin }) === "built-in");
	check("pathless themes are built-in", sourceLabel({ name: "dark" }) === "built-in");
	check(
		"home paths are tilde-shortened",
		sourceLabel({ name: "gruvbox", path: "/home/rv/.pi/agent/themes/gruvbox.json" }, "/home/rv") ===
			"~/.pi/agent/themes/gruvbox.json",
	);
	check(
		"other paths are shown in full",
		sourceLabel({ name: "project", path: "/srv/repo/.pi/themes/project.json" }, "/home/rv") ===
			"/srv/repo/.pi/themes/project.json",
	);
});

await test("/theme <name> switches and reports", async () => {
	const pi = loadThemeExtension({ themes: THEMES, active: "dark" });
	await pi.run("gruvbox");
	checkEquals("theme applied", pi.applied, ["gruvbox"]);
	check("active theme updated", pi.active === "gruvbox");
	check("user told which theme", lastNotice(pi) === "Theme: gruvbox");
	check("notice is informational", pi.notifications.at(-1)?.type === "info");
});

await test("/theme accepts partial names and trims", async () => {
	const pi = loadThemeExtension({ themes: THEMES, active: "dark" });
	await pi.run("  GRUVBOX-l  ");
	checkEquals("prefix resolved", pi.applied, ["gruvbox-light"]);
});

await test("/theme reports ambiguity instead of guessing", async () => {
	const pi = loadThemeExtension({ themes: THEMES, active: "dark" });
	await pi.run("gruv");
	check("nothing applied", pi.applied.length === 0);
	check("candidates listed", lastNotice(pi).includes("gruvbox, gruvbox-light"));
	check("warned", pi.notifications.at(-1)?.type === "warning");
});

await test("/theme reports unknown names with the available list", async () => {
	const pi = loadThemeExtension({ themes: THEMES, active: "dark" });
	await pi.run("nord");
	check("nothing applied", pi.applied.length === 0);
	check("names offered", lastNotice(pi).includes("dark, gruvbox, gruvbox-light, light"));
});

await test("/theme next and prev cycle the sorted list", async () => {
	const pi = loadThemeExtension({ themes: THEMES, active: "gruvbox" });
	await pi.run("next");
	check("next moves down the sorted list", pi.active === "gruvbox-light");
	await pi.run("next");
	check("next again", pi.active === "light");
	await pi.run("next");
	check("next wraps", pi.active === "dark");
	await pi.run("prev");
	check("prev wraps back", pi.active === "light");
	await pi.run("previous");
	check("previous is an alias for prev", pi.active === "gruvbox-light");
});

await test("a broken theme reports the loader error", async () => {
	const pi = loadThemeExtension({ themes: THEMES, active: "dark", broken: ["gruvbox"] });
	await pi.run("gruvbox");
	checkEquals("apply attempted", pi.attempted, ["gruvbox"]);
	check("nothing applied", pi.applied.length === 0);
	check("active theme unchanged", pi.active === "dark");
	check("error surfaced", lastNotice(pi).includes("invalid color token"));
	check("notice is an error", pi.notifications.at(-1)?.type === "error");
});

await test("argument completions cover themes plus the cycle verbs", async () => {
	const pi = loadThemeExtension({ themes: THEMES, active: "gruvbox" });
	const items = (await pi.complete("")) ?? [];
	checkEquals("every theme offered", items.slice(0, 4).map((item) => item.value), [
		"dark",
		"gruvbox",
		"gruvbox-light",
		"light",
	]);
	check("active theme marked", items.find((item) => item.value === "gruvbox")?.label === "gruvbox (active)");
	check("built-ins described", items.find((item) => item.value === "dark")?.description === "built-in");
	check(
		"custom themes show their file",
		items.find((item) => item.value === "gruvbox")?.description === "/tmp/themes/gruvbox.json",
	);
	checkEquals("cycle verbs offered", items.slice(-2).map((item) => item.value), ["next", "prev"]);

	const filtered = (await pi.complete("gruv")) ?? [];
	checkEquals("prefix filters completions", filtered.map((item) => item.value), ["gruvbox", "gruvbox-light"]);
});

await test("bare /theme opens the picker in TUI mode", async () => {
	let opened = 0;
	const pi = loadThemeExtension({
		themes: THEMES,
		active: "dark",
		// Simulate the user pressing Enter on the theme the picker previewed.
		custom: async (factory) => {
			opened++;
			factory({ requestRender() {} }, undefined, {}, () => {});
			return "light";
		},
	});
	await pi.run("");
	check("picker opened", opened === 1);
	check("kept theme reported", lastNotice(pi) === "Theme: light");
});

await test("cancelling the picker reports the theme as unchanged", async () => {
	const pi = loadThemeExtension({
		themes: THEMES,
		active: "dark",
		custom: async () => undefined,
	});
	await pi.run("");
	check("unchanged reported", lastNotice(pi) === "Theme: dark (unchanged)");
});

await test("non-TUI UI falls back to a plain selector", async () => {
	const asked: string[][] = [];
	const pi = loadThemeExtension({
		themes: THEMES,
		active: "dark",
		mode: "rpc",
		select: async (_title, options) => {
			asked.push(options);
			return "gruvbox";
		},
	});
	await pi.run("");
	checkEquals("selector listed the themes", asked, [["dark", "gruvbox", "gruvbox-light", "light"]]);
	checkEquals("selection applied", pi.applied, ["gruvbox"]);
});

await test("headless mode refuses the picker but keeps direct switching", async () => {
	const pi = loadThemeExtension({ themes: THEMES, active: "dark", mode: "print", hasUI: false });
	await pi.run("");
	check("nothing applied", pi.applied.length === 0);
	check("user pointed at the argument form", lastNotice(pi).includes("theme name"));
	await pi.run("light");
	checkEquals("named switch still works", pi.applied, ["light"]);
});

await test("the shortcut opens the picker and honours settings", async () => {
	const custom = async () => undefined;
	const withDefault = loadThemeExtension({ themes: THEMES, active: "dark", custom });
	check("default shortcut registered", withDefault.shortcut === "alt+t");
	await withDefault.pressShortcut();
	check("shortcut reported the active theme", lastNotice(withDefault) === "Theme: dark (unchanged)");

	const cwd = mkdtempSync(join(tmpdir(), "theme-settings-"));
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ themeCommand: { shortcut: "alt+y" } }));
	check("project settings override the key", loadThemeExtension({ themes: THEMES, cwd, custom }).shortcut === "alt+y");

	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ themeCommand: { shortcut: false } }));
	check("false disables the shortcut", loadThemeExtension({ themes: THEMES, cwd, custom }).shortcut === undefined);

	writeFileSync(join(cwd, ".pi", "settings.json"), "{ not json");
	check("malformed settings fall back", loadThemeExtension({ themes: THEMES, cwd, custom }).shortcut === "alt+t");
});

await test("no themes at all is reported, not crashed", async () => {
	const pi = loadThemeExtension({ themes: [], active: undefined, custom: async () => undefined });
	await pi.run("");
	check("picker refused", lastNotice(pi) === "No themes found.");
	await pi.run("next");
	check("cycling refused", lastNotice(pi) === "No themes found.");
});

report();
