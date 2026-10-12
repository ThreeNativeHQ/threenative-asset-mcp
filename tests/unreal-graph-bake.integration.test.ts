import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Document, NodeIO } from "@gltf-transform/core";
import sharp from "sharp";
import { describe, expect, it, onTestFinished } from "vitest";

import { chainParameters, createGraphBaker, directVertexColorGraph, graphNamed, parametersKey, type GraphBakeOutcome } from "../src/unreal/graph-baker.js";
import { canonicalEngineReference } from "../src/unreal/engine-content.js";
import { parsePropsFile } from "../src/unreal/materials.js";
import { materialGraphSchema, type MaterialGraph } from "../src/unreal/graph-dump.js";
import { importUnrealDirectory, packageGlb, type ImportReport } from "../src/unreal/importer.js";
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

function masterGraph(
  kind: "mask-tint" | "vertex-color" = "mask-tint",
  defaultTexture = "T_MasterMask",
  where: { readonly package?: string; readonly tint?: number[] } = {},
): MaterialGraph {
  const nodes: Raw[] =
    kind === "mask-tint"
      ? [
          node("mask", "TextureSampleParameter2D", {
            parameter: { name: "Mask", group: "" },
            default: null,
            texture: `/Game/Test/${defaultTexture}.${defaultTexture}`,
            samplerType: "Masks",
          }),
          node("tint", "Constant3Vector", { constants: { Constant: where.tint ?? [0.5, 0.25, 1, 1] } }),
          node("mul", "Multiply", { inputs: { A: pin("mask", [1, 1, 1, 0]), B: pin("tint") } }),
        ]
      : [
          node("vertex", "VertexColor"),
          node("tint", "Constant3Vector", { constants: { Constant: where.tint ?? [0.5, 0.25, 1, 1] } }),
          node("mul", "Multiply", { inputs: { A: pin("vertex", [1, 1, 1, 0]), B: pin("tint") } }),
        ];
  return materialGraphSchema.parse({
    format: 1,
    material: "M_Master",
    package: where.package ?? "/Game/Test/M_Master",
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

// BaseColor = lerp(tan, moss, WorldAlignedBlend."w/Vertex Normals"), the cliff-rock master's moss overlay in miniature.
function moss(): MaterialGraph {
  return materialGraphSchema.parse({
    format: 1,
    material: "M_Master",
    package: "/Game/Test/M_Master",
    truncated: false,
    nodeCount: 5,
    outputs: { baseColor: pin("mix"), roughness: null, metallic: null, emissive: null, opacity: null, opacityMask: null, normal: null, materialAttributes: null },
    nodes: [
      node("mix", "LinearInterpolate", { inputs: { A: pin("tan"), B: pin("moss"), Alpha: { node: "wab", output: 1, mask: null } } }),
      node("tan", "Constant3Vector", { constants: { Constant: [0.6, 0.5, 0.3, 1] } }),
      node("moss", "Constant3Vector", { constants: { Constant: [0.1, 0.3, 0.05, 1] } }),
      node("wab", "FunctionCall", {
        inputs: { Input2: pin("sharp"), Input3: pin("bias") },
        function: "/Engine/Functions/Engine_MaterialFunctions01/AlphaBlend/WorldAlignedBlend.WorldAlignedBlend",
        outputNames: ["Alpha", "w/Vertex Normals", "w/ Explicit Normal"],
        fn: { inputs: { Input2: "sharp", Input3: "bias" }, outputs: [], output: null },
        error: "material function could not be loaded (engine content is not in the pack)",
      }),
      node("sharp", "Constant", { constants: { R: 10 } }),
      node("bias", "Constant", { constants: { R: -2 } }),
    ],
  });
}

const instanceProps = (
  parent: string,
  overrides: [string, string][],
  extras: { scalars?: [string, number][] | undefined; vectors?: [string, [number, number, number, number]][] | undefined } = {},
): string =>
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
    ...(extras.scalars ?? []).flatMap(([name, value], index) => [
      `ScalarParameterValues[${index}] =`,
      "{",
      `    ParameterInfo = { Name=${name} }`,
      `    ParameterValue = ${value}`,
      "}",
    ]),
    ...(extras.vectors ?? []).flatMap(([name, value], index) => [
      `VectorParameterValues[${index}] =`,
      "{",
      `    ParameterInfo = { Name=${name} }`,
      `    ParameterValue = { R=${value[0]}, G=${value[1]}, B=${value[2]}, A=${value[3]} }`,
      "}",
    ]),
  ].join("\n");

const encode = (unit: number): number => {
  const value = Math.min(1, Math.max(0, unit));
  return Math.round((value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055) * 255);
};

// BaseColor = VertexColor.RGB exactly (the Hornbeam icon master's proven composition): the mesh's COLOR_0 is the colour
// and the graph adds nothing, so a white residual factor reproduces Unreal when glTF multiplies COLOR_0 in.
function vertexColorDirect(materialName = "M_Master", mask: number[] | null = [1, 1, 1, 0]): MaterialGraph {
  return materialGraphSchema.parse({
    format: 1,
    material: materialName,
    package: `/Game/Test/${materialName}`,
    truncated: false,
    nodeCount: 2,
    outputs: {
      baseColor: { node: "vertex", output: 0, mask },
      roughness: pin("rough"),
      metallic: null,
      emissive: null,
      opacity: null,
      opacityMask: null,
      normal: null,
      materialAttributes: null,
    },
    nodes: [node("vertex", "VertexColor"), node("rough", "Constant", { constants: { R: 0 } })],
  });
}

// Any use that is not the exact direct RGB selection: a component swizzle, an arithmetic combination, or an opacity path.
function vertexColorSwizzled(): MaterialGraph {
  return materialGraphSchema.parse({
    format: 1,
    material: "M_Master",
    package: "/Game/Test/M_Master",
    truncated: false,
    nodeCount: 3,
    outputs: {
      baseColor: { node: "swizzle", output: 0, mask: null },
      roughness: null,
      metallic: null,
      emissive: null,
      opacity: null,
      opacityMask: null,
      normal: null,
      materialAttributes: null,
    },
    nodes: [
      node("vertex", "VertexColor"),
      node("swizzle", "ComponentMask", { inputs: { Input: pin("vertex", [1, 1, 1, 0]) }, channelMask: [0, 1, 0, 0] }),
    ],
  });
}

function vertexColorWithOpacity(): MaterialGraph {
  const graph = vertexColorDirect();
  return materialGraphSchema.parse({ ...graph, outputs: { ...graph.outputs, opacity: pin("opaque") }, nodes: [...graph.nodes, node("opaque", "Constant", { constants: { R: 1 } })] });
}

const ATTRIBUTE_OUTPUTS = ["BaseColor", "Metallic", "Specular", "Roughness", "EmissiveColor", "Opacity", "OpacityMask", "Normal"];
const ROUGHNESS = 3;
const OPACITY_MASK = 6;
const output = (nodeId: string, index: number, mask: number[] | null = null) => ({ node: nodeId, output: index, mask });
const breakOf = (id: string, source: string): Raw => node(id, "BreakMaterialAttributes", { inputs: { MaterialAttributes: pin(source) }, outputNames: ATTRIBUTE_OUTPUTS });
const make = (id: string, baseColor: string, overrides: Raw = {}): Raw => node(id, "MakeMaterialAttributes", { inputs: { BaseColor: pin(baseColor), ...overrides } });
const switchOf = (id: string, a: string, b: string, name: string): Raw => node(id, "StaticSwitchParameter", { inputs: { A: pin(a), B: pin(b) }, parameter: { name, group: "" }, default: true });
const unboundTexture = (id: string): Raw => node(id, "TextureSampleParameter2D", { parameter: { name: "BaseTexture", group: "Base" }, default: null, texture: null, samplerType: "Color" });
const textured = (id: string, texture: string, samplerType = "Color"): Raw => node(id, "TextureSample", { texture: `/Game/Test/${texture}.${texture}`, samplerType });
const scalar = (id: string, value: number): Raw => node(id, "Constant", { constants: { R: value } });
const constant3 = (id: string, rgb: number[]): Raw => node(id, "Constant3Vector", { constants: { Constant: [...rgb, 1].slice(0, 4) } });

// Outer switch A reads the inner switch's BaseColor (unbound on inner A, so outer flips to B); outer B reads the inner
// Roughness (bound on both), so it flips back to A. The two choices alternate forever: the switch set never settles.
function cyclingSwitchGraph(): MaterialGraph {
  const nodes: Raw[] = [
    breakOf("reader", "outer"),
    switchOf("outer", "makeA", "makeB", "UseOuter"),
    make("makeA", "innerBreak"),
    make("makeB", "innerRoughColour"),
    breakOf("innerBreak", "inner"),
    node("innerRoughColour", "Multiply", { inputs: { A: output("innerBreak", ROUGHNESS), B: pin("white") } }),
    switchOf("inner", "innerA", "innerB", "UseInner"),
    make("innerA", "unbound", { Roughness: pin("roughA") }),
    make("innerB", "white", { Roughness: pin("roughB") }),
    scalar("roughA", 0.2),
    scalar("roughB", 0.8),
    unboundTexture("unbound"),
    constant3("white", [1, 1, 1]),
  ];
  return materialGraphSchema.parse({
    format: 1,
    material: "M_Master",
    package: "/Game/Test/M_Master",
    truncated: false,
    nodeCount: nodes.length,
    outputs: { baseColor: output("reader", 0), roughness: null, metallic: null, emissive: null, opacity: null, opacityMask: null, normal: null, materialAttributes: null },
    nodes,
  });
}

// One switch read by both the colour and the cut-out. Branch A's OpacityMask is unbound, so on its own the colour keeps
// A (bound) while the cut-out flips to B; the union flips to B, so the cut-out's alpha picks the BaseColor branch.
// `vertexOnB` puts the VertexColor node on B's BaseColor path, so the probe's class report flips with the alpha too.
function alphaSharedSwitchGraph(vertexOnB: boolean): MaterialGraph {
  const good = textured("good", "T_InstanceMask");
  const alt = textured("alt", "T_MasterMask");
  const mixB: Raw = node("mixB", "Multiply", { inputs: { A: pin("alt", [1, 1, 1, 0]), B: vertexOnB ? pin("vertex", [1, 1, 1, 0]) : pin("tint", [1, 1, 1, 0]) } });
  const nodes: Raw[] = [
    breakOf("reader", "sw"),
    node("sw", "StaticSwitchParameter", { inputs: { A: pin("makeA"), B: pin("makeB") }, parameter: { name: "UseA", group: "" }, default: true }),
    node("makeA", "MakeMaterialAttributes", { inputs: { BaseColor: pin("good", [1, 1, 1, 0]), OpacityMask: pin("badMask", [1, 0, 0, 0]) } }),
    node("makeB", "MakeMaterialAttributes", { inputs: { BaseColor: pin("mixB", [1, 1, 1, 0]), OpacityMask: pin("goodMask", [1, 0, 0, 0]) } }),
    good,
    alt,
    mixB,
    constant3("tint", [1, 1, 1]),
    node("vertex", "VertexColor"),
    textured("goodMask", "T_MasterMask", "LinearColor"),
    node("badMask", "TextureSampleParameter2D", { parameter: { name: "Unbound", group: "Base" }, default: null, texture: null, samplerType: "LinearColor" }),
  ];
  return materialGraphSchema.parse({
    format: 1,
    material: "M_Master",
    package: "/Game/Test/M_Master",
    truncated: false,
    nodeCount: nodes.length,
    outputs: {
      baseColor: output("reader", 0, [1, 1, 1, 0]),
      roughness: null,
      metallic: null,
      emissive: null,
      opacity: null,
      opacityMask: output("reader", OPACITY_MASK, [1, 0, 0, 0]),
      normal: null,
      materialAttributes: null,
    },
    nodes,
  });
}


function vertexColorWithAttributes(): MaterialGraph {
  const graph = vertexColorDirect();
  return materialGraphSchema.parse({
    ...graph,
    outputs: { ...graph.outputs, materialAttributes: pin("attrs") },
    nodes: [...graph.nodes,
      node("attrs", "MakeMaterialAttributes", { inputs: { BaseColor: pin("otherColour"), Roughness: pin("otherRoughness") } }),
      node("otherColour", "Constant3Vector", { constants: { Constant: [1, 0, 0, 1] } }),
      node("otherRoughness", "Constant", { constants: { R: 0.7 } }),
    ],
  });
}

// The direct VertexColor graph with Roughness and Metallic wired to the given pins (absent: unconnected) and the extra nodes they reach.
function vertexColorScalars(outputs: { roughness?: Raw | null; metallic?: Raw | null }, nodes: Raw[] = []): MaterialGraph {
  return materialGraphSchema.parse({
    format: 1,
    material: "M_Master",
    package: "/Game/Test/M_Master",
    truncated: false,
    nodeCount: nodes.length + 1,
    outputs: {
      baseColor: { node: "vertex", output: 0, mask: [1, 1, 1, 0] },
      roughness: outputs.roughness ?? null,
      metallic: outputs.metallic ?? null,
      emissive: null,
      opacity: null,
      opacityMask: null,
      normal: null,
      materialAttributes: null,
    },
    nodes: [node("vertex", "VertexColor"), ...nodes],
  });
}

async function firstPixel(png: Buffer | Uint8Array): Promise<number[]> {
  const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return [...data.subarray(0, 3)];
}

describe("chainParameters over modern-converter props", () => {
  const collected = (parent: string | undefined, entries: [string, string][]): string =>
    [
      ...(parent ? [`Parent = Material'${parent}.${parent}'`] : []),
      `CollectedTextureParameters[${entries.length}] =`,
      "{",
      ...entries.flatMap(([name, texture], index) => [
        `    CollectedTextureParameters[${index}] =`,
        "    {",
        `        Texture = Texture2D'/Game/Test/${texture}.${texture}'`,
        `        Name = ${name}`,
        "        Group = None",
        "    }",
      ]),
      "}",
    ].join("\n");

  it("the instance's collected block is its override and beats the parent's collected default", () => {
    const instance = parsePropsFile(collected("M_Master", [["Color", "T_Own"]]));
    const master = parsePropsFile(collected(undefined, [["Color", "T_Default"], ["Mask", "T_Mask"]]));
    const parameters = chainParameters([instance, master]);
    expect(parameters.textures.get("color")).toBe("T_Own");
    expect(parameters.textures.get("mask")).toBe("T_Mask");
  });
});

describe("chainParameters over UE Viewer static switch overrides", () => {
  const switches = (parent: string | undefined, entries: [string, boolean, boolean][]): string =>
    [
      ...(parent ? [`Parent = MaterialInstanceConstant'${parent}.${parent}'`] : []),
      "StaticParameters =",
      "{",
      `    StaticSwitchParameters[${entries.length}] =`,
      "    {",
      ...entries.flatMap(([name, value, overridden], index) => [
        `        StaticSwitchParameters[${index}] =`,
        "        {",
        `            Value = ${value}`,
        `            ParameterInfo = { Name=${name} }`,
        `            bOverride = ${overridden}`,
        "        }",
      ]),
      "    }",
      "}",
    ].join("\n");

  it("reads an instance's overridden switches and the nearest level wins", () => {
    const instance = parsePropsFile(switches("MI_Parent", [["Split Albedo Controls", true, true], ["Winter", false, true]]));
    const parent = parsePropsFile(switches(undefined, [["Split Albedo Controls", false, true], ["Seasons", true, true]]));
    const parameters = chainParameters([instance, parent]);
    expect(parameters.switches.get("split albedo controls")).toBe(true);
    expect(parameters.switches.get("winter")).toBe(false);
    expect(parameters.switches.get("seasons")).toBe(true);
  });

  it("ignores an entry the instance lists without overriding it", () => {
    const instance = parsePropsFile(switches(undefined, [["Split Albedo Controls", true, false]]));
    expect(chainParameters([instance]).switches.has("split albedo controls")).toBe(false);
  });
});

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

  it("takes the master the Parent line names when two packages hold a master of the same name", async () => {
    // Landscape Pro: RocksCliff/ and RocksMedium/ both hold M_cliffrock01_material, and they are different graphs
    // (the Medium one blends moss). The dump keys the first by name and the second by package, so a lookup by name
    // always returned the Cliff graph for a Medium rock.
    const { sourceDir, assets } = await fixture();
    const cliff = masterGraph("mask-tint", "T_MasterMask", { package: "/Game/Test/Cliff/M_Master", tint: [1, 1, 1, 1] });
    const medium = masterGraph("mask-tint", "T_MasterMask", { package: "/Game/Test/Medium/M_Master", tint: [0.5, 0.25, 1, 1] });
    const dump = async () => new Map([["M_Master", cliff], ["/Game/Test/Medium/M_Master", medium]]);
    const props: Record<string, string> = {
      MI_Rock: instanceProps("M_Master", [["Mask", "T_InstanceMask"]]).replace("Content/Test/M_Master.M_Master", "Content/Test/Medium/M_Master.M_Master"),
      MI_Cliff: instanceProps("M_Master", [["Mask", "T_InstanceMask"]]).replace("Content/Test/M_Master.M_Master", "Content/Test/Cliff/M_Master.M_Master"),
      MI_Bare: instanceProps("M_Master", [["Mask", "T_InstanceMask"]]),
    };
    for (const name of ["MI_Cliff", "MI_Bare"]) await writeFile(join(sourceDir, "Content", "Test", `${name}.uasset`), Buffer.alloc(16));
    const baker = createGraphBaker({ sourceDir, maxTextureSize: 8, dumpGraphs: dump })!;
    const readProps = (name: string): string | undefined => props[name];
    const rock = await baker({ materialName: "s", lookupName: "MI_Rock", assets, readProps });
    if (rock.status !== "baked") throw new Error(`expected a bake, got ${JSON.stringify(rock)}`);
    expect(await firstPixel(rock.png)).toEqual([encode((200 / 255) * 0.5), encode((100 / 255) * 0.25), encode(50 / 255)]);
    const cliffBake = await baker({ materialName: "s", lookupName: "MI_Cliff", assets, readProps });
    if (cliffBake.status !== "baked") throw new Error(`expected a bake, got ${JSON.stringify(cliffBake)}`);
    expect(await firstPixel(cliffBake.png)).toEqual([encode(200 / 255), encode(100 / 255), encode(50 / 255)]);
    // A reference that names no directory keeps the by-name pick (the first graph).
    const bare = await baker({ materialName: "s", lookupName: "MI_Bare", assets, readProps: (name) => (name === "MI_Bare" ? props.MI_Bare!.replace(/Content\/Test\//, "") : undefined) });
    if (bare.status !== "baked") throw new Error(`expected a bake, got ${JSON.stringify(bare)}`);
    expect(await firstPixel(bare.png)).toEqual([encode(200 / 255), encode(100 / 255), encode(50 / 255)]);
  });

  it("builds the surface map only for a graph that reads it, and bakes a separate texture per surface", async () => {
    const { sourceDir, assets, readProps } = await fixture();
    const aligned = moss();
    const surfaceOf = (normal: number[]) => ({ width: 2, height: 2, normals: new Float32Array(12).map((_, index) => normal[index % 3]!), covered: 4 });
    let builds = 0;
    const baker = createGraphBaker({ sourceDir, maxTextureSize: 4, dumpGraphs: async () => new Map([["M_Master", aligned]]) })!;
    const up = await baker({ materialName: "s", lookupName: "MI_Rock", assets, readProps, surface: () => (builds++, surfaceOf([0, 1, 0])) });
    const side = await baker({ materialName: "s", lookupName: "MI_Rock", assets, readProps, surface: () => (builds++, surfaceOf([1, 0, 0])) });
    const upAgain = await baker({ materialName: "s", lookupName: "MI_Rock", assets, readProps, surface: () => (builds++, surfaceOf([0, 1, 0])) });
    if (up.status !== "baked" || side.status !== "baked") throw new Error("expected bakes");
    expect(await firstPixel(up.png)).toEqual([encode(0.1), encode(0.3), encode(0.05)]);
    expect(await firstPixel(side.png)).toEqual([encode(0.6), encode(0.5), encode(0.3)]);
    expect(upAgain).toBe(up);
    expect(builds).toBe(3);

    // A graph that does not read the surface never asks for it and keeps one shared bake.
    const plain = createGraphBaker({ sourceDir, maxTextureSize: 8, dumpGraphs: async () => new Map([["M_Master", masterGraph()]]) })!;
    const never = () => {
      throw new Error("the surface map was built for a graph that does not read it");
    };
    const first = await plain({ materialName: "s", lookupName: "MI_Rock", assets, readProps, surface: never });
    const second = await plain({ materialName: "s2", lookupName: "MI_Rock", assets, readProps, surface: never });
    expect(first.status).toBe("baked");
    expect(second).toBe(first);
  });

  it("hands a VertexNormalWS graph the surface and an ObjectRadius graph the mesh radius, baking per value", async () => {
    const { sourceDir, assets, readProps } = await fixture();
    const graph = (nodes: Raw[]) =>
      materialGraphSchema.parse({
        format: 1,
        material: "M_Master",
        package: "/Game/Test/M_Master",
        truncated: false,
        nodeCount: nodes.length,
        outputs: { baseColor: pin("out"), roughness: null, metallic: null, emissive: null, opacity: null, opacityMask: null, normal: null, materialAttributes: null },
        nodes,
      });
    // BaseColor = abs(VertexNormalWS.z): white on an up-facing surface, black on a side-facing one.
    const upness = graph([node("out", "Abs", { inputs: { Input: pin("z") } }), node("z", "ComponentMask", { inputs: { Input: pin("n") }, channelMask: [0, 0, 1, 0] }), node("n", "VertexNormalWS")]);
    const surfaceOf = (normal: number[]) => ({ width: 2, height: 2, normals: new Float32Array(12).map((_, index) => normal[index % 3]!), covered: 4 });
    const normals = createGraphBaker({ sourceDir, maxTextureSize: 4, dumpGraphs: async () => new Map([["M_Master", upness]]) })!;
    const up = await normals({ materialName: "s", lookupName: "MI_Rock", assets, readProps, surface: () => surfaceOf([0, 1, 0]) });
    const side = await normals({ materialName: "s", lookupName: "MI_Rock", assets, readProps, surface: () => surfaceOf([1, 0, 0]) });
    if (up.status !== "baked" || side.status !== "baked") throw new Error(`expected bakes, got ${up.status} and ${side.status}`);
    expect(await firstPixel(up.png)).toEqual([255, 255, 255]);
    expect(await firstPixel(side.png)).toEqual([0, 0, 0]);

    // BaseColor = ObjectRadius / 1000: radius 500 cm is 0.5, radius 250 cm is 0.25; the radius is asked only by this graph.
    const radius = graph([node("out", "Divide", { inputs: { A: pin("r") }, constants: { ConstB: 1000 } }), node("r", "ObjectRadius")]);
    let asked = 0;
    const sized = createGraphBaker({ sourceDir, maxTextureSize: 4, dumpGraphs: async () => new Map([["M_Master", radius]]) })!;
    const large = await sized({ materialName: "s", lookupName: "MI_Rock", assets, readProps, objectRadius: () => (asked++, 500) });
    const small = await sized({ materialName: "s", lookupName: "MI_Rock", assets, readProps, objectRadius: () => (asked++, 250) });
    if (large.status !== "baked" || small.status !== "baked") throw new Error(`expected bakes, got ${large.status} and ${small.status}`);
    expect(await firstPixel(large.png)).toEqual([encode(0.5), encode(0.5), encode(0.5)]);
    expect(await firstPixel(small.png)).toEqual([encode(0.25), encode(0.25), encode(0.25)]);
    expect(asked).toBe(2);
    const plain = createGraphBaker({ sourceDir, maxTextureSize: 4, dumpGraphs: async () => new Map([["M_Master", masterGraph()]]) })!;
    expect((await plain({ materialName: "s", lookupName: "MI_Rock", assets, readProps, objectRadius: () => { throw new Error("radius asked for a graph that does not read it"); } })).status).toBe("baked");
  });

  it("probes the BaseColor textures of a readable path only, never those a partial compile reaches past an unsupported node", async () => {
    const { sourceDir, assets, readProps } = await fixture();
    // BaseColor = mask x SmoothThreshold(mask): the SmoothThreshold function has no body in the pack, so the bake cannot run.
    const blocked = materialGraphSchema.parse({
      format: 1,
      material: "M_Master",
      package: "/Game/Test/M_Master",
      truncated: false,
      nodeCount: 3,
      outputs: { baseColor: pin("mul", [1, 1, 1, 0]), roughness: null, metallic: null, emissive: null, opacity: null, opacityMask: null, normal: null, materialAttributes: null },
      nodes: [
        node("mask", "TextureSampleParameter2D", { parameter: { name: "Mask", group: "" }, default: null, texture: "/Game/Test/T_MasterMask.T_MasterMask", samplerType: "Masks" }),
        node("gate", "FunctionCall", { function: "/Engine/Functions/Engine_MaterialFunctions02/SmoothThreshold", inputs: { Input0: pin("mask", [1, 1, 1, 0]) } }),
        node("mul", "Multiply", { inputs: { A: pin("mask", [1, 1, 1, 0]), B: pin("gate") } }),
      ],
    });
    const probeBlocked = createGraphBaker({ sourceDir, dumpGraphs: async () => new Map([["M_Master", blocked]]) })!;
    const blockedOutcome = await probeBlocked({ materialName: "MI_Rock", lookupName: "MI_Rock", assets, readProps, probe: true });
    expect(blockedOutcome.baseColourTextures).toBeUndefined();

    const probeReadable = createGraphBaker({ sourceDir, dumpGraphs: async () => new Map([["M_Master", masterGraph()]]) })!;
    const readableOutcome = await probeReadable({ materialName: "MI_Rock", lookupName: "MI_Rock", assets, readProps, probe: true });
    expect(readableOutcome.baseColourTextures).toEqual(["T_InstanceMask"]);
  });

  it("omits vertexColorOnBaseColor on a probe whose switch choices never settle, rather than claim it does not read VertexColor", async () => {
    const { sourceDir, assets, readProps } = await fixture();
    const cycle = createGraphBaker({ sourceDir, dumpGraphs: async () => new Map([["M_Master", cyclingSwitchGraph()]]) })!;
    const outcome = await cycle({ materialName: "MI_Rock_s", lookupName: "MI_Rock", assets, readProps, probe: true });
    expect(outcome.status).toBe("unavailable");
    // The active path describes no bake, so the probe must not say `false`: the importer would drop the mesh's COLOR_0.
    expect(outcome.vertexColorOnBaseColor).toBeUndefined();
    expect(outcome.baseColourTextures).toBeUndefined();
  });

  it("settles a shared switch with the requested cut-out, so the probe names the BaseColor branch the bake samples", async () => {
    const { sourceDir, assets, readProps } = await fixture();
    const graph = alphaSharedSwitchGraph(false);
    const make = (it: MaterialGraph) => createGraphBaker({ sourceDir, maxTextureSize: 4, dumpGraphs: async () => new Map([["M_Master", it]]) })!;

    // Cache-catch order: the masked probe first, the opaque one second on the same asset index. A path cache keyed
    // without the alpha would hand the opaque probe the masked branch's texture.
    const maskedFirst = make(graph);
    const masked = await maskedFirst({ materialName: "s", lookupName: "MI_Rock", assets, readProps, probe: true, alpha: "opacityMask" });
    expect(masked.baseColourTextures).toEqual(["T_MasterMask"]);
    const opaque = await maskedFirst({ materialName: "s", lookupName: "MI_Rock", assets, readProps, probe: true });
    expect(opaque.baseColourTextures).toEqual(["T_InstanceMask"]);

    // The other order on a fresh baker proves the key carries the alpha, not just the first probe that filled it.
    const opaqueFirst = make(graph);
    expect((await opaqueFirst({ materialName: "s", lookupName: "MI_Rock", assets, readProps, probe: true })).baseColourTextures).toEqual(["T_InstanceMask"]);
    expect((await opaqueFirst({ materialName: "s", lookupName: "MI_Rock", assets, readProps, probe: true, alpha: "opacityMask" })).baseColourTextures).toEqual(["T_MasterMask"]);

    // The bake of each alpha samples the same texture the probe named for it.
    const maskedBake = await maskedFirst({ materialName: "s", lookupName: "MI_Rock", assets, readProps, alpha: "opacityMask" });
    if (maskedBake.status !== "baked") throw new Error(`expected a bake, got ${maskedBake.status}`);
    expect(maskedBake.texturesUsed).toEqual(["T_MasterMask"]);
    const opaqueBake = await maskedFirst({ materialName: "s", lookupName: "MI_Rock", assets, readProps });
    if (opaqueBake.status !== "baked") throw new Error(`expected a bake, got ${opaqueBake.status}`);
    expect(opaqueBake.texturesUsed).toEqual(["T_InstanceMask"]);
  });

  it("changes the active BaseColor classes with the cut-out, so the probe's VertexColor report follows the bake's branch", async () => {
    const { sourceDir, assets, readProps } = await fixture();
    const baker = createGraphBaker({ sourceDir, maxTextureSize: 4, dumpGraphs: async () => new Map([["M_Master", alphaSharedSwitchGraph(true)]]) })!;

    // With the cut-out the union flips the switch to B, whose BaseColor reads VertexColor: the probe keeps the class even
    // though the probe compile cannot evaluate VertexColor, and names no textures (the existing, preserved contract).
    const masked = await baker({ materialName: "s", lookupName: "MI_Rock", assets, readProps, probe: true, alpha: "opacityMask" });
    expect(masked.vertexColorOnBaseColor).toBe(true);
    expect(masked.baseColourTextures).toBeUndefined();

    const opaque = await baker({ materialName: "s", lookupName: "MI_Rock", assets, readProps, probe: true });
    expect(opaque.vertexColorOnBaseColor).toBe(false);
    expect(opaque.baseColourTextures).toEqual(["T_InstanceMask"]);

    // The bake takes the same branch: with the cut-out B (T_MasterMask and VertexColor), without it A.
    const maskedBake = await baker({ materialName: "s", lookupName: "MI_Rock", assets, readProps, alpha: "opacityMask", vertexColor: [1, 1, 1, 1] });
    if (maskedBake.status !== "baked") throw new Error(`expected a bake, got ${maskedBake.status}`);
    expect(maskedBake.texturesUsed).toEqual(["T_MasterMask"]);
    const opaqueBake = await baker({ materialName: "s", lookupName: "MI_Rock", assets, readProps });
    if (opaqueBake.status !== "baked") throw new Error(`expected a bake, got ${opaqueBake.status}`);
    expect(opaqueBake.texturesUsed).toEqual(["T_InstanceMask"]);
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

  it("bakes the good materials and marks only the unreadable one unavailable, with its reason", async () => {
    const { sourceDir, assets, readProps } = await fixture();
    // The package list is read once, so the broken material's package must exist before the first request.
    await writeFile(join(sourceDir, "Content", "Test", "M_Broken.uasset"), Buffer.alloc(16));
    const baker = createGraphBaker({
      sourceDir,
      maxTextureSize: 8,
      dumpGraphs: async () =>
        Object.assign(new Map([["M_Master", masterGraph()]]), {
          invalid: new Map([["M_Broken", "nodes[12].inputs.A.output: expected number, received null"]]),
        }),
    })!;
    const good = await baker({ materialName: "MI_Rock_section", lookupName: "MI_Rock", assets, readProps });
    expect(good.status).toBe("baked");
    const broken = await baker({ materialName: "M_Broken_section", lookupName: "M_Broken", assets, readProps });
    expect(broken).toMatchObject({
      status: "unavailable",
      reason: "graph for M_Broken unreadable (nodes[12].inputs.A.output: expected number, received null)",
    });
  });

  it("a parent whose graph is unreadable makes the instance unavailable, naming the parent", async () => {
    const { sourceDir, assets, readProps } = await fixture();
    const baker = createGraphBaker({
      sourceDir,
      dumpGraphs: async () => Object.assign(new Map<string, MaterialGraph>(), { invalid: new Map([["M_Master", "nodes[0].class: expected string, received undefined"]]) }),
    })!;
    const outcome = await baker({ materialName: "MI_Rock_section", lookupName: "MI_Rock", assets, readProps });
    expect(outcome).toMatchObject({ status: "unavailable" });
    expect(outcome.status === "unavailable" && outcome.reason).toBe("graph for M_Master unreadable (nodes[0].class: expected string, received undefined)");
  });

  it("an all-invalid dump yields unavailable per section and never throws", async () => {
    const { sourceDir, assets, readProps } = await fixture();
    let dumps = 0;
    const baker = createGraphBaker({
      sourceDir,
      dumpGraphs: async () => {
        dumps += 1;
        return Object.assign(new Map<string, MaterialGraph>(), { invalid: new Map([["M_Master", "format: expected 1"]]) });
      },
    })!;
    for (const name of ["MI_Rock", "M_Master"]) {
      const outcome = await baker({ materialName: `${name}_s`, lookupName: name, assets, readProps });
      expect(outcome.status).toBe("unavailable");
      expect(outcome.status === "unavailable" && outcome.reason).toContain("unreadable (format: expected 1)");
    }
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

  it("bakes a neutral residual for a flagged exact VertexColor graph and keeps the colour out of the PNG", async () => {
    const { sourceDir, assets, readProps } = await fixture();
    const baker = createGraphBaker({
      sourceDir,
      maxTextureSize: 8,
      dumpGraphs: async () => new Map([["M_Master", vertexColorDirect()]]),
    })!;
    const request = { materialName: "MI_Rock_s", lookupName: "MI_Rock", assets, readProps };
    const flagged = await baker({ ...request, directVertexColor: true });
    expect(flagged.status).toBe("baked");
    expect(flagged.status === "baked" && flagged.vertexColorResidual).toBe(true);
    expect(flagged.status === "baked" && flagged.confidence).toBe("exact");
    expect(await firstPixel(flagged.status === "baked" ? flagged.png : Buffer.alloc(4))).toEqual([255, 255, 255]);
    // The same assets and parameters asked without the guarantee flag is a different result under a different cache key.
    const unflagged = await baker(request);
    expect(unflagged.status).toBe("unsupported");
  });

  it("accepts a null output-0 mask but rejects every other VertexColor use", () => {
    expect(directVertexColorGraph(vertexColorDirect("M_Master", null))).toBe(true);
    expect(directVertexColorGraph(vertexColorDirect())).toBe(true);
    expect(directVertexColorGraph(vertexColorSwizzled())).toBe(false);
    expect(directVertexColorGraph(masterGraph("vertex-color"))).toBe(false);
    expect(directVertexColorGraph(vertexColorWithOpacity())).toBe(false);
    expect(directVertexColorGraph(vertexColorWithAttributes())).toBe(false);
    expect(directVertexColorGraph({ ...vertexColorDirect(), truncated: true })).toBe(false);
    expect(directVertexColorGraph({ ...vertexColorDirect(), error: "unreadable" })).toBe(false);
    const outputs = { ...vertexColorDirect().outputs, baseColor: { node: "vertex", output: 1, mask: null } };
    expect(directVertexColorGraph({ ...vertexColorDirect(), outputs })).toBe(false);
  });

  it("never lowers a swizzle, arithmetic or opacity VertexColor graph even when the flag is set", async () => {
    const { sourceDir, assets, readProps } = await fixture();
    for (const graph of [vertexColorSwizzled(), masterGraph("vertex-color"), vertexColorWithOpacity(), vertexColorWithAttributes()]) {
      const baker = createGraphBaker({ sourceDir, maxTextureSize: 8, dumpGraphs: async () => new Map([["M_Master", graph]]) })!;
      const outcome = await baker({ materialName: "MI_Rock_s", lookupName: "MI_Rock", assets, readProps, directVertexColor: true });
      expect(outcome.status).toBe("unsupported");
      expect(outcome.vertexColorResidual).toBeUndefined();
    }
  });

  it("reports a flagged direct VertexColor graph unavailable when the graph is truncated or errored", async () => {
    const { sourceDir, assets, readProps } = await fixture();
    for (const graph of [{ ...vertexColorDirect(), truncated: true }, { ...vertexColorDirect(), error: "unreadable" }]) {
      const baker = createGraphBaker({ sourceDir, maxTextureSize: 8, dumpGraphs: async () => new Map([["M_Master", graph]]) })!;
      const outcome = await baker({ materialName: "MI_Rock_s", lookupName: "MI_Rock", assets, readProps, directVertexColor: true });
      expect(outcome.status).toBe("unavailable");
      expect(outcome.vertexColorResidual).toBeUndefined();
    }
  });

  it("carries the literal Roughness and Metallic on the cached residual outcome, an omitted R being 0", async () => {
    const { sourceDir, assets, readProps } = await fixture();
    const graph = vertexColorScalars({ roughness: pin("rough"), metallic: pin("metal") }, [
      node("rough", "Constant", { constants: { R: 0.25 } }),
      node("metal", "Constant", { constants: {} }),
    ]);
    const baker = createGraphBaker({ sourceDir, maxTextureSize: 8, dumpGraphs: async () => new Map([["M_Master", graph]]) })!;
    const request = { materialName: "MI_Rock_s", lookupName: "MI_Rock", assets, readProps, directVertexColor: true };
    const first = await baker(request);
    expect(first.status === "baked" && first.pbrFactors).toEqual({ roughness: 0.25, metallic: 0 });
    // The same request is answered from the memo, so the factors come back with the cached residual.
    expect(await baker(request)).toBe(first);
  });

  it("accepts a literal on output 0 with a null or R-only mask, at either end of [0, 1]", async () => {
    const { sourceDir, assets, readProps } = await fixture();
    const cases: Array<[string, MaterialGraph, number]> = [
      ["an R-only mask", vertexColorScalars({ roughness: pin("rough", [1, 0, 0, 0]) }, [node("rough", "Constant", { constants: { R: 0.25 } })]), 0.25],
      ["an upper bound of 1", vertexColorScalars({ roughness: pin("rough") }, [node("rough", "Constant", { constants: { R: 1 } })]), 1],
      ["a lower bound of 0", vertexColorScalars({ roughness: pin("rough") }, [node("rough", "Constant", { constants: { R: 0 } })]), 0],
    ];
    for (const [label, graph, expected] of cases) {
      const baker = createGraphBaker({ sourceDir, maxTextureSize: 8, dumpGraphs: async () => new Map([["M_Master", graph]]) })!;
      const outcome = await baker({ materialName: "MI_Rock_s", lookupName: "MI_Rock", assets, readProps, directVertexColor: true });
      expect(outcome.status === "baked" && outcome.pbrFactors?.roughness, label).toBe(expected);
    }
  });

  it("withholds the factor for any pin, node or value it cannot prove, and the residual itself still bakes", async () => {
    const { sourceDir, assets, readProps } = await fixture();
    const constant = (R: unknown) => node("rough", "Constant", { constants: { R } });
    const cases: Array<[string, MaterialGraph]> = [
      ["an unconnected Roughness", vertexColorScalars({}, [constant(0.25)])],
      ["a Roughness from output 1", vertexColorScalars({ roughness: { node: "rough", output: 1, mask: null } }, [constant(0.25)])],
      ["a Roughness with a G-only mask", vertexColorScalars({ roughness: pin("rough", [0, 1, 0, 0]) }, [constant(0.25)])],
      ["a Roughness above 1", vertexColorScalars({ roughness: pin("rough") }, [constant(1.5)])],
      ["a negative Roughness", vertexColorScalars({ roughness: pin("rough") }, [constant(-0.5)])],
      ["a Roughness written as a string", vertexColorScalars({ roughness: pin("rough") }, [constant("0.25")])],
      ["a Roughness written as an array", vertexColorScalars({ roughness: pin("rough") }, [constant([0.25])])],
      ["a Roughness read from a parameter", vertexColorScalars({ roughness: pin("rough") }, [node("rough", "ScalarParameter", { parameter: { name: "Roughness", group: "" }, default: 0.25 })])],
      ["a Constant with a wired input", vertexColorScalars({ roughness: pin("rough") }, [node("rough", "Constant", { inputs: { A: pin("vertex") }, constants: { R: 0.25 } })])],
      ["a Roughness whose node is missing", vertexColorScalars({ roughness: pin("gone") })],
      ["a Roughness whose node failed to load", vertexColorScalars({ roughness: pin("rough") }, [{ id: "rough", class: "Constant", error: "unreadable" }])],
    ];
    for (const [label, graph] of cases) {
      const baker = createGraphBaker({ sourceDir, maxTextureSize: 8, dumpGraphs: async () => new Map([["M_Master", graph]]) })!;
      const outcome = await baker({ materialName: "MI_Rock_s", lookupName: "MI_Rock", assets, readProps, directVertexColor: true });
      expect(outcome.status, label).toBe("baked");
      expect(outcome.vertexColorResidual, label).toBe(true);
      expect(outcome.pbrFactors, label).toBeUndefined();
    }
  });
});

// A finished bake is cached per exported-asset index. Two chains that differ only in the spelling of an /Engine/ reference
// must never share that cache: the exact spelling is answered by engine content and any other is not, so a folded key would
// let whichever baked first answer for the other, in whichever order the two happen to be requested.
describe("the finished bake cache keeps an /Engine/ reference's own spelling", () => {
  const VALID = "Texture2D'/Engine/Textures/T_Rock.T_Rock'";
  // The same package, spelled the way the importer refuses it: the mount prefix in another case, another class, an object that
  // differs only in case, a malformed shape that still addresses the engine mount, or padding, backslashes and doubled separators.
  // Each reaches the bake as a real parameter override (the props parser keeps the spelling whole inside its class wrapper), so
  // none of them can pass for the want of a parse.
  const REFUSED = [
    ["another mount case", "Texture2D'/engine/Textures/T_Rock.T_Rock'"],
    ["another class", "StaticMesh'/Engine/Textures/T_Rock.T_Rock'"],
    ["an object that differs only in case", "Texture2D'/Engine/Textures/T_Rock.t_rock'"],
    ["a parent segment", "Texture2D'/Engine/../Textures/T_Rock.T_Rock'"],
    ["a leading space inside a class wrapper", "Texture2D' /Engine/Textures/T_Rock.T_Rock'"],
    ["a trailing space inside a class wrapper", "Texture2D'/Engine/Textures/T_Rock.T_Rock '"],
    ["mixed separators", "/Engine\\Textures/T_Rock.T_Rock"],
    ["a doubled leading slash", "//Engine/Textures/T_Rock.T_Rock"],
    ["all backslashes", "\\Engine\\Textures\\T_Rock.T_Rock"],
    ["all backslashes in a class wrapper", "Texture2D'\\Engine\\Textures\\T_Rock.T_Rock'"],
    ["a wrong class with backslashes", "StaticMesh'\\Engine\\Textures\\T_Rock.T_Rock'"],
  ] as const;

  const propsFor = (reference: string): string =>
    [
      "Parent = Material3'/Game/Test/M_Master.M_Master'",
      "TextureParameterValues[0] =",
      "{",
      "    ParameterInfo = { Name=None }",
      `    ParameterValue = ${reference}`,
      "    ParameterName = Mask",
      "}",
    ].join("\n");

  /** One source tree, one exported-asset index and one baker per order, so only the request order differs. */
  async function fixture(refused: string) {
    const root = await scratch("graph-bake-engine-key-");
    const sourceDir = join(root, "source");
    const content = join(sourceDir, "Content", "Test");
    await mkdir(content, { recursive: true });
    for (const name of ["M_Master", "MI_Valid", "MI_Refused"]) await writeFile(join(content, `${name}.uasset`), Buffer.alloc(16));
    await writePng(join(root, "T_Rock.png"), [80, 160, 240, 255], 4);
    // The importer's own rule, kept here so the test measures the cache and not a rule of its own: an /Engine/ reference is
    // answered only when it is an exact texture reference, and a refused spelling is never answered by a pack package.
    const exportTexture = async (name: string, reference?: string): Promise<{ path: string } | undefined> =>
      canonicalEngineReference(reference ?? "")?.object === name ? { path: join(root, "T_Rock.png") } : undefined;
    const assets = { png: new Map<string, string>() };
    const readProps = (name: string): string | undefined => propsFor(name === "MI_Valid" ? VALID : refused);
    return { sourceDir, assets, readProps, exportTexture };
  }

  for (const [label, refused] of REFUSED) {
    it(`never lets a bake for one spelling of ${label} answer for the other, in either order`, async () => {
      const root = await fixture(refused);
      const byOrder = new Map<string, Map<string, GraphBakeOutcome>>();
      for (const order of [
        ["MI_Valid", "MI_Refused"],
        ["MI_Refused", "MI_Valid"],
      ]) {
        const baker = createGraphBaker({
          sourceDir: root.sourceDir,
          engine: "UE_5.8",
          maxTextureSize: 4,
          exportTexture: root.exportTexture,
          dumpGraphs: async () => new Map([["M_Master", masterGraph()]]),
        })!;
        const outcomes = new Map<string, GraphBakeOutcome>();
        for (const lookupName of order) {
          outcomes.set(
            lookupName,
            await baker({ materialName: `${lookupName}_section`, lookupName, assets: root.assets, readProps: root.readProps }),
          );
        }
        byOrder.set(order.join(" then "), outcomes);
      }
      const [validFirst, refusedFirst] = [...byOrder.values()];
      // Each request gets its own answer, whatever ran first, on one baker and one exported-asset index.
      expect(validFirst!.get("MI_Valid")?.status, "valid reference").toBe("baked");
      expect(validFirst!.get("MI_Refused")?.status, "refused reference").toBe("unavailable");
      // The spelling reached the bake whole, through the props parser, class and quotes included: a case the parser dropped
      // would leave the master's own default here and pass for the wrong reason.
      expect(validFirst!.get("MI_Refused")?.parameters?.textureReferences).toEqual(new Map([["mask", refused]]));
      expect(refusedFirst!.get("MI_Valid")?.status, "valid reference").toBe("baked");
      expect(refusedFirst!.get("MI_Refused")?.status, "refused reference").toBe("unavailable");
      // And the answer itself does not depend on the order the two were asked in.
      expect(refusedFirst!.get("MI_Valid")).toEqual(validFirst!.get("MI_Valid"));
      expect(refusedFirst!.get("MI_Refused")).toEqual(validFirst!.get("MI_Refused"));
    });
  }

  // The cache key holds the spelling itself, so a padded engine reference never shares a bake with the valid bare one.
  it("keys a padded /Engine/ reference apart from the valid one, so neither can answer for the other", () => {
    const keyed = (reference: string) =>
      parametersKey({
        textures: new Map([["mask", "T_Rock"]]),
        textureReferences: new Map([["mask", reference]]),
        vectors: new Map(),
        scalars: new Map(),
        switches: new Map(),
      });
    expect(keyed(" /Engine/Textures/T_Rock.T_Rock")).not.toBe(keyed("/Engine/Textures/T_Rock.T_Rock"));
    expect(keyed("/Engine/Textures/T_Rock.T_Rock ")).not.toBe(keyed("/Engine/Textures/T_Rock.T_Rock"));
  });
});

// ---------------------------------------------------------------------------------------------------------
// The importer end to end: fake umodel + a fake modern converter that answers `--dump-graphs`.

/** How the fake modern converter answers an exact `/Engine/` export: the PNG it writes, its SRGB flag, or its exit code. */
interface EngineExportFixture {
  readonly png: string;
  readonly srgb?: boolean;
  readonly writePng?: boolean;
  readonly exitCode?: number;
}

/** A `--dump-graphs` run the fake refuses under one `--engine` profile: a profile mismatch, or with `unrelated` a failure that is not one. */
interface DumpFailureFixture {
  readonly engine: string;
  readonly unrelated?: boolean;
}

async function writeFakeConverter(path: string, graph: MaterialGraph, argvLog: string, textureFrom?: string, engine?: EngineExportFixture, dumpFailure?: DumpFailureFixture): Promise<void> {
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
  const failure = ${JSON.stringify(dumpFailure ?? null)};
  const engineAt = argv.indexOf("--engine");
  if (failure && engineAt >= 0 && argv[engineAt + 1] === failure.engine) {
    process.stderr.write((failure.unrelated ? "fatal: the graph writer reached an unexpected end of stream" : "ParserException: Invalid FString length while decoding an unversioned package") + "\\n");
    process.exit(1);
  }
  fs.writeFileSync(join(argv[at + 1], ${JSON.stringify(`${graph.material}.graph.json`)}), ${JSON.stringify(JSON.stringify(graph))});
  process.exit(0);
}
const exportAt = argv.indexOf("--export-dir");
const filterAt = argv.indexOf("--filter");
const exactAt = argv.indexOf("--exact-reference");
if (exactAt >= 0) {
  const engine = ${JSON.stringify(engine ?? null)};
  if (engine && engine.exitCode) process.exit(engine.exitCode);
  if (engine && engine.writePng !== false) {
    const dir = join(argv[exportAt + 1], "Textures");
    const object = argv[exactAt + 1].split(".").pop();
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(engine.png, join(dir, object + ".png"));
    fs.writeFileSync(join(dir, object + ".props.txt"), "SRGB=" + (engine.srgb ? "True" : "False") + "\\n");
  }
  process.exit(0);
}
if (exportAt >= 0 && filterAt >= 0 && ${JSON.stringify(textureFrom ?? "")}) {
  const name = argv[filterAt + 1].split("/").pop();
  fs.mkdirSync(join(argv[exportAt + 1], "Textures"), { recursive: true });
  fs.copyFileSync(join(${JSON.stringify(textureFrom ?? "")}, name + ".png"), join(argv[exportAt + 1], "Textures", name + ".png"));
}
process.exit(0);
`,
  );
  await chmod(path, 0o755);
}

/** A umodel that exports `hiddenFrom` for the one texture package `T_Hidden` and defers everything else to `base`. */
async function writeDispatchingUmodel(path: string, base: string, hiddenFrom: string | undefined, log: string): Promise<void> {
  await writeFile(
    path,
    `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const { basename, join } = require("node:path");
const argv = process.argv.slice(2);
const selector = argv.filter((entry) => !entry.startsWith("-")).pop() || "";
if (argv.includes("-export") && basename(selector) === "T_Hidden") {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + "\\n");
  const out = argv.find((entry) => entry.indexOf("-out=") === 0).slice("-out=".length);
  if (${JSON.stringify(hiddenFrom)}) {
    fs.mkdirSync(join(out, "Group"), { recursive: true });
    fs.cpSync(${JSON.stringify(hiddenFrom)}, join(out, "Group"), { recursive: true });
  }
  process.exit(0);
}
const run = spawnSync(${JSON.stringify(base)}, argv, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
process.stdout.write(run.stdout || ""); process.stderr.write(run.stderr || "");
process.exit(run.status === null ? 1 : run.status);
`,
  );
  await chmod(path, 0o755);
}

/**
 * The parent's EmissiveColor default (the collected block UE Viewer writes for a parent value) and the instance's override of
 * the Emissive switch, in the layout `materials.ts` reads.
 */
function emissiveProps(options: { collectedEmissive?: readonly number[] | undefined; switchOverride?: boolean | undefined }): string {
  const lines: string[] = [];
  if (options.collectedEmissive) {
    const [r, g, b, a] = options.collectedEmissive;
    lines.push("CollectedVectorParameters[1] =", "{", "    CollectedVectorParameters[0] =", "    {", `        Value = { R=${r}, G=${g}, B=${b}, A=${a} }`, "        Name = EmissiveColor", "    }", "}");
  }
  if (options.switchOverride !== undefined) {
    lines.push(
      "StaticParameters =",
      "{",
      "    StaticSwitchParameters[1] =",
      "    {",
      "        StaticSwitchParameters[0] =",
      "        {",
      "            ParameterInfo = { Name=Emissive }",
      `            Value = ${options.switchOverride}`,
      "            bOverride = true",
      "        }",
      "    }",
      "}",
    );
  }
  return lines.length > 0 ? `\n${lines.join("\n")}` : "";
}

async function importWithGraph(options: { graph: MaterialGraph; graphBake?: boolean; hiddenTexture?: boolean; hiddenVia?: "umodel" | "converter" | "modern-header"; vertexColors?: boolean; normal?: [number, number, number]; instanceScalars?: [string, number][]; instanceTint?: [number, number, number, number]; packedRoughness?: boolean; collectedEmissive?: [number, number, number, number]; switchOverride?: boolean; emissiveTexture?: boolean; inputEmissive?: { factor?: [number, number, number]; texture?: boolean }; inputBaseColorTexture?: boolean; emptyToolchain?: boolean; engine?: { srgb?: boolean; writePng?: boolean; exitCode?: number }; packEngine?: string; packNamesake?: boolean; noInstanceOverrides?: boolean; normalTexture?: string; inputNormalTexture?: string; formatHint?: string; dumpFailure?: DumpFailureFixture }) {
  const root = await scratch("graph-bake-import-");
  const sourceDir = join(root, "source");
  const content = join(sourceDir, "Content", "Test");
  const exported = join(root, "exported");
  const outputDir = join(root, "output");
  await mkdir(content, { recursive: true });
  await writeFile(join(content, "Mesh.uasset"), Buffer.alloc(16));
  await writeFile(join(content, "MI_Rock.uasset"), Buffer.alloc(16));
  await writeFile(join(content, "M_Master.uasset"), Buffer.alloc(16));
  const overrides: [string, string][] = options.hiddenTexture || options.noInstanceOverrides ? [] : [["Mask", "T_InstanceMask"]];
  // A packed roughness texture (SpecPower binds the metallicRoughness slot): a constant factor must not multiply into it.
  if (options.packedRoughness) overrides.push(["SpecPower", "T_Spec"]);
  // An Emissive texture the instance binds: the stale-emission case drops it with the factor.
  if (options.emissiveTexture) overrides.push(["Emissive", "T_InstanceGlow"]);
  // The flattened normal map: an instance texture the resolver binds to the normal slot, which the graph may or may not read.
  if (options.normalTexture) overrides.push(["Normal", options.normalTexture]);
  // The exporter binds nothing to MI_Rock: its colour exists only in the graph.
  await writeMeshFixture(exported, {
    name: "Mesh",
    materialName: "MI_Rock",
    mat: "",
    props:
      instanceProps("M_Master", overrides, {
        scalars: options.instanceScalars,
        vectors: options.instanceTint ? [["Base Color Tint", options.instanceTint]] : undefined,
      }) + emissiveProps({ collectedEmissive: options.collectedEmissive, switchOverride: options.switchOverride }),
    textures: [],
  });
  if (options.inputEmissive || options.inputBaseColorTexture || options.inputNormalTexture !== undefined) {
    // The converter can leave a base-colour, normal or emissive texture, or an emissive factor, on the input glTF material, which the
    // .mat/.props the resolver reads never mentions. The graph proof must preserve the base colour and handle the emission.
    const io = new NodeIO();
    const document = await io.read(join(exported, "Mesh.gltf"));
    const inputMaterial = document.getRoot().listMaterials()[0]!;
    const solidPng = async (rgba: readonly [number, number, number]) => {
      const pixels = Buffer.alloc(2 * 2 * 4);
      for (let index = 0; index < 4; index += 1) {
        pixels[index * 4] = rgba[0];
        pixels[index * 4 + 1] = rgba[1];
        pixels[index * 4 + 2] = rgba[2];
        pixels[index * 4 + 3] = 255;
      }
      return sharp(pixels, { raw: { width: 2, height: 2, channels: 4 } }).png().toBuffer();
    };
    if (options.inputBaseColorTexture) {
      inputMaterial.setBaseColorTexture(document.createTexture("T_InputAlbedo").setImage(new Uint8Array(await solidPng([120, 90, 60]))).setMimeType("image/png"));
    }
    if (options.inputEmissive?.factor) inputMaterial.setEmissiveFactor([...options.inputEmissive.factor]);
    if (options.inputEmissive?.texture) {
      inputMaterial.setEmissiveTexture(document.createTexture("T_InputGlow").setImage(new Uint8Array(await solidPng([255, 200, 80]))).setMimeType("image/png"));
    }
    if (options.inputNormalTexture !== undefined) {
      inputMaterial.setNormalTexture(document.createTexture(options.inputNormalTexture).setImage(new Uint8Array(await solidPng([128, 128, 255]))).setMimeType("image/png"));
    }
    await io.write(join(exported, "Mesh.gltf"), document);
  }
  if (options.normal) {
    const io = new NodeIO();
    const document = await io.read(join(exported, "Mesh.gltf"));
    const primitive = document.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
    primitive.getAttribute("NORMAL")!.setArray(new Float32Array([...options.normal, ...options.normal, ...options.normal]));
    await io.write(join(exported, "Mesh.gltf"), document);
  }
  if (options.vertexColors) {
    // UE Viewer's glTF writer emits COLOR_0 for a mesh that has a vertex colour buffer.
    const io = new NodeIO();
    const document = await io.read(join(exported, "Mesh.gltf"));
    const primitive = document.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
    primitive.setAttribute("COLOR_0", document.createAccessor("COLOR_0").setType("VEC4").setArray(new Float32Array([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1])).setBuffer(document.getRoot().listBuffers()[0]!));
    await io.write(join(exported, "Mesh.gltf"), document);
  }
  // The textures the graph names are packages in the pack; the baker exports the exact one from source, never a same-named PNG
  // the mesh export happened to carry.
  await writeFile(join(content, "T_InstanceMask.uasset"), Buffer.alloc(16));
  await writeFile(join(content, "T_MasterMask.uasset"), Buffer.alloc(16));
  await writePng(join(exported, "T_InstanceMask.png"), [200, 100, 50, 255], 4);
  await writePng(join(exported, "T_MasterMask.png"), [10, 10, 10, 255], 4);
  // A pack package and a same-named PNG the mesh export carried, both called T_Rock: an /Engine/ reference must never pick them.
  if (options.packNamesake) {
    await writeFile(join(content, "T_Rock.uasset"), Buffer.alloc(16));
    await writePng(join(exported, "T_Rock.png"), [200, 100, 50, 255], 4);
  }
  // The engine content root the importer keys: a real directory with one body, and the PNG the fake exporter copies.
  const engineDir = join(root, "engine", "Content");
  if (options.engine) {
    await mkdir(join(engineDir, "Textures"), { recursive: true });
    await writeFile(join(engineDir, "Textures", "T_Rock.uasset"), "engine body");
    await writePng(join(root, "engine-T_Rock.png"), [80, 160, 240, 255], 4);
  }
  if (options.packedRoughness) {
    await writeFile(join(content, "T_Spec.uasset"), Buffer.alloc(16));
    await writePng(join(exported, "T_Spec.png"), [128, 128, 128, 255], 4);
  }
  if (options.emissiveTexture) {
    await writeFile(join(content, "T_InstanceGlow.uasset"), Buffer.alloc(16));
    await writePng(join(exported, "T_InstanceGlow.png"), [255, 200, 80, 255], 4);
  }
  if (options.normalTexture) {
    await writeFile(join(content, `${options.normalTexture}.uasset`), Buffer.alloc(16));
    await writePng(join(exported, `${options.normalTexture}.png`), [128, 128, 255, 255], 4);
  }
  const umodel = join(root, "umodel");
  const textureLog = join(root, "texture-exports.log");
  const cacheDir = join(root, "cache");
  if (options.hiddenTexture) {
    // T_Hidden is referenced only by the graph: the mesh export does not carry it, only its own package export does.
    const header = Buffer.alloc(24);
    header.writeUInt32LE(0x9e2a83c1, 0);
    // UE5 packages (LegacyFileVersion <= -8) are routed straight to the modern converter.
    header.writeInt32LE(options.hiddenVia === "modern-header" ? -8 : -7, 4);
    await writeFile(join(content, "T_Hidden.uasset"), header);
    await mkdir(join(root, "hidden"), { recursive: true });
    await writePng(join(root, "hidden", "T_Hidden.png"), [80, 160, 240, 255], 4);
    await writeFakeUmodel(join(root, "umodel-base"), { exportFrom: exported, classes: { Mesh: ["StaticMesh"] } });
    await writeDispatchingUmodel(umodel, join(root, "umodel-base"), (options.hiddenVia ?? "umodel") === "umodel" ? join(root, "hidden") : undefined, textureLog);
  } else {
    await writeFakeUmodel(umodel, { exportFrom: exported, classes: { Mesh: ["StaticMesh"] } });
  }
  const converter = join(root, "converter");
  const converterLog = join(root, "converter.log");
  await writeFakeConverter(
    converter,
    options.graph,
    converterLog,
    options.hiddenTexture && options.hiddenVia && options.hiddenVia !== "umodel" ? join(root, "hidden") : undefined,
    options.engine ? { ...options.engine, png: join(root, "engine-T_Rock.png") } : undefined,
    options.dumpFailure,
  );
  const report = await importUnrealDirectory({
    sourceDir,
    outputDir,
    onlyPackages: ["Mesh"],
    concurrency: 1,
    freeSpaceBytes: 30_000_000_000,
    environment: {
      ...withoutEngineContent(process.env),
      THREENATIVE_UNREAL_CACHE_DIR: cacheDir,
      ...(options.engine ? { THREENATIVE_ENGINE_CONTENT_DIR: engineDir, THREENATIVE_ENGINE_CONTENT_VERSION: "5.8" } : {}),
      // An empty toolchain with auto-install off: the graph baker must fail to provision and never download anything.
      ...(options.emptyToolchain ? { THREENATIVE_TOOLCHAIN_AUTOINSTALL: "0", THREENATIVE_TOOLCHAIN_DIR: join(root, "toolchain") } : {}),
    },
    umodel: { name: "umodel", path: umodel, version: "fixture" },
    // No converter injected when the toolchain is empty: the graph baker must resolve-or-fail, never provision.
    ...(options.emptyToolchain ? {} : { modernConverter: { name: "modern", path: converter, version: "fake-converter 1" } }),
    ...(options.graphBake === undefined ? {} : { graphBake: options.graphBake }),
    ...(options.packEngine ? { engine: options.packEngine } : {}),
    ...(options.formatHint === undefined ? {} : { formatHint: options.formatHint }),
  });
  const glb = await new NodeIO().read(join(outputDir, report.models[0]!.glb));
  const onDisk = JSON.parse(await readFile(join(outputDir, "import-report.json"), "utf8")) as ImportReport;
  const dumped = await readFile(converterLog, "utf8").catch(() => "");
  const leftovers = await readdir(cacheDir, { recursive: true }).catch(() => [] as string[]);
  const textureExports = (await readFile(textureLog, "utf8").catch(() => "")).split("\n").filter(Boolean);
  const toolchain = await readdir(join(root, "toolchain"), { recursive: true }).catch(() => [] as string[]);
  return { report, onDisk, material: glb.getRoot().listMaterials()[0]!, glb, dumped, leftovers, textureExports, toolchain, engineDir };
}

/** The process environment without engine content, so a developer's own engine variables never reach a test's import. */
function withoutEngineContent(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...environment };
  delete copy.THREENATIVE_ENGINE_CONTENT_DIR;
  delete copy.THREENATIVE_ENGINE_CONTENT_VERSION;
  return copy;
}

/** Every converter invocation the fake logged, one argv per line. */
function invocations(log: string): string[][] {
  return log.split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
}

/** The invocations that asked for an exact `/Engine/` export. */
function exactExports(log: string): string[][] {
  return invocations(log).filter((argv) => argv.includes("--exact-reference"));
}

/** The invocations that asked for a pack package by a selector ending in `name`: the suffix and basename route. */
function filterExports(log: string, name: string): string[][] {
  return invocations(log).filter((argv) => {
    const at = argv.indexOf("--filter");
    return at >= 0 && argv[at + 1]!.endsWith(name);
  });
}

/** M_Master whose BaseColor is one texture sampled as Color, so Unreal's sRGB decode of that texture is what the bake shows. */
function colourGraph(reference: string, options: { sampled?: boolean } = {}): MaterialGraph {
  const sampled = options.sampled ?? true;
  const nodes: Raw[] = [
    node("tex", "TextureSampleParameter2D", { parameter: { name: "Colour", group: "" }, default: null, texture: reference, samplerType: "Color" }),
    node("constant", "Constant3Vector", { constants: { Constant: [0.5, 0.25, 1, 1] } }),
  ];
  return materialGraphSchema.parse({
    format: 1,
    material: "M_Master",
    package: "/Game/Test/M_Master",
    truncated: false,
    nodeCount: nodes.length,
    outputs: {
      baseColor: pin(sampled ? "tex" : "constant"),
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

describe("importUnrealDirectory surface-driven graph bake", () => {
  it("bakes a world-aligned blend from the mesh's own normals: moss on an up-facing surface, rock on a side-facing one", async () => {
    const up = await importWithGraph({ graph: moss(), normal: [0, 1, 0] });
    const side = await importWithGraph({ graph: moss(), normal: [1, 0, 0] });
    expect(await firstPixel(up.material.getBaseColorTexture()!.getImage()!)).toEqual([encode(0.1), encode(0.3), encode(0.05)]);
    expect(await firstPixel(side.material.getBaseColorTexture()!.getImage()!)).toEqual([encode(0.6), encode(0.5), encode(0.3)]);
    const graph = up.report.models[0]!.materials[0]!.graph;
    expect(graph?.approximations.some((note) => note.startsWith("WorldAlignedBlend evaluated as saturate(up component"))).toBe(true);
  });
});

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

  it("names the unsupported node class and stays neutral for a VertexColor graph on a painted mesh", async () => {
    const { report, material } = await importWithGraph({ graph: masterGraph("vertex-color"), vertexColors: true });
    expect(material.getBaseColorTexture()).toBeNull();
    expect(material.getBaseColorFactor().slice(0, 3).every((value) => Math.abs(value - 0.8) < 1e-6)).toBe(true);
    const section = report.models[0]!.materials[0]!;
    expect(section.graph).toMatchObject({ status: "unsupported" });
    expect(section.graph?.unsupportedNodes).toContain("VertexColor");
    expect(section.bindings.some((binding) => binding.source === "graph")).toBe(false);
    expect(report.materialCoverage.graphBaked).toBe(0);
  });

  it("keeps COLOR_0 when the graph's switch choices never settle, instead of dropping it on an unknown path", async () => {
    const { report, glb, material } = await importWithGraph({ graph: cyclingSwitchGraph(), vertexColors: true });
    // The probe cannot say the BaseColor path reads VertexColor: it never settles, so COLOR_0 must survive.
    const primitive = glb.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
    expect([...primitive.getAttribute("COLOR_0")!.getArray()!]).toEqual([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1]);
    const section = report.models[0]!.materials[0]!;
    expect(section.limitations.join("\n")).not.toContain("COLOR_0");
    // The same refusal leaves the section on the neutral fallback.
    expect(material.getBaseColorTexture()).toBeNull();
  });

  it("evaluates VertexColor as white for a mesh without COLOR_0 and reports the approximation", async () => {
    const { report, material } = await importWithGraph({ graph: masterGraph("vertex-color") });
    const texture = material.getBaseColorTexture();
    expect(texture).not.toBeNull();
    expect(await firstPixel(texture!.getImage()!)).toEqual([encode(0.5), encode(0.25), encode(1)]);
    const section = report.models[0]!.materials[0]!;
    expect(section.graph).toMatchObject({ status: "baked", confidence: "heuristic", unsupportedNodes: [] });
    expect(section.graph?.approximations.join("\n")).toContain("VertexColor evaluated as white: the mesh carries no vertex colours");
    expect(section.limitations.join("\n")).toContain("VertexColor evaluated as white");
    expect(section.bindings).toContainEqual(expect.objectContaining({ source: "graph", confidence: "heuristic" }));
    expect(report.materialCoverage.graphBaked).toBe(1);
  });

  it("bakes a white residual for a direct VertexColor graph and keeps the mesh's COLOR_0 colours exact", async () => {
    const { report, onDisk, material, glb } = await importWithGraph({ graph: vertexColorDirect(), vertexColors: true });
    const texture = material.getBaseColorTexture();
    expect(texture).not.toBeNull();
    // Neutral residual: the actual colour is not in the PNG.
    expect(await firstPixel(texture!.getImage()!)).toEqual([255, 255, 255]);
    // White factor, so glTF's factor x texture x COLOR_0 equals Unreal's VertexColor (no 0.8 dimming).
    expect(material.getBaseColorFactor()).toEqual([1, 1, 1, 1]);
    expect(material.getAlphaMode()).toBe("OPAQUE");
    const primitive = glb.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
    expect([...primitive.getAttribute("COLOR_0")!.getArray()!]).toEqual([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1]);
    const section = report.models[0]!.materials[0]!;
    expect(section.graph).toMatchObject({ status: "baked", confidence: "exact", unsupportedNodes: [], vertexColorResidual: true });
    // No false "mesh carries no vertex colours" note: the mesh does carry them.
    expect(section.graph?.approximations.join("\n")).not.toContain("the mesh carries no vertex colours");
    expect(section.limitations.join("\n")).toContain("COLOR_0 supplies the base colour");
    expect(section.bindings).toContainEqual(expect.objectContaining({ source: "graph", confidence: "exact" }));
    expect(onDisk.models[0]!.materials[0]!.graph?.vertexColorResidual).toBe(true);
  });

  it("keeps an OPAQUE direct VertexColor section when an unused instance Opacity scalar and tint alpha are present", async () => {
    // Regression: the direct VertexColor graph proves there is no alpha path (no Opacity/OpacityMask output), so an
    // unused instance scalar Opacity and a tint alpha of 0.5 must not lower the proved-OPAQUE section to BLEND. Doing
    // so let COLOR_0's alpha decide visibility and broke the prerequisite that the mesh's COLOR_0 is the colour.
    const { report, material, glb } = await importWithGraph({
      graph: vertexColorDirect(),
      vertexColors: true,
      instanceScalars: [["Opacity", 0.5]],
      instanceTint: [1, 1, 1, 0.5],
    });
    const texture = material.getBaseColorTexture();
    expect(texture).not.toBeNull();
    // The residual stays the exact identity: no tint alpha folded into the factor, no 0.8 dimming.
    expect(await firstPixel(texture!.getImage()!)).toEqual([255, 255, 255]);
    expect(material.getBaseColorFactor()).toEqual([1, 1, 1, 1]);
    expect(material.getAlphaMode()).toBe("OPAQUE");
    const primitive = glb.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
    expect([...primitive.getAttribute("COLOR_0")!.getArray()!]).toEqual([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1]);
    const section = report.models[0]!.materials[0]!;
    expect(section.graph).toMatchObject({ status: "baked", confidence: "exact", vertexColorResidual: true });
    expect(section.limitations.join("\n")).toContain("COLOR_0 supplies the base colour");
  });

  it("keeps default white for a direct VertexColor graph on a mesh that carries no COLOR_0", async () => {
    const { report, material, glb } = await importWithGraph({ graph: vertexColorDirect() });
    const texture = material.getBaseColorTexture();
    expect(texture).not.toBeNull();
    expect(await firstPixel(texture!.getImage()!)).toEqual([255, 255, 255]);
    expect(material.getBaseColorFactor()).toEqual([1, 1, 1, 1]);
    // No invented colour buffer: a glTF client leaves the base colour at the white factor, like Unreal's default node.
    expect(glb.getRoot().listMeshes()[0]!.listPrimitives()[0]!.getAttribute("COLOR_0")).toBeNull();
    const section = report.models[0]!.materials[0]!;
    expect(section.graph).toMatchObject({ status: "baked", confidence: "heuristic" });
    expect(section.graph?.vertexColorResidual).toBeUndefined();
    expect(section.graph?.approximations.join("\n")).toContain("VertexColor evaluated as white: the mesh carries no vertex colours");
  });

  it("applies a literal Roughness and Metallic to the GLB and report, an omitted R being Unreal's default 0", async () => {
    const graph = vertexColorScalars({ roughness: pin("rough"), metallic: pin("metal") }, [
      node("rough", "Constant", { constants: {} }),
      node("metal", "Constant", { constants: { R: 1 } }),
    ]);
    const { report, onDisk, material } = await importWithGraph({ graph, vertexColors: true });
    expect(material.getRoughnessFactor()).toBe(0);
    expect(material.getMetallicFactor()).toBe(1);
    for (const reported of [report, onDisk]) {
      const section = reported.models[0]!.materials[0]!;
      expect(section.factors).toMatchObject({ roughness: 0, metallic: 1 });
      expect(section.limitations.join("\n")).toContain("Roughness 0, Metallic 1");
    }
  });

  it("carries a literal Roughness of 0.25 through the GLB and report, and an unused instance Roughness of 0.8 does not override it", async () => {
    const graph = vertexColorScalars({ roughness: pin("rough") }, [node("rough", "Constant", { constants: { R: 0.25 } })]);
    const { report, onDisk, material } = await importWithGraph({ graph, vertexColors: true, instanceScalars: [["Roughness", 0.8]] });
    expect(material.getRoughnessFactor()).toBe(0.25);
    for (const reported of [report, onDisk]) {
      const section = reported.models[0]!.materials[0]!;
      expect(section.factors.roughness).toBe(0.25);
      expect(section.graph).toMatchObject({ status: "baked", vertexColorResidual: true });
    }
  });

  it("keeps the 0.8 fallback when the graph's Roughness is not a proven literal: out of range, another output, or a parameter", async () => {
    const cases: Array<[string, MaterialGraph]> = [
      ["out of range", vertexColorScalars({ roughness: pin("rough") }, [node("rough", "Constant", { constants: { R: 1.5 } })])],
      ["output 1", vertexColorScalars({ roughness: { node: "rough", output: 1, mask: null } }, [node("rough", "Constant", { constants: { R: 0.25 } })])],
      ["a parameter", vertexColorScalars({ roughness: pin("rough") }, [node("rough", "ScalarParameter", { parameter: { name: "Roughness", group: "" }, default: 0.25 })])],
    ];
    for (const [label, graph] of cases) {
      const { report, material } = await importWithGraph({ graph, vertexColors: true });
      const section = report.models[0]!.materials[0]!;
      expect(material.getRoughnessFactor(), label).toBe(0.8);
      expect(section.factors.roughness, label).toBe(0.8);
      expect(section.graph, label).toMatchObject({ status: "baked", vertexColorResidual: true });
      expect(section.limitations.join("\n"), label).not.toContain("literal Constant");
    }
  });

  it("does not multiply a literal Roughness into a packed metallicRoughness texture, and records that the constant is not applied", async () => {
    const graph = vertexColorScalars({ roughness: pin("rough") }, [node("rough", "Constant", { constants: { R: 0.25 } })]);
    const { report, material } = await importWithGraph({ graph, vertexColors: true, packedRoughness: true });
    const section = report.models[0]!.materials[0]!;
    expect(material.getMetallicRoughnessTexture()).not.toBeNull();
    // The packed path keeps its own factors (metallic 0, roughness 1), so the texture's channels stand unscaled.
    expect(material.getMetallicFactor()).toBe(0);
    expect(material.getRoughnessFactor()).toBe(1);
    expect(section.limitations.join("\n")).toContain("not applied");
    expect(section.graph).toMatchObject({ status: "baked", vertexColorResidual: true });
  });
});

/**
 * The Jungle master's shape in the importer's fixture: BaseColor is Mask x tint, and EmissiveColor is the Emissive switch
 * (stored default `switchStored`) between a glow and a zero constant. `glowOnly` wires the glow straight in instead, and
 * `equalBounds` wires a SmoothStep of two equal parameters, which has no defined GPU result and so no zero proof.
 */
/**
 * A master whose Normal is the node the test names: the leaf map its own parameter samples (not the bark map the flattened binding
 * names), the bark map itself, or a node the evaluator cannot follow. BaseColor is the instance's mask, or a node no bake can read.
 */
function normalMaster(normal: "leaf" | "bark" | "camera", baseColor: "mask" | "unbakeable" = "mask"): MaterialGraph {
  const nodes: Raw[] = [
    node("mask", "TextureSampleParameter2D", { parameter: { name: "Mask", group: "" }, default: null, texture: "/Game/Test/T_MasterMask.T_MasterMask", samplerType: "Color" }),
    node("leaf", "TextureSampleParameter2D", { parameter: { name: "LeafNormal", group: "" }, default: null, texture: "/Game/Test/T_LeafNormal.T_LeafNormal", samplerType: "Normal" }),
    node("bark", "TextureSample", { texture: "/Game/Test/T_BarkNormal.T_BarkNormal", samplerType: "Normal" }),
    node("camera", "CameraVectorWS"),
    node("unbakeable", "CameraVectorWS"),
    node("make", "MakeMaterialAttributes", { inputs: { BaseColor: pin(baseColor), Normal: pin(normal) } }),
  ];
  return materialGraphSchema.parse({
    format: 1,
    material: "M_Master",
    package: "/Game/Test/M_Master",
    truncated: false,
    nodeCount: nodes.length,
    outputs: { baseColor: null, roughness: null, metallic: null, emissive: null, opacity: null, opacityMask: null, normal: null, materialAttributes: pin("make") },
    outputConstants: {},
    nodes,
  });
}

/**
 * normalMaster's Normal as a static switch: A the leaf map, B the bark map, and Value the StaticBoolParameter UseLeaf (default true) read
 * through `value`. `flag` is merged over that parameter node.
 */
function switchedNormalMaster(value: Raw, flag: Raw = {}): MaterialGraph {
  const nodes: Raw[] = [
    node("mask", "TextureSampleParameter2D", { parameter: { name: "Mask", group: "" }, default: null, texture: "/Game/Test/T_MasterMask.T_MasterMask", samplerType: "Color" }),
    node("leaf", "TextureSampleParameter2D", { parameter: { name: "LeafNormal", group: "" }, default: null, texture: "/Game/Test/T_LeafNormal.T_LeafNormal", samplerType: "Normal" }),
    node("bark", "TextureSample", { texture: "/Game/Test/T_BarkNormal.T_BarkNormal", samplerType: "Normal" }),
    node("flag", "StaticBoolParameter", { parameter: { name: "UseLeaf", group: "" }, default: true, ...flag }),
    node("sw", "StaticSwitch", { inputs: { A: pin("leaf"), B: pin("bark"), Value: value } }),
    node("make", "MakeMaterialAttributes", { inputs: { BaseColor: pin("mask"), Normal: pin("sw") } }),
  ];
  return materialGraphSchema.parse({
    format: 1,
    material: "M_Master",
    package: "/Game/Test/M_Master",
    truncated: false,
    nodeCount: nodes.length,
    outputs: { baseColor: null, roughness: null, metallic: null, emissive: null, opacity: null, opacityMask: null, normal: null, materialAttributes: pin("make") },
    outputConstants: {},
    nodes,
  });
}

describe("a flattened normal map the graph's active Normal does not read", () => {
  it("is omitted from the GLTF and the report, and the other textures and geometry match the import that keeps it", async () => {
    const kept = await importWithGraph({ graph: normalMaster("bark"), normalTexture: "T_BarkNormal" });
    const stale = await importWithGraph({ graph: normalMaster("leaf"), normalTexture: "T_BarkNormal" });
    expect(kept.material.getNormalTexture()).not.toBeNull();
    expect(stale.material.getNormalTexture()).toBeNull();
    const limitations = stale.report.models[0]!.materials[0]!.limitations.join("\n");
    expect(limitations).toContain("T_BarkNormal is a stale flattened normal, omitted");
    expect(limitations).toContain("authored normal composition is not reconstructed");
    expect(stale.onDisk.models[0]!.materials[0]!.limitations.join("\n")).toContain("T_BarkNormal is a stale flattened normal, omitted");
    expect(stale.glb.getRoot().listTextures()).toHaveLength(kept.glb.getRoot().listTextures().length - 1);
    expect(stale.material.getBaseColorTexture()?.getImage()).toEqual(kept.material.getBaseColorTexture()?.getImage());
    const positions = (glb: typeof kept.glb) => glb.getRoot().listMeshes()[0]!.listPrimitives()[0]!.getAttribute("POSITION")!.getArray();
    expect(positions(stale.glb)).toEqual(positions(kept.glb));
  });

  it("is decided by the probe even when the BaseColor does not bake", async () => {
    const stale = await importWithGraph({ graph: normalMaster("leaf", "unbakeable"), normalTexture: "T_BarkNormal" });
    expect(stale.material.getNormalTexture()).toBeNull();
    expect(stale.report.models[0]!.materials[0]!.limitations.join("\n")).toContain("T_BarkNormal is a stale flattened normal, omitted");
  });

  it("keeps a flattened normal map the graph reads, with no limitation about it", async () => {
    const kept = await importWithGraph({ graph: normalMaster("bark"), normalTexture: "T_BarkNormal" });
    expect(kept.material.getNormalTexture()).not.toBeNull();
    expect(kept.report.models[0]!.materials[0]!.limitations.join("\n")).not.toContain("T_BarkNormal");
  });

  it("keeps a flattened normal map the graph cannot prove, and says it is unverified", async () => {
    const unknown = await importWithGraph({ graph: normalMaster("camera"), normalTexture: "T_BarkNormal" });
    expect(unknown.material.getNormalTexture()).not.toBeNull();
    expect(unknown.report.models[0]!.materials[0]!.limitations.join("\n")).toContain("T_BarkNormal kept as the normal map, unverified:");
  });

  it("keeps a flattened normal map when a static switch's StaticBoolParameter could not be read, though its default is true", async () => {
    const unknown = await importWithGraph({ graph: switchedNormalMaster(pin("flag"), { error: "could not load" }), normalTexture: "T_BarkNormal" });
    expect(unknown.material.getNormalTexture()).not.toBeNull();
    expect(unknown.report.models[0]!.materials[0]!.limitations.join("\n")).toContain("T_BarkNormal kept as the normal map, unverified:");
  });

  it.each([
    ["a non-zero output of its StaticBoolParameter", { ...pin("flag"), output: 1 }],
    ["a masked StaticBoolParameter pin", pin("flag", [1, 1, 1, 0])],
  ])("keeps a flattened normal map when a static switch reads %s, and says it is unverified", async (_label, value) => {
    const unknown = await importWithGraph({ graph: switchedNormalMaster(value), normalTexture: "T_BarkNormal" });
    expect(unknown.material.getNormalTexture()).not.toBeNull();
    expect(unknown.report.models[0]!.materials[0]!.limitations.join("\n")).toContain("T_BarkNormal kept as the normal map, unverified:");
  });
});

/**
 * masterGraph's mask-tint BaseColor, a graph-only colour that bakes, beside a Normal that is one Distance wired by `inputs`. `extra` adds the
 * constants or masked pins it reads, over the leaf and bark maps normalMaster names. The Normal is read from the attributes pin.
 */
function distanceNormalMaster(inputs: Raw, extra: Raw[] = []): MaterialGraph {
  const nodes: Raw[] = [
    node("mask", "TextureSampleParameter2D", { parameter: { name: "Mask", group: "" }, default: null, texture: "/Game/Test/T_MasterMask.T_MasterMask", samplerType: "Masks" }),
    node("tint", "Constant3Vector", { constants: { Constant: [0.5, 0.25, 1, 1] } }),
    node("mul", "Multiply", { inputs: { A: pin("mask", [1, 1, 1, 0]), B: pin("tint") } }),
    node("leaf", "TextureSampleParameter2D", { parameter: { name: "LeafNormal", group: "" }, default: null, texture: "/Game/Test/T_LeafNormal.T_LeafNormal", samplerType: "Normal" }),
    node("bark", "TextureSample", { texture: "/Game/Test/T_BarkNormal.T_BarkNormal", samplerType: "Normal" }),
    ...extra,
    node("d", "Distance", { inputs }),
    node("make", "MakeMaterialAttributes", { inputs: { Normal: pin("d") } }),
  ];
  return materialGraphSchema.parse({
    format: 1,
    material: "M_Master",
    package: "/Game/Test/M_Master",
    truncated: false,
    nodeCount: nodes.length,
    outputs: { baseColor: pin("mul"), roughness: null, metallic: null, emissive: null, opacity: null, opacityMask: null, normal: null, materialAttributes: pin("make") },
    outputConstants: {},
    nodes,
  });
}

describe("a flattened normal map under a Normal Distance the compile refuses", () => {
  const two = node("two", "Constant2Vector", { constants: { R: 0.3, G: 0.4 } });
  const three = constant3("three", [0, 0, 0]);
  const four = node("four", "Constant4Vector", { constants: { Constant: [0.3, 0.4, 0.5, 0] } });

  // The BaseColor still bakes, and the bark map is kept as unverified: a Distance the compile refuses proves nothing about the Normal.
  it.each([
    ["a missing B", { A: pin("two") }, [two]],
    ["a float2 and a float3", { A: pin("two"), B: pin("three") }, [two, three]],
    ["a float4 masked to 3 components against a float2", { A: pin("four", [1, 1, 1, 0]), B: pin("two") }, [four, two]],
  ])("keeps the flattened normal map as unverified under %s, and bakes the BaseColor", async (_label, inputs, extra) => {
    const { material, report } = await importWithGraph({ graph: distanceNormalMaster(inputs, extra), normalTexture: "T_BarkNormal" });
    const section = report.models[0]!.materials[0]!;
    expect(section.graph).toMatchObject({ status: "baked" });
    expect(material.getNormalTexture()).not.toBeNull();
    expect(section.limitations.join("\n")).toContain("T_BarkNormal kept as the normal map, unverified:");
    expect(section.limitations.join("\n")).not.toContain("is a stale flattened normal");
  });

  it("keeps the bark map under a valid Distance that reads it, with no limitation", async () => {
    const kept = await importWithGraph({ graph: distanceNormalMaster({ A: pin("bark", [1, 1, 1, 0]), B: pin("three") }, [three]), normalTexture: "T_BarkNormal" });
    expect(kept.material.getNormalTexture()).not.toBeNull();
    expect(kept.report.models[0]!.materials[0]!.limitations.join("\n")).not.toContain("T_BarkNormal");
  });

  it("omits the bark map as stale under a valid Distance that reads only the leaf map", async () => {
    const stale = await importWithGraph({ graph: distanceNormalMaster({ A: pin("leaf", [1, 1, 1, 0]), B: pin("three") }, [three]), normalTexture: "T_BarkNormal" });
    expect(stale.material.getNormalTexture()).toBeNull();
    expect(stale.report.models[0]!.materials[0]!.limitations.join("\n")).toContain("T_BarkNormal is a stale flattened normal, omitted");
  });
});

describe("the input glTF normal map beside a flattened normal the graph does not read", () => {
  // The flattened Bark binding is stale (the graph's Normal reads only the leaf map). The input glTF material's own normal map is judged
  // on its own identity: it is never cleared just because the binding is stale.
  it("keeps an input map the graph reads, drops only the stale binding, and leaves the rest of the import unchanged", async () => {
    const reference = await importWithGraph({ graph: normalMaster("leaf"), inputNormalTexture: "T_LeafNormal" });
    const stale = await importWithGraph({ graph: normalMaster("leaf"), normalTexture: "T_BarkNormal", inputNormalTexture: "T_LeafNormal" });
    // The final normal slot holds the input map: the stale binding is not attached to it after the input map is kept.
    expect(stale.material.getNormalTexture()?.getName()).toBe("T_LeafNormal");
    expect(stale.material.getNormalTexture()?.getImage()).toEqual(reference.material.getNormalTexture()?.getImage());
    const limitations = stale.report.models[0]!.materials[0]!.limitations.join("\n");
    expect(limitations).toContain("T_BarkNormal is a stale flattened normal, omitted");
    expect(limitations).toContain("the section keeps its input glTF normal map");
    expect(limitations).not.toContain("so the section has no normal map");
    expect(limitations).toContain("T_LeafNormal kept as the input normal map");
    expect(limitations).toContain("matched by basename only");
    expect(stale.onDisk.models[0]!.materials[0]!.limitations.join("\n")).toContain("T_BarkNormal is a stale flattened normal, omitted");
    expect(stale.glb.getRoot().listTextures()).toHaveLength(reference.glb.getRoot().listTextures().length);
    expect(stale.material.getBaseColorTexture()?.getImage()).toEqual(reference.material.getBaseColorTexture()?.getImage());
    const positions = (glb: typeof reference.glb) => glb.getRoot().listMeshes()[0]!.listPrimitives()[0]!.getAttribute("POSITION")!.getArray();
    expect(positions(stale.glb)).toEqual(positions(reference.glb));
  });

  it("clears an input map whose identity is the stale binding the graph does not read", async () => {
    const stale = await importWithGraph({ graph: normalMaster("leaf"), normalTexture: "T_BarkNormal", inputNormalTexture: "T_BarkNormal" });
    expect(stale.material.getNormalTexture()).toBeNull();
    expect(stale.report.models[0]!.materials[0]!.limitations.join("\n")).toContain("T_BarkNormal is a stale flattened normal, omitted");
  });

  it("keeps an input map with no source name, and says it is unverified", async () => {
    const unnamed = await importWithGraph({ graph: normalMaster("leaf"), normalTexture: "T_BarkNormal", inputNormalTexture: "" });
    expect(unnamed.material.getNormalTexture()).not.toBeNull();
    expect(unnamed.report.models[0]!.materials[0]!.limitations.join("\n")).toContain("kept as the normal map, unverified:");
  });

  it("keeps an input map whose name matches neither a read texture nor the dropped binding, and says it is unverified", async () => {
    const other = await importWithGraph({ graph: normalMaster("leaf"), normalTexture: "T_BarkNormal", inputNormalTexture: "T_OtherNormal" });
    expect(other.material.getNormalTexture()?.getName()).toBe("T_OtherNormal");
    expect(other.report.models[0]!.materials[0]!.limitations.join("\n")).toContain("T_OtherNormal kept as the normal map, unverified: it matches neither");
  });
});

function emissionMaster(options: { switchStored?: boolean; glowOnly?: boolean; truncated?: boolean; equalBounds?: boolean } = {}): MaterialGraph {
  const stored = options.switchStored ?? false;
  const nodes: Raw[] = [
    node("mask", "TextureSampleParameter2D", { parameter: { name: "Mask", group: "" }, default: null, texture: "/Game/Test/T_MasterMask.T_MasterMask", samplerType: "Masks" }),
    node("tint", "Constant3Vector", { constants: { Constant: [0.5, 0.25, 1, 1] } }),
    node("mul", "Multiply", { inputs: { A: pin("mask", [1, 1, 1, 0]), B: pin("tint") } }),
    node("glow", "VectorParameter", { parameter: { name: "EmissiveColor", group: "" }, default: [1, 1, 1, 0] }),
    node("zero", "Constant3Vector", { constants: { Constant: [0, 0, 0, 1] } }),
    node("switch", "StaticSwitchParameter", { parameter: { name: "Emissive", group: "6 Emissive" }, default: stored, switchValue: stored, inputs: { A: pin("glow"), B: pin("zero") } }),
    ...(options.equalBounds
      ? [
          node("lo", "ScalarParameter", { parameter: { name: "Lo", group: "" }, default: 0.5 }),
          node("hi", "ScalarParameter", { parameter: { name: "Hi", group: "" }, default: 0.5 }),
          node("v", "Constant", { constants: { R: 0.25 } }),
          node("step", "SmoothStep", { inputs: { Min: pin("lo"), Max: pin("hi"), Value: pin("v") } }),
        ]
      : []),
    node("make", "MakeMaterialAttributes", { inputs: { BaseColor: pin("mul"), EmissiveColor: pin(options.equalBounds ? "step" : options.glowOnly ? "glow" : "switch") } }),
  ];
  return materialGraphSchema.parse({
    format: 1,
    material: "M_Master",
    package: "/Game/Test/M_Master",
    truncated: options.truncated ?? false,
    nodeCount: nodes.length,
    outputs: { baseColor: null, roughness: null, metallic: null, emissive: null, opacity: null, opacityMask: null, normal: null, materialAttributes: pin("make") },
    nodes,
  });
}

describe("importUnrealDirectory emission proof", () => {
  it("drops a stale white EmissiveColor the graph proves zero: the Emissive switch is off and no other path draws it", async () => {
    const { report, onDisk, material } = await importWithGraph({ graph: emissionMaster(), collectedEmissive: [1, 1, 1, 0] });
    expect(material.getEmissiveFactor()).toEqual([0, 0, 0]);
    for (const reported of [report, onDisk]) {
      expect(reported.models[0]!.materials[0]!.limitations.join("\n")).toContain("source-proven zero emission");
    }
  });

  it("drops a stale Emissive texture with the factor, and nothing later reintroduces the factor", async () => {
    const { material } = await importWithGraph({ graph: emissionMaster(), collectedEmissive: [1, 1, 1, 0], emissiveTexture: true });
    expect(material.getEmissiveTexture()).toBeNull();
    expect(material.getEmissiveFactor()).toEqual([0, 0, 0]);
  });

  it("keeps the stale EmissiveColor when the instance overrides the Emissive switch on", async () => {
    const { report, material } = await importWithGraph({ graph: emissionMaster(), collectedEmissive: [1, 1, 1, 0], switchOverride: true });
    expect(material.getEmissiveFactor()).toEqual([1, 1, 1]);
    expect(report.models[0]!.materials[0]!.limitations.join("\n")).not.toContain("source-proven zero emission");
  });

  it("keeps it when the stored switch is on, and when the graph's EmissiveColor is a glow with no switch", async () => {
    for (const graph of [emissionMaster({ switchStored: true }), emissionMaster({ glowOnly: true })]) {
      const { material } = await importWithGraph({ graph, collectedEmissive: [1, 1, 1, 0] });
      expect(material.getEmissiveFactor()).toEqual([1, 1, 1]);
    }
  });

  it("keeps it when the graph cannot be read in full", async () => {
    const { material } = await importWithGraph({ graph: emissionMaster({ truncated: true }), collectedEmissive: [1, 1, 1, 0] });
    expect(material.getEmissiveFactor()).toEqual([1, 1, 1]);
  });

  // Equal parameter bounds: the bake refuses the SmoothStep, so the proof is not made and the stale factor and texture stay.
  it("keeps the stale emissive factor and texture when EmissiveColor is a SmoothStep of two equal parameters", async () => {
    const { report, material } = await importWithGraph({ graph: emissionMaster({ equalBounds: true }), collectedEmissive: [1, 1, 1, 0], emissiveTexture: true });
    expect(material.getEmissiveFactor()).toEqual([1, 1, 1]);
    expect(material.getEmissiveTexture()).not.toBeNull();
    expect(report.models[0]!.materials[0]!.limitations.join("\n")).not.toContain("source-proven zero emission");
  });

  // The resolver metadata never carries the input glTF material's own emissive slots, so those must trigger the probe too.
  it("drops an emissive factor the input glTF material carries, the slot the resolver metadata never sees", async () => {
    const { material } = await importWithGraph({ graph: emissionMaster(), inputEmissive: { factor: [1, 0.5, 0.2] } });
    expect(material.getEmissiveFactor()).toEqual([0, 0, 0]);
    expect(material.getEmissiveTexture()).toBeNull();
  });

  it("drops an emissive texture the input glTF material carries, alone and together with a factor", async () => {
    const textureOnly = await importWithGraph({ graph: emissionMaster(), inputEmissive: { texture: true } });
    expect(textureOnly.material.getEmissiveTexture()).toBeNull();
    expect(textureOnly.material.getEmissiveFactor()).toEqual([0, 0, 0]);
    const both = await importWithGraph({ graph: emissionMaster(), inputEmissive: { factor: [1, 0.5, 0.2], texture: true } });
    expect(both.material.getEmissiveTexture()).toBeNull();
    expect(both.material.getEmissiveFactor()).toEqual([0, 0, 0]);
  });

  it("keeps the input glTF emission when the graph's emission is active, and when the proof is unavailable", async () => {
    const active = await importWithGraph({ graph: emissionMaster({ glowOnly: true }), inputEmissive: { factor: [1, 0.5, 0.2], texture: true } });
    expect(active.material.getEmissiveFactor()).toEqual([1, 0.5, 0.2]);
    expect(active.material.getEmissiveTexture()).not.toBeNull();
    const unknown = await importWithGraph({ graph: emissionMaster({ truncated: true }), inputEmissive: { factor: [1, 0.5, 0.2], texture: true } });
    expect(unknown.material.getEmissiveFactor()).toEqual([1, 0.5, 0.2]);
    expect(unknown.material.getEmissiveTexture()).not.toBeNull();
  });

  // With no toolchain and auto-install off, the proof is unavailable rather than attempted: a section with a resolved base
  // colour and stale emission keeps both, and the import provisions nothing.
  it("preserves an existing base colour and stale emission when an empty toolchain cannot prove zero, installing nothing", async () => {
    const { report, material, toolchain, leftovers } = await importWithGraph({
      graph: emissionMaster(),
      collectedEmissive: [1, 1, 1, 0],
      inputBaseColorTexture: true,
      emptyToolchain: true,
    });
    expect(material.getBaseColorTexture()).not.toBeNull();
    expect(material.getEmissiveFactor()).toEqual([1, 1, 1]);
    const section = report.models[0]!.materials[0]!;
    expect(section.limitations.join("\n")).not.toContain("source-proven zero emission");
    // Nothing was installed: the toolchain root stayed empty and no .NET/CUE4Parse or converter cache appeared.
    expect(toolchain).toEqual([]);
    expect(leftovers.filter((entry) => /toolchain|dotnet|cue4parse|\.engine-|converter/i.test(entry))).toEqual([]);
  });
});

// An /Engine/ texture reference is answered by the configured engine content alone. The pack's namesake and a same-named PNG
// the mesh export carried never stand in for it, and a reference that is refused or fails is unresolved, with no fallback.
describe("an /Engine/ texture reference is answered by engine content alone", () => {
  const ENGINE_T_ROCK = "/Engine/Textures/T_Rock.T_Rock";
  // The engine PNG (80, 160, 240) decoded linearly, as SRGB=False asks: a Color sample of it bakes back to these bytes.
  const linearEngine = [encode(80 / 255), encode(160 / 255), encode(240 / 255)];

  it("exports the named package from the configured engine root, decodes it with its own sRGB flag, and never reads the pack's namesake", async () => {
    const { report, material, dumped, leftovers, engineDir } = await importWithGraph({
      graph: colourGraph(ENGINE_T_ROCK),
      noInstanceOverrides: true,
      packNamesake: true,
      engine: { srgb: false },
      packEngine: "UE_5.8",
    });
    expect(await firstPixel(material.getBaseColorTexture()!.getImage()!)).toEqual(linearEngine);
    expect(report.models[0]!.materials[0]!.graph).toMatchObject({ status: "baked", confidence: "exact" });
    expect(exactExports(dumped)).toEqual([[engineDir, "--export-dir", expect.any(String), "--exact-reference", ENGINE_T_ROCK, "--engine", "5.8"]]);
    expect(filterExports(dumped, "T_Rock")).toEqual([]);
    expect(leftovers.filter((entry) => entry.includes("graph-textures"))).toEqual([]);
  });

  it("keeps the engine content export on its configured version, never the pack's format hint", async () => {
    const { report, dumped, engineDir } = await importWithGraph({
      graph: colourGraph(ENGINE_T_ROCK),
      noInstanceOverrides: true,
      packNamesake: true,
      engine: { srgb: false },
      packEngine: "UE_5.8",
      formatHint: "UE_5.1",
    });
    expect(report.models[0]!.materials[0]!.graph).toMatchObject({ status: "baked", confidence: "exact" });
    // The engine root has its own version, so its one run names that version and no hinted profile.
    expect(exactExports(dumped)).toEqual([[engineDir, "--export-dir", expect.any(String), "--exact-reference", ENGINE_T_ROCK, "--engine", "5.8"]]);
  });

  it("is unresolved when no engine content is configured, with no fallback to the pack", async () => {
    const { report, material, dumped } = await importWithGraph({ graph: colourGraph(ENGINE_T_ROCK), noInstanceOverrides: true, packNamesake: true });
    expect(material.getBaseColorTexture()).toBeNull();
    expect(report.models[0]!.materials[0]!.graph).toMatchObject({ status: "unavailable" });
    expect(exactExports(dumped)).toEqual([]);
    expect(filterExports(dumped, "T_Rock")).toEqual([]);
  });

  it.each([
    ["a failed export", { srgb: false, exitCode: 1 }],
    ["an export that writes no PNG", { srgb: false, writePng: false }],
  ])("is unresolved after one attempt on %s, with no retry and no pack fallback", async (_label, engine) => {
    const { report, material, dumped, engineDir } = await importWithGraph({ graph: colourGraph(ENGINE_T_ROCK), noInstanceOverrides: true, packNamesake: true, engine });
    expect(material.getBaseColorTexture()).toBeNull();
    expect(report.models[0]!.materials[0]!.graph).toMatchObject({ status: "unavailable" });
    expect(exactExports(dumped)).toEqual([[engineDir, "--export-dir", expect.any(String), "--exact-reference", ENGINE_T_ROCK, "--engine", "5.8"]]);
    expect(filterExports(dumped, "T_Rock")).toEqual([]);
  });

  it.each([
    ["a parent segment", "/Engine/../Game/Test/T_Rock.T_Rock"],
    ["an object that is not the package's own", "/Engine/Textures/T_Rock.T_Other"],
    ["an object that differs only in case", "/Engine/Textures/T_Rock.t_rock"],
    ["a prefix that differs only in case", "/engine/Textures/T_Rock.T_Rock"],
    ["a class other than Texture2D", "StaticMesh'/Engine/Textures/T_Rock.T_Rock'"],
    ["no object", "/Engine/Textures/T_Rock"],
    ["raw leading and trailing whitespace", "  /Engine/Textures/T_Rock.T_Rock  "],
    ["mixed separators", "/Engine\\Textures/T_Rock.T_Rock"],
    ["an all-backslash path", "\\Engine\\Textures\\T_Rock.T_Rock"],
    ["repeated separators", "/Engine//Textures/T_Rock.T_Rock"],
  ])("refuses %s without asking the converter or the pack", async (_label, reference) => {
    const { report, material, dumped } = await importWithGraph({ graph: colourGraph(reference), noInstanceOverrides: true, packNamesake: true, engine: { srgb: false } });
    expect(material.getBaseColorTexture()).toBeNull();
    expect(report.models[0]!.materials[0]!.graph).toMatchObject({ status: "unavailable" });
    expect(exactExports(dumped)).toEqual([]);
    expect(filterExports(dumped, "T_Rock")).toEqual([]);
  });

  it("names the engine texture it read only when the pack's version is unknown or another, as the function note does", async () => {
    const unknown = await importWithGraph({ graph: colourGraph(ENGINE_T_ROCK), noInstanceOverrides: true, engine: { srgb: false } });
    expect(unknown.report.models[0]!.materials[0]!.graph).toMatchObject({ status: "baked", confidence: "heuristic" });
    expect(unknown.report.models[0]!.materials[0]!.graph!.approximations).toEqual([
      "T_Rock read from engine content 5.8 (/Engine/Textures/T_Rock); the pack's Unreal version is unknown",
    ]);
    expect(await firstPixel(unknown.material.getBaseColorTexture()!.getImage()!)).toEqual(linearEngine);
    const other = await importWithGraph({ graph: colourGraph(ENGINE_T_ROCK), noInstanceOverrides: true, engine: { srgb: false }, packEngine: "UE_5.7" });
    expect(other.report.models[0]!.materials[0]!.graph!.approximations).toEqual([
      "T_Rock read from engine content 5.8 (/Engine/Textures/T_Rock); the pack is 5.7",
    ]);
  });

  it("runs the converter once for one package, however its reference is spelt", async () => {
    const graph = materialGraphSchema.parse({
      format: 1,
      material: "M_Master",
      package: "/Game/Test/M_Master",
      truncated: false,
      nodeCount: 3,
      outputs: { baseColor: pin("mul"), roughness: null, metallic: null, emissive: null, opacity: null, opacityMask: null, normal: null, materialAttributes: null },
      nodes: [
        node("plain", "TextureSampleParameter2D", { parameter: { name: "Plain", group: "" }, default: null, texture: ENGINE_T_ROCK, samplerType: "Color" }),
        node("quoted", "TextureSampleParameter2D", { parameter: { name: "Quoted", group: "" }, default: null, texture: `Texture2D'${ENGINE_T_ROCK}'`, samplerType: "Color" }),
        node("mul", "Multiply", { inputs: { A: pin("plain"), B: pin("quoted") } }),
      ],
    });
    const { material, dumped } = await importWithGraph({ graph, noInstanceOverrides: true, engine: { srgb: false } });
    expect(material.getBaseColorTexture()).not.toBeNull();
    expect(exactExports(dumped)).toHaveLength(1);
  });

  it("exports nothing for an engine texture the bake never samples, so it adds no note", async () => {
    const { report, dumped } = await importWithGraph({ graph: colourGraph(ENGINE_T_ROCK, { sampled: false }), noInstanceOverrides: true, engine: { srgb: false } });
    expect(exactExports(dumped)).toEqual([]);
    expect(report.models[0]!.materials[0]!.graph?.approximations ?? []).toEqual([]);
  });
});

describe("graph textures that only a material function references", () => {
  it("unit: the exporter is authoritative before assets.png, and a same-named PNG never stands in for it", async () => {
    const root = await scratch("graph-bake-export-");
    const content = join(root, "source", "Content", "Test");
    await mkdir(content, { recursive: true });
    await writeFile(join(content, "M_Master.uasset"), Buffer.alloc(16));
    await writePng(join(root, "T_Late.png"), [200, 100, 50, 255], 4);
    const requested: string[] = [];
    const make = (exportTexture: (name: string, reference?: string) => Promise<string | undefined>) =>
      createGraphBaker({ sourceDir: join(root, "source"), maxTextureSize: 4, exportTexture, dumpGraphs: async () => new Map([["M_Master", masterGraph("mask-tint", "T_Late")]]) })!;
    const request = { materialName: "M_Master", lookupName: "M_Master", assets: { png: new Map<string, string>() }, readProps: () => undefined };
    const baked = await make(async (name, reference) => {
      requested.push(name);
      expect(reference).toContain("T_Late");
      return join(root, "T_Late.png");
    })(request);
    expect(baked.status).toBe("baked");
    expect(requested).toEqual(["T_Late"]);
    const failed = await make(async () => undefined)(request);
    expect(failed).toMatchObject({ status: "unavailable" });
    expect(failed.status === "unavailable" && failed.reason).toContain("T_Late");
    // The exporter owns the answer: a same-named PNG the mesh export carried must not stand in when it cannot select the package.
    const asked: string[] = [];
    const present = await make(async (name) => {
      asked.push(name);
      return undefined;
    })({ ...request, assets: { png: new Map([["T_Late", join(root, "T_Late.png")]]) } });
    expect(present).toMatchObject({ status: "unavailable" });
    expect(asked).toEqual(["T_Late"]);
    // Without an exporter the caller's PNG map is the only binding.
    const plain = createGraphBaker({ sourceDir: join(root, "source"), maxTextureSize: 4, dumpGraphs: async () => new Map([["M_Master", masterGraph("mask-tint", "T_Late")]]) })!;
    const bound = await plain({ ...request, assets: { png: new Map([["T_Late", join(root, "T_Late.png")]]) } });
    expect(bound.status).toBe("baked");
  });

  it("importer: exports the one package on demand, bakes it, and leaves nothing behind", async () => {
    const { report, material, textureExports, leftovers } = await importWithGraph({ graph: masterGraph("mask-tint", "T_Hidden"), hiddenTexture: true });
    expect(material.getBaseColorTexture()).not.toBeNull();
    expect(await firstPixel(material.getBaseColorTexture()!.getImage()!)).toEqual([encode((80 / 255) * 0.5), encode((160 / 255) * 0.25), encode(240 / 255)]);
    expect(report.models[0]!.materials[0]!.graph).toMatchObject({ status: "baked" });
    expect(textureExports).toHaveLength(1);
    expect(textureExports[0]).toContain("-png");
    expect(textureExports[0]).toContain("Content/Test/T_Hidden");
    expect(leftovers.filter((entry) => entry.includes("graph-textures"))).toEqual([]);
  });

  const hiddenPixel = [encode((80 / 255) * 0.5), encode((160 / 255) * 0.25), encode(240 / 255)];

  it("importer: falls back to the modern converter when UE Viewer yields no PNG, serially, leaving nothing behind", async () => {
    const { report, material, textureExports, dumped, leftovers } = await importWithGraph({ graph: masterGraph("mask-tint", "T_Hidden"), hiddenTexture: true, hiddenVia: "converter" });
    expect(textureExports).toHaveLength(1); // UE Viewer was tried first, once
    expect(dumped.split("\n").filter((line) => line.includes("--filter"))).toHaveLength(1);
    expect(dumped).toContain("Content/Test/T_Hidden");
    expect(report.models[0]!.materials[0]!.graph).toMatchObject({ status: "baked" });
    expect(await firstPixel(material.getBaseColorTexture()!.getImage()!)).toEqual(hiddenPixel);
    expect(leftovers.filter((entry) => entry.includes("graph-textures") || entry.includes(".engine-"))).toEqual([]);
  });

  it("importer: a UE5 package header goes straight to the converter and UE Viewer never sees it", async () => {
    const { report, material, textureExports, dumped, leftovers } = await importWithGraph({ graph: masterGraph("mask-tint", "T_Hidden"), hiddenTexture: true, hiddenVia: "modern-header" });
    expect(textureExports).toEqual([]);
    expect(dumped).toContain("--filter");
    expect(report.models[0]!.materials[0]!.graph).toMatchObject({ status: "baked" });
    expect(await firstPixel(material.getBaseColorTexture()!.getImage()!)).toEqual(hiddenPixel);
    expect(leftovers.filter((entry) => entry.includes("graph-textures") || entry.includes(".engine-"))).toEqual([]);
  });

  it("importer: the graph's own texture export and the graph dump both run first under the format hint", async () => {
    const { report, material, dumped, leftovers } = await importWithGraph({
      graph: masterGraph("mask-tint", "T_Hidden"),
      hiddenTexture: true,
      hiddenVia: "modern-header",
      formatHint: "UE_5.1",
    });
    expect(report.models[0]!.materials[0]!.graph).toMatchObject({ status: "baked" });
    expect(await firstPixel(material.getBaseColorTexture()!.getImage()!)).toEqual(hiddenPixel);
    const runs = invocations(dumped);
    const dump = runs.filter((argv) => argv.includes("--dump-graphs"));
    expect(dump).toHaveLength(1);
    expect(dump[0]![dump[0]!.indexOf("--engine") + 1]).toBe("5.1");
    const exported = runs.filter((argv) => argv.includes("--filter") && argv[argv.indexOf("--filter") + 1]!.endsWith("T_Hidden"));
    expect(exported.map((argv) => (argv.includes("--engine") ? argv[argv.indexOf("--engine") + 1] : "auto"))).toEqual(["5.1"]);
    expect(leftovers.filter((entry) => entry.includes("graph-textures") || entry.includes(".engine-"))).toEqual([]);
  });
});

describe("the graph dump under a format hint", () => {
  const hidden = { graph: masterGraph("mask-tint", "T_Hidden"), hiddenTexture: true, hiddenVia: "modern-header" } as const;
  /** The `--engine` of every graph dump run, in order, `auto` for a run given none. */
  const dumpEngines = (dumped: string): string[] =>
    invocations(dumped)
      .filter((argv) => argv.includes("--dump-graphs"))
      .map((argv) => (argv.includes("--engine") ? argv[argv.indexOf("--engine") + 1]! : "auto"));
  const dumpOption = (dumped: string, flag: string): string | undefined => {
    const argv = invocations(dumped).find((run) => run.includes("--dump-graphs"));
    return argv?.[argv.indexOf(flag) + 1];
  };

  it("answers a profile mismatch of the hinted dump with the unhinted run it made before hints existed", async () => {
    const { report, dumped } = await importWithGraph({ ...hidden, formatHint: "UE_5.1", dumpFailure: { engine: "5.1" } });
    expect(report.models[0]!.materials[0]!.graph).toMatchObject({ status: "baked" });
    expect(dumpEngines(dumped)).toEqual(["5.1", "auto"]);
  });

  it("does not retry a dump failure that is not a profile mismatch", async () => {
    const { report, dumped } = await importWithGraph({ ...hidden, formatHint: "UE_5.1", dumpFailure: { engine: "5.1", unrelated: true } });
    expect(report.models[0]!.materials[0]!.graph).toMatchObject({ status: "unavailable" });
    expect(dumpEngines(dumped)).toEqual(["5.1"]);
  });

  it("keeps the one unhinted run when the hint is missing or names no fallback profile", async () => {
    for (const formatHint of [undefined, "UE_4.18", "UE_5.8", "not-an-engine"]) {
      const { dumped } = await importWithGraph({ ...hidden, ...(formatHint === undefined ? {} : { formatHint }) });
      expect(dumpEngines(dumped), String(formatHint)).toEqual(["auto"]);
    }
  });

  it("keeps the request's own engine, which the hint does not override", async () => {
    const { dumped } = await importWithGraph({ ...hidden, packEngine: "UE_5.4", formatHint: "UE_5.1" });
    expect(dumpEngines(dumped)).toEqual(["5.4"]);
  });

  it("hands the engine content version beside the hinted profile, never as it and never replaced by it", async () => {
    const reference = "/Engine/Textures/T_Rock.T_Rock";
    const options = { graph: colourGraph(reference), noInstanceOverrides: true, packNamesake: true, engine: { srgb: false } } as const;
    const hinted = await importWithGraph({ ...options, formatHint: "UE_5.1" });
    expect(dumpEngines(hinted.dumped)).toEqual(["5.1"]);
    expect(dumpOption(hinted.dumped, "--engine-content-version")).toBe("5.8");
    expect(exactExports(hinted.dumped)).toEqual([[hinted.engineDir, "--export-dir", expect.any(String), "--exact-reference", reference, "--engine", "5.8"]]);
    const plain = await importWithGraph(options);
    expect(dumpEngines(plain.dumped)).toEqual(["auto"]);
    expect(dumpOption(plain.dumped, "--engine-content-version")).toBe("5.8");
  });
});

// Converter 74: an intermediate instance whose .props.txt the export does not carry is read from its qualified record. The master's
// BaseColor is one static switch: branch A samples the flattened texture T_Stale, branch B is a constant green. UseDetail defaults to A.
function switchedColourGraph(detail = true): MaterialGraph {
  const nodes: Raw[] = [
    node("pick", "StaticSwitchParameter", { inputs: { A: pin("sampled"), B: pin("flat") }, parameter: { name: "UseDetail", group: "" }, default: detail }),
    textured("sampled", "T_Stale"),
    constant3("flat", [0, 1, 0]),
  ];
  return materialGraphSchema.parse({
    format: 1,
    material: "M_Master",
    package: "/Game/Test/M_Master",
    truncated: false,
    nodeCount: nodes.length,
    outputs: { baseColor: output("pick", 0), roughness: null, metallic: null, emissive: null, opacity: null, opacityMask: null, normal: null, materialAttributes: null },
    nodes,
  });
}
// One `StaticParameters` override row as UE Viewer writes it: the value, the parameter and bOverride.
const switchBlock = (name: string, value: boolean): string =>
  [
    "StaticParameters =",
    "{",
    "    StaticSwitchParameters[1] =",
    "    {",
    "        StaticSwitchParameters[0] =",
    "        {",
    `            Value = ${value}`,
    `            ParameterInfo = { Name=${name} }`,
    "            bOverride = true",
    "        }",
    "    }",
    "}",
  ].join("\n");
// The exported props of the child instance: its Parent line (UE Viewer spelling) and, optionally, its own switch override.
const childInstanceProps = (parentPath: string, switchValue: boolean | undefined): string =>
  [`Parent = MaterialInstanceConstant'${parentPath}.MI_Mid'`, ...(switchValue === undefined ? [] : [switchBlock("UseDetail", switchValue)])].join("\n");
// A record as the converter writes it: the instance's own overrides and its qualified parent, with the matching Parent line.
const instanceRecord = (object: string, props: string, options: { package?: string; parent?: string | null } = {}): Record<string, unknown> => {
  const parent = options.parent === undefined ? "M_Master" : options.parent;
  return {
    format: 1,
    kind: "materialInstance",
    package: `${options.package ?? "/Game/Test"}/${object}`,
    object,
    parent: parent === null ? null : { package: `/Game/Test/${parent}`, object: parent },
    complete: true,
    props: parent === null ? props : `Parent = Material'/Game/Test/${parent}.${parent}'\n${props}`,
    refusal: null,
  };
};
const refusedInstance = (object: string): Record<string, unknown> => ({
  format: 1,
  kind: "materialInstance",
  package: `/Game/Test/${object}`,
  object,
  parent: { package: "/Game/Test/M_Master", object: "M_Master" },
  complete: false,
  props: null,
  refusal: "ScalarParameterValues row is a LayerParameter parameter, and only global parameters are supported",
});
// A fake converter that writes `files` into its --dump-graphs directory and copies `textureFrom/<name>.png` for an --export-dir request.
async function writeRecordConverter(path: string, files: Record<string, string>, argvLog: string, textureFrom: string): Promise<void> {
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
  for (const [name, text] of Object.entries(${JSON.stringify(files)})) fs.writeFileSync(join(argv[at + 1], name), text);
  process.exit(0);
}
const exportAt = argv.indexOf("--export-dir");
const filterAt = argv.indexOf("--filter");
if (exportAt >= 0 && filterAt >= 0) {
  const name = argv[filterAt + 1].split("/").pop();
  const source = join(${JSON.stringify(textureFrom)}, name + ".png");
  if (fs.existsSync(source)) {
    fs.mkdirSync(join(argv[exportAt + 1], "Textures"), { recursive: true });
    fs.copyFileSync(source, join(argv[exportAt + 1], "Textures", name + ".png"));
  }
}
process.exit(0);
`,
  );
  await chmod(path, 0o755);
}

describe("createGraphBaker reads an intermediate parent from its exact qualified record", () => {
  async function probe(options: { files: Record<string, string>; props: Record<string, string> }) {
    const root = await scratch("graph-bake-records-");
    const sourceDir = join(root, "source");
    await mkdir(join(sourceDir, "Content", "Test"), { recursive: true });
    await writeFile(join(sourceDir, "Content", "Test", "MI_Child.uasset"), Buffer.alloc(16));
    const converter = join(root, "converter");
    await writeRecordConverter(converter, { "M_Master.graph.json": JSON.stringify(switchedColourGraph()), ...options.files }, join(root, "argv.log"), root);
    const baker = createGraphBaker({
      sourceDir,
      maxTextureSize: 8,
      environment: withoutEngineContent(process.env),
      modernConverter: { name: "modern", path: converter, version: "fake-converter 1" },
    })!;
    return baker({
      materialName: "MI_Child_section",
      lookupName: "MI_Child",
      assets: { png: new Map() },
      readProps: (name) => options.props[name],
      probe: true,
    });
  }
  const recordFiles = (object: string, value: boolean, packageName?: string): Record<string, string> => ({
    [`${object}.instance.json`]: JSON.stringify(instanceRecord(object, switchBlock("UseDetail", value), packageName === undefined ? {} : { package: packageName })),
  });

  it("takes the recovered intermediate's switch when the child names none", async () => {
    const outcome = await probe({ files: recordFiles("MI_Mid", false), props: { MI_Child: childInstanceProps("Content/Test/MI_Mid", undefined) } });
    expect(outcome).toMatchObject({ switchOverridden: true, baseColourTextures: [] });
  });

  it("lets the child's own switch value beat the recovered intermediate's", async () => {
    const outcome = await probe({ files: recordFiles("MI_Mid", false), props: { MI_Child: childInstanceProps("Content/Test/MI_Mid", true) } });
    expect(outcome).toMatchObject({ switchOverridden: true, baseColourTextures: ["T_Stale"] });
  });

  it("uses a complete native parent and never consults a record for it", async () => {
    const outcome = await probe({
      files: recordFiles("MI_Mid", false),
      props: {
        MI_Child: childInstanceProps("Content/Test/MI_Mid", undefined),
        MI_Mid: `Parent = Material'/Game/Test/M_Master.M_Master'\n${switchBlock("UseDetail", true)}`,
      },
    });
    expect(outcome).toMatchObject({ baseColourTextures: ["T_Stale"] });
  });

  it("never substitutes a same-named record from another package, and says that no record matches", async () => {
    const outcome = await probe({ files: recordFiles("MI_Mid", false, "/Game/Other"), props: { MI_Child: childInstanceProps("Content/Test/MI_Mid", undefined) } });
    expect(outcome).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/MI_Mid.*instance record/) });
    expect(outcome).not.toHaveProperty("switchOverridden");
  });

  it("carries the converter's refusal of the intermediate as the reason", async () => {
    const outcome = await probe({
      files: { "MI_Mid.instance.json": JSON.stringify(refusedInstance("MI_Mid")) },
      props: { MI_Child: childInstanceProps("Content/Test/MI_Mid", undefined) },
    });
    expect(outcome).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/LayerParameter/) });
  });

  it("carries a malformed record's shape reason rather than a bare 'no dumped graph'", async () => {
    const outcome = await probe({
      files: { "MI_Mid.instance.json": JSON.stringify({ format: 1, kind: "materialInstance", package: "/Game/Test/MI_Mid", object: "MI_Mid" }) },
      props: { MI_Child: childInstanceProps("Content/Test/MI_Mid", undefined) },
    });
    expect(outcome).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/unexpected shape/) });
  });

  it("never bakes an /Engine/ parent from a /Game/Engine/ namesake's record", async () => {
    const outcome = await probe({
      files: recordFiles("MI_Mid", false, "/Game/Engine/A"),
      props: { MI_Child: childInstanceProps("/Engine/A/MI_Mid", undefined) },
    });
    expect(outcome).not.toHaveProperty("switchOverridden");
    expect(outcome).toMatchObject({ status: "unavailable", reason: expect.stringContaining("no instance record for /Engine/A/MI_Mid") });
  });

  it("never bakes a missing qualified master from a namesake in another mount", async () => {
    const outcome = await probe({
      files: { "M_Master.graph.json": JSON.stringify({ ...switchedColourGraph(), package: "/Game/Wrong/M_Master" }) },
      props: { MI_Child: "Parent = Material'/Game/Required/M_Master.M_Master'" },
    });
    expect(outcome).toMatchObject({ status: "unavailable", reason: expect.stringContaining("no instance record for /Game/Required/M_Master") });
  });

  it("never bakes an unmounted parent from a /Game/ master of the same path", async () => {
    const outcome = await probe({
      files: { "M_Master.graph.json": JSON.stringify({ ...switchedColourGraph(), package: "/Game/SoulCave/M_Master" }) },
      props: { MI_Child: "Parent = Material'SoulCave/M_Master.M_Master'" },
    });
    expect(outcome).toMatchObject({ status: "unavailable", reason: expect.stringContaining("no instance record for SoulCave/M_Master") });
  });
});

