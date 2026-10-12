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
export async function readPackageHead(file: string): Promise<Buffer | undefined> {
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

/**
 * The candidate class names whose `\0Class\0` name-table entry appears in a package's bounded head.
 * The length prefix and terminator bracket the entry, so `AnimMontage` does not match inside a longer
 * name. Membership proves the class is named in the package: it is evidence of presence, never of how
 * many objects of that class the package exports.
 */
export function classesInHead(head: Buffer, candidates: readonly string[]): string[] {
  const text = head.toString("latin1");
  return candidates.filter((className) => text.includes(`\0${className}\0`));
}

export async function readPackageClasses(file: string, candidates: readonly string[]): Promise<string[]> {
  const head = await readPackageHead(file);
  return head ? classesInHead(head, candidates) : [];
}

const GAME_PREFIX = "/Game/";
/** The two byte encodings Unreal writes a string in, so the raw header can be searched for a start. */
const GAME_PREFIX_UTF8 = Buffer.from(GAME_PREFIX, "utf8");
const GAME_PREFIX_UTF16LE = Buffer.from(GAME_PREFIX, "utf16le");

/**
 * A character that can appear inside a `/Game/...` reference: a path separator, an ASCII letter, digit,
 * underscore or hyphen, or any non-ASCII Unicode letter or digit. Everything else ends the reference,
 * so a dot (the `.Object` suffix), NUL, whitespace, punctuation or a UTF-8 replacement char terminates
 * it. That is what stops a reference being truncated at a hyphen or a Unicode letter and what keeps it
 * from being extended into unrelated bytes.
 */
const REFERENCE_ASCII = /[A-Za-z0-9]/;
const REFERENCE_UNICODE = /[\p{L}\p{N}]/u;

function isReferenceChar(char: string): boolean {
  if (char === "/" || char === "_" || char === "-" || REFERENCE_ASCII.test(char)) return true;
  return char.charCodeAt(0) > 0x7f && REFERENCE_UNICODE.test(char);
}

/** The full `/Game/...` package paths in one decoded string, object suffixes removed and repeated
 * separators collapsed. */
function scanGameReferences(text: string): string[] {
  const refs: string[] = [];
  let index = 0;
  for (;;) {
    const start = text.indexOf(GAME_PREFIX, index);
    if (start === -1) break;
    let end = start + GAME_PREFIX.length;
    while (end < text.length && isReferenceChar(text[end]!)) end += 1;
    const path = text.slice(start, end).replace(/\/{2,}/g, "/").replace(/\/$/, "");
    if (path.length > GAME_PREFIX.length) refs.push(path);
    index = end > start ? end : start + GAME_PREFIX.length;
  }
  return refs;
}

/**
 * The first byte offset of a UTF-16LE `\0` terminator at or after `start`, stepping two bytes at a
 * time from the start of the string. A UTF-16LE string is a run of two-byte code units, so only the
 * units on that stride are its characters; stepping by one would let a zero high byte inside a
 * neighbouring code unit end the string early.
 */
function utf16Terminator(buffer: Buffer, start: number): number {
  for (let offset = start; offset + 1 < buffer.length; offset += 2) {
    if (buffer[offset] === 0 && buffer[offset + 1] === 0) return offset;
  }
  return buffer.length;
}

/**
 * Every NUL-terminated string in `head` that starts with the encoded `/Game/` prefix. Unreal writes a
 * string's bytes contiguously and terminates it with a zero, so a match of the prefix begins a real
 * string; only the bounded bytes up to the terminator are decoded, never the arbitrary-binary header
 * around it. Decoding the whole header instead allocates a string over bytes that are not text and
 * aborts the native process on some packages.
 *
 * `indexOf` finds the prefix at any byte offset, so scanning the UTF-8 prefix and the UTF-16LE prefix
 * covers both encodings and every alignment without a second whole-buffer decode. A malformed match
 * decodes to replacement characters and is discarded by the path scan, so it never crashes.
 */
function gameReferenceCandidates(buffer: Buffer, prefix: Buffer, encoding: "utf8" | "utf16le"): string[] {
  const candidates: string[] = [];
  let from = 0;
  for (;;) {
    const start = buffer.indexOf(prefix, from);
    if (start === -1) break;
    const end = encoding === "utf16le" ? utf16Terminator(buffer, start) : buffer.indexOf(0, start);
    candidates.push(buffer.subarray(start, end === -1 ? buffer.length : end).toString(encoding));
    from = start + prefix.length;
  }
  return candidates;
}

/**
 * The `/Game/...` source package paths named in a package's import/name tables. A package that
 * references a material, texture or skeleton names that package's path, so these are the edges of the
 * dependency graph a slice must close over. Engine (`/Engine/...`) and script references are excluded:
 * they are not files in the pack. Repeated separators collapse to one, so a normalized reference joins
 * the same set as its canonical form.
 *
 * Unreal serializes a string as UTF-8 when it is ANSI and as UTF-16LE otherwise, at any byte offset, so
 * this scans the raw bytes for both encodings' `/Game/` prefix and decodes only the bounded string that
 * follows. A path is read by its legal characters rather than a fixed class, so a hyphen or a Unicode
 * letter never truncates it.
 */
export function gameReferencesInHead(head: Buffer): string[] {
  const refs = new Set<string>();
  for (const candidate of [
    ...gameReferenceCandidates(head, GAME_PREFIX_UTF8, "utf8"),
    ...gameReferenceCandidates(head, GAME_PREFIX_UTF16LE, "utf16le"),
  ]) {
    for (const ref of scanGameReferences(candidate)) refs.add(ref);
  }
  return [...refs];
}

/** A whole file's byte length, so a truncated package can be told from an unreadable one. */
async function fileSize(file: string): Promise<number | undefined> {
  let handle;
  try {
    handle = await open(file, "r");
  } catch {
    return undefined;
  }
  try {
    return (await handle.stat()).size;
  } finally {
    await handle.close();
  }
}

/**
 * The `TotalHeaderSize` field of a package summary, or undefined for a byte string that is not a
 * supported Unreal package. This mirrors the pinned CUE4Parse `FPackageFileSummary` read order for the
 * two summary layouts the slice scanner meets: UE4 (legacy -3..-7) and UE5 (legacy -8/-9). `SavedHash`
 * (20 bytes) precedes the size only from UE5 `PACKAGE_SAVED_HASH` (1016) on. The custom-version
 * container size follows the legacy version: enum tags (-2), a variable guid record (-3..-5) or the
 * modern guid+int (-6 and below).
 */
export function packageHeaderSize(prefix: Buffer): number | undefined {
  try {
    if (prefix.length < 40 || prefix.readUInt32LE(0) !== PACKAGE_MAGIC) return undefined;
    let offset = 0;
    const i32 = (): number => {
      const value = prefix.readInt32LE(offset);
      offset += 4;
      return value;
    };
    i32(); // magic
    const legacy = i32();
    if (legacy > -2 || legacy < -9) return undefined; // not a UE4/UE5 summary
    if (legacy !== -4) i32(); // legacy UE3 version
    i32(); // UE4 object version
    const ue5 = legacy <= -8 ? i32() : 0;
    i32(); // licensee version
    let totalHeaderSize: number | undefined;
    if (ue5 >= 1016) {
      offset += 20; // SavedHash
      totalHeaderSize = i32();
    }
    const customVersions = i32();
    if (customVersions < 0 || customVersions > 100_000) return undefined;
    if (legacy === -2) offset += customVersions * 8;
    else if (legacy >= -5) {
      for (let index = 0; index < customVersions; index += 1) {
        offset += 20;
        const length = i32();
        offset += length < 0 ? -length * 2 : length;
      }
    } else offset += customVersions * 20;
    if (totalHeaderSize === undefined) totalHeaderSize = i32();
    return totalHeaderSize;
  } catch {
    return undefined;
  }
}

/** The largest header this reader will load whole; a summary beyond it is refused rather than allocated. */
const MAX_HEADER_BYTES = 64 * 1024 * 1024;

/** A byte source with positioned reads; a `FileHandle` satisfies it. */
export interface PositionedReader {
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
}

/** Fills `buffer` from `position`, or throws. A short read must never leave a zero-filled tail that
 * scans as absent data: a regular file returns the full request, but the contract is enforced, not
 * assumed, so a truncated or concurrently changed file fails loudly. */
export async function readExactly(handle: PositionedReader, buffer: Buffer, position: number): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, position + offset);
    if (bytesRead === 0) throw new Error(`short read at ${position + offset}: wanted ${buffer.length} bytes, got ${offset}`);
    offset += bytesRead;
  }
}

