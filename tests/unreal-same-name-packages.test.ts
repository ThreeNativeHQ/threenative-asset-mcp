import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Document, NodeIO } from "@gltf-transform/core";
import { describe, expect, it, onTestFinished } from "vitest";

import { gamePackageKey, importUnrealDirectory, sharedBasenames } from "../src/unreal/importer.js";
import { writeFakeUmodel, writePng } from "./helpers/unreal-fixture.js";

// UE5 packs routinely hold two packages with one object name in different folders: two meshes (a well base in a
// props folder and in a level folder), or two material instances (one beside each of two posters). The CUE4Parse
// converter writes Meshes/<name>.glb and Materials/<name>.mat, so one run leaves a single file for both.

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "same-name-packages-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** A UE5 editor package head: magic, legacy -8, then the names a class sniff looks for. */
function ue5Package(names: readonly string[]): Buffer {
  const header = Buffer.alloc(28);
  header.writeUInt32LE(0x9e2a83c1, 0);
  header.writeInt32LE(-8, 4);
  header.writeInt32LE(864, 8);
  header.writeInt32LE(522, 12);
  header.writeInt32LE(1009, 16);
  return Buffer.concat([header, ...names.map((name) => Buffer.from(`\0${name}\0`, "latin1"))]);
}

async function triangle(path: string, height: number, material: string): Promise<void> {
  const document = new Document();
  const buffer = document.createBuffer();
  const position = document.createAccessor("POSITION").setType("VEC3").setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, height, 0])).setBuffer(buffer);
  const uv = document.createAccessor("TEXCOORD_0").setType("VEC2").setArray(new Float32Array([0, 0, 1, 0, 0, 1])).setBuffer(buffer);
  const primitive = document.createPrimitive().setAttribute("POSITION", position).setAttribute("TEXCOORD_0", uv).setMaterial(document.createMaterial(material));
  document.createScene().addChild(document.createNode("Mesh").setMesh(document.createMesh("Mesh").addPrimitive(primitive)));
  await mkdir(dirname(path), { recursive: true });
  await new NodeIO().write(path, document);
}

/**
 * A converter that behaves like the real one on names: an unfiltered run writes one Meshes/<name>.glb and one
 * Materials/<name>.mat per object name (the last package wins), a `--filter <relative path>` run writes only that package.
 * `outputs` maps a relative package path (or "" for the unfiltered run) to the files it writes.
 */
async function fakeConverter(path: string, outputs: Record<string, Record<string, string>>): Promise<void> {
  await writeFile(
    path,
    `#!/usr/bin/env node
const fs = require("node:fs");
const { dirname, join } = require("node:path");
const argv = process.argv.slice(2);
if (argv.includes("--version")) { process.stdout.write("fake-modern 1\\n"); process.exit(0); }
const out = argv[argv.indexOf("--export-dir") + 1];
const at = argv.indexOf("--filter");
const filter = at >= 0 ? argv[at + 1].replace(/^Content\\//, "") : "";
const outputs = ${JSON.stringify(outputs)};
for (const [target, source] of Object.entries(outputs[filter] || {})) {
  fs.mkdirSync(dirname(join(out, target)), { recursive: true });
  if (source.startsWith("text:")) fs.writeFileSync(join(out, target), source.slice(5));
  else fs.copyFileSync(source, join(out, target));
}
`,
  );
  await chmod(path, 0o755);
}

