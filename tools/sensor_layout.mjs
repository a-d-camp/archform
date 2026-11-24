#!/usr/bin/env node
// Sensor layout for the pressure insole, in the Archform builder's own coordinates.
//
//   node tools/sensor_layout.mjs <orthotic-settings.json> [outDir] [--foot length,forefootWidth,heelWidth]
//
// The sensor sheet follows the foot, so it needs the foot's length and widths (mm): from --foot, or
// from an older settings file that still has length, ballWidth and heelWidth, or 265,100,66.
// Coordinates (same as the builder): millimetres, X from the back of the heel toward
// the toes, +Y toward the medial (inner) side of a RIGHT foot, Z up from the base.
// Each sensor is placed by f = fraction of foot length from the heel and
// a = fraction of the way across the foot from the medial edge (0) to the lateral edge (1),
// so the layout scales with the foot measurements in the settings file.
//
// Writes:  <outDir>/sensor_layout.csv   one row per sensor, with orthotic surface height/slope
//          <outDir>/sensor_template.svg 1:1 printable template (A4 portrait)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const fi = args.indexOf('--foot');
const footArg = fi >= 0 ? args.splice(fi, 2)[1] : null;
const [settingsPath, outArg] = args;
const outDir = resolve(outArg || join(here, '..', 'hardware'));
if (!settingsPath) {
  console.error('usage: node tools/sensor_layout.mjs <orthotic-settings.json> [outDir] [--foot length,forefootWidth,heelWidth]');
  process.exit(1);
}

// ---------- Load the geometry engine from our local copy of the builder ----------
const geomPath = join(here, '..', 'builder', 'src', 'geometry.js');
const shapePath = join(here, '..', 'builder', 'src', 'shape.js');
// Expose the two internal helpers we need alongside the public API.
const src = readFileSync(geomPath, 'utf8').replace('root.OrthoGeom = {', 'root.OrthoGeom = { makeOutline, makeHeights,');
if (!src.includes('makeOutline, makeHeights,')) throw new Error(`Could not hook the geometry engine in ${geomPath}`);
const root = {};
new Function('globalThis', 'window', readFileSync(shapePath, 'utf8'))(root, root);
new Function('globalThis', 'window', src)(root, root);
const G = root.OrthoGeom;
if (!G || !G.makeOutline || !G.makeHeights) throw new Error('Could not expose makeOutline/makeHeights; the builder code changed.');

const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
const raw = settings.params || settings;
const P = G.sanitize(raw);
if (P.side !== 'right') console.warn(`Note: settings are for the ${P.side} foot; layout is drawn as a right foot (mirror Y for left).`);

let foot = footArg ? footArg.split(',').map(Number) : [raw.length, raw.ballWidth, raw.heelWidth];
if (foot.length !== 3 || !foot.every(v => Number.isFinite(v) && v > 0)) {
  if (footArg) { console.error('--foot takes three numbers in mm: length,forefootWidth,heelWidth'); process.exit(1); }
  foot = [265, 100, 66];
  console.warn('Note: no foot size given; using 265 mm long, 100 mm forefoot, 66 mm heel. Pass --foot to set it.');
}
const [L, footW, footH] = foot;
const footOl = footOutline(L, footW, footH); // sensor sheet follows the foot
const orthOl = G.makeOutline(P);             // the orthotic as designed
const orthH = G.makeHeights(P, orthOl);

