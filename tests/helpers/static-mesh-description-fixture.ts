function fstring(text: string): Buffer {
  const bytes = Buffer.from(`${text}\0`, "latin1");
  const length = Buffer.alloc(4);
  length.writeInt32LE(bytes.length);
  return Buffer.concat([length, bytes]);
}
function int32(...values: number[]): Buffer {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => buffer.writeInt32LE(value, index * 4));
  return buffer;
}
function floats(values: readonly number[]): Buffer {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  return buffer;
}

type Attribute =
  | { name: string; kind: 0 | 1 | 2 | 3 | 4; extent: number; elementSize: number; data: Buffer }
  | { name: string; kind: 6; names: readonly string[] };

function element(name: string, count: number, attributes: readonly Attribute[], compactNames: boolean): Buffer {
  const words = Math.ceil(count / 32);
  const bits = Buffer.alloc(words * 4);
  for (let index = 0; index < count; index++) bits.writeUInt32LE((bits.readUInt32LE((index >> 5) * 4) | (1 << (index & 31))) >>> 0, (index >> 5) * 4);
  const parts: Buffer[] = [fstring(name), int32(1), int32(count), bits, int32(0, count, attributes.length)];
  const defaults: Record<number, number> = { 0: 16, 1: 12, 2: 8, 3: 4, 4: 4 };
  for (const attribute of attributes) {
    parts.push(fstring(attribute.name), int32(attribute.kind, 1, count, 1));
    if (attribute.kind === 6) {
      parts.push(int32(1, attribute.names.length));
      if (compactNames) {
        const distinct = [...new Set(attribute.names)];
        parts.push(int32(distinct.length), ...distinct.map(fstring));
      } else parts.push(...attribute.names.map(fstring));
      parts.push(fstring("None"), int32(32));
    } else {
      parts.push(int32(attribute.extent, attribute.elementSize, attribute.data.length / attribute.elementSize), attribute.data);
      parts.push(Buffer.alloc(defaults[attribute.kind]!), int32(0));
    }
  }
  return Buffer.concat(parts);
}

export function meshDescription(slotNames: readonly string[], compactNames: boolean, colors?: readonly number[], vertexIndices: readonly number[] = [0, 1, 2]): Buffer {
  const vertexInstances: Attribute[] = [
    { name: "VertexIndex", kind: 4, extent: 1, elementSize: 4, data: int32(...vertexIndices) },
    { name: "Normal", kind: 1, extent: 1, elementSize: 12, data: floats([0, 0, 1, 0, 0, 1, 0, 0, 1]) },
    { name: "TextureCoordinate", kind: 2, extent: 1, elementSize: 8, data: floats([0, 0, 1, 0, 0, 1]) },
    // MeshAttribute::VertexInstance::Color is an FVector4f (attribute kind 0, 16 bytes); it is optional, so
    // it only appears when the package carried one.
    ...(colors ? [{ name: "Color", kind: 0 as const, extent: 1, elementSize: 16, data: floats(colors) }] : []),
  ];
  return Buffer.concat([
    int32(5),
    element("Vertices", 3, [{ name: "Position ", kind: 1, extent: 1, elementSize: 12, data: floats([0, 0, 0, 100, 0, 0, 0, 100, 0]) }], compactNames),
    element("VertexInstances", 3, vertexInstances, compactNames),
    element(
      "Triangles",
      1,
      [
        { name: "VertexInstanceIndex", kind: 4, extent: 3, elementSize: 4, data: int32(0, 1, 2) },
        { name: "PolygonGroupIndex", kind: 4, extent: 1, elementSize: 4, data: int32(0) },
      ],
      compactNames,
    ),
    // An "ObjectName" per triangle corner, all the same: the compact layout stores it once.
    element("Polygons", 3, [{ name: "ObjectName", kind: 6, names: ["piece", "piece", "piece"] }], compactNames),
    element("PolygonGroups", slotNames.length, [{ name: "ImportedMaterialSlotName", kind: 6, names: slotNames }], compactNames),
  ]);
}

