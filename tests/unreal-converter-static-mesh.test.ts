import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeIO } from "@gltf-transform/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CUE4PARSE_PROGRAM } from "../src/unreal/cue4parse-adapter.js";
import { childEnvironment, runBounded } from "../src/unreal/toolchain.js";
import { modernSdkExecutable } from "../src/unreal/provision.js";
import { describeWithTools } from "./helpers/require-tool.js";
import { compileProject, type ConverterBuild } from "./helpers/material-overrides-harness.js";
import { extractCSharp } from "./helpers/rgba16f-producer.js";

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

describeWithTools(["modern-converter"], "native UE5 static mesh source and cooked LOD fixtures", () => {
  let root = "";
  let build: ConverterBuild;
  let sdk = "";

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "tn-native-static-mesh-"));
    sdk = await modernSdkExecutable(process.env);
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
    expect(metadata.buildScale3D).toEqual([2, 2, 2]);
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
