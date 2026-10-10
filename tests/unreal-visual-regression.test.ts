import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Document, NodeIO } from "@gltf-transform/core";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";

import { renderContactSheet, renderTiles } from "../src/unreal/contact-sheet.js";
import { dropUnreadVertexColours, packageGlb } from "../src/unreal/importer.js";
import type { SourceMaterial } from "../src/unreal/source-material.js";
import { writeMeshFixture } from "./helpers/unreal-fixture.js";
import { createGraphBaker } from "../src/unreal/graph-baker.js";
import type { SurfaceNormals } from "../src/unreal/surface-normals.js";
import { materialGraphSchema } from "../src/unreal/graph-dump.js";
import { scopeParentChain } from "../src/unreal/importer.js";
import { remapGltfSectionMaterials } from "../src/unreal/static-mesh-sections.js";
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

/**
 * A finely hatched mask (one opaque pixel in four, like needles on a card) as the blue channel of a packed `_AORO` map, and a
 * leaf-green colour map. Mipmapped, the mask averages to its 25% mean at distance, falls under the 0.333 cut and the card
 * vanishes; unmipped (what the pack authors for the map) the needles stay.
 */
async function writeNeedleCardPngs(dir: string, options: { vivid?: boolean; solidMask?: boolean } = {}): Promise<void> {
  const size = 512;
  const colour = Buffer.alloc(size * size * 3);
  const mask = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 3;
      // Vivid: saturated green blades beside red-brown tips (uncorrelated channels), like the Fern Collection's fern_02_A.
      colour.set(options.vivid ? (((x >> 5) + (y >> 5)) % 3 === 0 ? [200, 30, 20] : [20, 190, 30]) : [40, 170, 60], o);
      mask.set([255, 160, options.solidMask || (x + 2 * y) % 4 === 0 ? 255 : 0], o);
    }
  }
  await sharp(colour, { raw: { width: size, height: size, channels: 3 } }).png().toFile(join(dir, "Leaf_A.png"));
  await sharp(mask, { raw: { width: size, height: size, channels: 3 } }).png().toFile(join(dir, "Leaf_AORO.png"));
}

