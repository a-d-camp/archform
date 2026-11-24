"""Turn a Design into a closed, printable triangle mesh (thin shell) and write STL."""
from __future__ import annotations

import struct
from dataclasses import dataclass

import numpy as np
from scipy.spatial import Delaunay

from .geometry import Design

MAX_SLANT = 3.0  # on very steep walls, thicken the vertical offset by at most this factor (~70 degrees)


@dataclass
class Mesh:
    vertices: np.ndarray        # (n, 3)
    triangles: np.ndarray       # (m, 3), counter-clockwise seen from outside
    n_plan: int                 # vertices [0, n_plan) are the top surface, [n_plan, 2 n_plan) the underside
    n_top: int                  # number of top triangles (they come first)

    @property
    def volume(self) -> float:
        v = self.vertices[self.triangles]
        return float(np.einsum("ij,ij->i", v[:, 0], np.cross(v[:, 1], v[:, 2])).sum() / 6.0)


def _resample_ring(ring: np.ndarray, spacing: float) -> np.ndarray:
    closed = np.vstack([ring, ring[:1]])
    seg = np.linalg.norm(np.diff(closed, axis=0), axis=1)
    cum = np.concatenate([[0], np.cumsum(seg)])
    n = max(16, int(np.ceil(cum[-1] / spacing)))
    t = np.linspace(0, cum[-1], n, endpoint=False)
    return np.column_stack([np.interp(t, cum, closed[:, 0]), np.interp(t, cum, closed[:, 1])])


def _dist_to_ring(pts: np.ndarray, ring: np.ndarray) -> np.ndarray:
    a, b = ring, np.roll(ring, -1, axis=0)
    ab = b - a
    ap = pts[:, None, :] - a[None]
    t = np.clip((ap * ab[None]).sum(-1) / np.maximum((ab * ab).sum(-1), 1e-12)[None], 0, 1)
    d = ap - t[..., None] * ab[None]
    return np.sqrt((d * d).sum(-1)).min(axis=1)


def plan_triangulation(design: Design, spacing: float = 2.0):
    """Points and triangles covering the outline minus the opening; boundary edges are kept exactly."""
    outer = _resample_ring(design.outline.poly, spacing * 0.75)
    rings = [outer]
    if design.opening is not None:
        rings.append(design.opening.ring(spacing * 0.75))
    # triangular lattice inside, kept clear of the boundaries so they survive triangulation
    o = design.outline
    ys = np.arange(o._ymin.min() - spacing, o._ymax.max() + spacing, spacing * np.sqrt(3) / 2)
    pts = []
    for r, y in enumerate(ys):
        xs = np.arange(o.x0 + (spacing / 2 if r % 2 else 0), o.x1, spacing)
        pts.append(np.column_stack([xs, np.full_like(xs, y)]))
    lattice = np.vstack(pts)
    keep = design.outline.contains(lattice)
    if design.opening is not None:
        keep &= ~design.opening.inside(lattice[:, 0], lattice[:, 1])
    lattice = lattice[keep]
    clear = np.ones(len(lattice), bool)
    for ring in rings:
        clear &= _dist_to_ring(lattice, ring) > spacing * 0.6
    lattice = lattice[clear]

    for _ in range(8):
        bpts = np.vstack(rings)
        P = np.vstack([bpts, lattice])
        tri = Delaunay(P).simplices
        c = P[tri].mean(axis=1)
        ok = design.outline.contains(c)
        if design.opening is not None:
            ok &= ~design.opening.inside(c[:, 0], c[:, 1])
        tri = tri[ok]
        # every boundary segment must be an edge; split any that are missing and try again
        edges = set()
        for a, b, cc in tri:
            edges.update({(a, b), (b, a), (b, cc), (cc, b), (cc, a), (a, cc)})
        missing, start, new_rings = False, 0, []
        for ring in rings:
            n = len(ring)
            out = []
            for i in range(n):
                out.append(ring[i])
                if (start + i, start + (i + 1) % n) not in edges:
                    missing = True
                    out.append((ring[i] + ring[(i + 1) % n]) / 2)
            new_rings.append(np.array(out))
            start += n
        if not missing:
            break
        rings = new_rings
    else:
        raise RuntimeError("could not keep the outline edges in the triangulation")
    # counter-clockwise seen from above
    p = P[tri]
    area = (p[:, 1, 0] - p[:, 0, 0]) * (p[:, 2, 1] - p[:, 0, 1]) - (p[:, 2, 0] - p[:, 0, 0]) * (p[:, 1, 1] - p[:, 0, 1])
    tri[area < 0] = tri[area < 0][:, [0, 2, 1]]
    return P, tri


