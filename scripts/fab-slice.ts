/**
 * PRD-581 Phase 2: small, non-redundant feature-test slices cut from owned Fab packs.
 *
 * A slice holds the packages a feature PRD needs plus their dependency closure, copied with the
 * pack's own directory layout so `asset_import_unreal` takes it as an ordinary `sourceDir`. The
 * closure follows the `/Game/...` package references in each package's import table, closed under
 * recursion and limited to the pack: it never substitutes a file-name guess or copies the whole pack.
 *
 *   npx tsx scripts/fab-slice.ts make --slice <id> [--full <dir>] [--out <dir>] [--record]
 *   npx tsx scripts/fab-slice.ts make --all [--out <dir>] [--record]
 *   npx tsx scripts/fab-slice.ts verify [--out <dir>] [--record]
 *   npx tsx scripts/fab-slice.ts compare-full <slice-id> --full <dir> [--out <dir>]
 *   npx tsx scripts/fab-slice.ts list
 *
 * Slices are local-only: they carry licensed packages, so `--out` defaults outside the repository and
 * the corpus record holds numeric identifiers and class counts, never an asset name. `make` writes a
 * free download into the lane-local acquisition cache and deletes nothing automatically: a full pack
 * is kept until `compare-full` has produced its evidence.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { FabCli, type FabOwnedListing } from "../src/fab/fabcli.js";
import type { DecoderRoute } from "../src/fab/routes.js";
import { classesInHead, gameReferencesInHead, readPackageHead, readPackageHeaderRegion } from "../src/unreal/cooking.js";
import { ImportError, importUnrealDirectory, type ImportReport } from "../src/unreal/importer.js";
import { parseImportedPackages, parsePrimaryClass } from "../src/unreal/static-mesh-sections.js";

export const SLICE_LIMIT_BYTES = 1024 * 1024 * 1024;
export const SLICE_MANIFEST = ".fab-slice.json";
const USAGE = [
  "usage:",
  "  fab-slice.ts make --slice <id> [--full <dir>] [--out <dir>] [--record] [--cleanup] [--per-class N]",
  "  fab-slice.ts make --all [--out <dir>] [--record]",
  "  fab-slice.ts verify [--out <dir>] [--record]",
  "  fab-slice.ts compare-full <slice-id> --full <dir> [--out <dir>]",
  "  fab-slice.ts list",
].join("\n");

const PACKAGE_EXTENSIONS = new Set([".uasset", ".umap"]);
/** A package's bulk-data sidecars; they are not packages themselves and travel with their owner. */
const SIDECAR_EXTENSIONS = [".uexp", ".ubulk", ".uptnl"] as const;

export interface SlicePlan {
  /** Slice id; also the directory name under the slices root. */
  readonly id: string;
  readonly listingId: string;
  readonly artifactId: string;
  readonly engine: string;
  readonly route: DecoderRoute;
  /** Class names the slice must contain; the coverage matrix columns. */
  readonly targetClasses: readonly string[];
  /** A slice that already has its full pack on disk; `make` uses it when no `--full` is given. */
  readonly defaultFull?: string;
  /** Recorded matrix gaps this slice does not fill (accepted, not hidden). */
  readonly gaps?: readonly string[];
  /** An extra slice strict `verify` does not require; the five artifacts of the matrix are required. */
  readonly optional?: boolean;
}

