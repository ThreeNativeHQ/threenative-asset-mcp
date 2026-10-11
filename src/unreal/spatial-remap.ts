import { createHash } from "node:crypto";

// T2A corner-remap verifier (layout only). Proves that a remapped triangle mesh carries the source's corners: every
// source face exactly once, each output face's corners in the source's cyclic order, and every original attribute
// byte-identical per corner. It reads no export and admits no source route; that is T1's attested receipt, not this
// module. The new atlas UV is not an original attribute, so it is never part of these snapshots (see spatial-atlas.ts).
// Every input is validated and copied before it decides anything. Fingerprints hash host-order bytes (little-endian on
// every supported host). A caller that omits an attribute from both snapshots is not detectable here: generators must
// pass the complete original attribute dictionary.

/** glTF-style component types. The data array must be the matching typed array. */
export type SpatialComponentType = "int8" | "uint8" | "int16" | "uint16" | "uint32" | "float32";

export type SpatialAttributeData = Int8Array | Uint8Array | Int16Array | Uint16Array | Uint32Array | Float32Array;

/** One original attribute: packed data (length = vertexCount * itemSize) and its representation. */
export interface SpatialAttributeSnapshot {
  readonly componentType: SpatialComponentType;
  readonly itemSize: number;
  readonly normalized: boolean;
  readonly data: SpatialAttributeData;
}

/** A whole mesh: the complete original attribute dictionary plus the triangle list. */
export interface SpatialMeshSnapshot {
  readonly vertexCount: number;
  readonly attributes: ReadonlyMap<string, SpatialAttributeSnapshot>;
  readonly indices: ArrayLike<number>;
}

/** A refusal carries a stable name and a human detail. Results are data; nothing here throws for bad input. */
export interface NamedRefusal<Name extends string> {
  readonly kind: "refused";
  readonly name: Name;
  readonly detail: string;
}

export type CornerRemapRefusal =
  | "malformed-snapshot"
  | "malformed-indices"
  | "index-out-of-range"
  | "empty-mesh"
  | "attribute-set-mismatch"
  | "attribute-representation-mismatch"
  | "face-map-invalid"
  | "face-map-not-bijective"
  | "vertex-map-invalid"
  | "corner-correspondence-mismatch"
  | "attribute-bytes-mismatch";

/** Issued only by verifyCornerRemap. A hand-built object with the same shape is not recognised. */
export interface VerifiedCornerRemap {
  readonly kind: "verified";
  /** SHA-256 hex over the schema, both snapshots (metadata and bytes), indices and both maps. */
  readonly fingerprint: string;
  readonly sourceVertexCount: number;
  readonly sourceFaceCount: number;
  readonly vertexCount: number;
  readonly faceCount: number;
  /** Sorted original attribute names. */
  readonly attributeNames: readonly string[];
  /** Fresh copies on every call; the verified backing arrays are never exposed. */
  indices(): Uint32Array;
  sourceFaceForOutputFace(): Uint32Array;
  sourceVertexForOutputVertex(): Uint32Array;
}

export type CornerRemapResult = VerifiedCornerRemap | NamedRefusal<CornerRemapRefusal>;

const SCHEMA = "threenative:spatial-corner-remap:v1";
const COMPONENT_BYTES: Readonly<Record<SpatialComponentType, number>> = {
  int8: 1,
  uint8: 1,
  int16: 2,
  uint16: 2,
  uint32: 4,
  float32: 4,
};

const issued = new WeakSet<object>();

/**
 * Length-prefixed SHA-256 builder. Every field carries its tag and byte length, so no two field sequences can share a
 * byte stream. Used for the remap fingerprint and for the atlas certificate fingerprint.
 */
export class SpatialDigest {
  private readonly hash = createHash("sha256");

  constructor(schema: string) {
    this.text("schema", schema);
  }

  text(tag: string, value: string): void {
    this.bytes(tag, Buffer.from(value, "utf8"));
  }

