/**
 * Sub-object ids of a Unity model. A prefab names a mesh inside an FBX by `fileID`; the model's `.meta`
 * maps the id to the object's name through `internalIDToNameTable` (Unity 2019.1+) or `fileIDToRecycleName`
 * (older). When neither lists it, Unity derives the id from the type and name.
 *
 * The table routes are documented Unity formats (tested on synthetic metas). The derived route was measured:
 * for a model whose importer has `fileIdsGeneration: 2` Unity names each sub-object by a signed 64-bit hash of
 * its class name and a stable name (PRD-620; reproduced on all 17 mesh ids of the real pack U2). The rule is
 * implemented here from that measurement; no Unity or Unidot code is copied.
 */
import { parseMeta } from "./yaml.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export type ModelIdSource = "internalIDToNameTable" | "fileIDToRecycleName";

export interface ModelObjectId {
  readonly classId: number;
  /** Decimal string: ids are 64-bit. */
  readonly fileId: string;
  readonly name: string;
  readonly via: ModelIdSource;
}

/** Every object the `.meta` names, from both tables. The 2019.1+ table comes first. */
export function readModelIdTable(metaYaml: string): ModelObjectId[] {
  const importer = parseMeta(metaYaml).ModelImporter;
  if (!isRecord(importer)) return [];
  const found: ModelObjectId[] = [];
  if (Array.isArray(importer.internalIDToNameTable)) {
    for (const item of importer.internalIDToNameTable) {
      if (!isRecord(item) || !isRecord(item.first) || typeof item.second !== "string") continue;
      for (const [classId, fileId] of Object.entries(item.first)) {
        found.push({ classId: Number(classId), fileId: String(fileId), name: item.second, via: "internalIDToNameTable" });
      }
    }
  }
  if (isRecord(importer.fileIDToRecycleName)) {
    for (const [fileId, name] of Object.entries(importer.fileIDToRecycleName)) {
      if (typeof name !== "string") continue;
      // A recycle id is `classId * 100000 + n`: 4300000 is the first Mesh.
      found.push({ classId: Math.floor(Number(fileId) / 100_000), fileId, name, via: "fileIDToRecycleName" });
    }
  }
  return found;
}

/** The name the `.meta` gives mesh `fileId`, or undefined when no table lists it. */
export function meshNameFromMeta(metaYaml: string, fileId: string): { name: string; via: ModelIdSource } | undefined {
  const hit = readModelIdTable(metaYaml).find((item) => item.fileId === fileId && item.classId === 43);
  return hit ? { name: hit.name, via: hit.via } : undefined;
}

/** First id of `classId` in the tables (the model's root GameObject is class 1, its Transform class 4). */
export function firstModelId(metaYaml: string, classId: number): string | undefined {
  const ids = readModelIdTable(metaYaml).filter((item) => item.classId === classId).map((item) => BigInt(item.fileId));
  if (ids.length === 0) return undefined;
  return ids.reduce((low, id) => (id < low ? id : low)).toString();
}

// ---------------------------------------------------------------- derived ids

const MASK = (1n << 64n) - 1n;
const PRIME1 = 0x9e3779b185ebca87n;
const PRIME2 = 0xc2b2ae3d27d4eb4fn;
const PRIME3 = 0x165667b19e3779f9n;
const PRIME4 = 0x85ebca77c2b2ae63n;
const PRIME5 = 0x27d4eb2f165667c5n;
const rotl = (value: bigint, bits: bigint): bigint => ((value << bits) | (value >> (64n - bits))) & MASK;
const round = (acc: bigint, input: bigint): bigint => (rotl((acc + input * PRIME2) & MASK, 31n) * PRIME1) & MASK;
const merge = (acc: bigint, value: bigint): bigint => (((acc ^ round(0n, value)) * PRIME1) + PRIME4) & MASK;

