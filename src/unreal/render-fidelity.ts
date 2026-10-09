/**
 * Objective fidelity of one rendered piece against Unreal's own thumbnail of it (PRD-537 visual judge).
 *
 * The thumbnail is lit, on a checkered floor, from another camera; our render is neutral-lit on flat grey.
 * So raw brightness and pixel metrics say nothing. What survives the change of lighting and camera:
 *   - hue (which colour the foliage/paint is), weighted by chroma so grey pixels do not add noise;
 *   - saturation, measured as chroma per unit lightness (chroma per lightness), which a lighting change barely moves;
 *   - the silhouette's fill of its bounding box (sparse needles versus a solid card), scale-invariant;
 *   - mean lightness, kept but weighted low because lighting does move it.
 * Each part is scored 0..1 and the weighted sum is the 0..100 `score`. A washed-out, hue-shifted or
 * sparse import scores low even when the older mean-colour "similarity" waves it through.
 */
import { maskFillRatio, objectMask, rgbToLab, type RgbaImage } from "./image-diff.js";

const HUE_BINS = 36;
/** Object masks tolerate the floor's shading; the border palette is wider than the default. */
const MASK_TOLERANCE = 26;
/** An object smaller than this share of the image cannot be described. */
const MIN_COVERAGE = 0.002;
/** Below this mean chroma an object counts as neutral and its hue is not compared. */
const NEUTRAL_CHROMA = 6;

export const FIDELITY_WEIGHTS = Object.freeze({ hue: 0.25, saturation: 0.35, density: 0.25, lightness: 0.15 });
/** Hue distance (degrees) at which the hue part reaches 0. */
export const HUE_ZERO_DEGREES = 60;
/** Saturation / density / lightness ratio at which the part reaches 0 (symmetric in log space). */
export const SATURATION_ZERO_RATIO = 2;
export const DENSITY_ZERO_RATIO = 3;
export const LIGHTNESS_ZERO_RATIO = 3;
/** Verdict thresholds on `score`. */
export const FIDELITY_OK_SCORE = 70;
export const FIDELITY_SUSPECT_SCORE = 50;

interface Described {
  pixels: number;
  coverage: number;
  meanChroma: number;
  meanLightness: number;
  /** Median of chroma per lightness over pixels with some lightness. */
  medianSaturation: number;
  /** Chroma-weighted hue histogram, normalised to sum 1 (all zero for a neutral object). */
  hueHistogram: Float64Array;
  fillRatio: number;
}

function describe(image: RgbaImage): Described {
  const mask = objectMask(image, MASK_TOLERANCE);
  const hueHistogram = new Float64Array(HUE_BINS);
  const saturations: number[] = [];
  let pixels = 0;
  let chromaSum = 0;
  let lightnessSum = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const o = i * 4;
    const [l, a, b] = rgbToLab(image.data[o]!, image.data[o + 1]!, image.data[o + 2]!);
    const chroma = Math.hypot(a, b);
    pixels++;
    chromaSum += chroma;
    lightnessSum += l;
    if (l > 4) saturations.push(chroma / l);
    if (chroma > 1) {
      let hue = (Math.atan2(b, a) * 180) / Math.PI;
      if (hue < 0) hue += 360;
      hueHistogram[Math.min(HUE_BINS - 1, Math.floor((hue / 360) * HUE_BINS))]! += chroma;
    }
  }
  const total = hueHistogram.reduce((sum, value) => sum + value, 0);
  if (total > 0) for (let i = 0; i < HUE_BINS; i++) hueHistogram[i]! /= total;
  saturations.sort((x, y) => x - y);
  const fill = maskFillRatio(mask, image.width, image.height);
  return {
    pixels,
    coverage: pixels / Math.max(1, mask.length),
    meanChroma: pixels > 0 ? chromaSum / pixels : 0,
    meanLightness: pixels > 0 ? lightnessSum / pixels : 0,
    medianSaturation: saturations.length > 0 ? saturations[Math.floor(saturations.length / 2)]! : 0,
    hueHistogram,
    fillRatio: fill.fillRatio,
  };
}

/** Circular earth mover's distance between two normalised hue histograms, in degrees. */
export function circularHueEmd(a: Float64Array, b: Float64Array): number {
  // EMD on a circle: subtract the median of the running difference (Rabin et al.), then sum absolute values.
  const running: number[] = [];
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i]! - b[i]!;
    running.push(sum);
  }
  const sorted = [...running].sort((x, y) => x - y);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  let emd = 0;
  for (const value of running) emd += Math.abs(value - median);
  return (emd * 360) / a.length;
}