describe("importUnrealDirectory judges a stale flattened base colour through an incomplete chain", () => {
  // The child's .mat binds the flattened T_Stale; its parent MI_Mid is not in the export, so the child's props alone cannot say which
  // branch the master's switch takes. Converter 74's records can.
  async function importChild(options: { childSwitch?: boolean; detail?: boolean; parentPath?: string; files?: Record<string, string> }) {
    const root = await scratch("graph-bake-child-");
    const sourceDir = join(root, "source");
    const content = join(sourceDir, "Content", "Test");
    const exported = join(root, "exported");
    const outputDir = join(root, "output");
    await mkdir(content, { recursive: true });
    for (const name of ["Mesh", "MI_Child", "M_Master", "T_Stale"]) await writeFile(join(content, `${name}.uasset`), Buffer.alloc(16));
    await writeMeshFixture(exported, {
      name: "Mesh",
      materialName: "MI_Child",
      mat: "Diffuse=T_Stale\n",
      props: childInstanceProps(options.parentPath ?? "Content/Test/MI_Mid", options.childSwitch),
      textures: ["T_Stale"],
    });
    await writePng(join(exported, "T_Stale.png"), [200, 120, 60, 255], 4);
    const umodel = join(root, "umodel");
    await writeFakeUmodel(umodel, { exportFrom: exported, classes: { Mesh: ["StaticMesh"] } });
    const converter = join(root, "converter");
    await writeRecordConverter(
      converter,
      { "M_Master.graph.json": JSON.stringify(switchedColourGraph(options.detail ?? true)), ...(options.files ?? {}) },
      join(root, "converter.log"),
      exported,
    );
    const report = await importUnrealDirectory({
      sourceDir,
      outputDir,
      onlyPackages: ["Mesh"],
      concurrency: 1,
      freeSpaceBytes: 30_000_000_000,
      environment: { ...withoutEngineContent(process.env), THREENATIVE_UNREAL_CACHE_DIR: join(root, "cache") },
      umodel: { name: "umodel", path: umodel, version: "fixture" },
      modernConverter: { name: "modern", path: converter, version: "fake-converter 1" },
    });
    const converterLog = await readFile(join(root, "converter.log"), "utf8").catch(() => "");
    return { section: report.models[0]!.materials[0]!, dumped: converterLog.includes("--dump-graphs") };
  }

  it("drops the flattened base colour when the recovered switch takes a branch that does not sample it", async () => {
    const { section } = await importChild({ files: { "MI_Mid.instance.json": JSON.stringify(instanceRecord("MI_Mid", switchBlock("UseDetail", false))) } });
    expect(section.limitations.join("\n")).toContain("T_Stale dropped as base colour");
    expect(section.graph).toMatchObject({ status: "baked" });
  });

  it("keeps the flattened base colour without any unverified note when the child's own switch takes the branch that samples it", async () => {
    const { section } = await importChild({
      childSwitch: true,
      files: { "MI_Mid.instance.json": JSON.stringify(instanceRecord("MI_Mid", switchBlock("UseDetail", false))) },
    });
    expect(section.limitations.join("\n")).not.toContain("T_Stale");
    expect(section.bindings).toContainEqual(expect.objectContaining({ slot: "baseColor", texture: "T_Stale" }));
  });

  it("keeps the flattened base colour, with no note, when the recovered chain overrides no switch and the active branch samples it", async () => {
    // The master's default branch samples T_Stale, so the flattened binding is the active one whatever the switches say.
    const { section } = await importChild({ detail: true, files: { "MI_Mid.instance.json": JSON.stringify(instanceRecord("MI_Mid", "")) } });
    expect(section.limitations.join("\n")).not.toContain("T_Stale");
    expect(section.bindings).toContainEqual(expect.objectContaining({ slot: "baseColor", texture: "T_Stale" }));
  });

  it("drops the flattened base colour when no switch is overridden and the active branch does not sample it", async () => {
    // Nothing in the recovered chain overrides a switch, but the master's default (detail off) is the active branch and samples no
    // T_Stale: the flattened binding is wrong without any switch override, so the proven branch replaces it.
    const { section } = await importChild({ detail: false, files: { "MI_Mid.instance.json": JSON.stringify(instanceRecord("MI_Mid", "")) } });
    expect(section.limitations.join("\n")).toContain("T_Stale dropped as base colour");
    expect(section.graph).toMatchObject({ status: "baked" });
  });

  it("does not probe, or note, a flattened base colour whose parent is an engine master: no pack record could settle it", async () => {
    const { section, dumped } = await importChild({ parentPath: "/Engine/EngineMaterials/MI_Mid" });
    expect(dumped).toBe(false);
    expect(section.limitations.join("\n")).not.toContain("T_Stale");
    expect(section.bindings).toContainEqual(expect.objectContaining({ slot: "baseColor", texture: "T_Stale" }));
  });

  it("keeps a refused intermediate's flattened base colour, explicitly unverified, with the converter's reason", async () => {
    const { section } = await importChild({ files: { "MI_Mid.instance.json": JSON.stringify(refusedInstance("MI_Mid")) } });
    expect(section.limitations.join("\n")).toMatch(/T_Stale kept as base colour, unverified/);
    expect(section.limitations.join("\n")).toContain("LayerParameter");
    expect(section.bindings).toContainEqual(expect.objectContaining({ slot: "baseColor", texture: "T_Stale" }));
  });

  it("keeps the flattened base colour when the qualified master is missing and only a wrong-mount master exists", async () => {
    const { section } = await importChild({
      files: {
        "M_Master.graph.json": JSON.stringify({ ...switchedColourGraph(true), package: "/Game/Wrong/M_Master" }),
        "MI_Mid.instance.json": JSON.stringify(instanceRecord("MI_Mid", switchBlock("UseDetail", false))),
      },
    });
    expect(section.bindings).toContainEqual(expect.objectContaining({ slot: "baseColor", texture: "T_Stale" }));
  });
});

