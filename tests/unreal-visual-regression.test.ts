import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Document, NodeIO } from "@gltf-transform/core";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { renderTiles } from "../src/unreal/contact-sheet.js";
import { createGraphBaker } from "../src/unreal/graph-baker.js";
import { materialGraphSchema } from "../src/unreal/graph-dump.js";
import { scopeParentChain } from "../src/unreal/importer.js";
import { compareImages, decodeRgba, type RgbaImage } from "../src/unreal/image-diff.js";
import { bakeGraph, type TextureRaster } from "../src/unreal/material-graph.js";
import { resolveMaterial, type ResolveMaterialRequest } from "../src/unreal/materials.js";
import { WASHED_OUT_LUMA, judgeRender } from "../src/unreal/visual-judge.js";
import { describeWithTools } from "./helpers/require-tool.js";

// A committed, synthetic golden-image suite for the Fab/Unreal importer's rendered output. It builds
// tiny GLBs in the test (no licensed pack bytes), renders them through the production tile renderer
// with its fixed camera, asserts per-fixture numeric invariants through the visual judge, and compares
// each tile to a small committed PNG. The importer-dependent fixtures (the zero-alpha tint and the
// emissive effect) take their factors from the real material resolver, so reverting those fixes turns
// the suite red. Update the goldens with `npm run goldens:update`.

const TILE = 120;
const GOLDEN_DIR = fileURLToPath(new URL("./fixtures/visual-golden/", import.meta.url));
const DIFF_DIR = join(process.cwd(), "artifacts", "ci", "visual-diff");
/**
 * Minimum SSIM against the committed golden. SwiftShader is deterministic on one machine but its
 * rasterisation and the three.js version can differ between hosts, so an exact match is not expected.
 * 0.90 tolerates sub-pixel edge and antialiasing differences while still catching any real change in
 * colour, coverage, alpha or shape (the numeric invariants below guard the same fixtures more tightly).
 */
const GOLDEN_SSIM_MIN = 0.9;

type Geometry = "quad" | "cube";

interface GlbOptions {
  readonly name: string;
  readonly geometry: Geometry;
  readonly baseColorFactor: readonly [number, number, number, number];
  readonly texture?: Buffer;
  readonly alphaMode?: "OPAQUE" | "MASK" | "BLEND";
  readonly alphaCutoff?: number;
  readonly emissiveFactor?: readonly [number, number, number];
  readonly doubleSided?: boolean;
}

