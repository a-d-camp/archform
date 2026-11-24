"""Turn a phone scan of a shell (scanned upside down, plastic side up) into surface fit points.

Steps: load the mesh, find the floor (the biggest flat plane) and level it, keep the object that
stands off the floor, drop floating specks, flip it right way up, align it to the design's
underside (trying both the same foot and the mirror image), then sample the plastic's
underside on a grid and convert to top-surface heights (top = underside + thickness, measured
square to the surface).
"""
from __future__ import annotations

import struct
from pathlib import Path

import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree

from .geometry import Design
from .mesh import build


def load_stl(path) -> np.ndarray:
    """Unique vertices of an STL (binary or ASCII), in mm (metre files are scaled up)."""
    b = Path(path).read_bytes()
    n = struct.unpack("<I", b[80:84])[0] if len(b) >= 84 else 0
    if len(b) == 84 + 50 * n:
        V = np.frombuffer(b[84:84 + 50 * n], dtype=[("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")])["v"].reshape(-1, 3)
    else:
        V = np.array([[float(t) for t in line.split()[1:4]] for line in b.decode(errors="ignore").splitlines()
                      if line.strip().startswith("vertex")])
    V = V.astype(float)
    if np.ptp(V, axis=0).max() < 5.0:   # metres
        V *= 1000.0
    return np.unique(V.round(3), axis=0)


def level(V: np.ndarray, tol: float = 1.0, iters: int = 400, seed: int = 0):
    """Find the floor plane (most points within tol); return (plan xy, height above floor)."""
    rng = np.random.default_rng(seed)
    best, best_n = None, -1
    sample = V[rng.choice(len(V), min(len(V), 60000), replace=False)]
    for _ in range(iters):
        a, b, c = sample[rng.choice(len(sample), 3, replace=False)]
        nrm = np.cross(b - a, c - a)
        if np.linalg.norm(nrm) < 1e-9:
            continue
        nrm /= np.linalg.norm(nrm)
        k = (np.abs((sample - a) @ nrm) < tol).sum()
        if k > best_n:
            best, best_n = (a, nrm), k
    a, nrm = best
    for _ in range(5):  # refine on the inliers
        inl = V[np.abs((V - a) @ nrm) < tol]
        c = inl.mean(0)
        _, _, vt = np.linalg.svd(inl - c, full_matrices=False)
        a, nrm = c, vt[-1]
    h = (V - a) @ nrm
    if np.median(h) < 0 or (h > 3).sum() < (h < -3).sum():  # most of the object should be above the floor
        nrm, h = -nrm, -h
    e1 = np.cross(nrm, [1.0, 0, 0] if abs(nrm[0]) < 0.9 else [0, 1.0, 0]); e1 /= np.linalg.norm(e1)
    e2 = np.cross(nrm, e1)
    return np.column_stack([(V - a) @ e1, (V - a) @ e2]), h


def isolate(xy: np.ndarray, h: np.ndarray, above: float = 1.5, contact: float = 0.8, cell: float = 2.0):
    """Points of the largest object standing above the floor, with floating specks removed.
    The object is found from points over `above` mm; then everything over `contact` mm within its
    footprint is kept, so edges that rested on the table (rims, flange tops) are not lost."""
    up = h > above
    lo = xy[up].min(0)
    ij = np.floor((xy[up] - lo) / cell).astype(int)
    grid = np.zeros(ij.max(0) + 1, bool)
    grid[ij[:, 0], ij[:, 1]] = True
    grid = ndimage.binary_closing(grid, iterations=1)
    lab, nlab = ndimage.label(grid)
    sizes = ndimage.sum(grid, lab, range(1, nlab + 1))
    main = lab == (1 + int(np.argmax(sizes)))
    # the opening: floor-level region enclosed by the object
    filled = ndimage.binary_fill_holes(main)
    holes = filled & ~main
    # keep points over `contact` mm round the object's outer edge (grown by one cell), but not round
    # the opening, whose floor would otherwise turn into false high spots once the shell is flipped
    foot = ndimage.binary_dilation(main, iterations=1) & ~ndimage.binary_dilation(holes, iterations=2)
    near = h > contact
    ij2 = np.floor((xy - lo) / cell).astype(int)
    inb = (ij2 >= 0).all(1) & (ij2[:, 0] < foot.shape[0]) & (ij2[:, 1] < foot.shape[1])
    sel = np.zeros(len(h), bool)
    sel[inb] = foot[ij2[inb, 0], ij2[inb, 1]]
    in_main = np.zeros(len(h), bool)
    in_main[inb] = main[ij2[inb, 0], ij2[inb, 1]]
    keep_idx = np.where((near & sel) | (up & in_main))[0]
    P = np.column_stack([xy[keep_idx], h[keep_idx]])
    # specks: far from the median height of their plan neighbours
    tree = cKDTree(P[:, :2])
    nb = tree.query_ball_point(P[:, :2], r=3.0)
    med = np.array([np.median(P[i, 2]) for i in nb])
    cnt = np.array([len(i) for i in nb])
    ok = (np.abs(P[:, 2] - med) < 2.0) & (cnt >= 6)
    hl, hn = ndimage.label(holes)
    hole_xy = None
    if hn:
        hs = ndimage.sum(holes, hl, range(1, hn + 1))
        k = 1 + int(np.argmax(hs))
        if hs[k - 1] * cell * cell > 200:  # mm^2: a real opening, not a gap in the scan
            ii = np.argwhere(hl == k)
            hole_xy = lo + (ii.mean(0) + 0.5) * cell
    return P[ok], hole_xy


