// Mesh checks for src/geometry.js. Run with: node tests/check_mesh.js
// Every case must give a closed, consistently wound (watertight) mesh with positive volume.
require('../src/bases.js');
require('../src/geometry.js');
const G = globalThis.OrthoGeom;

function check(params, side) {
  const m = G.build(params, { side });
  const { pos, tri, nSurf } = m;
  for (let i = 0; i < pos.length; i++) if (!Number.isFinite(pos[i])) return 'non-finite vertex';
  const edges = new Map();
  for (let t = 0; t < tri.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = tri[t + e], b = tri[t + (e + 1) % 3];
      if (a === b) return 'degenerate triangle';
      const k = a + ',' + b;
      edges.set(k, (edges.get(k) || 0) + 1);
    }
  }
  for (const [k, c] of edges) {
    const [a, b] = k.split(',');
    if (c !== 1 || edges.get(b + ',' + a) !== 1) return 'not watertight at edge ' + k;
  }
  for (let k = 0; k < nSurf; k++) {
    if (pos[k * 3 + 2] - pos[(nSurf + k) * 3 + 2] < 0.99) return 'thinner than 1 mm at vertex ' + k;
  }
  for (let k = 2; k < pos.length; k += 3) if (pos[k] < -1e-6) return 'below the build plate';
  // The top surface is a height field, so seen from above every top triangle keeps its winding:
  // a flipped one means the grid folded over (for example around the heel opening).
  for (let t = 0; t < m.counts.top * 3; t += 3) {
    const a = tri[t] * 3, b = tri[t + 1] * 3, c = tri[t + 2] * 3;
    const area = (pos[b] - pos[a]) * (pos[c + 1] - pos[a + 1]) - (pos[c] - pos[a]) * (pos[b + 1] - pos[a + 1]);
    if (area < -1e-9) return 'top surface folds over at triangle ' + t / 3;
  }
  if (params.heelHole > 0 && G.warnings(params).every(s => !/no room for a heel opening/.test(s)) && m.counts.wall <= 2 * m.outline.length) return 'heel opening missing';
  if (!(m.stats.volume > 0)) return 'non-positive volume';
  const p = G.sanitize(params);
  const expected = G.coverageEnd(p) * p.length;
  if (Math.abs(m.stats.length - expected) > 0.01) return 'length mismatch';
  return null;
}

const cases = [
  {},
  { coverage: 'full' },
  { coverage: 'sulcus' },
  { style: 'shell' },
  { coverage: 'full', style: 'shell', metPad: 5, rearPost: 4, forePost: -3, heelLift: 6 },
  { length: 150, ballWidth: 55, heelWidth: 35, archHeight: 30, heelCup: 25 },
  { length: 340, ballWidth: 135, heelWidth: 95, archHeight: 0, heelCup: 0, lateralArch: 0, style: 'shell' },
  { rearPost: -8, forePost: 8, archPeak: 52, archSpread: 90, metPad: 8, metPadPos: 68 },
  { archHeight: 30, archSpread: 100, archFill: 80, lateralArch: 8, style: 'shell' },
  { heelCup: 25, heelCupReach: 100, archHeight: 30, archSpread: 100, archFill: 80 },
  { archHeight: 30, archSpread: 100, archFill: 100, lateralArch: 8, style: 'shell', coverage: 'full' },
  { archHeight: 30, archSpread: 35, archFill: 100, heelCup: 25, heelCupReach: 100 },
  { heelHole: 30, heelCup: 10, heelCupReach: 100 },
  { archLength: 30, archHeight: 30, archPeak: 32, coverage: 'full', style: 'shell' },
  { shellLength: 172, length: 271, style: 'shell', shellThick: 2.5, archHeight: 30, archLength: 20, heelCup: 12, heelCupReach: 100 },
  { shellLength: 400, coverage: 'sulcus' },
  { shellLength: 172, shellWidth: 76, length: 271, ballWidth: 100, heelWidth: 65, style: 'shell', shellThick: 2.5, archHeight: 22, archLength: 19, heelHole: 43, heelCup: 13, heelCupReach: 100 },
  { shellWidth: 40, coverage: 'sulcus', heelHole: 45, heelCup: 20, heelCupReach: 100 },
  { shellWidth: 135, coverage: '3q' },
  { shellLength: 184, shellWidth: 76, shellSlant: 27, heelWidth: 63, heelHole: 43, heelHolePos: 44, heelCup: 14, heelCupReach: 100, style: 'shell', shellThick: 2.5, archHeight: 22, archLength: 19 },
  { shellSlant: 60, coverage: 'sulcus', metPad: 6, forePost: 4 },
  { shellSlant: 60, shellLength: 80, length: 150, ballWidth: 55, heelWidth: 35, heelHole: 45, heelHolePos: 120 },
  { heelHole: 30, heelHolePos: 120, coverage: '3q' },
  { style: 'thin' },
  { base: 'high-arch', style: 'thin', shellThick: 2.5 },
  { base: 'high-arch', style: 'thin', archAdjHeight: 8, archAdjShift: 25, archAdjLength: 30, archAdjReach: 100, outerAdj: 8, heelAdj: 8 },
  { base: 'high-arch', style: 'thin', archAdjHeight: -8, archAdjShift: -25, archAdjLength: -30, archAdjReach: 20, outerAdj: -5, heelAdj: -8 },
  { base: 'high-arch', style: 'solid', archAdjHeight: 4 },
  { base: 'high-arch', style: 'shell', heelAdj: 5 },
  { base: 'no-such-base' },
  { archRound: 100, archHeight: 30, archSpread: 100, style: 'thin' },
  { archRound: 100, archSpread: 35, archFill: 100, archHeight: 30, style: 'shell' },
  { archRound: 50, archFill: 60, archSpread: 90, archHeight: 25 },
  { style: 'thin', coverage: 'full', heelCup: 25, heelCupReach: 100, archHeight: 30, archSpread: 100, archFill: 100, metPad: 6, rearPost: 5, heelLift: 6 },
  { style: 'thin', shellLength: 184, shellWidth: 76, shellSlant: 27, heelWidth: 63, heelHole: 43, heelHolePos: 44, heelCup: 13.5, shellThick: 2.5, archHeight: 22, archPeak: 44, archLength: 19 },
  { style: 'thin', length: 150, ballWidth: 55, heelWidth: 35, heelCup: 25, shellThick: 1.5, foreThick: 1 },
  { shellLength: 60, length: 271, archPeak: 52, archLength: 30 },
  { archLength: 30, archHeight: 30, archPeak: 52, archSpread: 100, archFill: 100, heelHole: 30 },
  { heelHole: 45, heelCup: 25, heelCupReach: 100, style: 'shell', heelLift: 6, rearPost: 5, coverage: 'full' },
  { heelHole: 45, length: 150, ballWidth: 55, heelWidth: 35, heelCup: 2 },
  { heelHole: 20, length: 340, ballWidth: 135, heelWidth: 95, rearPost: -8, archSpread: 100, archFill: 100 },
  { length: 150, ballWidth: 55, heelWidth: 35, heelCup: 2, heelCupReach: 100, coverage: 'full' },
  { length: 'oops', ballWidth: -5, coverage: 'nope', style: 42 }
];