/** Writes a tiny GLB: an XY quad or an axis-aligned cube, with one material. */
async function writeGlb(path: string, options: GlbOptions): Promise<void> {
  const document = new Document();
  const buffer = document.createBuffer();
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  if (options.geometry === "quad") {
    positions.push(-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0);
    normals.push(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1);
    uvs.push(0, 1, 1, 1, 1, 0, 0, 0);
    indices.push(0, 1, 2, 0, 2, 3);
  } else {
    const h = 0.5;
    const faces: [number[], number[]][] = [
      [[1, 0, 0], [0, 1, 0]],
      [[-1, 0, 0], [0, 0, 1]],
      [[0, 1, 0], [0, 0, 1]],
      [[0, -1, 0], [1, 0, 0]],
      [[0, 0, 1], [1, 0, 0]],
      [[0, 0, -1], [0, 1, 0]],
    ];
    for (const [n, u] of faces) {
      const v = [n[1]! * u[2]! - n[2]! * u[1]!, n[2]! * u[0]! - n[0]! * u[2]!, n[0]! * u[1]! - n[1]! * u[0]!];
      const base = positions.length / 3;
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        for (let axis = 0; axis < 3; axis++) positions.push((n[axis]! + a * u[axis]! + b * v[axis]!) * h);
        normals.push(...n);
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const material = document
    .createMaterial(options.name)
    .setBaseColorFactor([...options.baseColorFactor])
    .setMetallicFactor(0)
    .setRoughnessFactor(1);
  if (options.texture !== undefined) {
    const texture = document.createTexture(options.name).setImage(new Uint8Array(options.texture)).setMimeType("image/png");
    material.setBaseColorTexture(texture);
  }
  if (options.alphaMode !== undefined) material.setAlphaMode(options.alphaMode);
  if (options.alphaCutoff !== undefined) material.setAlphaCutoff(options.alphaCutoff);
  if (options.emissiveFactor !== undefined) material.setEmissiveFactor([...options.emissiveFactor]);
  if (options.doubleSided === true) material.setDoubleSided(true);

  const primitive = document
    .createPrimitive()
    .setAttribute("POSITION", document.createAccessor().setType("VEC3").setArray(new Float32Array(positions)).setBuffer(buffer))
    .setAttribute("NORMAL", document.createAccessor().setType("VEC3").setArray(new Float32Array(normals)).setBuffer(buffer))
    .setIndices(document.createAccessor().setType("SCALAR").setArray(new Uint16Array(indices)).setBuffer(buffer))
    .setMaterial(material);
  if (options.texture !== undefined) {
    primitive.setAttribute("TEXCOORD_0", document.createAccessor().setType("VEC2").setArray(new Float32Array(uvs)).setBuffer(buffer));
  }
  const mesh = document.createMesh(options.name).addPrimitive(primitive);
  document.createScene().addChild(document.createNode(options.name).setMesh(mesh));
  await new NodeIO().write(path, document);
}

/** A brown, noisy diffuse colour texture (a wood albedo stand-in). */
async function woodTexture(): Promise<Buffer> {
  const size = 64;
  const data = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = Math.sin(x * 0.7) * 8 + Math.cos(y * 0.5) * 8 + ((x * 7 + y * 3) % 5);
      data.set([150 + n, 110 + n, 70 + n, 255], (y * size + x) * 4);
    }
  }
  return sharp(data, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
}

/** A ragged, needle-spray-like alpha cut-out inside a disc: about a quarter of the disc is opaque. */
async function raggedAlphaTexture(): Promise<Buffer> {
  const size = 64;
  const data = Buffer.alloc(size * size * 4);
  const cx = 32;
  const cy = 32;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const inDisc = dx * dx + dy * dy <= 30 * 30;
      const spray = (x * 13 + y * 7) % 4 < 1;
      data.set([40, 170, 60, inDisc && spray ? 255 : 0], (y * size + x) * 4);
    }
  }
  return sharp(data, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
}

/**
 * A leaf card the way the graph baker produces it: BaseColor = leaf texture, Opacity = Desaturation(mask texture), the
 * silhouette living only in the mask (the Rusty Cars ivy). Baked for real with `alpha: "opacity"`; if the baker stopped
 * writing the cut-out, this card would be a solid green square.
 */
async function graphBakedLeafTexture(): Promise<Buffer> {
  const size = 64;
  const raster = (texel: (x: number, y: number) => [number, number, number]): TextureRaster => {
    const rgba = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) rgba.set([...texel(x, y), 255], (y * size + x) * 4);
    return { width: size, height: size, rgba, srgb: true };
  };
  const leaf = raster(() => [50, 130, 55]);
  // A leaf-shaped (pointed ellipse) white mask on black: roughly a third of the card.
  const mask = raster((x, y) => {
    const dx = (x - 32) / 30;
    const dy = (y - 32) / 18;
    return dx * dx + dy * dy <= 1 && Math.abs(dy) <= 1 - Math.abs(dx) * 0.5 ? [255, 255, 255] : [0, 0, 0];
  });
  const pin = (node: string, mask: number[] | null = null) => ({ node, output: 0, mask });
  const nodes = [
    { id: "leaf", class: "TextureSample", inputs: {}, constants: {}, texture: "/Game/Test/T_Leaf.T_Leaf", samplerType: "Color" },
    { id: "mask", class: "TextureSample", inputs: {}, constants: {}, texture: "/Game/Test/T_Mask.T_Mask", samplerType: "Color" },
    { id: "gray", class: "Desaturation", inputs: { Input: pin("mask", [1, 1, 1, 0]) }, constants: {} },
  ];
  const graph = materialGraphSchema.parse({
    format: 1,
    material: "M_Leaf",
    package: "/Game/Test/M_Leaf",
    truncated: false,
    nodeCount: nodes.length,
    outputs: { baseColor: pin("leaf", [1, 1, 1, 0]), roughness: null, metallic: null, emissive: null, opacity: pin("gray"), opacityMask: null, normal: null, materialAttributes: null },
    nodes,
  });
  const result = await bakeGraph({
    graph,
    output: "baseColor",
    parameters: { textures: new Map(), vectors: new Map(), scalars: new Map(), switches: new Map() },
    loadTexture: async (name) => (name.includes("T_Leaf") ? leaf : name.includes("T_Mask") ? mask : undefined),
    size,
    alpha: "opacity",
  });
  if (result.status !== "baked") throw new Error(`leaf bake failed: ${JSON.stringify(result)}`);
  return result.png;
}

