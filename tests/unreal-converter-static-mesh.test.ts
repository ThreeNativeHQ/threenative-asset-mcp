import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeIO } from "@gltf-transform/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { importUnrealDirectory } from "../src/unreal/importer.js";
import { writeFakeUmodel } from "./helpers/unreal-fixture.js";

import { CUE4PARSE_PROGRAM } from "../src/unreal/cue4parse-adapter.js";
import { childEnvironment, runBounded } from "../src/unreal/toolchain.js";
import { modernSdkExecutable } from "../src/unreal/provision.js";
import { describeWithTools } from "./helpers/require-tool.js";
import { compileProject, type ConverterBuild } from "./helpers/material-overrides-harness.js";
import { extractCSharp } from "./helpers/rgba16f-producer.js";

import { meshDescription } from "./helpers/static-mesh-description-fixture.js";

const STATIC_SCALE_HELPER = extractCSharp(CUE4PARSE_PROGRAM, "static float[]? ReadStaticMeshBuildScale(UStaticMesh mesh)");

const HARNESS = `using System.Reflection;
using CUE4Parse.UE4.Assets;
using CUE4Parse.UE4.Assets.Readers;
using CUE4Parse.UE4.Readers;
using CUE4Parse.UE4.Versions;
using System.Runtime.CompilerServices;
using System.Text.Json;
using Newtonsoft.Json;
using JsonSerializer = System.Text.Json.JsonSerializer;
using CUE4Parse.UE4.Assets.Exports;
using CUE4Parse.UE4.Assets.Exports.StaticMesh;
using CUE4Parse.UE4.Assets.Objects;
using CUE4Parse.UE4.Assets.Objects.Properties;
using CUE4Parse.UE4.Objects.Core.Math;
using CUE4Parse.UE4.Objects.Meshes;
using CUE4Parse.UE4.Objects.RenderCore;
using CUE4Parse.UE4.Objects.UObject;
using CUE4Parse_Conversion;
using CUE4Parse_Conversion.Options;

${STATIC_SCALE_HELPER}

// Complete type-name trees follow pinned FPropertyTag/FPropertyTagData; SourceModels is an array of tagged structs.
static UStaticMesh TaggedScaleMesh(EGame game, double factor)
{
    var names = new[] { "None", "SourceModels", "ArrayProperty", "StructProperty", "StaticMeshSourceModel", "/Script/Engine", "BuildSettings", "MeshBuildSettings", "BuildScale3D", "Vector", "/Script/CoreUObject" };
    byte[] Bytes(Action<BinaryWriter> write)
    {
        using var stream = new MemoryStream();
        using (var writer = new BinaryWriter(stream, System.Text.Encoding.UTF8, true)) write(writer);
        return stream.ToArray();
    }
    void Name(BinaryWriter writer, string name) { writer.Write(Array.IndexOf(names, name)); writer.Write(0); }
    void Node(BinaryWriter writer, string name, int children) { Name(writer, name); writer.Write(children); }
    void Property(BinaryWriter writer, string name, Action<BinaryWriter> tree, byte[] payload)
    {
        Name(writer, name); tree(writer); writer.Write(payload.Length); writer.Write((byte)0); writer.Write(payload);
    }
    void StructType(BinaryWriter writer, string type, string module)
    { Node(writer, "StructProperty", 1); Node(writer, type, 1); Node(writer, module, 0); }
    var vector = Bytes(writer => { writer.Write(factor); writer.Write(factor); writer.Write(factor); });
    var settings = Bytes(writer => {
        Property(writer, "BuildScale3D", w => StructType(w, "Vector", "/Script/CoreUObject"), vector);
        Name(writer, "None");
    });
    var source = Bytes(writer => {
        Property(writer, "BuildSettings", w => StructType(w, "MeshBuildSettings", "/Script/Engine"), settings);
        Name(writer, "None");
    });
    var bytes = Bytes(writer => {
        Property(writer, "SourceModels", w => { Node(w, "ArrayProperty", 1); StructType(w, "StaticMeshSourceModel", "/Script/Engine"); },
            Bytes(w => { w.Write(1); w.Write(source); }));
        Name(writer, "None");
    });
    using var archive = new FAssetArchive(new FByteArchive("tagged-source-models", bytes, new VersionContainer(game)), new SyntheticPackage(names));
    if (archive.Ver < EUnrealEngineObjectUE5Version.PROPERTY_TAG_COMPLETE_TYPE_NAME) throw new Exception("wrong tag profile");
    var decoded = new FStructFallback(archive, "StaticMesh");
    if (archive.Position != bytes.Length) throw new Exception("unconsumed tagged bytes");
    var mesh = new UStaticMesh { Name = "Synthetic_" + game };
    mesh.Properties.AddRange(decoded.Properties);
    var decodedVector = ((FStructFallback)mesh.GetOrDefault<FStructFallback[]>("SourceModels")[0]
        .GetOrDefault<FScriptStruct>("BuildSettings").StructType).GetOrDefault<FScriptStruct>("BuildScale3D").StructType;
    if (decodedVector is not FVector v || v.X != factor || v.Y != factor || v.Z != factor) throw new Exception("native FVector decode failed");
    return mesh;
}

var output = "";
var requestedLods = new[] { 0 };
var exportedMeshes = new HashSet<string>();
var meshFailures = new Dictionary<string, string>();
var assetLookupDiagnostics = new Dictionary<string, string>();
bool ExportEditorStaticMesh(UStaticMesh mesh, FStaticMaterial[] materials, out StaticMeshMetadata? metadata)
{ throw new Exception("unexpected editor fallback"); }
void RecordMeshFailure(string name, string kind, object results) => throw new Exception("native mesh export failed");
Task WriteMeshMaterialPackagesAsync(string name, IEnumerable<FPackageIndex?> materials) => Task.CompletedTask;
Task ExportMaterialAsync(string name, string? path) => throw new Exception("unexpected material export");
string? IndexPackagePath(FPackageIndex? index) => null;

${extractCSharp(CUE4PARSE_PROGRAM, "async Task WriteMeshMetadataAsync(string meshName, StaticMeshMetadata metadata)")}
${extractCSharp(CUE4PARSE_PROGRAM, "async Task<bool> ExportStaticMeshAsync(UStaticMesh mesh)")}

static T Uninitialized<T>() where T : class => (T)RuntimeHelpers.GetUninitializedObject(typeof(T));

static void SetMember(object target, string name, object value)
{
    var type = target.GetType();
    var property = type.GetProperty(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
    var setter = property?.GetSetMethod(true);
    if (setter is not null)
    {
        setter.Invoke(target, new[] { value });
        return;
    }
    var field = type.GetField(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
        ?? type.GetField("<" + name + ">k__BackingField", BindingFlags.Instance | BindingFlags.NonPublic);
    if (field is null) throw new MissingMemberException(type.FullName, name);
    field.SetValue(target, value);
}

static FStaticMeshLODResources Lod(int triangleCount)
{
    var positions = Enumerable.Range(0, triangleCount * 3)
        .Select(index => new FVector(index % 3, index / 3, 0))
        .ToArray();
    var positionBuffer = new SyntheticPositionBuffer(positions);
    var vertexBuffer = Uninitialized<FStaticMeshVertexBuffer>();
    vertexBuffer.NumVertices = positions.Length;
    vertexBuffer.NumTexCoords = 1;
    vertexBuffer.UV = positions.Select(_ => new FStaticMeshUVItem(
        new[] { new FPackedNormal(new FVector(0, 1, 0)), new FPackedNormal(new FVector(0, 0, 0)), new FPackedNormal(new FVector(0, 0, 1)) },
        new[] { new FMeshUVFloat(0, 0) })).ToArray();
    var indexBuffer = new FRawStaticIndexBuffer();
    typeof(FRawIndexBuffer).GetMethod("SetIndices", BindingFlags.Instance | BindingFlags.NonPublic, new[] { typeof(uint[]) })!
        .Invoke(indexBuffer, new object[] { Enumerable.Range(0, triangleCount * 3).Select(index => (uint)index).ToArray() });
    var lod = Uninitialized<FStaticMeshLODResources>();
    SetMember(lod, "Sections", new[] { new FStaticMeshSection { MaterialIndex = 0, FirstIndex = 0, NumTriangles = triangleCount, MinVertexIndex = 0, MaxVertexIndex = positions.Length - 1 } });
    SetMember(lod, "PositionVertexBuffer", positionBuffer);
    SetMember(lod, "VertexBuffer", vertexBuffer);
    SetMember(lod, "IndexBuffer", indexBuffer);
    return lod;
}

static UStaticMesh CookedFixture()
{
    var render = new FStaticMeshRenderData
    {
        LODs = new[] { Lod(2), Lod(1) },
        Bounds = new FBoxSphereBounds(new FVector(0, 0, 0), new FVector(2, 2, 1), 2),
        ScreenSize = new[] { 1f, 0.5f },
    };
    var mesh = new UStaticMesh { Name = "SyntheticCooked" };
    SetMember(mesh, "RenderData", render);
    return mesh;
}

if (args[0] == "scale")
{
    foreach (var game in new[] { EGame.GAME_UE5_4, EGame.GAME_UE5_5 })
    {
        var unit = ReadStaticMeshBuildScale(TaggedScaleMesh(game, 1));
        var scale = ReadStaticMeshBuildScale(TaggedScaleMesh(game, 2));
        Console.WriteLine(JsonSerializer.Serialize(new { profile = game.ToString(), unit, scale }));
    }
}
else if (args[0] == "lods")
{
    foreach (var (directory, lods) in new[] { (args[1], new[] { 0 }), (args[2], new[] { 0, 1 }) })
    {
        output = directory;
        requestedLods = lods;
        exportedMeshes.Clear();
        Directory.CreateDirectory(Path.Combine(output, "Meshes"));
        var mesh = CookedFixture();
        mesh.Properties.AddRange(TaggedScaleMesh(EGame.GAME_UE5_5, 2).Properties);
        if (!await ExportStaticMeshAsync(mesh)) throw new Exception("export failed");
    }
}
else throw new ArgumentException("expected scale or lods");

${CUE4PARSE_PROGRAM.match(/sealed record StaticMeshLodMetadata[^\n]+/)![0]}
${CUE4PARSE_PROGRAM.match(/sealed record StaticMeshMetadata[^\n]+/)![0]}

sealed class SyntheticPackage : AbstractUePackage
{
    public SyntheticPackage(string[] names) : base("Synthetic", null) { NameMap = names.Select(name => new FNameEntrySerialized(name)).ToArray(); }
    public override FPackageFileSummary Summary { get; } = new();
    public override FNameEntrySerialized[] NameMap { get; }
    public override int ImportMapLength => 0;
    public override int ExportMapLength => 0;
    public override int GetExportIndex(string name, StringComparison comparisonType = StringComparison.Ordinal) => -1;
    public override ResolvedObject? ResolvePackageIndex(FPackageIndex? index) => null;
}

sealed class SyntheticPositionBuffer : FPositionVertexBuffer
{
    public SyntheticPositionBuffer(FVector[] positions)
    {
        Verts = positions;
        NumVertices = positions.Length;
        Stride = 12;
    }
}
`;

