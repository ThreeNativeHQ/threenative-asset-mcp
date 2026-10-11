import { describe, expect, it } from "vitest";

import {
  isVerifiedCornerRemap,
  verifyCornerRemap,
  type CornerRemapRefusal,
  type CornerRemapResult,
  type SpatialAttributeData,
  type SpatialAttributeSnapshot,
  type SpatialComponentType,
  type VerifiedCornerRemap,
} from "../src/unreal/spatial-remap.js";

// Synthetic, hand-written data only. Source: four vertices and two faces sharing edge 1-2:
//   source face 0 = (0, 1, 2), source face 1 = (2, 1, 3).
// Output: six vertices. A valid output corner order is a cyclic rotation of the source corners, e.g. (1, 3, 2) for
// source face 1. Reversed winding, (2, 3, 1), is not a rotation and must be refused.

interface Spec {
  readonly componentType: SpatialComponentType;
  readonly itemSize: number;
  readonly normalized: boolean;
  readonly values: readonly number[];
}

const SPECS: ReadonlyMap<string, Spec> = new Map<string, Spec>([
  ["POSITION", { componentType: "float32", itemSize: 3, normalized: false, values: [0.1, 0.2, 0.3, 0.4, 0, 0.5, 0, 0.7, 0.2, 0.9, 0.6, 0.1] }],
  ["NORMAL", { componentType: "float32", itemSize: 3, normalized: false, values: [0, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0, 0] }],
  ["TEXCOORD_0", { componentType: "float32", itemSize: 2, normalized: false, values: [0.2, 0.1, 0.8, 0.3, 0.5, 0.9, 0.6, 0.4] }],
  ["TEXCOORD_1", { componentType: "float32", itemSize: 2, normalized: false, values: [0, 0, 1, 0, 0, 1, 0.25, 0.75] }],
  ["COLOR_0", { componentType: "uint8", itemSize: 4, normalized: true, values: [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 12, 34, 56, 78] }],
  ["TANGENT", { componentType: "float32", itemSize: 4, normalized: false, values: [1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 1, -1, 0.5, 0.5, 0.5, 1] }],
  ["_ID", { componentType: "uint16", itemSize: 1, normalized: false, values: [7, 8, 9, 10] }],
]);

const SOURCE_INDICES = [0, 1, 2, 2, 1, 3];
const IDENTITY = [0, 1, 2, 3];
const REMAP_INDICES = [0, 1, 2, 3, 4, 5];
const FACE_MAP = [0, 1];
const VERTEX_MAP = [0, 1, 2, 1, 3, 2];

type Table = Map<string, number[]>;
interface Edit {
  readonly name: string;
  readonly index: number;
  readonly value: number;
}

/** Fixtures stay mutable so a case can edit one attribute; they are assignable to SpatialMeshSnapshot. */
interface Fixture {
  vertexCount: number;
  attributes: Map<string, SpatialAttributeSnapshot>;
  indices: number[];
}

function baseTable(): Table {
  return new Map([...SPECS].map(([name, spec]): [string, number[]] => [name, [...spec.values]]));
}

function packed(componentType: SpatialComponentType, values: readonly number[]): SpatialAttributeData {
  switch (componentType) {
    case "int8":
      return Int8Array.from(values);
    case "uint8":
      return Uint8Array.from(values);
    case "int16":
      return Int16Array.from(values);
    case "uint16":
      return Uint16Array.from(values);
    case "uint32":
      return Uint32Array.from(values);
    case "float32":
      return Float32Array.from(values);
  }
}

/** Output vertex v takes the row of table vertex order[v]; an edit lands on one output value. */
function build(table: Table, order: readonly number[], indices: readonly number[], edit?: Edit): Fixture {
  const attributes = new Map<string, SpatialAttributeSnapshot>();
  for (const [name, spec] of SPECS) {
    const values = table.get(name) ?? [];
    const rows = order.flatMap((vertex) => values.slice(vertex * spec.itemSize, (vertex + 1) * spec.itemSize));
    if (edit?.name === name) rows[edit.index] = edit.value;
    attributes.set(name, {
      componentType: spec.componentType,
      itemSize: spec.itemSize,
      normalized: spec.normalized,
      data: packed(spec.componentType, rows),
    });
  }
  return { vertexCount: order.length, attributes, indices: [...indices] };
}

