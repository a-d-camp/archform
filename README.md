# Archform

3D-printable arch-support shells for high arches, designed as one smooth spline surface. Start from the included high-arch baseline, or fit a design to a scan of an orthotic you already own. Then adjust it for your foot in a browser builder and print it.

The workflow: print, wear, adjust, print again.

## How a design works

A design (`designs/*.json`) is:

- **outline**: points round the edge in plan view, joined by a smooth closed curve.
  - x is mm from the very back of the heel; +y is toward the inner (arch) side of a right foot.
- **opening** (optional): a hole through the heel seat, so the heel pad rests on the shoe. Give it a centre and size for an oval, or add a Fourier series of its radius for any smooth rounded shape (the baseline's is a tilted egg).
- **surface**: one smooth top surface, set by a grid of control heights in mm above the floor.
  - One row per station along the shell (`stations_mm`). In each row, the heights run from the inner edge across to the outer edge (`across`, 0 to 1).
  - Raising a number lifts the surface around that spot, and the surface stays smooth.
  - The first and last rows are single points (heel back, tip), so each must hold one value.
- **thickness**: the shell is this thick everywhere (a thin shell). Its underside follows the top surface and rests on the floor only where the top is low.

Left-foot STLs are mirrored from the right-foot design.

## Commands

Needs [uv](https://docs.astral.sh/uv/) and Node.js.

```
uv run ortho build designs/high-arch.json       # STL, overview picture and checks, into out/high-arch/
uv run ortho fit designs/high-arch.json my_points.json --smooth 0.1
                                                # fit the control heights to measured points, then build
uv run ortho scan my_scan.stl designs/high-arch.json my_scan_points.json [--include extra_points.json]
                                                # fit the design to a 3D scan of a shell (see below)
uv run ortho export "designs/high-arch.json=High arch baseline"
                                                # hand designs to the browser builder (writes builder/src/bases.js)
uv run pytest -q                                # every design builds watertight on both feet; fitting works
```

### Fitting to a scan of your own orthotic

1. Scan the shell upside down (underside up) on a flat table with a phone 3D-scanning app, and export an STL.
2. Trace or measure its outline into a design's `outline` points, or pass `--scan-outline` to take the outline and opening from the scan.
3. Run `ortho scan`. It finds the table, isolates the shell, flips it upright, lines it up with the design outline, samples the top surface (underside plus thickness), and refits the control heights.
4. Optionally add hand measurements with `--include`, as points `{"x", "y" or "v", "z", "weight", "source"}`, to fill gaps the scan missed (usually the steep edges).

Fit points use v = 0 for the inner edge and 1 for the outer edge at that x. Weight 1 means measured; lower weights mark guesses.

## Adjusting in the browser builder

`tools/builder.sh` rebuilds the builder and opens it. Under **Start from**, choose *High arch baseline*. The builder draws exactly the exported surface (it matches the Python model to 0.01 mm), and these sliders adjust it:

- **Arch height change** (mm): largest at the inner edge under the peak, fading smoothly along and across.
- **Arch position change** (mm toward the toes or heel).
- **Arch length change** (%).
- **How far across an arch change reaches** (%).
- **Outer side change** (mm).
- **Heel cup change** (mm).

At zero you get the baseline. The changes are saved in the settings file as offsets from the base, so they survive a refit: run `ortho export` again, then reload the builder. **Print → Base** is set to *Thin shell*; print with supports under the heel cup and arch.

The builder also keeps its original measurement-driven mode (*My measurements*), which builds a shell from foot measurements alone.

`out/<name>/overview.png` shows:

- a top-view height map, with the control stations and data points
- the inner edge, outer edge and middle along the shell, against the data
- cross-sections seen from the front
- two 3D views

## Where things are

- `ortho/`: the Python code (geometry, fit, scan processing, mesh/STL, pictures, CLI).
- `designs/`: designs. `high-arch.json` is the baseline.
- `builder/`: the browser builder, extended to adjust fitted base shapes. Forked from [Orthotics Builder](https://github.com/markusg1234/Orthotics-builder) by markusg1234 (MIT licence; see `builder/LICENSE`). Archform is an independent project and isn't affiliated with or endorsed by the original author.
- `tools/`: builder launcher, profile tools, and the sensor-layout generator.
- `hardware/`: plan for a pressure-sensing insole to compare prototypes (work in progress).

## Disclaimer

This is a hobby project, not medical advice or a medical device. If you have foot pain or a foot condition, see a podiatrist.

## Licence

MIT. See [LICENSE](LICENSE). The browser builder is derived from [Orthotics Builder](https://github.com/markusg1234/Orthotics-builder), copyright (c) 2026 markusg1234, also MIT; its notice is kept in [builder/LICENSE](builder/LICENSE).
