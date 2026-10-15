import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { writePsd } from "ag-psd";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { readTextureSettings } from "../src/unity/settings.js";
import {
  type DecodedImage,
  UnityTextureError,
  decodeTexture,
  decodeTga,
  encodePng,
  limitTextureSize,
  heightToNormal,
  renderRecipe,
} from "../src/unity/textures.js";
import { scratchDirectory } from "./helpers/unity-fixtures.js";
import { DEFAULT_TEXTURE, textureImporter } from "./helpers/unity-models.js";

type Rgba = [number, number, number, number];
const RED: Rgba = [255, 0, 0, 255];
const GREEN: Rgba = [0, 255, 0, 255];
const BLUE: Rgba = [0, 0, 255, 255];
const WHITE: Rgba = [255, 255, 255, 255];

function pixelsOf(image: DecodedImage): Rgba[] {
  return Array.from({ length: image.width * image.height }, (_, at) => Array.from(image.data.subarray(at * 4, at * 4 + 4)) as Rgba);
}

/** A 2x2 TGA. `rows` are listed as they appear on screen, top row first. */
function tga(options: { type: number; depth: 8 | 24 | 32; rows: number[][][]; topDown?: boolean; rle?: boolean; palette?: number[][] }): Buffer {
  const { type, depth, rows, topDown = false, palette } = options;
  const header = Buffer.alloc(18);
  header[1] = palette ? 1 : 0;
  header[2] = type;
  if (palette) {
    header.writeUInt16LE(palette.length, 5);
    header[7] = 24;
  }
  header.writeUInt16LE(2, 12);
  header.writeUInt16LE(2, 14);
  header[16] = depth;
  header[17] = (topDown ? 0x20 : 0) | (depth === 32 ? 8 : 0);
  const stored = topDown ? rows : [...rows].reverse();
  const bytes = stored.flat().map((value) => Buffer.from(value));
  const body = options.rle
    ? Buffer.concat(bytes.map((pixel) => Buffer.concat([Buffer.from([0x80]), pixel]))) // each pixel as a run of one
    : Buffer.concat(bytes);
  const map = palette ? Buffer.concat(palette.map((entry) => Buffer.from(entry))) : Buffer.alloc(0);
  return Buffer.concat([header, map, body]);
}

const bgr = (rgba: Rgba): number[] => [rgba[2], rgba[1], rgba[0]];
const bgra = (rgba: Rgba): number[] => [rgba[2], rgba[1], rgba[0], rgba[3]];

describe("TGA decoding", () => {
  it("reads bottom-up 24-bit true colour and flips it to top-down", () => {
    const image = decodeTga(tga({ type: 2, depth: 24, rows: [[bgr(RED), bgr(GREEN)], [bgr(BLUE), bgr(WHITE)]] }));
    expect([image.width, image.height]).toEqual([2, 2]);
    expect(pixelsOf(image)).toEqual([RED, GREEN, BLUE, WHITE]);
  });

  it("reads top-down 32-bit colour with alpha", () => {
    const translucent: Rgba = [10, 20, 30, 64];
    const image = decodeTga(tga({ type: 2, depth: 32, topDown: true, rows: [[bgra(RED), bgra(translucent)], [bgra(BLUE), bgra(WHITE)]] }));
    expect(pixelsOf(image)).toEqual([RED, translucent, BLUE, WHITE]);
  });

  it("reads run-length encoded, grey and colour-mapped images", () => {
    const rle = decodeTga(tga({ type: 10, depth: 24, rle: true, rows: [[bgr(RED), bgr(GREEN)], [bgr(BLUE), bgr(WHITE)]] }));
    expect(pixelsOf(rle)).toEqual([RED, GREEN, BLUE, WHITE]);
    const grey = decodeTga(tga({ type: 3, depth: 8, rows: [[[0], [85]], [[170], [255]]] }));
    expect(pixelsOf(grey).map((pixel) => pixel[0])).toEqual([0, 85, 170, 255]);
    const mapped = decodeTga(tga({ type: 1, depth: 8, palette: [bgr(RED), bgr(BLUE)], rows: [[[0], [1]], [[1], [0]]] }));
    expect(pixelsOf(mapped)).toEqual([RED, BLUE, BLUE, RED]);
  });

  it("refuses a truncated file with a clear error", () => {
    const whole = tga({ type: 2, depth: 24, rows: [[bgr(RED), bgr(GREEN)], [bgr(BLUE), bgr(WHITE)]] });
    expect(() => decodeTga(whole.subarray(0, whole.length - 5))).toThrow(UnityTextureError);
  });
});

