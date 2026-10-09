/**
 * Which material each section of an uncooked UE4 StaticMesh really uses.
 *
 * UE Viewer reads an editor-saved (uncooked) mesh from its raw source model and names a section's material by the
 * raw material index, ignoring the mesh's `SectionInfoMap`. The editor builds LOD0's sections from the sorted raw
 * indices and then applies `SectionInfoMap[(lod, section)].MaterialIndex`, so an artist who reordered the slots (leaves
 * moved to slot 2, a lod3 card material left in slot 0) gets the trunk painted with the lod3 atlas and the leaf cards
 * painted with bark. This reads the two properties that say what the editor does, straight from the package bytes:
 * `StaticMaterials` (slot -> material object name) and `SectionInfoMap` (section -> slot).
 *
 * Supported: UE4 packages before the import-table layout change of 4.22 (file version below 520), which is the
 * range UE Viewer's mesh route serves here. Anything unexpected returns undefined and the export is left untouched.
 */
import { readFile, writeFile } from "node:fs/promises";

export interface StaticMeshSections {
  /** Material object name of every `StaticMaterials` slot, undefined for an empty slot. */
  readonly slots: readonly (string | undefined)[];
  /** LOD0 section index -> slot index, from `SectionInfoMap`. */
  readonly lod0: ReadonlyMap<number, number>;
}

const UE4_IMPORT_STRIDE = 28;
const UE4_NON_OUTER_PACKAGE_IMPORT = 520;

class Reader {
  private readonly view: DataView;
  offset = 0;
  constructor(readonly bytes: Buffer, private readonly names: readonly string[] = []) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  i32(): number {
    const value = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return value;
  }
  u8(): number {
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }
  /** An FName: name-table index and instance number. */
  name(): string {
    const index = this.i32();
    this.i32();
    const text = this.names[index];
    if (text === undefined) throw new RangeError(`name index ${index} out of range`);
    return text;
  }
  at(offset: number): Reader {
    const copy = new Reader(this.bytes, this.names);
    copy.offset = offset;
    return copy;
  }
  withNames(names: readonly string[]): Reader {
    const copy = new Reader(this.bytes, names);
    copy.offset = this.offset;
    return copy;
  }
}

interface Header {
  readonly names: readonly string[];
  readonly importNames: readonly string[];
  readonly bodyStart: number;
}

function readHeader(bytes: Buffer): Header | undefined {
  const reader = new Reader(bytes);
  reader.i32(); // magic
  reader.i32(); // legacy file version
  reader.i32(); // legacy UE3 version
  const ue4 = reader.i32();
  reader.i32(); // licensee version
  if (ue4 < 504 || ue4 >= UE4_NON_OUTER_PACKAGE_IMPORT) return undefined;
  const customVersions = reader.i32();
  reader.offset += customVersions * 20;
  const totalHeaderSize = reader.i32();
  const folderLength = reader.i32();
  reader.offset += folderLength;
  reader.i32(); // package flags
  const nameCount = reader.i32();
  const nameOffset = reader.i32();
  reader.i32(); // gatherable text count
  reader.i32(); // gatherable text offset
  reader.i32(); // export count
  reader.i32(); // export offset
  const importCount = reader.i32();
  const importOffset = reader.i32();
  if (nameCount < 1 || nameCount > 1_000_000 || importCount < 0 || importCount > 1_000_000) return undefined;
  const names: string[] = [];
  const table = reader.at(nameOffset);
  for (let index = 0; index < nameCount; index += 1) {
    const length = table.i32();
    if (length <= 0 || length > 4096) return undefined; // UTF-16 names have a negative length: not handled
    names.push(bytes.toString("latin1", table.offset, table.offset + length - 1));
    table.offset += length + 4;
  }
  const importNames: string[] = [];
  for (let index = 0; index < importCount; index += 1) {
    const entry = reader.at(importOffset + index * UE4_IMPORT_STRIDE + 20);
    importNames.push(entry.withNames(names).name());
  }
  return { names, importNames, bodyStart: totalHeaderSize };
}

