/**
 * Image-diff algorithms for the texture-identity proofs of the Fab parity sweep (S5). Everything
 * except `decodeRgba` and `resizeRgba` is pure arithmetic over RGBA8 buffers, so the metrics can be
 * asserted against analytic expectations on synthetic images.
 *
 * Conventions:
 *  - Images are straight (non-premultiplied) RGBA, 4 bytes per pixel, row-major.
 *  - `mse`, `psnr` and `maxAbsDiff` run over all four channels. `compareImages` can premultiply the
 *    colour by alpha first (`premultiplied: true`), so texels hidden behind alpha 0 do not count.
 *  - SSIM uses 8x8 windows at stride 4 (the last window of a row or column is moved back so every
 *    pixel is covered), the usual constants C1 = (0.01*255)^2 and C2 = (0.03*255)^2, on luminance
 *    (Rec. 601) and on each channel. The headline `ssim` is the lower of the luminance score and the
 *    mean of the four channel scores: a change in one colour channel that luminance hides still shows.
 */

export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  /** `width * height * 4` bytes, straight alpha. */
  readonly data: Uint8Array;
}

const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;
const WINDOW = 8;
const STRIDE = 4;

/** Decodes any image format sharp reads into straight RGBA8. */
export async function decodeRgba(buffer: Uint8Array): Promise<RgbaImage> {
  const { default: sharp } = await import("sharp");
  sharp.cache(false);
  const { data, info } = await sharp(Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength), {
    limitInputPixels: 268_435_456,
    unlimited: true,
  })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
}

