# PRD-916 edge-misalignment fixtures (phase 2q)

Downscaled copies of a **real paid run** of `texture_project_paint`, used to calibrate and pin the check
that masks the painted edges the clay has no edge for: a pillar the painter drew shifted, a coping or a
stele the level does not have. When such an edge is projected, its pixels land on the flat wall behind it
and show up as a ghost "leaning slab" as the camera moves. The run itself (40 × 2048 px views) is not in
the repo: only these 256 px, name-free tiles travel.

## Provenance

- Run: `courtyard-mwuijnnl` under `sandbox/trompe-yard-prd916/.threenative/texture-projection/`
  (engine-side sandbox, not committed). Level `assets/blockout/courtyard.glb`, view size 2048 px,
  40 views (34 ground, 6 aerial), model `or-klein` (FLUX 3 Klein through OpenRouter).
- Files: `gen.png` (generated images), `clay.png` (the clay each one was given), 8 columns × 5 rows of
  256 px tiles, view index = row-major tile index. `layout.json` names the layout.
- `geometry.png` is the per-pixel geometry mask the check is given (white = level geometry), at the same
  256 px tiles. The run did not store the geometry buffer, so it is derived from the clay render's
  **exact clear colour** `(200, 209, 223)` as in the silhouette fixtures: the clay fills the sky with
  that one colour and nothing else in the frame is that colour, so the mask is exact up to the
  anti-aliased silhouette pixels.
- Both sheets are greyscale: the check works on luminance.
- 256 px is the smallest tile that separates all five invented views (see below): at 128 px view 12's
  invented ridge is too soft to reach the cell step, at 192 px it scores 0.195, at 224 px 0.446.
- The fixtures hold the **raw** generation; production judges the colour-corrected one, as with the
  structure fixtures. The split is the same on the stored 2048 px images.

## Labels and calibration (2026-11-24, this build)

The labels were settled on the pixels, not on the generation alone. Views 12, 23, 24, 32, 37 paint an
object the clay does not have, or shift one it does:

| view | what the painter invented |
|------|---------------------------|
| 12 | a curved stone ridge across the foreground |
| 23 | a niche with a tiled canopy and a buttress on a flat wall |
| 24 | a whole wall raised over what the clay shows as sky |
| 32 | a roof-tile coping and snow along a wall top that is shifted from the clay's |
| 37 | a stone stele with a tiled coping in the middle of a wall |

| set | views | score |
|-----|-------|-------|
| accepted by the pipeline | 0, 1, 2, 3, 5, 6, 7, 8, 9, 10, 15, 16, 19, 29, 38, 39 | 0.000, and no masked pixel: their whole area is kept |
| invented objects | 12 at 0.394, 32 at 0.386, 23 at 0.583, 24 at 0.920, 37 at 1.000 | min 0.386 |
| also rejected by the structure check | 11 at 0.778, 17 at 0.880 | — |

**Margin: min invented 0.386 / max accepted 0.000**, with `EDGE_MISALIGNMENT_LIMIT = 0.25` sitting
1.54x below the weakest invented view and above every accepted one, which masks nothing. Re-judging the
same run at its own 2048 px (a resume of `courtyard-mwuijnnl` with this check in place) gives ≤ 0.128 for
the 16 projected views (view 0; 39 at 0.070, 15 at 0.053) and 0.907 / 0.913 for the two invented views
that reach the check there (24, 37 — 12, 23 and 32 were rejected by the caller and never re-judged), so
the limit is 1.95x above the strongest accepted view and 3.6x below the strongest invented one. The strip
the check leaves out costs 0.1 points of the bake's visible coverage: 68.3 -> 68.2 %.
