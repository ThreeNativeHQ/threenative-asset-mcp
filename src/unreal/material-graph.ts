import sharp from "sharp";
import type { GraphInput, GraphNode, MaterialGraph } from "./graph-dump.js";
import type { SurfaceNormals } from "./surface-normals.js";

/**
 * PRD-538 Phase 2a: evaluates the BaseColor output of a dumped Unreal material graph (see `graph-dump.ts`)
 * per texel and bakes it into an sRGB PNG that a glTF `baseColorTexture` can carry.
 *
 * How it works: the graph is compiled once into a flat list of instructions over a small register file
 * (4 floats per register). Subtrees that do not depend on the texel (parameters, constants, switches) are
 * folded at compile time; only texture samples, texture coordinates and the arithmetic that depends on them
 * run per texel. Nothing is allocated per node per texel. Only the BaseColor attribute of a
 * MaterialAttributes value is carried; the other attributes (roughness, normal, ...) are never evaluated,
 * so a path that needs one of them is reported as unsupported rather than guessed.
 *
 * Conventions (each is pinned by a test):
 * - Colour space: textures flagged `srgb: true` that are sampled with a `Color` sampler are decoded to
 *   linear before filtering and arithmetic, as the GPU does. Normal, Masks, Grayscale, LinearColor and
 *   every other sampler type are read as stored. The baked PNG is re-encoded to sRGB because glTF treats
 *   `baseColorTexture` as sRGB.
 * - Texture space: output pixel (x, y) samples uv = ((x + 0.5) / size, (y + 0.5) / size). V runs top to
 *   bottom (v = 0 is the first PNG row), which is Unreal's and glTF's convention, so the bake keeps the
 *   texture's row order. Sampling is bilinear with wrap/repeat; texel centres sit at (i + 0.5) / extent.
 * - Minification: when a sample's coordinates are TextureCoordinate x tiling, the sample reads the mip
 *   level closest to the texel-to-pixel ratio (box-filtered in linear space), so a tiling-8 texture baked
 *   at 1024 does not alias. The scale is carried through Multiply/Divide/Add/Subtract by a constant and through
 *   CustomRotator and UVEdit, so tiled and rotated coordinates keep their mip level.
 * - Texture coordinates are a general per-texel value (2 floats): UV-producing nodes (TextureCoordinate, Add/Multiply/
 *   Divide on UVs, AppendVector, ComponentMask, CustomRotator, UVEdit) compose freely and feed any `Coordinates` pin.
 */

export interface GraphParameters {
  /** Parameter name (lower-case) -> texture object name or path. */
  textures: ReadonlyMap<string, string>;
  vectors: ReadonlyMap<string, [number, number, number, number]>;
  scalars: ReadonlyMap<string, number>;
  switches: ReadonlyMap<string, boolean>;
}

export interface TextureRaster {
  width: number;
  height: number;
  /** Row-major RGBA, 8 bit, first row = top (v = 0). */
  rgba: Uint8Array | Uint8ClampedArray;
  /** The texture carries sRGB-encoded colour (Unreal's `SRGB` flag). */
  srgb: boolean;
}

export type TextureLoader = (objectName: string) => Promise<TextureRaster | undefined>;

export interface BakeRequest {
  graph: MaterialGraph;
  output: "baseColor";
  parameters: GraphParameters;
  loadTexture: TextureLoader;
  /** Square output edge in pixels. Default 1024. */
  size?: number;
  /**
   * Evaluate TextureCoordinate nodes with CoordinateIndex > 0 as UV0 and mark the bake heuristic instead of
   * refusing it. Off by default: which mesh UV set an index refers to is not in the graph.
   */
  allowUvSetFallback?: boolean;
  /**
   * Linear value every `VertexColor` node evaluates to. Pass white for a mesh without a colour buffer, which is what
   * Unreal feeds the node. Absent, VertexColor is unsupported.
   */
  vertexColor?: readonly [number, number, number, number];
  /**
   * Linear value every `ParticleColor` node evaluates to. Outside a particle emitter Unreal feeds the node white, so the
   * importer passes white; the emitter's own colour modules are not read. Absent, ParticleColor is unsupported.
   */
  particleColor?: readonly [number, number, number, number];
  /**
   * Which graph output carries the cut-out: `opacity` for a translucent material, `opacityMask` for a masked one (the
   * importer picks it from the section's glTF alpha mode). The bake writes it into the PNG's alpha channel, so a leaf card
   * whose silhouette lives in a mask texture is not an opaque rectangle. Absent, or the pin is unwired: alpha stays 255.
   */
  alpha?: "opacity" | "opacityMask";
  /** The mesh's vertex normals in UV space. With it a `WorldAlignedBlend` follows the surface; without, it is 0.5. */
  surface?: SurfaceNormals | undefined;
  /**
   * Bounding-sphere radius of the mesh in Unreal units (centimetres), which `ObjectRadius` reads for an unscaled instance.
   * Absent, ObjectRadius is unsupported.
   */
  objectRadius?: number | undefined;
}

export type BakeResult =
  | {
      status: "baked";
      png: Buffer;
      width: number;
      height: number;
      meanRgb: [number, number, number];
      confidence: "exact" | "heuristic";
      approximations: string[];
      texturesUsed: string[];
      /** Present when a cut-out was written into the alpha channel. */
      alpha?: { pin: "opacity" | "opacityMask"; opaqueShare: number; binary: boolean };
    }
  | { status: "unsupported"; unsupported: string[]; reason: string }
  | { status: "unavailable"; reason: string };

/** Node classes the evaluator implements. Everything else on an active path makes the bake `unsupported`. */
const SUPPORTED_NODE_CLASSES = [
  "TextureSample",
  "TextureSampleParameter2D",
  "ScalarParameter",
  "VectorParameter",
  "CollectionParameter",
  "Constant",
  "Constant2Vector",
  "Constant3Vector",
  "Constant4Vector",
  "Multiply",
  "Divide",
  "Add",
  "Subtract",
  "LinearInterpolate",
  "ComponentMask",
  "AppendVector",
  "OneMinus",
  "Saturate",
  "Desaturation",
  "Clamp",
  "Power",
  "TextureCoordinate",
  "StaticSwitch",
  "StaticSwitchParameter",
  "StaticBool",
  "StaticBoolParameter",
  "FeatureLevelSwitch",
  "FunctionCall",
  "FunctionInput",
  "FunctionOutput",
  "NamedRerouteUsage",
  "NamedRerouteDeclaration",
  "MakeMaterialAttributes",
  "BreakMaterialAttributes",
  "BlendMaterialAttributes",
  "SetMaterialAttributes",
  "GetMaterialAttributes",
  "Reroute",
  "QualitySwitch",
  "ShadingModel",
  "PathTracingQualitySwitch",
  "ShadingPathSwitch",
  "Abs",
  "Frac",
  "Min",
  "Max",
  "DotProduct",
  "Normalize",
  "ConstantBiasScale",
  "SphereMask",
  "ObjectPositionWS",
  "PerInstanceRandom",
  "BumpOffset",
  "Fresnel",
  "DepthFade",
  "TwoSidedSign",
  "WorldPosition",
  "TextureObject",
  "TextureObjectParameter",
  "LightmassReplace",
  "MaterialProxyReplace",
  "PrecomputedAOMask",
  "VertexNormalWS",
  "Transform",
  "ObjectRadius",
  "Time",
  "Panner",
  "Ceil",
  "Floor",
  "Sine",
  "SmoothStep",
  "SquareRoot",
  "CrossProduct",
] as const;

/** Engine content functions that the pack does not carry, matched by lower-cased function name. */
const SUPPORTED_ENGINE_FUNCTIONS = [
  "MatLayerBlend_Standard", "MatLayerBlend_Simple", "MatLayerBlend_NormalBlend", "MatLayerBlend_Tint", "MatLayerBlend_AO", "MatLayerBlend_BakedNormal", "FuzzyShading",
  "SpeedTreeColorVariation",
  "PivotPainter2FoliageShader",
  "Blend_Overlay",
  "CheapContrast",
  "HueShift",
  "DitherTemporalAA",
  "FlattenNormal",
  "CustomRotator",
  "UVEdit",
  "ConvertFromDiffSpec",
  "CheapContrast_RGB",
  "MakeFloat2",
  "MakeFloat3",
  "MakeFloat4",
  "BreakOutFloat2Components",
  "BreakOutFloat3Components",
  "BreakOutFloat4Components",
  "SplitComponents",
  "ObjectScale",
  "BoundingBoxBased_0-1_UVW",
  "WorldAlignedBlend",
  "WorldAlignedTexture",
  "FlowMaps_Simple",
  "MatLayerBlend_Emissive",
  "MatLayerBlend_ModulateRoughness",
  "MatLayerBlend_ModulateSpecular",
  "MatLayerBlend_ReplaceNormals",
  "MatLayerBlend_NormalFlatten",
  "MatLayerBlend_OverrideWorldPositionOffset",
  "MatLayerBlend_LightmassReplace",
  "MatLayerBlend_TopNormal",
  "MatLayerBlend_BreakBaseColor",
  "MatLayerBlend_BreakNormal",
  "MatLayerBlend_OverrideBaseColor",
  "MatLayerBlend_MultiplyBaseColor",
  "MatLayerBlend_TenLayerBlend",
  "Lerp_ScratchGrime",
  "MetallicShading",
  "VectorLength",
  "RemapValueRange",
  "LinearGradient",
] as const;

/**
 * Fixed GUIDs of the material attributes that `SetMaterialAttributes.AttributeSetTypes` and
 * `GetMaterialAttributes.AttributeGetTypes` list (the dump emits them as `attributeTypes`). The format is the
 * converter's `FGuid.ToString()`: 32 upper-case hex digits.
 *
 * Empirically derived from the European Hornbeam Megascans pack (UE 5.1; 4 `SetMaterialAttributes` nodes and 1
 * `GetMaterialAttributes` node, in MA_Foliage and MA_Impostor_SimpleOffset_MS; UE source was not available).
 * Every guid kept its meaning in every node it appears in (no inconsistency found). Evidence:
 * - CERTAIN, Impostor_MS function (its named outputs wire to SetMaterialAttributes pins in order): BaseColor
 *   (69B8..., 3 of 3 Set nodes), SubsurfaceColor (5B8F...), Specular (9FDA...), OpacityMask (679F...), Roughness
 *   (D1DD...), Normal (0FA2...), WorldPositionOffset (F905...), PixelDepthOffset (0AC9...).
 *   Normal is also named by the GetMaterialAttributes output name "Normal" and is fed by MF_adjustNormal; BaseColor is
 *   fed by MF_BarkDetailer/MF_adjustBaseColor colour math in both foliage Set nodes and never by a normal function.
 * - CERTAIN, the pin is fed by a `ShadingModel` node: ShadingModel (D942...).
 * - INFERRED from the feeding function only (agrees with the Impostor_MS names): Specular (MF_generateSpecular),
 *   Roughness (MF_Roughness), OpacityMask (MF_BranchBlending / MF_DecorationBlending), WorldPositionOffset (MF_AdvancedWind).
 * - UNKNOWN, deliberately absent: E8EBD0AD... (fed by a Masks-sampled texture; Opacity or AmbientOcclusion is a guess),
 *   Metallic, EmissiveColor, Opacity, AmbientOcclusion, and every other guid.
 */
export const MATERIAL_ATTRIBUTE_GUIDS = {
  BaseColor: "69B8D33616ED4D499AA497292F050F7A",
  SubsurfaceColor: "5B8FC67951CE40829D777BEEF4F72C44",
  Specular: "9FDAB39925564CC98CD2D572C12C8FED",
  OpacityMask: "679FFB172BB5422CAD520483166E0C75",
  Roughness: "D1DD967C4CAD47D39E6346FB08ECF210",
  Normal: "0FA2821A200F4A4AB719B789C1259C64",
  WorldPositionOffset: "F905F895D5814314916D24348C40CE9E",
  PixelDepthOffset: "0AC97EC3E3D047BAB610167DC4D919FF",
  ShadingModel: "D9423FFFD77E4D828FF9CF5E055D1255",
} as const;

/** Approximation notes whose node follows the view or the clock, by the node name each note starts with. */
const VIEW_DEPENDENT_PREFIXES = ["Fresnel", "DepthFade", "TwoSidedSign", "BumpOffset", "Time", "Panner", "FlowMaps_Simple", "MetallicShading", "view-dependent fuzzy shading"] as const;

/**
 * The view- or time-dependent nodes a bake stood in for, from its approximation notes. Unreal has no flat-colour bake of
 * these (it shades them per view and per frame), so the importer reports them as approximated rather than at parity.
 */
export function viewDependentNodes(approximations: readonly string[]): string[] {
  return VIEW_DEPENDENT_PREFIXES.filter((prefix) => approximations.some((note) => note === prefix || note.startsWith(`${prefix} `) || note.startsWith(`${prefix}:`)));
}

export function supportedNodeClasses(): readonly string[] {
  return SUPPORTED_NODE_CLASSES;
}

export function supportedEngineFunctions(): readonly string[] {
  return SUPPORTED_ENGINE_FUNCTIONS;
}

const DEFAULT_SIZE = 1024;
const MAX_DEPTH = 400;

// ---------------------------------------------------------------------------------------------------------
// Textures

/** One mip level. `u8` levels keep the texture's own bytes and decode through `lut`; `f32` levels are decoded. */
interface Level {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray | Float32Array;
  /** Decode table for the RGB bytes of a `u8` level. */
  lut: Float32Array | null;
}

const SRGB_TO_LINEAR = new Float32Array(256);
const BYTE_TO_UNIT = new Float32Array(256);
for (let index = 0; index < 256; index++) {
  const unit = index / 255;
  BYTE_TO_UNIT[index] = unit;
  SRGB_TO_LINEAR[index] = unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value: number): number {
  const clamped = value > 1 ? 1 : value > 0 ? value : 0;
  return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
}

function channelOf(level: Level, x: number, y: number, channel: number): number {
  const index = (y * level.width + x) * 4 + channel;
  if (level.data instanceof Float32Array) return level.data[index]!;
  const byte = level.data[index]!;
  return channel < 3 && level.lut ? level.lut[byte]! : byte / 255;
}

/** Halves a level with a 2x2 box filter, in linear float space. Odd extents clamp their last neighbour. */
function downsample(source: Level): Level {
  const width = Math.max(1, source.width >> 1);
  const height = Math.max(1, source.height >> 1);
  const data = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const y0 = Math.min(source.height - 1, y * 2);
    const y1 = Math.min(source.height - 1, y * 2 + 1);
    for (let x = 0; x < width; x++) {
      const x0 = Math.min(source.width - 1, x * 2);
      const x1 = Math.min(source.width - 1, x * 2 + 1);
      for (let channel = 0; channel < 4; channel++) {
        data[(y * width + x) * 4 + channel] =
          (channelOf(source, x0, y0, channel) + channelOf(source, x1, y0, channel) + channelOf(source, x0, y1, channel) + channelOf(source, x1, y1, channel)) / 4;
      }
    }
  }
  return { width, height, data, lut: null };
}

function wrap(index: number, extent: number): number {
  const wrapped = index % extent;
  return wrapped < 0 ? wrapped + extent : wrapped;
}

