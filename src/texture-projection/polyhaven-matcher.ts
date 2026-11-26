import { readFile } from "node:fs/promises";

import sharp from "sharp";

import { PolyHavenClient, type PolyHavenAsset } from "../polyhaven/client.js";

export type PolyHavenMatchMode = "detailed" | "lean";

export type PolyHavenSurfaceDecision =
  | "use_polyhaven_pbr"
  | "polyhaven_detail_plus_project"
  | "ai_project_only"
  | "procedural_tint_fallback";

export type PolyHavenModelDecision =
  | "use_polyhaven_model"
  | "ai_project_only"
  | "procedural_tint_fallback";

export interface SurfaceCropRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PolyHavenSurfaceQuery {
  readonly name: string;
  readonly query: string;
  readonly crop?: SurfaceCropRect;
  readonly homogeneous?: boolean;
  readonly referenceImagePath?: string;
}

export interface PolyHavenModelQuery {
  readonly name: string;
  readonly query: string;
  readonly crop?: SurfaceCropRect;
  readonly referenceImagePath?: string;
  readonly dimensionsMeters?: readonly [number, number, number];
  readonly maxPolycount?: number;
}

export interface TextureFeatures {
  readonly meanL: number;
  readonly stdL: number;
  readonly meanA: number;
  readonly stdA: number;
  readonly meanB: number;
  readonly stdB: number;
  readonly gradFine: number;
  readonly gradCoarse: number;
  readonly referenceHex?: string;
}

export interface PolyHavenCandidateScore {
  readonly id: string;
  readonly name: string;
  readonly score: number;
  readonly semanticScore: number;
  readonly labChromaScore: number;
  readonly textureEnergyScore: number;
  readonly thumbnailUrl: string;
  readonly labColorShift: { readonly dL: number; readonly dA: number; readonly dB: number };
  readonly dimensions?: readonly number[];
  readonly polycount?: number;
}

export interface SurfaceMaterialMatch {
  readonly name: string;
  readonly eligible: boolean;
  readonly decision: PolyHavenSurfaceDecision;
  readonly referenceHex: string;
  readonly bestMatch: PolyHavenCandidateScore | null;
  readonly alternatives: readonly PolyHavenCandidateScore[];
}

export interface ModelAssetMatch {
  readonly name: string;
  readonly decision: PolyHavenModelDecision;
  readonly referenceHex: string;
  readonly bestMatch: PolyHavenCandidateScore | null;
  readonly alternatives: readonly PolyHavenCandidateScore[];
}

export interface MatchPolyHavenInput {
  readonly mode?: PolyHavenMatchMode;
  readonly referenceImagePath?: string;
  readonly referenceImagePaths?: readonly string[];
  readonly surfaces: readonly PolyHavenSurfaceQuery[];
  readonly topCandidates?: number;
}

export interface MatchPolyHavenModelsInput {
  readonly mode?: PolyHavenMatchMode;
  readonly referenceImagePath?: string;
  readonly referenceImagePaths?: readonly string[];
  readonly models: readonly PolyHavenModelQuery[];
  readonly topCandidates?: number;
}

export interface MatchPolyHavenDeps {
  readonly client: PolyHavenClient;
  readonly fetchImpl?: typeof fetch;
}

const NON_TILING_HERO_PATTERN =
  /\b(shopfront|storefront|mural|signage|graffiti|interior|custom|hero|display)\b|facade[-_\s]+detail/iu;
const TILING_SURFACE_PATTERN =
  /\b(cobble|cobblestone|paving|paver|asphalt|concrete|brick|stone|tile|tiles|roof|wood|plank|planks|plaster|stucco|curb|sidewalk|dirt|gravel|sand|metal|wall|walls|floor|ground|road|street|terracotta)\b/iu;

/**
 * Surfaces that repeat uniformly across a level can use CC0 Poly Haven PBR textures instead of burning
 * AI projection credits; unique hero shopfronts/murals remain AI-projected.
 */
export function isEligibleForTilingPbr(surface: {
  readonly name: string;
  readonly description: string;
  readonly homogeneous?: boolean;
}): boolean {
  if (surface.homogeneous === false) return false;
  const text = `${surface.name} ${surface.description}`;
  if (NON_TILING_HERO_PATTERN.test(text)) return false;
  return TILING_SURFACE_PATTERN.test(text);
}

