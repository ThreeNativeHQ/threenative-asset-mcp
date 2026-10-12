import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { NodeIO } from "@gltf-transform/core";
import { afterAll, describe, expect, it } from "vitest";

import { CUE4PARSE_SOURCE } from "../src/unreal/cue4parse-adapter.js";
import { importUnrealDirectory } from "../src/unreal/importer.js";

// Real-pack regression for uncooked UE5 static meshes. The known Hornbeam download is licensed and local-only;
// the converter path may point at a private proof wrapper, so this suite never installs or replaces toolchain files.
const HORNBEAM = process.env.THREENATIVE_UE5_EDITOR_PACK?.trim() || join(
  homedir(),
  ".cache/threenative-asset-mcp/fab-downloads/parity-20261010T190956-00bdf8/c6f917b6-ffcb-4b86-9d9f-5274ba7f6a8e/MS_Hornbeam_UE51_V2/Content",
);
const CONVERTER = process.env.THREENATIVE_NATIVE_CONVERTER_PATH?.trim() || join(homedir(), ".cache/threenative-asset-mcp/toolchain/modern/bin/ThreeNativeConverter");
const MESH_SELECTOR = process.env.THREENATIVE_UE5_EDITOR_MESH_SELECTOR?.trim();

function converterReady(): boolean {
  try {
    return execFileSync(CONVERTER, ["--version"], { encoding: "utf8" }).includes(CUE4PARSE_SOURCE.version);
  } catch {
    return false;
  }
}

const ready = existsSync(HORNBEAM) && converterReady() && Boolean(MESH_SELECTOR);
const outputs: string[] = [];
afterAll(async () => {
  await Promise.all(outputs.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function triangleCount(glb: string): Promise<number> {
  const document = await new NodeIO().read(glb);
  return document
    .getRoot()
    .listMeshes()
    .flatMap((mesh) => mesh.listPrimitives())
    .reduce((sum, primitive) => sum + (primitive.getIndices()?.getCount() ?? 0) / 3, 0);
}

describe.skipIf(!ready)("uncooked UE5 Megascans (local European Hornbeam download)", () => {
  it(
    "decodes requested StaticMesh source-model LODs and names each payload-backed output",
    async () => {
      const outputDir = await mkdtemp(join(tmpdir(), "asset-mcp-ue5-editor-"));
      outputs.push(outputDir);
      const report = await importUnrealDirectory({
        sourceDir: HORNBEAM,
        outputDir,
        onlyPackages: [MESH_SELECTOR!],
        modernConverter: { name: "modern", path: CONVERTER, version: CUE4PARSE_SOURCE.version },
        lods: [0, 1, 2],
      });
      expect(report.failed).toEqual([]);
      const base = report.models.find((model) => !/_LOD\d+\.glb$/i.test(model.glb));
      expect(base).toBeDefined();
      const lodPaths = [base!.glb, base!.glb.replace(/\.glb$/i, "_LOD1.glb"), base!.glb.replace(/\.glb$/i, "_LOD2.glb")];
      expect(report.models.map((model) => model.glb)).toEqual(lodPaths);
      const counts = await Promise.all(lodPaths.map((path) => triangleCount(join(outputDir, path))));
      expect(counts).toEqual([115_674, 41_543, 15_076]);
    },
    900_000,
  );
});
