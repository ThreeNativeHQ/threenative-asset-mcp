import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { edgeBandMask, occlusionBandMask } from "../src/texture-projection/app/core/silhouette.js";
import {
  EDGE_MISALIGNMENT_LIMIT,
  SILHOUETTE_MISMATCH_LIMIT,
  STRUCTURE_DEVIATION_LIMIT,
  edgeMisalignment,
  rejectsStructure,
  rejectsViewScores,
  silhouetteMismatch,
  skySolidShare,
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
const SILHOUETTE_FIXTURES = join(REPO, "tests", "fixtures", "prd916-silhouette");

interface Sheet {
  readonly data: Buffer;
  readonly width: number;
}

interface Layout {
  readonly tile: number;
  readonly real: { readonly columns: number; readonly rows: number; readonly views: number };
  readonly inventions: readonly { readonly index: number; readonly kind: string; readonly sourceView: number }[];
}

async function readSheet(name: string, directory = FIXTURES): Promise<Sheet> {
  const { data, info } = await sharp(join(directory, name)).greyscale().raw().toBuffer({ resolveWithObject: true });
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

/**
 * Phase 2g on the paid run `courtyard-mwuijnnl` (40 views: 34 ground, 6 aerial). The labels were
 * settled on the pixels: 13 of them paint brick, stone or cobbles over the background the clay left
 * empty — a wall top raised over it, a coping, a floor where the level has no ground — and 27 keep it.
 * Views 22, 30 and 36 are the reason a quick look at the generation reads them as clean: they keep
 * part of the sky in frame.
 */
describe("texture-projection silhouette check: solid surface painted over the clay's sky (phase 2g)", () => {
  const PAINTS_OVER_SKY = [11, 13, 14, 17, 18, 20, 22, 24, 30, 31, 33, 36, 37];

  it("rejects the 13 views that paint over the sky and accepts the other 27", async () => {
    const layout = JSON.parse(await readFile(join(SILHOUETTE_FIXTURES, "layout.json"), "utf8")) as {
      readonly tile: number;
      readonly columns: number;
      readonly views: number;
      readonly cells: number;
    };
    const { tile, cells } = layout;
    const generations = await readSheet("gen.png", SILHOUETTE_FIXTURES);
    const clays = await readSheet("clay.png", SILHOUETTE_FIXTURES);
    const masks = await readSheet("geometry-cells.png", SILHOUETTE_FIXTURES);

    const scores: number[] = [];
    for (let index = 0; index < layout.views; index++) {
      scores.push(
        silhouetteMismatch(
          tileOf(generations, tile, layout.columns, index),
          tileOf(clays, tile, layout.columns, index),
          maskOf(masks, tile, layout.columns, index, cells),
          tile,
          tile,
          cells,
        ),
      );
    }

    const rejected = scores
      .map((score, index) => (score > SILHOUETTE_MISMATCH_LIMIT ? index : -1))
      .filter((index) => index >= 0);
    expect(rejected).toEqual(PAINTS_OVER_SKY);
    // And the 27 that keep the sky are accepted with room to spare, not merely under the limit.
    const accepted = scores.filter((_score, index) => !PAINTS_OVER_SKY.includes(index));
    const maxAccepted = Math.max(...accepted);
    const minRejected = Math.min(...PAINTS_OVER_SKY.map((index) => scores[index]!));
    expect(maxAccepted).toBeLessThan(SILHOUETTE_MISMATCH_LIMIT * 0.75);
    // The margin the limit sits in: 3.3x between the strongest clean view and the weakest rejected one.
    expect(minRejected / maxAccepted).toBeGreaterThan(3);
    expect(SILHOUETTE_MISMATCH_LIMIT / maxAccepted).toBeGreaterThan(1.4);
    expect(minRejected / SILHOUETTE_MISMATCH_LIMIT).toBeGreaterThan(2);
  });
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

describe("the far side of an occlusion edge is left out of the projection (phase 2x)", () => {
  const W = 64;
  const H = 64;
  /** Wall at 10 m everywhere, a box at 3 m over its middle: a foreground silhouette on a background. */
  const boxOnWall = () => {
    const pos = new Float32Array(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        pos[4 * i] = x * 0.1;
        pos[4 * i + 1] = y * 0.1;
        pos[4 * i + 2] = -10;
        pos[4 * i + 3] = x >= 24 && x < 40 && y >= 24 && y < 40 ? 3 : 10;
      }
    }
    return pos;
  };

  it("masks the wall within the band beside the box, and neither the box nor the wall away from it", () => {
    const pos = boxOnWall();
    const mask = occlusionBandMask(pos, W, H, 4);
    // The four sides of the background: the band is the wall's pixels right beside the box.
    for (let at = 26; at < 38; at += 3) {
      expect(mask[at * W + 20]).toBe(1); // 4 px left of the box
      expect(mask[at * W + 43]).toBe(1); // 4 px right of it
      expect(mask[20 * W + at]).toBe(1); // 4 px above it
      expect(mask[43 * W + at]).toBe(1); // 4 px below it
      expect(mask[at * W + 19]).toBe(0); // 5 px away: the wall's own stone
      expect(mask[at * W + 44]).toBe(0);
      expect(mask[19 * W + at]).toBe(0);
      expect(mask[44 * W + at]).toBe(0);
    }
    // The box keeps every one of its own pixels: the painter drew it where the clay has it.
    for (let y = 24; y < 40; y++) {
      for (let x = 24; x < 40; x++) expect(mask[y * W + x]).toBe(0);
    }
    // And the wall away from the silhouette is untouched.
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) expect(mask[y * W + x]).toBe(0);
  });

  it("leaves a surface whose distance only climbs with the frame — a wall at a grazing angle — alone", () => {
    // 3 % per pixel, under the 4 % jump that makes a discontinuity: no seed anywhere, no band.
    const pos = new Float32Array(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) pos[4 * (y * W + x) + 3] = 10 + 0.3 * x;
    }
    const mask = occlusionBandMask(pos, W, H, 4);
    expect(mask.some((value) => value)).toBe(false);
  });

  it("seeds no band from the sky: only the wall beside a foreground surface is masked", () => {
    // Sky (distance 0) above row 20: a wall running out of frame into the sky is not an occlusion edge,
    // because nothing is painted over the sky in the first place.
    const pos = boxOnWall();
    for (let y = 0; y < 20; y++) for (let x = 0; x < W; x++) pos[4 * (y * W + x) + 3] = 0;
    const mask = occlusionBandMask(pos, W, H, 4);
    // Columns left and right of the box: the wall right under the sky keeps its stone.
    for (let x = 0; x < 20; x++) expect(mask[20 * W + x]).toBe(0), expect(mask[23 * W + x]).toBe(0);
    for (let x = 45; x < W; x++) expect(mask[20 * W + x]).toBe(0), expect(mask[23 * W + x]).toBe(0);
    expect(mask[19 * W + 8]).toBe(0);
  });
});

describe("silhouette gate decision (rejectsViewScores)", () => {
  const N = 128;

  it("accepts sky-only silhouette shifts <= 0.85 when geometry stays aligned, and rejects hijack or paired misalignment", () => {
    const geometry = new Uint8Array(N * N);
    const state = new Uint8ClampedArray(N * N * 4);
    for (let y = 0; y < N; y++) {
      const isWall = y >= N / 2;
      for (let x = 0; x < N; x++) {
        const i = y * N + x;
        geometry[i] = isWall ? 1 : 0;
        const p = 4 * i;
        state[p] = state[p + 1] = state[p + 2] = 180;
        state[p + 3] = 255;
      }
    }

    // Case 1: half of sky changes luminance (silhouette ~0.5 > 0.20), wall stays aligned -> accepted.
    const genSkyOnly = new Uint8ClampedArray(state);
    for (let y = 0; y < N / 4; y++) {
      for (let x = 0; x < N; x++) {
        const k = 4 * (y * N + x);
        genSkyOnly[k] = genSkyOnly[k + 1] = genSkyOnly[k + 2] = 90;
      }
    }
    const sil1 = silhouetteMismatch(genSkyOnly, state, geometry, N, N);
    const dev1 = structureDeviation(genSkyOnly, state, N, N, undefined, geometry);
    const edge1 = edgeMisalignment(genSkyOnly, state, geometry, N, N).score;
    expect(sil1).toBeGreaterThan(SILHOUETTE_MISMATCH_LIMIT);
    expect(sil1).toBeLessThanOrEqual(0.85);
    expect(rejectsViewScores(dev1, sil1, edge1)).toBe(false);

    // Case 2: full-sky hijack (> 0.85) -> rejected.
    const genHijack = new Uint8ClampedArray(state);
    for (let y = 0; y < N / 2; y++) {
      for (let x = 0; x < N; x++) {
        const k = 4 * (y * N + x);
        genHijack[k] = genHijack[k + 1] = genHijack[k + 2] = 60;
      }
    }
    const sil2 = silhouetteMismatch(genHijack, state, geometry, N, N);
    expect(sil2).toBeGreaterThan(0.85);
    expect(rejectsViewScores(0, sil2, 0)).toBe(true);

    // Case 3: moderate sky shift paired with a sharp drawn edge step inside the wall -> rejected.
    const genPaired = new Uint8ClampedArray(genSkyOnly);
    for (let y = N / 2; y < N; y++) {
      for (let x = N / 2; x < N; x++) {
        const k = 4 * (y * N + x);
        genPaired[k] = genPaired[k + 1] = genPaired[k + 2] = 70;
      }
    }
    const edge3 = edgeMisalignment(genPaired, state, geometry, N, N).score;
    expect(edge3).toBeGreaterThan(0.1);
    expect(rejectsViewScores(0, sil1, edge3)).toBe(true);
    expect(rejectsViewScores(0, 0.1, EDGE_MISALIGNMENT_LIMIT + 0.01)).toBe(true);
  });

  it("allows uniform bright overcast sky shifts via skySolidShare while rejecting dark or textured sky intrusions", () => {
    const geometry = new Uint8Array(N * N);
    const clay = new Uint8ClampedArray(N * N * 4);
    for (let y = 0; y < N; y++) {
      const isWall = y >= N / 2;
      for (let x = 0; x < N; x++) {
        const i = y * N + x;
        geometry[i] = isWall ? 1 : 0;
        const p = 4 * i;
        clay[p] = clay[p + 1] = clay[p + 2] = 170;
        clay[p + 3] = 255;
      }
    }

    // Smooth overcast white/bright sky across all sky cells: silhouetteMismatch = 1.0, skySolid = 0.0 -> accepted.
    const genSmoothBrightSky = new Uint8ClampedArray(clay);
    for (let y = 0; y < N / 2; y++) {
      for (let x = 0; x < N; x++) {
        const p = 4 * (y * N + x);
        genSmoothBrightSky[p] = genSmoothBrightSky[p + 1] = genSmoothBrightSky[p + 2] = 242;
      }
    }
    const silSmooth = silhouetteMismatch(genSmoothBrightSky, clay, geometry, N, N);
    const skySolidSmooth = skySolidShare(genSmoothBrightSky, geometry, N, N);
    expect(silSmooth).toBeGreaterThan(0.85);
    expect(skySolidSmooth).toBe(0);
    expect(rejectsViewScores(0, silSmooth, 0, skySolidSmooth)).toBe(false);

    // Dark solid wall over sky: skySolid > 0.50 -> rejected.
    const genDarkWall = new Uint8ClampedArray(clay);
    for (let y = 0; y < N / 2; y++) {
      for (let x = 0; x < N; x++) {
        const p = 4 * (y * N + x);
        genDarkWall[p] = genDarkWall[p + 1] = genDarkWall[p + 2] = 60;
      }
    }
    const skySolidDark = skySolidShare(genDarkWall, geometry, N, N);
    expect(skySolidDark).toBeGreaterThan(0.5);
    expect(rejectsViewScores(0, silSmooth, 0, skySolidDark)).toBe(true);
  });
});
