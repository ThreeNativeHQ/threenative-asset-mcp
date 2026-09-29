/** Pinned because these changes depend on exact upstream serialization code. */
export const CUE4PARSE_SOURCE = Object.freeze({
  repository: "https://github.com/FabianFG/CUE4Parse.git",
  commit: "b4e95441bcf0c975eb3adb68c0fb44c740c2cf62",
  version: "b4e95441+threenative.49",
});

/** Applied to the pinned checkout, which remains an out-of-process Apache-2.0 tool. */
export const CUE4PARSE_PATCH = String.raw`diff --git a/Directory.Packages.props b/Directory.Packages.props
--- a/Directory.Packages.props
+++ b/Directory.Packages.props
@@ -2,3 +2,4 @@
   <PropertyGroup>
     <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
+    <CentralPackageTransitivePinningEnabled>true</CentralPackageTransitivePinningEnabled>
   </PropertyGroup>
@@ -14,2 +15,3 @@
     <PackageVersion Include="LZMA-SDK" Version="22.1.1" />
+    <PackageVersion Include="Microsoft.Bcl.Memory" Version="9.0.14" />
     <PackageVersion Include="Newtonsoft.Json" Version="13.0.4" />
diff --git a/CUE4Parse-Conversion/ExportSession.cs b/CUE4Parse-Conversion/ExportSession.cs
index 8cfaa87..c40edb0 100644
--- a/CUE4Parse-Conversion/ExportSession.cs
+++ b/CUE4Parse-Conversion/ExportSession.cs
@@ -163,7 +163,9 @@ public sealed class ExportSession(Action<StreamingLevelFilterArgs, CancellationT
         var fullPath = Path.Combine(BaseDirectory.FullName, savePath) + nameSuffix + '.' + ext.ToLower();
         var dir = Path.GetDirectoryName(fullPath) ?? throw new InvalidOperationException($"Cannot determine directory for path: {fullPath}");
         Directory.CreateDirectory(dir);
-        return fullPath.Replace('/', '\\');
+        // The old unconditional '\\' rewrite joined the whole absolute path into one backslash
+        // separated filename on Linux, so the file landed in the process working directory.
+        return fullPath.Replace('/', Path.DirectorySeparatorChar);
     }
 
     public event PropertyChangedEventHandler? PropertyChanged;
diff --git a/CUE4Parse-Conversion/Exporters/DnaExporter.cs b/CUE4Parse-Conversion/Exporters/DnaExporter.cs
index dc63558..3aa234d 100644
--- a/CUE4Parse-Conversion/Exporters/DnaExporter.cs
+++ b/CUE4Parse-Conversion/Exporters/DnaExporter.cs
@@ -15,7 +15,10 @@ public sealed class DnaExporter(UDNAAsset dna) : ExporterBase(dna)
         string? suffix = null;
         if (!string.IsNullOrEmpty(dna.DnaFileName))
         {
-            suffix = $"/{Path.GetFileNameWithoutExtension(dna.DnaFileName)}";
+            // DnaFileName is the authoring machine's absolute path, so its separators are whatever
+            // that machine used. Normalize before taking the leaf, or the whole path becomes a name.
+            var leaf = dna.DnaFileName.Replace('\\', '/');
+            suffix = $"/{Path.GetFileNameWithoutExtension(leaf)}";
         }
 
         return [new ExportFile("dna", dna.DNAData?.Value ?? [], suffix)];
diff --git a/CUE4Parse-Conversion/Dto/MeshLodDto.SkeletalMesh.cs b/CUE4Parse-Conversion/Dto/MeshLodDto.SkeletalMesh.cs
index 0c3aa7d..3b63cc2 100644
--- a/CUE4Parse-Conversion/Dto/MeshLodDto.SkeletalMesh.cs
+++ b/CUE4Parse-Conversion/Dto/MeshLodDto.SkeletalMesh.cs
@@ -70,7 +70,7 @@ internal static MeshLodDto<SkinnedMeshVertex> FromSkeletalMesh(SkeletalMeshDto o
             FSkelMeshVertexBase vertex;
             if (bUseVerticesFromSections)
             {
-                var v = lod.Sections[chunkIndex].SoftVertices[chunkVertexIndex++];
+                var v = lod.Sections[chunkIndex - 1].SoftVertices[chunkVertexIndex++];
                 vertex = v;
                 if (vertexColors != null)
                 {
diff --git a/CUE4Parse/UE4/Assets/Exports/SkeletalMesh/FSoftVertex.cs b/CUE4Parse/UE4/Assets/Exports/SkeletalMesh/FSoftVertex.cs
index 8a096e9..a6133f7 100644
--- a/CUE4Parse/UE4/Assets/Exports/SkeletalMesh/FSoftVertex.cs
+++ b/CUE4Parse/UE4/Assets/Exports/SkeletalMesh/FSoftVertex.cs
@@ -26,8 +26,13 @@ public FSoftVertex(FArchive Ar, bool isRigid = false)
             Color = Ar.Read<FColor>();
         }

+        var supportsEightInfluences = Ar.Ver >= EUnrealEngineObjectUE4Version.SUPPORT_8_BONE_INFLUENCES_SKELETAL_MESHES;
+        var supportsUnlimitedInfluences = FAnimObjectVersion.Get(Ar) >= FAnimObjectVersion.Type.UnlimitedBoneInfluences;
+        var influenceCount = supportsUnlimitedInfluences ? 12 : supportsEightInfluences ? 8 : 4;
+        var uses16BitBoneIndices = FAnimObjectVersion.Get(Ar) >= FAnimObjectVersion.Type.IncreaseBoneIndexLimitPerChunk;
+        var uses16BitBoneWeights = FUE5MainStreamObjectVersion.Get(Ar) >= FUE5MainStreamObjectVersion.Type.IncreasedSkinWeightPrecision;
         Infs = !isRigid ?
-            new FSkinWeightInfo(Ar, Ar.Ver >= EUnrealEngineObjectUE4Version.SUPPORT_8_BONE_INFLUENCES_SKELETAL_MESHES) :
+            new FSkinWeightInfo(Ar, supportsEightInfluences, uses16BitBoneIndices, uses16BitBoneWeights, influenceCount) :
             new FSkinWeightInfo { BoneIndex = { [0] = Ar.Read<byte>() }, BoneWeight = { [0] = 255 } };
     }
 }
diff --git a/CUE4Parse/UE4/Assets/Exports/SkeletalMesh/FStaticLODModel.cs b/CUE4Parse/UE4/Assets/Exports/SkeletalMesh/FStaticLODModel.cs
index 5a23e98..8eacca2 100644
--- a/CUE4Parse/UE4/Assets/Exports/SkeletalMesh/FStaticLODModel.cs
+++ b/CUE4Parse/UE4/Assets/Exports/SkeletalMesh/FStaticLODModel.cs
@@ -50,6 +50,7 @@ public FStaticLODModel()
     {
         Chunks = [];
         MeshToImportVertexMap = [];
+        VertexBufferGPUSkin = new FSkeletalMeshVertexBuffer();
         ColorVertexBuffer = new FSkeletalMeshVertexColorBuffer();
     }

@@ -68,7 +69,7 @@ public FStaticLODModel(FArchive Ar, bool bHasVertexColors, bool isFilterEditorOn
         else
         {
             // UE4.19+ uses 32-bit index buffer (for editor data)
-            Indices = new FMultisizeIndexContainer(Ar.ReadBulkArray<uint>());
+            Indices = new FMultisizeIndexContainer(Ar.ReadArray<uint>());
         }

         ActiveBoneIndices = Ar.ReadArray<short>();
@@ -158,6 +159,28 @@ public FStaticLODModel(FAssetArchive Ar, bool bHasVertexColors) : this()

         Sections = Ar.ReadArray(() => new FSkelMeshSection(Ar, Ar.IsFilterEditorOnly));

+        if (!stripDataFlags.IsEditorDataStripped() && FEditorObjectVersion.Get(Ar) >= FEditorObjectVersion.Type.SkeletalMeshBuildRefactor)
+        {
+            _ = Ar.ReadMap(Ar.Read<int>, () =>
+            {
+                var userStrip = new FStripDataFlags(Ar);
+                if (!userStrip.IsEditorDataStripped())
+                {
+                    _ = Ar.ReadBoolean();
+                    if (FRecomputeTangentCustomVersion.Get(Ar) >= FRecomputeTangentCustomVersion.Type.RecomputeTangentVertexColorMask)
+                        _ = Ar.Read<ESkinVertexColorChannel>();
+                    _ = Ar.ReadBoolean();
+                    if (FUE5MainStreamObjectVersion.Get(Ar) >= FUE5MainStreamObjectVersion.Type.SkelMeshSectionVisibleInRayTracingFlagAdded)
+                        _ = Ar.ReadBoolean();
+                    _ = Ar.ReadBoolean();
+                    _ = Ar.Read<int>();
+                    _ = Ar.Read<short>();
+                    _ = Ar.Read<FClothingSectionData>();
+                }
+                return 0;
+            });
+        }
+
         if (skelMeshVer < FSkeletalMeshCustomVersion.Type.SplitModelAndRenderData)
         {
             Indices = new FMultisizeIndexContainer(Ar);
@@ -165,7 +188,7 @@ public FStaticLODModel(FAssetArchive Ar, bool bHasVertexColors) : this()
         else
         {
             // UE4.19+ uses 32-bit index buffer (for editor data)
-            Indices = new FMultisizeIndexContainer(Ar.ReadBulkArray<uint>());
+            Indices = new FMultisizeIndexContainer(Ar.ReadArray<uint>());
         }

         if (Ar.Ver < EUnrealEngineObjectUE3Version.DeprecatedOldLodformat)
@@ -178,6 +201,17 @@ public FStaticLODModel(FAssetArchive Ar, bool bHasVertexColors) : this()

         ActiveBoneIndices = Ar.ReadArray<short>();

+        if (!stripDataFlags.IsEditorDataStripped() && FUE5MainStreamObjectVersion.Get(Ar) >= FUE5MainStreamObjectVersion.Type.SkeletalMeshLODModelMeshInfo)
+        {
+            var importedMeshInfoCount = Ar.Read<int>();
+            for (var index = 0; index < importedMeshInfoCount; index++)
+            {
+                Ar.SkipFName();
+                _ = Ar.Read<int>();
+                _ = Ar.Read<int>();
+            }
+        }
+
         if (Ar.Ver >= EUnrealEngineObjectUE3Version.DeprecatedOldLodformat)
         {
             if (skelMeshVer < FSkeletalMeshCustomVersion.Type.CombineSectionWithChunk)
@@ -192,7 +226,23 @@ public FStaticLODModel(FAssetArchive Ar, bool bHasVertexColors) : this()

         RequiredBones = Ar.ReadArray<short>();
         if (!stripDataFlags.IsEditorDataStripped())
-            RawPointIndices = new FIntBulkData(Ar);
+        {
+            if (FUE5ReleaseStreamObjectVersion.Get(Ar) < FUE5ReleaseStreamObjectVersion.Type.RemoveSkeletalMeshLODModelBulkDatas)
+            {
+                RawPointIndices = new FIntBulkData(Ar);
+            }
+            else
+            {
+                _ = Ar.ReadArray<uint>();
+            }
+
+            if (FEditorObjectVersion.Get(Ar) >= FEditorObjectVersion.Type.SkeletalMeshMoveEditorSourceDataToPrivateAsset)
+            {
+                _ = Ar.ReadFString();
+                _ = Ar.ReadBoolean();
+                _ = Ar.ReadBoolean();
+            }
+        }

         if (Ar.Game != GAME_StateOfDecay2 && Ar.Ver >= EUnrealEngineObjectUE4Version.ADD_SKELMESH_MESHTOIMPORTVERTEXMAP)
         {
@@ -324,6 +374,24 @@ public FStaticLODModel(FAssetArchive Ar, bool bHasVertexColors) : this()
             }
         }

+        if (skelMeshVer >= FSkeletalMeshCustomVersion.Type.SkinWeightProfiles)
+        {
+            var profileCount = Ar.Read<int>();
+            for (var profileIndex = 0; profileIndex < profileCount; profileIndex++)
+            {
+                Ar.SkipFName();
+                var skinWeightCount = Ar.Read<int>();
+                var usesUnlimitedInfluences = FAnimObjectVersion.Get(Ar) >= FAnimObjectVersion.Type.UnlimitedBoneInfluences;
+                var uses16BitWeights = FUE5MainStreamObjectVersion.Get(Ar) >= FUE5MainStreamObjectVersion.Type.IncreasedSkinWeightPrecision;
+                var influenceCount = usesUnlimitedInfluences ? 12 : 8;
+                var influenceSize = usesUnlimitedInfluences ? uses16BitWeights ? 4 : 3 : FAnimObjectVersion.Get(Ar) >= FAnimObjectVersion.Type.IncreaseBoneIndexLimitPerChunk ? 3 : 2;
+                Ar.Position += skinWeightCount * influenceCount * influenceSize;
+
+                var sourceInfluenceCount = Ar.Read<int>();
+                Ar.Position += sourceInfluenceCount * (sizeof(float) + sizeof(uint) + sizeof(ushort));
+            }
+        }
+
         if (Ar.Game == GAME_SeaOfThieves)
         {
             _ = new FMultisizeIndexContainer(Ar);
diff --git a/CUE4Parse/UE4/Assets/Exports/SkeletalMesh/USkeletalMesh.cs b/CUE4Parse/UE4/Assets/Exports/SkeletalMesh/USkeletalMesh.cs
index 0be7a79..a12695a 100644
--- a/CUE4Parse/UE4/Assets/Exports/SkeletalMesh/USkeletalMesh.cs
+++ b/CUE4Parse/UE4/Assets/Exports/SkeletalMesh/USkeletalMesh.cs
@@ -109,6 +109,10 @@ public override void Deserialize(FAssetArchive Ar, long validPos)
         {
             if (!stripDataFlags.IsEditorDataStripped())
             {
+                if (FFortniteMainBranchObjectVersion.Get(Ar) >= FFortniteMainBranchObjectVersion.Type.AllowSkeletalMeshToReduceTheBaseLOD)
+                {
+                    _ = new FStripDataFlags(Ar);
+                }
                 LODModels = Ar.ReadArray(() => new FStaticLODModel(Ar, bHasVertexColors));
             }

diff --git a/CUE4Parse-Conversion/Textures/TextureDecoder.cs b/CUE4Parse-Conversion/Textures/TextureDecoder.cs
--- a/CUE4Parse-Conversion/Textures/TextureDecoder.cs
+++ b/CUE4Parse-Conversion/Textures/TextureDecoder.cs
@@ -240,7 +240,7 @@ private static void DecodeTexture(UTexture texture, FTexture2DMipMap? mip, EText
         sizeY = mip.SizeY;
         sizeZ = mip.SizeZ;

-        if (texture is UVolumeTexture or UTextureCube)
+        if (texture is UVolumeTexture or UTextureCube or UTextureCubeArray)
         {
             var slices = texture.PlatformData.GetNumSlices();
             if (texture.Owner?.Provider?.Versions.Game == EGame.GAME_Borderlands4)
diff --git a/CUE4Parse-Conversion/Writers/Gltf/Gltf.cs b/CUE4Parse-Conversion/Writers/Gltf/Gltf.cs
index 10bfc73..b1d220e 100644
--- a/CUE4Parse-Conversion/Writers/Gltf/Gltf.cs
+++ b/CUE4Parse-Conversion/Writers/Gltf/Gltf.cs
@@ -68,6 +68,9 @@ public Gltf(string name, MeshLodDto<SkinnedMeshVertex> lod, bool exportMorphTarg
                 var verts = morphBuilder.Vertices.ToArray();
                 foreach (var delta in morphModel.Vertices)
                 {
+                    // A morph LOD model can carry a source index past this LOD's shorter vertex
+                    // array (Ada_FaceMesh LOD1 has one), which used to fail the whole export.
+                    if (delta.SourceIdx < 0 || delta.SourceIdx >= lod.Vertices.Length) continue;
                     var vert = lod.Vertices[delta.SourceIdx];
                     var srcVert = new VertexPositionNormalTangent(SwapYZ(vert.Position * UnitScale),SwapYZAndNormalize((FVector)vert.Normal) , SwapYZAndNormalize((Vector4)vert.Tangent));
                     var index = FindVert(srcVert, verts);
`;

