import { open, readdir, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import sharp from "sharp";

/**
 * The content-browser thumbnail an Unreal editor embeds in an uncooked `.uasset` (an
 * `FObjectThumbnail`: int32 width, int32 height, int32 compressedSize, then the PNG or JPEG bytes).
 * It is the editor's own render of that one asset, so it is a per-piece "original" to set beside our
 * import of the same piece.
 *
 * Channel order. The stored image has red and blue exchanged (consistent with the editor writing its BGRA `FColor`
 * buffer as if it were RGBA; the engine reads it back the same way, so it never shows; the mechanism is inferred,
 * the swap is measured). Measured on the Soul Cave pack (UE 4.18, package legacy version -7): for each of the 37 texture
 * packages checked, the thumbnail is closer to UE Viewer's export of the same texture with red and blue swapped
 * than as stored (34 of them by a factor of 1.5 or more, the other 3 near-neutral or not matching either way), and
 * a rock texture that exports brown has a blue-grey stored thumbnail. Packages whose summary says UE4 are
 * therefore returned with red and blue swapped back. UE5 packages (legacy version -8 and below) and packages
 * without a readable summary are returned as stored: the order there is unverified.
 *
 * A PNG or JPEG found in a package is accepted only when the 12 bytes in front of it parse as that
 * record and agree with the image: little-endian width and height equal the image header's, and
 * `compressedSize` covers the image without running past the end of the file. An embedded texture
 * (source art, a bulk-data PNG) has no such record and is never returned.
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const RECORD_BYTES = 12;
const MAX_EDGE = 4096;
/** The thumbnail sits in the package header region; the rest of a package can be hundreds of MB. */
const SCAN_BYTES = 16 * 1024 * 1024;

export interface PackageThumbnail {
  readonly format: "png" | "jpeg";
  readonly width: number;
  readonly height: number;
  readonly bytes: Buffer;
  /** True when `bytes` had red and blue exchanged back (see the channel-order note above); it is then a PNG. */
  readonly channelsSwapped?: boolean;
}

const PACKAGE_TAG = 0x9e2a83c1;

/** True when the package summary at the start of `head` is a UE4 one (legacy file version -7 .. -1). */
export function packageStoresSwappedThumbnail(head: Buffer): boolean {
  if (head.length < 8 || head.readUInt32LE(0) !== PACKAGE_TAG) return false;
  const legacy = head.readInt32LE(4);
  return legacy <= -1 && legacy >= -7;
}

/** The same image with its red and blue channels exchanged, as a PNG (alpha kept). */
export async function swapRedBlue(image: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let at = 0; at + 3 < data.length; at += 4) {
    const red = data[at]!;
    data[at] = data[at + 2]!;
    data[at + 2] = red;
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

/** Length of the PNG that starts at `start`, ending exactly after IEND; undefined when truncated. */
function pngEnd(buffer: Buffer, start: number): { length: number; width: number; height: number } | undefined {
  // Signature, then IHDR: length 13, "IHDR", width, height.
  if (start + 33 > buffer.length) return undefined;
  if (buffer.readUInt32BE(start + 8) !== 13 || buffer.toString("latin1", start + 12, start + 16) !== "IHDR") {
    return undefined;
  }
  const width = buffer.readUInt32BE(start + 16);
  const height = buffer.readUInt32BE(start + 20);
  let offset = start + 8;
  while (offset + 12 <= buffer.length) {
    const size = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const next = offset + 12 + size;
    if (next > buffer.length) return undefined;
    if (type === "IEND") return { length: next - start, width, height };
    offset = next;
  }
  return undefined;
}

/** Frame size from the first SOF marker of a JPEG that starts at `start`. */
function jpegSize(buffer: Buffer, start: number, end: number): { width: number; height: number } | undefined {
  let offset = start + 2;
  while (offset + 4 <= end) {
    if (buffer[offset] !== 0xff) return undefined;
    const marker = buffer[offset + 1]!;
    if (marker === 0xff) {
      offset++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return undefined; // image data before any frame header
    const size = buffer.readUInt16BE(offset + 2);
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (offset + 9 > end) return undefined;
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
    }
    offset += 2 + size;
  }
  return undefined;
}

function recordAt(buffer: Buffer, signatureAt: number, fileSize: number) {
  if (signatureAt < RECORD_BYTES) return undefined;
  const width = buffer.readInt32LE(signatureAt - 12);
  const height = buffer.readInt32LE(signatureAt - 8);
  const compressedSize = buffer.readInt32LE(signatureAt - 4);
  if (width <= 0 || height <= 0 || width > MAX_EDGE || height > MAX_EDGE || compressedSize <= 0) return undefined;
  return { width, height, compressedSize, remaining: fileSize - signatureAt };
}

/** Pure scan over package bytes. `fileSize` is the whole file's length, which may exceed `buffer`. */
export function findThumbnailInPackage(buffer: Buffer, fileSize = buffer.length): PackageThumbnail | undefined {
  for (const [format, signature] of [["png", PNG_SIGNATURE], ["jpeg", JPEG_SIGNATURE]] as const) {
    let at = buffer.indexOf(signature);
    while (at !== -1) {
      const record = recordAt(buffer, at, fileSize);
      if (record !== undefined && record.compressedSize <= record.remaining) {
        if (format === "png") {
          const image = pngEnd(buffer, at);
          if (
            image !== undefined &&
            image.width === record.width &&
            image.height === record.height &&
            record.compressedSize >= image.length
          ) {
            return { format, width: image.width, height: image.height, bytes: Buffer.from(buffer.subarray(at, at + image.length)) };
          }
        } else {
          const end = at + record.compressedSize;
          if (end <= buffer.length && buffer[end - 2] === 0xff && buffer[end - 1] === 0xd9) {
            const size = jpegSize(buffer, at, end);
            if (size !== undefined && size.width === record.width && size.height === record.height) {
              return { format, width: size.width, height: size.height, bytes: Buffer.from(buffer.subarray(at, end)) };
            }
          }
        }
      }
      at = buffer.indexOf(signature, at + 1);
    }
  }
  return undefined;
}

/**
 * The editor thumbnail of an uncooked `.uasset` as PNG/JPEG bytes, in true colour order (see above), or `undefined` when the package
 * has none, is not a `.uasset`, or cannot be read. UE5 packages are accepted when the same record
 * validates; there is no version-specific path.
 */
export async function extractPackageThumbnail(uassetPath: string): Promise<Buffer | undefined> {
  return (await readPackageThumbnail(uassetPath))?.bytes;
}

export async function readPackageThumbnail(uassetPath: string): Promise<PackageThumbnail | undefined> {
  if (!uassetPath.toLowerCase().endsWith(".uasset")) return undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const { size } = await stat(uassetPath);
    handle = await open(uassetPath, "r");
    const head = Buffer.alloc(Math.min(size, SCAN_BYTES));
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const found = findThumbnailInPackage(head.subarray(0, bytesRead), size);
    if (found === undefined || !packageStoresSwappedThumbnail(head.subarray(0, bytesRead))) return found;
    return { format: "png", width: found.width, height: found.height, bytes: await swapRedBlue(found.bytes), channelsSwapped: true };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** The part of an import report's model entry that maps a GLB back to its source package. */
export interface ThumbnailModel {
  readonly name: string;
  /** Source package path relative to the source directory, e.g. `Content/Pack/SM_Rock.uasset`. */
  readonly package: string;
  /** GLB path relative to the promoted output directory. */
  readonly glb: string;
}

async function uassetsByStem(sourceDir: string): Promise<Map<string, string[]>> {
  const index = new Map<string, string[]>();
  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.toLowerCase().endsWith(".uasset")) {
        const stem = entry.name.replace(/\.uasset$/i, "");
        index.set(stem, [...(index.get(stem) ?? []), path]);
      }
    }
  };
  await walk(sourceDir);
  return index;
}

/**
 * Editor thumbnails keyed by each model's GLB path (as in the report). A model's source package is
 * `sourceDir/<package>`; when that file is gone, the model's name is matched against `.uasset` file
 * stems under `sourceDir`, and a name that matches more than one package is skipped rather than
 * guessed. Models whose package carries no valid thumbnail are absent from the map.
 */
export async function findThumbnails(options: {
  sourceDir: string;
  report: { readonly models: readonly ThumbnailModel[] };
}): Promise<Map<string, Buffer>> {
  const root = resolve(options.sourceDir);
  const result = new Map<string, Buffer>();
  let index: Map<string, string[]> | undefined;
  for (const model of options.report.models) {
    let path: string | undefined = resolve(root, model.package);
    const inside = path === root || path.startsWith(root + sep);
    const exists = inside && (await stat(path).then((s) => s.isFile(), () => false));
    if (!exists) {
      index ??= await uassetsByStem(root);
      const matches = index.get(model.name) ?? [];
      path = matches.length === 1 ? matches[0] : undefined;
    }
    if (path === undefined) continue;
    const bytes = await extractPackageThumbnail(path);
    if (bytes !== undefined) result.set(model.glb, bytes);
  }
  return result;
}
