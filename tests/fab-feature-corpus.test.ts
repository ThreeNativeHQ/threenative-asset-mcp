import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { NodeIO } from "@gltf-transform/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertNoSymlinks,
  assertSafeChild,
  containedPath,
  corpusPath,
  diffPackageOutcomes,
  gamePathOf,
  importFreshOutput,
  listPackageFiles,
  missingRequiredSlices,
  packageDigest,
  packageOutcomes,
  readCorpus,
  selectSlicePackages,
  SLICES,
  type PackageOutcome,
  type ScannedPackage,
  type SlicePlan,
} from "../scripts/fab-slice.js";
import { packageHeaderSize, readExactly, readPackageHeaderRegion, type PositionedReader } from "../src/unreal/cooking.js";
import { IMPORTER_VERSION, ImportError, importUnrealDirectory, type ImportReport } from "../src/unreal/importer.js";
import { primaryClassFixture } from "./helpers/uasset-fixture.js";

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

describe("fab-slice finite per-class selection", () => {
  const niagara: ScannedPackage[] = [
    { rel: "Content/VFX/NS_A.uasset", classes: ["NiagaraSystem"], refs: [] },
    { rel: "Content/VFX/NS_B.uasset", classes: ["NiagaraSystem"], refs: [] },
    { rel: "Content/VFX/NS_C.uasset", classes: ["NiagaraSystem"], refs: [] },
  ];

  it("keeps N distinct NiagaraSystem representatives, not one", () => {
    expect(selectSlicePackages(niagara, ["NiagaraSystem"], 3)).toEqual([
      "Content/VFX/NS_A.uasset",
      "Content/VFX/NS_B.uasset",
      "Content/VFX/NS_C.uasset",
    ]);
    expect(selectSlicePackages(niagara, ["NiagaraSystem"], 2)).toHaveLength(2);
  });

  it("counts only eligible representatives, not dependencies that merely mention the class", () => {
    const withMentions: ScannedPackage[] = [
      { rel: "Content/VFX/NS_A.uasset", primaryClass: "NiagaraSystem", classes: ["NiagaraSystem"], refs: ["/Game/VFX/D_A"] },
      { rel: "Content/VFX/NS_B.uasset", primaryClass: "NiagaraSystem", classes: ["NiagaraSystem"], refs: ["/Game/VFX/D_B"] },
      { rel: "Content/VFX/NS_C.uasset", primaryClass: "NiagaraSystem", classes: ["NiagaraSystem"], refs: [] },
      { rel: "Content/VFX/D_A.uasset", primaryClass: "NiagaraEmitter", classes: ["NiagaraEmitter", "NiagaraSystem"], refs: [] },
      { rel: "Content/VFX/D_B.uasset", primaryClass: "NiagaraEmitter", classes: ["NiagaraEmitter", "NiagaraSystem"], refs: [] },
    ];
    const selected = selectSlicePackages(withMentions, ["NiagaraSystem"], 3);
    expect(selected).toEqual([
      "Content/VFX/D_A.uasset",
      "Content/VFX/D_B.uasset",
      "Content/VFX/NS_A.uasset",
      "Content/VFX/NS_B.uasset",
      "Content/VFX/NS_C.uasset",
    ]);
  });

  it("keeps name-table membership for a UE5 package with no parsed primary class", () => {
    const ue5: ScannedPackage[] = [
      { rel: "Content/VFX/NS_A.uasset", classes: ["NiagaraSystem"], refs: [] },
      { rel: "Content/VFX/NS_B.uasset", classes: ["NiagaraEmitter", "NiagaraSystem"], refs: [] },
      { rel: "Content/VFX/NS_C.uasset", classes: ["NiagaraSystem"], refs: ["/Game/VFX/NS_A"] },
    ];
    expect(selectSlicePackages(ue5, ["NiagaraSystem"], 3)).toEqual([
      "Content/VFX/NS_A.uasset",
      "Content/VFX/NS_B.uasset",
      "Content/VFX/NS_C.uasset",
    ]);
  });

  it("counts a package matching two target classes as covering both (overlapping coverage)", () => {
    const overlap: ScannedPackage[] = [
      { rel: "Content/VFX/Both.uasset", classes: ["NiagaraSystem", "NiagaraEmitter"], refs: [] },
      { rel: "Content/VFX/OnlyEmitter.uasset", classes: ["NiagaraEmitter"], refs: [] },
    ];
    expect(selectSlicePackages(overlap, ["NiagaraSystem", "NiagaraEmitter"], 1)).toEqual(["Content/VFX/Both.uasset"]);
  });

  it("takes the whole pool when a class has fewer than N members (insufficient pool)", () => {
    expect(selectSlicePackages(niagara.slice(0, 2), ["NiagaraSystem"], 5)).toEqual([
      "Content/VFX/NS_A.uasset",
      "Content/VFX/NS_B.uasset",
    ]);
  });
});

