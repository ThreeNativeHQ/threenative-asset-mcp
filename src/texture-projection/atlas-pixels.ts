/**
 * Rules the painted atlas' exported pixels follow, shared by the browser app and its tests: the UV
 * gutter a mip level needs (C.2), what an unpainted texel becomes, and the fills and crops that keep a
 * later view's material the same as an accepted one. Node-safe (no DOM, no GPU) so the runner and the
 * unit tests read the same rules the browser applies.
 */
/** Visible coverage the hole pass paints up to, and the share below which a run says so (B, phase 2d). */
export const VISIBLE_COVERAGE_TARGET = 95;
export const VISIBLE_COVERAGE_WARN = 90;

/** Minimum UV-island gutter in atlas texels (C.2: >= 8 px, so mip levels 0-3 sample real colour). */
export const ATLAS_GUTTER_TEXELS = 8;

export interface InpaintReport {
  /** Share of the atlas' island texels no view painted, filled from the material around them. */
  readonly unpaintedPercent: number;
  /**
   * The painted-coverage mask the detail fill measured, one byte per atlas texel (phase 2t): 255 where
   * an accepted view painted, 0 where the fill made the colour up, feathered and gutter-bled like the
   * exported alpha was in phase 2s. Absent for the debug fill and an atlas with no paint at all.
   */
  readonly mask?: Uint8Array;
}

/** What the exported atlas does with an island texel no accepted view painted (PRD-916 phase 2r). */
export type PaintFill = "detail" | "debug";

/** The debug fill's colour, #FF69B4: a texel of this colour was painted by no view at all. */
const DEBUG_FILL_RGB = [255, 105, 180] as const;

/**
 * Fill the texels no view painted (alpha < 128) from the painted texels of the same UV island: a
 * push-pull pyramid over the island's own bounding box, so each texel the fill made up takes the value
 * of the level above it and the gap becomes a smooth membrane between the borders a view did paint (phase
 * 2u) — never a line where one border's colour meets another's. The alpha those texels leave with is 255,
 * as every texel's is: the painted-coverage mask ships separately (phase 2t).
 *
 * `fill: "debug"` (phase 2r) writes such a texel as hot pink (#FF69B4) instead, and skips the fill and
 * its grain: a capture then counts the bake's gaps as pink pixels, which is a number, where reading a
 * filled gap is an opinion. Painted texels keep their colour, and so do the gutters: they were dilated
 * from paint before this pass, so a mip still samples the level rather than a hole. A hole's pink does
 * reach its neighbours at a high mip level, which is what a verification bake is for.
 *
 * A single global mean colour was the 2c fill, and it is what made the courtyard floor look painted
 * (PRD-916 phase 2d): every texel the magnification guard or a rejected view left empty became the
 * atlas' average tone, so gaps between cobbles read as smooth white plaster patches with a tan seam.
 * The fill replaces that with the material of the island around the hole. Phase 2d took the nearest
 * painted colour for that; phase 2u takes the pyramid's interpolation between all the painted borders,
 * because nearest-colour left the hole's own outline visible in the wall.
 *
 * The island is the boundary, not the atlas (phase 2e): a texel is only ever filled from painted
 * texels of its own island, so a gap in a floor island cannot take the white plaster of a wall island
 * that happens to sit next to it in the atlas' packing.
 *
 * The fill's tone is all it had, so a filled texel also takes the grain of a real painted patch of its
 * own island (`transferDetail`, phase 2i). An island with no painted texel at all gets the mean of the
 * atlas' paint as its exported colour — nothing closer exists — and no grain, and `unpaintedPercent`
 * counts it, so the hole pass can still buy a view for it.
 *
 * The exported bytes are opaque everywhere and carry the fill's own colour, as before phase 2s: the
 * painted-coverage mask is measured separately (`paintCoverageMask`, phase 2t) and handed back in the
 * report, because a mask in the atlas' alpha cost the atlas its UASTC cook and every filled texel its
 * colour. A caller that only wants the colour (the debug fill, an atlas with no paint at all) gets no
 * mask.
 */