function source(edit?: Edit): Fixture {
  return build(baseTable(), IDENTITY, SOURCE_INDICES, edit);
}

function remapped(vertexMap: readonly number[] = VERTEX_MAP, edit?: Edit): Fixture {
  return build(baseTable(), vertexMap, REMAP_INDICES, edit);
}

function outcome(result: CornerRemapResult): CornerRemapRefusal | "verified" {
  return result.kind === "refused" ? result.name : "verified";
}

function verifiedOrThrow(result: CornerRemapResult): VerifiedCornerRemap {
  if (result.kind !== "verified") throw new Error(`expected verified, got ${result.name}: ${result.detail}`);
  return result;
}

describe("verifyCornerRemap: accepted layouts", () => {
  it("verifies a split mesh whose output corners are a cyclic rotation of each source face", () => {
    const result = verifiedOrThrow(verifyCornerRemap(source(), remapped(), FACE_MAP, VERTEX_MAP));

    expect(result.sourceVertexCount).toBe(4);
    expect(result.sourceFaceCount).toBe(2);
    expect(result.vertexCount).toBe(6);
    expect(result.faceCount).toBe(2);
    expect(result.attributeNames).toEqual(["COLOR_0", "NORMAL", "POSITION", "TANGENT", "TEXCOORD_0", "TEXCOORD_1", "_ID"]);
    expect(Array.from(result.indices())).toEqual(REMAP_INDICES);
    expect(Array.from(result.sourceFaceForOutputFace())).toEqual(FACE_MAP);
    expect(Array.from(result.sourceVertexForOutputVertex())).toEqual(VERTEX_MAP);
    expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(isVerifiedCornerRemap(result)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(() => Object.assign(result, { kind: "tampered" })).toThrow();
  });

  it.each([
    ["identity rotation", [0, 1, 2, 2, 1, 3]],
    ["rotation by one", [0, 1, 2, 1, 3, 2]],
    ["rotation by two", [0, 1, 2, 3, 2, 1]],
  ])("accepts every cyclic rotation of the corners (%s)", (_label, vertexMap) => {
    verifiedOrThrow(verifyCornerRemap(source(), remapped(vertexMap), FACE_MAP, vertexMap));
  });

  it("accepts overlapping original TEXCOORD_0; the no-overlap guarantee belongs to the atlas", () => {
    const table = baseTable();
    table.set("TEXCOORD_0", [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
    const src = build(table, IDENTITY, SOURCE_INDICES);
    const rem = build(table, VERTEX_MAP, REMAP_INDICES);
    verifiedOrThrow(verifyCornerRemap(src, rem, FACE_MAP, VERTEX_MAP));
  });
});

describe("verifyCornerRemap: correspondence", () => {
  it("refuses reversed corner winding", () => {
    const reversed = [0, 1, 2, 2, 3, 1];
    expect(outcome(verifyCornerRemap(source(), remapped(reversed), FACE_MAP, reversed))).toBe("corner-correspondence-mismatch");
  });

  it("matches corners by source vertex id, not by position", () => {
    const table = baseTable();
    // Source vertex 3 takes vertex 2's position, so output corner 4 pointing at source 2 matches by position where
    // source 3 belongs. Only the source vertex id can tell them apart.
    const positions = table.get("POSITION") ?? [];
    positions.splice(9, 3, ...positions.slice(6, 9));
    const map = [0, 1, 2, 1, 2, 2];
    const src = build(table, IDENTITY, SOURCE_INDICES);
    const rem = build(table, map, REMAP_INDICES);
    expect(outcome(verifyCornerRemap(src, rem, FACE_MAP, map))).toBe("corner-correspondence-mismatch");
  });

  it("refuses a face map that is not a bijection onto the source faces", () => {
    expect(outcome(verifyCornerRemap(source(), remapped(), [0, 0], VERTEX_MAP))).toBe("face-map-not-bijective");
  });

  it.each([
    ["out of range", [0, 2]],
    ["fractional", [0, 1.5]],
    ["short", [0]],
  ])("refuses a face map entry that is %s", (_label, faceMap) => {
    expect(outcome(verifyCornerRemap(source(), remapped(), faceMap, VERTEX_MAP))).toBe("face-map-invalid");
  });

  it.each([
    ["out of range", [0, 1, 2, 1, 3, 4]],
    ["negative", [0, 1, 2, 1, 3, -1]],
    ["fractional", [0, 1, 2, 1, 1.5, 2]],
    ["short", [0, 1, 2, 1, 3]],
  ])("refuses a vertex map entry that is %s", (_label, vertexMap) => {
    expect(outcome(verifyCornerRemap(source(), remapped(), FACE_MAP, vertexMap))).toBe("vertex-map-invalid");
  });

  it("verifies every output vertex, including one that no face uses", () => {
    const rem = build(baseTable(), [0, 1, 2, 1, 3, 2, 0], REMAP_INDICES);
    expect(outcome(verifyCornerRemap(source(), rem, FACE_MAP, [0, 1, 2, 1, 3, 2, 99]))).toBe("vertex-map-invalid");
  });
});

describe("verifyCornerRemap: attributes", () => {
  it("refuses a missing or an extra original attribute", () => {
    const missing = remapped();
    missing.attributes.delete("COLOR_0");
    expect(outcome(verifyCornerRemap(source(), missing, FACE_MAP, VERTEX_MAP))).toBe("attribute-set-mismatch");

    const extra = remapped();
    extra.attributes.set("_EXTRA", { componentType: "uint8", itemSize: 1, normalized: false, data: new Uint8Array(6) });
    expect(outcome(verifyCornerRemap(source(), extra, FACE_MAP, VERTEX_MAP))).toBe("attribute-set-mismatch");
  });

  it("refuses a componentType mismatch", () => {
    const rem = remapped();
    const color = rem.attributes.get("COLOR_0");
    if (!color) throw new Error("fixture has no COLOR_0");
    rem.attributes.set("COLOR_0", { ...color, componentType: "float32", data: Float32Array.from(color.data) });
    expect(outcome(verifyCornerRemap(source(), rem, FACE_MAP, VERTEX_MAP))).toBe("attribute-representation-mismatch");
  });

  it("refuses a normalized mismatch", () => {
    const rem = remapped();
    const color = rem.attributes.get("COLOR_0");
    if (!color) throw new Error("fixture has no COLOR_0");
    rem.attributes.set("COLOR_0", { ...color, normalized: false });
    expect(outcome(verifyCornerRemap(source(), rem, FACE_MAP, VERTEX_MAP))).toBe("attribute-representation-mismatch");
  });

  it("refuses an itemSize mismatch", () => {
    const rem = remapped();
    rem.attributes.set("_ID", { componentType: "uint16", itemSize: 2, normalized: false, data: new Uint16Array(12) });
    expect(outcome(verifyCornerRemap(source(), rem, FACE_MAP, VERTEX_MAP))).toBe("attribute-representation-mismatch");
  });

  it.each<[string, Edit]>([
    ["COLOR_0", { name: "COLOR_0", index: 4 * 4, value: 1 }],
    ["TANGENT", { name: "TANGENT", index: 5 * 4 + 3, value: 2 }],
    ["TEXCOORD_1", { name: "TEXCOORD_1", index: 3 * 2 + 1, value: 0.5 }],
  ])("refuses a changed %s value at one corner", (_name, edit) => {
    expect(outcome(verifyCornerRemap(source(), remapped(VERTEX_MAP, edit), FACE_MAP, VERTEX_MAP))).toBe("attribute-bytes-mismatch");
  });

  it("refuses a data array whose length is not vertexCount times itemSize", () => {
    const rem = remapped();
    rem.attributes.set("POSITION", { componentType: "float32", itemSize: 3, normalized: false, data: new Float32Array(8) });
    expect(outcome(verifyCornerRemap(source(), rem, FACE_MAP, VERTEX_MAP))).toBe("malformed-snapshot");
  });

  it("refuses a typed array that does not match its componentType", () => {
    const rem = remapped();
    rem.attributes.set("NORMAL", { componentType: "float32", itemSize: 3, normalized: false, data: new Uint8Array(18) });
    expect(outcome(verifyCornerRemap(source(), rem, FACE_MAP, VERTEX_MAP))).toBe("malformed-snapshot");
  });

  it("refuses an itemSize outside 1..4", () => {
    const rem = remapped();
    rem.attributes.set("_ID", { componentType: "uint16", itemSize: 0, normalized: false, data: new Uint16Array(0) });
    expect(outcome(verifyCornerRemap(source(), rem, FACE_MAP, VERTEX_MAP))).toBe("malformed-snapshot");
  });
});

describe("verifyCornerRemap: indices and mesh shape", () => {
  it("refuses an index list whose length is not a multiple of three", () => {
    const rem = build(baseTable(), VERTEX_MAP, [0, 1, 2, 3]);
    expect(outcome(verifyCornerRemap(source(), rem, FACE_MAP, VERTEX_MAP))).toBe("malformed-indices");
  });

  it("refuses an index outside the vertex range", () => {
    const rem = build(baseTable(), VERTEX_MAP, [0, 1, 2, 3, 4, 6]);
    expect(outcome(verifyCornerRemap(source(), rem, FACE_MAP, VERTEX_MAP))).toBe("index-out-of-range");
  });

  it("refuses a fractional source index", () => {
    const src = build(baseTable(), IDENTITY, [0, 1, 2, 2, 1, 1.5]);
    expect(outcome(verifyCornerRemap(src, remapped(), FACE_MAP, VERTEX_MAP))).toBe("malformed-indices");
  });

  it("refuses an empty mesh", () => {
    const src = build(baseTable(), [0], []);
    const rem = build(baseTable(), [0], []);
    expect(outcome(verifyCornerRemap(src, rem, [], [0]))).toBe("empty-mesh");
  });
});

describe("verifyCornerRemap: provenance", () => {
  it("keeps private copies, so later mutation of the inputs or of returned arrays changes nothing", () => {
    const src = source();
    const rem = remapped();
    const faceMap = [...FACE_MAP];
    const vertexMap = [...VERTEX_MAP];
    const verified = verifiedOrThrow(verifyCornerRemap(src, rem, faceMap, vertexMap));
    const fingerprint = verified.fingerprint;

    faceMap.reverse();
    vertexMap.fill(0);
    src.indices.fill(0);
    const position = src.attributes.get("POSITION");
    if (position) (position.data as Float32Array).fill(0);
    rem.attributes.clear();
    verified.indices().fill(42);

    expect(Array.from(verified.indices())).toEqual(REMAP_INDICES);
    expect(Array.from(verified.sourceFaceForOutputFace())).toEqual(FACE_MAP);
    expect(Array.from(verified.sourceVertexForOutputVertex())).toEqual(VERTEX_MAP);
    expect(verified.fingerprint).toBe(fingerprint);
  });

  it("is deterministic, and changes with any verified input", () => {
    const base = verifiedOrThrow(verifyCornerRemap(source(), remapped(), FACE_MAP, VERTEX_MAP)).fingerprint;
    const again = verifiedOrThrow(verifyCornerRemap(source(), remapped(), FACE_MAP, VERTEX_MAP)).fingerprint;
    expect(again).toBe(base);

    const rotated = [0, 1, 2, 3, 2, 1];
    const otherMap = verifiedOrThrow(verifyCornerRemap(source(), remapped(rotated), FACE_MAP, rotated)).fingerprint;
    expect(otherMap).not.toBe(base);

    const tangentEdit: Edit = { name: "TANGENT", index: 0, value: 0.75 };
    const editedBytes = verifiedOrThrow(
      verifyCornerRemap(source(tangentEdit), remapped(VERTEX_MAP, tangentEdit), FACE_MAP, VERTEX_MAP),
    ).fingerprint;
    expect(editedBytes).not.toBe(base);
  });

  it("does not recognise a hand-built object of the same shape", () => {
    const verified = verifiedOrThrow(verifyCornerRemap(source(), remapped(), FACE_MAP, VERTEX_MAP));
    expect(isVerifiedCornerRemap(verified)).toBe(true);
    expect(isVerifiedCornerRemap({ ...verified })).toBe(false);
    expect(isVerifiedCornerRemap(Object.create(verified))).toBe(false);
  });
});
