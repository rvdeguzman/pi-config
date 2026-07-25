// Compare colouring strategies for the header art, in THIS terminal.
import { readFileSync } from "node:fs";

const R = "\x1b[0m";
const src = readFileSync("/Users/rv/.pi/agent/extensions/gruvbox-dashboard.ts", "utf8");
const literal = src
	.slice(src.indexOf("const LOGOS"), src.indexOf("const DEFAULT_LOGO"))
	.replace(/^const LOGOS: Record<string, readonly string\[\]> =/, "")
	.trim()
	.replace(/;$/, "");
const ART = eval(`(${literal})`).brand;

// --- A: hardcoded truecolor (what we have now) ---
const PALETTE = [
	[250, 189, 47],
	[254, 128, 25],
	[251, 73, 52],
	[254, 128, 25],
];
const mix = (a, b, t) => Math.round(a + (b - a) * t);
const sample = (pos) => {
	const w = ((pos % 1) + 1) % 1;
	const s = w * PALETTE.length;
	const i = Math.floor(s);
	const n = (i + 1) % PALETTE.length;
	return [0, 1, 2].map((k) => mix(PALETTE[i][k], PALETTE[n][k], s - i));
};
const truecolor = (line, ph) =>
	[...line]
		.map((c, i) => {
			if (c === " ") return c;
			const [r, g, b] = sample(i / Math.max(line.length - 1, 1) + ph);
			return `\x1b[38;2;${r};${g};${b}m${c}${R}`;
		})
		.join("");

// --- B: ANSI 16 palette, banded per row (terminal decides the hues) ---
const ANSI_BANDS = [11, 3, 1, 9, 1, 3, 11, 3, 1]; // bright yellow -> red, per row
const ansi16 = (line, row) =>
	[...line]
		.map((c) => (c === " " ? c : `\x1b[38;5;${ANSI_BANDS[row % ANSI_BANDS.length]}m${c}${R}`))
		.join("");

// --- C: single ANSI accent ---
const single = (line, idx) =>
	[...line].map((c) => (c === " " ? c : `\x1b[38;5;${idx}m${c}${R}`)).join("");

// --- D: no colour at all — terminal default fg, shape shaded with bold/dim ---
const plain = (line) =>
	[...line]
		.map((c) => {
			if (c === " ") return c;
			return c === "█" ? `\x1b[1m${c}${R}` : `\x1b[2m${c}${R}`;
		})
		.join("");

// --- E: 256-colour greyscale ramp (theme-agnostic depth) ---
const GREY = [252, 250, 248, 245, 243, 240, 243, 245, 248];
const grey = (line, row) =>
	[...line]
		.map((c) => (c === " " ? c : `\x1b[38;5;${GREY[row % GREY.length]}m${c}${R}`))
		.join("");

const modes = [
	["A  truecolor gruvbox  (current: hardcoded #fabd2f -> #fb4934)", (l, r) => truecolor(l, r * 0.045)],
	["B  ANSI 16 banded     (palette slots 11/3/1/9 - follows terminal theme)", ansi16],
	["C  single ANSI accent (slot 1 = terminal's 'red')", (l) => single(l, 1)],
	["D  no colour          (default fg; █ bold, ▀▄ dim)", plain],
	["E  256 greyscale      (ramp 252->240, theme-agnostic)", grey],
];

for (const [label, fn] of modes) {
	console.log(`\n\x1b[1m${label}\x1b[0m`);
	ART.forEach((line, row) => console.log("  " + fn(line, row)));
}

console.log(`\n\x1b[2mCOLORTERM=${process.env.COLORTERM ?? "(unset)"} TERM=${process.env.TERM}\x1b[0m`);