export function inpaintUnpainted(
  data: Uint8ClampedArray,
  islands: Uint8Array,
  size: number,
  fallback: [number, number, number] = [128, 128, 128],
  fill: PaintFill = "detail",
): InpaintReport {
  const n = size * size;
  let islandTexels = 0;
  let paintedTexels = 0;
  // Counted before the fill runs: a filled texel is still a texel no view painted, and the hole pass
  // buys its views by this number.
  let unpainted = 0;
  let meanR = 0;
  let meanG = 0;
  let meanB = 0;
  const painted = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (islands[i]) islandTexels += 1;
    if (data[4 * i + 3]! < 128) {
      if (islands[i]) unpainted += 1;
      continue;
    }
    paintedTexels += 1;
    painted[i] = 1;
    meanR += data[4 * i]!;
    meanG += data[4 * i + 1]!;
    meanB += data[4 * i + 2]!;
  }
  // Nothing painted (a run that projected no view): keep the level's own clay-neutral tone rather
  // than filling from zeroes, which would be black.
  const guess =
    paintedTexels > 0
      ? [meanR / paintedTexels, meanG / paintedTexels, meanB / paintedTexels]
      : [fallback[0], fallback[1], fallback[2]];
  if (fill === "debug") {
    // No fill and no grain: a texel no accepted view painted is exactly #FF69B4, so a capture's share of
    // pink is the bake's gap count. Painted texels (and the dilated gutters, which are painted) keep
    // the colour they had, and everything ends opaque, as in the detail fill.
    for (let i = 0; i < n; i++) {
      if (data[4 * i + 3]! >= 128) continue;
      const inIsland = islands[i] !== 0;
      data[4 * i] = inIsland ? DEBUG_FILL_RGB[0] : guess[0]!;
      data[4 * i + 1] = inIsland ? DEBUG_FILL_RGB[1] : guess[1]!;
      data[4 * i + 2] = inIsland ? DEBUG_FILL_RGB[2] : guess[2]!;
      data[4 * i + 3] = 255;
    }
    return { unpaintedPercent: islandTexels ? (100 * unpainted) / islandTexels : 0 };
  }
  const labels = islandLabels(islands, size);
  // A copy, because the fill marks what it filled and the detail pass still needs to know which texels a
  // view painted (those are never changed).
  const filled = painted.slice();
  // Texels from paint, read out of the fill's own breadth-first order: the detail's fade-in (phase 2k).
  const distance = new Uint8Array(n);
  if (paintedTexels > 0) fillWithinIslands(data, labels, filled, distance, size);
  for (let i = 0; i < n; i++) {
    if (!painted[i]) {
      // A filled texel already holds its own island's material; anything else is the atlas' guess.
      if (!filled[i]) {
        data[4 * i] = guess[0]!;
        data[4 * i + 1] = guess[1]!;
        data[4 * i + 2] = guess[2]!;
      }
    }
    // Opaque everywhere, whatever the fill wrote: the atlas cooks as an OPAQUE base colour.
    data[4 * i + 3] = 255;
  }
  const mask = paintedTexels > 0 ? paintCoverageMask(labels, islands, painted, size) : undefined;
  if (paintedTexels > 0) transferDetail(data, labels, islands, painted, distance, size);
  return {
    unpaintedPercent: islandTexels ? (100 * unpainted) / islandTexels : 0,
    ...(mask === undefined ? {} : { mask }),
  };
}

/** Texels over which the mask ramps up inside painted texels, inwards from the fill edge. */
export const PAINTED_MASK_FEATHER = 6;

/** Atlas texels per mask texel: the mask ships at a quarter of the atlas' side (phase 2t). */
export const PAINTED_MASK_DOWNSCALE = 4;

/**
 * The painted-coverage mask (PRD-916 phases 2s and 2t): 255 where an accepted view painted the texel, 0
 * where the fill made it up, and a `PAINTED_MASK_FEATHER`-texel ramp inside the painted side of that
 * edge, so a shader that swaps the atlas for a stand-in (the paint's own swatch) there has no hard line
 * to show. It ships as its own single-channel file beside the GLB, never in the atlas' alpha: a lossy
 * alpha on an OPAQUE material drops the atlas off its UASTC cook, and a canvas premultiplies, so a
 * filled texel's colour would not survive the export at alpha 0.
 *
 * The ramp is one-sided on purpose. A filled texel is exactly 0 wherever it sits, so "no view painted
 * this" is exact, and only the paint's own edge gives part of its weight away.
 *
 * The island is the boundary here too: a texel only ramps against a fill of its own island, and a UV
 * gutter copies the value of the island edge it was dilated from (`bleedGutterMask`), so a bilinear
 * sample that reaches into a gutter reads coverage rather than the unpainted atlas outside the island.
 */
