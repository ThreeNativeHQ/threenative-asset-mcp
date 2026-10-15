/**
 * Unity textures to 8-bit RGBA, and the pixel recipes that turn Unity's channel layouts into glTF's.
 *
 * Decoders: `sharp` reads PNG, JPEG, TIFF, GIF and WebP. It cannot read TGA or PSD (checked against
 * sharp 0.35.4: both fail with "unsupported image format"), so TGA is decoded here and PSD goes through
 * `ag-psd` (MIT). Nothing else in this module touches colour management: bytes stay bytes. A normal map
 * or a mask is therefore linear by construction, and only a texture that Unity marks `sRGBTexture: 0`
 * in a colour slot is re-encoded.
 */
import { readFile } from "node:fs/promises";
import { extname } from "node:path/posix";

import { initializeCanvas, readPsd } from "ag-psd";
import sharp from "sharp";

export class UnityTextureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnityTextureError";
  }
}

export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  /** 8-bit RGBA, row-major from the top. */
  readonly data: Buffer;
}

export type Channel = "r" | "g" | "b" | "a";
const CHANNEL_INDEX: Record<Channel, number> = { r: 0, g: 1, b: 2, a: 3 };

/** What Unity says about a texture file (its `TextureImporter`). */
export interface TextureSettings {
  readonly srgb: boolean;
  /** `textureType: 1`, or a texture bound to a normal-map slot. */
  readonly normalMap: boolean;
  readonly convertToNormalMap: boolean;
  /** `heightScale` ("Bumpiness"); only used with `convertToNormalMap`. */
  readonly heightScale: number;
  /** `normalMapFilter`: 0 smooth, 1 sharp. */
  readonly normalMapFilter: number;
  readonly flipGreenChannel: boolean;
  /** Unity's own per-platform cap, recorded in the report only. */
  readonly unityMaxTextureSize?: number;
}

// ---------------------------------------------------------------- decoding

/** Largest texture, in pixels, any decoder allocates for (2^27: 16384x8192). A header can claim far more than its file holds. */
export const MAX_TEXTURE_PIXELS = 2 ** 27;

function assertPixelBudget(width: number, height: number, maxPixels: number, what: string): void {
  if (width * height > maxPixels) {
    throw new UnityTextureError(`${what} is ${width}x${height} pixels, more than the ${maxPixels} pixel limit.`);
  }
}

/** Uncompressed and RLE TGA: colour-mapped, true-colour (15/16/24/32 bit) and grey, either origin. */
export function decodeTga(buffer: Buffer, maxPixels = MAX_TEXTURE_PIXELS): DecodedImage {
  if (buffer.length < 18) throw new UnityTextureError("TGA file is shorter than its header.");
  const idLength = buffer[0]!;
  const mapType = buffer[1]!;
  const type = buffer[2]!;
  const mapFirst = buffer.readUInt16LE(3);
  const mapLength = buffer.readUInt16LE(5);
  const mapDepth = buffer[7]!;
  const width = buffer.readUInt16LE(12);
  const height = buffer.readUInt16LE(14);
  const depth = buffer[16]!;
  const descriptor = buffer[17]!;
  const base = type & 7;
  const rle = type >= 9;
  if (![1, 2, 3].includes(base) || width === 0 || height === 0) {
    throw new UnityTextureError(`TGA image type ${type} (${width}x${height}) is not supported.`);
  }
  if (![8, 15, 16, 24, 32].includes(depth) || (base === 1 && depth !== 8)) {
    throw new UnityTextureError(`TGA pixel depth ${depth} is not supported.`);
  }
  assertPixelBudget(width, height, maxPixels, "The TGA");
  const bytesPerPixel = Math.ceil(depth / 8);
  let position = 18 + idLength;
  const palette: number[][] = [];
  if (mapType === 1) {
    const entryBytes = Math.ceil(mapDepth / 8);
    for (let index = 0; index < mapLength; index += 1) {
      palette[mapFirst + index] = readTgaPixel(buffer, position, mapDepth, 0);
      position += entryBytes;
    }
  }
  const pixel = (at: number): number[] =>
    base === 1 ? (palette[buffer[at]!] ?? [0, 0, 0, 255]) : readTgaPixel(buffer, at, depth, base === 3 ? 3 : descriptor & 15);

  const count = width * height;
  const decoded = Buffer.alloc(count * 4);
  let written = 0;
  const put = (values: number[]): void => {
    decoded[written * 4] = values[0]!;
    decoded[written * 4 + 1] = values[1]!;
    decoded[written * 4 + 2] = values[2]!;
    decoded[written * 4 + 3] = values[3]!;
    written += 1;
  };
  if (!rle) {
    if (buffer.length < position + count * bytesPerPixel) throw new UnityTextureError("TGA pixel data is truncated.");
    for (; written < count; ) put(pixel(position + written * bytesPerPixel));
  } else {
    while (written < count) {
      if (position >= buffer.length) throw new UnityTextureError("TGA run-length data is truncated.");
      const header = buffer[position++]!;
      const run = (header & 0x7f) + 1;
      if (header & 0x80) {
        const values = pixel(position);
        position += bytesPerPixel;
        for (let index = 0; index < run && written < count; index += 1) put(values);
      } else {
        for (let index = 0; index < run && written < count; index += 1) {
          put(pixel(position));
          position += bytesPerPixel;
        }
      }
    }
  }
  // Bit 5 set: rows run top to bottom. Clear (the common case): bottom to top. Bit 4: right to left.
  const topDown = (descriptor & 0x20) !== 0;
  const rightToLeft = (descriptor & 0x10) !== 0;
  if (topDown && !rightToLeft) return { width, height, data: decoded };
  const data = Buffer.alloc(count * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceRow = topDown ? y : height - 1 - y;
    for (let x = 0; x < width; x += 1) {
      const sourceX = rightToLeft ? width - 1 - x : x;
      decoded.copy(data, (y * width + x) * 4, (sourceRow * width + sourceX) * 4, (sourceRow * width + sourceX) * 4 + 4);
    }
  }
  return { width, height, data };
}

