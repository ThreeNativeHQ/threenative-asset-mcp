import { readdir } from "node:fs/promises";
import { basename, extname } from "node:path";
import sharp from "sharp";
import { dumpEngineArg } from "../fab/routes.js";
import { dumpMaterialGraphs } from "./graph-dump.js";
import type { MaterialGraph } from "./graph-dump.js";
import {
  bakeGraph,
  emissiveOnlyEffect,
  particleDrivenBaseColor,
  graphPathClasses,
  type EmissiveEffect,
  type BakeResult,
  type GraphParameters,
  type TextureRaster,
} from "./material-graph.js";
import { parsePropsFile, type PropsFile } from "./materials.js";
import { surfaceKey, type SurfaceNormals } from "./surface-normals.js";
import type { ExternalTool } from "./toolchain.js";

/**
 * PRD-538 Phase 2b: connects the graph evaluator (`material-graph.ts`) to the importer.
 *
 * The baker is lazy. Nothing is provisioned, dumped or decoded until the importer asks for a material
 * that ended up with no base-colour texture, and the dump runs at most once per import. Every failure
 * becomes an `unavailable` outcome with the reason: a bake that cannot run never fails the import, it
 * leaves the section on the neutral fallback exactly as before.
 */

/** The part of the importer's exported-asset index the baker reads. */
export interface GraphBakeAssets {
  /** Texture object name -> PNG written by UE Viewer. */
  readonly png: ReadonlyMap<string, string>;
  /** Basenames with several physical PNG producers; a sample of one cannot name its exact pixels. */
  readonly ambiguousPng?: ReadonlySet<string> | undefined;
}

export interface GraphBakeRequest {
  /** Section (library) material name, for diagnostics. */
  readonly materialName: string;
  /** Unreal object basename; the `.uasset` and `.props.txt` lookup key. */
  readonly lookupName: string;
  readonly assets: GraphBakeAssets;
  /** Returns the `.props.txt` text for a material (or texture) name, or undefined. */
  readonly readProps: (name: string) => string | undefined;
  /**
   * Linear value `VertexColor` nodes evaluate to. The importer passes white when no mesh primitive using the
   * section carries `COLOR_0`; absent, VertexColor stays unsupported.
   */
  readonly vertexColor?: readonly [number, number, number, number] | undefined;
  /**
   * Only classify: report whether the material is an emissive-only effect and never bake. The importer probes a
   * translucent section that already has a base-colour texture, which a plain request would not look at.
   */
  readonly probe?: boolean | undefined;
  /**
   * The graph output that carries the section's cut-out, from its glTF alpha mode: `opacity` for BLEND, `opacityMask`
   * for MASK, absent for OPAQUE. The bake writes it into the colour PNG's alpha channel.
   */
  readonly alpha?: "opacity" | "opacityMask" | undefined;
  /**
   * The mesh's vertex normals in UV space, built on demand: the importer lays them out only for a graph that reads the
   * surface (a world-normal blend), so a graph that does not never pays for the raster or loses its shared bake.
   */
  readonly surface?: (() => SurfaceNormals | undefined) | undefined;
  /** The mesh's bounding-sphere radius in Unreal units, built on demand for a graph that reads `ObjectRadius`. */
  readonly objectRadius?: (() => number | undefined) | undefined;
}

export type GraphBakeOutcome = BakeResult & {
  /** Present when the material wires only Emissive: no albedo exists in the package (see `emissiveOnlyEffect`). */
  readonly effect?: EmissiveEffect;
  /**
   * Present when a bake did not succeed and the BaseColor path reads a per-particle value (see `particleDrivenBaseColor`):
   * the emitter, not the package, sets this section's colour.
   */
  readonly particle?: string;
  /**
   * Probe only: whether the BaseColor path reads VertexColor (after static switches). Absent when the graph is unknown,
   * truncated or unreadable.
   */
  readonly vertexColorOnBaseColor?: boolean;
  /** The dumped graph that was evaluated (the root `Material` of the instance chain). */
  readonly graphMaterial?: string;
  /** The parameters the evaluator saw, after nearest-wins merging over the instance chain. */
  readonly parameters?: GraphParameters;
};

export type GraphBaker = (request: GraphBakeRequest) => Promise<GraphBakeOutcome>;

export interface GraphBakerOptions {
  readonly sourceDir: string;
  readonly engine?: string | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly log?: ((message: string) => void) | undefined;
  /** Use this converter instead of provisioning the pinned one. */
  readonly modernConverter?: ExternalTool | undefined;
  /** The importer's longest embedded edge; the bake never exceeds 1024 either way. */
  readonly maxTextureSize?: number | undefined;
  /**
   * Exports one texture package that the mesh export did not carry (colour textures that only a material
   * function references) and returns the PNG path, or undefined. Tried after `assets.png`.
   */
  readonly exportTexture?: ((name: string) => Promise<string | undefined>) | undefined;
  /** Test seam; production runs the converter's `--dump-graphs` mode. */
  readonly dumpGraphs?: typeof dumpMaterialGraphs;
}