/** Bilinear, wrapping sample of a level into `out[offset..offset + 3]`. */
function sampleLevel(level: Level, u: number, v: number, out: Float64Array, offset: number): void {
  const { width, height, data, lut } = level;
  const fx = (Number.isFinite(u) ? u : 0) * width - 0.5;
  const fy = (Number.isFinite(v) ? v : 0) * height - 0.5;
  const x0f = Math.floor(fx);
  const y0f = Math.floor(fy);
  const tx = fx - x0f;
  const ty = fy - y0f;
  const x0 = wrap(x0f, width);
  const x1 = x0 + 1 === width ? 0 : x0 + 1;
  const y0 = wrap(y0f, height);
  const y1 = y0 + 1 === height ? 0 : y0 + 1;
  const i00 = (y0 * width + x0) * 4;
  const i10 = (y0 * width + x1) * 4;
  const i01 = (y1 * width + x0) * 4;
  const i11 = (y1 * width + x1) * 4;
  const w00 = (1 - tx) * (1 - ty);
  const w10 = tx * (1 - ty);
  const w01 = (1 - tx) * ty;
  const w11 = tx * ty;
  if (data instanceof Float32Array) {
    for (let channel = 0; channel < 4; channel++) {
      out[offset + channel] = data[i00 + channel]! * w00 + data[i10 + channel]! * w10 + data[i01 + channel]! * w01 + data[i11 + channel]! * w11;
    }
    return;
  }
  for (let channel = 0; channel < 3; channel++) {
    out[offset + channel] = lut![data[i00 + channel]!]! * w00 + lut![data[i10 + channel]!]! * w10 + lut![data[i01 + channel]!]! * w01 + lut![data[i11 + channel]!]! * w11;
  }
  out[offset + 3] = (data[i00 + 3]! * w00 + data[i10 + 3]! * w10 + data[i01 + 3]! * w01 + data[i11 + 3]! * w11) / 255;
}

/** One TextureSample node's view of a texture: which texture, how it decodes, which mip level it reads. */
interface TextureSlot {
  name: string;
  /** Sampler type allows sRGB decoding (the raster's own flag is checked once it is loaded). */
  colorSampler: boolean;
  /** Mip level wanted (0 = full size). Set at compile time from the coordinate scale. */
  lodFor: (outputSize: number, raster: { width: number; height: number }) => number;
  level?: Level;
}

/** `T_Rock_D`, `/Game/Rock/T_Rock_D.T_Rock_D` and `Rock/T_Rock_D.T_Rock_D` all name the object `T_Rock_D`. */
function textureObjectName(reference: string): string {
  const afterSlash = reference.slice(reference.lastIndexOf("/") + 1);
  return afterSlash.slice(afterSlash.lastIndexOf(".") + 1);
}

/** GUIDs compare case-insensitively and ignoring dashes and braces. */
function sameGuid(a: string, b: string): boolean {
  const normal = (guid: string) => guid.replace(/[^0-9a-f]/gi, "").toUpperCase();
  return normal(a) === normal(b);
}

function functionBaseName(reference: string | null | undefined): string | undefined {
  if (!reference) return undefined;
  const afterSlash = reference.slice(reference.lastIndexOf("/") + 1);
  const dot = afterSlash.indexOf(".");
  return dot < 0 ? afterSlash : afterSlash.slice(0, dot);
}

// ---------------------------------------------------------------------------------------------------------
// Compiler

/** A value of 1-4 components held in four floats at `reg` (an offset into the register file). */
interface Val {
  kind: "vec";
  reg: number;
  n: number;
  konst: boolean;
  /** The value is `uv * uvScale`: lets a sample choose a mip level. Dropped by any other operation. */
  uvScale?: [number, number];
  /** The value derives from `WorldPosition`: a texture sampled at it has no UV-space meaning, so its average stands in. */
  world?: true;
}
/** A MaterialAttributes value. Only BaseColor is carried (null = the attribute is not wired = black). */
interface Attrs {
  kind: "attr";
  baseColor: Val | null;
}
/**
 * A texture object (`TextureObject`, `TextureObjectParameter`, or a function input carrying one): not a value, only a
 * texture that a sample or an engine function reads. `reference` is null when nothing binds it (Unreal samples black).
 */
interface TexRef {
  kind: "tex";
  reference: string | null;
  samplerType: string;
}
type Compiled = Val | Attrs | TexRef;

interface TexelContext {
  u: number;
  v: number;
  /** Unit vertex normal at the texel (glTF axes, +Y up), when the bake was given a surface map. */
  nx?: number;
  ny?: number;
  nz?: number;
}
type Instruction = (registers: Float64Array, texel: TexelContext) => void;

