/**
 * Fidelity of a render against the package itself, for packs that ship no Unreal thumbnail (every UE5 pack).
 *
 * `render-fidelity.ts` needs Unreal's own picture. Without it the closest objective reference is the albedo the
 * material actually binds, which is already in the glTF: the colour a piece should have is the alpha-weighted
 * colour of its base-colour textures (times the colour factor). Two measurements come out of that:
 *   1. colour: the same lighting-robust description `render-fidelity.ts` uses (linear-light saturation
 *      (max - min) / max and hue, on the mid-lightness band, percentiles 35-95 of luminance) of the render's object
 *      pixels against the albedo's, where each texel counts in proportion to its alpha and its material's share of the
 *      piece. Same thresholds as the thumbnail verdict. The render is lit and the albedo is not, so lightness is
 *      reported, never scored.
 *   2. cut-out: a translucent or masked material must carry its mask in the texture's alpha. Its opaque coverage
 *      is compared with the mask texture's own coverage; a card whose coverage is 1 is a solid rectangle.
 * Pure over pixels, so a unit test pins both on synthetic images.
 */
import type { RgbaImage } from "./image-diff.js";
import {
  BAND_HIGH,
  BAND_LOW,
  HUE_BINS,
  HUE_FAIL_DEGREES,
  HUE_SUSPECT_DEGREES,
  HUE_ZERO_DEGREES,
  MIN_COVERAGE,
  NEUTRAL_SATURATION,
  SATURATION_FAIL,
  SATURATION_NOISE_FLOOR,
  SATURATION_SUSPECT,
  SATURATION_ZERO_RATIO,
  circularHueEmd,
  describeObject,
  ratioPart,
  srgbToLinear,
} from "./render-fidelity.js";

/** Opaque coverage at or above this on a translucent or masked material means no cut-out survived. */
export const SOLID_CARD_COVERAGE = 0.98;
/** An alpha texel at or above this counts as part of the silhouette. */
const OPAQUE_TEXEL = 128;
/** Each texture contributes at most about this many texels (a strided sample), so a 4096 atlas stays cheap. */
const MAX_TEXELS_PER_SOURCE = 90_000;

/** One base-colour texture of a piece, with the share of the piece it paints and its glTF colour factor. */
export interface AlbedoSource {
  readonly image: RgbaImage;
  /** Relative weight, for example the primitive's triangle count. */
  readonly weight: number;
  /** glTF baseColorFactor RGB (linear, 0..1). Default white. */
  readonly factor?: readonly [number, number, number];
  /**
   * Which texels the mesh actually maps (see `uvCoverage`). A texture atlas is mostly unused area; without this the
   * albedo is the whole atlas, not the colour of the piece.
   */
  readonly coverage?: UvCoverage;
}

/** A square occupancy grid over the 0..1 UV square: 1 where some triangle of the primitive maps. */
export interface UvCoverage {
  readonly size: number;
  readonly data: Uint8Array;
}

/**
 * Rasterises a primitive's UV triangles into an occupancy grid. UVs outside 0..1 wrap (a tiled texture). A triangle
 * smaller than a cell still marks the cells of its corners, so tiny triangles are not lost.
 */
export function uvCoverage(uvs: ArrayLike<number>, indices: ArrayLike<number> | undefined, size = 256): UvCoverage {
  const data = new Uint8Array(size * size);
  const count = indices ? indices.length : Math.floor(uvs.length / 2);
  const index = (corner: number): number => (indices ? indices[corner]! : corner);
  const fract = (value: number): number => value - Math.floor(value);
  const mark = (x: number, y: number): void => {
    const cx = Math.min(size - 1, Math.max(0, Math.floor(x)));
    const cy = Math.min(size - 1, Math.max(0, Math.floor(y)));
    data[cy * size + cx] = 1;
  };
  for (let t = 0; t + 2 < count; t += 3) {
    const a = index(t);
    const b = index(t + 1);
    const c = index(t + 2);
    // Wrap by the triangle's centroid tile, so a triangle that touches a tile edge (U = 1 exactly) stays in one piece.
    const baseU = Math.floor((uvs[a * 2]! + uvs[b * 2]! + uvs[c * 2]!) / 3);
    const baseV = Math.floor((uvs[a * 2 + 1]! + uvs[b * 2 + 1]! + uvs[c * 2 + 1]!) / 3);
    const px = [a, b, c].map((corner) => (uvs[corner * 2]! - baseU) * size);
    const py = [a, b, c].map((corner) => (uvs[corner * 2 + 1]! - baseV) * size);
    for (let k = 0; k < 3; k++) mark(fract(px[k]! / size) * size, fract(py[k]! / size) * size);
    const minX = Math.max(0, Math.floor(Math.min(...px)));
    const maxX = Math.min(size - 1, Math.floor(Math.max(...px)));
    const minY = Math.max(0, Math.floor(Math.min(...py)));
    const maxY = Math.min(size - 1, Math.floor(Math.max(...py)));
    const area = (px[1]! - px[0]!) * (py[2]! - py[0]!) - (py[1]! - py[0]!) * (px[2]! - px[0]!);
    if (Math.abs(area) < 1e-9) continue;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const cx = x + 0.5;
        const cy = y + 0.5;
        const w0 = ((px[1]! - cx) * (py[2]! - cy) - (py[1]! - cy) * (px[2]! - cx)) / area;
        const w1 = ((px[2]! - cx) * (py[0]! - cy) - (py[2]! - cy) * (px[0]! - cx)) / area;
        if (w0 >= 0 && w1 >= 0 && w0 + w1 <= 1) data[y * size + x] = 1;
      }
    }
  }
  return { size, data };
}

