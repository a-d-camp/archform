#!/usr/bin/env node
// Fit the builder's arch and heel settings to a measured inner-edge profile.
//
//   node tools/fit_profile.cjs <base-settings.json> <profile.csv> [out-settings.json]
//
// profile.csv: distance_from_heel_mm,height_mm[,source]  (height = top surface above the table)
// The base settings fix everything that is not fitted (foot size, shell length, thickness, style...).
// Fitted: archHeight, archPeak, archLength, heelCup. Prints the gap at every measured point.
const fs = require('fs');
const path = require('path');

const [basePath, profPath, outPath] = process.argv.slice(2);
if (!basePath || !profPath) { console.error('usage: node tools/fit_profile.cjs <base-settings.json> <profile.csv> [out-settings.json]'); process.exit(1); }

require(path.join(__dirname, '..', 'builder', 'src', 'geometry.js'));
const G = globalThis.OrthoGeom;
const baseFile = JSON.parse(fs.readFileSync(basePath, 'utf8'));
const base = baseFile.params || baseFile;
const pts = fs.readFileSync(profPath, 'utf8').trim().split(/\r?\n/).slice(1)
  .map(l => l.split(',')).map(([d, h]) => [Number(d), Number(h)]).filter(([d, h]) => Number.isFinite(d) && Number.isFinite(h));

const FIT = { archHeight: [10, 30, 0.5], archPeak: [32, 52, 1], archLength: [0, 30, 1], heelCup: [0, 20, 0.5] };
const model = (p, d) => G.innerEdgeTop(p, d);
const err = q => { const p = G.sanitize(Object.assign({}, base, q)); return pts.reduce((s, [d, h]) => s + (model(p, d) - h) ** 2, 0); };

// Coordinate descent on a grid, from a few starting points
let best = null;
for (const start of [{}, { archLength: 20 }, { archPeak: 44, archLength: 10, heelCup: 10 }]) {
  let q = {};
  for (const k in FIT) q[k] = start[k] ?? G.sanitize(base)[k];
  let e = err(q);
  for (let pass = 0, improved = true; improved && pass < 50; pass++) {
    improved = false;
    for (const [k, [lo, hi, step]] of Object.entries(FIT)) {
      for (let v = lo; v <= hi + 1e-9; v += step) {
        const t = Object.assign({}, q, { [k]: +v.toFixed(3) }), et = err(t);
        if (et < e - 1e-9) { q = t; e = et; improved = true; }
      }
    }
  }
  if (!best || e < best.e) best = { q, e };
}

const p = G.sanitize(Object.assign({}, base, best.q));
console.log('fitted:', Object.entries(best.q).map(([k, v]) => `${k} ${v}`).join(', '));
console.log(`rms gap ${Math.sqrt(best.e / pts.length).toFixed(2)} mm over ${pts.length} points\n`);
console.log('mm from heel   measured   builder    gap');
for (const [d, h] of pts) {
  const m = model(p, d);
  console.log(`${String(d).padStart(12)} ${h.toFixed(1).padStart(10)} ${m.toFixed(1).padStart(10)} ${(m - h >= 0 ? '+' : '') + (m - h).toFixed(1).padStart(6)}`);
}
if (outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ app: 'orthotics-builder', version: 1, params: p }, null, 2) + '\n');
  console.log(`\nwrote ${outPath} (load it in the builder with Load settings)`);
}
