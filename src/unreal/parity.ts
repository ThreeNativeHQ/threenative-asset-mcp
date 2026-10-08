/**
 * Pure structural parity scorer (PRD-537). Compares the package's own tagged properties, read by
 * CUE4Parse (`PropertyDump`), with what the importer reported (`ImportReport`). No I/O.
 */
import type { ImportedMaterialSection, ImportedModel, ImportReport } from "./importer.js";
import { isWorldPartitionExternalPackage } from "./importer.js";
import type { PropertyDump } from "./property-dump.js";

/** Every list in a score is capped at this many entries; a `…Total` count sits beside it. */
export const PARITY_LIST_CAP = 50;
const NEUTRAL_BASE_COLOR = [0.8, 0.8, 0.8, 1] as const;
const COLOUR_PASS_SHARE = 0.9;
const MAX_PARENT_DEPTH = 16;

type DumpExport = NonNullable<PropertyDump["packages"][number]["exports"]>[number];
type Vec = readonly number[];

export interface MissingMesh {
  readonly package: string;
  readonly reason?: string;
}
export type ShapeViolation =
  | { readonly kind: "slot-count"; readonly model: string; readonly expected: number; readonly actual: number }
  | { readonly kind: "bounds-axis"; readonly model: string; readonly expected: Vec; readonly actual: Vec }
  | { readonly kind: "bounds-size"; readonly model: string; readonly expected: Vec; readonly actual: Vec };
export interface IdentityViolation {
  readonly model: string;
  readonly section: string;
  readonly texture: string;
  readonly kind: "overridden-parent-default" | "foreign";
}
/** What the PRD-538 graph bake did for a section: `none` when no bake was attempted. */
export type GraphOutcome = "baked" | "unsupported" | "unavailable" | "none";
export interface ColourMiss {
  readonly model: string;
  readonly section: string;
  readonly graphStatus: GraphOutcome;
  /** The node classes that stopped the bake, when `graphStatus` is `unsupported`. */
  readonly unsupportedNodes?: readonly string[];
}
/**
 * Where the sections that expect colour ended up. `bakedAway` sections are coloured because the
 * graph bake produced a colour (they would be misses without it); every other key counts misses.
 */
export interface MissAttribution {
  readonly bakedAway: number;
  /** A bake succeeded but the colour it produced is still neutral. */
  readonly bakedStillGrey: number;
  readonly unsupportedNode: number;
  readonly unavailable: number;
  readonly noGraph: number;
}
export interface PackScore {
  readonly status: "pass" | "fail" | "unverified";
  readonly reasons: readonly string[];
  readonly coverage: {
    readonly ok: boolean;
    readonly expected: number;
    readonly exported: number;
    readonly missing: readonly MissingMesh[];
    readonly missingTotal: number;
    /** World Partition external actor/object packages with mesh-class exports that were left out of `expected` (level data, not meshes). */
    readonly externalActorPackages: number;
  };
  readonly shape: {
    readonly ok: boolean;
    readonly checked: number;
    readonly unmatchedModels: number;
    /**
     * Models whose source mesh could not be read (export or package `error`, or no slots): S2 and
     * S3 cannot judge them, so they are never counted as violations and never as a pass.
     */
    readonly unverifiedModels: number;
    readonly unusedSlots: number;
    readonly boundsUnverified: number;
    /** Meshes whose size is within the tolerance but more than 1 % off the authored bounds. */
    readonly boundsDrift: number;
    readonly violations: readonly ShapeViolation[];
    readonly violationsTotal: number;
    /** Uncapped violation count per kind; `violations` is capped, this is not. */
    readonly byKind: Readonly<Record<string, number>>;
  };
  readonly identity: {
    readonly ok: boolean;
    readonly sections: number;
    readonly verified: number;
    readonly unverified: number;
    readonly violations: readonly IdentityViolation[];
    readonly violationsTotal: number;
    /** Uncapped violation count per kind; `violations` is capped, this is not. */
    readonly byKind: Readonly<Record<string, number>>;
  };
  readonly colour: {
    readonly ok: boolean;
    readonly expectsColour: number;
    readonly coloured: number;
    readonly share: number;
    readonly misses: readonly ColourMiss[];
    readonly missesTotal: number;
    /** Sections (all models) by graph outcome; sections with no `graph` count in none of these. */
    readonly graphBaked: number;
    readonly graphUnsupported: number;
    readonly graphUnavailable: number;
    /** Sections naming each unsupported node class (a class repeated in one section counts once). */
    readonly unsupportedNodes: Readonly<Record<string, number>>;
    /** Unavailable sections per normalised reason; capped at the top PARITY_LIST_CAP reasons. */
    readonly unavailableReasons: Readonly<Record<string, number>>;
    /** Uncapped, unlike `misses`. */
    readonly missAttribution: MissAttribution;
  };
}

