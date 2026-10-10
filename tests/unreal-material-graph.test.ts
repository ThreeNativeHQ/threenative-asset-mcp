import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { materialGraphSchema, type MaterialGraph } from "../src/unreal/graph-dump.js";
import { graphReadsSurface } from "../src/unreal/graph-baker.js";
import {
  MATERIAL_ATTRIBUTE_GUIDS,
  bakeGraph,
  graphPathClasses,
  graphPathTextures,
  supportedEngineFunctions,
  supportedNodeClasses,
  type BakeResult,
  type GraphParameters,
  type TextureRaster,
} from "../src/unreal/material-graph.js";

// ---------------------------------------------------------------------------------------------------------
// Colour helpers. The bake decodes sRGB textures to linear, does arithmetic there and re-encodes the PNG.

const decode = (byte: number): number => {
  const unit = byte / 255;
  return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
};
const encode = (linear: number): number => {
  const value = Math.min(1, Math.max(0, linear));
  return Math.round((value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055) * 255);
};

// ---------------------------------------------------------------------------------------------------------
// Texture fixtures: tiny PNGs written with sharp and decoded back through sharp, like a real loader would.

type Rgb = readonly [number, number, number];

async function pngOf(width: number, height: number, texel: (x: number, y: number) => Rgb): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = texel(x, y);
      raw.set([r, g, b, 255], (y * width + x) * 4);
    }
  }
  return sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

interface Fixture {
  png: Buffer;
  /** The Unreal SRGB flag of the texture. */
  srgb: boolean;
}

function makeLoader(textures: Record<string, Fixture>) {
  const requested: string[] = [];
  const loadTexture = async (name: string): Promise<TextureRaster | undefined> => {
    requested.push(name);
    const fixture = textures[name];
    if (!fixture) return undefined;
    const { data, info } = await sharp(fixture.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, rgba: new Uint8Array(data), srgb: fixture.srgb };
  };
  return { loadTexture, requested };
}

const flat = (rgb: Rgb) => async (): Promise<Buffer> => pngOf(4, 4, () => rgb);

async function pixelsOf(result: BakeResult): Promise<(x: number, y: number) => number[]> {
  if (result.status !== "baked") throw new Error(`expected a baked result, got ${result.status}`);
  const { data, info } = await sharp(result.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  expect([info.width, info.height]).toEqual([result.width, result.height]);
  return (x, y) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 3)];
}

const NO_PARAMETERS: GraphParameters = { textures: new Map(), vectors: new Map(), scalars: new Map(), switches: new Map() };
const params = (overrides: {
  textures?: Record<string, string>;
  vectors?: Record<string, [number, number, number, number]>;
  scalars?: Record<string, number>;
  switches?: Record<string, boolean>;
}): GraphParameters => ({
  textures: new Map(Object.entries(overrides.textures ?? {})),
  vectors: new Map(Object.entries(overrides.vectors ?? {})),
  scalars: new Map(Object.entries(overrides.scalars ?? {})),
  switches: new Map(Object.entries(overrides.switches ?? {})),
});

// ---------------------------------------------------------------------------------------------------------
// Graph builders, copying the node shapes of the real M_Cave_Rock_MASTER dump.

type Raw = Record<string, unknown>;
const RGB_MASK = [1, 1, 1, 0];
const pin = (node: string, output = 0, mask: number[] | null = null) => ({ node, output, mask });
const node = (id: string, cls: string, extra: Raw = {}): Raw => ({ id, class: cls, inputs: {}, constants: {}, ...extra });
const withInputs = (n: Raw, inputs: Raw): Raw => ({ ...n, inputs });

const constant3 = (id: string, rgb: Rgb | [number, number, number, number]): Raw =>
  node(id, "Constant3Vector", { constants: { Constant: [...rgb, 1].slice(0, 4) } });
const scalarParameter = (id: string, name: string, value: number): Raw =>
  node(id, "ScalarParameter", { parameter: { name, group: "" }, default: value });
const vectorParameter = (id: string, name: string, value: number[]): Raw =>
  node(id, "VectorParameter", { parameter: { name, group: "" }, default: value });
const boolParameter = (id: string, name: string, value: boolean): Raw =>
  node(id, "StaticBoolParameter", { parameter: { name, group: "" }, default: value });
const textureCoordinate = (id: string, tiling: [number, number] = [1, 1], index = 0): Raw =>
  node(id, "TextureCoordinate", { constants: { UTiling: tiling[0], VTiling: tiling[1], ...(index ? { CoordinateIndex: index } : {}) }, tiling });
const textureSample = (id: string, texture: string, samplerType = "Color", coordinates: string | null = null): Raw =>
  node(id, "TextureSample", {
    inputs: coordinates ? { Coordinates: pin(coordinates) } : {},
    texture: `/Game/Test/${texture}.${texture}`,
    samplerType,
    coordinates: coordinates ? pin(coordinates) : null,
  });
const textureParameter = (id: string, name: string, texture: string, samplerType: string): Raw =>
  node(id, "TextureSampleParameter2D", { parameter: { name, group: "Base" }, default: null, texture: `/Game/Test/${texture}.${texture}`, samplerType });
const multiply = (id: string, a: Raw, b: Raw): Raw => node(id, "Multiply", { inputs: { A: a, B: b } });

/** An engine-content function call: the pack has no body, so the dumper leaves `error` and an empty `fn`. */
const engineCall = (id: string, name: string, inputs: Raw): Raw =>
  node(id, "FunctionCall", {
    inputs,
    function: `/Engine/Functions/MaterialLayerFunctions/${name}.${name}`,
    outputNames: ["Blended Material"],
    fn: { inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, value && (value as { node: string }).node])), outputs: [], output: null },
    error: "material function could not be loaded (engine content is not in the pack)",
  });

/** MF_Cave_Rock01 shape: Make(BaseColor = Multiply(Tint input, Texture(coords))) with the Tint input wired to `tintNode`. */
function colourLayer(callId: string, tintNode: string, texture: string, tiling: [number, number] = [1, 1]): Raw[] {
  return [
    node(callId, "FunctionCall", {
      inputs: { Tint: pin(tintNode, 0, RGB_MASK) },
      function: `/Game/Test/${callId}.${callId}`,
      outputNames: ["Result"],
      fn: { inputs: { Tint: tintNode }, outputs: [`${callId}/make`], output: `${callId}/make`, outputNames: [""] },
    }),
    node(`${callId}/make`, "MakeMaterialAttributes", { inputs: { BaseColor: pin(`${callId}/mul`), Metallic: null, Refraction: null } }),
    multiply(`${callId}/mul`, pin(`${callId}/tint`), pin(`${callId}/tex`, 0, RGB_MASK)),
    node(`${callId}/tint`, "FunctionInput", {
      inputs: { Preview: pin(`${callId}/white`), Input: pin(tintNode, 0, RGB_MASK) },
      constants: { InputName: "Tint", bUsePreviewValueAsDefault: true },
    }),
    constant3(`${callId}/white`, [1, 1, 1]),
    textureSample(`${callId}/tex`, texture, "Color", `${callId}/uv`),
    textureCoordinate(`${callId}/uv`, tiling),
  ];
}

/** MF_Solid_Color shape: Make(BaseColor = Constant3Vector). */
function solidLayer(callId: string, rgb: [number, number, number]): Raw[] {
  return [
    node(callId, "FunctionCall", {
      function: `/Game/Test/${callId}.${callId}`,
      outputNames: ["Result"],
      fn: { inputs: {}, outputs: [`${callId}/make`], output: `${callId}/make`, outputNames: [""] },
    }),
    node(`${callId}/make`, "MakeMaterialAttributes", { inputs: { BaseColor: pin(`${callId}/colour`), Refraction: null } }),
    constant3(`${callId}/colour`, [...rgb, 1]),
  ];
}

function makeGraph(nodes: Raw[], baseColor: ReturnType<typeof pin> | null, extra: Raw = {}): MaterialGraph {
  return materialGraphSchema.parse({
    format: 1,
    material: "M_Test",
    package: "/Game/Test/M_Test",
    truncated: false,
    nodeCount: nodes.length,
    outputs: {
      baseColor,
      roughness: null,
      metallic: null,
      emissive: null,
      opacity: null,
      opacityMask: null,
      normal: null,
      materialAttributes: null,
    },
    nodes,
    ...extra,
  });
}

const MASTER_ROCK01: Rgb = [200, 100, 50];
const MASTER_ROCK02: Rgb = [10, 220, 30];
const MASTER_SOLID: [number, number, number] = [0.27, 0.260581, 0.229186];

/**
 * The shape of M_Cave_Rock_MASTER: BaseColor = Diffuse Brightness x Break(Standard(Standard(rock01, rock02,
 * Mask.R), solid, Mask.G)).BaseColor, with a FeatureLevelSwitch in front of the first layer, and
 * MatLayerBlend_AO / BakedNormal / FuzzyShading around it when `wrapped`.
 */
function masterGraph(options: { wrapped?: boolean; brightness?: number } = {}): MaterialGraph {
  const nodes: Raw[] = [
    multiply("out", pin("brightness"), pin("break", 0, RGB_MASK)),
    scalarParameter("brightness", "Diffuse Brightness", options.brightness ?? 1),
    node("break", "BreakMaterialAttributes", {
      inputs: { MaterialAttributes: pin(options.wrapped ? "ao" : "blendSolid") },
      outputNames: ["BaseColor", "Metallic", "Specular", "Roughness", "EmissiveColor", "Opacity", "OpacityMask", "Normal"],
    }),
    engineCall("blendSolid", "MatLayerBlend_Standard", { Input0: pin("fls"), Input1: pin("solid"), Input2: pin("mask", 2, [0, 1, 0, 0]) }),
    node("fls", "FeatureLevelSwitch", {
      inputs: { Default: pin("blendRock"), "Inputs[0]": pin("rock01"), "Inputs[1]": pin("blendRock"), "Inputs[2]": pin("blendRock"), "Inputs[3]": pin("blendRock") },
    }),
    engineCall("blendRock", "MatLayerBlend_Standard", { Input0: pin("rock01"), Input1: pin("rock02"), Input2: pin("mask", 1, [1, 0, 0, 0]) }),
    vectorParameter("rockTint", "RockTint", [1, 0, 1, 1]),
    vectorParameter("detailTint", "DetailRockTint", [0, 1, 1, 1]),
    textureParameter("mask", "Mask", "T_Mask_Default", "LinearColor"),
    ...colourLayer("rock01", "rockTint", "T_Rock_01_D", [1, 1]),
    ...colourLayer("rock02", "detailTint", "T_Rock_Detail_D", [1, 1]),
    ...solidLayer("solid", MASTER_SOLID),
  ];
  if (options.wrapped) {
    nodes.push(
      engineCall("ao", "MatLayerBlend_AO", { Input0: pin("fuzzy"), Input1: pin("mask", 3, [0, 0, 1, 0]) }),
      // The pack carries no body for this fuzzy-shading function, so the name-matched view-dependent handler stands in.
      // (A pack-local body would be inlined first; see "inlines a pack-local body before an engine-name handler".)
      engineCall("fuzzy", "MF_FuzzyShading_JM", { "Material Input": pin("bakedNormal") }),
      engineCall("bakedNormal", "MatLayerBlend_BakedNormal", { Input0: pin("blendSolid"), Input1: pin("mask", 0, RGB_MASK) }),
    );
  }
  // MatLayerBlend_AO wraps the blended material in the wrapped graph, so the Break above reads "ao".
  return makeGraph(nodes, pin("out"));
}

/** Mask texture: corner texels select each layer exactly; (1, 0) holds a 128 alpha for the blend maths. */
function maskTexel(x: number, y: number): Rgb {
  if (x === 0 && y === 0) return [255, 0, 0]; // R = 1, G = 0: second layer (rock02)
  if (x === 3 && y === 0) return [0, 0, 0]; // R = 0, G = 0: first layer (rock01)
  if (x === 0 && y === 3) return [0, 255, 0]; // R = 0, G = 1: solid
  if (x === 3 && y === 3) return [255, 255, 0]; // R = 1, G = 1: solid
  if (x === 1 && y === 0) return [128, 0, 0]; // R = 128/255 (stored, not decoded), G = 0
  return [0, 0, 0];
}

async function masterTextures(): Promise<Record<string, Fixture>> {
  return {
    T_Rock_01_D: { png: await flat(MASTER_ROCK01)(), srgb: true },
    T_Rock_Detail_D: { png: await flat(MASTER_ROCK02)(), srgb: true },
    // The mask is flagged sRGB on purpose: its LinearColor sampler must still read the stored bytes.
    T_Mask_Default: { png: await pngOf(4, 4, maskTexel), srgb: true },
  };
}

// ---------------------------------------------------------------------------------------------------------

describe("bakeGraph", () => {
  it("multiplies a constant tint with a texture, pixel-exact", async () => {
    // Texel (x, y) = (60x, 60y, 200). Tint (1, 0.5, 0): r keeps its byte, g = encode(decode(g) * 0.5), b = 0.
    const texture = await pngOf(4, 4, (x, y) => [60 * x, 60 * y, 200]);
    const graph = makeGraph(
      [multiply("m", pin("tint"), pin("t", 0, RGB_MASK)), constant3("tint", [1, 0.5, 0]), textureSample("t", "T_Gradient")],
      pin("m"),
    );
    const loader = makeLoader({ T_Gradient: { png: texture, srgb: true } });
    const result = await bakeGraph({ graph, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: loader.loadTexture, size: 4 });
    expect(result.status).toBe("baked");
    const pixel = await pixelsOf(result);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) expect(pixel(x, y)).toEqual([60 * x, encode(decode(60 * y) * 0.5), 0]);
    }
    // Spot values by hand: (3, 3) = (180, encode(decode(180) * 0.5) = 131, 0); (0, 0) = (0, 0, 0).
    expect(pixel(3, 3)).toEqual([180, 131, 0]);
    if (result.status === "baked") {
      expect(result.confidence).toBe("exact");
      expect(result.approximations).toEqual([]);
      expect(result.texturesUsed).toEqual(["T_Gradient"]);
      const mean = [0, 1, 2].map((channel) => {
        let sum = 0;
        for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) sum += pixel(x, y)[channel]!;
        return sum / 16 / 255;
      });
      result.meanRgb.forEach((value, channel) => expect(value).toBeCloseTo(mean[channel]!, 9));
    }
  });

  it("blends three layers by the R and G mask channels through inlined function calls", async () => {
    const loader = makeLoader(await masterTextures());
    const result = await bakeGraph({ graph: masterGraph(), output: "baseColor", parameters: NO_PARAMETERS, loadTexture: loader.loadTexture, size: 4 });
    expect(result.status).toBe("baked");
    const pixel = await pixelsOf(result);
    // Layer colours after the tints RockTint (1,0,1) and DetailRockTint (0,1,1): rock01 = (200,0,50), rock02 = (0,220,30).
    expect(pixel(3, 0)).toEqual([200, 0, 50]); // mask (0,0): rock01
    expect(pixel(0, 0)).toEqual([0, 220, 30]); // mask R=1, G=0: rock02
    // Solid layer is a linear constant (0.27, 0.260581, 0.229186) = sRGB bytes (142, 140, 132).
    expect(pixel(0, 3)).toEqual([142, 140, 132]); // mask R=0, G=1
    expect(pixel(3, 3)).toEqual([142, 140, 132]); // mask R=1, G=1: G wins because the solid layer blends last
    // Mask texel (1, 0): R stored 128 -> alpha 128/255 (the LinearColor sampler is not decoded), G = 0.
    const alpha = 128 / 255;
    expect(pixel(1, 0)).toEqual([
      encode(decode(200) * (1 - alpha)),
      encode(decode(220) * alpha),
      encode(decode(50) * (1 - alpha) + decode(30) * alpha),
    ]);
    if (result.status === "baked") {
      expect(result.confidence).toBe("exact");
      expect(result.texturesUsed).toEqual(["T_Mask_Default", "T_Rock_01_D", "T_Rock_Detail_D"]);
    }
  });

  it("applies instance overrides for vector, scalar and texture parameters", async () => {
    const textures = {
      ...(await masterTextures()),
      // An all-zero mask: every texel is the first layer.
      T_Mask_Pillar: { png: await pngOf(4, 4, () => [0, 0, 0]), srgb: false },
    };
    const loader = makeLoader(textures);
    const overridden = params({
      textures: { mask: "/Game/Test/T_Mask_Pillar.T_Mask_Pillar" },
      vectors: { rocktint: [0, 1, 0, 1] },
      scalars: { "diffuse brightness": 0.5 },
    });
    const result = await bakeGraph({ graph: masterGraph(), output: "baseColor", parameters: overridden, loadTexture: loader.loadTexture, size: 4 });
    expect(result.status).toBe("baked");
    const pixel = await pixelsOf(result);
    // rock01 (200,100,50) x tint (0,1,0) = (0,100,0), then x 0.5 brightness in linear: g = encode(decode(100) * 0.5) = 71.
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) expect(pixel(x, y)).toEqual([0, 71, 0]);
    expect(loader.requested).not.toContain("T_Mask_Default");
    expect(loader.requested).toContain("T_Mask_Pillar");
  });

  it("follows the active StaticSwitch branch only", async () => {
    const nodes: Raw[] = [
      withInputs(node("switch", "StaticSwitch", { switchValue: false }), { A: pin("red"), B: pin("vertex"), Value: pin("flag") }),
      constant3("red", [1, 0, 0]),
      node("vertex", "VertexColor"),
      boolParameter("flag", "UseConstant", true),
    ];
    const graph = makeGraph(nodes, pin("switch", 0, RGB_MASK));
    const loader = makeLoader({});
    // True (the node default) takes A; the VertexColor on B is inactive and must not block the bake.
    const active = await bakeGraph({ graph, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: loader.loadTexture, size: 2 });
    expect(active.status).toBe("baked");
    const pixel = await pixelsOf(active);
    expect(pixel(0, 0)).toEqual([255, 0, 0]);
    // An instance switching it off makes VertexColor active.
    const inactive = await bakeGraph({ graph, output: "baseColor", parameters: params({ switches: { useconstant: false } }), loadTexture: loader.loadTexture, size: 2 });
    expect(inactive).toMatchObject({ status: "unsupported", unsupported: ["VertexColor"] });
  });

  it("reports VertexColor on the active path as unsupported and bakes no PNG", async () => {
    const graph = makeGraph([multiply("m", pin("v", 0, RGB_MASK), pin("c")), node("v", "VertexColor"), constant3("c", [1, 1, 1])], pin("m"));
    const loader = makeLoader({});
    const result = await bakeGraph({ graph, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: loader.loadTexture, size: 2 });
    expect(result.status).toBe("unsupported");
    expect(result).toMatchObject({ unsupported: ["VertexColor"] });
    expect(result).not.toHaveProperty("png");
    expect(loader.requested).toEqual([]);
  });

  it("passes BaseColor through AO, baked-normal and fuzzy-shading functions and calls the result heuristic", async () => {
    const loader = makeLoader(await masterTextures());
    const result = await bakeGraph({ graph: masterGraph({ wrapped: true }), output: "baseColor", parameters: NO_PARAMETERS, loadTexture: loader.loadTexture, size: 4 });
    expect(result.status).toBe("baked");
    if (result.status !== "baked") return;
    expect(result.confidence).toBe("heuristic");
    expect(result.approximations).toEqual([
      "MatLayerBlend_AO: BaseColor passed through; engine body unavailable",
      "MatLayerBlend_BakedNormal: BaseColor passed through; engine body unavailable",
      "view-dependent fuzzy shading ignored",
    ]);
    // The wrapped chain returns the same colours as the bare blend; the pack carries no fuzzy-shading body to follow.
    const pixel = await pixelsOf(result);
    expect(pixel(3, 0)).toEqual([200, 0, 50]);
    expect(pixel(0, 3)).toEqual([142, 140, 132]);
  });

  it("names an engine function it does not know when that function is on the path", async () => {
    const graph = makeGraph(
      [
        node("break", "BreakMaterialAttributes", { inputs: { MaterialAttributes: pin("contrast") }, outputNames: ["BaseColor", "Metallic"] }),
        engineCall("contrast", "MatLayerBlend_Imaginary", { Input0: pin("make"), Input1: pin("amount") }),
        node("make", "MakeMaterialAttributes", { inputs: { BaseColor: pin("c") } }),
        constant3("c", [0.5, 0.5, 0.5]),
        node("amount", "Constant", { constants: { R: 0.2 } }),
      ],
      pin("break", 0, RGB_MASK),
    );
    const result = await bakeGraph({ graph, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: makeLoader({}).loadTexture, size: 2 });
    expect(result).toMatchObject({ status: "unsupported", unsupported: ["MatLayerBlend_Imaginary"] });
  });

  it("lerps the layers of MatLayerBlend_Simple and passes MatLayerBlend_NormalBlend's attributes through (UE4 mannequin shape)", async () => {
    // M_UE4Man_Body: NormalBlend(Input0 unwired, Input1 = attributes, Input2 = normal map) feeds the material attributes,
    // and MatLayerBlend_Simple(Input0 = base, Input1 = top, Input2 = alpha) chains are blended by a mask texture's channels.
    const graph = makeGraph(
      [
        node("break", "BreakMaterialAttributes", { inputs: { MaterialAttributes: pin("normalBlend") }, outputNames: ["BaseColor"] }),
        engineCall("normalBlend", "MatLayerBlend_NormalBlend", { Input0: null, Input1: pin("simple"), Input2: pin("normal", 0, RGB_MASK) }),
        engineCall("simple", "MatLayerBlend_Simple", { Input0: pin("base"), Input1: pin("top"), Input2: pin("alpha") }),
        node("base", "MakeMaterialAttributes", { inputs: { BaseColor: pin("red") } }),
        node("top", "MakeMaterialAttributes", { inputs: { BaseColor: pin("blue") } }),
        constant3("red", [1, 0, 0]),
        constant3("blue", [0, 0, 1]),
        constant3("normal", [0.5, 0.5, 1]),
        node("alpha", "Constant", { constants: { R: 0.5 } }),
      ],
      pin("break", 0, RGB_MASK),
    );
    const result = await bakeGraph({ graph, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: makeLoader({}).loadTexture, size: 2 });
    expect(result.status).toBe("baked");
    expect((result as { unsupported?: string[] }).unsupported ?? []).toEqual([]);
    const pixel = await pixelsOf(result);
    // lerp(red, blue, 0.5) in linear light, encoded to sRGB.
    const [r = 0, g = 0, b = 0] = pixel(0, 0);
    expect(r).toBeGreaterThan(150);
    expect(r).toBeLessThan(210);
    expect(g).toBe(0);
    expect(Math.abs(r - b)).toBeLessThanOrEqual(1);
  });

  it("falls back to NormalBlend's Input0 when Input1 is unwired", async () => {
    const graph = makeGraph(
      [
        node("break", "BreakMaterialAttributes", { inputs: { MaterialAttributes: pin("normalBlend") }, outputNames: ["BaseColor"] }),
        engineCall("normalBlend", "MatLayerBlend_NormalBlend", { Input0: pin("base"), Input1: null, Input2: pin("normal", 0, RGB_MASK) }),
        node("base", "MakeMaterialAttributes", { inputs: { BaseColor: pin("red") } }),
        constant3("red", [1, 0, 0]),
        constant3("normal", [0.5, 0.5, 1]),
      ],
      pin("break", 0, RGB_MASK),
    );
    const result = await bakeGraph({ graph, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: makeLoader({}).loadTexture, size: 2 });
    expect(result.status).toBe("baked");
    expect((await pixelsOf(result))(0, 0)).toEqual([255, 0, 0]);
  });

  it("refuses a graph whose BaseColor needs an attribute the bake does not carry (Specular)", async () => {
    const graph = makeGraph(
      [
        node("break", "BreakMaterialAttributes", { inputs: { MaterialAttributes: pin("make") }, outputNames: ["BaseColor", "Metallic", "Specular", "Roughness"] }),
        node("make", "MakeMaterialAttributes", { inputs: { BaseColor: pin("c"), Roughness: pin("c") } }),
        constant3("c", [0.5, 0.5, 0.5]),
      ],
      pin("break", 2, [1, 1, 1, 0]),
    );
    const result = await bakeGraph({ graph, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: makeLoader({}).loadTexture, size: 2 });
    expect(result).toMatchObject({ status: "unsupported", unsupported: ["BreakMaterialAttributes.Specular"] });
  });

  it("is unavailable when a needed texture cannot be loaded, and names it", async () => {
    const textures = await masterTextures();
    delete textures.T_Rock_Detail_D;
    const loader = makeLoader(textures);
    const result = await bakeGraph({ graph: masterGraph(), output: "baseColor", parameters: NO_PARAMETERS, loadTexture: loader.loadTexture, size: 4 });
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") expect(result.reason).toContain("T_Rock_Detail_D");
  });

  it("is unavailable for a truncated graph and for a graph without a BaseColor output", async () => {
    const loader = makeLoader({});
    const truncated = makeGraph([constant3("c", [1, 1, 1])], pin("c"), { truncated: true });
    expect(await bakeGraph({ graph: truncated, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: loader.loadTexture, size: 2 })).toMatchObject({
      status: "unavailable",
    });
    const unwired = makeGraph([constant3("c", [1, 1, 1])], null);
    const result = await bakeGraph({ graph: unwired, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: loader.loadTexture, size: 2 });
    expect(result).toMatchObject({ status: "unavailable" });
  });

  it("keeps a mid-grey sRGB texel unchanged through Multiply by one", async () => {
    // decode(128) = 0.2159 linear; x 1 stays; encode(0.2159) = 128. Round trip through the linear working space.
    const graph = makeGraph([multiply("m", pin("t", 0, RGB_MASK), pin("one")), textureSample("t", "T_Grey"), node("one", "Constant", { constants: { R: 1 } })], pin("m"));
    const grey = { png: await flat([128, 128, 128])(), srgb: true };
    const decoded = await bakeGraph({ graph, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: makeLoader({ T_Grey: grey }).loadTexture, size: 2 });
    expect((await pixelsOf(decoded))(0, 0)).toEqual([128, 128, 128]);
    // The same bytes read through a LinearColor sampler are linear 0.502, which encodes to 188.
    const linearGraph = makeGraph(
      [multiply("m", pin("t", 0, RGB_MASK), pin("one")), textureSample("t", "T_Grey", "LinearColor"), node("one", "Constant", { constants: { R: 1 } })],
      pin("m"),
    );
    const undecoded = await bakeGraph({ graph: linearGraph, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: makeLoader({ T_Grey: grey }).loadTexture, size: 2 });
    expect((await pixelsOf(undecoded))(0, 0)).toEqual([188, 188, 188]);
    // A texture without the sRGB flag is not decoded even with a Color sampler.
    const unflagged = await bakeGraph({
      graph,
      output: "baseColor",
      parameters: NO_PARAMETERS,
      loadTexture: makeLoader({ T_Grey: { ...grey, srgb: false } }).loadTexture,
      size: 2,
    });
    expect((await pixelsOf(unflagged))(0, 0)).toEqual([188, 188, 188]);
  });

  it("evaluates Divide per channel, with ConstB as the unwired divisor and a guarded zero", async () => {
    const texture = { png: await flat([100, 0, 255])(), srgb: false };
    const divideBy = (constants: Raw): MaterialGraph =>
      makeGraph([node("d", "Divide", { inputs: { A: pin("t", 0, RGB_MASK) }, constants }), textureSample("t", "T_Div", "LinearColor")], pin("d"));
    // LinearColor is read as stored: 100/255 / 0.5 = 0.7843 -> encode 232; 0 stays 0; 1 / 0.5 clamps to 255.
    const half = await bakeGraph({ graph: divideBy({ ConstB: 0.5 }), output: "baseColor", parameters: NO_PARAMETERS, loadTexture: makeLoader({ T_Div: texture }).loadTexture, size: 2 });
    expect((await pixelsOf(half))(0, 0)).toEqual([encode(100 / 255 / 0.5), 0, 255]);
    // A zero divisor becomes 1e-6: positive numerators saturate, zero stays zero, and nothing is NaN.
    const zero = await bakeGraph({ graph: divideBy({ ConstB: 0 }), output: "baseColor", parameters: NO_PARAMETERS, loadTexture: makeLoader({ T_Div: texture }).loadTexture, size: 2 });
    expect((await pixelsOf(zero))(0, 0)).toEqual([255, 0, 255]);
    // Wired divisors work too: A / B with B a Constant3Vector.
    const wired = makeGraph(
      [
        node("d", "Divide", { inputs: { A: pin("t", 0, RGB_MASK), B: pin("c") } }),
        textureSample("t", "T_Div", "LinearColor"),
        constant3("c", [2, 1, 4]),
      ],
      pin("d"),
    );
    const result = await bakeGraph({ graph: wired, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: makeLoader({ T_Div: texture }).loadTexture, size: 2 });
    expect((await pixelsOf(result))(0, 0)).toEqual([encode(100 / 255 / 2), 0, encode(255 / 255 / 4)]);
  });

  it("evaluates VertexColor as the supplied constant only when asked, and says so", async () => {
    // Lerp(red, blue, VertexColor.A) x VertexColor.RGB(0.5 grey): alpha 1 picks the B layer, so (0, 0, 1) x 0.5.
    const graph = makeGraph(
      [
        multiply("m", pin("mix", 0, RGB_MASK), pin("vc", 0, RGB_MASK)),
        node("mix", "LinearInterpolate", { inputs: { A: pin("red"), B: pin("blue"), Alpha: pin("vc", 4, [0, 0, 0, 1]) } }),
        constant3("red", [1, 0, 0]),
        constant3("blue", [0, 0, 1]),
        node("vc", "VertexColor"),
      ],
      pin("m"),
    );
    const loader = makeLoader({});
    const without = await bakeGraph({ graph, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: loader.loadTexture, size: 2 });
    expect(without).toMatchObject({ status: "unsupported", unsupported: ["VertexColor"] });
    const white = await bakeGraph({ graph, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: loader.loadTexture, size: 2, vertexColor: [1, 1, 1, 1] });
    expect((await pixelsOf(white))(0, 0)).toEqual([0, 0, 255]);
    expect(white).toMatchObject({
      confidence: "heuristic",
      approximations: ["VertexColor evaluated as white: the mesh carries no vertex colours (Unreal's default); an instance painted in a level would differ"],
    });
    // A non-white constant is still honoured (alpha 0.5 halves the blend), but it is not the white claim.
    const grey = await bakeGraph({ graph, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: loader.loadTexture, size: 2, vertexColor: [0.5, 0.5, 0.5, 0.5] });
    expect((await pixelsOf(grey))(0, 0)).toEqual([encode(0.5 * 0.5), 0, encode(0.5 * 0.5)]);
    // Not on the active path: no approximation is claimed.
    const unused = makeGraph([constant3("red", [1, 0, 0]), node("vc", "VertexColor")], pin("red"));
    const plain = await bakeGraph({ graph: unused, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: loader.loadTexture, size: 2, vertexColor: [1, 1, 1, 1] });
    expect(plain).toMatchObject({ confidence: "exact", approximations: [] });
  });

  it("keeps the texture's row order: v = 0 is the first PNG row", async () => {
    // Every texel is distinct and non-symmetric: (x, y) = (40x + 10, 60y + 5, 77).
    const texel = (x: number, y: number): Rgb => [40 * x + 10, 60 * y + 5, 77];
    const graph = makeGraph([textureSample("t", "T_Orient")], pin("t", 0, RGB_MASK));
    const loader = makeLoader({ T_Orient: { png: await pngOf(4, 4, texel), srgb: true } });
    const result = await bakeGraph({ graph, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: loader.loadTexture, size: 4 });
    const pixel = await pixelsOf(result);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) expect(pixel(x, y)).toEqual([...texel(x, y)]);
    // The top-left output pixel is the top-left texel (10, 5, 77), not the bottom-left (10, 185, 77).
    expect(pixel(0, 0)).toEqual([10, 5, 77]);
  });

  it("repeats a texture by the TextureCoordinate tiling", async () => {
    // A 2x2 texture with columns 0, 255 (sRGB: linear 0, 1). Output 4 wide at tiling 2 reads uv x2, so output x
    // lands exactly on texel x mod 2 (position x + 0.5 - 0.5): 0, 255, 0, 255. Texel-to-pixel ratio is 1, so no mip.
    // Without the tiling output x samples texel position x / 2 - 0.25: linear 0.25, 0.25, 0.75, 0.75 (bytes 137, 137, 225, 225).
    const stripes = await pngOf(2, 2, (x) => (x === 0 ? [0, 0, 0] : [255, 255, 255]));
    const loader = makeLoader({ T_Stripes: { png: stripes, srgb: true } });
    const build = (tiling: [number, number]) => makeGraph([textureSample("t", "T_Stripes", "Color", "uv"), textureCoordinate("uv", tiling)], pin("t", 0, RGB_MASK));
    const tiled = await bakeGraph({ graph: build([2, 2]), output: "baseColor", parameters: NO_PARAMETERS, loadTexture: loader.loadTexture, size: 4 });
    const tiledPixel = await pixelsOf(tiled);
    expect([0, 1, 2, 3].map((x) => tiledPixel(x, 0)[0])).toEqual([0, 255, 0, 255]);
    const plain = await bakeGraph({ graph: build([1, 1]), output: "baseColor", parameters: NO_PARAMETERS, loadTexture: loader.loadTexture, size: 4 });
    const plainPixel = await pixelsOf(plain);
    expect([0, 1, 2, 3].map((x) => plainPixel(x, 0)[0])).toEqual([encode(0.25), encode(0.25), encode(0.75), encode(0.75)]);
  });

  it("averages a minified texture instead of aliasing it", async () => {
    // A 4x4 texture with one white texel baked to 1x1: the mip chain ends in the mean, linear 1/16.
    // Point or bilinear sampling at the centre (u = v = 0.5) would only touch the black texels and give 0.
    const dot = await pngOf(4, 4, (x, y) => (x === 0 && y === 0 ? [255, 255, 255] : [0, 0, 0]));
    const loader = makeLoader({ T_Dot: { png: dot, srgb: true } });
    const graph = makeGraph([textureSample("t", "T_Dot")], pin("t", 0, RGB_MASK));
    const result = await bakeGraph({ graph, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: loader.loadTexture, size: 1 });
    expect((await pixelsOf(result))(0, 0)).toEqual([encode(1 / 16), encode(1 / 16), encode(1 / 16)]);
  });

  it("refuses a texture coordinate set other than UV0 unless asked to approximate it", async () => {
    const graph = makeGraph([textureSample("t", "T_Grey", "Color", "uv"), textureCoordinate("uv", [5, 5], 2)], pin("t", 0, RGB_MASK));
    const loader = makeLoader({ T_Grey: { png: await flat([128, 128, 128])(), srgb: true } });
    const strict = await bakeGraph({ graph, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: loader.loadTexture, size: 2 });
    expect(strict).toMatchObject({ status: "unsupported", unsupported: ["TextureCoordinate[2]"] });
    const relaxed = await bakeGraph({ graph, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: loader.loadTexture, size: 2, allowUvSetFallback: true });
    expect(relaxed).toMatchObject({ status: "baked", confidence: "heuristic" });
    if (relaxed.status === "baked") expect(relaxed.approximations[0]).toContain("TextureCoordinate[2]");
  });

  it("computes the node arithmetic: lerp, one-minus, saturate, power, mask and append", async () => {
    // lerp(0.2, 1, 0.25) = 0.4; OneMinus -> 0.6; Saturate(0.6 + 0.9) = 1; Power(0.5, 2) = 0.25.
    const nodes: Raw[] = [
      node("append", "AppendVector", { inputs: { A: pin("rg"), B: pin("b") } }),
      node("rg", "AppendVector", { inputs: { A: pin("oneMinus"), B: pin("saturate") } }),
      node("oneMinus", "OneMinus", { inputs: { Input: pin("lerp") } }),
      node("lerp", "LinearInterpolate", { inputs: { A: pin("a"), B: pin("b1") }, constants: { ConstAlpha: 0.25 } }),
      node("a", "Constant", { constants: { R: 0.2 } }),
      node("b1", "Constant", { constants: { R: 1 } }),
      node("saturate", "Saturate", { inputs: { Input: pin("sum") } }),
      node("sum", "Add", { inputs: { A: pin("oneMinus"), B: pin("c09") } }),
      node("c09", "Constant", { constants: { R: 0.9 } }),
      node("b", "Power", { inputs: { Base: pin("half") }, constants: { ConstExponent: 2 } }),
      node("half", "Constant", { constants: { R: 0.5 } }),
    ];
    const result = await bakeGraph({ graph: makeGraph(nodes, pin("append", 0, RGB_MASK)), output: "baseColor", parameters: NO_PARAMETERS, loadTexture: makeLoader({}).loadTexture, size: 2 });
    expect((await pixelsOf(result))(1, 1)).toEqual([encode(0.6), encode(1), encode(0.25)]);
  });

  it("bakes a 1024 master-shaped graph quickly", async () => {
    const wide = { ...(await masterTextures()), T_Rock_01_D: { png: await pngOf(256, 256, (x, y) => [x, y, 128]), srgb: true } };
    const started = performance.now();
    const result = await bakeGraph({ graph: masterGraph({ wrapped: true }), output: "baseColor", parameters: NO_PARAMETERS, loadTexture: makeLoader(wide).loadTexture, size: 1024 });
    expect(result.status).toBe("baked");
    expect(performance.now() - started).toBeLessThan(25_000);
  });
});

