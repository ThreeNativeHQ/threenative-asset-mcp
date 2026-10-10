import { expect, it } from "vitest";

import type { RgbaImage } from "../src/unreal/image-diff.js";
import {
  SOLID_CARD_FILL_FACTOR,
  SUSPECT_COLOUR_SIMILARITY,
  TINY_COVERAGE_FRACTION,
  judgeRender,
} from "../src/unreal/visual-judge.js";

const SIZE = 100;

/** Grey 128 tile with a centred square of `side` px painted by `paint(x, y)`. */
function tile(side: number, paint: (x: number, y: number) => [number, number, number]): RgbaImage {
  const data = new Uint8Array(SIZE * SIZE * 4);
  const lo = Math.floor((SIZE - side) / 2);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const inside = x >= lo && x < lo + side && y >= lo && y < lo + side;
      const [r, g, b] = inside ? paint(x, y) : [128, 128, 128];
      data.set([r, g, b, 255], (y * SIZE + x) * 4);
    }
  }
  return { width: SIZE, height: SIZE, data };
}

/** Grey 128 tile with a ragged spray of `side` px bbox: about 30% of the box is painted (a needle cut-out). */
function sprayTile(side: number): RgbaImage {
  const data = new Uint8Array(SIZE * SIZE * 4);
  const lo = Math.floor((SIZE - side) / 2);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const inside = x >= lo && x < lo + side && y >= lo && y < lo + side;
      const paint = inside && (x * 7 + y * 13) % 10 < 3;
      const [r, g, b] = paint ? colouredStone(x, y) : [128, 128, 128];
      data.set([r, g, b, 255], (y * SIZE + x) * 4);
    }
  }
  return { width: SIZE, height: SIZE, data };
}

/** Deterministic pseudo-noise in [-1, 1]. */
const noise = (x: number, y: number) => Math.sin(x * 12.9898 + y * 78.233) * 0.5 + Math.cos(x * 4.1 + y * 2.3) * 0.5;

const colouredStone = (x: number, y: number): [number, number, number] => {
  const n = noise(x, y) * 30;
  return [150 + n, 100 + n, 60 + n];
};

it("passes a normal coloured object", () => {
  const result = judgeRender(tile(60, colouredStone), { expectColoured: true });
  expect(result.verdict).toBe("ok");
  expect(result.reasons).toEqual([]);
  expect(result.stats.coverage).toBeCloseTo(0.36, 2);
  expect(result.stats.meanSaturation).toBeGreaterThan(0.3);
});

it("flags an object dominated by pure hues (region-mask vertex colours bound as albedo)", () => {
  // Green above, cyan below, shaded: what a MetaHuman face's RGB region mask looks like multiplied into a grey base colour.
  const mask = judgeRender(tile(60, (x, y) => {
    const shade = 140 + Math.round(noise(x, y) * 60);
    return y < 50 ? [0, shade, 0] : [0, shade, shade];
  }), { expectColoured: true });
  expect(mask.stats.pureHueFraction).toBeGreaterThan(0.9);
  expect(mask.verdict).toBe("suspect");
  expect(mask.reasons.join("\n")).toContain("pure hues");
  // Lit skin-like albedo is saturated but nowhere near pure.
  const skin = judgeRender(tile(60, (x, y) => [190 + noise(x, y) * 30, 130 + noise(x, y) * 25, 100 + noise(x, y) * 20]), { expectColoured: true });
  expect(skin.stats.pureHueFraction).toBe(0);
  expect(skin.verdict).toBe("ok");
  // One pure hue is a flat-colour material (a prototyping solid blue), not a mask.
  const solid = judgeRender(tile(60, (x, y) => [0, 0, 140 + Math.round(noise(x, y) * 60)]), { expectColoured: true });
  expect(solid.stats.pureHueRegions).toBe(1);
  expect(solid.verdict).toBe("ok");
});

it("flags a white object, and fails it when the report claims colour", () => {
  const white = tile(60, () => [255, 255, 255]);
  const plain = judgeRender(white);
  expect(plain.verdict).toBe("suspect");
  expect(plain.reasons[0]).toMatch(/^white/);
  const claimed = judgeRender(white, { expectColoured: true });
  expect(claimed.verdict).toBe("fail");
  expect(claimed.reasons).toContain("report claims coloured sections but render is white/neutral");
});

it("flags a uniform grey ghost, pale or barely off the background", () => {
  const pale = judgeRender(tile(60, (x, y) => [180 + noise(x, y), 180 + noise(x, y), 180 + noise(x, y)]));
  expect(pale.verdict).toBe("suspect");
  expect(pale.reasons[0]).toMatch(/^ghost/);
  const dim = judgeRender(tile(60, () => [116, 116, 116]));
  expect(dim.verdict).toBe("suspect");
  expect(dim.reasons[0]).toMatch(/^ghost/);
});

it("does not call a shaded neutral rock a ghost", () => {
  const rock = tile(60, (x, y) => {
    const v = 90 + noise(x, y) * 45 + (x > 50 ? 25 : 0);
    return [v, v, v];
  });
  expect(judgeRender(rock).verdict).toBe("ok");
});

