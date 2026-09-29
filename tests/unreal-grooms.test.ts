import { describe, expect, it } from "vitest";

import { ImportError } from "../src/unreal/errors.js";
import { decodeGroomPayload, groomSidecar } from "../src/unreal/grooms.js";

/**
 * A GroomAsset's hair description only exists inside MetaHuman packages that cannot be committed,
 * so the decoder is guarded by a payload built here in the encoding the converter hands it: the
 * same bulk-array layout the mesh-description reader in cue4parse-adapter.ts parses.
 */

/** An FString: a length that counts its own NUL terminator. */
function fstr(text: string): Buffer {
  const bytes = Buffer.from(text, "latin1");
  const encoded = Buffer.alloc(4 + bytes.length + 1);
  encoded.writeInt32LE(bytes.length + 1, 0);
  bytes.copy(encoded, 4);
  return encoded;
}

const DEFAULT_VALUE_BYTES = [16, 12, 8, 4, 4, 4] as const;

type Attribute =
  | { readonly name: string; readonly kind: number; readonly values: readonly number[] }
  | { readonly name: string; readonly kind: 6; readonly names: readonly string[] };

function attribute(entry: Attribute): Buffer {
  // Type code, then the allocator and flag words the encoding writes before its channel count.
  const head = Buffer.alloc(16);
  head.writeInt32LE(entry.kind, 0);
  head.writeInt32LE(1, 12);
  const name = fstr(entry.name);
  if ("names" in entry) {
    const names = entry.names.map(fstr);
    const count = Buffer.alloc(8);
    count.writeInt32LE(entry.names.length, 4);
    const tail = Buffer.alloc(4);
    tail.writeInt32LE(0, 0);
    return Buffer.concat([name, head, count, ...names, fstr(""), tail]);
  }
  const perElement = entry.kind === 1 ? 3 : entry.kind === 2 ? 2 : 1;
  if (entry.values.length % perElement !== 0) throw new Error(`${entry.name} needs whole elements`);
  const values = Buffer.alloc(entry.values.length * 4);
  entry.values.forEach((value, index) => {
    if (entry.kind === 4) values.writeInt32LE(value, index * 4);
    else values.writeFloatLE(value, index * 4);
  });
  // Channel extent, then the element size and count of the bulk array.
  const block = Buffer.alloc(12);
  block.writeInt32LE(entry.values.length / perElement, 0);
  block.writeInt32LE(perElement * 4, 4);
  block.writeInt32LE(entry.values.length / perElement, 8);
  // An encoding this build does not know still needs a default value to sit behind it.
  const defaultValue = Buffer.alloc(DEFAULT_VALUE_BYTES[entry.kind] ?? 4);
  const flags = Buffer.alloc(4);
  return Buffer.concat([name, head, block, values, defaultValue, flags]);
}

function elementSet(elements: number, attributes: readonly Attribute[]): Buffer {
  const header = Buffer.alloc(8);
  header.writeInt32LE(elements, 0);
  header.writeInt32LE(attributes.length, 4);
  return Buffer.concat([header, ...attributes.map(attribute)]);
}

interface Hair {
  /** f32 triples in Unreal's centimetre, Z-up frame. */
  readonly positions: readonly number[];
  readonly widths: readonly number[];
  readonly pointsPerStrand: readonly number[];
  readonly guides?: readonly number[];
  readonly groups?: readonly number[];
  readonly curveTypes?: readonly number[];
  /** The name-list encoding of the same enum, which some engine versions write instead. */
  readonly curveTypeNames?: readonly string[];
  /** Overrides the strand count the points per strand are measured against. */
  readonly strandCount?: number;
  /** Appends a trailing byte, so a payload can be made longer than its own contents. */
  readonly trailing?: number;
  /** Overrides an attribute's type code, to encode something this build does not know. */
  readonly unknownKind?: number;
}

function payload(hair: Hair): Buffer {
  const vertices = hair.pointsPerStrand.reduce((total, count) => total + count, 0);
  const strands = hair.strandCount ?? hair.pointsPerStrand.length;
  const head = Buffer.alloc(8);
  head.writeInt32LE(vertices, 0);
  head.writeInt32LE(strands, 4);
  const bytes = Buffer.concat([
    head,
    elementSet(vertices, [
      { name: "position", kind: 1, values: hair.positions },
      { name: "groom_width", kind: 3, values: hair.widths },
      // An attribute this format does not read, which still has to be consumed exactly.
      { name: "groom_color", kind: 2, values: hair.positions.flatMap((_, index) => [index % 2, 0.5]) },
    ]),
    elementSet(strands, [
      { name: "vertexcount", kind: 4, values: hair.pointsPerStrand },
      { name: "groom_guide", kind: 4, values: hair.guides ?? hair.pointsPerStrand.map(() => 0) },
      { name: "groom_group_id", kind: 4, values: hair.groups ?? hair.pointsPerStrand.map(() => 0) },
      hair.curveTypeNames === undefined
        ? { name: "groom_curve_type", kind: 4, values: hair.curveTypes ?? hair.pointsPerStrand.map(() => 0) }
        : { name: "groom_curve_type", kind: 6, names: hair.curveTypeNames },
      { name: "groom_basis_type", kind: 6, names: ["Basis"] },
    ]),
    elementSet(0, hair.unknownKind === undefined ? [] : [{ name: "groom_unknown", kind: hair.unknownKind, values: [1] }]),
  ]);
  return hair.trailing === undefined ? bytes : Buffer.concat([bytes, Buffer.from([hair.trailing])]);
}

/**
 * The two-strand fixture: a two-point guide strand, then a three-point renderable one. The guide
 * comes first on purpose: its points still hold their slots in the payload, so a decoder that
 * forgets to step over them writes the guide's positions and widths.
 */
