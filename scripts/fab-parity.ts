/**
 * PRD-537 parity sweep: import every owned Fab Unreal artifact through the real fab_import_asset
 * handler, score it against its own package, and write a scorecard. Sequential by design.
 *
 *   npm run parity:fab -- --help
 *
 * Downloads are licensed, not redistributable: they live in a per-run cache directory and are
 * deleted after each pack unless --keep is given. Nothing from a pack is written under the repo.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, rmdirSync, statSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, rmdir } from "node:fs/promises";
import { loadavg, platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { FabCli } from "../src/fab/fabcli.js";
import { dumpEngineArg } from "../src/fab/routes.js";
import { createFabImportAssetHandler, fabDownloadRoot } from "../src/tools/import-unreal.js";
import { importUnrealDirectory, type ImportReport } from "../src/unreal/importer.js";
import { captureMaterialMetadata, type MaterialMetadataEntry, writeMaterialMetadataDump } from "../src/unreal/material-metadata.js";
import { colouredGlbKeys, renderContactSheet } from "../src/unreal/contact-sheet.js";
import { findThumbnails } from "../src/unreal/package-thumbnail.js";
import { scorePack } from "../src/unreal/parity.js";
import {
  acquireLock,
  buildCorpus,
  carriedOverEntries,
  DOWNLOAD_RETRY_DELAYS_MS,
  emergencyCleanup,
  failureClasses,
  isFatalHandlerError,
  licencesReader,
  mergeScorecardEntries,
  PARITY_USAGE,
  blankTileWarnings,
  parseLicencesFile,
  parityLine,
  parseParityArgs,
  readBaselineS4Misses,
  readPreviousEntries,
  runWithRetries,
  s4Delta,
  s4DeltaLine,
  s4MissCount,
  selectResume,
  SweepLockHeldError,
  summarizeEntries,
  entryFromHandlerError,
  summaryOf,
  unsupportedNodeLines,
  upsertEntry,
  withTextureProof,
  writeJsonAtomic,
  type CorpusEntry,
  type CorpusMode,
  type HandlerError,
  type Scorecard,
  type EntrySheet,
  type ScorecardEntry,
  type SkippedEntry,
} from "../src/unreal/parity-run.js";
import { dumpUnrealProperties } from "../src/unreal/property-dump.js";
import { ensureModernConverter } from "../src/unreal/provision.js";
import {
  crossDecodeProof,
  flattenProofSources,
  proveTextures,
  sampleEvenly,
  type CrossDecodeProof,
  type TextureProof,
} from "../src/unreal/texture-proof.js";

const HIGH_LOAD = 20;
/** Textures cross-decoded with CUE4Parse per UE Viewer pack. */
const CROSS_DECODE_SAMPLE = 6;
/** Most textures image-diffed per pack; `PARITY_PROOF_SAMPLE` overrides. */
const PROOF_SAMPLE = Number(process.env.PARITY_PROOF_SAMPLE) > 0 ? Number(process.env.PARITY_PROOF_SAMPLE) : 500;

/**
 * S5 proof state of the pack being imported. The importer deletes its staging PNGs (the exporter's
 * pixels) when it returns, so the identity proof runs inside its `proofSources` hook, and the few
 * UE Viewer PNGs the cross-decode needs are copied out for after scoring.
 */
interface PackProof {
  texture?: TextureProof;
  /** Why the proof could not run; the pack is then unproven, not failed. */
  error?: string;
  /** Copies of the sampled UE Viewer PNGs, by texture name. */
  crossSources?: Map<string, string>;
}
const TMP_PREFIX = "tn-parity-";
const RUN_TMP_PREFIX = "tn-parity-run-";

/** Number of files (recursively) under `root`; 0 when it does not exist. */
function countFiles(root: string): number {
  let count = 0;
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return 0;
  }
  for (const name of names) {
    const path = join(root, name);
    try {
      if (statSync(path).isDirectory()) count += countFiles(path);
      else count++;
    } catch {
      /* vanished */
    }
  }
  return count;
}

function say(message: string): void {
  console.log(message);
}

