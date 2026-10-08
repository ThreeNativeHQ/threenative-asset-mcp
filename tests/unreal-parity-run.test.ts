import { spawn } from "node:child_process";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it, onTestFinished } from "vitest";

import type { FabOwnedListing } from "../src/fab/fabcli.js";
import type { PackScore } from "../src/unreal/parity.js";
import {
  acquireLock,
  buildCorpus,
  entryKey,
  isFatalHandlerError,
  isLockStale,
  retryPolicyFor,
  runWithRetries,
  DOWNLOAD_RETRY_DELAYS_MS,
  type HandlerError,
  isSettled,
  mergeScorecardEntries,
  readBaselineS4Misses,
  s4Delta,
  s4DeltaLine,
  s4MissCount,
  summaryOf,
  parityLine,
  parseParityArgs,
  carriedOverEntries,
  entryFromHandlerError,
  licencesReader,
  parseLicencesFile,
  readPreviousEntries,
  selectResume,
  SweepLockHeldError,
  summarizeEntries,
  upsertEntry,
  writeJsonAtomic,
  type ScorecardEntry,
} from "../src/unreal/parity-run.js";

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tn-parity-test-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function entry(partial: Partial<ScorecardEntry> & Pick<ScorecardEntry, "status">): ScorecardEntry {
  return {
    listingId: "aaaaaaaa-0000-0000-0000-000000000000",
    title: "Pack",
    artifactId: "A1",
    engines: ["UE_4.18"],
    oldestEngine: "UE_4.18",
    route: "umodel",
    reasons: [],
    classes: [],
    summary: null,
    durationMs: 1,
    ...partial,
  };
}

const listing = (listingId: string, artifacts: [string, string[]][], title = listingId): FabOwnedListing => ({
  listingId,
  title,
  url: "",
  categories: [],
  distributionMethod: "",
  unrealArtifacts: artifacts.map(([artifactId, engineVersions]) => ({
    artifactId,
    engineVersions,
    targetPlatforms: [],
  })),
});

describe("buildCorpus", () => {
  const owned = [
    listing("4898e707-7855-404b-af0e-a505ee690e68", [["City", ["UE_5.4"]]], "City Sample"),
    listing("0281d63e-0000-0000-0000-000000000000", [["MH", ["UE_5.3"]]], "MetaHumans"),
    listing("11111111-0000-0000-0000-000000000000", [
      ["Old", ["UE_5.4", "UE_4.18"]],
      ["New", ["UE_5.0", "UE_5.4"]],
    ]),
    listing("22222222-0000-0000-0000-000000000000", []),
    { ...listing("x", [["N", ["UE_4.27"]]]), listingId: undefined },
  ] satisfies FabOwnedListing[];
  const base = { listings: [], artifact: undefined, limit: undefined, excludeSize: true, allArtifacts: true };

  it("makes one entry per listing x artifact, skipping size and non-Unreal listings", () => {
    const { entries, skipped } = buildCorpus(owned, base);
    expect(entries.map((e) => [e.artifactId, e.oldestEngine, e.route])).toEqual([
      ["Old", "UE_4.18", "umodel"],
      ["New", "UE_5.0", "cue4parse"],
    ]);
    expect(skipped.map((s) => [s.title, s.reason])).toEqual([
      ["City Sample", "skipped: size"],
      ["MetaHumans", "skipped: size"],
    ]);
  });

  it("includes the large packs when asked and honours --listing, --artifact and --limit", () => {
    expect(buildCorpus(owned, { ...base, excludeSize: false }).entries).toHaveLength(4);
    expect(buildCorpus(owned, { ...base, artifact: "New" }).entries.map((e) => e.artifactId)).toEqual(["New"]);
    expect(buildCorpus(owned, { ...base, limit: 1 }).entries).toHaveLength(1);
    const named = buildCorpus(owned, { ...base, listings: ["4898E707-7855-404B-AF0E-A505EE690E68"] });
    expect(named.entries.map((e) => e.artifactId)).toEqual(["City"]);
    expect(named.skipped).toEqual([]);
  });
});

