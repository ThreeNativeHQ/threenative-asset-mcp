import { readFile, stat } from "node:fs/promises";

/**
 * UE Viewer exports an uncooked UE4 StaticMesh from its source model's raw mesh, which is the geometry as it was
 * imported. Unreal multiplies it by the source model's `BuildSettings.BuildScale3D` when it builds the render data,
 * so a mesh authored at one eighth of its size and built with a scale of 8 (Paragon's SM_Agelsjon02_Cliff) leaves
 * UE Viewer's GLB eight times too small. UE Viewer does not read the `FMeshBuildSettings` struct, so the scale is
 * read here from the package's own tagged property.
 *
 * The UE4 (legacy file version -7) and UE5 (-8) header profiles are read: the MeshDescription and CUE4Parse converters
 * decode the same raw source model from editor packages, so their geometry needs the scale too. Anything else, or a
 * package without the property, returns undefined and the mesh is left as exported.
 */

const PACKAGE_TAG = 0x9e2a83c1;
const MAX_PACKAGE_BYTES = 512 * 1024 * 1024;

/** The name table of a legacy -7 (UE4) or -8 (UE5) package, or undefined when the header is neither profile. */
function readNames(bytes: Buffer): string[] | undefined {
  if (bytes.length < 32 || bytes.readUInt32LE(0) !== PACKAGE_TAG) return undefined;
  const legacy = bytes.readInt32LE(4);
  if (legacy !== -7 && legacy !== -8) return undefined;
  // Tag, legacy version, UE3 version, UE4 version, (UE5 version,) licensee version.
  let at = legacy === -8 ? 24 : 20;
  const customVersions = bytes.readInt32LE(at);
  if (customVersions < 0 || customVersions > 1000) return undefined;
  at += 4 + customVersions * 20;
  at += 4; // TotalHeaderSize
  const folder = bytes.readInt32LE(at);
  at += 4 + (folder < 0 ? -folder * 2 : folder);
  at += 4; // PackageFlags
  if (at + 8 > bytes.length) return undefined;
  const nameCount = bytes.readInt32LE(at);
  const nameOffset = bytes.readInt32LE(at + 4);
  if (nameCount < 0 || nameCount > 1_000_000 || nameOffset < 0 || nameOffset >= bytes.length) return undefined;
  const names: string[] = [];
  let cursor = nameOffset;
  for (let index = 0; index < nameCount; index += 1) {
    if (cursor + 4 > bytes.length) return undefined;
    const length = bytes.readInt32LE(cursor);
    cursor += 4;
    const size = length < 0 ? -length * 2 : length;
    if (size < 0 || cursor + size + 4 > bytes.length) return undefined;
    names.push(length < 0 ? bytes.toString("utf16le", cursor, cursor + size - 2) : bytes.toString("utf8", cursor, cursor + size - 1));
    cursor += size + 4; // string, then the two 16 bit name hashes
  }
  return names;
}

function nameBytes(index: number): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeInt32LE(index, 0);
  return buffer;
}

/**
 * `BuildScale3D` of the first source model (LOD0), in Unreal axes, or undefined. The tag is
 * `FName BuildScale3D, FName StructProperty, int32 size = 12, int32 arrayIndex, FName Vector, FGuid, bool hasGuid`,
 * followed by the three floats.
 */
export function readBuildScale3D(bytes: Buffer, body: Buffer = bytes): readonly [number, number, number] | undefined {
  const names = readNames(bytes);
  if (!names) return undefined;
  const scale = names.indexOf("BuildScale3D");
  const structProperty = names.indexOf("StructProperty");
  const vector = names.indexOf("Vector");
  if (scale < 0 || structProperty < 0 || vector < 0) return undefined;
  const head = Buffer.concat([nameBytes(scale), nameBytes(structProperty)]);
  for (let from = 0; ; ) {
    const found = body.indexOf(head, from);
    if (found < 0) return undefined;
    from = found + 1;
    let at = found + head.length;
    if (at + 8 + 8 + 16 + 1 > body.length) continue;
    // 12 bytes of floats in UE4; UE5's large-world-coordinate FVector is 24 bytes of doubles.
    const size = body.readInt32LE(at);
    if ((size !== 12 && size !== 24) || body.readInt32LE(at + 4) !== 0) continue;
    at += 8;
    if (!body.subarray(at, at + 8).equals(nameBytes(vector))) continue;
    at += 8 + 16;
    const hasGuid = body[at];
    at += 1;
    if (hasGuid === 1) at += 16;
    else if (hasGuid !== 0) continue;
    if (at + size > body.length) continue;
    const value: [number, number, number] =
      size === 24
        ? [body.readDoubleLE(at), body.readDoubleLE(at + 8), body.readDoubleLE(at + 16)]
        : [body.readFloatLE(at), body.readFloatLE(at + 4), body.readFloatLE(at + 8)];
    if (value.every((component) => Number.isFinite(component) && component > 0 && component < 1e6)) return value;
  }
}

/** Reads `file` (and its `.uexp`, where split packages keep their properties) for the mesh's BuildScale3D. */
export async function readPackageBuildScale3D(file: string): Promise<readonly [number, number, number] | undefined> {
  try {
    if ((await stat(file)).size > MAX_PACKAGE_BYTES) return undefined;
    const bytes = await readFile(file);
    const inline = readBuildScale3D(bytes);
    if (inline) return inline;
    const exports = file.replace(/\.uasset$/i, ".uexp");
    if (exports === file) return undefined;
    const split = await readFile(exports).catch(() => undefined);
    return split ? readBuildScale3D(bytes, split) : undefined;
  } catch {
    return undefined;
  }
}
