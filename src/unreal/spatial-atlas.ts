import { isVerifiedCornerRemap, SpatialDigest, type NamedRefusal, type VerifiedCornerRemap } from "./spatial-remap.js";

// T2A per-triangle atlas certifier (layout only). Certifies a final atlas UV for one verified corner remap:
// pairwise disjoint closed triangles, a 4 px page border, one strict interior pixel centre per triangle, and an exact
// 4 px owner mask with no collisions. Float32 bits are decoded exactly (BigInt, units of 2^-150 px); the predicates
// are exact integer arithmetic. It never produces a ValidatedSpatialContext and admits no source route.
//
// Continuous guarantee (why the mask suffices): for any query point q in a closed triangle T, each of the four
// bilinear taps lies within Linf 1 of q, hence within Euclidean sqrt(2) < 4 of T. So every tap centre is in T's
// owned mask. With no collisions a tap has exactly one owner, and the border keeps taps on the page.

export type TriangleAtlasRefusal =
  | "unsupported-layout-parameters"
  | "unverified-remap"
  | "atlas-uv-not-float32"
  | "atlas-uv-malformed"
  | "atlas-uv-nonfinite"
  | "atlas-uv-out-of-unit-range"
  | "atlas-vertex-count-mismatch"
  | "indices-not-bound-to-remap"
  | "zero-area-triangle"
  | "border-under-4px"
  | "triangles-intersect"
  | "mask-collision"
  | "no-strict-interior-centre";

export interface CertifyTriangleAtlasInput {
  /** Final atlas UV, two float32 per vertex. Copied on entry. */
  readonly finalAtlasUv: Float32Array;
  /** Must equal the verified remap's triangle list exactly. */
  readonly indices: ArrayLike<number>;
  readonly verifiedRemap: VerifiedCornerRemap;
  readonly resolution: 2048;
  readonly filter: "linear-no-mips";
  readonly gutterRadius: 4;
}

/** Issued only by certifyTriangleAtlas. Frozen; every array it exposes is a fresh copy. */
export interface CertifiedTriangleAtlas {
  readonly kind: "certified";
  readonly fingerprint: string;
  readonly remapFingerprint: string;
  readonly resolution: 2048;
  readonly filter: "linear-no-mips";
  readonly gutterRadius: 4;
  /** The verified minimum page border, in pixels. */
  readonly borderMinPx: 4;
  readonly vertexCount: number;
  readonly triangleCount: number;
  readonly ownedPixelCount: number;
  /** Face index owning integer texel (i, j), or -1 when unowned or outside the page. Column i, row j. */
  ownerAt(i: number, j: number): number;
  /** Strict interior pixel centres of a face, or -1 for an invalid face index. */
  interiorCountOf(face: number): number;
  /** Mask pixels owned by a face, or -1 for an invalid face index. */
  ownedPixelCountOf(face: number): number;
  triangleIndices(face: number): readonly [number, number, number] | undefined;
  /** Copy of the owner map: face + 1 per texel, 0 unowned, row-major (index = j * 2048 + i). */
  exportOwnerMap(): Uint32Array;
}

export type TriangleAtlasResult = CertifiedTriangleAtlas | NamedRefusal<TriangleAtlasRefusal>;

const PAGE = 2048;
const GUTTER_PX = 4;
const FILTER = "linear-no-mips" as const;
const SCHEMA = "threenative:spatial-triangle-atlas:v1";
const CELL_PX = 64;
const CELLS_PER_AXIS = PAGE / CELL_PX;

/** Every coordinate is an exact integer multiple of 2^-150 px, which holds for any float32 UV scaled by 2048. */
const SCALE_BITS = 150n;
const UNIT = 1n << SCALE_BITS;
const GUTTER = BigInt(GUTTER_PX) * UNIT;
const PAGE_LIMIT = BigInt(PAGE - GUTTER_PX) * UNIT;
/** (4 px)^2 in units of UNIT^2, the squared mask radius. */
const RADIUS2 = 16n * UNIT * UNIT;
const CELL_SHIFT = SCALE_BITS + BigInt(Math.log2(CELL_PX));
/** Centre of pixel k along an axis: (k + 0.5) * UNIT. */
const CENTRES: readonly bigint[] = Array.from({ length: PAGE }, (_, k) => BigInt(2 * k + 1) << (SCALE_BITS - 1n));

const NONE = 0;
const MASK = 1;
const STRICT = 2;
type Coverage = typeof NONE | typeof MASK | typeof STRICT;

const issued = new WeakSet<object>();

interface Pt {
  readonly x: bigint;
  readonly y: bigint;
}