const EDITOR_SOURCE = CUE4PARSE_PROGRAM.replace(/^\s*\/\/.*$/gm, "");
const EDITOR_FUNCTIONS = [
  "static (uint Flags, byte[] ContentHash, long PayloadSize, long? PayloadOffset)? ReadStaticMeshBulkHeader(", "static EditorMesh? ReadUniqueLegacyLod0(",
  "static byte[]? ReadStaticMeshSourcePayload(", "bool ExportEditorStaticMesh(",
  "static EditorMesh? ReadLargestMeshDescription(", "static List<(int At, ulong RawSize)> ScanEditorPayloads(",
  "static byte[] DecompressEditorPayload(", "static EditorMesh ReadMeshDescription(",
  "static EditorMesh ReadMeshDescriptionInEitherLayout(", "static void CheckActiveUvChannels(",
  "static EditorMesh ReadMeshDescriptionLayout(", "static void WriteEditorMeshGlb(",
  "static System.Numerics.Vector4 EditorVertexColor(", "static float SrgbVertexChannel(", "static float LinearVertexChannel(",
].map(signature => extractCSharp(EDITOR_SOURCE, signature)).join("\n");
const EDITOR_RECORD = CUE4PARSE_PROGRAM.slice(CUE4PARSE_PROGRAM.indexOf("sealed record EditorMesh("));
const EDITOR_HARNESS = HARNESS
  .replace("using System.Reflection;", `using System.Reflection;
using System.Buffers.Binary;
using System.Text;
using System.Runtime.InteropServices;
using CUE4Parse.Compression;
using CUE4Parse.UE4.Objects.Core.Compression;
using CUE4Parse.UE4.Objects.Core.Misc;`)
  .replace(/bool ExportEditorStaticMesh\(UStaticMesh mesh, FStaticMaterial\[\] materials, out StaticMeshMetadata\? metadata\)\n\{ throw new Exception\("unexpected editor fallback"\); \}/,
    `var provider = new FixtureProvider();\n${EDITOR_FUNCTIONS}`)
  .replace('if (args[0] == "scale")', `if (args[0] == "legacy")
{
    output = args[2];
    Directory.CreateDirectory(Path.Combine(output, "Meshes"));
    var mesh = TaggedScaleMesh(EGame.GAME_UE5_5, 1);
    var source = mesh.GetOrDefault<FStructFallback[]>("SourceModels")[0];
    source.Properties.Add(new FPropertyTag { Name = new FName("CacheMeshDescriptionTrianglesCount"), Tag = new UInt32Property(1) });
    mesh.Properties.Single(property => property.Name.Text == "SourceModels").Tag = new ArrayProperty(new UScriptArray(new List<FPropertyTagType> {
        new StructProperty(new FScriptStruct(source)), new StructProperty(new FScriptStruct(new FStructFallback(new List<FPropertyTag>()))) }, "StructProperty"));
    requestedLods = new[] { 0, 1 };
    provider.Files[mesh.Name + ".uasset"] = new FixtureFile(File.ReadAllBytes(args[1]));
    var success = ExportEditorStaticMesh(mesh, Array.Empty<FStaticMaterial>(), out var metadata);
    if (success) await WriteMeshMetadataAsync(mesh.Name, metadata);
    Console.WriteLine(JsonSerializer.Serialize(new { success, metadata, reason = assetLookupDiagnostics.GetValueOrDefault(mesh.Name) }));
}
else if (args[0] == "header")
{
    var results = new List<object>();
    foreach (var guidPresent in new[] { false, true })
    {
        using var stream = new MemoryStream();
        using (var writer = new BinaryWriter(stream, Encoding.UTF8, true))
        {
            writer.Write(1); writer.Write(0); // None FName
            writer.Write(guidPresent ? 1 : 0);
            if (guidPresent) writer.Write(Enumerable.Range(1, 16).Select(i => (byte)i).ToArray());
            writer.Write(64u);
            writer.Write(Enumerable.Range(17, 16).Select(i => (byte)i).ToArray()); // bulk GUID
            writer.Write(Enumerable.Range(33, 20).Select(i => (byte)i).ToArray());
            writer.Write(123456789L);
            writer.Write(987654321L);
        }
        var bytes = stream.ToArray();
        var header = ReadStaticMeshBulkHeader(bytes, 0, bytes.Length, new SyntheticPackage(new[] { "Unused", "None" }), new VersionContainer(EGame.GAME_UE5_3));
        var truncated = ReadStaticMeshBulkHeader(bytes, 0, bytes.Length - 1, new SyntheticPackage(new[] { "Unused", "None" }), new VersionContainer(EGame.GAME_UE5_3));
        results.Add(new { flags = header?.Flags, hash = header is { } h ? Convert.ToHexString(h.ContentHash) : null, size = header?.PayloadSize, offset = header?.PayloadOffset, truncated = truncated is null });
    }
    Console.WriteLine(JsonSerializer.Serialize(results));
}
else if (args[0] == "flags")
{
    var bytes = new byte[68];
    BinaryPrimitives.WriteInt32LittleEndian(bytes, 1); // odd None index, previously mistaken for virtualized flags
    BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(12), 64);
    var header = ReadStaticMeshBulkHeader(bytes, 0, bytes.Length, new SyntheticPackage(new[] { "Unused", "None" }), new VersionContainer(EGame.GAME_UE5_3));
    Console.WriteLine(JsonSerializer.Serialize(new { flags = header?.Flags }));
}
else if (args[0] == "scale")`)
  + `\n${EDITOR_RECORD.slice(0, EDITOR_RECORD.indexOf(");") + 2)}
${extractCSharp(CUE4PARSE_PROGRAM, "sealed class EditorVertexComparer")}
sealed class FixtureProvider { public Dictionary<string, FixtureFile> Files = new(); }
sealed class FixtureFile(byte[] bytes) { public long Size => bytes.Length; public byte[] Read() => bytes; }
`;

