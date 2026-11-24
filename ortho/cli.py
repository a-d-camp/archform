"""Command line.

  uv run ortho build designs/high-arch.json          # STL + overview picture + checks, into out/<name>/
  uv run ortho fit designs/high-arch.json my_points.json [--smooth 0.3]
                                                     # refit the control heights to the points, then build
  uv run ortho scan my_scan.stl designs/high-arch.json my_scan_points.json [--check points.json]
                                                     # scan (shell side up) -> fit points -> refit the design
  uv run ortho export designs/high-arch.json
                                                     # make the design the browser builder's shape
"""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np

from .fit import fit, load_points
from .geometry import Design
from .mesh import build, check, write_stl
from .render import overview


def _build(design: Design, out: Path, points=None) -> int:
    out.mkdir(parents=True, exist_ok=True)
    mesh = build(design)
    problems = check(mesh)
    stl = out / f"{design.name}-{design.side}.stl"
    write_stl(mesh, stl, design.name)
    overview(design, mesh, out / "overview.png", points)
    V, n = mesh.vertices, mesh.n_plan
    floor = (V[n:, 2] < 0.01).mean()
    o = design.outline
    print(f"{design.name} ({design.side}): {o.length:.1f} mm long, {np.ptp(o.poly[:, 1]):.1f} mm wide, "
          f"tallest {V[:, 2].max():.1f} mm, {mesh.volume / 1000:.1f} cm3, {len(mesh.triangles)} triangles")
    print(f"underside on the floor at {100 * floor:.0f}% of its points")
    print("checks:", "ok" if not problems else "; ".join(problems))
    print(f"wrote {stl} and {out / 'overview.png'}")
    return 1 if problems else 0


def _scan(a, design: Design, out: Path) -> int:
    import json
    from .geometry import Opening
    from .scan import isolate, level, load_stl, sample_points, upright
    V = load_stl(a.scan)
    xy, h = level(V)
    P, _ = isolate(xy, h)
    Y, outline, opening, mirrored = upright(P)
    o_old, op_old = design.outline, design.opening
    print(f"scan: {len(V)} points, {len(P)} on the shell; {'a LEFT shell, mirrored to a right one' if mirrored else 'a right shell'}")
    print(f"  length {np.ptp(Y[:, 0]):.1f} mm, width {np.ptp(Y[:, 1]):.1f} mm"
          + (f"; opening {opening[1][0]:.0f} wide x {opening[1][1]:.0f} long, centred {opening[0][0]:.0f} mm from the heel back" if opening else "; no opening found"))
    if op_old is not None and opening is not None:
        print(f"  (design had: opening {op_old.size[0]:.0f} x {op_old.size[1]:.0f}, centred {op_old.center[0]:.0f} mm)")
    if a.scan_outline:
        design.outline_points = outline.round(2).tolist()
        design.outline_smoothing = 20.0
        if hasattr(design, "_outline"):
            del design._outline
        if opening is not None:
            design.opening = Opening(*opening)
        ring = None
    else:
        from .scan import align_plan
        Y, ring, prms = align_plan(Y, outline, design)
        print(f"  lined up with the design outline in plan: {prms:.2f} mm (trimmed rms)")
    extra = [q for f in a.include for q in load_points(f)]
    pts = sample_points(Y, design, ring=ring) + extra
    rep = fit(design, pts, smooth=a.smooth)
    print(f"fit: {len(pts)} points, gap {rep['rms_all']:.2f} mm rms")
    Path(a.points_out).write_text(json.dumps({"about": f"Top-surface points sampled from {a.scan} (plastic underside + thickness). "
                                              "x, y mm (right foot, +y inner side), z mm above the floor.", "points": pts}, indent=1) + "\n")
    out.mkdir(parents=True, exist_ok=True)
    np.save(out / "scan_upright.npy", Y)
    if a.check:
        o = design.outline
        print("\ncheck against other measurements" + (" (these are also fitted)" if a.check in a.include else " (not fitted)") + ":")
        for p in load_points(a.check):
            x = p["x"]; y = p["y"] if "y" in p else o.to_xy((x - o.x0) / o.length, p["v"])[1]
            print(f"  x {x:6.1f}: measured {p['z']:5.1f}  scan model {float(design.top(x, y)):5.1f}  ({p['source']})")
    design.meta["fitted_to"] = a.points_out
    design.save(a.design)
    print(f"saved {a.points_out} and {a.design}")
    return _build(design, out, pts)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="ortho")
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="write the STL and an overview picture")
    b.add_argument("design")
    b.add_argument("--out", default=None)
    b.add_argument("--points", default=None, help="data points to draw on the pictures")
    f = sub.add_parser("fit", help="fit the control heights to data points, save, and build")
    f.add_argument("design")
    f.add_argument("points")
    f.add_argument("--smooth", type=float, default=0.3)
    f.add_argument("--out", default=None)
    sc = sub.add_parser("scan", help="turn a scan into fit points, refit the design to them, and build")
    sc.add_argument("scan")
    sc.add_argument("design")
    sc.add_argument("points_out")
    sc.add_argument("--check", default=None, help="measurements to compare against (not fitted)")
    sc.add_argument("--include", nargs="*", default=[], help="point files to fit together with the scan (e.g. hand measurements)")
    sc.add_argument("--scan-outline", action="store_true", help="replace the design's outline and opening with the scan's footprint")
    sc.add_argument("--smooth", type=float, default=0.05)
    sc.add_argument("--out", default=None)
    ex = sub.add_parser("export", help="write a design as the browser builder's shape")
    ex.add_argument("design")
    ex.add_argument("--to", default="builder/src/shape.js")
    a = ap.parse_args(argv)
    if a.cmd == "export":
        from .export import shape_record, write_shape
        write_shape(shape_record(Design.load(a.design)), a.to)
        print(f"wrote {a.to}")
        return 0

    design = Design.load(a.design)
    out = Path(a.out or Path("out") / design.name)
    if a.cmd == "build":
        return _build(design, out, load_points(a.points) if a.points else None)

    if a.cmd == "scan":
        return _scan(a, design, out)

    pts = load_points(a.points)
    rep = fit(design, pts, smooth=a.smooth)
    print(f"{'x':>6} {'v':>5} {'data':>6} {'model':>6} {'gap':>6}  source")
    for r in rep["rows"]:
        print(f"{r['x']:6.1f} {r['v']:5.2f} {r['measured']:6.1f} {r['model']:6.1f} {r['gap']:+6.1f}  "
              f"{'(guess) ' if r['weight'] < 1 else ''}{r['source']}")
    print(f"rms gap: measured points {rep['rms_measured']:.2f} mm, all points {rep['rms_all']:.2f} mm")
    design.save(a.design)
    print(f"saved {a.design}")
    return _build(design, out, pts)


if __name__ == "__main__":
    raise SystemExit(main())
