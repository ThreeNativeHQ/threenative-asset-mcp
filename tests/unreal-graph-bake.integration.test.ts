import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeIO } from "@gltf-transform/core";
import sharp from "sharp";
import { describe, expect, it, onTestFinished } from "vitest";

import { createGraphBaker } from "../src/unreal/graph-baker.js";
import { materialGraphSchema, type MaterialGraph } from "../src/unreal/graph-dump.js";
import { importUnrealDirectory, type ImportReport } from "../src/unreal/importer.js";
import { writeFakeUmodel, writeMeshFixture, writePng } from "./helpers/unreal-fixture.js";

async function scratch(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// ---------------------------------------------------------------------------------------------------------
// A hand-written master graph: BaseColor = Mask.RGB x Constant3(0.5, 0.25, 1), Mask being a TextureSampleParameter2D.

type Raw = Record<string, unknown>;
const pin = (node: string, mask: number[] | null = null) => ({ node, output: 0, mask });
const node = (id: string, cls: string, extra: Raw = {}): Raw => ({ id, class: cls, inputs: {}, constants: {}, ...extra });

function masterGraph(kind: "mask-tint" | "vertex-color" = "mask-tint"): MaterialGraph {
  const nodes: Raw[] =
    kind === "mask-tint"
      ? [
          node("mask", "TextureSampleParameter2D", {
            parameter: { name: "Mask", group: "" },
            default: null,
            texture: "/Game/Test/T_MasterMask.T_MasterMask",
            samplerType: "Masks",
          }),
          node("tint", "Constant3Vector", { constants: { Constant: [0.5, 0.25, 1, 1] } }),
          node("mul", "Multiply", { inputs: { A: pin("mask", [1, 1, 1, 0]), B: pin("tint") } }),
        ]
      : [
          node("vertex", "VertexColor"),
          node("tint", "Constant3Vector", { constants: { Constant: [0.5, 0.25, 1, 1] } }),
          node("mul", "Multiply", { inputs: { A: pin("vertex", [1, 1, 1, 0]), B: pin("tint") } }),
        ];
  return materialGraphSchema.parse({
    format: 1,
    material: "M_Master",
    package: "/Game/Test/M_Master",
    truncated: false,
    nodeCount: nodes.length,
    outputs: {
      baseColor: pin("mul"),
      roughness: null,
      metallic: null,
      emissive: null,
      opacity: null,
      opacityMask: null,
      normal: null,
      materialAttributes: null,
    },
    nodes,
  });
}

const instanceProps = (parent: string, overrides: [string, string][]): string =>
  [
    `Parent = Material3'Content/Test/${parent}.${parent}'`,
    ...overrides.flatMap(([name, texture], index) => [
      `TextureParameterValues[${index}] =`,
      "{",
      "    ParameterInfo = { Name=None }",
      `    ParameterValue = Texture2D'/Game/Test/${texture}.${texture}'`,
      `    ParameterName = ${name}`,
      "}",
    ]),
  ].join("\n");

const encode = (unit: number): number => {
  const value = Math.min(1, Math.max(0, unit));
  return Math.round((value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055) * 255);
};

async function firstPixel(png: Buffer | Uint8Array): Promise<number[]> {
  const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return [...data.subarray(0, 3)];
}

describe("createGraphBaker", () => {
  async function fixture() {
    const root = await scratch("graph-bake-unit-");
    const sourceDir = join(root, "source", "Content", "Test");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "MI_Rock.uasset"), Buffer.alloc(16));
    await writeFile(join(sourceDir, "M_Master.uasset"), Buffer.alloc(16));
    const png = new Map<string, string>();
    await writePng(join(root, "T_MasterMask.png"), [10, 10, 10, 255], 4);
    await writePng(join(root, "T_InstanceMask.png"), [200, 100, 50, 255], 4);
    png.set("T_MasterMask", join(root, "T_MasterMask.png"));
    png.set("T_InstanceMask", join(root, "T_InstanceMask.png"));
    const props: Record<string, string> = {
      MI_Rock: instanceProps("M_Master", [["Mask", "T_InstanceMask"]]),
    };
    const assets = { png };
    const readProps = (name: string): string | undefined => props[name];
    return { root, sourceDir: join(root, "source"), assets, readProps };
  }

  it("hands the converter an engine it accepts (the importer carries UE_4.18)", async () => {
    const { sourceDir, assets, readProps } = await fixture();
    const engines: Array<string | undefined> = [];
    const baker = createGraphBaker({
      sourceDir,
      engine: "UE_4.18",
      maxTextureSize: 8,
      dumpGraphs: async (_dir, options) => {
        engines.push(options?.engine);
        return new Map([["M_Master", masterGraph()]]);
      },
    })!;
    await baker({ materialName: "MI_Rock_section", lookupName: "MI_Rock", assets, readProps });
    expect(engines).toEqual(["4.18"]);
  });

  it("bakes the instance's override, not the master default, and dumps once", async () => {
    const { sourceDir, assets, readProps } = await fixture();
    let dumps = 0;
    const baker = createGraphBaker({
      sourceDir,
      maxTextureSize: 8,
      dumpGraphs: async () => {
        dumps += 1;
        return new Map([["M_Master", masterGraph()]]);
      },
    })!;
    expect(baker).toBeDefined();
    expect(dumps).toBe(0); // lazy: nothing happens until the first request

    const first = await baker({ materialName: "MI_Rock_section", lookupName: "MI_Rock", assets, readProps });
    if (first.status !== "baked") throw new Error(`expected a bake, got ${JSON.stringify(first)}`);
    expect(first.graphMaterial).toBe("M_Master");
    expect(first.parameters?.textures.get("mask")).toBe("T_InstanceMask");
    expect(first.confidence).toBe("exact");
    expect(first.texturesUsed).toEqual(["T_InstanceMask"]);
    // Masks are read as stored; the product is re-encoded to sRGB for the glTF base colour texture.
    expect(await firstPixel(first.png)).toEqual([encode((200 / 255) * 0.5), encode((100 / 255) * 0.25), encode(50 / 255)]);

    const second = await baker({ materialName: "MI_Rock_other", lookupName: "MI_Rock", assets, readProps });
    expect(second.status).toBe("baked");
    expect(dumps).toBe(1);
    // The same graph + parameters + asset index is one bake, not two.
    expect(second).toBe(first);

    // With no override the master's own default texture is used.
    const plain = await baker({ materialName: "M_Master", lookupName: "M_Master", assets, readProps });
    if (plain.status !== "baked") throw new Error("expected a bake of the master");
    expect(await firstPixel(plain.png)).toEqual([encode((10 / 255) * 0.5), encode((10 / 255) * 0.25), encode(10 / 255)]);
    expect(dumps).toBe(1);
  });

  it("is unavailable without a source package and does not touch the converter", async () => {
    const { sourceDir, assets, readProps } = await fixture();
    let dumps = 0;
    const baker = createGraphBaker({
      sourceDir,
      dumpGraphs: async () => {
        dumps += 1;
        return new Map();
      },
    })!;
    const outcome = await baker({ materialName: "Ghost", lookupName: "Ghost", assets, readProps });
    expect(outcome).toMatchObject({ status: "unavailable", reason: "no source package" });
    expect(dumps).toBe(0);
  });

  it("reports a failing dump as unavailable, once, and never throws", async () => {
    const { sourceDir, assets, readProps } = await fixture();
    let dumps = 0;
    const baker = createGraphBaker({
      sourceDir,
      dumpGraphs: async () => {
        dumps += 1;
        throw new Error("converter exploded");
      },
    })!;
    const request = { materialName: "MI_Rock", lookupName: "MI_Rock", assets, readProps };
    const first = await baker(request);
    expect(first.status).toBe("unavailable");
    expect(first.status === "unavailable" && first.reason).toContain("converter exploded");
    expect((await baker(request)).status).toBe("unavailable");
    expect(dumps).toBe(1);
  });

  it("names the unsupported node class of a VertexColor graph", async () => {
    const { sourceDir, assets, readProps } = await fixture();
    const baker = createGraphBaker({
      sourceDir,
      dumpGraphs: async () => new Map([["M_Master", masterGraph("vertex-color")]]),
    })!;
    const outcome = await baker({ materialName: "MI_Rock", lookupName: "MI_Rock", assets, readProps });
    expect(outcome.status).toBe("unsupported");
    expect(outcome.status === "unsupported" && outcome.unsupported).toContain("VertexColor");
  });
});