describe("summarizeEntries", () => {
  it("tallies statuses, rates, routes and failure classes", () => {
    const summary = summarizeEntries([
      entry({ status: "pass" }),
      entry({ status: "pass", artifactId: "A2", route: "cue4parse" }),
      entry({ status: "fail", artifactId: "A3", classes: ["S2:bounds-axis", "S4:grey"] }),
      entry({ status: "fail", artifactId: "A4", classes: ["S4:grey"] }),
      entry({ status: "unverified", artifactId: "A5", classes: ["unverified:dump-failed"] }),
      entry({ status: "error", artifactId: "A6", error: { code: "UNREAL_TOOL_FAILED", message: "x" } }),
    ]);
    expect(summary).toMatchObject({ attempted: 6, pass: 2, fail: 2, unverified: 1, error: 1 });
    expect(summary.passRateScored).toBeCloseTo(0.5);
    expect(summary.passRateAttempted).toBeCloseTo(2 / 6);
    expect(summary.byRoute.umodel).toEqual({ attempted: 5, pass: 1, fail: 2, unverified: 1, error: 1 });
    expect(summary.byRoute.cue4parse).toEqual({ attempted: 1, pass: 1, fail: 0, unverified: 0, error: 0 });
    expect(summary.topFailureClasses[0]).toEqual({ class: "S4:grey", count: 2 });
    expect(summary.topFailureClasses.map((c) => c.class)).toContain("error:UNREAL_TOOL_FAILED");
    expect(parityLine(summary)).toBe("PARITY pass=2/4 (50.0% of scored) attempted=6 (33.3% of attempted) unverified=1 error=1 skipped=0");
  });

  it("reports null rates for an empty run", () => {
    const summary = summarizeEntries([]);
    expect(summary.passRateScored).toBeNull();
    expect(summary.passRateAttempted).toBeNull();
    expect(parityLine(summary)).toBe("PARITY pass=0/0 (n/a of scored) attempted=0 (n/a of attempted) unverified=0 error=0 skipped=0");
  });
});

describe("skipped: no importable content", () => {
  const base = {
    listingId: "bbbbbbbb-0000-0000-0000-000000000000",
    title: "OpenRigLogic Sample Content",
    artifactId: "ORL",
    engines: ["UE_5.4"],
    oldestEngine: "UE_5.4",
    route: "cue4parse" as const,
  };
  const emptyMessage = `The source directory has no Unreal packages. ${"x".repeat(300)}`;

  it("turns UNREAL_SOURCE_EMPTY into a skipped entry and keeps every other code an error", () => {
    const skipped = entryFromHandlerError(base, { code: "UNREAL_SOURCE_EMPTY", message: emptyMessage, retryable: false }, 5);
    expect(skipped).toMatchObject({
      status: "skipped",
      classes: ["skipped:no-importable-content"],
      summary: null,
      durationMs: 5,
      error: { code: "UNREAL_SOURCE_EMPTY" },
    });
    expect(skipped.reasons).toEqual([`no importable content: ${emptyMessage.slice(0, 160)}`]);
    for (const code of ["UNREAL_TOOL_FAILED", "UNKNOWN", "FAB_AUTH_REQUIRED"]) {
      const other = entryFromHandlerError(base, { code, message: "boom", retryable: false }, 5);
      expect(other).toMatchObject({ status: "error", classes: [], reasons: [`${code}: boom`], error: { code } });
    }
  });

  it("excludes skipped entries from attempted and both rates, and lists them", () => {
    const summary = summarizeEntries([
      entry({ status: "pass" }),
      entry({ status: "fail", artifactId: "A2" }),
      entry({ ...base, status: "skipped", classes: ["skipped:no-importable-content"] }),
    ]);
    expect(summary).toMatchObject({ attempted: 2, pass: 1, fail: 1, error: 0, skipped: 1 });
    expect(summary.passRateScored).toBeCloseTo(0.5);
    expect(summary.passRateAttempted).toBeCloseTo(0.5);
    expect(summary.skippedNoContent).toEqual([{ title: base.title, artifactId: "ORL" }]);
    expect(parityLine(summary)).toBe(
      "PARITY pass=1/2 (50.0% of scored) attempted=2 (50.0% of attempted) unverified=0 error=0 skipped=1",
    );
    const onlySkipped = summarizeEntries([entry({ ...base, status: "skipped" })]);
    expect(onlySkipped.attempted).toBe(0);
    expect(onlySkipped.passRateAttempted).toBeNull();
    expect(onlySkipped.byRoute).toEqual({});
  });

  it("is settled: resume keeps it, carry-over keeps it and the merge keeps it", () => {
    const skippedEntry = entry({ ...base, status: "skipped" });
    expect(isSettled(skippedEntry)).toBe(true);
    const corpus = [{ listingId: base.listingId, title: base.title, artifactId: "ORL", engines: base.engines, oldestEngine: "UE_5.4", route: "cue4parse" as const }];
    const { todo, kept } = selectResume(corpus, [skippedEntry]);
    expect(todo).toEqual([]);
    expect(kept).toEqual([skippedEntry]);
    const dropped = [{ listingId: base.listingId, title: base.title, artifactId: "ORL", reason: "skipped: duplicate" }];
    expect(carriedOverEntries([skippedEntry], dropped)).toEqual([skippedEntry]);
    expect(mergeScorecardEntries([skippedEntry], [])).toEqual([skippedEntry]);
  });
});