/** Skips the rest of a tagged property after its common header (name, type, size, array index). */
function skipTagBody(reader: Reader, type: string, size: number): void {
  if (type === "BoolProperty") {
    reader.offset += 1;
    if (reader.u8() !== 0) reader.offset += 16;
    return;
  }
  if (type === "StructProperty") reader.offset += 8 + 16;
  else if (type === "ByteProperty" || type === "EnumProperty" || type === "ArrayProperty" || type === "SetProperty") reader.offset += 8;
  else if (type === "MapProperty") reader.offset += 16;
  if (reader.u8() !== 0) reader.offset += 16;
  reader.offset += size;
}

/** Finds `name`'s tag header (name, type, size, array index 0) at or after `from`, returning its offset. */
function findTag(bytes: Buffer, names: readonly string[], name: string, type: string, from: number): number | undefined {
  const nameIndex = names.indexOf(name);
  const typeIndex = names.indexOf(type);
  if (nameIndex < 0 || typeIndex < 0) return undefined;
  const wanted = Buffer.alloc(16);
  wanted.writeInt32LE(nameIndex, 0);
  wanted.writeInt32LE(typeIndex, 8);
  for (let at = bytes.indexOf(wanted.subarray(0, 8), from); at >= 0; at = bytes.indexOf(wanted.subarray(0, 8), at + 1)) {
    if (bytes.readInt32LE(at + 8) === typeIndex && bytes.readInt32LE(at + 20) === 0) return at;
  }
  return undefined;
}

function readStaticMaterials(bytes: Buffer, header: Header): (string | undefined)[] | undefined {
  const at = findTag(bytes, header.names, "StaticMaterials", "ArrayProperty", header.bodyStart);
  if (at === undefined) return undefined;
  const reader = new Reader(bytes, header.names);
  reader.offset = at + 24; // name, type, size, array index
  if (reader.name() !== "StructProperty") return undefined;
  if (reader.u8() !== 0) reader.offset += 16;
  const count = reader.i32();
  if (count < 0 || count > 256) return undefined;
  if (count === 0) return [];
  // The element tag: name, type, size, array index, struct name, guid, has-guid.
  reader.offset += 8 + 8 + 4 + 4 + 8 + 16 + 1;
  const slots: (string | undefined)[] = [];
  for (let element = 0; element < count; element += 1) {
    let material: string | undefined;
    for (;;) {
      const property = reader.name();
      if (property === "None") break;
      const type = reader.name();
      const size = reader.i32();
      reader.i32();
      if (property === "MaterialInterface" && type === "ObjectProperty" && size === 4) {
        if (reader.u8() !== 0) reader.offset += 16;
        const reference = reader.i32();
        material = reference < 0 ? header.importNames[-reference - 1] : undefined;
      } else {
        skipTagBody(reader, type, size);
      }
    }
    slots.push(material);
  }
  return slots;
}

function readSectionInfoMap(bytes: Buffer, header: Header): Map<number, number> | undefined {
  const at = findTag(bytes, header.names, "SectionInfoMap", "StructProperty", header.bodyStart);
  if (at === undefined) return undefined;
  const reader = new Reader(bytes, header.names);
  reader.offset = at + 24;
  if (reader.name() !== "MeshSectionInfoMap") return undefined;
  reader.offset += 16;
  if (reader.u8() !== 0) reader.offset += 16;
  // Inside the struct: the tagged `Map` property whose value is a struct of tagged properties.
  if (reader.name() !== "Map") return undefined;
  if (reader.name() !== "MapProperty") return undefined;
  reader.i32();
  reader.i32();
  reader.offset += 16;
  if (reader.u8() !== 0) reader.offset += 16;
  reader.i32(); // entries to remove
  const count = reader.i32();
  if (count < 0 || count > 4096) return undefined;
  const lod0 = new Map<number, number>();
  for (let entry = 0; entry < count; entry += 1) {
    const key = reader.i32();
    let materialIndex: number | undefined;
    for (;;) {
      const property = reader.name();
      if (property === "None") break;
      const type = reader.name();
      const size = reader.i32();
      reader.i32();
      if (property === "MaterialIndex" && type === "IntProperty" && size === 4) {
        if (reader.u8() !== 0) reader.offset += 16;
        materialIndex = reader.i32();
      } else {
        skipTagBody(reader, type, size);
      }
    }
    if (materialIndex !== undefined && key >> 16 === 0) lod0.set(key & 0xffff, materialIndex);
  }
  return lod0;
}

