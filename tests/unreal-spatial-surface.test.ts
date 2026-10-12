import { describe, expect, it } from "vitest";

import {
  prepareSpatialGeometry,
  SpatialSurfaceRefusal,
  type BuildScaleInput,
  type PreparedSpatialGeometry,
  type SourceRouteProof,
  type SpatialGeometryInput,
  type SpatialRefusalCode,
} from "../src/unreal/spatial-surface.js";

// Synthetic, hand-written data only. glTF metres map to UE centimetres as UE = (x, z, y) * 100.
// Pre-scale corners:
//   v0 glTF (0.1, 0.2, 0.3) = UE (10, 30, 20)
//   v1 glTF (0.4, 0.0, 0.5) = UE (40, 50, 0)
//   v2 glTF (0.0, 0.7, 0.2) = UE (0, 20, 70)
// Declared normals (glTF): (1,0,0), (0,0,1), (0,1,0). Atlas and original UVs are asymmetric and differ from each other.

const PINNED_UMODEL = "a0bfb468d42be831b126632fd8a0ae6b3614f981";
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const PROOF: SourceRouteProof = {
  tool: "umodel",
  commit: PINNED_UMODEL,
  container: "SourceModels",
  bCooked: 0,
  axisExport: "XZY",
  exportScale: 0.01,
};

/** A valid input. Each test overrides only what it is about. */
function fixture(overrides: Partial<SpatialGeometryInput> = {}): SpatialGeometryInput {
  return {
    positions: [0.1, 0.2, 0.3, 0.4, 0, 0.5, 0, 0.7, 0.2],
    normals: [1, 0, 0, 0, 0, 1, 0, 1, 0],
    originalUv: [
      { set: 0, uv: [0.2, 0.1, 0.8, 0.3, 0.5, 0.9] },
      { set: 1, uv: [0, 0, 1, 0, 0, 1] },
      { set: 2, uv: [0.25, 0.75, 0.5, 0.25, 0.125, 0.5] },
    ],
    atlasUv: [0.1, 0.2, 0.7, 0.1, 0.3, 0.6],
    indices: [0, 1, 2],
    sourceRouteProof: PROOF,
    buildScale: { known: true, xyz: [1, 1, 1] },
    nodeTransform: IDENTITY,
    fixedOrigin: [0, 0, 0],
    deformation: "none",
    ...overrides,
  };
}

/** Code of the refusal `run` throws, or "no-refusal" when it returns. Any other error propagates. */
function refusalOf(run: () => unknown): SpatialRefusalCode | "no-refusal" {
  try {
    run();
  } catch (error) {
    if (error instanceof SpatialSurfaceRefusal) return error.code;
    throw error;
  }
  return "no-refusal";
}

/** Calls query as an untyped JavaScript caller would, so a barycentric the type forbids reaches the runtime check. */
function queryUntyped(
  geometry: PreparedSpatialGeometry,
  triangle: number,
  barycentric: unknown,
  uvSets: readonly number[],
): unknown {
  return Reflect.apply(geometry.query, geometry, [triangle, barycentric, uvSets]);
}

function expectClose(actual: readonly number[], expected: readonly number[], digits = 9): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((value, index) => expect(actual[index]).toBeCloseTo(value, digits));
}

const BAD_SCALES: Array<[string, BuildScaleInput, SpatialRefusalCode]> = [
  ["nonuniform", { known: true, xyz: [2, 3, 4] }, "nonuniform-scale"],
  ["negative", { known: true, xyz: [-2, -2, -2] }, "non-positive-scale"],
  ["zero", { known: true, xyz: [0, 0, 0] }, "non-positive-scale"],
  ["nonfinite", { known: true, xyz: [Number.NaN, Number.NaN, Number.NaN] }, "nonfinite"],
  ["unknown", { known: false }, "unknown-scale"],
];