// graphNamed takes the graph a qualified request names, or nothing: a namesake of another package or mount is never taken for it.
describe("graphNamed takes only the graph a qualified request names", () => {
  const graphAt = (packagePath: string): MaterialGraph => ({ ...masterGraph(), material: "M_Master", package: packagePath });

  it("refuses a qualified miss, rather than the first namesake of another package", () => {
    expect(graphNamed(new Map([["M_Master", graphAt("/Game/Wrong/M_Master")]]), "M_Master", "/Game/Required/M_Master")).toBeUndefined();
  });

  it("never takes a namesake across mounts: /Engine/ is not the pack's /Game/Engine/", () => {
    expect(graphNamed(new Map([["M_Master", graphAt("/Game/Engine/M_Master")]]), "M_Master", "/Engine/M_Master")).toBeUndefined();
  });

  it("never takes an unmounted package for the /Game/ package of the same path", () => {
    expect(graphNamed(new Map([["M_Master", graphAt("/Game/SoulCave/M_Master")]]), "M_Master", "SoulCave/M_Master")).toBeUndefined();
  });

  it("refuses two exact matches rather than choosing one of them", () => {
    const graphs = new Map([
      ["M_Master", graphAt("/Game/Required/M_Master")],
      ["/Game/Required/M_Master", graphAt("/Game/Required/M_Master")],
    ]);
    expect(graphNamed(graphs, "M_Master", "/Game/Required/M_Master")).toBeUndefined();
  });

  it("finds the one exact match under the Content/ alias, past a wrong namesake", () => {
    const required = graphAt("/Game/Required/M_Master");
    const graphs = new Map([
      ["M_Master", graphAt("/Game/Wrong/M_Master")],
      ["/Game/Required/M_Master", required],
    ]);
    expect(graphNamed(graphs, "M_Master", "Content/Required/M_Master")).toBe(required);
  });

  it("keeps the unqualified lookup by name when the request names no package", () => {
    const first = graphAt("/Game/Wrong/M_Master");
    expect(graphNamed(new Map([["M_Master", first]]), "M_Master", undefined)).toBe(first);
  });
});

