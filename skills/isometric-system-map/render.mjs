#!/usr/bin/env node
// isometric-system-map — deterministic renderer.
// spec JSON in, one self-contained HTML file out. Zero dependencies.
//
//   node render.mjs --spec system.json --out map.html [--root .] [--validate-only]
//
// Geometry, layout, hatching and edge routing all happen here so that output is
// identical across runs. The agent's only job is to author a truthful spec.

import fs from 'node:fs';
import path from 'node:path';

/* ─────────────────────────── projection ─────────────────────────── */

const TW = 32;   // half tile width  (screen px per grid unit on X)
const TH = 16;   // half tile height (screen px per grid unit on Y)
const ZU = 27;   // screen px per grid unit of height

const proj = (x, y, z = 0) => [(x - y) * TW, (x + y) * TH - z * ZU];
const pt = (x, y, z = 0) => proj(x, y, z).map((n) => Math.round(n * 100) / 100).join(',');

/* ─────────────────────────── shape vocabulary ─────────────────────────── */
// Morphology is meaning. Dimensions come from metrics, never from taste.

const SHAPES = {
  block: 'service / process — something that runs and holds logic',
  slab: 'shared library / common code — wide, low, everyone stands on it',
  stack: 'store / archive / versioned data — layered plates',
  fins: 'replicated workers / instances — one fin per replica',
  plate: 'adapter / config / thin binding — barely any thickness',
  tower: 'measurement / observability / gate — tall and narrow',
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// → { w, d, solids[] } in grid units, origin at the node's cell corner.
function massing(node) {
  const m = node.metrics || {};
  const c = clamp(m.complexity ?? 2, 1, 5);
  const surf = clamp(m.surface ?? 2, 1, 5);
  const rep = clamp(m.replicas ?? 4, 2, 9);
  const s = 0.86 + 0.07 * surf; // footprint scale from surface area

  switch (node.shape) {
    case 'slab': {
      const w = 2.05 * s, d = 1.5 * s, h = 0.2 + 0.055 * c;
      return { w, d, solids: [{ x: 0, y: 0, z: 0, w, d, h }] };
    }
    case 'stack': {
      const w = 1.7 * s, d = 1.7 * s, t = 0.13, g = 0.075;
      const layers = Math.round(clamp(m.layers ?? rep, 2, 8));
      const solids = [];
      for (let i = 0; i < layers; i++) solids.push({ x: 0, y: 0, z: i * (t + g), w, d, h: t });
      return { w, d, solids };
    }
    case 'fins': {
      const n = Math.round(rep), fw = 0.3, fg = 0.14;
      const d = 1.3 * s, h = 0.85 + 0.16 * c;
      const solids = [];
      for (let i = 0; i < n; i++) solids.push({ x: i * (fw + fg), y: 0, z: 0, w: fw, d, h });
      return { w: n * fw + (n - 1) * fg, d, solids };
    }
    case 'plate': {
      const w = 1.15 * s, d = 0.98 * s, h = 0.12 + 0.035 * c;
      return { w, d, solids: [{ x: 0, y: 0, z: 0, w, d, h }] };
    }
    case 'tower': {
      const w = 0.72 * s, d = 0.72 * s, h = 1.65 + 0.42 * c;
      return { w, d, solids: [{ x: 0, y: 0, z: 0, w, d, h }] };
    }
    case 'block':
    default: {
      const w = 1.16 * s, d = 1.16 * s, h = 0.8 + 0.3 * c;
      return { w, d, solids: [{ x: 0, y: 0, z: 0, w, d, h }] };
    }
  }
}

/* ─────────────────────────── layout ─────────────────────────── */
// Rank by flow depth along the X axis; groups get disjoint bands on the Y axis
// so palisades can never overlap. Explicit `cell` wins over all of it.

const GAP = 0.62;        // between buildings inside a band
const RANK_GAP = 1.25;   // between ranks
const BAND_GAP = 1.8;    // between palisade bands
const PAL_PAD = 0.8;     // palisade breathing room around its members
const topOf = (n) => Math.max(...n._mass.solids.map((s) => s.z + s.h));
// A tall building hides whatever stands behind it, so it has to buy clearance.
const clearance = (n) => GAP + Math.max(0, topOf(n) - 1) * 0.42;

// Real systems have cycles (store → api → gateway → log → workers → store).
// Strip the back edges with a DFS first, rank on the DAG that remains, and the
// cycle comes back as a return road instead of pushing ranks to infinity.
function rankNodes(nodes, edges) {
  const has = new Set(nodes.map((n) => n.id));
  const out = new Map(nodes.map((n) => [n.id, []]));
  const clean = [];
  for (const e of edges) {
    if (!has.has(e.from) || !has.has(e.to) || e.from === e.to) continue;
    out.get(e.from).push(e.to);
    clean.push(e);
  }

  const indegRaw = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of clean) indegRaw.set(e.to, indegRaw.get(e.to) + 1);

  const colour = new Map(nodes.map((n) => [n.id, 0])); // 0 white 1 grey 2 black
  const back = new Set();
  const roots = [...nodes.filter((n) => indegRaw.get(n.id) === 0).map((n) => n.id), ...nodes.map((n) => n.id)];
  for (const r of roots) {
    if (colour.get(r) !== 0) continue;
    const stack = [[r, 0]];
    colour.set(r, 1);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const kids = out.get(frame[0]);
      if (frame[1] >= kids.length) { colour.set(frame[0], 2); stack.pop(); continue; }
      const nxt = kids[frame[1]++];
      if (colour.get(nxt) === 1) back.add(`${frame[0]}\u0000${nxt}`);   // edge into the live stack
      else if (colour.get(nxt) === 0) { colour.set(nxt, 1); stack.push([nxt, 0]); }
    }
  }

  const dag = clean.filter((e) => !back.has(`${e.from}\u0000${e.to}`));
  const kids = new Map(nodes.map((n) => [n.id, []]));
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of dag) { kids.get(e.from).push(e.to); indeg.set(e.to, indeg.get(e.to) + 1); }

  const rank = new Map(nodes.map((n) => [n.id, 0]));
  const queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  while (queue.length) {
    const cur = queue.shift();
    for (const nxt of kids.get(cur)) {
      rank.set(nxt, Math.max(rank.get(nxt), rank.get(cur) + 1));
      indeg.set(nxt, indeg.get(nxt) - 1);
      if (indeg.get(nxt) === 0) queue.push(nxt);
    }
  }
  return rank;
}

