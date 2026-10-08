import { mkdir, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { z } from "zod";

import { FabClient } from "../fab/client.js";
import { FabCli, FabCliError, preferredPlatform } from "../fab/fabcli.js";
import { decoderRoute, oldestEngine } from "../fab/routes.js";
import { classifyLicenses, type LicenseDecision } from "../fab/license.js";
import { normalizeListing } from "../fab/normalize.js";
import { ImportError, type ImportReport, importUnrealDirectory } from "../unreal/importer.js";
import { ToolchainError } from "../unreal/toolchain.js";
import { parseListingId } from "./get-asset.js";

const SizeMetersSchema = z.object({
  x: z.number().nonnegative(),
  y: z.number().nonnegative(),
  z: z.number().nonnegative(),
});

const SummarySchema = z.object({
  outputDir: z.string().max(4_096),
  reportPath: z.string().max(4_096),
  materials: z.enum(["complete", "degraded"]),
  reused: z.boolean(),
  counts: z.object({
    packages: z.number().int().nonnegative(),
    exported: z.number().int().nonnegative(),
    textures: z.number().int().nonnegative(),
    cubemaps: z.number().int().nonnegative(),
    materialAssets: z.number().int().nonnegative(),
    audio: z.number().int().nonnegative(),
    dataAssets: z.number().int().nonnegative(),
    textureStacks: z.number().int().nonnegative(),
    fonts: z.number().int().nonnegative(),
    bitmapFonts: z.number().int().nonnegative(),
    sprites: z.number().int().nonnegative(),
    flipbooks: z.number().int().nonnegative(),
    scenes: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
  materialCoverage: z.object({
    sections: z.number().int().nonnegative(),
    textured: z.number().int().nonnegative(),
    exact: z.number().int().nonnegative(),
    heuristic: z.number().int().nonnegative(),
    unsupported: z.number().int().nonnegative(),
    unresolved: z.number().int().nonnegative(),
  }),
  license: z
    .object({
      verdict: z.string().max(40),
      slugs: z.array(z.string().max(60)).max(30),
      reason: z.string().max(600),
    })
    .optional(),
  models: z.array(
    z.object({
      name: z.string().max(200),
      kind: z.enum(["static", "skeletal"]),
      glb: z.string().max(1_024),
      bytes: z.number().int().nonnegative(),
      vertices: z.number().int().nonnegative(),
      skins: z.number().int().nonnegative(),
      animations: z.number().int().nonnegative(),
      textured: z.boolean(),
      sizeMeters: SizeMetersSchema,
    }),
  ),
  textures: z.array(
    z.object({
      name: z.string().max(200),
      png: z.string().max(1_024),
      bytes: z.number().int().nonnegative(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }),
  ),
  cubemaps: z.array(
    z.object({
      name: z.string().max(200),
      file: z.string().max(1_024),
      mimeType: z.enum(["image/png", "image/vnd.radiance"]),
      bytes: z.number().int().nonnegative(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      dynamicRange: z.enum(["ldr", "hdr"]),
      mapping: z.literal("EquirectangularReflectionMapping"),
    }),
  ),
  materialAssets: z.array(
    z.object({
      name: z.string().max(200),
      glb: z.string().max(1_024),
      libraryName: z.string().max(1_024),
      textured: z.boolean(),
      alphaMode: z.string().max(20),
    }),
  ),
  audio: z.array(
    z.object({
      name: z.string().max(200),
      file: z.string().max(1_024),
      mimeType: z.string().max(100),
      bytes: z.number().int().nonnegative(),
      durationSeconds: z.number().nonnegative().optional(),
      channels: z.number().int().positive().optional(),
      sampleRate: z.number().int().positive().optional(),
    }),
  ),
  dataAssets: z.array(
    z.object({
      name: z.string().max(200),
      className: z.string().max(200),
      json: z.string().max(1_024),
      bytes: z.number().int().nonnegative(),
    }),
  ),
  textureStacks: z.array(
    z.object({
      name: z.string().max(200),
      kind: z.enum(["array", "cube-array", "volume"]),
      data: z.string().max(1_024),
      manifest: z.string().max(1_024),
      format: z.literal("RGBA8"),
      threeTexture: z.enum(["DataArrayTexture", "Data3DTexture"]),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      depth: z.number().int().positive(),
      bytes: z.number().int().nonnegative(),
    }),
  ),
  fonts: z.array(
    z.object({
      name: z.string().max(300),
      file: z.string().max(1_024),
      mimeType: z.enum(["font/ttf", "font/otf"]),
      family: z.string().max(300),
      style: z.string().max(200),
      weight: z.number().int().min(1).max(1_000),
      fontStyle: z.enum(["normal", "italic"]),
      bytes: z.number().int().nonnegative(),
    }),
  ),
  bitmapFonts: z.array(
    z.object({
      name: z.string().max(300),
      manifest: z.string().max(1_024),
      pages: z.array(z.string().max(1_024)).max(256),
      glyphs: z.number().int().positive(),
      distanceField: z.boolean(),
      bytes: z.number().int().nonnegative(),
    }),
  ),
  sprites: z.array(
    z.object({
      name: z.string().max(300),
      glb: z.string().max(1_024),
      vertices: z.number().int().positive(),
      widthMetres: z.number().nonnegative(),
      heightMetres: z.number().nonnegative(),
      textureWidth: z.number().int().positive(),
      textureHeight: z.number().int().positive(),
      bytes: z.number().int().nonnegative(),
    }),
  ),
  flipbooks: z.array(
    z.object({
      name: z.string().max(300),
      manifest: z.string().max(1_024),
      framesPerSecond: z.number().positive(),
      frames: z.number().int().positive(),
      durationSeconds: z.number().positive(),
      unresolvedSprites: z.array(z.string().max(4_096)).max(100_000),
    }),
  ),
  scenes: z.array(
    z.object({
      name: z.string().max(200),
      glb: z.string().max(1_024),
      sizeMeters: SizeMetersSchema.optional(),
      manifest: z.string().max(1_024),
      actors: z.number().int().nonnegative(),
      resolvedActors: z.number().int().nonnegative(),
      instanceGroups: z.number().int().nonnegative(),
      instances: z.number().int().nonnegative(),
      resolvedInstances: z.number().int().nonnegative(),
      landscapes: z.number().int().nonnegative(),
      landscapeVertices: z.number().int().nonnegative(),
      unresolvedMeshes: z.array(z.string().max(200)).max(10_000),
      generatedEnginePrimitives: z.array(z.string().max(200)).max(100),
      lights: z.number().int().nonnegative(),
      blueprintComponents: z.number().int().nonnegative(),
      approximatedAreaLights: z.number().int().nonnegative(),
      omittedActors: z.array(z.object({
        actor: z.string().max(1_024), component: z.string().max(1_024),
        sourceClass: z.string().max(1_024), reason: z.string().max(2_000),
      })).max(100_000),
    }),
  ),
  skipped: z.array(z.object({ package: z.string().max(1_024), reason: z.string().max(2_000) })),
  failed: z.array(z.object({ package: z.string().max(1_024), reason: z.string().max(2_000) })),
  warnings: z.array(z.string().max(500)),
  durationMs: z.number().int().nonnegative(),
});

export type ImportSummary = z.output<typeof SummarySchema>;

const OutputDirSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .describe(
    "Directory the source GLBs are written to, normally <game>/assets/fab/<listing-id>. It must not already hold a different import; this tool never overwrites one.",
  );

const PackagesSchema = z
  .array(z.string().trim().min(1).max(200))
  .max(500)
  .optional()
  .describe(
    "Import only these package names, for example [\"SM_Rock\", \"DemoMap\"]. Omit to convert every supported mesh and level in the pack; a large marketplace pack is many gigabytes of GLBs.",
  );

const MaxTextureSizeSchema = z.coerce
  .number()
  .int()
  .min(64)
  .max(8_192)
  .optional()
  .describe(
    "Optional longest edge for embedded textures. Leave unset to keep Unreal's own resolution and let the ThreeNative asset compiler cap it.",
  );

export const AssetImportUnrealInputSchema = z.object({
  sourceDir: z
    .string()
    .trim()
    .min(1)
    .max(4_096)
    .describe("A local directory of Unreal .uasset/.umap files, for example an already downloaded Fab pack."),
  outputDir: OutputDirSchema,
  packages: PackagesSchema,
  maxTextureSize: MaxTextureSizeSchema,
});

export const FabImportAssetInputSchema = z.object({
  listingIdOrUrl: z.string().trim().min(1).max(500),
  outputDir: OutputDirSchema,
  packages: PackagesSchema,
  engine: z
    .string()
    .trim()
    .regex(/^UE_\d+\.\d+$/)
    .optional()
    .describe("Unreal engine selector, for example UE_4.21. When the listing publishes several artifacts and neither engine nor artifactId is given, the artifact with the best decoder route is chosen and the choice is reported in warnings."),
  artifactId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._-]{1,128}$/)
    .optional()
    .describe(
      "Exact Unreal artifact to import, as listed by the library. Wins over engine when both are given, and is the only way to pick between artifacts whose engine lists overlap.",
    ),
  maxTextureSize: MaxTextureSizeSchema,
  platform: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_]{1,32}$/)
    .optional()
    .describe("Platform build to download when the artifact publishes several, for example Windows."),
  acceptFabEula: z.literal(true).describe(
    "Required acknowledgement that the user accepts the Fab EULA for the listing they already own.",
  ),
});

export const ImportUnrealOutputSchema = SummarySchema;

export function summarize(report: ImportReport, outputDir: string): ImportSummary {
  return SummarySchema.parse({
    outputDir,
    reportPath: join(outputDir, "import-report.json"),
    materials: report.materials,
    reused: report.reused,
    counts: report.counts,
    materialCoverage: report.materialCoverage,
    ...(report.entitlement.license ? { license: report.entitlement.license } : {}),
    models: report.models.map((model) => ({
      name: model.name,
      kind: model.kind,
      glb: model.glb,
      bytes: model.bytes,
      vertices: model.vertices,
      skins: model.skins,
      animations: model.animations,
      textured: model.materials.some((section) => section.textured),
      sizeMeters: {
        x: model.boundsMetres[0],
        y: model.boundsMetres[1],
        z: model.boundsMetres[2],
      },
    })),
    textures: report.textures.map((texture) => ({
      name: texture.name,
      png: texture.png,
      bytes: texture.bytes,
      width: texture.width,
      height: texture.height,
    })),
    cubemaps: report.cubemaps.map((cubemap) => ({
      name: cubemap.name,
      file: cubemap.file,
      mimeType: cubemap.mimeType,
      bytes: cubemap.bytes,
      width: cubemap.width,
      height: cubemap.height,
      dynamicRange: cubemap.dynamicRange,
      mapping: cubemap.mapping,
    })),
    materialAssets: report.materialAssets.map((material) => ({
      name: material.name,
      glb: material.glb,
      libraryName: material.libraryName,
      textured: material.textured,
      alphaMode: material.alphaMode,
    })),
    audio: report.audio.map((entry) => ({
      name: entry.name,
      file: entry.file,
      mimeType: entry.mimeType,
      bytes: entry.bytes,
      ...(entry.durationSeconds === undefined ? {} : { durationSeconds: entry.durationSeconds }),
      ...(entry.channels === undefined ? {} : { channels: entry.channels }),
      ...(entry.sampleRate === undefined ? {} : { sampleRate: entry.sampleRate }),
    })),
    dataAssets: report.dataAssets.map((entry) => ({
      name: entry.name,
      className: entry.className,
      json: entry.json,
      bytes: entry.bytes,
    })),
    textureStacks: report.textureStacks.map((entry) => ({
      name: entry.name,
      kind: entry.kind,
      data: entry.data,
      manifest: entry.manifest,
      format: entry.format,
      threeTexture: entry.threeTexture,
      width: entry.width,
      height: entry.height,
      depth: entry.depth,
      bytes: entry.bytes,
    })),
    fonts: report.fonts.map((entry) => ({
      name: entry.name,
      file: entry.file,
      mimeType: entry.mimeType,
      family: entry.family,
      style: entry.style,
      weight: entry.weight,
      fontStyle: entry.fontStyle,
      bytes: entry.bytes,
    })),
    bitmapFonts: report.bitmapFonts.map((entry) => ({
      name: entry.name,
      manifest: entry.manifest,
      pages: entry.pages,
      glyphs: entry.glyphs,
      distanceField: entry.distanceField,
      bytes: entry.bytes,
    })),
    sprites: report.sprites.map((entry) => ({
      name: entry.name,
      glb: entry.glb,
      vertices: entry.vertices,
      widthMetres: entry.widthMetres,
      heightMetres: entry.heightMetres,
      textureWidth: entry.textureWidth,
      textureHeight: entry.textureHeight,
      bytes: entry.bytes,
    })),
    flipbooks: report.flipbooks.map((entry) => ({
      name: entry.name,
      manifest: entry.manifest,
      framesPerSecond: entry.framesPerSecond,
      frames: entry.frames,
      durationSeconds: entry.durationSeconds,
      unresolvedSprites: entry.unresolvedSprites,
    })),
    scenes: report.scenes.map((scene) => ({
      name: scene.name,
      glb: scene.glb,
      ...(scene.sizeMeters ? { sizeMeters: scene.sizeMeters } : {}),
      manifest: scene.manifest,
      actors: scene.actors,
      resolvedActors: scene.resolvedActors,
      instanceGroups: scene.instanceGroups,
      instances: scene.instances,
      resolvedInstances: scene.resolvedInstances,
      landscapes: scene.landscapes,
      landscapeVertices: scene.landscapeVertices,
      unresolvedMeshes: scene.unresolvedMeshes,
      generatedEnginePrimitives: scene.generatedEnginePrimitives,
      lights: scene.lights,
      blueprintComponents: scene.blueprintComponents,
      approximatedAreaLights: scene.approximatedAreaLights,
      omittedActors: scene.omittedActors,
    })),
    skipped: report.skipped.slice(0, 400),
    failed: report.failed.slice(0, 400),
    warnings: report.warnings,
    durationMs: report.durationMs,
  });
}

function errorResult(error: unknown) {
  const safe =
    error instanceof ImportError || error instanceof ToolchainError || error instanceof FabCliError
      ? { code: error.code, message: error.message, retryable: error.retryable }
      : error instanceof z.ZodError
        ? {
            code: "UNREAL_IMPORT_INVALID_INPUT",
            message: "The Unreal import input is invalid.",
            retryable: false,
          }
        : {
            code: "UNREAL_IMPORT_INTERNAL",
            message: "The asset MCP could not complete the Unreal import.",
            retryable: false,
          };
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify(safe) }],
  };
}