export interface AlbedoDescription {
  /** Total alpha-and-share weight that was seen; 0 when there is nothing to describe. */
  readonly weight: number;
  readonly medianSaturation: number;
  readonly meanSaturation: number;
  readonly hueHistogram: Float64Array;
  readonly medianLuminance: number;
}

/** Alpha-weighted, lighting-robust description of the albedo a piece binds. */
export function describeAlbedo(sources: readonly AlbedoSource[]): AlbedoDescription {
  const totalWeight = sources.reduce((sum, source) => sum + Math.max(0, source.weight), 0);
  const texels: { r: number; g: number; b: number; y: number; w: number }[] = [];
  for (const source of sources) {
    const { image, coverage } = source;
    const pixels = image.width * image.height;
    const stride = Math.max(1, Math.floor(pixels / MAX_TEXELS_PER_SOURCE));
    const factor = source.factor ?? [1, 1, 1];
    const first = texels.length;
    for (let i = 0; i < pixels; i += stride) {
      const o = i * 4;
      if (coverage) {
        const cell = Math.floor(((i / image.width) | 0) * coverage.size / image.height) * coverage.size + Math.floor(((i % image.width) * coverage.size) / image.width);
        if (!coverage.data[cell]) continue;
      }
      const alpha = image.data[o + 3]! / 255;
      if (alpha === 0) continue;
      const r = srgbToLinear(image.data[o]!) * factor[0];
      const g = srgbToLinear(image.data[o + 1]!) * factor[1];
      const b = srgbToLinear(image.data[o + 2]!) * factor[2];
      texels.push({ r, g, b, y: 0.2126 * r + 0.7152 * g + 0.0722 * b, w: alpha });
    }
    // A source's texels share its weight equally, so a big or sparsely mapped texture does not outvote a small one.
    const count = texels.length - first;
    const share = totalWeight > 0 && count > 0 ? Math.max(0, source.weight) / totalWeight / count : 0;
    for (let k = first; k < texels.length; k++) texels[k]!.w *= share;
  }
  const empty: AlbedoDescription = { weight: 0, medianSaturation: 0, meanSaturation: 0, hueHistogram: new Float64Array(HUE_BINS), medianLuminance: 0 };
  if (texels.length === 0) return empty;
  texels.sort((x, y) => x.y - y.y);
  const weight = texels.reduce((sum, texel) => sum + texel.w, 0);
  if (weight <= 0) return empty;
  const percentile = (q: number): number => {
    let running = 0;
    for (const texel of texels) {
      running += texel.w;
      if (running >= q * weight) return texel.y;
    }
    return texels[texels.length - 1]!.y;
  };
  const low = percentile(BAND_LOW);
  const high = percentile(BAND_HIGH);
  const band: { s: number; w: number }[] = [];
  const hueHistogram = new Float64Array(HUE_BINS);
  for (const { r, g, b, y, w } of texels) {
    if (y < low || y > high) continue;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max < 1e-4) continue;
    const saturation = (max - min) / max;
    band.push({ s: saturation, w });
    if (max - min > 1e-4) {
      const d = max - min;
      let hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      if (hue < 0) hue += 6;
      hueHistogram[Math.min(HUE_BINS - 1, Math.floor((hue / 6) * HUE_BINS))]! += saturation * w;
    }
  }
  const hueTotal = hueHistogram.reduce((sum, value) => sum + value, 0);
  if (hueTotal > 0) for (let i = 0; i < HUE_BINS; i++) hueHistogram[i]! /= hueTotal;
  band.sort((x, y) => x.s - y.s);
  const bandWeight = band.reduce((sum, entry) => sum + entry.w, 0);
  let medianSaturation = 0;
  let running = 0;
  for (const entry of band) {
    running += entry.w;
    if (running >= bandWeight / 2) {
      medianSaturation = entry.s;
      break;
    }
  }
  const meanSaturation = bandWeight > 0 ? band.reduce((sum, entry) => sum + entry.s * entry.w, 0) / bandWeight : 0;
  return { weight, medianSaturation, meanSaturation, hueHistogram, medianLuminance: percentile(0.5) };
}

