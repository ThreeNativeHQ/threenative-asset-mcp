import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeIO } from "@gltf-transform/core";
import sharp from "sharp";
import { describe, expect, it, onTestFinished } from "vitest";

import { createGraphBaker } from "../src/unreal/graph-baker.js";
import { materialGraphSchema, type MaterialGraph } from "../src/unreal/graph-dump.js";
import { importUnrealDirectory, type ImportedMaterialSection, type ImportedModel, type ImportReport } from "../src/unreal/importer.js";
import { bakeGraph, emissiveOnlyEffect, particleDrivenBaseColor, type GraphParameters, type TextureRaster } from "../src/unreal/material-graph.js";
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

function graphOf(material: string, nodes: Raw[], outputs: { baseColor?: ReturnType<typeof pin>; emissive?: ReturnType<typeof pin> }): MaterialGraph {
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
      opacityMask: null,
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
  });
  for (const [name, rgb] of options.textures) await writePng(join(exported, `${name}.png`), [...rgb, 255], 4);
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

  it("claims nothing when the mesh package does not name the engine default material", async () => {
    const { section, report } = await leaf("/Game/Test/SomeOtherMaterial");
    expect(section.resolved).toBe(false);
    expect(section.effect).toBeUndefined();
    expect(report.materialCoverage.effect).toBe(0);
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
