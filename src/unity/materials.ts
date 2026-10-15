/**
 * Unity `.mat` to glTF PBR. Pure: it reads the parsed material and describes the glTF material
 * (factors, texture recipes, alpha mode); `textures.ts` makes the pixels and `gltf-materials.ts` writes them.
 *
 * The mapping follows the shader property meanings in the Unity manuals and the structure of
 * KhronosGroup/UnityGLTF `ExporterMaterials.cs` (MIT): `_MainTex`/`_BaseMap` colour, roughness = 1 - smoothness,
 * `_GlossMapScale`, smoothness from the albedo alpha, `_Mode`/`_Surface` alpha. No code is copied.
 * Shader GUIDs and property names are facts about the shaders. Assumptions worth knowing:
 *  - Colour properties are stored the way the colour picker shows them (gamma) and the project is in linear
 *    colour space, so every colour is converted sRGB to linear. Alpha is not converted.
 *  - The Standard shader is `fileID` 46 (and 45 for the Specular setup) inside the built-in extra resources.
 *    Unverified on a real pack: the ledger says so.
 *  - Specular setup becomes metallic 0 plus KHR_materials_specular with `specularColor = F0 / 0.04`, because
 *    glTF's dielectric F0 is `0.04 * specularColor`. glTF already splits energy between diffuse and specular.
 */
import type { ImageRecipe, ChannelRead, TextureSettings } from "./textures.js";
import { BUILTIN_EXTRA_RESOURCES_GUID, type UnityDocument, type UnityRef, asUnityRef } from "./yaml.js";

export type ShaderPipeline =
  | "standard"
  | "standard-specular"
  | "urp-lit"
  | "urp-simplelit"
  | "urp-complexlit"
  | "hdrp-lit";

export const SHADER_GUIDS: Readonly<Record<string, ShaderPipeline>> = {
  "933532a4fcc9baf4fa0491de14d08ed7": "urp-lit",
  "8d2bb70cbf9db8d4da26e15b26e74248": "urp-simplelit",
  ee7e4c9a5f6364b688a332c67fc32cca: "urp-complexlit",
  "6e4ae4064600d784cac1e41a9e6f2e59": "hdrp-lit",
};
const STANDARD_FILE_ID = "46";
const STANDARD_SPECULAR_FILE_ID = "45";

export type Rgba = readonly [number, number, number, number];
export interface UvTransform {
  readonly scale: readonly [number, number];
  readonly offset: readonly [number, number];
}
interface TexEnv {
  readonly ref: UnityRef | undefined;
  readonly scale: readonly [number, number];
  readonly offset: readonly [number, number];
}

export interface UnityMaterial {
  readonly name: string;
  readonly shader: UnityRef | undefined;
  /** False when the file lists no keywords at all (then emission is judged by its colour). */
  readonly keywordsKnown: boolean;
  readonly keywords: ReadonlySet<string>;
  readonly floats: Readonly<Record<string, number>>;
  readonly colors: Readonly<Record<string, Rgba>>;
  readonly textures: Readonly<Record<string, TexEnv>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pair(value: unknown, fallback: readonly [number, number]): readonly [number, number] {
  if (!isRecord(value)) return fallback;
  const x = Number(value.x);
  const y = Number(value.y);
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : fallback;
}

const channel = (value: unknown, fallback: number): number => {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) ? number : fallback;
};

/** `m_SavedProperties` lists are sequences of one-key maps. */
function entries(list: unknown): [string, unknown][] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) => (isRecord(item) ? Object.entries(item) : []));
}

