import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeIO, type Accessor } from "@gltf-transform/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CUE4PARSE_PROGRAM } from "../src/unreal/cue4parse-adapter.js";
import { toolchainCacheDir } from "../src/unreal/provision.js";
import { describeWithTools } from "./helpers/require-tool.js";

// Three UE5 editor-package layouts the modern converter did not read (converter 61):
//  - TSCF_UEDELTA texture sources (UE 5.6+ default): raw pixels, row-delta filtered per tile. No PNG or
//    JPEG is inside, so every colour texture of a 5.6+ pack was dropped and its sections went neutral.
//  - The UE 5.8 compact FName array in an FMeshDescription: the static mesh had no readable source model.
//  - A UE4-saved MaterialInstanceConstant inside a UE5 artifact: CUE4Parse throws before filling the typed
//    TextureParameterValues, so the instance exported no textures although its tagged properties hold them.
// The decoders are pure functions in the embedded program. They are compiled on their own, against the private
// .NET SDK and SharpGLTF assemblies of the `modern-converter` test prerequisite, and run against synthetic data
// encoded here from Unreal's documented tile rules. Without them the compiled suite skips locally and fails under CI=true.

/** Extracts one top-level C# declaration (signature line through its matching brace) from the program. */
function extractCSharp(program: string, signature: string): string {
  const start = program.indexOf(signature);
  if (start < 0) throw new Error(`converter program has no ${signature}`);
  let depth = 0;
  let opened = false;
  for (let index = start; index < program.length; index++) {
    const char = program[index]!;
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
    expect(CUE4PARSE_PROGRAM).toContain("ExtractUeDeltaSourcePng(bytes, texture, failures) ?? ExtractLargestPng(bytes) ?? ExtractCompressedPayloadPng(bytes, failures)");
    // No texture site bypasses it any more: the only PNG-then-payload chain left is inside ExtractSourcePng.
    expect(CUE4PARSE_PROGRAM.match(/ExtractLargestPng\([^)]*\) \?\? ExtractCompressedPayloadPng\(/g)).toHaveLength(1);
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
});

const DOTNET = join(toolchainCacheDir(), "modern", "dotnet", process.platform === "win32" ? "dotnet.exe" : "dotnet");
// The glTF vertex-colour writer compiles against the SharpGLTF assemblies the provisioned converter ships.
const SHARPGLTF_BIN = join(toolchainCacheDir(), "modern", "bin");

describeWithTools(["modern-converter"], "UE5 editor source decoders (compiled from the embedded program)", () => {
  let root = "";
  let harness = "";
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
      "static EditorMesh ReadMeshDescription(",
      // Absent before converter 61; the old reader is the single function above.
      ...(CUE4PARSE_PROGRAM.includes("static EditorMesh ReadMeshDescriptionLayout(") ? ["static EditorMesh ReadMeshDescriptionLayout("] : []),
      // Absent before converter 67.
      ...(CUE4PARSE_PROGRAM.includes("static string MaterialSidecarName(") ? ["static string MaterialSidecarName("] : []),
      // Converter 68+: the vertex-colour writer, compiled against the SharpGLTF assemblies the modern converter ships.
      "static void WriteEditorMeshGlb(",
      "static System.Numerics.Vector4 EditorVertexColor(",
    ].map((signature) => extractCSharp(CUE4PARSE_PROGRAM, signature));
    const record = CUE4PARSE_PROGRAM.slice(CUE4PARSE_PROGRAM.indexOf("sealed record EditorMesh("));
    const editorMesh = record.slice(0, record.indexOf(");") + 2);
    await writeFile(
      join(project, "Program.cs"),
      `using System.Runtime.InteropServices;
using System.Text;
if (args[0] == "delta")
{
    var data = File.ReadAllBytes(args[1]);
    var (bytesPerPixel, sampleBytes) = UeDeltaPixelLayout(args[3]);
    var size = args[2].Split('x').Select(int.Parse).ToArray();
    UndoUeDelta(data, 0, size[0], size[1], bytesPerPixel, sampleBytes);
    File.WriteAllBytes(args[1] + ".out", data);
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
`,
    );
    try {
      execFileSync(DOTNET, ["build", project, "-c", "Release", "-o", join(root, "bin"), "-nodeReuse:false"], {
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
    execFileSync(DOTNET, [harness, ...args], { env: environment(), encoding: "utf8", timeout: 60_000 }).trim();

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
  // the FVector4f attribute, the writer maps it to COLOR_0 by vertex instance, and SharpGLTF normalises it.
  describe("MeshDescription vertex colours into glTF COLOR_0", () => {
    // Three vertex instances, each with a distinct linear RGBA. The vertex-index map is the permutation (2,0,1),
    // so instance i sits on a different vertex than i; a writer that indexed colours by vertex rather than
    // instance would put them in the wrong place. The export scales and swaps each position to (0,0,0), (1,0,0),
    // (0,0,1) metres, so each colour can be read back by position.
    const palette = [1, 0.5, 0, 0.7, 0, 1, 0.25, 0.35, 0.2, 0.4, 0.6, 0.9] as const;
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
        byPosition.set(position, [components[vertex * 4]!, components[vertex * 4 + 1]!, components[vertex * 4 + 2]!, components[vertex * 4 + 3]!].map((value) => value / 255));
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
      const expected: ReadonlyArray<readonly [string, ReadonlyArray<number>]> = [
        ["0.000,0.000,0.000", [palette[4], palette[5], palette[6], palette[7]]],
        ["1.000,0.000,0.000", [palette[8], palette[9], palette[10], palette[11]]],
        ["0.000,0.000,1.000", [palette[0], palette[1], palette[2], palette[3]]],
      ];
      for (const [position, rgba] of expected) {
        const found = byPosition.get(position);
        expect(found, `no vertex at ${position}`).toBeDefined();
        rgba.forEach((channel, index) => expect(found![index]).toBeCloseTo(channel, 2));
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
});
