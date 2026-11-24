/**
 * Did the model invent geometry? A dark arch, doorway, passage, staircase or an added volume is a
 * *compact* change of the 64 px luminance; painting a material, a darker style or a gradient of light
 * is either averaged out at that scale or is a smooth trend. Pure functions: unit-tested in node, no
 * DOM, no GL.
 */

/** Cells across the low-frequency comparison grid (64: one cell is 16 view pixels at 1024). */
export const STRUCTURE_GRID = 64;
/** Box radius (13x13 cells = 208 view pixels at 1024) whose trend is removed: gradients are not shapes. */
const TREND_RADIUS = 6;
/** Box radius averaged before the maximum: one noisy cell is not an invention. */
const PATCH_RADIUS = 2;

/**
 * Largest compact mean luminance change, in the 0..1 luminance scale, after removing each image's
 * global mean and the 13x13-cell trend. Measured:
 *
 * - accepts, synthetic 256 px pairs: a painted material 0.008, a 20% brightness ramp 0.010;
 * - accepts, the painter itself on the sample courtyard at 128-1024 px: a grain-only repaint of the
 *   view it was given 0.002-0.009;
 * - rejects: a staircase 0.125, an added volume 0.129, an arch 0.222 (0.24-0.32 when painted by a
 *   stub image model at 128-1024 px), a dark window 0.23-0.35, a door 0.275.
 *
 * 0.05 sits about 5x above the largest accepted value and 2.5x below the smallest rejected one.
 * (A plain difference of means rejected a 15% darker repaint of the same image at 0.15; the trend
 * subtraction is what separates a contrast change from a shape.)
 */
export const STRUCTURE_DEVIATION_LIMIT = 0.05;

/**
 * Luminance (Rec. 709) of one top-down RGBA8 image, box-averaged down to `grid` x `grid`. With a
 * `mask` (1 = level geometry), only those pixels count: the sky is background the model may repaint,
 * and no sky pixel is ever projected into the atlas.
 */
export function lowFrequencyLuminance(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  grid = STRUCTURE_GRID,
  mask?: Uint8Array,
): Float32Array {
  const sums = new Float64Array(grid * grid);
  const counts = new Float64Array(grid * grid);
  for (let y = 0; y < height; y++) {
    const gy = Math.min(grid - 1, Math.floor(((y + 0.5) * grid) / height));
    for (let x = 0; x < width; x++) {
      const pixel = y * width + x;
      if (mask !== undefined && !mask[pixel]) continue;
      const gx = Math.min(grid - 1, Math.floor(((x + 0.5) * grid) / width));
      const p = 4 * pixel;
      const cell = gy * grid + gx;
      sums[cell] = (sums[cell] ?? 0) + (0.2126 * rgba[p]! + 0.7152 * rgba[p + 1]! + 0.0722 * rgba[p + 2]!) / 255;
      counts[cell] = (counts[cell] ?? 0) + 1;
    }
  }
  const out = new Float32Array(grid * grid);
  for (let i = 0; i < out.length; i++) out[i] = counts[i]! > 0 ? sums[i]! / counts[i]! : 0;
  return out;
}

/** Share of each grid cell that the mask covers (1 = the whole cell is level geometry). */
function maskCoverage(mask: Uint8Array, width: number, height: number, grid: number): Float32Array {
  const counts = new Float32Array(grid * grid);
  const totals = new Float32Array(grid * grid);
  for (let y = 0; y < height; y++) {
    const gy = Math.min(grid - 1, Math.floor(((y + 0.5) * grid) / height));
    for (let x = 0; x < width; x++) {
      const gx = Math.min(grid - 1, Math.floor(((x + 0.5) * grid) / width));
      const cell = gy * grid + gx;
      if (mask[y * width + x]) counts[cell] = (counts[cell] ?? 0) + 1;
      totals[cell] = (totals[cell] ?? 0) + 1;
    }
  }
  const out = new Float32Array(grid * grid);
  for (let i = 0; i < out.length; i++) out[i] = totals[i]! > 0 ? counts[i]! / totals[i]! : 0;
  return out;
}