describe("fab-slice required-slice verification", () => {
  it("reports every missing required slice and ignores an optional one", () => {
    const plans = [
      { id: "a" },
      { id: "b" },
      { id: "c", optional: true },
    ] as unknown as SlicePlan[];
    expect(missingRequiredSlices(plans, new Set(["a"])).map((slice) => slice.id)).toEqual(["b"]);
    expect(missingRequiredSlices(plans, new Set(["a", "b"])).map((slice) => slice.id)).toEqual([]);
    expect(missingRequiredSlices(plans, new Set(["c"])).map((slice) => slice.id)).toEqual(["a", "b"]);
  });

  it("keeps the five matrix slices required and the sixth GASP 5.4 slice optional", () => {
    const built = new Set(["anim-starter-4.4", "stickman-4.22", "soul-cave-4.18", "vtol-5.4"]);
    expect(SLICES.find((slice) => slice.id === "game-anim-5.4")?.optional).toBe(true);
    expect(missingRequiredSlices(SLICES, built).map((slice) => slice.id)).toEqual(["game-anim-5.8"]);
    expect(missingRequiredSlices(SLICES, new Set(SLICES.map((slice) => slice.id)))).toEqual([]);
  });
});

describe("fab-slice path containment", () => {
  it("rejects empty, absolute and parent-escaping names", () => {
    for (const bad of ["", ".", "..", "/etc", "a/b", "..\\x"]) {
      expect(() => assertSafeChild("/root", bad)).toThrow(/unsafe/);
    }
    expect(assertSafeChild("/root", "slice-id")).toBe("/root/slice-id");
  });

  it("accepts a nested manifest path but refuses traversal, absolute and empty segments", () => {
    expect(containedPath("/root", "Content/A/Mesh.uasset")).toBe("/root/Content/A/Mesh.uasset");
    for (const bad of ["", "/etc/passwd", "../x", "a/../../x", "a//b", "a/./b", "a\\..\\b"]) {
      expect(() => containedPath("/root", bad)).toThrow(/unsafe|escapes/);
    }
  });

  it("refuses to delete or copy through a symlinked path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fab-slice-symlink-"));
    directories.push(directory);
    await mkdir(join(directory, "real"));
    await symlink("/etc", join(directory, "link"));
    await expect(assertNoSymlinks(directory, "link/hosts")).rejects.toThrow(/symlink/);
    await expect(assertNoSymlinks(directory, "real/../real/ok.uasset")).rejects.toThrow(/unsafe/);
    await expect(assertNoSymlinks(directory, "real/new.uasset")).resolves.toBe(join(directory, "real", "new.uasset"));
  });

  it("refuses a symlinked root, which would bypass the per-child check", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fab-slice-rootlink-"));
    directories.push(directory);
    await mkdir(join(directory, "real"));
    const rootLink = join(directory, "root-link");
    await symlink(join(directory, "real"), rootLink);
    // The root itself is a symlink: a contained `rel` still resolves through it, so it is refused.
    await expect(assertNoSymlinks(rootLink, "new.uasset")).rejects.toThrow(/symlink/);
    await expect(assertNoSymlinks(rootLink, "nested/new.uasset")).rejects.toThrow(/symlink/);
    // A real root with no symlinked child is still accepted.
    await expect(assertNoSymlinks(join(directory, "real"), "new.uasset")).resolves.toBe(join(directory, "real", "new.uasset"));
  });
});

