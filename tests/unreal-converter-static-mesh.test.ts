import { mkdtemp, readdir, rm } from "node:fs/promises";
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
using System.Runtime.CompilerServices;
using System.Text.Json;
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

static FPropertyTag Tag(string name, string type, FPropertyTagType value) => new() { Name = new FName(name), Tag = value };
static FStructFallback Struct(params FPropertyTag[] fields) => new(fields.ToList());
static FPropertyTag StructTag(string name, FStructFallback value) => Tag(name, "StructProperty", new StructProperty(new FScriptStruct(value)));

static UStaticMesh TaggedScaleMesh(string profile)
{
    // These are tagged SourceModels[0].BuildSettings.BuildScale3D values, as CUE4Parse presents the UE5.4 (1012)
    // and UE5.5 (-9) property layouts after deserialization. The package profile is kept in the fixture output.
    var scale = Struct(
        Tag("X", "FloatProperty", new FloatProperty(2f)),
        Tag("Y", "FloatProperty", new FloatProperty(2f)),
        Tag("Z", "FloatProperty", new FloatProperty(2f)));
    var buildSettings = Struct(StructTag("BuildScale3D", scale));
    var sourceModel = Struct(StructTag("BuildSettings", buildSettings));
    var mesh = new UStaticMesh { Name = "Synthetic_" + profile };
    mesh.Properties.Add(Tag("SourceModels", "ArrayProperty", new ArrayProperty(new UScriptArray(
        new List<FPropertyTagType> { new StructProperty(new FScriptStruct(sourceModel)) }, "StructProperty"))));
    return mesh;
}

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
    foreach (var profile in new[] { "ue54-tag1012", "ue55-legacy9" })
    {
        var mesh = TaggedScaleMesh(profile);
        var scale = ReadStaticMeshBuildScale(mesh);
        Console.WriteLine(JsonSerializer.Serialize(new { profile, scale }));
    }
}
else if (args[0] == "lods")
{
    foreach (var (directory, quality) in new[] { (args[1], EMeshQuality.Highest), (args[2], EMeshQuality.All) })
    {
        var session = new ExportSession { MaxDegreeOfParallelism = 1 };
        session.Add(CookedFixture());
        var results = await session.RunAsync(directory, new ExportOptions(meshFormat: EMeshFormat.Gltf2, exportMaterials: false, meshQuality: quality));
        Console.WriteLine(JsonSerializer.Serialize(new { quality = quality.ToString(), files = results.SelectMany(result => result.DiskFilePaths ?? []).ToArray() }));
    }
}
else throw new ArgumentException("expected scale or lods");

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

  it("reads tagged SourceModels[0].BuildSettings.BuildScale3D for UE5.4 tag 1012 and UE5.5 legacy -9 contexts", async () => {
    expect(build.code, build.output).toBe(0);
    const result = await run("scale");
    expect(result.code, result.stderr).toBe(0);
    const rows = result.stdout.trim().split("\n").map(line => JSON.parse(line) as { profile: string; scale: number[] });
    expect(rows).toEqual([
      { profile: "ue54-tag1012", scale: [2, 2, 2] },
      { profile: "ue55-legacy9", scale: [2, 2, 2] },
    ]);
  });

  it("exports a synthetic cooked static mesh's actual buffers at Highest versus All quality", async () => {
    expect(build.code, build.output).toBe(0);
    const highest = join(root, "highest");
    const all = join(root, "all");
    const result = await run("lods", highest, all);
    expect(result.code, result.stderr).toBe(0);
    const highestGlb = join(highest, "SyntheticCooked.glb");
    const allLod0 = join(all, "SyntheticCooked.glb");
    const allLod1 = join(all, "SyntheticCooked_LOD1.glb");
    const files = await readdir(all);
    expect(files).toContain("SyntheticCooked_LOD1.glb");
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
