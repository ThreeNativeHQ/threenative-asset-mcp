import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import { type EngineContentConfig } from "./engine-content.js";
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
    /** Set only on a body read from the explicitly configured engine content: the `X.Y` content and the `/Engine/` package. */
    engine: z.object({ version: z.string().min(1), package: z.string().min(1) }).strict().optional(),
  })
  .strict();

export const graphNodeSchema = z
  .object({
    id: z.string().min(1),
    /** Unreal expression class without the `MaterialExpression` prefix, or `FunctionCall` for a function call. */
    class: z.string().min(1),
    // An `Unresolved` node (an expression that failed to load) is emitted with only id, class and error.
    inputs: z.record(z.string(), graphInputSchema.nullable()).default({}),
    /** A UV set property (`CoordinateIndex`, `ConstCoordinate`) the dump found but could not read is `<name>Error`, never absent: absent is UV0. */
    constants: z.record(z.string(), constantSchema).default({}),
    parameter: z.object({ name: z.string(), group: z.string() }).strict().optional(),
    // GraphValue() also yields a string for a name-valued DefaultValue.
    default: z.union([z.number(), z.boolean(), z.string(), z.array(z.number())]).nullable().optional(),
    texture: z.string().nullable().optional(),
    /** `CollectionParameter`: the MaterialParameterCollection it reads (its default is in `default`). */
    collection: z.string().nullable().optional(),
    samplerType: z.string().optional(),
    coordinates: graphInputSchema.nullable().optional(),
    tiling: z.tuple([z.number(), z.number()]).optional(),
    channelMask: vec4Int.optional(),
    function: z.string().nullable().optional(),
    switchValue: z.boolean().optional(),
    fn: functionSchema.optional(),
    outputNames: z.array(z.string()).optional(),
    /**
     * `SetMaterialAttributes`: attribute GUIDs, pin `Inputs[i]` carries `attributeTypes[i-1]` (`Inputs[0]` is the incoming attributes).
     * `GetMaterialAttributes`: attribute GUIDs, output `i` is `attributeTypes[i]`.
     */
    attributeTypes: z.array(z.string()).optional(),
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

/** The suffix of an instance record beside the graphs (converter 74). Its own file, so the graph reader never sees it. */
const INSTANCE_SUFFIX = ".instance.json";
const MAX_PACKAGE = 512;
const MAX_OBJECT = 256;
/** An instance's own overrides as `.props.txt` blocks, bounded so one record cannot take unbounded memory. */
const MAX_INSTANCE_PROPS = 512 * 1024;

/**
 * One material instance the converter loaded, by its qualified identity. `props` holds only its own overrides (the Parent line,
 * the scalar, vector and static switch blocks, its own texture overrides by qualified package and object) and is present only when
 * `complete`; a refused instance carries `refusal` instead. A flattened collection of the parent's defaults is never recorded.
 */
export const materialInstanceSchema = z
  .object({
    format: z.literal(1),
    kind: z.literal("materialInstance"),
    /** The instance's own package, as the graphs name packages: `/Game/...` for a pack package. */
    package: z.string().min(1).max(MAX_PACKAGE),
    object: z.string().min(1).max(MAX_OBJECT),
    /** The qualified parent, or null when the instance has none. */
    parent: z.object({ package: z.string().min(1).max(MAX_PACKAGE), object: z.string().min(1).max(MAX_OBJECT) }).strict().nullable(),
    complete: z.boolean(),
    props: z.string().max(MAX_INSTANCE_PROPS).nullable(),
    refusal: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.complete && (record.props === null || record.refusal !== null))
      context.addIssue({ code: "custom", message: "a complete record has props and no refusal", path: ["complete"] });
    if (!record.complete && (record.props !== null || record.refusal === null))
      context.addIssue({ code: "custom", message: "a refused record has a refusal and no props", path: ["complete"] });
  });

export type MaterialInstanceRecord = z.infer<typeof materialInstanceSchema>;

/**
 * A package in the form the graphs, the `Parent =` lines and the records share. It keeps its mount: `/Game/A/B` and `Content/A/B`
 * name the pack's `game` mount, `/Engine/A/B` names `engine`, and a path with no mount names `unmounted`. So `/Engine/A/B` is never
 * the pack's `/Game/Engine/A/B`, and an unmounted path never equals a mounted one. Lower case: the names compare case-insensitively.
 */
export function canonicalPackage(path: string): string {
  const rooted = path.replace(/\\/g, "/").replace(/^\/+/, "");
  const mounted = /^(Game|Content|Engine)\/(.*)$/i.exec(rooted);
  if (mounted === null) return `unmounted:${rooted.toLowerCase()}`;
  const mount = mounted[1]!.toLowerCase() === "engine" ? "engine" : "game";
  return `${mount}:${mounted[2]!.toLowerCase()}`;
}

/** The exact identity an instance is looked up by: its package and object name. Two records with one key claim one identity. */
export function materialInstanceKey(packagePath: string, object: string): string {
  return `${canonicalPackage(packagePath)}|${object.toLowerCase()}`;
}

/** Why a parsed record may not be used, or undefined. Its package and parent must sit in the pack's `/Game` mount, and its Parent line must name its parent exactly. */
function instanceProblem(record: MaterialInstanceRecord): string | undefined {
  if (!/^\/Game\//i.test(record.package)) return `package ${record.package} is outside the /Game mount`;
  if (record.parent !== null && !/^\/Game\//i.test(record.parent.package)) return `parent ${record.parent.package} is outside the /Game mount`;
  if (record.refusal !== null) return `refused by the converter: ${record.refusal}`;
  const named = [...(record.props ?? "").matchAll(/^Parent\s*=\s*\w+'([^']*)'/gm)].map((match) => match[1]);
  const expected = record.parent === null ? undefined : `${record.parent.package}.${record.parent.object}`;
  if (named.length !== (expected === undefined ? 0 : 1) || (expected !== undefined && named[0] !== expected))
    return `its Parent line does not name its parent ${expected ?? "(none)"}`;
  return undefined;
}

/**
 * The identity a record declares (a graph declares it in `material`), even one the schema rejects, so a duplicate is caught whatever
 * else is wrong with it.
 */
function declaredIdentity(parsed: unknown, objectField: "object" | "material" = "object"): { readonly key: string; readonly label: string } | undefined {
  const declared = parsed as Record<string, unknown> | null;
  const packagePath = declared?.package;
  const object = declared?.[objectField];
  if (typeof packagePath !== "string" || typeof object !== "string" || !packagePath || !object) return undefined;
  return { key: materialInstanceKey(packagePath, object), label: `${packagePath}.${object}` };
}

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
export type MaterialGraphDump = Map<string, MaterialGraph> & {
  readonly invalid?: ReadonlyMap<string, string>;
  /** Usable instance records by `materialInstanceKey`: complete, in the /Game mount, and the only record of their identity. */
  readonly instances?: ReadonlyMap<string, MaterialInstanceRecord>;
  /**
   * Why an instance cannot be used, by `materialInstanceKey` (the file stem when the record names no identity). A duplicate
   * identity is one entry with one reason; a converter refusal carries the converter's text.
   */
  readonly invalidInstances?: ReadonlyMap<string, string>;
  /**
   * Why a graph identity is refused, by `materialInstanceKey`: two or more graph files claim it (case and Content/ spellings are one
   * identity). Every claimant is refused, so neither the map nor a lookup can reach any of them.
   */
  readonly duplicateGraphs?: ReadonlyMap<string, string>;
};

export interface DumpMaterialGraphsOptions {
  engine?: string;
  filter?: string;
  environment?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
  /** Use this converter instead of provisioning the pinned one. */
  converterPath?: string;
  /** Engine functions a pack's material functions name are read from this explicitly configured content root. */
  engineContent?: EngineContentConfig;
}

/**
 * Runs the converter's `--dump-graphs` mode and returns every `UMaterial` graph, keyed by material name
 * (by package path when two packages hold a material of the same name). A graph file that cannot be read or does
 * not match the schema is skipped and listed in `invalid`; it never fails the dump. The instance records the same
 * run wrote (`<name>.instance.json`) are read beside the graphs into `instances` and `invalidInstances`, by exact
 * qualified identity, under the same rule: a bad record is listed, never fatal. A graph identity that two or more files
 * claim is refused whole, with its reason in `duplicateGraphs`, so no later file overwrites an earlier one in the map.
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
    if (options.engineContent) {
      args.push("--engine-content", options.engineContent.dir, "--engine-content-version", options.engineContent.version);
    }
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
    const duplicateGraphs = new Map<string, string>();
    Object.defineProperty(graphs, "duplicateGraphs", { value: duplicateGraphs, enumerable: false });
    const instances = new Map<string, MaterialInstanceRecord>();
    const invalidInstances = new Map<string, string>();
    Object.defineProperty(graphs, "instances", { value: instances, enumerable: false });
    Object.defineProperty(graphs, "invalidInstances", { value: invalidInstances, enumerable: false });
    const entries = await readdir(scratch);
    const files = entries.filter((name) => name.endsWith(".graph.json")).sort();
    // Every file's declared identity is a claim, usable or not; the usable graphs are inserted only once every claim is known.
    const claims = new Map<string, string[]>();
    const usable: MaterialGraph[] = [];
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
      const claim = declaredIdentity(parsed, "material");
      if (claim) claims.set(claim.key, [...(claims.get(claim.key) ?? []), claim.label]);
      const checked = materialGraphSchema.safeParse(parsed);
      if (!checked.success) {
        const declared = (parsed as { material?: unknown } | null)?.material;
        const key = typeof declared === "string" && declared ? declared : name.slice(0, -".graph.json".length);
        if (!invalid.has(key)) invalid.set(key, describeGraphIssue(checked.error));
        continue;
      }
      usable.push(checked.data);
    }
    // Every claimed identity is settled before any graph is inserted. The map keys a later graph by its package, so an identity two files
    // claim would otherwise be overwritten silently. A refused identity takes no name key either: a name-only lookup finds usable graphs only.
    for (const [key, labels] of claims) {
      if (labels.length > 1) duplicateGraphs.set(key, clip(`duplicate identity: ${labels.length} graph files claim ${[...new Set(labels)].join(" and ")}`));
    }
    for (const graph of usable) {
      if (duplicateGraphs.has(materialInstanceKey(graph.package, graph.material))) continue;
      graphs.set(graphs.has(graph.material) ? graph.package : graph.material, graph);
    }
    await readInstanceRecords(scratch, entries, instances, invalidInstances);
    return graphs;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Reads every instance record in `names` into `instances` (usable) or `invalid` (one reason per identity, or per file stem when
 * the record names no identity). A record is usable only when it reads, parses, passes the schema and `instanceProblem`, and is the
 * only record that claims its identity: two that claim one are both refused, under one reason.
 */
async function readInstanceRecords(
  scratch: string,
  names: readonly string[],
  instances: Map<string, MaterialInstanceRecord>,
  invalid: Map<string, string>,
): Promise<void> {
  type Entry = { readonly stem: string; readonly key?: string; readonly label?: string; readonly record?: MaterialInstanceRecord; readonly reason?: string };
  const entries: Entry[] = [];
  for (const name of names.filter((entry) => entry.endsWith(INSTANCE_SUFFIX)).sort()) {
    const stem = name.slice(0, -INSTANCE_SUFFIX.length);
    let text: string;
    try {
      text = await readFile(join(scratch, name), "utf8");
    } catch (error) {
      entries.push({ stem, reason: `unreadable: ${clip(error instanceof Error ? error.message : String(error))}` });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      entries.push({ stem, reason: `not valid JSON: ${clip(error instanceof Error ? error.message : String(error))}` });
      continue;
    }
    const declared = declaredIdentity(parsed);
    const checked = materialInstanceSchema.safeParse(parsed);
    if (!checked.success) {
      entries.push({ stem, ...declared, reason: `unexpected shape: ${describeGraphIssue(checked.error)}` });
      continue;
    }
    const record = checked.data;
    const problem = instanceProblem(record);
    const key = materialInstanceKey(record.package, record.object);
    const label = `${record.package}.${record.object}`;
    entries.push(problem === undefined ? { stem, key, label, record } : { stem, key, label, reason: problem });
  }
  const claims = new Map<string, number>();
  for (const entry of entries) if (entry.key !== undefined) claims.set(entry.key, (claims.get(entry.key) ?? 0) + 1);
  for (const entry of entries) {
    if (entry.key === undefined || entry.label === undefined) {
      invalid.set(entry.stem, clip(entry.reason ?? "unexpected shape"));
      continue;
    }
    const count = claims.get(entry.key) ?? 1;
    if (count > 1) invalid.set(entry.key, clip(`duplicate identity: ${count} records claim ${entry.label}`));
    else if (entry.record !== undefined) instances.set(entry.key, entry.record);
    else invalid.set(entry.key, clip(entry.reason ?? "unexpected shape"));
  }
}
