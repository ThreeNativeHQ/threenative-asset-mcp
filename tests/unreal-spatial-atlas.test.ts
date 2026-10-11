import { describe, expect, it } from "vitest";

import {
  verifyCornerRemap,
  type SpatialAttributeSnapshot,
  type SpatialMeshSnapshot,
  type VerifiedCornerRemap,
} from "../src/unreal/spatial-remap.js";
import {
  certifyTriangleAtlas,
  isCertifiedTriangleAtlas,
  type CertifiedTriangleAtlas,
  type CertifyTriangleAtlasInput,
  type TriangleAtlasRefusal,
  type TriangleAtlasResult,
} from "../src/unreal/spatial-atlas.js";

// Synthetic, hand-written geometry only, in page pixels of a 2048 page. Coordinates are multiples of 1/64, so every
// float32 UV (pixel / 2048) is exact: the tests exercise the exact predicates, not float rounding. Pixel (i, j) has
// centre (i + 0.5, j + 0.5); ownerAt(i, j) takes the column first.

const PAGE = 2048;
type Point = readonly [number, number];
type Triangle = readonly [Point, Point, Point];
type Overrides = Partial<Record<keyof CertifyTriangleAtlasInput, unknown>>;

const ASYMMETRIC: readonly Triangle[] = [
  [[100, 100], [160, 110], [120, 170]],
  [[400, 300], [500, 320], [410, 420]],
  [[900, 1200], [1010, 1150], [960, 1330]],
];

/** Remap over `faces` triangles with fresh corners: identity correspondence, POSITION only, optional overlapping TEXCOORD_0. */
function identityRemap(faces: number, overlappingUv = false): VerifiedCornerRemap {
  const attributes = new Map<string, SpatialAttributeSnapshot>([
    ["POSITION", { componentType: "float32", itemSize: 3, normalized: false, data: new Float32Array(faces * 9) }],
  ]);
  if (overlappingUv) {
    attributes.set("TEXCOORD_0", {
      componentType: "float32",
      itemSize: 2,
      normalized: false,
      data: new Float32Array(faces * 6).fill(0.5),
    });
  }
  const corners = Array.from({ length: faces * 3 }, (_, n) => n);
  const snapshot: SpatialMeshSnapshot = { vertexCount: faces * 3, attributes, indices: corners };
  const result = verifyCornerRemap(snapshot, snapshot, Array.from({ length: faces }, (_, f) => f), corners);
  if (result.kind !== "verified") throw new Error(`fixture remap refused: ${result.name}: ${result.detail}`);
  return result;
}

function uvOf(triangles: readonly Triangle[]): Float32Array {
  const uv = new Float32Array(triangles.length * 6);
  triangles.forEach((triangle, f) =>
    triangle.forEach(([x, y], k) => {
      uv[(f * 3 + k) * 2] = x / PAGE;
      uv[(f * 3 + k) * 2 + 1] = y / PAGE;
    }),
  );
  return uv;
}

function certify(triangles: readonly Triangle[], overrides: Overrides = {}): TriangleAtlasResult {
  const input = {
    finalAtlasUv: uvOf(triangles),
    indices: Array.from({ length: triangles.length * 3 }, (_, n) => n),
    verifiedRemap: identityRemap(triangles.length),
    resolution: 2048,
    filter: "linear-no-mips",
    gutterRadius: 4,
    ...overrides,
  };
  // Test-only cast of the raw input; the certificate itself is only ever issued by certifyTriangleAtlas.
  return certifyTriangleAtlas(input as unknown as CertifyTriangleAtlasInput);
}

function certifiedOrThrow(result: TriangleAtlasResult): CertifiedTriangleAtlas {
  if (result.kind !== "certified") throw new Error(`expected certified, got ${result.name}: ${result.detail}`);
  return result;
}

function refusalOf(result: TriangleAtlasResult): TriangleAtlasRefusal | "certified" {
  return result.kind === "refused" ? result.name : "certified";
}

function gridTriangles(count: number): Triangle[] {
  return Array.from({ length: count }, (_, n) => {
    const x = 20 + (n % 100) * 20;
    const y = 20 + Math.floor(n / 100) * 20;
    return [
      [x, y],
      [x + 10, y],
      [x, y + 10],
    ] as const;
  });
}