describe("selectResume", () => {
  const corpus = ["A1", "A2", "A3", "A4", "A5"].map((artifactId) => ({
    listingId: "aaaaaaaa-0000-0000-0000-000000000000",
    title: "Pack",
    artifactId,
    engines: ["UE_4.18"],
    oldestEngine: "UE_4.18",
    route: "umodel" as const,
  }));

  it("keeps pass, fail and unverified; reruns every error and entries never seen", () => {
    const previous = [
      entry({ status: "pass", artifactId: "A1" }),
      entry({ status: "fail", artifactId: "A2" }),
      entry({ status: "error", artifactId: "A3", error: { code: "UNREAL_TOOL_FAILED", message: "boom" } }),
      entry({ status: "error", artifactId: "A4", error: { code: "FABCLI_UNAUTHENTICATED", message: "no session" } }),
      entry({ status: "unverified", artifactId: "A5" }),
    ];
    const { todo, kept } = selectResume(corpus, previous);
    expect(kept.map((e) => e.artifactId)).toEqual(["A1", "A2", "A5"]);
    expect(todo.map((e) => e.artifactId)).toEqual(["A3", "A4"]);
    expect(isSettled(entry({ status: "error", error: { code: "BROWSER_LAUNCH_FAILED", message: "x" } }))).toBe(false);
    expect(isSettled(entry({ status: "unverified" }))).toBe(true);
  });

  it("merges a narrowed run over the existing scorecard without losing settled entries", () => {
    const previous = [
      entry({ status: "pass", artifactId: "A1" }),
      entry({ status: "fail", artifactId: "A2" }),
      entry({ status: "error", artifactId: "A3", error: { code: "X", message: "x" } }),
      entry({ status: "unverified", artifactId: "A4" }),
    ];
    const current = [entry({ status: "pass", artifactId: "A3" }), entry({ status: "fail", artifactId: "A9" })];
    const merged = mergeScorecardEntries(previous, current);
    expect(merged.map((e) => [e.artifactId, e.status])).toEqual([
      ["A1", "pass"],
      ["A2", "fail"],
      ["A3", "pass"],
      ["A4", "unverified"],
      ["A9", "fail"],
    ]);
    expect(mergeScorecardEntries(previous, [])).toEqual(previous);
    expect(mergeScorecardEntries([], current)).toEqual(current);
  });

  it("matches listing ids case-insensitively and upserts by key", () => {
    const first = entry({ status: "fail" });
    const upper = entry({ status: "pass", listingId: first.listingId.toUpperCase() });
    expect(entryKey(first)).toBe(entryKey(upper));
    expect(upsertEntry([first], upper)).toEqual([upper]);
  });
});

describe("isFatalHandlerError", () => {
  it("stops on session failures, not on one bad pack or a transient download failure", () => {
    expect(isFatalHandlerError({ code: "FABCLI_UNAUTHENTICATED", message: "" })).toBe(true);
    expect(isFatalHandlerError({ code: "FABCLI_SESSION_EXPIRED", message: "" })).toBe(true);
    expect(isFatalHandlerError({ code: "FABCLI_DOWNLOAD_FAILED", message: "" })).toBe(false);
    expect(isFatalHandlerError({ code: "FABCLI_KEYSTORE_UNREACHABLE", message: "" })).toBe(true);
    expect(isFatalHandlerError({ code: "FABCLI_NOT_OWNED", message: "not yours", retryable: false })).toBe(false);
    expect(isFatalHandlerError({ code: "FABCLI_LICENSE_NOT_PERMITTED", message: "no" })).toBe(false);
    expect(isFatalHandlerError({ code: "UNREAL_TOOL_FAILED", message: "download of x failed", retryable: false })).toBe(false);
  });
});

describe("retryPolicyFor", () => {
  it("retries transient download failures and never treats them as fatal", () => {
    for (const message of [
      "chunk 12 download failed: HTTP 503 Service Unavailable",
      "error decoding response body",
      "fabcli exited 5",
      "",
    ]) {
      expect(retryPolicyFor({ code: "FABCLI_DOWNLOAD_FAILED", message })).toEqual({ retry: true, fatal: false });
    }
    expect(retryPolicyFor({ code: "FABCLI_UNKNOWN", message: "Download stalled", retryable: false })).toEqual({ retry: true, fatal: false });
  });

  it("makes auth, session and keystore failures fatal and not retried", () => {
    for (const code of ["FABCLI_AUTH_REQUIRED", "FABCLI_UNAUTHENTICATED", "FABCLI_SESSION_EXPIRED", "FABCLI_KEYSTORE_UNREACHABLE"]) {
      expect(retryPolicyFor({ code, message: "download failed" })).toEqual({ retry: false, fatal: true });
    }
  });

  it("leaves licence errors and other pack-level errors alone", () => {
    expect(retryPolicyFor({ code: "FABCLI_LICENSE_UNVERIFIED", message: "download no network", retryable: false })).toEqual({ retry: false, fatal: false });
    expect(retryPolicyFor({ code: "FABCLI_LICENSE_NOT_PERMITTED", message: "download auth" })).toEqual({ retry: false, fatal: false });
    expect(retryPolicyFor({ code: "FABCLI_NOT_OWNED", message: "not yours", retryable: false })).toEqual({ retry: false, fatal: false });
    expect(retryPolicyFor({ code: "UNREAL_TOOL_FAILED", message: "download of x failed", retryable: false })).toEqual({ retry: false, fatal: false });
  });
});

