import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import { NodeIO } from "@gltf-transform/core";
import { afterAll, describe, expect, it } from "vitest";

import { CUE4PARSE_PATCH, CUE4PARSE_PROGRAM, CUE4PARSE_SOURCE } from "../src/unreal/cue4parse-adapter.js";
import { importUnrealDirectory } from "../src/unreal/importer.js";

/**
 * A MetaHuman SkeletalMesh carries an embedded DNAAsset whose stored file name is the authoring
 * machine's absolute Windows path, and it keeps eight LODs. Both facts are read out of a pinned
 * out-of-process CUE4Parse build, so the fixes that matter live in C# and in the generated
 * converter program rather than in the TypeScript that drives them.
 */

// Fab's MetaHuman Sample 5.5 project, downloaded by fab_import_asset.
const ADA = join(
  homedir(),
  ".cache/threenative-asset-mcp/fab-downloads/0281d63e-71f7-4e07-a344-5fa721ac4d35/MetaHumanSample_5.5",
);
/** The DNA that came out of the first MetaHuman arm, used as the byte-for-byte reference. */
const REFERENCE_DNA = join(homedir(), ".cache/threenative/metahuman/ada-face/dna/Ada_FaceMesh.dna");
const CONVERTER = join(homedir(), ".cache/threenative-asset-mcp/toolchain/modern/bin/ThreeNativeConverter");

function converterReady(): boolean {
  try {
    return execFileSync(CONVERTER, ["--version"], { encoding: "utf8" }).includes(CUE4PARSE_SOURCE.version);
  } catch {
    return false;
  }
}

const ready = existsSync(ADA) && existsSync(REFERENCE_DNA) && converterReady();
const outputs: string[] = [];
afterAll(async () => {
  await Promise.all(outputs.map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("the pinned CUE4Parse build", () => {
  it("writes export paths with the host separator instead of joining them with backslashes", () => {
    // Regression guard for the DNA defect: the old unconditional rewrite turned an absolute path
    // into one backslash-joined filename, so a .dna landed in the process working directory. The
    // patch replaces that exact line; its `-`/`+` pair is what makes the guard falsifiable.
    expect(CUE4PARSE_PATCH).toContain("-        return fullPath.Replace('/', '\\\\');");
    expect(CUE4PARSE_PATCH).toContain("+        return fullPath.Replace('/', Path.DirectorySeparatorChar);");
  });

  it("reduces a DNA asset's stored Windows path to its leaf before naming the file", () => {
    expect(CUE4PARSE_PATCH).toContain("dna.DnaFileName.Replace('\\\\', '/')");
  });

  it("asks CUE4Parse for every LOD when more than the highest-quality one is requested", () => {
    // EMeshQuality.Highest, the export default, truncates a skeletal mesh to LOD0.
    expect(CUE4PARSE_PROGRAM).toContain("EMeshQuality.All");
    expect(CUE4PARSE_PROGRAM).toContain("--lods");
  });
});

describe.skipIf(!ready)("the real Ada_FaceMesh MetaHuman face (local MetaHuman Sample 5.5 download)", () => {
  it(
    "keeps the DNA byte-identical out of the working directory and exports LOD1 beside LOD0",
    async () => {
      // This mesh needs ~90 GiB of head-room by the pre-flight's estimate, so it cannot go in the
      // system temp directory; the cache volume is where the real workflow writes anyway.
      const scratch = join(homedir(), ".cache/threenative/metahuman");
      await mkdir(scratch, { recursive: true });
      const outputDir = await mkdtemp(join(scratch, "import-test-"));
      outputs.push(outputDir);
      const before = new Set(await readdir(process.cwd()));
      const report = await importUnrealDirectory({
        sourceDir: ADA,
        outputDir,
        onlyPackages: ["Ada_FaceMesh"],
        lods: [0, 1],
        modernConverter: { name: "modern", path: CONVERTER, version: CUE4PARSE_SOURCE.version },
      });
      expect(report.failed).toEqual([]);

      // The Windows-path .dna used to be written here as a single backslash-joined filename.
      expect((await readdir(process.cwd())).filter((entry) => !before.has(entry))).toEqual([]);

      const lod0 = report.models.find((model) => model.glb === "Models/Ada_FaceMesh.glb");
      const lod1 = report.models.find((model) => model.glb === "Models/Ada_FaceMesh_LOD1.glb");
      if (!lod0 || !lod1) throw new Error(`missing LODs: ${JSON.stringify(report.models.map((m) => m.glb))}`);

      const promoted = await readFile(join(outputDir, lod0.dna!.path));
      expect(createHash("sha256").update(promoted).digest("hex")).toBe(
        createHash("sha256").update(await readFile(REFERENCE_DNA)).digest("hex"),
      );
      expect(lod0.dna!.bytes).toBe(promoted.byteLength);

      const documents = await Promise.all(
        [lod0, lod1].map((model) => new NodeIO().read(join(outputDir, model.glb))),
      );
      const document0 = documents[0]!;
      const document1 = documents[1]!;
      const jointsOf = (document: Awaited<ReturnType<NodeIO["read"]>>) =>
        document.getRoot().listNodes().filter((node) => node.getSkin()).map((node) => node.getName());
      expect(jointsOf(document1)).toEqual(jointsOf(document0));
      const targetsOf = (document: Awaited<ReturnType<NodeIO["read"]>>) =>
        document
          .getRoot()
          .listMeshes()
          .flatMap((mesh) => mesh.listPrimitives())
          .reduce((sum, primitive) => sum + primitive.listTargets().length, 0);
      expect(lod0.vertices).toBeGreaterThan(lod1.vertices);
      expect(targetsOf(document1)).toBeGreaterThan(0);
      expect(lod0.morphTargets).toBe(targetsOf(document0));
      expect(lod1.morphTargets).toBe(targetsOf(document1));
    },
    1_800_000,
  );
});
