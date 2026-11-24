import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { edgeBandMask } from "../src/texture-projection/app/core/silhouette.js";
import {
  STRUCTURE_DEVIATION_LIMIT,
  rejectsStructure,
  structureDeviation,
} from "../src/texture-projection/app/core/structure.js";

/**
 * B.2 calibrated on the real thing, not on stubs.
 *
 * The fixtures are 128 px copies of the 60 views of the paid courtyard run `courtyard-mwubecio`
 * (FLUX 3 Klein through texture_project_paint, $0.54, 2048 px): the generation, the clay it was
 * given, and the clay's geometry mask (sky excluded). The run itself stays out of the repo: only
 * downscaled, name-free pixels travel. The second pair of sheets is four inventions pasted into
 * four of those real generations — a dark arched doorway, a dark window, a passage/void and an
 * added box — so the check is measured against what the model really produced, not against
 * synthetic drawings. See the README next to the sheets for the provenance and the numbers.
 */

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(REPO, "tests", "fixtures", "prd916-structure");

interface Sheet {
  readonly data: Buffer;
  readonly width: number;
}

interface Layout {
  readonly tile: number;
  readonly real: { readonly columns: number; readonly rows: number; readonly views: number };
  readonly inventions: readonly { readonly index: number; readonly kind: string; readonly sourceView: number }[];
}

async function readSheet(name: string): Promise<Sheet> {
  const { data, info } = await sharp(join(FIXTURES, name)).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width };
}

/** One tile of a sheet as top-down RGBA8 (the shape the painter hands the check). */
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

/**
 * The stored geometry mask is kept at the check's own 64-cell resolution (computed from the run's
 * 2048 px clay), then expanded to the tile's pixels: the fixtures pin the production mask decisions,
 * and a coarse per-pixel mask would not (a boundary cell can flip and hide a shadow band).
 */
function maskOf(cellSheet: Sheet, tile: number, columns: number, index: number, cells: number): Uint8Array {
  const x0 = (index % columns) * cells;
  const y0 = Math.floor(index / columns) * cells;
  const scale = tile / cells;
  const mask = new Uint8Array(tile * tile);
  for (let y = 0; y < tile; y++) {
    for (let x = 0; x < tile; x++) {
      const value = cellSheet.data[(y0 + Math.floor(y / scale)) * cellSheet.width + x0 + Math.floor(x / scale)]!;
      mask[y * tile + x] = value > 127 ? 1 : 0;
    }
  }
  return mask;
}

describe("texture-projection structure check on the paid courtyard run (B.2)", () => {
  it(
    "accepts all 60 real views and rejects every invention pasted into them",
    async () => {
      const layout = JSON.parse(await readFile(join(FIXTURES, "layout.json"), "utf8")) as Layout;
      const { tile } = layout;
      const generations = await readSheet("real-gen.png");
      const clays = await readSheet("real-clay.png");
      const masks = await readSheet("real-geometry-cells.png");

      const accepted: number[] = [];
      for (let index = 0; index < layout.real.views; index++) {
        const score = structureDeviation(
          tileOf(generations, tile, layout.real.columns, index),
          tileOf(clays, tile, layout.real.columns, index),
          tile,
          tile,
          64,
          maskOf(masks, tile, layout.real.columns, index, 64),
        );
        accepted.push(score);
        // A real painting that follows its clay geometry is never a rejection, whatever material it wears.
        expect(rejectsStructure(score), `real view ${index} scored ${score.toFixed(3)}`).toBe(false);
      }

      const inventionGenerations = await readSheet("inventions-gen.png");
      const inventionClays = await readSheet("inventions-clay.png");
      const rejected: { kind: string; score: number }[] = [];
      for (const invention of layout.inventions) {
        const score = structureDeviation(
          tileOf(inventionGenerations, tile, layout.inventions.length, invention.index),
          tileOf(inventionClays, tile, layout.inventions.length, invention.index),
          tile,
          tile,
          64,
        );
        rejected.push({ kind: invention.kind, score });
        expect(rejectsStructure(score), `${invention.kind} scored ${score.toFixed(3)}`).toBe(true);
      }

      const maxAccepted = Math.max(...accepted);
      const minRejected = Math.min(...rejected.map((entry) => entry.score));
      // The margin the limit sits in: every invention scores at least twice the strongest real view.
      expect(minRejected / maxAccepted).toBeGreaterThan(2);
      // The strongest real view is real material at a wall corner, not an opening: well under the limit.
      expect(maxAccepted).toBeLessThan(STRUCTURE_DEVIATION_LIMIT * 0.5);
      // And the weakest invention is above it with room to spare.
      expect(minRejected).toBeGreaterThan(STRUCTURE_DEVIATION_LIMIT * 1.2);
    },
    60_000,
  );
});

describe("the strip along a view's clay edges is left out of the projection (phase 2e)", () => {
  const W = 16;
  const H = 16;
  /** A view of one flat wall filling the frame (normal -Z), `metresPerPixel` at every pixel. */
  const wallGeometry = (skyAbove = 0, metresPerPixel = 0.1) => {
    const pos = new Float32Array(W * H * 4);
    const nrm = new Float32Array(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        pos[4 * i] = x * metresPerPixel;
        pos[4 * i + 1] = (H - y) * metresPerPixel;
        pos[4 * i + 2] = -10;
        pos[4 * i + 3] = 10;
        nrm[4 * i + 1] = 0;
        nrm[4 * i + 2] = 1;
        nrm[4 * i + 3] = y >= skyAbove ? 1 : 0; // the columns above `skyAbove` are sky
      }
    }
    return { pos, nrm };
  };

  it("masks the wall under its top edge and leaves the wall below it alone", () => {
    // Sky above row 2, then wall: a 0.4 m strip is 4 pixels of 0.1 m at a constant depth.
    const { pos, nrm } = wallGeometry(2);
    const mask = edgeBandMask(pos, nrm, W, H, 0.4);
    for (let x = 0; x < W; x++) {
      expect(mask[2 * W + x]).toBe(1); // the edge pixel itself
      expect(mask[5 * W + x]).toBe(1); // 0.3 m below it: still the cap's strip
      expect(mask[3 * W + x]).toBe(1);
      expect(mask[10 * W + x]).toBe(0); // 0.8 m below the edge: the wall's own stone courses
      expect(mask[15 * W + x]).toBe(0);
    }
  });

  it("never masks a floor, and never masks a wall away from an edge", () => {
    const { pos, nrm } = wallGeometry(2);
    const floor = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) {
      nrm[4 * i + 1] = 1;
      nrm[4 * i + 2] = 0;
      floor[i] = edgeBandMask(pos, nrm, W, H, 0.4)[i]!;
    }
    expect(floor.some((value) => value)).toBe(false);
  });

  it("masks a wall that ends under a farther one (the corner both painters give a face)", () => {
    // The right half is a wall 2 m nearer than the left half: the nearer wall's edge between them
    // gets the strip, on the nearer side only.
    const { pos, nrm } = wallGeometry(0);
    for (let y = 0; y < H; y++) {
      for (let x = 8; x < W; x++) {
        const i = y * W + x;
        pos[4 * i + 3] = 7;
      }
    }
    const mask = edgeBandMask(pos, nrm, W, H, 0.4);
    for (let y = 0; y < H; y++) {
      expect(mask[y * W + 8]).toBe(1);
      expect(mask[y * W + 11]).toBe(1); // 0.3 m into the nearer wall
      expect(mask[y * W + 7]).toBe(0); // the farther wall keeps its stone
      expect(mask[y * W + 15]).toBe(0);
    }
  });
});