/** Reads the `Material` document of a `.mat` file. Returns undefined when there is none. */
export function readMaterial(documents: readonly UnityDocument[], fallbackName: string): UnityMaterial | undefined {
  const document = documents.find((candidate) => candidate.classId === 21 || candidate.typeName === "Material");
  if (!document) return undefined;
  const fields = document.fields;
  const saved = isRecord(fields.m_SavedProperties) ? fields.m_SavedProperties : {};
  const floats: Record<string, number> = {};
  for (const [key, value] of [...entries(saved.m_Floats), ...entries(saved.m_Ints)]) {
    if (typeof value === "number" && Number.isFinite(value)) floats[key] = value;
  }
  const colors: Record<string, Rgba> = {};
  for (const [key, value] of entries(saved.m_Colors)) {
    // YAML `.nan` and `.inf` parse as numbers; a non-finite channel takes its default instead of reaching a glTF factor.
    if (isRecord(value)) colors[key] = [channel(value.r, 0), channel(value.g, 0), channel(value.b, 0), channel(value.a, 1)];
  }
  const textures: Record<string, TexEnv> = {};
  for (const [key, value] of entries(saved.m_TexEnvs)) {
    if (!isRecord(value)) continue;
    const ref = asUnityRef(value.m_Texture);
    textures[key] = {
      ref: ref && !(ref.fileID === "0" && (ref.guid === undefined || /^0+$/.test(ref.guid))) ? ref : undefined,
      scale: pair(value.m_Scale, [1, 1]),
      offset: pair(value.m_Offset, [0, 0]),
    };
  }
  const keywords = new Set<string>();
  const shaderKeywords = fields.m_ShaderKeywords;
  if (typeof shaderKeywords === "string") for (const word of shaderKeywords.split(/\s+/)) if (word) keywords.add(word);
  const valid = fields.m_ValidKeywords;
  if (Array.isArray(valid)) for (const word of valid) if (typeof word === "string") keywords.add(word);
  return {
    name: typeof fields.m_Name === "string" && fields.m_Name !== "" ? fields.m_Name : fallbackName,
    shader: asUnityRef(fields.m_Shader),
    keywordsKnown: "m_ShaderKeywords" in fields || "m_ValidKeywords" in fields,
    keywords,
    floats,
    colors,
    textures,
  };
}

// ---------------------------------------------------------------- shader identity

export interface ShaderIdentity {
  readonly pipeline?: ShaderPipeline;
  /** `<guid>/<fileID>`, or `builtin/<fileID>`: the reference the report prints. */
  readonly ref: string;
  /** Project path when the shader is a file of the package (a Shader Graph, a custom shader). */
  readonly path?: string;
}

export function identifyShader(ref: UnityRef | undefined, pathOf: (guid: string) => string | undefined): ShaderIdentity {
  if (!ref) return { ref: "none" };
  if (ref.guid === BUILTIN_EXTRA_RESOURCES_GUID) {
    const pipeline = ref.fileID === STANDARD_FILE_ID ? "standard" : ref.fileID === STANDARD_SPECULAR_FILE_ID ? "standard-specular" : undefined;
    return { ...(pipeline ? { pipeline } : {}), ref: `builtin/${ref.fileID}` };
  }
  const label = `${ref.guid ?? "local"}/${ref.fileID}`;
  const pipeline = ref.guid === undefined ? undefined : SHADER_GUIDS[ref.guid];
  const path = ref.guid === undefined ? undefined : pathOf(ref.guid);
  return { ...(pipeline ? { pipeline } : {}), ref: label, ...(path ? { path } : {}) };
}

// ---------------------------------------------------------------- resolution

export interface TextureBinding {
  readonly guid: string;
  readonly path: string;
  readonly settings: TextureSettings;
}
/** A texture reference becomes a binding, `"missing"` when the package lacks it, or undefined for none. */
export type TextureLookup = (ref: UnityRef | undefined) => TextureBinding | "missing" | undefined;

export interface TextureSlot {
  readonly recipe: ImageRecipe;
  readonly transform?: UvTransform;
  /** Unity texture guids the image is built from. */
  readonly sources: readonly string[];
}

