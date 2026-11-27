import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { NodeIO } from "@gltf-transform/core";
import sharp from "sharp";
import { z } from "zod";

import { canonicalPath, isInside, type TextureProjectionMode } from "../config.js";
import { PolyHavenClient } from "../polyhaven/client.js";
import { auditCookConfig } from "../texture-projection/config-audit.js";
import { MAX_ATLAS_PAGES } from "../texture-projection/atlas-pages.js";
import { buildAtlasSheet, buildContactSheet } from "../texture-projection/contact-sheet.js";
import { readProjectedAtlasMarker } from "../texture-projection/glb-marker.js";
import { DEFAULT_MODEL } from "../texture-projection/models.js";
import { matchPolyHavenMaterials, matchPolyHavenModels } from "../texture-projection/polyhaven-matcher.js";
import { DEFAULT_VERIFY_MODEL } from "../texture-projection/verify.js";
import { defaultRunRoot, readRun, type StoredRun } from "../texture-projection/runs.js";
import {
  TextureProjectionError,
  measureStoredRunBlurredPercent,
  paintTextureProjection,
  quoteTextureProjection,
} from "../texture-projection/runner.js";

/**
 * Texture projection for gray blockout levels and environments: an image model paints the level
 * from planned camera views, the views are projected into the level's UV atlas, and the baked GLB
 * comes back ready to cook. Quote first (free), then paint, then inspect the bake by eye.
 */

const PathSchema = z.string().min(1).max(4_096);
const ModelSchema = z
  .string()
  .min(1)
  .max(128)
  .default(DEFAULT_MODEL)
  .describe(
    'Image model alias: "or-klein" (default), "flux-3", "qwen-2.1-turbo", "qwen-2.1-pro", "muse-image", "or-seedream-lite" or "or:<model id>".',
  );
const AtlasSchema = z
  .union([z.number().int().min(256).max(8_192), z.literal("auto")])
  .default("auto")
  .describe(
    'Atlas size in pixels, or "auto" (default) for the smallest power of two that matches what the planned views resolve.',
  );
const AtlasPagesSchema = z
  .union([z.number().int().min(1).max(MAX_ATLAS_PAGES), z.literal("auto")])
  .default("auto")
  .describe(
    'Multi-page UV atlas count (1-4), or "auto" (default) to split large levels across up to 4 atlases for higher texel density.',
  );
const PlanShape = {
  views: z.number().int().min(1).max(96).optional().describe("Maximum number of camera views to plan (default 36)."),
  aerial: z.number().int().min(0).max(24).optional().describe("Aerial ring cameras around the level (default 0)."),
  roofs: z.number().int().min(0).max(24).optional().describe("Close roof passes painted with the roof prompt (default 0)."),
  holes: z
    .number()
    .int()
    .min(0)
    .max(24)
    .optional()
    .describe(
      "Extra views over the largest unpainted texels players can see, painted until visible coverage reaches 95% (default 12).",
    ),
} as const;

const UvStretchSchema = z
  .object({
    p95: z.number().nonnegative(),
    worstMaterial: z.string(),
    worstMaterialP95: z.number().nonnegative(),
    triangles: z.number().int().nonnegative(),
    uniform: z.boolean(),
  })
  .strict();

export const TextureProjectQuoteInputSchema = z
  .object({
    levelPath: PathSchema.describe(
      "Gray blockout level or environment GLB, project-relative; it must carry TEXCOORD_0 (unwrapped).",
    ),
    ...PlanShape,
    model: ModelSchema,
    atlas: AtlasSchema,
    atlasPages: AtlasPagesSchema,
    verify: z
      .boolean()
      .optional()
      .describe(
        "Opt-in vision check: one OpenRouter chat call per painted view, priced separately here (default false, so the quote prices images only).",
      ),
    verifyModel: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("OpenRouter chat model id with image input for the opt-in vision check (default google/gemini-2.5-flash-lite)."),
  })
  .strict();

export const TextureProjectQuoteOutputSchema = z
  .object({
    views: z.number().int().nonnegative(),
    aerial: z.number().int().nonnegative(),
    roofs: z.number().int().nonnegative(),
    holes: z.number().int().nonnegative(),
    model: z.string(),
    modelId: z.string(),
    estimatedUsd: z.number().nonnegative(),
    atlas: z.number().int().positive(),
    atlasPages: z.number().int().positive(),
    estimatedBlurredTexelPercent: z.number().min(0).max(100),
    uvStretch: UvStretchSchema,
    verifyModel: z.string().nullable(),
    estimatedVerifyUsd: z.number().nonnegative(),
  })
  .strict();