/** `Content/A/B.uasset`, `/Game/A/B` and `Pack/Content/A/B` all become `a/b`. */
export function packageKey(path: string): string {
  const segments = path
    .replace(/\\/g, "/")
    .replace(/\.(uasset|umap)$/i, "")
    .split("/")
    .filter((s) => s.length > 0);
  let from = 0;
  const content = segments.map((s) => s.toLowerCase()).lastIndexOf("content");
  if (content >= 0) from = content + 1;
  else from = 1; // `/Game/...` and any other mount point: drop the mount name
  return segments.slice(from).join("/").toLowerCase();
}

/** `/Game/A/MI_X.MI_X` and `MI_X` both become `mi_x`. */
export function objectName(path: string): string {
  const last = path.replace(/\\/g, "/").split("/").pop() ?? path;
  const dot = last.lastIndexOf(".");
  return (dot >= 0 ? last.slice(dot + 1) : last).toLowerCase();
}

/** The package half of `/Game/A/MI_X.MI_X`. */
function objectPackageKey(path: string): string {
  const slash = path.lastIndexOf("/");
  const dot = path.indexOf(".", slash + 1);
  return packageKey(dot >= 0 ? path.slice(0, dot) : path);
}

function capped<T>(list: readonly T[]): readonly T[] {
  return list.slice(0, PARITY_LIST_CAP);
}

/**
 * Strips the names out of a bake's `unavailable` reason so equal causes share a count:
 * `texture T_Rock_M could not be loaded` and `no dumped graph for MI_X or its parents` become
 * `texture could not be loaded` and `no dumped graph`.
 */
