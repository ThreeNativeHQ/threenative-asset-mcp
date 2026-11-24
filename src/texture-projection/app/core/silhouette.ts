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
 */

/**
 * How far along a wall's face the strip runs, in metres. Measured on the courtyard's views: the painted
 * coping along a wall top is 14 px at 10 m, i.e. 0.14 m, so 0.25 m takes the cap and the shadow line
 * that gives it a body without touching the wall's own stone courses. Wider is worse: the strip is
 * unpainted by design (the fill continues the wall), and on the phase-2d images at 0.4 m it left 9.6
 * points of player-visible texels to the fill (98.2% -> 88.6% visible coverage), where 0.25 m keeps a
 * measured 93%+ (`tests/texture-projection-structure.test.ts` pins the rule itself).
 */
export const EDGE_BAND_METRES = 0.25;

/** |normal.y| above this is a horizontal surface (a floor, a tread), never a masked edge. */
const HORIZONTAL = 0.5;

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
