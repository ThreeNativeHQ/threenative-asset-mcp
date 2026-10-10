import { chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeIO } from "@gltf-transform/core";
import { expect, it, onTestFinished } from "vitest";

import { materialGraphSchema, type MaterialGraph } from "../src/unreal/graph-dump.js";
import { importUnrealDirectory } from "../src/unreal/importer.js";
import { writeMeshFixture, writePng } from "./helpers/unreal-fixture.js";

const INSTANCE = "MI_Rock_Inst";
const PARENT = "M_Master";

const encode = (unit: number): number => {
  const value = Math.min(1, Math.max(0, unit));
  return Math.round((value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055) * 255);
};

/** BaseColor = Constant3(0.2, 0.4, 0.6): colour that lives only in the master graph, no texture to export. */
function masterGraph(): MaterialGraph {
  return materialGraphSchema.parse({
    format: 1,
    material: PARENT,
    package: `/Game/Test/${PARENT}`,
    truncated: false,
    nodeCount: 1,
    outputs: {
      baseColor: { node: "tint", output: 0, mask: null },
      roughness: null,
      metallic: null,
      emissive: null,
      opacity: null,
      opacityMask: null,
      normal: null,
      materialAttributes: null,
    },
    nodes: [{ id: "tint", class: "Constant3Vector", inputs: {}, constants: { Constant: [0.2, 0.4, 0.6, 1] } }],
  });
}

/**
 * A UE Viewer stand-in: the mesh export copies `meshDir`; a material-only export writes only an UNRELATED
 * sidecar, never one named after the material, exactly as UE Viewer exits 0 with nothing for an instance
 * whose parameters it cannot read. The unrelated file keeps the export index non-empty so the bug (an empty
 * index being accepted just because it is truthy) is exercised rather than a null check.
 */
async function writeFakeUmodel(path: string, meshDir: string, classes: Record<string, readonly string[]>): Promise<void> {
  const script = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const { basename, join } = require("node:path");
const argv = process.argv.slice(2);
const classes = ${JSON.stringify(classes)};
if (argv.includes("-version")) { process.stdout.write("UE Viewer (UModel)\\nCompiled fixture\\n"); process.exit(0); }
const selector = argv.filter((entry) => !entry.startsWith("-")).pop();
const target = basename(selector || "").replace(/\\.(uasset|umap)$/i, "");
if (argv.includes("-list")) {
  process.stdout.write("Found 1 game files (0 skipped) in 1 folders\\n");
  (classes[target] || []).forEach((className, index) => process.stdout.write("   " + index + "    1000       10 " + className + " " + target + "\\n"));
  process.exit(0);
}
if (argv.includes("-export")) {
  const out = argv.find((entry) => entry.indexOf("-out=") === 0).slice(5);
  fs.mkdirSync(out, { recursive: true });
  if (target === "Mesh") fs.cpSync(${JSON.stringify(meshDir)}, out, { recursive: true });
  else { fs.writeFileSync(join(out, "Other.mat"), "Diffuse=None\\n"); fs.writeFileSync(join(out, "Other.props.txt"), ""); }
  process.exit(0);
}
process.exit(0);
`;
  await writeFile(path, script);
  await chmod(path, 0o755);
}

/** The modern converter: dumps the master graph and, for a material export, writes the instance's `Parent`. */
async function writeFakeModernConverter(path: string, graph: MaterialGraph, argvLog: string): Promise<void> {
  const script = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const { basename, join } = require("node:path");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(argv) + "\\n");
if (argv.includes("--version")) { process.stdout.write("fake-converter 1\\n"); process.exit(0); }
const dumpAt = argv.indexOf("--dump-graphs");
if (dumpAt >= 0) {
  fs.mkdirSync(argv[dumpAt + 1], { recursive: true });
  fs.writeFileSync(join(argv[dumpAt + 1], ${JSON.stringify(`${graph.material}.graph.json`)}), ${JSON.stringify(JSON.stringify(graph))});
  process.exit(0);
}
const exportAt = argv.indexOf("--export-dir");
const filterAt = argv.indexOf("--filter");
if (exportAt >= 0 && filterAt >= 0) {
  const name = basename(argv[filterAt + 1]);
  fs.mkdirSync(join(argv[exportAt + 1], "Materials"), { recursive: true });
  const props = name === ${JSON.stringify(INSTANCE)} ? "Parent = Material'/Game/Test/${PARENT}.${PARENT}'\\n" : "";
  fs.writeFileSync(join(argv[exportAt + 1], "Materials", name + ".props.txt"), props);
  process.exit(0);
}
process.exit(0);
`;
  await writeFile(path, script);
  await chmod(path, 0o755);
}

async function readConverterCalls(path: string): Promise<unknown[][]> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown[]);
}

const materialExportFor = (calls: unknown[][], name: string): unknown[] | undefined =>
  calls.find(
    (args) => args.includes("--export-dir") && args.includes("--filter") &&
      String(args[args.indexOf("--filter") + 1]).includes(name),
  );

