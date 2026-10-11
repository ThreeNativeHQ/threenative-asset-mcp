import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeIO } from "@gltf-transform/core";
import sharp from "sharp";
import { describe, expect, it, onTestFinished } from "vitest";

import { createGraphBaker } from "../src/unreal/graph-baker.js";
import { materialGraphSchema, type MaterialGraph } from "../src/unreal/graph-dump.js";
import { importUnrealDirectory, type ImportedMaterialSection, type ImportedModel, type ImportReport } from "../src/unreal/importer.js";
import { bakeGraph, emissiveOnlyEffect, noColourOutput, particleDrivenBaseColor, type GraphParameters, type TextureRaster } from "../src/unreal/material-graph.js";
import { scorePack } from "../src/unreal/parity.js";
import type { PropertyDump } from "../src/unreal/property-dump.js";
import { writeFakeUmodel, writeMeshFixture, writePng } from "./helpers/unreal-fixture.js";

// Synthetic fixtures only: the shapes mirror the Soul Cave splash, effect and leaf materials, no licensed bytes.

async function scratch(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

type Raw = Record<string, unknown>;
const pin = (node: string, output = 0, mask: number[] | null = null) => ({ node, output, mask });
const node = (id: string, cls: string, extra: Raw = {}): Raw => ({ id, class: cls, inputs: {}, constants: {}, ...extra });
const NO_PARAMETERS: GraphParameters = { textures: new Map(), vectors: new Map(), scalars: new Map(), switches: new Map() };

function graphOf(
  material: string,
  nodes: Raw[],
  outputs: { baseColor?: ReturnType<typeof pin>; emissive?: ReturnType<typeof pin>; opacityMask?: ReturnType<typeof pin> },
): MaterialGraph {
  return materialGraphSchema.parse({
    format: 1,
    material,
    package: `/Game/Test/${material}`,
    truncated: false,
    nodeCount: nodes.length,
    outputs: {
      baseColor: outputs.baseColor ?? null,
      roughness: null,
      metallic: null,
      emissive: outputs.emissive ?? null,
      opacity: null,
      opacityMask: outputs.opacityMask ?? null,
      normal: null,
      materialAttributes: null,
    },
    nodes,
  });
}

/** SM_SplashMesh_02's master: BaseColor = (UseColorTexture ? Noise.rgb : BaseColor) x ParticleColor.rgb. */
function particleTintedMaster(): MaterialGraph {
  return graphOf(
    "M_Splash",
    [
      node("mul", "Multiply", { inputs: { A: pin("switch"), B: pin("particle", 0, [1, 1, 1, 0]) } }),
      node("switch", "StaticSwitchParameter", {
        inputs: { A: pin("noise", 0, [1, 1, 1, 0]), B: pin("tint", 0, [1, 1, 1, 0]) },
        parameter: { name: "UseColorTexture", group: "" },
        default: true,
        switchValue: true,
      }),
      node("noise", "TextureSampleParameter2D", {
        parameter: { name: "UseColorTexture", group: "" },
        default: null,
        texture: "/Game/Test/T_Noise.T_Noise",
        samplerType: "Color",
      }),
      node("tint", "VectorParameter", { parameter: { name: "BaseColor", group: "" }, default: [0.5, 0.5, 0.5, 1] }),
      node("particle", "ParticleColor"),
    ],
    { baseColor: pin("mul") },
  );
}

/** M_WaveSplash_01's shape: Emissive = Mask.g x ParticleColor.rgb, no BaseColor. */
function emissiveOnlyGraph(): MaterialGraph {
  return graphOf(
    "M_Foam",
    [
      node("mul", "Multiply", { inputs: { A: pin("mask", 2, [0, 1, 0, 0]), B: pin("particle", 0, [1, 1, 1, 0]) } }),
      node("mask", "TextureSample", {
        inputs: { Coordinates: pin("uv") },
        coordinates: pin("uv"),
        texture: "/Game/Test/T_FoamMask.T_FoamMask",
        samplerType: "Masks",
      }),
      node("uv", "TextureCoordinate"),
      node("particle", "ParticleColor"),
      node("unused", "TextureSample", { texture: "/Game/Test/T_NotOnPath.T_NotOnPath", samplerType: "Masks" }),
    ],
    { emissive: pin("mul") },
  );
}

/**
 * A particle splash master: BaseColor = ParticleColor x a mask sampled at UV + a panner whose offset and speed come from
 * the emitter's DynamicParameter (x per-particle offset, w timing), driven by Time.
 */
function dynamicParameterGraph(): MaterialGraph {
  return graphOf(
    "M_FluidSplash",
    [
      node("mul", "Multiply", { inputs: { A: pin("particle", 0, [1, 1, 1, 0]), B: pin("mask", 0, [1, 1, 1, 0]) } }),
      node("particle", "ParticleColor"),
      node("mask", "TextureSample", { inputs: { Coordinates: pin("pan") }, coordinates: pin("pan"), texture: "/Game/Test/T_SplashMask.T_SplashMask", samplerType: "Color" }),
      node("pan", "Panner", { inputs: { Coordinate: pin("offset"), Time: pin("timing") }, constants: { SpeedX: 0.25, SpeedY: 0.68 } }),
      node("offset", "Add", { inputs: { A: pin("uv"), B: pin("dynamic", 0, [1, 0, 0, 0]) } }),
      node("uv", "TextureCoordinate"),
      node("timing", "Multiply", { inputs: { A: pin("dynamic", 3, [0, 0, 0, 1]), B: pin("time") } }),
      node("dynamic", "DynamicParameter", { parameter: { name: "", group: "" } }),
      node("time", "Time"),
    ],
    { baseColor: pin("mul") },
  );
}

async function texturePng(rgb: [number, number, number]): Promise<Buffer> {
  return sharp({ create: { width: 2, height: 2, channels: 4, background: { r: rgb[0], g: rgb[1], b: rgb[2], alpha: 1 } } }).png().toBuffer();
}

async function rasterOf(png: Buffer, srgb: boolean): Promise<TextureRaster> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, rgba: new Uint8Array(data), srgb };
}