describe("texture file formats", () => {
  it("decodes TGA, PSD and TIF files by their Unity path", async () => {
    const directory = await scratchDirectory("unity-textures-");
    const tgaFile = join(directory, "a");
    await writeFile(tgaFile, tga({ type: 2, depth: 24, rows: [[bgr(RED), bgr(GREEN)], [bgr(BLUE), bgr(WHITE)]] }));
    expect(pixelsOf(await decodeTexture(tgaFile, "Assets/T/a.tga"))).toEqual([RED, GREEN, BLUE, WHITE]);

    const pixels = new Uint8ClampedArray([...RED, ...GREEN, ...BLUE, ...WHITE]);
    const psdFile = join(directory, "b");
    await writeFile(psdFile, Buffer.from(writePsd({ width: 2, height: 2, imageData: { width: 2, height: 2, data: pixels } } as never, { generateThumbnail: false })));
    expect(pixelsOf(await decodeTexture(psdFile, "Assets/T/b.psd"))).toEqual([RED, GREEN, BLUE, WHITE]);

    const tifFile = join(directory, "c");
    await writeFile(tifFile, await sharp(Buffer.from(pixels.buffer), { raw: { width: 2, height: 2, channels: 4 } }).tiff({ compression: "lzw" }).toBuffer());
    expect(pixelsOf(await decodeTexture(tifFile, "Assets/T/c.tif"))).toEqual([RED, GREEN, BLUE, WHITE]);
  });

  it("expands grey and grey-alpha PNGs to RGBA", async () => {
    const directory = await scratchDirectory("unity-textures-");
    const grey = join(directory, "g");
    await writeFile(grey, await sharp(Buffer.from([0, 128, 255, 64]), { raw: { width: 2, height: 2, channels: 1 } }).png().toBuffer());
    expect(pixelsOf(await decodeTexture(grey, "Assets/T/g.png")).map((pixel) => pixel.join(","))).toEqual(["0,0,0,255", "128,128,128,255", "255,255,255,255", "64,64,64,255"]);
  });

  it("names the format it cannot decode instead of failing silently", async () => {
    const directory = await scratchDirectory("unity-textures-");
    const dds = join(directory, "d");
    await writeFile(dds, Buffer.from("DDS |not a real dds"));
    await expect(decodeTexture(dds, "Assets/T/d.dds")).rejects.toThrow(/\.dds texture could not be decoded/);
    const psd = join(directory, "e");
    await writeFile(psd, Buffer.concat([Buffer.from("8BPS"), Buffer.from([0, 1, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 2, 0, 0, 0, 2, 0, 8, 0, 3])]));
    await expect(decodeTexture(psd, "Assets/T/e.psd")).rejects.toBeInstanceOf(UnityTextureError);
  });
});

