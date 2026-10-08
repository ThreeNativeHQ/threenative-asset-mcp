import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import type { FabOwnedListing } from "../src/fab/fabcli.js";
import {
  acquireLock,
  buildCorpus,
  entryKey,
  isFatalHandlerError,
  isLockStale,
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
    expect(parityLine(summary)).toBe("PARITY pass=2/4 (50.0%) attempted=6 unverified=1 error=1");
  });

  it("reports null rates for an empty run", () => {
    const summary = summarizeEntries([]);
    expect(summary.passRateScored).toBeNull();
    expect(summary.passRateAttempted).toBeNull();
    expect(parityLine(summary)).toBe("PARITY pass=0/0 (n/a) attempted=0 unverified=0 error=0");
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

  it("keeps settled entries, reruns auth errors and entries never seen", () => {
    const previous = [
      entry({ status: "pass", artifactId: "A1" }),
      entry({ status: "fail", artifactId: "A2" }),
      entry({ status: "error", artifactId: "A3", error: { code: "UNREAL_TOOL_FAILED", message: "boom" } }),
      entry({ status: "error", artifactId: "A4", error: { code: "FABCLI_UNAUTHENTICATED", message: "no session" } }),
    ];
    const { todo, kept } = selectResume(corpus, previous);
    expect(kept.map((e) => e.artifactId)).toEqual(["A1", "A2", "A3"]);
    expect(todo.map((e) => e.artifactId)).toEqual(["A4", "A5"]);
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
    expect(isLockStale("", () => true)).toBe(true);
    expect(isLockStale("not-a-pid", () => true)).toBe(true);
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