describe("fab-slice output-collision handling", () => {
  it("propagates a collision without deleting the existing output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fab-slice-collision-"));
    directories.push(directory);
    const outputDir = join(directory, "out");
    await mkdir(outputDir, { recursive: true });
    const sentinel = join(outputDir, "import-report.json");
    await writeFile(sentinel, "{}");
    const collision = new ImportError("UNREAL_OUTPUT_COLLISION", "already holds a different import");
    await expect(importFreshOutput("source", outputDir, async () => { throw collision; })).rejects.toMatchObject({
      code: "UNREAL_OUTPUT_COLLISION",
    });
    await expect(readFile(sentinel, "utf8")).resolves.toBe("{}");
    expect(existsSync(outputDir)).toBe(true);
  });

  it("rethrows a non-collision error unchanged", async () => {
    const failure = new Error("boom");
    await expect(importFreshOutput("source", "out", async () => { throw failure; })).rejects.toBe(failure);
  });
});

describe("fab-slice package-header read", () => {
  it("fills the buffer across short reads, so a partial read never leaves a zero tail", async () => {
    const buffer = Buffer.alloc(8);
    let calls = 0;
    const chunked: PositionedReader = {
      async read(target, offset, length) {
        const bytesRead = Math.min(length, 3);
        target.fill(calls + 1, offset, offset + bytesRead);
        calls += 1;
        return { bytesRead };
      },
    };
    await readExactly(chunked, buffer, 0);
    expect(calls).toBe(3);
    expect([...buffer]).toEqual([1, 1, 1, 2, 2, 2, 3, 3]);
  });

  it("throws when a read ends before the buffer is full", async () => {
    const empty: PositionedReader = { async read() { return { bytesRead: 0 }; } };
    await expect(readExactly(empty, Buffer.alloc(4), 0)).rejects.toThrow(/short read/);
  });

  it("reads exactly the declared header bytes and refuses a truncated file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fab-slice-header-"));
    directories.push(directory);
    const bytes = primaryClassFixture({ ue4Version: 385 });
    const totalHeaderSize = packageHeaderSize(bytes);
    expect(totalHeaderSize).toBeDefined();
    expect(totalHeaderSize).toBe(bytes.length);
    const full = join(directory, "Full.uasset");
    await writeFile(full, bytes);
    const region = await readPackageHeaderRegion(full);
    expect(region.length).toBe(totalHeaderSize);
    expect(region.equals(bytes.subarray(0, totalHeaderSize))).toBe(true);
    // One byte short of the declared header is the deterministic short-read boundary: it must throw,
    // never return a zero-filled tail that scans as absent data.
    const short = join(directory, "Short.uasset");
    await writeFile(short, bytes.subarray(0, totalHeaderSize! - 1));
    await expect(readPackageHeaderRegion(short)).rejects.toThrow(/truncated header/);
  });
});

