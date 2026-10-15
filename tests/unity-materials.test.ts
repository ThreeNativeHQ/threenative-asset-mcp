import { describe, expect, it } from "vitest";

import { identifyShader, readMaterial, resolveMaterial, type ResolvedMaterial } from "../src/unity/materials.js";
import { type DecodedImage, type ImageRecipe, renderRecipe } from "../src/unity/textures.js";
import { parseUnityDocuments } from "../src/unity/yaml.js";
import { guidFor } from "./helpers/unity-fixtures.js";
import { DEFAULT_TEXTURE, SHADERS, type MaterialSpec, materialYaml, textureLookup } from "./helpers/unity-models.js";

function resolve(
  spec: MaterialSpec,
  known: Parameters<typeof textureLookup>[0] = {},
  shaderPaths: Record<string, string> = {},
): ResolvedMaterial {
  const material = readMaterial(parseUnityDocuments(materialYaml(spec)), spec.name);
  if (!material) throw new Error("no material");
  return resolveMaterial(material, identifyShader(material.shader, (guid) => shaderPaths[guid]), textureLookup(known));
}

/** A 1x1 image with the given RGBA, keyed by the texture's project path. */
function pixel(...rgba: [number, number, number, number]): DecodedImage {
  return { width: 1, height: 1, data: Buffer.from(rgba) };
}

async function render(recipe: ImageRecipe, images: Record<string, DecodedImage>): Promise<[number, number, number, number]> {
  const byGuid = new Map(Object.entries(images).map(([path, image]) => [guidFor(path), image]));
  const out = await renderRecipe(recipe, {
    load: async (guid) => byGuid.get(guid)!,
    settings: () => DEFAULT_TEXTURE,
  });
  return [out.data[0]!, out.data[1]!, out.data[2]!, out.data[3]!];
}

const ALBEDO = "Assets/T/albedo.png";
const MASK = "Assets/T/mask.png";
const NORMAL = "Assets/T/normal.png";
const AO = "Assets/T/ao.png";
const EMISSIVE = "Assets/T/emissive.png";

describe("non-finite material values", () => {
  it("drops YAML .nan and .inf floats and colour channels instead of passing them to the glTF factors", () => {
    const yaml = materialYaml({ name: "bad", shader: SHADERS.standard, floats: { _Metallic: 0.5, _Glossiness: 0.25 }, colors: { _Color: [0.5, 0.5, 0.5, 1] } })
      .replace("_Metallic: 0.5", "_Metallic: .nan")
      .replace("_Glossiness: 0.25", "_Glossiness: .inf")
      .replace(/r: 0\.5/, "r: .nan")
      .replace(/a: 1\b/, "a: -.inf");
    expect(yaml).toMatch(/\.nan[\s\S]*\.inf/);
    const material = readMaterial(parseUnityDocuments(yaml), "bad")!;
    expect(material.floats).toEqual({});
    expect(material.colors._Color).toEqual([0, 0.5, 0.5, 1]);
    const resolved = resolveMaterial(material, identifyShader(material.shader, () => undefined), textureLookup({}));
    for (const value of [resolved.metallicFactor, resolved.roughnessFactor, ...resolved.baseColorFactor, ...resolved.emissiveFactor]) expect(Number.isFinite(value)).toBe(true);
  });
});

