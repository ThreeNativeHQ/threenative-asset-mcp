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
 * stretching, no resampling of a resampled image). It is made tileable in two ways (phase 2n): an axis
 * whose paint repeats on a clear period — brick courses, setts, a floor's paving — is cropped to whole
 * periods with the seam inside a joint, so it wraps with no blend at all; an axis without one keeps a
 * narrow cross-fade against a copy offset by half a tile, the way `transferDetail` tiles an island's
 * fill. A blend band mixes two layouts, so on a coursed wall the misaligned joints inside it read as
 * doubled mortar at arm's length: the band is the fallback, not the rule. Plain math over arrays (no
 * DOM, no GPU) so the node tests run the same rules the browser applies.
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
 * Per class, the angle between a patch's normal and the direction to its view above which no patch is
 * cut, in degrees. A wall is only cut near head-on: at 50 degrees one view pixel covers 1.56x as much
 * surface along one axis, and the swatch would stretch that. A floor is allowed further (phase 2n):
 * rectification is an inverse projection, so a floor cut at 60 degrees is still true scale — one view
 * pixel covers 1/cos(60) = 2x as much surface along depth as across, so it is only softer there.
 */
export const SWATCH_MAX_INCIDENCE_DEG: Readonly<Record<SwatchClass, number>> = { wall: 50, floor: 65 };

/**
 * Share of a side the cross-fade band covers, on an axis with no mortar snap (phase 2n): narrow, not
 * `transferDetail`'s quarter. The band is where two layouts are mixed, and a coursed surface shows it.
 */
export const SWATCH_SEAM_SHARE = 0.08;

/**
 * Unsharp mask applied where the swatch is cut (phase 2x). The paint's mortar joints come out soft: the
 * swatch is a 1.7x upscale of soft source pixels, so at 0.35 m a joint is a 20 px ramp, and 2w measured
 * that a shader unsharp at the atlas' own mip bias cannot narrow it (the atlas the shader samples carries
 * no energy at that scale). The cut is the one place with the paint at its own texels, so the joint is
 * steepened here and the game samples a swatch that already reads as an edge.
 *
 * Sigma is about one joint edge in swatch texels — a 12 mm mortar joint is 8 texels at 1.46 mm — so the
 * mask acts on the joint and leaves the paint's grain alone; the amount is the smallest that halves a
 * joint's 10-90 % edge width (tests/texture-projection-swatch.test.ts pins both).
 */
export const SWATCH_SHARPEN_SIGMA = 3;
export const SWATCH_SHARPEN_AMOUNT = 2.5;

/**
 * The period of a course profile is taken only when its normalised autocorrelation peaks above this:
 * below it the profile has structure without a repeat, and cropping to it would cut the paint apart.
 */
export const SWATCH_PERIOD_MIN_CORRELATION = 0.3;

/** Shortest lag a period is looked for at, px: anything shorter is grain, not a course or a sett. */
const SWATCH_PERIOD_MIN_LAG = 8;

/** How far a peak has to climb out of its trough to count as a repeat rather than a flat stretch. */
const SWATCH_PERIOD_MIN_RISE = 0.15;

/**
 * Repeats a snap has to cover: one would repeat at its own pitch and read as a stripe, and two or three
 * are thin evidence of a repeat. It also keeps a patch's own lighting gradient — which nearly equals
 * itself half an image later — from ever being taken for a period.
 */
const SWATCH_MIN_PERIODS = 4;

/**
 * How much darker than its own neighbourhood a row has to be to be a bed joint, as a share of the row
 * profile's range (phase 2y). The painted mortar of the sample courtyard is only ~15 % darker than its
 * bricks, so the bar is low; it is a share of the range, not a level, so a sunlit and a shaded wall pass
 * the same. A dip that fails it is the paint's tonal variation, and cutting there would join two patches.
 */
const SWATCH_JOINT_MIN_DEPTH = 0.18;

/** Joints a coursed wall has to show before its rows are trusted to be courses, not one dark stain. */
const SWATCH_JOINT_MIN_COUNT = 4;