/** Resamples to `width` x `height` (Lanczos, ignoring aspect ratio). */
export async function resizeRgba(image: RgbaImage, width: number, height: number): Promise<RgbaImage> {
  if (image.width === width && image.height === height) return image;
  const { default: sharp } = await import("sharp");
  sharp.cache(false);
  const { data, info } = await sharp(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength), {
    raw: { width: image.width, height: image.height, channels: 4 },
  })
    .resize(width, height, { fit: "fill", kernel: "lanczos3" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
}

/** Colour channels scaled by alpha/255 (rounded), alpha kept. */
export function premultiplyAlpha(image: RgbaImage): RgbaImage {
  const out = new Uint8Array(image.data.length);
  for (let i = 0; i < out.length; i += 4) {
    const alpha = image.data[i + 3]!;
    out[i] = Math.round((image.data[i]! * alpha) / 255);
    out[i + 1] = Math.round((image.data[i + 1]! * alpha) / 255);
    out[i + 2] = Math.round((image.data[i + 2]! * alpha) / 255);
    out[i + 3] = alpha;
  }
  return { width: image.width, height: image.height, data: out };
}

function assertSameSize(a: RgbaImage, b: RgbaImage): void {
  if (a.width !== b.width || a.height !== b.height) {
    throw new RangeError(`Image sizes differ: ${a.width}x${a.height} vs ${b.width}x${b.height}.`);
  }
  if (a.data.length !== a.width * a.height * 4 || b.data.length !== b.width * b.height * 4) {
    throw new RangeError("Image data length does not match width x height x 4.");
  }
}

/** Mean squared error over every channel value. */
export function mse(a: RgbaImage, b: RgbaImage): number {
  assertSameSize(a, b);
  let sum = 0;
  for (let i = 0; i < a.data.length; i++) {
    const d = a.data[i]! - b.data[i]!;
    sum += d * d;
  }
  return a.data.length === 0 ? 0 : sum / a.data.length;
}

/** Peak signal-to-noise ratio in dB for 8-bit data; Infinity for identical images. */
export function psnr(a: RgbaImage, b: RgbaImage): number {
  const error = mse(a, b);
  return error === 0 ? Infinity : 10 * Math.log10((255 * 255) / error);
}

/** Largest absolute difference of any channel value (0 means bit-identical pixels). */
export function maxAbsDiff(a: RgbaImage, b: RgbaImage): number {
  assertSameSize(a, b);
  let max = 0;
  for (let i = 0; i < a.data.length; i++) {
    const d = Math.abs(a.data[i]! - b.data[i]!);
    if (d > max) max = d;
  }
  return max;
}

/** Window origins covering `length` pixels with the given window and stride. */
function windowStarts(length: number, window: number): number[] {
  if (length <= window) return [0];
  const starts: number[] = [];
  for (let at = 0; at + window <= length; at += STRIDE) starts.push(at);
  const last = length - window;
  if (starts[starts.length - 1] !== last) starts.push(last);
  return starts;
}

/** Mean SSIM of two single-channel planes of the same size. */
function ssimPlane(a: Float64Array, b: Float64Array, width: number, height: number): number {
  const windowW = Math.min(WINDOW, width);
  const windowH = Math.min(WINDOW, height);
  const n = windowW * windowH;
  const xs = windowStarts(width, windowW);
  const ys = windowStarts(height, windowH);
  let total = 0;
  let count = 0;
  for (const y0 of ys) {
    for (const x0 of xs) {
      let sa = 0;
      let sb = 0;
      let saa = 0;
      let sbb = 0;
      let sab = 0;
      for (let y = y0; y < y0 + windowH; y++) {
        const row = y * width;
        for (let x = x0; x < x0 + windowW; x++) {
          const va = a[row + x]!;
          const vb = b[row + x]!;
          sa += va;
          sb += vb;
          saa += va * va;
          sbb += vb * vb;
          sab += va * vb;
        }
      }
      const meanA = sa / n;
      const meanB = sb / n;
      // Population variance, as in Wang et al.; clamped against float cancellation.
      const varA = Math.max(0, saa / n - meanA * meanA);
      const varB = Math.max(0, sbb / n - meanB * meanB);
      const cov = sab / n - meanA * meanB;
      const numerator = (2 * meanA * meanB + C1) * (2 * cov + C2);
      const denominator = (meanA * meanA + meanB * meanB + C1) * (varA + varB + C2);
      total += numerator / denominator;
      count++;
    }
  }
  return total / count;
}

function plane(image: RgbaImage, channel: 0 | 1 | 2 | 3 | "luma"): Float64Array {
  const pixels = image.width * image.height;
  const out = new Float64Array(pixels);
  const d = image.data;
  for (let i = 0; i < pixels; i++) {
    const o = i * 4;
    out[i] = channel === "luma" ? 0.299 * d[o]! + 0.587 * d[o + 1]! + 0.114 * d[o + 2]! : d[o + channel]!;
  }
  return out;
}

export interface SsimScores {
  /** Mean SSIM of the luminance plane. */
  readonly luma: number;
  /** Mean SSIM of R, G, B and A, each on its own plane. */
  readonly channels: readonly [number, number, number, number];
  readonly channelMean: number;
  /** The lower of `luma` and `channelMean`. */
  readonly ssim: number;
}

export function ssimScores(a: RgbaImage, b: RgbaImage): SsimScores {
  assertSameSize(a, b);
  if (a.width === 0 || a.height === 0) return { luma: 1, channels: [1, 1, 1, 1], channelMean: 1, ssim: 1 };
  const luma = ssimPlane(plane(a, "luma"), plane(b, "luma"), a.width, a.height);
  const channels = ([0, 1, 2, 3] as const).map((channel) =>
    ssimPlane(plane(a, channel), plane(b, channel), a.width, a.height),
  ) as unknown as [number, number, number, number];
  const channelMean = (channels[0] + channels[1] + channels[2] + channels[3]) / 4;
  return { luma, channels, channelMean, ssim: Math.min(luma, channelMean) };
}

/** Headline structural similarity in (-1, 1]; 1 for identical images. See `ssimScores` for the parts. */
export function ssim(a: RgbaImage, b: RgbaImage): number {
  return ssimScores(a, b).ssim;
}

// --- perceptual hashes ---------------------------------------------------------------------------

/** Luminance plane box-averaged to `width` x `height` (pure JS, exact area weights per source pixel). */
function lumaGrid(image: RgbaImage, width: number, height: number): Float64Array {
  const luma = plane(image, "luma");
  const out = new Float64Array(width * height);
  for (let gy = 0; gy < height; gy++) {
    const y0 = (gy * image.height) / height;
    const y1 = ((gy + 1) * image.height) / height;
    for (let gx = 0; gx < width; gx++) {
      const x0 = (gx * image.width) / width;
      const x1 = ((gx + 1) * image.width) / width;
      let sum = 0;
      let weight = 0;
      for (let y = Math.floor(y0); y < Math.min(image.height, Math.ceil(y1)); y++) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0);
        for (let x = Math.floor(x0); x < Math.min(image.width, Math.ceil(x1)); x++) {
          const w = wy * (Math.min(x + 1, x1) - Math.max(x, x0));
          sum += luma[y * image.width + x]! * w;
          weight += w;
        }
      }
      out[gy * width + gx] = weight === 0 ? 0 : sum / weight;
    }
  }
  return out;
}

