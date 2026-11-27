import * as THREE from "three";
import { describe, expect, it } from "vitest";

import {
  SWATCH_MAX_INCIDENCE_DEG,
  SWATCH_SIZE,
  pickSwatch,
  rectifySwatch,
  sharpenSwatch,
  tileSwatch,
  type SwatchCandidate,
  type SwatchTile,
  type ViewGeometry,
} from "../src/texture-projection/app/core/swatch.js";
import { makeCamera, type ViewSpec } from "../src/texture-projection/app/core/views.js";

/**
 * The swatch math on a synthetic world (PRD-916 phases 2m and 2n): a camera, one infinite plane, and
 * an image painted on that plane at a known metric scale. The swatch must read the pattern back at its
 * own true scale — the same period along both of its axes, within 2% of the real one — and it must
 * tile: an axis with a clear repeat is cropped to whole repeats so it wraps on a joint, an axis
 * without one is cross-faded, and a floor may be cut from a view that sees it obliquely.
 */

/** Synthetic view and generation size, px. */
const VIEW = 1024;
const FOV = 90;
/** Side of one checker square, metres. */
const PERIOD = 0.25;
/** The rectified patch's side, metres (the wall default). */
const SIDE = 1.5;

type Triple = [number, number, number];

/** The camera a player would stand at: one spec looking from `eye` at `target`. */
function lookAt(id: number, eye: Triple, target: Triple): ViewSpec {
  const dx = target[0] - eye[0];
  const dy = target[1] - eye[1];
  const dz = target[2] - eye[2];
  const length = Math.hypot(dx, dy, dz);
  return {
    id,
    position: eye,
    // makeCamera's convention: yaw 0 looks down -Z, pitch is up from the horizon.
    yaw: Math.atan2(-dx, -dz),
    pitch: Math.asin(dy / length),
    fov: FOV,
  };
}

interface SyntheticView {
  /** What the GPU would read back for this view: world position + distance, normal + label. */
  readonly geometry: ViewGeometry;
  /** 1 where the view shows the plane (0 = sky): the class mask the search takes. */
  readonly area: Uint8Array;
  /** The image the model "painted": the plane's pattern, pixel by pixel. */
  readonly generation: Uint8ClampedArray;
}

/**
 * One synthetic view of an infinite plane through `point` with normal `normal`, whose paint is
 * `pattern(worldX, worldY, worldZ)`. Each image pixel is the pattern at the world point its centre ray
 * hits; a ray that never meets the plane is sky.
 */
function renderPlane(
  spec: ViewSpec,
  point: Triple,
  normal: Triple,
  pattern: (x: number, y: number, z: number) => Triple,
): SyntheticView {
  const camera = makeCamera(spec);
  const eye = camera.position;
  const inverse = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).invert();
  const e = inverse.elements;
  const pixels = VIEW * VIEW;
  const position = new Float32Array(4 * pixels);
  const normals = new Float32Array(4 * pixels);
  const generation = new Uint8ClampedArray(4 * pixels);
  const area = new Uint8Array(pixels);
  for (let j = 0; j < VIEW; j++) {
    const ndcY = 1 - ((j + 0.5) / VIEW) * 2;
    for (let i = 0; i < VIEW; i++) {
      const ndcX = ((i + 0.5) / VIEW) * 2 - 1;
      const w = e[3]! * ndcX + e[7]! * ndcY + e[11]! * 0.5 + e[15]!;
      const wx = (e[0]! * ndcX + e[4]! * ndcY + e[8]! * 0.5 + e[12]!) / w;
      const wy = (e[1]! * ndcX + e[5]! * ndcY + e[9]! * 0.5 + e[13]!) / w;
      const wz = (e[2]! * ndcX + e[6]! * ndcY + e[10]! * 0.5 + e[14]!) / w;
      const dx = wx - eye.x;
      const dy = wy - eye.y;
      const dz = wz - eye.z;
      const length = Math.hypot(dx, dy, dz);
      const denominator = (dx * normal[0] + dy * normal[1] + dz * normal[2]) / length;
      if (!(Math.abs(denominator) > 1e-6)) continue;
      const offset = (point[0] - eye.x) * normal[0] + (point[1] - eye.y) * normal[1] + (point[2] - eye.z) * normal[2];
      const t = offset / denominator;
      if (!(t > 0)) continue;
      const hitX = eye.x + (dx / length) * t;
      const hitY = eye.y + (dy / length) * t;
      const hitZ = eye.z + (dz / length) * t;
      const at = j * VIEW + i;
      position[4 * at] = hitX;
      position[4 * at + 1] = hitY;
      position[4 * at + 2] = hitZ;
      position[4 * at + 3] = t;
      normals[4 * at] = normal[0];
      normals[4 * at + 1] = normal[1];
      normals[4 * at + 2] = normal[2];
      normals[4 * at + 3] = 1; // label 0 + 1
      area[at] = 1;
      const [r, g, b] = pattern(hitX, hitY, hitZ);
      generation[4 * at] = r;
      generation[4 * at + 1] = g;
      generation[4 * at + 2] = b;
      generation[4 * at + 3] = 255;
    }
  }
  return { geometry: { spec, size: VIEW, position, normal: normals }, area, generation };
}

/** A square checker painted at `PERIOD` metres on the plane, its cells aligned to the plane's x/y. */
const checker = (x: number, y: number): Triple => {
  const dark = (Math.floor(x / PERIOD) + Math.floor(y / PERIOD)) & 1;
  return dark === 0 ? [230, 230, 230] : [25, 25, 25];
};

