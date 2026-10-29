import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, rename, unlink, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { Document, ImageUtils, NodeIO } from "@gltf-transform/core";
import { compressTexture, dedup, prune, simplify, weld } from "@gltf-transform/functions";
import { MeshoptSimplifier } from "meshoptimizer";
import sharp from "sharp";

import { RIG_LIMITS, RigAssetError } from "../rig/inspect.js";
import { renderPreview, type PreviewResult } from "../rig/preview.js";

export type MeshOptimizeErrorCode =
  | "MESH_OPTIMIZE_INVALID_INPUT"
  | "MESH_OPTIMIZE_UNSAFE_PATH"
  | "MESH_OPTIMIZE_INPUT_TOO_LARGE"
  | "MESH_OPTIMIZE_INVALID_GLTF"
  | "MESH_OPTIMIZE_UNSUPPORTED"
  | "MESH_OPTIMIZE_PREVIEW_UNAVAILABLE"
  | "MESH_OPTIMIZE_PREVIEW_FAILED"
  | "MESH_OPTIMIZE_FAILED";

export class MeshOptimizeError extends Error {
  constructor(
    public readonly code: MeshOptimizeErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "MeshOptimizeError";
  }
}

/** Thresholds from the PRD; Phase 3 calibrates them against real scans. */
export const MESH_OPTIMIZE_GATE = Object.freeze({
  /** Minimum silhouette intersection-over-union for every rendered angle. */
  iouThreshold: 0.98,
  /** Maximum mean grayscale difference, as a fraction of full scale (0.02 = 2%). */
  grayThreshold: 0.02,
});

export interface MeshGateView {
  angle: number;
  iou: number;
  grayDifference: number;
  passed: boolean;
}

export interface MeshGateResult {
  passed: boolean;
  /** Worst IoU across the rendered angles. */
  iou: number;
  /** Worst mean grayscale difference across the rendered angles, as a fraction of full scale. */
  grayDifference: number;
  views: MeshGateView[];
}

export interface GateOptions {
  iouThreshold?: number;
  grayThreshold?: number;
}

export interface MeshAttempt {
  error: number;
  triangles: number;
  bytes: number;
  gate: MeshGateResult;
}

export interface MeshOptimizeResult {
  kept: "optimized" | "original";
  input: { path: string; bytes: number; sha256: string; triangles: number };
  output: { path: string; bytes: number; sha256: string; triangles: number } | null;
  attempts: MeshAttempt[];
  gate: MeshGateResult | null;
  previews: { before: string; after: string } | null;
  maxTextureSize: number;
}

export interface OptimizeMeshOptions {
  outputPath?: string;
  maxTextureSize?: number;
  /** Error ladder, as a fraction of mesh radius. */
  errorLadder?: number[];
  angles?: number;
  width?: number;
  height?: number;
}

const DEFAULT_ERROR_LADDER = Object.freeze([0.005, 0.002, 0.0005]);
const DEFAULT_MAX_TEXTURE_SIZE = 2_048;
/** Camera distance, in largest-model-dimension units, that keeps a wide static mesh inside the frame. */
const PREVIEW_FIT_MARGIN = 2.2;
const PREVIEW_TIMEOUT_MS = 180_000;
const PREVIEW_SIZE = 384;
/** glTF primitive mode 4: TRIANGLES. */
const TRIANGLES = 4;
/** Scene background hardcoded in `src/rig/preview.ts`. */
const PREVIEW_BACKGROUND = [32, 40, 48] as const;
/** Sum of absolute RGB differences above which a pixel belongs to the model, not the background. */
const MASK_DISTANCE = 24;

const io: NodeIO = new NodeIO();

let simplifierReady: Promise<void> | undefined;

async function ensureSimplifierReady(): Promise<void> {
  simplifierReady ??= MeshoptSimplifier.ready;
  await simplifierReady;
  if (!MeshoptSimplifier.supported) {
    throw new MeshOptimizeError(
      "MESH_OPTIMIZE_FAILED",
      "The meshopt simplifier is not supported by this runtime.",
    );
  }
}

interface RawImage {
  data: Buffer;
  width: number;
  height: number;
  channels: number;
}

