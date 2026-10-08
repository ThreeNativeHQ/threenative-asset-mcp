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
    // The converter copies the package's OutputIndex verbatim, so do not reject an out-of-range one here;
    // the baker treats a missing output as an unsupported node.
    output: z.number().int(),
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
    // An `Unresolved` node (an expression that failed to load) is emitted with only id, class and error.
    inputs: z.record(z.string(), graphInputSchema.nullable()).default({}),
    constants: z.record(z.string(), constantSchema).default({}),
    parameter: z.object({ name: z.string(), group: z.string() }).strict().optional(),
    // GraphValue() also yields a string for a name-valued DefaultValue.
    default: z.union([z.number(), z.boolean(), z.string(), z.array(z.number())]).nullable().optional(),
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

const MAX_REASON = 200;

function clip(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= MAX_REASON ? oneLine : `${oneLine.slice(0, MAX_REASON - 3)}...`;
}

function pathText(path: readonly PropertyKey[]): string {
  return path.reduce<string>((text, part) => (typeof part === "number" ? `${text}[${part}]` : text ? `${text}.${String(part)}` : String(part)), "");
}

/** `nodes[12].inputs.A.output: expected number, received null`: the first issue only, one line, at most 200 characters. */
export function describeGraphIssue(error: z.ZodError): string {
  let issue: z.core.$ZodIssue | undefined = error.issues[0];
  // A union reports "Invalid input" at the union; the first alternative's issue says what is actually wrong.
  while (issue && issue.code === "invalid_union" && issue.errors[0]?.[0]) issue = issue.errors[0][0];
  if (!issue) return "unexpected shape";
  const message = issue.message.replace(/^Invalid input: /, "");
  const where = pathText(issue.path);
  return clip(where ? `${where}: ${message}` : message);
}

/** Reads and strictly validates one `<Material>.graph.json`. */
export async function readMaterialGraph(file: string): Promise<MaterialGraph> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new ToolchainError(
      "UNREAL_TOOL_FAILED",
      `Material graph ${basename(file)} is not valid JSON: ${clip(error instanceof Error ? error.message : String(error))}`,
    );
  }
  const checked = materialGraphSchema.safeParse(parsed);
  if (!checked.success) {
    throw new ToolchainError(
      "UNREAL_TOOL_FAILED",
      `Material graph ${basename(file)} has an unexpected shape: ${describeGraphIssue(checked.error)}`,
    );
  }
  return checked.data;
}

/**
 * The usable graphs by material name. `invalid` maps the material (or the file stem when its name is not
 * readable) of every graph file that was skipped to a one-line reason. It is a non-enumerable extra property so
 * a plain `Map<string, MaterialGraph>` (tests, other callers) stays a valid value of this type.
 */
export type MaterialGraphDump = Map<string, MaterialGraph> & { readonly invalid?: ReadonlyMap<string, string> };

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
 * (by package path when two packages hold a material of the same name). A graph file that cannot be read or does
 * not match the schema is skipped and listed in `invalid`; it never fails the dump.
 */
export async function dumpMaterialGraphs(
  sourceDir: string,
  options: DumpMaterialGraphsOptions = {},
): Promise<MaterialGraphDump> {
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
    const invalid = new Map<string, string>();
    Object.defineProperty(graphs, "invalid", { value: invalid, enumerable: false });
    const files = (await readdir(scratch)).filter((name) => name.endsWith(".graph.json")).sort();
    for (const name of files) {
      const file = join(scratch, name);
      let text: string;
      try {
        text = await readFile(file, "utf8");
      } catch (error) {
        invalid.set(name.slice(0, -".graph.json".length), `unreadable: ${clip(error instanceof Error ? error.message : String(error))}`);
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        invalid.set(name.slice(0, -".graph.json".length), `not valid JSON: ${clip(error instanceof Error ? error.message : String(error))}`);
        continue;
      }
      const checked = materialGraphSchema.safeParse(parsed);
      if (!checked.success) {
        const declared = (parsed as { material?: unknown } | null)?.material;
        const key = typeof declared === "string" && declared ? declared : name.slice(0, -".graph.json".length);
        if (!invalid.has(key)) invalid.set(key, describeGraphIssue(checked.error));
        continue;
      }
      const graph = checked.data;
      graphs.set(graphs.has(graph.material) ? graph.package : graph.material, graph);
    }
    return graphs;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
