import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Document, NodeIO } from "@gltf-transform/core";
import { KHRMaterialsUnlit } from "@gltf-transform/extensions";
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

/**
 * An axis-aligned box [-h, h]^3 scaled by `scale`, coloured `color`. `unlit` adds KHR_materials_unlit, so the picture reads the
 * colour through its tone curve alone, with no light on it.
 */
async function writeCube(
  path: string,
  color: [number, number, number],
  scale = 1,
  unlit = false,
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
  if (unlit) material.setExtension("KHR_materials_unlit", document.createExtension(KHRMaterialsUnlit).createUnlit());
  const primitive = document
    .createPrimitive()
    .setAttribute("POSITION", document.createAccessor().setType("VEC3").setArray(new Float32Array(positions)).setBuffer(buffer))
    .setAttribute("NORMAL", document.createAccessor().setType("VEC3").setArray(new Float32Array(normals)).setBuffer(buffer))
    .setIndices(document.createAccessor().setType("SCALAR").setArray(new Uint16Array(indices)).setBuffer(buffer))
    .setMaterial(material);
  const mesh = document.createMesh("cube").addPrimitive(primitive);
  document.createScene().addChild(document.createNode("cube").setMesh(mesh));
  await new NodeIO().registerExtensions([KHRMaterialsUnlit]).write(path, document);
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
 * The unit cube at the origin as the picture camera sees it, by its contract (vertical field 40 degrees, direction (1, 0.75, 1.2),
 * distance = radius / sin(field / 2) * 1.05): the eye and one ray per pixel of a `tile`-pixel render. An independent pinhole
 * model; no renderer code is used.
 */
function pinholeRays(tile: number): { eye: number[]; rays: number[][] } {
  const half = (40 * Math.PI) / 360;
  const toward = unitVector([1, 0.75, 1.2]);
  const distance = ((Math.sqrt(3) / 2) / Math.sin(half)) * 1.05;
  const eye = toward.map((c) => c * distance);
  const forward = toward.map((c) => -c);
  const right = unitVector(crossProduct(forward, [0, 1, 0]));
  const up = crossProduct(right, forward);
  const rays: number[][] = [];
  for (let row = 0; row < tile; row++) {
    for (let column = 0; column < tile; column++) {
      const sx = (2 * (column + 0.5)) / tile - 1;
      const sy = 1 - (2 * (row + 0.5)) / tile;
      rays.push(forward.map((c, i) => c + Math.tan(half) * (sx * right[i]! + sy * up[i]!)));
    }
  }
  return { eye, rays };
}

/** The floor point (x, z) each pixel of a `tile`-pixel render of the unit cube sees; null where the ray misses the floor (y = -0.5) or the cube hides it. */
function floorSeenBy(tile: number): ([number, number] | null)[] {
  const { eye, rays } = pinholeRays(tile);
  return rays.map((ray) => {
    if (ray[1]! >= 0) return null;
    const s = (-0.5 - eye[1]!) / ray[1]!;
    const point = eye.map((c, i) => c + s * ray[i]!);
    return segmentHitsCube(eye, point) ? null : [point[0]!, point[2]!];
  });
}

/** The cube face each pixel of the same render enters, named by its outward normal (`+x`); null where the ray misses the cube. */
function faceSeenBy(tile: number): (string | null)[] {
  const { eye, rays } = pinholeRays(tile);
  return rays.map((ray) => {
    let enter = -Infinity;
    let exit = Infinity;
    let axis = -1;
    for (let k = 0; k < 3; k++) {
      const a = (-0.5 - eye[k]!) / ray[k]!;
      const b = (0.5 - eye[k]!) / ray[k]!;
      if (Math.min(a, b) > enter) {
        enter = Math.min(a, b);
        axis = k;
      }
      exit = Math.min(exit, Math.max(a, b));
    }
    if (enter > exit || exit <= 0) return null;
    // A ray moving along +axis enters through the face whose outward normal points along -axis.
    return `${ray[axis]! > 0 ? "-" : "+"}${"xyz"[axis]}`;
  });
}

/**
 * Mean luma of the floor pixels grouped by the Grid phase their floor point sits in: an axis is bright in [0, 1.28) of its
 * 2.56 m period and dark in [1.28, 2.56); 0.2 m margins at each seam are left out.
 */
type Cell = "bothBright" | "xDark" | "zDark" | "bothDark";

/** The Grid cell a floor point sits in, or null inside a 0.2 m seam. `bothBright` is texel TL (x and z low), `xDark` TR, `zDark` BL. */
function phaseCell(point: readonly [number, number]): Cell | null {
  const phase = (v: number) => ((v % 2.56) + 2.56) % 2.56;
  const axis = (v: number): boolean | undefined => {
    const p = phase(v);
    if (p >= 0.2 && p <= 1.08) return true;
    if (p >= 1.48 && p <= 2.36) return false;
    return undefined;
  };
  const bx = axis(point[0]);
  const bz = axis(point[1]);
  if (bx === undefined || bz === undefined) return null;
  return bx ? (bz ? "bothBright" : "zDark") : bz ? "xDark" : "bothDark";
}

function phaseMeans(
  tile: { readonly data: Uint8Array },
  seen: readonly ([number, number] | null)[],
): Record<"bothBright" | "xDark" | "zDark" | "bothDark", { mean: number; count: number }> {
  const groups: Record<Cell, number[]> = { bothBright: [], xDark: [], zDark: [], bothDark: [] };
  seen.forEach((point, index) => {
    const cell = point === null ? null : phaseCell(point);
    if (cell !== null) groups[cell].push(pixelLuma(tile, index));
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
  // three 0.185.1 rewrites PCFSoftShadowMap to PCFShadowMap when it renders shadows (WebGLShadowMap.render), so this pins the configured label, not the kernel.
  it("pins the lit picture to ACES filmic at exposure 1 and the configured PCFSoftShadowMap label with a literal gate, not a copy of the page's code", () => {
    expect(PICTURE_RENDERER).toEqual({ toneMapping: "ACESFilmicToneMapping", toneMappingExposure: 1, shadowMapType: "PCFSoftShadowMap" });
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

/** A world-space rectangle on the floor, in metres. */
type FloorRect = { readonly x0: number; readonly x1: number; readonly z0: number; readonly z1: number };

function inRect(point: [number, number], rect: FloorRect): boolean {
  return point[0] >= rect.x0 && point[0] <= rect.x1 && point[1] >= rect.z0 && point[1] <= rect.z1;
}

/** Mean luma and pixel count of the floor points inside a rectangle; the points come from floorSeenBy, not from the renderer. */
function cellLuma(tile: { readonly data: Uint8Array }, seen: readonly ([number, number] | null)[], rect: FloorRect): { mean: number; count: number } {
  const values: number[] = [];
  seen.forEach((point, index) => {
    if (point !== null && inRect(point, rect)) values.push(pixelLuma(tile, index));
  });
  return { mean: values.reduce((sum, v) => sum + v, 0) / Math.max(1, values.length), count: values.length };
}

/**
 * The 25.6 cm fine phase of a floor coordinate: the fine term samples the Grid at ten times the coarse UV (thumbnail-floor.ts), so its
 * bright texels cover [0, 0.128) of each 0.256 m. Linear filtering blends between texel centres, so only [0.016, 0.112] (bright) and
 * [0.144, 0.240] (dark) are pure; `undefined` elsewhere.
 */
function finePhase(v: number): boolean | undefined {
  const p = ((v % 0.256) + 0.256) % 0.256;
  if (p >= 0.016 && p <= 0.112) return true;
  if (p >= 0.144 && p <= 0.24) return false;
  return undefined;
}

/** Floor points inside a rectangle, split by fine phase: `bright` where both axes are fine-bright, `rest` where either is fine-dark. */
function fineSplit(
  tile: { readonly data: Uint8Array },
  seen: readonly ([number, number] | null)[],
  rect: FloorRect,
): Record<"bright" | "rest", { mean: number; count: number }> {
  const bright: number[] = [];
  const rest: number[] = [];
  seen.forEach((point, index) => {
    if (point === null || !inRect(point, rect)) return;
    const bx = finePhase(point[0]);
    const bz = finePhase(point[1]);
    if (bx === undefined || bz === undefined) return;
    (bx && bz ? bright : rest).push(pixelLuma(tile, index));
  });
  const summarise = (values: number[]) => ({ mean: values.reduce((sum, v) => sum + v, 0) / Math.max(1, values.length), count: values.length });
  return { bright: summarise(bright), rest: summarise(rest) };
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

  it("lights the +X+Z phase of each Grid period brighter than the other three phases at the fixed camera", () => {
    const groups = phaseMeans(lit.tiles[0]!, floorSeenBy(TILE));
    // A phase check, not an orientation proof: swapping X and Z leaves this cell bright too. The orientation tests below pin the axes.
    // The Grid's own contrast is about 9% here and reverses under the procedural checker, so the margin sits well inside it.
    const dark = [groups.xDark, groups.zDark, groups.bothDark];
    const darkMean = dark.reduce((sum, g) => sum + g.mean * g.count, 0) / dark.reduce((sum, g) => sum + g.count, 0);
    expect(groups.bothBright.count).toBeGreaterThan(500);
    expect(groups.bothBright.mean).toBeGreaterThan(groups.xDark.mean * 1.05);
    expect(groups.bothBright.mean).toBeGreaterThan(groups.zDark.mean * 1.05);
    expect(groups.bothBright.mean).toBeGreaterThan(darkMean * 1.05);
  });

  it("repeats the Grid every 2.56 m: a 1.28 m step flips the bright phase, and the 25.6 cm fine term repeats in dark cells", () => {
    const seen = floorSeenBy(TILE);
    const tile = lit.tiles[0]!;
    // Coarse: the bright cell against the cell 1.28 m away in X. A 256 cm period darkens that one; a 128 cm period would light it.
    const bright = cellLuma(tile, seen, { x0: 0.2, x1: 0.6, z0: 0.6, z1: 1.0 });
    const dark = { x0: -1.08, x1: -0.68, z0: 0.2, z1: 0.6 };
    const darkMean = cellLuma(tile, seen, dark);
    expect(bright.count).toBeGreaterThan(200);
    expect(darkMean.count).toBeGreaterThan(200);
    expect(bright.mean).toBeGreaterThan(darkMean.mean * 1.05);
    // Fine: inside each dark cell, floor that is fine-bright on both axes outshines the rest. Measured: about 4 luma at 256 cm; under 0.6 at 512 or 128 cm.
    for (const cell of [dark, { x0: -1.08, x1: -0.2, z0: 0.2, z1: 1.08 }]) {
      const split = fineSplit(tile, seen, cell);
      expect(split.bright.count).toBeGreaterThan(50);
      expect(split.bright.mean - split.rest.mean).toBeGreaterThan(2);
    }
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

/** sRGB transfer (IEC 61966-2-1) on unit values: the decode a sampled sRGB texel takes, and the encode a picture pixel takes. */
function srgbEotf(encoded: number): number {
  return encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
}

function srgbOetf(linear: number): number {
  const clamped = Math.min(1, Math.max(0, linear));
  return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
}

/** Three's `ACESFilmicToneMapping` matrices, as the installed tonemapping chunk writes them (GLSL mat3 columns). */
const ACES_INPUT_COLUMNS = [
  [0.59719, 0.076, 0.0284],
  [0.35458, 0.90834, 0.13383],
  [0.04823, 0.01566, 0.83777],
];
const ACES_OUTPUT_COLUMNS = [
  [1.60475, -0.10208, -0.00327],
  [-0.53108, 1.10813, -0.07276],
  [-0.07367, -0.00605, 1.07602],
];

/** The unit sRGB value a neutral linear swatch reads as under the lit picture's tone curve (exposure 1). */
function acesFilmicSrgb(linear: number): number {
  // Component r of M * v is the sum over columns j of column_j[r] * v[j].
  const times = (columns: number[][], v: number[]) =>
    [0, 1, 2].map((r) => columns[0]![r]! * v[0]! + columns[1]![r]! * v[1]! + columns[2]![r]! * v[2]!);
  const fit = (v: number) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
  // `color *= toneMappingExposure / 0.6`, then the input matrix, the fit per channel, the output matrix, and a clamp.
  const scaled = [linear / 0.6, linear / 0.6, linear / 0.6];
  return srgbOetf(times(ACES_OUTPUT_COLUMNS, times(ACES_INPUT_COLUMNS, scaled).map(fit))[0]!);
}

/** Synthetic 8x8 RGBA8 Grid, row 0 first: flat bytes in its TL, TR, BL and BR quadrants (the 2.56 m period's four cells). Never a real Grid. */
function quadrants(tl: number, tr: number, bl: number, br: number): ThumbnailSourceGrid {
  const rgba = new Uint8Array(GRID_SIZE * GRID_SIZE * 4);
  for (let row = 0; row < GRID_SIZE; row++) {
    for (let column = 0; column < GRID_SIZE; column++) {
      const value = row < 4 ? (column < 4 ? tl : tr) : column < 4 ? bl : br;
      rgba.set([value, value, value, 255], (row * GRID_SIZE + column) * 4);
    }
  }
  return { width: GRID_SIZE, height: GRID_SIZE, rgba, source: GRID_SOURCE };
}

/** Mean luma change `tile` minus `base` over each Grid cell's floor points: the same pixels in both renders, so the view cancels. */
function cellChange(
  tile: { readonly data: Uint8Array },
  base: { readonly data: Uint8Array },
  seen: readonly ([number, number] | null)[],
): Record<Cell, number> {
  const sum: Record<Cell, number> = { bothBright: 0, xDark: 0, zDark: 0, bothDark: 0 };
  const count: Record<Cell, number> = { bothBright: 0, xDark: 0, zDark: 0, bothDark: 0 };
  seen.forEach((point, index) => {
    const cell = point === null ? null : phaseCell(point);
    if (cell === null) return;
    sum[cell] += pixelLuma(tile, index) - pixelLuma(base, index);
    count[cell]++;
  });
  return {
    bothBright: sum.bothBright / count.bothBright,
    xDark: sum.xDark / count.xDark,
    zDark: sum.zDark / count.zDark,
    bothDark: sum.bothDark / count.bothDark,
  };
}

/**
 * Brightening of the top-left cell from byte 128 to 255, over its darkening from 0 to 128, with the other three texels moved and the
 * top-left held at 128. Only the fine term moves (roughness reads the top-left texel alone), and that term is linear in the decoded
 * bytes, so the ratio is a pure function of the decode: sRGB (correct), no decode at all (loss), or a second decode (double). The
 * picture's luma is read after ACES and the sRGB encode, so the test below checks a band around the sRGB ratio, not exact linearity.
 */
function fineRatio(decode: (byte: number) => number): number {
  return (decode(255) - decode(128)) / (decode(128) - decode(0));
}
const RATIO_SRGB = fineRatio((byte) => srgbEotf(byte / 255));
const RATIO_NO_DECODE = fineRatio((byte) => byte / 255);
const RATIO_DOUBLE_DECODE = fineRatio((byte) => srgbEotf(srgbEotf(byte / 255)));
/** A measured ratio passes only between the geometric midpoints: nearer the sRGB prediction than to either wrong decode. */
const DECODE_BAND: [number, number] = [Math.sqrt(RATIO_SRGB * RATIO_NO_DECODE), Math.sqrt(RATIO_SRGB * RATIO_DOUBLE_DECODE)];

/**
 * Longlat radiance with two HDR lobes on the equator (rows 14-17): red (12) on columns 44-51, centred on u = 0.75, and blue (12) on
 * columns 12-19, centred on u = 0.25, over the uniform sky. Under the source rotation +pi/2, u = 0.75 is world +X and u = 0.25 is -X:
 * the mapping u = 0.5 + atan2(d.x, -d.z) / 2pi that thumbnail-lighting.test.ts checks against the inverse environment rotation.
 */
function lobeSky(): Float32Array {
  const rgb = new Float32Array(RADIANCE.width * RADIANCE.height * 3);
  for (let row = 0; row < RADIANCE.height; row++) {
    for (let column = 0; column < RADIANCE.width; column++) {
      const equator = row >= 14 && row < 18;
      const red = equator && column >= 44 && column < 52;
      const blue = equator && column >= 12 && column < 20;
      rgb.set(red ? [12, 1, 1] : blue ? [1, 1, 12] : [0.4, 0.5, 0.7], (row * RADIANCE.width + column) * 3);
    }
  }
  return rgb;
}

describeWithTools(["chromium"], "unreal picture tone curve", () => {
  const SWATCHES = [0.18, 1];
  let dir = "";
  let lit: RenderedTiles;
  let neutral: RenderedTiles;

  // Unlit swatches have no light on them, so each pixel is the swatch's own value through the picture's tone curve alone.
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "tn-contact-sheet-tone-"));
    const paths: string[] = [];
    for (const [index, value] of SWATCHES.entries()) {
      const path = join(dir, `SM_Swatch${index}.glb`);
      await writeCube(path, [value, value, value], 1, true);
      paths.push(path);
    }
    lit = await renderTiles({ glbPaths: paths, tile: 128, lighting: "unreal-like" });
    neutral = await renderTiles({ glbPaths: paths, tile: 128 });
  }, 120_000);
  afterAll(() => rm(dir, { recursive: true, force: true }));

  /** Mean red of the central 20x20 pixels of one tile: the swatch is a single flat colour. */
  const swatchValue = (rendered: RenderedTiles, index: number): number => {
    const tile = rendered.tiles[index]!;
    let sum = 0;
    for (let y = 54; y < 74; y++) for (let x = 54; x < 74; x++) sum += tile.data[(y * tile.width + x) * 4]!;
    return sum / 400;
  };

  it("reads an unlit swatch through ACES filmic at exposure 1, within one 8-bit level of the curve", () => {
    SWATCHES.forEach((value, index) => {
      expect(Math.abs(swatchValue(lit, index) - 255 * acesFilmicSrgb(value))).toBeLessThanOrEqual(1);
    });
  });

  it("keeps the neutral metric picture on no tone curve: the same swatch reads its linear value through the sRGB encode only", () => {
    SWATCHES.forEach((value, index) => {
      expect(Math.abs(swatchValue(neutral, index) - 255 * srgbOetf(value))).toBeLessThanOrEqual(1);
    });
  });
});

describeWithTools(["chromium"], "unreal source Grid orientation and decode", () => {
  const TILE = 256;
  const PICTURE = {
    tile: TILE,
    lighting: "unreal-like" as const,
    shadows: false,
    sourceEnvironment: { ...RADIANCE, rgb: syntheticSky(0, 0), source: SOURCE },
  };
  let dir = "";
  let seen: ([number, number] | null)[] = [];
  let base: RenderedTiles;
  let topRight: RenderedTiles;
  let bottomLeft: RenderedTiles;
  let fineDark: RenderedTiles;
  let fineBright: RenderedTiles;

  // One cube; a uniform midtone Grid, then one quadrant changed at a time. Each comparison is between the same floor pixels.
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "tn-contact-sheet-orientation-"));
    const cube = join(dir, "SM_Cube.glb");
    await writeCube(cube, [0.8, 0.8, 0.8]);
    seen = floorSeenBy(TILE);
    const render = (sourceGrid: ThumbnailSourceGrid) => renderTiles({ ...PICTURE, glbPaths: [cube], sourceGrid });
    base = await render(quadrants(128, 128, 128, 128));
    topRight = await render(quadrants(128, 255, 128, 128));
    bottomLeft = await render(quadrants(128, 128, 255, 128));
    fineDark = await render(quadrants(128, 0, 0, 0));
    fineBright = await render(quadrants(128, 255, 255, 255));
  }, 240_000);
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("lights the x-high, z-low cell from the top-right texel and no other cell: x and z are not swapped, and Y is not flipped", () => {
    const delta = cellChange(topRight.tiles[0]!, base.tiles[0]!, seen);
    expect(delta.xDark).toBeGreaterThan(0);
    expect(delta.xDark).toBeGreaterThanOrEqual(4 * Math.max(delta.bothBright, delta.zDark, delta.bothDark));
  });

  it("lights the x-low, z-high cell from the bottom-left texel and no other cell", () => {
    const delta = cellChange(bottomLeft.tiles[0]!, base.tiles[0]!, seen);
    expect(delta.zDark).toBeGreaterThan(0);
    expect(delta.zDark).toBeGreaterThanOrEqual(4 * Math.max(delta.bothBright, delta.xDark, delta.bothDark));
  });

  it("decodes the Grid's sRGB bytes before the floor math: the top-left cell's fine-only ratio falls in the sRGB band", () => {
    // The wrong decodes must sit outside the band, or the band would not separate them.
    expect(RATIO_NO_DECODE).toBeLessThan(DECODE_BAND[0]);
    expect(RATIO_DOUBLE_DECODE).toBeGreaterThan(DECODE_BAND[1]);
    const top = (rendered: RenderedTiles) => phaseMeans(rendered.tiles[0]!, seen).bothBright.mean;
    const ratio = (top(fineBright) - top(base)) / (top(base) - top(fineDark));
    expect(ratio).toBeGreaterThan(DECODE_BAND[0]);
    expect(ratio).toBeLessThan(DECODE_BAND[1]);
  });
});

describeWithTools(["chromium"], "unreal source environment rotation", () => {
  const TILE = 256;
  const PICTURE = { tile: TILE, lighting: "unreal-like" as const, shadows: false };
  const faces = faceSeenBy(TILE);
  let dir = "";
  let plain: RenderedTiles;
  let lobes: RenderedTiles;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "tn-contact-sheet-rotation-"));
    const cube = join(dir, "SM_Cube.glb");
    await writeCube(cube, [0.8, 0.8, 0.8]);
    plain = await renderTiles({ ...PICTURE, glbPaths: [cube], sourceEnvironment: { ...RADIANCE, rgb: syntheticSky(0, 0), source: SOURCE } });
    lobes = await renderTiles({ ...PICTURE, glbPaths: [cube], sourceEnvironment: { ...RADIANCE, rgb: lobeSky(), source: SOURCE } });
  }, 240_000);
  afterAll(() => rm(dir, { recursive: true, force: true }));

  /** Mean RGB of one visible cube face in a render. */
  const faceMean = (rendered: RenderedTiles, face: string): number[] => {
    const tile = rendered.tiles[0]!;
    const sum = [0, 0, 0];
    let count = 0;
    faces.forEach((label, index) => {
      if (label !== face) return;
      for (let c = 0; c < 3; c++) sum[c]! += tile.data[index * 4 + c]!;
      count++;
    });
    return sum.map((v) => v / count);
  };
  /** Per-channel change a face takes from the lobes: the lobed render minus the same sky without lobes. */
  const lobeEffect = (face: string): number[] => faceMean(lobes, face).map((v, c) => v - faceMean(plain, face)[c]!);

  it("lights the +X face red from the lobe on u = 0.75, at least twice as much as the +Z face, and not blue from the lobe on u = 0.25", () => {
    const posX = lobeEffect("+x");
    const posZ = lobeEffect("+z");
    expect(posX[0]!).toBeGreaterThan(2);
    expect(posX[0]!).toBeGreaterThanOrEqual(2 * posZ[0]!);
    expect(posX[2]!).toBeLessThan(1);
  });
});