function layout(nodes, edges, groups) {
  for (const n of nodes) n._mass = massing(n);
  const rank = rankNodes(nodes, edges);

  const bandKey = (n) => n.group || '_loose';
  const order = [];
  const seenBand = new Set();
  for (const g of groups) if (nodes.some((n) => n.group === g.id)) { order.push(g.id); seenBand.add(g.id); }
  if (nodes.some((n) => !n.group)) order.push('_loose');

  const byBandRank = new Map(); // `${band}|${rank}` → nodes
  for (const n of nodes) {
    const k = `${bandKey(n)}|${rank.get(n.id)}`;
    if (!byBandRank.has(k)) byBandRank.set(k, []);
    byBandRank.get(k).push(n);
  }
  for (const list of byBandRank.values()) list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));

  const ranks = [...new Set(nodes.map((n) => rank.get(n.id)))].sort((a, b) => a - b);

  // X offset per rank = widest member of that rank
  const xoff = new Map();
  let cx = 0;
  for (const r of ranks) {
    xoff.set(r, cx);
    const inRank = nodes.filter((n) => rank.get(n.id) === r);
    const wide = Math.max(...inRank.map((n) => n._mass.w));
    const tall = Math.max(...inRank.map((n) => topOf(n)));
    cx += wide + RANK_GAP + Math.max(0, tall - 1) * 0.3;
  }

  // Y band per group = deepest column that group needs in any rank. Bands never
  // share Y, which is what guarantees two palisades can never overlap.
  const columnDepth = (band, r) => {
    const list = byBandRank.get(`${band}|${r}`) || [];
    return list.reduce((acc, n) => acc + n._mass.d + clearance(n), 0) - (list.length ? GAP : 0);
  };
  const bandDepth = new Map(order.map((band) => [band, Math.max(...ranks.map((r) => columnDepth(band, r)), 0)]));

  const yoff = new Map();
  let cy = 0;
  for (const band of order) {
    yoff.set(band, cy);
    cy += bandDepth.get(band) + BAND_GAP;
  }

  for (const band of order) {
    for (const r of ranks) {
      const list = byBandRank.get(`${band}|${r}`) || [];
      // centre each rank's column inside the band so the spine reads as a street
      let y = yoff.get(band) + Math.max(0, (bandDepth.get(band) - columnDepth(band, r)) / 2);
      for (const n of list) {
        n.gx = xoff.get(r);
        n.gy = y;
        n.rank = r;
        // the empty street just outside this band's wall, used as a return road
        n.lane = yoff.get(band) + bandDepth.get(band) + PAL_PAD + BAND_GAP * 0.28;
        y += n._mass.d + clearance(n);
      }
    }
  }
  for (const n of nodes) {
    if (Array.isArray(n.cell)) { n.gx = n.cell[0]; n.gy = n.cell[1]; }
  }
  return nodes;
}

/* ─────────────────────────── edge routing ─────────────────────────── */
// Manhattan routes in grid space, projected afterwards, so every segment lands
// on an isometric axis exactly like a surveyed road.

function centre(n) { return { x: n.gx + n._mass.w / 2, y: n.gy + n._mass.d / 2 }; }

// Forward edges run in the empty street between two ranks. Anything that goes
// backwards or sideways takes the ring road round the edge of the city, so a
// wire never has to cut under a building it has nothing to do with.
function route(a, b) {
  const A = centre(a), B = centre(b);
  const aR = a.gx + a._mass.w, bL = b.gx;
  if (bL > aR + 0.2) {
    const mx = (aR + bL) / 2;
    if (Math.abs(A.y - B.y) < 0.02) return [[aR, A.y], [bL, B.y]];
    return [[aR, A.y], [mx, A.y], [mx, B.y], [bL, B.y]];
  }
  // back edge or same rank: out the front, along the street, back in the front
  const lane = Math.max(a.lane ?? 0, b.lane ?? 0, a.gy + a._mass.d + GAP * 0.8, b.gy + b._mass.d + GAP * 0.8);
  return [[A.x, a.gy + a._mass.d], [A.x, lane], [B.x, lane], [B.x, b.gy + b._mass.d]];
}

function routeLen(r) {
  let L = 0;
  for (let i = 1; i < r.length; i++) L += Math.hypot(r[i][0] - r[i - 1][0], r[i][1] - r[i - 1][1]);
  return L;
}
function routeAt(r, frac) {
  const total = routeLen(r); let want = total * frac;
  for (let i = 1; i < r.length; i++) {
    const seg = Math.hypot(r[i][0] - r[i - 1][0], r[i][1] - r[i - 1][1]);
    if (want <= seg || i === r.length - 1) {
      const t = seg ? want / seg : 0;
      return [r[i - 1][0] + (r[i][0] - r[i - 1][0]) * t, r[i - 1][1] + (r[i][1] - r[i - 1][1]) * t];
    }
    want -= seg;
  }
  return r[0];
}

/* ─────────────────────────── svg emitters ─────────────────────────── */

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Hatching, not flat fill: tone comes from line density per face orientation,
// the way a surveyor's drawing shades a solid. Each tile carries its own base
// tone so a face is a single polygon.
function hatch(id, tone, gapPx, rotate, weight) {
  const h = 6;
  return `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${gapPx}" height="${h}"`
    + (rotate ? ` patternTransform="rotate(${rotate})"` : '')
    + `><rect width="${gapPx}" height="${h}" style="fill:var(${tone})"/>`
    + `<path d="M${(gapPx / 2).toFixed(2)} -0.5 V${h + 0.5}" style="stroke:var(--ink);stroke-width:${weight}" opacity="0.34"/></pattern>`;
}

const DEFS = `<defs>`
  + hatch('hT', '--face-t', 3.7, 0, 0.5)
  + hatch('hR', '--face-r', 2.5, 0, 0.55)
  + hatch('hL', '--face-l', 3.1, -32, 0.55)
  + hatch('hTs', '--face-t-sel', 3.7, 0, 0.5)
  + hatch('hRs', '--face-r-sel', 2.5, 0, 0.55)
  + hatch('hLs', '--face-l-sel', 3.1, -32, 0.55)
  + `</defs>`;

function solidSVG(n, s) {
  const { x, y, z, w, d, h } = s;
  const X = n.gx + x, Y = n.gy + y, Z = z, T = z + h;
  const top = [pt(X, Y, T), pt(X + w, Y, T), pt(X + w, Y + d, T), pt(X, Y + d, T)].join(' ');
  const right = [pt(X + w, Y, T), pt(X + w, Y + d, T), pt(X + w, Y + d, Z), pt(X + w, Y, Z)].join(' ');
  const left = [pt(X, Y + d, T), pt(X + w, Y + d, T), pt(X + w, Y + d, Z), pt(X, Y + d, Z)].join(' ');
  return `<polygon class="f fL" points="${left}"/><polygon class="f fR" points="${right}"/><polygon class="f fT" points="${top}"/>`;
}

