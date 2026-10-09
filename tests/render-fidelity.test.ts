import { describe, expect, it } from "vitest";

import type { RgbaImage } from "../src/unreal/image-diff.js";
import { circularHueEmd, explainFidelity, FIDELITY_OK_SCORE, fidelityVerdict, measureFidelity } from "../src/unreal/render-fidelity.js";
import { judgeRender } from "../src/unreal/visual-judge.js";

const SIZE = 64;

/** A flat mid-grey tile with a rectangle of `colour` (the object), optionally with a hole pattern that lowers its fill. */
function tile(colour: [number, number, number], options: { sparse?: boolean } = {}): RgbaImage {
  const data = new Uint8Array(SIZE * SIZE * 4);
  for (let i = 0; i < SIZE * SIZE; i++) {
    const x = i % SIZE;
    const y = Math.floor(i / SIZE);
    const inside = x >= 12 && x < 52 && y >= 12 && y < 52;
    // Sparse: only every third column inside the box is drawn, so the fill ratio drops to about a third.
    const drawn = inside && (!options.sparse || x % 3 === 0);
    const [r, g, b] = drawn ? colour : [128, 128, 128];
    data.set([r, g, b, 255], i * 4);
  }
  return { width: SIZE, height: SIZE, data };
}

describe("measureFidelity", () => {
  const reference = tile([120, 160, 40]);

  it("scores an identical render at the top", () => {
    const metrics = measureFidelity(reference, tile([120, 160, 40]));
    expect(metrics.comparable).toBe(true);
    expect(metrics.score).toBeGreaterThan(95);
    expect(metrics.saturationRatio).toBeCloseTo(1, 1);
    expect(metrics.densityRatio).toBeCloseTo(1, 1);
  });

  it("survives a lighting change: a darker, same-hue, same-saturation render stays ok", () => {
    // Unreal's thumbnail is lit differently; scaling the colour keeps hue and chroma per lightness close.
    const metrics = measureFidelity(reference, tile([96, 128, 32]));
    expect(metrics.score).toBeGreaterThanOrEqual(FIDELITY_OK_SCORE);
  });

  it("flags a washed-out (greyer) render of the same hue: the conifer defect", () => {
    // Same yellow-green hue, a third of the saturation. The old mean-colour similarity waved this kind of drift through.
    const metrics = measureFidelity(reference, tile([128, 140, 100]));
    expect(metrics.saturationRatio).toBeLessThan(0.6);
    expect(fidelityVerdict(metrics).verdict).not.toBe("ok");
    expect(explainFidelity(metrics)).toMatch(/greyer than Unreal/);
  });

  it("flags a hue shift at the same saturation", () => {
    const metrics = measureFidelity(reference, tile([160, 80, 40]));
    expect(metrics.hueEmdDegrees).toBeGreaterThan(30);
    expect(fidelityVerdict(metrics).verdict).not.toBe("ok");
    expect(explainFidelity(metrics)).toMatch(/hue off/);
  });

  it("flags a sparse silhouette (needles missing) and a solid card", () => {
    const sparse = measureFidelity(reference, tile([120, 160, 40], { sparse: true }));
    expect(sparse.densityRatio).toBeLessThan(0.5);
    expect(explainFidelity(sparse)).toMatch(/sparser than Unreal/);
    const solid = measureFidelity(tile([120, 160, 40], { sparse: true }), tile([120, 160, 40]));
    expect(solid.densityRatio).toBeGreaterThan(2);
    expect(explainFidelity(solid)).toMatch(/more solid than Unreal/);
  });

  it("does not fail a legitimately grey object that Unreal also shows grey", () => {
    const metrics = measureFidelity(tile([90, 90, 92]), tile([100, 100, 102]));
    expect(metrics.parts.hue).toBe(1);
    expect(metrics.parts.saturation).toBe(1);
    expect(metrics.score).toBeGreaterThanOrEqual(FIDELITY_OK_SCORE);
  });

  it("is not comparable when an object is missing", () => {
    expect(measureFidelity(reference, tile([128, 128, 128])).comparable).toBe(false);
  });

  it("circularHueEmd wraps around the hue circle", () => {
    const near = new Float64Array(36);
    const other = new Float64Array(36);
    near[0] = 1;
    other[35] = 1;
    expect(circularHueEmd(near, other)).toBeCloseTo(10, 5);
    expect(circularHueEmd(near, near)).toBe(0);
  });
});

/** A textured, foliage-like object: leaf greens of varied lightness, on flat grey. */
function foliage(transform: (r: number, g: number, b: number, x: number, y: number) => [number, number, number]): RgbaImage {
  const data = new Uint8Array(SIZE * SIZE * 4);
  for (let i = 0; i < SIZE * SIZE; i++) {
    const x = i % SIZE;
    const y = Math.floor(i / SIZE);
    const inside = x >= 10 && x < 54 && y >= 8 && y < 56 && (x * 7 + y * 3) % 5 !== 0;
    let rgb: [number, number, number] = [128, 128, 128];
    if (inside) {
      const shade = 0.55 + 0.45 * (((x * 13 + y * 29) % 17) / 16);
      rgb = transform(110 * shade, 160 * shade, 45 * shade, x, y);
    }
    data.set([...rgb.map((v) => Math.max(0, Math.min(255, Math.round(v)))), 255], i * 4);
  }
  return { width: SIZE, height: SIZE, data };
}