/** Box sums over a grid, with a summed-area table so a 13x13 patch costs one lookup. */
function boxTable(values: Float32Array, grid: number): (x0: number, y0: number, x1: number, y1: number) => number {
  const stride = grid + 1;
  const integral = new Float64Array(stride * stride);
  for (let y = 0; y < grid; y++) {
    let row = 0;
    for (let x = 0; x < grid; x++) {
      row += values[y * grid + x]!;
      integral[(y + 1) * stride + (x + 1)] = integral[y * stride + (x + 1)]! + row;
    }
  }
  return (x0, y0, x1, y1) =>
    integral[y1 * stride + x1]! - integral[y0 * stride + x1]! - integral[y1 * stride + x0]! + integral[y0 * stride + x0]!;
}

function boxMean(values: Float32Array, grid: number, radius: number): Float32Array {
  const table = boxTable(values, grid);
  const out = new Float32Array(grid * grid);
  for (let y = 0; y < grid; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(grid, y + radius + 1);
    for (let x = 0; x < grid; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(grid, x + radius + 1);
      out[y * grid + x] = table(x0, y0, x1, y1) / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

/**
 * How much compact low-frequency luminance the generated image adds or removes, ignoring its overall
 * brightness and any smooth lighting trend: the maximum, over 5x5-cell patches, of the mean deviation
 * after a 13x13-cell box trend is subtracted. 0 = same structure.
 */
export function structureDeviation(
  generated: Uint8ClampedArray | Uint8Array,
  reference: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  grid = STRUCTURE_GRID,
  mask?: Uint8Array,
): number {
  let validCells: Uint8Array | undefined;
  if (mask !== undefined) {
    const coverage = maskCoverage(mask, width, height, grid);
    validCells = new Uint8Array(grid * grid);
    for (let i = 0; i < validCells.length; i++) validCells[i] = coverage[i]! > 0.5 ? 1 : 0; // majority geometry
  }
  return structureDeviationOfLuminance(
    lowFrequencyLuminance(generated, width, height, grid, mask),
    lowFrequencyLuminance(reference, width, height, grid, mask),
    grid,
    validCells,
  );
}

export function structureDeviationOfLuminance(
  a: Float32Array,
  b: Float32Array,
  grid = STRUCTURE_GRID,
  valid?: Uint8Array,
): number {
  let included = 0;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < grid * grid; i++) {
    if (valid !== undefined && !valid[i]) continue;
    included += 1;
    sumA += a[i]!;
    sumB += b[i]!;
  }
  if (included === 0) return 0;
  const meanA = sumA / included;
  const meanB = sumB / included;
  const difference = new Float32Array(grid * grid);
  for (let i = 0; i < difference.length; i++) {
    if (valid !== undefined && !valid[i]) continue;
    difference[i] = (a[i]! - meanA) - (b[i]! - meanB);
  }
  // Remove the smooth trend (a darker style or a lighting gradient), keep compact shapes.
  const trend = boxMean(difference, grid, TREND_RADIUS);
  const compact = new Float32Array(grid * grid);
  for (let i = 0; i < compact.length; i++) compact[i] = difference[i]! - trend[i]!;
  const patches = boxMean(compact, grid, PATCH_RADIUS);
  const support = boxTable(
    Float32Array.from({ length: grid * grid }, (_, i) => (valid === undefined || valid[i] ? 1 : 0)),
    grid,
  );
  let worst = 0;
  for (let y = 0; y < grid; y++) {
    const y0 = Math.max(0, y - PATCH_RADIUS);
    const y1 = Math.min(grid, y + PATCH_RADIUS + 1);
    for (let x = 0; x < grid; x++) {
      const x0 = Math.max(0, x - PATCH_RADIUS);
      const x1 = Math.min(grid, x + PATCH_RADIUS + 1);
      if (support(x0, y0, x1, y1) < 5) continue; // a patch with almost no level geometry says nothing
      const mean = Math.abs(patches[y * grid + x]!);
      if (mean > worst) worst = mean;
    }
  }
  return worst;
}

/** Whether the generated view paints a shape the image it was given does not have. */
export function rejectsStructure(deviation: number, limit = STRUCTURE_DEVIATION_LIMIT): boolean {
  return deviation > limit;
}
