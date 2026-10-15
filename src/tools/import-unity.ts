import { join, resolve } from "node:path";

import { z } from "zod";

import { UnityImportError } from "../unity/errors.js";
import { type UnityImportReport, importUnityPackage } from "../unity/importer.js";
import { UnityPackageError } from "../unity/package.js";
import { ToolchainError } from "../unreal/toolchain.js";

const SizeMetersSchema = z.object({
  x: z.number().nonnegative(),
  y: z.number().nonnegative(),
  z: z.number().nonnegative(),
});

const SummarySchema = z.object({
  outputDir: z.string().max(4_096),
  reportPath: z.string().max(4_096),
  importerVersion: z.number().int().positive(),
  materials: z.enum(["complete", "degraded"]),
  counts: z.object({
    models: z.number().int().nonnegative(),
    materials: z.number().int().nonnegative(),
    textures: z.number().int().nonnegative(),
    fallbackMaterials: z.number().int().nonnegative(),
    boundSlots: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
  blender: z.object({ version: z.string().max(40), origin: z.string().max(40) }),
  // Any LICENSE / Third-Party Notices file in the package. Restricted Assets carry their own terms.
  licenseFiles: z
    .array(z.object({ path: z.string().max(1_024), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/), excerpt: z.string().max(600) }))
    .max(100),
  models: z
    .array(
      z.object({
        name: z.string().max(200),
        source: z.string().max(1_024),
        glb: z.string().max(1_024),
        bytes: z.number().int().nonnegative(),
        vertices: z.number().int().nonnegative(),
        sizeMeters: SizeMetersSchema,
        slots: z.array(
          z.object({
            embedded: z.string().max(200),
            binding: z.enum(["externalObjects", "name-search", "embedded", "disabled"]),
            material: z.string().max(1_024).optional(),
            status: z.enum(["mapped", "fallback", "embedded"]),
          }),
        ).max(1_000),
      }),
    )
    .max(5_000),
  materialAssets: z
    .array(
      z.object({
        name: z.string().max(200),
        path: z.string().max(1_024),
        pipeline: z.string().max(40),
        status: z.enum(["mapped", "fallback"]),
        shader: z.string().max(1_024),
        fallbackReason: z.string().max(1_024).optional(),
      }),
    )
    .max(10_000),
  textures: z
    .array(
      z.object({
        name: z.string().max(200),
        png: z.string().max(1_024),
        bytes: z.number().int().nonnegative(),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      }),
    )
    .max(20_000),
  skipped: z.array(z.object({ asset: z.string().max(1_024), reason: z.string().max(2_000) })).max(400),
  failed: z.array(z.object({ asset: z.string().max(1_024), reason: z.string().max(2_000) })).max(400),
  warnings: z.array(z.string().max(500)).max(400),
  durationMs: z.number().int().nonnegative(),
});

export type UnityImportSummary = z.output<typeof SummarySchema>;

export const AssetImportUnityInputSchema = z.object({
  source: z
    .string()
    .trim()
    .min(1)
    .max(4_096)
    .describe("A .unitypackage, a UPM package tarball (.tgz) or a Unity project folder on this machine. unity_list_packages lists the Unity Editor's cached downloads."),
  outputDir: z
    .string()
    .trim()
    .min(1)
    .max(4_096)
    .describe("Directory the GLBs, textures and import-report.json are written to. It must be new or empty: this tool never overwrites an import."),
  assets: z
    .array(z.string().trim().min(1).max(500))
    .max(500)
    .optional()
    .describe("Convert only these models: a project path (Assets/Models/crate.fbx), a file name or a name without extension. Omit to convert every FBX, OBJ and .blend model."),
  maxTextureSize: z.coerce
    .number()
    .int()
    .min(64)
    .max(8_192)
    .optional()
    .describe("Optional longest edge for written textures. Leave unset to keep the source resolution."),
  acceptUnityAssetStoreEula: z
    .literal(true)
    .describe(
      "Required acknowledgement that the user owns the package, accepts the Unity Asset Store EULA for it, and has checked any Restricted Asset terms. The tool cannot check them: Asset Store terms forbid automated access.",
    ),
});

export const AssetImportUnityOutputSchema = SummarySchema;

export function summarizeUnity(report: UnityImportReport, outputDir: string): UnityImportSummary {
  return SummarySchema.parse({
    outputDir,
    reportPath: join(outputDir, "import-report.json"),
    importerVersion: report.importerVersion,
    materials: report.materials,
    counts: report.counts,
    blender: report.blender,
    licenseFiles: report.licenseFiles,
    models: report.models.map((model) => ({
      name: model.name,
      source: model.source,
      glb: model.glb,
      bytes: model.bytes,
      vertices: model.vertices,
      sizeMeters: model.sizeMeters,
      slots: model.slots.map((slot) => ({
        embedded: slot.embedded,
        binding: slot.binding,
        ...(slot.material ? { material: slot.material } : {}),
        status: slot.status,
      })),
    })),
    materialAssets: report.materialAssets.map((material) => ({
      name: material.name,
      path: material.path,
      pipeline: material.pipeline,
      status: material.status,
      shader: material.shader.path ?? material.shader.ref,
      ...(material.fallbackReason ? { fallbackReason: material.fallbackReason } : {}),
    })),
    textures: report.textures.map((texture) => ({
      name: texture.name,
      png: texture.png,
      bytes: texture.bytes,
      width: texture.width,
      height: texture.height,
    })),
    skipped: report.skipped.slice(0, 400),
    failed: report.failed.slice(0, 400),
    warnings: report.warnings.slice(0, 400),
    durationMs: report.durationMs,
  });
}

function errorResult(error: unknown) {
  const safe =
    error instanceof UnityImportError || error instanceof UnityPackageError || error instanceof ToolchainError
      ? { code: error.code, message: error.message, retryable: "retryable" in error ? error.retryable : false }
      : error instanceof z.ZodError
        ? {
            code: "UNITY_IMPORT_INVALID_INPUT",
            message: `The Unity import input is invalid: ${error.issues.map((issue) => `${issue.path.join(".") || "input"} ${issue.message}`).join("; ").slice(0, 400)}. acceptUnityAssetStoreEula must be true.`,
            retryable: false,
          }
        : {
            code: "UNITY_IMPORT_INTERNAL",
            message: "The asset MCP could not complete the Unity import.",
            retryable: false,
          };
  return { isError: true as const, content: [{ type: "text" as const, text: JSON.stringify(safe) }] };
}

export interface ImportUnityDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly log?: (message: string) => void;
  readonly importPackage?: typeof importUnityPackage;
}

export function createAssetImportUnityHandler(dependencies: ImportUnityDependencies = {}) {
  const runImport = dependencies.importPackage ?? importUnityPackage;
  return async (rawInput: z.input<typeof AssetImportUnityInputSchema>) => {
    try {
      const input = AssetImportUnityInputSchema.parse(rawInput);
      const outputDir = resolve(input.outputDir);
      const report = await runImport({
        source: resolve(input.source),
        outputDir,
        ...(input.assets ? { assets: input.assets } : {}),
        ...(input.maxTextureSize !== undefined ? { maxTextureSize: input.maxTextureSize } : {}),
        ...(dependencies.environment ? { environment: dependencies.environment } : {}),
        ...(dependencies.log ? { log: dependencies.log } : {}),
      });
      const output = summarizeUnity(report, outputDir);
      return { content: [{ type: "text" as const, text: JSON.stringify(output) }], structuredContent: output };
    } catch (error) {
      return errorResult(error);
    }
  };
}