describe("measureFidelity under Unreal-like lighting (apples to apples)", () => {
  const neutral = foliage((r, g, b) => [r, g, b]);

  it("is unmoved by sun and shade, a cast-shadow patch and a cool sky tint on the reference", () => {
    // Unreal's thumbnail: brighter sun side, darker shade side, a deep shadow patch, a bluish ambient lift in shade.
    const lit = foliage((r, g, b, x, y) => {
      const sun = 0.5 + 0.9 * (x / SIZE);
      const inShadow = x < 22 && y > 36;
      const k = inShadow ? 0.25 : sun;
      const ambient = inShadow ? 12 : 0;
      return [r * k + ambient * 0.6, g * k + ambient * 0.8, b * k + ambient * 1.3];
    });
    const metrics = measureFidelity(lit, neutral);
    expect(metrics.score).toBeGreaterThanOrEqual(FIDELITY_OK_SCORE + 10);
    expect(metrics.saturationRatio).toBeGreaterThan(0.8);
    expect(metrics.saturationRatio).toBeLessThan(1.25);
    expect(fidelityVerdict(metrics).verdict).toBe("ok");
  });

  it("still catches a desaturated render under that same lighting difference", () => {
    const lit = foliage((r, g, b, x) => {
      const k = 0.5 + 0.9 * (x / SIZE);
      return [r * k, g * k, b * k];
    });
    // Same luminance, half the colour: the washed-out conifer look.
    const washed = foliage((r, g, b) => {
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      return [y + (r - y) * 0.45, y + (g - y) * 0.45, y + (b - y) * 0.45];
    });
    const metrics = measureFidelity(lit, washed);
    expect(metrics.saturationRatio).toBeLessThan(0.75);
    expect(fidelityVerdict(metrics).verdict).not.toBe("ok");
  });
});

describe("judgeRender with fidelity", () => {
  const image = tile([120, 160, 40]);
  const reference = tile([120, 160, 40]);

  it("passes a faithful render", () => {
    expect(judgeRender(image, { fidelity: measureFidelity(reference, image) }).verdict).toBe("ok");
  });

  it("marks one bad axis suspect, and a very bad one fail, with the reason", () => {
    const washed = measureFidelity(reference, tile([128, 140, 100]));
    const suspect = judgeRender(image, { fidelity: washed });
    expect(["suspect", "fail"]).toContain(suspect.verdict);
    expect(suspect.reasons.join(" ")).toContain("greyer than Unreal");
    const solid = measureFidelity(tile([120, 160, 40], { sparse: true }), tile([120, 160, 40]));
    expect(judgeRender(image, { fidelity: solid }).verdict).toBe("fail");
  });
});

/**
 * An editor thumbnail stands the piece on a blue-grey checkered floor and the piece casts a dark, bluer copy of that floor.
 * The border-palette object mask counts the shadow as object: it drags hue toward blue (the conifer pack read 30-60 degrees
 * "off" on Larch/Spruce that were not), lowers saturation and inflates the bounding box. Synthetic stand-in below.
 */
function thumbnailWithShadow(withShadow: boolean): RgbaImage {
  const size = 96;
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const x = i % size;
    const y = Math.floor(i / size);
    const checker = (Math.floor(x / 12) + Math.floor(y / 12)) % 2 === 0;
    let rgb: [number, number, number] = checker ? [125, 132, 137] : [112, 120, 126];
    // Shadow blob on the floor, left of and below the plant: darker and bluer than the floor.
    if (withShadow && x >= 6 && x < 46 && y >= 60 && y < 84) rgb = [48, 66, 78];
    // The plant: leaf greens of varied lightness, ragged like needles.
    if (x >= 40 && x < 80 && y >= 14 && y < 62 && (x * 7 + y * 3) % 5 !== 0) {
      const shade = 0.55 + 0.45 * (((x * 13 + y * 29) % 17) / 16);
      rgb = [110 * shade, 160 * shade, 45 * shade];
    }
    data.set([...rgb.map((v) => Math.round(v)), 255], i * 4);
  }
  return { width: size, height: size, data };
}

describe("measureFidelity ignores the floor's cast shadow", () => {
  const render = foliage((r, g, b) => [r, g, b]);

  it("scores a correct render the same with and without a shadow in the reference", () => {
    const clean = measureFidelity(thumbnailWithShadow(false), render);
    const shadowed = measureFidelity(thumbnailWithShadow(true), render);
    expect(shadowed.hueEmdDegrees).toBeLessThan(15);
    expect(shadowed.hueEmdDegrees).toBeCloseTo(clean.hueEmdDegrees, 0);
    expect(shadowed.densityRatio).toBeCloseTo(clean.densityRatio, 1);
    expect(fidelityVerdict(shadowed).verdict).toBe("ok");
  });

  it("still flags a genuinely wrong hue when a shadow is present", () => {
    const wrong = foliage((r, g, b) => [g, r, b]);
    expect(fidelityVerdict(measureFidelity(thumbnailWithShadow(true), wrong)).verdict).not.toBe("ok");
  });
});
