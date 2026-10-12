import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";

import { CUE4PARSE_ENGINE_CONTENT, CUE4PARSE_PROGRAM } from "../src/unreal/cue4parse-adapter.js";
import { parsePsa } from "../src/unreal/psa.js";
import { modernSdkExecutable, toolchainCacheDir } from "../src/unreal/provision.js";
import { childEnvironment, runBounded } from "../src/unreal/toolchain.js";
import { describeWithTools } from "./helpers/require-tool.js";

// The converter's own animation code, compiled against the installed CUE4Parse assembly. This runs the shipped C#
// through the compiler and, when a licensed proof pack is named, through the reader on real typed fields.
const MODERN_BIN = join(toolchainCacheDir(process.env), "modern", "bin");
const INSTALLED_SDK = modernSdkExecutable;
const PROOF_PACK = process.env.THREENATIVE_ANIMATION_PROOF_PACK;
const PROOF_FILTER = process.env.THREENATIVE_ANIMATION_PROOF_FILTER;
const PROOF_ENGINE = process.env.THREENATIVE_ANIMATION_PROOF_ENGINE ?? "5.8";
// The one fixture whose exact shape is asserted, named by its canonical package (optionally `.Object`)
// rather than by a frame count. Unset means no clip carries those assertions; a frame count alone can
// match an unrelated clip and is never used to select the known proof.
const KNOWN_CLIP = process.env.THREENATIVE_ANIMATION_KNOWN_CLIP;

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Artifacts are written under a package-derived directory; collect them recursively and relative. */
async function collectRelativeFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) found.push(relative(root, full).split(sep).join("/"));
    }
  };
  await walk(root);
  return found.sort();
}

/** The expected nested artifact path for a document, mirroring `AnimationTarget`'s package directories. */
function artifactRelative(packagePath: unknown, name: unknown, extension: string): string {
  const canonical = typeof packagePath === "string" ? packagePath : "";
  const relativePackage = canonical.startsWith("/Game/") ? canonical.slice("/Game/".length) : canonical.replace(/^\/+/, "");
  const directory = relativePackage.split("/").filter((segment) => segment.length > 0).join("/");
  return `${directory.length > 0 ? `${directory}/` : ""}${String(name)}${extension}`;
}

function matchesKnown(document: Record<string, unknown>, wanted: string): boolean {
  const packagePath = typeof document.package === "string" ? document.package : "";
  const name = typeof document.name === "string" ? document.name : "";
  return wanted === packagePath || wanted === name || wanted === `${packagePath}.${name}`;
}

function assemblyReference(assembly: string): string {
  return `<Reference Include="${escapeXml(assembly)}"><HintPath>${escapeXml(join(MODERN_BIN, `${assembly}.dll`))}</HintPath></Reference>`;
}

function buildEnvironment(root: string): NodeJS.ProcessEnv {
  return {
    ...childEnvironment(process.env),
    THREENATIVE_TOOLCHAIN_AUTOINSTALL: "0",
    DOTNET_CLI_HOME: join(root, "home"),
    DOTNET_NOLOGO: "1",
    DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
    MSBUILDDISABLENODEREUSE: "1",
    NUGET_PACKAGES: join(root, "nuget"),
    TMPDIR: join(root, "tmp"),
  };
}