describe("Desaturation and SpeedTreeColorVariation", () => {
  const SOURCE: Rgb = [200, 100, 50];
  const linear = SOURCE.map(decode) as [number, number, number];
  const grey = (factors: readonly number[] = [0.3, 0.59, 0.11]) => linear[0] * factors[0]! + linear[1] * factors[1]! + linear[2] * factors[2]!;
  const desaturate = async (desaturation: Raw, extra: Raw[] = []) => {
    const graph = makeGraph([desaturation, textureSample("t", "T_Source"), ...extra], pin("d", 0, RGB_MASK));
    const loader = makeLoader({ T_Source: { png: await flat(SOURCE)(), srgb: true } });
    return bakeGraph({ graph, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: loader.loadTexture, size: 4 });
  };

  it("collapses to luminance when Fraction is unwired (Unreal's default is 1)", async () => {
    const result = await desaturate(node("d", "Desaturation", { inputs: { Input: pin("t", 0, RGB_MASK) } }));
    const pixel = await pixelsOf(result);
    // Hand value: 0.3 * 0.5776 + 0.59 * 0.1274 + 0.11 * 0.0319 = 0.2518 -> sRGB byte 137 on every channel.
    const byte = encode(grey());
    expect(byte).toBe(137);
    expect(pixel(2, 2)).toEqual([byte, byte, byte]);
    if (result.status === "baked") expect(result.confidence).toBe("exact");
  });

  it("lerps from the input to its luminance by a wired Fraction", async () => {
    const result = await desaturate(node("d", "Desaturation", { inputs: { Input: pin("t", 0, RGB_MASK), Fraction: pin("f") } }), [
      node("f", "Constant", { constants: { R: 0.25 } }),
    ]);
    const pixel = await pixelsOf(result);
    const g = grey();
    expect(pixel(1, 1)).toEqual(linear.map((channel) => encode(channel + (g - channel) * 0.25)));
    // Not the reversed lerp (grey + (input - grey) * 0.25), which would be much closer to the input.
    expect(pixel(1, 1)).not.toEqual(linear.map((channel) => encode(g + (channel - g) * 0.25)));
  });

  it("returns the input untouched for Fraction 0 and honours a stored Fraction constant and custom LuminanceFactors", async () => {
    const identity = await pixelsOf(await desaturate(node("d", "Desaturation", { inputs: { Input: pin("t", 0, RGB_MASK) }, constants: { Fraction: 0 } })));
    expect(identity(0, 0)).toEqual([...SOURCE]);
    const factors = [0.5, 0.25, 0.25];
    const custom = await pixelsOf(
      await desaturate(node("d", "Desaturation", { inputs: { Input: pin("t", 0, RGB_MASK) }, constants: { LuminanceFactors: [...factors, 0] } })),
    );
    const byte = encode(grey(factors));
    expect(custom(3, 3)).toEqual([byte, byte, byte]);
  });

  it("reports a Desaturation without an input as unavailable", async () => {
    const result = await desaturate(node("d", "Desaturation"));
    expect(result.status).toBe("unavailable");
  });

  const treeCall = (inputs: Raw) => engineCall("v", "SpeedTreeColorVariation", inputs);
  const APPROXIMATION = "SpeedTreeColorVariation: per-instance colour variation ignored; engine body unavailable";
  const bakeVariation = async (inputs: Raw) => {
    const graph = makeGraph([treeCall(inputs), textureSample("t", "T_Source")], pin("v", 0, RGB_MASK));
    const loader = makeLoader({ T_Source: { png: await flat(SOURCE)(), srgb: true } });
    return bakeGraph({ graph, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: loader.loadTexture, size: 4 });
  };

  it("passes the colour input of SpeedTreeColorVariation through as a heuristic", async () => {
    for (const inputs of [{ "Base Color": pin("t", 0, RGB_MASK) }, { Input0: pin("t", 0, RGB_MASK) }, { Other: pin("t", 0, RGB_MASK) }]) {
      const result = await bakeVariation(inputs);
      expect((await pixelsOf(result))(0, 0)).toEqual([...SOURCE]);
      if (result.status === "baked") {
        expect(result.confidence).toBe("heuristic");
        expect(result.approximations).toEqual([APPROXIMATION]);
      }
    }
  });

  it("prefers the pin named like a colour over earlier pins", async () => {
    const other: Raw = pin("c", 0, RGB_MASK);
    const graph = makeGraph(
      [treeCall({ Input0: other, "Color Input": pin("t", 0, RGB_MASK) }), textureSample("t", "T_Source"), constant3("c", [0, 0, 1])],
      pin("v", 0, RGB_MASK),
    );
    const loader = makeLoader({ T_Source: { png: await flat(SOURCE)(), srgb: true } });
    const result = await bakeGraph({ graph, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: loader.loadTexture, size: 4 });
    expect((await pixelsOf(result))(0, 0)).toEqual([...SOURCE]);
  });

  it("names SpeedTreeColorVariation as unsupported when nothing is connected", async () => {
    const result = await bakeVariation({ Input0: null });
    expect(result.status).toBe("unsupported");
    if (result.status === "unsupported") expect(result.unsupported).toEqual(["SpeedTreeColorVariation"]);
  });

  it("bakes Multiply(Desaturation(SpeedTreeColorVariation(texture)), tint) on the BaseColor path", async () => {
    const graph = makeGraph(
      [
        multiply("out", pin("d", 0, RGB_MASK), pin("tint")),
        node("d", "Desaturation", { inputs: { Input: pin("v", 0, RGB_MASK), Fraction: pin("f") } }),
        node("f", "Constant", { constants: { R: 0.5 } }),
        treeCall({ "Base Color": pin("t", 0, RGB_MASK) }),
        textureSample("t", "T_Source"),
        constant3("tint", [1, 0.5, 0]),
      ],
      pin("out"),
    );
    const loader = makeLoader({ T_Source: { png: await flat(SOURCE)(), srgb: true } });
    const result = await bakeGraph({ graph, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: loader.loadTexture, size: 4 });
    const pixel = await pixelsOf(result);
    const g = grey();
    const tint = [1, 0.5, 0];
    expect(pixel(2, 1)).toEqual(linear.map((channel, index) => encode((channel + (g - channel) * 0.5) * tint[index]!)));
    if (result.status === "baked") {
      expect(result.confidence).toBe("heuristic");
      expect(result.approximations).toEqual([APPROXIMATION]);
    }
    expect(graphPathClasses(graph, "baseColor")).toEqual(expect.arrayContaining(["Desaturation", "FunctionCall", "Multiply"]));
  });

  it("lists both in the supported sets", () => {
    expect(supportedNodeClasses()).toContain("Desaturation");
    expect(supportedEngineFunctions()).toContain("SpeedTreeColorVariation");
  });
});

describe("SetMaterialAttributes, PivotPainter2FoliageShader, Blend_Overlay and CheapContrast", () => {
  const bake = (graph: MaterialGraph, textures: Record<string, Fixture> = {}) =>
    bakeGraph({ graph, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: makeLoader(textures).loadTexture, size: 2 });
  const breakBaseColor = (source: string): Raw =>
    node("break", "BreakMaterialAttributes", { inputs: { MaterialAttributes: pin(source) }, outputNames: ["BaseColor", "Metallic"] });
  const makeColour = (colour: string): Raw => node("make", "MakeMaterialAttributes", { inputs: { BaseColor: pin(colour, 0, RGB_MASK) } });
  const PIVOT = "PivotPainter2FoliageShader: world-position offset ignored; engine body unavailable";

  it("SetMaterialAttributes uses a wired Base Color override, else passes the incoming BaseColor through", async () => {
    const overridden = await bake(
      makeGraph([breakBaseColor("set"), node("set", "SetMaterialAttributes", { inputs: { MaterialAttributes: pin("make"), "Base Color": pin("over", 0, RGB_MASK) } }), makeColour("c"), constant3("c", [0.25, 0.5, 0.75]), constant3("over", [0.5, 0.125, 1])], pin("break", 0, RGB_MASK)),
    );
    expect((await pixelsOf(overridden))(0, 0)).toEqual([encode(0.5), encode(0.125), 255]);
    if (overridden.status === "baked") expect(overridden.confidence).toBe("exact");
    for (const incoming of ["MaterialAttributes", "Inputs[0]"]) {
      const passed = await bake(
        makeGraph([breakBaseColor("set"), node("set", "SetMaterialAttributes", { inputs: { [incoming]: pin("make"), Metallic: pin("c") } }), makeColour("c"), constant3("c", [0.25, 0.5, 0.75])], pin("break", 0, RGB_MASK)),
      );
      expect((await pixelsOf(passed))(1, 1)).toEqual([encode(0.25), encode(0.5), encode(0.75)]);
    }
  });

  it("SetMaterialAttributes with neither attributes nor override is unavailable", async () => {
    const result = await bake(makeGraph([breakBaseColor("set"), node("set", "SetMaterialAttributes")], pin("break", 0, RGB_MASK)));
    expect(result.status).toBe("unavailable");
  });

  it("PivotPainter2FoliageShader passes its attributes through and names the ignored offset", async () => {
    const result = await bake(
      makeGraph([breakBaseColor("pp"), engineCall("pp", "PivotPainter2FoliageShader", { "Material Attributes": pin("make") }), makeColour("c"), constant3("c", [0.25, 0.5, 0.75])], pin("break", 0, RGB_MASK)),
    );
    expect((await pixelsOf(result))(0, 0)).toEqual([encode(0.25), encode(0.5), encode(0.75)]);
    if (result.status === "baked") {
      expect(result.confidence).toBe("heuristic");
      expect(result.approximations).toEqual([PIVOT]);
    }
  });

  it("Blend_Overlay is exact per channel: 2*Base*Blend below 0.5, else 1-2*(1-Base)*(1-Blend)", async () => {
    // Base (0.25, 0.5, 0.75), Blend (0.6, 0.2, 0.2) by hand:
    //   R: 0.25 < 0.5      -> 2 * 0.25 * 0.6          = 0.3
    //   G: 0.5 is not < 0.5 -> 1 - 2 * 0.5 * 0.8       = 0.2
    //   B: 0.75            -> 1 - 2 * 0.25 * 0.8       = 0.6
    for (const pins of [["Base", "Blend"], ["Input0", "Input1"]] as const) {
      const result = await bake(
        makeGraph(
          [engineCall("o", "Blend_Overlay", { [pins[0]]: pin("base", 0, RGB_MASK), [pins[1]]: pin("blend", 0, RGB_MASK) }), constant3("base", [0.25, 0.5, 0.75]), constant3("blend", [0.6, 0.2, 0.2])],
          pin("o", 0, RGB_MASK),
        ),
      );
      expect((await pixelsOf(result))(0, 1)).toEqual([encode(0.3), encode(0.2), encode(0.6)]);
      if (result.status === "baked") expect(result.confidence).toBe("exact");
    }
  });

  it("CheapContrast is lerp(-Contrast, 1+Contrast, In) clamped to [0, 1]", async () => {
    // Contrast 0.2: -0.2 + 1.4 * In. In (0.3, 0.5, 0.9) -> (0.22, 0.5, 1.06 -> 1).
    for (const pins of [["In", "Contrast"], ["Input0", "Input1"]] as const) {
      const result = await bake(
        makeGraph(
          [engineCall("c", "CheapContrast", { [pins[0]]: pin("in", 0, RGB_MASK), [pins[1]]: pin("amount") }), constant3("in", [0.3, 0.5, 0.9]), node("amount", "Constant", { constants: { R: 0.2 } })],
          pin("c", 0, RGB_MASK),
        ),
      );
      expect((await pixelsOf(result))(0, 0)).toEqual([encode(0.22), encode(0.5), 255]);
      if (result.status === "baked") expect(result.confidence).toBe("exact");
    }
    // A negative result clamps to 0: In 0.1 -> -0.06.
    const dark = await bake(
      makeGraph([engineCall("c", "CheapContrast", { In: pin("in", 0, RGB_MASK), Contrast: pin("amount") }), constant3("in", [0.1, 0.1, 0.1]), node("amount", "Constant", { constants: { R: 0.2 } })], pin("c", 0, RGB_MASK)),
    );
    expect((await pixelsOf(dark))(0, 0)).toEqual([0, 0, 0]);
  });

  it("CheapContrast clamps before downstream arithmetic sees the value", async () => {
    // In (0.1, 0.5, 0.9), Contrast 0.2 -> raw (-0.06, 0.5, 1.06) -> clamped (0, 0.5, 1). Add 0.1: (0.1, 0.6, 1.1); Multiply 0.5 would give (0, 0.25, 0.5).
    const graph = makeGraph(
      [
        node("sum", "Add", { inputs: { A: pin("c", 0, RGB_MASK) }, constants: { ConstB: 0.1 } }),
        engineCall("c", "CheapContrast", { In: pin("in", 0, RGB_MASK), Contrast: pin("amount") }),
        constant3("in", [0.1, 0.5, 0.9]),
        node("amount", "Constant", { constants: { R: 0.2 } }),
      ],
      pin("sum", 0, RGB_MASK),
    );
    expect((await pixelsOf(await bake(graph)))(0, 0)).toEqual([encode(0.1), encode(0.6), 255]);
    const scaled = makeGraph(
      [
        node("half", "Multiply", { inputs: { A: pin("c", 0, RGB_MASK) }, constants: { ConstB: 0.5 } }),
        engineCall("c", "CheapContrast", { In: pin("in", 0, RGB_MASK), Contrast: pin("amount") }),
        constant3("in", [0.1, 0.5, 0.9]),
        node("amount", "Constant", { constants: { R: 0.2 } }),
      ],
      pin("half", 0, RGB_MASK),
    );
    expect((await pixelsOf(await bake(scaled)))(0, 0)).toEqual([0, encode(0.25), encode(0.5)]);
  });

  it("an engine function with an unwired colour input is unavailable", async () => {
    for (const name of ["Blend_Overlay", "CheapContrast", "PivotPainter2FoliageShader"]) {
      const result = await bake(makeGraph([engineCall("f", name, { Base: null })], pin("f", 0, RGB_MASK)));
      expect(result.status).toBe("unavailable");
    }
  });

  it("bakes Set(PivotPainter(Make(Multiply(Desaturation(SpeedTreeColorVariation(texture)), tint)))) and names only functions on the path", async () => {
    const source: Rgb = [200, 100, 50];
    const body = (withPivot: boolean): Raw[] => [
      breakBaseColor("set"),
      node("set", "SetMaterialAttributes", { inputs: { MaterialAttributes: pin(withPivot ? "pp" : "make") } }),
      ...(withPivot ? [engineCall("pp", "PivotPainter2FoliageShader", { "Material Attributes": pin("make") })] : []),
      makeColour("mul"),
      multiply("mul", pin("d", 0, RGB_MASK), pin("tint")),
      node("d", "Desaturation", { inputs: { Input: pin("v", 0, RGB_MASK), Fraction: pin("f") } }),
      node("f", "Constant", { constants: { R: 0.5 } }),
      engineCall("v", "SpeedTreeColorVariation", { "Base Color": pin("t", 0, RGB_MASK) }),
      textureSample("t", "T_Source"),
      constant3("tint", [1, 0.5, 0]),
    ];
    const textures = { T_Source: { png: await flat(source)(), srgb: true } };
    const linear = source.map(decode);
    const g = linear[0]! * 0.3 + linear[1]! * 0.59 + linear[2]! * 0.11;
    const expected = linear.map((channel, index) => encode((channel + (g - channel) * 0.5) * [1, 0.5, 0][index]!));

    const full = await bake(makeGraph(body(true), pin("break", 0, RGB_MASK)), textures);
    expect((await pixelsOf(full))(1, 0)).toEqual(expected);
    if (full.status === "baked") {
      expect(full.confidence).toBe("heuristic");
      expect(full.approximations).toEqual([PIVOT, "SpeedTreeColorVariation: per-instance colour variation ignored; engine body unavailable"]);
    }
    const bare = await bake(makeGraph(body(false), pin("break", 0, RGB_MASK)), textures);
    if (bare.status === "baked") expect(bare.approximations).toEqual(["SpeedTreeColorVariation: per-instance colour variation ignored; engine body unavailable"]);
    // Without the SpeedTree call either, nothing is approximated.
    const exact = await bake(
      makeGraph([breakBaseColor("set"), node("set", "SetMaterialAttributes", { inputs: { MaterialAttributes: pin("make") } }), makeColour("c"), constant3("c", [0.5, 0.5, 0.5])], pin("break", 0, RGB_MASK)),
    );
    if (exact.status === "baked") expect(exact).toMatchObject({ confidence: "exact", approximations: [] });
  });

  it("lists them in the supported sets", () => {
    expect(supportedNodeClasses()).toContain("SetMaterialAttributes");
    for (const name of ["PivotPainter2FoliageShader", "Blend_Overlay", "CheapContrast"]) expect(supportedEngineFunctions()).toContain(name);
  });
});

describe("HueShift", () => {
  const NOTE = "HueShift: engine body unavailable; hue rotated by Input1 as a fraction of a turn";
  const bake = (graph: MaterialGraph, textures: Record<string, Fixture> = {}) =>
    bakeGraph({ graph, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: makeLoader(textures).loadTexture, size: 2 });
  const shifted = (colour: [number, number, number], shift: number | null) =>
    bake(
      makeGraph(
        [
          engineCall("h", "HueShift", { Input0: pin("c", 0, RGB_MASK), ...(shift === null ? {} : { Input1: pin("s") }) }),
          constant3("c", colour),
          node("s", "Constant", { constants: { R: shift ?? 0 } }),
        ],
        pin("h", 0, RGB_MASK),
      ),
    );

  it("is an exact passthrough, with no approximation, for a zero or unwired shift", async () => {
    for (const shift of [0, null]) {
      const result = await shifted([0.5, 0.25, 0.125], shift);
      expect((await pixelsOf(result))(0, 0)).toEqual([encode(0.5), encode(0.25), encode(0.125)]);
      if (result.status === "baked") expect(result).toMatchObject({ confidence: "exact", approximations: [] });
    }
  });

  it("rotates hue by a fraction of a turn: red -> green at 1/3, cyan at 1/2, blue at -1/3", async () => {
    const third = await shifted([1, 0, 0], 1 / 3);
    expect((await pixelsOf(third))(0, 0)).toEqual([0, 255, 0]);
    if (third.status === "baked") expect(third).toMatchObject({ confidence: "heuristic", approximations: [NOTE] });
    expect((await pixelsOf(await shifted([1, 0, 0], 0.5)))(1, 1)).toEqual([0, 255, 255]);
    expect((await pixelsOf(await shifted([1, 0, 0], -1 / 3)))(0, 1)).toEqual([0, 0, 255]);
    // Saturation and value are kept: (0.5, 0.25, 0.25) is hue 0, S 0.5, V 0.5 -> hue 120 = (0.25, 0.5, 0.25).
    expect((await pixelsOf(await shifted([0.5, 0.25, 0.25], 1 / 3)))(0, 0)).toEqual([encode(0.25), encode(0.5), encode(0.25)]);
    // A grey has no hue to rotate.
    expect((await pixelsOf(await shifted([0.4, 0.4, 0.4], 0.3)))(0, 0)).toEqual([encode(0.4), encode(0.4), encode(0.4)]);
  });

  it("wraps a whole turn back to the identity", async () => {
    for (const shift of [1, 2, -1]) {
      expect((await pixelsOf(await shifted([0.5, 0.25, 0.125], shift)))(0, 0)).toEqual([encode(0.5), encode(0.25), encode(0.125)]);
    }
  });

  it("works inside Multiply(HueShift(texture, constant), tint) and records the approximation once", async () => {
    // Texel (255, 0, 0) is linear red; a third of a turn makes it green, and the 0.5 tint gives linear 0.5 = byte 188.
    const graph = makeGraph(
      [
        multiply("out", pin("h", 0, RGB_MASK), pin("tint")),
        engineCall("h", "HueShift", { Input0: pin("t", 0, RGB_MASK), Input1: pin("s") }),
        textureSample("t", "T_Red"),
        node("s", "Constant", { constants: { R: 1 / 3 } }),
        constant3("tint", [0.5, 0.5, 0.5]),
      ],
      pin("out"),
    );
    const result = await bake(graph, { T_Red: { png: await flat([255, 0, 0])(), srgb: true } });
    expect((await pixelsOf(result))(1, 0)).toEqual([0, encode(0.5), 0]);
    if (result.status === "baked") expect(result).toMatchObject({ confidence: "heuristic", approximations: [NOTE] });
  });

  it("is unavailable without a colour input and listed as supported", async () => {
    expect((await bake(makeGraph([engineCall("h", "HueShift", { Input1: null })], pin("h", 0, RGB_MASK)))).status).toBe("unavailable");
    expect(supportedEngineFunctions()).toContain("HueShift");
  });
});

