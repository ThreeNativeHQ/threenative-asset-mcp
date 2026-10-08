import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { access, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, sep } from "node:path";

import { chromium } from "playwright";
import sharp, { type Metadata } from "sharp";
import { z } from "zod";

import { browserTempEnvironment, createBrowserTempDir } from "../browser-temp.js";
import {
  CreatureOperationError,
  type CreatureRunner,
} from "./runner.js";

const PREVIEW_TIMEOUT_MS = 120_000;
const IMAGE_BUDGET_BYTES = 4 * 1_024 * 1_024;
const SILHOUETTE_VIEWS = ["front", "side", "top", "hero"] as const;
const PYTHON_VIEWS = SILHOUETTE_VIEWS.join(",");

export type CreaturePreviewMode = "silhouettes" | "hero";

export interface CreaturePreviewRequest {
  readonly glbPath: string;
  readonly mode: CreaturePreviewMode;
  readonly previousPreviewId?: string;
}

export interface PreviewArtifact {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly included: boolean;
  readonly omittedReason?: string;
}

export interface CreaturePreviewView {
  readonly name: string;
  readonly image: PreviewArtifact;
  readonly thumbnail: PreviewArtifact;
  readonly measurements: Record<string, unknown>;
}

export interface CreaturePreviewBackend {
  readonly id: "python-outline" | "browser-silmetrics" | "browser-hero";
  readonly nativeViewNames: readonly string[];
  readonly camera: {
    readonly projection: "perspective";
    readonly fovDegrees: number;
    readonly resolution: { readonly width: number; readonly height: number };
    readonly distanceMultiplier?: number;
    readonly initialDistanceMultiplier?: number;
    readonly fitFraction?: number;
  };
}

export interface CreaturePreviewResult {
  readonly operation: "creature_preview";
  readonly mode: CreaturePreviewMode;
  readonly glbPath: string;
  readonly glbSha256: string;
  readonly previewId: string;
  readonly receiptPath: string;
  readonly backend: CreaturePreviewBackend;
  readonly views: readonly CreaturePreviewView[];
  readonly encodedImageBudgetBytes: number;
  readonly visualReview: "notReviewed";
  readonly comparison?: { readonly previousPreviewId: string; readonly compatible: true };
}

interface CommandResult {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly overflow: boolean;
}

export interface PreviewImageContent {
  readonly type: "image";
  readonly mimeType: "image/png";
  readonly data: string;
}

interface ImageData {
  readonly bytes: Buffer;
  readonly metadata: Metadata;
  readonly raw: Buffer;
  readonly channels: number;
}

interface PreviewResolution {
  readonly width: number;
  readonly height: number;
}

export interface PreviewToolAvailability {
  readonly available: boolean;
  readonly reason?: string;
}

const PYTHON_PROBE_TIMEOUT_MS = 5_000;
const CHROMIUM_PROBE_TIMEOUT_MS = 10_000;
const PREVIEW_TIMEOUT_MESSAGE =
  `Creature preview exceeded ${PREVIEW_TIMEOUT_MS} ms; use a smaller asset or retry when the machine is less loaded.`;
const PREVIEW_CANCELLED_MESSAGE =
  "Creature preview rendering was cancelled; no preview approval was recorded.";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function previewAbortError(signal: AbortSignal): CreatureOperationError {
  const reason = signal.reason;
  const timedOut = isRecord(reason) && reason.kind === "timeout";
  return new CreatureOperationError(
    timedOut ? "TIMEOUT" : "CANCELLED",
    timedOut ? PREVIEW_TIMEOUT_MESSAGE : PREVIEW_CANCELLED_MESSAGE,
  );
}

function throwIfPreviewAborted(signal: AbortSignal): void {
  if (signal.aborted) throw previewAbortError(signal);
}

function projectPath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function commandEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "HOME",
    "USERPROFILE",
    "LOCALAPPDATA",
    "PLAYWRIGHT_BROWSERS_PATH",
    "PW_CHROMIUM_PATH",
    "PW_NO_SANDBOX",
  ]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    killer.once("error", () => child.kill(signal));
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The command exited between the state check and the signal.
    }
  }
}

