/**
 * The thin strip along a view's wall edges, left out of the projection (PRD-916 phase 2e).
 *
 * Every painter gives a flat clay edge a body of its own: a grey coping slab along a wall top, a lit
 * face beside a shadow where two walls meet, a plinth at a base. In the clay each of those is one
 * thin line; in the atlas the strip becomes a separate 3D cap on the wall (owner rule B: no invented
 * geometry). Phase 2d measured that asking the model not to paint it does not work: two paid prompt
 * tests still returned a coping, and refusing the whole view empties the bake.
 *
 * So the strip is *not* projected: the texels stay unpainted and the island fill continues the
 * material around them to the edge, which is what the clay shows — a flat wall ending in a thin line.
 *
 * A wall pixel is in the strip when it lies within `bandMetres` of the clay's own edge: a pixel next
 * to the sky, or next to a surface that is *farther* away (the wall ends there, under something
 * behind it). Only wall pixels are masked: a floor's junction with a wall is not such an edge (the
 * floor is nearer), and on a floor the strip would fill with a mix of the two materials.
 *
 * The far side of an occlusion edge is a second, screen-space band (phase 2x): see `occlusionBandMask`.
 */

/**
 * How far along a wall's face the strip runs, in metres. Measured on the courtyard's views: the painted
 * coping along a wall top is 14 px at 10 m, i.e. 0.14 m, so 0.25 m takes the cap and the shadow line
 * that gives it a body without touching the wall's own stone courses. Wider is worse: the strip is
 * unpainted by design (the fill continues the wall), and on the phase-2d images at 0.4 m it left 9.6
 * points of player-visible texels to the fill (98.2% -> 88.6% visible coverage), where 0.25 m keeps a
 * measured 93%+ (`tests/texture-projection-structure.test.ts` pins the rule itself).
 */
export const EDGE_BAND_METRES = 0.10;

/** |normal.y| above this is a horizontal surface (a floor, a tread), never a masked edge. */
const HORIZONTAL = 0.5;

/**
 * Width of the occlusion band, as a share of the view image's width (phase 2x). An image model shifts a
 * foreground silhouette by a few pixels, so the background right beside an occlusion edge is painted with
 * the foreground object's colour: on the courtyard a moss strip along the top of the slab, a dark blob of
 * the slab's shadow on the wall behind it. 1.5 % of 1024 px is 15 px, more than any shift seen.
 */
export const OCCLUSION_BAND_SHARE = 0.005;

/**
 * Two pixels are on different surfaces when their distances differ by more than this share of the nearer
 * one: a few percent, the same jump the projection's own occlusion test uses (atlas.ts). Larger, and a
 * wall at a grazing angle — whose distance climbs with every pixel — would read as one edge after another.
 */
const OCCLUSION_DEPTH_JUMP = 0.04;

/** A surface behind this pixel is farther when its distance is this multiple of this pixel's. */
const FARTHER_BEHIND = 1.25;

/**
 * 1 where a view must not project: a wall pixel within `bandMetres` of a clay edge whose other side is
 * sky or a farther surface.
 *
 * `pos` and `nrm` are `Engine.readGeometry()`'s buffers: world position + distance per pixel, and
 * normal + geometry flag (a > 0.5 = level geometry), top-down, `width` x `height`.
 */