describe("SmoothStep, SquareRoot, CrossProduct, VectorLength, RemapValueRange and LinearGradient", () => {
  const bake = (graph: MaterialGraph, textures: Record<string, Fixture> = {}) =>
    bakeGraph({ graph, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: makeLoader(textures).loadTexture, size: 2 });
  const scalar = (id: string, value: number): Raw => node(id, "Constant", { constants: { R: value } });
  /** The grey every channel of a scalar BaseColor encodes to. */
  const grey = (linear: number) => [encode(linear), encode(linear), encode(linear)];
  /** An engine function of the math library, as the dump shows a call whose body is engine content. */
  const mathCall = (id: string, name: string, inputs: Raw, outputNames: string[] = ["Result"]): Raw => ({
    ...engineCall(id, name, inputs),
    function: `/Engine/Functions/Engine_MaterialFunctions02/Math/${name}.${name}`,
    outputNames,
  });

  it("SmoothStep is HLSL smoothstep(Min, Max, Value), exact, with Unreal's ConstMin 0 / ConstMax 1 defaults", async () => {
    const step = (value: number, wiredRange: boolean) =>
      bake(
        makeGraph(
          [
            node("s", "SmoothStep", { inputs: { Value: pin("v"), ...(wiredRange ? { Min: pin("lo"), Max: pin("hi") } : {}) } }),
            scalar("v", value),
            scalar("lo", 0.2),
            scalar("hi", 0.6),
          ],
          pin("s"),
        ),
      );
    // t = (0.4 - 0.2) / 0.4 = 0.5 -> 0.5; t = 0.75 -> 0.84375; below and above the range clamp to 0 and 1.
    expect((await pixelsOf(await step(0.4, true)))(0, 0)).toEqual(grey(0.5));
    expect((await pixelsOf(await step(0.5, true)))(1, 1)).toEqual(grey(0.84375));
    expect((await pixelsOf(await step(0.1, true)))(0, 1)).toEqual(grey(0));
    expect((await pixelsOf(await step(0.9, true)))(1, 0)).toEqual(grey(1));
    // Unwired Min and Max are 0 and 1: smoothstep(0, 1, 0.25) = 0.15625.
    const unwired = await step(0.25, false);
    expect((await pixelsOf(unwired))(0, 0)).toEqual(grey(0.15625));
    expect(unwired).toMatchObject({ status: "baked", confidence: "exact", approximations: [] });
    // A stored ConstMax with the pin unwired: smoothstep(0, 0.5, 0.25) = 0.5.
    const stored = await bake(makeGraph([node("s", "SmoothStep", { inputs: { Value: pin("v") }, constants: { ConstMax: 0.5 } }), scalar("v", 0.25)], pin("s")));
    expect((await pixelsOf(stored))(0, 0)).toEqual(grey(0.5));
  });

  it("SmoothStep steps per channel of a vector Value", async () => {
    const result = await bake(makeGraph([node("s", "SmoothStep", { inputs: { Value: pin("v", 0, RGB_MASK) } }), constant3("v", [0, 0.5, 1])], pin("s")));
    expect((await pixelsOf(result))(0, 0)).toEqual([encode(0), encode(0.5), encode(1)]);
  });

  it("SquareRoot is exact, and a negative input reads 0 instead of NaN", async () => {
    const root = (value: number) => bake(makeGraph([node("q", "SquareRoot", { inputs: { Input: pin("v") } }), scalar("v", value)], pin("q")));
    const quarter = await root(0.25);
    expect((await pixelsOf(quarter))(0, 0)).toEqual(grey(0.5));
    expect(quarter).toMatchObject({ confidence: "exact", approximations: [] });
    expect((await pixelsOf(await root(-0.5)))(0, 0)).toEqual(grey(0));
    expect((await bake(makeGraph([node("q", "SquareRoot")], pin("q")))).status).toBe("unavailable");
  });

  it("CrossProduct is the exact 3-component cross product", async () => {
    const cross = (a: [number, number, number], b: [number, number, number]) =>
      bake(makeGraph([node("x", "CrossProduct", { inputs: { A: pin("a", 0, RGB_MASK), B: pin("b", 0, RGB_MASK) } }), constant3("a", a), constant3("b", b)], pin("x")));
    expect((await pixelsOf(await cross([1, 0, 0], [0, 1, 0])))(0, 0)).toEqual([0, 0, 255]);
    expect((await pixelsOf(await cross([0, 1, 0], [0, 0, 1])))(1, 1)).toEqual([255, 0, 0]);
    // (0.5, 0.25, 0) x (0, 0.5, 0.5) = (0.125, -0.25, 0.25): the negative component clamps to 0 in the PNG.
    expect((await pixelsOf(await cross([0.5, 0.25, 0], [0, 0.5, 0.5])))(0, 0)).toEqual([encode(0.125), 0, encode(0.25)]);
  });

  it("VectorLength is sqrt(dot(v, v)), recorded as an inferred engine body", async () => {
    const result = await bake(makeGraph([mathCall("l", "VectorLength", { Input0: pin("v", 0, RGB_MASK) }), constant3("v", [0.3, 0.4, 0])], pin("l")));
    expect((await pixelsOf(result))(0, 0)).toEqual(grey(0.5));
    expect(result).toMatchObject({ confidence: "heuristic" });
    if (result.status === "baked") expect(result.approximations).toEqual([expect.stringMatching(/^VectorLength: sqrt\(dot\(Input0, Input0\)\)/)]);
  });

  it("RemapValueRange maps Input from [Input Low, Input High] to [Target Low, Target High], unclamped", async () => {
    const remap = (inputs: Record<string, number>, value: Raw = scalar("x", 0.5)) =>
      bake(
        makeGraph(
          [
            mathCall("r", "RemapValueRange", Object.fromEntries([["Input0", pin("x", 0, value.class === "Constant3Vector" ? RGB_MASK : null)], ...Object.keys(inputs).map((key) => [key, pin(key)])])),
            value,
            ...Object.entries(inputs).map(([key, constant]) => scalar(key, constant)),
          ],
          pin("r"),
        ),
      );
    // 0.5 in [0, 1] to [0, 0.7] is 0.35, a remap that compresses an albedo.
    const compressed = await remap({ Input1: 0, Input2: 1, Input3: 0, Input4: 0.7 });
    expect((await pixelsOf(compressed))(0, 0)).toEqual(grey(0.35));
    expect(compressed).toMatchObject({ confidence: "heuristic" });
    if (compressed.status === "baked") expect(compressed.approximations).toEqual([expect.stringMatching(/^RemapValueRange: lerp\(Input3, Input4/)]);
    // 0.5 in [0.25, 0.75] to [1, 0] is 0.5; 0.5 in [0, 0.25] to [0, 0.1] is 0.2 (not clamped to 0.1).
    expect((await pixelsOf(await remap({ Input1: 0.25, Input2: 0.75, Input3: 1, Input4: 0 })))(1, 0)).toEqual(grey(0.5));
    expect((await pixelsOf(await remap({ Input1: 0, Input2: 0.25, Input3: 0, Input4: 0.1 })))(0, 1)).toEqual(grey(0.2));
    // Per channel on a colour.
    expect((await pixelsOf(await remap({ Input1: 0, Input2: 1, Input3: 0.2, Input4: 0.6 }, constant3("x", [0, 0.5, 1]))))(0, 0)).toEqual([encode(0.2), encode(0.4), encode(0.6)]);
    // A pin left unwired: its default is engine content, so the bake refuses rather than guess.
    expect((await remap({ Input1: 0, Input2: 1, Input3: 0 })).status).toBe("unavailable");
  });

  it("LinearGradient's U and V outputs are the texture coordinate ramps, by output name", async () => {
    const gradient = (output: number, inputs: Raw = {}) =>
      bake(makeGraph([mathCall("g", "LinearGradient", inputs, ["UGradient", "VGradient"]), textureCoordinate("uv", [2, 2])], pin("g", output)));
    // A 2x2 bake samples u, v at 0.25 and 0.75.
    const u = await pixelsOf(await gradient(0));
    expect([u(0, 0), u(1, 0), u(0, 1)]).toEqual([grey(0.25), grey(0.75), grey(0.25)]);
    const v = await pixelsOf(await gradient(1));
    expect([v(0, 0), v(1, 0), v(0, 1)]).toEqual([grey(0.25), grey(0.25), grey(0.75)]);
    // A wired UV input replaces UV0: tiling 2 doubles the ramp (0.5 at the first texel).
    expect((await pixelsOf(await gradient(0, { Input0: pin("uv") })))(0, 0)).toEqual(grey(0.5));
    const result = await gradient(0);
    if (result.status === "baked") expect(result.approximations).toEqual([expect.stringMatching(/^LinearGradient: the U or V texture coordinate/)]);
  });

  it("lists them in the supported sets", () => {
    for (const name of ["SmoothStep", "SquareRoot", "CrossProduct"]) expect(supportedNodeClasses()).toContain(name);
    for (const name of ["VectorLength", "RemapValueRange", "LinearGradient"]) expect(supportedEngineFunctions()).toContain(name);
  });
});

describe("graphPathClasses and supportedNodeClasses", () => {
  it("lists the classes on the active path only", () => {
    const nodes: Raw[] = [
      withInputs(node("switch", "StaticSwitch", { switchValue: false }), { A: pin("red"), B: pin("mix"), Value: pin("flag") }),
      constant3("red", [1, 0, 0]),
      node("mix", "Multiply", { inputs: { A: pin("vertex"), B: pin("time") } }),
      node("vertex", "VertexColor"),
      node("time", "Time"),
      boolParameter("flag", "UseConstant", true),
    ];
    const graph = makeGraph(nodes, pin("switch", 0, RGB_MASK));
    expect(graphPathClasses(graph, "baseColor", NO_PARAMETERS)).toEqual(["Constant3Vector", "StaticBoolParameter", "StaticSwitch"]);
    // Flipping the switch exposes the inactive branch, including the classes the evaluator cannot bake.
    expect(graphPathClasses(graph, "baseColor", params({ switches: { useconstant: false } }))).toEqual([
      "Multiply",
      "StaticBoolParameter",
      "StaticSwitch",
      "Time",
      "VertexColor",
    ]);
  });

  it("includes the unknown engine function and works for a material that cannot bake", () => {
    const graph = makeGraph(
      [
        node("break", "BreakMaterialAttributes", { inputs: { MaterialAttributes: pin("contrast") }, outputNames: ["BaseColor"] }),
        engineCall("contrast", "MatLayerBlend_Imaginary", { Input0: pin("make") }),
        node("make", "MakeMaterialAttributes", { inputs: { BaseColor: pin("v") } }),
        node("v", "VertexColor"),
      ],
      pin("break", 0, RGB_MASK),
    );
    expect(graphPathClasses(graph, "baseColor")).toEqual(["BreakMaterialAttributes", "FunctionCall", "MakeMaterialAttributes", "MatLayerBlend_Imaginary", "VertexColor"]);
  });

  it("exposes the closed node set", () => {
    const supported = supportedNodeClasses();
    for (const name of ["TextureSample", "TextureSampleParameter2D", "LinearInterpolate", "FunctionCall", "StaticSwitch", "FeatureLevelSwitch", "Fresnel", "DepthFade", "TwoSidedSign", "WorldPosition"]) {
      expect(supported).toContain(name);
    }
    for (const name of ["VertexColor", "CameraVectorWS", "ReflectionVectorWS", "TextureSampleParameterCube"]) expect(supported).not.toContain(name);
  });
});

describe("named reroutes", () => {
  const SOURCE: Rgb = [200, 100, 50];
  const bake = async (graph: MaterialGraph) =>
    bakeGraph({
      graph,
      output: "baseColor",
      parameters: NO_PARAMETERS,
      loadTexture: makeLoader({ T_Source: { png: await flat(SOURCE)(), srgb: true } }).loadTexture,
      size: 2,
    });

  it("bakes BaseColor = Multiply(Usage -> Declaration -> TextureSample, Constant3) exactly", async () => {
    const graph = makeGraph(
      [
        multiply("out", pin("use", 0, RGB_MASK), pin("tint", 0, RGB_MASK)),
        node("use", "NamedRerouteUsage", { inputs: { Input: pin("decl") }, constants: { DeclarationGuid: "00000000-0000-0000-0000-000000000001" } }),
        node("decl", "NamedRerouteDeclaration", { inputs: { Input: pin("tex") }, constants: { Name: "Albedo" } }),
        textureSample("tex", "T_Source"),
        constant3("tint", [0.5, 0.25, 1]),
      ],
      pin("out"),
    );
    const result = await bake(graph);
    const expected = [0.5, 0.25, 1].map((tint, index) => encode(decode(SOURCE[index]!) * tint));
    expect((await pixelsOf(result))(1, 1)).toEqual(expected);
    if (result.status === "baked") expect(result.confidence).toBe("exact");
    expect(graphPathClasses(graph, "baseColor")).toEqual(expect.arrayContaining(["NamedRerouteUsage", "NamedRerouteDeclaration", "TextureSample"]));
    expect(supportedNodeClasses()).toEqual(expect.arrayContaining(["NamedRerouteUsage", "NamedRerouteDeclaration"]));
  });

  it("honours the pin mask on the way through a reroute", async () => {
    const graph = makeGraph(
      [
        node("use", "NamedRerouteUsage", { inputs: { Input: pin("decl") } }),
        node("decl", "NamedRerouteDeclaration", { inputs: { Input: pin("tint") } }),
        constant3("tint", [0.5, 0.25, 1]),
      ],
      pin("use", 0, [0, 0, 1, 0]),
    );
    const pixel = await pixelsOf(await bake(graph));
    expect(pixel(0, 0)).toEqual([encode(1), encode(1), encode(1)]);
  });

  it("reports a usage with no declaration link (an old dump) as unsupported, naming NamedRerouteUsage", async () => {
    const graph = makeGraph(
      [multiply("out", pin("use", 0, RGB_MASK), pin("tint", 0, RGB_MASK)), node("use", "NamedRerouteUsage"), constant3("tint", [0.5, 0.25, 1])],
      pin("out"),
    );
    expect(await bake(graph)).toMatchObject({ status: "unsupported", unsupported: ["NamedRerouteUsage"] });
  });

  it("does not bake a usage whose declaration the dumper could not find", async () => {
    const graph = makeGraph(
      [
        multiply("out", pin("use", 0, RGB_MASK), pin("tint", 0, RGB_MASK)),
        node("use", "NamedRerouteUsage", { error: "named reroute declaration could not be found" }),
        constant3("tint", [0.5, 0.25, 1]),
      ],
      pin("out"),
    );
    const result = await bake(graph);
    expect(result.status).not.toBe("baked");
  });
});

// ---------------------------------------------------------------------------------------------------------
// Real SetMaterialAttributes / GetMaterialAttributes shape: pins are generic `Inputs[i]` and the attribute each
// carries is `attributeTypes[i - 1]` (hand-written from the Hornbeam MA_Foliage dump; no pack bytes).

describe("SetMaterialAttributes with attributeTypes (real dump shape), Reroute, QualitySwitch, ShadingModel", () => {
  const G = MATERIAL_ATTRIBUTE_GUIDS;
  const bake = (graph: MaterialGraph, textures: Record<string, Fixture> = {}) =>
    bakeGraph({ graph, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: makeLoader(textures).loadTexture, size: 2 });
  const breakBaseColor = (source: string): Raw =>
    node("break", "BreakMaterialAttributes", { inputs: { MaterialAttributes: pin(source) }, outputNames: ["BaseColor", "Metallic"] });
  const makeColour = (id: string, colour: string): Raw => node(id, "MakeMaterialAttributes", { inputs: { BaseColor: pin(colour, 0, RGB_MASK) } });
  const reroute = (id: string, source: Raw): Raw => node(id, "Reroute", { inputs: { Input: source } });
  const set = (inputs: Raw, attributeTypes: string[]): Raw => node("set", "SetMaterialAttributes", { inputs, attributeTypes });
  // Texel (x, y) of a 2x2 sRGB texture; the 2x2 bake samples each texel centre exactly.
  const bark: Rgb[][] = [
    [[200, 100, 50], [10, 220, 30]],
    [[255, 255, 255], [64, 128, 192]],
  ];
  const barkTexture = async (): Promise<Record<string, Fixture>> => ({ T_Bark: { png: await pngOf(2, 2, (x, y) => bark[y]![x]!), srgb: true } });
  const tint: Rgb = [0.5, 1, 0.25];
  const expectedBark = (x: number, y: number): number[] => bark[y]![x]!.map((byte, index) => encode(decode(byte) * tint[index]!));

  it("takes BaseColor from the pin typed with the BaseColor guid, not from a guessed name or position", async () => {
    // n2/n3 shape: Inputs[0] unwired, Inputs[1] BaseColor <- Reroute(Multiply(texture, tint)), Inputs[2] unknown attribute, Inputs[3] ShadingModel.
    const graph = makeGraph(
      [
        breakBaseColor("set"),
        set(
          { "Inputs[0]": null, "Inputs[1]": pin("rr"), "Inputs[2]": pin("time"), "Inputs[3]": pin("rrShading") },
          [G.BaseColor, "E8EBD0ADB1654CBEB079C3A8B39B9F15", G.ShadingModel],
        ),
        reroute("rr", pin("mul", 0, RGB_MASK)),
        multiply("mul", pin("tex", 0, RGB_MASK), pin("tint")),
        textureSample("tex", "T_Bark"),
        constant3("tint", tint),
        node("time", "Time"),
        reroute("rrShading", pin("shading")),
        node("shading", "ShadingModel"),
      ],
      pin("break", 0, RGB_MASK),
    );
    const result = await bake(graph, await barkTexture());
    const pixel = await pixelsOf(result);
    for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) expect(pixel(x, y)).toEqual(expectedBark(x, y));
    if (result.status === "baked") expect(result).toMatchObject({ confidence: "exact", approximations: [], texturesUsed: ["T_Bark"] });
  });

  it("the BaseColor pin overrides the incoming attributes, wherever it sits among the pins", async () => {
    const graph = makeGraph(
      [
        breakBaseColor("set"),
        set({ "Inputs[0]": pin("make"), "Inputs[1]": pin("c"), "Inputs[2]": pin("c"), "Inputs[3]": pin("over", 0, RGB_MASK) }, [G.Roughness, G.Normal, G.BaseColor]),
        makeColour("make", "c"),
        constant3("c", [0.25, 0.5, 0.75]),
        constant3("over", [0.5, 0.125, 1]),
      ],
      pin("break", 0, RGB_MASK),
    );
    expect((await pixelsOf(await bake(graph)))(0, 0)).toEqual([encode(0.5), encode(0.125), 255]);
  });

  it("an unwired BaseColor pin keeps the incoming BaseColor", async () => {
    const graph = makeGraph(
      [breakBaseColor("set"), set({ "Inputs[0]": pin("make"), "Inputs[1]": null, "Inputs[2]": pin("c") }, [G.BaseColor, G.Roughness]), makeColour("make", "c"), constant3("c", [0.25, 0.5, 0.75])],
      pin("break", 0, RGB_MASK),
    );
    expect((await pixelsOf(await bake(graph)))(1, 1)).toEqual([encode(0.25), encode(0.5), encode(0.75)]);
  });

  it("an unsupported node that feeds only a non-BaseColor pin does not block, and is not even visited", async () => {
    const graph = makeGraph(
      [
        breakBaseColor("set"),
        set(
          { "Inputs[0]": pin("make"), "Inputs[1]": pin("wpo"), "Inputs[2]": pin("normal"), "Inputs[3]": pin("shading") },
          [G.WorldPositionOffset, G.Normal, G.ShadingModel],
        ),
        makeColour("make", "c"),
        constant3("c", [0.25, 0.5, 0.75]),
        node("wpo", "RotateAboutAxis"),
        node("normal", "VertexNormalWS"),
        node("shading", "ReflectionVectorWS"),
      ],
      pin("break", 0, RGB_MASK),
    );
    const result = await bake(graph);
    expect((await pixelsOf(result))(0, 0)).toEqual([encode(0.25), encode(0.5), encode(0.75)]);
    expect(graphPathClasses(graph, "baseColor")).toEqual(["BreakMaterialAttributes", "Constant3Vector", "MakeMaterialAttributes", "SetMaterialAttributes"]);
  });

  it("an unsupported node on the BaseColor pin or the incoming attributes still blocks", async () => {
    const onColour = makeGraph(
      [breakBaseColor("set"), set({ "Inputs[0]": pin("make"), "Inputs[1]": pin("bad") }, [G.BaseColor]), makeColour("make", "c"), constant3("c", [1, 1, 1]), node("bad", "ReflectionVectorWS")],
      pin("break", 0, RGB_MASK),
    );
    expect(await bake(onColour)).toMatchObject({ status: "unsupported", unsupported: ["ReflectionVectorWS"] });
    const onIncoming = makeGraph(
      [breakBaseColor("set"), set({ "Inputs[0]": pin("bad"), "Inputs[1]": pin("c") }, [G.Roughness]), constant3("c", [1, 1, 1]), node("bad", "ReflectionVectorWS")],
      pin("break", 0, RGB_MASK),
    );
    expect(await bake(onIncoming)).toMatchObject({ status: "unsupported", unsupported: ["ReflectionVectorWS"] });
  });

  it("a SetMaterialAttributes with no incoming attributes and no BaseColor pin is Unreal's default black, and says so", async () => {
    // An eye-occlusion shadow card only sets Opacity and the shading model; BaseColor is the attribute default (black).
    const graph = makeGraph([set({ "Inputs[1]": pin("opacity") }, [G.Roughness]), node("opacity", "Constant", { constants: { R: 0.5 } })], pin("set"));
    const result = await bake(graph);
    expect(result.status).toBe("baked");
    expect((await pixelsOf(result))(0, 0)).toEqual([0, 0, 0]);
    expect(result.status === "baked" && result.approximations.some((note) => note.startsWith("SetMaterialAttributes has no incoming attributes"))).toBe(true);
  });

  it("sibling: an incoming attributes pin that cannot be read stays unavailable, never black", async () => {
    const graph = makeGraph(
      [set({ "Inputs[0]": pin("broken") }, [G.Roughness]), node("broken", "NamedRerouteUsage", { error: "named reroute declaration could not be found" })],
      pin("set"),
    );
    const result = await bake(graph);
    expect(result.status).not.toBe("baked");
  });

  it("falls back to by-name matching when the dump carries no attributeTypes", async () => {
    const graph = makeGraph(
      [breakBaseColor("set"), node("set", "SetMaterialAttributes", { inputs: { "Inputs[0]": pin("make"), "Base Color": pin("over", 0, RGB_MASK) } }), makeColour("make", "c"), constant3("c", [0.25, 0.5, 0.75]), constant3("over", [0.5, 0.125, 1])],
      pin("break", 0, RGB_MASK),
    );
    expect((await pixelsOf(await bake(graph)))(0, 0)).toEqual([encode(0.5), encode(0.125), 255]);
  });

  it("GetMaterialAttributes reads only the output it is asked for", async () => {
    // outputNames[0] is the attribute pass-through; attributeTypes[k - 1] types output k.
    const get = (id: string, source: string): Raw =>
      node(id, "GetMaterialAttributes", { inputs: { MaterialAttributes: pin(source) }, outputNames: ["MaterialAttributes", "BaseColor", "Normal"], attributeTypes: [G.BaseColor, G.Normal] });
    const nodes = (): Raw[] => [get("get", "make"), makeColour("make", "c"), constant3("c", [0.25, 0.5, 0.75])];
    const colour = await bake(makeGraph(nodes(), pin("get", 1, RGB_MASK)));
    expect((await pixelsOf(colour))(0, 0)).toEqual([encode(0.25), encode(0.5), encode(0.75)]);
    const passthrough = makeGraph([breakBaseColor("get"), get("get", "make"), makeColour("make", "c"), constant3("c", [0.25, 0.5, 0.75])], pin("break", 0, RGB_MASK));
    expect((await pixelsOf(await bake(passthrough)))(1, 0)).toEqual([encode(0.25), encode(0.5), encode(0.75)]);
    const normal = await bake(makeGraph(nodes(), pin("get", 2, RGB_MASK)));
    expect(normal).toMatchObject({ status: "unsupported", unsupported: ["GetMaterialAttributes.Normal"] });
  });

  it("BreakMaterialAttributes does not walk its input for an attribute the bake does not carry (Specular)", async () => {
    const graph = makeGraph(
      [node("break", "BreakMaterialAttributes", { inputs: { MaterialAttributes: pin("bad") }, outputNames: ["BaseColor", "Metallic", "Specular"] }), node("bad", "ReflectionVectorWS")],
      pin("break", 2, RGB_MASK),
    );
    expect(await bake(graph)).toMatchObject({ status: "unsupported", unsupported: ["BreakMaterialAttributes.Specular"] });
  });

  it("Reroute is an exact pass-through of Input", async () => {
    const result = await bake(makeGraph([reroute("a", pin("b")), reroute("b", pin("c", 0, RGB_MASK)), constant3("c", [0.25, 0.5, 0.75])], pin("a", 0, RGB_MASK)));
    expect((await pixelsOf(result))(0, 0)).toEqual([encode(0.25), encode(0.5), encode(0.75)]);
    if (result.status === "baked") expect(result).toMatchObject({ confidence: "exact", approximations: [] });
    expect(await bake(makeGraph([node("a", "Reroute")], pin("a", 0, RGB_MASK)))).toMatchObject({ status: "unavailable" });
  });

  it("QualitySwitch takes Default exactly and never visits the quality slots", async () => {
    const graph = makeGraph(
      [
        node("q", "QualitySwitch", { inputs: { Default: pin("hi", 0, RGB_MASK), "Inputs[0]": pin("bad"), "Inputs[1]": pin("lo", 0, RGB_MASK), "Inputs[2]": pin("bad") } }),
        constant3("hi", [0.25, 0.5, 0.75]),
        constant3("lo", [1, 0, 0]),
        node("bad", "ReflectionVectorWS"),
      ],
      pin("q", 0, RGB_MASK),
    );
    const result = await bake(graph);
    expect((await pixelsOf(result))(0, 0)).toEqual([encode(0.25), encode(0.5), encode(0.75)]);
    if (result.status === "baked") expect(result).toMatchObject({ confidence: "exact", approximations: [] });
    expect(await bake(makeGraph([node("q", "QualitySwitch")], pin("q", 0, RGB_MASK)))).toMatchObject({ status: "unavailable" });
  });

  it("ShadingModel is a supported constant", async () => {
    const result = await bake(makeGraph([node("s", "ShadingModel")], pin("s")));
    expect(result.status).toBe("baked");
    expect(supportedNodeClasses()).toEqual(expect.arrayContaining(["Reroute", "QualitySwitch", "ShadingModel", "GetMaterialAttributes"]));
  });

  it("DitherTemporalAA and FlattenNormal pass Input0 through as heuristics with named approximations", async () => {
    const cases: [string, string][] = [
      ["DitherTemporalAA", "DitherTemporalAA: dithering ignored; engine body unavailable"],
      ["FlattenNormal", "FlattenNormal: normal-only function; BaseColor path unaffected (engine body unavailable)"],
    ];
    for (const [name, note] of cases) {
      const graph = makeGraph(
        [engineCall("f", name, { Input0: pin("c", 0, RGB_MASK), Input1: pin("bad") }), constant3("c", [0.25, 0.5, 0.75]), node("bad", "ReflectionVectorWS")],
        pin("f", 0, RGB_MASK),
      );
      const result = await bake(graph);
      expect((await pixelsOf(result))(0, 0), name).toEqual([encode(0.25), encode(0.5), encode(0.75)]);
      if (result.status === "baked") expect(result).toMatchObject({ confidence: "heuristic", approximations: [note] });
      expect(supportedEngineFunctions()).toContain(name);
    }
  });
});