async function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
  extraEnvironment: NodeJS.ProcessEnv = {},
): Promise<CommandResult> {
  const child = spawn(command, args, {
    cwd,
    env: { ...commandEnvironment(), ...extraEnvironment },
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let captured = 0;
  let overflow = false;
  const capture = (target: Buffer[], chunk: Buffer) => {
    const remaining = 1 * 1_024 * 1_024 - captured;
    if (remaining > 0) target.push(chunk.subarray(0, remaining));
    captured += chunk.length;
    if (captured > 1 * 1_024 * 1_024 && !overflow) {
      overflow = true;
      killGroup(child, "SIGTERM");
    }
  };
  child.stdout?.on("data", (chunk: Buffer) => capture(stdout, chunk));
  child.stderr?.on("data", (chunk: Buffer) => capture(stderr, chunk));
  const onAbort = () => killGroup(child, "SIGTERM");
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  let forceKill: NodeJS.Timeout | undefined;
  const closed = await new Promise<{ exitCode: number | null; signalCode: NodeJS.Signals | null }>((resolveClose) => {
    child.once("error", () => resolveClose({ exitCode: 1, signalCode: null }));
    child.once("close", (exitCode, signalCode) => resolveClose({ exitCode, signalCode }));
    forceKill = setTimeout(() => {
      if (signal.aborted || overflow) killGroup(child, "SIGKILL");
    }, 1_500);
    forceKill.unref();
  });
  if (forceKill) clearTimeout(forceKill);
  signal.removeEventListener("abort", onAbort);
  return {
    ...closed,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
    overflow,
  };
}

async function executableOnPath(name: string): Promise<boolean> {
  const names = process.platform === "win32" && !extname(name)
    ? [name, `${name}.exe`]
    : [name];
  const candidates = isAbsolute(name)
    ? names
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .flatMap((directory) => names.map((candidate) => join(directory, candidate)));
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) {
        await access(candidate, process.platform === "win32" ? 0 : 1);
        return true;
      }
    } catch {
      // Try the next PATH entry.
    }
  }
  return false;
}

export async function validatePreviewPng(
  path: string,
  resolution: PreviewResolution,
): Promise<void> {
  await readPng(path, resolution);
}

async function readPng(path: string, resolution: PreviewResolution): Promise<ImageData> {
  const bytes = await readFile(path).catch(() => {
    throw new CreatureOperationError("TOOLCHAIN_UNAVAILABLE", `The preview renderer did not produce '${basename(path)}'.`, { path });
  });
  if (bytes.length === 0) throw new CreatureOperationError("TOOLCHAIN_UNAVAILABLE", `The preview renderer produced an empty '${basename(path)}'.`, { path });
  const image = sharp(bytes);
  const metadata = await image.metadata().catch(() => {
    throw new CreatureOperationError("TOOLCHAIN_UNAVAILABLE", `The preview renderer produced an unreadable '${basename(path)}'.`, { path });
  });
  if (
    metadata.format !== "png" ||
    metadata.width !== resolution.width ||
    metadata.height !== resolution.height
  ) {
    throw new CreatureOperationError(
      "TOOLCHAIN_UNAVAILABLE",
      `The preview renderer produced an invalid '${basename(path)}'; expected ${resolution.width}x${resolution.height} PNG pixels.`,
      {
        path,
        expectedWidth: resolution.width,
        expectedHeight: resolution.height,
        actualWidth: metadata.width ?? null,
        actualHeight: metadata.height ?? null,
      },
    );
  }
  const rawResult = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const raw = rawResult.data;
  let visible = 0;
  for (let index = 0; index < raw.length; index += 4) {
    if ((raw[index + 3] ?? 0) > 8 && ((raw[index] ?? 255) < 245 || (raw[index + 1] ?? 255) < 245 || (raw[index + 2] ?? 255) < 245)) visible += 1;
  }
  if (visible < 100) throw new CreatureOperationError("TOOLCHAIN_UNAVAILABLE", `The preview renderer produced a blank '${basename(path)}'.`, { path });
  return { bytes, metadata, raw, channels: rawResult.info.channels };
}

async function thumbnail(image: ImageData, path: string): Promise<Buffer> {
  return sharp(image.bytes)
    .resize(48, 48, { fit: "contain", background: { r: 255, g: 255, b: 255, alpha: 1 } })
    .resize(240, 240, { kernel: sharp.kernel.nearest })
    .png()
    .toBuffer()
    .then((bytes) => writeFile(path, bytes).then(() => bytes));
}

function artifact(
  root: string,
  path: string,
  bytes: Buffer,
  included: boolean,
  omittedReason?: string,
): PreviewArtifact {
  return {
    path: projectPath(root, path),
    sha256: sha256(bytes),
    bytes: bytes.length,
    included,
    ...(omittedReason ? { omittedReason } : {}),
  };
}

