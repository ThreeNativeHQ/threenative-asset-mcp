/**
 * Reconstructs a standard glTF PBR material from what UE Viewer can recover of an Unreal material.
 *
 * Three sources, ranked. The `.mat` file is the authority: umodel resolved the material graph far
 * enough to name a Diffuse/Normal/Specular/SpecPower/Opacity/Emissive/Cube/Mask texture. A named
 * slot normally has exact binding confidence, except contradictory samples duplicated across
 * distinct section families in one export namespace. Shader fidelity is reported separately.
 * `.props.txt` carries `CollectedTextureParameters`, the material's own
 * parameter names, which recover slots the `.mat` left in `Other[n]` — the Kite Demo foliage is the
 * case that matters: its diffuse atlas is `Other[0]` in the `.mat` and `Diffuse` in the props. That
 * is the material's naming rather than umodel's resolution, so it is heuristic. Texture filename
 * suffixes are the last resort and are always heuristic. Anything left over is reported as
 * unsupported with its name; nothing is silently dropped and no debug colour is ever called a
 * texture.
 */

export type GltfSlot =
  | "baseColor"
  | "normal"
  | "emissive"
  | "metallicRoughness"
  | "occlusion";

/**
 * Named channel transforms. Unreal packs channels in ways glTF does not share, so a texture bound
 * to metallicRoughness usually has to be rebuilt rather than referenced. Each one is exercised by
 * a unit test over synthetic pixels.
 */
export type TextureTransform =
  | "none"
  /** RGB(A) diffuse whose alpha is roughness (`*_D_R`): alpha becomes glTF's green channel. */
  | "alphaToRoughness"
  /** A gloss/specular-power map in red: roughness is its inverse. */
  | "specPowerToRoughness"
  /** A roughness map already in red: moved to glTF's green channel. */
  | "redToRoughness"
  /** Separate red-channel roughness and metalness maps packed into glTF G and B. */
  | "redRoughnessRedMetalness"
  /** Already packed glTF image: force G to one so an authored scalar supplies all roughness. */
  | "roughnessToOne"
  /** Preserve diffuse RGB, with a separate opacity map's red channel as alpha. */
  | "redToBaseColorAlpha";

/** `effect`: an emissive-only effect material's mask, bound as emissive and alpha because the package has no albedo. */
export type BindingSource = "mat" | "props" | "filename" | "texture-set" | "authored-source" | "graph" | "effect";
export type BindingConfidence = "exact" | "heuristic";

export interface MaterialTextureBinding {
  readonly slot: GltfSlot;
  readonly texture: string;
  /** Second image used only by transforms that combine separate Unreal maps. */
  readonly secondaryTexture?: string;
  readonly source: BindingSource;
  readonly confidence: BindingConfidence;
  readonly transform: TextureTransform;
  /** The texture the source actually named, when a Winter/Autumn texture yielded to its Summer sibling. */
  readonly substitutedFrom?: string;
}

export interface UnsupportedTexture {
  readonly texture: string;
  readonly reason: string;
}

export interface ResolvedMaterial {
  readonly name: string;
  readonly bindings: readonly MaterialTextureBinding[];
  readonly unsupported: readonly UnsupportedTexture[];
  readonly alphaMode: "OPAQUE" | "MASK" | "BLEND";
  readonly alphaCutoff: number | undefined;
  readonly doubleSided: boolean;
  readonly baseColorFactor: readonly [number, number, number, number] | undefined;
  readonly emissiveFactor: readonly [number, number, number] | undefined;
  readonly metallicFactor: number | undefined;
  readonly roughnessFactor: number | undefined;
  /** Parent materials followed, nearest first. Empty for a plain Material. */
  readonly parents: readonly string[];
  readonly limitations: readonly string[];
}

export interface MatFile {
  readonly slots: ReadonlyMap<string, string>;
  readonly others: readonly string[];
}

export interface CollectedTextureParameter {
  readonly name: string;
  readonly texture: string;
}

export interface ScalarParameter {
  readonly name: string;
  readonly value: number;
}

export interface VectorParameter {
  readonly name: string;
  readonly value: readonly [number, number, number, number];
}

export interface PropsFile {
  readonly twoSided: boolean | undefined;
  readonly blendMode: string | undefined;
  readonly opacityMaskClipValue: number | undefined;
  /** `CollectedTextureParameters`, present from UE 4.19 on. */
  readonly collected: readonly CollectedTextureParameter[];
  /** `TextureParameterValues` — a MaterialInstanceConstant's own overrides of its parent's inputs.
   * The only place an instance's textures appear when umodel resolved the parent's instead. */
  readonly overrides: readonly CollectedTextureParameter[];
  /**
   * Names of `TextureParameterValues` entries whose value is `None`: UE Viewer cannot name an engine texture
   * (`BaseFlattenNormalMap`, `WhiteSquareTexture`), so an override that points outside the pack prints as `None`.
   * It still replaces whatever an ancestor bound to that parameter.
   */
  readonly unresolvedOverrides: readonly string[];
  readonly scalars: readonly ScalarParameter[];
  readonly scalarOverrides: readonly ScalarParameter[];
  readonly vectors: readonly VectorParameter[];
  readonly vectorOverrides: readonly VectorParameter[];
  readonly parent: string | undefined;
  /** Instance-local streaming references identify a surface family, never its UV transform. */
  readonly streamingTextures: readonly string[];
  /** Legacy decoder sidecars can omit the flags that distinguish instance defaults from overrides. */
  readonly overrideFlagsMissing: boolean;
}