async function rawImage(png: Uint8Array): Promise<RawImage> {
  const { data, info } = await sharp(Buffer.from(png))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

function foreground(raw: RawImage, pixel: number): boolean {
  const offset = pixel * raw.channels;
  const red = raw.data[offset] ?? 0;
  const green = raw.data[offset + 1] ?? 0;
  const blue = raw.data[offset + 2] ?? 0;
  return (
    Math.abs(red - PREVIEW_BACKGROUND[0]) +
      Math.abs(green - PREVIEW_BACKGROUND[1]) +
      Math.abs(blue - PREVIEW_BACKGROUND[2]) >
    MASK_DISTANCE
  );
}

function luminance(raw: RawImage, pixel: number): number {
  const offset = pixel * raw.channels;
  return (
    0.2126 * (raw.data[offset] ?? 0) +
    0.7152 * (raw.data[offset + 1] ?? 0) +
    0.0722 * (raw.data[offset + 2] ?? 0)
  );
}

/**
 * Compare two previews of the same asset, angle by angle. A candidate passes only when every
 * view keeps the silhouette and the shaded surface: a triangle count could drop while a carving
 * or a hole silently disappears, and this is the check that refuses that result.
 */
export async function comparePreviews(
  before: PreviewResult,
  after: PreviewResult,
  options: GateOptions = {},
): Promise<MeshGateResult> {
  if (before.images.length !== after.images.length) {
    throw new MeshOptimizeError(
      "MESH_OPTIMIZE_FAILED",
      "The before and after previews rendered a different number of views.",
    );
  }
  const iouThreshold = options.iouThreshold ?? MESH_OPTIMIZE_GATE.iouThreshold;
  const grayThreshold = options.grayThreshold ?? MESH_OPTIMIZE_GATE.grayThreshold;
  const views: MeshGateView[] = [];
  for (let index = 0; index < before.images.length; index += 1) {
    const beforeImage = await rawImage(before.images[index]!.png);
    const afterImage = await rawImage(after.images[index]!.png);
    if (beforeImage.width !== afterImage.width || beforeImage.height !== afterImage.height) {
      throw new MeshOptimizeError(
        "MESH_OPTIMIZE_FAILED",
        "The before and after previews rendered at different sizes.",
      );
    }
    const pixels = beforeImage.width * beforeImage.height;
    let intersection = 0;
    let union = 0;
    let grayTotal = 0;
    let grayCount = 0;
    for (let pixel = 0; pixel < pixels; pixel += 1) {
      const inBefore = foreground(beforeImage, pixel);
      const inAfter = foreground(afterImage, pixel);
      if (inBefore && inAfter) intersection += 1;
      if (inBefore || inAfter) {
        union += 1;
        grayTotal += Math.abs(luminance(beforeImage, pixel) - luminance(afterImage, pixel));
        grayCount += 1;
      }
    }
    const iou = union === 0 ? 1 : intersection / union;
    const grayDifference = grayCount === 0 ? 0 : grayTotal / grayCount / 255;
    views.push({
      angle: before.images[index]!.angle,
      iou,
      grayDifference,
      passed: iou >= iouThreshold && grayDifference <= grayThreshold,
    });
  }
  return {
    passed: views.every((view) => view.passed),
    iou: Math.min(...views.map((view) => view.iou)),
    grayDifference: Math.max(...views.map((view) => view.grayDifference)),
    views,
  };
}

function countTriangles(document: Document): number {
  let triangles = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      if (primitive.getMode() !== TRIANGLES) continue;
      const count =
        primitive.getIndices()?.getCount() ?? primitive.getAttribute("POSITION")?.getCount() ?? 0;
      triangles += Math.floor(count / 3);
    }
  }
  return triangles;
}

function assertSupported(document: Document): void {
  if (document.getRoot().listSkins().length > 0) {
    throw new MeshOptimizeError(
      "MESH_OPTIMIZE_UNSUPPORTED",
      "The mesh has a skin; skinned meshes are out of scope for mesh_optimize.",
    );
  }
  if (
    document
      .getRoot()
      .listMeshes()
      .some((mesh) => mesh.listPrimitives().some((primitive) => primitive.listTargets().length > 0))
  ) {
    throw new MeshOptimizeError(
      "MESH_OPTIMIZE_UNSUPPORTED",
      "The mesh has morph targets; morph-target meshes are out of scope for mesh_optimize.",
    );
  }
}

async function shrinkTextures(document: Document, maxTextureSize: number): Promise<void> {
  for (const texture of document.getRoot().listTextures()) {
    const image = texture.getImage();
    if (!image) continue;
    const size = ImageUtils.getSize(image, texture.getMimeType());
    if (!size || (size[0] <= maxTextureSize && size[1] <= maxTextureSize)) continue;
    await compressTexture(texture, { encoder: sharp, resize: [maxTextureSize, maxTextureSize] });
  }
}