/**
 * Reads a whole package header (summary, name table and import table) for the fallback class/edge scan.
 * The name table holds every `/Game/...` path an import names, so scanning the whole header is a
 * conservative superset of the import-table closure. Unlike the bounded head scan this throws on a
 * truncated or unreadable package, so a dependency can never be dropped silently: the header size must
 * be present, well-formed and inside the file.
 */
export async function readPackageHeaderRegion(file: string): Promise<Buffer> {
  const size = await fileSize(file);
  if (size === undefined) throw new Error(`cannot read package ${file}`);
  let handle;
  try {
    handle = await open(file, "r");
    // The custom-version container sits before `TotalHeaderSize` and can be tens of records long, so
    // read a prefix wide enough to hold it rather than a fixed small window.
    const prefix = Buffer.alloc(Math.min(64 * 1024, size));
    await readExactly(handle, prefix, 0);
    const totalHeaderSize = packageHeaderSize(prefix);
    if (totalHeaderSize === undefined) throw new Error("not a supported Unreal package header");
    if (totalHeaderSize < 16) throw new Error(`implausible header size ${totalHeaderSize}`);
    if (totalHeaderSize > MAX_HEADER_BYTES) throw new Error(`header size ${totalHeaderSize} exceeds the ${MAX_HEADER_BYTES}-byte bound`);
    if (totalHeaderSize > size) throw new Error(`truncated header: ${totalHeaderSize} bytes declared, file holds ${size}`);
    const header = Buffer.alloc(totalHeaderSize);
    await readExactly(handle, header, 0);
    return header;
  } finally {
    await handle?.close();
  }
}

export async function readPackageGameReferences(file: string): Promise<string[]> {
  const head = await readPackageHead(file);
  return head ? gameReferencesInHead(head) : [];
}

/** Object names a package names in the name and import tables at its head: the packages it
 * references, such as a static mesh's materials and textures. Those are separate files on disk. */
export async function readPackageObjectNames(file: string): Promise<Set<string>> {
  const head = await readPackageHead(file);
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
  const head = await readPackageHead(file);
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