/** Radius of the row profile's slow average, as a share of the image: the neighbourhood a joint darkens. */
const SWATCH_JOINT_BASE_SHARE = 1 / 16;

/**
 * Share of the rows at each end a bed-joint crop may open and close in: the tile starts inside a joint
 * in the top quarter of the patch and ends inside one in the bottom quarter, so the wrap needs no blend
 * and the cut loses at most half the paint.
 */
const SWATCH_JOINT_WINDOW_SHARE = 0.25;

/**
 * A course's own x wrap is closed by a head joint drawn across the seam, half of it on either side: a
 * mortar band as wide as the bed joints are thick, ramping out over this many px so the joint keeps a
 * soft edge instead of a two-texel step (phase 2y).
 */
const SWATCH_HEAD_SOFT_PX = 1.5;

/** Spread of the grain a drawn head joint carries, in levels: enough to break a flat stripe, small
 * enough that the two sides of the seam still agree.
 */
const SWATCH_HEAD_GRAIN = 12;

/**
 * The engine transcodes a base-colour map in 4x4 texel blocks and refuses one that is not a whole number of
 * them (the cook's ktx2 pass fails on e.g. 1024x871). A tile cut to joints therefore has each of its sides
 * snapped to one, which a joint crop can afford: its ends are inside a joint, and two rows either way
 * around a joint's centre are still mortar.
 */
const SWATCH_BLOCK = 4;

/**
 * How far each course is rolled along x: half the tile on alternate courses, plus a deterministic jitter
 * of up to this share either way, so the head joints stagger like a running bond and never stack up.
 */
const SWATCH_BOND_OFFSET_SHARE = 0.5;
const SWATCH_BOND_JITTER_SHARE = 0.15;

/**
 * Share of a period a joint may cover, after folding the profile onto one period. A mortar joint is a
 * narrow band of a course (a tenth of it); a dip wider than this is a tonal patch — moss on a sett floor,
 * a stain — and cutting there would butt two unrelated patches together, so that axis keeps its fade.
 */
const SWATCH_JOINT_MAX_SHARE = 0.25;

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