async function main(): Promise<number> {
  let args;
  try {
    args = parseParityArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(PARITY_USAGE);
    return 1;
  }
  if (args.help) {
    say(PARITY_USAGE);
    return 0;
  }
  if (args.exportMetadata !== undefined) {
    say(`Metadata dumps in ${args.exportMetadata} hold licensed pack names: local-only, never commit them.`);
  }

  // Validate before anything is created or downloaded: a bad file exits 2.
  let licences: Record<string, string[]> | undefined;
  if (args.licencesFile !== undefined) {
    try {
      licences = parseLicencesFile(args.licencesFile);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }

  const load1 = loadavg()[0] ?? 0;
  if (load1 > HIGH_LOAD) {
    console.warn(`WARNING: load average ${load1.toFixed(1)} is above ${HIGH_LOAD}; expect slow, timing-sensitive packs.`);
  }

  mkdirSync(join(args.out, "packs"), { recursive: true });
  let lock;
  try {
    lock = acquireLock(join(args.out, ".lock"));
  } catch (error) {
    if (error instanceof SweepLockHeldError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }

  const downloadParent = fabDownloadRoot(process.env);
  // Importer output and staging reach tens of GiB for the big packs, and /tmp is often a RAM-backed
  // tmpfs (16 GB here): a sweep there fills it and every later pack fails with a disk-space error.
  // The run scratch therefore lives beside the download root, on the same disk-backed volume.
  const scratchRoot = process.env.THREENATIVE_PARITY_TMP ?? join(dirname(downloadParent), "parity-tmp");
  mkdirSync(scratchRoot, { recursive: true });
  const realTmp = scratchRoot;
  const runId = `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${randomBytes(3).toString("hex")}`;
  const runRoot = join(downloadParent, `parity-${runId}`);
  // ALL scratch is run-scoped: every os.tmpdir() consumer (tn-parity-*, tn-property-dump-*, importer
  // temp, FabCLI/UE Viewer staging) lands in runTmp, and the importer cache lives inside it too.
  const runTmp = await mkdtemp(join(realTmp, RUN_TMP_PREFIX));
  const unrealCache = join(runTmp, "unreal-cache");
  process.env.TMPDIR = runTmp;
  process.env.THREENATIVE_UNREAL_CACHE_DIR = unrealCache;
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    THREENATIVE_FAB_DOWNLOAD_DIR: runRoot,
    THREENATIVE_UNREAL_CACHE_DIR: unrealCache,
    TMPDIR: runTmp,
    ...(args.graphBake ? {} : { THREENATIVE_GRAPH_BAKE: "0" }),
  };
  const corpusMode: CorpusMode = args.allArtifacts ? "all-artifacts" : "per-route";
  const scorecardPath = join(args.out, "scorecard.json");
  // Read before the sweep: --baseline may name the scorecard this run is about to rewrite.
  const baselineMisses = args.baseline === undefined ? null : readBaselineS4Misses(args.baseline);
  if (args.baseline !== undefined && baselineMisses === null) {
    console.warn(`WARNING: no S4 miss count could be read from ${args.baseline}; no baseline delta will be printed.`);
  }

  let entries: ScorecardEntry[] = [];
  /** Entries already on disk when a --resume run started; merged under this run's entries. */
  let previousEntries: ScorecardEntry[] = [];
  let skipped: SkippedEntry[] = [];
  let importerVersion: number | null = null;
  let cue4parse: string | null = null;
  const cleanups: Array<() => Promise<void>> = [];
  let stopping = false;
  let finishPromise: Promise<number> | undefined;
  // scorecard.json is only written once there is something to put in it: a run that dies in setup
  // (auth, ownedListings, ...) must never replace an existing scorecard with an empty one.
  let writable = false;

  const writeScorecard = (): Scorecard | undefined => {
    if (!writable) return undefined;
    const all = args.resume ? mergeScorecardEntries(previousEntries, entries) : entries;
    const summary = summarizeEntries(all);
    const now = s4MissCount(summary);
    const scorecard: Scorecard = {
      generatedAt: new Date().toISOString(),
      host: { load1: loadavg()[0] ?? 0, platform: platform() },
      toolchain: { importerVersion, cue4parse },
      graphBake: args.graphBake,
      corpus: corpusMode,
      entries: all,
      skipped,
      summary:
        baselineMisses !== null && now !== null
          ? { ...summary, s4VsBaseline: s4Delta(baselineMisses, now) }
          : summary,
    };
    writeJsonAtomic(scorecardPath, scorecard);
    return scorecard;
  };

  /** The single cleanup path: pack cleanups, then the run's downloads, importer cache and tmp. */
  const sweepCleanup = async (): Promise<void> => {
    for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => {});
    if (args.keep) return;
    await rm(runRoot, { recursive: true, force: true }).catch(() => {});
    await rm(unrealCache, { recursive: true, force: true }).catch(() => {});
    await rm(runTmp, { recursive: true, force: true }).catch(() => {});
    try {
      rmdirSync(scratchRoot); // only when empty: another sweep may share it
    } catch {
      /* not empty or already gone */
    }
  };
  const leftovers = (): { downloads: number; cache: number; tmp: number; parityDirs: number } => {
    let parityDirs = 0;
    try {
      parityDirs = readdirSync(downloadParent).filter((name) => name.startsWith("parity-")).length;
    } catch {
      parityDirs = 0;
    }
    return { downloads: countFiles(runRoot), cache: countFiles(unrealCache), tmp: countFiles(runTmp), parityDirs };
  };

  const finish = (code: number): Promise<number> => {
    finishPromise ??= (async () => {
      await sweepCleanup();
      const scorecard = writeScorecard();
      lock.release();
      const left = leftovers();
      say(
        `LEFTOVER downloads=${left.downloads} unreal-cache=${left.cache} tmp=${left.tmp} fab-downloads/parity-*=${left.parityDirs}${args.keep ? " (--keep)" : ""}`,
      );
      if (scorecard) {
        say(parityLine(scorecard.summary));
        if (scorecard.summary.s4VsBaseline) say(s4DeltaLine(scorecard.summary.s4VsBaseline));
        const top = unsupportedNodeLines(scorecard.summary);
        if (top.length > 0) say(["Top unsupported material-graph node classes:", ...top].join("\n"));
      }
      return code;
    })();
    return finishPromise;
  };

  // Everything the handler does is synchronous: it ends in process.exit, so an await would race the
  // exit and the dying children, which is how the lock and the scratch directories were left behind.
  const onSignal = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    console.error(`${signal}: stopping children, cleaning up.`);
    emergencyCleanup({
      lock,
      paths: args.keep ? [] : [runRoot, unrealCache, runTmp],
    });
    process.exit(130);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    const fabCli = new FabCli({ environment });
    try {
      await fabCli.requireAuthenticatedSession();
    } catch (error) {
      console.error(`Fab session unusable: ${error instanceof Error ? error.message : String(error)}`);
      return await finish(2);
    }
    const owned = await fabCli.ownedListings();
    const corpus = buildCorpus(owned, {
      listings: args.listings,
      artifact: args.artifact,
      limit: args.limit,
      excludeSize: args.excludeSize,
      allArtifacts: args.allArtifacts,
    });
    skipped = corpus.skipped;
    if (corpus.entries.length === 0) {
      console.error("The corpus is empty: no owned listing matches the selection.");
      return await finish(1);
    }

    let todo: CorpusEntry[] = corpus.entries;
    if (args.resume) {
      previousEntries = readPreviousEntries(scorecardPath);
      const resumed = selectResume(corpus.entries, previousEntries);
      todo = resumed.todo;
      entries = resumed.kept;
      writable = true; // previous entries are merged back in, so nothing settled can be lost
      const carried = carriedOverEntries(previousEntries, skipped).length;
      say(
        `Resuming: ${resumed.kept.length} settled, ${todo.length} to run${carried > 0 ? `, ${carried} kept from artifacts the per-route dedupe now skips` : ""}.`,
      );
    }
    say(`Sweeping ${todo.length} artifact(s) from ${new Set(todo.map((e) => e.listingId)).size} listing(s); skipped ${skipped.length}. Run ${runId}.`);
    writeScorecard();

    // --export-metadata: each pack's material resolutions, deduplicated, written once the pack imported.
    const packMaterials = new Map<string, MaterialMetadataEntry>();
    let packProof: PackProof = {};
    const proofImport: typeof importUnrealDirectory = (request) =>
      importUnrealDirectory({
        ...request,
        proofSources: async (sources, report) => {
          const state = packProof;
          try {
            const flat = await flattenProofSources(sources);
            state.texture = await proveTextures({
              report,
              outputDir: request.outputDir,
              sourceTextures: flat.sourceTextures,
              sourcesByGlb: sources,
              ambiguous: flat.ambiguous,
              maxTextureSize: request.maxTextureSize,
              sample: PROOF_SAMPLE,
            });
            const crossDir = join(dirname(request.outputDir), "cross-decode");
            await mkdir(crossDir, { recursive: true });
            state.crossSources = new Map();
            for (const name of sampleEvenly([...flat.sourceTextures.keys()].filter((n) => !flat.ambiguous.has(n)).sort(), CROSS_DECODE_SAMPLE)) {
              const copy = join(crossDir, `${name}.png`);
              await copyFile(flat.sourceTextures.get(name)!, copy);
              state.crossSources.set(name, copy);
            }
          } catch (error) {
            state.error = error instanceof Error ? error.message : String(error);
          }
        },
      });
    const handler = createFabImportAssetHandler({
      environment,
      ...(args.proof ? { importDirectory: proofImport } : {}),
      ...(licences === undefined ? {} : { readLicenses: licencesReader(licences) }),
      ...(args.exportMetadata === undefined
        ? {}
        : {
            onMaterialResolved: (request) => {
              const entry = captureMaterialMetadata(request);
              packMaterials.set(JSON.stringify(entry), entry);
            },
          }),
    });
    let fatal: HandlerError | undefined;
    // Delays are overridable (comma-separated ms, e.g. "0,0,0") so a rehearsal need not wait minutes.
    const retryDelaysMs = (process.env.PARITY_DOWNLOAD_RETRY_DELAYS_MS ?? "")
      .split(",")
      .filter((part) => part.trim() !== "")
      .map((part) => Number(part))
      .filter((n) => Number.isFinite(n) && n >= 0);
    if (retryDelaysMs.length === 0) retryDelaysMs.push(...DOWNLOAD_RETRY_DELAYS_MS);
    const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

    for (const [index, item] of todo.entries()) {
      if (stopping) break;
      const label = `${item.listingId.slice(0, 8)}-${item.artifactId}`;
      say(`[${index + 1}/${todo.length}] ${item.title} (${item.artifactId}, ${item.oldestEngine ?? "no engine"}, ${item.route})`);
      const started = Date.now();
      const sourceDir = join(runRoot, item.listingId.toLowerCase(), item.artifactId);
      const tempParent = await mkdtemp(join(tmpdir(), TMP_PREFIX));
      const outputDir = join(tempParent, "out");
      const packCleanup = async (): Promise<void> => {
        if (args.keep) return;
        await rm(sourceDir, { recursive: true, force: true });
        await rmdir(join(runRoot, item.listingId.toLowerCase())).catch(() => {});
        await rm(tempParent, { recursive: true, force: true });
      };
      cleanups.push(packCleanup);

      const base = {
        listingId: item.listingId,
        title: item.title,
        artifactId: item.artifactId,
        engines: item.engines,
        oldestEngine: item.oldestEngine,
        route: item.route,
      };
      let entry: ScorecardEntry;
      try {
        packMaterials.clear();
        const run = await runWithRetries(
          async (attemptNumber) => {
            packProof = {}; // each attempt starts with an empty proof
            if (attemptNumber > 1) {
              // A retry starts clean: drop the partial download and any half-written output.
              await rm(sourceDir, { recursive: true, force: true });
              await rm(outputDir, { recursive: true, force: true });
            }
            return handler({
              listingIdOrUrl: item.listingId,
              outputDir,
              artifactId: item.artifactId,
              maxTextureSize: 1024,
              acceptFabEula: true,
            });
          },
          {
            errorOf: (result) =>
              "isError" in result && result.isError ? parseHandlerError(result.content[0]?.text) : undefined,
            delaysMs: retryDelaysMs,
          },
          (ms) => {
            say(`    download failed; waiting ${ms / 1000}s before retrying this pack`);
            return sleepMs(ms);
          },
        );
        if (args.exportMetadata !== undefined && packMaterials.size > 0) {
          writeMaterialMetadataDump(args.exportMetadata, `${label}.json`, {
            version: 1,
            source: `fab:${label}`,
            materials: [...packMaterials.values()],
          });
        }
        if (run.kind === "error") {
          const error = run.exhausted
            ? {
                ...run.error,
                message: `${run.error.message} (after ${retryDelaysMs.length} attempts: retried ${retryDelaysMs.length} times, ${run.attempts} tries in all)`,
              }
            : run.error;
          if (isFatalHandlerError(error)) fatal = error;
          entry = entryFromHandlerError(base, error, Date.now() - started);
        } else {
          const report = JSON.parse(await readFile(join(outputDir, "import-report.json"), "utf8")) as ImportReport;
          importerVersion = report.importer.version;
          cue4parse = report.toolchain.modernConverter ?? cue4parse;
          entry = await scoreOne(item, base, sourceDir, report, environment, started, args.out, label, args.proof ? packProof : undefined);
          if (args.sheets) {
            entry = { ...entry, sheet: await sheetFor(sourceDir, outputDir, report, args.out, label) };
            for (const warning of entry.sheet?.warnings ?? []) console.log(`WARNING ${label}: ${warning}`);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        entry = {
          ...base,
          status: "error",
          reasons: [`PARITY_RUN_FAILED: ${message}`],
          classes: [],
          summary: null,
          durationMs: Date.now() - started,
          error: { code: "PARITY_RUN_FAILED", message },
        };
      } finally {
        await packCleanup().catch(() => {});
        cleanups.splice(cleanups.indexOf(packCleanup), 1);
      }

      if (stopping) break; // interrupted mid-pack: the signal path cleans up; this entry is not a result
      entries = upsertEntry(entries, entry);
      writable = true;
      writeScorecard();
      say(`    ${entry.status}${entry.reasons.length > 0 ? ` - ${entry.reasons.join("; ")}` : ""} (${(entry.durationMs / 1000).toFixed(1)}s)`);

      if (fatal) {
        console.error(`Stopping the sweep: ${fatal.code}: ${fatal.message}`);
        return await finish(2);
      }
    }
    if (stopping) return await finish(130);
    return await finish(0);
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    return await finish(1);
  }
}

function parseHandlerError(text: string | undefined): HandlerError {
  try {
    const parsed = JSON.parse(text ?? "") as Partial<HandlerError>;
    return {
      code: parsed.code ?? "UNKNOWN",
      message: parsed.message ?? "",
      retryable: parsed.retryable ?? false,
    };
  } catch {
    return { code: "UNKNOWN", message: (text ?? "").slice(0, 300), retryable: false };
  }
}

/** CUE4Parse's decode of the sampled textures against UE Viewer's, for packs UE Viewer decoded. */
async function crossDecode(
  item: CorpusEntry,
  sourceDir: string,
  proof: PackProof,
  environment: NodeJS.ProcessEnv,
  engine: string | undefined,
): Promise<CrossDecodeProof | undefined> {
  if (item.route !== "umodel" || proof.crossSources === undefined || proof.crossSources.size === 0) return undefined;
  try {
    const converter = await ensureModernConverter(environment);
    return await crossDecodeProof(sourceDir, [...proof.crossSources.keys()], {
      converterPath: converter.path,
      sourceTextures: proof.crossSources,
      engine,
      sample: CROSS_DECODE_SAMPLE,
      environment,
    });
  } catch (error) {
    return {
      status: "unavailable",
      requested: proof.crossSources.size,
      compared: 0,
      agreeing: 0,
      unavailable: proof.crossSources.size,
      sizeMismatches: 0,
      minSsim: null,
      threshold: 0.999,
      results: [{ texture: "*", status: "unavailable", reason: (error instanceof Error ? error.message : String(error)).slice(0, 240) }],
    };
  }
}

/** Renders the pack's contact sheet (non-fatal): thumbnails beside renders, judged. */
async function sheetFor(
  sourceDir: string,
  outputDir: string,
  report: ImportReport,
  out: string,
  label: string,
): Promise<EntrySheet> {
  const rel = join("sheets", `${label}.jpg`);
  const empty = { rendered: 0, total: report.models.length, thumbnails: 0, judge: { ok: 0, suspect: 0, fail: 0 } };
  try {
    await mkdir(join(out, "sheets"), { recursive: true });
    const thumbnails = await findThumbnails({ sourceDir, report });
    const result = await renderContactSheet({
      glbPaths: report.models.map((m) => join(outputDir, m.glb)),
      outPath: join(out, rel),
      title: label,
      subtitle: `${report.models.length} models | importer ${report.importer.version}`,
      selection: "spread",
      ...(thumbnails.size > 0 ? { thumbnails: new Map([...thumbnails].map(([k, v]) => [join(outputDir, k), v])) } : {}),
      expectColoured: new Set([...colouredGlbKeys(report)].map((k) => join(outputDir, k))),
    });
    const sims = result.judge.flatMap((j) => (j.similarity === undefined ? [] : [j.similarity]));
    writeJsonAtomic(join(out, "sheets", `${label}.json`), { sheet: rel, judge: result.judge });
    return {
      path: rel,
      rendered: result.meshesRendered,
      total: result.meshesTotal,
      thumbnails: result.thumbnailsShown,
      judge: result.judgeSummary,
      ...(blankTileWarnings(result.judge, result.thumbnailsShown).length > 0 ? { warnings: blankTileWarnings(result.judge, result.thumbnailsShown) } : {}),
      ...(sims.length > 0 ? { meanSimilarity: Math.round((sims.reduce((a, b) => a + b, 0) / sims.length) * 1000) / 1000 } : {}),
    };
  } catch (error) {
    return { ...empty, path: rel, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
  }
}

async function scoreOne(
  item: CorpusEntry,
  base: Pick<ScorecardEntry, "listingId" | "title" | "artifactId" | "engines" | "oldestEngine" | "route">,
  sourceDir: string,
  report: ImportReport,
  environment: NodeJS.ProcessEnv,
  started: number,
  out: string,
  label: string,
  proof: PackProof | undefined,
): Promise<ScorecardEntry> {
  const engine = item.oldestEngine === undefined ? undefined : dumpEngineArg(item.oldestEngine);
  // S5 is judged from the staging pixels captured during the import, so it does not depend on the dump.
  const cross = proof ? await crossDecode(item, sourceDir, proof, environment, engine) : undefined;
  const proofDetail = proof ? { texture: proof.texture, cross, error: proof.error } : undefined;
  const judged = (entry: ScorecardEntry): ScorecardEntry =>
    proof?.texture ? withTextureProof(entry, proof.texture, cross) : entry;
  let dump;
  try {
    dump = await dumpUnrealProperties(sourceDir, {
      ...(engine === undefined ? {} : { engine }),
      environment,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const entry = judged({
      ...base,
      status: "unverified",
      reasons: [`property dump failed: ${message.slice(0, 300)}`],
      classes: ["unverified:dump-failed"],
      summary: null,
      durationMs: Date.now() - started,
    });
    writeJsonAtomic(join(out, "packs", `${label}.json`), {
      ...entry,
      importer: { version: report.importer.version },
      reused: report.reused,
      ...(proofDetail ? { proof: proofDetail } : {}),
    });
    return entry;
  }
  const score = scorePack(dump, report);
  const durationMs = Date.now() - started;
  const entry = judged({
    ...base,
    status: score.status,
    reasons: score.reasons,
    classes: failureClasses(score),
    summary: summaryOf(score),
    durationMs,
  });
  writeJsonAtomic(join(out, "packs", `${label}.json`), {
    ...base,
    ...score,
    // The verdict after S5: a texture-identity failure turns a scored pass into a fail.
    status: entry.status,
    reasons: entry.reasons,
    route: item.route,
    durationMs,
    importer: { version: report.importer.version },
    reused: report.reused,
    ...(proofDetail ? { proof: proofDetail } : {}),
  });
  return entry;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