export interface ResolvedMaterial {
  readonly name: string;
  readonly status: "mapped" | "fallback";
  readonly pipeline: ShaderPipeline | "fallback";
  readonly shader: { readonly ref: string; readonly path?: string };
  readonly fallbackReason?: string;
  readonly baseColorFactor: readonly [number, number, number, number];
  readonly baseColor?: TextureSlot;
  readonly metallicFactor: number;
  readonly roughnessFactor: number;
  readonly metallicRoughness?: TextureSlot;
  readonly normal?: TextureSlot & { readonly scale: number };
  readonly occlusion?: TextureSlot & { readonly strength: number };
  readonly emissiveFactor: readonly [number, number, number];
  readonly emissiveStrength?: number;
  readonly emissive?: TextureSlot;
  readonly specular?: { readonly colorFactor: readonly [number, number, number]; readonly colorTexture?: TextureSlot };
  readonly alphaMode: "OPAQUE" | "MASK" | "BLEND";
  readonly alphaCutoff?: number;
  readonly doubleSided: boolean;
  /** Assigned textures and non-default features the mapping does not carry. */
  readonly ignored: readonly string[];
  /** Features Unity applies that this importer cannot reproduce at all (for example convertToNormalMap). */
  readonly unsupported: readonly string[];
  readonly warnings: readonly string[];
}

export const srgbToLinear = (value: number): number =>
  value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;

const linearRgb = (color: Rgba): [number, number, number] => [srgbToLinear(color[0]), srgbToLinear(color[1]), srgbToLinear(color[2])];
const round = (value: number): number => Math.round(value * 1e6) / 1e6;

/** Unity UVs have V up, glTF V down: `v' = v * sy + (1 - sy - oy)`. Undefined for the identity. */
function uvTransform(env: TexEnv | undefined): UvTransform | undefined {
  if (!env) return undefined;
  const [sx, sy] = env.scale;
  const transform: UvTransform = { scale: [round(sx), round(sy)], offset: [round(env.offset[0]), round(1 - sy - env.offset[1])] };
  const identity = transform.scale[0] === 1 && transform.scale[1] === 1 && transform.offset[0] === 0 && transform.offset[1] === 0;
  return identity ? undefined : transform;
}

interface Resolver {
  readonly material: UnityMaterial;
  readonly lookup: TextureLookup;
  readonly warnings: string[];
  readonly unsupported: string[];
  readonly used: Set<string>;
  float(name: string, fallback: number): number;
  has(name: string): boolean;
  color(name: string): Rgba | undefined;
  /** The binding for a texture property, with a warning when the package lacks the file. */
  texture(name: string): TextureBinding | undefined;
}

function makeResolver(material: UnityMaterial, lookup: TextureLookup): Resolver {
  const warnings: string[] = [];
  const used = new Set<string>();
  return {
    material,
    lookup,
    warnings,
    unsupported: [],
    used,
    float: (name, fallback) => material.floats[name] ?? fallback,
    has: (name) => name in material.floats,
    color: (name) => material.colors[name],
    texture(name) {
      const env = material.textures[name];
      if (!env?.ref) return undefined;
      const found = lookup(env.ref);
      if (found === "missing") {
        warnings.push(`${name} refers to a texture that is not in the package`);
        return undefined;
      }
      if (found) used.add(name);
      return found;
    },
  };
}

const read = (binding: TextureBinding, channel: ChannelRead["channel"], min = 0, max = 1): ChannelRead => ({
  texture: binding.guid,
  channel,
  min,
  max,
});

interface Surface {
  baseColorProp: string;
  baseMapProp: string;
}

