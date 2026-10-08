import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Document, NodeIO } from "@gltf-transform/core";
import { describe, expect, it, onTestFinished } from "vitest";

import { CUE4PARSE_PATCH, CUE4PARSE_PROGRAM, CUE4PARSE_SOURCE } from "../src/unreal/cue4parse-adapter.js";
import { importUnrealDirectory, parseModernMeshFailures } from "../src/unreal/importer.js";
import { writeFakeUmodel, writeMeshFixture } from "./helpers/unreal-fixture.js";

/**
 * A UE4 editor SkeletalMesh that the modern converter cannot read used to vanish: the converter
 * exits zero when it wrote any other package, the importer saw no GLB and said only "produced no
 * GLB". These tests pin the recovery through UE Viewer and the explained error when both fail.
 */

async function scratch(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** A package head: the magic, the legacy version, the UE4 object version, then the name table. */
function packageHead(names: readonly string[], legacy: number, ue4 = 517): Buffer {
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

/** An uncooked UE4.22-era SkeletalMesh: editor-only names, legacy -7, object version 517. */
const UE4_SKELETAL = ["/Script/Engine", "/Script/UnrealEd", "AssetImportData", "SkeletalMesh", "SourceModels"];
/** A UE5 editor SkeletalMesh, which UE Viewer cannot list at all. */
const UE5_SKELETAL = ["AssetImportData", "SkeletalMesh", "SkeletalMeshEditorData", "MeshEditorDataObject"];

const CAUSE = "SkeletalMesh ParserException: Invalid bool value (6203); the exporter failed (Mesh has no LOD data)";

interface ModernBehaviour {
  readonly exitCode?: number;
  /** Meshes the converter writes a GLB for. */
  readonly writes: readonly string[];
  /** Meshes it reports as failed, `name` -> cause. */
  readonly failures: Readonly<Record<string, string>>;
}

async function writeGlb(path: string, name: string): Promise<void> {
  const document = new Document();
  const buffer = document.createBuffer();
  const position = document.createAccessor("POSITION").setType("VEC3").setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 2, 0])).setBuffer(buffer);
  const normal = document.createAccessor("NORMAL").setType("VEC3").setArray(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1])).setBuffer(buffer);
  const material = document.createMaterial("MI_Skin");
  const primitive = document.createPrimitive().setAttribute("POSITION", position).setAttribute("NORMAL", normal).setMaterial(material);
  const mesh = document.createMesh(name).addPrimitive(primitive);
  document.createScene().addChild(document.createNode(name).setMesh(mesh));
  await new NodeIO().write(path, document);
}

async function writeFakeModernConverter(path: string, glb: string, argvLog: string, behaviour: ModernBehaviour): Promise<void> {
  await writeFile(
    path,
    `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const { join } = require("node:path");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(argv) + "\\n");
if (argv.includes("--version")) { process.stdout.write("fake-modern 1\\n"); process.exit(0); }
const behaviour = ${JSON.stringify(behaviour)};
const out = argv[argv.indexOf("--export-dir") + 1];
fs.mkdirSync(join(out, "Meshes"), { recursive: true });
for (const name of behaviour.writes) fs.copyFileSync(${JSON.stringify(glb)}, join(out, "Meshes", name + ".glb"));
for (const [name, cause] of Object.entries(behaviour.failures)) process.stderr.write("threenative-mesh-failure\\t" + name + "\\t" + cause + "\\n");
process.exit(behaviour.exitCode || 0);
`,
  );
  await chmod(path, 0o755);
}