describe("runWithRetries", () => {
  const failure: HandlerError = { code: "FABCLI_DOWNLOAD_FAILED", message: "HTTP 503" };
  type Outcome = { error?: HandlerError; value?: string };
  const errorOf = (outcome: Outcome): HandlerError | undefined => outcome.error;
  const sleeps = (): { slept: number[]; sleep: (ms: number) => Promise<void> } => {
    const slept: number[] = [];
    return { slept, sleep: async (ms) => void slept.push(ms) };
  };

  it("defaults to 30 s, 90 s, 180 s backoff", () => {
    expect(DOWNLOAD_RETRY_DELAYS_MS).toEqual([30_000, 90_000, 180_000]);
  });

  it("succeeds on the third attempt, sleeping the first two delays", async () => {
    const { slept, sleep } = sleeps();
    const numbers: number[] = [];
    const run = await runWithRetries<Outcome>(
      async (n) => {
        numbers.push(n);
        return n < 3 ? { error: failure } : { value: "ok" };
      },
      { errorOf, delaysMs: [0, 1, 2] },
      sleep,
    );
    expect(run).toEqual({ kind: "result", value: { value: "ok" }, attempts: 3 });
    expect(numbers).toEqual([1, 2, 3]);
    expect(slept).toEqual([0, 1]);
  });

  it("gives up after the retries and returns the last error", async () => {
    const { slept, sleep } = sleeps();
    let calls = 0;
    const run = await runWithRetries<Outcome>(
      async () => {
        calls += 1;
        return { error: failure };
      },
      { errorOf, delaysMs: [30, 90, 180] },
      sleep,
    );
    expect(run).toEqual({ kind: "error", error: failure, attempts: 4, exhausted: true });
    expect(calls).toBe(4);
    expect(slept).toEqual([30, 90, 180]);
  });

  it("does not retry a fatal error", async () => {
    const { slept, sleep } = sleeps();
    const fatal: HandlerError = { code: "FABCLI_SESSION_EXPIRED", message: "log in" };
    let calls = 0;
    const run = await runWithRetries<Outcome>(
      async () => {
        calls += 1;
        return { error: fatal };
      },
      { errorOf, delaysMs: [0, 0, 0] },
      sleep,
    );
    expect(run).toEqual({ kind: "error", error: fatal, attempts: 1, exhausted: false });
    expect(calls).toBe(1);
    expect(slept).toEqual([]);
  });

  it("returns a pack-level error unchanged without retrying", async () => {
    const { slept, sleep } = sleeps();
    const licence: HandlerError = { code: "FABCLI_LICENSE_NOT_PERMITTED", message: "download not allowed" };
    const run = await runWithRetries<Outcome>(async () => ({ error: licence }), { errorOf, delaysMs: [0] }, sleep);
    expect(run).toEqual({ kind: "error", error: licence, attempts: 1, exhausted: false });
    expect(slept).toEqual([]);
  });

  it("retries a thrown FABCLI download error and rethrows anything else", async () => {
    const { sleep } = sleeps();
    const thrown = Object.assign(new Error("chunk download failed: HTTP 503"), { code: "FABCLI_DOWNLOAD_FAILED" });
    let calls = 0;
    const run = await runWithRetries<Outcome>(
      async () => {
        calls += 1;
        if (calls < 2) throw thrown;
        return { value: "ok" };
      },
      { errorOf, delaysMs: [0, 0] },
      sleep,
    );
    expect(run).toMatchObject({ kind: "result", attempts: 2 });

    const boom = new Error("disk full");
    await expect(
      runWithRetries<Outcome>(async () => { throw boom; }, { errorOf, delaysMs: [0] }, sleep),
    ).rejects.toBe(boom);
  });
});