function paintCoverageMask(
  labels: Int32Array,
  islands: Uint8Array,
  painted: Uint8Array,
  size: number,
): Uint8Array {
  const n = size * size;
  const mask = new Uint8Array(n);
  // Every texel no view painted reads as no paint at all, wherever it sits; the gutters below then take
  // the value of the island edge they were dilated from, as the pad's colour does.
  for (let i = 0; i < n; i++) mask[i] = painted[i] ? 255 : 0;
  const depth = new Uint8Array(n);
  const neighbours: number[] = [];
  // The paint edge: painted texels with a fill texel of their own island beside them.
  let frontier: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!islands[i] || !painted[i]) continue;
    const id = labels[i]!;
    if (!around(i, size, neighbours).some((j) => !painted[j] && labels[j] === id)) continue;
    depth[i] = 1;
    frontier.push(i);
  }
  for (let level = 1; level <= PAINTED_MASK_FEATHER && frontier.length > 0; level++) {
    for (const i of frontier) mask[i] = Math.round((255 * level) / PAINTED_MASK_FEATHER);
    if (level === PAINTED_MASK_FEATHER) break;
    const next: number[] = [];
    for (const i of frontier) {
      const id = labels[i]!;
      for (const j of around(i, size, neighbours)) {
        if (!painted[j] || depth[j] !== 0 || labels[j] !== id) continue;
        depth[j] = level + 1;
        next.push(j);
      }
    }
    frontier = next;
  }
  bleedGutterMask(mask, islands, size);
  return mask;
}

/**
 * The mask every renderer samples, from the atlas-space one: a plain box average over each
 * `PAINTED_MASK_DOWNSCALE` x `PAINTED_MASK_DOWNSCALE` block, so a fourth of the side (1024 texels for a
 * 4096 atlas) still holds the six-texel feather as one or two texels of ramp and the fill stays exactly
 * 0. The mask covers the same UVs as the atlas, so a shader reads it at the atlas' own uv.
 */
export function downsampleCoverage(mask: Uint8Array, size: number, factor = PAINTED_MASK_DOWNSCALE): Uint8Array {
  const side = Math.floor(size / factor);
  const out = new Uint8Array(side * side);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      let total = 0;
      for (let dy = 0; dy < factor; dy++) {
        const row = (y * factor + dy) * size + x * factor;
        for (let dx = 0; dx < factor; dx++) total += mask[row + dx]!;
      }
      out[y * side + x] = Math.round(total / (factor * factor));
    }
  }
  return out;
}

/** The 8-connected texels of `i` in a re-used array, so a per-texel walk allocates nothing. */
function around(i: number, size: number, out: number[]): number[] {
  const x = i % size;
  const y = (i - x) / size;
  out.length = 0;
  for (let dy = -1; dy <= 1; dy++) {
    const ny = y + dy;
    if (ny < 0 || ny >= size) continue;
    for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx;
      if ((dx === 0 && dy === 0) || nx < 0 || nx >= size) continue;
      out.push(ny * size + nx);
    }
  }
  return out;
}

/**
 * A UV gutter copies the mask of the island edge the colour was dilated from (`Atlas.pad`): a bilinear
 * or mipped sample at an island's border reads into the gutter, and the unbled atlas outside the island
 * is 0, which would make a painted edge read as a fill. Breadth-first out of the islands for as many
 * texels of gutter as the pad writes, each gutter texel taking the mean of the ones already known.
 */
