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
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, rmdir } from "node:fs/promises";
import { loadavg, platform, tmpdir } from "node:os";
import { join } from "node:path";

import { FabCli } from "../src/fab/fabcli.js";
import { dumpEngineArg } from "../src/fab/routes.js";
import { createFabImportAssetHandler, fabDownloadRoot } from "../src/tools/import-unreal.js";
import type { ImportReport } from "../src/unreal/importer.js";
import { scorePack } from "../src/unreal/parity.js";
import {
  acquireLock,
  buildCorpus,
  failureClasses,
  isFatalHandlerError,
  licencesReader,
  mergeScorecardEntries,
  PARITY_USAGE,
  parseLicencesFile,
  parityLine,
  parseParityArgs,
  readBaselineS4Misses,
  readPreviousEntries,
  s4Delta,
  s4DeltaLine,
  s4MissCount,
  selectResume,
  SweepLockHeldError,
  summarizeEntries,
  summaryOf,
  unsupportedNodeLines,
  upsertEntry,
  writeJsonAtomic,
  type CorpusEntry,
  type HandlerError,
  type Scorecard,
  type ScorecardEntry,
  type SkippedEntry,
} from "../src/unreal/parity-run.js";
import { dumpUnrealProperties } from "../src/unreal/property-dump.js";

const HIGH_LOAD = 20;
const TMP_PREFIX = "tn-parity-";
const RUN_TMP_PREFIX = "tn-parity-run-";
const SIGNAL_GRACE_MS = 2000;

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

/** Every process below this one (children, grandchildren), via pgrep; best effort. */
function descendantPids(root = process.pid): number[] {
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
  return found;
}

function signalDescendants(signal: NodeJS.Signals): void {
  for (const pid of descendantPids()) {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

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

  const realTmp = tmpdir();
  const downloadParent = fabDownloadRoot(process.env);
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

  const onSignal = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true; // stop starting new work; the loop checks this
    console.error(`${signal}: stopping children, cleaning up.`);
    void (async () => {
      // The handler's children are spawned deep inside it, so they are found by walking the tree.
      signalDescendants("SIGTERM");
      const deadline = Date.now() + SIGNAL_GRACE_MS;
      while (Date.now() < deadline && descendantPids().length > 0) await sleep(100);
      signalDescendants("SIGKILL");
      process.exit(await finish(130));
    })();
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
      say(`Resuming: ${resumed.kept.length} settled, ${todo.length} to run.`);
    }
    say(`Sweeping ${todo.length} artifact(s) from ${new Set(todo.map((e) => e.listingId)).size} listing(s); skipped ${skipped.length}. Run ${runId}.`);
    writeScorecard();

    const handler = createFabImportAssetHandler({
      environment,
      ...(licences === undefined ? {} : { readLicenses: licencesReader(licences) }),
    });
    let fatal: HandlerError | undefined;

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
        const result = await handler({
          listingIdOrUrl: item.listingId,
          outputDir,
          artifactId: item.artifactId,
          maxTextureSize: 1024,
          acceptFabEula: true,
        });
        if ("isError" in result && result.isError) {
          const error = parseHandlerError(result.content[0]?.text);
          if (isFatalHandlerError(error)) fatal = error;
          entry = {
            ...base,
            status: "error",
            reasons: [`${error.code}: ${error.message}`],
            classes: [],
            summary: null,
            durationMs: Date.now() - started,
            error: { code: error.code, message: error.message },
          };
        } else {
          const report = JSON.parse(await readFile(join(outputDir, "import-report.json"), "utf8")) as ImportReport;
          importerVersion = report.importer.version;
          cue4parse = report.toolchain.modernConverter ?? cue4parse;
          entry = await scoreOne(item, base, sourceDir, report, environment, started, args.out, label);
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

async function scoreOne(
  item: CorpusEntry,
  base: Pick<ScorecardEntry, "listingId" | "title" | "artifactId" | "engines" | "oldestEngine" | "route">,
  sourceDir: string,
  report: ImportReport,
  environment: NodeJS.ProcessEnv,
  started: number,
  out: string,
  label: string,
): Promise<ScorecardEntry> {
  const engine = item.oldestEngine === undefined ? undefined : dumpEngineArg(item.oldestEngine);
  let dump;
  try {
    dump = await dumpUnrealProperties(sourceDir, {
      ...(engine === undefined ? {} : { engine }),
      environment,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const entry: ScorecardEntry = {
      ...base,
      status: "unverified",
      reasons: [`property dump failed: ${message.slice(0, 300)}`],
      classes: ["unverified:dump-failed"],
      summary: null,
      durationMs: Date.now() - started,
    };
    writeJsonAtomic(join(out, "packs", `${label}.json`), {
      ...entry,
      importer: { version: report.importer.version },
      reused: report.reused,
    });
    return entry;
  }
  const score = scorePack(dump, report);
  const durationMs = Date.now() - started;
  writeJsonAtomic(join(out, "packs", `${label}.json`), {
    ...base,
    ...score,
    route: item.route,
    durationMs,
    importer: { version: report.importer.version },
    reused: report.reused,
  });
  return {
    ...base,
    status: score.status,
    reasons: score.reasons,
    classes: failureClasses(score),
    summary: summaryOf(score),
    durationMs,
  };
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
