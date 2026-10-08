import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { importUnrealDirectory, isWorldPartitionExternalPackage, WORLD_PARTITION_EXTERNAL_REASON } from "../src/unreal/importer.js";
import { writeFakeUmodel, writeMeshFixture, writePng } from "./helpers/unreal-fixture.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("World Partition external packages", () => {
  it("recognises __ExternalActors__ and __ExternalObjects__ segments case-insensitively", () => {
    expect(isWorldPartitionExternalPackage("Content/__ExternalActors__/Pack/0/23/abc.uasset")).toBe(true);
    expect(isWorldPartitionExternalPackage("__externalobjects__\\Pack\\0\\1\\abc.uasset")).toBe(true);
    expect(isWorldPartitionExternalPackage("Content/Meshes/SM_ExternalActors.uasset")).toBe(false);
    expect(isWorldPartitionExternalPackage("Content/Meshes/SM_Car.uasset")).toBe(false);
  });

  it("skips external actor packages instead of failing them as meshes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "external-actors-"));
    directories.push(directory);
    const sourceDir = join(directory, "source");
    const fixture = join(directory, "fixture");
    const outputDir = join(directory, "output");
    const meshes = join(sourceDir, "Content", "Meshes");
    const actors = join(sourceDir, "Content", "__ExternalActors__", "Pack", "0", "23");
    await mkdir(meshes, { recursive: true });
    await mkdir(actors, { recursive: true });
    await writeFile(join(meshes, "SM_Car.uasset"), Buffer.alloc(16));
    await writeFile(join(actors, "abc123hash.uasset"), Buffer.alloc(16));
    await writeMeshFixture(fixture, { name: "SM_Car", materialName: "M_Car", mat: "Diffuse=Albedo", props: "", textures: ["Albedo"] });
    await writePng(join(fixture, "Albedo.png"), [120, 110, 100, 255]);
    const tool = join(directory, "umodel");
    await writeFakeUmodel(tool, { exportFrom: fixture, classes: { SM_Car: ["StaticMesh"], abc123hash: ["StaticMesh"] } });
    const report = await importUnrealDirectory({
      sourceDir,
      outputDir,
      concurrency: 1,
      graphBake: false,
      freeSpaceBytes: 30_000_000_000,
      umodel: { name: "umodel", path: tool, version: "fixture" },
    });
    expect(report.models.map((m) => m.name)).toEqual(["SM_Car"]);
    expect(report.failed).toEqual([]);
    expect(report.skipped).toEqual([
      { package: "Content/__ExternalActors__/Pack/0/23/abc123hash.uasset", reason: WORLD_PARTITION_EXTERNAL_REASON },
    ]);
    expect(WORLD_PARTITION_EXTERNAL_REASON).toBe("World Partition external actor/object package (level data, not an asset)");
  });
});