describe("standard shader materials", () => {
  it("maps the metallic setup factors, with colours converted from sRGB to linear", () => {
    const material = resolve({
      name: "plain",
      shader: SHADERS.standard,
      floats: { _Metallic: 0.8, _Glossiness: 0.25, _Mode: 0 },
      colors: { _Color: [0.5, 1, 0, 0.5] },
    });
    expect(material).toMatchObject({ status: "mapped", pipeline: "standard", metallicFactor: 0.8, roughnessFactor: 0.75, alphaMode: "OPAQUE", doubleSided: false });
    expect(material.baseColorFactor[0]).toBeCloseTo(0.214, 3);
    expect(material.baseColorFactor.slice(1)).toEqual([1, 0, 1]);
    expect(material.metallicRoughness).toBeUndefined();
  });

  it("packs the metallic map (R) and smoothness (A x _GlossMapScale) into a glTF metallic-roughness image", async () => {
    const material = resolve(
      { name: "mr", shader: SHADERS.standard, floats: { _GlossMapScale: 0.5 }, textures: { _MainTex: ALBEDO, _MetallicGlossMap: MASK } },
      { [ALBEDO]: {}, [MASK]: {} },
    );
    expect(material).toMatchObject({ metallicFactor: 1, roughnessFactor: 1 });
    expect(material.baseColor?.recipe).toMatchObject({ kind: "copy", role: "color" });
    const [, g, b] = await render(material.metallicRoughness!.recipe, { [MASK]: pixel(200, 0, 0, 204), [ALBEDO]: pixel(1, 2, 3, 4) });
    expect(b).toBe(200); // metallic from R
    expect(g).toBe(Math.round((1 - (204 / 255) * 0.5) * 255)); // roughness = 1 - smoothness
  });

  it("takes smoothness from the albedo alpha when _SmoothnessTextureChannel is 1", async () => {
    const material = resolve(
      { name: "alpha", shader: SHADERS.standard, floats: { _SmoothnessTextureChannel: 1, _GlossMapScale: 1, _Metallic: 0.5 }, textures: { _MainTex: ALBEDO } },
      { [ALBEDO]: {} },
    );
    const recipe = material.metallicRoughness!.recipe;
    expect(recipe).toMatchObject({ kind: "metallicRoughness", smoothness: { texture: guidFor(ALBEDO), channel: "a" }, metallicConstant: 0.5 });
    const [, g, b] = await render(recipe, { [ALBEDO]: pixel(9, 9, 9, 51) });
    expect([g, b]).toEqual([Math.round(0.8 * 255), 128]);
  });

  it("maps _Mode to the glTF alpha mode: cutout to MASK with _Cutoff, fade and transparent to BLEND", () => {
    const cutout = resolve({ name: "cut", shader: SHADERS.standard, floats: { _Mode: 1, _Cutoff: 0.3 }, colors: { _Color: [1, 1, 1, 0.4] } });
    expect(cutout).toMatchObject({ alphaMode: "MASK", alphaCutoff: 0.3 });
    for (const mode of [2, 3]) {
      const blended = resolve({ name: "blend", shader: SHADERS.standard, floats: { _Mode: mode }, colors: { _Color: [1, 1, 1, 0.5] } });
      expect(blended).toMatchObject({ alphaMode: "BLEND" });
      expect(blended.baseColorFactor[3]).toBe(0.5);
    }
    expect(resolve({ name: "kw", shader: SHADERS.standard, keywords: "_ALPHATEST_ON" })).toMatchObject({ alphaMode: "MASK", alphaCutoff: 0.5 });
  });

  it("converts the specular setup to metallic 0 with KHR_materials_specular", async () => {
    const plain = resolve({
      name: "spec",
      shader: SHADERS.standardSpecular,
      floats: { _Glossiness: 0.7 },
      colors: { _SpecColor: [0.5, 0.5, 0.5, 1] },
    });
    expect(plain).toMatchObject({ pipeline: "standard-specular", metallicFactor: 0, roughnessFactor: 0.3 });
    expect(plain.specular?.colorFactor[0]).toBeCloseTo(0.214 / 0.04, 2);
    const mapped = resolve(
      { name: "specmap", shader: SHADERS.standardSpecular, floats: { _GlossMapScale: 1 }, textures: { _SpecGlossMap: MASK } },
      { [MASK]: {} },
    );
    expect(mapped.specular?.colorTexture?.recipe).toMatchObject({ kind: "copy", role: "color" });
    expect(mapped.specular?.colorFactor).toEqual([25, 25, 25]);
    const [, g] = await render(mapped.metallicRoughness!.recipe, { [MASK]: pixel(255, 255, 255, 102) });
    expect(g).toBe(Math.round(0.6 * 255)); // smoothness from the spec map's alpha
  });

  it("maps the normal, occlusion and emission slots and the base map's tiling", () => {
    const material = resolve(
      {
        name: "full",
        shader: SHADERS.standard,
        keywords: "_EMISSION _NORMALMAP",
        floats: { _BumpScale: 0.7, _OcclusionStrength: 0.4 },
        colors: { _EmissionColor: [4, 2, 1, 1] },
        textures: { _MainTex: { path: ALBEDO, scale: [2, 3], offset: [0.25, 0.5] }, _BumpMap: NORMAL, _OcclusionMap: AO, _EmissionMap: EMISSIVE, _DetailAlbedoMap: AO },
      },
      { [ALBEDO]: {}, [NORMAL]: { normalMap: true }, [AO]: {}, [EMISSIVE]: {} },
    );
    expect(material.normal).toMatchObject({ scale: 0.7, recipe: { kind: "copy", role: "normal" } });
    expect(material.occlusion).toMatchObject({ strength: 0.4, recipe: { kind: "occlusion", read: { channel: "g" } } });
    expect(material.emissive?.recipe).toMatchObject({ kind: "copy", texture: guidFor(EMISSIVE) });
    expect(material.emissiveStrength).toBeGreaterThan(1); // an HDR colour keeps its intensity
    expect(Math.max(...material.emissiveFactor)).toBe(1);
    // glTF V runs down: v' = v * 3 + (1 - 3 - 0.5)
    expect(material.baseColor?.transform).toEqual({ scale: [2, 3], offset: [0.25, -2.5] });
    expect(material.normal?.transform).toEqual(material.baseColor?.transform);
    expect(material.ignored).toEqual(["_DetailAlbedoMap"]);
  });

  it("applies no emission when the _EMISSION keyword is off, even with a colour set", () => {
    const material = resolve({ name: "off", shader: SHADERS.standard, keywords: "", colors: { _EmissionColor: [1, 1, 1, 1] } });
    expect(material.emissiveFactor).toEqual([0, 0, 0]);
  });

  it("warns about a texture the package does not hold and leaves the slot empty", () => {
    const material = resolve({ name: "gone", shader: SHADERS.standard, textures: { _MainTex: ALBEDO } }, {});
    expect(material.baseColor).toBeUndefined();
    expect(material.warnings).toEqual(["_MainTex refers to a texture that is not in the package"]);
  });
});