function buildingSVG(n) {
  const m = n._mass;
  const solids = [...m.solids].sort((a, b) => (a.x + a.y + a.z) - (b.x + b.y + b.z));
  const body = solids.map((s) => solidSVG(n, s)).join('');
  const topZ = Math.max(...m.solids.map((s) => s.z + s.h));
  const [lx, ly] = proj(n.gx + m.w / 2, n.gy + m.d / 2, topZ);
  const [cx, cy] = proj(n.gx + m.w / 2, n.gy + m.d / 2, 0);
  const kids = (n.children || []).length;
  return `<g class="bld" data-node="${esc(n.id)}" data-cx="${cx.toFixed(1)}" data-cy="${cy.toFixed(1)}" data-kids="${kids}" tabindex="-1">`
    + `<title>${esc(n.code)} · ${esc(n.name)}</title>`
    + body
    + `<text class="code" x="${lx.toFixed(1)}" y="${(ly + 3.2).toFixed(1)}">${esc(n.code)}</text>`
    + (kids ? `<text class="into" x="${lx.toFixed(1)}" y="${(ly + 13).toFixed(1)}">\u25ab</text>` : '')
    + `</g>`;
}

function palisadeSVG(g, members) {
  if (!members.length) return '';
  const x0 = Math.min(...members.map((n) => n.gx)) - PAL_PAD;
  const y0 = Math.min(...members.map((n) => n.gy)) - PAL_PAD;
  const x1 = Math.max(...members.map((n) => n.gx + n._mass.w)) + PAL_PAD;
  const y1 = Math.max(...members.map((n) => n.gy + n._mass.d)) + PAL_PAD;
  const ring = [pt(x0, y0), pt(x1, y0), pt(x1, y1), pt(x0, y1)].join(' ');
  // Ride the name along the outside of the north-west wall. Corners are where
  // buildings stand; the strip just outside a wall is always open ground.
  const [ax, ay] = proj(x0, y0);
  const [bx, by] = proj(x0, y1);
  const lx = (ax + bx) / 2 - 15, ly = (ay + by) / 2 - 8;
  const planned = g.state === 'planned';
  return {
    ring: `<g class="pal${planned ? ' planned' : ''}" data-group="${esc(g.id)}"><polygon class="palring" points="${ring}"/></g>`,
    label: `<text class="pallabel" transform="translate(${lx.toFixed(1)} ${ly.toFixed(1)}) rotate(-26.57)">`
      + `${esc(g.name)}${planned ? ' · not switched on' : ''}</text>`,
  };
}

function edgeSVG(e, a, b) {
  const r = route(a, b);
  const dAttr = r.map((p, i) => `${i ? 'L' : 'M'}${pt(p[0], p[1])}`).join(' ');
  const [mx, my] = routeAt(r, 0.55);
  const [px, py] = proj(mx, my);
  const dir = `M${px} ${py - 4.9} L${px + 4.9} ${py} L${px} ${py + 4.9} L${px - 4.9} ${py} Z`;
  return `<g class="edge k-${esc(e.kind || 'control')}" data-edge="${esc(e.id)}" data-from="${esc(e.from)}" data-to="${esc(e.to)}">`
    + `<path class="wire" d="${dAttr}"/><path class="tip" d="${dir}"/></g>`;
}

function gridSVG(nodes) {
  const xs = nodes.map((n) => n.gx), ys = nodes.map((n) => n.gy);
  const xw = nodes.map((n) => n.gx + n._mass.w), yd = nodes.map((n) => n.gy + n._mass.d);
  const x0 = Math.floor(Math.min(...xs) - 3), x1 = Math.ceil(Math.max(...xw) + 3);
  const y0 = Math.floor(Math.min(...ys) - 3), y1 = Math.ceil(Math.max(...yd) + 3);
  let s = '';
  for (let x = x0; x <= x1; x++) s += `<line x1="${proj(x, y0)[0]}" y1="${proj(x, y0)[1]}" x2="${proj(x, y1)[0]}" y2="${proj(x, y1)[1]}"/>`;
  for (let y = y0; y <= y1; y++) s += `<line x1="${proj(x0, y)[0]}" y1="${proj(x0, y)[1]}" x2="${proj(x1, y)[0]}" y2="${proj(x1, y)[1]}"/>`;
  return `<g class="grid">${s}</g>`;
}

// One level = one ground plane. Root plus at most one level of interiors.
function levelSVG(levelId, nodes, edges, groups) {
  layout(nodes, edges, groups);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const palParts = groups
    .map((g) => palisadeSVG(g, nodes.filter((n) => n.group === g.id)))
    .filter(Boolean);
  const pals = palParts.map((p) => p.ring).join('');
  const palLabels = palParts.map((p) => p.label).join('');
  const wires = edges
    .filter((e) => byId.has(e.from) && byId.has(e.to) && e.from !== e.to)
    .map((e) => edgeSVG(e, byId.get(e.from), byId.get(e.to)))
    .join('');
  const blds = [...nodes]
    .sort((a, b) => (a.gx + a.gy + a._mass.w / 2 + a._mass.d / 2) - (b.gx + b.gy + b._mass.w / 2 + b._mass.d / 2))
    .map(buildingSVG)
    .join('');

  const px = nodes.flatMap((n) => {
    const h = Math.max(...n._mass.solids.map((s) => s.z + s.h));
    return [proj(n.gx, n.gy, h), proj(n.gx + n._mass.w, n.gy, h), proj(n.gx, n.gy + n._mass.d, 0), proj(n.gx + n._mass.w, n.gy + n._mass.d, 0)];
  });
  const bbox = { // room for wall labels on the left and return roads below
    x0: Math.min(...px.map((p) => p[0])) - 120, x1: Math.max(...px.map((p) => p[0])) + 90,
    y0: Math.min(...px.map((p) => p[1])) - 75, y1: Math.max(...px.map((p) => p[1])) + 110,
  };
  // rings under the city, labels over it — a name should never hide behind a roof.
  // .overlay stays empty until a flow runs, then the live wire is lifted into it
  // so the traced path is never occluded by the buildings it passes.
  const svg = `<g class="level" id="lv-${esc(levelId)}">${gridSVG(nodes)}${pals}`
    + `<g class="wires">${wires}</g>${blds}`
    + `<g class="pallabels">${palLabels}</g><g class="overlay"></g></g>`;
  return { svg, bbox, nodes };
}

/* ─────────────────────────── validation ─────────────────────────── */

