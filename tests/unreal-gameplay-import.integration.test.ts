import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Document, NodeIO } from "@gltf-transform/core";
import { describe, expect, it, onTestFinished } from "vitest";

import { importUnrealDirectory, type ImportReport } from "../src/unreal/importer.js";
import { writeFakeUmodel, writeMeshFixture } from "./helpers/unreal-fixture.js";

// PRD-582: the public import path. A UE4 package that holds a socket, a static collision, a
// PhysicsAsset or a SoundCue is routed to the CUE4Parse adapter (UE Viewer cannot decode those
// classes), and the adapter's Gameplay/*.json and Audio/*.cue.json become socket nodes, collision and
// physics sidecars, and a cue graph, all reachable through importUnrealDirectory.

const PACKAGE_MAGIC = 0x9e2a83c1;

/** A UE4 package head (legacy -7, UE 4.26) whose name table carries the classes a class sniff looks for. */
function ue4Package(names: readonly string[]): Buffer {
  const header = Buffer.alloc(24);
  header.writeUInt32LE(PACKAGE_MAGIC, 0);
  header.writeInt32LE(-7, 4);
  header.writeInt32LE(864, 8);
  header.writeInt32LE(522, 12);
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

/** A UE5 package head (legacy -8) whose name table carries the classes a class sniff looks for.
 * UE Viewer cannot list a UE5 package, so only this head names the class. */
function ue5Package(names: readonly string[]): Buffer {
  const header = Buffer.alloc(24);
  header.writeUInt32LE(PACKAGE_MAGIC, 0);
  header.writeInt32LE(-8, 4);
  header.writeInt32LE(864, 8);
  header.writeInt32LE(522, 12);
  header.writeInt32LE(1012, 16);
  header.writeInt32LE(names.length, 20);
  const table = names.map((name) => {
    const bytes = Buffer.from(`${name}\0`, "latin1");
    const length = Buffer.alloc(4);
    length.writeInt32LE(bytes.length, 0);
    return Buffer.concat([length, bytes]);
  });
  return Buffer.concat([header, ...table]);
}

/** A skinned GLB whose mesh node is named after the package and whose only joint is `hand_r`. */
async function skinnedGlb(path: string): Promise<void> {
  const document = new Document();
  const buffer = document.createBuffer();
  const position = document.createAccessor("POSITION").setType("VEC3").setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buffer);
  const joints = document.createAccessor("JOINTS_0").setType("VEC4").setArray(new Uint16Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).setBuffer(buffer);
  const weights = document.createAccessor("WEIGHTS_0").setType("VEC4").setArray(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])).setBuffer(buffer);
  const joint = document.createNode("hand_r");
  const skin = document.createSkin("skin").addJoint(joint);
  const primitive = document
    .createPrimitive()
    .setAttribute("POSITION", position)
    .setAttribute("JOINTS_0", joints)
    .setAttribute("WEIGHTS_0", weights)
    .setMaterial(document.createMaterial("M_Plain"));
  const meshNode = document.createNode("SK_Hero").setMesh(document.createMesh("SK_Hero").addPrimitive(primitive)).setSkin(skin);
  document.createScene().addChild(meshNode);
  await mkdir(dirname(path), { recursive: true });
  await new NodeIO().write(path, document);
}

/** The stand-in modern converter: writes the files a `--filter` run names, or the unfiltered set. */
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

interface Fixture {
  readonly report: ImportReport;
  readonly outputDir: string;
}