function bitsToHex(bits: readonly boolean[]): string {
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) {
    hex += ((bits[i] ? 8 : 0) | (bits[i + 1] ? 4 : 0) | (bits[i + 2] ? 2 : 0) | (bits[i + 3] ? 1 : 0)).toString(16);
  }
  return hex;
}

/** 64-bit difference hash (9x8 grid, left pixel brighter than its right neighbour) as 16 hex digits. */
export function dHash(image: RgbaImage): string {
  const grid = lumaGrid(image, 9, 8);
  const bits: boolean[] = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits.push(grid[y * 9 + x]! > grid[y * 9 + x + 1]!);
  return bitsToHex(bits);
}

/** 64-bit perceptual hash: 32x32 luminance grid, 2-D DCT-II, low 8x8 block against its median. */
export function perceptualHash(image: RgbaImage): string {
  const size = 32;
  const grid = lumaGrid(image, size, size);
  const basis: number[][] = [];
  for (let u = 0; u < 8; u++) {
    const row: number[] = [];
    for (let x = 0; x < size; x++) row.push(Math.cos(((2 * x + 1) * u * Math.PI) / (2 * size)));
    basis.push(row);
  }
  // Separable DCT: rows first (only the 8 lowest frequencies are needed), then columns.
  const rows = new Float64Array(size * 8);
  for (let y = 0; y < size; y++) {
    for (let u = 0; u < 8; u++) {
      let sum = 0;
      for (let x = 0; x < size; x++) sum += grid[y * size + x]! * basis[u]![x]!;
      rows[y * 8 + u] = sum;
    }
  }
  const coefficients: number[] = [];
  for (let v = 0; v < 8; v++) {
    for (let u = 0; u < 8; u++) {
      let sum = 0;
      for (let y = 0; y < size; y++) sum += rows[y * 8 + u]! * basis[v]![y]!;
      coefficients.push(sum);
    }
  }
  // The DC term dominates and says nothing about structure, so the median ignores it.
  const sorted = coefficients.slice(1).sort((x, y) => x - y);
  const median = (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.ceil((sorted.length - 1) / 2)]!) / 2;
  return bitsToHex(coefficients.map((value) => value > median));
}

/** Number of differing bits between two equal-length hex hashes. */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) throw new RangeError("Hashes must have the same length.");
  let bits = 0;
  for (let i = 0; i < a.length; i++) {
    let x = Number.parseInt(a[i]!, 16) ^ Number.parseInt(b[i]!, 16);
    while (x) {
      bits += x & 1;
      x >>= 1;
    }
  }
  return bits;
}

// --- one-call comparison -------------------------------------------------------------------------

export interface CompareOptions {
  /** Resample `b` to the size of `a` when they differ; without it a size mismatch throws. */
  readonly resizeToMatch?: boolean;
  /** Multiply colour by alpha before comparing, so texels behind alpha 0 are ignored. */
  readonly premultiplied?: boolean;
}

export interface ImageComparison {
  readonly width: number;
  readonly height: number;
  readonly mse: number;
  /** Infinity for identical images. */
  readonly psnr: number;
  readonly ssim: number;
  readonly ssimLuma: number;
  readonly ssimChannels: number;
  readonly maxAbs: number;
  /** Same size without resampling, and every channel value equal. */
  readonly identical: boolean;
  /** `b` was resampled to match `a`. */
  readonly resized: boolean;
  /** Hamming distance between the difference hashes (0-64). */
  readonly dHashDistance: number;
  /** Hamming distance between the perceptual hashes (0-64). */
  readonly pHashDistance: number;
}

async function asImage(input: RgbaImage | Uint8Array): Promise<RgbaImage> {
  return "data" in input && "width" in input ? input : decodeRgba(input);
}

export async function compareImages(
  a: RgbaImage | Uint8Array,
  b: RgbaImage | Uint8Array,
  options: CompareOptions = {},
): Promise<ImageComparison> {
  let left = await asImage(a);
  let right = await asImage(b);
  let resized = false;
  if (left.width !== right.width || left.height !== right.height) {
    if (!options.resizeToMatch) assertSameSize(left, right);
    right = await resizeRgba(right, left.width, left.height);
    resized = true;
  }
  if (options.premultiplied) {
    left = premultiplyAlpha(left);
    right = premultiplyAlpha(right);
  }
  const maxAbs = maxAbsDiff(left, right);
  // Bit-identical pixels score perfectly by definition; skipping the windows keeps a sweep over
  // hundreds of textures fast, because identity is the common case.
  const exact = maxAbs === 0;
  const scores = exact ? { luma: 1, channelMean: 1, ssim: 1 } : ssimScores(left, right);
  return {
    width: left.width,
    height: left.height,
    mse: exact ? 0 : mse(left, right),
    psnr: exact ? Infinity : psnr(left, right),
    ssim: scores.ssim,
    ssimLuma: scores.luma,
    ssimChannels: scores.channelMean,
    maxAbs,
    identical: exact && !resized,
    resized,
    dHashDistance: exact ? 0 : hammingDistance(dHash(left), dHash(right)),
    pHashDistance: exact ? 0 : hammingDistance(perceptualHash(left), perceptualHash(right)),
  };
}

