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
import { mkdirSync, readdirSync } from "node:fs";
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
  PARITY_USAGE,
  parityLine,
  parseParityArgs,
  readPreviousEntries,
  selectResume,
  SweepLockHeldError,
  summarizeEntries,
  summaryOf,
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

  const runId = `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}-${randomBytes(3).toString("hex")}`;
  const runRoot = join(fabDownloadRoot(process.env), `parity-${runId}`);
  const environment: NodeJS.ProcessEnv = { ...process.env, THREENATIVE_FAB_DOWNLOAD_DIR: runRoot };
  const scorecardPath = join(args.out, "scorecard.json");

  let entries: ScorecardEntry[] = [];
  let skipped: SkippedEntry[] = [];
  let importerVersion: number | null = null;
  let cue4parse: string | null = null;
  const cleanups: Array<() => Promise<void>> = [];
  let finishing = false;

  const writeScorecard = (): Scorecard => {
    const scorecard: Scorecard = {
      generatedAt: new Date().toISOString(),
      host: { load1: loadavg()[0] ?? 0, platform: platform() },
      toolchain: { importerVersion, cue4parse },
      entries,
      skipped,
      summary: summarizeEntries(entries),
    };
    writeJsonAtomic(scorecardPath, scorecard);
    return scorecard;
  };

  /** Deletes the run's downloads and any temp output, then reports what is left. */
  const sweepCleanup = async (): Promise<void> => {
    for (const cleanup of cleanups.splice(0)) await cleanup().catch(() => {});
    if (!args.keep) await rm(runRoot, { recursive: true, force: true }).catch(() => {});
  };
  const leftovers = (): { downloads: number; tmp: number } => {
    let downloads = 0;
    try {
      downloads = readdirSync(runRoot).length;
    } catch {
      downloads = 0;
    }
    const tmp = readdirSync(tmpdir()).filter((name) => name.startsWith(TMP_PREFIX)).length;
    return { downloads, tmp };
  };

  const finish = async (code: number): Promise<number> => {
    finishing = true;
    await sweepCleanup();
    const scorecard = writeScorecard();
    lock.release();
    const left = leftovers();
    say(`LEFTOVER downloads=${left.downloads} tmp=${left.tmp}${args.keep ? " (--keep)" : ""}`);
    say(parityLine(scorecard.summary));
    return code;
  };

  const onSignal = (signal: NodeJS.Signals) => {
    if (finishing) return;
    console.error(`${signal}: cleaning up and stopping.`);
    void finish(130).then((code) => process.exit(code));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    const fabCli = new FabCli({ environment });
    try {
      await fabCli.requireAuthenticatedSession();
    } catch (error) {
      console.error(`Fab session unusable: ${error instanceof Error ? error.message : String(error)}`);
      lock.release();
      return 2;
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
      lock.release();
      return 1;
    }

    let todo: CorpusEntry[] = corpus.entries;
    if (args.resume) {
      const resumed = selectResume(corpus.entries, readPreviousEntries(scorecardPath));
      todo = resumed.todo;
      entries = resumed.kept;
      say(`Resuming: ${resumed.kept.length} settled, ${todo.length} to run.`);
    }
    say(`Sweeping ${todo.length} artifact(s) from ${new Set(todo.map((e) => e.listingId)).size} listing(s); skipped ${skipped.length}. Run ${runId}.`);
    writeScorecard();

    const handler = createFabImportAssetHandler({ environment });
    let fatal: HandlerError | undefined;

    for (const [index, item] of todo.entries()) {
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

      entries = upsertEntry(entries, entry);
      writeScorecard();
      say(`    ${entry.status}${entry.reasons.length > 0 ? ` - ${entry.reasons.join("; ")}` : ""} (${(entry.durationMs / 1000).toFixed(1)}s)`);

      if (fatal) {
        console.error(`Stopping the sweep: ${fatal.code}: ${fatal.message}`);
        return await finish(2);
      }
    }
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
