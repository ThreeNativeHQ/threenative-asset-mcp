import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Document, NodeIO } from "@gltf-transform/core";
import sharp from "sharp";
import { describe, expect, it, onTestFinished } from "vitest";

import { colouredGlbKeys, renderContactSheet, renderTiles } from "../src/unreal/contact-sheet.js";
import type { ThumbnailSourceRadiance } from "../src/unreal/thumbnail-lighting.js";
import { describeWithTools } from "./helpers/require-tool.js";

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tn-contact-sheet-test-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** An axis-aligned box [-h, h]^3 scaled by `scale`, coloured `color`. */
async function writeCube(
  path: string,
  color: [number, number, number],
  scale = 1,
): Promise<void> {
  const document = new Document();
  const buffer = document.createBuffer();
  const h = 0.5 * scale;
  const faces: [number[], number[]][] = [
    [[1, 0, 0], [0, 1, 0]],
    [[-1, 0, 0], [0, 0, 1]],
    [[0, 1, 0], [0, 0, 1]],
    [[0, -1, 0], [1, 0, 0]],
    [[0, 0, 1], [1, 0, 0]],
    [[0, 0, -1], [0, 1, 0]],
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (const [n, u] of faces) {
    const v = [n[1]! * u[2]! - n[2]! * u[1]!, n[2]! * u[0]! - n[0]! * u[2]!, n[0]! * u[1]! - n[1]! * u[0]!];
    const base = positions.length / 3;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      for (let axis = 0; axis < 3; axis++) positions.push((n[axis]! + a * u[axis]! + b * v[axis]!) * h);
      normals.push(...n);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const material = document
    .createMaterial("cube")
    .setBaseColorFactor([...color, 1])
    .setMetallicFactor(0)
    .setRoughnessFactor(1);
  const primitive = document
    .createPrimitive()
    .setAttribute("POSITION", document.createAccessor().setType("VEC3").setArray(new Float32Array(positions)).setBuffer(buffer))
    .setAttribute("NORMAL", document.createAccessor().setType("VEC3").setArray(new Float32Array(normals)).setBuffer(buffer))
    .setIndices(document.createAccessor().setType("SCALAR").setArray(new Uint16Array(indices)).setBuffer(buffer))
    .setMaterial(material);
  const mesh = document.createMesh("cube").addPrimitive(primitive);
  document.createScene().addChild(document.createNode("cube").setMesh(mesh));
  await new NodeIO().write(path, document);
}

async function writeTexturedQuad(path: string): Promise<void> {
  const document = new Document();
  const buffer = document.createBuffer();
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 0, g: 0, b: 255 } } })
    .png()
    .toBuffer();
  const texture = document.createTexture("blue").setImage(new Uint8Array(png)).setMimeType("image/png");
  const material = document.createMaterial("quad").setBaseColorTexture(texture).setMetallicFactor(0).setRoughnessFactor(1);
  const primitive = document
    .createPrimitive()
    .setAttribute(
      "POSITION",
      document.createAccessor().setType("VEC3").setBuffer(buffer).setArray(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0])),
    )
    .setAttribute(
      "NORMAL",
      document.createAccessor().setType("VEC3").setBuffer(buffer).setArray(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1])),
    )
    .setAttribute(
      "TEXCOORD_0",
      document.createAccessor().setType("VEC2").setBuffer(buffer).setArray(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1])),
    )
    .setIndices(document.createAccessor().setType("SCALAR").setBuffer(buffer).setArray(new Uint16Array([0, 1, 2, 0, 2, 3])))
    .setMaterial(material);
  const mesh = document.createMesh("quad").addPrimitive(primitive);
  document.createScene().addChild(document.createNode("quad").setMesh(mesh));
  await new NodeIO().write(path, document);
}

async function galleryPng(): Promise<Buffer> {
  return sharp({ create: { width: 640, height: 349, channels: 3, background: { r: 200, g: 40, b: 200 } } })
    .png()
    .toBuffer();
}

