import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CUE4PARSE_PROGRAM } from "../src/unreal/cue4parse-adapter.js";
import { modernSdkExecutable } from "../src/unreal/provision.js";
import { childEnvironment, runBounded } from "../src/unreal/toolchain.js";
import { compileProject } from "./helpers/material-overrides-harness.js";
import { describeWithTools } from "./helpers/require-tool.js";
import {
  importUnrealDirectory,
  isWorldPartitionExternalPackage,
  shouldSkipWorldPartitionExternalPackage,
  worldPartitionExternalActorMap,
  WORLD_PARTITION_EXTERNAL_REASON,
} from "../src/unreal/importer.js";
import { writeFakeUmodel, writeMeshFixture, writePng } from "./helpers/unreal-fixture.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

// ULevel's external actor directory preserves the mount and full map path before the three hash segments.
const ownershipCases = [
  ["Content/__ExternalActors__/Maps/City/0/23/actor.uasset", "Content/Maps/City.umap", true],
  ["Project/Content/__ExternalActors__/Maps/City/0/23/actor.uasset", "Project/Content/Maps/City.umap", true],
  ["Plugins/A/Content/__ExternalActors__/Maps/City/0/23/actor.uasset", "Plugins/A/Content/Maps/City.umap", true],
  ["Plugins/A/Content/__ExternalActors__/Maps/City/0/23/actor.uasset", "Plugins/B/Content/Maps/City.umap", false],
  ["Plugins/A/Content/__ExternalActors__/Maps/City/0/23/actor.uasset", "Content/Maps/City.umap", false],
  ["Content/__ExternalActors__/Maps/City/0/23/actor.uasset", "Project/Content/Maps/City.umap", false],
  ["plugins/a/content/__externalactors__/maps/city/0/23/actor.UASSET", "Plugins/A/Content/Maps/City.UMAP", true],
  ["Project\\Content\\__ExternalActors__\\Maps\\City\\0\\23\\actor.uasset", "Project/Content/Maps/City.umap", true],
  ["Content/__ExternalActors__/Other/Maps/City/0/23/actor.uasset", "Content/Maps/City.umap", false],
  ["Content/__ExternalObjects__/Maps/City/0/23/object.uasset", "Content/Maps/City.umap", false],
  ["Content/__ExternalActors__/Maps/Other/0/23/actor.uasset", "Content/Maps/City.umap", false],
  ["Content/__ExternalActors__/Maps/City/0/actor.uasset", "Content/Maps/City.umap", false],
] as const;

describe("public external actor mount ownership", () => {
  it.each(ownershipCases)("%s belongs to %s: %s", (actor, level, owns) => {
    expect(shouldSkipWorldPartitionExternalPackage(actor, [level])).toBe(!owns);
  });
});

describeWithTools(["modern-converter"], "compiled production external actor mount ownership", () => {
  let directory = "";
  let results: boolean[] = [];
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "tn-external-actor-mount-"));
    // Extract the shipped methods verbatim; no alternate ownership implementation in the harness.
    const start = CUE4PARSE_PROGRAM.indexOf("static string SourceRelativePackagePath(");
    const end = CUE4PARSE_PROGRAM.indexOf("IEnumerable<UObject> ActorsForLevel(", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const calls = ownershipCases.map(([actor, level]) => `IsExternalActorForLevel(${JSON.stringify(actor)}, ${JSON.stringify(level)})`);
    const build = await compileProject(directory, "ActorMount", {
      "Program.cs": `Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(new bool[] { ${calls.join(",")} }));\n${CUE4PARSE_PROGRAM.slice(start, end)}`,
    });
    expect(build.code, build.output).toBe(0);
    const run = await runBounded(await modernSdkExecutable(), [build.dll], {
      timeoutMs: 30_000, environment: childEnvironment(process.env),
    });
    expect(run.code, run.stderr).toBe(0);
    results = JSON.parse(run.stdout);
  }, 120_000);
  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  it.each(ownershipCases.map(([actor, level, owns], index) => ({ actor, level, owns, index })))(
    "$actor belongs to $level: $owns", ({ owns, index }) => {
      expect(results[index]).toBe(owns);
    },
  );
});

describe("World Partition external packages", () => {
  it("recognises __ExternalActors__ and __ExternalObjects__ segments case-insensitively", () => {
    expect(isWorldPartitionExternalPackage("Content/__ExternalActors__/Pack/0/23/abc.uasset")).toBe(true);
    expect(isWorldPartitionExternalPackage("__externalobjects__\\Pack\\0\\1\\abc.uasset")).toBe(true);
    expect(isWorldPartitionExternalPackage("Content/Meshes/SM_ExternalActors.uasset")).toBe(false);
    expect(isWorldPartitionExternalPackage("Content/Meshes/SM_Car.uasset")).toBe(false);
  });

  it("associates actor packages with their map and leaves unrelated maps skipped", () => {
    const actor = "Content/__ExternalActors__/Maps/Imported/00/FH/actor.uasset";
    const otherActor = "Content/__ExternalActors__/Maps/Other/00/FH/actor.uasset";
    const sameBasenameDifferentPrefix = "Content/__ExternalActors__/Other/Maps/Imported/00/FH/actor.uasset";
    const object = "Content/__ExternalObjects__/Maps/Imported/00/FH/object.uasset";
    expect(worldPartitionExternalActorMap(actor)).toBe("Content/Maps/Imported.umap");
    expect(shouldSkipWorldPartitionExternalPackage(actor, ["Content/Maps/Imported.umap"])).toBe(false);
    expect(shouldSkipWorldPartitionExternalPackage(otherActor, ["Content/Maps/Imported.umap"])).toBe(true);
    expect(worldPartitionExternalActorMap(sameBasenameDifferentPrefix)).toBe("Content/Other/Maps/Imported.umap");
    expect(shouldSkipWorldPartitionExternalPackage(sameBasenameDifferentPrefix, ["Content/Maps/Imported.umap"])).toBe(true);
    expect(shouldSkipWorldPartitionExternalPackage(object, ["Content/Maps/Imported.umap"])).toBe(true);
  });

  it("skips external actor packages instead of failing them as meshes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "external-actors-"));
    directories.push(directory);
    const sourceDir = join(directory, "source");
    const fixture = join(directory, "fixture");
    const outputDir = join(directory, "output");
    const meshes = join(sourceDir, "Content", "Meshes");
    const actors = join(sourceDir, "Content", "__ExternalActors__", "Maps", "NotImported", "00", "23");
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
      { package: "Content/__ExternalActors__/Maps/NotImported/00/23/abc123hash.uasset", reason: WORLD_PARTITION_EXTERNAL_REASON },
    ]);
    expect(WORLD_PARTITION_EXTERNAL_REASON).toBe("World Partition external actor/object package (level data, not an asset)");
  });
});