describe("Metallic and Roughness beside BaseColor", () => {
  const G = MATERIAL_ATTRIBUTE_GUIDS;
  // Not in MATERIAL_ATTRIBUTE_GUIDS: it stands for an attribute the table does not name, and asserts nothing about which one.
  const UNNAMED_GUID = "0123456789ABCDEF0123456789ABCDEF";
  const TINT: Rgb = [0.8, 0.6, 0.4];
  const WHITE = constant3("white", [1, 1, 1]);
  const BREAK_OUTPUTS = ["BaseColor", "Metallic", "Specular", "Roughness"];
  const METALLIC = 1;
  const ROUGHNESS = 3;
  // Constant colours are linear, so BaseColor = TINT x s is encoded channel by channel.
  const tintTimes = (scale: number): number[] => TINT.map((channel) => encode(channel * scale));
  const bake = (graph: MaterialGraph) =>
    bakeGraph({ graph, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: makeLoader({}).loadTexture, size: 2 });
  const pixelOf = async (graph: MaterialGraph): Promise<number[]> => {
    const result = await bake(graph);
    expect(result.status).toBe("baked");
    return (await pixelsOf(result))(0, 0);
  };
  const breakOf = (id: string, source: string): Raw =>
    node(id, "BreakMaterialAttributes", { inputs: { MaterialAttributes: pin(source) }, outputNames: BREAK_OUTPUTS });
  const make = (id: string, scalars: Raw = {}): Raw => node(id, "MakeMaterialAttributes", { inputs: { BaseColor: pin("white"), ...scalars } });
  const scalar = (id: string, value: number): Raw => node(id, "Constant", { constants: { R: value } });
  // BaseColor = TINT x output `output` of the node `reader`; `nodes` holds everything else the graph needs.
  const tinted = (reader: string, output: number, nodes: Raw[]): MaterialGraph =>
    makeGraph([multiply("m", pin("tint"), pin(reader, output)), constant3("tint", TINT), WHITE, ...nodes], pin("m"));

  it("reads Metallic from a MakeMaterialAttributes and multiplies BaseColor by it", async () => {
    const graph = tinted("reader", METALLIC, [breakOf("reader", "make"), make("make", { Metallic: pin("metal") }), scalar("metal", 0.25)]);
    expect(await pixelOf(graph)).toEqual(tintTimes(0.25));
  });

  it("reads Roughness from a MakeMaterialAttributes the same way", async () => {
    const graph = tinted("reader", ROUGHNESS, [breakOf("reader", "make"), make("make", { Roughness: pin("rough") }), scalar("rough", 0.25)]);
    expect(await pixelOf(graph)).toEqual(tintTimes(0.25));
  });

  it("takes Unreal's default for an unwired Make pin: Roughness 0.5, and Metallic 0", async () => {
    expect(await pixelOf(tinted("reader", ROUGHNESS, [breakOf("reader", "make"), make("make")]))).toEqual(tintTimes(0.5));
    expect(await pixelOf(tinted("reader", METALLIC, [breakOf("reader", "make"), make("make")]))).toEqual([0, 0, 0]);
  });

  it("reads a Break with no MaterialAttributes input as unknown, not as the defaults", async () => {
    const graph = tinted("reader", ROUGHNESS, [node("reader", "BreakMaterialAttributes", { inputs: {}, outputNames: BREAK_OUTPUTS })]);
    expect(await bake(graph)).toMatchObject({ status: "unsupported", unsupported: ["BreakMaterialAttributes.Roughness"] });
  });

  it("changes the baked RGB when the scalar changes", async () => {
    const at = (metallic: number) =>
      pixelOf(tinted("reader", METALLIC, [breakOf("reader", "make"), make("make", { Metallic: pin("metal") }), scalar("metal", metallic)]));
    expect(await at(0.25)).toEqual(tintTimes(0.25));
    expect(await at(0.75)).toEqual(tintTimes(0.75));
  });

  it("keeps the Make's Metallic through a Set that overrides BaseColor", async () => {
    const set = node("set", "SetMaterialAttributes", { inputs: { "Inputs[0]": pin("make"), "Inputs[1]": pin("tint") }, attributeTypes: [G.BaseColor, G.Roughness] });
    const graph = tinted("reader", METALLIC, [breakOf("reader", "set"), set, make("make", { Metallic: pin("metal") }), scalar("metal", 0.25)]);
    expect(await pixelOf(graph)).toEqual(tintTimes(0.25));
  });

  it("takes a Set's Roughness override over the Make's, and keeps the Make's Metallic", async () => {
    const set = node("set", "SetMaterialAttributes", { inputs: { "Inputs[0]": pin("make"), "Inputs[2]": pin("override") }, attributeTypes: [G.BaseColor, G.Roughness] });
    const source = [make("make", { Metallic: pin("metal"), Roughness: pin("low") }), scalar("metal", 0.25), scalar("low", 0.1), scalar("override", 0.75)];
    expect(await pixelOf(tinted("reader", ROUGHNESS, [breakOf("reader", "set"), set, ...source]))).toEqual(tintTimes(0.75));
    expect(await pixelOf(tinted("reader", METALLIC, [breakOf("reader", "set"), set, ...source]))).toEqual(tintTimes(0.25));
  });

  it("starts a Set with no incoming attributes from the defaults", async () => {
    // Only BaseColor is set, so Roughness is Unreal's default 0.5.
    const set = node("set", "SetMaterialAttributes", { inputs: { "Inputs[1]": pin("tint") }, attributeTypes: [G.BaseColor] });
    expect(await pixelOf(tinted("reader", ROUGHNESS, [breakOf("reader", "set"), set]))).toEqual(tintTimes(0.5));
  });

  it("reads Roughness by its known GUID, and Metallic by its output name", async () => {
    const source = [make("make", { Metallic: pin("metal"), Roughness: pin("rough") }), scalar("metal", 0.25), scalar("rough", 0.75)];
    const byGuid = node("get", "GetMaterialAttributes", { inputs: { MaterialAttributes: pin("make") }, outputNames: ["MaterialAttributes", "Roughness"], attributeTypes: [G.Roughness] });
    const byName = node("getm", "GetMaterialAttributes", { inputs: { MaterialAttributes: pin("make") }, outputNames: ["MaterialAttributes", "Metallic"] });
    expect(await pixelOf(tinted("get", 1, [byGuid, ...source]))).toEqual(tintTimes(0.75));
    expect(await pixelOf(tinted("getm", 1, [byName, ...source]))).toEqual(tintTimes(0.25));
  });

  it("blends Metallic by Alpha in BlendMaterialAttributes", async () => {
    const blend = node("blend", "BlendMaterialAttributes", { inputs: { A: pin("ma"), B: pin("mb"), Alpha: pin("alpha") } });
    const nodes = [breakOf("reader", "blend"), blend, make("ma", { Metallic: pin("m0") }), make("mb", { Metallic: pin("m1") }), scalar("m0", 0.2), scalar("m1", 0.8), scalar("alpha", 0.25)];
    // 0.2 + (0.8 - 0.2) x 0.25
    expect(await pixelOf(tinted("reader", METALLIC, nodes))).toEqual(tintTimes(0.35));
  });

  it("blends Metallic by Alpha through MatLayerBlend_Standard, as the attribute blend does", async () => {
    const layer = engineCall("layer", "MatLayerBlend_Standard", { Input0: pin("ma"), Input1: pin("mb"), Input2: pin("alpha") });
    const nodes = [breakOf("reader", "layer"), layer, make("ma", { Metallic: pin("m0") }), make("mb", { Metallic: pin("m1") }), scalar("m0", 0.2), scalar("m1", 0.8), scalar("alpha", 0.25)];
    expect(await pixelOf(tinted("reader", METALLIC, nodes))).toEqual(tintTimes(0.35));
  });

  it("keeps Metallic and Roughness through MatLayerBlend_AO, NormalBlend and Tint", async () => {
    const source = [make("make", { Metallic: pin("metal"), Roughness: pin("rough") }), scalar("metal", 0.25), scalar("rough", 0.75), constant3("layerTint", [0.5, 0.5, 0.5])];
    const layers: [string, Raw][] = [
      ["MatLayerBlend_AO", engineCall("layer", "MatLayerBlend_AO", { Input0: pin("make") })],
      ["MatLayerBlend_NormalBlend", engineCall("layer", "MatLayerBlend_NormalBlend", { Input0: pin("make"), Input1: null })],
      ["MatLayerBlend_Tint", engineCall("layer", "MatLayerBlend_Tint", { Input0: pin("make"), Input1: pin("layerTint") })],
    ];
    for (const [name, layer] of layers) {
      expect(await pixelOf(tinted("reader", METALLIC, [breakOf("reader", "layer"), layer, ...source])), name).toEqual(tintTimes(0.25));
      expect(await pixelOf(tinted("reader", ROUGHNESS, [breakOf("reader", "layer"), layer, ...source])), name).toEqual(tintTimes(0.75));
    }
  });

  it("keeps Metallic through MatLayerBlend_ModulateRoughness, and names Roughness as unknown there", async () => {
    const source = [make("make", { Metallic: pin("metal"), Roughness: pin("rough") }), scalar("metal", 0.25), scalar("rough", 0.75)];
    const layer = () => engineCall("layer", "MatLayerBlend_ModulateRoughness", { Input0: pin("make") });
    expect(await pixelOf(tinted("reader", METALLIC, [breakOf("reader", "layer"), layer(), ...source]))).toEqual(tintTimes(0.25));
    expect(await bake(tinted("reader", ROUGHNESS, [breakOf("reader", "layer"), layer(), ...source]))).toMatchObject({
      status: "unsupported",
      unsupported: ["BreakMaterialAttributes.Roughness", "MatLayerBlend_ModulateRoughness.Roughness"],
    });
  });

  it("takes the Roughness of a pack-local MatLayerBlend_ModulateRoughness from its own body", async () => {
    const call = node("layer", "FunctionCall", {
      inputs: {},
      function: "/Game/Test/MatLayerBlend_ModulateRoughness.MatLayerBlend_ModulateRoughness",
      outputNames: ["Result"],
      fn: { inputs: {}, outputs: ["body"], output: "body", outputNames: [""] },
    });
    const nodes = [breakOf("reader", "layer"), call, make("body", { Roughness: pin("low") }), scalar("low", 0.1)];
    expect(await pixelOf(tinted("reader", ROUGHNESS, nodes))).toEqual(tintTimes(0.1));
  });

  it("does not visit an unsupported Normal, or an unused Metallic, on a BaseColor-only path", async () => {
    const graph = makeGraph(
      [breakOf("reader", "make"), make("make", { Normal: pin("bad"), Metallic: pin("bad") }), node("bad", "ReflectionVectorWS"), constant3("white", [0.5, 0.5, 0.5])],
      pin("reader", 0, RGB_MASK),
    );
    expect(await pixelOf(graph)).toEqual([encode(0.5), encode(0.5), encode(0.5)]);
  });

  it("fails a BaseColor path that consumes an unsupported Metallic, and names the node", async () => {
    const graph = tinted("reader", METALLIC, [breakOf("reader", "make"), make("make", { Metallic: pin("bad") }), node("bad", "ReflectionVectorWS")]);
    expect(await bake(graph)).toMatchObject({ status: "unsupported", unsupported: ["ReflectionVectorWS"] });
  });

  it("makes Metallic unknown after a Set that overrides an attribute the table does not name, and names that pin", async () => {
    const set = node("set", "SetMaterialAttributes", { inputs: { "Inputs[0]": pin("make"), "Inputs[2]": pin("override") }, attributeTypes: [G.BaseColor, UNNAMED_GUID] });
    const nodes = [breakOf("reader", "set"), set, make("make", { Metallic: pin("metal") }), scalar("metal", 0.25), scalar("override", 0.75)];
    expect(await bake(tinted("reader", METALLIC, nodes))).toMatchObject({
      status: "unsupported",
      unsupported: ["BreakMaterialAttributes.Metallic", `SetMaterialAttributes.${UNNAMED_GUID}`],
    });
  });

  it("does not let that unnamed override block a BaseColor-only bake", async () => {
    const set = node("set", "SetMaterialAttributes", { inputs: { "Inputs[0]": pin("make"), "Inputs[2]": pin("override") }, attributeTypes: [G.BaseColor, UNNAMED_GUID] });
    const graph = makeGraph(
      [breakOf("reader", "set"), set, make("make", { Metallic: pin("metal") }), scalar("metal", 0.25), scalar("override", 0.75), WHITE],
      pin("reader", 0, RGB_MASK),
    );
    expect(await pixelOf(graph)).toEqual([encode(1), encode(1), encode(1)]);
  });

  it("still reads a Roughness override beside an unnamed override pin", async () => {
    const set = node("set", "SetMaterialAttributes", {
      inputs: { "Inputs[0]": pin("make"), "Inputs[2]": pin("override"), "Inputs[3]": pin("rough") },
      attributeTypes: [G.BaseColor, UNNAMED_GUID, G.Roughness],
    });
    expect(await pixelOf(tinted("reader", ROUGHNESS, [breakOf("reader", "set"), set, make("make"), scalar("override", 0.3), scalar("rough", 0.75)]))).toEqual(tintTimes(0.75));
  });

  it("reads a vector wired to a scalar input through its first component", async () => {
    const nodes = [breakOf("reader", "make"), make("make", { Roughness: pin("rgb") }), constant3("rgb", [0.25, 0.9, 0.5])];
    expect(await pixelOf(tinted("reader", ROUGHNESS, nodes))).toEqual(tintTimes(0.25));
  });

  it("reads a legacy Set's Roughness override by its pin name", async () => {
    const set = node("set", "SetMaterialAttributes", { inputs: { MaterialAttributes: pin("make"), Roughness: pin("rough") } });
    expect(await pixelOf(tinted("reader", ROUGHNESS, [breakOf("reader", "set"), set, make("make"), scalar("rough", 0.75)]))).toEqual(tintTimes(0.75));
  });

  // BaseColor is lazy too: reading only a scalar of a Make/Set/Blend/layer must not compile an unsupported BaseColor node.
  it("reads Metallic from a Make whose BaseColor is unsupported", async () => {
    const nodes = [breakOf("reader", "make"), node("make", "MakeMaterialAttributes", { inputs: { BaseColor: pin("bad"), Metallic: pin("metal") } }), scalar("metal", 0.7), node("bad", "ReflectionVectorWS")];
    expect(await pixelOf(tinted("reader", METALLIC, nodes))).toEqual(tintTimes(0.7));
  });

  it("reads Metallic through a Set whose BaseColor override is unsupported", async () => {
    const set = node("set", "SetMaterialAttributes", { inputs: { "Inputs[0]": pin("make"), "Inputs[1]": pin("bad") }, attributeTypes: [G.BaseColor] });
    const nodes = [breakOf("reader", "set"), set, node("make", "MakeMaterialAttributes", { inputs: { Metallic: pin("metal") } }), scalar("metal", 0.7), node("bad", "ReflectionVectorWS")];
    expect(await pixelOf(tinted("reader", METALLIC, nodes))).toEqual(tintTimes(0.7));
  });

  it("blends Metallic without compiling an unsupported BaseColor on either side", async () => {
    const blend = node("blend", "BlendMaterialAttributes", { inputs: { A: pin("ma"), B: pin("mb"), Alpha: pin("alpha") } });
    const nodes = [
      breakOf("reader", "blend"),
      blend,
      node("ma", "MakeMaterialAttributes", { inputs: { BaseColor: pin("bad"), Metallic: pin("m0") } }),
      make("mb", { Metallic: pin("m1") }),
      scalar("m0", 0.2),
      scalar("m1", 0.8),
      scalar("alpha", 0.25),
      node("bad", "ReflectionVectorWS"),
    ];
    // 0.2 + (0.8 - 0.2) x 0.25
    expect(await pixelOf(tinted("reader", METALLIC, nodes))).toEqual(tintTimes(0.35));
  });

  it("passes Metallic through a BaseColor writer whose colour is unsupported", async () => {
    const layer = engineCall("layer", "MatLayerBlend_OverrideBaseColor", { Input0: pin("make"), Input1: pin("bad") });
    const nodes = [breakOf("reader", "layer"), layer, make("make", { Metallic: pin("metal") }), scalar("metal", 0.7), node("bad", "ReflectionVectorWS")];
    expect(await pixelOf(tinted("reader", METALLIC, nodes))).toEqual(tintTimes(0.7));
  });

  it("passes Roughness through a Tint layer whose tint is unsupported", async () => {
    const layer = engineCall("layer", "MatLayerBlend_Tint", { Input0: pin("make"), Input1: pin("bad") });
    const nodes = [breakOf("reader", "layer"), layer, make("make", { Roughness: pin("rough") }), scalar("rough", 0.75), node("bad", "ReflectionVectorWS")];
    expect(await pixelOf(tinted("reader", ROUGHNESS, nodes))).toEqual(tintTimes(0.75));
  });
});

describe("a cycle in attribute forwarding is reported, not run away", () => {
  // A typed Set with no attributeTypes: Inputs[0] is the incoming attributes and nothing overrides them.
  const setOf = (id: string, incoming: Raw): Raw => node(id, "SetMaterialAttributes", { inputs: { "Inputs[0]": incoming }, attributeTypes: [] });
  const readerOf = (source: string): Raw => node("reader", "BreakMaterialAttributes", { inputs: { MaterialAttributes: pin(source) }, outputNames: ["BaseColor", "Metallic"] });
  const bake = (graph: MaterialGraph) => bakeGraph({ graph, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: makeLoader({}).loadTexture, size: 2 });
  // BaseColor = TINT x Break(source).<output>, so a scalar read shows up in the baked RGB.
  const tintedRead = (source: string, output: number, nodes: Raw[]): MaterialGraph =>
    makeGraph([multiply("m", pin("tint"), pin("reader", output)), constant3("tint", [0.8, 0.6, 0.4]), readerOf(source), ...nodes], pin("m"));
  // A forwarding cycle must be a diagnostic, never a RangeError from the stack.
  const expectCycle = (result: BakeResult) => {
    expect(result.status).not.toBe("baked");
    expect(result).toMatchObject({ reason: expect.stringContaining("cycle") });
  };

  it("refuses a SetMaterialAttributes whose incoming pin is itself, on BaseColor", async () => {
    expectCycle(await bake(makeGraph([setOf("set", pin("set"))], pin("set"))));
  });

  it("refuses the same self-cycle on a scalar read", async () => {
    expectCycle(await bake(tintedRead("set", 1, [setOf("set", pin("set"))])));
  });

  it("refuses two Sets that forward their attributes to each other, on BaseColor", async () => {
    expectCycle(await bake(makeGraph([setOf("a", pin("b")), setOf("b", pin("a"))], pin("a"))));
  });

  it("refuses the same two-node cycle on a scalar read", async () => {
    expectCycle(await bake(tintedRead("a", 1, [setOf("a", pin("b")), setOf("b", pin("a"))])));
  });
});