// ---------------------------------------------------------------------------------------------------------
// The importer end to end: fake umodel + a fake modern converter that answers `--dump-graphs`.

async function writeFakeConverter(path: string, graph: MaterialGraph, argvLog: string): Promise<void> {
  await writeFile(
    path,
    `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const { join } = require("node:path");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(argv) + "\\n");
if (argv.includes("--version")) { process.stdout.write("fake-converter 1\\n"); process.exit(0); }
const at = argv.indexOf("--dump-graphs");
if (at >= 0) {
  fs.writeFileSync(join(argv[at + 1], ${JSON.stringify(`${graph.material}.graph.json`)}), ${JSON.stringify(JSON.stringify(graph))});
  process.exit(0);
}
process.exit(0);
`,
  );
  await chmod(path, 0o755);
}

async function importWithGraph(options: { graph: MaterialGraph; graphBake?: boolean }) {
  const root = await scratch("graph-bake-import-");
  const sourceDir = join(root, "source");
  const content = join(sourceDir, "Content", "Test");
  const exported = join(root, "exported");
  const outputDir = join(root, "output");
  await mkdir(content, { recursive: true });
  await writeFile(join(content, "Mesh.uasset"), Buffer.alloc(16));
  await writeFile(join(content, "MI_Rock.uasset"), Buffer.alloc(16));
  await writeFile(join(content, "M_Master.uasset"), Buffer.alloc(16));
  // The exporter binds nothing to MI_Rock: its colour exists only in the graph.
  await writeMeshFixture(exported, {
    name: "Mesh",
    materialName: "MI_Rock",
    mat: "",
    props: instanceProps("M_Master", [["Mask", "T_InstanceMask"]]),
    textures: [],
  });
  await writePng(join(exported, "T_InstanceMask.png"), [200, 100, 50, 255], 4);
  await writePng(join(exported, "T_MasterMask.png"), [10, 10, 10, 255], 4);
  const umodel = join(root, "umodel");
  await writeFakeUmodel(umodel, { exportFrom: exported, classes: { Mesh: ["StaticMesh"] } });
  const converter = join(root, "converter");
  const converterLog = join(root, "converter.log");
  await writeFakeConverter(converter, options.graph, converterLog);
  const report = await importUnrealDirectory({
    sourceDir,
    outputDir,
    onlyPackages: ["Mesh"],
    concurrency: 1,
    freeSpaceBytes: 30_000_000_000,
    umodel: { name: "umodel", path: umodel, version: "fixture" },
    modernConverter: { name: "modern", path: converter, version: "fake-converter 1" },
    ...(options.graphBake === undefined ? {} : { graphBake: options.graphBake }),
  });
  const glb = await new NodeIO().read(join(outputDir, report.models[0]!.glb));
  const onDisk = JSON.parse(await readFile(join(outputDir, "import-report.json"), "utf8")) as ImportReport;
  const dumped = await readFile(converterLog, "utf8").catch(() => "");
  return { report, onDisk, material: glb.getRoot().listMaterials()[0]!, dumped };
}

