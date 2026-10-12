/** Pinned because these changes depend on exact upstream serialization code. */
export const CUE4PARSE_SOURCE = Object.freeze({
  repository: "https://github.com/FabianFG/CUE4Parse.git",
  commit: "b4e95441bcf0c975eb3adb68c0fb44c740c2cf62",
  version: "b4e95441+threenative.81",
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
@@ -192,7 +226,31 @@ public FStaticLODModel(FAssetArchive Ar, bool bHasVertexColors) : this()

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
+            else if (skelMeshVer >= FSkeletalMeshCustomVersion.Type.SplitModelAndRenderData)
+            {
+                // UE4.19-4.24 editor packages keep the imported source model inline as
+                // FRawSkeletalMeshBulkData: a bulk-data header, a GUID and bGuidIsHash.
+                _ = new FByteBulkData(Ar);
+                Ar.Position += 16;
+                _ = Ar.ReadBoolean();
+            }
+        }

         if (Ar.Game != GAME_StateOfDecay2 && Ar.Ver >= EUnrealEngineObjectUE4Version.ADD_SKELMESH_MESHTOIMPORTVERTEXMAP)
         {
@@ -324,6 +382,24 @@ public FStaticLODModel(FAssetArchive Ar, bool bHasVertexColors) : this()
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
@@ -56,7 +56,7 @@ public Gltf(string name, MeshLodDto<SkinnedMeshVertex> lod, bool exportMorphTarg
             for (var j = 0; j < morphTargets.Length; j++)
             {
                 var morphTarget = morphTargets[j].Load<UMorphTarget>();
-                if (morphTarget?.MorphLODModels == null || morphTarget.MorphLODModels.Length < lod.SourceLodIndex || morphTarget.MorphLODModels[lod.SourceLodIndex].Vertices.Length == 0)
+                if (morphTarget?.MorphLODModels == null || morphTarget.MorphLODModels.Length <= lod.SourceLodIndex || morphTarget.MorphLODModels[lod.SourceLodIndex].Vertices.Length == 0)
                     continue;
 
                 var morphBuilder = meshBuilder.UseMorphTarget(j);
@@ -68,12 +68,15 @@ public Gltf(string name, MeshLodDto<SkinnedMeshVertex> lod, bool exportMorphTarg
                 var verts = morphBuilder.Vertices.ToArray();
                 foreach (var delta in morphModel.Vertices)
                 {
+                    // A morph LOD model can carry a source index past this LOD's shorter vertex
+                    // array (Ada_FaceMesh LOD1 has one), which used to fail the whole export.
+                    if (delta.SourceIdx < 0 || delta.SourceIdx >= lod.Vertices.Length) continue;
                     var vert = lod.Vertices[delta.SourceIdx];
                     var srcVert = new VertexPositionNormalTangent(SwapYZ(vert.Position * UnitScale),SwapYZAndNormalize((FVector)vert.Normal) , SwapYZAndNormalize((Vector4)vert.Tangent));
                     var index = FindVert(srcVert, verts);
                     if (index == -1)  continue;
 
-                    morphBuilder.SetVertexDelta(morphBuilder.Vertices.ElementAt(index), new VertexGeometryDelta(SwapYZ(delta.PositionDelta * UnitScale), Vector3.Zero, SwapYZAndNormalize(delta.TangentZDelta)));
+                    morphBuilder.SetVertexDelta(morphBuilder.Vertices.ElementAt(index), new VertexGeometryDelta(SwapYZ(delta.PositionDelta * UnitScale), SwapYZ(delta.TangentZDelta), Vector3.Zero));
                 }
             }
 
diff --git a/CUE4Parse/UE4/Versions/VersionUtils.cs b/CUE4Parse/UE4/Versions/VersionUtils.cs
--- a/CUE4Parse/UE4/Versions/VersionUtils.cs
+++ b/CUE4Parse/UE4/Versions/VersionUtils.cs
@@ -27,4 +27,14 @@ public static class VersionUtils

         return -1; // Determine by game
     }
+
+    // A package saved by UE4 lists every custom version it used, so a GUID missing from its non-empty container names a field its
+    // engine never wrote. CustomVer reports -1 for it and the callers then guess from --engine, which can open a UE5-only field.
+    public static bool IsAbsentInUe4Package(this FArchive Ar, FGuid key)
+    {
+        var summary = (Ar as FAssetArchive)?.Owner?.Summary;
+        return summary is { bUnversioned: false, CustomVersionContainer: { Versions.Length: > 0 } versions } &&
+               summary.FileVersionUE.FileVersionUE5 == 0 &&
+               versions.GetVersion(key) == -1;
+    }
 }
diff --git a/CUE4Parse/UE4/Versions/FUE5MainStreamObjectVersion.cs b/CUE4Parse/UE4/Versions/FUE5MainStreamObjectVersion.cs
--- a/CUE4Parse/UE4/Versions/FUE5MainStreamObjectVersion.cs
+++ b/CUE4Parse/UE4/Versions/FUE5MainStreamObjectVersion.cs
@@ -395,6 +395,8 @@ public static class FUE5MainStreamObjectVersion
         var ver = Ar.CustomVer(GUID);
         if (ver >= 0)
             return (Type) ver;
+        if (Ar.IsAbsentInUe4Package(GUID))
+            return Type.BeforeCustomVersionWasAdded;

         return Ar.Game switch
         {
diff --git a/CUE4Parse/UE4/Versions/FUE5ReleaseStreamObjectVersion.cs b/CUE4Parse/UE4/Versions/FUE5ReleaseStreamObjectVersion.cs
--- a/CUE4Parse/UE4/Versions/FUE5ReleaseStreamObjectVersion.cs
+++ b/CUE4Parse/UE4/Versions/FUE5ReleaseStreamObjectVersion.cs
@@ -227,6 +227,8 @@ public static class FUE5ReleaseStreamObjectVersion
         var ver = Ar.CustomVer(GUID);
         if (ver >= 0)
             return (Type) ver;
+        if (Ar.IsAbsentInUe4Package(GUID))
+            return Type.BeforeCustomVersionWasAdded;

         return Ar.Game switch
         {
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

/**
 * The engine-content rules the converter and its compiled tests share: the root, the key the pinned provider gives a loose
 * directory, the exact /Engine/ reference lookup, and the provenance of a loaded body. Written beside Program.cs and compiled
 * against the pinned CUE4Parse source by tests/unreal-engine-content-compiled.test.ts, so the tests run the shipped code.
 */
export const CUE4PARSE_ENGINE_CONTENT = String.raw`using CUE4Parse.FileProvider;
using CUE4Parse.UE4.Assets;

public static class EngineContent
{
    // Every provider-readable file under the root Root last checked, by the key the pinned provider would register for it. The
    // provider's own comparer is OrdinalIgnoreCase, so a key names its file only when the root spells the two the same way.
    private static readonly Dictionary<string, string> Sources = new(StringComparer.Ordinal);
    // The same keys folded to case, which is exactly how the provider reads them: two files under one folded key would leave one
    // of them unreadable under whichever spelling the enumeration reached first.
    private static readonly Dictionary<string, string> Folded = new(StringComparer.OrdinalIgnoreCase);

    // The extensions the pinned provider registers as files (GameFile.UeKnownExtensions), so a pair of case-distinct folders is
    // judged on the package keys it holds and not on an unrelated file that happens to share a name across the two.
    private static readonly HashSet<string> ProviderFiles = new(StringComparer.OrdinalIgnoreCase)
    {
        "uasset", "umap", "upk", "xxx", "udk", "u", "mbamap", "sword", "rbd", "aa3", "ut3", "ut2", "utx", "unr", "umx",
        "uax", "usx", "ukx", "map", "lm", "s8m", "ccpk", "mo",
        "uexp", "ubulk", "uptnl", "tfc",
        "bin", "ini", "uplugin", "upluginmanifest", "locres", "locmeta", "wem", "ewem", "bnk", "pck", "bank", "awb", "acb",
    };

    // The configured root, without a trailing separator. It must be an existing directory that is not a filesystem root and holds
    // no .uproject (a project, not Engine/Content). A link at the root or anywhere under it is refused before anything is read:
    // links are never followed or skipped, because the provider would read through them and a cache key would miss the bytes.
    // Two files the provider would register under one key are refused here too, before it exists: /Engine/A/T.uasset and an
    // /Engine/a/T.uasset are one key to a case-insensitive comparer, and only one of them could ever be read.
    public static string Root(string configured)
    {
        var root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(configured));
        Sources.Clear();
        Folded.Clear();
        var directory = new DirectoryInfo(root);
        if (!directory.Exists) throw new DirectoryNotFoundException($"engine content directory not found: {root}");
        if (directory.Parent is null) throw new InvalidDataException($"engine content root cannot be a filesystem root: {root}");
        if (directory.LinkTarget is not null) throw new InvalidDataException($"engine content root is a link: {root}; links are refused, not followed");
        if (directory.GetFiles("*.uproject", SearchOption.TopDirectoryOnly).Length > 0) throw new InvalidDataException($"engine content root holds a .uproject, so it is a project rather than Engine/Content: {root}");
        var pending = new Stack<DirectoryInfo>();
        pending.Push(directory);
        var mount = MountPrefix(root);
        while (pending.Count > 0)
        {
            foreach (var entry in pending.Pop().EnumerateFileSystemInfos())
            {
                if (entry.LinkTarget is not null) throw new InvalidDataException($"engine content contains a link at {entry.FullName}; links are refused, not followed or skipped");
                if (entry is DirectoryInfo child) { pending.Push(child); continue; }
                // The provider reads the extension the way SubstringAfter('.') gives it, without its dot.
                var extension = Path.GetExtension(entry.Name).TrimStart('.');
                if (extension.Length == 0 || !ProviderFiles.Contains(extension)) continue;
                // The key the pinned provider builds: the mount prefix, then the path relative to the root in forward slashes.
                var key = mount + Path.GetRelativePath(root, entry.FullName).Replace('\\', '/');
                if (!Folded.TryAdd(key, entry.FullName))
                    throw new InvalidDataException($"engine content holds files the provider would key as one ({key}): {Folded[key]} and {entry.FullName}; case-distinct packages are refused, not merged");
                Sources.Add(key, entry.FullName);
            }
        }
        return root;
    }

    // The key prefix the pinned provider gives a loose directory: DirectoryInfo.Name, the name it reads, which carries no trailing
    // separator. Root refuses a .uproject, the only input that would give the provider a different mount.
    public static string MountPrefix(string root) => new DirectoryInfo(Path.TrimEndingDirectorySeparator(root)).Name + "/";

    // The one key an exact /Engine/<folders>/<name>.<name> reference names under the mount, or false for anything else: an object
    // name that is not the package's own, a path outside /Engine/, an empty, dot or parent segment, a backslash, a drive-style
    // segment or a control character. Nothing is matched by basename, so a same-named body elsewhere is never selected.
    // The spelling is ordinal at both ends. A prefix the reference spells /engine/ is not this mount, and a key the root spells
    // in another case names no file here: the provider's comparer would fold the two and answer a reference with a namesake.
    public static bool TryExactReference(string mountPrefix, string reference, out string key, out string objectName)
    {
        key = string.Empty;
        objectName = string.Empty;
        const string engine = "/Engine/";
        if (!reference.StartsWith(engine, StringComparison.Ordinal)) return false;
        var dot = reference.LastIndexOf('.');
        if (dot < 0) return false;
        var packagePath = reference[..dot];
        objectName = reference[(dot + 1)..];
        if (objectName.Length == 0 || objectName != packagePath[(packagePath.LastIndexOf('/') + 1)..]) return false;
        var folders = packagePath[engine.Length..].Split('/');
        if (folders.Any(folder => folder.Length == 0 || folder == "." || folder == ".." || folder.Contains('\\') || folder.Contains(':') || folder.Any(char.IsControl))) return false;
        var candidate = mountPrefix + string.Join('/', folders) + ".uasset";
        if (!Sources.ContainsKey(candidate)) return false;
        key = candidate;
        return true;
    }

    // The file an exact key names, spelled the way the reference spells it, or null when the root holds only a case-folded
    // namesake. It is the provider key the root registered, so an exact export never resolves its own path by folding.
    public static string? ExactSource(string key) => Sources.TryGetValue(key, out var source) ? source : null;

    // The /Engine/ path of a loaded body's package, when the engine provider loaded that package; otherwise null. Provenance is the
    // provider that loaded the package (IPackage.Provider), never the path a pack names the body by: a pack-owned package keeps no
    // engine provenance even under the engine's own name, and a body reached by a nested call into engine content keeps its own.
    public static string? PackagePath(IPackage? owner, IFileProvider? engineProvider, string? mountPrefix)
    {
        if (owner is null || engineProvider is null || mountPrefix is null || !ReferenceEquals(owner.Provider, engineProvider)) return null;
        // A loaded package is named by its provider key without the extension: "<mount>/Functions/A/B".
        var name = owner.Name;
        if (!name.StartsWith(mountPrefix, StringComparison.OrdinalIgnoreCase) || name.Length == mountPrefix.Length) return null;
        return "/Engine/" + name[mountPrefix.Length..];
    }
}
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
using CUE4Parse.UE4.Assets.Exports.Material.Parameters;
using CUE4Parse.UE4.Assets.Exports.Sound;
using CUE4Parse.UE4.Assets.Exports.Sound.Node;
using CUE4Parse.UE4.Assets.Exports.Animation;
using CUE4Parse.UE4.Objects.PhysicsEngine;
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
using CUE4Parse.UE4.Objects.Core.Misc;
using CUE4Parse.UE4.Versions;
using CUE4Parse_Conversion;
using CUE4Parse_Conversion.Exporters;
using CUE4Parse_Conversion.Options;
using CUE4Parse_Conversion.Sounds;
using Newtonsoft.Json;

if (args.Contains("--version")) { Console.WriteLine("threenative-cue4parse ${CUE4PARSE_SOURCE.version}"); return; }
var dumpAt = Array.IndexOf(args, "--dump-properties");
var graphAt = Array.IndexOf(args, "--dump-graphs");
if (args.Length < 3 || (dumpAt < 0 && graphAt < 0 && !args.Contains("--export-dir"))) throw new ArgumentException("usage: converter SOURCE --export-dir OUTPUT [--filter NAME] [--lods 0,1] | converter SOURCE --dump-properties OUT.json [--engine X] [--filter NAME] | converter SOURCE --dump-graphs OUT_DIR [--engine X] [--filter NAME]");
var root = Path.GetFullPath(args[0]);
var output = dumpAt >= 0 || graphAt >= 0 ? Path.GetFullPath(".") : Path.GetFullPath(args[Array.IndexOf(args, "--export-dir") + 1]);
var filterAt = Array.IndexOf(args, "--filter");
var filter = filterAt >= 0 ? args[filterAt + 1] : null;
// Exact mode: one Engine package, named by its canonical /Engine/ reference under the root (EngineContent.TryExactReference). Only
// that package's own Texture2D is exported, with the suffix and basename fallbacks off, and its sRGB flag written beside the PNG.
var exactAt = Array.IndexOf(args, "--exact-reference");
string? exactPackage = null;
string? exactObject = null;
string? exactFile = null;
if (exactAt >= 0)
{
    if (filterAt >= 0) throw new ArgumentException("--exact-reference and --filter cannot be given together");
    EngineContent.Root(root);
    if (!EngineContent.TryExactReference(EngineContent.MountPrefix(root), args[exactAt + 1], out var exactKey, out var exactName))
        throw new ArgumentException($"--exact-reference is not an exact /Engine/ package reference: {args[exactAt + 1]}");
    exactPackage = exactKey;
    exactObject = exactName;
    // The body the key names, at the spelling the reference gave it. A root that holds only /engine/a/T.uasset has already been
    // refused by TryExactReference, so this is never resolved by folding the key back onto a path.
    exactFile = EngineContent.ExactSource(exactKey)
        ?? throw new ArgumentException($"--exact-reference names no engine source: {args[exactAt + 1]}");
}
// Data-texture mode: one Texture2D of one package, named by its root-relative selector (the package path without .uasset). The
// selector is mapped onto the provider key of the one loose file at that exact path. It writes the stored RGBA16F source bytes
// beside a manifest, and refuses any source it cannot reproduce exactly.
var dataTextureAt = Array.IndexOf(args, "--data-texture");
string? dataTextureSelector = null;
string? dataTextureKey = null;
Rgba16fPackage? dataTexturePackage = null;
if (dataTextureAt >= 0)
{
    if (exactAt >= 0 || filterAt >= 0) throw new ArgumentException("--data-texture cannot be combined with --filter or --exact-reference");
    if (dumpAt >= 0 || graphAt >= 0) throw new ArgumentException("--data-texture cannot be combined with --dump-properties or --dump-graphs");
    if (dataTextureAt + 1 >= args.Length) throw new ArgumentException("--data-texture needs a package key");
    dataTextureSelector = args[dataTextureAt + 1];
    if (dataTextureSelector.Length == 0 || dataTextureSelector.Contains('\\') || dataTextureSelector.StartsWith('/') ||
        dataTextureSelector.Split('/').Any(part => part is "" or "." or ".."))
        throw new ArgumentException($"--data-texture is not a relative package key: {dataTextureSelector}");
    dataTextureKey = dataTextureSelector + ".uasset";
}
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
    // Data-texture mode names one package: the provider key its selector maps to, case and separators included.
    if (dataTexturePackage is not null) return string.Equals(key, dataTexturePackage.Key, StringComparison.Ordinal);
    // Exact mode names one package by its key under the root: no suffix or basename can select another package.
    if (exactPackage is not null) return string.Equals(key, exactPackage, StringComparison.OrdinalIgnoreCase);
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
if (dumpAt < 0 && graphAt < 0)
{
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
    Directory.CreateDirectory(Path.Combine(output, "Grooms"));
    Directory.CreateDirectory(Path.Combine(output, "Gameplay"));
}
ObjectTypeRegistry.RegisterClass(typeof(USkeletalMeshEditorData));
// CUE4Parse swallows an export it cannot deserialize and logs it, which leaves a mesh with no
// geometry and no explanation. Capturing those events lets a missing mesh name its real cause.
var packageReadFailures = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
CUE4Parse.CUE4ParseLog.UseLogger(new Serilog.LoggerConfiguration().MinimumLevel.Error().WriteTo.Sink(new PackageReadFailureSink(packageReadFailures)).CreateLogger());
// Mesh name -> why no GLB was written. Reported on stderr as "threenative-mesh-failure" lines.
var meshFailures = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
string? olderEngineAttempts = null;

var engineAt = Array.IndexOf(args, "--engine");
var game = engineAt >= 0 ? ParseGame(args[engineAt + 1]) : DetectGame(root);
// Engine content is an explicitly configured Engine/Content root and the X.Y version it was cooked for: both or neither.
// It has its own provider and VersionContainer, so the pack's provider and its graph export loop are unchanged.
var engineContentAt = Array.IndexOf(args, "--engine-content");
var engineContentVersionAt = Array.IndexOf(args, "--engine-content-version");
if ((engineContentAt >= 0) != (engineContentVersionAt >= 0)) throw new ArgumentException("--engine-content and --engine-content-version must be given together");
DefaultFileProvider? engineProvider = null;
string? engineContentVersion = null;
string? engineContentKeyPrefix = null;
if (engineContentAt >= 0)
{
    // Refused before the provider enumerates anything: a link at the root or under it, a filesystem root, or a project.
    var engineRoot = EngineContent.Root(args[engineContentAt + 1]);
    engineContentVersion = args[engineContentVersionAt + 1];
    engineProvider = new DefaultFileProvider(engineRoot, SearchOption.AllDirectories, new VersionContainer(ParseGame(engineContentVersion)), StringComparer.OrdinalIgnoreCase);
    engineProvider.Initialize();
    engineProvider.PostMount();
    // The provider keys a loose directory under its own name, so the Content root's keys begin "Content/".
    engineContentKeyPrefix = EngineContent.MountPrefix(engineRoot);
}
var provider = new DefaultFileProvider(root, SearchOption.AllDirectories, new VersionContainer(game), StringComparer.OrdinalIgnoreCase);
var mappings = Directory.EnumerateFiles(root, "*.usmap", SearchOption.AllDirectories).ToArray();
if (mappings.Length > 1) throw new InvalidDataException($"Found {mappings.Length} .usmap files. Keep only the mapping that matches this asset's game/version.");
if (mappings.Length == 1) provider.MappingsContainer = new FileUsmapTypeMappingsProvider(mappings[0]);
provider.Initialize();
provider.PostMount();
if (dataTextureKey is not null) dataTexturePackage = ResolveRgba16fPackage(provider, root, dataTextureSelector!);
if (dumpAt >= 0)
{
    var dumpPath = Path.GetFullPath(args[dumpAt + 1]);
    Directory.CreateDirectory(Path.GetDirectoryName(dumpPath)!);
    var dumpedPackages = new List<Dictionary<string, object?>>();
    foreach (var key in provider.Files.Keys
        .Where(key => key.EndsWith(".uasset", StringComparison.OrdinalIgnoreCase) && MatchesFilter(key))
        .OrderBy(key => key, StringComparer.OrdinalIgnoreCase))
        dumpedPackages.Add(DumpPackage(key));
    var dumpDocument = new Dictionary<string, object?> { ["format"] = 1, ["game"] = game.ToString(), ["packages"] = dumpedPackages };
    File.WriteAllText(dumpPath, JsonConvert.SerializeObject(dumpDocument, Formatting.Indented), new UTF8Encoding(false));
    Console.WriteLine($"dumped {dumpedPackages.Count} packages to {dumpPath}");
    return;
}

// Inlined function bodies count: a layered master (Paragon's Master_SidesMarble) needs more than 2000.
const int GraphNodeLimit = 10000;
const int GraphFunctionDepthLimit = 8;
// Properties that describe editor placement or bookkeeping, not the computation.
var GraphIgnoredProperties = new HashSet<string>(StringComparer.Ordinal)
{
    "MaterialExpressionEditorX", "MaterialExpressionEditorY", "MaterialExpressionGuid", "Desc", "bCollapsed", "bRealtimePreview",
    "bCommentBubbleVisible", "ParameterName", "Group", "SortPriority", "ExpressionGUID", "Id", "MenuCategories", "GraphNode",
    "Material", "Function", "Texture", "MaterialFunction", "SamplerType", "Outputs", "FunctionInputs", "FunctionOutputs",
    "FunctionExpressions",
};
var graphLegacyCache = new Dictionary<string, Dictionary<string, GraphLegacyInput>>(StringComparer.Ordinal);
var graphLegacyFunctionCache = new Dictionary<string, List<GraphLegacyInput>?>(StringComparer.Ordinal);
Dictionary<string, string>? graphFunctionKeys = null;
var graphPackageKeys = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
var graphPackageArchives = new Dictionary<string, FAssetArchive?>(StringComparer.OrdinalIgnoreCase);
var GraphMaterialOutputs = new (string Output, string Property)[]
{
    ("baseColor", "BaseColor"), ("roughness", "Roughness"), ("metallic", "Metallic"), ("emissive", "EmissiveColor"),
    ("opacity", "Opacity"), ("opacityMask", "OpacityMask"), ("normal", "Normal"), ("materialAttributes", "MaterialAttributes"),
};

if (graphAt >= 0)
{
    var graphDir = Path.GetFullPath(args[graphAt + 1]);
    Directory.CreateDirectory(graphDir);
    var graphFileNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    var graphCount = 0;
    foreach (var key in provider.Files.Keys
        .Where(key => key.EndsWith(".uasset", StringComparison.OrdinalIgnoreCase) && MatchesFilter(key))
        .OrderBy(key => key, StringComparer.OrdinalIgnoreCase))
    {
        try { graphCount += DumpMaterialGraphs(key, graphDir, graphFileNames); }
        catch (Exception error) { Console.Error.WriteLine($"graph dump skipped {key}: {error.Message}"); }
    }
    Console.WriteLine($"dumped {graphCount} material graphs to {graphDir}");
    return;
}

static object? GraphValue(object? value) => value switch
{
    null => null,
    bool flag => flag,
    float number => DumpNum(number),
    double number => double.IsFinite(number) ? number : 0d,
    int number => number,
    uint number => number,
    long number => number,
    short number => number,
    byte number => number,
    FLinearColor color => new[] { DumpNum(color.R), DumpNum(color.G), DumpNum(color.B), DumpNum(color.A) },
    FColor color => new[] { color.R / 255d, color.G / 255d, color.B / 255d, color.A / 255d },
    FVector vector => DumpVec(vector),
    FVector2D vector => new[] { DumpNum(vector.X), DumpNum(vector.Y) },
    // A FunctionInput's PreviewValue: the constant an unconnected input compiles to.
    FVector4 vector => new[] { DumpNum(vector.X), DumpNum(vector.Y), DumpNum(vector.Z), DumpNum(vector.W) },
    FName name => name.Text,
    string text => text,
    FScriptStruct script => GraphValue(script.StructType),
    _ => null,
};
// A scalar is kept when it reads. A UV set the export holds but cannot be read is not dropped: an absent CoordinateIndex or
// ConstCoordinate means UV0, so it is kept under the name with an "Error" suffix, and the material graph refuses it only where
// that set is demanded. Other unreadable scalars are still dropped.
static void GraphRecordConstant(Dictionary<string, object?> constants, string name, int arrayIndex, string typeName, object? value)
{
    var converted = GraphValue(value);
    if (converted is not null) constants[arrayIndex > 0 ? $"{name}[{arrayIndex}]" : name] = converted;
    else if (name is "CoordinateIndex" or "ConstCoordinate") constants[name + "Error"] = $"property {name} ({typeName}) could not be read";
}
static string GraphEnumName(object? value, string prefix)
{
    var text = value switch { FName name => name.Text, null => "", _ => value.ToString() ?? "" };
    var colons = text.LastIndexOf("::", StringComparison.Ordinal);
    if (colons >= 0) text = text[(colons + 2)..];
    return text.StartsWith(prefix, StringComparison.Ordinal) ? text[prefix.Length..] : text;
}
static string GraphText(object? value) => value switch { FName name => name.Text ?? "", string text => text, _ => "" };
static string? GraphGuid(FPropertyTag? property) =>
    property?.Tag?.GenericValue is FScriptStruct { StructType: FGuid guid } ? guid.ToString() : null;
static bool GraphBool(UObject expr, string name) =>
    expr.Properties.Any(property => property.Name.Text == name && property.Tag?.GenericValue is bool flag && flag);
static FPropertyTag? GraphProperty(IPropertyHolder holder, string name) =>
    holder.Properties.FirstOrDefault(property => property.Name.Text == name);
static bool GraphIsInput(object? value) => value is GraphLegacyInput or FScriptStruct { StructType: FExpressionInput };
// UE4 packages store an input as tagged properties inside FExpressionInput.FallbackStruct; newer ones serialize it natively.
static (FPackageIndex? Expression, int Output, int[]? Mask, object? Constant, bool UseConstant) GraphReadInput(object? value)
{
    if (value is GraphLegacyInput legacy) return (legacy.Expression, legacy.Output, legacy.Mask, legacy.Constant, legacy.UseConstant);
    var holder = value is FScriptStruct script ? script.StructType : value;
    if (holder is not FExpressionInput input) return (null, 0, null, null, false);
    FPackageIndex? expression;
    int output, mask;
    int[] channels;
    object? constant = null;
    var useConstant = false;
    if (input.FallbackStruct is { } fallback)
    {
        expression = GraphProperty(fallback, "Expression")?.Tag?.GenericValue as FPackageIndex;
        output = GraphProperty(fallback, "OutputIndex")?.Tag?.GenericValue is int outputIndex ? outputIndex : 0;
        int Channel(string name) => GraphProperty(fallback, name)?.Tag?.GenericValue is int channel ? channel : 0;
        mask = Channel("Mask");
        channels = new[] { Channel("MaskR"), Channel("MaskG"), Channel("MaskB"), Channel("MaskA") };
        useConstant = GraphProperty(fallback, "UseConstant")?.Tag?.GenericValue is true;
        constant = GraphValue(GraphProperty(fallback, "Constant")?.Tag?.GenericValue);
    }
    else
    {
        expression = input.Expression;
        output = input.OutputIndex;
        mask = input.Mask;
        channels = new[] { input.MaskR, input.MaskG, input.MaskB, input.MaskA };
        var type = input.GetType();
        useConstant = type.GetProperty("UseConstant")?.GetValue(input) is true;
        constant = useConstant ? GraphValue(type.GetProperty("Constant")?.GetValue(input)) : null;
    }
    return (expression, output, mask != 0 ? channels : null, constant, useConstant);
}

// A Custom node's Inputs array wraps each FExpressionInput in an FStructFallback that also carries the pin's
// InputName. Returns the named pins in array order, or null with a reason when the layout is raw, a wrapper is
// unreadable, or a name repeats; an unnamed pin keeps its index as a stable key. The value is the unwrapped
// FExpressionInput, so its target, OutputIndex and mask survive unchanged.
static List<(string Name, object Value)>? GraphCustomInputs(bool raw, UScriptArray array, out string? error)
{
    if (raw)
    {
        error = "Custom Inputs use a raw layout this converter cannot read";
        return null;
    }
    var seen = new HashSet<string>(StringComparer.Ordinal);
    var pins = new List<(string Name, object Value)>();
    for (var element = 0; element < array.Properties.Count; element++)
    {
        if (array.Properties[element].GenericValue is not FScriptStruct { StructType: FStructFallback wrapper })
        {
            error = $"Custom Inputs[{element}] is not a struct wrapper";
            return null;
        }
        var name = GraphText(GraphProperty(wrapper, "InputName")?.Tag?.GenericValue);
        if (string.IsNullOrEmpty(name)) name = $"Inputs[{element}]";
        if (!seen.Add(name))
        {
            error = $"Custom Inputs has a duplicate pin name {name}";
            return null;
        }
        if (GraphProperty(wrapper, "Input")?.Tag?.GenericValue is not FScriptStruct { StructType: FExpressionInput input })
        {
            error = $"Custom Input {name} has no readable input";
            return null;
        }
        pins.Add((name, input));
    }
    error = null;
    return pins;
}

// Real Unreal reads an input as tagged properties when the package does not record FCoreObjectVersion at all.
// CUE4Parse guesses from --engine when the package records nothing, and that guess is wrong for packages saved by UE 4.5.
static bool GraphTaggedInputs(IPackage? package) =>
    package is Package legacy && (legacy.Summary.CustomVersionContainer?.Versions.All(version => version.Key != FCoreObjectVersion.GUID) ?? true);
// A native package that records no FFrameworkObjectVersion keeps a pin's InputName as an FString (Unreal reads a missing custom version as the
// oldest), but CUE4Parse guesses an FName from --engine and misreads every input's mask, or drops a connected Color/Scalar input outright.
static bool GraphPinsAsString(IPackage? package) =>
    package is Package legacy && (legacy.Summary.CustomVersionContainer?.Versions.All(version => version.Key != FFrameworkObjectVersion.GUID) ?? false);
// Inputs CUE4Parse cannot be trusted with: re-read from the raw bytes.
static bool GraphRawInputs(IPackage? package) => GraphTaggedInputs(package) || GraphPinsAsString(package);
// Packages saved by UE 4.5 store each FExpressionInput as tagged properties that CUE4Parse mis-reads as the native layout and drops.
// Re-read those struct payloads from the raw package bytes.
FAssetArchive? GraphRawArchive(Package legacy)
{
    if (!graphPackageArchives.TryGetValue(legacy.Name, out var archive))
    {
        archive = null;
        try
        {
            // A package reached through a function call was never mounted by the dump loop: find its file by name.
            if (!graphPackageKeys.ContainsKey(legacy.Name) &&
                provider.Files.Keys.FirstOrDefault(candidate => string.Equals(Path.ChangeExtension(candidate, null), legacy.Name, StringComparison.OrdinalIgnoreCase)) is { } located)
                graphPackageKeys[legacy.Name] = located;
            if (graphPackageKeys.TryGetValue(legacy.Name, out var key))
            {
                var bytes = provider.SaveAsset(key);
                archive = new FAssetArchive(new FByteArchive(key, bytes, (VersionContainer) provider.Versions.Clone()), legacy);
                _ = new FPackageFileSummary(archive);
            }
        }
        catch { archive = null; }
        graphPackageArchives[legacy.Name] = archive;
    }
    return archive;
}
// The same recovery for a function call's FunctionInputs: every element nests an FExpressionInput (Input) that CUE4Parse reads in
// the native layout, so an unwired or wired pin of an old package arrives as junk (a pin on the call itself, masks like 67108864)
// and the call, with the engine function behind it, looks like a cycle. Null when the array cannot be re-read.
List<GraphLegacyInput>? GraphLegacyFunctionInputs(UObject call)
{
    if (call.Owner is not Package legacy) return null;
    var cacheKey = legacy.Name + "#" + call.Name;
    if (graphLegacyFunctionCache.TryGetValue(cacheKey, out var cached)) return cached;
    graphLegacyFunctionCache[cacheKey] = null;
    var archive = GraphRawArchive(legacy);
    var export = legacy.ExportMap.FirstOrDefault(item => item.ObjectName.Text == call.Name);
    if (archive is null || export is null) return null;
    var native = !GraphTaggedInputs(legacy);
    archive.Position = export.SerialOffset;
    List<GraphLegacyInput>? result = null;
    while (true)
    {
        FPropertyTag tag;
        try { tag = new FPropertyTag(archive, false); } catch { break; }
        if (tag.Name.IsNone) break;
        var end = archive.Position + tag.Size;
        try
        {
            if (tag.Name.Text == "FunctionInputs" && tag.PropertyType.Text == "ArrayProperty" && tag.TagData?.InnerType == "StructProperty")
            {
                var count = archive.Read<int>();
                if (count > 0 && archive.Ver >= EUnrealEngineObjectUE4Version.INNER_ARRAY_TAG_INFO) _ = new FPropertyTag(archive, false);
                var elements = new List<GraphLegacyInput>();
                for (var element = 0; element < count; element++)
                {
                    var input = new GraphLegacyInput(null, 0, null, null, false);
                    while (true)
                    {
                        var item = new FPropertyTag(archive, false);
                        if (item.Name.IsNone) break;
                        var itemEnd = archive.Position + item.Size;
                        if (item.Name.Text == "Input") input = native ? GraphReadNativeInput(archive, legacy) : GraphReadLegacyInput(archive, itemEnd);
                        archive.Position = itemEnd;
                    }
                    elements.Add(input);
                }
                result = elements;
            }
        }
        catch { result = null; }
        archive.Position = end;
    }
    graphLegacyFunctionCache[cacheKey] = result;
    return result;
}
// The value of an expression's input property, recovered from the raw package when it is stored as tagged properties.
object? GraphInputValue(UObject expr, string name)
{
    var property = GraphProperty(expr, name);
    var value = property?.Tag?.GenericValue;
    if (property is not null && property.PropertyType.Text == "StructProperty" &&
        (property.Tag is null || (GraphRawInputs(expr.Owner) && value is FScriptStruct { StructType: FExpressionInput })))
        return GraphLegacyInputs(expr).TryGetValue(name, out var recovered) ? recovered : null;
    return value;
}
Dictionary<string, GraphLegacyInput> GraphLegacyInputs(UObject expr)
{
    var inputs = new Dictionary<string, GraphLegacyInput>(StringComparer.Ordinal);
    if (expr.Owner is not Package legacy) return inputs;
    var cacheKey = legacy.Name + "#" + expr.Name;
    if (graphLegacyCache.TryGetValue(cacheKey, out var cached)) return cached;
    graphLegacyCache[cacheKey] = inputs;
    var archive = GraphRawArchive(legacy);
    if (archive is null) return inputs;
    var export = legacy.ExportMap.FirstOrDefault(item => item.ObjectName.Text == expr.Name);
    if (export is null) return inputs;
    // A package that records FCoreObjectVersion stores an input natively; CUE4Parse's own read of a connected Color/Scalar input
    // of such a package can still fail and drop the property (a UE 4.21 re-save), so the native payload is re-read here too.
    var native = !GraphTaggedInputs(legacy);
    archive.Position = export.SerialOffset;
    while (true)
    {
        FPropertyTag tag;
        try { tag = new FPropertyTag(archive, false); } catch { break; }
        if (tag.Name.IsNone) break;
        var end = archive.Position + tag.Size;
        try
        {
            if (tag.PropertyType.Text == "StructProperty" && tag.TagData?.StructType is "ExpressionInput" or "ColorMaterialInput" or "ScalarMaterialInput" or "VectorMaterialInput" or "Vector2MaterialInput" or "MaterialAttributesInput")
                inputs[tag.ArrayIndex > 0 ? $"{tag.Name.Text}[{tag.ArrayIndex}]" : tag.Name.Text] = native ? GraphReadNativeInput(archive, legacy) : GraphReadLegacyInput(archive, end);
        }
        catch { }
        archive.Position = end;
    }
    return inputs;
}
// The native layout (Expression, OutputIndex, InputName, Mask, MaskR..A); the UseConstant/Constant tail is not needed for a wired input.
static GraphLegacyInput GraphReadNativeInput(FAssetArchive archive, Package legacy)
{
    var expression = new FPackageIndex(archive);
    var output = archive.Read<int>();
    if (legacy.Summary.CustomVersionContainer?.Versions.FirstOrDefault(version => version.Key == FFrameworkObjectVersion.GUID) is { } framework &&
        framework.Version >= (int) FFrameworkObjectVersion.Type.PinsStoreFName) archive.ReadFName();
    else archive.ReadFString();
    var mask = archive.Read<int>();
    var channels = new[] { archive.Read<int>(), archive.Read<int>(), archive.Read<int>(), archive.Read<int>() };
    return new GraphLegacyInput(expression, output, mask != 0 ? channels : null, null, false);
}
static GraphLegacyInput GraphReadLegacyInput(FAssetArchive archive, long structEnd)
{
    FPackageIndex? expression = null;
    int output = 0, mask = 0;
    var channels = new int[4];
    var useConstant = false;
    object? constant = null;
    while (archive.Position < structEnd)
    {
        var tag = new FPropertyTag(archive, false);
        if (tag.Name.IsNone) break;
        var end = archive.Position + tag.Size;
        switch (tag.Name.Text)
        {
            case "Expression": expression = new FPackageIndex(archive); break;
            case "OutputIndex": output = archive.Read<int>(); break;
            case "Mask": mask = archive.Read<int>(); break;
            case "MaskR": channels[0] = archive.Read<int>(); break;
            case "MaskG": channels[1] = archive.Read<int>(); break;
            case "MaskB": channels[2] = archive.Read<int>(); break;
            case "MaskA": channels[3] = archive.Read<int>(); break;
            case "UseConstant": useConstant = tag.TagData?.Bool == true; break;
            case "Constant":
                if (tag.PropertyType.Text == "FloatProperty") constant = GraphValue(archive.Read<float>());
                else if (tag.TagData?.StructType == "Color") constant = GraphValue(archive.Read<FColor>());
                else if (tag.TagData?.StructType == "LinearColor") constant = GraphValue(archive.Read<FLinearColor>());
                else if (tag.TagData?.StructType == "Vector") constant = GraphValue(archive.Read<FVector>());
                break;
        }
        archive.Position = end;
    }
    return new GraphLegacyInput(expression, output, mask != 0 ? channels : null, constant, useConstant);
}

int DumpMaterialGraphs(string key, string graphDir, HashSet<string> usedFileNames)
{
    IPackage package;
    try { package = provider.LoadPackage(key); }
    catch (Exception error) { Console.Error.WriteLine($"graph dump could not load {key}: {error.Message}"); return 0; }
    var written = 0;
    graphPackageKeys[package.Name] = key;
    for (var index = 0; index < package.ExportsLazy.Length; index++)
    {
        string className, exportName;
        try { className = DumpExportClass(package, index); exportName = DumpExportName(package, index); }
        catch { continue; }
        if (className == "MaterialInstanceConstant")
        {
            DumpMaterialInstanceRecord(package, index, exportName, graphDir, usedFileNames);
            continue;
        }
        if (className != "Material") continue;
        Dictionary<string, object?> document;
        try { document = BuildMaterialGraph(package, package.ExportsLazy[index].Value, exportName); }
        catch (Exception error)
        {
            document = new Dictionary<string, object?>
            {
                ["format"] = 1, ["material"] = exportName, ["package"] = DumpGamePath(package.Name), ["truncated"] = false, ["nodeCount"] = 0,
                ["outputs"] = GraphMaterialOutputs.ToDictionary(item => item.Output, item => (object?) null),
                ["nodes"] = new List<object>(), ["error"] = error.Message,
            };
        }
        var fileName = exportName;
        for (var suffix = 2; !usedFileNames.Add(fileName); suffix++) fileName = $"{exportName}__{suffix}";
        File.WriteAllText(Path.Combine(graphDir, fileName + ".graph.json"), JsonConvert.SerializeObject(document, Formatting.Indented), new UTF8Encoding(false));
        written++;
    }
    return written;
}

// A UMaterialInstanceConstant a graph dump loads, as one qualified record beside the graphs (converter 74). props holds only the
// instance's own overrides, in the .props.txt blocks the importer reads: its Parent line, MaterialOverrides.Blocks (scalars, vectors
// and static switches) and its own TextureParameterValues by qualified package and object. A flattened CollectedTextureParameters
// block never enters a record. A read that cannot be proven complete is recorded as refused with its reason, never dropped.
void DumpMaterialInstanceRecord(IPackage package, int index, string exportName, string graphDir, HashSet<string> usedFileNames)
{
    var record = new Dictionary<string, object?>
    {
        ["format"] = 1, ["kind"] = "materialInstance", ["package"] = DumpGamePath(package.Name), ["object"] = exportName,
        ["parent"] = null, ["complete"] = false, ["props"] = null, ["refusal"] = null,
    };
    try
    {
        if (package.ExportsLazy[index].Value is not UMaterialInstanceConstant instance)
            throw new InvalidDataException($"{exportName} did not deserialize as a material instance");
        var text = new StringBuilder();
        if (instance.TryGetValue<FPackageIndex>(out var parent, "Parent") && !parent.IsNull && parent.Name != "None")
        {
            var parentPackage = ResolvedPackagePath(package.ResolvePackageIndex(parent));
            if (parentPackage is null) throw new InvalidDataException($"the parent of {exportName} does not resolve to a qualified package");
            record["parent"] = new Dictionary<string, object?> { ["package"] = parentPackage, ["object"] = parent.Name };
            text.AppendLine($"Parent = Material'{parentPackage}.{parent.Name}'");
        }
        // The scalar, vector and static switch blocks are MaterialOverrides' own: a layer, an unreadable row or an incomplete read refuses here.
        text.Append(MaterialOverrides.Blocks(instance, exportName, packageReadFailures));
        text.Append(MaterialOverrides.Textures(instance, exportName, packageReadFailures, reference => {
            try { return ResolvedPackagePath(package.ResolvePackageIndex(reference)); } catch { return null; }
        }));
        record["complete"] = true;
        record["props"] = text.ToString();
    }
    catch (Exception error)
    {
        record["refusal"] = error.Message;
    }
    var fileName = exportName;
    for (var suffix = 2; !usedFileNames.Add(fileName); suffix++) fileName = $"{exportName}__{suffix}";
    File.WriteAllText(Path.Combine(graphDir, fileName + ".instance.json"), JsonConvert.SerializeObject(record, Formatting.Indented), new UTF8Encoding(false));
}

Dictionary<string, object?> BuildMaterialGraph(IPackage package, UObject material, string materialName)
{
    var nodes = new List<Dictionary<string, object?>>();
    var ids = new Dictionary<string, string>(StringComparer.Ordinal);
    var counter = 0;
    var truncated = false;

    Dictionary<string, object?>? Pin(object? value, string prefix, Dictionary<string, Dictionary<string, object?>?>? callInputs, int depth)
    {
        var (expression, output, mask, _, _) = GraphReadInput(value);
        if (expression is null || expression.IsNull) return null;
        UObject? target;
        string? failure = null;
        try { target = expression.Load<UObject>(); }
        catch (Exception error) { target = null; failure = error.Message; }
        string? id = null;
        if (target is null)
        {
            if (nodes.Count >= GraphNodeLimit) { truncated = true; return null; }
            id = prefix + "n" + counter++;
            nodes.Add(new Dictionary<string, object?> { ["id"] = id, ["class"] = "Unresolved", ["error"] = failure ?? "expression could not be loaded" });
        }
        else id = EmitNode(target, prefix, callInputs, depth);
        if (id is null) return null;
        return new Dictionary<string, object?> { ["node"] = id, ["output"] = output, ["mask"] = mask };
    }

    string? EmitNode(UObject expr, string prefix, Dictionary<string, Dictionary<string, object?>?>? callInputs, int depth)
    {
        var key = prefix + expr.GetPathName();
        if (ids.TryGetValue(key, out var existing)) return existing;
        if (nodes.Count >= GraphNodeLimit) { truncated = true; return null; }
        var id = prefix + "n" + counter++;
        ids[key] = id;
        var className = expr.ExportType;
        if (className.StartsWith("MaterialExpression", StringComparison.Ordinal)) className = className["MaterialExpression".Length..];
        var node = new Dictionary<string, object?> { ["id"] = id, ["class"] = className };
        nodes.Add(node);
        var inputs = new Dictionary<string, object?>();
        var constants = new Dictionary<string, object?>();
        node["inputs"] = inputs;
        node["constants"] = constants;
        var owner = expr.Owner;
        try
        {
            var isFunctionCall = className == "MaterialFunctionCall";
            var isFunctionInput = className == "FunctionInput";
            if (isFunctionCall) { className = "FunctionCall"; node["class"] = className; }
            Dictionary<string, GraphLegacyInput>? legacyInputs = null;
            var taggedPackage = GraphRawInputs(owner);
            foreach (var property in expr.Properties)
            {
                var name = property.Name.Text;
                var value = property.Tag?.GenericValue;
                try
                {
                    if (property.PropertyType.Text == "StructProperty" && (property.Tag is null || (taggedPackage && value is FScriptStruct { StructType: FExpressionInput })))
                    {
                        // CUE4Parse dropped this property; recover an expression input from the raw package or say so.
                        var legacyName = property.ArrayIndex > 0 ? $"{name}[{property.ArrayIndex}]" : name;
                        legacyInputs ??= GraphLegacyInputs(expr);
                        if (legacyInputs.TryGetValue(legacyName, out var recovered)) value = recovered;
                        else { node["error"] = $"property {name} ({property.PropertyType.Text}) could not be read"; continue; }
                    }
                    if (value is GraphLegacyInput or FScriptStruct { StructType: FExpressionInput })
                    {
                        // Fixed C arrays (FeatureLevelSwitch.Inputs, ...) arrive as one tag per element.
                        var pinName = property.ArrayIndex > 0 || name == "Inputs" ? $"{name}[{property.ArrayIndex}]" : name;
                        var (_, _, _, constant, useConstant) = GraphReadInput(value);
                        inputs[pinName] = Pin(value, prefix, callInputs, depth);
                        if (useConstant && constant is not null) constants[pinName] = constant;
                    }
                    else if (value is UScriptArray array)
                    {
                        if (name == "Outputs")
                        {
                            var names = new List<string>();
                            foreach (var element in array.Properties)
                                names.Add(element.GenericValue is FScriptStruct { StructType: FStructFallback outputItem } ? GraphText(GraphProperty(outputItem, "OutputName")?.Tag?.GenericValue) : "");
                            node["outputNames"] = names;
                        }
                        else if (name is "AttributeSetTypes" or "AttributeGetTypes")
                        {
                            // SetMaterialAttributes pin Inputs[i] carries attribute AttributeSetTypes[i-1]; GetMaterialAttributes output i is AttributeGetTypes[i].
                            var guids = new List<string>();
                            foreach (var element in array.Properties)
                                guids.Add(element.GenericValue is FScriptStruct { StructType: FGuid attributeGuid } ? attributeGuid.ToString() : "");
                            node["attributeTypes"] = guids;
                        }
                        else if (className == "Custom" && name == "Inputs")
                        {
                            // A Custom node's Inputs array wraps each pin's FExpressionInput; name it from its InputName.
                            var custom = GraphCustomInputs(GraphRawInputs(owner), array, out var customError);
                            if (custom is null) node["error"] = customError;
                            else foreach (var (pinName, pinValue) in custom) inputs[pinName] = Pin(pinValue, prefix, callInputs, depth);
                        }
                        else if (array.Properties.Count > 0 && array.Properties.All(element => GraphIsInput(element.GenericValue)))
                        {
                            for (var element = 0; element < array.Properties.Count; element++)
                                inputs[$"{name}[{element}]"] = Pin(array.Properties[element].GenericValue, prefix, callInputs, depth);
                        }
                    }
                    else if (!GraphIgnoredProperties.Contains(name) && !name.StartsWith("MaterialExpression", StringComparison.Ordinal))
                        GraphRecordConstant(constants, name, property.ArrayIndex, property.PropertyType.Text, value);
                }
                catch (Exception error) { node["error"] = $"{name}: {error.Message}"; }
            }

            if (className.Contains("Parameter", StringComparison.Ordinal))
            {
                var parameterName = GraphText(GraphProperty(expr, "ParameterName")?.Tag?.GenericValue);
                var group = GraphText(GraphProperty(expr, "Group")?.Tag?.GenericValue);
                node["parameter"] = new Dictionary<string, object?> { ["name"] = parameterName, ["group"] = group };
                var defaultTag = GraphProperty(expr, "DefaultValue")?.Tag?.GenericValue;
                // Tagged serialization omits values equal to the class default, so an absent DefaultValue is the zero value.
                constants.Remove("DefaultValue");
                node["default"] = GraphValue(defaultTag) ?? (className.Contains("Vector", StringComparison.Ordinal) ? new[] { 0d, 0d, 0d, 0d }
                    : className.Contains("Scalar", StringComparison.Ordinal) ? 0d
                    : className.Contains("Static", StringComparison.Ordinal) ? false : null);
                // A CollectionParameter reads a MaterialParameterCollection: its default is the collection entry's
                // DefaultValue (a scalar, or a linear colour), which is what the editor renders until gameplay sets it.
                if (className == "CollectionParameter")
                {
                    node["default"] = GraphCollectionDefault(GraphProperty(expr, "Collection")?.Tag?.GenericValue as FPackageIndex, parameterName);
                    if (GraphProperty(expr, "Collection")?.Tag?.GenericValue is FPackageIndex collectionIndex && owner is not null)
                        node["collection"] = DumpPath(owner, collectionIndex);
                }
            }
            if (className.StartsWith("TextureSample", StringComparison.Ordinal) || className.StartsWith("TextureObject", StringComparison.Ordinal))
            {
                node["texture"] = GraphProperty(expr, "Texture")?.Tag?.GenericValue is FPackageIndex textureIndex && owner is not null ? DumpPath(owner, textureIndex) : null;
                node["samplerType"] = GraphProperty(expr, "SamplerType") is { } sampler ? GraphEnumName(sampler.Tag?.GenericValue, "SAMPLERTYPE_") : "Color";
                node["coordinates"] = inputs.TryGetValue("Coordinates", out var coordinates) ? coordinates : null;
            }
            // Unreal omits the pin names of a Break node when they equal the class default; indices 0-7 are the first eight attributes.
            if (className == "BreakMaterialAttributes" && !node.ContainsKey("outputNames"))
                node["outputNames"] = new[] { "BaseColor", "Metallic", "Specular", "Roughness", "EmissiveColor", "Opacity", "OpacityMask", "Normal" };
            if (className == "TextureCoordinate")
            {
                double Tile(string name) => GraphProperty(expr, name)?.Tag?.GenericValue is float tile ? DumpNum(tile) : 1d;
                node["tiling"] = new[] { Tile("UTiling"), Tile("VTiling") };
            }
            if (className == "ComponentMask")
                node["channelMask"] = new[] { GraphBool(expr, "R") ? 1 : 0, GraphBool(expr, "G") ? 1 : 0, GraphBool(expr, "B") ? 1 : 0, GraphBool(expr, "A") ? 1 : 0 };
            if (className is "StaticSwitch" or "StaticSwitchParameter") node["switchValue"] = GraphBool(expr, "DefaultValue");

            if (isFunctionInput)
            {
                // Inside an inlined function: the call's real input replaces the preview input.
                var path = expr.GetPathName();
                if (callInputs is not null && callInputs.TryGetValue(path, out var actual) && actual is not null) inputs["Input"] = actual;
                else if (!inputs.ContainsKey("Input")) inputs["Input"] = null;
                constants["InputName"] = GraphText(GraphProperty(expr, "InputName")?.Tag?.GenericValue);
            }
            if (className == "NamedRerouteUsage")
            {
                // A usage has no input of its own: link it to its declaration so the declaration's Input is followed.
                var declarationGuid = GraphGuid(GraphProperty(expr, "DeclarationGuid"));
                if (declarationGuid is not null) constants["DeclarationGuid"] = declarationGuid;
                UObject? declaration = null;
                if (GraphProperty(expr, "Declaration")?.Tag?.GenericValue is FPackageIndex declarationIndex && !declarationIndex.IsNull)
                {
                    try { declaration = declarationIndex.Load<UObject>(); } catch { }
                }
                if (declaration is null && declarationGuid is not null && owner is not null)
                {
                    for (var exportIndex = 0; exportIndex < owner.ExportsLazy.Length && declaration is null; exportIndex++)
                    {
                        try
                        {
                            if (!DumpExportClass(owner, exportIndex).EndsWith("NamedRerouteDeclaration", StringComparison.Ordinal)) continue;
                            var candidate = owner.ExportsLazy[exportIndex].Value;
                            if (GraphGuid(GraphProperty(candidate, "VariableGuid")) == declarationGuid) declaration = candidate;
                        }
                        catch { }
                    }
                }
                if (declaration is null) node["error"] = "named reroute declaration could not be found";
                else
                {
                    var declarationId = EmitNode(declaration, prefix, callInputs, depth);
                    if (declarationId is null) node["error"] = "named reroute declaration could not be emitted (graph node limit)";
                    else inputs["Input"] = new Dictionary<string, object?> { ["node"] = declarationId, ["output"] = 0, ["mask"] = null };
                }
            }
            if (isFunctionCall) InlineFunctionCall(expr, id, node, prefix, callInputs, depth);
        }
        catch (Exception error) { node["error"] = error.Message; }
        return id;
    }

    // A pack may mount its content under any folder (Polyphoria/Polyphoria/...), so a reference that does not load
    // as given is found again by its file name among the pack's own packages. Engine content is never in the pack.
    object? GraphCollectionDefault(FPackageIndex? collectionIndex, string parameterName)
    {
        if (collectionIndex is null || collectionIndex.IsNull || string.IsNullOrEmpty(parameterName)) return null;
        UObject? collection = null;
        try { collection = collectionIndex.Load<UObject>(); } catch { }
        collection ??= GraphLoadFunction(null, collectionIndex.ResolvedObject?.GetPathName());
        if (collection is null) return null;
        foreach (var entry in collection.GetOrDefault<FStructFallback[]>("ScalarParameters") ?? Array.Empty<FStructFallback>())
            if (GraphText(GraphProperty(entry, "ParameterName")?.Tag?.GenericValue).Equals(parameterName, StringComparison.OrdinalIgnoreCase))
                return GraphValue(GraphProperty(entry, "DefaultValue")?.Tag?.GenericValue) ?? 0d;
        foreach (var entry in collection.GetOrDefault<FStructFallback[]>("VectorParameters") ?? Array.Empty<FStructFallback>())
            if (GraphText(GraphProperty(entry, "ParameterName")?.Tag?.GenericValue).Equals(parameterName, StringComparison.OrdinalIgnoreCase))
                return GraphValue(GraphProperty(entry, "DefaultValue")?.Tag?.GenericValue) ?? new[] { 0d, 0d, 0d, 0d };
        return null;
    }
    UObject? GraphLoadFunction(FPackageIndex? functionIndex, string? path)
    {
        try { if (functionIndex?.Load<UObject>() is { } direct) return direct; } catch { }
        if (string.IsNullOrEmpty(path)) return null;
        if (path.StartsWith("/Engine/", StringComparison.OrdinalIgnoreCase)) return GraphLoadEngineFunction(path);
        var slash = path.LastIndexOf('/');
        var functionName = path[(slash + 1)..];
        var dot = functionName.IndexOf('.');
        if (dot >= 0) functionName = functionName[..dot];
        if (functionName.Length == 0) return null;
        if (graphFunctionKeys is null)
        {
            graphFunctionKeys = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var key in provider.Files.Keys.Where(key => key.EndsWith(".uasset", StringComparison.OrdinalIgnoreCase)).OrderBy(key => key, StringComparer.Ordinal))
                graphFunctionKeys.TryAdd(Path.GetFileNameWithoutExtension(key), key);
        }
        if (!graphFunctionKeys.TryGetValue(functionName, out var packageKey)) return null;
        try
        {
            var functionPackage = provider.LoadPackage(packageKey);
            for (var index = 0; index < functionPackage.ExportsLazy.Length; index++)
            {
                if (DumpExportName(functionPackage, index) == functionName) return functionPackage.ExportsLazy[index].Value;
            }
        }
        catch { }
        return null;
    }

    // The one engine package an exact /Engine/<folders>/<name>.<name> reference names, read from the configured content root.
    // Nothing is matched by basename and nothing falls back to another mount: the reference must name exactly that package
    // and object, and the key must exist exactly under the configured root (EngineContent.TryExactReference).
    UObject? GraphLoadEngineFunction(string path)
    {
        if (engineProvider is null || engineContentKeyPrefix is null) return null;
        if (!EngineContent.TryExactReference(engineContentKeyPrefix, path, out var key, out var objectName)) return null;
        if (!engineProvider.Files.ContainsKey(key)) return null;
        try
        {
            var enginePackage = engineProvider.LoadPackage(key);
            for (var index = 0; index < enginePackage.ExportsLazy.Length; index++)
            {
                if (DumpExportName(enginePackage, index) == objectName) return enginePackage.ExportsLazy[index].Value;
            }
        }
        catch { }
        return null;
    }

    // UE4 and 5.0 keep the expression list on the function; 5.1+ moves it to EditorOnlyData.ExpressionCollection.
    // The package exports are the last resort, because the inputs and outputs are exports whatever the layout.
    List<UObject> GraphFunctionExpressions(UObject function)
    {
        var found = new List<UObject>();
        void Collect(object? array)
        {
            if (array is not UScriptArray list) return;
            foreach (var element in list.Properties)
            {
                try { if ((element.GenericValue as FPackageIndex)?.Load<UObject>() is { } candidate) found.Add(candidate); } catch { }
            }
        }
        Collect(GraphProperty(function, "FunctionExpressions")?.Tag?.GenericValue);
        if (found.Count == 0)
        {
            try
            {
                var editorOnly = GraphProperty(function, "EditorOnlyData")?.Tag?.GenericValue is FPackageIndex editorIndex ? editorIndex.Load<UObject>() : null;
                if (editorOnly is not null &&
                    GraphProperty(editorOnly, "ExpressionCollection")?.Tag?.GenericValue is FScriptStruct { StructType: FStructFallback collection })
                    Collect(GraphProperty(collection, "Expressions")?.Tag?.GenericValue);
            }
            catch { }
        }
        if (found.Count == 0 && function.Owner is { } functionOwner)
        {
            for (var index = 0; index < functionOwner.ExportsLazy.Length; index++)
            {
                try
                {
                    var export = functionOwner.ExportsLazy[index].Value;
                    if (export.ExportType is "MaterialExpressionFunctionInput" or "MaterialExpressionFunctionOutput") found.Add(export);
                }
                catch { }
            }
        }
        return found;
    }

    void InlineFunctionCall(UObject call, string callId, Dictionary<string, object?> node, string prefix, Dictionary<string, Dictionary<string, object?>?>? outerInputs, int depth)
    {
        var owner = call.Owner;
        var functionIndex = GraphProperty(call, "MaterialFunction")?.Tag?.GenericValue as FPackageIndex;
        node["function"] = functionIndex is not null && owner is not null ? DumpPath(owner, functionIndex) : null;
        var outerIds = new Dictionary<string, object?>();
        var outputIds = new List<string?>();
        var fn = new Dictionary<string, object?> { ["inputs"] = outerIds, ["outputs"] = outputIds, ["output"] = null };
        node["fn"] = fn;
        var callPins = (Dictionary<string, object?>) node["inputs"]!;
        // The call stores each wired input and only a guid for the function input it feeds.
        var function = GraphLoadFunction(functionIndex, node["function"] as string);
        // A body records the configured engine content it came from only when the engine provider loaded its package. The package
        // that loaded it decides, not the path the call names: a pack may mount its own package under /Engine/.
        var enginePackage = function is null ? null : EngineContent.PackagePath(function.Owner, engineProvider, engineContentKeyPrefix);
        if (enginePackage is not null && engineContentVersion is not null)
            fn["engine"] = new Dictionary<string, object?> { ["version"] = engineContentVersion, ["package"] = enginePackage };
        var inputExpressions = new Dictionary<string, UObject>(StringComparer.Ordinal);
        var outputExpressions = new Dictionary<string, UObject>(StringComparer.Ordinal);
        if (function is not null)
        {
            foreach (var candidate in GraphFunctionExpressions(function))
            {
                var guid = GraphGuid(GraphProperty(candidate, "Id"));
                if (guid is null) continue;
                if (candidate.ExportType == "MaterialExpressionFunctionInput") inputExpressions[guid] = candidate;
                else if (candidate.ExportType == "MaterialExpressionFunctionOutput") outputExpressions[guid] = candidate;
            }
        }
        var pins = new Dictionary<string, Dictionary<string, object?>?>(StringComparer.Ordinal);
        if (GraphProperty(call, "FunctionInputs")?.Tag?.GenericValue is UScriptArray callInputs)
        {
            // A package that records no FCoreObjectVersion stores each nested input as tagged properties; read them from the raw bytes.
            var legacyInputs = GraphRawInputs(owner) ? GraphLegacyFunctionInputs(call) : null;
            if (legacyInputs is not null && legacyInputs.Count != callInputs.Properties.Count) legacyInputs = null;
            var position = 0;
            foreach (var element in callInputs.Properties)
            {
                var slot = position++;
                if (element.GenericValue is not FScriptStruct { StructType: FStructFallback item }) continue;
                var actual = Pin(legacyInputs is not null ? legacyInputs[slot] : GraphProperty(item, "Input")?.Tag?.GenericValue, prefix, outerInputs, depth);
                var guid = GraphGuid(GraphProperty(item, "ExpressionInputId"));
                var inputName = $"Input{slot}";
                if (guid is not null && inputExpressions.TryGetValue(guid, out var inputExpression))
                {
                    pins[inputExpression.GetPathName()] = actual;
                    var named = GraphText(GraphProperty(inputExpression, "InputName")?.Tag?.GenericValue);
                    if (named.Length > 0) inputName = named;
                }
                outerIds[inputName] = actual?["node"];
                callPins[inputName] = actual;
            }
        }
        if (function is null) { node["error"] = "material function could not be loaded (engine content is not in the pack)"; return; }
        if (depth >= GraphFunctionDepthLimit) { node["error"] = "function nesting limit reached"; return; }
        var inner = callId + "/";
        var outputNames = new List<string>();
        if (GraphProperty(call, "FunctionOutputs")?.Tag?.GenericValue is UScriptArray callOutputs)
        {
            foreach (var element in callOutputs.Properties)
            {
                string? innerId = null;
                var outputName = "";
                if (element.GenericValue is FScriptStruct { StructType: FStructFallback item } &&
                    GraphGuid(GraphProperty(item, "ExpressionOutputId")) is { } guid &&
                    outputExpressions.TryGetValue(guid, out var outputExpression))
                {
                    innerId = Pin(GraphInputValue(outputExpression, "A"), inner, pins, depth + 1)?["node"] as string;
                    outputName = GraphText(GraphProperty(outputExpression, "OutputName")?.Tag?.GenericValue);
                }
                outputIds.Add(innerId);
                outputNames.Add(outputName);
            }
        }
        fn["outputNames"] = outputNames;
        fn["output"] = outputIds.FirstOrDefault(item => item is not null);
    }

    var outputs = new Dictionary<string, object?>();
    var outputConstants = new Dictionary<string, object?>();
    var editorOnly = GraphProperty(material, "EditorOnlyData")?.Tag?.GenericValue is FPackageIndex editorIndex ? editorIndex.Load<UObject>() : null;
    foreach (var (outputName, propertyName) in GraphMaterialOutputs)
    {
        try
        {
            var outputProperty = GraphProperty(material, propertyName) ?? (editorOnly is null ? null : GraphProperty(editorOnly, propertyName));
            var value = outputProperty?.Tag?.GenericValue;
            if (outputProperty is not null && outputProperty.PropertyType.Text == "StructProperty" && (outputProperty.Tag is null || GraphRawInputs(material.Owner)))
            {
                var recovered = GraphLegacyInputs(material);
                if (recovered.TryGetValue(propertyName, out var legacyOutput)) value = legacyOutput;
                else outputConstants[outputName + "Error"] = $"property {propertyName} ({outputProperty.PropertyType.Text}) could not be read";
            }
            outputs[outputName] = Pin(value, "", null, 0);
            var (_, _, _, constant, useConstant) = GraphReadInput(value);
            if (useConstant && constant is not null) outputConstants[outputName] = constant;
        }
        catch (Exception error) { outputs[outputName] = null; outputConstants[outputName + "Error"] = error.Message; }
    }
    return new Dictionary<string, object?>
    {
        ["format"] = 1, ["material"] = materialName, ["package"] = DumpGamePath(package.Name), ["truncated"] = truncated,
        ["nodeCount"] = nodes.Count, ["outputs"] = outputs, ["outputConstants"] = outputConstants, ["nodes"] = nodes,
    };
}

static double DumpNum(float value) => float.IsFinite(value) ? value : 0d;
static double[] DumpVec(FVector value) => new[] { DumpNum(value.X), DumpNum(value.Y), DumpNum(value.Z) };
// A loose directory mounts as "<dir>/Content/<path>"; Unreal names that package "/Game/<path>".
static string DumpGamePath(string path)
{
    var normalized = path.Replace('\\', '/');
    var contentAt = normalized.IndexOf("/Content/", StringComparison.OrdinalIgnoreCase);
    return contentAt >= 0 ? "/Game/" + normalized[(contentAt + 9)..] : normalized;
}
static string? DumpPath(IPackage package, FPackageIndex? index)
{
    if (index is null || index.IsNull) return null;
    try { var resolved = package.ResolvePackageIndex(index)?.GetPathName(); return resolved is null ? null : DumpGamePath(resolved); }
    catch { return null; }
}
static string DumpExportClass(IPackage package, int index)
{
    if (package is Package legacy)
    {
        var export = legacy.ExportMap[index];
        if (!string.IsNullOrEmpty(export.ClassName)) return export.ClassName;
        return legacy.ResolvePackageIndex(export.ClassIndex)?.Name.Text ?? "";
    }
    return package.ExportsLazy[index].Value.ExportType;
}
static string DumpExportName(IPackage package, int index) =>
    package is Package legacy ? legacy.ExportMap[index].ObjectName.Text : package.ExportsLazy[index].Value.Name;
static Dictionary<string, object?> DumpSlot(string? name, string? material) =>
    new() { ["name"] = name ?? "", ["material"] = material };
static Dictionary<string, object?>? DumpBounds(UObject mesh, string property)
{
    var bounds = mesh.GetOrDefault<FStructFallback>(property);
    if (bounds is null) return null;
    return new Dictionary<string, object?>
    {
        ["origin"] = DumpVec(bounds.GetOrDefault<FVector>("Origin")),
        ["boxExtent"] = DumpVec(bounds.GetOrDefault<FVector>("BoxExtent")),
        ["sphereRadius"] = DumpNum(bounds.GetOrDefault<float>("SphereRadius")),
        ["property"] = property,
        ["positiveExtension"] = DumpVec(mesh.GetOrDefault<FVector>("PositiveBoundsExtension")),
        ["negativeExtension"] = DumpVec(mesh.GetOrDefault<FVector>("NegativeBoundsExtension")),
    };
}
static List<Dictionary<string, object?>> DumpSlots(UObject mesh, IPackage package)
{
    var slots = new List<Dictionary<string, object?>>();
    if (mesh is UStaticMesh staticMesh)
        foreach (var slot in staticMesh.StaticMaterials ?? Array.Empty<FStaticMaterial>())
            slots.Add(DumpSlot(slot.MaterialSlotName.Text, DumpPath(package, slot.MaterialInterface)));
    else if (mesh is USkeletalMesh skeletalMesh)
        foreach (var slot in skeletalMesh.SkeletalMaterials ?? Array.Empty<FSkeletalMaterial>())
            slots.Add(DumpSlot(slot.MaterialSlotName.Text, DumpPath(package, slot.Material)));
    if (slots.Count == 0)
    {
        foreach (var property in new[] { "StaticMaterials", "SkeletalMaterials" })
            foreach (var slot in mesh.GetOrDefault<FStructFallback[]>(property) ?? Array.Empty<FStructFallback>())
                slots.Add(DumpSlot(slot.GetOrDefault<FName>("MaterialSlotName").Text,
                    DumpPath(package, slot.GetOrDefault<FPackageIndex>("MaterialInterface") ?? slot.GetOrDefault<FPackageIndex>("Material"))));
    }
    if (slots.Count == 0)
        foreach (var material in mesh.GetOrDefault<FPackageIndex[]>("Materials") ?? Array.Empty<FPackageIndex>())
            slots.Add(DumpSlot("", DumpPath(package, material)));
    return slots;
}
// The name a material's Materials/<name>.mat and .props.txt are written under. One run can export two
// packages with one object name: a MetaHuman instance (Kellan/Face/MI_X) whose parent is a same-named
// instance in Common/ (Common/Face/MI_X). The first package to claim a name keeps it; a later package of
// that name, told apart by its package path, gets "<name>__2" (then __3, ...), so it can no longer
// overwrite the instance's own overrides, and the child's Parent line names the suffixed sidecar. A
// package without a known path never counts as different.
static string MaterialSidecarName(Dictionary<string, string> owners, string name, string? packagePath)
{
    var identity = packagePath ?? "";
    var candidate = name;
    for (var suffix = 2; ; suffix++)
    {
        if (!owners.TryGetValue(candidate, out var owner))
        {
            owners[candidate] = identity;
            return candidate;
        }
        if (owner.Length == 0 || identity.Length == 0 || owner.Equals(identity, StringComparison.OrdinalIgnoreCase))
        {
            // The spelling first claimed, so one package always lands on one file.
            var claimed = owners.Keys.First(key => key.Equals(candidate, StringComparison.OrdinalIgnoreCase));
            if (owner.Length == 0 && identity.Length > 0) owners[claimed] = identity;
            return claimed;
        }
        candidate = name + "__" + suffix;
    }
}
// A MaterialInstanceConstant's TextureParameterValues. CUE4Parse fills the typed array only after
// UMaterialInstance.Deserialize returns; on a UE4 package inside a UE5 artifact (UE 4.25 materials
// beside UE 5.1 meshes) it throws on the UE5-only cached-data flag first, so the typed array stays
// empty although the tagged properties were already read. Those are the same values.
static FTextureParameterValue[] InstanceTextureParameters(UMaterialInstanceConstant instance)
    => instance.TextureParameterValues.Length > 0
        ? instance.TextureParameterValues
        : (instance.GetOrDefault<FStructFallback[]>("TextureParameterValues") ?? Array.Empty<FStructFallback>())
            .Select(fallback => new FTextureParameterValue(fallback)).ToArray();
static List<Dictionary<string, object?>> DumpTextureParameters(UObject instance, IPackage package)
{
    var parameters = new List<Dictionary<string, object?>>();
    foreach (var parameter in instance.GetOrDefault<FStructFallback[]>("TextureParameterValues") ?? Array.Empty<FStructFallback>())
    {
        var info = parameter.GetOrDefault<FStructFallback>("ParameterInfo");
        var name = info is not null ? info.GetOrDefault<FName>("Name").Text : parameter.GetOrDefault<FName>("ParameterName").Text;
        parameters.Add(new Dictionary<string, object?> { ["name"] = name ?? "", ["texture"] = DumpPath(package, parameter.GetOrDefault<FPackageIndex>("ParameterValue")) });
    }
    return parameters;
}
static List<Dictionary<string, object?>> DumpVectorParameters(UObject instance)
{
    var parameters = new List<Dictionary<string, object?>>();
    foreach (var parameter in instance.GetOrDefault<FStructFallback[]>("VectorParameterValues") ?? Array.Empty<FStructFallback>())
    {
        var info = parameter.GetOrDefault<FStructFallback>("ParameterInfo");
        var name = info is not null ? info.GetOrDefault<FName>("Name").Text : parameter.GetOrDefault<FName>("ParameterName").Text;
        var value = parameter.GetOrDefault<FLinearColor>("ParameterValue");
        parameters.Add(new Dictionary<string, object?> { ["name"] = name ?? "", ["value"] = new[] { DumpNum(value.R), DumpNum(value.G), DumpNum(value.B), DumpNum(value.A) } });
    }
    return parameters;
}
static List<Dictionary<string, object?>> DumpScalarParameters(UObject instance)
{
    var parameters = new List<Dictionary<string, object?>>();
    foreach (var parameter in instance.GetOrDefault<FStructFallback[]>("ScalarParameterValues") ?? Array.Empty<FStructFallback>())
    {
        var info = parameter.GetOrDefault<FStructFallback>("ParameterInfo");
        var name = info is not null ? info.GetOrDefault<FName>("Name").Text : parameter.GetOrDefault<FName>("ParameterName").Text;
        parameters.Add(new Dictionary<string, object?> { ["name"] = name ?? "", ["value"] = DumpNum(parameter.GetOrDefault<float>("ParameterValue")) });
    }
    return parameters;
}

Dictionary<string, object?> DumpPackage(string key)
{
    var entry = new Dictionary<string, object?> { ["path"] = key };
    IPackage package;
    try { package = provider.LoadPackage(key); }
    catch (Exception error) { entry["error"] = error.Message; return entry; }
    entry["path"] = DumpGamePath(package.Name);
    var importedTextures = new List<string>();
    if (package is Package legacyPackage)
    {
        for (var index = 0; index < legacyPackage.ImportMap.Length; index++)
        {
            var className = legacyPackage.ImportMap[index].ClassName.Text;
            if (!className.StartsWith("Texture", StringComparison.OrdinalIgnoreCase)) continue;
            var path = DumpPath(package, new FPackageIndex(package, -(index + 1)));
            if (path is not null && !importedTextures.Contains(path, StringComparer.OrdinalIgnoreCase)) importedTextures.Add(path);
        }
    }
    entry["importedTextures"] = importedTextures;
    var exportsJson = new List<Dictionary<string, object?>>();
    entry["exports"] = exportsJson;
    // Material graph facts come from the expression exports and are attached to the owning Material below.
    var graphTextureParameters = new List<Dictionary<string, object?>>();
    var graphTextures = new List<string>();
    var graphVectorParameters = new List<Dictionary<string, object?>>();
    var graphFunctions = new List<string>();
    var graphConstants = 0;
    var graphOwners = new List<Dictionary<string, object?>>();
    for (var index = 0; index < package.ExportsLazy.Length; index++)
    {
        string className, exportName;
        try { className = DumpExportClass(package, index); exportName = DumpExportName(package, index); }
        catch (Exception error) { exportsJson.Add(new Dictionary<string, object?> { ["name"] = $"#{index}", ["class"] = "", ["error"] = error.Message }); continue; }
        var isMesh = className is "StaticMesh" or "SkeletalMesh";
        var isMaterialExpression = className.StartsWith("MaterialExpression", StringComparison.Ordinal);
        var isMaterial = className.StartsWith("Material", StringComparison.Ordinal) && !isMaterialExpression;
        // An HLODProxy marks the package as a level's generated LOD stand-ins: recorded by class only.
        if (className == "HLODProxy") { exportsJson.Add(new Dictionary<string, object?> { ["name"] = exportName, ["class"] = className }); continue; }
        if (!isMesh && !isMaterialExpression && !isMaterial) continue;
        var item = new Dictionary<string, object?> { ["name"] = exportName, ["class"] = className };
        try
        {
            var export = package.ExportsLazy[index].Value;
            if (isMesh)
            {
                var slots = DumpSlots(export, package);
                item["slots"] = slots;
                var bounds = DumpBounds(export, "ExtendedBounds") ?? DumpBounds(export, "ImportedBounds");
                if (bounds is null && export is UStaticMesh renderMesh && renderMesh.RenderData?.Bounds is { } renderBounds)
                    bounds = new Dictionary<string, object?>
                    {
                        ["origin"] = DumpVec(renderBounds.Origin), ["boxExtent"] = DumpVec(renderBounds.BoxExtent),
                        ["sphereRadius"] = DumpNum(renderBounds.SphereRadius), ["property"] = "RenderData.Bounds",
                        ["positiveExtension"] = DumpVec(export.GetOrDefault<FVector>("PositiveBoundsExtension")),
                        ["negativeExtension"] = DumpVec(export.GetOrDefault<FVector>("NegativeBoundsExtension")),
                    };
                item["bounds"] = bounds;
                if (slots.Count == 0) item["error"] = "no material slots could be read (typed mesh load may have failed)";
            }
            else if (isMaterialExpression)
            {
                if (className.Contains("TextureSample", StringComparison.Ordinal) || className.Contains("TextureObject", StringComparison.Ordinal))
                {
                    var texture = DumpPath(package, export.GetOrDefault<FPackageIndex>("Texture"));
                    if (texture is not null)
                    {
                        if (!graphTextures.Contains(texture, StringComparer.OrdinalIgnoreCase)) graphTextures.Add(texture);
                        if (className.Contains("Parameter", StringComparison.Ordinal))
                            graphTextureParameters.Add(new Dictionary<string, object?> { ["name"] = export.GetOrDefault<FName>("ParameterName").Text ?? "", ["texture"] = texture });
                    }
                }
                else if (className == "MaterialExpressionVectorParameter")
                {
                    var value = export.GetOrDefault<FLinearColor>("DefaultValue");
                    graphVectorParameters.Add(new Dictionary<string, object?> { ["name"] = export.GetOrDefault<FName>("ParameterName").Text ?? "", ["value"] = new[] { DumpNum(value.R), DumpNum(value.G), DumpNum(value.B), DumpNum(value.A) } });
                }
                else if (className == "MaterialExpressionMaterialFunctionCall")
                {
                    var function = DumpPath(package, export.GetOrDefault<FPackageIndex>("MaterialFunction"));
                    if (function is not null && !graphFunctions.Contains(function, StringComparer.OrdinalIgnoreCase)) graphFunctions.Add(function);
                }
                else if (className is "MaterialExpressionConstant3Vector" or "MaterialExpressionConstant4Vector") graphConstants++;
                continue;
            }
            else
            {
                if (className == "Material" || className.StartsWith("MaterialFunction", StringComparison.Ordinal))
                {
                    item["textureParameters"] = graphTextureParameters;
                    item["textures"] = graphTextures;
                    item["functions"] = graphFunctions;
                    item["vectorParameters"] = graphVectorParameters;
                    item["constantColors"] = 0;
                    graphOwners.Add(item);
                }
                else
                {
                    item["parent"] = DumpPath(package, export.GetOrDefault<FPackageIndex>("Parent"));
                    item["textureParameters"] = DumpTextureParameters(export, package);
                    item["vectorParameters"] = DumpVectorParameters(export);
                    item["scalarParameters"] = DumpScalarParameters(export);
                }
            }
        }
        catch (Exception error) { item["error"] = error.Message; }
        exportsJson.Add(item);
    }
    foreach (var owner in graphOwners) owner["constantColors"] = graphConstants;
    return entry;
}
var exported = 0;
var mappingRequired = false;
Exception? lastLoadError = null;
var textureFailures = new List<string>();
var selectedExportTypes = new HashSet<string>(StringComparer.Ordinal);
var exportedMaterials = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
// Refused materials by qualified identity. Bounded: the first 64 are kept, and later refusals are counted. Either fails the conversion.
var materialFailures = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
var materialFailuresDropped = 0;
// Materials/<name>.mat and .props.txt per sidecar name -> the package that owns it (see MaterialSidecarName).
var materialSidecarOwners = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
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
        var spriteTexture = LoadAssetByName<UTexture>(textureName);
        var sourcePng = ExtractSourcePng(packageBytes, spriteTexture);
        if (sourcePng is null) return false;
        await File.WriteAllBytesAsync(textureTarget, NormalizeSourcePng(sourcePng, spriteTexture));
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

// /Game/A/MI_X.MI_X (or a provider key Pack/Content/A/MI_X.uasset) -> /Game/A/MI_X.
static string GamePackagePath(string path)
{
    var game = DumpGamePath(path);
    foreach (var suffix in new[] { ".uasset", ".umap" })
        if (game.EndsWith(suffix, StringComparison.OrdinalIgnoreCase)) return game[..^suffix.Length];
    var slash = game.LastIndexOf('/');
    var dot = game.IndexOf('.', slash + 1);
    return dot >= 0 ? game[..dot] : game;
}
// Two packages can share a material's object name (MI_Wanted2 beside two posters). The package path, when the
// referrer names it, picks the right one; the first by name is only the fallback.
string? MaterialKey(string materialName, string? packagePath)
{
    var byName = provider.Files.Keys.Where(candidate => Path.GetFileNameWithoutExtension(candidate).Equals(materialName, StringComparison.OrdinalIgnoreCase)).ToList();
    if (packagePath is not null)
    {
        var exact = byName.FirstOrDefault(candidate => GamePackagePath(candidate).Equals(packagePath, StringComparison.OrdinalIgnoreCase));
        if (exact is not null) return exact;
    }
    return byName.FirstOrDefault();
}
static string? ResolvedPackagePath(ResolvedObject? resolved)
{
    try { var path = resolved?.GetPathName(); return string.IsNullOrEmpty(path) ? null : GamePackagePath(path); }
    catch { return null; }
}
static string? IndexPackagePath(FPackageIndex? index)
{
    if (index is null || index.IsNull) return null;
    try { return ResolvedPackagePath(index.ResolvedObject); } catch { return null; }
}
// Meshes/<mesh>.materials.json: slot material object name -> package path, so the importer can tell same-named
// materials apart. A name two slots take from different packages is left out.
async Task WriteMeshMaterialPackagesAsync(string meshName, IEnumerable<FPackageIndex?> materials)
{
    var packages = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
    foreach (var material in materials)
    {
        if (material is null || material.IsNull || string.IsNullOrWhiteSpace(material.Name)) continue;
        var path = IndexPackagePath(material);
        if (path is null) continue;
        packages[material.Name] = packages.TryGetValue(material.Name, out var known) && (known is null || !known.Equals(path, StringComparison.OrdinalIgnoreCase)) ? null : path;
    }
    var known2 = packages.Where(entry => entry.Value is not null).ToDictionary(entry => entry.Key, entry => entry.Value!);
    if (known2.Count == 0) return;
    await File.WriteAllTextAsync(Path.Combine(output, "Meshes", meshName + ".materials.json"), JsonConvert.SerializeObject(known2));
}

// A refused material is recorded by its identity and fails the conversion at completion. The reason is flattened and bounded like
// a mesh failure, so a long CUE4Parse message cannot grow the report.
void RecordMaterialFailure(string identity, string reason)
{
    if (!materialFailures.ContainsKey(identity) && materialFailures.Count >= 64)
    {
        materialFailuresDropped++;
        return;
    }
    var flat = string.Join(' ', reason.Split(new[] { '\r', '\n', '\t' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
    materialFailures[identity] = flat.Length <= 500 ? flat : flat[..500];
}

async Task ExportMaterialAsync(string initialName, string? initialPath = null)
{
    var pending = new Queue<(string Name, string? Path)>();
    pending.Enqueue((initialName, initialPath));
    while (pending.TryDequeue(out var next))
    {
        var materialName = next.Name;
        if (!exportedMaterials.Add(next.Path ?? materialName)) continue;
        var sidecarName = MaterialSidecarName(materialSidecarOwners, materialName, next.Path);
        var materialKey = MaterialKey(materialName, next.Path);
        if (materialKey is null) continue;
        // A parent whose own package is not in the pack falls back to the first package of its name. When that is one
        // this run already wrote (the instance itself, for a same-named parent), writing it again under the parent's
        // sidecar name would only make the instance its own parent: the parent stays absent instead.
        if (next.Path is not null && !GamePackagePath(materialKey).Equals(next.Path, StringComparison.OrdinalIgnoreCase) &&
            exportedMaterials.Contains(GamePackagePath(materialKey))) continue;
        IPackage package;
        try { package = provider.LoadPackage(materialKey); } catch { continue; }
        var exports = package.GetExports().ToArray();
        var material = exports.OfType<UMaterialInterface>().FirstOrDefault(candidate => candidate.Name.Equals(materialName, StringComparison.OrdinalIgnoreCase));
        if (material is null) continue;

        var references = new List<(string Parameter, string Texture)>();
        if (material is UMaterialInstanceConstant instance)
        {
            foreach (var parameter in InstanceTextureParameters(instance))
                if (!parameter.ParameterValue.IsNull && parameter.ParameterValue.Name != "None")
                    references.Add((parameter.Name, parameter.ParameterValue.Name));
            // An editor-saved UE5.3 instance leaves the typed array empty while its tagged TextureParameterValues
            // hold every override (the property dump reads them this way), so the instance bound its parent's
            // defaults (T_Default_N) instead of its own textures. Read the tagged structs as well.
            foreach (var parameter in instance.GetOrDefault<FStructFallback[]>("TextureParameterValues") ?? Array.Empty<FStructFallback>())
            {
                var info = parameter.GetOrDefault<FStructFallback>("ParameterInfo");
                var parameterName = info is not null ? info.GetOrDefault<FName>("Name").Text : parameter.GetOrDefault<FName>("ParameterName").Text;
                var value = parameter.GetOrDefault<FPackageIndex>("ParameterValue");
                if (string.IsNullOrEmpty(parameterName) || parameterName == "None" || value is null || value.IsNull || value.Name == "None") continue;
                references.Add((parameterName, value.Name));
            }
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
        var parentSidecar = "";
        string? parentPath = null;
        if (material.TryGetValue<FPackageIndex>(out var parent, "Parent") && !parent.IsNull && parent.Name != "None")
        {
            parentName = parent.Name;
            try { parentPath = ResolvedPackagePath(package.ResolvePackageIndex(parent)); } catch { parentPath = null; }
            pending.Enqueue((parentName, parentPath));
            // Claimed now, so this instance's Parent line names the sidecar the parent is written under.
            parentSidecar = MaterialSidecarName(materialSidecarOwners, parentName, parentPath);
        }

        references = references.Distinct().ToList();
        var materialDirectory = Path.Combine(output, "Materials");
        Directory.CreateDirectory(materialDirectory);
        var mat = string.Join("\n", references.Select((entry, index) => $"Other[{index}]={entry.Texture}")) + "\n";
        var props = new StringBuilder();
        // The parent's package path lets the importer pick between same-named parents.
        if (parentName.Length > 0) props.AppendLine($"Parent = Material'{(parentPath is null ? parentName : parentPath)}.{parentSidecar}'");
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
        // The overrides are read before either sidecar is written. A refused material writes neither, but it is recorded by its
        // identity, so the conversion fails at completion. Its textures are still extracted below, as the rest of the output is.
        var identity = $"{GamePackagePath(materialKey)}.{material.Name}";
        string? refusal = null;
        if (material is UMaterialInstance overridden)
        {
            try { props.Append(MaterialOverrides.Blocks(overridden, material.Name, packageReadFailures)); }
            catch (MaterialOverrides.Refusal error) { refusal = error.Message; }
        }
        if (refusal is null)
        {
            await File.WriteAllTextAsync(Path.Combine(materialDirectory, sidecarName + ".mat"), mat);
            await File.WriteAllTextAsync(Path.Combine(materialDirectory, sidecarName + ".props.txt"), props.ToString());
        }
        else
        {
            Console.Error.WriteLine($"material overrides refused {material.Name}: {refusal}");
            RecordMaterialFailure(identity, refusal);
        }

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
            var sourceTexture = LoadAssetByName<UTexture>(textureName);
            var sourcePng = ExtractSourcePng(textureBytes, sourceTexture);
            if (sourcePng is not null) await File.WriteAllBytesAsync(target, NormalizeSourcePng(sourcePng, sourceTexture));
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
            meshFailures[mesh.Name] = assetLookupDiagnostics.GetValueOrDefault(mesh.Name, "the uncooked static mesh could not be decoded");
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
            RecordMeshFailure(mesh.Name, "static mesh", results);
            return false;
        }
        if (!Path.GetFullPath(emitted).Equals(Path.GetFullPath(target), StringComparison.OrdinalIgnoreCase)) File.Move(emitted, target, true);
    }
    meshFailures.Remove(mesh.Name);
    await WriteMeshMaterialPackagesAsync(mesh.Name, staticMaterials.Select(slot => slot.MaterialInterface));
    foreach (var slot in staticMaterials.Where(slot => !string.IsNullOrWhiteSpace(slot.MaterialInterface?.Name)))
        await ExportMaterialAsync(slot.MaterialInterface!.Name, IndexPackagePath(slot.MaterialInterface));
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
    // The triangle count LOD0's source model cached when the mesh was saved: the cross-check that lets
    // a payload with a stale tail through (see ReadMeshDescription).
    var cachedTriangles = (int)((mesh.GetOrDefault<FStructFallback[]>("SourceModels") ?? Array.Empty<FStructFallback>())
        .FirstOrDefault()?.GetOrDefault<uint>("CacheMeshDescriptionTrianglesCount") ?? 0);
    var editorMesh = ReadLargestMeshDescription(file.Read(), out var refusal, cachedTriangles);
    if (editorMesh is null)
    {
        assetLookupDiagnostics[mesh.Name] = "uncooked mesh has no readable FMeshDescription source model" + (refusal is null ? "" : $" ({refusal})");
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

void RecordMeshFailure(string name, string kind, IEnumerable<ExportResult> results)
{
    var parts = new List<string>();
    if (packageReadFailures.TryGetValue(name, out var readFailure))
        parts.Add($"the {kind} package could not be deserialized ({readFailure}{(olderEngineAttempts is null ? "" : "; it also failed under the " + olderEngineAttempts + " profiles")})");
    var error = results.Select(result => result.Error).FirstOrDefault(candidate => candidate is not null);
    if (error is not null) parts.Add($"the exporter failed ({error.GetType().Name}: {error.Message})");
    if (parts.Count == 0) parts.Add($"the exporter wrote no glTF for this {kind}");
    var flat = string.Join(' ', string.Join("; ", parts).Split(new[] { '\r', '\n', '\t' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
    meshFailures[name] = flat.Length <= 500 ? flat : flat[..500];
}

// A package that predates the run's engine profile (a UE4 or early UE5 package read as UE5.3) lists
// fewer custom versions, so CUE4Parse fills the gaps from the profile and reads the file in a later layout (a wider soft-vertex, for
// one). The package then yields a SkeletalMesh with no LODs. Re-reading it under an older UE4
// profile is the only decoder that can tell, and costs nothing for a mesh that already loaded.
var olderEngineProviders = new Dictionary<EGame, DefaultFileProvider>();
USkeletalMesh? ReloadSkeletalMeshWithOlderEngine(string packageKey, string meshName)
{
    if (game < EGame.GAME_UE4_0) return null;
    foreach (var older in new[] { EGame.GAME_UE4_27, EGame.GAME_UE4_24, EGame.GAME_UE4_22, EGame.GAME_UE4_20 })
    {
        if (older >= game) continue;
        try
        {
            if (!olderEngineProviders.TryGetValue(older, out var olderProvider))
            {
                olderProvider = new DefaultFileProvider(root, SearchOption.AllDirectories, new VersionContainer(older), StringComparer.OrdinalIgnoreCase);
                if (mappings.Length == 1) olderProvider.MappingsContainer = new FileUsmapTypeMappingsProvider(mappings[0]);
                olderProvider.Initialize();
                olderProvider.PostMount();
                olderEngineProviders[older] = olderProvider;
            }
            var candidate = olderProvider.LoadPackage(packageKey).GetExports().OfType<USkeletalMesh>().FirstOrDefault(item => item.Name == meshName);
            if (candidate?.LODModels is { Length: > 0 })
            {
                packageReadFailures.Remove(meshName);
                return candidate;
            }
        }
        catch (Exception) { }
    }
    olderEngineAttempts = "UE 4.27, 4.24, 4.22 and 4.20";
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
        RecordMeshFailure(mesh.Name, "skeletal mesh", results);
        return false;
    }
    meshFailures.Remove(mesh.Name);
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
    await WriteMeshMaterialPackagesAsync(mesh.Name, mesh.SkeletalMaterials.Select(slot => slot.Material));
    foreach (var slot in mesh.SkeletalMaterials.Where(slot => !string.IsNullOrWhiteSpace(slot.Material?.Name)))
        await ExportMaterialAsync(slot.Material!.Name, IndexPackagePath(slot.Material));
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
        var readable = mesh.LODModels is { Length: > 0 } ? mesh : ReloadSkeletalMeshWithOlderEngine(key, mesh.Name) ?? mesh;
        if (await ExportSkeletalMeshAsync(readable)) exported++;
    }
    foreach (var mesh in package.GetExports().OfType<UStaticMesh>())
    {
        if (await ExportStaticMeshAsync(mesh)) exported++;
    }
    // A hair description only exists in an editor package, and no export class reads it, so it is
    // recognised by the class name the package was authored as.
    foreach (var asset in package.GetExports().Where(asset => asset.ExportType.Equals("GroomAsset", StringComparison.OrdinalIgnoreCase)))
        if (provider.Files.TryGetValue(key, out var groomFile) && groomFile.Size <= 2_000_000_000L &&
            ExportGroomPayloads(groomFile.Read(), asset.Name) > 0) exported++;
    foreach (var material in package.GetExports().OfType<UMaterialInterface>())
    {
        await ExportMaterialAsync(material.Name, GamePackagePath(key));
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
                var sourcePng = ExtractSourcePng(packageBytes, texture);
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
    // Data-texture mode exports only this package's own Texture2D as raw RGBA16F. The PNG exporters below never see it: they
    // cannot encode the format, so the importer asks for this path after their failure instead.
    if (dataTextureKey is not null)
    {
        ExportRgba16fDataTexture(package, provider, dataTexturePackage!, output, dataTextureSelector!);
        exported++;
        continue;
    }
    foreach (var texture in package.GetExports().OfType<UTexture2D>().Where(candidate => exactObject is null || candidate.Name == exactObject))
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
            // An export is named for the object (Texture2D_0 inside a material package), not for
            // the file, so the package's own key resolves it before the export name does.
            var packageFiles = Directory.EnumerateFiles(root, Path.GetFileNameWithoutExtension(key) + ".uasset", SearchOption.AllDirectories)
                .Where(candidate => normalizedKey.EndsWith(Path.GetRelativePath(root, candidate).Replace('\\', '/'), StringComparison.OrdinalIgnoreCase))
                .ToArray();
            // Exact mode keeps only the file EngineContent.Root registered for this key, spelled as the reference spells it,
            // at the path it registered: a case-folded namesake can neither be selected nor take its place.
            if (exactFile is not null) packageFiles = new[] { exactFile };
            var candidates = exactFile is not null ? Array.Empty<string>() : Directory.EnumerateFiles(root, texture.Name + ".uasset", SearchOption.AllDirectories).ToArray();
            var textureFile = packageFiles.FirstOrDefault()
                ?? candidates.FirstOrDefault(candidate =>
                    normalizedKey.EndsWith(Path.GetRelativePath(root, candidate).Replace('\\', '/'), StringComparison.OrdinalIgnoreCase))
                ?? (candidates.Length == 1 ? candidates[0] : null);
            if (textureFile is null || new FileInfo(textureFile).Length > 1_073_741_824)
            {
                textureFailures.Add(ReportTextureFailure(texture, results, textureFile is null ? "texture package file not found on disk" : "texture package exceeds 1 GiB", []));
                continue;
            }
            var packageBytes = await File.ReadAllBytesAsync(textureFile);
            var payloadFailures = new List<string>();
            var sourcePng = ExtractSourcePng(packageBytes, texture, payloadFailures);
            if (sourcePng is null)
            {
                textureFailures.Add(ReportTextureFailure(texture, results, "no decodable pixel data", payloadFailures));
                continue;
            }
            await File.WriteAllBytesAsync(target, NormalizeSourcePng(sourcePng, texture));
        }
        // Exact mode writes the texture's own sRGB flag beside its PNG, so the bake decodes it as Unreal does: never a namesake's, never a guess.
        if (exactObject is not null) await File.WriteAllTextAsync(Path.Combine(output, "Textures", texture.Name + ".props.txt"), $"SRGB={texture.SRGB}\n");
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
                    var sourcePng = ExtractSourcePng(await File.ReadAllBytesAsync(sourceFile), sheet);
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
    // PRD-582: sockets, static-mesh simple collision and the PhysicsAsset reference for this package, plus every
    // SoundCue graph. The importer reads Gameplay/*.json and Audio/*.cue.json and turns them into glTF nodes,
    // extras and metre-scale sidecars.
    var skeletalSockets = new List<object>();
    var staticSockets = new List<object>();
    object? collision = null;
    string? physicsAssetRef = null;
    foreach (var mesh in package.GetExports().OfType<USkeletalMesh>())
    {
        foreach (var socketIndex in mesh.Sockets)
            if (socketIndex?.Load<USkeletalMeshSocket>() is { } socket) skeletalSockets.Add(GpSocket(socket, "mesh"));
        if (mesh.Skeleton?.Load<USkeleton>() is { } skeleton)
            foreach (var socketIndex in skeleton.Sockets)
                if (socketIndex?.Load<USkeletalMeshSocket>() is { } socket) skeletalSockets.Add(GpSocket(socket, "skeleton"));
        if (mesh.PhysicsAsset is { IsNull: false } physicsIndex) physicsAssetRef = physicsIndex.Load<UPhysicsAsset>()?.Name ?? physicsIndex.Name;
    }
    foreach (var mesh in package.GetExports().OfType<UStaticMesh>())
    {
        foreach (var socketIndex in mesh.Sockets ?? Array.Empty<FPackageIndex>())
            if (socketIndex?.Load<UStaticMeshSocket>() is { } socket) staticSockets.Add(GpStaticSocket(socket));
        if (mesh.BodySetup?.Load<UBodySetup>() is { } setup) collision = GpCollision(setup);
    }
    var physics = package.GetExports().OfType<UPhysicsAsset>().Select(GpPhysics).FirstOrDefault();
    if (skeletalSockets.Count > 0 || staticSockets.Count > 0 || collision is not null || physicsAssetRef is not null || physics is not null)
    {
        var gameplay = new Dictionary<string, object?> { ["version"] = 1, ["package"] = GameplaySelector(key) };
        if (skeletalSockets.Count > 0) gameplay["skeletalSockets"] = skeletalSockets;
        if (staticSockets.Count > 0) gameplay["staticSockets"] = staticSockets;
        if (collision is not null) gameplay["collision"] = collision;
        if (physicsAssetRef is not null) gameplay["physicsAssetRef"] = physicsAssetRef;
        if (physics is not null) gameplay["physics"] = physics;
        var gameplayTarget = Path.Combine(output, "Gameplay", GameplaySelector(key) + ".json");
        Directory.CreateDirectory(Path.GetDirectoryName(gameplayTarget)!);
        await File.WriteAllTextAsync(gameplayTarget, JsonConvert.SerializeObject(gameplay, Formatting.Indented));
        exported++;
    }
    foreach (var cue in package.GetExports().OfType<USoundCue>())
    {
        await File.WriteAllTextAsync(Path.Combine(output, "Audio", cue.Name + ".cue.json"), JsonConvert.SerializeObject(GpCue(cue), Formatting.Indented));
        exported++;
    }
}
foreach (var (failedMesh, failureDetail) in meshFailures)
    Console.Error.WriteLine($"threenative-mesh-failure\t{failedMesh}\t{failureDetail}");
if (exported == 0 && mappingRequired) throw new InvalidDataException("This cooked UE5 package uses unversioned properties. Place its game-compatible .usmap mapping file in the imported directory.");
if (exported == 0 && lastLoadError is not null) throw new InvalidDataException("CUE4Parse could not decode the selected Unreal package.", lastLoadError);
if (exported == 0) throw new InvalidDataException($"No StaticMesh, SkeletalMesh, Texture2D, TextureCube, SoundWave, or structured-data output was produced. Loaded export types: {string.Join(", ", selectedExportTypes)}." + (textureFailures.Count > 0 ? "\n" + string.Join("\n", textureFailures) : ""));

// A refused material fails the conversion even when a mesh or texture in the same package exported: the output is incomplete, and a
// successful sibling cannot publish it as whole.
if (materialFailures.Count > 0) throw new InvalidDataException(
    $"{materialFailures.Count + materialFailuresDropped} material(s) could not be imported with their overrides, so the conversion is incomplete:\n" +
    string.Join("\n", materialFailures.Select(entry => $"{entry.Key}: {entry.Value}")) +
    (materialFailuresDropped > 0 ? $"\n... and {materialFailuresDropped} more" : ""));

// Raw RGBA16F source art (TSF_RGBA16F). Unreal stores these samples unfiltered: UE 4.19 Texture.cpp copies the mip without PNG
// encoding (CanPNGCompress excludes the format), 8 bytes per pixel. The producer keeps those bytes exactly, so nothing is clamped,
// resized or re-encoded, and a source outside that layout is refused rather than converted. The two records are declared last.
// The CUE4Parse read: the typed Source struct and the SourceArt bulk (the FEditorBulkData payload of a UE 5.1+ package), with enum names
// stripped of their type prefix.
static Rgba16fSourceArt ReadRgba16fSourceArt(UTexture2D texture)
{
    var source = texture.GetOrDefault<FStructFallback?>("Source", null) ?? throw new InvalidDataException("the texture has no typed Source struct");
    static string EnumName(FStructFallback properties, string name)
    {
        var text = properties.GetOrDefault<FName>(name).Text ?? "";
        return text[(text.LastIndexOf(':') + 1)..];
    }
    // CompressionFormat is missing from a UE 4.19 Source, which predates the field, and the default there is uncompressed. Presence
    // is checked first: a missing field is null, while a present one must read as an enum name, so a field of another type is refused
    // instead of being taken for the default.
    static string? CompressionName(FStructFallback properties)
    {
        if (!properties.Properties.Any(tag => string.Equals(tag.Name.Text, "CompressionFormat", StringComparison.OrdinalIgnoreCase))) return null;
        var text = properties.TryGetValue<FName>(out var format, "CompressionFormat") ? format.Text ?? "" : "";
        if (text.Length == 0) throw new InvalidDataException("the source CompressionFormat is present but not an enum name");
        return text[(text.LastIndexOf(':') + 1)..];
    }
    // A UE 5.1+ package keeps the source in FEditorBulkData, not SourceArt. With TSCF_None its Oodle-decoded payload is the mip data itself, mip 0
    // at offset 0 (UE 5.8.3 Texture.cpp FTextureSource::Decompress, CalcMipOffset), so the validation below applies to it unchanged. The recorded
    // size must equal the size in the buffer header before anything is decoded.
    static (long, byte[]?) EditorSource(FEditorBulkData editor)
    {
        var header = editor.Payload.Header;
        if (editor.PayloadSize is < 1 or > (1L << 30) || (ulong) editor.PayloadSize != header.TotalRawSize)
            throw new InvalidDataException($"the editor payload holds {header.TotalRawSize} bytes but its bulk data records {editor.PayloadSize} (1 byte to 1 GiB is read)");
        return (editor.PayloadSize, DecompressEditorPayload(editor.Payload));
    }
    var (elementCount, bytes) = texture.SourceArt is { } bulk ? ((long) bulk.Header.ElementCount, bulk.ReadDataOnce())
        : texture.EditorData is { } editor ? EditorSource(editor)
        : throw new InvalidDataException("the texture has no SourceArt bulk data");
    return new Rgba16fSourceArt(
        EnumName(source, "Format"),
        source.GetOrDefault<int>("SizeX"),
        source.GetOrDefault<int>("SizeY"),
        source.GetOrDefault<int>("NumSlices"),
        source.GetOrDefault<int>("NumMips"),
        source.GetOrDefault<bool>("bPNGCompressed", false),
        CompressionName(source),
        texture.SRGB,
        elementCount,
        bytes);
}
// The rules the raw layout must meet. Every refusal names the rule, and nothing is written before all of them pass.
static Rgba16fDataTexture ValidateRgba16fSourceArt(Rgba16fSourceArt source)
{
    if (source.Format != "TSF_RGBA16F") throw new InvalidDataException($"source format {source.Format} is not TSF_RGBA16F");
    if (source.PngCompressed) throw new InvalidDataException("the source is PNG-compressed; Unreal never compresses RGBA16F, so the raw layout does not apply");
    if (source.Compression is not (null or "TSCF_None")) throw new InvalidDataException($"the source uses compression {source.Compression}; only uncompressed raw SourceArt is exported");
    if (source.Srgb) throw new InvalidDataException("the texture is sRGB; its raw RGBA16F values are linear and must not be decoded");
    if (source.NumMips != 1) throw new InvalidDataException($"the source holds {source.NumMips} mips; exactly one mip is supported");
    if (source.NumSlices != 1) throw new InvalidDataException($"the source holds {source.NumSlices} slices; exactly one slice is supported");
    if (source.SizeX is < 1 or > 65536 || source.SizeY is < 1 or > 65536)
        throw new InvalidDataException($"source dimensions {source.SizeX}x{source.SizeY} are outside 1 to 65536");
    var expected = (long) source.SizeX * source.SizeY * 8;
    if (expected > 1L << 30) throw new InvalidDataException("the RGBA16F source exceeds the 1 GiB limit");
    if (source.Bytes is null) throw new InvalidDataException("the SourceArt read returned no bytes");
    if (source.ElementCount != expected || source.Bytes.LongLength != expected)
        throw new InvalidDataException($"SourceArt read is incomplete or not raw: {source.Bytes.LongLength} bytes, element count {source.ElementCount}; {source.SizeX}x{source.SizeY} RGBA16F is {expected} bytes");
    for (var offset = 0; offset < source.Bytes.Length; offset += 2)
    {
        var sample = BinaryPrimitives.ReadUInt16LittleEndian(source.Bytes.AsSpan(offset, 2));
        if ((sample & 0x7C00) == 0x7C00)
            throw new InvalidDataException($"non-finite half-float sample at sample {offset / 2} (pixel {offset / 8}, channel {offset / 2 % 4})");
    }
    return new Rgba16fDataTexture(source.SizeX, source.SizeY, source.Bytes);
}
// SHA-256 of the package file set: for each present file (.uasset, .uexp, .ubulk, .uptnl, in that order), its "ext size" line and its bytes.
static string PackageSetSha256(IReadOnlyList<(string Extension, byte[] Bytes)> files)
{
    using var hash = System.Security.Cryptography.IncrementalHash.CreateHash(System.Security.Cryptography.HashAlgorithmName.SHA256);
    foreach (var file in files)
    {
        hash.AppendData(Encoding.ASCII.GetBytes($"{file.Extension} {file.Bytes.Length}\n"));
        hash.AppendData(file.Bytes);
    }
    return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
}
// Writes <name>.rgba16f-le and <name>.rgba16f.json. Each file is renamed into place from a temporary sibling.
static string WriteRgba16fDataTexture(string directory, string name, string packageKey, string objectPath, string packageSha256, Rgba16fDataTexture data, string converter)
{
    Directory.CreateDirectory(directory);
    var binaryName = name + ".rgba16f-le";
    var binaryPath = Path.Combine(directory, binaryName);
    var manifestPath = Path.Combine(directory, name + ".rgba16f.json");
    var dataSha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(data.Bytes)).ToLowerInvariant();
    var descriptor = new {
        format = "threenative-rgba16f-data-texture",
        version = 1,
        name,
        source = new { package = packageKey, @object = name, objectPath, @class = "Texture2D", sourceFormat = "TSF_RGBA16F", sha256 = packageSha256 },
        data = new {
            file = binaryName, format = "RGBA16F", layout = "little-endian-half4", width = data.Width, height = data.Height,
            mips = 1, slices = 1, channels = 4, bytesPerPixel = 8, bytes = data.Bytes.Length, sha256 = dataSha256, srgb = false, colorSpace = "none"
        },
        provenance = new { converter, unrealSource = "UE 4.19 Texture.cpp raw SourceArt path: bPNGCompressed false, 8 bytes per pixel" },
        limits = new[] { "Raw SourceArt bytes only: no PivotPainter, classifier, source UV, graph or WPO semantic decoding is applied." }
    };
    File.WriteAllBytes(binaryPath + ".tmp", data.Bytes);
    File.Move(binaryPath + ".tmp", binaryPath, true);
    File.WriteAllText(manifestPath + ".tmp", JsonConvert.SerializeObject(descriptor, Formatting.Indented) + "\n");
    File.Move(manifestPath + ".tmp", manifestPath, true);
    return manifestPath;
}
// The provider key of the loose file at root/relativePath, found by its physical path and never by a key, a suffix or a basename.
// The provider names a loose root after its own folder and folds keys case-insensitively, so a key can name another file. Null when
// no file exists at that path. Refused when the file exists but the provider holds no loose entry for exactly it, or holds two.
static string? ExactLooseKey(DefaultFileProvider provider, string root, string name, string relativePath)
{
    var physical = Path.GetFullPath(Path.Combine(root, relativePath));
    // The file name is compared first, so only the files that share it pay for the full path comparison.
    var fileName = Path.GetFileName(physical);
    var keys = provider.Files
        .Where(entry => entry.Value is CUE4Parse.FileProvider.Objects.OsGameFile loose && string.Equals(loose.ActualFile.Name, fileName, StringComparison.Ordinal) &&
            string.Equals(Path.GetFullPath(loose.ActualFile.FullName), physical, StringComparison.Ordinal))
        .Select(entry => entry.Key)
        .ToArray();
    if (keys.Length == 1) return keys[0];
    if (keys.Length > 1)
    {
        var listed = string.Join(", ", keys);
        throw RefuseRgba16fDataTexture(name, $"{relativePath} is registered {keys.Length} times ({listed}); exactly one key is needed");
    }
    if (File.Exists(physical)) throw RefuseRgba16fDataTexture(name, $"the provider registered no loose file at exactly {relativePath}");
    return null;
}
// The package a --data-texture selector names: the provider key of its .uasset, the package name the manifest records (the selector
// with .uasset, which the promotion checks), and the provider keys of the sidecars that exist at the same physical stem.
static Rgba16fPackage ResolveRgba16fPackage(DefaultFileProvider provider, string root, string selector)
{
    var name = Path.GetFileName(selector);
    var key = ExactLooseKey(provider, root, name, selector + ".uasset")
        ?? throw RefuseRgba16fDataTexture(name, $"no package has exactly the key {selector}.uasset under the source root");
    var sidecars = new Dictionary<string, string>();
    foreach (var extension in new[] { ".uexp", ".ubulk", ".uptnl" })
        if (ExactLooseKey(provider, root, name, selector + extension) is { } sidecar) sidecars[extension] = sidecar;
    RequireConsumedPayloads(provider, name, selector, key, sidecars);
    return new Rgba16fPackage(key, selector + ".uasset", sidecars);
}
// The payloads the load consumes for the package: FindPayloads on the file of the .uasset, the call LoadPackage makes. The provider folds
// keys case-insensitively, so it can hand over a namesake of a sidecar the exact stem lacks. Each extension must be consumed by the object
// the provider holds under its mapping key, or by nothing when the stem has no file. Anything else is refused before the package is read.
static void RequireConsumedPayloads(DefaultFileProvider provider, string name, string selector, string key, Dictionary<string, string> sidecars)
{
    provider.Files.FindPayloads(provider.Files[key], out var uexp, out var ubulks, out var uptnls);
    var consumed = new Dictionary<string, IReadOnlyList<CUE4Parse.FileProvider.Objects.GameFile>>
    {
        [".uexp"] = uexp is null ? [] : [uexp],
        [".ubulk"] = ubulks,
        [".uptnl"] = uptnls,
    };
    foreach (var (extension, payloads) in consumed)
    {
        var mappedKey = sidecars.GetValueOrDefault(extension);
        if (payloads.Count > 1) throw RefuseRgba16fDataTexture(name, $"the provider would load {payloads.Count} {extension} files for {selector}; exactly one is needed");
        if (payloads.Count == 0 && mappedKey is null) continue;
        if (payloads.Count == 0)
            throw RefuseRgba16fDataTexture(name, $"the provider would load no {extension} for {selector}, though {mappedKey} is registered at exactly that path");
        if (mappedKey is null)
            throw RefuseRgba16fDataTexture(name, $"the provider would load {payloads[0].Path} as the {extension} of {selector}, but no {extension} exists at exactly {selector}{extension}");
        if (!object.ReferenceEquals(payloads[0], provider.Files[mappedKey]))
            throw RefuseRgba16fDataTexture(name, $"the provider would load {payloads[0].Path} as the {extension} of {selector}, not {mappedKey}");
    }
}
// The package file set the converter hashes: the .uasset, then each sidecar that exists, each read through its exact provider key.
static List<(string Extension, byte[] Bytes)> ReadRgba16fPackageFiles(DefaultFileProvider provider, Rgba16fPackage mapping)
{
    var files = new List<(string Extension, byte[] Bytes)> { (".uasset", provider.Files[mapping.Key].Read()) };
    foreach (var extension in new[] { ".uexp", ".ubulk", ".uptnl" })
        if (mapping.Sidecars.TryGetValue(extension, out var sidecar)) files.Add((extension, provider.Files[sidecar].Read()));
    return files;
}
// Exports the one Texture2D named like the package file. The package file set is read through the provider by its exact keys.
static void ExportRgba16fDataTexture(IPackage package, DefaultFileProvider provider, Rgba16fPackage mapping, string output, string selector)
{
    var name = Path.GetFileName(selector);
    var textures = package.GetExports().OfType<UTexture2D>().Where(candidate => candidate.Name == name).ToArray();
    if (textures.Length != 1) throw RefuseRgba16fDataTexture(name, $"{textures.Length} Texture2D exports are named {name} in {mapping.Key}; exactly one is needed");
    var texture = textures[0];
    var files = ReadRgba16fPackageFiles(provider, mapping);
    Rgba16fDataTexture data;
    try { data = ValidateRgba16fSourceArt(ReadRgba16fSourceArt(texture)); }
    catch (InvalidDataException error) { throw RefuseRgba16fDataTexture(name, error.Message); }
    // The manifest names the package by its root-relative selector, which is what the promotion checks, and never by the provider key.
    var manifest = WriteRgba16fDataTexture(Path.Combine(output, "DataTextures"), name, mapping.PackageKey, texture.GetPathName(), PackageSetSha256(files), data, "threenative-cue4parse ${CUE4PARSE_SOURCE.version}");
    Console.WriteLine($"threenative-data-texture {name}: {manifest}");
}
// Names the refusal on stderr the way the importer reads texture failures, and returns the exception to throw.
static Exception RefuseRgba16fDataTexture(string name, string reason)
{
    Console.Error.WriteLine($"threenative-texture-failure {name}: {reason}");
    return new InvalidDataException(reason);
}

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

// A texture the converter cannot write is reported with the evidence that decides the cause, so the
// importer can say "pixel data not present in the pack" instead of a bare exit code.
static string ReportTextureFailure(UTexture2D texture, IEnumerable<ExportResult> results, string reason, List<string> payloadFailures)
{
    var source = texture.GetOrDefault<FStructFallback?>("Source", null);
    var mip = texture.GetFirstMip();
    var exportErrors = string.Join(" | ", results.Where(item => item.Error is not null).Select(item => item.Error!.GetType().Name + ": " + item.Error.Message));
    var message =
        $"threenative-texture-failure {texture.Name}: {reason}; " +
        $"platformFormat={texture.PlatformData?.PixelFormat}, mips={texture.PlatformData?.Mips?.Length ?? 0}, firstMipBulk={(mip?.BulkData is { } bulk ? bulk.Header.ElementCount : -1)}, " +
        $"compression={texture.CompressionSettings}, srgb={texture.SRGB}, sourceFormat={source?.GetOrDefault<FName>("Format").Text}, " +
        $"sourceCompression={source?.GetOrDefault<FName>("CompressionFormat").Text}, " +
        $"editorPayload={(texture.EditorData is { } editor ? $"{editor.Payload.Header.Method}/{editor.Payload.Header.TotalRawSize}B/offset {editor.OffsetInFile}" : "none")}, " +
        $"exportErrors=[{exportErrors}], payload=[{string.Join(" | ", payloadFailures)}]";
    Console.Error.WriteLine(message);
    return message;
}

static byte[]? ExtractCompressedPayloadPng(byte[] bytes, List<string>? failures = null)
{
    ReadOnlySpan<byte> magic = [0xb7, 0x75, 0x63, 0x62];
    var searchAt = 0;
    while (searchAt <= bytes.Length - magic.Length)
    {
        var relativeAt = bytes.AsSpan(searchAt).IndexOf(magic);
        if (relativeAt < 0)
        {
            if (searchAt == 0) failures?.Add("the package holds no editor source payload and no cooked mip (pixel data is not in the pack)");
            return null;
        }
        var payloadAt = searchAt + relativeAt;
        searchAt = payloadAt + magic.Length;
        try
        {
            using var archive = new FByteArchive("editor-payload", bytes);
            archive.Position = payloadAt;
            var payload = new FCompressedBuffer(archive);
            if (payload.Header.TotalRawSize == 0 || payload.Header.TotalRawSize > 1_073_741_824) continue;
            var raw = DecompressEditorPayload(payload);
            var png = ExtractLargestPng(raw) ?? ExtractLargestJpegAsPng(raw);
            if (png is not null) return png;
            failures?.Add($"payload at {payloadAt} ({payload.Header.Method}, {payload.Header.TotalRawSize} bytes) decoded but holds no PNG or JPEG");
        }
        catch (Exception error)
        {
            // The magic may occur in unrelated bulk bytes. Continue to the next bounded candidate.
            failures?.Add($"payload at {payloadAt}: {error.GetType().Name}: {error.Message}");
        }
    }
    return null;
}

// Editor source art in the order every exporter should try it: a TSCF_UEDELTA payload (raw pixels,
// row-delta filtered, UE 5.6+), then an inline PNG, then a PNG or JPEG inside a compressed payload.
// The inline scan skips the package's own registered thumbnails, which are previews, not source art.
static byte[]? ExtractSourcePng(byte[] bytes, UTexture? texture, List<string>? failures = null)
    => ExtractUeDeltaSourcePng(bytes, texture, failures) ?? ExtractLargestPng(bytes, RegisteredThumbnails(bytes, texture), failures) ?? ExtractCompressedPayloadPng(bytes, failures);

// The editor saves a 256 px display-gamma preview of every asset in its package (FObjectThumbnail: int32 width, int32 height,
// int32 byte count, then the image) and lists where each one sits in the summary's thumbnail table, which CUE4Parse reads the same
// way. That table is the proof that an image is a preview. An image's size, its name or the bytes in front of it prove nothing,
// because a genuine source can look the same. A package without a table registers nothing, and a damaged table registers the
// entries read before the damage. A texture CUE4Parse did not load (a sprite or a material route whose class it rejects) has no
// parsed summary, so the summary is read from the package bytes instead; if that fails too, nothing is registered.
static List<(long Start, long End)> RegisteredThumbnails(byte[] bytes, UTexture? texture)
{
    var previews = new List<(long Start, long End)>();
    var offsets = new List<int>();
    try
    {
        using var archive = new FByteArchive("thumbnail-table", bytes);
        var tableAt = texture?.Owner is Package owner ? owner.Summary.ThumbnailTableOffset : new FPackageFileSummary(archive).ThumbnailTableOffset;
        if (tableAt <= 0 || tableAt > bytes.Length - 4L) return previews;
        archive.Position = tableAt;
        var count = archive.Read<int>();
        // An entry is two strings and an offset, at least 12 bytes, so the bytes left bound the loop and no fixed cap is needed.
        for (var index = 0; index < count && archive.Position + 12 <= bytes.Length; index++)
        {
            archive.ReadFString();
            archive.ReadFString();
            offsets.Add(archive.Read<int>());
        }
    }
    catch (Exception)
    {
        // The offsets read before the damage stay registered; nothing else is assumed to be a preview.
    }
    foreach (var offset in offsets)
    {
        if (offset < 0 || offset + 12L > bytes.Length) continue;
        var size = BitConverter.ToInt32(bytes, offset + 8);
        if (size > 0 && offset + 12L + size <= bytes.Length) previews.Add((offset + 12L, offset + 12L + size));
    }
    return previews;
}

// TSCF_UEDELTA (UE 5.6+ editor default for 8- and 16-bit sources): the payload is the raw source
// pixels with each tile's rows replaced by their difference from the row above. Decoding it needs
// the source's size and format from the Source struct, so it cannot be found by scanning for an
// image signature; without this a UE 5.6+ pack exported no colour textures at all.
static byte[]? ExtractUeDeltaSourcePng(byte[] bytes, UTexture? texture, List<string>? failures)
{
    var source = texture?.GetOrDefault<FStructFallback?>("Source", null);
    if (source is null) return null;
    var compression = source.GetOrDefault<FName>("CompressionFormat").Text ?? "";
    if (!compression.EndsWith("TSCF_UEDELTA", StringComparison.Ordinal)) return null;
    var format = source.GetOrDefault<FName>("Format").Text ?? "";
    format = format[(format.LastIndexOf(':') + 1)..];
    var width = source.GetOrDefault<int>("SizeX");
    var height = source.GetOrDefault<int>("SizeY");
    var slices = Math.Max(1, source.GetOrDefault<int>("NumSlices"));
    var mips = Math.Max(1, source.GetOrDefault<int>("NumMips"));
    var layers = Math.Max(1, source.GetOrDefault<int>("NumLayers"));
    var blocks = source.GetOrDefault<FStructFallback[]>("Blocks") ?? Array.Empty<FStructFallback>();
    if (layers > 1 || blocks.Length > 0)
    {
        failures?.Add($"TSCF_UEDELTA source with {layers} layers and {blocks.Length} extra blocks is not supported");
        return null;
    }
    var (bytesPerPixel, sampleBytes) = UeDeltaPixelLayout(format);
    if (bytesPerPixel == 0 || width <= 0 || height <= 0)
    {
        failures?.Add($"TSCF_UEDELTA source format {format} ({width}x{height}) is not supported");
        return null;
    }
    long total = 0;
    for (var mip = 0; mip < mips; mip++) total += (long) Math.Max(1, width >> mip) * Math.Max(1, height >> mip) * slices * bytesPerPixel;
    foreach (var (at, rawSize) in ScanEditorPayloads(bytes))
    {
        if ((long) rawSize != total) continue;
        try
        {
            using var archive = new FByteArchive("editor-payload", bytes);
            archive.Position = at;
            var pixels = DecompressEditorPayload(new FCompressedBuffer(archive));
            // Mip 0, slice 0 is all the importer keeps; it is the first image in the payload.
            UndoUeDelta(pixels, 0, width, height, bytesPerPixel, sampleBytes);
            var png = EncodeSourcePixels(pixels, width, height, format, texture!.SRGB);
            RawDerived.Table.Add(png, new object());
            return png;
        }
        catch (Exception error) when (error is not OutOfMemoryException)
        {
            failures?.Add($"TSCF_UEDELTA payload at {at}: {error.GetType().Name}: {error.Message}");
        }
    }
    failures?.Add($"no TSCF_UEDELTA payload of {total} bytes ({format} {width}x{height}, {mips} mips, {slices} slices)");
    return null;
}

// Bytes per pixel and per delta sample of each source format the delta filter covers (0 = not
// covered). Float formats are never delta coded.
static (int BytesPerPixel, int SampleBytes) UeDeltaPixelLayout(string format) => format switch
{
    "TSF_G8" => (1, 1),
    "TSF_BGRA8" or "TSF_BGRE8" => (4, 1),
    "TSF_G16" => (2, 2),
    "TSF_RGBA16" => (8, 2),
    _ => (0, 0),
};

// The inverse of Unreal's row delta (ImageCoreDelta). The image is cut into tiles that are each
// coded on their own: rows wider than 4096 bytes are split into columns of a cache-line multiple,
// and each column into runs of rows of about 32768 pixels (at most 512 runs). A tile's first row is
// stored as is; every later sample is the difference from the sample above it, plus 0x8080 for
// 16-bit samples. The cut rules are part of the file format, so they are reproduced exactly.
static void UndoUeDelta(byte[] data, long offset, int width, int height, int bytesPerPixel, int sampleBytes)
{
    const long minPixelsPerCut = 32768, minPixelsForAnyCut = 136 * 136, cutStrideBytes = 4096, maxNumCuts = 512;
    long strideBytes = (long) width * bytesPerPixel;
    static long RowsPerCut(long sizeX, long sizeY)
    {
        var pixels = sizeX * sizeY;
        long cuts = 1;
        if (pixels > minPixelsPerCut)
        {
            cuts = pixels / minPixelsPerCut;
            while (cuts > maxNumCuts) cuts >>= 1;
        }
        return (sizeY + cuts - 1) / cuts;
    }
    void Tile(long startX, long tileWidth, long startY, long tileHeight)
    {
        var rowBytes = tileWidth * bytesPerPixel;
        for (var y = startY + 1; y < startY + tileHeight; y++)
        {
            var row = offset + y * strideBytes + startX * bytesPerPixel;
            var above = row - strideBytes;
            if (sampleBytes == 1)
            {
                for (long x = 0; x < rowBytes; x++) data[row + x] = (byte) (data[row + x] + data[above + x]);
            }
            else
            {
                for (long x = 0; x < rowBytes; x += 2)
                {
                    var delta = data[row + x] | (data[row + x + 1] << 8);
                    var up = data[above + x] | (data[above + x + 1] << 8);
                    var value = (delta + up - 0x8080) & 0xFFFF;
                    data[row + x] = (byte) value;
                    data[row + x + 1] = (byte) (value >> 8);
                }
            }
        }
    }
    if ((long) width * height <= minPixelsForAnyCut)
    {
        Tile(0, width, 0, height);
        return;
    }
    long partPixels = width;
    if (strideBytes > cutStrideBytes)
    {
        var parts = (strideBytes + cutStrideBytes - 1) / cutStrideBytes;
        var partBytes = (strideBytes + parts / 2) / parts;
        partBytes = (partBytes + 63) & ~63L;
        partPixels = partBytes / bytesPerPixel;
    }
    for (long startX = 0; startX < width; startX += partPixels)
    {
        var tileWidth = Math.Min(partPixels, width - startX);
        var rows = RowsPerCut(tileWidth, height);
        for (long startY = 0; startY < height; startY += rows) Tile(startX, tileWidth, startY, Math.Min(rows, height - startY));
    }
}

// Raw source pixels (mip 0, slice 0) as an RGBA PNG in true colour. A 16-bit sRGB source is linear
// light, so it is encoded to sRGB like the 16-bit PNG source path does.
static byte[] EncodeSourcePixels(byte[] pixels, int width, int height, string format, bool srgb)
{
    var rgba = new byte[(long) width * height * 4];
    var count = (long) width * height;
    switch (format)
    {
        case "TSF_G8":
            for (long i = 0; i < count; i++) { var g = pixels[i]; rgba[i * 4] = g; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = g; rgba[i * 4 + 3] = 255; }
            break;
        case "TSF_BGRA8":
        case "TSF_BGRE8":
            for (long i = 0; i < count; i++)
            {
                rgba[i * 4] = pixels[i * 4 + 2];
                rgba[i * 4 + 1] = pixels[i * 4 + 1];
                rgba[i * 4 + 2] = pixels[i * 4];
                rgba[i * 4 + 3] = pixels[i * 4 + 3];
            }
            break;
        case "TSF_G16":
        case "TSF_RGBA16":
        {
            var lut = new byte[65536];
            for (var value = 0; value < lut.Length; value++)
            {
                var linear = value / 65535.0;
                var encoded = srgb ? (linear <= 0.0031308 ? linear * 12.92 : 1.055 * Math.Pow(linear, 1 / 2.4) - 0.055) : linear;
                lut[value] = (byte) Math.Clamp(Math.Round(encoded * 255), 0, 255);
            }
            int Sample(long index) => pixels[index] | (pixels[index + 1] << 8);
            for (long i = 0; i < count; i++)
            {
                if (format == "TSF_G16")
                {
                    var g = lut[Sample(i * 2)];
                    rgba[i * 4] = g; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = g; rgba[i * 4 + 3] = 255;
                    continue;
                }
                rgba[i * 4] = lut[Sample(i * 8)];
                rgba[i * 4 + 1] = lut[Sample(i * 8 + 2)];
                rgba[i * 4 + 2] = lut[Sample(i * 8 + 4)];
                rgba[i * 4 + 3] = (byte) Math.Clamp(Math.Round(Sample(i * 8 + 6) / 257.0), 0, 255); // alpha is coverage, not light
            }
            break;
        }
        default:
            throw new InvalidDataException($"Unsupported source format {format}.");
    }
    var info = new SkiaSharp.SKImageInfo(width, height, SkiaSharp.SKColorType.Rgba8888, SkiaSharp.SKAlphaType.Unpremul);
    var handle = GCHandle.Alloc(rgba, GCHandleType.Pinned);
    try
    {
        using var pixmap = new SkiaSharp.SKPixmap(info, handle.AddrOfPinnedObject());
        using var png = pixmap.Encode(SkiaSharp.SKEncodedImageFormat.Png, 100) ?? throw new InvalidDataException("PNG encode failed.");
        return png.ToArray();
    }
    finally
    {
        handle.Free();
    }
}

// The LOD0 source model of an uncooked UE5 StaticMesh. Its package trailer holds one
// FMeshDescription payload per source-model LOD, so the largest raw payload that parses is LOD0.
// Every other payload in a StaticMesh package is also a mesh description, so ranking by the
// header's raw size decompresses only what is kept.
static EditorMesh? ReadLargestMeshDescription(byte[] bytes, out string? refusal, int cachedTriangles = 0)
{
    refusal = null;
    foreach (var (at, _) in ScanEditorPayloads(bytes))
    {
        try
        {
            using var archive = new FByteArchive("editor-payload", bytes);
            archive.Position = at;
            return ReadMeshDescription(DecompressEditorPayload(new FCompressedBuffer(archive)), cachedTriangles);
        }
        catch (NotSupportedException error)
        {
            // A mesh description in a layout this reader knows it cannot map; say so.
            refusal ??= error.Message;
        }
        catch
        {
            // Not a mesh description; try the next largest payload.
        }
    }
    return null;
}

// Every plausible FCompressedBuffer in a package, largest raw size first. The 0xb7 0x75 0x63 0x62
// magic also occurs inside unrelated bulk bytes, so each candidate is header-validated and the
// reader decides what it is.
static List<(int At, ulong RawSize)> ScanEditorPayloads(byte[] bytes)
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
    return candidates.OrderByDescending(candidate => candidate.RawSize).ToList();
}

// A GroomAsset's hair description is editor-only bulk data, so the cooked export path never sees
// it: it lives in the package's compressed trailer. CUE4Parse has no GroomAsset export to read it
// from, so every decompressible candidate is written raw and the importer's parser picks the one
// that decodes as a hair description. Returning the candidate count keeps a groom package that
// decoded nothing from passing for an export.
int ExportGroomPayloads(byte[] bytes, string name)
{
    var written = 0;
    foreach (var (at, _) in ScanEditorPayloads(bytes))
    {
        try
        {
            using var archive = new FByteArchive("groom-payload", bytes);
            archive.Position = at;
            var raw = DecompressEditorPayload(new FCompressedBuffer(archive));
            File.WriteAllBytes(Path.Combine(output, "Grooms", $"{name}.payload{written}.bin"), raw);
            written++;
        }
        catch
        {
            // Not a decompressible payload; the next candidate is still worth trying.
        }
    }
    return written;
}

// UE5's FMeshDescription serialization, as verified byte-exact on the Common Hazel packs (see
// docs/PRDs/done/ue5-mesh-description-reference.py for the annotated layout). Throws unless the
// whole payload is consumed, so a layout drift is a refusal rather than garbage geometry.
//
// Some UE 5.8 re-saves (the LookAtPOI border props) store a payload longer than the description it
// holds: every declared element type parses, then the tail repeats the cut-off start of an earlier,
// different serialization. Such a payload is kept only when cachedTriangles (the source model's
// CacheMeshDescriptionTrianglesCount, written at save time) equals the decoded live triangle count and
// exactly one FName layout reads it that way; without that count, or with a mismatch, it stays a refusal.
static EditorMesh ReadMeshDescription(byte[] raw, int cachedTriangles = 0)
{
    var mesh = ReadMeshDescriptionInEitherLayout(raw, cachedTriangles);
    // Checked once the layout is settled: inside an attempt, a refusal would be retried as the other FName layout and
    // reported as that layout's error.
    CheckActiveUvChannels(mesh);
    return mesh;
}

// Every UV channel spans every allocated vertex instance (holes included), as Normal and VertexIndex do, and each live
// triangle corner names an allocated instance with a finite coordinate in every channel. Only live triangles are written,
// so only their corners need one. A channel that does not span, or a corner with a non-finite coordinate, is refused
// rather than padded.
static void CheckActiveUvChannels(EditorMesh mesh)
{
    var instances = mesh.InstanceVertices.Length;
    foreach (var (channel, values) in mesh.UvChannels)
    {
        if (values.Length != instances * 2)
            throw new InvalidDataException("UV channel " + channel + " has " + values.Length / 2 + " values for " + instances + " vertex instances.");
    }
    for (var triangle = 0; triangle < mesh.TriangleInstances.Length / 3; triangle++)
    {
        if (triangle < mesh.LiveTriangles.Length && !mesh.LiveTriangles[triangle]) continue;
        for (var corner = 0; corner < 3; corner++)
        {
            var instance = mesh.TriangleInstances[triangle * 3 + corner];
            if (instance < 0 || instance >= instances)
                throw new InvalidDataException("Triangle " + triangle + " uses vertex instance " + instance + " of " + instances + ".");
            foreach (var (channel, values) in mesh.UvChannels)
            {
                if (!float.IsFinite(values[instance * 2]) || !float.IsFinite(values[instance * 2 + 1]))
                    throw new InvalidDataException("UV channel " + channel + " is not finite at vertex instance " + instance + ".");
            }
        }
    }
}

static EditorMesh ReadMeshDescriptionInEitherLayout(byte[] raw, int cachedTriangles)
{
    // Both FName array layouts are tried; only one consumes the whole payload.
    try
    {
        return ReadMeshDescriptionLayout(raw, compactNames: false, 0);
    }
    catch (Exception error) when (error is not OutOfMemoryException)
    {
        try
        {
            return ReadMeshDescriptionLayout(raw, compactNames: true, 0);
        }
        catch (InvalidDataException strict) when (cachedTriangles > 0)
        {
            var readings = new List<EditorMesh>();
            foreach (var compactNames in new[] { false, true })
            {
                try { readings.Add(ReadMeshDescriptionLayout(raw, compactNames, cachedTriangles)); }
                catch (Exception tolerant) when (tolerant is not OutOfMemoryException) { }
            }
            if (readings.Count == 1) return readings[0];
            throw readings.Count == 0 ? strict : new InvalidDataException("Mesh description with a trailing tail reads in both FName layouts.");
        }
    }
}

static EditorMesh ReadMeshDescriptionLayout(byte[] raw, bool compactNames, int cachedTriangles)
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
    // A TextureCoordinate index is one UV channel: an FVector2f (kind 2, eight bytes) in at most eight channels, which is
    // what Unreal's UV sets are. Any other layout is one this reader does not map, so it is refused by name.
    void CheckUvChannel(int channel, int kind, int elementSize)
    {
        if (channel >= 8) throw new NotSupportedException("VertexInstance TextureCoordinate channel " + channel + " is past the eight UV channels Unreal allows");
        if (kind != 2 || elementSize != 8) throw new NotSupportedException("VertexInstance TextureCoordinate channel " + channel + " is attribute kind " + kind + " with " + elementSize + "-byte elements, not FVector2f");
    }
    var arrays = new Dictionary<string, byte[]>(StringComparer.Ordinal);
    var kinds = new Dictionary<string, int>(StringComparer.Ordinal);
    var names = new Dictionary<string, string[]>(StringComparer.Ordinal);
    var live = new Dictionary<string, bool[]>(StringComparer.Ordinal);
    var textureCoordinates = 0; // the UV channels of the VertexInstances element: one TextureCoordinate index each
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
                if (element == "VertexInstances" && attribute == "TextureCoordinate") textureCoordinates = indices;
                for (var index = 0; index < indices; index++)
                {
                    reader.ReadInt32(); // extent
                    var key = element + "[" + channel + "]." + attribute + "[" + index + "]";
                    if (kind == 6)
                    {
                        var count = reader.ReadInt32();
                        if (compactNames)
                        {
                            // UE 5.8 re-saves (Paladin weapons, LookAtPOI props): the element count is
                            // followed by a distinct-name count and the distinct names. Every package
                            // seen so far holds one distinct name, which then names every element;
                            // with more, the element-to-name mapping is unknown, so refuse.
                            var distinct = reader.ReadInt32();
                            if (distinct != (count == 0 ? 0 : 1))
                                throw new NotSupportedException($"FName attribute {attribute} has {distinct} distinct names for {count} elements in the UE 5.8 compact layout");
                            var only = distinct == 1 ? ReadName() : "";
                            names[key] = Enumerable.Repeat(only, count).ToArray();
                            continue;
                        }
                        names[key] = Enumerable.Range(0, count).Select(_ => ReadName()).ToArray();
                        continue;
                    }
                    var elementSize = reader.ReadInt32();
                    var elements = reader.ReadInt32();
                    if (element == "VertexInstances" && attribute == "TextureCoordinate") CheckUvChannel(index, kind, elementSize);
                    arrays[key] = reader.ReadBytes(checked(elementSize * elements));
                    kinds[key] = kind;
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
    var liveTriangles = live.TryGetValue("Triangles", out var liveTriangleFlags) ? liveTriangleFlags.Count(flag => flag) : 0;
    if (stream.Position != raw.Length && (cachedTriangles <= 0 || liveTriangles != cachedTriangles))
        throw new InvalidDataException("Mesh description was not fully consumed.");
    float[] Floats(string key) => arrays.TryGetValue(key, out var bytes) ? MemoryMarshal.Cast<byte, float>(bytes).ToArray() : throw new InvalidDataException("Missing " + key);
    int[] Ints(string key) => arrays.TryGetValue(key, out var bytes) ? MemoryMarshal.Cast<byte, int>(bytes).ToArray() : throw new InvalidDataException("Missing " + key);
    // A vertex-instance colour is a linear FVector4f (attribute kind 0, 16 bytes), the layout Unreal
    // writes for MeshAttribute::VertexInstance::Color. Any other stored type would need a reinterpretation
    // this reader does not do, so it is left absent rather than guessed; absent also means no colour buffer.
    float[] Colors()
    {
        const string key = "VertexInstances[0].Color[0]";
        return arrays.TryGetValue(key, out var bytes) && kinds.TryGetValue(key, out var kind) && kind == 0
            ? MemoryMarshal.Cast<byte, float>(bytes).ToArray()
            : [];
    }
    // UV channel n is TextureCoordinate index n: one FVector2f per allocated vertex instance, holes included, so it spans
    // the same count as VertexIndex and Normal. A channel that does not is refused rather than padded or renumbered.
    var instanceVertices = Ints("VertexInstances[0].VertexIndex[0]");
    var uvChannels = new (int Channel, float[] Values)[textureCoordinates];
    for (var channel = 0; channel < textureCoordinates; channel++)
        uvChannels[channel] = (channel, MemoryMarshal.Cast<byte, float>(arrays["VertexInstances[0].TextureCoordinate[" + channel + "]"]).ToArray());
    var triangleInstances = Ints("Triangles[0].VertexInstanceIndex[0]");
    var triangleLive = live.TryGetValue("Triangles", out var triangleFlags) ? triangleFlags : [];
    return new EditorMesh(
        Floats("Vertices[0].Position[0]"),
        instanceVertices,
        Floats("VertexInstances[0].Normal[0]"),
        uvChannels,
        Colors(),
        triangleInstances,
        Ints("Triangles[0].PolygonGroupIndex[0]"),
        triangleLive,
        names.TryGetValue("PolygonGroups[0].ImportedMaterialSlotName[0]", out var slots) ? slots : []);
}

// Writes the decoded source model with the cooked glTF writer's conventions: centimetres to metres,
// Unreal's Z-up swapped to glTF's Y-up, and Unreal's triangle order kept (the axis swap and Unreal's
// left-handedness cancel). Tangents are still left out, so a glTF client generates MikkTSpace tangents.
// Every UV channel the MeshDescription carries is written as TEXCOORD_<index> at its own index, and only those: an
// absent channel is not written, no set is zero-filled or renumbered, and a source without UV channels has no TEXCOORD
// at all. Each primitive stores every distinct vertex once, keyed by its whole value (position, normal, colour and all
// channels), so instances that differ only in a later channel keep separate vertices.
// A source model whose MeshDescription carries a per-vertex-instance Color is written as COLOR_0, as the
// cooked writer does; glTF clients with a material that does not read it would still multiply it into the
// base colour, so the importer drops COLOR_0 for those sections. Without such an attribute no COLOR_0 is
// written at all, so nothing is invented for an unpainted mesh.
static void WriteEditorMeshGlb(EditorMesh mesh, string[] materialNames, string name, string target)
{
    // Every vertex instance must have a colour for the attribute to line up with the instance indexing,
    // so a colour buffer of any other length is treated as absent rather than padded or truncated.
    var colors = mesh.VertexColors.Length == mesh.InstanceVertices.Length * 4 ? mesh.VertexColors : null;
    var root = SharpGLTF.Schema2.ModelRoot.CreateModel();
    SharpGLTF.Schema2.Mesh? gltfMesh = null;
    var materials = new Dictionary<int, SharpGLTF.Schema2.Material>();
    SharpGLTF.Schema2.Material Material(int group)
    {
        if (materials.TryGetValue(group, out var existing)) return existing;
        var builder = new SharpGLTF.Materials.MaterialBuilder(group >= 0 && group < materialNames.Length ? materialNames[group] : "MaterialSlot_" + group)
            .WithBaseColor(System.Numerics.Vector4.One);
        var material = SharpGLTF.Schema2.Toolkit.CreateMaterial(root, builder);
        materials[group] = material;
        return material;
    }
    // One vertex instance's packed value: position and normal converted as before, the colour (when the mesh has one)
    // as the value Unreal's shader reads, then each UV channel at the instance's own index.
    float[] PackVertex(int instance)
    {
        var vertex = mesh.InstanceVertices[instance];
        var position = new System.Numerics.Vector3(mesh.Positions[vertex * 3], mesh.Positions[vertex * 3 + 2], mesh.Positions[vertex * 3 + 1]) * 0.01f;
        var normal = new System.Numerics.Vector3(mesh.Normals[instance * 3], mesh.Normals[instance * 3 + 2], mesh.Normals[instance * 3 + 1]);
        normal = normal.LengthSquared() > 1e-12f && float.IsFinite(normal.LengthSquared()) ? System.Numerics.Vector3.Normalize(normal) : System.Numerics.Vector3.UnitY;
        var packed = new List<float> { position.X, position.Y, position.Z, normal.X, normal.Y, normal.Z };
        if (colors is not null)
        {
            var color = EditorVertexColor(colors, instance);
            packed.AddRange(new[] { color.X, color.Y, color.Z, color.W });
        }
        foreach (var (_, values) in mesh.UvChannels) packed.AddRange(new[] { values[instance * 2], values[instance * 2 + 1] });
        return packed.ToArray();
    }
    SharpGLTF.Schema2.Accessor VertexAccessor(byte[] bytes, int count, SharpGLTF.Schema2.DimensionType dimensions, SharpGLTF.Schema2.EncodingType encoding = SharpGLTF.Schema2.EncodingType.FLOAT, bool normalized = false)
    {
        var view = root.UseBufferView(bytes, 0, null, 0, SharpGLTF.Schema2.BufferMode.ARRAY_BUFFER);
        var accessor = root.CreateAccessor();
        accessor.SetVertexData(view, 0, count, dimensions, encoding, normalized);
        return accessor;
    }
    SharpGLTF.Schema2.Accessor IndexAccessor(IReadOnlyList<int> indices, int vertexCount)
    {
        // The narrowest index type that holds every vertex index: UNSIGNED_SHORT up to 65536 vertices.
        var wide = vertexCount > 65536;
        var bytes = wide
            ? MemoryMarshal.AsBytes(indices.Select(index => (uint)index).ToArray().AsSpan()).ToArray()
            : MemoryMarshal.AsBytes(indices.Select(index => (ushort)index).ToArray().AsSpan()).ToArray();
        var view = root.UseBufferView(bytes, 0, null, 0, SharpGLTF.Schema2.BufferMode.ELEMENT_ARRAY_BUFFER);
        var accessor = root.CreateAccessor();
        accessor.SetIndexData(view, 0, indices.Count, wide ? SharpGLTF.Schema2.IndexEncodingType.UNSIGNED_INT : SharpGLTF.Schema2.IndexEncodingType.UNSIGNED_SHORT);
        return accessor;
    }
    static byte[] FloatBytes(float[] values) => MemoryMarshal.AsBytes(values.AsSpan()).ToArray();
    // The byte a normalized UNSIGNED_BYTE COLOR_0 stores for an encoded channel. The encoders above add half a step, so
    // truncating at 255 lands on the byte Unreal's ToFColor(true) writes, exactly as the SharpGLTF encoder did.
    static byte ColourByte(float encoded) => (byte)Math.Clamp(MathF.Floor(encoded * 255f), 0f, 255f);
    // Two corners at one position make a zero-area triangle, which the builder this writer replaces dropped (whatever their
    // normal, colour or UVs); the position is the first three components of a packed vertex.
    bool SamePosition(float[] left, float[] right) => left.AsSpan(0, 3).SequenceEqual(right.AsSpan(0, 3));
    // Triangles are grouped by material slot, one primitive per slot in the order each slot is first used, and only the
    // live triangles are written.
    var groupOrder = new List<int>();
    var groupTriangles = new Dictionary<int, List<int>>();
    for (var triangle = 0; triangle < mesh.TriangleInstances.Length / 3; triangle++)
    {
        if (triangle < mesh.LiveTriangles.Length && !mesh.LiveTriangles[triangle]) continue;
        var group = triangle < mesh.TriangleGroups.Length ? mesh.TriangleGroups[triangle] : 0;
        if (!groupTriangles.TryGetValue(group, out var triangles))
        {
            groupOrder.Add(group);
            groupTriangles[group] = triangles = new List<int>();
        }
        triangles.Add(triangle);
    }
    foreach (var group in groupOrder)
    {
        var vertices = new List<float[]>();
        var vertexOf = new Dictionary<float[], int>(new EditorVertexComparer());
        var indices = new List<int>();
        foreach (var triangle in groupTriangles[group])
        {
            var corners = new[] { PackVertex(mesh.TriangleInstances[triangle * 3]), PackVertex(mesh.TriangleInstances[triangle * 3 + 1]), PackVertex(mesh.TriangleInstances[triangle * 3 + 2]) };
            // A triangle with two corners at one position is dropped, as it always was. The UV channels and normals only split
            // vertices, so the triangles, and therefore the index buffer of a single-channel source, are unchanged.
            if (SamePosition(corners[0], corners[1]) || SamePosition(corners[1], corners[2]) || SamePosition(corners[2], corners[0])) continue;
            foreach (var packed in corners)
            {
                if (!vertexOf.TryGetValue(packed, out var local))
                {
                    local = vertices.Count;
                    vertices.Add(packed);
                    vertexOf.Add(packed, local);
                }
                indices.Add(local);
            }
        }
        // A group whose triangles were all dropped has no primitive, as before.
        if (indices.Count == 0) continue;
        gltfMesh ??= root.CreateMesh(name);
        var count = vertices.Count;
        var positions = new float[count * 3];
        var normals = new float[count * 3];
        var colourBytes = colors is null ? null : new byte[count * 4];
        var uvs = mesh.UvChannels.Select(_ => new float[count * 2]).ToArray();
        for (var vertex = 0; vertex < count; vertex++)
        {
            var packed = vertices[vertex];
            Array.Copy(packed, 0, positions, vertex * 3, 3);
            Array.Copy(packed, 3, normals, vertex * 3, 3);
            var at = 6;
            if (colourBytes is not null)
            {
                for (var component = 0; component < 4; component++) colourBytes[vertex * 4 + component] = ColourByte(packed[at + component]);
                at += 4;
            }
            for (var channel = 0; channel < uvs.Length; channel++)
            {
                uvs[channel][vertex * 2] = packed[at];
                uvs[channel][vertex * 2 + 1] = packed[at + 1];
                at += 2;
            }
        }
        var primitive = gltfMesh.CreatePrimitive();
        primitive.Material = Material(group);
        primitive.SetVertexAccessor("POSITION", VertexAccessor(FloatBytes(positions), count, SharpGLTF.Schema2.DimensionType.VEC3));
        primitive.SetVertexAccessor("NORMAL", VertexAccessor(FloatBytes(normals), count, SharpGLTF.Schema2.DimensionType.VEC3));
        if (colourBytes is not null)
            primitive.SetVertexAccessor("COLOR_0", VertexAccessor(colourBytes, count, SharpGLTF.Schema2.DimensionType.VEC4, SharpGLTF.Schema2.EncodingType.UNSIGNED_BYTE, normalized: true));
        for (var channel = 0; channel < uvs.Length; channel++)
            primitive.SetVertexAccessor("TEXCOORD_" + mesh.UvChannels[channel].Channel, VertexAccessor(FloatBytes(uvs[channel]), count, SharpGLTF.Schema2.DimensionType.VEC2));
        primitive.SetIndexAccessor(IndexAccessor(indices, count));
    }
    var scene = root.UseScene(0);
    if (gltfMesh is not null) SharpGLTF.Schema2.Toolkit.WithMesh(scene.CreateNode(), gltfMesh);
    Directory.CreateDirectory(Path.GetDirectoryName(target)!);
    root.SaveGLB(target);
}

// One vertex instance's colour as the value Unreal's shader reads. The MeshDescription stores a linear
// FVector4f, but the static-mesh build packs it with FLinearColor::ToFColor(true) -- sRGB-encoding RGB
// (standard .0031308 breakpoint), keeping alpha linear, quantising to a byte -- and VET_Color reads that
// byte / 255 with no gamma decode (the Platform.ush code applies a channel swizzle only). A glTF COLOR_0
// of the raw source would make a client read a different colour than Unreal, so the shader value is
// written instead. UE5.8's ToFColorSRGB takes RGB through a fast LUT, which may differ from this standard
// sRGB curve by at most one byte; alpha is the same round-to-nearest. A colour index past the buffer would
// be a malformed mesh; Unreal's default white is used so the whole export does not fail over one bad
// triangle, and an unpainted mesh writes no COLOR_0 at all.
static System.Numerics.Vector4 EditorVertexColor(float[] colors, int instance)
{
    var at = instance * 4;
    return at >= 0 && at + 3 < colors.Length
        ? new System.Numerics.Vector4(SrgbVertexChannel(colors[at]), SrgbVertexChannel(colors[at + 1]), SrgbVertexChannel(colors[at + 2]), LinearVertexChannel(colors[at + 3]))
        : System.Numerics.Vector4.One;
}

// The byte Unreal's ToFColor(true) writes for a linear RGB channel, as the normalized value SharpGLTF
// stores. MathF.Round(..., AwayFromZero) is the modern nearest byte (.5 up); the +0.5 offset makes
// SharpGLTF's truncating byte encoder land on exactly that byte: floor((byte + 0.5) / 255 * 255) == byte.
static float SrgbVertexChannel(float value)
{
    if (!float.IsFinite(value)) return value;
    var linear = Math.Clamp(value, 0f, 1f);
    var srgb = linear <= 0.0031308f ? linear * 12.92f : 1.055f * MathF.Pow(linear, 1f / 2.4f) - 0.055f;
    return (MathF.Round(srgb * 255f, MidpointRounding.AwayFromZero) + 0.5f) / 255f;
}

// Alpha stays linear through ToFColor; only the RGB curve is applied.
static float LinearVertexChannel(float value)
{
    return float.IsFinite(value) ? (MathF.Round(Math.Clamp(value, 0f, 1f) * 255f, MidpointRounding.AwayFromZero) + 0.5f) / 255f : value;
}

// Editor source art is stored the way FTextureSource keeps it, not as a display image. A
// TSF_BGRA8 source PNG carries blue in its red channel: against UE Viewer's export of the same
// Megascans texture, the extracted PNG measured RMSE 0.066 as-is and 0.016 with red and blue
// swapped. TSF_RGBA16 source is linear light, so an sRGB-sampled one reads about four times too
// dark until it is encoded to sRGB. Anything else passes through unchanged.
static byte[] NormalizeSourcePng(byte[] png, UTexture? texture)
{
    if (texture is null) return png;
    // A JPEG source (TSCF_JPEG) is decoded to true colour by Skia, so it needs no channel fix-up.
    if (JpegDerived.Table.TryGetValue(png, out _)) return png;
    // Neither does one encoded from raw TSCF_UEDELTA pixels: it was written as RGBA in true colour.
    if (RawDerived.Table.TryGetValue(png, out _)) return png;
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
        // UE stores a block verbatim when compression did not shrink it (compressed size == raw
        // size); the block table holds the same size for both, and the decoder returns 0 bytes for
        // such a block. Incompressible source art (PNG) is mostly verbatim blocks, so a texture
        // whose payload has one never decoded.
        if (compressedSize == rawSize) payload.Data.AsSpan(inputOffset, rawSize).CopyTo(output.AsSpan(outputOffset, rawSize));
        else Compression.Decompress(payload.Data, inputOffset, compressedSize, output, outputOffset, rawSize, method);
        inputOffset += compressedSize;
        outputOffset += rawSize;
    }
    if (outputOffset != output.Length) throw new InvalidDataException("Editor payload is incomplete.");
    return output;
}

// A texture saved with TSCF_JPEG source compression keeps JPEG bytes (SOI FF D8 FF) in its editor payload. The
// largest decodable image wins; it is re-encoded as PNG so every later stage sees the format it already reads.
static byte[]? ExtractLargestJpegAsPng(byte[] bytes)
{
    byte[]? best = null;
    long bestArea = 0;
    for (var start = 0; start <= bytes.Length - 3; start++)
    {
        if (bytes[start] != 0xff || bytes[start + 1] != 0xd8 || bytes[start + 2] != 0xff) continue;
        try
        {
            using var bitmap = SkiaSharp.SKBitmap.Decode(bytes.AsSpan(start));
            if (bitmap is null) continue;
            var area = (long) bitmap.Width * bitmap.Height;
            if (area <= bestArea) continue;
            using var image = SkiaSharp.SKImage.FromBitmap(bitmap);
            using var encoded = image.Encode(SkiaSharp.SKEncodedImageFormat.Png, 100);
            if (encoded is null) continue;
            best = encoded.ToArray();
            bestArea = area;
        }
        catch (Exception error) when (error is not OutOfMemoryException)
        {
            // A false-positive marker inside compressed bytes; keep scanning.
        }
    }
    if (best is not null) JpegDerived.Table.Add(best, new object());
    return best;
}

static byte[]? ExtractLargestPng(byte[] bytes, IReadOnlyList<(long Start, long End)>? previews = null, List<string>? failures = null)
{
    ReadOnlySpan<byte> signature = [137, 80, 78, 71, 13, 10, 26, 10];
    byte[]? best = null;
    ulong bestArea = 0;
    for (var start = 0; start <= bytes.Length - signature.Length; start++)
    {
        if (!bytes.AsSpan(start, signature.Length).SequenceEqual(signature)) continue;
        // Only an image the package's thumbnail table registers is skipped (see RegisteredThumbnails).
        if (previews is not null && previews.Any(preview => start >= preview.Start && start < preview.End))
        {
            failures?.Add($"ignored the PNG at {start}: the package's thumbnail table registers it, so it is a preview, not source art");
            continue;
        }
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
    "5.8" => EGame.GAME_UE5_8,
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
    "4.25" => EGame.GAME_UE4_25,
    "4.24" => EGame.GAME_UE4_24,
    "4.23" => EGame.GAME_UE4_23,
    "4.22" => EGame.GAME_UE4_22,
    "4.21" => EGame.GAME_UE4_21,
    "4.20" => EGame.GAME_UE4_20,
    "4.19" => EGame.GAME_UE4_19,
    "4.18" => EGame.GAME_UE4_18,
    "4.17" => EGame.GAME_UE4_17,
    "4.16" => EGame.GAME_UE4_16,
    "4.15" => EGame.GAME_UE4_15,
    "4.14" => EGame.GAME_UE4_14,
    "4.13" => EGame.GAME_UE4_13,
    "4.12" => EGame.GAME_UE4_12,
    "4.11" => EGame.GAME_UE4_11,
    "4.10" => EGame.GAME_UE4_10,
    "4.9" => EGame.GAME_UE4_9,
    "4.8" => EGame.GAME_UE4_8,
    "4.7" => EGame.GAME_UE4_7,
    "4.6" => EGame.GAME_UE4_6,
    "4.5" => EGame.GAME_UE4_5,
    "4.4" => EGame.GAME_UE4_4,
    "4.3" => EGame.GAME_UE4_3,
    "4.2" => EGame.GAME_UE4_2,
    "4.1" => EGame.GAME_UE4_1,
    "4.0" => EGame.GAME_UE4_0,
    _ => throw new ArgumentException($"unsupported --engine version {version}")
};

// PRD-582 gameplay data. Every value is written in Unreal's own frame (centimetres, UE axes, FRotator
// degrees); src/unreal/gameplay-data.ts converts it to metres and glTF space. Keeping the conversion in
// TypeScript makes it unit-testable without compiling the converter.
static object GpVec(FVector value) => new[] { value.X, value.Y, value.Z };
static object GpRot(FRotator value) => new[] { value.Pitch, value.Yaw, value.Roll };
static string GpText(FName name) => name.IsNone ? "" : name.Text;

static object? GpShape(FKShapeElem shape)
{
    var result = new Dictionary<string, object?>();
    switch (shape)
    {
        case FKSphereElem sphere:
            result["type"] = "sphere"; result["center"] = GpVec(sphere.Center); result["radius"] = sphere.Radius; break;
        case FKBoxElem box:
            result["type"] = "box"; result["center"] = GpVec(box.Center); result["rotation"] = GpRot(box.Rotation);
            result["x"] = box.X; result["y"] = box.Y; result["z"] = box.Z; break;
        case FKSphylElem sphyl:
            result["type"] = "capsule"; result["center"] = GpVec(sphyl.Center); result["rotation"] = GpRot(sphyl.Rotation);
            result["radius"] = sphyl.Radius; result["length"] = sphyl.Length; break;
        case FKTaperedCapsuleElem tapered:
            // Keep both end radii: collapsing them to one radius loses the taper. The importer keeps
            // radius0 and radius1, and only uses radius (the larger) for a coarse single-radius consumer.
            result["type"] = "capsule"; result["center"] = GpVec(tapered.Center); result["rotation"] = GpRot(tapered.Rotation);
            result["radius"] = Math.Max(tapered.Radius0, tapered.Radius1); result["radius0"] = tapered.Radius0; result["radius1"] = tapered.Radius1;
            result["length"] = tapered.Length; break;
        case FKConvexElem convex:
            result["type"] = "convex"; result["center"] = GpVec(convex.Transform.Translation); result["rotation"] = GpRot(convex.Transform.Rotation.Rotator());
            // The hull's own local scale is preserved, so the importer applies it instead of dropping it.
            result["scale"] = GpVec(convex.Transform.Scale3D);
            result["vertices"] = convex.VertexData.Select(vertex => GpVec(vertex)).ToArray();
            result["indices"] = convex.IndexData; break;
        default:
            return null;
    }
    if (!shape.Name.IsNone) result["name"] = shape.Name.Text;
    return result;
}

static List<object> GpAggShapes(FKAggregateGeom? aggregate)
{
    var shapes = new List<object>();
    if (aggregate is null) return shapes;
    foreach (var sphere in aggregate.SphereElems) if (GpShape(sphere) is { } shape) shapes.Add(shape);
    foreach (var box in aggregate.BoxElems) if (GpShape(box) is { } shape) shapes.Add(shape);
    foreach (var sphyl in aggregate.SphylElems) if (GpShape(sphyl) is { } shape) shapes.Add(shape);
    foreach (var convex in aggregate.ConvexElems) if (GpShape(convex) is { } shape) shapes.Add(shape);
    foreach (var tapered in aggregate.TaperedCapsuleElems) if (GpShape(tapered) is { } shape) shapes.Add(shape);
    return shapes;
}

static object GpCollision(UBodySetup setup)
{
    var profile = setup.GetOrDefault<FName>("CollisionProfileName");
    var result = new Dictionary<string, object?>
    {
        ["traceFlag"] = setup.GetOrDefault<ECollisionTraceFlag>("CollisionTraceFlag").ToString(),
        ["shapes"] = GpAggShapes(setup.AggGeom),
    };
    if (!profile.IsNone && !string.IsNullOrEmpty(profile.Text)) result["profile"] = profile.Text;
    return result;
}

static object GpFrame(FVector location, FVector primary, FVector secondary) => new Dictionary<string, object?>
{
    ["location"] = GpVec(location), ["primaryAxis"] = GpVec(primary), ["secondaryAxis"] = GpVec(secondary),
};

static object? GpDamping(USkeletalBodySetup body)
{
    if (!body.TryGetValue<FStructFallback>(out var instance, "DefaultInstance") || instance is null) return null;
    return new Dictionary<string, object?>
    {
        ["linear"] = instance.GetOrDefault<float>("LinearDamping"),
        ["angular"] = instance.GetOrDefault<float>("AngularDamping"),
    };
}

static object GpDrive(FConstraintDrive drive) => new Dictionary<string, object?>
{
    ["stiffness"] = drive.Stiffness,
    ["damping"] = drive.Damping,
    ["maxForce"] = drive.MaxForce,
    ["positionDrive"] = drive.bEnablePositionDrive,
    ["velocityDrive"] = drive.bEnableVelocityDrive,
};

static object GpDrives(FConstraintProfileProperties profile)
{
    var linear = profile.LinearDrive;
    var angular = profile.AngularDrive;
    return new Dictionary<string, object?>
    {
        ["linear"] = new Dictionary<string, object?>
        {
            ["positionTarget"] = GpVec(linear.PositionTarget),
            ["velocityTarget"] = GpVec(linear.VelocityTarget),
            ["x"] = GpDrive(linear.XDrive), ["y"] = GpDrive(linear.YDrive), ["z"] = GpDrive(linear.ZDrive),
        },
        ["angular"] = new Dictionary<string, object?>
        {
            ["orientationTarget"] = GpRot(angular.OrientationTarget),
            ["angularVelocityTarget"] = GpVec(angular.AngularVelocityTarget),
            ["swing"] = GpDrive(angular.SwingDrive), ["twist"] = GpDrive(angular.TwistDrive), ["slerp"] = GpDrive(angular.SlerpDrive),
            ["mode"] = angular.AngularDriveMode.ToString(),
        },
    };
}

static object GpPhysics(UPhysicsAsset asset)
{
    var bodies = new List<object>();
    var missingBodies = 0;
    foreach (var index in asset.SkeletalBodySetups)
    {
        if (index?.Load<USkeletalBodySetup>() is not { } body) { missingBodies++; continue; }
        var entry = new Dictionary<string, object?>
        {
            ["bone"] = GpText(body.BoneName),
            ["physicsType"] = body.PhysicsType.ToString(),
            ["traceFlag"] = body.CollisionTraceFlag.ToString(),
            ["shapes"] = GpAggShapes(body.AggGeom),
        };
        if (GpDamping(body) is { } damping) entry["damping"] = damping;
        bodies.Add(entry);
    }
    var constraints = new List<object>();
    var missingConstraints = 0;
    foreach (var index in asset.ConstraintSetup)
    {
        if (index?.Load<UPhysicsConstraintTemplate>() is not { } template) { missingConstraints++; continue; }
        var instance = template.DefaultInstance;
        var profile = instance.ProfileInstance;
        constraints.Add(new Dictionary<string, object?>
        {
            ["child"] = GpText(instance.ConstraintBone1),
            ["parent"] = GpText(instance.ConstraintBone2),
            ["childFrame"] = GpFrame(instance.Pos1, instance.PriAxis1, instance.SecAxis1),
            ["parentFrame"] = GpFrame(instance.Pos2, instance.PriAxis2, instance.SecAxis2),
            ["swing1Deg"] = profile.ConeLimit.Swing1LimitDegrees,
            ["swing2Deg"] = profile.ConeLimit.Swing2LimitDegrees,
            ["twistDeg"] = profile.TwistLimit.TwistLimitDegrees,
            ["linearLimit"] = profile.LinearLimit.Limit,
            ["motions"] = new Dictionary<string, object?>
            {
                ["linear"] = new[] { profile.LinearLimit.XMotion.ToString(), profile.LinearLimit.YMotion.ToString(), profile.LinearLimit.ZMotion.ToString() },
                ["swing1"] = profile.ConeLimit.Swing1Motion.ToString(),
                ["swing2"] = profile.ConeLimit.Swing2Motion.ToString(),
                ["twist"] = profile.TwistLimit.TwistMotion.ToString(),
            },
            ["drives"] = GpDrives(profile),
            ["disableCollision"] = profile.bDisableCollision,
        });
    }
    var disabled = new List<object>();
    foreach (var pair in asset.CollisionDisableTable ?? new Dictionary<FRigidBodyIndexPair, bool>())
        if (pair.Value) disabled.Add(new[] { pair.Key.Indices[0], pair.Key.Indices[1] });
    return new Dictionary<string, object?>
    {
        ["asset"] = asset.Name, ["bodies"] = bodies, ["constraints"] = constraints,
        ["collisionDisabledPairs"] = disabled, ["missingBodies"] = missingBodies, ["missingConstraints"] = missingConstraints,
    };
}

static object GpSocket(USkeletalMeshSocket socket, string source) => new Dictionary<string, object?>
{
    ["name"] = GpText(socket.SocketName), ["bone"] = GpText(socket.BoneName), ["source"] = source,
    ["location"] = GpVec(socket.RelativeLocation), ["rotation"] = GpRot(socket.RelativeRotation), ["scale"] = GpVec(socket.RelativeScale),
};

static object GpStaticSocket(UStaticMeshSocket socket)
{
    var result = new Dictionary<string, object?>
    {
        ["name"] = GpText(socket.SocketName),
        ["location"] = GpVec(socket.RelativeLocation), ["rotation"] = GpRot(socket.RelativeRotation), ["scale"] = GpVec(socket.RelativeScale),
    };
    if (!string.IsNullOrEmpty(socket.Tag)) result["tag"] = socket.Tag;
    return result;
}

static object GpCueNode(UObject node, int depth)
{
    var result = new Dictionary<string, object?> { ["type"] = node.ExportType };
    var parameters = new Dictionary<string, object?>();
    switch (node)
    {
        // A UE5 editor SoundCue stores the wave as a soft path; the native SoundWave FPackageIndex CUE4Parse reads
        // is bogus on those assets, so only SoundWaveAssetPtr is used here.
        case USoundNodeWavePlayer player:
            if (!string.IsNullOrEmpty(player.SoundWaveAssetPtr.AssetPathName.Text)) parameters["wave"] = player.SoundWaveAssetPtr.AssetPathName.Text;
            break;
        case USoundNodeSwitch soundSwitch:
            parameters["intParameterName"] = GpText(soundSwitch.GetOrDefault<FName>("IntParameterName")); break;
        case USoundNodeBranch branch:
            parameters["boolParameterName"] = GpText(branch.GetOrDefault<FName>("BoolParameterName")); break;
        case USoundNodeParamCrossFade crossFade:
            parameters["paramName"] = GpText(crossFade.GetOrDefault<FName>("ParamName")); break;
        case USoundNodeMixer mixer:
            parameters["inputVolume"] = mixer.InputVolume; break;
        case USoundNodeRandom random:
            parameters["weights"] = random.Weights; break;
    }
    if (parameters.Count > 0) result["params"] = parameters;
    if (node is USoundNode soundNode && depth < 256)
    {
        var children = new List<object>();
        foreach (var child in soundNode.ChildNodes ?? Array.Empty<FPackageIndex>())
            if (child?.Load<UObject>() is { } loaded) children.Add(GpCueNode(loaded, depth + 1));
        if (children.Count > 0) result["children"] = children;
    }
    return result;
}

static object GpCue(USoundCue cue)
{
    var result = new Dictionary<string, object?>
    {
        ["name"] = cue.Name,
        ["volume"] = cue.VolumeMultiplier,
        ["pitch"] = cue.PitchMultiplier,
        ["root"] = cue.FirstNode?.Load<UObject>() is { } first ? GpCueNode(first, 0) : null,
    };
    var attenuation = new Dictionary<string, object?>();
    if (cue.TryGetValue<FPackageIndex>(out var settings, "AttenuationSettings") && settings is { IsNull: false } && !string.IsNullOrEmpty(settings.Name))
        attenuation["asset"] = settings.Name;
    if (cue.GetOrDefault<bool>("bOverrideAttenuation")) attenuation["overridden"] = true;
    if (attenuation.Count > 0) result["attenuation"] = attenuation;
    return result;
}

// The provider key relative to the mount, without its package extension: the same selector the importer
// uses (entry.selector), so Gameplay/<selector>.json maps back to the package it came from.
string GameplaySelector(string key)
{
    var normalized = key.Replace('\\', '/');
    var mount = new DirectoryInfo(root).Name + "/";
    var relative = normalized.StartsWith(mount, StringComparison.Ordinal) ? normalized[mount.Length..] : normalized;
    if (relative.EndsWith(".uasset", StringComparison.OrdinalIgnoreCase)) return relative[..^".uasset".Length];
    if (relative.EndsWith(".umap", StringComparison.OrdinalIgnoreCase)) return relative[..^".umap".Length];
    return relative;
}

// The instance's own overrides, written as .props.txt blocks. A row is written only when CUE4Parse read it whole: a tagged row must
// carry the tags it needs, and a binary row must come from a material whose read raised no logged failure. Presence is the tag
// list: a missing tag is never read as 0, false or a default colour. The typed views of a tagged set are not used: GetParams
// flattens the parent's values into the instance, and GetOrDefault cannot tell an absent field from a zero one.


public sealed class PackageReadFailureSink(Dictionary<string, string> failures) : Serilog.Core.ILogEventSink
{
    public void Emit(Serilog.Events.LogEvent logEvent)
    {
        if (logEvent.Exception is null) return;
        var match = System.Text.RegularExpressions.Regex.Match(logEvent.RenderMessage(), "^Could not read \"?(?<type>[^\"]+?)\"? named \"?(?<name>[^\"]+?)\"? correctly$");
        if (!match.Success) return;
        var root = logEvent.Exception;
        while (root.InnerException is not null) root = root.InnerException;
        var first = (root.Message.Split('\n')[0]).Trim();
        failures.TryAdd(match.Groups["name"].Value, $"{match.Groups["type"].Value} {root.GetType().Name}: {first}");
    }
}

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


public static class MaterialOverrides
{
    public sealed class Refusal(string message) : Exception(message);

    // A parameter as the blocks name it. Association and Index are null when the source did not hold them; Guid is null when zero.
    sealed record ParameterIdentity(string Name, string? Association, int? Index, string? Guid);

    // A switch row. A row that does not override (Enabled false) writes nothing and inherits the parent's value.
    readonly record struct SwitchRow(ParameterIdentity Identity, bool Enabled, bool Value);

    // The instance's own TextureParameterValues, by qualified package and object: Blocks does not write them. The declared tagged
    // collection is the only source. Its ParameterInfo carries the association and index that the typed array's flattened Name drops,
    // so a typed row is never admitted: with no declared tag it cannot prove its identity. A declared collection that cannot be read
    // refuses, and so does a read that did not complete for the material, since its rows then cannot be taken as the whole set. A row's
    // identity is admitted as Blocks admits a global one, and its block writes that identity. An authored null texture refuses, since
    // inheriting the parent's texture for it is not source-proven. qualify gives the package path of a texture reference, or null.
    public static string Textures(UMaterialInstanceConstant instance, string material, IReadOnlyDictionary<string, string> readFailures, Func<FPackageIndex, string?> qualify)
    {
        // Null for an absent collection the read completed for; an absent one the read did not complete for refuses inside Rows.
        var rows = Rows(instance, "TextureParameterValues", material, readFailures);
        if (rows is null)
        {
            if (instance.TextureParameterValues.Length > 0)
                throw new Refusal("TextureParameterValues has typed rows but no declared tag, so their association and index are not proven");
            return "";
        }
        if (readFailures.TryGetValue(material, out var failure))
            throw new Refusal($"TextureParameterValues is present, but the material did not read completely ({failure}), so its rows cannot be taken as the whole set");
        var text = new StringBuilder();
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var index = 0;
        foreach (var row in rows)
        {
            var identity = Claim(TaggedIdentity(row, "TextureParameterValues"), "TextureParameterValues", names);
            var value = Required<FPackageIndex>(row, "ParameterValue", "TextureParameterValues");
            if (value is null) throw new Refusal($"TextureParameterValues row '{identity.Name}' has a ParameterValue that cannot be read");
            if (value.IsNull) throw new Refusal($"TextureParameterValues row '{identity.Name}' is an authored null texture, and inheriting the parent's texture for it is not source-proven");
            var package = value.Name == "None" ? null : qualify(value);
            if (package is null) throw new Refusal($"TextureParameterValues row '{identity.Name}' does not name a qualified texture, so the instance's texture is not known");
            Block(text, "TextureParameterValues", index++, [$"    ParameterValue = Texture2D'{package}.{value.Name}'", .. Lines(identity)]);
        }
        return text.ToString();
    }

    // Everything is read before any text is returned, so a refused material leaves the caller nothing to write.
    public static string Blocks(UMaterialInstance instance, string material, IReadOnlyDictionary<string, string> readFailures)
    {
        var scalars = Rows(instance, "ScalarParameterValues", material, readFailures) ?? Array.Empty<FStructFallback>();
        var vectors = Rows(instance, "VectorParameterValues", material, readFailures) ?? Array.Empty<FStructFallback>();
        var switches = SwitchRows(instance, material, readFailures);
        var text = new StringBuilder();

        var scalarNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var index = 0;
        foreach (var row in scalars)
        {
            var identity = Claim(TaggedIdentity(row, "ScalarParameterValues"), "ScalarParameterValues", scalarNames);
            var value = Required<float>(row, "ParameterValue", "ScalarParameterValues");
            if (!float.IsFinite(value)) throw new Refusal($"ScalarParameterValues row '{identity.Name}' has a non-finite ParameterValue");
            Block(text, "ScalarParameterValues", index++, [$"    ParameterValue = {Number(value)}", .. Lines(identity)]);
        }

        var vectorNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        index = 0;
        foreach (var row in vectors)
        {
            var identity = Claim(TaggedIdentity(row, "VectorParameterValues"), "VectorParameterValues", vectorNames);
            var color = Required<FLinearColor>(row, "ParameterValue", "VectorParameterValues");
            if (!float.IsFinite(color.R) || !float.IsFinite(color.G) || !float.IsFinite(color.B) || !float.IsFinite(color.A))
                throw new Refusal($"VectorParameterValues row '{identity.Name}' has a non-finite channel");
            var value = $"{{R={Number(color.R)},G={Number(color.G)},B={Number(color.B)},A={Number(color.A)}}}";
            Block(text, "VectorParameterValues", index++, [$"    ParameterValue = {value}", .. Lines(identity)]);
        }

        // Every row claims its identity, enabled or not, so a disabled row cannot share a name with an override.
        var switchNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        index = 0;
        foreach (var row in switches)
        {
            Claim(row.Identity, "StaticSwitchParameters", switchNames);
            // bOverride = false inherits the parent's value, so the row writes nothing.
            if (!row.Enabled) continue;
            Block(text, "StaticSwitchParameters", index++, [$"    Value = {(row.Value ? "true" : "false")}", "    bOverride = true", .. Lines(row.Identity)]);
        }
        return text.ToString();
    }

    // The switch rows the instance overrides with. A tagged set (StaticParameters, else its runtime copy) is read tag by tag, so its
    // presence is the evidence. A binary set carries no tags, and a read that stopped early leaves a short list that looks whole, so
    // it is trusted only when the material's read raised no logged failure.
    static List<SwitchRow> SwitchRows(UMaterialInstance instance, string material, IReadOnlyDictionary<string, string> readFailures)
    {
        var field = Has(instance, "StaticParameters") ? "StaticParameters" : Has(instance, "StaticParametersRuntime") ? "StaticParametersRuntime" : null;
        if (field is not null)
        {
            if (!instance.TryGetValue<FStructFallback>(out var set, field)) throw new Refusal($"{field} is present but cannot be read");
            return (Rows(set, "StaticSwitchParameters", material, readFailures) ?? Array.Empty<FStructFallback>()).Select(TaggedSwitch).ToList();
        }
        if (readFailures.TryGetValue(material, out var failure))
            throw new Refusal($"its static switches are read from the binary StaticParameters, and the material did not read completely ({failure})");
        return (instance.StaticParameters?.StaticSwitchParameters ?? Array.Empty<FStaticSwitchParameter>()).Select(BinarySwitch).ToList();
    }

    static SwitchRow TaggedSwitch(FStructFallback row)
    {
        var identity = TaggedIdentity(row, "StaticSwitchParameters");
        var enabled = Required<bool>(row, "bOverride", "StaticSwitchParameters");
        // A row that inherits needs no value, so its Value tag is required only when it overrides.
        return new SwitchRow(identity, enabled, enabled && Required<bool>(row, "Value", "StaticSwitchParameters"));
    }

    // A row CUE4Parse read from the binary archive. The archive reads a bare name and sets the index to -1, and the parameterless
    // FMaterialParameterInfo it runs on sets the association to global. Layer parameters did not exist in this format.
    static SwitchRow BinarySwitch(FStaticSwitchParameter row)
    {
        if (row is null) throw new Refusal("StaticSwitchParameters has a row that could not be read");
        var info = row.ParameterInfo ?? throw new Refusal("StaticSwitchParameters row has no ParameterInfo, so its name is not known");
        if (info.Association != EMaterialParameterAssociation.GlobalParameter)
            throw new Refusal($"StaticSwitchParameters row is a {info.Association} parameter, and only global parameters are supported");
        if (info.Index != -1) throw new Refusal("StaticSwitchParameters row has a layer index, which only layer parameters use");
        var identity = new ParameterIdentity(Admit(info.Name.Text ?? "", "StaticSwitchParameters"), info.Association.ToString(), info.Index, ExpressionGuid(row.ExpressionGuid));
        return new SwitchRow(identity, row.bOverride, row.Value);
    }

    // The parameter a tagged row overrides. The association is required: an absent one would read as the enum's first member, a layer.
    // The index and the expression GUID are written only when their tags hold them, never as defaults.
    static ParameterIdentity TaggedIdentity(FStructFallback row, string owner)
    {
        if (row is null) throw new Refusal($"{owner} has a row that could not be read");
        string name;
        string? association = null;
        int? index = null;
        if (Has(row, "ParameterInfo"))
        {
            var info = Required<FStructFallback>(row, "ParameterInfo", owner);
            var value = Required<EMaterialParameterAssociation>(info, "Association", owner);
            if (value != EMaterialParameterAssociation.GlobalParameter)
                throw new Refusal($"{owner} row is a {value} parameter, and only global parameters are supported");
            if (Has(info, "Index"))
            {
                index = Required<int>(info, "Index", owner);
                if (index != -1) throw new Refusal($"{owner} row has a layer index, which only layer parameters use");
            }
            association = value.ToString();
            name = Required<FName>(info, "Name", owner).Text ?? "";
        }
        else
        {
            // Legacy rows predate layer parameters and name the parameter directly, so they carry no association or index to write.
            name = Required<FName>(row, "ParameterName", owner).Text ?? "";
        }
        var guid = Has(row, "ExpressionGUID") ? ExpressionGuid(Required<FGuid>(row, "ExpressionGUID", owner)) : null;
        return new ParameterIdentity(Admit(name, owner), association, index, guid);
    }

    static string Admit(string name, string owner)
    {
        if (name is "" or "None" || name != name.Trim() || name.IndexOfAny(new[] { '{', '}', '\r', '\n' }) >= 0)
            throw new Refusal($"{owner} row names '{name}', which the .props.txt blocks cannot carry");
        return name;
    }

    // Rows claim a parameter by its identity: name, association and index. Two claims on one identity are a collision.
    static ParameterIdentity Claim(ParameterIdentity identity, string owner, HashSet<string> claimed)
    {
        if (!claimed.Add($"{identity.Association}|{identity.Index}|{identity.Name}"))
            throw new Refusal($"{owner} has two rows named '{identity.Name}', so their identity collides");
        return identity;
    }

    // An absent GUID reads as zero, which is also how a binary row without one reads, so a zero GUID is left out rather than written.
    static string? ExpressionGuid(FGuid guid) =>
        guid.A == 0 && guid.B == 0 && guid.C == 0 && guid.D == 0 ? null : guid.ToString();

    // The parameter's own block fields. Only what the source held is written: an absent index or GUID is not invented.
    static IEnumerable<string> Lines(ParameterIdentity identity)
    {
        yield return "    ParameterInfo =";
        yield return "    {";
        yield return $"        Name = {identity.Name}";
        if (identity.Association is not null) yield return $"        Association = {identity.Association}";
        if (identity.Index is not null) yield return $"        Index = {identity.Index}";
        yield return "    }";
        if (identity.Guid is not null) yield return $"    ExpressionGUID = {identity.Guid}";
    }

    // Present is the array, empty included. Absent means no override only when the read completed. The only completion evidence
    // read here is CUE4Parse's logged read failure for this export, keyed by its name; a list cut short without a logged failure
    // cannot be detected from the converter.
    static FStructFallback[]? Rows(AbstractPropertyHolder holder, string field, string material, IReadOnlyDictionary<string, string> readFailures)
    {
        if (Has(holder, field))
        {
            if (holder.TryGetValue<FStructFallback[]>(out var rows, field)) return rows ?? Array.Empty<FStructFallback>();
            throw new Refusal($"{field} is present but its rows cannot be read");
        }
        if (readFailures.TryGetValue(material, out var failure))
            throw new Refusal($"{field} is absent and the material did not read completely ({failure})");
        return null;
    }

    static bool Has(AbstractPropertyHolder holder, string field) => holder.Properties.Any(tag => tag.Name.Text == field);

    static T Required<T>(AbstractPropertyHolder holder, string field, string owner)
    {
        if (!Has(holder, field)) throw new Refusal($"{owner} row has no {field} tag, so its value is not known");
        if (!holder.TryGetValue<T>(out var value, field)) throw new Refusal($"{owner} row's {field} tag cannot be read as {typeof(T).Name}");
        return value;
    }

    static void Block(StringBuilder text, string collection, int index, IEnumerable<string> fields)
    {
        text.AppendLine($"{collection}[{index}] =");
        text.AppendLine("{");
        foreach (var field in fields) text.AppendLine(field);
        text.AppendLine("}");
    }

    static string Number(float value) => value.ToString("R", System.Globalization.CultureInfo.InvariantCulture);
}

// PNGs that were re-encoded from a JPEG source payload, by reference, so NormalizeSourcePng can tell them apart.
static class JpegDerived
{
    public static readonly System.Runtime.CompilerServices.ConditionalWeakTable<byte[], object> Table = new();
}
// PNGs encoded here from raw source pixels (TSCF_UEDELTA), already in true RGBA colour.
static class RawDerived
{
    public static readonly System.Runtime.CompilerServices.ConditionalWeakTable<byte[], object> Table = new();
}
sealed record GraphLegacyInput(FPackageIndex? Expression, int Output, int[]? Mask, object? Constant, bool UseConstant);
sealed record EditorMesh(
    float[] Positions,
    int[] InstanceVertices,
    float[] Normals,
    (int Channel, float[] Values)[] UvChannels,
    float[] VertexColors,
    int[] TriangleInstances,
    int[] TriangleGroups,
    bool[] LiveTriangles,
    string[] GroupSlots);
sealed record Rgba16fSourceArt(string Format, int SizeX, int SizeY, int NumSlices, int NumMips, bool PngCompressed, string? Compression, bool Srgb, long ElementCount, byte[]? Bytes);
sealed record Rgba16fDataTexture(int Width, int Height, byte[] Bytes);
sealed record Rgba16fPackage(string Key, string PackageKey, Dictionary<string, string> Sidecars);

// Packed glTF vertices are equal when every component is equal under float.Equals, so -0 matches 0 and NaN matches
// NaN: the equality the MeshBuilder this writer replaces used. Every present UV channel is a component of the key, so
// vertices that differ only in a later channel stay apart.
sealed class EditorVertexComparer : IEqualityComparer<float[]>
{
    public bool Equals(float[]? left, float[]? right) => left!.AsSpan().SequenceEqual(right!.AsSpan());

    public int GetHashCode(float[] vertex)
    {
        var hash = new HashCode();
        foreach (var component in vertex) hash.Add(component);
        return hash.ToHashCode();
    }
}
`;
