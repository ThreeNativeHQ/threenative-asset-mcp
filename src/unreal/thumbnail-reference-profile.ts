import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ThumbnailGridSource } from "./thumbnail-floor.js";
import type { ThumbnailEnvironmentSource, ThumbnailSourceRadiance } from "./thumbnail-lighting.js";

/**
 * Stand-in for the Grid's public sourceGrid type until it merges: decoded RGBA8, row-major, top row first.
 * Its source is the caller's record, not an attestation of file identity or redistribution rights.
 */
export interface ThumbnailReferenceGrid {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
  readonly source: ThumbnailGridSource;
}

/** Digests of the bytes actually read. The decoded arrays are never serialised. */
export interface ThumbnailReferenceProfileReport {
  readonly profileSha256: string;
  readonly environmentRadianceSha256: string;
  readonly gridRgbaSha256: string;
}

export interface ThumbnailReferenceProfile {
  readonly sourceEnvironment: ThumbnailSourceRadiance;
  readonly sourceGrid: ThumbnailReferenceGrid;
  readonly report: ThumbnailReferenceProfileReport;
}

/**
 * Test-only seams at the file-read boundary. Production passes none. `opened` and `checked` are awaited where they are
 * named, so a test changes a file at an exact point in the read instead of racing a timer or a watcher.
 */
export interface ThumbnailReferenceProfileHooks {
  /** A descriptor is open for `file`. The loader reads only through `handle` and closes it on every path. */
  readonly opened?: (file: string, handle: FileHandle) => void | Promise<void>;
  /** The descriptor passed its type and size checks. No byte of `file` has been read yet. */
  readonly checked?: (file: string) => void | Promise<void>;
  /** A bounded read of `length` bytes at `offset` is about to run. */
  readonly read?: (file: string, offset: number, length: number) => void;
}

const MAX_SIDE = 16384;
const MAX_BINARY_BYTES = 512 * 1024 * 1024;
const MAX_PROFILE_BYTES = 64 * 1024;
const MAX_TEXT_LENGTH = 256;
const RADIANCE_BYTES_PER_PIXEL = 12; // RGB, float32 each
const GRID_BYTES_PER_PIXEL = 4; // RGBA8
/** Read-only, and non-blocking where the platform has it: opening a FIFO then returns at once and its type check refuses it. */
const READ_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

interface ProfileDocument {
  readonly environment: {
    readonly path: string;
    readonly width: number;
    readonly height: number;
    readonly sha256: string;
    readonly source: ThumbnailEnvironmentSource;
  };
  readonly grid: {
    readonly path: string;
    readonly width: number;
    readonly height: number;
    readonly sha256: string;
    readonly source: ThumbnailGridSource;
  };
}

/**
 * Loads a local reference profile: version-1 JSON beside two raw binaries. Relative binary paths resolve against the
 * JSON's directory, never the working directory. The whole document is validated before any binary is opened, and each
 * binary must match its declared size and SHA-256 before it is decoded. Every file is opened once and read only through
 * that descriptor, within a fixed bound, so a replaced path or a growing file cannot make the load read more than that.
 * An invalid profile rejects; nothing falls back. The profile carries no lighting, exposure, orientation or floor
 * settings: those stay with the renderer. Nothing is fetched, bundled or searched for. The source `bytesSha256` is caller
 * provenance, not an engine attestation. `hooks` is for tests only.
 */