export function normaliseGraphReason(reason: string | undefined): string {
  const text = (reason ?? "").trim();
  if (text === "") return "no reason given";
  const texture = /^(texture)\s+\S+\s+(.+)$/i.exec(text);
  if (texture) return `${texture[1]!.toLowerCase()} ${texture[2]!}`.slice(0, 80);
  const noGraph = /^(no dumped graph)\b/i.exec(text);
  if (noGraph) return noGraph[1]!.toLowerCase();
  return text
    .replace(/(["'`])[^"'`]*\1/g, "")
    .split(/\s+/)
    .filter((word) => !/[/\\_.]/.test(word) && !/\d/.test(word))
    .join(" ")
    .trim()
    .slice(0, 80) || "other";
}

function bump(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

/** The PARITY_LIST_CAP largest entries, ties by name. */
function cappedRecord(record: Readonly<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, PARITY_LIST_CAP),
  );
}

const isMeshClass = (c: string): boolean => c === "StaticMesh" || c === "SkeletalMesh";
const isNormalName = (name: string): boolean => /(_n|_nrm|_normal|normal)$/i.test(name);

function countByKind(list: readonly { readonly kind: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of list) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
  return counts;
}

export const UNREADABLE_MESH_REASON =
  "mesh(es) unreadable in the dump (export or package error, or no slots); S2/S3 cannot verify them";

interface SourceMesh {
  readonly exp: DumpExport;
  /** The export or its package carries an error, or it has no slots to compare against. */
  readonly unreadable: boolean;
}

interface Located {
  readonly pkg: string;
  readonly exp: DumpExport;
}

interface Effective {
  readonly textures: ReadonlySet<string>;
  /** Textures a parent supplied for a parameter that a descendant replaced. */
  readonly replaced: ReadonlySet<string>;
  readonly normalTextures: ReadonlySet<string>;
  readonly hasVectors: boolean;
  readonly constantColors: boolean;
}

function buildMaterialIndex(dump: PropertyDump): Map<string, Located[]> {
  const index = new Map<string, Located[]>();
  for (const pkg of dump.packages) {
    const key = packageKey(pkg.path);
    for (const exp of pkg.exports ?? []) {
      if (!exp.class.startsWith("Material")) continue;
      const name = exp.name.toLowerCase();
      const list = index.get(name) ?? [];
      list.push({ pkg: key, exp });
      index.set(name, list);
    }
  }
  return index;
}

function resolve(index: Map<string, Located[]>, path: string): Located | undefined {
  const candidates = index.get(objectName(path)) ?? [];
  const key = path.includes("/") ? objectPackageKey(path) : undefined;
  if (key !== undefined) {
    const exact = candidates.find((c) => c.pkg === key);
    if (exact) return exact;
  }
  return candidates.length === 1 && key === undefined ? candidates[0] : undefined;
}

const MAX_FUNCTION_DEPTH = 16;

/** Textures reachable from `roots` through MaterialFunction calls (cycle-safe, depth-limited). */
function functionTextures(index: Map<string, Located[]>, roots: readonly string[]): Set<string> {
  const found = new Set<string>();
  const seen = new Set<DumpExport>();
  let frontier = roots;
  for (let depth = 0; depth < MAX_FUNCTION_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const path of frontier) {
      const located = resolve(index, path);
      if (!located || !located.exp.class.startsWith("MaterialFunction") || seen.has(located.exp)) continue;
      seen.add(located.exp);
      for (const t of located.exp.textures ?? []) found.add(objectName(t));
      for (const p of located.exp.textureParameters ?? []) if (p.texture) found.add(objectName(p.texture));
      next.push(...(located.exp.functions ?? []));
    }
    frontier = next;
  }
  return found;
}

/** The effective texture/colour set for a material, or undefined when the chain leaves the dump. */
function effectiveSet(index: Map<string, Located[]>, start: Located): Effective | undefined {
  const chain: Located[] = [start];
  const seen = new Set<DumpExport>([start.exp]);
  let current = start;
  while (current.exp.parent) {
    if (chain.length > MAX_PARENT_DEPTH) return undefined;
    const next = resolve(index, current.exp.parent);
    if (!next || seen.has(next.exp)) return undefined;
    seen.add(next.exp);
    chain.push(next);
    current = next;
  }
  const root = chain[chain.length - 1]!.exp;
  const params = new Map<string, string>();
  const replaced = new Set<string>();
  const rootDefaults = new Set<string>();
  for (const p of root.textureParameters ?? []) {
    if (!p.texture) continue;
    params.set(p.name, objectName(p.texture));
    rootDefaults.add(objectName(p.texture));
  }
  const vectors = new Map<string, Vec>();
  for (const v of root.vectorParameters ?? []) vectors.set(v.name, v.value);
  for (let i = chain.length - 2; i >= 0; i--) {
    const level = chain[i]!.exp;
    for (const p of level.textureParameters ?? []) {
      if (!p.texture) continue;
      const next = objectName(p.texture);
      const previous = params.get(p.name);
      if (previous !== undefined && previous !== next) replaced.add(previous);
      params.set(p.name, next);
    }
    for (const v of level.vectorParameters ?? []) vectors.set(v.name, v.value);
  }
  const textures = new Set<string>(params.values());
  for (const t of root.textures ?? []) {
    const name = objectName(t);
    if (!rootDefaults.has(name)) textures.add(name);
  }
  // Textures a MaterialFunction samples are bound through the calling Material's graph, but the dump lists
  // them on the function's own export. Functions missing from the dump are unverified, never a violation.
  for (const name of functionTextures(index, root.functions ?? [])) if (!rootDefaults.has(name)) textures.add(name);
  for (const name of textures) replaced.delete(name);
  const normalTextures = new Set<string>();
  for (const name of textures) if (isNormalName(name)) normalTextures.add(name);
  for (const [paramName, tex] of params) if (/normal/i.test(paramName)) normalTextures.add(tex);
  return {
    textures,
    replaced,
    normalTextures,
    hasVectors: vectors.size > 0,
    constantColors: (root.constantColors ?? 0) > 0,
  };
}

const BOUNDS_TOLERANCE = 0.1;

function near(a: number, b: number, tolerance: number): boolean {
  return Math.abs(a - b) <= tolerance;
}
function triplesMatch(a: Vec, b: Vec, tolerance: number): boolean {
  return a.length === 3 && b.length === 3 && a.every((v, i) => near(v, b[i]!, tolerance));
}

function isNeutral(factor: readonly number[]): boolean {
  return NEUTRAL_BASE_COLOR.every((v, i) => near(factor[i] ?? v, v, 1e-3));
}

export function scorePack(dump: PropertyDump, report: ImportReport): PackScore {
  const meshes = new Map<string, SourceMesh>();
  const failedPackages = new Set<string>();
  const externalActorKeys = new Set<string>();
  for (const pkg of dump.packages) {
    const key = packageKey(pkg.path);
    if (isWorldPartitionExternalPackage(pkg.path)) {
      if ((pkg.exports ?? []).some((exp) => isMeshClass(exp.class))) externalActorKeys.add(key);
      continue;
    }
    if (pkg.error) failedPackages.add(key);
    for (const exp of pkg.exports ?? []) {
      if (!isMeshClass(exp.class) || meshes.has(key)) continue;
      const unreadable = Boolean(pkg.error) || Boolean(exp.error) || (exp.slots?.length ?? 0) === 0;
      meshes.set(key, { exp, unreadable });
    }
  }
  const models = new Map<string, ImportedModel>();
  for (const model of report.models) models.set(packageKey(model.package), model);

  // S1 coverage
  const reasonFor = new Map<string, string>();
  for (const entry of [...report.skipped, ...report.failed]) reasonFor.set(packageKey(entry.package), entry.reason);
  const missing: MissingMesh[] = [];
  for (const [key] of meshes) {
    if (models.has(key)) continue;
    const reason = reasonFor.get(key);
    missing.push(reason === undefined ? { package: key } : { package: key, reason });
  }

  // S2 shape, S3 identity, S4 colour
  const index = buildMaterialIndex(dump);
  const shape: ShapeViolation[] = [];
  let checked = 0;
  let unmatchedModels = 0;
  let unverifiedModels = 0;
  let unusedSlots = 0;
  let boundsUnverified = 0;
  let boundsDrift = 0;
  const identity: IdentityViolation[] = [];
  let sections = 0;
  let unverified = 0;
  // Sections of readable meshes only: the "material data outside the dump" rule must not count
  // sections that are unverified because their mesh was unreadable.
  let readableSections = 0;
  let outsideDump = 0;
  let expectsColour = 0;
  let coloured = 0;
  const misses: ColourMiss[] = [];
  let graphBaked = 0;
  let graphUnsupported = 0;
  let graphUnavailable = 0;
  const unsupportedNodes: Record<string, number> = {};
  const unavailableReasons: Record<string, number> = {};
  const missAttribution = { bakedAway: 0, bakedStillGrey: 0, unsupportedNode: 0, unavailable: 0, noGraph: 0 };

  for (const [key, model] of models) {
    // Graph outcomes are tallied for every section, readable mesh or not.
    for (const section of model.materials) {
      const graph = section.graph;
      if (!graph) continue;
      if (graph.status === "baked") graphBaked++;
      else if (graph.status === "unsupported") {
        graphUnsupported++;
        for (const node of new Set(graph.unsupportedNodes ?? [])) bump(unsupportedNodes, node);
      } else if (graph.status === "unavailable") {
        graphUnavailable++;
        bump(unavailableReasons, normaliseGraphReason(graph.reason));
      }
    }
    const source = meshes.get(key);
    // A package that failed to load has no mesh export, yet the importer may still list a model.
    const unreadable = source ? source.unreadable : failedPackages.has(key);
    const mesh = unreadable ? undefined : source?.exp;
    if (unreadable) unverifiedModels++;
    else if (mesh) {
      checked++;
      const expectedSlots = mesh.slots?.length ?? 0;
      const actualSlots = new Set(model.materials.map((m) => m.name)).size;
      if (actualSlots > expectedSlots || actualSlots === 0) {
        shape.push({ kind: "slot-count", model: model.name, expected: expectedSlots, actual: actualSlots });
      } else unusedSlots += expectedSlots - actualSlots;
      const extent = mesh.bounds?.boxExtent;
      if (!extent) boundsUnverified++;
      else {
        // `ExtendedBounds` is the geometry grown by the mesh's authored Positive/NegativeBoundsExtension
        // (culling padding, large on foliage), so judge the geometry against the box minus that padding.
        const padded = mesh.bounds?.property === "ExtendedBounds";
        const positive = padded ? mesh.bounds?.positiveExtension : undefined;
        const negative = padded ? mesh.bounds?.negativeExtension : undefined;
        const size = extent.map((e, i) => Math.max(e * 2 - (positive?.[i] ?? 0) - (negative?.[i] ?? 0), 0) / 100);
        // Two glTF axis conventions are valid and both keep UE's up axis (Z) on glTF Y: UE Viewer writes
        // (X, Z, Y); the CUE4Parse and MeshDescription converters write (Y, Z, X) (UE right -> glTF x,
        // UE forward -> glTF z). A mesh is axis-correct when it matches either order.
        const viewerOrder = [size[0]!, size[2]!, size[1]!];
        const converterOrder = [size[1]!, size[2]!, size[0]!];
        const actual = model.boundsMetres;
        // `ExtendedBounds` is an authored, cached value and can lag the geometry (Soul Cave: 4 of 173
        // meshes sit 2-8 % off). Scale, unit and up-axis errors are factors, so 10 % still catches
        // them; the 1-10 % band is counted as drift, not failed.
        const tolFor = (e: readonly number[], fraction: number): number => Math.max(fraction * Math.max(...e), 0.001);
        const matched = [viewerOrder, converterOrder].find((order) => triplesMatch(order, actual, tolFor(order, BOUNDS_TOLERANCE)));
        if (matched) {
          if (!triplesMatch(matched, actual, tolFor(matched, 0.01))) boundsDrift++;
        } else {
          const expected = viewerOrder;
          const sortedE = [...expected].sort((a, b) => a - b);
          const sortedA = [...actual].sort((a, b) => a - b);
          shape.push({
            kind: triplesMatch(sortedE, sortedA, tolFor(expected, BOUNDS_TOLERANCE)) ? "bounds-axis" : "bounds-size",
            model: model.name,
            expected,
            actual,
          });
        }
      }
    } else unmatchedModels++;

    if (unreadable) {
      sections += model.materials.length;
      unverified += model.materials.length;
      continue;
    }
    const slotMaterials = new Set((mesh?.slots ?? []).map((s) => s.material).filter((m): m is string => !!m));
    for (const section of model.materials) {
      sections++;
      readableSections++;
      const located = locateSection(index, section.name, slotMaterials);
      const effective = located ? effectiveSet(index, located) : undefined;
      if (!located || !effective) {
        unverified++;
        outsideDump++;
        continue;
      }
      scoreIdentity(model.name, section, effective, identity);
      const hasColourTexture = [...effective.textures].some((t) => !effective.normalTextures.has(t));
      if (hasColourTexture || effective.hasVectors || effective.constantColors) {
        expectsColour++;
        const isColoured = section.textured === true || (section.factors?.baseColor !== undefined && !isNeutral(section.factors.baseColor));
        const graphStatus: GraphOutcome = section.graph?.status ?? "none";
        if (isColoured) {
          coloured++;
          if (graphStatus === "baked") missAttribution.bakedAway++;
        } else {
          if (graphStatus === "baked") missAttribution.bakedStillGrey++;
          else if (graphStatus === "unsupported") missAttribution.unsupportedNode++;
          else if (graphStatus === "unavailable") missAttribution.unavailable++;
          else missAttribution.noGraph++;
          const nodes = graphStatus === "unsupported" ? [...new Set(section.graph?.unsupportedNodes ?? [])] : [];
          misses.push({
            model: model.name,
            section: section.name,
            graphStatus,
            ...(nodes.length > 0 ? { unsupportedNodes: nodes } : {}),
          });
        }
      }
    }
  }

  const share = expectsColour === 0 ? 1 : coloured / expectsColour;
  const coverageOk = missing.length === 0;
  const shapeOk = shape.length === 0;
  const identityOk = identity.length === 0;
  const colourOk = share >= COLOUR_PASS_SHARE;

  const reasons: string[] = [];
  let status: PackScore["status"];
  if (meshes.size === 0) {
    status = "unverified";
    reasons.push("dump has no readable StaticMesh or SkeletalMesh exports");
  } else if (readableSections > 0 && outsideDump * 2 > readableSections) {
    status = "unverified";
    reasons.push(`${outsideDump} of ${readableSections} sections have material data outside the dump`);
  } else {
    if (!coverageOk) reasons.push(`S1 coverage: ${missing.length} mesh package(s) not exported`);
    if (!shapeOk) reasons.push(`S2 shape: ${shape.length} violation(s)`);
    if (!identityOk) reasons.push(`S3 identity: ${identity.length} violation(s)`);
    if (!colourOk) reasons.push(`S4 colour: ${coloured}/${expectsColour} sections coloured (below 90%)`);
    status = reasons.length === 0 ? "pass" : "fail";
  }
  if (unverifiedModels > 0) {
    // A pack with an unreadable mesh is never a pass: it is unverified unless a verified check failed.
    reasons.push(`${unverifiedModels} ${UNREADABLE_MESH_REASON}`);
    if (status === "pass") status = "unverified";
  }

  return {
    status,
    reasons,
    coverage: {
      ok: coverageOk,
      expected: meshes.size,
      exported: models.size,
      missing: capped(missing),
      missingTotal: missing.length,
      externalActorPackages: externalActorKeys.size,
    },
    shape: {
      ok: shapeOk,
      checked,
      unmatchedModels,
      unverifiedModels,
      unusedSlots,
      boundsUnverified,
      boundsDrift,
      violations: capped(shape),
      violationsTotal: shape.length,
      byKind: countByKind(shape),
    },
    identity: {
      ok: identityOk,
      sections,
      verified: sections - unverified,
      unverified,
      violations: capped(identity),
      violationsTotal: identity.length,
      byKind: countByKind(identity),
    },
    colour: {
      ok: colourOk,
      expectsColour,
      coloured,
      share,
      misses: capped(misses),
      missesTotal: misses.length,
      graphBaked,
      graphUnsupported,
      graphUnavailable,
      unsupportedNodes: cappedRecord(unsupportedNodes),
      unavailableReasons: cappedRecord(unavailableReasons),
      missAttribution,
    },
  };
}

function locateSection(
  index: Map<string, Located[]>,
  sectionName: string,
  slotMaterials: ReadonlySet<string>,
): Located | undefined {
  const name = sectionName.toLowerCase();
  for (const path of slotMaterials) {
    if (objectName(path) === name) {
      const hit = resolve(index, path);
      if (hit) return hit;
    }
  }
  const candidates = index.get(name) ?? [];
  return candidates[0];
}

function scoreIdentity(
  model: string,
  section: ImportedMaterialSection,
  effective: Effective,
  out: IdentityViolation[],
): void {
  const actual = new Set<string>();
  for (const b of section.bindings) {
    // A baked graph texture is derived from several pack textures, so it is not itself one of them.
    if (b.source === "graph") continue;
    actual.add(objectName(b.texture));
    if (b.secondaryTexture) actual.add(objectName(b.secondaryTexture));
  }
  for (const texture of actual) {
    if (effective.textures.has(texture)) continue;
    out.push({
      model,
      section: section.name,
      texture,
      kind: effective.replaced.has(texture) ? "overridden-parent-default" : "foreign",
    });
  }
}
