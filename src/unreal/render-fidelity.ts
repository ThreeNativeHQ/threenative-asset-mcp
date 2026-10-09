/**
 * Objective fidelity of one rendered piece against Unreal's own thumbnail of it (PRD-537 visual judge).
 *
 * The thumbnail is lit (sun, tinted sky, cast shadows), on a checkered floor, from another camera; our render is
 * neutral-lit on flat grey. So raw brightness and pixel metrics say nothing, and the comparison is made on what
 * a change of lighting leaves alone:
 *   - saturation and hue are taken in LINEAR light, where a multiplicative lighting change (sun, shade) cancels
 *     out of (max - min) / max, and only on the mid-lightness pixels of each object (percentiles 35-95 of its own
 *     luminance), so deep shadow and specular highlights drop out;
 *   - the silhouette's fill of its bounding box (sparse needles versus a solid card), scale-invariant;
 *   - median luminance, kept but weighted low and tolerant, because lighting does move it.
 * Each part is scored 0..1 and the weighted sum is the 0..100 `score`.
 */
import { maskFillRatio, objectMask, type RgbaImage } from "./image-diff.js";

export const HUE_BINS = 36;
/** Object masks tolerate the floor's shading; the border palette is wider than the default. */
const MASK_TOLERANCE = 26;
/** An object smaller than this share of the image cannot be described. */
export const MIN_COVERAGE = 0.002;

export const FIDELITY_WEIGHTS = Object.freeze({ hue: 0.25, saturation: 0.35, density: 0.25, lightness: 0.15 });
/** Hue distance (degrees) at which the hue part reaches 0. */
export const HUE_ZERO_DEGREES = 60;
/** Saturation / density / lightness ratio at which the part reaches 0 (symmetric in log space). */
export const SATURATION_ZERO_RATIO = 2;
export const DENSITY_ZERO_RATIO = 3;
export const LIGHTNESS_ZERO_RATIO = 6;
/** Composite thresholds on `score` (the ratchet number; verdicts also gate each axis, see `fidelityVerdict`). */
export const FIDELITY_OK_SCORE = 70;
export const FIDELITY_SUSPECT_SCORE = 50;
/**
 * Per-axis gates. A composite averages a single bad axis away (half the saturation still scores ~76), so a tile is
 * suspect or failed as soon as ONE axis leaves its band. The bands sit outside what lighting alone does to a
 * lighting-robust measure (see the synthetic-lighting tests) and inside what the owner sees as wrong. They are
 * provisional: the editor's filmic tonemapper lifts saturation a little, so a correct import sits somewhat under
 * a ratio of 1. Calibrated on the Temperate conifer pack only (2026-10-09); recalibrate on the library-wide
 * distribution of a full sweep before treating them as final.
 */
export const SATURATION_SUSPECT: readonly [number, number] = [0.7, 1.4];
export const SATURATION_FAIL: readonly [number, number] = [0.5, 2];
export const HUE_SUSPECT_DEGREES = 25;
export const HUE_FAIL_DEGREES = 45;
export const DENSITY_SUSPECT: readonly [number, number] = [0.65, 1.6];
export const DENSITY_FAIL: readonly [number, number] = [0.4, 2.5];

export interface Described {
  pixels: number;
  coverage: number;
  /** Median linear-light saturation, (max - min) / max, of the mid-lightness pixels . */
  medianSaturation: number;
  /** Mean saturation of the same pixels; below `NEUTRAL_SATURATION` the object is neutral and its hue is not compared. */
  meanSaturation: number;
  /** Saturation-weighted hue histogram of the same pixels, normalised to sum 1 (all zero for a neutral object). */
  hueHistogram: Float64Array;
  /** Median linear luminance of the object, 0..1. */
  medianLuminance: number;
  fillRatio: number;
}

/** Below this mean linear saturation an object counts as neutral. */
export const NEUTRAL_SATURATION = 0.06;
export const SATURATION_NOISE_FLOOR = 0.05;
/** The object's own luminance percentiles that are kept: below drops deep shadow, above drops specular highlights. */
export const BAND_LOW = 0.35;
export const BAND_HIGH = 0.95;