export interface ImportUnrealDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly log?: (message: string) => void;
  readonly importDirectory?: typeof importUnrealDirectory;
  readonly fabCli?: FabCli;
  /** Injected in tests; production reads the listing's published licences from Fab. */
  readonly readLicenses?: (listingId: string) => Promise<readonly string[]>;
}

/**
 * Reads the licences Fab publishes for a listing. Anonymous and read-only: the entitlement check
 * must not depend on the authenticated path it is guarding.
 */
async function readPublishedLicenses(listingId: string): Promise<readonly string[]> {
  const client = new FabClient();
  try {
    const result = await client.getListing(listingId, "USD");
    return normalizeListing(result.payload, "USD", result.transport).licenses.map(
      (license) => license.slug,
    );
  } finally {
    await client.close();
  }
}

/**
 * Refuses anything but Fab Standard or CC-BY, before a byte is downloaded. A licence lookup that
 * fails is a refusal too: "could not check" is not "may use".
 */
export async function requirePermittedLicense(
  listingId: string,
  read: (listingId: string) => Promise<readonly string[]>,
): Promise<LicenseDecision> {
  let slugs: readonly string[];
  try {
    slugs = await read(listingId);
  } catch (error) {
    throw new FabCliError(
      "FABCLI_LICENSE_UNVERIFIED",
      `The licence for listing ${listingId} could not be read (${error instanceof Error ? error.name : "lookup failed"}), so the import stopped before downloading anything. Only Fab Standard (Personal or Professional) and CC-BY assets are imported.`,
      true,
    );
  }
  const decision = classifyLicenses(slugs);
  if (decision.verdict === "allowed") return decision;
  throw new FabCliError(
    decision.verdict === "rejected"
      ? "FABCLI_LICENSE_NOT_PERMITTED"
      : "FABCLI_LICENSE_UNVERIFIED",
    decision.reason,
  );
}