function validate(spec, root) {
  const errs = [], warns = [];
  const E = (m) => errs.push(m), W = (m) => warns.push(m);

  if (!spec.meta?.title) E('meta.title is required');
  if (!Array.isArray(spec.nodes) || !spec.nodes.length) { E('nodes[] is required'); return { errs, warns }; }
  if (!Array.isArray(spec.edges)) E('edges[] is required (may be empty only for a single-node system)');

  const stats = spec.meta?.stats || [];
  if (stats.length < 2 || stats.length > 6) W(`meta.stats should hold 2-6 cells, found ${stats.length}`);

  const groups = new Set((spec.groups || []).map((g) => g.id));
  const codes = new Map(), ids = new Set();

  const checkCites = (owner, cites) => {
    if (!Array.isArray(cites) || !cites.length) { E(`${owner}: no citations — every node and edge must cite real files`); return 0; }
    let ok = 0;
    for (const c of cites) {
      if (!c.path) { E(`${owner}: citation without a path`); continue; }
      const abs = path.resolve(root, c.path);
      if (!fs.existsSync(abs)) { E(`${owner}: cited path does not exist — ${c.path}`); continue; }
      if (c.lines) {
        const mm = /^(\d+)(?:-(\d+))?$/.exec(String(c.lines));
        if (!mm) { E(`${owner}: bad line range "${c.lines}" (use "12" or "12-40")`); continue; }
        const total = fs.readFileSync(abs, 'utf8').split('\n').length;
        const hi = Number(mm[2] || mm[1]);
        if (hi > total) { E(`${owner}: ${c.path}:${c.lines} runs past end of file (${total} lines)`); continue; }
      }
      ok++;
    }
    return ok;
  };

  const walk = (nodes, level, parent) => {
    if (nodes.length > 40) E(`${level}: ${nodes.length} buildings — hard cap is 40, abstract into districts`);
    else if (nodes.length > 28) W(`${level}: ${nodes.length} buildings — past the ~28 legible cap, consider merging into districts`);
    for (const n of nodes) {
      const who = `node ${n.id || '(no id)'}`;
      if (!n.id) E('a node has no id');
      if (ids.has(n.id)) E(`duplicate node id "${n.id}"`); else ids.add(n.id);
      if (!n.code) E(`${who}: no code`);
      else if (codes.has(n.code)) E(`duplicate code "${n.code}" (${codes.get(n.code)} and ${n.id})`);
      else codes.set(n.code, n.id);
      if (!n.name) E(`${who}: no name`);
      if (!SHAPES[n.shape]) E(`${who}: unknown shape "${n.shape}" — one of ${Object.keys(SHAPES).join(', ')}`);
      if (!n.does) E(`${who}: missing "does"`);
      if (!n.built) E(`${who}: missing "built"`);
      if (n.group && !groups.has(n.group)) E(`${who}: group "${n.group}" is not declared`);
      n._citeCount = checkCites(who, n.cites);
      if (parent && (n.children || []).length) E(`${who}: drill-down is capped at one level`);
      if ((n.children || []).length) walk(n.children, `inside ${n.id}`, n);
    }
  };
  walk(spec.nodes, 'root level', null);

  const allIds = new Set();
  const collect = (ns) => ns.forEach((n) => { allIds.add(n.id); collect(n.children || []); });
  collect(spec.nodes);

  const edgeIds = new Set();
  for (const e of spec.edges || []) {
    const who = `edge ${e.id || `${e.from}->${e.to}`}`;
    if (!e.id) E(`${who}: no id`);
    if (edgeIds.has(e.id)) E(`duplicate edge id "${e.id}"`); else edgeIds.add(e.id);
    if (!allIds.has(e.from)) E(`${who}: unknown source "${e.from}"`);
    if (!allIds.has(e.to)) E(`${who}: unknown target "${e.to}"`);
    if (!['control', 'data', 'async'].includes(e.kind)) E(`${who}: kind must be control | data | async`);
    checkCites(who, e.cites);
  }

  for (const f of spec.flows || []) {
    if (!f.id || !f.name) E('a flow is missing id or name');
    if (!Array.isArray(f.steps) || !f.steps.length) E(`flow ${f.id}: no steps`);
    for (const s of f.steps || []) {
      if (!edgeIds.has(s.edge)) E(`flow ${f.id}: step references unknown edge "${s.edge}"`);
      if (!s.caption) W(`flow ${f.id}: step ${s.edge} has no caption`);
    }
  }

  for (const n of spec.nodes) if (n._citeCount === 0) W(`node ${n.id} ended with 0 verified citations`);
  return { errs, warns };
}

/* ─────────────────────────── html ─────────────────────────── */