export const CUE4PARSE_PROJECT = String.raw`<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>
  <ItemGroup>
    <ProjectReference Include="../CUE4Parse/CUE4Parse.csproj" />
    <ProjectReference Include="../CUE4Parse-Conversion/CUE4Parse-Conversion.csproj" />
    <PackageReference Include="Microsoft.Bcl.Memory" />
    <PackageReference Include="SkiaSharp.NativeAssets.Linux.NoDependencies" />
  </ItemGroup>
</Project>
`;

export const CUE4PARSE_PROGRAM = String.raw`using System.Buffers.Binary;
using System.Runtime.InteropServices;
using System.Text;
using CUE4Parse.FileProvider;
using CUE4Parse.MappingsProvider.Usmap;
using CUE4Parse.Compression;
using CUE4Parse.UE4.Assets;
using CUE4Parse.UE4.Assets.Exports;
using CUE4Parse.UE4.Assets.Exports.SkeletalMesh;
using CUE4Parse.UE4.Assets.Exports.StaticMesh;
using CUE4Parse.UE4.Assets.Exports.Texture;
using CUE4Parse.UE4.Assets.Exports.Material;
using CUE4Parse.UE4.Assets.Exports.Sound;
using CUE4Parse.UE4.Assets.Exports.Engine;
using CUE4Parse.UE4.Assets.Exports.Engine.Font;
using CUE4Parse.UE4.Assets.Exports.Actor;
using CUE4Parse.UE4.Assets.Exports.Component;
using CUE4Parse.UE4.Assets.Exports.Component.Lights;
using CUE4Parse.UE4.Assets.Exports.Component.SkeletalMesh;
using CUE4Parse.UE4.Assets.Exports.Component.StaticMesh;
using CUE4Parse.UE4.Assets.Exports.Component.TextRender;
using CUE4Parse.UE4.Objects.Engine;
using CUE4Parse.UE4.Objects.UObject;
using CUE4Parse.UE4.Assets.Objects;
using CUE4Parse.UE4.Assets.Readers;
using CUE4Parse.UE4.Readers;
using CUE4Parse.UE4.Objects.Core.Compression;
using CUE4Parse.UE4.Objects.Core.i18N;
using CUE4Parse.UE4.Objects.Core.Math;
using CUE4Parse.UE4.Versions;
using CUE4Parse_Conversion;
using CUE4Parse_Conversion.Exporters;
using CUE4Parse_Conversion.Options;
using CUE4Parse_Conversion.Sounds;
using Newtonsoft.Json;

if (args.Contains("--version")) { Console.WriteLine("threenative-cue4parse ${CUE4PARSE_SOURCE.version}"); return; }
if (args.Length < 3 || !args.Contains("--export-dir")) throw new ArgumentException("usage: converter SOURCE --export-dir OUTPUT [--filter NAME] [--lods 0,1]");
var root = Path.GetFullPath(args[0]);
var output = Path.GetFullPath(args[Array.IndexOf(args, "--export-dir") + 1]);
var filterAt = Array.IndexOf(args, "--filter");
var filter = filterAt >= 0 ? args[filterAt + 1] : null;
// Source-model LODs of a skeletal mesh to export, as indices into its source model array.
var lodsAt = Array.IndexOf(args, "--lods");
var requestedLods = lodsAt >= 0
    ? args[lodsAt + 1].Split(',', StringSplitOptions.RemoveEmptyEntries)
        .Select(part => int.TryParse(part.Trim(), out var lod) ? lod : -1)
        .Where(lod => lod >= 0)
        .Distinct()
        .OrderBy(lod => lod)
        .ToArray()
    : new[] { 0 };
if (requestedLods.Length == 0) throw new ArgumentException("--lods needs at least one LOD index");
bool MatchesFilter(string key)
{
    if (filter is null) return true;
    static string Normalize(string value)
    {
        var normalized = value.Replace('\\', '/').Trim('/');
        foreach (var suffix in new[] { ".uasset", ".umap" })
            if (normalized.EndsWith(suffix, StringComparison.OrdinalIgnoreCase)) return normalized[..^suffix.Length];
        return normalized;
    }
    var normalizedKey = Normalize(key);
    var normalizedFilter = Normalize(filter);
    return Path.GetFileName(normalizedKey).Equals(Path.GetFileName(normalizedFilter), StringComparison.OrdinalIgnoreCase) &&
        (normalizedFilter.IndexOf('/') < 0 || normalizedKey.EndsWith(normalizedFilter, StringComparison.OrdinalIgnoreCase));
}
Directory.CreateDirectory(Path.Combine(output, "Meshes"));
Directory.CreateDirectory(Path.Combine(output, "Textures"));
Directory.CreateDirectory(Path.Combine(output, "Cubemaps"));
Directory.CreateDirectory(Path.Combine(output, "Audio"));
Directory.CreateDirectory(Path.Combine(output, "Data"));
Directory.CreateDirectory(Path.Combine(output, "Multidimensional"));
Directory.CreateDirectory(Path.Combine(output, "Fonts"));
Directory.CreateDirectory(Path.Combine(output, "Scenes"));
Directory.CreateDirectory(Path.Combine(output, "Sprites"));
Directory.CreateDirectory(Path.Combine(output, "TileMaps"));
ObjectTypeRegistry.RegisterClass(typeof(USkeletalMeshEditorData));

var engineAt = Array.IndexOf(args, "--engine");
var game = engineAt >= 0 ? ParseGame(args[engineAt + 1]) : DetectGame(root);
var provider = new DefaultFileProvider(root, SearchOption.AllDirectories, new VersionContainer(game), StringComparer.OrdinalIgnoreCase);
var mappings = Directory.EnumerateFiles(root, "*.usmap", SearchOption.AllDirectories).ToArray();
if (mappings.Length > 1) throw new InvalidDataException($"Found {mappings.Length} .usmap files. Keep only the mapping that matches this asset's game/version.");
if (mappings.Length == 1) provider.MappingsContainer = new FileUsmapTypeMappingsProvider(mappings[0]);
provider.Initialize();
provider.PostMount();
var exported = 0;
var mappingRequired = false;
Exception? lastLoadError = null;
var selectedExportTypes = new HashSet<string>(StringComparer.Ordinal);
var exportedMaterials = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
var exportedSprites = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
var exportedMeshes = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
var assetLookupDiagnostics = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

async Task<bool> ExportPaperSpriteAsync(UPaperSprite sprite)
{
    var identity = sprite.GetPathName();
    if (!exportedSprites.Add(identity)) return true;
    var textureIndex = sprite.BakedSourceTexture ?? sprite.GetOrDefault<FPackageIndex>("SourceTexture");
    var textureName = textureIndex?.Name ?? "";
    if (textureName.Length == 0 || textureName == "None") return false;
    string? emitted = null;
    if (textureIndex?.Load<UTexture2D>() is { } texture)
    {
        var session = new ExportSession { MaxDegreeOfParallelism = 1 };
        session.Add(texture);
        var results = await session.RunAsync(output, new ExportOptions());
        emitted = results.SelectMany(result => result.DiskFilePaths ?? [])
            .FirstOrDefault(path => path.EndsWith(".png", StringComparison.OrdinalIgnoreCase));
    }
    var textureTarget = Path.Combine(output, "Sprites", sprite.Name + ".png");
    if (emitted is not null && File.Exists(emitted) && !Path.GetFullPath(emitted).Equals(Path.GetFullPath(textureTarget), StringComparison.OrdinalIgnoreCase))
        File.Copy(emitted, textureTarget, true);
    if (!File.Exists(textureTarget))
    {
        var textureFile = Directory.EnumerateFiles(root, textureName + ".uasset", SearchOption.AllDirectories).FirstOrDefault();
        if (textureFile is null || new FileInfo(textureFile).Length > 1_073_741_824) return false;
        var packageBytes = await File.ReadAllBytesAsync(textureFile);
        var sourcePng = ExtractLargestPng(packageBytes) ?? ExtractCompressedPayloadPng(packageBytes);
        if (sourcePng is null) return false;
        await File.WriteAllBytesAsync(textureTarget, NormalizeSourcePng(sourcePng, LoadAssetByName<UTexture>(textureName)));
    }
    var descriptor = new {
        Name = sprite.Name,
        PackagePath = identity,
        Texture = Path.GetFileName(textureTarget),
        TextureName = textureName,
        SourceUV = new[] { sprite.BakedSourceUV.X, sprite.BakedSourceUV.Y },
        SourceDimension = new[] { sprite.BakedSourceDimension.X, sprite.BakedSourceDimension.Y },
        PixelsPerUnrealUnit = sprite.PixelsPerUnrealUnit,
        Vertices = sprite.BakedRenderData.Select(vertex => new[] { vertex.X, vertex.Y, vertex.Z, vertex.W }).ToArray()
    };
    await File.WriteAllTextAsync(
        Path.Combine(output, "Sprites", sprite.Name + ".sprite.json"),
        JsonConvert.SerializeObject(descriptor, Formatting.Indented));
    return true;
}

UPaperSprite? ResolveFlipbookSprite(USceneComponent component, UObject actor, out bool fromBlueprintTemplate)
{
    fromBlueprintTemplate = false;
    FPackageIndex? sourceFlipbook = component.GetOrDefault<FPackageIndex?>("SourceFlipbook");
    if ((sourceFlipbook is null or { IsNull: true }) && actor.ExportType.EndsWith("_C", StringComparison.Ordinal))
    {
        var blueprintName = actor.ExportType[..^2];
        var blueprintKey = provider.Files.Keys.FirstOrDefault(candidate =>
            Path.GetFileNameWithoutExtension(candidate).Equals(blueprintName, StringComparison.OrdinalIgnoreCase));
        if (blueprintKey is not null)
        {
            try
            {
                var blueprintPackage = provider.LoadPackage(blueprintKey);
                var template = blueprintPackage.GetExports().FirstOrDefault(candidate =>
                    candidate.ExportType.Contains("PaperFlipbookComponent", StringComparison.OrdinalIgnoreCase) &&
                    candidate.Name.Equals(component.Name, StringComparison.OrdinalIgnoreCase));
                template ??= blueprintPackage.GetExports().FirstOrDefault(candidate =>
                    candidate.ExportType.Contains("PaperFlipbookComponent", StringComparison.OrdinalIgnoreCase));
                sourceFlipbook = template?.GetOrDefault<FPackageIndex?>("SourceFlipbook");
                fromBlueprintTemplate = sourceFlipbook is { IsNull: false };
            }
            catch { }
        }
    }
    if ((sourceFlipbook is null or { IsNull: true }) || sourceFlipbook.Load<UObject>() is not { } flipbook) return null;
    var firstFrame = flipbook.GetOrDefault<FStructFallback[]>("KeyFrames", []).FirstOrDefault();
    return firstFrame?.GetOrDefault<FPackageIndex>("Sprite")?.Load<UPaperSprite>();
}

FPackageIndex ResolveStaticMesh(USceneComponent component) =>
    component is UStaticMeshComponent staticComponent
        ? staticComponent.GetStaticMesh()
        : component.GetOrDefault("StaticMesh", new FPackageIndex());

FPackageIndex ResolveSkeletalMesh(USceneComponent component) =>
    component is USkinnedMeshComponent skinnedComponent
        ? skinnedComponent.GetSkeletalMesh()
        : component.GetOrDefault("SkeletalMesh", component.GetOrDefault("SkinnedAsset", new FPackageIndex()));

async Task ExportMaterialAsync(string initialName)
{
    var pending = new Queue<string>();
    pending.Enqueue(initialName);
    while (pending.TryDequeue(out var materialName))
    {
        if (!exportedMaterials.Add(materialName)) continue;
        var materialKey = provider.Files.Keys.FirstOrDefault(candidate => Path.GetFileNameWithoutExtension(candidate).Equals(materialName, StringComparison.OrdinalIgnoreCase));
        if (materialKey is null) continue;
        IPackage package;
        try { package = provider.LoadPackage(materialKey); } catch { continue; }
        var exports = package.GetExports().ToArray();
        var material = exports.OfType<UMaterialInterface>().FirstOrDefault(candidate => candidate.Name.Equals(materialName, StringComparison.OrdinalIgnoreCase));
        if (material is null) continue;

        var references = new List<(string Parameter, string Texture)>();
        if (material is UMaterialInstanceConstant instance)
        {
            foreach (var parameter in instance.TextureParameterValues)
                if (!parameter.ParameterValue.IsNull && parameter.ParameterValue.Name != "None")
                    references.Add((parameter.Name, parameter.ParameterValue.Name));
        }
        foreach (var expression in exports.OfType<UMaterialExpressionTextureBase>())
        {
            if (!expression.TryGetValue<FPackageIndex>(out var texture, "Texture") || texture.IsNull || texture.Name == "None") continue;
            var parameter = expression is UMaterialExpressionTextureSampleParameter named && !named.ParameterName.IsNone
                ? named.ParameterName.Text
                : texture.Name;
            references.Add((parameter, texture.Name));
        }

        var parentName = "";
        if (material.TryGetValue<FPackageIndex>(out var parent, "Parent") && !parent.IsNull && parent.Name != "None")
        {
            parentName = parent.Name;
            pending.Enqueue(parentName);
        }

        references = references.Distinct().ToList();
        var materialDirectory = Path.Combine(output, "Materials");
        Directory.CreateDirectory(materialDirectory);
        var mat = string.Join("\n", references.Select((entry, index) => $"Other[{index}]={entry.Texture}")) + "\n";
        await File.WriteAllTextAsync(Path.Combine(materialDirectory, materialName + ".mat"), mat);
        var props = new StringBuilder();
        if (parentName.Length > 0) props.AppendLine($"Parent = Material'{parentName}.{parentName}'");
        if (material is UMaterial baseMaterial)
        {
            props.AppendLine($"BlendMode = {baseMaterial.BlendMode}");
            props.AppendLine($"TwoSided = {baseMaterial.TwoSided.ToString().ToLowerInvariant()}");
            props.AppendLine($"OpacityMaskClipValue = {baseMaterial.OpacityMaskClipValue.ToString(System.Globalization.CultureInfo.InvariantCulture)}");
        }
        else if (material is UMaterialInstance materialInstance && materialInstance.BasePropertyOverrides is { } overrides)
        {
            props.AppendLine($"BlendMode = {overrides.BlendMode}");
            props.AppendLine($"OpacityMaskClipValue = {overrides.OpacityMaskClipValue.ToString(System.Globalization.CultureInfo.InvariantCulture)}");
        }
        props.AppendLine($"CollectedTextureParameters[{references.Count}] =");
        props.AppendLine("{");
        for (var index = 0; index < references.Count; index++)
        {
            var entry = references[index];
            props.AppendLine($"    CollectedTextureParameters[{index}] =");
            props.AppendLine("    {");
            props.AppendLine($"        Texture = Texture2D'{entry.Texture}.{entry.Texture}'");
            props.AppendLine($"        Name = {entry.Parameter}");
            props.AppendLine("        Group = None");
            props.AppendLine("    }");
        }
        props.AppendLine("}");
        await File.WriteAllTextAsync(Path.Combine(materialDirectory, materialName + ".props.txt"), props.ToString());

        foreach (var textureName in references.Select(entry => entry.Texture).Distinct(StringComparer.OrdinalIgnoreCase))
        {
            var target = Path.Combine(materialDirectory, textureName + ".png");
            // Materials share the same 8K textures, so skip decoding/encoding one another material already wrote.
            if (File.Exists(target)) continue;
            var textureFile = Directory.EnumerateFiles(root, textureName + ".uasset", SearchOption.AllDirectories).FirstOrDefault();
            if (textureFile is null || new FileInfo(textureFile).Length > 1_073_741_824) continue;
            // UE5.1+ keeps large source art inside an FCompressedBuffer payload, like every other
            // editor texture site; without this fallback a level's materials lost their textures.
            var textureBytes = await File.ReadAllBytesAsync(textureFile);
            var sourcePng = ExtractLargestPng(textureBytes) ?? ExtractCompressedPayloadPng(textureBytes);
            if (sourcePng is not null) await File.WriteAllBytesAsync(target, NormalizeSourcePng(sourcePng, LoadAssetByName<UTexture>(textureName)));
        }
    }
}

async Task<bool> ExportStaticMeshAsync(UStaticMesh mesh)
{
    var identity = mesh.GetPathName();
    var target = Path.Combine(output, "Meshes", mesh.Name + ".glb");
    if (!exportedMeshes.Add(identity)) return File.Exists(target);
    // An uncooked UE5 package deserializes StaticMaterials as a tagged property, after the point
    // UStaticMesh stops reading editor packages.
    var staticMaterials = mesh.StaticMaterials.Length > 0
        ? mesh.StaticMaterials
        : mesh.GetOrDefault("StaticMaterials", Array.Empty<FStaticMaterial>());
    if (mesh.RenderData?.LODs is not { Length: > 0 })
    {
        // Uncooked editor mesh: no render data, only the source model. Decode LOD0's
        // FMeshDescription from the package trailer instead.
        if (!ExportEditorStaticMesh(mesh, staticMaterials, target))
        {
            exportedMeshes.Remove(identity);
            return false;
        }
    }
    else
    {
        var session = new ExportSession { MaxDegreeOfParallelism = 1 };
        session.Add(mesh);
        var results = await session.RunAsync(output, new ExportOptions(meshFormat: EMeshFormat.Gltf2, exportMaterials: false));
        var emitted = results.SelectMany(result => result.DiskFilePaths ?? [])
            .FirstOrDefault(path => path.EndsWith(".glb", StringComparison.OrdinalIgnoreCase));
        if (emitted is null || !File.Exists(emitted))
        {
            exportedMeshes.Remove(identity);
            return false;
        }
        if (!Path.GetFullPath(emitted).Equals(Path.GetFullPath(target), StringComparison.OrdinalIgnoreCase)) File.Move(emitted, target, true);
    }
    foreach (var materialName in staticMaterials.Select(slot => slot.MaterialInterface?.Name).Where(name => !string.IsNullOrWhiteSpace(name)).Distinct(StringComparer.OrdinalIgnoreCase))
        await ExportMaterialAsync(materialName!);
    return true;
}

bool ExportEditorStaticMesh(UStaticMesh mesh, FStaticMaterial[] staticMaterials, string target)
{
    // Same-named meshes in different folders: prefer the key whose last two path segments match
    // the owning package's.
    var packageTail = string.Join('/', (mesh.Owner?.Name ?? mesh.Name).Split('/').TakeLast(2));
    var packageKey = provider.Files.Keys
        .Where(candidate => candidate.EndsWith(".uasset", StringComparison.OrdinalIgnoreCase) &&
            Path.GetFileNameWithoutExtension(candidate).Equals(mesh.Name, StringComparison.OrdinalIgnoreCase))
        .OrderByDescending(candidate => Path.ChangeExtension(candidate.Replace('\\', '/'), null)
            .EndsWith(packageTail, StringComparison.OrdinalIgnoreCase))
        .FirstOrDefault();
    if (packageKey is null || !provider.Files.TryGetValue(packageKey, out var file) || file.Size > 2_000_000_000L)
    {
        assetLookupDiagnostics[mesh.Name] = "uncooked mesh package was not mounted";
        return false;
    }
    var editorMesh = ReadLargestMeshDescription(file.Read());
    if (editorMesh is null)
    {
        assetLookupDiagnostics[mesh.Name] = "uncooked mesh has no readable FMeshDescription source model";
        return false;
    }
    // Same material naming as the cooked glTF writer (MeshMaterialDto.SlotName): the material
    // interface's name, else the imported slot name.
    var materialNames = editorMesh.GroupSlots.Select((slot, index) =>
    {
        var match = staticMaterials.FirstOrDefault(material =>
            string.Equals(material.ImportedMaterialSlotName?.Text, slot, StringComparison.OrdinalIgnoreCase) ||
            string.Equals(material.MaterialSlotName.Text, slot, StringComparison.OrdinalIgnoreCase))
            ?? (index < staticMaterials.Length ? staticMaterials[index] : null);
        return match?.MaterialInterface?.Name ?? match?.ImportedMaterialSlotName?.Text ?? slot;
    }).ToArray();
    WriteEditorMeshGlb(editorMesh, materialNames, mesh.Name, target);
    return File.Exists(target);
}

T? LoadAssetByName<T>(string name) where T : UObject
{
    var assetKeys = provider.Files.Keys.Where(candidate =>
        Path.GetFileNameWithoutExtension(candidate).Equals(name, StringComparison.OrdinalIgnoreCase)).ToArray();
    if (assetKeys.Length == 0)
    {
        assetLookupDiagnostics[name] = "no basename-matching package was mounted";
        return null;
    }
    foreach (var assetKey in assetKeys)
    {
        try
        {
            var exports = provider.LoadPackage(assetKey).GetExports().ToArray();
            if (exports.OfType<T>().FirstOrDefault() is { } asset) return asset;
            assetLookupDiagnostics[name] = $"{assetKey} loaded as {string.Join(", ", exports.Select(asset => asset.GetType().Name).Distinct())}";
        }
        catch (Exception error)
        {
            var detail = $"{assetKey}: {error.GetType().Name}: {error.Message}";
            assetLookupDiagnostics[name] = detail.Length <= 512 ? detail : detail[..512];
        }
    }
    return null;
}

async Task<bool> ExportSkeletalMeshAsync(USkeletalMesh mesh)
{
    var identity = mesh.GetPathName();
    var target = Path.Combine(output, "Meshes", mesh.Name + ".glb");
    if (!exportedMeshes.Add(identity)) return File.Exists(target);
    // EMeshQuality.Highest, the export default, keeps only the first source model. Anything but a
    // lone LOD0 therefore has to decode every LOD before the requested ones can be selected.
    var quality = requestedLods.Length > 1 ? EMeshQuality.All : EMeshQuality.Highest;
    var session = new ExportSession { MaxDegreeOfParallelism = 1 };
    session.Add(mesh);
    var results = await session.RunAsync(output, new ExportOptions(meshFormat: EMeshFormat.Gltf2, exportMaterials: false, meshQuality: quality));
    var diskPaths = results.SelectMany(result => result.DiskFilePaths ?? []).ToArray();
    // The glTF writer names every LOD after its source index: LOD0 plain, the rest _LOD<n>.
    var wanted = requestedLods.ToHashSet();
    var glbByLod = new Dictionary<int, string>();
    foreach (var path in diskPaths.Where(path => path.EndsWith(".glb", StringComparison.OrdinalIgnoreCase)))
    {
        var stem = Path.GetFileNameWithoutExtension(path);
        var marker = stem.LastIndexOf("_LOD", StringComparison.Ordinal);
        var lod = marker < 0 || !int.TryParse(stem[(marker + 4)..], out var parsed) ? 0 : parsed;
        if (wanted.Contains(lod)) glbByLod[lod] = path;
    }
    if (glbByLod.Count == 0)
    {
        exportedMeshes.Remove(identity);
        return false;
    }
    foreach (var (lod, path) in glbByLod)
    {
        var lodTarget = Path.Combine(output, "Meshes", lod == 0 ? mesh.Name + ".glb" : mesh.Name + "_LOD" + lod + ".glb");
        if (!Path.GetFullPath(path).Equals(Path.GetFullPath(lodTarget), StringComparison.OrdinalIgnoreCase)) File.Move(path, lodTarget, true);
    }
    // A DNA asset reaches the session as an inner object of the mesh package, so the session wrote it
    // under the mesh's own package path. Promote it beside the LOD0 GLB.
    var dna = diskPaths.FirstOrDefault(path => path.EndsWith(".dna", StringComparison.OrdinalIgnoreCase));
    if (dna is not null)
    {
        var dnaTarget = Path.Combine(output, "Meshes", mesh.Name + ".dna");
        if (!Path.GetFullPath(dna).Equals(Path.GetFullPath(dnaTarget), StringComparison.OrdinalIgnoreCase)) File.Move(dna, dnaTarget, true);
    }
    foreach (var materialName in mesh.SkeletalMaterials.Select(slot => slot.Material?.Name).Where(name => !string.IsNullOrWhiteSpace(name)).Distinct(StringComparer.OrdinalIgnoreCase))
        await ExportMaterialAsync(materialName!);
    return true;
}

foreach (var key in provider.Files.Keys.Where(key =>
    (key.EndsWith(".uasset", StringComparison.OrdinalIgnoreCase) || key.EndsWith(".umap", StringComparison.OrdinalIgnoreCase)) && MatchesFilter(key)))
{
    IPackage package;
    try { package = provider.LoadPackage(key); }
    catch (Exception error)
    {
        if (error.ToString().Contains("mapping file is missing", StringComparison.OrdinalIgnoreCase)) mappingRequired = true;
        lastLoadError = error;
        continue;
    }
    foreach (var export in package.GetExports()) selectedExportTypes.Add(export.GetType().Name);
    foreach (var mesh in package.GetExports().OfType<USkeletalMesh>())
    {
        if (await ExportSkeletalMeshAsync(mesh)) exported++;
    }
    foreach (var mesh in package.GetExports().OfType<UStaticMesh>())
    {
        if (await ExportStaticMeshAsync(mesh)) exported++;
    }
    foreach (var material in package.GetExports().OfType<UMaterialInterface>())
    {
        await ExportMaterialAsync(material.Name);
        exported++;
    }
    foreach (var world in package.GetExports().OfType<UWorld>())
    {
        var level = world.PersistentLevel.Load<ULevel>();
        if (level?.Actors is null) continue;
        PropertyUtil.SearchPropertyInTemplate = true;
        var actors = new List<object>();
        var texts = new List<object>();
        var lights = new List<object>();
        var omittedActors = new List<object>();
        var groupedSpriteInstances = new Dictionary<string, List<object>>(StringComparer.OrdinalIgnoreCase);
        var blueprintComponents = 0;
        var hasCamera = false;
        double cameraX = 0, cameraY = 0, cameraZ = 0, cameraPitch = 0, cameraYaw = 0, cameraRoll = 0;
        foreach (var actorIndex in level.Actors)
        {
            var actor = actorIndex?.Load<UObject>();
            if (actor is null) continue;
            var componentReferences = new List<FPackageIndex?> {
                actor.GetOrDefault<FPackageIndex?>("RootComponent"),
                actor.GetOrDefault<FPackageIndex?>("RenderComponent"),
                actor.GetOrDefault<FPackageIndex?>("PaperFlipbook"),
                actor.GetOrDefault<FPackageIndex?>("CameraComponent"),
                actor.GetOrDefault<FPackageIndex?>("TextRender"),
                actor.GetOrDefault<FPackageIndex?>("LightComponent"),
                actor.GetOrDefault<FPackageIndex?>("PointLightComponent"),
                actor.GetOrDefault<FPackageIndex?>("SpotLightComponent"),
                actor.GetOrDefault<FPackageIndex?>("RectLightComponent"),
                actor.GetOrDefault<FPackageIndex?>("DirectionalLightComponent"),
                actor.GetOrDefault<FPackageIndex?>("SkyLightComponent"),
                actor.GetOrDefault<FPackageIndex?>("Mesh"),
                actor.GetOrDefault<FPackageIndex?>("StaticMeshComponent"),
                actor.GetOrDefault<FPackageIndex?>("SkeletalMeshComponent")
            };
            componentReferences.AddRange(actor.GetOrDefault<FPackageIndex[]>("BlueprintCreatedComponents", []));
            componentReferences.AddRange(actor.GetOrDefault<FPackageIndex[]>("InstanceComponents", []));
            componentReferences = componentReferences.Where(reference => reference is { IsNull: false }).Distinct().ToList();
            if (actor.GetOrDefault<FPackageIndex?>("CameraComponent")?.Load<USceneComponent>() is { } cameraComponent)
            {
                var cameraTransform = cameraComponent.GetRelativeTransform();
                var cameraParent = cameraComponent.GetOrDefault<FPackageIndex?>("AttachParent")?.Load<USceneComponent>();
                for (var parentDepth = 0; cameraParent is not null && parentDepth < 64; parentDepth++)
                {
                    cameraTransform *= cameraParent.GetRelativeTransform();
                    cameraParent = cameraParent.GetOrDefault<FPackageIndex?>("AttachParent")?.Load<USceneComponent>();
                }
                var cameraRotation = cameraTransform.Rotator();
                hasCamera = true;
                cameraX = cameraTransform.Translation.X; cameraY = cameraTransform.Translation.Y; cameraZ = cameraTransform.Translation.Z;
                cameraPitch = cameraRotation.Pitch; cameraYaw = cameraRotation.Yaw; cameraRoll = cameraRotation.Roll;
            }
            foreach (var componentReference in componentReferences)
            {
                if (componentReference?.Load<USceneComponent>() is not { } component) continue;
                var transform = component.GetRelativeTransform();
                var parentComponent = component.GetOrDefault<FPackageIndex?>("AttachParent")?.Load<USceneComponent>();
                for (var parentDepth = 0; parentComponent is not null && parentDepth < 64; parentDepth++)
                {
                    transform *= parentComponent.GetRelativeTransform();
                    parentComponent = parentComponent.GetOrDefault<FPackageIndex?>("AttachParent")?.Load<USceneComponent>();
                }
                var rotation = transform.Rotator();
                var actorName = actor is AActor labeled && !string.IsNullOrWhiteSpace(labeled.ActorLabel) ? labeled.ActorLabel : actor.Name;
                if (component is USkyLightComponent)
                {
                    omittedActors.Add(new { actor = actorName, component = component.Name, sourceClass = component.ExportType, reason = "SkyLight environment capture is not reconstructable as a punctual Three.js light" });
                    continue;
                }
                if (component is ULightComponentBase light)
                {
                    var lightType = component is UDirectionalLightComponent ? "directional" : component is USpotLightComponent ? "spot" : component is URectLightComponent ? "rect" : "point";
                    var localLight = component as ULocalLightComponent;
                    var spotLight = component as USpotLightComponent;
                    var rectLight = component as URectLightComponent;
                    var temperatureLight = component as ULightComponent;
                    var lightColor = light.GetLightColor();
                    lights.Add(new {
                        name = actorName + "/" + component.Name,
                        type = lightType,
                        location = new { x = transform.Translation.X, y = transform.Translation.Y, z = transform.Translation.Z },
                        rotation = new { pitch = rotation.Pitch, yaw = rotation.Yaw, roll = rotation.Roll },
                        color = new[] { lightColor.R, lightColor.G, lightColor.B },
                        intensity = light.Intensity,
                        range = (localLight?.AttenuationRadius ?? 0f) * 0.01f,
                        innerConeAngle = spotLight?.InnerConeAngle ?? 0f,
                        outerConeAngle = spotLight?.OuterConeAngle ?? 44f,
                        temperature = temperatureLight?.Temperature ?? 6500f,
                        useTemperature = temperatureLight?.bUseTemperature ?? false,
                        sourceWidth = (rectLight?.SourceWidth ?? 0f) * 0.01f,
                        sourceHeight = (rectLight?.SourceHeight ?? 0f) * 0.01f
                    });
                    continue;
                }
                if (component.ExportType.Contains("PaperGroupedSpriteComponent", StringComparison.OrdinalIgnoreCase))
                {
                    var before = groupedSpriteInstances.Sum(group => group.Value.Count);
                    foreach (var instance in component.GetOrDefault<FStructFallback[]>("PerInstanceSpriteData", []))
                    {
                        var spriteIndex = instance.GetOrDefault<FPackageIndex?>("SourceSprite");
                        if (spriteIndex is null or { IsNull: true } || spriteIndex.Load<UPaperSprite>() is not { } sprite) continue;
                        await ExportPaperSpriteAsync(sprite);
                        var matrix = instance.GetOrDefault<FMatrix>("Transform", FMatrix.Identity);
                        var instanceTransform = new FTransform(
                            new FVector(matrix.M00, matrix.M01, matrix.M02),
                            new FVector(matrix.M10, matrix.M11, matrix.M12),
                            new FVector(matrix.M20, matrix.M21, matrix.M22),
                            new FVector(matrix.M30, matrix.M31, matrix.M32)) * transform;
                        var instanceRotation = instanceTransform.Rotator();
                        var groupKey = actorName + "/" + component.Name + "/" + sprite.Name;
                        if (!groupedSpriteInstances.TryGetValue(groupKey, out var instances)) groupedSpriteInstances[groupKey] = instances = [];
                        instances.Add(new {
                            location = new { x = instanceTransform.Translation.X, y = instanceTransform.Translation.Y, z = instanceTransform.Translation.Z },
                            rotation = new { pitch = instanceRotation.Pitch, yaw = instanceRotation.Yaw, roll = instanceRotation.Roll },
                            scale = new { x = instanceTransform.Scale3D.X, y = instanceTransform.Scale3D.Y, z = instanceTransform.Scale3D.Z }
                        });
                    }
                    if (groupedSpriteInstances.Sum(group => group.Value.Count) == before)
                        omittedActors.Add(new { actor = actorName, component = component.Name, sourceClass = component.ExportType, reason = "grouped sprite component has no decodable instances" });
                    continue;
                }
                if (component.ExportType.Contains("TextRenderComponent", StringComparison.OrdinalIgnoreCase))
                {
                    var text = component.GetOrDefault<FText?>("Text")?.Text ?? "";
                    var font = component.GetOrDefault<FPackageIndex?>("Font");
                    if (text.Length > 0 && font is { IsNull: false })
                    {
                        var color = component.GetOrDefault<FColor>("TextRenderColor", new FColor(255));
                        texts.Add(new {
                            name = actorName + "/" + component.Name,
                            text,
                            fontName = font.Name,
                            fontPath = font.ResolvedObject?.GetPathName() ?? font.Name,
                            worldSize = component.GetOrDefault<float>("WorldSize", 30f),
                            horizontalAlignment = component.GetOrDefault<EHorizTextAligment>("HorizontalAlignment", EHorizTextAligment.EHTA_Left).ToString(),
                            verticalAlignment = component.GetOrDefault<EVerticalTextAligment>("VerticalAlignment", EVerticalTextAligment.EVRTA_TextBottom).ToString(),
                            color = new[] { (int)color.R, (int)color.G, (int)color.B, (int)color.A },
                            location = new { x = transform.Translation.X, y = transform.Translation.Y, z = transform.Translation.Z },
                            rotation = new { pitch = rotation.Pitch, yaw = rotation.Yaw, roll = rotation.Roll },
                            scale = new { x = transform.Scale3D.X, y = transform.Scale3D.Y, z = transform.Scale3D.Z },
                            parent = actorName
                        });
                    }
                    if (text.Length > 0 && font is { IsNull: false }) continue;
                    omittedActors.Add(new { actor = actorName, component = component.Name, sourceClass = component.ExportType, reason = "text component has no usable text/font reference" });
                    continue;
                }
                if (component.ExportType.Contains("PaperTerrain", StringComparison.OrdinalIgnoreCase))
                {
                    omittedActors.Add(new { actor = actorName, component = component.Name, sourceClass = component.ExportType, reason = "Paper Terrain spline geometry is not reconstructed" });
                    continue;
                }
                if (component.ExportType.Contains("SplineMeshComponent", StringComparison.OrdinalIgnoreCase))
                {
                    omittedActors.Add(new { actor = actorName, component = component.Name, sourceClass = component.ExportType, reason = "spline-deformed mesh geometry is not reconstructed" });
                    continue;
                }
                var meshName = "";
                var staticMesh = ResolveStaticMesh(component);
                var skeletalMesh = ResolveSkeletalMesh(component);
                if (!staticMesh.IsNull)
                {
                    meshName = staticMesh.Name;
                    if ((staticMesh.Load<UStaticMesh>() ?? LoadAssetByName<UStaticMesh>(staticMesh.Name)) is { } loadedStaticMesh) await ExportStaticMeshAsync(loadedStaticMesh);
                }
                else if (!skeletalMesh.IsNull)
                {
                    meshName = skeletalMesh.Name;
                    if ((skeletalMesh.Load<USkeletalMesh>() ?? LoadAssetByName<USkeletalMesh>(skeletalMesh.Name)) is { } loadedSkeletalMesh) await ExportSkeletalMeshAsync(loadedSkeletalMesh);
                }
                else if (component.TryGetValue<FPackageIndex>(out var sourceSprite, "SourceSprite") && !sourceSprite.IsNull)
                {
                    meshName = sourceSprite.Name;
                    if (sourceSprite.Load<UPaperSprite>() is { } sprite) await ExportPaperSpriteAsync(sprite);
                }
                else if (component.ExportType.Contains("PaperFlipbook", StringComparison.OrdinalIgnoreCase) && ResolveFlipbookSprite(component, actor, out var fromBlueprintTemplate) is { } flipbookSprite)
                {
                    meshName = flipbookSprite.Name;
                    await ExportPaperSpriteAsync(flipbookSprite);
                    if (fromBlueprintTemplate) blueprintComponents++;
                }
                else if (component.TryGetValue<FPackageIndex>(out var tileMap, "TileMap") && !tileMap.IsNull)
                    meshName = tileMap.Name;
                if (meshName.Length == 0)
                {
                    if (component.ExportType.Contains("MeshComponent", StringComparison.OrdinalIgnoreCase) ||
                        component.ExportType.Contains("Niagara", StringComparison.OrdinalIgnoreCase) ||
                        component.ExportType.Contains("ParticleSystem", StringComparison.OrdinalIgnoreCase) ||
                        component.ExportType.Contains("Decal", StringComparison.OrdinalIgnoreCase) ||
                        component.ExportType.Contains("Groom", StringComparison.OrdinalIgnoreCase))
                        omittedActors.Add(new { actor = actorName, component = component.Name, sourceClass = component.ExportType, reason = "render component class is not yet reconstructable" });
                    continue;
                }
                actors.Add(new {
                    name = actorName + "/" + component.Name,
                    meshName,
                    location = new { x = transform.Translation.X, y = transform.Translation.Y, z = transform.Translation.Z },
                    rotation = new { pitch = rotation.Pitch, yaw = rotation.Yaw, roll = rotation.Roll },
                    scale = new { x = transform.Scale3D.X, y = transform.Scale3D.Y, z = transform.Scale3D.Z },
                    parent = actorName
                });
            }
        }
        var descriptor = new {
            format = "threenative-unreal-scene-source",
            version = 1,
            mapName = world.Name,
            sourceFile = key.Replace('\\', '/'),
            actors,
            texts,
            omittedActors,
            instanceGroups = groupedSpriteInstances.Select(group => new {
                name = group.Key,
                meshName = group.Key[(group.Key.LastIndexOf('/') + 1)..],
                transforms = group.Value,
                parent = group.Key[..group.Key.IndexOf('/')],
                sourceClass = "PaperGroupedSpriteComponent"
            }).ToArray(),
            landscapes = Array.Empty<object>(),
            lights,
            blueprintComponents,
            camera = new {
                hasCamera,
                location = new { x = cameraX, y = cameraY, z = cameraZ },
                rotation = new { pitch = cameraPitch, yaw = cameraYaw, roll = cameraRoll }
            }
        };
        await File.WriteAllTextAsync(
            Path.Combine(output, "Scenes", world.Name + ".scene-source.json"),
            JsonConvert.SerializeObject(descriptor, Formatting.Indented));
        PropertyUtil.SearchPropertyInTemplate = false;
        exported++;
    }
    foreach (var generatedClass in package.GetExports().OfType<UBlueprintGeneratedClass>())
    {
        if (generatedClass.SimpleConstructionScript?.Load<USimpleConstructionScript>() is not { } script) continue;
        var prefabName = generatedClass.Name.EndsWith("_C", StringComparison.Ordinal) ? generatedClass.Name[..^2] : generatedClass.Name;
        var actors = new List<object>();
        var lights = new List<object>();
        var omittedActors = new List<object>();
        var visitedComponents = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var componentCount = 0;

        async Task VisitNodeAsync(USCS_Node node, FTransform parentTransform, string parentName, int depth)
        {
            if (depth > 64) return;
            var component = node.ComponentTemplate?.Load<USceneComponent>() ?? node.GetComponentTemplate();
            var worldTransform = parentTransform;
            var componentName = node.InternalVariableName.IsNone ? node.Name : node.InternalVariableName.Text;
            if (component is not null)
            {
                visitedComponents.Add(component.GetPathName());
                componentCount++;
                worldTransform = component.GetRelativeTransform() * parentTransform;
                var rotation = worldTransform.Rotator();
                if (component is USkyLightComponent)
                {
                    omittedActors.Add(new { actor = prefabName, component = componentName, sourceClass = component.ExportType, reason = "SkyLight environment capture is not reconstructable as a punctual Three.js light" });
                }
                else if (component is ULightComponentBase light)
                {
                    var lightType = component is UDirectionalLightComponent ? "directional" : component is USpotLightComponent ? "spot" : component is URectLightComponent ? "rect" : "point";
                    var localLight = component as ULocalLightComponent;
                    var spotLight = component as USpotLightComponent;
                    var rectLight = component as URectLightComponent;
                    var temperatureLight = component as ULightComponent;
                    var lightColor = light.GetLightColor();
                    lights.Add(new {
                        name = prefabName + "/" + componentName,
                        type = lightType,
                        location = new { x = worldTransform.Translation.X, y = worldTransform.Translation.Y, z = worldTransform.Translation.Z },
                        rotation = new { pitch = rotation.Pitch, yaw = rotation.Yaw, roll = rotation.Roll },
                        color = new[] { lightColor.R, lightColor.G, lightColor.B },
                        intensity = light.Intensity,
                        range = (localLight?.AttenuationRadius ?? 0f) * 0.01f,
                        innerConeAngle = spotLight?.InnerConeAngle ?? 0f,
                        outerConeAngle = spotLight?.OuterConeAngle ?? 44f,
                        temperature = temperatureLight?.Temperature ?? 6500f,
                        useTemperature = temperatureLight?.bUseTemperature ?? false,
                        sourceWidth = (rectLight?.SourceWidth ?? 0f) * 0.01f,
                        sourceHeight = (rectLight?.SourceHeight ?? 0f) * 0.01f
                    });
                }
                else
                {
                    var meshName = "";
                    var staticMesh = ResolveStaticMesh(component);
                    var skeletalMesh = ResolveSkeletalMesh(component);
                    if (!staticMesh.IsNull)
                    {
                        meshName = staticMesh.Name;
                        if ((staticMesh.Load<UStaticMesh>() ?? LoadAssetByName<UStaticMesh>(staticMesh.Name)) is { } loadedStaticMesh) await ExportStaticMeshAsync(loadedStaticMesh);
                    }
                    else if (!skeletalMesh.IsNull)
                    {
                        meshName = skeletalMesh.Name;
                        if ((skeletalMesh.Load<USkeletalMesh>() ?? LoadAssetByName<USkeletalMesh>(skeletalMesh.Name)) is { } loadedSkeletalMesh) await ExportSkeletalMeshAsync(loadedSkeletalMesh);
                    }
                    else if (component.TryGetValue<FPackageIndex>(out var sourceSprite, "SourceSprite") && !sourceSprite.IsNull)
                    {
                        meshName = sourceSprite.Name;
                        if (sourceSprite.Load<UPaperSprite>() is { } sprite) await ExportPaperSpriteAsync(sprite);
                    }
                    if (meshName.Length > 0)
                    {
                        actors.Add(new {
                            name = prefabName + "/" + componentName,
                            meshName,
                            location = new { x = worldTransform.Translation.X, y = worldTransform.Translation.Y, z = worldTransform.Translation.Z },
                            rotation = new { pitch = rotation.Pitch, yaw = rotation.Yaw, roll = rotation.Roll },
                            scale = new { x = worldTransform.Scale3D.X, y = worldTransform.Scale3D.Y, z = worldTransform.Scale3D.Z },
                            parent = parentName
                        });
                    }
                    else if (component.ExportType.Contains("MeshComponent", StringComparison.OrdinalIgnoreCase) ||
                             component.ExportType.Contains("Niagara", StringComparison.OrdinalIgnoreCase) ||
                             component.ExportType.Contains("ParticleSystem", StringComparison.OrdinalIgnoreCase) ||
                             component.ExportType.Contains("SplineMesh", StringComparison.OrdinalIgnoreCase) ||
                             component.ExportType.Contains("Decal", StringComparison.OrdinalIgnoreCase) ||
                             component.ExportType.Contains("Groom", StringComparison.OrdinalIgnoreCase) ||
                             component.ExportType.Contains("TextRender", StringComparison.OrdinalIgnoreCase))
                    {
                        omittedActors.Add(new { actor = prefabName, component = componentName, sourceClass = component.ExportType, reason = "serialized Blueprint render component is not yet reconstructable" });
                    }
                }
            }
            foreach (var childIndex in node.ChildNodes)
                if (childIndex?.Load<USCS_Node>() is { } child) await VisitNodeAsync(child, worldTransform, componentName, depth + 1);
        }

        foreach (var rootNodeIndex in script.RootNodes)
            if (rootNodeIndex?.Load<USCS_Node>() is { } rootNode) await VisitNodeAsync(rootNode, FTransform.Identity, prefabName, 0);
        var looseComponents = generatedClass.ComponentTemplates
            .Select(index => index?.Load<USceneComponent>())
            .Concat(package.GetExports().OfType<USceneComponent>())
            .Where(component => component is not null)
            .Cast<USceneComponent>()
            .Where(component => !visitedComponents.Contains(component.GetPathName()))
            .DistinctBy(component => component.GetPathName())
            .ToArray();
        foreach (var component in looseComponents)
        {
            visitedComponents.Add(component.GetPathName());
            componentCount++;
            var transform = component.GetRelativeTransform();
            var parentComponent = component.GetOrDefault<FPackageIndex?>("AttachParent")?.Load<USceneComponent>();
            for (var parentDepth = 0; parentComponent is not null && parentDepth < 64; parentDepth++)
            {
                transform *= parentComponent.GetRelativeTransform();
                parentComponent = parentComponent.GetOrDefault<FPackageIndex?>("AttachParent")?.Load<USceneComponent>();
            }
            var rotation = transform.Rotator();
            var staticMesh = ResolveStaticMesh(component);
            var skeletalMesh = ResolveSkeletalMesh(component);
            var meshName = !staticMesh.IsNull ? staticMesh.Name : !skeletalMesh.IsNull ? skeletalMesh.Name : "";
            var meshExported = false;
            var loadedStaticMesh = !staticMesh.IsNull ? staticMesh.Load<UStaticMesh>() ?? LoadAssetByName<UStaticMesh>(staticMesh.Name) : null;
            var loadedSkeletalMesh = !skeletalMesh.IsNull ? skeletalMesh.Load<USkeletalMesh>() ?? LoadAssetByName<USkeletalMesh>(skeletalMesh.Name) : null;
            if (loadedStaticMesh is not null)
                meshExported = await ExportStaticMeshAsync(loadedStaticMesh);
            if (loadedSkeletalMesh is not null)
                meshExported = await ExportSkeletalMeshAsync(loadedSkeletalMesh);
            if (meshName.Length > 0)
            {
                actors.Add(new {
                    name = prefabName + "/" + component.Name,
                    meshName,
                    location = new { x = transform.Translation.X, y = transform.Translation.Y, z = transform.Translation.Z },
                    rotation = new { pitch = rotation.Pitch, yaw = rotation.Yaw, roll = rotation.Roll },
                    scale = new { x = transform.Scale3D.X, y = transform.Scale3D.Y, z = transform.Scale3D.Z },
                    parent = prefabName
                });
                if (!meshExported)
                    omittedActors.Add(new { actor = prefabName, component = component.Name, sourceClass = component.ExportType, reason = loadedStaticMesh is null && loadedSkeletalMesh is null ? $"referenced mesh package {meshName} is absent or unreadable ({assetLookupDiagnostics.GetValueOrDefault(meshName, "no lookup diagnostic")})" : $"referenced mesh {meshName} was loaded but its render geometry could not be decoded" });
            }
            else if (component.ExportType.Contains("MeshComponent", StringComparison.OrdinalIgnoreCase))
            {
                omittedActors.Add(new { actor = prefabName, component = component.Name, sourceClass = component.ExportType, reason = "serialized Blueprint mesh component has no resolvable mesh default" });
            }
        }
        if (generatedClass.UberGraphFunction is { IsNull: false })
            omittedActors.Add(new { actor = prefabName, component = generatedClass.UberGraphFunction.Name, sourceClass = generatedClass.ExportType, reason = "Blueprint bytecode is not executed; serialized component defaults were reconstructed" });
        var descriptor = new {
            format = "threenative-unreal-scene-source",
            version = 1,
            mapName = prefabName,
            sourceFile = key.Replace('\\', '/'),
            actors,
            texts = Array.Empty<object>(),
            omittedActors,
            instanceGroups = Array.Empty<object>(),
            landscapes = Array.Empty<object>(),
            lights,
            blueprintComponents = componentCount,
            camera = new {
                hasCamera = false,
                location = new { x = 0, y = 0, z = 0 },
                rotation = new { pitch = 0, yaw = 0, roll = 0 }
            }
        };
        await File.WriteAllTextAsync(
            Path.Combine(output, "Scenes", prefabName + ".prefab-source.json"),
            JsonConvert.SerializeObject(descriptor, Formatting.Indented));
        exported++;
    }
    foreach (var font in package.GetExports().OfType<UFont>())
    {
        var characters = font.GetOrDefault<FFontCharacter[]>("Characters", []);
        var textureReferences = font.GetOrDefault<FPackageIndex[]>("Textures", []);
        if (characters.Length == 0 || textureReferences.Length == 0) continue;
        var pageFiles = new List<string>();
        var packageBytes = Array.Empty<byte>();
        for (var pageIndex = 0; pageIndex < textureReferences.Length; pageIndex++)
        {
            var texture = textureReferences[pageIndex].Load<UTexture2D>();
            if (texture is null) continue;
            var targetName = $"{font.Name}_page{pageIndex:D2}.png";
            var target = Path.Combine(output, "Fonts", targetName);
            var session = new ExportSession { MaxDegreeOfParallelism = 1 };
            session.Add(texture);
            var results = await session.RunAsync(output, new ExportOptions());
            var emitted = results.SelectMany(result => result.DiskFilePaths ?? [])
                .FirstOrDefault(path => path.EndsWith(".png", StringComparison.OrdinalIgnoreCase));
            if (emitted is not null && File.Exists(emitted))
            {
                if (!Path.GetFullPath(emitted).Equals(Path.GetFullPath(target), StringComparison.OrdinalIgnoreCase))
                    File.Copy(emitted, target, true);
            }
            else if (textureReferences.Length == 1)
            {
                if (packageBytes.Length == 0)
                {
                    var normalizedKey = key.Replace('\\', '/');
                    var packageFile = Directory.EnumerateFiles(root, Path.GetFileNameWithoutExtension(key) + ".uasset", SearchOption.AllDirectories)
                        .FirstOrDefault(candidate => normalizedKey.EndsWith(Path.GetRelativePath(root, candidate).Replace('\\', '/'), StringComparison.OrdinalIgnoreCase));
                    if (packageFile is not null && new FileInfo(packageFile).Length <= 1_073_741_824)
                        packageBytes = await File.ReadAllBytesAsync(packageFile);
                }
                var sourcePng = ExtractLargestPng(packageBytes) ?? ExtractCompressedPayloadPng(packageBytes);
                if (sourcePng is not null) await File.WriteAllBytesAsync(target, NormalizeSourcePng(sourcePng, texture));
            }
            if (File.Exists(target)) pageFiles.Add(targetName);
        }
        if (pageFiles.Count == 0) continue;
        var isDistanceField = false;
        var distanceFieldScaleFactor = 1;
        if (font.TryGetValue<FStructFallback>(out var importOptions, "ImportOptions"))
        {
            isDistanceField = importOptions.GetOrDefault<bool>("bUseDistanceFieldAlpha", false);
            distanceFieldScaleFactor = importOptions.GetOrDefault<int>("DistanceFieldScaleFactor", 1);
        }
        var descriptor = new {
            Name = font.Name,
            PackagePath = font.GetPathName(),
            Pages = pageFiles,
            Characters = characters.Select(character => new {
                character.StartU, character.StartV, character.USize, character.VSize,
                character.TextureIndex, character.VerticalOffset
            }).ToArray(),
            CharRemap = font.CharRemap ?? new Dictionary<ushort, ushort>(),
            IsRemapped = font.GetOrDefault<int>("IsRemapped", 0) != 0,
            Kerning = font.GetOrDefault<int>("Kerning", 0),
            EmScale = font.GetOrDefault<float>("EmScale", 1f),
            Ascent = font.GetOrDefault<float>("Ascent", 0f),
            Descent = font.GetOrDefault<float>("Descent", 0f),
            Leading = font.GetOrDefault<float>("Leading", 0f),
            ScalingFactor = font.GetOrDefault<float>("ScalingFactor", 1f),
            IsDistanceField = isDistanceField,
            DistanceFieldScaleFactor = distanceFieldScaleFactor
        };
        await File.WriteAllTextAsync(
            Path.Combine(output, "Fonts", font.Name + ".font.json"),
            JsonConvert.SerializeObject(descriptor, Formatting.Indented));
        exported++;
    }
    foreach (var texture in package.GetExports().OfType<UTexture2D>())
    {
        var session = new ExportSession { MaxDegreeOfParallelism = 1 };
        session.Add(texture);
        var results = await session.RunAsync(output, new ExportOptions());
        var result = results.FirstOrDefault(item => item.Success);
        var emitted = result?.DiskFilePaths?.FirstOrDefault(path => path.EndsWith(".png", StringComparison.OrdinalIgnoreCase));
        var target = Path.Combine(output, "Textures", texture.Name + ".png");
        if (emitted is not null && File.Exists(emitted))
        {
            if (!Path.GetFullPath(emitted).Equals(Path.GetFullPath(target), StringComparison.OrdinalIgnoreCase)) File.Move(emitted, target, true);
        }
        else
        {
            // Editor Texture2D packages have source art but no cooked PlatformData mip. Depending
            // on the UE5 version, the complete source PNG is inline or wrapped in FCompressedBuffer
            // blocks. Preserving it is lossless and does not require the derived-data cache.
            var normalizedKey = key.Replace('\\', '/');
            var candidates = Directory.EnumerateFiles(root, texture.Name + ".uasset", SearchOption.AllDirectories).ToArray();
            var textureFile = candidates.FirstOrDefault(candidate =>
                normalizedKey.EndsWith(Path.GetRelativePath(root, candidate).Replace('\\', '/'), StringComparison.OrdinalIgnoreCase))
                ?? (candidates.Length == 1 ? candidates[0] : null);
            if (textureFile is null || new FileInfo(textureFile).Length > 1_073_741_824) continue;
            var packageBytes = await File.ReadAllBytesAsync(textureFile);
            var sourcePng = ExtractLargestPng(packageBytes) ?? ExtractCompressedPayloadPng(packageBytes);
            if (sourcePng is null) continue;
            await File.WriteAllBytesAsync(target, NormalizeSourcePng(sourcePng, texture));
        }
        exported++;
    }
    foreach (var cubemap in package.GetExports().OfType<UTextureCube>())
    {
        var session = new ExportSession { MaxDegreeOfParallelism = 1 };
        session.Add(cubemap);
        var results = await session.RunAsync(output, new ExportOptions());
        var result = results.FirstOrDefault(item => item.Success);
        var emitted = result?.DiskFilePaths?.FirstOrDefault(path =>
            path.EndsWith(".png", StringComparison.OrdinalIgnoreCase) || path.EndsWith(".hdr", StringComparison.OrdinalIgnoreCase));
        if ((emitted is null || !File.Exists(emitted)) &&
            cubemap.SourceArt?.ReadDataOnce() is { Length: > 0 } sourceArt &&
            cubemap.TryGetValue<FStructFallback>(out var source, "Source") &&
            source.GetOrDefault<int>("SizeX") is var width &&
            source.GetOrDefault<int>("SizeY") is var height &&
            source.Properties.FirstOrDefault(property => property.Name.Text.Equals("Format", StringComparison.OrdinalIgnoreCase))?.Tag?.GenericValue?.ToString() == "TSF_BGRE8")
        {
            var hdr = EncodeBgre8AsRadiance(sourceArt, width, height);
            emitted = Path.Combine(output, "Cubemaps", cubemap.Name + ".hdr");
            await File.WriteAllBytesAsync(emitted, hdr);
        }
        if (emitted is null || !File.Exists(emitted))
        {
            lastLoadError = results.FirstOrDefault()?.Error;
            continue;
        }
        var target = Path.Combine(output, "Cubemaps", cubemap.Name + Path.GetExtension(emitted).ToLowerInvariant());
        if (!Path.GetFullPath(emitted).Equals(Path.GetFullPath(target), StringComparison.OrdinalIgnoreCase)) File.Move(emitted, target, true);
        exported++;
    }
    foreach (var texture in package.GetExports().Where(asset =>
        asset is UTexture2DArray or UTextureCubeArray or UVolumeTexture).Cast<UTexture>())
    {
        var mip = texture.GetFirstMip();
        if (mip is null) continue;
        var depth = texture is UVolumeTexture ? mip.SizeZ : texture.PlatformData.GetNumSlices();
        if (mip.SizeX <= 0 || mip.SizeY <= 0 || depth <= 0) continue;
        var session = new ExportSession { MaxDegreeOfParallelism = 1 };
        session.Add(texture);
        var results = await session.RunAsync(output, new ExportOptions(exportHdrTexturesAsHdr: true));
        var result = results.FirstOrDefault(item => item.Success);
        var emitted = result?.DiskFilePaths?
            .Where(path => path.EndsWith(".png", StringComparison.OrdinalIgnoreCase) || path.EndsWith(".hdr", StringComparison.OrdinalIgnoreCase))
            .OrderBy(path => path, StringComparer.OrdinalIgnoreCase)
            .ToArray() ?? [];
        if (emitted.Length == 0)
        {
            lastLoadError = results.FirstOrDefault()?.Error;
            continue;
        }
        var moved = new List<string>();
        for (var index = 0; index < emitted.Length; index++)
        {
            var suffix = texture is UVolumeTexture && emitted.Length == 1 ? "ATLAS" : $"LAYER{index:D4}";
            var target = Path.Combine(output, "Multidimensional", texture.Name + "_" + suffix + Path.GetExtension(emitted[index]).ToLowerInvariant());
            if (!Path.GetFullPath(emitted[index]).Equals(Path.GetFullPath(target), StringComparison.OrdinalIgnoreCase)) File.Move(emitted[index], target, true);
            moved.Add(Path.GetFileName(target));
        }
        var descriptor = new {
            Name = texture.Name,
            Class = texture.GetType().Name[1..],
            Width = mip.SizeX,
            Height = mip.SizeY,
            Depth = depth,
            Layout = texture is UVolumeTexture or UTextureCubeArray ? "vertical-atlas" : "layers",
            Layers = moved
        };
        await File.WriteAllTextAsync(
            Path.Combine(output, "Multidimensional", texture.Name + ".texture.json"),
            JsonConvert.SerializeObject(descriptor, Formatting.Indented));
        exported++;
    }
    foreach (var sprite in package.GetExports().OfType<UPaperSprite>())
    {
        if (await ExportPaperSpriteAsync(sprite)) exported++;
    }
    foreach (var tileAsset in package.GetExports().Where(asset => asset.ExportType is "PaperTileMap" or "PaperTileSet"))
    {
        var related = package.GetExports().Where(asset => asset.ExportType == "PaperTileLayer").Select(layer => new {
            Name = layer.Name,
            Class = layer.ExportType,
            Properties = layer.Properties.ToDictionary(property =>
                property.ArrayIndex > 0 ? $"{property.Name.Text}[{property.ArrayIndex}]" : property.Name.Text,
                property => property.Tag?.GenericValue)
        }).ToArray();
        string? textureFileName = null;
        if (tileAsset.ExportType == "PaperTileSet" && tileAsset.TryGetValue<FPackageIndex>(out var tileSheet, "TileSheet") &&
            !tileSheet.IsNull && tileSheet.Load<UTexture2D>() is { } sheet)
        {
            textureFileName = tileAsset.Name + ".png";
            var textureTarget = Path.Combine(output, "TileMaps", textureFileName);
            var session = new ExportSession { MaxDegreeOfParallelism = 1 };
            session.Add(sheet);
            var results = await session.RunAsync(output, new ExportOptions());
            var emitted = results.SelectMany(result => result.DiskFilePaths ?? [])
                .FirstOrDefault(path => path.EndsWith(".png", StringComparison.OrdinalIgnoreCase));
            if (emitted is not null && File.Exists(emitted)) File.Copy(emitted, textureTarget, true);
            else
            {
                var sourceFile = Directory.EnumerateFiles(root, sheet.Name + ".uasset", SearchOption.AllDirectories).FirstOrDefault();
                if (sourceFile is not null && new FileInfo(sourceFile).Length <= 1_073_741_824)
                {
                    var sourcePng = ExtractLargestPng(await File.ReadAllBytesAsync(sourceFile)) ?? ExtractCompressedPayloadPng(await File.ReadAllBytesAsync(sourceFile));
                    if (sourcePng is not null) await File.WriteAllBytesAsync(textureTarget, NormalizeSourcePng(sourcePng, sheet));
                }
            }
            if (!File.Exists(textureTarget)) textureFileName = null;
        }
        var descriptor = new {
            Name = tileAsset.Name,
            PackagePath = tileAsset.GetPathName(),
            Class = tileAsset.ExportType,
            Properties = tileAsset.Properties.ToDictionary(property =>
                property.ArrayIndex > 0 ? $"{property.Name.Text}[{property.ArrayIndex}]" : property.Name.Text,
                property => property.Tag?.GenericValue),
            RelatedExports = related,
            Texture = textureFileName
        };
        await File.WriteAllTextAsync(
            Path.Combine(output, "TileMaps", tileAsset.Name + ".tile.json"),
            JsonConvert.SerializeObject(descriptor, Formatting.Indented));
        exported++;
    }
    foreach (var flipbook in package.GetExports().Where(asset => asset.ExportType == "PaperFlipbook"))
    {
        var framesPerSecond = flipbook.GetOrDefault<float>("FramesPerSecond", 15f);
        var keyFrames = flipbook.GetOrDefault<FStructFallback[]>("KeyFrames", []);
        var frames = new List<object>();
        foreach (var keyFrame in keyFrames)
        {
            var spriteIndex = keyFrame.GetOrDefault<FPackageIndex>("Sprite");
            var frameRun = Math.Max(1, keyFrame.GetOrDefault<int>("FrameRun", 1));
            var sprite = spriteIndex?.Load<UPaperSprite>();
            if (sprite is not null) await ExportPaperSpriteAsync(sprite);
            frames.Add(new {
                Sprite = spriteIndex?.Name ?? "",
                SpritePath = spriteIndex?.ResolvedObject?.GetPathName() ?? "",
                FrameRun = frameRun
            });
        }
        if (framesPerSecond <= 0 || frames.Count == 0) continue;
        var descriptor = new { Name = flipbook.Name, PackagePath = flipbook.GetPathName(), FramesPerSecond = framesPerSecond, Frames = frames };
        await File.WriteAllTextAsync(
            Path.Combine(output, "Sprites", flipbook.Name + ".flipbook.json"),
            JsonConvert.SerializeObject(descriptor, Formatting.Indented));
        exported++;
    }
    foreach (var sound in package.GetExports().OfType<USoundWave>())
    {
        sound.Decode(true, out var audioFormat, out var data);
        if (data is null || data.Length == 0)
        {
            // UE5 editor SoundWave source art is stored independently of cooked streaming chunks.
            // Epic normalizes imported audio to WAV, commonly inline after an FCompressedBuffer
            // header. Extract exactly the RIFF-declared extent so package footer bytes never leak.
            var normalizedKey = key.Replace('\\', '/');
            var candidates = Directory.EnumerateFiles(root, sound.Name + ".uasset", SearchOption.AllDirectories).ToArray();
            var soundFile = candidates.FirstOrDefault(candidate =>
                normalizedKey.EndsWith(Path.GetRelativePath(root, candidate).Replace('\\', '/'), StringComparison.OrdinalIgnoreCase))
                ?? (candidates.Length == 1 ? candidates[0] : null);
            if (soundFile is not null && new FileInfo(soundFile).Length <= 1_073_741_824)
            {
                var packageBytes = await File.ReadAllBytesAsync(soundFile);
                data = ExtractEmbeddedWave(packageBytes) ?? ExtractCompressedPayloadWave(packageBytes);
                if (data is not null) audioFormat = "WAV";
            }
        }
        if (data is null || data.Length == 0) continue;
        var extension = audioFormat.ToLowerInvariant();
        if (data.Length >= 12 && Encoding.ASCII.GetString(data, 0, 4) == "RIFF") extension = "wav";
        else if (data.Length >= 4 && Encoding.ASCII.GetString(data, 0, 4) == "OggS") extension = "ogg";
        else if (data.Length >= 4 && Encoding.ASCII.GetString(data, 0, 4) == "fLaC") extension = "flac";
        else if (data.Length >= 3 && Encoding.ASCII.GetString(data, 0, 3) == "ID3") extension = "mp3";
        extension = new string(extension.Where(char.IsAsciiLetterOrDigit).ToArray());
        if (extension.Length == 0) extension = "bin";
        await File.WriteAllBytesAsync(Path.Combine(output, "Audio", sound.Name + "." + extension), data);
        exported++;
    }
    var dataTypes = new HashSet<string>(StringComparer.Ordinal) {
        "UDataTable", "UCurveTable", "UStringTable", "UCurveFloat", "UCurveVector", "UCurveLinearColor"
    };
    foreach (var dataAsset in package.GetExports().Where(asset => dataTypes.Contains(asset.GetType().Name)))
    {
        var session = new ExportSession { MaxDegreeOfParallelism = 1 };
        session.Add(new JsonPropertiesExporter(dataAsset));
        var results = await session.RunAsync(output, new ExportOptions());
        var result = results.FirstOrDefault(item => item.Success);
        var emitted = result?.DiskFilePaths?.FirstOrDefault(path => path.EndsWith(".json", StringComparison.OrdinalIgnoreCase));
        if (emitted is null || !File.Exists(emitted))
        {
            lastLoadError = results.FirstOrDefault()?.Error;
            continue;
        }
        var target = Path.Combine(output, "Data", dataAsset.Name + ".json");
        if (!Path.GetFullPath(emitted).Equals(Path.GetFullPath(target), StringComparison.OrdinalIgnoreCase)) File.Move(emitted, target, true);
        exported++;
    }
}
if (exported == 0 && mappingRequired) throw new InvalidDataException("This cooked UE5 package uses unversioned properties. Place its game-compatible .usmap mapping file in the imported directory.");
if (exported == 0 && lastLoadError is not null) throw new InvalidDataException("CUE4Parse could not decode the selected Unreal package.", lastLoadError);
if (exported == 0) throw new InvalidDataException($"No StaticMesh, SkeletalMesh, Texture2D, TextureCube, SoundWave, or structured-data output was produced. Loaded export types: {string.Join(", ", selectedExportTypes)}.");

static byte[] EncodeBgre8AsRadiance(byte[] source, int width, int height)
{
    if (width <= 0 || height <= 0 || width != height * 2 || (long) width * height * 4 != source.Length)
        throw new InvalidDataException($"Invalid TSF_BGRE8 equirectangular source: {width}x{height}, {source.Length} bytes.");
    using var output = new MemoryStream(source.Length + 128);
    var header = Encoding.ASCII.GetBytes($"#?RADIANCE\n# Preserved from Unreal TSF_BGRE8 source art\nFORMAT=32-bit_rle_rgbe\n\n-Y {height} +X {width}\n");
    output.Write(header);
    for (var at = 0; at < source.Length; at += 4)
    {
        output.WriteByte(source[at + 2]);
        output.WriteByte(source[at + 1]);
        output.WriteByte(source[at]);
        output.WriteByte(source[at + 3]);
    }
    return output.ToArray();
}

static byte[]? ExtractEmbeddedWave(byte[] bytes)
{
    ReadOnlySpan<byte> riff = "RIFF"u8;
    var searchAt = 0;
    while (searchAt <= bytes.Length - 12)
    {
        var relativeAt = bytes.AsSpan(searchAt).IndexOf(riff);
        if (relativeAt < 0) return null;
        var at = searchAt + relativeAt;
        searchAt = at + 4;
        if (!bytes.AsSpan(at + 8, 4).SequenceEqual("WAVE"u8)) continue;
        var declared = BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(at + 4, 4));
        var length = (long) declared + 8;
        if (length < 44 || length > 1_073_741_824 || at + length > bytes.Length) continue;
        return bytes.AsSpan(at, checked((int) length)).ToArray();
    }
    return null;
}

static byte[]? ExtractCompressedPayloadWave(byte[] bytes)
{
    ReadOnlySpan<byte> magic = [0xb7, 0x75, 0x63, 0x62];
    var searchAt = 0;
    while (searchAt <= bytes.Length - magic.Length)
    {
        var relativeAt = bytes.AsSpan(searchAt).IndexOf(magic);
        if (relativeAt < 0) return null;
        var payloadAt = searchAt + relativeAt;
        searchAt = payloadAt + magic.Length;
        try
        {
            using var archive = new FByteArchive("editor-audio-payload", bytes);
            archive.Position = payloadAt;
            var payload = new FCompressedBuffer(archive);
            if (payload.Header.TotalRawSize == 0 || payload.Header.TotalRawSize > 1_073_741_824) continue;
            var wave = ExtractEmbeddedWave(DecompressEditorPayload(payload));
            if (wave is not null) return wave;
        }
        catch
        {
            // Continue after a false-positive magic sequence in unrelated package data.
        }
    }
    return null;
}

static byte[]? ExtractCompressedPayloadPng(byte[] bytes)
{
    ReadOnlySpan<byte> magic = [0xb7, 0x75, 0x63, 0x62];
    var searchAt = 0;
    while (searchAt <= bytes.Length - magic.Length)
    {
        var relativeAt = bytes.AsSpan(searchAt).IndexOf(magic);
        if (relativeAt < 0) return null;
        var payloadAt = searchAt + relativeAt;
        searchAt = payloadAt + magic.Length;
        try
        {
            using var archive = new FByteArchive("editor-payload", bytes);
            archive.Position = payloadAt;
            var payload = new FCompressedBuffer(archive);
            if (payload.Header.TotalRawSize == 0 || payload.Header.TotalRawSize > 1_073_741_824) continue;
            var raw = DecompressEditorPayload(payload);
            var png = ExtractLargestPng(raw);
            if (png is not null) return png;
        }
        catch
        {
            // The magic may occur in unrelated bulk bytes. Continue to the next bounded candidate.
        }
    }
    return null;
}

// The LOD0 source model of an uncooked UE5 StaticMesh. Its package trailer holds one
// FMeshDescription payload per source-model LOD, so the largest raw payload that parses is LOD0.
// Every other payload in a StaticMesh package is also a mesh description, so ranking by the
// header's raw size decompresses only what is kept.
static EditorMesh? ReadLargestMeshDescription(byte[] bytes)
{
    ReadOnlySpan<byte> magic = [0xb7, 0x75, 0x63, 0x62];
    var candidates = new List<(int At, ulong RawSize)>();
    for (var searchAt = 0; searchAt <= bytes.Length - magic.Length;)
    {
        var relativeAt = bytes.AsSpan(searchAt).IndexOf(magic);
        if (relativeAt < 0) break;
        var payloadAt = searchAt + relativeAt;
        searchAt = payloadAt + magic.Length;
        try
        {
            using var archive = new FByteArchive("editor-payload", bytes);
            archive.Position = payloadAt;
            var header = new FCompressedBufferHeader(archive);
            if (header.Magic == FCompressedBufferHeader.ExpectedMagic && header.TotalRawSize is > 0 and <= 1_073_741_824)
                candidates.Add((payloadAt, header.TotalRawSize));
        }
        catch
        {
            // The magic may occur inside unrelated compressed bytes.
        }
    }
    foreach (var (at, _) in candidates.OrderByDescending(candidate => candidate.RawSize))
    {
        try
        {
            using var archive = new FByteArchive("editor-payload", bytes);
            archive.Position = at;
            return ReadMeshDescription(DecompressEditorPayload(new FCompressedBuffer(archive)));
        }
        catch
        {
            // Not a mesh description; try the next largest payload.
        }
    }
    return null;
}

// UE5's FMeshDescription serialization, as verified byte-exact on the Common Hazel packs (see
// docs/PRDs/done/ue5-mesh-description-reference.py for the annotated layout). Throws unless the
// whole payload is consumed, so a layout drift is a refusal rather than garbage geometry.
static EditorMesh ReadMeshDescription(byte[] raw)
{
    using var stream = new MemoryStream(raw, false);
    using var reader = new BinaryReader(stream);
    string ReadName()
    {
        var length = reader.ReadInt32();
        if (length is <= 0 or > 4096) throw new InvalidDataException("Implausible FString length.");
        var text = Encoding.ASCII.GetString(reader.ReadBytes(length - 1));
        reader.ReadByte();
        return text;
    }
    var arrays = new Dictionary<string, byte[]>(StringComparer.Ordinal);
    var names = new Dictionary<string, string[]>(StringComparer.Ordinal);
    var live = new Dictionary<string, bool[]>(StringComparer.Ordinal);
    var elementTypes = reader.ReadInt32();
    if (elementTypes is < 1 or > 64) throw new InvalidDataException("Not a mesh description.");
    for (var elementIndex = 0; elementIndex < elementTypes; elementIndex++)
    {
        var element = ReadName();
        var channels = reader.ReadInt32();
        if (channels is < 0 or > 64) throw new InvalidDataException("Implausible element channel count.");
        for (var channel = 0; channel < channels; channel++)
        {
            var bits = reader.ReadInt32();
            if (bits < 0) throw new InvalidDataException("Negative allocation bit count.");
            var words = new uint[(bits + 31) / 32];
            for (var word = 0; word < words.Length; word++) words[word] = reader.ReadUInt32();
            if (channel == 0) live[element] = Enumerable.Range(0, bits).Select(bit => ((words[bit >> 5] >> (bit & 31)) & 1) != 0).ToArray();
            reader.ReadInt32(); // free-list head
            reader.ReadInt32(); // element count
            var attributes = reader.ReadInt32();
            for (var attributeIndex = 0; attributeIndex < attributes; attributeIndex++)
            {
                var attribute = ReadName().Trim(); // Vertex position is "Position " with a space
                var kind = reader.ReadInt32();
                reader.ReadInt32();
                reader.ReadInt32();
                var indices = reader.ReadInt32();
                for (var index = 0; index < indices; index++)
                {
                    reader.ReadInt32(); // extent
                    var key = element + "[" + channel + "]." + attribute + "[" + index + "]";
                    if (kind == 6)
                    {
                        var count = reader.ReadInt32();
                        names[key] = Enumerable.Range(0, count).Select(_ => ReadName()).ToArray();
                        continue;
                    }
                    var elementSize = reader.ReadInt32();
                    var elements = reader.ReadInt32();
                    arrays[key] = reader.ReadBytes(checked(elementSize * elements));
                }
                // The default value is written even for an attribute with no channels, so its size
                // comes from the attribute type: FVector4f, FVector3f, FVector2f, float, int32, and
                // bool (a 4-byte UE bool, although bulk arrays store 1 byte per element).
                if (kind == 6) ReadName();
                else reader.ReadBytes(kind switch
                {
                    0 => 16, 1 => 12, 2 => 8, 3 or 4 or 5 => 4,
                    _ => throw new InvalidDataException("Unknown mesh attribute type " + kind + "."),
                });
                reader.ReadInt32(); // EMeshAttributeFlags
            }
        }
    }
    if (stream.Position != raw.Length) throw new InvalidDataException("Mesh description was not fully consumed.");
    float[] Floats(string key) => arrays.TryGetValue(key, out var bytes) ? MemoryMarshal.Cast<byte, float>(bytes).ToArray() : throw new InvalidDataException("Missing " + key);
    int[] Ints(string key) => arrays.TryGetValue(key, out var bytes) ? MemoryMarshal.Cast<byte, int>(bytes).ToArray() : throw new InvalidDataException("Missing " + key);
    return new EditorMesh(
        Floats("Vertices[0].Position[0]"),
        Ints("VertexInstances[0].VertexIndex[0]"),
        Floats("VertexInstances[0].Normal[0]"),
        Floats("VertexInstances[0].TextureCoordinate[0]"),
        Ints("Triangles[0].VertexInstanceIndex[0]"),
        Ints("Triangles[0].PolygonGroupIndex[0]"),
        live.TryGetValue("Triangles", out var triangles) ? triangles : [],
        names.TryGetValue("PolygonGroups[0].ImportedMaterialSlotName[0]", out var slots) ? slots : []);
}

// Writes the decoded source model with the cooked glTF writer's conventions: centimetres to metres,
// Unreal's Z-up swapped to glTF's Y-up, and Unreal's triangle order kept (the axis swap and
// Unreal's left-handedness cancel). Vertex colours and tangents are left out, as the UE Viewer
// route leaves them out: Megascans vertex colours are wind masks, not tint, and glTF clients
// generate MikkTSpace tangents when none are given.
static void WriteEditorMeshGlb(EditorMesh mesh, string[] materialNames, string name, string target)
{
    var builder = new SharpGLTF.Geometry.MeshBuilder<
        SharpGLTF.Geometry.VertexTypes.VertexPositionNormal,
        SharpGLTF.Geometry.VertexTypes.VertexTexture1,
        SharpGLTF.Geometry.VertexTypes.VertexEmpty>(name);
    var materials = new Dictionary<int, SharpGLTF.Materials.MaterialBuilder>();
    SharpGLTF.Materials.MaterialBuilder Material(int group)
    {
        if (materials.TryGetValue(group, out var existing)) return existing;
        var material = new SharpGLTF.Materials.MaterialBuilder(group >= 0 && group < materialNames.Length ? materialNames[group] : "MaterialSlot_" + group)
            .WithBaseColor(System.Numerics.Vector4.One);
        materials[group] = material;
        return material;
    }
    SharpGLTF.Geometry.VertexBuilder<
        SharpGLTF.Geometry.VertexTypes.VertexPositionNormal,
        SharpGLTF.Geometry.VertexTypes.VertexTexture1,
        SharpGLTF.Geometry.VertexTypes.VertexEmpty> Vertex(int instance)
    {
        var vertex = mesh.InstanceVertices[instance];
        var position = new System.Numerics.Vector3(mesh.Positions[vertex * 3], mesh.Positions[vertex * 3 + 2], mesh.Positions[vertex * 3 + 1]) * 0.01f;
        var normal = new System.Numerics.Vector3(mesh.Normals[instance * 3], mesh.Normals[instance * 3 + 2], mesh.Normals[instance * 3 + 1]);
        normal = normal.LengthSquared() > 1e-12f && float.IsFinite(normal.LengthSquared()) ? System.Numerics.Vector3.Normalize(normal) : System.Numerics.Vector3.UnitY;
        var uv = new System.Numerics.Vector2(mesh.Uv0[instance * 2], mesh.Uv0[instance * 2 + 1]);
        return new(new SharpGLTF.Geometry.VertexTypes.VertexPositionNormal(position, normal), new SharpGLTF.Geometry.VertexTypes.VertexTexture1(uv));
    }
    var triangleCount = mesh.TriangleInstances.Length / 3;
    for (var triangle = 0; triangle < triangleCount; triangle++)
    {
        if (triangle < mesh.LiveTriangles.Length && !mesh.LiveTriangles[triangle]) continue;
        var group = triangle < mesh.TriangleGroups.Length ? mesh.TriangleGroups[triangle] : 0;
        builder.UsePrimitive(Material(group)).AddTriangle(
            Vertex(mesh.TriangleInstances[triangle * 3]),
            Vertex(mesh.TriangleInstances[triangle * 3 + 1]),
            Vertex(mesh.TriangleInstances[triangle * 3 + 2]));
    }
    var scene = new SharpGLTF.Scenes.SceneBuilder();
    scene.AddRigidMesh(builder, System.Numerics.Matrix4x4.Identity);
    Directory.CreateDirectory(Path.GetDirectoryName(target)!);
    scene.ToGltf2().SaveGLB(target);
}

// Editor source art is stored the way FTextureSource keeps it, not as a display image. A
// TSF_BGRA8 source PNG carries blue in its red channel: against UE Viewer's export of the same
// Megascans texture, the extracted PNG measured RMSE 0.066 as-is and 0.016 with red and blue
// swapped. TSF_RGBA16 source is linear light, so an sRGB-sampled one reads about four times too
// dark until it is encoded to sRGB. Anything else passes through unchanged.
static byte[] NormalizeSourcePng(byte[] png, UTexture? texture)
{
    if (texture is null) return png;
    var format = texture.GetOrDefault<FStructFallback?>("Source", null)?.GetOrDefault<FName>("Format").Text ?? "";
    try
    {
        if (format.EndsWith("TSF_BGRA8", StringComparison.Ordinal)) return SwapRedBlue(png);
        if (format.EndsWith("TSF_RGBA16", StringComparison.Ordinal) && texture.SRGB) return LinearToSrgb8(png);
    }
    catch (Exception error) when (error is not OutOfMemoryException)
    {
        // An undecodable PNG is kept as extracted rather than dropped.
    }
    return png;
}

static byte[] SwapRedBlue(byte[] png)
{
    using var codec = SkiaSharp.SKCodec.Create(new MemoryStream(png)) ?? throw new InvalidDataException("Not a PNG.");
    var info = new SkiaSharp.SKImageInfo(codec.Info.Width, codec.Info.Height, SkiaSharp.SKColorType.Rgba8888, SkiaSharp.SKAlphaType.Unpremul);
    var pixels = new byte[info.BytesSize];
    var handle = GCHandle.Alloc(pixels, GCHandleType.Pinned);
    try
    {
        if (codec.GetPixels(info, handle.AddrOfPinnedObject()) != SkiaSharp.SKCodecResult.Success) throw new InvalidDataException("PNG decode failed.");
        for (var index = 0; index < pixels.Length; index += 4) (pixels[index], pixels[index + 2]) = (pixels[index + 2], pixels[index]);
        using var pixmap = new SkiaSharp.SKPixmap(info, handle.AddrOfPinnedObject());
        using var encoded = pixmap.Encode(SkiaSharp.SKEncodedImageFormat.Png, 100) ?? throw new InvalidDataException("PNG encode failed.");
        return encoded.ToArray();
    }
    finally
    {
        handle.Free();
    }
}

// ponytail: decodes the whole 16-bit image at once (an 8K source needs ~800 MB); decode by
// scanline if that ever exhausts memory.
static byte[] LinearToSrgb8(byte[] png)
{
    using var codec = SkiaSharp.SKCodec.Create(new MemoryStream(png)) ?? throw new InvalidDataException("Not a PNG.");
    var width = codec.Info.Width;
    var height = codec.Info.Height;
    // Skia's PNG codec refuses a 16-bit unorm target (InvalidConversion) but decodes to half
    // floats, which hold every value an 8-bit result can distinguish. With no colour space on the
    // target it applies no conversion, so these are the stored linear values.
    var wide = new SkiaSharp.SKImageInfo(width, height, SkiaSharp.SKColorType.RgbaF16, SkiaSharp.SKAlphaType.Unpremul);
    var source = new Half[(long) width * height * 4];
    var lut = new byte[65536];
    for (var value = 0; value < lut.Length; value++)
    {
        var linear = value / 65535.0;
        var srgb = linear <= 0.0031308 ? linear * 12.92 : 1.055 * Math.Pow(linear, 1 / 2.4) - 0.055;
        lut[value] = (byte) Math.Clamp(Math.Round(srgb * 255), 0, 255);
    }
    var sourceHandle = GCHandle.Alloc(source, GCHandleType.Pinned);
    try
    {
        if (codec.GetPixels(wide, sourceHandle.AddrOfPinnedObject()) != SkiaSharp.SKCodecResult.Success) throw new InvalidDataException("PNG decode failed.");
    }
    finally
    {
        sourceHandle.Free();
    }
    var narrow = new SkiaSharp.SKImageInfo(width, height, SkiaSharp.SKColorType.Rgba8888, SkiaSharp.SKAlphaType.Unpremul);
    var output = new byte[narrow.BytesSize];
    static int Unorm16(Half value) => (int) Math.Clamp(Math.Round((float) value * 65535f), 0f, 65535f);
    for (long index = 0; index < source.LongLength; index += 4)
    {
        output[index] = lut[Unorm16(source[index])];
        output[index + 1] = lut[Unorm16(source[index + 1])];
        output[index + 2] = lut[Unorm16(source[index + 2])];
        output[index + 3] = (byte) Math.Clamp(Math.Round((float) source[index + 3] * 255f), 0f, 255f); // alpha is coverage, not light
    }
    var outputHandle = GCHandle.Alloc(output, GCHandleType.Pinned);
    try
    {
        using var pixmap = new SkiaSharp.SKPixmap(narrow, outputHandle.AddrOfPinnedObject());
        using var encoded = pixmap.Encode(SkiaSharp.SKEncodedImageFormat.Png, 100) ?? throw new InvalidDataException("PNG encode failed.");
        return encoded.ToArray();
    }
    finally
    {
        outputHandle.Free();
    }
}

static byte[] DecompressEditorPayload(FCompressedBuffer payload)
{
    var header = payload.Header;
    var output = new byte[checked((int) header.TotalRawSize)];
    if (header.Method == FCompressedBufferHeader.EMethod.None)
    {
        if (payload.Data.Length < output.Length) throw new InvalidDataException("Truncated uncompressed editor payload.");
        payload.Data.AsSpan(0, output.Length).CopyTo(output);
        return output;
    }
    if (header.Method is not (FCompressedBufferHeader.EMethod.Oodle or FCompressedBufferHeader.EMethod.LZ4))
        throw new InvalidDataException($"Unsupported editor payload compression {header.Method}.");
    if (header.BlockCount == 0 || header.BlockCount > 1_000_000 || header.BlockSizeExponent > 30)
        throw new InvalidDataException("Invalid editor payload block table.");

    var tableBytes = checked((int) header.BlockCount * sizeof(uint));
    if (tableBytes > payload.Data.Length) throw new InvalidDataException("Truncated editor payload block table.");
    var inputOffset = tableBytes;
    var outputOffset = 0;
    var method = header.Method == FCompressedBufferHeader.EMethod.Oodle
        ? CompressionMethod.Oodle
        : CompressionMethod.LZ4;
    for (var index = 0; index < header.BlockCount; index++)
    {
        var compressedSize = checked((int) BinaryPrimitives.ReadUInt32BigEndian(payload.Data.AsSpan(index * 4, 4)));
        if (compressedSize < 0 || inputOffset > payload.Data.Length - compressedSize)
            throw new InvalidDataException("Truncated editor payload block.");
        var rawSize = Math.Min(1 << header.BlockSizeExponent, output.Length - outputOffset);
        if (rawSize <= 0) throw new InvalidDataException("Editor payload contains excess blocks.");
        Compression.Decompress(payload.Data, inputOffset, compressedSize, output, outputOffset, rawSize, method);
        inputOffset += compressedSize;
        outputOffset += rawSize;
    }
    if (outputOffset != output.Length) throw new InvalidDataException("Editor payload is incomplete.");
    return output;
}

static byte[]? ExtractLargestPng(byte[] bytes)
{
    ReadOnlySpan<byte> signature = [137, 80, 78, 71, 13, 10, 26, 10];
    byte[]? best = null;
    ulong bestArea = 0;
    for (var start = 0; start <= bytes.Length - signature.Length; start++)
    {
        if (!bytes.AsSpan(start, signature.Length).SequenceEqual(signature)) continue;
        var cursor = start + signature.Length;
        uint width = 0, height = 0;
        while (cursor <= bytes.Length - 12)
        {
            var length = BinaryPrimitives.ReadUInt32BigEndian(bytes.AsSpan(cursor, 4));
            if (length > int.MaxValue || cursor + 12L + length > bytes.Length) break;
            var type = Encoding.ASCII.GetString(bytes, cursor + 4, 4);
            if (type == "IHDR" && length >= 8)
            {
                width = BinaryPrimitives.ReadUInt32BigEndian(bytes.AsSpan(cursor + 8, 4));
                height = BinaryPrimitives.ReadUInt32BigEndian(bytes.AsSpan(cursor + 12, 4));
            }
            cursor += checked((int) length + 12);
            if (type != "IEND") continue;
            var area = (ulong) width * height;
            if (area > bestArea)
            {
                bestArea = area;
                best = bytes[start..cursor];
            }
            break;
        }
    }
    return best;
}

static EGame DetectGame(string root)
{
    var project = Directory.EnumerateFiles(root, "*.uproject", SearchOption.AllDirectories).FirstOrDefault();
    if (project is not null)
    {
        var text = File.ReadAllText(project);
        foreach (var (needle, game) in new[] {
            ("5.7", EGame.GAME_UE5_7), ("5.6", EGame.GAME_UE5_6), ("5.5", EGame.GAME_UE5_5),
            ("5.4", EGame.GAME_UE5_4), ("5.3", EGame.GAME_UE5_3), ("5.2", EGame.GAME_UE5_2),
            ("5.1", EGame.GAME_UE5_1), ("5.0", EGame.GAME_UE5_0), ("4.27", EGame.GAME_UE4_27),
            ("4.26", EGame.GAME_UE4_26), ("4.25", EGame.GAME_UE4_25) })
            if (text.Contains(needle, StringComparison.Ordinal)) return game;
    }
    // UE5 changed LegacyFileVersion from -7 to -8. This signal lives in every package and lets a
    // loose marketplace Content directory choose the right serializer without its .uproject.
    var package = Directory.EnumerateFiles(root, "*.uasset", SearchOption.AllDirectories).FirstOrDefault();
    if (package is not null)
    {
        using var stream = File.OpenRead(package);
        Span<byte> header = stackalloc byte[8];
        if (stream.Read(header) == header.Length && BinaryPrimitives.ReadUInt32LittleEndian(header) == 0x9E2A83C1)
        {
            var legacyFileVersion = BinaryPrimitives.ReadInt32LittleEndian(header[4..]);
            if (legacyFileVersion >= -7) return EGame.GAME_UE4_LATEST;
            if (legacyFileVersion <= -9) return EGame.GAME_UE5_7;
        }
    }
    return EGame.GAME_UE5_3;
}

static EGame ParseGame(string version) => version switch
{
    "5.7" => EGame.GAME_UE5_7,
    "5.6" => EGame.GAME_UE5_6,
    "5.5" => EGame.GAME_UE5_5,
    "5.4" => EGame.GAME_UE5_4,
    "5.3" => EGame.GAME_UE5_3,
    "5.2" => EGame.GAME_UE5_2,
    "5.1" => EGame.GAME_UE5_1,
    "5.0" => EGame.GAME_UE5_0,
    "4.27" => EGame.GAME_UE4_27,
    "4.26" => EGame.GAME_UE4_26,
    _ => throw new ArgumentException($"unsupported --engine version {version}")
};

public sealed class USkeletalMeshEditorData : UObject
{
    public override void Deserialize(FAssetArchive ar, long validPos)
    {
        base.Deserialize(ar, validPos);
        var count = ar.Read<int>();
        if (count < 0 || count > 128) throw new InvalidDataException($"Invalid editor LOD count {count}");
        for (var index = 0; index < count; index++)
        {
            if (FEditorObjectVersion.Get(ar) >= FEditorObjectVersion.Type.SkeletalMeshBuildRefactor) ar.Position += 2;
            _ = new FByteBulkData(ar);
            ar.Position += 16;
            _ = ar.ReadBoolean();
        }
    }
}

sealed record EditorMesh(
    float[] Positions,
    int[] InstanceVertices,
    float[] Normals,
    float[] Uv0,
    int[] TriangleInstances,
    int[] TriangleGroups,
    bool[] LiveTriangles,
    string[] GroupSlots);
`;