/** Route a surface between Poly Haven PBR, hybrid detail+AI projection, AI-only projection, or keyless procedural fallback. */
export function routeSurfaceMaterial(
  score: number,
  eligible: boolean,
  mode: PolyHavenMatchMode = "detailed",
): PolyHavenSurfaceDecision {
  if (mode === "lean") {
    if (!eligible || score < 0.45) return "procedural_tint_fallback";
    return "use_polyhaven_pbr";
  }
  if (!eligible || score < 0.5) return "ai_project_only";
  if (score >= 0.72) return "use_polyhaven_pbr";
  return "polyhaven_detail_plus_project";
}

/** Route a prop/object between a Poly Haven CC0 3D model, AI blockout projection, or procedural fallback. */
export function routePropModel(
  score: number,
  mode: PolyHavenMatchMode = "detailed",
): PolyHavenModelDecision {
  const threshold = mode === "lean" ? 0.45 : 0.55;
  if (score >= threshold) return "use_polyhaven_model";
  return mode === "lean" ? "procedural_tint_fallback" : "ai_project_only";
}

function toHexByte(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
}

function srgbToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function labF(t: number): number {
  return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
}

function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const rl = srgbToLinear(r);
  const gl = srgbToLinear(g);
  const bl = srgbToLinear(b);
  const x = (0.4124564 * rl + 0.3575761 * gl + 0.1804375 * bl) / 0.95047;
  const y = 0.2126729 * rl + 0.7151522 * gl + 0.072175 * bl;
  const z = (0.0193339 * rl + 0.119192 * gl + 0.9503041 * bl) / 1.08883;
  const fx = labF(x);
  const fy = labF(y);
  const fz = labF(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function meanSobelMagnitude(lChannel: Float64Array, side: number): number {
  if (side < 3) return 0;
  let sum = 0;
  let count = 0;
  for (let y = 1; y < side - 1; y++) {
    for (let x = 1; x < side - 1; x++) {
      const idx = (yy: number, xx: number) => lChannel[yy * side + xx]!;
      const gx =
        -idx(y - 1, x - 1) + idx(y - 1, x + 1) - 2 * idx(y, x - 1) + 2 * idx(y, x + 1) - idx(y + 1, x - 1) + idx(y + 1, x + 1);
      const gy =
        -idx(y - 1, x - 1) - 2 * idx(y - 1, x) - idx(y - 1, x + 1) + idx(y + 1, x - 1) + 2 * idx(y + 1, x) + idx(y + 1, x + 1);
      sum += Math.hypot(gx, gy) / 4;
      count += 1;
    }
  }
  return count > 0 ? sum / count : 0;
}

/**
 * Extract CIELAB color statistics and two-scale Sobel gradient energy from an image buffer
 * so texture matching stays robust against global shadows or brightness offsets.
 */
export async function extractTextureFeatures(imageBuffer: Buffer): Promise<TextureFeatures> {
  const { data: fineRgb } = await sharp(imageBuffer)
    .removeAlpha()
    .resize(64, 64, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { data: coarseRgb } = await sharp(imageBuffer)
    .removeAlpha()
    .resize(16, 16, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const n = 64 * 64;
  const lVals = new Float64Array(n);
  const aVals = new Float64Array(n);
  const bVals = new Float64Array(n);
  let sumL = 0;
  let sumA = 0;
  let sumB = 0;
  let sumR = 0;
  let sumG = 0;
  let sumBlue = 0;
  for (let i = 0; i < n; i++) {
    const r = fineRgb[3 * i]!;
    const g = fineRgb[3 * i + 1]!;
    const bCh = fineRgb[3 * i + 2]!;
    sumR += r;
    sumG += g;
    sumBlue += bCh;
    const [L, a, b] = rgbToLab(r, g, bCh);
    lVals[i] = L;
    aVals[i] = a;
    bVals[i] = b;
    sumL += L;
    sumA += a;
    sumB += b;
  }
  const meanL = sumL / n;
  const meanA = sumA / n;
  const meanB = sumB / n;
  const referenceHex = `#${toHexByte(sumR / n)}${toHexByte(sumG / n)}${toHexByte(sumBlue / n)}`;

  let varL = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i++) {
    varL += (lVals[i]! - meanL) ** 2;
    varA += (aVals[i]! - meanA) ** 2;
    varB += (bVals[i]! - meanB) ** 2;
  }

  const coarseL = new Float64Array(16 * 16);
  for (let i = 0; i < 16 * 16; i++) {
    coarseL[i] = rgbToLab(coarseRgb[3 * i]!, coarseRgb[3 * i + 1]!, coarseRgb[3 * i + 2]!)[0];
  }

  return {
    meanL,
    stdL: Math.sqrt(varL / n),
    meanA,
    stdA: Math.sqrt(varA / n),
    meanB,
    stdB: Math.sqrt(varB / n),
    gradFine: meanSobelMagnitude(lVals, 64),
    gradCoarse: meanSobelMagnitude(coarseL, 16),
    referenceHex,
  };
}

const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ["cobble", "cobblestone", "paving", "paver", "street", "road", "stone", "sidewalk"],
  ["brick", "bricks", "masonry", "terracotta", "clay"],
  ["plaster", "stucco", "concrete", "cement", "wall"],
  ["wood", "plank", "planks", "timber", "board", "wooden"],
  ["roof", "tile", "tiles", "slate", "shingle"],
  ["chair", "seat", "stool", "bench", "armchair", "dining"],
  ["table", "desk", "counter", "stand", "workbench"],
  ["lamp", "lantern", "light", "sconce", "streetlight", "chandelier"],
  ["pot", "planter", "vase", "urn", "flowerpot", "plant", "potted", "shrub", "bush", "fern"],
  ["tree", "sapling", "palm", "pine", "oak", "foliage"],
  ["crate", "box", "barrel", "chest", "cask", "bin", "container"],
  ["door", "gate", "arch", "window", "shutter", "awning", "canopy"],
  ["rock", "boulder", "stone", "cliff", "pebble"],
  ["fence", "railing", "balustrade", "post", "bollard", "barrier"],
  ["shelf", "bookshelf", "cabinet", "cupboard", "drawer", "rack"],
  ["sign", "signboard", "billboard", "placard", "poster"],
  ["car", "vehicle", "cart", "wagon", "bicycle", "bike", "scooter"],
];

function expandTokenVariants(token: string): string[] {
  const stem = token.length >= 6 ? token.slice(0, 5) : token;
  const variants = new Set([token, stem]);
  for (const group of SYNONYM_GROUPS) {
    if (group.includes(token) || group.includes(stem)) {
      for (const word of group) variants.add(word);
    }
  }
  return [...variants];
}

function queryTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length >= 3);
}

