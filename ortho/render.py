"""Pictures of a design for checking by eye: top-view height map, edge profiles, cross-sections, 3D."""
from __future__ import annotations

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.tri import Triangulation

from .geometry import Design
from .mesh import Mesh


def overview(design: Design, mesh: Mesh, path, points=None, sections=None) -> None:
    o, S = design.outline, design.surface
    n = mesh.n_plan
    V = mesh.vertices * (np.array([1, -1, 1]) if design.side == "left" else 1)  # draw as a right foot
    top_tri = mesh.triangles[:mesh.n_top]
    if design.side == "left":
        top_tri = top_tri[:, [0, 2, 1]]
    fig = plt.figure(figsize=(15, 10.5), constrained_layout=True)
    gs = fig.add_gridspec(2, 3)

    # 1. top view, height colours, control stations
    ax = fig.add_subplot(gs[:, 0])
    t = Triangulation(V[:n, 1], V[:n, 0], top_tri)
    cf = ax.tricontourf(t, V[:n, 2], levels=np.arange(0, V[:n, 2].max() + 2, 2), cmap="viridis")
    ax.tricontour(t, V[:n, 2], levels=np.arange(0, V[:n, 2].max() + 2, 2), colors="k", linewidths=0.3)
    ax.plot(np.r_[o.poly[:, 1], o.poly[0, 1]], np.r_[o.poly[:, 0], o.poly[0, 0]], "k-", lw=1.2)
    for st in S.s_at:
        x = o.x0 + st * o.length
        ym, yl = o.edges(x)
        ax.plot([ym, yl], [x, x], color="w", lw=0.6, alpha=0.7)
    if points:
        for p in points:
            x = p["x"]
            y = p["y"] if "y" in p else o.to_xy((x - o.x0) / o.length, p["v"])[1]
            ax.plot(y, x, "o", ms=4, mfc="r" if p.get("weight", 1) >= 1 else "none", mec="r")
    ax.set_aspect("equal"); ax.invert_xaxis()
    ax.set_xlabel("inner side  <-  y (mm)  ->  outer side"); ax.set_ylabel("x from heel back (mm)")
    ax.set_title(f"{design.name}: top surface (mm)\nwhite lines = control stations; red = data (hollow = guess)")
    fig.colorbar(cf, ax=ax, shrink=0.6)

    # 2. edge profiles along the length
    ax = fig.add_subplot(gs[0, 1])
    xs = np.linspace(o.x0, o.x1, 400)
    for v, name, col in ((0.0, "inner edge", "C0"), (1.0, "outer edge", "C1"), (0.5, "middle", "C2")):
        _, y = o.to_xy((xs - o.x0) / o.length, v)
        ax.plot(xs, design.top(xs, y), col, label=name)
    if points:
        for p in points:
            v = p.get("v")
            if v is None:
                continue
            col = "C0" if v <= 0.01 else "C1" if v >= 0.99 else "C2" if abs(v - 0.5) < 0.01 else "0.5"
            ax.plot(p["x"], p["z"], "o", ms=5, mfc=col if p.get("weight", 1) >= 1 else "none", mec=col)
    ax.set_xlabel("x from heel back (mm)"); ax.set_ylabel("height (mm)"); ax.set_title("Heights along the shell (dots = data, hollow = guess)")
    ax.grid(alpha=0.3); ax.legend(fontsize=8)

    # 3. cross-sections, seen from the front (inner side on the left)
    ax = fig.add_subplot(gs[0, 2])
    sections = sections or [20, 45, 80, 110, 140, 160]
    for i, x in enumerate(sections):
        if not (o.x0 < x < o.x1):
            continue
        ym, yl = o.edges(x)
        ys = np.linspace(ym, yl, 120)
        z = design.top(np.full_like(ys, x), ys)
        hole = design.opening.inside(np.full_like(ys, x), ys) if design.opening else np.zeros_like(ys, bool)
        z = np.where(hole, np.nan, z)
        ax.plot(-ys, z, color=plt.cm.plasma(i / max(1, len(sections) - 1)), label=f"{x:.0f} mm")
    ax.set_xlabel("inner side  <-  across (mm)  ->  outer side"); ax.set_ylabel("height (mm)")
    ax.set_title("Cross-sections from the front, top surface (gaps = opening)"); ax.grid(alpha=0.3); ax.legend(fontsize=8)

    # 4. 3D
    for k, (el, az) in enumerate(((22, -60), (18, 120))):
        ax = fig.add_subplot(gs[1, 1 + k], projection="3d")
        ax.plot_trisurf(V[:n, 0], V[:n, 1], V[:n, 2], triangles=top_tri, cmap="viridis", linewidth=0, antialiased=True)
        bt = mesh.triangles[mesh.n_top:2 * mesh.n_top] - n
        if design.side == "left":
            bt = bt[:, [0, 2, 1]]
        ax.plot_trisurf(V[n:, 0], V[n:, 1], V[n:, 2], triangles=bt, color="0.6", alpha=0.35, linewidth=0)
        ax.set_box_aspect((np.ptp(V[:, 0]), np.ptp(V[:, 1]), np.ptp(V[:, 2]) * 1.0))
        ax.view_init(el, az); ax.set_title("from the inner side" if k == 0 else "from the outer side")
        ax.set_xlabel("x"); ax.set_ylabel("y"); ax.set_zlabel("z")
    fig.savefig(path, dpi=110)
    plt.close(fig)