export function createAssetImportUnrealHandler(dependencies: ImportUnrealDependencies = {}) {
  const runImport = dependencies.importDirectory ?? importUnrealDirectory;
  return async (rawInput: z.input<typeof AssetImportUnrealInputSchema>) => {
    try {
      const input = AssetImportUnrealInputSchema.parse(rawInput);
      const outputDir = resolve(input.outputDir);
      const report = await runImport({
        sourceDir: resolve(input.sourceDir),
        outputDir,
        maxTextureSize: input.maxTextureSize,
        onlyPackages: input.packages,
        sourceKind: "local-directory",
        ...(dependencies.environment ? { environment: dependencies.environment } : {}),
        ...(dependencies.log ? { log: dependencies.log } : {}),
      });
      const output = summarize(report, outputDir);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
        structuredContent: output,
      };
    } catch (error) {
      return errorResult(error);
    }
  };
}

export function fabDownloadRoot(environment: NodeJS.ProcessEnv = process.env): string {
  return (
    environment.THREENATIVE_FAB_DOWNLOAD_DIR?.trim() ||
    join(
      environment.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache"),
      "threenative-asset-mcp",
      "fab-downloads",
    )
  );
}

/**
 * The composed Fab flow: verify the session the user already established, resolve which Unreal
 * artifact the engine selector names, download it into an MCP-owned staging directory outside the
 * game, and hand that directory to the same importer a local pack takes. No step here logs in,
 * claims, purchases, or reads a token; a session that cannot be used stops the flow before any
 * download begins.
 */