const resolve = (request: Omit<ResolveMaterialRequest, "readMat" | "readProps"> & {
  readonly files: Record<string, { mat?: string; props?: string }>;
}) =>
  resolveMaterial({
    name: request.name,
    readMat: (material) => request.files[material]?.mat,
    readProps: (material) => request.files[material]?.props,
    availableTextures: request.availableTextures,
  });

/** The grass library's shape: a masked master with a `Tint` of A=0, an instance with no override. */
function zeroAlphaTintFactor(): readonly [number, number, number, number] {
  const masterProps = [
    "BlendMode = BLEND_Masked (1)",
    "OpacityMaskClipValue = 0.333",
    "CollectedVectorParameters[1] =",
    "{",
    "    CollectedVectorParameters[0] =",
    "    {",
    "        Value = { R=1, G=1, B=1, A=0 }",
    "        Name = Tint",
    "    }",
    "}",
  ].join("\n");
  const instanceProps = "Parent = Material3'Content/Pack/Materials/MA_Grass.MA_Grass'\nVectorParameterValues[0] = {}\n";
  const resolved = resolve({
    name: "Grass_Mat",
    availableTextures: new Set(["Grass_Albedo"]),
    files: {
      Grass_Mat: { mat: "Diffuse=Grass_Albedo\n", props: instanceProps },
      MA_Grass: { mat: "Diffuse=Grass_Albedo\n", props: masterProps },
    },
  });
  return resolved.baseColorFactor ?? [1, 1, 1, 1];
}

/** An unused Emissive parameter default (the Old West grey-emissive regression) resolved for real. */
function emissiveFactor(): readonly [number, number, number] {
  const props = [
    "CollectedVectorParameters[1] =",
    "{",
    "    CollectedVectorParameters[0] =",
    "    {",
    "        Value = { R=0, G=1, B=0.4, A=1 }",
    "        Name = Emissive",
    "    }",
    "}",
  ].join("\n");
  const resolved = resolve({
    name: "M_Foam",
    availableTextures: new Set(),
    files: { M_Foam: { props } },
  });
  return resolved.emissiveFactor ?? [0, 0, 0];
}

/** An instance's qualified base-colour tint override (the Old West curtain tint). */
function darkWoodFactor(): readonly [number, number, number, number] {
  const props = [
    "Parent = Material3'Content/Pack/Materials/MM_Wood.MM_Wood'",
    "VectorParameterValues[1] =",
    "{",
    "    VectorParameterValues[0] =",
    "    {",
    "        ParameterInfo = { Name=Diffuse Tint }",
    "        ParameterValue = { R=0.35, G=0.2, B=0.1, A=1 }",
    "    }",
    "}",
  ].join("\n");
  const resolved = resolve({
    name: "MI_Wood",
    availableTextures: new Set(["T_Wood_ALB"]),
    files: { MI_Wood: { mat: "Diffuse=T_Wood_ALB\n", props } },
  });
  return resolved.baseColorFactor ?? [1, 1, 1, 1];
}

