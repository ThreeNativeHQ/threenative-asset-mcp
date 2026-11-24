# PRD-916 silhouette check fixtures (phase 2g)

Downscaled copies of a **real paid run** of `texture_project_paint`, used to calibrate and pin the
check that rejects a view painting solid surface where the clay shows sky. The run itself
(40 × 2048 px views) is not in the repo: only these 128 px, name-free tiles travel.

## Provenance

- Run: `courtyard-mwuijnnl` under `sandbox/trompe-yard-prd916/.threenative/texture-projection/`
  (engine-side sandbox, not committed). Level `assets/blockout/courtyard.glb`, view size 2048 px,
  40 views (34 ground, 6 aerial), model `or-klein` (FLUX 3 Klein through OpenRouter).
- Files: `gen.png` (generated images), `clay.png` (the clay each one was given),
  `geometry-cells.png` (white = the cell is not clay sky, black = it is), 8 columns × 5 rows of
  128 px tiles, view index = row-major tile index. `layout.json` names the layout.
- `geometry-cells.png` is one pixel per cell of the check's own 64×64 grid, already carrying the
  production sky decision: a cell is clay sky when at least 98 % of its pixels is outside the geometry
  mask. The run did not store the geometry buffer, so the mask was derived from the clay's flat clear
  colour, which is exact (see the phase 2g report under `~/.cache/tmp-tn/prd916/`); in production
  `judgeView` passes the real `masks.geometry` and the same decision is taken per pixel.
- The fixtures hold the **raw** generation; production judges the colour-corrected one. Same caveat as
  the structure fixtures, and the split is identical at 2048 px on the stored images.

## Labels and calibration (2026-11-24, this build)

The 13/27 split was settled by looking at the pixels, not at the generation alone: the defect is
visible in `gen.png` where the clay's backdrop was empty (a wall top raised over it, a new coping,
cobbles where the level has no ground).

| set | views | score |
|-----|-------|-------|
| clean | the other 27 (19 is clean: its light area is a lit wall, only 1.8 % of the frame is background) | max 0.135 (view 32), 11 of them 0.000 |
| paints over sky | 11, 13, 14, 17, 18, 20, 22, 24, 30, 31, 33, 36, 37 | min 0.439 (view 33), 1.000 for 11/14/17/18/20/24/36/37 |

**Margin: min rejected 0.439 / max accepted 0.135 = 3.3x** at
`SILHOUETTE_MISMATCH_LIMIT = 0.20`, which sits 1.48x above the strongest clean view and 2.2x below
the weakest rejected one. The same split and a 3.2–3.3x margin hold at 2048, 512, 256 and 128 px and
at every departure/texture threshold in {0.10, 0.15, 0.20, 0.25} × {0.03, 0.04, 0.05, 0.06}.
