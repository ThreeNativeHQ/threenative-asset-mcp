import { createHash } from "node:crypto";

// T1 geometry core: pre-scale glTF geometry in; UE composition, barycentric queries and analytic derivatives out.
// The result is PreparedSpatialGeometry (untrusted atlas). Nothing here certifies anything: only the T2 certifier
// certifies layout only. ValidatedSpatialContext also requires verified source-route admission. Every derived value is checked before it decides anything or
// leaves the module; an overflow or NaN refuses with the named code "nonfinite".

/** Named reason for a refusal. */
export type SpatialRefusalCode =
  | "bad-length"
  | "bad-index"
  | "bad-uv-set"
  | "bad-triangle"
  | "bad-barycentric"
  | "nonfinite"
  | "degenerate-triangle"
  | "degenerate-normal"
  | "unproved-route"
  | "cooked"
  | "non-identity-transform"
  | "reflected-transform"
  | "deformation-unsupported"
  | "unknown-scale"
  | "nonuniform-scale"
  | "non-positive-scale"
  | "missing-uv-set";

export class SpatialSurfaceRefusal extends Error {
  readonly code: SpatialRefusalCode;

  constructor(code: SpatialRefusalCode, detail: string) {
    super(`spatial surface refused (${code}): ${detail}`);
    this.name = "SpatialSurfaceRefusal";
    this.code = code;
  }
}

/**
 * Route declaration supplied by the caller. In this math-only stage it is a declaration, NOT an attested proof: nothing
 * here reads or verifies the export that produced the mesh. Only the pinned UModel uncooked SourceModels route with
 * bCooked 0 is accepted as a value. Production admission will be gated separately by a route receipt (implementation pending), and needs
 * more than this value (docs/plans/2026-10-10-spatial-material-bake.md, T1 prerequisites).
 */
export interface SourceRouteProof {
  readonly tool: "umodel";
  /** Must be the pinned UModel commit a0bfb468d42be831b126632fd8a0ae6b3614f981. */
  readonly commit: string;
  readonly container: "SourceModels";
  readonly bCooked: 0 | 1;
  /** Raw CVT identity; the export maps UE (X, Y, Z) to glTF (X, Z, Y). */
  readonly axisExport: "XZY";
  /** Export scale from centimetres to metres. */
  readonly exportScale: number;
}

/** Pending BuildScale: known, or explicitly unknown (which refuses). */
export type BuildScaleInput =
  | { readonly known: true; readonly xyz: readonly [number, number, number] }
  | { readonly known: false };

export interface SpatialGeometryInput {
  /** Pre-scale glTF positions in metres, x y z per vertex. Copied. */
  readonly positions: ArrayLike<number>;
  /** Declared glTF normals, one per vertex. Copied; never replaced by a face normal. */
  readonly normals: ArrayLike<number>;
  /** Every original UV set (TEXCOORD_n), two values per vertex. Copied. */
  readonly originalUv: ReadonlyArray<{ readonly set: number; readonly uv: ArrayLike<number> }>;
  /** Atlas layout, two values per vertex. Untrusted in T1. */
  readonly atlasUv: ArrayLike<number>;
  /** Triangle vertex indices; winding is kept as given. */
  readonly indices: ArrayLike<number>;
  readonly sourceRouteProof: SourceRouteProof;
  readonly buildScale: BuildScaleInput;
  /** Node transform as sixteen column-major values. Only the identity is accepted. */
  readonly nodeTransform: ArrayLike<number>;
  /** Fixed placement in UE centimetres, applied after the scale. Required: there is no default. */
  readonly fixedOrigin: readonly [number, number, number];
  readonly deformation: "none" | "skinned" | "morphed";
}

/** One barycentric query in UE units. Every field is a fresh, frozen copy. */
export interface SpatialSample {
  /** Atlas point of the query. */
  readonly atlas: readonly [number, number];
  /** UE composition position in centimetres: scale and fixed origin applied. */
  readonly position: readonly [number, number, number];
  /** Unit normal along UE axes: the declared normals interpolated, then normalised. */
  readonly normal: readonly [number, number, number];
  /** Interpolated original UV for each requested set. */
  readonly uv: Readonly<Record<number, readonly [number, number]>>;
}

