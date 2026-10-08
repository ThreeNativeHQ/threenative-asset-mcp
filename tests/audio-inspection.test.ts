import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { AudioInspectError, AudioInspector } from "../src/audio/inspect.js";
import { createAudioInspectHandler } from "../src/tools/audio.js";
import { describeWithTools } from "./helpers/require-tool.js";

/**
 * These run the real pinned `threenative-playtest audio` binary against real ffmpeg output. Mocking
 * either would leave the one thing worth testing — that this adapter reads a real report correctly
 * and never turns "could not check" into "passed" — completely unverified.
 *
 * Every fixture recipe below was measured before it was asserted on. Two are worth knowing:
 * ffmpeg's `sine` source peaks near 0.125, so a clip needs roughly `volume=5` to clear the
 * inspector's 0.1 quiet warning; and a whole-cycle sine wraps seamlessly even with a fade, so a
 * genuinely bad seam needs a clip that *ends* at full amplitude — a quarter cycle of a 1 Hz tone.
 */

const temporaryDirectories: string[] = [];
let root: string;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "asset-mcp-inspect-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function ffmpeg(args: string[]): void {
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
}

/** Fixtures live for the whole file: building them per test costs more than the tests do. */
function inspectorIn(directory = root): AudioInspector {
  return new AudioInspector({ audioDir: directory, inspectRoots: [directory] });
}

/**
 * An inspector whose cache is private to one test but which may still read the shared fixtures.
 * Results are cached by input bytes plus expectations plus inspector version, so two tests asking
 * the same question of the same file would otherwise see each other's answers.
 */
async function isolatedInspector(options: { inspectorBin?: string } = {}) {
  const cacheDir = await temporaryDirectory();
  return new AudioInspector({
    audioDir: cacheDir,
    inspectRoots: [root, cacheDir],
    ...(options.inspectorBin === undefined ? {} : { inspectorBin: options.inspectorBin }),
  });
}