function segmentDistanceSquared(p: Point, q: Point, px: number, py: number): number {
  const ex = q[0] - p[0];
  const ey = q[1] - p[1];
  const t = Math.min(1, Math.max(0, ((px - p[0]) * ex + (py - p[1]) * ey) / (ex * ex + ey * ey)));
  const dx = p[0] + t * ex - px;
  const dy = p[1] + t * ey - py;
  return dx * dx + dy * dy;
}

function withinMask(triangle: Triangle, px: number, py: number): boolean {
  const [a, b, c] = triangle;
  const sign = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) < 0 ? -1 : 1;
  const edges: Array<[Point, Point]> = [
    [a, b],
    [b, c],
    [c, a],
  ];
  const inside = edges.every(([p, q]) => sign * ((q[0] - p[0]) * (py - p[1]) - (q[1] - p[1]) * (px - p[0])) >= 0);
  return inside || edges.some(([p, q]) => segmentDistanceSquared(p, q, px, py) <= 16);
}

/** Independent double-precision owner map: closed-triangle distance <= 4, clamped projection, no shared SAT or grid. */
function oracleOwners(triangles: readonly Triangle[]): Int32Array {
  const owner = new Int32Array(PAGE * PAGE).fill(-1);
  triangles.forEach((triangle, f) => {
    const xs = triangle.map(([x]) => x);
    const ys = triangle.map(([, y]) => y);
    const i0 = Math.max(0, Math.floor(Math.min(...xs) - 4.5));
    const i1 = Math.min(PAGE - 1, Math.ceil(Math.max(...xs) + 4.5));
    const j0 = Math.max(0, Math.floor(Math.min(...ys) - 4.5));
    const j1 = Math.min(PAGE - 1, Math.ceil(Math.max(...ys) + 4.5));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if (!withinMask(triangle, i + 0.5, j + 0.5)) continue;
        if (owner[j * PAGE + i] !== -1) throw new Error(`oracle collision at (${i}, ${j})`);
        owner[j * PAGE + i] = f;
      }
    }
  });
  return owner;
}

describe("certifyTriangleAtlas: accepted layouts", () => {
  it("certifies disjoint asymmetric triangles with exact interior, border and owner-mask facts", () => {
    const result = certifiedOrThrow(certify(ASYMMETRIC));

    expect(result.kind).toBe("certified");
    expect(result.resolution).toBe(2048);
    expect(result.filter).toBe("linear-no-mips");
    expect(result.gutterRadius).toBe(4);
    expect(result.borderMinPx).toBe(4);
    expect(result.triangleCount).toBe(3);
    expect(result.vertexCount).toBe(9);
    expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.remapFingerprint).toMatch(/^[0-9a-f]{64}$/);
    for (let f = 0; f < 3; f++) {
      expect(result.interiorCountOf(f)).toBeGreaterThanOrEqual(1);
      expect(result.ownedPixelCountOf(f)).toBeGreaterThan(result.interiorCountOf(f));
    }
    expect(result.ownerAt(120, 120)).toBe(0);
    expect(result.ownerAt(450, 350)).toBe(1);
    expect(result.ownerAt(0, 0)).toBe(-1);
    expect(result.ownerAt(PAGE, 0)).toBe(-1);
    expect(result.ownerAt(-1, 5)).toBe(-1);
    expect(result.triangleIndices(1)).toEqual([3, 4, 5]);
    expect(result.triangleIndices(3)).toBeUndefined();
    expect(result.interiorCountOf(7)).toBe(-1);
    expect(isCertifiedTriangleAtlas(result)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(() => Object.assign(result, { kind: "tampered" })).toThrow();
  });

  it("ownerAt agrees with an independent floating-point oracle on every texel of the page", () => {
    const result = certifiedOrThrow(certify(ASYMMETRIC));
    const expected = oracleOwners(ASYMMETRIC);
    let mismatches = 0;
    for (let j = 0; j < PAGE; j++) {
      for (let i = 0; i < PAGE; i++) {
        if (result.ownerAt(i, j) !== expected[j * PAGE + i]) mismatches++;
      }
    }
    expect(mismatches).toBe(0);
  });

  it("certifies a clockwise triangle: winding is canonicalised for the predicates only", () => {
    const clockwise: readonly Triangle[] = [[[100, 100], [100, 160], [160, 110]]];
    const result = certifiedOrThrow(certify(clockwise));
    expect(result.ownerAt(120, 120)).toBe(0);
    expect(result.triangleIndices(0)).toEqual([0, 1, 2]);
  });

  it("accepts overlapping original TEXCOORD_0 when the final atlas is valid", () => {
    const result = certifiedOrThrow(certify(ASYMMETRIC, { verifiedRemap: identityRemap(3, true) }));
    expect(result.triangleCount).toBe(3);
  });

  it("has no arbitrary triangle-count cutoff", () => {
    const result = certifiedOrThrow(certify(gridTriangles(200)));
    expect(result.triangleCount).toBe(200);
    const interiorCounts = Array.from({ length: 200 }, (_, f) => result.interiorCountOf(f));
    expect(interiorCounts.every((count) => count >= 1)).toBe(true);
  });

  it("accepts a triangle that holds a strict interior centre just inside its hypotenuse", () => {
    const justInside: readonly Triangle[] = [
      [
        [10.5, 10.5],
        [12.5625, 10.5],
        [10.5, 12.5625],
      ],
    ];
    expect(certifiedOrThrow(certify(justInside)).interiorCountOf(0)).toBeGreaterThanOrEqual(1);
  });
});

