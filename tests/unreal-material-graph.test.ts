import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { materialGraphSchema, type MaterialGraph } from "../src/unreal/graph-dump.js";
import {
  bakeGraph,
  graphPathClasses,
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
      node("fuzzy", "FunctionCall", {
        inputs: { "Material Input": pin("bakedNormal") },
        function: "/Game/Test/MF_FuzzyShading_JM.MF_FuzzyShading_JM",
        outputNames: ["Result"],
        // Inlined like the real one, with a body the evaluator must NOT follow (it reads the camera vector).
        fn: { inputs: { "Material Input": "bakedNormal" }, outputs: ["fuzzy/make"], output: "fuzzy/make", outputNames: [""] },
      }),
      node("fuzzy/make", "MakeMaterialAttributes", { inputs: { BaseColor: pin("fuzzy/camera") } }),
      node("fuzzy/camera", "CameraVectorWS"),
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
    // The wrapped chain returns the same colours as the bare blend; the camera-vector body of fuzzy shading was not followed.
    const pixel = await pixelsOf(result);
    expect(pixel(3, 0)).toEqual([200, 0, 50]);
    expect(pixel(0, 3)).toEqual([142, 140, 132]);
  });

  it("names an engine function it does not know when that function is on the path", async () => {
    const graph = makeGraph(
      [
        node("break", "BreakMaterialAttributes", { inputs: { MaterialAttributes: pin("contrast") }, outputNames: ["BaseColor", "Metallic"] }),
        engineCall("contrast", "MatLayerBlend_Tint", { Input0: pin("make"), Input1: pin("amount") }),
        node("make", "MakeMaterialAttributes", { inputs: { BaseColor: pin("c") } }),
        constant3("c", [0.5, 0.5, 0.5]),
        node("amount", "Constant", { constants: { R: 0.2 } }),
      ],
      pin("break", 0, RGB_MASK),
    );
    const result = await bakeGraph({ graph, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: makeLoader({}).loadTexture, size: 2 });
    expect(result).toMatchObject({ status: "unsupported", unsupported: ["MatLayerBlend_Tint"] });
  });

  it("refuses a graph whose BaseColor needs another attribute of a Break node", async () => {
    const graph = makeGraph(
      [
        node("break", "BreakMaterialAttributes", { inputs: { MaterialAttributes: pin("make") }, outputNames: ["BaseColor", "Metallic", "Specular", "Roughness"] }),
        node("make", "MakeMaterialAttributes", { inputs: { BaseColor: pin("c"), Roughness: pin("c") } }),
        constant3("c", [0.5, 0.5, 0.5]),
      ],
      pin("break", 3, [1, 1, 1, 0]),
    );
    const result = await bakeGraph({ graph, output: "baseColor", parameters: NO_PARAMETERS, loadTexture: makeLoader({}).loadTexture, size: 2 });
    expect(result).toMatchObject({ status: "unsupported", unsupported: ["BreakMaterialAttributes.Roughness"] });
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
        engineCall("contrast", "MatLayerBlend_Tint", { Input0: pin("make") }),
        node("make", "MakeMaterialAttributes", { inputs: { BaseColor: pin("v") } }),
        node("v", "VertexColor"),
      ],
      pin("break", 0, RGB_MASK),
    );
    expect(graphPathClasses(graph, "baseColor")).toEqual(["BreakMaterialAttributes", "FunctionCall", "MakeMaterialAttributes", "MatLayerBlend_Tint", "VertexColor"]);
  });

  it("exposes the closed node set", () => {
    const supported = supportedNodeClasses();
    for (const name of ["TextureSample", "TextureSampleParameter2D", "LinearInterpolate", "FunctionCall", "StaticSwitch", "FeatureLevelSwitch"]) {
      expect(supported).toContain(name);
    }
    for (const name of ["VertexColor", "Panner", "Time", "WorldPosition", "Fresnel"]) expect(supported).not.toContain(name);
  });
});