/**
 * Old West wood: the instance's resolved `.mat` names Diffuse/Normal only, but its master declares an
 * `Emissive` texture parameter whose default is the neutral fill that is also the diffuse. Resolved for
 * real; if an emissive slot is bound, the importer would emit the flat grey (mean about 0.72) at factor 1.
 */
function unwiredEmissiveGrey(): readonly [number, number, number] {
  const tex = (name: string): string => `Texture2D'Content/Pack/Textures/${name}.${name}'`;
  const collected = (name: string, texture: string, index: number): string[] => [
    `    CollectedTextureParameters[${index}] =`,
    "    {",
    `        Texture = ${tex(texture)}`,
    `        Name = ${name}`,
    "        Group = Base",
    "    }",
  ];
  const masterProps = [
    "CollectedTextureParameters[2] =",
    "{",
    ...collected("Albedo", "TX_Fill_ALB", 0),
    ...collected("Emissive", "TX_Fill_ALB", 1),
    "}",
  ].join("\n");
  const resolved = resolve({
    name: "MI_Chair",
    availableTextures: new Set(["TX_Chair_ALB", "TX_Fill_ALB"]),
    files: {
      MI_Chair: {
        mat: "Diffuse=TX_Chair_ALB\nOther[0]=TX_Fill_ALB\n",
        props: "Parent = Material3'Content/Pack/Materials/MM_Master.MM_Master'\n",
      },
      MM_Master: { mat: "Diffuse=TX_Fill_ALB\n", props: masterProps },
    },
  });
  return resolved.bindings.some((binding) => binding.slot === "emissive") ? [0.72, 0.72, 0.72] : [0, 0, 0];
}

/** A leaf albedo of one flat hue with mild noise (the importer binds only plausible albedos; this is a render fixture). */
async function leafTexture(rgb: readonly [number, number, number]): Promise<Buffer> {
  const size = 32;
  const data = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = ((x * 5 + y * 3) % 7) - 3;
      data.set([rgb[0] + n, rgb[1] + n, rgb[2] + n, 255], (y * size + x) * 4);
    }
  }
  return sharp(data, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
}

/**
 * Landscape Pro's dead trees: `DeadTrees/MI_Leafs_Parent` overrides Diffuse with the dry leaf and `GreenTrees/MI_Leafs_Parent`
 * (same basename) with the green one. The instance's `Parent =` line names DeadTrees; the sidecar index is keyed by
 * basename, so the importer must follow the package or the dead tree renders green. Resolved for real through the
 * importer's parent scoping.
 */