describe("sweep lock", () => {
  it("treats a dead or unreadable pid as stale", () => {
    expect(isLockStale("123\n", () => false)).toBe(true);
    expect(isLockStale("123\n", () => true)).toBe(false);
    // An unreadable pid may be a writer between create and write: held until the file is old.
    expect(isLockStale("", () => true, 0)).toBe(false);
    expect(isLockStale("not-a-pid", () => true, 9_000)).toBe(false);
    expect(isLockStale("", () => true, 11_000)).toBe(true);
    expect(isLockStale("not-a-pid", () => true, 11_000)).toBe(true);
  });

  it("treats a fresh empty lock file as held and an old one as stale", async () => {
    const path = join(await scratch(), ".lock");
    await writeFile(path, "");
    expect(() => acquireLock(path, () => false)).toThrow(SweepLockHeldError);
    expect(await readFile(path, "utf8")).toBe("");
    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old);
    const reclaimed = acquireLock(path, () => false);
    expect(await readFile(path, "utf8")).toBe(`${process.pid}\n`);
    reclaimed.release();
  });

  it("lets only one of two racing reclaimers win a stale lock", async () => {
    const path = join(await scratch(), ".lock");
    await writeFile(path, "999999999\n");
    let rival: { release(): void } | undefined;
    let first = true;
    // While the first reclaimer is deciding the lock is stale, a second one reclaims it and wins.
    const alive = (pid: number): boolean => {
      if (first) {
        first = false;
        rival = acquireLock(path, () => false);
        return false;
      }
      return pid === process.pid;
    };
    expect(() => acquireLock(path, alive)).toThrow(SweepLockHeldError);
    expect(await readFile(path, "utf8")).toBe(`${process.pid}\n`);
    rival?.release();
  });

  it("fails fast while the holder is alive and reclaims a stale lock", async () => {
    const path = join(await scratch(), ".lock");
    const first = acquireLock(path);
    expect(await readFile(path, "utf8")).toBe(`${process.pid}\n`);
    expect(() => acquireLock(path)).toThrow(SweepLockHeldError);
    first.release();
    await expect(readFile(path, "utf8")).rejects.toThrow();

    await writeFile(path, "999999999\n");
    const reclaimed = acquireLock(path, () => false);
    expect(await readFile(path, "utf8")).toBe(`${process.pid}\n`);
    reclaimed.release();
  });
});

describe("scorecard files and arguments", () => {
  it("rewrites the scorecard atomically and reads entries back", async () => {
    const directory = await scratch();
    const path = join(directory, "scorecard.json");
    writeJsonAtomic(path, { entries: [entry({ status: "pass" })] });
    writeJsonAtomic(path, { entries: [entry({ status: "fail" })] });
    expect(readPreviousEntries(path).map((e) => e.status)).toEqual(["fail"]);
    expect(readPreviousEntries(join(directory, "missing.json"))).toEqual([]);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(directory)).toEqual(["scorecard.json"]);
  });

  it("parses the documented flags and rejects the rest", () => {
    const args = parseParityArgs(["--listing", "a", "--listing", "b", "--artifact", "X", "--limit", "3", "--resume", "--keep", "--out", "/x"]);
    expect(args).toMatchObject({ listings: ["a", "b"], artifact: "X", limit: 3, resume: true, keep: true, out: "/x", excludeSize: true });
    expect(parseParityArgs(["--help"]).help).toBe(true);
    expect(parseParityArgs([]).allArtifacts).toBe(false);
    expect(parseParityArgs(["--all-artifacts"]).allArtifacts).toBe(true);
    expect(parseParityArgs(["--no-exclude-size"]).excludeSize).toBe(false);
    expect(() => parseParityArgs(["--limit", "0"])).toThrow();
    expect(() => parseParityArgs(["--corpus", "x"])).toThrow();
    expect(() => parseParityArgs(["--wat"])).toThrow(/Unknown option/);
    expect(() => parseParityArgs(["--out"])).toThrow(/needs a value/);
  });
});

describe("buildCorpus per-route dedupe", () => {
  const perRoute = { listings: [], artifact: undefined, limit: undefined, excludeSize: true, allArtifacts: false };
  const nature = "33333333-0000-0000-0000-000000000000";
  const owned = [
    listing(
      nature,
      [
        ["N48", ["UE_4.8", "UE_4.10"]],
        ["N49", ["UE_4.9", "UE_4.10"]],
        ["N410", ["UE_4.10"]],
        ["N27", ["UE_4.27", "UE_5.0"]],
        ["N421", ["UE_4.21"]],
        ["N50", ["UE_5.0"]],
        ["N54", ["UE_5.4"]],
      ],
      "Procedural Nature",
    ),
    listing("44444444-0000-0000-0000-000000000000", [["Solo", ["UE_4.18"]]], "Solo"),
  ];

  it("keeps the artifact whose oldest engine is newest in each route, one per route", () => {
    const { entries } = buildCorpus(owned, perRoute);
    expect(entries.map((e) => [e.artifactId, e.route])).toEqual([
      ["N410", "umodel"],
      ["N27", "mesh-description"],
      ["N54", "cue4parse"],
      ["Solo", "umodel"],
    ]);
  });

  it("lets the first listed artifact win a tie on route and oldest engine", () => {
    const tied = [listing(nature, [["First", ["UE_4.10", "UE_5.0"]], ["Second", ["UE_4.10"]]])];
    expect(buildCorpus(tied, perRoute).entries.map((e) => e.artifactId)).toEqual(["First"]);
  });

  it("records every dropped artifact as skipped with the artifact that represents its route", () => {
    const { skipped } = buildCorpus(owned, perRoute);
    expect(skipped.map((s) => [s.artifactId, s.reason])).toEqual([
      ["N48", "same route as N410"],
      ["N49", "same route as N410"],
      ["N421", "same route as N27"],
      ["N50", "same route as N54"],
    ]);
    expect(skipped.every((s) => s.listingId === nature && s.title === "Procedural Nature")).toBe(true);
  });

  it("restores one entry per artifact with --all-artifacts", () => {
    const all = buildCorpus(owned, { ...perRoute, allArtifacts: true });
    expect(all.entries).toHaveLength(8);
    expect(all.skipped).toEqual([]);
  });

  it("bypasses the dedupe for a named listing or artifact", () => {
    const listed = buildCorpus(owned, { ...perRoute, listings: [nature] });
    expect(listed.entries).toHaveLength(7);
    expect(listed.skipped).toEqual([]);
    const named = buildCorpus(owned, { ...perRoute, artifact: "N48" });
    expect(named.entries.map((e) => e.artifactId)).toEqual(["N48"]);
    expect(named.skipped).toEqual([]);
  });

  it("applies --limit after the dedupe", () => {
    expect(buildCorpus(owned, { ...perRoute, limit: 2 }).entries.map((e) => e.artifactId)).toEqual(["N410", "N27"]);
  });

  it("keeps size skips next to route skips", () => {
    const city = listing("4898e707-7855-404b-af0e-a505ee690e68", [["City", ["UE_5.4"]]], "City Sample");
    const { skipped } = buildCorpus([city, ...owned], perRoute);
    expect(skipped[0]).toMatchObject({ title: "City Sample", reason: "skipped: size" });
    expect(skipped).toHaveLength(5);
  });
});

