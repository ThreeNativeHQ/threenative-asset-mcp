/**
 * Unity package to GLB. Opens the package (PRD-615), converts each model with headless Blender, replaces
 * Blender's materials with the ones Unity binds (`externalObjects`, else a search by name), writes textures,
 * and records every decision in `import-report.json`.
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative } from "node:path";

import { type Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { getBounds } from "@gltf-transform/functions";

import type { ProvisionLog } from "../unreal/provision.js";
import { childEnvironment, runBounded } from "../unreal/toolchain.js";
import { BLENDER_CONVERT_SCRIPT } from "./blender-script.js";
import { type BlenderTool, ensureBlender } from "./blender.js";
import { UnityImportError } from "./errors.js";
import { TextureCache, applyResolvedMaterial, disposeOrphanTextures } from "./gltf-materials.js";
import { inventoryUnityAssets, unityKind } from "./inventory.js";
import { identifyShader, readMaterial, resolveMaterial, type ResolvedMaterial, type TextureBinding, type TextureLookup } from "./materials.js";
import { type UnityAssetDatabase, type UnityAssetEntry, openUnityPackage } from "./package.js";
import { type BindingSource, indexMaterials, readModelSettings, readTextureSettings, searchMaterial } from "./settings.js";
import {
  type DecodedImage,
  type ImageRecipe,
  UnityTextureError,
  decodeTexture,
  encodePng,
  limitTextureSize,
  recipeKey,
  recipeTextures,
  renderRecipe,
} from "./textures.js";
import { type ComponentNote, type LodNote, PrefabResolver, type PrefabNode, type ResolvedPrefab, type Unresolved } from "./prefab.js";
import { writePrefabDocument } from "./prefab-glb.js";
import { parseUnityDocuments, resolveRef } from "./yaml.js";

/** Bump when a change alters the GLBs or the report for the same package. */
export const UNITY_IMPORTER_VERSION = 3;

const SUPPORTED_MODELS = new Set([".fbx", ".obj", ".blend"]);
const NEEDS_DCC = new Set([".max", ".ma", ".mb"]);
const LICENSE_FILE = /^(licen[sc]e|copying|notice|third[-_ ]?party[-_ ]?notices?)(\.[a-z0-9]+)?$/i;
const BLENDER_TIMEOUT_MS = 900_000;

export interface UnityImportOptions {
  readonly source: string;
  readonly outputDir: string;
  /** Model and prefab paths, file names or names without extension. Omit to convert every supported model and prefab. */
  readonly assets?: readonly string[];
  /** Longest edge of written textures. Unset keeps the source size. */
  readonly maxTextureSize?: number;
  readonly environment?: NodeJS.ProcessEnv;
  readonly log?: ProvisionLog;
  /** Tests inject a resolved Blender instead of resolving one. */
  readonly blender?: BlenderTool;
}

export type SlotBindingSource = BindingSource | "embedded" | "disabled";

export interface ReportSlot {
  readonly embedded: string;
  readonly binding: SlotBindingSource;
  readonly material?: string;
  readonly status: "mapped" | "fallback" | "embedded";
  readonly fallbackReason?: string;
}

export interface ReportModel {
  readonly name: string;
  readonly source: string;
  readonly glb: string;
  readonly bytes: number;
  readonly vertices: number;
  readonly sizeMeters: { readonly x: number; readonly y: number; readonly z: number };
  readonly scale: { readonly globalScale: number; readonly useFileScale: boolean; readonly fileUnitScale?: number };
  readonly slots: readonly ReportSlot[];
  readonly warnings: readonly string[];
}

export interface ReportPrefab {
  readonly name: string;
  readonly source: string;
  readonly glb: string;
  readonly bytes: number;
  readonly nodes: number;
  readonly meshNodes: number;
  readonly vertices: number;
  readonly sizeMeters: { readonly x: number; readonly y: number; readonly z: number };
  /** MeshRenderer slots a `.mat` replaced, and the distinct `.mat` paths used: what colours the prefab. */
  readonly boundSlots: number;
  readonly materials: readonly string[];
  /** Colliders are listed, not imported. */
  readonly colliders: readonly ComponentNote[];
  /** Scripts, lights, audio, skinned meshes and other components that are not imported. */
  readonly components: readonly ComponentNote[];
  /** LOD levels above 0; LOD0 is imported. */
  readonly lodLevels: readonly LodNote[];
  readonly inactive: readonly string[];
  readonly unresolved: readonly Unresolved[];
  readonly warnings: readonly string[];
}