const RGB_MASK = [1, 1, 1, 0];
const TEXTURE_OUTPUT_MASKS: readonly number[][] = [RGB_MASK, [1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
const BREAK_ATTRIBUTES = ["BaseColor", "Metallic", "Specular", "Roughness", "EmissiveColor", "Opacity", "OpacityMask", "Normal"];

interface CompileOptions {
  allowUvSetFallback: boolean;
  /** The bake carries the mesh's UV-space normals, so a world-normal driven node can be evaluated per texel. */
  surface?: boolean | undefined;
  vertexColor?: readonly [number, number, number, number] | undefined;
  particleColor?: readonly [number, number, number, number] | undefined;
  /** Bounding-sphere radius of the mesh in Unreal units, for `ObjectRadius`. */
  objectRadius?: number | undefined;
}

const PARTICLE_COLOR_NOTE =
  "ParticleColor evaluated as white: Unreal's value outside a particle emitter; the emitter's colour modules are not read";

const OBJECT_POSITION_NOTE =
  "ObjectPositionWS evaluated as the origin: a baked texture is shared by every placed instance, so one representative instance stands in";

const PER_INSTANCE_RANDOM_NOTE =
  "PerInstanceRandom evaluated as 0.5, the middle of its 0..1 range: a baked texture is shared by every placed instance";

const BOUNDING_BOX_UVW_NOTE =
  "BoundingBoxBased_0-1_UVW evaluated as the mesh UV0 with W = 0.5: the function maps the pixel's position across the object's bounding box to 0..1, and a bake has no object-space position (engine body unavailable, inferred from the name)";
const DEFAULT_ATTRIBUTES_NOTE =
  "SetMaterialAttributes has no incoming attributes and no BaseColor pin: BaseColor is Unreal's default attribute value (black)";
const OBJECT_SCALE_NOTE =
  "ObjectScale evaluated as 1 (an unscaled instance): a placed instance's scale would change texture tiling; engine body unavailable";

const BUMP_OFFSET_NOTE =
  "BumpOffset evaluated as its Coordinate: the parallax offset follows the view vector, which a baked texture does not have (a straight-on view is no offset)";

const WORLD_ALIGNED_BLEND_NOTE =
  "WorldAlignedBlend evaluated as 0.5: its blend follows the surface normal in world space (moss on up-facing faces), which a UV-space bake cannot hold, so half the surface stands in";

const WORLD_ALIGNED_BLEND_SURFACE_NOTE =
  "WorldAlignedBlend evaluated as saturate(up component of the mesh's own vertex normal x sharpness + bias), rasterised into UV space; the engine body is not in the pack, so the formula is inferred, and the mesh is taken unrotated";

const VERTEX_NORMAL_WS_NOTE =
  "VertexNormalWS evaluated from the mesh's own vertex normals rasterised into UV space, the mesh taken unrotated: Unreal's up (Z) is glTF +Y on every route; the horizontal axes are taken as Unreal X, Y = glTF X, Z";

const FRESNEL_NOTE =
  "Fresnel evaluated as its mean over the visible surface of a sphere seen from afar, BaseReflectFraction + (1 - BaseReflectFraction) * 2 / ((Exponent + 1) * (Exponent + 2)); the rim falloff follows the view angle, which a baked texture does not have";

/**
 * Mean of (1 - cos)^exponent over a sphere's visible disc, where the cosine between the normal and the view vector has
 * density 2 cos on 0..1 (a pixel disc is uniform in radius, cos = sqrt(1 - r^2)): 2 B(2, e + 1) = 2 / ((e + 1)(e + 2)).
 */
function fresnelSphereMean(exponent: number): number {
  const power = Math.max(exponent, 1e-4);
  return 2 / ((power + 1) * (power + 2));
}

const DEPTH_FADE_NOTE =
  "DepthFade evaluated as fully faded in: InOpacity x saturate((scene depth - pixel depth) / FadeDistance) with nothing close behind the surface is InOpacity; a baked texture has no scene depth";

const TWO_SIDED_SIGN_NOTE =
  "TwoSidedSign evaluated as +1 (the front face): a baked texture shows one side, and the back face of a two-sided card is not baked";

const MAT_LAYER_TINT_NOTE =
  "MatLayerBlend_Tint: BaseColor multiplied by lerp(1, Tint, Alpha) (unwired Alpha is 1); engine body unavailable, inferred from the pins (a white Tint is the identity)";

const WORLD_POSITION_NOTE =
  "WorldPosition evaluated as the origin, and a texture sampled at a coordinate derived from it as that texture's average colour: a baked texture is shared by every placed instance, so a world-space tiling mask stands in as its mean";

const PRECOMPUTED_AO_MASK_NOTE =
  "PrecomputedAOMask evaluated as 0: Unreal's value without built static lighting (the editor thumbnail, a movable or unbuilt mesh); a level built with Lightmass's AO material mask would darken crevices";

const TRANSFORM_LOCAL_WORLD_NOTE =
  "Transform between Local and World space is the identity: the bake is one unrotated, unscaled instance";

const TRANSFORM_TANGENT_NOTE =
  "Transform from Tangent to World space keeps only the vector's normal component (z x vertex normal): the mesh's tangent frame is not in the bake, so in-plane components are dropped (exact for a flat tangent-space normal)";

const OBJECT_RADIUS_NOTE =
  "ObjectRadius evaluated as the mesh's bounding-sphere radius (an unscaled instance); a scaled placement would change the tiling it drives";

const WORLD_ALIGNED_TEXTURE_NOTE =
  "WorldAlignedTexture evaluated as its texture's average colour: the projection follows world position, which a baked texture shared by every instance does not have, and every planar projection of a tiling texture averages to the same value; engine body unavailable";

const FLOW_MAP_NOTE =
  "FlowMaps_Simple: Diffuse evaluated as its texture's average colour: the texture is cross-faded between two flow-displaced phases over time, which a single baked texture cannot hold, and over the surface the flow keeps its mean; engine body unavailable";

const TIME_NOTE =
  "Time evaluated as 0 (the first frame): a baked texture is one snapshot; a snapshot keeps a panning texture's detail, which a time average would blur, and a sine of time is at its mean there";

const PANNER_NOTE =
  "Panner evaluated at time 0: its coordinate unpanned; a tiling texture panned by any amount has the same look";

const MAT_LAYER_PASS_NOTE = (name: string) => `${name}: BaseColor passed through (the function writes another attribute); engine body unavailable`;

const BREAK_NORMAL_NOTE =
  "MatLayerBlend_BreakNormal: only BaseColor is carried through layers, so a flat tangent-space normal (0, 0, 1) stands in for the layer's normal (normal-map detail ignored)";

const TEN_LAYER_NOTE =
  "MatLayerBlend_TenLayerBlend: Input20 is the base, Input21 the baked normal, and each (Input2k = layer, Input2k+1 = alpha) is lerped over the result from k = 9 (next to the base) up to k = 0 (top); inferred from the pins, engine body unavailable";

const TEN_LAYER_DEFAULT_BASE_NOTE =
  "MatLayerBlend_TenLayerBlend: Input20 (the base) is unwired, so the layers blend over Unreal's default attribute values (BaseColor black); engine body unavailable";

const VECTOR_LENGTH_NOTE =
  "VectorLength: sqrt(dot(Input0, Input0)) over the input's components; engine body unavailable, inferred from the name";

const REMAP_VALUE_RANGE_NOTE =
  "RemapValueRange: lerp(Input3, Input4, (Input0 - Input1) / (Input2 - Input1)), i.e. Input from [Input Low, Input High] to [Target Low, Target High], unclamped; engine body unavailable, inferred from the pins";

const LINEAR_GRADIENT_NOTE =
  "LinearGradient: the U or V texture coordinate (UV0 unless a UV input is wired) as a 0-1 ramp, by output name; engine body unavailable, inferred from the pins";

const VERTEX_COLOR_WHITE_NOTE =
  "VertexColor evaluated as white: the mesh carries no vertex colours (Unreal's default); an instance painted in a level would differ";

class Compiler {
  registers = new Float64Array(256);
  registerCount = 0;
  readonly program: Instruction[] = [];
  readonly unsupported = new Set<string>();
  readonly unavailable: string[] = [];
  readonly approximations = new Set<string>();
  readonly classes = new Set<string>();
  readonly slots: TextureSlot[] = [];
  private readonly memo = new Map<string, Compiled>();
  /** Above zero while the inputs of an already-unsupported node are being visited for the report. */
  private walkingInputs = 0;
  private readonly active = new Set<string>();
  private readonly textureRegisters = new Map<string, Val>();
  private readonly nodes = new Map<string, GraphNode>();
  /** Texture parameters this compile reached that the instance chain does not bind (and the graph gives no texture). */
  readonly unboundTextures = new Set<string>();

  constructor(
    private readonly graph: MaterialGraph,
    private readonly parameters: GraphParameters,
    private readonly options: CompileOptions,
    /** Branch choices of unoverridden static switches, shared with the trial compilers so each switch is decided once. */
    private readonly switchChoices: Map<string, { value: boolean; flipped: boolean }> = new Map(),
  ) {
    for (const node of graph.nodes) this.nodes.set(node.id, node);
  }

  // -- registers and instructions -------------------------------------------------------------------------

  private allocate(): number {
    const offset = this.registerCount * 4;
    this.registerCount++;
    if (offset + 4 > this.registers.length) {
      const grown = new Float64Array(this.registers.length * 2);
      grown.set(this.registers);
      this.registers = grown;
    }
    return offset;
  }

  constant(values: readonly number[], n = values.length): Val {
    const reg = this.allocate();
    for (let index = 0; index < 4; index++) this.registers[reg + index] = values[Math.min(index, values.length - 1)] ?? 0;
    return { kind: "vec", reg, n: Math.max(1, Math.min(4, n)), konst: true };
  }

  /** Emits `instruction`, or runs it now when every input is constant (the result is then a constant). */
  private emit(inputs: readonly Val[], n: number, build: (out: number) => Instruction, texelDependent = false): Val {
    const reg = this.allocate();
    const instruction = build(reg);
    const world = inputs.some((input) => input.world) ? ({ world: true } as const) : {};
    if (!texelDependent && inputs.every((input) => input.konst)) {
      instruction(this.registers, { u: 0, v: 0 });
      return { kind: "vec", reg, n, konst: true, ...world };
    }
    this.program.push(instruction);
    return { kind: "vec", reg, n, konst: false, ...world };
  }

  private binary(a: Val, b: Val, op: (x: number, y: number) => number): Val {
    const sa = a.n === 1 ? 0 : 1;
    const sb = b.n === 1 ? 0 : 1;
    return this.emit([a, b], Math.max(a.n, b.n), (o) => (r) => {
      r[o] = op(r[a.reg]!, r[b.reg]!);
      r[o + 1] = op(r[a.reg + sa]!, r[b.reg + sb]!);
      r[o + 2] = op(r[a.reg + 2 * sa]!, r[b.reg + 2 * sb]!);
      r[o + 3] = op(r[a.reg + 3 * sa]!, r[b.reg + 3 * sb]!);
    });
  }

  private unary(a: Val, op: (x: number) => number): Val {
    return this.emit([a], a.n, (o) => (r) => {
      for (let index = 0; index < 4; index++) r[o + index] = op(r[a.reg + index]!);
    });
  }

  lerp(a: Val, b: Val, alpha: Val): Val {
    const sa = a.n === 1 ? 0 : 1;
    const sb = b.n === 1 ? 0 : 1;
    const sl = alpha.n === 1 ? 0 : 1;
    return this.emit([a, b, alpha], Math.max(a.n, b.n, alpha.n), (o) => (r) => {
      for (let index = 0; index < 4; index++) {
        const x = r[a.reg + index * sa]!;
        r[o + index] = x + (r[b.reg + index * sb]! - x) * r[alpha.reg + index * sl]!;
      }
    });
  }

  private gather(source: Val, channels: readonly number[]): Val {
    if (source.n === 1 || channels.length === 0) return source;
    if (channels.length === source.n && channels.every((channel, index) => channel === index)) return source;
    const picked = channels.slice(0, 4);
    return this.emit([source], picked.length, (o) => (r) => {
      for (let index = 0; index < picked.length; index++) r[o + index] = r[source.reg + picked[index]!]!;
    });
  }

  private applyMask(value: Val, mask: readonly number[] | null | undefined): Val {
    if (!mask) return value;
    const channels = mask.flatMap((flag, index) => (flag ? [index] : []));
    return this.gather(value, channels);
  }

  // -- diagnostics ----------------------------------------------------------------------------------------

  markUnsupported(name: string): Val {
    this.unsupported.add(name);
    return this.constant([0], 1);
  }

  private markUnavailable(reason: string): Val {
    if (!this.unavailable.includes(reason)) this.unavailable.push(reason);
    return this.constant([0], 1);
  }

  // -- pins -----------------------------------------------------------------------------------------------

  pin(input: GraphInput | null | undefined): Compiled | undefined {
    if (!input) return undefined;
    const node = this.nodes.get(input.node);
    if (!node) return this.markUnavailable(`pin refers to missing node ${input.node}`);
    const compiled = this.nodeOutput(node, input.output);
    if (compiled.kind !== "vec") return compiled;
    const fallbackMask = (node.class.startsWith("TextureSample") || node.class === "VertexColor" || node.class === "ParticleColor") && input.output >= 0 && input.output < TEXTURE_OUTPUT_MASKS.length ? TEXTURE_OUTPUT_MASKS[input.output]! : null;
    return this.applyMask(compiled, input.mask ?? fallbackMask);
  }

  /** A pin that must carry a plain value; an attribute value there is a malformed graph. */
  private vec(input: GraphInput | null | undefined, label: string): Val | undefined {
    const compiled = this.pin(input);
    if (!compiled) return undefined;
    if (compiled.kind === "attr") return this.markUnavailable(`${label} received a MaterialAttributes value`);
    if (compiled.kind === "tex") return this.markUnavailable(`${label} received a texture object, not a value`);
    return compiled;
  }

  /** A pin that must carry a texture object. */
  private texture(input: GraphInput | null | undefined, label: string): TexRef | undefined {
    const compiled = this.pin(input);
    if (!compiled) return undefined;
    if (compiled.kind !== "tex") {
      this.markUnavailable(`${label} expected a texture object`);
      return undefined;
    }
    return compiled;
  }

  private attrs(input: GraphInput | null | undefined, label: string): Attrs | undefined {
    const compiled = this.pin(input);
    if (!compiled) return undefined;
    if (compiled.kind !== "attr") {
      this.markUnavailable(`${label} expected MaterialAttributes`);
      return { kind: "attr", baseColor: null };
    }
    return compiled;
  }

  private operand(node: GraphNode, pinName: string, constantName: string, fallback: number): Val {
    const wired = node.inputs[pinName];
    if (wired) return this.vec(wired, `${node.class}.${pinName}`) ?? this.constant([fallback], 1);
    const stored = node.constants[constantName];
    return this.constant([typeof stored === "number" ? stored : fallback], 1);
  }

  /** Value of a static-bool pin, which must reduce to a constant. */
  private staticBool(input: GraphInput | null | undefined, fallback: boolean, label: string): boolean {
    if (!input) return fallback;
    const value = this.vec(input, label);
    if (!value) return fallback;
    if (!value.konst) {
      this.markUnsupported(`${label}(non-static value)`);
      return fallback;
    }
    return this.registers[value.reg]! !== 0;
  }

  // -- nodes ----------------------------------------------------------------------------------------------

  private nodeOutput(node: GraphNode, output: number): Compiled {
    const key = `${node.id}#${output}`;
    const cached = this.memo.get(key);
    if (cached) return cached;
    if (this.active.has(key) || this.active.size > MAX_DEPTH) {
      // The walk below an unsupported node follows every input, though a function call hands each output only the inputs
      // that feed it, so an engine function whose normal output feeds a texture that feeds the same call's UV output
      // looks like a loop. It is a reporting walk: the node is already named, and a "Cycle" would be an invented cause.
      if (this.walkingInputs > 0 && this.active.has(key)) return this.constant([0], 1);
      this.markUnsupported(this.active.has(key) ? "Cycle" : "DepthLimit");
      return this.constant([0], 1);
    }
    this.active.add(key);
    this.classes.add(node.class);
    let compiled: Compiled;
    try {
      compiled = this.evaluate(node, output);
    } finally {
      this.active.delete(key);
    }
    this.memo.set(key, compiled);
    return compiled;
  }

  private evaluate(node: GraphNode, output: number): Compiled {
    if (node.error && node.class !== "FunctionCall") {
      // The dumper could not read part of this node, so its value cannot be trusted. An unloadable class is a gap in coverage.
      if (node.class === "Unresolved") return this.markUnsupported("Unresolved");
      this.markUnavailable(`node ${node.id} (${node.class}) could not be read: ${node.error}`);
    }
    switch (node.class) {
      case "TextureSample":
      case "TextureSampleParameter2D":
        return this.textureSample(node);
      case "ScalarParameter": {
        const override = node.parameter ? this.parameters.scalars.get(node.parameter.name.toLowerCase()) : undefined;
        const stored = node.default;
        return this.constant([override ?? (typeof stored === "number" ? stored : 0)], 1);
      }
      case "VectorParameter": {
        const override = node.parameter ? this.parameters.vectors.get(node.parameter.name.toLowerCase()) : undefined;
        const stored = Array.isArray(node.default) ? node.default : [0, 0, 0, 0];
        const value = override ?? stored;
        return this.constant([value[0] ?? 0, value[1] ?? 0, value[2] ?? 0, value[3] ?? 1], 4);
      }
      case "CollectionParameter": {
        // A MaterialParameterCollection entry at its default value: what the editor shows until gameplay changes it.
        // Instances cannot override it. Without a default the collection was not readable.
        const stored = node.default;
        if (typeof stored === "number") return this.constant([stored], 1);
        if (Array.isArray(stored)) return this.constant([stored[0] ?? 0, stored[1] ?? 0, stored[2] ?? 0, stored[3] ?? 0], 4);
        return this.unsupportedNode(node);
      }
      case "Constant": {
        const r = node.constants.R;
        return this.constant([typeof r === "number" ? r : 0], 1);
      }
      case "Constant2Vector": {
        const { R, G } = node.constants;
        return this.constant([typeof R === "number" ? R : 0, typeof G === "number" ? G : 0], 2);
      }
      case "Constant3Vector":
      case "Constant4Vector": {
        const packed = node.constants.Constant;
        const values = Array.isArray(packed)
          ? packed
          : ["R", "G", "B", "A"].map((name) => (typeof node.constants[name] === "number" ? (node.constants[name] as number) : 0));
        return this.constant([values[0] ?? 0, values[1] ?? 0, values[2] ?? 0, values[3] ?? 0], node.class === "Constant3Vector" ? 3 : 4);
      }
      // Class defaults below are Unreal's; the dumper omits a constant that equals its default.
      case "Multiply": {
        const a = this.operand(node, "A", "ConstA", 0);
        const b = this.operand(node, "B", "ConstB", 1);
        return this.carryUvScale(this.binary(a, b, (x, y) => x * y), a, b, "mul");
      }
      case "Divide": {
        const a = this.operand(node, "A", "ConstA", 0);
        const b = this.operand(node, "B", "ConstB", 1);
        // A divisor within 1e-6 of zero is pushed out to 1e-6, keeping its sign, so a black texel yields a large finite value.
        return this.carryUvScale(this.binary(a, b, (x, y) => x / (Math.abs(y) < 1e-6 ? (y < 0 ? -1e-6 : 1e-6) : y)), a, b, "div");
      }
      case "Add": {
        const a = this.operand(node, "A", "ConstA", 0);
        const b = this.operand(node, "B", "ConstB", 1);
        return this.carryUvScale(this.binary(a, b, (x, y) => x + y), a, b, "add");
      }
      case "Subtract": {
        const a = this.operand(node, "A", "ConstA", 1);
        const b = this.operand(node, "B", "ConstB", 1);
        return this.carryUvScale(this.binary(a, b, (x, y) => x - y), a, b, "sub");
      }
      case "LinearInterpolate":
        return this.lerp(this.operand(node, "A", "ConstA", 0), this.operand(node, "B", "ConstB", 1), this.operand(node, "Alpha", "ConstAlpha", 0.5));
      case "Power": {
        // A negative base has no real power; Unreal's compiler wraps it in a clamp to zero.
        const base = this.operand(node, "Base", "ConstBase", 0);
        return this.binary(base, this.operand(node, "Exponent", "ConstExponent", 2), (x, y) => Math.max(x, 0) ** y);
      }
      case "OneMinus": {
        const input = this.vec(node.inputs.Input, "OneMinus.Input");
        return input ? this.unary(input, (x) => 1 - x) : this.markUnavailable(`OneMinus ${node.id} has no input`);
      }
      case "Saturate": {
        const input = this.vec(node.inputs.Input, "Saturate.Input");
        return input ? this.unary(input, (x) => (x < 0 ? 0 : x > 1 ? 1 : x)) : this.markUnavailable(`Saturate ${node.id} has no input`);
      }
      case "Desaturation":
        return this.desaturation(node);
      case "Clamp": {
        const input = this.vec(node.inputs.Input, "Clamp.Input");
        if (!input) return this.markUnavailable(`Clamp ${node.id} has no input`);
        const low = this.operand(node, "Min", "MinDefault", 0);
        const high = this.operand(node, "Max", "MaxDefault", 1);
        return this.binary(this.binary(input, low, (x, y) => (x < y ? y : x)), high, (x, y) => (x > y ? y : x));
      }
      case "ComponentMask": {
        const input = this.vec(node.inputs.Input, "ComponentMask.Input");
        if (!input) return this.markUnavailable(`ComponentMask ${node.id} has no input`);
        const channels = (node.channelMask ?? [1, 1, 1, 0]).flatMap((flag, index) => (flag ? [index] : []));
        return this.gather(input, channels);
      }
      case "AppendVector":
        return this.append(node);
      case "TextureCoordinate":
        return this.textureCoordinate(node);
      case "VertexColor": {
        const color = this.options.vertexColor;
        if (!color) return this.unsupportedNode(node);
        // Only the default (white) is faithful for a mesh without a colour buffer; any other value is the caller's claim.
        if (color.some((channel) => channel !== 1)) this.approximations.add(`VertexColor evaluated as constant (${color.join(", ")})`);
        else this.approximations.add(VERTEX_COLOR_WHITE_NOTE);
        return this.constant([...color], 4);
      }
      case "ParticleColor": {
        const color = this.options.particleColor;
        if (!color) return this.unsupportedNode(node);
        this.approximations.add(color.every((channel) => channel === 1) ? PARTICLE_COLOR_NOTE : `ParticleColor evaluated as constant (${color.join(", ")})`);
        return this.constant([...color], 4);
      }
      case "VertexNormalWS": {
        // The vertex normal in world space. A bake knows the mesh's own normals per texel (as for WorldAlignedBlend), and a
        // mesh is baked unrotated, so its local normal is the world one: a grid that tints up-facing faces (a level-prototyping
        // master) gets its top colour on the top faces. Without the surface map the node stays unsupported.
        if (!this.options.surface) return this.unsupportedNode(node);
        this.approximations.add(VERTEX_NORMAL_WS_NOTE);
        return this.emit([], 3, (o) => (r, texel) => {
          r[o] = texel.nx ?? 0;
          r[o + 1] = texel.nz ?? 0;
          r[o + 2] = texel.ny ?? 1;
        }, true);
      }
      case "ObjectPositionWS":
        // Per-instance data: the placement of the instance in the level. One representative instance (the origin).
        this.approximations.add(OBJECT_POSITION_NOTE);
        return this.constant([0, 0, 0], 3);
      case "WorldPosition": {
        // The position of the pixel in the level. A world-space macro mask (grass variation noise tiled by world X/Y) has no UV
        // equivalent, so the origin stands in and a texture sampled through it reads its average (see `textureSample`).
        this.approximations.add(WORLD_POSITION_NOTE);
        return { ...this.constant([0, 0, 0], 3), world: true };
      }
      case "PerInstanceRandom":
        this.approximations.add(PER_INSTANCE_RANDOM_NOTE);
        return this.constant([0.5], 1);
      case "BumpOffset": {
        // Coordinate + (Height - Reference) * HeightRatio * CameraVector.xy: no view vector in a bake, so the coordinate itself.
        this.approximations.add(BUMP_OFFSET_NOTE);
        const coordinate = node.inputs.Coordinate ? this.vec(node.inputs.Coordinate, "BumpOffset.Coordinate") : this.defaultUv();
        return coordinate ?? this.markUnavailable(`BumpOffset ${node.id} has no coordinate`);
      }
      case "Fresnel": {
        // BaseReflectFraction + (1 - BaseReflectFraction) * (1 - saturate(dot(Normal, CameraVector)))^Exponent. A bake has no
        // camera, and the texture is seen from every angle, so the node stands in as its mean over a sphere's visible surface
        // (an object lit by a Fresnel rim is paler on average than face-on: the cloud, sun and moon meshes of one sky pack score 64
        // with the mean against 55 with the face-on value). Unreal's defaults are Exponent 5 and BaseReflectFraction 0.04. The Normal
        // pin only changes the angle, so it is not walked.
        this.approximations.add(FRESNEL_NOTE);
        const base = this.operand(node, "BaseReflectFractionIn", "BaseReflectFraction", 0.04);
        const exponent = this.operand(node, "ExponentIn", "Exponent", 5);
        return this.binary(base, exponent, (reflect, power) => reflect + (1 - reflect) * fresnelSphereMean(power));
      }
      case "TwoSidedSign":
        // +1 on a front face, -1 on the back face of a two-sided mesh. Foliage cards lerp a "top" colour (sign > 0) over a
        // "bottom" colour through saturate(sign); the glTF material carries the front face.
        this.approximations.add(TWO_SIDED_SIGN_NOTE);
        return this.constant([1], 1);
      case "DepthFade":
        // InOpacity x saturate((SceneDepth - PixelDepth) / FadeDistance): the soft-edge fade where a surface meets what is
        // behind it. A surface with open space behind it is fully faded in (the factor is 1), so the value is InOpacity,
        // which is OpacityDefault (1) when unwired. FadeDistance only scales the factor and is not walked.
        this.approximations.add(DEPTH_FADE_NOTE);
        return this.operand(node, "InOpacity", "OpacityDefault", 1);
      case "TextureObject":
        return { kind: "tex", reference: node.texture ?? null, samplerType: node.samplerType ?? "Color" };
      case "TextureObjectParameter": {
        const override = node.parameter ? this.parameters.textures.get(node.parameter.name.toLowerCase()) : undefined;
        return { kind: "tex", reference: override ?? node.texture ?? null, samplerType: node.samplerType ?? "Color" };
      }
      case "LightmassReplace":
        // Realtime is what the renderer evaluates; Lightmass only feeds the static-lighting bake (inferred: the expression's
        // Compile is engine code, not in the pack).
        return this.pin(node.inputs.Realtime) ?? this.markUnavailable(`LightmassReplace ${node.id} has no Realtime input`);
      case "MaterialProxyReplace":
        // Realtime is the material itself; MaterialProxy only feeds merged-actor (HLOD) proxy baking (inferred, as above).
        return this.pin(node.inputs.Realtime) ?? this.markUnavailable(`MaterialProxyReplace ${node.id} has no Realtime input`);
      case "PrecomputedAOMask":
        // Inferred: the value without a built AO material mask is not verifiable here (engine code); 0 was chosen and checked
        // against the editor thumbnails of the pieces that read it (see the PR's fidelity table).
        this.approximations.add(PRECOMPUTED_AO_MASK_NOTE);
        return this.constant([0], 1);
      case "Transform":
        return this.transform(node);
      case "ObjectRadius": {
        const radius = this.options.objectRadius;
        if (radius === undefined || !Number.isFinite(radius)) return this.unsupportedNode(node);
        this.approximations.add(OBJECT_RADIUS_NOTE);
        return this.constant([radius], 1);
      }
      case "Time":
        this.approximations.add(TIME_NOTE);
        return this.constant([0], 1);
      case "Panner":
        return this.panner(node);
      case "Ceil":
      case "Floor": {
        const input = this.vec(node.inputs.Input, `${node.class}.Input`);
        if (!input) return this.markUnavailable(`${node.class} ${node.id} has no input`);
        return this.unary(input, node.class === "Ceil" ? Math.ceil : Math.floor);
      }
      case "SmoothStep":
        return this.smoothStep(node);
      case "SquareRoot": {
        // HLSL sqrt; a negative input (NaN on the GPU) is taken as 0.
        const input = this.vec(node.inputs.Input, "SquareRoot.Input");
        if (!input) return this.markUnavailable(`SquareRoot ${node.id} has no input`);
        return this.unary(input, (x) => Math.sqrt(x > 0 ? x : 0));
      }
      case "CrossProduct":
        return this.crossProduct(node);
      case "Sine": {
        // sin(Input * 2 pi / Period) for a positive Period (default 1), else sin(Input).
        const input = this.vec(node.inputs.Input, "Sine.Input");
        if (!input) return this.markUnavailable(`Sine ${node.id} has no input`);
        const period = typeof node.constants.Period === "number" ? node.constants.Period : 1;
        return this.unary(input, (x) => Math.sin(period > 0 ? (x * 2 * Math.PI) / period : x));
      }
      case "StaticBool":
        return this.constant([node.constants.Value === true ? 1 : 0], 1);
      case "StaticBoolParameter": {
        const override = node.parameter ? this.parameters.switches.get(node.parameter.name.toLowerCase()) : undefined;
        return this.constant([(override ?? (node.default === true)) ? 1 : 0], 1);
      }
      case "StaticSwitchParameter": {
        const override = node.parameter ? this.parameters.switches.get(node.parameter.name.toLowerCase()) : undefined;
        const stored = typeof node.default === "boolean" ? node.default : node.switchValue === true;
        if (override !== undefined) return this.branch(node, override);
        return this.branch(node, this.unoverriddenSwitch(node, stored));
      }
      case "StaticSwitch":
        return this.branch(node, this.staticBool(node.inputs.Value, node.switchValue === true, "StaticSwitch.Value"));
      case "FeatureLevelSwitch": {
        // Shader model 5 is the quality the bake targets: the Default pin, else the SM5 slot.
        const wired = node.inputs.Default ?? node.inputs["Inputs[3]"];
        return this.pin(wired) ?? this.markUnavailable(`FeatureLevelSwitch ${node.id} has no Default input`);
      }
      case "FunctionInput": {
        // The dumper replaces the preview with the call's real pin; an unwired input keeps its preview value.
        const wired = node.inputs.Input ?? node.inputs.Preview;
        if (!wired && node.constants.bUsePreviewValueAsDefault === true) {
          // Unreal compiles an unconnected input with "use preview value as default" to its PreviewValue constant, sized by
          // InputType (default Vector3). Tagged serialization omits a zero PreviewValue, so an absent one is (0, 0, 0, 0).
          const width = { FunctionInput_Scalar: 1, FunctionInput_Vector2: 2, FunctionInput_Vector3: 3, FunctionInput_Vector4: 4 }[String(node.constants.InputType ?? "FunctionInput_Vector3")];
          if (width !== undefined) {
            const preview = node.constants.PreviewValue;
            const values = Array.isArray(preview) ? preview : typeof preview === "number" ? [preview] : [0, 0, 0, 0];
            return this.constant([0, 1, 2, 3].map((index) => values[index] ?? 0), width);
          }
        }
        return this.pin(wired) ?? this.markUnavailable(`function input "${String(node.constants.InputName ?? node.id)}" is not wired and has no preview value`);
      }
      case "FunctionOutput": {
        const wired = Object.values(node.inputs).find((candidate) => candidate !== null && candidate !== undefined);
        return this.pin(wired) ?? this.markUnavailable(`function output ${node.id} is not wired`);
      }
      case "NamedRerouteDeclaration":
        return this.pin(node.inputs.Input) ?? this.markUnavailable(`named reroute declaration ${node.id} is not wired`);
      case "NamedRerouteUsage": {
        // The dumper links a usage to its declaration through `Input`; a dump without that pin cannot be followed.
        if (!node.inputs.Input) return this.unsupportedNode(node);
        return this.pin(node.inputs.Input) ?? this.markUnavailable(`named reroute usage ${node.id} has no declaration`);
      }
      case "FunctionCall":
        return this.functionCall(node, output);
      case "Reroute":
        // A reroute node only carries its Input through.
        return this.pin(node.inputs.Input) ?? this.markUnavailable(`Reroute ${node.id} is not wired`);
      case "QualitySwitch": {
        // Like FeatureLevelSwitch, the bake targets the highest quality: the Default pin.
        return this.pin(node.inputs.Default) ?? this.markUnavailable(`QualitySwitch ${node.id} has no Default input`);
      }
      case "PathTracingQualitySwitch":
        // The path tracer is not the renderer the bake models: Normal is the real-time branch.
        return this.pin(node.inputs.Normal) ?? this.markUnavailable(`PathTracingQualitySwitch ${node.id} has no Normal input`);
      case "ShadingPathSwitch": {
        // Deferred is the path the bake targets: the Default pin, else the deferred slot.
        const wired = node.inputs.Default ?? node.inputs["Inputs[0]"];
        return this.pin(wired) ?? this.markUnavailable(`ShadingPathSwitch ${node.id} has no Default or deferred input`);
      }
      case "Abs":
      case "Frac": {
        const input = this.vec(node.inputs.Input, `${node.class}.Input`);
        if (!input) return this.markUnavailable(`${node.class} ${node.id} has no input`);
        return this.unary(input, node.class === "Abs" ? Math.abs : (x) => x - Math.floor(x));
      }
      case "Min":
        return this.binary(this.operand(node, "A", "ConstA", 0), this.operand(node, "B", "ConstB", 1), (x, y) => (x < y ? x : y));
      case "Max":
        return this.binary(this.operand(node, "A", "ConstA", 0), this.operand(node, "B", "ConstB", 1), (x, y) => (x > y ? x : y));
      case "DotProduct":
        return this.dotProduct(node);
      case "Normalize":
        return this.normalize(node);
      case "ConstantBiasScale": {
        // (Input + Bias) * Scale; Unreal's defaults are Bias 1 and Scale 0.5, which the dumper omits.
        const input = this.vec(node.inputs.Input, "ConstantBiasScale.Input");
        if (!input) return this.markUnavailable(`ConstantBiasScale ${node.id} has no input`);
        const bias = typeof node.constants.Bias === "number" ? node.constants.Bias : 1;
        const scale = typeof node.constants.Scale === "number" ? node.constants.Scale : 0.5;
        return this.unary(input, (x) => (x + bias) * scale);
      }
      case "SphereMask":
        return this.sphereMask(node);
      case "ShadingModel":
        // Its value only reaches the ShadingModel slot of a SetMaterialAttributes, never BaseColor.
        return this.constant([0], 1);
      case "MakeMaterialAttributes": {
        const baseColor = this.vec(node.inputs.BaseColor, "MakeMaterialAttributes.BaseColor") ?? null;
        return { kind: "attr", baseColor };
      }
      case "BreakMaterialAttributes":
        return this.breakAttributes(node, output);
      case "GetMaterialAttributes":
        return this.getAttributes(node, output);
      case "BlendMaterialAttributes":
        return this.blendAttributes(node);
      case "SetMaterialAttributes":
        return this.setAttributes(node);
      default:
        return this.unsupportedNode(node);
    }
  }

  /**
   * MaterialExpressionDesaturation: lerp(Input, dot(Input.rgb, LuminanceFactors), Fraction). Unreal's defaults are
   * LuminanceFactors (0.3, 0.59, 0.11) and, for an unwired Fraction, 1 (fully grey). Exact.
   */
  private desaturation(node: GraphNode): Compiled {
    const input = this.vec(node.inputs.Input, "Desaturation.Input");
    if (!input) return this.markUnavailable(`Desaturation ${node.id} has no input`);
    const stored = node.constants.LuminanceFactors;
    const factors = Array.isArray(stored) && stored.length >= 3 ? stored : [0.3, 0.59, 0.11];
    const [fr, fg, fb] = [factors[0]!, factors[1]!, factors[2]!];
    const luminance =
      input.n === 1
        ? this.unary(input, (x) => x * (fr + fg + fb))
        : this.emit([input], 1, (o) => (r) => {
            r[o] = r[input.reg]! * fr + r[input.reg + 1]! * fg + r[input.reg + 2]! * fb;
            r[o + 1] = r[o + 2] = r[o + 3] = r[o]!;
          });
    return this.lerp(input, luminance, this.operand(node, "Fraction", "Fraction", 1));
  }

  /**
   * SmoothStep(Min, Max, Value) = t * t * (3 - 2t) with t = saturate((Value - Min) / (Max - Min)), HLSL's smoothstep.
   * Unwired pins take ConstMin 0, ConstMax 1 and ConstValue 0, Unreal's defaults; Max = Min is guarded like Divide.
   */
  private smoothStep(node: GraphNode): Compiled {
    const low = this.operand(node, "Min", "ConstMin", 0);
    const high = this.operand(node, "Max", "ConstMax", 1);
    const value = this.operand(node, "Value", "ConstValue", 0);
    const n = Math.max(low.n, high.n, value.n);
    const stride = (operand: Val) => (operand.n === 1 ? 0 : 1);
    const [sl, sh, sv] = [stride(low), stride(high), stride(value)];
    return this.emit([low, high, value], n, (o) => (r) => {
      for (let index = 0; index < 4; index++) {
        const min = r[low.reg + index * sl]!;
        const span = r[high.reg + index * sh]! - min;
        const raw = (r[value.reg + index * sv]! - min) / (Math.abs(span) < 1e-6 ? (span < 0 ? -1e-6 : 1e-6) : span);
        const t = raw < 0 ? 0 : raw > 1 ? 1 : raw;
        r[o + index] = t * t * (3 - 2 * t);
      }
    });
  }

  /** CrossProduct(A, B): the 3-component cross product; a narrower operand's missing components are 0. */
  private crossProduct(node: GraphNode): Compiled {
    const a = this.vec(node.inputs.A, "CrossProduct.A");
    const b = this.vec(node.inputs.B, "CrossProduct.B");
    if (!a || !b) return this.markUnavailable(`CrossProduct ${node.id} is missing an input`);
    const component = (value: Val, r: Float64Array, index: number): number => (value.n === 1 ? r[value.reg]! : index < value.n ? r[value.reg + index]! : 0);
    return this.emit([a, b], 3, (o) => (r) => {
      const [ax, ay, az] = [component(a, r, 0), component(a, r, 1), component(a, r, 2)];
      const [bx, by, bz] = [component(b, r, 0), component(b, r, 1), component(b, r, 2)];
      r[o] = ay * bz - az * by;
      r[o + 1] = az * bx - ax * bz;
      r[o + 2] = ax * by - ay * bx;
      r[o + 3] = 0;
    });
  }

  private dotProduct(node: GraphNode): Compiled {
    const a = this.vec(node.inputs.A, "DotProduct.A");
    const b = this.vec(node.inputs.B, "DotProduct.B");
    if (!a || !b) return this.markUnavailable(`DotProduct ${node.id} is missing an input`);
    return this.dot(a, b);
  }

  /** Sum of component products over the wider operand; a scalar operand repeats. */
  private dot(a: Val, b: Val): Val {
    const sa = a.n === 1 ? 0 : 1;
    const sb = b.n === 1 ? 0 : 1;
    const n = Math.max(a.n, b.n);
    return this.emit([a, b], 1, (o) => (r) => {
      let sum = 0;
      for (let index = 0; index < n; index++) sum += r[a.reg + index * sa]! * r[b.reg + index * sb]!;
      r[o] = r[o + 1] = r[o + 2] = r[o + 3] = sum;
    });
  }

  /** v / |v| over the vector's own components; the zero vector stays zero. */
  private normalize(node: GraphNode): Compiled {
    const input = this.vec(node.inputs.VectorInput ?? node.inputs.Input, "Normalize.VectorInput");
    if (!input) return this.markUnavailable(`Normalize ${node.id} has no input`);
    const n = input.n;
    return this.emit([input], n, (o) => (r) => {
      let sum = 0;
      for (let index = 0; index < n; index++) sum += r[input.reg + index]! ** 2;
      const length = Math.sqrt(sum);
      for (let index = 0; index < 4; index++) r[o + index] = length > 0 && index < n ? r[input.reg + index]! / length : 0;
    });
  }

  /**
   * SphereMask(A, B, Radius, Hardness) = saturate((1 - |A - B| / Radius) / (1 - Hardness)), Hardness 0 soft and 1 hard.
   * Reconstructed from the node's documented behaviour, not read from the engine source, so it is a heuristic.
   * Unwired Radius and Hardness fall back to AttenuationRadius (256) and HardnessPercent / 100 (100 -> 1).
   */
  private sphereMask(node: GraphNode): Compiled {
    const a = this.vec(node.inputs.A, "SphereMask.A");
    const b = this.vec(node.inputs.B, "SphereMask.B");
    if (!a || !b) return this.markUnavailable(`SphereMask ${node.id} is missing A or B`);
    const radius = node.inputs.Radius ? this.vec(node.inputs.Radius, "SphereMask.Radius")! : this.constant([typeof node.constants.AttenuationRadius === "number" ? node.constants.AttenuationRadius : 256], 1);
    const hardness = node.inputs.Hardness
      ? this.vec(node.inputs.Hardness, "SphereMask.Hardness")!
      : this.constant([(typeof node.constants.HardnessPercent === "number" ? node.constants.HardnessPercent : 100) / 100], 1);
    this.approximations.add("SphereMask: formula reconstructed from the node's behaviour, not verified against the engine");
    const sa = a.n === 1 ? 0 : 1;
    const sb = b.n === 1 ? 0 : 1;
    const n = Math.max(a.n, b.n);
    return this.emit([a, b, radius, hardness], 1, (o) => (r) => {
      let sum = 0;
      for (let index = 0; index < n; index++) sum += (r[a.reg + index * sa]! - r[b.reg + index * sb]!) ** 2;
      const normalised = Math.sqrt(sum) / Math.max(r[radius.reg]!, 1e-5);
      const value = (1 - normalised) / Math.max(1 - r[hardness.reg]!, 1e-5);
      r[o] = r[o + 1] = r[o + 2] = r[o + 3] = value < 0 ? 0 : value > 1 ? 1 : value;
    });
  }

  /**
   * Transform(Input) from TransformSourceType (default Tangent) to TransformType (default World). The bake is one unrotated,
   * unscaled instance, so Local and World coincide. Tangent to World needs the tangent frame; only the vertex normal is known,
   * so the vector's z (normal) component is carried along it. View, camera and particle spaces are unsupported.
   */
  private transform(node: GraphNode): Compiled {
    const source = String(node.constants.TransformSourceType ?? "TRANSFORMSOURCE_Tangent").replace(/^TRANSFORMSOURCE_/, "");
    const target = String(node.constants.TransformType ?? "TRANSFORM_World").replace(/^TRANSFORM_/, "");
    const objectOrWorld = (space: string) => space === "Local" || space === "World";
    if (source !== target && !(objectOrWorld(source) && objectOrWorld(target)) && !(source === "Tangent" && objectOrWorld(target))) {
      this.unsupported.add(`Transform(${source} to ${target})`);
      return this.constant([0], 1);
    }
    if (source === "Tangent" && target !== "Tangent" && !this.options.surface) {
      this.unsupported.add(`Transform(${source} to ${target})`);
      return this.constant([0], 1);
    }
    const input = this.vec(node.inputs.Input, "Transform.Input");
    if (!input) return this.markUnavailable(`Transform ${node.id} has no input`);
    if (source === target) return input;
    if (objectOrWorld(source)) {
      this.approximations.add(TRANSFORM_LOCAL_WORLD_NOTE);
      return input;
    }
    this.approximations.add(TRANSFORM_TANGENT_NOTE);
    return this.emit([input], 3, (o) => (r, texel) => {
      const z = input.n >= 3 ? r[input.reg + 2]! : input.n === 1 ? r[input.reg]! : 0;
      r[o] = z * (texel.nx ?? 0);
      r[o + 1] = z * (texel.nz ?? 0);
      r[o + 2] = z * (texel.ny ?? 1);
      r[o + 3] = 0;
    }, true);
  }

  /**
   * Panner: Coordinate + (SpeedX, SpeedY) x Time. An unwired Time pin is the global time, evaluated at 0 (the coordinate
   * itself, see `TIME_NOTE`); a wired one is evaluated. An unwired Coordinate is the UV set ConstCoordinate.
   */
  private panner(node: GraphNode): Compiled {
    const index = typeof node.constants.ConstCoordinate === "number" ? node.constants.ConstCoordinate : 0;
    let coordinate: Val | undefined;
    if (node.inputs.Coordinate) coordinate = this.vec(node.inputs.Coordinate, "Panner.Coordinate");
    else if (index > 0 && !this.options.allowUvSetFallback) return this.markUnsupported(`TextureCoordinate[${index}]`);
    else {
      if (index > 0) this.approximations.add(`TextureCoordinate[${index}] evaluated as UV0; the mesh UV set ${index} is not in the material`);
      coordinate = this.defaultUv();
    }
    if (!coordinate) return this.markUnavailable(`Panner ${node.id} has no coordinate`);
    if (!node.inputs.Time) {
      this.approximations.add(PANNER_NOTE);
      return coordinate;
    }
    const time = this.vec(node.inputs.Time, "Panner.Time");
    if (!time) return coordinate;
    const speed = node.inputs.Speed
      ? (this.vec(node.inputs.Speed, "Panner.Speed") ?? this.constant([0, 0], 2))
      : this.constant([typeof node.constants.SpeedX === "number" ? node.constants.SpeedX : 0, typeof node.constants.SpeedY === "number" ? node.constants.SpeedY : 0], 2);
    const offset = this.binary(speed, time, (s, t) => s * t);
    const panned = this.binary(coordinate, this.gather(offset, [0, 1]), (c, d) => c + d);
    if (coordinate.uvScale) panned.uvScale = coordinate.uvScale;
    return panned;
  }

  /** Pins of an engine function call in the order the function declares its inputs; an unwired one is null. */
  private orderedPins(node: GraphNode): (GraphInput | null)[] {
    return Object.values(node.inputs).map((input) => input ?? null);
  }

  /** MakeFloatN: the first component of each input in declaration order; an unwired input is zero. */
  private makeFloat(node: GraphNode, width: number, name: string): Compiled {
    const parts = this.orderedPins(node).slice(0, width).map((input) => (input ? (this.vec(input, `${name}.input`) ?? this.constant([0], 1)) : this.constant([0], 1)));
    while (parts.length < width) parts.push(this.constant([0], 1));
    return this.emit(parts, width, (o) => (r) => {
      for (let index = 0; index < 4; index++) r[o + index] = index < width ? r[parts[index]!.reg]! : 0;
    });
  }

  /** SplitComponents: output 0 is the whole RGB value, outputs 1..3 are R, G and B. Exact. */
  private splitComponents(node: GraphNode, output: number, name: string): Compiled {
    const input = this.vec(this.orderedPins(node)[0], `${name}.Input0`);
    if (!input) return this.markUnavailable(`${name} ${node.id} has no input`);
    if (output <= 0) return this.gather(input, [0, 1, 2]);
    return this.gather(input, [Math.min(3, output) - 1]);
  }

  /** BreakOutFloatNComponents: output i is component i of Input0. */
  private breakOut(node: GraphNode, output: number, name: string): Compiled {
    const input = this.vec(this.orderedPins(node)[0], `${name}.Input0`);
    if (!input) return this.markUnavailable(`${name} ${node.id} has no input`);
    return this.gather(input, [Math.max(0, Math.min(3, output))]);
  }

  /** Records an unsupported class and still walks its inputs, so the report names everything beneath it. */
  private unsupportedNode(node: GraphNode): Val {
    this.unsupported.add(node.class);
    this.walkInputs(node);
    return this.constant([0], 1);
  }

  /** Visits every input of an unsupported node so the report is complete; a loop met on the way is not an error. */
  private walkInputs(node: GraphNode): void {
    this.walkingInputs++;
    try {
      for (const input of Object.values(node.inputs)) this.pin(input);
    } finally {
      this.walkingInputs--;
    }
  }

  /**
   * The dump carries no static-switch overrides of a material instance, so an unoverridden switch falls back to the
   * parent's default. When that default branch samples a texture parameter that neither the instance chain nor the
   * graph binds (Unreal would sample its black default), it cannot be the branch the instance is using, and the other
   * branch is taken if every texture it samples is bound. Recorded as an approximation.
   */
  private unoverriddenSwitch(node: GraphNode, stored: boolean): boolean {
    let choice = this.switchChoices.get(node.id);
    if (!choice) {
      choice = { value: stored, flipped: false };
      this.switchChoices.set(node.id, choice);
      const unboundIn = (value: boolean): boolean => {
        const trial = new Compiler(this.graph, this.parameters, this.options, this.switchChoices);
        trial.pin(value ? (node.inputs.A ?? node.inputs.True) : (node.inputs.B ?? node.inputs.False));
        return trial.unboundTextures.size > 0;
      };
      if (unboundIn(stored) && !unboundIn(!stored)) choice = { value: !stored, flipped: true };
      this.switchChoices.set(node.id, choice);
    }
    if (choice.flipped) {
      this.approximations.add(
        `static switch "${node.parameter?.name ?? node.id}" taken as ${choice.value}: its default branch samples a texture parameter the material instance does not bind`,
      );
    }
    return choice.value;
  }

  private branch(node: GraphNode, value: boolean): Compiled {
    const chosen = value ? (node.inputs.A ?? node.inputs.True) : (node.inputs.B ?? node.inputs.False);
    return this.pin(chosen) ?? this.markUnavailable(`${node.class} ${node.id} has no ${value ? "A (true)" : "B (false)"} input`);
  }

  private append(node: GraphNode): Val {
    const a = this.vec(node.inputs.A, "AppendVector.A");
    const b = this.vec(node.inputs.B, "AppendVector.B");
    if (!a || !b) return this.markUnavailable(`AppendVector ${node.id} is missing an input`);
    const n = Math.min(4, a.n + b.n);
    return this.emit([a, b], n, (o) => (r) => {
      let at = 0;
      for (let index = 0; index < a.n && at < 4; index++) r[o + at++] = r[a.reg + (a.n === 1 ? 0 : index)]!;
      for (let index = 0; index < b.n && at < 4; index++) r[o + at++] = r[b.reg + (b.n === 1 ? 0 : index)]!;
    });
  }

  private textureCoordinate(node: GraphNode): Val {
    const rawIndex = node.constants.CoordinateIndex;
    const index = typeof rawIndex === "number" ? rawIndex : 0;
    if (index > 0) {
      if (!this.options.allowUvSetFallback) return this.markUnsupported(`TextureCoordinate[${index}]`);
      this.approximations.add(`TextureCoordinate[${index}] evaluated as UV0; the mesh UV set ${index} is not in the material`);
    }
    return this.uvSource(node.tiling ?? [1, 1]);
  }

  private defaultUvVal: Val | undefined;

  /** The mesh UV0 an unwired UV input of an engine function falls back to (a TextureCoordinate with tiling 1). */
  private defaultUv(): Val {
    this.defaultUvVal ??= this.uvSource([1, 1]);
    return this.defaultUvVal;
  }

  private uvSource([su, sv]: readonly [number, number]): Val {
    const reg = this.allocate();
    this.program.push((r, texel) => {
      r[reg] = texel.u * su;
      r[reg + 1] = texel.v * sv;
    });
    return { kind: "vec", reg, n: 2, konst: false, uvScale: [su, sv] };
  }

  private textureSample(node: GraphNode): Val {
    const cached = this.textureRegisters.get(node.id);
    if (cached) return cached;
    const parameterName = node.class === "TextureSampleParameter2D" && node.parameter ? node.parameter.name.toLowerCase() : undefined;
    let reference = parameterName ? this.parameters.textures.get(parameterName) : undefined;
    // A wired TextureObject pin replaces the node's own Texture property (inside a function that property is only the
    // preview, e.g. DefaultDiffuse), and a TextureObjectParameter there honours the instance's override.
    if (!reference && node.inputs.TextureObject) {
      const object = this.texture(node.inputs.TextureObject, `${node.class}.TextureObject`);
      reference = object?.reference ?? undefined;
    } else reference ??= node.texture ?? undefined;
    if (!reference) this.unboundTextures.add(node.id);
    if (!reference) return this.markUnavailable(`texture sample ${node.id}${parameterName ? ` (parameter "${node.parameter?.name}")` : ""} has no texture`);

    const coordinates = node.inputs.Coordinates ? this.vec(node.inputs.Coordinates, "TextureSample.Coordinates") : undefined;
    const uvScale = coordinates ? coordinates.uvScale : ([1, 1] as [number, number]);
    const sampler = (node.samplerType ?? "Color").toLowerCase();
    const worldCoordinates = coordinates?.world === true;
    const slot: TextureSlot = {
      name: textureObjectName(reference),
      colorSampler: sampler === "color",
      lodFor: (outputSize, raster) => {
        // A world-space coordinate reads the coarsest mip, the texture's average colour.
        if (worldCoordinates) return 40;
        if (!uvScale) return 0;
        const ratio = Math.max(raster.width * uvScale[0], raster.height * uvScale[1]) / outputSize;
        return ratio > 1 ? Math.round(Math.log2(ratio)) : 0;
      },
    };
    this.slots.push(slot);
    const reg = this.allocate();
    const coordinateReg = coordinates ? coordinates.reg : -1;
    this.program.push((r, texel) => {
      const level = slot.level!;
      if (coordinateReg < 0) sampleLevel(level, texel.u, texel.v, r, reg);
      else sampleLevel(level, r[coordinateReg]!, r[coordinateReg + 1]!, r, reg);
    });
    const value: Val = { kind: "vec", reg, n: 4, konst: false };
    this.textureRegisters.set(node.id, value);
    return value;
  }

  private breakAttributes(node: GraphNode, output: number): Compiled {
    const names = node.outputNames && node.outputNames.length > 0 ? node.outputNames : BREAK_ATTRIBUTES;
    const attribute = names[output] ?? BREAK_ATTRIBUTES[output] ?? `output${output}`;
    // Another attribute is never evaluated, so its source is not walked either.
    if (attribute !== "BaseColor") {
      this.unsupported.add(`BreakMaterialAttributes.${attribute}`);
      return this.constant([0], 1);
    }
    const source = this.attrs(node.inputs.MaterialAttributes, "BreakMaterialAttributes.MaterialAttributes");
    return source?.baseColor ?? this.constant([0, 0, 0], 3);
  }

  /**
   * GetMaterialAttributes: output 0 passes the attributes through when `outputNames[0]` says so; the other outputs are
   * typed by `attributeTypes` (offset by that pass-through output). Only BaseColor is carried, so any other attribute
   * on the path is unsupported, and its source is not walked.
   */
  private getAttributes(node: GraphNode, output: number): Compiled {
    const names = node.outputNames ?? [];
    const passThrough = names[0] === "MaterialAttributes";
    if (passThrough && output === 0) return this.attrs(node.inputs.MaterialAttributes, "GetMaterialAttributes.MaterialAttributes") ?? this.markUnavailable(`GetMaterialAttributes ${node.id} has no MaterialAttributes input`);
    const guid = node.attributeTypes?.[output - (passThrough ? 1 : 0)];
    if (guid === undefined) return this.markUnsupported(`GetMaterialAttributes.output${output}`);
    if (!sameGuid(guid, MATERIAL_ATTRIBUTE_GUIDS.BaseColor)) {
      this.unsupported.add(`GetMaterialAttributes.${names[output] || guid}`);
      return this.constant([0], 1);
    }
    const source = this.attrs(node.inputs.MaterialAttributes, "GetMaterialAttributes.MaterialAttributes");
    return source?.baseColor ?? this.constant([0, 0, 0], 3);
  }

  private blendAttributes(node: GraphNode): Compiled {
    if (!node.inputs.A || !node.inputs.B || !node.inputs.Alpha) {
      // The dump of this class carries no pins, so there is nothing to evaluate.
      return this.markUnsupported("BlendMaterialAttributes");
    }
    const a = this.attrs(node.inputs.A, "BlendMaterialAttributes.A");
    const b = this.attrs(node.inputs.B, "BlendMaterialAttributes.B");
    const alpha = this.vec(node.inputs.Alpha, "BlendMaterialAttributes.Alpha");
    if (!a || !b || !alpha) return this.markUnavailable(`BlendMaterialAttributes ${node.id} is missing an input`);
    return this.blendAttrs(a, b, alpha);
  }

  /**
   * SetMaterialAttributes: the incoming attributes with per-attribute overrides. Only BaseColor is carried, and only the
   * two pins that decide it are visited, so a node feeding any other slot (ShadingModel, Normal, WPO, ...) cannot block.
   *
   * Real dumps name the pins `Inputs[i]`: `Inputs[0]` is the incoming attributes and `Inputs[i]` (i >= 1) carries the
   * attribute `attributeTypes[i - 1]`. The BaseColor pin is the one typed with the BaseColor guid; an unwired one keeps the
   * incoming BaseColor. A dump without `attributeTypes` falls back to guessing from the pin names.
   */
  private setAttributes(node: GraphNode): Compiled {
    if (node.attributeTypes) {
      const colourIndex = node.attributeTypes.findIndex((guid) => sameGuid(guid, MATERIAL_ATTRIBUTE_GUIDS.BaseColor));
      const override = colourIndex >= 0 ? node.inputs[`Inputs[${colourIndex + 1}]`] : undefined;
      const incomingPin = node.inputs["Inputs[0]"];
      const incoming = incomingPin ? this.attrs(incomingPin, "SetMaterialAttributes.Inputs[0]") : undefined;
      if (override) {
        const colour = this.vec(override, "SetMaterialAttributes.BaseColor");
        return { kind: "attr", baseColor: colour ?? null };
      }
      if (!incomingPin) {
        // Nothing wired into the attributes at all: Unreal starts from the default attributes, whose BaseColor is black (an
        // eye-occlusion or shadow-card material that only sets Opacity and the shading model).
        this.approximations.add(DEFAULT_ATTRIBUTES_NOTE);
        return { kind: "attr", baseColor: null };
      }
      return incoming ?? this.markUnavailable(`SetMaterialAttributes ${node.id} has no incoming attributes and no BaseColor input`);
    }
    const override = this.namedPin(node, ["basecolor"]);
    const incomingName = this.namedPin(node, ["materialattributes", "inputs0", "inputs"]);
    let incoming: Attrs | undefined;
    if (incomingName) incoming = this.attrs(incomingName, "SetMaterialAttributes.MaterialAttributes");
    else {
      for (const input of Object.values(node.inputs)) {
        if (!input || input === override) continue;
        const compiled = this.pin(input);
        if (compiled?.kind === "attr") {
          incoming = compiled;
          break;
        }
      }
    }
    if (override) {
      const colour = this.vec(override, "SetMaterialAttributes.BaseColor");
      return { kind: "attr", baseColor: colour ?? null };
    }
    return incoming ?? this.markUnavailable(`SetMaterialAttributes ${node.id} has no MaterialAttributes input`);
  }

  /** The wired pin whose name, ignoring case and non-alphanumerics, equals one of `names` (tried in order). */
  private namedPin(node: GraphNode, names: readonly string[]): GraphInput | undefined {
    const normalised = Object.entries(node.inputs).map(([key, input]) => [key.toLowerCase().replace(/[^a-z0-9]/g, ""), input] as const);
    for (const wanted of names) {
      const found = normalised.find(([key, input]) => key === wanted && input);
      if (found) return found[1] ?? undefined;
    }
    return undefined;
  }

  /** Two colour operands of an engine function, by their documented pin names or Input0/Input1. */
  private engineOperands(node: GraphNode, first: string, second: string, name: string): [Val, Val] | undefined {
    const a = this.vec(this.namedPin(node, [first, "input0"]), `${name}.${first}`);
    const b = this.vec(this.namedPin(node, [second, "input1"]), `${name}.${second}`);
    if (!a || !b) {
      this.markUnavailable(`${name} ${node.id} is missing its ${first} or ${second} input`);
      return undefined;
    }
    return [a, b];
  }

  private blendAttrs(base: Attrs, top: Attrs, alpha: Val): Attrs {
    const black = this.constant([0, 0, 0], 3);
    return { kind: "attr", baseColor: this.lerp(base.baseColor ?? black, top.baseColor ?? black, alpha) };
  }

  // -- texture coordinates --------------------------------------------------------------------------------

  /** Component `index` of a value that is constant at compile time (a scalar broadcasts). */
  private constComponent(value: Val, index: number): number {
    return this.registers[value.reg + (value.n === 1 ? 0 : index)]!;
  }

  /**
   * Carries a UV value's `uvScale` through arithmetic with a compile-time constant, so a sample keeps choosing its mip
   * level after `uv * tiling`, `uv / tiling` or `uv + offset`. Anything else drops it (the sample reads level 0).
   */
  private carryUvScale(result: Val, a: Val, b: Val, kind: "mul" | "div" | "add" | "sub"): Val {
    const scaled = (uv: Val, constant: Val, apply: (scale: number, factor: number) => number): void => {
      result.uvScale = [apply(uv.uvScale![0], this.constComponent(constant, 0)), apply(uv.uvScale![1], this.constComponent(constant, 1))];
    };
    if (a.uvScale && b.konst) {
      if (kind === "mul") scaled(a, b, (scale, factor) => scale * Math.abs(factor));
      else if (kind === "div") scaled(a, b, (scale, factor) => scale / Math.max(Math.abs(factor), 1e-6));
      else result.uvScale = a.uvScale;
    } else if (b.uvScale && a.konst) {
      if (kind === "mul") scaled(b, a, (scale, factor) => scale * Math.abs(factor));
      else if (kind === "add") result.uvScale = b.uvScale;
    }
    return result;
  }

  /**
   * Rotates a 2D coordinate about `center` by `turns` full turns: with d = uv - center, uv' = (cos*dx - sin*dy,
   * sin*dx + cos*dy) + center, angle = 2*pi*turns. This is Unreal's `Rotator` matrix with a 0..1 angle. Returns the
   * input untouched when the angle is a compile-time zero.
   */
  private rotateUv(uv: Val, center: Val, turns: Val): Val {
    if (turns.konst && this.registers[turns.reg] === 0) return uv;
    const uvStride = uv.n === 1 ? 0 : 1;
    const centerStride = center.n === 1 ? 0 : 1;
    const rotated = this.emit([uv, center, turns], 2, (o) => (r) => {
      const angle = r[turns.reg]! * 2 * Math.PI;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const cx = r[center.reg]!;
      const cy = r[center.reg + centerStride]!;
      const dx = r[uv.reg]! - cx;
      const dy = r[uv.reg + uvStride]! - cy;
      r[o] = cos * dx - sin * dy + cx;
      r[o + 1] = sin * dx + cos * dy + cy;
      r[o + 2] = r[o + 3] = 0;
    });
    if (uv.uvScale) {
      const magnitude = Math.max(Math.abs(uv.uvScale[0]), Math.abs(uv.uvScale[1]));
      rotated.uvScale = [magnitude, magnitude];
    }
    return rotated;
  }

  /**
   * CustomRotator(Input0 = UVs, Input1 = Rotation Center, Input2 = Rotation Angle (0-1)): the real dumps wire the angle as
   * degrees / -360. Unwired UVs are UV0 and an unwired centre is (0.5, 0.5), the function's defaults. A zero angle is the
   * identity and exact; any other angle uses the Rotator matrix, which is a heuristic because the body is engine content.
   */
  private customRotator(node: GraphNode, name: string): Compiled {
    const wiredUv = this.namedPin(node, ["input0", "uvs"]);
    const uv = wiredUv ? this.vec(wiredUv, `${name}.UVs`) : this.defaultUv();
    if (!uv) return this.markUnavailable(`${name} ${node.id} has no UVs input`);
    const wiredCenter = this.namedPin(node, ["input1", "rotationcenter"]);
    const center = (wiredCenter ? this.vec(wiredCenter, `${name}.Rotation Center`) : undefined) ?? this.constant([0.5, 0.5], 2);
    const wiredAngle = this.namedPin(node, ["input2", "rotationangle0"]);
    const turns = (wiredAngle ? this.vec(wiredAngle, `${name}.Rotation Angle`) : undefined) ?? this.constant([0], 1);
    const result = this.rotateUv(uv, center, turns);
    if (result !== uv) this.approximations.add(`${name}: engine body unavailable; UVs rotated about the centre by the angle as a fraction of a turn (Rotator matrix)`);
    return result;
  }

  /**
   * Datasmith UVEdit(Input0 = UV, Input1 = Tiling_Pivot, Input2 = UV_Tiling, Input3 = Mirror_U, Input4 = Mirror_V,
   * Input5 = Rotation_Pivot, Input6 = W_Rotation, Input7 = UV_Offset; the real dump names them like that). Body not in the
   * pack, so the order is the 3ds Max texture-transform order: scale about the tiling pivot, mirror-repeat the flagged axes,
   * rotate about the rotation pivot (W_Rotation as a fraction of a turn), then add the offset. Always heuristic.
   * Unwired inputs are the identity (no pivot, tiling 1, no mirror, no rotation, no offset).
   */
  private uvEdit(node: GraphNode, name: string): Compiled {
    const wiredUv = node.inputs.Input0;
    const uv = wiredUv ? this.vec(wiredUv, `${name}.UV`) : this.defaultUv();
    if (!uv) return this.markUnavailable(`${name} ${node.id} has no UV input`);
    const optional = (pinName: string, fallback: readonly number[]): Val => (node.inputs[pinName] ? this.vec(node.inputs[pinName], `${name}.${pinName}`) : undefined) ?? this.constant(fallback, fallback.length);
    const tilingPivot = optional("Input1", [0, 0]);
    const tiling = optional("Input2", [1, 1]);
    const mirrorU = this.staticBool(node.inputs.Input3, false, `${name}.Mirror_U`);
    const mirrorV = this.staticBool(node.inputs.Input4, false, `${name}.Mirror_V`);
    const rotationPivot = optional("Input5", [0, 0]);
    const rotation = optional("Input6", [0]);
    const offset = optional("Input7", [0, 0]);
    this.approximations.add(`${name}: engine body unavailable; UV scaled about the tiling pivot, mirrored per axis, rotated (W_Rotation as a fraction of a turn) about the rotation pivot, then offset`);

    const uvStride = uv.n === 1 ? 0 : 1;
    const stride = (value: Val) => (value.n === 1 ? 0 : 1);
    const pivotStride = stride(tilingPivot);
    const tilingStride = stride(tiling);
    const scaled = this.emit([uv, tilingPivot, tiling], 2, (o) => (r) => {
      const pu = r[tilingPivot.reg]!;
      const pv = r[tilingPivot.reg + pivotStride]!;
      r[o] = (r[uv.reg]! - pu) * r[tiling.reg]! + pu;
      r[o + 1] = (r[uv.reg + uvStride]! - pv) * r[tiling.reg + tilingStride]! + pv;
      r[o + 2] = r[o + 3] = 0;
    });
    if (uv.uvScale) scaled.uvScale = [uv.uvScale[0] * Math.abs(this.maybeConstant(tiling, 0)), uv.uvScale[1] * Math.abs(this.maybeConstant(tiling, 1))];
    // Mirror-repeat: x in [0, 1] stays, [1, 2] folds back, period 2.
    const fold = (x: number): number => {
      const wrapped = ((x % 2) + 2) % 2;
      return wrapped > 1 ? 2 - wrapped : wrapped;
    };
    const mirrored =
      mirrorU || mirrorV
        ? this.emit([scaled], 2, (o) => (r) => {
            r[o] = mirrorU ? fold(r[scaled.reg]!) : r[scaled.reg]!;
            r[o + 1] = mirrorV ? fold(r[scaled.reg + 1]!) : r[scaled.reg + 1]!;
            r[o + 2] = r[o + 3] = 0;
          })
        : scaled;
    if (mirrored !== scaled && scaled.uvScale) mirrored.uvScale = scaled.uvScale;
    const rotated = this.rotateUv(mirrored, rotationPivot, rotation);
    const offsetStride = stride(offset);
    const result = this.emit([rotated, offset], 2, (o) => (r) => {
      r[o] = r[rotated.reg]! + r[offset.reg]!;
      r[o + 1] = r[rotated.reg + 1]! + r[offset.reg + offsetStride]!;
      r[o + 2] = r[o + 3] = 0;
    });
    if (rotated.uvScale) result.uvScale = rotated.uvScale;
    return result;
  }

  /** Component of `value` when it is a compile-time constant, else 1 (the scale is then only a mip hint). */
  private maybeConstant(value: Val, index: number): number {
    return value.konst ? this.constComponent(value, index) : 1;
  }

  // -- function calls -------------------------------------------------------------------------------------

  private functionCall(node: GraphNode, output: number): Compiled {
    const name = functionBaseName(node.function);
    const lower = (name ?? "").toLowerCase();
    // Engine functions are matched by name before inlining. Each is trusted only as far as its comment says.
    if (lower === "matlayerblend_standard") return this.layerBlendStandard(node, name!);
    if (lower === "matlayerblend_simple") {
      // Same pin shape as Standard (base, layer, alpha); the engine body is not in the pack, so the per-attribute lerp is inferred.
      this.approximations.add(`${name}: attributes lerped by alpha like MatLayerBlend_Standard; engine body unavailable`);
      return this.layerBlendStandard(node, name!);
    }
    if (lower === "matlayerblend_normalblend") {
      // Only blends a normal into the attributes it receives (Input2 is the normal), so BaseColor is the attributes input's.
      // The UE4 mannequin wires the attributes to Input1 and leaves Input0 empty; accept either, preferring Input1.
      this.approximations.add(`${name}: BaseColor passed through; engine body unavailable`);
      return this.passThrough(node, node.inputs.Input1 ? "Input1" : "Input0", name!);
    }
    if (lower === "matlayerblend_tint") return this.layerBlendTint(node, name!);
    if (lower === "matlayerblend_ao" || lower === "matlayerblend_bakednormal") {
      // These only write ambient occlusion / normal into the blended attributes, so BaseColor of the first
      // layer is the output's BaseColor. The bodies are engine content that the pack does not carry, hence heuristic.
      this.approximations.add(`${name}: BaseColor passed through; engine body unavailable`);
      return this.passThrough(node, "Input0", name!);
    }
    if (lower.includes("fuzzyshading")) {
      // Fuzzy shading darkens the core and brightens grazing angles from the view vector, which a baked
      // texture cannot hold. Ignoring it keeps the albedo; the first input is the colour or attributes.
      this.approximations.add("view-dependent fuzzy shading ignored");
      const pin = node.inputs["Material Input"] ? "Material Input" : "Input0";
      return this.passThrough(node, pin, name!);
    }
    if (lower === "pivotpainter2foliageshader") {
      // It only writes world-position offset; the attributes it receives are the surface the bake wants.
      this.approximations.add(`${name}: world-position offset ignored; engine body unavailable`);
      const wired = this.namedPin(node, ["materialattributes", "materialinput", "input0"]);
      return this.pin(wired ?? Object.values(node.inputs).find((input) => input)) ?? this.markUnavailable(`${name} ${node.id} has no attributes input`);
    }
    if (lower === "blend_overlay") {
      const operands = this.engineOperands(node, "base", "blend", name!);
      if (!operands) return this.constant([0], 1);
      return this.binary(operands[0], operands[1], (x, y) => (x < 0.5 ? 2 * x * y : 1 - 2 * (1 - x) * (1 - y)));
    }
    if (lower === "cheapcontrast" || lower === "cheapcontrast_rgb") {
      const operands = this.engineOperands(node, "in", "contrast", name!);
      if (!operands) return this.constant([0], 1);
      const [input, contrast] = operands;
      const stretched = this.lerp(this.unary(contrast, (x) => -x), this.unary(contrast, (x) => 1 + x), input);
      return this.unary(stretched, (x) => (x < 0 ? 0 : x > 1 ? 1 : x));
    }
    if (lower === "hueshift") return this.hueShift(node, name!);
    if (!node.fn?.outputs.some(Boolean)) {
      const layered = this.layerFunction(node, lower, name!, output);
      if (layered) return layered;
    }
    if (lower === "boundingboxbased_0-1_uvw" && !node.fn?.outputs.some(Boolean)) {
      this.approximations.add(BOUNDING_BOX_UVW_NOTE);
      const reg = this.allocate();
      this.program.push((r, texel) => {
        r[reg] = texel.u;
        r[reg + 1] = texel.v;
        r[reg + 2] = 0.5;
        r[reg + 3] = 1;
      });
      return { kind: "vec", reg, n: 3, konst: false };
    }
    if (lower === "objectscale" && !node.fn?.outputs.some(Boolean)) {
      // Outputs: Scale XYZ (vector), Scale X, Scale Y, Scale Z. The scale of the placed instance is not known to a bake.
      this.approximations.add(OBJECT_SCALE_NOTE);
      return output === 0 ? this.constant([1, 1, 1], 3) : this.constant([1], 1);
    }
    if (lower === "worldalignedblend" && !node.fn?.outputs.some(Boolean)) {
      // Every output (Alpha, w/ Vertex Normals, w/ Explicit Normal) is a 0..1 mask driven by a world-space normal.
      for (const input of Object.values(node.inputs)) this.pin(input);
      if (!this.options.surface) {
        this.approximations.add(WORLD_ALIGNED_BLEND_NOTE);
        return this.constant([0.5], 1);
      }
      // The mesh's own vertex normals are known per texel: up-facing surface gets the blend. The engine body is not in the
      // pack, so the formula is inferred from the pins (Input2 sharpness, Input3 bias; an artist's -2 bias with sharpness 10
      // puts the transition at a normal's up component of 0.2 to 0.3).
      this.approximations.add(WORLD_ALIGNED_BLEND_SURFACE_NOTE);
      const sharpness = node.inputs.Input2 ? this.vec(node.inputs.Input2, `${name}.Input2`) ?? this.constant([1], 1) : this.constant([1], 1);
      const bias = node.inputs.Input3 ? this.vec(node.inputs.Input3, `${name}.Input3`) ?? this.constant([0], 1) : this.constant([0], 1);
      return this.emit([sharpness, bias], 1, (o) => (r, texel) => {
        const alpha = (texel.ny ?? 0) * r[sharpness.reg]! + r[bias.reg]!;
        r[o] = r[o + 1] = r[o + 2] = r[o + 3] = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
      }, true);
    }
    if (lower === "splitcomponents" && !node.fn?.outputs.some(Boolean)) return this.splitComponents(node, output, name!);
    // A pack that carries its own body (a Datasmith project holds UVEdit) is evaluated from that body instead.
    const hasBody = node.fn?.outputs[output] != null;
    if (lower === "customrotator" && !hasBody) return this.customRotator(node, name!);
    if (lower === "uvedit" && !hasBody) return this.uvEdit(node, name!);
    if (lower === "convertfromdiffspec" && !hasBody) {
      const attribute = node.outputNames?.[output] ?? ["BaseColor", "Metallic", "Specular"][output] ?? `output${output}`;
      if (attribute !== "BaseColor") {
        // Only BaseColor is evaluated; the Metallic/Specular split of the diffuse+specular pair is the engine body's.
        this.unsupported.add(`${name}.${attribute}`);
        return this.constant([0], 1);
      }
      this.approximations.add("ConvertFromDiffSpec: BaseColor taken from the diffuse input; engine body unavailable");
      return this.passThrough(node, "Input0", name!);
    }
    if (lower === "dithertemporalaa") {
      // Input0 is the opacity, Input1 the dither pattern: the result is a dithered opacity, which BaseColor never reads.
      this.approximations.add("DitherTemporalAA: dithering ignored; engine body unavailable");
      return this.passThrough(node, "Input0", name!);
    }
    if (lower === "flattennormal") {
      // Input0 is a normal, Input1 the flatten amount. A normal does not feed BaseColor, so Input0 stands in for the result.
      this.approximations.add("FlattenNormal: normal-only function; BaseColor path unaffected (engine body unavailable)");
      return this.passThrough(node, "Input0", name!);
    }
    if (lower === "speedtreecolorvariation") {
      // Per-instance colour variation driven by instance and world data, which a baked texture cannot hold.
      // The colour input is the first wired pin named like a colour, else Input0, else the first wired pin.
      const wired = Object.entries(node.inputs).filter(([, input]) => input);
      const chosen = wired.find(([key]) => key.toLowerCase().includes("color")) ?? wired.find(([key]) => key === "Input0") ?? wired[0];
      if (chosen) {
        this.approximations.add(`${name}: per-instance colour variation ignored; engine body unavailable`);
        return this.passThrough(node, chosen[0], name!);
      }
      // Nothing is connected, so there is no colour to pass through.
      this.unsupported.add(name!);
      this.classes.add(name!);
      return this.constant([0], 1);
    }
    const inner = node.fn?.outputs[output];
    // Plain vector plumbing of the engine library. A pack that carries its own body of the same name keeps its body.
    if (!node.fn?.outputs.some(Boolean)) {
      const makeWidth = /^makefloat([234])$/.exec(lower)?.[1];
      if (makeWidth) return this.makeFloat(node, Number(makeWidth), name!);
      if (/^breakoutfloat[234]components$/.test(lower)) return this.breakOut(node, output, name!);
    }
    if (inner) {
      const innerNode = this.nodes.get(inner);
      if (!innerNode) return this.markUnavailable(`function ${name ?? node.id} output refers to missing node ${inner}`);
      return this.nodeOutput(innerNode, 0);
    }
    // No body: an engine function the evaluator does not know. Walk its inputs so the report is complete.
    this.unsupported.add(name ?? "FunctionCall");
    if (name) this.classes.add(name);
    this.walkInputs(node);
    return this.constant([0], 1);
  }

  /**
   * HueShift(Input0 = colour, Input1 = shift): the engine body is not in the pack, so Input1 is read as a fraction of
   * a full turn and the colour's hue is rotated by it (saturation and value unchanged). A zero or unwired shift is
   * the identity and exact; anything else is a heuristic.
   */
  private hueShift(node: GraphNode, name: string): Compiled {
    const colour = this.vec(this.namedPin(node, ["input0"]), `${name}.Input0`);
    if (!colour) return this.markUnavailable(`${name} ${node.id} has no Input0 input`);
    const wired = this.namedPin(node, ["input1"]);
    const shift = wired ? this.vec(wired, `${name}.Input1`) : undefined;
    if (!shift || (shift.konst && this.registers[shift.reg] === 0)) return colour;
    this.approximations.add(`${name}: engine body unavailable; hue rotated by Input1 as a fraction of a turn`);
    return this.emit([colour, shift], colour.n, (o) => (r) => {
      const red = r[colour.reg]!;
      const green = r[colour.reg + 1]!;
      const blue = r[colour.reg + 2]!;
      const max = Math.max(red, green, blue);
      const min = Math.min(red, green, blue);
      const chroma = max - min;
      let hue = 0;
      if (chroma > 0) {
        if (max === red) hue = ((green - blue) / chroma) % 6;
        else if (max === green) hue = (blue - red) / chroma + 2;
        else hue = (red - green) / chroma + 4;
        hue /= 6;
      }
      const turned = (((hue + r[shift.reg]!) % 1) + 1) % 1;
      const sector = turned * 6;
      const second = chroma * (1 - Math.abs((sector % 2) - 1));
      const floor = min;
      const index = Math.min(5, Math.floor(sector));
      const [dr, dg, db] = [[chroma, second, 0], [second, chroma, 0], [0, chroma, second], [0, second, chroma], [second, 0, chroma], [chroma, 0, second]][index]!;
      r[o] = dr! + floor;
      r[o + 1] = dg! + floor;
      r[o + 2] = db! + floor;
      r[o + 3] = r[colour.reg + 3]!;
    });
  }

  /**
   * Engine content functions of the layered-material library and its helpers, recognised by name when the pack carries no
   * body. Each is inferred from its pins (the bodies are engine content), so each records an approximation. Returns
   * undefined for a function this does not handle.
   */
  private layerFunction(node: GraphNode, lower: string, name: string, output: number): Compiled | undefined {
    switch (lower) {
      // Attribute -> attribute functions that write something other than BaseColor: Input0 is the incoming attributes.
      case "matlayerblend_emissive":
      case "matlayerblend_modulateroughness":
      case "matlayerblend_modulatespecular":
      case "matlayerblend_replacenormals":
      case "matlayerblend_normalflatten":
      case "matlayerblend_overrideworldpositionoffset":
      case "matlayerblend_lightmassreplace": // Input0 is the realtime attributes, Input1 the Lightmass-only colour.
        this.approximations.add(MAT_LAYER_PASS_NOTE(name));
        return this.passThrough(node, "Input0", name);
      case "matlayerblend_topnormal":
        // (Input0 = base, Input1 = top, Input2 = alpha): the top layer's normal is kept whole; the other attributes blend
        // like MatLayerBlend_Standard.
        this.approximations.add(`${name}: BaseColor lerped by alpha like MatLayerBlend_Standard; engine body unavailable`);
        return this.layerBlendStandard(node, name);
      case "matlayerblend_breakbasecolor": {
        // One output, BaseColor, of the attributes on Input0.
        const source = this.attrs(node.inputs.Input0, `${name}.Input0`);
        if (!source) return this.markUnavailable(`${name} ${node.id} has no Input0`);
        this.approximations.add(`${name}: the BaseColor of Input0; engine body unavailable`);
        return source.baseColor ?? this.constant([0, 0, 0], 3);
      }
      case "matlayerblend_breaknormal":
        // The attributes on Input0 are not walked: only their normal is read, and a normal is not carried.
        this.approximations.add(BREAK_NORMAL_NOTE);
        return this.constant([0, 0, 1], 3);
      case "matlayerblend_overridebasecolor": {
        // (Input0 = attributes, Input1 = colour, Input2 = alpha, unwired = a full override).
        const base = this.attrs(node.inputs.Input0, `${name}.Input0`);
        if (!base) return this.markUnavailable(`${name} ${node.id} has no Input0`);
        this.approximations.add(`${name}: BaseColor replaced by Input1 (lerped by Input2 when wired); engine body unavailable`);
        const colour = node.inputs.Input1 ? this.vec(node.inputs.Input1, `${name}.Input1`) : undefined;
        if (!colour) return base;
        if (!node.inputs.Input2) return { kind: "attr", baseColor: colour };
        const alpha = this.vec(node.inputs.Input2, `${name}.Input2`) ?? this.constant([1], 1);
        return { kind: "attr", baseColor: this.lerp(base.baseColor ?? this.constant([0, 0, 0], 3), colour, alpha) };
      }
      case "matlayerblend_multiplybasecolor": {
        // (Input0 = attributes, Input1 = colour, Input2 = amount, unwired = 1): BaseColor x lerp(1, colour, amount).
        const base = this.attrs(node.inputs.Input0, `${name}.Input0`);
        if (!base) return this.markUnavailable(`${name} ${node.id} has no Input0`);
        this.approximations.add(`${name}: BaseColor multiplied by lerp(1, Input1, Input2); engine body unavailable`);
        const colour = node.inputs.Input1 ? this.vec(node.inputs.Input1, `${name}.Input1`) : undefined;
        if (!colour || !base.baseColor) return base;
        const amount = node.inputs.Input2 ? (this.vec(node.inputs.Input2, `${name}.Input2`) ?? this.constant([1], 1)) : this.constant([1], 1);
        return { kind: "attr", baseColor: this.binary(base.baseColor, this.lerp(this.constant([1], 1), colour, amount), (x, y) => x * y) };
      }
      case "matlayerblend_tenlayerblend":
        return this.tenLayerBlend(node, name);
      case "vectorlength": {
        const wired = this.namedPin(node, ["input0", "vector", "input"]) ?? Object.values(node.inputs).find((input) => input);
        const input = this.vec(wired, `${name}.Input0`);
        if (!input) return this.markUnavailable(`${name} ${node.id} has no input`);
        this.approximations.add(VECTOR_LENGTH_NOTE);
        const n = input.n;
        return this.emit([input], 1, (o) => (r) => {
          let sum = 0;
          for (let index = 0; index < n; index++) sum += r[input.reg + index]! ** 2;
          r[o] = r[o + 1] = r[o + 2] = r[o + 3] = Math.sqrt(sum);
        });
      }
      case "remapvaluerange":
        return this.remapValueRange(node, name);
      case "lineargradient":
        return this.linearGradient(node, name, output);
      case "lerp_scratchgrime": {
        // (Input0 = base colour, Input1 = scratch colour, Input2 = grime colour, Input3 = scratch mask, Input4 = grime mask):
        // lerp(lerp(base, scratch, scratch mask), grime, grime mask). An unwired colour or mask leaves its stage out.
        let result = this.vec(node.inputs.Input0, `${name}.Input0`);
        if (!result) return this.markUnavailable(`${name} ${node.id} has no Input0`);
        this.approximations.add(`${name}: lerp(lerp(base, scratch, scratch mask), grime, grime mask); engine body unavailable`);
        for (const [colourPin, maskPin] of [["Input1", "Input3"], ["Input2", "Input4"]] as const) {
          if (!node.inputs[colourPin] || !node.inputs[maskPin]) continue;
          const colour = this.vec(node.inputs[colourPin], `${name}.${colourPin}`);
          const mask = this.vec(node.inputs[maskPin], `${name}.${maskPin}`);
          if (colour && mask) result = this.lerp(result, colour, mask);
        }
        return result;
      }
      case "metallicshading":
        // A view-dependent sheen over the colour on Input0; like FuzzyShading, the albedo is what a bake can hold.
        this.approximations.add(`${name}: view-dependent shading ignored, Input0 colour passed through; engine body unavailable`);
        return this.passThrough(node, "Input0", name);
      case "worldalignedtexture":
        this.approximations.add(WORLD_ALIGNED_TEXTURE_NOTE);
        return this.textureMean(node, "Input0", name);
      case "flowmaps_simple": {
        // Outputs Diffuse, Diffuse Alpha, Normal, Distortion; Input0 is the diffuse texture object, Input1 the normal one.
        if (output === 2) {
          this.approximations.add(`${name}: Normal stands in as flat (0, 0, 1); engine body unavailable`);
          return this.constant([0, 0, 1], 3);
        }
        if (output > 2) return this.markUnsupported(`${name}.${node.outputNames?.[output] ?? `output${output}`}`);
        this.approximations.add(FLOW_MAP_NOTE);
        const mean = this.textureMean(node, "Input0", name);
        return mean.kind === "vec" && output === 1 ? this.gather(mean, [3]) : mean;
      }
      default:
        return undefined;
    }
  }

  /**
   * RemapValueRange(Input0 = Input, Input1 = Input Low, Input2 = Input High, Input3 = Target Low, Input4 = Target High), see
   * `REMAP_VALUE_RANGE_NOTE`. Every pin must be wired: the function's own defaults are engine content the pack does not carry.
   */
  private remapValueRange(node: GraphNode, name: string): Compiled {
    const pins = ["Input0", "Input1", "Input2", "Input3", "Input4"].map((pinName) => (node.inputs[pinName] ? this.vec(node.inputs[pinName], `${name}.${pinName}`) : undefined));
    if (pins.some((value) => value === undefined)) return this.markUnavailable(`${name} ${node.id} needs all five of Input0..Input4 wired (its defaults are engine content)`);
    const [input, inLow, inHigh, outLow, outHigh] = pins as Val[];
    this.approximations.add(REMAP_VALUE_RANGE_NOTE);
    const span = this.binary(inHigh!, inLow!, (high, low) => high - low);
    const fraction = this.binary(this.binary(input!, inLow!, (x, low) => x - low), span, (x, y) => x / (Math.abs(y) < 1e-6 ? (y < 0 ? -1e-6 : 1e-6) : y));
    return this.lerp(outLow!, outHigh!, fraction);
  }

  /** LinearGradient: see `LINEAR_GRADIENT_NOTE`. An output named neither U nor V (or a third output) is unsupported. */
  private linearGradient(node: GraphNode, name: string, output: number): Compiled {
    const outputName = node.outputNames?.[output] ?? "";
    const axis = /^u/i.test(outputName) ? 0 : /^v/i.test(outputName) ? 1 : outputName === "" && output < 2 ? output : -1;
    if (axis < 0) return this.markUnsupported(`${name}.${outputName || `output${output}`}`);
    const wired = Object.values(node.inputs).find((input) => input);
    const uv = wired ? this.vec(wired, `${name}.UVs`) : this.defaultUv();
    if (!uv) return this.markUnavailable(`${name} ${node.id} has no UV input`);
    this.approximations.add(LINEAR_GRADIENT_NOTE);
    return this.gather(uv, [uv.n === 1 ? 0 : axis]);
  }

  /** See `TEN_LAYER_NOTE`. An unwired layer or alpha leaves that layer out. */
  private tenLayerBlend(node: GraphNode, name: string): Compiled {
    const count = Object.keys(node.inputs).filter((pinName) => /^Input\d+$/.test(pinName)).length;
    if (count !== 22) return this.markUnsupported(`${name}(${count} inputs)`);
    let result = this.attrs(node.inputs.Input20, `${name}.Input20`);
    if (!result) {
      this.approximations.add(TEN_LAYER_DEFAULT_BASE_NOTE);
      result = { kind: "attr", baseColor: null };
    }
    this.approximations.add(TEN_LAYER_NOTE);
    for (let layer = 9; layer >= 0; layer--) {
      const topPin = node.inputs[`Input${layer * 2}`];
      const alphaPin = node.inputs[`Input${layer * 2 + 1}`];
      if (!topPin || !alphaPin) continue;
      const top = this.attrs(topPin, `${name}.Input${layer * 2}`);
      const alpha = this.vec(alphaPin, `${name}.Input${layer * 2 + 1}`);
      if (!top || !alpha) return this.markUnavailable(`${name} ${node.id} layer ${layer} could not be read`);
      result = this.blendAttrs(result, top, alpha);
    }
    return result;
  }

  /** The average colour (RGBA, the coarsest mip) of the texture object on `pinName`, for engine functions whose sampling follows world position or time. */
  private textureMean(node: GraphNode, pinName: string, name: string): Compiled {
    const object = this.texture(node.inputs[pinName], `${name}.${pinName}`);
    if (!object) return this.markUnavailable(`${name} ${node.id} has no texture object`);
    if (!object.reference) {
      this.unboundTextures.add(node.id);
      return this.markUnavailable(`${name} ${node.id} samples a texture object nothing binds`);
    }
    const key = `${node.id}#mean`;
    const cached = this.textureRegisters.get(key);
    if (cached) return cached;
    const slot: TextureSlot = { name: textureObjectName(object.reference), colorSampler: object.samplerType.toLowerCase() === "color", lodFor: () => 40 };
    this.slots.push(slot);
    const reg = this.allocate();
    this.program.push((r) => sampleLevel(slot.level!, 0.5, 0.5, r, reg));
    const value: Val = { kind: "vec", reg, n: 4, konst: false };
    this.textureRegisters.set(key, value);
    return value;
  }

  private passThrough(node: GraphNode, pinName: string, name: string): Compiled {
    const wired = node.inputs[pinName];
    return this.pin(wired) ?? this.markUnavailable(`${name} ${node.id} has no ${pinName} input`);
  }

  /**
   * MatLayerBlend_Standard(Input0 = base, Input1 = layer, Input2 = alpha) is BlendMaterialAttributes: every
   * attribute is lerp(base, layer, alpha). That is the only behaviour the pin shape (three attribute/alpha
   * inputs) allows, and it is what the Soul Cave masks drive, so BaseColor is treated as exact. More layers
   * continue the pattern (Input3 = layer, Input4 = alpha, ...): each is lerped over the running result.
   */
  private layerBlendStandard(node: GraphNode, name: string): Compiled {
    const count = Object.keys(node.inputs).filter((pinName) => /^Input\d+$/.test(pinName)).length;
    if (count < 3 || count % 2 === 0) return this.markUnsupported(`${name}(${count} inputs)`);
    let result = this.attrs(node.inputs.Input0, `${name}.Input0`);
    if (!result) return this.markUnavailable(`${name} ${node.id} has no Input0`);
    for (let layer = 1; layer + 1 < count; layer += 2) {
      const top = this.attrs(node.inputs[`Input${layer}`], `${name}.Input${layer}`);
      const alpha = this.vec(node.inputs[`Input${layer + 1}`], `${name}.Input${layer + 1}`);
      if (!top || !alpha) return this.markUnavailable(`${name} ${node.id} is missing Input${layer} or Input${layer + 1}`);
      result = this.blendAttrs(result, top, alpha);
    }
    return result;
  }

  /**
   * MatLayerBlend_Tint(Input0 = attributes, Input1 = Tint colour, Input2 = Alpha): the real graphs wire an "Overall Material
   * Brightness" parameter (default white) to the tint and an edge mask texture to the alpha, so the tint multiplies BaseColor,
   * weighted by the alpha: BaseColor x lerp(1, Tint, Alpha). An unwired alpha is 1, an unwired tint the identity. Heuristic:
   * the engine body is not in the pack.
   */
  private layerBlendTint(node: GraphNode, name: string): Compiled {
    const base = this.attrs(node.inputs.Input0, `${name}.Input0`);
    if (!base) return this.markUnavailable(`${name} ${node.id} has no Input0`);
    this.approximations.add(MAT_LAYER_TINT_NOTE);
    const tint = node.inputs.Input1 ? this.vec(node.inputs.Input1, `${name}.Input1`) : undefined;
    if (!tint || !base.baseColor) return base;
    const alpha = node.inputs.Input2 ? this.vec(node.inputs.Input2, `${name}.Input2`) ?? this.constant([1], 1) : this.constant([1], 1);
    const weight = this.lerp(this.constant([1], 1), tint, alpha);
    return { kind: "attr", baseColor: this.binary(base.baseColor, weight, (x, y) => x * y) };
  }

  // -- entry ----------------------------------------------------------------------------------------------

  /** Compiles the BaseColor output; returns the value, or undefined when the graph has no BaseColor path. */
  compileBaseColor(graph: MaterialGraph): Val | undefined {
    const wired = graph.outputs.baseColor ?? graph.outputs.materialAttributes;
    if (!wired) return undefined;
    const compiled = this.pin(wired);
    if (!compiled) return undefined;
    if (compiled.kind === "vec") return compiled;
    if (compiled.kind === "tex") return this.markUnavailable("BaseColor is wired to a texture object, not a value");
    return compiled.baseColor ?? this.constant([0, 0, 0], 3);
  }

  /** Compiles the Opacity or OpacityMask pin; undefined when it is unwired or carries a material-attributes struct. */
  compileAlpha(graph: MaterialGraph, pin: "opacity" | "opacityMask"): Val | undefined {
    const wired = graph.outputs[pin];
    if (!wired) return undefined;
    const compiled = this.pin(wired);
    return compiled?.kind === "vec" ? compiled : undefined;
  }
}

function compile(graph: MaterialGraph, parameters: GraphParameters, options: CompileOptions) {
  const compiler = new Compiler(graph, parameters, options);
  const value = compiler.compileBaseColor(graph);
  return { compiler, value };
}

const NO_PARAMETERS: GraphParameters = { textures: new Map(), vectors: new Map(), scalars: new Map(), switches: new Map() };

/**
 * Distinct node classes on the active path of an output, plus the names of engine functions that had no
 * body to inline. Switches follow their active branch only. Works without textures, so the report can
 * build its histogram for materials that never bake.
 */
export function graphPathClasses(graph: MaterialGraph, output: "baseColor", parameters: GraphParameters = NO_PARAMETERS): string[] {
  if (output !== "baseColor") return [];
  const { compiler } = compile(graph, parameters, { allowUvSetFallback: true });
  return [...compiler.classes].sort();
}

// ---------------------------------------------------------------------------------------------------------
// Particle materials

/**
 * The reason a graph's BaseColor is set per particle, or undefined. `DynamicParameter` only carries a value inside a
 * particle emitter (Cascade's or Niagara's dynamic-parameter module), so a BaseColor path that reads it belongs to a
 * particle material: the emitter supplies the coordinates, timing and tint, and the package alone does not fix an albedo.
 * Only that node qualifies: `ParticleColor` alone has a well-defined value off an emitter (white) and is baked as such.
 */
export function particleDrivenBaseColor(graph: MaterialGraph): string | undefined {
  if (graph.truncated || graph.error || !graph.outputs.baseColor) return undefined;
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  const stack = [graph.outputs.baseColor.node];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = nodes.get(id);
    if (!node) continue;
    if (node.class === "DynamicParameter") {
      return `${graph.material} reads DynamicParameter on its BaseColor path: a particle material whose coordinates and colour are set per particle by its emitter, so the package has no fixed albedo`;
    }
    for (const input of [...Object.values(node.inputs), node.coordinates]) if (input) stack.push(input.node);
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------
// Emissive-only effect materials

export interface EmissiveEffect {
  /** Object names (no package path) of the textures on the Emissive path. */
  textures: string[];
  reason: string;
}

/**
 * A graph whose only colour output is Emissive: no BaseColor and no MaterialAttributes pin, Emissive wired. That is an
 * unlit or additive effect (flipbook splash, spark, flying paper): its colour is emitted light, often multiplied by a
 * particle or collection colour, so no albedo exists in the package and a lit PBR base colour cannot reproduce it.
 * `textures` are the textures sampled on the Emissive path (through nodes and their coordinate pins; function bodies
 * are not entered), so the importer can tell an emissive mask from a real albedo.
 */
export function emissiveOnlyEffect(graph: MaterialGraph): EmissiveEffect | undefined {
  if (graph.truncated || graph.error) return undefined;
  const { baseColor, materialAttributes, emissive } = graph.outputs;
  if (baseColor || materialAttributes || !emissive) return undefined;
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  const textures = new Set<string>();
  const stack = [emissive.node];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const node = nodes.get(id);
    if (!node) continue;
    if (node.texture) {
      const reference = node.texture;
      const afterSlash = reference.slice(reference.lastIndexOf("/") + 1);
      textures.add(afterSlash.includes(".") ? afterSlash.slice(afterSlash.lastIndexOf(".") + 1) : afterSlash);
    }
    for (const input of [...Object.values(node.inputs), node.coordinates]) if (input) stack.push(input.node);
  }
  return {
    textures: [...textures].sort(),
    reason: `${graph.material} wires only Emissive (no BaseColor): an unlit or additive effect whose colour is emitted light, so the package has no albedo`,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Bake

/**
 * Loads the textures a compiled program samples, then runs it once per texel of a size x size grid and hands each
 * texel's registers to `onTexel`. Returns a reason when a texture is missing or unusable, otherwise undefined.
 */
async function evaluate(
  compiler: Compiler,
  request: BakeRequest,
  size: number,
  onTexel: (x: number, y: number, registers: Float64Array) => void,
): Promise<string | undefined> {
  // Load each texture once, then give every sample node its mip level.
  const rasters = new Map<string, TextureRaster>();
  for (const slot of compiler.slots) {
    if (rasters.has(slot.name)) continue;
    const raster = await request.loadTexture(slot.name);
    if (!raster) return `texture ${slot.name} could not be loaded`;
    if (raster.width < 1 || raster.height < 1 || raster.rgba.length < raster.width * raster.height * 4) {
      return `texture ${slot.name} has an unusable raster (${raster.width}x${raster.height}, ${raster.rgba.length} bytes)`;
    }
    rasters.set(slot.name, raster);
  }
  const levels = new Map<string, Level>();
  const levelFor = (name: string, decode: boolean, lod: number): Level => {
    const key = `${name}|${decode ? "srgb" : "raw"}|${lod}`;
    const known = levels.get(key);
    if (known) return known;
    let level: Level;
    if (lod <= 0) {
      const raster = rasters.get(name)!;
      level = { width: raster.width, height: raster.height, data: raster.rgba, lut: decode ? SRGB_TO_LINEAR : BYTE_TO_UNIT };
    } else {
      const parent = levelFor(name, decode, lod - 1);
      level = parent.width === 1 && parent.height === 1 ? parent : downsample(parent);
    }
    levels.set(key, level);
    return level;
  };
  for (const slot of compiler.slots) {
    const raster = rasters.get(slot.name)!;
    slot.level = levelFor(slot.name, raster.srgb && slot.colorSampler, slot.lodFor(size, raster));
  }

  const registers = compiler.registers.slice(0, Math.max(4, compiler.registerCount * 4));
  const program = compiler.program;
  const texel: TexelContext = { u: 0, v: 0 };
  const surface = request.surface;
  for (let y = 0; y < size; y++) {
    texel.v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      texel.u = (x + 0.5) / size;
      if (surface) {
        const sx = Math.min(surface.width - 1, Math.floor(((x + 0.5) / size) * surface.width));
        const sy = Math.min(surface.height - 1, Math.floor(((y + 0.5) / size) * surface.height));
        const at = (sy * surface.width + sx) * 3;
        texel.nx = surface.normals[at]!;
        texel.ny = surface.normals[at + 1]!;
        texel.nz = surface.normals[at + 2]!;
      }
      for (let index = 0; index < program.length; index++) program[index]!(registers, texel);
      onTexel(x, y, registers);
    }
  }
  return undefined;
}

/** Alpha bytes at or above / at or below these count as fully opaque / fully clear. */
const ALPHA_OPAQUE = 242;
const ALPHA_CLEAR = 13;
/** A baked opacity with at least this share of fully opaque or fully clear texels is a cut-out, not a gradient. */
const BINARY_CUTOUT_SHARE = 0.9;

export async function bakeGraph(request: BakeRequest): Promise<BakeResult> {
  const size = Math.max(1, Math.floor(request.size ?? DEFAULT_SIZE));
  const { graph } = request;
  if (graph.truncated) return { status: "unavailable", reason: `graph ${graph.material} was truncated at ${graph.nodeCount} nodes` };
  if (graph.error) return { status: "unavailable", reason: `graph ${graph.material} could not be dumped: ${graph.error}` };
  if (!graph.outputs.baseColor && !graph.outputs.materialAttributes) {
    return { status: "unavailable", reason: `graph ${graph.material} has no BaseColor output` };
  }

  const { compiler, value } = compile(graph, request.parameters, { allowUvSetFallback: request.allowUvSetFallback === true, vertexColor: request.vertexColor, particleColor: request.particleColor, surface: request.surface !== undefined, objectRadius: request.objectRadius });
  if (compiler.unsupported.size > 0) {
    const unsupported = [...compiler.unsupported].sort();
    return { status: "unsupported", unsupported, reason: `BaseColor of ${graph.material} depends on unsupported nodes: ${unsupported.join(", ")}` };
  }
  if (compiler.unavailable.length > 0 || !value) {
    return { status: "unavailable", reason: compiler.unavailable.length > 0 ? compiler.unavailable.join("; ") : `graph ${graph.material} has no readable BaseColor path` };
  }

  const out = Buffer.alloc(size * size * 4);
  const sums = [0, 0, 0];
  const failure = await evaluate(compiler, request, size, (x, y, registers) => {
    const at = (y * size + x) * 4;
    const channelStep = value.n === 1 ? 0 : 1;
    for (let channel = 0; channel < 3; channel++) {
      const byte = Math.round(linearToSrgb(registers[value.reg + channel * channelStep]!) * 255);
      out[at + channel] = byte;
      sums[channel]! += byte;
    }
    out[at + 3] = 255;
  });
  if (failure) return { status: "unavailable", reason: failure };

  const approximations = new Set(compiler.approximations);
  const alphaPin = request.alpha && graph.outputs[request.alpha] ? request.alpha : undefined;
  let alphaSummary: { pin: "opacity" | "opacityMask"; opaqueShare: number; binary: boolean } | undefined;
  if (alphaPin) {
    // The cut-out is its own compile, so an alpha path the evaluator cannot read costs only the cut-out: the colour stays.
    const alphaCompiler = new Compiler(graph, request.parameters, { allowUvSetFallback: request.allowUvSetFallback === true, vertexColor: request.vertexColor, particleColor: request.particleColor, surface: request.surface !== undefined, objectRadius: request.objectRadius });
    const alphaValue = alphaCompiler.compileAlpha(graph, alphaPin);
    if (alphaCompiler.unsupported.size > 0 || alphaCompiler.unavailable.length > 0 || !alphaValue) {
      const why = alphaCompiler.unsupported.size > 0 ? `unsupported nodes ${[...alphaCompiler.unsupported].sort().join(", ")}` : alphaCompiler.unavailable.join("; ") || "no readable path";
      approximations.add(`${alphaPin} could not be evaluated (${why}); the base colour stays fully opaque`);
    } else if (alphaValue.konst) {
      // A uniform opacity (a scalar parameter, a constant) is not a cut-out: the section's colour factor carries it.
    } else {
      const alphaFailure = await evaluate(alphaCompiler, request, size, (x, y, registers) => {
        out[(y * size + x) * 4 + 3] = Math.round(Math.min(1, Math.max(0, registers[alphaValue.reg]!)) * 255);
      });
      if (alphaFailure) {
        for (let at = 3; at < out.length; at += 4) out[at] = 255;
        approximations.add(`${alphaPin} could not be evaluated (${alphaFailure}); the base colour stays fully opaque`);
      } else {
        for (const note of alphaCompiler.approximations) approximations.add(note);
        let opaque = 0;
        let extreme = 0;
        for (let at = 3; at < out.length; at += 4) {
          if (out[at]! >= ALPHA_OPAQUE) opaque++;
          if (out[at]! >= ALPHA_OPAQUE || out[at]! <= ALPHA_CLEAR) extreme++;
        }
        const texels = out.length / 4;
        alphaSummary = { pin: alphaPin, opaqueShare: opaque / texels, binary: extreme / texels >= BINARY_CUTOUT_SHARE };
      }
    }
  }
  const png = await sharp(out, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
  const pixels = size * size * 255;
  return {
    status: "baked",
    png,
    width: size,
    height: size,
    meanRgb: [sums[0]! / pixels, sums[1]! / pixels, sums[2]! / pixels],
    confidence: approximations.size === 0 ? "exact" : "heuristic",
    approximations: [...approximations].sort(),
    texturesUsed: [...new Set(compiler.slots.map((slot) => slot.name))].sort(),
    ...(alphaSummary ? { alpha: alphaSummary } : {}),
  };
}
