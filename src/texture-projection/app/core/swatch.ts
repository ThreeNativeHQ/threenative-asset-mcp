/**
 * True-scale, tileable material swatches cut from the paint a run already paid for (PRD-916 phase 2m).
 *
 * The bake is one atlas for the whole level: 4096 texels over some tens of metres on the sample
 * courtyard, about 0.8 cm per texel. At arm's length one texel covers ~15 screen pixels, so a wall
 * reads as blotches however many views painted it (v3 with 37 views looked the same as v1). The usual
 * fix is macro + detail: the atlas keeps its large-scale variation, and a material tiled in world
 * space gives the close range its grain. The detail has to be the paint itself — the paint decides the
 * look, scans may only add fine grain — so it is cut from the stored generations, which hold far more
 * pixels per metre wherever a camera stood close.
 *
 * A swatch is a planar world-space square on one surface of one material class that an accepted view
 * sees fully: its pixels are the inverse projection of that stored image onto the plane (no
 * stretching, no resampling of a resampled image), and it is made tileable by cross-fading it with a
 * copy offset by half a tile, the way `transferDetail` tiles an island's fill. Plain math over arrays
 * (no DOM, no GPU) so the node tests run the same rules the browser applies.
 */
import * as THREE from 'three';
import { makeCamera, type ViewSpec } from './views.js';

/** The two material classes a swatch is cut for: vertical faces, and upward faces at ground height. */
export type SwatchClass = 'wall' | 'floor';
export const SWATCH_CLASSES: readonly SwatchClass[] = ['wall', 'floor'];

/** Patch side in metres: big enough to tile without a visible repeat, small enough to be one surface. */
export const SWATCH_SIDE_METRES: Readonly<Record<SwatchClass, number>> = { wall: 1.5, floor: 2 };

/** Swatch image side. 1.5 m over 1024 px is 1.5 mm per pixel: the detail is the paint's own grain. */
export const SWATCH_SIZE = 1024;

/**
 * A patch is only cut from a view that sees it at less than this angle to its normal: at 50 degrees
 * one view pixel covers 1.56x as much surface along one axis, and the swatch would stretch that.
 */
export const SWATCH_MAX_INCIDENCE_DEG = 50;

/** Share of the swatch's side the seam band covers (a quarter of the tile, as `transferDetail` uses). */
export const SWATCH_SEAM_SHARE = 0.25;

/** A vertical face, by |normal.y|: the walls a wall swatch can come from (semantics.ts finds floors). */
export const WALL_MAX_NY = 0.35;

/** Side of the geometry probe the patch search reads back: a view is 1024-2048 px, this is enough. */
export const SWATCH_PROBE_PX = 512;

/** Sample grid per patch side, used for "fully in frame, unoccluded, on one plane". */
export const SWATCH_SAMPLES = 9;

/** How far a patch sample may sit from the surface the view recorded there, in metres. */
const SWATCH_MATCH_METRES = 0.02;

/** A sample's recorded normal must agree with the patch's this much (cosine) to be the same surface. */
const SWATCH_SAME_SURFACE = 0.85;

/** A patch sample this close to the frame edge (share of the half-frame) is not usable: filtering is not. */
const SWATCH_FRAME_MARGIN = 0.02;

/** Resolution buckets, 1/8 octave each, over 2^-14 m (0.06 mm) to 2^6 m (64 m) per pixel. */
const SWATCH_BUCKETS = 160;

/**
 * Patch candidates tried per view and class before the view is given up on, best resolution first:
 * the centres come from a lattice (see `pickSwatch`), so this is a real spread over the frame, and a
 * view whose close surfaces are ledges cannot turn the search into seconds of work.
 */
const SWATCH_MAX_TESTS = 512;

export type Vec3 = readonly [number, number, number];

/** One view's geometry as `Engine.readGeometry()` reads it back, top-down (image row order). */
export interface ViewGeometry {
  readonly spec: ViewSpec;
  /** Square side, px. */
  readonly size: number;
  /** RGBA per pixel: world position xyz + distance to the camera. */
  readonly position: Float32Array;
  /** RGBA per pixel: world normal xyz + (label + 1); a < 0.5 is sky. */
  readonly normal: Float32Array;
}

