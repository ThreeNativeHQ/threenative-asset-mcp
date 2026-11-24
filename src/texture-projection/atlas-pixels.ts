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
}

/**
 * Fill the texels no view painted (alpha < 128) from the painted texels of the same UV island and
 * make the atlas opaque: a breadth-first fill inwards, each texel taking the average of the filled
 * texels around it, so a gap continues the material that surrounds it inside its own UV island.
 *
 * A single global mean colour was the 2c fill, and it is what made the courtyard floor look painted
 * (PRD-916 phase 2d): every texel the magnification guard or a rejected view left empty became the
 * atlas' average tone, so gaps between cobbles read as smooth white plaster patches with a tan seam.
 * The fill replaces that with the nearest painted material: a hole in the paving fills with paving.
 *
 * The island is the boundary, not the atlas (phase 2e): a texel is only ever filled from painted
 * texels of its own island, so a gap in a floor island cannot take the white plaster of a wall island
 * that happens to sit next to it in the atlas' packing.
 *
 * The fill's tone is all it had, so a filled texel also takes the grain of a real painted patch of its
 * own island (`transferDetail`, phase 2i). An island with no painted texel at all gets the mean of the
 * atlas' paint as its exported colour — nothing closer exists — and no grain, and `unpaintedPercent`
 * counts it, so the hole pass can still buy a view for it. The exported image is opaque everywhere, so
 * no reader samples a hole.
 */
export function inpaintUnpainted(
  data: Uint8ClampedArray,
  islands: Uint8Array,
  size: number,
  fallback: [number, number, number] = [128, 128, 128],
): InpaintReport {
  const n = size * size;
  const labels = islandLabels(islands, size);
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
  // A copy, because the fill marks what it filled and the detail pass still needs to know which texels a
  // view painted (those are never changed).
  const filled = painted.slice();
  // Texels from paint, read out of the fill's own breadth-first order: the detail's fade-in (phase 2k).
  const distance = new Uint8Array(n);
  if (paintedTexels > 0) fillWithinIslands(data, labels, filled, distance, size);
  // Nothing painted (a run that projected no view): keep the level's own clay-neutral tone rather
  // than filling from zeroes, which would be black.
  const guess =
    paintedTexels > 0
      ? [meanR / paintedTexels, meanG / paintedTexels, meanB / paintedTexels]
      : [fallback[0], fallback[1], fallback[2]];
  for (let i = 0; i < n; i++) {
    if (data[4 * i + 3]! >= 128) continue;
    // A filled texel already holds its own island's material; anything else is the atlas' guess.
    if (!filled[i]) {
      data[4 * i] = guess[0]!;
      data[4 * i + 1] = guess[1]!;
      data[4 * i + 2] = guess[2]!;
    }
    data[4 * i + 3] = 255;
  }
  if (paintedTexels > 0) transferDetail(data, labels, islands, painted, distance, size);
  return { unpaintedPercent: islandTexels ? (100 * unpainted) / islandTexels : 0 };
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
 * Breadth-first fill of each island's unpainted texels from its own painted ones: a texel takes the
 * mean of the filled texels 8-connected to it, nearest paint first, so the gap continues the material
 * around it and never reaches into another island. `distance` records how many texels from paint each
 * filled texel is (0 where a view painted), which the detail pass fades its grain in over.
 */
function fillWithinIslands(
  data: Uint8ClampedArray,
  labels: Int32Array,
  filled: Uint8Array,
  distance: Uint8Array,
  size: number,
): void {
  const queue = new Int32Array(labels.length);
  let head = 0;
  let tail = 0;
  const enqueueNeighboursOf = (i: number) => {
    const x = i % size;
    const y = (i - x) / size;
    const id = labels[i]!;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= size) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        if ((dx === 0 && dy === 0) || nx < 0 || nx >= size) continue;
        const j = ny * size + nx;
        if (filled[j] || labels[j] !== id) continue;
        // Nearest paint first, so the first enqueue is the shortest one; a later one keeps the shorter.
        if (distance[j] === 0) distance[j] = Math.min(255, distance[i]! + 1);
        queue[tail++] = j;
      }
    }
  };
  for (let i = 0; i < labels.length && tail < queue.length; i++) if (filled[i]) enqueueNeighboursOf(i);
  while (head < tail) {
    const i = queue[head++]!;
    if (filled[i]) continue;
    const x = i % size;
    const y = (i - x) / size;
    let r = 0;
    let g = 0;
    let b = 0;
    let count = 0;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= size) continue;
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        if ((dx === 0 && dy === 0) || nx < 0 || nx >= size) continue;
        const j = ny * size + nx;
        if (!filled[j]) continue;
        r += data[4 * j]!;
        g += data[4 * j + 1]!;
        b += data[4 * j + 2]!;
        count += 1;
      }
    }
    if (count === 0) continue; // its paint is further away: a later owner of the queue will fill it
    data[4 * i] = r / count;
    data[4 * i + 1] = g / count;
    data[4 * i + 2] = b / count;
    data[4 * i + 3] = 255;
    filled[i] = 1;
    enqueueNeighboursOf(i);
  }
}

/** Smallest square of painted texels a patch is cut from: smaller is a streak, not a texture. */
const DETAIL_PATCH_MIN = 32;
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