export const TextureProjectPaintInputSchema = z
  .object({
    levelPath: PathSchema.describe(
      "Gray blockout level or environment GLB, project-relative; it must carry TEXCOORD_0 (unwrapped).",
    ),
    outputPath: PathSchema.describe(
      "Painted GLB to write, project-relative and under the project's assets/ directory (atomically replaced).",
    ),
    model: ModelSchema,
    fillModel: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe("Model alias for fill and hole views (defaults to model); the first views always use model."),
    fill: z
      .enum(["detail", "debug"])
      .optional()
      .describe(
        'What the exported atlas writes in a texel no accepted view painted: "detail" (default) continues the material around the gap; "debug" writes it hot pink (#FF69B4) so a capture can count the bake gaps. Use "debug" for verification, never ship it.',
      ),
    atlas: AtlasSchema,
    atlasPages: AtlasPagesSchema,
    viewSize: z
      .number()
      .int()
      .min(128)
      .max(4_096)
      .default(1_024)
      .describe("Pixels per view image sent to the model (default 1024)."),
    lighting: z
      .enum(["outdoor", "overcast", "indoor"])
      .default("overcast")
      .describe('Light the clay render is painted under; "overcast" (default) keeps albedo free of baked sun.'),
    style: z.string().min(1).max(2_000).optional().describe("Material style for the level, e.g. its architecture and wear."),
    styleImagePath: PathSchema.optional().describe("Reference image whose materials and palette ride along, project-relative."),
    ...PlanShape,
    verify: z
      .boolean()
      .optional()
      .describe(
        "Opt-in vision check: one OpenRouter chat call per painted view, priced separately in the quote (default false). A rejected view is repainted once, then left to the fill pass. You review inspect's contact sheet instead.",
      ),
    verifyModel: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("OpenRouter chat model id with image input for the opt-in vision check (default google/gemini-2.5-flash-lite)."),
    promptTestView: z
      .number()
      .int()
      .min(0)
      .max(95)
      .optional()
      .describe("Paint only this planned view, for one image: a prompt test that leaves the run incomplete."),
    resumeRunId: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe("Continue a stored run: its paid views are replayed and only the missing ones are requested."),
    rejectViews: z
      .array(z.number().int().min(0).max(95))
      .optional()
      .describe(
        "Views you judged wrong in inspect's contact sheet: each is stored as rejected by the caller, projected nowhere, and buys no image. Requires resumeRunId and indices the run stores.",
      ),
  })
  .strict();

const SwatchSchema = z
  .object({
    file: z.string().describe("File name beside the GLB, e.g. courtyard.swatch_wall.png."),
    path: z.string().describe("Absolute path of that file."),
    metres: z.number().positive().describe("Patch side in metres, before the wrap crop: the largest square the view gave."),
    metresX: z
      .number()
      .positive()
      .describe("Extent of the cut swatch across, metres: the width a game repeats it at."),
    metresY: z
      .number()
      .positive()
      .describe("Extent of the cut swatch up, metres: its height (a cropped axis is shorter than metres)."),
    view: z.number().int().nonnegative().describe("Accepted view the swatch was cut from."),
    metresPerPixel: z.number().positive().describe("Metres of surface per swatch pixel (its true scale)."),
    sourceMetresPerPixel: z
      .number()
      .positive()
      .describe("Metres of surface per pixel of that view; below metresPerPixel means the swatch is an upsample."),
    incidence: z.number().min(0).max(90).describe("Angle between the patch's normal and its view, in degrees."),
    corners: z
      .array(z.array(z.number()).length(3))
      .length(4)
      .describe("The patch's four world corners, in order: -u-v, +u-v, +u+v, -u+v from its centre."),
  })
  .strict();

