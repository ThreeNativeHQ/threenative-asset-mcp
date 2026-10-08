import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { AudioGenerateError, AudioGenerator } from "../src/audio/generate.js";
import { createAudioGenerateHandler } from "../src/tools/audio.js";

/**
 * Only the provider's HTTP boundary is stubbed. Disk, ffmpeg and the real pinned inspector all do
 * their actual work, because the failures worth catching here — a second charge, a half-written
 * file, a leaked key — only happen where those meet.
 */

const temporaryDirectories: string[] = [];
let mp3Bytes: Uint8Array;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "asset-mcp-generate-"));
  temporaryDirectories.push(directory);
  return directory;
}

beforeAll(async () => {
  // A real MP3, so the conversion and the inspection downstream are real work.
  const staging = await mkdtemp(join(tmpdir(), "asset-mcp-mp3-"));
  const path = join(staging, "sound.mp3");
  execFileSync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi",
    "-i", "sine=frequency=441:duration=2:sample_rate=44100",
    "-af", "volume=5.0",
    "-b:a", "128k",
    path,
  ]);
  mp3Bytes = new Uint8Array(await readFile(path));
  await rm(staging, { recursive: true, force: true });
});

interface Recorded {
  calls: { url: string; headers: Record<string, string>; body: unknown }[];
  fetch: typeof globalThis.fetch;
}

function recordingFetch(
  respond: (call: number) => Response | Promise<Response>,
): Recorded {
  const calls: Recorded["calls"] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    );
    calls.push({
      url: String(input),
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
    });
    return await respond(calls.length);
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

function audioResponse(bytes: Uint8Array, extra: Record<string, string> = {}): Response {
  return new Response(bytes.slice().buffer as ArrayBuffer, {
    status: 200,
    headers: { "content-type": "audio/mpeg", "content-length": String(bytes.byteLength), ...extra },
  });
}

const PROMPT = "One short metal latch closing, close microphone, dry recording, single event.";
const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";

async function generatorIn(
  audioDir: string,
  respond: (call: number) => Response | Promise<Response>,
  options: { apiKey?: string } = {},
) {
  const recorded = recordingFetch(respond);
  const generator = new AudioGenerator({
    audioDir,
    inspectRoots: [audioDir],
    fetch: recorded.fetch,
    ...(options.apiKey === undefined ? { apiKey: "test-key-not-a-real-one" } : {}),
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
  });
  return { generator, recorded };
}

describe("audio generation saves and inspects one candidate", () => {
  it("maps the request, saves both files, and returns a real inspection of the saved WAV", async () => {
    const audioDir = await temporaryDirectory();
    const { generator, recorded } = await generatorIn(audioDir, () =>
      audioResponse(mp3Bytes, { "request-id": "prov-123", "character-cost": "42" }),
    );

    const result = await generator.generate({
      requestId: ID_A,
      prompt: PROMPT,
      durationSeconds: 2,
      loop: true,
      promptInfluence: 0.4,
    });

    expect(recorded.calls).toHaveLength(1);
    const call = recorded.calls[0]!;
    expect(call.url).toContain("api.elevenlabs.io/v1/sound-generation");
    expect(call.url).toContain("output_format=mp3_44100_128");
    expect(call.body).toMatchObject({
      text: PROMPT,
      duration_seconds: 2,
      loop: true,
      prompt_influence: 0.4,
      model_id: "eleven_text_to_sound_v2",
    });

    expect(result.generation).toBe("saved");
    expect(result.providerRequestId).toBe("prov-123");
    expect(result.billingUnits).toBe("42");
    expect(result.commercialUse).toBe("unverified");
    expect(result.replayed).toBe(false);

    // The provider's own bytes are preserved exactly; only a separate WAV is derived from them.
    const savedSource = new Uint8Array(await readFile(result.sourcePath));
    expect(Buffer.from(savedSource).equals(Buffer.from(mp3Bytes))).toBe(true);
    expect(result.sourceSha256).toBe(createHash("sha256").update(mp3Bytes).digest("hex"));

    // Inspection ran for real, on the WAV, against the duration and loop generation itself supplied.
    expect(result.inspection.inputPath).toBe(result.wavPath);
    expect(result.inspection.measured?.durationSeconds).toBeGreaterThan(1.8);
    expect(result.inspection.measured?.durationSeconds).toBeLessThan(2.2);
    expect(result.inspection.effectiveExpectations).toMatchObject({ loop: true });
    expect(result.inspection.artisticQuality).toBe("unverified");
    expect(result.inspection.promptFit).toBe("unverified");
  });

  it("keeps a saved candidate inspectable even when it has defects, without calling it approved", async () => {
    const audioDir = await temporaryDirectory();
    const staging = await temporaryDirectory();
    const silentPath = join(staging, "silent.mp3");
    execFileSync("ffmpeg", [
      "-v", "error", "-y",
      "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono",
      "-t", "2", "-b:a", "128k", silentPath,
    ]);
    const silent = new Uint8Array(await readFile(silentPath));

    const { generator } = await generatorIn(audioDir, () => audioResponse(silent));
    const result = await generator.generate({
      requestId: ID_A,
      prompt: PROMPT,
      durationSeconds: 2,
    });

    expect(result.generation).toBe("saved");
    expect(result.inspection.technicalStatus).toBe("fail");
    expect(result.inspection.recommendation).toBe("reject");
    expect(result.inspection.findings.some((finding) => finding.severity === "error")).toBe(true);
  });
});

