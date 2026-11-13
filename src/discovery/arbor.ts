import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

import { assetId, AssetSchema, type Asset, type AssetAdapter, type AssetDetail } from "./types.js";

/** The slice of `@threenative/procedural-vegetation` this MCP calls. */
export interface VegetationModule {
  vegetationPresets(): { id: string; name: string; latin?: string; kind: string }[];
  bakeVegetation(options: {
    preset: string;
    seed?: number;
    lods?: readonly number[];
    out: string;
  }): Promise<
    { lod: number; path: string; triangles: number; bounds: { min: number[]; max: number[] } }[]
  >;
}

export class VegetationError extends Error {
  constructor(
    readonly code: "VEGETATION_PACKAGE_MISSING" | "VEGETATION_INVALID_INPUT",
    message: string,
  ) {
    super(message);
  }
}

const PACKAGE = "@threenative/procedural-vegetation";
const SOURCE_URL = "https://github.com/ThreeNativeHQ/threenative-engine/tree/develop/packages/procedural-vegetation";
const LICENSE: Asset["license"] = {
  name: "Generated, user-owned",
  evidence:
    "Baked on this machine by the MIT-licensed Arbor generator; the GLB carries no third-party content.",
  commercialUse: "yes",
  attributionRequired: "no",
};

export type VegetationLoader = () => Promise<VegetationModule>;

/** The package is a dependency of this MCP; a broken install names the fix instead of a stack. */
export const loadVegetation: VegetationLoader = async () => {
  try {
    // A variable specifier keeps the type checker from resolving a package that may be absent.
    const name: string = PACKAGE;
    return (await import(name)) as VegetationModule;
  } catch {
    throw new VegetationError(
      "VEGETATION_PACKAGE_MISSING",
      `The Arbor bake package is not installed. Run: npm i ${PACKAGE}`,
    );
  }
};

function row(preset: ReturnType<VegetationModule["vegetationPresets"]>[number], index: number): Asset {
  return AssetSchema.parse({
    assetId: assetId("arbor", preset.id),
    provider: "arbor",
    nativeId: preset.id,
    sourceUrl: SOURCE_URL,
    title: `${preset.name} (procedural ${preset.kind})${preset.latin ? ` - ${preset.latin}` : ""}`,
    type: "3d-model",
    itemKind: "asset",
    free: "yes",
    license: LICENSE,
    author: "Arbor procedural generator",
    downloadStatus: "manual",
    downloadReason: `Generated, not downloaded: call vegetation_generate { preset: "${preset.id}", seed } to bake LOD GLBs with a _WIND vertex attribute.`,
    canDownloadNow: false,
    providerRank: index,
    rankingFactors: ["Preset id, name, latin name or kind matched every query word", "Price 0, generated"],
  });
}

/** Procedural Arbor trees and ground cover as `asset_search` rows: price 0, generated, user-owned. */
export function createArborAdapter(load: VegetationLoader = loadVegetation): AssetAdapter {
  return {
    id: "arbor",
    async search(query, types, limit) {
      if (!types.includes("3d-model")) return { items: [], truncated: false };
      const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
      const found = (await load())
        .vegetationPresets()
        .filter((preset) => {
          const text = [preset.id, preset.name, preset.latin ?? "", preset.kind].join(" ").toLowerCase();
          return words.every((word) => text.includes(word));
        });
      return { items: found.slice(0, limit).map(row), truncated: found.length > limit };
    },
    async get(id): Promise<AssetDetail> {
      const presets = (await load()).vegetationPresets();
      const index = presets.findIndex((preset) => preset.id === id);
      if (index < 0) throw new VegetationError("VEGETATION_INVALID_INPUT", `Unknown Arbor preset "${id}".`);
      const asset = row(presets[index]!, index);
      return {
        asset,
        files: [],
        selectedVariant: "generate",
        selectionExplanation: asset.downloadReason,
        alternatives: ["lods 0 (full), 1 (mid), 2 (far)"],
        termsText: LICENSE.evidence,
        providerDetails: { tool: "vegetation_generate", arguments: { preset: id, seed: 1, lods: [0, 1, 2] } },
      };
    },
  };
}

export const VegetationGenerateInputSchema = z.object({
  preset: z.string().regex(/^[a-z0-9]+$/u).max(40).describe("An Arbor preset id, as asset_search returns it (oak, spruce, baobab, ...)."),
  seed: z.number().int().min(0).max(2_147_483_647).default(1).describe("The same preset and seed always bake the same bytes."),
  lods: z.array(z.number().int().min(0).max(2)).min(1).max(3).default([0, 1, 2]).describe("0 full, 1 mid, 2 far."),
  outDir: z.string().min(1).max(4_096).optional().describe(
    "Absolute directory to write into, for example the game's assets/trees. Default: <ASSET_DOWNLOAD_DIR>/arbor.",
  ),
});

export const VegetationGenerateOutputSchema = z.object({
  preset: z.string(),
  seed: z.number().int(),
  outDir: z.string(),
  license: z.string(),
  files: z
    .array(
      z.object({
        lod: z.number().int(),
        path: z.string(),
        bytes: z.number().int().positive(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/u),
        triangles: z.number().int().nonnegative(),
        bounds: z.object({ min: z.array(z.number()).length(3), max: z.array(z.number()).length(3) }),
      }),
    )
    .min(1),
});

export function createVegetationGenerateHandler(load: VegetationLoader = loadVegetation) {
  return async (raw: z.input<typeof VegetationGenerateInputSchema>) => {
    try {
      const input = VegetationGenerateInputSchema.parse(raw);
      if (input.outDir !== undefined && !isAbsolute(input.outDir))
        throw new VegetationError("VEGETATION_INVALID_INPUT", "outDir must be an absolute path.");
      const outDir = resolve(
        input.outDir ??
          join(process.env.ASSET_DOWNLOAD_DIR ?? join(homedir(), "Downloads", "threenative-asset-mcp", "assets"), "arbor"),
      );
      const module = await load();
      if (!module.vegetationPresets().some((preset) => preset.id === input.preset))
        throw new VegetationError("VEGETATION_INVALID_INPUT", `Unknown Arbor preset "${input.preset}". Call asset_search to list presets.`);
      const baked = await module.bakeVegetation({ lods: input.lods, out: outDir, preset: input.preset, seed: input.seed });
      const files = await Promise.all(
        baked.map(async (entry) => {
          const bytes = await readFile(entry.path);
          return {
            bounds: entry.bounds,
            bytes: bytes.length,
            lod: entry.lod,
            path: entry.path,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            triangles: entry.triangles,
          };
        }),
      );
      const output = VegetationGenerateOutputSchema.parse({
        files,
        license: LICENSE.name,
        outDir,
        preset: input.preset,
        seed: input.seed,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(output) }], structuredContent: output };
    } catch (error) {
      const safe =
        error instanceof VegetationError
          ? { code: error.code, message: error.message, retryable: false }
          : error instanceof z.ZodError
            ? { code: "VEGETATION_INVALID_INPUT", message: error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "), retryable: false }
            : { code: "VEGETATION_INTERNAL", message: error instanceof Error ? error.message.slice(0, 300) : "The asset MCP could not bake the tree.", retryable: false };
      return { isError: true as const, content: [{ type: "text" as const, text: JSON.stringify(safe) }] };
    }
  };
}
