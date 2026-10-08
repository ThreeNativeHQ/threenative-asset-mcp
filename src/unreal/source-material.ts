import type { SourceExport, SourcePackage, SourceProperty, SourceReference } from "./source-material-package.js";

export type SourceCoordinates = { readonly kind: "implicit"; readonly samplerClass: string } |
  { readonly kind: "explicit"; readonly index: number; readonly u: number; readonly v: number } |
  { readonly kind: "unresolved"; readonly reason: string };
export interface SourceSample { readonly path: string; readonly node: string; readonly coordinates: SourceCoordinates }
export interface SourceSampling { readonly status: "linear" | "unresolved"; readonly reason: string }
export type SourceValue = { readonly kind: "scalar"; readonly value: number } |
  { readonly kind: "texture"; readonly path: string; readonly channel: number; readonly factor: number; readonly coordinates: SourceCoordinates; readonly sampling: SourceSampling };
export interface SourceMaterial { readonly channels: Readonly<Record<string, SourceValue>>; readonly baseColorSamples: readonly SourceSample[]; readonly limitations: readonly string[] }
const fields = (properties: readonly SourceProperty[]): Map<string, SourceProperty> => new Map(properties.filter((p) => p.arrayIndex === 0).map((p) => [p.name, p]));
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const ref = (value: unknown): SourceReference | undefined => { const v = object(value); return v && typeof v.index === "number" && (typeof v.path === "string" || v.path === null) ? v as unknown as SourceReference : undefined; };
const input = (value: unknown): Record<string, unknown> | undefined => { const v = object(value); return v && ref(v.Expression) && typeof v.OutputIndex === "number" ? v : undefined; };
class UnsupportedPath extends Error {}
const required = (properties: Map<string, SourceProperty>, name: string): unknown => {
  const p = properties.get(name); if (!p || p.unsupported) throw new UnsupportedPath(`${name}: ${p?.unsupported ?? "serialized value/default unresolved"}`); return p.value;
};
const finite = (value: unknown, description: string): number => { if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid finite ${description}`); return value; };
const parameterKey = (row: Map<string, SourceProperty>): string => {
  const properties = required(row, "ParameterInfo"); if (!Array.isArray(properties)) throw new Error("Invalid source parameter identity");
  const info = fields(properties as SourceProperty[]); const name = required(info, "Name"); const association = required(info, "Association"); const index = required(info, "Index");
  if (typeof name !== "string" || typeof association !== "string" || typeof index !== "number" || !Number.isInteger(index)) throw new Error("Invalid source parameter identity");
  return JSON.stringify([name, association, index]);
};
const globalKey = (name: unknown): string => { if (typeof name !== "string") throw new Error("Invalid source parameter name"); return JSON.stringify([name, "GlobalParameter", -1]); };
const CHANNELS = ["BaseColor", "Metallic", "Specular", "Roughness", "EmissiveColor", "Opacity", "OpacityMask", "Normal", "WorldPositionOffset", "WorldDisplacement", "TessellationMultiplier", "SubsurfaceColor", "ClearCoat", "ClearCoatRoughness", "AmbientOcclusion", "Refraction", "PixelDepthOffset"];

/** Reduces selected source paths only; opaque function inputs are structural evidence, never values. */
export function reduceSourceMaterial(packages: ReadonlyMap<string, SourcePackage>, objectPath: string): SourceMaterial {
  const limitations = new Set<string>(); const channels: Record<string, SourceValue> = {}; const baseColorSamples: SourceSample[] = [];
  const result = (): SourceMaterial => ({ channels, baseColorSamples, limitations: [...limitations] });
  const getObject = (path: string): { package: Extract<SourcePackage, { status: "decoded" }>; export: SourceExport } => {
    const packagePath = path.split(".")[0]!; const pkg = packages.get(packagePath);
    if (!pkg) throw new UnsupportedPath(`Exact source package ${packagePath} unavailable`);
    if (pkg.status === "unsupported") throw new UnsupportedPath(`${packagePath}: ${pkg.reason}`);
    const exports = pkg.exports.filter((e) => e.path === path); if (exports.length > 1) throw new Error("Duplicate source object path");
    if (!exports[0]) throw new UnsupportedPath(`Exact source object ${path} unavailable`);
    return { package: pkg, export: exports[0] };
  };
  const scalars = new Map<string, number>(); const textures = new Map<string, SourceReference>(); const switches = new Map<string, boolean>();
  let root: ReturnType<typeof getObject>;
  try {
    let current = getObject(objectPath); const ancestors = new Set<string>();
    while (current.export.className === "MaterialInstanceConstant") {
      if (ancestors.has(current.export.path) || ancestors.size >= 64) throw new Error("Source parent cycle/depth"); ancestors.add(current.export.path);
      const fs = fields(current.export.properties);
      for (const name of ["ScalarParameterValues", "TextureParameterValues"] as const) {
        const property = fs.get(name); if (!property) continue;
        if (property.unsupported || !Array.isArray(property.value)) throw new UnsupportedPath(`${name} unresolved`);
        const local = new Set<string>();
        for (const row of property.value as SourceProperty[][]) {
          const rowFields = fields(row); const key = parameterKey(rowFields); if (local.has(key)) throw new Error("Duplicate source parameter"); local.add(key);
          if (name === "ScalarParameterValues" ? scalars.has(key) : textures.has(key)) continue;
          const value = required(rowFields, "ParameterValue");
          if (name === "ScalarParameterValues") { const scalar = finite(value, "source scalar override"); if (!scalars.has(key)) scalars.set(key, scalar); }
          else { const texture = ref(value); if (!texture || !texture.path) throw new Error("Invalid source texture override"); if (!textures.has(key)) textures.set(key, texture); }
        }
      }
      const statics = fs.get("StaticParameters");
      if (statics) {
        if (statics.unsupported || !Array.isArray(statics.value)) throw new UnsupportedPath("StaticParameters unresolved");
        const rows = fields(statics.value as SourceProperty[]).get("StaticSwitchParameters"); const local = new Set<string>();
        if (rows?.unsupported || (rows && !Array.isArray(rows.value))) throw new UnsupportedPath("StaticSwitchParameters unresolved");
        for (const row of (rows?.value ?? []) as SourceProperty[][]) {
          const rowFields = fields(row); const key = parameterKey(rowFields); if (local.has(key)) throw new Error("Duplicate source static switch"); local.add(key);
          const override = required(rowFields, "bOverride");
          if (typeof override !== "boolean") throw new Error("Invalid source switch override flag");
          if (!override || switches.has(key)) continue;
          const value = required(rowFields, "Value"); if (typeof value !== "boolean") throw new Error("Invalid source switch value flag");
          switches.set(key, value);
        }
      }
      const parent = ref(required(fs, "Parent")); if (!parent?.path) throw new UnsupportedPath("Source parent unresolved"); current = getObject(parent.path);
    }
    if (current.export.className !== "Material") throw new UnsupportedPath(`Unsupported source root class ${current.export.className}`);
    root = current;
  } catch (error) { if (!(error instanceof UnsupportedPath)) throw error; limitations.add(error.message); return result(); }
  const nodes = new Map(root.package.exports.map((e) => [e.index, e]));
  const nodeFor = (edge: Record<string, unknown>): SourceExport => {
    const reference = ref(edge.Expression)!; const node = nodes.get(reference.index);
    if (!node || reference.index <= 0 || !node.className.startsWith("MaterialExpression")) throw new Error("Invalid selected source expression index");
    const output = edge.OutputIndex;
    const scalarNodes = ["MaterialExpressionConstant", "MaterialExpressionScalarParameter", "MaterialExpressionMultiply", "MaterialExpressionReroute", "MaterialExpressionStaticSwitchParameter", "MaterialExpressionMakeMaterialAttributes", "MaterialExpressionTextureCoordinate"];
    // BreakMaterialAttributes also exposes customized UV outputs outside this subset. Unknown
    // outputs remain opaque; the supported channel route below checks its known correspondence.
    const maximum = ["MaterialExpressionTextureSample", "MaterialExpressionTextureSampleParameter2D"].includes(node.className) ? 4 : scalarNodes.includes(node.className) ? 0 : undefined;
    if (typeof output !== "number" || !Number.isInteger(output) || output < 0 || (maximum !== undefined && output > maximum)) throw new Error(`Invalid source expression output index ${output} at ${node.path}`);
    return node;
  };
  const selected = (node: SourceExport): Record<string, unknown> => {
    const fs = fields(node.properties); const key = globalKey(required(fs, "ParameterName")); const condition = switches.get(key) ?? required(fs, "DefaultValue");
    if (typeof condition !== "boolean") throw new Error("Invalid selected static switch flag");
    const edge = input(required(fs, condition ? "A" : "B")); if (!edge) throw new Error("Invalid selected static switch input"); return edge;
  };
  const selectAttributes = (edge: Record<string, unknown>, seen = new Set<number>()): SourceExport => {
    const node = nodeFor(edge); if (seen.has(node.index) || seen.size > 64) throw new Error("Source attribute cycle/depth"); seen.add(node.index);
    if (node.className === "MaterialExpressionMakeMaterialAttributes") return node;
    if (node.className === "MaterialExpressionStaticSwitchParameter") return selectAttributes(selected(node), seen);
    if (node.className === "MaterialExpressionReroute") { const next = input(required(fields(node.properties), "Input")); if (!next) throw new Error("Invalid source attribute reroute"); return selectAttributes(next, seen); }
    throw new UnsupportedPath(`${node.path}: opaque attributes ${node.className}`);
  };
  const coordinates = (node: SourceExport): SourceCoordinates => {
    const fs = fields(node.properties); const coordinate = fs.get("Coordinates"); const constant = fs.get("ConstCoordinate");
    if (!coordinate && !constant) return { kind: "implicit", samplerClass: node.className };
    if (coordinate?.unsupported || constant?.unsupported) return { kind: "unresolved", reason: "Source sampler coordinates unsupported" };
    const edge = input(coordinate?.value);
    if (edge && ref(edge.Expression)!.index !== 0) {
      let uv = nodeFor(edge); const seen = new Set<number>();
      while (uv.className === "MaterialExpressionReroute") { if (seen.has(uv.index) || seen.size >= 64) throw new Error("Source coordinate cycle/depth"); seen.add(uv.index); const next = input(required(fields(uv.properties), "Input")); if (!next) throw new Error("Invalid source coordinate reroute"); uv = nodeFor(next); }
      if (uv.className !== "MaterialExpressionTextureCoordinate") return { kind: "unresolved", reason: `Opaque source coordinates ${uv.path}` };
      const uvFields = fields(uv.properties);
      if (["CoordinateIndex", "UTiling", "VTiling", "UnMirrorU", "UnMirrorV"].some((p) => !uvFields.has(p) || uvFields.get(p)?.unsupported)) return { kind: "unresolved", reason: `Source UV defaults unresolved at ${uv.path}` };
      if (required(uvFields, "UnMirrorU") !== false || required(uvFields, "UnMirrorV") !== false) return { kind: "unresolved", reason: "Source UV unmirror semantics unsupported" };
      const index = finite(required(uvFields, "CoordinateIndex"), "UV index"); if (!Number.isInteger(index) || index < 0) throw new Error("Invalid source UV index");
      return { kind: "explicit", index, u: finite(required(uvFields, "UTiling"), "UV U tiling"), v: finite(required(uvFields, "VTiling"), "UV V tiling") };
    }
    // Explicit ConstCoordinate is independent of a class default. Null Coordinates without it
    // is deliberately distinct from both fields being absent.
    if (constant && typeof constant.value === "number" && Number.isInteger(constant.value) && constant.value >= 0 && !coordinate) return { kind: "explicit", index: constant.value, u: 1, v: 1 };
    return { kind: "unresolved", reason: "Source sampler effective coordinate/default unresolved" };
  };
  const sample = (node: SourceExport): SourceSample => {
    const fs = fields(node.properties); const parameterName = fs.get("ParameterName");
    const reference = parameterName ? textures.get(globalKey(required(fs, "ParameterName"))) ?? ref(required(fs, "Texture")) : ref(required(fs, "Texture"));
    if (!reference?.path) throw new UnsupportedPath(`${node.path}: source texture unresolved`);
    if (fs.get("MipValueMode") && required(fs, "MipValueMode") !== "TMVM_None") throw new UnsupportedPath(`${node.path}: explicit mip sampling unsupported`);
    if (fs.has("SamplerSource") && required(fs, "SamplerSource") !== "SSM_FromTextureAsset") throw new UnsupportedPath(`${node.path}: nontexture sampler source unsupported`);
    return { path: reference.path, node: node.path, coordinates: coordinates(node) };
  };
  const isSample = (node: SourceExport) => ["MaterialExpressionTextureSample", "MaterialExpressionTextureSampleParameter2D"].includes(node.className);
  const sampling = (node: SourceExport, texturePath: string): SourceSampling => {
    const samplerType = fields(node.properties).get("SamplerType");
    let srgb: SourceProperty | undefined;
    try { const texture = getObject(texturePath); if (texture.export.className === "Texture2D") srgb = fields(texture.export.properties).get("SRGB"); }
    catch (error) { if (!(error instanceof UnsupportedPath)) throw error; return { status: "unresolved", reason: `${error.message}; SRGB source flag unresolved` }; }
    const knownLinear = ["SAMPLERTYPE_LinearColor", "SAMPLERTYPE_LinearGrayscale", "SAMPLERTYPE_Masks"].includes(samplerType?.value as string);
    if (srgb?.value === false && !srgb.unsupported && knownLinear && !samplerType?.unsupported) return { status: "linear", reason: `Explicit Texture2D.SRGB=false and ${samplerType!.value}` };
    return { status: "unresolved", reason: `Texture2D.SRGB=${srgb?.unsupported ?? (srgb ? String(srgb.value) : "omitted/default unresolved")}; SamplerType=${samplerType?.unsupported ?? (samplerType ? String(samplerType.value) : "omitted/default unresolved")}; linear AO sampling is unproved` };
  };
  const edges = (value: unknown): Record<string, unknown>[] => {
    const edge = input(value); if (edge) return [edge]; if (Array.isArray(value)) return value.flatMap(edges);
    const v = object(value); return v ? Object.values(v).flatMap(edges) : [];
  };
  const collect = (edge: Record<string, unknown>, channel: string, active = new Set<number>(), visited = new Set<number>()): void => {
    if (ref(edge.Expression)!.index === 0) return;
    const node = nodeFor(edge); if (active.has(node.index) || active.size >= 64) throw new Error("Selected source graph cycle/depth"); if (visited.has(node.index)) return;
    active.add(node.index); visited.add(node.index); const fs = fields(node.properties);
    if (isSample(node) && channel === "BaseColor") { try { baseColorSamples.push(sample(node)); } catch (error) { if (!(error instanceof UnsupportedPath)) throw error; limitations.add(`Source ${channel}: ${error.message}`); } }
    if (node.className === "MaterialExpressionMaterialFunctionCall") { const fn = ref(fs.get("MaterialFunction")?.value); limitations.add(`Source ${channel}: opaque function ${node.path}${fn?.path ? ` (${fn.path})` : ""}; exact shader semantics unsupported`); }
    if (node.className === "MaterialExpressionStaticSwitchParameter") collect(selected(node), channel, active, visited);
    else for (const next of edges(node.properties)) collect(next, channel, active, visited);
    active.delete(node.index);
  };
  const evaluate = (edge: Record<string, unknown>, channel: string, active = new Set<number>()): SourceValue => {
    if (ref(edge.Expression)!.index === 0) {
      if (edge.UseConstant === true) return { kind: "scalar", value: finite(edge.Constant, "source constant input") };
      throw new UnsupportedPath("Unconnected source input/class default unresolved");
    }
    const node = nodeFor(edge); if (active.has(node.index) || active.size >= 64) throw new Error("Selected source value cycle/depth"); active.add(node.index);
    const fs = fields(node.properties);
    const recurse = (value: unknown) => { const next = input(value); if (!next) throw new Error("Invalid supported source input"); return evaluate(next, channel, new Set(active)); };
    if (node.className === "MaterialExpressionStaticSwitchParameter") return evaluate(selected(node), channel, active);
    if (node.className === "MaterialExpressionReroute") return recurse(required(fs, "Input"));
    if (node.className === "MaterialExpressionConstant") return { kind: "scalar", value: finite(required(fs, "R"), "source constant") };
    if (node.className === "MaterialExpressionScalarParameter") { const key = globalKey(required(fs, "ParameterName")); return { kind: "scalar", value: scalars.get(key) ?? finite(required(fs, "DefaultValue"), "source parameter default") }; }
    if (node.className === "MaterialExpressionMultiply") {
      const operand = (name: string) => fs.has(name) ? recurse(required(fs, name)) : { kind: "scalar" as const, value: finite(required(fs, `Const${name}`), "source multiply constant") };
      const a = operand("A"); const b = operand("B");
      if (a.kind === "scalar" && b.kind === "scalar") return { kind: "scalar", value: finite(a.value * b.value, "source scalar product") };
      const texture = a.kind === "texture" ? a : b.kind === "texture" ? b : undefined; const scalar = a.kind === "scalar" ? a : b.kind === "scalar" ? b : undefined;
      if (texture && scalar) return { ...texture, factor: finite(texture.factor * scalar.value, "source texture product") };
      throw new UnsupportedPath(`${node.path}: product of two textures unsupported`);
    }
    if (isSample(node)) {
      const s = sample(node); let component: number;
      if (edge.Mask === 1) { const selected = [edge.MaskR, edge.MaskG, edge.MaskB, edge.MaskA].flatMap((m, index) => m === 1 ? [index] : []); if (selected.length !== 1) throw new UnsupportedPath(`${node.path}: nonscalar texture mask unsupported`); component = selected[0]!; }
      else { const output = edge.OutputIndex as number; if (output < 1 || output > 4) throw new UnsupportedPath(`${node.path}: nonscalar texture output unsupported`); component = output - 1; }
      if (edge.Mask === 1 && (edge.OutputIndex as number) > 0 && component !== (edge.OutputIndex as number) - 1) throw new UnsupportedPath(`${node.path}: texture output/mask component mismatch unsupported`);
      return { kind: "texture", path: s.path, channel: component, factor: 1, coordinates: s.coordinates, sampling: sampling(node, s.path) };
    }
    throw new UnsupportedPath(`${node.path}: ${node.className} shader path unsupported`);
  };
  const rootFields = fields(root.export.properties); const shading = rootFields.get("ShadingModel");
  limitations.add(`Source shading ${typeof shading?.value === "string" ? shading.value : "effective default unresolved"}: exact Unreal shading unsupported`);
  for (const channel of CHANNELS) {
    let edge: Record<string, unknown> | undefined;
    try {
      if (rootFields.get("bUseMaterialAttributes")?.value === true) { const attributes = input(required(rootFields, "MaterialAttributes")); if (!attributes) throw new Error("Invalid source MaterialAttributes input"); edge = input(fields(selectAttributes(attributes).properties).get(channel)?.value); }
      else edge = input(rootFields.get(channel)?.value);
      if (!edge) continue;
      if (ref(edge.Expression)!.index !== 0 && nodeFor(edge).className === "MaterialExpressionBreakMaterialAttributes") {
        if (CHANNELS.slice(0, 16)[edge.OutputIndex as number] !== channel) throw new UnsupportedPath(`BreakMaterialAttributes output ${edge.OutputIndex} does not establish ${channel} within the supported output layout`);
        const attributes = input(required(fields(nodeFor(edge).properties), "MaterialAttributes")); if (!attributes) throw new Error("Invalid source attributes input"); edge = input(fields(selectAttributes(attributes).properties).get(channel)?.value);
        if (!edge) { limitations.add(`Source ${channel}: selected attribute default unresolved`); continue; }
      }
      collect(edge, channel);
      const reduced = evaluate(edge, channel);
      if (["Roughness", "AmbientOcclusion", "Metallic"].includes(channel)) channels[channel] = reduced;
      else if (channel === "Specular") limitations.add(`Source Specular${reduced.kind === "texture" ? ` ${reduced.path}.${"RGBA"[reduced.channel]}` : ` ${reduced.value}`}: exact UE4.19 reflectance conversion unsupported`);
      else limitations.add(`Source ${channel}: authored output retained as unsupported by bounded scalar PBR subset`);
    } catch (error) { if (!(error instanceof UnsupportedPath)) throw error; limitations.add(`Source ${channel}: ${error.message}`); }
  }
  return result();
}

export function sameSourceCoordinates(a: SourceCoordinates, b: SourceCoordinates): boolean {
  return a.kind !== "unresolved" && b.kind !== "unresolved" && JSON.stringify(a) === JSON.stringify(b);
}
