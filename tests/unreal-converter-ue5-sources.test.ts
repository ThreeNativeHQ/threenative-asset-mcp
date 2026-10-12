import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeIO, type Accessor, type Primitive } from "@gltf-transform/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CUE4PARSE_PATCH, CUE4PARSE_PROGRAM } from "../src/unreal/cue4parse-adapter.js";
import { assembleSceneGlb, parseUnrealSceneSource } from "../src/unreal/scenes.js";
import { modernSdkExecutable, toolchainCacheDir } from "../src/unreal/provision.js";
import { describeWithTools } from "./helpers/require-tool.js";

// Three UE5 editor-package layouts the modern converter did not read (converter 61):
//  - TSCF_UEDELTA texture sources (UE 5.6+ default): raw pixels, row-delta filtered per tile. No PNG or
//    JPEG is inside, so every colour texture of a 5.6+ pack was dropped and its sections went neutral.
//  - The UE 5.8 compact FName array in an FMeshDescription: the static mesh had no readable source model.
//  - A UE4-saved MaterialInstanceConstant inside a UE5 artifact: CUE4Parse throws before filling the typed
//    TextureParameterValues, so the instance exported no textures although its tagged properties hold them.
//  - UE5 LandscapeComponent source art: serialized proxy components now become the same height/normal arrays
//    consumed by the public scene contract, including the subsection edge mapping and component transform.
// The decoders are pure functions in the embedded program. They are compiled on their own, against the .NET 10
// SDK and SharpGLTF assemblies of the `modern-converter` test prerequisite, and run against synthetic data
// encoded here from Unreal's documented tile rules. Without them the compiled suite skips locally and fails under CI=true.

/** Extracts one top-level C# declaration (signature line through its matching brace) from the program. */
function extractCSharp(program: string, signature: string): string {
  const start = program.indexOf(signature);
  if (start < 0) throw new Error(`converter program has no ${signature}`);
  let depth = 0;
  let opened = false;
  for (let index = start; index < program.length; index++) {
    const char = program[index]!;
    // Comments first: an apostrophe in prose ("Unreal's") is not a char literal, and would hide the braces after it.
    if (char === "/" && program[index + 1] === "/") {
      index = program.indexOf("\n", index);
      if (index < 0) break;
      continue;
    }
    if (char === "/" && program[index + 1] === "*") {
      const close = program.indexOf("*/", index + 2);
      if (close < 0) break;
      index = close + 1;
      continue;
    }
    if (char === '"') {
      // Skip a string literal (verbatim strings are not used in these functions).
      for (index++; index < program.length && program[index] !== '"'; index++) if (program[index] === "\\") index++;
      continue;
    }
    if (char === "'") {
      for (index++; index < program.length && program[index] !== "'"; index++) if (program[index] === "\\") index++;
      continue;
    }
    if (char === "{") {
      depth++;
      opened = true;
    } else if (char === "}") {
      depth--;
      if (opened && depth === 0) {
        // An expression-bodied member (`=> x switch { ... };`) ends at the semicolon after the brace.
        const rest = /^\s*;/.exec(program.slice(index + 1));
        return program.slice(start, index + 1 + (rest ? rest[0].length : 0));
      }
    }
  }
  throw new Error(`unbalanced braces after ${signature}`);
}

// ---------------------------------------------------------------------------------------------------------
// TSCF_UEDELTA forward transform (Unreal's ImageCoreDelta tile rules), written independently of the C#.

interface Tile {
  readonly x: number;
  readonly width: number;
  readonly y: number;
  readonly height: number;
}

function deltaTiles(width: number, height: number, bytesPerPixel: number): Tile[] {
  if (width * height <= 136 * 136) return [{ x: 0, width, y: 0, height }];
  const rowsPerCut = (sizeX: number, sizeY: number): number => {
    let cuts = 1;
    if (sizeX * sizeY > 32768) {
      cuts = Math.floor((sizeX * sizeY) / 32768);
      while (cuts > 512) cuts >>= 1;
    }
    return Math.ceil(sizeY / cuts);
  };
  let partPixels = width;
  const stride = width * bytesPerPixel;
  if (stride > 4096) {
    const parts = Math.ceil(stride / 4096);
    let partBytes = Math.floor((stride + Math.floor(parts / 2)) / parts);
    partBytes = (partBytes + 63) & ~63;
    partPixels = partBytes / bytesPerPixel;
  }
  const tiles: Tile[] = [];
  for (let x = 0; x < width; x += partPixels) {
    const tileWidth = Math.min(partPixels, width - x);
    const rows = rowsPerCut(tileWidth, height);
    for (let y = 0; y < height; y += rows) tiles.push({ x, width: tileWidth, y, height: Math.min(rows, height - y) });
  }
  return tiles;
}

function encodeUeDelta(pixels: Buffer, width: number, height: number, bytesPerPixel: number, sampleBytes: 1 | 2): Buffer {
  const out = Buffer.from(pixels);
  const stride = width * bytesPerPixel;
  for (const tile of deltaTiles(width, height, bytesPerPixel)) {
    for (let y = tile.y + 1; y < tile.y + tile.height; y++) {
      const row = y * stride + tile.x * bytesPerPixel;
      const above = row - stride;
      for (let x = 0; x < tile.width * bytesPerPixel; x += sampleBytes) {
        if (sampleBytes === 1) out[row + x] = (pixels[row + x]! - pixels[above + x]!) & 0xff;
        else out.writeUInt16LE((pixels.readUInt16LE(row + x) - pixels.readUInt16LE(above + x) + 0x8080) & 0xffff, row + x);
      }
    }
  }
  return out;
}

function noise(length: number, seed: number): Buffer {
  const buffer = Buffer.alloc(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    // Smooth-ish content (like an image) plus noise, so a wrong tile split cannot cancel out.
    buffer[index] = ((index >> 3) + (state >>> 27)) & 0xff;
  }
  return buffer;
}

// ---------------------------------------------------------------------------------------------------------
// A minimal FMeshDescription payload (one triangle, one polygon group), in the layout ReadMeshDescription reads.

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

const DEFAULT_VALUE_SIZE: Record<number, number> = { 0: 16, 1: 12, 2: 8, 3: 4, 4: 4, 5: 4 };

/**
 * An element whose allocation bits follow `live` (holes included) and whose attribute arrays each span every allocated
 * slot, as Unreal serializes VertexInstances. `Attribute` above has one array per attribute, so a UV set needs its own.
 */