export function srgbToLinear(value: number): number {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** Chromaticity distance (r, g of r+g+b) from the floor's within which a bluish dark pixel is the floor's shadow. */
const SHADOW_CHROMA_RADIUS = 0.12;
/** A floor whose own chroma (max - min over max) is below this is neutral grey; shadows there are grey and not separable by colour. */
const TINTED_FLOOR_SATURATION = 0.04;

/**
 * Removes a cast shadow from the object mask. An editor thumbnail's floor is blue-grey and the piece casts a dark,
 * bluer copy of it (sky tint); the border-palette mask counts that blob as object, which drags hue toward blue and
 * saturation down and inflates the bounding box. A shadow is the floor's own chromaticity pushed toward blue and
 * darker: blue the largest channel, within `SHADOW_CHROMA_RADIUS` of the floor's chromaticity, darker than the floor.
 * A flat neutral background (our own render) has no tinted floor, so nothing is removed there.
 */
export function withoutFloorShadow(image: RgbaImage, mask: Uint8Array): Uint8Array {
  const floor: [number, number, number][] = [];
  for (let i = 0; i < mask.length; i += 7) {
    if (mask[i]) continue;
    const o = i * 4;
    if (image.data[o + 3]! < 128) continue;
    floor.push([image.data[o]!, image.data[o + 1]!, image.data[o + 2]!]);
  }
  if (floor.length < 50) return mask;
  const med = (channel: 0 | 1 | 2): number => floor.map((p) => p[channel]).sort((x, y) => x - y)[Math.floor(floor.length / 2)]!;
  const fr = med(0);
  const fg = med(1);
  const fb = med(2);
  const fmax = Math.max(fr, fg, fb);
  if ((fmax - Math.min(fr, fg, fb)) / Math.max(1, fmax) < TINTED_FLOOR_SATURATION) return mask;
  const floorSum = fr + fg + fb;
  const floorLuma = 0.2126 * fr + 0.7152 * fg + 0.0722 * fb;
  const out = new Uint8Array(mask);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const o = i * 4;
    const r = image.data[o]!;
    const g = image.data[o + 1]!;
    const b = image.data[o + 2]!;
    const sum = r + g + b;
    if (sum < 1 || b < Math.max(r, g)) continue;
    if (0.2126 * r + 0.7152 * g + 0.0722 * b > floorLuma * 0.85) continue;
    if (Math.hypot(r / sum - fr / floorSum, g / sum - fg / floorSum) <= SHADOW_CHROMA_RADIUS) out[i] = 0;
  }
  return out;
}