def upright(P: np.ndarray, cell: float = 1.0):
    """Turn the upside-down scan right way up in design coordinates, from the scan alone.

    x runs along the shell from the very back of the heel, y across with +y toward the inner (arch)
    side of a right foot, z up from the plane the shell rests on. A left shell comes out mirrored
    to a right one. Returns (points, outline points, opening (center, size) or None, mirrored).
    """
    from scipy.optimize import linprog
    import contourpy
    # long axis of the footprint; flip over about it (a rotation: across and up both reverse)
    c = P[:, :2].mean(0)
    _, U = np.linalg.eigh(np.cov((P[:, :2] - c).T))
    ax = U[:, 1]
    perp = np.array([-ax[1], ax[0]])
    a, b = (P[:, :2] - c) @ ax, (P[:, :2] - c) @ perp
    Q = np.column_stack([a, -b, -P[:, 2]])
    # the plane it rests on: the supporting plane under its centre (maximise the plane's height there)
    A = np.column_stack([Q[:, 0], Q[:, 1], np.ones(len(Q))])
    res = linprog(c=-A.mean(0), A_ub=A, b_ub=Q[:, 2], bounds=[(None, None)] * 3, method="highs")
    Q[:, 2] -= A @ res.x
    # footprint mask, opening and outline
    lo = Q[:, :2].min(0) - 3 * cell
    ij = np.floor((Q[:, :2] - lo) / cell).astype(int)
    g = np.zeros(ij.max(0) + 4, bool)
    g[ij[:, 0], ij[:, 1]] = True
    g = ndimage.binary_closing(g, iterations=2)
    solid = ndimage.binary_fill_holes(g)
    lab, n = ndimage.label(solid)
    solid = lab == (1 + int(np.argmax(ndimage.sum(solid, lab, range(1, n + 1)))))
    holes = solid & ~g
    hl, hn = ndimage.label(holes)
    hole_cells = None
    if hn:
        hs = ndimage.sum(holes, hl, range(1, hn + 1))
        k = 1 + int(np.argmax(hs))
        if hs[k - 1] * cell * cell > 200:
            hole_cells = (np.argwhere(hl == k) + 0.5) * cell + lo
    # +x from the heel: the opening is in the heel half
    end_sign = 1.0
    if hole_cells is not None and hole_cells[:, 0].mean() > 0:
        end_sign = -1.0
    Q[:, 0] *= end_sign; Q[:, 1] *= end_sign       # turning end for end is a rotation about z
    if hole_cells is not None:
        hole_cells = hole_cells * end_sign
    # +y = inner side: the arch flange is the higher long edge through the middle of the shell
    x0 = Q[:, 0].min(); Q[:, 0] -= x0
    if hole_cells is not None:
        hole_cells[:, 0] -= x0
    L = Q[:, 0].max()
    mid = (Q[:, 0] > 0.5 * L) & (Q[:, 0] < 0.8 * L)
    mirrored = np.median(Q[mid & (Q[:, 1] > 0), 2]) < np.median(Q[mid & (Q[:, 1] < 0), 2])
    if mirrored:  # the inner side came out on -y: this is the other foot; mirror it to a right one
        Q[:, 1] *= -1
        if hole_cells is not None:
            hole_cells[:, 1] *= -1
    # outline from the footprint boundary, resampled evenly
    lo = Q[:, :2].min(0) - 3 * cell
    ij = np.floor((Q[:, :2] - lo) / cell).astype(int)
    g = np.zeros(ij.max(0) + 4, bool)
    g[ij[:, 0], ij[:, 1]] = True
    solid = ndimage.binary_fill_holes(ndimage.binary_closing(g, iterations=2))
    lines = contourpy.contour_generator(z=solid.astype(float).T).lines(0.5)
    ring = max(lines, key=len) * cell + lo  # contour of the transposed mask comes back as (i, j) = (x, y) cells
    seg = np.linalg.norm(np.diff(ring, axis=0), axis=1)
    cum = np.concatenate([[0], np.cumsum(seg)])
    t = np.linspace(0, cum[-1], 72, endpoint=False)
    outline = np.column_stack([np.interp(t, cum, ring[:, 0]), np.interp(t, cum, ring[:, 1])])
    opening = None
    if hole_cells is not None:
        ctr = hole_cells.mean(0)
        ev, evec = np.linalg.eigh(np.cov((hole_cells - ctr).T))
        semi = 2 * np.sqrt(ev)                       # a filled ellipse's semi-axes from its spread
        along = abs(evec[0, 1]) > abs(evec[1, 1])    # is the long axis along x?
        opening = (tuple(ctr.round(1)), (round(float(semi[0] * 2), 1), round(float(semi[1] * 2), 1)) if along
                   else (round(float(semi[1] * 2), 1), round(float(semi[0] * 2), 1)))
    return Q, outline, opening, bool(mirrored)


