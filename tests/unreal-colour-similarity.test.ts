import { describe, expect, it } from "vitest";

import { colourSimilarity, objectMask, rgbToLab, type RgbaImage } from "../src/unreal/image-diff.js";

type Rgb = [number, number, number];

/**
 * A scene: `background(x, y)` everywhere, a square object of `side` px in the middle painted by
 * `paint(x, y)`. Deterministic, so the numbers below are stable.
 */
function scene(
  size: number,
  side: number,
  background: (x: number, y: number) => Rgb,
  paint: (x: number, y: number) => Rgb,
): RgbaImage {
  const data = new Uint8Array(size * size * 4);
  const lo = Math.floor((size - side) / 2);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inside = x >= lo && x < lo + side && y >= lo && y < lo + side;
      const [r, g, b] = inside ? paint(x, y) : background(x, y);
      data.set([r, g, b, 255], (y * size + x) * 4);
    }
  }
  return { width: size, height: size, data };
}

const grain = (x: number, y: number) => Math.sin(x * 12.9898 + y * 78.233) * 8;
const flatGrey = (): Rgb => [128, 128, 128];
/** A two-tone checkered floor, like an editor thumbnail's. */
const checker = (x: number, y: number): Rgb => ((x >> 3) + (y >> 3)) % 2 === 0 ? [150, 140, 120] : [95, 90, 80];
const brown = (x: number, y: number): Rgb => [150 + grain(x, y), 100 + grain(x, y), 60 + grain(x, y)];
const blueGrey = (x: number, y: number): Rgb => [60 + grain(x, y), 80 + grain(x, y), 110 + grain(x, y)];

describe("objectMask", () => {
  it("keeps the object and drops a flat or a checkered background", () => {
    for (const background of [flatGrey, checker]) {
      const mask = objectMask(scene(100, 40, background, brown));
      const count = mask.reduce((sum, v) => sum + v, 0);
      expect(count).toBeGreaterThan(1600 * 0.97);
      expect(count).toBeLessThan(1600 * 1.03);
    }
  });
});

describe("rgbToLab", () => {
  it("maps white and black to L 100 and 0 with no chroma", () => {
    const white = rgbToLab(255, 255, 255);
    expect(white[0]).toBeCloseTo(100, 0);
    expect(Math.abs(white[1])).toBeLessThan(0.5);
    expect(Math.abs(white[2])).toBeLessThan(0.5);
    expect(rgbToLab(0, 0, 0)[0]).toBeCloseTo(0, 5);
  });
});

describe("colourSimilarity", () => {
  it("is high for the same colour seen on different backgrounds", () => {
    const result = colourSimilarity(scene(100, 40, checker, brown), scene(128, 60, flatGrey, brown));
    expect(result.comparable).toBe(true);
    expect(result.similarity).toBeGreaterThan(0.85);
    expect(result.meanColourDelta).toBeLessThan(3);
  });

  it("is low for a brown object against a blue-grey one", () => {
    const result = colourSimilarity(scene(100, 40, checker, blueGrey), scene(128, 60, flatGrey, brown));
    expect(result.similarity).toBeLessThan(0.3);
    expect(result.meanColourDelta).toBeGreaterThan(25);
    expect(result.hueHistogramIntersection).toBeLessThan(0.2);
  });

  it("is not comparable, and scores 0, when one side has no object", () => {
    const empty = scene(100, 0, flatGrey, brown);
    const result = colourSimilarity(empty, scene(128, 60, flatGrey, brown));
    expect(result.comparable).toBe(false);
    expect(result.similarity).toBe(0);
  });

  it("does not depend on object size or position", () => {
    const small = colourSimilarity(scene(100, 20, flatGrey, brown), scene(100, 70, flatGrey, brown));
    expect(small.similarity).toBeGreaterThan(0.85);
  });
});

describe("colourSimilarity with a thumbnail's cast shadow", () => {
  it("scores a correct render higher when the shadow is taken out of the reference's object mask", async () => {
    const { withoutFloorShadow } = await import("../src/unreal/render-fidelity.js");
    const size = 96;
    const checker = (x: number, y: number): Rgb => ((Math.floor(x / 12) + Math.floor(y / 12)) % 2 === 0 ? [125, 132, 137] : [112, 120, 126]);
    const leaf = (x: number): Rgb => [40 + (x % 5) * 6, 150 + (x % 7) * 4, 50];
    const reference = scene(size, 30, checker, (x) => leaf(x));
    // The piece's cast shadow: a big dark, bluer copy of the floor beside it.
    for (let y = 60; y < 90; y++) for (let x = 4; x < 80; x++) reference.data.set([48, 66, 78, 255], (y * size + x) * 4);
    const render = scene(size, 30, flatGrey, (x) => leaf(x));
    const polluted = colourSimilarity(reference, render);
    const clean = colourSimilarity(reference, render, withoutFloorShadow(reference, objectMask(reference)));
    expect(clean.similarity).toBeGreaterThan(polluted.similarity + 0.15);
    expect(clean.similarity).toBeGreaterThan(0.6);
  });
});