/** A smooth paint: a 0.6 m wave in x on red, a 0.8 m wave in y on green. It has no hard edges. */
const waves = (x: number, y: number): Triple => [
  128 + 100 * Math.sin((2 * Math.PI * x) / 0.6),
  128 + 100 * Math.sin((2 * Math.PI * y) / 0.8),
  128,
];

/**
 * Broad 0.25 m bands of dark and light: a repeat the autocorrelation sees clearly (six of them fit the
 * patch) but which is a tonal patch, half the period dark, not a joint. Moss on a sett floor looks like
 * this, and cutting a swatch there would butt two unrelated patches together.
 */
const blotches = (x: number): Triple => (((x % PERIOD) + PERIOD) % PERIOD) < PERIOD / 2 ? [40, 40, 40] : [220, 220, 220];

/** A running bond: 0.3 m bricks, 0.125 m courses, a 12 mm mortar joint, every other course offset. */
const BRICK_LONG = 0.3;
const BRICK_HIGH = 0.125;
const MORTAR = 0.012;
const brick = (x: number, y: number): Triple => {
  const course = Math.floor(y / BRICK_HIGH);
  const offset = (((course % 2) + 2) % 2) * (BRICK_LONG / 2);
  const along = (((x - offset) % BRICK_LONG) + BRICK_LONG) % BRICK_LONG;
  const up = ((y % BRICK_HIGH) + BRICK_HIGH) % BRICK_HIGH;
  return along < MORTAR || up < MORTAR ? [70, 70, 70] : [180, 140, 120];
};

