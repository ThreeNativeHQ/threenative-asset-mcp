import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import { ensureModernConverter } from "./provision.js";
import { ToolchainError, runBounded } from "./toolchain.js";

const channel = z.number().int();
const vec4Int = z.tuple([channel, channel, channel, channel]);

/** One wire: the producing node, which of its outputs, and an optional RGBA channel mask. */
export const graphInputSchema = z
  .object({
    node: z.string().min(1),
    output: z.number().int().min(0),
    mask: vec4Int.nullable(),
  })
  .strict();

const constantSchema = z.union([z.number(), z.boolean(), z.string(), z.array(z.number())]);

const functionSchema = z
  .object({
    /** Call input name -> id of the outer node that feeds it (null when unwired). */
    inputs: z.record(z.string(), z.string().nullable()),
    /** Inner node id that feeds each function output, in output-index order (null when unreadable). */
    outputs: z.array(z.string().nullable()),
    /** First readable entry of `outputs`. */
    output: z.string().nullable(),
    outputNames: z.array(z.string()).optional(),
  })
  .strict();

export const graphNodeSchema = z
  .object({
    id: z.string().min(1),
    /** Unreal expression class without the `MaterialExpression` prefix, or `FunctionCall` for a function call. */
    class: z.string().min(1),
    inputs: z.record(z.string(), graphInputSchema.nullable()),
    constants: z.record(z.string(), constantSchema),
    parameter: z.object({ name: z.string(), group: z.string() }).strict().optional(),
    default: z.union([z.number(), z.boolean(), z.array(z.number())]).nullable().optional(),
    texture: z.string().nullable().optional(),
    samplerType: z.string().optional(),
    coordinates: graphInputSchema.nullable().optional(),
    tiling: z.tuple([z.number(), z.number()]).optional(),
    channelMask: vec4Int.optional(),
    function: z.string().nullable().optional(),
    switchValue: z.boolean().optional(),
    fn: functionSchema.optional(),
    outputNames: z.array(z.string()).optional(),
    error: z.string().optional(),
  })
  .strict();

const outputPin = graphInputSchema.nullable();

export const materialGraphSchema = z
  .object({
    format: z.literal(1),
    material: z.string().min(1),
    package: z.string(),
    truncated: z.boolean(),
    nodeCount: z.number().int().min(0),
    outputs: z
      .object({
        baseColor: outputPin,
        roughness: outputPin,
        metallic: outputPin,
        emissive: outputPin,
        opacity: outputPin,
        opacityMask: outputPin,
        normal: outputPin,
        materialAttributes: outputPin,
      })
      .strict(),
    /** Constants of unconnected material outputs; `<output>Error` keys explain an output that could not be read. */
    outputConstants: z.record(z.string(), constantSchema).default({}),
    nodes: z.array(graphNodeSchema),
    error: z.string().optional(),
  })
  .strict();

export type MaterialGraph = z.infer<typeof materialGraphSchema>;
export type GraphNode = z.infer<typeof graphNodeSchema>;
export type GraphInput = z.infer<typeof graphInputSchema>;

/** Reads and strictly validates one `<Material>.graph.json`. */
export async function readMaterialGraph(file: string): Promise<MaterialGraph> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new ToolchainError(
      "UNREAL_TOOL_FAILED",
      `Material graph ${basename(file)} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const checked = materialGraphSchema.safeParse(parsed);
  if (!checked.success) {
    throw new ToolchainError(
      "UNREAL_TOOL_FAILED",
      `Material graph ${basename(file)} has an unexpected shape: ${checked.error.message.slice(0, 1000)}`,
    );
  }
  return checked.data;
}

export interface DumpMaterialGraphsOptions {
  engine?: string;
  filter?: string;
  environment?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  /** Use this converter instead of provisioning the pinned one. */
  converterPath?: string;
}

/**
 * Runs the converter's `--dump-graphs` mode and returns every `UMaterial` graph, keyed by material name
 * (by package path when two packages hold a material of the same name).
 */
export async function dumpMaterialGraphs(
  sourceDir: string,
  options: DumpMaterialGraphsOptions = {},
): Promise<Map<string, MaterialGraph>> {
  const executable =
    options.converterPath ?? (await ensureModernConverter(options.environment, options.log)).path;
  const scratch = await mkdtemp(join(tmpdir(), "tn-graph-dump-"));
  try {
    const args = [sourceDir, "--dump-graphs", scratch];
    if (options.engine) args.push("--engine", options.engine);
    if (options.filter) args.push("--filter", options.filter);
    const run = await runBounded(executable, args, {
      timeoutMs: 20 * 60_000,
      ...(options.environment ? { environment: options.environment } : {}),
    });
    if (run.code !== 0) {
      throw new ToolchainError(
        "UNREAL_TOOL_FAILED",
        `Graph dump failed (exit ${run.code}): ${(run.stderr || run.stdout).trim().slice(-2000)}`,
      );
    }
    const graphs = new Map<string, MaterialGraph>();
    const files = (await readdir(scratch)).filter((name) => name.endsWith(".graph.json")).sort();
    for (const name of files) {
      const graph = await readMaterialGraph(join(scratch, name));
      graphs.set(graphs.has(graph.material) ? graph.package : graph.material, graph);
    }
    return graphs;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