/**
 * Analytic derivatives of a linear-affine triangle with respect to its atlas coordinates (u, then v). The position
 * derivatives come from the untranslated scaled positions, so the fixed origin cannot change them.
 */
export interface SpatialDerivatives {
  /** d(position)/d(atlas u) and d(atlas v), in centimetres per atlas unit. */
  readonly position: readonly [readonly [number, number, number], readonly [number, number, number]];
  /** d(original uv)/d(atlas u) and d(atlas v), for each requested set. */
  readonly uv: Readonly<Record<number, readonly [readonly [number, number], readonly [number, number]]>>;
}

export interface PreparedSpatialGeometry {
  /** Always "untrusted-atlas" in T1. */
  readonly trust: "untrusted-atlas";
  readonly vertexCount: number;
  readonly triangleCount: number;
  /** SHA-256 over geometry, every UV set, indices, source proof, scale and fixed origin. */
  readonly fingerprint: string;
  /** The triangle's vertex indices in stored winding order. */
  triangleVertices(triangle: number): readonly [number, number, number];
  /** Barycentric query. Invalid barycentrics refuse; they are never renormalised. */
  query(triangle: number, barycentric: readonly [number, number, number], uvSets: readonly number[]): SpatialSample;
  derivatives(triangle: number, uvSets: readonly number[]): SpatialDerivatives;
}

const UMODEL_COMMIT = "a0bfb468d42be831b126632fd8a0ae6b3614f981";
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const CM_PER_METRE = 100;
/** Degenerate when twice the area is at most this fraction of the longest edge squared (a sine of about 1e-9). */
const DEGENERATE_AREA_RATIO = 1e-9;
/** Weights may sit this far outside [0, 1] for float noise at an edge. Their sum must be 1 within it. */
const BARYCENTRIC_TOLERANCE = 1e-9;

type Vec3 = [number, number, number];
type Corners = readonly [number, number, number];
type Weights = readonly [number, number, number];

/** The two atlas edges leaving the first corner of a triangle, and the determinant that inverts them. */
interface AtlasFrame {
  readonly e1x: number;
  readonly e1y: number;
  readonly e2x: number;
  readonly e2y: number;
  readonly det: number;
}

function refuse(code: SpatialRefusalCode, detail: string): never {
  throw new SpatialSurfaceRefusal(code, detail);
}

/** Refuses by name unless every value is finite. Overflow and NaN must not reach a decision or an output. */
function requireFinite(what: string, ...values: readonly number[]): void {
  if (!values.every((value) => Number.isFinite(value))) refuse("nonfinite", `${what} is not finite`);
}

function freezeTuple<T extends readonly unknown[]>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function checkRoute(proof: SourceRouteProof): void {
  const pinned =
    proof.tool === "umodel" &&
    proof.commit === UMODEL_COMMIT &&
    proof.container === "SourceModels" &&
    proof.axisExport === "XZY" &&
    proof.exportScale === 0.01;
  if (!pinned) refuse("unproved-route", "route is not the pinned UModel uncooked SourceModels export (XZY, scale 0.01)");
  if (proof.bCooked !== 0) refuse("cooked", "source is cooked (bCooked 1); only uncooked SourceModels are accepted");
}

function checkNodeTransform(matrix: ArrayLike<number>): void {
  if (matrix.length !== 16) refuse("bad-length", `node transform holds ${matrix.length} values; expected 16`);
  const m = Float64Array.from(matrix);
  if (!m.every(Number.isFinite)) refuse("nonfinite", "node transform has a non-finite value");
  // Column-major: a negative determinant of the upper-left 3x3 is a reflection.
  const det =
    m[0]! * (m[5]! * m[10]! - m[9]! * m[6]!) - m[4]! * (m[1]! * m[10]! - m[9]! * m[2]!) + m[8]! * (m[1]! * m[6]! - m[5]! * m[2]!);
  requireFinite("node transform determinant", det);
  if (det < 0) refuse("reflected-transform", "node transform reflects the mesh (negative determinant)");
  if (!m.every((value, index) => value === IDENTITY[index])) {
    refuse("non-identity-transform", "node transform must be the identity; rotation, scale and translation are refused");
  }
}

