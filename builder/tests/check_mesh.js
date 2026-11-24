// Mesh checks for src/geometry.js. Run with: node tests/check_mesh.js
// Every case must give a closed, consistently wound (watertight) mesh with positive volume.
require('../src/shape.js');
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
  if (m.counts.wall <= 2 * m.outline.length) return 'heel opening missing';
  if (!(m.stats.volume > 0)) return 'non-positive volume';
  if (Math.abs(m.stats.length - globalThis.OrthoShape.length) > 0.01) return 'length mismatch';
  return null;
}

const cases = [
  {},
  { style: 'solid' },
  { shellThick: 1.5 },
  { shellThick: 8, style: 'solid' },
  { archAdjHeight: 8, archAdjShift: 25, archAdjLength: 30, archAdjReach: 100, outerAdj: 8, heelAdj: 8 },
  { archAdjHeight: -8, archAdjShift: -25, archAdjLength: -30, archAdjReach: 20, outerAdj: -5, heelAdj: -8 },
  { archAdjHeight: 4, style: 'solid' },
  { heelAdj: 5, shellThick: 4 },
  { archAdjHeight: 'oops', heelAdj: -50, style: 42, material: 'wood' },
  { base: 'none', length: 265, coverage: 'full', archHeight: 15 }   // settings saved by an older version
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

// Settings that are not part of this version are dropped, and the defaults match the shape.
const s = G.sanitize({ base: 'none', length: 265, style: 'shell' });
if ('base' in s || 'length' in s || s.style !== 'thin') { console.error('FAIL sanitize keeps old settings'); process.exit(1); }
if (G.DEFAULTS.shellThick !== globalThis.OrthoShape.thickness) { console.error('FAIL default thickness'); process.exit(1); }