const CSS = `
:root{
  --paper:#cdc49b; --paper-2:#c9c096; --ink:#2f2b1c; --ink-2:#5c553b; --ink-3:#847c5c;
  --rule:#8d8564; --grid:#bcb490;
  --face-t:#c6bd96; --face-r:#b6ae89; --face-l:#a49c77;
  --face-t-sel:#b3a97f; --face-r-sel:#a0976f; --face-l-sel:#8d855f;
  --mark:#2f2b1c; --hl:#2f2b1c;
  --mono:"SF Mono",ui-monospace,"JetBrains Mono",Menlo,Consolas,monospace;
}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{background:var(--paper);color:var(--ink);font:12px/1.5 var(--mono);
  display:grid;grid-template-rows:auto 1fr;overflow:hidden;-webkit-font-smoothing:antialiased}

/* top strip */
.bar{display:flex;border-bottom:1px solid var(--rule);background:var(--paper)}
.stat{padding:5px 14px 7px;border-right:1px solid var(--rule);min-width:96px}
.stat b{display:block;font:400 9px/1.4 var(--mono);letter-spacing:.14em;color:var(--ink-3);text-transform:uppercase}
.stat span{font:600 13px/1.5 var(--mono);letter-spacing:.02em}
.bar .tools{margin-left:auto;display:flex;align-items:center;gap:6px;padding:0 10px}
button{font:inherit;font-size:9.5px;letter-spacing:.13em;text-transform:uppercase;color:var(--ink);
  background:transparent;border:1px solid var(--rule);padding:4px 9px;cursor:pointer}
button:hover{background:#00000010}
button[disabled]{opacity:.35;cursor:default}
button.on{background:var(--ink);color:var(--paper);border-color:var(--ink)}

.wrap{display:grid;grid-template-columns:232px 1fr 336px;min-height:0}

/* legend */
.legend{border-right:1px solid var(--rule);overflow:auto;padding:8px 10px 40px}
.legend h2{font:400 9px/1.6 var(--mono);letter-spacing:.16em;color:var(--ink-3);
  text-transform:uppercase;margin:12px 2px 6px}
.legend h2:first-child{margin-top:2px}
.row{display:flex;gap:7px;align-items:baseline;width:100%;text-align:left;
  border:1px solid var(--rule);padding:4px 7px;margin:0 0 4px;background:transparent;
  text-transform:none;letter-spacing:0;font-size:11px;line-height:1.35}
.row .c{font-size:9px;color:var(--ink-3);min-width:14px;letter-spacing:.06em}
.row .n{flex:1;font-weight:600;letter-spacing:.04em;text-transform:uppercase}
.row .k{font-size:9.5px;color:var(--ink-3)}
.row.child{margin-left:14px;width:calc(100% - 14px)}
.row:hover{background:#00000010}
.row.sel{background:var(--ink);color:var(--paper);border-color:var(--ink)}
.row.sel .c,.row.sel .k{color:var(--paper)}
.row.dim{opacity:.4}

/* map */
.map{position:relative;overflow:hidden;background:var(--paper);cursor:grab}
.map.drag{cursor:grabbing}
#scene{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none}
/* strokes are drawn in screen px, so zooming out never dissolves the drawing */
.grid line,.f,.wire,.palring,.edge.k-async .tip{vector-effect:non-scaling-stroke}
.grid line{stroke:var(--grid);stroke-width:.8;fill:none}
.f{stroke:var(--ink);stroke-width:1;stroke-linejoin:round}
.fT{fill:url(#hT)}.fR{fill:url(#hR)}.fL{fill:url(#hL)}
.bld{cursor:pointer}
.bld .code{font:600 8.5px var(--mono);letter-spacing:.1em;text-anchor:middle;fill:var(--ink);pointer-events:none;
  paint-order:stroke;stroke:var(--face-t);stroke-width:2.4;stroke-linejoin:round}
.bld .into{font:400 8px var(--mono);text-anchor:middle;fill:var(--ink-2);pointer-events:none}
.bld:hover .fT,.bld.sel .fT{fill:url(#hTs)}
.bld:hover .fR,.bld.sel .fR{fill:url(#hRs)}
.bld:hover .fL,.bld.sel .fL{fill:url(#hLs)}
.bld.sel .f{stroke-width:1.9}
.bld.dim{opacity:.42}

.edge .wire{fill:none;stroke:var(--ink);stroke-width:1.35;opacity:.88;stroke-linejoin:round;stroke-linecap:round}
.edge .tip{fill:var(--mark);opacity:.88}
.edge.k-data .wire{stroke-width:.9;opacity:.62}
.edge.k-data .tip{opacity:.62}
.edge.k-async .wire{stroke-dasharray:5 4;stroke-width:1.1;opacity:.66}
.edge.k-async .tip{fill:none;stroke:var(--mark);stroke-width:1;opacity:.66}
.edge.hot .wire{stroke-width:2.1;opacity:1}
.edge.hot .tip{opacity:1;fill:var(--mark)}
.edge.cold{opacity:.22}
.edge.live .wire{stroke-width:2.6;opacity:1;stroke-dasharray:none;
  paint-order:stroke;stroke:var(--ink)}
.edge.live .tip{opacity:1;fill:var(--mark);stroke:var(--paper);stroke-width:1.4}

.pal .palring{fill:none;stroke:var(--ink-2);stroke-width:.9;opacity:.4}
.pal.planned .palring{stroke-dasharray:7 5;opacity:.45}
.pallabels text{font:400 8px var(--mono);letter-spacing:.14em;fill:var(--ink-2);text-transform:uppercase;
  text-anchor:middle;paint-order:stroke;stroke:var(--paper);stroke-width:3.5;stroke-linejoin:round}

.zoom{position:absolute;top:8px;right:8px;display:flex;flex-direction:column;gap:4px}
.zoom button{width:22px;height:20px;padding:0;line-height:1;font-size:11px;background:var(--paper)}
.crumb{position:absolute;top:8px;left:10px;font-size:9.5px;letter-spacing:.14em;
  text-transform:uppercase;color:var(--ink-3)}
.crumb b{color:var(--ink);font-weight:600}
.hint{position:absolute;left:0;right:0;bottom:0;padding:5px 12px;border-top:1px solid var(--rule);
  background:var(--paper);font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3)}
.step{position:absolute;left:12px;bottom:30px;right:52px;font-size:11px;color:var(--ink);
  border-left:2px solid var(--ink);padding:3px 9px;background:#cdc49bdd;display:none}
.step.on{display:block}

/* explainer */
.panel{border-left:1px solid var(--rule);display:grid;grid-template-rows:auto 1fr;min-height:0}
.tabs{display:flex;border-bottom:1px solid var(--rule)}
.tabs button{flex:1;border:0;border-right:1px solid var(--rule);padding:6px 8px}
.tabs button:last-child{border-right:0}
.body{overflow:auto;padding:12px 16px 28px}
.eyebrow{font:400 9px/1.6 var(--mono);letter-spacing:.16em;color:var(--ink-3);text-transform:uppercase}
.body h1{font:400 19px/1.3 var(--mono);letter-spacing:.01em;margin:4px 0 6px}
.body h3{font:400 9px/1.6 var(--mono);letter-spacing:.16em;color:var(--ink-3);
  text-transform:uppercase;margin:16px 0 5px}
.body p{margin:0 0 9px;font-size:11.5px;line-height:1.65}
.body .lede{color:var(--ink-2);font-size:10.5px;margin-bottom:12px}
mark{background:var(--ink);color:var(--paper);padding:0 3px}
.cite{display:block;font-size:10.5px;padding:3px 0 3px 9px;border-left:1px solid var(--rule);margin:0 0 3px}
.cite b{font-weight:600}
.cite i{font-style:normal;color:var(--ink-3)}
.cond{border-left:2px solid var(--ink);padding:4px 0 4px 9px;font-size:11px}
.tag{display:inline-block;border:1px solid var(--rule);padding:1px 6px;font-size:9px;
  letter-spacing:.1em;text-transform:uppercase;color:var(--ink-2);margin:0 4px 4px 0}
.key{display:flex;gap:8px;align-items:center;margin:0 0 5px;font-size:10.5px}
.key svg{width:38px;height:26px;flex:none;display:block}
.key i{font-style:normal;color:var(--ink-3)}
::-webkit-scrollbar{width:9px;height:9px}
::-webkit-scrollbar-thumb{background:#8d856455}
`;

