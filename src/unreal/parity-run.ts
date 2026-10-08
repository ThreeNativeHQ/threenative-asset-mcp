/**
 * Pure and small-I/O helpers for the Fab parity sweep (`scripts/fab-parity.ts`, PRD-537): corpus
 * selection, scorecard aggregation, `--resume`, the single-sweep lock and argument parsing. Nothing
 * here downloads, imports or spawns anything.
 */
import {
  closeSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { FabOwnedListing } from "../fab/fabcli.js";
import { decoderRoute, oldestEngine } from "../fab/routes.js";
import type { MissAttribution, PackScore } from "./parity.js";

export type ParityRoute = "umodel" | "mesh-description" | "cue4parse" | "unknown";
export type ParityStatus = "pass" | "fail" | "unverified" | "error";

/** Listing id prefixes (8 characters) of the two packs too large for a routine sweep. */
export const SIZE_EXCLUDED_PREFIXES: readonly string[] = ["4898e707", "0281d63e"];
export const SIZE_SKIP_REASON = "skipped: size";
export const LISTING_PREFIX_LENGTH = 8;

export interface CorpusEntry {
  readonly listingId: string;
  readonly title: string;
  readonly artifactId: string;
  readonly engines: readonly string[];
  readonly oldestEngine: string | undefined;
  readonly route: ParityRoute;
}

export interface SkippedEntry {
  readonly listingId: string;
  readonly title: string;
  readonly reason: string;
}

export interface ScorecardEntry {
  readonly listingId: string;
  readonly title: string;
  readonly artifactId: string;
  readonly engines: readonly string[];
  readonly oldestEngine: string | undefined;
  readonly route: ParityRoute;
  readonly status: ParityStatus;
  readonly reasons: readonly string[];
  /** Failure classes such as `S2:bounds-axis`; the aggregate behind `topFailureClasses`. */
  readonly classes: readonly string[];
  readonly summary: {
    readonly s1: { readonly expected: number; readonly exported: number };
    readonly s2: { readonly violations: number };
    readonly s3: { readonly violations: number; readonly unverified: number };
    /** Everything beyond `share` is absent in scorecards written before PRD-538. */
    readonly s4: {
      readonly share: number;
      readonly missesTotal?: number;
      readonly expectsColour?: number;
      readonly graphBaked?: number;
      readonly graphUnsupported?: number;
      readonly graphUnavailable?: number;
      readonly unsupportedNodes?: Readonly<Record<string, number>>;
      readonly unavailableReasons?: Readonly<Record<string, number>>;
      readonly missAttribution?: MissAttribution;
    };
  } | null;
  readonly durationMs: number;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface RouteTally {
  attempted: number;
  pass: number;
  fail: number;
  unverified: number;
  error: number;
}

export interface ScorecardSummary {
  readonly attempted: number;
  readonly pass: number;
  readonly fail: number;
  readonly unverified: number;
  readonly error: number;
  /** pass / (pass + fail); null when nothing was scored. */
  readonly passRateScored: number | null;
  /** pass / attempted; null when nothing was attempted. */
  readonly passRateAttempted: number | null;
  readonly byRoute: Readonly<Record<string, RouteTally>>;
  readonly topFailureClasses: readonly { readonly class: string; readonly count: number }[];
  /** Unsupported material-graph node classes by the number of sections naming them (PRD-538). */
  readonly unsupportedNodeClasses: readonly {
    readonly class: string;
    readonly sections: number;
    readonly packs: number;
  }[];
  /** Sections whose base colour came from the graph bake. */
  readonly graphBaked: number;
  /** Total S4 misses; null when no entry carries a miss count (scorecards from before PRD-538). */
  readonly s4Misses: number | null;
  /** Where the S4 sections ended up; absent keys of old entries count as zero. */
  readonly s4MissAttribution: MissAttribution;
  /** Set by the sweep script when `--baseline` is given. */
  readonly s4VsBaseline?: S4Delta;
}

export interface S4Delta {
  readonly baseline: number;
  readonly now: number;
  /** (now - baseline) / baseline x 100; null when the baseline is 0 and the count grew. */
  readonly changePct: number | null;
}

export interface Scorecard {
  readonly generatedAt: string;
  readonly host: { readonly load1: number; readonly platform: string };
  readonly toolchain: { readonly importerVersion: number | null; readonly cue4parse: string | null };
  readonly entries: readonly ScorecardEntry[];
  readonly skipped: readonly SkippedEntry[];
  readonly summary: ScorecardSummary;
}

// --- corpus -------------------------------------------------------------------------------------

export interface CorpusOptions {
  readonly listings: readonly string[];
  readonly artifact: string | undefined;
  readonly limit: number | undefined;
  readonly excludeSize: boolean;
}

export function listingPrefix(listingId: string): string {
  return listingId.slice(0, LISTING_PREFIX_LENGTH).toLowerCase();
}

export function routeFor(engine: string | undefined): ParityRoute {
  return engine === undefined ? "unknown" : decoderRoute(engine);
}

/**
 * One entry per listing x Unreal artifact, library order. A listing the caller named explicitly is
 * never size-excluded: asking for City Sample by id is a decision, not an accident.
 */
export function buildCorpus(
  owned: readonly FabOwnedListing[],
  options: CorpusOptions,
): { readonly entries: CorpusEntry[]; readonly skipped: SkippedEntry[] } {
  const wanted = new Set(options.listings.map((id) => id.toLowerCase()));
  const entries: CorpusEntry[] = [];
  const skipped: SkippedEntry[] = [];
  for (const listing of owned) {
    const listingId = listing.listingId;
    if (listingId === undefined || listing.unrealArtifacts.length === 0) continue;
    const explicit = wanted.size > 0;
    if (explicit && !wanted.has(listingId.toLowerCase())) continue;
    if (
      !explicit &&
      options.excludeSize &&
      SIZE_EXCLUDED_PREFIXES.includes(listingPrefix(listingId))
    ) {
      skipped.push({ listingId, title: listing.title, reason: SIZE_SKIP_REASON });
      continue;
    }
    for (const artifact of listing.unrealArtifacts) {
      if (options.artifact !== undefined && artifact.artifactId !== options.artifact) continue;
      const oldest = oldestEngine(artifact.engineVersions);
      entries.push({
        listingId,
        title: listing.title,
        artifactId: artifact.artifactId,
        engines: artifact.engineVersions,
        oldestEngine: oldest,
        route: routeFor(oldest),
      });
    }
  }
  return {
    entries: options.limit === undefined ? entries : entries.slice(0, options.limit),
    skipped,
  };
}

export const entryKey = (entry: { listingId: string; artifactId: string }): string =>
  `${entry.listingId.toLowerCase()}/${entry.artifactId}`;

// --- errors -------------------------------------------------------------------------------------

export interface HandlerError {
  readonly code: string;
  readonly message: string;
  readonly retryable?: boolean;
}

/**
 * Whether a failed import means the whole sweep cannot continue (no session, keystore gone,
 * network down), as opposed to one pack that simply could not be converted.
 */
export function isFatalHandlerError(error: HandlerError): boolean {
  if (/^FABCLI_(AUTH|UNAUTH|SESSION|KEYSTORE|DOWNLOAD)/.test(error.code)) return true;
  return (
    error.code.startsWith("FABCLI_") &&
    error.retryable === false &&
    /auth|download|network/i.test(error.message)
  );
}

// --- scoring -> entry ---------------------------------------------------------------------------

export function summaryOf(score: PackScore): NonNullable<ScorecardEntry["summary"]> {
  return {
    s1: { expected: score.coverage.expected, exported: score.coverage.exported },
    s2: { violations: score.shape.violationsTotal },
    s3: { violations: score.identity.violationsTotal, unverified: score.identity.unverified },
    s4: {
      share: score.colour.share,
      missesTotal: score.colour.missesTotal,
      expectsColour: score.colour.expectsColour,
      graphBaked: score.colour.graphBaked,
      graphUnsupported: score.colour.graphUnsupported,
      graphUnavailable: score.colour.graphUnavailable,
      unsupportedNodes: score.colour.unsupportedNodes,
      unavailableReasons: score.colour.unavailableReasons,
      missAttribution: score.colour.missAttribution,
    },
  };
}

/** `S1:missing`, `S2:bounds-axis`, `S3:foreign`, `S4:grey`, or `unverified:...` for a pack. */
export function failureClasses(score: PackScore): string[] {
  const classes: string[] = [];
  if (score.status === "unverified") {
    const reason = score.reasons.find((r) => !/unreadable/.test(r)) ?? score.reasons[0] ?? "";
    classes.push(
      /no readable/.test(reason)
        ? "unverified:no-meshes"
        : /outside the dump/.test(reason)
          ? "unverified:material-outside-dump"
          : /unreadable/.test(reason)
            ? "unverified:unreadable-mesh"
            : "unverified:other",
    );
    return classes;
  }
  if (!score.coverage.ok) {
    for (let i = 0; i < score.coverage.missingTotal; i++) classes.push("S1:missing");
  }
  // Counted from the uncapped per-kind totals: `violations` is capped at PARITY_LIST_CAP.
  for (const [kind, count] of Object.entries(score.shape.byKind))
    for (let i = 0; i < count; i++) classes.push(`S2:${kind}`);
  for (const [kind, count] of Object.entries(score.identity.byKind))
    for (let i = 0; i < count; i++) classes.push(`S3:${kind}`);
  if (!score.colour.ok) classes.push("S4:grey");
  return classes;
}

// --- aggregation --------------------------------------------------------------------------------

const emptyTally = (): RouteTally => ({ attempted: 0, pass: 0, fail: 0, unverified: 0, error: 0 });

export function summarizeEntries(entries: readonly ScorecardEntry[]): ScorecardSummary {
  const total = emptyTally();
  const byRoute: Record<string, RouteTally> = {};
  const classCounts = new Map<string, number>();
  const nodeSections = new Map<string, { sections: number; packs: number }>();
  const attribution = { bakedAway: 0, bakedStillGrey: 0, unsupportedNode: 0, unavailable: 0, noGraph: 0 };
  let graphBaked = 0;
  let s4Misses: number | null = null;
  for (const entry of entries) {
    const s4 = entry.summary?.s4;
    if (s4) {
      graphBaked += s4.graphBaked ?? 0;
      if (s4.missesTotal !== undefined) s4Misses = (s4Misses ?? 0) + s4.missesTotal;
      for (const [node, sections] of Object.entries(s4.unsupportedNodes ?? {})) {
        const tally = nodeSections.get(node) ?? { sections: 0, packs: 0 };
        tally.sections += sections;
        tally.packs++;
        nodeSections.set(node, tally);
      }
      for (const key of Object.keys(attribution) as (keyof MissAttribution)[])
        attribution[key] += s4.missAttribution?.[key] ?? 0;
    }
    const tally = (byRoute[entry.route] ??= emptyTally());
    for (const target of [total, tally]) {
      target.attempted++;
      target[entry.status]++;
    }
    for (const name of entry.classes) classCounts.set(name, (classCounts.get(name) ?? 0) + 1);
    if (entry.status === "error" && entry.error) {
      const name = `error:${entry.error.code}`;
      classCounts.set(name, (classCounts.get(name) ?? 0) + 1);
    }
  }
  const scored = total.pass + total.fail;
  return {
    attempted: total.attempted,
    pass: total.pass,
    fail: total.fail,
    unverified: total.unverified,
    error: total.error,
    passRateScored: scored === 0 ? null : total.pass / scored,
    passRateAttempted: total.attempted === 0 ? null : total.pass / total.attempted,
    byRoute,
    topFailureClasses: [...classCounts]
      .map(([name, count]) => ({ class: name, count }))
      .sort((a, b) => b.count - a.count || a.class.localeCompare(b.class)),
    unsupportedNodeClasses: [...nodeSections]
      .map(([name, tally]) => ({ class: name, ...tally }))
      .sort((a, b) => b.sections - a.sections || a.class.localeCompare(b.class)),
    graphBaked,
    s4Misses,
    s4MissAttribution: attribution,
  };
}

/** The S4 miss total of a summary (PRD-538 AC-4); null when its entries predate the count. */
export function s4MissCount(summary: Pick<ScorecardSummary, "s4Misses">): number | null {
  return summary.s4Misses;
}

export function s4Delta(baseline: number, now: number): S4Delta {
  const changePct = baseline === 0 ? (now === 0 ? 0 : null) : ((now - baseline) / baseline) * 100;
  return { baseline, now, changePct };
}

export function s4DeltaLine(delta: S4Delta): string {
  const pct =
    delta.changePct === null ? "n/a" : `${delta.changePct > 0 ? "+" : ""}${delta.changePct.toFixed(1)}%`;
  return `S4 misses: ${delta.baseline} → ${delta.now} (${pct} change)`;
}

/**
 * The S4 miss total of a baseline scorecard file. Reads `summary.s4Misses`, else sums the entries,
 * and for entries from before PRD-538 falls back to `colour.missesTotal` in the per-pack file
 * `packs/<listing8>-<artifact>.json` beside the scorecard. Null when any pack cannot be counted:
 * a partial count would make the delta look better than it is.
 */
export function readBaselineS4Misses(path: string): number | null {
  let parsed: { entries?: ScorecardEntry[]; summary?: { s4Misses?: number | null } };
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as typeof parsed;
  } catch {
    return null;
  }
  const recorded = parsed.summary?.s4Misses;
  if (typeof recorded === "number") return recorded;
  let total = 0;
  for (const item of parsed.entries ?? []) {
    const s4 = item.summary?.s4;
    if (!s4) continue; // errored or unverified entries have no colour result
    let misses = s4.missesTotal;
    if (misses === undefined) {
      try {
        const label = `${item.listingId.slice(0, LISTING_PREFIX_LENGTH)}-${item.artifactId}`;
        const pack = JSON.parse(readFileSync(join(dirname(path), "packs", `${label}.json`), "utf8")) as {
          colour?: { missesTotal?: number };
        };
        misses = pack.colour?.missesTotal;
      } catch {
        misses = undefined;
      }
    }
    if (typeof misses !== "number") return null;
    total += misses;
  }
  return total;
}

/** The top node classes as `Divide x35 sections / 4 packs` lines for the sweep's final output. */
export function unsupportedNodeLines(summary: ScorecardSummary, top = 5): string[] {
  return summary.unsupportedNodeClasses
    .slice(0, top)
    .map((c) => `  ${c.class}: ${c.sections} sections in ${c.packs} pack(s)`);
}

/**
 * Prints both rates. PRD-537 AC-6 is judged on the ATTEMPTED rate (pass / attempted): a pack that
 * errored or could not be verified is not a pass, so the scored rate alone flatters the sweep.
 */
export function parityLine(summary: ScorecardSummary): string {
  const scored = summary.pass + summary.fail;
  const pct = (rate: number | null): string => (rate === null ? "n/a" : `${(rate * 100).toFixed(1)}%`);
  return `PARITY pass=${summary.pass}/${scored} (${pct(summary.passRateScored)} of scored) attempted=${summary.attempted} (${pct(summary.passRateAttempted)} of attempted) unverified=${summary.unverified} error=${summary.error}`;
}

// --- resume -------------------------------------------------------------------------------------

/** A recorded error that means "could not reach Fab", which a resumed run must try again. */
export function isAuthEntry(entry: ScorecardEntry): boolean {
  return (
    entry.status === "error" &&
    entry.error !== undefined &&
    isFatalHandlerError({ code: entry.error.code, message: entry.error.message, retryable: false })
  );
}

/**
 * Only pass, fail and unverified are settled. Every error is re-run on `--resume`: licence,
 * browser and network errors are transient, and a recorded error says nothing about the pack.
 */
export function isSettled(entry: ScorecardEntry): boolean {
  return entry.status === "pass" || entry.status === "fail" || entry.status === "unverified";
}

export function selectResume(
  corpus: readonly CorpusEntry[],
  previous: readonly ScorecardEntry[],
): { readonly todo: CorpusEntry[]; readonly kept: ScorecardEntry[] } {
  const settled = new Map<string, ScorecardEntry>();
  for (const entry of previous) if (isSettled(entry)) settled.set(entryKey(entry), entry);
  const todo: CorpusEntry[] = [];
  const kept: ScorecardEntry[] = [];
  for (const entry of corpus) {
    const done = settled.get(entryKey(entry));
    if (done) kept.push(done);
    else todo.push(entry);
  }
  return { todo, kept };
}

/** Replaces the entry with the same key, or appends it. */
export function upsertEntry(
  entries: readonly ScorecardEntry[],
  entry: ScorecardEntry,
): ScorecardEntry[] {
  const key = entryKey(entry);
  const index = entries.findIndex((existing) => entryKey(existing) === key);
  if (index < 0) return [...entries, entry];
  const next = [...entries];
  next[index] = entry;
  return next;
}

/**
 * The scorecard to write for a (possibly narrowed) `--resume` run: every entry already on disk is
 * kept in place, entries the run produced replace the ones with the same key, new ones are appended.
 * A narrowed corpus (`--listing`, `--limit`, `--artifact`) therefore never drops a settled entry.
 */
export function mergeScorecardEntries(
  previous: readonly ScorecardEntry[],
  current: readonly ScorecardEntry[],
): ScorecardEntry[] {
  let merged: ScorecardEntry[] = [...previous];
  for (const entry of current) merged = upsertEntry(merged, entry);
  return merged;
}

// --- files --------------------------------------------------------------------------------------

/** Writes beside the target and renames, so a reader never sees half a scorecard. */
export function writeJsonAtomic(path: string, value: unknown): void {
  const temporary = join(dirname(path), `.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

export function readPreviousEntries(path: string): ScorecardEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { entries?: unknown };
    return Array.isArray(parsed.entries) ? (parsed.entries as ScorecardEntry[]) : [];
  } catch {
    return [];
  }
}

// --- lock ---------------------------------------------------------------------------------------

export class SweepLockHeldError extends Error {
  constructor(
    readonly path: string,
    readonly pid: number,
  ) {
    super(`Another parity sweep holds ${path} (pid ${pid}). Wait for it or stop it first.`);
    this.name = "SweepLockHeldError";
  }
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists and belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** An unreadable pid is only believed to be abandoned once the file is this old (ms). */
export const LOCK_UNPARSEABLE_GRACE_MS = 10_000;

/**
 * A lock is stale when its recorded pid is not running. A file with an empty or unparseable pid may
 * belong to a writer between create and write, so it counts as held until it is older than
 * LOCK_UNPARSEABLE_GRACE_MS.
 */
export function isLockStale(
  content: string,
  alive: (pid: number) => boolean = isPidAlive,
  ageMs = 0,
): boolean {
  const pid = Number.parseInt(content.trim(), 10);
  if (!Number.isInteger(pid)) return ageMs > LOCK_UNPARSEABLE_GRACE_MS;
  return !alive(pid);
}

/** Creates `path` exclusively with its content already in place (hard link of a complete file). */
function createLockFile(path: string): void {
  const temporary = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(temporary, `${process.pid}\n`, { flag: "wx" });
  try {
    linkSync(temporary, path); // fails with EEXIST when the lock exists; never exposes a partial pid
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* gone */
    }
  }
}

function lockAgeMs(path: string): number {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Removes a stale lock under a short-lived `<path>.reclaim` guard, re-reading the lock inside the
 * guard: if it changed since it was judged stale, someone else already reclaimed it and nothing is
 * removed. Returns false when another reclaimer holds the guard.
 */
function reclaimStaleLock(path: string, judged: string): boolean {
  const guard = `${path}.reclaim`;
  try {
    closeSync(openSync(guard, "wx"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (lockAgeMs(guard) > LOCK_UNPARSEABLE_GRACE_MS) {
      try {
        unlinkSync(guard); // a reclaimer died holding it
      } catch {
        /* someone else cleaned it */
      }
    }
    return false;
  }
  try {
    let current: string;
    try {
      current = readFileSync(path, "utf8");
    } catch {
      return true; // already gone
    }
    if (current !== judged) return false;
    try {
      unlinkSync(path);
    } catch {
      /* gone */
    }
    return true;
  } finally {
    try {
      unlinkSync(guard);
    } catch {
      /* gone */
    }
  }
}

/** Takes `<out>/.lock` exclusively. Reclaims a stale lock; otherwise fails fast. */
export function acquireLock(
  path: string,
  alive: (pid: number) => boolean = isPidAlive,
): { release(): void } {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      createLockFile(path);
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          try {
            // Only remove a lock that is still ours.
            if (readFileSync(path, "utf8").trim() === String(process.pid)) unlinkSync(path);
          } catch {
            /* already gone */
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let content = "";
      try {
        content = readFileSync(path, "utf8");
      } catch {
        continue; // vanished between create and read: try again
      }
      if (!isLockStale(content, alive, lockAgeMs(path))) {
        throw new SweepLockHeldError(path, Number.parseInt(content.trim(), 10));
      }
      // Reclaim, then loop: the create is exclusive, so a rival that got there first makes this
      // attempt see a live lock instead of both winning.
      reclaimStaleLock(path, content);
    }
  }
  throw new SweepLockHeldError(path, -1);
}

// --- arguments ----------------------------------------------------------------------------------

export interface ParityArgs {
  readonly help: boolean;
  readonly corpus: "library";
  readonly listings: readonly string[];
  readonly artifact: string | undefined;
  readonly limit: number | undefined;
  readonly resume: boolean;
  readonly keep: boolean;
  readonly out: string;
  readonly excludeSize: boolean;
  /** A scorecard.json to compare this sweep's S4 miss count against. */
  readonly baseline: string | undefined;
}

export const PARITY_USAGE = `Usage: npm run parity:fab -- [options]

Imports every owned Fab Unreal artifact one at a time, scores it against its own package
(PRD-537 S1-S4) and writes <out>/scorecard.json. Downloads are licensed: they are deleted after
each pack unless --keep is given.

Options:
  --corpus library       Corpus to sweep (default; the only one)
  --listing <uid>        Only this listing (repeatable); overrides the size exclusion
  --artifact <id>        Only this artifact id
  --limit <N>            Stop after N corpus entries
  --resume               Skip entries already settled in <out>/scorecard.json
  --keep                 Keep downloads and import output (default: delete after each pack)
  --out <dir>            Output directory (default: artifacts/parity)
  --exclude-size         Skip City Sample and MetaHumans (default on)
  --no-exclude-size      Include them
  --baseline <file>      Compare this sweep's S4 miss count with that scorecard.json and print
                         "S4 misses: <baseline> → <now> (<pct>% change)" (PRD-538 AC-4)
  -h, --help             Print this help

Exit codes: 0 done, 1 error, 2 Fab session/download failure (partial scorecard written), 130 interrupted.`;

export function parseParityArgs(argv: readonly string[]): ParityArgs {
  let corpus: "library" = "library";
  const listings: string[] = [];
  let artifact: string | undefined;
  let limit: number | undefined;
  let resumeRun = false;
  let keep = false;
  let out = "artifacts/parity";
  let excludeSize = true;
  let help = false;
  let baseline: string | undefined;
  const value = (index: number, flag: string): string => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value.`);
    return next;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "-h":
      case "--help":
        help = true;
        break;
      case "--corpus": {
        const name = value(i++, arg);
        if (name !== "library") throw new Error(`Unknown corpus "${name}"; only "library" exists.`);
        corpus = "library";
        break;
      }
      case "--listing":
        listings.push(value(i++, arg));
        break;
      case "--artifact":
        artifact = value(i++, arg);
        break;
      case "--limit": {
        const n = Number(value(i++, arg));
        if (!Number.isInteger(n) || n < 1) throw new Error("--limit needs a positive integer.");
        limit = n;
        break;
      }
      case "--resume":
        resumeRun = true;
        break;
      case "--keep":
        keep = true;
        break;
      case "--out":
        out = value(i++, arg);
        break;
      case "--exclude-size":
        excludeSize = true;
        break;
      case "--no-exclude-size":
        excludeSize = false;
        break;
      case "--baseline":
        baseline = resolve(value(i++, arg));
        break;
      default:
        throw new Error(`Unknown option "${arg}". Use --help.`);
    }
  }
  return {
    help,
    corpus,
    listings,
    artifact,
    limit,
    resume: resumeRun,
    keep,
    out: resolve(out),
    excludeSize,
    baseline,
  };
}
