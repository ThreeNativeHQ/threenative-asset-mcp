import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ensureModernConverter } from "./provision.js";
import { ToolchainError, runBounded } from "./toolchain.js";

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const vec4 = z.tuple([z.number(), z.number(), z.number(), z.number()]);

const slotSchema = z.object({ name: z.string(), material: z.string().nullable().optional() });
const boundsSchema = z.object({
  origin: vec3,
  boxExtent: vec3,
  sphereRadius: z.number(),
  property: z.string(),
});
const textureParameterSchema = z.object({ name: z.string(), texture: z.string().nullable().optional() });
const vectorParameterSchema = z.object({ name: z.string(), value: vec4 });
const scalarParameterSchema = z.object({ name: z.string(), value: z.number() });

export const dumpExportSchema = z.object({
  name: z.string(),
  class: z.string(),
  error: z.string().optional(),
  slots: z.array(slotSchema).optional(),
  bounds: boundsSchema.nullable().optional(),
  parent: z.string().nullable().optional(),
  textureParameters: z.array(textureParameterSchema).optional(),
  vectorParameters: z.array(vectorParameterSchema).optional(),
  scalarParameters: z.array(scalarParameterSchema).optional(),
  textures: z.array(z.string()).optional(),
  constantColors: z.number().optional(),
});

export const dumpPackageSchema = z.object({
  path: z.string(),
  error: z.string().optional(),
  importedTextures: z.array(z.string()).optional(),
  exports: z.array(dumpExportSchema).optional(),
});

export const propertyDumpSchema = z.object({
  format: z.literal(1),
  game: z.string(),
  packages: z.array(dumpPackageSchema),
});

export type PropertyDump = z.infer<typeof propertyDumpSchema>;
export type PropertyDumpPackage = z.infer<typeof dumpPackageSchema>;
export type PropertyDumpExport = z.infer<typeof dumpExportSchema>;

export interface DumpUnrealPropertiesOptions {
  engine?: string;
  filter?: string;
  environment?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  /** Use this converter instead of provisioning the pinned one. */
  converterPath?: string;
}

/** Runs the converter's `--dump-properties` mode and returns its validated JSON. */
export async function dumpUnrealProperties(
  sourceDir: string,
  options: DumpUnrealPropertiesOptions = {},
): Promise<PropertyDump> {
  const executable =
    options.converterPath ?? (await ensureModernConverter(options.environment, options.log)).path;
  const scratch = await mkdtemp(join(tmpdir(), "tn-property-dump-"));
  try {
    const out = join(scratch, "dump.json");
    const args = [sourceDir, "--dump-properties", out];
    if (options.engine) args.push("--engine", options.engine);
    if (options.filter) args.push("--filter", options.filter);
    const run = await runBounded(executable, args, {
      timeoutMs: 20 * 60_000,
      ...(options.environment ? { environment: options.environment } : {}),
    });
    if (run.code !== 0) {
      throw new ToolchainError(
        "UNREAL_TOOL_FAILED",
        `Property dump failed (exit ${run.code}): ${(run.stderr || run.stdout).trim().slice(-2000)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(out, "utf8"));
    } catch (error) {
      throw new ToolchainError(
        "UNREAL_TOOL_FAILED",
        `Property dump output is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const checked = propertyDumpSchema.safeParse(parsed);
    if (!checked.success) {
      throw new ToolchainError(
        "UNREAL_TOOL_FAILED",
        `Property dump output has an unexpected shape: ${checked.error.message.slice(0, 1000)}`,
      );
    }
    return checked.data;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