export interface ReportMaterial {
  readonly name: string;
  readonly path: string;
  readonly pipeline: ResolvedMaterial["pipeline"];
  readonly status: "mapped" | "fallback";
  readonly shader: { readonly ref: string; readonly path?: string };
  readonly fallbackReason?: string;
  readonly alphaMode: string;
  readonly textures: readonly string[];
  readonly ignored: readonly string[];
  readonly unsupported: readonly string[];
  readonly warnings: readonly string[];
  readonly usedBy: number;
}

export interface ReportTexture {
  readonly name: string;
  readonly png: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  readonly kind: ImageRecipe["kind"];
  readonly sources: readonly string[];
  readonly colorSpace: "srgb" | "linear";
}

export interface ReportLicenseFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly excerpt: string;
}

export interface UnityImportReport {
  readonly importerVersion: number;
  readonly source: { readonly shape: string; readonly name: string };
  readonly blender: { readonly version: string; readonly origin: BlenderTool["source"] };
  readonly materials: "complete" | "degraded";
  readonly counts: {
    readonly models: number;
    readonly prefabs: number;
    readonly materials: number;
    readonly textures: number;
    readonly fallbackMaterials: number;
    readonly boundSlots: number;
    readonly skipped: number;
    readonly failed: number;
  };
  readonly licenseFiles: readonly ReportLicenseFile[];
  readonly models: readonly ReportModel[];
  readonly prefabs: readonly ReportPrefab[];
  readonly materialAssets: readonly ReportMaterial[];
  readonly textures: readonly ReportTexture[];
  readonly skipped: readonly { readonly asset: string; readonly reason: string }[];
  readonly failed: readonly { readonly asset: string; readonly reason: string }[];
  readonly warnings: readonly string[];
  readonly durationMs: number;
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "_").slice(0, 80) || "asset";
}

const shortHash = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 8);

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

async function requireFreshOutput(outputDir: string): Promise<void> {
  if (!(await pathExists(outputDir))) return;
  if ((await readdir(outputDir)).length > 0) {
    throw new UnityImportError(
      "UNITY_OUTPUT_EXISTS",
      `${outputDir} already has files. This tool never overwrites an import: choose an empty or new directory.`,
    );
  }
}

function matchesAsset(entry: UnityAssetEntry, wanted: string): boolean {
  const lower = wanted.toLowerCase();
  const path = entry.path.toLowerCase();
  return path === lower || path.endsWith(`/${lower}`) || basename(path, extname(path)) === lower;
}

const unsupportedModelReason = (extension: string): string =>
  NEEDS_DCC.has(extension)
    ? `${extension} needs the authoring application (Max or Maya) to convert; export an FBX instead`
    : `${extension} models are not converted yet`;

function selectModels(database: UnityAssetDatabase, assets: readonly string[] | undefined): {
  chosen: UnityAssetEntry[];
  skipped: { asset: string; reason: string }[];
} {
  const skipped: { asset: string; reason: string }[] = [];
  const models = [...database.entries.values()]
    .filter((entry) => entry.assetFile !== undefined && unityKind(entry.path) === "model")
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  const chosen: UnityAssetEntry[] = [];
  for (const entry of models) {
    if (assets && !assets.some((wanted) => matchesAsset(entry, wanted))) continue;
    const extension = extname(entry.path).toLowerCase();
    if (SUPPORTED_MODELS.has(extension)) chosen.push(entry);
    else skipped.push({ asset: entry.path, reason: unsupportedModelReason(extension) });
  }
  return { chosen, skipped };
}

function selectPrefabs(database: UnityAssetDatabase, assets: readonly string[] | undefined): UnityAssetEntry[] {
  return [...database.entries.values()]
    .filter((entry) => entry.assetFile !== undefined && unityKind(entry.path) === "prefab")
    .filter((entry) => !assets || assets.some((wanted) => matchesAsset(entry, wanted)))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
}