it("fails a render where the report expects colour but it is neutral", () => {
  const grey = tile(60, (x, y) => [70 + noise(x, y) * 40, 70 + noise(x, y) * 40, 70 + noise(x, y) * 40]);
  expect(judgeRender(grey).verdict).toBe("ok");
  expect(judgeRender(grey, { expectColoured: true }).verdict).toBe("fail");
  // ...unless Unreal's own thumbnail has the same neutral colour: grey stone is real colour.
  expect(judgeRender(grey, { expectColoured: true, colourSimilarity: 0.46 }).verdict).toBe("ok");
  // A thumbnail that disagrees keeps it failing.
  expect(judgeRender(grey, { expectColoured: true, colourSimilarity: 0.1 }).verdict).toBe("fail");
});

it("only a strong thumbnail agreement excuses a white render", () => {
  const white = tile(60, () => [250, 250, 250]);
  expect(judgeRender(white, { expectColoured: true, colourSimilarity: 0.4 }).verdict).toBe("fail");
  expect(judgeRender(white, { expectColoured: true, colourSimilarity: 0.9 }).reasons.join()).not.toMatch(/report claims/);
});

it("flags specks: fail below 0.2% of the tile, suspect below the tiny threshold", () => {
  const speck = judgeRender(tile(4, colouredStone)); // 16 px of 10000 = 0.16%
  expect(speck.verdict).toBe("fail");
  expect(speck.reasons[0]).toMatch(/^degenerate/);
  const small = judgeRender(tile(8, colouredStone)); // 0.64%
  expect(small.stats.coverage).toBeLessThan(TINY_COVERAGE_FRACTION);
  expect(small.verdict).toBe("suspect");
  expect(small.reasons[0]).toMatch(/^speck/);
});

it("fails a blank tile", () => {
  const result = judgeRender(tile(0, colouredStone));
  expect(result.verdict).toBe("fail");
  expect(result.reasons[0]).toMatch(/^blank/);
  expect(result.stats.objectPixels).toBe(0);
});

it("marks a low colour similarity to the thumbnail as suspect and a high one as fine", () => {
  const image = tile(60, colouredStone);
  const low = judgeRender(image, { colourSimilarity: SUSPECT_COLOUR_SIMILARITY - 0.01 });
  expect(low.verdict).toBe("suspect");
  expect(low.reasons[0]).toContain("colour similarity");
  expect(judgeRender(image, { colourSimilarity: SUSPECT_COLOUR_SIMILARITY }).verdict).toBe("ok");
  expect(judgeRender(image, { colourSimilarity: 0.8 }).verdict).toBe("ok");
});

it("honours a custom background", () => {
  const data = new Uint8Array(SIZE * SIZE * 4).fill(255);
  const white = judgeRender({ width: SIZE, height: SIZE, data }, { background: { r: 255, g: 255, b: 255 } });
  expect(white.verdict).toBe("fail");
  expect(white.reasons[0]).toMatch(/^blank/);
});

it("measures fill ratio: a solid square fills its bounding box, a sparse spray does not", () => {
  const solid = judgeRender(tile(60, colouredStone));
  expect(solid.stats.fillRatio).toBeCloseTo(1, 1);
  const spray = judgeRender(sprayTile(60));
  expect(spray.stats.fillRatio).toBeLessThan(0.6);
  expect(spray.stats.objectPixels).toBeGreaterThan(200);
});

it("flags a solid card when its fill ratio dwarfs the thumbnail's cut-out", () => {
  const solid = judgeRender(tile(60, colouredStone), { thumbnailFillRatio: 0.3, thumbnailObjectPixels: 5000 });
  expect(solid.verdict).toBe("suspect");
  expect(solid.reasons.join(" ")).toContain("solid card: render fill");
});

it("does not flag a render whose fill matches the thumbnail's", () => {
  const card = judgeRender(sprayTile(60), { thumbnailFillRatio: 0.3, thumbnailObjectPixels: 5000 });
  expect(card.reasons.join(" ")).not.toContain("solid card");
  // A legitimately dense real card stays below the factor.
  const dense = judgeRender(tile(60, colouredStone), { thumbnailFillRatio: 0.7, thumbnailObjectPixels: 5000 });
  expect(dense.stats.fillRatio).toBeLessThan(0.7 * SOLID_CARD_FILL_FACTOR);
  expect(dense.reasons.join(" ")).not.toContain("solid card");
});

it("ignores the silhouette rule when either mask has too few pixels, or there is no thumbnail", () => {
  const tinyRender = judgeRender(tile(8, colouredStone), { thumbnailFillRatio: 0.1, thumbnailObjectPixels: 5000 });
  expect(tinyRender.reasons.join(" ")).not.toContain("solid card");
  const tinyThumbnail = judgeRender(tile(60, colouredStone), { thumbnailFillRatio: 0.3, thumbnailObjectPixels: 50 });
  expect(tinyThumbnail.reasons.join(" ")).not.toContain("solid card");
  expect(judgeRender(tile(60, colouredStone)).reasons.join(" ")).not.toContain("solid card");
});