function bleedGutterMask(mask: Uint8Array, islands: Uint8Array, size: number): void {
  const n = size * size;
  const depth = new Uint8Array(n).fill(255);
  for (let i = 0; i < n; i++) if (islands[i]) depth[i] = 0;
  let frontier: number[] = [];
  // The first ring: gutter texels beside an island texel. One scan; everything past it is frontier work.
  for (let i = 0; i < n; i++) {
    if (depth[i] !== 255) continue;
    const x = i % size;
    const y = (i - x) / size;
    if (
      !(
        (x > 0 && depth[i - 1] === 0) ||
        (x + 1 < size && depth[i + 1] === 0) ||
        (y > 0 && depth[i - size] === 0) ||
        (y + 1 < size && depth[i + size] === 0)
      )
    )
      continue;
    depth[i] = 1;
    frontier.push(i);
  }
  const neighbours: number[] = [];
  for (let level = 1; level <= ATLAS_GUTTER_TEXELS && frontier.length > 0; level++) {
    const next: number[] = [];
    for (const i of frontier) {
      const ring = around(i, size, neighbours);
      let total = 0;
      let count = 0;
      for (const j of ring) {
        if (depth[j]! >= level) continue;
        total += mask[j]!;
        count += 1;
      }
      // The ring is the pad's own dilation of an island, so it always meets one known texel.
      mask[i] = count === 0 ? 0 : Math.round(total / count);
      for (const j of ring) {
        if (depth[j] !== 255) continue;
        depth[j] = level + 1;
        next.push(j);
      }
    }
    frontier = next;
  }
}

/** Island id per texel (-1 outside every island), from 4-connected components of the island mask. */
export function islandLabels(islands: Uint8Array, size: number): Int32Array {
  const labels = new Int32Array(islands.length).fill(-1);
  const stack: number[] = [];
  let next = 0;
  for (let start = 0; start < islands.length; start++) {
    if (!islands[start] || labels[start] !== -1) continue;
    const id = next++;
    labels[start] = id;
    stack.push(start);
    while (stack.length > 0) {
      const i = stack.pop()!;
      const x = i % size;
      const y = (i - x) / size;
      if (x > 0 && islands[i - 1] && labels[i - 1] === -1) {
        labels[i - 1] = id;
        stack.push(i - 1);
      }
      if (x + 1 < size && islands[i + 1] && labels[i + 1] === -1) {
        labels[i + 1] = id;
        stack.push(i + 1);
      }
      if (y > 0 && islands[i - size] && labels[i - size] === -1) {
        labels[i - size] = id;
        stack.push(i - size);
      }
      if (y + 1 < size && islands[i + size] && labels[i + size] === -1) {
        labels[i + size] = id;
        stack.push(i + size);
      }
    }
  }
  return labels;
}

/**
 * Fill of each island's unpainted texels from its own painted ones, as a smooth membrane (PRD-916 phase
 * 2u): a push-pull pyramid per island, so a gap interpolates between all of the painted borders around it
 * rather than flowing in from the nearest one.
 *
 * Phase 2d filled a gap breadth-first, nearest painted texel first, which continues the material around it
 * but leaves the *shape* of the gap in the result: where dark moss sits below a hole and light stone above
 * it, the two meet along a line that traces the hole's outline, and the judge saw exactly those outlines as
 * shrub-shadow blobs on the courtyard's back wall. A pyramid has no such meeting line: every level averages
 * the island's paint, and the pull back down interpolates one continuous field between all its borders.
 *
 * Everything else is unchanged: the island is still the boundary (each island's pyramid is built in its own
 * bounding box and only its own texels carry weight), `transferDetail` still adds the grain of a real
 * painted patch on top, and `distance` still says how far from paint each filled texel sits, which is the
 * grain's fade-in.
 */
