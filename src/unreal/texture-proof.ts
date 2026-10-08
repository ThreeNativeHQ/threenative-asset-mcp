/**
 * S5 texture-identity proofs for the Fab parity sweep: does the GLB carry the exporter's pixels?
 *
 * Two independent checks, both built on the image-diff metrics:
 *
 *  1. `proveTextures`: every report binding that moves a source PNG into a glTF slot without a pixel
 *     transform must embed exactly that PNG (after the importer's own `maxTextureSize` resize, run
 *     through the same `applyTextureTransform`). Graph-baked base colours have no source image, so
 *     they are only sanity-checked (decodes, not constant, not the neutral fallback).
 *  2. `crossDecodeProof`: UE Viewer and CUE4Parse are separate codebases. When both decode the same
 *     Texture2D to (nearly) the same pixels, the exporter's pixels are the texture's pixels.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { NodeIO, type Document, type Material, type Texture } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";

import { compareImages, decodeRgba, type ImageComparison, type RgbaImage } from "./image-diff.js";
import { applyTextureTransform, type ImportReport, type ImportedMaterialSection } from "./importer.js";
import { PARITY_LIST_CAP } from "./parity.js";
import { runBounded } from "./toolchain.js";

type Section = ImportedMaterialSection;

/** The neutral base colour of a section with no texture (`[0.8, 0.8, 0.8]`) in 8-bit sRGB-as-stored. */
const NEUTRAL_GREY = 204;
/** A baked base colour whose mean is this close to the neutral grey (RGB distance) did not bake anything. */
const NEUTRAL_DISTANCE = 3;

export interface TextureProofEntry {
  readonly texture: string;
  readonly model: string;
  readonly section: string;
  readonly slot: string;
  readonly ssim: number;
  readonly mse: number;
  readonly maxAbs: number;
  readonly identical: boolean;
  /** The importer downscaled this texture; the source was resized with the same function before comparing. */
  readonly resized: boolean;
  /** Why a non-identical entry differs ("size 8x8 vs 4x4", "embedded image does not decode"). */
  readonly reason?: string;
}

export interface GraphTextureCheck {
  readonly texture: string;
  readonly model: string;
  readonly nonConstant: boolean;
  readonly differsFromNeutral: boolean;
  readonly meanColour: readonly [number, number, number];
  readonly reason?: string;
}

export interface TextureProof {
  /** Distinct (source texture, embedded pixels) pairs compared. */
  readonly compared: number;
  readonly identical: number;
  /** Lowest SSIM among compared entries; null when nothing was compared. */
  readonly minSsim: number | null;
  /** Compared entries whose source was downscaled by `maxTextureSize` first. */
  readonly resized: number;
  /** Exact bindings found; larger than `compared` when `sample` capped the work. */
  readonly candidates: number;
  readonly sampled: boolean;
  /** Entries that are not identical, worst first, capped at PARITY_LIST_CAP. */
  readonly mismatches: readonly TextureProofEntry[];
  readonly mismatchCount: number;
  /** Lowest-SSIM entries (identical or not), capped. */
  readonly worst: readonly TextureProofEntry[];
  /** Exact bindings that could not be compared, by reason. */
  readonly skipped: Readonly<Record<string, number>>;
  readonly graph: {
    readonly checked: number;
    readonly ok: number;
    readonly failures: readonly GraphTextureCheck[];
  };
}

export interface ProveTexturesOptions {
  readonly report: ImportReport;
  readonly outputDir: string;
  /** Source PNG of each texture name (the exporter's output). */
  readonly sourceTextures: ReadonlyMap<string, string>;
  /**
   * Per GLB (relative to `outputDir`): texture name -> source paths, as handed out by the importer's
   * `proofSources` hook. Wins over `sourceTextures` for that GLB; more than one path is ambiguous.
   */
  readonly sourcesByGlb?: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;
  /** Names the flat map cannot resolve because several different files carry them. */
  readonly ambiguous?: ReadonlySet<string>;
  /** The `maxTextureSize` the import ran with; undefined when it did not resize. */
  readonly maxTextureSize?: number | undefined;
  /** Compare at most this many textures (evenly spaced, deterministic). Default: all. */
  readonly sample?: number | undefined;
}