describe("fab-slice sidecar accounting", () => {
  it("groups each package's .uexp/.ubulk with it and counts their bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fab-slice-sidecars-"));
    directories.push(directory);
    const files = [
      ["Content/A/Mesh.uasset", 10],
      ["Content/A/Mesh.uexp", 3],
      ["Content/A/Mesh.ubulk", 5],
      ["Content/A/Other.uasset", 7],
      ["Content/A/Other.ubulk", 2],
      ["Content/A/Text.uasset", 4],
      ["Content/A/Unrelated.bin", 9],
    ] as const;
    for (const [rel, size] of files) {
      const abs = join(directory, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, Buffer.alloc(size));
    }
    const packages = await listPackageFiles(directory);
    expect(packages.map((file) => file.rel)).toEqual(["Content/A/Mesh.uasset", "Content/A/Other.uasset", "Content/A/Text.uasset"]);
    const mesh = packages.find((file) => file.rel.endsWith("Mesh.uasset"))!;
    expect(mesh.sidecars.map((sidecar) => sidecar.rel).sort()).toEqual(["Content/A/Mesh.ubulk", "Content/A/Mesh.uexp"]);
    expect(mesh.size).toBe(10);
    expect(mesh.sidecars.reduce((sum, sidecar) => sum + sidecar.size, 0)).toBe(8);
    const text = packages.find((file) => file.rel.endsWith("Text.uasset"))!;
    expect(text.sidecars).toEqual([]);
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

  it("catches a selected package the slice silently dropped (a row only the full pack has)", () => {
    const slice = new Map<string, PackageOutcome>();
    const full = new Map<string, PackageOutcome>([["Content/A/X.uasset", { status: "converted" }]]);
    expect(diffPackageOutcomes(slice, full, ["Content/A/X.uasset"])).toEqual([
      { package: "Content/A/X.uasset", slice: { status: "absent" }, full: { status: "converted" } },
    ]);
  });

  it("compares a selected package absent on both sides (no difference, but not ignored)", () => {
    const selected = ["Content/A/Anim.uasset", "Content/A/Mesh.uasset"];
    const slice = new Map<string, PackageOutcome>([["Content/A/Mesh.uasset", { status: "converted" }]]);
    const full = new Map<string, PackageOutcome>([["Content/A/Mesh.uasset", { status: "converted" }]]);
    expect(diffPackageOutcomes(slice, full, selected)).toEqual([]);
    expect(selected.filter((pkg) => !slice.has(pkg) && !full.has(pkg))).toEqual(["Content/A/Anim.uasset"]);
  });

  it("ignores a full-only row outside the selected packages", () => {
    const slice = new Map<string, PackageOutcome>([["Content/A/X.uasset", { status: "converted" }]]);
    const full = new Map<string, PackageOutcome>([
      ["Content/A/X.uasset", { status: "converted" }],
      ["Content/B/Other.uasset", { status: "failed", reason: "not in the slice" }],
    ]);
    expect(diffPackageOutcomes(slice, full, ["Content/A/X.uasset"])).toEqual([]);
  });

  const PKG = "Content/IsolatedExamples/LookAtPOI/TestLevelContent/Characters/Eye/M_LookAtPOI_Eye.uasset";

  it("treats two source-root prefixes as equivalent when the roots are known", () => {
    // The provider keys a loose directory as "<source-root>/<package path>". The slice and the full
    // pack live under different directory names, so the same refusal embeds different roots.
    const slice = new Map<string, PackageOutcome>([[PKG, { status: "failed", reason: `0 in game-anim-5.8/${PKG}; exactly one is needed` }]]);
    const full = new Map<string, PackageOutcome>([[PKG, { status: "failed", reason: `0 in GameAnimationSample/${PKG}; exactly one is needed` }]]);
    expect(diffPackageOutcomes(slice, full, [PKG])).toHaveLength(1);
    expect(diffPackageOutcomes(slice, full, [PKG], { slice: "game-anim-5.8", full: "GameAnimationSample" })).toEqual([]);
  });

  it("keeps a differing failure detail a difference after the source root is normalized", () => {
    const slice = new Map<string, PackageOutcome>([[PKG, { status: "failed", reason: `0 exports named in game-anim-5.8/${PKG}; exactly one is needed` }]]);
    const full = new Map<string, PackageOutcome>([[PKG, { status: "failed", reason: `2 exports named in GameAnimationSample/${PKG}; exactly one is needed` }]]);
    expect(diffPackageOutcomes(slice, full, [PKG], { slice: "game-anim-5.8", full: "GameAnimationSample" })).toHaveLength(1);
  });

  it("does not normalize an unrelated dependency path that differs between the sides", () => {
    const slice = new Map<string, PackageOutcome>([[PKG, { status: "failed", reason: `needs game-anim-5.8/${PKG} and /Game/SliceOnly/Dep.uasset` }]]);
    const full = new Map<string, PackageOutcome>([[PKG, { status: "failed", reason: `needs GameAnimationSample/${PKG} and /Game/FullOnly/Dep.uasset` }]]);
    const diffs = diffPackageOutcomes(slice, full, [PKG], { slice: "game-anim-5.8", full: "GameAnimationSample" });
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.full.reason).toContain("/Game/FullOnly/Dep.uasset");
  });

  it("does not rewrite a source-root name inside a longer path segment", () => {
    const slice = new Map<string, PackageOutcome>([[PKG, { status: "failed", reason: `in some-game-anim-5.8/${PKG}` }]]);
    const full = new Map<string, PackageOutcome>([[PKG, { status: "failed", reason: `in some-GameAnimationSample/${PKG}` }]]);
    expect(diffPackageOutcomes(slice, full, [PKG], { slice: "game-anim-5.8", full: "GameAnimationSample" })).toHaveLength(1);
  });

  it("does not rewrite a source-root name after a Unicode letter in the same component", () => {
    const slice = new Map<string, PackageOutcome>([[PKG, { status: "failed", reason: `in PaketÜgame-anim-5.8/${PKG}` }]]);
    const full = new Map<string, PackageOutcome>([[PKG, { status: "failed", reason: `in PaketÜGameAnimationSample/${PKG}` }]]);
    expect(diffPackageOutcomes(slice, full, [PKG], { slice: "game-anim-5.8", full: "GameAnimationSample" })).toHaveLength(1);
  });
});