export interface AlbedoFidelity {
  /** False when the render or the albedo has nothing to describe. */
  readonly comparable: boolean;
  readonly hueEmdDegrees: number;
  /** Render median linear-light saturation over the albedo's. Below 1: greyer than the textures. */
  readonly saturationRatio: number;
  /** Median luminance of the render over the albedo's; informational, lighting moves it. */
  readonly lightnessRatio: number;
  /** 0..100: 40 % hue, 60 % saturation. */
  readonly score: number;
  readonly verdict: "ok" | "suspect" | "fail";
  readonly reasons: readonly string[];
}

const NOT_COMPARABLE: AlbedoFidelity = Object.freeze({
  comparable: false,
  hueEmdDegrees: Number.NaN,
  saturationRatio: Number.NaN,
  lightnessRatio: Number.NaN,
  score: 0,
  verdict: "ok",
  reasons: Object.freeze([]) as readonly string[],
});

const outside = (value: number, [low, high]: readonly [number, number]): boolean => value < low || value > high;

/** Compares the object pixels of a neutral-lit render with the albedo its materials bind. */
export function measureAgainstAlbedo(sources: readonly AlbedoSource[], render: RgbaImage): AlbedoFidelity {
  const reference = describeAlbedo(sources);
  const out = describeObject(render);
  if (reference.weight <= 0 || out.coverage < MIN_COVERAGE) return NOT_COMPARABLE;
  const bothNeutral = reference.meanSaturation < NEUTRAL_SATURATION && out.meanSaturation < NEUTRAL_SATURATION;
  const hueEmdDegrees = bothNeutral ? 0 : circularHueEmd(reference.hueHistogram, out.hueHistogram);
  const saturationRatio = (out.medianSaturation + SATURATION_NOISE_FLOOR) / (reference.medianSaturation + SATURATION_NOISE_FLOOR);
  const lightnessRatio = reference.medianLuminance > 0 ? out.medianLuminance / reference.medianLuminance : Number.NaN;
  const hue = bothNeutral ? 1 : Math.max(0, 1 - hueEmdDegrees / HUE_ZERO_DEGREES);
  const saturation = bothNeutral ? 1 : ratioPart(saturationRatio, SATURATION_ZERO_RATIO);
  const failing: string[] = [];
  const suspect: string[] = [];
  const saturationReason = saturationRatio < 1 ? `greyer than its textures (${saturationRatio.toFixed(2)}x saturation)` : `more saturated than its textures (${saturationRatio.toFixed(2)}x)`;
  if (!bothNeutral) {
    if (outside(saturationRatio, SATURATION_FAIL)) failing.push(saturationReason);
    else if (outside(saturationRatio, SATURATION_SUSPECT)) suspect.push(saturationReason);
    if (hueEmdDegrees > HUE_FAIL_DEGREES) failing.push(`hue off by ${hueEmdDegrees.toFixed(0)}°`);
    else if (hueEmdDegrees > HUE_SUSPECT_DEGREES) suspect.push(`hue off by ${hueEmdDegrees.toFixed(0)}°`);
  }
  return {
    comparable: true,
    hueEmdDegrees,
    saturationRatio,
    lightnessRatio,
    score: 100 * (0.4 * hue + 0.6 * saturation),
    verdict: failing.length > 0 ? "fail" : suspect.length > 0 ? "suspect" : "ok",
    reasons: [...failing, ...suspect],
  };
}

/** Which channel of an image carries its opacity. A mask texture is read as red (it is a grey map); a baked card as alpha. */
export type OpacityChannel = "alpha" | "red";

/** Fraction of texels at or above half opacity in the chosen channel. */
export function opacityCoverage(image: RgbaImage, channel: OpacityChannel): number {
  const offset = channel === "alpha" ? 3 : 0;
  const pixels = image.width * image.height;
  let opaque = 0;
  for (let i = 0; i < pixels; i++) if (image.data[i * 4 + offset]! >= OPAQUE_TEXEL) opaque++;
  return pixels === 0 ? 0 : opaque / pixels;
}

export interface CutoutAudit {
  /** Opaque coverage of the card's base-colour alpha. */
  readonly coverage: number;
  /** Opaque coverage of the mask texture that should drive it, when one was given. */
  readonly maskCoverage?: number;
  /** coverage / maskCoverage; 1 means the cut-out matches its mask. */
  readonly ratio?: number;
  /** True when a translucent or masked card is a solid rectangle. */
  readonly solidCard: boolean;
}

/**
 * Audits one translucent or masked card: does its base-colour texture carry a cut-out, and does it match the mask?
 * Opaque materials have no cut-out and are not audited.
 */
export function auditCutout(card: RgbaImage, mask?: RgbaImage): CutoutAudit {
  const coverage = opacityCoverage(card, "alpha");
  const maskCoverage = mask ? opacityCoverage(mask, "red") : undefined;
  return {
    coverage,
    ...(maskCoverage !== undefined ? { maskCoverage, ratio: maskCoverage > 0 ? coverage / maskCoverage : Number.NaN } : {}),
    solidCard: coverage >= SOLID_CARD_COVERAGE && (maskCoverage === undefined || maskCoverage < SOLID_CARD_COVERAGE),
  };
}