async function deadLeafTextureName(dir: string): Promise<"T_Dry_Leaf" | "T_Green_Leaf"> {
  const reference = (folder: string, name: string, cls = "Texture2D"): string => `${cls}'Content/Pack/${folder}/${name}.${name}'`;
  const instance = (parentFolder: string): string => `Parent = MaterialInstanceConstant'Content/Pack/${parentFolder}/MI_Leafs_Parent.MI_Leafs_Parent'\n`;
  const overrideOf = (texture: string): string =>
    [
      "Parent = Material3'Content/Pack/Master/M_Leafs.M_Leafs'",
      "TextureParameterValues[1] =",
      "{",
      "    TextureParameterValues[0] =",
      "    {",
      "        ParameterInfo = { Name=None }",
      `        ParameterValue = ${reference("Textures", texture)}`,
      "        ParameterName = Diffuse",
      "    }",
      "}",
    ].join("\n");
  const master = ["CollectedTextureParameters[1] =", "{", "    CollectedTextureParameters[0] =", "    {", `        Texture = ${reference("Textures", "T_Dry_Leaf")}`, "        Name = Diffuse", "        Group = Base", "    }", "}"].join("\n");
  const root = join(dir, "leaf-index");
  const folders = { dead: join(root, "DeadTrees"), green: join(root, "GreenTrees"), tree: join(root, "DeadTrees", "tree02") };
  for (const folder of Object.values(folders)) await mkdir(folder, { recursive: true });
  await writeFile(join(folders.tree, "MI_Leafs_lod00.props.txt"), instance("DeadTrees"));
  await writeFile(join(folders.tree, "MI_Leafs_lod00.mat"), "Diffuse=T_Dry_Leaf\n");
  await writeFile(join(folders.dead, "MI_Leafs_Parent.props.txt"), overrideOf("T_Dry_Leaf"));
  await writeFile(join(folders.green, "MI_Leafs_Parent.props.txt"), overrideOf("T_Green_Leaf"));
  await writeFile(join(root, "M_Leafs.props.txt"), master);
  const props = new Map([
    ["MI_Leafs_lod00", join(folders.tree, "MI_Leafs_lod00.props.txt")],
    // Indexed last, as in the real pack: the green namesake.
    ["MI_Leafs_Parent", join(folders.green, "MI_Leafs_Parent.props.txt")],
    ["M_Leafs", join(root, "M_Leafs.props.txt")],
  ]);
  const propsAll = new Map([...props].map(([name, path]) => [name, name === "MI_Leafs_Parent" ? [join(folders.dead, "MI_Leafs_Parent.props.txt"), path] : [path]]));
  const scoped = scopeParentChain(
    { gltf: new Map(), psa: new Map(), mat: new Map(), props, matAll: new Map(), propsAll, png: new Map(), audio: new Map(), dna: new Map() },
    "MI_Leafs_lod00",
  );
  const read = async (path: string | undefined): Promise<string | undefined> => (path === undefined ? undefined : readFile(path, "utf8").catch(() => undefined));
  const texts = new Map<string, string>();
  for (const name of ["MI_Leafs_lod00", "MI_Leafs_Parent", "M_Leafs"]) {
    const text = await read(scoped.props.get(name));
    if (text !== undefined) texts.set(name, text);
  }
  const resolved = resolveMaterial({
    name: "MI_Leafs_lod00",
    readMat: (name) => (name === "MI_Leafs_lod00" ? "Diffuse=T_Dry_Leaf\n" : undefined),
    readProps: (name) => texts.get(name),
    availableTextures: new Set(["T_Dry_Leaf", "T_Green_Leaf"]),
  });
  const base = resolved.bindings.find((binding) => binding.slot === "baseColor")?.texture;
  return base === "T_Green_Leaf" ? "T_Green_Leaf" : "T_Dry_Leaf";
}

/**
 * Landscape Pro's rocks: two packages hold `M_Rock` (a tan cliff master and a dark mossy medium-rock master). The
 * instance's `Parent =` line names Medium. The baker must bake that graph, not the one the dump keys by plain name.
 * Returns the PNG the real graph baker produces.
 */
async function mossyRockBake(dir: string): Promise<Buffer> {
  const graph = (pkg: string, rgb: readonly [number, number, number]) =>
    materialGraphSchema.parse({
      format: 1,
      material: "M_Rock",
      package: pkg,
      truncated: false,
      nodeCount: 1,
      outputs: { baseColor: { node: "c", output: 0, mask: null }, roughness: null, metallic: null, emissive: null, opacity: null, opacityMask: null, normal: null, materialAttributes: null },
      nodes: [{ id: "c", class: "Constant3Vector", inputs: {}, constants: { Constant: [rgb[0], rgb[1], rgb[2], 1] } }],
    });
  const cliff = graph("/Game/Pack/Cliff/M_Rock", [0.5, 0.42, 0.3]);
  const medium = graph("/Game/Pack/Medium/M_Rock", [0.08, 0.13, 0.04]);
  const sourceDir = join(dir, "rock-source");
  await mkdir(join(sourceDir, "Content", "Pack"), { recursive: true });
  await writeFile(join(sourceDir, "Content", "Pack", "MI_Rock_Inst.uasset"), Buffer.alloc(16));
  const baker = createGraphBaker({
    sourceDir,
    maxTextureSize: 16,
    dumpGraphs: async () => new Map([["M_Rock", cliff], ["/Game/Pack/Medium/M_Rock", medium]]),
  })!;
  const outcome = await baker({
    materialName: "MI_Rock_Inst",
    lookupName: "MI_Rock_Inst",
    assets: { png: new Map() },
    readProps: (name) => (name === "MI_Rock_Inst" ? "Parent = Material3'Content/Pack/Medium/M_Rock.M_Rock'\n" : undefined),
  });
  if (outcome.status !== "baked") throw new Error(`rock bake failed: ${JSON.stringify(outcome)}`);
  return Buffer.from(outcome.png);
}