describe("certifyTriangleAtlas: contacts and overlaps", () => {
  it("refuses a sub-pixel overlap that contains no pixel centre", () => {
    const sliver: readonly Triangle[] = [
      [
        [100, 100],
        [120, 100],
        [100, 120],
      ],
      [
        [119.875, 100.0625],
        [130, 90],
        [130, 100],
      ],
    ];
    expect(refusalOf(certify(sliver))).toBe("triangles-intersect");
  });

  it("refuses containment", () => {
    const nested: readonly Triangle[] = [
      [
        [100, 100],
        [300, 100],
        [100, 300],
      ],
      [
        [120, 120],
        [140, 120],
        [120, 140],
      ],
    ];
    expect(refusalOf(certify(nested))).toBe("triangles-intersect");
  });

  it("refuses a point contact", () => {
    const touching: readonly Triangle[] = [
      [
        [100, 100],
        [200, 100],
        [100, 200],
      ],
      [
        [200, 100],
        [300, 100],
        [250, 50],
      ],
    ];
    expect(refusalOf(certify(touching))).toBe("triangles-intersect");
  });

  it("refuses an edge contact", () => {
    const shared: readonly Triangle[] = [
      [
        [100, 100],
        [200, 100],
        [100, 200],
      ],
      [
        [200, 100],
        [100, 200],
        [200, 200],
      ],
    ];
    expect(refusalOf(certify(shared))).toBe("triangles-intersect");
  });

  it("refuses an identical triangle", () => {
    const twin: readonly Triangle[] = [
      [
        [100, 100],
        [200, 100],
        [100, 200],
      ],
      [
        [100, 100],
        [200, 100],
        [100, 200],
      ],
    ];
    expect(refusalOf(certify(twin))).toBe("triangles-intersect");
  });

  it("refuses a zero-area triangle", () => {
    const flat: readonly Triangle[] = [
      [
        [100, 100],
        [150, 100],
        [200, 100],
      ],
    ];
    expect(refusalOf(certify(flat))).toBe("zero-area-triangle");
  });

  it("finds a contact on a 64 px broadphase bin boundary", () => {
    const touching: readonly Triangle[] = [
      [
        [100, 100],
        [128, 100],
        [100, 128],
      ],
      [
        [128, 100],
        [150, 110],
        [128, 130],
      ],
    ];
    expect(refusalOf(certify(touching))).toBe("triangles-intersect");
  });

  it("does not report a 1/64 px gap across that bin boundary as a contact", () => {
    const gapped: readonly Triangle[] = [
      [
        [100, 100],
        [128, 100],
        [100, 128],
      ],
      [
        [128.015625, 100],
        [150, 110],
        [128.015625, 130],
      ],
    ];
    expect(refusalOf(certify(gapped))).toBe("mask-collision");
  });
});