async function runImport(root: string, packages: Record<string, readonly string[]>, outputs: Record<string, Record<string, string>>) {
  const sourceDir = join(root, "source");
  const classes: Record<string, string[]> = {};
  for (const [relative, names] of Object.entries(packages)) {
    await mkdir(dirname(join(sourceDir, "Content", relative)), { recursive: true });
    await writeFile(join(sourceDir, "Content", `${relative}.uasset`), ue5Package(names));
    classes[relative.split("/").pop()!] = names.includes("StaticMesh") ? ["StaticMesh"] : [];
  }
  const umodel = join(root, "umodel");
  await writeFakeUmodel(umodel, { classes, listExitCode: 1 });
  const converter = join(root, "converter");
  await fakeConverter(converter, outputs);
  const outputDir = join(root, "output");
  const report = await importUnrealDirectory({
    sourceDir,
    outputDir,
    concurrency: 1,
    freeSpaceBytes: 30_000_000_000,
    graphBake: false,
    environment: { ...process.env, THREENATIVE_UNREAL_CACHE_DIR: join(root, "cache"), THREENATIVE_TOOLCHAIN_DIR: join(root, "toolchain") },
    umodel: { name: "umodel", path: umodel, version: "fixture" },
    modernConverter: { name: "modern", path: converter, version: "fake-modern 1" },
  });
  return { report, outputDir };
}

describe("helpers", () => {
  it("keys a package by its path under Content, from a /Game path or a relative file", () => {
    expect(gamePackageKey("/Game/Props/P2/MI_Same")).toBe("props/p2/mi_same");
    expect(gamePackageKey("Content/Props/P2/MI_Same.uasset")).toBe("props/p2/mi_same");
    expect(gamePackageKey("Pack/Content/Example/Content/X.uasset")).toBe("x");
    expect(gamePackageKey("Content/Pack/ExampleContent/X.uasset")).toBe("pack/examplecontent/x");
  });

  it("finds the entries whose basename another shares", () => {
    const entries = [{ package: "Content/A/SM_Dup.uasset" }, { package: "Content/B/sm_dup.uasset" }, { package: "Content/A/SM_One.uasset" }];
    expect(sharedBasenames(entries).map((entry) => entry.package)).toEqual(["Content/A/SM_Dup.uasset", "Content/B/sm_dup.uasset"]);
  });
});

describe("same-named UE5 packages", () => {
  const MESH = ["AssetImportData", "StaticMesh", "MeshDescriptionBulkData"];
  const MATERIAL = ["MaterialInstanceConstant", "MaterialInstanceBasePropertyOverrides"];

  it("gives each of two same-named meshes its own geometry and its own model file", async () => {
    const root = await scratch();
    const short = join(root, "short.glb");
    const tall = join(root, "tall.glb");
    await triangle(short, 1, "M_Plain");
    await triangle(tall, 3, "M_Plain");
    const { report } = await runImport(root, { "A/SM_Dup": MESH, "B/SM_Dup": MESH }, {
      // One run over both: the last package written wins Meshes/SM_Dup.glb.
      "": { "Meshes/SM_Dup.glb": tall },
      "A/SM_Dup": { "Meshes/SM_Dup.glb": short },
      "B/SM_Dup": { "Meshes/SM_Dup.glb": tall },
    });
    const byPackage = new Map(report.models.map((model) => [model.package.replace(/\\/g, "/"), model]));
    expect(byPackage.get("Content/A/SM_Dup.uasset")?.boundsMetres[1]).toBe(1);
    expect(byPackage.get("Content/B/SM_Dup.uasset")?.boundsMetres[1]).toBe(3);
    expect(new Set(report.models.map((model) => model.glb)).size).toBe(2);
  });

  it("binds the material instance from the package the mesh names, not the one the shared run wrote", async () => {
    const root = await scratch();
    const glb = join(root, "poster.glb");
    await triangle(glb, 1, "MI_Same");
    const one = join(root, "T_One.png");
    const two = join(root, "T_Two.png");
    await writePng(one, [200, 30, 30, 255], 4);
    await writePng(two, [30, 30, 200, 255], 4);
    const instance = (texture: string) => ({
      "Materials/MI_Same.mat": `text:Diffuse=${texture}\n`,
      "Materials/MI_Same.props.txt": "text:BlendMode = BLEND_Opaque\n",
      [`Materials/${texture}.png`]: texture === "T_One" ? one : two,
    });
    const { report } = await runImport(root, { "P1/MI_Same": MATERIAL, "P2/MI_Same": MATERIAL, "P2/SM_Poster": MESH }, {
      // The shared run looked the instance up by name and wrote the first package's copy.
      "": { "Meshes/SM_Poster.glb": glb, "Meshes/SM_Poster.materials.json": 'text:{"MI_Same":"/Game/P2/MI_Same"}', ...instance("T_One") },
      "P1/MI_Same": instance("T_One"),
      "P2/MI_Same": instance("T_Two"),
    });
    const poster = report.models.find((model) => model.name === "SM_Poster");
    expect(poster?.materials[0]?.bindings.find((binding) => binding.slot === "baseColor")?.texture).toBe("T_Two");
  });
});