export function createFabImportAssetHandler(dependencies: ImportUnrealDependencies = {}) {
  const runImport = dependencies.importDirectory ?? importUnrealDirectory;
  const environment = dependencies.environment ?? process.env;
  const log = dependencies.log ?? (() => {});
  return async (rawInput: z.input<typeof FabImportAssetInputSchema>) => {
    try {
      const input = FabImportAssetInputSchema.parse(rawInput);
      const listingId = parseListingId(input.listingIdOrUrl);
      // The licence gate runs first, on the anonymous public listing, so a refusal costs nothing
      // and no unusable entitlement is ever downloaded.
      const license = await requirePermittedLicense(
        listingId,
        dependencies.readLicenses ?? readPublishedLicenses,
      );
      log(`Licence check: ${license.reason}`);
      const fabCli =
        dependencies.fabCli ?? new FabCli({ environment, log });
      const tool = await fabCli.tool();
      await fabCli.requireAuthenticatedSession();

      const versions = await fabCli.unrealVersions(listingId);
      const { version: selected, reason: choiceReason } = FabCli.selectVersion(
        versions,
        input.engine,
        input.artifactId,
      );
      const extraWarnings: string[] = choiceReason === undefined ? [] : [choiceReason];
      // FabCLI filters by engine, not by artifact, so an explicit artifact is fetched through its
      // oldest engine, the one that names its package format.
      let engine = input.engine;
      if (input.artifactId || choiceReason !== undefined) {
        engine = oldestEngine(selected.engineVersions);
        if (input.engine && !selected.engineVersions.includes(input.engine)) {
          extraWarnings.push(
            `engine ${input.engine} is not published by artifact ${selected.artifactId} (${selected.engineVersions.join(", ")}); artifactId wins.`,
          );
        }
      }
      const stagingDir = join(fabDownloadRoot(environment), listingId, selected.artifactId);
      await mkdir(stagingDir, { recursive: true });

      const marker = join(stagingDir, ".fabcli-asset.json");
      const cached = await readFile(marker, "utf8").catch(() => undefined);
      if (cached === undefined || (await readdir(stagingDir)).length <= 1) {
        log(`Downloading ${selected.artifactId} from the Fab library…`);
        try {
          await fabCli.download({
            listingId,
            outputDir: stagingDir,
            engine,
            platform: input.platform,
          });
        } catch (error) {
          // A multi-platform artifact needs a platform picked. The source .uasset files are the
          // same whichever build is fetched, so refusing here would stop the flow over a choice
          // that does not change the meshes. The choice is made once, reported, and overridable.
          const ambiguous =
            error instanceof FabCliError &&
            /platform/i.test(error.message) &&
            input.platform === undefined;
          if (!ambiguous) throw error;
          const platform = preferredPlatform(selected.targetPlatforms) ?? "Windows";
          extraWarnings.push(
            `The ${selected.artifactId} artifact publishes several platform builds; downloaded the ${platform} build. Pass platform to choose another.`,
          );
          log(`Retrying the download with the ${platform} build…`);
          await fabCli.download({
            listingId,
            outputDir: stagingDir,
            engine,
            platform,
          });
        }
      } else {
        log(`Reusing the already-downloaded ${selected.artifactId} pack.`);
      }

      const outputDir = resolve(input.outputDir);
      const report = await runImport({
        sourceDir: stagingDir,
        outputDir,
        listingId,
        engine,
        sourceKind: "fab-listing",
        onlyPackages: input.packages,
        authenticatedDownload: true,
        fabcliVersion: tool.version,
        maxTextureSize: input.maxTextureSize,
        license: { verdict: license.verdict, slugs: license.slugs, reason: license.reason },
        extraWarnings,
        environment,
        log,
      });
      const output = summarize(report, outputDir);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
        structuredContent: output,
      };
    } catch (error) {
      return errorResult(error);
    }
  };
}


