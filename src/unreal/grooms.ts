import { ImportError } from "./errors.js";

/**
 * Unreal editor hair strands: a GroomAsset's `FHairDescription` bulk data, decoded to the renderable
 * polyline the game draws. The payload is the same bulk-array encoding the mesh-description reader
 * in cue4parse-adapter.ts already parses — the same FString headers, the same per-attribute type
 * codes, the same trailing default value and flags — so this is a port of that reader, not a second
 * binary format.
 *
 * Every decode refuses rather than guesses: a payload that is not consumed to its last byte, an
 * attribute type this build does not know, a non-finite position or width, and a hair description
 * with no renderable strand all raise UNREAL_GROOM_INVALID, while a description that is valid but
 * describes strands this format cannot carry raises UNREAL_GROOM_UNSUPPORTED.
 */

/** Attribute type codes, as written by `FAttributeInfo::Type`. Code 0 is FVector4f, which no hair
 * attribute uses, and 2 is FVector2f. */
const VECTOR3F = 1;
const FLOAT = 3;
const INT32 = 4;
const NAME = 6;

/** Bytes of the default value UE writes after every attribute's channels: FVector4f, FVector3f,
 * FVector2f, float, int32, and a 4-byte UE bool (bulk arrays store one byte per bool element, but
 * the default value is the struct-sized field). */
const DEFAULT_VALUE_BYTES = [16, 12, 8, 4, 4, 4] as const;

/** Unreal stores lengths in centimetres and in a left-handed Z-up frame; glTF is metres, Y-up and
 * right-handed. The same swap and scale the converter applies to mesh positions
 * (cue4parse-adapter.ts, WriteEditorMeshGlb), with the 0.01 rounded to float32 first so the
 * conversion rounds exactly once, as it does in the converter. */
const CENTIMETRES_TO_METRES = Math.fround(0.01);

const MAX_ELEMENTS = 1 << 28;
const MAX_ATTRIBUTES = 256;
const MAX_CHANNELS = 64;
const MAX_NAME_LENGTH = 4096;

export interface GroomStrands {
  readonly strandCount: number;
  readonly pointCount: number;
  /** Guide strands left out: they position the renderable strands but are never drawn. */
  readonly excludedGuides: number;
  /** Metres, in glTF space. */
  readonly bounds: { readonly min: readonly [number, number, number]; readonly max: readonly [number, number, number] };
  readonly widthRange: { readonly min: number; readonly max: number };
  /**
   * The renderable strands, in the documented `.strands.bin` layout: little-endian `u32` strand
   * count, `u32` point count, `u32[strandCount]` points per strand, `f32[pointCount * 3]` positions,
   * `f32[pointCount]` widths. Guides excluded.
   */
  readonly binary: Buffer;
}

export interface GroomSidecar {
  readonly strandCount: number;
  readonly pointCount: number;
  readonly bounds: GroomStrands["bounds"];
  readonly widthRange: GroomStrands["widthRange"];
  readonly units: "m";
  readonly excludedGuides: number;
  /** The Unreal package the strands came from. */
  readonly source: string;
}

function invalid(message: string): ImportError {
  return new ImportError("UNREAL_GROOM_INVALID", `Unreal groom editor payload ${message}.`);
}

function unsupported(message: string): ImportError {
  return new ImportError(
    "UNREAL_GROOM_UNSUPPORTED",
    `Unreal groom asset ${message}; strands are not written rather than reinterpreted.`,
  );
}