const CLIENT = String.raw`
const S = window.__MAP__;
let level = 'root', sel = null, tab = 'does', flow = null, step = -1, timer = null;
const cam = { x: 0, y: 0, k: 1 };
const svg = document.getElementById('scene');
const cams = document.getElementById('cam');
const map = document.getElementById('map');
const q = (s, r = document) => r.querySelector(s);
const qa = (s, r = document) => [...r.querySelectorAll(s)];
const node = (id) => S.index[id];

function apply() {
  cams.setAttribute('transform', 'translate(' + cam.x + ' ' + cam.y + ') scale(' + cam.k + ')');
}
function fit(id) {
  const b = S.levels[id].bbox, r = map.getBoundingClientRect();
  const k = Math.min(r.width / (b.x1 - b.x0), (r.height - 30) / (b.y1 - b.y0));
  cam.k = Math.min(1.35, Math.max(0.18, k));
  cam.x = r.width / 2 - ((b.x0 + b.x1) / 2) * cam.k;
  cam.y = (r.height - 24) / 2 - ((b.y0 + b.y1) / 2) * cam.k;
  apply();
}
function centreOn(id) {
  const g = q('.bld[data-node="' + CSS.escape(id) + '"]');
  if (!g) return;
  const r = map.getBoundingClientRect();
  cam.x = r.width / 2 - (+g.dataset.cx) * cam.k;
  cam.y = (r.height - 24) / 2 - (+g.dataset.cy) * cam.k;
  apply();
}

/* ---- level switching ---- */
function showLevel(id) {
  level = id;
  qa('.level').forEach((l) => { l.style.display = l.id === 'lv-' + id ? '' : 'none'; });
  const crumb = q('#crumb');
  crumb.innerHTML = id === 'root'
    ? '<b>' + S.meta.repo + '</b>'
    : '<b>' + S.meta.repo + '</b> \u2192 ' + node(id).code + ' \u00b7 ' + node(id).name + '  \u2014 \u238b to come back out';
  renderLegend();
  fit(id);
  select(id === 'root' ? null : id, false);
}
function enter(id) { if (S.levels[id] && id !== level) showLevel(id); }

/* ---- selection ---- */
function select(id, move = true) {
  sel = id;
  qa('.bld').forEach((b) => b.classList.toggle('sel', b.dataset.node === id));
  qa('.row').forEach((r) => r.classList.toggle('sel', r.dataset.node === id));
  qa('.edge').forEach((e) => {
    const touch = id && (e.dataset.from === id || e.dataset.to === id);
    e.classList.toggle('hot', !!touch && !flow);
    e.classList.toggle('cold', !!id && !touch && !flow);
  });
  if (id && move) centreOn(id);
  paint();
}

/* ---- explainer ---- */
function para(t) { return String(t).replace(/\[\[(.+?)\]\]/g, '<mark>$1</mark>'); }
function paint() {
  const body = q('#body');
  const n = sel ? node(sel) : null;
  q('#tabDoes').classList.toggle('on', tab === 'does');
  q('#tabBuilt').classList.toggle('on', tab === 'built');
  if (!n) {
    const m = S.meta;
    if (tab === 'does') {
      body.innerHTML = '<div class="eyebrow">' + m.repo + '</div><h1>' + m.title + '</h1>'
        + '<p class="lede">' + para(m.subtitle || '') + '</p>'
        + (m.intro || []).map((p, i) => (i === 0 ? '<h3>What this is</h3>' : '') + '<p>' + para(p) + '</p>').join('')
        + '<h3>How to read it</h3><p>' + para(m.readIt || 'Hover any building for a plain description; <mark>How it\u2019s built</mark> gives the implementation and the files behind it.') + '</p>';
    } else {
      body.innerHTML = '<div class="eyebrow">Legend</div><h1>How it\u2019s built</h1>'
        + '<h3>Shapes</h3>' + S.key.shapes.map((s) => '<div class="key">' + s.svg + '<span><b>' + s.name + '</b> \u2014 <i>' + s.text + '</i></span></div>').join('')
        + '<h3>Lines</h3>' + S.key.edges.map((s) => '<div class="key">' + s.svg + '<span><b>' + s.name + '</b> \u2014 <i>' + s.text + '</i></span></div>').join('')
        + '<h3>Palisades</h3><p>A perimeter wraps everything inside one runtime boundary \u2014 a process, a deployment unit, a trust zone. Crossing one costs you: serialisation, auth, latency. A dashed perimeter is not switched on yet.</p>'
        + (S.groups.length ? S.groups.map((g) => '<div class="cite"><b>' + g.name + '</b> <i>' + (g.state === 'planned' ? 'planned \u00b7 ' : '') + (g.kind || 'runtime') + '</i>' + (g.note ? '<br>' + g.note : '') + '</div>').join('') : '')
        + '<h3>Size</h3><p>Height tracks internal complexity, footprint tracks surface area, and a fin count is a replica count. Nothing here is decorative.</p>';
    }
    return;
  }
  if (tab === 'does') {
    body.innerHTML = '<div class="eyebrow">' + n.code + (n.groupName ? ' \u00b7 ' + n.groupName : '') + '</div>'
      + '<h1>' + n.name + '</h1>'
      + '<div>' + '<span class="tag">' + n.shape + '</span>'
      + (n.kids ? '<span class="tag">\u21b5 ' + n.kids + ' inside</span>' : '')
      + '<span class="tag">' + n.cites.length + ' file' + (n.cites.length === 1 ? '' : 's') + '</span></div>'
      + '<h3>What it does</h3><p>' + para(n.does) + '</p>'
      + (n.condition ? '<h3>Condition</h3><div class="cond">' + para(n.condition) + '</div>' : '')
      + (n.links.length ? '<h3>Connections</h3>' + n.links.map((l) => '<div class="cite"><b>' + l.dir + ' ' + l.other + '</b> <i>' + l.kind + '</i>' + (l.label ? '<br>' + l.label : '') + '</div>').join('') : '');
  } else {
    body.innerHTML = '<div class="eyebrow">' + n.code + '</div><h1>' + n.name + '</h1>'
      + '<h3>How it\u2019s built</h3><p>' + para(n.built) + '</p>'
      + '<h3>Files</h3>' + n.cites.map((c) => '<div class="cite"><b>' + c.path + (c.lines ? ':' + c.lines : '') + '</b>' + (c.note ? '<br><i>' + c.note + '</i>' : '') + '</div>').join('')
      + (n.edgeCites.length ? '<h3>Wiring</h3>' + n.edgeCites.map((c) => '<div class="cite"><b>' + c.path + (c.lines ? ':' + c.lines : '') + '</b><br><i>' + c.note + '</i></div>').join('') : '');
  }
}

/* ---- legend ---- */
function renderLegend() {
  const host = q('#legend'), lv = S.levels[level];
  host.innerHTML = lv.sections.map((s) =>
    '<h2>' + s.title + '</h2>' + s.nodes.map((id) => {
      const n = node(id);
      return '<button class="row' + (n.parent ? ' child' : '') + '" data-node="' + id + '">'
        + '<span class="c">' + n.code + '</span><span class="n">' + n.name + '</span>'
        + '<span class="k">' + n.cites.length + '</span></button>';
    }).join('')
  ).join('');
  qa('.row', host).forEach((r) => {
    r.onclick = () => select(r.dataset.node);
    r.ondblclick = () => enter(r.dataset.node);
  });
}

/* ---- flows ---- */
function stopFlow() {
  clearInterval(timer); timer = null;
  q('#play').textContent = flow ? '\u25b6 Resume the flow' : '\u25b6 Run the flow';
}
function resetFlow() {
  stopFlow(); flow = null; step = -1;
  qa('.edge').forEach((e) => {
    e.classList.remove('live', 'cold', 'hot');
    const home = e.closest('.level').querySelector('.wires');
    if (e.parentNode !== home) home.appendChild(e);   // put it back on the ground
  });
  q('#stepbox').classList.remove('on');
  select(sel, false);
}
function lightStep() {
  const f = S.flows.find((x) => x.id === flow);
  if (!f) return;
  const s = f.steps[step];
  const lv = q('#lv-' + level);
  qa('.edge').forEach((e) => {
    e.classList.remove('hot');
    const live = e.dataset.edge === s.edge;
    e.classList.toggle('live', live);
    e.classList.toggle('cold', !live);
    const home = live ? lv.querySelector('.overlay') : e.closest('.level').querySelector('.wires');
    if (home && e.parentNode !== home) home.appendChild(e);
  });
  const box = q('#stepbox');
  box.classList.add('on');
  box.innerHTML = '<b>' + (step + 1) + '/' + f.steps.length + '</b> \u00b7 ' + para(s.caption || '');
  const e = S.edges[s.edge];
  if (e) {
    const t = node(e.to);
    qa('.bld').forEach((b) => b.classList.toggle('sel', b.dataset.node === e.to));
    if (t) centreOn(e.to);
  }
}
function stepOne() {
  if (!flow) flow = (S.flows[0] || {}).id;
  const f = S.flows.find((x) => x.id === flow);
  if (!f) return;
  step = (step + 1) % f.steps.length;
  lightStep();
}
function play() {
  if (timer) { stopFlow(); return; }
  if (!flow) { flow = (S.flows[0] || {}).id; step = -1; }
  if (!S.flows.length) return;
  q('#play').textContent = '\u25a0 Pause';
  stepOne();
  timer = setInterval(stepOne, 1500);
}

/* ---- camera input ---- */
let dragging = false, last = null;
map.addEventListener('pointerdown', (e) => {
  if (e.target.closest('button')) return;
  dragging = true; last = [e.clientX, e.clientY];
  map.classList.add('drag'); map.setPointerCapture(e.pointerId);
});
map.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  cam.x += e.clientX - last[0]; cam.y += e.clientY - last[1];
  last = [e.clientX, e.clientY]; apply();
});
map.addEventListener('pointerup', () => { dragging = false; map.classList.remove('drag'); });
map.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = map.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
  const k = Math.min(2.6, Math.max(0.12, cam.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
  cam.x = mx - (mx - cam.x) * (k / cam.k); cam.y = my - (my - cam.y) * (k / cam.k);
  cam.k = k; apply();
}, { passive: false });

qa('.bld').forEach((b) => {
  b.addEventListener('click', () => select(b.dataset.node, false));
  b.addEventListener('dblclick', () => enter(b.dataset.node));
  b.addEventListener('mouseenter', () => { if (!sel) { const k = sel; sel = b.dataset.node; paint(); sel = k; } });
});

document.addEventListener('keydown', (e) => {
  const order = S.levels[level].order;
  if (e.key === 'Escape') { if (level !== 'root') showLevel('root'); else { resetFlow(); select(null); } }
  else if (e.key === 'Enter' && sel && S.levels[sel]) enter(sel);
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const i = order.indexOf(sel);
    const nx = e.key === 'ArrowDown' ? (i + 1) % order.length : (i - 1 + order.length) % order.length;
    select(order[nx]);
  } else if (e.key === ' ') { e.preventDefault(); play(); }
  else if (e.key === '.') stepOne();
});

q('#tabDoes').onclick = () => { tab = 'does'; paint(); };
q('#tabBuilt').onclick = () => { tab = 'built'; paint(); };
q('#play').onclick = play;
q('#stepb').onclick = () => { stopFlow(); stepOne(); };
q('#reset').onclick = () => { resetFlow(); showLevel('root'); };
q('#zin').onclick = () => { cam.k = Math.min(2.6, cam.k * 1.2); apply(); };
q('#zout').onclick = () => { cam.k = Math.max(0.12, cam.k / 1.2); apply(); };
window.addEventListener('resize', () => fit(level));

showLevel('root');
`;