/** A masked foliage card exactly as the importer packages it: `Opacity=` names the colour map, the cut-out is the AORO blue. */
async function importedNeedleCard(dir: string, name: string, options: { noMipmaps?: boolean; specular?: number; vivid?: boolean; solidMask?: boolean }): Promise<string> {
  const source = join(dir, name);
  await writeMeshFixture(source, {
    name: "Mesh",
    materialName: "Leaf",
    mat: "Diffuse=Leaf_A\nOpacity=Leaf_A\nOther[0]=Leaf_AORO\n",
    props: "BlendMode = BLEND_Masked (1)\nOpacityMaskClipValue = 0.333\nTwoSided = true\n",
    textures: [],
  });
  await writeNeedleCardPngs(source, options);
  const authored: SourceMaterial | undefined =
    options.specular === undefined ? undefined : { channels: { Specular: { kind: "scalar", value: options.specular } }, baseColorSamples: [], limitations: [] };
  const glbPath = join(dir, `${name}.glb`);
  await packageGlb({
    gltfPath: join(source, "Mesh.gltf"),
    glbPath,
    keepAllUvSets: false,
    maxTextureSize: undefined,
    assets: {
      gltf: new Map(),
      mat: new Map([["Leaf", join(source, "Leaf.mat")]]),
      props: new Map([["Leaf", join(source, "Leaf.props.txt")]]),
      png: new Map([["Leaf_A", join(source, "Leaf_A.png")], ["Leaf_AORO", join(source, "Leaf_AORO.png")]]),
      psa: new Map(),
      audio: new Map(),
      dna: new Map(),
    },
    ...(options.noMipmaps ? { noMipmapTextures: new Set(["Leaf_AORO"]) } : {}),
    ...(authored ? { sourceMaterial: () => authored } : {}),
  });
  return glbPath;
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

/**
 * Landscape Pro's rock master blends moss over stone by the surface's world-space normal (`WorldAlignedBlend`, sharpness 10,
 * bias -2). Baked with a surface map whose left half faces up and right half faces sideways, the left half must be moss and
 * the right half stone; a bake that ignores the surface paints both halves the same mid blend.
 */
async function worldAlignedMossBake(dir: string): Promise<Buffer> {
  const pin = (node: string, output = 0) => ({ node, output, mask: null });
  const graph = materialGraphSchema.parse({
    format: 1,
    material: "M_Rock",
    package: "/Game/Pack/M_Rock",
    truncated: false,
    nodeCount: 6,
    outputs: { baseColor: pin("mix"), roughness: null, metallic: null, emissive: null, opacity: null, opacityMask: null, normal: null, materialAttributes: null },
    nodes: [
      { id: "mix", class: "LinearInterpolate", inputs: { A: pin("stone"), B: pin("moss"), Alpha: pin("aligned", 1) }, constants: {} },
      { id: "stone", class: "Constant3Vector", inputs: {}, constants: { Constant: [0.55, 0.45, 0.3, 1] } },
      { id: "moss", class: "Constant3Vector", inputs: {}, constants: { Constant: [0.05, 0.3, 0.03, 1] } },
      {
        id: "aligned",
        class: "FunctionCall",
        inputs: { Input2: pin("sharpness"), Input3: pin("bias") },
        constants: {},
        function: "/Engine/Functions/Engine_MaterialFunctions01/AlphaBlend/WorldAlignedBlend.WorldAlignedBlend",
        outputNames: ["Alpha", "w/Vertex Normals", "w/ Explicit Normal"],
        fn: { inputs: { Input2: "sharpness", Input3: "bias" }, outputs: [], output: null },
        error: "material function could not be loaded (engine content is not in the pack)",
      },
      { id: "sharpness", class: "Constant", inputs: {}, constants: { R: 10 } },
      { id: "bias", class: "Constant", inputs: {}, constants: { R: -2 } },
    ],
  });
  const size = 16;
  const normals = new Float32Array(size * size * 3);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) normals.set(x < size / 2 ? [0, 1, 0] : [1, 0, 0], (y * size + x) * 3);
  const surface: SurfaceNormals = { width: size, height: size, normals, covered: size * size };
  const sourceDir = join(dir, "moss-source");
  await mkdir(join(sourceDir, "Content", "Pack"), { recursive: true });
  await writeFile(join(sourceDir, "Content", "Pack", "MI_Rock.uasset"), Buffer.alloc(16));
  const baker = createGraphBaker({ sourceDir, maxTextureSize: 16, dumpGraphs: async () => new Map([["M_Rock", graph]]) })!;
  const outcome = await baker({
    materialName: "MI_Rock",
    lookupName: "MI_Rock",
    assets: { png: new Map() },
    surface: () => surface,
    readProps: (name) => (name === "MI_Rock" ? "Parent = Material3'Content/Pack/M_Rock.M_Rock'\n" : undefined),
  });
  if (outcome.status !== "baked") throw new Error(`moss bake failed: ${JSON.stringify(outcome)}`);
  return Buffer.from(outcome.png);
}

/**
 * Bakes a one-graph material through the real graph baker into a PNG. `view` fixtures are the view-dependent nodes of sky
 * and foliage materials that used to leave their whole section on the neutral grey fallback.
 */
async function viewNodeBake(dir: string, name: string, nodes: Record<string, unknown>[], outputPin: string): Promise<Buffer> {
  const graph = materialGraphSchema.parse({
    format: 1,
    material: "M_View",
    package: `/Game/Pack/${name}`,
    truncated: false,
    nodeCount: nodes.length,
    outputs: { baseColor: { node: outputPin, output: 0, mask: null }, roughness: null, metallic: null, emissive: null, opacity: null, opacityMask: null, normal: null, materialAttributes: null },
    nodes,
  });
  const sourceDir = join(dir, `${name}-source`);
  await mkdir(join(sourceDir, "Content", "Pack"), { recursive: true });
  await writeFile(join(sourceDir, "Content", "Pack", "MI_View.uasset"), Buffer.alloc(16));
  const baker = createGraphBaker({ sourceDir, maxTextureSize: 16, dumpGraphs: async () => new Map([["M_View", graph]]) })!;
  const outcome = await baker({
    materialName: "MI_View",
    lookupName: "MI_View",
    assets: { png: new Map() },
    readProps: (material) => (material === "MI_View" ? "Parent = Material3'Content/Pack/M_View.M_View'\n" : undefined),
  });
  if (outcome.status !== "baked") throw new Error(`${name} bake failed: ${JSON.stringify(outcome)}`);
  return Buffer.from(outcome.png);
}