describe("pipelines: URP and HDRP materials", () => {
  it("maps URP Lit with _BaseMap, _Smoothness, the surface type and the cull mode", async () => {
    const material = resolve(
      {
        name: "urp",
        shader: SHADERS.urpLit,
        floats: { _WorkflowMode: 1, _Metallic: 0.3, _Smoothness: 0.6, _Surface: 1, _Cull: 0, _SmoothnessTextureChannel: 1 },
        colors: { _BaseColor: [1, 1, 1, 0.5] },
        textures: { _BaseMap: ALBEDO },
      },
      { [ALBEDO]: {} },
    );
    expect(material).toMatchObject({ pipeline: "urp-lit", alphaMode: "BLEND", doubleSided: true });
    expect(material.baseColor?.recipe).toMatchObject({ texture: guidFor(ALBEDO) });
    const [, g, b] = await render(material.metallicRoughness!.recipe, { [ALBEDO]: pixel(0, 0, 0, 255) });
    expect([g, b]).toEqual([Math.round(0.4 * 255), Math.round(0.3 * 255)]); // smoothness = albedo alpha x _Smoothness
  });

  it("maps URP Lit alpha clipping and its specular workflow", () => {
    const clipped = resolve({ name: "clip", shader: SHADERS.urpLit, floats: { _AlphaClip: 1, _Cutoff: 0.4, _Surface: 0 } });
    expect(clipped).toMatchObject({ alphaMode: "MASK", alphaCutoff: 0.4 });
    const specular = resolve({ name: "spec", shader: SHADERS.urpLit, floats: { _WorkflowMode: 0, _Smoothness: 0.5 }, colors: { _SpecColor: [1, 1, 1, 1] } });
    expect(specular).toMatchObject({ metallicFactor: 0, roughnessFactor: 0.5 });
    expect(specular.specular?.colorFactor).toEqual([25, 25, 25]);
  });

  it("maps URP SimpleLit and ComplexLit and reports clear coat as unsupported", () => {
    const simple = resolve({ name: "simple", shader: SHADERS.urpSimpleLit, floats: { _Smoothness: 0.2 }, colors: { _BaseColor: [1, 0, 0, 1] } });
    expect(simple).toMatchObject({ pipeline: "urp-simplelit", metallicFactor: 0, roughnessFactor: 0.8 });
    expect(simple.warnings.join(" ")).toMatch(/Blinn-Phong/);
    const complex = resolve({ name: "complex", shader: SHADERS.urpComplexLit, floats: { _ClearCoat: 1, _Metallic: 1 } });
    expect(complex).toMatchObject({ pipeline: "urp-complexlit", metallicFactor: 1, unsupported: ["clear coat"] });
  });

  it("splits the HDRP Lit mask map into a metallic-roughness image and an occlusion image", async () => {
    const material = resolve(
      {
        name: "hdrp",
        shader: SHADERS.hdrpLit,
        floats: { _MetallicRemapMin: 0, _MetallicRemapMax: 1, _SmoothnessRemapMin: 0, _SmoothnessRemapMax: 0.5, _AORemapMin: 0.5, _AORemapMax: 1, _NormalScale: 2, _DoubleSidedEnable: 1 },
        colors: { _BaseColor: [1, 1, 1, 1] },
        textures: { _BaseColorMap: ALBEDO, _MaskMap: MASK, _NormalMap: NORMAL },
      },
      { [ALBEDO]: {}, [MASK]: {}, [NORMAL]: { normalMap: true } },
    );
    expect(material).toMatchObject({ pipeline: "hdrp-lit", metallicFactor: 1, roughnessFactor: 1, doubleSided: true });
    expect(material.normal?.scale).toBe(2);
    const images = { [MASK]: pixel(51, 128, 255, 204) }; // R metallic, G occlusion, B detail mask, A smoothness
    expect(material.metallicRoughness?.recipe.kind).toBe("metallicRoughness");
    expect(material.occlusion?.recipe.kind).toBe("occlusion");
    const [, g, b] = await render(material.metallicRoughness!.recipe, images);
    expect([g, b]).toEqual([Math.round((1 - 0.8 * 0.5) * 255), 51]); // smoothness remapped to 0..0.5
    const [occlusion] = await render(material.occlusion!.recipe, images);
    expect(occlusion).toBe(Math.round((0.5 + 0.5 * (128 / 255)) * 255)); // AO remapped to 0.5..1
    expect(material.occlusion?.sources).toEqual([guidFor(MASK)]);
  });

  it("falls back to _Metallic and _Smoothness for an HDRP Lit material without a mask map", () => {
    const material = resolve({ name: "nomask", shader: SHADERS.hdrpLit, floats: { _Metallic: 0.9, _Smoothness: 0.1, _SurfaceType: 1 } });
    expect(material).toMatchObject({ metallicFactor: 0.9, roughnessFactor: 0.9, alphaMode: "BLEND" });
    expect(material.occlusion).toBeUndefined();
  });

  it("gives the same piece the same look in all three pipelines", () => {
    const params = { metallic: 0.6, smoothness: 0.35 };
    const standard = resolve({ name: "s", shader: SHADERS.standard, floats: { _Metallic: params.metallic, _Glossiness: params.smoothness }, colors: { _Color: [0.2, 0.4, 0.6, 1] } });
    const urp = resolve({ name: "u", shader: SHADERS.urpLit, floats: { _Metallic: params.metallic, _Smoothness: params.smoothness }, colors: { _BaseColor: [0.2, 0.4, 0.6, 1] } });
    const hdrp = resolve({ name: "h", shader: SHADERS.hdrpLit, floats: { _Metallic: params.metallic, _Smoothness: params.smoothness }, colors: { _BaseColor: [0.2, 0.4, 0.6, 1] } });
    for (const other of [urp, hdrp]) {
      expect(other.baseColorFactor).toEqual(standard.baseColorFactor);
      expect([other.metallicFactor, other.roughnessFactor]).toEqual([standard.metallicFactor, standard.roughnessFactor]);
    }
  });

  it("binds a height map marked convertToNormalMap as the normal texture (the image is converted when it is written)", () => {
    const material = resolve(
      { name: "height", shader: SHADERS.standard, textures: { _BumpMap: NORMAL } },
      { [NORMAL]: { convertToNormalMap: true } },
    );
    expect(material.normal).toBeDefined();
    expect(material.unsupported).toEqual([]);
  });
});

