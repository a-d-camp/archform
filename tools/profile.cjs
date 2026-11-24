#!/usr/bin/env node
// Print cross-sections of an orthotic: top-surface height (mm) across the foot at a few points
// along its length, from the inner (medial) edge to the outer (lateral) edge.
//
//   node tools/profile.cjs <orthotic-settings.json> ['{"archFill":100}'] [--geometry path/to/geometry.js]
//
// The optional JSON overrides settings, to try a change before making it in the builder.
// --geometry compares another version of the engine (e.g. one saved with `git show`).
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const gi = args.indexOf('--geometry');
const geomPath = gi >= 0 ? args.splice(gi, 2)[1] : path.join(__dirname, '..', 'builder', 'src', 'geometry.js');
const [settingsPath, overrides] = args;
if (!settingsPath) { console.error('usage: node tools/profile.cjs <orthotic-settings.json> [overrides-json] [--geometry file]'); process.exit(1); }

const src = fs.readFileSync(geomPath, 'utf8').replace('root.OrthoGeom = {', 'root.OrthoGeom = { makeOutline, makeHeights,');
const root = {}; new Function('globalThis', 'window', src)(root, root);
const G = root.OrthoGeom;
const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
const p = G.sanitize(Object.assign({}, saved.params || saved, JSON.parse(overrides || '{}')));
const ol = G.makeOutline(p), hf = G.makeHeights(p, ol);

// distance to the outline, as build() computes it for the heel cup
const loop = [];
for (let i = 0; i <= 600; i++) { const x = ol.xe * i / 600; const [m, l] = ol.edges(x); loop.push([x, m], [x, -l]); }
const dist = (x, y) => Math.min(...loop.map(([a, b]) => Math.hypot(a - x, b - y)));

function row(f, label) {
  const x = f * p.length; if (x > ol.xe) return;
  const [m, l] = ol.edges(x), out = [];
  for (let i = 0; i <= 10; i++) { const y = m - (i / 10) * (m + l); out.push(hf(x, y, m, l, dist(x, y))[0].toFixed(1).padStart(5)); }
  console.log(`${label.padEnd(14)} ${out.join(' ')}`);
}
console.log(`${'section'.padEnd(14)} inner edge .............................. outer edge   (top surface, mm)`);
row(0.06, 'heel 6%'); row(0.10, 'heel 10%'); row(0.15, 'heel 15%');
row(p.archPeak / 100, `arch peak ${p.archPeak}%`); row(0.50, 'arch 50%'); row(0.60, 'midfoot 60%');
