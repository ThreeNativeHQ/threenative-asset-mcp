import sharp from "sharp";
import type { GraphInput, GraphNode, MaterialGraph } from "./graph-dump.js";

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
 *   at 1024 does not alias.
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
    }
  | { status: "unsupported"; unsupported: string[]; reason: string }
  | { status: "unavailable"; reason: string };

/** Node classes the evaluator implements. Everything else on an active path makes the bake `unsupported`. */
const SUPPORTED_NODE_CLASSES = [
  "TextureSample",
  "TextureSampleParameter2D",
  "ScalarParameter",
  "VectorParameter",
  "Constant",
  "Constant2Vector",
  "Constant3Vector",
  "Constant4Vector",
  "Multiply",
  "Add",
  "Subtract",
  "LinearInterpolate",
  "ComponentMask",
  "AppendVector",
  "OneMinus",
  "Saturate",
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
  "MakeMaterialAttributes",
  "BreakMaterialAttributes",
  "BlendMaterialAttributes",
] as const;

/** Engine content functions that the pack does not carry, matched by lower-cased function name. */
const SUPPORTED_ENGINE_FUNCTIONS = ["MatLayerBlend_Standard", "MatLayerBlend_AO", "MatLayerBlend_BakedNormal", "FuzzyShading"] as const;

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
}
/** A MaterialAttributes value. Only BaseColor is carried (null = the attribute is not wired = black). */
interface Attrs {
  kind: "attr";
  baseColor: Val | null;
}
type Compiled = Val | Attrs;

interface TexelContext {
  u: number;
  v: number;
}
type Instruction = (registers: Float64Array, texel: TexelContext) => void;