/** A painted image with its own dimensions: a swatch is only square while nothing was cropped. */
interface Frame {
  readonly pixels: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

const frameOf = (tile: SwatchTile): Frame => ({ pixels: tile.pixels, width: tile.width, height: tile.height });
/** A rectified patch as it comes off `rectifySwatch`: the whole square, before any crop. */
const rectifiedFrame = (pixels: Uint8ClampedArray): Frame => ({ pixels, width: SWATCH_SIZE, height: SWATCH_SIZE });

/** One channel of a frame, along a row (`horizontal`) or down a column, at `line`. */
function sample(frame: Frame, line: number, step: number, channel: number, horizontal: boolean): number {
  const at = horizontal ? line * frame.width + step : step * frame.width + line;
  return frame.pixels[4 * at + channel]!;
}

/**
 * The pattern's metric period along one line, in pixels: a checker alternates from cell to cell, so
 * its crossings are one cell apart, and their positions against their index give the cell size by
 * least squares (each crossing has its own sub-pixel error; a fit does not add them up). With
 * `entering` only the light-to-dark crossings count, which is one per mortar joint: a joint is a
 * stripe, so counting both of its edges would fit half its spacing.
 */
function periodAlong(frame: Frame, line: number, channel: number, horizontal: boolean, entering: boolean): number {
  const length = horizontal ? frame.width : frame.height;
  const crossings: number[] = [];
  let previous = sample(frame, line, 0, channel, horizontal) > 128;
  for (let step = 1; step < length; step++) {
    const value = sample(frame, line, step, channel, horizontal) > 128;
    if (value !== previous && (!entering || value)) crossings.push(step - 0.5);
    previous = value;
  }
  if (crossings.length < 4) return Number.NaN;
  const meanIndex = (crossings.length - 1) / 2;
  const meanPosition = crossings.reduce((sum, position) => sum + position, 0) / crossings.length;
  let covariance = 0;
  let variance = 0;
  crossings.forEach((position, index) => {
    covariance += (index - meanIndex) * (position - meanPosition);
    variance += (index - meanIndex) ** 2;
  });
  return covariance / variance;
}

/** The median period over a few lines, so one line that happens to sit on a cell edge cannot decide it. */
function medianPeriod(frame: Frame, channel: number, horizontal: boolean, entering = false): number {
  const span = horizontal ? frame.height : frame.width;
  const periods = [0.33, 0.37, 0.41, 0.55, 0.59]
    .map((share) => periodAlong(frame, Math.round(share * span), channel, horizontal, entering))
    .filter((period) => Number.isFinite(period))
    .sort((a, b) => a - b);
  return periods[Math.floor(periods.length / 2)]!;
}

/** Luminance of every row of a frame, the profile a course shows in. */
function rowLuminance(frame: Frame): Float64Array {
  const out = new Float64Array(frame.height);
  for (let y = 0; y < frame.height; y++) {
    let sum = 0;
    for (let x = 0; x < frame.width; x++) {
      const at = 4 * (y * frame.width + x);
      sum += 0.299 * frame.pixels[at]! + 0.587 * frame.pixels[at + 1]! + 0.114 * frame.pixels[at + 2]!;
    }
    out[y] = sum / frame.width;
  }
  return out;
}

/** The row profile of `frame` read across the wrap: `span` rows before the seam, then `span` after. */
function acrossSeam(frame: Frame, span: number): number[] {
  const rows = rowLuminance(frame);
  return Array.from({ length: 2 * span + 1 }, (_, i) => rows[(((i - span) % frame.height) + frame.height) % frame.height]!);
}

/** The runs of rows darker than `mid`, in image order: one run per mortar joint. */
function joints(rows: Float64Array, mid: number): number[] {
  const runs: number[] = [];
  let run = 0;
  for (const value of rows) {
    if (value < mid) run++;
    else if (run > 0) {
      runs.push(run);
      run = 0;
    }
  }
  if (run > 0) runs.push(run);
  return runs;
}

/** The rows below `mid` that straddle the wrap: the two ends of the tile are one joint across it. */
function seamJoint(rows: Float64Array, mid: number): number {
  let before = 0;
  for (let at = rows.length - 1; at >= 0 && rows[at]! < mid; at--) before++;
  let after = 0;
  for (let at = 0; at < rows.length && rows[at]! < mid; at++) after++;
  return before + after;
}

/** 1 where the plane is seen inside `low`..`high` degrees of its normal: a class' sampling window. */
function incidenceBand(view: SyntheticView, low: number, high: number): Uint8Array {
  const eye = makeCamera(view.geometry.spec).position;
  const { position, normal, size } = view.geometry;
  const band = new Uint8Array(size * size);
  for (let i = 0; i < band.length; i++) {
    if (normal[4 * i + 3]! < 0.5) continue;
    const at = 4 * i;
    const cosine =
      ((eye.x - position[at]!) * normal[at]! +
        (eye.y - position[at + 1]!) * normal[at + 1]! +
        (eye.z - position[at + 2]!) * normal[at + 2]!) /
      position[at + 3]!;
    const incidence = (Math.acos(Math.min(1, cosine)) * 180) / Math.PI;
    if (incidence >= low && incidence <= high) band[i] = 1;
  }
  return band;
}

function patchOf(view: SyntheticView, klass: "wall" | "floor", side: number): SwatchCandidate {
  const candidate = pickSwatch(view.geometry, {
    klass,
    side,
    view: view.geometry.spec.id,
    viewSize: VIEW,
    area: view.area,
  });
  expect(candidate, `no ${klass} patch in view ${view.geometry.spec.id}`).toBeDefined();
  return candidate!;
}

describe("material swatch rectification", () => {
  // A wall at z = 0 seen from the side and slightly below: the view is at 19 degrees to the wall's
  // normal, and perspective alone makes its pixels unequal along the two screen axes. The swatch has
  // to undo both, or the pattern comes out with the wrong period along one of its axes.
  const spec = lookAt(1, [1.8, 2.2, 3.4], [0.2, 1.4, 0]);
  const wall = renderPlane(spec, [0, 0, 0], [0, 0, 1], checker);

  it("reproduces the paint at its true metric period, on both axes", () => {
    const candidate = patchOf(wall, "wall", SIDE);
    expect(candidate.incidence).toBeGreaterThan(5);
    expect(candidate.incidence).toBeLessThan(SWATCH_MAX_INCIDENCE_DEG.wall);
    expect(candidate.patch.side).toBe(SIDE);
    // The swatch is 1.5 m over 1024 px; a 0.25 m tile is 1024 / 6 px.
    const expected = SWATCH_SIZE * (PERIOD / SIDE);
    const swatch = frameOf(tileSwatch(rectifySwatch(candidate.patch, spec, wall.generation, VIEW), candidate.patch.side));
    const horizontal = medianPeriod(swatch, 0, true);
    const vertical = medianPeriod(swatch, 0, false);
    expect(Math.abs(horizontal - expected) / expected).toBeLessThan(0.02);
    expect(Math.abs(vertical - expected) / expected).toBeLessThan(0.02);
    // No stretch: the two axes carry the same scale, whatever the view's perspective did.
    expect(Math.abs(horizontal - vertical) / expected).toBeLessThan(0.02);
  });

  it("reports the patch's own scale and the view's, and its world corners", () => {
    const candidate = patchOf(wall, "wall", SIDE);
    expect(candidate.metresPerPixel).toBeCloseTo(SIDE / SWATCH_SIZE, 12);
    // The view is ~3.5 m away at 1024 px over 90 degrees: about 7 mm of wall per image pixel, which is
    // what the search reports (never the probe's own, much coarser, pixel).
    expect(candidate.sourceMetresPerPixel).toBeGreaterThan(0.004);
    expect(candidate.sourceMetresPerPixel).toBeLessThan(0.02);
    // The reported incidence is the angle between the wall's normal and the direction to the camera.
    const [centreX, centreY, centreZ] = candidate.patch.centre;
    const toEye = [spec.position[0] - centreX, spec.position[1] - centreY, spec.position[2] - centreZ];
    const cosine =
      (toEye[0]! * candidate.patch.normal[0] +
        toEye[1]! * candidate.patch.normal[1] +
        toEye[2]! * candidate.patch.normal[2]) /
      Math.hypot(...toEye);
    expect(candidate.incidence).toBeCloseTo((Math.acos(cosine) * 180) / Math.PI, 3);
    // One image pixel at that distance, stretched by the incidence: the resolution reported is the
    // view's own, never the probe's much coarser one.
    expect(candidate.sourceMetresPerPixel).toBeCloseTo((2 * Math.tan(Math.PI / 4) * Math.hypot(...toEye)) / VIEW / cosine, 6);
    for (const corner of candidate.patch.corners) {
      expect(Math.abs(corner[2] - centreZ)).toBeLessThan(1e-6);
      const fromCentre = Math.hypot(corner[0] - centreX, corner[1] - centreY, corner[2] - centreZ);
      expect(fromCentre).toBeCloseTo(SIDE / Math.SQRT2, 6);
    }
  });
});

describe("material swatch tiling", () => {
  const spec = lookAt(4, [1.8, 2.2, 3.4], [0.2, 1.4, 0]);
  const wall = renderPlane(spec, [0, 0, 0], [0, 0, 1], waves);

  it("wraps its edges into each other, where a plain rectified patch does not", () => {
    const candidate = patchOf(wall, "wall", SIDE);
    const rectified = rectifiedFrame(rectifySwatch(candidate.patch, spec, wall.generation, VIEW));
    const tiled = frameOf(tileSwatch(rectified.pixels, candidate.patch.side));
    const edgeStep = (frame: Frame) => {
      let worst = 0;
      for (const share of [0.2, 0.3, 0.5, 0.7, 0.8]) {
        const line = Math.round(share * frame.height);
        for (const channel of [0, 1]) {
          worst = Math.max(worst, Math.abs(sample(frame, line, 0, channel, true) - sample(frame, line, frame.width - 1, channel, true)));
          worst = Math.max(worst, Math.abs(sample(frame, line, 0, channel, false) - sample(frame, line, frame.height - 1, channel, false)));
        }
      }
      return worst;
    };
    // The patch's paint is 1.5 m of a wave that repeats every 0.6 m: laid end to end it would not
    // meet, so the plain rectified patch has a hard cut on both axes.
    expect(edgeStep(rectified)).toBeGreaterThan(40);
    // The tile wraps instead: an axis with a clear repeat is cut on one (no blend at all), and an axis
    // without one is cross-faded from a sample one pixel apart — either way the join is continuous.
    expect(edgeStep(tiled)).toBeLessThan(12);
  });

  it("keeps the paint's grain and colour through the seam band", () => {
    const candidate = patchOf(wall, "wall", SIDE);
    const rectified = rectifiedFrame(rectifySwatch(candidate.patch, spec, wall.generation, VIEW));
    const tiled = frameOf(tileSwatch(rectified.pixels, candidate.patch.side));
    const stats = (frame: Frame) => {
      let mean = 0;
      let min = 255;
      let max = 0;
      for (let i = 0; i < frame.width * frame.height; i++) {
        const value = frame.pixels[4 * i]!;
        mean += value;
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
      return { mean: mean / frame.width / frame.height, min, max };
    };
    const before = stats(rectified);
    const after = stats(tiled);
    // Amplitude is renormalised across the two samples, not averaged away: the band keeps its spread.
    expect(after.max - after.min).toBeGreaterThan((before.max - before.min) * 0.9);
    // The band's two samples are the same paint half a tile apart, so the patch's own tone survives
    // it to within a couple of levels (the amplitude rescale cannot shift a wider pattern's mean).
    expect(Math.abs(after.mean - before.mean)).toBeLessThan(8);
  });
});

describe("material swatch courses", () => {
  const spec = lookAt(5, [1.8, 2.2, 3.4], [0.2, 1.4, 0]);
  const wall = renderPlane(spec, [0, 0, 0], [0, 0, 1], brick);
  const COURSE = SWATCH_SIZE * (BRICK_HIGH / SIDE);
  const cut = () => {
    const candidate = patchOf(wall, "wall", SIDE);
    return tileSwatch(rectifySwatch(candidate.patch, spec, wall.generation, VIEW), candidate.patch.side);
  };

  it("wraps a running bond on a mortar joint, with no blend band to double it", () => {
    const tile = cut();
    // The courses were found and the height cut to whole ones, so a course sits on the seam.
    expect(tile.periodY).toBe(Math.round(COURSE));
    expect(tile.height % tile.periodY).toBe(0);
    expect(tile.height).toBeLessThan(SWATCH_SIZE);
    const rows = rowLuminance(frameOf(tile));
    const mid = (Math.min(...rows) + Math.max(...rows)) / 2;
    // Exactly one joint in the quarter period either side of the wrap, and it is a joint: a patch cut
    // through brick or a half-tile blend (which mixes two layouts) misses it or shows more than one.
    const profile = acrossSeam(frameOf(tile), Math.round(COURSE / 4));
    const minima: number[] = [];
    for (let i = 1; i < profile.length - 1; i++) {
      if (profile[i]! < mid && profile[i]! <= profile[i - 1]! && profile[i]! <= profile[i + 1]!) minima.push(i);
    }
    expect(minima).toHaveLength(1);
    // And the joint across the seam is one joint wide, not two: it matches the joints inside the tile.
    const inside = joints(rows, mid).sort((a, b) => a - b);
    const joint = inside[Math.floor(inside.length / 2)]!;
    // One whole joint opens the tile (a half one would leave a thin mortar line at the wrap, two would
    // read as doubled mortar): the same width as the joints inside the tile, give or take a row.
    expect(seamJoint(rows, mid)).toBeGreaterThanOrEqual(Math.round(joint * 0.75));
    expect(seamJoint(rows, mid)).toBeLessThanOrEqual(Math.round(joint * 1.25));
  });

  it("does not cut an axis whose repeat is a tonal patch rather than a joint", () => {
    const spec = lookAt(6, [1.8, 2.2, 3.4], [0.2, 1.4, 0]);
    const wall = renderPlane(spec, [0, 0, 0], [0, 0, 1], blotches);
    const candidate = patchOf(wall, "wall", SIDE);
    const tile = tileSwatch(rectifySwatch(candidate.patch, spec, wall.generation, VIEW), candidate.patch.side);
    // The bands repeat every 0.25 m, so the period is there; the dip they make is half the period wide,
    // so it is not a mortar joint and the axis keeps its narrow cross-fade instead of a hard cut.
    expect(tile.periodX).toBe(0);
    expect(tile.width).toBe(SWATCH_SIZE);
    expect(tile.metresX).toBeCloseTo(SIDE, 9);
    // The bands are still in the swatch, dark and light: it blended the axis, it did not lose the paint.
    let dark = 255;
    let light = 0;
    for (let i = 0; i < tile.width * tile.height; i++) {
      dark = Math.min(dark, tile.pixels[4 * i]!);
      light = Math.max(light, tile.pixels[4 * i]!);
    }
    expect(dark).toBeLessThan(60);
    expect(light).toBeGreaterThan(200);
  });

  it("keeps the paint's metric scale on both axes through the crop", () => {
    const tile = cut();
    // Whole rows and columns are dropped, never resampled: the pixel grid keeps the patch's scale, and
    // the tile only covers less of it.
    expect(tile.metresX).toBeCloseTo((SIDE * tile.width) / SWATCH_SIZE, 9);
    expect(tile.metresY).toBeCloseTo((SIDE * tile.height) / SWATCH_SIZE, 9);
    const frame = frameOf(tile);
    // One mortar joint per crossing, so the metric measure is the joint pitch — 0.3 m of brick along a
    // course, 0.125 m of course down the wall — read back off the cut tile.
    const horizontal = medianPeriod(frame, 0, true, true);
    const vertical = medianPeriod(frame, 0, false, true);
    const expectedX = SWATCH_SIZE * (BRICK_LONG / SIDE);
    const expectedY = COURSE;
    expect(Math.abs(horizontal - expectedX) / expectedX).toBeLessThan(0.02);
    expect(Math.abs(vertical - expectedY) / expectedY).toBeLessThan(0.02);
  });
});

describe("the swatch's joints are sharpened where it is cut (phase 2x)", () => {
  /**
   * A coursed wall as the paint leaves it: a 12 mm mortar joint is 8 texels at the swatch's 1.46 mm, and
   * its edges are soft — the swatch is an upscale of soft source pixels — a Gaussian of 2 texels each.
   */
  const SIZE = 256;
  const PER = 64;
  const JOINT = 8;
  const SOFT = 2;
  const DARK = 60;
  const LIGHT = 200;
  /** One joint per course, centred on the course break, so both of its edges are soft and it wraps. */
  const coursed = () => {
    const pixels = new Uint8ClampedArray(SIZE * SIZE * 4);
    for (let y = 0; y < SIZE; y++) {
      const phase = y % PER;
      // Dark for the rows around the break (0), light in the middle of the course.
      const distance = Math.min(phase, PER - phase);
      const joint = 1 / (1 + Math.exp((distance - JOINT) / SOFT));
      const value = Math.round(LIGHT - (LIGHT - DARK) * joint);
      for (let x = 0; x < SIZE; x++) {
        const at = 4 * (y * SIZE + x);
        pixels[at] = pixels[at + 1] = pixels[at + 2] = value;
        pixels[at + 3] = 255;
      }
    }
    return pixels;
  };
  /** 10-90 % width of one joint edge, in rows, at the paint's own levels (down the middle column). */
  const jointRamp = (pixels: Uint8ClampedArray, width: number, from: number, to: number) => {
    const low = DARK + 0.1 * (LIGHT - DARK);
    const high = DARK + 0.9 * (LIGHT - DARK);
    const at = (row: number) => pixels[4 * (row * width + (width >> 1))]!;
    // The joint's leading edge, scanning down: light above, dark below.
    const crossing = (level: number, startAt: number) => {
      for (let row = Math.floor(startAt) + 1; row < to; row++) {
        const before = at(row - 1);
        const after = at(row);
        if (before >= level && after < level) return row - 1 + Math.abs((level - before) / (after - before));
      }
      return Number.NaN;
    };
    const top = crossing(high, from);
    return crossing(low, Number.isNaN(top) ? from : top) - top;
  };

  it("halves a soft joint's edge and keeps the paint's mean colour", () => {
    const pixels = coursed();
    const before = jointRamp(pixels, SIZE, 40, 84);
    const sharpened = sharpenSwatch(pixels, SIZE, SIZE);
    const after = jointRamp(sharpened, SIZE, 40, 84);
    expect(Number.isFinite(before)).toBe(true);
    expect(before).toBeGreaterThan(4);
    expect(after).toBeLessThanOrEqual(before * 0.5);
    const mean = (frame: Uint8ClampedArray) => {
      let sum = 0;
      for (let i = 0; i < frame.length; i += 4) sum += frame[i]!;
      return sum / (frame.length / 4);
    };
    expect(Math.abs(mean(sharpened) - mean(pixels)) / mean(pixels)).toBeLessThan(0.02);
  });

  it("leaves flat paint flat, and sharpens the joint of the cut the game is handed", () => {
    // No edge, no overshoot: the mask adds nothing where the paint is one value.
    const flat = new Uint8ClampedArray(SIZE * SIZE * 4).fill(120);
    for (const value of sharpenSwatch(flat, SIZE, SIZE)) expect(value).toBe(120);
    // And the cut really is what carries the sharpening: the tile's joint falls further per row than the
    // rectified patch it was cut from.
    const pixels = coursed();
    const tile = tileSwatch(pixels, SIDE, SIZE);
    const steepest = (frame: { pixels: Uint8ClampedArray; width: number }) => {
      const column = frame.width >> 1;
      let worst = 0;
      for (let row = 41; row < 84; row++) {
        const before = frame.pixels[4 * ((row - 1) * frame.width + column)]!;
        const after = frame.pixels[4 * (row * frame.width + column)]!;
        worst = Math.max(worst, Math.abs(after - before));
      }
      return worst;
    };
    expect(steepest(tile)).toBeGreaterThan(steepest({ pixels, width: SIZE }) * 1.5);
  });
});

describe("material swatch search", () => {
  it("finds a floor patch from a camera that looks down at the floor", () => {
    const spec = lookAt(7, [0.6, 2.4, 2.2], [0, 0, 0]);
    const floor = renderPlane(spec, [0, 0, 0], [0, 1, 0], checker);
    const candidate = patchOf(floor, "floor", 2);
    expect(candidate.patch.normal).toEqual([0, 1, 0]);
    // The search takes the most head-on patch it can see, which is the floor nearer the camera, not the
    // floor the camera is aimed at: its incidence is the angle at its own centre.
    const [centreX, centreY, centreZ] = candidate.patch.centre;
    const toEye = [spec.position[0] - centreX, spec.position[1] - centreY, spec.position[2] - centreZ];
    const incidence = (Math.acos(toEye[1]! / Math.hypot(...toEye)) * 180) / Math.PI;
    expect(candidate.incidence).toBeCloseTo(incidence, 3);
    expect(candidate.incidence).toBeLessThan(SWATCH_MAX_INCIDENCE_DEG.floor);
  });

  it("cuts a 2 m floor patch from a ground view that only sees it at 60 degrees", () => {
    // The real run's shape (phase 2n): a player-height camera pitched 2 degrees up sees no floor nearer
    // than 2 m away, so the flattest patch it can give is past 50 degrees of the floor's normal. That is
    // still true scale after rectification, only softer along depth, so the floor class takes it.
    const spec: ViewSpec = { id: 10, position: [0, 1.7, 0], yaw: 0, pitch: (2 * Math.PI) / 180, fov: FOV };
    const floor = renderPlane(spec, [0, 0, 0], [0, 1, 0], checker);
    const candidate = patchOf(floor, "floor", 2);
    expect(candidate.incidence).toBeGreaterThan(SWATCH_MAX_INCIDENCE_DEG.wall);
    expect(candidate.incidence).toBeGreaterThan(55);
    expect(candidate.incidence).toBeLessThan(SWATCH_MAX_INCIDENCE_DEG.floor);
  });

  it("takes the floor at 60 degrees of its normal and refuses it at 70", () => {
    const spec: ViewSpec = { id: 11, position: [0, 1.7, 0], yaw: 0, pitch: (2 * Math.PI) / 180, fov: FOV };
    const floor = renderPlane(spec, [0, 0, 0], [0, 1, 0], checker);
    const search = (low: number, high: number) =>
      pickSwatch(floor.geometry, {
        klass: "floor",
        side: 2,
        view: 11,
        viewSize: VIEW,
        area: incidenceBand(floor, low, high),
      });
    // Only the floor class' ceiling lets a patch this oblique through: the wall's 50 would refuse it.
    const accepted = search(56, 62);
    expect(accepted).toBeDefined();
    expect(accepted!.incidence).toBeGreaterThan(SWATCH_MAX_INCIDENCE_DEG.wall);
    expect(accepted!.incidence).toBeLessThan(SWATCH_MAX_INCIDENCE_DEG.floor);
    expect(search(66, 74)).toBeUndefined();
  });

  it("refuses a floor patch a standing view only sees at a graze", () => {
    const spec = lookAt(8, [0, 1.2, 5], [0, 0, 0]);
    const floor = renderPlane(spec, [0, 0, 0], [0, 1, 0], checker);
    // 76 degrees from the floor's normal: a swatch cut there would be stretched, so there is none.
    expect(
      pickSwatch(floor.geometry, { klass: "floor", side: 2, view: 8, viewSize: VIEW, area: floor.area }),
    ).toBeUndefined();
  });

  it("refuses a patch that the view does not have, or cannot see whole", () => {
    const spec = lookAt(9, [1.8, 2.2, 3.4], [0.2, 1.4, 0]);
    const wall = renderPlane(spec, [0, 0, 0], [0, 0, 1], checker);
    // An empty area mask is a view that shows nothing of this class.
    expect(
      pickSwatch(wall.geometry, {
        klass: "wall",
        side: SIDE,
        view: 9,
        viewSize: VIEW,
        area: new Uint8Array(VIEW * VIEW),
      }),
    ).toBeUndefined();
    // The strip along the clay's edges is not projected: a patch that lands in it is not a swatch.
    expect(
      pickSwatch(wall.geometry, {
        klass: "wall",
        side: SIDE,
        view: 9,
        viewSize: VIEW,
        area: wall.area,
        avoid: new Uint8Array(VIEW * VIEW).fill(1),
      }),
    ).toBeUndefined();
  });
});

/**
 * A coursed wall of ashlar as the paint leaves it (phase 2y): courses of unequal height, head joints
 * staggered from course to course, mortar darker than the stone, grain over both — and no period at all,
 * because the courses are not the same height. The sample courtyard's wall is this, at 1.5 m over 1024 px.
 */
const ASHLAR = 1024;
/** Centres of the bed joints, px: courses of 138, 176, 152, 196 and 164 rows, and 198 across the wrap. */
const BEDS = [23, 161, 337, 489, 685, 849];
const BED_HALF = 5;
const HEAD_HALF = 5;
const MORTAR_LEVEL = 70;
const STONE_LEVEL = 165;

/**
 * The head joints of course `course`, px: three per course, each course staggered from the last and each
 * course's stones of a different width, so no column repeats: the x axis has no period either.
 */
function headsOf(course: number): number[] {
  return [(97 + 383 * course) % ASHLAR, (411 + 271 * course) % ASHLAR, (877 + 149 * course) % ASHLAR];
}

/** A small deterministic grain, so the row profile has the paint's noise and no autocorrelation peak. */
function grain(x: number, y: number): number {
  let hash = (Math.imul(x + 1, 0x9e3779b1) ^ Math.imul(y + 1, 0x85ebca6b)) >>> 0;
  hash ^= hash >>> 15;
  return (hash % 13) - 6;
}

/** The level of one pixel of the ashlar wall. */
function ashlarLevel(x: number, y: number): number {
  for (let course = 0; course < BEDS.length; course++) {
    const from = BEDS[course]!;
    const to = BEDS[(course + 1) % BEDS.length]!;
    const inside = from < to ? y >= from && y < to : y >= from || y < to;
    if (!inside) continue;
    let bed = Math.min(Math.abs(y - from), Math.abs(y - (from - ASHLAR)), Math.abs(y - (from + ASHLAR)));
    bed = Math.min(bed, Math.abs(y - to), Math.abs(y - (to - ASHLAR)), Math.abs(y - (to + ASHLAR)));
    if (bed <= BED_HALF) return MORTAR_LEVEL + grain(x, y);
    const head = Math.min(...headsOf(course).map((at) => Math.min(Math.abs(x - at), ASHLAR - Math.abs(x - at))));
    return (head <= HEAD_HALF ? MORTAR_LEVEL : STONE_LEVEL) + grain(x, y);
  }
  return STONE_LEVEL;
}

/** The ashlar wall as a rectified patch. */
function ashlar(): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(ASHLAR * ASHLAR * 4);
  for (let y = 0; y < ASHLAR; y++) {
    for (let x = 0; x < ASHLAR; x++) {
      const value = ashlarLevel(x, y);
      const at = 4 * (y * ASHLAR + x);
      pixels[at] = value;
      pixels[at + 1] = value;
      pixels[at + 2] = value;
      pixels[at + 3] = 255;
    }
  }
  return pixels;
}

/**
 * The same courses with no head joints at all: the paint of a coursed wall whose stones run on, so the only
 * head joints the tile can show are the ones it draws itself. Nothing else can close a course's x wrap.
 */
function stripes(): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(ASHLAR * ASHLAR * 4);
  for (let y = 0; y < ASHLAR; y++) {
    let bed = Infinity;
    for (const at of BEDS) bed = Math.min(bed, Math.abs(y - at), ASHLAR - Math.abs(y - at));
    const value = bed <= BED_HALF ? MORTAR_LEVEL : STONE_LEVEL;
    for (let x = 0; x < ASHLAR; x++) {
      const level = value + grain(x, y);
      const offset = 4 * (y * ASHLAR + x);
      pixels[offset] = level;
      pixels[offset + 1] = level;
      pixels[offset + 2] = level;
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}

/** A running bond on a clear period: courses of exactly 136 rows, head joints every 264, half-staggered. */
function regular(): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(ASHLAR * ASHLAR * 4);
  for (let y = 0; y < ASHLAR; y++) {
    for (let x = 0; x < ASHLAR; x++) {
      const index = Math.floor(y / 136);
      const offset = (index % 2) * 132;
      const bed = y % 136 < 10;
      const head = (x - offset + 4 * ASHLAR) % 264 < 10;
      const value = bed || head ? MORTAR_LEVEL : STONE_LEVEL;
      const at = 4 * (y * ASHLAR + x);
      pixels[at] = value;
      pixels[at + 1] = value;
      pixels[at + 2] = value;
      pixels[at + 3] = 255;
    }
  }
  return pixels;
}

/** Something a wall could be painted with that has no courses in it: smooth, and no period either. */
function smooth(): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(ASHLAR * ASHLAR * 4);
  for (let y = 0; y < ASHLAR; y++) {
    for (let x = 0; x < ASHLAR; x++) {
      const value = 128 + 40 * Math.sin(x / 210) + 30 * Math.sin(y / 165 + 1.3);
      const at = 4 * (y * ASHLAR + x);
      pixels[at] = value;
      pixels[at + 1] = value;
      pixels[at + 2] = value;
      pixels[at + 3] = 255;
    }
  }
  return pixels;
}

