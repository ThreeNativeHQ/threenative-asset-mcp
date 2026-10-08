import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { sha256Bytes, sha256File, sha256Json } from "./fsutil.js";
import {
  AudioInspector,
  type AudioInspectRequest,
  type AudioInspectResult,
  type AudioInspectorOptions,
} from "./inspect.js";
import { semanticAvailable } from "./semantic.js";

/**
 * One billed ElevenLabs sound-effect generation, saved and then inspected.
 *
 * The whole design here is about never charging twice. A `requestId` reserves a directory and a
 * normalized-request hash *before* the POST, every durable step is written down as it completes, and
 * a replay resumes from whichever verified bytes already exist. A submission whose outcome we never
 * learned stays `outcome_unknown` forever: repeating that id never resubmits, because the provider
 * may well have billed for it.
 */

export type AudioGenerateErrorCode =
  | "AUDIO_GENERATE_NO_CREDENTIALS"
  | "AUDIO_GENERATE_INVALID_INPUT"
  | "AUDIO_GENERATE_REQUEST_CONFLICT"
  | "AUDIO_GENERATE_OUTCOME_UNKNOWN"
  | "AUDIO_GENERATE_PREREQUISITE_MISSING"
  | "AUDIO_GENERATE_AUTH_FAILED"
  | "AUDIO_GENERATE_RATE_LIMITED"
  | "AUDIO_GENERATE_REJECTED"
  | "AUDIO_GENERATE_UPSTREAM"
  | "AUDIO_GENERATE_TIMEOUT"
  | "AUDIO_GENERATE_TOO_LARGE"
  | "AUDIO_GENERATE_UNSAFE_REDIRECT"
  | "AUDIO_GENERATE_STORAGE"
  | "AUDIO_GENERATE_CONVERT_FAILED"
  | "AUDIO_GENERATE_HASH_MISMATCH";

export class AudioGenerateError extends Error {
  constructor(
    public readonly code: AudioGenerateErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "AudioGenerateError";
  }
}

const ENDPOINT = "https://api.elevenlabs.io/v1/sound-generation";
const MODEL_ID = "eleven_text_to_sound_v2";
const OUTPUT_FORMAT = "mp3_44100_128";
const PROVIDER_TERMS_URL =
  "https://help.elevenlabs.io/hc/en-us/articles/13313564601361-Can-I-publish-the-content-I-generate-on-the-platform";

export const GENERATE_LIMITS = {
  /** Our policy cap, not a claimed provider maximum. */
  maxPromptChars: 2_000,
  minDurationSeconds: 0.5,
  maxDurationSeconds: 30,
  maxResponseBytes: 32 * 1024 * 1024,
  timeoutMs: 120_000,
} as const;

export interface AudioGenerateRequest {
  requestId: string;
  prompt: string;
  durationSeconds?: number | undefined;
  loop?: boolean | undefined;
  promptInfluence?: number | undefined;
  inspection?:
    | Omit<AudioInspectRequest, "path" | "loop" | "expectedDurationSeconds" | "expectedPrompt">
    | undefined;
}

type RequestState = "submitted" | "outcome_unknown" | "source_saved" | "wav_saved" | "complete";

interface Receipt {
  requestId: string;
  state: RequestState;
  normalizedHash: string;
  normalized: NormalizedRequest;
  provider: "elevenlabs";
  model: string;
  generatedAt?: string;
  providerRequestId?: string;
  billingUnits?: string;
  source?: { path: string; sha256: string; sizeBytes: number };
  wav?: { path: string; sha256: string; sizeBytes: number };
  inspectionCacheKey?: string;
  commercialUse: "unverified";
  providerTermsUrl: string;
}

interface NormalizedRequest {
  text: string;
  duration_seconds: number;
  loop: boolean;
  prompt_influence: number;
  model_id: string;
  output_format: string;
}

export interface AudioGenerateResult {
  requestId: string;
  provider: "elevenlabs";
  model: string;
  normalizedRequest: NormalizedRequest;
  generatedAt: string;
  generation: "saved";
  sourcePath: string;
  sourceSha256: string;
  sourceSizeBytes: number;
  wavPath: string;
  wavSha256: string;
  wavSizeBytes: number;
  providerRequestId?: string;
  billingUnits?: string;
  commercialUse: "unverified";
  providerTermsUrl: string;
  receiptPath: string;
  replayed: boolean;
  inspection: AudioInspectResult;
}

