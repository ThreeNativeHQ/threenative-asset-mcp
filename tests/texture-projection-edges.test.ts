import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { EDGE_MISALIGNMENT_LIMIT, edgeMisalignment } from "../src/texture-projection/app/core/structure.js";

/**
 * Phase 2q: a painter draws a body for the corner pillar it sees, and when it draws that pillar
 * *shifted* the projection puts its pixels on the flat wall behind it — a ghost "leaning slab" on that
 * wall, which neither the structure check (a closed blob) nor the silhouette check (paint over sky)
 * sees. These are the two guards: the synthetic one pins the rule, the fixture one pins the rule
 * against the 40 real views of the paid run `courtyard-mwuijnnl`.
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(REPO, "tests", "fixtures", "prd916-edges");

const SIZE = 256;
const WALL = 0.5;
const PILLAR = 0.72;

/**
 * A frame of one flat wall with a vertical pillar on it: `edges(y)` gives the pillar's two x
 * positions as fractions of the width. A pillar edge is a hard 0.22 luminance step at pixel scale, which
 * is what the clay render of a face boundary is.
 */
function frame(edges: (y: number) => readonly [number, number]): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    const span = edges(y);
    const from = Math.round(span[0] * SIZE);
    const to = Math.round(span[1] * SIZE);
    for (let x = 0; x < SIZE; x++) {
      const level = Math.round(255 * (x >= from && x < to ? PILLAR : WALL));
      const p = 4 * (y * SIZE + x);
      rgba[p] = level;
      rgba[p + 1] = level;
      rgba[p + 2] = level;
      rgba[p + 3] = 255;
    }
  }
  return rgba;
}

/** The same pillar, shifted left by 6 % of the width and tilted by 5 % across the frame's height. */
const shifted = (y: number, shift = 0.06, tilt = 0.05) => {
  const left = 0.36 - shift + (tilt * y) / SIZE;
  return [left, left + 0.14] as const;
};

const allGeometry = new Uint8Array(SIZE * SIZE).fill(1);

/** The columns of `band` that hold at least one projected pixel. */
function bandColumns(band: Uint8Array): number[] {
  const columns = new Set<number>();
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) if (band[y * SIZE + x]) columns.add(x);
  }
  return [...columns].sort((a, b) => a - b);
}

describe("painted edges the clay does not have (phase 2q)", () => {
  const clay = frame(() => [0.36, 0.5]);

  it("leaves a painting that keeps the pillar where the clay has it", () => {
    const aligned = frame(() => [0.36, 0.5]);
    const { score, band, strong, misaligned } = edgeMisalignment(aligned, clay, allGeometry, SIZE, SIZE);
    expect(strong).toBeGreaterThan(0); // the pillar's two edges were found and are strong
    expect(misaligned).toBe(0);
    expect(score).toBe(0);
    expect(band.some((value) => value)).toBe(false);
  });

  it("masks the shifted, tilted pillar edge and not the clay's own", () => {
    const invented = frame(shifted);
    const { score, band, misaligned } = edgeMisalignment(invented, clay, allGeometry, SIZE, SIZE);
    expect(score).toBeGreaterThan(EDGE_MISALIGNMENT_LIMIT);
    expect(misaligned).toBeGreaterThan(0);
    const columns = bandColumns(band);
    expect(columns.length).toBeGreaterThan(0);
    // The strip sits on the painted edge (0.30 of the width at the top, drifting to 0.35 at the bottom),
    // and the clay's own edge at 0.36-0.50 is left out of it.
    const paintedLeft = Math.round(0.3 * SIZE);
    expect(columns.some((x) => Math.abs(x - paintedLeft) <= 4)).toBe(true);
    const clayLeft = Math.round(0.36 * SIZE);
    const clayRight = Math.round(0.5 * SIZE);
    // The band may touch the clay's edge range at the bottom of the tilt, never at the top.
    expect(band[8 * SIZE + clayRight - 2]).toBe(0);
    expect(band[8 * SIZE + clayLeft - 2]).toBe(0);
  });

  it("needs geometry: nothing is masked over the sky, and a void view has no edge to judge", () => {
    const invented = frame(shifted);
    const sky = new Uint8Array(SIZE * SIZE);
    const overSky = edgeMisalignment(invented, clay, sky, SIZE, SIZE);
    expect(overSky.score).toBe(0);
    expect(overSky.band.some((value) => value)).toBe(false);
  });
});