const REFUSED_INPUTS: Array<[string, SpatialGeometryInput, SpatialRefusalCode]> = [
  [
    "reflected node transform",
    fixture({ nodeTransform: [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }),
    "reflected-transform",
  ],
  [
    "translated node transform",
    fixture({ nodeTransform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1] }),
    "non-identity-transform",
  ],
  ["cooked source", fixture({ sourceRouteProof: { ...PROOF, bCooked: 1 } }), "cooked"],
  ["unpinned UModel commit", fixture({ sourceRouteProof: { ...PROOF, commit: "0".repeat(40) } }), "unproved-route"],
  ["export scale other than 0.01", fixture({ sourceRouteProof: { ...PROOF, exportScale: 1 } }), "unproved-route"],
  ["skinned deformation", fixture({ deformation: "skinned" }), "deformation-unsupported"],
  ["NaN position", fixture({ positions: [0.1, Number.NaN, 0.3, 0.4, 0, 0.5, 0, 0.7, 0.2] }), "nonfinite"],
  ["NaN fixed origin", fixture({ fixedOrigin: [0, Number.NaN, 0] }), "nonfinite"],
  ["short positions", fixture({ positions: [0.1, 0.2, 0.3, 0.4] }), "bad-length"],
  ["short normals", fixture({ normals: [1, 0, 0] }), "bad-length"],
  ["short atlas UV", fixture({ atlasUv: [0.1, 0.2] }), "bad-length"],
  ["short original UV", fixture({ originalUv: [{ set: 0, uv: [0.2, 0.1] }] }), "bad-length"],
  ["index count not a multiple of three", fixture({ indices: [0, 1] }), "bad-length"],
  ["index past the last vertex", fixture({ indices: [0, 1, 3] }), "bad-index"],
  ["fractional index", fixture({ indices: [0, 1, 1.5] }), "bad-index"],
  [
    "duplicate UV set",
    fixture({
      originalUv: [
        { set: 0, uv: [0.2, 0.1, 0.8, 0.3, 0.5, 0.9] },
        { set: 0, uv: [0, 0, 1, 0, 0, 1] },
      ],
    }),
    "bad-uv-set",
  ],
  [
    "node transform whose determinant overflows",
    fixture({ nodeTransform: [1e200, 0, 0, 0, 0, 1e200, 0, 0, 0, 0, 1e200, 0, 0, 0, 0, 1] }),
    "nonfinite",
  ],
];

const BAD_BARYCENTRICS: Array<[string, [number, number, number]]> = [
  ["sum above one", [0.5, 0.5, 0.5]],
  ["sum below one", [0.2, 0.2, 0.2]],
  ["negative weight", [1.2, -0.2, 0]],
  ["NaN weight", [Number.NaN, 0.5, 0.5]],
];

// Shapes the type forbids, which a JavaScript caller can still pass. Each is refused before any weight is used.
const sparseWeights = new Array<number>(3);
sparseWeights[0] = 0.5;
sparseWeights[2] = 0.5;
const BAD_BARYCENTRIC_SHAPES: Array<[string, unknown]> = [
  ["two entries", [0.5, 0.5]],
  ["four entries", [0.5, 0.5, 0, 0.5]],
  ["a hole at index 1", sparseWeights],
  ["no indexed entries", { length: 3 }],
  ["a string entry", ["0.5", 0.25, 0.25]],
];

const FINGERPRINT_VARIANTS: Array<[string, SpatialGeometryInput]> = [
  ["a position", fixture({ positions: [0.1, 0.2, 0.3001, 0.4, 0, 0.5, 0, 0.7, 0.2] })],
  ["a normal", fixture({ normals: [1, 0, 0, 0, 0, 1, 0, 1, 0.5] })],
  [
    "original UV set 0",
    fixture({
      originalUv: [
        { set: 0, uv: [0.2, 0.1, 0.8, 0.3, 0.5, 0.91] },
        { set: 1, uv: [0, 0, 1, 0, 0, 1] },
        { set: 2, uv: [0.25, 0.75, 0.5, 0.25, 0.125, 0.5] },
      ],
    }),
  ],
  [
    "original UV set 2",
    fixture({
      originalUv: [
        { set: 0, uv: [0.2, 0.1, 0.8, 0.3, 0.5, 0.9] },
        { set: 1, uv: [0, 0, 1, 0, 0, 1] },
        { set: 2, uv: [0.25, 0.75, 0.5, 0.25, 0.125, 0.51] },
      ],
    }),
  ],
  ["the atlas", fixture({ atlasUv: [0.1, 0.2, 0.7, 0.1, 0.3, 0.61] })],
  ["the index winding", fixture({ indices: [0, 2, 1] })],
  ["the BuildScale", fixture({ buildScale: { known: true, xyz: [2, 2, 2] } })],
  ["the fixed origin", fixture({ fixedOrigin: [0, 0, 1] })],
];