export const TextureProjectPaintOutputSchema = z
  .object({
    runId: z.string(),
    outputPath: z.string(),
    coveragePercent: z.number().min(0).max(100),
    visibleCoveragePercent: z
      .number()
      .min(0)
      .max(100)
      .describe("Share of the texels player-height cameras see that the bake painted (B)."),
    warnings: z.array(z.string()).describe("What the run wants read before the bake is used (a visible-coverage shortfall)."),
    viewsPainted: z
      .number()
      .int()
      .nonnegative(),
    viewsRejected: z
      .object({
        grazing: z.number().int().nonnegative(),
        structure: z.number().int().nonnegative(),
        verify: z.number().int().nonnegative(),
        verifyUnparsed: z.number().int().nonnegative(),
        caller: z
          .number()
          .int()
          .nonnegative()
          .describe("Views you rejected through rejectViews; they were not projected and bought nothing."),
      })
      .strict(),
    viewsRepainted: z.number().int().nonnegative(),
    viewsBanded: z
      .number()
      .int()
      .nonnegative()
      .describe("Views whose vision check listed an edge band (a coping, a plinth): projected, and recorded in run.json."),
    verifyModel: z.string().nullable(),
    blurredTexelPercent: z.number().min(0).max(100),
    magnificationSkippedPercent: z.number().min(0).max(100),
    atlas: z.number().int().positive(),
    atlasPages: z.number().int().positive(),
    texelsPerMetre: z.number().nonnegative().optional(),
    estimatedUsd: z.number().nonnegative(),
    cookConfigHint: z.string(),
    swatches: z
      .object({
        jsonPath: z.string().describe("The swatches.json written beside the GLB; the run directory keeps its own copy."),
        wall: SwatchSchema.nullable(),
        floor: SwatchSchema.nullable(),
      })
      .strict()
      .nullable()
      .describe(
        "True-scale, tileable material swatches cut from the stored paint: a game tiles them in world space for close range and keeps the atlas for macro variation. Null for a prompt test; a class no accepted view could give a patch for is null and named in warnings.",
      ),
    paintedMask: z
      .object({
        file: z.string().describe("File name beside the GLB, e.g. courtyard.painted.png."),
        path: z.string().describe("Absolute path of that file."),
      })
      .strict()
      .nullable()
      .describe(
        "The painted-coverage mask written beside the GLB: an 8-bit grayscale PNG at a quarter of the atlas' side, 255 where an accepted view painted the texel and 0 where the fill made the colour up, feathered and bled into the UV gutters. A game samples it as a linear data texture at the atlas' uv to swap the atlas for the paint's swatch exactly where no view painted. The atlas itself stays opaque RGB with the fill's own colour, so it cooks UASTC. Null for the debug fill, which writes no mask.",
      ),
  })
  .strict();

export const TextureProjectInspectInputSchema = z
  .object({
    runId: z.string().min(1).max(128).optional().describe("Stored run under the project's .threenative/texture-projection."),
    glbPath: PathSchema.optional().describe(
      "A projected GLB, project-relative; its extras marker names the run when one exists.",
    ),
  })
  .strict()
  .refine((value) => value.runId !== undefined || value.glbPath !== undefined, {
    message: "pass runId or glbPath",
  });

export const TextureProjectInspectOutputSchema = z
  .object({
    runId: z.string().nullable(),
    glbPath: z.string().nullable(),
    atlas: z.number().int().positive().nullable(),
    coveragePercent: z.number().min(0).max(100).nullable(),
    blurredTexelPercent: z.number().min(0).max(100).nullable(),
    magnificationSkippedPercent: z.number().min(0).max(100).nullable(),
    views: z.number().int().nonnegative(),
    rejectedViews: z.array(z.object({ index: z.number().int(), reason: z.string() }).strict()),
    /** The vision check's own verdicts, so a bake's invented structure is visible without the run.json. */
    verifyModel: z.string().nullable(),
    verifyRejected: z
      .array(
        z
          .object({
            index: z.number().int(),
            added: z.array(z.string()),
            bands: z.array(z.string()),
            scaleOk: z.boolean(),
            verdict: z.string(),
          })
          .strict(),
      ),
    viewsRepainted: z.number().int().nonnegative(),
    cookConfig: z
      .object({
        path: z.string().nullable(),
        baseColorMaxSize: z.number().int().positive(),
        baseColorCodec: z.string().nullable(),
        flagged: z.boolean(),
        findings: z.array(z.string()),
      })
      .strict(),
    contactSheetPath: z.string(),
    contactSheetViews: z.array(z.number().int()),
  })
  .strict();

function projectRoot(): string {
  // The MCP launch root is the game project; every path the tools take is relative to it.
  return process.cwd();
}

