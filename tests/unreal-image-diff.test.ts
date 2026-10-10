import sharp from "sharp";
import { describe, expect, it } from "vitest";

import {
  compareImages,
  decodeRgba,
  dHash,
  hammingDistance,
  maskFillRatio,
  maxAbsDiff,
  mse,
  perceptualHash,
  premultiplyAlpha,
  psnr,
  ssim,
  ssimScores,
  type RgbaImage,
} from "../src/unreal/image-diff.js";

/** Deterministic noise (mulberry32) so every run sees the same pixels. */
function noise(width: number, height: number, seed = 1): RgbaImage {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 20 + Math.floor(next() * 200);
    data[i + 1] = 20 + Math.floor(next() * 200);
    data[i + 2] = 20 + Math.floor(next() * 200);
    data[i + 3] = 255;
  }
  return { width, height, data };
}

const clone = (image: RgbaImage): RgbaImage => ({ ...image, data: new Uint8Array(image.data) });

function offset(image: RgbaImage, delta: number): RgbaImage {
  const out = clone(image);
  for (let i = 0; i < out.data.length; i++) out.data[i] = Math.max(0, Math.min(255, out.data[i]! + delta));
  return out;
}

function shiftRight(image: RgbaImage, pixels: number): RgbaImage {
  const out = clone(image);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const from = (y * image.width + ((x - pixels + image.width) % image.width)) * 4;
      out.data.set(image.data.subarray(from, from + 4), (y * image.width + x) * 4);
    }
  }
  return out;
}

function solid(width: number, height: number, rgba: readonly number[]): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return { width, height, data };
}

describe("image-diff metrics", () => {
  it("scores identical images as perfect", async () => {
    const a = noise(32, 24);
    const b = clone(a);
    expect(mse(a, b)).toBe(0);
    expect(psnr(a, b)).toBe(Infinity);
    expect(maxAbsDiff(a, b)).toBe(0);
    expect(ssim(a, b)).toBeCloseTo(1, 12);
    const compared = await compareImages(a, b);
    expect(compared).toMatchObject({ identical: true, mse: 0, maxAbs: 0, resized: false, dHashDistance: 0, pHashDistance: 0 });
    expect(compared.ssim).toBeCloseTo(1, 12);
  });

  it.each([1, 4, 16])("a constant offset of %i gives mse d^2 and psnr 10*log10(255^2/d^2)", (d) => {
    const a = solid(16, 16, [100, 110, 120, 128]);
    const b = offset(a, d);
    expect(mse(a, b)).toBeCloseTo(d * d, 12);
    expect(psnr(a, b)).toBeCloseTo(10 * Math.log10((255 * 255) / (d * d)), 9);
    expect(maxAbsDiff(a, b)).toBe(d);
  });

  it("one flipped pixel is found by maxAbs and is not identical", async () => {
    const a = noise(16, 16, 7);
    const b = clone(a);
    const at = (5 * 16 + 9) * 4 + 2;
    b.data[at] = 255 - b.data[at]!;
    const expected = Math.abs(a.data[at]! - b.data[at]!);
    expect(maxAbsDiff(a, b)).toBe(expected);
    expect(mse(a, b)).toBeCloseTo((expected * expected) / (16 * 16 * 4), 12);
    const compared = await compareImages(a, b);
    expect(compared.identical).toBe(false);
    expect(compared.ssim).toBeLessThan(1);
    expect(compared.maxAbs).toBe(expected);
  });

  it("a colour-channel change that luminance barely sees still lowers the headline ssim", () => {
    const a = noise(24, 24, 3);
    const b = clone(a);
    // Alpha changes nothing in luminance.
    for (let i = 3; i < b.data.length; i += 4) b.data[i] = i % 8 === 3 ? 255 : 90;
    const scores = ssimScores(a, b);
    expect(scores.luma).toBeCloseTo(1, 12);
    expect(scores.channels[3]).toBeLessThan(0.99);
    expect(scores.ssim).toBeLessThan(scores.luma);
  });

  it("a horizontally shifted noise image is far from the original", () => {
    const a = noise(64, 64, 11);
    const shifted = shiftRight(a, 3);
    expect(ssim(a, shifted)).toBeLessThan(0.2);
    expect(mse(a, shifted)).toBeGreaterThan(1000);
  });

  it("ssim falls monotonically as brightness moves away", () => {
    const a = noise(48, 48, 5);
    const scores = [0, 8, 24, 64, 120].map((delta) => ssim(a, offset(a, delta)));
    for (let i = 1; i < scores.length; i++) expect(scores[i]!).toBeLessThan(scores[i - 1]!);
    expect(scores[0]).toBeCloseTo(1, 12);
  });

  it("ssim of two flat images follows the luminance term: equal grey is 1, black vs white is near 0", () => {
    expect(ssim(solid(16, 16, [90, 90, 90, 255]), solid(16, 16, [90, 90, 90, 255]))).toBeCloseTo(1, 12);
    expect(ssim(solid(16, 16, [0, 0, 0, 255]), solid(16, 16, [255, 255, 255, 255]))).toBeLessThan(0.01);
  });

  it("handles images smaller than one window", () => {
    const a = noise(3, 5, 2);
    expect(ssim(a, clone(a))).toBeCloseTo(1, 12);
    expect(ssim(a, offset(a, 40))).toBeLessThan(1);
  });

  it("throws on a size mismatch unless asked to resize", async () => {
    const a = noise(16, 16);
    const b = noise(8, 8);
    expect(() => mse(a, b)).toThrow(/sizes differ/);
    await expect(compareImages(a, b)).rejects.toThrow(/sizes differ/);
  });

  it("resizes to match and reports it", async () => {
    // A smooth gradient survives a down-up round trip with small error; noise would not.
    const width = 32;
    const data = new Uint8Array(width * width * 4);
    for (let y = 0; y < width; y++) {
      for (let x = 0; x < width; x++) data.set([x * 8, y * 8, 128, 255], (y * width + x) * 4);
    }
    const a: RgbaImage = { width, height: width, data };
    const small = await sharp(Buffer.from(data), { raw: { width, height: width, channels: 4 } })
      .resize(16, 16)
      .raw()
      .toBuffer();
    const compared = await compareImages(a, { width: 16, height: 16, data: new Uint8Array(small) }, { resizeToMatch: true });
    expect(compared).toMatchObject({ width, height: width, resized: true, identical: false });
    expect(compared.ssim).toBeGreaterThan(0.95);
    expect(compared.psnr).toBeGreaterThan(25);
  });

  it("compares straight alpha by default and premultiplied on request", async () => {
    // Same visible pixel; the colour hidden behind alpha 0 differs.
    const a = solid(8, 8, [10, 20, 30, 0]);
    const b = solid(8, 8, [200, 100, 50, 0]);
    expect((await compareImages(a, b)).identical).toBe(false);
    const premultiplied = await compareImages(a, b, { premultiplied: true });
    expect(premultiplied.identical).toBe(true);
    expect(premultiplied.mse).toBe(0);
    expect(premultiplyAlpha(solid(1, 1, [200, 100, 50, 128])).data).toEqual(new Uint8Array([100, 50, 25, 128]));
  });

  it("decodes encoded images to straight RGBA and accepts buffers in compareImages", async () => {
    const source = noise(10, 6, 9);
    const png = await sharp(Buffer.from(source.data), { raw: { width: 10, height: 6, channels: 4 } }).png().toBuffer();
    const decoded = await decodeRgba(png);
    expect(decoded.width).toBe(10);
    expect(Buffer.from(decoded.data).equals(Buffer.from(source.data))).toBe(true);
    expect((await compareImages(png, source)).identical).toBe(true);
    // 3-channel input gains an opaque alpha.
    const rgb = await sharp(Buffer.from(source.data), { raw: { width: 10, height: 6, channels: 4 } }).removeAlpha().jpeg({ quality: 100 }).toBuffer();
    expect((await decodeRgba(rgb)).data[3]).toBe(255);
  });
});