function writeSource(content: string): Promise<void> {
  return Promise.all([
    writeFile(join(content, "Mesh.uasset"), Buffer.alloc(16)),
    writeFile(join(content, `${INSTANCE}.uasset`), Buffer.alloc(16)),
    writeFile(join(content, `${PARENT}.uasset`), Buffer.alloc(16)),
  ]).then(() => undefined);
}

const CLASSES = { Mesh: ["StaticMesh"], [INSTANCE]: ["MaterialInstanceConstant"], [PARENT]: ["Material"] } as const;

/**
 * A legacy UE4 package whose MaterialInstanceConstant has no recognised parameters: UE Viewer exits 0 with
 * "Ignoring MaterialInstanceConstant due to empty parameters" and writes no metadata for it. The export
 * directory still holds an unrelated material's sidecar, so the empty result is truthy. The importer must
 * require the instance's OWN basename and delegate to the modern converter, which supplies the `Parent` line.
 */
it("falls back to the modern converter for an empty UE Viewer material export and bakes the parent graph", async () => {
  const root = await mkdtemp(join(tmpdir(), "empty-material-fallback-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const sourceDir = join(root, "source");
  const content = join(sourceDir, "Content", "Test");
  const meshDir = join(root, "mesh-export");
  const outputDir = join(root, "output");
  await mkdir(content, { recursive: true });
  await writeSource(content);
  await writeMeshFixture(meshDir, { name: "Mesh", materialName: INSTANCE, mat: "", props: "", textures: [] });
  // The mesh carries the instance by name, but UE Viewer wrote no sidecar for it.
  await unlink(join(meshDir, `${INSTANCE}.mat`));
  await unlink(join(meshDir, `${INSTANCE}.props.txt`));

  const umodel = join(root, "umodel");
  await writeFakeUmodel(umodel, meshDir, CLASSES);
  const converter = join(root, "converter");
  const converterLog = join(root, "converter.log");
  await writeFakeModernConverter(converter, masterGraph(), converterLog);

  const report = await importUnrealDirectory({
    sourceDir,
    outputDir,
    concurrency: 1,
    freeSpaceBytes: 30_000_000_000,
    umodel: { name: "umodel", path: umodel, version: "fixture" },
    modernConverter: { name: "modern", path: converter, version: "fake-converter 1" },
  });

  const calls = await readConverterCalls(converterLog);
  expect(materialExportFor(calls, INSTANCE)).toBeDefined();

  expect(report.models).toHaveLength(1);
  const section = report.models[0]!.materials[0]!;
  expect(section.graph).toMatchObject({ status: "baked" });
  expect(section.bindings).toContainEqual(
    expect.objectContaining({ slot: "baseColor", source: "graph", confidence: "exact" }),
  );

  const glb = await new NodeIO().read(join(outputDir, report.models[0]!.glb));
  const material = glb.getRoot().listMaterials()[0]!;
  expect(material.getBaseColorTexture()).not.toBeNull();
  expect(material.getBaseColorFactor().slice(0, 3)).not.toEqual([0.8, 0.8, 0.8]);
  const { data } = await (await import("sharp"))
    .default(material.getBaseColorTexture()!.getImage()!)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  expect([...data.subarray(0, 3)]).toEqual([encode(0.2), encode(0.4), encode(0.6)]);
});

it("keeps a material whose own sidecar UE Viewer did export, without a modern fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "own-metadata-material-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const sourceDir = join(root, "source");
  const content = join(sourceDir, "Content", "Test");
  const meshDir = join(root, "mesh-export");
  const outputDir = join(root, "output");
  await mkdir(content, { recursive: true });
  await writeSource(content);
  await writeMeshFixture(meshDir, { name: "Mesh", materialName: INSTANCE, mat: "Diffuse=T_Own", props: "", textures: ["T_Own"] });
  await writePng(join(meshDir, "T_Own.png"), [40, 80, 120, 255]);

  const umodel = join(root, "umodel");
  await writeFakeUmodel(umodel, meshDir, CLASSES);
  const converter = join(root, "converter");
  const converterLog = join(root, "converter.log");
  await writeFakeModernConverter(converter, masterGraph(), converterLog);

  const report = await importUnrealDirectory({
    sourceDir,
    outputDir,
    concurrency: 1,
    freeSpaceBytes: 30_000_000_000,
    umodel: { name: "umodel", path: umodel, version: "fixture" },
    modernConverter: { name: "modern", path: converter, version: "fake-converter 1" },
  });

  const calls = await readConverterCalls(converterLog);
  expect(materialExportFor(calls, INSTANCE)).toBeUndefined();
  expect(report.models).toHaveLength(1);
  const section = report.models[0]!.materials[0]!;
  expect(section.textured).toBe(true);
  expect(section.bindings).toContainEqual(
    expect.objectContaining({ slot: "baseColor", source: expect.not.stringMatching("graph") }),
  );
});
