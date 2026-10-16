import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";

import { isInside, sha256File, sha256Json } from "./fsutil.js";
import { inspectSemantics, type SemanticRequest, type SemanticResult } from "./semantic.js";

/**
 * Wrap the existing `threenative-playtest audio` inspector.
 *
 * Every measurement and every judgement about peaks, silence, bands and loop seams belongs to that
 * package. This module only decides which bytes get inspected, translates the caller's expectations
 * into its manifest, and turns its report into an agent-facing result that never overstates what was
 * actually checked. It does not re-implement a single DSP routine, and it never repairs the input.
 */

export type AudioInspectErrorCode =
  | "AUDIO_INSPECT_INVALID_INPUT"
  | "AUDIO_INSPECT_NOT_FOUND"
  | "AUDIO_INSPECT_OUTSIDE_ROOT"
  | "AUDIO_INSPECT_TOO_LARGE"
  | "AUDIO_INSPECT_UNSUPPORTED"
  | "AUDIO_INSPECT_TOOL_MISSING"
  | "AUDIO_INSPECT_FAILED";

export class AudioInspectError extends Error {
  constructor(
    public readonly code: AudioInspectErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "AudioInspectError";
  }
}

/** v1 limits, reported in every result so a caller never has to guess why something was refused. */
export const INSPECT_LIMITS = {
  maxBytes: 64 * 1024 * 1024,
  maxSeconds: 60,
  maxChannels: 2,
  maxSampleRate: 96_000,
  /** Wall clock for the inspector subprocess itself. */
  timeoutMs: 120_000,
  /** stdout is a JSON report, not a stream; a runaway one is a failure, not something to buffer. */
  maxOutputBytes: 8 * 1024 * 1024,
} as const;

const DECODABLE_EXTENSIONS = new Set([".wav", ".ogg", ".oga", ".mp3", ".flac"]);

/** Exit 69 from the inspector: ffmpeg absent. "I could not check" is never "I checked and it passed". */
const NO_DECODER_EXIT = 69;

export const AUDIO_BAND_NAMES = ["sub", "low", "mid", "high", "air"] as const;
export type AudioBandName = (typeof AUDIO_BAND_NAMES)[number];

export interface AudioBandBound {
  min?: number | undefined;
  max?: number | undefined;
}

export interface AudioEmotionRequest {
  sourceDescription: string;
  targetMood: string;
  alternativeMoods: string[];
}

type PartialBands = { [K in AudioBandName]?: AudioBandBound | undefined };

export interface AudioInspectRequest {
  path: string;
  loop: boolean;
  expectedDurationSeconds?: number | undefined;
  expectedPrompt?: string | undefined;
  alternativePrompts?: string[] | undefined;
  emotion?: AudioEmotionRequest | undefined;
  bands?: PartialBands | undefined;
  peakMax?: number | undefined;
  silenceRms?: number | undefined;
  seamMaxRatio?: number | undefined;
  semantic?: "off" | "clap" | "earshot" | undefined;
}

export interface AudioFinding {
  name: string;
  severity: "error" | "warning";
  reason: string;
  remedy?: string;
}

export interface AudioMeasured {
  durationSeconds: number;
  sampleRate: number;
  channels: number;
  peak: number;
  rms: number;
  dc: number;
  bands: Record<AudioBandName, number>;
  seam?: { wrap: number; nearP99: number; ratio: number };
}

export interface AudioInspectResult {
  inputPath: string;
  inputSha256: string;
  inputSizeBytes: number;
  analysis: { inspector: string; inspectorVersion: string; adapterVersion: string };
  limits: typeof INSPECT_LIMITS;
  effectiveExpectations: Record<string, unknown>;
  measured?: AudioMeasured;
  findings: AudioFinding[];
  spectrogramPath?: string;
  technicalStatus: "pass" | "warn" | "fail" | "unverified";
  promptFit: "consistent" | "possible_mismatch" | "unverified";
  emotionFit: SemanticResult["emotionFit"];
  semantic: SemanticResult["content"];
  artisticQuality: "unverified";
  recommendation: "reject" | "review" | "audition";
  notes: string[];
  cacheKey: string;
  cached: boolean;
}

