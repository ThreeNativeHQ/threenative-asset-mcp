import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { importUnrealDirectory } from "../src/unreal/importer.js";
import { writeFakeUmodel, writeMeshFixture } from "./helpers/unreal-fixture.js";
import { float, input, materialPackage, subsetInstance, subsetMaster } from "./helpers/unreal-material-source.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

// An authored-source material that cannot be decoded must never abort a mesh import.
const corruptions = {
  "negative expression output index": () => materialPackage([
    { name: "Bad", className: "Material", properties: [input("Roughness", 2, 0, -1)] },
    { name: "Constant", className: "MaterialExpressionConstant", properties: [float("R", 0.5)] },
  ]),
  "duplicate property key": () => materialPackage([
    { name: "Bad", className: "Material", properties: [float("OpacityMaskClipValue", 0.1), float("OpacityMaskClipValue", 0.2)] },
  ]),
  "parent cycle": () => materialPackage([{ name: "Bad", className: "MaterialInstanceConstant", properties: [{ name: "Parent", type: "ObjectProperty", value: "/Game/Kit/Bad" }] }], ["/Game/Kit/Bad"]),
} as const;

it.each(Object.keys(corruptions) as (keyof typeof corruptions)[])("degrades an unreadable source material (%s) without losing the mesh", async (kind) => {
  const directory = await mkdtemp(join(tmpdir(), "source-degrade-")); directories.push(directory);
  const sourceDir = join(directory, "source"); const kit = join(sourceDir, "Content", "Kit");
  const fixture = join(directory, "fixture"); const outputDir = join(directory, "output");
  await mkdir(kit, { recursive: true });
  await writeFile(join(kit, "Master.uasset"), subsetMaster());
  await writeFile(join(kit, "Instance.uasset"), subsetInstance("Instance", 5));
  await writeFile(join(kit, "Bad.uasset"), corruptions[kind]());
  for (const mesh of ["MeshBadOne", "MeshBadTwo", "MeshGood"]) {
    await writeFile(join(kit, `${mesh}.uasset`), Buffer.alloc(16));
    await writeMeshFixture(fixture, { name: mesh, materialName: mesh === "MeshGood" ? "Instance" : "Bad", mat: "Diffuse=Albedo", props: "", textures: ["Albedo"] });
  }
  const tool = join(directory, "umodel");
  await writeFakeUmodel(tool, { exportFrom: fixture, emptyExports: ["Master", "Instance", "Bad"], classes: { MeshBadOne: ["StaticMesh"], MeshBadTwo: ["StaticMesh"], MeshGood: ["StaticMesh"], Master: ["Material"], Instance: ["MaterialInstanceConstant"], Bad: [kind === "parent cycle" ? "MaterialInstanceConstant" : "Material"] } });
  const report = await importUnrealDirectory({ sourceDir, outputDir, concurrency: 1, graphBake: false, freeSpaceBytes: 30_000_000_000, umodel: { name: "umodel", path: tool, version: "fixture" } });
  expect(report.failed).toEqual([]);
  expect(report.models.map((m) => m.name).sort()).toEqual(["MeshBadOne", "MeshBadTwo", "MeshGood"]);
  for (const name of ["MeshBadOne", "MeshBadTwo"]) {
    const limitations = report.models.find((m) => m.name === name)!.materials[0]!.limitations.join("\n");
    expect(limitations).toContain("Source material unreadable");
    expect(limitations).toContain("authored roughness/AO not applied");
  }
  expect(report.warnings.filter((w) => w.startsWith("Source material unreadable"))).toHaveLength(1);
  const good = report.models.find((m) => m.name === "MeshGood")!.materials[0]!;
  expect(good.factors.roughness).toBe(1);
  expect(good.limitations.join("\n")).toContain("authored Roughness 5");
  expect(good.limitations.join("\n")).not.toContain("Source material unreadable");
});