function fillWithinIslands(
  data: Uint8ClampedArray,
  labels: Int32Array,
  filled: Uint8Array,
  distance: Uint8Array,
  size: number,
): void {
  let islandCount = 0;
  for (let i = 0; i < labels.length; i++) if (labels[i]! >= islandCount) islandCount = labels[i]! + 1;
  if (islandCount === 0) return;
  // One pass for each island's bounds and how much of it a view painted: an island with no paint has
  // nothing to continue, and one with no gap has nothing to fill.
  const x0 = new Int32Array(islandCount).fill(-1);
  const y0 = new Int32Array(islandCount);
  const x1 = new Int32Array(islandCount);
  const y1 = new Int32Array(islandCount);
  const texels = new Int32Array(islandCount);
  const painted = new Int32Array(islandCount);
  for (let y = 0, i = 0; y < size; y++) {
    for (let x = 0; x < size; x++, i++) {
      const id = labels[i]!;
      if (id < 0) continue;
      if (x0[id]! < 0) {
        x0[id] = x;
        y0[id] = y;
        x1[id] = x;
        y1[id] = y;
      } else {
        if (x < x0[id]!) x0[id] = x;
        if (x > x1[id]!) x1[id] = x;
        if (y > y1[id]!) y1[id] = y;
      }
      texels[id]! += 1;
      if (data[4 * i + 3]! >= 128) painted[id]! += 1;
    }
  }
  for (let id = 0; id < islandCount; id++) {
    if (painted[id]! === 0 || painted[id]! === texels[id]!) continue;
    fillIsland(data, labels, filled, distance, size, id, x0[id]!, y0[id]!, x1[id]!, y1[id]!);
  }
}

/**
 * One island's membrane fill, inside its own bounding box: the texels a view painted are the pyramid's
 * weights (1 each), every other texel is 0, and the pull back down gives each of those a value.
 *
 * A second island can share these bounds (a hole in one island holding another in the packing) and it
 * contributes nothing: its weight is 0, so the pyramid never averages its colour. The bounding box only
 * decides how much work the island costs, never what it is filled from.
 */
function fillIsland(
  data: Uint8ClampedArray,
  labels: Int32Array,
  filled: Uint8Array,
  distance: Uint8Array,
  size: number,
  id: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const val = new Float32Array(w * h * 3);
  const weight = new Float32Array(w * h);
  const dist = new Uint8Array(w * h).fill(DETAIL_RAMP_TEXELS);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y0 + y) * size + x0 + x;
      if (labels[i] !== id || data[4 * i + 3]! < 128) continue;
      const k = y * w + x;
      val[3 * k] = data[4 * i]!;
      val[3 * k + 1] = data[4 * i + 1]!;
      val[3 * k + 2] = data[4 * i + 2]!;
      weight[k] = 1;
      dist[k] = 0;
    }
  }
  const tone = pushPull(val, weight, w, h);
  chamferFromPaint(dist, w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y0 + y) * size + x0 + x;
      if (labels[i] !== id || data[4 * i + 3]! >= 128) continue;
      const k = y * w + x;
      data[4 * i] = tone[3 * k]!;
      data[4 * i + 1] = tone[3 * k + 1]!;
      data[4 * i + 2] = tone[3 * k + 2]!;
      data[4 * i + 3] = 255;
      filled[i] = 1;
      distance[i] = dist[k]!;
    }
  }
}

/**
 * Texels from paint, capped at `DETAIL_RAMP_TEXELS` (0 on a painted texel): two sweeps of a chessboard
 * distance transform, which the breadth-first fill used to give for free. The grain's fade-in is the only
 * reader, and it stops counting at that cap, so texels of another island inside these bounds may carry the
 * field across without any colour following them.
 */
function chamferFromPaint(dist: Uint8Array, w: number, h: number): void {
  const cap = DETAIL_RAMP_TEXELS;
  const relax = (k: number, n: number) => {
    const step = dist[n]! + 1;
    if (step < dist[k]!) dist[k] = Math.min(cap, step);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      if (dist[k] === 0) continue;
      if (x > 0) relax(k, k - 1);
      if (y === 0) continue;
      relax(k, k - w);
      if (x > 0) relax(k, k - w - 1);
      if (x + 1 < w) relax(k, k - w + 1);
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const k = y * w + x;
      if (dist[k] === 0) continue;
      if (x + 1 < w) relax(k, k + 1);
      if (y + 1 === h) continue;
      relax(k, k + w);
      if (x + 1 < w) relax(k, k + w + 1);
      if (x > 0) relax(k, k + w - 1);
    }
  }
}

/** Smallest square of painted texels a patch is cut from: smaller is a streak, not a texture. */
const DETAIL_PATCH_MIN = 16;
/** Longest side a patch is cut at, so a patch's mean stays a fixed cost per island. */
const DETAIL_PATCH_MAX = 128;
/** Share of a patch's side a tile seam cross-fades over (a quarter: wide enough to hide the seam). */
const DETAIL_SEAM_FEATHER = 0.25;
/** Texels of fill it takes the grain to reach full strength away from painted texels. */
const DETAIL_RAMP_TEXELS = 8;