const MAT_SLOTS = new Set([
  "Diffuse",
  "Normal",
  "Specular",
  "SpecPower",
  "Opacity",
  "Emissive",
  "Cube",
  "Mask",
]);

/** Parses umodel's `<Material>.mat`: one `Key=TextureName` per line, `Other[n]` for the rest. */
export function parseMatFile(text: string): MatFile {
  const slots = new Map<string, string>();
  const others: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!value) continue;
    if (/^Other\[\d+\]$/.test(key)) {
      others.push(value);
      continue;
    }
    if (MAT_SLOTS.has(key)) slots.set(key, value);
  }
  return { slots, others };
}

/** `Texture2D'Content/Path/Name.Name'` → `Name`. */
function objectName(reference: string): string | undefined {
  const quoted = /'([^']+)'/.exec(reference)?.[1] ?? reference;
  const afterDot = quoted.includes(".") ? quoted.slice(quoted.lastIndexOf(".") + 1) : quoted;
  const name = afterDot.trim();
  return name === "" || name === "None" ? undefined : name;
}

/**
 * Parses umodel's `<Material>.props.txt`. The file is a brace-nested dump, so the block containing
 * `CollectedTextureParameters` is walked by depth rather than matched with one regex: the same
 * `Texture =` key appears inside `ReferencedTextures` and `CachedExpressionData`, where it carries
 * no parameter name.
 */