function uniformScale(buildScale: BuildScaleInput): number {
  if (!buildScale.known) refuse("unknown-scale", "pending BuildScale is unknown; a known uniform scale is required");
  const [x, y, z] = buildScale.xyz;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    refuse("nonfinite", "BuildScale has a non-finite component");
  }
  if (x !== y || y !== z) refuse("nonuniform-scale", `BuildScale [${x}, ${y}, ${z}] is not uniform`);
  if (x <= 0) refuse("non-positive-scale", `BuildScale ${x} is not positive`);
  return x;
}

function checkOrigin(origin: readonly [number, number, number]): void {
  if (origin.length !== 3) refuse("bad-length", `fixed origin holds ${origin.length} values; expected 3`);
  if (!origin.every(Number.isFinite)) refuse("nonfinite", "fixed origin has a non-finite component");
}

function finiteCopy(name: string, values: ArrayLike<number>): Float64Array {
  const copy = Float64Array.from(values);
  if (!copy.every(Number.isFinite)) refuse("nonfinite", `${name} has a non-finite value`);
  return copy;
}

/** True when the atlas triangle (a, b, c) has no area relative to its longest edge. Overflow refuses by name. */
function isDegenerate2(p: Float64Array, a: number, b: number, c: number): boolean {
  const e1x = p[2 * b]! - p[2 * a]!;
  const e1y = p[2 * b + 1]! - p[2 * a + 1]!;
  const e2x = p[2 * c]! - p[2 * a]!;
  const e2y = p[2 * c + 1]! - p[2 * a + 1]!;
  const fx = e2x - e1x;
  const fy = e2y - e1y;
  const twiceArea = Math.abs(e1x * e2y - e1y * e2x);
  const longest = Math.max(e1x * e1x + e1y * e1y, e2x * e2x + e2y * e2y, fx * fx + fy * fy);
  requireFinite("atlas triangle edge arithmetic", e1x, e1y, e2x, e2y, fx, fy, twiceArea, longest);
  return twiceArea <= DEGENERATE_AREA_RATIO * longest;
}

/**
 * True when the triangle (a, b, c), given as glTF positions, has no area relative to its longest edge. The uniform scale,
 * the axis swap and the origin leave that ratio unchanged, so the metres are enough. Overflow refuses by name.
 */
function isDegenerate3(p: Float64Array, a: number, b: number, c: number): boolean {
  const e1 = [0, 1, 2].map((k) => p[3 * b + k]! - p[3 * a + k]!);
  const e2 = [0, 1, 2].map((k) => p[3 * c + k]! - p[3 * a + k]!);
  const f = [0, 1, 2].map((k) => e2[k]! - e1[k]!);
  const cross = [
    e1[1]! * e2[2]! - e1[2]! * e2[1]!,
    e1[2]! * e2[0]! - e1[0]! * e2[2]!,
    e1[0]! * e2[1]! - e1[1]! * e2[0]!,
  ];
  const squared = (v: number[]): number => v[0]! * v[0]! + v[1]! * v[1]! + v[2]! * v[2]!;
  const twiceArea = Math.hypot(cross[0]!, cross[1]!, cross[2]!);
  const longest = Math.max(squared(e1), squared(e2), squared(f));
  requireFinite("triangle edge arithmetic", ...e1, ...e2, ...f, ...cross, twiceArea, longest);
  return twiceArea <= DEGENERATE_AREA_RATIO * longest;
}

function atlasFrame(atlas: Float64Array, c: Corners): AtlasFrame {
  const e1x = atlas[2 * c[1]]! - atlas[2 * c[0]]!;
  const e1y = atlas[2 * c[1] + 1]! - atlas[2 * c[0] + 1]!;
  const e2x = atlas[2 * c[2]]! - atlas[2 * c[0]]!;
  const e2y = atlas[2 * c[2] + 1]! - atlas[2 * c[0] + 1]!;
  const det = e1x * e2y - e2x * e1y;
  requireFinite("atlas triangle edges and determinant", e1x, e1y, e2x, e2y, det);
  return { e1x, e1y, e2x, e2y, det };
}