interface Fixture {
  readonly name: string;
  readonly path: string;
}

async function buildFixtures(dir: string): Promise<Fixture[]> {
  const wood = await woodTexture();
  const ragged = await raggedAlphaTexture();
  const graphLeaf = await graphBakedLeafTexture();
  const fixtures: Fixture[] = [];
  const write = async (name: string, options: Omit<GlbOptions, "name">): Promise<void> => {
    const path = join(dir, `${name}.glb`);
    await writeGlb(path, { name, ...options });
    fixtures.push({ name, path });
  };

  await write("dark-wood", { geometry: "quad", baseColorFactor: darkWoodFactor(), texture: wood });
  await write("wood-unwired-emissive", {
    geometry: "quad",
    baseColorFactor: darkWoodFactor(),
    texture: wood,
    emissiveFactor: unwiredEmissiveGrey(),
  });
  await write("cutout-card", {
    geometry: "quad",
    baseColorFactor: [1, 1, 1, 1],
    texture: ragged,
    alphaMode: "MASK",
    alphaCutoff: 0.5,
    doubleSided: true,
  });
  await write("emissive-effect", {
    geometry: "quad",
    baseColorFactor: [0, 0, 0, 1],
    emissiveFactor: emissiveFactor(),
    alphaMode: "BLEND",
  });
  await write("zero-alpha-tint", {
    geometry: "quad",
    baseColorFactor: zeroAlphaTintFactor(),
    texture: ragged,
    alphaMode: "MASK",
    alphaCutoff: 0.5,
    doubleSided: true,
  });
  await write("graph-baked-leaf-card", {
    geometry: "quad",
    baseColorFactor: [1, 1, 1, 1],
    texture: graphLeaf,
    // What the importer exports for a binary Opacity cut-out.
    alphaMode: "MASK",
    alphaCutoff: 0.5,
    doubleSided: true,
  });
  await write("dead-tree-leaf", { geometry: "quad", baseColorFactor: [1, 1, 1, 1], texture: await leafTexture((await deadLeafTextureName(dir)) === "T_Green_Leaf" ? [60, 170, 50] : [150, 120, 80]) });
  await write("mossy-rock", { geometry: "cube", baseColorFactor: [1, 1, 1, 1], texture: await mossyRockBake(dir) });
  await write("solid-box", { geometry: "cube", baseColorFactor: [0.15, 0.3, 0.85, 1] });
  await write("neutral-grey", { geometry: "cube", baseColorFactor: [0.5, 0.5, 0.5, 1] });
  await write("solid-quad", { geometry: "quad", baseColorFactor: [0.2, 0.7, 0.3, 1] });
  return fixtures;
}

/** Mean RGB over the object pixels (those not within the judge's background tolerance of mid grey). */
function objectMeanRgb(image: RgbaImage): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < image.width * image.height; i++) {
    const o = i * 4;
    if (Math.abs(image.data[o]! - 128) <= 6 && Math.abs(image.data[o + 1]! - 128) <= 6 && Math.abs(image.data[o + 2]! - 128) <= 6) continue;
    r += image.data[o]!;
    g += image.data[o + 1]!;
    b += image.data[o + 2]!;
    n++;
  }
  return n === 0 ? [0, 0, 0] : [r / n, g / n, b / n];
}

