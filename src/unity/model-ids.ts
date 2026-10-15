/**
 * Sub-object ids of a Unity model. A prefab names a mesh inside an FBX by `fileID`; the model's `.meta`
 * maps the id to the object's name through `internalIDToNameTable` (Unity 2019.1+) or `fileIDToRecycleName`
 * (older). When neither lists it, Unity derives the id from the type and name.
 *
 * The lookup order and the derived-id route follow V-Sekai/unidot_importer (MIT, Copyright (c) V-Sekai
 * contributors) `object_adapter.gd` and `asset_database.gd`, re-written here from memory of the format.
 * No Unidot code is copied. UNVERIFIED: the table routes are documented Unity formats and tested on
 * synthetic metas, but the derived-id string layout below is recalled, not checked against a real pack.
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

// ---------------------------------------------------------------- MD4 (RFC 1320)

/** MD4 is not in Node's default OpenSSL 3 provider, and the derived id needs it. */
export function md4(input: Uint8Array): Uint8Array {
  const length = input.length;
  const padded = new Uint8Array((((length + 8) >> 6) + 1) << 6);
  padded.set(input);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, (length << 3) >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(length / 0x20000000), true);
  let a = 0x67452301;
  let b = 0xefcdab89 | 0;
  let c = 0x98badcfe | 0;
  let d = 0x10325476;
  const rotl = (x: number, n: number): number => (x << n) | (x >>> (32 - n));
  const f = (x: number, y: number, z: number): number => (x & y) | (~x & z);
  const g = (x: number, y: number, z: number): number => (x & y) | (x & z) | (y & z);
  const h = (x: number, y: number, z: number): number => x ^ y ^ z;
  for (let offset = 0; offset < padded.length; offset += 64) {
    const x = Array.from({ length: 16 }, (_, index) => view.getUint32(offset + index * 4, true) | 0);
    const [sa, sb, sc, sd] = [a, b, c, d];
    const round1 = [3, 7, 11, 19];
    for (let i = 0; i < 16; i += 1) {
      const t = (a + f(b, c, d) + x[i]!) | 0;
      a = d; d = c; c = b; b = rotl(t, round1[i % 4]!);
    }
    const round2 = [3, 5, 9, 13];
    for (let i = 0; i < 16; i += 1) {
      const k = (i % 4) * 4 + Math.floor(i / 4);
      const t = (a + g(b, c, d) + x[k]! + 0x5a827999) | 0;
      a = d; d = c; c = b; b = rotl(t, round2[i % 4]!);
    }
    const round3 = [3, 9, 11, 15];
    const order = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15];
    for (let i = 0; i < 16; i += 1) {
      const t = (a + h(b, c, d) + x[order[i]!]! + 0x6ed9eba1) | 0;
      a = d; d = c; c = b; b = rotl(t, round3[i % 4]!);
    }
    a = (a + sa) | 0; b = (b + sb) | 0; c = (c + sc) | 0; d = (d + sd) | 0;
  }
  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  [a, b, c, d].forEach((word, index) => outView.setInt32(index * 4, word, true));
  return out;
}

/**
 * The id Unity derives for a generated Mesh sub-object with no table entry: the first 8 bytes of the MD4 of
 * `Type:Mesh->{name}->0`, read as a little-endian signed 64-bit integer. UNVERIFIED against a real pack.
 */
export function derivedMeshFileId(name: string): string {
  const digest = md4(new TextEncoder().encode(`Type:Mesh->${name}->0`));
  return new DataView(digest.buffer).getBigInt64(0, true).toString();
}