/** Resolve one project-relative path and refuse anything that canonicalises outside `parent`. */
function containedPath(parent: string, value: string, label: string): string {
  const canonicalRoot = canonicalPath(parent);
  const target = canonicalPath(isAbsolute(value) ? value : resolve(canonicalRoot, value));
  if (target === canonicalRoot || !isInside(target, canonicalRoot)) {
    throw new TextureProjectionError(
      "TEXTURE_PROJECT_UNSAFE_PATH",
      `${label} must stay inside ${label === "outputPath" ? "the project's assets/ directory" : "the project root"} (a relative path is resolved from there)`,
    );
  }
  return target;
}

function planRequest(input: {
  views?: number | undefined;
  aerial?: number | undefined;
  roofs?: number | undefined;
  holes?: number | undefined;
}) {
  return {
    ...(input.views === undefined ? {} : { maxViews: input.views }),
    ...(input.aerial === undefined ? {} : { aerial: input.aerial }),
    ...(input.roofs === undefined ? {} : { roofs: input.roofs }),
    ...(input.holes === undefined ? {} : { holes: input.holes }),
  };
}

/**
 * The cook settings for one painted atlas (C.3, A.4). The atlas is at most 4096 px (the engine cook's
 * KTX2 ceiling), so no override can ask for more than the bake holds. The engine cook of the release
 * that ships PRD-916 reads the GLB's extras.threenative.textureProjection marker and keeps this size
 * with UASTC on its own; the explicit override below only says it out loud, and wins if the project
 * ever needs a different choice for this file.
 */
export function cookConfigHint(atlas: number): string {
  return [
    "// threenative.config.ts — the painted atlas at the size the bake actually holds (<= 4096, the KTX2",
    "// ceiling). The engine cook of the release that ships PRD-916 honours the GLB's",
    "// extras.threenative.textureProjection marker: it keeps this size and encodes UASTC with full mips.",
    "// The override below is the same choice stated explicitly, for a project that pins it per slot.",
    "// The game sets anisotropy 8 on the level's base colour map so the atlas stays sharp at a graze.",
    "assets: {",
    "  models: {",
    "    textures: {",
    `      maxSize: { baseColorTexture: ${atlas} },`,
    '      overrides: [{ slot: "baseColorTexture", codec: "uastc" }],',
    "    },",
    "  },",
    "},",
  ].join("\n");
}

function failure(error: unknown): {
  isError: true;
  content: [{ type: "text"; text: string }];
} {
  const code =
    error instanceof TextureProjectionError
      ? error.code
      : error instanceof z.ZodError
        ? "TEXTURE_PROJECT_INVALID_INPUT"
        : "TEXTURE_PROJECT_FAILED";
  const message =
    error instanceof TextureProjectionError
      ? error.message
      : error instanceof z.ZodError
        ? error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")
        : error instanceof Error
          ? error.message
          : String(error);
  return { isError: true, content: [{ type: "text", text: `${code}: ${message}` }] };
}

export function createTextureProjectQuoteHandler() {
  return async (raw: z.input<typeof TextureProjectQuoteInputSchema>) => {
    try {
      const input = TextureProjectQuoteInputSchema.parse(raw);
      const root = projectRoot();
      const levelPath = containedPath(root, input.levelPath, "levelPath");
      const quote = await quoteTextureProjection({
        levelPath,
        cwd: root,
        // No key: a quote plans cameras and measures the plan, it never buys an image.
        env: {},
        atlas: input.atlas,
        atlasPages: input.atlasPages,
        plan: planRequest(input),
        firstModel: input.model,
        ...(input.verify === undefined ? {} : { verify: input.verify }),
        ...(input.verifyModel === undefined ? {} : { verifyModel: input.verifyModel }),
      });
      const output = TextureProjectQuoteOutputSchema.parse({
        views: quote.views,
        aerial: quote.aerial,
        roofs: quote.roofs,
        holes: quote.holes,
        model: quote.model,
        modelId: quote.modelId,
        estimatedUsd: quote.estimatedUsd,
        atlas: quote.atlas,
        atlasPages: quote.atlasPages,
        estimatedBlurredTexelPercent: quote.estimatedBlurredTexelPercent,
        uvStretch: quote.uvStretch,
        verifyModel: quote.verifyModel,
        estimatedVerifyUsd: quote.estimatedVerifyUsd,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(output) }], structuredContent: output };
    } catch (error) {
      return failure(error);
    }
  };
}