function cameraFor(mode: CreaturePreviewMode, backend: CreaturePreviewBackend["id"]): CreaturePreviewBackend {
  if (mode === "hero") {
    return {
      id: "browser-hero",
      nativeViewNames: ["hero"],
      camera: {
        projection: "perspective",
        fovDegrees: 32,
        resolution: { width: 1024, height: 1024 },
        initialDistanceMultiplier: 2.6,
        fitFraction: 0.83,
      },
    };
  }
  return {
    id: backend,
    nativeViewNames: [...SILHOUETTE_VIEWS],
    camera: {
      projection: "perspective",
      fovDegrees: 30,
      resolution: { width: 640, height: 640 },
      distanceMultiplier: 2.4,
    },
  };
}

function measurementsFor(name: string, metrics: Record<string, unknown>): Record<string, unknown> {
  const views = isRecord(metrics.views) ? metrics.views : undefined;
  const selected = name === "side" ? views?.side : views?.[name];
  return isRecord(selected) ? { empty: "", ...selected } : { empty: "" };
}

function fallbackMeasurements(image: ImageData): Record<string, unknown> {
  const width = image.metadata.width ?? 0;
  const height = image.metadata.height ?? 0;
  const mask = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    const index = (y * width + x) * image.channels;
    return (image.raw[index] ?? 255) < 128 && (image.channels < 4 || (image.raw[index + 3] ?? 0) > 8);
  };
  let x0 = width;
  let x1 = -1;
  let y0 = height;
  let y1 = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask(x, y)) continue;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  }
  if (x1 < x0 || y1 < y0) return { empty: "blank" };
  const boxWidth = x1 - x0 + 1;
  const boxHeight = y1 - y0 + 1;
  const top: number[] = [];
  const bottom: number[] = [];
  for (let x = x0; x <= x1; x += 1) {
    let topY = -1;
    let bottomY = -1;
    for (let y = y0; y <= y1; y += 1) {
      if (mask(x, y)) {
        topY = y;
        break;
      }
    }
    for (let y = y1; y >= y0; y -= 1) {
      if (mask(x, y)) {
        bottomY = y;
        break;
      }
    }
    top.push(topY);
    bottom.push(bottomY);
  }
  const extrema = (boundary: readonly number[]): number => {
    let count = 0;
    let last = -20;
    for (let index = 6; index < boundary.length - 6; index += 1) {
      const previous = boundary[index - 5];
      const current = boundary[index];
      const next = boundary[index + 5];
      if (previous === undefined || current === undefined || next === undefined || previous < 0 || current < 0 || next < 0) continue;
      const left = current - previous;
      const right = next - current;
      if (left * right < -4 && index - last > 10) {
        count += 1;
        last = index;
      }
    }
    return count;
  };
  return {
    W_over_H: Number((boxWidth / boxHeight).toFixed(3)),
    fill: 0,
    protrusions: Math.max(1, extrema(top) + extrema(bottom)),
    thinnest_px48: 1,
    px: [boxWidth, boxHeight],
  };
}

async function packageDirectory(): Promise<string> {
  const require = createRequire(import.meta.url);
  const entry = require.resolve("playwright");
  let candidate = dirname(entry);
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const manifest = JSON.parse(await readFile(join(candidate, "package.json"), "utf8")) as Record<string, unknown>;
      if (manifest.name === "playwright") return candidate;
    } catch {
      // Walk toward the package root.
    }
    candidate = dirname(candidate);
  }
  throw new CreatureOperationError("TOOLCHAIN_UNAVAILABLE", "The installed Playwright package could not be located for preview rendering.");
}

async function createBrowserHarness(payloadRoot: string): Promise<{ readonly root: string; readonly scriptRoot: string; readonly tmp: string; readonly cleanup: () => Promise<void> }> {
  const temporary = await mkdtemp(join(tmpdir(), "threenative-creature-render-"));
  const harness = join(temporary, "harness");
  const assets = join(harness, "assets");
  const tmp = join(temporary, "tmp");
  await mkdir(assets, { recursive: true, mode: 0o700 });
  await mkdir(tmp, { recursive: true, mode: 0o700 });
  for (const name of ["pwlaunch.mjs", "pwprobe.mjs", "silmetrics.mjs", "hero.mjs"]) {
    await copyFile(join(payloadRoot, "harness", name), join(harness, name));
  }
  await copyFile(join(payloadRoot, "harness", "assets", "three-bundle.js"), join(assets, "three-bundle.js"));
  const playwrightRoot = await packageDirectory();
  await mkdir(join(temporary, "node_modules"), { recursive: true, mode: 0o700 });
  await symlink(playwrightRoot, join(temporary, "node_modules", "playwright"), "dir");
  return {
    root: temporary,
    scriptRoot: harness,
    tmp,
    cleanup: () => rm(temporary, { recursive: true, force: true }),
  };
}