function keySwatch(shape) {
  const n = { id: 'k', code: '', shape, metrics: { complexity: 2, surface: 2, replicas: 4 }, gx: 0, gy: 0 };
  n._mass = massing(n);
  const solids = [...n._mass.solids].sort((a, b) => (a.x + a.y + a.z) - (b.x + b.y + b.z));
  const body = solids.map((s) => solidSVG(n, s)).join('');
  const w = n._mass.w, d = n._mass.d;
  const hmax = Math.max(...n._mass.solids.map((s) => s.z + s.h));
  const xs = [proj(0, 0, hmax), proj(w, 0, hmax), proj(w, d, 0), proj(0, d, 0), proj(0, 0, 0), proj(w, d, hmax)];
  const x0 = Math.min(...xs.map((p) => p[0])) - 2, x1 = Math.max(...xs.map((p) => p[0])) + 2;
  const y0 = Math.min(...xs.map((p) => p[1])) - 2, y1 = Math.max(...xs.map((p) => p[1])) + 2;
  return `<svg width="38" height="26" viewBox="${x0} ${y0} ${x1 - x0} ${y1 - y0}">${body}</svg>`;
}

const EDGE_KEY = [
  { name: 'Control', kind: 'control', text: 'a synchronous call — A makes B do something and waits' },
  { name: 'Data', kind: 'data', text: 'a payload moves; the diamond points where it lands' },
  { name: 'Async', kind: 'async', text: 'queue, event, cron — decoupled in time' },
];
function edgeSwatch(kind) {
  return `<svg width="38" height="26" viewBox="0 0 40 12"><g class="edge k-${kind}"><path class="wire" d="M2,6 L38,6"/><path class="tip" d="M20,2 L24,6 L20,10 L16,6 Z"/></g></svg>`;
}