/** A cut, tileable swatch: its pixels, and the extent each of its axes covers in metres. */
export interface SwatchTile {
  readonly pixels: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  /** Extent along the patch's u axis, metres: the tile's width when a game repeats it. */
  readonly metresX: number;
  /** Extent along the patch's v axis, metres: its height. */
  readonly metresY: number;
  /** Period the axis was cut on, px, and its own; 0 where the axis has no clear one and was cross-faded. */
  readonly periodX: number;
  readonly periodY: number;
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
  const cosLimit = Math.cos((SWATCH_MAX_INCIDENCE_DEG[search.klass] * Math.PI) / 180);
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
  if (incidence >= SWATCH_MAX_INCIDENCE_DEG[search.klass]) return undefined;
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
 * Make the rectified patch a tile in world space (phase 2n). An axis whose paint repeats on a clear
 * period is cropped to whole periods, starting on the darkest row (column) of the period, so the tile's
 * two ends are the two halves of one joint and it wraps with no blend there. An axis without one is
 * cross-faded with a copy offset by half a tile over a narrow band along its own edges (the 2-sample
 * overlap blend `transferDetail` uses). Only the deviation from the patch's mean is cross-faded and
 * renormalised by `1 / sqrt(w1^2 + w2^2)`, so the band keeps the grain's amplitude and the patch's
 * colour instead of washing out or brightening; on the border one sample has weight 1 and the other 0,
 * which is what lets the edges wrap.
 *
 * A wall without a period takes a third path (phase 2y), because the blend is what a coursed wall shows:
 * the painted courses of the sample courtyard have no repeat, so both axes were faded, and at a metre the
 * band read as a strip of thin courses with two parallel bed joints and as joint stubs cut by a vertical
 * line. Such a wall's bed joints are found in the row profile instead and the rows are cut to two of
 * them, so the wrap lands inside mortar and needs no blend; each course then closes its own x wrap on a
 * head joint drawn across the seam and is rolled onto a running bond. When no bed joints are found the
 * blend stays — a wall with no courses has nothing better to wrap on.
 *
 * The crop is what the swatch's own extent has to follow: a cropped axis covers less than `side`, so
 * the tile reports `metresX` and `metresY` and a game repeats it with both. The pixel grid itself is
 * untouched (whole rows and columns are dropped, never resampled), so the metres per pixel stay the
 * patch's own on both axes.
 */
export function tileSwatch(
  rectified: Uint8ClampedArray,
  side: number,
  size = SWATCH_SIZE,
  klass: SwatchClass = 'wall',
): SwatchTile {
  // One profile per axis: the mean over a row says what a course does down y, the mean over a column
  // says what a joint does across x.
  const rows = smoothed(axisProfile(rectified, size, true));
  const columns = smoothed(axisProfile(rectified, size, false));
  const periodY = axisPeriod(rows);
  const periodX = axisPeriod(columns);
  if (klass === 'wall' && periodY === 0) {
    const joints = bedJoints(rows, size);
    // The x axis keeps a period it has: a head-joint wrap drawn over a repeating pattern would be a
    // second, freer rule where the paint already gives one.
    if (joints) {
      const croppedX = periodX > 0 ? periodCrop(columns, periodX) : undefined;
      return jointSwatch(rectified, side, size, joints, croppedX && { ...croppedX, period: periodX });
    }
  }
  const croppedY = periodY > 0 ? periodCrop(rows, periodY) : undefined;
  const croppedX = periodX > 0 ? periodCrop(columns, periodX) : undefined;
  const left = croppedX?.start ?? 0;
  const top = croppedY?.start ?? 0;
  const width = croppedX?.length ?? size;
  const height = croppedY?.length ?? size;
  const mean = [0, 0, 0];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = 4 * ((top + y) * size + left + x);
      for (let c = 0; c < 3; c++) mean[c] = mean[c]! + rectified[at + c]!;
    }
  }
  for (let c = 0; c < 3; c++) mean[c] = mean[c]! / (width * height);
  const bandX = Math.max(1, Math.round(width * SWATCH_SEAM_SHARE));
  const bandY = Math.max(1, Math.round(height * SWATCH_SEAM_SHARE));
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    // A cropped axis is not blended and not rolled: its two ends already continue each other.
    const nearY = croppedY ? 1 : edgeWeight(y, height, bandY);
    const y2 = croppedY ? y : (y + (height >> 1)) % height;
    for (let x = 0; x < width; x++) {
      const nearX = croppedX ? 1 : edgeWeight(x, width, bandX);
      const x2 = croppedX ? x : (x + (width >> 1)) % width;
      const w1 = Math.min(nearX, nearY);
      const w2 = 1 - w1;
      const scale = 1 / Math.sqrt(w1 * w1 + w2 * w2);
      const a = 4 * (y * width + x);
      const b = 4 * ((top + y2) * size + left + x2);
      const c0 = 4 * ((top + y) * size + left + x);
      for (let c = 0; c < 3; c++) {
        const m = mean[c]!;
        out[a + c] = m + scale * (w1 * (rectified[c0 + c]! - m) + w2 * (rectified[b + c]! - m));
      }
      out[a + 3] = 255;
    }
  }
  return {
    // The cut is the last place the joint can be made crisp: sharpened at the tile's own texels (2x).
    pixels: sharpenSwatch(out, width, height),
    width,
    height,
    metresX: (side * width) / size,
    metresY: (side * height) / size,
    periodX: croppedX ? periodX : 0,
    periodY: croppedY ? periodY : 0,
  };
}

/**
 * The tile's own unsharp mask (phase 2x): `pixel + amount * (pixel - blur(pixel))`, clamped to the byte
 * range. The blur samples the tile with wrap, so a tiled swatch sees its own edges as the game will and
 * the mean is kept exactly where the paint is not clipped.
 */