export async function loadThumbnailReferenceProfile(profilePath: string, hooks: ThumbnailReferenceProfileHooks = {}): Promise<ThumbnailReferenceProfile> {
  const profileFile = resolve(localPath(profilePath, "profile path"));
  const profileBytes = await readBoundedFile(profileFile, "profile", MAX_PROFILE_BYTES, false, hooks);
  const profile = parseProfile(profileBytes, profileFile);
  const directory = dirname(profileFile);
  const environmentFile = resolve(directory, profile.environment.path);
  const gridFile = resolve(directory, profile.grid.path);
  const environment = await readVerifiedBinary(
    environmentFile,
    "radiance",
    profile.environment.width * profile.environment.height * RADIANCE_BYTES_PER_PIXEL,
    profile.environment.sha256,
    hooks,
  );
  const grid = await readVerifiedBinary(gridFile, "grid", profile.grid.width * profile.grid.height * GRID_BYTES_PER_PIXEL, profile.grid.sha256, hooks);
  return {
    sourceEnvironment: Object.freeze({
      width: profile.environment.width,
      height: profile.environment.height,
      rgb: decodeRadiance(environment.bytes, environmentFile),
      source: Object.freeze(profile.environment.source),
    }),
    sourceGrid: Object.freeze({
      width: profile.grid.width,
      height: profile.grid.height,
      // A copy, so the array owns its buffer rather than viewing the file read.
      rgba: new Uint8Array(grid.bytes),
      source: Object.freeze(profile.grid.source),
    }),
    report: Object.freeze({
      profileSha256: sha256Hex(profileBytes),
      environmentRadianceSha256: environment.sha256,
      gridRgbaSha256: grid.sha256,
    }),
  };
}