// The walk starts in the material's own package (`GraphBakeRequest.materialPackage`, from the mesh's import table), so a
// graph of another package that shares the material's name is never the section's colour. Synthetic packages only.
const namedMaterial = (name: string, packagePath: string, tint: number[]): MaterialGraph => ({
  ...masterGraph("mask-tint", "T_MasterMask", { package: packagePath, tint }),
  material: name,
});
const correctMasterColour = [encode((10 / 255) * 0.5), encode((10 / 255) * 0.25), encode(10 / 255)];
const instanceParentLine = "Parent = Material'/Game/Correct/M_Master.M_Master'";

describe("createGraphBaker starts the walk in the material's own package", () => {
  const namesake = namedMaterial("MI_Child", "/Game/Other/MI_Child", [1, 1, 1, 1]);
  const correctMaster = namedMaterial("M_Master", "/Game/Correct/M_Master", [0.5, 0.25, 1, 1]);
  const otherMaster = namedMaterial("M_Master", "/Game/Other/M_Master", [1, 1, 1, 1]);
  const readProps = (name: string): string | undefined => (name === "MI_Child" ? instanceParentLine : undefined);

  async function fixture() {
    const root = await scratch("graph-bake-own-package-");
    const sourceDir = join(root, "source");
    await mkdir(join(sourceDir, "Content", "Correct"), { recursive: true });
    await writeFile(join(sourceDir, "Content", "Correct", "MI_Child.uasset"), Buffer.alloc(16));
    await writePng(join(root, "T_MasterMask.png"), [10, 10, 10, 255], 4);
    return { sourceDir, assets: { png: new Map([["T_MasterMask", join(root, "T_MasterMask.png")]]) } };
  }

  it("bakes the section's own master, never a same-named graph of another package", async () => {
    const { sourceDir, assets } = await fixture();
    // The namesake is keyed by its name; the second M_Master is keyed by its package, as the dump keys a collision.
    const dumped = new Map([["MI_Child", namesake], ["M_Master", otherMaster], ["/Game/Correct/M_Master", correctMaster]]);
    const baker = createGraphBaker({ sourceDir, maxTextureSize: 8, dumpGraphs: async () => dumped })!;
    const outcome = await baker({ materialName: "MI_Child_section", lookupName: "MI_Child", materialPackage: "/Game/Correct/MI_Child", assets, readProps });
    if (outcome.status !== "baked") throw new Error(`expected a bake, got ${JSON.stringify(outcome)}`);
    expect(outcome.graphMaterial).toBe("M_Master");
    expect(await firstPixel(outcome.png)).toEqual(correctMasterColour);
  });

  it("is unavailable, never a namesake, when the section's master is absent from its own package", async () => {
    const { sourceDir, assets } = await fixture();
    const dumped = new Map([["MI_Child", namesake], ["M_Master", otherMaster]]);
    const baker = createGraphBaker({ sourceDir, maxTextureSize: 8, dumpGraphs: async () => dumped })!;
    const outcome = await baker({ materialName: "MI_Child_section", lookupName: "MI_Child", materialPackage: "/Game/Correct/MI_Child", assets, readProps });
    expect(outcome).toMatchObject({ status: "unavailable", reason: expect.stringContaining("/Game/Correct/M_Master") });
  });

  it("keeps the by-name start for a caller that names no package, when the name is unique", async () => {
    const { sourceDir, assets } = await fixture();
    const own = namedMaterial("MI_Child", "/Game/Correct/MI_Child", [0.5, 0.25, 1, 1]);
    const baker = createGraphBaker({ sourceDir, maxTextureSize: 8, dumpGraphs: async () => new Map([["MI_Child", own]]) })!;
    const outcome = await baker({ materialName: "MI_Child_section", lookupName: "MI_Child", assets, readProps: () => undefined });
    if (outcome.status !== "baked") throw new Error(`expected a bake, got ${JSON.stringify(outcome)}`);
    expect(outcome.graphMaterial).toBe("MI_Child");
    expect(await firstPixel(outcome.png)).toEqual(correctMasterColour);
  });
});