/** A square of painted texels of one island, and its own mean (subtracted: the detail carries no tone). */
interface DetailPatch {
  readonly x: number;
  readonly y: number;
  readonly side: number;
  /** Half a tile: the offset the second sample is taken at, so its seams fall in the first one's middle. */
  readonly shift: number;
  /** Texels over which the detail cross-fades to that second sample, on each side of a seam. */
  readonly feather: number;
  readonly mean: readonly [number, number, number];
}

/**
 * High-frequency half of the fill (PRD-916 phase 2i, retiled in 2k): every filled texel also gets the
 * grain of a real painted square of its own island, tiled over the island with plain wrap repeat and
 * added to the fill's tone.
 *
 * The breadth-first fill continued a gap's tone and nothing else, so in game the courtyard floor's
 * unpainted texels read as long smeared streaks and the step and pillar faces as flat beige. The grain is
 * the island's own largest fully painted square: same island, so the same orientation and texel scale,
 * and its mean is subtracted so the join is a join in grain, not in colour.
 *
 * Phase 2i tiled it with mirrored repeat, and the judge saw the fold it cannot help: a wall end face
 * came back a mirror-symmetric kaleidoscope smear with hard horizontal bands, the floor a radial rosette
 * at every tile corner (the 4-fold symmetry of a mirrored repeat), and the cobbles changed at the tile
 * border where the fill met the painted floor. So the tile wraps plainly now — no symmetry anywhere —
 * and the seams that leaves are cross-faded away: within `DETAIL_SEAM_FEATHER` of a seam the detail is
 * blended with the same patch sampled half a tile further on, the two weights summing to 1 and
 * renormalised by `1 / sqrt(w1^2 + w2^2)` so the grain keeps its amplitude. Each sample's own seam is
 * the place its weight reaches 0, so no seam has a discontinuity to show.
 *
 * An island with no fully painted 32x32 square (a parapet strip, a pillar face) keeps the plain fill
 * instead of borrowing another island's grain: borrowed grain is the wrong scale and orientation, which
 * is what the judge saw on the narrow wall ends. The grain also fades in over the first
 * `DETAIL_RAMP_TEXELS` texels away from painted ones, so paint and fill meet in a join in grain rather
 * than a hard switch of pattern.
 */