const MAX_BAKE_SIZE = 1024;
const MAX_PARENT_DEPTH = 8;
const RASTER_CACHE_BYTES = 256 * 1024 * 1024;
const BAKE_CACHE_BYTES = 256 * 1024 * 1024;
const STATIC_SWITCH_NOTE = "static switch values taken from the parent's defaults";

/**
 * The one place that decides whether a UE Viewer PNG carries sRGB-encoded colour.
 * The evaluator combines this with the sampler type of each node: only `Color` samplers decode
 * sRGB, Normal / Masks / Grayscale / LinearColor samplers read the stored bytes. So this flag only
 * has to say whether the texture's own `SRGB` property was switched off; UE Viewer writes that into
 * a texture's `.props.txt` when it exports one, and absent properties mean Unreal's default (true).
 */
function textureIsSrgb(propsText: string | undefined): boolean {
  return !(propsText !== undefined && /^\s*SRGB\s*=\s*false\b/im.test(propsText));
}

/** `Texture2D'/Game/A/T_X.T_X'`, `/Game/A/T_X.T_X` and `T_X` all name the texture `T_X`. */
function textureBasename(reference: string): string {
  const quoted = /'([^']+)'/.exec(reference)?.[1] ?? reference;
  const afterSlash = quoted.slice(quoted.lastIndexOf("/") + 1);
  return (afterSlash.includes(".") ? afterSlash.slice(afterSlash.lastIndexOf(".") + 1) : afterSlash).trim();
}

async function listUassetBasenames(root: string): Promise<Set<string>> {
  const names = new Set<string>();
  const entries = await readdir(root, { recursive: true });
  for (const entry of entries) {
    if (extname(entry).toLowerCase() === ".uasset") names.add(basename(entry, extname(entry)));
  }
  return names;
}

function mergeFirst<T>(target: Map<string, T>, key: string, value: T): void {
  const normalised = key.trim().toLowerCase();
  if (!target.has(normalised)) target.set(normalised, value);
}

/**
 * Parameters for an instance chain, nearest wins. Overrides (`TextureParameterValues`,
 * `VectorParameterValues`, `ScalarParameterValues`) of every level beat any default; defaults
 * (`Collected*`) then fill in from the instance upwards. The evaluator fills the rest from the
 * graph's own node defaults.
 */
export function chainParameters(chain: readonly PropsFile[]): GraphParameters {
  const textures = new Map<string, string>();
  const vectors = new Map<string, [number, number, number, number]>();
  const scalars = new Map<string, number>();
  const switches = new Map<string, boolean>();
  for (const props of chain) {
    for (const entry of props.switchOverrides) mergeFirst(switches, entry.name, entry.value);
    for (const entry of props.overrides) mergeFirst(textures, entry.name, entry.texture);
    for (const entry of props.vectorOverrides) mergeFirst(vectors, entry.name, [...entry.value]);
    for (const entry of props.scalarOverrides) mergeFirst(scalars, entry.name, entry.value);
  }
  for (const props of chain) {
    for (const entry of props.collected) mergeFirst(textures, entry.name, entry.texture);
    for (const entry of props.vectors) mergeFirst(vectors, entry.name, [...entry.value]);
    for (const entry of props.scalars) mergeFirst(scalars, entry.name, entry.value);
  }
  return { textures, vectors, scalars, switches };
}

function parametersKey(parameters: GraphParameters): string {
  const sorted = <T>(map: ReadonlyMap<string, T>): [string, T][] => [...map].sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([sorted(parameters.textures), sorted(parameters.vectors), sorted(parameters.scalars), sorted(parameters.switches)]);
}

function unavailable(reason: string): GraphBakeOutcome {
  return { status: "unavailable", reason };
}

/** True when the graph has a node whose value follows the surface normal (see `surface-normals.ts`). */
export function graphReadsSurface(graph: MaterialGraph): boolean {
  return graph.nodes.some(
    (node) =>
      (node.class === "FunctionCall" && /(?:^|\/)WorldAlignedBlend\./i.test(node.function ?? "") && !node.fn?.outputs.some(Boolean)) ||
      node.class === "VertexNormalWS" ||
      (node.class === "Transform" && String(node.constants.TransformSourceType ?? "TRANSFORMSOURCE_Tangent") === "TRANSFORMSOURCE_Tangent"),
  );
}

/** True when the graph reads the mesh's bounding radius (`ObjectRadius`), so a bake depends on the mesh. */
export function graphReadsObjectRadius(graph: MaterialGraph): boolean {
  return graph.nodes.some((node) => node.class === "ObjectRadius");
}