function tokenMatchRatio(tokens: readonly string[], haystack: string): number {
  if (tokens.length === 0) return 0.5;
  const lower = haystack.toLowerCase();
  let matched = 0;
  for (const token of tokens) {
    if (expandTokenVariants(token).some((variant) => lower.includes(variant))) matched += 1;
  }
  return matched / tokens.length;
}

function assetHaystack(asset: Pick<PolyHavenAsset, "id" | "name" | "description" | "category" | "tags">): string {
  return [asset.id, asset.name, asset.description ?? "", asset.category ?? "", ...asset.tags].join(" ").toLowerCase();
}

function thumbnailUrlForAsset(asset: Pick<PolyHavenAsset, "id" | "thumbnailUrl">): string {
  return (
    asset.thumbnailUrl ??
    `https://cdn.polyhaven.com/asset_img/thumbs/${encodeURIComponent(asset.id)}.png?width=256`
  );
}

function computeSimilarityMetrics(
  targetDescription: string,
  target: TextureFeatures,
  asset: Pick<PolyHavenAsset, "id" | "name" | "description" | "category" | "tags" | "thumbnailUrl">,
  candidate: TextureFeatures,
) {
  const semanticScore = tokenMatchRatio(queryTokens(targetDescription), assetHaystack(asset));
  const chromaDist = Math.hypot(target.meanA - candidate.meanA, target.meanB - candidate.meanB);
  const tNormStd = target.stdL / Math.max(target.meanL, 15);
  const cNormStd = candidate.stdL / Math.max(candidate.meanL, 15);
  const spreadDiff =
    Math.abs(tNormStd - cNormStd) * 20 +
    0.3 * (Math.abs(target.stdA - candidate.stdA) + Math.abs(target.stdB - candidate.stdB));
  const labChromaScore = Math.exp(-(chromaDist + spreadDiff) / 22);

  const fineDiff = Math.abs(Math.log((target.gradFine + 2) / (candidate.gradFine + 2)));
  const coarseDiff = Math.abs(Math.log((target.gradCoarse + 2) / (candidate.gradCoarse + 2)));
  const textureEnergyScore = 0.6 * Math.exp(-fineDiff / 1.1) + 0.4 * Math.exp(-coarseDiff / 1.1);

  return {
    semanticScore,
    labChromaScore,
    textureEnergyScore,
    thumbnailUrl: thumbnailUrlForAsset(asset),
    labColorShift: {
      dL: +(target.meanL - candidate.meanL).toFixed(2),
      dA: +(target.meanA - candidate.meanA).toFixed(2),
      dB: +(target.meanB - candidate.meanB).toFixed(2),
    },
  };
}