/** KUBIKOS Cube World's clouds: Lerp(blue, white, Fresnel(exponent 1.2, base reflect 0)). The bake is the blue paled by the rim average. */
const skyFresnelBake = (dir: string): Promise<Buffer> =>
  viewNodeBake(
    dir,
    "sky-fresnel-cloud",
    [
      { id: "mix", class: "LinearInterpolate", inputs: { A: { node: "face", output: 0, mask: null }, B: { node: "rim", output: 0, mask: null }, Alpha: { node: "fresnel", output: 0, mask: null } }, constants: {} },
      { id: "face", class: "Constant3Vector", inputs: {}, constants: { Constant: [0.23, 0.27, 0.71, 1] } },
      { id: "rim", class: "Constant3Vector", inputs: {}, constants: { Constant: [1, 1, 1, 1] } },
      { id: "fresnel", class: "Fresnel", inputs: {}, constants: { Exponent: 1.2, BaseReflectFraction: 0 } },
    ],
    "mix",
  );

/** Kite Demo's leaves: Lerp(brown bottom colour, green top colour, Clamp(TwoSidedSign)). The front face shows the green top. */
const twoSidedLeafBake = (dir: string): Promise<Buffer> =>
  viewNodeBake(
    dir,
    "two-sided-leaf",
    [
      { id: "mix", class: "LinearInterpolate", inputs: { A: { node: "bottom", output: 0, mask: null }, B: { node: "top", output: 0, mask: null }, Alpha: { node: "clamp", output: 0, mask: null } }, constants: {} },
      { id: "bottom", class: "Constant3Vector", inputs: {}, constants: { Constant: [0.4, 0.25, 0.1, 1] } },
      { id: "top", class: "Constant3Vector", inputs: {}, constants: { Constant: [0.1, 0.5, 0.08, 1] } },
      { id: "clamp", class: "Clamp", inputs: { Input: { node: "sign", output: 0, mask: null } }, constants: {} },
      { id: "sign", class: "TwoSidedSign", inputs: {}, constants: {} },
    ],
    "mix",
  );

/** Mean RGB of the object pixels left and right of the object's horizontal centre. */
function halfMeans(image: RgbaImage): { left: [number, number, number]; right: [number, number, number] } {
  const isObject = (o: number): boolean => !(Math.abs(image.data[o]! - 128) <= 6 && Math.abs(image.data[o + 1]! - 128) <= 6 && Math.abs(image.data[o + 2]! - 128) <= 6);
  let minX = image.width;
  let maxX = -1;
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) if (isObject((y * image.width + x) * 4)) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
  const middle = (minX + maxX) / 2;
  const sums = { left: [0, 0, 0, 0], right: [0, 0, 0, 0] };
  for (let y = 0; y < image.height; y++) {
    for (let x = minX; x <= maxX; x++) {
      const o = (y * image.width + x) * 4;
      if (!isObject(o)) continue;
      const half = x < middle ? sums.left : sums.right;
      half[0]! += image.data[o]!;
      half[1]! += image.data[o + 1]!;
      half[2]! += image.data[o + 2]!;
      half[3]! += 1;
    }
  }
  const mean = (half: number[]): [number, number, number] => [half[0]! / Math.max(1, half[3]!), half[1]! / Math.max(1, half[3]!), half[2]! / Math.max(1, half[3]!)];
  return { left: mean(sums.left), right: mean(sums.right) };
}

/**
 * Landscape Pro's pines and trees: the mesh's slots are [lod3 card, bark, leafs] and its SectionInfoMap sends section 0 (the
 * trunk) to bark and section 1 (the leaf cards) to leafs, but UE Viewer named the sections by raw index (lod3, bark). The
 * importer re-points them. Two side-by-side quads stand for trunk (left) and leaf cards (right), each painted with the texture
 * of the material its section ends up with: trunk brown, leaves green. Unmapped, the trunk gets the lod3 atlas and the
 * leaves get bark.
 */