let failed = 0;
for (const c of cases) {
  for (const side of ['right', 'left']) {
    const err = check(c, side);
    if (err) { failed++; console.error(`FAIL ${side} ${JSON.stringify(c)}: ${err}`); }
  }
}
const stl = G.toSTL([G.build({})]);
const n = new DataView(stl).getUint32(80, true);
if (stl.byteLength !== 84 + 50 * n) { failed++; console.error('FAIL STL size'); }

if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log(`all ${cases.length * 2} mesh cases and the STL writer passed`);

// Round trip: measure a design the way a person would measure a real orthotic,
// convert the measurements back into settings, and expect the same settings.
const designs = [
  {},
  { coverage: 'full', archHeight: 12, heelCup: 15, metPad: 4, metPadPos: 62, foreThick: 2.5 },
  { coverage: 'sulcus', style: 'shell', archHeight: 20, archPeak: 45, rearPost: 4, shellThick: 3.5 },
  { length: 240, ballWidth: 92, heelWidth: 60, heelLift: 5, rearPost: -3, forePost: 3, coverage: 'full' }
];
const keys = ['length', 'ballWidth', 'heelWidth', 'shellThick', 'heelLift', 'heelCup', 'archHeight', 'archPeak', 'metPad', 'metPadPos', 'rearPost', 'forePost'];
let rtFailed = 0;
for (const d of designs) {
  const P = G.sanitize(d), m = G.measureDesign(P), rad = a => (a * Math.PI) / 180;
  const meas = {
    coverage: P.coverage, style: P.style, length: m.length, maxWidth: m.maxWidth, heelWidth: P.heelWidth,
    heelSeat: m.heelSeat, heelRim: m.heelRim, archTop: m.archTop, archDist: m.archDist, heelLift: P.heelLift,
    foreThick: P.coverage !== '3q' ? P.foreThick : '', padHeight: P.metPad, padDist: (P.metPadPos / 100) * P.length,
    heelWedgeInner: Math.max(0, Math.tan(rad(P.rearPost)) * 60), heelWedgeOuter: Math.max(0, -Math.tan(rad(P.rearPost)) * 60), heelWedgeWidth: 60,
    foreWedgeInner: Math.max(0, Math.tan(rad(P.forePost)) * 90), foreWedgeOuter: Math.max(0, -Math.tan(rad(P.forePost)) * 90), foreWedgeWidth: 90
  };
  const r = G.fromOrthotic(meas, G.DEFAULTS);
  const bad = r.error ? [r.error] : keys.filter(k => Math.abs(r.params[k] - P[k]) > 0.1).map(k => `${k} ${P[k]} → ${r.params[k].toFixed(2)}`);
  if (bad.length) { rtFailed++; console.error(`FAIL round trip ${JSON.stringify(d)}: ${bad.join(', ')}`); }
}
if (G.fromOrthotic({ length: '' }, G.DEFAULTS).error === undefined) { rtFailed++; console.error('FAIL missing length not reported'); }
if (rtFailed) { console.error(`${rtFailed} round-trip check(s) failed`); process.exit(1); }
console.log(`all ${designs.length} measure-and-match round trips passed`);
