#!/usr/bin/env node
// Render the map in several states and screenshot each, so the map can actually
// be looked at before anyone claims it is finished.
//
//   node shots.mjs --html map.html [--out /tmp/shots] [--width 1440] [--height 820]
//
// Needs a Chrome/Chromium/Brave binary; set CHROME to override discovery.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const htmlPath = path.resolve(arg('--html', 'system-map.html'));
const outDir = path.resolve(arg('--out', '/tmp/isometric-system-map-shots'));
const W = arg('--width', '1440'), H = arg('--height', '820');

const CANDIDATES = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);
const chrome = CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
if (!chrome) {
  console.error('no Chrome/Chromium found — set CHROME=/path/to/binary, or open the HTML by hand and look at it');
  process.exit(3);
}

const html = fs.readFileSync(htmlPath, 'utf8');
const data = JSON.parse(html.match(/window\.__MAP__=(\{.*?\});<\/script>/s)?.[1] ?? '{}');
const rootOrder = data.levels?.root?.order ?? [];
const firstDeep = rootOrder.find((id) => data.levels?.[id]) ?? null;
const spine = rootOrder[Math.min(2, rootOrder.length - 1)] ?? null;
const flowId = data.flows?.[0]?.id ?? null;

const states = [
  ['1-overview', ''],
  ...(spine ? [['2-selected', `select(${JSON.stringify(spine)});`]] : []),
  ...(spine ? [['3-built', `select(${JSON.stringify(spine)});tab='built';paint();`]] : []),
  ...(flowId ? [['4-flow', `flow=${JSON.stringify(flowId)};step=2;lightStep();`]] : []),
  ...(firstDeep ? [['5-inside', `enter(${JSON.stringify(firstDeep)});`]] : []),
  ['6-legend', `tab='built';paint();`],
];

fs.mkdirSync(outDir, { recursive: true });
const made = [];
for (const [name, action] of states) {
  const tmp = path.join(outDir, `_${name}.html`);
  fs.writeFileSync(tmp, action
    ? html.replace('</body>', `<script>setTimeout(()=>{${action}},80);</script></body>`)
    : html);
  const png = path.join(outDir, `${name}.png`);
  try {
    execFileSync(chrome, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
      `--window-size=${W},${H}`, `--screenshot=${png}`, '--virtual-time-budget=3000',
      `file://${tmp}`,
    ], { stdio: 'ignore', timeout: 60_000 });
    made.push(png);
  } catch {
    console.error(`could not shoot ${name}`);
  }
  fs.rmSync(tmp, { force: true });
}

console.log(made.join('\n'));
console.log(`\n${made.length} screenshot(s) in ${outDir} — look at every one before reporting the map done.`);
