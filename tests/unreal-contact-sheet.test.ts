import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Document, NodeIO } from "@gltf-transform/core";
import sharp from "sharp";
import { expect, it, onTestFinished } from "vitest";

import { colouredGlbKeys, renderContactSheet } from "../src/unreal/contact-sheet.js";
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
