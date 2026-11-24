/*
 * Orthotic geometry engine.
 * Pure JavaScript, no dependencies. Builds a closed, printable triangle mesh of the default shape
 * (src/shape.js, exported from the Python tool) with the adjustments below applied
 * (millimetres, Z up, X from heel to toe, +Y = medial side of a RIGHT foot).
 */
(function (root) {
  'use strict';

  function shape() {
    const S = root.OrthoShape;
    if (!S) throw new Error('No shape loaded: load src/shape.js before src/geometry.js');
    return S;
  }

  const DEFAULTS = {
    side: 'right',        // right | left | pair (pair is a view/export option)
    archAdjHeight: 0,     // raise (+) or lower (-) the arch, mm at the inner edge under the peak
    archAdjShift: 0,      // move the arch toward the toes (+) or the heel (-), mm
    archAdjLength: 0,     // stretch (+) or shorten (-) the arch along the foot, %
    archAdjReach: 60,     // how far across from the inner edge an arch height change carries, %
    outerAdj: 0,          // raise (+) or lower (-) the outer side under the arch, mm
    heelAdj: 0,           // deepen (+) or flatten (-) the heel cup walls, mm
    style: 'thin',        // thin (constant thickness, rounded underneath) | solid (flat base)
    shellThick: root.OrthoShape ? root.OrthoShape.thickness : 2.5, // shell thickness (mm)
    material: 'tpu'
  };

  const LIMITS = {
    archAdjHeight: [-8, 8], archAdjShift: [-25, 25], archAdjLength: [-30, 30], archAdjReach: [20, 100],
    outerAdj: [-5, 8], heelAdj: [-8, 8],
    shellThick: [1.5, 8]
  };

  // Thin shell: on very steep walls, thicken the vertical offset by at most this factor (about 70 degrees)
  const THIN_MAX_SLANT = 3;
  const DENSITY = { tpu: 1.21, petg: 1.27, pla: 1.24 }; // g/cm^3

  const N_ROWS = 150;   // along the length
  const N_COLS = 56;    // across the width

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  function smooth(e0, e1, x) {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  }

  // Only the settings above are kept, each inside its limits; anything else in the input is dropped.
  function sanitize(input) {
    const src = input || {}, p = {};
    for (const k in DEFAULTS) p[k] = src[k] !== undefined ? src[k] : DEFAULTS[k];
    for (const k in LIMITS) {
      const v = Number(p[k]);
      p[k] = Number.isFinite(v) ? clamp(v, LIMITS[k][0], LIMITS[k][1]) : DEFAULTS[k];
    }
    if (p.side !== 'left' && p.side !== 'pair') p.side = 'right';
    if (p.style !== 'solid') p.style = 'thin';
    if (!DENSITY[p.material]) p.material = DEFAULTS.material;
    return p;
  }

  /* ---------- The shape (fitted with the Python tool, see src/shape.js) ---------- */
  // An outline table and a bicubic B-spline over (s along the shell 0..1, v across 0 = inner edge ..
  // 1 = outer edge). The adjustments reshape it smoothly; at zero they give the shape exactly.
  const ARCH_CORE = 0.18, ARCH_FADE = 0.16, CUP_R = 15;
  function bspan(t, n, u) {            // knot span for clamped cubic with n control points
    if (u >= t[n]) return n - 1;
    let lo = 3, hi = n;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (u < t[mid]) hi = mid; else lo = mid; }
    return lo;
  }
  function bbasis(t, i, u) {           // the 4 non-zero cubic basis values at u in span i
    const N = [1, 0, 0, 0], left = [0, 0, 0, 0], right = [0, 0, 0, 0];
    for (let j = 1; j <= 3; j++) {
      left[j] = u - t[i + 1 - j]; right[j] = t[i + j] - u;
      let saved = 0;
      for (let r = 0; r < j; r++) {
        const den = right[r + 1] + left[j - r], tmp = den !== 0 ? N[r] / den : 0;
        N[r] = saved + right[r + 1] * tmp; saved = left[j - r] * tmp;
      }
      N[j] = saved;
    }
    return N;
  }
  function spline(B) {
    if (B._eval) return B._eval;
    const { ts, tv, C } = B.spline, ns = C.length, nv = C[0].length;
    return (B._eval = (s, v) => {
      s = clamp(s, 0, 1); v = clamp(v, 0, 1);
      const is = bspan(ts, ns, s), iv = bspan(tv, nv, v), Ns = bbasis(ts, is, s), Nv = bbasis(tv, iv, v);
      let z = 0;
      for (let a = 0; a < 4; a++) {
        const row = C[is - 3 + a];
        for (let b = 0; b < 4; b++) z += Ns[a] * Nv[b] * row[iv - 3 + b];
      }
      return z;
    });
  }
  function makeOutline() {
    const B = shape();
    const X = B.edges.x, YM = B.edges.ymax, YL = B.edges.ymin, xe = B.length;
    const at = (arr, x) => {
      x = clamp(x, 0, xe);
      let lo = 0, hi = X.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (X[mid] <= x) lo = mid; else hi = mid; }
      const f = X[hi] > X[lo] ? (x - X[lo]) / (X[hi] - X[lo]) : 0;
      return arr[lo] + f * (arr[hi] - arr[lo]);
    };
    const edges = x => [at(YM, x), -at(YL, x)];
    const y0 = (YM[0] + YL[0]) / 2, yTip = (YM[YM.length - 1] + YL[YL.length - 1]) / 2;
    let W = 0;
    for (const x of X) W = Math.max(W, at(YM, x) - at(YL, x));
    return { edges, xe, yc: yTip, y0, L: xe, W, H: at(YM, 0.15 * xe) - at(YL, 0.15 * xe) };
  }

  /* ---------- Height field ---------- */
  // The adjustments, in the shape's own (s, v). Returns [top, bottom, thickness] at plan point (x, y),
  // where m and l are the inner and outer edges there and d is the distance to the outline.
  function makeHeights(p, ol) {
    const B = shape(), S = spline(B), L = B.length, sp = B.arch.peak_s, t = p.shellThick;
    const k = 1 + p.archAdjLength / 100, c = clamp(sp + p.archAdjShift / L, 0.15, 0.85);
    const core = ARCH_CORE * k, fade = ARCH_FADE;
    const win = s => 1 - smooth(core, core + fade, Math.abs(s - c));
    const reach = p.archAdjReach / 100;
    return function (x, y, m, l, d) {
      const span = m + l, s = x / ol.xe, v = span > 1e-6 ? clamp((m - y) / span, 0, 1) : 0.5;
      if (d == null) d = 1e9;
      // move and stretch the arch: read the shape from where this point's arch came from
      const w = win(s);
      const s0 = s + w * (sp + (s - c) / k - s);
      let z = S(s0, v);
      const across = v < reach ? (1 - v / reach) ** 2 : 0;
      z += p.archAdjHeight * w * across;
      z += p.outerAdj * w * smooth(0.45, 1.0, v);
      if (p.heelAdj !== 0 && d < CUP_R) z += p.heelAdj * (1 - smooth(0.10, 0.30, s)) * (1 - d / CUP_R) ** 2;
      return [Math.max(t, z), 0, t];
    };
  }

  /* ---------- Heel opening ---------- */
  // rad(x, y) is 1 on the edge (below 1 inside, and it grows in proportion to the distance from the
  // centre), ang(x, y) is the angle round the centre, at(t) the edge point there. The shape gives a
  // centre and size for an oval, and optionally a Fourier series of the radius for any rounded shape.
  function heelOpening() {
    const o = shape().opening;
    if (!o) return null;
    const [xh, yh] = o.center, [w, len] = o.size, rx = len / 2, ry = w / 2, F = o.fourier;
    const ho = { xh, yh };
    if (F) {
      const R = t => { let r = F[0]; for (let k = 1; 2 * k < F.length; k++) r += F[2 * k - 1] * Math.cos(k * t) + F[2 * k] * Math.sin(k * t); return r; };
      ho.ang = (x, y) => Math.atan2(y - yh, x - xh);
      ho.rad = (x, y) => Math.hypot(x - xh, y - yh) / R(ho.ang(x, y));
      ho.at = t => [xh + R(t) * Math.cos(t), yh + R(t) * Math.sin(t)];
    } else {
      ho.ang = (x, y) => Math.atan2((y - yh) / ry, (x - xh) / rx);
      ho.rad = (x, y) => Math.hypot((x - xh) / rx, (y - yh) / ry);
      ho.at = t => [xh + rx * Math.cos(t), yh + ry * Math.sin(t)];
    }
    return ho;
  }

  function segDist(px, py, ax, ay, bx, by) {
    const vx = bx - ax, vy = by - ay, wx = px - ax, wy = py - ay;
    const c = vx * vx + vy * vy;
    let t = c > 0 ? (wx * vx + wy * vy) / c : 0;
    t = clamp(t, 0, 1);
    const dx = wx - t * vx, dy = wy - t * vy;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /* ---------- Mesh builder ---------- */
  function build(input, opts) {
    const p = sanitize(input);
    const mirror = (opts && opts.side ? opts.side : p.side) === 'left';
    const ol = makeOutline(p);
    const hf = makeHeights(p, ol);
    const N = N_ROWS, M = N_COLS, xe = ol.xe;

    // Rows (dense near both ends) and columns (dense near both edges)
    const xs = new Float64Array(N + 1), vs = new Float64Array(M + 1);
    for (let i = 0; i <= N; i++) xs[i] = xe * (1 - Math.cos((Math.PI * i) / N)) / 2;
    for (let j = 0; j <= M; j++) vs[j] = (1 - Math.cos((Math.PI * j) / M)) / 2;
    const ml = [];
    for (let i = 0; i <= N; i++) ml.push(ol.edges(xs[i]));

    // Surface sample points (x, y) — heel pole, grid rows 1..N-1, toe pole
    const nSurf = 2 + (N - 1) * (M + 1);
    const sx = new Float64Array(nSurf), sy = new Float64Array(nSurf);
    const sm = new Float64Array(nSurf), sl = new Float64Array(nSurf);
    const heelPole = 0, toePole = nSurf - 1;
    const gi = (i, j) => 1 + (i - 1) * (M + 1) + j;
    sx[heelPole] = 0; sy[heelPole] = ol.y0 || 0; sm[heelPole] = 0; sl[heelPole] = 0;
    sx[toePole] = xe; sy[toePole] = ol.yc; sm[toePole] = ol.yc; sl[toePole] = -ol.yc;
    for (let i = 1; i < N; i++) {
      const [m, l] = ml[i];
      for (let j = 0; j <= M; j++) {
        const k = gi(i, j);
        sx[k] = xs[i]; sy[k] = m - vs[j] * (m + l); sm[k] = m; sl[k] = l;
      }
    }

    // Heel opening: drop the grid cells whose centre falls inside the oval, then move the vertices
    // on the cut onto the oval itself so the edge is smooth rather than stepped along the grid.
    const ho = heelOpening();
    const cut = new Uint8Array((N - 1) * M); // cell (i, j) for rows i = 1..N-2 -> index (i - 1) * M + j
    const ci = (i, j) => (i - 1) * M + j;
    if (ho) {
      const rOf = ho.rad;
      const inCut = new Uint8Array(nSurf), inKept = new Uint8Array(nSurf);
      const cellVs = (i, j) => [gi(i, j), gi(i, j + 1), gi(i + 1, j), gi(i + 1, j + 1)];
      const isCutCell = (i, j) => i >= 1 && i < N - 1 && j >= 0 && j < M && cut[ci(i, j)] === 1;
      for (let i = 1; i < N - 1; i++) {
        for (let j = 0; j < M; j++) {
          let cx = 0, cy = 0;
          for (const v of cellVs(i, j)) { cx += sx[v] / 4; cy += sy[v] / 4; }
          cut[ci(i, j)] = rOf(cx, cy) < 1 ? 1 : 0;
        }
      }
      // A kept cell bordering the cut on two or more sides sticks into the opening; three of its corners
      // would sit on the oval and fold it. Cut those too, until none is left.
      for (let changed = true; changed;) {
        changed = false;
        for (let i = 1; i < N - 1; i++) for (let j = 0; j < M; j++) {
          if (cut[ci(i, j)]) continue;
          const n = isCutCell(i - 1, j) + isCutCell(i + 1, j) + isCutCell(i, j - 1) + isCutCell(i, j + 1);
          if (n >= 2) { cut[ci(i, j)] = 1; changed = true; }
        }
      }
      for (let i = 1; i < N - 1; i++) for (let j = 0; j < M; j++) {
        for (const v of cellVs(i, j)) (cut[ci(i, j)] ? inCut : inKept)[v] = 1;
      }
      // 1. Move every vertex on the cut straight out (or in) onto the oval.
      // 2. Smooth a band of kept vertices around it (each moves to the average of its grid neighbours),
      //    so the grid stretches to meet the oval instead of folding where the cut stair-steps.
      const moved = new Map(); // vertex -> its original [x, y, m, l]
      const keep = k => { if (!moved.has(k)) moved.set(k, [sx[k], sy[k], sm[k], sl[k]]); };
      const onEdge = k => inCut[k] && inKept[k];
      // Cell areas before anything moves, for the fold check further down
      const area = (a, b, c) => (sx[b] - sx[a]) * (sy[c] - sy[a]) - (sx[c] - sx[a]) * (sy[b] - sy[a]);
      const area0 = new Float64Array(2 * (N - 1) * M);
      for (let i = 1; i < N - 1; i++) for (let j = 0; j < M; j++) {
        const a = gi(i, j), b = gi(i, j + 1), c = gi(i + 1, j), d = gi(i + 1, j + 1);
        area0[2 * ci(i, j)] = area(a, b, d); area0[2 * ci(i, j) + 1] = area(a, d, c);
      }
      // Walk the cut's edge in order (the same edges the wall is built on) ...
      const next = new Map();
      let pinched = false;
      const link = (u, w) => { if (next.has(u)) pinched = true; next.set(u, w); };
      for (let i = 1; i < N - 1; i++) for (let j = 0; j < M; j++) {
        if (cut[ci(i, j)]) continue;
        const a = gi(i, j), b = gi(i, j + 1), c = gi(i + 1, j), d = gi(i + 1, j + 1);
        if (isCutCell(i - 1, j)) link(a, b);
        if (isCutCell(i, j + 1)) link(b, d);
        if (isCutCell(i + 1, j)) link(d, c);
        if (isCutCell(i, j - 1)) link(c, a);
      }
      const ring = [];
      if (!pinched && next.size) {
        const start = next.keys().next().value;
        for (let k = start; ring.length <= next.size;) { ring.push(k); k = next.get(k); if (k === start || k === undefined) break; }
        if (ring.length !== next.size) ring.length = 0; // more than one loop: fall back to snapping
      }
      if (ring.length >= 8) {
        // ... and space its vertices evenly round the oval, in the same order, as close as possible to
        // where they were, so neighbours can never land on top of each other.
        const n = ring.length, ang = k => ho.ang(sx[k], sy[k]);
        let total = 0;
        for (let s = 0; s < n; s++) {
          let dA = ang(ring[(s + 1) % n]) - ang(ring[s]);
          if (dA > Math.PI) dA -= 2 * Math.PI; else if (dA < -Math.PI) dA += 2 * Math.PI;
          total += dA;
        }
        const dir = total >= 0 ? 1 : -1;
        let cs = 0, sn = 0;
        for (let s = 0; s < n; s++) { const off = ang(ring[s]) - dir * 2 * Math.PI * s / n; cs += Math.cos(off); sn += Math.sin(off); }
        const c0 = Math.atan2(sn, cs);
        ring.forEach((k, s) => {
          const t = c0 + dir * 2 * Math.PI * s / n;
          keep(k); [sx[k], sy[k]] = ho.at(t);
        });
      } else {
        for (let k = 0; k < nSurf; k++) {
          if (!onEdge(k)) continue;
          const r = rOf(sx[k], sy[k]);
          if (r < 1e-9) continue;
          keep(k);
          sx[k] = ho.xh + (sx[k] - ho.xh) / r;
          sy[k] = ho.yh + (sy[k] - ho.yh) / r;
        }
      }
      const nbrs = k => {
        const i = 1 + Math.floor((k - 1) / (M + 1)), j = (k - 1) % (M + 1), out = [];
        if (i > 1) out.push(gi(i - 1, j));
        if (i < N - 1) out.push(gi(i + 1, j));
        if (j > 0) out.push(gi(i, j - 1));
        if (j < M) out.push(gi(i, j + 1));
        return out.filter(v => inKept[v]);
      };
      const band = [], depth = new Map();
      for (let k = 0; k < nSurf; k++) if (onEdge(k)) depth.set(k, 0);
      let front = [...depth.keys()];
      for (let dpt = 1; dpt <= 3; dpt++) {
        const next = [];
        for (const k of front) for (const v of nbrs(k)) {
          if (depth.has(v) || inCut[v]) continue;
          const j = (v - 1) % (M + 1);
          if (j === 0 || j === M) continue; // never move the outline
          depth.set(v, dpt); next.push(v); band.push(v);
        }
        front = next;
      }
      for (const v of band) keep(v);
      for (let it = 0; it < 30; it++) {
        const nx = new Map();
        for (const v of band) {
          const nb = nbrs(v);
          let ax = 0, ay = 0;
          for (const u of nb) { ax += sx[u]; ay += sy[u]; }
          nx.set(v, [ax / nb.length, ay / nb.length]);
        }
        for (const [v, [x, y]] of nx) { sx[v] = x; sy[v] = y; }
      }
      for (const k of moved.keys()) { const [m, l] = ol.edges(sx[k]); sm[k] = m; sl[k] = l; }
      // Backstop: if a kept triangle still folded or collapsed (under 2% of its area; slivers where three
      // edge points sit on the gently curving oval are fine and stay), put
      // its vertices back on the grid, until none is left.
      const unsnap = v => { const o = moved.get(v); if (!o) return false; [sx[v], sy[v], sm[v], sl[v]] = o; moved.delete(v); return true; };
      for (let changed = true; changed;) {
        changed = false;
        for (let i = 1; i < N - 1; i++) {
          for (let j = 0; j < M; j++) {
            if (cut[ci(i, j)]) continue;
            const a = gi(i, j), b = gi(i, j + 1), c = gi(i + 1, j), d = gi(i + 1, j + 1);
            if (area(a, b, d) > 0.02 * area0[2 * ci(i, j)] && area(a, d, c) > 0.02 * area0[2 * ci(i, j) + 1]) continue;
            for (const v of [a, b, c, d]) if (unsnap(v)) changed = true;
          }
        }
      }
    }

    // Outline loop, counter-clockwise from above: heel → outer edge → toe → inner edge
    const loop = [heelPole];
    for (let i = 1; i < N; i++) loop.push(gi(i, M));
    loop.push(toePole);
    for (let i = N - 1; i >= 1; i--) loop.push(gi(i, 0));

    // Distance to the edge (only needed where the heel cup change reaches, the back 30% of the shell)
    const cupR = CUP_R, dLimit = 0.3 * xe + cupR;
    const dist = new Float64Array(nSurf).fill(1e9);
    if (p.heelAdj !== 0) {
      const lx = loop.map(k => sx[k]), ly = loop.map(k => sy[k]), nl = loop.length;
      for (let k = 0; k < nSurf; k++) {
        const x = sx[k];
        if (x > dLimit) continue;
        let best = 1e9;
        for (let s = 0; s < nl; s++) {
          const ax = lx[s], bx = lx[(s + 1) % nl];
          if (Math.min(ax, bx) > x + cupR + 1 || Math.max(ax, bx) < x - cupR - 1) continue;
          const dd = segDist(x, sy[k], ax, ly[s], bx, ly[(s + 1) % nl]);
          if (dd < best) best = dd;
        }
        dist[k] = best;
      }
    }

    // Vertices: top surface [0, nSurf), bottom surface [nSurf, 2 nSurf)
    const pos = new Float32Array(nSurf * 2 * 3);
    let maxTop = 0;
    const thick = new Float64Array(nSurf);
    for (let k = 0; k < nSurf; k++) {
      const [top, bot, tk] = hf(sx[k], sy[k], sm[k], sl[k], dist[k]);
      const y = mirror ? -sy[k] : sy[k];
      pos[k * 3] = sx[k]; pos[k * 3 + 1] = y; pos[k * 3 + 2] = top;
      const b = (nSurf + k) * 3;
      pos[b] = sx[k]; pos[b + 1] = y; pos[b + 2] = bot;
      thick[k] = tk;
      if (top > maxTop) maxTop = top;
    }
    if (p.style === 'thin') {
      // Thin shell: the underside follows the top surface at the shell's thickness, measured square to
      // the surface (so steep cup walls keep their thickness), and stops at the floor. The heel cup
      // and arch come out as a curved shell that only touches the floor where the top is low.
      const zt = k => pos[k * 3 + 2];
      const slant = new Float64Array(nSurf).fill(1);
      // Slope of the top surface at a point: a least-squares plane through every surface point within a
      // couple of millimetres, not just the four grid neighbours. Behind the heel and at the toe the grid
      // rows bunch up to hundredths of a millimetre apart, and four neighbours there give mostly noise.
      const SLOPE_R = 2.0;
      const slopeAt = (i, j) => {
        const k = gi(i, j);
        let r = SLOPE_R;
        for (const v of [i > 1 ? gi(i - 1, j) : -1, i < N - 1 ? gi(i + 1, j) : -1, j > 0 ? gi(i, j - 1) : -1, j < M ? gi(i, j + 1) : -1])
          if (v >= 0) r = Math.max(r, 1.01 * Math.hypot(sx[v] - sx[k], sy[v] - sy[k]));
        let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
        const add = v => {
          const dx = sx[v] - sx[k], dy = sy[v] - sy[k], dd = Math.hypot(dx, dy);
          if (dd > r || v === k) return;
          const w = 1 - dd / (r * 1.0001), dz = zt(v) - zt(k);
          a11 += w * dx * dx; a12 += w * dx * dy; a22 += w * dy * dy; b1 += w * dx * dz; b2 += w * dy * dz;
        };
        for (let ii = i; ii >= 1 && Math.abs(sx[gi(ii, j)] - sx[k]) <= r; ii--) for (let jj = 0; jj <= M; jj++) add(gi(ii, jj));
        for (let ii = i + 1; ii < N && Math.abs(sx[gi(ii, j)] - sx[k]) <= r; ii++) for (let jj = 0; jj <= M; jj++) add(gi(ii, jj));
        if (Math.hypot(sx[heelPole] - sx[k], sy[heelPole] - sy[k]) <= r) add(heelPole);
        if (Math.hypot(sx[toePole] - sx[k], sy[toePole] - sy[k]) <= r) add(toePole);
        const det = a11 * a22 - a12 * a12;
        if (!(det > 1e-12)) return 1;
        const gx = (a22 * b1 - a12 * b2) / det, gy = (a11 * b2 - a12 * b1) / det;
        return Math.min(THIN_MAX_SLANT, Math.sqrt(1 + gx * gx + gy * gy));
      };
      for (let i = 1; i < N; i++) {
        for (let j = 1; j < M; j++) slant[gi(i, j)] = slopeAt(i, j);
        // On the outline itself the neighbours all lie on one side, which makes the slope jump from one
        // point to the next and the rim's lower edge ragged. Use the steepness just inside the edge.
        slant[gi(i, 0)] = slant[gi(i, 1)];
        slant[gi(i, M)] = slant[gi(i, M - 1)];
      }
      // Smooth the steepness a little (not the surface), so the underside and the rim's lower edge run
      // as smoothly as the top does.
      for (let it = 0; it < 4; it++) {
        const s2 = Float64Array.from(slant);
        for (let i = 1; i < N; i++) for (let j = 0; j <= M; j++) {
          const nb = [];
          if (i > 1) nb.push(gi(i - 1, j));
          if (i < N - 1) nb.push(gi(i + 1, j));
          if (j > 0) nb.push(gi(i, j - 1));
          if (j < M) nb.push(gi(i, j + 1));
          let a = 0;
          for (const v of nb) a += slant[v];
          s2[gi(i, j)] = 0.5 * slant[gi(i, j)] + 0.5 * a / nb.length;
        }
        slant.set(s2);
      }
      const under = new Float64Array(nSurf);
      for (let i = 1; i < N; i++) for (let j = 0; j <= M; j++) { const k = gi(i, j); under[k] = zt(k) - thick[k] * slant[k]; }
      // The two poles are points on the outline: level them with the rim on either side of them,
      // not with the whole ring (which takes in the low middle of the heel cup and notches the rim).
      const pole = (k, i) => Math.min(0.5 * (under[gi(i, 0)] + under[gi(i, M)]) + (zt(k) - 0.5 * (zt(gi(i, 0)) + zt(gi(i, M)))), zt(k) - 1);
      under[heelPole] = pole(heelPole, 1);
      under[toePole] = pole(toePole, N - 1);
      for (let k = 0; k < nSurf; k++) pos[(nSurf + k) * 3 + 2] = Math.max(0, under[k]);
    }

    // Triangles: top, bottom, then side walls
    const tris = [];
    const B = nSurf;
    const pushTop = (a, b, c) => tris.push(a, b, c);
    const pushBot = (a, b, c) => tris.push(B + a, B + c, B + b);
    // poles
    for (let j = 0; j < M; j++) {
      const r0 = gi(1, j), r1 = gi(1, j + 1);
      pushTop(heelPole, r1, r0);
      const q0 = gi(N - 1, j), q1 = gi(N - 1, j + 1);
      pushTop(toePole, q0, q1);
    }
    for (let i = 1; i < N - 1; i++) {
      for (let j = 0; j < M; j++) {
        if (cut[ci(i, j)]) continue;
        const a = gi(i, j), b = gi(i, j + 1), c = gi(i + 1, j), d = gi(i + 1, j + 1);
        pushTop(a, b, d); pushTop(a, d, c);
      }
    }
    const nTop = tris.length / 3;
    for (let j = 0; j < M; j++) {
      const r0 = gi(1, j), r1 = gi(1, j + 1);
      pushBot(heelPole, r1, r0);
      const q0 = gi(N - 1, j), q1 = gi(N - 1, j + 1);
      pushBot(toePole, q0, q1);
    }
    for (let i = 1; i < N - 1; i++) {
      for (let j = 0; j < M; j++) {
        if (cut[ci(i, j)]) continue;
        const a = gi(i, j), b = gi(i, j + 1), c = gi(i + 1, j), d = gi(i + 1, j + 1);
        pushBot(a, b, d); pushBot(a, d, c);
      }
    }
    const nBot = tris.length / 3 - nTop;
    for (let s = 0; s < loop.length; s++) {
      const u = loop[s], w = loop[(s + 1) % loop.length];
      tris.push(B + u, B + w, w);
      tris.push(B + u, w, u);
    }
    if (ho) {
      // Wall round the opening: every edge of a kept cell that borders a cut cell, wound the same
      // way as the outer wall (cell rows run i -> i+1 along x, columns j -> j+1 inner -> outer).
      const wall = (u, w) => { tris.push(B + u, B + w, w); tris.push(B + u, w, u); };
      const isCut = (i, j) => i >= 1 && i < N - 1 && j >= 0 && j < M && cut[ci(i, j)] === 1;
      for (let i = 1; i < N - 1; i++) {
        for (let j = 0; j < M; j++) {
          if (cut[ci(i, j)]) continue;
          const a = gi(i, j), b = gi(i, j + 1), c = gi(i + 1, j), d = gi(i + 1, j + 1);
          // top-surface edge directions in this cell's triangles (a,b,d) and (a,d,c): a->b, b->d, d->c, c->a
          if (isCut(i - 1, j)) wall(a, b);
          if (isCut(i, j + 1)) wall(b, d);
          if (isCut(i + 1, j)) wall(d, c);
          if (isCut(i, j - 1)) wall(c, a);
        }
      }
    }
    const tri = new Uint32Array(tris);
    if (mirror) for (let t = 0; t < tri.length; t += 3) { const tmp = tri[t + 1]; tri[t + 1] = tri[t + 2]; tri[t + 2] = tmp; }

    // Stats
    let vol = 0;
    for (let t = 0; t < tri.length; t += 3) {
      const a = tri[t] * 3, b = tri[t + 1] * 3, c = tri[t + 2] * 3;
      vol += (pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) -
        pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c]) +
        pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c])) / 6;
    }
    // Width is edge to edge across the whole outline, as a ruler laid across the orthotic reads it. The inner
    // and outer bulges sit at different points along the foot, so no single cross-section is this wide.
    let minY = 1e9, maxY = -1e9;
    for (let k = 0; k < nSurf; k++) { const y = pos[k * 3 + 1]; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    const maxWidth = maxY - minY;
    const outline = loop.map(k => [sx[k], mirror ? -sy[k] : sy[k]]);

    return {
      params: p, pos, tri, nSurf,
      counts: { top: nTop, bottom: nBot, wall: tri.length / 3 - nTop - nBot },
      outline,
      stats: {
        length: xe, maxWidth, maxHeight: maxTop, volume: vol / 1000, // cm^3
        weight: (vol / 1000) * DENSITY[p.material], minY, maxY
      }
    };
  }

  /* ---------- Binary STL ---------- */
  function toSTL(meshes) {
    let n = 0;
    for (const m of meshes) n += m.tri.length / 3;
    const buf = new ArrayBuffer(84 + n * 50), dv = new DataView(buf);
    const header = 'Archform - binary STL, units mm';
    for (let i = 0; i < 80; i++) dv.setUint8(i, i < header.length ? header.charCodeAt(i) : 32);
    dv.setUint32(80, n, true);
    let o = 84;
    for (const m of meshes) {
      const { pos, tri } = m, ox = m.offsetX || 0, oy = m.offsetY || 0;
      for (let t = 0; t < tri.length; t += 3) {
        const a = tri[t] * 3, b = tri[t + 1] * 3, c = tri[t + 2] * 3;
        const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
        const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len; ny /= len; nz /= len;
        dv.setFloat32(o, nx, true); dv.setFloat32(o + 4, ny, true); dv.setFloat32(o + 8, nz, true); o += 12;
        for (const v of [a, b, c]) {
          dv.setFloat32(o, pos[v] + ox, true); dv.setFloat32(o + 4, pos[v + 1] + oy, true);
          dv.setFloat32(o + 8, pos[v + 2], true); o += 12;
        }
        dv.setUint16(o, 0, true); o += 2;
      }
    }
    return buf;
  }


  // Each warning names the setting that tripped it, where that setting lives and
  // what to do about it. A warning you cannot act on is just noise.
  function warnings(input) {
    const p = sanitize(input), w = [];
    const n1 = v => v.toFixed(1);
    if (p.style !== 'thin') w.push('The shape is a thin moulded shell. Set Base to Thin shell under Print to match it; solid fills in underneath.');
    if (p.shellThick < 2.5 && p.material !== 'tpu') w.push(`A ${p.material.toUpperCase()} shell ${n1(p.shellThick)} mm thick can crack. Raise shell thickness to 2.5–3.5 mm under Print, or switch the material to TPU.`);
    if (Math.abs(p.archAdjHeight) > 4) w.push(`The arch is ${p.archAdjHeight > 0 ? 'raised' : 'lowered'} ${n1(Math.abs(p.archAdjHeight))} mm from the shape. Big changes are easier to judge in 2 mm steps, printing between them.`);
    return w;
  }

  // Where the arch peaks along the inner edge, and how high its top surface is there above the table.
  function archPeak(input) {
    const p = sanitize(input), ol = makeOutline(), hf = makeHeights(p, ol);
    const x = clamp(shape().arch.peak_x + p.archAdjShift, 0.5, ol.xe - 0.5);
    const [m, l] = ol.edges(x);
    return { x, top: hf(x, m, m, l, 0)[0] };
  }

  root.OrthoGeom = { DEFAULTS, LIMITS, build, toSTL, warnings, sanitize, archPeak };
})(typeof window !== 'undefined' ? window : globalThis);