async function readLicenseFiles(database: UnityAssetDatabase): Promise<ReportLicenseFile[]> {
  const found: ReportLicenseFile[] = [];
  for (const entry of [...database.entries.values()].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    if (entry.assetFile === undefined || !LICENSE_FILE.test(basename(entry.path))) continue;
    const bytes = await readFile(entry.assetFile);
    found.push({
      path: entry.path,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      excerpt: bytes.subarray(0, 500).toString("utf8").replace(/\0/g, "").trim(),
    });
  }
  return found;
}

/** The Blender GLB's vertex total and world-space size. */
function measure(document: import("@gltf-transform/core").Document): { vertices: number; size: { x: number; y: number; z: number } } {
  let vertices = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) vertices += primitive.getAttribute("POSITION")?.getCount() ?? 0;
  }
  const scene = document.getRoot().getDefaultScene() ?? document.getRoot().listScenes()[0];
  const { min, max } = scene ? getBounds(scene) : { min: [0, 0, 0] as number[], max: [0, 0, 0] as number[] };
  const size = { x: max[0]! - min[0]!, y: max[1]! - min[1]!, z: max[2]! - min[2]! };
  const finite = [size.x, size.y, size.z].every(Number.isFinite);
  return { vertices, size: finite ? size : { x: 0, y: 0, z: 0 } };
}

interface TextureInfo {
  readonly entry: UnityAssetEntry;
  readonly binding: TextureBinding;
}

class Importer {
  private readonly materialIndex;
  private readonly textureInfo = new Map<string, TextureInfo>();
  private readonly materialCache = new Map<string, { resolved?: ResolvedMaterial; path: string; usedBy: number; error?: string }>();
  private readonly imageCache = new Map<string, Promise<{ name: string; png: Buffer }>>();
  private readonly textureReport = new Map<string, ReportTexture>();
  private readonly modelNames = new Set<string>();
  private readonly prefabNames = new Set<string>();
  private readonly modelFiles = new Map<string, string>();
  private readonly modelDocuments = new Map<string, Promise<Document>>();

  constructor(
    private readonly database: UnityAssetDatabase,
    private readonly outputDir: string,
    private readonly maxTextureSize: number | undefined,
  ) {
    this.materialIndex = indexMaterials(database.entries.values());
  }

  get textures(): ReportTexture[] {
    return [...this.textureReport.values()].sort((a, b) => (a.png < b.png ? -1 : 1));
  }