async function run(options: {
  readonly packages: readonly { readonly name: string; readonly names: readonly string[]; readonly legacy: number }[];
  readonly modern: ModernBehaviour;
  /** Packages UE Viewer lists but exports nothing for. */
  readonly umodelEmpty?: readonly string[];
  readonly umodelListExitCode?: number;
}) {
  const root = await scratch("skeletal-recovery-");
  const sourceDir = join(root, "source");
  const content = join(sourceDir, "Content", "Test");
  const outputDir = join(root, "output");
  await mkdir(content, { recursive: true });
  const classes: Record<string, string[]> = {};
  for (const pack of options.packages) {
    await writeFile(join(content, `${pack.name}.uasset`), packageHead(pack.names, pack.legacy));
    classes[pack.name] = ["SkeletalMesh"];
  }
  const exported = join(root, "exported");
  await writeMeshFixture(exported, { name: "SK_Bad", materialName: "MI_Skin", mat: "", props: "", textures: [] });
  const umodelLog = join(root, "umodel.log");
  const modernLog = join(root, "modern.log");
  const umodel = join(root, "umodel");
  await writeFakeUmodel(umodel, {
    exportFrom: exported,
    classes,
    argvLog: umodelLog,
    emptyExports: options.umodelEmpty ?? [],
    ...(options.umodelListExitCode ? { listExitCode: options.umodelListExitCode } : {}),
  });
  const glb = join(root, "Mesh.glb");
  await writeGlb(glb, "SK_Good");
  const modern = join(root, "modern-converter");
  await writeFakeModernConverter(modern, glb, modernLog, options.modern);
  const attempt = importUnrealDirectory({
    sourceDir,
    outputDir,
    concurrency: 1,
    freeSpaceBytes: 30_000_000_000,
    graphBake: false,
    environment: { ...process.env, THREENATIVE_UNREAL_CACHE_DIR: join(root, "cache"), THREENATIVE_TOOLCHAIN_DIR: join(root, "toolchain") },
    umodel: { name: "umodel", path: umodel, version: "fixture" },
    modernConverter: { name: "modern", path: modern, version: "fake-modern 1" },
  });
  const lines = async (path: string) =>
    (await readFile(path, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
  return { attempt, umodelCalls: () => lines(umodelLog) };
}

describe("a UE4 SkeletalMesh the modern converter wrote no GLB for", () => {
  it("is decoded by UE Viewer when the converter exited zero having written another package", async () => {
    const { attempt, umodelCalls } = await run({
      packages: [
        { name: "SK_Good", names: UE4_SKELETAL, legacy: -7 },
        { name: "SK_Bad", names: UE4_SKELETAL, legacy: -7 },
      ],
      modern: { writes: ["SK_Good"], failures: { SK_Bad: CAUSE } },
    });
    const report = await attempt;
    expect(report.failed).toEqual([]);
    expect(report.models.map((model) => model.name).sort()).toEqual(["SK_Bad", "SK_Good"]);
    expect(report.warnings.join("\n")).toMatch(/wrote no GLB for 1 mesh package; UE Viewer decoded it instead/);
    const exports = (await umodelCalls()).filter((argv) => argv.includes("-export"));
    expect(exports).toHaveLength(1);
    expect(exports[0]!.join(" ")).toContain("SK_Bad");
  });

  it("is decoded by UE Viewer when the converter exited non-zero", async () => {
    const { attempt } = await run({
      packages: [{ name: "SK_Bad", names: UE4_SKELETAL, legacy: -7 }],
      modern: { exitCode: 1, writes: [], failures: {} },
    });
    const report = await attempt;
    expect(report.failed).toEqual([]);
    expect(report.models.map((model) => model.name)).toEqual(["SK_Bad"]);
    expect(report.warnings.join("\n")).toMatch(/exited 1; UE Viewer decoded 1 mesh package it could read itself/);
  });

  it("reports the converter's own cause and UE Viewer's outcome when neither can read it", async () => {
    const { attempt } = await run({
      packages: [
        { name: "SK_Good", names: UE4_SKELETAL, legacy: -7 },
        { name: "SK_Bad", names: UE4_SKELETAL, legacy: -7 },
      ],
      modern: { writes: ["SK_Good"], failures: { SK_Bad: CAUSE } },
      umodelEmpty: ["SK_Bad"],
    });
    const report = await attempt;
    expect(report.models.map((model) => model.name)).toEqual(["SK_Good"]);
    const failure = report.failed.find((entry) => entry.package.includes("SK_Bad"));
    expect(failure?.reason).toContain("The modern UE5 mesh converter produced no GLB for this package");
    expect(failure?.reason).toContain("Invalid bool value (6203)");
    expect(failure?.reason).toContain("UE Viewer retry: it wrote no glTF");
    expect(failure?.reason).not.toBe("The modern UE5 mesh converter produced no GLB for this package.");
  });

  it("never asks UE Viewer to read a UE5 package, and still names the converter's cause", async () => {
    const { attempt, umodelCalls } = await run({
      packages: [{ name: "SK_Bad", names: UE5_SKELETAL, legacy: -8 }],
      modern: { writes: [], failures: { SK_Bad: CAUSE } },
      umodelListExitCode: 1,
    });
    // With nothing else to import the whole run fails, and the error carries the cause.
    const error = await attempt.then(() => undefined, (reason: unknown) => reason);
    expect(error).toMatchObject({ code: "UNREAL_EXPORT_EMPTY" });
    expect((error as Error).message).toContain("Invalid bool value (6203)");
    expect((error as Error).message).not.toContain("UE Viewer retry");
    expect((await umodelCalls()).some((argv) => argv.includes("-export"))).toBe(false);
  });
});

describe("parseModernMeshFailures", () => {
  it("keeps the first cause per mesh and ignores unrelated output", () => {
    const stderr = [
      "warning: something unrelated",
      "threenative-mesh-failure\tSK_A\tfirst cause",
      "threenative-mesh-failure\tSK_A\tsecond cause",
      "threenative-mesh-failure\tSM_B\tthe exporter wrote no glTF for this static mesh",
      "threenative-mesh-failure\tbroken line with no cause",
    ].join("\n");
    expect([...parseModernMeshFailures(stderr)]).toEqual([
      ["SK_A", "first cause"],
      ["SM_B", "the exporter wrote no glTF for this static mesh"],
    ]);
  });
});

describe("the pinned CUE4Parse build for uncooked UE4 SkeletalMesh packages", () => {
  it("skips FRawSkeletalMeshBulkData after RawPointIndices in a UE4.19-4.24 editor model", () => {
    // Root cause of SK_Stickman exporting nothing: its LOD model stores the imported source as a
    // bulk-data header, a GUID and bGuidIsHash right after RawPointIndices. Unread, the following
    // arrays were misaligned, the model threw and LODModels stayed null.
    expect(CUE4PARSE_PATCH).toContain("+            else if (skelMeshVer >= FSkeletalMeshCustomVersion.Type.SplitModelAndRenderData)");
    expect(CUE4PARSE_PATCH).toContain("+                _ = new FByteBulkData(Ar);\n+                Ar.Position += 16;\n+                _ = Ar.ReadBoolean();");
  });

  it("re-reads a SkeletalMesh with no LODs under older UE4 profiles before giving up", () => {
    // The run's profile (UE4.27 for a loose legacy -7 pack) gives a package that predates it a
    // wider soft-vertex layout; only an older profile reads such a file.
    expect(CUE4PARSE_PROGRAM).toContain("ReloadSkeletalMeshWithOlderEngine(key, mesh.Name)");
    expect(CUE4PARSE_PROGRAM).toContain("new[] { EGame.GAME_UE4_24, EGame.GAME_UE4_22, EGame.GAME_UE4_20 }");
    expect(CUE4PARSE_PROGRAM).toContain("mesh.LODModels is { Length: > 0 }");
  });

  it("names the cause of every mesh it could not write on stderr", () => {
    expect(CUE4PARSE_PROGRAM).toContain("threenative-mesh-failure\\t{failedMesh}\\t{failureDetail}");
    expect(CUE4PARSE_PROGRAM).toContain("CUE4Parse.CUE4ParseLog.UseLogger");
    expect(CUE4PARSE_PROGRAM).toContain('"^Could not read');
  });

  it("is a new tool version, so a cached converter without the fix is rebuilt", () => {
    expect(CUE4PARSE_SOURCE.version).not.toBe("b4e95441+threenative.55");
  });
});