/** `/Game/A/B/Name` and `Content/A/B/Name` name one package; compare them without the mount point or case. */
function normalisedPackage(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/^(?:Game|Content)\//i, "").toLowerCase();
}

/**
 * The graph of material `name`. The dump keys the first graph of a name by that name and any later one of the same
 * name by its package path, so a plain lookup by name always lands on one arbitrary namesake. With the package the
 * instance's `Parent =` line named, the matching graph is taken wherever it is keyed.
 */
export function graphNamed(graphs: ReadonlyMap<string, MaterialGraph>, name: string, packagePath: string | undefined): MaterialGraph | undefined {
  const byName = graphs.get(name);
  if (packagePath === undefined) return byName;
  const wanted = normalisedPackage(packagePath);
  if (byName !== undefined && normalisedPackage(byName.package) === wanted) return byName;
  for (const candidate of graphs.values()) {
    if (candidate.material === name && normalisedPackage(candidate.package) === wanted) return candidate;
  }
  return byName;
}

/** Returns undefined when graph baking is switched off by the caller (the importer decides that). */
export function createGraphBaker(options: GraphBakerOptions): GraphBaker | undefined {
  const dump = options.dumpGraphs ?? dumpMaterialGraphs;
  const environment = options.environment ?? process.env;
  const size = Math.max(1, Math.min(options.maxTextureSize ?? MAX_BAKE_SIZE, MAX_BAKE_SIZE));

  let packages: Promise<Set<string>> | undefined;
  let graphs: Promise<{ readonly graphs: ReadonlyMap<string, MaterialGraph>; readonly invalid: ReadonlyMap<string, string> } | { readonly error: string }> | undefined;

  const sourcePackages = (): Promise<Set<string>> => (packages ??= listUassetBasenames(options.sourceDir).catch(() => new Set<string>()));
  // With THREENATIVE_TOOLCHAIN_AUTOINSTALL=0 the dump resolves an installed converter or throws; either
  // way a failure is memoised here as `unavailable` and never reaches the importer.
  const dumpedGraphs = (): NonNullable<typeof graphs> =>
    (graphs ??= (async () => {
      options.log?.(
        "Some sections have no base-colour texture; reading the pack's material graphs with CUE4Parse to bake them (the converter and its .NET SDK are installed once on first use; set graphBake:false or THREENATIVE_TOOLCHAIN_AUTOINSTALL=0 to skip).",
      );
      try {
        const dumped = await dump(options.sourceDir, {
          // The importer carries `UE_4.18`; the converter wants `4.18` and refuses anything else.
          ...(options.engine && dumpEngineArg(options.engine) ? { engine: dumpEngineArg(options.engine)! } : {}),
          environment,
          ...(options.log ? { log: options.log } : {}),
          ...(options.modernConverter ? { converterPath: options.modernConverter.path } : {}),
        });
        return { graphs: dumped, invalid: dumped.invalid ?? new Map<string, string>() };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    })());

  // Decoded textures, shared across every section of the import.
  const rasters = new Map<string, Promise<TextureRaster | undefined>>();
  const rasterSizes = new Map<string, number>();
  let rasterBytes = 0;
  const decode = (path: string, srgb: boolean): Promise<TextureRaster | undefined> => {
    const key = `${path}|${srgb}`;
    const known = rasters.get(key);
    if (known) return known;
    const pending = (async (): Promise<TextureRaster | undefined> => {
      try {
        const { data, info } = await sharp(path)
          .toColourspace("srgb")
          .ensureAlpha()
          .raw({ depth: "uchar" })
          .toBuffer({ resolveWithObject: true });
        if (info.channels !== 4) return undefined;
        rasterSizes.set(key, data.length);
        rasterBytes += data.length;
        return { width: info.width, height: info.height, rgba: data, srgb };
      } catch {
        return undefined;
      }
    })();
    rasters.set(key, pending);
    void pending.then(() => {
      if (rasterBytes <= RASTER_CACHE_BYTES) return;
      // Over budget: forget everything decoded except the texture that just finished.
      for (const other of [...rasters.keys()]) {
        if (other !== key) rasters.delete(other);
      }
      rasterBytes = rasterSizes.get(key) ?? 0;
      for (const other of [...rasterSizes.keys()]) {
        if (other !== key) rasterSizes.delete(other);
      }
    });
    return pending;
  };

  // Finished bakes, per exported-asset index (the same texture name can mean different pixels in another one).
  const bakes = new WeakMap<object, Map<string, Promise<GraphBakeOutcome>>>();
  let bakeBytes = 0;

  const baker: GraphBaker = async (request) => {
    const known = await sourcePackages();
    if (!known.has(request.lookupName)) return unavailable("no source package");

    const dumped = await dumpedGraphs();
    if ("error" in dumped) return unavailable(`graph dump failed: ${dumped.error}`);
    const byName = dumped.graphs;

    const chain: PropsFile[] = [];
    let graph: MaterialGraph | undefined;
    const visited = new Set<string>();
    // The package the previous link's `Parent =` line named: when two packages hold a material of one name, it picks the graph.
    let currentPackage: string | undefined;
    for (let current: string | undefined = request.lookupName; current && chain.length < MAX_PARENT_DEPTH && !visited.has(current); ) {
      visited.add(current);
      const text = request.readProps(current);
      if (text) chain.push(parsePropsFile(text));
      graph = graphNamed(byName, current, currentPackage);
      if (graph) break;
      const unreadable = dumped.invalid.get(current);
      if (unreadable !== undefined) return unavailable(`graph for ${current} unreadable (${unreadable})`);
      current = text ? chain[chain.length - 1]!.parent : undefined;
      currentPackage = text ? chain[chain.length - 1]!.parentPackage : undefined;
    }
    if (!graph) return unavailable(`no dumped graph for ${request.lookupName} or its parents`);

    const effect = emissiveOnlyEffect(graph);
    if (effect) return { status: "unavailable", reason: effect.reason, effect, graphMaterial: graph.material };
    const parameters = chainParameters(chain);
    if (request.probe) {
      // Unreal applies a mesh's vertex colours only where the graph reads VertexColor; glTF multiplies COLOR_0 into
      // every base colour. The importer drops COLOR_0 when the BaseColor path does not read it.
      const readable = !graph.truncated && !graph.error;
      return {
        ...unavailable(`${graph.material} has a BaseColor output`),
        ...(readable ? { vertexColorOnBaseColor: graphPathClasses(graph, "baseColor", parameters).includes("VertexColor") } : {}),
      };
    }

    const surface = request.surface && graphReadsSurface(graph) ? request.surface() : undefined;
    const objectRadius = request.objectRadius && graphReadsObjectRadius(graph) ? request.objectRadius() : undefined;
    const key = `${graph.package}|${parametersKey(parameters)}|vc:${request.vertexColor?.join(",") ?? "none"}|alpha:${request.alpha ?? "none"}|surface:${surface ? surfaceKey(surface) : "none"}|radius:${objectRadius ?? "none"}`;
    let perAssets = bakes.get(request.assets);
    if (!perAssets) {
      perAssets = new Map();
      bakes.set(request.assets, perAssets);
    }
    const memo = perAssets.get(key);
    if (memo) return memo;

    const pending = (async (): Promise<GraphBakeOutcome> => {
      const ambiguous: string[] = [];
      const loaded = new Set<string>();
      const result = await bakeGraph({
        graph: graph!,
        output: "baseColor",
        parameters,
        size,
        allowUvSetFallback: true,
        // Unreal feeds white to ParticleColor outside a particle emitter.
        particleColor: [1, 1, 1, 1],
        ...(request.alpha ? { alpha: request.alpha } : {}),
        ...(request.vertexColor ? { vertexColor: request.vertexColor } : {}),
        ...(surface ? { surface } : {}),
        ...(objectRadius !== undefined ? { objectRadius } : {}),
        loadTexture: async (reference) => {
          const name = textureBasename(reference);
          const path = request.assets.png.get(name) ?? (await options.exportTexture?.(name));
          if (!path) return undefined;
          if (request.assets.ambiguousPng?.has(name) && !loaded.has(name)) ambiguous.push(name);
          loaded.add(name);
          return decode(path, textureIsSrgb(request.readProps(name)));
        },
      });
      if (result.status !== "baked") {
        const particle = particleDrivenBaseColor(graph!);
        return { ...result, graphMaterial: graph!.material, parameters, ...(particle ? { particle } : {}) };
      }
      const approximations = new Set(result.approximations);
      for (const name of ambiguous) approximations.add(`texture ${name}: ambiguous exported PNG basename; exact source pixels cannot be selected`);
      const classes = graphPathClasses(graph!, "baseColor", parameters);
      if (classes.includes("StaticSwitchParameter") || classes.includes("StaticBoolParameter")) approximations.add(STATIC_SWITCH_NOTE);
      const baked: GraphBakeOutcome = {
        ...result,
        approximations: [...approximations].sort(),
        confidence: approximations.size === 0 ? "exact" : "heuristic",
        graphMaterial: graph!.material,
        parameters,
      };
      bakeBytes += result.png.length;
      return baked;
    })();
    perAssets.set(key, pending);
    void pending.then(() => {
      if (bakeBytes <= BAKE_CACHE_BYTES) return;
      // Over budget: keep only the bake that just finished.
      perAssets!.clear();
      perAssets!.set(key, pending);
      bakeBytes = 0;
    });
    return pending;
  };
  return baker;
}