function transferDetail(
  data: Uint8ClampedArray,
  labels: Int32Array,
  islands: Uint8Array,
  painted: Uint8Array,
  distance: Uint8Array,
  size: number,
): void {
  let islandCount = 0;
  for (let i = 0; i < labels.length; i++) if (labels[i]! >= islandCount) islandCount = labels[i]! + 1;
  if (islandCount === 0) return;
  const largest = new Int32Array(islandCount);
  const cornerX = new Int32Array(islandCount);
  const cornerY = new Int32Array(islandCount);
  // One pass: the largest fully painted square per island (the usual three-neighbour minimum, so it
  // costs nothing beyond the pass).
  let prev = new Int32Array(size);
  let cur = new Int32Array(size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      cur[x] = 0;
      const id = labels[i]!;
      if (id < 0 || !painted[i]) continue;
      let square = 1;
      if (x > 0 && y > 0) {
        // A neighbour of another island (or unpainted) ends the square: cur/prev hold its side.
        const left = labels[i - 1] === id ? cur[x - 1]! : 0;
        const up = labels[i - size] === id ? prev[x]! : 0;
        const diagonal = labels[i - size - 1] === id ? prev[x - 1]! : 0;
        square += Math.min(left, up, diagonal);
      }
      cur[x] = square;
      if (square > largest[id]!) {
        largest[id] = square;
        cornerX[id] = x;
        cornerY[id] = y;
      }
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  // Only an island's own square is ever a source: no island borrows another's grain.
  const patches: (DetailPatch | undefined)[] = new Array(islandCount).fill(undefined);
  let anyPatch = false;
  for (let id = 0; id < islandCount; id++) {
    const side = Math.min(largest[id]!, DETAIL_PATCH_MAX);
    if (side < DETAIL_PATCH_MIN) continue;
    patches[id] = detailPatch(data, size, cornerX[id]! - side + 1, cornerY[id]! - side + 1, side);
    anyPatch = true;
  }
  if (!anyPatch) return; // no painted square anywhere: keep the plain fill
  for (let i = 0; i < painted.length; i++) {
    if (painted[i] || !islands[i]) continue;
    const patch = patches[labels[i]!];
    if (!patch) continue;
    const side = patch.side;
    // Fade the grain in away from paint: at the join the fill is the fill's own tone, as before.
    const ramp = distance[i] === 0 ? 1 : Math.min(distance[i]!, DETAIL_RAMP_TEXELS) / DETAIL_RAMP_TEXELS;
    const x = i % size;
    const y = (i - x) / size;
    const u = wrapOffset(x - patch.x, side);
    const v = wrapOffset(y - patch.y, side);
    const u2 = wrapOffset(u + patch.shift, side);
    const v2 = wrapOffset(v + patch.shift, side);
    const near1 = seamRamp(u, v, side, patch.feather);
    const near2 = seamRamp(u2, v2, side, patch.feather);
    // Both 0 only on the one-texel crossings where each sample sits on a seam (a quarter tile): an even
    // mix there, since neither can be preferred.
    const w1 = near1 + near2 > 0 ? near1 / (near1 + near2) : 0.5;
    const w2 = 1 - w1;
    const scale = ramp / Math.sqrt(w1 * w1 + w2 * w2);
    const a = 4 * ((patch.y + v) * size + patch.x + u);
    const b = 4 * ((patch.y + v2) * size + patch.x + u2);
    for (let c = 0; c < 3; c++) {
      const detail = w1 * (data[a + c]! - patch.mean[c]!) + w2 * (data[b + c]! - patch.mean[c]!);
      data[4 * i + c] = data[4 * i + c]! + scale * detail;
    }
  }
}

/** A fully painted square of `side` x `side` texels at (`x`, `y`), with its own mean colour. */
function detailPatch(data: Uint8ClampedArray, size: number, x: number, y: number, side: number): DetailPatch {
  let r = 0;
  let g = 0;
  let b = 0;
  for (let row = 0; row < side; row++) {
    const from = (y + row) * size + x;
    for (let col = 0; col < side; col++) {
      const p = 4 * (from + col);
      r += data[p]!;
      g += data[p + 1]!;
      b += data[p + 2]!;
    }
  }
  const texels = side * side;
  return {
    x,
    y,
    side,
    shift: side >> 1,
    feather: Math.max(1, side * DETAIL_SEAM_FEATHER),
    mean: [r / texels, g / texels, b / texels],
  };
}

/** Plain wrap repeat: an offset of `v` texels from a patch's corner, wrapped into `[0, side)`. */
function wrapOffset(v: number, side: number): number {
  const wrapped = v % side;
  return wrapped < 0 ? wrapped + side : wrapped;
}

/** 0 on a patch's own border texels, 1 at `width` texels in: how far a sample is from a tile seam. */
function seamRamp(u: number, v: number, side: number, width: number): number {
  return Math.min(1, Math.min(u, side - 1 - u, v, side - 1 - v) / width);
}

/**
 * Whether a pass may only paint what no player-height camera sees: the passes that look down on the
 * level from above (an aerial ring, a close pass over the roofs). It is the rule phase 2e added for the
 * courtyard's floor — an aerial view sees the courtyard as one blank plane and paints a decorative
 * mosaic on it, which then became what a player walks on — so those passes are restricted to wall tops,
 * roof tops and outer faces, and the ground is left to the views that stand on it.
 */
export function aerialPassOnlyHidden(kind: "ground" | "aerial" | "roof" | "fill" | undefined): boolean {
  return kind === "aerial" || kind === "roof";
}

/**
 * Push-pull interpolation: values known where `wt` > 0 spread smoothly into everything else (a cheap stand-in for
 * a membrane / Poisson fill). RGB float in, RGB float out.
 */
export function pushPull(val: Float32Array, wt: Float32Array, w: number, h: number): Float32Array {
  type L = { v: Float32Array; a: Float32Array; w: number; h: number };
  const levels: L[] = [{ v: val.slice(), a: wt.slice(), w, h }];
  for (let level = levels[0]!; level.w > 1 || level.h > 1; ) {
    const F = level;
    const cw = Math.max(1, Math.ceil(F.w / 2)), ch = Math.max(1, Math.ceil(F.h / 2));
    const v = new Float32Array(cw * ch * 3), a = new Float32Array(cw * ch);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        let s0 = 0, s1 = 0, s2 = 0, sa = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const fx = 2 * x + dx, fy = 2 * y + dy;
            if (fx >= F.w || fy >= F.h) continue;
            const j = fy * F.w + fx, wj = F.a[j]!;
            s0 += F.v[3 * j]! * wj; s1 += F.v[3 * j + 1]! * wj; s2 += F.v[3 * j + 2]! * wj; sa += wj;
          }
        }
        const k = y * cw + x;
        if (sa > 0) { v[3 * k] = s0 / sa; v[3 * k + 1] = s1 / sa; v[3 * k + 2] = s2 / sa; }
        a[k] = Math.min(1, sa);
      }
    }
    level = { v, a, w: cw, h: ch };
    levels.push(level);
  }
  for (let li = levels.length - 2; li >= 0; li--) {
    const F = levels[li]!, C = levels[li + 1]!;
    for (let y = 0; y < F.h; y++) {
      const cy = Math.min(C.h - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
      const y0 = Math.floor(cy), y1 = Math.min(C.h - 1, y0 + 1), fy = cy - y0;
      for (let x = 0; x < F.w; x++) {
        const cx = Math.min(C.w - 1, Math.max(0, (x + 0.5) / 2 - 0.5));
        const x0 = Math.floor(cx), x1 = Math.min(C.w - 1, x0 + 1), fx = cx - x0;
        const j = y * F.w + x, a = F.a[j]!;
        if (a >= 1) continue;
        for (let c = 0; c < 3; c++) {
          const top = C.v[3 * (y0 * C.w + x0) + c]! * (1 - fx) + C.v[3 * (y0 * C.w + x1) + c]! * fx;
          const bot = C.v[3 * (y1 * C.w + x0) + c]! * (1 - fx) + C.v[3 * (y1 * C.w + x1) + c]! * fx;
          F.v[3 * j + c] = a * F.v[3 * j + c]! + (1 - a) * (top * (1 - fy) + bot * fy);
        }
        F.a[j] = 1;
      }
    }
  }
  return levels[0]!.v;
}