export interface AudioGeneratorOptions extends AudioInspectorOptions {
  fetch?: typeof globalThis.fetch;
  apiKey?: string;
  ffmpegPath?: string;
}

export class AudioGenerator {
  private readonly fetch: typeof globalThis.fetch;
  private readonly audioDir: string;
  private readonly apiKeyOverride: string | undefined;
  private readonly ffmpegPath: string;
  private readonly inspector: AudioInspector;
  /** Request directories this generator is working on right now. */
  private readonly inFlight = new Set<string>();

  constructor(options: AudioGeneratorOptions = {}) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.audioDir = resolve(
      options.audioDir ??
        process.env.AUDIO_DOWNLOAD_DIR ??
        join(homedir(), "Downloads", "threenative-asset-mcp", "audio"),
    );
    this.apiKeyOverride = options.apiKey;
    this.ffmpegPath = options.ffmpegPath ?? "ffmpeg";
    this.inspector = new AudioInspector({ ...options, audioDir: this.audioDir });
  }

  /**
   * The key is the operator's, read from their environment at call time. It is never defaulted,
   * never written to a receipt, never logged and never returned — a missing one is an error the
   * agent is expected to relay to the person running the server.
   */
  private apiKey(): string {
    const key = this.apiKeyOverride ?? process.env.ELEVENLABS_API_KEY;
    if (!key || key.trim().length === 0) {
      throw new AudioGenerateError(
        "AUDIO_GENERATE_NO_CREDENTIALS",
        "ELEVENLABS_API_KEY is not set, so no audio can be generated and nothing was charged. " +
          "Ask the user to set their own ElevenLabs API key in the MCP server's environment; " +
          "the catalog and local inspection tools keep working without it.",
      );
    }
    return key.trim();
  }

  async generate(request: AudioGenerateRequest): Promise<AudioGenerateResult> {
    const normalized = normalize(request);
    const normalizedHash = sha256Json(normalized);
    const dir = join(this.audioDir, "generated", request.requestId);
    // A duplicate that arrives while the first call is still converting would otherwise read its
    // half-finished receipt and race it through the same local files.
    if (this.inFlight.has(dir)) {
      throw new AudioGenerateError(
        "AUDIO_GENERATE_REQUEST_CONFLICT",
        "That requestId is already in flight. Wait for it, or use a new requestId.",
      );
    }
    this.inFlight.add(dir);
    try {
      return await this.generateOnce(request, normalized, normalizedHash, dir);
    } finally {
      this.inFlight.delete(dir);
    }
  }

  private async generateOnce(
    request: AudioGenerateRequest,
    normalized: NormalizedRequest,
    normalizedHash: string,
    dir: string,
  ): Promise<AudioGenerateResult> {
    const receiptPath = join(dir, "receipt.json");

    // Preflight: everything that could fail locally fails before a paid request is made.
    this.apiKey();
    await this.preflight(dir, request);

    const existing = await readReceipt(receiptPath);
    if (existing) {
      if (existing.normalizedHash !== normalizedHash) {
        throw new AudioGenerateError(
          "AUDIO_GENERATE_REQUEST_CONFLICT",
          "That requestId was already used with different options. Use a new requestId for a new attempt.",
        );
      }
      if (existing.state === "outcome_unknown") {
        throw new AudioGenerateError(
          "AUDIO_GENERATE_OUTCOME_UNKNOWN",
          "A previous submission of this requestId never reported its outcome; it may already have been " +
            "billed, so this id will never be resubmitted. Use a new requestId to deliberately try again.",
        );
      }
      // Everything from here is local work on bytes already paid for.
      return await this.resume(existing, dir, receiptPath, request);
    }

    await this.reserve(dir, receiptPath, {
      requestId: request.requestId,
      state: "submitted",
      normalizedHash,
      normalized,
      provider: "elevenlabs",
      model: MODEL_ID,
      commercialUse: "unverified",
      providerTermsUrl: PROVIDER_TERMS_URL,
    });

    const response = await this.submit(normalized, receiptPath);
    const receipt: Receipt = {
      requestId: request.requestId,
      state: "source_saved",
      normalizedHash,
      normalized,
      provider: "elevenlabs",
      model: MODEL_ID,
      generatedAt: new Date().toISOString(),
      ...(response.providerRequestId === undefined
        ? {}
        : { providerRequestId: response.providerRequestId }),
      ...(response.billingUnits === undefined ? {} : { billingUnits: response.billingUnits }),
      commercialUse: "unverified",
      providerTermsUrl: PROVIDER_TERMS_URL,
    };

    const sourcePath = join(dir, "source.mp3");
    await writeExclusive(sourcePath, response.body);
    receipt.source = {
      path: sourcePath,
      sha256: sha256Bytes(response.body),
      sizeBytes: response.body.byteLength,
    };
    await writeReceipt(receiptPath, receipt);

    return await this.resume(receipt, dir, receiptPath, request);
  }

  /** Local-only completion: convert, inspect, finish. Never reaches the provider, never charges. */
  private async resume(
    receipt: Receipt,
    dir: string,
    receiptPath: string,
    request: AudioGenerateRequest,
  ): Promise<AudioGenerateResult> {
    if (!receipt.source) {
      // `submitted` with nothing saved yet means another caller is mid-flight with this id. That is
      // a conflict to wait on, not an unknown outcome to condemn the id for.
      throw receipt.state === "submitted"
        ? new AudioGenerateError(
            "AUDIO_GENERATE_REQUEST_CONFLICT",
            "That requestId is already in flight. Wait for it, or use a new requestId.",
          )
        : new AudioGenerateError(
            "AUDIO_GENERATE_OUTCOME_UNKNOWN",
            "This request has no durable source audio, so it cannot be completed locally.",
          );
    }
    // Recorded before this call finishes it: a replay is one that arrived already complete.
    const replayed = receipt.state === "complete";
    // A saved file that no longer matches its recorded hash fails; it is never re-fetched.
    if ((await sha256File(receipt.source.path)) !== receipt.source.sha256) {
      throw new AudioGenerateError(
        "AUDIO_GENERATE_HASH_MISMATCH",
        "The saved source audio no longer matches the hash recorded when it was written.",
      );
    }

    const wavPath = join(dir, "sound.wav");
    if (!receipt.wav || !(await exists(wavPath))) {
      await this.toWav(receipt.source.path, wavPath);
      receipt.wav = {
        path: wavPath,
        sha256: await sha256File(wavPath),
        sizeBytes: (await stat(wavPath)).size,
      };
      receipt.state = "wav_saved";
      await writeReceipt(receiptPath, receipt);
    } else if ((await sha256File(wavPath)) !== receipt.wav.sha256) {
      throw new AudioGenerateError(
        "AUDIO_GENERATE_HASH_MISMATCH",
        "The saved WAV no longer matches the hash recorded when it was written.",
      );
    }

    const inspection = await this.inspector.inspect({
      ...(request.inspection ?? {}),
      path: wavPath,
      loop: receipt.normalized.loop,
      expectedDurationSeconds: receipt.normalized.duration_seconds,
      expectedPrompt: receipt.normalized.text,
    });

    receipt.state = "complete";
    receipt.inspectionCacheKey = inspection.cacheKey;
    await writeReceipt(receiptPath, receipt);

    return {
      requestId: receipt.requestId,
      provider: "elevenlabs",
      model: receipt.model,
      normalizedRequest: receipt.normalized,
      generatedAt: receipt.generatedAt ?? new Date().toISOString(),
      generation: "saved",
      sourcePath: receipt.source.path,
      sourceSha256: receipt.source.sha256,
      sourceSizeBytes: receipt.source.sizeBytes,
      wavPath: receipt.wav.path,
      wavSha256: receipt.wav.sha256,
      wavSizeBytes: receipt.wav.sizeBytes,
      ...(receipt.providerRequestId === undefined
        ? {}
        : { providerRequestId: receipt.providerRequestId }),
      ...(receipt.billingUnits === undefined ? {} : { billingUnits: receipt.billingUnits }),
      commercialUse: "unverified",
      providerTermsUrl: PROVIDER_TERMS_URL,
      receiptPath,
      replayed,
      inspection,
    };
  }

  private async preflight(dir: string, request: AudioGenerateRequest): Promise<void> {
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    } catch {
      throw new AudioGenerateError(
        "AUDIO_GENERATE_STORAGE",
        "The audio output directory could not be created, so nothing was requested.",
      );
    }
    await new Promise<void>((done, fail) => {
      execFile(this.ffmpegPath, ["-hide_banner", "-version"], { timeout: 20_000 }, (error) =>
        error
          ? fail(
              new AudioGenerateError(
                "AUDIO_GENERATE_PREREQUISITE_MISSING",
                "FFmpeg is not available, so the response could not be decoded. Nothing was requested.",
              ),
            )
          : done(),
      );
    });
    this.inspector.resolveInspectorBin();
    // An explicitly requested semantic model that is not provisioned is refused before spending.
    if (request.inspection?.semantic === "clap" && !(await semanticAvailable())) {
      throw new AudioGenerateError(
        "AUDIO_GENERATE_PREREQUISITE_MISSING",
        "Semantic inspection was requested but local CLAP is not provisioned. Nothing was requested or charged.",
      );
    }
  }

  /** Exclusive reservation: two concurrent duplicates cannot both get past this. */
  private async reserve(dir: string, receiptPath: string, receipt: Receipt): Promise<void> {
    let handle;
    try {
      handle = await open(receiptPath, "wx", 0o600);
    } catch {
      throw new AudioGenerateError(
        "AUDIO_GENERATE_REQUEST_CONFLICT",
        "That requestId is already in flight. Wait for it, or use a new requestId.",
      );
    }
    try {
      await handle.writeFile(JSON.stringify(receipt, null, 2));
      await handle.sync();
    } finally {
      await handle.close();
    }
    void dir;
  }

  private async submit(
    normalized: NormalizedRequest,
    receiptPath: string,
  ): Promise<{ body: Uint8Array; providerRequestId?: string; billingUnits?: string }> {
    const url = new URL(ENDPOINT);
    url.searchParams.set("output_format", normalized.output_format);

    let response: Response;
    try {
      response = await this.fetch(url, {
        method: "POST",
        // An authenticated request must never be replayed against a redirect target.
        redirect: "error",
        signal: AbortSignal.timeout(GENERATE_LIMITS.timeoutMs),
        headers: {
          "xi-api-key": this.apiKey(),
          "content-type": "application/json",
          accept: "audio/mpeg",
          "user-agent": "threenative-asset-mcp",
        },
        body: JSON.stringify({
          text: normalized.text,
          duration_seconds: normalized.duration_seconds,
          loop: normalized.loop,
          prompt_influence: normalized.prompt_influence,
          model_id: normalized.model_id,
        }),
      });
    } catch (error) {
      // We asked and never learned the answer, so we must assume it may have been billed.
      await markUnknown(receiptPath);
      throw new AudioGenerateError(
        isTimeout(error) ? "AUDIO_GENERATE_TIMEOUT" : "AUDIO_GENERATE_UPSTREAM",
        "The generation request did not complete and its outcome is unknown; this requestId will not be retried.",
      );
    }

    if (!response.ok) {
      // A refusal is a definite non-charge answer, so the reservation can simply be cleared.
      await rm(receiptPath, { force: true });
      throw sanitizedUpstream(response.status);
    }

    const providerRequestId = response.headers.get("request-id") ?? undefined;
    const billingUnits = response.headers.get("character-cost") ?? undefined;

    let body: Uint8Array;
    try {
      body = await readCapped(response, GENERATE_LIMITS.maxResponseBytes);
    } catch (error) {
      if (error instanceof AudioGenerateError) {
        await rm(receiptPath, { force: true });
        throw error;
      }
      await markUnknown(receiptPath);
      throw new AudioGenerateError(
        "AUDIO_GENERATE_UPSTREAM",
        "The generated audio could not be read completely and its outcome is unknown.",
      );
    }
    if (body.byteLength === 0) {
      await markUnknown(receiptPath);
      throw new AudioGenerateError(
        "AUDIO_GENERATE_UPSTREAM",
        "The provider returned no audio; the outcome of this request is unknown.",
      );
    }
    return {
      body,
      ...(providerRequestId === undefined ? {} : { providerRequestId }),
      ...(billingUnits === undefined ? {} : { billingUnits }),
    };
  }

  /**
   * Decode to PCM16 WAV with no resampling, no downmix, no normalization and no trimming. Turning
   * MP3 into WAV does not restore what the encoder threw away, and pretending otherwise by
   * "cleaning up" here would hide the defect the inspection exists to find.
   */
  private async toWav(sourcePath: string, wavPath: string): Promise<void> {
    // Unique per call, so two processes finishing the same request never rename each other's file.
    const temporary = `${wavPath}.${randomUUID()}.partial`;
    await new Promise<void>((done, fail) => {
      execFile(
        this.ffmpegPath,
        ["-v", "error", "-y", "-i", sourcePath, "-c:a", "pcm_s16le", "-f", "wav", temporary],
        { timeout: GENERATE_LIMITS.timeoutMs, maxBuffer: 1024 * 1024 },
        (error) =>
          error
            ? fail(
                new AudioGenerateError(
                  "AUDIO_GENERATE_CONVERT_FAILED",
                  "The saved audio could not be decoded to WAV. The original response is kept.",
                  true,
                ),
              )
            : done(),
      );
    });
    await rename(temporary, wavPath);
  }
}

