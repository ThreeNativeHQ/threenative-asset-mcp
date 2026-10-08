import type { RgbaImage } from "./image-diff.js";

/** A thumbnail present and colour similarity below this makes the verdict `suspect`. */
export const SUSPECT_COLOUR_SIMILARITY = 0.35;
/** An object covering less of the tile than this is a speck, not a render of the piece. */
export const MIN_OBJECT_COVERAGE_FRACTION = 0.002;
/** Share of object pixels that must be near-white (all channels above 235) to call a render white. */
export const WHITE_FRACTION = 0.85;
/** Share of object pixels that must be near-neutral (channel spread under 12) to call it neutral. */
export const NEUTRAL_FRACTION = 0.9;
/**
 * An object this much of the tile is a speck; below `MIN_OBJECT_COVERAGE_FRACTION` it is a fail, below
 * this it is suspect. A piece is framed to fill its tile, so a healthy one covers several percent; the
 * smallest healthy pieces seen (thin stalactites, waterfalls) cover about 4%.
 */
export const TINY_COVERAGE_FRACTION = 0.01;
/**
 * A ghost: a near-neutral object with luma standard deviation below `GHOST_MAX_STDDEV` (flat, no
 * shading) that is either pale (mean luma above `GHOST_MIN_LIGHTNESS`) or sits within
 * `GHOST_BACKGROUND_LUMA_BAND` of the background luma, so it barely stands out from the tile.
 */
export const GHOST_MIN_LIGHTNESS = 150;
export const GHOST_MAX_STDDEV = 12;
export const GHOST_BACKGROUND_LUMA_BAND = 40;
/** A near-neutral object brighter than this mean luma is washed out even if not near-white everywhere. */
export const WASHED_OUT_LUMA = 200;
const NEAR_WHITE = 235;
const NEUTRAL_SPREAD = 12;
/** Colour distance from the tile background above which a pixel is object. */
const BACKGROUND_TOLERANCE = 6;

export type Verdict = "ok" | "suspect" | "fail";

export interface JudgeStats {
  tilePixels: number;
  objectPixels: number;
  /** objectPixels / tilePixels. */
  coverage: number;
  nearWhiteFraction: number;
  neutralFraction: number;
  /** Mean HSV saturation of the object pixels, 0..1. */
  meanSaturation: number;
  meanLuma: number;
  lumaStdDev: number;
}

export interface JudgeResult {
  verdict: Verdict;
  reasons: string[];
  stats: JudgeStats;
}

export interface JudgeOptions {
  /** The report says the piece has coloured or textured sections. */
  expectColoured?: boolean;
  /** Tile background; default is the contact sheet's mid grey. */
  background?: { r: number; g: number; b: number };
  /** Colour similarity (0..1) to the Unreal thumbnail, when there is one and it is comparable. */
  colourSimilarity?: number;
}

const RANK: Record<Verdict, number> = { ok: 0, suspect: 1, fail: 2 };

/**
 * Judges one rendered tile without a reference: is there an object, is it a speck, is it white, is it
 * a uniform pale ghost, is it colourless where the import report says it is coloured. Pure over pixels.
 */
export function judgeRender(image: RgbaImage, options: JudgeOptions = {}): JudgeResult {
  const background = options.background ?? { r: 128, g: 128, b: 128 };
  const tilePixels = image.width * image.height;
  let objectPixels = 0;
  let white = 0;
  let neutral = 0;
  let saturation = 0;
  let luma = 0;
  let lumaSquares = 0;
  for (let i = 0; i < tilePixels; i++) {
    const o = i * 4;
    const r = image.data[o]!;
    const g = image.data[o + 1]!;
    const b = image.data[o + 2]!;
    if (
      Math.abs(r - background.r) <= BACKGROUND_TOLERANCE &&
      Math.abs(g - background.g) <= BACKGROUND_TOLERANCE &&
      Math.abs(b - background.b) <= BACKGROUND_TOLERANCE
    ) {
      continue;
    }
    objectPixels++;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (min > NEAR_WHITE) white++;
    if (max - min < NEUTRAL_SPREAD) neutral++;
    saturation += max === 0 ? 0 : (max - min) / max;
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    luma += y;
    lumaSquares += y * y;
  }
  const n = Math.max(1, objectPixels);
  const meanLuma = luma / n;
  const stats: JudgeStats = {
    tilePixels,
    objectPixels,
    coverage: objectPixels / Math.max(1, tilePixels),
    nearWhiteFraction: white / n,
    neutralFraction: neutral / n,
    meanSaturation: saturation / n,
    meanLuma,
    lumaStdDev: Math.sqrt(Math.max(0, lumaSquares / n - meanLuma * meanLuma)),
  };

  let verdict: Verdict = "ok";
  const reasons: string[] = [];
  const raise = (level: Verdict, reason: string): void => {
    if (RANK[level] > RANK[verdict]) verdict = level;
    reasons.push(reason);
  };

  if (objectPixels === 0) {
    raise("fail", "blank: nothing drawn");
    return { verdict, reasons, stats };
  }
  if (stats.coverage < MIN_OBJECT_COVERAGE_FRACTION) {
    raise("fail", `degenerate: object covers ${(stats.coverage * 100).toFixed(2)}% of the tile`);
    return { verdict, reasons, stats };
  }
  const isWhite = stats.nearWhiteFraction > WHITE_FRACTION;
  const backgroundLuma = 0.299 * background.r + 0.587 * background.g + 0.114 * background.b;
  const isNeutral = stats.neutralFraction > NEUTRAL_FRACTION;
  const isGhost =
    isNeutral &&
    stats.lumaStdDev < GHOST_MAX_STDDEV &&
    (stats.meanLuma > GHOST_MIN_LIGHTNESS || Math.abs(stats.meanLuma - backgroundLuma) < GHOST_BACKGROUND_LUMA_BAND);
  const isWashedOut = isNeutral && stats.meanLuma > WASHED_OUT_LUMA;
  if (stats.coverage < TINY_COVERAGE_FRACTION) {
    raise("suspect", `speck: object covers only ${(stats.coverage * 100).toFixed(2)}% of the tile`);
  }
  if (isWhite) raise("suspect", `white: ${(stats.nearWhiteFraction * 100).toFixed(0)}% of object pixels are near-white`);
  else if (isGhost) raise("suspect", "ghost: uniform grey object with no shading, pale or close to the background");
  else if (isWashedOut) raise("suspect", "washed out: near-neutral and very bright");
  if (options.expectColoured === true && (isWhite || isGhost || isWashedOut || isNeutral)) {
    raise("fail", "report claims coloured sections but render is white/neutral");
  }
  if (options.colourSimilarity !== undefined && options.colourSimilarity < SUSPECT_COLOUR_SIMILARITY) {
    raise("suspect", `colour similarity ${options.colourSimilarity.toFixed(2)} below ${SUSPECT_COLOUR_SIMILARITY}`);
  }
  return { verdict, reasons, stats };
}