/** Reads the slot materials and LOD0 section map of an uncooked UE4 StaticMesh package; undefined when it cannot. */
export function parseStaticMeshSections(bytes: Buffer): StaticMeshSections | undefined {
  try {
    const header = readHeader(bytes);
    if (!header) return undefined;
    const slots = readStaticMaterials(bytes, header);
    const lod0 = readSectionInfoMap(bytes, header);
    if (!slots || !lod0 || lod0.size === 0) return undefined;
    return { slots, lod0 };
  } catch {
    return undefined;
  }
}

interface GltfPrimitive {
  material?: number;
}
interface GltfJson {
  materials?: { name?: string }[];
  meshes?: { primitives?: GltfPrimitive[] }[];
}

/**
 * Points each primitive of a UE Viewer glTF at the material its section really uses. The exported primitives are the
 * LOD0 sections in order, each named for its raw slot; section `i` belongs to slot `lod0.get(i)`. Returns the number of
 * primitives whose material changed. A glTF that does not look like that (a different primitive count, a material
 * that is not the one a raw slot would give, raw slots out of order) is left alone and reports 0.
 */
export function remapGltfSectionMaterials(gltf: GltfJson, sections: StaticMeshSections): number {
  const primitives = (gltf.meshes ?? []).flatMap((mesh) => mesh.primitives ?? []);
  const materials = gltf.materials ?? [];
  if (primitives.length === 0 || primitives.length !== sections.lod0.size) return 0;
  const used = new Set<number>();
  let previousRaw = -1;
  const targets: string[] = [];
  for (const [section, primitive] of primitives.entries()) {
    const current = primitive.material === undefined ? undefined : materials[primitive.material]?.name;
    const raw = sections.slots.findIndex((slot, index) => slot !== undefined && slot === current && !used.has(index));
    const slot = sections.lod0.get(section);
    const target = slot === undefined ? undefined : sections.slots[slot];
    if (raw < 0 || raw <= previousRaw || target === undefined) return 0;
    used.add(raw);
    previousRaw = raw;
    targets.push(target);
  }
  if (targets.every((target, section) => target === materials[primitives[section]!.material!]?.name)) return 0;
  const rebuilt: { name?: string }[] = [];
  let changed = 0;
  for (const [section, primitive] of primitives.entries()) {
    const target = targets[section]!;
    const original = materials[primitive.material!]!;
    let index = rebuilt.findIndex((material) => material.name === target);
    if (index < 0) {
      index = rebuilt.length;
      rebuilt.push({ ...original, name: target });
    }
    if (original.name !== target) changed += 1;
    primitive.material = index;
  }
  gltf.materials = rebuilt;
  return changed;
}

/** Applies `remapGltfSectionMaterials` to a `.gltf` file on disk, given the mesh's source `.uasset`. */
export async function remapMeshFileSectionMaterials(gltfPath: string, uassetPath: string): Promise<number> {
  let sections: StaticMeshSections | undefined;
  try {
    sections = parseStaticMeshSections(await readFile(uassetPath));
  } catch {
    return 0;
  }
  if (!sections) return 0;
  let gltf: GltfJson;
  try {
    gltf = JSON.parse(await readFile(gltfPath, "utf8")) as GltfJson;
  } catch {
    return 0;
  }
  const changed = remapGltfSectionMaterials(gltf, sections);
  if (changed > 0) await writeFile(gltfPath, JSON.stringify(gltf));
  return changed;
}