export function createTextureProjectPaintHandler() {
  return async (raw: z.input<typeof TextureProjectPaintInputSchema>) => {
    try {
      const input = TextureProjectPaintInputSchema.parse(raw);
      const root = projectRoot();
      const levelPath = input.levelPath === undefined ? undefined : containedPath(root, input.levelPath, "levelPath");
      const outputPath = containedPath(root, input.outputPath, "outputPath");
      const assetsRoot = canonicalPath(join(root, "assets"));
      if (!isInside(canonicalPath(outputPath), assetsRoot)) {
        throw new TextureProjectionError(
          "TEXTURE_PROJECT_UNSAFE_PATH",
          "outputPath must be under the project's assets/ directory, project-relative",
        );
      }
      const styleImagePath =
        input.styleImagePath === undefined ? undefined : containedPath(root, input.styleImagePath, "styleImagePath");
      const result = await paintTextureProjection({
        cwd: root,
        env: process.env,
        ...(levelPath === undefined ? {} : { levelPath }),
        outputPath,
        ...(styleImagePath === undefined ? {} : { styleImagePath }),
        firstModel: input.model,
        fillModel: input.fillModel ?? input.model,
        ...(input.fill === undefined ? {} : { fill: input.fill }),
        atlas: input.atlas,
        atlasPages: input.atlasPages,
        viewSize: input.viewSize,
        lighting: input.lighting,
        ...(input.style === undefined ? {} : { style: input.style }),
        ...(input.promptTestView === undefined ? {} : { promptTestView: input.promptTestView }),
        ...(input.resumeRunId === undefined ? {} : { resumeRunId: input.resumeRunId }),
        ...(input.rejectViews === undefined ? {} : { rejectViews: input.rejectViews }),
        ...(input.verify === undefined ? {} : { verify: input.verify }),
        ...(input.verifyModel === undefined ? {} : { verifyModel: input.verifyModel }),
        plan: planRequest(input),
      });
      const output = TextureProjectPaintOutputSchema.parse({
        runId: result.runId,
        outputPath: relative(root, result.outputPath) || basename(result.outputPath),
        coveragePercent: result.coveragePercent,
        visibleCoveragePercent: result.visibleCoveragePercent,
        warnings: result.warnings,
        viewsPainted: result.viewsPainted,
        viewsRejected: result.viewsRejected,
        viewsRepainted: result.viewsRepainted,
        viewsBanded: result.viewsBanded,
        verifyModel: result.verifyModel,
        blurredTexelPercent: result.blurredTexelPercent,
        magnificationSkippedPercent: result.magnificationSkippedPercent,
        atlas: result.atlas,
        atlasPages: result.atlasPages,
        ...(result.texelsPerMetre === undefined ? {} : { texelsPerMetre: result.texelsPerMetre }),
        estimatedUsd: result.estimatedUsd,
        cookConfigHint: cookConfigHint(result.atlas),
        swatches: result.swatches,
        paintedMask: result.paintedMask,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(output) }], structuredContent: output };
    } catch (error) {
      return failure(error);
    }
  };
}

/** The painted atlas image inside a projected GLB, for a sheet with no stored views. */
async function atlasImageOf(glbPath: string): Promise<{ image: Uint8Array | undefined; runId: string | undefined }> {
  const bytes = new Uint8Array(await readFile(glbPath));
  const marker = readProjectedAtlasMarker(bytes);
  const document = await new NodeIO().read(glbPath);
  const root = document.getRoot();
  const material = root.listMaterials()[0];
  const image = material?.getBaseColorTexture()?.getImage() ?? root.listTextures()[0]?.getImage();
  return { image: image ?? undefined, runId: marker?.runId };
}

async function readConfigAudit(root: string, atlas: number) {
  const path = join(root, "threenative.config.ts");
  let text: string | undefined;
  try {
    if ((await stat(path)).isFile()) text = await readFile(path, "utf8");
  } catch {
    text = undefined;
  }
  const audit = auditCookConfig(text, atlas, text === undefined ? null : relative(root, path));
  return {
    path: audit.path,
    baseColorMaxSize: audit.baseColorMaxSize,
    baseColorCodec: audit.baseColorCodec ?? null,
    flagged: audit.flagged,
    findings: [...audit.findings],
  };
}