/** Mean RGB over a pixel rectangle of a decoded JPEG. */
async function meanColor(
  jpeg: string,
  region: { left: number; top: number; width: number; height: number },
): Promise<[number, number, number]> {
  const { data, info } = await sharp(jpeg).extract(region).raw().toBuffer({ resolveWithObject: true });
  const sum = [0, 0, 0];
  for (let i = 0; i < data.length; i += info.channels) {
    for (let c = 0; c < 3; c++) sum[c]! += data[i + c]!;
  }
  const n = data.length / info.channels;
  return [sum[0]! / n, sum[1]! / n, sum[2]! / n];
}

const SOURCE = {
  reference: "synthetic/hdr-band",
  engine: "synthetic",
  bytesSha256: "c".repeat(64),
  layout: "ue-source-longlat-rgb-f32" as const,
  radianceDecode: "ue5.8-rgbe" as const,
};
const RADIANCE = { width: 64, height: 32 };

/** Synthetic longlat radiance, never a real asset: a dim sky with a full-width HDR band over rows [from, to). */
function syntheticSky(from: number, to: number, value = 12): Float32Array {
  const rgb = new Float32Array(RADIANCE.width * RADIANCE.height * 3);
  for (let row = 0; row < RADIANCE.height; row++) {
    const band = row >= from && row < to ? [value, value * 0.8, value * 0.6] : [0.4, 0.5, 0.7];
    for (let column = 0; column < RADIANCE.width; column++) rgb.set(band, (row * RADIANCE.width + column) * 3);
  }
  return rgb;
}

function radianceDigest(rgb: Float32Array): string {
  return createHash("sha256").update(Buffer.from(rgb.buffer, rgb.byteOffset, rgb.byteLength)).digest("hex");
}

/** Mean Rec.709 luma of a decoded RGBA tile, 0..255. */
function meanLuma(tile: { readonly data: Uint8Array }): number {
  let sum = 0;
  for (let i = 0; i < tile.data.length; i += 4) sum += 0.2126 * tile.data[i]! + 0.7152 * tile.data[i + 1]! + 0.0722 * tile.data[i + 2]!;
  return sum / (tile.data.length / 4);
}

/** Mean absolute RGB difference of two decoded RGBA tiles, 0..255. */
function meanAbsDiff(a: { readonly data: Uint8Array }, b: { readonly data: Uint8Array }): number {
  let sum = 0;
  for (let i = 0; i < a.data.length; i += 4) for (let c = 0; c < 3; c++) sum += Math.abs(a.data[i + c]! - b.data[i + c]!);
  return sum / ((a.data.length / 4) * 3);
}