function parseProfile(bytes: Buffer, file: string): ProfileDocument {
  try {
    return parseDocument(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch (error) {
    throw new Error(`invalid thumbnail reference profile ${file}: ${(error as Error).message}`);
  }
}

/** Refuses anything outside the version-1 schema and rebuilds each record field by field, so no extra key or array survives. */
function parseDocument(value: unknown): ProfileDocument {
  const root = exactFields(value, "profile", ["version", "environment", "grid"]);
  if (root.version !== 1) throw new Error("version must be 1");
  const environment = exactFields(root.environment, "environment", ["path", "encoding", "width", "height", "sha256", "source"]);
  const environmentSource = exactFields(environment.source, "environment.source", ["reference", "engine", "bytesSha256", "layout", "radianceDecode"]);
  const grid = exactFields(root.grid, "grid", ["path", "encoding", "width", "height", "sha256", "source"]);
  const gridSource = exactFields(grid.source, "grid.source", ["reference", "engine", "bytesSha256"]);
  if (environment.encoding !== "rgb-f32le") throw new Error("environment.encoding must be rgb-f32le");
  if (grid.encoding !== "rgba8") throw new Error("grid.encoding must be rgba8");
  if (environmentSource.layout !== "ue-source-longlat-rgb-f32") throw new Error("environment.source.layout must be ue-source-longlat-rgb-f32");
  const environmentWidth = dimension(environment.width, "environment.width");
  const environmentHeight = dimension(environment.height, "environment.height");
  checkStorage(environmentWidth, environmentHeight, RADIANCE_BYTES_PER_PIXEL, "radiance");
  const gridWidth = dimension(grid.width, "grid.width");
  const gridHeight = dimension(grid.height, "grid.height");
  checkStorage(gridWidth, gridHeight, GRID_BYTES_PER_PIXEL, "grid");
  return {
    environment: {
      path: localPath(environment.path, "environment.path"),
      width: environmentWidth,
      height: environmentHeight,
      sha256: digest(environment.sha256, "environment.sha256"),
      source: {
        reference: text(environmentSource.reference, "environment.source.reference"),
        engine: text(environmentSource.engine, "environment.source.engine"),
        bytesSha256: digest(environmentSource.bytesSha256, "environment.source.bytesSha256"),
        layout: "ue-source-longlat-rgb-f32",
        radianceDecode: oneOf(environmentSource.radianceDecode, ["ue4.19-rgbe", "ue5.8-rgbe"], "environment.source.radianceDecode"),
      },
    },
    grid: {
      path: localPath(grid.path, "grid.path"),
      width: gridWidth,
      height: gridHeight,
      sha256: digest(grid.sha256, "grid.sha256"),
      source: {
        reference: text(gridSource.reference, "grid.source.reference"),
        engine: text(gridSource.engine, "grid.source.engine"),
        bytesSha256: digest(gridSource.bytesSha256, "grid.source.bytesSha256"),
      },
    },
  };
}

/**
 * Opens `file` once and reads it only through that descriptor. On the descriptor it must be a regular file: exactly
 * `limit` bytes when `exact` is set, at most `limit` bytes otherwise. Both checks run before the first byte is read. The
 * reads then ask for at most one byte past `limit`, so growth shows as that extra byte and nothing further is read. The
 * descriptor is closed on every path, including a hook that throws.
 */
async function readBoundedFile(file: string, label: string, limit: number, exact: boolean, hooks: ThumbnailReferenceProfileHooks): Promise<Buffer> {
  const handle = await open(file, READ_FLAGS);
  try {
    await hooks.opened?.(file, handle);
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`${label} ${file} is not a regular file`);
    if (exact && info.size !== limit) throw new Error(`${label} ${file} has ${info.size} bytes, expected ${limit}`);
    if (!exact && info.size > limit) throw new Error(`${label} ${file} has ${info.size} bytes, above the ${limit} byte limit`);
    await hooks.checked?.(file);
    const bytes = Buffer.alloc(limit + 1);
    let total = 0;
    while (total <= limit) {
      const length = limit + 1 - total;
      hooks.read?.(file, total, length);
      const { bytesRead } = await handle.read(bytes, total, length, null);
      if (bytesRead === 0) break; // end of file
      total += bytesRead;
    }
    if (exact ? total !== limit : total > limit) throw new Error(`${label} ${file} changed size while it was read`);
    return bytes.subarray(0, total);
  } finally {
    await handle.close();
  }
}

/** Checks the size on the descriptor before reading and the digest after, so a wrong file is refused before anything is decoded. */
async function readVerifiedBinary(file: string, label: string, size: number, declaredSha256: string, hooks: ThumbnailReferenceProfileHooks): Promise<{ readonly bytes: Buffer; readonly sha256: string }> {
  const bytes = await readBoundedFile(file, label, size, true, hooks);
  const sha256 = sha256Hex(bytes);
  if (sha256 !== declaredSha256) throw new Error(`${label} ${file} does not match its declared sha256`);
  return { bytes, sha256 };
}

/** Explicit little-endian binary32 through DataView, so host byte order never matters. Values are kept as stored, never clamped. */
function decodeRadiance(bytes: Buffer, file: string): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const rgb = new Float32Array(bytes.byteLength / 4);
  for (let index = 0; index < rgb.length; index++) {
    const value = view.getFloat32(index * 4, true);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${file} sample ${index} is ${value}; HDR radiance must be finite and nonnegative`);
    rgb[index] = value;
  }
  return rgb;
}

/** Every key must be one of `keys`, every key in `keys` must be present, and arrays are not objects. */
function exactFields(value: unknown, field: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !keys.includes(key));
  if (unknown.length > 0) throw new Error(`${field} has unknown field ${unknown.join(", ")}`);
  const missing = keys.filter((key) => !Object.hasOwn(record, key));
  if (missing.length > 0) throw new Error(`${field} is missing ${missing.join(", ")}`);
  return record;
}

/** A local path only: no NUL byte, no URL scheme (two or more characters before the colon, so a one-letter drive such as `C:` stays a path) and no UNC share. */
function localPath(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) throw new Error(`${field} must be a nonempty path without NUL bytes`);
  if (/^[A-Za-z][A-Za-z0-9+.-]+:/.test(value) || value.startsWith("//") || value.startsWith("\\\\")) {
    throw new Error(`${field} must be a local path, not a URL or a remote share`);
  }
  return value;
}

function dimension(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > MAX_SIDE) {
    throw new Error(`${field} must be a whole number from 1 to ${MAX_SIDE}`);
  }
  return value;
}

/** Refuses a declared size above the cap before any file is opened or any array is allocated. */
function checkStorage(width: number, height: number, bytesPerPixel: number, label: string): void {
  const bytes = width * height * bytesPerPixel;
  if (bytes > MAX_BINARY_BYTES) throw new Error(`${label} needs ${bytes} bytes, above the ${MAX_BINARY_BYTES / 1024 / 1024} MiB limit`);
}

/** Lowercase hex only, as `sha256sum` and Node print it; the declared digest is compared exactly, never case-folded. */
function digest(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${field} must be a lowercase SHA-256 hex digest`);
  return value;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_TEXT_LENGTH) {
    throw new Error(`${field} must be a nonempty string of at most ${MAX_TEXT_LENGTH} characters`);
  }
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (!allowed.some((candidate) => candidate === value)) throw new Error(`${field} must be one of ${allowed.join(", ")}`);
  return value as T;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