/** The flat view of the importer's per-GLB source map; names with differing files are `ambiguous`. */
export function flattenProofSources(
  byGlb: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>,
): { sourceTextures: Map<string, string>; ambiguous: Set<string> } {
  const sourceTextures = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const textures of byGlb.values()) {
    for (const [name, paths] of textures) {
      for (const path of paths) {
        const known = sourceTextures.get(name);
        if (known !== undefined && known !== path) ambiguous.add(name);
        sourceTextures.set(name, path);
      }
    }
  }
  return { sourceTextures, ambiguous };
}

function slotTexture(material: Material, slot: string): Texture | null {
  switch (slot) {
    case "baseColor":
      return material.getBaseColorTexture();
    case "normal":
      return material.getNormalTexture();
    case "metallicRoughness":
      return material.getMetallicRoughnessTexture();
    case "emissive":
      return material.getEmissiveTexture();
    case "occlusion":
      return material.getOcclusionTexture();
    default:
      return null;
  }
}

const sha = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** Deterministic, evenly spaced subset of `items`. */
export function sampleEvenly<T>(items: readonly T[], count: number): T[] {
  if (count >= items.length) return [...items];
  if (count <= 0) return [];
  const picked: T[] = [];
  for (let i = 0; i < count; i++) picked.push(items[Math.floor((i * items.length) / count)]!);
  return picked;
}

interface Candidate {
  readonly texture: string;
  readonly model: string;
  readonly section: string;
  readonly slot: string;
  readonly sourcePath: string;
  readonly embedded: Uint8Array;
}

function meanColour(image: RgbaImage): [number, number, number] {
  const sums = [0, 0, 0];
  const pixels = image.width * image.height;
  for (let i = 0; i < pixels; i++) {
    sums[0]! += image.data[i * 4]!;
    sums[1]! += image.data[i * 4 + 1]!;
    sums[2]! += image.data[i * 4 + 2]!;
  }
  return pixels === 0 ? [0, 0, 0] : [sums[0]! / pixels, sums[1]! / pixels, sums[2]! / pixels];
}

function isConstant(image: RgbaImage): boolean {
  const d = image.data;
  for (let i = 4; i < d.length; i += 4) {
    if (d[i] !== d[0] || d[i + 1] !== d[1] || d[i + 2] !== d[2] || d[i + 3] !== d[3]) return false;
  }
  return true;
}