/** XXH64 (seed 0 unless given), the hash Unity's importers use for sub-object ids. Returns the unsigned 64-bit value. */
export function xxh64(input: Uint8Array, seed = 0n): bigint {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const length = input.length;
  let offset = 0;
  let hash: bigint;
  if (length >= 32) {
    let v1 = (seed + PRIME1 + PRIME2) & MASK;
    let v2 = (seed + PRIME2) & MASK;
    let v3 = seed;
    let v4 = (seed - PRIME1) & MASK;
    for (; offset <= length - 32; offset += 32) {
      v1 = round(v1, view.getBigUint64(offset, true));
      v2 = round(v2, view.getBigUint64(offset + 8, true));
      v3 = round(v3, view.getBigUint64(offset + 16, true));
      v4 = round(v4, view.getBigUint64(offset + 24, true));
    }
    hash = (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & MASK;
    for (const lane of [v1, v2, v3, v4]) hash = merge(hash, lane);
  } else {
    hash = (seed + PRIME5) & MASK;
  }
  hash = (hash + BigInt(length)) & MASK;
  for (; offset + 8 <= length; offset += 8) hash = ((rotl(hash ^ round(0n, view.getBigUint64(offset, true)), 27n) * PRIME1) + PRIME4) & MASK;
  if (offset + 4 <= length) {
    hash = ((rotl(hash ^ ((BigInt(view.getUint32(offset, true)) * PRIME1) & MASK), 23n) * PRIME2) + PRIME3) & MASK;
    offset += 4;
  }
  for (; offset < length; offset += 1) hash = (rotl(hash ^ ((BigInt(input[offset]!) * PRIME5) & MASK), 11n) * PRIME1) & MASK;
  hash = ((hash ^ (hash >> 33n)) * PRIME2) & MASK;
  hash = ((hash ^ (hash >> 29n)) * PRIME3) & MASK;
  return hash ^ (hash >> 32n);
}

/**
 * The id Unity gives a generated sub-object of a model when no table lists it: the signed 64-bit XXH64 (seed 0) of
 * `Type:<class>-><name><n>`, where `n` is 0 and counts up while an earlier object of the model already has the id.
 * Measured on the real pack U2 (Unity 6, `fileIdsGeneration: 2`): meshes use the sanitized mesh name; the root
 * GameObject uses `//RootNode/root` and its Transform `//RootNode/root/Transform` (a child GameObject would add
 * `/<name>`, a component `/<class>` to its parent's path; only the root is verified).
 * Control characters and invalid UTF-8 in a name become `_` before hashing (not reproduced here: names are text).
 */
export function derivedFileId(className: string, name: string, counter = 0): string {
  return BigInt.asIntN(64, xxh64(new TextEncoder().encode(`Type:${className}->${name}${counter}`))).toString();
}

/** The id of a generated Mesh sub-object named `name` (the `counter`th of that name in the model). */
export function derivedMeshFileId(name: string, counter = 0): string {
  return derivedFileId("Mesh", name, counter);
}

/** `ModelImporter.meshes.fileIdsGeneration`: 2 means the sub-object ids are hash-derived (Unity 2021.2+ default). */
export function usesDerivedIds(metaYaml: string): boolean {
  const importer = parseMeta(metaYaml).ModelImporter;
  const meshes = isRecord(importer) ? importer.meshes : undefined;
  return isRecord(meshes) && Number(meshes.fileIdsGeneration) === 2;
}

/** Ids of a model's root GameObject and Transform: the tables, else the derived ids, else the legacy fixed ones. */
export function modelRootIds(metaYaml: string): { gameObject: string; transform: string } {
  const derived = usesDerivedIds(metaYaml);
  return {
    gameObject: firstModelId(metaYaml, 1) ?? (derived ? derivedFileId("GameObject", "//RootNode/root") : "100000"),
    transform: firstModelId(metaYaml, 4) ?? (derived ? derivedFileId("Transform", "//RootNode/root/Transform") : "400000"),
  };
}