/** The five non-redundant artifacts of the coverage matrix (`001-fab-feature-test-corpus.md`). */
export const SLICES: readonly SlicePlan[] = [
  {
    id: "anim-starter-4.4",
    listingId: "98ff449d-79db-4f54-9303-75486c4fb9d9",
    artifactId: "AnimStarterPack",
    engine: "UE_4.4",
    route: "umodel",
    targetClasses: ["SkeletalMeshSocket", "SkeletalMesh", "BlendSpace", "BlendSpace1D", "AimOffsetBlendSpace", "AimOffsetBlendSpace1D", "PhysicsAsset", "Skeleton", "AnimBlueprint", "AnimSequence"],
    // `Aim_Space_*` files are AnimSequence packages, not an aim-offset blend space, so 4.4 offers no
    // AimOffsetBlendSpace; the pack has no socket-bearing mesh either. Both are recorded gaps.
    gaps: ["AimOffsetBlendSpace", "AimOffsetBlendSpace1D", "BlendSpace1D", "SkeletalMeshSocket"],
  },
  {
    id: "stickman-4.22",
    listingId: "d36ddd1b-8139-427d-8f8a-6a91469dc6b8",
    artifactId: "ROGCreata5e7dce4b29aV1",
    engine: "UE_4.22",
    route: "mesh-description",
    targetClasses: ["SkeletalMeshSocket", "SkeletalMesh", "AnimMontage", "BlendSpace", "BlendSpace1D", "PhysicsAsset", "Skeleton", "AnimNotify"],
    // The mesh names no `SkeletalMeshSocket` entry and no montage names an `AnimNotify` class entry.
    gaps: ["SkeletalMeshSocket", "AnimNotify"],
  },
  {
    id: "soul-cave-4.18",
    listingId: "75f42402-40bb-4a1b-b557-18e2c9604273",
    artifactId: "SoulCave418",
    engine: "UE_4.18",
    route: "umodel",
    targetClasses: ["ParticleSystem", "SoundCue", "StaticMesh", "BodySetup"],
  },
  {
    id: "vtol-5.4",
    listingId: "03152868-7c84-4363-bafc-322031e95513",
    artifactId: "FreeSciFa6c7dbbcefe6V1",
    engine: "UE_5.4",
    route: "cue4parse",
    targetClasses: ["NiagaraSystem", "NiagaraEmitter"],
  },
  {
    id: "game-anim-5.8",
    listingId: "880e319a-a59e-4ed2-b268-b32dac7fa016",
    artifactId: "GameAnimationSample_5.8",
    engine: "UE_5.8",
    route: "cue4parse",
    targetClasses: ["SkeletalMeshSocket", "PhysicsAsset", "PhysicsConstraintTemplate", "SkeletalBodySetup", "SoundCue", "AnimMontage", "BlendSpace", "BlendSpace1D", "PoseAsset"],
    defaultFull: join(
      homedir(),
      ".cache/threenative-asset-mcp/fab-downloads/parity-20261010T210430-b1b64a/880e319a-a59e-4ed2-b268-b32dac7fa016/GameAnimationSample_5.8",
    ),
  },
  // Optional sixth slice (PRD-583): the same Game Animation Sample listing's 5.4 artifact, for the
  // UE 5.0-5.5 clip data model. Strict `verify` does not require it until it is built and recorded.
  // Its seed is one clip and the two mannequin meshes so the closure stays small:
  //   Content/Characters/UEFN_Mannequin/Animations/AimOffset/M_Neutral_AO_Stand_X0_Y0.uasset
  //   Content/Characters/UEFN_Mannequin/Meshes/SKM_UEFN_Mannequin.uasset
  //   Content/Characters/UEFN_Mannequin/Meshes/SK_UEFN_Mannequin.uasset
  {
    id: "game-anim-5.4",
    listingId: "880e319a-a59e-4ed2-b268-b32dac7fa016",
    artifactId: "GameAnimationSample_5.4",
    engine: "UE_5.4",
    route: "cue4parse",
    targetClasses: ["AnimSequence", "SkeletalMesh", "Skeleton"],
    defaultFull: join(
      homedir(),
      ".cache/threenative-asset-mcp/fab-downloads/prd583-20261011/game-animation-5.4",
    ),
    optional: true,
  },
];

export function findSlice(id: string): SlicePlan {
  const slice = SLICES.find((entry) => entry.id === id);
  if (!slice) throw new Error(`unknown slice "${id}". Known: ${SLICES.map((entry) => entry.id).join(", ")}`);
  return slice;
}

/**
 * The required slices (not `optional`) absent from the built set. Strict `verify` and `--record` call
 * this before writing the record, so a missing required slice fails loudly instead of being skipped
 * and dropped from `docs/parity/feature-corpus.json`.
 */
export function missingRequiredSlices(slices: readonly SlicePlan[], builtIds: ReadonlySet<string>): SlicePlan[] {
  return slices.filter((slice) => !slice.optional && !builtIds.has(slice.id));
}

// --- corpus record (numeric identifiers only) ----------------------------------------------------

export interface CorpusSlice {
  readonly id: string;
  readonly listingId: string;
  readonly artifactId: string;
  readonly engine: string;
  readonly route: DecoderRoute;
  readonly targetClasses: readonly string[];
  /** Package counts per target class, from name-table membership (presence, not export count). */
  readonly classCounts: Readonly<Record<string, number>>;
  readonly packages: number;
  readonly bytes: number;
  readonly packageDigest: string;
  readonly gaps: readonly string[];
}

export interface FeatureCorpus {
  readonly version: number;
  readonly limitBytes: number;
  readonly slices: readonly CorpusSlice[];
}

export function corpusPath(root = repositoryRoot()): string {
  return join(root, "docs", "parity", "feature-corpus.json");
}

function repositoryRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

export async function readCorpus(path: string): Promise<FeatureCorpus> {
  const text = await readFile(path, "utf8").catch(() => undefined);
  if (text === undefined) return { version: 1, limitBytes: SLICE_LIMIT_BYTES, slices: [] };
  const parsed = JSON.parse(text) as FeatureCorpus;
  return { version: parsed.version ?? 1, limitBytes: parsed.limitBytes ?? SLICE_LIMIT_BYTES, slices: parsed.slices ?? [] };
}

export async function writeCorpus(path: string, corpus: FeatureCorpus): Promise<void> {
  const slices = [...corpus.slices].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  await writeFile(path, `${JSON.stringify({ version: 1, limitBytes: corpus.limitBytes, slices }, null, 2)}\n`);
}

// --- filesystem ----------------------------------------------------------------------------------

interface TreeFile {
  readonly abs: string;
  readonly rel: string;
  readonly size: number;
}

interface PackageFile extends TreeFile {
  /** `.uexp`/`.ubulk`/`.uptnl` bulk data that belongs to this package, if present. */
  readonly sidecars: readonly TreeFile[];
}

/** Every regular file below `root`, with its size, sorted by relative path. */
async function listTreeFiles(root: string): Promise<TreeFile[]> {
  const found: TreeFile[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else if (entry.isFile()) {
        const info = await stat(abs);
        found.push({ abs, rel: relative(root, abs), size: info.size });
      }
    }
  }
  await walk(root);
  return found.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/**
 * The packages below `root` with any bulk-data sidecars beside them. The package extension is stripped
 * from the relative path to find `<stem>.uexp`, `.ubulk` and `.uptnl`, so a sidecar is only counted and
 * copied with the package that owns it.
 */
