/** `.meta` importer settings the conversion needs, and the rule that binds an FBX material slot to a `.mat`. */
import { dirname, basename, extname } from "node:path/posix";

import type { TextureSettings } from "./textures.js";
import type { UnityAssetEntry } from "./package.js";
import { parseMeta, asUnityRef, type UnityRef } from "./yaml.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Finds `key` in an importer block or in the record blocks directly under it (`meshes:`, `materials:`, `bumpmap:`). */
function setting(importer: Record<string, unknown>, key: string): unknown {
  if (key in importer) return importer[key];
  for (const child of Object.values(importer)) {
    if (isRecord(child) && key in child) return child[key];
  }
  return undefined;
}

const num = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

export interface ModelSettings {
  readonly globalScale: number;
  readonly useFileScale: boolean;
  /** 0 none, 1 legacy, 2 material description. Unity 5 files only have `importMaterials`. */
  readonly materialImportMode: number;
  readonly externalObjects: readonly { readonly name: string; readonly ref: UnityRef }[];
}

export function readModelSettings(metaYaml: string): ModelSettings {
  const meta = parseMeta(metaYaml);
  const importer = isRecord(meta.ModelImporter) ? meta.ModelImporter : {};
  const mode = setting(importer, "materialImportMode");
  const legacy = setting(importer, "importMaterials");
  const externalObjects: { name: string; ref: UnityRef }[] = [];
  const raw = importer.externalObjects;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!isRecord(item) || !isRecord(item.first)) continue;
      const name = item.first.name;
      const type = String(item.first.type ?? "");
      const ref = asUnityRef(item.second);
      if (typeof name === "string" && /Material/.test(type) && ref && ref.guid) externalObjects.push({ name, ref });
    }
  }
  return {
    globalScale: num(setting(importer, "globalScale"), 1),
    useFileScale: num(setting(importer, "useFileScale"), 1) !== 0,
    materialImportMode: typeof mode === "number" ? mode : legacy === 0 ? 0 : 2,
    externalObjects,
  };
}

export function readTextureSettings(metaYaml: string): TextureSettings {
  const meta = parseMeta(metaYaml);
  const importer = isRecord(meta.TextureImporter) ? meta.TextureImporter : {};
  let unityMax = num(importer.maxTextureSize, 0);
  const platforms = importer.platformSettings;
  if (Array.isArray(platforms)) {
    const primary = platforms.find((item) => isRecord(item) && item.buildTarget === "DefaultTexturePlatform") ?? platforms[0];
    if (isRecord(primary)) unityMax = num(primary.maxTextureSize, unityMax);
  }
  return {
    srgb: num(setting(importer, "sRGBTexture"), 1) !== 0,
    normalMap: num(setting(importer, "textureType"), 0) === 1,
    convertToNormalMap: num(setting(importer, "convertToNormalMap"), 0) === 1,
    flipGreenChannel: num(setting(importer, "flipGreenChannel"), 0) === 1,
    ...(unityMax > 0 ? { unityMaxTextureSize: unityMax } : {}),
  };
}

export type BindingSource = "externalObjects" | "name-search";

export interface MaterialIndex {
  /** Material entries by lower-case file name without extension. */
  readonly byName: ReadonlyMap<string, readonly UnityAssetEntry[]>;
}

export function indexMaterials(entries: Iterable<UnityAssetEntry>): MaterialIndex {
  const byName = new Map<string, UnityAssetEntry[]>();
  for (const entry of entries) {
    if (entry.assetFile === undefined || extname(entry.path).toLowerCase() !== ".mat") continue;
    const key = basename(entry.path, extname(entry.path)).toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), entry]);
  }
  return { byName };
}

/** 0 is the best place for a material of the model at `modelPath`: its own `Materials` folder, then its folder, then up. */
function proximity(materialPath: string, modelPath: string): number {
  const materialDirectory = dirname(materialPath);
  let directory = dirname(modelPath);
  for (let depth = 0; ; depth += 1) {
    if (materialDirectory === `${directory}/Materials`) return depth * 2;
    if (materialDirectory === directory) return depth * 2 + 1;
    const parent = dirname(directory);
    if (parent === directory || directory === "." || directory === "") return 1_000;
    directory = parent;
  }
}

export interface SlotBinding {
  readonly source: BindingSource;
  readonly entry: UnityAssetEntry;
  readonly warning?: string;
}

/** Finds the `.mat` for an embedded material name by file name, nearest to the model first. */
export function searchMaterial(name: string, modelPath: string, index: MaterialIndex): SlotBinding | undefined {
  const candidates = index.byName.get(name.toLowerCase());
  if (!candidates || candidates.length === 0) return undefined;
  const ranked = candidates
    .map((entry) => ({
      entry,
      rank: proximity(entry.path, modelPath) + (basename(entry.path, extname(entry.path)) === name ? 0 : 5_000),
    }))
    .sort((a, b) => a.rank - b.rank || (a.entry.path < b.entry.path ? -1 : 1));
  const best = ranked[0]!;
  const tied = ranked.filter((candidate) => candidate.rank === best.rank);
  return {
    source: "name-search",
    entry: best.entry,
    ...(tied.length > 1 ? { warning: `${tied.length} materials named "${name}" are equally near the model; used ${best.entry.path}` } : {}),
  };
}