export function createTextureProjectInspectHandler() {
  return async (raw: z.input<typeof TextureProjectInspectInputSchema>) => {
    try {
      const input = TextureProjectInspectInputSchema.parse(raw);
      const root = projectRoot();
      const runRoot = defaultRunRoot(root);
      const glbPath = input.glbPath === undefined ? undefined : containedPath(root, input.glbPath, "glbPath");
      let runId = input.runId;
      let atlasFromGlb: number | undefined;
      let glbImage: Uint8Array | undefined;
      if (glbPath !== undefined) {
        const fromGlb = await atlasImageOf(glbPath);
        glbImage = fromGlb.image;
        if (runId === undefined && fromGlb.runId !== undefined) runId = fromGlb.runId;
        const marker = readProjectedAtlasMarker(new Uint8Array(await readFile(glbPath)));
        atlasFromGlb = marker?.atlas;
      }
      const run: StoredRun | undefined =
        runId === undefined
          ? undefined
          : await readRun(runRoot, runId).then((stored) => {
              if (!stored) {
                throw new TextureProjectionError(
                  "TEXTURE_PROJECT_RUN_NOT_FOUND",
                  `no stored run ${runId} under ${runRoot}`,
                );
              }
              return stored;
            });

      if (run !== undefined) {
        const rejectedViews = run.views
          .filter((view) => view.rejected !== undefined)
          .map((view) => ({ index: view.index, reason: view.rejected! }));
        // Measured from the run's own plan at its atlas size; no image is bought.
        const measured = await measureStoredRunBlurredPercent(runRoot, run);
        const blurredTexelPercent = measured.blurred;
        const summary = `${run.views.length} views · ${run.complete ? "complete" : "incomplete"} · ${run.cost.toFixed(3)} USD · ${
          rejectedViews.length
        } rejected · blurred ${blurredTexelPercent.toFixed(1)}% · magnified texels left empty ${measured.magnificationSkipped.toFixed(1)}%`;
        const sheet = await buildContactSheet(runRoot, run, summary);
        const coverage = run.views
          .filter((view) => view.rejected === undefined)
          .map((view) => view.coverage)
          .at(-1);
        const output = TextureProjectInspectOutputSchema.parse({
          runId: run.runId,
          glbPath: glbPath === undefined ? null : relative(root, glbPath),
          atlas: run.atlas,
          coveragePercent: coverage === undefined ? null : Math.round(coverage * 100),
          blurredTexelPercent,
          magnificationSkippedPercent: measured.magnificationSkipped,
          views: run.views.length,
          rejectedViews,
          verifyModel:
            run.options.verify === true
              ? ((run.options.verifyModel as string | undefined) ?? DEFAULT_VERIFY_MODEL.id)
              : null,
          verifyRejected: run.views
            .filter((view) => view.rejected === "verify" && view.verify !== undefined)
            .map((view) => ({
              index: view.index,
              added: [...(view.verify?.added ?? [])],
              bands: [...(view.verify?.bands ?? [])],
              scaleOk: view.verify?.scaleOk ?? false,
              verdict: view.verify?.verdict ?? "unparsed",
            })),
          viewsRepainted: run.views.filter((view) => view.repainted === true).length,
          cookConfig: await readConfigAudit(root, run.atlas),
          contactSheetPath: relative(root, sheet.path),
          contactSheetViews: [...sheet.views],
        });
        return {
          content: [
            { type: "image" as const, mimeType: "image/png", data: sheet.png.toString("base64") },
            { type: "text" as const, text: JSON.stringify(output) },
          ],
          structuredContent: output,
        };
      }

      if (glbPath === undefined) {
        throw new TextureProjectionError(
          "TEXTURE_PROJECT_INVALID_INPUT",
          "pass a runId or a glbPath; no stored run was named",
        );
      }
      // A GLB without a stored run: report what the bytes themselves say, and show the atlas.
      const imageSize = glbImage === undefined ? undefined : await atlasSize(glbImage);
      const atlas = atlasFromGlb ?? imageSize?.width ?? 2_048;
      const png = await buildAtlasSheet(glbImage, `${basename(glbPath)} · atlas ${atlas}px · no stored run`);
      const directory = join(runRoot, "inspect");
      await mkdir(directory, { recursive: true });
      const sheetPath = join(directory, `${basename(glbPath).replace(/\.\w+$/, "")}_atlas.png`);
      await writeFile(sheetPath, png);
      const output = TextureProjectInspectOutputSchema.parse({
        runId: runId ?? null,
        glbPath: relative(root, glbPath),
        atlas,
        coveragePercent: null,
        blurredTexelPercent: null,
        views: 0,
        rejectedViews: [],
        cookConfig: await readConfigAudit(root, atlas),
        contactSheetPath: relative(root, sheetPath),
        contactSheetViews: [],
      });
      return {
        content: [
          { type: "image" as const, mimeType: "image/png", data: png.toString("base64") },
          { type: "text" as const, text: JSON.stringify(output) },
        ],
        structuredContent: output,
      };
    } catch (error) {
      return failure(error);
    }
  };
}