export async function listPackageFiles(root: string): Promise<PackageFile[]> {
  const all = await listTreeFiles(root);
  const byRel = new Map(all.map((file) => [file.rel, file]));
  const packages: PackageFile[] = [];
  for (const file of all) {
    const extension = extname(file.rel).toLowerCase();
    if (!PACKAGE_EXTENSIONS.has(extension)) continue;
    const stem = file.rel.slice(0, file.rel.length - extension.length);
    const sidecars = SIDECAR_EXTENSIONS.map((sidecar) => byRel.get(`${stem}${sidecar}`)).filter((sidecar): sidecar is TreeFile => sidecar !== undefined);
    packages.push({ ...file, sidecars });
  }
  return packages;
}

/** The bytes a package occupies, its sidecars included. */
function packageBytes(file: PackageFile): number {
  return file.size + file.sidecars.reduce((sum, sidecar) => sum + sidecar.size, 0);
}

/** The `/Game/...` package path a package file would have in the pack: the path below `Content/`. */
export function gamePathOf(rel: string): string | undefined {
  const parts = rel.split(sep).flatMap((segment) => (segment === "" ? [] : [segment]));
  const contentIndex = parts.indexOf("Content");
  const below = contentIndex >= 0 ? parts.slice(contentIndex + 1) : parts;
  if (below.length === 0) return undefined;
  const stem = below[below.length - 1]!.replace(/\.[^.]+$/, "");
  return `/Game/${[...below.slice(0, -1), stem].join("/")}`;
}

/** A package reference is a package path, sometimes with an `.Object` suffix; keep the package. */
function normalizeReference(reference: string): string {
  const dot = reference.indexOf(".", reference.lastIndexOf("/"));
  return dot === -1 ? reference : reference.slice(0, dot);
}

/** Rejects an empty, absolute or parent-escaping directory name before it is joined to a root. */
export function assertSafeChild(root: string, segment: string): string {
  if (segment === "" || segment === "." || segment === ".." || isAbsolute(segment) || segment.includes(sep) || segment.includes("/") || segment.includes("\\")) {
    throw new Error(`unsafe directory name "${segment}"`);
  }
  return join(root, segment);
}

/** Resolves a slash-separated relative path under `root`, refusing absolute, empty, `.`, `..` or escaping parts. */
export function containedPath(root: string, rel: string): string {
  if (rel === "" || isAbsolute(rel)) throw new Error(`unsafe manifest path "${rel}"`);
  const parts = rel.split(/[\\/]/);
  if (parts.some((part) => part === "" || part === "." || part === "..")) throw new Error(`unsafe manifest path "${rel}"`);
  const base = resolve(root);
  const abs = resolve(base, rel);
  if (abs === base || !abs.startsWith(base + sep)) throw new Error(`manifest path escapes its root: "${rel}"`);
  return abs;
}

/**
 * `containedPath` plus a check that no path component is a symlink. A manifest is local-only, but it
 * names paths this tool deletes, so a tampered or shared manifest must not be able to point a delete or
 * copy at a file outside the slice (through `../` or a symlinked directory).
 */
export async function assertNoSymlinks(root: string, rel: string): Promise<string> {
  const abs = containedPath(root, rel);
  // The root itself can be a symlink (a tampered slice directory), which would let a contained `rel`
  // still resolve outside the intended tree. Check it before any child.
  const rootInfo = await lstat(resolve(root)).catch(() => undefined);
  if (rootInfo?.isSymbolicLink()) throw new Error(`refusing to touch symlink root "${root}"`);
  const parts = rel.split(/[\\/]/);
  let current = resolve(root);
  for (const part of parts) {
    current = join(current, part);
    const info = await lstat(current).catch(() => undefined);
    if (info?.isSymbolicLink()) throw new Error(`refusing to touch symlink "${rel}"`);
  }
  return abs;
}

// --- dependency closure --------------------------------------------------------------------------

export interface ScannedPackage {
  readonly rel: string;
  readonly classes: readonly string[];
  readonly refs: readonly string[];
  /**
   * The class of the package's first export record, when the format exposes it (UE4). A UE4 export map
   * is not ordered by asset, so this is only used to pick a slice representative; counts come from
   * `classes` membership.
   */
  readonly primaryClass?: string;
}

/**
 * The packages a slice must hold: every package that is a target class, plus every package reachable
 * from one through the `/Game/...` references of the import table. The closure is closed under
 * recursion and cannot leave the pack because only indexed pack files are ever added.
 *
 * A package matches a class exactly when its first export record is that class (UE4); a class with no
 * such package (a sub-object like `SkeletalMeshSocket`, or a UE5 package whose reader names no primary
 * class) falls back to name-table membership, which is evidence of presence. A bounded number of the
 * smallest representatives is taken per class so a class with hundreds of members cannot pull a
 * pack-sized slice. That bounds assets, never classes: every target class still needs a member.
 */
