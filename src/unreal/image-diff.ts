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
  const scores = ssimScores(left, right);
  const maxAbs = maxAbsDiff(left, right);
  return {
    width: left.width,
    height: left.height,
    mse: mse(left, right),
    psnr: psnr(left, right),
    ssim: scores.ssim,
    ssimLuma: scores.luma,
    ssimChannels: scores.channelMean,
    maxAbs,
    identical: maxAbs === 0 && !resized,
    resized,
    dHashDistance: hammingDistance(dHash(left), dHash(right)),
    pHashDistance: hammingDistance(perceptualHash(left), perceptualHash(right)),
  };
}