/** A planar, world-space square on one surface of the level. */
export interface SwatchPatch {
  readonly centre: Vec3;
  /** Unit vectors spanning the patch's own plane; `axisV` is up on a wall. */
  readonly axisU: Vec3;
  readonly axisV: Vec3;
  readonly normal: Vec3;
  /** Side in metres. */
  readonly side: number;
  /** Corner world positions: centre - u/2 - v/2, then +u, +u+v, +v. */
  readonly corners: readonly Vec3[];
}

/** One patch a view can give, with what it would cost in resolution. */
export interface SwatchCandidate {
  readonly klass: SwatchClass;
  /** View index the patch is cut from (the `ViewSpec`'s plan index). */
  readonly view: number;
  readonly patch: SwatchPatch;
  /** Where the patch's centre lands in that view, in pixels. */
  readonly px: number;
  readonly py: number;
  /** Angle between the surface normal and the direction to the camera, in degrees. */
  readonly incidence: number;
  /** Metres of surface per swatch pixel (the swatch's own true scale). */
  readonly metresPerPixel: number;
  /** Metres of surface per pixel of the view it is cut from: below `metresPerPixel` means an upsample. */
  readonly sourceMetresPerPixel: number;
}

export interface SwatchSearch {
  readonly klass: SwatchClass;
  /** Patch side, metres. */
  readonly side: number;
  /** View index, reported back on the candidate. */
  readonly view: number;
  /**
   * The view image's own side, px. The geometry is read at the probe size (a search detail), but the
   * resolution reported back is per image pixel: that is the paint the swatch was cut from.
   */
  readonly viewSize: number;
  /** 1 where this class may be sampled: vertical faces, or upward faces at ground height. */
  readonly area: Uint8Array;
  /**
   * 1 where the patch may not land: the strip along the view's clay edges, which the projection
   * leaves out (a coping, a plinth). A swatch must never straddle one.
   */
  readonly avoid?: Uint8Array;
}

/** A camera-relative projection matrix and what it does to a point, for the sweeps below. */
type Projection = readonly number[];

function viewProjection(spec: ViewSpec): Projection {
  const camera = makeCamera(spec);
  return new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).elements;
}

function cameraPosition(spec: ViewSpec): Vec3 {
  return spec.position;
}

/**
 * A planar square of `side` metres at `centre` on the surface with normal `n`. `axisV` points up on a
 * wall, so a swatch's top row is the patch's top; on a floor the two axes are the level's own.
 */
export function makePatch(centre: Vec3, normal: Vec3, side: number): SwatchPatch {
  const n: Vec3 = unit(normal);
  // A tangent that is never parallel to the normal: up unless the surface itself faces up or down.
  const helper: Vec3 = Math.abs(n[1]) > 0.9 ? [0, 0, 1] : [0, 1, 0];
  const u = unit(cross(helper, n));
  const v = unit(cross(n, u));
  const corner = (fu: number, fv: number): Vec3 => [
    centre[0] + u[0] * fu * side + v[0] * fv * side,
    centre[1] + u[1] * fu * side + v[1] * fv * side,
    centre[2] + u[2] * fu * side + v[2] * fv * side,
  ];
  return {
    centre,
    axisU: u,
    axisV: v,
    normal: n,
    side,
    corners: [corner(-0.5, -0.5), corner(0.5, -0.5), corner(0.5, 0.5), corner(-0.5, 0.5)],
  };
}