describe("prepareSpatialGeometry: coordinate proof", () => {
  it("maps glTF metres to UE centimetres as (x, z, y) * 100 (UE (10, 30, 20) exports as glTF (0.1, 0.2, 0.3))", () => {
    const geometry = prepareSpatialGeometry(fixture());
    expectClose(geometry.query(0, [1, 0, 0], []).position, [10, 30, 20]);
    expectClose(geometry.query(0, [0, 1, 0], []).position, [40, 50, 0]);
    expectClose(geometry.query(0, [0, 0, 1], []).position, [0, 20, 70]);
  });

  it("applies a known uniform BuildScale once, then the fixed origin, to literal positions", () => {
    const geometry = prepareSpatialGeometry(
      fixture({ buildScale: { known: true, xyz: [2, 2, 2] }, fixedOrigin: [5, -7, 11] }),
    );
    expectClose(geometry.query(0, [1, 0, 0], []).position, [25, 53, 51]);
    expectClose(geometry.query(0, [0, 1, 0], []).position, [85, 93, 11]);
    expectClose(geometry.query(0, [0, 0, 1], []).position, [5, 33, 151]);
  });

  it("does not mutate the caller's arrays", () => {
    const positions = [0.1, 0.2, 0.3, 0.4, 0, 0.5, 0, 0.7, 0.2];
    const indices = [0, 1, 2];
    prepareSpatialGeometry(
      fixture({ positions, indices, buildScale: { known: true, xyz: [2, 2, 2] }, fixedOrigin: [5, -7, 11] }),
    );
    expect(positions).toEqual([0.1, 0.2, 0.3, 0.4, 0, 0.5, 0, 0.7, 0.2]);
    expect(indices).toEqual([0, 1, 2]);
  });

  it("keeps the XZY permutation, normalises each normal, and keeps its direction under a uniform scale", () => {
    for (const scale of [1, 2]) {
      const geometry = prepareSpatialGeometry(
        fixture({ normals: [2, 0, 0, 0, 0, 1, 0, 1, 0], buildScale: { known: true, xyz: [scale, scale, scale] } }),
      );
      expectClose(geometry.query(0, [1, 0, 0], []).normal, [1, 0, 0]);
      expectClose(geometry.query(0, [0, 1, 0], []).normal, [0, 1, 0]);
      expectClose(geometry.query(0, [0, 0, 1], []).normal, [0, 0, 1]);
    }
  });

  it("interpolates the declared normals and normalises the result, not the face normal", () => {
    // The face normal of the UE corners is about (0.52, -0.85, -0.07). The declared normals average to (1, 1, 1) / sqrt(3).
    const sample = prepareSpatialGeometry(fixture()).query(0, [1 / 3, 1 / 3, 1 / 3], []);
    expectClose(sample.normal, [0.5773502691896258, 0.5773502691896258, 0.5773502691896258]);
  });

  it("treats the normalised normal as nonlinear: its slope along an edge is not the affine slope", () => {
    // Corners 0 and 1 have UE normals (1, 0, 0) and (0, 1, 0). Blend (1 - t, t, 0) and normalise: at t = 0.5 the
    // slope is (-sqrt 2, sqrt 2, 0), where an affine blend would give (-1, 1, 0).
    const geometry = prepareSpatialGeometry(fixture());
    const normalAt = (t: number) => geometry.query(0, [1 - t, t, 0], []).normal;
    const h = 1e-6;
    const hi = normalAt(0.5 + h);
    const lo = normalAt(0.5 - h);
    const slope = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]].map((d) => d / (2 * h));
    expectClose(slope, [-1.4142135623730951, 1.4142135623730951, 0], 5);
    expect(slope[0]).not.toBeCloseTo(-1, 3);
  });

  it("returns analytic position and UV derivatives of an asymmetric triangle, as literal values", () => {
    // Atlas edges e1 = (0.6, -0.1) and e2 = (0.2, 0.4), determinant 0.26. Position edges (30, 20, -20), (-10, -10, 50).
    const derivatives = prepareSpatialGeometry(fixture()).derivatives(0, [0, 1, 2]);
    expectClose(derivatives.position[0], [550 / 13, 350 / 13, -150 / 13]);
    expectClose(derivatives.position[1], [-600 / 13, -500 / 13, 1700 / 13]);
    expectClose(derivatives.uv[0]![0], [27 / 26, 8 / 13]);
    expectClose(derivatives.uv[0]![1], [3 / 13, 22 / 13]);
    expectClose(derivatives.uv[1]![0], [20 / 13, 5 / 13]);
    expectClose(derivatives.uv[1]![1], [-10 / 13, 30 / 13]);
    expectClose(derivatives.uv[2]![0], [35 / 104, -45 / 52]);
    expectClose(derivatives.uv[2]![1], [-25 / 52, -5 / 26]);
  });

  it("derives the derivatives from untranslated positions: a 1e20 fixed origin leaves them as at the zero origin", () => {
    // At 1e20 the corners cannot keep their differences if the origin is added first, so this checks the order of operations.
    const far = prepareSpatialGeometry(fixture({ fixedOrigin: [1e20, 1e20, 1e20] })).derivatives(0, [0, 1, 2]);
    expectClose(far.position[0], [550 / 13, 350 / 13, -150 / 13]);
    expectClose(far.position[1], [-600 / 13, -500 / 13, 1700 / 13]);
    expect(far).toEqual(prepareSpatialGeometry(fixture()).derivatives(0, [0, 1, 2]));
  });

  it("carries the BuildScale once into the derivatives and ignores the fixed origin", () => {
    const derivatives = prepareSpatialGeometry(
      fixture({ buildScale: { known: true, xyz: [2, 2, 2] }, fixedOrigin: [5, -7, 11] }),
    ).derivatives(0, [0]);
    expectClose(derivatives.position[0], [1100 / 13, 700 / 13, -300 / 13]);
    expectClose(derivatives.position[1], [-1200 / 13, -1000 / 13, 3400 / 13]);
    expectClose(derivatives.uv[0]![0], [27 / 26, 8 / 13]);
  });

  it("interpolates every requested original UV set, set 2 included, separately from the atlas point", () => {
    const sample = prepareSpatialGeometry(fixture()).query(0, [0.2, 0.3, 0.5], [0, 1, 2]);
    expectClose(sample.atlas, [0.38, 0.37]);
    expectClose(sample.uv[0]!, [0.53, 0.56]);
    expectClose(sample.uv[1]!, [0.3, 0.5]);
    expectClose(sample.uv[2]!, [0.2625, 0.475]);
  });

  it("returns no UV set that was not requested", () => {
    expect(Object.keys(prepareSpatialGeometry(fixture()).query(0, [1, 0, 0], []).uv)).toEqual([]);
  });

  it("interpolates the composed position: the barycentric mix of the scaled and placed corners", () => {
    const geometry = prepareSpatialGeometry(
      fixture({ buildScale: { known: true, xyz: [2, 2, 2] }, fixedOrigin: [5, -7, 11] }),
    );
    expectClose(geometry.query(0, [0.2, 0.3, 0.5], []).position, [33, 55, 89]);
  });

  it("keeps the index winding as given and accepts overlapping original UVs, each interpolated per triangle", () => {
    const geometry = prepareSpatialGeometry(fixture({ indices: [0, 1, 2, 0, 2, 1] }));
    expect(geometry.triangleVertices(0)).toEqual([0, 1, 2]);
    expect(geometry.triangleVertices(1)).toEqual([0, 2, 1]);
    // Triangle 1 weights corners 0, 2, 1: 0.2 * UV0 + 0.3 * UV2 + 0.5 * UV1 = (0.59, 0.44) in set 0.
    expectClose(geometry.query(1, [0.2, 0.3, 0.5], [0]).uv[0]!, [0.59, 0.44]);
  });

  it("refuses degenerate triangles in atlas or UE space, and zero-length declared normals", () => {
    // Atlas corners 0 and 1 coincide.
    expect(
      refusalOf(() => prepareSpatialGeometry(fixture({ atlasUv: [0.1, 0.2, 0.1, 0.2, 0.3, 0.6] }))),
    ).toBe("degenerate-triangle");
    // Corner 2 is the midpoint of corners 0 and 1 in UE space: the triangle is collinear.
    expect(
      refusalOf(() => prepareSpatialGeometry(fixture({ positions: [0.1, 0.2, 0.3, 0.4, 0, 0.5, 0.25, 0.1, 0.4] }))),
    ).toBe("degenerate-triangle");
    expect(refusalOf(() => prepareSpatialGeometry(fixture({ normals: [0, 0, 0, 0, 0, 1, 0, 1, 0] })))).toBe(
      "degenerate-normal",
    );
  });

  it("refuses a query whose interpolated normal vanishes instead of normalising zero", () => {
    // Corners 0 and 1 have opposite UE normals, so the midpoint blend is zero.
    const geometry = prepareSpatialGeometry(fixture({ normals: [1, 0, 0, -1, 0, 0, 0, 1, 0] }));
    expect(refusalOf(() => geometry.query(0, [0.5, 0.5, 0], []))).toBe("degenerate-normal");
  });

  it.each(BAD_SCALES)("refuses a %s BuildScale by name", (_label, buildScale, code) => {
    expect(refusalOf(() => prepareSpatialGeometry(fixture({ buildScale })))).toBe(code);
  });

  it.each(REFUSED_INPUTS)("refuses %s by name", (_label, input, code) => {
    expect(refusalOf(() => prepareSpatialGeometry(input))).toBe(code);
  });

  it.each(BAD_BARYCENTRICS)("refuses barycentrics with a %s, without renormalising them", (_label, barycentric) => {
    const geometry = prepareSpatialGeometry(fixture());
    expect(refusalOf(() => geometry.query(0, barycentric, []))).toBe("bad-barycentric");
  });

  it.each(BAD_BARYCENTRIC_SHAPES)("refuses a barycentric with %s as bad-barycentric", (_label, barycentric) => {
    const geometry = prepareSpatialGeometry(fixture());
    expect(refusalOf(() => queryUntyped(geometry, 0, barycentric, []))).toBe("bad-barycentric");
  });

  it("refuses a query for an original UV set the mesh does not carry, and names the set", () => {
    const geometry = prepareSpatialGeometry(fixture({ originalUv: [{ set: 0, uv: [0.2, 0.1, 0.8, 0.3, 0.5, 0.9] }] }));
    expect(refusalOf(() => geometry.query(0, [1, 0, 0], [2]))).toBe("missing-uv-set");
    expect(() => geometry.query(0, [1, 0, 0], [2])).toThrow("UV set 2");
  });

  it("refuses a triangle index outside the mesh", () => {
    const geometry = prepareSpatialGeometry(fixture());
    expect(refusalOf(() => geometry.query(1, [1, 0, 0], []))).toBe("bad-triangle");
    expect(refusalOf(() => geometry.derivatives(-1, []))).toBe("bad-triangle");
  });

  it("keeps private copies of every input: later changes alter neither outputs nor fingerprint", () => {
    const positions = [0.1, 0.2, 0.3, 0.4, 0, 0.5, 0, 0.7, 0.2];
    const normals = [1, 0, 0, 0, 0, 1, 0, 1, 0];
    const atlasUv = [0.1, 0.2, 0.7, 0.1, 0.3, 0.6];
    const uv0 = [0.2, 0.1, 0.8, 0.3, 0.5, 0.9];
    const uv1 = [0, 0, 1, 0, 0, 1];
    const uv2 = [0.25, 0.75, 0.5, 0.25, 0.125, 0.5];
    const indices = [0, 1, 2];
    const proof: SourceRouteProof = { ...PROOF };
    const xyz: [number, number, number] = [2, 2, 2];
    const fixedOrigin: [number, number, number] = [5, -7, 11];
    const nodeTransform = [...IDENTITY];
    const geometry = prepareSpatialGeometry({
      positions,
      normals,
      originalUv: [
        { set: 0, uv: uv0 },
        { set: 1, uv: uv1 },
        { set: 2, uv: uv2 },
      ],
      atlasUv,
      indices,
      sourceRouteProof: proof,
      buildScale: { known: true, xyz },
      nodeTransform,
      fixedOrigin,
      deformation: "none",
    });
    const before = geometry.query(0, [0.2, 0.3, 0.5], [0, 1, 2]);
    const beforeDerivatives = geometry.derivatives(0, [0, 1, 2]);
    const fingerprint = geometry.fingerprint;
    expectClose(before.position, [33, 55, 89]);
    expectClose(before.uv[2]!, [0.2625, 0.475]);

    positions[0] = 999;
    normals[0] = -5;
    atlasUv[0] = 0.99;
    uv0[0] = 0.99;
    uv1[0] = 0.99;
    uv2[0] = 0.99;
    indices[0] = 2;
    Reflect.set(proof, "exportScale", 1);
    Reflect.set(proof, "bCooked", 1);
    Reflect.set(xyz, 0, 3);
    Reflect.set(fixedOrigin, 0, 99);
    Reflect.set(nodeTransform, 12, 5);
    expect(geometry.query(0, [0.2, 0.3, 0.5], [0, 1, 2])).toEqual(before);
    expect(geometry.derivatives(0, [0, 1, 2])).toEqual(beforeDerivatives);
    expect(geometry.fingerprint).toBe(fingerprint);
    expect(geometry.triangleVertices(0)).toEqual([0, 1, 2]);
  });

  it("returns frozen plain arrays, so a caller cannot write into the prepared result", () => {
    const geometry = prepareSpatialGeometry(fixture());
    const sample = geometry.query(0, [0.2, 0.3, 0.5], [0]);
    expect(Object.isFrozen(sample)).toBe(true);
    expect(Object.isFrozen(sample.position)).toBe(true);
    expect(Reflect.set(sample.position, 0, 99)).toBe(false);
    expectClose(geometry.query(0, [0.2, 0.3, 0.5], [0]).position, [14, 31, 39]);
  });

  it("freezes every nested tuple a query or derivative returns, and later calls are unchanged", () => {
    const geometry = prepareSpatialGeometry(fixture());
    const sample = geometry.query(0, [0.2, 0.3, 0.5], [0, 2]);
    const derivatives = geometry.derivatives(0, [0, 2]);
    const sampleParts = [sample, sample.atlas, sample.position, sample.normal, sample.uv, sample.uv[0]!, sample.uv[2]!];
    const derivativeParts = [
      derivatives,
      derivatives.position,
      derivatives.position[0],
      derivatives.position[1],
      derivatives.uv,
      derivatives.uv[0]!,
      derivatives.uv[0]![0],
      derivatives.uv[2]!,
    ];
    for (const part of [...sampleParts, ...derivativeParts, geometry.triangleVertices(0)]) {
      expect(Object.isFrozen(part)).toBe(true);
    }
    expect(Reflect.set(sample.position, 0, 99)).toBe(false);
    expect(Reflect.set(sample.uv, 0, [9, 9])).toBe(false);
    expect(Reflect.set(derivatives.position[0], 1, 99)).toBe(false);
    expect(Reflect.set(derivatives.uv[0]![1], 0, 99)).toBe(false);
    expectClose(geometry.query(0, [0.2, 0.3, 0.5], [0, 2]).position, [14, 31, 39]);
    expectClose(geometry.derivatives(0, [0, 2]).position[1], [-600 / 13, -500 / 13, 1700 / 13]);
  });
});

