import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Document, NodeIO } from "@gltf-transform/core";
import { describe, expect, it, onTestFinished } from "vitest";

import { importUnrealDirectory, meshGeometryScale } from "../src/unreal/importer.js";
import { writeFakeUmodel, writeMeshFixture } from "./helpers/unreal-fixture.js";

// A UE 4.26 pack built its street lights with BuildScale3D 1.4 and a tree with 3. Unreal multiplies the
// source model by that scale when it builds the render data, but the uncooked MeshDescription converter
// writes the source model as stored, so those pieces came out 1.4x and 3x too small (S2 bounds-size).

async function scratch(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** A UE 4.26-shaped StaticMesh package (legacy -7, object version 522) whose source model carries `scale`. */
function meshPackage(scale: readonly [number, number, number] | undefined): Buffer {
  const names = ["None", "/Script/Engine", "/Script/UnrealEd", "AssetImportData", "StaticMesh", "SourceModels", "BuildSettings", "BuildScale3D", "StructProperty", "Vector"];
  const fstring = (text: string): Buffer => {
    const raw = Buffer.from(`${text}\0`, "utf8");
    const length = Buffer.alloc(4);
    length.writeInt32LE(raw.length);
    return Buffer.concat([length, raw]);
  };
  const i32 = (value: number): Buffer => {
    const out = Buffer.alloc(4);
    out.writeInt32LE(value);
    return out;
  };
  const folder = fstring("/Game/Test");
  const summaryLength = 4 * 6 + 4 + folder.length + 4 + 4 + 4;
  const table = Buffer.concat(names.flatMap((name) => [fstring(name), Buffer.alloc(4)]));
  const header = Buffer.concat([
    i32(0x9e2a83c1 | 0), i32(-7), i32(864), i32(522), i32(0), i32(0), i32(summaryLength + table.length), folder, i32(0), i32(names.length), i32(summaryLength),
  ]);
  const name = (text: string): Buffer => Buffer.concat([i32(names.indexOf(text)), i32(0)]);
  const tag = scale
    ? Buffer.concat([
        name("BuildScale3D"), name("StructProperty"), i32(12), i32(0), name("Vector"), Buffer.alloc(16), Buffer.from([0]),
        ...scale.map((component) => {
          const out = Buffer.alloc(4);
          out.writeFloatLE(component);
          return out;
        }),
      ])
    : Buffer.alloc(0);
  return Buffer.concat([header, table, tag]);
}

/** Stands in for the uncooked converter: writes one triangle in centimetres, glTF x, y, z = Unreal y, z, x. */
async function writeFakeUncookedConverter(path: string, glb: string): Promise<void> {
  await writeFile(
    path,
    `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const { join } = require("node:path");
const argv = process.argv.slice(2);
if (argv.includes("--version")) { process.stdout.write("fake-uncooked 1\\n"); process.exit(0); }
if (argv.includes("--scene-json-dir")) process.exit(0);
const out = argv[argv.indexOf("--export-dir") + 1];
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(${JSON.stringify(glb)}, join(out, "Mesh.glb"));
`,
  );
  await chmod(path, 0o755);
}

async function importMesh(scale: readonly [number, number, number] | undefined) {
  const root = await scratch("md-build-scale-");
  const sourceDir = join(root, "source");
  const content = join(sourceDir, "Content", "Test");
  await mkdir(content, { recursive: true });
  await writeFile(join(content, "Mesh.uasset"), meshPackage(scale));
  const exported = join(root, "exported");
  await writeMeshFixture(exported, { name: "Mesh", materialName: "M_Plain", mat: "", props: "", textures: [] });
  // 100 cm along glTF x (Unreal y), 200 cm up (Unreal z), 300 cm along glTF z (Unreal x).
  const glb = join(root, "Mesh.glb");
  const document = new Document();
  const buffer = document.createBuffer();
  const position = document.createAccessor("POSITION").setType("VEC3").setArray(new Float32Array([0, 0, 0, 100, 0, 0, 0, 200, 300])).setBuffer(buffer);
  const normal = document.createAccessor("NORMAL").setType("VEC3").setArray(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0])).setBuffer(buffer);
  const primitive = document.createPrimitive().setAttribute("POSITION", position).setAttribute("NORMAL", normal).setMaterial(document.createMaterial("M_Plain"));
  document.createScene().addChild(document.createNode("Mesh").setMesh(document.createMesh("Mesh").addPrimitive(primitive)));
  await new NodeIO().write(glb, document);
  const umodel = join(root, "umodel");
  await writeFakeUmodel(umodel, { exportFrom: exported, classes: { Mesh: ["StaticMesh"] } });
  const uncooked = join(root, "uncooked-converter");
  await writeFakeUncookedConverter(uncooked, glb);
  const report = await importUnrealDirectory({
    sourceDir,
    outputDir: join(root, "output"),
    onlyPackages: ["Mesh"],
    concurrency: 1,
    freeSpaceBytes: 30_000_000_000,
    graphBake: false,
    environment: { ...process.env, THREENATIVE_UNREAL_CACHE_DIR: join(root, "cache"), THREENATIVE_TOOLCHAIN_DIR: join(root, "toolchain") },
    umodel: { name: "umodel", path: umodel, version: "fixture" },
    uncookedConverter: { name: "uncooked", path: uncooked, version: "fake-uncooked 1" },
  });
  const model = report.models.find((candidate) => candidate.name === "Mesh");
  if (!model) throw new Error(`no Mesh model: ${JSON.stringify(report.failed)}`);
  const out = await new NodeIO().read(join(root, "output", model.glb));
  const max = out.getRoot().listMeshes()[0]!.listPrimitives()[0]!.getAttribute("POSITION")!.getMax([0, 0, 0]);
  return { report, max: max.map((value) => Math.round(value * 1000) / 1000) };
}

describe("BuildScale3D on the uncooked MeshDescription route", () => {
  it("multiplies the source model by a uniform build scale, as Unreal's render data is", async () => {
    const { max, report } = await importMesh([1.4, 1.4, 1.4]);
    expect(max).toEqual([1.4, 2.8, 4.2]);
    expect(report.warnings.join("\n")).toContain("BuildScale3D (1.399999976158142, 1.399999976158142, 1.399999976158142); the decoded source geometry was scaled by it");
  });

  it("maps a non-uniform scale through the converter's axes (glTF x, y, z = Unreal y, z, x)", async () => {
    // Unreal (x, y, z) scale (2, 3, 5): glTF x (Unreal y) * 3, glTF y (Unreal z) * 5, glTF z (Unreal x) * 2.
    const { max } = await importMesh([2, 3, 5]);
    expect(max).toEqual([3, 10, 6]);
  });

  it("leaves a mesh without the property in metres as before", async () => {
    const { max, report } = await importMesh(undefined);
    expect(max).toEqual([1, 2, 3]);
    expect(report.warnings.join("\n")).not.toContain("BuildScale3D");
  });

  it("keeps UE Viewer's mapping (glTF x, y, z = Unreal x, z, y) for the other route", () => {
    expect(meshGeometryScale(false, [2, 3, 5])).toEqual([2, 5, 3]);
    expect(meshGeometryScale(false, undefined)).toBe(1);
    expect(meshGeometryScale(true, undefined)).toBe(0.01);
  });
});
