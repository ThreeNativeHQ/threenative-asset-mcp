import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeIO } from "@gltf-transform/core";
import sharp from "sharp";
import { describe, expect, it, onTestFinished } from "vitest";

import { chainParameters, createGraphBaker, directVertexColorGraph } from "../src/unreal/graph-baker.js";
import { parsePropsFile } from "../src/unreal/materials.js";
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

// ---------------------------------------------------------------------------------------------------------
// The importer end to end: fake umodel + a fake modern converter that answers `--dump-graphs`.

async function writeFakeConverter(path: string, graph: MaterialGraph, argvLog: string, textureFrom?: string): Promise<void> {
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
const exportAt = argv.indexOf("--export-dir");
const filterAt = argv.indexOf("--filter");
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

async function importWithGraph(options: { graph: MaterialGraph; graphBake?: boolean; hiddenTexture?: boolean; hiddenVia?: "umodel" | "converter" | "modern-header"; vertexColors?: boolean; normal?: [number, number, number]; instanceScalars?: [string, number][]; instanceTint?: [number, number, number, number]; packedRoughness?: boolean }) {
  const root = await scratch("graph-bake-import-");
  const sourceDir = join(root, "source");
  const content = join(sourceDir, "Content", "Test");
  const exported = join(root, "exported");
  const outputDir = join(root, "output");
  await mkdir(content, { recursive: true });
  await writeFile(join(content, "Mesh.uasset"), Buffer.alloc(16));
  await writeFile(join(content, "MI_Rock.uasset"), Buffer.alloc(16));
  await writeFile(join(content, "M_Master.uasset"), Buffer.alloc(16));
  const overrides: [string, string][] = options.hiddenTexture ? [] : [["Mask", "T_InstanceMask"]];
  // A packed roughness texture (SpecPower binds the metallicRoughness slot): a constant factor must not multiply into it.
  if (options.packedRoughness) overrides.push(["SpecPower", "T_Spec"]);
  // The exporter binds nothing to MI_Rock: its colour exists only in the graph.
  await writeMeshFixture(exported, {
    name: "Mesh",
    materialName: "MI_Rock",
    mat: "",
    props: instanceProps("M_Master", overrides, {
      scalars: options.instanceScalars,
      vectors: options.instanceTint ? [["Base Color Tint", options.instanceTint]] : undefined,
    }),
    textures: [],
  });
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
  if (options.packedRoughness) {
    await writeFile(join(content, "T_Spec.uasset"), Buffer.alloc(16));
    await writePng(join(exported, "T_Spec.png"), [128, 128, 128, 255], 4);
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
  await writeFakeConverter(converter, options.graph, converterLog, options.hiddenTexture && options.hiddenVia && options.hiddenVia !== "umodel" ? join(root, "hidden") : undefined);
  const report = await importUnrealDirectory({
    sourceDir,
    outputDir,
    onlyPackages: ["Mesh"],
    concurrency: 1,
    freeSpaceBytes: 30_000_000_000,
    environment: { ...process.env, THREENATIVE_UNREAL_CACHE_DIR: cacheDir },
    umodel: { name: "umodel", path: umodel, version: "fixture" },
    modernConverter: { name: "modern", path: converter, version: "fake-converter 1" },
    ...(options.graphBake === undefined ? {} : { graphBake: options.graphBake }),
  });
  const glb = await new NodeIO().read(join(outputDir, report.models[0]!.glb));
  const onDisk = JSON.parse(await readFile(join(outputDir, "import-report.json"), "utf8")) as ImportReport;
  const dumped = await readFile(converterLog, "utf8").catch(() => "");
  const leftovers = await readdir(cacheDir, { recursive: true }).catch(() => [] as string[]);
  const textureExports = (await readFile(textureLog, "utf8").catch(() => "")).split("\n").filter(Boolean);
  return { report, onDisk, material: glb.getRoot().listMaterials()[0]!, glb, dumped, leftovers, textureExports };
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
});