describe("attribute-scoped reads: static switches and legacy Set overrides", () => {
  const BREAK_OUTPUTS = ["BaseColor", "Metallic", "Specular", "Roughness", "EmissiveColor", "Opacity", "OpacityMask", "Normal"];
  const METALLIC = 1;
  const ROUGHNESS = 3;
  const OPACITY_MASK = 6;
  const TINT: Rgb = [0.8, 0.6, 0.4];
  const MASK_BYTES = [64, 128, 191, 255];
  const WHITE = constant3("white", [1, 1, 1]);
  const tintTimes = (scale: number): number[] => TINT.map((channel) => encode(channel * scale));
  const breakOf = (id: string, source: string): Raw => node(id, "BreakMaterialAttributes", { inputs: { MaterialAttributes: pin(source) }, outputNames: BREAK_OUTPUTS });
  const make = (id: string, baseColor: string, scalars: Raw = {}): Raw => node(id, "MakeMaterialAttributes", { inputs: { BaseColor: pin(baseColor), ...scalars } });
  const scalar = (id: string, value: number): Raw => node(id, "Constant", { constants: { R: value } });
  // The switch takes A by default. A's BaseColor samples a texture no instance binds; B's BaseColor is white.
  const switchOf = (id: string, a: string, b: string, name: string): Raw => node(id, "StaticSwitchParameter", { inputs: { A: pin(a), B: pin(b) }, parameter: { name, group: "" }, default: true });
  const unbound = (id: string): Raw => node(id, "TextureSampleParameter2D", { parameter: { name: "BaseTexture", group: "Base" }, default: null, texture: null, samplerType: "Color" });
  const bad = (id: string): Raw => node(id, "ReflectionVectorWS");
  // BaseColor = TINT x output `output` of a Break of `source`; `nodes` holds the rest of the graph.
  const tintedRead = (source: string, output: number, nodes: Raw[]): MaterialGraph =>
    makeGraph([multiply("m", pin("tint"), pin("reader", output)), constant3("tint", TINT), breakOf("reader", source), ...nodes], pin("m"));
  // The colour is `baseColor`; the cut-out is the OpacityMask of a Break of `source`. `nodes` holds the rest of the graph.
  const cutOut = (source: string, baseColor: string, nodes: Raw[]): MaterialGraph => {
    const all = [breakOf("reader", source), ...nodes];
    return materialGraphSchema.parse({
      format: 1,
      material: "M_Test",
      package: "/Game/Test/M_Test",
      truncated: false,
      nodeCount: all.length,
      outputs: { baseColor: pin(baseColor), roughness: null, metallic: null, emissive: null, opacity: null, opacityMask: pin("reader", OPACITY_MASK, [1, 0, 0, 0]), normal: null, materialAttributes: null },
      nodes: all,
    });
  };
  const bakeColour = (graph: MaterialGraph) => bakeGraph({ graph, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: makeLoader({}).loadTexture, size: 2 });
  const pixelOf = async (graph: MaterialGraph): Promise<number[]> => {
    const result = await bakeColour(graph);
    expect(result.status).toBe("baked");
    return (await pixelsOf(result))(0, 0);
  };
  const maskTextures = async (): Promise<Record<string, Fixture>> => ({
    T_Mask: { png: await pngOf(2, 2, (x, y) => [MASK_BYTES[y * 2 + x]!, 0, 0]), srgb: false },
    T_Other: { png: await pngOf(2, 2, () => [255, 0, 0]), srgb: false },
  });
  const bakeCutOut = async (graph: MaterialGraph) =>
    bakeGraph({ graph, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: makeLoader(await maskTextures()).loadTexture, size: 2, alpha: "opacityMask" });
  // Alpha of the four texels of the 2 x 2 cut-out bake, in the order the mask fixture was written. (pixelsOf drops alpha.)
  const alphaOf = async (result: BakeResult): Promise<number[]> => {
    if (result.status !== "baked") throw new Error(`expected baked, got ${result.status}`);
    const { data, info } = await sharp(result.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => data[(y * info.width + x) * 4 + 3]!;
    return [at(0, 0), at(1, 0), at(0, 1), at(1, 1)];
  };
  const cutOutAlpha = async (graph: MaterialGraph): Promise<number[]> => alphaOf(await bakeCutOut(graph));

  describe("a static switch probes only the attribute its read asks for", () => {
    // Roughness is .2 on the default branch and .8 on B.
    const roughnessSwitch = (): Raw[] => [
      switchOf("sw", "makeA", "makeB", "UseA"),
      make("makeA", "unbound", { Roughness: pin("roughA") }),
      make("makeB", "white", { Roughness: pin("roughB") }),
      unbound("unbound"),
      WHITE,
      scalar("roughA", 0.2),
      scalar("roughB", 0.8),
    ];

    it("takes the Roughness of the default branch when only Roughness is read", async () => {
      expect(await pixelOf(tintedRead("sw", ROUGHNESS, roughnessSwitch()))).toEqual(tintTimes(0.2));
    });

    it("takes the Metallic of the default branch when only Metallic is read", async () => {
      const nodes = [
        switchOf("sw", "makeA", "makeB", "UseA"),
        make("makeA", "unbound", { Metallic: pin("metalA") }),
        make("makeB", "white", { Metallic: pin("metalB") }),
        unbound("unbound"),
        WHITE,
        scalar("metalA", 0.2),
        scalar("metalB", 0.8),
      ];
      expect(await pixelOf(tintedRead("sw", METALLIC, nodes))).toEqual(tintTimes(0.2));
    });

    it("takes the OpacityMask of the default branch for the cut-out", async () => {
      const nodes = [
        switchOf("sw", "makeA", "makeB", "UseA"),
        make("makeA", "unbound", { OpacityMask: pin("maskA") }),
        make("makeB", "white", { OpacityMask: pin("maskB") }),
        unbound("unbound"),
        WHITE,
        textureSample("maskA", "T_Mask", "LinearColor"),
        textureSample("maskB", "T_Other", "LinearColor"),
      ];
      expect(await cutOutAlpha(cutOut("sw", "white", nodes))).toEqual(MASK_BYTES);
    });

    it("still probes BaseColor when BaseColor is what is read", async () => {
      const graph = makeGraph(
        [multiply("m", pin("tint"), pin("reader", 0, RGB_MASK)), constant3("tint", TINT), breakOf("reader", "sw"), switchOf("sw", "makeA", "makeB", "UseA"), make("makeA", "unbound"), make("makeB", "white"), unbound("unbound"), WHITE],
        pin("m"),
      );
      expect(await pixelOf(graph)).toEqual(tintTimes(1));
    });

    it("an explicit switch override still wins over the probe", async () => {
      const result = await bakeGraph({ graph: tintedRead("sw", ROUGHNESS, roughnessSwitch()), output: "baseColor", parameters: params({ switches: { usea: false } }), loadTexture: makeLoader({}).loadTexture, size: 2 });
      expect((await pixelsOf(result))(0, 0)).toEqual(tintTimes(0.8));
    });

    it("probes BaseColor for a Break nested in a Roughness read, and keeps the outer switch on Roughness", async () => {
      const nodes = [
        switchOf("sw", "makeA", "makeB", "UseA"),
        make("makeA", "unbound", { Roughness: pin("inner") }),
        make("makeB", "white", { Roughness: pin("roughB") }),
        breakOf("inner", "innerSwitch"),
        switchOf("innerSwitch", "innerA", "innerB", "UseInner"),
        make("innerA", "unbound"),
        make("innerB", "half"),
        constant3("half", [0.5, 0.5, 0.5]),
        unbound("unbound"),
        WHITE,
        scalar("roughB", 0.8),
      ];
      // The inner switch takes its grey B for BaseColor, so A's Roughness is 0.5; the outer switch keeps A.
      expect(await pixelOf(tintedRead("sw", ROUGHNESS, nodes))).toEqual(tintTimes(0.5));
    });

    it("shares one branch between the colour and the cut-out: BaseColor takes B, so the mask comes from B too", async () => {
      const nodes = [
        multiply("m", pin("tint"), pin("reader", 0, RGB_MASK)),
        constant3("tint", TINT),
        switchOf("sw", "makeA", "makeB", "UseA"),
        make("makeA", "unbound", { OpacityMask: pin("maskA") }),
        make("makeB", "white", { OpacityMask: pin("maskB") }),
        unbound("unbound"),
        WHITE,
        textureSample("maskA", "T_Mask", "LinearColor"),
        textureSample("maskB", "T_Other", "LinearColor"),
      ];
      const result = await bakeCutOut(cutOut("sw", "m", nodes));
      expect((await pixelsOf(result))(0, 0)).toEqual(tintTimes(1));
      expect(await alphaOf(result)).toEqual([255, 255, 255, 255]);
    });
  });

  describe("the switch choice is settled over the colour and the cut-out, not by the first read", () => {
    const unboundMask = (id: string): Raw =>
      node(id, "TextureSampleParameter2D", { parameter: { name: "Mask", group: "" }, default: null, texture: null, samplerType: "LinearColor" });
    const grey = (level: number) => [encode(level), encode(level), encode(level)];
    const splitGraph = (colour: string, mask: string, nodes: Raw[]): MaterialGraph =>
      materialGraphSchema.parse({
        format: 1,
        material: "M_Test",
        package: "/Game/Test/M_Test",
        truncated: false,
        nodeCount: nodes.length,
        outputs: { baseColor: pin(colour), roughness: null, metallic: null, emissive: null, opacity: null, opacityMask: pin(mask, OPACITY_MASK, [1, 0, 0, 0]), normal: null, materialAttributes: null },
        nodes,
      });

    // Roughness .2 on the default branch, .8 on B; the default branch's BaseColor samples a texture no instance binds.
    const roughnessSwitch = (): Raw[] => [
      switchOf("sw", "makeA", "makeB", "UseA"),
      make("makeA", "unbound", { Roughness: pin("roughA") }),
      make("makeB", "white", { Roughness: pin("roughB") }),
      unbound("unbound"),
      WHITE,
      scalar("roughA", 0.2),
      scalar("roughB", 0.8),
    ];

    it.each(["roughness", "colour"] as const)("takes one branch for Roughness x BaseColor whichever operand is read first (%s first)", async (first) => {
      const roughness = pin("reader", ROUGHNESS);
      const colour = pin("reader", 0, RGB_MASK);
      const product = first === "roughness" ? multiply("m", roughness, colour) : multiply("m", colour, roughness);
      expect(await pixelOf(makeGraph([product, breakOf("reader", "sw"), ...roughnessSwitch()], pin("m")))).toEqual(grey(0.8));
    });

    it("a switch the colour and the cut-out both read takes one branch on their union, so the cut-out's unbound mask moves the colour", async () => {
      // Alone the colour keeps A (its TINT is bound) and the cut-out flips to B (A's mask is unbound); the union flips to B.
      const nodes = [
        switchOf("sw", "makeA", "makeB", "UseA"),
        make("makeA", "tint", { OpacityMask: pin("maskA") }),
        make("makeB", "white", { OpacityMask: pin("maskB") }),
        constant3("tint", TINT),
        WHITE,
        unboundMask("maskA"),
        textureSample("maskB", "T_Other", "LinearColor"),
      ];
      const result = await bakeCutOut(cutOut("sw", "reader", nodes));
      expect((await pixelsOf(result))(0, 0)).toEqual(grey(1));
      expect(await alphaOf(result)).toEqual([255, 255, 255, 255]);
    });

    it("a nested switch in a branch the colour leaves keeps the choice of the reads that take it, not the trial's", async () => {
      // The outer switch's A has an unbound texture, so B is taken and A is left. A's BaseColor reaches the inner switch only in
      // a trial, whose BaseColor probe keeps the inner A. The cut-out reads the inner switch's mask: unbound on A, bound on B.
      const nodes = [
        breakOf("colourRead", "outer"),
        breakOf("maskRead", "inner"),
        switchOf("outer", "makeA", "makeB", "UseOuter"),
        make("makeA", "mixed"),
        multiply("mixed", pin("unbound"), pin("innerColour")),
        breakOf("innerColour", "inner"),
        make("makeB", "white"),
        switchOf("inner", "innerA", "innerB", "UseInner"),
        make("innerA", "white", { OpacityMask: pin("maskA") }),
        make("innerB", "white", { OpacityMask: pin("maskB") }),
        unbound("unbound"),
        WHITE,
        unboundMask("maskA"),
        textureSample("maskB", "T_Mask", "LinearColor"),
      ];
      const result = await bakeCutOut(splitGraph("colourRead", "maskRead", nodes));
      expect((await pixelsOf(result))(0, 0)).toEqual(grey(1));
      expect(await alphaOf(result)).toEqual(MASK_BYTES);
    });

    it("refuses a switch choice that never settles, rather than looping", async () => {
      // On A the outer switch reads the inner switch's BaseColor, unbound on the inner A, so B is taken; on B it reads the inner
      // Roughness instead, bound on both inner branches, so A is taken again. The two configurations alternate, and the bake says so.
      const nodes = [
        switchOf("outer", "makeA", "makeB", "UseOuter"),
        make("makeA", "innerBreak"),
        make("makeB", "innerRoughColour"),
        breakOf("innerBreak", "inner"),
        multiply("innerRoughColour", pin("innerBreak", ROUGHNESS), pin("white")),
        switchOf("inner", "innerA", "innerB", "UseInner"),
        make("innerA", "unbound", { Roughness: pin("roughA") }),
        make("innerB", "white", { Roughness: pin("roughB") }),
        scalar("roughA", 0.2),
        scalar("roughB", 0.8),
        unbound("unbound"),
        WHITE,
      ];
      expect(await bakeColour(makeGraph([breakOf("reader", "outer"), ...nodes], pin("reader")))).toMatchObject({
        status: "unavailable",
        reason: expect.stringContaining("do not settle"),
      });
      // The probe reports the same refusal: no classes and no textures, so a caller never reads a cycling path as one
      // that does not read VertexColor (which would drop a painted mesh's COLOR_0).
      const cycling = makeGraph([breakOf("reader", "outer"), ...nodes], pin("reader"));
      expect(graphPathClasses(cycling, "baseColor")).toBeUndefined();
      expect(graphPathTextures(cycling)).toBeUndefined();
    });
  });

  describe("a legacy SetMaterialAttributes reads its named overrides before it looks for an incoming pin", () => {
    // No attributeTypes and no pin named MaterialAttributes: the incoming attributes can only be found among the other pins.
    const legacySet = (inputs: Raw): Raw => node("set", "SetMaterialAttributes", { inputs });

    it("an unused unsupported Roughness or OpacityMask does not poison a BaseColor read", async () => {
      const graph = makeGraph([breakOf("reader", "set"), legacySet({ BaseColor: pin("white"), Roughness: pin("bad"), OpacityMask: pin("bad2") }), bad("bad"), bad("bad2"), WHITE], pin("reader", 0, RGB_MASK));
      expect(await pixelOf(graph)).toEqual([encode(1), encode(1), encode(1)]);
    });

    it("a mask-only read works with an unsupported BaseColor and Roughness override", async () => {
      const nodes = [legacySet({ BaseColor: pin("bad"), Roughness: pin("bad2"), OpacityMask: pin("maskA") }), bad("bad"), bad("bad2"), WHITE, textureSample("maskA", "T_Mask", "LinearColor")];
      expect(await cutOutAlpha(cutOut("set", "white", nodes))).toEqual(MASK_BYTES);
    });

    it("a consumed unsupported Roughness is still unsupported", async () => {
      const nodes = [legacySet({ BaseColor: pin("white"), Roughness: pin("bad") }), bad("bad"), WHITE];
      expect(await bakeColour(tintedRead("set", ROUGHNESS, nodes))).toMatchObject({ status: "unsupported", unsupported: ["ReflectionVectorWS"] });
    });

    it("an unnamed incoming attributes pin is still found, and its Roughness is read", async () => {
      const nodes = [legacySet({ Source: pin("make"), BaseColor: pin("white") }), make("make", "white", { Roughness: pin("rough") }), scalar("rough", 0.75), WHITE];
      expect(await pixelOf(tintedRead("set", ROUGHNESS, nodes))).toEqual(tintTimes(0.75));
    });

    it("does not visit an unused Normal or WorldPositionOffset override while it looks for an unnamed incoming pin", async () => {
      const graph = makeGraph([breakOf("reader", "set"), legacySet({ BaseColor: pin("white"), Normal: pin("bad"), WorldPositionOffset: pin("bad2") }), bad("bad"), bad("bad2"), WHITE], pin("reader", 0, RGB_MASK));
      expect(await pixelOf(graph)).toEqual([encode(1), encode(1), encode(1)]);
    });

    it("an unsupported unnamed source does not block a Roughness override that shadows it", async () => {
      const graph = makeGraph([multiply("m", pin("reader", ROUGHNESS), pin("white")), breakOf("reader", "set"), legacySet({ Source: pin("bad"), Roughness: pin("roughA") }), bad("bad"), scalar("roughA", 0.2), WHITE], pin("m"));
      expect(await pixelOf(graph)).toEqual([encode(0.2), encode(0.2), encode(0.2)]);
    });
  });

  describe("a typed SetMaterialAttributes compiles its incoming source only for a field nothing overrides", () => {
    const G = MATERIAL_ATTRIBUTE_GUIDS;
    // Inputs[0] is the incoming attributes and Inputs[i] carries attributeTypes[i - 1], as in the real dump.
    const typedSet = (inputs: Raw, attributeTypes: string[]): Raw => node("set", "SetMaterialAttributes", { inputs, attributeTypes });
    const roughnessTimesWhite = (set: Raw, nodes: Raw[]): MaterialGraph =>
      makeGraph([multiply("m", pin("reader", ROUGHNESS), pin("white")), breakOf("reader", "set"), set, WHITE, ...nodes], pin("m"));

    it("reads an overridden Roughness while the incoming source is unsupported", async () => {
      const set = typedSet({ "Inputs[0]": pin("bad"), "Inputs[1]": pin("roughA") }, [G.Roughness]);
      expect(await pixelOf(roughnessTimesWhite(set, [bad("bad"), scalar("roughA", 0.2)]))).toEqual([encode(0.2), encode(0.2), encode(0.2)]);
    });

    it("reads an overridden BaseColor and Roughness while the incoming source is unsupported", async () => {
      const set = typedSet({ "Inputs[0]": pin("bad"), "Inputs[1]": pin("white"), "Inputs[2]": pin("roughA") }, [G.BaseColor, G.Roughness]);
      const graph = makeGraph([multiply("m", pin("reader", ROUGHNESS), pin("reader", 0, RGB_MASK)), breakOf("reader", "set"), set, bad("bad"), WHITE, scalar("roughA", 0.2)], pin("m"));
      expect(await pixelOf(graph)).toEqual([encode(0.2), encode(0.2), encode(0.2)]);
    });

    it("still reports the unsupported incoming source when a field it supplies is read", async () => {
      const set = typedSet({ "Inputs[0]": pin("bad"), "Inputs[1]": pin("roughA") }, [G.Roughness]);
      const graph = makeGraph([multiply("m", pin("reader", METALLIC), pin("white")), breakOf("reader", "set"), set, bad("bad"), scalar("roughA", 0.2), WHITE], pin("m"));
      expect(await bakeColour(graph)).toMatchObject({ status: "unsupported", unsupported: ["BreakMaterialAttributes.Metallic", "ReflectionVectorWS"] });
    });
  });
});

describe("a pack-local function body wins over an engine-name handler", () => {
  const bake = (graph: MaterialGraph) => bakeGraph({ graph, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: makeLoader({}).loadTexture, size: 2 });
  const rgbOf = async (graph: MaterialGraph): Promise<number[]> => (await pixelsOf(await bake(graph)))(0, 0);
  const GREEN = constant3("green", [0, 1, 0]);
  const UNUSED = node("unused", "ReflectionVectorWS");
  const breakOf = (source: string): Raw => node("break", "BreakMaterialAttributes", { inputs: { MaterialAttributes: pin(source) }, outputNames: ["BaseColor"] });
  // A call named exactly like an engine layer function, but carrying a pack-local body: Make(BaseColor = green).
  const packed = (name: string): Raw =>
    node("layer", "FunctionCall", {
      function: `/Game/Test/${name}.${name}`,
      outputNames: ["Result"],
      fn: { inputs: {}, outputs: ["body", "unused"], output: "body", outputNames: ["", ""] },
    });
  const body = (inputs: Raw = {}) => node("body", "MakeMaterialAttributes", { inputs: { BaseColor: pin("green"), ...inputs } });

  it("uses the body's BaseColor for a call named MatLayerBlend_Standard, not the name-matched lerp", async () => {
    const graph = makeGraph([breakOf("layer"), packed("MatLayerBlend_Standard"), body(), GREEN, UNUSED], pin("break", 0, RGB_MASK));
    expect(await rgbOf(graph)).toEqual([0, 255, 0]);
  });

  it("uses the body's BaseColor for a call named MatLayerBlend_Tint", async () => {
    const graph = makeGraph([breakOf("layer"), packed("MatLayerBlend_Tint"), body(), GREEN, UNUSED], pin("break", 0, RGB_MASK));
    expect(await rgbOf(graph)).toEqual([0, 255, 0]);
  });

  it("does not compile a body output that was not requested", async () => {
    // outputs[1] points at an unsupported node; only output 0 is read, so the bake still succeeds.
    const graph = makeGraph([breakOf("layer"), packed("MatLayerBlend_Standard"), body(), GREEN, UNUSED], pin("break", 0, RGB_MASK));
    const result = await bake(graph);
    expect(result).toMatchObject({ status: "baked" });
    expect(result.status === "baked" && result.approximations).toEqual([]);
  });

  it("names the function rather than falling back to the name handler when the body lacks the requested output", async () => {
    // A body defines output 0 but not output 1: requesting output 1 must not silently run the engine-name handler.
    const call = node("layer", "FunctionCall", {
      function: "/Game/Test/MatLayerBlend_Standard.MatLayerBlend_Standard",
      outputNames: ["Result", "Other"],
      fn: { inputs: {}, outputs: ["body", null], output: "body", outputNames: ["", ""] },
    });
    const graph = makeGraph([call, body(), GREEN], pin("layer", 1, RGB_MASK));
    expect(await bake(graph)).toMatchObject({ status: "unsupported", unsupported: ["MatLayerBlend_Standard"] });
  });
});

describe("OpacityMask", () => {
  const G = MATERIAL_ATTRIBUTE_GUIDS;
  const MASK = 6;
  const BREAK_MASK = ["BaseColor", "Metallic", "Specular", "Roughness", "EmissiveColor", "Opacity", "OpacityMask", "Normal"];
  const TINT: Rgb = [0.8, 0.6, 0.4];
  const WHITE = constant3("white", [1, 1, 1]);
  const scalar = (id: string, value: number): Raw => node(id, "Constant", { constants: { R: value } });
  const make = (id: string, pins: Raw = {}): Raw => node(id, "MakeMaterialAttributes", { inputs: { BaseColor: pin("white"), ...pins } });
  const reader = (source: string): Raw => node("reader", "BreakMaterialAttributes", { inputs: { MaterialAttributes: pin(source) }, outputNames: BREAK_MASK });
  const graphWith = (nodes: Raw[], outputs: Raw): MaterialGraph =>
    materialGraphSchema.parse({
      format: 1,
      material: "M_Test",
      package: "/Game/Test/M_Test",
      truncated: false,
      nodeCount: nodes.length,
      outputs: { baseColor: null, roughness: null, metallic: null, emissive: null, opacity: null, opacityMask: null, normal: null, materialAttributes: null, ...outputs },
      nodes,
    });
  // BaseColor = TINT x Break(<reader>).OpacityMask, so a mask factor shows up in the baked RGB.
  const readScalar = (nodes: Raw[]): MaterialGraph => makeGraph([multiply("m", pin("tint"), pin("reader", MASK)), constant3("tint", TINT), WHITE, ...nodes], pin("m"));
  const scalarBytes = async (graph: MaterialGraph): Promise<number[]> => {
    const result = await bakeGraph({ graph, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: makeLoader({}).loadTexture, size: 2 });
    return (await pixelsOf(result))(0, 0);
  };
  const scaled = (factor: number) => TINT.map((channel) => encode(channel * factor));
  const MASK_BYTES = [64, 128, 191, 255];
  const maskTextures = async (): Promise<Record<string, Fixture>> => ({ T_Mask: { png: await pngOf(2, 2, (x, y) => [MASK_BYTES[y * 2 + x]!, 0, 0]), srgb: false } });
  const bakeMask = (graph: MaterialGraph, textures: Record<string, Fixture>) =>
    bakeGraph({ graph, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: makeLoader(textures).loadTexture, size: 2, alpha: "opacityMask" });
  const alphaBytes = async (result: BakeResult): Promise<number[]> => {
    if (result.status !== "baked") throw new Error(`expected baked, got ${result.status}`);
    const { data, info } = await sharp(result.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => data[(y * info.width + x) * 4 + 3]!;
    return [at(0, 0), at(1, 0), at(0, 1), at(1, 1)];
  };

  it("bakes a nontrivial OpacityMask from a nested Make into the alpha channel", async () => {
    const graph = graphWith(
      [
        node("brk", "BreakMaterialAttributes", { inputs: { MaterialAttributes: pin("make") }, outputNames: BREAK_MASK }),
        make("make", { OpacityMask: pin("tex") }),
        textureSample("tex", "T_Mask", "LinearColor"),
        WHITE,
      ],
      { baseColor: pin("white"), opacityMask: pin("brk", MASK, [1, 0, 0, 0]) },
    );
    const result = await bakeMask(graph, await maskTextures());
    expect(result.status).toBe("baked");
    expect(await alphaBytes(result)).toEqual(MASK_BYTES);
  });

  it("takes Unreal's default for an unwired OpacityMask: 1", async () => {
    expect(await scalarBytes(readScalar([reader("make"), make("make")]))).toEqual(scaled(1));
  });

  it("does not poison the alpha bake with an unsupported unused BaseColor or Metallic", async () => {
    const graph = graphWith(
      [
        node("brk", "BreakMaterialAttributes", { inputs: { MaterialAttributes: pin("make") }, outputNames: BREAK_MASK }),
        node("make", "MakeMaterialAttributes", { inputs: { BaseColor: pin("bad"), Metallic: pin("bad2"), OpacityMask: pin("tex") } }),
        textureSample("tex", "T_Mask", "LinearColor"),
        node("bad", "ReflectionVectorWS"),
        node("bad2", "ReflectionVectorWS"),
        WHITE,
      ],
      { baseColor: pin("white"), opacityMask: pin("brk", MASK, [1, 0, 0, 0]) },
    );
    const result = await bakeMask(graph, await maskTextures());
    expect(result.status).toBe("baked");
    expect(await alphaBytes(result)).toEqual(MASK_BYTES);
  });

  it("reads OpacityMask through a Set override typed with its GUID", async () => {
    const set = node("set", "SetMaterialAttributes", { inputs: { "Inputs[0]": pin("make"), "Inputs[1]": pin("tex") }, attributeTypes: [G.OpacityMask] });
    const graph = graphWith(
      [
        node("brk", "BreakMaterialAttributes", { inputs: { MaterialAttributes: pin("set") }, outputNames: BREAK_MASK }),
        set,
        make("make"),
        textureSample("tex", "T_Mask", "LinearColor"),
        WHITE,
      ],
      { baseColor: pin("white"), opacityMask: pin("brk", MASK, [1, 0, 0, 0]) },
    );
    const result = await bakeMask(graph, await maskTextures());
    expect(result.status).toBe("baked");
    expect(await alphaBytes(result)).toEqual(MASK_BYTES);
  });

  it("reads OpacityMask through a GetMaterialAttributes output typed with its GUID", async () => {
    const get = node("get", "GetMaterialAttributes", { inputs: { MaterialAttributes: pin("make") }, outputNames: ["MaterialAttributes", "OpacityMask"], attributeTypes: [G.OpacityMask] });
    const graph = graphWith(
      [get, make("make", { OpacityMask: pin("tex") }), textureSample("tex", "T_Mask", "LinearColor"), WHITE],
      { baseColor: pin("white"), opacityMask: pin("get", 1, [1, 0, 0, 0]) },
    );
    const result = await bakeMask(graph, await maskTextures());
    expect(result.status).toBe("baked");
    expect(await alphaBytes(result)).toEqual(MASK_BYTES);
  });

  it("blends OpacityMask by Alpha in BlendMaterialAttributes", async () => {
    const blend = node("blend", "BlendMaterialAttributes", { inputs: { A: pin("ma"), B: pin("mb"), Alpha: pin("alpha") } });
    const nodes = [reader("blend"), blend, make("ma", { OpacityMask: pin("m0") }), make("mb", { OpacityMask: pin("m1") }), scalar("m0", 0.2), scalar("m1", 0.8), scalar("alpha", 0.25)];
    // 0.2 + (0.8 - 0.2) x 0.25
    expect(await scalarBytes(readScalar(nodes))).toEqual(scaled(0.35));
  });

  it("preserves OpacityMask through a known BaseColor-only writer", async () => {
    const layer = engineCall("layer", "MatLayerBlend_OverrideBaseColor", { Input0: pin("make"), Input1: pin("red") });
    const nodes = [reader("layer"), layer, make("make", { OpacityMask: pin("mask") }), scalar("mask", 0.3), constant3("red", [1, 0, 0])];
    expect(await scalarBytes(readScalar(nodes))).toEqual(scaled(0.3));
  });

  it("models the mask a MatLayerBlend_Standard can change as an attribute blend", async () => {
    const layer = engineCall("layer", "MatLayerBlend_Standard", { Input0: pin("ma"), Input1: pin("mb"), Input2: pin("alpha") });
    const nodes = [reader("layer"), layer, make("ma", { OpacityMask: pin("m0") }), make("mb", { OpacityMask: pin("m1") }), scalar("m0", 0.2), scalar("m1", 0.8), scalar("alpha", 0.25)];
    expect(await scalarBytes(readScalar(nodes))).toEqual(scaled(0.35));
  });

  it("reads OpacityMask written by a pack-local function body, not the name handler's incoming mask", async () => {
    const call = node("layer", "FunctionCall", {
      inputs: { Input0: pin("incoming") },
      function: "/Game/Test/MatLayerBlend_Tint.MatLayerBlend_Tint",
      outputNames: ["Result"],
      fn: { inputs: { Input0: "incoming" }, outputs: ["body"], output: "body", outputNames: [""] },
    });
    const nodes = [reader("layer"), call, make("body", { OpacityMask: pin("bodyMask") }), make("incoming", { OpacityMask: pin("incomingMask") }), scalar("bodyMask", 0.3), scalar("incomingMask", 0.9)];
    expect(await scalarBytes(readScalar(nodes))).toEqual(scaled(0.3));
  });
});

describe("UV-producing nodes: CustomRotator, UVEdit, UV arithmetic, ConvertFromDiffSpec", () => {
  // Asymmetric 4x4 texture: every texel distinct, so a transposed, mirrored or wrongly rotated bake cannot match.
  const texel = (x: number, y: number): Rgb => [40 * x + 10, 60 * y + 5, 77];
  const ROTATOR_NOTE = "CustomRotator: engine body unavailable; UVs rotated about the centre by the angle as a fraction of a turn (Rotator matrix)";
  const UVEDIT_NOTE =
    "UVEdit: engine body unavailable; UV scaled about the tiling pivot, mirrored per axis, rotated (W_Rotation as a fraction of a turn) about the rotation pivot, then offset";

  const bake = async (graph: MaterialGraph, textures: Record<string, Fixture>, size = 4) =>
    bakeGraph({ graph, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: makeLoader(textures).loadTexture, size });
  const orient = async (): Promise<Record<string, Fixture>> => ({ T_Orient: { png: await pngOf(4, 4, texel), srgb: true } });
  const expectMapping = async (result: BakeResult, source: (x: number, y: number) => [number, number], size = 4) => {
    const pixel = await pixelsOf(result);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) expect(pixel(x, y), `pixel ${x},${y}`).toEqual([...texel(...source(x, y))]);
  };
  const constant2 = (id: string, r: number, g: number): Raw => node(id, "Constant2Vector", { constants: { R: r, G: g } });
  const scalar = (id: string, r: number): Raw => node(id, "Constant", { constants: { R: r } });
  /** The PSR function's angle: degrees / -360, as dumped from the Playground Apocalypse master. */
  const degreesAngle = (id: string, degrees: number): Raw[] => [
    node(id, "Divide", { inputs: { A: pin(`${id}/deg`) }, constants: { ConstB: -360 } }),
    scalar(`${id}/deg`, degrees),
  ];
  const rotatorGraph = (inputs: Raw, extra: Raw[] = []) =>
    makeGraph([textureSample("t", "T_Orient", "Color", "rot"), engineCall("rot", "CustomRotator", inputs), textureCoordinate("uv"), ...extra], pin("t", 0, RGB_MASK));

  it("CustomRotator turns the UVs a quarter about the default centre: output(x, y) = texture(3 - y, x)", async () => {
    // angle = -90 / -360 = 0.25 turn; d = uv - 0.5; uv' = (cos*dx - sin*dy, sin*dx + cos*dy) + 0.5 = (0.5 - dy, 0.5 + dx).
    // Output pixel (x, y) has dx = (x - 1.5) / 4, dy = (y - 1.5) / 4, so u' texel = 3 - y and v' texel = x, on texel centres.
    const graph = rotatorGraph({ Input0: pin("uv"), Input1: null, Input2: pin("angle") }, degreesAngle("angle", -90));
    const result = await bake(graph, await orient());
    await expectMapping(result, (x, y) => [3 - y, x]);
    if (result.status === "baked") expect(result).toMatchObject({ confidence: "heuristic", approximations: [ROTATOR_NOTE] });
  });

  it("CustomRotator half turn is a point reflection, and a wired centre moves the pivot", async () => {
    const half = await bake(rotatorGraph({ Input0: pin("uv"), Input2: pin("half") }, [scalar("half", 0.5)]), await orient());
    await expectMapping(half, (x, y) => [3 - x, 3 - y]);
    // Centre (0.25, 0.25): uv' = (0.25 - (v - 0.25), 0.25 + (u - 0.25)) = (0.5 - v, u): u' texel = (1 - y) mod 4, v' texel = x.
    const moved = await bake(rotatorGraph({ Input0: pin("uv"), Input1: pin("centre", 0, [1, 1, 0, 0]), Input2: pin("quarter") }, [constant2("centre", 0.25, 0.25), scalar("quarter", 0.25)]), await orient());
    await expectMapping(moved, (x, y) => [(1 - y + 4) % 4, x]);
  });

  it("CustomRotator with a zero or unwired angle is an exact identity, as in the Playground Rotation = 0 default", async () => {
    // Playground shape: Add(Divide(CustomRotator(TexCoord, null, 0 / -360), Append(1, 1)), Append(0, 0)).
    const nodes: Raw[] = [
      textureSample("t", "T_Orient", "Color", "sum"),
      node("sum", "Add", { inputs: { A: pin("div"), B: pin("offset") } }),
      node("div", "Divide", { inputs: { A: pin("rot"), B: pin("tiling") } }),
      engineCall("rot", "CustomRotator", { Input0: pin("uv"), Input1: null, Input2: pin("angle") }),
      textureCoordinate("uv"),
      ...degreesAngle("angle", 0),
      node("tiling", "AppendVector", { inputs: { A: pin("one"), B: pin("one") } }),
      node("offset", "AppendVector", { inputs: { A: pin("zero"), B: pin("zero") } }),
      scalar("one", 1),
      scalar("zero", 0),
    ];
    const result = await bake(makeGraph(nodes, pin("t", 0, RGB_MASK)), await orient());
    await expectMapping(result, (x, y) => [x, y]);
    if (result.status === "baked") expect(result).toMatchObject({ confidence: "exact", approximations: [] });
    const unwired = await bake(rotatorGraph({ Input0: pin("uv") }), await orient());
    await expectMapping(unwired, (x, y) => [x, y]);
    expect(supportedEngineFunctions()).toEqual(expect.arrayContaining(["CustomRotator", "UVEdit", "ConvertFromDiffSpec"]));
  });

  it("CustomRotator without UVs reads UV0", async () => {
    const result = await bake(rotatorGraph({ Input2: pin("half") }, [scalar("half", 0.5)]), await orient());
    await expectMapping(result, (x, y) => [3 - x, 3 - y]);
  });

  const uvEditGraph = (inputs: Raw, extra: Raw[], extraName = "UVEdit") =>
    makeGraph([textureSample("t", "T_Orient", "Color", "edit"), engineCall("edit", extraName, { Input0: pin("uv"), ...inputs }), textureCoordinate("uv"), ...extra], pin("t", 0, RGB_MASK));

  it("UVEdit offset adds to the UV: texture((x + 1) mod 4, (y + 2) mod 4) for offset (0.25, 0.5)", async () => {
    const result = await bake(uvEditGraph({ Input7: pin("offset", 0, [1, 1, 0, 0]) }, [constant2("offset", 0.25, 0.5)]), await orient());
    await expectMapping(result, (x, y) => [(x + 1) % 4, (y + 2) % 4]);
    if (result.status === "baked") expect(result).toMatchObject({ confidence: "heuristic", approximations: [UVEDIT_NOTE] });
  });

  it("UVEdit tiling scales about the tiling pivot", async () => {
    // 2x2 stripes (column 0 black, column 1 white), output 4 wide, tiling (2, 1): uv_x = 2u - pivot. Pivot 0 reads texel x mod 2
    // (0, 255, 0, 255); pivot 0.5 shifts by one texel: pos = x - 1 -> (255, 0, 255, 0).
    const stripes = { T_Orient: { png: await pngOf(2, 2, (x) => (x === 0 ? [0, 0, 0] : [255, 255, 255])), srgb: true } };
    const row = async (pivot: number) => {
      const result = await bake(uvEditGraph({ Input1: pin("pivot", 0, [1, 1, 0, 0]), Input2: pin("tiling", 0, [1, 1, 0, 0]) }, [constant2("pivot", pivot, 0), constant2("tiling", 2, 1)]), stripes);
      const pixel = await pixelsOf(result);
      return [0, 1, 2, 3].map((x) => pixel(x, 0)[0]);
    };
    expect(await row(0)).toEqual([0, 255, 0, 255]);
    expect(await row(0.5)).toEqual([255, 0, 255, 0]);
  });

  it("UVEdit mirrors a flagged axis (period-2 fold) and leaves the other alone", async () => {
    // Texture varies along x only. Output 8 wide, tiling (2, 1): uv_x = (x + 0.5) / 4 -> texel x for x < 4, then folds: 7 - x.
    const columns = { T_Orient: { png: await pngOf(4, 4, (x) => [40 * x + 10, 100, 77]), srgb: true } };
    const run = async (mirror: boolean) => {
      const graph = uvEditGraph({ Input2: pin("tiling", 0, [1, 1, 0, 0]), Input3: pin("mirror") }, [constant2("tiling", 2, 1), node("mirror", "StaticBool", { constants: { Value: mirror } })]);
      const pixel = await pixelsOf(await bake(graph, columns, 8));
      return [0, 1, 2, 3, 4, 5, 6, 7].map((x) => pixel(x, 3)[0]);
    };
    const red = (x: number) => 40 * x + 10;
    expect(await run(true)).toEqual([0, 1, 2, 3, 3, 2, 1, 0].map(red));
    expect(await run(false)).toEqual([0, 1, 2, 3, 0, 1, 2, 3].map(red));
  });

  it("UVEdit rotates about its pivot before adding the offset", async () => {
    // W_Rotation 0.25 about (0.5, 0.5) is texture(3 - y, x); the offset (0.25, 0) then shifts u' by one texel: (4 - y) mod 4.
    // Offset-then-rotate would land between texel centres and could not match these exact bytes.
    const graph = uvEditGraph(
      { Input5: pin("pivot", 0, [1, 1, 0, 0]), Input6: pin("turn"), Input7: pin("offset", 0, [1, 1, 0, 0]) },
      [constant2("pivot", 0.5, 0.5), scalar("turn", 0.25), constant2("offset", 0.25, 0)],
    );
    await expectMapping(await bake(graph, await orient()), (x, y) => [(4 - y) % 4, x]);
  });

  it("UVEdit evaluates the pack's own body when it carries one, with no approximation", async () => {
    // Datasmith projects ship UVEdit; an inlined body (here: UV + (0.25, 0)) wins over the name-matched approximation.
    const call = node("edit", "FunctionCall", {
      inputs: { Input0: pin("uv") },
      function: "/DatasmithContent/Materials/UVEdit.UVEdit",
      outputNames: ["Result"],
      fn: { inputs: { Input0: "uv" }, outputs: ["edit/add"], output: "edit/add", outputNames: [""] },
    });
    const graph = makeGraph([textureSample("t", "T_Orient", "Color", "edit"), call, textureCoordinate("uv"), node("edit/add", "Add", { inputs: { A: pin("uv"), B: pin("edit/off") } }), constant2("edit/off", 0.25, 0)], pin("t", 0, RGB_MASK));
    const result = await bake(graph, await orient());
    await expectMapping(result, (x, y) => [(x + 1) % 4, y]);
    if (result.status === "baked") expect(result).toMatchObject({ confidence: "exact", approximations: [] });
  });

  it("composes general UV values: Append(TexCoord.r, 1 - TexCoord.g) flips V", async () => {
    const graph = makeGraph(
      [
        textureSample("t", "T_Orient", "Color", "flip"),
        node("flip", "AppendVector", { inputs: { A: pin("uv", 0, [1, 0, 0, 0]), B: pin("inv") } }),
        node("inv", "OneMinus", { inputs: { Input: pin("uv", 0, [0, 1, 0, 0]) } }),
        textureCoordinate("uv"),
      ],
      pin("t", 0, RGB_MASK),
    );
    const result = await bake(graph, await orient());
    await expectMapping(result, (x, y) => [x, 3 - y]);
    if (result.status === "baked") expect(result.confidence).toBe("exact");
  });

  it("keeps the mip level through Multiply by a constant UV scale", async () => {
    // A 4x4 texture with one white texel baked to 1x1 through TexCoord * (2, 2). The scale reaches the sample, so it reads
    // the 1x1 mip (linear 1/16). Without it level 0 is sampled at uv (1, 1): a quarter of the white texel (0.25).
    const dot = { T_Dot: { png: await pngOf(4, 4, (x, y) => (x === 0 && y === 0 ? [255, 255, 255] : [0, 0, 0])), srgb: true } };
    const graph = makeGraph(
      [textureSample("t", "T_Dot", "Color", "scaled"), node("scaled", "Multiply", { inputs: { A: pin("uv"), B: pin("two") } }), textureCoordinate("uv"), constant2("two", 2, 2)],
      pin("t", 0, RGB_MASK),
    );
    expect((await pixelsOf(await bake(graph, dot, 1)))(0, 0)).toEqual([encode(1 / 16), encode(1 / 16), encode(1 / 16)]);
  });

  describe("ConvertFromDiffSpec", () => {
    const convert = (output: number) =>
      makeGraph(
        [
          { ...engineCall("conv", "ConvertFromDiffSpec", { Input0: pin("diffuse", 0, RGB_MASK), Input1: pin("spec") }), outputNames: ["BaseColor", "Metallic", "Specular"] },
          constant3("diffuse", [0.25, 0.5, 0.75]),
          scalar("spec", 0.04),
        ],
        pin("conv", output, output === 0 ? null : RGB_MASK),
      );

    it("takes BaseColor from the diffuse input and says so", async () => {
      const result = await bake(convert(0), {}, 2);
      expect((await pixelsOf(result))(1, 1)).toEqual([encode(0.25), encode(0.5), encode(0.75)]);
      if (result.status === "baked") expect(result).toMatchObject({ confidence: "heuristic", approximations: ["ConvertFromDiffSpec: BaseColor taken from the diffuse input; engine body unavailable"] });
    });

    it("does not guess its Metallic output", async () => {
      expect(await bake(convert(1), {}, 2)).toMatchObject({ status: "unsupported", unsupported: ["ConvertFromDiffSpec.Metallic"] });
    });
  });
});

describe("standard math nodes and engine utility functions seen on real BaseColor paths", () => {
  const bake = (graph: MaterialGraph) =>
    bakeGraph({ graph, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: makeLoader({}).loadTexture, size: 2 });
  const rgbOf = async (nodes: Raw[], root: string) => (await pixelsOf(await bake(makeGraph(nodes, pin(root, 0, RGB_MASK)))))(0, 0);
  const scalar = (id: string, value: number): Raw => node(id, "Constant", { constants: { R: value } });
  /** Linear 0.25 / 0.5 / 0.75 encodes to different bytes, so a swapped channel fails. */
  const unary = (cls: string, input: string, pinName = "Input"): Raw[] => [node("u", cls, { inputs: { [pinName]: pin("c", 0, RGB_MASK) } }), constant3("c", [input === "neg" ? -0.25 : 0.25, 0.5, 0.75])];
  const exact = async (nodes: Raw[], root = "u") => {
    const result = await bake(makeGraph(nodes, pin(root, 0, RGB_MASK)));
    if (result.status !== "baked") throw new Error(`expected baked, got ${result.status}`);
    expect(result).toMatchObject({ confidence: "exact", approximations: [] });
    return (await pixelsOf(result))(0, 0);
  };

  it("PathTracingQualitySwitch takes Normal and never visits the path-traced branch", async () => {
    const nodes = [
      node("q", "PathTracingQualitySwitch", { inputs: { Normal: pin("hi", 0, RGB_MASK), PathTraced: pin("bad") } }),
      constant3("hi", [0.25, 0.5, 0.75]),
      node("bad", "ReflectionVectorWS"),
    ];
    expect(await exact(nodes, "q")).toEqual([encode(0.25), encode(0.5), encode(0.75)]);
    expect(await bake(makeGraph([node("q", "PathTracingQualitySwitch")], pin("q", 0, RGB_MASK)))).toMatchObject({ status: "unavailable" });
  });

  it("ShadingPathSwitch takes Default, else the deferred slot Inputs[0]", async () => {
    const withDefault = [
      node("s", "ShadingPathSwitch", { inputs: { Default: pin("hi", 0, RGB_MASK), "Inputs[0]": pin("lo", 0, RGB_MASK), "Inputs[2]": pin("bad") } }),
      constant3("hi", [0.25, 0.5, 0.75]), constant3("lo", [1, 0, 0]), node("bad", "ReflectionVectorWS"),
    ];
    expect(await exact(withDefault, "s")).toEqual([encode(0.25), encode(0.5), encode(0.75)]);
    const slotOnly = [node("s", "ShadingPathSwitch", { inputs: { "Inputs[0]": pin("lo", 0, RGB_MASK), "Inputs[2]": pin("bad") } }), constant3("lo", [1, 0, 0]), node("bad", "ReflectionVectorWS")];
    expect(await exact(slotOnly, "s")).toEqual([255, 0, 0]);
    expect(await bake(makeGraph([node("s", "ShadingPathSwitch")], pin("s", 0, RGB_MASK)))).toMatchObject({ status: "unavailable" });
  });

  it("Abs and Frac work per component", async () => {
    expect(await exact(unary("Abs", "neg"))).toEqual([encode(0.25), encode(0.5), encode(0.75)]);
    expect(await exact([node("u", "Frac", { inputs: { Input: pin("s") } }), scalar("s", 2.75)])).toEqual([encode(0.75), encode(0.75), encode(0.75)]);
    // Frac of a negative is x - floor(x), not the C remainder.
    expect(await exact([node("u", "Frac", { inputs: { Input: pin("s") } }), scalar("s", -0.25)])).toEqual([encode(0.75), encode(0.75), encode(0.75)]);
  });

  it("Min and Max take operands from pins or ConstA/ConstB", async () => {
    const pair = (cls: string) => [node("u", cls, { inputs: { A: pin("a", 0, RGB_MASK), B: pin("b", 0, RGB_MASK) } }), constant3("a", [0.25, 0.5, 0.75]), constant3("b", [0.5, 0.5, 0.5])];
    expect(await exact(pair("Max"))).toEqual([encode(0.5), encode(0.5), encode(0.75)]);
    expect(await exact(pair("Min"))).toEqual([encode(0.25), encode(0.5), encode(0.5)]);
    expect(await exact([node("u", "Max", { inputs: { A: pin("a", 0, RGB_MASK) }, constants: { ConstB: 0.6 } }), constant3("a", [0.25, 0.5, 0.75])])).toEqual([encode(0.6), encode(0.6), encode(0.75)]);
  });

  it("DotProduct sums the component products and Normalize divides by the length", async () => {
    const dot = [node("u", "DotProduct", { inputs: { A: pin("a", 0, RGB_MASK), B: pin("b", 0, RGB_MASK) } }), constant3("a", [0.5, 0.25, 0.5]), constant3("b", [0.5, 1, 0.5])];
    expect(await exact(dot)).toEqual([encode(0.75), encode(0.75), encode(0.75)]);
    // (0, 0.6, 0.8) has length 1; (0, 3, 4) / 5 is the same direction.
    const normalised = [node("u", "Normalize", { inputs: { VectorInput: pin("c", 0, RGB_MASK) } }), constant3("c", [0, 3, 4])];
    expect(await exact(normalised)).toEqual([0, encode(0.6), encode(0.8)]);
  });

  it("ConstantBiasScale is (Input + Bias) * Scale with Unreal's defaults of 1 and 0.5", async () => {
    expect(await exact(unary("ConstantBiasScale", "pos"))).toEqual([encode(0.625), encode(0.75), encode(0.875)]);
    const custom = [node("u", "ConstantBiasScale", { inputs: { Input: pin("c", 0, RGB_MASK) }, constants: { Bias: -0.25, Scale: 2 } }), constant3("c", [0.5, 0.75, 1])];
    expect(await exact(custom)).toEqual([encode(0.5), encode(1), encode(1)]);
  });

  it("SphereMask is a heuristic: saturate((1 - distance / Radius) / (1 - Hardness)) with a named approximation", async () => {
    const mask = (hardness: number) => [
      node("m", "SphereMask", { inputs: { A: pin("a", 0, RGB_MASK), B: pin("b", 0, RGB_MASK), Radius: pin("r"), Hardness: pin("h") } }),
      constant3("a", [0.5, 0, 0]), constant3("b", [0, 0, 0]), scalar("r", 1), scalar("h", hardness),
    ];
    const soft = await bake(makeGraph(mask(0), pin("m")));
    expect((await pixelsOf(soft))(0, 0)).toEqual([encode(0.5), encode(0.5), encode(0.5)]);
    if (soft.status === "baked") expect(soft).toMatchObject({ confidence: "heuristic", approximations: [expect.stringContaining("SphereMask")] });
    const firm = await bake(makeGraph(mask(0.5), pin("m")));
    expect((await pixelsOf(firm))(0, 0)).toEqual([255, 255, 255]);
    // Outside the radius it is zero.
    const outside = [
      node("m", "SphereMask", { inputs: { A: pin("a", 0, RGB_MASK), B: pin("b", 0, RGB_MASK) }, constants: { AttenuationRadius: 0.25, HardnessPercent: 0 } }),
      constant3("a", [0.5, 0, 0]), constant3("b", [0, 0, 0]),
    ];
    expect((await pixelsOf(await bake(makeGraph(outside, pin("m")))))(0, 0)).toEqual([0, 0, 0]);
  });

  it("MakeFloat2/3 and BreakOutFloat2/3Components work by position when the engine body is absent", async () => {
    const make = [engineCall("u", "MakeFloat3", { Input0: pin("x"), Input1: pin("y"), Input2: pin("z") }), scalar("x", 0.25), scalar("y", 0.5), scalar("z", 0.75)];
    expect(await exact(make)).toEqual([encode(0.25), encode(0.5), encode(0.75)]);
    // An unwired component is zero, like an unwired function input.
    expect(await exact([engineCall("u", "MakeFloat3", { Input0: pin("x"), Input1: null, Input2: pin("z") }), scalar("x", 0.25), scalar("z", 0.75)])).toEqual([encode(0.25), 0, encode(0.75)]);
    for (const [name, output, expected] of [["BreakOutFloat3Components", 0, 0.25], ["BreakOutFloat3Components", 1, 0.5], ["BreakOutFloat3Components", 2, 0.75], ["BreakOutFloat2Components", 1, 0.5]] as const) {
      const graph = makeGraph([engineCall("u", name, { Input0: pin("c", 0, RGB_MASK) }), constant3("c", [0.25, 0.5, 0.75])], pin("u", output));
      const result = await bake(graph);
      expect((await pixelsOf(result))(0, 0), `${name}.${output}`).toEqual([encode(expected), encode(expected), encode(expected)]);
      if (result.status === "baked") expect(result).toMatchObject({ confidence: "exact", approximations: [] });
    }
    const joined = [
      engineCall("u", "MakeFloat3", { Input0: pin("b", 2), Input1: pin("b", 1), Input2: pin("b", 0) }),
      engineCall("b", "BreakOutFloat3Components", { Input0: pin("c", 0, RGB_MASK) }),
      constant3("c", [0.25, 0.5, 0.75]),
    ];
    expect(await exact(joined)).toEqual([encode(0.75), encode(0.5), encode(0.25)]);
  });

  it("CheapContrast_RGB matches CheapContrast", async () => {
    const result = await bake(
      makeGraph([engineCall("c", "CheapContrast_RGB", { Input0: pin("in", 0, RGB_MASK), Input1: pin("amount") }), constant3("in", [0.3, 0.5, 0.9]), scalar("amount", 0.2)], pin("c", 0, RGB_MASK)),
    );
    expect((await pixelsOf(result))(0, 0)).toEqual([encode(0.22), encode(0.5), 255]);
    if (result.status === "baked") expect(result.confidence).toBe("exact");
  });

  it("registers the new node classes and engine function names", () => {
    expect(supportedNodeClasses()).toEqual(
      expect.arrayContaining(["PathTracingQualitySwitch", "ShadingPathSwitch", "Abs", "Frac", "Min", "Max", "DotProduct", "Normalize", "ConstantBiasScale", "SphereMask"]),
    );
    expect(supportedEngineFunctions()).toEqual(expect.arrayContaining(["MakeFloat2", "MakeFloat3", "BreakOutFloat2Components", "BreakOutFloat3Components", "CheapContrast_RGB"]));
  });

  it("scene and view dependent nodes stay unsupported", async () => {
    for (const cls of ["SceneColor", "SceneTexture", "ViewProperty", "CameraVectorWS", "ReflectionVectorWS"]) {
      expect(await bake(makeGraph([node("u", cls)], pin("u", 0, RGB_MASK))), cls).toMatchObject({ status: "unsupported", unsupported: [cls] });
    }
  });
});

describe("per-instance and engine utility nodes of layered cliff materials", () => {
  const bake = (graph: MaterialGraph, textures: Record<string, Fixture> = {}) =>
    bakeGraph({ graph, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: makeLoader(textures).loadTexture, size: 4 });
  /** An engine function with several outputs and no body, like the real ObjectScale and SplitComponents. */
  const engineOutputs = (id: string, name: string, path: string, outputNames: string[], inputs: Raw = {}): Raw =>
    node(id, "FunctionCall", {
      inputs,
      function: `/Engine/Functions/${path}/${name}.${name}`,
      outputNames,
      fn: { inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, value && (value as { node: string }).node])), outputs: [], output: null },
      error: "material function could not be loaded (engine content is not in the pack)",
    });
  const OBJECT_SCALE = ["Scale XYZ", "Scale X", "Scale Y", "Scale Z"];
  const SPLIT = ["RGB", "R", "G", "B"];

  it("SplitComponents hands each channel of its input through exactly", async () => {
    for (const [output, expected] of [[1, 0.2], [2, 0.4], [3, 0.6]] as const) {
      const result = await bake(
        makeGraph([engineOutputs("split", "SplitComponents", "Engine_MaterialFunctions02", SPLIT, { Input0: pin("c", 0, RGB_MASK) }), constant3("c", [0.2, 0.4, 0.6])], pin("split", output)),
      );
      expect((await pixelsOf(result))(0, 0)).toEqual([encode(expected), encode(expected), encode(expected)]);
      if (result.status === "baked") expect(result.confidence).toBe("exact");
    }
    const whole = await bake(makeGraph([engineOutputs("split", "SplitComponents", "Engine_MaterialFunctions02", SPLIT, { Input0: pin("c", 0, RGB_MASK) }), constant3("c", [0.2, 0.4, 0.6])], pin("split", 0, RGB_MASK)));
    expect((await pixelsOf(whole))(0, 0)).toEqual([encode(0.2), encode(0.4), encode(0.6)]);
  });

  it("ObjectScale is one for an unscaled instance, so world-scaled UVs keep their tiling, and says so", async () => {
    // UV x (ObjectScale X x 2): scale 1 tiles the 2-texel stripes twice across 4 pixels. A scale that fell to 0 would read texel 0 everywhere.
    const stripes = await pngOf(2, 2, (x) => (x === 0 ? [0, 0, 0] : [255, 255, 255]));
    const graph = makeGraph(
      [
        textureSample("t", "T_Stripes", "Color", "scaled"),
        multiply("scaled", pin("uv"), pin("scale")),
        textureCoordinate("uv"),
        multiply("scale", pin("objectScale", 1), pin("two")),
        node("two", "Constant", { constants: { R: 2 } }),
        engineOutputs("objectScale", "ObjectScale", "Engine_MaterialFunctions02/WorldPositionOffset", OBJECT_SCALE),
      ],
      pin("t", 0, RGB_MASK),
    );
    const result = await bake(graph, { T_Stripes: { png: stripes, srgb: true } });
    const pixel = await pixelsOf(result);
    expect([0, 1, 2, 3].map((x) => pixel(x, 0)[0])).toEqual([0, 255, 0, 255]);
    expect(result.status === "baked" && result.confidence).toBe("heuristic");
    expect(result.status === "baked" && result.approximations.some((note) => note.startsWith("ObjectScale evaluated as 1"))).toBe(true);
  });

  it("BoundingBoxBased_0-1_UVW (a backdrop's gradient mapping) stands in as the mesh UV, not an unsupported node, and says so", async () => {
    const result = await bake(makeGraph([engineOutputs("bbox", "BoundingBoxBased_0-1_UVW", "Texturing", ["UVW"])], pin("bbox", 0, RGB_MASK)));
    expect(result.status).toBe("baked");
    const pixel = await pixelsOf(result);
    expect(pixel(3, 0)[0]!).toBeGreaterThan(pixel(0, 0)[0]!);
    expect(pixel(0, 3)[1]!).not.toBe(pixel(0, 0)[1]);
    expect(pixel(1, 1)[2]).toBe(encode(0.5));
    expect(result.status === "baked" && result.confidence).toBe("heuristic");
    expect(result.status === "baked" && result.approximations.some((note) => note.startsWith("BoundingBoxBased_0-1_UVW evaluated as the mesh UV0"))).toBe(true);
  });

  it("WorldAlignedBlend (the cliff-rock moss overlay) stands in as half the surface and says so, not an unsupported node", async () => {
    // MF_moss-overlay-function: BaseColor = lerp(rock, moss, WorldAlignedBlend."w/ Vertex Normals"). The mask follows the
    // world normal, which a UV-space bake cannot hold; before this the whole section fell back to neutral grey.
    const graph = makeGraph(
      [
        node("blend", "LinearInterpolate", { inputs: { A: pin("rock"), B: pin("moss"), Alpha: pin("aligned", 1) } }),
        constant3("rock", [0.6, 0.6, 0.6]),
        constant3("moss", [0.2, 0.4, 0.0]),
        engineOutputs("aligned", "WorldAlignedBlend", "Engine_MaterialFunctions01/AlphaBlend", ["Alpha", "w/Vertex Normals", "w/ Explicit Normal"], { Input2: pin("sharpness"), Input3: pin("bias") }),
        node("sharpness", "ScalarParameter", { parameter: { name: "Blend Sharpness Moss", group: "" }, default: 10 }),
        node("bias", "ScalarParameter", { parameter: { name: "Blend Bias Moss", group: "" }, default: -2 }),
      ],
      pin("blend", 0, RGB_MASK),
    );
    const result = await bake(graph);
    expect((await pixelsOf(result))(0, 0)).toEqual([encode(0.4), encode(0.5), encode(0.3)]);
    expect(result.status === "baked" && result.confidence).toBe("heuristic");
    expect(result.status === "baked" && result.approximations.some((note) => note.startsWith("WorldAlignedBlend evaluated as 0.5"))).toBe(true);
  });

  it("WorldAlignedBlend follows the mesh's own surface normals when the bake is given them", async () => {
    // Left half of UV space faces up (+Y), right half faces sideways. saturate(up x 10 - 2): moss (alpha 1) on the left, rock (0) on the right.
    const graph = makeGraph(
      [
        node("blend", "LinearInterpolate", { inputs: { A: pin("rock"), B: pin("moss"), Alpha: pin("aligned", 1) } }),
        constant3("rock", [0.6, 0.6, 0.6]),
        constant3("moss", [0.2, 0.4, 0.0]),
        engineOutputs("aligned", "WorldAlignedBlend", "Engine_MaterialFunctions01/AlphaBlend", ["Alpha", "w/Vertex Normals", "w/ Explicit Normal"], { Input2: pin("sharpness"), Input3: pin("bias") }),
        node("sharpness", "ScalarParameter", { parameter: { name: "Blend Sharpness Moss", group: "" }, default: 10 }),
        node("bias", "ScalarParameter", { parameter: { name: "Blend Bias Moss", group: "" }, default: -2 }),
      ],
      pin("blend", 0, RGB_MASK),
    );
    const size = 4;
    const normals = new Float32Array(size * size * 3);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) normals.set(x < size / 2 ? [0, 1, 0] : [1, 0, 0], (y * size + x) * 3);
    const result = await bakeGraph({ graph, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: makeLoader({}).loadTexture, size, surface: { width: size, height: size, normals, covered: size * size } });
    const pixel = await pixelsOf(result);
    expect(pixel(0, 0)).toEqual([encode(0.2), encode(0.4), encode(0)]);
    expect(pixel(3, 2)).toEqual([encode(0.6), encode(0.6), encode(0.6)]);
    expect(result.status === "baked" && result.approximations.some((note) => note.startsWith("WorldAlignedBlend evaluated as saturate(up component"))).toBe(true);
  });

  it("VertexNormalWS reads the mesh's own normals (Unreal Z = glTF +Y), and stays unsupported without them", async () => {
    // A level-prototyping grid tints up-facing faces: BaseColor = lerp(side, top, saturate(VertexNormalWS.z)). Before, the node
    // was unsupported and the whole section fell back to neutral.
    const graph = makeGraph(
      [
        node("blend", "LinearInterpolate", { inputs: { A: pin("side"), B: pin("top"), Alpha: pin("normal", 0, [0, 0, 1, 0]) } }),
        constant3("side", [0.3, 0.3, 0.3]),
        constant3("top", [0.8, 0.5, 0.1]),
        node("normal", "VertexNormalWS"),
      ],
      pin("blend", 0, RGB_MASK),
    );
    expect(graphReadsSurface(graph)).toBe(true);
    const size = 4;
    const normals = new Float32Array(size * size * 3);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) normals.set(x < size / 2 ? [0, 1, 0] : [0, 0, 1], (y * size + x) * 3);
    const result = await bakeGraph({ graph, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: makeLoader({}).loadTexture, size, surface: { width: size, height: size, normals, covered: size * size } });
    const pixel = await pixelsOf(result);
    expect(pixel(0, 0)).toEqual([encode(0.8), encode(0.5), encode(0.1)]);
    expect(pixel(3, 1)).toEqual([encode(0.3), encode(0.3), encode(0.3)]);
    expect(result.status === "baked" && result.approximations.some((note) => note.startsWith("VertexNormalWS evaluated from the mesh's own vertex normals"))).toBe(true);

    const blind = await bake(graph);
    expect(blind.status).toBe("unsupported");
    expect(blind.status === "unsupported" && blind.unsupported).toContain("VertexNormalWS");
  });

  it("BumpOffset keeps its Coordinate (no view vector in a bake) instead of failing the section", async () => {
    // Sample at BumpOffset(UV x 2): the 2-texel stripes tile twice over 4 pixels. A BumpOffset that returned 0 would read texel 0 everywhere.
    const stripes = await pngOf(2, 2, (x) => (x === 0 ? [0, 0, 0] : [255, 255, 255]));
    const graph = makeGraph(
      [
        textureSample("t", "T_Stripes", "Color", "bumped"),
        node("bumped", "BumpOffset", { inputs: { Coordinate: pin("scaled"), Height: pin("height"), HeightRatioInput: pin("ratio") } }),
        multiply("scaled", pin("uv"), pin("two")),
        textureCoordinate("uv"),
        node("two", "Constant", { constants: { R: 2 } }),
        node("height", "Constant", { constants: { R: 0.7 } }),
        node("ratio", "Constant", { constants: { R: 0.004 } }),
      ],
      pin("t", 0, RGB_MASK),
    );
    const result = await bake(graph, { T_Stripes: { png: stripes, srgb: true } });
    const pixel = await pixelsOf(result);
    expect([0, 1, 2, 3].map((x) => pixel(x, 0)[0])).toEqual([0, 255, 0, 255]);
    expect(result.status === "baked" && result.approximations.some((note) => note.startsWith("BumpOffset evaluated as its Coordinate"))).toBe(true);
  });

  it("PerInstanceRandom and ObjectPositionWS evaluate to one representative instance and are named, not left unsupported", async () => {
    // BaseColor = Random x (0.4, 0.8, 0.2) + ObjectPosition x 0.01: 0.5 and the origin give (0.2, 0.4, 0.1).
    const graph = makeGraph(
      [
        node("sum", "Add", { inputs: { A: pin("scaled"), B: pin("placed") } }),
        multiply("scaled", pin("random"), pin("tint")),
        node("random", "PerInstanceRandom"),
        constant3("tint", [0.4, 0.8, 0.2]),
        multiply("placed", pin("position"), pin("small")),
        node("position", "ObjectPositionWS"),
        node("small", "Constant", { constants: { R: 0.01 } }),
      ],
      pin("sum", 0, RGB_MASK),
    );
    const result = await bake(graph);
    expect((await pixelsOf(result))(0, 0)).toEqual([encode(0.2), encode(0.4), encode(0.1)]);
    expect(result.status === "baked" && result.confidence).toBe("heuristic");
    expect(result.status === "baked" && result.approximations).toEqual(
      expect.arrayContaining([expect.stringMatching(/^PerInstanceRandom evaluated as 0\.5/), expect.stringMatching(/^ObjectPositionWS evaluated as the origin/)]),
    );
  });

  it("the cliff-rock colour variation (frac of random and position, normalised) is a zero tint, not a black texture", async () => {
    // MF_color-variation: Amount x ConstantBiasScale(dot(frac(Const(100,10,1) x Random + Position x 0.01).rg, .gb), -0.5, 2)
    // x normalize(frac(...)), added to the texture. Real shape, node for node, on a flat 0.5 texture.
    const flatTexture = await pngOf(2, 2, () => [128, 128, 128]);
    const graph = makeGraph(
      [
        node("out", "Add", { inputs: { A: pin("variation"), B: pin("tex", 0, RGB_MASK) } }),
        textureSample("tex", "T_Flat"),
        multiply("variation", pin("amountTimesBias"), pin("direction")),
        multiply("amountTimesBias", pin("amount", 0, RGB_MASK), pin("bias")),
        vectorParameter("amount", "Variation", [0.02, 0, 0, 1]),
        node("bias", "ConstantBiasScale", { inputs: { Input: pin("dot") }, constants: { Bias: -0.5, Scale: 2 } }),
        node("dot", "DotProduct", { inputs: { A: pin("rg"), B: pin("gb") } }),
        node("rg", "ComponentMask", { inputs: { Input: pin("frac") }, constants: { R: true, G: true }, channelMask: [1, 1, 0, 0] }),
        node("gb", "ComponentMask", { inputs: { Input: pin("frac") }, constants: { G: true, B: true }, channelMask: [0, 1, 1, 0] }),
        node("frac", "Frac", { inputs: { Input: pin("shifted") } }),
        node("shifted", "Add", { inputs: { A: pin("randomScaled"), B: pin("positionScaled") } }),
        multiply("randomScaled", pin("weights"), pin("random")),
        constant3("weights", [100, 10, 1]),
        node("random", "PerInstanceRandom"),
        multiply("positionScaled", pin("position"), pin("small")),
        node("position", "ObjectPositionWS"),
        node("small", "Constant", { constants: { R: 0.01 } }),
        node("direction", "Normalize", { inputs: { VectorInput: pin("frac") } }),
      ],
      pin("out", 0, RGB_MASK),
    );
    const result = await bake(graph, { T_Flat: { png: flatTexture, srgb: true } });
    const texel = encode(decode(128));
    const [r, g, b] = (await pixelsOf(result))(0, 0);
    for (const channel of [r, g, b]) expect(Math.abs(channel! - texel)).toBeLessThanOrEqual(1);
    expect(result.status === "baked" && result.confidence).toBe("heuristic");
  });
});