describe("fallback materials", () => {
  const GRAPH = "Assets/Shaders/water.shadergraph";

  it("keeps the saved colour and base texture of a Shader Graph material and records the shader", () => {
    const material = resolve(
      {
        name: "water",
        shader: { guid: guidFor(GRAPH), fileID: "-6465566751694194690" },
        colors: { _BaseColor: [1, 0, 0, 1] },
        textures: { _BaseMap: ALBEDO, _NoiseMap: AO },
      },
      { [ALBEDO]: {}, [AO]: {} },
      { [guidFor(GRAPH)]: GRAPH },
    );
    expect(material).toMatchObject({ status: "fallback", pipeline: "fallback", metallicFactor: 0, roughnessFactor: 1, alphaMode: "OPAQUE" });
    expect(material.shader).toEqual({ ref: `${guidFor(GRAPH)}/-6465566751694194690`, path: GRAPH });
    expect(material.fallbackReason).toContain(GRAPH);
    expect(material.baseColorFactor).toEqual([1, 0, 0, 1]);
    expect(material.baseColor?.recipe).toMatchObject({ kind: "copy", texture: guidFor(ALBEDO) });
    expect(material.ignored).toEqual(["_NoiseMap"]);
  });

  it("takes the base texture of a custom shader that names it _Albedo (a real U3 custom shader), and still records the fallback", () => {
    const material = resolve({ name: "custom", shader: { guid: guidFor("Assets/custom.shader"), fileID: "4800000" }, textures: { _Albedo: ALBEDO, _Specular: AO } }, { [ALBEDO]: {}, [AO]: {} });
    expect(material.status).toBe("fallback");
    expect(material.baseColor?.recipe).toMatchObject({ kind: "copy", texture: guidFor(ALBEDO) });
    expect(material.ignored).toEqual(["_Specular"]);
  });

  it("reads the legacy _Color and _MainTex names, and is neutral when the material has neither", () => {
    const legacy = resolve({ name: "legacy", shader: { guid: BUILTIN_OTHER, fileID: "7" }, colors: { _Color: [0, 1, 0, 1] }, textures: { _MainTex: ALBEDO } }, { [ALBEDO]: {} });
    expect(legacy).toMatchObject({ status: "fallback", shader: { ref: "builtin/7" }, baseColorFactor: [0, 1, 0, 1] });
    expect(legacy.baseColor).toBeDefined();
    const neutral = resolve({ name: "bare", shader: { guid: guidFor("Assets/custom.shader"), fileID: "4800000" } });
    expect(neutral).toMatchObject({ status: "fallback", baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 });
    expect(neutral.baseColor).toBeUndefined();
  });
});

const BUILTIN_OTHER = "0000000000000000f000000000000000";
