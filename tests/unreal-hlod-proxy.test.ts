import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import { HLOD_PROXY_REASON, importUnrealDirectory } from "../src/unreal/importer.js";
import { writeFakeUmodel, writeMeshFixture } from "./helpers/unreal-fixture.js";

// A level's HLOD package (Maps/HLOD/<Level>_0_HLOD) holds an HLODProxy and the generated, reduced cluster meshes of
// that level. It is build output: the importer reports it as skipped with the reason instead of failing to decode it.

/** An uncooked UE4.18 package head whose name table carries `names`. */
function packageHead(names: readonly string[]): Buffer {
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x9e2a83c1, 0);
  header.writeInt32LE(-7, 4);
  header.writeInt32LE(864, 8);
  header.writeInt32LE(514, 12);
  return Buffer.concat([header, ...names.map((name) => Buffer.from(`\0${name}\0`, "latin1"))]);
}

describe("HLOD proxy packages", () => {
  it("are skipped with the reason, and the level's own meshes still import", async () => {
    const root = await mkdtemp(join(tmpdir(), "hlod-proxy-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const sourceDir = join(root, "source");
    await mkdir(join(sourceDir, "Content", "Maps", "HLOD"), { recursive: true });
    await mkdir(join(sourceDir, "Content", "Props"), { recursive: true });
    await writeFile(join(sourceDir, "Content", "Maps", "HLOD", "Level_0_HLOD.uasset"), packageHead(["HLODProxy", "HLODProxyDesc", "StaticMesh", "SourceModels"]));
    await writeFile(join(sourceDir, "Content", "Props", "Mesh.uasset"), packageHead(["StaticMesh", "SourceModels"]));
    const exported = join(root, "exported");
    await writeMeshFixture(exported, { name: "Mesh", materialName: "M_Plain", mat: "", props: "", textures: [] });
    const argvLog = join(root, "umodel.log");
    const umodel = join(root, "umodel");
    await writeFakeUmodel(umodel, { exportFrom: exported, classes: { Mesh: ["StaticMesh"], Level_0_HLOD: ["StaticMesh", "HLODProxy"] }, argvLog });
    const report = await importUnrealDirectory({
      sourceDir,
      outputDir: join(root, "output"),
      concurrency: 1,
      freeSpaceBytes: 30_000_000_000,
      graphBake: false,
      environment: { ...process.env, THREENATIVE_UNREAL_CACHE_DIR: join(root, "cache") },
      umodel: { name: "umodel", path: umodel, version: "fixture" },
    });
    expect(report.models.map((model) => model.name)).toEqual(["Mesh"]);
    expect(report.skipped).toContainEqual({ package: expect.stringMatching(/Level_0_HLOD\.uasset$/), reason: HLOD_PROXY_REASON });
    expect(report.failed).toEqual([]);
  });
});
