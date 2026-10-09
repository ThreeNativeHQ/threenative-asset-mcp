import { describe, expect, it } from "vitest";

import { auditCutout, measureAgainstAlbedo, opacityCoverage, uvCoverage, type AlbedoSource } from "../src/unreal/albedo-fidelity.js";
import type { RgbaImage } from "../src/unreal/image-diff.js";

// Synthetic images only.

function image(width: number, height: number, texel: (x: number, y: number) => [number, number, number, number]): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(texel(x, y), (y * width + x) * 4);
  return { width, height, data };
}

/** A neutral-grey tile with a coloured disc in the middle, like the contact-sheet renderer draws a piece. */
const render = (rgb: [number, number, number]): RgbaImage =>
  image(64, 64, (x, y) => ((x - 32) ** 2 + (y - 32) ** 2 <= 24 ** 2 ? [...rgb, 255] : [128, 128, 128, 255]));

const flat = (rgb: [number, number, number], alpha = 255): RgbaImage => image(8, 8, () => [...rgb, alpha]);
const source = (img: RgbaImage, weight = 1): AlbedoSource => ({ image: img, weight });

describe("measureAgainstAlbedo", () => {
  const leaf: [number, number, number] = [50, 110, 40];

  it("scores a render of the right colour high", () => {
    const result = measureAgainstAlbedo([source(flat(leaf))], render([45, 100, 36]));
    expect(result.comparable).toBe(true);
    expect(result.hueEmdDegrees).toBeLessThan(10);
    expect(result.saturationRatio).toBeGreaterThan(0.85);
    expect(result.saturationRatio).toBeLessThan(1.15);
    expect(result.score).toBeGreaterThan(85);
  });

  it("does not move with exposure: a render lit at half the albedo's brightness still scores high", () => {
    const dim = measureAgainstAlbedo([source(flat(leaf))], render([25, 55, 20]));
    expect(dim.saturationRatio).toBeGreaterThan(0.85);
    expect(dim.saturationRatio).toBeLessThan(1.2);
    expect(dim.verdict).toBe("ok");
  });

  it("gives a verdict with a reason when the render is greyer than its textures", () => {
    const result = measureAgainstAlbedo([source(flat(leaf))], render([90, 100, 88]));
    expect(result.verdict).toBe("fail");
    expect(result.reasons.join()).toContain("greyer than its textures");
  });

  it("scores a washed-out render low on saturation", () => {
    const result = measureAgainstAlbedo([source(flat(leaf))], render([90, 100, 88]));
    expect(result.saturationRatio).toBeLessThan(0.5);
    expect(result.score).toBeLessThan(55);
  });

  it("scores a hue-shifted render low on hue", () => {
    const result = measureAgainstAlbedo([source(flat(leaf))], render([120, 50, 40]));
    expect(result.hueEmdDegrees).toBeGreaterThan(60);
    expect(result.score).toBeLessThan(60);
  });

  it("counts albedo pixels in proportion to their alpha: a transparent magenta background is not the leaf's colour", () => {
    const card = image(8, 8, (x) => (x < 4 ? [...leaf, 255] : [255, 0, 255, 0]));
    const result = measureAgainstAlbedo([source(card)], render([45, 100, 36]));
    expect(result.hueEmdDegrees).toBeLessThan(10);
    expect(result.score).toBeGreaterThan(85);
    // The same card with the background opaque is half magenta, and the green render is then far off.
    const solid = image(8, 8, (x) => (x < 4 ? [...leaf, 255] : [255, 0, 255, 255]));
    expect(measureAgainstAlbedo([source(solid)], render([45, 100, 36])).score).toBeLessThan(70);
  });

  it("weights several materials by their share of the piece", () => {
    const bark = flat([120, 100, 80]);
    const mostlyLeaf = measureAgainstAlbedo([source(flat(leaf), 9), source(bark, 1)], render([45, 100, 36]));
    const mostlyBark = measureAgainstAlbedo([source(flat(leaf), 1), source(bark, 9)], render([45, 100, 36]));
    expect(mostlyLeaf.score).toBeGreaterThan(mostlyBark.score);
  });

  it("is not comparable when nothing is drawn", () => {
    expect(measureAgainstAlbedo([source(flat(leaf))], image(32, 32, () => [128, 128, 128, 255])).comparable).toBe(false);
  });
});