function resolveMapped(material: UnityMaterial, identity: ShaderIdentity, pipeline: ShaderPipeline, lookup: TextureLookup): ResolvedMaterial {
  const r = makeResolver(material, lookup);
  const hdrp = pipeline === "hdrp-lit";
  const urp = pipeline.startsWith("urp");
  const standard = pipeline === "standard" || pipeline === "standard-specular";
  const surface: Surface = hdrp
    ? { baseColorProp: "_BaseColor", baseMapProp: "_BaseColorMap" }
    : urp
      ? { baseColorProp: "_BaseColor", baseMapProp: "_BaseMap" }
      : { baseColorProp: "_Color", baseMapProp: "_MainTex" };

  // Base colour. URP packages written by older URP versions keep only the legacy names.
  const baseMapName = urp && !material.textures._BaseMap?.ref && material.textures._MainTex?.ref ? "_MainTex" : surface.baseMapProp;
  const baseColorName = urp && !material.colors._BaseColor && material.colors._Color ? "_Color" : surface.baseColorProp;
  const albedo = r.texture(baseMapName);
  const tint = r.color(baseColorName) ?? [1, 1, 1, 1];
  const rgb = linearRgb(tint);

  const slots: Record<string, TextureSlot> = {};
  const stSource = material.textures[baseMapName]?.ref
    ? material.textures[baseMapName]
    : Object.values(material.textures).find((env) => env.ref !== undefined);
  const transform = uvTransform(stSource);
  const slot = (recipe: ImageRecipe, sources: string[]): TextureSlot => ({ recipe, sources, ...(transform ? { transform } : {}) });

  // Alpha mode.
  let alphaMode: ResolvedMaterial["alphaMode"] = "OPAQUE";
  let alphaCutoff: number | undefined;
  if (standard) {
    const mode = r.has("_Mode")
      ? r.float("_Mode", 0)
      : material.keywords.has("_ALPHATEST_ON") ? 1 : material.keywords.has("_ALPHABLEND_ON") || material.keywords.has("_ALPHAPREMULTIPLY_ON") ? 3 : 0;
    if (mode === 1) {
      alphaMode = "MASK";
      alphaCutoff = r.float("_Cutoff", 0.5);
    } else if (mode >= 2) alphaMode = "BLEND";
  } else if (urp) {
    if (r.float("_Surface", 0) === 1) alphaMode = "BLEND";
    else if (r.float("_AlphaClip", 0) === 1) {
      alphaMode = "MASK";
      alphaCutoff = r.float("_Cutoff", 0.5);
    }
  } else if (r.float("_SurfaceType", 0) === 1) alphaMode = "BLEND";
  else if (r.float("_AlphaCutoffEnable", 0) === 1) {
    alphaMode = "MASK";
    alphaCutoff = r.float("_AlphaCutoff", 0.5);
  }
  const baseColor = albedo ? slot({ kind: "copy", texture: albedo.guid, role: "color" }, [albedo.guid]) : undefined;

  // Metallic and smoothness.
  let metallicFactor = 0;
  let roughnessFactor = 1;
  let metallicRoughness: TextureSlot | undefined;
  let occlusion: (TextureSlot & { strength: number }) | undefined;
  let specular: ResolvedMaterial["specular"];
  const specularWorkflow = pipeline === "standard-specular" || (urp && pipeline !== "urp-simplelit" && r.float("_WorkflowMode", 1) === 0);

  let metallicRead: ChannelRead | undefined;
  let smoothnessRead: ChannelRead | undefined;
  let metallicConstant = r.float("_Metallic", 0);
  let smoothnessConstant: number;
  if (hdrp) {
    const mask = r.texture("_MaskMap");
    smoothnessConstant = r.float("_Smoothness", 0.5);
    if (mask) {
      metallicRead = read(mask, "r", r.float("_MetallicRemapMin", 0), r.float("_MetallicRemapMax", 1));
      smoothnessRead = read(mask, "a", r.float("_SmoothnessRemapMin", 0), r.float("_SmoothnessRemapMax", 1));
      occlusion = {
        ...slot({ kind: "occlusion", read: read(mask, "g", r.float("_AORemapMin", 0), r.float("_AORemapMax", 1)) }, [mask.guid]),
        strength: 1,
      };
    }
    if (r.float("_MaterialID", 1) === 4) r.unsupported.push("_MaterialID 4 (specular colour material)");
  } else {
    const scaleName = standard ? "_GlossMapScale" : "_Smoothness";
    const scale = r.float(scaleName, standard ? 1 : 0.5);
    smoothnessConstant = standard ? r.float("_Glossiness", 0.5) : r.float("_Smoothness", 0.5);
    const albedoAlpha = standard
      ? r.float("_SmoothnessTextureChannel", 0) === 1 || material.keywords.has("_SMOOTHNESS_TEXTURE_ALBEDO_CHANNEL_A")
      : urp && (pipeline === "urp-simplelit" ? r.float("_GlossinessSource", 0) === 1 : r.float("_SmoothnessTextureChannel", 0) === 1);
    const gloss = r.texture(specularWorkflow || pipeline === "urp-simplelit" ? "_SpecGlossMap" : "_MetallicGlossMap");
    if (specularWorkflow || pipeline === "urp-simplelit") {
      metallicConstant = 0;
      const specColor = r.color("_SpecColor") ?? [0.2, 0.2, 0.2, 1];
      if (specularWorkflow) {
        const specLinear = linearRgb(specColor);
        specular = gloss
          ? { colorFactor: [25, 25, 25], colorTexture: slot({ kind: "copy", texture: gloss.guid, role: "color" }, [gloss.guid]) }
          : { colorFactor: [round(specLinear[0] / 0.04), round(specLinear[1] / 0.04), round(specLinear[2] / 0.04)] };
      } else {
        r.warnings.push("SimpleLit specular is Blinn-Phong; imported as a non-metal with roughness from smoothness");
      }
      if (gloss && !albedoAlpha) smoothnessRead = read(gloss, "a", 0, scale);
      else if (albedoAlpha) smoothnessRead = albedo ? read(albedo, "a", 0, scale) : undefined;
      if (albedoAlpha && !albedo) smoothnessConstant = scale;
    } else {
      if (gloss) metallicRead = read(gloss, "r");
      if (albedoAlpha) {
        if (albedo) smoothnessRead = read(albedo, "a", 0, scale);
        else smoothnessConstant = scale;
      } else if (gloss) smoothnessRead = read(gloss, "a", 0, scale);
    }
    const ao = r.texture("_OcclusionMap");
    if (ao) {
      occlusion = {
        ...slot({ kind: "occlusion", read: read(ao, "g") }, [ao.guid]),
        strength: r.float("_OcclusionStrength", 1),
      };
    }
  }
  if (metallicRead || smoothnessRead) {
    const recipe: ImageRecipe = {
      kind: "metallicRoughness",
      ...(metallicRead ? { metallic: metallicRead } : {}),
      metallicConstant,
      ...(smoothnessRead ? { smoothness: smoothnessRead } : {}),
      smoothnessConstant,
    };
    metallicRoughness = slot(recipe, [...new Set([metallicRead?.texture, smoothnessRead?.texture].filter((guid): guid is string => guid !== undefined))]);
    metallicFactor = 1;
    roughnessFactor = 1;
  } else {
    metallicFactor = round(metallicConstant);
    roughnessFactor = round(1 - smoothnessConstant);
  }

  // Normal map.
  let normal: (TextureSlot & { scale: number }) | undefined;
  const normalName = hdrp ? "_NormalMap" : "_BumpMap";
  const bump = r.texture(normalName);
  if (bump) {
    if (hdrp && r.float("_NormalMapSpace", 0) === 1) {
      r.unsupported.push("object-space normal map");
      r.used.delete(normalName);
    } else {
      normal = { ...slot({ kind: "copy", texture: bump.guid, role: "normal" }, [bump.guid]), scale: round(r.float(hdrp ? "_NormalScale" : "_BumpScale", 1)) };
    }
  }

  // Emission.
  let emissiveFactor: [number, number, number] = [0, 0, 0];
  let emissiveStrength: number | undefined;
  let emissive: TextureSlot | undefined;
  const emissionMapName = hdrp ? "_EmissiveColorMap" : "_EmissionMap";
  const emissionColor = hdrp ? (r.color("_EmissiveColorLDR") ?? r.color("_EmissiveColor")) : r.color("_EmissionColor");
  const emissionMap = r.texture(emissionMapName);
  // Unity multiplies the map by the colour, so a black colour is no emission even with a map assigned.
  const colorLit = emissionColor === undefined ? emissionMap !== undefined : emissionColor[0] > 0 || emissionColor[1] > 0 || emissionColor[2] > 0;
  const emissionOn = colorLit && (hdrp || !material.keywordsKnown || material.keywords.has("_EMISSION"));
  if (emissionOn) {
    const linear = emissionColor ? linearRgb(emissionColor) : ([1, 1, 1] as [number, number, number]);
    const peak = Math.max(...linear);
    if (peak > 1) emissiveStrength = round(peak);
    emissiveFactor = linear.map((value) => round(peak > 1 ? value / peak : value)) as [number, number, number];
    if (emissionMap) emissive = slot({ kind: "copy", texture: emissionMap.guid, role: "color" }, [emissionMap.guid]);
  } else r.used.delete(emissionMapName);
  if (hdrp && r.float("_EmissiveIntensity", 1) !== 1) r.warnings.push("HDRP _EmissiveIntensity (a luminance unit) is not applied");

  const doubleSided = urp ? r.float("_Cull", 2) === 0 : hdrp ? r.float("_DoubleSidedEnable", 0) === 1 : false;
  if (urp && pipeline === "urp-complexlit" && r.float("_ClearCoat", 0) > 0) r.unsupported.push("clear coat");

  const consumed = new Set(r.used);
  consumed.add(baseMapName);
  const ignored = Object.entries(material.textures)
    .filter(([name, env]) => env.ref !== undefined && !consumed.has(name) && !/^unity_|^_?(Lightmap|Dir|ShadowMask)/i.test(name) && !(name === "_MainTex" && urp))
    .map(([name]) => name);

  return {
    name: material.name,
    status: "mapped",
    pipeline,
    shader: { ref: identity.ref, ...(identity.path ? { path: identity.path } : {}) },
    baseColorFactor: [round(rgb[0]), round(rgb[1]), round(rgb[2]), alphaMode === "OPAQUE" ? 1 : round(tint[3])],
    ...(baseColor ? { baseColor } : {}),
    metallicFactor,
    roughnessFactor,
    ...(metallicRoughness ? { metallicRoughness } : {}),
    ...(normal ? { normal } : {}),
    ...(occlusion ? { occlusion } : {}),
    emissiveFactor,
    ...(emissiveStrength !== undefined ? { emissiveStrength } : {}),
    ...(emissive ? { emissive } : {}),
    ...(specular ? { specular } : {}),
    alphaMode,
    ...(alphaCutoff !== undefined ? { alphaCutoff: round(alphaCutoff) } : {}),
    doubleSided,
    ignored,
    unsupported: r.unsupported,
    warnings: r.warnings,
  };
}