describe("unreal source environment refusal", () => {
  const valid = () => ({ width: RADIANCE.width, height: RADIANCE.height, rgb: syntheticSky(0, 4), source: SOURCE });
  const refusals: [string, () => unknown, RegExp][] = [
    ["a float short of width*height*3", () => ({ ...valid(), rgb: valid().rgb.subarray(1) }), /exactly width\*height\*3/],
    ["a zero width", () => ({ ...valid(), width: 0 }), /positive whole dimensions/],
    ["a fractional height", () => ({ ...valid(), height: 16.5 }), /positive whole dimensions/],
    ["a plain array instead of a Float32Array", () => ({ ...valid(), rgb: Array.from(valid().rgb) }), /must be a Float32Array/],
    ["a NaN", () => { const input = valid(); input.rgb[7] = Number.NaN; return input; }, /radiance must be finite/],
    ["an infinite value", () => { const input = valid(); input.rgb[7] = Number.POSITIVE_INFINITY; return input; }, /radiance must be finite/],
    ["a negative value", () => { const input = valid(); input.rgb[7] = -0.5; return input; }, /radiance must be finite and nonnegative/],
    ["an unknown layout", () => ({ ...valid(), source: { ...SOURCE, layout: "equirect-png" } }), /explicit UE source longlat layout/],
    ["an unknown radiance decode", () => ({ ...valid(), source: { ...SOURCE, radianceDecode: "srgb" } }), /explicit UE source longlat layout/],
    ["a malformed SHA-256", () => ({ ...valid(), source: { ...SOURCE, bytesSha256: "not-a-digest" } }), /SHA-256 provenance/],
    ["a Float64Array with the byte count of width*height*3 float32 values", () => ({ ...valid(), width: 2, height: 1, rgb: new Float64Array([2, 3, 4]) }), /must be a Float32Array/],
    ["a Uint8Array with the byte count of width*height*3 float32 values", () => ({ ...valid(), width: 2, height: 1, rgb: new Uint8Array(24) }), /must be a Float32Array/],
    ["a non-string reference", () => ({ ...valid(), source: { ...SOURCE, reference: ["/Engine/Test"] } }), /explicit UE source longlat layout/],
  ];

  it.each(refusals)("refuses %s with the validation error and writes no sheet", async (_label, make, message) => {
    const dir = await scratch();
    const out = join(dir, "sheet.jpg");
    const sourceEnvironment = make() as ThumbnailSourceRadiance;
    await expect(renderTiles({ glbPaths: [], sourceEnvironment })).rejects.toThrow(message);
    await expect(renderContactSheet({ glbPaths: [], outPath: out, title: "Refused", sourceEnvironment })).rejects.toThrow(message);
    await expect(stat(out)).rejects.toThrow();
  });
});

