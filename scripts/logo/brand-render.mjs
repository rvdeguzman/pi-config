// Rasterize the Berserk Brand of Sacrifice into half-block ASCII at any size.
//
// Pixel grid is W wide x (H*2) tall; each output row packs two pixel rows into
// one cell via ▀ (top only), ▄ (bottom only), █ (both), space (neither).
// Terminal cells are ~1:2, so half-block pixels come out roughly square.
//
// Geometry traced off the reference art (869x1456), normalized to 0..1 with y
// down. The mark is NOT a triangle: two long diagonals cross in an X, thin
// horn-spikes rise off the upper elbows, the lower edges close into a diamond,
// and a central vertical spike runs through it all — crown at the top, point at
// the bottom.
//
// Aspect: the source is 869/1456 ≈ 0.60 w:h, so a W-wide render wants
// W/0.60 pixel rows ≈ W/1.19 character rows.

const PIX = [" ", "▀", "▄", "█"]; // index = top | bottom<<1
export const BRAND_ASPECT = 869 / 1456;

/** Tapered thick segment: half-width goes t0 -> t1 along a -> b (fractions of W). */
const seg = (a, b, t0, t1 = t0) => ({ a, b, t0, t1 });

export function brandStrokes({ stroke = 0.075, spike = 0.055 } = {}) {
	const XL = [0.035, 0.237]; // upper-left elbow
	const XR = [0.965, 0.237]; // upper-right elbow
	const DL = [0.035, 0.694]; // lower-left elbow (diamond west point)
	const DR = [0.965, 0.694]; // lower-right elbow (diamond east point)
	const TIP = [0.5, 0.965]; // bottom point of the diamond
	return [
		// The X: each upper elbow runs straight through the crossing to the
		// opposite lower elbow — one stroke, not two.
		seg(XL, DR, stroke),
		seg(XR, DL, stroke),
		// Horn spikes off the upper elbows, tapering to a needle point.
		seg(XL, [0.285, 0.075], stroke, 0.004),
		seg(XR, [0.715, 0.075], stroke, 0.004),
		// Lower edges closing the diamond.
		seg(DL, TIP, stroke),
		seg(DR, TIP, stroke),
		// Central spike: crown at the top, point below the diamond.
		seg([0.5, 0.09], [0.5, 0.9], spike, spike),
		seg([0.5, 0.09], [0.5, 0.027], spike, 0.004), // crown centre needle
		seg([0.5, 0.9], [0.5, 0.995], spike, 0.004), // bottom point
		// Crown barbs.
		seg([0.5, 0.105], [0.425, 0.062], spike * 0.7, 0.004),
		seg([0.5, 0.105], [0.575, 0.062], spike * 0.7, 0.004),
	];
}

/** Distance from p to segment a-b, plus the clamped parameter along it. */
function projectToSeg([px, py], [ax, ay], [bx, by]) {
	const dx = bx - ax;
	const dy = by - ay;
	const len2 = dx * dx + dy * dy || 1;
	let t = ((px - ax) * dx + (py - ay) * dy) / len2;
	t = Math.max(0, Math.min(1, t));
	return { dist: Math.hypot(px - (ax + t * dx), py - (ay + t * dy)), t };
}

/**
 * Render at `cols` wide. Rows default to the aspect-correct height. `coverage`
 * is the fraction of sub-samples that must land inside a stroke for the pixel to
 * turn on — lower keeps the needle-thin spikes alive at small sizes.
 */
export function renderBrand(cols, rows, opts = {}) {
	const { stroke, spike, coverage = 0.35, samples = 3 } = opts;
	const W = cols;
	const H = (rows ?? Math.round(cols / BRAND_ASPECT / 2)) * 2;
	const strokes = brandStrokes({ stroke, spike });
	// Pixel space: 1 cell wide x 1 half-cell tall ≈ square, so Euclidean
	// distance there gives an isotropic stroke. x maps to W, y maps to H.
	const sx = W;
	const sy = H;
	const px = [];
	for (let y = 0; y < H; y++) {
		const row = [];
		for (let x = 0; x < W; x++) {
			let hits = 0;
			let total = 0;
			for (let sj = 0; sj < samples; sj++) {
				for (let si = 0; si < samples; si++) {
					total++;
					const p = [x + (si + 0.5) / samples, y + (sj + 0.5) / samples];
					for (const s of strokes) {
						const a = [s.a[0] * sx, s.a[1] * sy];
						const b = [s.b[0] * sx, s.b[1] * sy];
						const { dist, t } = projectToSeg(p, a, b);
						const halfWidth = ((s.t0 + (s.t1 - s.t0) * t) * sx) / 2;
						if (dist <= halfWidth) {
							hits++;
							break;
						}
					}
				}
			}
			row.push(hits / total >= coverage ? 1 : 0);
		}
		px.push(row);
	}
	const out = [];
	for (let y = 0; y < H; y += 2) {
		let line = "";
		for (let x = 0; x < W; x++) line += PIX[px[y][x] | ((px[y + 1]?.[x] ?? 0) << 1)];
		out.push(line.replace(/\s+$/, "").padEnd(W, " "));
	}
	return out;
}

/** omp's splash trick: double every glyph horizontally and every row vertically. */
export function double(lines) {
	return lines.flatMap((line) => {
		let wide = "";
		for (const ch of line) wide += ch === " " ? "  " : `${ch}${ch}`;
		return [wide, wide];
	});
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const show = (label, lines) => {
		console.log(`\n${label}  (${[...lines[0]].length}x${lines.length})`);
		for (const l of lines) console.log("  " + l);
	};
	const cols = Number(process.argv[2] ?? 0);
	if (cols) {
		show(`brand ${cols}`, renderBrand(cols, undefined, { stroke: Number(process.argv[3]) || 0.075 }));
	} else {
		show("14 wide", renderBrand(14, undefined, { stroke: 0.12, spike: 0.09 }));
		show("20 wide", renderBrand(20, undefined, { stroke: 0.095, spike: 0.07 }));
		show("28 wide", renderBrand(28, undefined, { stroke: 0.08, spike: 0.055 }));
		show("40 wide", renderBrand(40, undefined, { stroke: 0.07, spike: 0.045 }));
	}
}
