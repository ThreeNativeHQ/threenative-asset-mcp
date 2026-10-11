import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Document, NodeIO } from "@gltf-transform/core";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";

import { colouredGlbKeys, PICTURE_RENDERER, renderContactSheet, renderTiles, type RenderedTiles } from "../src/unreal/contact-sheet.js";
import type { ThumbnailSourceGrid } from "../src/unreal/thumbnail-floor.js";
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

const GRID_SIZE = 8;
const GRID_SOURCE = { reference: "synthetic/quadrant-grid", engine: "synthetic", bytesSha256: "d".repeat(64) };

/** Synthetic RGBA8 Grid, never a real asset: red 255 in the top-left 4x4 texels, the +X+Z quadrant of each 2.56 m period. */
function quadrantGrid(): Uint8Array {
  const rgba = new Uint8Array(GRID_SIZE * GRID_SIZE * 4);
  for (let row = 0; row < GRID_SIZE; row++) {
    for (let column = 0; column < GRID_SIZE; column++) {
      const value = row < 4 && column < 4 ? 255 : 0;
      rgba.set([value, value, value, 255], (row * GRID_SIZE + column) * 4);
    }
  }
  return rgba;
}

function gridDigest(rgba: Uint8Array): string {
  return createHash("sha256").update(rgba).digest("hex");
}

function pixelLuma(tile: { readonly data: Uint8Array }, index: number): number {
  return 0.2126 * tile.data[index * 4]! + 0.7152 * tile.data[index * 4 + 1]! + 0.0722 * tile.data[index * 4 + 2]!;
}

function unitVector(v: readonly number[]): number[] {
  const length = Math.hypot(...v);
  return v.map((c) => c / length);
}