/**
 * The 40 real views, as 256 px copies of the generations, the clays and the clays' geometry masks. The
 * run itself (40 x 2048 px frames, licensed-model spend) is not in the repo. The pixel-level geometry
 * mask is the clay render's exact clear colour, as in the silhouette fixtures; the run did not store the
 * geometry buffer.
 */
describe("texture-projection edge check on the paid courtyard run (phase 2q)", () => {
  /** The 16 views the pipeline projects; 4 and 27 are rejected by the vision check, not by pixels. */
  const ACCEPTED = [0, 1, 2, 3, 5, 6, 7, 8, 9, 10, 15, 16, 19, 29, 38, 39];
  /** An object the painter invented or shifted: a niche, a stele, a wall raised over the sky, a ridge. */
  const INVENTED = [12, 23, 24, 32, 37];

  interface Sheet {
    readonly data: Buffer;
    readonly width: number;
  }

  async function readSheet(name: string): Promise<Sheet> {
    const { data, info } = await sharp(join(FIXTURES, name)).greyscale().raw().toBuffer({ resolveWithObject: true });
    return { data, width: info.width };
  }

  /** One tile of a sheet as top-down RGBA8, the shape the painter hands the check. */
  function tileOf(sheet: Sheet, tile: number, columns: number, index: number): Uint8ClampedArray {
    const x0 = (index % columns) * tile;
    const y0 = Math.floor(index / columns) * tile;
    const rgba = new Uint8ClampedArray(tile * tile * 4);
    for (let y = 0; y < tile; y++) {
      for (let x = 0; x < tile; x++) {
        const value = sheet.data[(y0 + y) * sheet.width + x0 + x]!;
        const p = 4 * (y * tile + x);
        rgba[p] = value;
        rgba[p + 1] = value;
        rgba[p + 2] = value;
        rgba[p + 3] = 255;
      }
    }
    return rgba;
  }

  function maskOf(sheet: Sheet, tile: number, columns: number, index: number): Uint8Array {
    const x0 = (index % columns) * tile;
    const y0 = Math.floor(index / columns) * tile;
    const mask = new Uint8Array(tile * tile);
    for (let y = 0; y < tile; y++) {
      for (let x = 0; x < tile; x++) {
        mask[y * tile + x] = sheet.data[(y0 + y) * sheet.width + x0 + x]! > 127 ? 1 : 0;
      }
    }
    return mask;
  }

  it("rejects the invented objects and keeps every accepted view whole", async () => {
    const layout = JSON.parse(await readFile(join(FIXTURES, "layout.json"), "utf8")) as {
      readonly tile: number;
      readonly columns: number;
      readonly views: number;
    };
    const { tile, columns } = layout;
    const generations = await readSheet("gen.png");
    const clays = await readSheet("clay.png");
    const masks = await readSheet("geometry.png");

    const scores: number[] = [];
    const bandShares: number[] = [];
    for (let index = 0; index < layout.views; index++) {
      const geometry = maskOf(masks, tile, columns, index);
      const result = edgeMisalignment(
        tileOf(generations, tile, columns, index),
        tileOf(clays, tile, columns, index),
        geometry,
        tile,
        tile,
      );
      let band = 0;
      let level = 0;
      for (let i = 0; i < geometry.length; i++) {
        if (geometry[i]) level += 1;
        if (result.band[i]) band += 1;
      }
      scores.push(result.score);
      bandShares.push(band / Math.max(1, level));
    }

    const rejected = scores.map((score, index) => (score > EDGE_MISALIGNMENT_LIMIT ? index : -1)).filter((i) => i >= 0);
    for (const index of INVENTED) expect(rejected, `view ${index} scored ${scores[index]!.toFixed(3)}`).toContain(index);
    // The 16 views the pipeline projects are not rejected and keep their whole area: the strip never
    // lands on a real wall.
    for (const index of ACCEPTED) {
      expect(scores[index], `accepted view ${index}`).toBe(0);
      expect(bandShares[index], `accepted view ${index}`).toBe(0);
    }
    // The margin the limit sits in: the weakest invented view is 1.5x above it, an accepted one is 0.
    const weakest = Math.min(...INVENTED.map((index) => scores[index]!));
    expect(weakest).toBeGreaterThan(EDGE_MISALIGNMENT_LIMIT * 1.5);
  }, 30_000);
});
