"""Fit a design's control heights to measured (and, where unmeasured, guessed) surface points.

Data file (JSON):
  {"points": [{"x": mm, "v": 0..1 or "y": mm, "z": mm, "weight": 1.0, "source": "..."}, ...]}
v = 0 is the inner edge, 1 the outer edge, at that x. Points inside the opening are ignored.

Least squares on the control grid, plus a smoothness penalty (second differences along and across)
so areas without data take the smoothest shape the data allow. The heel-back and tip rows are
each tied to a single height, since those ends of the outline are single points.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from .geometry import Design, Surface


def load_points(path):
    return json.loads(Path(path).read_text())["points"]


def _second_diff(n: int) -> np.ndarray:
    D = np.zeros((max(n - 2, 0), n))
    for i in range(n - 2):
        D[i, i:i + 3] = (1, -2, 1)
    return D


def fit(design: Design, points, smooth: float = 0.3) -> dict:
    """Refit design.heights in place to the points; returns a report of the gaps.
    The grid size and positions come from the design's stations_mm and across."""
    ns, nv = len(design.stations_mm or design.heights), len(design.across or design.heights[0])
    design.heights = np.zeros((ns, nv)).tolist()
    if hasattr(design, "_surface"):
        del design._surface
    S = design.surface
    o = design.outline

    xs, vs, zs, ws, src = [], [], [], [], []
    for p in points:
        x = float(p["x"])
        if "v" in p:
            v = float(p["v"])
            _, y = o.to_xy((x - o.x0) / o.length, v)
        else:
            y = float(p["y"])
            _, v = o.to_sv(x, y)
        if design.opening is not None and design.opening.inside(x, y):
            continue
        xs.append(x); vs.append(float(v)); zs.append(float(p["z"])); ws.append(float(p.get("weight", 1.0)))
        src.append(p.get("source", ""))
    s = (np.array(xs) - o.x0) / o.length
    A = S.design_matrix(s, np.array(vs))
    W = np.sqrt(np.array(ws))[:, None]

    # parameters: one height for the heel-back row, free interior rows, one height for the tip row
    nfree = (ns - 2) * nv
    M = np.zeros((ns * nv, nfree + 2))
    M[0:nv, 0] = 1.0
    for k in range(nfree):
        M[nv + k, 1 + k] = 1.0
    M[(ns - 1) * nv:, -1] = 1.0

    Ds = np.kron(_second_diff(ns), np.eye(nv))
    Dv = np.kron(np.eye(ns), _second_diff(nv))
    lam = smooth * max(1.0, float(np.sum(ws)) / (ns * nv))
    lhs = np.vstack([W * (A @ M), np.sqrt(lam) * (Ds @ M), np.sqrt(lam) * (Dv @ M)])
    rhs = np.concatenate([W[:, 0] * np.array(zs), np.zeros(len(Ds) + len(Dv))])
    p, *_ = np.linalg.lstsq(lhs, rhs, rcond=None)
    C = (M @ p).reshape(ns, nv)

    design.heights = C.tolist()
    for attr in ("_surface",):
        if hasattr(design, attr):
            delattr(design, attr)
    model = design.surface(s, np.array(vs))
    gaps = model - np.array(zs)
    return {
        "rows": [dict(x=round(x, 1), v=round(v, 2), measured=z, model=round(float(m), 2), gap=round(float(g), 2), weight=w, source=sr)
                 for x, v, z, m, g, w, sr in zip(xs, vs, zs, model, gaps, ws, src)],
        "rms_measured": float(np.sqrt(np.mean([g * g for g, w in zip(gaps, ws) if w >= 1.0]) if any(w >= 1.0 for w in ws) else 0.0)),
        "rms_all": float(np.sqrt(np.mean(gaps ** 2))),
    }
