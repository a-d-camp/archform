"""Checks that every design builds into a printable mesh, and that fitting recovers a known surface."""
import json
from pathlib import Path

import numpy as np
import pytest

from ortho.fit import fit
from ortho.geometry import Design, Opening
from ortho.mesh import build, check

ROOT = Path(__file__).resolve().parents[1]
DESIGNS = sorted((ROOT / "designs").glob("*.json"))


@pytest.mark.parametrize("path", DESIGNS, ids=[p.stem for p in DESIGNS])
@pytest.mark.parametrize("side", ["right", "left"])
def test_designs_build_clean(path, side):
    d = Design.load(path)
    d.side = side
    m = build(d)
    assert check(m) == []
    # top triangles face up (no folds), on both feet once mirrored back
    V = m.vertices * (np.array([1, -1, 1]) if side == "left" else 1)
    t = m.triangles[: m.n_top][:, [0, 2, 1]] if side == "left" else m.triangles[: m.n_top]
    p = V[t]
    area = (p[:, 1, 0] - p[:, 0, 0]) * (p[:, 2, 1] - p[:, 0, 1]) - (p[:, 2, 0] - p[:, 0, 0]) * (p[:, 1, 1] - p[:, 0, 1])
    assert (area > 0).all()


def _simple(opening=True):
    pts = [[0, 0], [5, -18], [40, -28], [120, -35], [150, -20], [160, 0], [150, 20], [80, 25], [20, 22], [5, 15]]
    return Design(name="t", side="right", thickness=2.5, outline_points=pts, outline_smoothing=2,
                  heights=[[8.0] * 5 for _ in range(8)],
                  opening=Opening((40, -3), (25, 34)) if opening else None,
                  stations_mm=[0, 10, 30, 55, 80, 105, 135, 160], across=[0, 0.2, 0.5, 0.8, 1.0])


@pytest.mark.parametrize("opening", [True, False])
def test_simple_shapes_build(opening):
    d = _simple(opening)
    m = build(d)
    assert check(m) == []
    assert m.volume > 0


def test_fit_recovers_a_smooth_surface():
    d = _simple(opening=False)
    truth = lambda x, v: 3 + 12 * np.exp(-((x - 80) / 40) ** 2) * (1 - v) ** 1.5 + 4 * v * np.exp(-((x - 90) / 50) ** 2)
    pts = [{"x": float(x), "v": float(v), "z": float(truth(x, v))}
           for x in np.linspace(5, 155, 16) for v in np.linspace(0, 1, 6)]
    rep = fit(d, pts, smooth=0.01)
    assert rep["rms_all"] < 0.4