export function sharpenSwatch(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  sigma = SWATCH_SHARPEN_SIGMA,
  amount = SWATCH_SHARPEN_AMOUNT,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixels);
  const kernel = gaussianKernel(sigma);
  const rgb = new Float32Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    for (let c = 0; c < 3; c++) rgb[3 * i + c] = pixels[4 * i + c]!;
  }
  const blurred = blurAxis(blurAxis(rgb, width, height, kernel, true), width, height, kernel, false);
  for (let i = 0; i < width * height; i++) {
    for (let c = 0; c < 3; c++) {
      // Uint8ClampedArray rounds and clamps: the overshoot at a joint's dark core stops at the byte floor.
      out[4 * i + c] = pixels[4 * i + c]! + amount * (pixels[4 * i + c]! - blurred[3 * i + c]!);
    }
  }
  return out;
}

/** A normalised Gaussian of `sigma`, truncated at three sigma. */
function gaussianKernel(sigma: number): Float64Array {
  const radius = Math.max(1, Math.ceil(3 * sigma));
  const kernel = new Float64Array(2 * radius + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    kernel[i + radius] = Math.exp(-(i * i) / (2 * sigma * sigma));
    sum += kernel[i + radius]!;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] = kernel[i]! / sum;
  return kernel;
}

/** One separable pass of a Gaussian over an RGB plane, wrapping at both edges like the tile it is. */
function blurAxis(
  src: Float32Array,
  width: number,
  height: number,
  kernel: Float64Array,
  horizontal: boolean,
): Float32Array {
  const radius = (kernel.length - 1) / 2;
  const out = new Float32Array(src.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const to = 3 * (y * width + x);
      for (let t = -radius; t <= radius; t++) {
        const k = kernel[t + radius]!;
        const at = horizontal
          ? 3 * (y * width + (((x + t) % width) + width) % width)
          : 3 * (((((y + t) % height) + height) % height) * width + x);
        for (let c = 0; c < 3; c++) out[to + c] = out[to + c]! + k * src[at + c]!;
      }
    }
  }
  return out;
}

/** 0 on the border of the band, 1 the band's width in: the same weight on both of an axis' edges. */
function edgeWeight(at: number, span: number, band: number): number {
  return Math.min(1, Math.min(at, span - 1 - at) / band);
}

/** Mean luminance per row of a square image (courses down y) or per column (setts across x). */
function axisProfile(image: Uint8ClampedArray, size: number, perRow: boolean): Float64Array {
  const out = new Float64Array(size);
  for (let a = 0; a < size; a++) {
    let sum = 0;
    for (let b = 0; b < size; b++) {
      const at = 4 * (perRow ? a * size + b : b * size + a);
      sum += 0.299 * image[at]! + 0.587 * image[at + 1]! + 0.114 * image[at + 2]!;
    }
    out[a] = sum / size;
  }
  return out;
}

/** A 3-tap box over the profile: the paint's own grain is not a course, and would fake two peaks. */
function smoothed(profile: Float64Array): Float64Array {
  const count = profile.length;
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const before = profile[Math.max(0, i - 1)]!;
    const after = profile[Math.min(count - 1, i + 1)]!;
    out[i] = (before + profile[i]! + after) / 3;
  }
  return out;
}

/**
 * The repeat this profile shows, in px, or 0 when it shows none. The normalised autocorrelation's first
 * peak after its first trough: a coursed wall's row profile is a square wave whose correlation is back
 * to ~1 at one course height, while a profile without a repeat never peaks.
 */