/** A triangle in canonical counter-clockwise order (for predicates); `corners` keeps the actual corner order. */
interface Tri {
  readonly face: number;
  readonly a: Pt;
  readonly b: Pt;
  readonly c: Pt;
  readonly corners: readonly [number, number, number];
}

export function certifyTriangleAtlas(input: CertifyTriangleAtlasInput): TriangleAtlasResult {
  if (input.resolution !== PAGE || input.filter !== FILTER || input.gutterRadius !== GUTTER_PX) {
    return refuse("unsupported-layout-parameters", "only resolution 2048, linear-no-mips and gutterRadius 4 are certified");
  }
  if (!isVerifiedCornerRemap(input.verifiedRemap)) {
    return refuse("unverified-remap", "indices must come from verifyCornerRemap, not a hand-built object");
  }
  const remap = input.verifiedRemap;

  if (!(input.finalAtlasUv instanceof Float32Array)) {
    return refuse("atlas-uv-not-float32", "finalAtlasUv must be a Float32Array; no silent rounding");
  }
  if (input.finalAtlasUv.length % 2 !== 0) return refuse("atlas-uv-malformed", "finalAtlasUv needs two values per vertex");
  const vertexCount = input.finalAtlasUv.length / 2;
  if (vertexCount !== remap.vertexCount) {
    return refuse("atlas-vertex-count-mismatch", `atlas holds ${vertexCount} vertices, remap ${remap.vertexCount}`);
  }
  const uv = copyFloat32(input.finalAtlasUv);
  for (let k = 0; k < uv.length; k++) {
    const value = uv[k] ?? Number.NaN;
    if (!Number.isFinite(value)) return refuse("atlas-uv-nonfinite", `UV value ${k} is not finite`);
    if (value < 0 || value > 1) return refuse("atlas-uv-out-of-unit-range", `UV value ${k} is outside [0, 1]`);
  }

  const bound = remap.indices();
  const given: unknown[] = isArrayLikeObject(input.indices) ? Array.from(input.indices) : [];
  if (given.length !== bound.length || bound.some((id, k) => given[k] !== id)) {
    return refuse("indices-not-bound-to-remap", "indices must equal the verified remapped indices exactly");
  }

  const bits = new Uint32Array(uv.buffer, uv.byteOffset, uv.length);
  const pointOf = (vertex: number): Pt => ({
    x: scaledPixel(bits[2 * vertex] ?? 0),
    y: scaledPixel(bits[2 * vertex + 1] ?? 0),
  });

  const triangles: Tri[] = [];
  for (let f = 0; f < bound.length / 3; f++) {
    const c0 = idAt(bound, 3 * f);
    const c1 = idAt(bound, 3 * f + 1);
    const c2 = idAt(bound, 3 * f + 2);
    const p0 = pointOf(c0);
    const p1 = pointOf(c1);
    const p2 = pointOf(c2);
    const area = side(p0, p1, p2);
    if (area === 0n) return refuse("zero-area-triangle", `face ${f} has zero area`);
    if (![p0, p1, p2].every(insidePage)) return refuse("border-under-4px", `face ${f} reaches within 4 px of the page edge`);
    const canonical = area > 0n ? [p0, p1, p2] : [p0, p2, p1];
    triangles.push({
      face: f,
      a: pointAt(canonical, 0),
      b: pointAt(canonical, 1),
      c: pointAt(canonical, 2),
      corners: [c0, c1, c2],
    });
  }

  const cells = broadphase(triangles);
  const tested = new Set<number>();
  for (const cell of cells) {
    for (let p = 0; p < cell.length; p++) {
      for (let q = p + 1; q < cell.length; q++) {
        const i = cell[p] ?? -1;
        const j = cell[q] ?? -1;
        const key = Math.min(i, j) * triangles.length + Math.max(i, j);
        if (tested.has(key)) continue;
        tested.add(key);
        const ti = triangles[i];
        const tj = triangles[j];
        if (ti && tj && closedTrianglesIntersect(ti, tj)) {
          return refuse("triangles-intersect", `faces ${ti.face} and ${tj.face} touch or overlap`);
        }
      }
    }
  }

  const owner = new Uint32Array(PAGE * PAGE);
  const interiorCount = new Uint32Array(triangles.length);
  const ownedCount = new Uint32Array(triangles.length);
  for (const t of triangles) {
    const minX = min3(t.a.x, t.b.x, t.c.x);
    const maxX = max3(t.a.x, t.b.x, t.c.x);
    const minY = min3(t.a.y, t.b.y, t.c.y);
    const maxY = max3(t.a.y, t.b.y, t.c.y);
    const iLo = Math.max(0, Number((minX - GUTTER) >> SCALE_BITS) - 1);
    const iHi = Math.min(PAGE - 1, Number(ceilUnits(maxX + GUTTER)) + 1);
    const jLo = Math.max(0, Number((minY - GUTTER) >> SCALE_BITS) - 1);
    const jHi = Math.min(PAGE - 1, Number(ceilUnits(maxY + GUTTER)) + 1);

    let interior = 0;
    let owned = 0;
    for (let j = jLo; j <= jHi; j++) {
      const py = CENTRES[j] ?? 0n;
      for (let i = iLo; i <= iHi; i++) {
        const coverage = coverageAt(t, CENTRES[i] ?? 0n, py);
        if (coverage === NONE) continue;
        const index = j * PAGE + i;
        const holder = owner[index] ?? 0;
        if (holder !== 0) {
          return refuse("mask-collision", `texel (${i}, ${j}) lies within 4 px of faces ${holder - 1} and ${t.face}`);
        }
        owner[index] = t.face + 1;
        owned++;
        if (coverage === STRICT) interior++;
      }
    }
    if (interior === 0) return refuse("no-strict-interior-centre", `face ${t.face} has no strict interior pixel centre`);
    interiorCount[t.face] = interior;
    ownedCount[t.face] = owned;
  }

  let ownedPixelCount = 0;
  for (const count of ownedCount) ownedPixelCount += count;

  const digest = new SpatialDigest(SCHEMA);
  digest.text("resolution", String(PAGE));
  digest.text("filter", FILTER);
  digest.text("gutterRadius", String(GUTTER_PX));
  digest.text("remapFingerprint", remap.fingerprint);
  digest.text("vertexCount", String(vertexCount));
  digest.bytes("finalAtlasUv", bytesOf(uv));
  digest.bytes("indices", bytesOf(bound));
  digest.bytes("ownerMap", bytesOf(owner));

  const certified: CertifiedTriangleAtlas = Object.freeze({
    kind: "certified" as const,
    fingerprint: digest.hex(),
    remapFingerprint: remap.fingerprint,
    resolution: PAGE as 2048,
    filter: FILTER,
    gutterRadius: GUTTER_PX as 4,
    borderMinPx: GUTTER_PX as 4,
    vertexCount,
    triangleCount: triangles.length,
    ownedPixelCount,
    ownerAt: (i: number, j: number) => {
      if (!Number.isInteger(i) || !Number.isInteger(j) || i < 0 || j < 0 || i >= PAGE || j >= PAGE) return -1;
      return (owner[j * PAGE + i] ?? 0) - 1;
    },
    interiorCountOf: (face: number) => (validFace(face, triangles.length) ? (interiorCount[face] ?? -1) : -1),
    ownedPixelCountOf: (face: number) => (validFace(face, triangles.length) ? (ownedCount[face] ?? -1) : -1),
    triangleIndices: (face: number) => {
      const t = validFace(face, triangles.length) ? triangles[face] : undefined;
      return t ? ([t.corners[0], t.corners[1], t.corners[2]] as const) : undefined;
    },
    exportOwnerMap: () => Uint32Array.from(owner),
  });
  issued.add(certified);
  return certified;
}