describe("importUnrealDirectory graph bake", () => {
  it("bakes a graph-only base colour and reports it as a graph binding", async () => {
    const { report, onDisk, material, dumped } = await importWithGraph({ graph: masterGraph() });
    const texture = material.getBaseColorTexture();
    expect(texture).not.toBeNull();
    expect(await firstPixel(texture!.getImage()!)).toEqual([encode((200 / 255) * 0.5), encode((100 / 255) * 0.25), encode(50 / 255)]);
    for (const reported of [report, onDisk]) {
      const section = reported.models[0]!.materials[0]!;
      expect(section.textured).toBe(true);
      expect(section.bindings).toContainEqual({
        slot: "baseColor",
        texture: `${section.name}_graph_baseColor`,
        source: "graph",
        confidence: "exact",
        transform: "none",
      });
      expect(section.graph).toMatchObject({ status: "baked", confidence: "exact", unsupportedNodes: [] });
      expect(reported.materialCoverage.graphBaked).toBe(1);
    }
    expect(dumped).toContain("--dump-graphs");
  });

  it("keeps the neutral fallback when graph baking is switched off", async () => {
    const { report, material, dumped } = await importWithGraph({ graph: masterGraph(), graphBake: false });
    expect(material.getBaseColorTexture()).toBeNull();
    expect(material.getBaseColorFactor()).toEqual([0.8, 0.8, 0.8, 1]);
    const section = report.models[0]!.materials[0]!;
    expect(section.graph).toBeUndefined();
    expect(section.textured).toBe(false);
    expect(report.materialCoverage.graphBaked).toBe(0);
    expect(dumped).toBe(""); // the converter was never spawned
  });

  it("names the unsupported node class and stays neutral for a VertexColor graph", async () => {
    const { report, material } = await importWithGraph({ graph: masterGraph("vertex-color") });
    expect(material.getBaseColorTexture()).toBeNull();
    expect(material.getBaseColorFactor().slice(0, 3).every((value) => Math.abs(value - 0.8) < 1e-6)).toBe(true);
    const section = report.models[0]!.materials[0]!;
    expect(section.graph).toMatchObject({ status: "unsupported" });
    expect(section.graph?.unsupportedNodes).toContain("VertexColor");
    expect(section.bindings.some((binding) => binding.source === "graph")).toBe(false);
    expect(report.materialCoverage.graphBaked).toBe(0);
  });
});