describe("one invocation is at most one charge", () => {
  it("replays a completed request from saved bytes without a second POST", async () => {
    const audioDir = await temporaryDirectory();
    const { generator, recorded } = await generatorIn(audioDir, () => audioResponse(mp3Bytes));

    const first = await generator.generate({ requestId: ID_A, prompt: PROMPT, durationSeconds: 2 });
    const second = await generator.generate({ requestId: ID_A, prompt: PROMPT, durationSeconds: 2 });

    expect(recorded.calls).toHaveLength(1);
    expect(second.replayed).toBe(true);
    expect(second.wavSha256).toBe(first.wavSha256);
    expect(second.sourceSha256).toBe(first.sourceSha256);
  });

  it("lets only one of two concurrent duplicates submit", async () => {
    const audioDir = await temporaryDirectory();
    const { generator, recorded } = await generatorIn(audioDir, async () => {
      await new Promise((done) => setTimeout(done, 50));
      return audioResponse(mp3Bytes);
    });

    const settled = await Promise.allSettled([
      generator.generate({ requestId: ID_A, prompt: PROMPT, durationSeconds: 2 }),
      generator.generate({ requestId: ID_A, prompt: PROMPT, durationSeconds: 2 }),
    ]);

    expect(recorded.calls).toHaveLength(1);
    expect(settled.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((outcome) => outcome.status === "rejected");
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(AudioGenerateError);
    expect((rejected as PromiseRejectedResult).reason.code).toBe("AUDIO_GENERATE_REQUEST_CONFLICT");
  });

  it("refuses a duplicate that arrives while the first call is still converting", async () => {
    const audioDir = await temporaryDirectory();
    // Hold the first call inside its WAV conversion: the window where a duplicate used to read the
    // half-finished receipt, run its own conversion, and lose the rename race with ENOENT.
    const slowFfmpeg = join(await temporaryDirectory(), "slow-ffmpeg");
    await writeFile(slowFfmpeg, "#!/bin/sh\nsleep 1\nexec ffmpeg \"$@\"\n");
    await chmod(slowFfmpeg, 0o755);
    const recorded = recordingFetch(() => audioResponse(mp3Bytes));
    const generator = new AudioGenerator({
      audioDir,
      inspectRoots: [audioDir],
      fetch: recorded.fetch,
      apiKey: "test-key-not-a-real-one",
      ffmpegPath: slowFfmpeg,
    });

    const first = generator.generate({ requestId: ID_A, prompt: PROMPT, durationSeconds: 2 });
    const source = join(audioDir, "generated", ID_A, "source.mp3");
    while (!(await stat(source).then(() => true, () => false))) {
      await new Promise((done) => setTimeout(done, 10));
    }
    const second = generator.generate({ requestId: ID_A, prompt: PROMPT, durationSeconds: 2 });

    await expect(second).rejects.toMatchObject({ code: "AUDIO_GENERATE_REQUEST_CONFLICT" });
    await expect(first).resolves.toMatchObject({ requestId: ID_A });
    expect(recorded.calls).toHaveLength(1);
  }, 20_000);

  it("refuses the same id with different options instead of charging for a different sound", async () => {
    const audioDir = await temporaryDirectory();
    const { generator, recorded } = await generatorIn(audioDir, () => audioResponse(mp3Bytes));

    await generator.generate({ requestId: ID_A, prompt: PROMPT, durationSeconds: 2 });
    await expect(
      generator.generate({ requestId: ID_A, prompt: "A completely different sound", durationSeconds: 2 }),
    ).rejects.toMatchObject({ code: "AUDIO_GENERATE_REQUEST_CONFLICT" });

    expect(recorded.calls).toHaveLength(1);
  });

  it("never resubmits an id whose outcome it never learned", async () => {
    const audioDir = await temporaryDirectory();
    const { generator, recorded } = await generatorIn(audioDir, () => {
      throw new Error("socket hung up");
    });

    await expect(
      generator.generate({ requestId: ID_A, prompt: PROMPT, durationSeconds: 2 }),
    ).rejects.toMatchObject({ code: "AUDIO_GENERATE_UPSTREAM" });
    expect(recorded.calls).toHaveLength(1);

    // It may already have been billed, so the id is spent forever — even across a restart.
    const restarted = new AudioGenerator({
      audioDir,
      inspectRoots: [audioDir],
      apiKey: "test-key-not-a-real-one",
      fetch: recordingFetch(() => audioResponse(mp3Bytes)).fetch,
    });
    await expect(
      restarted.generate({ requestId: ID_A, prompt: PROMPT, durationSeconds: 2 }),
    ).rejects.toMatchObject({ code: "AUDIO_GENERATE_OUTCOME_UNKNOWN" });
    expect(recorded.calls).toHaveLength(1);
  });

  it("resumes local conversion and inspection from saved source bytes with no further POST", async () => {
    const audioDir = await temporaryDirectory();
    const { generator, recorded } = await generatorIn(audioDir, () => audioResponse(mp3Bytes));

    const first = await generator.generate({ requestId: ID_A, prompt: PROMPT, durationSeconds: 2 });

    // Simulate a crash after the source was durable but before the WAV survived.
    await rm(first.wavPath, { force: true });
    const receiptPath = first.receiptPath;
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
    delete receipt.wav;
    receipt.state = "source_saved";
    await writeFile(receiptPath, JSON.stringify(receipt));

    const resumed = await generator.generate({
      requestId: ID_A,
      prompt: PROMPT,
      durationSeconds: 2,
    });

    expect(recorded.calls).toHaveLength(1);
    expect(resumed.wavSha256).toBe(first.wavSha256);
    expect((await stat(resumed.wavPath)).size).toBeGreaterThan(0);
  });

  it("fails a tampered saved file instead of silently re-fetching it", async () => {
    const audioDir = await temporaryDirectory();
    const { generator, recorded } = await generatorIn(audioDir, () => audioResponse(mp3Bytes));

    const first = await generator.generate({ requestId: ID_A, prompt: PROMPT, durationSeconds: 2 });
    await writeFile(first.sourcePath, "not the audio that was paid for");

    await expect(
      generator.generate({ requestId: ID_A, prompt: PROMPT, durationSeconds: 2 }),
    ).rejects.toMatchObject({ code: "AUDIO_GENERATE_HASH_MISMATCH" });
    expect(recorded.calls).toHaveLength(1);
  });
});

describe("credentials and provider errors", () => {
  it("fails with an actionable error and spends nothing when ELEVENLABS_API_KEY is absent", async () => {
    const audioDir = await temporaryDirectory();
    const recorded = recordingFetch(() => audioResponse(mp3Bytes));
    const saved = process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    try {
      const generator = new AudioGenerator({
        audioDir,
        inspectRoots: [audioDir],
        fetch: recorded.fetch,
      });
      const error = await generator
        .generate({ requestId: ID_A, prompt: PROMPT, durationSeconds: 2 })
        .then(() => undefined)
        .catch((problem: unknown) => problem as AudioGenerateError);

      expect(error?.code).toBe("AUDIO_GENERATE_NO_CREDENTIALS");
      // The message has to tell the agent what to ask the user for.
      expect(error?.message).toContain("ELEVENLABS_API_KEY");
      expect(error?.message.toLowerCase()).toContain("user");
      expect(recorded.calls).toHaveLength(0);
    } finally {
      if (saved !== undefined) process.env.ELEVENLABS_API_KEY = saved;
    }
  });

  it("returns that missing-key failure through MCP as a structured error, not a crash", async () => {
    const audioDir = await temporaryDirectory();
    const saved = process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    try {
      const handler = createAudioGenerateHandler(
        new AudioGenerator({ audioDir, inspectRoots: [audioDir] }),
      );
      const result = (await handler({
        requestId: ID_A,
        prompt: PROMPT,
        durationSeconds: 2,
      })) as { isError: true; content: { text: string }[] };

      expect(result.isError).toBe(true);
      const payload = JSON.parse(result.content[0]!.text) as { code: string; message: string };
      expect(payload.code).toBe("AUDIO_GENERATE_NO_CREDENTIALS");
      expect(payload.message).toContain("ELEVENLABS_API_KEY");
    } finally {
      if (saved !== undefined) process.env.ELEVENLABS_API_KEY = saved;
    }
  });

  it("never puts the key, provider headers or a raw provider body into the result", async () => {
    const audioDir = await temporaryDirectory();
    const secret = "sk-secret-value-that-must-not-leak";
    const { generator } = await generatorIn(
      audioDir,
      () =>
        new Response(JSON.stringify({ detail: `quota exhausted for ${secret}` }), {
          status: 401,
          headers: { "content-type": "application/json", "x-provider-internal": secret },
        }),
      { apiKey: secret },
    );

    const error = await generator
      .generate({ requestId: ID_A, prompt: PROMPT, durationSeconds: 2 })
      .then(() => undefined)
      .catch((problem: unknown) => problem as AudioGenerateError);

    expect(error?.code).toBe("AUDIO_GENERATE_AUTH_FAILED");
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(error?.message).not.toContain("quota exhausted");
  });

  it("sends the key only as the xi-api-key header and refuses to follow a redirect", async () => {
    const audioDir = await temporaryDirectory();
    const secret = "sk-another-secret";
    const { generator, recorded } = await generatorIn(audioDir, () => audioResponse(mp3Bytes), {
      apiKey: secret,
    });
    await generator.generate({ requestId: ID_A, prompt: PROMPT, durationSeconds: 2 });

    const call = recorded.calls[0]!;
    expect(call.headers["xi-api-key"]).toBe(secret);
    expect(call.url).not.toContain(secret);
    expect(JSON.stringify(call.body)).not.toContain(secret);
  });

  it("refuses a response larger than the cap and saves nothing", async () => {
    const audioDir = await temporaryDirectory();
    const huge = String(33 * 1024 * 1024);
    const { generator } = await generatorIn(audioDir, () =>
      new Response(mp3Bytes.slice().buffer as ArrayBuffer, {
        status: 200,
        headers: { "content-type": "audio/mpeg", "content-length": huge },
      }),
    );

    await expect(
      generator.generate({ requestId: ID_A, prompt: PROMPT, durationSeconds: 2 }),
    ).rejects.toMatchObject({ code: "AUDIO_GENERATE_TOO_LARGE" });
  });

  it("rejects out-of-range parameters before it reaches the provider", async () => {
    const audioDir = await temporaryDirectory();
    const { generator, recorded } = await generatorIn(audioDir, () => audioResponse(mp3Bytes));

    for (const bad of [
      { requestId: ID_A, prompt: "   ", durationSeconds: 2 },
      { requestId: ID_A, prompt: PROMPT, durationSeconds: 0.2 },
      { requestId: ID_B, prompt: PROMPT, durationSeconds: 45 },
      { requestId: ID_B, prompt: PROMPT, durationSeconds: 2, promptInfluence: 1.5 },
    ]) {
      await expect(generator.generate(bad)).rejects.toMatchObject({
        code: "AUDIO_GENERATE_INVALID_INPUT",
      });
    }
    expect(recorded.calls).toHaveLength(0);
  });

  it("refuses inspection expectations that generation already supplies", async () => {
    const audioDir = await temporaryDirectory();
    const { generator, recorded } = await generatorIn(audioDir, () => audioResponse(mp3Bytes));

    await expect(
      generator.generate({
        requestId: ID_A,
        prompt: PROMPT,
        durationSeconds: 2,
        inspection: { loop: true } as never,
      }),
    ).rejects.toMatchObject({ code: "AUDIO_GENERATE_INVALID_INPUT" });
    expect(recorded.calls).toHaveLength(0);
  });

  it("refuses a requested semantic model that is not provisioned, before spending", async () => {
    const audioDir = await temporaryDirectory();
    const { generator, recorded } = await generatorIn(audioDir, () => audioResponse(mp3Bytes));
    const saved = process.env.AUDIO_CLAP_PYTHON;
    delete process.env.AUDIO_CLAP_PYTHON;
    try {
      await expect(
        generator.generate({
          requestId: ID_A,
          prompt: PROMPT,
          durationSeconds: 2,
          inspection: {
            semantic: "clap",
            emotion: {
              sourceDescription: "a metal latch closing",
              targetMood: "calm and reassuring",
              alternativeMoods: ["tense and threatening"],
            },
          },
        }),
      ).rejects.toMatchObject({ code: "AUDIO_GENERATE_PREREQUISITE_MISSING" });
      expect(recorded.calls).toHaveLength(0);
    } finally {
      if (saved !== undefined) process.env.AUDIO_CLAP_PYTHON = saved;
    }
  });
});
