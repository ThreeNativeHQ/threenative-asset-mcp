import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Document, NodeIO } from "@gltf-transform/core";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { renderTiles } from "../src/unreal/contact-sheet.js";
import { compareImages, decodeRgba, type RgbaImage } from "../src/unreal/image-diff.js";
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

interface Fixture {
  readonly name: string;
  readonly path: string;
}

async function buildFixtures(dir: string): Promise<Fixture[]> {
  const wood = await woodTexture();
  const ragged = await raggedAlphaTexture();
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