/** Score a Poly Haven texture against a target surface query and reference patch features. */
export function scorePolyHavenCandidate(
  targetDescription: string,
  target: TextureFeatures,
  asset: Pick<PolyHavenAsset, "id" | "name" | "description" | "category" | "tags" | "thumbnailUrl">,
  candidate: TextureFeatures,
): PolyHavenCandidateScore {
  const sim = computeSimilarityMetrics(targetDescription, target, asset, candidate);
  const score = 0.45 * sim.semanticScore + 0.3 * sim.labChromaScore + 0.25 * sim.textureEnergyScore;

  return {
    id: asset.id,
    name: asset.name,
    score: +score.toFixed(4),
    semanticScore: +sim.semanticScore.toFixed(4),
    labChromaScore: +sim.labChromaScore.toFixed(4),
    textureEnergyScore: +sim.textureEnergyScore.toFixed(4),
    thumbnailUrl: sim.thumbnailUrl,
    labColorShift: sim.labColorShift,
  };
}

/** Score a Poly Haven CC0 3D model against a prop query, reference image crop, and optional size/poly limits. */
export function scorePolyHavenModelCandidate(
  targetDescription: string,
  target: TextureFeatures,
  asset: Pick<
    PolyHavenAsset,
    "id" | "name" | "description" | "category" | "tags" | "thumbnailUrl" | "dimensions" | "polycount"
  >,
  candidate: TextureFeatures,
  options?: {
    readonly dimensionsMeters?: readonly [number, number, number];
    readonly maxPolycount?: number;
  },
): PolyHavenCandidateScore {
  const sim = computeSimilarityMetrics(targetDescription, target, asset, candidate);
  let score = 0.55 * sim.semanticScore + 0.25 * sim.labChromaScore + 0.2 * sim.textureEnergyScore;

  if (options?.maxPolycount !== undefined && asset.polycount !== undefined && asset.polycount > options.maxPolycount) {
    score *= Math.max(0.2, Math.exp(-(asset.polycount - options.maxPolycount) / options.maxPolycount));
  }
  if (
    options?.dimensionsMeters !== undefined &&
    asset.dimensions !== undefined &&
    asset.dimensions.length === 3
  ) {
    const assetSorted = [...asset.dimensions].sort((a, b) => a - b);
    const targetSorted = [...options.dimensionsMeters].sort((a, b) => a - b);
    let logErrorSum = 0;
    for (let i = 0; i < 3; i++) {
      logErrorSum += Math.abs(Math.log(Math.max(assetSorted[i]!, 0.01) / Math.max(targetSorted[i]!, 0.01)));
    }
    score *= Math.max(0.35, Math.exp(-(logErrorSum / 3) * 0.6));
  }

  return {
    id: asset.id,
    name: asset.name,
    score: +Math.min(1, Math.max(0, score)).toFixed(4),
    semanticScore: +sim.semanticScore.toFixed(4),
    labChromaScore: +sim.labChromaScore.toFixed(4),
    textureEnergyScore: +sim.textureEnergyScore.toFixed(4),
    thumbnailUrl: sim.thumbnailUrl,
    labColorShift: sim.labColorShift,
    ...(asset.dimensions ? { dimensions: asset.dimensions } : {}),
    ...(asset.polycount !== undefined ? { polycount: asset.polycount } : {}),
  };
}

