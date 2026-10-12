import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  assertSafeChild,
  diffPackageOutcomes,
  gamePathOf,
  packageDigest,
  packageOutcomes,
  selectSlicePackages,
  type PackageOutcome,
  type ScannedPackage,
} from "../scripts/fab-slice.js";
import { importUnrealDirectory, type ImportReport } from "../src/unreal/importer.js";

describe("fab-slice dependency closure", () => {
  const scanned: ScannedPackage[] = [
    { rel: "Content/A/Mesh.uasset", classes: ["StaticMesh"], refs: ["/Game/A/MI_Mesh"] },
    { rel: "Content/A/MI_Mesh.uasset", classes: ["MaterialInstance"], refs: ["/Game/A/M_Master", "/Game/A/T_Albedo"] },
    { rel: "Content/A/M_Master.uasset", classes: ["Material"], refs: ["/Game/A/T_Albedo"] },
    { rel: "Content/A/T_Albedo.uasset", classes: ["Texture2D"], refs: [] },
    { rel: "Content/B/Unrelated.uasset", classes: ["Blueprint"], refs: ["/Game/B/Other"] },
    { rel: "Content/B/Other.uasset", classes: ["Blueprint"], refs: [] },
  ];

  it("closes over import-table references and never leaves the pack", () => {
    expect(selectSlicePackages(scanned, ["StaticMesh"])).toEqual([
      "Content/A/MI_Mesh.uasset",
      "Content/A/M_Master.uasset",
      "Content/A/Mesh.uasset",
      "Content/A/T_Albedo.uasset",
    ]);
  });

  it("does not pull an unreferenced package of the same class", () => {
    const selected = selectSlicePackages(scanned, ["StaticMesh"]);
    expect(selected).not.toContain("Content/B/Unrelated.uasset");
  });

  it("follows a reference chain one hop at a time", () => {
    const chain: ScannedPackage[] = [
      { rel: "Content/A/A.uasset", classes: ["PoseAsset"], refs: ["/Game/A/B"] },
      { rel: "Content/A/B.uasset", classes: ["PhysicsAsset"], refs: ["/Game/A/C"] },
      { rel: "Content/A/C.uasset", classes: ["Skeleton"], refs: [] },
    ];
    expect(selectSlicePackages(chain, ["PoseAsset"])).toEqual([
      "Content/A/A.uasset",
      "Content/A/B.uasset",
      "Content/A/C.uasset",
    ]);
  });

  it("maps a layout to its /Game path and digests a sorted package list", () => {
    expect(gamePathOf("Content/A/B/Mesh.uasset")).toBe("/Game/A/B/Mesh");
    expect(gamePathOf("GameAnimationSample_5.8/Content/A/Mesh.uasset")).toBe("/Game/A/Mesh");
    expect(packageDigest(["b", "a"])).toBe(packageDigest(["a", "b"]));
  });
});

describe("fab-slice path containment", () => {
  it("rejects empty, absolute and parent-escaping names", () => {
    for (const bad of ["", ".", "..", "/etc", "a/b", "..\\x"]) {
      expect(() => assertSafeChild("/root", bad)).toThrow(/unsafe/);
    }
    expect(assertSafeChild("/root", "slice-id")).toBe("/root/slice-id");
  });
});

describe("fab-slice import-report comparison", () => {
  it("reads per-package outcomes with reasons and precedence", () => {
    const report = {
      models: [{ package: "Content/A/Mesh.uasset" }],
      textures: [],
      cubemaps: [],
      materialAssets: [],
      audio: [],
      dataAssets: [],
      textureStacks: [],
      dataTextures: [],
      fonts: [],
      bitmapFonts: [],
      sprites: [],
      flipbooks: [],
      scenes: [],
      strands: [],
      skipped: [{ package: "Content/A/Map.umap", reason: "level" }],
      failed: [{ package: "Content/A/Mesh.uasset", reason: "boom" }],
    } as unknown as ImportReport;
    const outcomes = packageOutcomes(report);
    expect(outcomes.get("Content/A/Mesh.uasset")).toEqual({ status: "failed", reason: "boom" });
    expect(outcomes.get("Content/A/Map.umap")).toEqual({ status: "skipped", reason: "level" });
  });

  it("reports a dropped dependency as a status difference", () => {
    const slice = new Map<string, PackageOutcome>([["Content/A/MI.uasset", { status: "failed", reason: "missing parent" }]]);
    const full = new Map<string, PackageOutcome>([["Content/A/MI.uasset", { status: "converted" }]]);
    expect(diffPackageOutcomes(slice, full)).toEqual([
      { package: "Content/A/MI.uasset", slice: { status: "failed", reason: "missing parent" }, full: { status: "converted" } },
    ]);
  });

  it("treats a missing full-package outcome as absent", () => {
    const slice = new Map<string, PackageOutcome>([["Content/A/X.uasset", { status: "converted" }]]);
    expect(diffPackageOutcomes(slice, new Map())).toEqual([
      { package: "Content/A/X.uasset", slice: { status: "converted" }, full: { status: "absent" } },
    ]);
  });
});

// Licensed slices are local-only and never committed. Set FAB_FEATURE_CORPUS_DIR to the slices root
// (`~/.cache/threenative-asset-mcp/fab-slices` by default) to import every built slice below.
const corpusDir = process.env.FAB_FEATURE_CORPUS_DIR;

if (!corpusDir) {
  describe("feature corpus slices (skipped)", () => {
    it.skip("FAB_FEATURE_CORPUS_DIR is not set; set it to the fab-slices root to import the licensed slices (local-only, never committed)", () => {});
  });
} else {
  const temporary: string[] = [];
  afterAll(async () => {
    await Promise.all(temporary.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  describe("feature corpus slices (FAB_FEATURE_CORPUS_DIR, local-only)", () => {
    it("imports every built slice and accounts for each of its packages", async () => {
      const sliceIds = ["anim-starter-4.4", "stickman-4.22", "soul-cave-4.18", "vtol-5.4", "game-anim-5.8"];
      for (const id of sliceIds) {
        const sourceDir = join(corpusDir, id);
        if (!existsSync(sourceDir)) continue;
        const outputDir = await mkdtemp(join(tmpdir(), `fab-corpus-${id}-`));
        temporary.push(outputDir);
        const report = await importUnrealDirectory({ sourceDir, outputDir, sourceKind: "local-directory" });
        // The slice classifies every package it holds; animations merge into their mesh and carry no
        // per-package row, so the outcome count is only bounded below by one.
        expect(report.counts.packages).toBeGreaterThan(0);
        // Every package the slice holds gets a per-package outcome; a skip or a failure carries a
        // reason. `compare-full` is what proves those outcomes equal the full pack's.
        for (const [, outcome] of packageOutcomes(report)) {
          expect(outcome.status).toMatch(/^(converted|skipped|failed)$/);
          if (outcome.status !== "converted") expect(outcome.reason?.length ?? 0).toBeGreaterThan(0);
        }
      }
    }, 1_800_000);
  });
}