export function selectSlicePackages(
  scanned: readonly ScannedPackage[],
  targetClasses: readonly string[],
  perClass = Number.POSITIVE_INFINITY,
  sizeOf?: (rel: string) => number,
): string[] {
  const byRel = new Map(scanned.map((entry) => [entry.rel, entry]));
  const byGamePath = new Map<string, string>();
  for (const entry of scanned) {
    const gamePath = gamePathOf(entry.rel);
    if (gamePath) byGamePath.set(gamePath, entry.rel);
  }
  const closure = (seeds: Iterable<string>): Set<string> => {
    const found = new Set<string>();
    const queue: string[] = [];
    for (const seed of seeds) {
      if (!found.has(seed)) {
        found.add(seed);
        queue.push(seed);
      }
    }
    while (queue.length > 0) {
      const current = byRel.get(queue.pop()!);
      if (!current) continue;
      for (const ref of current.refs) {
        const dependency = byGamePath.get(normalizeReference(ref));
        if (dependency !== undefined && !found.has(dependency)) {
          found.add(dependency);
          queue.push(dependency);
        }
      }
    }
    return found;
  };
  const poolFor = (className: string): ScannedPackage[] => {
    const exact = scanned.filter((entry) => entry.primaryClass === className);
    const pool = exact.length > 0 ? exact : scanned.filter((entry) => entry.classes.includes(className));
    return [...pool].sort((a, b) =>
      sizeOf ? sizeOf(a.rel) - sizeOf(b.rel) : a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0,
    );
  };
  // A class's eligible representatives are exactly its pool: the exact primary-class matches when any
  // exist (UE4), otherwise the name-table members (UE5, or a sub-object class). A package that a closure
  // merely pulls in and that only mentions the class by name must not count toward the representatives
  // needed, or 3 importing-only packages could stand in for 3 assets.
  const poolRels = (className: string): Set<string> => new Set(poolFor(className).map((entry) => entry.rel));

  if (!Number.isFinite(perClass)) {
    const seeds = new Set<string>();
    for (const className of targetClasses) for (const entry of poolFor(className)) seeds.add(entry.rel);
    return [...closure(seeds)].sort();
  }

  // Greedy set-cover: repeatedly add the candidate whose dependency closure adds the fewest new bytes,
  // so representatives that share a character's dependency closure win over the smallest package of
  // each class taken in isolation. This is what keeps a class-rich UE5 pack from becoming a pack-sized
  // slice. Each target class needs up to `perClass` distinct matching representatives, bounded by the
  // class's available pool; a package matching several target classes covers all of them at once. The
  // round bound is the total representatives required, so a class whose pool is smaller than `perClass`
  // cannot spin.
  const include = new Set<string>();
  const byteTotal = (set: Set<string>): number => (sizeOf ? [...set].reduce((sum, rel) => sum + sizeOf(rel), 0) : set.size);
  const needFor = (className: string): number => Math.min(perClass, poolFor(className).length);
  const covers = (className: string): number => {
    const pool = poolRels(className);
    return [...include].filter((rel) => pool.has(rel)).length;
  };
  const maxRounds = targetClasses.reduce((sum, className) => sum + needFor(className), 0);
  for (let round = 0; round < maxRounds; round += 1) {
    const unmet = targetClasses.filter((className) => covers(className) < needFor(className));
    if (unmet.length === 0) break;
    let bestSeed: string | undefined;
    let bestAdded = Number.POSITIVE_INFINITY;
    let bestGain = 0;
    for (const className of unmet) {
      for (const candidate of poolFor(className).slice(0, Math.max(24, perClass))) {
        if (include.has(candidate.rel)) continue;
        const next = closure([...include, candidate.rel]);
        const added = byteTotal(next) - byteTotal(include);
        const gain = unmet.filter((name) => poolRels(name).has(candidate.rel)).length;
        if (added < bestAdded || (added === bestAdded && gain > bestGain)) {
          bestAdded = added;
          bestSeed = candidate.rel;
          bestGain = gain;
        }
      }
    }
    if (bestSeed === undefined) break;
    for (const rel of closure([...include, bestSeed])) include.add(rel);
  }
  return [...include].sort();
}

export function packageDigest(relPaths: readonly string[]): string {
  return `sha256:${createHash("sha256").update([...relPaths].sort().join("\n")).digest("hex")}`;
}

/**
 * The number of packages that *name* each class in their name or import table: evidence of presence,
 * never an object or export count. A package that merely imports a class for a property is counted, so
 * a class with N members can report more than N. This is the coverage signal the corpus records; the
 * exact primary class is used only to pick slice representatives, not to report counts.
 */
export function classCounts(scanned: readonly ScannedPackage[], candidates: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const className of candidates) {
    counts[className] = scanned.filter((entry) => entry.classes.includes(className)).length;
  }
  return counts;
}

async function mapConcurrency<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) return;
        results[index] = await worker(items[index]!);
      }
    }),
  );
  return results;
}