export function parsePropsFile(text: string): PropsFile {
  const lines = text.split(/\r?\n/);
  let twoSided: boolean | undefined;
  let blendMode: string | undefined;
  let opacityMaskClipValue: number | undefined;
  let parent: string | undefined;
  const collected: CollectedTextureParameter[] = [];

  const overrides: CollectedTextureParameter[] = [];
  const unresolvedOverrides: string[] = [];
  const scalars: ScalarParameter[] = [];
  const scalarOverrides: ScalarParameter[] = [];
  const vectors: VectorParameter[] = [];
  const vectorOverrides: VectorParameter[] = [];
  let inCollected = false;
  let collectedDepth = 0;
  let depth = 0;
  let pendingTexture: string | undefined;
  let pendingName: string | undefined;

  const number = "[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[Ee][-+]?\\d+)?";
  const readName = (line: string): string | undefined => {
    const legacy = /ParameterName\s*=\s*([^,}\r\n]+)/.exec(line)?.[1]?.trim();
    const modern = /ParameterInfo\s*=\s*\{\s*Name\s*=\s*([^,}\r\n]+)/.exec(line)?.[1]?.trim();
    const collected = /\bName\s*=\s*([^,}\r\n]+)/.exec(line)?.[1]?.trim();
    return [legacy, modern, collected].find((name) => name && name !== "None");
  };
  const readScalar = (line: string): number | undefined => {
    const value = new RegExp(`(?:ParameterValue|Value)\\s*=\\s*(${number})`).exec(line)?.[1];
    return value === undefined ? undefined : Number(value);
  };
  const readVector = (line: string): [number, number, number, number] | undefined => {
    const value = new RegExp(
      `(?:ParameterValue|Value)\\s*=\\s*\\{[^}]*?(?:R|X)=(${number})[^}]*?(?:G|Y)=(${number})[^}]*?(?:B|Z)=(${number})(?:[^}]*?(?:A|W)=(${number}))?[^}]*?\\}`,
    ).exec(line);
    if (!value?.[1] || !value[2] || !value[3]) return undefined;
    return [Number(value[1]), Number(value[2]), Number(value[3]), Number(value[4] ?? 1)];
  };

  const indexedBlocks = (prefix: string): string[] => {
    const blocks: string[] = [];
    const expression = new RegExp(`${prefix}\\[\\d+\\]\\s*=\\s*\\{`, "g");
    for (const match of text.matchAll(expression)) {
      const start = (match.index ?? 0) + match[0].lastIndexOf("{");
      let depth = 0;
      for (let index = start; index < text.length; index += 1) {
        if (text[index] === "{") depth += 1;
        else if (text[index] === "}") {
          depth -= 1;
          if (depth === 0) {
            blocks.push(text.slice(start + 1, index));
            break;
          }
        }
      }
    }
    return blocks;
  };

  const collectScalars = (prefix: string, target: ScalarParameter[]): void => {
    for (const block of indexedBlocks(prefix)) {
      if (new RegExp(`${prefix}\\[\\d+\\]`).test(block)) continue;
      const name = readName(block);
      const value = readScalar(block);
      if (name && value !== undefined) target.push({ name, value });
    }
  };
  const collectVectors = (prefix: string, target: VectorParameter[]): void => {
    for (const block of indexedBlocks(prefix)) {
      if (new RegExp(`${prefix}\\[\\d+\\]`).test(block)) continue;
      const name = readName(block);
      const value = readVector(block);
      if (name && value) target.push({ name, value });
    }
  };
  collectScalars("CollectedScalarParameters", scalars);
  collectScalars("ScalarParameterValues", scalarOverrides);
  collectVectors("CollectedVectorParameters", vectors);
  collectVectors("VectorParameterValues", vectorOverrides);
  for (const block of indexedBlocks("TextureParameterValues")) {
    if (/TextureParameterValues\[\d+\]/.test(block)) continue;
    const name = readName(block);
    const texture = objectName(/ParameterValue\s*=\s*([^\r\n}]+)/.exec(block)?.[1] ?? "");
    if (name && texture) overrides.push({ name, texture });
    else if (name && /ParameterValue\s*=\s*None\b/.test(block)) unresolvedOverrides.push(name);
  }
  const streamingTextures = indexedBlocks("TextureStreamingData")
    .filter((block) => !/TextureStreamingData\[\d+\]/.test(block))
    .flatMap((block) => /TextureName\s*=\s*([^\s,}]+)/.exec(block)?.[1] ?? []);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const sided = /^TwoSided\s*=\s*(true|false)$/.exec(line);
    if (sided) twoSided = sided[1] === "true";
    if (blendMode === undefined) {
      const blend = /^BlendMode\s*=\s*(BLEND_[A-Za-z]+)/.exec(line);
      if (blend?.[1]) blendMode = blend[1];
    }
    if (opacityMaskClipValue === undefined) {
      const clip = /^OpacityMaskClipValue\s*=\s*([0-9.]+)/.exec(line);
      if (clip?.[1]) opacityMaskClipValue = Number(clip[1]);
    }
    if (parent === undefined && /^Parent\s*=/.test(line)) {
      parent = objectName(line.slice(line.indexOf("=") + 1));
    }
    if (!inCollected && /^CollectedTextureParameters\[\d+\]/.test(line)) {
      inCollected = true;
      collectedDepth = depth;
      pendingTexture = undefined;
      pendingName = undefined;
    }
    if (inCollected) {
      const texture = /^Texture\s*=\s*(.+)$/.exec(line);
      if (texture?.[1]) pendingTexture = objectName(texture[1]);
      const name = /^Name\s*=\s*(.+)$/.exec(line);
      if (name?.[1]) pendingName = name[1].trim();
      if (pendingTexture && pendingName) {
        collected.push({ name: pendingName, texture: pendingTexture });
        pendingTexture = undefined;
        pendingName = undefined;
      }
    }
    for (const character of line) {
      if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (inCollected && depth <= collectedDepth) inCollected = false;
      }
    }
  }

  const overrideFlag = (name: string): boolean | undefined => {
    const value = new RegExp(`^\\s*bOverride_${name}\\s*=\\s*(true|false)\\s*$`, "m").exec(text)?.[1];
    return value === undefined ? undefined : value === "true";
  };
  const effective = <T>(name: string, value: T | undefined, placeholder: T): T | undefined => {
    const flag = overrideFlag(name);
    return flag === false || (parent !== undefined && flag === undefined && value === placeholder) ? undefined : value;
  };
  return {
    twoSided: effective("TwoSided", twoSided, false),
    blendMode: effective("BlendMode", blendMode, "BLEND_Opaque"),
    opacityMaskClipValue: effective("OpacityMaskClipValue", opacityMaskClipValue, 0),
    collected,
    // The modern converter writes an instance's own overrides as `CollectedTextureParameters`
    // (a MaterialInstance has no expression nodes, so the collected block IS its overrides; on a
    // root Material it is the defaults). A real `TextureParameterValues` block wins; never both.
    overrides: parent !== undefined && overrides.length === 0 ? [...collected] : overrides,
    unresolvedOverrides,
    scalars,
    scalarOverrides,
    vectors,
    vectorOverrides,
    parent,
    streamingTextures,
    overrideFlagsMissing: parent !== undefined && [
      ["TwoSided", twoSided], ["BlendMode", blendMode], ["OpacityMaskClipValue", opacityMaskClipValue],
    ].some(([name, value]) => value !== undefined && overrideFlag(String(name)) === undefined),
  };
}

interface SlotPlan {
  readonly slot: GltfSlot;
  readonly transform: TextureTransform;
}

/** How each `.mat` key maps onto glTF's fixed PBR slots. `Cube` has no glTF counterpart. */
const MAT_SLOT_PLAN: Record<string, SlotPlan | undefined> = {
  Diffuse: { slot: "baseColor", transform: "none" },
  Normal: { slot: "normal", transform: "none" },
  Emissive: { slot: "emissive", transform: "none" },
  Specular: { slot: "metallicRoughness", transform: "specPowerToRoughness" },
  SpecPower: { slot: "metallicRoughness", transform: "specPowerToRoughness" },
};

/** Material parameter names, normalized. Unreal authors name these; we only recognize them. */
function planForParameterName(name: string): SlotPlan | undefined {
  const key = name.toLowerCase().replace(/[^a-z]/g, "");
  if (["diffuse", "basecolor", "albedo", "color", "basecolour"].includes(key)) {
    return { slot: "baseColor", transform: "none" };
  }
  if (["normal", "normalmap", "bump", "nrm", "nor", "norm", "mainnormal", "normaltexture"].includes(key)) {
    return { slot: "normal", transform: "none" };
  }
  if (["emissive", "emission"].includes(key)) {
    return { slot: "emissive", transform: "none" };
  }
  if (["spec", "specular", "specpower", "gloss", "glossiness"].includes(key)) {
    return { slot: "metallicRoughness", transform: "specPowerToRoughness" };
  }
  if (["rough", "roughness"].includes(key)) {
    return { slot: "metallicRoughness", transform: "redToRoughness" };
  }
  if (["ao", "occlusion", "ambientocclusion"].includes(key)) {
    return { slot: "occlusion", transform: "none" };
  }
  return undefined;
}