function crossProduct(a: readonly number[], b: readonly number[]): number[] {
  return [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
}

/** Whether the segment from `from` to `to` enters the unit cube [-0.5, 0.5]^3 before it reaches `to` (slab test). */
function segmentHitsCube(from: readonly number[], to: readonly number[]): boolean {
  let enter = 0;
  let exit = 1;
  for (let axis = 0; axis < 3; axis++) {
    const d = to[axis]! - from[axis]!;
    if (Math.abs(d) < 1e-12) {
      if (from[axis]! < -0.5 || from[axis]! > 0.5) return false;
      continue;
    }
    const a = (-0.5 - from[axis]!) / d;
    const b = (0.5 - from[axis]!) / d;
    enter = Math.max(enter, Math.min(a, b));
    exit = Math.min(exit, Math.max(a, b));
    if (enter > exit) return false;
  }
  return enter <= exit && enter < 1 && exit > 0;
}

/**
 * The floor point (x, z) each pixel of a `tile`-pixel render of the unit cube at the origin sees; null where the ray misses the
 * floor (y = -0.5) or the cube hides it. An independent pinhole model of the picture camera as its contract states it (vertical
 * field 40 degrees, direction (1, 0.75, 1.2), distance = radius / sin(field / 2) * 1.05). No renderer code is used.
 */
function floorSeenBy(tile: number): ([number, number] | null)[] {
  const half = (40 * Math.PI) / 360;
  const toward = unitVector([1, 0.75, 1.2]);
  const distance = ((Math.sqrt(3) / 2) / Math.sin(half)) * 1.05;
  const eye = toward.map((c) => c * distance);
  const forward = toward.map((c) => -c);
  const right = unitVector(crossProduct(forward, [0, 1, 0]));
  const up = crossProduct(right, forward);
  const seen: ([number, number] | null)[] = [];
  for (let row = 0; row < tile; row++) {
    for (let column = 0; column < tile; column++) {
      const sx = (2 * (column + 0.5)) / tile - 1;
      const sy = 1 - (2 * (row + 0.5)) / tile;
      const ray = forward.map((c, i) => c + Math.tan(half) * (sx * right[i]! + sy * up[i]!));
      if (ray[1]! >= 0) {
        seen.push(null);
        continue;
      }
      const s = (-0.5 - eye[1]!) / ray[1]!;
      const point = eye.map((c, i) => c + s * ray[i]!);
      seen.push(segmentHitsCube(eye, point) ? null : [point[0]!, point[2]!]);
    }
  }
  return seen;
}

/**
 * Mean luma of the floor pixels grouped by the Grid phase their floor point sits in: an axis is bright in [0, 1.28) of its
 * 2.56 m period and dark in [1.28, 2.56); 0.2 m margins at each seam are left out.
 */
function phaseMeans(
  tile: { readonly data: Uint8Array },
  seen: readonly ([number, number] | null)[],
): Record<"bothBright" | "xDark" | "zDark" | "bothDark", { mean: number; count: number }> {
  const phase = (v: number) => ((v % 2.56) + 2.56) % 2.56;
  const axis = (v: number): boolean | undefined => {
    const p = phase(v);
    if (p >= 0.2 && p <= 1.08) return true;
    if (p >= 1.48 && p <= 2.36) return false;
    return undefined;
  };
  const groups = { bothBright: [] as number[], xDark: [] as number[], zDark: [] as number[], bothDark: [] as number[] };
  seen.forEach((point, index) => {
    if (point === null) return;
    const bx = axis(point[0]);
    const bz = axis(point[1]);
    if (bx === undefined || bz === undefined) return;
    const key = bx ? (bz ? "bothBright" : "zDark") : bz ? "xDark" : "bothDark";
    groups[key].push(pixelLuma(tile, index));
  });
  const summarise = (values: number[]) => ({ mean: values.reduce((sum, v) => sum + v, 0) / Math.max(1, values.length), count: values.length });
  return {
    bothBright: summarise(groups.bothBright),
    xDark: summarise(groups.xDark),
    zDark: summarise(groups.zDark),
    bothDark: summarise(groups.bothDark),
  };
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

describe("unreal source Grid refusal", () => {
  const valid = (): ThumbnailSourceGrid => ({ width: GRID_SIZE, height: GRID_SIZE, rgba: quadrantGrid(), source: GRID_SOURCE });
  const refusals: [string, () => unknown, RegExp][] = [
    ["a plain array instead of a Uint8Array", () => ({ ...valid(), rgba: Array.from(quadrantGrid()) }), /must be a Uint8Array/],
    ["a Uint8ClampedArray with the same bytes", () => ({ ...valid(), rgba: new Uint8ClampedArray(quadrantGrid()) }), /must be a Uint8Array/],
    ["a Float32Array of the Grid's element count", () => ({ ...valid(), rgba: new Float32Array(GRID_SIZE * GRID_SIZE) }), /must be a Uint8Array/],
    ["one byte short of width*height*4", () => ({ ...valid(), rgba: quadrantGrid().subarray(1) }), /exactly width\*height\*4/],
    ["a zero width", () => ({ ...valid(), width: 0 }), /positive whole dimensions/],
    ["a fractional height", () => ({ ...valid(), height: 8.5 }), /positive whole dimensions/],
    ["a missing source", () => ({ ...valid(), source: undefined }), /provenance/],
    ["an empty reference", () => ({ ...valid(), source: { ...GRID_SOURCE, reference: "" } }), /provenance/],
    ["a reference that is an array", () => ({ ...valid(), source: { ...GRID_SOURCE, reference: [GRID_SOURCE.reference] } }), /provenance/],
    ["a malformed SHA-256", () => ({ ...valid(), source: { ...GRID_SOURCE, bytesSha256: "not-a-digest" } }), /provenance/],
    ["a SHA-256 array that stringifies to a digest", () => ({ ...valid(), source: { ...GRID_SOURCE, bytesSha256: [GRID_SOURCE.bytesSha256] } }), /provenance/],
  ];

  it.each(refusals)("refuses %s before any file is read, under either picture lighting, and writes no sheet", async (_label, make, message) => {
    const dir = await scratch();
    const out = join(dir, "sheet.jpg");
    const sourceGrid = make() as ThumbnailSourceGrid;
    await expect(renderTiles({ glbPaths: [], sourceGrid })).rejects.toThrow(message);
    await expect(renderTiles({ glbPaths: [], sourceGrid, lighting: "unreal-like" })).rejects.toThrow(message);
    await expect(renderContactSheet({ glbPaths: [], outPath: out, title: "Refused", sourceGrid })).rejects.toThrow(message);
    await expect(stat(out)).rejects.toThrow();
  });
});

describe("unreal picture renderer contract", () => {
  it("pins the lit picture to ACES filmic at exposure 1 with a literal gate, not a copy of the page's code", () => {
    expect(PICTURE_RENDERER).toEqual({ toneMapping: "ACESFilmicToneMapping", toneMappingExposure: 1 });
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
    // Both inputs at once: neutral lighting ignores them, but a malformed one would still be refused (see the refusal table).
    const sourceGrid: ThumbnailSourceGrid = { width: GRID_SIZE, height: GRID_SIZE, rgba: quadrantGrid(), source: GRID_SOURCE };
    const supplied = await renderTiles({ glbPaths: [red], tile: 128, sourceEnvironment, sourceGrid });
    expect(supplied.png.equals(plain.png)).toBe(true);
    expect(supplied.sourceEnvironment).toBeUndefined();
    expect(supplied.sourceGrid).toBeUndefined();

    const plainSheet = await renderContactSheet({ glbPaths: [red], outPath: join(dir, "plain.jpg"), title: "Neutral", tile: 128 });
    const suppliedSheet = await renderContactSheet({
      glbPaths: [red],
      outPath: join(dir, "supplied.jpg"),
      title: "Neutral",
      tile: 128,
      sourceEnvironment,
      sourceGrid,
    });
    expect(suppliedSheet.judge).toEqual(plainSheet.judge);
    expect(suppliedSheet.sourceEnvironment).toBeUndefined();
    expect(suppliedSheet.sourceGrid).toBeUndefined();
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
      sourceGrid: { width: GRID_SIZE, height: GRID_SIZE, rgba: quadrantGrid(), source: GRID_SOURCE },
    });
    expect(plain.sourceEnvironment).toBeUndefined();
    expect(plain.sourceGrid).toBeUndefined();
    expect(lit.sourceGrid).toMatchObject({ source: GRID_SOURCE, width: GRID_SIZE, height: GRID_SIZE });
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

/**
 * A tall thin box standing on the floor. The unit cube's cast shadow falls behind it from this camera (the light and the camera
 * are nearly aligned), so the PCF control needs a shadow that clears its own silhouette.
 */
async function writePillar(path: string, height: number): Promise<void> {
  const document = new Document();
  const buffer = document.createBuffer();
  const half = [0.15, height / 2, 0.15];
  const centre = [0, height / 2, 0];
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (let axis = 0; axis < 3; axis++) {
    for (const sign of [-1, 1]) {
      const n = [0, 0, 0];
      n[axis] = sign;
      const u = [0, 0, 0];
      u[(axis + 1) % 3] = 1;
      const v = [n[1]! * u[2]! - n[2]! * u[1]!, n[2]! * u[0]! - n[0]! * u[2]!, n[0]! * u[1]! - n[1]! * u[0]!];
      const base = positions.length / 3;
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        for (let k = 0; k < 3; k++) positions.push(centre[k]! + half[k]! * (n[k]! + a * u[k]! + b * v[k]!));
        normals.push(...n);
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const material = document.createMaterial("pillar").setBaseColorFactor([0.8, 0.8, 0.8, 1]).setMetallicFactor(0).setRoughnessFactor(1);
  const primitive = document
    .createPrimitive()
    .setAttribute("POSITION", document.createAccessor().setType("VEC3").setArray(new Float32Array(positions)).setBuffer(buffer))
    .setAttribute("NORMAL", document.createAccessor().setType("VEC3").setArray(new Float32Array(normals)).setBuffer(buffer))
    .setIndices(document.createAccessor().setType("SCALAR").setArray(new Uint16Array(indices)).setBuffer(buffer))
    .setMaterial(material);
  document.createScene().addChild(document.createNode("pillar").setMesh(document.createMesh("pillar").addPrimitive(primitive)));
  await new NodeIO().write(path, document);
}

describeWithTools(["chromium"], "unreal source Grid", () => {
  const TILE = 256;
  let dir = "";
  let cube = "";
  let pillar = "";
  let lit: RenderedTiles;
  let procedural: RenderedTiles;
  let shadowOn: RenderedTiles;
  let shadowOff: RenderedTiles;
  const picture = () => ({
    glbPaths: [cube],
    tile: TILE,
    lighting: "unreal-like" as const,
    sourceEnvironment: { ...RADIANCE, rgb: syntheticSky(0, 4), source: SOURCE },
  });
  const grid = (): ThumbnailSourceGrid => ({ width: GRID_SIZE, height: GRID_SIZE, rgba: quadrantGrid(), source: GRID_SOURCE });

  // One browser per configuration, shared by the assertions below. The same HDR radiance lights all three.
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "tn-contact-sheet-grid-"));
    cube = join(dir, "SM_Cube.glb");
    await writeCube(cube, [0.8, 0.8, 0.8]);
    pillar = join(dir, "SM_Pillar.glb");
    await writePillar(pillar, 3);
    lit = await renderTiles({ ...picture(), sourceGrid: grid() });
    procedural = await renderTiles(picture());
    shadowOn = await renderTiles({ ...picture(), glbPaths: [pillar], sourceGrid: grid() });
    shadowOff = await renderTiles({ ...picture(), glbPaths: [pillar], sourceGrid: grid(), shadows: false });
  }, 240_000);
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("maps the Grid by world X and Z at the fixed camera: only the +X+Z phase of each period is bright", () => {
    const groups = phaseMeans(lit.tiles[0]!, floorSeenBy(TILE));
    // The Grid's own contrast is about 9% here and reverses under the procedural checker, so the margin sits well inside it.
    const dark = [groups.xDark, groups.zDark, groups.bothDark];
    const darkMean = dark.reduce((sum, g) => sum + g.mean * g.count, 0) / dark.reduce((sum, g) => sum + g.count, 0);
    expect(groups.bothBright.count).toBeGreaterThan(500);
    expect(groups.bothBright.mean).toBeGreaterThan(groups.xDark.mean * 1.05);
    expect(groups.bothBright.mean).toBeGreaterThan(groups.zDark.mean * 1.05);
    expect(groups.bothBright.mean).toBeGreaterThan(darkMean * 1.05);
  });

  it("repeats the Grid every 2.56 m: the bright phase beyond the first period matches the whole bright phase", () => {
    const seen = floorSeenBy(TILE);
    const beyond = phaseMeans(lit.tiles[0]!, seen.map((p) => (p !== null && p[0] <= -1.28 ? p : null)));
    const all = phaseMeans(lit.tiles[0]!, seen);
    expect(beyond.bothBright.count).toBeGreaterThan(200);
    expect(Math.abs(beyond.bothBright.mean - all.bothBright.mean)).toBeLessThan(0.05 * all.bothBright.mean);
  });

  it("applies the Grid to the floor and reports it with its digest and approximations, and reports nothing without one", () => {
    expect(meanAbsDiff(lit.tiles[0]!, procedural.tiles[0]!)).toBeGreaterThan(2);
    expect(lit.sourceGrid).toEqual({
      source: GRID_SOURCE,
      width: GRID_SIZE,
      height: GRID_SIZE,
      rgbaSha256: gridDigest(quadrantGrid()),
      limitations: expect.arrayContaining([expect.stringMatching(/BRDF/), expect.stringMatching(/filtering/), expect.stringMatching(/EditorPlane/)]),
    });
    expect(lit.sourceGrid!.limitations.join(" ")).not.toMatch(/procedural/);
    // HDR and Grid together: both reports describe the same picture.
    expect(lit.sourceEnvironment).toBeDefined();
    expect(procedural.sourceGrid).toBeUndefined();
  });

  it("keeps the PCF cast shadow control live under the Grid: shadows on darken part of the floor and never brighten it", () => {
    // Measured here: about 1,350 of 65,536 pixels darken by more than 8 luma with shadows on, and none brighten.
    let darkened = 0;
    let brightened = 0;
    for (let i = 0; i < TILE * TILE; i++) {
      const change = pixelLuma(shadowOn.tiles[0]!, i) - pixelLuma(shadowOff.tiles[0]!, i);
      if (change < -8) darkened++;
      if (change > 8) brightened++;
    }
    expect(darkened).toBeGreaterThan(500);
    expect(brightened).toBe(0);
  });

  it("reads the caller's Grid before the browser starts: editing its bytes or provenance afterwards changes neither picture nor report", async () => {
    const rgba = quadrantGrid();
    const source = { ...GRID_SOURCE, extraRgba: new Uint8Array(4) };
    const input = { width: GRID_SIZE, height: GRID_SIZE, rgba, source, radiance: new Float32Array(3) } as unknown as ThumbnailSourceGrid;
    const pending = renderTiles({ ...picture(), sourceGrid: input });
    rgba.fill(0);
    source.reference = "mutated/after-call";
    const after = await pending;
    expect(after.png.equals(lit.png)).toBe(true);
    expect(after.sourceGrid).toEqual(lit.sourceGrid);
    expect(JSON.stringify(after.sourceGrid)).not.toMatch(/extra|mutated/);
  }, 120_000);
});