/**
 * Gradient of one scalar whose differences along the two atlas edges are d1 and d2:
 * [d/d(atlas u), d/d(atlas v)]. Exact for a linear-affine triangle, and constant over it. A quotient that is not finite
 * refuses, including one whose product overflowed on the way.
 */
function edgeGradient(d1: number, d2: number, f: AtlasFrame): [number, number] {
  const du = (d1 * f.e2y - d2 * f.e1y) / f.det;
  const dv = (d2 * f.e1x - d1 * f.e2x) / f.det;
  requireFinite("derivative", du, dv);
  return [du, dv];
}

function blend2(table: Float64Array, w: Weights, c: Corners, what: string): [number, number] {
  let u = 0;
  let v = 0;
  for (let k = 0; k < 3; k++) {
    u += w[k]! * table[2 * c[k]!]!;
    v += w[k]! * table[2 * c[k]! + 1]!;
  }
  requireFinite(what, u, v);
  return [u, v];
}

function blend3(table: Float64Array, w: Weights, c: Corners, what: string): [number, number, number] {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let k = 0; k < 3; k++) {
    x += w[k]! * table[3 * c[k]!]!;
    y += w[k]! * table[3 * c[k]! + 1]!;
    z += w[k]! * table[3 * c[k]! + 2]!;
  }
  requireFinite(what, x, y, z);
  return [x, y, z];
}

function checkTriangleIndex(triangle: number, triangleCount: number): number {
  if (!Number.isInteger(triangle) || triangle < 0 || triangle >= triangleCount) {
    refuse("bad-triangle", `triangle ${triangle} is outside 0..${triangleCount - 1}`);
  }
  return triangle;
}

/** Reads one barycentric weight. A hole, a non-number or a non-finite value refuses. */
function readWeight(barycentric: ArrayLike<unknown>, k: number): number {
  const value: unknown = barycentric[k];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    refuse("bad-barycentric", `barycentric component ${k} is missing, not a number, or not finite`);
  }
  return value;
}

/**
 * Runtime shape check for a barycentric a JavaScript caller may pass: exactly three dense finite numbers, each in range,
 * summing to 1 within tolerance. The weights are returned as given and are never renormalised.
 */
function checkBarycentric(barycentric: ArrayLike<unknown>): Weights {
  if (barycentric.length !== 3) refuse("bad-barycentric", `barycentric holds ${barycentric.length} values; expected 3`);
  const w: Weights = [readWeight(barycentric, 0), readWeight(barycentric, 1), readWeight(barycentric, 2)];
  const inRange = w.every((b) => b >= -BARYCENTRIC_TOLERANCE && b <= 1 + BARYCENTRIC_TOLERANCE);
  if (!inRange || Math.abs(w[0] + w[1] + w[2] - 1) > BARYCENTRIC_TOLERANCE) {
    refuse("bad-barycentric", `barycentric [${w.join(", ")}] lies outside the triangle or does not sum to 1`);
  }
  return w;
}

/** Little-endian float64 bytes. Adding 0 folds -0 into +0 so equal geometry hashes equally. */
function littleEndian(values: Float64Array): Buffer {
  const bytes = Buffer.alloc(values.length * 8);
  values.forEach((value, index) => bytes.writeDoubleLE(value + 0, index * 8));
  return bytes;
}

/**
 * Unit direction of a finite vector, or undefined for the zero vector. It scales by the largest component first, so a
 * huge vector cannot overflow its own length to infinity and come out as zero.
 */
function unitDirection(v: Vec3): Vec3 | undefined {
  const largest = Math.max(Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2]));
  if (!(largest > 0)) return undefined;
  const x = v[0] / largest;
  const y = v[1] / largest;
  const z = v[2] / largest;
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
}

