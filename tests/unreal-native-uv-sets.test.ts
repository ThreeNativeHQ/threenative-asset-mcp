import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Document, NodeIO } from "@gltf-transform/core";
import { describe, expect, it, onTestFinished } from "vitest";

import { importUnrealDirectory } from "../src/unreal/importer.js";
import { writeFakeUmodel, writePng } from "./helpers/unreal-fixture.js";

// UE Viewer writes every UV channel a mesh carries. A lightmap or shader input in UV1..7 is authored source data even
// when no bound material samples it, so the import keeps it; only the base colour reads UV0 here.

/** Sets 0, 1, 2 and 7 (3..6 absent), with UV1 different at every vertex so a swap or a lost set is visible. */
const UV_SETS = {
  TEXCOORD_0: [0, 0, 1, 0, 0, 1],
  TEXCOORD_1: [0.125, 0.25, 0.375, 0.5, 0.625, 0.75],
  TEXCOORD_2: [0.5, 0.5, 0.25, 0.75, 0.75, 0.25],
  TEXCOORD_7: [0.9375, 0.0625, 0.5, 0.875, 0.1875, 0.4375],
} as const;
const VERTEX_COLORS = [1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1];

async function scratch(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** The UE Viewer export of one mesh: a glTF with the UV sets above, and a material sidecar that samples Albedo through UV0. */
async function writeExport(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const document = new Document();
  const buffer = document.createBuffer();
  const primitive = document
    .createPrimitive()
    .setAttribute("POSITION", document.createAccessor("POSITION").setType("VEC3").setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 2, 0])).setBuffer(buffer))
    .setAttribute("NORMAL", document.createAccessor("NORMAL").setType("VEC3").setArray(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1])).setBuffer(buffer))
    .setAttribute("COLOR_0", document.createAccessor("COLOR_0").setType("VEC4").setArray(new Float32Array(VERTEX_COLORS)).setBuffer(buffer))
    .setMaterial(document.createMaterial("Plain").setBaseColorFactor([1, 1, 1, 1]));
  for (const [semantic, values] of Object.entries(UV_SETS)) {
    primitive.setAttribute(semantic, document.createAccessor(semantic).setType("VEC2").setArray(new Float32Array(values)).setBuffer(buffer));
  }
  document.createScene().addChild(document.createNode("Mesh").setMesh(document.createMesh("Mesh").addPrimitive(primitive)));
  await new NodeIO().write(join(directory, "Mesh.gltf"), document);
  await writeFile(join(directory, "Plain.mat"), "Diffuse=Albedo");
  await writeFile(join(directory, "Plain.props.txt"), "");
  await writePng(join(directory, "Albedo.png"), [200, 120, 60, 255]);
}

async function importMesh() {
  const root = await scratch("native-uv-sets-");
  const sourceDir = join(root, "source");
  await mkdir(join(sourceDir, "Content", "Test"), { recursive: true });
  await writeFile(join(sourceDir, "Content", "Test", "Mesh.uasset"), Buffer.alloc(16));
  const exported = join(root, "exported");
  await writeExport(exported);
  const umodel = join(root, "umodel");
  await writeFakeUmodel(umodel, { exportFrom: exported, classes: { Mesh: ["StaticMesh"] } });
  const report = await importUnrealDirectory({
    sourceDir,
    outputDir: join(root, "output"),
    onlyPackages: ["Mesh"],
    concurrency: 1,
    freeSpaceBytes: 30_000_000_000,
    graphBake: false,
    environment: { ...process.env, THREENATIVE_UNREAL_CACHE_DIR: join(root, "cache"), THREENATIVE_TOOLCHAIN_DIR: join(root, "toolchain") },
    umodel: { name: "umodel", path: umodel, version: "fixture" },
  });
  const model = report.models.find((candidate) => candidate.name === "Mesh");
  if (!model) throw new Error(`no Mesh model: ${JSON.stringify(report.failed)}`);
  // Read back from the written GLB, so the assertions see what the file holds.
  const output = await new NodeIO().read(join(root, "output", model.glb));
  const primitive = output.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
  return { report, primitive, material: primitive.getMaterial()! };
}

describe("native UV sets on the UE Viewer route", () => {
  it("keeps every UV set the source carries, not only the set the base colour samples", async () => {
    const { report, primitive, material } = await importMesh();
    expect(material.getBaseColorTexture()).not.toBeNull();
    expect(material.getBaseColorTextureInfo()!.getTexCoord()).toBe(0);
    expect(primitive.listSemantics().sort()).toEqual(["COLOR_0", "NORMAL", "POSITION", "TEXCOORD_0", "TEXCOORD_1", "TEXCOORD_2", "TEXCOORD_7"]);
    for (const [semantic, values] of Object.entries(UV_SETS)) {
      expect(Array.from(primitive.getAttribute(semantic)!.getArray()!), semantic).toEqual([...values]);
    }
    expect(Array.from(primitive.getAttribute("COLOR_0")!.getArray()!)).toEqual(VERTEX_COLORS);
    expect(report.warnings.join("\n")).not.toContain("unused extra UV channels");
  });
});
