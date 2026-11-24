/**
 * Did the model invent geometry? A dark arch, doorway, passage, staircase or a new volume changes
 * the low-frequency luminance of the 64 px image; painting a material (plaster, brick, tiles) does
 * not. Pure functions: unit-tested in node, no DOM, no GL.
 */

/** Cells across the low-frequency comparison grid (64: one cell is 16 view pixels at 1024). */
export const STRUCTURE_GRID = 64;
/** Box radius that averages brick-scale texture away (5x5 cells = 80 view pixels at 1024). */
const SMOOTH_RADIUS = 2;

/**
 * Largest allowed mean luminance shift, in the 0..1 luminance scale, of a smoothed 5x5-cell patch
 * after removing each image's global mean (so a darker style or a brighter render is not an
 * invention). Measured on synthetic pairs, all at 256 px: material-only paints (plaster, brick
 * 8-32 px, a uniformly darker timber) peak at 0.02-0.08; a painted door peaks at 0.38, a window at
 * 0.43, an arch at 0.49, stairs at 0.20, an added volume at 0.19. 0.13 sits between them.
 */
export const STRUCTURE_DEVIATION_LIMIT = 0.13;

/** Luminance (Rec. 709) of one top-down RGBA8 image, box-averaged down to `grid` x `grid`. */
export function lowFrequencyLuminance(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  grid = STRUCTURE_GRID,
): Float32Array {
  const sums = new Float64Array(grid * grid);
  const counts = new Float64Array(grid * grid);
  for (let y = 0; y < height; y++) {
    const gy = Math.min(grid - 1, Math.floor(((y + 0.5) * grid) / height));
    for (let x = 0; x < width; x++) {
      const gx = Math.min(grid - 1, Math.floor(((x + 0.5) * grid) / width));
      const p = 4 * (y * width + x);
      const cell = gy * grid + gx;
      sums[cell] = (sums[cell] ?? 0) + (0.2126 * rgba[p]! + 0.7152 * rgba[p + 1]! + 0.0722 * rgba[p + 2]!) / 255;
      counts[cell] = (counts[cell] ?? 0) + 1;
    }
  }
  const out = new Float32Array(grid * grid);
  for (let i = 0; i < out.length; i++) out[i] = counts[i]! > 0 ? sums[i]! / counts[i]! : 0;
  return out;
}

function meanOf(values: Float32Array): number {
  let sum = 0;
  for (const value of values) sum += value;
  return values.length > 0 ? sum / values.length : 0;
}

/**
 * How much low-frequency luminance the generated image adds or removes, ignoring the difference of
 * its overall brightness: the maximum, over 5x5-cell patches, of the mean absolute difference of the
 * two mean-removed luminance fields. 0 = same structure.
 */
export function structureDeviation(
  generated: Uint8ClampedArray | Uint8Array,
  reference: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  grid = STRUCTURE_GRID,
): number {
  return structureDeviationOfLuminance(
    lowFrequencyLuminance(generated, width, height, grid),
    lowFrequencyLuminance(reference, width, height, grid),
    grid,
  );
}

export function structureDeviationOfLuminance(a: Float32Array, b: Float32Array, grid = STRUCTURE_GRID): number {
  const meanA = meanOf(a);
  const meanB = meanOf(b);
  const difference = new Float32Array(grid * grid);
  for (let i = 0; i < difference.length; i++) difference[i] = (a[i]! - meanA) - (b[i]! - meanB);
  // Box sum over the patch, then |mean|; a brick alternates sign and averages out, a shape does not.
  const integral = new Float64Array((grid + 1) * (grid + 1));
  for (let y = 0; y < grid; y++) {
    let row = 0;
    for (let x = 0; x < grid; x++) {
      row += difference[y * grid + x]!;
      integral[(y + 1) * (grid + 1) + (x + 1)] = integral[y * (grid + 1) + (x + 1)]! + row;
    }
  }
  let worst = 0;
  for (let y = 0; y < grid; y++) {
    const y0 = Math.max(0, y - SMOOTH_RADIUS);
    const y1 = Math.min(grid, y + SMOOTH_RADIUS + 1);
    for (let x = 0; x < grid; x++) {
      const x0 = Math.max(0, x - SMOOTH_RADIUS);
      const x1 = Math.min(grid, x + SMOOTH_RADIUS + 1);
      const sum =
        integral[y1 * (grid + 1) + x1]! -
        integral[y0 * (grid + 1) + x1]! -
        integral[y1 * (grid + 1) + x0]! +
        integral[y0 * (grid + 1) + x0]!;
      const mean = Math.abs(sum) / ((y1 - y0) * (x1 - x0));
      if (mean > worst) worst = mean;
    }
  }
  return worst;
}

/** Whether the generated view paints a shape the image it was given does not have. */
export function rejectsStructure(deviation: number, limit = STRUCTURE_DEVIATION_LIMIT): boolean {
  return deviation > limit;
}