/** Bumped whenever this adapter changes how it translates or judges, so old cache entries retire. */
const ADAPTER_VERSION = "1";

export interface AudioInspectorOptions {
  /** Extra roots a caller may inspect, beyond the canonical audio download directory. */
  inspectRoots?: string[];
  audioDir?: string;
  /** Overridden only by tests that need a fake inspector; production resolves the pinned package. */
  inspectorBin?: string;
}

export class AudioInspector {
  private readonly audioDir: string;
  private readonly extraRoots: string[];
  private readonly inspectorBinOverride: string | undefined;

  constructor(options: AudioInspectorOptions = {}) {
    this.audioDir = resolve(
      options.audioDir ??
        process.env.AUDIO_DOWNLOAD_DIR ??
        join(homedir(), "Downloads", "threenative-asset-mcp", "audio"),
    );
    const configured =
      options.inspectRoots ??
      (process.env.AUDIO_INSPECT_ROOTS ?? "")
        .split(":")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    // The launch directory is included by default so an agent can inspect the game it is working in.
    this.extraRoots = [...configured, process.cwd()].map((entry) => resolve(entry));
    this.inspectorBinOverride = options.inspectorBin;
  }

  /** Absolute path of the pinned inspector's declared binary. Never `npx`, never a shell lookup. */
  resolveInspectorBin(): string {
    if (this.inspectorBinOverride !== undefined) return this.inspectorBinOverride;
    let manifestPath: string;
    try {
      manifestPath = createRequire(import.meta.url).resolve("@threenative/playtest/package.json");
    } catch {
      throw new AudioInspectError(
        "AUDIO_INSPECT_TOOL_MISSING",
        "The pinned @threenative/playtest inspector is not installed, so no audio was inspected.",
      );
    }
    return join(dirname(manifestPath), "dist", "runner", "cli.js");
  }

  private inspectorVersion(): string {
    if (this.inspectorBinOverride !== undefined) return "test-stub";
    const manifest = createRequire(import.meta.url)("@threenative/playtest/package.json") as {
      version?: string;
    };
    return manifest.version ?? "unknown";
  }

  async inspect(request: AudioInspectRequest): Promise<AudioInspectResult> {
    const file = await this.resolveInput(request.path);
    const inputSha256 = await sha256File(file.path);
    const expectations = effectiveExpectations(request);
    const semanticRequest = semanticRequestOf(request);
    const cacheKey = sha256Json({
      adapter: ADAPTER_VERSION,
      inspector: this.inspectorVersion(),
      input: inputSha256,
      expectations,
      semantic: semanticRequest,
    });

    const cacheDir = join(this.audioDir, "inspections", cacheKey);
    const cached = await readCached(cacheDir);
    if (cached) return { ...cached, cached: true };

    const result = await this.runInspection({
      cacheDir,
      expectations,
      file,
      inputSha256,
      request,
      semanticRequest,
    });

    // The source bytes must be exactly what we measured; a changed file invalidates the whole result.
    if ((await sha256File(file.path)) !== inputSha256) {
      throw new AudioInspectError(
        "AUDIO_INSPECT_FAILED",
        "The input file changed while it was being inspected, so the result would not describe it.",
        true,
      );
    }

    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    await writeFile(join(cacheDir, "result.json"), JSON.stringify(result, null, 2), {
      mode: 0o600,
    });
    return result;
  }

  private async resolveInput(
    rawPath: string,
  ): Promise<{ path: string; sizeBytes: number }> {
    if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
      throw new AudioInspectError("AUDIO_INSPECT_INVALID_INPUT", "The audio path is empty.");
    }
    const candidate = resolve(rawPath);