/** One TGA pixel as RGBA. `alphaBits` is the descriptor's attribute count (3 marks a grey image). */
function readTgaPixel(buffer: Buffer, at: number, depth: number, alphaBits: number): number[] {
  if (depth === 8) return [buffer[at]!, buffer[at]!, buffer[at]!, 255];
  if (depth === 16 && alphaBits === 3) return [buffer[at]!, buffer[at]!, buffer[at]!, buffer[at + 1]!];
  if (depth === 15 || depth === 16) {
    const value = buffer.readUInt16LE(at);
    const expand = (bits: number): number => Math.round(((bits & 31) * 255) / 31);
    return [expand(value >> 10), expand(value >> 5), expand(value), depth === 16 && alphaBits === 1 && (value & 0x8000) === 0 ? 0 : 255];
  }
  // 24 and 32 bit store BGR(A).
  return [buffer[at + 2]!, buffer[at + 1]!, buffer[at]!, depth === 32 ? buffer[at + 3]! : 255];
}

let psdReady = false;
function decodePsd(buffer: Buffer, maxPixels: number): DecodedImage {
  if (buffer.length >= 22) assertPixelBudget(buffer.readUInt32BE(18), buffer.readUInt32BE(14), maxPixels, "The PSD");
  if (!psdReady) {
    // ag-psd wants a canvas factory even when `useImageData` keeps it from drawing on one.
    initializeCanvas(
      () => {
        throw new UnityTextureError("PSD decoding needs no canvas; a canvas was requested.");
      },
      (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: "srgb" }) as ImageData,
    );
    psdReady = true;
  }
  const psd = readPsd(buffer, { skipLayerImageData: true, skipThumbnail: true, useImageData: true });
  if (!psd.imageData) {
    throw new UnityTextureError("The PSD has no flattened composite image. Save it again with Maximize Compatibility on.");
  }
  const { width, height, data } = psd.imageData;
  return { width, height, data: Buffer.from(data.buffer, data.byteOffset, data.byteLength) };
}

async function decodeWithSharp(buffer: Buffer, maxPixels: number): Promise<DecodedImage> {
  const options = { limitInputPixels: maxPixels };
  const metadata = await sharp(buffer, options).metadata();
  const pipeline = sharp(buffer, options);
  if (metadata.space === "cmyk") pipeline.toColourspace("srgb");
  const { data, info } = await pipeline.raw({ depth: "uchar" }).toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  if (channels === 4) return { width, height, data };
  const rgba = Buffer.alloc(width * height * 4, 255);
  for (let index = 0; index < width * height; index += 1) {
    const from = index * channels;
    const grey = channels <= 2;
    rgba[index * 4] = data[from]!;
    rgba[index * 4 + 1] = grey ? data[from]! : data[from + 1]!;
    rgba[index * 4 + 2] = grey ? data[from]! : data[from + 2]!;
    if (channels === 2) rgba[index * 4 + 3] = data[from + 1]!;
  }
  return { width, height, data: rgba };
}