describe("same-named UE4.26 packages on the MeshDescription route", () => {
  /** An uncooked 4.26 editor mesh head: legacy -7, object version 522, editor-only names. */
  function ue4Package(): Buffer {
    const header = Buffer.alloc(24);
    header.writeUInt32LE(0x9e2a83c1, 0);
    header.writeInt32LE(-7, 4);
    header.writeInt32LE(864, 8);
    header.writeInt32LE(522, 12);
    const names = ["/Script/UnrealEd", "AssetImportData", "SourceModels", "MeshDescriptionBulkData", "StaticMesh"];
    return Buffer.concat([header, ...names.map((name) => Buffer.from(`\0${name}\0`, "latin1"))]);
  }

  it("decodes each same-named mesh from an input tree that holds only it", async () => {
    const root = await scratch();
    const short = join(root, "short.glb");
    const tall = join(root, "tall.glb");
    await triangle(short, 1, "M_Plain");
    await triangle(tall, 3, "M_Plain");
    const sourceDir = join(root, "source");
    for (const folder of ["A", "B"]) {
      await mkdir(join(sourceDir, "Content", folder), { recursive: true });
      await writeFile(join(sourceDir, "Content", folder, "SM_Dup.uasset"), ue4Package());
    }
    // Writes Meshes/<name>.glb for every mesh under its input, folder B last (it wins a shared name), at centimetres.
    const uncooked = join(root, "uncooked");
    await writeFile(
      uncooked,
      `#!/usr/bin/env node
const fs = require("node:fs");
const { join } = require("node:path");
const argv = process.argv.slice(2);
if (argv.includes("--version")) { process.stdout.write("fake-uncooked 1\\n"); process.exit(0); }
const out = argv[argv.indexOf("--export-dir") + 1];
fs.mkdirSync(join(out, "Meshes"), { recursive: true });
for (const folder of ["A", "B"]) {
  if (fs.existsSync(join(argv[0], "Content", folder, "SM_Dup.uasset"))) {
    fs.copyFileSync(folder === "A" ? ${JSON.stringify(short)} : ${JSON.stringify(tall)}, join(out, "Meshes", "SM_Dup.glb"));
  }
}
`,
    );
    await chmod(uncooked, 0o755);
    const umodel = join(root, "umodel");
    await writeFakeUmodel(umodel, { classes: { SM_Dup: ["StaticMesh"] } });
    const report = await importUnrealDirectory({
      sourceDir,
      outputDir: join(root, "output"),
      concurrency: 1,
      freeSpaceBytes: 30_000_000_000,
      graphBake: false,
      environment: { ...process.env, THREENATIVE_UNREAL_CACHE_DIR: join(root, "cache"), THREENATIVE_TOOLCHAIN_DIR: join(root, "toolchain") },
      umodel: { name: "umodel", path: umodel, version: "fixture" },
      uncookedConverter: { name: "uncooked", path: uncooked, version: "fake-uncooked 1" },
    });
    const byPackage = new Map(report.models.map((model) => [model.package.replace(/\\/g, "/"), model]));
    // The MeshDescription converter writes centimetres: 1 and 3 become 0.01 and 0.03 m.
    expect(byPackage.get("Content/A/SM_Dup.uasset")?.boundsMetres[1]).toBeCloseTo(0.01, 6);
    expect(byPackage.get("Content/B/SM_Dup.uasset")?.boundsMetres[1]).toBeCloseTo(0.03, 6);
  });
});