export interface FidelityMetrics {
  /** False when either object is too small to describe; the numbers are then not meaningful. */
  readonly comparable: boolean;
  /** Circular EMD of the chroma-weighted hue histograms, degrees (0 = same hues). */
  readonly hueEmdDegrees: number;
  /** Median chroma per lightness of the render over the reference's. Below 1: greyer than Unreal. */
  readonly saturationRatio: number;
  /** Silhouette fill of the render over the reference's. Below 1: sparser; above 1: more solid. */
  readonly densityRatio: number;
  /** Mean L* of the render over the reference's (lighting moves it; weighted low). */
  readonly lightnessRatio: number;
  readonly parts: { readonly hue: number; readonly saturation: number; readonly density: number; readonly lightness: number };
  /** 0..100, higher is closer to Unreal's own picture of the piece. */
  readonly score: number;
}

const NOT_COMPARABLE: FidelityMetrics = Object.freeze({
  comparable: false,
  hueEmdDegrees: Number.NaN,
  saturationRatio: Number.NaN,
  densityRatio: Number.NaN,
  lightnessRatio: Number.NaN,
  parts: Object.freeze({ hue: 0, saturation: 0, density: 0, lightness: 0 }),
  score: 0,
});

function ratioPart(ratio: number, zeroAt: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 0;
  return Math.max(0, 1 - Math.abs(Math.log(ratio)) / Math.log(zeroAt));
}

/** Compares a render with the Unreal thumbnail of the same piece. Pure over pixels. */
export function measureFidelity(reference: RgbaImage, render: RgbaImage): FidelityMetrics {
  const ref = describe(reference);
  const out = describe(render);
  if (ref.coverage < MIN_COVERAGE || out.coverage < MIN_COVERAGE) return NOT_COMPARABLE;
  const bothNeutral = ref.meanChroma < NEUTRAL_CHROMA && out.meanChroma < NEUTRAL_CHROMA;
  const hueEmdDegrees = bothNeutral ? 0 : circularHueEmd(ref.hueHistogram, out.hueHistogram);
  const saturationRatio = ref.medianSaturation > 0.001 ? out.medianSaturation / ref.medianSaturation : out.medianSaturation > 0.001 ? Number.POSITIVE_INFINITY : 1;
  const densityRatio = ref.fillRatio > 0 ? out.fillRatio / ref.fillRatio : Number.NaN;
  const lightnessRatio = ref.meanLightness > 0 ? out.meanLightness / ref.meanLightness : Number.NaN;
  const parts = {
    hue: bothNeutral ? 1 : Math.max(0, 1 - hueEmdDegrees / HUE_ZERO_DEGREES),
    saturation: bothNeutral ? 1 : ratioPart(saturationRatio, SATURATION_ZERO_RATIO),
    density: ratioPart(densityRatio, DENSITY_ZERO_RATIO),
    lightness: ratioPart(lightnessRatio, LIGHTNESS_ZERO_RATIO),
  };
  const score =
    100 *
    (FIDELITY_WEIGHTS.hue * parts.hue +
      FIDELITY_WEIGHTS.saturation * parts.saturation +
      FIDELITY_WEIGHTS.density * parts.density +
      FIDELITY_WEIGHTS.lightness * parts.lightness);
  return { comparable: true, hueEmdDegrees, saturationRatio, densityRatio, lightnessRatio, parts, score };
}

/** One-line explanation of what drags a low score down, for the sheet. */
export function explainFidelity(metrics: FidelityMetrics): string {
  if (!metrics.comparable) return "not comparable";
  const reasons: string[] = [];
  if (metrics.parts.hue < 0.7) reasons.push(`hue off by ${metrics.hueEmdDegrees.toFixed(0)}°`);
  if (metrics.parts.saturation < 0.7) {
    reasons.push(metrics.saturationRatio < 1 ? `greyer than Unreal (${metrics.saturationRatio.toFixed(2)}x saturation)` : `more saturated than Unreal (${metrics.saturationRatio.toFixed(2)}x)`);
  }
  if (metrics.parts.density < 0.7) {
    reasons.push(metrics.densityRatio < 1 ? `sparser than Unreal (${metrics.densityRatio.toFixed(2)}x fill)` : `more solid than Unreal (${metrics.densityRatio.toFixed(2)}x fill)`);
  }
  if (metrics.parts.lightness < 0.5) reasons.push(`${metrics.lightnessRatio < 1 ? "darker" : "brighter"} (${metrics.lightnessRatio.toFixed(2)}x lightness)`);
  return reasons.join("; ");
}