async function scanPackages(files: readonly PackageFile[], candidates: readonly string[]): Promise<ScannedPackage[]> {
  return mapConcurrency(files, 12, async (file) => {
    const head = await readPackageHead(file.abs);
    if (!head) throw new Error(`cannot read the package head of "${file.rel}"`);
    const primary = parsePrimaryClass(head);
    if (primary !== undefined) {
      // A UE4 editor package exposes its own object's class and its exact import table, so both the
      // match and the dependency edges are read rather than guessed.
      const names = classesInHead(head, candidates);
      const imports = parseImportedPackages(head) ?? [];
      return { rel: file.rel, primaryClass: primary, classes: [...new Set([primary, ...names])], refs: imports };
    }
    // A UE5 package (or one this reader does not support) has no import-table reader here. Read its
    // whole header and take name-table class membership plus every `/Game/...` path it names. The name
    // table is a superset of the import table, and a truncated or unreadable header throws instead of
    // silently dropping a dependency from the closure.
    let header: Buffer;
    try {
      header = await readPackageHeaderRegion(file.abs);
    } catch (error) {
      throw new Error(`cannot read the Unreal package header of "${file.rel}": ${error instanceof Error ? error.message : String(error)}`);
    }
    return { rel: file.rel, classes: classesInHead(header, candidates), refs: gameReferencesInHead(header) };
  });
}

// --- import report comparison --------------------------------------------------------------------

export type PackageStatus = "converted" | "skipped" | "failed" | "absent";

export interface PackageOutcome {
  readonly status: PackageStatus;
  readonly reason?: string;
}

export interface PackageDiff {
  readonly package: string;
  readonly slice: PackageOutcome;
  readonly full: PackageOutcome;
}

const REPORT_COLLECTIONS = ["models", "textures", "cubemaps", "materialAssets", "audio", "dataAssets", "textureStacks", "dataTextures", "fonts", "bitmapFonts", "sprites", "flipbooks", "scenes", "strands"] as const;

export function packageOutcomes(report: ImportReport): Map<string, PackageOutcome> {
  const outcomes = new Map<string, PackageOutcome>();
  for (const key of REPORT_COLLECTIONS) {
    for (const item of report[key] as readonly { readonly package?: string }[]) {
      if (item.package !== undefined) outcomes.set(item.package, { status: "converted" });
    }
  }
  for (const entry of report.skipped) outcomes.set(entry.package, { status: "skipped", reason: entry.reason });
  for (const entry of report.failed) outcomes.set(entry.package, { status: "failed", reason: entry.reason });
  return outcomes;
}

/**
 * The packages of a slice whose import outcome differs from the full pack: a different status, or a
 * different reason. `selected` is the slice's own package list; every selected package is compared,
 * including one with no outcome row on either side (both absent), so a dependency the slice dropped —
 * or a selected package the importer never classified — cannot hide by emitting no row. Full-only rows
 * outside `selected` are ignored. Outcome reasons are compared exactly; when they carry absolute paths
 * that differ this is a false positive a caller must inspect.
 */
export function diffPackageOutcomes(
  slice: ReadonlyMap<string, PackageOutcome>,
  full: ReadonlyMap<string, PackageOutcome>,
  selected?: readonly string[],
): PackageDiff[] {
  const absent: PackageOutcome = { status: "absent" };
  // The slice's own emitted rows that the manifest missed stay in scope, so nothing the slice produced
  // is dropped from the comparison; full-only rows are never added.
  const packages = new Set([...(selected ?? slice.keys()), ...slice.keys()]);
  const diffs: PackageDiff[] = [];
  for (const pkg of packages) {
    const sliceOutcome = slice.get(pkg) ?? absent;
    const fullOutcome = full.get(pkg) ?? absent;
    if (sliceOutcome.status !== fullOutcome.status || (sliceOutcome.reason ?? "") !== (fullOutcome.reason ?? "")) {
      diffs.push({ package: pkg, slice: sliceOutcome, full: fullOutcome });
    }
  }
  return diffs.sort((a, b) => (a.package < b.package ? -1 : a.package > b.package ? 1 : 0));
}

// --- acquisition ---------------------------------------------------------------------------------

