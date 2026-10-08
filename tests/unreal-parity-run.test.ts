import { utimesSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import type { FabOwnedListing } from "../src/fab/fabcli.js";
import type { PackScore } from "../src/unreal/parity.js";
import {
  acquireLock,
  buildCorpus,
  entryKey,
  isFatalHandlerError,
  isLockStale,
  isSettled,
  mergeScorecardEntries,
  readBaselineS4Misses,
  s4Delta,
  s4DeltaLine,
  s4MissCount,
  summaryOf,
  parityLine,
  parseParityArgs,
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
  const base = { listings: [], artifact: undefined, limit: undefined, excludeSize: true };

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
    expect(parityLine(summary)).toBe("PARITY pass=2/4 (50.0% of scored) attempted=6 (33.3% of attempted) unverified=1 error=1");
  });

  it("reports null rates for an empty run", () => {
    const summary = summarizeEntries([]);
    expect(summary.passRateScored).toBeNull();
    expect(summary.passRateAttempted).toBeNull();
    expect(parityLine(summary)).toBe("PARITY pass=0/0 (n/a of scored) attempted=0 (n/a of attempted) unverified=0 error=0");
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
  it("stops on session and download failures, not on one bad pack", () => {
    expect(isFatalHandlerError({ code: "FABCLI_UNAUTHENTICATED", message: "" })).toBe(true);
    expect(isFatalHandlerError({ code: "FABCLI_SESSION_EXPIRED", message: "" })).toBe(true);
    expect(isFatalHandlerError({ code: "FABCLI_DOWNLOAD_FAILED", message: "" })).toBe(true);
    expect(isFatalHandlerError({ code: "FABCLI_KEYSTORE_UNREACHABLE", message: "" })).toBe(true);
    expect(isFatalHandlerError({ code: "FABCLI_NOT_OWNED", message: "not yours", retryable: false })).toBe(false);
    expect(isFatalHandlerError({ code: "FABCLI_LICENSE_NOT_PERMITTED", message: "no" })).toBe(false);
    expect(isFatalHandlerError({ code: "UNREAL_TOOL_FAILED", message: "download of x failed", retryable: false })).toBe(false);
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
    expect(parseParityArgs(["--no-exclude-size"]).excludeSize).toBe(false);
    expect(() => parseParityArgs(["--limit", "0"])).toThrow();
    expect(() => parseParityArgs(["--corpus", "x"])).toThrow();
    expect(() => parseParityArgs(["--wat"])).toThrow(/Unknown option/);
    expect(() => parseParityArgs(["--out"])).toThrow(/needs a value/);
  });
});

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