const COIL_HAIR: Hair = {
  positions: [99, 99, 99, 99, 99, 99, 10, 20, 30, 10, 20, 40, 10, 20, 50],
  widths: [3, 3, 1, 0.5, 0.25],
  pointsPerStrand: [2, 3],
  guides: [1, 0],
};
const COIL = payload(COIL_HAIR);

/** Centimetres to metres at float32 precision, which is what the converter writes. */
const metres = (centimetres: number): number => Math.fround(centimetres * Math.fround(0.01));

describe("Unreal groom strand decoding", () => {
  it("excludes guide strands, converts to metres and glTF's Y-up frame, and writes the documented layout", () => {
    const strands = decodeGroomPayload(COIL);
    expect(strands.strandCount).toBe(1);
    expect(strands.pointCount).toBe(3);
    expect(strands.excludedGuides).toBe(1);
    expect([...strands.binary.subarray(0, 12)]).toEqual([1, 0, 0, 0, 3, 0, 0, 0, 3, 0, 0, 0]);
    // Unreal (10, 20, 30) is glTF (0.1, 0.3, 0.2): X stays, Y and Z swap, centimetres become metres.
    const read = (offset: number) => [
      strands.binary.readFloatLE(offset),
      strands.binary.readFloatLE(offset + 4),
      strands.binary.readFloatLE(offset + 8),
    ];
    expect(read(12)).toEqual([metres(10), metres(30), metres(20)]);
    expect(read(24)).toEqual([metres(10), metres(40), metres(20)]);
    expect(read(36)).toEqual([metres(10), metres(50), metres(20)]);
    // Widths follow the positions, in metres, and the guide's 3 cm never appears.
    expect(strands.binary.readFloatLE(48)).toBe(metres(1));
    expect(strands.binary.readFloatLE(52)).toBe(metres(0.5));
    expect(strands.binary.readFloatLE(56)).toBe(metres(0.25));
    expect(strands.binary.byteLength).toBe(8 + 4 + 3 * 16);
    expect(strands.bounds).toEqual({
      min: [metres(10), metres(30), metres(20)],
      max: [metres(10), metres(50), metres(20)],
    });
    expect(strands.widthRange).toEqual({ min: metres(0.25), max: metres(1) });
    expect(groomSidecar(strands, "Content/MetaHumans/Ada/FemaleHair/Hair/Hair_S_Coil.uasset")).toEqual({
      strandCount: 1,
      pointCount: 3,
      bounds: strands.bounds,
      widthRange: strands.widthRange,
      units: "m",
      excludedGuides: 1,
      source: "Content/MetaHumans/Ada/FemaleHair/Hair/Hair_S_Coil.uasset",
    });
  });

  it("refuses a payload it cannot read to its last byte instead of decoding part of it", () => {
    for (const [what, bytes] of [
      ["truncated", COIL.subarray(0, COIL.byteLength - 4)],
      ["a byte longer than its own contents", payload({ ...COIL_HAIR, trailing: 0xff })],
    ] as const) {
      let thrown: unknown;
      try {
        decodeGroomPayload(bytes);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, what).toBeInstanceOf(ImportError);
      expect((thrown as ImportError).code, what).toBe("UNREAL_GROOM_INVALID");
      expect((thrown as ImportError).message, what).toMatch(/ended inside|not fully consumed/);
    }
  });

  it("refuses strands it would have to guess at", () => {
    const refuse = (code: "UNREAL_GROOM_INVALID" | "UNREAL_GROOM_UNSUPPORTED", hair: Hair) => {
      let thrown: ImportError | undefined;
      try {
        decodeGroomPayload(payload(hair));
      } catch (error) {
        thrown = error as ImportError;
      }
      expect(thrown?.code).toBe(code);
      return thrown?.message ?? "";
    };
    const straight = { positions: [10, 20, 30], widths: [1], pointsPerStrand: [1] };
    // Only guide strands is nothing to draw; a strand with no points is not a strand.
    expect(refuse("UNREAL_GROOM_INVALID", { ...straight, guides: [1] })).toMatch(/only guide strands/);
    expect(refuse("UNREAL_GROOM_INVALID", { ...straight, pointsPerStrand: [1, 0] })).toMatch(/strand 1 0 points/);
    // A declaration the points do not add up to is a layout this build has not verified.
    expect(refuse("UNREAL_GROOM_INVALID", { ...straight, strandCount: 2 })).toMatch(/lists 1 strands/);
    expect(refuse("UNREAL_GROOM_INVALID", { ...straight, unknownKind: 7 })).toMatch(/unknown attribute encoding 7/);
    expect(refuse("UNREAL_GROOM_INVALID", { ...straight, widths: [Number.NaN] })).toMatch(/non-finite/);
    expect(refuse("UNREAL_GROOM_UNSUPPORTED", { ...straight, groups: [0], curveTypes: [2] })).toMatch(/curve type 2/);
    expect(refuse("UNREAL_GROOM_UNSUPPORTED", { ...straight, curveTypeNames: ["Curved"] })).toMatch(/curve type Curved/);
    // The name-list encoding of a linear asset, which is what MetaHuman 5.5 eyebrows write.
    expect(decodeGroomPayload(payload({ ...straight, curveTypeNames: ["Linear"] })).strandCount).toBe(1);
    expect(refuse("UNREAL_GROOM_UNSUPPORTED", { ...straight, pointsPerStrand: [1, 1], positions: [1, 2, 3, 4, 5, 6], widths: [1, 1], groups: [0, 3] })).toMatch(/groups 0, 3/);
  });
});