function normalize(request: AudioGenerateRequest): NormalizedRequest {
  const text = typeof request.prompt === "string" ? request.prompt.trim() : "";
  if (text.length === 0 || text.length > GENERATE_LIMITS.maxPromptChars) {
    throw new AudioGenerateError(
      "AUDIO_GENERATE_INVALID_INPUT",
      `The prompt must be between 1 and ${String(GENERATE_LIMITS.maxPromptChars)} characters.`,
    );
  }
  const duration = request.durationSeconds ?? 5;
  if (
    !Number.isFinite(duration) ||
    duration < GENERATE_LIMITS.minDurationSeconds ||
    duration > GENERATE_LIMITS.maxDurationSeconds
  ) {
    throw new AudioGenerateError(
      "AUDIO_GENERATE_INVALID_INPUT",
      `durationSeconds must be between ${String(GENERATE_LIMITS.minDurationSeconds)} and ${String(GENERATE_LIMITS.maxDurationSeconds)}.`,
    );
  }
  const influence = request.promptInfluence ?? 0.3;
  if (!Number.isFinite(influence) || influence < 0 || influence > 1) {
    throw new AudioGenerateError(
      "AUDIO_GENERATE_INVALID_INPUT",
      "promptInfluence must be between 0 and 1.",
    );
  }
  // Generation owns these three; a caller who also sets them in `inspection` is contradicting itself.
  const conflicting = request.inspection as Record<string, unknown> | undefined;
  for (const key of ["loop", "expectedDurationSeconds", "expectedPrompt", "path"]) {
    if (conflicting && key in conflicting) {
      throw new AudioGenerateError(
        "AUDIO_GENERATE_INVALID_INPUT",
        `inspection.${key} is supplied by generation itself and must not be set.`,
      );
    }
  }
  return {
    text,
    duration_seconds: duration,
    loop: request.loop ?? false,
    prompt_influence: influence,
    model_id: MODEL_ID,
    output_format: OUTPUT_FORMAT,
  };
}