async function atlasSize(image: Uint8Array): Promise<{ width: number; height: number }> {
  const metadata = await sharp(Buffer.from(image)).metadata();
  return { width: metadata.width ?? 0, height: metadata.height ?? 0 };
}

const SurfaceCropSchema = z
  .object({
    x: z.number().nonnegative(),
    y: z.number().nonnegative(),
    width: z.number().positive(),
    height: z.number().positive(),
  })
  .strict();

const ModelDimensionsSchema = z.array(z.number().positive()).length(3);

const SurfaceQuerySchema = z
  .object({
    name: z.string().min(1).max(100),
    query: z.string().min(1).max(400),
    crop: SurfaceCropSchema.optional(),
    homogeneous: z.boolean().optional(),
    referenceImagePath: PathSchema.optional().describe(
      "Optional per-surface reference image override, project-relative.",
    ),
  })
  .strict();

const ModelQuerySchema = z
  .object({
    name: z.string().min(1).max(100),
    query: z.string().min(1).max(400),
    crop: SurfaceCropSchema.optional(),
    referenceImagePath: PathSchema.optional().describe(
      "Optional per-model reference image override, project-relative.",
    ),
    dimensionsMeters: ModelDimensionsSchema.optional().describe(
      "Expected target bounding box dimensions in metres [x, y, z].",
    ),
    maxPolycount: z.number().int().positive().max(10_000_000).optional(),
  })
  .strict();

export const TextureProjectMatchMaterialsInputSchema = z
  .object({
    mode: z
      .enum(["detailed", "lean"])
      .optional()
      .describe(
        'Workflow mode: "detailed" (Poly Haven PBR + OpenRouter AI projection) or "lean" (CC0 Poly Haven PBR textures/models + procedural/tint fallbacks only, no API key). Defaults to the server mode.',
      ),
    referenceImagePath: PathSchema.optional().describe(
      "Primary reference image to match against Poly Haven textures/models, project-relative.",
    ),
    referenceImagePaths: z
      .array(PathSchema)
      .min(1)
      .max(16)
      .optional()
      .describe(
        "Multiple project-relative reference images (first entry is the default when an item omits referenceImagePath).",
      ),
    surfaces: z.array(SurfaceQuerySchema).max(24).optional(),
    models: z.array(ModelQuerySchema).max(24).optional(),
    topCandidates: z.number().int().min(1).max(12).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const surfaces = value.surfaces ?? [];
    const models = value.models ?? [];
    if (surfaces.length + models.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["surfaces"],
        message: "Provide at least one surface or model query.",
      });
    }
    const hasDefaultRef =
      value.referenceImagePath !== undefined || (value.referenceImagePaths?.length ?? 0) > 0;
    if (!hasDefaultRef) {
      const missingSurface = surfaces.find((s) => s.referenceImagePath === undefined);
      const missingModel = models.find((m) => m.referenceImagePath === undefined);
      if (missingSurface || missingModel) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["referenceImagePath"],
          message:
            "Provide referenceImagePath, referenceImagePaths, or a per-item referenceImagePath on every query.",
        });
      }
    }
  });

const HexColorSchema = z.string().regex(/^#[0-9a-f]{6}$/u);

const CandidateScoreSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    score: z.number().min(0).max(1),
    semanticScore: z.number().min(0).max(1),
    labChromaScore: z.number().min(0).max(1),
    textureEnergyScore: z.number().min(0).max(1),
    thumbnailUrl: z.string().url(),
    labColorShift: z.object({ dL: z.number(), dA: z.number(), dB: z.number() }).strict(),
    dimensions: z.array(z.number().positive()).optional(),
    polycount: z.number().int().nonnegative().optional(),
  })
  .strict();