describe("ParticleColor in the graph evaluator", () => {
  it("is unsupported unless the caller supplies it, and is named", async () => {
    const result = await bakeGraph({ graph: particleTintedMaster(), output: "baseColor", parameters: NO_PARAMETERS, loadTexture: async () => rasterOf(await texturePng([100, 100, 100]), true), size: 2 });
    expect(result).toMatchObject({ status: "unsupported", unsupported: ["ParticleColor"] });
  });

  it("evaluates as white outside a particle emitter, says so, and keeps the texture colour", async () => {
    const png = await texturePng([100, 150, 200]);
    const result = await bakeGraph({
      graph: particleTintedMaster(),
      output: "baseColor",
      // The instance's BaseColor tint is not on the path: UseColorTexture defaults to true, so the noise texture is.
      parameters: { ...NO_PARAMETERS, vectors: new Map([["basecolor", [0.1, 0.1, 0.1, 1]]]) },
      loadTexture: async () => rasterOf(png, true),
      size: 2,
      particleColor: [1, 1, 1, 1],
    });
    if (result.status !== "baked") throw new Error(`expected a bake, got ${JSON.stringify(result)}`);
    const { data } = await sharp(result.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect([...data.subarray(0, 3)]).toEqual([100, 150, 200]);
    expect(result.confidence).toBe("heuristic");
    expect(result.approximations).toContain("ParticleColor evaluated as white: Unreal's value outside a particle emitter; the emitter's colour modules are not read");
  });
});

describe("emissiveOnlyEffect", () => {
  it("recognises a graph that wires only Emissive and lists the textures on that path", () => {
    const effect = emissiveOnlyEffect(emissiveOnlyGraph());
    expect(effect?.textures).toEqual(["T_FoamMask"]);
    expect(effect?.reason).toContain("wires only Emissive");
  });

  it("is not an effect when BaseColor is wired, or when Emissive is not", () => {
    expect(emissiveOnlyEffect(particleTintedMaster())).toBeUndefined();
    expect(emissiveOnlyEffect(graphOf("M_None", [node("c", "Constant")], {}))).toBeUndefined();
  });
});

describe("particleDrivenBaseColor", () => {
  it("names a BaseColor path that reads DynamicParameter, which only an emitter sets", () => {
    expect(particleDrivenBaseColor(dynamicParameterGraph())).toContain("reads DynamicParameter on its BaseColor path");
  });

  it("does not claim a ParticleColor-only tint (white off an emitter, baked as such) or an emissive-only graph", () => {
    expect(particleDrivenBaseColor(particleTintedMaster())).toBeUndefined();
    expect(particleDrivenBaseColor(emissiveOnlyGraph())).toBeUndefined();
  });
});

describe("createGraphBaker on an emissive-only effect", () => {
  async function bakerFor(graph: MaterialGraph) {
    const root = await scratch("effect-baker-");
    const content = join(root, "source", "Content", "Test");
    await mkdir(content, { recursive: true });
    await writeFile(join(content, `${graph.material}.uasset`), Buffer.alloc(16));
    let dumps = 0;
    const baker = createGraphBaker({
      sourceDir: join(root, "source"),
      dumpGraphs: async () => {
        dumps += 1;
        return new Map([[graph.material, graph]]);
      },
    })!;
    const request = { materialName: graph.material, lookupName: graph.material, assets: { png: new Map<string, string>() }, readProps: () => undefined };
    return { baker, request, dumps: () => dumps };
  }

  it("reports the effect with its emissive textures, in a probe and in a plain request, without baking", async () => {
    const { baker, request } = await bakerFor(emissiveOnlyGraph());
    for (const probe of [true, false]) {
      const outcome = await baker({ ...request, probe });
      expect(outcome.status).toBe("unavailable");
      expect(outcome.effect?.textures).toEqual(["T_FoamMask"]);
    }
  });

  it("reports a DynamicParameter-driven graph that cannot be baked as a particle material", async () => {
    const { baker, request } = await bakerFor(dynamicParameterGraph());
    const outcome = await baker(request);
    expect(outcome.status).toBe("unsupported");
    expect(outcome.particle).toContain("reads DynamicParameter on its BaseColor path");
    expect(outcome.effect).toBeUndefined();
  });

  it("a probe of a material with a BaseColor output reports no effect and never bakes", async () => {
    const { baker, request } = await bakerFor(particleTintedMaster());
    const outcome = await baker({ ...request, probe: true });
    expect(outcome.status).toBe("unavailable");
    expect(outcome.effect).toBeUndefined();
    expect(outcome).not.toHaveProperty("png");
  });
});

// ---------------------------------------------------------------------------------------------------------
// The importer end to end: fake umodel + a fake converter answering `--dump-graphs`.

async function writeFakeConverter(path: string, graph: MaterialGraph): Promise<void> {
  await writeFile(
    path,
    `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const { join } = require("node:path");
const argv = process.argv.slice(2);
if (argv.includes("--version")) { process.stdout.write("fake-converter 1\\n"); process.exit(0); }
const at = argv.indexOf("--dump-graphs");
if (at >= 0) fs.writeFileSync(join(argv[at + 1], ${JSON.stringify(`${graph.material}.graph.json`)}), ${JSON.stringify(JSON.stringify(graph))});
process.exit(0);
`,
  );
  await chmod(path, 0o755);
}

const translucentProps = (parent: string, extra: string[] = []): string =>
  [`Parent = Material3'Content/Test/${parent}.${parent}'`, "BlendMode = BLEND_Translucent (2)", ...extra].join("\n");

async function importFixture(options: {
  graph: MaterialGraph;
  materialName: string;
  props: string;
  mat?: string;
  textures: [string, [number, number, number]][];
  /** Bytes appended to the mesh package, which the importer scans for the engine default material. */
  meshPackageText?: string;
  vertexColor?: readonly [number, number, number, number];
  saturatedUv?: boolean;
  /** Further `<name>.props.txt` files in the export: the parent instances a chain walks through. */
  extraProps?: Record<string, string>;
}) {
  const root = await scratch("effect-import-");
  const sourceDir = join(root, "source");
  const content = join(sourceDir, "Content", "Test");
  const exported = join(root, "exported");
  await mkdir(content, { recursive: true });
  await writeFile(join(content, "Mesh.uasset"), Buffer.concat([Buffer.alloc(16), Buffer.from(options.meshPackageText ?? "")]));
  await writeFile(join(content, `${options.graph.material}.uasset`), Buffer.alloc(16));
  await writeFile(join(content, `${options.materialName}.uasset`), Buffer.alloc(16));
  await writeMeshFixture(exported, {
    name: "Mesh",
    materialName: options.materialName,
    mat: options.mat ?? "",
    props: options.props,
    textures: [],
    ...(options.vertexColor ? { vertexColor: options.vertexColor } : {}),
    ...(options.saturatedUv ? { saturatedUv: true } : {}),
  });
  for (const [name, text] of Object.entries(options.extraProps ?? {})) await writeFile(join(exported, `${name}.props.txt`), text);
  for (const [name, rgb] of options.textures) {
    // The texture package exists in the pack; the graph names it, so the baker exports it from the source, not from the mesh export.
    await writeFile(join(content, `${name}.uasset`), Buffer.alloc(16));
    await writePng(join(exported, `${name}.png`), [...rgb, 255], 4);
  }
  const umodel = join(root, "umodel");
  await writeFakeUmodel(umodel, { exportFrom: exported, classes: { Mesh: ["StaticMesh"] } });
  const converter = join(root, "converter");
  await writeFakeConverter(converter, options.graph);
  const outputDir = join(root, "output");
  const report = await importUnrealDirectory({
    sourceDir,
    outputDir,
    onlyPackages: ["Mesh"],
    concurrency: 1,
    freeSpaceBytes: 30_000_000_000,
    environment: { ...process.env, THREENATIVE_UNREAL_CACHE_DIR: join(root, "cache") },
    umodel: { name: "umodel", path: umodel, version: "fixture" },
    modernConverter: { name: "modern", path: converter, version: "fake-converter 1" },
  });
  const glb = await new NodeIO().read(join(outputDir, report.models[0]!.glb));
  const onDisk = JSON.parse(await readFile(join(outputDir, "import-report.json"), "utf8")) as ImportReport;
  const primitive = glb.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
  return { report, onDisk, material: glb.getRoot().listMaterials()[0]!, section: report.models[0]!.materials[0]!, primitive };
}

describe("importer: a ParticleColor-tinted translucent instance (SM_SplashMesh_02)", () => {
  it("bakes the texture colour, keeps the instance's opacity as alpha, and is not an effect", async () => {
    const { material, section, report } = await importFixture({
      graph: particleTintedMaster(),
      materialName: "MI_Splash",
      props: translucentProps("M_Splash", [
        "CollectedTextureParameters[1] =",
        "{",
        "    CollectedTextureParameters[0] =",
        "    {",
        "        Texture = Texture2D'/Game/Test/T_Noise.T_Noise'",
        "        Name = UseColorTexture",
        "        Group = None",
        "    }",
        "}",
        "VectorParameterValues[1] =",
        "{",
        "    VectorParameterValues[0] =",
        "    {",
        "        ParameterInfo = { Name=None }",
        "        ParameterValue = { R=0.1, G=0.1, B=0.1, A=1 }",
        "        ParameterName = BaseColor",
        "    }",
        "}",
        "ScalarParameterValues[1] =",
        "{",
        "    ScalarParameterValues[0] =",
        "    {",
        "        ParameterInfo = { Name=None }",
        "        ParameterValue = 0.125",
        "        ParameterName = Opacity",
        "    }",
        "}",
      ]),
      textures: [["T_Noise", [100, 150, 200]]],
    });
    expect(section.graph).toMatchObject({ status: "baked", confidence: "heuristic" });
    expect(section.graph?.approximations.join("\n")).toContain("ParticleColor evaluated as white");
    expect(section.effect).toBeUndefined();
    // The graph already holds the colour (the noise texture, not the 0.1 tint); only the opacity carries over.
    expect(material.getBaseColorTexture()).not.toBeNull();
    expect(material.getBaseColorFactor()).toEqual([1, 1, 1, 0.125]);
    expect(material.getAlphaMode()).toBe("BLEND");
    expect(report.materialCoverage.effect).toBe(0);
  });
});

/** An ivy leaf card: BaseColor = leaf texture, and the cut-out lives only in the Opacity (or OpacityMask) pin. */
function leafCardGraph(pinName: "opacity" | "opacityMask"): MaterialGraph {
  const nodes = [
    node("leaf", "TextureSample", { texture: "/Game/Test/T_Leaf.T_Leaf", samplerType: "Color" }),
    node("mask", "TextureSample", { texture: "/Game/Test/T_LeafMask.T_LeafMask", samplerType: "Color" }),
    node("gray", "Desaturation", { inputs: { Input: pin("mask", 0, [1, 1, 1, 0]) } }),
  ];
  return materialGraphSchema.parse({
    format: 1,
    material: "M_Leaf",
    package: "/Game/Test/M_Leaf",
    truncated: false,
    nodeCount: nodes.length,
    outputs: { baseColor: pin("leaf", 0, [1, 1, 1, 0]), roughness: null, metallic: null, emissive: null, opacity: pinName === "opacity" ? pin("gray") : null, opacityMask: pinName === "opacityMask" ? pin("gray") : null, normal: null, materialAttributes: null },
    nodes,
  });
}

async function embeddedAlpha(material: { getBaseColorTexture(): { getImage(): Uint8Array | null } | null }): Promise<number[]> {
  const image = material.getBaseColorTexture()!.getImage()!;
  const { data } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return [data[3]!, data[data.length - 1]!];
}

describe("importer: a leaf card whose silhouette lives in an opacity mask (SM_ivy)", () => {
  it("bakes a translucent material's Opacity into the base colour's alpha instead of a solid rectangle", async () => {
    const { material, section } = await importFixture({
      graph: leafCardGraph("opacity"),
      materialName: "MI_Leaf",
      props: translucentProps("M_Leaf"),
      // A black mask is the card's clear background: nothing of the card may be drawn.
      textures: [["T_Leaf", [40, 120, 50]], ["T_LeafMask", [0, 0, 0]]],
    });
    expect(section.graph).toMatchObject({ status: "baked" });
    expect(await embeddedAlpha(material)).toEqual([0, 0]);
  });

  it("exports a binary leaf cut-out as MASK, because blended overlapping cards render grey", async () => {
    const { material, section } = await importFixture({
      graph: leafCardGraph("opacity"),
      materialName: "MI_Leaf",
      props: translucentProps("M_Leaf"),
      textures: [["T_Leaf", [40, 120, 50]], ["T_LeafMask", [255, 255, 255]]],
    });
    expect(material.getAlphaMode()).toBe("MASK");
    expect(material.getAlphaCutoff()).toBe(0.5);
    expect(section.alphaMode).toBe("MASK");
    expect(section.limitations.join("\n")).toContain("binary cut-out");
  });

  it("keeps a genuinely graded translucency (a soft mask) as BLEND", async () => {
    const { material, section } = await importFixture({
      graph: leafCardGraph("opacity"),
      materialName: "MI_Leaf",
      props: translucentProps("M_Leaf"),
      // sRGB 128 decodes to linear 0.216: a uniform soft veil, not a cut-out.
      textures: [["T_Leaf", [40, 120, 50]], ["T_LeafMask", [128, 128, 128]]],
    });
    expect(material.getAlphaMode()).toBe("BLEND");
    expect(section.limitations.join("\n")).not.toContain("binary cut-out");
    const [alpha] = await embeddedAlpha(material);
    expect(alpha).toBeGreaterThan(40);
    expect(alpha).toBeLessThan(70);
  });

  it("keeps the leaf opaque where the mask is white", async () => {
    const { material } = await importFixture({
      graph: leafCardGraph("opacity"),
      materialName: "MI_Leaf",
      props: translucentProps("M_Leaf"),
      textures: [["T_Leaf", [40, 120, 50]], ["T_LeafMask", [255, 255, 255]]],
    });
    expect(await embeddedAlpha(material)).toEqual([255, 255]);
  });

  it("bakes a masked material's OpacityMask and keeps MASK mode", async () => {
    const { material } = await importFixture({
      graph: leafCardGraph("opacityMask"),
      materialName: "MI_Leaf",
      props: ["Parent = Material3'Content/Test/M_Leaf.M_Leaf'", "BlendMode = BLEND_Masked (1)", "OpacityMaskClipValue = 0.333"].join("\n"),
      textures: [["T_Leaf", [40, 120, 50]], ["T_LeafMask", [0, 0, 0]]],
    });
    expect(material.getAlphaMode()).toBe("MASK");
    expect(await embeddedAlpha(material)).toEqual([0, 0]);
  });
});

describe("importer: an emissive-only effect (SM_Splash_Sea)", () => {
  async function foam() {
    return importFixture({
      graph: emissiveOnlyGraph(),
      materialName: "M_Foam",
      // UE Viewer names the first sampled texture Diffuse even though the graph only emits it.
      mat: "Diffuse=T_FoamMask\nSpecPower=T_FoamMask\n",
      props: "BlendMode = BLEND_Translucent (2)\nTwoSided = true\n",
      textures: [["T_FoamMask", [90, 120, 150]]],
    });
  }

  it("records the effect with a reason and binds the mask as emissive and alpha, never as albedo", async () => {
    const { material, section, report, onDisk } = await foam();
    expect(section.effect).toMatchObject({ kind: "emissive" });
    expect(section.effect?.reason).toContain("wires only Emissive");
    expect(section.limitations.join("\n")).toContain("wires only Emissive");
    expect(section.limitations.join("\n")).toContain("emissive mask");
    expect(section.textured).toBe(false);
    expect(section.bindings).toContainEqual(expect.objectContaining({ slot: "emissive", texture: "T_FoamMask" }));
    expect(section.bindings).toContainEqual(expect.objectContaining({ slot: "baseColor", texture: "T_FoamMask", source: "effect", transform: "redToBaseColorAlpha" }));
    // The same mask read as SpecPower is not roughness for an unlit effect.
    expect(section.bindings.some((binding) => binding.slot === "metallicRoughness")).toBe(false);
    expect(material.getMetallicRoughnessTexture()).toBeNull();
    expect(material.getEmissiveTexture()).not.toBeNull();
    expect(material.getEmissiveFactor()).toEqual([1, 1, 1]);
    expect(material.getAlphaMode()).toBe("BLEND");
    expect(report.materialCoverage.effect).toBe(1);
    expect(onDisk.models[0]!.materials[0]!.effect).toEqual(section.effect);
    expect(report.warnings.join("\n")).toContain("no albedo by design");
  });
});

describe("importer: a particle material whose BaseColor reads DynamicParameter", () => {
  it("records the section as a particle effect with its reason (an effect section is not a parity colour miss)", async () => {
    const { section, report } = await importFixture({
      graph: dynamicParameterGraph(),
      materialName: "MI_FluidSplash",
      props: translucentProps("M_FluidSplash"),
      textures: [["T_SplashMask", [200, 220, 240]]],
    });
    expect(section.graph).toMatchObject({ status: "unsupported" });
    expect(section.effect).toMatchObject({ kind: "particle" });
    expect(section.textured).toBe(false);
    expect(report.materialCoverage.effect).toBe(1);
    expect(report.warnings.join("\n")).toContain("1 particle material");
  });
});

/** A bolt overlay: the textures feed Roughness, Opacity and Normal; BaseColor, MaterialAttributes and Emissive are unwired. */
function overlayGraph(extra: { truncated?: boolean; outputConstants?: Record<string, unknown> } = {}): MaterialGraph {
  const nodes = [
    node("rough", "TextureSample", { texture: "/Game/Test/T_Bolts_R.T_Bolts_R", samplerType: "Color" }),
    node("alpha", "TextureSample", { texture: "/Game/Test/T_Bolts_A.T_Bolts_A", samplerType: "Color" }),
    node("normal", "TextureSample", { texture: "/Game/Test/T_Bolts_N.T_Bolts_N", samplerType: "Normal" }),
  ];
  return materialGraphSchema.parse({
    format: 1,
    material: "M_Bolts",
    package: "/Game/Test/M_Bolts",
    truncated: extra.truncated ?? false,
    nodeCount: nodes.length,
    outputs: { baseColor: null, roughness: pin("rough", 0, [1, 1, 1, 0]), metallic: null, emissive: null, opacity: pin("alpha", 0, [1, 1, 1, 0]), opacityMask: null, normal: pin("normal", 0, [1, 1, 1, 0]), materialAttributes: null },
    outputConstants: extra.outputConstants ?? {},
    nodes,
  });
}

describe("noColourOutput", () => {
  it("names a graph that wires no BaseColor, MaterialAttributes or Emissive: Unreal's default BaseColor is black", () => {
    expect(noColourOutput(overlayGraph())).toContain("wires no BaseColor, MaterialAttributes or Emissive (only opacity, roughness, normal)");
  });

  it("claims nothing for a graph with a colour output, a truncated graph, an unread output or a constant BaseColor", () => {
    expect(noColourOutput(particleTintedMaster())).toBeUndefined();
    expect(noColourOutput(emissiveOnlyGraph())).toBeUndefined();
    expect(noColourOutput(overlayGraph({ truncated: true }))).toBeUndefined();
    expect(noColourOutput(overlayGraph({ outputConstants: { baseColorError: "property BaseColor could not be read" } }))).toBeUndefined();
    expect(noColourOutput(overlayGraph({ outputConstants: { baseColor: [0.5, 0.2, 0.1, 1] } }))).toBeUndefined();
  });
});

describe("importer: a translucent overlay whose graph wires no colour output", () => {
  it("records the section as having no albedo by design (not a parity colour miss) instead of an unavailable graph", async () => {
    const { section, report } = await importFixture({
      graph: overlayGraph(),
      materialName: "M_Bolts",
      props: "BlendMode = BLEND_Translucent (2)\n",
      textures: [["T_Bolts_A", [200, 200, 200]], ["T_Bolts_R", [90, 90, 90]]],
    });
    expect(section.graph).toMatchObject({ status: "unavailable" });
    expect(section.effect).toMatchObject({ kind: "no-base-colour" });
    expect(section.effect?.reason).toContain("default BaseColor, black");
    expect(section.textured).toBe(false);
    expect(report.materialCoverage.effect).toBe(1);
    expect(report.warnings.join("\n")).toContain("1 with no colour output");
  });
});

describe("importer: vertex colours the material never reads", () => {
  /** BaseColor = texture, optionally x VertexColor.rgb. */
  function textured(readsVertexColor: boolean): MaterialGraph {
    return graphOf(
      "M_Cloth",
      [
        node("albedo", "TextureSample", { texture: "/Game/Test/T_Cloth_D.T_Cloth_D", samplerType: "Color" }),
        ...(readsVertexColor
          ? [node("mul", "Multiply", { inputs: { A: pin("albedo", 0, [1, 1, 1, 0]), B: pin("paint", 0, [1, 1, 1, 0]) } }), node("paint", "VertexColor")]
          : []),
      ],
      { baseColor: readsVertexColor ? pin("mul") : pin("albedo", 0, [1, 1, 1, 0]) },
    );
  }
  const opaqueProps = ["Parent = Material3'Content/Test/M_Cloth.M_Cloth'", "BlendMode = BLEND_Opaque (0)"].join("\n");

  it("drops a black COLOR_0 that glTF would multiply into the base colour, and says so", async () => {
    // A skeletal character whose vertex colours are all black rendered black in a glTF viewer, although Unreal ignores
    // vertex colours its material does not read.
    const { primitive, section } = await importFixture({
      graph: textured(false),
      materialName: "MI_Cloth",
      props: opaqueProps,
      mat: "Diffuse=T_Cloth_D\n",
      textures: [["T_Cloth_D", [120, 90, 60]]],
      vertexColor: [0, 0, 0, 1],
    });
    expect(primitive.getAttribute("COLOR_0")).toBeNull();
    expect(section.limitations.join("\n")).toContain("Vertex colours (COLOR_0) dropped from 1 primitive(s)");
  });

  it("keeps COLOR_0 when the BaseColor path reads VertexColor", async () => {
    const { primitive, section } = await importFixture({
      graph: textured(true),
      materialName: "MI_Cloth",
      props: opaqueProps,
      mat: "Diffuse=T_Cloth_D\n",
      textures: [["T_Cloth_D", [120, 90, 60]]],
      vertexColor: [0.5, 0.25, 1, 1],
    });
    expect(primitive.getAttribute("COLOR_0")).not.toBeNull();
    expect(section.limitations.join("\n")).not.toContain("COLOR_0) dropped");
  });
});

describe("importer: half-float UVs stored as -65504", () => {
  it("resets the saturation value so it never reaches glTF, and says so", async () => {
    // Dead-tree bark carried -65504 in a UV channel: a renderer that wraps it samples an arbitrary texel.
    const { primitive, report } = await importFixture({
      graph: graphOf(
        "M_Cloth",
        [node("albedo", "TextureSample", { texture: "/Game/Test/T_Cloth_D.T_Cloth_D", samplerType: "Color" })],
        { baseColor: pin("albedo", 0, [1, 1, 1, 0]) },
      ),
      materialName: "MI_Cloth",
      props: ["Parent = Material3'Content/Test/M_Cloth.M_Cloth'", "BlendMode = BLEND_Opaque (0)"].join("\n"),
      mat: "Diffuse=T_Cloth_D\n",
      textures: [["T_Cloth_D", [120, 90, 60]]],
      saturatedUv: true,
    });
    const uv = primitive.getAttribute("TEXCOORD_0")!.getArray()!;
    expect(Math.min(...uv)).toBeGreaterThanOrEqual(0);
    expect(report.warnings.join("\n")).toContain("-65504");
  });
});

describe("importer: a slot holding the engine default material (SM_leaf)", () => {
  async function leaf(meshPackageText: string) {
    return importFixture({
      graph: particleTintedMaster(),
      // UE Viewer names an unresolvable slot dummy_material_<n>.
      materialName: "dummy_material_0",
      props: "",
      textures: [],
      meshPackageText,
    });
  }

  it("says the mesh names WorldGridMaterial, so the neutral grey is by design", async () => {
    const { section, material, report } = await leaf("/Engine/EngineMaterials/WorldGridMaterial\0WorldGridMaterial");
    expect(section.resolved).toBe(false);
    expect(section.effect).toMatchObject({ kind: "engine-default-material" });
    expect(section.effect?.reason).toContain("WorldGridMaterial");
    expect(material.getBaseColorFactor()).toEqual([0.8, 0.8, 0.8, 1]);
    expect(report.materialCoverage.effect).toBe(1);
  });

  it("drops COLOR_0 from an engine-default slot: WorldGridMaterial does not read VertexColor", async () => {
    const { section, primitive } = await importFixture({
      graph: particleTintedMaster(),
      materialName: "dummy_material_0",
      props: "",
      textures: [],
      meshPackageText: "/Engine/EngineMaterials/WorldGridMaterial\0WorldGridMaterial",
      vertexColor: [0, 1, 0, 1],
    });
    expect(section.effect).toMatchObject({ kind: "engine-default-material" });
    expect(primitive.getAttribute("COLOR_0")).toBeNull();
    expect(section.limitations.join("\n")).toContain("Vertex colours (COLOR_0) dropped from 1 primitive(s)");
  });

  it("claims nothing when the mesh package does not name the engine default material", async () => {
    const { section, report } = await leaf("/Game/Test/SomeOtherMaterial");
    expect(section.resolved).toBe(false);
    expect(section.effect).toBeUndefined();
    expect(report.materialCoverage.effect).toBe(0);
  });
});

describe("importer: a slot the mesh assigns no material (CUE4Parse names it None)", () => {
  it("drops the region-mask COLOR_0 and says Unreal draws its default material", async () => {
    // A MetaHuman face mesh with empty slots and RGB region-mask vertex colours rendered saturated green and cyan in a
    // glTF viewer; Unreal draws an empty slot with WorldGridMaterial, which never reads VertexColor.
    const { section, primitive, material, report } = await importFixture({
      graph: particleTintedMaster(),
      materialName: "None",
      props: "",
      textures: [],
      vertexColor: [0, 1, 0, 1],
    });
    expect(primitive.getAttribute("COLOR_0")).toBeNull();
    expect(section.limitations.join("\n")).toContain("Vertex colours (COLOR_0) dropped from 1 primitive(s)");
    expect(section.resolved).toBe(false);
    expect(section.effect).toMatchObject({ kind: "engine-default-material" });
    expect(section.effect?.reason).toContain("assigns no material");
    expect(material.getBaseColorFactor()).toEqual([0.8, 0.8, 0.8, 1]);
    expect(report.materialCoverage.effect).toBe(1);
  });

  it("keeps COLOR_0 on a named material whose graph is unknown", async () => {
    const { section, primitive } = await importFixture({
      graph: particleTintedMaster(),
      materialName: "MI_Unknown",
      props: "",
      textures: [],
      vertexColor: [0, 1, 0, 1],
    });
    expect(primitive.getAttribute("COLOR_0")).not.toBeNull();
    expect(section.effect).toBeUndefined();
  });
});

describe("parity scorer: legitimately neutral effect sections", () => {
  const dump: PropertyDump = {
    format: 1,
    game: "GAME_UE4_18",
    packages: [
      { path: "/Game/C/SM_Foam", exports: [{ name: "SM_Foam", class: "StaticMesh", slots: [{ name: "Slot0", material: "/Game/C/M_Foam.M_Foam" }], bounds: { origin: [0, 0, 0], boxExtent: [100, 200, 50], sphereRadius: 1, property: "ExtendedBounds" } }] },
      { path: "/Game/C/M_Foam", exports: [{ name: "M_Foam", class: "Material", textureParameters: [], textures: ["/Game/C/T_Foam_M.T_Foam_M"], vectorParameters: [], constantColors: 0 }] },
    ],
  };
  const grey = (over: Partial<ImportedMaterialSection>): ImportedMaterialSection => ({
    name: "M_Foam",
    resolved: true,
    bindings: [],
    unsupported: [],
    alphaMode: "BLEND",
    limitations: [],
    doubleSided: false,
    factors: { baseColor: [0.8, 0.8, 0.8, 1], emissive: [0, 0, 0], metallic: 0, roughness: 1 },
    textured: false,
    sidecarTextures: [],
    ...over,
  });
  const reportOf = (section: ImportedMaterialSection): ImportReport => {
    const model = {
      name: "SM_Foam",
      package: "Content/C/SM_Foam.uasset",
      kind: "static",
      glb: "x.glb",
      bytes: 1,
      sha256: "x",
      vertices: 1,
      primitives: 1,
      skins: 0,
      joints: 0,
      morphTargets: 0,
      animations: 0,
      boundsMetres: [2, 1, 4],
      materials: [section],
    } as unknown as ImportedModel;
    return { models: [model], failed: [], skipped: [] } as unknown as ImportReport;
  };

  it("counts a grey section as a colour miss, and a grey section with a named effect as neither miss nor expected", () => {
    const plain = scorePack(dump, reportOf(grey({})));
    expect(plain.colour).toMatchObject({ expectsColour: 1, coloured: 0, missesTotal: 1, effectNeutral: 0 });
    const effect = scorePack(dump, reportOf(grey({ effect: { kind: "emissive", reason: "wires only Emissive" } })));
    expect(effect.colour).toMatchObject({ expectsColour: 0, coloured: 0, missesTotal: 0, effectNeutral: 1 });
  });
});

describe("importer: an Additive or Modulate material is classified by its BlendMode, not waved through", () => {
  /** A particle master whose BaseColor needs a per-particle DynamicParameter the bake cannot read. */
  const particleMaster = (): MaterialGraph =>
    graphOf(
      "M_Spark",
      [
        node("mul", "Multiply", { inputs: { A: pin("tint", 0, [1, 1, 1, 0]), B: pin("dynamic") } }),
        node("tint", "VectorParameter", { parameter: { name: "Colour", group: "" }, default: [1, 0.5, 0.2, 1] }),
        node("dynamic", "DynamicParameter", { outputNames: ["Param1", "Param2", "Param3", "Param4"], parameter: { name: "", group: "" }, default: null }),
      ],
      { baseColor: pin("mul") },
    );
  const spark = (blend: string) =>
    importFixture({ graph: particleMaster(), materialName: "M_Spark", props: `BlendMode = ${blend}\nTwoSided = true\n`, textures: [] });

  it("Additive and Modulate: the section is an effect with the blend mode as its reason", async () => {
    for (const [blend, verb] of [["BLEND_Additive (3)", "added to"], ["BLEND_Modulate (4)", "multiplied with"]] as const) {
      const { section, report } = await spark(blend);
      expect(section.effect, blend).toMatchObject({ kind: "additive-blend" });
      expect(section.effect?.reason).toContain(verb);
      expect(report.materialCoverage.effect).toBe(1);
      // The graph is still asked and its unsupported node still named: the classification does not hide it.
      expect(section.graph).toMatchObject({ status: "unsupported", unsupportedNodes: ["DynamicParameter"] });
    }
  });

  it("Translucent with the same graph is a particle effect, not an additive-blend one: the emitter supplies the colour", async () => {
    const { section, report } = await spark("BLEND_Translucent (2)");
    expect(section.effect).toMatchObject({ kind: "particle" });
    expect(report.materialCoverage.effect).toBe(1);
    expect(section.graph).toMatchObject({ status: "unsupported", unsupportedNodes: ["DynamicParameter"] });
  });
});

describe("importer: a bake that stands in for a view- or time-dependent node says so", () => {
  it("adds a 'view-dependent: approximated' limitation naming the nodes, and none for a static graph", async () => {
    const rim = graphOf(
      "M_Rim",
      [
        node("mix", "LinearInterpolate", { inputs: { A: pin("face"), B: pin("edge"), Alpha: pin("fresnel") } }),
        node("face", "Constant3Vector", { constants: { Constant: [0.2, 0.3, 0.7, 1] } }),
        node("edge", "Constant3Vector", { constants: { Constant: [1, 1, 1, 1] } }),
        node("fresnel", "Fresnel", { inputs: { ExponentIn: pin("time") } }),
        node("time", "Time"),
      ],
      { baseColor: pin("mix") },
    );
    const { section } = await importFixture({ graph: rim, materialName: "M_Rim", props: "TwoSided = false\n", textures: [] });
    expect(section.graph).toMatchObject({ status: "baked" });
    expect(section.limitations).toContainEqual(expect.stringMatching(/^view-dependent: approximated \(Fresnel, Time\)/));
    const flat = graphOf("M_Flat", [node("c", "Constant3Vector", { constants: { Constant: [0.2, 0.3, 0.7, 1] } })], { baseColor: pin("c") });
    const plain = await importFixture({ graph: flat, materialName: "M_Flat", props: "TwoSided = false\n", textures: [] });
    expect(plain.section.graph).toMatchObject({ status: "baked" });
    expect(plain.section.limitations.some((line) => line.startsWith("view-dependent"))).toBe(false);
  });
});

describe("importer: an instance whose static switch picks a branch the flattened .mat does not list first", () => {
  /** A winter tree master: BaseColor = (IsLeaf ? T_Leaf : T_Bark), the shape of one master serving trunk, branch and leaf. */
  function treeMaster(): MaterialGraph {
    return graphOf(
      "M_Tree",
      [
        node("switch", "StaticSwitchParameter", {
          inputs: { A: pin("leaf", 0, [1, 1, 1, 0]), B: pin("bark", 0, [1, 1, 1, 0]) },
          parameter: { name: "true = leaf, false = trunk", group: "" },
          default: true,
          switchValue: true,
        }),
        node("leaf", "TextureSample", { texture: "/Game/Test/T_Leaf.T_Leaf", samplerType: "Color" }),
        node("bark", "TextureSample", { texture: "/Game/Test/T_Bark.T_Bark", samplerType: "Color" }),
      ],
      { baseColor: pin("switch") },
    );
  }
  const instance = (isLeaf: boolean): string =>
    [
      "Parent = Material3'Content/Test/M_Tree.M_Tree'",
      "BlendMode = BLEND_Opaque (0)",
      "StaticParameters =",
      "{",
      "    StaticSwitchParameters[1] =",
      "    {",
      "        StaticSwitchParameters[0] =",
      "        {",
      `            Value = ${isLeaf}`,
      "            ParameterInfo = { Name=true = leaf, false = trunk }",
      "            bOverride = true",
      "        }",
      "    }",
      "}",
    ].join("\n");
  // UE Viewer flattens every instance of the master to the first texture it meets: the bark.
  const flattened = "Diffuse=T_Bark\nOther[0]=T_Leaf\n";
  const textures: [string, [number, number, number]][] = [
    ["T_Bark", [120, 60, 30]],
    ["T_Leaf", [30, 160, 40]],
  ];

  async function bakedColour(material: { getBaseColorTexture(): { getImage(): Uint8Array | null } | null }): Promise<[number, number, number]> {
    const { data } = await sharp(material.getBaseColorTexture()!.getImage()!).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    return [data[0]!, data[1]!, data[2]!];
  }

  it("binds the branch the switch selects instead of the first texture the .mat lists", async () => {
    const { material, section } = await importFixture({ graph: treeMaster(), materialName: "MI_Leaf", props: instance(true), mat: flattened, textures });
    const [red, green] = await bakedColour(material);
    expect(green).toBeGreaterThan(red);
    expect(section.graph).toMatchObject({ status: "baked" });
    expect(section.limitations.join("\n")).toContain("T_Bark dropped as base colour");
  });

  it("keeps the .mat binding when the selected branch samples that texture (sibling)", async () => {
    const { material, section } = await importFixture({ graph: treeMaster(), materialName: "MI_Trunk", props: instance(false), mat: flattened, textures });
    const [red, green] = await bakedColour(material);
    expect(red).toBeGreaterThan(green);
    expect(section.graph).toBeUndefined();
    expect(section.limitations.join("\n")).not.toContain("dropped as base colour");
  });
});

describe("importer: a stale flattened base colour is replaced only by a successful graph bake", () => {
  const SWITCH_NAME = "leaf or trunk";
  const bark = node("bark", "TextureSample", { texture: "/Game/Test/T_Bark.T_Bark", samplerType: "Color" });
  const barkAndLeaf: [string, [number, number, number]][] = [
    ["T_Bark", [120, 60, 30]],
    ["T_Leaf", [30, 160, 40]],
  ];

  /** BaseColor = switch(A: T_Leaf, B: the `trunk` branch). The leaf branch is the switch's A pin. */
  function switchMaster(trunk: Raw[], trunkPin: string, opacityMask?: ReturnType<typeof pin>): MaterialGraph {
    return graphOf(
      "M_Switch",
      [
        node("switch", "StaticSwitchParameter", {
          inputs: { A: pin("leaf", 0, [1, 1, 1, 0]), B: pin(trunkPin, 0, [1, 1, 1, 0]) },
          parameter: { name: SWITCH_NAME, group: "" },
          default: true,
          switchValue: true,
        }),
        node("leaf", "TextureSample", { texture: "/Game/Test/T_Leaf.T_Leaf", samplerType: "Color" }),
        ...trunk,
      ],
      { baseColor: pin("switch"), ...(opacityMask ? { opacityMask } : {}) },
    );
  }

  /** An instance (or master child) that sets the switch to `value` itself, with its own parent line. */
  const switchOverride = (parent: string, value: boolean, blend = "BLEND_Opaque (0)", parentClass = "MaterialInstanceConstant"): string =>
    [
      `Parent = ${parentClass}'Content/Test/${parent}.${parent}'`,
      `BlendMode = ${blend}`,
      "StaticParameters =",
      "{",
      "    StaticSwitchParameters[1] =",
      "    {",
      "        StaticSwitchParameters[0] =",
      "        {",
      `            Value = ${value}`,
      `            ParameterInfo = { Name=${SWITCH_NAME} }`,
      "            bOverride = true",
      "        }",
      "    }",
      "}",
    ].join("\n");
  /** An instance that sets nothing itself and inherits from `parent`. */
  const inheriting = (parent: string): string => `Parent = MaterialInstanceConstant'Content/Test/${parent}.${parent}'\nBlendMode = BLEND_Opaque (0)`;

  async function colourOf(material: { getBaseColorTexture(): { getImage(): Uint8Array | null } | null }): Promise<[number, number, number]> {
    const { data } = await sharp(material.getBaseColorTexture()!.getImage()!).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    return [data[0]!, data[1]!, data[2]!];
  }

  it("follows a switch the parent instance overrides when the instance does not override it itself", async () => {
    const { material, section } = await importFixture({
      graph: switchMaster([bark], "bark"),
      materialName: "MI_Leaf",
      props: inheriting("MI_LeafParent"),
      extraProps: { MI_LeafParent: switchOverride("M_Switch", true, "BLEND_Opaque (0)", "Material3") },
      mat: "Diffuse=T_Bark\nOther[0]=T_Leaf\n",
      textures: barkAndLeaf,
    });
    const [red, green] = await colourOf(material);
    expect(green).toBeGreaterThan(red);
    expect(section.graph).toMatchObject({ status: "baked" });
    expect(section.limitations.join("\n")).toContain("T_Bark dropped as base colour");
  });

  it("lets an instance's own override beat the one its parent sets", async () => {
    const { material, section } = await importFixture({
      graph: switchMaster([bark], "bark"),
      materialName: "MI_Trunk",
      props: switchOverride("MI_LeafParent", false),
      extraProps: { MI_LeafParent: switchOverride("M_Switch", true, "BLEND_Opaque (0)", "Material3") },
      mat: "Diffuse=T_Bark\nOther[0]=T_Leaf\n",
      textures: barkAndLeaf,
    });
    const [red, green] = await colourOf(material);
    expect(red).toBeGreaterThan(green);
    expect(section.graph).toBeUndefined();
    expect(section.limitations.join("\n")).not.toContain("dropped as base colour");
  });

  it("keeps the flattened binding and says it is unverified when the selected branch cannot be baked", async () => {
    // The trunk branch runs through SmoothThreshold, an engine function whose definition is not in the pack.
    const gate = node("gate", "FunctionCall", {
      function: "/Engine/Functions/Engine_MaterialFunctions02/SmoothThreshold",
      inputs: { Input0: pin("bark", 0, [1, 1, 1, 0]) },
    });
    const { material, section } = await importFixture({
      graph: switchMaster([bark, gate], "gate"),
      materialName: "MI_Trunk",
      props: switchOverride("M_Switch", false, "BLEND_Opaque (0)", "Material3"),
      mat: "Diffuse=T_Leaf\nOther[0]=T_Bark\n",
      textures: barkAndLeaf,
    });
    expect(material.getBaseColorTexture()).not.toBeNull();
    expect(await colourOf(material)).toEqual([30, 160, 40]);
    expect(section.graph).toMatchObject({ status: "unsupported" });
    expect(section.graph?.unsupportedNodes).toContain("SmoothThreshold");
    const limitations = section.limitations.join("\n");
    expect(limitations).toContain("T_Leaf kept as base colour, unverified");
    expect(limitations).toContain("could not be baked");
    expect(limitations).not.toContain("dropped as base colour");
    expect(limitations).not.toContain("baked from the graph");
  });

  it("takes the cut-out of the selected branch from the graph when it replaces the stale binding", async () => {
    const mask = node("mask", "TextureSample", { texture: "/Game/Test/T_LeafMask.T_LeafMask", samplerType: "Masks" });
    const { material, section } = await importFixture({
      graph: switchMaster([bark, mask], "bark", pin("mask", 0, [1, 0, 0, 0])),
      materialName: "MI_Leaf",
      props: switchOverride("M_Switch", true, "BLEND_Masked (1)", "Material3"),
      mat: "Diffuse=T_Bark\nOther[0]=T_Leaf\n",
      // The mask is flat 128: the graph's own cut-out, not the flattened .mat's or a default opaque 255.
      textures: [...barkAndLeaf, ["T_LeafMask", [128, 128, 128]]],
    });
    expect(section.limitations.join("\n")).toContain("T_Bark dropped as base colour");
    expect(material.getAlphaMode()).toBe("MASK");
    const [red, green] = await colourOf(material);
    expect(green).toBeGreaterThan(red);
    expect(await embeddedAlpha(material)).toEqual([128, 128]);
  });

  it("replaces the flattened albedo and its opacity when an inherited switch selects a leaf whose albedo shares the opacity's name", async () => {
    // Diffuse=T_Bark and Opacity=T_Leaf; the switch the parent sets picks the leaf branch, whose albedo is T_Leaf too. That name is
    // the opacity's, so it is no evidence the flattened albedo is right: a successful bake replaces both.
    const mask = node("mask", "TextureSample", { texture: "/Game/Test/T_LeafMask.T_LeafMask", samplerType: "Masks" });
    const { material, section } = await importFixture({
      graph: switchMaster([bark, mask], "bark", pin("mask", 0, [1, 0, 0, 0])),
      materialName: "MI_Leaf",
      props: "Parent = MaterialInstanceConstant'Content/Test/MI_LeafParent.MI_LeafParent'",
      extraProps: { MI_LeafParent: switchOverride("M_Switch", true, "BLEND_Masked (1)", "Material3") },
      mat: "Diffuse=T_Bark\nOpacity=T_Leaf\n",
      textures: [...barkAndLeaf, ["T_LeafMask", [128, 128, 128]]],
    });
    expect(section.limitations.join("\n")).toContain("T_Bark dropped as base colour");
    expect(section.graph).toMatchObject({ status: "baked" });
    expect(material.getAlphaMode()).toBe("MASK");
    const [red, green] = await colourOf(material);
    expect(green).toBeGreaterThan(red);
    // The graph's own cut-out (flat 128), not the flattened opacity's red (T_Leaf's red is 30).
    expect(await embeddedAlpha(material)).toEqual([128, 128]);
  });
});