describe("view-dependent nodes of sky and effect materials", () => {
  const bake = (graph: MaterialGraph, textures: Record<string, Fixture> = {}) =>
    bakeGraph({ graph, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: makeLoader(textures).loadTexture, size: 4 });
  const notes = (result: BakeResult): string[] => (result.status === "baked" ? result.approximations : []);

  it("Fresnel is its mean over a sphere's visible surface, so lerp(A, B, Fresnel) is a face-on-to-rim average of A and B (sky dome shape)", async () => {
    // A sky pack's cloud material: Lerp(A = blue, B = white, Alpha = Fresnel(Exponent 1.2, BaseReflectFraction 0)).
    // The mean of (1 - cos)^1.2 over a sphere's disc is 2 / ((1.2 + 1)(1.2 + 2)) = 0.28409.
    const graph = makeGraph(
      [
        node("mix", "LinearInterpolate", { inputs: { A: pin("face"), B: pin("rim"), Alpha: pin("fresnel") }, constants: { ConstB: 0, ConstAlpha: 0 } }),
        constant3("face", [0.2297, 0.269, 0.7112]),
        constant3("rim", [1, 1, 1]),
        node("fresnel", "Fresnel", { constants: { Exponent: 1.2000000476837158, BaseReflectFraction: 0 } }),
      ],
      pin("mix", 0, RGB_MASK),
    );
    const result = await bake(graph);
    const mean = 2 / (2.2 * 3.2);
    const lerp = (a: number) => a + (1 - a) * mean;
    expect((await pixelsOf(result))(0, 0)).toEqual([encode(lerp(0.2297)), encode(lerp(0.269)), encode(lerp(0.7112))]);
    expect(result.status === "baked" && result.confidence).toBe("heuristic");
    expect(notes(result).some((note) => note.startsWith("Fresnel evaluated as its mean over the visible surface of a sphere"))).toBe(true);
  });

  it("Fresnel adds its BaseReflectFraction (constant, wired pin or Unreal's 0.04 default) to the exponent's mean", async () => {
    const colour = async (nodes: Raw[]) => {
      const graph = makeGraph(
        [node("mix", "LinearInterpolate", { inputs: { A: pin("face"), B: pin("rim"), Alpha: pin("fresnel") } }), constant3("face", [0, 0, 0]), constant3("rim", [1, 1, 1]), ...nodes],
        pin("mix", 0, RGB_MASK),
      );
      return (await pixelsOf(await bake(graph)))(0, 0)[0];
    };
    const value = (reflect: number, exponent: number) => reflect + (1 - reflect) * (2 / ((exponent + 1) * (exponent + 2)));
    expect(await colour([node("fresnel", "Fresnel", { constants: { BaseReflectFraction: 0.5, Exponent: 3 } })])).toBe(encode(value(0.5, 3)));
    // Both defaults omitted by the dumper: Exponent 5, BaseReflectFraction 0.04.
    expect(await colour([node("fresnel", "Fresnel")])).toBe(encode(value(0.04, 5)));
    expect(await colour([node("fresnel", "Fresnel", { inputs: { BaseReflectFractionIn: pin("reflect"), ExponentIn: pin("power") } }), node("reflect", "Constant", { constants: { R: 0.25 } }), node("power", "Constant", { constants: { R: 1 } })])).toBe(encode(value(0.25, 1)));
    // A stiffer exponent keeps the face-on colour on more of the surface: the mean shrinks as the exponent grows.
    const stiff = (await colour([node("fresnel", "Fresnel", { constants: { BaseReflectFraction: 0, Exponent: 8 } })]))!;
    expect(stiff).toBeLessThan((await colour([node("fresnel", "Fresnel", { constants: { BaseReflectFraction: 0, Exponent: 0.5 } })]))!);
  });

  it("Fresnel with a wired Normal does not walk the normal's own nodes", async () => {
    // A TwoSidedSign (or any view node) feeding only the Normal pin must not make the colour path unsupported.
    const graph = makeGraph(
      [
        node("mix", "LinearInterpolate", { inputs: { A: pin("face"), B: pin("rim"), Alpha: pin("fresnel") } }),
        constant3("face", [0.1, 0.2, 0.3]),
        constant3("rim", [1, 1, 1]),
        node("fresnel", "Fresnel", { inputs: { Normal: pin("view") }, constants: { BaseReflectFraction: 0 } }),
        node("view", "SomeViewOnlyNode"),
      ],
      pin("mix", 0, RGB_MASK),
    );
    const result = await bake(graph);
    expect(result.status).toBe("baked");
  });

  it("DepthFade is its InOpacity (fully faded in) or OpacityDefault, and its fade distance is not walked", async () => {
    // A cave pack's water master: Lerp(DepthFade(InOpacity = ColorOpacity) x Color, Color.rgb x Color.a, DepthContribution).
    const water = (opacity: number | null) =>
      makeGraph(
        [
          node("mix", "LinearInterpolate", { inputs: { A: pin("fade"), B: pin("deep"), Alpha: pin("half") } }),
          node("fade", "DepthFade", { inputs: { ...(opacity === null ? {} : { InOpacity: pin("opacity") }), FadeDistance: pin("distance") } }),
          scalarParameter("opacity", "ColorOpacity", opacity ?? 0),
          scalarParameter("distance", "FadeDistanceColor", 0),
          constant3("deep", [0.1, 0.2, 0.4]),
          scalarParameter("half", "DepthContribution", 0.5),
        ],
        pin("mix", 0, RGB_MASK),
      );
    const wired = await bake(water(0.8));
    // A = 0.8 (all channels), B = (0.1, 0.2, 0.4): lerp at 0.5.
    expect((await pixelsOf(wired))(0, 0)).toEqual([encode(0.45), encode(0.5), encode(0.6)]);
    expect(wired.status === "baked" && wired.confidence).toBe("heuristic");
    expect(notes(wired).some((note) => note.startsWith("DepthFade evaluated as fully faded in"))).toBe(true);
    // Unwired InOpacity: OpacityDefault, 1 unless the node stores another value.
    const unwired = await bake(water(null));
    expect((await pixelsOf(unwired))(0, 0)).toEqual([encode(0.55), encode(0.6), encode(0.7)]);
  });

  it("MatLayerBlend_Tint multiplies BaseColor by lerp(1, Tint, Alpha): white tint is the identity, an alpha mask picks where the tint applies", async () => {
    // A cave pack's statue master: Tint = Edge Highlight Colour (2, 2, 2), Alpha = Mask.G; its slum master: Tint = an overall brightness vector, no alpha.
    const layer = (tint: number[], withAlpha: boolean) =>
      makeGraph(
        [
          node("break", "BreakMaterialAttributes", { inputs: { MaterialAttributes: pin("tinted") }, outputNames: ["BaseColor"] }),
          engineCall("tinted", "MatLayerBlend_Tint", { Input0: pin("make"), Input1: pin("tint", 0, RGB_MASK), Input2: withAlpha ? pin("mask", 0, [0, 1, 0, 0]) : null }),
          node("make", "MakeMaterialAttributes", { inputs: { BaseColor: pin("base") } }),
          constant3("base", [0.2, 0.3, 0.1]),
          vectorParameter("tint", "Edge Highlight Colour", [...tint, tint[0] ?? 1]),
          textureSample("mask", "T_Mask"),
        ],
        pin("break", 0, RGB_MASK),
      );
    // Mask texels: left half G = 0 (no tint), right half G = 255 (full tint). The sampler is Color/sRGB, so 0 and 255 survive decoding.
    const mask = await pngOf(4, 4, (x) => (x < 2 ? [0, 0, 0] : [0, 255, 0]));
    const bright = await bake(layer([2, 2, 2], true), { T_Mask: { png: mask, srgb: true } });
    const pixel = await pixelsOf(bright);
    expect(pixel(0, 0)).toEqual([encode(0.2), encode(0.3), encode(0.1)]);
    expect(pixel(3, 0)).toEqual([encode(0.4), encode(0.6), encode(0.2)]);
    expect(bright.status === "baked" && bright.confidence).toBe("heuristic");
    expect(notes(bright).some((note) => note.startsWith("MatLayerBlend_Tint"))).toBe(true);
    // No alpha wired, white tint: the base colour unchanged.
    const identity = await bake(layer([1, 1, 1], false));
    expect((await pixelsOf(identity))(0, 0)).toEqual([encode(0.2), encode(0.3), encode(0.1)]);
    // No alpha wired, grey tint: the whole surface is tinted.
    const dimmed = await bake(layer([0.5, 0.5, 0.5], false));
    expect((await pixelsOf(dimmed))(0, 0)).toEqual([encode(0.1), encode(0.15), encode(0.05)]);
  });

  it("TwoSidedSign is +1 (front face): a leaf card's top colour wins over its bottom colour, and the bake says so", async () => {
    // Kite foliage: Lerp(bottom texture, top texture, Clamp(TwoSidedSign)) where the sign is -1 on the back face.
    const graph = makeGraph(
      [
        node("mix", "LinearInterpolate", { inputs: { A: pin("bottom"), B: pin("top"), Alpha: pin("clamp") } }),
        constant3("bottom", [0.1, 0.1, 0.1]),
        constant3("top", [0.3, 0.6, 0.2]),
        node("clamp", "Clamp", { inputs: { Input: pin("sign") } }),
        node("sign", "TwoSidedSign"),
      ],
      pin("mix", 0, RGB_MASK),
    );
    const result = await bake(graph);
    expect((await pixelsOf(result))(0, 0)).toEqual([encode(0.3), encode(0.6), encode(0.2)]);
    expect(result.status === "baked" && result.confidence).toBe("heuristic");
    expect(notes(result).some((note) => note.startsWith("TwoSidedSign evaluated as +1"))).toBe(true);
  });

  it("a texture sampled at a WorldPosition-derived coordinate reads its average colour, not one UV-space texel, and says so", async () => {
    // A grass pack's WorldCoords-XY function: ComponentMask(WorldPosition).xy / Scale, feeding a macro variation mask.
    // The 4x4 mask is 255 on its four corner texels and 0 elsewhere: its average is 0.25. The origin (uv 0, 0) wraps onto those
    // four corners, so a sample taken there reads 1; the average reads 0.25.
    const corner = (n: number): boolean => n === 0 || n === 3;
    const mask = await pngOf(4, 4, (x, y) => (corner(x) && corner(y) ? [255, 255, 255] : [0, 0, 0]));
    const graph = makeGraph(
      [
        node("mix", "LinearInterpolate", { inputs: { A: pin("dead"), B: pin("live"), Alpha: pin("mask", 0, [1, 0, 0, 0]) } }),
        constant3("dead", [0, 0, 0]),
        constant3("live", [1, 1, 1]),
        node("mask", "TextureSample", { inputs: { Coordinates: pin("coords") }, texture: "/Game/Test/T_Mask.T_Mask", samplerType: "LinearColor" }),
        node("coords", "Divide", { inputs: { A: pin("xy"), B: pin("scale") } }),
        node("xy", "ComponentMask", { inputs: { Input: pin("world") }, channelMask: [1, 1, 0, 0] }),
        node("world", "WorldPosition"),
        node("scale", "Constant", { constants: { R: 600 } }),
      ],
      pin("mix", 0, RGB_MASK),
    );
    const result = await bake(graph, { T_Mask: { png: mask, srgb: false } });
    const pixel = await pixelsOf(result);
    expect(pixel(0, 0)).toEqual([encode(0.25), encode(0.25), encode(0.25)]);
    expect(pixel(3, 3)).toEqual(pixel(0, 0));
    expect(result.status === "baked" && result.confidence).toBe("heuristic");
    expect(notes(result).some((note) => note.startsWith("WorldPosition evaluated as the origin"))).toBe(true);
  });

  it("an engine function without a body is named alone: its other outputs' inputs are not reported as a Cycle", async () => {
    // ImposterUVs(UVs, ..., Normal in) -> output 0 feeds a normal texture, whose sample is wired back to the same call's input 8
    // (for its TransformedNormals output). BaseColor reads output 0 only, so there is no loop, only an engine function with no body.
    const graph = makeGraph(
      [
        node("tex", "TextureSample", { inputs: { Coordinates: pin("uvs", 0) }, texture: "/Game/Test/T_Albedo.T_Albedo", samplerType: "Color" }),
        engineCall("uvs", "ImposterUVs", { Input0: pin("scale"), Input8: pin("normalTex", 0, RGB_MASK) }),
        node("normalTex", "TextureSample", { inputs: { Coordinates: pin("uvs", 0) }, texture: "/Game/Test/T_Normal.T_Normal", samplerType: "Normal" }),
        node("scale", "Constant", { constants: { R: 4 } }),
      ],
      pin("tex", 0, RGB_MASK),
    );
    const result = await bake(graph);
    expect(result).toMatchObject({ status: "unsupported", unsupported: ["ImposterUVs"] });
  });
});

