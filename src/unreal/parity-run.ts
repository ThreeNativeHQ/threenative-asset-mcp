/**
 * Pure and small-I/O helpers for the Fab parity sweep (`scripts/fab-parity.ts`, PRD-537): corpus
 * selection, scorecard aggregation, `--resume`, the single-sweep lock and argument parsing. Nothing
 * here downloads, imports or spawns anything.
 */
import { execFileSync } from "node:child_process";
import {
  closeSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

import type { FabOwnedListing } from "../fab/fabcli.js";
import { compareEngines, decoderRoute, oldestEngine } from "../fab/routes.js";
import type { MissAttribution, PackScore } from "./parity.js";
import { textureIdentityReason, type CrossDecodeProof, type TextureProof } from "./texture-proof.js";

export type ParityRoute = "umodel" | "mesh-description" | "cue4parse" | "unknown";
export type ParityStatus = "pass" | "fail" | "unverified" | "error" | "skipped";

/**
 * Listing id prefixes (8 characters) of the packs too large for a routine sweep: City Sample, MetaHumans, and
 * Common Hazel (a 4.7 GB Megascans pack whose hundreds of material packages each take ~3 minutes to decode, so one
 * pack alone ran over an hour and still had most of its materials left on 2026-10-08).
 */
export const SIZE_EXCLUDED_PREFIXES: readonly string[] = ["4898e707", "0281d63e", "81bc7ba6"];
export const SIZE_SKIP_REASON = "skipped: size";
export const LISTING_PREFIX_LENGTH = 8;

/**
 * A UID-less owned listing cannot be swept: FabCLI is invoked by listing UID, the explicit catalog
 * route (asset id + namespace) is not wired, and no licence was read for it. Its artifacts are
 * reported as skipped rather than dropped silently.
 */
export const NO_LISTING_UID_REASON =
  "no listing UID; explicit catalog route is not wired and licence is unverified";

export interface CorpusEntry {
  readonly listingId: string;
  readonly title: string;
  readonly artifactId: string;
  readonly engines: readonly string[];
  readonly oldestEngine: string | undefined;
  readonly route: ParityRoute;
}

export interface SkippedEntry {
  /** Absent for a UID-less owned listing (its artifact(s) are reported individually). */
  readonly listingId?: string;
  readonly title: string;
  /** Set for an artifact a per-route dedupe or UID-less listing dropped; absent for a size skip. */
  readonly artifactId?: string;
  readonly reason: string;
}

export type CorpusMode = "per-route" | "all-artifacts";

/** The S5 texture-identity result kept in a scorecard entry (the full detail is in the pack JSON). */
export interface EntryProof {
  readonly compared: number;
  readonly identical: number;
  /** Lowest SSIM among the compared textures; null when none were compared. */
  readonly minSsim: number | null;
  /** Compared textures whose source was downscaled by the importer first. */
  readonly resized?: number;
  /** Graph-baked textures that decoded, vary and differ from the neutral fallback / all checked. */
  readonly graph?: { readonly ok: number; readonly checked: number };
  /** UE Viewer vs CUE4Parse decode of sampled textures (umodel-route packs only). */
  readonly cross?: {
    readonly status: CrossDecodeProof["status"];
    readonly compared: number;
    readonly agreeing: number;
    readonly minSsim: number | null;
    /** Compared textures the two decoders produced at different resolutions. */
    readonly sizeMismatches?: number;
  };
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
  /** Absent for a sweep run with `--no-proof`, an unscored pack, or a scorecard from before S5. */
  readonly proof?: EntryProof;
  /** The contact sheet and visual judge result; absent for `--no-sheets` or a pack that did not import. */
  readonly sheet?: EntrySheet;
}

/** The contact sheet kept in a scorecard entry: where it is, and what the visual judge said about it. */
export interface EntrySheet {
  /** Path relative to the sweep's output directory. */
  readonly path: string;
  readonly rendered: number;
  readonly total: number;
  /** Tiles drawn beside an Unreal editor thumbnail. */
  readonly thumbnails: number;
  readonly judge: { readonly ok: number; readonly suspect: number; readonly fail: number };
  /** Mean colour similarity to the thumbnail over tiles that had a comparable one. */
  readonly meanSimilarity?: number;
  /** Why the sheet could not be made; the pack is unaffected. */
  readonly error?: string;
  /**
   * Recorded warnings (they never change S1-S5): a tile the judge found blank although Unreal drew that piece
   * (it has an editor thumbnail) means a model that renders as nothing and still scores PASS.
   */
  readonly warnings?: readonly string[];
}

/** The judge's reason for an empty render (`judgeRender`). */
const BLANK_REASON = "blank: nothing drawn";

/**
 * Warnings for blank tiles. A blank tile beside an Unreal thumbnail is a model that cannot be seen at all, which the
 * structural scorecard cannot tell (an invisible material still has textures and bindings). `thumbnailed` is how many
 * tiles had a thumbnail; every tile of a sheet built with thumbnails has one.
 */
export function blankTileWarnings(
  judge: readonly { readonly name: string; readonly reasons: readonly string[] }[],
  thumbnailed: number,
): string[] {
  if (thumbnailed <= 0) return [];
  const blank = judge.filter((tile) => tile.reasons.includes(BLANK_REASON));
  if (blank.length === 0) return [];
  const names = blank.slice(0, 5).map((tile) => tile.name).join(", ");
  return [`blank-with-thumbnail: ${blank.length} of ${judge.length} sheet tiles rendered nothing although Unreal drew them (${names}${blank.length > 5 ? ", ..." : ""})`];
}

/** The proof half of an entry: what `proveTextures` and `crossDecodeProof` found, summarised. */
export function entryProofOf(proof: TextureProof, cross?: CrossDecodeProof): EntryProof {
  return {
    compared: proof.compared,
    identical: proof.identical,
    minSsim: proof.minSsim,
    ...(proof.resized > 0 ? { resized: proof.resized } : {}),
    ...(proof.graph.checked > 0 ? { graph: { ok: proof.graph.ok, checked: proof.graph.checked } } : {}),
    ...(cross
      ? { cross: { status: cross.status, compared: cross.compared, agreeing: cross.agreeing, minSsim: cross.minSsim, sizeMismatches: cross.sizeMismatches } }
      : {}),
  };
}

/** Failure class of an S5 mismatch; one per differing texture, like the S2/S3 classes. */
export const S5_CLASS = "S5:texture-mismatch";

/**
 * Applies the S5 verdict to a scored entry. A compared exact texture that is not identical (SSIM < 1
 * after the importer's own resize) fails the pack with a reason naming the textures. Entries that
 * errored or were skipped have no scored import to judge and are left alone.
 */
export function withTextureProof(entry: ScorecardEntry, proof: TextureProof, cross?: CrossDecodeProof): ScorecardEntry {
  const base: ScorecardEntry = { ...entry, proof: entryProofOf(proof, cross) };
  const reason = textureIdentityReason(proof);
  if (reason === undefined || base.status === "error" || base.status === "skipped") return base;
  return {
    ...base,
    status: "fail",
    reasons: [...base.reasons, reason],
    classes: [...base.classes, ...Array.from({ length: proof.mismatchCount }, () => S5_CLASS)],
  };
}

/** Handler error code for a download with no Unreal packages (a code plugin or sample shell). */
export const SOURCE_EMPTY_CODE = "UNREAL_SOURCE_EMPTY";
export const SKIPPED_NO_CONTENT_CLASS = "skipped:no-importable-content";

/**
 * The scorecard entry for an import the handler refused. An empty source is correct importer
 * behaviour, not a failure: it is `skipped` and stays out of the pass-rate denominators. Every
 * other code stays an `error`.
 */
export function entryFromHandlerError(
  base: Pick<ScorecardEntry, "listingId" | "title" | "artifactId" | "engines" | "oldestEngine" | "route">,
  error: HandlerError,
  durationMs: number,
): ScorecardEntry {
  const skipped = error.code === SOURCE_EMPTY_CODE;
  return {
    ...base,
    status: skipped ? "skipped" : "error",
    reasons: [skipped ? `no importable content: ${error.message.slice(0, 160)}` : `${error.code}: ${error.message}`],
    classes: skipped ? [SKIPPED_NO_CONTENT_CLASS] : [],
    summary: null,
    durationMs,
    error: { code: error.code, message: error.message },
  };
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
  /** Entries with nothing to import; not counted in `attempted` or either rate. */
  readonly skipped: number;
  /** The skipped entries by title and artifact, so none is hidden. */
  readonly skippedNoContent: readonly { readonly title: string; readonly artifactId: string }[];
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
  /** Visual-judge tile totals over the packs with a sheet; absent for `--no-sheets` or an old scorecard. */
  readonly sheets?: { readonly packs: number; readonly ok: number; readonly suspect: number; readonly fail: number };
  /** S5 totals; absent when no entry carries a proof (a `--no-proof` sweep or an old scorecard). */
  readonly proof?: {
    readonly compared: number;
    readonly identical: number;
    /** Packs with at least one compared texture that is not identical. */
    readonly packsWithMismatch: number;
  };
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
  /** False for a `--no-graph-bake` baseline sweep (PRD-537's state). */
  readonly graphBake: boolean;
  /** `per-route`: one artifact per listing and decoder route (default); else one per artifact. */
  readonly corpus: CorpusMode;
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
  /** True keeps every artifact; false keeps one per (listing, decoder route). */
  readonly allArtifacts: boolean;
}

export function listingPrefix(listingId: string): string {
  return listingId.slice(0, LISTING_PREFIX_LENGTH).toLowerCase();
}

export function routeFor(engine: string | undefined): ParityRoute {
  return engine === undefined ? "unknown" : decoderRoute(engine);
}

/**
 * One entry per listing x decoder route, library order: of the artifacts that share a route, the
 * one whose oldest engine is newest (the tie-break of `FabCli`'s choice among artifacts; the first
 * listed wins a full tie). The rest are returned in `skipped` with the artifact that stands for
 * them. `allArtifacts`, a named `artifact` and a named listing all keep every artifact. A listing
 * the caller named explicitly is never size-excluded: asking for City Sample by id is a decision,
 * not an accident. A UID-less owned listing is never addressed; in whole-library coverage each of
 * its artifacts the selection matches is reported as skipped (`NO_LISTING_UID_REASON`), while an
 * explicit `--listing` shard, which names ids, leaves it out entirely.
 */
export function buildCorpus(
  owned: readonly FabOwnedListing[],
  options: CorpusOptions,
): { readonly entries: CorpusEntry[]; readonly skipped: SkippedEntry[] } {
  const wanted = new Set(options.listings.map((id) => id.toLowerCase()));
  const explicit = wanted.size > 0;
  const entries: CorpusEntry[] = [];
  const skipped: SkippedEntry[] = [];
  for (const listing of owned) {
    if (listing.unrealArtifacts.length === 0) continue;
    const listingId = listing.listingId;
    if (listingId === undefined) {
      // Whole-library coverage only: a --listing shard names ids, so this listing is unrelated to it.
      if (!explicit) {
        for (const artifact of listing.unrealArtifacts) {
          if (options.artifact !== undefined && artifact.artifactId !== options.artifact) continue;
          skipped.push({
            title: listing.title,
            artifactId: artifact.artifactId,
            reason: NO_LISTING_UID_REASON,
          });
        }
      }
      continue;
    }
    if (explicit && !wanted.has(listingId.toLowerCase())) continue;
    if (
      !explicit &&
      options.excludeSize &&
      SIZE_EXCLUDED_PREFIXES.includes(listingPrefix(listingId))
    ) {
      skipped.push({ listingId, title: listing.title, reason: SIZE_SKIP_REASON });
      continue;
    }
    const candidates: CorpusEntry[] = [];
    for (const artifact of listing.unrealArtifacts) {
      if (options.artifact !== undefined && artifact.artifactId !== options.artifact) continue;
      const oldest = oldestEngine(artifact.engineVersions);
      candidates.push({
        listingId,
        title: listing.title,
        artifactId: artifact.artifactId,
        engines: artifact.engineVersions,
        oldestEngine: oldest,
        route: routeFor(oldest),
      });
    }
    const dedupe = !options.allArtifacts && !explicit && options.artifact === undefined;
    if (!dedupe) {
      entries.push(...candidates);
      continue;
    }
    const winners = new Map<ParityRoute, CorpusEntry>();
    for (const candidate of candidates) {
      const current = winners.get(candidate.route);
      if (!current || newerOldestEngine(candidate, current)) winners.set(candidate.route, candidate);
    }
    for (const candidate of candidates) {
      const winner = winners.get(candidate.route)!;
      if (winner === candidate) entries.push(candidate);
      else {
        skipped.push({
          listingId,
          title: listing.title,
          artifactId: candidate.artifactId,
          reason: `same route as ${winner.artifactId}`,
        });
      }
    }
  }
  return {
    entries: options.limit === undefined ? entries : entries.slice(0, options.limit),
    skipped,
  };
}

/** Strictly newer oldest engine; an artifact with no engine never beats one that has one. */
function newerOldestEngine(a: CorpusEntry, b: CorpusEntry): boolean {
  if (a.oldestEngine === undefined) return false;
  if (b.oldestEngine === undefined) return true;
  return compareEngines(a.oldestEngine, b.oldestEngine) > 0;
}

export const entryKey = (entry: { listingId: string; artifactId: string }): string =>
  `${entry.listingId.toLowerCase()}/${entry.artifactId}`;

// --- errors -------------------------------------------------------------------------------------

export interface HandlerError {
  readonly code: string;
  readonly message: string;
  readonly retryable?: boolean;
}

export interface RetryPolicy {
  /** The same pack is worth trying again after a wait (transient CDN or network failure). */
  readonly retry: boolean;
  /** The whole sweep cannot continue (no session, keystore gone, network down). */
  readonly fatal: boolean;
}

/** Waits before retry 1, 2 and 3 of a pack whose download failed. */
export const DOWNLOAD_RETRY_DELAYS_MS: readonly number[] = [30_000, 90_000, 180_000];

/**
 * Classify a failed import. Auth, session and keystore failures are fatal: no pack can succeed.
 * A download failure (HTTP 503 from the CDN, a decode error, `exited 5`) is about one moment, so it
 * is retried and never stops the sweep. Licence refusals concern one listing and are neither.
 */
export function retryPolicyFor(error: HandlerError): RetryPolicy {
  // A licence refusal or lookup failure is about one listing; its text mentions "download".
  if (error.code.startsWith("FABCLI_LICENSE_")) return { retry: false, fatal: false };
  if (/^FABCLI_(AUTH|UNAUTH|SESSION|KEYSTORE)/.test(error.code)) return { retry: false, fatal: true };
  if (error.code === "FABCLI_DOWNLOAD_FAILED") return { retry: true, fatal: false };
  if (!error.code.startsWith("FABCLI_")) return { retry: false, fatal: false };
  if (error.retryable === false && /auth|network/i.test(error.message) && !/download/i.test(error.message)) {
    return { retry: false, fatal: true };
  }
  if (/download/i.test(error.message)) return { retry: true, fatal: false };
  return { retry: false, fatal: false };
}

/** Whether a failed import means the whole sweep cannot continue, as opposed to one pack. */
export function isFatalHandlerError(error: HandlerError): boolean {
  return retryPolicyFor(error).fatal;
}

export interface RetryOptions<T> {
  /** The handler error carried by one attempt's result, if it failed. */
  readonly errorOf: (result: T) => HandlerError | undefined;
  /** Waits before each retry; its length is the number of retries. */
  readonly delaysMs: readonly number[];
}

export type RetryRun<T> =
  | { readonly kind: "result"; readonly value: T; readonly attempts: number }
  | { readonly kind: "error"; readonly error: HandlerError; readonly attempts: number; readonly exhausted: boolean };

function thrownHandlerError(thrown: unknown): HandlerError | undefined {
  if (!(thrown instanceof Error)) return undefined;
  const code = (thrown as { code?: unknown }).code;
  if (typeof code !== "string" || !code.startsWith("FABCLI_")) return undefined;
  return { code, message: thrown.message };
}

/**
 * Run `attempt` (called with the 1-based attempt number), retrying while the error's policy says
 * so, sleeping `delaysMs[i]` before retry i+1. A non-retryable result or error comes back after one
 * attempt; a thrown error that is not a FABCLI_* error is rethrown.
 */
export async function runWithRetries<T>(
  attempt: (attemptNumber: number) => Promise<T>,
  options: RetryOptions<T>,
  sleep: (ms: number) => Promise<void>,
): Promise<RetryRun<T>> {
  for (let attempts = 1; ; attempts += 1) {
    let error: HandlerError | undefined;
    let value: T | undefined;
    try {
      value = await attempt(attempts);
      error = options.errorOf(value);
    } catch (thrown) {
      error = thrownHandlerError(thrown);
      if (error === undefined) throw thrown;
    }
    if (error === undefined) return { kind: "result", value: value as T, attempts };
    if (!retryPolicyFor(error).retry) {
      // A failed result is still a result for the caller to record; only thrown errors become "error".
      return { kind: "error", error, attempts, exhausted: false };
    }
    const delay = options.delaysMs[attempts - 1];
    if (delay === undefined) return { kind: "error", error, attempts, exhausted: true };
    await sleep(delay);
  }
}

// --- licences file ------------------------------------------------------------------------------

const LicencesFileSchema = z.record(z.string(), z.array(z.string().min(1)).min(1));

/**
 * `{ "<listingId>": ["personal", "professional"], "_source": "..." }`: licence slugs the owner read
 * from fab.com. Keys starting with `_` are notes. Throws a readable error on a bad file.
 */
export function parseLicencesFile(path: string): Record<string, string[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      error instanceof SyntaxError
        ? `Licences file ${path} is not valid JSON.`
        : `Cannot read licences file ${path}.`,
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`Licences file ${path} must be a JSON object of listing id to licence slugs.`);
  }
  const entries = Object.entries(raw).filter(([key]) => !key.startsWith("_"));
  const parsed = LicencesFileSchema.safeParse(Object.fromEntries(entries));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path[0] === undefined ? "" : ` for listing "${String(issue.path[0])}"`;
    throw new Error(
      `Licences file ${path} is invalid${where}: each listing needs a non-empty array of slug strings.`,
    );
  }
  return parsed.data;
}