// A full-length foot outline from its length and widths, the way the builder drew one before it
// worked from a fixed shape. Returns inner (m) and outer (l) offsets from the foot axis at x.
function footOutline(L, W, H) {
  H = Math.min(H, W * 0.95, L * 0.36);
  const rh = Math.min(H / 2, 0.2 * L);
  const mi = interp([rh, 0.25 * L, 0.45 * L, 0.72 * L, 0.86 * L, L],
    [0.5 * H, 0.5 * H, 0.5 * (0.5 * H + 0.45 * W) - 0.025 * W, 0.45 * W, 0.42 * W, 0.34 * W]);
  const li = interp([rh, 0.30 * L, 0.47 * L, 0.66 * L, 0.84 * L, L],
    [0.5 * H, 0.56 * H, 0.5 * (0.56 * H + 0.55 * W) + 0.01 * W, 0.55 * W, 0.44 * W, 0.30 * W]);
  const heel = x => 0.5 * H * Math.sqrt(Math.max(0, 1 - (1 - x / rh) ** 2));
  const capStart = 0.84 * L, yc = 0.18 * W;   // toe shape, big toe longest
  const edges = x => {
    let m = x < rh ? heel(x) : mi(x), l = x < rh ? heel(x) : li(x);
    if (x > capStart) {
      const s = Math.min(1, Math.max(0, (x - capStart) / (L - capStart)));
      m = yc + (m - yc) * Math.sqrt(Math.max(0, 1 - s ** 2.6));
      l = -yc + (l + yc) * Math.sqrt(Math.max(0, 1 - s ** 1.5));
    }
    return [m, l];
  };
  return { edges, xe: L };
}
// Monotone cubic Hermite interpolation (Fritsch–Carlson): smooth, no overshoot.
function interp(xs, ys) {
  const n = xs.length, d = [], m = [];
  for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return x => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

// ---------- Sensor definitions ----------
// mux A = low-pressure channels (arch, lateral midfoot), larger reference resistor
// mux B = high-pressure channels (heel, forefoot, toes), smaller reference resistor
const SENSORS = [
  // id,    region,              f,    a,    mux
  ['H1',  'heel medial',         0.13, 0.25, 'B'],
  ['H2',  'heel centre',         0.09, 0.50, 'B'],
  ['H3',  'heel lateral',        0.13, 0.75, 'B'],
  ...[0.33, 0.40, 0.47, 0.54].flatMap((f, r) =>
    [0.10, 0.28, 0.46].map((a, c) => [`A${r + 1}${c + 1}`, `medial arch r${r + 1} c${c + 1}`, f, a, 'A'])),
  ['L1',  'lateral midfoot',     0.38, 0.85, 'A'],
  ['L2',  'lateral midfoot (5th met base)', 0.55, 0.86, 'A'],
  ['M1',  'met head 1',          0.72, 0.15, 'B'],
  ['M2',  'met head 2',          0.73, 0.34, 'B'],
  ['M3',  'met head 3',          0.71, 0.51, 'B'],
  ['M4',  'met head 4',          0.68, 0.67, 'B'],
  ['M5',  'met head 5',          0.65, 0.83, 'B'],
  ['T1',  'hallux',              0.90, 0.22, 'B'],
  ['T2',  'lesser toes',         0.86, 0.58, 'B'],
];
const PAD_D = 10; // mm, Velostat dot / electrode diameter

const chan = { A: 0, B: 0 };
const yAt = (ol, x, a) => { const [mm, l] = ol.edges(x); return mm - a * (mm + l); };
const insideOrth = (x, y) => {
  if (x < 0 || x > orthOl.xe) return false;
  const [mm, l] = orthOl.edges(x);
  return y <= mm && y >= -l;
};
// distance from (x,y) to the orthotic outline, sampled
const orthLoop = [];
for (let i = 0; i <= 400; i++) { const x = orthOl.xe * i / 400; const [mm, l] = orthOl.edges(x); orthLoop.push([x, mm]); orthLoop.unshift([x, -l]); }
const distToOrthEdge = (x, y) => Math.min(...orthLoop.map(([px, py]) => Math.hypot(px - x, py - y)));
const topZ = (x, y) => {
  if (!insideOrth(x, y)) return null;
  const [mm, l] = orthOl.edges(x);
  const d = Math.min(mm - y, y + l, x);
  return orthH(x, y, mm, l, d)[0];
};

const rows = SENSORS.map(([id, region, f, a, mux]) => {
  const x = f * L, y = yAt(footOl, x, a);
  const z = topZ(x, y);
  let slope = null;
  if (z != null) {
    const h = 2, zx1 = topZ(x + h, y), zx0 = topZ(x - h, y), zy1 = topZ(x, y + h), zy0 = topZ(x, y - h);
    if ([zx1, zx0, zy1, zy0].every(v => v != null)) {
      const gx = (zx1 - zx0) / (2 * h), gy = (zy1 - zy0) / (2 * h);
      slope = Math.atan(Math.hypot(gx, gy)) * 180 / Math.PI;
    }
  }
  const onOrth = z != null;
  const edge = distToOrthEdge(x, y);
  const notes = [];
  if (edge < PAD_D / 2 + 3) notes.push(`within ${edge.toFixed(1)} mm of orthotic edge`);
  if (slope != null && slope > 25) notes.push(`steep surface ${slope.toFixed(0)} deg`);
  return { id, region, mux, ch: chan[mux]++, f, a, x, y, onOrth, z, slope, edge, notes };
});

// spacing check
let minGap = Infinity, minPair = '';
for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
  const d = Math.hypot(rows[i].x - rows[j].x, rows[i].y - rows[j].y) - PAD_D;
  if (d < minGap) { minGap = d; minPair = `${rows[i].id}-${rows[j].id}`; }
}

// ---------- CSV ----------
mkdirSync(outDir, { recursive: true });
const csv = ['id,region,mux,channel,pct_length,across_from_medial,x_mm,y_mm,on_orthotic,orthotic_top_z_mm,surface_slope_deg,dist_to_orthotic_edge_mm,notes'];
for (const r of rows) csv.push([r.id, `"${r.region}"`, r.mux, r.ch, (r.f * 100).toFixed(0), r.a.toFixed(2), r.x.toFixed(1), r.y.toFixed(1),
  r.onOrth ? 'yes' : 'no', r.z == null ? '' : r.z.toFixed(1), r.slope == null ? '' : r.slope.toFixed(0), r.edge.toFixed(1), `"${r.notes.join('; ')}"`].join(','));