function compressedMesh(): Buffer {
  const raw = meshDescription(["SlotA"], false);
  const header = Buffer.alloc(64);
  header.writeUInt32BE(0xb7756362, 0);
  header.writeBigUInt64BE(BigInt(raw.length), 16);
  header.writeBigUInt64BE(BigInt(raw.length + 64), 24);
  return Buffer.concat([header, raw]);
}

describeWithTools(["modern-converter"], "native UE5 static mesh source and cooked LOD fixtures", () => {
  let root = "";
  let build: ConverterBuild;
  let sdk = "";
  let editorBuild: ConverterBuild;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "tn-native-static-mesh-"));
    sdk = await modernSdkExecutable(process.env);
    editorBuild = await compileProject(join(root, "editor-build"), "EditorStaticMeshFixture", { "Program.cs": EDITOR_HARNESS });
    build = await compileProject(join(root, "build"), "StaticMeshFixture", { "Program.cs": HARNESS });
  }, 900_000);

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function run(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const result = await runBounded(sdk, [build.dll, ...args], {
      timeoutMs: 900_000,
      maxOutputBytes: 16 * 1024 * 1024,
      environment: childEnvironment(process.env),
    });
    return result;
  }

  it("reads the complete bulk header after variable UObject preambles within export bounds", async () => {
    expect(editorBuild.code, editorBuild.output).toBe(0);
    const result = await runBounded(sdk, [editorBuild.dll, "header"], { timeoutMs: 30_000, environment: childEnvironment(process.env) });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([false, true].map(() => ({
      flags: 64, hash: Buffer.from(Array.from({ length: 20 }, (_, i) => i + 33)).toString("hex").toUpperCase(),
      size: 123456789, offset: 987654321, truncated: true,
    })));
  });

  it("reads bulk flags after serialized UObject properties rather than the odd None name index", async () => {
    expect(editorBuild.code, editorBuild.output).toBe(0);
    const result = await runBounded(sdk, [editorBuild.dll, "flags"], { timeoutMs: 30_000, environment: childEnvironment(process.env) });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).flags).toBe(64);
  });

  it("exports a positively identified legacy LOD0 with SourceModels present and no modern reference, refusing ambiguity", async () => {
    expect(editorBuild.code, editorBuild.output).toBe(0);
    for (const ambiguous of [false, true]) {
      const input = join(root, ambiguous ? "ambiguous.bin" : "legacy.bin");
      await writeFile(input, ambiguous ? Buffer.concat([compressedMesh(), compressedMesh()]) : compressedMesh());
      const output = join(root, ambiguous ? "ambiguous-output" : "legacy-output");
      const result = await runBounded(sdk, [editorBuild.dll, "legacy", input, output], { timeoutMs: 30_000, environment: childEnvironment(process.env) });
      expect(result.code, result.stderr).toBe(0);
      const value = JSON.parse(result.stdout);
      expect(value.success).toBe(!ambiguous);
      expect(value.metadata.Lods[1].Status).toBe("generated");
      expect(await readdir(join(output, "Meshes"))).not.toContain("Synthetic_GAME_UE5_5_LOD1.glb");
      if (ambiguous) expect(value.reason).toContain("ambiguous legacy LOD0");
      else {
        const document = await new NodeIO().read(join(output, "Meshes", "Synthetic_GAME_UE5_5.glb"));
        expect(document.getRoot().listMeshes()).toHaveLength(1);
        const sourceDir = join(root, "legacy-public-source");
        await mkdir(sourceDir, { recursive: true });
        const header = Buffer.alloc(32);
        header.writeUInt32LE(0x9e2a83c1, 0);
        header.writeInt32LE(-8, 4);
        header.writeInt32LE(1009, 12);
        await writeFile(join(sourceDir, "Synthetic_GAME_UE5_5.uasset"), Buffer.concat([header, Buffer.from("StaticMesh\0Default__StaticMesh\0")]));
        const umodel = join(root, "legacy-public-umodel");
        await writeFakeUmodel(umodel, { classes: {}, listExitCode: 1 });
        const converter = join(root, "legacy-public-relay");
        await writeFile(converter, `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
const out = argv[argv.indexOf("--export-dir") + 1];
fs.mkdirSync(out, { recursive: true });
fs.cpSync(${JSON.stringify(output)}, out, { recursive: true });
`);
        await chmod(converter, 0o755);
        const report = await importUnrealDirectory({
          sourceDir, outputDir: join(root, "legacy-public-output"), lods: [0, 1], graphBake: false,
          freeSpaceBytes: 30_000_000_000,
          environment: { ...process.env, THREENATIVE_UNREAL_CACHE_DIR: join(root, "legacy-public-cache") },
          umodel: { name: "umodel", path: umodel, version: "fixture" },
          modernConverter: { name: "modern", path: converter, version: "native-output relay" },
        });
        expect(report.models.map(model => model.glb)).toEqual(["Models/Synthetic_GAME_UE5_5.glb"]);
        expect(report.failed).toEqual([]);
      }
    }
  });

  it("decodes serialized complete-type-name SourceModels and FVector doubles under UE5.4 and UE5.5 versions", async () => {
    expect(build.code, build.output).toBe(0);
    const result = await run("scale");
    expect(result.code, result.stderr).toBe(0);
    const rows = result.stdout.trim().split("\n").map(line => JSON.parse(line) as { profile: string; unit: number[]; scale: number[] });
    expect(rows).toEqual([
      { profile: "GAME_UE5_4", unit: [1, 1, 1], scale: [2, 2, 2] },
      { profile: "GAME_UE5_5", unit: [1, 1, 1], scale: [2, 2, 2] },
    ]);
  });

  it("preserves native cooked bounds through the public importer without applying source BuildScale twice", async () => {
    expect(build.code, build.output).toBe(0);
    const native = join(root, "composed-native");
    const result = await run("lods", join(root, "composed-highest"), native);
    expect(result.code, result.stderr).toBe(0);
    const sourceDir = join(root, "composed-source");
    const outputDir = join(root, "composed-output");
    await mkdir(sourceDir, { recursive: true });
    // The header selects the public UE5 route; native render buffers and metadata supply the actual proof.
    const header = Buffer.alloc(32);
    header.writeUInt32LE(0x9e2a83c1, 0);
    header.writeInt32LE(-8, 4);
    header.writeInt32LE(1009, 12);
    await writeFile(join(sourceDir, "SyntheticCooked.uasset"), Buffer.concat([header, Buffer.from("StaticMesh\0Default__StaticMesh\0")]));
    const umodel = join(root, "composed-umodel");
    await writeFakeUmodel(umodel, { classes: {}, listExitCode: 1 });
    const converter = join(root, "composed-relay");
    await writeFile(converter, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
const out = argv[argv.indexOf("--export-dir") + 1];
fs.mkdirSync(out, { recursive: true });
fs.cpSync(${JSON.stringify(native)}, out, { recursive: true });
`);
    await chmod(converter, 0o755);
    const extent = async (file: string) => {
      const document = await new NodeIO().read(file);
      const positions = document.getRoot().listMeshes()[0]!.listPrimitives()[0]!.getAttribute("POSITION")!;
      const min = positions.getMin([]);
      const max = positions.getMax([]);
      return max.map((value, axis) => value - min[axis]!);
    };
    const nativeBounds = await extent(join(native, "Meshes", "SyntheticCooked.glb"));
    const report = await importUnrealDirectory({
      sourceDir, outputDir, lods: [0, 1], graphBake: false,
      freeSpaceBytes: 30_000_000_000,
      environment: { ...process.env, THREENATIVE_UNREAL_CACHE_DIR: join(root, "composed-cache") },
      umodel: { name: "umodel", path: umodel, version: "fixture" },
      modernConverter: { name: "modern", path: converter, version: "native-output relay" },
    });
    expect(report.models.map(model => model.glb)).toEqual(["Models/SyntheticCooked.glb", "Models/SyntheticCooked_LOD1.glb"]);
    expect(report.models[0]?.boundsMetres).toEqual(nativeBounds);
    expect(await extent(join(outputDir, report.models[0]!.glb))).toEqual(nativeBounds);
    const metadata = JSON.parse(await readFile(join(native, "Meshes", "SyntheticCooked.metadata.json"), "utf8"));
    expect(metadata.buildScale3D).toBeNull();
  });

  it("runs shipped ExportStaticMeshAsync on synthetic cooked buffers for requested LOD0 versus LOD0/1", async () => {
    expect(build.code, build.output).toBe(0);
    const highest = join(root, "highest");
    const all = join(root, "all");
    const result = await run("lods", highest, all);
    expect(result.code, result.stderr).toBe(0);
    const highestGlb = join(highest, "Meshes", "SyntheticCooked.glb");
    const allLod0 = join(all, "Meshes", "SyntheticCooked.glb");
    const allLod1 = join(all, "Meshes", "SyntheticCooked_LOD1.glb");
    const files = await readdir(join(all, "Meshes"));
    expect(files).toContain("SyntheticCooked_LOD1.glb");
    expect(await readdir(join(highest, "Meshes"))).not.toContain("SyntheticCooked_LOD1.glb");
    const metadata = JSON.parse(await readFile(join(all, "Meshes", "SyntheticCooked.metadata.json"), "utf8"));
    expect(metadata.buildScale3D).toBeNull();
    expect(metadata.lods.map((lod: { lod: number }) => lod.lod)).toEqual([0, 1]);
    const triangles = async (path: string): Promise<number> => {
      const document = await new NodeIO().read(path);
      return document.getRoot().listMeshes().flatMap(mesh => mesh.listPrimitives())
        .reduce((sum, primitive) => sum + (primitive.getIndices()?.getCount() ?? 0) / 3, 0);
    };
    expect(await triangles(highestGlb)).toBe(2);
    expect(await triangles(allLod0)).toBe(2);
    expect(await triangles(allLod1)).toBe(1);
  });
});
