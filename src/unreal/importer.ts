import { createHash, randomBytes } from "node:crypto";
import { copyFile, readdir, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createReadStream, readFileSync, statfs } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { Document, NodeIO, TextureInfo, VertexLayout, type Material, type Primitive, type Root, type Texture } from "@gltf-transform/core";
import { EXTMeshGPUInstancing, KHRLightsPunctual, KHRMaterialsSpecular, KHRMaterialsUnlit } from "@gltf-transform/extensions";
import { attachPsaAnimations, parsePsa, type PsaFile } from "./psa.js";

import {
  type MaterialTextureBinding,
  type UnsupportedTexture,
  type ResolvedMaterial,
  type ResolveMaterialRequest,
  type TextureTransform,
  isColourTexture,
  parsePropsFile,
  resolveMaterial,
} from "./materials.js";
import { readPackageCooking, readPackageObjectNames } from "./cooking.js";
import { decodeMaterialPackage, type SourcePackage } from "./source-material-package.js";
import { reduceSourceMaterial, sameSourceCoordinates, type SourceMaterial } from "./source-material.js";
import { decodeGroomPayload, groomSidecar, type GroomStrands } from "./grooms.js";
import { ImportError } from "./errors.js";
import { extractUnrealFonts } from "./fonts.js";
import { parseOfflineFontDescriptor, writeOfflineFont } from "./bitmap-fonts.js";
import {
  paperObjectPathToPackage,
  parsePaperFlipbookDescriptor,
  parsePaperSpriteDescriptor,
  writePaperSpriteGlb,
  type PaperFlipbookDescriptor,
  type PaperSpriteDescriptor,
} from "./paper2d.js";
import {
  parsePaperTileMapDescriptor,
  parsePaperTileSetDescriptor,
  writePaperTileMapGlb,
  type PaperTileMapDescriptor,
  type PaperTileSetDescriptor,
} from "./paper-tilemaps.js";
import { createGraphBaker, type GraphBakeRequest, type GraphBaker } from "./graph-baker.js";
import { readPackageBuildScale3D } from "./mesh-build-scale.js";
import { ensureModernConverter, ensureUncookedConverter, ensureUmodel } from "./provision.js";
import {
  assembleSceneGlb,
  type ImportedScene,
  parseUnrealSceneSource,
} from "./scenes.js";
import { rasteriseSurfaceNormals, type SurfaceNormals, type SurfaceTriangles } from "./surface-normals.js";
import { remapMeshFileSectionMaterials } from "./static-mesh-sections.js";
import { type ExternalTool, ToolchainError, assertSupportedHost, runBounded } from "./toolchain.js";

const statfsAsync = promisify(statfs);

/** Bumped whenever the conversion contract changes; it participates in the reuse cache key. */
export const IMPORTER_VERSION = 70;

/** First and last UE4 object versions whose uncooked StaticMesh source models are FMeshDescription
 * bulk data (UE4.25–4.27), which only the engine-free converter reads. Below that window UE Viewer
 * reads uncooked source geometry itself, static and skeletal alike: verified on FAB packs saved at
 * object versions 401–516 (UE4.0–4.20), where it matched or beat every hand-written decoder. */
const MESH_DESCRIPTION_FIRST_VERSION = 517;
const MESH_DESCRIPTION_LAST_VERSION = 522;

/** Which tool decodes an uncooked mesh package, or undefined when it must be refused. */
export function uncookedMeshRoute(
  meshKind: "static" | "skeletal",
  fileVersionUE4: number | undefined,
): "umodel" | "mesh-description" | "modern" | undefined {
  if (fileVersionUE4 !== undefined && fileVersionUE4 < MESH_DESCRIPTION_FIRST_VERSION) return "umodel";
  if (meshKind === "skeletal") return "modern";
  return fileVersionUE4 !== undefined && fileVersionUE4 <= MESH_DESCRIPTION_LAST_VERSION ? "mesh-description" : undefined;
}

/** One line per mesh the modern converter could not write: `threenative-mesh-failure<TAB>name<TAB>cause`. */
const MODERN_MESH_FAILURE = /^threenative-mesh-failure\t([^\t]+)\t(.+)$/;

/** Why the modern converter wrote no GLB for each mesh it named, keyed by package basename. */
export function parseModernMeshFailures(stderr: string): Map<string, string> {
  const failures = new Map<string, string>();
  for (const line of stderr.split(/\r?\n/)) {
    const match = MODERN_MESH_FAILURE.exec(line.trim());
    if (match?.[1] && match[2] && !failures.has(match[1])) failures.set(match[1], match[2].trim());
  }
  return failures;
}

/**
 * Whether UE Viewer is worth trying on a mesh the modern converter could not write. A UE5 package
 * is beyond UE Viewer, and a UE4 static mesh already has its own route; the case this admits is a
 * UE4 skeletal mesh, which UE Viewer reads for the object versions it decodes.
 */
function umodelCanRetry(meshKind: "static" | "skeletal" | undefined, legacyFileVersion: number | undefined): boolean {
  return meshKind !== undefined && legacyFileVersion !== undefined && legacyFileVersion >= -7;
}

export { ImportError, type ImportErrorCode } from "./errors.js";

/**
 * Why a section is legitimately without albedo. A visual judge or the parity scorer reads this to tell "the source has
 * no base colour here" from "the importer failed to find it".
 */
export interface ImportedMaterialEffect {
  /**
   * `emissive`: the material wires only Emissive (an unlit or additive effect), so its colour is emitted light.
   * `engine-default-material`: the slot holds Unreal's default material (WorldGridMaterial, an engine asset outside the
   * pack); a particle emitter or placing actor supplies the real material at runtime.
   * `particle`: the BaseColor path reads a per-particle value (DynamicParameter) and could not be baked; the emitter sets
   * the colour at runtime.
   */
  readonly kind: "emissive" | "engine-default-material" | "particle";
  readonly reason: string;
}

export interface ImportedMaterialSection {
  readonly name: string;
  /** False when UE Viewer could not resolve a material for the section at all. */
  readonly resolved: boolean;
  readonly bindings: readonly {
    readonly slot: string;
    readonly texture: string;
    readonly secondaryTexture?: string;
    readonly source: string;
    readonly confidence: string;
    readonly transform: TextureTransform;
    /** The texture the source named when this binding is its Summer sibling instead. */
    readonly substitutedFrom?: string;
  }[];
  readonly unsupported: readonly { readonly texture: string; readonly reason: string }[];
  readonly alphaMode: string;
  readonly alphaCutoff?: number;
  readonly limitations: readonly string[];
  readonly doubleSided: boolean;
  readonly factors: {
    readonly baseColor: readonly [number, number, number, number];
    readonly emissive: readonly [number, number, number];
    readonly metallic: number;
    readonly roughness: number;
  };
  readonly textured: boolean;
  /** Present when the source has no albedo for this section by design (see `ImportedMaterialEffect`). */
  readonly effect?: ImportedMaterialEffect;
  /** Textures written beside the GLB because no glTF slot honestly fits them. */
  readonly sidecarTextures: readonly string[];
  /** Present only when a material-graph bake was attempted for the section (PRD-538). */
  readonly graph?: {
    readonly status: "baked" | "unsupported" | "unavailable";
    readonly confidence?: "exact" | "heuristic";
    readonly unsupportedNodes: readonly string[];
    readonly approximations: readonly string[];
    readonly reason?: string;
  };
}

export interface ImportedModel {
  readonly name: string;
  readonly package: string;
  readonly kind: "static" | "skeletal";
  /** Path relative to the promoted output directory. */
  readonly glb: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly vertices: number;
  readonly primitives: number;
  readonly skins: number;
  readonly joints: number;
  readonly morphTargets: number;
  readonly animations: number;
  readonly boundsMetres: readonly [number, number, number];
  readonly materials: readonly ImportedMaterialSection[];
  /** The embedded DNA asset promoted beside the GLB, for a MetaHuman skeletal mesh. */
  readonly dna?: { readonly path: string; readonly bytes: number; readonly sha256: string };
}

export interface ImportedTexture {
  readonly name: string;
  readonly package: string;
  /** Collision-free path relative to the promoted output directory. */
  readonly png: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
}

/** A TextureCube decoded to the equirectangular layout consumed by Three.js environments. */
export interface ImportedCubemap {
  readonly name: string;
  readonly package: string;
  readonly file: string;
  readonly mimeType: "image/png" | "image/vnd.radiance";
  readonly bytes: number;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
  readonly dynamicRange: "ldr" | "hdr";
  readonly mapping: "EquirectangularReflectionMapping";
}

/** One standalone Unreal material exposed through a shared, directly loadable glTF library. */
export interface ImportedMaterialAsset extends ImportedMaterialSection {
  readonly name: string;
  readonly package: string;
  /** Path to the shared material-swatch GLB, relative to the promoted output directory. */
  readonly glb: string;
  /** Unique material name inside the GLB; use this when Unreal packages share a basename. */
  readonly libraryName: string;
}

export interface ImportedAudio {
  readonly name: string;
  readonly package: string;
  /** Collision-free, Three.js AudioLoader-compatible path relative to the output directory. */
  readonly file: string;
  readonly mimeType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly durationSeconds: number | undefined;
  readonly channels: number | undefined;
  readonly sampleRate: number | undefined;
}

export interface ImportedDataAsset {
  readonly name: string;
  readonly package: string;
  readonly className: string;
  /** Collision-free JSON path relative to the output directory. */
  readonly json: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ImportedTextureStack {
  readonly name: string;
  readonly package: string;
  readonly kind: "array" | "cube-array" | "volume";
  readonly data: string;
  readonly manifest: string;
  readonly format: "RGBA8";
  readonly threeTexture: "DataArrayTexture" | "Data3DTexture";
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ImportedFont {
  readonly name: string;
  readonly package: string;
  /** Browser FontFace-compatible TTF/OTF path relative to the output directory. */
  readonly file: string;
  readonly mimeType: "font/ttf" | "font/otf";
  readonly family: string;
  readonly style: string;
  readonly weight: number;
  readonly fontStyle: "normal" | "italic";
  readonly bytes: number;
  readonly sha256: string;
}

export interface ImportedBitmapFont {
  readonly name: string;
  readonly package: string;
  /** BMFont-compatible metrics and atlas references, relative to the output directory. */
  readonly manifest: string;
  readonly pages: readonly string[];
  readonly glyphs: number;
  readonly distanceField: boolean;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ImportedSprite {
  readonly name: string;
  readonly package: string;
  readonly glb: string;
  readonly vertices: number;
  readonly widthMetres: number;
  readonly heightMetres: number;
  readonly textureWidth: number;
  readonly textureHeight: number;
  readonly bytes: number;
  readonly sha256: string;
}

export interface ImportedFlipbook {
  readonly name: string;
  readonly package: string;
  readonly manifest: string;
  readonly framesPerSecond: number;
  readonly frames: number;
  readonly durationSeconds: number;
  readonly unresolvedSprites: readonly string[];
}

/** Renderable hair strands promoted beside the models, in metres and glTF's Y-up frame. */
export interface ImportedGroom {
  readonly name: string;
  readonly package: string;
  /** Path to the `.strands.bin`, relative to the promoted output directory. */
  readonly path: string;
  /** The `.strands.json` sidecar describing the same strands, relative to the output directory. */
  readonly sidecar: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly strandCount: number;
  readonly pointCount: number;
  /** Guide strands the payload carried and this format leaves out. */
  readonly excludedGuides: number;
}

export interface ImportReport {
  readonly importer: { readonly name: string; readonly version: number };
  readonly source: {
    readonly kind: "local-directory" | "fab-listing";
    readonly path: string;
    readonly listingId: string | undefined;
    readonly engine: string | undefined;
    readonly fileCount: number;
    readonly totalBytes: number;
    readonly sourceHash: string;
  };
  readonly entitlement: {
    readonly provider: string;
    /** Whether an authenticated entitlement was used. Never a token, cookie, or account name. */
    readonly authenticatedDownload: boolean;
    readonly acquisition: "none";
    /** The licence the listing is offered under, and why it was accepted. */
    readonly license:
      | { readonly verdict: string; readonly slugs: readonly string[]; readonly reason: string }
      | undefined;
  };
  readonly toolchain: {
    readonly umodel: string;
    readonly fabcli: string | undefined;
    readonly uncookedConverter: string | undefined;
    readonly modernConverter: string | undefined;
  };
  readonly cacheKey: string;
  readonly reused: boolean;
  readonly materials: "complete" | "degraded";
  readonly counts: {
    readonly packages: number;
    readonly exported: number;
    readonly textures: number;
    readonly cubemaps: number;
    readonly materialAssets: number;
    readonly audio: number;
    readonly dataAssets: number;
    readonly textureStacks: number;
    readonly fonts: number;
    readonly bitmapFonts: number;
    readonly sprites: number;
    readonly flipbooks: number;
    readonly scenes: number;
    readonly strands: number;
    readonly skipped: number;
    readonly failed: number;
  };
  readonly models: readonly ImportedModel[];
  readonly textures: readonly ImportedTexture[];
  readonly cubemaps: readonly ImportedCubemap[];
  readonly materialAssets: readonly ImportedMaterialAsset[];
  readonly audio: readonly ImportedAudio[];
  readonly dataAssets: readonly ImportedDataAsset[];
  readonly textureStacks: readonly ImportedTextureStack[];
  readonly fonts: readonly ImportedFont[];
  readonly bitmapFonts: readonly ImportedBitmapFont[];
  readonly sprites: readonly ImportedSprite[];
  readonly flipbooks: readonly ImportedFlipbook[];
  readonly scenes: readonly ImportedScene[];
  readonly strands: readonly ImportedGroom[];
  readonly skipped: readonly { readonly package: string; readonly reason: string }[];
  readonly failed: readonly { readonly package: string; readonly reason: string }[];
  readonly materialCoverage: {
    readonly sections: number;
    readonly textured: number;
    readonly exact: number;
    readonly heuristic: number;
    readonly unsupported: number;
    /** Sections UE Viewer left as `dummy_material_*`; renamed on output and never called textured. */
    readonly unresolved: number;
    /** Sections whose base colour was baked from the Unreal material graph (PRD-538). */
    readonly graphBaked?: number;
    /** Sections with no albedo by design (emissive-only effects, engine default material); they carry `effect` with the reason. */
    readonly effect?: number;
  };
  readonly transforms: Readonly<Record<string, number>>;
  /** Relative paths of textures written beside the models because no glTF slot fits them. */
  readonly sidecarTextures: readonly string[];
  readonly warnings: readonly string[];
  readonly durationMs: number;
}

export interface ImportUnrealRequest {
  readonly sourceDir: string;
  readonly outputDir: string;
  readonly listingId?: string | undefined;
  readonly engine?: string | undefined;
  readonly sourceKind?: "local-directory" | "fab-listing";
  readonly authenticatedDownload?: boolean;
  readonly fabcliVersion?: string | undefined;
  /** Longest edge for embedded textures. Undefined keeps UE Viewer's own resolution. */
  readonly maxTextureSize?: number | undefined;
  /** Limits the run to packages whose name is in this set. Used by tests and partial imports. */
  readonly onlyPackages?: readonly string[] | undefined;
  /** Source-model LODs to export for a skeletal mesh. Defaults to `[0]`; existing GLBs are unchanged. */
  readonly lods?: readonly number[] | undefined;
  /** Warnings raised before the import started, carried into the report the caller keeps. */
  readonly extraWarnings?: readonly string[] | undefined;
  readonly license?:
    | { readonly verdict: string; readonly slugs: readonly string[]; readonly reason: string }
    | undefined;
  readonly concurrency?: number;
  readonly keepStaging?: boolean;
  readonly environment?: NodeJS.ProcessEnv;
  /** Free bytes reported for every volume the pre-flight measures. Injected by tests. */
  readonly freeSpaceBytes?: number | undefined;
  readonly log?: (message: string) => void;
  readonly umodel?: ExternalTool;
  /** Injected by tests or advanced installations; production provisions the pinned converter. */
  readonly uncookedConverter?: ExternalTool;
  /** Modern UE5 editor-package decoder; production provisions the pinned CUE4Parse adapter. */
  readonly modernConverter?: ExternalTool;
  /** Bake base colour from the Unreal material graph when no colour texture binds. Default true. */
  readonly graphBake?: boolean;
  /** Receives each material's resolver request, for metadata capture. Production leaves it unset. */
  readonly onMaterialResolved?: ((request: ResolveMaterialRequest) => void) | undefined;
  /**
   * Called once after the output is promoted and before the staging directory is deleted, with the
   * exporter's source PNG of every texture embedded without a pixel transform: GLB path (relative
   * to the output directory) -> texture name -> source path(s). More than one path for a name means
   * the name is ambiguous inside that GLB. The paths are valid only until the callback returns.
   * It also receives the report. Not called when the import is served from the cache. Used by the
   * texture-identity proof.
   */
  readonly proofSources?: (
    sources: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>,
    report: ImportReport,
  ) => void | Promise<void>;
}

const UNSUPPORTED_EXTENSIONS = new Map<string, string>();

export const WORLD_PARTITION_EXTERNAL_REASON = "World Partition external actor/object package (level data, not an asset)";

/** True when a package path has a `__ExternalActors__` or `__ExternalObjects__` segment. */
export function isWorldPartitionExternalPackage(path: string): boolean {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .some((segment) => /^__external(actors|objects)__$/i.test(segment));
}

const UNSUPPORTED_CLASSES = new Map<string, string>([
  ["Blueprint", "Blueprint graph"],
  ["BlueprintGeneratedClass", "Blueprint class"],
  ["NiagaraSystem", "Niagara system"],
  ["NiagaraEmitter", "Niagara emitter"],
  ["ParticleSystem", "Cascade particle system"],
  ["LandscapeComponent", "landscape component"],
  ["FoliageType_InstancedStaticMesh", "foliage placement type"],
  ["World", "level"],
  ["MapBuildDataRegistry", "baked level lighting"],
]);

const DATA_ASSET_CLASSES = new Set([
  "DataTable",
  "CurveTable",
  "StringTable",
  "CurveFloat",
  "CurveVector",
  "CurveLinearColor",
]);

const TEXTURE_STACK_CLASSES = new Set(["Texture2DArray", "TextureCubeArray", "VolumeTexture"]);

/** A material package lists hundreds of expression classes; the reason names a few and counts the rest. */
export function summarizeClasses(classes: readonly string[], keep = 4): string {
  const unique = [...new Set(classes)];
  if (unique.length <= keep) return unique.join(", ");
  return `${unique.slice(0, keep).join(", ")} and ${unique.length - keep} more`;
}

/** Staging older than this belongs to an import that was killed before its `finally` ran. */
const STALE_STAGING_MS = 24 * 60 * 60 * 1000;

/** Removes `run-*` staging left by killed imports. One such run can hold gigabytes, and they
 * accumulate until the cache volume fills and every later import fails its free-space check. */
export async function sweepStaleStaging(root: string, now = Date.now()): Promise<void> {
  for (const key of await readdir(root).catch(() => [] as string[])) {
    for (const run of await readdir(join(root, key)).catch(() => [] as string[])) {
      if (!run.startsWith("run-")) continue;
      const path = join(root, key, run);
      const modified = (await stat(path).catch(() => undefined))?.mtimeMs;
      if (modified !== undefined && now - modified > STALE_STAGING_MS) {
        await rm(path, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}

function cacheRoot(environment: NodeJS.ProcessEnv): string {
  return (
    environment.THREENATIVE_UNREAL_CACHE_DIR?.trim() ||
    join(
      environment.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache"),
      "threenative-asset-mcp",
      "unreal-import",
    )
  );
}

async function listFiles(root: string): Promise<{ path: string; size: number }[]> {
  const found: { path: string; size: number }[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(directory, entry.name);
      // Symlinks are never followed: a link inside the pack could otherwise read or, after
      // promotion, write outside the directory the caller named.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      found.push({ path: full, size: (await stat(full)).size });
    }
  };
  await walk(root);
  found.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return found;
}

/** Identity of the input tree: every relative path, size, and byte, in a stable order. */
export async function hashSourceTree(
  root: string,
  files: readonly { path: string; size: number }[],
): Promise<string> {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(relative(root, file.path).split(sep).join("/"));
    hash.update("\0");
    hash.update(String(file.size));
    hash.update("\0");
    for await (const chunk of createReadStream(file.path)) hash.update(chunk);
    hash.update("\n");
  }
  return `sha256:${hash.digest("hex")}`;
}

/** Rejects any generated name that would escape the directory it is written into. */
export function assertContained(root: string, candidate: string): string {
  const full = resolve(root, candidate);
  const inside = relative(root, full);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
    throw new ImportError(
      "UNREAL_OUTPUT_INVALID",
      `Refusing to write "${candidate}": it resolves outside the import output directory.`,
    );
  }
  return full;
}

interface PackageClassification {
  readonly package: string;
  readonly selector: string;
  readonly file: string;
  readonly classes: readonly string[];
  readonly meshKind: "static" | "skeletal" | undefined;
  readonly hasAnimation: boolean;
  readonly hasTexture: boolean;
  readonly hasCubemap: boolean;
  readonly hasMaterial: boolean;
  readonly hasSound: boolean;
  readonly dataClass: string | undefined;
  readonly textureStackClass: string | undefined;
  readonly hasFont: boolean;
  readonly hasBlueprintPrefab: boolean;
  readonly paperClass: "PaperSprite" | "PaperFlipbook" | "PaperTileMap" | "PaperTileSet" | undefined;
  readonly hasGroom: boolean;
  readonly needsModernConverter: boolean;
  /** A texture package whose mip generation setting is `TMGS_NoMipmaps` (see `PackageCooking.noMipmapsHint`). */
  readonly noMipmaps?: boolean;
  readonly error: string | undefined;
}

const LIST_LINE = /^\s*\d+\s+[0-9A-F]+\s+[0-9A-F]+\s+(\S+)\s+(\S+)\s*$/;

export function parseUmodelList(stdout: string): { classes: string[]; objects: string[] } {
  const classes: string[] = [];
  const objects: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = LIST_LINE.exec(line);
    if (!match?.[1] || !match[2]) continue;
    classes.push(match[1]);
    objects.push(match[2]);
  }
  return { classes, objects };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (index >= items.length || item === undefined) return;
      results[index] = await worker(item, index);
    }
  });
  await Promise.all(runners);
  return results;
}

interface ExportedAssets {
  readonly gltf: Map<string, string>;
  readonly psa: Map<string, string>;
  readonly mat: Map<string, string>;
  readonly props: Map<string, string>;
  /**
   * Every `.mat` / `.props.txt` written for a basename, in index order. `mat` and `props` keep only the last one, so two
   * packages that share an object name (`MI_Rock_Inst` in two folders) would silently share one file; `scopeMaterialFiles`
   * uses these to pick the copy that sits beside the mesh being packaged.
   */
  readonly matAll?: ReadonlyMap<string, readonly string[]>;
  readonly propsAll?: ReadonlyMap<string, readonly string[]>;
  readonly png: Map<string, string>;
  /** Basenames with multiple physical PNG producers cannot establish an exact source binding. */
  readonly ambiguousPng?: ReadonlySet<string>;
  readonly audio: Map<string, string>;
  /** Embedded MetaHuman DNA blobs, keyed by the mesh whose export promoted them. */
  readonly dna: Map<string, string>;
}

async function indexExported(root: string): Promise<ExportedAssets> {
  const gltf = new Map<string, string>();
  const psa = new Map<string, string>();
  const mat = new Map<string, string>();
  const props = new Map<string, string>();
  const matAll = new Map<string, string[]>();
  const propsAll = new Map<string, string[]>();
  const png = new Map<string, string>();
  const ambiguousPng = new Set<string>();
  const audio = new Map<string, string>();
  const dna = new Map<string, string>();
  const collect = (all: Map<string, string[]>, key: string, path: string): void => {
    const list = all.get(key) ?? [];
    list.push(path);
    all.set(key, list);
  };
  for (const file of await listFiles(root).catch(() => [])) {
    const name = basename(file.path);
    if (name.endsWith(".props.txt")) { const key = name.slice(0, -".props.txt".length); props.set(key, file.path); collect(propsAll, key, file.path); }
    else if (name.endsWith(".mat")) { const key = name.slice(0, -".mat".length); mat.set(key, file.path); collect(matAll, key, file.path); }
    else if (name.endsWith(".gltf")) gltf.set(name.slice(0, -".gltf".length), file.path);
    else if (name.endsWith(".psa")) psa.set(name.slice(0, -".psa".length), file.path);
    else if (name.endsWith(".png")) { const stem = name.slice(0, -".png".length); if (png.has(stem)) ambiguousPng.add(stem); png.set(stem, file.path); }
    else if (name.endsWith(".dna")) dna.set(name.slice(0, -".dna".length), file.path);
    else if (/\.(?:wav|ogg|mp3|flac)$/i.test(name)) audio.set(name.slice(0, name.lastIndexOf(".")), file.path);
  }
  return { gltf, psa, mat, props, matAll, propsAll, png, ambiguousPng, audio, dna };
}

function mergeCandidates(
  left: ReadonlyMap<string, readonly string[]> | undefined,
  right: ReadonlyMap<string, readonly string[]> | undefined,
): Map<string, string[]> {
  const merged = new Map<string, string[]>();
  for (const source of [left, right]) {
    for (const [name, paths] of source ?? []) {
      const list = merged.get(name) ?? [];
      for (const path of paths) if (!list.includes(path)) list.push(path);
      merged.set(name, list);
    }
  }
  return merged;
}

const scopedMaterialFiles = new WeakMap<ExportedAssets, Map<string, ExportedAssets>>();

/**
 * UE Viewer keeps the package folders, but the importer indexes `.mat` / `.props.txt` by basename, so `MI_X_Inst` in two
 * folders collapses to whichever was indexed last and a mesh gets another package's textures. A mesh's own folder is the
 * best evidence of which copy it uses (the Landscape Pro rocks each have a same-named instance beside them), so for a
 * name with several exports the copy beside the mesh wins. Returns `assets` itself when nothing needs choosing.
 */
export function scopeMaterialFiles(assets: ExportedAssets, meshDirectory: string): ExportedAssets {
  const byDirectory = scopedMaterialFiles.get(assets) ?? new Map<string, ExportedAssets>();
  scopedMaterialFiles.set(assets, byDirectory);
  const known = byDirectory.get(meshDirectory);
  if (known) return known;
  const choose = (all: ReadonlyMap<string, readonly string[]> | undefined, current: Map<string, string>): Map<string, string> => {
    let chosen: Map<string, string> | undefined;
    for (const [name, paths] of all ?? []) {
      if (paths.length < 2) continue;
      const beside = paths.find((path) => dirname(path) === meshDirectory);
      if (beside === undefined || current.get(name) === beside) continue;
      chosen ??= new Map(current);
      chosen.set(name, beside);
    }
    return chosen ?? current;
  };
  const mat = choose(assets.matAll, assets.mat);
  const props = choose(assets.propsAll, assets.props);
  const scoped = mat === assets.mat && props === assets.props ? assets : { ...assets, mat, props };
  byDirectory.set(meshDirectory, scoped);
  return scoped;
}

/** How many trailing directory names of `file` equal those of the package a `Parent =` reference names. */
function packageDirectoryOverlap(file: string, packagePath: string): number {
  const wanted = packagePath.replace(/\\/g, "/").toLowerCase().split("/").slice(0, -1);
  const held = dirname(file).replace(/\\/g, "/").toLowerCase().split("/");
  let overlap = 0;
  while (overlap < wanted.length && overlap < held.length && wanted[wanted.length - 1 - overlap] === held[held.length - 1 - overlap]) overlap += 1;
  return overlap;
}

/** The one copy that shares the most trailing directories with the named package; undefined on no overlap or a tie. */
function copyInPackage(copies: readonly string[], packagePath: string): string | undefined {
  const scored = copies.map((copy) => ({ copy, overlap: packageDirectoryOverlap(copy, packagePath) })).sort((a, b) => b.overlap - a.overlap);
  const [best, next] = scored;
  return best !== undefined && best.overlap > 0 && best.overlap > (next?.overlap ?? 0) ? best.copy : undefined;
}