describe("pixel budget", () => {
  it("refuses a TGA or PSD header that claims more pixels than the limit before it allocates", async () => {
    const directory = await scratchDirectory("unity-textures-");
    const header = Buffer.alloc(18);
    header[2] = 10;
    header[16] = 24;
    header.writeUInt16LE(30000, 12);
    header.writeUInt16LE(30000, 14);
    expect(() => decodeTga(header)).toThrow(/30000x30000 pixels, more than the 134217728 pixel limit/);
    const psd = Buffer.alloc(26);
    psd.write("8BPS", 0, "latin1");
    psd.writeUInt16BE(1, 4);
    psd.writeUInt32BE(30000, 14);
    psd.writeUInt32BE(30000, 18);
    const psdFile = join(directory, "big");
    await writeFile(psdFile, psd);
    await expect(decodeTexture(psdFile, "Assets/T/big.psd")).rejects.toThrow(/The PSD is 30000x30000 pixels/);
  });

  it("applies the limit to TGA, PSD and sharp-decoded files alike", async () => {
    const directory = await scratchDirectory("unity-textures-");
    const pixels = new Uint8ClampedArray(2 * 2 * 4).fill(200);
    const raw = { raw: { width: 2, height: 2, channels: 4 as const } };
    const files: [string, Buffer][] = [
      ["a.tga", tga({ type: 2, depth: 24, rows: [[bgr(RED), bgr(GREEN)], [bgr(BLUE), bgr(WHITE)]] })],
      ["b.psd", Buffer.from(writePsd({ width: 2, height: 2, imageData: { width: 2, height: 2, data: pixels } } as never, { generateThumbnail: false }))],
      ["c.png", await sharp(Buffer.from(pixels.buffer), raw).png().toBuffer()],
      ["d.tif", await sharp(Buffer.from(pixels.buffer), raw).tiff().toBuffer()],
      ["e.jpg", await sharp(Buffer.from(pixels.buffer), raw).jpeg().toBuffer()],
    ];
    for (const [name, bytes] of files) {
      const file = join(directory, name);
      await writeFile(file, bytes);
      expect((await decodeTexture(file, `Assets/T/${name}`, 4)).width, name).toBe(2);
      await expect(decodeTexture(file, `Assets/T/${name}`, 3), name).rejects.toBeInstanceOf(UnityTextureError);
    }
  });
});

