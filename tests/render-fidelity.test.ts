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
function thumbnailWithShadow(withShadow: boolean, floor: { light: [number, number, number]; dark: [number, number, number]; shadow: [number, number, number] } = { light: [125, 132, 137], dark: [112, 120, 126], shadow: [48, 66, 78] }): RgbaImage {
  const size = 96;
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const x = i % size;
    const y = Math.floor(i / size);
    const checker = (Math.floor(x / 12) + Math.floor(y / 12)) % 2 === 0;
    let rgb: [number, number, number] = checker ? floor.light : floor.dark;
    // Shadow blob on the floor, left of and below the plant: darker and bluer than the floor.
    if (withShadow && x >= 2 && x < 60 && y >= 58 && y < 94) rgb = floor.shadow;
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

  it("also removes it from a near-neutral light floor (the Fern Collection thumbnails, floor saturation 0.035)", () => {
    // The grey shadow has a lower saturation than the leaves: left in the mask it halved the reference's median saturation,
    // so a correct fern read 2.4x "over-saturated" and failed.
    const neutral = { light: [167, 171, 173] as [number, number, number], dark: [150, 154, 157] as [number, number, number], shadow: [109, 116, 122] as [number, number, number] };
    const clean = measureFidelity(thumbnailWithShadow(false, neutral), render);
    const shadowed = measureFidelity(thumbnailWithShadow(true, neutral), render);
    expect(shadowed.saturationRatio).toBeCloseTo(clean.saturationRatio, 1);
    expect(shadowed.saturationRatio).toBeLessThan(1.4);
    expect(fidelityVerdict(shadowed).verdict).toBe("ok");
  });

  it("still flags a genuinely wrong hue when a shadow is present", () => {
    const wrong = foliage((r, g, b) => [g, r, b]);
    expect(fidelityVerdict(measureFidelity(thumbnailWithShadow(true), wrong)).verdict).not.toBe("ok");
  });
});

describe("referenceObjectMask (the solid-card check's thumbnail fill)", () => {
  it("does not grow the thumbnail's bounding box with the floor's shadow", async () => {
    const { referenceObjectMask } = await import("../src/unreal/contact-sheet.js");
    const { maskFillRatio } = await import("../src/unreal/image-diff.js");
    const fill = (image: RgbaImage) => maskFillRatio(referenceObjectMask(image), image.width, image.height).fillRatio;
    // With the shadow counted, the plant's bounding box spans the shadow blob too and its fill drops by about half, which
    // made a correct cut-out render read as "solid card" (fill 0.2 vs 0.08 on the conifer ground twigs).
    expect(fill(thumbnailWithShadow(true))).toBeCloseTo(fill(thumbnailWithShadow(false)), 1);
  });
});

/**
 * Mass, not only bounding-box fill: a spray of 1px needles and a half-solid blob can fill the same share of their boxes,
 * yet one reads as speckle. `closedSolidity` is object pixels over the closed silhouette's pixels at the scale of a needle
 * cluster. Calibrated on the conifer pack: render/reference mass 0.82 at 1x (hard alpha-tested edges), 0.95 supersampled.
 */
function stripes(period: number, boxWidth = 40): RgbaImage {
  const data = new Uint8Array(SIZE * SIZE * 4);
  for (let i = 0; i < SIZE * SIZE; i++) {
    const x = i % SIZE;
    const y = Math.floor(i / SIZE);
    const inside = x >= 12 && x < 12 + boxWidth && y >= 12 && y < 52 && (period === 1 || x % period === 0);
    data.set(inside ? [60, 150, 50, 255] : [128, 128, 128, 255], i * 4);
  }
  return { width: SIZE, height: SIZE, data };
}

describe("closedSolidity and the mass ratio", () => {
  it("is 1 for a solid block and about the fill for thin stripes the closing bridges", async () => {
    const { objectMask } = await import("../src/unreal/image-diff.js");
    const { closedSolidity } = await import("../src/unreal/render-fidelity.js");
    const solidity = (image: RgbaImage) => closedSolidity(objectMask(image, 26), image.width, image.height, 0.03);
    expect(solidity(stripes(1))).toBeCloseTo(1, 2);
    expect(solidity(stripes(2))).toBeGreaterThan(0.45);
    expect(solidity(stripes(2))).toBeLessThan(0.6);
  });

  it("sees thin speckle that bounding-box fill cannot: equal fill, half the mass", () => {
    // Reference: a solid block over the left half of the box plus one stray pixel that stretches its box to full width.
    // Render: stripes across the whole box at half density. Both fill half of their (equal) boxes.
    const reference = stripes(1, 20);
    reference.data.set([60, 150, 50, 255], (12 * SIZE + 51) * 4);
    const render = stripes(2, 40);
    const metrics = measureFidelity(reference, render);
    expect(metrics.comparable).toBe(true);
    expect(metrics.densityRatio).toBeGreaterThan(0.85);
    expect(metrics.densityRatio).toBeLessThan(1.2);
    expect(metrics.massRatio).toBeLessThan(0.65);
    expect(explainFidelity(metrics)).toMatch(/thinner than Unreal/);
  });

  it("fails a spray of thin needles against a dense reference", () => {
    const metrics = measureFidelity(stripes(1, 40), stripes(3, 40));
    expect(metrics.massRatio).toBeLessThan(0.4);
    expect(fidelityVerdict(metrics).verdict).toBe("fail");
    expect(fidelityVerdict(metrics).reasons.join(" ")).toMatch(/thinner than Unreal/);
  });

  it("reads the mass from the supersampled render when one is given, leaving colour and density on the 1x render", () => {
    const reference = stripes(1, 40);
    const thin = stripes(3, 40);
    const dense = stripes(1, 40);
    const plain = measureFidelity(reference, thin);
    const supersampled = measureFidelity(reference, thin, dense);
    expect(supersampled.massRatio).toBeGreaterThan(plain.massRatio * 2);
    expect(supersampled.densityRatio).toBeCloseTo(plain.densityRatio, 6);
    expect(supersampled.saturationRatio).toBeCloseTo(plain.saturationRatio, 6);
  });

  it("does not flag an identical render", () => {
    const metrics = measureFidelity(stripes(2, 40), stripes(2, 40));
    expect(metrics.massRatio).toBeCloseTo(1, 2);
    expect(fidelityVerdict(metrics).verdict).toBe("ok");
  });
});
