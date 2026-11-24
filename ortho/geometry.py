"""Shape of an orthotic shell: a plan outline and one smooth top surface over it.

Coordinates (mm): x from the very back of the heel toward the toes, y across the foot with
+y toward the inner (medial, arch) side of a RIGHT foot, z up from the floor. A left foot is
the mirror image, made at export.

The top surface is a single bicubic B-spline over two parameters:
  s = how far along the shell, 0 at the heel back to 1 at the tip
  v = how far across at that point, 0 at the inner edge to 1 at the outer edge
Its control heights form a grid (stations along x, points across). A B-spline never leaves the
range of its control heights and is smooth everywhere, so the heel cup, arch and outer side
always join up as one surface.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from scipy.interpolate import BSpline, NdBSpline, splev, splprep

K = 3  # cubic


def clamped_knots(n: int) -> np.ndarray:
    """Knots for n control points of a clamped cubic B-spline on [0, 1] (uniform inside)."""
    inner = np.linspace(0.0, 1.0, n - K + 1)
    return np.concatenate([np.zeros(K), inner, np.ones(K)])



def knots_for(at) -> np.ndarray:
    """Clamped cubic knots whose control points sit as close as possible to the parameters `at`
    (increasing, from 0 to 1). Lets stations be closer together where the shape changes fast."""
    g = np.asarray(at, float)
    n = len(g)
    m = n - K - 1  # interior knots
    if m <= 0:
        return clamped_knots(n)
    # g_i = mean(t[i+1 : i+K+1]); solve for the interior knots by least squares
    A = np.zeros((n, m)); b = g.copy()
    for i in range(n):
        for j in range(i + 1, i + K + 1):
            if K + 1 <= j <= K + m:
                A[i, j - K - 1] += 1.0 / K
            elif j > K + m:
                b[i] -= 1.0 / K
    inner, *_ = np.linalg.lstsq(A, b, rcond=None)
    # keep them in order, inside (0, 1) and at least a little apart; fall back to even spacing
    inner = np.sort(np.clip(inner, 0.0, 1.0))
    gap = 0.2 / (m + 1)
    for i in range(m):
        inner[i] = max(inner[i], (inner[i - 1] if i else 0.0) + gap)
    if inner[-1] > 1 - gap:
        inner = np.linspace(0, 1, m + 2)[1:-1]
    return np.concatenate([np.zeros(K + 1), inner, np.ones(K + 1)])


def greville(t: np.ndarray, n: int) -> np.ndarray:
    """Where each control point 'sits' along the parameter: the average of its K inner knots."""
    return np.array([t[i + 1:i + K + 1].mean() for i in range(n)])


def basis(t: np.ndarray, n: int, u: np.ndarray, nu: int = 0) -> np.ndarray:
    """Matrix B[r, i] = value (or nu-th derivative) of basis function i at u[r]."""
    u = np.clip(np.asarray(u, float), 0.0, 1.0)
    B = np.zeros((u.size, n))
    for i in range(n):
        c = np.zeros(n)
        c[i] = 1.0
        b = BSpline(t, c, K, extrapolate=False)
        B[:, i] = np.nan_to_num((b.derivative(nu) if nu else b)(u))
    # the right end (u = 1) is excluded by BSpline's half-open intervals: take the limit
    at1 = u >= 1.0
    if at1.any() and nu == 0:
        B[at1] = 0.0
        B[at1, -1] = 1.0
    return B


def signed_area(poly: np.ndarray) -> float:
    x, y = poly[:, 0], poly[:, 1]
    return 0.5 * float(np.dot(x, np.roll(y, -1)) - np.dot(np.roll(x, -1), y))


class Outline:
    """A smooth closed plan outline through measured edge points.

    points: ordered round the outline (either direction), not repeated at the end.
    smoothing: scipy splprep smoothing; roughly (number of points) x (measurement error in mm)^2.
    """

    def __init__(self, points, smoothing: float = 0.0, samples: int = 900):
        P = np.asarray(points, float)
        closed = np.vstack([P, P[:1]])
        tck, _ = splprep([closed[:, 0], closed[:, 1]], s=smoothing, per=1)
        uu = np.linspace(0.0, 1.0, samples, endpoint=False)
        x, y = splev(uu, tck)
        poly = np.column_stack([x, y])
        if signed_area(poly) < 0:
            poly = poly[::-1]
        self.poly = poly
        self.x0, self.x1 = float(x.min()), float(x.max())
        self.length = self.x1 - self.x0
        # Table of the inner (max y) and outer (min y) edge at each x, for converting (x, y) <-> v
        self._xs = np.linspace(self.x0, self.x1, 4001)
        self._ymax, self._ymin = self._crossings(self._xs)

    def _crossings(self, xs: np.ndarray):
        a, b = self.poly, np.roll(self.poly, -1, axis=0)
        xa, ya, xb, yb = a[:, 0][None], a[:, 1][None], b[:, 0][None], b[:, 1][None]
        X = xs[:, None]
        lo, hi = np.minimum(xa, xb), np.maximum(xa, xb)
        hit = (X >= lo) & (X <= hi) & (hi > lo)
        t = np.where(hi > lo, (X - xa) / np.where(xb != xa, xb - xa, 1.0), 0.0)
        yy = np.where(hit, ya + t * (yb - ya), np.nan)
        ymax, ymin = np.nanmax(yy, axis=1), np.nanmin(yy, axis=1)
        # the very ends touch a single point: fall back to the nearest polygon vertex
        for arr, f in ((ymax, np.nanmax), (ymin, np.nanmin)):
            bad = ~np.isfinite(arr)
            if bad.any():
                for i in np.where(bad)[0]:
                    j = np.argmin(np.abs(self.poly[:, 0] - xs[i]))
                    arr[i] = self.poly[j, 1]
        return ymax, ymin

    def edges(self, x):
        """Inner (max y) and outer (min y) edge of the outline at x."""
        x = np.clip(np.asarray(x, float), self.x0, self.x1)
        return np.interp(x, self._xs, self._ymax), np.interp(x, self._xs, self._ymin)

    def to_sv(self, x, y):
        x = np.asarray(x, float)
        ym, yl = self.edges(x)
        w = np.maximum(ym - yl, 1e-9)
        s = (x - self.x0) / self.length
        v = (ym - np.asarray(y, float)) / w
        return np.clip(s, 0, 1), np.clip(v, 0, 1)

    def to_xy(self, s, v):
        x = self.x0 + np.asarray(s, float) * self.length
        ym, yl = self.edges(x)
        return x, ym - np.asarray(v, float) * (ym - yl)

    def contains(self, pts) -> np.ndarray:
        from matplotlib.path import Path as MPath
        return MPath(self.poly).contains_points(np.asarray(pts, float))


class Surface:
    """Bicubic B-spline height surface over (s, v) from a grid of control heights [station][across]."""

    def __init__(self, heights, s_at=None, v_at=None):
        C = np.asarray(heights, float)
        self.C = C
        self.ns, self.nv = C.shape
        self.ts = knots_for(s_at) if s_at is not None else clamped_knots(self.ns)
        self.tv = knots_for(v_at) if v_at is not None else clamped_knots(self.nv)
        self.s_at, self.v_at = greville(self.ts, self.ns), greville(self.tv, self.nv)
        self._spl = NdBSpline((self.ts, self.tv), C, K)

    def __call__(self, s, v, nu=(0, 0)):
        s, v = np.broadcast_arrays(np.clip(np.asarray(s, float), 0, 1), np.clip(np.asarray(v, float), 0, 1))
        pts = np.column_stack([s.ravel(), v.ravel()])
        return self._spl(pts, nu=nu).reshape(s.shape)

    def design_matrix(self, s, v) -> np.ndarray:
        """Rows map the flattened control grid (station-major) to surface heights at (s, v)."""
        Bs, Bv = basis(self.ts, self.ns, s), basis(self.tv, self.nv, v)
        return (Bs[:, :, None] * Bv[:, None, :]).reshape(len(Bs), -1)


@dataclass
class Opening:
    """A hole through the shell. center (x, y) mm; size = (width across, length along) mm.

    Without `fourier` it is an oval of that size. With `fourier` = [c0, a1, b1, a2, b2, ...] its edge is
    r(phi) = c0 + sum(a_k cos k*phi + b_k sin k*phi) mm from the centre, phi measured from +x (toward the
    toes) round toward +y (the inner side). That gives any smooth rounded shape, such as a tilted egg;
    `size` is then just its extent along and across the foot, for reference."""
    center: tuple
    size: tuple
    fourier: tuple | None = None

    def radius(self, phi) -> np.ndarray:
        phi = np.asarray(phi, float)
        if self.fourier is None:
            a, b = self.size[1] / 2, self.size[0] / 2
            return 1.0 / np.sqrt((np.cos(phi) / a) ** 2 + (np.sin(phi) / b) ** 2)
        c = self.fourier
        r = np.full_like(phi, c[0])
        for k in range(1, (len(c) - 1) // 2 + 1):
            r = r + c[2 * k - 1] * np.cos(k * phi) + c[2 * k] * np.sin(k * phi)
        return r

    def inside(self, x, y, grow: float = 0.0):
        dx, dy = np.asarray(x, float) - self.center[0], np.asarray(y, float) - self.center[1]
        return np.hypot(dx, dy) < self.radius(np.arctan2(dy, dx)) + grow

    def ring(self, spacing: float) -> np.ndarray:
        t = np.linspace(0, 2 * np.pi, 720, endpoint=False)
        r = self.radius(t)
        P = np.column_stack([self.center[0] + r * np.cos(t), self.center[1] + r * np.sin(t)])
        seg = np.linalg.norm(np.roll(P, -1, axis=0) - P, axis=1)
        n = max(24, int(np.ceil(seg.sum() / spacing)))
        at = np.concatenate([[0], np.cumsum(seg)])[:-1]
        tt = np.interp(np.linspace(0, seg.sum(), n, endpoint=False), at, t)   # even spacing along the edge
        r = self.radius(tt)
        return np.column_stack([self.center[0] + r * np.cos(tt), self.center[1] + r * np.sin(tt)])


@dataclass
class Design:
    name: str
    side: str
    thickness: float
    outline_points: list
    outline_smoothing: float
    heights: list
    opening: Opening | None = None
    stations_mm: list | None = None   # where the control rows sit along the shell (mm from the heel back)
    across: list | None = None        # where the control columns sit across (0 inner edge .. 1 outer edge)
    notes: str = ""
    meta: dict = field(default_factory=dict)

    @property
    def outline(self) -> Outline:
        if not hasattr(self, "_outline"):
            self._outline = Outline(self.outline_points, self.outline_smoothing)
        return self._outline

    @property
    def surface(self) -> Surface:
        if not hasattr(self, "_surface"):
            o = self.outline
            s_at = None
            if self.stations_mm is not None:
                st = np.asarray(self.stations_mm, float)
                s_at = (st - st[0]) / (st[-1] - st[0])   # stations are spread over the outline's full length
            v_at = None if self.across is None else np.asarray(self.across, float)
            self._surface = Surface(self.heights, s_at, v_at)
        return self._surface

    def top(self, x, y):
        """Top-surface height (mm) at plan points; never below the shell thickness."""
        s, v = self.outline.to_sv(x, y)
        return np.maximum(self.surface(s, v), self.thickness)

    # ---------- file format ----------
    @classmethod
    def load(cls, path) -> "Design":
        d = json.loads(Path(path).read_text())
        op = d.get("opening")
        return cls(
            name=d["name"], side=d.get("side", "right"), thickness=float(d["thickness"]),
            outline_points=d["outline"]["points"], outline_smoothing=float(d["outline"].get("smoothing", 0.0)),
            heights=d["surface"]["heights"],
            stations_mm=d["surface"].get("stations_mm"), across=d["surface"].get("across"),
            opening=Opening(tuple(op["center"]), tuple(op["size"]), tuple(op["fourier"]) if op.get("fourier") else None) if op else None,
            notes=d.get("notes", ""), meta=d.get("meta", {}),
        )

    def _opening_json(self):
        op = self.opening
        if op is None:
            return None
        d = {"center": list(op.center), "size": list(op.size)}
        if op.fourier is not None:
            d["fourier"] = [round(float(c), 3) for c in op.fourier]
            d["about"] = ("Hole: centre [x, y] mm; size [width across, length along] mm (for reference); its edge is "
                          "r(phi) = c0 + sum(a_k cos k phi + b_k sin k phi) mm from the centre, fourier = [c0, a1, b1, a2, b2, ...], "
                          "phi from +x (toes) toward +y (inner side).")
        else:
            d["about"] = "Oval hole: centre [x, y] mm, size [width across, length along] mm."
        return d

    def save(self, path) -> None:
        S = self.surface
        stations = self.stations_mm if self.stations_mm is not None else (self.outline.x0 + S.s_at * self.outline.length).round(1).tolist()
        d = {
            "name": self.name,
            "side": self.side,
            "notes": self.notes,
            "thickness": self.thickness,
            "outline": {
                "about": "Plan outline: [x, y] mm round the edge. x from the heel back, +y toward the inner (arch) side of a right foot.",
                "smoothing": self.outline_smoothing,
                "points": [[round(float(a), 2), round(float(b), 2)] for a, b in self.outline_points],
            },
            "opening": self._opening_json(),
            "surface": {
                "about": "Control heights (mm above the floor) of the top surface. One row per station from heel to tip; "
                         "in each row, from the inner edge across to the outer edge. Raising a number pulls the surface "
                         "up around that spot; the first and last rows are single points (heel back, tip), so keep each "
                         "of those rows at one value.",
                "stations_mm": stations,
                "across": [round(float(v), 3) for v in (self.across if self.across is not None else S.v_at)],
                "heights": [[round(float(h), 2) for h in row] for row in self.heights],
            },
            "meta": self.meta,
        }
        Path(path).write_text(json.dumps(d, indent=2) + "\n")