function axisPeriod(values: Float64Array): number {
  const count = values.length;
  const longest = Math.floor(count / 2);
  if (longest <= SWATCH_PERIOD_MIN_LAG) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / count;
  let energy = 0;
  for (let i = 0; i < count; i++) energy += (values[i]! - mean) ** 2;
  // A constant profile — a checkerboard's rows are all the same — has no period at all.
  if (!(energy / count > 1e-6)) return 0;
  const r = new Float64Array(longest + 1);
  for (let lag = 1; lag <= longest; lag++) {
    let dot = 0;
    let before = 0;
    let after = 0;
    for (let i = 0; i + lag < count; i++) {
      const a = values[i]! - mean;
      const b = values[i + lag]! - mean;
      dot += a * b;
      before += a * a;
      after += b * b;
    }
    r[lag] = before > 0 && after > 0 ? dot / Math.sqrt(before * after) : 0;
  }
  let trough = -1;
  for (let lag = SWATCH_PERIOD_MIN_LAG; lag < longest; lag++) {
    if (r[lag]! < r[lag - 1]! && r[lag]! <= r[lag + 1]!) {
      trough = lag;
      break;
    }
  }
  if (trough < 0) return 0;
  // The shortest repeat that is clearly one: a later, stronger peak is a multiple of it, and taking that
  // would cost the swatch the paint of the periods it skips. A peak also has to climb out of the trough —
  // one that sits on a plateau's noise is no repeat — and be a peak at all, so a period longer than the
  // window, which only rises to its edge, is not read as one.
  let best = 0;
  for (let lag = trough + 1; lag < longest; lag++) {
    if (!(r[lag]! >= r[lag - 1]! && r[lag]! >= r[lag + 1]!)) continue;
    if (r[lag]! < SWATCH_PERIOD_MIN_CORRELATION || r[lag]! - r[trough]! < SWATCH_PERIOD_MIN_RISE) continue;
    best = lag;
    break;
  }
  if (best === 0) return 0;
  // The peak has to be one the window can hold: a crop needs whole periods, and enough of them to be a repeat.
  return Math.floor(count / best) >= SWATCH_MIN_PERIODS ? best : 0;
}

/**
 * Where to cut a rectified swatch on an axis with a period: the longest whole number of periods that
 * opens on a mortar joint, so the paint carries on across the wrap and the wrap needs no blend. A start
 * that leaves no whole period is given up for one period less, so the clearest joint in the image is
 * the one the seam lands in.
 */
function periodCrop(values: Float64Array, period: number): { start: number; length: number } | undefined {
  const count = values.length;
  // Fold the profile onto one period: the mean over every occurrence of each phase. Folding averages
  // the patch's own lighting gradient out, so the joint this finds is the paint's, not its shading.
  const folded = new Float64Array(period);
  for (let phase = 0; phase < period; phase++) {
    let sum = 0;
    let seen = 0;
    for (let at = phase; at < count; at += period) {
      sum += values[at]!;
      seen++;
    }
    folded[phase] = sum / seen;
  }
  let darkest = 0;
  for (let phase = 1; phase < period; phase++) if (folded[phase]! < folded[darkest]!) darkest = phase;
  const mid = (Math.min(...folded) + Math.max(...folded)) / 2;
  // A joint is a narrow band of a course, not a broad tonal patch (see SWATCH_JOINT_MAX_SHARE).
  let below = 0;
  for (let phase = 0; phase < period; phase++) if (folded[phase]! < mid) below++;
  if (below > period * SWATCH_JOINT_MAX_SHARE) return undefined;
  // The joint's first row, not its darkest: then the whole joint opens the tile and the tile's last row
  // is the brick just before the next one, so the wrap reads as one ordinary joint. Starting on the
  // darkest row instead would split the joint across the seam and leave half of it there.
  let joint = darkest;
  for (let up = 1; up < period >> 2; up++) {
    const phase = (darkest - up + period) % period;
    if (folded[phase]! >= mid) break;
    joint = phase;
  }
  for (let periods = Math.floor(count / period); periods >= SWATCH_MIN_PERIODS; periods--) {
    const length = periods * period;
    // The clearest joint of that phase: the darkest of its occurrences that still leaves whole periods.
    let start = -1;
    let lowest = Infinity;
    for (let row = joint; row + length <= count; row += period) {
      if (values[row]! < lowest) {
        lowest = values[row]!;
        start = row;
      }
    }
    if (start >= 0) return { start, length };
  }
  return undefined;
}