// --- colour similarity of unlike views ---------------------------------------------------------------
//
// An editor thumbnail and our render of the same piece differ in camera, lighting, ground and
// background, so pixel metrics such as SSIM say nothing useful. What can still be compared honestly
// is the colour of the object itself: the mean colour in Lab, and how the object's pixels distribute
// over colour and hue. It answers "is this roughly the same colour of thing", not "is it the same".

const PALETTE_STEP = 16;
const PALETTE_MIN_SHARE = 0.004;
const BACKGROUND_TOLERANCE = 18;
/** An object smaller than this share of the image is too small to describe by colour. */
export const MIN_OBJECT_COVERAGE = 0.002;
/** Mean-colour distance (CIE76 delta E) at which the mean-colour component reaches 0. */
const DELTA_E_ZERO = 50;
const HUE_BINS = 24;

/**
 * Marks object pixels: those that are not close to one of the colours the image border is made of.
 * A flat studio background has one such colour; an editor thumbnail's checkered floor and sky have a
 * handful. Pixels that are mostly transparent are background.
 */
export function objectMask(image: RgbaImage, tolerance = BACKGROUND_TOLERANCE): Uint8Array {
  const { width, height, data } = image;
  const bins = new Map<number, { count: number; r: number; g: number; b: number }>();
  let borderPixels = 0;
  const addBorder = (x: number, y: number): void => {
    const o = (y * width + x) * 4;
    if (data[o + 3]! < 128) return;
    const key = ((data[o]! >> 4) << 8) | ((data[o + 1]! >> 4) << 4) | (data[o + 2]! >> 4);
    const bin = bins.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    bin.count++;
    bin.r += data[o]!;
    bin.g += data[o + 1]!;
    bin.b += data[o + 2]!;
    bins.set(key, bin);
    borderPixels++;
  };
  for (let x = 0; x < width; x++) {
    addBorder(x, 0);
    addBorder(x, height - 1);
  }
  for (let y = 1; y < height - 1; y++) {
    addBorder(0, y);
    addBorder(width - 1, y);
  }
  const palette: [number, number, number][] = [];
  for (const bin of bins.values()) {
    if (bin.count >= Math.max(2, borderPixels * PALETTE_MIN_SHARE)) {
      palette.push([bin.r / bin.count, bin.g / bin.count, bin.b / bin.count]);
    }
  }
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    if (data[o + 3]! < 128) continue;
    let background = false;
    for (const [r, g, b] of palette) {
      if (Math.abs(data[o]! - r) <= tolerance && Math.abs(data[o + 1]! - g) <= tolerance && Math.abs(data[o + 2]! - b) <= tolerance) {
        background = true;
        break;
      }
    }
    mask[i] = background ? 0 : 1;
  }
  return mask;
}

export interface MaskFill {
  /** Pixels set in the mask. */
  readonly pixels: number;
  /** Area of the tight bounding box around the set pixels; 0 for an empty mask. */
  readonly boundingBox: number;
  /** `pixels / boundingBox`; 1 means the set pixels fill their box (a flat card). 0 for an empty mask. */
  readonly fillRatio: number;
}

/**
 * How much of its own bounding box a binary mask fills. A flat card fills its box (ratio 1); a ragged
 * cut-out — a grass blade card, a needle spray — leaves gaps and sits well below 1. Scale-invariant, so
 * a large editor thumbnail and a small render of the same piece can be compared directly.
 */
export function maskFillRatio(mask: Uint8Array, width: number, height: number): MaskFill {
  let pixels = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      pixels++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const boundingBox = maxX < 0 ? 0 : (maxX - minX + 1) * (maxY - minY + 1);
  return { pixels, boundingBox, fillRatio: boundingBox === 0 ? 0 : pixels / boundingBox };
}

