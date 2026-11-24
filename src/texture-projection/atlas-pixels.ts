/**
 * Rules the painted atlas' exported pixels follow, shared by the browser app and its tests: the UV
 * gutter a mip level needs (C.2) and what an unpainted texel becomes.
 */

/** Minimum UV-island gutter in atlas texels (C.2: >= 8 px, so mip levels 0-3 sample real colour). */
export const ATLAS_GUTTER_TEXELS = 8;

/**
 * Replace texels no view painted (alpha < 128) with the atlas' mean painted colour, and make them
 * opaque. A mip level coarser than the UV gutter then blends toward the atlas instead of toward
 * black or clay gray, so a seam never bleeds a foreign colour (C.2).
 */
export function infillUnpainted(data: Uint8ClampedArray, fallback: [number, number, number] = [128, 128, 128]): void {
  let r = 0;
  let g = 0;
  let b = 0;
  let painted = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3]! < 128) continue;
    r += data[i]!;
    g += data[i + 1]!;
    b += data[i + 2]!;
    painted += 1;
  }
  const mean = painted > 0 ? [r / painted, g / painted, b / painted] : fallback;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3]! >= 128) continue;
    data[i] = mean[0]!;
    data[i + 1] = mean[1]!;
    data[i + 2] = mean[2]!;
    data[i + 3] = 255;
  }
}