describe("packageGlb takes a section's graph from the import table's package", () => {
  // One primitive whose material is `section`, with its `.props.txt` naming the correct master. The caller supplies the dump.
  async function packSection(options: {
    readonly dumped: Map<string, MaterialGraph>;
    readonly section?: string;
    readonly materialPackages?: ReadonlyMap<string, string>;
    readonly materialLookupNames?: ReadonlyMap<string, string>;
  }): Promise<Uint8Array | null> {
    const root = await scratch("graph-bake-package-own-");
    const sourceDir = join(root, "source");
    await mkdir(join(sourceDir, "Content", "Correct"), { recursive: true });
    await writeFile(join(sourceDir, "Content", "Correct", "MI_Child.uasset"), Buffer.alloc(16));
    await writePng(join(root, "T_MasterMask.png"), [10, 10, 10, 255], 4);
    const propsPath = join(root, "MI_Child.props.txt");
    await writeFile(propsPath, instanceParentLine);

    const document = new Document();
    const buffer = document.createBuffer();
    const accessor = (type: "VEC3" | "VEC2" | "SCALAR", array: Float32Array<ArrayBuffer> | Uint16Array<ArrayBuffer>) =>
      document.createAccessor().setType(type).setArray(array).setBuffer(buffer);
    const primitive = document
      .createPrimitive()
      .setAttribute("POSITION", accessor("VEC3", new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0])))
      .setAttribute("NORMAL", accessor("VEC3", new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1])))
      .setAttribute("TEXCOORD_0", accessor("VEC2", new Float32Array([0, 0, 1, 0, 1, 1, 0, 1])))
      .setIndices(accessor("SCALAR", new Uint16Array([0, 1, 2, 0, 2, 3])))
      .setMaterial(document.createMaterial(options.section ?? "MI_Child"));
    document.createScene("Scene").addChild(document.createNode("Mesh").setMesh(document.createMesh("Mesh").addPrimitive(primitive)));
    const gltfPath = join(root, "Mesh.gltf");
    await new NodeIO().write(gltfPath, document);

    const glbPath = join(root, "out.glb");
    await packageGlb({
      gltfPath,
      glbPath,
      keepAllUvSets: false,
      maxTextureSize: undefined,
      assets: {
        gltf: new Map(),
        psa: new Map(),
        mat: new Map(),
        props: new Map([["MI_Child", propsPath]]),
        png: new Map([["T_MasterMask", join(root, "T_MasterMask.png")]]),
        audio: new Map(),
        dna: new Map(),
      },
      graphBaker: createGraphBaker({ sourceDir, maxTextureSize: 8, dumpGraphs: async () => options.dumped })!,
      ...(options.materialPackages ? { materialPackages: options.materialPackages } : {}),
      ...(options.materialLookupNames ? { materialLookupNames: options.materialLookupNames } : {}),
    });
    const [material] = (await new NodeIO().read(glbPath)).getRoot().listMaterials();
    return material?.getBaseColorTexture()?.getImage() ?? null;
  }

  it("bakes the import table's master, never a namesake of another package", async () => {
    const image = await packSection({
      dumped: new Map([["MI_Child", namedMaterial("MI_Child", "/Game/Other/MI_Child", [1, 1, 1, 1])], ["/Game/Correct/M_Master", namedMaterial("M_Master", "/Game/Correct/M_Master", [0.5, 0.25, 1, 1])]]),
      materialPackages: new Map([["mi_child", "/Game/Correct/MI_Child"]]),
    });
    if (!image) throw new Error("expected a baked base colour on the packed section");
    expect(await firstPixel(image)).toEqual(correctMasterColour);
  });

  it("keys the import table by the lookup name a remapped section resolves to, not by the section's own name", async () => {
    const image = await packSection({
      section: "Section_A",
      materialLookupNames: new Map([["Section_A", "MI_Child"]]),
      dumped: new Map([["MI_Child", namedMaterial("MI_Child", "/Game/Other/MI_Child", [1, 1, 1, 1])], ["/Game/Correct/M_Master", namedMaterial("M_Master", "/Game/Correct/M_Master", [0.5, 0.25, 1, 1])]]),
      materialPackages: new Map([["mi_child", "/Game/Correct/MI_Child"]]),
    });
    if (!image) throw new Error("expected a baked base colour on the packed section");
    expect(await firstPixel(image)).toEqual(correctMasterColour);
  });

  it("leaves the section without a base colour, never a namesake, when the import table's master is absent", async () => {
    const image = await packSection({
      dumped: new Map([["MI_Child", namedMaterial("MI_Child", "/Game/Other/MI_Child", [1, 1, 1, 1])]]),
      materialPackages: new Map([["mi_child", "/Game/Correct/MI_Child"]]),
    });
    expect(image).toBeNull();
  });

  it("bakes a unique graph by name when the import table names no package for the section", async () => {
    const image = await packSection({
      dumped: new Map([["MI_Child", namedMaterial("MI_Child", "/Game/Correct/MI_Child", [0.5, 0.25, 1, 1])]]),
      materialPackages: new Map([["other_section", "/Game/Correct/Other"]]),
    });
    if (!image) throw new Error("expected a baked base colour on the packed section");
    expect(await firstPixel(image)).toEqual(correctMasterColour);
  });
});