writeFileSync(join(outDir, 'sensor_layout.csv'), csv.join('\n') + '\n');

// ---------- SVG template (A4 portrait, 1:1, toes up, medial side on the left like looking down at a right foot) ----------
const PW = 210, PH = 297, ox = PW / 2, oy = PH - 4; // heel at the bottom, toes clear of the header
const sx = y => ox - y + 0, sy = x => oy - x;    // +Y medial -> left on the page
const path = ol => {
  const pts = [];
  for (let i = 0; i <= 300; i++) { const x = ol.xe * i / 300; pts.push([x, ol.edges(x)[0]]); }
  for (let i = 300; i >= 0; i--) { const x = ol.xe * i / 300; pts.push([x, -ol.edges(x)[1]]); }
  return 'M' + pts.map(([x, y]) => `${sx(y).toFixed(2)},${sy(x).toFixed(2)}`).join(' L') + ' Z';
};
const pctLines = [30, 40, 50, 60, 70, 80].map(p => {
  const x = p / 100 * L, [mm, l] = footOl.edges(x);
  return `<line x1="${sx(mm + 4)}" y1="${sy(x)}" x2="${sx(-l - 4)}" y2="${sy(x)}" class="grid"/><text x="${sx(-l - 5)}" y="${sy(x) + 1}" class="small">${p}%</text>`;
}).join('\n');
const pads = rows.map(r => `<g><circle cx="${sx(r.y).toFixed(2)}" cy="${sy(r.x).toFixed(2)}" r="${PAD_D / 2}" class="pad ${r.mux}"/>` +
  `<text x="${sx(r.y).toFixed(2)}" y="${(sy(r.x) + 1.2).toFixed(2)}" class="lbl">${r.id}</text></g>`).join('\n');
const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${PW}mm" height="${PH}mm" viewBox="0 0 ${PW} ${PH}">
<style>
  .foot{fill:none;stroke:#000;stroke-width:0.4}
  .orth{fill:none;stroke:#555;stroke-width:0.3;stroke-dasharray:2 1.5}
  .grid{stroke:#bbb;stroke-width:0.15}
  .pad{stroke:#000;stroke-width:0.25}
  .pad.A{fill:#cfe3ff}.pad.B{fill:#ffd9c2}
  .lbl{font:2.6px sans-serif;text-anchor:middle}
  .small{font:2.4px sans-serif}
  .title{font:3.6px sans-serif;font-weight:bold}
</style>
<rect width="${PW}" height="${PH}" fill="#fff"/>
<text x="8" y="8" class="title">Pressure insole sensor template: RIGHT foot, ${L} mm x ${footW} mm ball, heel ${footH} mm</text>
<text x="8" y="12" class="small">Print at 100% (no fit-to-page) and check the 50 mm bar. Solid = foot outline (sensor sheet). Dashed = orthotic outline.</text>
<text x="8" y="15" class="small">Blue = mux A (low range), orange = mux B (high range). Pads ${PAD_D} mm. Medial (inner) side is on the LEFT.</text>
<text x="8" y="18" class="small">Lines show % of foot length from the heel, as in the builder.</text>
<line x1="8" y1="${PH - 6}" x2="58" y2="${PH - 6}" stroke="#000" stroke-width="0.6"/><text x="8" y="${PH - 8}" class="small">50 mm</text>
${pctLines}
<path d="${path(footOl)}" class="foot"/>
<path d="${path(orthOl)}" class="orth"/>
${pads}
</svg>
`;
writeFileSync(join(outDir, 'sensor_template.svg'), svg);

// ---------- Report ----------
console.log(`Foot ${L} mm, orthotic ends at ${orthOl.xe.toFixed(1)} mm; ${rows.length} sensors (A: ${chan.A}, B: ${chan.B}).`);
console.log(`Closest pads: ${minPair}, edge-to-edge gap ${minGap.toFixed(1)} mm.`);
for (const r of rows) console.log(`${r.id.padEnd(4)} ${r.mux}${String(r.ch).padStart(2)}  x=${r.x.toFixed(0).padStart(3)} y=${r.y.toFixed(0).padStart(4)}  ${r.onOrth ? `z=${r.z.toFixed(1).padStart(4)} slope=${r.slope == null ? '  ?' : r.slope.toFixed(0).padStart(3)}` : 'off orthotic      '}  ${r.notes.join('; ')}`);
console.log(`Wrote ${join(outDir, 'sensor_layout.csv')} and sensor_template.svg`);