describeWithTools(["chromium"], "unreal contact sheet", () => {
  it("renders a gallery panel and a grid of tiles, with a red cube predominantly red", async () => {
    const dir = await scratch();
    const red = join(dir, "SM_Red.glb");
    await writeCube(red, [1, 0, 0]);
    const quad = join(dir, "SM_Quad.glb");
    await writeTexturedQuad(quad);
    const out = join(dir, "sheet.jpg");

    const result = await renderContactSheet({
      glbPaths: [red, quad],
      outPath: out,
      title: "Synthetic Pack",
      subtitle: "artifact A | route test | 2/2 meshes",
      galleryImage: await galleryPng(),
      tile: 200,
    });

    expect(result).toMatchObject({ outPath: out, meshesRendered: 2, meshesTotal: 2, meshesFailed: 0, galleryIncluded: true });
    expect((await stat(out)).size).toBe(result.bytes);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width!).toBeLessThanOrEqual(1800);
    const panel = Math.round(meta.width! - 2 * 200);
    expect(panel).toBeGreaterThan(100);

    // Gallery on the left is the magenta image.
    const [gr, gg, gb] = await meanColor(out, { left: 20, top: 60, width: 40, height: 40 });
    expect(gr).toBeGreaterThan(150);
    expect(gg).toBeLessThan(90);
    expect(gb).toBeGreaterThan(150);

    // Largest-first: the cube (volume 1) is tile 0, the flat quad tile 1. Sample the tile centres.
    const top = 30;
    const [cr, cg, cb] = await meanColor(out, { left: panel + 80, top: top + 70, width: 40, height: 40 });
    expect(cr).toBeGreaterThan(cg * 2);
    expect(cr).toBeGreaterThan(cb * 2);
    expect(cr).toBeGreaterThan(80);

    // The textured quad renders blue in the centre of its tile, which differs from the grey background.
    const [qr, , qb] = await meanColor(out, { left: panel + 200 + 85, top: top + 85, width: 30, height: 30 });
    expect(qb).toBeGreaterThan(qr * 2);
    const [br, bg, bb] = await meanColor(out, { left: panel + 5, top: top + 5, width: 10, height: 10 });
    expect(Math.abs(br - 128)).toBeLessThan(12);
    expect(Math.abs(bg - 128)).toBeLessThan(12);
    expect(Math.abs(bb - 128)).toBeLessThan(12);
  });

  it("shows 'load failed' for a corrupt GLB, counts it, and still renders the rest", async () => {
    const dir = await scratch();
    const good = join(dir, "good.glb");
    await writeCube(good, [0, 1, 0]);
    const corrupt = join(dir, "broken.glb");
    await writeFile(corrupt, "this is not a glb");
    const out = join(dir, "sheet.jpg");

    const result = await renderContactSheet({ glbPaths: [good, corrupt], outPath: out, title: "Mixed", tile: 160 });

    expect(result).toMatchObject({ meshesRendered: 1, meshesTotal: 2, meshesFailed: 1, galleryIncluded: false });
    expect((await stat(out)).size).toBeGreaterThan(1000);
  });

  it("writes a sheet with a note when there are no meshes, without launching a browser", async () => {
    const dir = await scratch();
    const out = join(dir, "sheet.jpg");

    const result = await renderContactSheet({ glbPaths: [], outPath: out, title: "Empty", galleryImage: await galleryPng(), tile: 160 });

    expect(result).toMatchObject({ meshesRendered: 0, meshesTotal: 0, meshesFailed: 0, galleryIncluded: true });
    expect((await sharp(out).metadata()).height).toBeGreaterThan(160);
  });

  it("limits tiles to maxMeshes and picks the largest by bounding-box volume", async () => {
    const dir = await scratch();
    const paths: string[] = [];
    for (const [index, scale] of [0.1, 3, 1, 2].entries()) {
      const path = join(dir, `cube${index}.glb`);
      await writeCube(path, [0, 0, 1], scale);
      paths.push(path);
    }
    const out = join(dir, "sheet.jpg");

    const result = await renderContactSheet({ glbPaths: paths, outPath: out, title: "Cap", maxMeshes: 2, tile: 120 });
    expect(result).toMatchObject({ meshesRendered: 2, meshesTotal: 4 });

    const spread = await renderContactSheet({ glbPaths: paths, outPath: out, title: "Cap", maxMeshes: 3, tile: 120, selection: "spread" });
    expect(spread).toMatchObject({ meshesRendered: 3, meshesTotal: 4 });
  });

  it("uses a placeholder when the gallery image cannot be decoded", async () => {
    const dir = await scratch();
    const out = join(dir, "sheet.jpg");
    const result = await renderContactSheet({ glbPaths: [], outPath: out, title: "Bad", galleryImage: Buffer.from("nope"), tile: 160 });
    expect(result.galleryIncluded).toBe(false);
  });

  it("judges every tile, with a verdict and statistics, and counts them", async () => {
    const dir = await scratch();
    const red = join(dir, "SM_Red.glb");
    await writeCube(red, [1, 0, 0]);
    const white = join(dir, "SM_White.glb");
    await writeCube(white, [1, 1, 1], 0.5);
    const out = join(dir, "sheet.jpg");

    const result = await renderContactSheet({
      glbPaths: [red, white],
      outPath: out,
      title: "Judged",
      tile: 160,
      expectColoured: new Set(["SM_White.glb"]),
    });

    expect(result.judge).toHaveLength(2);
    const byName = Object.fromEntries(result.judge.map((j) => [j.name, j]));
    expect(byName.SM_Red).toMatchObject({ verdict: "ok", reasons: [] });
    expect(byName.SM_White!.verdict).toBe("fail");
    expect(byName.SM_White!.reasons.join(" ")).toContain("report claims coloured sections");
    expect(result.judgeSummary).toEqual({ ok: 1, suspect: 0, fail: 1 });
    expect(result.thumbnailsShown).toBe(0);
  });

  it("shows the Unreal thumbnail beside each render, only for pieces that have one, with colour similarity", async () => {
    const dir = await scratch();
    const red = join(dir, "Meshes", "SM_Red.glb");
    const blue = join(dir, "Meshes", "SM_Blue.glb");
    const nothumb = join(dir, "Meshes", "SM_NoThumb.glb");
    await mkdir(join(dir, "Meshes"), { recursive: true });
    await writeCube(red, [1, 0, 0]);
    await writeCube(blue, [0, 0, 1], 0.9);
    await writeCube(nothumb, [0, 1, 0], 0.8);
    // A thumbnail looks like the editor's: a checkered floor with the object in the middle.
    const thumbnail = async (r: number, g: number, b: number): Promise<Buffer> => {
      const floor = Buffer.alloc(64 * 64 * 3);
      for (let y = 0; y < 64; y++) {
        for (let x = 0; x < 64; x++) {
          const v = ((x >> 3) + (y >> 3)) % 2 === 0 ? 150 : 100;
          floor.set([v, v - 10, v - 30], (y * 64 + x) * 3);
        }
      }
      const base = sharp(floor, { raw: { width: 64, height: 64, channels: 3 } }).resize(256, 256, { kernel: "nearest" });
      const square = await sharp({ create: { width: 110, height: 110, channels: 3, background: { r, g, b } } }).png().toBuffer();
      return base.composite([{ input: square, left: 73, top: 73 }]).png().toBuffer();
    };
    const out = join(dir, "sheet.jpg");

    const result = await renderContactSheet({
      glbPaths: [red, blue, nothumb],
      outPath: out,
      title: "Pairs",
      galleryImage: await galleryPng(),
      tile: 200,
      // Red cube gets a red thumbnail, the blue cube a red one too (a deliberate colour mismatch).
      thumbnails: new Map([
        ["Meshes/SM_Red.glb", await thumbnail(220, 20, 20)],
        ["Meshes/SM_Blue.glb", await thumbnail(220, 20, 20)],
      ]),
    });

    expect(result).toMatchObject({ meshesRendered: 2, thumbnailsShown: 2, galleryIncluded: true });
    expect(result.judge.map((j) => j.name).sort()).toEqual(["SM_Blue", "SM_Red"]);
    const byName = Object.fromEntries(result.judge.map((j) => [j.name, j]));
    expect(byName.SM_Red!.similarity).toBeGreaterThan(0.6);
    expect(byName.SM_Red!.verdict).toBe("ok");
    expect(byName.SM_Blue!.similarity).toBeLessThan(0.35);
    // A blue cube against a red thumbnail: the colour-similarity rule and the lighting-robust hue axis both flag it.
    expect(byName.SM_Blue!.verdict).toBe("fail");
    expect(byName.SM_Blue!.reasons.join(" | ")).toContain("colour similarity");
    expect(byName.SM_Blue!.reasons.join(" | ")).toMatch(/fidelity \d+\/100: hue off by/);

    // Tile 0 (the larger blue cube is volume 0.73, red is 1: red first). Thumbnail left, render right.
    const top = 132;
    const [tr, tg, tb] = await meanColor(out, { left: 80, top: top + 80, width: 40, height: 40 });
    expect(tr).toBeGreaterThan(tg * 3);
    expect(tr).toBeGreaterThan(tb * 3);
    const [rr, rg, rb] = await meanColor(out, { left: 200 + 80, top: top + 80, width: 40, height: 40 });
    expect(rr).toBeGreaterThan(rg * 2);
    expect(rr).toBeGreaterThan(rb * 2);
    // Second pair: render is blue.
    const [br, , bb] = await meanColor(out, { left: 400 + 200 + 80, top: top + 80, width: 40, height: 40 });
    expect(bb).toBeGreaterThan(br * 2);
  });

  it("derives expected-coloured GLBs from a report's textured sections", () => {
    const keys = colouredGlbKeys({
      models: [
        { glb: "a.glb", materials: [{ textured: true }] },
        { glb: "b.glb", materials: [{ textured: false }] },
      ],
    });
    expect([...keys]).toEqual(["a.glb"]);
  });
});