// Exact-identity, stale-probe and material-library regressions. The graphs and records are the converter's own JSON, read by the real dump.
const graphWith = (nodes: Raw[], baseColor: string, packagePath = "/Game/Test/M_Master", material = "M_Master"): MaterialGraph =>
  materialGraphSchema.parse({
    format: 1,
    material,
    package: packagePath,
    truncated: false,
    nodeCount: nodes.length,
    outputs: { baseColor: pin(baseColor), roughness: null, metallic: null, emissive: null, opacity: null, opacityMask: null, normal: null, materialAttributes: null },
    nodes,
  });
// BaseColor = TextureSampleParameter2D "Albedo", defaulting to T_Stale: the parameter a recovered instance overrides with no switch.
const albedoMaster = (packagePath?: string): MaterialGraph =>
  graphWith([node("albedo", "TextureSampleParameter2D", { parameter: { name: "Albedo", group: "" }, default: null, texture: "/Game/Test/T_Stale.T_Stale", samplerType: "Color" })], "albedo", packagePath);
// BaseColor = a constant: the active path samples no texture at all.
const constantMaster = (rgb: number[], packagePath?: string, material?: string): MaterialGraph => graphWith([constant3("tint", rgb)], "tint", packagePath, material);
// BaseColor runs through a node class the evaluator does not know, so the active path is unknown.
const unsupportedMaster = (): MaterialGraph => graphWith([node("probe", "UnsupportedProbeNode")], "probe");
// A `TextureParameterValues` entry as UE Viewer writes it, or `None` for a value it cannot name.
const textureParameter = (name: string, texture: string | "None"): string =>
  [
    "TextureParameterValues[0] =",
    "{",
    "    ParameterInfo = { Name=None }",
    `    ParameterValue = ${texture === "None" ? "None" : `Texture2D'/Game/Test/${texture}.${texture}'`}`,
    `    ParameterName = ${name}`,
    "}",
  ].join("\n");