  bytes(tag: string, view: Uint8Array): void {
    const tagBytes = Buffer.from(tag, "utf8");
    this.hash.update(lengthPrefix(tagBytes.byteLength));
    this.hash.update(tagBytes);
    this.hash.update(lengthPrefix(view.byteLength));
    this.hash.update(view);
  }

  hex(): string {
    return this.hash.digest("hex");
  }
}

export function verifyCornerRemap(
  sourceSnapshot: SpatialMeshSnapshot,
  remappedSnapshot: SpatialMeshSnapshot,
  sourceFaceForOutputFace: ArrayLike<number>,
  sourceVertexForOutputVertex: ArrayLike<number>,
): CornerRemapResult {
  const source = copyMesh(sourceSnapshot, "source");
  if (source.kind === "refused") return source;
  const remapped = copyMesh(remappedSnapshot, "remapped");
  if (remapped.kind === "refused") return remapped;

  if (source.faceCount === 0 || remapped.faceCount === 0) {
    return refuse("empty-mesh", "a mesh needs at least one triangle");
  }

  const names = [...source.attributes.keys()].sort();
  if (!sameNames(names, [...remapped.attributes.keys()].sort())) {
    return refuse("attribute-set-mismatch", "remapped mesh must carry exactly the source attribute names");
  }
  for (const name of names) {
    const a = source.attributes.get(name);
    const b = remapped.attributes.get(name);
    if (!a || !b) return refuse("attribute-set-mismatch", `${name} is missing`);
    if (a.componentType !== b.componentType || a.itemSize !== b.itemSize || a.normalized !== b.normalized) {
      return refuse("attribute-representation-mismatch", `${name}: componentType, itemSize or normalized differs`);
    }
  }

  if (remapped.faceCount !== source.faceCount) {
    return refuse("face-map-not-bijective", "remapped and source face counts differ");
  }
  const faceRead = readIds(sourceFaceForOutputFace, source.faceCount);
  if (!faceRead.ok || faceRead.ids.length !== remapped.faceCount) {
    return refuse("face-map-invalid", "sourceFaceForOutputFace must hold one integer source face per output face");
  }
  const faceMap = faceRead.ids;
  const seenFace = new Uint8Array(source.faceCount);
  for (const g of faceMap) {
    if (seenFace[g] === 1) return refuse("face-map-not-bijective", `source face ${g} is used more than once`);
    seenFace[g] = 1;
  }

  const vertexRead = readIds(sourceVertexForOutputVertex, source.vertexCount);
  if (!vertexRead.ok || vertexRead.ids.length !== remapped.vertexCount) {
    return refuse("vertex-map-invalid", "sourceVertexForOutputVertex must hold one integer source vertex per output vertex");
  }
  const vertexMap = vertexRead.ids;

  for (let f = 0; f < remapped.faceCount; f++) {
    const x = [0, 1, 2].map((k) => idAt(vertexMap, idAt(remapped.indices, 3 * f + k)));
    const s = [0, 1, 2].map((k) => idAt(source.indices, 3 * idAt(faceMap, f) + k));
    const rotations = [
      [s[0], s[1], s[2]],
      [s[1], s[2], s[0]],
      [s[2], s[0], s[1]],
    ];
    if (!rotations.some((r) => r[0] === x[0] && r[1] === x[1] && r[2] === x[2])) {
      return refuse("corner-correspondence-mismatch", `output face ${f} is not a cyclic rotation of its source face`);
    }
  }

  for (let v = 0; v < remapped.vertexCount; v++) {
    const from = idAt(vertexMap, v);
    for (const name of names) {
      const a = source.attributes.get(name);
      const b = remapped.attributes.get(name);
      if (!a || !b) return refuse("attribute-set-mismatch", `${name} is missing`);
      const stride = a.itemSize * COMPONENT_BYTES[a.componentType];
      if (!bytesEqual(bytesOf(a.data), from * stride, bytesOf(b.data), v * stride, stride)) {
        return refuse("attribute-bytes-mismatch", `${name} differs at output vertex ${v}`);
      }
    }
  }

  const digest = new SpatialDigest(SCHEMA);
  digestMesh(digest, "source", source);
  digestMesh(digest, "remapped", remapped);
  digest.bytes("sourceFaceForOutputFace", bytesOf(Uint32Array.from(faceMap)));
  digest.bytes("sourceVertexForOutputVertex", bytesOf(Uint32Array.from(vertexMap)));

  const indices = Uint32Array.from(remapped.indices);
  const verified: VerifiedCornerRemap = Object.freeze({
    kind: "verified" as const,
    fingerprint: digest.hex(),
    sourceVertexCount: source.vertexCount,
    sourceFaceCount: source.faceCount,
    vertexCount: remapped.vertexCount,
    faceCount: remapped.faceCount,
    attributeNames: Object.freeze(names),
    indices: () => Uint32Array.from(indices),
    sourceFaceForOutputFace: () => Uint32Array.from(faceMap),
    sourceVertexForOutputVertex: () => Uint32Array.from(vertexMap),
  });
  issued.add(verified);
  return verified;
}

