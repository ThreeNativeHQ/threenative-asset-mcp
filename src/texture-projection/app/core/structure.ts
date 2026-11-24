/**
 * Did the model invent geometry? A dark arch, doorway, passage or an added volume is a *compact,
 * closed* region that is much darker (or brighter) than the clay surface it sits on, and the clay
 * render has no edge inside that surface. Painting a material, a stain, a shadow band or a lighting
 * gradient is not: materials and stains cover a whole surface (so the surface's own median follows
 * them), stains and grain are soft or thin, and a shadow band runs along an edge the clay already has.
 *
 * So the check segments the clay image into surfaces (regions between the clay's own edges), compares
 * the generated image with each surface's own median and scale, and only then looks for a compact,
 * closed blob whose boundary is *inside* that surface. Comparing each surface with itself is what
 * makes the check blind to a per-surface albedo change: repainting a light-gray wall dark ochre is a
 * new median, not a new shape.
 *
 * Pure functions: unit-tested in node, no DOM, no GL. Calibrated on the 60 real FLUX 3 Klein views of
 * the courtyard run `courtyard-mwubecio` (fixtures under tests/fixtures/prd916-structure): every real
 * view scores at most 0.064 and the four synthetic inventions pasted into those views score
 * 0.270-0.495.
 */

/** Cells across the comparison grid (64: one cell is 16 view pixels at 1024, 32 at 2048). */
export const STRUCTURE_GRID = 64;
/** Clay luminance step between two neighbouring cells over which the clay has an edge, not a surface. */
const CLAY_EDGE_STEP = 0.03;
/** Cells this many standard deviations from their surface's median are candidates for a blob. */
const BLOB_DEVIATIONS = 2;
/** Floor for a surface's own scale (5 luminance levels): a perfectly flat surface still has a scale. */
const MIN_SURFACE_SCALE = 0.02;
/** The blob's boundary must be a real step from the surface around it: this many scales. */
const BOUNDARY_STEP = 1.5;
/** Surfaces under this share of the level's geometry are detail (a step riser), not a wall. */
const MIN_SURFACE_SHARE = 0.01;
/** A blob this big already weighs fully: "a door/arch/window is about 3% of the surface it sits on". */
const FULL_WEIGHT_AREA_SHARE = 0.03;
/** Smallest blob worth calling an opening: 0.49% of the view (20 of 4096 cells: a window at 1024 px). */
const MIN_BLOB_CELLS = 0.0049;
/** A blob bigger than half its surface is the material, not a shape on it. */
const MAX_BLOB_SHARE = 0.5;
/** Openings are upright: no wider than twice their height, and no 10:1 sliver in either direction. */
const MAX_WIDTH_PER_HEIGHT = 2;
const MAX_BOUNDS_ASPECT = 4;
/**
 * Closed and compact: this share of the blob's perimeter has surface (not another segment) behind it —
 * unless the blob reaches the ground (or a frame) along one of its *short* sides, which is how a real
 * doorway or arch sits. A shadow band under the roof tiles runs along its long side and is not closed.
 */
const MIN_CLOSED_SHARE = 0.8;
/** Share of the blob's bounding box the blob fills (a doorway 0.9, a shadow wedge 0.3). */
const MIN_BLOB_FILL = 0.45;
/** One-cell margin from the image border: an opening cut off by the frame is not inside a surface. */
const BORDER_MARGIN = 1;

/**
 * A view is rejected when a compact, closed blob covers at least ~3% of its clay surface (weighted
 * linearly below that) and differs from the surface around it by more than this share of the
 * luminance range. In luminance units, not percentages of a difference of means:
 *
 * - accepts, the 60 real views of `courtyard-mwubecio` (128 px fixture copies): the strongest is view
 *   43 at 0.064, a shadowed strip at a wall corner; views 5 and 19 follow at 0.059 and 0.029, the
 *   other 57 score 0.000 — real materials, not invented geometry;
 * - accepts, the same views at 256, 1024 and 2048 px directly from the run: at most 0.089, same views
 *   (the run is never re-bought to check it);
 * - rejects, synthetic inventions pasted into the real generation: a dark arched doorway 0.356, a
 *   dark window 0.431, a passage/void 0.495, an added box 0.270.
 *
 * 0.20 is 2.2x above the strongest real view at production resolution and 1.35x below the weakest
 * invention; the margin (min rejected / max accepted) is 0.270 / 0.064 = 4.2x on the fixtures and
 * 0.270 / 0.089 = 3.0x at 2048 px.
 */