async function pngFromRgba(image: RgbaImage): Promise<Buffer> {
  return sharp(Buffer.from(image.data), { raw: { width: image.width, height: image.height, channels: 4 } }).png().toBuffer();
}

/** Writes the actual tile and a heatmap of its difference from the golden, for CI artifact upload. */
async function writeDiffArtifacts(name: string, actual: RgbaImage, golden: RgbaImage): Promise<void> {
  await mkdir(DIFF_DIR, { recursive: true });
  await writeFile(join(DIFF_DIR, `actual-${name}.png`), await pngFromRgba(actual));
  const diff = new Uint8Array(actual.data.length);
  for (let i = 0; i < diff.length; i += 4) {
    const d = Math.min(
      255,
      Math.abs(actual.data[i]! - golden.data[i]!) +
        Math.abs(actual.data[i + 1]! - golden.data[i + 1]!) +
        Math.abs(actual.data[i + 2]! - golden.data[i + 2]!),
    );
    diff[i] = d;
    diff[i + 1] = d;
    diff[i + 2] = d;
    diff[i + 3] = 255;
  }
  await writeFile(join(DIFF_DIR, `diff-${name}.png`), await pngFromRgba({ width: actual.width, height: actual.height, data: diff }));
}

describeWithTools(["chromium"], "unreal visual regression goldens", () => {
  let dir: string;
  let names: string[] = [];
  let byName = new Map<string, RgbaImage>();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "tn-visual-regression-"));
    const fixtures = await buildFixtures(dir);
    names = fixtures.map((fixture) => fixture.name);
    const result = await renderTiles({ glbPaths: fixtures.map((fixture) => fixture.path), tile: TILE });
    expect(result.rendered.every(Boolean)).toBe(true);
    byName = new Map(names.map((name, index) => [name, result.tiles[index]!]));
  }, 120_000);

  afterAll(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  });

  it("the cut-out card is far sparser than the solid quad", () => {
    const cutout = judgeRender(byName.get("cutout-card")!);
    const solid = judgeRender(byName.get("solid-quad")!);
    expect(cutout.stats.objectPixels).toBeGreaterThan(200);
    expect(solid.stats.fillRatio).toBeGreaterThan(0.5);
    expect(cutout.stats.fillRatio).toBeLessThan(solid.stats.fillRatio * 0.75);
  });

  it("a graph-baked leaf card keeps its silhouette: far sparser than a solid card, still green (Rusty Cars ivy)", async () => {
    const leaf = judgeRender(byName.get("graph-baked-leaf-card")!);
    const solid = judgeRender(byName.get("solid-quad")!);
    expect(leaf.stats.objectPixels).toBeGreaterThan(200);
    // A solid card would draw as many pixels as the solid quad; the leaf is about a third of it.
    expect(leaf.stats.objectPixels).toBeLessThan(solid.stats.objectPixels * 0.6);
    const [r, g, b] = objectMeanRgb(byName.get("graph-baked-leaf-card")!);
    expect(g).toBeGreaterThan(r * 1.3);
    expect(g).toBeGreaterThan(b * 1.3);
    // The numeric lock on the baked texture itself: about a third of the texels are opaque, matching the mask.
    const { data } = await sharp(await graphBakedLeafTexture()).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let opaque = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i]! >= 128) opaque++;
    expect(opaque / (data.length / 4)).toBeGreaterThan(0.25);
    expect(opaque / (data.length / 4)).toBeLessThan(0.5);
  });

  it("the zero-alpha-tint card is not blank", () => {
    const result = judgeRender(byName.get("zero-alpha-tint")!);
    expect(result.stats.objectPixels).toBeGreaterThan(200);
    expect(result.reasons).not.toContain("blank: nothing drawn");
    expect(result.verdict).not.toBe("fail");
  });

  it("dark wood stays dark and is not washed out", () => {
    const result = judgeRender(byName.get("dark-wood")!);
    expect(result.stats.objectPixels).toBeGreaterThan(200);
    expect(result.stats.meanLuma).toBeGreaterThan(10);
    expect(result.stats.meanLuma).toBeLessThan(180);
    expect(result.stats.meanLuma).toBeLessThan(WASHED_OUT_LUMA);
    expect(result.verdict).not.toBe("fail");
  });

  it("an unwired Emissive default does not wash dark wood out (Old West)", () => {
    const wood = judgeRender(byName.get("dark-wood")!);
    const washed = judgeRender(byName.get("wood-unwired-emissive")!);
    expect(washed.stats.objectPixels).toBeGreaterThan(200);
    expect(washed.stats.meanLuma).toBeLessThan(180);
    expect(washed.stats.meanLuma).toBeLessThan(wood.stats.meanLuma + 25);
    expect(washed.reasons.join()).not.toMatch(/washed out|white/);
  });

  it("a dead tree's leaf is dry brown, not the namesake package's green (Landscape Pro)", () => {
    const [r, g] = objectMeanRgb(byName.get("dead-tree-leaf")!);
    expect(r).toBeGreaterThan(g);
  });

  it("a medium rock bakes its own dark mossy master, not the tan cliff one (Landscape Pro)", () => {
    const result = judgeRender(byName.get("mossy-rock")!);
    const [r, g, b] = objectMeanRgb(byName.get("mossy-rock")!);
    expect(result.stats.meanLuma).toBeLessThan(115);
    expect(g).toBeGreaterThan(b);
    expect(r).toBeLessThan(120);
  });

  it("the solid box hue matches its base-colour factor", () => {
    const [r, g, b] = objectMeanRgb(byName.get("solid-box")!);
    expect(b).toBeGreaterThan(r * 1.4);
    expect(b).toBeGreaterThan(g * 1.4);
  });

  it("the emissive-only effect glows green", () => {
    const [r, g, b] = objectMeanRgb(byName.get("emissive-effect")!);
    expect(g).toBeGreaterThan(r * 1.5);
    expect(g).toBeGreaterThan(b * 1.2);
  });

  it("the neutral-grey default is judged ok", () => {
    const result = judgeRender(byName.get("neutral-grey")!);
    expect(result.verdict).toBe("ok");
  });

  it("matches every committed golden image", async () => {
    const updating = process.env.UPDATE_GOLDENS !== undefined;
    if (updating) await mkdir(GOLDEN_DIR, { recursive: true });
    const lines: string[] = [];
    for (const name of names) {
      const actual = byName.get(name)!;
      const goldenPath = join(GOLDEN_DIR, `${name}.png`);
      if (updating) {
        await writeFile(goldenPath, await pngFromRgba(actual));
        lines.push(`${name} updated`);
        continue;
      }
      const golden = await decodeRgba(await readFile(goldenPath));
      const comparison = await compareImages(actual, golden);
      if (comparison.ssim < GOLDEN_SSIM_MIN) await writeDiffArtifacts(name, actual, golden);
      expect(comparison.ssim, `${name}: SSIM ${comparison.ssim.toFixed(3)} vs golden`).toBeGreaterThanOrEqual(GOLDEN_SSIM_MIN);
      lines.push(`${name} ${comparison.ssim.toFixed(3)}`);
    }
    if (updating) {
      // eslint-disable-next-line no-console
      console.log(`Regenerated ${names.length} visual goldens in ${GOLDEN_DIR}: ${lines.join(", ")}`);
    } else if (process.env.VISUAL_GOLDEN_REPORT !== undefined) {
      // eslint-disable-next-line no-console
      console.log(`golden SSIM: ${lines.join(", ")}`);
    }
  }, 60_000);
});
