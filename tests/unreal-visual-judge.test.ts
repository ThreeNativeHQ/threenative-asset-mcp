import { expect, it } from "vitest";

import type { RgbaImage } from "../src/unreal/image-diff.js";
import {
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

it("a thumbnail never excuses a white render", () => {
  const white = tile(60, () => [250, 250, 250]);
  expect(judgeRender(white, { expectColoured: true, colourSimilarity: 0.9 }).verdict).toBe("fail");
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