/** Decodes a Unity texture file. `unityPath` supplies the extension, because packaged files have none. */
export async function decodeTexture(file: string, unityPath: string, maxPixels = MAX_TEXTURE_PIXELS): Promise<DecodedImage> {
  const extension = extname(unityPath).toLowerCase();
  const buffer = await readFile(file);
  try {
    if (extension === ".tga") return decodeTga(buffer, maxPixels);
    if (extension === ".psd" || buffer.subarray(0, 4).toString("latin1") === "8BPS") return decodePsd(buffer, maxPixels);
    return await decodeWithSharp(buffer, maxPixels);
  } catch (error) {
    if (error instanceof UnityTextureError) throw error;
    throw new UnityTextureError(
      `${extension || "this"} texture could not be decoded (${error instanceof Error ? error.message.split("\n")[0] : "unknown error"}).`,
    );
  }
}

// ---------------------------------------------------------------- pixel operations

export async function resizeImage(image: DecodedImage, width: number, height: number, kernel: "lanczos3" | "cubic" = "lanczos3"): Promise<DecodedImage> {
  if (image.width === width && image.height === height) return image;
  const { data, info } = await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 4 } })
    .resize({ width, height, fit: "fill", kernel })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

/** Scales the longest edge down to `maxEdge`. Never scales up. */
export async function limitTextureSize(image: DecodedImage, maxEdge: number | undefined): Promise<DecodedImage> {
  if (maxEdge === undefined || Math.max(image.width, image.height) <= maxEdge) return image;
  const scale = maxEdge / Math.max(image.width, image.height);
  return resizeImage(image, Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
}

export async function encodePng(image: DecodedImage): Promise<Buffer> {
  let opaque = true;
  for (let at = 3; at < image.data.length; at += 4) {
    if (image.data[at] !== 255) {
      opaque = false;
      break;
    }
  }
  const pipeline = sharp(image.data, { raw: { width: image.width, height: image.height, channels: 4 } });
  return (opaque ? pipeline.removeAlpha() : pipeline).png({ compressionLevel: 6 }).toBuffer();
}

const srgbEncode = (linear: number): number => {
  const value = linear / 255;
  return Math.round(255 * (value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055));
};

/** A colour texture Unity samples as linear (`sRGBTexture: 0`) must be stored sRGB-encoded for glTF. */
export function encodeLinearAsSrgb(image: DecodedImage): DecodedImage {
  const table = Uint8Array.from({ length: 256 }, (_, value) => srgbEncode(value));
  const data = Buffer.from(image.data);
  for (let at = 0; at < data.length; at += 4) {
    data[at] = table[data[at]!]!;
    data[at + 1] = table[data[at + 1]!]!;
    data[at + 2] = table[data[at + 2]!]!;
  }
  return { ...image, data };
}

/** Unity's `flipGreenChannel` (a DirectX-style normal map). */
export function flipGreen(image: DecodedImage): DecodedImage {
  const data = Buffer.from(image.data);
  for (let at = 1; at < data.length; at += 4) data[at] = 255 - data[at]!;
  return { ...image, data };
}

/**
 * Unity's `convertToNormalMap`: the height is the mean of R, G and B, scaled by `(width + height) * (10^bumpiness - 1) / 100`.
 * The slope is taken with wrap-around, from `4 * (next - previous)` (smooth) or a 3x3 Sobel kernel (sharp), and the normal is
 * `normalize(-dx, -dy, 1)` stored as `value * 0.5 + 0.5`. Image rows run top to bottom here and bottom to top in Unity, so
 * Unity's `y + 1` is the row above. Measured on Unity 6000.0.64f1 (PRD-620); the corpus holds no texture that uses it.
 */
export function heightToNormal(image: DecodedImage, bumpiness: number, sharp: boolean): DecodedImage {
  const { width, height } = image;
  const gain = ((width + height) * (10 ** bumpiness - 1)) / 100 / 255 / 3;
  const heights = new Float32Array(width * height);
  for (let at = 0; at < heights.length; at += 1) heights[at] = (image.data[at * 4]! + image.data[at * 4 + 1]! + image.data[at * 4 + 2]!) * gain;
  const wrap = (value: number, size: number): number => (value + size) % size;
  const at = (x: number, y: number): number => heights[wrap(y, height) * width + wrap(x, width)]!;
  const data = Buffer.alloc(width * height * 4, 255);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // Unity's "next row" (y + 1) is the row above in this top-down image.
      const up = y - 1;
      const down = y + 1;
      let dx: number;
      let dy: number;
      if (sharp) {
        dx = 2 * at(x + 1, y) - 2 * at(x - 1, y) + at(x + 1, up) + at(x + 1, down) - at(x - 1, up) - at(x - 1, down);
        dy = 2 * at(x, up) - 2 * at(x, down) + at(x - 1, up) + at(x + 1, up) - at(x - 1, down) - at(x + 1, down);
      } else {
        dx = 4 * (at(x + 1, y) - at(x - 1, y));
        dy = 4 * (at(x, up) - at(x, down));
      }
      const length = Math.sqrt(dx * dx + dy * dy + 1);
      const out = (y * width + x) * 4;
      data[out] = clamp8(((-dx / length + 1) / 2) * 255);
      data[out + 1] = clamp8(((-dy / length + 1) / 2) * 255);
      data[out + 2] = clamp8(((1 / length + 1) / 2) * 255);
    }
  }
  return { width, height, data };
}