describeWithTools(["modern-converter"], "converter animation code, compiled against the installed CUE4Parse", () => {
  let directory = "";
  let build: Awaited<ReturnType<typeof runBounded>> | undefined;

  beforeAll(async () => {
    const sdk = await INSTALLED_SDK(process.env);
    directory = await mkdtemp(join(tmpdir(), "tn-animation-compiled-"));
    await mkdir(join(directory, "tmp"), { recursive: true });
    await writeFile(join(directory, "Program.cs"), CUE4PARSE_PROGRAM);
    await writeFile(join(directory, "EngineContent.cs"), CUE4PARSE_ENGINE_CONTENT);
    const libraries = readdirSync(MODERN_BIN).filter((file) => file.endsWith(".dll") && !/^(?:System\.|Microsoft\.|ThreeNativeConverter\.)/.test(file));
    await writeFile(
      join(directory, "ThreeNativeConverter.csproj"),
      `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <UseSharedCompilation>false</UseSharedCompilation>
  </PropertyGroup>
  <ItemGroup>
    ${libraries.map((file) => assemblyReference(file.slice(0, -".dll".length))).join("")}
  </ItemGroup>
</Project>
`,
    );
    build = await runBounded(sdk, ["build", join(directory, "ThreeNativeConverter.csproj"), "-c", "Release", "-o", join(directory, "out"), "--nologo", "-nodeReuse:false"], {
      timeoutMs: 900_000,
      maxOutputBytes: 64 * 1024 * 1024,
      environment: buildEnvironment(directory),
    });
  }, 900_000);

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("compiles with no error against the installed assembly", () => {
    expect(build?.code, `${build?.stdout.slice(-4000) ?? ""}${build?.stderr.slice(-4000) ?? ""}`).toBe(0);
  });

  it.skipIf(!PROOF_PACK || !PROOF_FILTER)("reads typed blend-space defaults and a clip's unsupported model from a real pack", async () => {
    onTestFinished(() => rm(join(directory, "run"), { recursive: true, force: true }));
    const source = PROOF_PACK!;
    const run = join(directory, "run");
    await mkdir(run, { recursive: true });
    const sdk = await INSTALLED_SDK(process.env);
    const executed = await runBounded(sdk, [join(directory, "out", "ThreeNativeConverter.dll"), source, "--export-dir", run, "--animations", "--engine", PROOF_ENGINE, "--filter", PROOF_FILTER!], {
      timeoutMs: 300_000,
      maxOutputBytes: 32 * 1024 * 1024,
      environment: buildEnvironment(directory),
    });
    expect(executed.code, executed.stderr.slice(-2000)).toBe(0);
    const animation = join(run, "Animation");
    const files = await collectRelativeFiles(animation).catch(() => [] as string[]);
    expect(files.length).toBeGreaterThan(0);
    const documents = await Promise.all(files.filter((file) => file.endsWith(".json")).map(async (file) => JSON.parse(await readFile(join(animation, file), "utf8")) as Record<string, unknown>));
    for (const document of documents) {
      expect(document.format).toBe("threenative-unreal-animation");
      if (document.kind === "blendSpace") {
        const axes = document.axes as { gridNum: number; min: number; max: number }[];
        // A field the serializer omitted is restored to FBlendParameter's default, never read as 0.
        for (const axis of axes) expect(axis.gridNum).toBeGreaterThan(0);
      }
      if (document.kind === "clip" && document.timing !== undefined) {
        // A conventional UAnimDataModel clip: keys are frames + 1 (endpoints included) and the model's
        // rational duration is NumberOfFrames / fps, so the sampled duration must land on it within a frame.
        const timing = document.timing as { frames: number; keys: number; rateNumerator: number; rateDenominator: number; duration: number };
        expect(timing.keys).toBe(timing.frames + 1);
        expect(timing.rateNumerator).toBeGreaterThan(0);
        expect(timing.rateDenominator).toBeGreaterThan(0);
        const period = timing.rateDenominator / timing.rateNumerator;
        expect(Math.abs(timing.duration - timing.frames * period)).toBeLessThanOrEqual(period + 1e-6);
      }
      if (document.kind === "clip" && document.unsupportedReason !== undefined) {
        expect(String(document.unsupportedReason)).toMatch(/bone tracks|ControlRig|compressed/i);
      }
    }
    // Each timed clip sidecar and its PSA must agree, so the reader's timing is tied to the bytes written:
    // the sidecar's key count is the PSA frame count, the PSA rate is the model's rational rate, and the
    // PSA's endpoint (its last key) lands on the model's duration within a frame. A timed sidecar with no
    // PSA is a defect, not a skip: the timing assertions cannot silently go unproven.
    for (const document of documents) {
      if (document.kind !== "clip" || document.timing === undefined) continue;
      const timing = document.timing as { frames: number; keys: number; rateNumerator: number; rateDenominator: number; duration: number };
      const expected = artifactRelative(document.package, document.name, ".psa");
      const psaPath = files.find((file) => file === expected) ?? files.find((file) => basename(file) === `${String(document.name)}.psa`);
      expect(psaPath, `the timed clip ${String(document.name)} has no corresponding PSA at ${expected}`).toBeDefined();
      const psa = parsePsa(await readFile(join(animation, psaPath!)));
      const sequence = psa.sequences[0]!;
      expect(sequence.frames).toBe(timing.keys);
      expect(sequence.rate).toBeCloseTo(timing.rateNumerator / timing.rateDenominator, 6);
      expect((sequence.frames - 1) / sequence.rate).toBeCloseTo(timing.duration, 4);
    }
    // A UE4-era proof pack (raw editor tracks) must produce real ActorX clips. Static poses are
    // legitimate, so this scopes the moving proof to one known fixture: at least one exported clip
    // must carry a bone track whose quaternion varies over time (the raw FRawAnimSequenceTrack read
    // and the track-map bone mapping), rather than demanding motion from every clip in the pack.
    const psaFiles = files.filter((file) => file.toLowerCase().endsWith(".psa"));
    expect(psaFiles.length).toBeGreaterThan(0);
    const moving: string[] = [];
    for (const file of psaFiles) {
      const psa = parsePsa(await readFile(join(animation, file)));
      expect(psa.sequences.length).toBeGreaterThan(0);
      for (const sequence of psa.sequences) {
        expect(sequence.frames).toBeGreaterThan(0);
        const moves = sequence.tracks.some((track) => {
          if (track.rotations.length < 8) return false;
          let maxDelta = 0;
          for (let i = 4; i < track.rotations.length; i += 4) {
            const delta = Math.abs(track.rotations[i]! - track.rotations[i - 4]!) + Math.abs(track.rotations[i + 1]! - track.rotations[i - 3]!) + Math.abs(track.rotations[i + 2]! - track.rotations[i - 2]!) + Math.abs(track.rotations[i + 3]! - track.rotations[i - 1]!);
            maxDelta = Math.max(maxDelta, delta);
          }
          return maxDelta > 1e-4;
        });
        if (moves) moving.push(`${file}:${sequence.name}`);
      }
    }
    expect(moving.length, "no exported clip carried a bone track with a varying rotation").toBeGreaterThan(0);
    // The known conventional-model proof is selected by an explicit fixture identifier (a canonical
    // package, optionally `.Object`, from THREENATIVE_ANIMATION_KNOWN_CLIP), never by a frame count that
    // could match an unrelated clip. When it is set, the fixture's own timing, its PSA's 83 keys at 30
    // fps, its 354 bones, its 2.733333 s endpoint and its 52 rotating tracks are all asserted here.
    if (KNOWN_CLIP) {
      const known = documents.find((document) => document.kind === "clip" && document.timing !== undefined && matchesKnown(document, KNOWN_CLIP!));
      expect(known, `the known fixture ${KNOWN_CLIP} produced no timed clip`).toBeDefined();
      const timing = known!.timing as { frames: number; keys: number; rateNumerator: number; rateDenominator: number; duration: number };
      expect(timing.keys).toBe(83);
      expect(timing.rateNumerator).toBe(30);
      expect(timing.rateDenominator).toBe(1);
      expect(timing.duration).toBeCloseTo(2.733333, 5);
      const expected = artifactRelative(known!.package, known!.name, ".psa");
      const psaPath = files.find((file) => file === expected) ?? files.find((file) => basename(file) === `${String(known!.name)}.psa`);
      expect(psaPath, `the known fixture ${KNOWN_CLIP} has no PSA at ${expected}`).toBeDefined();
      const psa = parsePsa(await readFile(join(animation, psaPath!)));
      expect(psa.sequences.length).toBe(1);
      const sequence = psa.sequences[0]!;
      expect(sequence.rate).toBe(30);
      expect(sequence.frames).toBe(83);
      expect(sequence.tracks.length).toBe(354);
      const rotating = sequence.tracks.filter((track) => {
        if (track.rotations.length < 8) return false;
        let maxDelta = 0;
        for (let i = 4; i < track.rotations.length; i += 4) {
          const delta = Math.abs(track.rotations[i]! - track.rotations[i - 4]!) + Math.abs(track.rotations[i + 1]! - track.rotations[i - 3]!) + Math.abs(track.rotations[i + 2]! - track.rotations[i - 2]!) + Math.abs(track.rotations[i + 3]! - track.rotations[i - 1]!);
          maxDelta = Math.max(maxDelta, delta);
        }
        return maxDelta > 1e-4;
      }).length;
      expect(rotating).toBe(52);
    }
  });
});