const parentScoped = new WeakMap<ExportedAssets, Map<string, ExportedAssets>>();

/**
 * A parent material is named by basename in the sidecar maps, so two packages that share one (`MI_Leafs_Inst` under
 * `DeadTrees/` and `GreenTrees/`) collapse onto whichever was indexed last. The instance's `Parent =` line names the
 * package it really inherits from; this follows the chain from `startName` and points each ambiguous ancestor at the
 * `.mat` / `.props.txt` that sits in that package's directory. Anything it cannot place keeps the existing pick.
 */
export function scopeParentChain(assets: ExportedAssets, startName: string): ExportedAssets {
  if (assets.propsAll === undefined) return assets;
  const known = parentScoped.get(assets) ?? new Map<string, ExportedAssets>();
  parentScoped.set(assets, known);
  const cached = known.get(startName);
  if (cached) return cached;
  let mat: Map<string, string> | undefined;
  let props: Map<string, string> | undefined;
  const visited = new Set<string>();
  let path = assets.props.get(startName);
  for (let depth = 0; path !== undefined && depth < 8; depth += 1) {
    const text = readMaterialSidecar(path);
    if (!text) break;
    const { parent, parentPackage } = parsePropsFile(text);
    if (parent === undefined || visited.has(parent)) break;
    visited.add(parent);
    const copies = assets.propsAll.get(parent) ?? [];
    const matching = parentPackage !== undefined && copies.length > 1 ? copyInPackage(copies, parentPackage) : undefined;
    if (matching !== undefined && matching !== (props ?? assets.props).get(parent)) {
      props ??= new Map(assets.props);
      props.set(parent, matching);
      const sibling = (assets.matAll?.get(parent) ?? []).find((copy) => dirname(copy) === dirname(matching));
      if (sibling !== undefined) {
        mat ??= new Map(assets.mat);
        mat.set(parent, sibling);
      }
    }
    path = (props ?? assets.props).get(parent);
  }
  const scoped = mat === undefined && props === undefined ? assets : { ...assets, mat: mat ?? assets.mat, props: props ?? assets.props };
  known.set(startName, scoped);
  return scoped;
}

function mergeExported(left: ExportedAssets, right: ExportedAssets): ExportedAssets {
  const merge = (first: Map<string, string>, second: Map<string, string>): Map<string, string> =>
    new Map([...first, ...second]);
  const ambiguousPng = new Set([...(left.ambiguousPng ?? []), ...(right.ambiguousPng ?? [])]);
  for (const [name, file] of right.png) if (left.png.has(name) && left.png.get(name) !== file) ambiguousPng.add(name);
  return {
    gltf: merge(left.gltf, right.gltf),
    psa: merge(left.psa, right.psa),
    mat: merge(left.mat, right.mat),
    props: merge(left.props, right.props),
    matAll: mergeCandidates(left.matAll, right.matAll),
    propsAll: mergeCandidates(left.propsAll, right.propsAll),
    png: merge(left.png, right.png),
    ambiguousPng,
    audio: merge(left.audio, right.audio),
    dna: merge(left.dna, right.dna),
  };
}

async function indexGlbs(root: string): Promise<Map<string, string>> {
  const glbs = new Map<string, string>();
  for (const file of await listFiles(root).catch(() => [])) {
    const name = basename(file.path);
    if (name.toLowerCase().endsWith(".glb")) glbs.set(name.slice(0, -4), file.path);
  }
  return glbs;
}

/** Raw GroomAsset editor payloads by asset name, largest first: only one of a package's compressed
 * trailers is the hair description, and the decoder recognises it by consuming all of it. */
async function indexGroomPayloads(root: string): Promise<Map<string, string[]>> {
  const payloads = new Map<string, { readonly path: string; readonly size: number }[]>();
  for (const file of await listFiles(root).catch(() => [])) {
    const name = basename(file.path);
    const match = /^(.*)\.payload\d+\.bin$/i.exec(name);
    if (!match?.[1]) continue;
    const forName = payloads.get(match[1]) ?? [];
    forName.push(file);
    payloads.set(match[1], forName);
  }
  return new Map(
    [...payloads].map(([name, files]) => [
      name,
      files.sort((left, right) => right.size - left.size).map((file) => file.path),
    ]),
  );
}

const MODERN_ENGINE_FALLBACKS = ["5.7", "5.6", "5.5", "5.4", "5.3", "5.2", "5.1", "5.0"] as const;

function isEngineProfileMismatch(output: string): boolean {
  return /CUE4Parse could not decode|ParserException|Invalid FString length|UnknownEngineVersion|No StaticMesh, SkeletalMesh, Texture2D, TextureCube, SoundWave, or structured-data output was produced/i.test(output);
}

/**
 * The converter explains a texture it could not write on stderr (`threenative-texture-failure
 * <name>: <reason>; <evidence>`), ahead of the generic "no output" exception. Surfacing that line
 * turns a bare exit code into a stated pack limitation, such as pixel data that is not in the pack.
 */
export function modernConverterFailureCause(output: { readonly stdout: string; readonly stderr: string }): string | undefined {
  const lines = `${output.stderr}\n${output.stdout}`.split(/\r?\n/);
  const explained = lines.find((line) => line.startsWith("threenative-texture-failure "));
  const cause = explained?.slice("threenative-texture-failure ".length)
    ?? lines.find((line) => /^Unhandled exception\. /.test(line))?.replace(/^Unhandled exception\. [\w.]+: /, "");
  const trimmed = cause?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > 800 ? `${trimmed.slice(0, 800)}…` : trimmed;
}

/**
 * Unversioned UE5.6 and UE5.7 packages both use LegacyFileVersion -9, so the package header alone
 * cannot select the serializer. Each attempt writes to a private sibling and only a complete exit
 * zero is renamed into the caller's staging path; failed partial exports never leak forward.
 */
async function runModernConverter(
  executable: string,
  sourceDir: string,
  outputDir: string,
  tailArgs: readonly string[],
  limits: { readonly timeoutMs: number; readonly maxOutputBytes: number },
) {
  const attempts: (typeof MODERN_ENGINE_FALLBACKS[number] | undefined)[] = [undefined, ...MODERN_ENGINE_FALLBACKS];
  let last: Awaited<ReturnType<typeof runBounded>> | undefined;
  for (const engine of attempts) {
    const attempt = `${outputDir}.engine-${engine ?? "auto"}`;
    await rm(attempt, { recursive: true, force: true });
    await mkdir(dirname(attempt), { recursive: true });
    const args = [sourceDir, "--export-dir", attempt, ...tailArgs];
    if (engine) args.push("--engine", engine);
    const converted = await runBounded(executable, args, limits);
    if (converted.code === 0) {
      await rm(outputDir, { recursive: true, force: true });
      await rename(attempt, outputDir);
      return converted;
    }
    last = converted;
    await rm(attempt, { recursive: true, force: true });
    if (!isEngineProfileMismatch(`${converted.stdout}\n${converted.stderr}`)) return converted;
  }
  return last!;
}

/**
 * Rebuilds one Unreal texture into the channel layout the target glTF slot expects. Every branch
 * is a named transform declared by `materials.ts` and asserted over synthetic pixels in the tests;
 * nothing here guesses at runtime.
 */
export async function applyTextureTransform(
  input: Buffer,
  transform: TextureTransform,
  maxTextureSize: number | undefined,
  secondaryInput?: Buffer,
): Promise<{ data: Buffer; mimeType: string }> {
  const { default: sharp } = await import("sharp");
  sharp.cache(false);
  const base = () => {
    const pipeline = sharp(input, { limitInputPixels: 268_435_456, unlimited: true });
    return maxTextureSize
      ? pipeline.resize({
          width: maxTextureSize,
          height: maxTextureSize,
          fit: "inside",
          withoutEnlargement: true,
        })
      : pipeline;
  };

  if (transform === "none") {
    // Re-encoding an untouched image would cost minutes across a full pack and change nothing.
    if (maxTextureSize === undefined) return { data: input, mimeType: "image/png" };
    return { data: await base().png({ compressionLevel: 6 }).toBuffer(), mimeType: "image/png" };
  }

  const { data, info } = await base()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixels = info.width * info.height;
  if (transform === "roughnessToOne") {
    for (let index = 0; index < pixels; index += 1) data[index * 4 + 1] = 255;
    return { data: await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png({ compressionLevel: 6 }).toBuffer(), mimeType: "image/png" };
  }
  if (transform === "redToBaseColorAlpha" || transform === "blueToBaseColorAlpha") {
    if (!secondaryInput) throw new Error("Opacity source is missing for base-colour alpha composition.");
    const colourMetadata = await sharp(input).metadata();
    const opacityMetadata = await sharp(secondaryInput).metadata();
    // The same UV layout at another resolution is fine (the mask is resized to the colour); another aspect is not.
    const colourAspect = (colourMetadata.width ?? 1) / (colourMetadata.height ?? 1);
    const opacityAspect = (opacityMetadata.width ?? 1) / (opacityMetadata.height ?? 1);
    if (Math.abs(colourAspect / opacityAspect - 1) > 0.01) {
      throw new Error("Opacity and base-colour source dimensions do not match.");
    }
    const mask = await sharp(secondaryInput, { limitInputPixels: 268_435_456, unlimited: true })
      .resize(info.width, info.height, { fit: "fill" })
      .ensureAlpha().raw().toBuffer();
    const channel = transform === "blueToBaseColorAlpha" ? 2 : 0;
    for (let index = 0; index < pixels; index += 1) data[index * 4 + 3] = mask[index * 4 + channel] ?? 0;
    return {
      data: await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png({ compressionLevel: 6, adaptiveFiltering: true }).toBuffer(),
      mimeType: "image/png",
    };
  }
  const output = Buffer.alloc(pixels * 3);
  let secondary: Buffer | undefined;
  if (transform === "redRoughnessRedMetalness") {
    if (!secondaryInput) throw new Error("Metalness source is missing for metallic-roughness packing.");
    secondary = await sharp(secondaryInput, { limitInputPixels: 268_435_456, unlimited: true })
      .resize(info.width, info.height, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer();
  }
  for (let index = 0; index < pixels; index += 1) {
    const source = index * 4;
    const target = index * 3;
    const red = data[source] ?? 0;
    const alpha = data[source + 3] ?? 255;
    // glTF metallicRoughness: R is free, G is roughness, B is metalness. Nothing in an Unreal
    // photoscan pack is a metal, so B stays 0 rather than inheriting an unrelated channel.
    const roughness =
      transform === "alphaToRoughness"
        ? alpha
        : transform === "redToRoughness" || transform === "redRoughnessRedMetalness"
          ? red
          : 255 - red;
    output[target] = 255;
    output[target + 1] = roughness;
    output[target + 2] = secondary?.[source - Math.floor(source / 4)] ?? 0;
  }
  return {
    data: await sharp(output, {
      raw: { width: info.width, height: info.height, channels: 3 },
    })
      .png({ compressionLevel: 6 })
      .toBuffer(),
    mimeType: "image/png",
  };
}

const SLOT_ORDER = ["baseColor", "normal", "metallicRoughness", "emissive", "occlusion"] as const;

/**
 * Whether an image can plausibly be a base colour map.
 *
 * Unreal's larger materials do not ship an albedo texture at all: a rock master blends tiling
 * detail materials through a packed mask, and umodel resolves that mask into its `Diffuse` slot
 * because it is where the diffuse chain begins. Binding it as base colour is what turns a
 * limestone cave magenta — the channels are three unrelated masks, not a photograph.
 *
 * A photographed albedo has strongly correlated RGB and low saturation; the pack's masks measure
 * 0.02–0.16 correlation at 0.78–0.84 saturation against 0.97–1.00 at 0.09–0.13 for its real
 * albedos. The thresholds sit in the gap, and the decision is recorded rather than silent.
 */
export interface IAlbedoVerdict {
  readonly isAlbedo: boolean;
  readonly saturation: number;
  readonly channelCorrelation: number;
  readonly spatialVariation: number;
}

const MASK_SATURATION = 0.45;
const ALBEDO_CORRELATION = 0.55;

export async function classifyAlbedo(image: Buffer): Promise<IAlbedoVerdict> {
  const { default: sharp } = await import("sharp");
  const { data, info } = await sharp(image, { limitInputPixels: 268_435_456, unlimited: true })
    .resize(96, 96, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixels = info.width * info.height;
  let saturation = 0;
  let meanRed = 0;
  let meanGreen = 0;
  let meanBlue = 0;
  for (let index = 0; index < pixels; index += 1) {
    const red = (data[index * 3] ?? 0) / 255;
    const green = (data[index * 3 + 1] ?? 0) / 255;
    const blue = (data[index * 3 + 2] ?? 0) / 255;
    const high = Math.max(red, green, blue);
    const low = Math.min(red, green, blue);
    saturation += high === 0 ? 0 : (high - low) / high;
    meanRed += red;
    meanGreen += green;
    meanBlue += blue;
  }
  saturation /= pixels;
  meanRed /= pixels;
  meanGreen /= pixels;
  meanBlue /= pixels;
  let covariance = 0;
  let varianceRed = 0;
  let varianceGreen = 0;
  let varianceBlue = 0;
  for (let index = 0; index < pixels; index += 1) {
    const red = (data[index * 3] ?? 0) / 255 - meanRed;
    const green = (data[index * 3 + 1] ?? 0) / 255 - meanGreen;
    const blue = (data[index * 3 + 2] ?? 0) / 255 - meanBlue;
    covariance += red * green;
    varianceRed += red * red;
    varianceGreen += green * green;
    varianceBlue += blue * blue;
  }
  const channelCorrelation = covariance / Math.sqrt(varianceRed * varianceGreen || 1e-9);
  const spatialVariation = Math.sqrt(
    (varianceRed + varianceGreen + varianceBlue) / Math.max(1, pixels * 3),
  );
  return {
    // A solid swatch can be fully saturated but is still a legitimate base colour. Packed masks
    // vary spatially; accepting near-uniform images avoids classifying red/blue palette textures
    // as channel masks.
    isAlbedo:
      spatialVariation < 0.03 ||
      saturation < MASK_SATURATION ||
      channelCorrelation > ALBEDO_CORRELATION,
    saturation,
    channelCorrelation,
    spatialVariation,
  };
}

/**
 * Transformed images, shared across every mesh in one import. A ground-tile texture is bound by
 * dozens of meshes and an 8K resize costs seconds, so without this the full pack pays for the same
 * decode over and over. Bounded by bytes rather than entries: one 8K image is worth thousands of
 * small ones.
 */
const TRANSFORMED_IMAGE_BUDGET_BYTES = 1_500_000_000;

export class TransformedImageCache {
  readonly #entries = new Map<string, { data: Buffer; mimeType: string }>();
  #bytes = 0;

  async get(
    key: string,
    produce: () => Promise<{ data: Buffer; mimeType: string }>,
  ): Promise<{ data: Buffer; mimeType: string }> {
    const cached = this.#entries.get(key);
    if (cached) return cached;
    const produced = await produce();
    while (this.#bytes + produced.data.length > TRANSFORMED_IMAGE_BUDGET_BYTES) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#bytes -= this.#entries.get(oldest.value)?.data.length ?? 0;
      this.#entries.delete(oldest.value);
    }
    this.#entries.set(key, produced);
    this.#bytes += produced.data.length;
    return produced;
  }
}

/** Resolution of the UV-space normal map a surface-reading graph bake is given. */
const SURFACE_MAP_SIZE = 1024;
const surfaceMaps = new WeakMap<Material, SurfaceNormals | null>();

/** The vertex normals of every primitive that uses `material`, laid out in UV space; undefined when there are none to use. */
function surfaceOf(root: Root, material: Material): SurfaceNormals | undefined {
  const known = surfaceMaps.get(material);
  if (known !== undefined) return known ?? undefined;
  const triangles: SurfaceTriangles[] = [];
  for (const mesh of root.listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      if (primitive.getMaterial() !== material) continue;
      const uv = primitive.getAttribute("TEXCOORD_0")?.getArray();
      const normal = primitive.getAttribute("NORMAL")?.getArray();
      if (!uv || !normal) continue;
      triangles.push({ uv, normal, indices: primitive.getIndices()?.getArray() ?? undefined });
    }
  }
  const surface = triangles.length > 0 ? rasteriseSurfaceNormals(triangles, SURFACE_MAP_SIZE) : undefined;
  surfaceMaps.set(material, surface ?? null);
  return surface;
}

function attachTexture(
  material: Material,
  binding: MaterialTextureBinding,
  texture: Texture,
): void {
  switch (binding.slot) {
    case "baseColor":
      material.setBaseColorTexture(texture);
      material.setBaseColorFactor([1, 1, 1, 1]);
      return;
    case "normal":
      material.setNormalTexture(texture);
      return;
    case "emissive":
      material.setEmissiveTexture(texture);
      material.setEmissiveFactor([1, 1, 1]);
      return;
    case "metallicRoughness":
      material.setMetallicRoughnessTexture(texture);
      material.setMetallicFactor(0);
      material.setRoughnessFactor(1);
      return;
    case "occlusion":
      material.setOcclusionTexture(texture);
      return;
  }
}

export interface PackagedModel {
  readonly vertices: number;
  readonly primitives: number;
  readonly skins: number;
  readonly joints: number;
  readonly morphTargets: number;
  readonly animations: number;
  readonly attachedPsa: readonly string[];
  readonly existingPsa: readonly string[];
  readonly incompatiblePsa: readonly string[];
  readonly bounds: [number, number, number];
  readonly sections: ImportedMaterialSection[];
  readonly prunedUvSets: number;
  readonly droppedTangents: number;
  /** Seam-duplicated render vertices given the morph delta their twin already carried. */
  readonly repairedMorphDeltas: number;
  /** Co-located vertices whose morph deltas disagreed in a way no single value could repair. */
  readonly conflictingMorphDeltas: number;
}

/** Two co-located vertices are the same source vertex when their positions agree to this far. */
const SEAM_POSITION_EPSILON = 1e-6;
/** A delta at or below this is a value no renderer can see, so it is not a delta. */
const SEAM_DELTA_EPSILON = 1e-6;

/**
 * A glTF export splits one render vertex into a copy per UV and normal seam, and Unreal's morph
 * export writes a source vertex's delta to a single one of those copies. The skin then tears open
 * along the seam: one copy moves, its identical twin stays put. Every co-located copy that shares a
 * skin has to carry the same delta, so a group of them is given the value its delta-carrying
 * member already has. Two members that disagree are left exactly as exported — picking either would
 * move a vertex the source data put somewhere else — and counted.
 */
function repairSeamMorphDeltas(primitive: Primitive): { readonly repaired: number; readonly conflicting: number } {
  const targets = primitive.listTargets();
  const position = primitive.getAttribute("POSITION");
  const joints = primitive.getAttribute("JOINTS_0");
  const weights = primitive.getAttribute("WEIGHTS_0");
  if (targets.length === 0 || !position || !joints || !weights) return { repaired: 0, conflicting: 0 };

  const positionArray = position.getArray();
  const jointArray = joints.getArray();
  const weightArray = weights.getArray();
  const positionSize = position.getElementSize();
  const jointSize = joints.getElementSize();
  const weightSize = weights.getElementSize();
  if (!positionArray || !jointArray || !weightArray) return { repaired: 0, conflicting: 0 };

  // The seams belong to the mesh, not to a morph, so the groups are built once and reused for
  // every target. Two vertices join a group only when they are co-located AND bound to the same
  // joints with the same weights, because a vertex on a different skin is a different vertex no
  // matter how close it lies to this one.
  const groups = new Map<string, number[]>();
  for (let index = 0; index < position.getCount(); index += 1) {
    let key = "";
    for (let axis = 0; axis < positionSize; axis += 1) {
      key += `${Math.round((positionArray[index * positionSize + axis] ?? 0) / SEAM_POSITION_EPSILON)},`;
    }
    for (let slot = 0; slot < jointSize; slot += 1) key += `/${jointArray[index * jointSize + slot]}`;
    for (let slot = 0; slot < weightSize; slot += 1) key += `/${weightArray[index * weightSize + slot]}`;
    const group = groups.get(key);
    if (group) group.push(index);
    else groups.set(key, [index]);
  }

  let repaired = 0;
  let conflicting = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const target of targets) {
      for (const delta of target.listAttributes()) {
        const array = delta.getArray();
        if (!array) continue;
        const size = delta.getElementSize();
        // The first member carrying a delta is the value the rest of the group has to take, unless
        // a second member carries a different one — then neither is right, and neither is moved.
        let carrier = -1;
        let agreed = true;
        for (const member of group) {
          let magnitude = 0;
          for (let axis = 0; axis < size; axis += 1) {
            magnitude = Math.max(magnitude, Math.abs(array[member * size + axis] ?? 0));
          }
          if (magnitude <= SEAM_DELTA_EPSILON) continue;
          if (carrier === -1) {
            carrier = member;
            continue;
          }
          for (let axis = 0; axis < size; axis += 1) {
            if (
              Math.abs((array[member * size + axis] ?? 0) - (array[carrier * size + axis] ?? 0)) >
              SEAM_DELTA_EPSILON
            ) {
              agreed = false;
            }
          }
          if (!agreed) break;
        }
        if (carrier === -1) continue;
        if (!agreed) {
          conflicting += 1;
          continue;
        }
        for (const member of group) {
          if (member === carrier) continue;
          let written = false;
          for (let axis = 0; axis < size; axis += 1) {
            const value = array[carrier * size + axis] ?? 0;
            if (array[member * size + axis] === value) continue;
            array[member * size + axis] = value;
            written = true;
          }
          if (written) repaired += 1;
        }
      }
    }
  }
  return { repaired, conflicting };
}

/**
 * Reads one UE Viewer glTF, replaces its debug-colour materials with the reconstructed PBR ones,
 * embeds every bound image, and writes a self-contained GLB.
 */
/**
 * glTF-Transform interleaves vertex attributes by default. ThreeNative's native host rejects an
 * interleaved buffer view outright — `createRenderPipeline` fails on every mesh that uses one — so
 * an interleaved GLB is a source asset that renders on the web and cannot be packaged for desktop
 * or mobile at all. Separate is the only layout this importer writes.
 */
function separateLayoutIO(): NodeIO {
  return new NodeIO()
    .registerExtensions([KHRLightsPunctual, EXTMeshGPUInstancing, KHRMaterialsUnlit, KHRMaterialsSpecular])
    .setVertexLayout(VertexLayout.SEPARATE);
}

/** Builds a tiny swatch mesh per material so GLTFLoader returns normal Three.js materials. */
async function writeMaterialLibrarySource(
  path: string,
  entries: readonly { readonly libraryName: string; readonly package: string }[],
): Promise<void> {
  const document = new Document();
  const buffer = document.createBuffer();
  const position = document
    .createAccessor("POSITION")
    .setType("VEC3")
    .setArray(new Float32Array([-0.45, -0.45, 0, 0.45, -0.45, 0, 0.45, 0.45, 0, -0.45, 0.45, 0]))
    .setBuffer(buffer);
  const normal = document
    .createAccessor("NORMAL")
    .setType("VEC3")
    .setArray(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]))
    .setBuffer(buffer);
  const uv = document
    .createAccessor("TEXCOORD_0")
    .setType("VEC2")
    .setArray(new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]))
    .setBuffer(buffer);
  const indices = document
    .createAccessor("indices")
    .setType("SCALAR")
    .setArray(new Uint16Array([0, 1, 2, 0, 2, 3]))
    .setBuffer(buffer);
  const scene = document.createScene("Unreal Material Library");
  const columns = Math.max(1, Math.ceil(Math.sqrt(entries.length)));
  for (const [index, entry] of entries.entries()) {
    const material = document.createMaterial(entry.libraryName);
    const primitive = document
      .createPrimitive()
      .setIndices(indices)
      .setAttribute("POSITION", position)
      .setAttribute("NORMAL", normal)
      .setAttribute("TEXCOORD_0", uv)
      .setMaterial(material);
    const mesh = document.createMesh(entry.libraryName).addPrimitive(primitive);
    const node = document
      .createNode(entry.libraryName)
      .setMesh(mesh)
      .setTranslation([index % columns, -Math.floor(index / columns), 0])
      .setExtras({ unrealPackage: entry.package, materialSwatch: true });
    scene.addChild(node);
  }
  await mkdir(dirname(path), { recursive: true });
  await separateLayoutIO().write(path, document);
}

/** True when any primitive that renders with `material` carries a COLOR_0 attribute. */
function usesVertexColors(root: ReturnType<Document["getRoot"]>, material: Material): boolean {
  return root
    .listMeshes()
    .some((mesh) => mesh.listPrimitives().some((primitive) => primitive.getMaterial() === material && primitive.getAttribute("COLOR_0") !== null));
}

/** Glass, mirror and light sections keep their named PBR fallbacks; no graph bake is attempted for them. */
function hasNamedFallback(materialName: string): boolean {
  const lower = materialName.toLowerCase();
  return lower.includes("glass") || lower.includes("mirror") || /(?:^|_)light(?:_|$)/.test(lower);
}

