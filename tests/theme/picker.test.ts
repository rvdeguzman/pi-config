/** The live-preview picker: navigation, filtering, keeping, and reverting. */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { K, check, checkEquals, driveDialog, report, test } from "../lib/harness.ts";
import { themePicker, type ThemeChoice } from "../../extensions/theme.ts";

const CHOICES: ThemeChoice[] = [
	{ name: "dark" },
	{ name: "gruvbox", path: "/tmp/themes/gruvbox.json" },
	{ name: "gruvbox-light", path: "/tmp/themes/gruvbox-light.json" },
	{ name: "light" },
];

interface PickerRun {
	kept: string | undefined;
	/** Themes applied, in order: the live preview trail. */
	applied: string[];
	/** Screen after each key, plus frames[0] for the freshly opened picker. */
	frames: string[];
}

/** Last rendered frame. */
function screen(run: PickerRun): string {
	return run.frames.at(-1) ?? "";
}

/**
 * Drive the picker with a scripted key sequence.
 * `broken` names fail to apply, standing in for an unparsable theme file.
 */
async function pick(keys: string[], opts: { original?: string; broken?: string[] } = {}): Promise<PickerRun> {
	const applied: string[] = [];
	const frames: string[] = [];
	const broken = new Set(opts.broken ?? []);

	const { ctx } = driveDialog(async (component, render) => {
		frames.push(render());
		for (const key of keys) {
			component.handleInput?.(key);
			component.invalidate();
			frames.push(render());
		}
	});

	const kept = await themePicker(ctx as ExtensionContext, CHOICES, opts.original ?? "dark", (name) => {
		if (broken.has(name)) return { success: false, error: "invalid color token" };
		applied.push(name);
		return { success: true };
	});

	return { kept, applied, frames };
}

await test("the picker lists every theme with its source", async () => {
	const text = screen(await pick([K.esc]));
	check("title shown", text.includes("Theme"));
	check("built-ins listed", text.includes("dark") && text.includes("light"));
	check("custom theme path shown", text.includes("/tmp/themes/gruvbox.json"));
	check("built-in source labelled", text.includes("built-in"));
	check("counter shown", text.includes("4/4"));
	check("keys documented", text.includes("Enter keep") && text.includes("Esc revert"));
});

await test("the picker relayouts when the terminal width changes", async () => {
	let narrow: string[] = [];
	const { ctx } = driveDialog(async (component) => {
		component.render(90);
		narrow = component.render(30);
		component.handleInput?.(K.esc);
	});
	await themePicker(ctx as ExtensionContext, CHOICES, "dark", () => ({ success: true }));
	check("narrow render differs from the cached wide frame", narrow.every((line) => visibleWidth(line) <= 30), narrow);
});

await test("opening and closing without moving changes nothing", async () => {
	const run = await pick([K.esc]);
	check("nothing applied", run.applied.length === 0);
	check("nothing kept", run.kept === undefined);
});

await test("the cursor starts on the active theme", async () => {
	const run = await pick([K.esc], { original: "gruvbox-light" });
	const cursorLine = screen(run)
		.split("\n")
		.find((line) => line.includes("❯"));
	check("cursor sits on the active theme", cursorLine?.includes("gruvbox-light") === true, cursorLine);
});

await test("arrow keys preview themes live", async () => {
	const run = await pick([K.down, K.down, K.enter]);
	checkEquals("each step applied as it was highlighted", run.applied, ["gruvbox", "gruvbox-light"]);
	check("Enter keeps the previewed theme", run.kept === "gruvbox-light");
});

await test("Enter keeps, Esc reverts to the theme that was live on open", async () => {
	const kept = await pick([K.down, K.enter]);
	check("kept name returned", kept.kept === "gruvbox");
	checkEquals("no revert after keeping", kept.applied, ["gruvbox"]);

	const reverted = await pick([K.down, K.down, K.esc]);
	check("cancel returns nothing", reverted.kept === undefined);
	checkEquals("the original theme is re-applied last", reverted.applied, ["gruvbox", "gruvbox-light", "dark"]);
});

await test("navigation wraps in both directions", async () => {
	const up = await pick([K.up, K.enter]);
	check("up from the first row wraps to the last", up.kept === "light");
	const down = await pick([K.up, K.down, K.enter]);
	check("down from the last row wraps to the first", down.kept === "dark");
});

await test("re-highlighting the live theme does not re-apply it", async () => {
	const run = await pick([K.down, K.up, K.down, K.enter]);
	checkEquals("only real changes are applied", run.applied, ["gruvbox", "dark", "gruvbox"]);
});

await test("typing filters the list", async () => {
	const run = await pick(["g", "r", "u", K.down, K.enter]);
	const text = run.frames[3];
	check("filter shown", text.includes("filter: gru"), text);
	check("counter narrowed", text.includes("2/4"), text);
	check("filtered out themes are hidden", !text.includes("light  built-in"), text);
	check("Enter keeps a filtered row", run.kept === "gruvbox-light");
});

await test("backspace widens the filter again", async () => {
	const run = await pick(["g", "r", "u", "z", "\x7f", "\x7f", "\x7f", "\x7f", K.esc]);
	const text = screen(run);
	check("filter cleared", !text.includes("filter:"), text);
	check("all themes back", text.includes("4/4"), text);
});

await test("a filter matching nothing is reported and keeps nothing", async () => {
	const run = await pick(["z", "z", K.enter]);
	check("no-match warning shown", run.frames[2].includes('No theme matches "zz"'), run.frames[2]);
	check("Enter on an empty list keeps nothing", run.kept === undefined);
	check("nothing was applied", run.applied.length === 0);
});

await test("a theme that fails to load is reported and does not stick", async () => {
	const run = await pick([K.down, K.down, K.esc], { broken: ["gruvbox"] });
	check("loader error shown while highlighted", run.frames[1].includes("gruvbox: invalid color token"), run.frames[1]);
	check("error clears once a theme loads", !run.frames[2].includes("invalid color token"), run.frames[2]);
	// The failed preview never became live, so gruvbox-light is applied from dark
	// and the revert still knows the original is what needs restoring.
	checkEquals("only the working theme applied, then the revert", run.applied, ["gruvbox-light", "dark"]);
});

await test("ctrl+c cancels like Esc", async () => {
	const run = await pick([K.down, "\x03"]);
	check("nothing kept", run.kept === undefined);
	checkEquals("original restored", run.applied, ["gruvbox", "dark"]);
});

await test("the swatch renders the live palette", async () => {
	const text = screen(await pick([K.esc]));
	check("accent sample", text.includes("accent"));
	check("diff samples", text.includes("+ added") && text.includes("- removed"));
	check("syntax samples", text.includes("const") && text.includes('"str"'));
});

report();