describeWithTools(["ffmpeg"], "audio inspection", () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "asset-mcp-fixtures-"));

    // Correctly levelled 2s tone at exactly 882 whole cycles: peak 0.63, seam ratio 1.0, no findings.
    ffmpeg(["-f", "lavfi", "-i", "sine=frequency=441:duration=2:sample_rate=44100",
      "-af", "volume=5.0", "-c:a", "pcm_s16le", join(root, "clean.wav")]);
    // A quarter cycle of 1 Hz: starts at zero, ends at full amplitude, so the wrap is a cliff.
    ffmpeg(["-f", "lavfi", "-i", "sine=frequency=1:duration=0.25:sample_rate=44100",
      "-af", "volume=5.0", "-c:a", "pcm_s16le", join(root, "bad-seam.wav")]);
    ffmpeg(["-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "1",
      "-c:a", "pcm_s16le", join(root, "silent.wav")]);
    ffmpeg(["-f", "lavfi", "-i", "sine=frequency=441:duration=2:sample_rate=44100",
      "-af", "volume=20.0", "-c:a", "pcm_s16le", join(root, "hot.wav")]);
    // Deliberately below the default silence floor's neighbourhood but still real audio.
    ffmpeg(["-f", "lavfi", "-i", "sine=frequency=441:duration=2:sample_rate=44100",
      "-af", "volume=0.02", "-c:a", "pcm_s16le", join(root, "quiet.wav")]);
    ffmpeg(["-f", "lavfi", "-i", "sine=frequency=441:duration=2:sample_rate=44100",
      "-af", "volume=5.0", "-c:a", "flac", join(root, "clean.flac")]);

    await writeFile(join(root, "corrupt.wav"), createHash("sha512").update("noise").digest());
    await writeFile(join(root, "playlist.m3u"), "#EXTM3U\nclean.wav\n");
  });

  // `root` is shared by every test, so it must outlive the per-test cleanup above.
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  describe("inspection catches audio that is actually broken", () => {
    it("fails a file that does not decode at all", async () => {
      const result = await inspectorIn().inspect({ path: join(root, "corrupt.wav"), loop: false });

      expect(result.technicalStatus).toBe("fail");
      expect(result.recommendation).toBe("reject");
      expect(result.findings.some((finding) => finding.severity === "error")).toBe(true);
      expect(result.measured).toBeUndefined();
    });

    it("fails silence against the declared floor", async () => {
      const result = await inspectorIn().inspect({ path: join(root, "silent.wav"), loop: false });

      expect(result.technicalStatus).toBe("fail");
      expect(result.recommendation).toBe("reject");
      expect(result.measured?.rms).toBe(0);
      expect(result.findings.some((f) => f.severity === "error" && /silen/i.test(f.name))).toBe(true);
    });

    it("fails audio driven past the peak ceiling", async () => {
      const result = await inspectorIn().inspect({ path: join(root, "hot.wav"), loop: false });

      expect(result.technicalStatus).toBe("fail");
      expect(result.measured?.peak).toBeGreaterThanOrEqual(0.98);
      expect(result.findings.some((finding) => finding.severity === "error")).toBe(true);
    });

    it("fails a declared loop whose wrap is a click", async () => {
      const result = await inspectorIn().inspect({ path: join(root, "bad-seam.wav"), loop: true });

      expect(result.technicalStatus).toBe("fail");
      expect(result.measured?.seam?.ratio).toBeGreaterThan(1.5);
      expect(result.findings.some((f) => f.severity === "error" && /seam/i.test(f.name))).toBe(true);
    });

    it("does not check the seam of a clip that was not declared a loop", async () => {
      const result = await inspectorIn().inspect({ path: join(root, "bad-seam.wav"), loop: false });

      expect(result.findings.some((finding) => /seam/i.test(finding.name))).toBe(false);
      expect(result.effectiveExpectations).not.toHaveProperty("seamMaxRatio");
    });

    it("reports a duration mismatch instead of trimming the file", async () => {
      const before = await readFile(join(root, "clean.wav"));
      const result = await inspectorIn().inspect({
        path: join(root, "clean.wav"),
        loop: false,
        expectedDurationSeconds: 10,
      });

      expect(result.technicalStatus).toBe("fail");
      expect(result.findings.some((f) => f.severity === "error" && /duration/i.test(f.name))).toBe(
        true,
      );
      expect(result.measured?.durationSeconds).toBeLessThan(3);
      expect(Buffer.from(await readFile(join(root, "clean.wav"))).equals(before)).toBe(true);
    });

    it("fails a band bound the clip cannot meet", async () => {
      const result = await inspectorIn().inspect({
        path: join(root, "clean.wav"),
        loop: false,
        bands: { air: { min: 90 } },
      });

      expect(result.technicalStatus).toBe("fail");
      expect(result.findings.some((f) => f.severity === "error" && /air/i.test(f.name))).toBe(true);
    });
  });

  describe("inspection does not fail good audio", () => {
    it("passes a correctly levelled, seamless loop with no findings at all", async () => {
      const result = await inspectorIn().inspect({ path: join(root, "clean.wav"), loop: true });

      expect(result.findings).toEqual([]);
      expect(result.technicalStatus).toBe("pass");
      expect(result.recommendation).toBe("audition");
      expect(result.measured?.peak).toBeGreaterThan(0.1);
      expect(result.measured?.peak).toBeLessThan(0.98);
      expect(result.measured?.seam?.ratio).toBeLessThanOrEqual(1.5);
      expect(result.spectrogramPath).toMatch(/\.png$/);
      expect((await stat(result.spectrogramPath!)).size).toBeGreaterThan(0);
    });

    it("passes deliberately quiet audio that declares its own lower floor", async () => {
      const strict = await inspectorIn().inspect({ path: join(root, "quiet.wav"), loop: false });
      expect(strict.findings.length).toBeGreaterThan(0);

      const declared = await inspectorIn().inspect({
        path: join(root, "quiet.wav"),
        loop: false,
        silenceRms: 1e-6,
        peakMax: 0.98,
      });

      expect(declared.findings.some((finding) => /silen/i.test(finding.name))).toBe(false);
      // The floor it was actually held to is echoed back, not silently defaulted.
      expect(declared.effectiveExpectations).toMatchObject({ silenceRms: 1e-6 });
    });

    it("accepts a duration inside the max(0.10s, 2%) tolerance", async () => {
      const result = await inspectorIn().inspect({
        path: join(root, "clean.wav"),
        loop: false,
        expectedDurationSeconds: 2.04,
      });

      expect(result.findings.some((finding) => /duration/i.test(finding.name))).toBe(false);
    });

    it("reads FLAC as well as WAV", async () => {
      const result = await inspectorIn().inspect({ path: join(root, "clean.flac"), loop: false });

      expect(result.technicalStatus).toBe("pass");
      expect(result.measured?.sampleRate).toBe(44_100);
    });

    it("never claims artistic quality, and leaves prompt fit unverified when unrequested", async () => {
      for (const name of ["clean.wav", "silent.wav", "hot.wav", "bad-seam.wav"]) {
        const result = await inspectorIn().inspect({ path: join(root, name), loop: true });
        expect(result.artisticQuality).toBe("unverified");
        expect(result.promptFit).toBe("unverified");
        expect(result.semantic.requested).toBe(false);
        expect(result.emotionFit.status).toBe("not_requested");
        expect(result.notes.join(" ")).toMatch(/nobody listened/i);
      }
    });

    it("will not call a technically clean clip auditionable while a requested check is incomplete", async () => {
      const saved = process.env.AUDIO_CLAP_PYTHON;
      delete process.env.AUDIO_CLAP_PYTHON;
      try {
        const result = await inspectorIn().inspect({
          path: join(root, "clean.wav"),
          loop: true,
          semantic: "clap",
          expectedPrompt: "a short metal latch closing",
          alternativePrompts: ["a dog barking", "heavy rain on a tin roof"],
        });

        expect(result.technicalStatus).toBe("pass");
        // Requested, unavailable, and therefore not a pass: review, never audition.
        expect(result.promptFit).toBe("unverified");
        expect(result.semantic.requested).toBe(true);
        expect(result.recommendation).toBe("review");
        expect(result.notes.join(" ")).toMatch(/AUDIO_CLAP_PYTHON|not provisioned/i);
      } finally {
        if (saved !== undefined) process.env.AUDIO_CLAP_PYTHON = saved;
      }
    });
  });

  describe("only containable, real audio files are read", () => {
    it("refuses a path outside every allowed root", async () => {
      const elsewhere = await temporaryDirectory();
      ffmpeg(["-f", "lavfi", "-i", "sine=frequency=441:duration=1:sample_rate=44100",
        "-af", "volume=5.0", "-c:a", "pcm_s16le", join(elsewhere, "outside.wav")]);

      await expect(
        inspectorIn().inspect({ path: join(elsewhere, "outside.wav"), loop: false }),
      ).rejects.toMatchObject({ code: "AUDIO_INSPECT_OUTSIDE_ROOT" });
    });

    it("refuses a symlink inside a root that escapes to a file outside it", async () => {
      const elsewhere = await temporaryDirectory();
      const target = join(elsewhere, "secret.wav");
      ffmpeg(["-f", "lavfi", "-i", "sine=frequency=441:duration=1:sample_rate=44100",
        "-af", "volume=5.0", "-c:a", "pcm_s16le", target]);
      const link = join(root, `escape-${String(Date.now())}.wav`);
      await symlink(target, link);

      await expect(inspectorIn().inspect({ path: link, loop: false })).rejects.toMatchObject({
        code: "AUDIO_INSPECT_OUTSIDE_ROOT",
      });
      await rm(link, { force: true });
    });

    it("reports a missing file as missing", async () => {
      await expect(
        inspectorIn().inspect({ path: join(root, "no-such-file.wav"), loop: false }),
      ).rejects.toMatchObject({ code: "AUDIO_INSPECT_NOT_FOUND" });
    });

    it("refuses a playlist rather than following it", async () => {
      await expect(
        inspectorIn().inspect({ path: join(root, "playlist.m3u"), loop: false }),
      ).rejects.toMatchObject({ code: "AUDIO_INSPECT_UNSUPPORTED" });
    });

    it("returns the hash of the exact bytes measured, and leaves them untouched", async () => {
      const path = join(root, "clean.wav");
      const before = await readFile(path);
      const beforeStat = await stat(path);

      const result = await inspectorIn().inspect({ path, loop: true });

      expect(result.inputSha256).toBe(createHash("sha256").update(before).digest("hex"));
      expect(result.inputSizeBytes).toBe(before.byteLength);
      const after = await stat(path);
      expect(after.size).toBe(beforeStat.size);
      expect(after.mtimeMs).toBe(beforeStat.mtimeMs);
      expect(Buffer.from(await readFile(path)).equals(before)).toBe(true);
    });

    it("surfaces a refusal through MCP as a structured error, not a thrown stack", async () => {
      const elsewhere = await temporaryDirectory();
      const handler = createAudioInspectHandler(inspectorIn());
      const result = (await handler({ path: join(elsewhere, "nope.wav"), loop: false })) as {
        isError: true;
        content: { text: string }[];
      };

      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0]!.text).code).toMatch(/^AUDIO_INSPECT_/);
    });

    it("rejects an unknown expectation key instead of ignoring it", async () => {
      const handler = createAudioInspectHandler(inspectorIn());
      const result = (await handler({
        path: join(root, "clean.wav"),
        loop: false,
        loudnessTarget: -14,
      })) as { isError: true; content: { text: string }[] };

      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0]!.text).code).toBe("AUDIO_INVALID_INPUT");
    });
  });

  describe("cached results describe the inputs they were computed from", () => {
    it("reuses an identical inspection", async () => {
      const inspector = await isolatedInspector();
      const first = await inspector.inspect({ path: join(root, "clean.wav"), loop: true });
      const second = await inspector.inspect({ path: join(root, "clean.wav"), loop: true });

      expect(first.cached).toBe(false);
      expect(second.cached).toBe(true);
      expect(second.cacheKey).toBe(first.cacheKey);
      expect(second.inputSha256).toBe(first.inputSha256);
    });

    it("never reuses a result across changed expectations", async () => {
      const inspector = await isolatedInspector();
      const base = await inspector.inspect({ path: join(root, "clean.wav"), loop: true });
      const changed = await inspector.inspect({
        path: join(root, "clean.wav"),
        loop: true,
        expectedDurationSeconds: 2,
      });

      expect(changed.cacheKey).not.toBe(base.cacheKey);
      expect(changed.cached).toBe(false);
    });

    it("never reuses a result across changed bytes", async () => {
      const directory = await temporaryDirectory();
      const path = join(directory, "moving.wav");
      ffmpeg(["-f", "lavfi", "-i", "sine=frequency=441:duration=2:sample_rate=44100",
        "-af", "volume=5.0", "-c:a", "pcm_s16le", path]);
      const inspector = inspectorIn(directory);
      const first = await inspector.inspect({ path, loop: true });

      ffmpeg(["-f", "lavfi", "-i", "sine=frequency=880:duration=1:sample_rate=44100",
        "-af", "volume=5.0", "-c:a", "pcm_s16le", path]);
      const second = await inspector.inspect({ path, loop: true });

      expect(second.inputSha256).not.toBe(first.inputSha256);
      expect(second.cacheKey).not.toBe(first.cacheKey);
      expect(second.cached).toBe(false);
      expect(second.measured?.durationSeconds).toBeLessThan(1.5);
    });

    it("changes the cache key when only the requested mood changes", async () => {
      const inspector = await isolatedInspector();
      const common = {
        path: join(root, "clean.wav"),
        loop: true,
        semantic: "clap" as const,
        emotion: {
          sourceDescription: "a metal latch closing",
          alternativeMoods: ["tense and threatening"],
        },
      };
      const calm = await inspector.inspect({
        ...common,
        emotion: { ...common.emotion, targetMood: "calm and reassuring" },
      });
      const tense = await inspector.inspect({
        ...common,
        emotion: { ...common.emotion, targetMood: "urgent and alarming" },
      });

      expect(tense.cacheKey).not.toBe(calm.cacheKey);
      expect(tense.cached).toBe(false);
    });
  });

  describe("an unavailable decoder is never a pass", () => {
    it("reports unverified, not pass, when the inspector cannot decode anything", async () => {
      const stub = await temporaryDirectory();
      const fake = join(stub, "fake-cli.js");
      // Exit 69 is the inspector's own "ffmpeg is missing" code.
      await writeFile(
        fake,
        [
          "process.stderr.write(JSON.stringify({",
          '  diagnostics: [{ code: "TN_AUDIO_NO_DECODER", severity: "error", message: "no ffmpeg" }],',
          "  inspected: false, pass: false }));",
          "process.exit(69);",
        ].join("\n"),
      );

      const inspector = await isolatedInspector({ inspectorBin: fake });
      const result = await inspector.inspect({ path: join(root, "clean.wav"), loop: true });

      expect(result.technicalStatus).toBe("unverified");
      expect(result.technicalStatus).not.toBe("pass");
      expect(result.recommendation).toBe("review");
      expect(result.measured).toBeUndefined();
      expect(result.notes.join(" ")).toMatch(/not a pass/i);
    });

    it("treats a crashed inspector as an incomplete inspection, not a verdict", async () => {
      const stub = await temporaryDirectory();
      const fake = join(stub, "broken-cli.js");
      await writeFile(fake, 'process.stdout.write("this is not json"); process.exit(1);');

      const inspector = await isolatedInspector({ inspectorBin: fake });

      await expect(
        inspector.inspect({ path: join(root, "clean.wav"), loop: true }),
      ).rejects.toBeInstanceOf(AudioInspectError);
    });

    it("treats an empty check list as nothing verified", async () => {
      const stub = await temporaryDirectory();
      const fake = join(stub, "empty-cli.js");
      await writeFile(
        fake,
        'process.stdout.write(JSON.stringify({checks:[],clips:[],pass:true})); process.exit(0);',
      );

      const inspector = await isolatedInspector({ inspectorBin: fake });

      await expect(
        inspector.inspect({ path: join(root, "clean.wav"), loop: true }),
      ).rejects.toMatchObject({ code: "AUDIO_INSPECT_FAILED" });
    });
  });
});
