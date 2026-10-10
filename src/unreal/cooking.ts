import { open } from "node:fs/promises";

/** Unreal's package magic, `0x9E2A83C1`, little-endian at offset 0 of every `.uasset`/`.umap`. */
const PACKAGE_MAGIC = 0x9e2a83c1;

/** How much of a package's head to read. The name and import tables sit near the front, well inside
 * this window even for a large mesh; reading the whole file would mean paging gigabytes of texture
 * bulk data to answer a question the header already settles. */
const PREFIX_BYTES = 512 * 1024;

/** Names that exist only in an uncooked editor package. Cooking strips editor-only imports and
 * properties, so a cooked package never carries them — which makes their presence a high-precision
 * signal, and their absence no evidence either way. `SourceModels` is the StaticMesh's editable
 * source geometry, `AssetImportData` the record of the FBX it was imported from, and
 * `/Script/UnrealEd` an import of the editor module itself. */
const EDITOR_ONLY_MARKERS = Object.freeze([
  "/Script/UnrealEd",
  "AssetImportData",
  "SourceModels",
  "RawMeshBulkData",
  "MeshDescriptionBulkData",
]);

/** `uncooked` means UE Viewer cannot export this package's geometry, because the renderable vertex
 * and index buffers are not in the file at all — the editor derives them from the source mesh
 * through its derived-data cache. `unknown` is the honest answer everywhere else: this reads a
 * positive signal, never a negative one, so it never claims a package is cooked. */
export type CookingState = "uncooked" | "unknown";

export interface PackageCooking {
  readonly state: CookingState;
  /** Legacy package summary version. UE5 editor packages use negative values such as `-8`. */
  readonly legacyFileVersion: number | undefined;
  /** UE4 package object version from the file header; undefined for non-packages/truncated input. */
  readonly fileVersionUE4: number | undefined;
  /** UE5 package object version, which is the only version UE5-only packages can have. */
  readonly fileVersionUE5: number | undefined;
  /** Whether the name table names NaniteSettings, the marker of a Nanite mesh. */
  readonly naniteHint: boolean;
  /** The editor-only names actually found, so a caller can report evidence rather than a verdict. */
  readonly markers: readonly string[];
  /** High-confidence mesh class hint used only when UE Viewer cannot parse a newer header. */
  readonly meshKindHint: "static" | "skeletal" | undefined;
  /** High-confidence Texture2D hint used only when UE Viewer cannot parse a newer header. */
  readonly textureHint: boolean;
  /**
   * The texture's `MipGenSettings` is `TMGS_NoMipmaps`: the editor builds no mip chain for it. A tagged enum value is a name
   * in the name table (a default is never written), so the whole entry is positive evidence. Foliage packs set it on the
   * packed `_AORO` opacity map so thin cut-outs keep their coverage at a distance.
   */
  readonly noMipmapsHint: boolean;
  /** High-confidence TextureCube hint used only when UE Viewer cannot parse a newer header. */
  readonly cubemapHint: boolean;
  /** High-confidence SoundWave hint used only when UE Viewer cannot parse a newer header. */
  readonly soundHint: boolean;
  /** High-confidence structured-data class hint used only when UE Viewer cannot parse UE5 headers. */
  readonly dataClassHint: string | undefined;
  /** High-confidence multidimensional texture class hint for headers UE Viewer rejects. */
  readonly textureStackClassHint: string | undefined;
  /** High-confidence Font/FontFace hint used when UE Viewer rejects a versionless package. */
  readonly fontHint: boolean;
  /** High-confidence Material/MaterialInstance hint used when UE Viewer rejects a newer header. */
  readonly materialHint: boolean;
  /** High-confidence Level hint for `.umap` packages UE Viewer cannot list. */
  readonly levelHint: boolean;
  /** A whole name-table entry naming the GroomAsset class, which only a hair package carries. */
  readonly groomHint: boolean;
  /** Serialized BlueprintGeneratedClass/SCS prefab hint for newer headers UE Viewer rejects. */
  readonly blueprintPrefabHint: boolean;
  /** An editor-only class with nothing to import, named when UE Viewer cannot list the package. */
  readonly nonImportableClassHint: string | undefined;
  /**
   * The package holds an `HLODProxy`: the editor's generated hierarchical-LOD stand-ins for a level (merged, reduced
   * copies of the level's own meshes with a flattened material), built output rather than an authored asset.
   */
  readonly hlodProxyHint: boolean;
}

