import * as THREE from "three";
import { describe, expect, it } from "vitest";

import {
  SWATCH_MAX_INCIDENCE_DEG,
  SWATCH_SIZE,
  pickSwatch,
  rectifySwatch,
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
