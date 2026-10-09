import { describe, expect, it } from "vitest";

import type { RgbaImage } from "../src/unreal/image-diff.js";
import { circularHueEmd, explainFidelity, FIDELITY_OK_SCORE, FIDELITY_SUSPECT_SCORE, measureFidelity } from "../src/unreal/render-fidelity.js";
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
    expect(metrics.score).toBeLessThan(FIDELITY_OK_SCORE);
    expect(explainFidelity(metrics)).toMatch(/greyer than Unreal/);
  });

  it("flags a hue shift at the same saturation", () => {
    const metrics = measureFidelity(reference, tile([160, 80, 40]));
    expect(metrics.hueEmdDegrees).toBeGreaterThan(30);
    expect(metrics.score).toBeLessThan(FIDELITY_OK_SCORE);
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

describe("judgeRender with a fidelity score", () => {
  const image = tile([120, 160, 40]);
  it("passes a high score, marks a middling one suspect and a low one fail, with the explanation", () => {
    expect(judgeRender(image, { fidelityScore: 90 }).verdict).toBe("ok");
    const suspect = judgeRender(image, { fidelityScore: FIDELITY_OK_SCORE - 1, fidelityExplanation: "greyer than Unreal (0.60x saturation)" });
    expect(suspect.verdict).toBe("suspect");
    expect(suspect.reasons.join(" ")).toContain("greyer than Unreal");
    expect(judgeRender(image, { fidelityScore: FIDELITY_SUSPECT_SCORE - 1 }).verdict).toBe("fail");
  });
});
