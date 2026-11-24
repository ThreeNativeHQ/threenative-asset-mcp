# PRD-916 structure check fixtures (B.2)

Downscaled copies of a **real paid run** of `texture_project_paint`, used to calibrate and pin the
invented-geometry check. The run itself (60 × 2048 px views, ~526 MB) is not in the repo: only these
128 px, name-free tiles travel, so the check is measured against what the image model actually
produced instead of against synthetic drawings.

## Provenance

- Run: `courtyard-mwubecio` under
  `sandbox/trompe-yard-prd916/.threenative/texture-projection/` (engine-side sandbox, not committed).
- Level: `assets/blockout/courtyard.glb` (the sample courtyard), view size 2048 px, atlas 8192 px,
  60 views (52 planned + 8 hole), model `or-klein` (FLUX 3 Klein through OpenRouter), run cost
  $0.54, 684 s. Style: weathered limestone, faded ochre lime plaster, terracotta, cobbles, mossy steps.
- Every view was rejected by the *old* check (`structureDeviation` 0.087–0.312 against a 0.05
  limit, coverage 0%) although the paintings keep the clay geometry. That calibration had only ever
  seen stub images; these fixtures replace it with the real pairs.
- Files: `real-gen.png` (generated images), `real-clay.png` (the clay each one was given),
  `real-geometry.png` (white = level geometry, black = sky), all 10 columns × 6 rows of 128 px tiles,
  view index = row-major tile index. `layout.json` names the layout.
- The sky mask is derived from the clay (overcast sky luminance ≥ 0.70) because the run stored no
  geometry buffer; in production the painter passes its real geometry mask and the check reduces it
  to cells by pixel majority. The check only uses the mask to skip cells, so this stand-in is
  equivalent for calibration.

## Synthetic inventions

`inventions-gen.png` / `inventions-clay.png`: four inventions pasted into four of the real
generations (one 128 px tile each, in order), with the real clay of that view beside them.

| index | kind | source view | shape (cells at 64 px) | contrast vs its surface |
|-------|------|-------------|------------------------|-------------------------|
| 0 | dark arched doorway on a wall | 11 | 7 × 14 arch | 0.356 |
| 1 | dark rectangular window | 33 | 8 × 9 | 0.430 |
| 2 | passage / void (arch) | 20 | 9 × 12 | 0.495 |
| 3 | added box (shadowed front, lit top) | 0 | 9 × 7 | 0.272 |

Each sits inside one clay surface with at least a one-cell margin, is at least 3% of that surface,
and is darker than anything the surface itself shows — the shape the check is meant to catch.

## Calibration (2026-11-23, this build)

`structureDeviation` scores a view in **luminance units**: the strongest compact, closed blob inside
one clay surface, weighted by its area share of that surface (full weight at 3%). Limit
`STRUCTURE_DEVIATION_LIMIT = 0.20`.

| set | score |
|-----|-------|
| the 60 real views (128 px tiles) | max 0.064 (view 43, a shadowed strip at a wall corner); views 5 and 19 follow at 0.059 and 0.029, the rest 0.000 |
| the 60 real views (256/1024/2048 px, direct from the run) | max 0.089 (views 5 and 43) — the fixtures do not flatter the metric |
| darkest real *near miss* when the compactness test is relaxed | 0.148 (an eave shadow under the roof tiles, fill 0.30) |
| inventions | box 0.270 / door 0.356 / window 0.431 / passage 0.495 |

**Margin: min rejected 0.270 / max accepted 0.064 = 4.2x** (0.270 / 0.089 = 3.0x at production
resolution). The limit is 2.2x above the strongest real view and 1.35x below the weakest invention.
What made the old check fire on every real view was comparing absolute luminance across the whole
frame: each repainted surface moved it by 0.1–0.3. Per surface, the real paintings deviate by at most
0.089, and only where a shadow or a darker stone sits at an edge.