/** A 32-bit fingerprint of a tile, so a path that must not change can be pinned to it. */
function fingerprint(tile: SwatchTile): string {
  let hash = 0x811c9dc5;
  const mix = (value: number) => {
    hash = (hash ^ (value & 0xff)) >>> 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  };
  for (const value of tile.pixels) mix(value);
  for (const value of [tile.width, tile.height, tile.periodX, tile.periodY]) {
    mix(value & 0xff);
    mix((value >> 8) & 0xff);
  }
  return hash.toString(16).padStart(8, "0");
}

/** Mean luminance of every column of a frame, over its rows `from`..`to`. */
function columnLuminance(frame: Frame, from: number, to: number): Float64Array {
  const out = new Float64Array(frame.width);
  for (let x = 0; x < frame.width; x++) {
    let sum = 0;
    let count = 0;
    for (let y = from; y < to; y++) {
      const at = 4 * (y * frame.width + x);
      sum += 0.299 * frame.pixels[at]! + 0.587 * frame.pixels[at + 1]! + 0.114 * frame.pixels[at + 2]!;
      count++;
    }
    out[x] = count > 0 ? sum / count : 0;
  }
  return out;
}

/** The runs of rows darker than `mid`, read across the wrap: one entry per joint, centres in rows. */
function circularRuns(rows: Float64Array, mid: number): number[][] {
  const count = rows.length;
  const dark = Array.from({ length: count }, (_, y) => rows[y]! < mid);
  if (dark.every((value) => value)) return [[0, count]];
  // Start at a row that is not dark, so the run across the wrap is one run and not two.
  const start = dark.findIndex((value) => !value);
  const runs: number[][] = [];
  let run: number[] = [];
  for (let i = 0; i < count; i++) {
    const y = (start + i) % count;
    if (dark[y]) run.push(y);
    else if (run.length > 0) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

/** Fingerprints of the paths phase 2y must not touch, taken from the cut as it shipped in 0.19.0. */
const FLOOR_FINGERPRINT = "1785890d";
const PERIOD_FINGERPRINT = "bd68e731";
const FADE_FINGERPRINT = "7212f4e6";

/** Centre row of a run of rows, read on the circle the tile wraps on (a run may cross the wrap). */
function runCentre(run: readonly number[], height: number): number {
  const base = run[0]!;
  let sum = 0;
  for (const row of run) sum += row < base ? row + height : row;
  const mean = sum / run.length;
  return mean >= height ? mean - height : mean;
}

/** Distance between two rows of the tile, the short way round its wrap. */
function circularGap(a: number, b: number, height: number): number {
  const gap = Math.abs(a - b);
  return Math.min(gap, height - gap);
}

describe("a coursed wall wraps inside its bed joints and head joints (phase 2y)", () => {
  const tile = tileSwatch(ashlar(), SIDE, ASHLAR, "wall");
  const frame = frameOf(tile);
  const rows = rowLuminance(frame);
  const mid = (Math.min(...rows) + Math.max(...rows)) / 2;

  it("cuts the rows to two bed joints, so both ends of the tile are mortar", () => {
    // No period: the courses are not the same height, so the cut is on the joints the profile shows.
    expect(tile.periodY).toBe(0);
    expect(tile.height).toBeLessThan(ASHLAR);
    // Both ends sit inside a bed joint: the wrap needs no blend at all.
    expect(rows[0]).toBeLessThan(mid);
    expect(rows[1]).toBeLessThan(mid);
    expect(rows[tile.height - 1]).toBeLessThan(mid);
    expect(rows[tile.height - 2]).toBeLessThan(mid);
    // The cut is whole rows off the patch, never a resample: the patch's own scale is what it reports.
    expect(tile.metresY).toBeCloseTo((SIDE * tile.height) / ASHLAR, 9);
    expect(tile.metresX).toBeCloseTo((SIDE * tile.width) / ASHLAR, 9);
    // And both sides are whole 4x4 blocks: the cook transcodes the base colour map in them and refuses a
    // swatch that is not (a 1024x871 tile failed the engine's ktx2 pass outright).
    expect(tile.width % 4).toBe(0);
    expect(tile.height % 4).toBe(0);
  });

  it("shows exactly one bed joint per course, never a doubled one", () => {
    const runs = circularRuns(rows, mid);
    // One joint per course of the pattern the tile covers, plus no second joint beside any of them.
    expect(runs.length).toBeGreaterThanOrEqual(4);
    for (const run of runs) {
      // A joint: wide enough for the mortar and the grain on it, and no wider than the pattern's mortar.
      expect(run.length).toBeGreaterThanOrEqual(6);
      expect(run.length).toBeLessThanOrEqual(2 * BED_HALF + 14);
    }
    // A cross-fade band mixes two layouts half a tile apart, which puts a second minimum a short course
    // away from the real joint. No two joints of this wall are that close.
    const centres = runs.map((run) => runCentre(run, tile.height));
    for (let i = 0; i < centres.length; i++) {
      for (let j = i + 1; j < centres.length; j++) {
        expect(circularGap(centres[i]!, centres[j]!, tile.height)).toBeGreaterThan(60);
      }
    }
  });

  it("draws one head joint per course to close its x wrap, staggered onto a running bond", () => {
    // On a wall with no head joints of its own there is nothing but the drawn joint to close a course's x
    // wrap: exactly one full-height mortar band per course, as wide as the bed joints are thick, and no
    // two courses in a row with it in the same place.
    const striped = tileSwatch(stripes(), SIDE, ASHLAR, "wall");
    const frame = frameOf(striped);
    const profile = rowLuminance(frame);
    const mid = (Math.min(...profile) + Math.max(...profile)) / 2;
    const borders = circularRuns(profile, mid).map((run) => runCentre(run, striped.height));
    expect(borders.length).toBeGreaterThanOrEqual(4);
    const sorted = [...borders].sort((a, b) => a - b);
    const bounds = [0, ...sorted.filter((row) => row > 6 && row < striped.height - 6), striped.height];
    const centres: number[] = [];
    for (let i = 0; i + 1 < bounds.length; i++) {
      const from = Math.round(bounds[i]! + BED_HALF + 2);
      const to = Math.round(bounds[i + 1]! - BED_HALF - 2);
      // The share of a column's rows that is stone: a drawn head joint runs the whole course, so it is
      // stone for none of them, while everywhere else is stone but for the bed joints crossing it.
      const stone = new Float64Array(striped.width);
      for (let x = 0; x < striped.width; x++) {
        let bright = 0;
        for (let y = from; y < to; y++) if (sample(frame, y, x, 0, true) >= mid) bright++;
        stone[x] = bright / Math.max(1, to - from);
      }
      const runs = circularRuns(stone, 0.15);
      expect(runs.length, `one head joint in the course at row ${from}`).toBe(1);
      const width = runs[0]!.length;
      expect(width).toBeGreaterThanOrEqual(6);
      expect(width).toBeLessThanOrEqual(2 * BED_HALF + 14);
      centres.push(runCentre(runs[0]!, striped.width));
    }
    expect(centres.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < centres.length; i++) {
      expect(circularGap(centres[i]!, centres[i - 1]!, striped.width)).toBeGreaterThan(60);
    }
  });

  it("leaves the floor path, the periodic path and the cross-faded path byte-identical", () => {
    // A floor is not cut to bed joints even when it shows them: the class decides, as before.
    expect(fingerprint(tileSwatch(ashlar(), 2, ASHLAR, "floor"))).toBe(FLOOR_FINGERPRINT);
    // A wall whose courses do repeat is still cut on the period, exactly as it was.
    expect(fingerprint(tileSwatch(regular(), SIDE, ASHLAR))).toBe(PERIOD_FINGERPRINT);
    // And a wall with no joints to find keeps its cross-fade.
    expect(fingerprint(tileSwatch(smooth(), SIDE, ASHLAR))).toBe(FADE_FINGERPRINT);
  });
});
