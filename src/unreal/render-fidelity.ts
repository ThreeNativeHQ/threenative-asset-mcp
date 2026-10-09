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
/** Closing radius of the mass measure, as a share of the object's longer side (about a needle cluster). */
export const MASS_RADIUS_FRACTION = 0.015;
/**
 * Mass ratio gates. Bounding-box fill does not see sparse speckle (a spray of thin needles and a thick one can share a box),
 * so mass is the object's pixels over its closed silhouette's, render over reference. Measured on the supersampled render
 * (`measureFidelity`'s third argument): the 1x alpha-tested tile reads 0.82 on pieces that are as dense as Unreal's, because
 * its hard cut-out edges lose the anti-aliased fringe the thumbnail has; supersampled it reads 0.95 (0.83-1.25).
 */
export const MASS_SUSPECT: readonly [number, number] = [0.65, 1.5];
export const MASS_FAIL: readonly [number, number] = [0.4, 2.5];

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
  /** `closedSolidity` of the object mask at `MASS_RADIUS_FRACTION`. */
  solidity: number;
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
    return { pixels: 0, coverage: 0, medianSaturation: 0, meanSaturation: 0, hueHistogram, medianLuminance: 0, fillRatio: fill.fillRatio, solidity: 0 };
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
    solidity: closedSolidity(mask, image.width, image.height, MASS_RADIUS_FRACTION),
  };
}

/** Running max (or min) of one row/column with a window of `2 * radius + 1`, naive but bounded by the tile size. */
function slide(values: Uint8Array, length: number, stride: number, offset: number, radius: number, max: boolean): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    let hit = max ? 0 : 1;
    for (let k = Math.max(0, i - radius); k <= Math.min(length - 1, i + radius); k++) {
      const v = values[offset + k * stride]!;
      if (max ? v : !v) { hit = max ? 1 : 0; break; }
    }
    out[i] = hit;
  }
  return out;
}

function morph(mask: Uint8Array, width: number, height: number, radius: number, max: boolean): Uint8Array {
  const rows = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) rows.set(slide(mask, width, 1, y * width, radius, max), y * width);
  const out = new Uint8Array(mask.length);
  for (let x = 0; x < width; x++) {
    const column = slide(rows, height, width, x, radius, max);
    for (let y = 0; y < height; y++) out[y * width + x] = column[y]!;
  }
  return out;
}

/**
 * Mass of the silhouette at the scale of a needle cluster: object pixels over the pixels of the object's morphologically
 * closed silhouette (dilate then erode by `radiusFraction` of the bounding box's longer side). A solid sheet is 1; a spray of
 * thin needles whose gaps are narrower than the closing radius is its true density; isolated speckle that does not fuse stays
 * low. Unlike the bounding-box fill it does not move with the piece's overall shape, only with how filled its parts are, and
 * it is scale-invariant because the radius follows the object's own size.
 */
export function closedSolidity(mask: Uint8Array, width: number, height: number, radiusFraction: number): number {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let pixels = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    pixels++;
    const x = i % width;
    const y = (i - x) / width;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (pixels === 0) return 0;
  const radius = Math.max(1, Math.round(radiusFraction * Math.max(maxX - minX + 1, maxY - minY + 1)));
  const closed = morph(morph(mask, width, height, radius, true), width, height, radius, false);
  let closedPixels = 0;
  for (let i = 0; i < closed.length; i++) if (closed[i]) closedPixels++;
  return pixels / Math.max(pixels, closedPixels);
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
  /** Closed-silhouette mass of the render over the reference's (see `MASS_SUSPECT`). Below 1: sparser or speckled. */
  readonly massRatio: number;
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
  massRatio: Number.NaN,
  lightnessRatio: Number.NaN,
  parts: Object.freeze({ hue: 0, saturation: 0, density: 0, lightness: 0 }),
  score: 0,
});

export function ratioPart(ratio: number, zeroAt: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 0;
  return Math.max(0, 1 - Math.abs(Math.log(ratio)) / Math.log(zeroAt));
}

/** Compares a render with the Unreal thumbnail of the same piece. Pure over pixels. */
export function measureFidelity(reference: RgbaImage, render: RgbaImage, shapeRender?: RgbaImage): FidelityMetrics {
  const ref = describeObject(reference);
  const out = describeObject(render);
  // Mass reads the supersampled render when given one: an alpha-tested cut-out has no anti-aliased fringe at 1x.
  const shape = shapeRender ? describeObject(shapeRender) : out;
  if (ref.coverage < MIN_COVERAGE || out.coverage < MIN_COVERAGE) return NOT_COMPARABLE;
  const bothNeutral = ref.meanSaturation < NEUTRAL_SATURATION && out.meanSaturation < NEUTRAL_SATURATION;
  const hueEmdDegrees = bothNeutral ? 0 : circularHueEmd(ref.hueHistogram, out.hueHistogram);
  // A noise floor keeps two near-neutral objects (a grey mannequin) from scoring on a 0 / 0.02 ratio.
  const saturationRatio = (out.medianSaturation + SATURATION_NOISE_FLOOR) / (ref.medianSaturation + SATURATION_NOISE_FLOOR);
  const densityRatio = ref.fillRatio > 0 ? out.fillRatio / ref.fillRatio : Number.NaN;
  const massRatio = ref.solidity > 0 && shape.solidity > 0 ? shape.solidity / ref.solidity : Number.NaN;
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
  return { comparable: true, hueEmdDegrees, saturationRatio, densityRatio, massRatio, lightnessRatio, parts, score };
}

const outside = (value: number, [low, high]: readonly [number, number]): boolean => value < low || value > high;

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
  if (Number.isFinite(metrics.massRatio) && outside(metrics.massRatio, MASS_SUSPECT)) {
    reasons.push(metrics.massRatio < 1 ? `thinner than Unreal (${metrics.massRatio.toFixed(2)}x mass)` : `heavier than Unreal (${metrics.massRatio.toFixed(2)}x mass)`);
  }
  if (metrics.parts.lightness < 0.5) reasons.push(`${metrics.lightnessRatio < 1 ? "darker" : "brighter"} (${metrics.lightnessRatio.toFixed(2)}x lightness)`);
  return reasons.join("; ");
}

export interface FidelityVerdict {
  readonly verdict: "ok" | "suspect" | "fail";
  readonly reasons: readonly string[];
}

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
  if (Number.isFinite(metrics.massRatio)) {
    const mass = metrics.massRatio < 1 ? `thinner than Unreal (${metrics.massRatio.toFixed(2)}x mass)` : `heavier than Unreal (${metrics.massRatio.toFixed(2)}x mass)`;
    if (outside(metrics.massRatio, MASS_FAIL)) failing.push(mass);
    else if (outside(metrics.massRatio, MASS_SUSPECT)) suspect.push(mass);
  }
  if (failing.length > 0) return { verdict: "fail", reasons: [...failing, ...suspect] };
  return { verdict: suspect.length > 0 ? "suspect" : "ok", reasons: suspect };
}