def align_plan(Y: np.ndarray, ring: np.ndarray, design: Design, iters: int = 60, trim: float = 0.7):
    """Rotate/shift the upright scan in plan so its footprint edge sits on the design's outline.
    Trimmed, so a border of foam round part of the scan does not pull it off. Returns (Y, ring, rms)."""
    target = design.outline.poly
    tree = cKDTree(target)
    R, t = np.eye(2), np.zeros(2)
    for _ in range(iters):
        A = ring @ R.T + t
        dist, idx = tree.query(A)
        k = dist <= np.quantile(dist, trim)
        a, b = A[k], target[idx[k]]
        ca, cb = a.mean(0), b.mean(0)
        U, _, Vt = np.linalg.svd((a - ca).T @ (b - cb))
        D = np.diag([1, np.sign(np.linalg.det(Vt.T @ U.T))])
        dR = Vt.T @ D @ U.T
        R, t = dR @ R, dR @ t + cb - dR @ ca
    dist, _ = tree.query(ring @ R.T + t)
    rms = float(np.sqrt(np.mean(np.sort(dist ** 2)[: int(trim * len(dist))])))
    Y2 = Y.copy()
    Y2[:, :2] = Y[:, :2] @ R.T + t
    return Y2, ring @ R.T + t, rms


def sample_points(Y: np.ndarray, design: Design, spacing: float = 4.0, edge: float = 1.5, radius: float = 2.0,
                  ring: np.ndarray | None = None, band: float = 4.0):
    """Top-surface fit points from the upright scan underside, on a grid inside the outline.

    The top of the plastic is one thickness from the underside along the surface normal, so on a
    steep wall it sits beside the underside point rather than above it. Grid points within `band` mm
    of the scan's own edge are skipped: that is where a border of the foam cover shows."""
    o = design.outline
    tree = cKDTree(Y[:, :2])
    ring_tree = cKDTree(ring) if ring is not None else None
    t = design.thickness
    pts = []
    for x in np.arange(o.x0 + edge, o.x1 - edge + 1e-9, spacing):
        ym, yl = o.edges(x)
        for y in np.arange(yl + edge, ym - edge + 1e-9, spacing):
            if design.opening is not None and design.opening.inside(x, y, grow=edge):
                continue
            if ring_tree is not None and ring_tree.query([x, y])[0] < band:
                continue
            idx = tree.query_ball_point([x, y], r=radius)
            if len(idx) < 8:
                continue
            L = Y[idx]
            A = np.column_stack([L[:, 0] - x, L[:, 1] - y, np.ones(len(L))])
            (gx, gy, z0), *_ = np.linalg.lstsq(A, L[:, 2], rcond=None)   # local plane: height and slope
            n = np.array([-gx, -gy, 1.0]); n /= np.linalg.norm(n)
            px, py, pz = np.array([x, y, z0]) + t * n
            if not o.contains([[px, py]])[0]:
                continue
            pts.append({"x": round(float(px), 1), "y": round(float(py), 1), "z": round(float(pz), 2),
                        "weight": 1.0, "source": "scan"})
    return pts