export const STRUCTURE_DEVIATION_LIMIT = 0.2;

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

/** Median of `values` over `indices` (a sorted copy; the grids are small). */
function medianOf(values: Float32Array, indices: readonly number[]): number {
  if (indices.length === 0) return 0;
  const copy = new Float64Array(indices.length);
  for (let i = 0; i < indices.length; i++) copy[i] = values[indices[i]!]!;
  copy.sort();
  const middle = copy.length >> 1;
  return copy.length % 2 === 1 ? copy[middle]! : (copy[middle - 1]! + copy[middle]!) / 2;
}

/**
 * 4-neighbour connected components of `cells`, as `labels` (-1 outside) and, per label, its cells.
 * Breadth-first with an explicit stack: a 64x64 grid never recurses deep enough to matter but the
 * stack keeps it out of the engine's call stack.
 */
function components(cells: Uint8Array, grid: number): { labels: Int32Array; groups: number[][] } {
  const labels = new Int32Array(cells.length).fill(-1);
  const groups: number[][] = [];
  const stack: number[] = [];
  for (let start = 0; start < cells.length; start++) {
    if (!cells[start] || labels[start] !== -1) continue;
    const id = groups.length;
    const group: number[] = [];
    labels[start] = id;
    stack.push(start);
    while (stack.length > 0) {
      const i = stack.pop()!;
      group.push(i);
      const x = i % grid;
      const y = (i - x) / grid;
      const neighbours = [
        x > 0 ? i - 1 : -1,
        x + 1 < grid ? i + 1 : -1,
        y > 0 ? i - grid : -1,
        y + 1 < grid ? i + grid : -1,
      ];
      for (const j of neighbours) {
        if (j < 0 || !cells[j] || labels[j] !== -1) continue;
        labels[j] = id;
        stack.push(j);
      }
    }
    groups.push(group);
  }
  return { labels, groups };
}

/**
 * The clay's own surfaces: the cells between its edges. A neighbour step over `CLAY_EDGE_STEP` is a
 * silhouette or a crease; the flat regions inside belong to one surface. The clay is box-smoothed
 * (3x3) before the step test: a box filter keeps a step but removes one-cell render noise, and a
 * surface edge is wider than one cell anyway (this is what makes a 128 px fixture and a 2048 px view
 * segment alike). Two surfaces of the same flat gray merge here (the courtyard's wall and floor do in
 * a few views) — that only makes the surface bigger, never invents an edge inside one.
 */
function surfacesOf(
  clay: Float32Array,
  valid: Uint8Array,
  grid: number,
): { labels: Int32Array; groups: number[][] } {
  // Denoise over level geometry only, with a 3x3 median: the cells outside the mask hold no clay
  // (they are sky), and averaging their zeros in would carve an edge along every silhouette. A median,
  // not a mean: it removes a stray cell without smearing a one-cell step across two cells, which a box
  // filter does (a 7% step then reads as two 2% differences and never becomes an edge).
  const denoised = new Float32Array(clay.length);
  const window: number[] = [];
  for (let y = 0; y < grid; y++) {
    for (let x = 0; x < grid; x++) {
      if (!valid[y * grid + x]) continue;
      window.length = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= grid || ny >= grid) continue;
          if (!valid[ny * grid + nx]) continue;
          window.push(clay[ny * grid + nx]!);
        }
      }
      window.sort((a, b) => a - b);
      denoised[y * grid + x] = window[window.length >> 1]!;
    }
  }
  const flat = new Uint8Array(valid.length);
  for (let i = 0; i < valid.length; i++) flat[i] = valid[i] ? 1 : 0;
  for (let y = 0; y < grid; y++) {
    for (let x = 0; x < grid; x++) {
      const i = y * grid + x;
      if (!valid[i]) continue;
      const rightValid = x + 1 < grid && valid[i + 1];
      const downValid = y + 1 < grid && valid[i + grid];
      // A surface ends where the level does: a neighbour outside the mask is its boundary, not a step.
      if (!rightValid || !downValid) {
        flat[i] = 0;
        continue;
      }
      const right = denoised[i + 1]!;
      const down = denoised[i + grid]!;
      if (Math.abs(denoised[i]! - right) > CLAY_EDGE_STEP || Math.abs(denoised[i]! - down) > CLAY_EDGE_STEP) {
        flat[i] = 0;
        flat[i + 1] = 0;
        flat[i + grid] = 0;
      }
    }
  }
  return components(flat, grid);
}