describe("prepareSpatialGeometry: finite policy", () => {
  it("refuses a BuildScale whose composed positions overflow, by name", () => {
    // 1e308 times 100 times 0.1 metres is past the largest double.
    const input = fixture({ buildScale: { known: true, xyz: [1e308, 1e308, 1e308] } });
    expect(refusalOf(() => prepareSpatialGeometry(input))).toBe("nonfinite");
  });

  it("refuses a placed position that overflows although every input is finite", () => {
    // The scaled offsets (1e300 times 100 times metres) and the origin are each finite; origin plus offset is not.
    const input = fixture({
      buildScale: { known: true, xyz: [1e300, 1e300, 1e300] },
      fixedOrigin: [Number.MAX_VALUE, 0, 0],
    });
    expect(refusalOf(() => prepareSpatialGeometry(input))).toBe("nonfinite");
  });

  it("refuses an overflowing UE-space edge by name instead of reading its NaN area as non-degenerate", () => {
    // Corners 0 and 2 coincide and corner 1 lies 2e308 away: the edge arithmetic overflows, then yields NaN.
    const input = fixture({ positions: [-1e308, 0, 0, 1e308, 0, 0, -1e308, 0, 0] });
    expect(refusalOf(() => prepareSpatialGeometry(input))).toBe("nonfinite");
  });

  it("refuses a UV difference that overflows, when derivatives are requested", () => {
    // The two corners' U values are finite but 3.4e308 apart.
    const geometry = prepareSpatialGeometry(fixture({ originalUv: [{ set: 0, uv: [-1.7e308, 0, 1.7e308, 0, 0, 0] }] }));
    expect(refusalOf(() => geometry.derivatives(0, [0]))).toBe("nonfinite");
  });

  it("refuses a UV gradient that overflows although its UV inputs are finite", () => {
    // A 1.7e308 UV difference over a 1e-5 atlas edge, divided by a determinant of 1e-10, is about 1.7e313.
    const geometry = prepareSpatialGeometry(
      fixture({ atlasUv: [0, 0, 1e-5, 0, 0, 1e-5], originalUv: [{ set: 0, uv: [0, 0, 1.7e308, 0, 0, 0] }] }),
    );
    expect(refusalOf(() => geometry.derivatives(0, [0]))).toBe("nonfinite");
  });

  it("normalises a huge declared normal to its unit direction, never to zero", () => {
    // (1.7e308, 1.7e308, 1.7e308) is longer than the largest double; its direction is (1, 1, 1) / sqrt 3.
    const geometry = prepareSpatialGeometry(fixture({ normals: [1.7e308, 1.7e308, 1.7e308, 0, 0, 1, 0, 1, 0] }));
    expectClose(geometry.query(0, [1, 0, 0], []).normal, [0.5773502691896258, 0.5773502691896258, 0.5773502691896258]);
  });

  it("keeps the signs of a huge declared normal when it normalises it", () => {
    // glTF (1.7e308, -1.7e308, 1.7e308) is UE (1.7e308, 1.7e308, -1.7e308): direction (1, 1, -1) / sqrt 3.
    const geometry = prepareSpatialGeometry(fixture({ normals: [1.7e308, -1.7e308, 1.7e308, 0, 0, 1, 0, 1, 0] }));
    expectClose(geometry.query(0, [1, 0, 0], []).normal, [0.5773502691896258, 0.5773502691896258, -0.5773502691896258]);
  });

  it("sets no arbitrary coordinate limit: a representable 1e100 scale gives finite, correctly scaled results", () => {
    // Corner 0 is UE (10, 30, 20) cm before the scale; at 1e100 every value is still finite.
    const geometry = prepareSpatialGeometry(fixture({ buildScale: { known: true, xyz: [1e100, 1e100, 1e100] } }));
    const sample = geometry.query(0, [1, 0, 0], [0]);
    const derivatives = geometry.derivatives(0, [0]);
    expect(sample.position[0] / 1e100).toBeCloseTo(10, 9);
    expect(derivatives.position[0][0] / 1e100).toBeCloseTo(550 / 13, 9);
    const values = [
      ...sample.position,
      ...sample.normal,
      ...sample.atlas,
      ...derivatives.position[0],
      ...derivatives.position[1],
      ...derivatives.uv[0]![0],
      ...derivatives.uv[0]![1],
    ];
    expect(values.every(Number.isFinite)).toBe(true);
  });
});

describe("prepareSpatialGeometry: fingerprint", () => {
  it("is identical for identical input", () => {
    expect(prepareSpatialGeometry(fixture()).fingerprint).toBe(prepareSpatialGeometry(fixture()).fingerprint);
  });

  it.each(FINGERPRINT_VARIANTS)("changes when %s changes", (_label, variant) => {
    expect(prepareSpatialGeometry(variant).fingerprint).not.toBe(prepareSpatialGeometry(fixture()).fingerprint);
  });
});
