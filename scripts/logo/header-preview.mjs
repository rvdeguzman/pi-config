// Render the real header layout (art + quote column) at a few widths.
const RESET = "\x1b[0m";
const PALETTE = [
	[250, 189, 47],
	[254, 128, 25],
	[251, 73, 52],
	[254, 128, 25],
];
const FG3 = [168, 153, 132];
const YELLOW = [250, 189, 47];
const INDENT = 2;
const GAP = 4;
const QUOTE_MAX_WIDTH = 54;
const QUOTE_MIN_WIDTH = 26;

const mix = (a, b, t) => Math.round(a + (b - a) * t);
const sample = (pos) => {
	const w = ((pos % 1) + 1) % 1;
	const s = w * PALETTE.length;
	const i = Math.floor(s);
	const n = (i + 1) % PALETTE.length;
	const t = s - i;
	return [0, 1, 2].map((k) => mix(PALETTE[i][k], PALETTE[n][k], t));
};
const fg = ([r, g, b], s) => `\x1b[38;2;${r};${g};${b}m${s}${RESET}`;
const vis = (s) => [...s.replace(/\x1b\[[0-9;]*m/g, "")].length;
const gradientText = (t, ph) =>
	[...t]
		.map((c, i) => (c === " " ? c : fg(sample(i / Math.max([...t].length - 1, 1) + ph), c)))
		.join("");

const wrapText = (text, width) => {
	const lines = [];
	let line = "";
	for (const word of text.split(/\s+/)) {
		if (!line) line = word;
		else if (vis(`${line} ${word}`) <= width) line += ` ${word}`;
		else {
			lines.push(line);
			line = word;
		}
	}
	if (line) lines.push(line);
	return lines;
};

const quoteBlock = (quote, width, maxLines) => {
	const wrapped = wrapText(`"${quote.text}"`, width);
	const bodyLines = Math.max(1, maxLines - 1);
	const body = wrapped.slice(0, bodyLines);
	if (wrapped.length > bodyLines) body[body.length - 1] = `${body[body.length - 1].slice(0, width - 1)}…`;
	const author = `— ${quote.author}`;
	const pad = " ".repeat(Math.max(0, width - vis(author)));
	return [...body.map((l) => fg(FG3, l)), pad + fg(YELLOW, author)];
};

const src = (await import("node:fs")).readFileSync(
	"/Users/rv/.pi/agent/extensions/gruvbox-dashboard.ts",
	"utf8",
);
const literal = src
	.slice(src.indexOf("const LOGOS"), src.indexOf("const DEFAULT_LOGO"))
	.replace(/^const LOGOS: Record<string, readonly string\[\]> =/, "")
	.trim()
	.replace(/;$/, "");
const LOGOS = eval(`(${literal})`);

const res = await fetch("https://www.stoic-quotes.com/api/quote", { redirect: "follow" }).catch(
	() => null,
);
const quote = res
	? await res.json()
	: { text: "We suffer more often in imagination than in reality.", author: "Seneca" };

function renderHeader(art, width, quote) {
	const artWidth = Math.max(...art.map(vis));
	const columnWidth = Math.min(QUOTE_MAX_WIDTH, width - INDENT - artWidth - GAP - 1);
	const quoteLines =
		quote && columnWidth >= QUOTE_MIN_WIDTH ? quoteBlock(quote, columnWidth, art.length) : [];
	const rows = Math.max(art.length, quoteLines.length);
	const top = Math.max(0, Math.floor((rows - quoteLines.length) / 2));
	const out = [];
	for (let row = 0; row < rows; row++) {
		const artLine = (art[row] ?? "").padEnd(artWidth);
		const left = " ".repeat(INDENT) + gradientText(artLine, row * 0.045);
		const q = quoteLines[row - top];
		out.push(q ? left + " ".repeat(GAP) + q : left.replace(/ +$/, ""));
	}
	return ["", ...out, ""];
}

for (const [name, width] of [
	["brand", 100],
	["brand", 76],
	["brand", 52],
	["brand-large", 100],
]) {
	console.log(`\n\x1b[2m${"─".repeat(width)}\x1b[0m  /logo ${name} @ ${width} cols`);
	for (const line of renderHeader(LOGOS[name], width, quote)) console.log(line);
	const max = Math.max(...renderHeader(LOGOS[name], width, quote).map(vis));
	console.log(`\x1b[2m[widest line: ${max} / ${width}]\x1b[0m`);
}
