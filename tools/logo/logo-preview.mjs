// Preview the gruvbox-dashboard banners without booting pi.
const RESET = "\x1b[0m";
const PALETTE = [
	[250, 189, 47],
	[254, 128, 25],
	[251, 73, 52],
	[254, 128, 25],
];
const mix = (a, b, t) => Math.round(a + (b - a) * t);
function sample(pos) {
	const w = ((pos % 1) + 1) % 1;
	const s = w * PALETTE.length;
	const i = Math.floor(s);
	const n = (i + 1) % PALETTE.length;
	const t = s - i;
	const a = PALETTE[i];
	const b = PALETTE[n];
	return [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
}
const fg = ([r, g, b], s) => `\x1b[38;2;${r};${g};${b}m${s}${RESET}`;
function gradientText(text, phase) {
	const chars = [...text];
	const span = Math.max(chars.length - 1, 1);
	return chars.map((c, i) => (c === " " ? c : fg(sample(i / span + phase), c))).join("");
}

const src = await import("node:fs").then((fs) =>
	fs.readFileSync(new URL("file:///Users/rv/.pi/agent/extensions/gruvbox-dashboard.ts"), "utf8"),
);
const body = src.slice(src.indexOf("const LOGOS"), src.indexOf("const DEFAULT_LOGO"));
const literal = body
	.replace(/^const LOGOS: Record<string, readonly string\[\]> =/, "")
	.trim()
	.replace(/;$/, "");
const LOGOS = eval(`(${literal})`);

for (const [name, lines] of Object.entries(LOGOS)) {
	console.log(`\n  /logo ${name}   (${[...lines[0]].length} wide x ${lines.length})`);
	for (const [row, line] of lines.entries()) console.log("   " + gradientText(line, row * 0.045));
}
console.log();