describe("perceptual hashes", () => {
  /** A smooth picture: flat-region ties would make a difference hash flip on rounding noise. */
  function pattern(width: number): RgbaImage {
    const data = new Uint8Array(width * width * 4);
    for (let y = 0; y < width; y++) {
      for (let x = 0; x < width; x++) {
        const u = x / width;
        const v = y / width;
        const value = 128 + 90 * Math.sin(u * 9 + v * 3) * Math.cos(v * 7 - u * 2);
        data.set([value, value, value, 255], (y * width + x) * 4);
      }
    }
    return { width, height: width, data };
  }

  it("agree for the same picture at two resolutions and differ for another picture", async () => {
    const big = pattern(64);
    const small = await sharp(Buffer.from(big.data), { raw: { width: 64, height: 64, channels: 4 } }).resize(32, 32).raw().toBuffer();
    const smaller: RgbaImage = { width: 32, height: 32, data: new Uint8Array(small) };
    expect(hammingDistance(dHash(big), dHash(smaller))).toBeLessThanOrEqual(4);
    expect(hammingDistance(perceptualHash(big), perceptualHash(smaller))).toBeLessThanOrEqual(4);
    const other = noise(64, 64, 4);
    expect(hammingDistance(perceptualHash(big), perceptualHash(other))).toBeGreaterThan(10);
  });

  it("hex hashes are 16 digits and hamming counts bits", () => {
    expect(dHash(noise(16, 16))).toMatch(/^[0-9a-f]{16}$/);
    expect(perceptualHash(noise(16, 16))).toMatch(/^[0-9a-f]{16}$/);
    expect(hammingDistance("0000000000000000", "ffffffffffffffff")).toBe(64);
    expect(hammingDistance("0f", "f0")).toBe(8);
    expect(() => hammingDistance("0", "00")).toThrow(/same length/);
  });
});

describe("maskFillRatio", () => {
  it("is 1 for a mask that fills its own box, and lower for a ragged one", () => {
    const solid = new Uint8Array(10 * 10).fill(1);
    expect(maskFillRatio(solid, 10, 10)).toEqual({ pixels: 100, boundingBox: 100, fillRatio: 1 });
    const ragged = new Uint8Array(10 * 10);
    for (let i = 0; i < 10; i++) ragged[i * 10 + i] = 1; // a diagonal
    const fill = maskFillRatio(ragged, 10, 10);
    expect(fill.pixels).toBe(10);
    expect(fill.boundingBox).toBe(100);
    expect(fill.fillRatio).toBeCloseTo(0.1);
  });

  it("measures the tight bounding box, not the whole mask", () => {
    const mask = new Uint8Array(10 * 10);
    for (let y = 2; y < 8; y++) for (let x = 3; x < 9; x++) mask[y * 10 + x] = 1;
    expect(maskFillRatio(mask, 10, 10)).toEqual({ pixels: 36, boundingBox: 36, fillRatio: 1 });
    mask[0] = 1; // a stray pixel at the corner grows the box to 9 x 8
    const stray = maskFillRatio(mask, 10, 10);
    expect(stray.pixels).toBe(37);
    expect(stray.boundingBox).toBe(9 * 8);
  });

  it("is zero for an empty mask", () => {
    expect(maskFillRatio(new Uint8Array(16), 4, 4)).toEqual({ pixels: 0, boundingBox: 0, fillRatio: 0 });
  });
});
