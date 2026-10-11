/**
 * Raw RGBA16F data textures: the stored samples of one Unreal `TSF_RGBA16F` source, unchanged.
 *
 * A texture is two files: `<name>.rgba16f-le`, the pixels as little-endian IEEE 754 binary16 R, G, B, A
 * values, rows top to bottom, and `<name>.rgba16f.json`, the manifest that names its source and hashes the
 * bytes. Nothing is clamped, resized, tone-mapped or re-encoded, and no channel is interpreted: negative,
 * HDR, subnormal and alpha values stay exactly as Unreal stored them.
 *
 * This module is browser-safe (no Node built-ins). The producer and the importer check the same rules, and
 * the browser loader (`threenative-asset-mcp/data-texture`) reuses them with `crypto.subtle` for the hash.
 */

export const DATA_TEXTURE_FORMAT = "threenative-rgba16f-data-texture";
export const DATA_TEXTURE_VERSION = 1;
/** Bytes per pixel of TSF_RGBA16F: four 16-bit samples. */
export const RGBA16F_BYTES_PER_PIXEL = 8;
/** Largest payload accepted, matching the importer's 1 GiB per-artifact limit. */
export const RGBA16F_MAX_BYTES = 1024 ** 3;

export interface DataTextureManifest {
  readonly format: typeof DATA_TEXTURE_FORMAT;
  readonly version: typeof DATA_TEXTURE_VERSION;
  readonly name: string;
  readonly source: {
    /** Exact package key under the source root, e.g. `Pack/Content/A/T_X.uasset`. */
    readonly package: string;
    /** The exported Texture2D object the bytes came from. */
    readonly object: string;
    readonly objectPath: string;
    readonly class: "Texture2D";
    readonly sourceFormat: "TSF_RGBA16F";
    /** SHA-256 of the package file set (see `packageSetSha256`). */
    readonly sha256: string;
  };
  readonly data: {
    /** Basename of the binary, beside the manifest. */
    readonly file: string;
    readonly format: "RGBA16F";
    readonly layout: "little-endian-half4";
    readonly width: number;
    readonly height: number;
    readonly mips: 1;
    readonly slices: 1;
    readonly channels: 4;
    readonly bytesPerPixel: typeof RGBA16F_BYTES_PER_PIXEL;
    readonly bytes: number;
    readonly sha256: string;
    readonly srgb: false;
    readonly colorSpace: "none";
  };
  readonly provenance: {
    readonly converter: string;
    readonly unrealSource: string;
  };
  /** What the bytes do not claim: stated in the manifest and in the import report. */
  readonly limits: readonly string[];
}

/** A manifest or payload that does not meet the raw RGBA16F rules. The message says which rule. */
export class DataTextureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataTextureError";
  }
}

/** SHA-256 of a byte array as lowercase hex. Injected so the browser and Node can each supply their own. */
export type Sha256Hex = (bytes: Uint8Array) => Promise<string>;

const HEX_SHA256 = /^[0-9a-f]{64}$/;

export function dataTextureByteLength(width: number, height: number): number {
  return width * height * RGBA16F_BYTES_PER_PIXEL;
}

/**
 * Checks a parsed JSON value against the manifest rules and returns it typed. Unknown fields are refused, so a
 * newer producer cannot add meaning that an older consumer silently ignores.
 */