describe("resume with the per-route dedupe", () => {
  const listingId = "33333333-0000-0000-0000-000000000000";
  const owned = [listing(listingId, [["N48", ["UE_4.8"]], ["N410", ["UE_4.10"]]])];
  const opts = { listings: [], artifact: undefined, limit: undefined, excludeSize: true, allArtifacts: false };

  it("keys resume by listing and artifact and counts entries the dedupe now skips", () => {
    const { entries, skipped } = buildCorpus(owned, opts);
    const previous = [
      entry({ status: "pass", listingId, artifactId: "N48" }),
      entry({ status: "error", listingId, artifactId: "N410", error: { code: "X", message: "x" } }),
    ];
    const resumed = selectResume(entries, previous);
    // The old artifact is not re-run in its own right and the new representative is not settled.
    expect(resumed.kept).toEqual([]);
    expect(resumed.todo.map((e) => e.artifactId)).toEqual(["N410"]);
    const carried = carriedOverEntries(previous, skipped);
    expect(carried.map((e) => e.artifactId)).toEqual(["N48"]);
    // The scorecard keeps the carried entry beside the new ones.
    expect(mergeScorecardEntries(previous, []).map((e) => e.artifactId)).toContain("N48");
  });

  it("does not carry over errors or entries of artifacts that were not skipped", () => {
    const { skipped } = buildCorpus(owned, opts);
    const previous = [
      entry({ status: "error", listingId, artifactId: "N48", error: { code: "X", message: "x" } }),
      entry({ status: "pass", listingId, artifactId: "N410" }),
    ];
    expect(carriedOverEntries(previous, skipped)).toEqual([]);
  });
});

describe("emergency cleanup on SIGTERM", () => {
  it("removes the lock, scratch dirs and children before exiting 130, leaving the scorecard", async () => {
    const root = await scratch();
    const out = join(root, "out");
    const runRoot = join(root, "fab-downloads", "parity-run");
    const cache = join(root, "run-tmp", "unreal-cache");
    const runTmp = join(root, "run-tmp");
    for (const dir of [out, runRoot, cache]) mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(join(runRoot, "nested", "pack.uasset"), "x");
    writeFileSync(join(cache, "nested", "cached"), "x");
    writeFileSync(join(runTmp, "scratch"), "x");
    const scorecard = join(out, "scorecard.json");
    writeFileSync(scorecard, '{"entries":[]}');
    const lockPath = join(out, ".lock");

    const module = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "../src/unreal/parity-run.ts")).href;
    const script = join(root, "holder.mjs");
    writeFileSync(
      script,
      `import { spawn } from "node:child_process";
import { acquireLock, emergencyCleanup } from ${JSON.stringify(module)};
const [lockPath, runTmp, ...rest] = process.argv.slice(2);
const lock = acquireLock(lockPath);
// A child that ignores SIGTERM, so the cleanup has to escalate to SIGKILL.
const child = spawn("sh", ["-c", 'trap "" TERM; while :; do sleep 1; done'], { stdio: "ignore" });
process.on("SIGTERM", () => {
  emergencyCleanup({ lock, paths: [...rest, runTmp], graceMs: 300 });
  process.exit(130);
});
console.log("ready " + child.pid);
setInterval(() => {}, 1000);
`,
    );
    const holder = spawn(
      process.execPath,
      ["--import", pathToFileURL(createRequireResolve("tsx/esm")).href, script, lockPath, runTmp, runRoot, cache],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    onTestFinished(() => {
      holder.kill("SIGKILL");
    });
    let shellPid = 0;
    await new Promise<void>((resolveReady, reject) => {
      let text = "";
      holder.stdout.on("data", (chunk: Buffer) => {
        text += chunk.toString();
        const match = /ready (\d+)/.exec(text);
        if (match) {
          shellPid = Number(match[1]);
          resolveReady();
        }
      });
      holder.once("exit", (code) => reject(new Error(`holder exited ${code} before it was ready`)));
    });
    expect(existsSync(lockPath)).toBe(true);
    onTestFinished(() => {
      try {
        process.kill(shellPid, "SIGKILL");
      } catch {
        /* gone */
      }
    });

    const exit = new Promise<number | null>((done) => holder.once("exit", (code) => done(code)));
    holder.kill("SIGTERM");
    expect(await exit).toBe(130);

    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(runRoot)).toBe(false);
    expect(existsSync(cache)).toBe(false);
    expect(existsSync(runTmp)).toBe(false);
    expect(existsSync(scorecard)).toBe(true);
    expect(isAlive(shellPid)).toBe(false);
  }, 20_000);
});