async function preview(modelBytes: Uint8Array, angles: number, width: number, height: number) {
  try {
    return await renderPreview(modelBytes, {
      times: [0],
      angles,
      width,
      height,
      fitMargin: PREVIEW_FIT_MARGIN,
      timeoutMs: PREVIEW_TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof RigAssetError) {
      const code =
        error.code === "RIG_PREVIEW_UNAVAILABLE"
          ? "MESH_OPTIMIZE_PREVIEW_UNAVAILABLE"
          : "MESH_OPTIMIZE_PREVIEW_FAILED";
      throw new MeshOptimizeError(code, error.message);
    }
    throw error;
  }
}

async function canonicalPath(path: string): Promise<string> {
  const existing = await realpath(path).catch(() => null);
  if (existing) return existing;
  const parent = await realpath(dirname(path)).catch(() => dirname(path));
  return join(parent, basename(path));
}

async function writeAtomically(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.part-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, bytes);
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

/**
 * Simplify a static GLB while a rendered gate caps the visible change, not the triangle count.
 * The error ladder lets flat areas collapse and detailed areas keep their triangles, so each
 * asset finds its own count. When no candidate passes the gate, nothing is written.
 */
export async function optimizeMesh(
  inputPath: string,
  options: OptimizeMeshOptions = {},
): Promise<MeshOptimizeResult> {
  const resolved = await realpath(inputPath).catch(() => null);
  if (!resolved) {
    throw new MeshOptimizeError("MESH_OPTIMIZE_INVALID_INPUT", `No readable file at ${inputPath}.`);
  }
  if (!resolved.toLowerCase().endsWith(".glb")) {
    throw new MeshOptimizeError("MESH_OPTIMIZE_INVALID_INPUT", "The input must be a .glb file.");
  }
  const maxTextureSize = options.maxTextureSize ?? DEFAULT_MAX_TEXTURE_SIZE;
  const errorLadder = options.errorLadder ?? [...DEFAULT_ERROR_LADDER];
  const angles = options.angles ?? 6;
  const width = options.width ?? PREVIEW_SIZE;
  const height = options.height ?? PREVIEW_SIZE;
  const outputPath = resolve(
    options.outputPath ?? `${resolved.slice(0, -4)}.optimized.glb`,
  );
  if (!outputPath.toLowerCase().endsWith(".glb")) {
    throw new MeshOptimizeError("MESH_OPTIMIZE_INVALID_INPUT", "The output must be a .glb path.");
  }
  if ((await canonicalPath(outputPath)) === resolved) {
    throw new MeshOptimizeError(
      "MESH_OPTIMIZE_UNSAFE_PATH",
      "The output path is the input file; mesh_optimize never overwrites its input.",
    );
  }

  const inputBytes = new Uint8Array(await readFile(resolved));
  if (inputBytes.byteLength > RIG_LIMITS.maxGlbBytes) {
    throw new MeshOptimizeError(
      "MESH_OPTIMIZE_INPUT_TOO_LARGE",
      `${inputPath} is over the GLB byte limit.`,
    );
  }
  const inputSha256 = createHash("sha256").update(inputBytes).digest("hex");
  let source: Document;
  try {
    source = await io.readBinary(inputBytes);
  } catch {
    throw new MeshOptimizeError("MESH_OPTIMIZE_INVALID_GLTF", `${inputPath} is not a readable GLB asset.`);
  }
  assertSupported(source);
  const inputTriangles = countTriangles(source);
  const input = {
    path: resolved,
    bytes: inputBytes.byteLength,
    sha256: inputSha256,
    triangles: inputTriangles,
  };

  await ensureSimplifierReady();
  const before = await preview(inputBytes, angles, width, height);

  const attempts: MeshAttempt[] = [];
  for (const error of errorLadder) {
    const document = await io.readBinary(inputBytes);
    await document.transform(
      dedup(),
      weld({}),
      simplify({ simplifier: MeshoptSimplifier, ratio: 0, error }),
      prune(),
    );
    await shrinkTextures(document, maxTextureSize);
    const bytes = await io.writeBinary(document);
    const after = await preview(bytes, angles, width, height);
    const gate = await comparePreviews(before, after);
    attempts.push({
      error,
      triangles: countTriangles(document),
      bytes: bytes.byteLength,
      gate,
    });
    if (!gate.passed) continue;

    await writeAtomically(outputPath, bytes);
    const beforePath = `${outputPath.slice(0, -4)}.before.png`;
    const afterPath = `${outputPath.slice(0, -4)}.after.png`;
    await writeAtomically(beforePath, before.contactSheet);
    await writeAtomically(afterPath, after.contactSheet);
    return {
      kept: "optimized",
      input,
      output: {
        path: outputPath,
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        triangles: countTriangles(document),
      },
      attempts,
      gate,
      previews: { before: beforePath, after: afterPath },
      maxTextureSize,
    };
  }

  return {
    kept: "original",
    input,
    output: null,
    attempts,
    gate: null,
    previews: null,
    maxTextureSize,
  };
}