    let link: Awaited<ReturnType<typeof lstat>>;
    try {
      link = await lstat(candidate);
    } catch {
      throw new AudioInspectError("AUDIO_INSPECT_NOT_FOUND", "No audio file exists at that path.");
    }
    if (!link.isFile() && !link.isSymbolicLink()) {
      throw new AudioInspectError(
        "AUDIO_INSPECT_INVALID_INPUT",
        "Only a regular audio file can be inspected.",
      );
    }

    // Resolve first, then contain: a symlink that points outside the roots must not smuggle a file in.
    let real: string;
    try {
      real = await realpath(candidate);
    } catch {
      throw new AudioInspectError("AUDIO_INSPECT_NOT_FOUND", "No audio file exists at that path.");
    }
    const info = await stat(real);
    if (!info.isFile()) {
      throw new AudioInspectError(
        "AUDIO_INSPECT_INVALID_INPUT",
        "Only a regular audio file can be inspected.",
      );
    }

    const roots = await this.allowedRoots();
    if (!roots.some((root) => isInside(real, root))) {
      throw new AudioInspectError(
        "AUDIO_INSPECT_OUTSIDE_ROOT",
        "That path is outside the audio download directory and every configured AUDIO_INSPECT_ROOTS entry.",
      );
    }
    if (!DECODABLE_EXTENSIONS.has(extname(real).toLowerCase())) {
      throw new AudioInspectError(
        "AUDIO_INSPECT_UNSUPPORTED",
        `Inspection accepts ${[...DECODABLE_EXTENSIONS].join(", ")}; playlists and other containers are refused.`,
      );
    }
    if (info.size > INSPECT_LIMITS.maxBytes) {
      throw new AudioInspectError(
        "AUDIO_INSPECT_TOO_LARGE",
        `The file is larger than the ${String(INSPECT_LIMITS.maxBytes)}-byte inspection limit.`,
      );
    }
    return { path: real, sizeBytes: info.size };
  }

  private async allowedRoots(): Promise<string[]> {
    const roots: string[] = [];
    for (const candidate of [this.audioDir, ...this.extraRoots]) {
      try {
        roots.push(await realpath(candidate));
      } catch {
        // A configured root that does not exist yet simply grants nothing.
      }
    }
    return roots;
  }

  private async runInspection(context: {
    cacheDir: string;
    expectations: Record<string, unknown>;
    file: { path: string; sizeBytes: number };
    inputSha256: string;
    request: AudioInspectRequest;
    semanticRequest: SemanticRequest | undefined;
  }): Promise<AudioInspectResult> {
    const { file, request, semanticRequest } = context;
    const workDir = await mkdtemp(join(tmpdir(), "asset-mcp-inspect-"));
    const notes: string[] = [];
    try {
      // An immutable snapshot: the inspector reads our copy, so the caller's file cannot be touched
      // and cannot change underneath the measurement.
      const clipName = `clip${extname(file.path).toLowerCase()}`;
      await copyFile(file.path, join(workDir, clipName));
      const outDir = join(workDir, "artifacts");
      await writeFile(
        join(workDir, "expect.json"),
        JSON.stringify(manifestFor(clipName, request), null, 2),
      );

      const run = await this.runInspector(workDir, outDir);

      if (run.code === NO_DECODER_EXIT) {
        notes.push(
          "FFmpeg is not installed, so nothing was decoded and nothing was measured. This is not a pass.",
        );
        return this.assemble({
          ...context,
          findings: [],
          measured: undefined,
          notes,
          semantic: await this.semantics(semanticRequest, file.path, notes, false),
          spectrogramPath: undefined,
          technicalStatus: "unverified",
        });
      }
      if (run.code !== 0 && run.code !== 1) {
        throw new AudioInspectError(
          "AUDIO_INSPECT_FAILED",
          `The inspector did not complete (exit ${String(run.code)}), so nothing was verified.`,
          true,
        );
      }

      const report = parseReport(run.stdout);
      const clip = report.clips.find((entry) => entry.path === clipName);
      const findings = report.checks
        .filter((check) => check.status !== "ok")
        .map((check) => ({
          name: check.name,
          severity: check.status === "fail" ? ("error" as const) : ("warning" as const),
          reason: check.detail,
          ...(check.fix === undefined ? {} : { remedy: check.fix }),
        }));

      if (report.checks.length === 0) {
        throw new AudioInspectError(
          "AUDIO_INSPECT_FAILED",
          "The inspector asserted nothing about this clip, so nothing was verified.",
          true,
        );
      }

      const measured = clip ? measuredOf(clip.analysis) : undefined;
      if (measured) {
        findings.push(...limitFindings(measured));
        findings.push(...durationFindings(measured, request.expectedDurationSeconds, notes));
      }

      const spectrogramPath = await this.keepSpectrogram(outDir, context.cacheDir);
      const semantic = await this.semantics(semanticRequest, file.path, notes, true);

      const hasError = findings.some((finding) => finding.severity === "error");
      return this.assemble({
        ...context,
        findings,
        measured,
        notes,
        semantic,
        spectrogramPath,
        technicalStatus: hasError ? "fail" : findings.length > 0 ? "warn" : "pass",
      });
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  private async semantics(
    request: SemanticRequest | undefined,
    audioPath: string,
    notes: string[],
    decoded: boolean,
  ): Promise<SemanticResult> {
    if (!request) return inspectSemantics(undefined, audioPath);
    if (!decoded) {
      notes.push("Semantic comparison was skipped because the audio never decoded.");
      return inspectSemantics(undefined, audioPath);
    }
    const result = await inspectSemantics(request, audioPath);
    if (result.unavailableReason) notes.push(result.unavailableReason);
    return result;
  }

  private async keepSpectrogram(outDir: string, cacheDir: string): Promise<string | undefined> {
    let names: string[];
    try {
      names = await readdir(outDir);
    } catch {
      return undefined;
    }
    const png = names.find((name) => name.endsWith(".png"));
    if (png === undefined) return undefined;
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    const kept = join(cacheDir, png);
    await copyFile(join(outDir, png), kept);
    return kept;
  }

  private runInspector(
    workDir: string,
    outDir: string,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const bin = this.resolveInspectorBin();
    return new Promise((done, fail) => {
      execFile(
        process.execPath,
        [bin, "audio", "--root", workDir, "--expect", "expect.json", "--out", outDir],
        {
          timeout: INSPECT_LIMITS.timeoutMs,
          maxBuffer: INSPECT_LIMITS.maxOutputBytes,
          // No shell, an argument array, and nothing inherited that could redirect the decoder.
          env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const code =
            error && typeof (error as { code?: unknown }).code === "number"
              ? (error as { code: number }).code
              : error
                ? -1
                : 0;
          if (code === -1) {
            fail(
              new AudioInspectError(
                "AUDIO_INSPECT_FAILED",
                "The inspector process could not be run to completion.",
                true,
              ),
            );
            return;
          }
          done({ code, stdout, stderr });
        },
      );
    });
  }

  private assemble(context: {
    cacheDir: string;
    expectations: Record<string, unknown>;
    file: { path: string; sizeBytes: number };
    findings: AudioFinding[];
    inputSha256: string;
    measured: AudioMeasured | undefined;
    notes: string[];
    semantic: SemanticResult;
    spectrogramPath: string | undefined;
    technicalStatus: AudioInspectResult["technicalStatus"];
  }): AudioInspectResult {
    const { semantic, technicalStatus } = context;
    return {
      inputPath: context.file.path,
      inputSha256: context.inputSha256,
      inputSizeBytes: context.file.sizeBytes,
      analysis: {
        inspector: "@threenative/playtest audio",
        inspectorVersion: this.inspectorVersion(),
        adapterVersion: ADAPTER_VERSION,
      },
      limits: INSPECT_LIMITS,
      effectiveExpectations: context.expectations,
      ...(context.measured === undefined ? {} : { measured: context.measured }),
      findings: context.findings,
      ...(context.spectrogramPath === undefined
        ? {}
        : { spectrogramPath: context.spectrogramPath }),
      technicalStatus,
      promptFit: semantic.content.status,
      emotionFit: semantic.emotionFit,
      semantic: semantic.content,
      artisticQuality: "unverified",
      recommendation: recommend(technicalStatus, semantic),
      notes: [
        ...context.notes,
        "An audition recommendation is not a judgement of artistic quality; nobody listened to this.",
      ],
      cacheKey: context.cacheDir.split("/").pop() ?? "",
      cached: false,
    };
  }
}

/** Definite technical failures reject; anything incomplete or merely suspicious asks for review. */
function recommend(
  technicalStatus: AudioInspectResult["technicalStatus"],
  semantic: SemanticResult,
): AudioInspectResult["recommendation"] {
  if (technicalStatus === "fail") return "reject";
  if (technicalStatus === "warn" || technicalStatus === "unverified") return "review";
  // A requested check that could not be completed is not a check that passed.
  if (semantic.content.status === "possible_mismatch") return "review";
  if (semantic.content.requested && semantic.content.status === "unverified") return "review";
  if (semantic.emotionFit.status === "possible_mismatch") return "review";
  if (semantic.emotionFit.status === "unverified") return "review";
  return "audition";
}

function manifestFor(clipName: string, request: AudioInspectRequest): unknown {
  return {
    version: 1,
    clips: [
      {
        path: clipName,
        loop: request.loop,
        ...(request.bands === undefined ? {} : { bands: request.bands }),
        ...(request.peakMax === undefined ? {} : { peakMax: request.peakMax }),
        ...(request.silenceRms === undefined ? {} : { silenceRms: request.silenceRms }),
        // The inspector refuses a seam bound on a one-shot, and it is right to.
        ...(request.seamMaxRatio === undefined || !request.loop
          ? {}
          : { seamMaxRatio: request.seamMaxRatio }),
      },
    ],
  };
}

function effectiveExpectations(request: AudioInspectRequest): Record<string, unknown> {
  return {
    loop: request.loop,
    // Echoed exactly as sent, including the inspector's own defaults left unnamed, so a caller can
    // see which floor they were actually held to.
    peakMax: request.peakMax ?? 0.98,
    silenceRms: request.silenceRms ?? 1e-4,
    ...(request.loop ? { seamMaxRatio: request.seamMaxRatio ?? 1.5 } : {}),
    ...(request.bands === undefined ? {} : { bands: request.bands }),
    ...(request.expectedDurationSeconds === undefined
      ? {}
      : { expectedDurationSeconds: request.expectedDurationSeconds }),
  };
}

function semanticRequestOf(request: AudioInspectRequest): SemanticRequest | undefined {
  if (request.semantic !== "clap" && request.semantic !== "earshot") return undefined;
  return {
    backend: request.semantic,
    ...(request.expectedPrompt === undefined ? {} : { expectedPrompt: request.expectedPrompt }),
    ...(request.alternativePrompts === undefined
      ? {}
      : { alternativePrompts: request.alternativePrompts }),
    ...(request.emotion === undefined ? {} : { emotion: request.emotion }),
  };
}

interface RawCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  fix?: string;
}
interface RawAnalysis {
  bands: Record<string, number>;
  channels: number;
  dc: number;
  peak: number;
  rms: number;
  sampleRate: number;
  seconds: number;
  seam?: { wrap: number; nearP99: number; ratio: number };
}
interface RawReport {
  checks: RawCheck[];
  clips: { path: string; analysis: RawAnalysis; spectrogram?: string }[];
  pass: boolean;
}