def build(design: Design, spacing: float = 2.0) -> Mesh:
    P, tri = plan_triangulation(design, spacing)
    x, y = P[:, 0], P[:, 1]
    top = design.top(x, y)
    # thin shell: the underside sits one thickness below the top, measured square to the surface
    h = 0.25
    gx = (design.top(x + h, y) - design.top(x - h, y)) / (2 * h)
    gy = (design.top(x, y + h) - design.top(x, y - h)) / (2 * h)
    slant = np.minimum(MAX_SLANT, np.sqrt(1 + gx * gx + gy * gy))
    bottom = np.maximum(0.0, top - design.thickness * slant)

    n = len(P)
    V = np.vstack([np.column_stack([x, y, top]), np.column_stack([x, y, bottom])])
    tris = [tri, tri[:, [0, 2, 1]] + n]
    # walls along every boundary edge of the top surface (outline and opening alike)
    directed = {}
    for a, b, c in tri:
        for u, w in ((a, b), (b, c), (c, a)):
            directed[(u, w)] = True
    walls = [(u + n, w + n, w, u + n, w, u) for (u, w) in directed if (w, u) not in directed]
    walls = np.array(walls, int).reshape(-1, 3)
    T = np.vstack(tris + [walls])
    if design.side == "left":
        V = V * np.array([1, -1, 1])
        T = T[:, [0, 2, 1]]
    return Mesh(V, T, n, len(tri))


def write_stl(mesh: Mesh, path, name: str = "orthotic") -> None:
    v = mesh.vertices[mesh.triangles].astype(np.float32)
    nrm = np.cross(v[:, 1] - v[:, 0], v[:, 2] - v[:, 0])
    nrm /= np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-12)
    with open(path, "wb") as f:
        f.write(name.encode()[:80].ljust(80, b"\0"))
        f.write(struct.pack("<I", len(v)))
        rec = np.zeros(len(v), dtype=[("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")])
        rec["n"], rec["v"] = nrm, v
        f.write(rec.tobytes())


def check(mesh: Mesh) -> list[str]:
    """Problems that would make the mesh unprintable; empty when it is fine."""
    problems = []
    T = mesh.triangles
    if (T[:, 0] == T[:, 1]).any() or (T[:, 1] == T[:, 2]).any() or (T[:, 0] == T[:, 2]).any():
        problems.append("degenerate triangle")
    from collections import Counter
    e = Counter()
    for a, b, c in T:
        e[(a, b)] += 1; e[(b, c)] += 1; e[(c, a)] += 1
    bad = [k for k, c in e.items() if c != 1 or e.get((k[1], k[0]), 0) != 1]
    if bad:
        problems.append(f"not watertight ({len(bad)} edges)")
    n = mesh.n_plan
    thin = mesh.vertices[:n, 2] - mesh.vertices[n:, 2]
    if thin.min() < 0.99:
        problems.append(f"thinner than 1 mm (min {thin.min():.2f})")
    if mesh.vertices[:, 2].min() < -1e-6:
        problems.append("below the floor")
    if mesh.volume <= 0:
        problems.append("non-positive volume")
    return problems