const OwnedListingSchema = z.object({
  listingId: z.string().max(100).optional(),
  title: z.string().max(300),
  url: z.string().max(1_000),
  categories: z.array(z.string().max(120)).max(20),
  distributionMethod: z.string().max(60),
  hasUnrealArtifact: z.boolean(),
  engineVersions: z.array(z.string().max(20)).max(60),
  artifacts: z
    .array(
      z.object({
        artifactId: z.string().max(200),
        engineVersions: z.array(z.string().max(20)).max(60),
        oldestEngine: z.string().max(20).optional(),
        route: z.enum(["umodel", "mesh-description", "cue4parse"]).optional(),
        targetPlatforms: z.array(z.string().max(60)).max(40),
      }),
    )
    .max(60)
    .describe(
      "Each Unreal artifact separately. An artifact's format is its oldest listed engine, which picks the decoder route.",
    ),
});

export const FabListOwnedInputSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe("Case-insensitive substring of the title or category. Omit to list everything."),
  unrealOnly: z
    .boolean()
    .default(false)
    .describe(
      "Keep only what fab_import_asset can actually take: a listing UID plus a published Unreal artifact. Drops the engine installs and code plugins a library also contains.",
    ),
});

export const FabListOwnedOutputSchema = z.object({
  listings: z.array(OwnedListingSchema).max(500),
  total: z.number().int().nonnegative(),
});