function createRequireResolve(specifier: string): string {
  return createRequire(import.meta.url).resolve(specifier);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

type S4 = NonNullable<ScorecardEntry["summary"]>["s4"];
const withS4 = (s4: Partial<S4>, over: Partial<ScorecardEntry> = {}): ScorecardEntry =>
  entry({
    status: "fail",
    summary: {
      s1: { expected: 1, exported: 1 },
      s2: { violations: 0 },
      s3: { violations: 0, unverified: 0 },
      s4: { share: 0, ...s4 },
    },
    ...over,
  });

describe("graph histogram and S4 attribution (PRD-538)", () => {
  it("sums section counts per node class across packs and sorts by sections", () => {
    const summary = summarizeEntries([
      withS4({ graphBaked: 2, unsupportedNodes: { Divide: 35, Power: 3 }, missesTotal: 4 }, { artifactId: "A1" }),
      withS4({ graphBaked: 1, unsupportedNodes: { Divide: 5, Lerp: 9 }, missesTotal: 2 }, { artifactId: "A2" }),
      withS4({ unsupportedNodes: { Power: 3 }, missesTotal: 1 }, { artifactId: "A3" }),
    ]);
    expect(summary.unsupportedNodeClasses).toEqual([
      { class: "Divide", sections: 40, packs: 2 },
      { class: "Lerp", sections: 9, packs: 1 },
      { class: "Power", sections: 6, packs: 2 },
    ]);
    expect(summary.graphBaked).toBe(3);
    expect(s4MissCount(summary)).toBe(7);
  });

  it("totals the miss attribution table", () => {
    const summary = summarizeEntries([
      withS4({ missesTotal: 5, missAttribution: { bakedAway: 3, bakedStillGrey: 0, unsupportedNode: 2, unavailable: 1, noGraph: 2 } }, { artifactId: "A1" }),
      withS4({ missesTotal: 1, missAttribution: { bakedAway: 0, bakedStillGrey: 1, unsupportedNode: 0, unavailable: 0, noGraph: 0 } }, { artifactId: "A2" }),
    ]);
    expect(summary.s4MissAttribution).toEqual({ bakedAway: 3, bakedStillGrey: 1, unsupportedNode: 2, unavailable: 1, noGraph: 2 });
  });

  it("summarises entries from scorecards written before PRD-538 without crashing", () => {
    const summary = summarizeEntries([
      entry({ status: "pass" }),
      withS4({}, { artifactId: "A2" }), // s4 has only a share, as in PRD-537 scorecards
    ]);
    expect(summary.unsupportedNodeClasses).toEqual([]);
    expect(summary.graphBaked).toBe(0);
    expect(s4MissCount(summary)).toBeNull();
  });

  it("carries the graph fields from a PackScore into the entry summary", () => {
    const score = {
      coverage: { expected: 1, exported: 1, missingTotal: 0 },
      shape: { violationsTotal: 0 },
      identity: { violationsTotal: 0, unverified: 0 },
      colour: {
        share: 0.5,
        missesTotal: 2,
        expectsColour: 4,
        graphBaked: 1,
        graphUnsupported: 2,
        graphUnavailable: 0,
        unsupportedNodes: { Divide: 2 },
        unavailableReasons: {},
        missAttribution: { bakedAway: 1, bakedStillGrey: 0, unsupportedNode: 2, unavailable: 0, noGraph: 0 },
      },
    } as unknown as PackScore;
    expect(summaryOf(score).s4).toMatchObject({ share: 0.5, missesTotal: 2, graphBaked: 1, unsupportedNodes: { Divide: 2 } });
  });
});

describe("S4 baseline delta (PRD-538 AC-4)", () => {
  it("computes the percent change and formats the line", () => {
    expect(s4Delta(100, 40)).toEqual({ baseline: 100, now: 40, changePct: -60 });
    expect(s4DeltaLine(s4Delta(100, 40))).toBe("S4 misses: 100 → 40 (-60.0% change)");
    expect(s4DeltaLine(s4Delta(8, 10))).toBe("S4 misses: 8 → 10 (+25.0% change)");
    expect(s4Delta(0, 0).changePct).toBe(0);
    expect(s4Delta(0, 3).changePct).toBeNull();
    expect(s4DeltaLine(s4Delta(0, 3))).toBe("S4 misses: 0 → 3 (n/a change)");
  });

  it("reads the baseline from summary, entries, or the pack files beside an old scorecard", async () => {
    const directory = await scratch();
    const { mkdir } = await import("node:fs/promises");
    await writeFile(join(directory, "a.json"), JSON.stringify({ entries: [], summary: { s4Misses: 12 } }));
    expect(readBaselineS4Misses(join(directory, "a.json"))).toBe(12);

    const withMisses = withS4({ missesTotal: 4 }, { artifactId: "A1" });
    await writeFile(join(directory, "b.json"), JSON.stringify({ entries: [withMisses] }));
    expect(readBaselineS4Misses(join(directory, "b.json"))).toBe(4);

    // PRD-537 era: the entry has only a share; the per-pack file beside it has the miss count.
    const old = withS4({}, { artifactId: "A9", listingId: "bbbbbbbb-0000-0000-0000-000000000000" });
    await mkdir(join(directory, "packs"));
    await writeFile(join(directory, "packs", "bbbbbbbb-A9.json"), JSON.stringify({ colour: { missesTotal: 7 } }));
    await writeFile(join(directory, "c.json"), JSON.stringify({ entries: [old] }));
    expect(readBaselineS4Misses(join(directory, "c.json"))).toBe(7);

    await writeFile(join(directory, "d.json"), JSON.stringify({ entries: [old, withS4({}, { artifactId: "A8" })] }));
    expect(readBaselineS4Misses(join(directory, "d.json"))).toBeNull();
    expect(readBaselineS4Misses(join(directory, "missing.json"))).toBeNull();
  });

  it("parses --baseline", () => {
    expect(parseParityArgs(["--baseline", "/x/scorecard.json"]).baseline).toBe("/x/scorecard.json");
    expect(parseParityArgs([]).baseline).toBeUndefined();
    expect(() => parseParityArgs(["--baseline"])).toThrow(/needs a value/);
  });
});

describe("--licences-file and --no-graph-bake", () => {
  it("parses the options", () => {
    const args = parseParityArgs(["--licences-file", "l.json", "--no-graph-bake"]);
    expect(args.licencesFile).toMatch(/l\.json$/);
    expect(args.graphBake).toBe(false);
    const defaults = parseParityArgs([]);
    expect(defaults.licencesFile).toBeUndefined();
    expect(defaults.graphBake).toBe(true);
    expect(() => parseParityArgs(["--licences-file"])).toThrow(/needs a value/);
  });

  it("reads slugs per listing and ignores _ keys", async () => {
    const path = join(await scratch(), "l.json");
    await writeFile(path, JSON.stringify({ _source: "fab.com", "L1": ["personal", "professional"], "L2": ["cc-by"] }));
    const map = parseLicencesFile(path);
    expect(map).toEqual({ L1: ["personal", "professional"], L2: ["cc-by"] });
    const read = licencesReader(map);
    await expect(read("L1")).resolves.toEqual(["personal", "professional"]);
    await expect(read("l2")).resolves.toEqual(["cc-by"]);
    await expect(read("L3")).rejects.toThrow(/not in the licences file/);
  });

  it("rejects an unreadable or malformed file", async () => {
    const directory = await scratch();
    const write = async (name: string, content: string): Promise<string> => {
      const path = join(directory, name);
      await writeFile(path, content);
      return path;
    };
    expect(() => parseLicencesFile(join(directory, "missing.json"))).toThrow(/Cannot read/);
    await write("a.json", "not json");
    expect(() => parseLicencesFile(join(directory, "a.json"))).toThrow(/not valid JSON/);
    await write("c.json", JSON.stringify({ L1: [] }));
    expect(() => parseLicencesFile(join(directory, "c.json"))).toThrow(/L1/);
    await write("d.json", JSON.stringify({ L1: "personal" }));
    expect(() => parseLicencesFile(join(directory, "d.json"))).toThrow(/L1/);
    await write("e.json", JSON.stringify([["personal"]]));
    expect(() => parseLicencesFile(join(directory, "e.json"))).toThrow();
  });

  it("does not treat a licence error as fatal to the sweep", () => {
    expect(isFatalHandlerError({ code: "FABCLI_LICENSE_UNVERIFIED", message: "x", retryable: true })).toBe(false);
    expect(isFatalHandlerError({ code: "FABCLI_LICENSE_UNVERIFIED", message: "no network", retryable: false })).toBe(false);
    expect(isFatalHandlerError({ code: "FABCLI_LICENSE_NOT_PERMITTED", message: "download auth", retryable: false })).toBe(false);
  });
});