export function isCertifiedTriangleAtlas(value: unknown): value is CertifiedTriangleAtlas {
  return typeof value === "object" && value !== null && issued.has(value);
}

function refuse<Name extends TriangleAtlasRefusal>(name: Name, detail: string): NamedRefusal<Name> {
  return { kind: "refused", name, detail };
}

function validFace(face: number, count: number): boolean {
  return Number.isInteger(face) && face >= 0 && face < count;
}

function copyFloat32(source: Float32Array): Float32Array {
  const bytes = new Uint8Array(source.byteLength);
  bytes.set(bytesOf(source));
  return new Float32Array(bytes.buffer);
}

function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function isArrayLikeObject(value: unknown): value is ArrayLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Number.isSafeInteger((value as { length?: unknown }).length) &&
    (value as { length: number }).length >= 0
  );
}

function idAt(values: ArrayLike<number>, index: number): number {
  return values[index] ?? -1;
}

function pointAt(points: readonly Pt[], index: number): Pt {
  return points[index] ?? { x: 0n, y: 0n };
}

function min3(a: bigint, b: bigint, c: bigint): bigint {
  return a < b ? (a < c ? a : c) : b < c ? b : c;
}

function max3(a: bigint, b: bigint, c: bigint): bigint {
  return a > b ? (a > c ? a : c) : b > c ? b : c;
}

function ceilUnits(value: bigint): bigint {
  return -((-value) >> SCALE_BITS);
}

function insidePage(p: Pt): boolean {
  return p.x >= GUTTER && p.x <= PAGE_LIMIT && p.y >= GUTTER && p.y <= PAGE_LIMIT;
}

