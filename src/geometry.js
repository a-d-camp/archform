/*
 * Orthotic geometry engine — scan-free, measurement-driven.
 * Pure JavaScript, no dependencies. Builds a closed, printable triangle mesh
 * (millimetres, Z up, X from heel to toe, +Y = medial side of a RIGHT foot).
 */
(function (root) {
  'use strict';

  const DEFAULTS = {
    side: 'right',        // right | left | pair (pair is a view/export option)
    length: 265,          // foot length, heel to longest toe (mm)
    ballWidth: 100,       // widest part across the ball of the foot (mm)
    heelWidth: 66,        // widest part of the heel (mm)
    base: 'none',         // 'none' (shape from the measurements below) or a fitted base shape from src/bases.js
    archAdjHeight: 0,     // base shapes: raise (+) or lower (-) the arch, mm at the inner edge under the peak
    archAdjShift: 0,      // base shapes: move the arch toward the toes (+) or the heel (-), mm
    archAdjLength: 0,     // base shapes: stretch (+) or shorten (-) the arch along the foot, %
    archAdjReach: 60,     // base shapes: how far across from the inner edge an arch height change carries, %
    outerAdj: 0,          // base shapes: raise (+) or lower (-) the outer side under the arch, mm
    heelAdj: 0,           // base shapes: deepen (+) or flatten (-) the heel cup walls, mm
    coverage: '3q',       // 3q | sulcus | full
    shellLength: 0,       // length of a 3q or sulcus shell (mm), overriding the coverage's share of the foot; 0 = off
    shellWidth: 0,        // widest a 3q or sulcus shell gets across the foot (mm); wider parts of the outline ease down to it; 0 = off
    shellSlant: 0,        // how much further forward the inner side of a 3q or sulcus front edge reaches than the outer (mm); 0 = rounded front
    archHeight: 15,       // medial arch rise above the base (mm)
    archPeak: 42,         // arch peak position, % of foot length from heel
    archSpread: 65,       // how far across the foot the arch reaches (%)
    archFill: 0,          // share of the spread held at full arch height (%); 0 = a ramp from the inner edge
    archLength: 0,        // length held at full arch height around the peak, % of foot length; 0 = a single peak
    archRound: 0,         // across the foot: 0 = S-curve with a flat top by the inner edge; 100 = keeps rising to the edge
    lateralArch: 2,       // outer (lateral) arch rise (mm)
    heelCup: 12,          // heel cup wall height (mm)
    heelCupReach: 0,      // how far the cup curve reaches toward the heel centre, % of half the heel width;
                          // 0 = walls only (curve reaches 8 + 0.8 x depth mm in from the edge)
    heelHole: 0,          // width of an oval opening under the heel centre (mm); 0 = none
    heelHolePos: 0,       // distance from the back of the heel to the opening's centre (mm); 0 = under the heel pad (55% of heel width)
    heelLift: 0,          // extra height under the heel (mm)
    rearPost: 0,          // rearfoot post angle, + raises inner side (deg)
    metPad: 0,            // metatarsal pad height (mm)
    metPadPos: 63,        // met pad centre, % of foot length
    forePost: 0,          // forefoot post angle, + raises inner side (deg)
    style: 'solid',       // solid (flat base) | shell (hollow under arch) | thin (constant thickness, rounded underneath)
    shellThick: 3,        // thickness at heel and arch (mm)
    foreThick: 2,         // thickness at forefoot (mm)
    material: 'tpu'
  };

  const LIMITS = {
    archAdjHeight: [-8, 8], archAdjShift: [-25, 25], archAdjLength: [-30, 30], archAdjReach: [20, 100],
    outerAdj: [-5, 8], heelAdj: [-8, 8],
    length: [150, 340], ballWidth: [55, 135], heelWidth: [35, 95], shellLength: [0, 340], shellWidth: [0, 135], shellSlant: [0, 60],
    archHeight: [0, 30], archPeak: [32, 52], archSpread: [35, 100], archFill: [0, 100], archLength: [0, 30], archRound: [0, 100], lateralArch: [0, 8],
    heelCup: [0, 25], heelCupReach: [0, 100], heelHole: [0, 45], heelHolePos: [0, 120], heelLift: [0, 15], rearPost: [-8, 8],
    metPad: [0, 8], metPadPos: [55, 68], forePost: [-8, 8],
    shellThick: [1.5, 8], foreThick: [1, 6]
  };

  const COVERAGE_END = { '3q': 0.67, sulcus: 0.80, full: 1.0 };
  // Where the orthotic ends, as a share of foot length. A shell length (3/4 and sulcus only) sets it
  // directly, kept between half and 95% of the foot.
  const SHELL_MIN = 0.5, SHELL_MAX = 0.95, SHELL_KNEE = 8;
  // Thin shell: on very steep walls, thicken the vertical offset by at most this factor (about 70 degrees)
  const THIN_MAX_SLANT = 3;
  // Slanted front: tip set in from the inner edge by this share of the width, rounded over this share
  // of the width, and the outer edge's sweep to it (1 = straight diagonal, larger = fuller curve).
  const SLANT_TIP_IN = 0.16, SLANT_TIP_ROUND = 0.10, SLANT_CURVE = 1.2;
  function coverageEnd(p) {
    const Bc = baseOf(p);
    if (Bc) return Bc.length / p.length;
    if (p.coverage !== 'full' && p.shellLength > 0) return clamp(p.shellLength / p.length, SHELL_MIN, SHELL_MAX);
    return COVERAGE_END[p.coverage];
  }
  const DENSITY = { tpu: 1.21, petg: 1.27, pla: 1.24 }; // g/cm^3

  const N_ROWS = 150;   // along the length
  const N_COLS = 56;    // across the width

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  function smooth(e0, e1, x) {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  }
  function smoother(e0, e1, x) {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * t * (t * (t * 6 - 15) + 10);
  }

  // Monotone cubic Hermite interpolation (Fritsch–Carlson): smooth, no overshoot.
  function makeInterp(xs, ys) {
    const n = xs.length, d = new Array(n - 1), m = new Array(n);
    for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
      const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
      if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
    }
    return function (x) {
      if (x <= xs[0]) return ys[0];
      if (x >= xs[n - 1]) return ys[n - 1];
      let i = 0;
      while (x > xs[i + 1]) i++;
      const h = xs[i + 1] - xs[i], t = (x - xs[i]) / h, t2 = t * t, t3 = t2 * t;
      return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] +
        (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
    };
  }

  function sanitize(input) {
    const p = Object.assign({}, DEFAULTS, input || {});
    for (const k in LIMITS) {
      const v = Number(p[k]);
      p[k] = Number.isFinite(v) ? clamp(v, LIMITS[k][0], LIMITS[k][1]) : DEFAULTS[k];
    }
    if (!COVERAGE_END[p.coverage]) p.coverage = DEFAULTS.coverage;
    if (typeof p.base !== 'string' || (p.base !== 'none' && !(root.OrthoBases && root.OrthoBases[p.base]))) p.base = 'none';
    if (p.style !== 'shell' && p.style !== 'thin') p.style = 'solid';
    if (!DENSITY[p.material]) p.material = DEFAULTS.material;
    // keep the heel narrower than the ball so the outline stays sensible
    p.heelWidth = Math.min(p.heelWidth, p.ballWidth * 0.95, p.length * 0.36);
    return p;
  }

  /* ---------- Base shapes (fitted designs from the Python tool, see src/bases.js) ---------- */
  // A base replaces the measurement-driven outline and surface with a fitted one: an outline table
  // and a bicubic B-spline over (s along the shell 0..1, v across 0 = inner edge .. 1 = outer edge).
  // The arch adjustments then reshape it smoothly; at zero they give the base exactly.
  const BASE_ARCH_CORE = 0.18, BASE_ARCH_FADE = 0.16, BASE_CUP_R = 15;
  function baseOf(p) {
    const B = root.OrthoBases;
    return p && p.base && p.base !== 'none' && B && B[p.base] ? B[p.base] : null;
  }
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
  function baseSpline(B) {
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
  function baseOutline(B) {
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
    return { edges, xe, yc: yTip, y0, L: xe, W, H: at(YM, 0.15 * xe) - at(YL, 0.15 * xe), base: B };
  }
  // The arch adjustments, in the base's own (s, v). Returns the height at plan point (s, v), d mm from the edge.
  function baseHeights(p, ol, B) {
    const S = baseSpline(B), L = B.length, sp = B.arch.peak_s;
    const k = 1 + p.archAdjLength / 100, c = clamp(sp + p.archAdjShift / L, 0.15, 0.85);
    const core = BASE_ARCH_CORE * k, fade = BASE_ARCH_FADE;
    const win = s => 1 - smooth(core, core + fade, Math.abs(s - c));
    const reach = p.archAdjReach / 100;
    return (s, v, d) => {
      // move and stretch the arch: read the base from where this point's arch came from
      const w = win(s);
      const s0 = s + w * (sp + (s - c) / k - s);
      let z = S(s0, v);
      const across = v < reach ? (1 - v / reach) ** 2 : 0;
      z += p.archAdjHeight * w * across;
      z += p.outerAdj * w * smooth(0.45, 1.0, v);
      if (p.heelAdj !== 0 && d < BASE_CUP_R) z += p.heelAdj * (1 - smooth(0.10, 0.30, s)) * (1 - d / BASE_CUP_R) ** 2;
      return z;
    };
  }

  /* ---------- Outline: medial offset m(x) and lateral offset l(x) from the foot axis ---------- */
  function makeOutline(p) {
    const Bs = baseOf(p);
    if (Bs) return baseOutline(Bs);
    const L = p.length, W = p.ballWidth, H = p.heelWidth;
    const rh = Math.min(H / 2, 0.2 * L);
    const mi = makeInterp(
      [rh, 0.25 * L, 0.45 * L, 0.72 * L, 0.86 * L, L],
      [0.5 * H, 0.5 * H, 0.5 * (0.5 * H + 0.45 * W) - 0.025 * W, 0.45 * W, 0.42 * W, 0.34 * W]);
    const li = makeInterp(
      [rh, 0.30 * L, 0.47 * L, 0.66 * L, 0.84 * L, L],
      [0.5 * H, 0.56 * H, 0.5 * (0.56 * H + 0.55 * W) + 0.01 * W, 0.55 * W, 0.44 * W, 0.30 * W]);

    const baseM = x => (x < rh ? 0.5 * H * Math.sqrt(Math.max(0, 1 - (1 - x / rh) ** 2)) : mi(x));
    const baseL = x => (x < rh ? 0.5 * H * Math.sqrt(Math.max(0, 1 - (1 - x / rh) ** 2)) : li(x));

    const xe = coverageEnd(p) * L;
    let capStart, yc, pm, pl;
    // Slanted front (3/4 and sulcus): the outer side ends `slant` mm short of the tip, and the edge sweeps
    // forward to a rounded tip near the inner side, like a shell cut along the line of the metatarsal heads.
    let slant = 0, capStartM = 0, capStartL = 0;
    if (p.coverage === 'full') {
      capStart = 0.84 * L; yc = 0.18 * W; pm = 2.6; pl = 1.5;           // toe shape, big toe longest
    } else {
      const w = baseM(xe) + baseL(xe);
      capStart = xe - (p.coverage === '3q' ? 0.18 : 0.22) * w;      // gently rounded distal edge
      yc = (baseM(capStart) - baseL(capStart)) / 2 + 0.12 * w;          // longer on the inner side
      pm = 2.5; pl = 1.6;
      if (p.shellSlant > 0) {
        slant = Math.min(p.shellSlant, 0.5 * xe);
        capStartM = xe - SLANT_TIP_ROUND * w;                           // rounding into the tip
        capStartL = Math.min(xe - slant, capStartM);                    // outer corner
        yc = baseM(xe) - SLANT_TIP_IN * w;                              // tip, just in from the inner edge
      }
    }
    // Shell width (3/4 and sulcus): a ceiling on the width across the foot. Narrower sections are left
    // alone; wider ones ease down toward it over the last SHELL_KNEE mm, so the outline has no corner.
    // Each section narrows evenly about the foot axis.
    const capW = p.coverage !== 'full' && p.shellWidth > 0 ? p.shellWidth : 0;
    const narrow = x => {
      if (!capW) return 1;
      const w = baseM(x) + baseL(x), knee = capW - SHELL_KNEE;
      return w <= knee ? 1 : (capW - SHELL_KNEE * Math.exp(-(w - knee) / SHELL_KNEE)) / w;
    };
    function edges(x) {
      let m = baseM(x), l = baseL(x);
      if (slant > 0) {
        if (x > capStartM) {
          const s = clamp((x - capStartM) / (xe - capStartM), 0, 1);
          m = yc + (m - yc) * Math.sqrt(Math.max(0, 1 - s ** 2.5));
        }
        if (x > capStartL) {
          const s = clamp((x - capStartL) / (xe - capStartL), 0, 1);
          l = -yc + (l + yc) * Math.max(0, 1 - s ** SLANT_CURVE) ** (1 / SLANT_CURVE);
        }
      } else if (x > capStart) {
        const s = clamp((x - capStart) / (xe - capStart), 0, 1);
        m = yc + (m - yc) * Math.sqrt(Math.max(0, 1 - s ** pm));
        l = -yc + (l + yc) * Math.sqrt(Math.max(0, 1 - s ** pl));
      }
      const k = narrow(x);
      return [m * k, l * k];
    }
    return { edges, xe, yc: yc * narrow(xe), L, W, H };
  }

  // How far in from the edge the heel cup curve reaches (mm). The default ties it to the wall
  // height; heelCupReach can carry the curve further in, up to the heel centre, for a rounder seat.
  function cupRadius(p) {
    if (baseOf(p)) return BASE_CUP_R;
    return Math.max(8 + 0.8 * p.heelCup, (p.heelCupReach / 100) * (p.heelWidth / 2));
  }

  // The heel opening: an oval centred under the heel pad, 25% longer than wide. The heel seat slopes
  // down over `taper` mm to a thin rim around it, so the middle of the heel rests on the shoe instead.
  // It shrinks to keep at least HOLE_SIDE mm of material either side and HOLE_BACK mm behind it.
  const HOLE_SIDE = 10, HOLE_BACK = 8, HOLE_TAPER = 12, HOLE_RIM = 1.5;
  // Shape helpers on the returned opening: rad(x, y) is 1 on the edge (below 1 inside, and it grows in
  // proportion to the distance from the centre), ang(x, y) is the angle round the centre, at(t) the edge point there.
  function shapeOpening(ho, fourier) {
    if (fourier) {
      const R = t => { let r = fourier[0]; for (let k = 1; 2 * k < fourier.length; k++) r += fourier[2 * k - 1] * Math.cos(k * t) + fourier[2 * k] * Math.sin(k * t); return r; };
      ho.ang = (x, y) => Math.atan2(y - ho.yh, x - ho.xh);
      ho.rad = (x, y) => Math.hypot(x - ho.xh, y - ho.yh) / R(ho.ang(x, y));
      ho.at = t => [ho.xh + R(t) * Math.cos(t), ho.yh + R(t) * Math.sin(t)];
    } else {
      ho.ang = (x, y) => Math.atan2((y - ho.yh) / ho.ry, (x - ho.xh) / ho.rx);
      ho.rad = (x, y) => Math.hypot((x - ho.xh) / ho.rx, (y - ho.yh) / ho.ry);
      ho.at = t => [ho.xh + ho.rx * Math.cos(t), ho.yh + ho.ry * Math.sin(t)];
    }
    return ho;
  }
  function heelOpening(p, ol) {
    const Bo = baseOf(p);
    if (Bo) {
      if (!Bo.opening) return null;
      const [cx, cy] = Bo.opening.center, [w, len] = Bo.opening.size;
      return shapeOpening({ xh: cx, yh: cy, rx: len / 2, ry: w / 2, width: w, taper: 0, rim: HOLE_RIM, fromBase: true }, Bo.opening.fourier);
    }
    if (!(p.heelHole > 0)) return null;
    const xh = p.heelHolePos > 0 ? Math.min(p.heelHolePos, ol.xe - HOLE_BACK - 4) : 0.55 * p.heelWidth;
    const [m, l] = ol.edges(xh);
    const ry = Math.min(p.heelHole / 2, (m + l) / 2 - HOLE_SIDE, (xh - HOLE_BACK) / 1.25, (ol.xe - HOLE_SIDE - xh) / 1.25);
    if (ry < 3) return null;
    return shapeOpening({ xh, yh: (m - l) / 2, rx: 1.25 * ry, ry, width: 2 * ry, taper: HOLE_TAPER, rim: HOLE_RIM });
  }

  /* ---------- Height field ---------- */
  function makeHeights(p, ol) {
    const Bh = baseOf(p);
    if (Bh) {
      const H = baseHeights(p, ol, Bh), t = p.shellThick;
      return function (x, y, m, l, d) {
        const span = m + l, s = x / ol.xe, v = span > 1e-6 ? clamp((m - y) / span, 0, 1) : 0.5;
        const top = Math.max(t, H(s, v, d == null ? 1e9 : d));
        return [top, 0, t];
      };
    }
    const ho = heelOpening(p, ol);
    const L = p.length, W = p.ballWidth, xe = ol.xe, fEnd = xe / L;
    const A = p.archHeight, LA = p.lateralArch, C = p.heelCup, P = p.metPad;
    const fs = 0.16, fpk = clamp(p.archPeak / 100, fs + 0.08, Math.min(0.70, fEnd - 0.01) - 0.08);
    const fae = Math.min(0.70, fEnd - 0.01);
    const cupR = cupRadius(p);
    const spread = p.archSpread / 100;
    // Across the foot (tn: 0 = outer edge, 1 = inner edge) the arch is at full height from archFull to the
    // inner edge and ramps down to zero at archFoot. The ramp is kept at least 10% of the width so a big
    // plateau never becomes a vertical step; when that pushes archFoot past the outer edge (archFoot < 0)
    // the outer edge stays raised. At 100% spread and 100% plateau the whole width is at full height.
    const archFull = 1 - (p.archFill / 100) * spread;
    const archFoot = Math.min(1 - spread, archFull - 0.10);
    const rp = (p.rearPost * Math.PI) / 180, fp = (p.forePost * Math.PI) / 180;
    const xp = (p.metPadPos / 100) * L, yp = -0.04 * W;
    const aProx = 0.10 * L, aDist = 0.045 * L, bPad = 0.17 * W;

    // Along the foot the arch rises from fs to pa, holds full height to pb, and falls to fae. With no
    // arch length pa = pb = the peak. Each slope keeps at least 6% of the foot length.
    const half = p.archLength / 200;
    const pa = Math.max(fs + 0.06, Math.min(fpk, fpk - half)), pb = Math.max(pa, Math.min(fae - 0.06, fpk + half));
    function gArch(f) {
      if (f <= fs || f >= fae) return 0;
      if (f < pa) return 0.5 - 0.5 * Math.cos(Math.PI * (f - fs) / (pa - fs));
      if (f <= pb) return 1;
      return 0.5 + 0.5 * Math.cos(Math.PI * (f - pb) / (fae - pb));
    }
    function gLat(f) {
      const a = 0.24, pk = 0.40, b = Math.min(0.60, fEnd - 0.02);
      if (f <= a || f >= b) return 0;
      return f < pk ? 0.5 - 0.5 * Math.cos(Math.PI * (f - a) / (pk - a))
        : 0.5 + 0.5 * Math.cos(Math.PI * (f - pk) / (b - pk));
    }

    return function (x, y, m, l, d) {
      const f = x / L;
      let t = lerp(p.shellThick, p.foreThick, smooth(0.55, 0.72, f));
      if (p.coverage !== 'full') t = lerp(t, Math.min(t, 1.2), smooth(xe - 16, xe, x)); // skive the end

      // Posts and lifts sit underneath the shell
      const wR = 1 - smooth(0.30, 0.55, f), wF = smooth(0.55, 0.72, f);
      let post = p.heelLift * (1 - smooth(0.28, 0.55, f));
      if (rp > 0) post += Math.tan(rp) * (y + l) * wR;
      else if (rp < 0) post += Math.tan(-rp) * (m - y) * wR;
      if (fp > 0) post += Math.tan(fp) * (y + l) * wF;
      else if (fp < 0) post += Math.tan(-fp) * (m - y) * wF;

      // Contours of the shell
      const span = m + l;
      const tn = span > 1e-6 ? clamp((y + l) / span, 0, 1) : 0.5; // 0 = outer edge, 1 = inner edge
      // Across the foot: an S-curve, flat at the top (roundness 0), blending into a curve that keeps
      // rising to the inner edge with no flat top, like a moulded shell (roundness 100)
      const ua = clamp((tn - archFoot) / (archFull - archFoot), 0, 1);
      const across = lerp(smoother(archFoot, archFull, tn), ua * ua, p.archRound / 100);
      const arch = A * gArch(f) * across;
      const lat = LA * gLat(f) * smoother(0.6, 1.0, 1 - tn);
      let cup = 0;
      if (C > 0 && d < cupR) cup = C * (1 - smooth(0.25, 0.50, f)) * (1 - d / cupR) ** 2;
      let pad = 0;
      if (P > 0) {
        const dx = x - xp, a = dx < 0 ? aProx : aDist;
        const r = Math.sqrt((dx / a) ** 2 + ((y - yp) / bPad) ** 2);
        if (r < 1) pad = P * 0.5 * (1 + Math.cos(Math.PI * r));
      }

      // Smooth maximum, so the heel cup wall flows into the arch instead of stacking on it
      // With a plateau the outer arch fills in under it rather than stacking a ridge on top
      // (archFill 0 leaves the plain sum unchanged).
      const a = arch + Math.max(0, lat - (p.archFill / 100) * arch), k = Math.min(4, 0.5 * Math.min(a, cup));
      let shell = Math.max(a, cup);
      if (k > 1e-6) {
        const h = clamp(0.5 + (0.5 * (a - cup)) / k, 0, 1);
        shell = lerp(cup, a, h) + k * h * (1 - h);
      }
      let top = t + post + shell + pad;
      const bottom = p.style === 'shell' ? a * smooth(0.20, 0.34, f) : 0;
      if (ho) {
        // Slope the seat down to the rim of the heel opening (inside it, the rim height stands in;
        // the mesh builder cuts those cells away)
        const ex = x - ho.xh, ey = y - ho.yh, r = ho.rad(x, y), rimTop = bottom + ho.rim;
        if (r <= 1) top = rimTop;
        else top = rimTop + (top - rimTop) * smooth(0, ho.taper, Math.hypot(ex, ey) * (1 - 1 / r));
      }
      // Third value: the shell's thickness here, which the mesh builder uses for the thin style
      return [top, bottom, t];
    };
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
    const ho = heelOpening(p, ol);
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

    // Distance to the edge (only needed where the heel cup lives)
    const cupR = cupRadius(p), dLimit = 0.55 * p.length + cupR;
    const dist = new Float64Array(nSurf).fill(1e9);
    if (baseOf(p) ? p.heelAdj !== 0 : p.heelCup > 0) {
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

  /* ---------- Shoe size to foot length (approximate, Brannock-style) ---------- */
  function lengthFromShoeSize(system, size) {
    const s = Number(size);
    if (!Number.isFinite(s)) return null;
    switch (system) {
      case 'eu': return (s / 1.5 - 1.5) * 10;
      case 'au-m': return (25.4 * (s + 23)) / 3;     // AU/UK men's
      case 'us-m': return (25.4 * (s + 22)) / 3;
      case 'au-w': return (25.4 * (s + 21)) / 3;     // AU/US women's
      default: return null;
    }
  }

  // Each warning names the setting that tripped it, where that setting lives and
  // what to do about it. A warning you cannot act on is just noise.
  function warnings(input) {
    const p = sanitize(input), w = [];
    const n1 = v => v.toFixed(1);
    const Bw = baseOf(p);
    if (Bw) {
      if (p.style !== 'thin') w.push(`${Bw.label} is a thin moulded shell. Set Base to Thin shell under Print to match it; ${p.style === 'solid' ? 'solid' : 'shell'} fills in underneath.`);
      if (p.style !== 'solid' && p.shellThick < 2.5 && p.material !== 'tpu') w.push(`A ${p.material.toUpperCase()} shell ${n1(p.shellThick)} mm thick can crack. Raise shell thickness to 2.5–3.5 mm under Print, or switch the material to TPU.`);
      if (Math.abs(p.archAdjHeight) > 4) w.push(`The arch is ${p.archAdjHeight > 0 ? 'raised' : 'lowered'} ${n1(Math.abs(p.archAdjHeight))} mm from ${Bw.label}. Big changes are easier to judge in 2 mm steps, printing between them.`);
      return w;
    }
    const ratioW = p.ballWidth / p.length, ratioH = p.heelWidth / p.ballWidth;
    if (ratioW < 0.32 || ratioW > 0.46) {
      w.push(`Forefoot width is ${Math.round(ratioW * 100)}% of the foot length, and most feet are 34–42%. Check forefoot width and foot length under Your foot.`);
    }
    if (ratioH < 0.55 || ratioH > 0.85) {
      w.push(`Heel width is ${Math.round(ratioH * 100)}% of the forefoot width, and it is usually 60–80%. Re-measure the heel about 2–3 cm forward from the back and set it under Your foot.`);
    }
    if (p.archHeight > 22) {
      w.push(`Arch height is ${n1(p.archHeight)} mm. Above about 20 mm feels aggressive for most people: lower it under Arch and go back up 2 mm at a time.`);
    }
    if (Math.abs(p.rearPost) > 6) {
      w.push(`Rearfoot post is ${n1(p.rearPost)}°, which tilts the heel by about ${n1(Math.abs(Math.tan((p.rearPost * Math.PI) / 180) * p.heelWidth))} mm across. Anything past 6° is uncommon unless a podiatrist measured you for it: set it back under Heel.`);
    }
    if (Math.abs(p.forePost) > 6) {
      w.push(`Forefoot post is ${n1(p.forePost)}°, which tilts the forefoot by about ${n1(Math.abs(Math.tan((p.forePost * Math.PI) / 180) * p.ballWidth))} mm across. Anything past 6° is uncommon unless a podiatrist measured you for it: set it back under Forefoot.`);
    }
    if (p.metPad > 0 && p.coverage === '3q' && p.metPadPos > 64) {
      w.push('The met pad sits at the very end of a 3/4 shell. Move metatarsal pad position back under Forefoot, or switch the orthotic to sulcus or full length under Your foot.');
    }
    if (p.shellLength > 0 && p.coverage !== 'full') {
      const want = p.shellLength / p.length;
      if (want < SHELL_MIN - 1e-9 || want > SHELL_MAX + 1e-9) w.push(`Shell length is kept between ${Math.round(SHELL_MIN * p.length)} and ${Math.round(SHELL_MAX * p.length)} mm for a ${Math.round(p.length)} mm foot, so it is ${Math.round(coverageEnd(p) * p.length)} mm, not ${Math.round(p.shellLength)} mm.`);
    }
    if (p.heelHole > 0) {
      const ho = heelOpening(p, makeOutline(p));
      if (!ho) w.push('There is no room for a heel opening here, so there is none. Set heel opening to 0 under Heel, move it with heel opening position, or check heel width under Your foot.');
      else if (ho.width < p.heelHole - 0.5) w.push(`The heel opening is ${n1(ho.width)} mm wide, not ${n1(p.heelHole)} mm: it keeps at least ${HOLE_SIDE} mm of shell round its sides and front and ${HOLE_BACK} mm behind it so the rim stays strong.`);
    }
    if (p.style !== 'solid' && p.shellThick < 2.5 && p.material !== 'tpu') {
      w.push(`A ${p.material.toUpperCase()} shell ${n1(p.shellThick)} mm thick can crack. Raise shell thickness to 2.5–3.5 mm under Print, or switch the material to TPU.`);
    }
    return w;
  }

  /* ---------- Measuring a design the way you would measure a real orthotic ---------- */
  // Heights are top-surface heights above the table. "Inner edge" is the arch side.
  function measureDesign(input, opts) {
    const p = sanitize(input), ol = makeOutline(p), hf = makeHeights(p, ol), L = p.length;
    const top = (x, y, m, l, d) => hf(x, y, m, l, d)[0];
    // Edge to edge across the whole outline (inner and outer bulges are at different points along it)
    let maxM = 0, maxL = 0;
    for (let i = 0; i <= 400; i++) {
      const [m, l] = ol.edges((ol.xe * i) / 400);
      if (m > maxM) maxM = m;
      if (l > maxL) maxL = l;
    }
    const maxWidth = maxM + maxL;
    const out = { length: ol.xe, maxWidth, heelWidth: p.heelWidth };
    if (opts && opts.widthOnly) return out;
    // Heel rim: the very back of the heel cup
    out.heelRim = top(0, 0, 0, 0, 0);
    // Heel seat: the middle of the heel, where the heel is widest
    const xs = Math.min(p.heelWidth / 2, 0.2 * L);
    const [ms, ls] = ol.edges(xs), ys = (ms - ls) / 2;
    out.heelSeat = top(xs, ys, ms, ls, Math.min(ms - ys, ys + ls));
    // Arch: height of the inner edge at the arch peak, and how far that is from the back of the heel
    const fae = Math.min(0.70, ol.xe / L - 0.01);
    const Bm = baseOf(p);
    const xa = Bm ? clamp(Bm.arch.peak_x + p.archAdjShift, 0, ol.xe) : clamp(p.archPeak / 100, 0.24, fae - 0.08) * L;
    out.archDist = xa;
    out.archTop = innerEdgeTop(p, xa);
    return out;
  }

  function innerEdgeTop(input, x) {
    const p = sanitize(input), ol = makeOutline(p), hf = makeHeights(p, ol);
    const xx = clamp(x, 0.5, ol.xe - 0.5);
    const [m, l] = ol.edges(xx);
    return hf(xx, m, m, l, 0)[0];
  }

  /* ---------- Converting measurements of an existing orthotic into settings ---------- */
  // meas: { coverage, style, length, maxWidth, heelWidth, heelSeat, heelRim, archTop, archDist,
  //         foreThick, padHeight, padDist, heelWedgeInner, heelWedgeOuter, heelWedgeWidth,
  //         foreWedgeInner, foreWedgeOuter, foreWedgeWidth }  (all lengths in mm)
  function fromOrthotic(meas, base) {
    const num = k => {
      const v = meas[k];
      if (v === '' || v == null) return null;
      const x = Number(v);
      return Number.isFinite(x) ? x : null;
    };
    const q = Object.assign({}, sanitize(base));
    q.shellLength = 0; q.shellWidth = 0; q.shellSlant = 0; // matching works back from the coverage's share of the foot
    if (COVERAGE_END[meas.coverage]) q.coverage = meas.coverage;
    if (meas.style === 'shell' || meas.style === 'solid' || meas.style === 'thin') q.style = meas.style;

    const Lo = num('length'), Wo = num('maxWidth');
    if (!(Lo > 0)) return { error: 'Enter the overall length of the orthotic (measurement 1).' };
    if (!(Wo > 0)) return { error: 'Enter the widest width of the orthotic (measurement 2).' };
    const raw = {};
    raw.length = q.length = Lo / COVERAGE_END[q.coverage];

    // Wedges (posts): angle from the thickness difference across the wedge
    const wedge = (i, o, w) => {
      const a = num(i), b = num(o), c = num(w);
      return a != null && b != null && c > 0 ? (Math.atan((a - b) / c) * 180) / Math.PI : 0;
    };
    raw.rearPost = q.rearPost = wedge('heelWedgeInner', 'heelWedgeOuter', 'heelWedgeWidth');
    raw.forePost = q.forePost = wedge('foreWedgeInner', 'foreWedgeOuter', 'foreWedgeWidth');

    // Outline: heel width as measured, ball width solved so the widest point matches
    const Ho = num('heelWidth');
    raw.heelWidth = q.heelWidth = Ho != null ? Ho : 0.66 * Wo;
    let lo = LIMITS.ballWidth[0], hi = LIMITS.ballWidth[1];
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (measureDesign(Object.assign({}, q, { ballWidth: mid }), { widthOnly: true }).maxWidth < Wo) lo = mid; else hi = mid;
    }
    q.ballWidth = (lo + hi) / 2;
    if (q.heelWidth > q.ballWidth * 0.95) q.heelWidth = q.ballWidth * 0.95;

    // Thickness from the heel seat height, less any separate heel lift and the rearfoot post under it
    const seat = num('heelSeat'), liftPad = Math.max(0, num('heelLift') || 0);
    q.heelLift = liftPad;
    if (seat != null) {
      const [tMin, tMax] = LIMITS.shellThick;
      const postAtSeat = measureDesign(Object.assign({}, q, { shellThick: tMin, heelLift: 0 })).heelSeat - tMin;
      const rest = seat - postAtSeat - liftPad;
      if (rest <= tMax) raw.shellThick = rest; else raw.thickOverflow = true;
      q.shellThick = clamp(rest, tMin, tMax);
      if (rest > tMax) q.heelLift = liftPad + (rest - tMax);
    }
    raw.heelLift = q.heelLift;
    const fore = num('foreThick');
    if (fore != null && q.coverage !== '3q') raw.foreThick = q.foreThick = fore;

    // Heel cup from the rim height
    const rim = num('heelRim');
    if (rim != null) {
      const noCup = measureDesign(Object.assign({}, q, { heelCup: 0 })).heelRim;
      raw.heelCup = q.heelCup = Math.max(0, rim - noCup);
    }

    // Arch: position from the distance, height solved so the inner-edge high point matches
    const ad = num('archDist');
    if (ad != null) raw.archPeak = q.archPeak = (ad / q.length) * 100;
    const at = num('archTop');
    if (at != null) {
      let a0 = LIMITS.archHeight[0], a1 = LIMITS.archHeight[1];
      const xAt = ad != null ? ad : measureDesign(q).archDist;
      const h = A => innerEdgeTop(Object.assign({}, q, { archHeight: A }), xAt);
      if (h(a1) < at) { q.archHeight = a1; raw.archHeight = a1 + (at - h(a1)); }
      else if (h(a0) >= at) { q.archHeight = 0; raw.archHeight = 0; }
      else {
        for (let i = 0; i < 40; i++) { const mid = (a0 + a1) / 2; if (h(mid) < at) a0 = mid; else a1 = mid; }
        raw.archHeight = q.archHeight = (a0 + a1) / 2;
      }
    }

    // Metatarsal pad
    const ph = num('padHeight'), pd = num('padDist');
    raw.metPad = q.metPad = ph != null && ph > 0 ? ph : 0;
    if (q.metPad > 0 && pd != null) raw.metPadPos = q.metPadPos = (pd / q.length) * 100;

    const params = sanitize(q);
    const notes = [];
    const label = {
      length: 'Foot length', heelWidth: 'Heel width', shellThick: 'Shell thickness', foreThick: 'Forefoot thickness',
      heelCup: 'Heel cup depth', archPeak: 'Arch peak position', archHeight: 'Arch height', metPad: 'Met pad height',
      metPadPos: 'Met pad position', rearPost: 'Rearfoot post', forePost: 'Forefoot post'
    };
    for (const k in raw) {
      if (!LIMITS[k]) continue;
      const [a, b] = LIMITS[k];
      if (raw[k] < a - 1e-6 || raw[k] > b + 1e-6) {
        notes.push(`${label[k] || k} works out at ${raw[k].toFixed(1)}, outside the tool's range of ${a}–${b}. It was set to ${params[k].toFixed(1)}.`);
      }
    }
    if (params.ballWidth >= LIMITS.ballWidth[1] - 0.01 || params.ballWidth <= LIMITS.ballWidth[0] + 0.01) {
      notes.push('The widest width is outside what this tool can draw. Check measurement 2.');
    }
    if (at != null && params.archHeight === 0 && raw.archHeight === 0) {
      notes.push('The arch high point is no higher than the base, so the arch was set to 0. Check measurement 6.');
    }
    if (raw.thickOverflow) notes.push(`The heel seat is thicker than ${LIMITS.shellThick[1]} mm, so the extra went into heel lift.`);
    return { params, notes };
  }

  root.OrthoGeom = { DEFAULTS, LIMITS, COVERAGE_END, coverageEnd, baseOf, build, toSTL, lengthFromShoeSize, warnings, sanitize, measureDesign, innerEdgeTop, fromOrthotic };
})(typeof window !== 'undefined' ? window : globalThis);