function parseReport(stdout: string): RawReport {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new AudioInspectError(
      "AUDIO_INSPECT_FAILED",
      "The inspector did not return a JSON report, so nothing was verified.",
      true,
    );
  }
  if (
    typeof raw !== "object" ||
    raw === null ||
    !Array.isArray((raw as RawReport).checks) ||
    !Array.isArray((raw as RawReport).clips)
  ) {
    throw new AudioInspectError(
      "AUDIO_INSPECT_FAILED",
      "The inspector's report was not in the expected shape, so nothing was verified.",
      true,
    );
  }
  return raw as RawReport;
}

function measuredOf(analysis: RawAnalysis): AudioMeasured {
  const bands = Object.fromEntries(
    AUDIO_BAND_NAMES.map((name) => [name, analysis.bands[name] ?? 0]),
  ) as Record<AudioBandName, number>;
  return {
    durationSeconds: analysis.seconds,
    sampleRate: analysis.sampleRate,
    channels: analysis.channels,
    peak: analysis.peak,
    rms: analysis.rms,
    dc: analysis.dc,
    bands,
    ...(analysis.seam === undefined ? {} : { seam: analysis.seam }),
  };
}

/** A nonfinite measurement is a broken measurement, never a quiet pass. */
function limitFindings(measured: AudioMeasured): AudioFinding[] {
  const findings: AudioFinding[] = [];
  for (const [name, value] of [
    ["duration", measured.durationSeconds],
    ["peak", measured.peak],
    ["rms", measured.rms],
    ["dc", measured.dc],
  ] as const) {
    if (!Number.isFinite(value)) {
      findings.push({
        name: `${name} is finite`,
        severity: "error",
        reason: `The inspector measured a non-finite ${name}, so this file's audio is not valid.`,
        remedy: "Re-encode or regenerate the source; a non-finite sample cannot be played.",
      });
    }
  }
  if (measured.durationSeconds > INSPECT_LIMITS.maxSeconds) {
    findings.push({
      name: "within duration limit",
      severity: "error",
      reason: `The clip is ${measured.durationSeconds.toFixed(2)}s; this v1 inspects at most ${String(INSPECT_LIMITS.maxSeconds)}s.`,
      remedy: "Inspect a shorter excerpt, or split the file.",
    });
  }
  if (measured.channels > INSPECT_LIMITS.maxChannels) {
    findings.push({
      name: "within channel limit",
      severity: "error",
      reason: `The clip has ${String(measured.channels)} channels; this v1 inspects at most ${String(INSPECT_LIMITS.maxChannels)}.`,
      remedy: "Downmix to mono or stereo before inspecting.",
    });
  }
  if (measured.sampleRate > INSPECT_LIMITS.maxSampleRate) {
    findings.push({
      name: "within sample-rate limit",
      severity: "error",
      reason: `The clip is ${String(measured.sampleRate)} Hz; this v1 inspects at most ${String(INSPECT_LIMITS.maxSampleRate)} Hz.`,
      remedy: "Inspect a copy at 96 kHz or below.",
    });
  }
  return findings;
}

/**
 * Duration is the one expectation the inspector's manifest has no field for, so this adapter owns
 * it. A mismatch is reported; the file is never trimmed to make the number true.
 */
function durationFindings(
  measured: AudioMeasured,
  expected: number | undefined,
  notes: string[],
): AudioFinding[] {
  if (expected === undefined) return [];
  const tolerance = Math.max(0.1, expected * 0.02);
  const delta = Math.abs(measured.durationSeconds - expected);
  if (delta <= tolerance) return [];
  notes.push(
    `Requested ${expected.toFixed(2)}s, measured ${measured.durationSeconds.toFixed(2)}s; nothing was trimmed.`,
  );
  return [
    {
      name: "duration matches request",
      severity: "error",
      reason: `The clip is ${measured.durationSeconds.toFixed(2)}s against a requested ${expected.toFixed(2)}s, outside the ${tolerance.toFixed(2)}s tolerance.`,
      remedy: "Regenerate with the duration you want; this tool will not silently trim audio.",
    },
  ];
}

async function readCached(cacheDir: string): Promise<AudioInspectResult | undefined> {
  try {
    return JSON.parse(await readFile(join(cacheDir, "result.json"), "utf8")) as AudioInspectResult;
  } catch {
    return undefined;
  }
}
