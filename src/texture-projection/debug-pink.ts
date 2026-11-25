/**
 * How much of a capture is the debug fill (PRD-916 phase 2r): a texel no accepted view painted is
 * #FF69B4 in a `fill: "debug"` bake, so a screenshot of the baked level can be counted instead of
 * judged. Lighting moves the colour, so this is a family test in HSV, not one RGB value.
 *
 * Node-safe (no DOM, no image library) so `scripts/count-debug-pink.ts` and the unit test count with
 * the same rule.
 */

/** The debug fill's hue, from #FF69B4, in degrees. */
export const DEBUG_PINK_HUE = 330;
/** How far a lit pink may drift in hue before it is another colour: a wall is 20-45 deg, sky 200-250. */
export const DEBUG_PINK_HUE_TOLERANCE = 25;
/** Below this the pixel is grey: a pale sky, a white wall and a shadowed white plaster all sit here. */
export const DEBUG_PINK_MIN_SATURATION = 0.45;
/** Below this it is black, not a lit surface, and its hue is noise. */
export const DEBUG_PINK_MIN_VALUE = 0.1;

/** One image's count: the pixels, the hot pink among them, and the share that is. */
export interface DebugPinkCount {
  readonly pixels: number;
  readonly pink: number;
  readonly share: number;
}

/**
 * Whether one sRGB pixel is the debug fill's hot pink, under any light that keeps it pink: hue within
 * `DEBUG_PINK_HUE_TOLERANCE` of the fill's, saturated enough not to be a grey or the pale blue sky, and
 * not black. A pink surface in shadow stays in (it is still the fill); a near-white wall or a blue sky
 * does not.
 */
export function isDebugPink(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const value = max / 255;
  if (value < DEBUG_PINK_MIN_VALUE) return false;
  if (max === 0 || delta / max < DEBUG_PINK_MIN_SATURATION) return false;
  let hue: number;
  if (max === r) hue = 60 * (((g - b) / delta) % 6);
  else if (max === g) hue = 60 * ((b - r) / delta + 2);
  else hue = 60 * ((r - g) / delta + 4);
  if (hue < 0) hue += 360;
  // Circular distance: the window may wrap through 0 deg.
  const distance = Math.abs(hue - DEBUG_PINK_HUE);
  return Math.min(distance, 360 - distance) <= DEBUG_PINK_HUE_TOLERANCE;
}

/**
 * Share of an RGBA image's opaque pixels that are the debug fill's hot pink. Transparent pixels are left
 * out of both counts: a capture's background is not a bake gap.
 */
export function countDebugPink(rgba: Uint8Array | Uint8ClampedArray): DebugPinkCount {
  let opaque = 0;
  let pink = 0;
  for (let i = 0; i < rgba.length / 4; i++) {
    if (rgba[4 * i + 3]! < 128) continue;
    opaque += 1;
    if (isDebugPink(rgba[4 * i]!, rgba[4 * i + 1]!, rgba[4 * i + 2]!)) pink += 1;
  }
  return { pixels: opaque, pink, share: opaque > 0 ? pink / opaque : 0 };
}