describe("layered architecture masters: texture objects, render-path switches, surface and layer functions", () => {
  const bake = (graph: MaterialGraph, textures: Record<string, Fixture> = {}, extra: Partial<Parameters<typeof bakeGraph>[0]> = {}) =>
    bakeGraph({ graph, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: makeLoader(textures).loadTexture, size: 4, ...extra });
  const notes = (result: BakeResult): string[] => (result.status === "baked" ? result.approximations : []);
  /** An engine function with no body in the pack, at its real engine path. */
  const engineFn = (id: string, path: string, inputs: Raw, outputNames: string[] = ["Blended Material"]): Raw => {
    const name = path.slice(path.lastIndexOf("/") + 1);
    return node(id, "FunctionCall", {
      inputs,
      function: `/Engine/Functions/${path}.${name}`,
      outputNames,
      fn: { inputs: Object.fromEntries(Object.entries(inputs).map(([key, value]) => [key, value && (value as { node: string }).node])), outputs: [], output: null },
      error: "material function could not be loaded (engine content is not in the pack)",
    });
  };
  const layer = (id: string, rgb: [number, number, number]): Raw[] => [node(id, "MakeMaterialAttributes", { inputs: { BaseColor: pin(`${id}/c`) } }), constant3(`${id}/c`, rgb)];
  const breakColour = (id: string, source: string): Raw => node(id, "BreakMaterialAttributes", { inputs: { MaterialAttributes: pin(source) }, outputNames: ["BaseColor"] });
  const surfaceOf = (size: number, normalAt: (x: number) => [number, number, number]) => {
    const normals = new Float32Array(size * size * 3);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) normals.set(normalAt(x), (y * size + x) * 3);
    return { width: size, height: size, normals, covered: size * size };
  };

  it("a sample's wired TextureObject replaces its own preview texture, and a TextureObjectParameter honours the instance", async () => {
    // A layer function samples its BaseColorTexture input; the sample's own Texture property is the function's DefaultDiffuse preview.
    const red = flat([255, 0, 0]);
    const blue = flat([0, 0, 255]);
    const green = flat([0, 255, 0]);
    const graph = makeGraph(
      [
        node("sample", "TextureSample", { inputs: { TextureObject: pin("input") }, texture: "/Engine/EngineMaterials/DefaultDiffuse.DefaultDiffuse", samplerType: "Color" }),
        node("input", "FunctionInput", { inputs: { Preview: pin("preview"), Input: pin("object") }, constants: { InputName: "BaseColorTexture", InputType: "FunctionInput_Texture2D" } }),
        node("preview", "TextureObject", { texture: "/Engine/EngineMaterials/DefaultDiffuse.DefaultDiffuse", samplerType: "Color" }),
        node("object", "TextureObjectParameter", { parameter: { name: "Gold", group: "" }, default: null, texture: "/Game/Test/T_Gold.T_Gold", samplerType: "Color" }),
      ],
      pin("sample", 0, RGB_MASK),
    );
    const textures = { DefaultDiffuse: { png: await red(), srgb: true }, T_Gold: { png: await blue(), srgb: true }, T_Override: { png: await green(), srgb: true } };
    const own = await bake(graph, textures);
    expect((await pixelsOf(own))(0, 0)).toEqual([0, 0, 255]);
    expect(own.status === "baked" && own.confidence).toBe("exact");
    const overridden = await bake(graph, textures, { parameters: params({ textures: { gold: "/Game/Test/T_Override.T_Override" } }) });
    expect((await pixelsOf(overridden))(0, 0)).toEqual([0, 255, 0]);
  });

  it("LightmassReplace and MaterialProxyReplace take Realtime exactly and never visit the other branch", async () => {
    for (const [cls, other] of [["LightmassReplace", "Lightmass"], ["MaterialProxyReplace", "MaterialProxy"]] as const) {
      const graph = makeGraph(
        [node("r", cls, { inputs: { Realtime: pin("c", 0, RGB_MASK), [other]: pin("bad") } }), constant3("c", [0.25, 0.5, 0.75]), node("bad", "ReflectionVectorWS")],
        pin("r", 0, RGB_MASK),
      );
      const result = await bake(graph);
      expect((await pixelsOf(result))(0, 0), cls).toEqual([encode(0.25), encode(0.5), encode(0.75)]);
      expect(result.status === "baked" && result.confidence, cls).toBe("exact");
    }
  });

  it("PrecomputedAOMask is 0, Unreal's value without built static lighting, and says so", async () => {
    // The jungle master's AO function: lerp(AO+ = 1.7, AO- = -3, PrecomputedAOMask) drives the wall colour mix.
    const graph = makeGraph(
      [
        node("mix", "LinearInterpolate", { inputs: { A: pin("dark"), B: pin("light"), Alpha: pin("clamp") } }),
        constant3("dark", [0.1, 0.1, 0.1]),
        constant3("light", [0.5, 0.4, 0.3]),
        node("clamp", "Clamp", { inputs: { Input: pin("ao") } }),
        node("ao", "LinearInterpolate", { inputs: { A: pin("plus"), B: pin("minus"), Alpha: pin("mask") } }),
        node("plus", "Constant", { constants: { R: 1.7 } }),
        node("minus", "Constant", { constants: { R: -3 } }),
        node("mask", "PrecomputedAOMask"),
      ],
      pin("mix", 0, RGB_MASK),
    );
    const result = await bake(graph);
    expect((await pixelsOf(result))(0, 0)).toEqual([encode(0.5), encode(0.4), encode(0.3)]);
    expect(notes(result).some((note) => note.startsWith("PrecomputedAOMask evaluated as 0"))).toBe(true);
  });

  it("VertexNormalWS is the mesh's own normal in Unreal axes (glTF +Y is Unreal Z) when the bake has the surface, and unsupported without it", async () => {
    // abs(VertexNormalWS.b) picks the leak colour on up-facing texels (left half) and the wall colour on side-facing ones.
    const graph = makeGraph(
      [
        node("mix", "LinearInterpolate", { inputs: { A: pin("wall"), B: pin("leak"), Alpha: pin("abs") } }),
        constant3("wall", [0.6, 0.6, 0.6]),
        constant3("leak", [0.2, 0.1, 0.0]),
        node("abs", "Abs", { inputs: { Input: pin("z") } }),
        node("z", "ComponentMask", { inputs: { Input: pin("normal") }, channelMask: [0, 0, 1, 0] }),
        node("normal", "VertexNormalWS"),
      ],
      pin("mix", 0, RGB_MASK),
    );
    const surface = surfaceOf(4, (x) => (x < 2 ? [0, 1, 0] : [0, 0, 1]));
    const result = await bake(graph, {}, { surface });
    const pixel = await pixelsOf(result);
    expect(pixel(0, 0)).toEqual([encode(0.2), encode(0.1), encode(0)]);
    expect(pixel(3, 0)).toEqual([encode(0.6), encode(0.6), encode(0.6)]);
    expect(notes(result).some((note) => note.startsWith("VertexNormalWS evaluated from the mesh's own vertex normals"))).toBe(true);
    expect(await bake(graph)).toMatchObject({ status: "unsupported", unsupported: ["VertexNormalWS"] });
  });

  it("Transform carries a flat tangent-space normal to the vertex normal, keeps Local/World as the identity, and names other spaces", async () => {
    // The moss layer: dot(Transform(BreakNormal(attributes)), (0, 0, 1)) is the up-facing mask; a flat normal map gives the vertex normal.
    const moss = (transform: Raw) =>
      makeGraph(
        [
          node("dot", "DotProduct", { inputs: { A: pin("t"), B: pin("up") } }),
          transform,
          engineFn("flat", "MaterialLayerFunctions/MatLayerBlend_BreakNormal", { Input0: pin("attrs") }, ["Normal"]),
          ...layer("attrs", [0.5, 0.5, 0.5]),
          constant3("up", [0, 0, 1]),
        ],
        pin("dot"),
      );
    const surface = surfaceOf(4, (x) => (x < 2 ? [0, 1, 0] : [1, 0, 0]));
    const tangent = await bake(moss(node("t", "Transform", { inputs: { Input: pin("flat") } })), {}, { surface });
    const pixel = await pixelsOf(tangent);
    expect(pixel(0, 0)).toEqual([255, 255, 255]);
    expect(pixel(3, 0)).toEqual([0, 0, 0]);
    expect(notes(tangent)).toEqual(expect.arrayContaining([expect.stringMatching(/^Transform from Tangent to World/), expect.stringMatching(/^MatLayerBlend_BreakNormal/)]));
    const local = await bake(moss(node("t", "Transform", { inputs: { Input: pin("flat") }, constants: { TransformSourceType: "TRANSFORMSOURCE_Local" } })));
    expect((await pixelsOf(local))(0, 0)).toEqual([255, 255, 255]);
    expect(notes(local).some((note) => note.startsWith("Transform between Local and World"))).toBe(true);
    const view = await bake(moss(node("t", "Transform", { inputs: { Input: pin("flat") }, constants: { TransformSourceType: "TRANSFORMSOURCE_World", TransformType: "TRANSFORM_View" } })), {}, { surface });
    expect(view).toMatchObject({ status: "unsupported", unsupported: ["Transform(World to View)"] });
    expect(await bake(moss(node("t", "Transform", { inputs: { Input: pin("flat") } })))).toMatchObject({ status: "unsupported", unsupported: ["Transform(Tangent to World)"] });
  });

  it("ObjectRadius is the mesh's bounding radius: UV x scale x radius / 250 tiles the detail mask with the mesh size", async () => {
    // The jungle detail function: TextureSample(T, UV x 2 x ObjectRadius / 250). A 250 cm radius tiles the stripes twice; 125 cm once.
    const stripes = await pngOf(2, 2, (x) => (x === 0 ? [0, 0, 0] : [255, 255, 255]));
    const graph = makeGraph(
      [
        textureSample("t", "T_Stripes", "Color", "coords"),
        multiply("coords", pin("radius"), pin("scaled")),
        node("radius", "Divide", { inputs: { A: pin("r") }, constants: { ConstB: 250 } }),
        node("r", "ObjectRadius"),
        multiply("scaled", pin("uv"), pin("two")),
        textureCoordinate("uv"),
        node("two", "Constant", { constants: { R: 2 } }),
      ],
      pin("t", 0, RGB_MASK),
    );
    const textures = { T_Stripes: { png: stripes, srgb: true } };
    const large = await pixelsOf(await bake(graph, textures, { objectRadius: 250 }));
    expect([0, 1, 2, 3].map((x) => large(x, 0)[0])).toEqual([0, 255, 0, 255]);
    // 125 cm tiles once: the same pixels as the graph with the radius written in as a constant, and not the 250 cm pixels.
    const small = await pixelsOf(await bake(graph, textures, { objectRadius: 125 }));
    const constant = makeGraph(graph.nodes.map((entry) => (entry.id === "r" ? node("r", "Constant", { constants: { R: 125 } }) : entry)) as Raw[], pin("t", 0, RGB_MASK));
    const reference = await pixelsOf(await bake(constant, textures));
    expect([0, 1, 2, 3].map((x) => small(x, 0))).toEqual([0, 1, 2, 3].map((x) => reference(x, 0)));
    expect(small(0, 0)).not.toEqual(large(0, 0));
    expect(await bake(graph, textures)).toMatchObject({ status: "unsupported", unsupported: ["ObjectRadius"] });
  });

  it("WorldAlignedTexture reads its texture object's average colour, honouring a TextureObjectParameter override", async () => {
    // Half black, half white (linear Masks sampler): the average of every output is 0.5, whatever the size input says.
    const half = await pngOf(4, 4, (x) => (x < 2 ? [0, 0, 0] : [255, 255, 255]));
    const quarter = await pngOf(4, 4, (x) => (x < 3 ? [0, 0, 0] : [255, 255, 255]));
    const graph = (output: number) =>
      makeGraph(
        [
          node("mask", "ComponentMask", { inputs: { Input: pin("wat", output) }, channelMask: [0, 1, 0, 0] }),
          engineFn("wat", "Engine_MaterialFunctions01/Texturing/WorldAlignedTexture", { Input0: pin("object"), Input1: pin("size") }, ["XY Texture", "Z Texture", "XYZ Texture"]),
          node("object", "TextureObjectParameter", { parameter: { name: "Details Mask", group: "" }, default: null, texture: "/Game/Test/T_Half.T_Half", samplerType: "Masks" }),
          node("size", "ScalarParameter", { parameter: { name: "MaskScale", group: "" }, default: 800 }),
        ],
        pin("mask"),
      );
    const textures = { T_Half: { png: half, srgb: false }, T_Quarter: { png: quarter, srgb: false } };
    for (const output of [0, 1, 2]) {
      const result = await bake(graph(output), textures);
      expect((await pixelsOf(result))(0, 0), `output ${output}`).toEqual([encode(0.5), encode(0.5), encode(0.5)]);
      expect(notes(result).some((note) => note.startsWith("WorldAlignedTexture evaluated as its texture's average colour"))).toBe(true);
    }
    const overridden = await bake(graph(2), textures, { parameters: params({ textures: { "details mask": "/Game/Test/T_Quarter.T_Quarter" } }) });
    expect((await pixelsOf(overridden))(3, 3)).toEqual([encode(0.25), encode(0.25), encode(0.25)]);
  });

  it("FlowMaps_Simple's Diffuse is its diffuse texture's average, Diffuse Alpha that average's alpha, Normal flat; Distortion stays unsupported", async () => {
    // The water masters: FlowMaps_Simple(Input0 = water texture object, Input1 = normal texture object, ..., Input5 = Panner).
    const half = await pngOf(4, 4, (x) => (x < 2 ? [0, 0, 0] : [255, 255, 255]));
    const flow = (output: number, mask: number[] | null) =>
      makeGraph(
        [
          engineFn("flow", "Engine_MaterialFunctions02/Texturing/FlowMaps_Simple", { Input0: pin("water"), Input1: pin("normal"), Input5: pin("pan") }, ["Diffuse", "Diffuse Alpha", "Normal", "Distortion"]),
          node("water", "TextureObject", { texture: "/Game/Test/T_Half.T_Half", samplerType: "LinearColor" }),
          node("normal", "TextureObject", { texture: "/Game/Test/T_Normal.T_Normal", samplerType: "Normal" }),
          node("pan", "Panner", { constants: { SpeedY: 0.1, bFractionalPart: true } }),
        ],
        pin("flow", output, mask),
      );
    const textures = { T_Half: { png: half, srgb: false } };
    const diffuse = await bake(flow(0, RGB_MASK), textures);
    expect((await pixelsOf(diffuse))(1, 2)).toEqual([encode(0.5), encode(0.5), encode(0.5)]);
    expect(notes(diffuse).some((note) => note.startsWith("FlowMaps_Simple: Diffuse evaluated as its texture's average"))).toBe(true);
    expect((await pixelsOf(await bake(flow(1, null), textures)))(0, 0)).toEqual([255, 255, 255]);
    expect((await pixelsOf(await bake(flow(2, null), textures)))(0, 0)).toEqual([0, 0, 255]);
    expect(await bake(flow(3, null), textures)).toMatchObject({ status: "unsupported", unsupported: ["FlowMaps_Simple.Distortion"] });
  });

  it("MatLayerBlend_TenLayerBlend lerps the layers over Input20 from Input18 (next to the base) up to Input0 (top), ignoring Input21", async () => {
    // A turret master: dirt (Input0) over lights (Input6) over gold (Input18) over marble (Input20); Input21 is a baked normal map.
    const tenLayers = (alphas: { dirt: number; gold: number }) =>
      makeGraph(
        [
          breakColour("out", "ten"),
          engineFn("ten", "MaterialLayerFunctions/MatLayerBlend_TenLayerBlend", {
            ...Object.fromEntries(Array.from({ length: 22 }, (_, index) => [`Input${index}`, null])),
            Input0: pin("dirt"),
            Input1: pin("dirtAlpha"),
            Input18: pin("gold"),
            Input19: pin("goldAlpha"),
            Input20: pin("marble"),
            Input21: pin("normalMap", 0, RGB_MASK),
          }),
          ...layer("dirt", [0.1, 0.08, 0.06]),
          ...layer("gold", [1, 0.8, 0.3]),
          ...layer("marble", [0.7, 0.7, 0.7]),
          node("dirtAlpha", "Constant", { constants: { R: alphas.dirt } }),
          node("goldAlpha", "Constant", { constants: { R: alphas.gold } }),
          node("normalMap", "ReflectionVectorWS"),
        ],
        pin("out", 0, RGB_MASK),
      );
    const base = await bake(tenLayers({ dirt: 0, gold: 0 }));
    expect((await pixelsOf(base))(0, 0)).toEqual([encode(0.7), encode(0.7), encode(0.7)]);
    // Both masks full: the top layer (Input0) wins over the one beside the base.
    expect((await pixelsOf(await bake(tenLayers({ dirt: 1, gold: 1 }))))(0, 0)).toEqual([encode(0.1), encode(0.08), encode(0.06)]);
    const half = await bake(tenLayers({ dirt: 0.5, gold: 1 }));
    expect((await pixelsOf(half))(0, 0)).toEqual([encode(0.55), encode(0.44), encode(0.18)]);
    expect(notes(half).some((note) => note.startsWith("MatLayerBlend_TenLayerBlend"))).toBe(true);
  });

  it("MatLayerBlend_TenLayerBlend with no base (Input20 unwired) blends its layers over Unreal's default attributes, so a nested blend still bakes", async () => {
    // A character master nests a ten-layer blend (a decal layer: flakes over hard metal, no base) as one layer of the outer
    // blend; the inner call wires only Input16..Input19 and the baked normal.
    const inner = (alpha: number) => [
      engineFn("inner", "MaterialLayerFunctions/MatLayerBlend_TenLayerBlend", {
        ...Object.fromEntries(Array.from({ length: 22 }, (_, index) => [`Input${index}`, null])),
        Input16: pin("flakes"),
        Input17: pin("flakesAlpha"),
        Input18: pin("metal"),
        Input19: pin("metalAlpha"),
        Input21: pin("normalMap", 0, RGB_MASK),
      }),
      ...layer("flakes", [0.8, 0.8, 0.9]),
      ...layer("metal", [0.4, 0.3, 0.2]),
      node("flakesAlpha", "Constant", { constants: { R: 0 } }),
      node("metalAlpha", "Constant", { constants: { R: alpha } }),
      node("normalMap", "ReflectionVectorWS"),
    ];
    const outer = (alpha: number) =>
      makeGraph(
        [
          breakColour("out", "ten"),
          engineFn("ten", "MaterialLayerFunctions/MatLayerBlend_TenLayerBlend", {
            ...Object.fromEntries(Array.from({ length: 22 }, (_, index) => [`Input${index}`, null])),
            Input14: pin("inner"),
            Input15: pin("innerAlpha"),
            Input20: pin("cloth"),
          }),
          ...inner(alpha),
          ...layer("cloth", [0.2, 0.5, 0.2]),
          node("innerAlpha", "Constant", { constants: { R: 1 } }),
        ],
        pin("out", 0, RGB_MASK),
      );
    const covered = await bake(outer(1));
    expect(covered.status).toBe("baked");
    expect((await pixelsOf(covered))(0, 0)).toEqual([encode(0.4), encode(0.3), encode(0.2)]);
    expect(notes(covered).some((note) => note.includes("Input20 (the base) is unwired"))).toBe(true);
    // Where no layer of the inner blend covers, the default attributes show: BaseColor black.
    expect((await pixelsOf(await bake(outer(0))))(0, 0)).toEqual([0, 0, 0]);
  });

  it("MatLayerBlend helpers: Break/Override/MultiplyBaseColor act on BaseColor, the others pass it through, without walking their other pins", async () => {
    const base = layer("base", [0.2, 0.4, 0.6]);
    const call = (name: string, inputs: Raw) => engineFn("f", `MaterialLayerFunctions/${name}`, inputs, name === "MatLayerBlend_BreakBaseColor" ? ["BaseColor"] : ["Blended Material"]);
    const colourOf = async (nodes: Raw[], root: ReturnType<typeof pin>) => {
      const result = await bake(makeGraph(nodes, root));
      return { pixel: (await pixelsOf(result))(0, 0), result };
    };
    const broken = await colourOf([call("MatLayerBlend_BreakBaseColor", { Input0: pin("base") }), ...base], pin("f", 0, RGB_MASK));
    expect(broken.pixel).toEqual([encode(0.2), encode(0.4), encode(0.6)]);
    const overridden = await colourOf([breakColour("out", "f"), call("MatLayerBlend_OverrideBaseColor", { Input0: pin("base"), Input1: pin("c", 0, RGB_MASK), Input2: null }), constant3("c", [0.9, 0.1, 0.1]), ...base], pin("out", 0, RGB_MASK));
    expect(overridden.pixel).toEqual([encode(0.9), encode(0.1), encode(0.1)]);
    const multiplied = await colourOf([breakColour("out", "f"), call("MatLayerBlend_MultiplyBaseColor", { Input0: pin("base"), Input1: pin("c", 0, RGB_MASK), Input2: pin("amount") }), constant3("c", [0.5, 0.5, 0]), node("amount", "Constant", { constants: { R: 0.5 } }), ...base], pin("out", 0, RGB_MASK));
    expect(multiplied.pixel).toEqual([encode(0.15), encode(0.3), encode(0.3)]);
    for (const name of ["MatLayerBlend_Emissive", "MatLayerBlend_ModulateRoughness", "MatLayerBlend_ModulateSpecular", "MatLayerBlend_ReplaceNormals", "MatLayerBlend_NormalFlatten", "MatLayerBlend_OverrideWorldPositionOffset", "MatLayerBlend_LightmassReplace"]) {
      const passed = await colourOf([breakColour("out", "f"), call(name, { Input0: pin("base"), Input1: pin("bad") }), node("bad", "ReflectionVectorWS"), ...base], pin("out", 0, RGB_MASK));
      expect(passed.pixel, name).toEqual([encode(0.2), encode(0.4), encode(0.6)]);
      expect(notes(passed.result).some((note) => note.startsWith(`${name}: BaseColor passed through`)), name).toBe(true);
    }
    expect(supportedEngineFunctions()).toEqual(expect.arrayContaining(["MatLayerBlend_TenLayerBlend", "MatLayerBlend_BreakBaseColor", "WorldAlignedTexture", "Lerp_ScratchGrime"]));
  });

  it("Lerp_ScratchGrime lays scratch then grime over the base, and MetallicShading passes its colour through", async () => {
    const graph = makeGraph(
      [
        engineFn("shade", "Engine_MaterialFunctions01/Shading/MetallicShading", { Input0: pin("lerp") }, ["Result"]),
        engineFn("lerp", "Engine_MaterialFunctions03/Blends/Lerp_ScratchGrime", { Input0: pin("base", 0, RGB_MASK), Input1: pin("scratch", 0, RGB_MASK), Input2: pin("grime", 0, RGB_MASK), Input3: pin("scratchMask"), Input4: pin("grimeMask") }, ["Result"]),
        constant3("base", [0.8, 0.8, 0.8]),
        constant3("scratch", [1, 1, 1]),
        constant3("grime", [0, 0, 0]),
        node("scratchMask", "Constant", { constants: { R: 0.25 } }),
        node("grimeMask", "Constant", { constants: { R: 0.5 } }),
      ],
      pin("shade", 0, RGB_MASK),
    );
    const result = await bake(graph);
    // lerp(lerp(0.8, 1, 0.25), 0, 0.5) = 0.425; grime first would be lerp(lerp(0.8, 0, 0.5), 1, 0.25) = 0.55.
    expect((await pixelsOf(result))(0, 0)).toEqual([encode(0.425), encode(0.425), encode(0.425)]);
    expect(notes(result)).toEqual(expect.arrayContaining([expect.stringMatching(/^Lerp_ScratchGrime/), expect.stringMatching(/^MetallicShading/)]));
  });

  it("Time is the first frame and Panner its coordinate unpanned; Sine, Ceil and Floor are exact", async () => {
    // Stripes sampled through Panner(UV x 2, Time): at t = 0 the stripes tile twice and are not shifted.
    const stripes = await pngOf(2, 2, (x) => (x === 0 ? [0, 0, 0] : [255, 255, 255]));
    for (const wiredTime of [false, true]) {
      const graph = makeGraph(
        [
          textureSample("t", "T_Stripes", "Color", "pan"),
          node("pan", "Panner", { inputs: { Coordinate: pin("scaled"), ...(wiredTime ? { Time: pin("time") } : {}) }, constants: { SpeedX: 0.37 } }),
          node("time", "Time"),
          multiply("scaled", pin("uv"), pin("two")),
          textureCoordinate("uv"),
          node("two", "Constant", { constants: { R: 2 } }),
        ],
        pin("t", 0, RGB_MASK),
      );
      const result = await bake(graph, { T_Stripes: { png: stripes, srgb: true } });
      const pixel = await pixelsOf(result);
      expect([0, 1, 2, 3].map((x) => pixel(x, 0)[0]), `wired time ${wiredTime}`).toEqual([0, 255, 0, 255]);
      expect(notes(result).some((note) => note.startsWith(wiredTime ? "Time evaluated as 0" : "Panner evaluated at time 0"))).toBe(true);
    }
    // Sine(0.25, Period 1) = 1; Ceil(0.2) = 1; Floor(0.7) = 0: (1, 1, 0).
    const maths = makeGraph(
      [
        node("rg", "AppendVector", { inputs: { A: pin("sine"), B: pin("ceil") } }),
        node("rgb", "AppendVector", { inputs: { A: pin("rg"), B: pin("floor") } }),
        node("sine", "Sine", { inputs: { Input: pin("quarter") } }),
        node("ceil", "Ceil", { inputs: { Input: pin("small") } }),
        node("floor", "Floor", { inputs: { Input: pin("large") } }),
        node("quarter", "Constant", { constants: { R: 0.25 } }),
        node("small", "Constant", { constants: { R: 0.2 } }),
        node("large", "Constant", { constants: { R: 0.7 } }),
      ],
      pin("rgb"),
    );
    const exact = await bake(maths);
    expect((await pixelsOf(exact))(0, 0)).toEqual([255, 255, 0]);
    expect(exact.status === "baked" && exact.confidence).toBe("exact");
  });

  it("an unconnected function input that uses its preview value as default is its PreviewValue, sized by InputType (zero when omitted)", async () => {
    const graph = (constants: Raw) =>
      makeGraph(
        [
          node("mix", "LinearInterpolate", { inputs: { A: pin("a"), B: pin("b"), Alpha: pin("mask") } }),
          constant3("a", [0.2, 0.2, 0.2]),
          constant3("b", [1, 0, 0]),
          node("mask", "FunctionInput", { inputs: { Input: null }, constants: { InputName: "ScratchMASK", InputType: "FunctionInput_Scalar", ...constants } }),
        ],
        pin("mix", 0, RGB_MASK),
      );
    expect((await pixelsOf(await bake(graph({ bUsePreviewValueAsDefault: true }))))(0, 0)).toEqual([encode(0.2), encode(0.2), encode(0.2)]);
    expect((await pixelsOf(await bake(graph({ bUsePreviewValueAsDefault: true, PreviewValue: [1, 0, 0, 0] }))))(0, 0)).toEqual([255, 0, 0]);
    // Without the flag Unreal refuses to compile a missing function input.
    expect((await bake(graph({}))).status).toBe("unavailable");
  });
});