// Every graph file that claims one exact identity is refused when the baker reads the dump: no copy, nor a namesake of another
// package, is baked for it, and the reason names the duplicate. Through the real dump, from the converter's own graph files.
describe("createGraphBaker refuses an exact identity that two graph files claim", () => {
  const WRONG_NAMESPACE = namedMaterial("M_Master", "/Game/Other/M_Master", [1, 1, 1, 1]);
  const FIRST_CLAIM = namedMaterial("M_Master", "/Game/Required/M_Master", [0.2, 0.2, 0.2, 1]);
  const SECOND_CLAIM = namedMaterial("M_Master", "/Game/Required/M_Master", [0.8, 0.8, 0.8, 1]);
  const tinted = (rgb: number[]): number[] => rgb.map((channel) => encode((10 / 255) * channel));

  async function bakerOver(files: Record<string, MaterialGraph>) {
    const root = await scratch("graph-bake-duplicate-identity-");
    const sourceDir = join(root, "source");
    await mkdir(join(sourceDir, "Content", "Required"), { recursive: true });
    await writeFile(join(sourceDir, "Content", "Required", "M_Master.uasset"), Buffer.alloc(16));
    await writePng(join(root, "T_MasterMask.png"), [10, 10, 10, 255], 4);
    const converter = join(root, "converter");
    await writeRecordConverter(converter, Object.fromEntries(Object.entries(files).map(([name, graph]) => [name, JSON.stringify(graph)])), join(root, "argv.log"), root);
    const baker = createGraphBaker({
      sourceDir,
      maxTextureSize: 8,
      environment: withoutEngineContent(process.env),
      modernConverter: { name: "modern", path: converter, version: "fake-converter 1" },
    })!;
    const assets = { png: new Map([["T_MasterMask", join(root, "T_MasterMask.png")]]) };
    const request = (materialPackage: string) => ({ materialName: "M_Master_section", lookupName: "M_Master", materialPackage, assets, readProps: () => undefined });
    return { baker, request };
  }

  it("refuses the claimed master when a namesake of another package sorts first, and bakes neither claimant", async () => {
    // Three files, the namesake first: the second and third claim one identity, and the map used to keep only the last of them.
    const { baker, request } = await bakerOver({ "a-wrong.graph.json": WRONG_NAMESPACE, "b-exact.graph.json": FIRST_CLAIM, "c-duplicate.graph.json": SECOND_CLAIM });
    expect(await baker(request("/Game/Required/M_Master"))).toMatchObject({
      status: "unavailable",
      reason: expect.stringMatching(/duplicate identity: 2 graph files claim \/Game\/Required\/M_Master\.M_Master/),
    });
  });

  it("counts a Content/ alias and a case variant as claims of the same identity, under one duplicate reason", async () => {
    const alias = namedMaterial("M_Master", "/Content/Required/M_Master", [0.5, 0.5, 0.5, 1]);
    const variant = namedMaterial("M_Master", "/game/required/m_master", [0.6, 0.6, 0.6, 1]);
    const { baker, request } = await bakerOver({ "a.graph.json": FIRST_CLAIM, "b.graph.json": alias, "c.graph.json": variant });
    expect(await baker(request("/Game/Required/M_Master"))).toMatchObject({
      status: "unavailable",
      reason: expect.stringMatching(/duplicate identity: 3 graph files claim/),
    });
  });

  it("keeps a same-named master of another namespace bakeable for its own request, beside the refused pair", async () => {
    const { baker, request } = await bakerOver({ "a.graph.json": WRONG_NAMESPACE, "b.graph.json": FIRST_CLAIM });
    const other = await baker(request("/Game/Other/M_Master"));
    const required = await baker(request("/Game/Required/M_Master"));
    if (other.status !== "baked" || required.status !== "baked") throw new Error(`expected two bakes, got ${JSON.stringify([other, required])}`);
    expect(await firstPixel(other.png)).toEqual(tinted([1, 1, 1]));
    expect(await firstPixel(required.png)).toEqual(tinted([0.2, 0.2, 0.2]));
  });

  it("bakes a single exact graph as before", async () => {
    const { baker, request } = await bakerOver({ "a.graph.json": FIRST_CLAIM });
    const outcome = await baker(request("/Game/Required/M_Master"));
    if (outcome.status !== "baked") throw new Error(`expected a bake, got ${JSON.stringify(outcome)}`);
    expect(await firstPixel(outcome.png)).toEqual(tinted([0.2, 0.2, 0.2]));
  });

  it("is unavailable, never a namesake, when the requested namespace holds no graph", async () => {
    const { baker, request } = await bakerOver({ "a.graph.json": WRONG_NAMESPACE });
    expect(await baker(request("/Game/Required/M_Master"))).toMatchObject({ status: "unavailable", reason: expect.stringContaining("no dumped graph for M_Master") });
  });
});

// The importer's stale probe through packageGlb and the real baker. The section's .mat binds T_Stale and its props name MI_Mid, which has
// no native export, so the rest of the chain is the converter's record for MI_Mid. The PNG colours tell the sampled branches apart.
describe("packageGlb judges a flattened base colour by the active path, through a recovered parent", () => {
  const PIXELS: Record<string, number[]> = { T_Stale: [200, 120, 60], T_Right: [30, 160, 90], T_Native: [240, 220, 20] };

  async function packStale(options: { master: MaterialGraph; childProps?: string; recordProps: string }) {
    const root = await scratch("graph-bake-stale-package-");
    const sourceDir = join(root, "source");
    await mkdir(join(sourceDir, "Content", "Test"), { recursive: true });
    await writeFile(join(sourceDir, "Content", "Test", "MI_Child.uasset"), Buffer.alloc(16));
    const png = new Map<string, string>();
    for (const [name, rgb] of Object.entries(PIXELS)) {
      await writePng(join(root, `${name}.png`), [...rgb, 255], 4);
      png.set(name, join(root, `${name}.png`));
    }
    const mat = join(root, "MI_Child.mat");
    await writeFile(mat, "Diffuse=T_Stale\n");
    const props = join(root, "MI_Child.props.txt");
    await writeFile(props, options.childProps ?? childInstanceProps("/Game/Test/MI_Mid", undefined));
    const converter = join(root, "converter");
    await writeRecordConverter(
      converter,
      { "M_Master.graph.json": JSON.stringify(options.master), "MI_Mid.instance.json": JSON.stringify(instanceRecord("MI_Mid", options.recordProps)) },
      join(root, "argv.log"),
      root,
    );

    const document = new Document();
    const buffer = document.createBuffer();
    const accessor = (type: "VEC3" | "VEC2" | "SCALAR", array: Float32Array<ArrayBuffer> | Uint16Array<ArrayBuffer>) =>
      document.createAccessor().setType(type).setArray(array).setBuffer(buffer);
    const primitive = document
      .createPrimitive()
      .setAttribute("POSITION", accessor("VEC3", new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0])))
      .setAttribute("NORMAL", accessor("VEC3", new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1])))
      .setAttribute("TEXCOORD_0", accessor("VEC2", new Float32Array([0, 0, 1, 0, 1, 1, 0, 1])))
      .setIndices(accessor("SCALAR", new Uint16Array([0, 1, 2, 0, 2, 3])))
      .setMaterial(document.createMaterial("MI_Child"));
    document.createScene("Scene").addChild(document.createNode("Mesh").setMesh(document.createMesh("Mesh").addPrimitive(primitive)));
    const gltfPath = join(root, "Mesh.gltf");
    await new NodeIO().write(gltfPath, document);

    const glbPath = join(root, "out.glb");
    const packaged = await packageGlb({
      gltfPath,
      glbPath,
      keepAllUvSets: false,
      maxTextureSize: undefined,
      assets: { gltf: new Map(), psa: new Map(), mat: new Map([["MI_Child", mat]]), props: new Map([["MI_Child", props]]), png, audio: new Map(), dna: new Map() },
      graphBaker: createGraphBaker({
        sourceDir,
        maxTextureSize: 8,
        environment: withoutEngineContent(process.env),
        modernConverter: { name: "modern", path: converter, version: "fake-converter 1" },
      })!,
    });
    const [material] = (await new NodeIO().read(glbPath)).getRoot().listMaterials();
    const image = material?.getBaseColorTexture()?.getImage();
    return { section: packaged.sections[0]!, pixel: image ? await firstPixel(image) : undefined };
  }

  it("replaces the flattened base colour that a recovered texture override moves, and bakes the override's texture", async () => {
    const { section, pixel } = await packStale({ master: albedoMaster(), recordProps: textureParameter("Albedo", "T_Right") });
    expect(section.bindings).not.toContainEqual(expect.objectContaining({ slot: "baseColor", texture: "T_Stale" }));
    expect(section.limitations.join("\n")).toContain("T_Stale dropped as base colour");
    expect(pixel).toEqual(PIXELS.T_Right);
  });

  it("bakes the native child's own texture override, not the recovered parent's, when the two disagree", async () => {
    const { section, pixel } = await packStale({
      master: albedoMaster(),
      childProps: `${childInstanceProps("/Game/Test/MI_Mid", undefined)}\n${textureParameter("Albedo", "T_Native")}`,
      recordProps: textureParameter("Albedo", "T_Right"),
    });
    expect(section.limitations.join("\n")).toContain("T_Stale dropped as base colour");
    expect(section.limitations.join("\n")).toContain("T_Native");
    expect(pixel).toEqual(PIXELS.T_Native);
  });

  it("drops the flattened base colour when the active path samples no texture at all", async () => {
    const { section } = await packStale({ master: constantMaster([0, 1, 0, 1]), recordProps: "" });
    expect(section.limitations.join("\n")).toContain("T_Stale dropped as base colour");
  });

  it("drops the flattened base colour when the recovered parent's own switch takes a branch that samples none of it", async () => {
    const { section } = await packStale({ master: switchedColourGraph(true), recordProps: switchBlock("UseDetail", false) });
    expect(section.limitations.join("\n")).toContain("T_Stale dropped as base colour");
  });

  it("keeps the flattened base colour when the recovered parent's texture override is None, which proves nothing", async () => {
    const { section } = await packStale({ master: albedoMaster(), recordProps: textureParameter("Albedo", "None") });
    expect(section.limitations.join("\n")).not.toContain("T_Stale");
    expect(section.bindings).toContainEqual(expect.objectContaining({ slot: "baseColor", texture: "T_Stale" }));
  });

  it("keeps the flattened base colour, with no note, when the active path is unknown and no switch is overridden", async () => {
    const { section } = await packStale({ master: unsupportedMaster(), recordProps: "" });
    expect(section.limitations.join("\n")).not.toContain("T_Stale");
    expect(section.bindings).toContainEqual(expect.objectContaining({ slot: "baseColor", texture: "T_Stale" }));
    expect(section.graph).toBeUndefined();
  });

  it("keeps the flattened base colour unverified, with the unsupported status, when an overridden switch makes the unknown path a bake", async () => {
    const { section } = await packStale({ master: unsupportedMaster(), childProps: childInstanceProps("/Game/Test/MI_Mid", true), recordProps: "" });
    expect(section.bindings).toContainEqual(expect.objectContaining({ slot: "baseColor", texture: "T_Stale" }));
    expect(section.limitations.join("\n")).toMatch(/T_Stale kept as base colour, unverified/);
    expect(section.graph).toMatchObject({ status: "unsupported" });
  });

  it("keeps the flattened base colour unverified, and names the None it cannot read, when the child's own switch makes that None the active path", async () => {
    const { section } = await packStale({
      master: albedoMaster(),
      childProps: `${childInstanceProps("/Game/Test/MI_Mid", true)}\n${textureParameter("Albedo", "None")}`,
      recordProps: "",
    });
    expect(section.bindings).toContainEqual(expect.objectContaining({ slot: "baseColor", texture: "T_Stale" }));
    expect(section.limitations.join("\n")).toMatch(/T_Stale kept as base colour, unverified: .*Albedo/);
  });
});

// The material library packages each standalone material package on its own. Two packages share the basename MI_Same: each section must
// take the graph of its own qualified package, never a wrong-root namesake, and the native child's switch must beat the recovered parent's.
describe("importUnrealDirectory bakes a material-library section from its own qualified package", () => {
  it("bakes each same-named instance from its own master, never a namesake of another root", async () => {
    const root = await scratch("graph-bake-library-");
    const sourceDir = join(root, "source");
    await mkdir(join(sourceDir, "Content", "Left"), { recursive: true });
    await mkdir(join(sourceDir, "Content", "Right"), { recursive: true });
    await writeFile(join(sourceDir, "Content", "Left", "MI_Same.uasset"), Buffer.alloc(16));
    await writeFile(join(sourceDir, "Content", "Right", "MI_Same.uasset"), Buffer.alloc(16));
    // The Left master samples T_Stale from its own package: a graph texture is baked only from its exact source package.
    await writeFile(join(sourceDir, "Content", "Left", "T_Stale.uasset"), Buffer.alloc(16));
    // UE Viewer exports each duplicate-named package on its own: a stand-in per package, chosen by the package's folder.
    const leftFixture = join(root, "fixture-left");
    const rightFixture = join(root, "fixture-right");
    await mkdir(leftFixture, { recursive: true });
    await mkdir(rightFixture, { recursive: true });
    await writeFile(join(leftFixture, "MI_Same.props.txt"), childInstanceProps("/Game/Left/MI_Mid", true));
    await writeFile(join(rightFixture, "MI_Same.props.txt"), "Parent = Material'/Game/Right/M_Master.M_Master'");
    await writePng(join(leftFixture, "T_Stale.png"), [200, 120, 60, 255], 4);
    const classes = { MI_Same: ["MaterialInstanceConstant"] };
    const leftTool = join(root, "umodel-left");
    const rightTool = join(root, "umodel-right");
    await writeFakeUmodel(leftTool, { exportFrom: leftFixture, classes });
    await writeFakeUmodel(rightTool, { exportFrom: rightFixture, classes });
    const umodel = join(root, "umodel");
    await writeFile(
      umodel,
      `#!/usr/bin/env node
"use strict";
const { spawnSync } = require("node:child_process");
const argv = process.argv.slice(2);
const selector = argv.filter((entry) => !entry.startsWith("-")).pop() || "";
const tool = selector.includes("/Left/") ? ${JSON.stringify(leftTool)} : ${JSON.stringify(rightTool)};
process.exit(spawnSync(tool, argv, { stdio: "inherit" }).status ?? 1);
`,
    );
    await chmod(umodel, 0o755);

    const midRecord = {
      format: 1,
      kind: "materialInstance",
      package: "/Game/Left/MI_Mid",
      object: "MI_Mid",
      parent: { package: "/Game/Left/M_Master", object: "M_Master" },
      complete: true,
      props: `Parent = Material'/Game/Left/M_Master.M_Master'\n${switchBlock("UseDetail", false)}`,
      refusal: null,
    };
    const converter = join(root, "converter");
    await writeRecordConverter(
      converter,
      {
        // The Left master samples T_Stale only when its switch is on; the Right master is a constant; the namesake is a wrong-root UMaterial.
        "M_Master.graph.json": JSON.stringify({ ...switchedColourGraph(false), package: "/Game/Left/M_Master" }).replace("/Game/Test/T_Stale.T_Stale", "/Game/Left/T_Stale.T_Stale"),
        "M_Master_right.graph.json": JSON.stringify(constantMaster([0, 0, 1, 1], "/Game/Right/M_Master")),
        "MI_Same.graph.json": JSON.stringify(constantMaster([1, 0, 0, 1], "/Game/Wrong/MI_Same", "MI_Same")),
        "MI_Mid.instance.json": JSON.stringify(midRecord),
      },
      join(root, "argv.log"),
      root,
    );

    const outputDir = join(root, "output");
    await importUnrealDirectory({
      sourceDir,
      outputDir,
      concurrency: 1,
      freeSpaceBytes: 30_000_000_000,
      environment: { ...withoutEngineContent(process.env), THREENATIVE_UNREAL_CACHE_DIR: join(root, "cache") },
      umodel: { name: "umodel", path: umodel, version: "fixture" },
      modernConverter: { name: "modern", path: converter, version: "fake-converter 1" },
    });
    const library = await new NodeIO().read(join(outputDir, "Materials", "UnrealMaterialLibrary.glb"));
    const bases = new Map(library.getRoot().listMaterials().map((material) => [material.getName(), material.getBaseColorTexture()?.getImage() ?? null]));
    expect([...bases.keys()].sort()).toEqual(["Content/Left/MI_Same", "Content/Right/MI_Same"]);
    expect(await firstPixel(bases.get("Content/Right/MI_Same")!)).toEqual([0, 0, 255]);
    expect(await firstPixel(bases.get("Content/Left/MI_Same")!)).toEqual([200, 120, 60]);
  });
});