describe("certifyTriangleAtlas: border, interior and sliver", () => {
  it("refuses a triangle closer than 4 px to the left page edge", () => {
    const tight: readonly Triangle[] = [
      [
        [3.9375, 100],
        [50, 100],
        [20, 150],
      ],
    ];
    expect(refusalOf(certify(tight))).toBe("border-under-4px");
  });

  it("accepts triangles exactly 4 px from the left, right and bottom page edges", () => {
    const left: readonly Triangle[] = [
      [
        [4, 100],
        [50, 100],
        [20, 150],
      ],
    ];
    const right: readonly Triangle[] = [
      [
        [2044, 100],
        [2000, 100],
        [2000, 150],
      ],
    ];
    const bottom: readonly Triangle[] = [
      [
        [100, 2044],
        [150, 2044],
        [120, 2000],
      ],
    ];
    certifiedOrThrow(certify(left));
    certifiedOrThrow(certify(right));
    certifiedOrThrow(certify(bottom));
  });

  it("refuses a triangle that reaches 1/64 px past the 2044 px limit", () => {
    const past: readonly Triangle[] = [
      [
        [2044.0625, 100],
        [2000, 100],
        [2000, 150],
      ],
    ];
    expect(refusalOf(certify(past))).toBe("border-under-4px");
  });

  it("refuses an uncovered sliver with no strict interior pixel centre", () => {
    const sliver: readonly Triangle[] = [
      [
        [100, 100],
        [300, 100],
        [300, 100.25],
      ],
    ];
    expect(refusalOf(certify(sliver))).toBe("no-strict-interior-centre");
  });

  it("refuses a triangle whose only candidate centre lies exactly on its hypotenuse", () => {
    const onEdge: readonly Triangle[] = [
      [
        [10.5, 10.5],
        [12.5, 10.5],
        [10.5, 12.5],
      ],
    ];
    expect(refusalOf(certify(onEdge))).toBe("no-strict-interior-centre");
  });
});

describe("certifyTriangleAtlas: 4 px owner mask", () => {
  it("refuses disjoint triangles whose 4 px masks share a pixel centre", () => {
    const close: readonly Triangle[] = [
      [
        [100, 100],
        [120, 100],
        [100, 120],
      ],
      [
        [127, 100],
        [147, 100],
        [127, 120],
      ],
    ];
    expect(refusalOf(certify(close))).toBe("mask-collision");
  });

  it("counts a pixel centre at distance exactly 4 from both triangles as a collision", () => {
    const exact: readonly Triangle[] = [
      [
        [100, 100],
        [120.5, 100],
        [120.5, 120],
      ],
      [
        [128.5, 100],
        [148.5, 100],
        [128.5, 120],
      ],
    ];
    expect(refusalOf(certify(exact))).toBe("mask-collision");
  });

  it("accepts the same pair once the gap is 1/64 px wider than 8", () => {
    const wider: readonly Triangle[] = [
      [
        [100, 100],
        [120.5, 100],
        [120.5, 120],
      ],
      [
        [128.515625, 100],
        [148.5, 100],
        [128.515625, 120],
      ],
    ];
    const result = certifiedOrThrow(certify(wider));
    expect(result.ownedPixelCount).toBe(result.ownedPixelCountOf(0) + result.ownedPixelCountOf(1));
    // Texel 124 sits exactly 4 px from the first triangle and 4.0156 px from the second; texel 125 is 3.0156 px from the
    // second, so the second triangle owns it. Texel (100, 50) is 49.5 px from both: unowned.
    expect(result.ownerAt(124, 105)).toBe(0);
    expect(result.ownerAt(125, 105)).toBe(1);
    expect(result.ownerAt(100, 50)).toBe(-1);
  });
});