/** A `readLicenses` for the import handler: the file's slugs, or a throw the gate reports as UNVERIFIED. */
export function licencesReader(
  licences: Readonly<Record<string, readonly string[]>>,
): (listingId: string) => Promise<readonly string[]> {
  const byId = new Map(Object.entries(licences).map(([id, slugs]) => [id.toLowerCase(), slugs]));
  return async (listingId) => {
    const slugs = byId.get(listingId.toLowerCase());
    if (slugs === undefined) throw new Error(`Listing ${listingId} is not in the licences file.`);
    return slugs;
  };
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
  const skippedNoContent: { title: string; artifactId: string }[] = [];
  let graphBaked = 0;
  let s4Misses: number | null = null;
  let sheetTotals: { packs: number; ok: number; suspect: number; fail: number } | undefined;
  for (const entry of entries) {
    if (entry.sheet && entry.sheet.error === undefined) {
      sheetTotals ??= { packs: 0, ok: 0, suspect: 0, fail: 0 };
      sheetTotals.packs++;
      sheetTotals.ok += entry.sheet.judge.ok;
      sheetTotals.suspect += entry.sheet.judge.suspect;
      sheetTotals.fail += entry.sheet.judge.fail;
    }
  }
  let proofTotals: { compared: number; identical: number; packsWithMismatch: number } | undefined;
  for (const entry of entries) {
    if (entry.proof) {
      proofTotals ??= { compared: 0, identical: 0, packsWithMismatch: 0 };
      proofTotals.compared += entry.proof.compared;
      proofTotals.identical += entry.proof.identical;
      if (entry.proof.identical < entry.proof.compared) proofTotals.packsWithMismatch++;
    }
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
    if (entry.status === "skipped") {
      skippedNoContent.push({ title: entry.title, artifactId: entry.artifactId });
      for (const name of entry.classes) classCounts.set(name, (classCounts.get(name) ?? 0) + 1);
      continue;
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
    skipped: skippedNoContent.length,
    skippedNoContent,
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
    ...(proofTotals ? { proof: proofTotals } : {}),
    ...(sheetTotals ? { sheets: sheetTotals } : {}),
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
  return `PARITY pass=${summary.pass}/${scored} (${pct(summary.passRateScored)} of scored) attempted=${summary.attempted} (${pct(summary.passRateAttempted)} of attempted) unverified=${summary.unverified} error=${summary.error} skipped=${summary.skipped}${summary.proof ? ` proof=${summary.proof.identical}/${summary.proof.compared}` : ""}`;
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
 * Only pass, fail, unverified and skipped (nothing to import) are settled. Every error is re-run on `--resume`: licence,
 * browser and network errors are transient, and a recorded error says nothing about the pack.
 */
export function isSettled(entry: ScorecardEntry): boolean {
  return entry.status === "pass" || entry.status === "fail" || entry.status === "unverified" || entry.status === "skipped";
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

/**
 * Settled entries already on disk for artifacts the per-route dedupe now skips. They stay in the
 * scorecard (`mergeScorecardEntries` keeps every previous entry) and are not re-run; the caller
 * reports how many there are so a smaller `todo` is not mistaken for lost work.
 */
export function carriedOverEntries(
  previous: readonly ScorecardEntry[],
  skipped: readonly SkippedEntry[],
): ScorecardEntry[] {
  const skippedKeys = new Set(
    skipped.flatMap((entry) =>
      entry.listingId === undefined || entry.artifactId === undefined
        ? []
        : [entryKey({ listingId: entry.listingId, artifactId: entry.artifactId })],
    ),
  );
  return previous.filter((entry) => isSettled(entry) && skippedKeys.has(entryKey(entry)));
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
  /** `--all-artifacts`: one corpus entry per artifact instead of per (listing, decoder route). */
  readonly allArtifacts: boolean;
  /** A scorecard.json to compare this sweep's S4 miss count against. */
  readonly baseline: string | undefined;
  /** A JSON map of listing id to licence slugs read from fab.com; replaces the anonymous lookup. */
  readonly licencesFile: string | undefined;
  /** False for `--no-graph-bake`: the importer skips graph baking (PRD-537 baseline). */
  readonly graphBake: boolean;
  /** Directory for per-pack material metadata dumps (licensed names: local-only, never commit). */
  readonly exportMetadata: string | undefined;
  /** False for `--no-proof`: skip the S5 texture-identity proofs. */
  readonly proof: boolean;
  /** False for `--no-sheets`: skip the contact sheets and the visual judge. */
  readonly sheets: boolean;
}

export const PARITY_USAGE = `Usage: npm run parity:fab -- [options]

Imports every owned Fab Unreal artifact one at a time, scores it against its own package
(PRD-537 S1-S4) and writes <out>/scorecard.json. Downloads are licensed: they are deleted after
each pack unless --keep is given.

Options:
  --corpus library       Corpus to sweep (default; the only one)
  --listing <uid>        Only this listing (repeatable); overrides the size exclusion
  --artifact <id>        Only this artifact id; overrides the per-route dedupe
  --all-artifacts        One corpus entry per artifact (default: one per listing and decoder
                         route, the artifact whose oldest engine is newest; the rest are listed
                         under "skipped" as "same route as <artifactId>")
  --limit <N>            Stop after N corpus entries
  --resume               Skip entries already settled in <out>/scorecard.json
  --keep                 Keep downloads and import output (default: delete after each pack)
  --out <dir>            Output directory (default: artifacts/parity)
  --exclude-size         Skip City Sample, MetaHumans and Common Hazel (default on)
  --no-exclude-size      Include them
  --baseline <file>      Compare this sweep's S4 miss count with that scorecard.json and print
                         "S4 misses: <baseline> → <now> (<pct>% change)" (PRD-538 AC-4)
  --licences-file <json> Licence slugs per listing, {"<listingId>": ["personal"], "_source": "..."},
                         read from fab.com by the owner. Used instead of the anonymous lookup; a
                         listing absent from it, or with non-permitted slugs, is recorded as an
                         error and the sweep continues. A bad file exits 2 before any download.
  --no-graph-bake        Import with graph baking off (THREENATIVE_GRAPH_BAKE=0): the PRD-537
                         baseline for comparing S4 misses
  --export-metadata <dir> Write <dir>/<listing8>-<artifact>.json per pack: the material texts each
                         resolution read, for replay (tests/fab-metadata.test.ts). Holds licensed
                         names: local-only, never commit.
  --proof                S5 texture-identity proofs (default on): after scoring a pack, compare every
                         exactly bound embedded texture with the exporter's PNG (image diff: SSIM, MSE)
                         and, for UE Viewer packs, cross-decode 6 sampled textures with CUE4Parse. Any
                         differing texture fails the pack ("S5 texture identity: ...")
  --no-proof             Skip the proofs
  --sheets               Contact sheet per pack (default on): <out>/sheets/<listing8>-<artifact>.jpg,
                         each piece's Unreal editor thumbnail beside its render, with a visual-judge
                         verdict per tile (white, ghost, specks, washed out, colour similarity)
  --no-sheets            Skip the sheets
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
  let allArtifacts = false;
  let help = false;
  let baseline: string | undefined;
  let licencesFile: string | undefined;
  let graphBake = true;
  let exportMetadata: string | undefined;
  let proof = true;
  let sheets = true;
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
      case "--all-artifacts":
        allArtifacts = true;
        break;
      case "--baseline":
        baseline = resolve(value(i++, arg));
        break;
      case "--licences-file":
        licencesFile = resolve(value(i++, arg));
        break;
      case "--no-graph-bake":
        graphBake = false;
        break;
      case "--export-metadata":
        exportMetadata = resolve(value(i++, arg));
        break;
      case "--proof":
        proof = true;
        break;
      case "--no-proof":
        proof = false;
        break;
      case "--sheets":
        sheets = true;
        break;
      case "--no-sheets":
        sheets = false;
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
    allArtifacts,
    baseline,
    licencesFile,
    graphBake,
    exportMetadata,
    proof,
    sheets,
  };
}

// --- interruption -------------------------------------------------------------------------------

const isZombie = (pid: number): boolean => {
  try {
    // "<pid> (<comm>) <state> ...": comm may contain spaces and parentheses, so cut at the last ")".
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) === "Z";
  } catch {
    return false;
  }
};

/**
 * Every live process below `root` (children, grandchildren), via pgrep; best effort. Zombies are
 * left out: a blocked event loop cannot reap them, and they are already dead.
 */
export function descendantPids(root = process.pid): number[] {
  const found: number[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    let output = "";
    try {
      output = execFileSync("pgrep", ["-P", String(parent)], { encoding: "utf8" });
    } catch {
      continue; // no children (exit 1) or no pgrep
    }
    for (const line of output.split("\n")) {
      const pid = Number.parseInt(line, 10);
      if (Number.isInteger(pid) && !found.includes(pid)) {
        found.push(pid);
        queue.push(pid);
      }
    }
  }
  return found.filter((pid) => !isZombie(pid));
}

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

export interface EmergencyCleanupOptions {
  /** The sweep lock to release. */
  readonly lock?: { release(): void };
  /** Directories to delete: the run's downloads, importer cache and tmp. Empty with `--keep`. */
  readonly paths: readonly string[];
  /** How long children get after SIGTERM before SIGKILL. Default 2000 ms. */
  readonly graceMs?: number;
}

/**
 * The whole cleanup of an interrupted sweep, synchronously. It runs inside the signal handler and
 * the process exits right after it, so nothing here may await: an async cleanup races the exit and
 * the dying children still writing into the directories being removed. Children are terminated
 * first (SIGTERM, then SIGKILL after the grace period), then the directories removed, then the lock
 * released. The scorecard is not touched: it is rewritten atomically after every pack.
 */
export function emergencyCleanup(options: EmergencyCleanupOptions): void {
  const signalAll = (signal: NodeJS.Signals): void => {
    for (const pid of descendantPids()) {
      try {
        process.kill(pid, signal);
      } catch {
        /* already gone */
      }
    }
  };
  const deadline = Date.now() + (options.graceMs ?? 2000);
  signalAll("SIGTERM");
  while (Date.now() < deadline && descendantPids().length > 0) sleepSync(50);
  signalAll("SIGKILL");
  // A SIGKILLed child is gone once the kernel has torn it down; give that a moment before rm.
  for (let i = 0; i < 20 && descendantPids().length > 0; i++) sleepSync(25);
  for (const path of options.paths) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* best effort: the remaining paths and the lock still go */
    }
  }
  try {
    options.lock?.release();
  } catch {
    /* already gone */
  }
}