function srgbToLinear(value: number): number {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** sRGB (0-255) to CIE L*a*b*, D65. */
export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f((0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047);
  const fy = f(0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb);
  const fz = f((0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

interface ObjectColour {
  pixels: number;
  coverage: number;
  meanLab: [number, number, number];
  colourHistogram: Float64Array;
  hueHistogram: Float64Array;
}

function describeObject(image: RgbaImage, mask: Uint8Array): ObjectColour {
  const colourHistogram = new Float64Array(512);
  const hueHistogram = new Float64Array(HUE_BINS + 1);
  let pixels = 0;
  let l = 0;
  let a = 0;
  let bb = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const o = i * 4;
    const r = image.data[o]!;
    const g = image.data[o + 1]!;
    const b = image.data[o + 2]!;
    pixels++;
    const lab = rgbToLab(r, g, b);
    l += lab[0];
    a += lab[1];
    bb += lab[2];
    colourHistogram[((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5)]! += 1;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max < 25 || (max - min) / max < 0.1) {
      hueHistogram[HUE_BINS]! += 1;
    } else {
      const d = max - min;
      let hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      if (hue < 0) hue += 6;
      hueHistogram[Math.min(HUE_BINS - 1, Math.floor((hue / 6) * HUE_BINS))]! += 1;
    }
  }
  if (pixels > 0) {
    for (const histogram of [colourHistogram, hueHistogram]) {
      for (let i = 0; i < histogram.length; i++) histogram[i]! /= pixels;
    }
  }
  return {
    pixels,
    coverage: pixels / Math.max(1, mask.length),
    meanLab: pixels > 0 ? [l / pixels, a / pixels, bb / pixels] : [0, 0, 0],
    colourHistogram,
    hueHistogram,
  };
}

function intersection(a: Float64Array, b: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.min(a[i]!, b[i]!);
  return sum;
}

export interface ColourSimilarity {
  /** 0..1, higher is more alike in object colour. 0 when `comparable` is false. */
  readonly similarity: number;
  /** CIE76 distance between the objects' mean Lab colours. */
  readonly meanColourDelta: number;
  /** 1 - deltaE / 50, floored at 0. */
  readonly meanColourScore: number;
  /** Intersection of the 8x8x8 RGB histograms of the object pixels. */
  readonly colourHistogramIntersection: number;
  /** Intersection of the 24-bin hue histograms plus one neutral bin. */
  readonly hueHistogramIntersection: number;
  readonly objectCoverage: { readonly a: number; readonly b: number };
  /** False when either image has too little object to describe; the numbers are then not meaningful. */
  readonly comparable: boolean;
}

/**
 * "Colour similarity" between two views of one piece, on the object pixels only (each image's
 * border-colour background is masked out). The score is 0.4 mean-colour + 0.3 colour histogram +
 * 0.3 hue histogram. It ignores shape, shading, camera and lighting, so it is a sanity signal, not a match.
 */
/**
 * `maskA` replaces the first image's border-palette object mask: an editor thumbnail's cast shadow is not the piece, and left in it
 * the shadow's blue-grey drags the mean colour and hue histogram (the Fern Collection read 0.28-0.33 "similarity" at fidelity 93).
 */
export function colourSimilarity(a: RgbaImage, b: RgbaImage, maskA?: Uint8Array): ColourSimilarity {
  const left = describeObject(a, maskA ?? objectMask(a));
  const right = describeObject(b, objectMask(b));
  const comparable = left.coverage >= MIN_OBJECT_COVERAGE && right.coverage >= MIN_OBJECT_COVERAGE;
  const delta = comparable
    ? Math.hypot(left.meanLab[0] - right.meanLab[0], left.meanLab[1] - right.meanLab[1], left.meanLab[2] - right.meanLab[2])
    : Number.NaN;
  const meanColourScore = comparable ? Math.max(0, 1 - delta / DELTA_E_ZERO) : 0;
  const colourHistogramIntersection = comparable ? intersection(left.colourHistogram, right.colourHistogram) : 0;
  const hueHistogramIntersection = comparable ? intersection(left.hueHistogram, right.hueHistogram) : 0;
  return {
    similarity: comparable ? 0.4 * meanColourScore + 0.3 * colourHistogramIntersection + 0.3 * hueHistogramIntersection : 0,
    meanColourDelta: delta,
    meanColourScore,
    colourHistogramIntersection,
    hueHistogramIntersection,
    objectCoverage: { a: left.coverage, b: right.coverage },
    comparable,
  };
}