/** A bed joint the wall path found in the row profile. */
interface BedJoint {
  /** Centre row of the joint, in the rectified patch's own rows. */
  readonly row: number;
  /** How far above the joint the rows around it sit, in profile levels: the clearest joint of a window wins. */
  readonly depth: number;
  /** Rows its dark core covers, px: the head joints the tile draws take their width from these. */
  readonly thickness: number;
}

/** Where a coursed wall is cut, and the joints its courses are made of. */
interface JointCrop {
  /** Row the tile starts on: the centre of a bed joint in the top quarter of the patch. */
  readonly top: number;
  /** Row the tile ends on: the centre of a bed joint in the bottom quarter. */
  readonly bottom: number;
  readonly joints: readonly BedJoint[];
  /** Width of the band the tile's head joints are drawn with, px: the median bed joint's own thickness. */
  readonly headWidth: number;
}

/**
 * The bed joints a coursed wall shows, and where to cut it (phase 2y). A bed joint is a narrow band of
 * rows clearly darker than the rows around it: the row profile is compared against its own slow average,
 * so the wall's lighting gradient — which makes the profile's absolute level meaningless — drops out, and
 * the darkest row of each dip is the joint's centre. A dip that is not deep enough, or is glossed over by
 * a nearby deeper one, is the paint's tonal variation, not a joint. A wall with fewer than
 * `SWATCH_JOINT_MIN_COUNT` joints is not coursed: it keeps the blend.
 *
 * The crop opens and closes inside the clearest joint of the top and bottom quarter, so both ends of the
 * tile are mortar and the half of each joint left outside the cut is what the other end's half meets when
 * the tile repeats.
 */
function bedJoints(values: Float64Array, size: number): JointCrop | undefined {
  const count = values.length;
  let low = Infinity;
  let high = -Infinity;
  for (const value of values) {
    low = Math.min(low, value);
    high = Math.max(high, value);
  }
  if (!(high - low > 1e-6)) return undefined;
  const minDepth = SWATCH_JOINT_MIN_DEPTH * (high - low);
  const radius = Math.max(8, Math.round(size * SWATCH_JOINT_BASE_SHARE));
  // A joint is a few rows wide; a dip narrower than the grain is not one.
  const reach = Math.max(2, Math.round(size / 256));
  const spacing = Math.max(4, Math.round(size / 32));
  const found: BedJoint[] = [];
  for (let row = reach; row < count - reach; row++) {
    const base = neighbourhood(values, row, radius);
    const depth = base - values[row]!;
    if (depth < minDepth) continue;
    let darkest = true;
    for (let t = -reach; t <= reach; t++) {
      if (t !== 0 && values[row + t]! < values[row]!) {
        darkest = false;
        break;
      }
    }
    if (!darkest) continue;
    // The joint's own rows: how far the dip stays past halfway back up to its neighbourhood.
    const level = (values[row]! + base) / 2;
    let above = 0;
    while (row - above - 1 >= 0 && values[row - above - 1]! < level) above++;
    let below = 0;
    while (row + below + 1 < count && values[row + below + 1]! < level) below++;
    found.push({ row, depth, thickness: above + below + 1 });
  }
  if (found.length < SWATCH_JOINT_MIN_COUNT) return undefined;
  // One joint per course: of two candidates closer together than a course, the deeper is the joint.
  found.sort((a, b) => b.depth - a.depth);
  const joints: BedJoint[] = [];
  for (const joint of found) {
    if (joints.some((kept) => Math.abs(kept.row - joint.row) < spacing)) continue;
    joints.push(joint);
  }
  if (joints.length < SWATCH_JOINT_MIN_COUNT) return undefined;
  joints.sort((a, b) => a.row - b.row);
  const window = Math.max(1, Math.round(count * SWATCH_JOINT_WINDOW_SHARE));
  const clearest = (from: number, to: number) => {
    let best: BedJoint | undefined;
    for (const joint of joints) {
      if (joint.row < from || joint.row >= to) continue;
      if (!best || joint.depth > best.depth) best = joint;
    }
    return best;
  };
  const top = clearest(0, window);
  const bottom = clearest(count - window, count);
  // A crop that keeps less than half the patch is a cut on two dips, not a tile of this wall.
  if (!top || !bottom || bottom.row - top.row < count / 2) return undefined;
  const thicknesses = joints.map((joint) => joint.thickness).sort((a, b) => a - b);
  const median = thicknesses[Math.floor(thicknesses.length / 2)]!;
  // Both ends to a block boundary: two rows either way around a joint's centre are still its core, and the
  // tile's height then is a whole number of the blocks the engine transcodes.
  const aligned = (row: number) => Math.min(count, Math.max(0, Math.round(row / SWATCH_BLOCK) * SWATCH_BLOCK));
  return {
    top: aligned(top.row),
    bottom: aligned(bottom.row),
    joints,
    headWidth: Math.max(3, Math.min(Math.round(size / 16), median)),
  };
}

