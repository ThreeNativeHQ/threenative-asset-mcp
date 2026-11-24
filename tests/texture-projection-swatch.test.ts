import * as THREE from "three";
import { describe, expect, it } from "vitest";

import {
  SWATCH_MAX_INCIDENCE_DEG,
  SWATCH_SIZE,
  makeSwatchTileable,
  pickSwatch,
  rectifySwatch,
  type SwatchCandidate,
  type ViewGeometry,
} from "../src/texture-projection/app/core/swatch.js";
import { makeCamera, type ViewSpec } from "../src/texture-projection/app/core/views.js";

/**
 * The swatch math on a synthetic world (PRD-916 phase 2m): a camera, one infinite plane, and an image
 * painted on that plane at a known metric scale. The swatch must read the pattern back at its own
 * true scale — the same period along both of its axes, within 2% of the real one — and its edges must
 * wrap, which a plain rectified patch does not.
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

/** One channel of a swatch, along a row (`horizontal`) or down a column, at `line`. */
function sample(image: Uint8ClampedArray, line: number, step: number, channel: number, horizontal: boolean): number {
  const at = horizontal ? line * SWATCH_SIZE + step : step * SWATCH_SIZE + line;
  return image[4 * at + channel]!;
}

/**
 * The pattern's metric period along one line, in swatch pixels: a checker alternates from cell to
 * cell, so its crossings are one cell apart, and their positions against their index give the cell
 * size by least squares (each crossing has its own sub-pixel error; a fit does not add them up).
 */
function periodAlong(image: Uint8ClampedArray, line: number, channel: number, horizontal: boolean): number {
  const crossings: number[] = [];
  let previous = sample(image, line, 0, channel, horizontal) > 128;
  for (let step = 1; step < SWATCH_SIZE; step++) {
    const value = sample(image, line, step, channel, horizontal) > 128;
    if (value !== previous) crossings.push(step - 0.5);
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
function medianPeriod(image: Uint8ClampedArray, channel: number, horizontal: boolean): number {
  const periods = [0.33, 0.37, 0.41, 0.55, 0.59]
    .map((share) => periodAlong(image, Math.round(share * SWATCH_SIZE), channel, horizontal))
    .filter((period) => Number.isFinite(period))
    .sort((a, b) => a - b);
  return periods[Math.floor(periods.length / 2)]!;
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
    expect(candidate.incidence).toBeLessThan(SWATCH_MAX_INCIDENCE_DEG);
    expect(candidate.patch.side).toBe(SIDE);
    // The swatch is 1.5 m over 1024 px; a 0.25 m tile is 1024 / 6 px.
    const expected = SWATCH_SIZE * (PERIOD / SIDE);
    const swatch = makeSwatchTileable(rectifySwatch(candidate.patch, spec, wall.generation, VIEW));
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
    const rectified = rectifySwatch(candidate.patch, spec, wall.generation, VIEW);
    const tiled = makeSwatchTileable(rectified);
    const edgeStep = (image: Uint8ClampedArray) => {
      let worst = 0;
      for (const share of [0.2, 0.3, 0.5, 0.7, 0.8]) {
        const line = Math.round(share * SWATCH_SIZE);
        for (const channel of [0, 1]) {
          worst = Math.max(worst, Math.abs(sample(image, line, 0, channel, true) - sample(image, line, SWATCH_SIZE - 1, channel, true)));
          worst = Math.max(worst, Math.abs(sample(image, line, 0, channel, false) - sample(image, line, SWATCH_SIZE - 1, channel, false)));
        }
      }
      return worst;
    };
    // The patch's paint is 1.5 m of a wave that repeats every 0.6 m: laid end to end it would not
    // meet, so the plain rectified patch has a hard cut on both axes.
    expect(edgeStep(rectified)).toBeGreaterThan(40);
    // The tile's border pixels come from one source pixel apart, so the join is a continuous one: the
    // paint's own step over a single view pixel (a few levels of 255), nothing more.
    expect(edgeStep(tiled)).toBeLessThan(12);
  });

  it("keeps the paint's grain and colour through the seam band", () => {
    const candidate = patchOf(wall, "wall", SIDE);
    const rectified = rectifySwatch(candidate.patch, spec, wall.generation, VIEW);
    const tiled = makeSwatchTileable(rectified);
    const stats = (image: Uint8ClampedArray) => {
      let mean = 0;
      let min = 255;
      let max = 0;
      for (let i = 0; i < SWATCH_SIZE * SWATCH_SIZE; i++) {
        const value = image[4 * i]!;
        mean += value;
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
      return { mean: mean / SWATCH_SIZE / SWATCH_SIZE, min, max };
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
    expect(candidate.incidence).toBeLessThan(SWATCH_MAX_INCIDENCE_DEG);
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