async function checkGraphTexture(texture: string, model: string, embedded: Uint8Array): Promise<GraphTextureCheck> {
  let image: RgbaImage;
  try {
    image = await decodeRgba(embedded);
  } catch (error) {
    return {
      texture,
      model,
      nonConstant: false,
      differsFromNeutral: false,
      meanColour: [0, 0, 0],
      reason: `does not decode: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200),
    };
  }
  const mean = meanColour(image);
  const nonConstant = !isConstant(image);
  const distance = Math.hypot(mean[0] - NEUTRAL_GREY, mean[1] - NEUTRAL_GREY, mean[2] - NEUTRAL_GREY);
  return {
    texture,
    model,
    nonConstant,
    differsFromNeutral: distance > NEUTRAL_DISTANCE,
    meanColour: [Math.round(mean[0]), Math.round(mean[1]), Math.round(mean[2])],
  };
}

async function compareEntry(candidate: Candidate, maxTextureSize: number | undefined): Promise<TextureProofEntry> {
  const head = {
    texture: candidate.texture,
    model: candidate.model,
    section: candidate.section,
    slot: candidate.slot,
  };
  const failed = (reason: string, resized = false): TextureProofEntry => ({
    ...head,
    ssim: 0,
    mse: Number.POSITIVE_INFINITY,
    maxAbs: 255,
    identical: false,
    resized,
    reason,
  });
  let expectedImage: RgbaImage;
  let resized = false;
  try {
    const sourceBytes = await readFile(candidate.sourcePath);
    // The importer's own function and parameters: what it would have embedded for this source.
    const expected = await applyTextureTransform(sourceBytes, "none", maxTextureSize);
    expectedImage = await decodeRgba(expected.data);
    if (maxTextureSize !== undefined) {
      const source = await decodeRgba(sourceBytes);
      resized = source.width !== expectedImage.width || source.height !== expectedImage.height;
    }
  } catch (error) {
    return failed(`source does not decode: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200));
  }
  let embeddedImage: RgbaImage;
  try {
    embeddedImage = await decodeRgba(candidate.embedded);
  } catch (error) {
    return failed(`embedded image does not decode: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200), resized);
  }
  const comparison: ImageComparison = await compareImages(expectedImage, embeddedImage, { resizeToMatch: true });
  const sizeNote =
    embeddedImage.width !== expectedImage.width || embeddedImage.height !== expectedImage.height
      ? `size ${embeddedImage.width}x${embeddedImage.height} embedded vs ${expectedImage.width}x${expectedImage.height} expected`
      : undefined;
  return {
    ...head,
    ssim: comparison.ssim,
    mse: comparison.mse,
    maxAbs: comparison.maxAbs,
    identical: comparison.identical,
    resized,
    ...(comparison.identical ? {} : { reason: sizeNote ?? `max channel difference ${comparison.maxAbs}` }),
  };
}

const worstFirst = (a: TextureProofEntry, b: TextureProofEntry): number =>
  a.ssim - b.ssim || b.mse - a.mse || a.texture.localeCompare(b.texture);

interface GlbEntry {
  readonly glb: string;
  readonly sections: readonly Section[];
  readonly names: readonly string[];
}

/** Each GLB once, with the report sections that live in it (a library GLB serves many material assets). */
function glbEntries(report: ImportReport): GlbEntry[] {
  const entries: GlbEntry[] = [];
  for (const model of report.models) {
    entries.push({ glb: model.glb, sections: model.materials, names: model.materials.map((m) => m.name) });
  }
  const library = new Map<string, { sections: Section[]; names: string[] }>();
  for (const asset of report.materialAssets) {
    const held = library.get(asset.glb) ?? { sections: [], names: [] };
    held.sections.push(asset);
    held.names.push(asset.libraryName);
    library.set(asset.glb, held);
  }
  for (const [glb, held] of library) entries.push({ glb, ...held });
  return entries;
}

export async function proveTextures(options: ProveTexturesOptions): Promise<TextureProof> {
  const { report, outputDir } = options;
  const root = resolve(outputDir);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const skipped: Record<string, number> = {};
  const skip = (reason: string): void => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };
  const candidates = new Map<string, Candidate>();
  const graphChecks = new Map<string, { texture: string; model: string; embedded: Uint8Array }>();

  for (const entry of glbEntries(report)) {
    const path = resolve(root, entry.glb);
    if (path !== root && !path.startsWith(root + sep)) {
      skip("glb-outside-output");
      continue;
    }
    let document: Document;
    try {
      document = await io.read(path);
    } catch {
      skip("glb-unreadable");
      continue;
    }
    const materials = document.getRoot().listMaterials();
    const byIndex = materials.length === entry.sections.length;
    for (const [index, section] of entry.sections.entries()) {
      const material = byIndex ? materials[index] : materials.find((m) => m.getName() === entry.names[index]);
      if (!material) {
        // Nothing to look up, so only an exact or graph binding makes this worth counting.
        if (section.bindings.some((b) => b.source === "graph" || b.transform === "none")) skip("material-not-in-glb");
        continue;
      }
      for (const binding of section.bindings) {
        const texture = slotTexture(material, binding.slot);
        if (binding.source === "graph") {
          const image = texture?.getImage();
          if (!texture || !image || texture.getName() !== binding.texture) {
            skip("graph-not-embedded");
            continue;
          }
          graphChecks.set(`${binding.texture}|${sha(image)}`, { texture: binding.texture, model: entry.glb, embedded: image });
          continue;
        }
        if (binding.transform !== "none") continue;
        if (section.unsupported.some((u) => u.texture === binding.texture)) {
          skip("not-embedded: sidecar");
          continue;
        }
        const image = texture?.getImage();
        if (!texture || !image || texture.getName() !== binding.texture) {
          skip("not-embedded: slot holds another texture");
          continue;
        }
        const perGlb = options.sourcesByGlb?.get(entry.glb)?.get(binding.texture);
        let sourcePath: string | undefined;
        if (perGlb !== undefined) {
          if (perGlb.length !== 1) {
            skip("ambiguous source");
            continue;
          }
          sourcePath = perGlb[0];
        } else {
          if (options.ambiguous?.has(binding.texture)) {
            skip("ambiguous source");
            continue;
          }
          sourcePath = options.sourceTextures.get(binding.texture);
        }
        if (sourcePath === undefined) {
          skip("no source png");
          continue;
        }
        candidates.set(`${sourcePath}|${sha(image)}`, {
          texture: binding.texture,
          model: entry.glb,
          section: section.name,
          slot: binding.slot,
          sourcePath,
          embedded: image,
        });
      }
    }
  }

  const all = [...candidates.values()].sort((a, b) => a.texture.localeCompare(b.texture) || a.model.localeCompare(b.model));
  const chosen = options.sample === undefined ? all : sampleEvenly(all, options.sample);
  const entries: TextureProofEntry[] = [];
  for (const candidate of chosen) entries.push(await compareEntry(candidate, options.maxTextureSize));

  const graphResults: GraphTextureCheck[] = [];
  for (const item of graphChecks.values()) graphResults.push(await checkGraphTexture(item.texture, item.model, item.embedded));
  const graphFailures = graphResults.filter((c) => !c.nonConstant || !c.differsFromNeutral || c.reason !== undefined);

  const mismatched = entries.filter((e) => !e.identical).sort(worstFirst);
  return {
    compared: entries.length,
    identical: entries.length - mismatched.length,
    minSsim: entries.length === 0 ? null : Math.min(...entries.map((e) => e.ssim)),
    resized: entries.filter((e) => e.resized).length,
    candidates: all.length,
    sampled: chosen.length < all.length,
    mismatches: mismatched.slice(0, PARITY_LIST_CAP),
    mismatchCount: mismatched.length,
    worst: [...entries].sort(worstFirst).slice(0, Math.min(10, PARITY_LIST_CAP)),
    skipped,
    graph: {
      checked: graphResults.length,
      ok: graphResults.length - graphFailures.length,
      failures: graphFailures.slice(0, PARITY_LIST_CAP),
    },
  };
}

/** The S5 failure reason for a proof, or undefined when every compared texture is identical. */
export function textureIdentityReason(proof: Pick<TextureProof, "compared" | "mismatchCount" | "mismatches">): string | undefined {
  if (proof.mismatchCount === 0) return undefined;
  const names = [...new Set(proof.mismatches.map((m) => m.texture))].slice(0, 3);
  return `S5 texture identity: ${proof.mismatchCount} of ${proof.compared} textures differ (${names.join(", ")}${proof.mismatchCount > names.length ? ", ..." : ""})`;
}

// --- independent-decoder cross-check ------------------------------------------------------------

/** SSIM at or above which UE Viewer and CUE4Parse count as agreeing (mip/gamma/rounding tolerance). */
export const CROSS_DECODE_SSIM = 0.999;

export interface CrossDecodeEntry {
  readonly texture: string;
  readonly status: "agree" | "disagree" | "unavailable";
  readonly reason?: string;
  readonly ssim?: number;
  readonly mse?: number;
  readonly maxAbs?: number;
  readonly width?: number;
  readonly height?: number;
  readonly sizeDiffers?: boolean;
}

export interface CrossDecodeProof {
  /** `unavailable` when no sampled texture could be decoded by both; `disagree` when any pair is below the threshold. */
  readonly status: "agree" | "disagree" | "unavailable";
  readonly requested: number;
  readonly compared: number;
  readonly agreeing: number;
  readonly unavailable: number;
  readonly minSsim: number | null;
  readonly threshold: number;
  readonly results: readonly CrossDecodeEntry[];
}

export interface CrossDecodeOptions {
  /** `ThreeNativeConverter` (CUE4Parse adapter) executable. */
  readonly converterPath: string;
  /** UE Viewer's PNG for each texture name (the importer's staging export). */
  readonly sourceTextures: ReadonlyMap<string, string>;
  /** `--engine` value for the converter (`4.18`); omitted when undefined. */
  readonly engine?: string | undefined;
  /** How many textures to cross-decode, evenly spaced over the sorted names. Default 6. */
  readonly sample?: number;
  readonly threshold?: number;
  readonly timeoutMs?: number;
  readonly environment?: NodeJS.ProcessEnv;
}

async function findTexturePng(directory: string, name: string): Promise<string | undefined> {
  const wanted = `${name}.png`.toLowerCase();
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let names;
    try {
      names = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const item of names) {
      if (item.isDirectory()) stack.push(join(current, item.name));
      else if (item.name.toLowerCase() === wanted) return join(current, item.name);
    }
  }
  return undefined;
}

export async function crossDecodeProof(
  sourceDir: string,
  textureNames: readonly string[],
  options: CrossDecodeOptions,
): Promise<CrossDecodeProof> {
  const threshold = options.threshold ?? CROSS_DECODE_SSIM;
  const names = sampleEvenly([...new Set(textureNames)].sort(), options.sample ?? 6);
  const results: CrossDecodeEntry[] = [];
  for (const name of names) {
    const viewerPath = options.sourceTextures.get(name);
    if (viewerPath === undefined) {
      results.push({ texture: name, status: "unavailable", reason: "UE Viewer exported no PNG for this texture" });
      continue;
    }
    const scratch = await mkdtemp(join(tmpdir(), "tn-cross-decode-"));
    try {
      const run = await runBounded(
        options.converterPath,
        [sourceDir, "--export-dir", scratch, "--filter", name, ...(options.engine === undefined ? [] : ["--engine", options.engine])],
        { timeoutMs: options.timeoutMs ?? 300_000, maxOutputBytes: 8 * 1024 * 1024, ...(options.environment ? { environment: options.environment } : {}) },
      );
      if (run.code !== 0) {
        const cause = `${run.stderr}\n${run.stdout}`.trim().split("\n").filter(Boolean).pop() ?? "";
        results.push({ texture: name, status: "unavailable", reason: `CUE4Parse converter exited ${run.code}: ${cause}`.slice(0, 240) });
        continue;
      }
      const decoded = await findTexturePng(scratch, name);
      if (!decoded) {
        results.push({ texture: name, status: "unavailable", reason: "CUE4Parse wrote no PNG for this texture" });
        continue;
      }
      // Premultiplied: the two decoders may keep different colour behind alpha 0, which no one can see.
      const compared = await compareImages(await decodeRgba(await readFile(viewerPath)), await decodeRgba(await readFile(decoded)), {
        resizeToMatch: true,
        premultiplied: true,
      });
      results.push({
        texture: name,
        status: compared.ssim >= threshold ? "agree" : "disagree",
        ssim: compared.ssim,
        mse: compared.mse,
        maxAbs: compared.maxAbs,
        width: compared.width,
        height: compared.height,
        ...(compared.resized ? { sizeDiffers: true } : {}),
      });
    } catch (error) {
      results.push({ texture: name, status: "unavailable", reason: (error instanceof Error ? error.message : String(error)).slice(0, 240) });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
  const compared = results.filter((r) => r.status !== "unavailable");
  const agreeing = compared.filter((r) => r.status === "agree").length;
  return {
    status: compared.length === 0 ? "unavailable" : agreeing === compared.length ? "agree" : "disagree",
    requested: names.length,
    compared: compared.length,
    agreeing,
    unavailable: results.length - compared.length,
    minSsim: compared.length === 0 ? null : Math.min(...compared.map((r) => r.ssim ?? 0)),
    threshold,
    results: results.slice(0, PARITY_LIST_CAP),
  };
}