/** The largest whole number of transcoding blocks no longer than `value`. */
function blockAligned(value: number): number {
  return Math.max(SWATCH_BLOCK, value - (value % SWATCH_BLOCK));
}

/** The mean of `values` over `radius` either side of `at`, clamped to the ends. */
function neighbourhood(values: Float64Array, at: number, radius: number): number {
  let sum = 0;
  let seen = 0;
  for (let t = -radius; t <= radius; t++) {
    const i = at + t;
    if (i < 0 || i >= values.length) continue;
    sum += values[i]!;
    seen++;
  }
  return sum / seen;
}

/**
 * The tile of a coursed wall (phase 2y): the patch's rows cut to two bed joints, and — where the columns
 * have no period of their own — each course's x wrap closed on a head joint instead of cross-faded. The
 * y axis needs no blend at all: both of its ends are mortar, and so is the wrap.
 */
function jointSwatch(
  rectified: Uint8ClampedArray,
  side: number,
  size: number,
  crop: JointCrop,
  columns: { start: number; length: number; period: number } | undefined,
): SwatchTile {
  const left = columns?.start ?? 0;
  // A period the x axis kept ends just short of the next joint, so dropping the last few columns of it is
  // as safe as keeping them; a side off the block grid is not.
  const width = blockAligned(columns?.length ?? size);
  const height = blockAligned(crop.bottom - crop.top);
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const from = 4 * ((crop.top + y) * size + left);
    out.set(rectified.subarray(from, from + 4 * width), 4 * y * width);
  }
  if (!columns) closeHeadJoints(out, width, height, crop);
  return {
    // Sharpened as the periodic crop is: the drawn head joints are made crisp the same way the paint's
    // bed joints are, so they read as one material.
    pixels: sharpenSwatch(out, width, height),
    width,
    height,
    metresX: (side * width) / size,
    metresY: (side * height) / size,
    // Neither axis was cut on a period here: y was cut to joints; x either keeps its own period or is
    // closed per course, and a course boundary is not a repeat the game may use.
    periodX: columns ? columns.period : 0,
    periodY: 0,
  };
}

/**
 * Close every course's own x wrap on a head joint (phase 2y). The band is drawn across the seam first —
 * half of it either side, blended to the mortar the bed joints are made of — and only then is the course
 * rolled onto its bond, so the place the roll's copy jumps falls inside the joint: the tile's own seam is
 * mortar on both sides, never brick against brick, and a rolled course stays continuous because a circular
 * shift of a circularly continuous row is continuous. Alternate courses take half the width, so the drawn
 * joints stagger like a running bond instead of stacking into a vertical line.
 */