export function isVerifiedCornerRemap(value: unknown): value is VerifiedCornerRemap {
  return typeof value === "object" && value !== null && issued.has(value);
}

interface CopiedAttribute {
  readonly componentType: SpatialComponentType;
  readonly itemSize: number;
  readonly normalized: boolean;
  readonly data: SpatialAttributeData;
}

interface CopiedMesh {
  readonly kind: "copied";
  readonly vertexCount: number;
  readonly faceCount: number;
  readonly attributes: ReadonlyMap<string, CopiedAttribute>;
  readonly indices: Uint32Array;
}

type IdRead = { readonly ok: true; readonly ids: number[] } | { readonly ok: false; readonly reason: "not-integer" | "out-of-range"; readonly at: number };

function refuse<Name extends CornerRemapRefusal>(name: Name, detail: string): NamedRefusal<Name> {
  return { kind: "refused", name, detail };
}

function copyMesh(mesh: SpatialMeshSnapshot, label: string): CopiedMesh | NamedRefusal<CornerRemapRefusal> {
  if (!isNonNegativeInteger(mesh.vertexCount) || mesh.vertexCount < 1) {
    return refuse("malformed-snapshot", `${label}: vertexCount must be a positive integer`);
  }
  if (typeof mesh.attributes !== "object" || mesh.attributes === null || typeof mesh.attributes.forEach !== "function") {
    return refuse("malformed-snapshot", `${label}: attributes must be a map`);
  }

  const attributes = new Map<string, CopiedAttribute>();
  for (const [name, attribute] of mesh.attributes) {
    const problem = attributeProblem(attribute, mesh.vertexCount);
    if (problem !== undefined) return refuse("malformed-snapshot", `${label} ${name}: ${problem}`);
    attributes.set(name, {
      componentType: attribute.componentType,
      itemSize: attribute.itemSize,
      normalized: attribute.normalized,
      data: copyData(attribute.data),
    });
  }

  if (!isArrayLikeObject(mesh.indices) || mesh.indices.length % 3 !== 0) {
    return refuse("malformed-indices", `${label}: indices must be whole triangles`);
  }
  const read = readIds(mesh.indices, mesh.vertexCount);
  if (!read.ok) {
    const name = read.reason === "not-integer" ? "malformed-indices" : "index-out-of-range";
    return refuse(name, `${label}: index ${read.at} is not a vertex id`);
  }
  return {
    kind: "copied",
    vertexCount: mesh.vertexCount,
    faceCount: read.ids.length / 3,
    attributes,
    indices: Uint32Array.from(read.ids),
  };
}