// ---------------------------------------------------------------------------------------------------------
// An unresolved native texture override (UE Viewer writes `None` for a texture it cannot name, so the exporter lost it) shadows what
// it replaces. It is recovered only from the same identity's complete qualified record, and only where that record names the
// parameter with a qualified texture. Fixtures are synthetic; the record shapes follow the converter's (`ParameterInfo` carries
// `Association = GlobalParameter`).
describe("an unresolved native texture override (None) shadows what it replaces, and is recovered only from its exact record", () => {
  // Each synthetic texture is a uniform 4x4 PNG, so a bake's first pixel is the colour it sampled.
  const PIXELS: Record<string, number[]> = {
    T_Master: [40, 80, 120],
    T_Other: [10, 10, 10],
    T_Mid: [200, 30, 30],
    T_Child: [30, 200, 30],
    T_Native: [60, 60, 200],
    T_Engine: [120, 240, 60],
  };
  const ENGINE_TEXTURE = "Texture2D'/Engine/EngineMaterials/T_Engine.T_Engine'";
  const MASTER_PARENT = "Material'/Game/Test/M_Master.M_Master'";
  const instanceParent = (object: string): string => `MaterialInstanceConstant'/Game/Test/${object}.${object}'`;
  const nativeProps = (parent: string, ...blocks: string[]): string => [`Parent = ${parent}`, ...blocks].join("\n");
  const nativeScalar = (name: string, value: number): string =>
    ["ScalarParameterValues[0] =", "{", `    ParameterInfo = { Name=${name} }`, `    ParameterValue = ${value}`, "}"].join("\n");
  // A record's override as the converter writes it: the value, then the parameter with its association.
  const recordTexture = (name: string, value: string, association = "GlobalParameter"): string =>
    [
      "TextureParameterValues[0] =",
      "{",
      `    ParameterValue = ${value}`,
      "    ParameterInfo =",
      "    {",
      `        Name = ${name}`,
      `        Association = ${association}`,
      "        Index = -1",
      "    }",
      "}",
    ].join("\n");
  const recordScalar = (name: string, value: number): string =>
    ["ScalarParameterValues[0] =", "{", `    ParameterValue = ${value}`, "    ParameterInfo =", "    {", `        Name = ${name}`, "        Association = GlobalParameter", "        Index = -1", "    }", "}"].join("\n");
  const collectedTexture = (name: string, texture: string): string =>
    ["CollectedTextureParameters[1] =", "{", "    CollectedTextureParameters[0] =", "    {", `        Texture = Texture2D'/Game/Test/${texture}.${texture}'`, `        Name = ${name}`, "        Group = None", "    }", "}"].join("\n");

  const textureParam = (id: string, name: string, texture: string): Raw =>
    node(id, "TextureSampleParameter2D", { parameter: { name, group: "" }, default: null, texture: `/Game/Test/${texture}.${texture}`, samplerType: "Color" });
  const scalarParam = (id: string, name: string, value: number): Raw => node(id, "ScalarParameter", { parameter: { name, group: "" }, default: value });
  function masterWith(nodes: Raw[], colour: string, extra: { readonly opacityMask?: string; readonly normal?: string } = {}): MaterialGraph {
    return materialGraphSchema.parse({
      format: 1,
      material: "M_Master",
      package: "/Game/Test/M_Master",
      truncated: false,
      nodeCount: nodes.length,
      outputs: {
        baseColor: output(colour, 0),
        roughness: null,
        metallic: null,
        emissive: null,
        opacity: null,
        opacityMask: extra.opacityMask === undefined ? null : output(extra.opacityMask, 0),
        normal: extra.normal === undefined ? null : output(extra.normal, 0),
        materialAttributes: null,
      },
      nodes,
    });
  }
  // BaseColor = the Mask texture parameter, whose node default is T_Master.
  const maskMaster = (): MaterialGraph => masterWith([textureParam("mask", "Mask", "T_Master")], "mask");
  // BaseColor = Mask x Brightness (a scalar parameter, default 1).
  const brightMaster = (): MaterialGraph =>
    masterWith(
      [textureParam("mask", "Mask", "T_Master"), scalarParam("brightness", "Brightness", 1), node("mul", "Multiply", { inputs: { A: pin("mask"), B: pin("brightness") } })],
      "mul",
    );
  // BaseColor = UseDetail ? Mask : Other, a static switch whose true branch samples Mask and whose false branch samples Other.
  const switchMaster = (): MaterialGraph =>
    masterWith(
      [
        node("pick", "StaticSwitchParameter", { inputs: { A: pin("mask"), B: pin("other") }, parameter: { name: "UseDetail", group: "" }, default: true }),
        textureParam("mask", "Mask", "T_Master"),
        textureParam("other", "Other", "T_Other"),
      ],
      "pick",
    );
  // A flat grey BaseColor; the Normal is the Normal texture parameter (node default T_Master).
  const normalMaster = (): MaterialGraph => masterWith([constant3("tint", [0.5, 0.5, 0.5]), textureParam("normal", "Normal", "T_Master")], "tint", { normal: "normal" });
  // A flat grey BaseColor; the opacity mask is the Mask texture parameter.
  const cutoutMaster = (): MaterialGraph => masterWith([constant3("tint", [0.5, 0.5, 0.5]), textureParam("mask", "Mask", "T_Master")], "tint", { opacityMask: "mask" });

  // A baker over the real dump: the fake converter writes the master graph and `files` (instance records) for it. The exporter is the
  // production shape: it answers only for the exact package a reference names, and the engine texture only with engine content.
  async function unresolvedBaker(master: MaterialGraph, files: Record<string, string> = {}, options: { readonly engine?: boolean } = {}) {
    const root = await scratch("graph-bake-unresolved-");
    const sourceDir = join(root, "source");
    await mkdir(join(sourceDir, "Content", "Test"), { recursive: true });
    for (const object of ["MI_Child", "MI_Mid", "MI_A", "MI_B"]) await writeFile(join(sourceDir, "Content", "Test", `${object}.uasset`), Buffer.alloc(16));
    const packages = new Map<string, string>();
    for (const [name, rgb] of Object.entries(PIXELS)) {
      const png = join(root, `${name}.png`);
      await writePng(png, [...rgb, 255], 4);
      packages.set(name.startsWith("T_Engine") ? `/Engine/EngineMaterials/${name}` : `/Game/Test/${name}`, png);
    }
    if (options.engine === false) packages.delete("/Engine/EngineMaterials/T_Engine");
    const converter = join(root, "converter");
    await writeRecordConverter(converter, { "M_Master.graph.json": JSON.stringify(master), ...files }, join(root, "argv.log"), root);
    const assets = { png: new Map<string, string>() };
    const baker = createGraphBaker({
      sourceDir,
      maxTextureSize: 8,
      environment: withoutEngineContent(process.env),
      modernConverter: { name: "modern", path: converter, version: "fake-converter 1" },
      exportTexture: async (_name, reference) => {
        const path = reference === undefined ? undefined : (/'([^']+)'/.exec(reference)?.[1] ?? reference);
        const dot = path === undefined ? -1 : path.lastIndexOf(".");
        return path === undefined || dot < 0 ? undefined : packages.get(path.slice(0, dot));
      },
    })!;
    return {
      bake: (request: {
        readonly lookupName: string;
        readonly props: Record<string, string>;
        readonly materialPackage?: string | undefined;
        readonly probe?: boolean;
        readonly alpha?: "opacityMask";
      }) =>
        baker({
          materialName: `${request.lookupName}_section`,
          lookupName: request.lookupName,
          materialPackage: "materialPackage" in request ? request.materialPackage : `/Game/Test/${request.lookupName}`,
          assets,
          readProps: (name) => request.props[name],
          ...(request.probe ? { probe: true } : {}),
          ...(request.alpha ? { alpha: request.alpha } : {}),
        }),
    };
  }
  async function bakedPixel(outcome: GraphBakeOutcome): Promise<number[]> {
    if (outcome.status !== "baked") throw new Error(`not baked: ${outcome.status}: ${outcome.reason}`);
    return firstPixel(outcome.png);
  }

  it("refuses an active None that would otherwise inherit the ancestor's override", async () => {
    const { bake } = await unresolvedBaker(maskMaster());
    const outcome = await bake({
      lookupName: "MI_Child",
      props: { MI_Child: nativeProps(instanceParent("MI_Mid"), textureParameter("Mask", "None")), MI_Mid: nativeProps(MASTER_PARENT, textureParameter("Mask", "T_Mid")) },
    });
    expect(outcome).toMatchObject({ status: "unavailable", reason: expect.stringContaining("Mask") });
  });

  it("refuses an active None that would otherwise fall back to the graph's own default texture", async () => {
    const { bake } = await unresolvedBaker(maskMaster());
    const outcome = await bake({ lookupName: "MI_Child", props: { MI_Child: nativeProps(MASTER_PARENT, textureParameter("Mask", "None")) } });
    expect(outcome).toMatchObject({ status: "unavailable", reason: expect.stringContaining("Mask") });
  });

  it("bakes when the static switch takes a branch that does not sample the None texture", async () => {
    const { bake } = await unresolvedBaker(switchMaster());
    const outcome = await bake({ lookupName: "MI_Child", props: { MI_Child: nativeProps(MASTER_PARENT, switchBlock("UseDetail", true), textureParameter("Other", "None")) } });
    expect(outcome).toMatchObject({ status: "baked", texturesUsed: ["T_Master"] });
    expect(await bakedPixel(outcome)).toEqual(PIXELS.T_Master);
  });

  it("refuses when the static switch takes the branch that samples the None texture", async () => {
    const { bake } = await unresolvedBaker(switchMaster());
    const outcome = await bake({ lookupName: "MI_Child", props: { MI_Child: nativeProps(MASTER_PARENT, switchBlock("UseDetail", true), textureParameter("Mask", "None")) } });
    expect(outcome).toMatchObject({ status: "unavailable", reason: expect.stringContaining("Mask") });
  });

  it("bakes the nearer instance's own texture over an ancestor's None", async () => {
    const { bake } = await unresolvedBaker(maskMaster());
    const outcome = await bake({
      lookupName: "MI_Child",
      props: { MI_Child: nativeProps(instanceParent("MI_Mid"), textureParameter("Mask", "T_Child")), MI_Mid: nativeProps(MASTER_PARENT, textureParameter("Mask", "None")) },
    });
    expect(await bakedPixel(outcome)).toEqual(PIXELS.T_Child);
  });

  it("recovers the None from the child's exact qualified record, and keeps the native scalar over anything the record says", async () => {
    const record = instanceRecord("MI_Child", `${recordTexture("Mask", ENGINE_TEXTURE)}\n${recordScalar("Brightness", 1)}`);
    const { bake } = await unresolvedBaker(brightMaster(), { "MI_Child.instance.json": JSON.stringify(record) });
    const outcome = await bake({ lookupName: "MI_Child", props: { MI_Child: nativeProps(MASTER_PARENT, textureParameter("Mask", "None"), nativeScalar("Brightness", 2500)) } });
    expect(outcome).toMatchObject({ status: "baked", texturesUsed: ["T_Engine"] });
    expect(outcome.parameters?.textureReferences?.get("mask")).toBe(ENGINE_TEXTURE);
    expect(outcome.parameters?.scalars.get("brightness")).toBe(2500);
    // 2500 times any texel clamps to white: the native scalar, not the record's 1, is the one the bake multiplies by.
    expect(await bakedPixel(outcome)).toEqual([255, 255, 255]);
  });

  it("keeps the native instance's own known texture over the record's texture for the same parameter", async () => {
    const record = instanceRecord("MI_Child", recordTexture("Mask", ENGINE_TEXTURE));
    const { bake } = await unresolvedBaker(maskMaster(), { "MI_Child.instance.json": JSON.stringify(record) });
    const outcome = await bake({ lookupName: "MI_Child", props: { MI_Child: nativeProps(MASTER_PARENT, textureParameter("Mask", "T_Native")) } });
    expect(outcome).toMatchObject({ status: "baked", texturesUsed: ["T_Native"] });
    expect(await bakedPixel(outcome)).toEqual(PIXELS.T_Native);
  });

  it("never recovers from a record of another package that carries the same object name", async () => {
    const record = instanceRecord("MI_Child", recordTexture("Mask", ENGINE_TEXTURE), { package: "/Game/Other" });
    const { bake } = await unresolvedBaker(maskMaster(), { "MI_Child.instance.json": JSON.stringify(record) });
    const outcome = await bake({ lookupName: "MI_Child", props: { MI_Child: nativeProps(MASTER_PARENT, textureParameter("Mask", "None")) } });
    expect(outcome).toMatchObject({ status: "unavailable", reason: expect.stringContaining("no instance record for /Game/Test/MI_Child") });
  });

  it("never recovers from an identity that two records claim", async () => {
    const record = JSON.stringify(instanceRecord("MI_Child", recordTexture("Mask", ENGINE_TEXTURE)));
    const { bake } = await unresolvedBaker(maskMaster(), { "MI_Child.instance.json": record, "MI_Child_copy.instance.json": record });
    const outcome = await bake({ lookupName: "MI_Child", props: { MI_Child: nativeProps(MASTER_PARENT, textureParameter("Mask", "None")) } });
    expect(outcome).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/duplicate identity/) });
  });

  it("never recovers from a record the converter refused", async () => {
    const { bake } = await unresolvedBaker(maskMaster(), { "MI_Child.instance.json": JSON.stringify(refusedInstance("MI_Child")) });
    const outcome = await bake({ lookupName: "MI_Child", props: { MI_Child: nativeProps(MASTER_PARENT, textureParameter("Mask", "None")) } });
    expect(outcome).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/LayerParameter/) });
  });

  it("never recovers a texture the record binds to a layer rather than globally", async () => {
    const record = instanceRecord("MI_Child", recordTexture("Mask", ENGINE_TEXTURE, "LayerParameter"));
    const { bake } = await unresolvedBaker(maskMaster(), { "MI_Child.instance.json": JSON.stringify(record) });
    const outcome = await bake({ lookupName: "MI_Child", props: { MI_Child: nativeProps(MASTER_PARENT, textureParameter("Mask", "None")) } });
    expect(outcome).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/not a global parameter/) });
  });

  it("never recovers a native None that is itself a layer parameter, even from a global record entry", async () => {
    const layerNone = [
      "TextureParameterValues[0] =",
      "{",
      "    ParameterValue = None",
      "    ParameterInfo =",
      "    {",
      "        Name = Mask",
      "        Association = LayerParameter",
      "        Index = 0",
      "    }",
      "}",
    ].join("\n");
    const record = instanceRecord("MI_Child", recordTexture("Mask", ENGINE_TEXTURE));
    const { bake } = await unresolvedBaker(maskMaster(), { "MI_Child.instance.json": JSON.stringify(record) });
    const outcome = await bake({ lookupName: "MI_Child", props: { MI_Child: nativeProps(MASTER_PARENT, layerNone) } });
    expect(outcome).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/not a global parameter/) });
  });

  it("never recovers from a record that names None, an authored null, for the parameter", async () => {
    const record = instanceRecord("MI_Child", recordTexture("Mask", "None"));
    const { bake } = await unresolvedBaker(maskMaster(), { "MI_Child.instance.json": JSON.stringify(record) });
    const outcome = await bake({ lookupName: "MI_Child", props: { MI_Child: nativeProps(MASTER_PARENT, textureParameter("Mask", "None")) } });
    expect(outcome).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/names no (qualified )?texture/) });
  });

  it("lets a parent record's own None, an authored null, fall through to the texture above it, as the renderer does", async () => {
    const record = instanceRecord("MI_Mid", recordTexture("Mask", "None"));
    const { bake } = await unresolvedBaker(maskMaster(), { "MI_Mid.instance.json": JSON.stringify(record) });
    const outcome = await bake({ lookupName: "MI_Child", props: { MI_Child: nativeProps(instanceParent("MI_Mid")) } });
    expect(outcome).toMatchObject({ status: "baked", texturesUsed: ["T_Master"] });
    expect(await bakedPixel(outcome)).toEqual(PIXELS.T_Master);
  });

  it("never recovers a texture the record names without its package", async () => {
    const record = instanceRecord("MI_Child", recordTexture("Mask", "Texture2D'T_Engine'"));
    const { bake } = await unresolvedBaker(maskMaster(), { "MI_Child.instance.json": JSON.stringify(record) });
    const outcome = await bake({ lookupName: "MI_Child", props: { MI_Child: nativeProps(MASTER_PARENT, textureParameter("Mask", "None")) } });
    expect(outcome).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/no qualified texture/) });
  });

  it("never recovers for a legacy request that names no package", async () => {
    const record = instanceRecord("MI_Child", recordTexture("Mask", ENGINE_TEXTURE));
    const { bake } = await unresolvedBaker(maskMaster(), { "MI_Child.instance.json": JSON.stringify(record) });
    const outcome = await bake({ lookupName: "MI_Child", materialPackage: undefined, props: { MI_Child: nativeProps(MASTER_PARENT, textureParameter("Mask", "None")) } });
    expect(outcome).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/names no package/) });
  });

  it("leaves a recovered engine texture unavailable, and says so, when no engine content answers for it", async () => {
    const record = instanceRecord("MI_Child", recordTexture("Mask", ENGINE_TEXTURE));
    const { bake } = await unresolvedBaker(maskMaster(), { "MI_Child.instance.json": JSON.stringify(record) }, { engine: false });
    const outcome = await bake({ lookupName: "MI_Child", props: { MI_Child: nativeProps(MASTER_PARENT, textureParameter("Mask", "None")) } });
    expect(outcome).toMatchObject({ status: "unavailable", reason: expect.stringContaining("T_Engine has no exact source") });
  });

  it("never answers an unresolved request from a positive bake of another instance of the same graph", async () => {
    const { bake } = await unresolvedBaker(maskMaster());
    const positive = await bake({ lookupName: "MI_A", props: { MI_A: nativeProps(MASTER_PARENT) } });
    expect(await bakedPixel(positive)).toEqual(PIXELS.T_Master);
    const unresolved = await bake({ lookupName: "MI_B", props: { MI_B: nativeProps(MASTER_PARENT, textureParameter("Mask", "None")) } });
    expect(unresolved).toMatchObject({ status: "unavailable", reason: expect.stringContaining("Mask") });
  });

  it("probes an active None as unknown: the probe names no base-colour texture, and no switch is claimed overridden", async () => {
    const { bake } = await unresolvedBaker(maskMaster());
    const outcome = await bake({ lookupName: "MI_Child", probe: true, props: { MI_Child: nativeProps(MASTER_PARENT, textureParameter("Mask", "None")) } });
    expect(outcome).not.toHaveProperty("baseColourTextures");
    expect(outcome).toMatchObject({ switchOverridden: false });
  });

  it("refuses the whole bake when the cut-out path samples a None texture, rather than keeping the colour opaque", async () => {
    const { bake } = await unresolvedBaker(cutoutMaster());
    const outcome = await bake({ lookupName: "MI_Child", alpha: "opacityMask", props: { MI_Child: nativeProps(MASTER_PARENT, textureParameter("Mask", "None")) } });
    expect(outcome).toMatchObject({ status: "unavailable", reason: expect.stringContaining("Mask") });
  });

  it("reports the Normal unknown, never a list without its texture, when the Normal's texture is None", async () => {
    const { bake } = await unresolvedBaker(normalMaster());
    const outcome = await bake({ lookupName: "MI_Child", props: { MI_Child: nativeProps(MASTER_PARENT, textureParameter("Normal", "None")) } });
    expect(outcome.normalDependencies).toMatchObject({ status: "unknown", reason: expect.stringContaining("Normal") });
  });

  it("reads the engine normal a qualified record gives a None Normal", async () => {
    const flat = "Texture2D'/Engine/EngineMaterials/BaseFlattenNormalMap.BaseFlattenNormalMap'";
    const record = instanceRecord("MI_Child", recordTexture("Normal", flat));
    const { bake } = await unresolvedBaker(normalMaster(), { "MI_Child.instance.json": JSON.stringify(record) });
    const outcome = await bake({ lookupName: "MI_Child", props: { MI_Child: nativeProps(MASTER_PARENT, textureParameter("Normal", "None")) } });
    expect(outcome.normalDependencies).toMatchObject({ status: "known", textures: [{ name: "BaseFlattenNormalMap", reference: flat }] });
  });

  it("gives the nearer None the whole texture parameter: no ancestor's default, object name or reference survives it", () => {
    const parameters = chainParameters([parsePropsFile(textureParameter("Mask", "None")), parsePropsFile(collectedTexture("Mask", "T_Master"))]);
    expect(parameters.textures.has("mask")).toBe(false);
    expect(parameters.textureReferences?.has("mask")).toBe(false);
    expect(parameters.unresolvedTextures?.has("mask")).toBe(true);
  });

  it("keeps a nearer known override over an ancestor's None, in both the object name and the reference", () => {
    const parameters = chainParameters([parsePropsFile(textureParameter("Mask", "T_Child")), parsePropsFile(textureParameter("Mask", "None"))]);
    expect(parameters.textures.get("mask")).toBe("T_Child");
    expect(parameters.textureReferences?.get("mask")).toBe("Texture2D'/Game/Test/T_Child.T_Child'");
    expect(parameters.unresolvedTextures?.has("mask") ?? false).toBe(false);
  });

  it("keys an unresolved parameter apart from an absent one, so neither answers for the other", () => {
    const absent = chainParameters([parsePropsFile("")]);
    const unresolved = chainParameters([parsePropsFile(textureParameter("Mask", "None"))]);
    expect(parametersKey(unresolved)).not.toBe(parametersKey(absent));
  });
});