/**
 * Window of a view that is most of already-accepted texture, for the consistency reference (C, phase 2d).
 *
 * `known` is 1 where the view shows texture a previous, accepted view painted. The window is chosen by
 * an integral image of that mask, so picking the densest `size` x `size` block is one pass, not a search
 * over every position. Returns the top-left corner, top-down pixel coordinates.
 */
export function paintedWindow(known: Uint8Array, w: number, h: number, size: number): { x: number; y: number } {
  const side = Math.min(size, w, h);
  if (side <= 0) return { x: 0, y: 0 };
  const stride = Math.max(1, Math.floor(side / 8));
  const integral = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += known[y * w + x] ? 1 : 0;
      integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1]! + row;
    }
  }
  let best = -1;
  let bestX = 0;
  let bestY = 0;
  for (let y = 0; y + side <= h; y += stride) {
    for (let x = 0; x + side <= w; x += stride) {
      const x1 = x + side;
      const y1 = y + side;
      const sum =
        integral[y1 * (w + 1) + x1]! -
        integral[y * (w + 1) + x1]! -
        integral[y1 * (w + 1) + x]! +
        integral[y * (w + 1) + x]!;
      if (sum > best) {
        best = sum;
        bestX = x;
        bestY = y;
      }
    }
  }
  return { x: bestX, y: bestY };
}

/** A square crop of a top-down RGBA image. */
export function cropRgba(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  x: number,
  y: number,
  size: number,
): Uint8ClampedArray {
  const side = Math.min(size, w - x, h - y);
  const out = new Uint8ClampedArray(side * side * 4);
  for (let row = 0; row < side; row++) {
    const from = ((y + row) * w + x) * 4;
    out.set(src.subarray(from, from + side * 4), row * side * 4);
  }
  return out;
}