describeWithTools(["chromium"], "contact sheet reference shadow", () => {
  it("does not let the thumbnail's cast shadow lower a correct render's colour similarity", async () => {
    const dir = await scratch();
    const green = join(dir, "Meshes", "SM_Green.glb");
    await mkdir(join(dir, "Meshes"), { recursive: true });
    await writeCube(green, [0.1, 0.8, 0.15]);
    // An editor-like thumbnail: blue-grey checkered floor, a green piece, and a larger dark blue cast shadow beside it.
    const floor = Buffer.alloc(64 * 64 * 3);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) floor.set(((x >> 3) + (y >> 3)) % 2 === 0 ? [125, 132, 137] : [112, 120, 126], (y * 64 + x) * 3);
    const base = sharp(floor, { raw: { width: 64, height: 64, channels: 3 } }).resize(256, 256, { kernel: "nearest" });
    const piece = await sharp({ create: { width: 70, height: 70, channels: 3, background: { r: 38, g: 200, b: 40 } } }).png().toBuffer();
    const shadow = await sharp({ create: { width: 190, height: 70, channels: 3, background: { r: 48, g: 66, b: 78 } } }).png().toBuffer();
    const thumbnail = await base.composite([{ input: shadow, left: 20, top: 150 }, { input: piece, left: 90, top: 70 }]).png().toBuffer();
    const result = await renderContactSheet({
      glbPaths: [green],
      outPath: join(dir, "sheet.jpg"),
      title: "Shadow",
      tile: 200,
      thumbnails: new Map([["Meshes/SM_Green.glb", thumbnail]]),
    });
    const tile = result.judge[0]!;
    expect(tile.similarity).toBeGreaterThan(0.5);
    expect(tile.reasons.join(" ")).not.toContain("colour similarity");
  });
});