export function prepareSpatialGeometry(input: SpatialGeometryInput): PreparedSpatialGeometry {
  checkRoute(input.sourceRouteProof);
  if (input.deformation !== "none") {
    refuse("deformation-unsupported", `deformation "${input.deformation}" is not supported; only "none" is`);
  }
  checkNodeTransform(input.nodeTransform);
  const scale = uniformScale(input.buildScale);
  checkOrigin(input.fixedOrigin);
  const [ox, oy, oz] = input.fixedOrigin;

  const positions = finiteCopy("positions", input.positions);
  if (positions.length === 0 || positions.length % 3 !== 0) {
    refuse("bad-length", `positions hold ${positions.length} values; expected a non-zero multiple of 3`);
  }
  const vertexCount = positions.length / 3;
  const normals = finiteCopy("normals", input.normals);
  if (normals.length !== positions.length) {
    refuse("bad-length", `normals hold ${normals.length} values; positions need ${positions.length}`);
  }
  const atlas = finiteCopy("atlas UV", input.atlasUv);
  if (atlas.length !== 2 * vertexCount) {
    refuse("bad-length", `atlas UV holds ${atlas.length} values; expected ${2 * vertexCount}`);
  }

  const originalUv = new Map<number, Float64Array>();
  for (const { set, uv } of input.originalUv) {
    if (!Number.isInteger(set) || set < 0) refuse("bad-uv-set", `UV set ${set} is not a non-negative integer`);
    if (originalUv.has(set)) refuse("bad-uv-set", `UV set ${set} is given twice`);
    const values = finiteCopy(`original UV set ${set}`, uv);
    if (values.length !== 2 * vertexCount) {
      refuse("bad-length", `UV set ${set} holds ${values.length} values; expected ${2 * vertexCount}`);
    }
    originalUv.set(set, values);
  }

  const indices = finiteCopy("indices", input.indices);
  if (indices.length === 0 || indices.length % 3 !== 0) {
    refuse("bad-length", `indices hold ${indices.length} values; expected a non-zero multiple of 3`);
  }
  for (const index of indices) {
    if (!Number.isInteger(index) || index < 0 || index >= vertexCount) {
      refuse("bad-index", `index ${index} is outside 0..${vertexCount - 1}`);
    }
  }
  const triangleCount = indices.length / 3;
  // Winding is kept exactly as given. Nothing here derives a normal from the face.
  const triangles = Uint32Array.from(indices);
  for (let t = 0; t < triangleCount; t++) {
    const a = triangles[3 * t]!;
    const b = triangles[3 * t + 1]!;
    const c = triangles[3 * t + 2]!;
    if (isDegenerate2(atlas, a, b, c)) refuse("degenerate-triangle", `triangle ${t} has no area in atlas space`);
    if (isDegenerate3(positions, a, b, c)) refuse("degenerate-triangle", `triangle ${t} has no area in UE space`);
  }

  // Untranslated UE positions with the uniform scale applied once. The fixed origin is added only when a query places a
  // point, so interpolation and derivatives never sum a large origin with a small offset (which would round it away).
  const scaledPositions = new Float64Array(3 * vertexCount);
  const ueNormals = new Float64Array(3 * vertexCount);
  for (let v = 0; v < vertexCount; v++) {
    const x = positions[3 * v]!;
    const y = positions[3 * v + 1]!;
    const z = positions[3 * v + 2]!;
    // Inverse of the UModel export (X, Z, Y) * 0.01: UE = (x, z, y) * 100, then the uniform scale once.
    const sx = scale * (CM_PER_METRE * x);
    const sy = scale * (CM_PER_METRE * z);
    const sz = scale * (CM_PER_METRE * y);
    // The placed corner must fit as well: a finite origin plus a finite offset can overflow.
    requireFinite(`UE position of vertex ${v} (scale and origin)`, sx, sy, sz, ox + sx, oy + sy, oz + sz);
    scaledPositions.set([sx, sy, sz], 3 * v);

    // The axes swap y and z. The length is unchanged, so normalising after the swap is the same.
    const direction = unitDirection([normals[3 * v]!, normals[3 * v + 2]!, normals[3 * v + 1]!]);
    if (direction === undefined) refuse("degenerate-normal", `vertex ${v} has a zero-length normal`);
    ueNormals.set(direction, 3 * v);
  }

  const hash = createHash("sha256");
  const field = (name: string, values: Float64Array): void => {
    hash.update(`${name}:${values.length}\n`);
    hash.update(littleEndian(values));
  };
  const proof = input.sourceRouteProof;
  hash.update("spatial-surface/t1\n");
  hash.update(
    `proof:${JSON.stringify([proof.tool, proof.commit, proof.container, proof.bCooked, proof.axisExport, proof.exportScale])}\n`,
  );
  hash.update("node:identity\n");
  hash.update(`deformation:${input.deformation}\n`);
  field("build-scale", Float64Array.of(scale));
  field("fixed-origin", Float64Array.of(ox, oy, oz));
  field("positions", positions);
  field("normals", normals);
  field("indices", indices);
  field("atlas", atlas);
  for (const set of [...originalUv.keys()].sort((p, q) => p - q)) field(`uv${set}`, originalUv.get(set)!);
  const fingerprint = hash.digest("hex");

  const corners = (t: number): Corners => [triangles[3 * t]!, triangles[3 * t + 1]!, triangles[3 * t + 2]!];
  const checkUvSet = (set: number): Float64Array => {
    const values = originalUv.get(set);
    if (values === undefined) refuse("missing-uv-set", `UV set ${set} is not in this mesh`);
    return values;
  };

  const prepared: PreparedSpatialGeometry = {
    trust: "untrusted-atlas",
    vertexCount,
    triangleCount,
    fingerprint,
    triangleVertices(triangle) {
      return freezeTuple(corners(checkTriangleIndex(triangle, triangleCount)));
    },
    query(triangle, barycentric, uvSets) {
      const c = corners(checkTriangleIndex(triangle, triangleCount));
      const w = checkBarycentric(barycentric);
      // Blend the untranslated positions first, then place the result at the fixed origin.
      const local = blend3(scaledPositions, w, c, "interpolated position");
      const position: Vec3 = [ox + local[0], oy + local[1], oz + local[2]];
      requireFinite("placed position", ...position);
      // Interpolate the unit normals, then normalise: the direction is what the sample returns.
      const direction = unitDirection(blend3(ueNormals, w, c, "interpolated normal"));
      if (direction === undefined) {
        refuse("degenerate-normal", "the interpolated normal vanishes here, so it has no direction");
      }
      const uv: Record<number, readonly [number, number]> = {};
      for (const set of uvSets) uv[set] = freezeTuple(blend2(checkUvSet(set), w, c, `interpolated UV set ${set}`));
      return Object.freeze({
        atlas: freezeTuple(blend2(atlas, w, c, "interpolated atlas UV")),
        position: freezeTuple(position),
        normal: freezeTuple(direction),
        uv: Object.freeze(uv),
      });
    },
    derivatives(triangle, uvSets) {
      const c = corners(checkTriangleIndex(triangle, triangleCount));
      const frame = atlasFrame(atlas, c);
      // Differences come from the untranslated scaled positions and the stored UV sets, so the fixed origin never enters.
      const gradient = (table: Float64Array, stride: 2 | 3, k: number): [number, number] => {
        const d1 = table[stride * c[1] + k]! - table[stride * c[0] + k]!;
        const d2 = table[stride * c[2] + k]! - table[stride * c[0] + k]!;
        requireFinite("difference along a triangle edge", d1, d2);
        return edgeGradient(d1, d2, frame);
      };
      const x = gradient(scaledPositions, 3, 0);
      const y = gradient(scaledPositions, 3, 1);
      const z = gradient(scaledPositions, 3, 2);
      const position: SpatialDerivatives["position"] = freezeTuple([
        freezeTuple<Vec3>([x[0], y[0], z[0]]),
        freezeTuple<Vec3>([x[1], y[1], z[1]]),
      ]);
      const uv: Record<number, readonly [readonly [number, number], readonly [number, number]]> = {};
      for (const set of uvSets) {
        const table = checkUvSet(set);
        const s = gradient(table, 2, 0);
        const t = gradient(table, 2, 1);
        uv[set] = freezeTuple([freezeTuple<[number, number]>([s[0], t[0]]), freezeTuple<[number, number]>([s[1], t[1]])]);
      }
      return Object.freeze({ position, uv: Object.freeze(uv) });
    },
  };
  return Object.freeze(prepared);
}