const RGB_MASK = [1, 1, 1, 0];
const TEXTURE_OUTPUT_MASKS: readonly number[][] = [RGB_MASK, [1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
const BREAK_ATTRIBUTES = ["BaseColor", "Metallic", "Specular", "Roughness", "EmissiveColor", "Opacity", "OpacityMask", "Normal"];

interface CompileOptions {
  allowUvSetFallback: boolean;
}

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
  private readonly active = new Set<string>();
  private readonly textureRegisters = new Map<string, Val>();
  private readonly nodes = new Map<string, GraphNode>();

  constructor(
    graph: MaterialGraph,
    private readonly parameters: GraphParameters,
    private readonly options: CompileOptions,
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
  private emit(inputs: readonly Val[], n: number, build: (out: number) => Instruction): Val {
    const reg = this.allocate();
    const instruction = build(reg);
    if (inputs.every((input) => input.konst)) {
      instruction(this.registers, { u: 0, v: 0 });
      return { kind: "vec", reg, n, konst: true };
    }
    this.program.push(instruction);
    return { kind: "vec", reg, n, konst: false };
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
    if (compiled.kind === "attr") return compiled;
    const fallbackMask = node.class.startsWith("TextureSample") && input.output >= 0 && input.output < TEXTURE_OUTPUT_MASKS.length ? TEXTURE_OUTPUT_MASKS[input.output]! : null;
    return this.applyMask(compiled, input.mask ?? fallbackMask);
  }

  /** A pin that must carry a plain value; an attribute value there is a malformed graph. */
  private vec(input: GraphInput | null | undefined, label: string): Val | undefined {
    const compiled = this.pin(input);
    if (!compiled) return undefined;
    if (compiled.kind === "attr") return this.markUnavailable(`${label} received a MaterialAttributes value`);
    return compiled;
  }

  private attrs(input: GraphInput | null | undefined, label: string): Attrs | undefined {
    const compiled = this.pin(input);
    if (!compiled) return undefined;
    if (compiled.kind === "vec") {
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
      case "Multiply":
        return this.binary(this.operand(node, "A", "ConstA", 0), this.operand(node, "B", "ConstB", 1), (x, y) => x * y);
      case "Add":
        return this.binary(this.operand(node, "A", "ConstA", 0), this.operand(node, "B", "ConstB", 1), (x, y) => x + y);
      case "Subtract":
        return this.binary(this.operand(node, "A", "ConstA", 1), this.operand(node, "B", "ConstB", 1), (x, y) => x - y);
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
      case "StaticBool":
        return this.constant([node.constants.Value === true ? 1 : 0], 1);
      case "StaticBoolParameter": {
        const override = node.parameter ? this.parameters.switches.get(node.parameter.name.toLowerCase()) : undefined;
        return this.constant([(override ?? (node.default === true)) ? 1 : 0], 1);
      }
      case "StaticSwitchParameter": {
        const override = node.parameter ? this.parameters.switches.get(node.parameter.name.toLowerCase()) : undefined;
        const stored = typeof node.default === "boolean" ? node.default : node.switchValue === true;
        return this.branch(node, override ?? stored);
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
        return this.pin(wired) ?? this.markUnavailable(`function input "${String(node.constants.InputName ?? node.id)}" is not wired and has no preview value`);
      }
      case "FunctionOutput": {
        const wired = Object.values(node.inputs).find((candidate) => candidate !== null && candidate !== undefined);
        return this.pin(wired) ?? this.markUnavailable(`function output ${node.id} is not wired`);
      }
      case "FunctionCall":
        return this.functionCall(node, output);
      case "MakeMaterialAttributes": {
        const baseColor = this.vec(node.inputs.BaseColor, "MakeMaterialAttributes.BaseColor") ?? null;
        return { kind: "attr", baseColor };
      }
      case "BreakMaterialAttributes":
        return this.breakAttributes(node, output);
      case "BlendMaterialAttributes":
        return this.blendAttributes(node);
      default:
        return this.unsupportedNode(node);
    }
  }

  /** Records an unsupported class and still walks its inputs, so the report names everything beneath it. */
  private unsupportedNode(node: GraphNode): Val {
    this.unsupported.add(node.class);
    for (const input of Object.values(node.inputs)) this.pin(input);
    return this.constant([0], 1);
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
    const [su, sv] = node.tiling ?? [1, 1];
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
    reference ??= node.texture ?? undefined;
    if (!reference) {
      const textureObject = node.inputs.TextureObject ? this.nodes.get(node.inputs.TextureObject.node) : undefined;
      if (textureObject) this.classes.add(textureObject.class);
      reference = textureObject?.texture ?? undefined;
    }
    if (!reference) return this.markUnavailable(`texture sample ${node.id}${parameterName ? ` (parameter "${node.parameter?.name}")` : ""} has no texture`);

    const coordinates = node.inputs.Coordinates ? this.vec(node.inputs.Coordinates, "TextureSample.Coordinates") : undefined;
    const uvScale = coordinates ? coordinates.uvScale : ([1, 1] as [number, number]);
    const sampler = (node.samplerType ?? "Color").toLowerCase();
    const slot: TextureSlot = {
      name: textureObjectName(reference),
      colorSampler: sampler === "color",
      lodFor: (outputSize, raster) => {
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
    const source = this.attrs(node.inputs.MaterialAttributes, "BreakMaterialAttributes.MaterialAttributes");
    if (attribute !== "BaseColor") {
      this.unsupported.add(`BreakMaterialAttributes.${attribute}`);
      return this.constant([0], 1);
    }
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

  private blendAttrs(base: Attrs, top: Attrs, alpha: Val): Attrs {
    const black = this.constant([0, 0, 0], 3);
    return { kind: "attr", baseColor: this.lerp(base.baseColor ?? black, top.baseColor ?? black, alpha) };
  }

  // -- function calls -------------------------------------------------------------------------------------

  private functionCall(node: GraphNode, output: number): Compiled {
    const name = functionBaseName(node.function);
    const lower = (name ?? "").toLowerCase();
    // Engine functions are matched by name before inlining. Each is trusted only as far as its comment says.
    if (lower === "matlayerblend_standard") return this.layerBlendStandard(node, name!);
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
    const inner = node.fn?.outputs[output];
    if (inner) {
      const innerNode = this.nodes.get(inner);
      if (!innerNode) return this.markUnavailable(`function ${name ?? node.id} output refers to missing node ${inner}`);
      return this.nodeOutput(innerNode, 0);
    }
    // No body: an engine function the evaluator does not know. Walk its inputs so the report is complete.
    this.unsupported.add(name ?? "FunctionCall");
    if (name) this.classes.add(name);
    for (const input of Object.values(node.inputs)) this.pin(input);
    return this.constant([0], 1);
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

  // -- entry ----------------------------------------------------------------------------------------------

  /** Compiles the BaseColor output; returns the value, or undefined when the graph has no BaseColor path. */
  compileBaseColor(graph: MaterialGraph): Val | undefined {
    const wired = graph.outputs.baseColor ?? graph.outputs.materialAttributes;
    if (!wired) return undefined;
    const compiled = this.pin(wired);
    if (!compiled) return undefined;
    if (compiled.kind === "vec") return compiled;
    return compiled.baseColor ?? this.constant([0, 0, 0], 3);
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
// Bake

export async function bakeGraph(request: BakeRequest): Promise<BakeResult> {
  const size = Math.max(1, Math.floor(request.size ?? DEFAULT_SIZE));
  const { graph } = request;
  if (graph.truncated) return { status: "unavailable", reason: `graph ${graph.material} was truncated at ${graph.nodeCount} nodes` };
  if (graph.error) return { status: "unavailable", reason: `graph ${graph.material} could not be dumped: ${graph.error}` };
  if (!graph.outputs.baseColor && !graph.outputs.materialAttributes) {
    return { status: "unavailable", reason: `graph ${graph.material} has no BaseColor output` };
  }

  const { compiler, value } = compile(graph, request.parameters, { allowUvSetFallback: request.allowUvSetFallback === true });
  if (compiler.unsupported.size > 0) {
    const unsupported = [...compiler.unsupported].sort();
    return { status: "unsupported", unsupported, reason: `BaseColor of ${graph.material} depends on unsupported nodes: ${unsupported.join(", ")}` };
  }
  if (compiler.unavailable.length > 0 || !value) {
    return { status: "unavailable", reason: compiler.unavailable.length > 0 ? compiler.unavailable.join("; ") : `graph ${graph.material} has no readable BaseColor path` };
  }

  // Load each texture once, then give every sample node its mip level.
  const rasters = new Map<string, TextureRaster>();
  for (const slot of compiler.slots) {
    if (rasters.has(slot.name)) continue;
    const raster = await request.loadTexture(slot.name);
    if (!raster) return { status: "unavailable", reason: `texture ${slot.name} could not be loaded` };
    if (raster.width < 1 || raster.height < 1 || raster.rgba.length < raster.width * raster.height * 4) {
      return { status: "unavailable", reason: `texture ${slot.name} has an unusable raster (${raster.width}x${raster.height}, ${raster.rgba.length} bytes)` };
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
  const out = Buffer.alloc(size * size * 4);
  const texel: TexelContext = { u: 0, v: 0 };
  const channelStep = value.n === 1 ? 0 : 1;
  const sums = [0, 0, 0];
  for (let y = 0; y < size; y++) {
    texel.v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      texel.u = (x + 0.5) / size;
      for (let index = 0; index < program.length; index++) program[index]!(registers, texel);
      const at = (y * size + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        const byte = Math.round(linearToSrgb(registers[value.reg + channel * channelStep]!) * 255);
        out[at + channel] = byte;
        sums[channel]! += byte;
      }
      out[at + 3] = 255;
    }
  }
  const png = await sharp(out, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
  const pixels = size * size * 255;
  const approximations = [...compiler.approximations].sort();
  return {
    status: "baked",
    png,
    width: size,
    height: size,
    meanRgb: [sums[0]! / pixels, sums[1]! / pixels, sums[2]! / pixels],
    confidence: approximations.length === 0 ? "exact" : "heuristic",
    approximations,
    texturesUsed: [...new Set(compiler.slots.map((slot) => slot.name))].sort(),
  };
}