/** The patch's sample grid in world space, row-major over `samples` x `samples` points. */
export function patchSamples(patch: SwatchPatch, samples = SWATCH_SAMPLES): Float64Array {
  const out = new Float64Array(samples * samples * 3);
  const [cx, cy, cz] = patch.centre;
  const [ux, uy, uz] = patch.axisU;
  const [vx, vy, vz] = patch.axisV;
  for (let b = 0; b < samples; b++) {
    const fv = samples > 1 ? b / (samples - 1) - 0.5 : 0;
    for (let a = 0; a < samples; a++) {
      const fu = samples > 1 ? a / (samples - 1) - 0.5 : 0;
      const k = 3 * (b * samples + a);
      out[k] = cx + patch.side * (ux * fu + vx * fv);
      out[k + 1] = cy + patch.side * (uy * fu + vy * fv);
      out[k + 2] = cz + patch.side * (uz * fu + vz * fv);
    }
  }
  return out;
}

/** Where a world point lands in a view image, in pixels; undefined outside the (margined) frame. */
function projectPoint(m: Projection, p: Vec3, size: number, margin = SWATCH_FRAME_MARGIN) {
  const [x, y, z] = p;
  const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
  if (!(w > 0)) return undefined;
  const ndcX = (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w;
  const ndcY = (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w;
  if (!(Math.abs(ndcX) <= 1 - margin) || !(Math.abs(ndcY) <= 1 - margin)) return undefined;
  const x0 = Math.round(((ndcX + 1) * 0.5) * size - 0.5);
  const y0 = Math.round(((1 - ndcY) * 0.5) * size - 0.5);
  if (x0 < 0 || y0 < 0 || x0 >= size || y0 >= size) return undefined;
  return { x: x0, y: y0 };
}

/**
 * The patch of a view this class can give at the best resolution: the first of its surfaces, best
 * first, that is seen head-on enough, fully in frame, on one plane, and clear of the edge strip.
 */
export function pickSwatch(g: ViewGeometry, search: SwatchSearch): SwatchCandidate | undefined {
  const size = g.size;
  const m = viewProjection(g.spec);
  const eye = cameraPosition(g.spec);
  const tanHalf = Math.tan((g.spec.fov * Math.PI) / 360);
  const pixelAngle = (2 * tanHalf) / size;
  const viewAngle = (2 * tanHalf) / search.viewSize;
  const cosLimit = Math.cos((SWATCH_MAX_INCIDENCE_DEG * Math.PI) / 180);
  const metresPerPixel = search.side / SWATCH_SIZE;
  // Best resolution first: a view pixel covers less surface the closer and more head-on it is.
  const buckets: number[][] = Array.from({ length: SWATCH_BUCKETS }, () => []);
  for (let i = 0; i < size * size; i++) {
    if (!search.area[i] || search.avoid?.[i]) continue;
    const b = 4 * i;
    if (g.normal[b + 3]! < 0.5) continue;
    const d = g.position[b + 3]!;
    if (!(d > 0)) continue;
    const cosInc =
      ((eye[0] - g.position[b]!) * g.normal[b]! +
        (eye[1] - g.position[b + 1]!) * g.normal[b + 1]! +
        (eye[2] - g.position[b + 2]!) * g.normal[b + 2]!) /
      d;
    if (!(cosInc > cosLimit)) continue;
    // Patch centres on a lattice of about a quarter of the patch's own footprint: a neighbouring pixel
    // would only test the same patch again, and would let one unusable surface spend the whole budget.
    const footprint = search.side / (d * pixelAngle);
    const stride = Math.max(2, Math.round(footprint / 4));
    const x = i % size;
    if (x % stride !== 0 || ((i - x) / size) % stride !== 0) continue;
    const metres = (d * pixelAngle) / cosInc;
    buckets[Math.min(SWATCH_BUCKETS - 1, Math.max(0, Math.floor((Math.log2(metres) + 14) * 8)))]!.push(i);
  }
  let tested = 0;
  for (const bucket of buckets) {
    for (const i of bucket) {
      if (++tested > SWATCH_MAX_TESTS) return undefined;
      const candidate = candidateAt(g, search, i, m, eye, pixelAngle, viewAngle, metresPerPixel);
      if (candidate) return candidate;
    }
  }
  return undefined;
}

function candidateAt(
  g: ViewGeometry,
  search: SwatchSearch,
  i: number,
  m: Projection,
  eye: Vec3,
  pixelAngle: number,
  viewAngle: number,
  metresPerPixel: number,
): SwatchCandidate | undefined {
  const b = 4 * i;
  const centre: Vec3 = [g.position[b]!, g.position[b + 1]!, g.position[b + 2]!];
  const normal = unit([g.normal[b]!, g.normal[b + 1]!, g.normal[b + 2]!]);
  const d = g.position[b + 3]!;
  const cosInc = ((eye[0] - centre[0]) * normal[0] + (eye[1] - centre[1]) * normal[1] + (eye[2] - centre[2]) * normal[2]) / d;
  if (!(cosInc > 0)) return undefined;
  const incidence = (Math.acos(Math.min(1, cosInc)) * 180) / Math.PI;
  if (incidence >= SWATCH_MAX_INCIDENCE_DEG) return undefined;
  const patch = makePatch(centre, normal, search.side);
  // One view pixel on the patch, plus room for the gap between a sample and the pixel it projects
  // into: a nearer surface (an occluder) or a surface behind a hole is metres off, not centimetres.
  const tolerance = Math.max(SWATCH_MATCH_METRES, 2.5 * ((d * pixelAngle) / cosInc));
  const points = patchSamples(patch, SWATCH_SAMPLES);
  for (let k = 0; k < points.length; k += 3) {
    const p: Vec3 = [points[k]!, points[k + 1]!, points[k + 2]!];
    const at = projectPoint(m, p, g.size);
    if (!at) return undefined;
    const j = at.y * g.size + at.x;
    if (g.normal[4 * j + 3]! < 0.5) return undefined; // sky where the patch should be
    if (search.avoid?.[j]) return undefined;
    const c = 4 * j;
    if (g.normal[c]! * normal[0] + g.normal[c + 1]! * normal[1] + g.normal[c + 2]! * normal[2]! < SWATCH_SAME_SURFACE) {
      return undefined;
    }
    const dev = Math.hypot(g.position[c]! - p[0], g.position[c + 1]! - p[1], g.position[c + 2]! - p[2]);
    if (dev > tolerance) return undefined;
  }
  return {
    klass: search.klass,
    view: search.view,
    patch,
    // The centre's own pixel, by construction: the plane is the surface the view recorded there.
    px: i % g.size,
    py: Math.floor(i / g.size),
    incidence,
    metresPerPixel,
    sourceMetresPerPixel: (d * viewAngle) / cosInc,
  };
}

/**
 * Whether this view projected paint over every sample of the patch: 1s come from the composite's
 * alpha, which a view only writes where its own image was projected (not the clay it was handed, not
 * the strip along the clay's edges, not a texel it left unpainted).
 */
export function patchPainted(patch: SwatchPatch, spec: ViewSpec, painted: Uint8Array, size: number): boolean {
  const m = viewProjection(spec);
  const points = patchSamples(patch, SWATCH_SAMPLES);
  for (let k = 0; k < points.length; k += 3) {
    const at = projectPoint(m, [points[k]!, points[k + 1]!, points[k + 2]!], size);
    if (!at || !painted[at.y * size + at.x]) return false;
  }
  return true;
}

/**
 * The swatch itself: one pixel per `side / outSize` metres, each the stored image bilinearly sampled
 * where that world point projects into it. The inverse projection is what makes it true scale — the
 * view may see the patch at an angle, and the swatch does not.
 */
export function rectifySwatch(
  patch: SwatchPatch,
  spec: ViewSpec,
  gen: Uint8ClampedArray,
  genSize: number,
  outSize = SWATCH_SIZE,
): Uint8ClampedArray {
  const m = viewProjection(spec);
  const out = new Uint8ClampedArray(outSize * outSize * 4);
  const [cx, cy, cz] = patch.centre;
  const [ux, uy, uz] = patch.axisU;
  const [vx, vy, vz] = patch.axisV;
  const side = patch.side;
  for (let y = 0; y < outSize; y++) {
    // Row 0 is +v: a wall's top, not its bottom.
    const fv = 0.5 - (y + 0.5) / outSize;
    for (let x = 0; x < outSize; x++) {
      const fu = (x + 0.5) / outSize - 0.5;
      const wx = cx + side * (ux * fu + vx * fv);
      const wy = cy + side * (uy * fu + vy * fv);
      const wz = cz + side * (uz * fu + vz * fv);
      const w = m[3]! * wx + m[7]! * wy + m[11]! * wz + m[15]!;
      const o = 4 * (y * outSize + x);
      if (!(w > 0)) continue;
      const ndcX = (m[0]! * wx + m[4]! * wy + m[8]! * wz + m[12]!) / w;
      const ndcY = (m[1]! * wx + m[5]! * wy + m[9]! * wz + m[13]!) / w;
      sampleBilinear(gen, genSize, ((ndcX + 1) * 0.5) * genSize - 0.5, ((1 - ndcY) * 0.5) * genSize - 0.5, out, o);
    }
  }
  return out;
}

/**
 * Make a rectified patch tile in world space: cross-fade it with a copy offset by half a tile, over a
 * `seamShare` band along its own edges (the 2-sample overlap blend `transferDetail` uses). Only the
 * deviation from the patch's mean is cross-faded and renormalised by `1 / sqrt(w1^2 + w2^2)`, so the
 * band keeps the grain's amplitude and the patch's colour instead of washing out or brightening; on
 * the border one sample has weight 1 and the other 0, which is what lets the edges wrap.
 */
export function makeSwatchTileable(src: Uint8ClampedArray, size = SWATCH_SIZE, seamShare = SWATCH_SEAM_SHARE): Uint8ClampedArray {
  const half = size >> 1;
  const band = Math.max(1, Math.round(size * seamShare));
  const mean = [0, 0, 0];
  for (let i = 0; i < size * size; i++) for (let c = 0; c < 3; c++) mean[c] = mean[c]! + src[4 * i + c]!;
  for (let c = 0; c < 3; c++) mean[c] = mean[c]! / (size * size);
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < size; y++) {
    const y2 = (y + half) % size;
    for (let x = 0; x < size; x++) {
      const x2 = (x + half) % size;
      // 0 on the patch's border, 1 the band's width in: the same weight on all four sides, so the
      // four edges wrap into each other.
      const near = Math.min(1, Math.min(x, size - 1 - x, y, size - 1 - y) / band);
      const w1 = near;
      const w2 = 1 - near;
      const scale = 1 / Math.sqrt(w1 * w1 + w2 * w2);
      const a = 4 * (y * size + x);
      const b = 4 * (y2 * size + x2);
      for (let c = 0; c < 3; c++) {
        const m = mean[c]!;
        out[a + c] = m + scale * (w1 * (src[a + c]! - m) + w2 * (src[b + c]! - m));
      }
      out[a + 3] = 255;
    }
  }
  return out;
}

/** Bilinear RGBA sample of a square image at a continuous pixel coordinate, edges clamped. */
function sampleBilinear(src: Uint8ClampedArray, size: number, px: number, py: number, out: Uint8ClampedArray, o: number) {
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const fx = px - x0;
  const fy = py - y0;
  const xa = Math.min(size - 1, Math.max(0, x0));
  const xb = Math.min(size - 1, Math.max(0, x0 + 1));
  const ya = Math.min(size - 1, Math.max(0, y0));
  const yb = Math.min(size - 1, Math.max(0, y0 + 1));
  const pa = 4 * (ya * size + xa);
  const pb = 4 * (ya * size + xb);
  const pc = 4 * (yb * size + xa);
  const pd = 4 * (yb * size + xb);
  const w1 = (1 - fx) * (1 - fy);
  const w2 = fx * (1 - fy);
  const w3 = (1 - fx) * fy;
  const w4 = fx * fy;
  for (let c = 0; c < 3; c++) {
    out[o + c] = src[pa + c]! * w1 + src[pb + c]! * w2 + src[pc + c]! * w3 + src[pd + c]! * w4;
  }
  out[o + 3] = 255;
}

function unit(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