/** Editor-only asset classes a UE5 pack ships beside its meshes. UE Viewer cannot list them, so
 * without this they read as failed packages rather than as content with nothing to import. */
const NON_IMPORTABLE_CLASSES = ["FoliageType_InstancedStaticMesh", "MaterialFunction", "MaterialParameterCollection"];

/** What a file that is not a readable package reports: no signal, never a negative one. */
const UNKNOWN: PackageCooking = Object.freeze({
  state: "unknown",
  markers: [],
  legacyFileVersion: undefined,
  fileVersionUE4: undefined,
  fileVersionUE5: undefined,
  naniteHint: false,
  meshKindHint: undefined,
  textureHint: false,
  noMipmapsHint: false,
  cubemapHint: false,
  soundHint: false,
  dataClassHint: undefined,
  textureStackClassHint: undefined,
  fontHint: false,
  materialHint: false,
  levelHint: false,
  groomHint: false,
  blueprintPrefabHint: false,
  nonImportableClassHint: undefined,
  hlodProxyHint: false,
});

/** Reads the bounded prefix of one package, or undefined when it cannot be read. */
async function readHead(file: string): Promise<Buffer | undefined> {
  let handle;
  try {
    handle = await open(file, "r");
  } catch {
    return undefined;
  }
  try {
    const buffer = Buffer.alloc(PREFIX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, PREFIX_BYTES, 0);
    return bytesRead >= 16 ? buffer.subarray(0, bytesRead) : undefined;
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

/** Object names a package names in the name and import tables at its head: the packages it
 * references, such as a static mesh's materials and textures. Those are separate files on disk. */
export async function readPackageObjectNames(file: string): Promise<Set<string>> {
  const head = await readHead(file);
  const names = new Set<string>();
  if (!head) return names;
  for (const match of head.toString("latin1").matchAll(/[\x20-\x7e]{4,}/g)) {
    for (const token of match[0].split(/[^\w]+/)) {
      if (token.length >= 4 && token.length <= 200) names.add(token);
    }
  }
  return names;
}

/** Reads a bounded prefix of one Unreal package and reports whether it is uncooked editor source.
 *
 * This exists because the failure it detects is otherwise invisible until far too late: `umodel
 * -list` happily reports `StaticMesh` for an uncooked package, so classification passes, and only
 * the export produces nothing — after the whole pack has been downloaded and every package walked.
 * A Fab marketplace pack is Unreal *source*, so this is the common case, not the exotic one. */
export async function readPackageCooking(file: string): Promise<PackageCooking> {
  const head = await readHead(file);
  if (!head || head.readUInt32LE(0) !== PACKAGE_MAGIC) return UNKNOWN;
  // Names are stored as length-prefixed ASCII, so a byte search finds them without walking the
  // name table — whose layout varies by engine version in ways this check must not depend on.
  const markers = EDITOR_ONLY_MARKERS.filter((marker) => head.includes(marker, 0, "latin1"));
  const legacyFileVersion = head.readInt32LE(4);
  const hasSkeletalClass = head.includes("SkeletalMesh", 0, "latin1");
  const hasSkeletalEditorData =
    head.includes("SkeletalMeshEditorData", 0, "latin1") ||
    head.includes("MeshEditorDataObject", 0, "latin1") ||
    // UE 5.5+ keeps skeletal source geometry in these instead (MetaHuman face meshes).
    head.includes("SkeletalMeshSourceModel", 0, "latin1");
  const hasStaticClass = head.includes("StaticMesh", 0, "latin1");
  const hasDefaultSkeletalClass = head.includes("Default__SkeletalMesh", 0, "latin1");
  const hasDefaultStaticClass = head.includes("Default__StaticMesh", 0, "latin1");
  const hasTextureClass = head.includes("Texture2D", 0, "latin1");
  const hasCubemapClass = head.includes("TextureCube", 0, "latin1");
  const hasSoundClass = head.includes("SoundWave", 0, "latin1");
  const dataClassHint = ["DataTable", "CurveTable", "StringTable", "CurveFloat", "CurveVector", "CurveLinearColor"]
    .find((className) => head.includes(`Default__${className}`, 0, "latin1"));
  const textureStackClassHint = ["Texture2DArray", "TextureCubeArray", "VolumeTexture"]
    .find((className) => head.includes(`Default__${className}`, 0, "latin1"));
  const fontHint = head.includes("Default__FontFace", 0, "latin1") ||
    (head.includes("FontBulkData", 0, "latin1") && head.includes("CompositeFont", 0, "latin1"));
  const materialHint = head.includes("MaterialEditorOnlyData", 0, "latin1") ||
    (head.includes("MaterialInstanceBasePropertyOverrides", 0, "latin1") && head.includes("MaterialInstanceConstant", 0, "latin1"));
  const levelHint = file.toLowerCase().endsWith(".umap") &&
    head.includes("PersistentLevel", 0, "latin1") && head.includes("WorldSettings", 0, "latin1");
  // A whole name-table entry, like nonImportableClassHint: the cards mesh a groom renders with is a
  // StaticMesh package and names no GroomAsset.
  const groomHint = file.toLowerCase().endsWith(".uasset") && head.includes("\0GroomAsset\0", 0, "latin1");
  // A whole name-table entry: the length prefix's high byte and the NUL terminator bracket it,
  // so "MaterialFunction" does not match inside "MaterialFunctionInstance".
  const nonImportableClassHint = NON_IMPORTABLE_CLASSES.find((className) => head.includes(`\0${className}\0`, 0, "latin1"));
  const blueprintPrefabHint = file.toLowerCase().endsWith(".uasset") &&
    head.includes("BlueprintGeneratedClass", 0, "latin1") && head.includes("SimpleConstructionScript", 0, "latin1");
  return {
    state: markers.length > 0 ? "uncooked" : "unknown",
    markers,
    legacyFileVersion,
    fileVersionUE4: head.readInt32LE(12),
    // A UE4 header carries no UE5 version at this offset: it holds FileVersionLicenseeUE4, which is
    // a licensee build number. Only a negative legacy version marks the UE5 header layout.
    fileVersionUE5: legacyFileVersion <= -8 ? head.readInt32LE(16) : undefined,
    naniteHint: head.includes("NaniteSettings", 0, "latin1"),
    meshKindHint:
      hasSkeletalClass && (hasSkeletalEditorData || (legacyFileVersion <= -8 && hasDefaultSkeletalClass))
        ? "skeletal"
        : hasStaticClass &&
            (markers.some((marker) => marker === "SourceModels" || marker === "MeshDescriptionBulkData") ||
              (legacyFileVersion <= -8 && hasDefaultStaticClass))
          ? "static"
          : undefined,
    // A generated editor texture (MetaHuman Creator bakes) keeps TextureSource with no import data.
    textureHint:
      hasTextureClass &&
      (markers.includes("AssetImportData") || head.includes("\0TextureSource\0", 0, "latin1")),
    noMipmapsHint: hasTextureClass && head.includes("\0TMGS_NoMipmaps\0", 0, "latin1"),
    cubemapHint: hasCubemapClass && markers.includes("AssetImportData"),
    soundHint: hasSoundClass && markers.includes("AssetImportData"),
    dataClassHint,
    textureStackClassHint,
    fontHint,
    materialHint,
    levelHint,
    groomHint,
    blueprintPrefabHint,
    nonImportableClassHint,
    hlodProxyHint: head.includes("\0HLODProxy\0", 0, "latin1"),
  };
}