/** Shader Graph, custom and unknown shaders: the saved colour and base texture, else neutral. */
function resolveFallback(material: UnityMaterial, identity: ShaderIdentity, reason: string, lookup: TextureLookup): ResolvedMaterial {
  const r = makeResolver(material, lookup);
  const colorName = material.colors._BaseColor ? "_BaseColor" : "_Color";
  const tint = material.colors[colorName] ?? ([1, 1, 1, 1] as Rgba);
  const mapName = (["_BaseMap", "_MainTex", "_BaseColorMap", "_Albedo"] as const).find((name) => material.textures[name]?.ref !== undefined);
  const binding = mapName ? r.texture(mapName) : undefined;
  const transform = mapName ? uvTransform(material.textures[mapName]) : undefined;
  const rgb = linearRgb(tint);
  const ignored = Object.entries(material.textures)
    .filter(([name, env]) => env.ref !== undefined && name !== mapName)
    .map(([name]) => name);
  return {
    name: material.name,
    status: "fallback",
    pipeline: "fallback",
    shader: { ref: identity.ref, ...(identity.path ? { path: identity.path } : {}) },
    fallbackReason: reason,
    baseColorFactor: [round(rgb[0]), round(rgb[1]), round(rgb[2]), 1],
    ...(binding
      ? { baseColor: { recipe: { kind: "copy" as const, texture: binding.guid, role: "color" as const }, sources: [binding.guid], ...(transform ? { transform } : {}) } }
      : {}),
    metallicFactor: 0,
    roughnessFactor: 1,
    emissiveFactor: [0, 0, 0],
    alphaMode: "OPAQUE",
    doubleSided: false,
    ignored,
    unsupported: [],
    warnings: r.warnings,
  };
}

export function resolveMaterial(material: UnityMaterial, identity: ShaderIdentity, lookup: TextureLookup): ResolvedMaterial {
  if (identity.pipeline) return resolveMapped(material, identity, identity.pipeline, lookup);
  const what = identity.path ?? identity.ref;
  const reason = material.shader
    ? `shader ${what} is not Standard, URP Lit/SimpleLit/ComplexLit or HDRP Lit`
    : "the material has no shader reference";
  return resolveFallback(material, identity, reason, lookup);
}