async function trunkAndLeavesGlb(path: string): Promise<void> {
  const gltf = {
    materials: [{ name: "MI_Lod3" }, { name: "MI_Bark" }],
    meshes: [{ primitives: [{ material: 0 }, { material: 1 }] }],
  };
  remapGltfSectionMaterials(gltf, { slots: ["MI_Lod3", "MI_Bark", "MI_Leafs"], lod0: new Map([[0, 1], [1, 2]]) });
  const colour: Record<string, [number, number, number]> = { MI_Lod3: [190, 175, 150], MI_Bark: [110, 75, 45], MI_Leafs: [50, 150, 50] };
  const document = new Document();
  const buffer = document.createBuffer();
  const mesh = document.createMesh("Tree");
  for (const [section, primitive] of gltf.meshes[0]!.primitives.entries()) {
    const name = gltf.materials[primitive.material]!.name;
    const [r, g, b] = colour[name]!;
    const flat = await sharp(Buffer.from([r, g, b, 255]), { raw: { width: 1, height: 1, channels: 4 } }).png().toBuffer();
    const left = section === 0 ? -1.1 : 0.1;
    const accessor = (type: "VEC3" | "VEC2" | "SCALAR", values: number[], kind: "f" | "u" = "f") =>
      document.createAccessor().setType(type).setArray(kind === "f" ? new Float32Array(values) : new Uint16Array(values)).setBuffer(buffer);
    mesh.addPrimitive(
      document
        .createPrimitive()
        .setAttribute("POSITION", accessor("VEC3", [left, -1, 0, left + 1, -1, 0, left + 1, 1, 0, left, 1, 0]))
        .setAttribute("NORMAL", accessor("VEC3", [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]))
        .setAttribute("TEXCOORD_0", accessor("VEC2", [0, 1, 1, 1, 1, 0, 0, 0]))
        .setIndices(accessor("SCALAR", [0, 1, 2, 0, 2, 3], "u"))
        .setMaterial(
          document
            .createMaterial(name)
            .setBaseColorTexture(document.createTexture(name).setImage(new Uint8Array(flat)).setMimeType("image/png"))
            .setMetallicFactor(0)
            .setRoughnessFactor(1),
        ),
    );
  }
  document.createScene().addChild(document.createNode("Tree").setMesh(mesh));
  await new NodeIO().write(path, document);
}

interface Fixture {
  readonly name: string;
  readonly path: string;
}

/**
 * A character piece whose mesh carries black vertex colours its material never reads (a 5.8 pack's armour and
 * mannequins rendered black). Built as the importer leaves it: a black COLOR_0 on a brown box, passed through the real
 * `dropUnreadVertexColours` with a graph whose BaseColor does not read VertexColor.
 */
async function unreadVertexColourBox(dir: string, name: string): Promise<string> {
  const path = join(dir, `${name}.glb`);
  await writeGlb(path, { name, geometry: "cube", baseColorFactor: [0.55, 0.3, 0.12, 1] });
  const io = new NodeIO();
  const document = await io.read(path);
  const root = document.getRoot();
  const primitive = root.listMeshes()[0]!.listPrimitives()[0]!;
  const count = primitive.getAttribute("POSITION")!.getCount();
  primitive.setAttribute(
    "COLOR_0",
    document.createAccessor("COLOR_0").setType("VEC4").setArray(new Float32Array(count * 4).map((_, i) => (i % 4 === 3 ? 1 : 0))).setBuffer(root.listBuffers()[0]!),
  );
  await dropUnreadVertexColours(root, root.listMaterials()[0]!, async () => ({ status: "unavailable", reason: "probe", vertexColorOnBaseColor: false }), () => ({
    materialName: name,
    lookupName: name,
    assets: { png: new Map() },
    readProps: () => undefined,
    probe: true,
  }));
  await io.write(path, document);
  return path;
}

/** A grey box whose COLOR_0 is an RGB region mask (green top, cyan bottom), kept: what the judge must flag. */
async function regionMaskVertexColourBox(dir: string, name: string): Promise<string> {
  const path = join(dir, `${name}.glb`);
  await writeGlb(path, { name, geometry: "cube", baseColorFactor: [0.8, 0.8, 0.8, 1] });
  const io = new NodeIO();
  const document = await io.read(path);
  const root = document.getRoot();
  const primitive = root.listMeshes()[0]!.listPrimitives()[0]!;
  const positions = primitive.getAttribute("POSITION")!;
  const colours = new Float32Array(positions.getCount() * 4);
  for (let i = 0; i < positions.getCount(); i++) {
    const top = positions.getElement(i, [0, 0, 0])[1]! > 0;
    colours.set([0, 1, top ? 0 : 1, 1], i * 4);
  }
  primitive.setAttribute("COLOR_0", document.createAccessor("COLOR_0").setType("VEC4").setArray(colours).setBuffer(root.listBuffers()[0]!));
  await io.write(path, document);
  return path;
}