function attributeProblem(attribute: SpatialAttributeSnapshot, vertexCount: number): string | undefined {
  if (typeof attribute !== "object" || attribute === null) return "attribute is not an object";
  if (!Object.hasOwn(COMPONENT_BYTES, attribute.componentType)) return "unknown componentType";
  if (!Number.isSafeInteger(attribute.itemSize) || attribute.itemSize < 1 || attribute.itemSize > 4) {
    return "itemSize must be 1 to 4";
  }
  if (typeof attribute.normalized !== "boolean") return "normalized must be a boolean";
  if (!isDataFor(attribute.componentType, attribute.data)) return "data is not the typed array for componentType";
  if (attribute.data.length !== vertexCount * attribute.itemSize) return "data length is not vertexCount * itemSize";
  return undefined;
}

function isDataFor(componentType: SpatialComponentType, data: unknown): data is SpatialAttributeData {
  switch (componentType) {
    case "int8":
      return data instanceof Int8Array;
    case "uint8":
      return data instanceof Uint8Array;
    case "int16":
      return data instanceof Int16Array;
    case "uint16":
      return data instanceof Uint16Array;
    case "uint32":
      return data instanceof Uint32Array;
    case "float32":
      return data instanceof Float32Array;
    default:
      return false;
  }
}

/** Private byte-exact copy of a packed attribute: no value is re-read or rounded. */
function copyData(data: SpatialAttributeData): SpatialAttributeData {
  const copy = new Uint8Array(data.byteLength);
  copy.set(bytesOf(data));
  const buffer = copy.buffer;
  if (data instanceof Float32Array) return new Float32Array(buffer);
  if (data instanceof Uint32Array) return new Uint32Array(buffer);
  if (data instanceof Uint16Array) return new Uint16Array(buffer);
  if (data instanceof Int16Array) return new Int16Array(buffer);
  if (data instanceof Int8Array) return new Int8Array(buffer);
  return new Uint8Array(buffer);
}

/** Copies an index-like list first, then checks each entry is an integer in [0, limit). */
function readIds(values: ArrayLike<number>, limit: number): IdRead {
  if (!isArrayLikeObject(values)) return { ok: false, reason: "not-integer", at: -1 };
  const copied: unknown[] = Array.from(values);
  const ids: number[] = [];
  for (let k = 0; k < copied.length; k++) {
    const value = copied[k];
    if (typeof value !== "number" || !Number.isInteger(value)) return { ok: false, reason: "not-integer", at: k };
    if (value < 0 || value >= limit) return { ok: false, reason: "out-of-range", at: k };
    ids.push(value);
  }
  return { ok: true, ids };
}

function idAt(values: ArrayLike<number>, index: number): number {
  return values[index] ?? -1;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isArrayLikeObject(value: unknown): value is ArrayLike<number> {
  return typeof value === "object" && value !== null && isNonNegativeInteger((value as { length?: unknown }).length);
}

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, k) => name === b[k]);
}

function bytesOf(view: ArrayBufferView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function bytesEqual(a: Uint8Array, aOffset: number, b: Uint8Array, bOffset: number, length: number): boolean {
  for (let k = 0; k < length; k++) {
    if (a[aOffset + k] !== b[bOffset + k]) return false;
  }
  return true;
}

function digestMesh(digest: SpatialDigest, label: string, mesh: CopiedMesh): void {
  digest.text(`${label}.vertexCount`, String(mesh.vertexCount));
  digest.text(`${label}.faceCount`, String(mesh.faceCount));
  for (const name of [...mesh.attributes.keys()].sort()) {
    const attribute = mesh.attributes.get(name);
    if (!attribute) continue;
    digest.text(`${label}.attribute`, name);
    digest.text(`${label}.componentType`, attribute.componentType);
    digest.text(`${label}.itemSize`, String(attribute.itemSize));
    digest.text(`${label}.normalized`, String(attribute.normalized));
    digest.bytes(`${label}.data`, bytesOf(attribute.data));
  }
  digest.bytes(`${label}.indices`, bytesOf(mesh.indices));
}

function lengthPrefix(length: number): Buffer {
  const prefix = Buffer.alloc(8);
  prefix.writeBigUInt64BE(BigInt(length));
  return prefix;
}