describeWithTools(["chromium"], "unreal floor camera height fade", () => {
  const TILE = 256;
  /** Camera heights in metres: two in the full-fade band, one mid-ramp, one past the ramp. */
  const HEIGHTS = [2, 3, 7.68, 12];
  /** The fine term's fade at camera height y (m): full below 512 cm, none from 1024 cm, linear between (thumbnail-floor.ts). */
  const fade = (y: number) => 1 - Math.min(1, Math.max(0, (y * 100 - 512) / 512));
  let dir = "";
  let seen: ([number, number] | null)[] = [];
  let rendered: RenderedTiles;

  // Uniform white Grid, so the fine term is the same everywhere on the floor and only the camera's height changes it. Each cube's
  // side sets its camera's height: the eye sits at the cube's centre plus `eye[1]` per unit side.
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "tn-contact-sheet-fade-"));
    const { eye } = pinholeRays(TILE);
    const paths: string[] = [];
    for (const [index, height] of HEIGHTS.entries()) {
      const path = join(dir, `SM_Cube${index}.glb`);
      await writeCube(path, [0.8, 0.8, 0.8], height / eye[1]!);
      paths.push(path);
    }
    seen = floorSeenBy(TILE);
    rendered = await renderTiles({
      glbPaths: paths,
      tile: TILE,
      lighting: "unreal-like",
      shadows: false,
      sourceEnvironment: { ...RADIANCE, rgb: syntheticSky(0, 0), source: SOURCE },
      sourceGrid: quadrants(255, 255, 255, 255),
    });
  }, 240_000);
  afterAll(() => rm(dir, { recursive: true, force: true }));

  /** Mean luma of the floor points the picture shows in one tile. */
  const floorMean = (index: number): number => {
    const tile = rendered.tiles[index]!;
    let sum = 0;
    let count = 0;
    seen.forEach((point, pixel) => {
      if (point === null) return;
      sum += pixelLuma(tile, pixel);
      count++;
    });
    return sum / count;
  };

  it("keeps a floor unchanged at the same camera height: two cubes in the full-fade band light it identically", () => {
    expect(Math.abs(floorMean(0) - floorMean(1))).toBeLessThanOrEqual(0.05);
  });

  it("ramps the fine term from 512 to 1024 cm: the mid-ramp floor's share of the full change lands near the fade's, in post-ACES luma", () => {
    const expectedShare = (fade(HEIGHTS[0]!) - fade(HEIGHTS[2]!)) / (fade(HEIGHTS[0]!) - fade(HEIGHTS[3]!));
    const share = (floorMean(0) - floorMean(2)) / (floorMean(0) - floorMean(3));
    expect(expectedShare).toBeCloseTo(0.5, 12);
    expect(Math.abs(share - expectedShare)).toBeLessThanOrEqual(0.05);
  });

  it("darkens the floor past 1024 cm by the whole fine term, far beyond the scale control", () => {
    expect(floorMean(0) - floorMean(3)).toBeGreaterThanOrEqual(1);
  });
});