function html(spec, levels, index, edgesById) {
  const m = spec.meta;
  const stats = (m.stats || []).map((s) => `<div class="stat"><b>${esc(s.label)}</b><span>${esc(s.value)}</span></div>`).join('');
  const scene = Object.values(levels).map((l) => l.svg).join('');
  const data = {
    meta: m,
    groups: spec.groups || [],
    flows: (spec.flows || []).map((f) => ({ id: f.id, name: f.name, steps: f.steps })),
    edges: edgesById,
    index,
    levels: Object.fromEntries(Object.entries(levels).map(([k, v]) => [k, { bbox: v.bbox, sections: v.sections, order: v.order }])),
    key: {
      shapes: Object.entries(SHAPES).map(([k, t]) => ({ name: k, text: t, svg: keySwatch(k) })),
      edges: EDGE_KEY.map((e) => ({ name: e.name, text: e.text, svg: edgeSwatch(e.kind) })),
    },
  };
  const json = JSON.stringify(data).replace(/<\//g, '<\\/');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(m.title)} — isometric system map</title>
<style>${CSS}</style></head>
<body>
<div class="bar">
  <div class="stat"><b>Repository</b><span>${esc(m.repo || '')}</span></div>
  ${stats}
  <div class="tools">
    <button id="play">▶ Run the flow</button>
    <button id="stepb">Trace one step</button>
    <button id="reset">Reset view</button>
  </div>
</div>
<div class="wrap">
  <div class="legend" id="legend"></div>
  <div class="map" id="map">
    <svg id="scene">${DEFS}<g id="cam">${scene}</g></svg>
    <div class="crumb" id="crumb"></div>
    <div class="zoom"><button id="zin">+</button><button id="zout">−</button></div>
    <div class="step" id="stepbox"></div>
    <div class="hint">↵ go inside · ⎋ come back out · ↓↑ move · space run · . step · drag to pan · scroll to zoom</div>
  </div>
  <div class="panel">
    <div class="tabs"><button id="tabDoes" class="on">What it does</button><button id="tabBuilt">How it's built</button></div>
    <div class="body" id="body"></div>
  </div>
</div>
<script>window.__MAP__=${json};</script>
<script>${CLIENT}</script>
</body></html>`;
}

/* ─────────────────────────── build ─────────────────────────── */

function build(spec) {
  const groups = spec.groups || [];
  const allNodes = [];
  const collect = (ns, parent) => ns.forEach((n) => { n.parent = parent; allNodes.push(n); collect(n.children || [], n.id); });
  collect(spec.nodes, null);

  const levels = {};
  const rootNodes = spec.nodes;
  const rootIds = new Set(rootNodes.map((n) => n.id));
  const rootEdges = (spec.edges || []).filter((e) => rootIds.has(e.from) && rootIds.has(e.to));
  levels.root = levelSVG('root', rootNodes, rootEdges, groups);

  for (const p of spec.nodes) {
    const kids = p.children || [];
    if (!kids.length) continue;
    const ids = new Set(kids.map((n) => n.id));
    const inner = (spec.edges || []).filter((e) => ids.has(e.from) && ids.has(e.to));
    levels[p.id] = levelSVG(p.id, kids, inner, groups);
  }

  // legend sections per level
  const sectionsFor = (nodes) => {
    const declared = spec.sections || [];
    const out = [];
    const used = new Set();
    for (const s of declared) {
      const list = nodes.filter((n) => n.section === s.id).map((n) => n.id);
      const withKids = [];
      for (const n of nodes.filter((x) => x.section === s.id)) {
        withKids.push(n.id);
        for (const k of n.children || []) withKids.push(k.id);
      }
      if (withKids.length) { out.push({ title: s.title, nodes: withKids }); withKids.forEach((i) => used.add(i)); }
      void list;
    }
    const rest = [];
    for (const n of nodes) {
      if (used.has(n.id)) continue;
      rest.push(n.id);
      for (const k of n.children || []) rest.push(k.id);
    }
    if (rest.length) out.push({ title: declared.length ? 'Elsewhere' : 'The system', nodes: rest });
    return out;
  };
  levels.root.sections = sectionsFor(rootNodes);
  levels.root.order = levels.root.sections.flatMap((s) => s.nodes);
  for (const p of spec.nodes) {
    if (!levels[p.id]) continue;
    levels[p.id].sections = [{ title: `inside ${p.name}`, nodes: (p.children || []).map((n) => n.id) }];
    levels[p.id].order = levels[p.id].sections[0].nodes;
  }

  const gname = new Map(groups.map((g) => [g.id, g.name]));
  const edgesById = {};
  for (const e of spec.edges || []) edgesById[e.id] = { from: e.from, to: e.to, kind: e.kind, label: e.label || '' };

  const index = {};
  for (const n of allNodes) {
    const links = (spec.edges || [])
      .filter((e) => e.from === n.id || e.to === n.id)
      .map((e) => {
        const otherId = e.from === n.id ? e.to : e.from;
        const other = allNodes.find((x) => x.id === otherId);
        return { dir: e.from === n.id ? '→' : '←', other: other ? `${other.code} ${other.name}` : otherId, kind: e.kind, label: e.label || '' };
      });
    const edgeCites = (spec.edges || [])
      .filter((e) => e.from === n.id || e.to === n.id)
      .flatMap((e) => (e.cites || []).map((c) => ({ ...c, note: c.note || `${e.from} → ${e.to} (${e.kind})` })));
    index[n.id] = {
      id: n.id, code: n.code, name: n.name, shape: n.shape,
      does: n.does, built: n.built, condition: n.condition || '',
      cites: n.cites || [], edgeCites, links,
      kids: (n.children || []).length, parent: n.parent || null,
      groupName: n.group ? gname.get(n.group) || '' : '',
    };
  }
  return { levels, index, edgesById };
}

/* ─────────────────────────── cli ─────────────────────────── */

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const specPath = arg('--spec');
const outPath = arg('--out', 'system-map.html');
const root = path.resolve(arg('--root', process.cwd()));
const only = args.includes('--validate-only');

if (!specPath) {
  console.error('usage: node render.mjs --spec system.json --out map.html [--root <repo>] [--validate-only]');
  process.exit(2);
}

const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const { errs, warns } = validate(spec, root);
for (const w of warns) console.warn(`warn  ${w}`);
for (const e of errs) console.error(`ERROR ${e}`);
if (errs.length) { console.error(`\n${errs.length} error(s) — nothing rendered.`); process.exit(1); }

if (only) {
  console.log(`ok    ${spec.nodes.length} root buildings, ${(spec.edges || []).length} edges, ${warns.length} warning(s)`);
  process.exit(0);
}

if (args.includes('--debug-cells')) {
  const groups = spec.groups || [];
  const ids = new Set(spec.nodes.map((n) => n.id));
  const es = (spec.edges || []).filter((e) => ids.has(e.from) && ids.has(e.to));
  layout(spec.nodes, es, groups);
  for (const n of spec.nodes) {
    console.log(`${n.code.padEnd(3)} r${n.rank} ${n.group || '-'} x[${n.gx.toFixed(2)}..${(n.gx + n._mass.w).toFixed(2)}] y[${n.gy.toFixed(2)}..${(n.gy + n._mass.d).toFixed(2)}]`);
  }
  let clashes = 0;
  for (let i = 0; i < spec.nodes.length; i++) for (let j = i + 1; j < spec.nodes.length; j++) {
    const a = spec.nodes[i], b = spec.nodes[j];
    const ox = Math.min(a.gx + a._mass.w, b.gx + b._mass.w) - Math.max(a.gx, b.gx);
    const oy = Math.min(a.gy + a._mass.d, b.gy + b._mass.d) - Math.max(a.gy, b.gy);
    if (ox > 0 && oy > 0) { console.log(`CLASH ${a.code} x ${b.code}  (${ox.toFixed(2)} x ${oy.toFixed(2)})`); clashes++; }
  }
  console.log(clashes ? `${clashes} footprint clash(es)` : 'no footprint clashes');
  process.exit(0);
}

const { levels, index, edgesById } = build(spec);
fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
fs.writeFileSync(outPath, html(spec, levels, index, edgesById));
const kb = (fs.statSync(outPath).size / 1024).toFixed(0);
console.log(`ok    ${outPath} — ${Object.keys(levels).length} level(s), ${Object.keys(index).length} buildings, ${kb} KB`);