function maskedElement(name: string, live: readonly boolean[], attributes: readonly { name: string; kind: number; elementSize: number; arrays: readonly Buffer[] }[]): Buffer {
  const bits = Buffer.alloc(Math.ceil(live.length / 32) * 4);
  live.forEach((on, index) => {
    if (on) bits.writeUInt32LE((bits.readUInt32LE((index >> 5) * 4) | (1 << (index & 31))) >>> 0, (index >> 5) * 4);
  });
  const parts: Buffer[] = [fstring(name), int32(1), int32(live.length), bits, int32(0, live.length, attributes.length)];
  for (const attribute of attributes) {
    parts.push(fstring(attribute.name), int32(attribute.kind, 1, live.length, attribute.arrays.length));
    for (const data of attribute.arrays) parts.push(int32(1, attribute.elementSize, data.length / attribute.elementSize), data);
    parts.push(Buffer.alloc(DEFAULT_VALUE_SIZE[attribute.kind]!), int32(0));
  }
  return Buffer.concat(parts);
}

/** One synthetic source model. Slot-indexed arrays span every allocated slot; `uv` has one array per UV channel. */
interface UvMesh {
  /** Allocation of the vertex instances, holes included (`false` slots are never read). */
  readonly live: readonly boolean[];
  /** The vertex of each allocated instance slot. */
  readonly vertexOf: readonly number[];
  /** UE centimetres, three floats per vertex. */
  readonly positions: readonly number[];
  readonly normals: readonly number[];
  readonly uv: readonly (readonly number[])[];
  /** The TextureCoordinate kind and element size; the defaults are FVector2f (kind 2, eight bytes) as Unreal writes it. */
  readonly uvKind?: number;
  readonly uvElementSize?: number;
  readonly colours?: readonly number[];
  /** Three live instances and a polygon group each. */
  readonly triangles: readonly (readonly [number, number, number, number])[];
  readonly slots: readonly string[];
}

function uvMeshDescription(mesh: UvMesh): Buffer {
  const triangles = mesh.triangles.length;
  const instance = [
    { name: "VertexIndex", kind: 4, elementSize: 4, arrays: [int32(...mesh.vertexOf)] },
    { name: "Normal", kind: 1, elementSize: 12, arrays: [floats(mesh.normals)] },
    { name: "TextureCoordinate", kind: mesh.uvKind ?? 2, elementSize: mesh.uvElementSize ?? 8, arrays: mesh.uv.map((channel) => floats(channel)) },
    ...(mesh.colours ? [{ name: "Color", kind: 0, elementSize: 16, arrays: [floats(mesh.colours)] }] : []),
  ];
  return Buffer.concat([
    int32(5),
    element("Vertices", mesh.positions.length / 3, [{ name: "Position ", kind: 1, extent: 1, elementSize: 12, data: floats(mesh.positions) }], false),
    maskedElement("VertexInstances", mesh.live, instance),
    element(
      "Triangles",
      triangles,
      [
        { name: "VertexInstanceIndex", kind: 4, extent: 3, elementSize: 4, data: int32(...mesh.triangles.flatMap((corners) => corners.slice(0, 3))) },
        { name: "PolygonGroupIndex", kind: 4, extent: 1, elementSize: 4, data: int32(...mesh.triangles.map((corners) => corners[3])) },
      ],
      false,
    ),
    element("Polygons", triangles, [{ name: "ObjectName", kind: 6, names: Array(triangles).fill("piece") }], false),
    element("PolygonGroups", mesh.slots.length, [{ name: "ImportedMaterialSlotName", kind: 6, names: mesh.slots }], false),
  ]);
}