export const TextureProjectMatchMaterialsOutputSchema = z
  .object({
    mode: z.enum(["detailed", "lean"]),
    requiresOpenRouterKey: z.boolean(),
    results: z.array(
      z
        .object({
          name: z.string().min(1),
          eligible: z.boolean(),
          decision: z.enum([
            "use_polyhaven_pbr",
            "polyhaven_detail_plus_project",
            "ai_project_only",
            "procedural_tint_fallback",
          ]),
          referenceHex: HexColorSchema,
          bestMatch: CandidateScoreSchema.nullable(),
          alternatives: z.array(CandidateScoreSchema),
        })
        .strict(),
    ),
    modelResults: z.array(
      z
        .object({
          name: z.string().min(1),
          decision: z.enum(["use_polyhaven_model", "ai_project_only", "procedural_tint_fallback"]),
          referenceHex: HexColorSchema,
          bestMatch: CandidateScoreSchema.nullable(),
          alternatives: z.array(CandidateScoreSchema),
        })
        .strict(),
    ),
  })
  .strict();

export function createTextureProjectMatchMaterialsHandler(
  client: PolyHavenClient,
  serverMode: TextureProjectionMode = "detailed",
) {
  return async (raw: z.input<typeof TextureProjectMatchMaterialsInputSchema>) => {
    try {
      const input = TextureProjectMatchMaterialsInputSchema.parse(raw);
      const effectiveMode = input.mode ?? serverMode;
      if (serverMode === "lean" && effectiveMode === "detailed") {
        throw new TextureProjectionError(
          "TEXTURE_PROJECT_MODE_RESTRICTED",
          'Server is running in "lean" mode and refuses "detailed" AI-projection matching. Omit mode or pass mode: "lean".',
        );
      }

      const root = projectRoot();
      const referenceImagePath =
        input.referenceImagePath === undefined
          ? undefined
          : containedPath(root, input.referenceImagePath, "referenceImagePath");
      const referenceImagePaths = input.referenceImagePaths?.map((entry, index) =>
        containedPath(root, entry, `referenceImagePaths[${index}]`),
      );

      const surfaces = (input.surfaces ?? []).map((surface, index) => ({
        name: surface.name,
        query: surface.query,
        ...(surface.crop === undefined ? {} : { crop: surface.crop }),
        ...(surface.homogeneous === undefined ? {} : { homogeneous: surface.homogeneous }),
        ...(surface.referenceImagePath === undefined
          ? {}
          : {
              referenceImagePath: containedPath(
                root,
                surface.referenceImagePath,
                `surfaces[${index}].referenceImagePath`,
              ),
            }),
      }));

      const models = (input.models ?? []).map((model, index) => ({
        name: model.name,
        query: model.query,
        ...(model.crop === undefined ? {} : { crop: model.crop }),
        ...(model.dimensionsMeters === undefined
          ? {}
          : {
              dimensionsMeters: [
                model.dimensionsMeters[0] ?? 0,
                model.dimensionsMeters[1] ?? 0,
                model.dimensionsMeters[2] ?? 0,
              ] as const,
            }),
        ...(model.maxPolycount === undefined ? {} : { maxPolycount: model.maxPolycount }),
        ...(model.referenceImagePath === undefined
          ? {}
          : {
              referenceImagePath: containedPath(
                root,
                model.referenceImagePath,
                `models[${index}].referenceImagePath`,
              ),
            }),
      }));

      const sharedRefFields = {
        mode: effectiveMode,
        ...(referenceImagePath === undefined ? {} : { referenceImagePath }),
        ...(referenceImagePaths === undefined ? {} : { referenceImagePaths }),
        ...(input.topCandidates === undefined ? {} : { topCandidates: input.topCandidates }),
      };

      const [results, modelResults] = await Promise.all([
        matchPolyHavenMaterials({ ...sharedRefFields, surfaces }, { client }),
        matchPolyHavenModels({ ...sharedRefFields, models }, { client }),
      ]);

      const requiresOpenRouterKey =
        effectiveMode === "detailed" &&
        (results.some(
          (entry) => entry.decision === "ai_project_only" || entry.decision === "polyhaven_detail_plus_project",
        ) ||
          modelResults.some((entry) => entry.decision === "ai_project_only"));

      const output = TextureProjectMatchMaterialsOutputSchema.parse({
        mode: effectiveMode,
        requiresOpenRouterKey,
        results,
        modelResults,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(output) }], structuredContent: output };
    } catch (error) {
      return failure(error);
    }
  };
}