/** Reads one decompressed GroomAsset editor payload and encodes its renderable strands. */
export function decodeGroomPayload(payload: Uint8Array): GroomStrands {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  let at = 0;
  const need = (bytes: number, what: string): void => {
    if (!Number.isSafeInteger(bytes) || at + bytes > payload.byteLength) {
      throw invalid(`ended inside ${what}`);
    }
  };
  const int32 = (what: string): number => {
    need(4, what);
    const value = view.getInt32(at, true);
    at += 4;
    return value;
  };
  const floats = (count: number): Float32Array => {
    need(count * 4, "float data");
    const values = new Float32Array(count);
    for (let index = 0; index < count; index += 1) values[index] = view.getFloat32(at + index * 4, true);
    at += count * 4;
    return values;
  };
  const integers = (count: number): Int32Array => {
    need(count * 4, "integer data");
    const values = new Int32Array(count);
    for (let index = 0; index < count; index += 1) values[index] = view.getInt32(at + index * 4, true);
    at += count * 4;
    return values;
  };
  // An FString is a length that includes its NUL terminator.
  const name = (): string => {
    const length = int32("a name");
    if (length <= 0 || length > MAX_NAME_LENGTH) throw invalid(`names a ${length}-byte string`);
    need(length, "a name");
    let text = "";
    for (let index = 0; index < length - 1; index += 1) text += String.fromCharCode(payload[at + index] ?? 0);
    at += length;
    return text;
  };

  const vertexCount = int32("the vertex count");
  const strandCount = int32("the strand count");
  if (vertexCount < 0 || strandCount < 0) throw invalid(`declares ${vertexCount} vertices and ${strandCount} strands`);

  // The attributes this format needs, each with the one type code it may be stored as.
  const wanted = new Map<string, number>([
    ["position", VECTOR3F],
    ["groom_width", FLOAT],
    ["vertexcount", INT32],
    ["groom_guide", INT32],
    ["groom_group_id", INT32],
    ["groom_curve_type", INT32],
  ]);
  const attributes = new Map<string, Float32Array | Int32Array>();
  /** Curve type is stored as a name list by some engine versions, as an int32 enum by others. */
  const curveTypeNames: string[] = [];
  for (const set of ["vertex", "strand", "groom"]) {
    const elements = int32(`the ${set} element count`);
    const attributeCount = int32(`the ${set} attribute count`);
    if (elements < 0 || elements > MAX_ELEMENTS) throw invalid(`declares ${elements} ${set} elements`);
    if (attributeCount < 0 || attributeCount > MAX_ATTRIBUTES) {
      throw invalid(`declares ${attributeCount} ${set} attributes`);
    }
    for (let attribute = 0; attribute < attributeCount; attribute += 1) {
      const attributeName = name().trim().toLowerCase();
      const kind = int32(`the type of ${attributeName}`);
      if (kind < 0 || kind > NAME) throw invalid(`stores ${attributeName} in unknown attribute encoding ${kind}`);
      int32(`the allocator of ${attributeName}`);
      int32(`the flags of ${attributeName}`);
      const channels = int32(`the channel count of ${attributeName}`);
      if (channels < 0 || channels > MAX_CHANNELS) throw invalid(`gives ${attributeName} ${channels} channels`);
      const expectedKind = wanted.get(attributeName);
      for (let channel = 0; channel < channels; channel += 1) {
        int32(`the extent of ${attributeName}`);
        if (kind === NAME) {
          const nameCount = int32(`the name count of ${attributeName}`);
          if (nameCount < 0 || nameCount > 1_000_000) throw invalid(`stores ${nameCount} names for ${attributeName}`);
          for (let entry = 0; entry < nameCount; entry += 1) {
            const text = name();
            if (attributeName === "groom_curve_type") curveTypeNames.push(text);
          }
          continue;
        }
        const elementSize = int32(`the element size of ${attributeName}`);
        const count = int32(`the element count of ${attributeName}`);
        if (elementSize < 0 || count < 0) throw invalid(`stores a negative ${attributeName} array`);
        if (kind !== expectedKind) {
          need(elementSize * count, `the unread ${attributeName} array`);
          at += elementSize * count;
          continue;
        }
        if (attributes.has(attributeName)) {
          throw invalid(`spreads ${attributeName} over more than one channel, which this reader cannot reassemble`);
        }
        if (kind === VECTOR3F) attributes.set(attributeName, floats(count * 3));
        else if (kind === FLOAT) attributes.set(attributeName, floats(count));
        else attributes.set(attributeName, integers(count));
      }
      if (kind === NAME) name();
      else {
        const defaultBytes = DEFAULT_VALUE_BYTES[kind] ?? 0;
        need(defaultBytes, `the default value of ${attributeName}`);
        at += defaultBytes;
      }
      int32(`the attribute flags of ${attributeName}`);
    }
  }
  if (at !== payload.byteLength) {
    throw invalid(`was not fully consumed (${at} of ${payload.byteLength} bytes read)`);
  }

  const positions = attributes.get("position") as Float32Array | undefined;
  const widths = attributes.get("groom_width") as Float32Array | undefined;
  const pointsPerStrand = attributes.get("vertexcount") as Int32Array | undefined;
  if (!positions || !widths || !pointsPerStrand) {
    throw invalid(`carries no ${["position", "groom_width", "vertexcount"].filter((key) => !attributes.has(key)).join(", ")}`);
  }
  if (pointsPerStrand.length !== strandCount) {
    throw invalid(`lists ${pointsPerStrand.length} strands where it declares ${strandCount}`);
  }
  if (positions.length !== vertexCount * 3) {
    throw invalid(`holds ${positions.length / 3} positions where it declares ${vertexCount} vertices`);
  }
  if (widths.length !== vertexCount) throw invalid(`holds ${widths.length} widths for ${vertexCount} vertices`);
  const guides = perStrand(attributes, "groom_guide", strandCount);
  const groups = perStrand(attributes, "groom_group_id", strandCount);
  const curveTypes = perStrand(attributes, "groom_curve_type", strandCount);
  if (curveTypeNames.length > 0) {
    if (curveTypeNames.length !== strandCount) {
      throw invalid(`names ${curveTypeNames.length} curve types for ${strandCount} strands`);
    }
    const curved = [...new Set(curveTypeNames.filter((curve) => curve.toLowerCase() !== "linear"))];
    if (curved.length > 0) throw unsupported(`uses strand curve type ${curved.join(", ")}; only linear is decoded`);
  } else if (curveTypes) {
    const kinds = [...new Set(curveTypes)].filter((kind) => kind !== 0);
    if (kinds.length > 0) throw unsupported(`uses strand curve type ${kinds.join(", ")}; only linear is decoded`);
  }
  if (groups) {
    const distinct = [...new Set(groups)];
    if (distinct.length > 1) throw unsupported(`splits its strands into groups ${distinct.join(", ")}`);
  }
  let declared = 0;
  for (let strand = 0; strand < strandCount; strand += 1) {
    const count = pointsPerStrand[strand] ?? 0;
    if (count <= 0) throw invalid(`gives strand ${strand} ${count} points`);
    declared += count;
  }
  if (declared !== vertexCount) {
    throw invalid(`holds ${declared} points across its strands where it declares ${vertexCount} vertices`);
  }
  const kept: number[] = [];
  for (let strand = 0; strand < strandCount; strand += 1) {
    if (!guides || guides[strand] === 0) kept.push(strand);
  }
  if (kept.length === 0) throw invalid("holds only guide strands, so there is nothing to draw");
  const points = kept.reduce((total, strand) => total + (pointsPerStrand[strand] ?? 0), 0);
  const excludedGuides = strandCount - kept.length;
  const binary = Buffer.allocUnsafe(8 + kept.length * 4 + points * 16);
  binary.writeUInt32LE(kept.length, 0);
  binary.writeUInt32LE(points, 4);
  const bounds = { min: [Infinity, Infinity, Infinity] as [number, number, number], max: [-Infinity, -Infinity, -Infinity] as [number, number, number] };
  const widthRange = { min: Infinity, max: -Infinity };
  let cursor = 8;
  for (const strand of kept) {
    binary.writeUInt32LE(pointsPerStrand[strand] ?? 0, cursor);
    cursor += 4;
  }
  // Every point is checked before anything is written, so a refusal cannot leave a partial file.
  for (let index = 0; index < vertexCount; index += 1) {
    if (
      !Number.isFinite(positions[index * 3] ?? Number.NaN) ||
      !Number.isFinite(positions[index * 3 + 1] ?? Number.NaN) ||
      !Number.isFinite(positions[index * 3 + 2] ?? Number.NaN) ||
      !Number.isFinite(widths[index] ?? Number.NaN)
    ) {
      throw invalid(`holds a non-finite position or width at point ${index}`);
    }
  }
  /** Walks the renderable points, in order, by their index in the payload's whole vertex array: a
   * guide strand's points still occupy their slots, so skipping one shifts everything after it. */
  const eachPoint = (visit: (point: number) => void): void => {
    let point = 0;
    for (let strand = 0; strand < strandCount; strand += 1) {
      const count = pointsPerStrand[strand] ?? 0;
      for (let index = 0; index < count; index += 1, point += 1) {
        if (!guides || guides[strand] === 0) visit(point);
      }
    }
  };
  eachPoint((point) => {
    for (const [axis, value] of ([
      positions[point * 3],
      positions[point * 3 + 2],
      positions[point * 3 + 1],
    ] as const).entries()) {
      const metres = Math.fround((value ?? Number.NaN) * CENTIMETRES_TO_METRES);
      binary.writeFloatLE(metres, cursor);
      cursor += 4;
      bounds.min[axis] = Math.min(bounds.min[axis] as number, metres);
      bounds.max[axis] = Math.max(bounds.max[axis] as number, metres);
    }
  });
  eachPoint((point) => {
    const metres = Math.fround((widths[point] ?? Number.NaN) * CENTIMETRES_TO_METRES);
    binary.writeFloatLE(metres, cursor);
    cursor += 4;
    widthRange.min = Math.min(widthRange.min, metres);
    widthRange.max = Math.max(widthRange.max, metres);
  });
  return {
    strandCount: kept.length,
    pointCount: points,
    excludedGuides,
    bounds,
    widthRange,
    binary,
  };
}

/** The per-strand attribute a hair description may omit, but never store at a different length. */
function perStrand(
  attributes: ReadonlyMap<string, Float32Array | Int32Array>,
  key: string,
  strandCount: number,
): Int32Array | undefined {
  const values = attributes.get(key) as Int32Array | undefined;
  if (!values) return undefined;
  if (values.length !== strandCount) {
    throw invalid(`stores ${values.length} ${key} values for ${strandCount} strands`);
  }
  return values;
}

export function groomSidecar(strands: GroomStrands, source: string): GroomSidecar {
  return {
    strandCount: strands.strandCount,
    pointCount: strands.pointCount,
    bounds: strands.bounds,
    widthRange: strands.widthRange,
    units: "m",
    excludedGuides: strands.excludedGuides,
    source,
  };
}