/** The statistics of a render's (or thumbnail's) object pixels. */
export function describeObject(image: RgbaImage): Described {
  const mask = withoutFloorShadow(image, objectMask(image, MASK_TOLERANCE));
    const pixelsRgb: [number, number, number, number][] = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const o = i * 4;
    const r = srgbToLinear(image.data[o]!);
    const g = srgbToLinear(image.data[o + 1]!);
    const b = srgbToLinear(image.data[o + 2]!);
    pixelsRgb.push([r, g, b, 0.2126 * r + 0.7152 * g + 0.0722 * b]);
  }
  const hueHistogram = new Float64Array(HUE_BINS);
  const fill = maskFillRatio(mask, image.width, image.height);
  if (pixelsRgb.length === 0) {
    return { pixels: 0, coverage: 0, medianSaturation: 0, meanSaturation: 0, hueHistogram, medianLuminance: 0, fillRatio: fill.fillRatio };
  }
  const luminances = pixelsRgb.map((pixel) => pixel[3]).sort((x, y) => x - y);
  const at = (q: number): number => luminances[Math.min(luminances.length - 1, Math.floor(q * luminances.length))]!;
  const low = at(BAND_LOW);
  const high = at(BAND_HIGH);
  const saturations: number[] = [];
  for (const [r, g, b, y] of pixelsRgb) {
    if (y < low || y > high) continue;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max < 1e-4) continue;
    const saturation = (max - min) / max;
    saturations.push(saturation);
    if (max - min > 1e-4) {
      const d = max - min;
      let hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      if (hue < 0) hue += 6;
      hueHistogram[Math.min(HUE_BINS - 1, Math.floor((hue / 6) * HUE_BINS))]! += saturation;
    }
  }
  const total = hueHistogram.reduce((sum, value) => sum + value, 0);
  if (total > 0) for (let i = 0; i < HUE_BINS; i++) hueHistogram[i]! /= total;
  saturations.sort((x, y) => x - y);
  return {
    pixels: pixelsRgb.length,
    coverage: pixelsRgb.length / Math.max(1, mask.length),
    medianSaturation: saturations.length > 0 ? saturations[Math.floor(saturations.length / 2)]! : 0,
    meanSaturation: saturations.length > 0 ? saturations.reduce((sum, v) => sum + v, 0) / saturations.length : 0,
    hueHistogram,
    medianLuminance: luminances[Math.floor(luminances.length / 2)]!,
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
  /** Median linear-light saturation of the render over the reference's, white balanced. Below 1: greyer than Unreal. */
  readonly saturationRatio: number;
  /** Silhouette fill of the render over the reference's. Below 1: sparser; above 1: more solid. */
  readonly densityRatio: number;
  /** Median linear luminance of the render over the reference's (lighting moves it; weighted low and tolerant). */
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

export function ratioPart(ratio: number, zeroAt: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 0;
  return Math.max(0, 1 - Math.abs(Math.log(ratio)) / Math.log(zeroAt));
}

/** Compares a render with the Unreal thumbnail of the same piece. Pure over pixels. */
export function measureFidelity(reference: RgbaImage, render: RgbaImage): FidelityMetrics {
  const ref = describeObject(reference);
  const out = describeObject(render);
  if (ref.coverage < MIN_COVERAGE || out.coverage < MIN_COVERAGE) return NOT_COMPARABLE;
  const bothNeutral = ref.meanSaturation < NEUTRAL_SATURATION && out.meanSaturation < NEUTRAL_SATURATION;
  const hueEmdDegrees = bothNeutral ? 0 : circularHueEmd(ref.hueHistogram, out.hueHistogram);
  // A noise floor keeps two near-neutral objects (a grey mannequin) from scoring on a 0 / 0.02 ratio.
  const saturationRatio = (out.medianSaturation + SATURATION_NOISE_FLOOR) / (ref.medianSaturation + SATURATION_NOISE_FLOOR);
  const densityRatio = ref.fillRatio > 0 ? out.fillRatio / ref.fillRatio : Number.NaN;
  const lightnessRatio = ref.medianLuminance > 0 ? out.medianLuminance / ref.medianLuminance : Number.NaN;
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

export interface FidelityVerdict {
  readonly verdict: "ok" | "suspect" | "fail";
  readonly reasons: readonly string[];
}

const outside = (value: number, [low, high]: readonly [number, number]): boolean => value < low || value > high;

/** Per-axis verdict for one comparable pair. */
export function fidelityVerdict(metrics: FidelityMetrics): FidelityVerdict {
  if (!metrics.comparable) return { verdict: "ok", reasons: [] };
  const failing: string[] = [];
  const suspect: string[] = [];
  const saturation = metrics.saturationRatio < 1 ? `greyer than Unreal (${metrics.saturationRatio.toFixed(2)}x saturation)` : `more saturated than Unreal (${metrics.saturationRatio.toFixed(2)}x)`;
  const density = metrics.densityRatio < 1 ? `sparser than Unreal (${metrics.densityRatio.toFixed(2)}x fill)` : `more solid than Unreal (${metrics.densityRatio.toFixed(2)}x fill)`;
  if (outside(metrics.saturationRatio, SATURATION_FAIL)) failing.push(saturation);
  else if (outside(metrics.saturationRatio, SATURATION_SUSPECT)) suspect.push(saturation);
  if (metrics.hueEmdDegrees > HUE_FAIL_DEGREES) failing.push(`hue off by ${metrics.hueEmdDegrees.toFixed(0)}°`);
  else if (metrics.hueEmdDegrees > HUE_SUSPECT_DEGREES) suspect.push(`hue off by ${metrics.hueEmdDegrees.toFixed(0)}°`);
  if (Number.isFinite(metrics.densityRatio)) {
    if (outside(metrics.densityRatio, DENSITY_FAIL)) failing.push(density);
    else if (outside(metrics.densityRatio, DENSITY_SUSPECT)) suspect.push(density);
  }
  if (failing.length > 0) return { verdict: "fail", reasons: [...failing, ...suspect] };
  return { verdict: suspect.length > 0 ? "suspect" : "ok", reasons: suspect };
}
