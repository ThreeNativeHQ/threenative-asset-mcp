import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Document, NodeIO } from "@gltf-transform/core";
import { describe, expect, it, onTestFinished } from "vitest";

import { importUnrealDirectory, validateGlb } from "../src/unreal/importer.js";
import { writeFakeUmodel, writeMeshFixture, writePng, type FakeUmodelOptions } from "./helpers/unreal-fixture.js";

async function scratch(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** A package head: the magic, the legacy version, the UE4 object version, then the name table. */
function packageHead(names: readonly string[], legacy: number, ue4 = 522): Buffer {
  const header = Buffer.alloc(24);
  header.writeUInt32LE(0x9e2a83c1, 0);
  header.writeInt32LE(legacy, 4);
  header.writeInt32LE(864, 8);
  header.writeInt32LE(ue4, 12);
  header.writeInt32LE(0, 16);
  header.writeInt32LE(names.length, 20);
  const table = names.map((name) => {
    const bytes = Buffer.from(`${name}\0`, "latin1");
    const length = Buffer.alloc(4);
    length.writeInt32LE(bytes.length, 0);
    return Buffer.concat([length, bytes]);
  });
  return Buffer.concat([header, ...table]);
}

const MESH_NAMES = ["/Script/Engine", "/Script/UnrealEd", "AssetImportData", "StaticMesh", "SourceModels"];
const LEVEL_NAMES = ["/Script/Engine", "PersistentLevel", "WorldSettings", "Level"];
/** A level named after its World, whose name table also holds the Texture2D auxiliary beside it. */
const WORLD_LEVEL_NAMES = [...LEVEL_NAMES, "World", "DemoMap", "Texture2D", "Texture2D_0"];

interface ConverterBehaviour {
  readonly failScenes?: boolean;
  readonly failMeshes?: boolean;
  /** Writes a scene source for every `.umap` under the source tree, as the real converter parses every level it finds. */
  readonly writeScenes?: boolean;
}

interface LevelSpec {
  readonly name: string;
  readonly legacy: number;
  /** The name table the level is written with; defaults to `LEVEL_NAMES`. */
  readonly names?: readonly string[];
  /** The UE4 object version the header records; defaults to 522, a version the scene parser is verified for. */
  readonly objectVersion?: number;
}

interface RunOptions {
  readonly behaviour: ConverterBehaviour;
  readonly levels: readonly LevelSpec[];
  /** `<package>` → the (class, object name) rows UE Viewer lists, for a package whose objects are named differently. */
  readonly objects?: FakeUmodelOptions["objects"];
  /** Standalone Texture2D packages, each named after its one object; UE Viewer exports `<name>.png` for them. */
  readonly textures?: readonly string[];
}

/** Stands in for the Python uncooked converter: meshes copy a prepared GLB, a scene run fails or
 * writes nothing, and every argv is logged so a test sees which invocations happened. */
async function writeFakeUncookedConverter(path: string, glb: string, argvLog: string, behaviour: ConverterBehaviour): Promise<void> {
  await writeFile(
    path,
    `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const { basename, join } = require("node:path");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(argv) + "\\n");
if (argv.includes("--version")) { process.stdout.write("fake-uncooked 1\\n"); process.exit(0); }
const behaviour = ${JSON.stringify(behaviour)};
if (argv.includes("--scene-json-dir")) {
  if (behaviour.failScenes) {
    process.stderr.write("ValueError: Unexpected LegacyFileVersion: -8 (expected -7 for UE4.27)\\n");
    process.exit(1);
  }
  if (behaviour.writeScenes) {
    const directory = argv[argv.indexOf("--scene-json-dir") + 1];
    fs.mkdirSync(directory, { recursive: true });
    for (const file of fs.readdirSync(argv[0], { recursive: true })) {
      if (!String(file).toLowerCase().endsWith(".umap")) continue;
      const map = basename(String(file), ".umap");
      const origin = { x: 0, y: 0, z: 0 };
      const rotation = { pitch: 0, yaw: 0, roll: 0 };
      fs.writeFileSync(join(directory, map + ".scene-source.json"), JSON.stringify({
        format: "threenative-unreal-scene-source", version: 1, mapName: map, sourceFile: String(file),
        actors: [{ name: "Floor", meshName: "Mesh", location: origin, rotation, scale: { x: 1, y: 1, z: 1 }, parent: "" }],
        lights: [], blueprintComponents: 0, camera: { hasCamera: false, location: origin, rotation },
      }));
    }
  }
  process.exit(0);
}
if (behaviour.failMeshes) process.exit(1);
const out = argv[argv.indexOf("--export-dir") + 1];
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(${JSON.stringify(glb)}, join(out, "Mesh.glb"));
process.exit(0);
`,
  );
  await chmod(path, 0o755);
}

async function writeFakeModernConverter(path: string, argvLog: string): Promise<void> {
  await writeFile(
    path,
    `#!/usr/bin/env node
"use strict";
require("node:fs").appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");
process.exit(1);
`,
  );
  await chmod(path, 0o755);
}

async function run(options: RunOptions) {
  const root = await scratch("level-gate-");
  const sourceDir = join(root, "source");
  const content = join(sourceDir, "Content", "Test");
  const exported = join(root, "exported");
  const outputDir = join(root, "output");
  await mkdir(content, { recursive: true });
  await writeFile(join(content, "Mesh.uasset"), packageHead(MESH_NAMES, -7));
  for (const level of options.levels) await writeFile(join(content, `${level.name}.umap`), packageHead(level.names ?? LEVEL_NAMES, level.legacy, level.objectVersion));
  for (const texture of options.textures ?? []) {
    await writeFile(join(content, `${texture}.uasset`), packageHead(["/Script/Engine", "Texture2D", texture, "TextureSource"], -7));
  }
  await writeMeshFixture(exported, { name: "Mesh", materialName: "MI_Rock", mat: "", props: "", textures: [] });
  for (const texture of options.textures ?? []) await writePng(join(exported, `${texture}.png`), [200, 120, 60, 255]);
  const glb = join(root, "Mesh.glb");
  const document = new Document();
  const buffer = document.createBuffer();
  const position = document.createAccessor("POSITION").setType("VEC3").setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 2, 0])).setBuffer(buffer);
  const normal = document.createAccessor("NORMAL").setType("VEC3").setArray(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1])).setBuffer(buffer);
  const material = document.createMaterial("MI_Rock");
  const primitive = document.createPrimitive().setAttribute("POSITION", position).setAttribute("NORMAL", normal).setMaterial(material);
  const mesh = document.createMesh("Mesh").addPrimitive(primitive);
  document.createScene().addChild(document.createNode("Mesh").setMesh(mesh));
  await new NodeIO().write(glb, document);

  const classes: Record<string, string[]> = { Mesh: ["StaticMesh"] };
  for (const level of options.levels) classes[level.name] = ["Level"];
  for (const texture of options.textures ?? []) classes[texture] = ["Texture2D"];
  const umodel = join(root, "umodel");
  const umodelLog = join(root, "umodel.log");
  await writeFakeUmodel(umodel, {
    exportFrom: exported,
    classes,
    argvLog: umodelLog,
    ...(options.objects === undefined ? {} : { objects: options.objects }),
  });
  const uncookedLog = join(root, "uncooked.log");
  const modernLog = join(root, "modern.log");
  const uncooked = join(root, "uncooked-converter");
  const modern = join(root, "modern-converter");
  await writeFakeUncookedConverter(uncooked, glb, uncookedLog, options.behaviour);
  await writeFakeModernConverter(modern, modernLog);
  const toolchain = join(root, "toolchain");
  const attempt = importUnrealDirectory({
    sourceDir,
    outputDir,
    concurrency: 1,
    freeSpaceBytes: 30_000_000_000,
    graphBake: false,
    environment: { ...process.env, THREENATIVE_UNREAL_CACHE_DIR: join(root, "cache"), THREENATIVE_TOOLCHAIN_DIR: toolchain },
    umodel: { name: "umodel", path: umodel, version: "fixture" },
    uncookedConverter: { name: "uncooked", path: uncooked, version: "fake-uncooked 1" },
    modernConverter: { name: "modern", path: modern, version: "fake-modern 1" },
  });
  const read = async (path: string) =>
    (await readFile(path, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
  return { attempt, uncookedCalls: () => read(uncookedLog), modernCalls: () => read(modernLog), umodelCalls: () => read(umodelLog), outputDir };
}

describe("uncooked converter isolation between meshes and levels", () => {
  it("keeps the meshes when the scene run fails, and reports the level as failed", async () => {
    const { attempt, uncookedCalls } = await run({ behaviour: { failScenes: true }, levels: [{ name: "Town", legacy: -7 }] });
    const report = await attempt;
    expect(report.models.map((model) => model.name)).toContain("Mesh");
    expect(report.scenes).toHaveLength(0);
    expect(report.warnings.join("\n")).toMatch(/Scene reconstruction failed \(.*LegacyFileVersion: -8.*\); 1 level skipped/);
    expect(report.failed).toContainEqual(expect.objectContaining({ package: expect.stringContaining("Town.umap") }));
    const calls = (await uncookedCalls()).filter((argv) => !argv.includes("--version"));
    expect(calls).toHaveLength(2);
    const [meshRun, sceneRun] = calls;
    expect(meshRun).toContain("--skip-textures");
    expect(meshRun).not.toContain("--scene-json-dir");
    expect(sceneRun).toContain("--skip-export");
    expect(sceneRun).toContain("--scene-json-dir");
  });

  it("never hands a UE5 level to the UE4-only scene parser", async () => {
    const { attempt, uncookedCalls, modernCalls } = await run({ behaviour: {}, levels: [{ name: "Canal", legacy: -8 }] });
    const report = await attempt;
    expect(report.models.map((model) => model.name)).toContain("Mesh");
    expect(report.failed).toContainEqual(expect.objectContaining({ package: expect.stringContaining("Canal.umap") }));
    expect((await uncookedCalls()).some((argv) => argv.includes("--scene-json-dir"))).toBe(false);
    expect((await modernCalls()).some((argv) => argv.join(" ").includes("Canal"))).toBe(true);
  });

  it("still fails the whole import when the mesh run fails", async () => {
    const { attempt } = await run({ behaviour: { failMeshes: true }, levels: [] });
    await expect(attempt).rejects.toMatchObject({ code: "UNREAL_TOOL_FAILED" });
  });
});

describe("a package-named World owns the Texture2D exports beside it", () => {
  /** What UE Viewer lists for a level named after its World: the World, a Texture2D auxiliary, and the PersistentLevel. */
  const LEVEL_OBJECTS = [
    { className: "World", objectName: "DemoMap" },
    { className: "Texture2D", objectName: "Texture2D_0" },
    { className: "Level", objectName: "PersistentLevel" },
  ];

  it("reconstructs the level and keeps its meshes, without a texture export for the package", async () => {
    const { attempt, outputDir, umodelCalls } = await run({
      behaviour: { writeScenes: true },
      levels: [{ name: "DemoMap", legacy: -7, names: WORLD_LEVEL_NAMES }],
      objects: { DemoMap: LEVEL_OBJECTS },
    });
    const report = await attempt;
    expect(report.failed).toEqual([]);
    expect(report.models.map((model) => model.name)).toEqual(["Mesh"]);
    expect(report.scenes.map((scene) => scene.name)).toEqual(["DemoMap"]);
    const scene = report.scenes[0]!;
    await expect(validateGlb(join(outputDir, scene.glb))).resolves.toMatchObject({ bytes: scene.bytes });
    expect((await umodelCalls()).filter((argv) => argv.includes("-export") && argv.at(-1)?.endsWith("DemoMap"))).toEqual([]);
    expect(report.warnings.join("\n")).toMatch(/\(Texture2D_0\).*unverified/);
  });

  it("still exports a standalone Texture2D whose object carries its own package name", async () => {
    const { attempt } = await run({ behaviour: {}, levels: [], textures: ["T_Rock"] });
    const report = await attempt;
    expect(report.failed).toEqual([]);
    expect(report.textures.map((texture) => texture.name)).toEqual(["T_Rock"]);
  });

  it("does not take a Texture2D namesake inside the level for the package's own texture", async () => {
    const { attempt, umodelCalls } = await run({
      behaviour: { writeScenes: true },
      levels: [{ name: "DemoMap", legacy: -7, names: WORLD_LEVEL_NAMES }],
      objects: { DemoMap: [...LEVEL_OBJECTS, { className: "Texture2D", objectName: "DemoMap" }] },
    });
    const report = await attempt;
    expect(report.failed).toEqual([]);
    expect(report.textures).toEqual([]);
    expect(report.scenes.map((scene) => scene.name)).toEqual(["DemoMap"]);
    expect((await umodelCalls()).filter((argv) => argv.includes("-export") && argv.at(-1)?.endsWith("DemoMap"))).toEqual([]);
    expect(report.warnings.join("\n")).toMatch(/\(Texture2D_0, DemoMap\).*unverified/);
  });

  // Object version 516 is UE 4.19, below the 517–522 range the scene parser is verified for: the level is skipped with
  // its reason and never handed to either converter, and the standalone texture beside it still exports.
  it("skips a UE 4.19 World (object version 516) with its reason, without a scene, a texture export or a failure", async () => {
    const { attempt, uncookedCalls, umodelCalls } = await run({
      behaviour: { writeScenes: true },
      levels: [{ name: "DemoMap", legacy: -7, objectVersion: 516, names: WORLD_LEVEL_NAMES }],
      objects: { DemoMap: LEVEL_OBJECTS },
      textures: ["T_Rock"],
    });
    const report = await attempt;
    expect(report.failed).toEqual([]);
    expect(report.skipped).toContainEqual(
      expect.objectContaining({ package: expect.stringContaining("DemoMap.umap"), reason: expect.stringContaining("object version 516") }),
    );
    expect(report.scenes).toEqual([]);
    expect(report.models.map((model) => model.name)).toEqual(["Mesh"]);
    expect(report.textures.map((texture) => texture.name)).toEqual(["T_Rock"]);
    expect((await uncookedCalls()).some((argv) => argv.includes("--scene-json-dir"))).toBe(false);
    expect((await umodelCalls()).filter((argv) => argv.includes("-export") && argv.at(-1)?.endsWith("DemoMap"))).toEqual([]);
    expect(report.warnings.join("\n")).toMatch(/\(Texture2D_0\).*unverified/);
  });
});