export async function packageGlb(options: {
  readonly gltfPath: string;
  readonly glbPath: string;
  readonly assets: ExportedAssets;
  readonly maxTextureSize: number | undefined;
  readonly keepAllUvSets: boolean;
  readonly imageCache?: TransformedImageCache;
  /** Written into the glTF `asset.copyright`, so the entitlement travels with the file. */
  readonly copyright?: string | undefined;
  /** Collects textures no glTF slot fits, to be written beside the GLBs. */
  readonly sidecars?: Map<string, string>;
  /**
   * Multiplies positions before writing; uncooked MeshDescription coordinates are centimetres. A triple scales the
   * glTF x, y and z axes separately (UE Viewer's `BuildScale3D`, see `mesh-build-scale.ts`).
   */
  readonly geometryScale?: number | readonly [number, number, number];
  /** Standalone ActorX animations exported by UE Viewer and matched to this model's joints. */
  readonly psaFiles?: readonly PsaFile[];
  /** Unique library material name -> Unreal object basename used for sidecar lookup. */
  readonly materialLookupNames?: ReadonlyMap<string, string>;
  /** Per-material isolated exports, required when two packages share an object basename. */
  readonly materialAssets?: ReadonlyMap<string, ExportedAssets>;
  /** Scoped authored source lookup; library names are resolved to exact source packages. */
  readonly sourceMaterial?: (name: string, lookupName: string) => SourceMaterial | undefined | Promise<SourceMaterial | undefined>;
  /** Bakes the Unreal material graph for a section no texture binding gave a base colour (PRD-538). */
  readonly graphBaker?: GraphBaker | undefined;
  /** Lazily answers whether the mesh package names the engine default material; asked only for an unresolved section. */
  readonly namesEngineDefaultMaterial?: (() => Promise<boolean>) | undefined;
  readonly onMaterialResolved?: ((request: ResolveMaterialRequest) => void) | undefined;
  /** Collects texture name -> source PNG path for every texture embedded without a pixel transform. */
  readonly proofSources?: Map<string, string[]> | undefined;
  /** Source textures with no mip chain in Unreal; a cut-out card sampling one keeps an unmipped sampler. */
  readonly noMipmapTextures?: ReadonlySet<string> | undefined;
}): Promise<PackagedModel> {
  const io = separateLayoutIO();
  const document = await io.read(options.gltfPath);
  const root = document.getRoot();
  const psa = attachPsaAnimations(document, options.psaFiles ?? []);
  // A provenance record that lives only in a sibling report is one `cp` away from being lost.
  // ThreeNative's own asset health check reads this field, so an imported asset that cannot say
  // where it came from is reported as unknown rather than quietly assumed fine.
  // glTF-Transform owns `generator` on write, so the provenance rides in `copyright` alone.
  if (options.copyright) root.getAsset().copyright = options.copyright;
  const sections: ImportedMaterialSection[] = [];
  const cache = new Map<string, Texture>();
  const scalarRoughnessTextures = new Map<Texture, Texture>();
  let prunedUvSets = 0;
  let droppedTangents = 0;
  let repairedMorphDeltas = 0;
  let conflictingMorphDeltas = 0;
  const rejectedMasks: UnsupportedTexture[] = [];
  const sharedGraphs = new Map<ExportedAssets, Map<string, Set<string>>>();
  const meshAssets = scopeMaterialFiles(options.assets, dirname(options.gltfPath));
  for (const material of root.listMaterials()) {
    const name = material.getName();
    const lookup = options.materialLookupNames?.get(name) ?? name;
    const assets = options.materialAssets?.get(name) ?? meshAssets;
    const path = assets.mat.get(lookup);
    if (!path) continue;
    const text = readMaterialSidecar(path);
    if (!text) continue;
    const graphs = sharedGraphs.get(assets) ?? new Map<string, Set<string>>();
    const names = graphs.get(text) ?? new Set<string>();
    names.add(lookup);
    graphs.set(text, names);
    sharedGraphs.set(assets, graphs);
  }

  for (const [index, material] of root.listMaterials().entries()) {
    const name = material.getName();
    const lookupName = options.materialLookupNames?.get(name) ?? name;
    const unscopedAssets = options.materialAssets?.get(name) ?? meshAssets;
    const materialAssets = scopeParentChain(unscopedAssets, lookupName);
    const availableTextures = new Set(materialAssets.png.keys());
    const graphPath = materialAssets.mat.get(lookupName);
    const graphText = graphPath ? readMaterialSidecar(graphPath) : undefined;
    const graphNames = graphText ? sharedGraphs.get(unscopedAssets)?.get(graphText) : undefined;
    // UE Viewer names a section it could not resolve `dummy_material_<n>` and paints it a debug
    // colour. Shipping that name would put a placeholder into a game asset and let a reader
    // mistake it for a real material, so it is renamed to something that says what it is.
    const unresolvedSection = /^dummy_material(_\d+)?$/i.test(name);
    if (unresolvedSection) {
      material.setName(`${basename(options.glbPath, ".glb")}_unresolved_section_${index}`);
    }
    const materialRequest: ResolveMaterialRequest = {
      name: lookupName,
      readMat: (materialName) => {
        const path = materialAssets.mat.get(materialName);
        return path === undefined ? undefined : readMaterialSidecar(path);
      },
      readProps: (materialName) => {
        const path = materialAssets.props.get(materialName);
        return path === undefined ? undefined : readMaterialSidecar(path);
      },
      availableTextures,
      ...(graphNames ? { sharedGraphMaterialNames: graphNames } : {}),
    };
    let resolved: ResolvedMaterial = resolveMaterial(materialRequest);
    options.onMaterialResolved?.(materialRequest);
    {
      // Same-named exports in several folders and none beside the mesh: the pick is the last indexed, not evidence.
      const copies = materialAssets.matAll?.get(lookupName) ?? [];
      const chosen = materialAssets.mat.get(lookupName);
      if (!options.materialAssets?.has(name) && copies.length > 1 && chosen !== undefined && dirname(chosen) !== dirname(options.gltfPath)) {
        const folders = [...new Set(copies.map((path) => basename(dirname(path))))].join(", ");
        resolved = {
          ...resolved,
          limitations: [...resolved.limitations, `Material ${lookupName} was exported from ${copies.length} folders (${folders}) and none beside this mesh; the one in ${basename(dirname(chosen))} was used, which may not be the package the mesh references.`],
        };
      }
    }
    let effect: ImportedMaterialEffect | undefined;
    if (unresolvedSection && (await options.namesEngineDefaultMaterial?.())) {
      effect = {
        kind: "engine-default-material",
        reason: "the mesh package names Unreal's default material (/Engine/EngineMaterials/WorldGridMaterial) and no pack material for this slot; the engine's default is not part of the pack, and a particle emitter or placing actor supplies the real material at runtime",
      };
    }
    const graphRequest = (probe: boolean): GraphBakeRequest => ({
      materialName: material.getName(),
      lookupName,
      assets: materialAssets,
      probe,
      // A translucent or masked section keeps its cut-out in the graph's Opacity or OpacityMask pin.
      ...(resolved.alphaMode === "BLEND" ? { alpha: "opacity" as const } : resolved.alphaMode === "MASK" ? { alpha: "opacityMask" as const } : {}),
      // Unreal feeds white to VertexColor for a mesh without a colour buffer. One painted primitive using the
      // section makes that claim false, so then VertexColor stays unsupported and is named in the report.
      ...(usesVertexColors(root, material) ? {} : { vertexColor: [1, 1, 1, 1] as const }),
      surface: () => surfaceOf(root, material),
      readProps: (propsName) => {
        const propsPath = materialAssets.props.get(propsName);
        return propsPath === undefined ? undefined : readMaterialSidecar(propsPath);
      },
    });
    // A translucent section with a base-colour texture is not otherwise looked at by the graph baker, yet an unlit or
    // additive effect names its emissive mask `Diffuse`. Ask the graph whether Emissive is its only colour output.
    if (
      options.graphBaker &&
      resolved.alphaMode === "BLEND" &&
      resolved.bindings.some((binding) => binding.slot === "baseColor") &&
      !hasNamedFallback(material.getName())
    ) {
      const probed = await options.graphBaker(graphRequest(true));
      if (probed.effect) {
        effect = { kind: "emissive", reason: probed.effect.reason };
        const emissiveMask = resolved.bindings.find((binding) => binding.slot === "baseColor" && probed.effect!.textures.includes(binding.texture));
        resolved = {
          ...resolved,
          bindings: [
            ...resolved.bindings
              // An unlit effect has no specular: the `SpecPower` the exporter read from the same mask is not roughness.
              .filter((binding) => !(emissiveMask && binding.slot === "metallicRoughness" && binding.texture === emissiveMask.texture))
              .map((binding) => (binding === emissiveMask ? { ...binding, slot: "emissive" as const } : binding)),
            // glTF has no additive blending, so the mask also drives alpha: bright where the effect emits, clear where it
            // does not, instead of an opaque sheet. An approximation, named by source "effect" and by the limitation below.
            ...(emissiveMask
              ? [{ slot: "baseColor" as const, texture: emissiveMask.texture, secondaryTexture: emissiveMask.texture, source: "effect" as const, confidence: "heuristic" as const, transform: "redToBaseColorAlpha" as const }]
              : []),
          ],
          limitations: [
            ...resolved.limitations,
            ...(emissiveMask ? [`${emissiveMask.texture} is an emissive mask: it is bound as emissive, and its red channel also drives alpha because glTF has no additive blending.`] : []),
          ],
        };
      }
    }
    const authored = await options.sourceMaterial?.(name, lookupName);
    let authoredAoCoordinatesMatch = false;
    let authoredAoBaseBinding: ResolvedMaterial["bindings"][number] | undefined;
    let authoredAoCoordinateLimitation: string | undefined;
    if (authored) {
      const limitations = [...resolved.limitations, ...authored.limitations];
      let roughnessFactor = resolved.roughnessFactor;
      const roughness = authored.channels.Roughness;
      if (roughness?.kind === "scalar") {
        roughnessFactor = Math.min(1, Math.max(0, roughness.value));
        limitations.push(`Source authored Roughness ${roughness.value}; glTF factor normalized to ${roughnessFactor}, without a claim about Unreal shader saturation.`);
      } else if (roughness) limitations.push(`Source Roughness texture ${roughness.path}: channel/product packaging unsupported.`);
      const metallic = authored.channels.Metallic;
      if (metallic) limitations.push(`Source Metallic ${metallic.kind === "scalar" ? metallic.value : `${metallic.path}.${"RGBA"[metallic.channel]}`}: recovered authored value is not applied by this bounded packaging subset; prior metallic reconstruction retained.`);
      const bindings = [...resolved.bindings];
      const ao = authored.channels.AmbientOcclusion;
      if (ao?.kind === "texture") {
        bindings.splice(0, bindings.length, ...bindings.filter((binding) => binding.slot !== "occlusion"));
        material.setOcclusionTexture(null);
        const aoName = ao.path.slice(ao.path.lastIndexOf(".") + 1);
        const base = bindings.find((binding) => binding.slot === "baseColor");
        const samples = base ? authored.baseColorSamples.filter((s) => s.path.slice(s.path.lastIndexOf(".") + 1) === base.texture) : [];
        const exactTexturePaths = new Set(samples.map((s) => s.path));
        const matching = samples.length > 0 && exactTexturePaths.size === 1 && samples.every((s) => sameSourceCoordinates(ao.coordinates, s.coordinates));
        if (ao.sampling.status !== "linear") limitations.push(`Source AmbientOcclusion ${ao.path}.R withheld: ${ao.sampling.reason}. Raw linear glTF AO would invent source color interpretation; filename AO bindings were withheld too.`);
        else if (ao.factor !== 1) limitations.push(`Source AmbientOcclusion ${ao.path}.RGBA[${ao.channel}] multiplied by ${ao.factor}: nonidentity pixel multiplication unsupported; occlusionStrength is not equivalent.`);
        else if (ao.channel !== 0) limitations.push(`Source AmbientOcclusion ${ao.path}: channel ${ao.channel} packing unsupported.`);
        else if (materialAssets.ambiguousPng?.has(aoName) || (base && materialAssets.ambiguousPng?.has(base.texture))) limitations.push(`Source AmbientOcclusion ${ao.path}: ambiguous exported PNG basename ${materialAssets.ambiguousPng?.has(aoName) ? aoName : base!.texture}; exact source pixels cannot be selected.`);
        else if (!matching) limitations.push(`Source AmbientOcclusion ${ao.path}: coordinates do not establish identity with the currently bound source albedo sampler.`);
        else if (ao.coordinates.kind === "explicit" && (ao.coordinates.u !== 1 || ao.coordinates.v !== 1)) limitations.push(`Source AmbientOcclusion ${ao.path}: explicit UV tiling requires an established consumer transform; unsupported.`);
        else if (!availableTextures.has(aoName)) limitations.push(`Source AmbientOcclusion exact texture ${ao.path} was not exported.`);
        else {
          // TextureInfo is applied after the existing base-colour binding has established its
          // consumer coordinate. An omitted Unreal default is never converted into native UV0.
          authoredAoCoordinatesMatch = true;
          authoredAoBaseBinding = base;
          bindings.splice(0, bindings.length, ...bindings.filter((binding) => binding.slot !== "occlusion"));
          bindings.push({ slot: "occlusion", texture: aoName, source: "authored-source", confidence: "exact", transform: "none" });
          if (ao.coordinates.kind === "implicit") authoredAoCoordinateLimitation = `Source AmbientOcclusion coordinates match the bound albedo's same-class omitted coordinate descriptor; effective Unreal coordinate default remains unresolved. Reused existing glTF albedo TextureInfo.`;
          else if (ao.coordinates.kind === "explicit") authoredAoCoordinateLimitation = `Source AmbientOcclusion matches albedo source coordinate ${ao.coordinates.index}; reused existing glTF albedo mapping. Applying that Unreal index to the consumer albedo is unsupported.`;
        }
      } else if (ao) limitations.push(`Source AmbientOcclusion constant ${ao.value}: scalar occlusion packaging unsupported.`);
      resolved = { ...resolved, bindings, roughnessFactor, limitations };
    }

    // UE Viewer's exporter writes a per-section debug colour. Whether or not a texture replaces
    // it, it never survives into the output: a red/green/blue tint reported as a material is the
    // exact false success this importer exists to prevent.
    material.setBaseColorFactor([1, 1, 1, 1]);
    material.setMetallicFactor(0);
    material.setRoughnessFactor(0.8);
    material.setAlphaMode(resolved.alphaMode);
    if (resolved.alphaMode === "MASK") material.setAlphaCutoff(resolved.alphaCutoff ?? 0.333);
    material.setDoubleSided(resolved.doubleSided);

    const ordered = [...resolved.bindings].sort(
      (left, right) => SLOT_ORDER.indexOf(left.slot) - SLOT_ORDER.indexOf(right.slot),
    );
    const packagingLimitations = [...resolved.limitations];
    let authoredAoApplied = false;
    let authoredAoBaseAttached = false;
    const sidecarTextures: string[] = [];
    for (const unsupported of resolved.unsupported) {
      const source = materialAssets.png.get(unsupported.texture);
      if (!source) continue;
      sidecarTextures.push(unsupported.texture);
      options.sidecars?.set(unsupported.texture, source);
    }
    for (const binding of ordered) {
      const source = materialAssets.png.get(binding.texture);
      if (!source) continue;
      // A vivid, uncorrelated leaf atlas (a fern frond with green blades and red-brown tips) fails the albedo statistics, but
      // a texture named as a colour map and cut out through a packed opacity map of its own set is the leaf colour (UE Viewer
      // wired it, or the filename rule paired it): the packed masks this check exists for are never masked foliage cards.
      const namedColourCutout =
        binding.source !== "effect" && binding.secondaryTexture !== undefined && resolved.alphaMode !== "OPAQUE" && isColourTexture(binding.texture);
      if (binding.slot === "baseColor" && binding.source !== "effect" && !namedColourCutout) {
        const verdict = await classifyAlbedo(await readFile(source));
        if (!verdict.isAlbedo) {
          // Not a photograph of a surface. Leave the slot on its neutral fallback and hand the
          // pixels to the game instead of painting the model with a mask.
          rejectedMasks.push({
            texture: binding.texture,
            reason: `packed mask, not a base colour (saturation ${verdict.saturation.toFixed(2)}, channel correlation ${verdict.channelCorrelation.toFixed(2)})`,
          });
          if (!sidecarTextures.includes(binding.texture)) sidecarTextures.push(binding.texture);
          options.sidecars?.set(binding.texture, source);
          continue;
        }
      }
      const secondarySource = binding.secondaryTexture
        ? materialAssets.png.get(binding.secondaryTexture)
        : undefined;
      const key = `${source}|${secondarySource ?? ""}|${binding.transform}`;
      let texture = cache.get(key);
      if (!texture) {
        const produce = async (transform: TextureTransform, secondary: string | undefined) => {
          const read = async () => applyTextureTransform(await readFile(source), transform, options.maxTextureSize, secondary ? await readFile(secondary) : undefined);
          return options.imageCache ? options.imageCache.get(`${source}|${secondary ?? ""}|${transform}`, read) : read();
        };
        let image: { data: Buffer; mimeType: string };
        try {
          image = await produce(binding.transform, secondarySource);
        } catch (error) {
          // An inferred opacity map that cannot be composed (other aspect, unreadable) must not cost the model its colour.
          if ((binding.transform !== "redToBaseColorAlpha" && binding.transform !== "blueToBaseColorAlpha") || binding.source === "effect") throw error;
          image = await produce("none", undefined);
          packagingLimitations.push(`Opacity map ${binding.secondaryTexture ?? "?"} could not be composed into ${binding.texture}'s alpha (${error instanceof Error ? error.message : String(error)}); the base colour is bound without it.`);
        }
        texture = document
          .createTexture(`${binding.texture}${binding.transform === "none" ? "" : `_${binding.transform}`}`)
          .setImage(new Uint8Array(image.data))
          .setMimeType(image.mimeType);
        cache.set(key, texture);
      }
      attachTexture(material, binding, texture);
      // Thin cut-outs (needles, grass) lose coverage as mips average the mask toward its mean, and the averaged edge pixels
      // pull in the off-leaf colour around the cut-out. Unreal does neither for a mask with no mip chain, so neither do we.
      if (
        binding.slot === "baseColor" &&
        resolved.alphaMode !== "OPAQUE" &&
        (options.noMipmapTextures?.has(binding.secondaryTexture ?? "") === true || (binding.secondaryTexture === undefined && options.noMipmapTextures?.has(binding.texture) === true))
      ) {
        const info = material.getBaseColorTextureInfo();
        info?.setMinFilter(TextureInfo.MinFilter.LINEAR as 9729);
        info?.setMagFilter(TextureInfo.MagFilter.LINEAR as 9729);
        packagingLimitations.push(`${binding.secondaryTexture ?? binding.texture} has no mip chain in Unreal (TMGS_NoMipmaps): the base colour sampler is unmipmapped so the cut-out keeps its coverage.`);
      }
      if (options.proofSources && binding.transform === "none") {
        const paths = options.proofSources.get(binding.texture) ?? [];
        if (!paths.includes(source)) paths.push(source);
        options.proofSources.set(binding.texture, paths);
      }
      if (binding === authoredAoBaseBinding) authoredAoBaseAttached = true;
      if (binding.source === "authored-source" && binding.slot === "occlusion") {
        const baseInfo = material.getBaseColorTextureInfo();
        if (authoredAoBaseAttached && baseInfo && authoredAoCoordinatesMatch) {
          material.getOcclusionTextureInfo()?.setTexCoord(baseInfo.getTexCoord());
          material.setOcclusionStrength(1);
          authoredAoApplied = true;
          if (authoredAoCoordinateLimitation) packagingLimitations.push(authoredAoCoordinateLimitation);
        } else {
          material.setOcclusionTexture(null);
          packagingLimitations.push("Source AmbientOcclusion refused: its albedo reference was not bound, so relative coordinate identity cannot be applied.");
        }
      }
    }

    // PRD-538: colour that exists only in the material graph. Glass, mirrors and lights keep their named
    // fallbacks; everything else that has no base-colour texture asks the graph baker.
    const graphBindings: MaterialTextureBinding[] = [];
    let graphReport: ImportedMaterialSection["graph"];
    if (material.getBaseColorTexture() === null && options.graphBaker && !hasNamedFallback(material.getName())) {
      const outcome = await options.graphBaker(graphRequest(false));
      if (outcome.effect && !effect) effect = { kind: "emissive", reason: outcome.effect.reason };
      if (outcome.particle && !effect && outcome.status !== "baked") effect = { kind: "particle", reason: outcome.particle };
      if (outcome.status === "baked") {
        const binding: MaterialTextureBinding = {
          slot: "baseColor",
          texture: `${material.getName()}_graph_baseColor`,
          source: "graph",
          confidence: outcome.confidence,
          transform: "none",
        };
        // Sections with the same graph and parameters bake to the same PNG buffer, so they share one texture.
        const key = `graph|${createHash("sha256").update(outcome.png).digest("hex")}`;
        let texture = cache.get(key);
        if (!texture) {
          texture = document.createTexture(binding.texture).setImage(new Uint8Array(outcome.png)).setMimeType("image/png");
          cache.set(key, texture);
        }
        attachTexture(material, binding, texture);
        graphBindings.push(binding);
        packagingLimitations.push(...outcome.approximations);
        if (outcome.alpha?.binary && material.getAlphaMode() === "BLEND") {
          // A translucent material whose Opacity is a leaf-shaped mask is a cut-out. Sorted blending smears overlapping
          // cards over each other and the backdrop (grey, washed-out foliage), so it is exported as a masked card.
          material.setAlphaMode("MASK");
          material.setAlphaCutoff(0.5);
          packagingLimitations.push(
            `Opacity is a binary cut-out (${(outcome.alpha.opaqueShare * 100).toFixed(0)}% of texels opaque): exported as alphaMode MASK instead of BLEND, because blended overlapping cards render grey and unsorted.`,
          );
        }
        graphReport = { status: "baked", confidence: outcome.confidence, unsupportedNodes: [], approximations: [...outcome.approximations] };
      } else if (outcome.status === "unsupported") {
        graphReport = { status: "unsupported", unsupportedNodes: [...outcome.unsupported], approximations: [], reason: outcome.reason };
      } else {
        graphReport = { status: "unavailable", unsupportedNodes: [], approximations: [], reason: outcome.reason };
      }
    }

    const boundBaseColour = material.getBaseColorTexture() !== null;
    // An effect's emissive mask also drives alpha (above); the instance's colour factor has nothing to tint there.
    const effectBinding = ordered.some((binding) => binding.source === "effect");
    if (!boundBaseColour) {
      const materialName = material.getName().toLowerCase();
      if (materialName.includes("glass")) {
        material.setBaseColorFactor([0.65, 0.8, 0.95, 0.22]);
        material.setRoughnessFactor(0.1);
        material.setMetallicFactor(0);
        material.setAlphaMode("BLEND");
        material.setDoubleSided(true);
      } else if (materialName.includes("mirror")) {
        material.setBaseColorFactor([0.95, 0.95, 0.95, 1]);
        material.setRoughnessFactor(0.03);
        material.setMetallicFactor(1);
      } else if (/(?:^|_)light(?:_|$)/.test(materialName)) {
        material.setBaseColorFactor([1, 1, 0.9, 1]);
        material.setEmissiveFactor([1, 1, 0.85]);
      } else {
        // Explicit neutral fallback, never the exporter's debug colour.
        material.setBaseColorFactor([0.8, 0.8, 0.8, 1]);
      }
    }
    if (resolved.baseColorFactor && graphBindings.length === 0 && !effectBinding) {
      material.setBaseColorFactor([...resolved.baseColorFactor]);
      if (resolved.baseColorFactor[3] < 1 && material.getAlphaMode() === "OPAQUE") {
        material.setAlphaMode("BLEND");
      }
    } else if (resolved.baseColorFactor && resolved.baseColorFactor[3] < 1) {
      // A baked graph already contains its tints (multiplying the instance's colour in again would apply them twice)
      // and an emissive effect has no albedo tint to apply, but the instance's opacity still holds. Only alpha carries over.
      const [r, g, b] = material.getBaseColorFactor();
      material.setBaseColorFactor([r, g, b, resolved.baseColorFactor[3]]);
      if (material.getAlphaMode() === "OPAQUE") material.setAlphaMode("BLEND");
    }
    if (effect) packagingLimitations.push(effect.reason);
    if (resolved.emissiveFactor) material.setEmissiveFactor([...resolved.emissiveFactor]);
    if (resolved.metallicFactor !== undefined) material.setMetallicFactor(resolved.metallicFactor);
    if (authored?.channels.Roughness?.kind === "scalar") {
      const previous = material.getMetallicRoughnessTexture();
      const image = previous?.getImage();
      if (previous && image) {
        let texture = scalarRoughnessTextures.get(previous);
        if (!texture) {
          const transformed = await applyTextureTransform(Buffer.from(image), "roughnessToOne", undefined);
          texture = document.createTexture(`${previous.getName()}_roughnessToOne`).setImage(new Uint8Array(transformed.data)).setMimeType(transformed.mimeType);
          scalarRoughnessTextures.set(previous, texture);
        }
        material.setMetallicRoughnessTexture(texture);
        packagingLimitations.push("Source authored scalar roughness: prior roughness texture contribution replaced with G=1; packed metallic channel retained.");
      }
    }
    if (resolved.roughnessFactor !== undefined) material.setRoughnessFactor(resolved.roughnessFactor);
    // Unreal's `Specular` input is a dielectric F0 of 0.08 x Specular (0.5 gives the glTF default 0.04). A matte foliage
    // master with Specular 0.1 has F0 0.008, a fifth of glTF's default, so leaving the default adds a pale sheen that
    // washes the green out. Only a constant is applied; 0.5 (the engine default) changes nothing.
    const specular = authored?.channels.Specular;
    if (specular?.kind === "scalar" && Number.isFinite(specular.value) && specular.value >= 0) {
      const factor = Math.min(1, (0.08 * specular.value) / 0.04);
      if (Math.abs(factor - 1) > 1e-6) {
        const extension = document.createExtension(KHRMaterialsSpecular);
        material.setExtension("KHR_materials_specular", extension.createSpecular().setSpecularFactor(factor));
      }
    }

    sections.push({
      name: material.getName(),
      resolved: !unresolvedSection,
      sidecarTextures,
      bindings: [...ordered.filter((binding) => binding.source !== "authored-source" || binding.slot !== "occlusion" || authoredAoApplied), ...graphBindings].map((binding) => ({
        slot: binding.slot,
        texture: binding.texture,
        ...(binding.secondaryTexture ? { secondaryTexture: binding.secondaryTexture } : {}),
        source: binding.source,
        confidence: binding.confidence,
        transform: binding.transform,
        ...(binding.substitutedFrom ? { substitutedFrom: binding.substitutedFrom } : {}),
      })),
      unsupported: [...resolved.unsupported.map((entry) => ({ ...entry })), ...rejectedMasks.splice(0)],
      alphaMode: material.getAlphaMode(),
      ...(material.getAlphaMode() === "MASK" ? { alphaCutoff: material.getAlphaCutoff() } : {}),
      limitations: packagingLimitations,
      doubleSided: material.getDoubleSided(),
      factors: {
        baseColor: material.getBaseColorFactor(),
        emissive: material.getEmissiveFactor(),
        metallic: material.getMetallicFactor(),
        roughness: material.getRoughnessFactor(),
      },
      textured: boundBaseColour && !effectBinding,
      ...(effect ? { effect } : {}),
      ...(graphReport ? { graph: graphReport } : {}),
    });
  }

  let vertices = 0;
  let primitives = 0;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const mesh of root.listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      primitives += 1;
      const position = primitive.getAttribute("POSITION");
      if (!position) continue;
      const scale = options.geometryScale;
      const factors = typeof scale === "number" ? [scale, scale, scale] : scale;
      if (factors && factors.some((factor) => factor !== 1)) {
        const element = [0, 0, 0];
        for (let index = 0; index < position.getCount(); index += 1) {
          position.getElement(index, element);
          element[0] = (element[0] ?? 0) * factors[0]!;
          element[1] = (element[1] ?? 0) * factors[1]!;
          element[2] = (element[2] ?? 0) * factors[2]!;
          position.setElement(index, element);
        }
      }
      vertices += position.getCount();
      for (let axis = 0; axis < 3; axis += 1) {
        min[axis] = Math.min(min[axis] ?? Infinity, position.getMin([0, 0, 0])[axis] ?? 0);
        max[axis] = Math.max(max[axis] ?? -Infinity, position.getMax([0, 0, 0])[axis] ?? 0);
      }
      // UE Viewer writes a TANGENT accessor for these UE4 static meshes whose every element is
      // (0,0,0,1). glTF requires unit-length tangents, and a renderer handed a zero tangent
      // produces NaN under any normal map — the failure looks like a broken material, not a
      // broken attribute. Dropping the attribute is correct rather than lossy: three.js derives
      // the tangent frame from UV derivatives when none is supplied.
      const tangent = primitive.getAttribute("TANGENT");
      if (tangent) {
        const element = [0, 0, 0, 0];
        let degenerate = 0;
        for (let index = 0; index < tangent.getCount(); index += 1) {
          tangent.getElement(index, element);
          if (Math.hypot(element[0] ?? 0, element[1] ?? 0, element[2] ?? 0) < 1e-6) degenerate += 1;
        }
        if (degenerate > 0) {
          primitive.setAttribute("TANGENT", null);
          tangent.dispose();
          droppedTangents += degenerate;
        }
      }

      const seams = repairSeamMorphDeltas(primitive);
      repairedMorphDeltas += seams.repaired;
      conflictingMorphDeltas += seams.conflicting;

      if (options.keepAllUvSets) continue;
      // UE Viewer emits every Unreal UV channel, including lightmap sets no runtime material
      // reads. They are pure size in a source asset that a compiler will copy again.
      for (let set = 1; set < 8; set += 1) {
        const material = primitive.getMaterial();
        const usedInfos = material ? [material.getBaseColorTextureInfo(), material.getNormalTextureInfo(), material.getMetallicRoughnessTextureInfo(), material.getEmissiveTextureInfo(), material.getOcclusionTextureInfo()] : [];
        if (usedInfos.some((info) => info?.getTexCoord() === set)) continue;
        const semantic = `TEXCOORD_${set}`;
        const attribute = primitive.getAttribute(semantic);
        if (!attribute) continue;
        primitive.setAttribute(semantic, null);
        attribute.dispose();
        prunedUvSets += 1;
      }
    }
  }

  await mkdir(dirname(options.glbPath), { recursive: true });
  await io.write(options.glbPath, document);

  return {
    vertices,
    primitives,
    skins: root.listSkins().length,
    joints: root.listSkins().reduce((sum, skin) => sum + skin.listJoints().length, 0),
    morphTargets: root.listMeshes().reduce(
      (sum, mesh) => sum + mesh.listPrimitives().reduce((count, primitive) => count + primitive.listTargets().length, 0),
      0,
    ),
    animations: root.listAnimations().length,
    attachedPsa: psa.attached,
    existingPsa: psa.existing,
    incompatiblePsa: psa.incompatible,
    bounds: [
      Number.isFinite(max[0]) ? max[0] - (min[0] ?? 0) : 0,
      Number.isFinite(max[1]) ? max[1] - (min[1] ?? 0) : 0,
      Number.isFinite(max[2]) ? max[2] - (min[2] ?? 0) : 0,
    ],
    sections,
    prunedUvSets,
    droppedTangents,
    repairedMorphDeltas,
    conflictingMorphDeltas,
  };
}