// ---------------------------------------------------------------- recipes

export interface ChannelRead {
  readonly texture: string;
  readonly channel: Channel;
  /** Unity remaps the stored value as `lerp(min, max, value)`. A plain scale is `min: 0, max: scale`. */
  readonly min: number;
  readonly max: number;
}

/**
 * How to build one glTF image. `copy` keeps a Unity texture as it is. The other two re-pack channels:
 * glTF wants roughness in G and metallic in B of one texture, and ambient occlusion in R.
 */
export type ImageRecipe =
  | { readonly kind: "copy"; readonly texture: string; readonly role: "color" | "data" | "normal" }
  | {
      readonly kind: "metallicRoughness";
      readonly metallic?: ChannelRead;
      readonly metallicConstant: number;
      readonly smoothness?: ChannelRead;
      readonly smoothnessConstant: number;
    }
  | { readonly kind: "occlusion"; readonly read: ChannelRead };

export function recipeKey(recipe: ImageRecipe): string {
  return JSON.stringify(recipe);
}

export function recipeTextures(recipe: ImageRecipe): string[] {
  switch (recipe.kind) {
    case "copy":
      return [recipe.texture];
    case "occlusion":
      return [recipe.read.texture];
    case "metallicRoughness":
      return [...new Set([recipe.metallic?.texture, recipe.smoothness?.texture].filter((guid): guid is string => guid !== undefined))];
  }
}

export interface RecipeContext {
  /** Decoded texture, already limited to `maxTextureSize`. */
  readonly load: (guid: string) => Promise<DecodedImage>;
  readonly settings: (guid: string) => TextureSettings;
}

const clamp8 = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));

/** Builds the image a recipe describes. Inputs of different sizes are resampled to the largest. */
export async function renderRecipe(recipe: ImageRecipe, context: RecipeContext): Promise<DecodedImage> {
  if (recipe.kind === "copy") {
    let image = await context.load(recipe.texture);
    const settings = context.settings(recipe.texture);
    if (recipe.role === "normal") {
      if (settings.convertToNormalMap) image = heightToNormal(image, settings.heightScale, settings.normalMapFilter === 1);
      return settings.flipGreenChannel ? flipGreen(image) : image;
    }
    if (recipe.role === "color" && !settings.srgb) image = encodeLinearAsSrgb(image);
    return image;
  }
  const reads = recipe.kind === "occlusion" ? [recipe.read] : [recipe.metallic, recipe.smoothness].filter((read): read is ChannelRead => read !== undefined);
  const loaded = new Map<string, DecodedImage>();
  for (const read of reads) if (!loaded.has(read.texture)) loaded.set(read.texture, await context.load(read.texture));
  const width = Math.max(...[...loaded.values()].map((image) => image.width), 1);
  const height = Math.max(...[...loaded.values()].map((image) => image.height), 1);
  for (const [guid, image] of loaded) loaded.set(guid, await resizeImage(image, width, height, "cubic"));
  const value = (read: ChannelRead | undefined, constant: number, at: number): number => {
    if (!read) return constant;
    const stored = loaded.get(read.texture)!.data[at * 4 + CHANNEL_INDEX[read.channel]]! / 255;
    return read.min + (read.max - read.min) * stored;
  };
  const data = Buffer.alloc(width * height * 4, 255);
  for (let at = 0; at < width * height; at += 1) {
    if (recipe.kind === "occlusion") {
      const occlusion = clamp8(value(recipe.read, 1, at) * 255);
      data[at * 4] = data[at * 4 + 1] = data[at * 4 + 2] = occlusion;
    } else {
      data[at * 4] = 255;
      data[at * 4 + 1] = clamp8((1 - value(recipe.smoothness, recipe.smoothnessConstant, at)) * 255);
      data[at * 4 + 2] = clamp8(value(recipe.metallic, recipe.metallicConstant, at) * 255);
    }
  }
  return { width, height, data };
}
