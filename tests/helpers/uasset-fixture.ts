import { writeFile } from "node:fs/promises";

/**
 * The bytes of a minimal uncooked UE4.18 StaticMesh package: the header (names, imports) and the two tagged
 * properties the importer reads, `StaticMaterials` and `SectionInfoMap`. No mesh data: only enough for
 * `parseStaticMeshSections`. The layout is the one a real 4.18 package has (checked against an editor-saved mesh).
 */
export interface StaticMeshUassetOptions {
  /** Material object name per slot. */
  readonly slots: readonly string[];
  /** `[lod, section, slot]` entries of `SectionInfoMap`. */
  readonly sectionMap: readonly (readonly [number, number, number])[];
}

export function staticMeshUasset(options: StaticMeshUassetOptions): Buffer {
  const names: string[] = [];
  const nameIndex = (name: string): number => {
    const found = names.indexOf(name);
    if (found >= 0) return found;
    names.push(name);
    return names.length - 1;
  };
  const i32 = (value: number): Buffer => {
    const out = Buffer.alloc(4);
    out.writeInt32LE(value);
    return out;
  };
  const fname = (name: string): Buffer => Buffer.concat([i32(nameIndex(name)), i32(0)]);
  const tag = (name: string, type: string, size: number): Buffer => Buffer.concat([fname(name), fname(type), i32(size), i32(0)]);
  const guid = Buffer.alloc(16);

  // Slot materials are imports; import 0 stands for the mesh class, so slots start at 1.
  const importNames = ["StaticMesh", ...options.slots];
  const element = (slot: string, index: number): Buffer =>
    Buffer.concat([
      tag("MaterialInterface", "ObjectProperty", 4),
      Buffer.from([0]),
      i32(-(index + 2)),
      tag("MaterialSlotName", "NameProperty", 8),
      Buffer.from([0]),
      fname(`Slot${index}_${slot}`),
      fname("None"),
    ]);
  const materialsBody = Buffer.concat([i32(options.slots.length), tag("StaticMaterials", "StructProperty", 0), fname("StaticMaterial"), guid, Buffer.from([0]), ...options.slots.map(element)]);
  const staticMaterials = Buffer.concat([tag("StaticMaterials", "ArrayProperty", materialsBody.length), fname("StructProperty"), Buffer.from([0]), materialsBody]);

  const entry = (key: number, slot: number): Buffer =>
    Buffer.concat([
      i32(key),
      tag("MaterialIndex", "IntProperty", 4),
      Buffer.from([0]),
      i32(slot),
      tag("bEnableCollision", "BoolProperty", 0),
      Buffer.from([1, 0]),
      tag("bCastShadow", "BoolProperty", 0),
      Buffer.from([1, 0]),
      fname("None"),
    ]);
  const mapBody = Buffer.concat([i32(0), i32(options.sectionMap.length), ...options.sectionMap.map(([lod, section, slot]) => entry((lod << 16) | section, slot))]);
  const mapProperty = Buffer.concat([tag("Map", "MapProperty", mapBody.length), fname("IntProperty"), fname("StructProperty"), Buffer.from([0]), mapBody]);
  const sectionInfoBody = Buffer.concat([mapProperty, fname("None")]);
  const sectionInfoMap = Buffer.concat([tag("SectionInfoMap", "StructProperty", sectionInfoBody.length), fname("MeshSectionInfoMap"), guid, Buffer.from([0]), sectionInfoBody]);
  const body = Buffer.concat([staticMaterials, sectionInfoMap, fname("None")]);

  const imports = Buffer.concat(importNames.map((name) => Buffer.concat([fname("/Script/Engine"), fname("Class"), i32(0), fname(name)])));
  // Header: magic, legacy -7, UE3 0, UE4 514, licensee 0, no custom versions, total size, folder "None", flags,
  // name count/offset, gatherable text count/offset, export count/offset, import count/offset.
  const folder = Buffer.concat([i32(5), Buffer.from("None\0", "latin1")]);
  const fixed = 4 * 6 + 4 + folder.length + 4 + 4 * 8;
  const nameTable = (): Buffer =>
    Buffer.concat(names.map((name) => Buffer.concat([i32(name.length + 1), Buffer.from(`${name}\0`, "latin1"), Buffer.alloc(4)])));
  // Names are final once every tag is built; the header needs their table size, so build it now.
  const table = nameTable();
  const nameOffset = fixed;
  const importOffset = nameOffset + table.length;
  const totalHeaderSize = importOffset + imports.length;
  const header = Buffer.concat([
    i32(-1641380927),
    i32(-7),
    i32(0),
    i32(514),
    i32(0),
    i32(0),
    i32(totalHeaderSize),
    folder,
    i32(0),
    i32(names.length),
    i32(nameOffset),
    i32(0),
    i32(importOffset),
    i32(0),
    i32(totalHeaderSize),
    i32(importNames.length),
    i32(importOffset),
  ]);
  if (header.length !== fixed) throw new Error(`header is ${header.length} bytes, expected ${fixed}`);
  return Buffer.concat([header, table, imports, body]);
}

export async function writeStaticMeshUasset(path: string, options: StaticMeshUassetOptions): Promise<void> {
  await writeFile(path, staticMeshUasset(options));
}