function meshDescription(slotNames: readonly string[], compactNames: boolean, colors?: readonly number[], vertexIndices: readonly number[] = [0, 1, 2]): Buffer {
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

// ---------------------------------------------------------------------------------------------------------

describe("UE5 editor sources the converter decodes (program text)", () => {
  it("tries a TSCF_UEDELTA source before scanning for an image signature, at every texture site", () => {
    expect(CUE4PARSE_PROGRAM).toContain("ExtractUeDeltaSourcePng(bytes, texture, failures) ?? ExtractLargestPng(bytes, RegisteredThumbnails(bytes, texture), failures) ?? ExtractCompressedPayloadPng(bytes, failures)");
    // No texture site bypasses it any more: the only PNG-then-payload chain left is inside ExtractSourcePng.
    expect(CUE4PARSE_PROGRAM.match(/ExtractLargestPng\(bytes, RegisteredThumbnails\(bytes, texture\), failures\) \?\? ExtractCompressedPayloadPng\(/g)).toHaveLength(1);
    // Raw pixels are written in true colour, so the BGRA8-PNG channel swap must skip them.
    expect(CUE4PARSE_PROGRAM).toContain("if (RawDerived.Table.TryGetValue(png, out _)) return png;");
  });

  it("reads a material instance's texture parameters from its tagged properties when the typed array is empty", () => {
    expect(CUE4PARSE_PROGRAM).toContain("foreach (var parameter in InstanceTextureParameters(instance))");
    expect(CUE4PARSE_PROGRAM).toContain('instance.GetOrDefault<FStructFallback[]>("TextureParameterValues")');
    expect(CUE4PARSE_PROGRAM).not.toContain("foreach (var parameter in instance.TextureParameterValues)");
  });

  it("writes a material under the sidecar name it claimed and points the instance's Parent line at its parent's", () => {
    // Without this a same-named parent (Kellan/MI_X -> Common/MI_X) overwrote the instance's Materials/MI_X.props.txt.
    expect(CUE4PARSE_PROGRAM).toContain("var sidecarName = MaterialSidecarName(materialSidecarOwners, materialName, next.Path);");
    expect(CUE4PARSE_PROGRAM).toContain("parentSidecar = MaterialSidecarName(materialSidecarOwners, parentName, parentPath);");
    expect(CUE4PARSE_PROGRAM).toContain('Path.Combine(materialDirectory, sidecarName + ".props.txt")');
    expect(CUE4PARSE_PROGRAM).toContain('Path.Combine(materialDirectory, sidecarName + ".mat")');
    expect(CUE4PARSE_PROGRAM).not.toContain('Path.Combine(materialDirectory, materialName + ".props.txt")');
    // A parent missing from the pack must not fall back to the same-named instance already written (a self-parent).
    expect(CUE4PARSE_PROGRAM).toContain("exportedMaterials.Contains(GamePackagePath(materialKey))) continue;");
  });

  it("names a compact FName layout it refuses instead of a bare 'no readable source model'", () => {
    expect(CUE4PARSE_PROGRAM).toContain("ReadLargestMeshDescription(file.Read(), out var refusal, cachedTriangles)");
    expect(CUE4PARSE_PROGRAM).toContain("ReadMeshDescriptionLayout(raw, compactNames: true, 0)");
  });

  it("reads trailer-backed landscape source payloads through the pinned CUE4Parse fixes", () => {
    expect(CUE4PARSE_PROGRAM).toContain("b4e95441+threenative.584.9.1");
    expect(CUE4PARSE_PROGRAM).toContain("LandscapeComponents");
    expect(CUE4PARSE_PROGRAM).toContain("TryReadLandscapeSourcePixels");
    expect(CUE4PARSE_PROGRAM).toContain("DecodeLandscapeHeightfield");
    expect(CUE4PARSE_PATCH).toContain("CUE4Parse/UE4/Objects/Core/Misc/FSHAHash.cs");
    expect(CUE4PARSE_PATCH).toContain("return span.IndexOfAnyExcept((byte) 0) >= 0;");
    expect(CUE4PARSE_PATCH).toContain("CUE4Parse/UE4/Assets/FPackageTrailer.cs");
    expect(CUE4PARSE_PATCH).toContain("entry.Identifier.Equals(id)");
  });
});

// The glTF vertex-colour writer compiles against the SharpGLTF assemblies the provisioned converter ships.
const SHARPGLTF_BIN = join(toolchainCacheDir(), "modern", "bin");

describeWithTools(["modern-converter"], "UE5 editor source decoders (compiled from the embedded program)", () => {
  let root = "";
  let harness = "";
  let sdk = "";
  const environment = (): NodeJS.ProcessEnv => ({
    ...process.env,
    DOTNET_CLI_HOME: join(root, "home"),
    DOTNET_NOLOGO: "1",
    DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
    MSBUILDDISABLENODEREUSE: "1",
    NUGET_PACKAGES: join(root, "nuget"),
    TMPDIR: join(root, "tmp"),
  });

  beforeAll(async () => {
    // The installed .NET 10 SDK, never a provisioner: a missing one fails here rather than installing into a cache.
    sdk = await modernSdkExecutable(process.env);
    root = await mkdtemp(join(tmpdir(), "asset-mcp-cs-decoders-"));
    await mkdir(join(root, "tmp"), { recursive: true });
    const project = join(root, "project");
    await mkdir(project, { recursive: true });
    await writeFile(
      join(project, "Decoders.csproj"),
      `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework>` +
        `<ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable><UseSharedCompilation>false</UseSharedCompilation></PropertyGroup>` +
        `<ItemGroup>${["SharpGLTF.Core", "SharpGLTF.Runtime", "SharpGLTF.Toolkit"]
          .map((assembly) => `<Reference Include="${assembly}"><HintPath>${join(SHARPGLTF_BIN, assembly + ".dll")}</HintPath></Reference>`)
          .join("")}</ItemGroup>` +
        `</Project>`,
    );
    const functions = [
      "static (int BytesPerPixel, int SampleBytes) UeDeltaPixelLayout(",
      "static void UndoUeDelta(",
      "static (float[] Heights, float[] Normals) DecodeLandscapeHeightfield(",
      "static int LandscapeRoundToInt(",
      "static float[] LandscapeLocalNormals(",
      "static EditorMesh ReadMeshDescription(",
      "static EditorMesh ReadMeshDescriptionInEitherLayout(",
      "static void CheckActiveUvChannels(",
      // Absent before converter 61; the old reader is the single function above.
      ...(CUE4PARSE_PROGRAM.includes("static EditorMesh ReadMeshDescriptionLayout(") ? ["static EditorMesh ReadMeshDescriptionLayout("] : []),
      // Absent before converter 67.
      ...(CUE4PARSE_PROGRAM.includes("static string MaterialSidecarName(") ? ["static string MaterialSidecarName("] : []),
      // Converter 68+: the vertex-colour writer, compiled against the SharpGLTF assemblies the modern converter ships.
      "static void WriteEditorMeshGlb(",
      "static System.Numerics.Vector4 EditorVertexColor(",
      "static float SrgbVertexChannel(",
      "static float LinearVertexChannel(",
    ].map((signature) => extractCSharp(CUE4PARSE_PROGRAM, signature));
    const record = CUE4PARSE_PROGRAM.slice(CUE4PARSE_PROGRAM.indexOf("sealed record EditorMesh("));
    const editorMesh = record.slice(0, record.indexOf(");") + 2);
    // The comparer is a type, which must follow the statements (local functions) like the record does.
    const comparer = CUE4PARSE_PROGRAM.includes("sealed class EditorVertexComparer") ? extractCSharp(CUE4PARSE_PROGRAM, "sealed class EditorVertexComparer") : "";
    await writeFile(
      join(project, "Program.cs"),
      `using System.Runtime.InteropServices;
using System.Text;
using System.Globalization;
using System.Text.Json;
if (args[0] == "delta")
{
    var data = File.ReadAllBytes(args[1]);
    var (bytesPerPixel, sampleBytes) = UeDeltaPixelLayout(args[3]);
    var size = args[2].Split('x').Select(int.Parse).ToArray();
    UndoUeDelta(data, 0, size[0], size[1], bytesPerPixel, sampleBytes);
    File.WriteAllBytes(args[1] + ".out", data);
}
else if (args[0] == "landscape")
{
    var data = File.ReadAllBytes(args[1]);
    var size = args[2].Split('x').Select(int.Parse).ToArray();
    var componentSizeQuads = int.Parse(args[3]);
    var subsectionSizeQuads = int.Parse(args[4]);
    var numSubsections = int.Parse(args[5]);
    var biasX = float.Parse(args[6], CultureInfo.InvariantCulture);
    var biasY = float.Parse(args[7], CultureInfo.InvariantCulture);
    UndoUeDelta(data, 0, size[0], size[1], 4, 1);
    var decoded = DecodeLandscapeHeightfield(data, size[0], size[1], componentSizeQuads, subsectionSizeQuads, numSubsections, biasX, biasY);
    if (args.Length > 8) decoded = (decoded.Heights, LandscapeLocalNormals(decoded.Normals, float.Parse(args[8], CultureInfo.InvariantCulture), float.Parse(args[9], CultureInfo.InvariantCulture), float.Parse(args[10], CultureInfo.InvariantCulture)));
    Console.WriteLine(JsonSerializer.Serialize(new { componentSizeQuads, heights = decoded.Heights, normals = decoded.Normals }));
}
else if (args[0] == "sidecar")
{
    // Each argument is "Name" or "Name=/Game/Package/Path": the sidecar name each claim gets, in order.
    ${CUE4PARSE_PROGRAM.includes("static string MaterialSidecarName(")
      ? `var owners = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    Console.WriteLine(string.Join(" ", args.Skip(1).Select(claim => claim.Split('=')).Select(parts => MaterialSidecarName(owners, parts[0], parts.Length > 1 ? parts[1] : null))));`
      : `Console.WriteLine(string.Join(" ", args.Skip(1).Select(claim => claim.Split('=')[0])));`}
}
else if (args[0] == "colormesh")
{
    var mesh = ReadMeshDescription(File.ReadAllBytes(args[1]));
    WriteEditorMeshGlb(mesh, mesh.GroupSlots.Length > 0 ? mesh.GroupSlots : new[] { "SlotA" }, "colormesh", args[2]);
    Console.WriteLine("ok " + mesh.VertexColors.Length);
}
else if (args[0] == "indexed")
{
    // The writer keys each TEXCOORD by the index its tuple carries, not by position: source channels 0, 1 and 7 are
    // supplied as indices 0, 1 and 7, so TEXCOORD_0, _1 and _7 are written and no set in between.
    var source = ReadMeshDescription(File.ReadAllBytes(args[1]));
    var sparse = source with { UvChannels = new[] { (0, source.UvChannels[0].Values), (1, source.UvChannels[1].Values), (7, source.UvChannels[7].Values) } };
    WriteEditorMeshGlb(sparse, sparse.GroupSlots.Length > 0 ? sparse.GroupSlots : new[] { "SlotA" }, "indexed", args[2]);
    Console.WriteLine("ok " + sparse.UvChannels.Length);
}
else
{
    try
    {
        var mesh = ${
          // Converter 66 takes the source model's cached triangle count; before that the reader has one parameter.
          CUE4PARSE_PROGRAM.includes("static EditorMesh ReadMeshDescription(byte[] raw, int cachedTriangles")
            ? "ReadMeshDescription(File.ReadAllBytes(args[1]), args.Length > 2 ? int.Parse(args[2]) : 0)"
            : "ReadMeshDescription(File.ReadAllBytes(args[1]))"
        };
        Console.WriteLine("ok " + mesh.Positions.Length / 3 + " " + mesh.TriangleInstances.Length / 3 + " " + string.Join(",", mesh.GroupSlots));
    }
    catch (Exception error)
    {
        Console.WriteLine("error " + error.GetType().Name + ": " + error.Message);
    }
}
${functions.join("\n")}
${editorMesh}
${comparer}
`,
    );
    try {
      execFileSync(sdk, ["build", project, "-c", "Release", "-o", join(root, "bin"), "-nodeReuse:false"], {
        env: environment(),
        stdio: "pipe",
        timeout: 240_000,
      });
    } catch (error) {
      const output = String((error as { stdout?: Buffer }).stdout ?? "");
      throw new Error(`the extracted decoders did not compile:\n${output.split("\n").filter((line) => line.includes("error")).slice(0, 10).join("\n")}`);
    }
    harness = join(root, "bin", "Decoders.dll");
  }, 300_000);

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  const run = (...args: string[]): string =>
    execFileSync(sdk, [harness, ...args], { env: environment(), encoding: "utf8", timeout: 60_000 }).trim();

  it.each([
    // [format, width, height, bytes per pixel, sample bytes]
    ["TSF_G8", 600, 300, 1, 1], // one column, five row cuts of 60
    ["TSF_G8", 120, 100, 1, 1], // at most 136x136 pixels: one tile
    // Two cache-line-aligned columns (560 + 540 pixels): the first is cut into two runs of 60 rows, the
    // narrower second stays one run of 120 (without the alignment both would be 550 wide and cut in two).
    ["TSF_BGRA8", 1100, 120, 4, 1],
    ["TSF_BGRA8", 1024, 96, 4, 1], // the 4096-byte row is not split; three row cuts of 32
    ["TSF_RGBA16", 700, 300, 8, 2], // 16-bit samples with the 0x8080 bias, two columns of three cuts
  ] as const)("undoes the UE delta of a %s %ix%i source", async (format, width, height, bytesPerPixel, sampleBytes) => {
    const pixels = noise(width * height * bytesPerPixel, width * 31 + height);
    const file = join(root, `${format}-${width}x${height}.bin`);
    await writeFile(file, encodeUeDelta(pixels, width, height, bytesPerPixel, sampleBytes));
    run("delta", file, `${width}x${height}`, format);
    const decoded = await readFile(`${file}.out`);
    expect(decoded.equals(pixels)).toBe(true);
  });

  it("decodes a BGRA8 UEDELTA landscape into the public height and normal arrays", async () => {
    const textureWidth = 8;
    const textureHeight = 8;
    const componentSizeQuads = 4;
    const subsectionSizeQuads = 2;
    const numSubsections = 2;
    const biasX = 1 / textureWidth;
    const biasY = 2 / textureHeight;
    const source = Buffer.alloc(textureWidth * textureHeight * 4);
    const encodedHeightAt = (x: number, y: number): number => {
      const value = 30_000 + y * 173 + x * 29;
      const at = (y * textureWidth + x) * 4;
      source[at] = 191; // normal X: 2*B/255 - 1
      source[at + 3] = 64; // normal Y: 2*A/255 - 1
      source[at + 1] = value & 0xff;
      source[at + 2] = value >>> 8;
      return value;
    };
    for (let y = 0; y < textureHeight; y++) for (let x = 0; x < textureWidth; x++) encodedHeightAt(x, y);
    const file = join(root, "landscape-bgra8-uedelta.bin");
    await writeFile(file, encodeUeDelta(source, textureWidth, textureHeight, 4, 1));
    const decoded = JSON.parse(run(
      "landscape",
      file,
      `${textureWidth}x${textureHeight}`,
      `${componentSizeQuads}`,
      `${subsectionSizeQuads}`,
      `${numSubsections}`,
      `${biasX}`,
      `${biasY}`,
    )) as { componentSizeQuads: number; heights: number[]; normals: number[] };

    const atlasCoordinate = (coordinate: number): number => {
      if (coordinate === 0) return 0;
      const previous = coordinate - 1;
      return Math.floor(previous / subsectionSizeQuads) * (subsectionSizeQuads + 1) + (previous % subsectionSizeQuads) + 1;
    };
    const atlasOffsetX = Math.round(biasX * textureWidth);
    const atlasOffsetY = Math.round(biasY * textureHeight);
    const expectedHeights: number[] = [];
    const expectedNormals: number[] = [];
    const normalX = 2 * 191 / 255 - 1;
    const normalY = 2 * 64 / 255 - 1;
    const normalZ = Math.sqrt(Math.max(1 - normalX * normalX - normalY * normalY, 0));
    for (let y = 0; y <= componentSizeQuads; y++) {
      for (let x = 0; x <= componentSizeQuads; x++) {
        const textureX = atlasOffsetX + atlasCoordinate(x);
        const textureY = atlasOffsetY + atlasCoordinate(y);
        expectedHeights.push((encodedHeightAt(textureX, textureY) - 32768) / 128);
        expectedNormals.push(normalX, normalY, normalZ);
      }
    }
    expect(decoded.componentSizeQuads).toBe(componentSizeQuads);
    decoded.heights.forEach((value, index) => expect(value).toBeCloseTo(expectedHeights[index]!, 5));
    decoded.normals.forEach((value, index) => expect(value).toBeCloseTo(expectedNormals[index]!, 6));
    // x=2 and x=3 cross a two-quad subsection boundary. A dense rectangle reader samples the wrong atlas columns.
    expect(decoded.heights[2]).toBeCloseTo(expectedHeights[2]!, 5);
    expect(decoded.heights[3]).toBeCloseTo(expectedHeights[3]!, 5);
    expect(decoded.heights[2]).not.toBe(decoded.heights[3]);

    const scene = parseUnrealSceneSource(JSON.stringify({
      format: "threenative-unreal-scene-source",
      version: 1,
      mapName: "SyntheticLandscape",
      sourceFile: "Synthetic.umap",
      actors: [],
      texts: [],
      omittedActors: [],
      instanceGroups: [],
      landscapes: [{
        name: "LandscapeProxy/LandscapeComponent",
        materialName: "Landscape_Default",
        location: { x: 0, y: 0, z: 0 },
        rotation: { pitch: 0, yaw: 0, roll: 0 },
        scale: { x: 1, y: 1, z: 1 },
        sizeQuads: componentSizeQuads,
        heights: decoded.heights,
        normals: decoded.normals,
      }],
      lights: [],
      blueprintComponents: 0,
      camera: { hasCamera: false, location: { x: 0, y: 0, z: 0 }, rotation: { pitch: 0, yaw: 0, roll: 0 } },
    }));
    expect(scene.landscapes).toHaveLength(1);
    scene.landscapes![0]!.heights.forEach((value, index) => expect(value).toBeCloseTo(expectedHeights[index]!, 5));
    expect(scene.landscapes![0]!.normals).toEqual(decoded.normals);
    // Actual shipped C# helper -> public writer -> GLB normal matrix. Mirroring must keep its sign.
    for (const scaleX of [2, -2]) {
      const scale = { x: scaleX, y: 3, z: 5 };
      const compensated = JSON.parse(run("landscape", file, `${textureWidth}x${textureHeight}`, `${componentSizeQuads}`, `${subsectionSizeQuads}`, `${numSubsections}`, `${biasX}`, `${biasY}`, `${scale.x}`, `${scale.y}`, `${scale.z}`)) as { normals: number[] };
      const scaledSource = { ...scene, landscapes: [{ ...scene.landscapes![0]!, scale, normals: compensated.normals }] };
      const written = await assembleSceneGlb({ source: scaledSource, package: "Synthetic.umap", outputRoot: root, outputStem: `normals-${scaleX}`, models: [], validate: async () => ({ bytes: 0, sha256: "synthetic" }) });
      const document = await new NodeIO().read(join(root, written.glb));
      const node = document.getRoot().listNodes().find((entry) => entry.getMesh())!;
      const matrix = node.getWorldMatrix();
      const local = node.getMesh()!.listPrimitives()[0]!.getAttribute("NORMAL")!.getElement(0, []);
      // This fixture has no rotation; inverse-transpose is diagonal in glTF's Y,Z,-X basis.
      const world = [local[0]! / matrix[0]!, local[1]! / matrix[5]!, local[2]! / matrix[10]!];
      const length = Math.hypot(...world);
      const expected = [normalY, normalZ, -Math.sign(scaleX) * normalX];
      world.forEach((value, axis) => expect(value / length, `scale ${scaleX}, world normal axis ${axis}`).toBeCloseTo(expected[axis]!, 5));
    }
    expect(() => run("landscape", file, `${textureWidth}x${textureHeight}`, `${componentSizeQuads}`, `${subsectionSizeQuads}`, `${numSubsections}`, `${biasX}`, `${biasY}`, "0", "3", "5")).toThrow();

  });

  it("decodes a mesh description in the established FName layout", async () => {
    const file = join(root, "mesh-classic.bin");
    await writeFile(file, meshDescription(["SlotA"], false));
    expect(run("mesh", file)).toBe("ok 3 1 SlotA");
  });

  it("decodes the UE 5.8 compact FName layout (one distinct name per attribute)", async () => {
    const file = join(root, "mesh-compact.bin");
    await writeFile(file, meshDescription(["SlotA"], true));
    expect(run("mesh", file)).toBe("ok 3 1 SlotA");
  });

  // A UE 5.8 re-save (the LookAtPOI border props) whose payload runs past the description: the tail is the cut-off start
  // of an earlier, different serialization (here a 12-triangle Triangles element).
  const staleTail = (): Buffer => element("Triangles", 12, [{ name: "VertexInstanceIndex", kind: 4, extent: 3, elementSize: 4, data: int32(...Array.from({ length: 36 }, (_, index) => index)) }], true).subarray(0, 104);

  it("decodes a UE 5.8 payload with a stale tail when the source model cached the same triangle count", async () => {
    const file = join(root, "mesh-compact-tail.bin");
    await writeFile(file, Buffer.concat([meshDescription(["SlotA"], true), staleTail()]));
    expect(run("mesh", file, "1")).toBe("ok 3 1 SlotA");
  });

  it("still refuses a payload with a tail when no cached triangle count vouches for it, or the count differs", async () => {
    const file = join(root, "mesh-compact-tail-unvouched.bin");
    await writeFile(file, Buffer.concat([meshDescription(["SlotA"], true), staleTail()]));
    expect(run("mesh", file)).toBe("error InvalidDataException: Mesh description was not fully consumed.");
    expect(run("mesh", file, "2")).toBe("error InvalidDataException: Mesh description was not fully consumed.");
    // The established layout is not loosened either.
    const classic = join(root, "mesh-classic-tail.bin");
    await writeFile(classic, Buffer.concat([meshDescription(["SlotA"], false), Buffer.from([0, 1, 2, 3, 4, 5, 6, 7])]));
    expect(run("mesh", classic)).toMatch(/^error /);
  });

  it("gives a second package of one material name its own sidecar name, so it cannot overwrite the first", () => {
    // A MetaHuman instance and its same-named parent in Common/, then the parent claimed again, an unrelated material, and a
    // claim without a package path (it never counts as a different package).
    expect(run("sidecar", "MI_Head=/Game/Kellan/Face/MI_Head", "mi_head=/Game/Common/Face/MI_Head", "MI_Head=/Game/Common/Face/MI_Head", "M_Skin=/Game/Common/M_Skin", "MI_Head")).toBe(
      "MI_Head mi_head__2 mi_head__2 M_Skin MI_Head",
    );
  });

  it("refuses a compact FName attribute with several distinct names rather than guess the mapping", async () => {
    const file = join(root, "mesh-compact-two.bin");
    await writeFile(file, meshDescription(["SlotA", "SlotB"], true));
    expect(run("mesh", file)).toMatch(/^error NotSupportedException: FName attribute ImportedMaterialSlotName has 2 distinct names for 2 elements/);
  });

  // The mesh writer must carry a MeshDescription's vertex colours so a material that reads VertexColor renders
  // (the Hornbeam Icon meshes), while a mesh without a colour buffer gets no COLOR_0 at all. The decoder reads
  // the FVector4f attribute, and the writer maps it to COLOR_0 by vertex instance as the value Unreal's shader
  // sees: the ship build packs the linear source with FLinearColor::ToFColor(true) (sRGB RGB, linear alpha, one
  // byte) and VET_Color reads it back as byte/255 with no gamma decode. SharpGLTF stores that byte normalized.
  describe("MeshDescription vertex colours into glTF COLOR_0", () => {
    // Three vertex instances, each with a distinct linear RGBA. The vertex-index map is the permutation (2,0,1),
    // so instance i sits on a different vertex than i; a writer that indexed colours by vertex rather than
    // instance would put them in the wrong place. The export scales and swaps each position to (0,0,0), (1,0,0),
    // (0,0,1) metres, so each colour can be read back by position. Expected values below are the packed bytes
    // (sRGB RGB, linear alpha, nearest byte) the shader reads, computed independently of the writer.
    const palette = [1, 0.5, 0, 0.7, 0, 1, 0.25, 0.5, 0.2, 0.4, 0.6, 0.9] as const;
    const vertexIndices = [2, 0, 1] as const;

    async function coloursByPosition(glb: string): Promise<{ attribute: Accessor; byPosition: Map<string, number[]> } | null> {
      const document = await new NodeIO().read(glb);
      const primitive = document.getRoot().listMeshes().flatMap((mesh) => mesh.listPrimitives())[0];
      if (!primitive) throw new Error("the writer produced no primitive");
      const attribute = primitive.getAttribute("COLOR_0");
      if (!attribute) return null;
      const positions = primitive.getAttribute("POSITION")!.getArray()!;
      const components = attribute.getArray()!;
      const byPosition = new Map<string, number[]>();
      for (let vertex = 0; vertex < attribute.getCount(); vertex++) {
        const position = [positions[vertex * 3]!, positions[vertex * 3 + 1]!, positions[vertex * 3 + 2]!].map((value) => value.toFixed(3)).join(",");
        byPosition.set(position, [components[vertex * 4]!, components[vertex * 4 + 1]!, components[vertex * 4 + 2]!, components[vertex * 4 + 3]!]);
      }
      return { attribute, byPosition };
    }

    it("writes the source's per-vertex-instance colours as normalized RGBA COLOR_0", async () => {
      const file = join(root, "mesh-colour.bin");
      await writeFile(file, meshDescription(["SlotA"], false, palette, vertexIndices));
      const glb = join(root, "mesh-colour.glb");
      // The decoder reports the colour component count it read (three instances x four channels).
      expect(run("colormesh", file, glb)).toBe("ok 12");

      const result = await coloursByPosition(glb);
      expect(result).not.toBeNull();
      const { attribute, byPosition } = result!;
      expect(attribute.getType()).toBe("VEC4");
      expect(attribute.getComponentType()).toBe(5121); // UNSIGNED_BYTE
      expect(attribute.getNormalized()).toBe(true);
      expect(attribute.getCount()).toBe(3);

      // VertexIndex (2,0,1) maps instance 1 -> vertex 0 -> (0,0,0), instance 2 -> vertex 1 -> (1,0,0), and
      // instance 0 -> vertex 2 -> (0,0,1). Colours follow the instance, so palette order is not position order.
      // Each packed byte is the sRGB curve of the channel (alpha linear), rounded to nearest with .5 up.
      // Alpha 0.5 is the modern 128, not the legacy floor 127 (see the uncooked suite).
      const expected: ReadonlyArray<readonly [string, ReadonlyArray<number>]> = [
        ["0.000,0.000,0.000", [0, 255, 137, 128]], // linear (0, 1, 0.25, 0.5)
        ["1.000,0.000,0.000", [124, 170, 203, 230]], // linear (0.2, 0.4, 0.6, 0.9)
        ["0.000,0.000,1.000", [255, 188, 0, 179]], // linear (1, 0.5, 0, 0.7)
      ];
      for (const [position, rgba] of expected) {
        const found = byPosition.get(position);
        expect(found, `no vertex at ${position}`).toBeDefined();
        rgba.forEach((channel, index) => expect(found![index]).toBe(channel));
      }
    });

    it("writes no COLOR_0 for a MeshDescription without a Color attribute", async () => {
      const file = join(root, "mesh-nocolour.bin");
      await writeFile(file, meshDescription(["SlotA"], false));
      const glb = join(root, "mesh-nocolour.glb");
      expect(run("colormesh", file, glb)).toBe("ok 0");
      expect(await coloursByPosition(glb)).toBeNull();
    });
  });

  // Every UV channel the MeshDescription carries reaches the GLB at its own TEXCOORD index. Instances are packed by
  // their full vertex (position, normal, colour and every channel), so a seam between instances that differ only in a
  // later channel is kept, and a channel the source does not carry is not written, padded or renumbered.
  describe("UV channels into TEXCOORD_<n>", () => {
    // Channel k at allocated slot s: (k*16+s)/64 and (s*4+k)/64. Exact in binary, and distinct for every channel and slot.
    const uvAt = (channel: number, slot: number): number[] => [(channel * 16 + slot) / 64, (slot * 4 + channel) / 64];
    const channelsOf = (count: number, slots: number): number[][] =>
      Array.from({ length: count }, (_, channel) => Array.from({ length: slots }, (_, slot) => uvAt(channel, slot)).flat());
    // Live instances 2, 5 and 9 in 12 allocated slots: 2 sits on vertex 1, 5 on vertex 0 and 9 on vertex 2.
    const LIVE = Array.from({ length: 12 }, (_, slot) => slot === 2 || slot === 5 || slot === 9);
    const VERTEX_OF = Array.from({ length: 12 }, (_, slot) => (slot === 2 ? 1 : slot === 5 ? 0 : slot === 9 ? 2 : 0));
    const POSITIONS = [0, 0, 0, 100, 0, 0, 0, 100, 0];
    const UP = Array.from({ length: 12 }, () => [0, 0, 1]).flat();
    const PALETTE = Array.from({ length: 12 }, (_, slot) => (slot === 2 ? [1, 0.5, 0, 0.7] : slot === 5 ? [0, 1, 0.25, 0.5] : slot === 9 ? [0.2, 0.4, 0.6, 0.9] : [1, 1, 1, 1])).flat();

    async function write(name: string, mesh: UvMesh, mode: "colormesh" | "mesh" | "indexed" = "colormesh"): Promise<{ output: string; glb: string }> {
      const file = join(root, `${name}.bin`);
      await writeFile(file, uvMeshDescription(mesh));
      const glb = join(root, `${name}.glb`);
      return { output: mode === "mesh" ? run(mode, file) : run(mode, file, glb), glb };
    }
    async function primitiveOf(glb: string): Promise<Primitive> {
      return (await new NodeIO().read(glb)).getRoot().listMeshes()[0]!.listPrimitives()[0]!;
    }
    const semanticsOf = (primitive: Primitive): string[] => primitive.listSemantics().sort();
    const indicesOf = (primitive: Primitive): number[] => Array.from(primitive.getIndices()!.getArray()!);
    function vec3sOf(primitive: Primitive, semantic: string): string[] {
      const attribute = primitive.getAttribute(semantic)!;
      const values = attribute.getArray()!;
      return Array.from({ length: attribute.getCount() }, (_, vertex) =>
        [values[vertex * 3]!, values[vertex * 3 + 1]!, values[vertex * 3 + 2]!].map((value) => value.toFixed(3)).join(","),
      );
    }
    function texcoordsOf(primitive: Primitive, channel: number): number[][] {
      const attribute = primitive.getAttribute(`TEXCOORD_${channel}`)!;
      const values = attribute.getArray()!;
      return Array.from({ length: attribute.getCount() }, (_, vertex) => [values[vertex * 2]!, values[vertex * 2 + 1]!]);
    }

    it("writes every present channel (0..7) at its own TEXCOORD index, read from the instance that owns it", async () => {
      const { output, glb } = await write("uv-eight", { live: LIVE, vertexOf: VERTEX_OF, positions: POSITIONS, normals: UP, uv: channelsOf(8, 12), triangles: [[2, 5, 9, 0]], slots: ["SlotA"] });
      expect(output).toBe("ok 0");
      const primitive = await primitiveOf(glb);
      expect(semanticsOf(primitive)).toEqual(["NORMAL", "POSITION", "TEXCOORD_0", "TEXCOORD_1", "TEXCOORD_2", "TEXCOORD_3", "TEXCOORD_4", "TEXCOORD_5", "TEXCOORD_6", "TEXCOORD_7"]);
      // Vertices are numbered by first use (instances 2, 5, 9); positions and normals are the (x, z, y) * 0.01 conversion.
      expect(vec3sOf(primitive, "POSITION")).toEqual(["1.000,0.000,0.000", "0.000,0.000,0.000", "0.000,0.000,1.000"]);
      expect(vec3sOf(primitive, "NORMAL")).toEqual(["0.000,1.000,0.000", "0.000,1.000,0.000", "0.000,1.000,0.000"]);
      expect(indicesOf(primitive)).toEqual([0, 1, 2]);
      for (let channel = 0; channel < 8; channel++) {
        expect(texcoordsOf(primitive, channel), `TEXCOORD_${channel}`).toEqual([uvAt(channel, 2), uvAt(channel, 5), uvAt(channel, 9)]);
      }
    });

    it("keeps a seam between instances that differ only in a later channel", async () => {
      // Instances 0 and 3 sit on vertex 0 with the same normal and UV0; only UV1 differs, so they stay two vertices.
      const { output, glb } = await write("uv-seam", {
        live: [true, true, true, true],
        vertexOf: [0, 1, 2, 0],
        positions: POSITIONS,
        normals: Array.from({ length: 4 }, () => [0, 0, 1]).flat(),
        uv: [
          [0, 0, 1, 0, 0, 1, 0, 0],
          [0.25, 0.5, 0.5, 0.5, 0.5, 0.75, 0.75, 0.5],
        ],
        triangles: [
          [0, 1, 2, 0],
          [3, 2, 1, 0],
        ],
        slots: ["SlotA"],
      });
      expect(output).toBe("ok 0");
      const primitive = await primitiveOf(glb);
      expect(vec3sOf(primitive, "POSITION")).toHaveLength(4);
      expect(indicesOf(primitive)).toEqual([0, 1, 2, 3, 2, 1]);
      expect(texcoordsOf(primitive, 0)).toEqual([
        [0, 0],
        [1, 0],
        [0, 1],
        [0, 0],
      ]);
      expect(texcoordsOf(primitive, 1)).toEqual([
        [0.25, 0.5],
        [0.5, 0.5],
        [0.5, 0.75],
        [0.75, 0.5],
      ]);
    });

    // Native serialization stores TextureCoordinate as one dense channel array (UE 5.8.3 MeshAttributeArray.h,
    // ArrayForChannels), so a source has no hole in the channel index space: its channels are 0..n-1, and only a trailing
    // channel can be absent. The writer is still handed indices, and it must keep the ones it is given.
    it("writes a supplied sparse channel set (0, 1, 7) at those indices, with no channel in between", async () => {
      const { output, glb } = await write("uv-sparse", { live: LIVE, vertexOf: VERTEX_OF, positions: POSITIONS, normals: UP, uv: channelsOf(8, 12), triangles: [[2, 5, 9, 0]], slots: ["SlotA"] }, "indexed");
      expect(output).toBe("ok 3");
      const primitive = await primitiveOf(glb);
      expect(semanticsOf(primitive)).toEqual(["NORMAL", "POSITION", "TEXCOORD_0", "TEXCOORD_1", "TEXCOORD_7"]);
      for (const channel of [0, 1, 7]) expect(texcoordsOf(primitive, channel), `TEXCOORD_${channel}`).toEqual([uvAt(channel, 2), uvAt(channel, 5), uvAt(channel, 9)]);
    });

    it("writes only the channels a two-channel source carries", async () => {
      const { glb } = await write("uv-two", { live: LIVE, vertexOf: VERTEX_OF, positions: POSITIONS, normals: UP, uv: channelsOf(2, 12), triangles: [[2, 5, 9, 0]], slots: ["SlotA"] });
      const primitive = await primitiveOf(glb);
      expect(semanticsOf(primitive)).toEqual(["NORMAL", "POSITION", "TEXCOORD_0", "TEXCOORD_1"]);
      expect(texcoordsOf(primitive, 1)).toEqual([uvAt(1, 2), uvAt(1, 5), uvAt(1, 9)]);
    });

    it("writes no TEXCOORD for a source that carries no UV channel", async () => {
      const { output, glb } = await write("uv-none", { live: LIVE, vertexOf: VERTEX_OF, positions: POSITIONS, normals: UP, uv: [], triangles: [[2, 5, 9, 0]], slots: ["SlotA"] });
      expect(output).toBe("ok 0");
      expect(semanticsOf(await primitiveOf(glb))).toEqual(["NORMAL", "POSITION"]);
    });

    it("writes COLOR_0 beside every UV channel, with the colour the instance owns", async () => {
      const { output, glb } = await write("uv-colour", { live: LIVE, vertexOf: VERTEX_OF, positions: POSITIONS, normals: UP, uv: channelsOf(8, 12), colours: PALETTE, triangles: [[2, 5, 9, 0]], slots: ["SlotA"] });
      expect(output).toBe("ok 48");
      const primitive = await primitiveOf(glb);
      expect(semanticsOf(primitive)).toEqual(["COLOR_0", "NORMAL", "POSITION", "TEXCOORD_0", "TEXCOORD_1", "TEXCOORD_2", "TEXCOORD_3", "TEXCOORD_4", "TEXCOORD_5", "TEXCOORD_6", "TEXCOORD_7"]);
      const colour = primitive.getAttribute("COLOR_0")!;
      expect(colour.getComponentType()).toBe(5121);
      expect(colour.getNormalized()).toBe(true);
      // Same packed bytes as the colour suite above: instance 2 -> (1, .5, 0, .7), 5 -> (0, 1, .25, .5), 9 -> (.2, .4, .6, .9).
      expect(Array.from(colour.getArray()!)).toEqual([255, 188, 0, 179, 0, 255, 137, 128, 124, 170, 203, 230]);
      expect(texcoordsOf(primitive, 7)).toEqual([uvAt(7, 2), uvAt(7, 5), uvAt(7, 9)]);
    });

    it("does not read a non-finite value in an unused hole", async () => {
      // Slot 0 is a hole: its channel-1 value is NaN, and it is never looked at.
      const channel1 = channelsOf(2, 12)[1]!;
      channel1[0] = Number.NaN;
      channel1[1] = Number.NaN;
      const { output, glb } = await write("uv-hole-nan", { live: LIVE, vertexOf: VERTEX_OF, positions: POSITIONS, normals: UP, uv: [channelsOf(2, 12)[0]!, channel1], triangles: [[2, 5, 9, 0]], slots: ["SlotA"] });
      expect(output).toBe("ok 0");
      const primitive = await primitiveOf(glb);
      expect(texcoordsOf(primitive, 1)).toEqual([uvAt(1, 2), uvAt(1, 5), uvAt(1, 9)]);
    });

    it("refuses a ninth UV channel rather than dropping or renumbering one", async () => {
      const { output } = await write("uv-nine", { live: LIVE, vertexOf: VERTEX_OF, positions: POSITIONS, normals: UP, uv: channelsOf(9, 12), triangles: [[2, 5, 9, 0]], slots: ["SlotA"] }, "mesh");
      expect(output).toMatch(/^error NotSupportedException: .*channel 8/);
    });

    it("refuses a channel that carries no values rather than fabricating one", async () => {
      const { output } = await write("uv-empty", { live: LIVE, vertexOf: VERTEX_OF, positions: POSITIONS, normals: UP, uv: [channelsOf(1, 12)[0]!, []], triangles: [[2, 5, 9, 0]], slots: ["SlotA"] }, "mesh");
      expect(output).toMatch(/^error InvalidDataException: UV channel 1 has 0 values for 12 vertex instances/);
    });

    it("refuses a TextureCoordinate that is not an FVector2f", async () => {
      const { output } = await write(
        "uv-kind",
        { live: LIVE, vertexOf: VERTEX_OF, positions: POSITIONS, normals: UP, uvKind: 1, uvElementSize: 12, uv: [Array.from({ length: 36 }, (_, index) => index / 64)], triangles: [[2, 5, 9, 0]], slots: ["SlotA"] },
        "mesh",
      );
      expect(output).toMatch(/^error NotSupportedException: .*channel 0 is attribute kind 1/);
    });

    it("refuses a UV channel that does not span every allocated instance", async () => {
      const short = channelsOf(1, 12)[0]!.slice(0, 12);
      const { output } = await write("uv-short", { live: LIVE, vertexOf: VERTEX_OF, positions: POSITIONS, normals: UP, uv: [channelsOf(1, 12)[0]!, short], triangles: [[2, 5, 9, 0]], slots: ["SlotA"] }, "mesh");
      expect(output).toMatch(/^error InvalidDataException: UV channel 1 has 6 values for 12 vertex instances/);
    });

    it("refuses a non-finite value at a live triangle corner", async () => {
      const channel1 = channelsOf(2, 12)[1]!;
      channel1[10] = Number.NaN; // slot 5, u
      const { output } = await write("uv-nan", { live: LIVE, vertexOf: VERTEX_OF, positions: POSITIONS, normals: UP, uv: [channelsOf(2, 12)[0]!, channel1], triangles: [[2, 5, 9, 0]], slots: ["SlotA"] }, "mesh");
      expect(output).toMatch(/^error InvalidDataException: UV channel 1 is not finite at vertex instance 5/);
    });

    it("refuses a triangle corner outside the allocated instances", async () => {
      const { output } = await write("uv-corner", { live: LIVE, vertexOf: VERTEX_OF, positions: POSITIONS, normals: UP, uv: channelsOf(2, 12), triangles: [[2, 5, 12, 0]], slots: ["SlotA"] }, "mesh");
      expect(output).toMatch(/^error InvalidDataException: Triangle 0 uses vertex instance 12 of 12/);
    });
  });
});