  get materials(): ReportMaterial[] {
    return [...this.materialCache.values()]
      .filter((cached) => cached.resolved !== undefined)
      .map((cached) => {
        const material = cached.resolved!;
        return {
          name: material.name,
          path: cached.path,
          pipeline: material.pipeline,
          status: material.status,
          shader: material.shader,
          ...(material.fallbackReason ? { fallbackReason: material.fallbackReason } : {}),
          alphaMode: material.alphaMode,
          textures: [...new Set([material.baseColor, material.metallicRoughness, material.normal, material.occlusion, material.emissive, material.specular?.colorTexture]
            .flatMap((slot) => (slot ? slot.sources : []))
            .map((guid) => this.database.entries.get(guid)?.path ?? guid))].sort(),
          ignored: material.ignored,
          unsupported: material.unsupported,
          warnings: material.warnings,
          usedBy: cached.usedBy,
        };
      })
      .sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  private texture(guid: string): TextureInfo | undefined {
    const cached = this.textureInfo.get(guid);
    if (cached) return cached;
    const entry = this.database.entries.get(guid);
    if (!entry || entry.assetFile === undefined || unityKind(entry.path) !== "texture") return undefined;
    const info: TextureInfo = { entry, binding: { guid, path: entry.path, settings: readTextureSettings(entry.metaYaml) } };
    this.textureInfo.set(guid, info);
    return info;
  }

  private readonly lookup: TextureLookup = (ref) => {
    if (!ref) return undefined;
    const resolved = resolveRef(ref, { database: this.database });
    if (resolved.kind === "null" || resolved.kind === "builtin" || resolved.kind === "local") return undefined;
    if (resolved.kind === "missing") return "missing";
    return this.texture(resolved.guid)?.binding ?? "missing";
  };

  /** Parses and resolves a `.mat` once per run. */
  async material(entry: UnityAssetEntry): Promise<ResolvedMaterial | undefined> {
    const cached = this.materialCache.get(entry.guid);
    if (cached) {
      cached.usedBy += 1;
      return cached.resolved;
    }
    const record: { resolved?: ResolvedMaterial; path: string; usedBy: number; error?: string } = { path: entry.path, usedBy: 1 };
    this.materialCache.set(entry.guid, record);
    try {
      const documents = parseUnityDocuments(await readFile(entry.assetFile!, "utf8"));
      const material = readMaterial(documents, basename(entry.path, extname(entry.path)));
      if (!material) throw new Error("no Material document");
      const identity = identifyShader(material.shader, (guid) => this.database.entries.get(guid)?.path);
      record.resolved = resolveMaterial(material, identity, this.lookup);
    } catch (error) {
      record.error = error instanceof Error ? error.message : "unreadable material";
    }
    return record.resolved;
  }

  materialError(entry: UnityAssetEntry): string | undefined {
    return this.materialCache.get(entry.guid)?.error;
  }

  /** Renders one image recipe to `textures/` once and returns its bytes for embedding. */
  readonly imageSource = (recipe: ImageRecipe): Promise<{ name: string; png: Buffer }> => {
    const key = recipeKey(recipe) + String(this.maxTextureSize ?? "");
    let pending = this.imageCache.get(key);
    if (!pending) {
      pending = this.renderImage(recipe, key);
      this.imageCache.set(key, pending);
    }
    return pending;
  };

  private async renderImage(recipe: ImageRecipe, key: string): Promise<{ name: string; png: Buffer }> {
    const sources = recipeTextures(recipe);
    const infos = sources.map((guid) => this.texture(guid));
    if (infos.some((info) => info === undefined)) throw new UnityTextureError("a source texture is not in the package");
    const decoded = new Map<string, DecodedImage>();
    const rendered = await renderRecipe(recipe, {
      load: async (guid) => {
        let image = decoded.get(guid);
        if (!image) {
          const info = this.texture(guid)!;
          image = await limitTextureSize(await decodeTexture(info.entry.assetFile!, info.entry.path), this.maxTextureSize);
          decoded.set(guid, image);
        }
        return image;
      },
      settings: (guid) => this.texture(guid)!.binding.settings,
    });
    const png = await encodePng(rendered);
    const first = infos[0]!;
    const suffix = recipe.kind === "copy" ? "" : recipe.kind === "metallicRoughness" ? "-metallic-roughness" : "-occlusion";
    const name = `${safeName(basename(first.entry.path, extname(first.entry.path)))}${suffix}-${shortHash(key)}`;
    await mkdir(join(this.outputDir, "textures"), { recursive: true });
    await writeFile(join(this.outputDir, "textures", `${name}.png`), png);
    this.textureReport.set(name, {
      name,
      png: `textures/${name}.png`,
      bytes: png.length,
      width: rendered.width,
      height: rendered.height,
      kind: recipe.kind,
      sources: infos.map((info) => info!.entry.path),
      colorSpace: recipe.kind === "copy" && recipe.role === "color" ? "srgb" : "linear",
    });
    return { name, png };
  }

  private uniqueName(used: Set<string>, entry: UnityAssetEntry): string {
    const base = safeName(basename(entry.path, extname(entry.path)));
    const name = used.has(base.toLowerCase()) ? `${base}-${shortHash(entry.path)}` : base;
    used.add(name.toLowerCase());
    return name;
  }

  modelFileName(entry: UnityAssetEntry): string {
    return this.uniqueName(this.modelNames, entry);
  }

  /** Remembers where a converted model's final GLB is, so prefabs can take its meshes. */
  recordModel(entry: UnityAssetEntry, glb: string): void {
    this.modelFiles.set(entry.guid, glb);
  }

  /** The converted model's GLB (a prefab host method), read once per run. */
  modelDocument(entry: UnityAssetEntry): Promise<Document | undefined> {
    const file = this.modelFiles.get(entry.guid);
    if (file === undefined) return Promise.resolve(undefined);
    let pending = this.modelDocuments.get(entry.guid);
    if (!pending) {
      pending = new NodeIO().registerExtensions(ALL_EXTENSIONS).read(file);
      this.modelDocuments.set(entry.guid, pending);
    }
    return pending;
  }

  /** Builds and writes the GLB of one resolved prefab. */
  async finishPrefab(prefab: ResolvedPrefab): Promise<ReportPrefab> {
    const built = await writePrefabDocument(prefab, this);
    const name = this.uniqueName(this.prefabNames, prefab.entry);
    const glb = join(this.outputDir, "prefabs", `${name}.glb`);
    await mkdir(dirname(glb), { recursive: true });
    const bytes = await new NodeIO().registerExtensions(ALL_EXTENSIONS).writeBinary(built.document);
    await writeFile(glb, bytes);
    const { vertices, size } = measure(built.document);
    return {
      name: basename(prefab.entry.path, extname(prefab.entry.path)),
      source: prefab.entry.path,
      glb: relative(this.outputDir, glb).split("\\").join("/"),
      bytes: bytes.length,
      nodes: prefab.nodeCount,
      meshNodes: built.meshNodes,
      vertices,
      sizeMeters: size,
      boundSlots: built.boundSlots,
      materials: built.boundMaterials,
      colliders: prefab.colliders,
      components: prefab.components,
      lodLevels: prefab.lodLevels,
      inactive: prefab.inactive,
      unresolved: [...prefab.unresolved, ...built.unresolved],
      warnings: [...prefab.warnings, ...built.warnings],
    };
  }

  /** Binds each embedded material of one converted model and writes the final GLB. */
  async finishModel(entry: UnityAssetEntry, blenderGlb: string, finalGlb: string, extra: { fileUnitScale?: number; warnings: string[] }): Promise<ReportModel> {
    const settings = readModelSettings(entry.metaYaml);
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
    const document = await io.read(blenderGlb);
    const cache = new TextureCache(document);
    const slots: ReportSlot[] = [];
    const warnings = [...extra.warnings];
    const explicit = new Map(settings.externalObjects.map((item) => [item.name, item.ref]));
    for (const material of document.getRoot().listMaterials()) {
      const embedded = material.getName();
      let bound: { entry: UnityAssetEntry; source: BindingSource } | undefined;
      if (settings.materialImportMode !== 0) {
        const ref = explicit.get(embedded);
        const target = ref?.guid ? this.database.entries.get(ref.guid) : undefined;
        if (target && target.assetFile !== undefined) bound = { entry: target, source: "externalObjects" };
        else if (ref) warnings.push(`externalObjects maps "${embedded}" to a material that is not in the package`);
        if (!bound) {
          const found = searchMaterial(embedded, entry.path, this.materialIndex);
          if (found) {
            bound = { entry: found.entry, source: found.source };
            if (found.warning) warnings.push(found.warning);
          }
        }
      }
      const resolved = bound ? await this.material(bound.entry) : undefined;
      if (bound && !resolved) {
        warnings.push(`${bound.entry.path} could not be read (${this.materialError(bound.entry) ?? "unknown error"}); kept the embedded material "${embedded}"`);
      }
      if (!bound || !resolved) {
        slots.push({ embedded, binding: settings.materialImportMode === 0 ? "disabled" : "embedded", status: "embedded" });
        continue;
      }
      const textureWarnings = await applyResolvedMaterial(document, cache, material, resolved, this.imageSource);
      if (textureWarnings.length > 0) {
        const known = this.materialCache.get(bound.entry.guid)!.resolved!;
        this.materialCache.get(bound.entry.guid)!.resolved = { ...known, warnings: [...new Set([...known.warnings, ...textureWarnings])] };
      }
      slots.push({
        embedded,
        binding: bound.source,
        material: bound.entry.path,
        status: resolved.status,
        ...(resolved.fallbackReason ? { fallbackReason: resolved.fallbackReason } : {}),
      });
    }
    disposeOrphanTextures(document);
    const bytes = await io.writeBinary(document);
    await writeFile(finalGlb, bytes);
    const { vertices, size } = measure(document);
    return {
      name: basename(entry.path, extname(entry.path)),
      source: entry.path,
      glb: relative(this.outputDir, finalGlb).split("\\").join("/"),
      bytes: bytes.length,
      vertices,
      sizeMeters: size,
      scale: {
        globalScale: settings.globalScale,
        useFileScale: settings.useFileScale,
        ...(extra.fileUnitScale !== undefined ? { fileUnitScale: extra.fileUnitScale } : {}),
      },
      slots,
      warnings,
    };
  }
}

async function runBlender(
  blender: BlenderTool,
  entry: UnityAssetEntry,
  work: string,
  index: number,
  settings: ReturnType<typeof readModelSettings>,
  environment: NodeJS.ProcessEnv,
): Promise<{ glb: string; fileUnitScale?: number; warnings: string[] }> {
  const extension = extname(entry.path).toLowerCase();
  // Blender picks the importer by extension and a packaged asset has none, so it gets a named link.
  const source = join(work, `model-${index}${extension}`);
  try {
    await symlink(entry.assetFile!, source);
  } catch {
    await copyFile(entry.assetFile!, source);
  }
  const target = join(work, `model-${index}.glb`);
  const scratch = join(work, `tmp-${index}`);
  await mkdir(scratch, { recursive: true });
  const script = join(work, "convert.py");
  await writeFile(script, BLENDER_CONVERT_SCRIPT);
  const run = await runBounded(
    blender.path,
    ["-b", "--factory-startup", "--disable-autoexec", "--python-exit-code", "1", "--python", script, "--", source, target, String(settings.globalScale), settings.useFileScale ? "1" : "0"],
    {
      timeoutMs: BLENDER_TIMEOUT_MS,
      maxOutputBytes: 16 * 1024 * 1024,
      environment: { ...childEnvironment(environment), TMPDIR: scratch, TEMP: scratch, TMP: scratch },
    },
  );
  if (run.code !== 0 || !(await pathExists(target))) {
    const detail = `${run.stderr}\n${run.stdout}`
      .split("\n")
      .filter((line) => /Error|error|Traceback|RuntimeError/.test(line))
      .slice(-3)
      .join(" | ")
      .slice(0, 400);
    throw new UnityImportError("UNITY_BLENDER_FAILED", `Blender could not convert the model (exit ${run.code})${detail ? `: ${detail}` : ""}`);
  }
  const info = /^UNITY_INFO (.*)$/m.exec(run.stdout)?.[1];
  let parsed: { fileUnitScale?: number | null; warnings?: string[] } = {};
  try {
    parsed = info ? (JSON.parse(info) as typeof parsed) : {};
  } catch {
    // The info line is advisory.
  }
  return {
    glb: target,
    ...(typeof parsed.fileUnitScale === "number" ? { fileUnitScale: parsed.fileUnitScale } : {}),
    warnings: parsed.warnings ?? [],
  };
}

/** Converts a package. Writes `<outputDir>/models`, `<outputDir>/textures` and `<outputDir>/import-report.json`. */
export async function importUnityPackage(options: UnityImportOptions): Promise<UnityImportReport> {
  const started = performance.now();
  const environment = options.environment ?? process.env;
  await requireFreshOutput(options.outputDir);
  const database = await openUnityPackage(options.source);
  const work = await mkdtemp(join(tmpdir(), "threenative-unity-import-"));
  try {
    const inventory = inventoryUnityAssets(database);
    const { chosen, skipped } = selectModels(database, options.assets);
    const prefabEntries = selectPrefabs(database, options.assets);
    if (options.assets && chosen.length === 0 && prefabEntries.length === 0) {
      throw new UnityImportError(
        "UNITY_IMPORT_INVALID_INPUT",
        `No convertible model or prefab matched ${JSON.stringify(options.assets)}. The package holds ${inventory.model} model file(s) and ${inventory.prefab} prefab(s).`,
      );
    }
    const allModels = [...database.entries.values()].filter((entry) => entry.assetFile !== undefined && unityKind(entry.path) === "model");
    const warnings = (options.assets ?? [])
      .filter((wanted) => !allModels.some((entry) => matchesAsset(entry, wanted)) && !prefabEntries.some((entry) => matchesAsset(entry, wanted)))
      .map((wanted) => `assets entry "${wanted}" matched no model or prefab`);
    const importer = new Importer(database, options.outputDir, options.maxTextureSize);

    // Prefabs are resolved first: the models they use are converted even when `assets` did not name them.
    const failed: { asset: string; reason: string }[] = [];
    const resolver = new PrefabResolver(database);
    const resolved: ResolvedPrefab[] = [];
    for (const entry of prefabEntries) {
      try {
        resolved.push(await resolver.resolve(entry));
      } catch (error) {
        failed.push({ asset: entry.path, reason: error instanceof Error ? error.message : "prefab could not be resolved" });
      }
    }
    const toConvert = new Map(chosen.map((entry) => [entry.guid, entry]));
    const used = new Map<string, UnityAssetEntry>();
    const visit = (node: PrefabNode): void => {
      for (const entry of [node.mesh?.model, node.model]) if (entry) used.set(entry.guid, entry);
      node.children.forEach(visit);
    };
    resolved.forEach((prefab) => prefab.roots.forEach(visit));
    for (const entry of used.values()) {
      if (toConvert.has(entry.guid)) continue;
      const extension = extname(entry.path).toLowerCase();
      if (SUPPORTED_MODELS.has(extension)) toConvert.set(entry.guid, entry);
      else if (!skipped.some((item) => item.asset === entry.path)) skipped.push({ asset: entry.path, reason: unsupportedModelReason(extension) });
    }
    const converting = [...toConvert.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
    const blender = converting.length > 0 ? (options.blender ?? (await ensureBlender(environment, options.log))) : undefined;
    // Created only now: a missing Blender above must not leave an output a retry would refuse.
    await mkdir(join(options.outputDir, "models"), { recursive: true });

    const models: ReportModel[] = [];
    for (const [index, entry] of converting.entries()) {
      try {
        const settings = readModelSettings(entry.metaYaml);
        const converted = await runBlender(blender!, entry, work, index, settings, environment);
        const name = importer.modelFileName(entry);
        const finalGlb = join(options.outputDir, "models", `${name}.glb`);
        models.push(await importer.finishModel(entry, converted.glb, finalGlb, {
          ...(converted.fileUnitScale !== undefined ? { fileUnitScale: converted.fileUnitScale } : {}),
          warnings: converted.warnings,
        }));
        importer.recordModel(entry, finalGlb);
        await rm(converted.glb, { force: true });
      } catch (error) {
        if (error instanceof UnityImportError && error.code === "UNITY_OUTPUT_EXISTS") throw error;
        failed.push({ asset: entry.path, reason: error instanceof Error ? error.message : "conversion failed" });
      }
    }

    const prefabs: ReportPrefab[] = [];
    for (const prefab of resolved) {
      try {
        prefabs.push(await importer.finishPrefab(prefab));
      } catch (error) {
        failed.push({ asset: prefab.entry.path, reason: error instanceof Error ? error.message : "prefab could not be written" });
      }
    }

    const materialAssets = importer.materials;
    const textures = importer.textures;
    const fallbackMaterials = materialAssets.filter((material) => material.status === "fallback").length;
    const boundSlots = models.reduce((sum, model) => sum + model.slots.filter((slot) => slot.status !== "embedded").length, 0);
    const unbound = models.reduce((sum, model) => sum + model.slots.filter((slot) => slot.status === "embedded").length, 0);
    const report: UnityImportReport = {
      importerVersion: UNITY_IMPORTER_VERSION,
      source: { shape: database.shape, name: basename(options.source) },
      blender: { version: blender?.version ?? "not used", origin: blender?.source ?? "PATH" },
      materials: fallbackMaterials === 0 && unbound === 0 && failed.length === 0 ? "complete" : "degraded",
      counts: {
        models: models.length,
        prefabs: prefabs.length,
        materials: materialAssets.length,
        textures: textures.length,
        fallbackMaterials,
        boundSlots,
        skipped: skipped.length,
        failed: failed.length,
      },
      licenseFiles: await readLicenseFiles(database),
      models,
      prefabs,
      materialAssets,
      textures,
      skipped,
      failed,
      warnings,
      durationMs: Math.round(performance.now() - started),
    };
    await writeFile(join(options.outputDir, "import-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally {
    await rm(work, { recursive: true, force: true });
    await database.dispose();
  }
}