/** The material sidecars are a few kilobytes each and `resolveMaterial` is synchronous by design:
 * the parent chain it walks is only known one file at a time. */
const textCache = new Map<string, string>();
function readMaterialSidecar(path: string): string | undefined {
  const cached = textCache.get(path);
  if (cached !== undefined) return cached;
  try {
    const text = readFileSync(path, "utf8");
    textCache.set(path, text);
    return text;
  } catch {
    return undefined;
  }
}

/**
 * A buffer view is interleaved when more than one attribute semantic reads from it — the same
 * definition ThreeNative's own native asset preflight uses. Byte stride alone is not the defect:
 * a one-attribute view may carry a stride and packages fine.
 */
export function interleavedBufferViews(glb: Buffer): number {
  const json = JSON.parse(
    glb.subarray(20, 20 + glb.readUInt32LE(12)).toString("utf8"),
  ) as {
    accessors?: { bufferView?: number }[];
    meshes?: { primitives?: { attributes?: Record<string, number> }[] }[];
  };
  const semanticsPerView = new Map<number, Set<string>>();
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      for (const [semantic, accessorIndex] of Object.entries(primitive.attributes ?? {})) {
        const view = json.accessors?.[accessorIndex]?.bufferView;
        if (view === undefined) continue;
        const seen = semanticsPerView.get(view) ?? new Set<string>();
        seen.add(semantic);
        semanticsPerView.set(view, seen);
      }
    }
  }
  let interleaved = 0;
  for (const seen of semanticsPerView.values()) if (seen.size > 1) interleaved += 1;
  return interleaved;
}

/** Re-reads a written GLB and fails the artifact when it does not hold up. */
export async function validateGlb(
  path: string,
  options: { readonly allowEmptyScene?: boolean } = {},
): Promise<{ bytes: number; sha256: string }> {
  const bytes = await readFile(path);
  if (bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67) {
    throw new ImportError("UNREAL_GLB_INVALID", `${basename(path)} is not a glTF binary container.`);
  }
  if (bytes.readUInt32LE(8) !== bytes.length) {
    throw new ImportError(
      "UNREAL_GLB_INVALID",
      `${basename(path)} declares ${bytes.readUInt32LE(8)} bytes but is ${bytes.length}.`,
    );
  }
  const io = separateLayoutIO();
  const document = await io.readBinary(new Uint8Array(bytes));
  const root = document.getRoot();
  const meshes = root.listMeshes();
  if (meshes.length === 0 && !options.allowEmptyScene) {
    throw new ImportError("UNREAL_GLB_INVALID", `${basename(path)} contains no mesh.`);
  }
  const hasVertices = meshes.length === 0 || meshes.some((mesh) =>
    mesh.listPrimitives().some((primitive) => (primitive.getAttribute("POSITION")?.getCount() ?? 0) > 0),
  );
  if (!hasVertices) {
    throw new ImportError("UNREAL_GLB_INVALID", `${basename(path)} contains no vertices.`);
  }
  const interleaved = interleavedBufferViews(bytes);
  if (interleaved > 0) {
    throw new ImportError(
      "UNREAL_GLB_INVALID",
      `${basename(path)} holds ${interleaved} interleaved buffer view${interleaved === 1 ? "" : "s"}; ThreeNative's native host fails createRenderPipeline on every mesh that uses one.`,
    );
  }
  for (const texture of root.listTextures()) {
    if ((texture.getImage()?.byteLength ?? 0) === 0) {
      throw new ImportError(
        "UNREAL_GLB_INVALID",
        `${basename(path)} references texture "${texture.getName()}" with no embedded image.`,
      );
    }
  }
  return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export interface AudioInspection {
  readonly extension: "wav" | "ogg" | "mp3" | "flac";
  readonly mimeType: string;
  readonly durationSeconds: number | undefined;
  readonly channels: number | undefined;
  readonly sampleRate: number | undefined;
}

export interface RadianceInspection {
  readonly width: number;
  readonly height: number;
  readonly pixelOffset: number;
}

/** Reads the ASCII envelope shared by flat and scanline-RLE Radiance RGBE files. */
export function inspectRadiance(data: Buffer): RadianceInspection | undefined {
  if (data.length < 32 || !data.subarray(0, 10).toString("ascii").startsWith("#?RADIANCE")) return undefined;
  const head = data.subarray(0, Math.min(data.length, 8_192)).toString("ascii");
  if (!/^FORMAT=32-bit_rle_rgbe$/m.test(head)) return undefined;
  const match = /(?:^|\n)-Y\s+(\d+)\s+\+X\s+(\d+)\r?\n/.exec(head);
  if (!match?.[1] || !match[2]) return undefined;
  const height = Number(match[1]);
  const width = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return undefined;
  return { width, height, pixelOffset: match.index + match[0].length };
}

/** Recognizes formats browser AudioContext decoders commonly accept; parses WAV metadata exactly. */
export function inspectWebAudio(data: Buffer): AudioInspection | undefined {
  if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WAVE") {
    let at = 12;
    let channels: number | undefined;
    let sampleRate: number | undefined;
    let byteRate: number | undefined;
    let sampleBytes: number | undefined;
    while (at + 8 <= data.length) {
      const id = data.subarray(at, at + 4).toString("ascii");
      const size = data.readUInt32LE(at + 4);
      const body = at + 8;
      if (body + size > data.length) return undefined;
      if (id === "fmt " && size >= 16) {
        channels = data.readUInt16LE(body + 2);
        sampleRate = data.readUInt32LE(body + 4);
        byteRate = data.readUInt32LE(body + 8);
      } else if (id === "data") sampleBytes = size;
      at = body + size + (size % 2);
    }
    if (!channels || !sampleRate || !byteRate || sampleBytes === undefined) return undefined;
    return {
      extension: "wav",
      mimeType: "audio/wav",
      durationSeconds: sampleBytes / byteRate,
      channels,
      sampleRate,
    };
  }
  if (data.length >= 4 && data.subarray(0, 4).toString("ascii") === "OggS") {
    return { extension: "ogg", mimeType: "audio/ogg", durationSeconds: undefined, channels: undefined, sampleRate: undefined };
  }
  if (
    data.length >= 3 &&
    (data.subarray(0, 3).toString("ascii") === "ID3" || (data[0] === 0xff && ((data[1] ?? 0) & 0xe0) === 0xe0))
  ) {
    return { extension: "mp3", mimeType: "audio/mpeg", durationSeconds: undefined, channels: undefined, sampleRate: undefined };
  }
  if (data.length >= 4 && data.subarray(0, 4).toString("ascii") === "fLaC") {
    return { extension: "flac", mimeType: "audio/flac", durationSeconds: undefined, channels: undefined, sampleRate: undefined };
  }
  return undefined;
}

async function freeBytes(path: string, override?: number): Promise<number> {
  if (override !== undefined) return override;
  try {
    const info = await statfsAsync(path);
    return Number(info.bavail) * Number(info.bsize);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** `Foo.uasset` is accompanied by `Foo.uexp`, `Foo.ubulk`, and `Foo.uptnl`; a partial import
 * reads every file of the stem it converts, and only files of that stem. */
function packageStem(file: string): string {
  return join(dirname(file), basename(file, extname(file)));
}

/** Source bytes a filtered import will actually read: the requested packages, their sidecars, and
 * the packages they name in their import tables — a mesh's materials and textures are separate
 * packages and hold most of a pack's bytes. Counting the whole tree instead refuses every
 * partial import on a full volume, and counting only the requested `.uasset` would let an import
 * start that cannot finish. */
async function importedPackageBytes(
  files: readonly { readonly path: string; readonly size: number }[],
  wanted: ReadonlySet<string>,
): Promise<number> {
  const groups = new Map<string, { primary: string; bytes: number }>();
  for (const file of files) {
    const stem = packageStem(file.path);
    const group = groups.get(stem) ?? { primary: file.path, bytes: 0 };
    group.bytes += file.size;
    if ([".uasset", ".umap"].includes(extname(file.path).toLowerCase())) group.primary = file.path;
    groups.set(stem, group);
  }
  const stemsByName = new Map<string, string[]>();
  for (const stem of groups.keys()) {
    const name = basename(stem);
    stemsByName.set(name, [...(stemsByName.get(name) ?? []), stem]);
  }
  let total = 0;
  const counted = new Set<string>();
  let frontier = [...groups.keys()].filter((stem) => wanted.has(basename(stem)));
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const stem of frontier) {
      counted.add(stem);
      total += groups.get(stem)!.bytes;
      // ponytail: a bounded byte scan for names, not a parsed import table. A name that merely
      // shares a string with the package counts its bytes; a name in another encoding does not.
      for (const name of await readPackageObjectNames(groups.get(stem)!.primary)) {
        for (const referenced of stemsByName.get(name) ?? []) {
          if (counted.has(referenced)) continue;
          next.push(referenced);
        }
      }
    }
    frontier = next;
  }
  return total;
}

/**
 * Why the modern converter produced nothing, in the terms that decide the next move: what it
 * printed (its last lines, not only the one it exits on), which engine wrote the package, and
 * whether the mesh is Nanite — the commonest reason a UE5 editor mesh has no render data.
 */
function describeModernFailure(
  stderr: string,
  packages: readonly {
    readonly entry: PackageClassification;
    readonly legacyFileVersion: number | undefined;
    readonly fileVersionUE4: number | undefined;
    readonly fileVersionUE5: number | undefined;
    readonly naniteHint: boolean;
  }[],
): string {
  const lines = stderr.trim().split(/\r?\n/).filter((line) => line.trim()).slice(-20);
  const versions = packages.map(
    ({ entry, legacyFileVersion, fileVersionUE4, fileVersionUE5, naniteHint }) =>
      `${entry.package} is ${legacyFileVersion !== undefined && legacyFileVersion <= -8 ? "UE5" : "UE4"} (legacy file version ${legacyFileVersion ?? "unknown"}), UE4 object version ${fileVersionUE4 ?? "unknown"}, UE5 object version ${fileVersionUE5 ?? "unknown"}; Nanite: ${naniteHint ? "likely (NaniteSettings present)" : "not detected"}`,
  );
  return [
    ...versions,
    ...(lines.length > 0 ? [`Converter output (last ${lines.length} lines):`, ...lines.map((line) => `  ${line.trim()}`)] : []),
  ].join(" ");
}

/**
 * Converts a local Unreal asset directory into self-contained source GLBs plus a provenance
 * report. Provider-independent: a pack downloaded by FabCLI and one unzipped by hand take the
 * same path, which is what makes an already-downloaded pack re-runnable.
 */
/**
 * The per-glTF-axis factor a mesh GLB is multiplied by. The uncooked MeshDescription converter writes centimetres with
 * glTF x, y, z = Unreal y, z, x; UE Viewer writes metres with glTF x, y, z = Unreal x, z, y. Either way the source
 * model's BuildScale3D (Unreal axes) is what Unreal multiplies the render data by.
 */
export function meshGeometryScale(
  fromMeshDescription: boolean,
  buildScale: readonly [number, number, number] | undefined,
): number | readonly [number, number, number] {
  if (fromMeshDescription) {
    return buildScale ? ([buildScale[1] * 0.01, buildScale[2] * 0.01, buildScale[0] * 0.01] as const) : 0.01;
  }
  return buildScale ? ([buildScale[0], buildScale[2], buildScale[1]] as const) : 1;
}