export function parseDataTextureManifest(value: unknown): DataTextureManifest {
  const root = plainObject(value, "manifest");
  exactKeys(root, ["format", "version", "name", "source", "data", "provenance", "limits"], "manifest");
  if (root.format !== DATA_TEXTURE_FORMAT) throw new DataTextureError(`manifest format is not ${DATA_TEXTURE_FORMAT}`);
  if (root.version !== DATA_TEXTURE_VERSION) throw new DataTextureError(`manifest version ${String(root.version)} is not supported`);
  const name = boundedString(root.name, "manifest name", 200);

  const source = plainObject(root.source, "source");
  exactKeys(source, ["package", "object", "objectPath", "class", "sourceFormat", "sha256"], "source");
  const sourcePackage = boundedString(source.package, "source package", 1024);
  if (!sourcePackage.endsWith(".uasset") || sourcePackage.includes("\\") || sourcePackage.startsWith("/") ||
    sourcePackage.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new DataTextureError("source package is not an exact relative .uasset key");
  }
  if (source.class !== "Texture2D") throw new DataTextureError("source class is not Texture2D");
  if (source.sourceFormat !== "TSF_RGBA16F") throw new DataTextureError("source format is not TSF_RGBA16F");
  const sourceSha256 = hexDigest(source.sha256, "source sha256");

  const data = plainObject(root.data, "data");
  exactKeys(
    data,
    ["file", "format", "layout", "width", "height", "mips", "slices", "channels", "bytesPerPixel", "bytes", "sha256", "srgb", "colorSpace"],
    "data",
  );
  const file = boundedString(data.file, "data file", 255);
  if (file === "." || file === ".." || file.includes("/") || file.includes("\\")) {
    throw new DataTextureError("data file is not a plain basename beside the manifest");
  }
  if (data.format !== "RGBA16F") throw new DataTextureError("data format is not RGBA16F");
  if (data.layout !== "little-endian-half4") throw new DataTextureError("data layout is not little-endian-half4");
  const width = dimension(data.width, "width");
  const height = dimension(data.height, "height");
  if (data.mips !== 1) throw new DataTextureError("data must hold exactly one mip");
  if (data.slices !== 1) throw new DataTextureError("data must hold exactly one slice");
  if (data.channels !== 4) throw new DataTextureError("data must hold four channels");
  if (data.bytesPerPixel !== RGBA16F_BYTES_PER_PIXEL) throw new DataTextureError("data must be 8 bytes per pixel");
  const bytes = dataTextureByteLength(width, height);
  if (data.bytes !== bytes) throw new DataTextureError(`data declares ${String(data.bytes)} bytes; ${width}x${height} RGBA16F is ${bytes}`);
  if (bytes > RGBA16F_MAX_BYTES) throw new DataTextureError("data exceeds the 1 GiB limit");
  const dataSha256 = hexDigest(data.sha256, "data sha256");
  if (data.srgb !== false) throw new DataTextureError("data is sRGB; raw RGBA16F values are linear and must not be decoded");
  if (data.colorSpace !== "none") throw new DataTextureError("data colour space is not none");

  const provenance = plainObject(root.provenance, "provenance");
  exactKeys(provenance, ["converter", "unrealSource"], "provenance");
  const limits = root.limits;
  if (!Array.isArray(limits) || !limits.every((limit) => typeof limit === "string")) {
    throw new DataTextureError("limits must be a list of strings");
  }

  return {
    format: DATA_TEXTURE_FORMAT,
    version: DATA_TEXTURE_VERSION,
    name,
    source: {
      package: sourcePackage,
      object: boundedString(source.object, "source object", 200),
      objectPath: boundedString(source.objectPath, "source object path", 1024),
      class: "Texture2D",
      sourceFormat: "TSF_RGBA16F",
      sha256: sourceSha256,
    },
    data: {
      file,
      format: "RGBA16F",
      layout: "little-endian-half4",
      width,
      height,
      mips: 1,
      slices: 1,
      channels: 4,
      bytesPerPixel: RGBA16F_BYTES_PER_PIXEL,
      bytes,
      sha256: dataSha256,
      srgb: false,
      colorSpace: "none",
    },
    provenance: {
      converter: boundedString(provenance.converter, "provenance converter", 200),
      unrealSource: boundedString(provenance.unrealSource, "provenance unreal source", 400),
    },
    limits: [...limits],
  };
}

/**
 * Checks the payload against the manifest: its exact length, its SHA-256, and that every sample is finite.
 * The order matters for the message: a truncated file is reported as truncated, not as a hash mismatch.
 */
export async function verifyRgba16fData(manifest: DataTextureManifest, bytes: Uint8Array, sha256: Sha256Hex): Promise<void> {
  if (bytes.byteLength !== manifest.data.bytes) {
    throw new DataTextureError(`payload is ${bytes.byteLength} bytes; expected ${manifest.data.bytes}`);
  }
  const digest = await sha256(bytes);
  if (digest !== manifest.data.sha256) throw new DataTextureError("payload SHA-256 does not match the manifest");
  decodeRgba16fLittleEndian(bytes);
}

/**
 * Reads the stored samples as unsigned 16-bit values in little-endian order, whatever the host's byte order. The
 * values are the raw binary16 bit patterns: nothing is converted to a number. Non-finite patterns (infinities and
 * NaNs, exponent all ones) are refused because the source has none and a consumer cannot tell them from data.
 */
export function decodeRgba16fLittleEndian(bytes: Uint8Array): Uint16Array {
  if (bytes.byteLength % RGBA16F_BYTES_PER_PIXEL !== 0) {
    throw new DataTextureError(`payload of ${bytes.byteLength} bytes is not whole RGBA16F pixels`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Uint16Array(bytes.byteLength / 2);
  for (let index = 0; index < samples.length; index++) {
    const sample = view.getUint16(index * 2, true);
    if ((sample & 0x7c00) === 0x7c00) {
      throw new DataTextureError(`non-finite half-float sample at sample ${index} (pixel ${Math.floor(index / 4)}, channel ${index % 4})`);
    }
    samples[index] = sample;
  }
  return samples;
}

function plainObject(value: unknown, where: string): Record<string, any> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new DataTextureError(`${where} is not an object`);
  return value as Record<string, any>;
}

function exactKeys(object: Record<string, unknown>, allowed: readonly string[], where: string): void {
  const unknown = Object.keys(object).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new DataTextureError(`${where} has an unknown field "${unknown}"`);
  const missing = allowed.find((key) => !(key in object));
  if (missing !== undefined) throw new DataTextureError(`${where} is missing "${missing}"`);
}

function boundedString(value: unknown, where: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new DataTextureError(`${where} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function hexDigest(value: unknown, where: string): string {
  if (typeof value !== "string" || !HEX_SHA256.test(value)) throw new DataTextureError(`${where} is not a lowercase SHA-256 hex digest`);
  return value;
}

function dimension(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 65_536) {
    throw new DataTextureError(`${where} must be an integer from 1 to 65536`);
  }
  return value;
}