export interface StructureBlob {
  readonly score: number;
  readonly cells: number;
  readonly share: number;
  readonly width: number;
  readonly height: number;
  readonly fill: number;
  readonly closed: number;
  readonly boundaryStep: number;
  readonly contrast: number;
}

/**
 * The strongest compact, closed deviation of `generated` from `reference`, per clay surface, in
 * luminance units (0 = every surface keeps its own material). `valid` marks the cells that show
 * level geometry: the sky is no surface and nothing is projected there.
 */
export function structureDeviationOfLuminance(
  generated: Float32Array,
  reference: Float32Array,
  grid = STRUCTURE_GRID,
  valid?: Uint8Array,
): number {
  return strongestBlob(generated, reference, grid, valid)?.score ?? 0;
}

export function strongestBlob(
  generated: Float32Array,
  reference: Float32Array,
  grid = STRUCTURE_GRID,
  valid?: Uint8Array,
): StructureBlob | undefined {
  const cells = grid * grid;
  const geometry = new Uint8Array(cells);
  let geometryCells = 0;
  for (let i = 0; i < cells; i++) {
    geometry[i] = valid === undefined || valid[i] ? 1 : 0;
    if (geometry[i]) geometryCells += 1;
  }
  if (geometryCells === 0) return undefined;
  const { labels: surfaces, groups } = surfacesOf(reference, geometry, grid);
  let best: StructureBlob | undefined;
  for (const surfaceCells of groups) {
    if (surfaceCells.length === 0) continue;
    if (surfaceCells.length < Math.max(16, MIN_SURFACE_SHARE * cells)) continue;
    const median = medianOf(generated, surfaceCells);
    const deviations = new Float32Array(cells);
    const scale = Math.max(
      MIN_SURFACE_SCALE,
      1.4826 * medianOf(
        (() => {
          const absolute = new Float32Array(cells);
          for (const i of surfaceCells) absolute[i] = Math.abs(generated[i]! - median);
          return absolute;
        })(),
        surfaceCells,
      ),
    );
    for (const i of surfaceCells) deviations[i] = (generated[i]! - median) / scale;
    for (const sign of [-1, 1]) {
      const candidatesOf = new Uint8Array(cells);
      for (const i of surfaceCells) if (sign * deviations[i]! > BLOB_DEVIATIONS) candidatesOf[i] = 1;
      if (!candidatesOf.some((value) => value)) continue;
      const candidateLabels = components(candidatesOf, grid).labels;
      const candidateGroups = new Map<number, number[]>();
      for (const i of surfaceCells) {
        const label = candidateLabels[i]!;
        if (label < 0) continue;
        const group = candidateGroups.get(label);
        if (group) group.push(i);
        else candidateGroups.set(label, [i]);
      }
      for (const blob of candidateGroups.values()) {
        const found = scoreBlob(blob, surfaceCells, surfaces, generated, deviations, grid);
        if (found && (best === undefined || found.score > best.score)) best = found;
      }
    }
  }
  return best;
}