function diagnostic(result: CommandResult): string {
  return result.stderr.trim().replace(/\s+/gu, " ").slice(-400);
}

export async function probePythonSilhouettes(): Promise<PreviewToolAvailability> {
  const pythonName = process.env.THREENATIVE_CREATURE_PYTHON?.trim() || "python3";
  if (!(await executableOnPath(pythonName))) {
    return {
      available: false,
      reason: "python3 is optional and was not found as an executable; install Python 3 with NumPy and Pillow or set THREENATIVE_CREATURE_PYTHON.",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort({ kind: "timeout" }), PYTHON_PROBE_TIMEOUT_MS);
  timer.unref();
  try {
    const result = await runCommand(
      pythonName,
      ["-c", "import numpy; from PIL import Image"],
      process.cwd(),
      controller.signal,
    );
    if (controller.signal.aborted) {
      return {
        available: false,
        reason: "python3 was found, but its NumPy/Pillow availability probe timed out; install the dependencies or inspect the interpreter before retrying.",
      };
    }
    if (result.exitCode === 0 && result.signalCode === null && !result.overflow) {
      return { available: true };
    }
    const detail = diagnostic(result);
    return {
      available: false,
      reason: `python3 is present but NumPy/Pillow could not be imported${detail ? ` (${detail})` : ""}; install them with 'python3 -m pip install numpy pillow'.`,
    };
  } catch (error) {
    return {
      available: false,
      reason: `python3 is present but the NumPy/Pillow availability probe failed${error instanceof Error ? ` (${error.message.split("\n")[0]})` : ""}; install them with 'python3 -m pip install numpy pillow'.`,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function probeChromiumWithRunner(
  runner: CreatureRunner,
  signal: AbortSignal,
): Promise<CommandResult> {
  const payloadRoot = await runner.ensurePayload(signal);
  const harness = await createBrowserHarness(payloadRoot);
  try {
    throwIfPreviewAborted(signal);
    return await runCommand(
      process.execPath,
      [join(harness.scriptRoot, "pwprobe.mjs")],
      harness.root,
      signal,
      browserTempEnvironment(harness.tmp),
    );
  } finally {
    await harness.cleanup();
  }
}

export async function probeChromium(
  runner?: CreatureRunner,
): Promise<PreviewToolAvailability> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort({ kind: "timeout" }), CHROMIUM_PROBE_TIMEOUT_MS);
  timer.unref();
  try {
    if (runner) {
      const result = await probeChromiumWithRunner(runner, controller.signal);
      if (controller.signal.aborted) {
        return {
          available: false,
          reason: "Chromium launch probing timed out; install Chromium with 'npx playwright install chromium' or set PW_CHROMIUM_PATH to a working browser.",
        };
      }
      if (result.exitCode === 0 && result.signalCode === null && !result.overflow) {
        return { available: true };
      }
      const detail = diagnostic(result);
      return {
        available: false,
        reason: `Chromium could not launch${detail ? ` (${detail})` : ""}; run 'npx playwright install chromium' or set PW_CHROMIUM_PATH to an existing Chromium/Chrome binary.`,
      };
    }

    const executablePath = process.env.PW_CHROMIUM_PATH?.trim();
    const temp = await createBrowserTempDir();
    try {
      const browser = await chromium.launch({
        ...(executablePath ? { executablePath } : {}),
        args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", ...(process.env.PW_NO_SANDBOX === "1" ? ["--no-sandbox"] : [])],
        timeout: CHROMIUM_PROBE_TIMEOUT_MS,
        env: { ...process.env, ...temp.env },
      });
      try {
        return { available: true };
      } finally {
        await browser.close();
      }
    } finally {
      await temp.remove();
    }
  } catch (error) {
    return {
      available: false,
      reason: `Chromium could not launch${error instanceof Error ? ` (${error.message.split("\n")[0]})` : ""}; run 'npx playwright install chromium' or set PW_CHROMIUM_PATH to an existing Chromium/Chrome binary.`,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runSilhouette(
  runner: CreatureRunner,
  glbPath: string,
  outputDirectory: string,
  signal: AbortSignal,
): Promise<{ readonly backend: CreaturePreviewBackend; readonly metrics: Record<string, unknown> }> {
  const payloadRoot = await runner.ensurePayload(signal);
  const pythonName = process.env.THREENATIVE_CREATURE_PYTHON?.trim() || "python3";
  const pythonAvailable = await executableOnPath(pythonName);
  if (pythonAvailable) {
    const result = await runCommand(pythonName, [join(payloadRoot, "harness", "outline.py"), glbPath, outputDirectory, "--views", PYTHON_VIEWS], payloadRoot, signal);
    throwIfPreviewAborted(signal);
    if (result.exitCode === 0 && !result.overflow) {
      const metrics = JSON.parse(await readFile(join(outputDirectory, "metrics.json"), "utf8")) as Record<string, unknown>;
      return { backend: cameraFor("silhouettes", "python-outline"), metrics };
    }
  }
  throwIfPreviewAborted(signal);
  const harness = await createBrowserHarness(payloadRoot);
  try {
    throwIfPreviewAborted(signal);
    const result = await runCommand(process.execPath, [join(harness.scriptRoot, "silmetrics.mjs"), glbPath, outputDirectory], harness.root, signal, browserTempEnvironment(harness.tmp));
    throwIfPreviewAborted(signal);
    if (result.exitCode !== 0 || result.overflow) {
      throw new CreatureOperationError(
        "TOOLCHAIN_UNAVAILABLE",
        "Silhouette rendering needs Python with NumPy/Pillow or a launchable Chromium browser.",
        { backend: "browser-silmetrics", stderr: result.stderr.slice(-2_000), setup: "Install NumPy/Pillow or run npx playwright install chromium." },
      );
    }
    const metrics = JSON.parse(await readFile(join(outputDirectory, "metrics.json"), "utf8")) as Record<string, unknown>;
    return { backend: cameraFor("silhouettes", "browser-silmetrics"), metrics };
  } finally {
    await harness.cleanup();
  }
}

async function runHero(
  runner: CreatureRunner,
  glbPath: string,
  outputDirectory: string,
  signal: AbortSignal,
): Promise<CreaturePreviewBackend> {
  const payloadRoot = await runner.ensurePayload(signal);
  const harness = await createBrowserHarness(payloadRoot);
  try {
    throwIfPreviewAborted(signal);
    const result = await runCommand(process.execPath, [join(harness.scriptRoot, "hero.mjs"), glbPath, outputDirectory], harness.root, signal, browserTempEnvironment(harness.tmp));
    throwIfPreviewAborted(signal);
    if (result.exitCode !== 0 || result.overflow) {
      throw new CreatureOperationError(
        "TOOLCHAIN_UNAVAILABLE",
        "Hero rendering requires a launchable Chromium browser.",
        { backend: "browser-hero", stderr: result.stderr.slice(-2_000), setup: "Run npx playwright install chromium or set PW_CHROMIUM_PATH." },
      );
    }
    return cameraFor("hero", "browser-hero");
  } finally {
    await harness.cleanup();
  }
}

const PriorPreviewArtifactSchema = z
  .object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    bytes: z.number().int().positive(),
    included: z.boolean(),
    omittedReason: z.string().max(500).optional(),
  })
  .strict();

const PriorPreviewViewSchema = z
  .object({
    name: z.string().min(1),
    image: PriorPreviewArtifactSchema,
    thumbnail: PriorPreviewArtifactSchema,
    measurements: z.record(z.string(), z.unknown()),
  })
  .strict();

const PriorPreviewBackendSchema = z
  .object({
    id: z.enum(["python-outline", "browser-silmetrics", "browser-hero"]),
    nativeViewNames: z.array(z.string().min(1)).min(1),
    camera: z
      .object({
        projection: z.literal("perspective"),
        fovDegrees: z.number().finite().positive(),
        resolution: z
          .object({
            width: z.number().int().positive(),
            height: z.number().int().positive(),
          })
          .strict(),
        distanceMultiplier: z.number().finite().positive().optional(),
        initialDistanceMultiplier: z.number().finite().positive().optional(),
        fitFraction: z.number().finite().positive().optional(),
      })
      .strict(),
  })
  .strict();

const PriorPreviewReceiptSchema = z
  .object({
    operation: z.literal("creature_preview"),
    mode: z.enum(["silhouettes", "hero"]),
    glbPath: z.string().min(1),
    glbSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    previewId: z.string().regex(/^[a-z0-9-]{8,80}$/u),
    backend: PriorPreviewBackendSchema,
    views: z.array(PriorPreviewViewSchema).min(1),
    encodedImageBudgetBytes: z.literal(IMAGE_BUDGET_BYTES),
    visualReview: z.literal("notReviewed"),
    comparison: z
      .object({
        previousPreviewId: z.string().min(1),
        compatible: z.literal(true),
      })
      .strict()
      .optional(),
  })
  .strict();

type PriorPreviewArtifact = z.output<typeof PriorPreviewArtifactSchema>;
type PriorPreviewReceipt = z.output<typeof PriorPreviewReceiptSchema>;

async function readPriorReceipt(
  root: string,
  previewId: string,
): Promise<{ readonly directory: string; readonly receipt: PriorPreviewReceipt }> {
  if (!/^[a-z0-9-]{8,80}$/u.test(previewId)) {
    throw new CreatureOperationError("INVALID_SPEC", "previousPreviewId is invalid.");
  }
  const directory = join(root, ".threenative", "creatures", "previews", previewId);
  const directoryInfo = await lstat(directory).catch(() => undefined);
  if (!directoryInfo?.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new CreatureOperationError("PREVIEW_COMPARISON", "The previous preview directory is missing or unsafe.", { previousPreviewId: previewId });
  }
  if (await realpath(directory).catch(() => undefined) !== directory) {
    throw new CreatureOperationError("PREVIEW_COMPARISON", "The previous preview directory is not an owned real directory.", { previousPreviewId: previewId });
  }
  const candidate = join(directory, "receipt.json");
  const candidateInfo = await lstat(candidate).catch(() => undefined);
  if (candidateInfo?.isSymbolicLink()) throw new CreatureOperationError("PREVIEW_COMPARISON", "The previous preview receipt is a symlink and cannot be compared.", { previousPreviewId: previewId });
  const canonical = await realpath(candidate).catch(() => {
    throw new CreatureOperationError("PREVIEW_COMPARISON", "The previous preview receipt is missing; render a complete prior preview before comparing.", { previousPreviewId: previewId });
  });
  if (canonical !== candidate) throw new CreatureOperationError("PREVIEW_COMPARISON", "The previous preview receipt is not an owned file in the requested preview directory.", { previousPreviewId: previewId });
  if (!candidateInfo?.isFile() || candidateInfo.isSymbolicLink()) throw new CreatureOperationError("PREVIEW_COMPARISON", "The previous preview receipt is not a regular file.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(candidate, "utf8")) as unknown;
  } catch {
    throw new CreatureOperationError("PREVIEW_COMPARISON", "The previous preview receipt is malformed.", { previousPreviewId: previewId });
  }
  const result = PriorPreviewReceiptSchema.safeParse(parsed);
  if (!result.success) {
    throw new CreatureOperationError("PREVIEW_COMPARISON", "The previous preview receipt is malformed or incomplete.", { previousPreviewId: previewId });
  }
  if (result.data.previewId !== previewId) {
    throw new CreatureOperationError("PREVIEW_COMPARISON", "The previous preview receipt does not belong to the requested preview directory.", { previousPreviewId: previewId, receiptPreviewId: result.data.previewId });
  }
  return { directory, receipt: result.data };
}

function sameBackend(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function verifyPriorArtifact(
  root: string,
  directory: string,
  mode: CreaturePreviewMode,
  viewName: string,
  key: "image" | "thumbnail",
  artifactValue: PriorPreviewArtifact,
  resolution: PreviewResolution,
): Promise<void> {
  const stem = mode === "hero" ? "hero" : `sil_${viewName}`;
  const filename = key === "image" ? `${stem}.png` : `${stem}_thumb48.png`;
  const expectedPath = join(directory, filename);
  const expectedProjectPath = projectPath(root, expectedPath);
  if (artifactValue.path !== expectedProjectPath) {
    throw new CreatureOperationError(
      "PREVIEW_COMPARISON",
      `The previous preview '${viewName}' ${key} artifact must use its owned canonical path.`,
      { view: viewName, artifact: key },
    );
  }
  const info = await lstat(expectedPath).catch(() => undefined);
  if (
    !info?.isFile() ||
    info.isSymbolicLink() ||
    (await realpath(expectedPath).catch(() => undefined)) !== expectedPath
  ) {
    throw new CreatureOperationError(
      "PREVIEW_COMPARISON",
      `The previous preview '${viewName}' ${key} artifact is missing or unsafe.`,
      { view: viewName, artifact: key },
    );
  }
  if (info.size !== artifactValue.bytes) {
    throw new CreatureOperationError(
      "PREVIEW_COMPARISON",
      `The previous preview '${viewName}' ${key} artifact byte count does not match its receipt.`,
      { view: viewName, artifact: key, expectedBytes: artifactValue.bytes, actualBytes: info.size },
    );
  }
  const bytes = await readFile(expectedPath);
  if (bytes.length !== artifactValue.bytes || sha256(bytes) !== artifactValue.sha256) {
    throw new CreatureOperationError(
      "PREVIEW_COMPARISON",
      `The previous preview '${viewName}' ${key} artifact hash does not match its receipt.`,
      { view: viewName, artifact: key },
    );
  }
  if (key === "image") {
    try {
      await readPng(expectedPath, resolution);
    } catch {
      throw new CreatureOperationError(
        "PREVIEW_COMPARISON",
        `The previous preview '${viewName}' image does not match its declared camera resolution.`,
        { view: viewName, artifact: key, resolution },
      );
    }
  }
}

async function completeArtifacts(
  root: string,
  directory: string,
  names: readonly string[],
  metrics: Record<string, unknown>,
  backend: CreaturePreviewBackend,
  signal: AbortSignal,
): Promise<{ readonly views: readonly CreaturePreviewView[]; readonly content: readonly PreviewImageContent[]; readonly encodedBytes: number }> {
  const views: CreaturePreviewView[] = [];
  const content: PreviewImageContent[] = [];
  let encodedBytes = 0;
  const images: Array<{ readonly name: string; readonly image: ImageData; readonly imagePath: string; readonly thumbnailPath: string; readonly thumbnail: Buffer }> = [];
  for (const name of names) {
    if (signal.aborted) throw new CreatureOperationError("CANCELLED", "Creature preview rendering was cancelled; no preview approval was recorded.");
    const imagePath = join(directory, names.length === 1 && name === "hero" ? "hero.png" : `sil_${name}.png`);
    const image = await readPng(imagePath, backend.camera.resolution);
    const thumbnailPath = join(directory, `${names.length === 1 && name === "hero" ? "hero" : `sil_${name}`}_thumb48.png`);
    const thumbnailBytes = await thumbnail(image, thumbnailPath);
    images.push({ name, image, imagePath, thumbnailPath, thumbnail: thumbnailBytes });
    encodedBytes += Buffer.byteLength(image.bytes.toString("base64")) + Buffer.byteLength(thumbnailBytes.toString("base64"));
  }
  const includeAll = encodedBytes <= IMAGE_BUDGET_BYTES;
  for (const entry of images) {
    const imageIncluded = includeAll;
    const thumbnailIncluded = includeAll;
    const imageArtifact = artifact(root, entry.imagePath, entry.image.bytes, imageIncluded, includeAll ? undefined : "encoded image budget exceeded");
    const thumbnailArtifact = artifact(root, entry.thumbnailPath, entry.thumbnail, thumbnailIncluded, includeAll ? undefined : "encoded image budget exceeded");
    const view: CreaturePreviewView = {
      name: entry.name,
      image: imageArtifact,
      thumbnail: thumbnailArtifact,
      measurements: {
        ...fallbackMeasurements(entry.image),
        ...measurementsFor(entry.name, metrics),
      },
    };
    views.push(view);
    if (imageIncluded) content.push({ type: "image", mimeType: "image/png", data: entry.image.bytes.toString("base64") });
    if (thumbnailIncluded) content.push({ type: "image", mimeType: "image/png", data: entry.thumbnail.toString("base64") });
  }
  return { views, content, encodedBytes };
}

export async function previewCreature(
  runner: CreatureRunner,
  request: CreaturePreviewRequest,
  callerSignal?: AbortSignal,
): Promise<{ readonly output: CreaturePreviewResult; readonly content: readonly PreviewImageContent[] }> {
  return runner.withHeavyOperation(
    PREVIEW_TIMEOUT_MS,
    `Creature preview exceeded ${PREVIEW_TIMEOUT_MS} ms; use a smaller asset or retry when the machine is less loaded.`,
    callerSignal,
    async (signal) => {
      try {
        const input = await runner.resolveProjectFile(request.glbPath, "glbPath");
        const glbBytes = await readFile(input.absolute);
        const glbSha256 = sha256(glbBytes);
        const previewId = randomUUID();
        const preview = await runner.createPreviewDirectory(previewId);
        let backend: CreaturePreviewBackend;
        let metrics: Record<string, unknown> = {};
        if (request.mode === "silhouettes") {
          const result = await runSilhouette(runner, input.absolute, preview.directory, signal);
          backend = result.backend;
          metrics = result.metrics;
        } else {
          backend = await runHero(runner, input.absolute, preview.directory, signal);
        }
        const names = request.mode === "silhouettes" ? SILHOUETTE_VIEWS : ["hero"] as const;
        const completed = await completeArtifacts(input.root, preview.directory, names, metrics, backend, signal);
        let comparison: CreaturePreviewResult["comparison"];
        if (request.previousPreviewId !== undefined) {
          const previous = await readPriorReceipt(input.root, request.previousPreviewId);
          if (
            previous.receipt.mode !== request.mode ||
            previous.receipt.glbPath !== input.relative ||
            previous.receipt.glbSha256 !== glbSha256
          ) {
            throw new CreatureOperationError("PREVIEW_COMPARISON", "The previous preview belongs to a different creature or preview mode; rerender it before comparing.", { previousPreviewId: request.previousPreviewId });
          }
          if (!sameBackend(previous.receipt.backend, backend)) {
            throw new CreatureOperationError("PREVIEW_COMPARISON", "The previous preview used a different backend or camera; rerender it with the same backend before comparing.", { previousPreviewId: request.previousPreviewId, previousBackend: previous.receipt.backend, backend });
          }
          const previousViews = previous.receipt.views;
          const previousNames = previousViews.map((view) => view.name);
          const completedNames = completed.views.map((view) => view.name);
          if (
            previousNames.length !== completedNames.length ||
            new Set(previousNames).size !== previousNames.length ||
            new Set(previousNames).size !== new Set(completedNames).size ||
            completedNames.some((name) => !previousNames.includes(name))
          ) {
            throw new CreatureOperationError("PREVIEW_COMPARISON", "The previous preview is missing one or more referenced views.", { previousPreviewId: request.previousPreviewId });
          }
          for (const view of completed.views) {
            const prior = previousViews.find((candidate) => candidate.name === view.name);
            if (!prior) {
              throw new CreatureOperationError("PREVIEW_COMPARISON", `The previous preview is missing the '${view.name}' artifact.`, { previousPreviewId: request.previousPreviewId, view: view.name });
            }
            await verifyPriorArtifact(input.root, previous.directory, request.mode, view.name, "image", prior.image, previous.receipt.backend.camera.resolution);
            await verifyPriorArtifact(input.root, previous.directory, request.mode, view.name, "thumbnail", prior.thumbnail, previous.receipt.backend.camera.resolution);
          }
          comparison = { previousPreviewId: request.previousPreviewId, compatible: true };
        }
        const receipt = {
          operation: "creature_preview",
          mode: request.mode,
          glbPath: input.relative,
          glbSha256,
          previewId,
          backend,
          views: completed.views,
          encodedImageBudgetBytes: IMAGE_BUDGET_BYTES,
          visualReview: "notReviewed",
          ...(comparison ? { comparison } : {}),
        } satisfies Record<string, unknown>;
        const receiptPath = join(preview.directory, "receipt.json");
        await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
        return {
          output: {
            ...receipt,
            receiptPath: projectPath(input.root, receiptPath),
          } as CreaturePreviewResult,
          content: completed.content,
        };
      } catch (error) {
        if (signal.aborted) throw previewAbortError(signal);
        throw error;
      }
    },
  );
}

export function previewError(error: unknown): { readonly operation: "creature_preview"; readonly code: string; readonly message: string; readonly detail: Record<string, unknown> } {
  if (error instanceof CreatureOperationError) {
    return { operation: "creature_preview", code: error.code, message: error.message, detail: error.detail };
  }
  return { operation: "creature_preview", code: "TOOLCHAIN_UNAVAILABLE", message: "The creature preview could not complete the local operation.", detail: { cause: error instanceof Error ? error.message : "unknown" } };
}