async function mapConcurrent<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const run = async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await worker(items[idx]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

function createThumbnailFeatureLoader(fetchImpl: typeof fetch) {
  const featureCache = new Map<string, Promise<TextureFeatures | null>>();
  return (url: string): Promise<TextureFeatures | null> => {
    const existing = featureCache.get(url);
    if (existing) return existing;
    const promise = (async () => {
      try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        return await extractTextureFeatures(buf);
      } catch {
        return null;
      }
    })();
    featureCache.set(url, promise);
    return promise;
  };
}

function createReferencePatchReader(
  defaultReferencePath?: string,
  fallbackPaths?: readonly string[],
) {
  const primaryPath = defaultReferencePath ?? fallbackPaths?.[0];
  const fileCache = new Map<string, Promise<{ readonly bytes: Buffer; readonly width: number; readonly height: number }>>();
  const fullImageFeaturesCache = new Map<string, Promise<TextureFeatures & { readonly referenceHex: string }>>();

  const loadImage = (imagePath: string) => {
    const existing = fileCache.get(imagePath);
    if (existing) return existing;
    const promise = (async () => {
      const bytes = await readFile(imagePath);
      const meta = await sharp(bytes).metadata();
      return { bytes, width: meta.width ?? 0, height: meta.height ?? 0 };
    })();
    fileCache.set(imagePath, promise);
    return promise;
  };

  const loadFullFeatures = (imagePath: string) => {
    const existing = fullImageFeaturesCache.get(imagePath);
    if (existing) return existing;
    const promise = (async () => {
      const { bytes } = await loadImage(imagePath);
      const features = await extractTextureFeatures(bytes);
      return { ...features, referenceHex: features.referenceHex ?? "#808080" };
    })();
    fullImageFeaturesCache.set(imagePath, promise);
    return promise;
  };

  return async (
    itemReferencePath?: string,
    crop?: SurfaceCropRect,
  ): Promise<TextureFeatures & { readonly referenceHex: string }> => {
    const chosenPath = itemReferencePath ?? primaryPath;
    if (!chosenPath) {
      throw new Error("No referenceImagePath provided for Poly Haven query.");
    }
    if (!crop) return loadFullFeatures(chosenPath);
    const { bytes, width, height } = await loadImage(chosenPath);
    if (width <= 0 || height <= 0) return loadFullFeatures(chosenPath);
    const left = Math.max(0, Math.min(width - 1, Math.round(crop.x)));
    const top = Math.max(0, Math.min(height - 1, Math.round(crop.y)));
    const cropW = Math.max(1, Math.min(width - left, Math.round(crop.width)));
    const cropH = Math.max(1, Math.min(height - top, Math.round(crop.height)));
    const patchBuf = await sharp(bytes).extract({ left, top, width: cropW, height: cropH }).toBuffer();
    const features = await extractTextureFeatures(patchBuf);
    return { ...features, referenceHex: features.referenceHex ?? "#808080" };
  };
}

function rankLexicalAssets(assets: readonly PolyHavenAsset[], text: string, topN: number): PolyHavenAsset[] {
  const tokens = queryTokens(text);
  return assets
    .map((asset) => ({
      asset,
      lexical: tokenMatchRatio(tokens, assetHaystack(asset)),
    }))
    .filter((entry) => entry.lexical > 0)
    .sort(
      (a, b) =>
        b.lexical - a.lexical ||
        (b.asset.downloadCount ?? 0) - (a.asset.downloadCount ?? 0),
    )
    .slice(0, topN)
    .map((entry) => entry.asset);
}

/**
 * Evaluate surface patches from one or more reference images against Poly Haven's CC0 texture catalog,
 * returning routing decisions (`use_polyhaven_pbr`, `polyhaven_detail_plus_project`, `ai_project_only`,
 * or `procedural_tint_fallback` in `lean` mode).
 */