describeWithTools(["chromium"], "unreal source environment", () => {
  it("lights the unreal-like picture from supplied HDR radiance, oriented with its first row as zenith and unclamped", async () => {
    const dir = await scratch();
    const cube = join(dir, "SM_Cube.glb");
    await writeCube(cube, [0.8, 0.8, 0.8]);
    const zenith = syntheticSky(0, 4);
    const render = (rgb: Float32Array) =>
      renderTiles({ glbPaths: [cube], tile: 128, lighting: "unreal-like", sourceEnvironment: { ...RADIANCE, rgb, source: SOURCE } });

    const hemisphere = await renderTiles({ glbPaths: [cube], tile: 128, lighting: "unreal-like" });
    const up = await render(zenith);
    const down = await render(syntheticSky(RADIANCE.height - 4, RADIANCE.height));
    const clamped = await render(Float32Array.from(zenith, (value) => Math.min(value, 1)));

    // Absent option: the hemisphere picture carries no source report.
    expect(Object.keys(hemisphere).sort()).toEqual(["png", "rendered", "tiles"]);
    expect(up.sourceEnvironment).toEqual({
      source: SOURCE,
      width: RADIANCE.width,
      height: RADIANCE.height,
      radianceSha256: radianceDigest(zenith),
      rotationY: Math.PI / 2,
      intensity: 1.69,
      limitations: expect.arrayContaining([expect.stringMatching(/PMREM/)]),
    });
    // Orientation: a zenith band lights the visible top faces; the same band at the nadir does not.
    expect(meanLuma(up.tiles[0]!)).toBeGreaterThan(meanLuma(down.tiles[0]!) + 2);
    // HDR: the 12.0 band must out-shine the same band clamped to 1.0.
    expect(meanLuma(up.tiles[0]!)).toBeGreaterThan(meanLuma(clamped.tiles[0]!) + 2);
    // The supplied environment is what changes the picture relative to the hemisphere fill.
    expect(meanAbsDiff(up.tiles[0]!, hemisphere.tiles[0]!)).toBeGreaterThan(2);
  });

  it("leaves the neutral picture and its judge byte-identical whether or not an environment is supplied", async () => {
    const dir = await scratch();
    const red = join(dir, "SM_Red.glb");
    await writeCube(red, [1, 0, 0]);
    const sourceEnvironment = { ...RADIANCE, rgb: syntheticSky(0, 4), source: SOURCE };

    const plain = await renderTiles({ glbPaths: [red], tile: 128 });
    const supplied = await renderTiles({ glbPaths: [red], tile: 128, sourceEnvironment });
    expect(supplied.png.equals(plain.png)).toBe(true);
    expect(supplied.sourceEnvironment).toBeUndefined();

    const plainSheet = await renderContactSheet({ glbPaths: [red], outPath: join(dir, "plain.jpg"), title: "Neutral", tile: 128 });
    const suppliedSheet = await renderContactSheet({
      glbPaths: [red],
      outPath: join(dir, "supplied.jpg"),
      title: "Neutral",
      tile: 128,
      sourceEnvironment,
    });
    expect(suppliedSheet.judge).toEqual(plainSheet.judge);
    expect(suppliedSheet.sourceEnvironment).toBeUndefined();
    expect((await readFile(join(dir, "supplied.jpg"))).equals(await readFile(join(dir, "plain.jpg")))).toBe(true);
  });

  it("keeps the lit sheet's judge on the neutral render and reports the environment only when it lit the picture", async () => {
    const dir = await scratch();
    const cube = join(dir, "SM_Cube.glb");
    await writeCube(cube, [0.8, 0.8, 0.8]);
    const sourceEnvironment = { ...RADIANCE, rgb: syntheticSky(0, 4), source: SOURCE };

    const plain = await renderContactSheet({
      glbPaths: [cube],
      outPath: join(dir, "plain.jpg"),
      title: "Lit",
      tile: 128,
      pictureLighting: "unreal-like",
    });
    const lit = await renderContactSheet({
      glbPaths: [cube],
      outPath: join(dir, "lit.jpg"),
      title: "Lit",
      tile: 128,
      pictureLighting: "unreal-like",
      sourceEnvironment,
    });
    expect(plain.sourceEnvironment).toBeUndefined();
    expect(lit.judge).toEqual(plain.judge);
    expect(lit.sourceEnvironment).toMatchObject({
      source: SOURCE,
      width: RADIANCE.width,
      height: RADIANCE.height,
      radianceSha256: radianceDigest(sourceEnvironment.rgb),
      rotationY: Math.PI / 2,
      intensity: 1.69,
    });
    expect((await readFile(join(dir, "lit.jpg"))).equals(await readFile(join(dir, "plain.jpg")))).toBe(false);
  });

  it("snapshots the radiance before the browser starts, so editing the caller's array afterwards cannot change the render", async () => {
    const dir = await scratch();
    const cube = join(dir, "SM_Cube.glb");
    await writeCube(cube, [0.8, 0.8, 0.8]);
    const rgb = syntheticSky(0, 4);
    const digest = radianceDigest(rgb);

    const pending = renderTiles({
      glbPaths: [cube],
      tile: 128,
      lighting: "unreal-like",
      sourceEnvironment: { ...RADIANCE, rgb, source: SOURCE },
    });
    rgb.fill(0);
    expect((await pending).sourceEnvironment?.radianceSha256).toBe(digest);
  });

  it("reports only the declared source fields, so an extra key holding an array never reaches the public report", async () => {
    const dir = await scratch();
    const cube = join(dir, "SM_Cube.glb");
    await writeCube(cube, [0.8, 0.8, 0.8]);
    // An extra key carrying radiance by another name: the report must not copy it.
    const source = { ...SOURCE, extraRadiance: Float32Array.from([12, 13, 14]) };
    const sourceEnvironment = { ...RADIANCE, rgb: syntheticSky(0, 4), source };

    const tiles = await renderTiles({ glbPaths: [cube], tile: 128, lighting: "unreal-like", sourceEnvironment });
    expect(tiles.sourceEnvironment?.source).toEqual(SOURCE);

    const sheet = await renderContactSheet({
      glbPaths: [cube],
      outPath: join(dir, "lit.jpg"),
      title: "Declared",
      tile: 128,
      pictureLighting: "unreal-like",
      sourceEnvironment,
    });
    expect(sheet.sourceEnvironment?.source).toEqual(SOURCE);
  });
});