// Licensed slices are local-only and never committed. Set FAB_FEATURE_CORPUS_DIR to the slices root
// (`~/.cache/threenative-asset-mcp/fab-slices` by default) to import every slice the committed record
// names. The record (`docs/parity/feature-corpus.json`) is the source of the slice ids; a missing slice
// is a failure, not a skip, so an empty or partial directory cannot pass.
const corpusDir = process.env.FAB_FEATURE_CORPUS_DIR;
const directories: string[] = [];
afterAll(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

if (!corpusDir) {
  describe("feature corpus slices (skipped)", () => {
    it.skip("FAB_FEATURE_CORPUS_DIR is not set; set it to the fab-slices root to import the licensed slices (local-only, never committed)", () => {});
  });
} else {
  describe("feature corpus slices (FAB_FEATURE_CORPUS_DIR, local-only)", () => {
    it("imports every committed-manifest slice and accounts for its outcomes", async () => {
      const record = await readCorpus(corpusPath());
      expect(record.slices.length).toBeGreaterThan(0);
      for (const entry of record.slices) {
        const sourceDir = join(corpusDir, entry.id);
        expect(existsSync(sourceDir), `committed slice ${entry.id} is missing under ${corpusDir}`).toBe(true);
        expect(entry.packages, `committed record for ${entry.id} has no packages`).toBeGreaterThan(0);
        const outputDir = await mkdtemp(join(tmpdir(), `fab-corpus-${entry.id}-`));
        directories.push(outputDir);
        const report = await importUnrealDirectory({ sourceDir, outputDir, sourceKind: "local-directory" });
        expect(report.counts.packages).toBeGreaterThan(0);
        const outcomes = packageOutcomes(report);
        // Animations merge into their mesh and carry no per-package row, so the outcome count is only a
        // subset of the package count; what is checked is that the importer classified something and
        // that every non-converted row names a reason.
        expect(outcomes.size).toBeGreaterThan(0);
        expect(outcomes.size).toBeLessThanOrEqual(report.counts.packages);
        for (const [, outcome] of outcomes) {
          expect(outcome.status).toMatch(/^(converted|skipped|failed)$/);
          if (outcome.status !== "converted") expect(outcome.reason?.length ?? 0).toBeGreaterThan(0);
        }
      }
    }, 1_800_000);
  });
}

// PRD-582 gameplay gates over the real corpus. The five matrix slices are required: when
// FAB_FEATURE_CORPUS_DIR is set, an absent one is a failure, never an empty success. Each slice is
// imported once through the public `importUnrealDirectory` with the immutable `threenative.85-gameplay`
// converter snapshot; the shared root toolchain binary is mutable and is never used. Output stays
// under the owner's cache so an import can be inspected, and each output is removed first so a stale
// report can never satisfy a gate. Licensed names never appear below: a model is located by its
// reported characteristics, and its socket, bone and wave names are compared only at runtime.

const CONVERTER_85_GAMEPLAY = join(homedir(), ".cache", "threenative-asset-mcp", "prd582", "converter-85-gameplay", "ThreeNativeConverter");
// A distinct owned output, so the earlier snapshot's evidence is preserved rather than overwritten.
const FINAL_IMPORT_DIR = join(homedir(), ".cache", "threenative-asset-mcp", "prd582", "final-imports-85-gameplay");

function runConverter(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { maxBuffer: 1 << 20 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
  });
}