export async function matchPolyHavenMaterials(
  input: MatchPolyHavenInput,
  deps: MatchPolyHavenDeps,
): Promise<SurfaceMaterialMatch[]> {
  if (input.surfaces.length === 0) return [];
  const mode = input.mode ?? "detailed";
  const topN = Math.min(12, Math.max(1, input.topCandidates ?? 6));
  const readPatchFeatures = createReferencePatchReader(input.referenceImagePath, input.referenceImagePaths);
  const loadFeatures = createThumbnailFeatureLoader(deps.fetchImpl ?? fetch);
  let texturesPromise: Promise<PolyHavenAsset[]> | undefined;
  const getTextures = () => {
    texturesPromise ??= deps.client.listAssets("textures");
    return texturesPromise;
  };

  const results: SurfaceMaterialMatch[] = [];
  for (const surface of input.surfaces) {
    const targetFeatures = await readPatchFeatures(surface.referenceImagePath, surface.crop);
    const referenceHex = targetFeatures.referenceHex;
    const eligible = isEligibleForTilingPbr({
      name: surface.name,
      description: surface.query,
      ...(surface.homogeneous === undefined ? {} : { homogeneous: surface.homogeneous }),
    });
    if (!eligible) {
      results.push({
        name: surface.name,
        eligible: false,
        decision: routeSurfaceMaterial(0, false, mode),
        referenceHex,
        bestMatch: null,
        alternatives: [],
      });
      continue;
    }

    const textures = await getTextures();
    const rankedAssets = rankLexicalAssets(textures, `${surface.name} ${surface.query}`, topN);
    const scored = (
      await mapConcurrent(rankedAssets, 4, async (asset) => {
        const candFeatures = await loadFeatures(thumbnailUrlForAsset(asset));
        if (!candFeatures) return null;
        return scorePolyHavenCandidate(`${surface.name} ${surface.query}`, targetFeatures, asset, candFeatures);
      })
    )
      .filter((item): item is PolyHavenCandidateScore => item !== null)
      .sort((a, b) => b.score - a.score);

    const bestMatch = scored[0] ?? null;
    results.push({
      name: surface.name,
      eligible: true,
      decision: routeSurfaceMaterial(bestMatch?.score ?? 0, true, mode),
      referenceHex,
      bestMatch,
      alternatives: scored.slice(1, 4),
    });
  }
  return results;
}

/**
 * Evaluate prop/object queries against Poly Haven's CC0 3D model catalog, returning matching assets
 * or falling back to AI projection (`detailed` mode) / procedural tinting (`lean` mode).
 */
export async function matchPolyHavenModels(
  input: MatchPolyHavenModelsInput,
  deps: MatchPolyHavenDeps,
): Promise<ModelAssetMatch[]> {
  if (input.models.length === 0) return [];
  const mode = input.mode ?? "detailed";
  const topN = Math.min(12, Math.max(1, input.topCandidates ?? 6));
  const readPatchFeatures = createReferencePatchReader(input.referenceImagePath, input.referenceImagePaths);
  const loadFeatures = createThumbnailFeatureLoader(deps.fetchImpl ?? fetch);
  const modelsCatalog = await deps.client.listAssets("models");

  const results: ModelAssetMatch[] = [];
  for (const model of input.models) {
    const targetFeatures = await readPatchFeatures(model.referenceImagePath, model.crop);
    const referenceHex = targetFeatures.referenceHex;
    const rankedAssets = rankLexicalAssets(modelsCatalog, `${model.name} ${model.query}`, topN);
    const scored = (
      await mapConcurrent(rankedAssets, 4, async (asset) => {
        const candFeatures = await loadFeatures(thumbnailUrlForAsset(asset));
        if (!candFeatures) return null;
        return scorePolyHavenModelCandidate(`${model.name} ${model.query}`, targetFeatures, asset, candFeatures, {
          ...(model.dimensionsMeters === undefined ? {} : { dimensionsMeters: model.dimensionsMeters }),
          ...(model.maxPolycount === undefined ? {} : { maxPolycount: model.maxPolycount }),
        });
      })
    )
      .filter((item): item is PolyHavenCandidateScore => item !== null)
      .sort((a, b) => b.score - a.score);

    const bestMatch = scored[0] ?? null;
    results.push({
      name: model.name,
      decision: routePropModel(bestMatch?.score ?? 0, mode),
      referenceHex,
      bestMatch,
      alternatives: scored.slice(1, 4),
    });
  }
  return results;
}