export async function importUnrealDirectory(
  request: ImportUnrealRequest,
): Promise<ImportReport> {
  const started = Date.now();
  assertSupportedHost();
  const environment = request.environment ?? process.env;
  const log = request.log ?? (() => {});
  const warnings: string[] = [...(request.extraWarnings ?? [])];

  let sourceDir: string;
  try {
    sourceDir = await realpath(resolve(request.sourceDir));
    if (!(await stat(sourceDir)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new ImportError(
      "UNREAL_SOURCE_NOT_FOUND",
      `"${request.sourceDir}" is not a readable directory of Unreal assets.`,
    );
  }
  const outputDir = resolve(request.outputDir);
  if (!isAbsolute(outputDir)) {
    throw new ImportError("UNREAL_OUTPUT_INVALID", "The import output directory must be absolute.");
  }
  // The converter's own default is LOD0 only; only a non-default request is forwarded to it.
  const requestedLods = [...new Set(request.lods ?? [0])].filter((lod) => lod >= 0).sort((a, b) => a - b);
  if (requestedLods.length === 0) requestedLods.push(0);
  const lodsArg = requestedLods.length === 1 && requestedLods[0] === 0 ? undefined : requestedLods.join(",");

  const files = await listFiles(sourceDir);
  const packages = files.filter((file) => [".uasset", ".umap"].includes(extname(file.path).toLowerCase()));
  if (packages.length === 0) {
    throw new ImportError(
      "UNREAL_SOURCE_EMPTY",
      `"${sourceDir}" contains no .uasset or .umap files.`,
    );
  }
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  // Only a single-package request is actually filtered: both converters take `--filter` for one
  // package alone and convert the whole tree otherwise, so two or more still need the whole tree.
  const neededBytes =
    request.onlyPackages?.length === 1 && request.onlyPackages[0]
      ? await importedPackageBytes(files, new Set(request.onlyPackages))
      : totalBytes;
  const sourceHash = await hashSourceTree(sourceDir, files);

  const umodel = request.umodel ?? (await ensureUmodel(environment, log));
  const cacheKey = createHash("sha256")
    .update(
      JSON.stringify({
        sourceHash,
        umodel: umodel.version,
        fabcli: request.fabcliVersion ?? null,
        importer: IMPORTER_VERSION,
        graphBake: request.graphBake !== false,
        engine: request.engine ?? null,
        listingId: request.listingId ?? null,
        maxTextureSize: request.maxTextureSize ?? null,
        only: request.onlyPackages ? [...request.onlyPackages].sort() : null,
        lods: lodsArg ?? null,
        uncookedConverter: request.uncookedConverter?.version ?? null,
        modernConverter: request.modernConverter?.version ?? null,
      }),
    )
    .digest("hex");

  const existingReportPath = join(outputDir, "import-report.json");
  const existing = await readFile(existingReportPath, "utf8").catch(() => undefined);
  if (existing !== undefined) {
    const parsed = JSON.parse(existing) as ImportReport;
    if (parsed.cacheKey === cacheKey) {
      log(`Reusing the existing import at ${outputDir}.`);
      return { ...parsed, reused: true };
    }
    throw new ImportError(
      "UNREAL_OUTPUT_COLLISION",
      `${outputDir} already holds a different import (cache key ${parsed.cacheKey.slice(0, 12)}…). Choose a new output directory; this importer never overwrites one.`,
    );
  }
  if (await stat(outputDir).then(() => true, () => false)) {
    const entries = await readdir(outputDir);
    if (entries.length > 0) {
      throw new ImportError(
        "UNREAL_OUTPUT_COLLISION",
        `${outputDir} is not empty and holds no import report. Choose a new output directory.`,
      );
    }
  }

  await sweepStaleStaging(cacheRoot(environment));
  const stagingRoot = join(cacheRoot(environment), cacheKey);
  await mkdir(stagingRoot, { recursive: true });
  // The cache key identifies reusable results, not ownership of mutable scratch space. Give every
  // invocation its own directory so identical concurrent imports cannot delete or mix each
  // other's converter output.
  const staging = await mkdtemp(join(stagingRoot, "run-"));
  const raw = join(staging, "raw");
  await mkdir(raw, { recursive: true });
  const promotionParent = dirname(outputDir);
  await mkdir(promotionParent, { recursive: true });
  // Unbounded scene assembly can temporarily hold model GLBs plus a source-sized aggregate GLB.
  // Staging and output may be different volumes, so checking only the cache volume is insufficient.
  const minimum = 2 * 1024 ** 3;
  const stagingRequired = neededBytes;
  const outputRequired = neededBytes * (request.maxTextureSize === undefined ? 2 : 1);
  const stagingDevice = (await stat(staging)).dev;
  const outputDevice = (await stat(promotionParent)).dev;
  const required = Math.max(
    stagingDevice === outputDevice ? stagingRequired + outputRequired : outputRequired,
    minimum,
  );
  const available = await freeBytes(promotionParent, request.freeSpaceBytes);
  if (available < required) {
    throw new ImportError(
      "UNREAL_DISK_SPACE",
      `The import needs about ${Math.ceil(required / 1024 ** 3)} GiB on the output volume; ${Math.floor(available / 1024 ** 3)} GiB is free at ${promotionParent}. Use --max-texture-size or choose an output on a larger volume.`,
    );
  }
  if (stagingDevice !== outputDevice) {
    const stagingAvailable = await freeBytes(staging, request.freeSpaceBytes);
    const separateStagingRequired = Math.max(stagingRequired, minimum);
    if (stagingAvailable < separateStagingRequired) {
      throw new ImportError(
        "UNREAL_DISK_SPACE",
        `The import needs about ${Math.ceil(separateStagingRequired / 1024 ** 3)} GiB of staging space; ${Math.floor(stagingAvailable / 1024 ** 3)} GiB is free at ${staging}.`,
      );
    }
  }

  const wanted = request.onlyPackages ? new Set(request.onlyPackages) : undefined;
  const candidates = packages
    .map((file) => ({
      file: file.path,
      package: basename(file.path, extname(file.path)),
      relative: relative(sourceDir, file.path).split(sep).join("/"),
      selector: relative(sourceDir, file.path).split(sep).join("/").slice(0, -extname(file.path).length),
      extension: extname(file.path).toLowerCase(),
    }))
    .filter((entry) => !wanted || wanted.has(entry.package));

  log(`Classifying ${candidates.length} Unreal packages…`);
  const concurrency = request.concurrency ?? Math.min(8, Math.max(2, candidates.length));
  const classifiedAll = await mapWithConcurrency<
    (typeof candidates)[number],
    PackageClassification
  >(candidates, concurrency, async (entry) => {
    const unsupported = UNSUPPORTED_EXTENSIONS.get(entry.extension);
    if (unsupported) {
      return {
        package: entry.relative,
        selector: entry.selector,
        file: entry.file,
        classes: [],
        meshKind: undefined,
        hasAnimation: false,
        hasTexture: false,
        hasCubemap: false,
        hasMaterial: false,
        hasSound: false,
        dataClass: undefined,
        textureStackClass: undefined,
        hasFont: false,
        hasBlueprintPrefab: false,
        paperClass: undefined,
        hasGroom: false,
        needsModernConverter: false,
        error: unsupported,
      };
    }
    try {
      const run = await runBounded(
        umodel.path,
        [`-path=${sourceDir}`, "-list", entry.selector],
        { timeoutMs: 300_000, maxOutputBytes: 16 * 1024 * 1024 },
      );
      const { classes } = parseUmodelList(run.stdout);
      const cooking = await readPackageCooking(entry.file);
      if (cooking?.materialHint && !classes.some((className) => className === "Material" || className === "MaterialInstanceConstant")) classes.push("Material");
      if (cooking?.levelHint && !classes.includes("Level")) classes.push("Level");
      const meshKind =
        classes.includes("SkeletalMesh")
          ? "skeletal"
          : classes.includes("StaticMesh")
            ? "static"
            : cooking?.meshKindHint;
      const isMapBuildData = classes.includes("MapBuildDataRegistry");
      // The name-table hints stand in for a listing UE Viewer could not produce. When it did list
      // the package, its classes win: a material instance names Texture2D and carries
      // AssetImportData too, and reading that as a texture drops the material entirely.
      const listed = run.code === 0 && classes.length > 0;
      const hasTexture = !isMapBuildData && (classes.includes("Texture2D") || (!listed && cooking?.textureHint === true));
      // MapBuildDataRegistry owns transient reflection-capture cubes that are tied to baked level
      // lighting. They are not standalone environment assets and cannot be meaningfully reused.
      const hasCubemap =
        !isMapBuildData && (classes.includes("TextureCube") || (!listed && cooking?.cubemapHint === true));
      const hasMaterial = classes.some((className) =>
        ["Material", "Material3", "MaterialInstance", "MaterialInstanceConstant"].includes(className),
      );
      const hasSound = classes.includes("SoundWave") || (!listed && cooking?.soundHint === true);
      const dataClass = classes.find((className) => DATA_ASSET_CLASSES.has(className)) ?? cooking?.dataClassHint;
      const textureStackClass =
        classes.find((className) => TEXTURE_STACK_CLASSES.has(className)) ?? cooking?.textureStackClassHint;
      const hasFont = classes.some((className) => className === "Font" || className === "FontFace") || cooking?.fontHint === true;
      const paperClass = classes.includes("PaperSprite") ? "PaperSprite"
        : classes.includes("PaperFlipbook") ? "PaperFlipbook"
        : classes.includes("PaperTileMap") ? "PaperTileMap"
        : classes.includes("PaperTileSet") ? "PaperTileSet"
        : undefined;
      // A hair description is editor-only bulk data, so it is decoded by the modern converter
      // whatever UE Viewer can say about the package.
      const hasGroom = classes.includes("GroomAsset") || cooking?.groomHint === true;
      const modernHeader = cooking.legacyFileVersion !== undefined && cooking.legacyFileVersion <= -8;
      const hasBlueprintPrefab = classes.includes("BlueprintGeneratedClass") || cooking?.blueprintPrefabHint === true;
      const needsModernConverter = modernHeader && (
        hasMaterial ||
        hasBlueprintPrefab ||
        (run.code !== 0 && (meshKind !== undefined || hasTexture || hasCubemap || hasSound || dataClass !== undefined || textureStackClass !== undefined || hasGroom))
      );
      // UE Viewer cannot list UE5 packages at all; when the name table shows an editor-only class
      // with nothing to import, report that class instead of a listing failure.
      const nonImportableClass = run.code !== 0 && !needsModernConverter ? cooking?.nonImportableClassHint : undefined;
      if (nonImportableClass && !classes.includes(nonImportableClass)) classes.push(nonImportableClass);
      return {
        package: entry.relative,
        selector: entry.selector,
        file: entry.file,
        classes,
        meshKind,
        hasAnimation:
          classes.some((className) => ["AnimSequence", "AnimSet", "MeshAnimation"].includes(className)) ||
          (classes.includes("Skeleton") && !classes.includes("SkeletalMesh")),
        hasTexture,
        hasCubemap,
        hasMaterial,
        hasSound,
        dataClass,
        textureStackClass,
        hasFont,
        hasBlueprintPrefab,
        paperClass,
        hasGroom,
        needsModernConverter,
        ...(hasTexture && cooking?.noMipmapsHint === true ? { noMipmaps: true } : {}),
        error:
          run.code === 0 || needsModernConverter || nonImportableClass !== undefined || hasFont || paperClass !== undefined || cooking?.levelHint === true
            ? undefined
            : `UE Viewer could not list the package (exit ${run.code}).`,
      };
    } catch (error) {
      return {
        package: entry.relative,
        selector: entry.selector,
        file: entry.file,
        classes: [],
        meshKind: undefined,
        hasAnimation: false,
        hasTexture: false,
        hasCubemap: false,
        hasMaterial: false,
        hasSound: false,
        dataClass: undefined,
        textureStackClass: undefined,
        hasFont: false,
        hasBlueprintPrefab: false,
        paperClass: undefined,
        hasGroom: false,
        needsModernConverter: false,
        error: error instanceof ToolchainError ? error.message : "UE Viewer failed to list the package.",
      };
    }
  });

  // World Partition keeps per-actor level data under __ExternalActors__/__ExternalObjects__. Those
  // packages can list mesh-class exports but are never standalone assets, so they are skipped
  // up front instead of being sent to a mesh converter and failing.
  const externalActorEntries = classifiedAll.filter((entry) => isWorldPartitionExternalPackage(entry.package));
  const externalActorFiles = new Set(externalActorEntries.map((entry) => entry.file));
  const classified = classifiedAll.filter((entry) => !externalActorFiles.has(entry.file));
  /** Texture basenames the editor builds no mip chain for; their sampler must not average them either. */
  const noMipmapTextures: ReadonlySet<string> = new Set(
    classified.filter((entry) => entry.noMipmaps === true).map((entry) => basename(entry.package, extname(entry.package))),
  );

  const meshPackages = classified.filter((entry) => entry.meshKind !== undefined && !entry.error);
  const animationPackages = classified.filter((entry) => entry.hasAnimation && !entry.error);
  // A Texture2D export nested in an offline UFont is its glyph atlas, not a standalone texture
  // asset. It is promoted with metrics below so it cannot produce a duplicate false failure.
  const texturePackages = classified.filter((entry) => entry.hasTexture && !entry.hasFont && !entry.error);
  const cubemapPackages = classified.filter((entry) => entry.hasCubemap && !entry.error);
  const materialPackages = classified.filter((entry) => entry.hasMaterial && !entry.error);
  // The Content directory defines a /Game namespace. Absolute roots separate downloaded
  // projects even when their canonical object paths and basenames happen to be identical.
  const sourceLocation = (file: string): { namespace: string; path: string } | undefined => {
    const parts = file.split(sep); const content = parts.lastIndexOf("Content");
    if (content < 0 || content >= parts.length - 1) return undefined;
    const namespace = parts.slice(0, content + 1).join(sep);
    const packageName = parts.slice(content + 1).join("/").slice(0, -extname(file).length);
    return { namespace, path: `/Game/${packageName}` };
  };
  // Export selection does not remove source dependencies. Index filenames from the existing
  // inventory, then read only the chosen material, exact parents and selected AO texture.
  const sourceFiles = new Map<string, Map<string, { file: string; size: number }[]>>();
  for (const entry of packages) {
    if (extname(entry.path).toLowerCase() !== ".uasset") continue;
    const location = sourceLocation(entry.path); if (!location) continue;
    const namespace = sourceFiles.get(location.namespace) ?? new Map<string, { file: string; size: number }[]>();
    const files = namespace.get(location.path) ?? []; files.push({ file: entry.path, size: entry.size });
    namespace.set(location.path, files); sourceFiles.set(location.namespace, namespace);
  }
  const sourcePackages = new Map<string, Map<string, SourcePackage>>();
  const sourcePackageLoads = new Map<string, Promise<SourcePackage>>();
  const loadSourcePackage = (namespaceName: string, path: string): Promise<SourcePackage> => {
    const key = `${namespaceName}\0${path}`; const cached = sourcePackageLoads.get(key); if (cached) return cached;
    const pending = (async (): Promise<SourcePackage> => {
      const matches = sourceFiles.get(namespaceName)?.get(path) ?? [];
      const entry = matches[0];
      const decoded: SourcePackage = matches.length !== 1 || !entry
        ? { status: "unsupported", path, reason: "Exact source package namespace unavailable or ambiguous" }
        : entry.size > 32 * 1024 * 1024
          ? { status: "unsupported", path, reason: "Source package exceeds bounded 32 MiB metadata reader" }
          : decodeMaterialPackage(await readFile(entry.file), path);
      const namespace = sourcePackages.get(namespaceName) ?? new Map<string, SourcePackage>();
      namespace.set(path, decoded); sourcePackages.set(namespaceName, namespace); return decoded;
    })();
    sourcePackageLoads.set(key, pending); return pending;
  };
  const sourceMaterialCache = new Map<string, Promise<SourceMaterial>>();
  const sourceForFile = async (file: string, objectPath?: string): Promise<SourceMaterial | undefined> => {
    const location = sourceLocation(file); if (!location) return undefined;
    const key = `${location.namespace}\0${location.path}\0${objectPath ?? ""}`; const cached = sourceMaterialCache.get(key); if (cached) return cached;
    const pending = (async () => {
      const source = await loadSourcePackage(location.namespace, location.path);
      const namespace = sourcePackages.get(location.namespace)!;
      let path = objectPath ?? `${location.path}.${basename(file, extname(file))}`;
      if (source.status === "decoded") {
        const roots = source.exports.filter((e) => (e.className === "Material" || e.className === "MaterialInstanceConstant") && (!objectPath || e.path === objectPath));
        if (roots.length !== 1) return { channels: {}, baseColorSamples: [], limitations: [`Authored source ${location.path}: material object unavailable or ambiguous; prior reconstruction retained.`] };
        let current = roots[0]!; path = current.path; const seen = new Set<string>();
        while (current.className === "MaterialInstanceConstant") {
          if (seen.has(current.path) || seen.size >= 64) throw new Error("Source parent cycle/depth"); seen.add(current.path);
          const parent = current.properties.find((p) => p.name === "Parent" && p.arrayIndex === 0);
          const reference = parent?.value as { path?: unknown } | undefined;
          if (parent?.unsupported || typeof reference?.path !== "string") break;
          const pkg = await loadSourcePackage(location.namespace, reference.path.split(".")[0]!);
          if (pkg.status !== "decoded") break;
          const next = pkg.exports.find((e) => e.path === reference.path); if (!next) break; current = next;
        }
      }
      let material = reduceSourceMaterial(namespace, path);
      const ao = material.channels.AmbientOcclusion;
      if (ao?.kind === "texture") {
        const texturePath = ao.path.split(".")[0]!;
        await loadSourcePackage(location.namespace, texturePath);
        material = reduceSourceMaterial(namespace, path);
      }
      return material;
    })();
    sourceMaterialCache.set(key, pending); return pending;
  };
  const sourceForMeshUnguarded = (file: string): ((name: string, lookup: string) => Promise<SourceMaterial | undefined>) => async (_name, lookup) => {
    const location = sourceLocation(file); if (!location) return undefined;
    const mesh = await loadSourcePackage(location.namespace, location.path);
    const references = mesh.status === "decoded" ? [...new Set(mesh.imports.filter((ref) => (ref.className === "Material" || ref.className === "MaterialInstanceConstant") && ref.name === lookup && ref.path?.startsWith("/Game/")).map((ref) => ref.path!))] : [];
    if (references.length > 1) return { channels: {}, baseColorSamples: [], limitations: [`Authored source material ${lookup}: ambiguous mesh material import references; prior reconstruction retained.`] };
    if (references.length === 1) {
      const objectPath = references[0]!;
      const files = sourceFiles.get(location.namespace)?.get(objectPath.split(".")[0]!) ?? [];
      if (files.length !== 1) return { channels: {}, baseColorSamples: [], limitations: [`Authored source material ${objectPath}: exact mesh import package unavailable or ambiguous; prior reconstruction retained.`] };
      return sourceForFile(files[0]!.file, objectPath);
    }
    const matches = [...(sourceFiles.get(location.namespace)?.values() ?? [])].flat().filter((entry) => basename(entry.file, extname(entry.file)) === lookup);
    if (matches.length === 0) return undefined;
    if (matches.length !== 1) return { channels: {}, baseColorSamples: [], limitations: [`Authored source material ${lookup}: ambiguous exact package namespace; prior reconstruction retained.`] };
    const material = await sourceForFile(matches[0]!.file);
    return material ? { ...material, limitations: [...material.limitations, `Authored source material ${lookup}: unique source basename fallback used because an exact mesh material import was not recovered${mesh.status === "unsupported" ? ` (${mesh.reason})` : ""}; canonical mesh routing remains unresolved.`] } : undefined;
  };
  // The authored-source reader only refines roughness/AO. A malformed, cyclic or oversized source
  // package must never abort a mesh import: it degrades to "no authored source" plus a limitation
  // on the section and one warning per import. This is the single boundary for every call site.
  let unreadableSourceWarned = false;
  const guardSource = async (read: () => Promise<SourceMaterial | undefined>): Promise<SourceMaterial | undefined> => {
    try { return await read(); } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 160);
      if (!unreadableSourceWarned) {
        unreadableSourceWarned = true;
        warnings.push(`Source material unreadable (${message}); authored roughness/AO not applied. Affected materials keep their prior reconstruction.`);
      }
      return { channels: {}, baseColorSamples: [], limitations: [`Source material unreadable (${message}); authored roughness/AO not applied`] };
    }
  };
  const sourceForMesh = (file: string): ((name: string, lookup: string) => Promise<SourceMaterial | undefined>) => {
    const read = sourceForMeshUnguarded(file);
    return (name, lookup) => guardSource(() => read(name, lookup));
  };
  const sourceForLibraryFile = (file: string): Promise<SourceMaterial | undefined> => guardSource(() => sourceForFile(file));
  // PRD-538: colour textures that only a material function references were never exported with the mesh.
  // Export exactly one such package on demand, serially, into the import's own staging directory.
  let textureIndex: Map<string, string[]> | undefined;
  let textureExports: Promise<unknown> = Promise.resolve();
  let textureExportCount = 0;
  let graphTextureConverter: Promise<ExternalTool> | undefined;
  const exportedTextures = new Map<string, Promise<string | undefined>>();
  const exportTexture = (name: string): Promise<string | undefined> => {
    const known = exportedTextures.get(name);
    if (known) return known;
    const run = textureExports.then(async (): Promise<string | undefined> => {
      if (!textureIndex) {
        textureIndex = new Map();
        for (const file of packages) {
          if (extname(file.path).toLowerCase() !== ".uasset") continue;
          const stem = basename(file.path, extname(file.path));
          textureIndex.set(stem, [...(textureIndex.get(stem) ?? []), file.path]);
        }
      }
      const matches = textureIndex.get(name) ?? [];
      // Two packages of one name cannot say which pixels the material meant.
      if (matches.length !== 1) {
        log(`Graph texture ${name}: ${matches.length === 0 ? "no source package" : "ambiguous source packages"}; not exported.`);
        return undefined;
      }
      const selector = relative(sourceDir, matches[0]!).split(sep).join("/").slice(0, -extname(matches[0]!).length);
      const nextDirectory = (): string => join(staging, "graph-textures", String(textureExportCount++).padStart(5, "0"));
      const viaUmodel = async (): Promise<string | undefined> => {
        const isolated = nextDirectory();
        // UE Viewer silently writes nothing when the output path grows past ~256 characters, and the
        // package's own folders are appended to it. A deep staging path is reached through a short
        // symlink (removed below); the files still land inside the staging directory.
        let link: string | undefined;
        try {
          await mkdir(isolated, { recursive: true });
          let out = isolated;
          if (isolated.length > 120) {
            link = join(tmpdir(), `tn-gt-${randomBytes(6).toString("hex")}`);
            await symlink(isolated, link);
            out = link;
          }
          const exportRun = await runBounded(umodel.path, [`-path=${sourceDir}`, "-export", "-png", `-out=${out}`, selector], {
            timeoutMs: 300_000,
            maxOutputBytes: 32 * 1024 * 1024,
          });
          if (exportRun.code !== 0) {
            log(`Graph texture ${name}: UE Viewer exited ${exportRun.code}.`);
            return undefined;
          }
          const png = (await indexExported(isolated)).png.get(name);
          if (!png) log(`Graph texture ${name}: UE Viewer wrote no PNG.`);
          return png;
        } catch (error) {
          log(`Graph texture ${name}: export failed (${error instanceof Error ? error.message : String(error)}).`);
          return undefined;
        } finally {
          if (link) await rm(link, { force: true });
        }
      };
      // UE5 packages are unreadable to UE Viewer: the modern converter decodes the one package into
      // its own staging directory (it names every texture Textures/<name>.png, hence the isolation).
      const viaConverter = async (): Promise<string | undefined> => {
        try {
          graphTextureConverter ??= request.modernConverter ? Promise.resolve(request.modernConverter) : ensureModernConverter(environment, log);
          const converter = await graphTextureConverter;
          const isolated = nextDirectory();
          const converted = await runModernConverter(converter.path, sourceDir, isolated, ["--filter", selector], {
            timeoutMs: 1_800_000,
            maxOutputBytes: 32 * 1024 * 1024,
          });
          if (converted.code !== 0) {
            const cause = modernConverterFailureCause(converted);
            log(`Graph texture ${name}: the modern converter exited ${converted.code}${cause ? `: ${cause}` : "."}`);
            return undefined;
          }
          const png = (await indexExported(isolated)).png.get(name);
          if (!png) log(`Graph texture ${name}: the modern converter wrote no PNG.`);
          return png;
        } catch (error) {
          log(`Graph texture ${name}: modern export failed (${error instanceof Error ? error.message : String(error)}).`);
          return undefined;
        }
      };
      const modernHeader = (await readPackageCooking(matches[0]!)).legacyFileVersion;
      if (modernHeader !== undefined && modernHeader <= -8) return viaConverter();
      return (await viaUmodel()) ?? viaConverter();
    });
    textureExports = run;
    exportedTextures.set(name, run);
    return run;
  };
  // PRD-538: lazy, so a run that never meets a colourless section never provisions or spawns the converter.
  const graphBaker = request.graphBake === false ? undefined : createGraphBaker({
    exportTexture,
    sourceDir,
    engine: request.engine,
    environment,
    log,
    modernConverter: request.modernConverter,
    maxTextureSize: request.maxTextureSize,
  });
  const soundPackages = classified.filter((entry) => entry.hasSound && !entry.error);
  const dataPackages = classified.filter((entry) => entry.dataClass !== undefined && !entry.error);
  const textureStackPackages = classified.filter((entry) => entry.textureStackClass !== undefined && !entry.error);
  const fontPackages = classified.filter((entry) => entry.hasFont && !entry.error);
  const offlineFontPackages = fontPackages.filter((entry) => entry.classes.includes("Font") && entry.classes.includes("Texture2D"));
  const paperPackages = classified.filter((entry) => entry.paperClass !== undefined && !entry.error);
  const groomPackages = classified.filter((entry) => entry.hasGroom && !entry.error);
  const levelCandidates = classified.filter(
    (entry) =>
      entry.file.toLowerCase().endsWith(".umap") &&
      entry.classes.includes("Level") &&
      !entry.error,
  );
  const levelCooking = await mapWithConcurrency(levelCandidates, concurrency, async (entry) => ({
    entry,
    ...(await readPackageCooking(entry.file)),
  }));
  const mapPackages = levelCooking
    .filter(
      ({ legacyFileVersion, fileVersionUE4 }) =>
        legacyFileVersion !== undefined && legacyFileVersion >= -7 && fileVersionUE4 !== undefined && fileVersionUE4 >= 517 && fileVersionUE4 <= 522,
    )
    .map(({ entry }) => entry);
  const modernMapPackages = levelCooking
    .filter(({ legacyFileVersion }) => legacyFileVersion !== undefined && legacyFileVersion <= -8)
    .map(({ entry }) => entry);
  const blueprintCandidates = classified.filter((entry) =>
    entry.file.toLowerCase().endsWith(".uasset") && entry.hasBlueprintPrefab && !entry.error,
  );
  const blueprintCooking = await mapWithConcurrency(blueprintCandidates, concurrency, async (entry) => ({
    entry,
    ...(await readPackageCooking(entry.file)),
  }));
  const modernPrefabPackages = blueprintCooking
    .filter(({ legacyFileVersion }) => legacyFileVersion !== undefined && legacyFileVersion <= -8)
    .map(({ entry }) => entry);
  const prefabFiles = new Set(modernPrefabPackages.map((entry) => entry.file));
  const unsupportedMaps = new Map<string, string>(
    levelCooking
      .filter(({ legacyFileVersion, fileVersionUE4 }) =>
        !(legacyFileVersion !== undefined && legacyFileVersion <= -8) &&
        (fileVersionUE4 === undefined || fileVersionUE4 < 517 || fileVersionUE4 > 522))
      .map(({ entry, fileVersionUE4 }): [string, string] => [
        entry.file,
        `Unreal level uses object version ${fileVersionUE4 ?? "unknown"}; engine-free scene reconstruction is verified for versions 517–522.`,
      ]),
  );
  const mapFiles = new Set([...mapPackages, ...modernMapPackages].map((entry) => entry.file));
  // A World Partition .umap may embed UStaticMesh exports for landscape/HLOD cells. Those are
  // level dependencies, not a second standalone mesh package for the map itself.
  const assetMeshPackages = meshPackages.filter((entry) => !mapFiles.has(entry.file));
  const skipped: { package: string; reason: string }[] = [];
  const failed: { package: string; reason: string }[] = [];
  for (const entry of externalActorEntries) {
    skipped.push({ package: entry.package, reason: WORLD_PARTITION_EXTERNAL_REASON });
  }
  for (const entry of classified) {
    if (
      (entry.meshKind !== undefined && !entry.error) ||
      (entry.hasAnimation && !entry.error) ||
      (entry.hasTexture && !entry.error) ||
      (entry.hasCubemap && !entry.error) ||
      (entry.hasMaterial && !entry.error) ||
      (entry.hasSound && !entry.error) ||
      (entry.dataClass !== undefined && !entry.error) ||
      (entry.textureStackClass !== undefined && !entry.error) ||
      (entry.hasFont && !entry.error) ||
      (entry.paperClass !== undefined && !entry.error) ||
      (entry.hasGroom && !entry.error) ||
      prefabFiles.has(entry.file) ||
      mapFiles.has(entry.file)
    ) continue;
    if (entry.error && !UNSUPPORTED_EXTENSIONS.has(extname(entry.file).toLowerCase())) {
      failed.push({ package: entry.package, reason: entry.error });
      continue;
    }
    const unsupportedClass = entry.classes.find((className) => UNSUPPORTED_CLASSES.has(className));
    skipped.push({
      package: entry.package,
      reason:
        entry.error ?? unsupportedMaps.get(entry.file) ??
        (extname(entry.file).toLowerCase() === ".umap"
          ? "Unreal level has no supported Level export to reconstruct"
          : unsupportedClass
          ? `unsupported Unreal-only content: ${UNSUPPORTED_CLASSES.get(unsupportedClass)}`
          : entry.classes.length === 0
            ? "no exportable object"
            : `carries no directly importable mesh, texture, or level (${summarizeClasses(entry.classes)})`),
    });
  }

  if (
    assetMeshPackages.length === 0 &&
    mapPackages.length === 0 &&
    modernMapPackages.length === 0 &&
    modernPrefabPackages.length === 0 &&
    texturePackages.length === 0 &&
    cubemapPackages.length === 0 &&
    materialPackages.length === 0 &&
    soundPackages.length === 0
    && dataPackages.length === 0 &&
    textureStackPackages.length === 0
    && fontPackages.length === 0
    && paperPackages.length === 0
    && groomPackages.length === 0
  ) {
    const animationOnly = animationPackages.length > 0
      ? ` Found ${animationPackages.length} animation package${animationPackages.length === 1 ? "" : "s"}, but no compatible SkeletalMesh to receive those tracks.`
      : "";
    throw new ImportError(
      "UNREAL_EXPORT_EMPTY",
      `No package under "${sourceDir}" contains a supported StaticMesh, SkeletalMesh, Texture2D, TextureCube, multidimensional texture, Material, SoundWave, Font, PaperSprite, PaperFlipbook, GroomAsset, structured data, or Level, so there is nothing to convert.${animationOnly}`,
    );
  }

  // An uncooked package lists as a StaticMesh and exports as nothing, so this has to be checked
  // before the export loop rather than inferred from its silence afterwards. Only a unanimous
  // verdict fails the import: one odd package among many is a package to skip, not a broken pack.
  const cooking = await mapWithConcurrency(assetMeshPackages, concurrency, async (entry) => ({
    entry,
    package: entry.package,
    ...(await readPackageCooking(entry.file)),
  }));
  const modernPackages = [
    ...cooking.filter(
      ({ entry, state, fileVersionUE4 }) =>
        entry.needsModernConverter ||
        (entry.meshKind === "skeletal" && state === "uncooked" && uncookedMeshRoute("skeletal", fileVersionUE4) === "modern"),
    ),
    // A hair description is editor-only bulk data in the package trailer, so its package goes
    // through the same converter run as the meshes.
    ...(await mapWithConcurrency(groomPackages, concurrency, async (entry) => ({
      entry,
      package: entry.package,
      ...(await readPackageCooking(entry.file)),
    }))),
  ];
  const modernTexturePackages = texturePackages.filter((entry) => entry.needsModernConverter);
  const modernMaterialPackages = materialPackages.filter((entry) => entry.needsModernConverter);
  const modernSoundPackages = soundPackages.filter((entry) => entry.needsModernConverter);
  const modernFiles = new Set(modernPackages.map(({ entry }) => entry.file));
  const exportableMeshPackages = assetMeshPackages.filter(
    (entry) => !modernFiles.has(entry.file),
  );
  const uncooked = cooking.filter(
    ({ entry, state }) => entry.meshKind === "static" && state === "uncooked" && !entry.needsModernConverter,
  );
  const uncookedMeshDescription = uncooked.filter(
    (entry) => uncookedMeshRoute("static", entry.fileVersionUE4) === "mesh-description",
  );
  const unsupportedUncooked = uncooked.filter((entry) => uncookedMeshRoute("static", entry.fileVersionUE4) === undefined);
  if (unsupportedUncooked.length > 0) {
    const versions = [...new Set(unsupportedUncooked.map((entry) => entry.fileVersionUE4 ?? "unknown"))];
    throw new ImportError(
      "UNREAL_SOURCE_UNSUPPORTED",
      `${unsupportedUncooked.length} uncooked static-mesh package${unsupportedUncooked.length === 1 ? " uses" : "s use"} UE4 object version ${versions.join(", ")}. UE Viewer reads versions below 517 and the engine-free MeshDescription path reads 517–522 (UE4.25–4.27-era source assets); refusing to guess at a different binary layout.`,
    );
  }

  /** UE Viewer's mesh export, in one place: the primary route for a mesh package, and the retry
   * for one the modern converter could not read. Returns the reason it failed, or undefined. */
  const exportMeshWithUmodel = async (
    entry: PackageClassification,
    out: string,
  ): Promise<string | undefined> => {
    const run = () =>
      runBounded(
        umodel.path,
        [`-path=${sourceDir}`, "-export", "-gltf", "-png", "-nooverwrite", `-out=${out}`, entry.selector],
        { timeoutMs: 1_800_000, maxOutputBytes: 32 * 1024 * 1024 },
      );
    try {
      // UE Viewer occasionally exits non-zero for one package under filesystem pressure even
      // though the same read-only export succeeds immediately afterward. One bounded retry keeps
      // a transient process failure from silently removing a mesh from an otherwise valid pack.
      let outcome = await run();
      if (outcome.code !== 0) outcome = await run();
      if (outcome.code !== 0) return `UE Viewer export exited ${outcome.code}.`;
      // UE Viewer names each section's material by raw index; the mesh's SectionInfoMap says which slot the editor used.
      if (entry.meshKind === "static") {
        const exported = join(out, `${entry.selector.replace(/^Content\//i, "")}.gltf`);
        const remapped = await remapMeshFileSectionMaterials(exported, entry.file);
        if (remapped > 0) log(`${basename(entry.selector)}: ${remapped} section material(s) taken from SectionInfoMap instead of UE Viewer's raw index.`);
      }
      return undefined;
    } catch (error) {
      return error instanceof ToolchainError ? error.message : "UE Viewer export failed.";
    }
  };

  // Packages share textures, so two exporters can write the same PNG at once and `-nooverwrite`
  // would see a half-written file as done. Listing is read-only and parallel; exporting is not.
  log(`Exporting ${exportableMeshPackages.length} static/skeletal mesh packages with UE Viewer…`);
  const exportFailures = await mapWithConcurrency(exportableMeshPackages, 1, async (entry) => {
    const reason = await exportMeshWithUmodel(entry, raw);
    return reason ? { package: entry.package, reason } : undefined;
  });
  for (const failure of exportFailures) if (failure) failed.push(failure);

  let assets = await indexExported(raw);
  log(`UE Viewer wrote ${assets.gltf.size} glTF meshes and ${assets.png.size} textures.`);

  // Mesh exports often bring their materials along, but a material-only pack has no mesh to
  // trigger that side effect. Export missing materials explicitly. Duplicate basenames are kept
  // in isolated directories so UE Viewer and our indexes cannot silently conflate packages.
  const materialNameCounts = new Map<string, number>();
  for (const entry of materialPackages) {
    const name = basename(entry.package, extname(entry.package));
    materialNameCounts.set(name, (materialNameCounts.get(name) ?? 0) + 1);
  }
  const materialAssetsByFile = new Map<string, ExportedAssets>();
  const materialFallbackPackages: PackageClassification[] = [];
  const materialsNeedingExport = materialPackages.filter((entry) => {
    if (entry.needsModernConverter) return false;
    const name = basename(entry.package, extname(entry.package));
    const reusable = materialNameCounts.get(name) === 1 && assets.mat.has(name) && assets.props.has(name);
    if (reusable) materialAssetsByFile.set(entry.file, assets);
    return !reusable;
  });
  if (materialsNeedingExport.length > 0) {
    const standaloneRaw = join(staging, "standalone-materials");
    await mkdir(standaloneRaw, { recursive: true });
    log(
      `Exporting ${materialsNeedingExport.length} standalone or duplicate-named Material package${materialsNeedingExport.length === 1 ? "" : "s"}…`,
    );
    const results = await mapWithConcurrency(materialsNeedingExport, 1, async (entry, index) => {
      const isolated = join(standaloneRaw, String(index).padStart(5, "0"));
      await mkdir(isolated, { recursive: true });
      try {
        const run = await runBounded(
          umodel.path,
          [`-path=${sourceDir}`, "-export", "-png", `-out=${isolated}`, entry.selector],
          { timeoutMs: 1_800_000, maxOutputBytes: 32 * 1024 * 1024 },
        );
        if (run.code !== 0) return { entry, reason: `UE Viewer material export exited ${run.code}.` };
        const exported = await indexExported(isolated);
        // UE Viewer intentionally ignores a Material whose graph has no texture parameters.
        // It is still useful as a named glass/light/mirror/neutral PBR swatch, and packageGlb's
        // explicit fallback makes that approximation visible instead of failing the whole pack.
        return { entry, exported };
      } catch (error) {
        return {
          entry,
          reason: error instanceof ToolchainError ? error.message : "UE Viewer material export failed.",
        };
      }
    });
    for (const result of results) {
      if (result.exported) {
        materialAssetsByFile.set(result.entry.file, result.exported);
        // A unique material exported here may also be referenced by a mesh whose export omitted
        // it. Duplicate names deliberately remain package-local.
        const name = basename(result.entry.package, extname(result.entry.package));
        if (materialNameCounts.get(name) === 1) assets = mergeExported(assets, result.exported);
      } else {
        materialFallbackPackages.push(result.entry);
      }
    }
  }

  // Preserve standalone textures as first-class outputs. Reuse images already emitted while
  // walking meshes when the package basename is unique; duplicate names must be exported into
  // isolated directories or UE Viewer's basename lookup would silently select the first one.
  const textureSources = new Map<string, string>();
  const cubemapSources = new Map<string, string>();
  const audioSources = new Map<string, string>();
  const dataSources = new Map<string, string>();
  const textureStackSources = new Map<string, string>();
  const offlineFontSources = new Map<string, string>();
  const paperSpriteSources: { entry: PackageClassification; descriptor: string }[] = [];
  const paperFlipbookSources = new Map<string, string>();
  const paperTileSources: { entry: PackageClassification; descriptor: string }[] = [];
  const textureNameCounts = new Map<string, number>();
  for (const entry of texturePackages) {
    if (entry.needsModernConverter) continue;
    const name = basename(entry.package, extname(entry.package));
    textureNameCounts.set(name, (textureNameCounts.get(name) ?? 0) + 1);
  }
  const texturesNeedingExport: PackageClassification[] = [];
  for (const entry of texturePackages) {
    if (entry.needsModernConverter) continue;
    const name = basename(entry.package, extname(entry.package));
    const shared = assets.png.get(name);
    if (textureNameCounts.get(name) === 1 && shared) textureSources.set(entry.file, shared);
    else texturesNeedingExport.push(entry);
  }
  if (texturesNeedingExport.length > 0) {
    const standaloneRaw = join(staging, "standalone-textures");
    await mkdir(standaloneRaw, { recursive: true });
    log(
      `Exporting ${texturesNeedingExport.length} standalone or duplicate-named Texture2D package${texturesNeedingExport.length === 1 ? "" : "s"}…`,
    );
    // UE Viewer uses process-global image codecs that can intermittently leave empty PNGs when
    // several exporter processes run together. Keep this narrow phase serial; packaging remains
    // concurrent and deterministic after all source images are complete.
    const results = await mapWithConcurrency(texturesNeedingExport, 1, async (entry, index) => {
      const name = basename(entry.package, extname(entry.package));
      const isolated = join(standaloneRaw, String(index).padStart(5, "0"));
      await mkdir(isolated, { recursive: true });
      try {
        const run = await runBounded(
          umodel.path,
          [`-path=${sourceDir}`, "-export", "-png", `-out=${isolated}`, entry.selector],
          { timeoutMs: 1_800_000, maxOutputBytes: 16 * 1024 * 1024 },
        );
        if (run.code !== 0) {
          return { entry, reason: `UE Viewer texture export exited ${run.code}.` };
        }
        const emitted = (await listFiles(isolated)).find(
          (file) => basename(file.path).toLowerCase() === `${name}.png`.toLowerCase(),
        );
        return emitted
          ? { entry, source: emitted.path }
          : { entry, reason: "UE Viewer recognized Texture2D but produced no PNG." };
      } catch (error) {
        return {
          entry,
          reason: error instanceof ToolchainError ? error.message : "UE Viewer texture export failed.",
        };
      }
    });
    for (const result of results) {
      if (result.source) textureSources.set(result.entry.file, result.source);
      else failed.push({ package: result.entry.package, reason: result.reason ?? "Texture export failed." });
    }
  }

  const legacySoundPackages = soundPackages.filter((entry) => !entry.needsModernConverter);
  if (legacySoundPackages.length > 0) {
    const standaloneRaw = join(staging, "standalone-audio");
    await mkdir(standaloneRaw, { recursive: true });
    log(`Exporting ${legacySoundPackages.length} SoundWave package${legacySoundPackages.length === 1 ? "" : "s"}…`);
    const results = await mapWithConcurrency(legacySoundPackages, Math.min(4, concurrency), async (entry, index) => {
      const name = basename(entry.package, extname(entry.package));
      const isolated = join(standaloneRaw, String(index).padStart(5, "0"));
      await mkdir(isolated, { recursive: true });
      try {
        const run = await runBounded(
          umodel.path,
          [`-path=${sourceDir}`, "-export", "-sounds", `-out=${isolated}`, entry.selector],
          { timeoutMs: 1_800_000, maxOutputBytes: 16 * 1024 * 1024 },
        );
        if (run.code !== 0) return { entry, reason: `UE Viewer sound export exited ${run.code}.` };
        const emitted = (await listFiles(isolated)).find(
          (file) => basename(file.path, extname(file.path)).toLowerCase() === name.toLowerCase() &&
            [".wav", ".ogg", ".mp3", ".flac"].includes(extname(file.path).toLowerCase()),
        );
        return emitted
          ? { entry, source: emitted.path }
          : { entry, reason: "UE Viewer recognized SoundWave but produced no web-decodable audio file." };
      } catch (error) {
        return {
          entry,
          reason: error instanceof ToolchainError ? error.message : "UE Viewer sound export failed.",
        };
      }
    });
    for (const result of results) {
      if (result.source) audioSources.set(result.entry.file, result.source);
      else failed.push({ package: result.entry.package, reason: result.reason ?? "Sound export failed." });
    }
  }

  const psaFiles: PsaFile[] = [];
  if (animationPackages.length > 0) {
    const animationRaw = join(staging, "animations");
    await mkdir(animationRaw, { recursive: true });
    log(`Exporting ${animationPackages.length} standalone animation packages as ActorX PSA…`);
    const animationFailures = await mapWithConcurrency(animationPackages, 1, async (entry) => {
      try {
        const run = await runBounded(
          umodel.path,
          [
            `-path=${sourceDir}`,
            "-export",
            "-psk",
            "-nooverwrite",
            `-out=${animationRaw}`,
            entry.selector,
          ],
          { timeoutMs: 1_800_000, maxOutputBytes: 32 * 1024 * 1024 },
        );
        if (run.code === 0) return undefined;
        // UE Viewer prints its reason last; without it every failure reads the same.
        const diagnostic = `${run.stdout}\n${run.stderr}`.trim().split(/\r?\n/).filter((line) => line.trim()).at(-1)?.trim();
        return {
          package: entry.package,
          reason: `UE Viewer animation export exited ${run.code}.${diagnostic ? ` ${diagnostic.slice(0, 300)}` : ""}`,
        };
      } catch (error) {
        return {
          package: entry.package,
          reason: error instanceof ToolchainError ? error.message : "UE Viewer animation export failed.",
        };
      }
    });
    for (const failure of animationFailures) if (failure) failed.push(failure);
    const animationAssets = await indexExported(animationRaw);
    for (const [name, path] of animationAssets.psa) {
      try {
        const parsed = parsePsa(await readFile(path));
        psaFiles.push(parsed);
        if (parsed.hasScaleKeys) {
          warnings.push(
            `${name}.psa contains ActorX scale keys; translation and rotation were converted, while per-frame bone scale remains unsupported.`,
          );
        }
      } catch (error) {
        failed.push({
          package: animationPackages.find((entry) => basename(entry.package, extname(entry.package)) === name)?.package ?? name,
          reason: `ActorX PSA conversion failed: ${error instanceof Error ? error.message : "unknown error"}`,
        });
      }
    }
    if (animationAssets.psa.size === 0 && animationFailures.every((entry) => entry === undefined)) {
      for (const entry of animationPackages) {
        failed.push({
          package: entry.package,
          reason: "UE Viewer recognized animation content but produced no ActorX PSA output.",
        });
      }
    }
  }

  let uncookedConverter: ExternalTool | undefined;
  let uncookedGlbs = new Map<string, string>();
  let modernConverter: ExternalTool | undefined;
  let modernGlbs = new Map<string, string>();
  let modernGroomPayloads = new Map<string, string[]>();
  /** Meshes UE Viewer exported after the modern converter failed on them. */
  const recoveredByUmodel = new Set<string>();
  /** Why a mesh the modern converter ran on still has no GLB, by package basename. */
  const modernMeshFailureReasons = new Map<string, string>();
  const modernSceneModelSources: {
    readonly entry: PackageClassification;
    readonly name: string;
    readonly glb: string;
    readonly assets: ExportedAssets;
  }[] = [];
  const sceneSources = join(staging, "scene-sources");
  const sceneSourcePaths = new Map<string, string>();
  const sceneSourcePathFor = (entry: PackageClassification): string =>
    assertContained(sceneSources, `${entry.package.slice(0, -extname(entry.package).length)}.scene-source.json`);
  if (uncookedMeshDescription.length > 0 || mapPackages.length > 0) {
    uncookedConverter = request.uncookedConverter ?? (await ensureUncookedConverter(environment, log));
    const uncookedRaw = join(staging, "uncooked");
    // Meshes and levels run as separate invocations. The Python tool parses every .umap under the
    // source tree while exporting scenes, so one level it cannot read (a UE5 package the header
    // check did not catch) must not take the meshes down with it.
    if (uncookedMeshDescription.length > 0) {
      const args = [sourceDir, "--export-dir", uncookedRaw, "--skip-textures"];
      if (request.onlyPackages?.length === 1 && request.onlyPackages[0]) {
        args.push("--filter", request.onlyPackages[0]);
      }
      log(`Decoding ${uncookedMeshDescription.length} uncooked MeshDescription package${uncookedMeshDescription.length === 1 ? "" : "s"}…`);
      const converted = await runBounded(uncookedConverter.path, args, {
        timeoutMs: 1_800_000,
        maxOutputBytes: 64 * 1024 * 1024,
      });
      if (converted.code !== 0) {
        throw new ToolchainError(
          "UNREAL_TOOL_FAILED",
          `The uncooked MeshDescription converter exited ${converted.code}; no partial output was promoted.`,
        );
      }
      uncookedGlbs = await indexGlbs(uncookedRaw);
      warnings.push(
        `Decoded ${uncookedMeshDescription.length} requested uncooked UE4 MeshDescription GLB${uncookedMeshDescription.length === 1 ? "" : "s"} without Unreal Engine; UE Viewer supplied their source textures and material metadata.`,
      );
    }
    if (mapPackages.length > 0) {
      const args = [sourceDir, "--export-dir", uncookedRaw, "--skip-export", "--scene-json-dir", sceneSources];
      log(`Decoding ${mapPackages.length} Unreal level${mapPackages.length === 1 ? "" : "s"}…`);
      const converted = await runBounded(uncookedConverter.path, args, {
        timeoutMs: 1_800_000,
        maxOutputBytes: 64 * 1024 * 1024,
      });
      if (converted.code === 0) {
        for (const entry of mapPackages) {
          sceneSourcePaths.set(entry.file, join(sceneSources, `${basename(entry.package, extname(entry.package))}.scene-source.json`));
        }
      } else {
        const detail = `${converted.stderr}\n${converted.stdout}`
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .pop();
        const reason = `The uncooked scene converter exited ${converted.code}${detail ? `: ${detail.slice(0, 160)}` : ""}`;
        warnings.push(
          `Scene reconstruction failed (${reason}); ${mapPackages.length} level${mapPackages.length === 1 ? "" : "s"} skipped.`,
        );
        for (const entry of mapPackages) failed.push({ package: entry.package, reason: `Scene reconstruction failed: ${reason}` });
      }
    }
  }
  const uncookedNames = new Set(uncookedMeshDescription.map((entry) => basename(entry.package, extname(entry.package))));
  const modernAssetCount = modernPackages.length;
  if (modernAssetCount > 0) {
    modernConverter = request.modernConverter ?? (await ensureModernConverter(environment, log));
    const modernRaw = join(staging, "modern");
    const args: string[] = [];
    if (request.onlyPackages?.length === 1 && request.onlyPackages[0]) {
      args.push("--filter", request.onlyPackages[0]);
    }
    if (lodsArg) args.push("--lods", lodsArg);
    log(`Decoding ${modernAssetCount} modern UE5 asset package${modernAssetCount === 1 ? "" : "s"}…`);
    const converted = await runModernConverter(modernConverter.path, sourceDir, modernRaw, args, {
      timeoutMs: 1_800_000,
      maxOutputBytes: 64 * 1024 * 1024,
    });
    if (converted.code !== 0) {
      // A static mesh old enough for UE Viewer never needed the modern converter, so one
      // converter crash must not take a mesh UE Viewer can read down with it. That fallback is only
      // honest when it covers everything: recovering part of the request would drop the rest
      // silently, so anything UE Viewer cannot supply reports the converter's own diagnostic.
      const retryable = modernPackages.filter(
        ({ entry, legacyFileVersion, fileVersionUE4 }) =>
          (entry.meshKind === "static" && uncookedMeshRoute("static", fileVersionUE4) === "umodel") ||
          (entry.meshKind === "skeletal" && umodelCanRetry(entry.meshKind, legacyFileVersion)),
      );
      const retried = await mapWithConcurrency(retryable, 1, async ({ entry }) => ({
        entry,
        reason: await exportMeshWithUmodel(entry, raw),
      }));
      const incomplete = retried.find((result) => result.reason !== undefined);
      if (retryable.length !== modernPackages.length || incomplete) {
        throw new ToolchainError(
          "UNREAL_TOOL_FAILED",
          `The modern UE5 asset converter exited ${converted.code}; no partial output was promoted. ${describeModernFailure(converted.stderr, modernPackages)}`,
        );
      }
      for (const result of retried) {
        recoveredByUmodel.add(basename(result.entry.package, extname(result.entry.package)));
      }
      assets = mergeExported(assets, await indexExported(raw));
      warnings.push(
        `The modern UE5 asset converter exited ${converted.code}; UE Viewer decoded ${recoveredByUmodel.size} mesh package${recoveredByUmodel.size === 1 ? "" : "s"} it could read itself.`,
      );
    } else {
      modernGlbs = await indexGlbs(modernRaw);
      modernGroomPayloads = await indexGroomPayloads(modernRaw);
      assets = mergeExported(assets, await indexExported(modernRaw));
      warnings.push(
        `Decoded ${modernAssetCount} requested modern UE5 asset package${modernAssetCount === 1 ? "" : "s"} without Unreal Engine.`,
      );
      // The converter exits zero when it wrote other packages, so a mesh it could not read is
      // only visible as a missing GLB. Name its cause, and give UE Viewer the chance to read it.
      const converterCauses = parseModernMeshFailures(converted.stderr);
      const missingMeshes = modernPackages.filter(
        ({ entry }) => entry.meshKind !== undefined && !modernGlbs.has(basename(entry.package, extname(entry.package))),
      );
      for (const { entry, legacyFileVersion } of missingMeshes) {
        const name = basename(entry.package, extname(entry.package));
        const cause = converterCauses.get(name);
        if (!umodelCanRetry(entry.meshKind, legacyFileVersion)) {
          if (cause) modernMeshFailureReasons.set(name, cause);
          continue;
        }
        const retried = await exportMeshWithUmodel(entry, raw);
        if (retried === undefined && (await indexExported(raw)).gltf.has(name)) {
          recoveredByUmodel.add(name);
        } else {
          modernMeshFailureReasons.set(
            name,
            [cause, `UE Viewer retry: ${retried ?? "it wrote no glTF"}`].filter(Boolean).join("; "),
          );
        }
      }
      if (recoveredByUmodel.size > 0) {
        assets = mergeExported(assets, await indexExported(raw));
        warnings.push(
          `The modern UE5 asset converter wrote no GLB for ${recoveredByUmodel.size} mesh package${recoveredByUmodel.size === 1 ? "" : "s"}; UE Viewer decoded ${recoveredByUmodel.size === 1 ? "it" : "them"} instead.`,
        );
      }
    }
  }
  if (modernTexturePackages.length > 0) {
    modernConverter ??= request.modernConverter ?? (await ensureModernConverter(environment, log));
    const modernTextureRoot = join(staging, "modern-textures");
    await mkdir(modernTextureRoot, { recursive: true });
    log(`Decoding ${modernTexturePackages.length} modern UE5 texture package${modernTexturePackages.length === 1 ? "" : "s"}…`);
    // The converter writes every texture to Textures/<name>.png, so one run holding two packages
    // that share a basename leaves both pointing at whichever was exported last. Isolated
    // directories and a relative-path filter are the only way each entry gets its own pixels.
    const results = await mapWithConcurrency(modernTexturePackages, Math.min(4, concurrency), async (entry, index) => {
      const name = basename(entry.package, extname(entry.package));
      const isolated = join(modernTextureRoot, String(index).padStart(5, "0"));
      await mkdir(isolated, { recursive: true });
      const converted = await runModernConverter(
        modernConverter!.path,
        sourceDir,
        isolated,
        ["--filter", entry.selector],
        { timeoutMs: 1_800_000, maxOutputBytes: 32 * 1024 * 1024 },
      );
      if (converted.code !== 0) {
        const cause = modernConverterFailureCause(converted);
        return { entry, reason: `The modern UE5 texture converter exited ${converted.code}${cause ? `: ${cause}` : "."}` };
      }
      const exported = await indexExported(isolated);
      const source = exported.png.get(name);
      return source
        ? { entry, source, exported }
        : { entry, reason: "The modern UE5 texture converter produced no PNG for this package." };
    });
    for (const result of results) {
      if (result.exported) {
        // Material texture bindings resolve by name, so the isolated exports still feed the
        // shared index exactly as the batched run used to.
        assets = mergeExported(assets, result.exported);
        textureSources.set(result.entry.file, result.source!);
      } else {
        failed.push({ package: result.entry.package, reason: result.reason ?? "Modern texture conversion failed." });
      }
    }
    warnings.push(
      `Decoded ${modernTexturePackages.length} requested modern UE5 texture package${modernTexturePackages.length === 1 ? "" : "s"} without Unreal Engine.`,
    );
  }
  if (modernMapPackages.length > 0) {
    modernConverter ??= request.modernConverter ?? (await ensureModernConverter(environment, log));
    const mapRoot = join(staging, "modern-scenes");
    await mkdir(mapRoot, { recursive: true });
    await mkdir(sceneSources, { recursive: true });
    log(`Decoding ${modernMapPackages.length} modern Unreal level${modernMapPackages.length === 1 ? "" : "s"}…`);
    const results = await mapWithConcurrency(modernMapPackages, Math.min(2, concurrency), async (entry, index) => {
      const name = basename(entry.package, extname(entry.package));
      const isolated = join(mapRoot, String(index).padStart(5, "0"));
      await mkdir(isolated, { recursive: true });
      const converted = await runModernConverter(
        modernConverter!.path,
        sourceDir,
        isolated,
        ["--filter", entry.selector],
        { timeoutMs: 1_800_000, maxOutputBytes: 64 * 1024 * 1024 },
      );
      if (converted.code !== 0) return { entry, spriteDescriptors: [] as string[], modelSources: [] as { name: string; glb: string }[], reason: `The modern level converter exited ${converted.code}.` };
      const emitted = await listFiles(isolated);
      const scene = emitted.find((file) => basename(file.path).toLowerCase() === `${name}.scene-source.json`.toLowerCase())?.path;
      const spriteDescriptors = emitted.filter((file) => file.path.toLowerCase().endsWith(".sprite.json")).map((file) => file.path);
      const glbs = await indexGlbs(isolated);
      const modelSources = [...glbs].map(([modelName, glb]) => ({ name: modelName, glb }));
      const exported = await indexExported(isolated);
      return scene ? { entry, scene, spriteDescriptors, modelSources, exported } : { entry, spriteDescriptors, modelSources, exported, reason: "The modern level converter produced no scene descriptor." };
    });
    for (const result of results) {
      for (const descriptor of result.spriteDescriptors) paperSpriteSources.push({ entry: result.entry, descriptor });
      if (result.exported) {
        for (const model of result.modelSources) modernSceneModelSources.push({ entry: result.entry, ...model, assets: result.exported });
      }
      if (result.scene) {
        const target = sceneSourcePathFor(result.entry);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, await readFile(result.scene));
        sceneSourcePaths.set(result.entry.file, target);
      }
      else failed.push({ package: result.entry.package, reason: result.reason ?? "Modern level conversion failed." });
    }
    warnings.push(`Decoded ${modernMapPackages.length} modern Unreal level${modernMapPackages.length === 1 ? "" : "s"} without Unreal Engine.`);
  }
  if (modernPrefabPackages.length > 0) {
    modernConverter ??= request.modernConverter ?? (await ensureModernConverter(environment, log));
    const prefabRoot = join(staging, "modern-prefabs");
    await mkdir(prefabRoot, { recursive: true });
    await mkdir(sceneSources, { recursive: true });
    log(`Decoding ${modernPrefabPackages.length} serialized Blueprint prefab${modernPrefabPackages.length === 1 ? "" : "s"}…`);
    const results = await mapWithConcurrency(modernPrefabPackages, Math.min(2, concurrency), async (entry, index) => {
      const name = basename(entry.package, extname(entry.package));
      const isolated = join(prefabRoot, String(index).padStart(5, "0"));
      const converted = await runModernConverter(
        modernConverter!.path,
        sourceDir,
        isolated,
        ["--filter", entry.selector],
        { timeoutMs: 1_800_000, maxOutputBytes: 64 * 1024 * 1024 },
      );
      // A logic-only Blueprint (event graph, no mesh or light components) converts to nothing;
      // the converter says so explicitly, and that is content with nothing to place, not a failure.
      const empty = converted.code !== 0 && /No StaticMesh, SkeletalMesh/.test(converted.stderr);
      if (converted.code !== 0) return { entry, empty, modelSources: [] as { name: string; glb: string }[], reason: `The Blueprint prefab converter exited ${converted.code}.` };
      const emitted = await listFiles(isolated);
      const scene = emitted.find((file) => basename(file.path).toLowerCase() === `${name}.prefab-source.json`.toLowerCase())?.path;
      const glbs = await indexGlbs(isolated);
      const modelSources = [...glbs].map(([modelName, glb]) => ({ name: modelName, glb }));
      const exported = await indexExported(isolated);
      return scene ? { entry, scene, modelSources, exported } : { entry, modelSources, exported, reason: "The Blueprint converter produced no prefab descriptor." };
    });
    for (const result of results) {
      if (result.exported) {
        for (const model of result.modelSources) modernSceneModelSources.push({ entry: result.entry, ...model, assets: result.exported });
      }
      if (result.scene) {
        const target = sceneSourcePathFor(result.entry);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, await readFile(result.scene));
        sceneSourcePaths.set(result.entry.file, target);
      }
      else if ("empty" in result && result.empty) skipped.push({ package: result.entry.package, reason: "unsupported Unreal-only content: Blueprint class with no mesh or light components" });
      else failed.push({ package: result.entry.package, reason: result.reason ?? "Blueprint prefab conversion failed." });
    }
    warnings.push(`Decoded ${modernPrefabPackages.length} serialized Blueprint prefab${modernPrefabPackages.length === 1 ? "" : "s"} without executing Unreal bytecode.`);
  }
  const modernMaterialCandidates = [...new Map(
    [...modernMaterialPackages, ...materialFallbackPackages].map((entry) => [entry.file, entry]),
  ).values()];
  if (modernMaterialCandidates.length > 0) {
    modernConverter ??= request.modernConverter ?? (await ensureModernConverter(environment, log));
    const materialRoot = join(staging, "modern-materials");
    await mkdir(materialRoot, { recursive: true });
    log(`Decoding ${modernMaterialCandidates.length} modern/fallback Material package${modernMaterialCandidates.length === 1 ? "" : "s"}…`);
    const results = await mapWithConcurrency(modernMaterialCandidates, Math.min(4, concurrency), async (entry, index) => {
      const name = basename(entry.package, extname(entry.package));
      const isolated = join(materialRoot, String(index).padStart(5, "0"));
      await mkdir(isolated, { recursive: true });
      const converted = await runModernConverter(
        modernConverter!.path,
        sourceDir,
        isolated,
        ["--filter", entry.selector],
        { timeoutMs: 1_800_000, maxOutputBytes: 32 * 1024 * 1024 },
      );
      if (converted.code !== 0) return { entry, reason: `The modern Material converter exited ${converted.code}.` };
      const exported = await indexExported(isolated);
      return exported.mat.has(name) || exported.props.has(name)
        ? { entry, exported }
        : { entry, reason: "The modern Material converter produced no metadata." };
    });
    for (const result of results) {
      if (result.exported) {
        materialAssetsByFile.set(result.entry.file, result.exported);
        const name = basename(result.entry.package, extname(result.entry.package));
        if (materialNameCounts.get(name) === 1) assets = mergeExported(assets, result.exported);
      } else {
        failed.push({ package: result.entry.package, reason: result.reason ?? "Modern Material conversion failed." });
      }
    }
    warnings.push(`Decoded ${modernMaterialCandidates.length} modern or UE Viewer-incompatible Unreal Material package${modernMaterialCandidates.length === 1 ? "" : "s"} without Unreal Engine.`);
  }
  if (modernSoundPackages.length > 0) {
    modernConverter ??= request.modernConverter ?? (await ensureModernConverter(environment, log));
    const modernAudioRoot = join(staging, "modern-audio");
    await mkdir(modernAudioRoot, { recursive: true });
    log(`Decoding ${modernSoundPackages.length} modern UE5 SoundWave package${modernSoundPackages.length === 1 ? "" : "s"}…`);
    const results = await mapWithConcurrency(modernSoundPackages, Math.min(4, concurrency), async (entry, index) => {
      const name = basename(entry.package, extname(entry.package));
      const isolated = join(modernAudioRoot, String(index).padStart(5, "0"));
      const converted = await runModernConverter(
        modernConverter!.path,
        sourceDir,
        isolated,
        ["--filter", entry.selector],
        { timeoutMs: 1_800_000, maxOutputBytes: 32 * 1024 * 1024 },
      );
      if (converted.code !== 0) return { entry, reason: `The modern UE5 sound converter exited ${converted.code}.` };
      const exported = await indexExported(isolated);
      const source = exported.audio.get(name);
      return source
        ? { entry, source }
        : { entry, reason: "The modern UE5 sound converter produced no web-decodable audio file." };
    });
    for (const result of results) {
      if (result.source) audioSources.set(result.entry.file, result.source);
      else failed.push({ package: result.entry.package, reason: result.reason ?? "Modern sound conversion failed." });
    }
    warnings.push(
      `Decoded ${modernSoundPackages.length} requested modern UE5 SoundWave package${modernSoundPackages.length === 1 ? "" : "s"} without Unreal Engine.`,
    );
  }
  if (cubemapPackages.length > 0) {
    modernConverter ??= request.modernConverter ?? (await ensureModernConverter(environment, log));
    const cubemapRoot = join(staging, "cubemaps");
    await mkdir(cubemapRoot, { recursive: true });
    log(`Decoding ${cubemapPackages.length} TextureCube package${cubemapPackages.length === 1 ? "" : "s"} to equirectangular environment maps…`);
    // Isolate each package: Unreal permits duplicate object names in separate content paths, while
    // the converter names its image after the object. A shared directory would silently collide.
    const results = await mapWithConcurrency(cubemapPackages, Math.min(4, concurrency), async (entry, index) => {
      const name = basename(entry.package, extname(entry.package));
      const isolated = join(cubemapRoot, String(index).padStart(5, "0"));
      await mkdir(isolated, { recursive: true });
      const converted = await runModernConverter(
        modernConverter!.path,
        sourceDir,
        isolated,
        ["--filter", entry.selector],
        { timeoutMs: 1_800_000, maxOutputBytes: 32 * 1024 * 1024 },
      );
      if (converted.code !== 0) return { entry, reason: `The TextureCube converter exited ${converted.code}.` };
      const source = (await listFiles(isolated)).find((file) =>
        basename(file.path, extname(file.path)).toLowerCase() === name.toLowerCase() &&
          [".png", ".hdr"].includes(extname(file.path).toLowerCase()),
      )?.path;
      return source
        ? { entry, source }
        : { entry, reason: "The TextureCube converter produced no equirectangular PNG." };
    });
    for (const result of results) {
      if (result.source) cubemapSources.set(result.entry.file, result.source);
      else failed.push({ package: result.entry.package, reason: result.reason ?? "TextureCube conversion failed." });
    }
    warnings.push(
      `Decoded ${cubemapPackages.length} requested TextureCube package${cubemapPackages.length === 1 ? "" : "s"} to Three.js equirectangular environment map${cubemapPackages.length === 1 ? "" : "s"} without Unreal Engine.`,
    );
  }
  if (dataPackages.length > 0) {
    modernConverter ??= request.modernConverter ?? (await ensureModernConverter(environment, log));
    const dataRoot = join(staging, "data-assets");
    await mkdir(dataRoot, { recursive: true });
    log(`Decoding ${dataPackages.length} structured-data package${dataPackages.length === 1 ? "" : "s"} to JSON…`);
    const results = await mapWithConcurrency(dataPackages, Math.min(4, concurrency), async (entry, index) => {
      const name = basename(entry.package, extname(entry.package));
      const isolated = join(dataRoot, String(index).padStart(5, "0"));
      await mkdir(isolated, { recursive: true });
      const converted = await runModernConverter(
        modernConverter!.path,
        sourceDir,
        isolated,
        ["--filter", entry.selector],
        { timeoutMs: 1_800_000, maxOutputBytes: 32 * 1024 * 1024 },
      );
      if (converted.code !== 0) {
        const diagnostic = converted.stderr.trim().split(/\r?\n/).find((line) => /exception:|\.usmap/i.test(line));
        return { entry, reason: `The structured-data converter exited ${converted.code}.${diagnostic ? ` ${diagnostic.trim()}` : ""}` };
      }
      const source = (await listFiles(isolated)).find((file) =>
        basename(file.path).toLowerCase() === `${name}.json`.toLowerCase(),
      )?.path;
      return source
        ? { entry, source }
        : { entry, reason: "The structured-data converter produced no JSON." };
    });
    for (const result of results) {
      if (result.source) dataSources.set(result.entry.file, result.source);
      else failed.push({ package: result.entry.package, reason: result.reason ?? "Structured-data conversion failed." });
    }
    warnings.push(
      `Decoded ${dataPackages.length} requested Unreal structured-data package${dataPackages.length === 1 ? "" : "s"} to reusable JSON without Unreal Engine.`,
    );
  }
  if (textureStackPackages.length > 0) {
    modernConverter ??= request.modernConverter ?? (await ensureModernConverter(environment, log));
    const stackRoot = join(staging, "texture-stacks");
    await mkdir(stackRoot, { recursive: true });
    log(`Decoding ${textureStackPackages.length} multidimensional texture package${textureStackPackages.length === 1 ? "" : "s"}…`);
    const results = await mapWithConcurrency(textureStackPackages, Math.min(4, concurrency), async (entry, index) => {
      const name = basename(entry.package, extname(entry.package));
      const isolated = join(stackRoot, String(index).padStart(5, "0"));
      await mkdir(isolated, { recursive: true });
      const converted = await runModernConverter(
        modernConverter!.path,
        sourceDir,
        isolated,
        ["--filter", entry.selector],
        { timeoutMs: 1_800_000, maxOutputBytes: 32 * 1024 * 1024 },
      );
      if (converted.code !== 0) {
        const diagnostic = converted.stderr.trim().split(/\r?\n/).find((line) => /exception:|\.usmap/i.test(line));
        return { entry, reason: `The multidimensional texture converter exited ${converted.code}.${diagnostic ? ` ${diagnostic.trim()}` : ""}` };
      }
      const descriptor = (await listFiles(isolated)).find((file) =>
        basename(file.path).toLowerCase() === `${name}.texture.json`.toLowerCase(),
      )?.path;
      return descriptor
        ? { entry, descriptor }
        : { entry, reason: "The multidimensional texture converter produced no descriptor." };
    });
    for (const result of results) {
      if (result.descriptor) textureStackSources.set(result.entry.file, result.descriptor);
      else failed.push({ package: result.entry.package, reason: result.reason ?? "Multidimensional texture conversion failed." });
    }
    warnings.push(
      `Decoded ${textureStackPackages.length} requested multidimensional texture package${textureStackPackages.length === 1 ? "" : "s"} without Unreal Engine.`,
    );
  }
  if (offlineFontPackages.length > 0) {
    modernConverter ??= request.modernConverter ?? (await ensureModernConverter(environment, log));
    const fontRoot = join(staging, "offline-fonts");
    await mkdir(fontRoot, { recursive: true });
    log(`Decoding ${offlineFontPackages.length} offline bitmap font package${offlineFontPackages.length === 1 ? "" : "s"}…`);
    const results = await mapWithConcurrency(offlineFontPackages, Math.min(4, concurrency), async (entry, index) => {
      const name = basename(entry.package, extname(entry.package));
      const isolated = join(fontRoot, String(index).padStart(5, "0"));
      await mkdir(isolated, { recursive: true });
      const converted = await runModernConverter(
        modernConverter!.path,
        sourceDir,
        isolated,
        ["--filter", entry.selector],
        { timeoutMs: 1_800_000, maxOutputBytes: 32 * 1024 * 1024 },
      );
      if (converted.code !== 0) return { entry, reason: `The offline font converter exited ${converted.code}.` };
      const descriptor = (await listFiles(isolated)).find((file) =>
        basename(file.path).toLowerCase() === `${name}.font.json`.toLowerCase(),
      )?.path;
      return descriptor ? { entry, descriptor } : { entry, reason: "The offline Font converter produced no atlas descriptor." };
    });
    for (const result of results) {
      if (result.descriptor) offlineFontSources.set(result.entry.file, result.descriptor);
    }
    warnings.push(`Decoded ${offlineFontPackages.length} offline Unreal font package${offlineFontPackages.length === 1 ? "" : "s"} without Unreal Engine.`);
  }
  if (paperPackages.length > 0) {
    modernConverter ??= request.modernConverter ?? (await ensureModernConverter(environment, log));
    const paperRoot = join(staging, "paper2d");
    await mkdir(paperRoot, { recursive: true });
    log(`Decoding ${paperPackages.length} Paper2D asset package${paperPackages.length === 1 ? "" : "s"}…`);
    const results = await mapWithConcurrency(paperPackages, Math.min(4, concurrency), async (entry, index) => {
      const name = basename(entry.package, extname(entry.package));
      const isolated = join(paperRoot, String(index).padStart(5, "0"));
      await mkdir(isolated, { recursive: true });
      const converted = await runModernConverter(
        modernConverter!.path,
        sourceDir,
        isolated,
        ["--filter", entry.selector],
        { timeoutMs: 1_800_000, maxOutputBytes: 32 * 1024 * 1024 },
      );
      if (converted.code !== 0) {
        const diagnostic = converted.stderr.trim().split(/\r?\n/).find((line) => /exception:|\.usmap/i.test(line));
        return { entry, spriteDescriptors: [] as string[], reason: `The Paper2D converter exited ${converted.code}.${diagnostic ? ` ${diagnostic.trim()}` : ""}` };
      }
      const emitted = await listFiles(isolated);
      const spriteDescriptors = emitted.filter((file) => file.path.toLowerCase().endsWith(".sprite.json")).map((file) => file.path);
      const flipbookDescriptor = emitted.find((file) => basename(file.path).toLowerCase() === `${name}.flipbook.json`.toLowerCase())?.path;
      const tileDescriptor = emitted.find((file) => basename(file.path).toLowerCase() === `${name}.tile.json`.toLowerCase())?.path;
      const primarySprite = emitted.find((file) => basename(file.path).toLowerCase() === `${name}.sprite.json`.toLowerCase())?.path;
      const valid = entry.paperClass === "PaperSprite" ? primarySprite !== undefined
        : entry.paperClass === "PaperFlipbook" ? flipbookDescriptor !== undefined
        : tileDescriptor !== undefined;
      return valid
        ? { entry, spriteDescriptors, flipbookDescriptor, tileDescriptor }
        : { entry, spriteDescriptors, reason: `The Paper2D converter produced no ${entry.paperClass} descriptor.` };
    });
    for (const result of results) {
      for (const descriptor of result.spriteDescriptors) paperSpriteSources.push({ entry: result.entry, descriptor });
      if (result.flipbookDescriptor) paperFlipbookSources.set(result.entry.file, result.flipbookDescriptor);
      if (result.tileDescriptor) paperTileSources.push({ entry: result.entry, descriptor: result.tileDescriptor });
      if (result.reason) failed.push({ package: result.entry.package, reason: result.reason });
    }
    warnings.push(`Decoded ${paperPackages.length} requested Paper2D package${paperPackages.length === 1 ? "" : "s"} without Unreal Engine.`);
  }
  const modernNames = new Set(
    modernPackages
      .map(({ entry }) => basename(entry.package, extname(entry.package)))
      .filter((name) => !recoveredByUmodel.has(name)),
  );

  const promotion = await mkdtemp(join(promotionParent, ".threenative-import-"));
  /** GLB path (relative to the output) -> texture name -> source PNG paths; see `ImportUnrealRequest.proofSources`. */
  const proofByGlb = new Map<string, Map<string, string[]>>();
  const proofFor = (glbPath: string): Map<string, string[]> | undefined => {
    if (!request.proofSources) return undefined;
    const key = relative(promotion, glbPath).split(sep).join("/");
    const sources = proofByGlb.get(key) ?? new Map<string, string[]>();
    proofByGlb.set(key, sources);
    return sources;
  };

  // Only a verified entitlement earns a copyright line. A local pack whose licence nobody
  // checked stays blank so the game's asset health check keeps saying "unknown".
  const copyright =
    request.license && request.license.verdict === "allowed"
      ? `${request.license.slugs.join(", ")} (Fab listing ${request.listingId ?? "unknown"}) via threenative-asset-mcp`
      : undefined;
  const models: ImportedModel[] = [];
  const textures: ImportedTexture[] = [];
  const cubemaps: ImportedCubemap[] = [];
  const standaloneMaterials: ImportedMaterialAsset[] = [];
  const audio: ImportedAudio[] = [];
  const dataAssets: ImportedDataAsset[] = [];
  const textureStacks: ImportedTextureStack[] = [];
  const fonts: ImportedFont[] = [];
  const bitmapFonts: ImportedBitmapFont[] = [];
  const sprites: ImportedSprite[] = [];
  const flipbooks: ImportedFlipbook[] = [];
  const scenes: ImportedScene[] = [];
  const strands: ImportedGroom[] = [];
  const modernSceneModelsByFile = new Map<string, ImportedModel[]>();
  const modernSceneModelPackages = new Set<string>();
  const imageCache = new TransformedImageCache();
  // Textures the importer refused to bind, kept so the game can rebuild the surface Unreal
  // composed in its material graph. Written once, beside the models that name them.
  const sidecars = new Map<string, string>();
  const transforms: Record<string, number> = {};
  let prunedUvSets = 0;
  let droppedTangents = 0;
  let repairedMorphDeltas = 0;
  let conflictingMorphDeltas = 0;
  const rejectedMasks: UnsupportedTexture[] = [];
  const attachedPsa = new Set<string>();
  const existingPsa = new Set<string>();
  const incompatiblePsa = new Set<string>();

  try {
    for (const entry of assetMeshPackages) {
      const name = basename(entry.package, extname(entry.package));
      const fromMeshDescription = uncookedNames.has(name);
      const fromModernConverter = modernNames.has(name);
      const defaultPath = fromMeshDescription
        ? uncookedGlbs.get(name)
        : fromModernConverter
          ? modernGlbs.get(name)
          : assets.gltf.get(name);
      // Only the modern converter emits more than LOD0, and only when asked. Every other route
      // keeps its single existing GLB. Extra LODs come out of the same run under the writer's own
      // `_LOD<n>` suffix, so the base mesh name plus that suffix finds them.
      const lodPaths: { lod: number; path: string }[] = [];
      if (fromModernConverter && lodsArg !== undefined) {
        for (const lod of requestedLods) {
          const path = lod === 0 ? defaultPath : modernGlbs.get(`${name}_LOD${lod}`);
          if (path) lodPaths.push({ lod, path });
        }
      } else if (defaultPath) {
        lodPaths.push({ lod: 0, path: defaultPath });
      }
      if (lodPaths.length === 0) {
        failed.push({
          package: entry.package,
          reason: fromMeshDescription
            ? "The uncooked MeshDescription converter produced no GLB for this package."
            : fromModernConverter
              ? `The modern UE5 mesh converter produced no GLB for this package${
                  modernMeshFailureReasons.has(name) ? `: ${modernMeshFailureReasons.get(name)}` : "."
                }`
            : "UE Viewer produced no glTF for this package.",
        });
        continue;
      }
      const dnaSource = fromModernConverter ? assets.dna.get(name) : undefined;
      // Neither UE Viewer's raw mesh nor the uncooked converter's FMeshDescription is multiplied by the source model's
      // BuildScale3D; Unreal's render data is. A UE 4.26 pack built street lights at 1.4 and a tree at 3, so they came out
      // that much too small.
      const buildScale = !fromModernConverter && entry.meshKind !== "skeletal" ? await readPackageBuildScale3D(entry.file) : undefined;
      if (buildScale && buildScale.some((factor) => factor !== 1)) {
        warnings.push(`${name}: the source mesh carries BuildScale3D (${buildScale.join(", ")}); ${fromMeshDescription ? "the source model's" : "UE Viewer's"} geometry was scaled by it${new Set(buildScale).size > 1 ? " (non-uniform: normals are not adjusted)" : ""}.`);
      }
      for (const { lod, path: gltfPath } of lodPaths) {
        const relativeGlb = fromMeshDescription || fromModernConverter
          ? lod === 0 ? `Models/${name}.glb` : `Models/${name}_LOD${lod}.glb`
          : `${relative(raw, gltfPath).split(sep).join("/").slice(0, -".gltf".length)}.glb`;
        const glbPath = assertContained(promotion, relativeGlb);
        try {
          const packaged = await packageGlb({
            gltfPath,
            glbPath,
            assets,
            maxTextureSize: request.maxTextureSize,
            keepAllUvSets: false,
            imageCache,
            copyright,
            sidecars,
            geometryScale: meshGeometryScale(fromMeshDescription, buildScale),
            psaFiles: entry.meshKind === "skeletal" ? psaFiles : [],
            sourceMaterial: sourceForMesh(entry.file),
            graphBaker,
            noMipmapTextures,
            namesEngineDefaultMaterial: async () => (await readPackageObjectNames(entry.file)).has("WorldGridMaterial"),
            onMaterialResolved: request.onMaterialResolved,
            proofSources: proofFor(glbPath),
          });
          prunedUvSets += packaged.prunedUvSets;
          droppedTangents += packaged.droppedTangents;
          repairedMorphDeltas += packaged.repairedMorphDeltas;
          conflictingMorphDeltas += packaged.conflictingMorphDeltas;
          for (const name of packaged.attachedPsa) attachedPsa.add(name);
          for (const name of packaged.existingPsa) existingPsa.add(name);
          for (const name of packaged.incompatiblePsa) incompatiblePsa.add(name);
          const validated = await validateGlb(glbPath);
          for (const section of packaged.sections) {
            for (const binding of section.bindings) {
              transforms[binding.transform] = (transforms[binding.transform] ?? 0) + 1;
            }
          }
          const model: ImportedModel = {
            name: lod === 0 ? name : `${name}_LOD${lod}`,
            package: entry.package,
            kind: entry.meshKind ?? "static",
            glb: relativeGlb,
            bytes: validated.bytes,
            sha256: validated.sha256,
            vertices: packaged.vertices,
            primitives: packaged.primitives,
            skins: packaged.skins,
            joints: packaged.joints,
            morphTargets: packaged.morphTargets,
            animations: packaged.animations,
            boundsMetres: packaged.bounds,
            materials: packaged.sections,
          };
          // The DNA belongs to the mesh, not to one LOD, so it rides with LOD0.
          let dna: ImportedModel["dna"];
          if (lod === 0 && dnaSource) {
            const dnaTarget = assertContained(promotion, `Models/${name}.dna`);
            await mkdir(dirname(dnaTarget), { recursive: true });
            await copyFile(dnaSource, dnaTarget);
            const dnaBytes = await readFile(dnaTarget);
            dna = {
              path: `Models/${name}.dna`,
              bytes: dnaBytes.byteLength,
              sha256: createHash("sha256").update(dnaBytes).digest("hex"),
            };
          }
          models.push(dna ? { ...model, dna } : model);
          log(`Packaged ${relativeGlb} (${(validated.bytes / 1024 ** 2).toFixed(1)} MiB).`);
        } catch (error) {
          await rm(glbPath, { force: true });
          failed.push({
            package: entry.package,
            reason: error instanceof Error ? error.message : "GLB packaging failed.",
          });
        }
      }
    }

    for (const entry of groomPackages) {
      const name = basename(entry.package, extname(entry.package));
      const relativeBinary = `Models/${name}.strands.bin`;
      const binaryPath = assertContained(promotion, relativeBinary);
      const candidates = modernGroomPayloads.get(name) ?? [];
      let decoded: GroomStrands | undefined;
      let reason = "The modern UE5 asset converter produced no hair description for this package.";
      for (const candidate of candidates) {
        try {
          decoded = decodeGroomPayload(await readFile(candidate));
          break;
        } catch (error) {
          // A package carries more than one compressed trailer and only one of them is the hair
          // description. A payload that decodes into strands this build refuses is not a different
          // candidate, so that verdict stands instead of being retried against the next one.
          reason = error instanceof Error ? error.message : "Groom decoding failed.";
          if (error instanceof ImportError && error.code === "UNREAL_GROOM_UNSUPPORTED") break;
        }
      }
      if (!decoded) {
        failed.push({ package: entry.package, reason });
        continue;
      }
      try {
        const sidecarRelative = `Models/${name}.strands.json`;
        const sidecarPath = assertContained(promotion, sidecarRelative);
        await mkdir(dirname(binaryPath), { recursive: true });
        await writeFile(binaryPath, decoded.binary);
        await writeFile(sidecarPath, `${JSON.stringify(groomSidecar(decoded, entry.package), null, 2)}\n`);
        strands.push({
          name,
          package: entry.package,
          path: relativeBinary,
          sidecar: sidecarRelative,
          bytes: decoded.binary.byteLength,
          sha256: createHash("sha256").update(decoded.binary).digest("hex"),
          strandCount: decoded.strandCount,
          pointCount: decoded.pointCount,
          excludedGuides: decoded.excludedGuides,
        });
        log(`Wrote ${relativeBinary} (${decoded.strandCount} strands, ${decoded.pointCount} points).`);
      } catch (error) {
        await rm(binaryPath, { force: true });
        failed.push({
          package: entry.package,
          reason: `Groom strand packaging failed: ${error instanceof Error ? error.message : "unknown error"}`,
        });
      }
    }

    for (const source of modernSceneModelSources) {
      const packageStem = source.entry.package.slice(0, -extname(source.entry.package).length).split(sep).join("/");
      const ownerDirectory = extname(source.entry.package).toLowerCase() === ".umap" ? "__maps" : "__prefabs";
      const relativeGlb = `Models/${ownerDirectory}/${packageStem}/${source.name}.glb`;
      const glbPath = assertContained(promotion, relativeGlb);
      const dependencyPackage = `${source.entry.package}#${source.name}`;
      try {
        const packaged = await packageGlb({
          gltfPath: source.glb,
          glbPath,
          assets: source.assets,
          maxTextureSize: request.maxTextureSize,
          keepAllUvSets: false,
          imageCache,
          copyright,
          sidecars,
          geometryScale: 1,
          sourceMaterial: sourceForMesh(source.entry.file),
          graphBaker,
          noMipmapTextures,
          onMaterialResolved: request.onMaterialResolved,
          proofSources: proofFor(glbPath),
        });
        prunedUvSets += packaged.prunedUvSets;
        droppedTangents += packaged.droppedTangents;
        repairedMorphDeltas += packaged.repairedMorphDeltas;
        conflictingMorphDeltas += packaged.conflictingMorphDeltas;
        const validated = await validateGlb(glbPath);
        const model: ImportedModel = {
          name: source.name,
          package: dependencyPackage,
          kind: packaged.skins > 0 ? "skeletal" : "static",
          glb: relativeGlb,
          bytes: validated.bytes,
          sha256: validated.sha256,
          vertices: packaged.vertices,
          primitives: packaged.primitives,
          skins: packaged.skins,
          joints: packaged.joints,
          morphTargets: packaged.morphTargets,
          animations: packaged.animations,
          boundsMetres: packaged.bounds,
          materials: packaged.sections,
        };
        models.push(model);
        modernSceneModelPackages.add(dependencyPackage);
        const scoped = modernSceneModelsByFile.get(source.entry.file) ?? [];
        scoped.push(model);
        modernSceneModelsByFile.set(source.entry.file, scoped);
      } catch (error) {
        await rm(glbPath, { force: true });
        failed.push({
          package: dependencyPackage,
          reason: `Scene-referenced mesh packaging failed: ${error instanceof Error ? error.message : "unknown error"}`,
        });
      }
    }
    if (modernSceneModelSources.length > 0) {
      warnings.push(`Promoted ${[...modernSceneModelsByFile.values()].reduce((count, entries) => count + entries.length, 0)} mesh dependencies emitted from modern Unreal levels and Blueprint prefabs.`);
    }

    if (attachedPsa.size > 0) {
      warnings.push(
        `Attached ${attachedPsa.size} standalone ActorX animation clip${attachedPsa.size === 1 ? "" : "s"} to compatible skeletal GLBs by joint name.`,
      );
    }
    if (existingPsa.size > 0) {
      warnings.push(
        `Kept ${existingPsa.size} animation clip${existingPsa.size === 1 ? "" : "s"} already present in UE Viewer's skeletal GLB instead of duplicating the matching PSA clip.`,
      );
    }
    if (psaFiles.length > 0 && attachedPsa.size === 0 && existingPsa.size === 0) {
      for (const entry of animationPackages) {
        failed.push({
          package: entry.package,
          reason: "ActorX PSA was decoded, but no imported SkeletalMesh matched at least 80% of its bone names.",
        });
      }
    } else if (incompatiblePsa.size > 0) {
      warnings.push(
        `${incompatiblePsa.size} ActorX animation clip${incompatiblePsa.size === 1 ? " was" : "s were"} not attached to at least one skeletal model because fewer than 80% of bone names matched.`,
      );
    }

    const materialEntries = materialPackages
      .filter((entry) => materialAssetsByFile.has(entry.file))
      .map((entry) => ({
        entry,
        libraryName: entry.package.slice(0, -extname(entry.package).length),
      }));
    if (materialEntries.length > 0) {
      const source = join(staging, "material-library.gltf");
      const relativeGlb = "Materials/UnrealMaterialLibrary.glb";
      const glbPath = assertContained(promotion, relativeGlb);
      try {
        await writeMaterialLibrarySource(
          source,
          materialEntries.map(({ entry, libraryName }) => ({ libraryName, package: entry.package })),
        );
        const lookupNames = new Map(
          materialEntries.map(({ entry, libraryName }) => [
            libraryName,
            basename(entry.package, extname(entry.package)),
          ]),
        );
        const isolatedAssets = new Map(
          materialEntries.map(({ entry, libraryName }) => [
            libraryName,
            materialAssetsByFile.get(entry.file) ?? assets,
          ]),
        );
        const packaged = await packageGlb({
          gltfPath: source,
          glbPath,
          assets,
          maxTextureSize: request.maxTextureSize,
          keepAllUvSets: false,
          imageCache,
          copyright,
          materialLookupNames: lookupNames,
          materialAssets: isolatedAssets,
          sourceMaterial: (name) => {
            const entry = materialEntries.find((e) => e.libraryName === name)?.entry;
            return entry ? sourceForLibraryFile(entry.file) : undefined;
          },
          graphBaker,
          noMipmapTextures,
          onMaterialResolved: request.onMaterialResolved,
          proofSources: proofFor(glbPath),
        });
        await validateGlb(glbPath);
        const sections = new Map(packaged.sections.map((section) => [section.name, section]));
        for (const { entry, libraryName } of materialEntries) {
          const section = sections.get(libraryName);
          if (!section) throw new Error(`Material library omitted ${libraryName}.`);
          standaloneMaterials.push({
            ...section,
            resolved:
              (isolatedAssets.get(libraryName)?.mat.has(lookupNames.get(libraryName) ?? "") ?? false) ||
              (isolatedAssets.get(libraryName)?.props.has(lookupNames.get(libraryName) ?? "") ?? false),
            name: basename(entry.package, extname(entry.package)),
            package: entry.package,
            glb: relativeGlb,
            libraryName,
          });
          for (const binding of section.bindings) {
            transforms[binding.transform] = (transforms[binding.transform] ?? 0) + 1;
          }
        }
        log(`Packaged ${relativeGlb} with ${standaloneMaterials.length} reusable material swatches.`);
        const approximated = standaloneMaterials.filter((material) => !material.resolved).length;
        if (approximated > 0) {
          warnings.push(
            `${approximated} standalone Material package${approximated === 1 ? " had" : "s had"} no UE Viewer PBR metadata and use named glass/light/mirror or neutral fallbacks in the material library.`,
          );
        }
      } catch (error) {
        await rm(glbPath, { force: true });
        for (const { entry } of materialEntries) {
          failed.push({
            package: entry.package,
            reason: `Material library packaging failed: ${error instanceof Error ? error.message : "unknown error"}`,
          });
        }
      }
    }

    if (sidecars.size > 0) {
      const directory = join(promotion, "textures");
      await mkdir(directory, { recursive: true });
      for (const [name, source] of sidecars) {
        await writeFile(assertContained(directory, `${name}.png`), await readFile(source));
      }
      warnings.push(
        `Wrote ${sidecars.size} unmappable textures to textures/ — they are extra Unreal material inputs with no single glTF PBR slot. Use the per-section report to rebuild layered or custom surfaces.`,
      );
    }

    for (const entry of texturePackages) {
      const source = textureSources.get(entry.file);
      if (!source) continue;
      const name = basename(entry.package, extname(entry.package));
      const relativePng = `textures/${entry.package.slice(0, -extname(entry.package).length)}.png`;
      const output = assertContained(promotion, relativePng);
      try {
        const transformed = await applyTextureTransform(
          await readFile(source),
          "none",
          request.maxTextureSize,
        );
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, transformed.data);
        const metadata = await (await import("sharp")).default(transformed.data).metadata();
        if (!metadata.width || !metadata.height) throw new Error("PNG dimensions are missing.");
        textures.push({
          name,
          package: entry.package,
          png: relativePng,
          bytes: transformed.data.byteLength,
          sha256: createHash("sha256").update(transformed.data).digest("hex"),
          width: metadata.width,
          height: metadata.height,
        });
      } catch (error) {
        await rm(output, { force: true });
        failed.push({
          package: entry.package,
          reason: `Texture packaging failed: ${error instanceof Error ? error.message : "unknown error"}`,
        });
      }
    }
    if (textures.length > 0) log(`Promoted ${textures.length} standalone Texture2D PNGs.`);

    for (const entry of cubemapPackages) {
      const source = cubemapSources.get(entry.file);
      if (!source) continue;
      const name = basename(entry.package, extname(entry.package));
      const extension = extname(source).toLowerCase();
      const relativeFile = `cubemaps/${entry.package.slice(0, -extname(entry.package).length)}${extension}`;
      const output = assertContained(promotion, relativeFile);
      try {
        const input = await readFile(source);
        let width: number;
        let height: number;
        let data = input;
        if (extension === ".hdr") {
          const inspected = inspectRadiance(input);
          if (!inspected) throw new Error("converter output is not a valid Radiance RGBE file");
          ({ width, height } = inspected);
          if (request.maxTextureSize !== undefined && width > request.maxTextureSize) {
            warnings.push(
              `${entry.package} is HDR and remains ${width}x${height}; maxTextureSize is not applied because lossy 8-bit resizing would destroy environment-light intensity.`,
            );
          }
        } else if (extension === ".png") {
          const { default: sharp } = await import("sharp");
          const sourceMetadata = await sharp(input, { limitInputPixels: 268_435_456, unlimited: true }).metadata();
          if (!sourceMetadata.width || !sourceMetadata.height) throw new Error("PNG dimensions are missing");
          width = sourceMetadata.width;
          height = sourceMetadata.height;
          const cappedWidth = request.maxTextureSize !== undefined && width > request.maxTextureSize
            ? Math.max(2, request.maxTextureSize - (request.maxTextureSize % 2))
            : width;
          if (cappedWidth !== width) {
            data = await sharp(input, { limitInputPixels: 268_435_456, unlimited: true })
              .resize(cappedWidth, cappedWidth / 2, { fit: "fill" })
              .png({ compressionLevel: 6 })
              .toBuffer();
            width = cappedWidth;
            height = cappedWidth / 2;
          }
        } else {
          throw new Error(`unsupported converter extension ${extension}`);
        }
        if (width !== height * 2) {
          throw new Error(
            `converter output must be a 2:1 equirectangular image, got ${width}x${height}`,
          );
        }
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, data);
        cubemaps.push({
          name,
          package: entry.package,
          file: relativeFile,
          mimeType: extension === ".hdr" ? "image/vnd.radiance" : "image/png",
          bytes: data.byteLength,
          sha256: createHash("sha256").update(data).digest("hex"),
          width,
          height,
          dynamicRange: extension === ".hdr" ? "hdr" : "ldr",
          mapping: "EquirectangularReflectionMapping",
        });
      } catch (error) {
        await rm(output, { force: true });
        failed.push({
          package: entry.package,
          reason: `Cubemap packaging failed: ${error instanceof Error ? error.message : "unknown error"}`,
        });
      }
    }
    if (cubemaps.length > 0) log(`Promoted ${cubemaps.length} equirectangular TextureCube environment maps.`);

    for (const entry of soundPackages) {
      const source = audioSources.get(entry.file);
      if (!source) continue;
      const name = basename(entry.package, extname(entry.package));
      try {
        const data = await readFile(source);
        const inspected = inspectWebAudio(data);
        if (!inspected) throw new Error("output is not a supported WAV, Ogg, MP3, or FLAC stream");
        const relativeAudio = `audio/${entry.package.slice(0, -extname(entry.package).length)}.${inspected.extension}`;
        const output = assertContained(promotion, relativeAudio);
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, data);
        audio.push({
          name,
          package: entry.package,
          file: relativeAudio,
          mimeType: inspected.mimeType,
          bytes: data.byteLength,
          sha256: createHash("sha256").update(data).digest("hex"),
          durationSeconds: inspected.durationSeconds,
          channels: inspected.channels,
          sampleRate: inspected.sampleRate,
        });
      } catch (error) {
        failed.push({
          package: entry.package,
          reason: `Audio packaging failed: ${error instanceof Error ? error.message : "unknown error"}`,
        });
      }
    }
    if (audio.length > 0) log(`Promoted ${audio.length} standalone SoundWave audio file${audio.length === 1 ? "" : "s"}.`);

    for (const entry of dataPackages) {
      const source = dataSources.get(entry.file);
      if (!source) continue;
      const name = basename(entry.package, extname(entry.package));
      const relativeJson = `data/${entry.package.slice(0, -extname(entry.package).length)}.json`;
      const output = assertContained(promotion, relativeJson);
      try {
        if ((await stat(source)).size > 256 * 1024 * 1024) throw new Error("JSON exceeds the 256 MiB safety limit");
        const data = await readFile(source);
        const parsed: unknown = JSON.parse(data.toString("utf8"));
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("converter output must be a JSON object");
        }
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, data);
        dataAssets.push({
          name,
          package: entry.package,
          className: entry.dataClass ?? "Unknown",
          json: relativeJson,
          bytes: data.byteLength,
          sha256: createHash("sha256").update(data).digest("hex"),
        });
      } catch (error) {
        await rm(output, { force: true });
        failed.push({
          package: entry.package,
          reason: `Structured-data packaging failed: ${error instanceof Error ? error.message : "unknown error"}`,
        });
      }
    }
    if (dataAssets.length > 0) log(`Promoted ${dataAssets.length} reusable structured-data JSON file${dataAssets.length === 1 ? "" : "s"}.`);

    for (const entry of textureStackPackages) {
      const descriptorPath = textureStackSources.get(entry.file);
      if (!descriptorPath) continue;
      const name = basename(entry.package, extname(entry.package));
      const relativeBase = `textures3d/${entry.package.slice(0, -extname(entry.package).length)}`;
      const relativeData = `${relativeBase}.rgba`;
      const relativeManifest = `${relativeBase}.texture.json`;
      const outputData = assertContained(promotion, relativeData);
      const outputManifest = assertContained(promotion, relativeManifest);
      try {
        const descriptor = JSON.parse(await readFile(descriptorPath, "utf8")) as Record<string, unknown>;
        const sourceClass = descriptor.Class;
        const sourceWidth = descriptor.Width;
        const sourceHeight = descriptor.Height;
        const sourceDepth = descriptor.Depth;
        const layout = descriptor.Layout;
        const layers = descriptor.Layers;
        if (!TEXTURE_STACK_CLASSES.has(String(sourceClass)) || sourceClass !== entry.textureStackClass) {
          throw new Error(`descriptor class ${String(sourceClass)} does not match ${entry.textureStackClass ?? "the package"}`);
        }
        if (![sourceWidth, sourceHeight, sourceDepth].every((value) =>
          typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 65_536,
        )) throw new Error("descriptor dimensions are invalid");
        if ((layout !== "layers" && layout !== "vertical-atlas") || !Array.isArray(layers) ||
          layers.some((layer) => typeof layer !== "string" || !/^[-A-Za-z0-9_.]+\.(?:png|hdr)$/i.test(layer))) {
          throw new Error("descriptor layer layout is invalid");
        }
        if (layers.some((layer) => extname(String(layer)).toLowerCase() !== ".png")) {
          throw new Error("HDR multidimensional textures require a floating-point output path that is not yet available");
        }
        const width = sourceWidth as number;
        const height = sourceHeight as number;
        const depth = sourceDepth as number;
        if (layout === "layers" && layers.length !== depth) {
          throw new Error(`descriptor declares ${depth} layers but contains ${layers.length}`);
        }
        if (layout === "vertical-atlas" && layers.length !== 1) {
          throw new Error("vertical atlas must contain exactly one image");
        }
        if (sourceClass === "TextureCubeArray" && depth % 6 !== 0) {
          throw new Error(`cube-array depth ${depth} is not divisible by six faces`);
        }
        const scale = request.maxTextureSize === undefined
          ? 1
          : Math.min(1, request.maxTextureSize / Math.max(width, height));
        const outputWidth = Math.max(1, Math.round(width * scale));
        const outputHeight = Math.max(1, Math.round(height * scale));
        const expectedBytes = outputWidth * outputHeight * depth * 4;
        if (!Number.isSafeInteger(expectedBytes) || expectedBytes > 1024 ** 3) {
          throw new Error("decoded RGBA8 texture stack would exceed the 1 GiB safety limit");
        }
        const { default: sharp } = await import("sharp");
        const rawLayers: Buffer[] = [];
        if (layout === "layers") {
          for (const layer of layers as string[]) {
            const layerPath = assertContained(dirname(descriptorPath), layer);
            const image = sharp(await readFile(layerPath), { limitInputPixels: 268_435_456, unlimited: true });
            const metadata = await image.metadata();
            if (metadata.width !== width || metadata.height !== height) {
              throw new Error(`${layer} is ${metadata.width ?? "?"}x${metadata.height ?? "?"}; expected ${width}x${height}`);
            }
            rawLayers.push(await image
              .resize(outputWidth, outputHeight, { fit: "fill" })
              .ensureAlpha()
              .raw()
              .toBuffer());
          }
        } else {
          const atlasName = layers[0] as string;
          const atlasPath = assertContained(dirname(descriptorPath), atlasName);
          const atlasData = await readFile(atlasPath);
          const metadata = await sharp(atlasData, { limitInputPixels: 268_435_456, unlimited: true }).metadata();
          if (metadata.width !== width || metadata.height !== height * depth) {
            throw new Error(`${atlasName} is ${metadata.width ?? "?"}x${metadata.height ?? "?"}; expected ${width}x${height * depth}`);
          }
          for (let layer = 0; layer < depth; layer += 1) {
            rawLayers.push(await sharp(atlasData, { limitInputPixels: 268_435_456, unlimited: true })
              .extract({ left: 0, top: layer * height, width, height })
              .resize(outputWidth, outputHeight, { fit: "fill" })
              .ensureAlpha()
              .raw()
              .toBuffer());
          }
        }
        const data = Buffer.concat(rawLayers);
        if (data.byteLength !== expectedBytes) throw new Error(`decoded ${data.byteLength} bytes; expected ${expectedBytes}`);
        const kind = sourceClass === "VolumeTexture" ? "volume" : sourceClass === "TextureCubeArray" ? "cube-array" : "array";
        const threeTexture = kind === "volume" ? "Data3DTexture" : "DataArrayTexture";
        await mkdir(dirname(outputData), { recursive: true });
        await writeFile(outputData, data);
        await writeFile(outputManifest, `${JSON.stringify({
          name,
          kind,
          format: "RGBA8",
          width: outputWidth,
          height: outputHeight,
          depth,
          data: basename(relativeData),
          threeTexture,
        }, null, 2)}\n`);
        textureStacks.push({
          name,
          package: entry.package,
          kind,
          data: relativeData,
          manifest: relativeManifest,
          format: "RGBA8",
          threeTexture,
          width: outputWidth,
          height: outputHeight,
          depth,
          bytes: data.byteLength,
          sha256: createHash("sha256").update(data).digest("hex"),
        });
      } catch (error) {
        await rm(outputData, { force: true });
        await rm(outputManifest, { force: true });
        failed.push({
          package: entry.package,
          reason: `Multidimensional texture packaging failed: ${error instanceof Error ? error.message : "unknown error"}`,
        });
      }
    }
    if (textureStacks.length > 0) log(`Promoted ${textureStacks.length} Three.js multidimensional texture stack${textureStacks.length === 1 ? "" : "s"}.`);

    for (const entry of fontPackages) {
      const sourceStem = entry.file.slice(0, -extname(entry.file).length);
      try {
        const payloads: Buffer[] = [];
        let sourceBytes = 0;
        for (const path of [entry.file, `${sourceStem}.uexp`, `${sourceStem}.ubulk`, `${sourceStem}.uptnl`]) {
          const info = await stat(path).catch(() => undefined);
          if (!info?.isFile()) continue;
          sourceBytes += info.size;
          if (sourceBytes > 1024 ** 3) throw new Error("font package payloads exceed the 1 GiB safety limit");
          payloads.push(await readFile(path));
        }
        const extracted = extractUnrealFonts(payloads);
        if (extracted.length === 0 && offlineFontSources.has(entry.file)) {
          const descriptorPath = offlineFontSources.get(entry.file)!;
          const descriptor = parseOfflineFontDescriptor(JSON.parse(await readFile(descriptorPath, "utf8")));
          const relativeDirectory = `bitmap-fonts/${entry.package.slice(0, -extname(entry.package).length)}`;
          const outputDirectory = assertContained(promotion, relativeDirectory);
          const packaged = await writeOfflineFont({ descriptor, descriptorPath, outputDirectory });
          const manifest = `${relativeDirectory}/${packaged.manifest}`;
          const pagePaths = packaged.pages.map((page) => `${relativeDirectory}/${page}`);
          const hash = createHash("sha256").update(await readFile(assertContained(promotion, manifest)));
          for (const page of pagePaths) hash.update(await readFile(assertContained(promotion, page)));
          bitmapFonts.push({
            name: descriptor.name,
            package: entry.package,
            manifest,
            pages: pagePaths,
            glyphs: packaged.glyphs,
            distanceField: descriptor.isDistanceField,
            bytes: packaged.bytes,
            sha256: hash.digest("hex"),
          });
          continue;
        }
        if (extracted.length === 0) throw new Error("no validated embedded TTF/OTF face or offline glyph atlas was found");
        const relativeDirectory = `fonts/${entry.package.slice(0, -extname(entry.package).length)}`;
        for (const [index, font] of extracted.entries()) {
          const fallbackName = `${font.family}-${font.style}`;
          const faceName = (font.postscriptName ?? fallbackName)
            .normalize("NFKD")
            .replace(/[^-A-Za-z0-9_.]+/g, "-")
            .replace(/^-+|-+$/g, "") || `face-${index + 1}`;
          const relativeFile = `${relativeDirectory}/${String(index + 1).padStart(2, "0")}-${faceName}.${font.extension}`;
          const output = assertContained(promotion, relativeFile);
          await mkdir(dirname(output), { recursive: true });
          await writeFile(output, font.data);
          const normalizedStyle = `${font.style} ${font.postscriptName ?? ""}`.toLowerCase();
          const weight = normalizedStyle.includes("black") ? 900
            : normalizedStyle.includes("extra bold") || normalizedStyle.includes("extrabold") ? 800
            : normalizedStyle.includes("bold") ? 700
            : normalizedStyle.includes("semi") ? 600
            : normalizedStyle.includes("medium") ? 500
            : normalizedStyle.includes("light") ? 300
            : normalizedStyle.includes("thin") ? 100
            : 400;
          fonts.push({
            name: font.postscriptName ?? fallbackName,
            package: entry.package,
            file: relativeFile,
            mimeType: font.mimeType,
            family: font.family,
            style: font.style,
            weight,
            fontStyle: normalizedStyle.includes("italic") || normalizedStyle.includes("oblique") ? "italic" : "normal",
            bytes: font.data.byteLength,
            sha256: font.sha256,
          });
        }
      } catch (error) {
        failed.push({
          package: entry.package,
          reason: `Font packaging failed: ${error instanceof Error ? error.message : "unknown error"}`,
        });
      }
    }
    if (fonts.length > 0) log(`Promoted ${fonts.length} browser-loadable font face${fonts.length === 1 ? "" : "s"}.`);
    if (bitmapFonts.length > 0) log(`Promoted ${bitmapFonts.length} Three.js bitmap font atlas${bitmapFonts.length === 1 ? "" : "es"}.`);

    const spriteRecords = new Map<string, { descriptor: PaperSpriteDescriptor; source: string }>();
    for (const source of paperSpriteSources) {
      try {
        const descriptor = parsePaperSpriteDescriptor(JSON.parse(await readFile(source.descriptor, "utf8")));
        const packagePath = paperObjectPathToPackage(descriptor.packagePath, descriptor.name);
        const key = packagePath.toLowerCase();
        if (!spriteRecords.has(key)) spriteRecords.set(key, { descriptor, source: source.descriptor });
      } catch (error) {
        failed.push({
          package: source.entry.package,
          reason: `PaperSprite descriptor failed: ${error instanceof Error ? error.message : "unknown error"}`,
        });
      }
    }
    const spriteByPackage = new Map<string, ImportedSprite>();
    const spritesByName = new Map<string, ImportedSprite[]>();
    for (const [packageKey, record] of spriteRecords) {
      const packagePath = paperObjectPathToPackage(record.descriptor.packagePath, record.descriptor.name);
      const relativeGlb = `Sprites/${packagePath.slice(0, -extname(packagePath).length)}.glb`;
      const output = assertContained(promotion, relativeGlb);
      try {
        await mkdir(dirname(output), { recursive: true });
        const packaged = await writePaperSpriteGlb({
          descriptor: record.descriptor,
          texturePath: assertContained(dirname(record.source), record.descriptor.texture),
          outputPath: output,
          maxTextureSize: request.maxTextureSize,
        });
        await validateGlb(output);
        const data = await readFile(output);
        const imported: ImportedSprite = {
          name: record.descriptor.name,
          package: packagePath,
          glb: relativeGlb,
          vertices: packaged.vertices,
          widthMetres: packaged.widthMetres,
          heightMetres: packaged.heightMetres,
          textureWidth: packaged.textureWidth,
          textureHeight: packaged.textureHeight,
          bytes: packaged.bytes,
          sha256: createHash("sha256").update(data).digest("hex"),
        };
        sprites.push(imported);
        spriteByPackage.set(packageKey, imported);
        const sameName = spritesByName.get(imported.name.toLowerCase()) ?? [];
        sameName.push(imported);
        spritesByName.set(imported.name.toLowerCase(), sameName);
      } catch (error) {
        await rm(output, { force: true });
        failed.push({ package: packagePath, reason: `PaperSprite packaging failed: ${error instanceof Error ? error.message : "unknown error"}` });
      }
    }
    if (sprites.length > 0) log(`Promoted ${sprites.length} PaperSprite GLB${sprites.length === 1 ? "" : "s"}.`);

    for (const entry of paperPackages.filter((candidate) => candidate.paperClass === "PaperFlipbook")) {
      const source = paperFlipbookSources.get(entry.file);
      if (!source) continue;
      const relativeManifest = `Flipbooks/${entry.package.slice(0, -extname(entry.package).length)}.flipbook.json`;
      const output = assertContained(promotion, relativeManifest);
      try {
        const descriptor: PaperFlipbookDescriptor = parsePaperFlipbookDescriptor(JSON.parse(await readFile(source, "utf8")));
        const unresolved = new Set<string>();
        const frames = descriptor.frames.map((frame) => {
          const framePackage = paperObjectPathToPackage(frame.spritePath, frame.sprite);
          const exact = spriteByPackage.get(framePackage.toLowerCase());
          const named = spritesByName.get(frame.sprite.toLowerCase());
          const sprite = exact ?? (named?.length === 1 ? named[0] : undefined);
          if (!sprite) unresolved.add(frame.spritePath || frame.sprite);
          return {
            sprite: frame.sprite,
            package: framePackage,
            glb: sprite?.glb,
            frameRun: frame.frameRun,
            durationSeconds: frame.frameRun / descriptor.framesPerSecond,
          };
        });
        if (frames.every((frame) => frame.glb === undefined)) throw new Error("none of the referenced PaperSprite frames resolved");
        const frameCount = descriptor.frames.reduce((sum, frame) => sum + frame.frameRun, 0);
        const durationSeconds = frameCount / descriptor.framesPerSecond;
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, `${JSON.stringify({
          name: descriptor.name,
          framesPerSecond: descriptor.framesPerSecond,
          frameCount,
          durationSeconds,
          frames,
        }, null, 2)}\n`);
        flipbooks.push({
          name: descriptor.name,
          package: entry.package,
          manifest: relativeManifest,
          framesPerSecond: descriptor.framesPerSecond,
          frames: frameCount,
          durationSeconds,
          unresolvedSprites: [...unresolved].sort(),
        });
        if (unresolved.size > 0) warnings.push(`${descriptor.name} has ${unresolved.size} unresolved PaperSprite reference${unresolved.size === 1 ? "" : "s"}.`);
      } catch (error) {
        await rm(output, { force: true });
        failed.push({ package: entry.package, reason: `PaperFlipbook packaging failed: ${error instanceof Error ? error.message : "unknown error"}` });
      }
    }
    if (flipbooks.length > 0) log(`Promoted ${flipbooks.length} PaperFlipbook manifest${flipbooks.length === 1 ? "" : "s"}.`);

    const tileSets = new Map<string, { descriptor: PaperTileSetDescriptor; source: string }>();
    const tileMaps: { descriptor: PaperTileMapDescriptor; source: string; entry: PackageClassification }[] = [];
    for (const source of paperTileSources) {
      try {
        const raw = JSON.parse(await readFile(source.descriptor, "utf8")) as { Class?: unknown };
        if (raw.Class === "PaperTileSet") {
          const descriptor = parsePaperTileSetDescriptor(raw);
          tileSets.set(descriptor.name.toLowerCase(), { descriptor, source: source.descriptor });
        } else if (raw.Class === "PaperTileMap") {
          tileMaps.push({ descriptor: parsePaperTileMapDescriptor(raw), source: source.descriptor, entry: source.entry });
        } else throw new Error("descriptor class is not PaperTileMap or PaperTileSet");
      } catch (error) {
        failed.push({ package: source.entry.package, reason: `PaperTile descriptor failed: ${error instanceof Error ? error.message : "unknown error"}` });
      }
    }
    for (const tileMap of tileMaps) {
      const tileSet = tileSets.get(tileMap.descriptor.selectedTileSet.toLowerCase());
      if (!tileSet) {
        failed.push({ package: tileMap.entry.package, reason: `PaperTileMap packaging failed: referenced tile set ${tileMap.descriptor.selectedTileSet} was not decoded` });
        continue;
      }
      const relativeGlb = `Models/${tileMap.entry.package.slice(0, -extname(tileMap.entry.package).length)}.glb`;
      const output = assertContained(promotion, relativeGlb);
      try {
        await mkdir(dirname(output), { recursive: true });
        const packaged = await writePaperTileMapGlb({
          map: tileMap.descriptor,
          tileSet: tileSet.descriptor,
          texturePath: assertContained(dirname(tileSet.source), tileSet.descriptor.texture),
          outputPath: output,
        });
        const validated = await validateGlb(output);
        models.push({
          name: tileMap.descriptor.name,
          package: tileMap.entry.package,
          kind: "static",
          glb: relativeGlb,
          bytes: validated.bytes,
          sha256: validated.sha256,
          vertices: packaged.vertices,
          primitives: 1,
          skins: 0,
          joints: 0,
          morphTargets: 0,
          animations: 0,
          boundsMetres: packaged.bounds,
          materials: [],
        });
        log(`Packaged ${relativeGlb} from ${packaged.tiles} PaperTileMap cells.`);
      } catch (error) {
        await rm(output, { force: true });
        failed.push({ package: tileMap.entry.package, reason: `PaperTileMap packaging failed: ${error instanceof Error ? error.message : "unknown error"}` });
      }
    }

    // A modern level or prefab whose conversion did not produce a scene source was already reported
    // above; reconstructing it again would only add a second, misleading ENOENT failure.
    const sceneEntries = [
      ...mapPackages.filter((entry) => sceneSourcePaths.has(entry.file)),
      ...[...modernMapPackages, ...modernPrefabPackages].filter((entry) => sceneSourcePaths.has(entry.file)),
    ];
    const sceneBasenameCounts = new Map<string, number>();
    for (const entry of sceneEntries) {
      const key = basename(entry.package, extname(entry.package)).toLowerCase();
      sceneBasenameCounts.set(key, (sceneBasenameCounts.get(key) ?? 0) + 1);
    }
    for (const entry of sceneEntries) {
      const name = basename(entry.package, extname(entry.package));
      try {
        const source = parseUnrealSceneSource(
          await readFile(sceneSourcePaths.get(entry.file) ?? join(sceneSources, `${name}.scene-source.json`), "utf8"),
        );
        const scopedSceneModels = modernSceneModelsByFile.get(entry.file) ?? [];
        const scene = await assembleSceneGlb({
          source,
          package: entry.package,
          outputRoot: promotion,
          ...((sceneBasenameCounts.get(name.toLowerCase()) ?? 0) > 1
            ? { outputStem: entry.package.slice(0, -extname(entry.package).length) }
            : {}),
          models: [
            ...models.filter((model) => !modernSceneModelPackages.has(model.package)),
            ...scopedSceneModels,
            ...sprites.map((sprite) => ({ name: sprite.name, glb: sprite.glb })),
          ],
          bitmapFonts: bitmapFonts.map((font) => ({ name: font.name, manifest: font.manifest })),
          validate: validateGlb,
        });
        scenes.push(scene);
        if (scene.unresolvedMeshes.length > 0) {
          warnings.push(
            `${scene.name} references ${scene.unresolvedMeshes.length} meshes that were not imported: ${scene.unresolvedMeshes.slice(0, 5).join(", ")}${scene.unresolvedMeshes.length > 5 ? ` and ${scene.unresolvedMeshes.length - 5} more` : ""}.`,
          );
        }
        if (scene.generatedEnginePrimitives.length > 0) {
          warnings.push(
            `${scene.name} generated installation-only Unreal Engine primitives not shipped in the pack: ${scene.generatedEnginePrimitives.join(", ")}.`,
          );
        }
        if (scene.blueprintComponents > 0) {
          warnings.push(
            `${scene.name} reconstructed ${scene.blueprintComponents} serialized Blueprint component defaults without executing Blueprint bytecode.`,
          );
        }
        if (scene.instances > 0) {
          warnings.push(
            `${scene.name} decoded ${scene.resolvedInstances}/${scene.instances} ISM/HISM/foliage placements into ${scene.instanceGroups} EXT_mesh_gpu_instancing group${scene.instanceGroups === 1 ? "" : "s"}.`,
          );
        }
        if (scene.landscapes > 0) {
          warnings.push(
            `${scene.name} decoded ${scene.landscapeVertices} UE4 Landscape heightfield vertices across ${scene.landscapes} components; material ${scene.landscapes === 1 ? "identity is" : "identities are"} preserved with neutral PBR shading.`,
          );
        }
        if (scene.approximatedAreaLights > 0) {
          warnings.push(
            `${scene.name} maps ${scene.approximatedAreaLights} Unreal rectangular area lights to KHR_lights_punctual point lights; their original dimensions remain in node extras and the scene manifest.`,
          );
        }
        if (scene.omittedActors.length > 0) {
          warnings.push(
            `${scene.name} reports ${scene.omittedActors.length} serialized component or behavior omission${scene.omittedActors.length === 1 ? "" : "s"}: ${scene.omittedActors.slice(0, 5).map((entry) => `${entry.actor}/${entry.component} (${entry.sourceClass})`).join(", ")}${scene.omittedActors.length > 5 ? ` and ${scene.omittedActors.length - 5} more` : ""}.`,
          );
        }
        log(
          `Packaged ${scene.glb} with ${scene.resolvedActors}/${scene.actors} mesh actors, ${scene.resolvedInstances}/${scene.instances} mesh instances, and ${scene.landscapes} landscape components.`,
        );
      } catch (error) {
        failed.push({
          package: entry.package,
          reason: `Level reconstruction failed: ${error instanceof Error ? error.message : "unknown error"}`,
        });
      }
    }

    if (
      models.length === 0 &&
      scenes.length === 0 &&
      textures.length === 0 &&
      cubemaps.length === 0 &&
      standaloneMaterials.length === 0 &&
      audio.length === 0 &&
      dataAssets.length === 0 &&
      textureStacks.length === 0 &&
      fonts.length === 0 &&
      bitmapFonts.length === 0 &&
      sprites.length === 0 &&
      flipbooks.length === 0 &&
      strands.length === 0
    ) {
      const reasons = failed.slice(0, 5).map((entry) => `${entry.package}: ${entry.reason}`);
      const more = failed.length > reasons.length ? ` (+${failed.length - reasons.length} more)` : "";
      throw new ImportError(
        "UNREAL_EXPORT_EMPTY",
        "No package produced a valid model, texture, cubemap, material, audio, font, bitmap font, sprite, flipbook, data asset, texture stack, strand, or scene; nothing was promoted." +
          (reasons.length > 0 ? ` Failures — ${reasons.join("; ")}${more}.` : ""),
      );
    }

    const sections = models.flatMap((model) => model.materials);
    const coverage = {
      sections: sections.length,
      textured: sections.filter((section) => section.textured).length,
      exact: sections.reduce(
        (sum, section) => sum + section.bindings.filter((binding) => binding.confidence === "exact").length,
        0,
      ),
      heuristic: sections.reduce(
        (sum, section) => sum + section.bindings.filter((binding) => binding.confidence === "heuristic").length,
        0,
      ),
      unsupported: sections.reduce((sum, section) => sum + section.unsupported.length, 0),
      unresolved: sections.filter((section) => !section.resolved).length,
      graphBaked: sections.filter((section) => section.graph?.status === "baked").length,
      effect: sections.filter((section) => section.effect !== undefined).length,
    };
    if (droppedTangents > 0) {
      warnings.push(
        `Dropped ${droppedTangents} zero-length TANGENT vectors UE Viewer wrote for these meshes; the runtime derives the tangent frame from UVs instead.`,
      );
    }
    if (prunedUvSets > 0) {
      warnings.push(
        `Dropped ${prunedUvSets} unused extra UV channels (TEXCOORD_1 and above); bound material coordinate sets were retained.`,
      );
    }
    if (repairedMorphDeltas > 0) {
      warnings.push(
        `Gave ${repairedMorphDeltas} seam-duplicated vertices the morph delta their twin carried; Unreal's export writes a source vertex's delta to one copy per UV or normal seam, which tears the skin open along the seam.`,
      );
    }
    if (conflictingMorphDeltas > 0) {
      warnings.push(
        `${conflictingMorphDeltas} seam-duplicated vertex groups carry two different non-zero morph deltas; both were kept, because either value would move a vertex the source placed elsewhere.`,
      );
    }
    if (coverage.unresolved > 0) {
      warnings.push(
        `${coverage.unresolved} mesh sections had no material UE Viewer could resolve; they are named "<mesh>_unresolved_section_<n>" and carry a neutral grey, not a debug colour.`,
      );
    }
    const effectSections = sections.filter((section) => section.effect !== undefined);
    if (effectSections.length > 0) {
      const byKind = (kind: string): number => effectSections.filter((section) => section.effect?.kind === kind).length;
      warnings.push(
        `${effectSections.length} material sections have no albedo by design and are not failures (${byKind("emissive")} emissive-only effect, ${byKind("engine-default-material")} engine default material, ${byKind("particle")} particle material); each carries "effect" with the reason.`,
      );
    }
    if (coverage.textured < coverage.sections) {
      warnings.push(
        `${coverage.sections - coverage.textured} material sections have no base colour texture and use an explicit named PBR fallback.`,
      );
    }
    const materialLimitations = [...new Set(sections.flatMap((section) => section.limitations))];
    for (const limitation of materialLimitations) warnings.push(`Material reconstruction: ${limitation}`);

    const report: ImportReport = {
      importer: { name: "threenative-asset-mcp", version: IMPORTER_VERSION },
      source: {
        kind: request.sourceKind ?? "local-directory",
        path: sourceDir,
        listingId: request.listingId,
        engine: request.engine,
        fileCount: files.length,
        totalBytes,
        sourceHash,
      },
      entitlement: {
        provider: request.listingId ? "fab" : "local",
        authenticatedDownload: request.authenticatedDownload ?? false,
        acquisition: "none",
        license: request.license,
      },
      toolchain: {
        umodel: umodel.version,
        fabcli: request.fabcliVersion,
        uncookedConverter: uncookedConverter?.version,
        modernConverter: modernConverter?.version,
      },
      cacheKey,
      reused: false,
      materials: coverage.textured === coverage.sections && materialLimitations.length === 0 ? "complete" : "degraded",
      counts: {
        packages: candidates.length,
        exported: models.length,
        textures: textures.length,
        cubemaps: cubemaps.length,
        materialAssets: standaloneMaterials.length,
        audio: audio.length,
        dataAssets: dataAssets.length,
        textureStacks: textureStacks.length,
        fonts: fonts.length,
        bitmapFonts: bitmapFonts.length,
        sprites: sprites.length,
        flipbooks: flipbooks.length,
        scenes: scenes.length,
        strands: strands.length,
        skipped: skipped.length,
        failed: failed.length,
      },
      models,
      textures,
      cubemaps,
      materialAssets: standaloneMaterials,
      audio,
      dataAssets,
      textureStacks,
      fonts,
      bitmapFonts,
      sprites,
      flipbooks,
      scenes,
      strands,
      skipped,
      failed,
      materialCoverage: coverage,
      transforms,
      sidecarTextures: [...sidecars.keys()].sort().map((name) => `textures/${name}.png`),
      warnings,
      durationMs: Date.now() - started,
    };

    await writeFile(join(promotion, "import-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    await rename(promotion, outputDir);
    // The staging PNGs are still on disk here and are removed in `finally`.
    if (request.proofSources) await request.proofSources(proofByGlb, report);
    log(
      `Promoted ${models.length} model GLB${models.length === 1 ? "" : "s"}, ${textures.length} texture PNG${textures.length === 1 ? "" : "s"}, ${cubemaps.length} cubemap environment map${cubemaps.length === 1 ? "" : "s"}, ${textureStacks.length} multidimensional texture stack${textureStacks.length === 1 ? "" : "s"}, ${standaloneMaterials.length} material asset${standaloneMaterials.length === 1 ? "" : "s"}, ${audio.length} audio file${audio.length === 1 ? "" : "s"}, ${fonts.length} font face${fonts.length === 1 ? "" : "s"}, ${bitmapFonts.length} bitmap font${bitmapFonts.length === 1 ? "" : "s"}, ${sprites.length} sprite GLB${sprites.length === 1 ? "" : "s"}, ${flipbooks.length} flipbook manifest${flipbooks.length === 1 ? "" : "s"}, ${dataAssets.length} data JSON file${dataAssets.length === 1 ? "" : "s"}, and ${scenes.length} scene GLB${scenes.length === 1 ? "" : "s"} to ${outputDir}.`,
    );
    return report;
  } catch (error) {
    await rm(promotion, { recursive: true, force: true });
    throw error;
  } finally {
    if (!request.keepStaging) await rm(staging, { recursive: true, force: true });
  }
}