/** Everything the blob test needs about one candidate, or undefined when it is not an opening. */
function scoreBlob(
  blob: readonly number[],
  surfaceCells: readonly number[],
  surfaces: Int32Array,
  generated: Float32Array,
  deviations: Float32Array,
  grid: number,
): StructureBlob | undefined {
  let minX = grid;
  let maxX = -1;
  let minY = grid;
  let maxY = -1;
  for (const i of blob) {
    const x = i % grid;
    const y = (i - x) / grid;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const surface = surfaceCells.length;
  const share = blob.length / surface;
  if (blob.length < Math.max(Math.round(MIN_BLOB_CELLS * grid * grid), 0.005 * surface)) return undefined;
  if (share > MAX_BLOB_SHARE) return undefined;
  if (Math.max(width, height) > MAX_BOUNDS_ASPECT * Math.min(width, height)) return undefined;
  if (width > MAX_WIDTH_PER_HEIGHT * height) return undefined;
  if (Math.min(width, height) < 2) return undefined;
  if (blob.length / (width * height) < MIN_BLOB_FILL) return undefined;
  if (
    minX < BORDER_MARGIN ||
    minY < BORDER_MARGIN ||
    maxX >= grid - BORDER_MARGIN ||
    maxY >= grid - BORDER_MARGIN
  ) {
    return undefined;
  }
  const inBlob = new Uint8Array(grid * grid);
  for (const i of blob) inBlob[i] = 1;
  const ring: number[] = [];
  let perimeter = 0;
  let closed = 0;
  /** Boundary cells on each side of the bounding box, and how many of those leave the surface there. */
  const sides = {
    top: { cells: 0, open: 0 },
    bottom: { cells: 0, open: 0 },
    left: { cells: 0, open: 0 },
    right: { cells: 0, open: 0 },
  };
  for (const i of blob) {
    const x = i % grid;
    const y = (i - x) / grid;
    if (y === minY) sides.top.cells += 1;
    if (y === maxY) sides.bottom.cells += 1;
    if (x === minX) sides.left.cells += 1;
    if (x === maxX) sides.right.cells += 1;
    const neighbours: [number, keyof typeof sides | undefined][] = [
      [x > 0 ? i - 1 : -1, x === minX ? "left" : undefined],
      [x + 1 < grid ? i + 1 : -1, x === maxX ? "right" : undefined],
      [y > 0 ? i - grid : -1, y === minY ? "top" : undefined],
      [y + 1 < grid ? i + grid : -1, y === maxY ? "bottom" : undefined],
    ];
    for (const [j, side] of neighbours) {
      if (j < 0 || inBlob[j]) continue;
      // A side of the blob's boundary. Same surface behind it? Then the edge is inside a surface.
      perimeter += 1;
      if (surfaces[j] === surfaces[i]) {
        closed += 1;
        ring.push(j);
      } else if (side !== undefined) {
        sides[side].open += 1;
      }
    }
  }
  if (perimeter === 0 || ring.length === 0) return undefined;
  // A doorway or an arch can stand on the surface's own boundary (the floor it opens onto) — but only
  // along one of its short sides. A shadow band under the roof tiles runs along its long side.
  const openSides = (Object.keys(sides) as (keyof typeof sides)[]).filter(
    (side) => sides[side].open >= Math.max(2, 0.5 * sides[side].cells),
  );
  const shortSide = Math.min(width, height) + 1;
  const opensOnShortSide =
    openSides.length === 1 && sides[openSides[0]!].open <= shortSide;
  if (closed / perimeter < MIN_CLOSED_SHARE && !opensOnShortSide) return undefined;
  const boundaryStep = Math.abs(medianOf(deviations, blob) - medianOf(deviations, ring));
  if (boundaryStep < BOUNDARY_STEP) return undefined;
  const contrast = Math.abs(medianOf(generated, blob) - medianOf(generated, ring));
  const weight = Math.min(1, blob.length / (FULL_WEIGHT_AREA_SHARE * surface));
  return {
    score: contrast * weight,
    cells: blob.length,
    share,
    width,
    height,
    fill: blob.length / (width * height),
    closed: closed / perimeter,
    boundaryStep,
    contrast,
  };
}

/**
 * How much invented geometry `generated` adds over the clay `reference`: the strongest compact,
 * closed opening or volume inside one clay surface, in luminance units. 0 = every surface keeps its
 * own material. `mask` marks level geometry (sky excluded), as in `lowFrequencyLuminance`.
 */
export function structureDeviation(
  generated: Uint8ClampedArray | Uint8Array,
  reference: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  grid = STRUCTURE_GRID,
  mask?: Uint8Array,
): number {
  const generatedLuminance = lowFrequencyLuminance(generated, width, height, grid, mask);
  const referenceLuminance = lowFrequencyLuminance(reference, width, height, grid, mask);
  let valid: Uint8Array | undefined;
  if (mask !== undefined) {
    const coverage = maskCoverage(mask, width, height, grid);
    valid = new Uint8Array(grid * grid);
    for (let i = 0; i < valid.length; i++) valid[i] = coverage[i]! > 0.5 ? 1 : 0; // majority geometry
  }
  return structureDeviationOfLuminance(generatedLuminance, referenceLuminance, grid, valid);
}

/** Whether the generated view paints a shape the clay it was given does not have. */
export function rejectsStructure(deviation: number, limit = STRUCTURE_DEVIATION_LIMIT): boolean {
  return deviation > limit;
}

/** A cell counts as sky when this share of its pixels is outside the geometry mask. */
const SKY_CELL_SHARE = 0.98;
/** Luminance departure (0..1) of a sky cell's mean from what the clay's own sky showed there. */
const SKY_DEPARTURE = 0.1;
/** Within-cell luminance deviation above which a cell is textured (brick, stone, coping), not sky. */
const SKY_TEXTURE = 0.03;
/** Fewer sky cells than this is no evidence either way: the view (almost) does not see the sky. */
const MIN_SKY_CELLS = 8;

/**
 * A view is rejected when the generation paints solid surface over at least this share of the cells the
 * clay left as sky: a wall raised over the backdrop, a new coping, cobbles where the level has no
 * ground. That is the same invention `structureDeviation` catches inside a surface, seen outside the
 * level's silhouette, where no texel is projected and the defect only shows when the camera moves.
 *
 * - accepts 27 of the 40 views of `courtyard-mwuijnnl` (FLUX 3 Klein, 2048 px): the strongest is view 32
 *   at 0.135, and 11 of the 27 score 0.000;
 * - rejects the 13 that paint the sky: views 13 at 0.908 and 11, 14, 17, 18, 20, 22, 24, 30, 31, 36, 37
 *   at 0.702-1.000, view 33 at 0.439 (a wall across part of the sky);
 * - the same 13/27 split at 2048, 512, 256 and 128 px, and at every departure/texture pair in
 *   {0.10, 0.15, 0.20, 0.25} x {0.03, 0.04, 0.05, 0.06}.
 *
 * 0.20 is 1.48x above the strongest accepted view and 2.2x below the weakest rejected one; the margin
 * (min rejected / max accepted) is 0.439 / 0.135 = 3.3x.
 */
export const SILHOUETTE_MISMATCH_LIMIT = 0.2;

/**
 * Share (0..1) of the cells the clay left as sky that `generated` painted solid surface into. A cell is
 * clay sky when at least `SKY_CELL_SHARE` of its pixels is outside `geometryMask` (1 = level geometry);
 * it is solid when the generation's mean luminance there departs from what the clay's own sky showed, or
 * when the cell is textured instead of the near-flat backdrop (a flat region of another colour would
 * pass the departure test on a light sky, clouds would pass a bare texture test). 0 = every cell the
 * clay left as sky is still sky, and 0 when the clay shows almost no sky (no evidence either way).
 *
 * Pure, on the same grid as the structure check: no DOM, no GL, unit-tested in node.
 */
export function silhouetteMismatch(
  generated: Uint8ClampedArray | Uint8Array,
  clay: Uint8ClampedArray | Uint8Array,
  geometryMask: Uint8Array,
  width: number,
  height: number,
  grid = STRUCTURE_GRID,
): number {
  const cells = grid * grid;
  const sky = new Float64Array(cells);
  const genSum = new Float64Array(cells);
  const genSumSq = new Float64Array(cells);
  const claySum = new Float64Array(cells);
  for (let y = 0; y < height; y++) {
    const gy = Math.min(grid - 1, Math.floor(((y + 0.5) * grid) / height));
    for (let x = 0; x < width; x++) {
      const pixel = y * width + x;
      const gx = Math.min(grid - 1, Math.floor(((x + 0.5) * grid) / width));
      const cell = gy * grid + gx;
      const p = 4 * pixel;
      const gl = (0.2126 * generated[p]! + 0.7152 * generated[p + 1]! + 0.0722 * generated[p + 2]!) / 255;
      const cl = (0.2126 * clay[p]! + 0.7152 * clay[p + 1]! + 0.0722 * clay[p + 2]!) / 255;
      if (!geometryMask[pixel]) sky[cell] = (sky[cell] ?? 0) + 1;
      genSum[cell] = (genSum[cell] ?? 0) + gl;
      genSumSq[cell] = (genSumSq[cell] ?? 0) + gl * gl;
      claySum[cell] = (claySum[cell] ?? 0) + cl;
    }
  }
  const pixelsPerCell = (width * height) / cells;
  let skyCells = 0;
  let solid = 0;
  for (let i = 0; i < cells; i++) {
    const count = sky[i]!;
    if (count < SKY_CELL_SHARE * pixelsPerCell) continue;
    skyCells += 1;
    const mean = genSum[i]! / count;
    const variance = Math.max(0, genSumSq[i]! / count - mean * mean);
    const departure = Math.abs(mean - claySum[i]! / count);
    if (departure > SKY_DEPARTURE || Math.sqrt(variance) > SKY_TEXTURE) solid += 1;
  }
  if (skyCells < MIN_SKY_CELLS) return 0;
  return solid / skyCells;
}