function normalizedParameterName(name: string): string {
  return name.toLowerCase().replace(/[^a-z]/g, "");
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Texture filename suffixes, the weakest signal and the only one that reads no material data. */
function planForFileName(texture: string): SlotPlan | undefined {
  const name = texture.toLowerCase();
  if (/_d(?:\d+)?(?:_[a-z]+)*_r$/.test(name)) {
    return { slot: "baseColor", transform: "none" };
  }
  if (/(_n|_nrm|_normal)(_tex)?$/.test(name)) return { slot: "normal", transform: "none" };
  if (/(_d|_diff|_diffuse|_basecolor|_albedo)(_tex)?$/.test(name)) {
    return { slot: "baseColor", transform: "none" };
  }
  if (/(_e|_emissive)(_tex)?$/.test(name)) return { slot: "emissive", transform: "none" };
  if (/(_ao|_occlusion)(_tex)?$/.test(name)) return { slot: "occlusion", transform: "none" };
  if (/(_r|_rough|_roughness)(_tex)?$/.test(name)) {
    return { slot: "metallicRoughness", transform: "redToRoughness" };
  }
  if (/(_s|_spec|_specular)(_tex)?$/.test(name)) {
    return { slot: "metallicRoughness", transform: "specPowerToRoughness" };
  }
  return undefined;
}

const COLOUR_TOKENS = new Set(["c", "d", "diff", "diffuse", "basecolor", "basecolour", "albedo", "color", "colour"]);
const DATA_TOKENS = new Set(["displacement", "height", "ao", "aoro", "curvature", "orm", "arm", "mask", "masks", "roughness", "gloss"]);
const NORMAL_TOKENS = new Set(["n", "nrm", "normal"]);

/** Name tokens after the prefix: `T_brick_wall_tiling_c_grey` is a colour map in its grey variant. */
function nameTokens(texture: string): string[] {
  return texture.toLowerCase().split("_").slice(1);
}

/** A colour word anywhere (`_c_grey`), or a trailing `_A` albedo beside `_N`/`_AORO` — never a
 * texture that ends as a normal map, whatever variant letter precedes that. */
function isColourTexture(texture: string): boolean {
  const tokens = nameTokens(texture);
  if (NORMAL_TOKENS.has(tokens.at(-1) ?? "")) return false;
  return tokens.some((token) => COLOUR_TOKENS.has(token)) || tokens.at(-1) === "a";
}

/** Named for data channels — height, AO, curvature, a trailing `_g` gloss — and for no colour. */
function isDataTexture(texture: string): boolean {
  const tokens = nameTokens(texture);
  if (isColourTexture(texture)) return false;
  return tokens.some((token) => DATA_TOKENS.has(token)) || tokens.at(-1) === "g";
}

/** `*_D_R` textures carry roughness in alpha; the same image serves both slots. */
export function packsRoughnessInAlpha(texture: string): boolean {
  return /_d(?:\d+)?(?:_[a-z0-9]+)*_r$/i.test(texture);
}

export interface ResolveMaterialRequest {
  readonly name: string;
  /** Returns the `.mat` text for a material name, or undefined when it was not exported. */
  readonly readMat: (materialName: string) => string | undefined;
  /** Returns the `.props.txt` text for a material name, or undefined. */
  readonly readProps: (materialName: string) => string | undefined;
  /** Names of the textures actually written next to the material. */
  readonly availableTextures: ReadonlySet<string>;
  /** Distinct sections whose exported .mat metadata is byte-identical in this model. */
  readonly sharedGraphMaterialNames?: ReadonlySet<string>;
}

const MAX_PARENT_DEPTH = 8;

/** Every texture any material in the chain names, whether or not it mapped to a slot. */
function referencedTextures(
  request: ResolveMaterialRequest,
  materials: Iterable<string>,
): Set<string> {
  const referenced = new Set<string>();
  for (const material of materials) {
    const matText = request.readMat(material);
    if (matText) {
      const mat = parseMatFile(matText);
      for (const texture of mat.slots.values()) referenced.add(texture);
      for (const texture of mat.others) referenced.add(texture);
    }
    const propsText = request.readProps(material);
    if (propsText) {
      const props = parsePropsFile(propsText);
      for (const parameter of [...props.collected, ...props.overrides]) referenced.add(parameter.texture);
    }
  }
  return referenced;
}

/** A parent's default texture that an instance below it replaces with its own. */
interface SupersededDefault {
  readonly parameter: string;
  /** The replacing texture; undefined when the override points outside the pack (an engine default). */
  readonly override: string | undefined;
}

/**
 * UE Viewer writes a material instance's `.mat` from the parent's graph when it does not
 * recognise the instance's parameter names, so the instance's slots can hold the parent's
 * default textures. The instance's `TextureParameterValues` are what Unreal actually renders.
 * Returns each parent default (by texture) that some instance in the chain overrides with a
 * different texture, keyed by the parent's texture.
 */
function supersededDefaults(request: ResolveMaterialRequest): Map<string, SupersededDefault> {
  const chain: PropsFile[] = [];
  const visited = new Set<string>();
  for (let current: string | undefined = request.name; current && chain.length < MAX_PARENT_DEPTH; ) {
    if (visited.has(current)) break;
    visited.add(current);
    const text = request.readProps(current);
    const props = text ? parsePropsFile(text) : undefined;
    if (props) chain.push(props);
    current = props?.parent;
  }
  const result = new Map<string, SupersededDefault>();
  const key = (name: string): string => name.trim().toLowerCase();
  // An override at level i replaces defaults declared at levels above it (i + 1 and up). An override whose
  // value is `None` points at an engine texture UE Viewer cannot name (Paragon: MI_Generic_Metal sets Baked_Normal
  // to the engine's flat normal map over its parent's T_EvilGate_Piece1_N); it supersedes the same way.
  for (let level = 0; level < chain.length; level += 1) {
    const replacing: { name: string; texture: string | undefined }[] = [
      ...chain[level]!.overrides,
      ...chain[level]!.unresolvedOverrides.map((name) => ({ name, texture: undefined })),
    ];
    for (const override of replacing) {
      for (let ancestor = level + 1; ancestor < chain.length; ancestor += 1) {
        // The value a descendant replaces is the nearest ancestor's: an ancestor INSTANCE's own override
        // (Paragon: MM_Marble_Walls_Inst sets Plain_Wall_M, the leaf sets another) as much as a master's default.
        const parentDefault =
          chain[ancestor]!.overrides.find((candidate) => key(candidate.name) === key(override.name)) ??
          chain[ancestor]!.collected.find((candidate) => key(candidate.name) === key(override.name));
        if (parentDefault && parentDefault.texture !== override.texture && !result.has(parentDefault.texture)) {
          result.set(parentDefault.texture, { parameter: override.name, override: override.texture });
          break;
        }
      }
    }
  }
  // A texture that is also the effective value of a parameter nobody overrides is still in use;
  // suppressing it would drop a real binding.
  const overridden = new Set(chain.flatMap((props) => [...props.overrides.map((override) => override.name), ...props.unresolvedOverrides].map(key)));
  for (const props of chain) {
    for (const parameter of props.collected) {
      if (!overridden.has(key(parameter.name))) result.delete(parameter.texture);
    }
  }
  return result;
}

/**
 * Resolves one material, following `Parent` chains with a visited set so a self-referential or
 * mutually-referential instance terminates instead of recursing forever.
 */
export function resolveMaterial(request: ResolveMaterialRequest): ResolvedMaterial {
  const bindings = new Map<GltfSlot, MaterialTextureBinding>();
  const claimed = new Set<string>();
  const seenMaterials = new Set<string>();
  const parents: string[] = [];
  const limitations = new Set<string>();
  const superseded = supersededDefaults(request);

  let alphaMode: ResolvedMaterial["alphaMode"] = "OPAQUE";
  let alphaCutoff: number | undefined;
  let doubleSided = false;
  let inheritedSidedness: boolean | undefined;
  let inheritedBlend: string | undefined;
  let sawAlphaSource = false;
  let baseColorFactorValue: [number, number, number, number] | undefined;
  let emissive: [number, number, number] | undefined;
  let metallic: number | undefined;
  let roughness: number | undefined;
  let opacity: number | undefined;
  /** Textures UE Viewer names as the material's opacity (`Opacity=` slot, or an `Other` named `*_Opacity*`), nearest material first. */
  const opacityTextures: string[] = [];

  const bind = (
    plan: SlotPlan,
    texture: string,
    source: BindingSource,
    confidence: BindingConfidence,
  ): void => {
    claimed.add(texture);
    const replacement = superseded.get(texture);
    if (replacement) {
      // The instance replaces this parent default. A replacement for the same slot is bound
      // exactly; one for a different slot or a packed data map is never painted in its place.
      const replacementPlan = planForParameterName(replacement.parameter);
      if (replacement.override === undefined) {
        limitations.add(`${texture} is the parent default of "${replacement.parameter}", overridden by an engine texture outside the pack; it is not bound for ${plan.slot}.`);
      } else if (replacementPlan?.slot === plan.slot && !isDataTexture(replacement.override)) {
        claimed.add(replacement.override);
        if (!bindings.has(plan.slot) && request.availableTextures.has(replacement.override)) {
          bindings.set(plan.slot, { slot: plan.slot, texture: replacement.override, source: "props", confidence: "exact", transform: replacementPlan.transform });
        }
      } else {
        limitations.add(`${texture} is the parent default of "${replacement.parameter}", overridden by ${replacement.override}; the override has no standard PBR slot here, so neither is bound for ${plan.slot}.`);
      }
      return;
    }
    if (bindings.has(plan.slot)) return;
    if (!request.availableTextures.has(texture)) return;
    bindings.set(plan.slot, {
      slot: plan.slot,
      texture,
      source,
      confidence,
      transform: plan.transform,
    });
  };

  let current: string | undefined = request.name;
  for (let depth = 0; current && depth < MAX_PARENT_DEPTH; depth += 1) {
    if (seenMaterials.has(current)) break;
    seenMaterials.add(current);
    if (depth > 0) parents.push(current);

    const matText = request.readMat(current);
    const propsText = request.readProps(current);
    const mat = matText ? parseMatFile(matText) : undefined;
    const props = propsText ? parsePropsFile(propsText) : undefined;
    if (propsText && /^\s*Expressions\[[1-9]\d*\]/m.test(propsText)) {
      limitations.add("Unreal shader expression connections are unavailable: layer blending, graph UV transforms, subsurface lighting, normal strength and vertex deformation are not reconstructed by standard glTF PBR.");
    }

    if (mat) {
      for (const [key, texture] of mat.slots) {
        if (key === "Opacity" || key === "Mask") {
          claimed.add(texture);
          sawAlphaSource = true;
          if (key === "Opacity" && !opacityTextures.includes(texture)) opacityTextures.push(texture);
          continue;
        }
        if (key === "Cube") {
          claimed.add(texture);
          continue;
        }
        const plan = MAT_SLOT_PLAN[key];
        if (plan) bind(plan, texture, "mat", "exact");
      }
    }

    if (props) {
      if (props.overrideFlagsMissing) limitations.add("Material-instance override flags are unavailable: ambiguous opaque, false and zero defaults inherit parent settings; non-default values retain legacy behavior without certifying the effective Unreal settings.");
      inheritedSidedness ??= props.twoSided;
      inheritedBlend ??= props.blendMode;
      alphaCutoff ??= props.opacityMaskClipValue;
      // `props.collected` are the material's declared texture-parameter defaults. A parameter can exist
      // without being wired to any output (or wired only behind a static switch that evaluates off), so its
      // default texture is not evidence of a live slot. When UE Viewer resolved the graph and named slots in
      // the `.mat`, a default whose texture is already one of those named outputs is a shared placeholder, not
      // a second live slot: bind only defaults whose texture the `.mat` left unattributed (in `Other[]`), which
      // is exactly how a parameter name recovers a diffuse umodel could not place. `props.overrides` still fills
      // slots below, and `supersededDefaults` applies those over any default bound here.
      const matNamedTextures = mat ? new Set(mat.slots.values()) : undefined;
      for (const parameter of props.collected) {
        const plan = planForParameterName(parameter.name);
        if (!plan) continue;
        if (matNamedTextures?.has(parameter.texture)) continue;
        bind(plan, parameter.texture, "props", "heuristic");
      }
      // An instance's own overrides fill slots umodel did not resolve. They never displace a
      // `.mat` slot: umodel walked the real graph to produce that one, and a parameter name is
      // only a name.
      for (const parameter of props.overrides) {
        const plan = planForParameterName(parameter.name);
        if (plan) bind(plan, parameter.texture, "props", "heuristic");
      }
      // The current instance is visited before its parents. Own overrides therefore win, then
      // collected defaults fill only values that remain unset.
      for (const parameter of [...props.scalarOverrides, ...props.scalars]) {
        const key = normalizedParameterName(parameter.name);
        if (["rough", "roughness"].includes(key) && roughness === undefined) {
          roughness = clamp01(parameter.value);
        } else if (["metal", "metallic", "metalness"].includes(key) && metallic === undefined) {
          metallic = clamp01(parameter.value);
        } else if (["opacity", "alpha", "transparency"].includes(key) && opacity === undefined) {
          opacity = clamp01(parameter.value);
        }
      }
      for (const parameter of [...props.vectorOverrides, ...props.vectors]) {
        const key = normalizedParameterName(parameter.name);
        const value = parameter.value;
        if (["basecolor", "basecolour", "albedo", "color", "colour", "tint"].includes(key) && !baseColorFactorValue) {
          baseColorFactorValue = [clamp01(value[0]), clamp01(value[1]), clamp01(value[2]), clamp01(value[3])];
        } else if (["emissive", "emission", "emissivecolor"].includes(key) && !emissive) {
          emissive = [clamp01(value[0]), clamp01(value[1]), clamp01(value[2])];
        }
      }
    }

    if (mat) {
      for (const texture of mat.others) {
        if (claimed.has(texture)) continue;
        const plan = planForFileName(texture);
        if (plan) bind(plan, texture, "filename", "heuristic");
        else if (/(?:^|_)opacity(?:_|\d|$)/i.test(texture) && !opacityTextures.includes(texture)) opacityTextures.push(texture);
      }
    }

    current = props?.parent;
  }

  doubleSided = inheritedSidedness ?? false;
  alphaMode = inheritedBlend === "BLEND_Masked" ? "MASK"
    : inheritedBlend === "BLEND_Translucent" ? "BLEND" : "OPAQUE";
  alphaCutoff = alphaMode === "MASK" ? alphaCutoff ?? 0.333 : undefined;

  // Last resort: complete a texture set by its own naming.
  //
  // Unreal materials that blend two surfaces by vertex colour — the moss and dirt variants of a
  // rock master material are the common case — have no single diffuse input, so umodel resolves
  // none and the section would ship flat grey. The material still references a coherent texture
  // set, and a set is named `<stem>_N` beside `<stem>_<something>`. When the base colour is
  // otherwise unbound, that sibling is the colour map far more often than not. It is recorded as
  // heuristic, and a grey rock is a worse answer than a probable one.
  if (!bindings.has("baseColor")) {
    // "Claimed" only means some rule looked at it; a texture recognized as a normal map while the
    // normal slot was already taken is still unused pixels. What disqualifies a candidate here is
    // being bound to a slot, not having been considered.
    const boundAlready = new Set([...bindings.values()].map((binding) => binding.texture));
    const unmapped = [...referencedTextures(request, seenMaterials)].filter(
      (texture) => !boundAlready.has(texture) && !superseded.has(texture) && request.availableTextures.has(texture),
    );
    const stems = new Map<string, string[]>();
    for (const texture of unmapped) {
      const stem = texture.replace(/_[A-Za-z0-9]+$/, "");
      stems.set(stem, [...(stems.get(stem) ?? []), texture]);
    }
    for (const [, members] of stems) {
      if (members.length < 2) continue;
      const normal = members.find((texture) => /_n(?:_tex)?$/i.test(texture));
      const colour = members.find((texture) => texture !== normal);
      if (!normal || !colour) continue;
      bind({ slot: "baseColor", transform: "none" }, colour, "texture-set", "heuristic");
      // The set's own normal is more specific than whatever the parent resolved.
      claimed.add(normal);
      if (!bindings.has("normal")) {
        bind({ slot: "normal", transform: "none" }, normal, "texture-set", "heuristic");
      }
      break;
    }
  }

  // A `*_D_R` base colour also carries roughness in its alpha channel.
  const baseColor = bindings.get("baseColor");
  if (baseColor && !bindings.has("metallicRoughness") && packsRoughnessInAlpha(baseColor.texture)) {
    bindings.set("metallicRoughness", {
      slot: "metallicRoughness",
      texture: baseColor.texture,
      source: baseColor.source,
      confidence: "heuristic",
      transform: "alphaToRoughness",
    });
  }

  // glTF has one combined metallic-roughness texture while Unreal commonly references two
  // grayscale images. Preserve both by packing roughness.red -> G and metalness.red -> B.
  const referenced = new Set([...referencedTextures(request, seenMaterials)].filter((texture) => !superseded.has(texture)));

  // A shared graph can emit unrelated first samples as Diffuse and Normal. Correct only that
  // contradiction, using one coherent referenced family. A name or streaming record is a
  // heuristic; neither recovers shader links, layered masks, normal strength or subsurface light.
  const colourStem = (texture: string): string | undefined =>
    /^(.*)_(?:a|d|albedo|diffuse|basecolou?r)(?:_\d+)?_?$/i.exec(texture)?.[1]?.toLowerCase();
  const normalStem = (texture: string): string | undefined =>
    /^(.*)_(?:n|normal)(?:_tex)?$/i.exec(texture)?.[1]?.toLowerCase();
  const diffuse = bindings.get("baseColor");
  const normal = bindings.get("normal");
  const families = [...new Set([...referenced].flatMap((texture) => colourStem(texture) ?? []))]
    .flatMap((stem) => {
      const colours = [...referenced].filter((texture) => colourStem(texture) === stem && request.availableTextures.has(texture));
      const normals = [...referenced].filter((texture) => normalStem(texture) === stem && request.availableTextures.has(texture));
      return colours.length === 1 && normals.length === 1 ? [{ stem, colour: colours[0]!, normal: normals[0]! }] : [];
    });
  const candidatesFor = (section: string) => {
    const text = request.readProps(section);
    const streamed = text ? parsePropsFile(text).streamingTextures : [];
    return streamed.length > 0
      ? families.filter(({ stem }) => streamed.some((texture) => colourStem(texture) === stem || normalStem(texture) === stem || texture.toLowerCase().startsWith(`${stem}_`)))
      : families.filter(({ stem }) => stem.replace(/^(?:t|tex)_/, "").split("_").every((token) => section.toLowerCase().split("_").includes(token)));
  };
  const sectionFamilies = new Set([...(request.sharedGraphMaterialNames ?? [])].flatMap((section) => {
    const candidates = candidatesFor(section);
    return candidates.length === 1 ? candidates[0]!.stem : [];
  }));
  if (sectionFamilies.size > 1 && diffuse?.source === "mat" && normal?.source === "mat"
    && colourStem(diffuse.texture) && normalStem(normal.texture)
    && colourStem(diffuse.texture) !== normalStem(normal.texture) && families.length > 1) {
    limitations.add("Duplicated shared-graph samples conflict with distinct section families; texture-family selection is heuristic, not recovered Unreal shader routing.");
    const candidates = candidatesFor(request.name);
    if (candidates.length === 1) {
      const family = candidates[0]!;
      const opacityCandidates = [...referenced].filter((texture) => request.availableTextures.has(texture) && /_(?:o|opacity)$/i.test(texture) && texture.replace(/_(?:o|opacity)$/i, "").toLowerCase() === family.stem);
      const mask = alphaMode === "MASK" && opacityCandidates.length === 1 ? opacityCandidates[0] : undefined;
      if (mask) limitations.add("Separate opacity.red is inferred from the selected texture family; equal source dimensions and shared TEXCOORD_0 are assumed. The original colour RGB is preserved.");
      bindings.set("baseColor", { slot: "baseColor", texture: family.colour, ...(mask ? { secondaryTexture: mask } : {}), source: "texture-set", confidence: "heuristic", transform: mask ? "redToBaseColorAlpha" : "none" });
      bindings.set("normal", { slot: "normal", texture: family.normal, source: "texture-set", confidence: "heuristic", transform: "none" });
    } else {
      // Conflicting graph samples are not exact merely because no safe replacement was found.
      bindings.set("baseColor", { ...diffuse, confidence: "heuristic" });
      bindings.set("normal", { ...normal, confidence: "heuristic" });
    }
  }

  // UE Viewer labels the first texture of a diffuse chain `Diffuse` when it cannot reduce the
  // graph, and in older packs that is often a data map: a rock's height/AO/curvature mask, a
  // brick wall's gloss. A filename cannot normally outrank the resolved `.mat`, but a data-named
  // base colour is a contradiction: take the graph's explicit colour image, or none at all —
  // a neutral surface beats one painted with a mask.
  const resolvedBaseColor = bindings.get("baseColor");
  if (resolvedBaseColor && isDataTexture(resolvedBaseColor.texture)) {
    const colour = [...referenced].find(
      (texture) => request.availableTextures.has(texture) && isColourTexture(texture),
    );
    if (colour) {
      bindings.set("baseColor", {
        slot: "baseColor",
        texture: colour,
        source: "filename",
        confidence: "heuristic",
        transform: "none",
      });
    } else {
      bindings.delete("baseColor");
    }
  }

  // Megascans foliage blends seasonal texture sets, and UE Viewer resolves the graph's first sample
  // — the Winter set, which turns every leaf brown. The packs' default look is Summer, so a Winter
  // or Autumn texture yields to its Summer sibling when the same graph references one.
  for (const [slot, binding] of bindings) {
    const summer = binding.texture.replace(/_(winter|autumn|fall)(?=_|$)/i, "_summer").toLowerCase();
    if (summer === binding.texture.toLowerCase()) continue;
    const sibling = [...referenced].find(
      (texture) => texture.toLowerCase() === summer && request.availableTextures.has(texture),
    );
    if (!sibling) continue;
    bindings.set(slot, { ...binding, texture: sibling, confidence: "heuristic", substitutedFrom: binding.texture });
    limitations.add(`Winter/Autumn texture ${binding.texture} replaced by its Summer sibling ${sibling} (heuristic default look)`);
  }

  const metallicRoughness = bindings.get("metallicRoughness");
  if (metallicRoughness?.transform === "redToRoughness") {
    const metalness = [...referenced].find(
      (texture) =>
        request.availableTextures.has(texture) &&
        /(_metallic|_metalness)(_tex)?$/i.test(texture),
    );
    if (metalness) {
      claimed.add(metalness);
      bindings.set("metallicRoughness", {
        ...metallicRoughness,
        secondaryTexture: metalness,
        transform: "redRoughnessRedMetalness",
      });
    }
  }

  // A masked or translucent section whose cut-out lives in a separate opacity map (a grass card's blades) keeps the
  // base colour's RGB and takes the map's red channel as alpha. Without it the card is a solid rectangle, and an
  // instance colour with a zero alpha would clip all of it.
  const colourForAlpha = bindings.get("baseColor");
  const opacityMap = opacityTextures.find((texture) => request.availableTextures.has(texture) && texture !== colourForAlpha?.texture);
  if (
    opacityMap && colourForAlpha && alphaMode !== "OPAQUE" && colourForAlpha.secondaryTexture === undefined &&
    colourForAlpha.transform === "none" && request.availableTextures.has(colourForAlpha.texture)
  ) {
    bindings.set("baseColor", { ...colourForAlpha, secondaryTexture: opacityMap, confidence: "heuristic", transform: "redToBaseColorAlpha" });
    limitations.add(`${opacityMap} is the material's opacity map: its red channel is the base colour's alpha; same UV layout is assumed (heuristic).`);
  }

  // Masked foliage takes its cutout from the base colour's own alpha channel.
  if (inheritedBlend === undefined && alphaMode === "OPAQUE" && sawAlphaSource && baseColor) {
    alphaMode = "MASK";
    alphaCutoff = 0.333;
  }

  const unsupported: UnsupportedTexture[] = [];
  const bound = new Set(
    [...bindings.values()].flatMap((binding) =>
      binding.secondaryTexture ? [binding.texture, binding.secondaryTexture] : [binding.texture],
    ),
  );
  for (const texture of referenced) {
    if (bound.has(texture)) continue;
    unsupported.push({
      texture,
      reason: claimed.has(texture)
        ? "recognized but has no glTF PBR counterpart"
        : "no exact, parameter-name, or filename mapping",
    });
  }

  return {
    name: request.name,
    bindings: [...bindings.values()],
    unsupported,
    alphaMode,
    alphaCutoff,
    doubleSided,
    // A colour parameter's alpha is not opacity in Unreal, and a `Tint` of A=0 is common on a surface that draws fully
    // (a zero alpha here would clip every pixel of a masked section). Only a partial alpha is kept, as before.
    baseColorFactor: baseColorFactorValue
      ? [baseColorFactorValue[0], baseColorFactorValue[1], baseColorFactorValue[2], opacity ?? (baseColorFactorValue[3] > 0 ? baseColorFactorValue[3] : 1)]
      : opacity === undefined
        ? undefined
        : [1, 1, 1, opacity],
    emissiveFactor: emissive,
    metallicFactor: metallic,
    roughnessFactor: roughness,
    parents,
    limitations: [...limitations],
  };
}