async function buildFixtures(dir: string): Promise<Fixture[]> {
  const wood = await woodTexture();
  const ragged = await raggedAlphaTexture();
  const graphLeaf = await graphBakedLeafTexture();
  const fixtures: Fixture[] = [];
  const trunkPath = join(dir, "trunk-and-leaves.glb");
  await trunkAndLeavesGlb(trunkPath);
  fixtures.push({ name: "trunk-and-leaves", path: trunkPath });
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
  fixtures.push({ name: "needle-card-mipped", path: await importedNeedleCard(dir, "needle-card-mipped", {}) });
  fixtures.push({ name: "needle-card-unmipped", path: await importedNeedleCard(dir, "needle-card-unmipped", { noMipmaps: true }) });
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
  await write("moss-by-normal", { geometry: "quad", baseColorFactor: [1, 1, 1, 1], texture: await worldAlignedMossBake(dir) });
  await write("sky-fresnel-cloud", { geometry: "quad", baseColorFactor: [1, 1, 1, 1], texture: await skyFresnelBake(dir) });
  await write("two-sided-leaf", { geometry: "quad", baseColorFactor: [1, 1, 1, 1], texture: await twoSidedLeafBake(dir) });
  await write("mossy-rock", { geometry: "cube", baseColorFactor: [1, 1, 1, 1], texture: await mossyRockBake(dir) });
  fixtures.push({ name: "vivid-atlas-card", path: await importedNeedleCard(dir, "vivid-atlas-card", { noMipmaps: true, vivid: true, solidMask: true }) });
  fixtures.push({ name: "matte-leaf-specular", path: await importedNeedleCard(dir, "matte-leaf-specular", { specular: 0.1, solidMask: true }) });
  fixtures.push({ name: "default-leaf-specular", path: await importedNeedleCard(dir, "default-leaf-specular", { solidMask: true }) });
  fixtures.push({ name: "unread-black-vertex-colours", path: await unreadVertexColourBox(dir, "unread-black-vertex-colours") });
  fixtures.push({ name: "region-mask-vertex-colours", path: await regionMaskVertexColourBox(dir, "region-mask-vertex-colours") });
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
  let paths = new Map<string, string>();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "tn-visual-regression-"));
    const fixtures = await buildFixtures(dir);
    names = fixtures.map((fixture) => fixture.name);
    paths = new Map(fixtures.map((fixture) => [fixture.name, fixture.path]));
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

  it("a needle card whose mask has no mip chain keeps its coverage; mipmapped it thins out", () => {
    const mipped = judgeRender(byName.get("needle-card-mipped")!);
    const unmipped = judgeRender(byName.get("needle-card-unmipped")!);
    expect(unmipped.stats.objectPixels).toBeGreaterThan(200);
    expect(unmipped.stats.objectPixels).toBeGreaterThan(mipped.stats.objectPixels * 2);
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

  it("a supersampled render keeps the cut-out's anti-aliased fringe: a hard 1x alpha test reads sparser than Unreal's AA'd thumbnail", async () => {
    const { tiles } = await renderTiles({ glbPaths: [paths.get("needle-card-unmipped")!], tile: TILE, supersample: 2 });
    const plain = judgeRender(byName.get("needle-card-unmipped")!);
    const smooth = judgeRender(tiles[0]!);
    // Same needles, same camera: only the edge treatment differs, and the fringe adds object pixels.
    expect(smooth.stats.objectPixels).toBeGreaterThan(plain.stats.objectPixels * 1.15);
    expect(smooth.stats.coverage).toBeLessThan(plain.stats.coverage * 3);
  });

  it("the unreal-like picture grounds the model and casts a shadow, while the default render stays the neutral golden", async () => {
    const path = paths.get("solid-box")!;
    const neutral = (await renderTiles({ glbPaths: [path], tile: TILE })).tiles[0]!;
    // The default is still the neutral render the committed goldens pin (a new option must not move it).
    const golden = await decodeRgba(await readFile(join(GOLDEN_DIR, "solid-box.png")));
    expect((await compareImages(neutral, golden)).ssim).toBeGreaterThanOrEqual(GOLDEN_SSIM_MIN);
    // Two unreal-like passes differ only in whether the key casts a shadow (same camera, fill and ground), so a
    // darkening outside the model's neutral silhouette is the cast shadow, not the darker floor.
    const shadowed = (await renderTiles({ glbPaths: [path], tile: TILE, lighting: "unreal-like" })).tiles[0]!;
    const flat = (await renderTiles({ glbPaths: [path], tile: TILE, lighting: "unreal-like", shadows: false })).tiles[0]!;
    let darkened = 0;
    for (let i = 0; i < neutral.data.length; i += 4) {
      const background =
        Math.abs(neutral.data[i]! - 128) <= 3 && Math.abs(neutral.data[i + 1]! - 128) <= 3 && Math.abs(neutral.data[i + 2]! - 128) <= 3;
      if (!background) continue;
      const on = 0.2126 * shadowed.data[i]! + 0.7152 * shadowed.data[i + 1]! + 0.0722 * shadowed.data[i + 2]!;
      const off = 0.2126 * flat.data[i]! + 0.7152 * flat.data[i + 1]! + 0.0722 * flat.data[i + 2]!;
      if (off - on >= 20) darkened++;
    }
    expect(darkened).toBeGreaterThan(20);
  });

  it("fails explicitly when the lit picture pass drops a tile the neutral pass rendered", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tn-lit-failure-"));
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    const box = join(dir, "SM_Box.glb");
    await writeGlb(box, { name: "SM_Box", geometry: "cube", baseColorFactor: [0.8, 0.2, 0.2, 1] });
    // A deterministic seam makes the lit pass drop tile 0, which the neutral pass renders; it must name the tile.
    await expect(
      renderContactSheet({
        glbPaths: [box],
        outPath: join(dir, "sheet.jpg"),
        title: "Lit failure",
        tile: TILE,
        pictureLighting: "unreal-like",
        litFailureProbe: [0],
      }),
    ).rejects.toThrow(/tile 0 "SM_Box"/);
  });

  it("a vivid leaf atlas cut out by a packed opacity map keeps its colour instead of the neutral grey fallback (Fern Collection)", () => {
    const vivid = judgeRender(byName.get("vivid-atlas-card")!);
    expect(vivid.stats.objectPixels).toBeGreaterThan(200);
    expect(vivid.stats.meanSaturation).toBeGreaterThan(0.5);
    expect(vivid.stats.neutralFraction).toBeLessThan(0.2);
  });

  it("an authored Specular of 0.1 is greener than glTF's default F0 on the same leaf", () => {
    const matte = judgeRender(byName.get("matte-leaf-specular")!);
    const plain = judgeRender(byName.get("default-leaf-specular")!);
    expect(matte.stats.objectPixels).toBeGreaterThan(200);
    expect(matte.stats.meanSaturation).toBeGreaterThan(plain.stats.meanSaturation + 0.015);
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

  it("moss follows the surface normal: the up-facing half is green moss, the side-facing half is stone (Landscape Pro)", () => {
    const { left, right } = halfMeans(byName.get("moss-by-normal")!);
    expect(left[1]).toBeGreaterThan(left[0]);
    expect(right[0]).toBeGreaterThan(right[1]);
    expect(left[0]).toBeLessThan(right[0] * 0.6);
  });

  it("a Fresnel sky material keeps its blue hue (paler by its rim average), not the grey fallback (KUBIKOS clouds)", () => {
    const [r, g, b] = objectMeanRgb(byName.get("sky-fresnel-cloud")!);
    expect(b).toBeGreaterThan(r * 1.15);
    expect(b).toBeGreaterThan(g * 1.05);
  });

  it("a two-sided leaf card shows its green top colour on the front face, not the brown bottom (Kite Demo)", () => {
    const [r, g, b] = objectMeanRgb(byName.get("two-sided-leaf")!);
    expect(g).toBeGreaterThan(r * 1.5);
    expect(g).toBeGreaterThan(b * 2);
  });

  it("a tree's trunk is bark brown and its leaf cards are leaf green, not swapped (Landscape Pro SectionInfoMap)", () => {
    const { left, right } = halfMeans(byName.get("trunk-and-leaves")!);
    expect(left[0]).toBeGreaterThan(left[1]);
    expect(right[1]).toBeGreaterThan(right[0]);
    expect(right[1]).toBeGreaterThan(left[1] * 1.3);
  });

  it("a box with black vertex colours its material never reads renders its brown base colour, not black", () => {
    const [r, g, b] = objectMeanRgb(byName.get("unread-black-vertex-colours")!);
    expect(r).toBeGreaterThan(70);
    expect(r).toBeGreaterThan(g * 1.3);
    expect(g).toBeGreaterThan(b * 1.3);
  });

  it("the judge flags a render dominated by region-mask vertex colours, and passes the plain solid box", () => {
    const mask = judgeRender(byName.get("region-mask-vertex-colours")!, { expectColoured: true });
    expect(mask.verdict).toBe("suspect");
    expect(mask.reasons.join("\n")).toContain("pure hues");
    expect(judgeRender(byName.get("solid-box")!, { expectColoured: true }).verdict).toBe("ok");
    expect(judgeRender(byName.get("vivid-atlas-card")!).reasons.join("\n")).not.toContain("pure hues");
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
