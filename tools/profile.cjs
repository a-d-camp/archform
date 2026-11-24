#!/usr/bin/env node
// Print cross-sections of an orthotic: top-surface height (mm) across the foot at a few points
// along its length, from the inner (medial) edge to the outer (lateral) edge.
//
//   node tools/profile.cjs <orthotic-settings.json> ['{"archAdjHeight":2}'] [--geometry path/to/geometry.js]
//
// The optional JSON overrides settings, to try a change before making it in the builder.
// --geometry compares another version of the engine (e.g. one saved with `git show`); it reads the
// shape.js next to it, if there is one, or the builder's own.
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const gi = args.indexOf('--geometry');
const geomPath = gi >= 0 ? args.splice(gi, 2)[1] : path.join(__dirname, '..', 'builder', 'src', 'geometry.js');
const [settingsPath, overrides] = args;
if (!settingsPath) { console.error('usage: node tools/profile.cjs <orthotic-settings.json> [overrides-json] [--geometry file]'); process.exit(1); }

const src = fs.readFileSync(geomPath, 'utf8').replace('root.OrthoGeom = {', 'root.OrthoGeom = { makeOutline, makeHeights,');
const shapePath = [path.join(path.dirname(geomPath), 'shape.js'), path.join(__dirname, '..', 'builder', 'src', 'shape.js')].find(f => fs.existsSync(f));
const root = {};
new Function('globalThis', 'window', fs.readFileSync(shapePath, 'utf8'))(root, root);
new Function('globalThis', 'window', src)(root, root);
const G = root.OrthoGeom;
const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
const p = G.sanitize(Object.assign({}, saved.params || saved, JSON.parse(overrides || '{}')));
const ol = G.makeOutline(p), hf = G.makeHeights(p, ol);

// distance to the outline, as build() computes it for the heel cup
const loop = [];
for (let i = 0; i <= 600; i++) { const x = ol.xe * i / 600; const [m, l] = ol.edges(x); loop.push([x, m], [x, -l]); }
const dist = (x, y) => Math.min(...loop.map(([a, b]) => Math.hypot(a - x, b - y)));

function row(x, label) {
  if (x < 0 || x > ol.xe) return;
  const [m, l] = ol.edges(x), out = [];
  for (let i = 0; i <= 10; i++) { const y = m - (i / 10) * (m + l); out.push(hf(x, y, m, l, dist(x, y))[0].toFixed(1).padStart(5)); }
  console.log(`${label.padEnd(16)} ${out.join(' ')}`);
}
const at = f => Math.round(f * ol.xe), pk = G.archPeak(p);
console.log(`${'mm from heel'.padEnd(16)} inner edge .............................. outer edge   (top surface, mm)`);
for (const f of [0.06, 0.10, 0.15]) row(at(f), `heel ${at(f)}`);
row(pk.x, `arch peak ${pk.x.toFixed(0)}`);
for (const f of [0.75, 0.90]) row(at(f), `fore ${at(f)}`);