/**
 * What the signed-in Fab account already owns.
 *
 * Free assets remain the first place to look — `fab_search_assets` with the default
 * `priceMode: "free"` — because an asset nobody had to buy is the one a reader of this project can
 * also fetch. This tool is the second place: a paid listing already in the library costs nothing
 * further to use and never appears in a free search. It reads the library and nothing else; there
 * is no acquisition path here.
 */
export function createFabListOwnedHandler(dependencies: ImportUnrealDependencies = {}) {
  const environment = dependencies.environment ?? process.env;
  const log = dependencies.log ?? (() => {});
  return async (rawInput: z.input<typeof FabListOwnedInputSchema>) => {
    try {
      const input = FabListOwnedInputSchema.parse(rawInput ?? {});
      const fabCli = dependencies.fabCli ?? new FabCli({ environment, log });
      await fabCli.requireAuthenticatedSession();
      const owned = await fabCli.ownedListings();
      const needle = input.query?.toLowerCase();
      const matched = owned
        .filter((entry) => {
          // A library also holds engine installs and code plugins. They carry no listing UID, or
          // no Unreal artifact, and the importer can do nothing with either — offering them as
          // candidates would send an agent down a dead end.
          if (input.unrealOnly && (entry.listingId === undefined || entry.unrealArtifacts.length === 0)) {
            return false;
          }
          if (needle === undefined) return true;
          return (
            entry.title.toLowerCase().includes(needle) ||
            entry.categories.some((category) => category.toLowerCase().includes(needle))
          );
        })
        .map((entry) => ({
          ...(entry.listingId === undefined ? {} : { listingId: entry.listingId }),
          title: entry.title,
          url: entry.url,
          categories: entry.categories,
          distributionMethod: entry.distributionMethod,
          hasUnrealArtifact: entry.unrealArtifacts.length > 0,
          engineVersions: [
            ...new Set(entry.unrealArtifacts.flatMap((artifact) => artifact.engineVersions)),
          ],
          artifacts: entry.unrealArtifacts.map((artifact) => {
            const oldest = oldestEngine(artifact.engineVersions);
            return {
              artifactId: artifact.artifactId,
              engineVersions: artifact.engineVersions,
              ...(oldest === undefined ? {} : { oldestEngine: oldest, route: decoderRoute(oldest) }),
              targetPlatforms: artifact.targetPlatforms,
            };
          }),
        }));
      const output = FabListOwnedOutputSchema.parse({
        listings: matched.slice(0, 500),
        total: matched.length,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
        structuredContent: output,
      };
    } catch (error) {
      return errorResult(error);
    }
  };
}