describe("certifyTriangleAtlas: inputs", () => {
  it.each<[string, Overrides]>([
    ["resolution", { resolution: 1024 }],
    ["filter", { filter: "nearest" }],
    ["gutterRadius", { gutterRadius: 3 }],
  ])("refuses unsupported layout parameters (%s)", (_name, override) => {
    expect(refusalOf(certify(ASYMMETRIC, override))).toBe("unsupported-layout-parameters");
  });

  it("refuses a hand-built object of the same shape as a verified remap", () => {
    const real = identityRemap(3);
    expect(refusalOf(certify(ASYMMETRIC, { verifiedRemap: { ...real } }))).toBe("unverified-remap");
  });

  it("refuses a Float64Array rather than rounding it to float32", () => {
    const uv = Float64Array.from(uvOf(ASYMMETRIC));
    expect(refusalOf(certify(ASYMMETRIC, { finalAtlasUv: uv }))).toBe("atlas-uv-not-float32");
  });

  it("refuses an odd UV length", () => {
    expect(refusalOf(certify(ASYMMETRIC, { finalAtlasUv: new Float32Array(17) }))).toBe("atlas-uv-malformed");
  });

  it("refuses a non-finite UV value", () => {
    const uv = uvOf(ASYMMETRIC);
    uv[4] = Number.NaN;
    expect(refusalOf(certify(ASYMMETRIC, { finalAtlasUv: uv }))).toBe("atlas-uv-nonfinite");
  });

  it.each<[string, number]>([
    ["above 1", 1 + 2 ** -23],
    ["below 0", -(2 ** -20)],
  ])("refuses a UV value outside [0, 1] (%s)", (_label, value) => {
    const uv = uvOf(ASYMMETRIC);
    uv[0] = value;
    expect(refusalOf(certify(ASYMMETRIC, { finalAtlasUv: uv }))).toBe("atlas-uv-out-of-unit-range");
  });

  it("refuses a vertex count that differs from the verified remap", () => {
    expect(refusalOf(certify(ASYMMETRIC, { verifiedRemap: identityRemap(2) }))).toBe("atlas-vertex-count-mismatch");
  });

  it("binds indices exactly to the verified remap", () => {
    expect(refusalOf(certify(ASYMMETRIC, { indices: [3, 4, 5, 0, 1, 2, 6, 7, 8] }))).toBe("indices-not-bound-to-remap");
    expect(refusalOf(certify(ASYMMETRIC, { indices: [0, 1, 2, 3, 4, 5, 6, 7, 8.5] }))).toBe("indices-not-bound-to-remap");
  });
});

describe("certifyTriangleAtlas: provenance", () => {
  it("keeps private copies: mutating the caller's UV or a returned map changes nothing", () => {
    const uv = uvOf(ASYMMETRIC);
    const result = certifiedOrThrow(certify(ASYMMETRIC, { finalAtlasUv: uv }));
    const fingerprint = result.fingerprint;

    uv.fill(0);
    result.exportOwnerMap().fill(0);

    expect(result.ownerAt(120, 120)).toBe(0);
    expect(result.exportOwnerMap()[120 * PAGE + 120]).toBe(1);
    expect(result.fingerprint).toBe(fingerprint);
    expect(result.exportOwnerMap()).not.toBe(result.exportOwnerMap());
  });

  it("fingerprints every input: equal inputs agree, a moved vertex or another remap does not", () => {
    const base = certifiedOrThrow(certify(ASYMMETRIC)).fingerprint;
    expect(certifiedOrThrow(certify(ASYMMETRIC)).fingerprint).toBe(base);

    const moved: Triangle[] = [
      [
        [100.015625, 100],
        [160, 110],
        [120, 170],
      ],
      ...ASYMMETRIC.slice(1),
    ];
    expect(certifiedOrThrow(certify(moved)).fingerprint).not.toBe(base);

    const otherRemap = certifiedOrThrow(certify(ASYMMETRIC, { verifiedRemap: identityRemap(3, true) }));
    expect(otherRemap.fingerprint).not.toBe(base);
    expect(otherRemap.remapFingerprint).not.toBe(certifiedOrThrow(certify(ASYMMETRIC)).remapFingerprint);
  });

  it("does not recognise a hand-built certificate of the same shape", () => {
    const result = certifiedOrThrow(certify(ASYMMETRIC));
    expect(isCertifiedTriangleAtlas(result)).toBe(true);
    expect(isCertifiedTriangleAtlas({ ...result })).toBe(false);
    expect(isCertifiedTriangleAtlas(Object.create(result))).toBe(false);
  });
});
