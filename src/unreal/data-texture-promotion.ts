import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { DataTextureError, parseDataTextureManifest, verifyRgba16fData, type DataTextureManifest } from "./data-texture.js";

/** The package files whose bytes the producer hashes, in the order it hashes them. */
export const PACKAGE_SET_EXTENSIONS = [".uasset", ".uexp", ".ubulk", ".uptnl"] as const;

/**
 * SHA-256 of a package file set under `sourceDir`, computed as the converter computes it: for each present file, its
 * `ext size` line followed by its bytes. A file that is absent contributes nothing.
 */
export async function packageSetSha256(sourceDir: string, selector: string): Promise<string> {
  const hash = createHash("sha256");
  for (const extension of PACKAGE_SET_EXTENSIONS) {
    const file = join(sourceDir, `${selector}${extension}`);
    const info = await stat(file).catch(() => undefined);
    if (!info?.isFile()) continue;
    const bytes = await readFile(file);
    hash.update(`${extension} ${bytes.byteLength}\n`, "ascii");
    hash.update(bytes);
  }
  return hash.digest("hex");
}

export interface PromotedDataTexture {
  readonly name: string;
  /** The qualified package name the report uses. */
  readonly package: string;
  /** The raw binary, relative to the promoted output directory. */
  readonly data: string;
  /** The manifest, relative to the promoted output directory. */
  readonly manifest: string;
  readonly format: "RGBA16F";
  readonly threeTexture: "DataTexture";
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly sha256: string;
  readonly sourceSha256: string;
}

export interface PromoteDataTextureOptions {
  /** The isolated run directory the converter wrote; its `DataTextures/` holds one manifest and its binary. */
  readonly converterOutput: string;
  /** The source root the converter read. */
  readonly sourceDir: string;
  /** The package key the run was asked for, without `.uasset`. The manifest must name exactly this package. */
  readonly selector: string;
  /** The import output directory the artifacts are promoted into. */
  readonly promotionDir: string;
  /** The target without extension, relative to `promotionDir`, e.g. `data-textures/game/a/t_x`. */
  readonly relativeBase: string;
  /** The qualified package name recorded in the report. */
  readonly package: string;
  /**
   * Test seam: runs after the binary is in place and before the manifest is committed. It lets a test prove that a
   * failed commit leaves neither file behind, without racing the filesystem.
   */
  readonly afterBinaryCommit?: () => Promise<void> | void;
}

/**
 * Promotes one converter-written RGBA16F data texture. The binary and its manifest are checked together (exact
 * package, length, SHA-256, finite samples, source identity), written beside their targets, and renamed into place
 * as a pair: a failure at any step removes everything this call created.
 */
export async function promoteRgba16fDataTexture(options: PromoteDataTextureOptions): Promise<PromotedDataTexture> {
  const directory = join(options.converterOutput, "DataTextures");
  const manifests = await manifestsIn(directory);
  if (manifests.length !== 1) {
    throw new DataTextureError(`the converter wrote ${manifests.length} data-texture manifests; exactly one is expected`);
  }
  const manifestPath = manifests[0]!;
  const manifest = parseDataTextureManifest(JSON.parse(await readFile(manifestPath, "utf8")) as unknown);
  if (manifest.source.package !== `${options.selector}.uasset`) {
    throw new DataTextureError(`the manifest names ${manifest.source.package}, not ${options.selector}.uasset`);
  }

  const binaryPath = join(dirname(manifestPath), manifest.data.file);
  const binaryInfo = await lstat(binaryPath).catch(() => undefined);
  if (!binaryInfo?.isFile()) throw new DataTextureError(`the data file ${manifest.data.file} is missing or not a regular file`);
  const bytes = new Uint8Array(await readFile(binaryPath));
  await verifyRgba16fData(manifest, bytes, sha256Hex);

  const sourceSha256 = await packageSetSha256(options.sourceDir, options.selector);
  if (sourceSha256 !== manifest.source.sha256) {
    throw new DataTextureError("the source package changed after conversion: its SHA-256 no longer matches the manifest");
  }

  const base = resolve(options.promotionDir, options.relativeBase);
  if (!isInside(options.promotionDir, base)) {
    throw new DataTextureError(`${options.relativeBase} is outside the promotion directory`);
  }
  const dataTarget = `${base}.rgba16f-le`;
  const manifestTarget = `${base}.rgba16f.json`;
  if ((await exists(dataTarget)) || (await exists(manifestTarget))) {
    throw new DataTextureError(`${options.relativeBase} is already promoted`);
  }

  const promoted = {
    name: manifest.name,
    package: options.package,
    data: `${options.relativeBase}.rgba16f-le`,
    manifest: `${options.relativeBase}.rgba16f.json`,
    format: "RGBA16F" as const,
    threeTexture: "DataTexture" as const,
    width: manifest.data.width,
    height: manifest.data.height,
    bytes: manifest.data.bytes,
    sha256: manifest.data.sha256,
    sourceSha256: manifest.source.sha256,
  };
  // The binary is named by the qualified target, so the manifest must point at that basename, not the converter's.
  const committed: DataTextureManifest = { ...manifest, data: { ...manifest.data, file: basename(dataTarget) } };
  const dataTemporary = `${dataTarget}.tmp`;
  const manifestTemporary = `${manifestTarget}.tmp`;
  await mkdir(dirname(base), { recursive: true });
  try {
    await writeFile(dataTemporary, bytes);
    await writeFile(manifestTemporary, `${JSON.stringify(committed, null, 2)}\n`);
    await rename(dataTemporary, dataTarget);
    await options.afterBinaryCommit?.();
    await rename(manifestTemporary, manifestTarget);
  } catch (error) {
    await Promise.all([dataTemporary, manifestTemporary, dataTarget, manifestTarget].map((path) => rm(path, { force: true })));
    throw error;
  }
  return promoted;
}

async function manifestsIn(directory: string): Promise<string[]> {
  const names = await readdir(directory).catch(() => [] as string[]);
  return names.filter((name) => name.endsWith(".rgba16f.json")).sort().map((name) => join(directory, name));
}

async function exists(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => undefined)) !== undefined;
}

function isInside(root: string, path: string): boolean {
  const rel = relative(resolve(root), path);
  return rel !== "" && rel.split(sep)[0] !== ".." && !isAbsolute(rel);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return createHash("sha256").update(bytes).digest("hex");
}