/** Provider error bodies and headers never reach the caller; only a category does. */
function sanitizedUpstream(status: number): AudioGenerateError {
  if (status === 401 || status === 403) {
    return new AudioGenerateError(
      "AUDIO_GENERATE_AUTH_FAILED",
      "ElevenLabs rejected the API key. Ask the user to check their own ELEVENLABS_API_KEY; nothing was saved.",
    );
  }
  if (status === 429) {
    return new AudioGenerateError(
      "AUDIO_GENERATE_RATE_LIMITED",
      "ElevenLabs rate-limited or refused the request for quota reasons; nothing was saved.",
      true,
    );
  }
  if (status === 422 || status === 400) {
    return new AudioGenerateError(
      "AUDIO_GENERATE_REJECTED",
      "ElevenLabs rejected the request parameters; nothing was saved.",
    );
  }
  return new AudioGenerateError(
    "AUDIO_GENERATE_UPSTREAM",
    `ElevenLabs returned an error (HTTP ${String(status)}); nothing was saved.`,
    status >= 500,
  );
}

async function readCapped(response: Response, cap: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > cap) {
    throw new AudioGenerateError(
      "AUDIO_GENERATE_TOO_LARGE",
      "The provider's audio response exceeds the size cap; nothing was saved.",
    );
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(await response.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > cap) {
        // Stop pulling bytes we have already decided to refuse.
        await reader.cancel();
        throw new AudioGenerateError(
          "AUDIO_GENERATE_TOO_LARGE",
          "The provider's audio response exceeds the size cap; nothing was saved.",
        );
      }
      chunks.push(value);
    }
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

async function markUnknown(receiptPath: string): Promise<void> {
  const receipt = await readReceipt(receiptPath);
  if (!receipt) return;
  await writeReceipt(receiptPath, { ...receipt, state: "outcome_unknown" });
}

async function readReceipt(path: string): Promise<Receipt | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Receipt;
  } catch {
    return undefined;
  }
}

async function writeReceipt(path: string, receipt: Receipt): Promise<void> {
  const temporary = `${path}.${randomUUID()}.partial`;
  await writeFile(temporary, JSON.stringify(receipt, null, 2), { mode: 0o600 });
  await rename(temporary, path);
}

async function writeExclusive(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