describe("cut-out coverage", () => {
  /** A diamond: white (leaf) inside, black outside. About half of the texels. */
  const mask = image(32, 32, (x, y) => (Math.abs(x - 16) + Math.abs(y - 16) <= 16 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
  const maskCoverage = opacityCoverage(mask, "red");

  it("measures the opaque share of a channel", () => {
    expect(maskCoverage).toBeGreaterThan(0.4);
    expect(maskCoverage).toBeLessThan(0.6);
    expect(opacityCoverage(flat([1, 2, 3], 255), "alpha")).toBe(1);
    expect(opacityCoverage(flat([1, 2, 3], 0), "alpha")).toBe(0);
  });

  it("a card whose alpha follows its mask matches it", () => {
    const card = image(32, 32, (x, y) => [40, 120, 50, mask.data[(y * 32 + x) * 4]!]);
    const audit = auditCutout(card, mask);
    expect(audit.ratio).toBeCloseTo(1, 2);
    expect(audit.solidCard).toBe(false);
  });

  it("an opaque card under a real mask is a solid rectangle (the ivy defect)", () => {
    const audit = auditCutout(flat([40, 120, 50], 255), mask);
    expect(audit.coverage).toBe(1);
    expect(audit.ratio).toBeGreaterThan(1.7);
    expect(audit.solidCard).toBe(true);
  });
});

describe("UV coverage of an atlas", () => {
  const leaf: [number, number, number] = [50, 110, 40];
  // Left half of the atlas is the piece's green paint, right half is unused red.
  const atlas = image(16, 16, (x) => (x < 8 ? [...leaf, 255] : [200, 30, 30, 255]));
  // A quad mapped to the left half of the atlas.
  const leftHalf = uvCoverage([0, 0, 0.5, 0, 0.5, 1, 0, 1], [0, 1, 2, 0, 2, 3], 32);

  it("marks the cells a triangle maps and no others", () => {
    const at = (x: number, y: number): number => leftHalf.data[y * leftHalf.size + x]!;
    expect([at(2, 2), at(10, 30), at(14, 16)]).toEqual([1, 1, 1]);
    expect([at(18, 2), at(30, 30), at(24, 16)]).toEqual([0, 0, 0]);
  });

  it("covers a full-texture quad whose corners sit exactly on U = 1 and V = 1 (a leaf card)", () => {
    const full = uvCoverage([1, 0, 0, 0, 0, 1, 1, 1], [0, 1, 2, 0, 2, 3], 32);
    expect(full.data.reduce((sum, value) => sum + value, 0)).toBe(32 * 32);
  });

  it("wraps a tiled UV and keeps a triangle smaller than a cell", () => {
    const wrapped = uvCoverage([1.1, 1.1, 1.3, 1.1, 1.1, 1.3], undefined, 32);
    expect(wrapped.data[(4 * 32) + 4]).toBe(1);
    const tiny = uvCoverage([0.51, 0.51, 0.5105, 0.51, 0.51, 0.5105], undefined, 32);
    expect(tiny.data.reduce((sum, value) => sum + value, 0)).toBeGreaterThan(0);
  });

  it("without coverage the unused atlas area drags the albedo off the piece's colour; with it the render matches", () => {
    const rendered = render([45, 100, 36]);
    const whole = measureAgainstAlbedo([source(atlas)], rendered);
    const mapped = measureAgainstAlbedo([{ image: atlas, weight: 1, coverage: leftHalf }], rendered);
    expect(whole.score).toBeLessThan(mapped.score);
    expect(mapped.hueEmdDegrees).toBeLessThan(10);
    expect(mapped.verdict).toBe("ok");
  });
});