function downloadRoot(environment: NodeJS.ProcessEnv = process.env): string {
  return (
    environment.THREENATIVE_FAB_DOWNLOAD_DIR?.trim() ||
    join(environment.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache"), "threenative-asset-mcp", "fab-downloads")
  );
}

export function slicesRoot(environment: NodeJS.ProcessEnv = process.env): string {
  return (
    environment.FAB_FEATURE_CORPUS_DIR?.trim() ||
    join(environment.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache"), "threenative-asset-mcp", "fab-slices")
  );
}

function acquisitionDir(slice: SlicePlan): string {
  return join(downloadRoot(), "slice-acquisition", slice.id);
}

async function resolveCatalogIds(fabCli: FabCli, listingId: string, artifactId: string): Promise<{ assetId?: string; assetNamespace?: string }> {
  const entry: FabOwnedListing | undefined = (await fabCli.ownedListings()).find(
    (owned) => owned.listingId?.toLowerCase() === listingId.toLowerCase(),
  );
  if (!entry || entry.assetId === undefined || entry.assetNamespace === undefined) return {};
  void artifactId;
  return { assetId: entry.assetId, assetNamespace: entry.assetNamespace };
}

async function downloadSlice(slice: SlicePlan, log: (message: string) => void): Promise<string> {
  const target = acquisitionDir(slice);
  if (existsSync(target)) return target;
  const fabCli = new FabCli({ environment: process.env, log });
  await fabCli.requireAuthenticatedSession();
  const ids = await resolveCatalogIds(fabCli, slice.listingId, slice.artifactId);
  log(`Downloading ${slice.artifactId} into ${target}…`);
  await mkdir(target, { recursive: true });
  await fabCli.download({
    listingId: slice.listingId,
    outputDir: target,
    engine: slice.engine,
    artifactId: slice.artifactId,
    ...(ids.assetId !== undefined ? { assetId: ids.assetId } : {}),
    ...(ids.assetNamespace !== undefined ? { assetNamespace: ids.assetNamespace } : {}),
  });
  return target;
}

// --- make ----------------------------------------------------------------------------------------

interface SliceManifest {
  readonly id: string;
  readonly targetClasses: readonly string[];
  /** Selected package relative paths. */
  readonly files: readonly string[];
  /** Bulk-data sidecars copied with their owning package. */
  readonly sidecars?: readonly string[];
  readonly packageDigest: string;
  readonly bytes: number;
}

async function readSliceManifest(sliceDir: string): Promise<SliceManifest | undefined> {
  const text = await readFile(join(sliceDir, SLICE_MANIFEST), "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as SliceManifest;
  } catch {
    return undefined;
  }
}

async function makeSlice(slice: SlicePlan, fullDir: string, outRoot: string, log: (message: string) => void, perClass: number): Promise<SliceManifest> {
  const sliceDir = assertSafeChild(outRoot, slice.id);
  const files = await listPackageFiles(fullDir);
  if (files.length === 0) throw new Error(`"${fullDir}" contains no Unreal packages`);
  const candidates = new Set([...slice.targetClasses, ...SLICES.flatMap((entry) => entry.targetClasses)]);
  const scanned = await scanPackages(files, [...candidates]);
  const byRel = new Map(files.map((file) => [file.rel, file]));
  const scannedByRel = new Map(scanned.map((entry) => [entry.rel, entry]));
  // The byte budget counts each package's bulk-data sidecars, so a sidecar cannot push a slice past the
  // limit unnoticed.
  const sizeByRel = new Map(files.map((file) => [file.rel, packageBytes(file)]));
  const selected = selectSlicePackages(scanned, slice.targetClasses, perClass, (rel) => sizeByRel.get(rel) ?? 0);
  if (selected.length === 0) {
    throw new Error(`no package in "${fullDir}" names a target class of ${slice.id} (${slice.targetClasses.join(", ")})`);
  }
  const bytes = selected.reduce((sum, rel) => sum + (sizeByRel.get(rel) ?? 0), 0);
  if (bytes > SLICE_LIMIT_BYTES) {
    throw new Error(
      `${slice.id} needs ${(bytes / 1024 / 1024).toFixed(1)} MiB, above the ${SLICE_LIMIT_BYTES / 1024 / 1024} MiB total limit; narrow the target classes or pick a smaller pack rather than dropping a target`,
    );
  }
  // Preserve unrelated files: remove only what a previous slice manifest claimed, then copy. Every path
  // comes from a manifest, so validate containment and reject symlinks before deleting or writing.
  const previous = await readSliceManifest(sliceDir);
  const selectedSidecars = selected.flatMap((rel) => (byRel.get(rel)?.sidecars ?? []).map((sidecar) => sidecar.rel));
  const currentCopied = new Set([...selected, ...selectedSidecars]);
  await mkdir(sliceDir, { recursive: true });
  for (const rel of [...(previous?.files ?? []), ...(previous?.sidecars ?? [])]) {
    if (currentCopied.has(rel)) continue;
    await assertNoSymlinks(sliceDir, rel);
    await rm(join(sliceDir, rel), { force: true });
  }
  for (const rel of selected) {
    const pkg = byRel.get(rel)!;
    await assertNoSymlinks(sliceDir, rel);
    await mkdir(dirname(join(sliceDir, rel)), { recursive: true });
    await cp(pkg.abs, join(sliceDir, rel));
    for (const sidecar of pkg.sidecars) {
      await assertNoSymlinks(sliceDir, sidecar.rel);
      await mkdir(dirname(join(sliceDir, sidecar.rel)), { recursive: true });
      await cp(sidecar.abs, join(sliceDir, sidecar.rel));
    }
  }
  const manifest: SliceManifest = {
    id: slice.id,
    targetClasses: slice.targetClasses,
    files: selected,
    sidecars: selectedSidecars,
    packageDigest: packageDigest(selected),
    bytes,
  };
  await writeFile(join(sliceDir, SLICE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  const counts = classCounts(selected.map((rel) => scannedByRel.get(rel)!), slice.targetClasses);
  log(`${slice.id}: ${selected.length} packages, ${(bytes / 1024 / 1024).toFixed(1)} MiB, ${JSON.stringify(counts)}`);
  return manifest;
}

// --- verify --------------------------------------------------------------------------------------

interface VerifyResult {
  readonly slices: readonly { readonly slice: SlicePlan; readonly corpus: CorpusSlice }[];
  readonly totalBytes: number;
}

async function verifySlice(slice: SlicePlan, outRoot: string): Promise<CorpusSlice> {
  const sliceDir = assertSafeChild(outRoot, slice.id);
  if (!existsSync(sliceDir)) throw new Error(`slice ${slice.id} is not built at ${sliceDir}; run make first`);
  const files = await listPackageFiles(sliceDir);
  const scanned = await scanPackages(files, slice.targetClasses);
  const counts = classCounts(scanned, slice.targetClasses);
  const bytes = files.reduce((sum, file) => sum + packageBytes(file), 0);
  const gaps = new Set(slice.gaps ?? []);
  const missing = slice.targetClasses.filter((className) => counts[className] === 0 && !gaps.has(className));
  if (missing.length > 0) {
    throw new Error(`${slice.id} is missing target class(es): ${missing.join(", ")}`);
  }
  return {
    id: slice.id,
    listingId: slice.listingId,
    artifactId: slice.artifactId,
    engine: slice.engine,
    route: slice.route,
    targetClasses: slice.targetClasses,
    classCounts: counts,
    packages: files.length,
    bytes,
    packageDigest: packageDigest(files.map((file) => file.rel)),
    gaps: slice.gaps ?? [],
  };
}

// --- CLI -----------------------------------------------------------------------------------------

interface CliOptions {
  readonly command: "make" | "verify" | "compare-full" | "list";
  readonly slice?: string;
  readonly all: boolean;
  readonly full?: string;
  readonly out?: string;
  readonly record: boolean;
  readonly cleanup: boolean;
  readonly perClass: number;
  readonly positionals: readonly string[];
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const command = argv[0];
  if (command !== "make" && command !== "verify" && command !== "compare-full" && command !== "list") {
    throw new Error(`unknown command\n${USAGE}`);
  }
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    const value = index >= 0 ? argv[index + 1] : undefined;
    return value && !value.startsWith("--") ? value : undefined;
  };
  const slice = flag("--slice");
  const full = flag("--full");
  const out = flag("--out");
  const perClassRaw = flag("--per-class");
  const perClass = perClassRaw === undefined ? 1 : Number(perClassRaw);
  if (!Number.isInteger(perClass) || perClass < 1) throw new Error("--per-class must be a positive integer");
  return {
    command,
    all: argv.includes("--all"),
    record: argv.includes("--record"),
    cleanup: argv.includes("--cleanup"),
    perClass,
    positionals: argv.slice(1).filter((value) => !value.startsWith("--")),
    ...(slice !== undefined ? { slice } : {}),
    ...(full !== undefined ? { full } : {}),
    ...(out !== undefined ? { out } : {}),
  };
}

async function importTree(sourceDir: string, outputDir: string, engine: string | undefined, log: (message: string) => void): Promise<ImportReport> {
  return importUnrealDirectory({
    sourceDir,
    outputDir,
    sourceKind: "local-directory",
    log,
    ...(engine !== undefined ? { formatHint: engine } : {}),
  });
}

/**
 * Imports `sourceDir` into `outputDir` and propagates the importer's output-collision refusal with
 * fresh-directory guidance. It never deletes or replaces existing output: a collision means the
 * directory holds a different import (or unrelated files) this tool did not create, so only the caller
 * can pick a new one. `runImport` is injected so a regression test can drive the collision path.
 */
export async function importFreshOutput(
  sourceDir: string,
  outputDir: string,
  runImport: (sourceDir: string, outputDir: string) => Promise<ImportReport>,
  log: (message: string) => void = () => {},
): Promise<ImportReport> {
  log(`Importing ${sourceDir}…`);
  try {
    return await runImport(sourceDir, outputDir);
  } catch (error) {
    if (!(error instanceof ImportError) || error.code !== "UNREAL_OUTPUT_COLLISION") throw error;
    throw new ImportError(
      "UNREAL_OUTPUT_COLLISION",
      `${outputDir} already holds a different import; this tool never deletes or overwrites existing output. Choose a fresh output directory. (${error.message})`,
      error.retryable,
    );
  }
}

async function runCompareFull(slice: SlicePlan, fullDir: string, outRoot: string, log: (message: string) => void): Promise<number> {
  const sliceDir = assertSafeChild(outRoot, slice.id);
  if (!existsSync(sliceDir)) throw new Error(`slice ${slice.id} is not built at ${sliceDir}; run make first`);
  const manifest = await readSliceManifest(sliceDir);
  if (!manifest) throw new Error(`slice ${slice.id} has no ${SLICE_MANIFEST}; run make first`);
  const selected = manifest.files.filter((rel) => PACKAGE_EXTENSIONS.has(extname(rel).toLowerCase()));
  const work = join(outRoot, "compare", slice.id);
  await mkdir(work, { recursive: true });
  // No script-level report cache: the importer reuses its own report only when the importer version and
  // the source-tree hash still match, so a warm report cannot prove a changed importer correct, and the
  // long full-pack import stays resumable because a matching report is returned as `reused`. A stale
  // report at the output is refused, never deleted and replaced: the output may be an import this task
  // did not create, so the collision propagates and the caller chooses a fresh directory.
  const runImport = (sourceDir: string, outputDir: string): Promise<ImportReport> => importTree(sourceDir, outputDir, slice.engine, log);
  const sliceReport = await importFreshOutput(sliceDir, join(work, "slice"), runImport, log);
  const fullReport = await importFreshOutput(fullDir, join(work, "full"), runImport, log);
  const sliceOutcomes = packageOutcomes(sliceReport);
  const fullOutcomes = packageOutcomes(fullReport);
  const diffs = diffPackageOutcomes(sliceOutcomes, fullOutcomes, selected);
  // Selected packages with no row on either side are still compared (both absent); record them so the
  // "nothing differs" claim is not mistaken for "every package emitted a row". Full-only rows outside
  // the slice are ignored, and counted, so that is explicit too.
  const bothAbsent = selected.filter((pkg) => !sliceOutcomes.has(pkg) && !fullOutcomes.has(pkg));
  const ignoredFullOnly = [...fullOutcomes.keys()].filter((pkg) => !selected.includes(pkg));
  const outPath = join(work, "compare.json");
  await writeFile(outPath, `${JSON.stringify({ slice: slice.id, selected: selected.length, sliceRows: sliceOutcomes.size, bothAbsent, ignoredFullOnly: ignoredFullOnly.length, diffs }, null, 2)}\n`);
  if (diffs.length === 0) {
    log(`${slice.id}: all ${selected.length} selected packages match the full pack (${bothAbsent.length} absent on both sides). Report: ${outPath}`);
    return 0;
  }
  for (const diff of diffs.slice(0, 40)) {
    log(`${diff.package}: slice ${diff.slice.status} vs full ${diff.full.status}`);
  }
  log(`${slice.id}: ${diffs.length} of ${selected.length} selected packages differ. Report: ${outPath}`);
  return 1;
}

async function main(): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const outRoot = resolve(options.out ?? slicesRoot());
  const log = (message: string): void => console.error(message);

  if (options.command === "list") {
    for (const slice of SLICES) console.log(`${slice.id}\t${slice.listingId}\t${slice.artifactId}\t${slice.engine}\t${slice.targetClasses.join(",")}`);
    return 0;
  }

  if (options.command === "make") {
    // `--all` builds only what has a full pack on disk: an optional slice whose pack is absent (the
    // GASP 5.4 default) is skipped rather than failing the whole run. `verify` still fails when a
    // required slice is missing, so a skip here can never pass unnoticed.
    const targets = options.all
      ? SLICES.filter((slice) => {
          const full = options.full ?? slice.defaultFull;
          return (full !== undefined && existsSync(full)) || existsSync(acquisitionDir(slice));
        })
      : [findSlice(options.slice ?? options.positionals[0] ?? "")];
    if (targets.length === 0) throw new Error(`nothing to make\n${USAGE}`);
    for (const slice of targets) {
      const full = options.full ?? slice.defaultFull ?? (await downloadSlice(slice, log));
      await makeSlice(slice, resolve(full), outRoot, log, options.perClass);
      if (options.cleanup) await cleanupAcquisition(slice, full, log);
    }
  }

  if (options.command === "verify" || (options.command === "make" && options.record)) {
    const builtIds = new Set(SLICES.filter((slice) => existsSync(assertSafeChild(outRoot, slice.id))).map((slice) => slice.id));
    const missing = missingRequiredSlices(SLICES, builtIds);
    if (missing.length > 0) {
      throw new Error(`required slice(s) not built under ${outRoot}: ${missing.map((slice) => slice.id).join(", ")}; run make first`);
    }
    const corpus = await readCorpus(corpusPath());
    const slices: CorpusSlice[] = [];
    let totalBytes = 0;
    for (const slice of SLICES) {
      if (!builtIds.has(slice.id)) continue;
      const built = await verifySlice(slice, outRoot);
      slices.push(built);
      totalBytes += built.bytes;
    }
    const previous = new Map(corpus.slices.map((entry) => [entry.id, entry]));
    const merged = slices.map((entry) => {
      const before = previous.get(entry.id);
      if (before && JSON.stringify(before) !== JSON.stringify(entry) && !options.record) {
        throw new Error(`${entry.id} differs from docs/parity/feature-corpus.json; re-run with --record to update`);
      }
      return entry;
    });
    if (options.record) await writeCorpus(corpusPath(), { version: 1, limitBytes: SLICE_LIMIT_BYTES, slices: merged });
    console.log(`slices: ${merged.length}, total ${(totalBytes / 1024 / 1024).toFixed(1)} MiB of ${SLICE_LIMIT_BYTES / 1024 / 1024} MiB`);
    for (const entry of merged) console.log(`${entry.id}\t${entry.packages} pkgs\t${(entry.bytes / 1024 / 1024).toFixed(1)} MiB\t${JSON.stringify(entry.classCounts)}`);
    if (totalBytes > SLICE_LIMIT_BYTES) {
      console.error(`total ${(totalBytes / 1024 / 1024).toFixed(1)} MiB exceeds the ${SLICE_LIMIT_BYTES / 1024 / 1024} MiB limit`);
      return 1;
    }
  }

  if (options.command === "compare-full") {
    const slice = findSlice(options.slice ?? options.positionals[0] ?? "");
    const full = options.full ?? slice.defaultFull ?? acquisitionDir(slice);
    return runCompareFull(slice, resolve(full), outRoot, log);
  }

  return 0;
}

/** Deletes a full download only when this task created it, never a shared or pre-existing pack. */
async function cleanupAcquisition(slice: SlicePlan, full: string, log: (message: string) => void): Promise<void> {
  const resolved = resolve(full);
  if (resolved !== resolve(acquisitionDir(slice))) return;
  await rm(resolved, { recursive: true, force: true });
  log(`Removed lane-local acquisition ${resolved}`);
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