interface CueNode {
  readonly type: string;
  readonly params?: Record<string, unknown>;
  readonly children?: readonly CueNode[];
}

interface ConstraintBasis {
  readonly primaryAxis: readonly [number, number, number];
  readonly secondaryAxis: readonly [number, number, number];
}

if (corpusDir) {
  const corpusRoot = corpusDir;
  describe("feature corpus gameplay gates (FAB_FEATURE_CORPUS_DIR, local-only)", () => {
    const imported = new Map<string, { readonly report: ImportReport; readonly outputDir: string }>();

    beforeAll(async () => {
      // The override lets an operator point the gate at their own 85-gameplay build; it must still report it.
      const converterPath = process.env.THREENATIVE_MODERN_UNREAL_CONVERTER_PATH?.trim() || CONVERTER_85_GAMEPLAY;
      const versionLine = (await runConverter(converterPath, ["--version"]))
        .trim()
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .pop();
      const versionMatch = versionLine === undefined ? null : /threenative\.([0-9]+(?:-gameplay)?)\b/.exec(versionLine);
      if (versionMatch?.[1] !== "85-gameplay") {
        throw new Error(`the gameplay gate needs the immutable converter-85-gameplay snapshot, but ${converterPath} reports "${versionLine ?? ""}"`);
      }
      const version = versionLine!.split(/\s+/).slice(1).join(" ") || versionLine!;

      const present = new Set(SLICES.filter((slice) => existsSync(join(corpusRoot, slice.id))).map((slice) => slice.id));
      const missing = missingRequiredSlices(SLICES, present);
      if (missing.length > 0) {
        throw new Error(
          `FAB_FEATURE_CORPUS_DIR is set, so every required matrix slice must be present; missing: ${missing.map((slice) => slice.id).join(", ")}`,
        );
      }

      for (const slice of SLICES.filter((entry) => !entry.optional)) {
        const sourceDir = join(corpusRoot, slice.id);
        const outputDir = join(FINAL_IMPORT_DIR, slice.id);
        // Force a fresh import: a report from an earlier importer would otherwise be reused.
        await rm(outputDir, { recursive: true, force: true });
        const report = await importFreshOutput(sourceDir, outputDir, (source, output) =>
          importUnrealDirectory({
            sourceDir: source,
            outputDir: output,
            sourceKind: "local-directory",
            engine: slice.engine,
            formatHint: slice.engine,
            graphBake: false,
            concurrency: 1,
            modernConverter: { name: "modern", path: converterPath, version },
            environment: { ...process.env, THREENATIVE_MODERN_UNREAL_CONVERTER_PATH: converterPath },
            log: () => {},
          }),
        );
        expect(report.reused, `${slice.id} must be imported fresh, not served from a cache`).toBe(false);
        expect(report.importer.version).toBe(IMPORTER_VERSION);
        expect(report.toolchain.modernConverter).toBe(version);
        imported.set(slice.id, { report, outputDir });
      }
    }, 900_000);

    function slice(id: string): { readonly report: ImportReport; readonly outputDir: string } {
      const entry = imported.get(id);
      if (!entry) throw new Error(`${id} was not imported`);
      return entry;
    }

    async function skinJoints(outputDir: string, glb: string): Promise<Set<string>> {
      const document = await new NodeIO().read(join(outputDir, glb));
      return new Set(document.getRoot().listSkins().flatMap((skin) => skin.listJoints().map((joint) => joint.getName())));
    }

    it("sockets: every socket:* node hangs under its named skin joint and the source counts match", async () => {
      const { report, outputDir } = slice("game-anim-5.8");
      // One skeletal mesh reports a socket bone the exported skin lacks; four others attach.
      const withMissingBone = report.models.filter((model) => (model.missingBones?.length ?? 0) > 0);
      expect(withMissingBone).toHaveLength(1);
      const mannequin = withMissingBone[0]!;
      expect(mannequin.kind).toBe("skeletal");
      expect(mannequin.sockets).toHaveLength(4);
      expect(mannequin.missingBones).toHaveLength(1);
      // The mesh with the most sockets carries twelve; converter 85 decodes its own socket list.
      const shoe = report.models.reduce((widest, model) =>
        (model.sockets?.length ?? 0) > (widest.sockets?.length ?? 0) ? model : widest,
      );
      expect(shoe.sockets).toHaveLength(12);
      expect(shoe.missingBones ?? []).toHaveLength(0);

      for (const [model, attached, sourceTotal] of [
        [mannequin, 4, 5],
        [shoe, 12, 12],
      ] as const) {
        const document = await new NodeIO().read(join(outputDir, model.glb));
        const joints = new Set(document.getRoot().listSkins().flatMap((skin) => skin.listJoints().map((joint) => joint.getName())));
        expect(joints.size).toBeGreaterThan(0);
        const socketNodes = document.getRoot().listNodes().filter((node) => node.getName().startsWith("socket:"));
        expect(socketNodes).toHaveLength(attached);
        expect(socketNodes.length + (model.missingBones?.length ?? 0)).toBe(sourceTotal);
        expect(socketNodes.map((node) => node.getName().slice("socket:".length)).sort()).toEqual([...(model.sockets ?? [])].sort());
        for (const node of socketNodes) {
          const parent = node.getParentNode();
          expect(parent, `${node.getName()} has no parent joint`).not.toBeNull();
          expect(parent!.getName()).toBe((node.getExtras() as { unrealSocket?: { bone?: string } }).unrealSocket?.bone);
          expect(joints.has(parent!.getName())).toBe(true);
        }
      }
    });

    it("physics: sidecar counts match the verified source and every body bone resolves in the linked skin", async () => {
      const expected = new Map<string, readonly (readonly [number, number])[]>([
        ["anim-starter-4.4", [[23, 22]]],
        ["stickman-4.22", [[14, 13]]],
        ["game-anim-5.8", [[23, 22], [6, 1], [2, 0]]],
      ]);
      // The two slices with no skeletal physics asset stay empty (VTOL carries none).
      expect(slice("soul-cave-4.18").report.physicsAssets).toHaveLength(0);
      expect(slice("vtol-5.4").report.physicsAssets).toHaveLength(0);

      const byCounts = (a: readonly number[], b: readonly number[]): number => a[0]! - b[0]! || a[1]! - b[1]!;
      for (const [id, counts] of expected) {
        const { report, outputDir } = slice(id);
        const fromFiles: [number, number][] = [];
        for (const asset of report.physicsAssets) {
          const file = join(outputDir, asset.file);
          expect(existsSync(file), `${asset.file} must exist`).toBe(true);
          expect(report.failed.some((row) => row.package === asset.package)).toBe(false);
          expect(report.skipped.some((row) => row.package === asset.package)).toBe(false);
          // The count comes from the sidecar file, not the report's own summary.
          const parsed = JSON.parse(await readFile(file, "utf8")) as {
            bodies: { bone: string }[];
            constraints: { childFrame: ConstraintBasis; parentFrame: ConstraintBasis }[];
          };
          fromFiles.push([parsed.bodies.length, parsed.constraints.length]);
          // Every frame is a unit, orthogonal, non-zero basis. A zero axis (an omitted Unreal tag read
          // as zero) normalizes to a zero vector and fails here, so the native axis defaults are pinned.
          for (const constraint of parsed.constraints) {
            for (const frame of [constraint.childFrame, constraint.parentFrame]) {
              const primary = frame.primaryAxis;
              const secondary = frame.secondaryAxis;
              expect(Math.hypot(...primary), `${asset.name} frame primary axis is not unit length`).toBeCloseTo(1, 5);
              expect(Math.hypot(...secondary), `${asset.name} frame secondary axis is not unit length`).toBeCloseTo(1, 5);
              const dot = primary[0] * secondary[0] + primary[1] * secondary[1] + primary[2] * secondary[2];
              expect(Math.abs(dot), `${asset.name} frame axes are not orthogonal`).toBeLessThan(1e-4);
            }
          }
          const linked = report.models.filter((model) => model.physics?.asset === asset.name);
          expect(linked.length, `${asset.name} must be linked to a skinned mesh`).toBeGreaterThan(0);
          for (const model of linked) {
            expect(model.physics?.missingBodies ?? 0, `${asset.name} must have no missing sub-export`).toBe(0);
            expect(model.physics?.missingConstraints ?? 0, `${asset.name} must have no missing sub-export`).toBe(0);
            const joints = await skinJoints(outputDir, model.glb);
            for (const body of parsed.bodies) {
              const resolved = joints.has(body.bone) || (model.physics?.missingBones ?? []).includes(body.bone);
              expect(resolved, `${body.bone} resolves to no joint and is not reported missing`).toBe(true);
            }
          }
        }
        const wanted = [...counts].map((count) => [...count]).sort(byCounts);
        expect(fromFiles.sort(byCounts)).toEqual(wanted);
        expect(report.physicsAssets.map((asset) => [asset.bodies, asset.constraints]).sort(byCounts)).toEqual(wanted);
      }
    });

    it("soundcue: every WavePlayer leaf resolves to exported audio and the leaf counts match", async () => {
      const expected = new Map<string, number>([
        ["soul-cave-4.18", 8],
        ["game-anim-5.8", 4],
      ]);
      for (const [id, leafCount] of expected) {
        const { report, outputDir } = slice(id);
        expect(report.soundCues.length, `${id} must decode its SoundCue graph`).toBe(1);
        const cue = report.soundCues[0]!;
        const file = join(outputDir, cue.file);
        expect(existsSync(file), `${cue.file} must exist`).toBe(true);
        expect(report.failed.some((row) => row.package === cue.package)).toBe(false);
        expect(report.skipped.some((row) => row.package === cue.package)).toBe(false);
        const parsed = JSON.parse(await readFile(file, "utf8")) as { root: CueNode | null };
        const leaves: CueNode[] = [];
        const collect = (node: CueNode | null | undefined): void => {
          if (!node) return;
          if (typeof node.params?.wave === "string") leaves.push(node);
          for (const child of node.children ?? []) collect(child);
        };
        collect(parsed.root);
        expect(leaves).toHaveLength(leafCount);
        expect(cue.waves).toHaveLength(leafCount);
        expect(cue.missingWaves).toHaveLength(0);
        for (const leaf of leaves) {
          const wave = leaf.params!.wave as string;
          const exported = leaf.params!.waveExport;
          if (typeof exported === "string") {
            expect(existsSync(join(outputDir, exported)), `${wave} must point at an exported wave`).toBe(true);
          } else {
            expect(cue.missingWaves).toContain(wave);
          }
        }
      }
      for (const id of ["anim-starter-4.4", "stickman-4.22", "vtol-5.4"]) {
        expect(slice(id).report.soundCues).toHaveLength(0);
      }
    });
  });
}