function closeHeadJoints(pixels: Uint8ClampedArray, width: number, height: number, crop: JointCrop) {
  const bounds = [0];
  for (const joint of crop.joints) {
    const row = joint.row - crop.top;
    if (row > 0 && row < height) bounds.push(row);
  }
  bounds.push(height);
  const mortar = jointColour(pixels, width, height, bounds);
  const reach = Math.max(1, Math.round(crop.headWidth / 2));
  const scratch = new Uint8ClampedArray(width * 4);
  for (let course = 0; course < bounds.length - 1; course++) {
    const from = bounds[course]!;
    const to = bounds[course + 1]!;
    for (let y = from; y < to; y++) {
      const base = 4 * y * width;
      // A joint is not a printed stripe: its width wanders down the course, and mortar has grain. Both
      // only depend on the distance to the seam and the row, so the band is mirror-symmetric about the
      // seam and stays continuous across it (the unsharp mask would ring on a step there).
      const edge = reach + Math.round(1.5 * Math.sin(y * 0.09) + Math.sin(y * 0.031 + 2.1));
      // Out to the soft edge and no further: the last column the band writes has to be all brick, or the
      // joint would end on a step instead of on the ramp the paint's own joints have.
      for (let d = 0; d < edge + SWATCH_HEAD_SOFT_PX; d++) {
        const weight = Math.min(1, Math.max(0, (edge - d) / SWATCH_HEAD_SOFT_PX));
        if (!(weight > 0)) break;
        let hash = (Math.imul(d + 1, 0x9e3779b1) ^ Math.imul(y + 1, 0x85ebca6b)) >>> 0;
        hash ^= hash >>> 15;
        const grain = ((hash % 1000) / 1000 - 0.5) * SWATCH_HEAD_GRAIN;
        for (const x of [d, width - 1 - d]) {
          const at = base + 4 * x;
          for (let c = 0; c < 3; c++) pixels[at + c] = (1 - weight) * pixels[at + c]! + weight * (mortar[c]! + grain);
        }
      }
    }
    const offset = bondOffset(course, width);
    if (offset === 0) continue;
    for (let y = from; y < to; y++) {
      const base = 4 * y * width;
      for (let x = 0; x < width; x++) {
        const at = base + 4 * ((((x - offset) % width) + width) % width);
        scratch[4 * x] = pixels[at]!;
        scratch[4 * x + 1] = pixels[at + 1]!;
        scratch[4 * x + 2] = pixels[at + 2]!;
        scratch[4 * x + 3] = 255;
      }
      pixels.set(scratch, base);
    }
  }
}

/**
 * The mortar the tile's head joints are made of: the mean RGB of every bed joint's core rows. Averaged over
 * all the joints and the whole width, so one joint's stain — and the paint's lighting gradient, which
 * brightens a joint at one end of the patch — does not carry into a band drawn somewhere else.
 */
function jointColour(pixels: Uint8ClampedArray, width: number, height: number, bounds: readonly number[]): Vec3 {
  const sum = [0, 0, 0];
  let count = 0;
  for (const bound of bounds) {
    // The core only: the rows either side of the joint's centre are its darkest, and the ones beyond are
    // the brick's own edge, which is lighter and would wash the band out.
    for (let dy = -1; dy <= 1; dy++) {
      const y = bound + dy;
      if (y < 0 || y >= height) continue;
      for (let x = 0; x < width; x++) {
        for (let c = 0; c < 3; c++) sum[c] = sum[c]! + pixels[4 * (y * width + x) + c]!;
      }
      count += width;
    }
  }
  if (count === 0) return [0, 0, 0];
  return [sum[0]! / count, sum[1]! / count, sum[2]! / count];
}

/**
 * How far a course is rolled along x: alternate courses take half the tile, the way a running bond
 * staggers its head joints, and every course its own fixed jitter — a hash of its index, not a random, so
 * the same paint gives the same swatch on every run.
 */
function bondOffset(course: number, width: number): number {
  const half = course % 2 === 0 ? 0 : Math.round(width * SWATCH_BOND_OFFSET_SHARE);
  let hash = Math.imul(course + 1, 0x9e3779b1) >>> 0;
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash = (hash ^ (hash >>> 13)) >>> 0;
  const jitter = Math.round((((hash % 1001) / 1000) * 2 - 1) * width * SWATCH_BOND_JITTER_SHARE);
  return (((half + jitter) % width) + width) % width;
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