/**
 * Exact value of a float32 in [0, 1] (given as its IEEE bits), times 2048 * 2^150. For a non-zero magnitude
 * m * 2^e the result is m * 2^(e + 161), with e + 161 in [12, 138]; zero of either sign is 0.
 */
function scaledPixel(bits: number): bigint {
  const exponentBits = (bits >>> 23) & 0xff;
  const fraction = bits & 0x7fffff;
  if (exponentBits === 0 && fraction === 0) return 0n;
  const mantissa = exponentBits === 0 ? fraction : fraction | 0x800000;
  const exponent = exponentBits === 0 ? -149 : exponentBits - 150;
  return BigInt(mantissa) << BigInt(exponent + 161);
}

/** Twice the signed area of (a, b, c) in units of UNIT^2: positive for counter-clockwise. */
function side(a: Pt, b: Pt, c: Pt): bigint {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function broadphase(triangles: readonly Tri[]): number[][] {
  const cells: number[][] = Array.from({ length: CELLS_PER_AXIS * CELLS_PER_AXIS }, () => []);
  triangles.forEach((t, index) => {
    // Closed ranges on both ends: two closed AABBs that meet share a cell, including exactly on a cell boundary.
    const x0 = Number(min3(t.a.x, t.b.x, t.c.x) >> CELL_SHIFT);
    const x1 = Number(max3(t.a.x, t.b.x, t.c.x) >> CELL_SHIFT);
    const y0 = Number(min3(t.a.y, t.b.y, t.c.y) >> CELL_SHIFT);
    const y1 = Number(max3(t.a.y, t.b.y, t.c.y) >> CELL_SHIFT);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) cells[cy * CELLS_PER_AXIS + cx]?.push(index);
    }
  });
  return cells;
}

/** Closed triangles intersect (touch or overlap) unless some edge normal strictly separates their projections. */
function closedTrianglesIntersect(p: Tri, q: Tri): boolean {
  return !separatedByEdgeNormal(p, q) && !separatedByEdgeNormal(q, p);
}

function separatedByEdgeNormal(p: Tri, q: Tri): boolean {
  const edges: Array<[Pt, Pt]> = [
    [p.a, p.b],
    [p.b, p.c],
    [p.c, p.a],
  ];
  for (const [from, to] of edges) {
    const nx = -(to.y - from.y);
    const ny = to.x - from.x;
    const [pMin, pMax] = projectionRange(p, nx, ny);
    const [qMin, qMax] = projectionRange(q, nx, ny);
    if (pMax < qMin || qMax < pMin) return true;
  }
  return false;
}

function projectionRange(t: Tri, nx: bigint, ny: bigint): [bigint, bigint] {
  const values = [t.a, t.b, t.c].map((v) => nx * v.x + ny * v.y);
  return [min3(values[0] ?? 0n, values[1] ?? 0n, values[2] ?? 0n), max3(values[0] ?? 0n, values[1] ?? 0n, values[2] ?? 0n)];
}

/** Exact pixel-centre class: strictly inside (STRICT), inside or within 4 px of the closed triangle (MASK), or NONE. */
function coverageAt(t: Tri, px: bigint, py: bigint): Coverage {
  const s0 = side(t.a, t.b, { x: px, y: py });
  const s1 = side(t.b, t.c, { x: px, y: py });
  const s2 = side(t.c, t.a, { x: px, y: py });
  if (s0 > 0n && s1 > 0n && s2 > 0n) return STRICT;
  if (s0 >= 0n && s1 >= 0n && s2 >= 0n) return MASK;
  const near =
    edgeWithin(t.a, t.b, px, py, s0) || edgeWithin(t.b, t.c, px, py, s1) || edgeWithin(t.c, t.a, px, py, s2);
  return near ? MASK : NONE;
}

/**
 * Squared distance from (px, py) to the closed segment a-b is <= 16 px^2, decided exactly. `cross` is side(a, b, p),
 * which equals the edge vector crossed with (p - a); the projection case uses cross^2 / |b - a|^2 <= 16 without division.
 */
function edgeWithin(a: Pt, b: Pt, px: bigint, py: bigint, cross: bigint): boolean {
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const wx = px - a.x;
  const wy = py - a.y;
  const dot = ex * wx + ey * wy;
  if (dot <= 0n) return wx * wx + wy * wy <= RADIUS2;
  const len2 = ex * ex + ey * ey;
  if (dot >= len2) {
    const qx = px - b.x;
    const qy = py - b.y;
    return qx * qx + qy * qy <= RADIUS2;
  }
  return cross * cross <= RADIUS2 * len2;
}