describe("colour spaces and sizes", () => {
  const normal: DecodedImage = { width: 1, height: 1, data: Buffer.from([128, 127, 255, 255]) };
  const context = (image: DecodedImage, settings = DEFAULT_TEXTURE) => ({ load: async () => image, settings: () => settings });

  it("keeps a normal map linear: its bytes are untouched whatever the sRGB flag says", async () => {
    const out = await renderRecipe({ kind: "copy", texture: "n", role: "normal" }, context(normal, { ...DEFAULT_TEXTURE, srgb: true, normalMap: true }));
    expect(Array.from(out.data)).toEqual([128, 127, 255, 255]);
    const directory = await scratchDirectory("unity-textures-");
    const file = join(directory, "n");
    await writeFile(file, await encodePng(normal));
    expect(Array.from((await decodeTexture(file, "Assets/T/n.png")).data)).toEqual([128, 127, 255, 255]);
  });

  it("flips the green channel only when the importer says so", async () => {
    const out = await renderRecipe({ kind: "copy", texture: "n", role: "normal" }, context(normal, { ...DEFAULT_TEXTURE, flipGreenChannel: true }));
    expect(out.data[1]).toBe(128);
  });

  it("re-encodes a colour texture that Unity samples as linear (sRGBTexture 0), and no data texture", async () => {
    const mid: DecodedImage = { width: 1, height: 1, data: Buffer.from([128, 128, 128, 255]) };
    const colour = await renderRecipe({ kind: "copy", texture: "c", role: "color" }, context(mid, { ...DEFAULT_TEXTURE, srgb: false }));
    expect(colour.data[0]).toBe(188);
    const data = await renderRecipe({ kind: "copy", texture: "c", role: "data" }, context(mid, { ...DEFAULT_TEXTURE, srgb: false }));
    expect(data.data[0]).toBe(128);
  });

  it("reads the importer settings: normal map type, sRGB, convertToNormalMap and Unity's own size cap", () => {
    expect(readTextureSettings(`fileFormatVersion: 2\nguid: ${"a".repeat(32)}\n${textureImporter({ srgb: false, normalMap: true, convertToNormalMap: true })}\n`)).toEqual({
      srgb: false,
      normalMap: true,
      convertToNormalMap: true,
      heightScale: 0.25,
      normalMapFilter: 0,
      flipGreenChannel: false,
      unityMaxTextureSize: 2048,
    });
    expect(readTextureSettings(`fileFormatVersion: 2\nguid: ${"a".repeat(32)}\nTextureImporter:\n  serializedVersion: 4\n`)).toMatchObject({ srgb: true, normalMap: false });
  });

  it("convertToNormalMap: a flat height map gives the flat normal, and bumpiness 0 flattens any map (PRD-620 FR-T1)", () => {
    const flat = heightToNormal({ width: 4, height: 4, data: Buffer.alloc(64, 90) }, 0.25, false);
    expect([...flat.data.subarray(0, 4)]).toEqual([128, 128, 255, 255]);
    const ramp = Buffer.alloc(64, 255);
    for (let at = 0; at < 16; at += 1) ramp.fill((at % 4) * 80, at * 4, at * 4 + 3);
    expect([...heightToNormal({ width: 4, height: 4, data: ramp }, 0, true).data.subarray(20, 24)]).toEqual([128, 128, 255, 255]);
  });

  it("convertToNormalMap: a slope tilts the normal away from the rise, smooth and sharp agree on direction, and the grid wraps (PRD-620 FR-T1)", () => {
    const size = 8;
    const right = Buffer.alloc(size * size * 4, 255);
    const upward = Buffer.alloc(size * size * 4, 255);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        right.fill(x * 20, (y * size + x) * 4, (y * size + x) * 4 + 3);
        // Brighter toward the top row of the image, which is the +V direction in Unity.
        upward.fill((size - 1 - y) * 20, (y * size + x) * 4, (y * size + x) * 4 + 3);
      }
    }
    for (const sharp of [false, true]) {
      const east = heightToNormal({ width: size, height: size, data: right }, 0.25, sharp);
      const at = (3 * size + 3) * 4;
      expect(east.data[at]).toBeLessThan(128);
      expect(Math.abs(east.data[at + 1]! - 128)).toBeLessThanOrEqual(1);
      const north = heightToNormal({ width: size, height: size, data: upward }, 0.25, sharp);
      expect(Math.abs(north.data[at]! - 128)).toBeLessThanOrEqual(1);
      expect(north.data[at + 1]).toBeLessThan(128);
      // Wrap: the last column steps down to the first, so the seam tilts the other way.
      expect(east.data[(3 * size + size - 1) * 4]).toBeGreaterThan(128);
    }
    expect(heightToNormal({ width: size, height: size, data: right }, 3, false).data[(3 * size + 3) * 4 + 2]).toBeLessThan(255);
    // The slope grows with 10^bumpiness and with (width + height): a stronger scale tilts further.
    const weak = heightToNormal({ width: size, height: size, data: right }, 0.1, false).data[(3 * size + 3) * 4]!;
    const strong = heightToNormal({ width: size, height: size, data: right }, 0.5, false).data[(3 * size + 3) * 4]!;
    expect(strong).toBeLessThan(weak);
  });

  it("convertToNormalMap: the recipe converts a normal-role texture whose settings ask for it, then applies flipGreenChannel", async () => {
    const ramp: DecodedImage = { width: 4, height: 4, data: Buffer.alloc(64, 255) };
    for (let at = 0; at < 16; at += 1) ramp.data.fill((at % 4) * 60, at * 4, at * 4 + 3);
    const settings = { ...DEFAULT_TEXTURE, normalMap: true, convertToNormalMap: true };
    const plain = await renderRecipe({ kind: "copy", texture: "h", role: "normal" }, context(ramp, settings));
    expect(plain.data).toEqual(heightToNormal(ramp, 0.25, false).data);
    const flipped = await renderRecipe({ kind: "copy", texture: "h", role: "normal" }, context(ramp, { ...settings, flipGreenChannel: true }));
    expect(flipped.data[5]).toBe(255 - plain.data[5]!);
  });

  it("applies maxTextureSize to the longest edge, keeps the aspect ratio and never scales up", async () => {
    const wide: DecodedImage = { width: 300, height: 100, data: Buffer.alloc(300 * 100 * 4, 200) };
    const small = await limitTextureSize(wide, 128);
    expect([small.width, small.height]).toEqual([128, 43]);
    expect(await limitTextureSize(wide, 512)).toBe(wide);
    expect(await limitTextureSize(wide, undefined)).toBe(wide);
  });

  it("writes an opaque image as RGB and a translucent one as RGBA", async () => {
    const opaque = await sharp(await encodePng({ width: 1, height: 1, data: Buffer.from([1, 2, 3, 255]) })).metadata();
    const translucent = await sharp(await encodePng({ width: 1, height: 1, data: Buffer.from([1, 2, 3, 100]) })).metadata();
    expect([opaque.channels, translucent.channels]).toEqual([3, 4]);
  });
});