async function runImport(
  packages: Record<string, readonly string[]>,
  outputs: (root: string) => Record<string, Record<string, string>>,
  umodelExportFrom?: string,
  extras?: { readonly ue5?: readonly string[]; readonly listExitCode?: number },
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "asset-mcp-gameplay-import-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const sourceDir = join(root, "source");
  const ue5 = new Set(extras?.ue5 ?? []);
  const classes: Record<string, string[]> = {};
  for (const [relative, names] of Object.entries(packages)) {
    await mkdir(dirname(join(sourceDir, "Content", relative)), { recursive: true });
    await writeFile(join(sourceDir, "Content", `${relative}.uasset`), ue5.has(relative) ? ue5Package(names) : ue4Package(names));
    // UE Viewer cannot list a UE5 package: report no rows for it, so only the name-table sniff can name it.
    classes[relative.split("/").pop()!] = ue5.has(relative) ? [] : [...names];
  }
  const umodel = join(root, "umodel");
  await writeFakeUmodel(umodel, {
    classes,
    ...(extras?.listExitCode === undefined ? {} : { listExitCode: extras.listExitCode }),
    ...(umodelExportFrom === undefined ? {} : { exportFrom: umodelExportFrom }),
  });
  const converter = join(root, "converter");
  await fakeConverter(converter, outputs(root));
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

describe("gameplay data through the public import path", () => {
  it("routes a UE4 socket/collision package to the adapter and attaches its data to the GLB", async () => {
    const glb = await mkdtemp(join(tmpdir(), "asset-mcp-skg-"));
    onTestFinished(() => rm(glb, { recursive: true, force: true }));
    const glbPath = join(glb, "SK_Hero.glb");
    await skinnedGlb(glbPath);
    const { report, outputDir } = await runImport(
      { "Chars/SK_Hero": ["SkeletalMesh", "SkeletalMeshSocket", "Skeleton"] },
      () => ({
        "": {
          "Meshes/SK_Hero.glb": glbPath,
          "Gameplay/Content/Chars/SK_Hero.json": `text:${JSON.stringify({
            version: 1,
            package: "Content/Chars/SK_Hero",
            skeletalSockets: [
              { name: "Muzzle", bone: "hand_r", source: "skeleton", location: [10, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
              { name: "Muzzle", bone: "hand_r", source: "mesh", location: [100, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
            ],
            collision: { traceFlag: "CTF_SimpleAndComplex", shapes: [{ type: "sphere", center: [0, 0, 0], radius: 50 }] },
          })}`,
        },
      }),
    );
    const model = report.models.find((candidate) => candidate.name === "SK_Hero");
    expect(model, `failed: ${JSON.stringify(report.failed)}`).toBeDefined();
    expect(model!.sockets).toEqual(["Muzzle"]);
    expect(model!.collision?.shapes[0]).toMatchObject({ type: "sphere", radius: 0.5 });
    // The mesh socket won the clash through the real attach path.
    const document = await new NodeIO().read(join(outputDir, model!.glb));
    const socket = document.getRoot().listNodes().find((node) => node.getName() === "socket:Muzzle");
    expect(socket?.getExtras().unrealSocket).toMatchObject({ source: "mesh" });
    // The collision sidecar is metre-scale and promoted beside the mesh.
    const collision = JSON.parse(await readFile(join(outputDir, `Collision/Content/Chars/SK_Hero.json`), "utf8")) as { shapes: { radius: number }[] };
    expect(collision.shapes[0]!.radius).toBeCloseTo(0.5, 6);
  });

  it("keeps a UE4 StaticMesh BodySetup package on the UE Viewer route and still attaches metre collision", async () => {
    const exported = await mkdtemp(join(tmpdir(), "asset-mcp-static-export-"));
    onTestFinished(() => rm(exported, { recursive: true, force: true }));
    await writeMeshFixture(exported, { name: "SM_Crate", materialName: "M_Crate", mat: "", props: "", textures: [] });
    const { report, outputDir } = await runImport(
      // No socket or gameplay class: only BodySetup, which UE Viewer cannot decode. The package must still
      // route to CUE4Parse for its metadata, but its render geometry must stay on the UE Viewer route.
      { "Props/SM_Crate": ["StaticMesh", "BodySetup"] },
      () => ({
        "": {
          "Gameplay/Content/Props/SM_Crate.json": `text:${JSON.stringify({
            version: 1,
            package: "Content/Props/SM_Crate",
            collision: { traceFlag: "CTF_SimpleAndComplex", shapes: [{ type: "box", center: [0, 0, 0], rotation: [0, 0, 0], x: 100, y: 50, z: 25 }] },
          })}`,
        },
      }),
      exported,
    );
    const model = report.models.find((candidate) => candidate.name === "SM_Crate");
    expect(model, `failed: ${JSON.stringify(report.failed)}`).toBeDefined();
    // Metre collision landed on the mesh and in a sidecar.
    expect(model!.collision?.shapes[0]).toMatchObject({ type: "box", size: [1, 0.25, 0.5] });
    const collision = JSON.parse(await readFile(join(outputDir, "Collision/Content/Props/SM_Crate.json"), "utf8")) as { shapes: { size: number[] }[] };
    expect(collision.shapes[0]!.size).toEqual([1, 0.25, 0.5]);
    const document = await new NodeIO().read(join(outputDir, model!.glb));
    const meshNode = document.getRoot().listNodes().find((node) => node.getMesh() !== null)!;
    expect(meshNode.getExtras().unrealCollision).toMatchObject({ shapes: [{ type: "box" }] });
  });

  it("resolves a SkeletalMesh PhysicsAsset reference when the package names no socket class", async () => {
    const exported = await mkdtemp(join(tmpdir(), "asset-mcp-sk-export-"));
    onTestFinished(() => rm(exported, { recursive: true, force: true }));
    await skinnedGlb(join(exported, "SK_Hero.gltf"));
    const { report, outputDir } = await runImport(
      // A UE4 SkeletalMesh whose only gameplay signal is an out-of-package PhysicsAsset/Skeleton reference.
      // UE Viewer still supplies its geometry; CUE4Parse supplies the metadata the reference names.
      {
        "Chars/SK_Hero": ["SkeletalMesh", "Skeleton"],
        "Chars/PA_Hero": ["PhysicsAsset"],
      },
      () => ({
        "": {
          "Gameplay/Content/Chars/SK_Hero.json": `text:${JSON.stringify({
            version: 1,
            package: "Content/Chars/SK_Hero",
            physicsAssetRef: "PA_Hero",
          })}`,
          "Gameplay/Content/Chars/PA_Hero.json": `text:${JSON.stringify({
            version: 1,
            package: "Content/Chars/PA_Hero",
            physics: {
              asset: "PA_Hero",
              bodies: [{ bone: "hand_r", shapes: [{ type: "sphere", center: [100, 0, 0], radius: 10 }] }],
              constraints: [],
              collisionDisabledPairs: [],
            },
          })}`,
        },
      }),
      exported,
    );
    const model = report.models.find((candidate) => candidate.name === "SK_Hero");
    expect(model, `failed: ${JSON.stringify(report.failed)}`).toBeDefined();
    expect(model!.physics).toMatchObject({ asset: "PA_Hero", bodies: 1, constraints: 0, missingBones: [] });
    const document = await new NodeIO().read(join(outputDir, model!.glb));
    const meshNode = document.getRoot().listNodes().find((node) => node.getMesh() !== null)!;
    expect(meshNode.getExtras().unrealPhysicsAsset).toBe("PA_Hero");
    expect(report.counts.physicsAssets).toBe(1);
  });

  it("promotes a PhysicsAsset package, references it from the mesh, and reports a bone the mesh lacks", async () => {
    const glb = await mkdtemp(join(tmpdir(), "asset-mcp-skg-"));
    onTestFinished(() => rm(glb, { recursive: true, force: true }));
    const glbPath = join(glb, "SK_Hero.glb");
    await skinnedGlb(glbPath);
    const { report, outputDir } = await runImport(
      {
        // The mesh package names a socket class, so it routes to the adapter for geometry; its physics
        // asset is a separate package. (A mesh whose only gameplay signal is a cross-package reference
        // has its own regression above: geometry stays on UE Viewer, metadata goes to the adapter.)
        "Chars/SK_Hero": ["SkeletalMesh", "Skeleton", "SkeletalMeshSocket"],
        "Chars/PA_Hero": ["PhysicsAsset"],
      },
      () => ({
        "": {
          "Meshes/SK_Hero.glb": glbPath,
          "Gameplay/Content/Chars/SK_Hero.json": `text:${JSON.stringify({
            version: 1,
            package: "Content/Chars/SK_Hero",
            physicsAssetRef: "PA_Hero",
          })}`,
          "Gameplay/Content/Chars/PA_Hero.json": `text:${JSON.stringify({
            version: 1,
            package: "Content/Chars/PA_Hero",
            physics: {
              asset: "PA_Hero",
              bodies: [
                { bone: "hand_r", physicsType: "PhysType_Simulated", shapes: [{ type: "sphere", center: [100, 0, 0], radius: 10 }] },
                { bone: "cloth_bone", shapes: [] },
              ],
              constraints: [
                {
                  child: "hand_r",
                  parent: "lowerarm_r",
                  childFrame: { location: [0, 0, 0], primaryAxis: [1, 0, 0], secondaryAxis: [0, 1, 0] },
                  parentFrame: { location: [0, 0, 0], primaryAxis: [1, 0, 0], secondaryAxis: [0, 1, 0] },
                  linearLimit: 50,
                  drives: { linear: { positionTarget: [0, 0, 0], x: { stiffness: 12, positionDrive: true } } },
                },
              ],
              collisionDisabledPairs: [],
            },
          })}`,
        },
      }),
    );
    const model = report.models.find((candidate) => candidate.name === "SK_Hero");
    expect(model, `failed: ${JSON.stringify(report.failed)}`).toBeDefined();
    expect(model!.physics).toMatchObject({ asset: "PA_Hero", bodies: 2, constraints: 1, missingBones: ["cloth_bone"] });
    const physics = JSON.parse(await readFile(join(outputDir, "Physics/Content/Chars/PA_Hero.json"), "utf8")) as {
      constraints: { linearLimit: number; drives: { linear: { x: { stiffness: number } } } }[];
    };
    expect(physics.constraints[0]!.linearLimit).toBeCloseTo(0.5, 6);
    expect(physics.constraints[0]!.drives.linear.x.stiffness).toBe(12);
    expect(report.counts.physicsAssets).toBe(1);
    expect(report.warnings.some((warning) => warning.includes("cloth_bone"))).toBe(true);
  });

  it("promotes a SoundCue graph and reports a wave no exported SoundWave matched", async () => {
    const { report, outputDir } = await runImport(
      { "Audio/SC_Footstep": ["SoundCue"] },
      () => ({
        "": {
          "Audio/SC_Footstep.cue.json": `text:${JSON.stringify({
            name: "SC_Footstep",
            volume: 1,
            pitch: 1,
            root: { type: "USoundNodeRandom", children: [{ type: "USoundNodeWavePlayer", params: { wave: "/Game/Audio/SW_Footstep.SW_Footstep" } }] },
          })}`,
        },
      }),
    );
    expect(report.counts.soundCues).toBe(1);
    const cue = report.soundCues[0]!;
    expect(cue.name).toBe("SC_Footstep");
    expect(cue.missingWaves).toEqual(["SW_Footstep"]);
    const promoted = JSON.parse(await readFile(join(outputDir, cue.file), "utf8")) as { root: { children: { params: Record<string, unknown> }[] } };
    expect(promoted.root.children[0]!.params.wave).toBe("/Game/Audio/SW_Footstep.SW_Footstep");
    expect(promoted.root.children[0]!.params.waveExport).toBeUndefined();
    expect(report.warnings.some((warning) => warning.includes("SW_Footstep"))).toBe(true);
    // A SoundCue-only package has no Gameplay sidecar; it must not be listed as skipped.
    expect(report.skipped.some((entry) => entry.package.includes("SC_Footstep"))).toBe(false);
  });

  it("promotes a UE5 PhysicsAsset sidecar when UE Viewer cannot list the package", async () => {
    const { report, outputDir } = await runImport(
      // A UE5 PhysicsAsset package: UE Viewer cannot list it (exit 1), and its class is only in the
      // name table. Without the shared class sniff it reads as a failed package and its decoded sidecar
      // is dropped; the public import must promote Physics/<package>.json and not report a listing failure.
      { "Chars/PA_Hero": ["PhysicsAsset", "SkeletalBodySetup"] },
      () => ({
        "": {
          "Gameplay/Content/Chars/PA_Hero.json": `text:${JSON.stringify({
            version: 1,
            package: "Content/Chars/PA_Hero",
            physics: {
              asset: "PA_Hero",
              bodies: [{ bone: "hand_r", shapes: [{ type: "sphere", center: [100, 0, 0], radius: 10 }] }],
              constraints: [],
              collisionDisabledPairs: [],
            },
          })}`,
        },
      }),
      undefined,
      { ue5: ["Chars/PA_Hero"], listExitCode: 1 },
    );
    expect(report.counts.physicsAssets).toBe(1);
    const promoted = JSON.parse(await readFile(join(outputDir, "Physics/Content/Chars/PA_Hero.json"), "utf8")) as { bodies: { bone: string; shapes: { radius: number }[] }[] };
    expect(promoted.bodies[0]!.bone).toBe("hand_r");
    expect(promoted.bodies[0]!.shapes[0]!.radius).toBeCloseTo(0.1, 6);
    expect(report.failed.some((entry) => entry.package.includes("PA_Hero"))).toBe(false);
  });
});