describe("CollectionParameter", () => {
  // A pack-wide colour grade: albedo x a MaterialParameterCollection entry (intensity) and + a collection colour.
  const graded = (intensity: number | null, overlay: number[] | null): MaterialGraph =>
    makeGraph(
      [
        node("add", "Add", { inputs: { A: pin("mul"), B: pin("overlay", 0, RGB_MASK) } }),
        multiply("mul", pin("tex", 0, RGB_MASK), pin("intensity")),
        textureSample("tex", "T_Albedo"),
        node("intensity", "CollectionParameter", { parameter: { name: "Albedo_Intensity", group: "" }, default: intensity, collection: "/Game/Test/MPC_Grade.MPC_Grade" }),
        node("overlay", "CollectionParameter", { parameter: { name: "Albedo_Overlay", group: "" }, default: overlay, collection: "/Game/Test/MPC_Grade.MPC_Grade" }),
      ],
      pin("add"),
    );

  it("evaluates a collection entry at its default, scalar or colour", async () => {
    const loader = makeLoader({ T_Albedo: { png: await flat([128, 128, 128])(), srgb: true } });
    const result = await bakeGraph({ graph: graded(0.5, [0.1, 0, 0, 1]), output: "baseColor", parameters: NO_PARAMETERS, loadTexture: loader.loadTexture, size: 4 });
    const pixel = (await pixelsOf(result))(0, 0);
    const grey = decode(128);
    expect(pixel[0]).toBeCloseTo(encode(grey * 0.5 + 0.1), -0.5);
    expect(pixel[1]).toBeCloseTo(encode(grey * 0.5), -0.5);
    expect(pixel[2]).toBeCloseTo(encode(grey * 0.5), -0.5);
  });

  it("is unsupported when the dump could not read the collection's default", async () => {
    const loader = makeLoader({ T_Albedo: { png: await flat([128, 128, 128])(), srgb: true } });
    const result = await bakeGraph({ graph: graded(null, [0, 0, 0, 1]), output: "baseColor", parameters: NO_PARAMETERS, loadTexture: loader.loadTexture, size: 4 });
    expect(result.status).toBe("unsupported");
    if (result.status === "unsupported") expect(result.unsupported).toEqual(["CollectionParameter"]);
  });

  it("is wired into the converter's graph dump (converter 62 onwards)", async () => {
    const { CUE4PARSE_PROGRAM } = await import("../src/unreal/cue4parse-adapter.js");
    expect(CUE4PARSE_PROGRAM).toContain('className == "CollectionParameter"');
    expect(CUE4PARSE_PROGRAM).toContain('"ScalarParameters"');
    expect(CUE4PARSE_PROGRAM).toContain('"VectorParameters"');
  });
});

describe("HeightLerp, SmoothThreshold and graphPathTextures", () => {
  const HEIGHT_LERP = "/Engine/Functions/Engine_MaterialFunctions02/Texturing/HeightLerp.HeightLerp";
  const SMOOTH_THRESHOLD = "/Engine/Functions/Engine_MaterialFunctions02/SmoothThreshold";
  const bake = (graph: MaterialGraph, textures: Record<string, Fixture> = {}) =>
    bakeGraph({ graph, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: makeLoader(textures).loadTexture, size: 2 });
  // A grey 2x2 height map: the left column is 64, the right 255. A Masks sampler reads it raw, so H = 64/255 and 1.
  const heightMap = async (): Promise<Record<string, Fixture>> => ({
    T_Height: { png: await pngOf(2, 2, (x) => (x === 0 ? [64, 64, 64] : [255, 255, 255])), srgb: false },
  });
  // A HeightLerp call as the dump has it: no function body, pins as the UE 4.27 texturing docs name them.
  // A = red and B = blue (linear); the height is the texture's red channel.
  const heightLerp = (phase: number, contrast: number, reference = HEIGHT_LERP): Raw[] => [
    node("hl", "FunctionCall", {
      inputs: { A: pin("a"), B: pin("b"), "Transition Phase": pin("phase"), "Height Texture": pin("height", 0, [1, 0, 0, 0]), Contrast: pin("contrast") },
      function: reference,
      outputNames: ["Results", "Alpha", "Lerp Alpha No Contrast"],
    }),
    constant3("a", [1, 0, 0]),
    constant3("b", [0, 0, 1]),
    node("phase", "Constant", { constants: { R: phase } }),
    textureSample("height", "T_Height", "Masks"),
    node("contrast", "Constant", { constants: { R: contrast } }),
  ];

  // The same call with A, B and Contrast fed by the named nodes, so a test can wire an unsupported node to a pin the output does not
  // read. SmoothThreshold has no public definition, so the "gate" node stays unsupported wherever it is read.
  const heightLerpFed = (from: { a: string; b: string; contrast: string }): Raw[] => [
    node("hl", "FunctionCall", {
      inputs: { A: pin(from.a), B: pin(from.b), "Transition Phase": pin("phase"), "Height Texture": pin("height", 0, [1, 0, 0, 0]), Contrast: pin(from.contrast) },
      function: HEIGHT_LERP,
      outputNames: ["Results", "Alpha", "Lerp Alpha No Contrast"],
    }),
    constant3("a", [1, 0, 0]),
    constant3("b", [0, 0, 1]),
    node("phase", "Constant", { constants: { R: 0.5 } }),
    textureSample("height", "T_Height", "Masks"),
    node("contrast", "Constant", { constants: { R: 0.2 } }),
    node("gate", "FunctionCall", { function: SMOOTH_THRESHOLD }),
  ];

  it("HeightLerp Results at Transition Phase 0.5 is the standard lerp of A and B by the height", async () => {
    const result = await bake(makeGraph(heightLerp(0.5, 0), pin("hl", 0, RGB_MASK)), await heightMap());
    expect(result.status).toBe("baked");
    const pixel = await pixelsOf(result);
    // Contrast 0 makes Alpha the height itself, so Results = (1 - H, 0, H) in linear light, encoded per channel.
    for (const [x, height] of [[0, 64 / 255], [1, 1]] as const) expect(pixel(x, 0)).toEqual([encode(1 - height), 0, encode(height)]);
  });

  it("HeightLerp reads its pins by position when the dump names them Input0 to Input4, as the Spruce dump does", async () => {
    const positional: Raw[] = [
      node("hl", "FunctionCall", {
        inputs: { Input0: pin("a"), Input1: pin("b"), Input2: pin("phase"), Input3: pin("height", 0, [1, 0, 0, 0]), Input4: pin("contrast") },
        function: HEIGHT_LERP,
        outputNames: ["Results", "Alpha", "Lerp Alpha No Contrast"],
      }),
      constant3("a", [1, 0, 0]),
      constant3("b", [0, 0, 1]),
      node("phase", "Constant", { constants: { R: 0.5 } }),
      textureSample("height", "T_Height", "Masks"),
      node("contrast", "Constant", { constants: { R: 0 } }),
    ];
    const result = await bake(makeGraph(positional, pin("hl", 0, RGB_MASK)), await heightMap());
    expect(result.status).toBe("baked");
    const pixel = await pixelsOf(result);
    for (const [x, height] of [[0, 64 / 255], [1, 1]] as const) expect(pixel(x, 0)).toEqual([encode(1 - height), 0, encode(height)]);
  });

  it("HeightLerp Alpha output (index 1) applies CheapContrast to the height, as the CheapContrast node does", async () => {
    const textures = await heightMap();
    const alpha = await pixelsOf(await bake(makeGraph(heightLerp(0.5, 0.2), pin("hl", 1)), textures));
    const cheap = await pixelsOf(
      await bake(
        makeGraph(
          [engineCall("cc", "CheapContrast", { In: pin("height", 0, RGB_MASK), Contrast: pin("contrast") }), textureSample("height", "T_Height", "Masks"), node("contrast", "Constant", { constants: { R: 0.2 } })],
          pin("cc", 0, RGB_MASK),
        ),
        textures,
      ),
    );
    // Contrast 0.2 keeps the dark column between the clamps, so the stretch is exercised (1.5 would clamp both columns to 0 and 1).
    expect(alpha(0, 0)[0]).not.toBe(alpha(1, 0)[0]);
    for (const x of [0, 1]) expect(alpha(x, 0)).toEqual(cheap(x, 0));
  });

  it("HeightLerp Lerp Alpha No Contrast output (index 2) is the raw height whatever the contrast", async () => {
    const result = await bake(makeGraph(heightLerp(0.5, 1.5), pin("hl", 2)), await heightMap());
    expect(result.status).toBe("baked");
    const pixel = await pixelsOf(result);
    expect(pixel(0, 0)).toEqual([encode(64 / 255), encode(64 / 255), encode(64 / 255)]);
    expect(pixel(1, 0)).toEqual([255, 255, 255]);
  });

  it("HeightLerp at a Transition Phase other than 0.5 stays unsupported", async () => {
    const result = await bake(makeGraph(heightLerp(0.3, 0), pin("hl", 0, RGB_MASK)), await heightMap());
    expect(result).toMatchObject({ status: "unsupported", unsupported: expect.arrayContaining([expect.stringMatching(/^HeightLerp/)]) });
  });

  it("HeightLerp Alpha evaluates without A or B, so an unsupported node wired to them is not reported", async () => {
    const textures = await heightMap();
    const clean = await pixelsOf(await bake(makeGraph(heightLerp(0.5, 0.2), pin("hl", 1)), textures));
    const gated = await bake(makeGraph(heightLerpFed({ a: "gate", b: "gate", contrast: "contrast" }), pin("hl", 1)), textures);
    expect(gated).toMatchObject({ status: "baked" });
    const pixel = await pixelsOf(gated);
    for (const x of [0, 1]) expect(pixel(x, 0)).toEqual(clean(x, 0));
  });

  it("HeightLerp Lerp Alpha No Contrast evaluates without A, B or Contrast", async () => {
    const result = await bake(makeGraph(heightLerpFed({ a: "gate", b: "gate", contrast: "gate" }), pin("hl", 2)), await heightMap());
    expect(result.status).toBe("baked");
    const pixel = await pixelsOf(result);
    expect(pixel(0, 0)).toEqual([encode(64 / 255), encode(64 / 255), encode(64 / 255)]);
    expect(pixel(1, 0)).toEqual([255, 255, 255]);
  });

  it("HeightLerp Results and Alpha still report an unsupported node on a pin they read", async () => {
    const textures = await heightMap();
    const results = await bake(makeGraph(heightLerpFed({ a: "gate", b: "b", contrast: "contrast" }), pin("hl", 0, RGB_MASK)), textures);
    const alpha = await bake(makeGraph(heightLerpFed({ a: "a", b: "b", contrast: "gate" }), pin("hl", 1)), textures);
    expect(results).toMatchObject({ status: "unsupported", unsupported: expect.arrayContaining(["SmoothThreshold"]) });
    expect(alpha).toMatchObject({ status: "unsupported", unsupported: expect.arrayContaining(["SmoothThreshold"]) });
  });

  it("HeightLerp evaluates the pack's own body when it carries one, instead of the engine function", async () => {
    // A body on the called output wins: the engine's lerp of A and B is not evaluated, so the body's colour is what bakes.
    const call = node("hl", "FunctionCall", {
      inputs: { A: pin("a"), B: pin("b"), "Transition Phase": pin("phase"), "Height Texture": pin("height", 0, [1, 0, 0, 0]), Contrast: pin("contrast") },
      function: HEIGHT_LERP,
      outputNames: ["Results", "Alpha", "Lerp Alpha No Contrast"],
      fn: { inputs: {}, outputs: ["hl/body"], output: "hl/body", outputNames: [""] },
    });
    const graph = makeGraph([call, constant3("hl/body", [0.25, 0.5, 0.75]), ...heightLerp(0.5, 0).slice(1)], pin("hl", 0, RGB_MASK));
    const result = await bake(graph, await heightMap());
    expect(result.status).toBe("baked");
    const pixel = await pixelsOf(result);
    expect(pixel(0, 0)).toEqual([encode(0.25), encode(0.5), encode(0.75)]);
  });

  it("HeightLerp from a pack or another engine path with no body is unsupported, not the engine's lerp", async () => {
    for (const reference of ["/Game/Custom/HeightLerp.HeightLerp", "/Engine/Custom/Texturing/HeightLerp.HeightLerp"]) {
      const result = await bake(makeGraph(heightLerp(0.5, 0, reference), pin("hl", 0, RGB_MASK)), await heightMap());
      expect(result, reference).toMatchObject({ status: "unsupported", unsupported: expect.arrayContaining([expect.stringMatching(/^HeightLerp/)]) });
    }
  });

  it("HeightLerp from a pack body that lacks the requested output is unsupported, not the engine's lerp", async () => {
    // The body has Results only. Results bakes from it; Alpha is the pack's to define, so the engine's Alpha does not stand in for it.
    const withBodyOnResults = (): Raw[] => [
      node("hl", "FunctionCall", {
        inputs: { A: pin("a"), B: pin("b"), "Transition Phase": pin("phase"), "Height Texture": pin("height", 0, [1, 0, 0, 0]), Contrast: pin("contrast") },
        function: "/Game/Custom/HeightLerp.HeightLerp",
        outputNames: ["Results", "Alpha", "Lerp Alpha No Contrast"],
        fn: { inputs: {}, outputs: ["hl/body", null, null], output: "hl/body", outputNames: ["Results", "Alpha", "Lerp Alpha No Contrast"] },
      }),
      constant3("hl/body", [0.25, 0.5, 0.75]),
      ...heightLerp(0.5, 0).slice(1),
    ];
    const results = await bake(makeGraph(withBodyOnResults(), pin("hl", 0, RGB_MASK)), await heightMap());
    expect(results.status).toBe("baked");
    const pixel = await pixelsOf(results);
    expect(pixel(0, 0)).toEqual([encode(0.25), encode(0.5), encode(0.75)]);
    const alpha = await bake(makeGraph(withBodyOnResults(), pin("hl", 1)), await heightMap());
    expect(alpha).toMatchObject({ status: "unsupported", unsupported: expect.arrayContaining([expect.stringMatching(/^HeightLerp/)]) });
  });

  it("HeightLerp recognizes the engine's reference in Unreal's MaterialFunction export form", async () => {
    const textures = await heightMap();
    const plain = await pixelsOf(await bake(makeGraph(heightLerp(0.5, 0), pin("hl", 0, RGB_MASK)), textures));
    const exported = await bake(makeGraph(heightLerp(0.5, 0, `MaterialFunction'${HEIGHT_LERP}'`), pin("hl", 0, RGB_MASK)), textures);
    expect(exported.status).toBe("baked");
    const pixel = await pixelsOf(exported);
    for (const x of [0, 1]) expect(pixel(x, 0)).toEqual(plain(x, 0));
  });

  it("SmoothThreshold stays unsupported (no public definition available)", async () => {
    const graph = makeGraph(
      [node("st", "FunctionCall", { inputs: { Input: pin("height", 0, RGB_MASK) }, function: SMOOTH_THRESHOLD }), textureSample("height", "T_Height", "Masks")],
      pin("st"),
    );
    expect(await bake(graph)).toMatchObject({ status: "unsupported", unsupported: expect.arrayContaining(["SmoothThreshold"]) });
  });

  it("graphPathTextures reports no textures when the BaseColor path reads an unsupported node", () => {
    // Positive control first: a readable path names its texture, so the undefined below comes from the unsupported node.
    expect(graphPathTextures(makeGraph([textureSample("bark", "T_Bark")], pin("bark", 0, RGB_MASK)))).toEqual(["T_Bark"]);
    const blocked = makeGraph(
      [multiply("m", pin("bark", 0, RGB_MASK), pin("st")), textureSample("bark", "T_Bark"), node("st", "FunctionCall", { function: SMOOTH_THRESHOLD })],
      pin("m", 0, RGB_MASK),
    );
    expect(graphPathTextures(blocked)).toBeUndefined();
  });

  it("supportedEngineFunctions lists HeightLerp", () => {
    expect(supportedEngineFunctions()).toContain("HeightLerp");
    expect(supportedEngineFunctions()).not.toContain("SmoothThreshold");
  });
});