export function edgeBandMask(
  pos: Float32Array,
  nrm: Float32Array,
  width: number,
  height: number,
  bandMetres = EDGE_BAND_METRES,
): Uint8Array {
  const n = width * height;
  const out = new Uint8Array(n);
  /** World distance travelled from the clay's edge, per masked pixel. */
  const travelled = new Float32Array(n);
  const wall = (i: number) => nrm[4 * i + 3]! > 0.5 && Math.abs(nrm[4 * i + 1]!) <= HORIZONTAL;
  const behind = (j: number, i: number) => nrm[4 * j + 3]! <= 0.5 || pos[4 * j + 3]! > pos[4 * i + 3]! * FARTHER_BEHIND;
  // The clay's own edge pixels: a wall texel with the sky, or a farther surface, on one of its sides.
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!wall(i)) continue;
      // The frame's own border is not a clay edge: a wall running out of frame has no top to cap.
      const edge =
        (x > 0 && behind(i - 1, i)) ||
        (x + 1 < width && behind(i + 1, i)) ||
        (y > 0 && behind(i - width, i)) ||
        (y + 1 < height && behind(i + width, i));
      if (!edge) continue;
      out[i] = 1;
      queue[tail++] = i;
    }
  }
  // Breadth-first inwards over the wall's own pixels: the strip is a world distance, so a wall seen
  // from far gets a few pixels and one seen close gets more.
  while (head < tail) {
    const i = queue[head++]!;
    const x = i % width;
    const y = (i - x) / width;
    const neighbours = [
      x > 0 ? i - 1 : -1,
      x + 1 < width ? i + 1 : -1,
      y > 0 ? i - width : -1,
      y + 1 < height ? i + width : -1,
    ];
    for (const j of neighbours) {
      if (j < 0 || out[j] || !wall(j)) continue;
      // Never cross the edge itself: the strip is on this surface's side of it.
      if (behind(j, i) || behind(i, j)) continue;
      const step = Math.hypot(pos[4 * j]! - pos[4 * i]!, pos[4 * j + 1]! - pos[4 * i + 1]!, pos[4 * j + 2]! - pos[4 * i + 2]!);
      const total = travelled[i]! + step;
      if (total > bandMetres) continue;
      travelled[j] = total;
      out[j] = 1;
      queue[tail++] = j;
    }
  }
  return out;
}

/**
 * 1 where a view must not project because it is the far side of an occlusion edge: every geometry pixel
 * within `band` px of a depth discontinuity whose own surface is the farther of the two (phase 2x).
 *
 * A silhouette the painter moved by a few pixels leaves the object's colour on the background beside it,
 * which the atlas then carries as part of the wall. The band is a screen distance, not a world one, because
 * the error is the painter's own pixel shift; it grows with neither the distance nor the surface's angle.
 * Only the far side is masked: the near surface (the object) is what the painter drew where the clay has it,
 * and its pixels are the ones to keep.
 *
 * Seeds are the adjacent pixel pairs on different surfaces (the farther of the two); the band is then grown
 * over the far surface's own pixels, never across another discontinuity and never onto a nearer surface.
 *
 * `pos` is `Engine.readGeometry()`'s position buffer: world position + distance per pixel, top-down,
 * `width` x `height`.
 */
export function occlusionBandMask(
  pos: Float32Array,
  width: number,
  height: number,
  band = Math.round(width * OCCLUSION_BAND_SHARE),
): Uint8Array {
  const n = width * height;
  const out = new Uint8Array(n);
  if (band <= 0) return out;
  const distance = (i: number) => pos[4 * i + 3]!;
  const jump = (i: number, j: number) => {
    const a = distance(i);
    const b = distance(j);
    return Math.abs(a - b) > OCCLUSION_DEPTH_JUMP * Math.min(a, b);
  };
  /** Band left to grow, per pixel: -1 unvisited, `band - 1` on a seed (the seed is 1 px from the edge). */
  const left = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  const seed = (i: number) => {
    if (left[i]! >= 0) return;
    left[i] = band - 1;
    out[i] = 1;
    queue[tail++] = i;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!(distance(i) > 0)) continue; // sky has no surface to be beside
      // The right and down neighbours cover every adjacent pair once: only the farther side is seeded.
      if (x + 1 < width && distance(i + 1) > 0 && jump(i, i + 1)) seed(distance(i) > distance(i + 1) ? i : i + 1);
      if (y + 1 < height && distance(i + width) > 0 && jump(i, i + width)) {
        seed(distance(i) > distance(i + width) ? i : i + width);
      }
    }
  }
  // Grow over the far surface only: a step that jumps again has left it, and a step onto a nearer
  // surface is the object's own silhouette, not the band beside it.
  while (head < tail) {
    const i = queue[head++]!;
    const rest = left[i]! - 1;
    if (rest < 0) continue;
    const x = i % width;
    const y = (i - x) / width;
    const neighbours = [
      x > 0 ? i - 1 : -1,
      x + 1 < width ? i + 1 : -1,
      y > 0 ? i - width : -1,
      y + 1 < height ? i + width : -1,
    ];
    for (const j of neighbours) {
      if (j < 0 || left[j]! >= 0 || !(distance(j) > 0) || jump(i, j)) continue;
      left[j] = rest;
      out[j] = 1;
      queue[tail++] = j;
    }
  }
  return out;
}
