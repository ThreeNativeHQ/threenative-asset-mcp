import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CUE4PARSE_PROGRAM } from "../src/unreal/cue4parse-adapter.js";
import { modernSdkExecutable, toolchainCacheDir } from "../src/unreal/provision.js";
import { childEnvironment } from "../src/unreal/toolchain.js";
import { describeWithTools } from "./helpers/require-tool.js";

const CUE4PARSE_BIN = join(toolchainCacheDir(process.env), "modern", "bin");

function extractCSharp(program: string, signature: string): string {
  const start = program.indexOf(signature);
  if (start < 0) throw new Error(`converter program has no ${signature}`);
  let depth = 0;
  let opened = false;
  for (let index = start; index < program.length; index++) {
    const char = program[index]!;
    if (char === '"') {
      for (index++; index < program.length && program[index] !== '"'; index++) if (program[index] === "\\") index++;
      continue;
    }
    if (char === "{") {
      depth++;
      opened = true;
    } else if (char === "}") {
      depth--;
      if (opened && depth === 0) return program.slice(start, index + 1);
    }
  }
  throw new Error(`unbalanced braces after ${signature}`);
}

function extractRecord(program: string, signature: string): string {
  const start = program.indexOf(signature);
  if (start < 0) throw new Error(`converter program has no ${signature}`);
  const end = program.indexOf(");", start);
  if (end < 0) throw new Error(`unterminated record after ${signature}`);
  return program.slice(start, end + 2);
}

describeWithTools(["modern-converter"], "UE5 Sequencer channel evaluator", () => {
  let root = "";
  let runner = "";
  let sdk = "";

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "tn-sequencer-channels-"));
    await mkdir(join(root, "tmp"), { recursive: true });
    const project = join(root, "project");
    await mkdir(project, { recursive: true });
    await writeFile(
      join(project, "SequencerChannels.csproj"),
      `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework>` +
        `<ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable><UseSharedCompilation>false</UseSharedCompilation></PropertyGroup>` +
        `<ItemGroup>${["CUE4Parse", "CUE4Parse-Conversion", "Newtonsoft.Json"].map(name =>
          `<Reference Include="${name}"><HintPath>${join(CUE4PARSE_BIN, name + ".dll")}</HintPath></Reference>`,
        ).join("")}` +
        `<None Include="${join(CUE4PARSE_BIN, "*.dll")}" Exclude="${["System*.dll", "Microsoft*.dll", "mscorlib.dll", "netstandard.dll"].map(name => join(CUE4PARSE_BIN, name)).join(";")}" Link="%(Filename)%(Extension)" CopyToOutputDirectory="PreserveNewest" /></ItemGroup></Project>`,
    );
    const declarations = [
      extractCSharp(CUE4PARSE_PROGRAM, "static CAnimSet ConvertAbsoluteSequencerAnimation("),
      extractCSharp(CUE4PARSE_PROGRAM, "static bool EvaluateSequencerChannel("),
      extractCSharp(CUE4PARSE_PROGRAM, "static bool SampleSequencerChannel("),
      extractCSharp(CUE4PARSE_PROGRAM, "static bool SampleSequencerTransform("),
      extractCSharp(CUE4PARSE_PROGRAM, "static bool SequencerFrameRate("),
      extractCSharp(CUE4PARSE_PROGRAM, "static FStructFallback? StructProperty("),
      extractCSharp(CUE4PARSE_PROGRAM, "static bool StructNumber("),
      extractRecord(CUE4PARSE_PROGRAM, "sealed record SequencerKey("),
      extractRecord(CUE4PARSE_PROGRAM, "sealed record SequencerChannelData("),
    ].join("\n");
    await writeFile(
      join(project, "Program.cs"),
      `using System.Globalization;
using CUE4Parse.UE4.Objects.Engine.Curves;
using System.Runtime.CompilerServices;
using CUE4Parse.UE4.Assets;
using CUE4Parse.UE4.Assets.Exports;
using CUE4Parse.UE4.Assets.Exports.Animation;
using CUE4Parse.UE4.Objects.Core.Math;
using CUE4Parse.UE4.Objects.Core.Misc;
using CUE4Parse.UE4.Assets.Objects;
using CUE4Parse.UE4.Objects.UObject;
using CUE4Parse_Conversion.Animations;
using CUE4Parse_Conversion.Writers.ActorX.Structs.Animations;

if (args.Contains("--additive"))
{
    // FReferenceSkeleton only exposes an archive constructor. Populate native fields
    // in memory rather than manufacturing a serialized Unreal package.
    var reference = (FReferenceSkeleton)RuntimeHelpers.GetUninitializedObject(typeof(FReferenceSkeleton));
    SetReference(nameof(FReferenceSkeleton.FinalRefBoneInfo), new[] {
        new FMeshBoneInfo(new FName("root"), -1), new FMeshBoneInfo(new FName("child"), 0) });
    SetReference(nameof(FReferenceSkeleton.FinalRefBonePose), new[] {
        FTransform.Identity, new FTransform(new FVector(10, 0, 0)) });
    SetReference(nameof(FReferenceSkeleton.FinalNameToIndexMap), new Dictionary<string, int> { ["root"] = 0, ["child"] = 1 });
    void SetReference(string name, object value) => typeof(FReferenceSkeleton).GetField(name)!.SetValue(reference, value);

    var skeleton = new USkeleton {
        Name = "TwoBones", ReferenceSkeleton = reference,
        BoneTree = new EBoneTranslationRetargetingMode[2], AnimRetargetSources = new()
    };
    var package = new SkeletonPackage(skeleton);
    var sequence = new UAnimSequence {
        Name = "AbsoluteRawMarkedAdditive", NumFrames = 2, SequenceLength = 1, RateScale = 1,
        RetargetSource = new FName("None"),
        AdditiveAnimType = EAdditiveAnimationType.AAT_LocalSpaceBase,
        RefPoseType = EAdditiveBasePoseType.ABPT_RefPose, RefFrameIndex = 0,
        TrackToSkeletonMapTable = new[] {
            new FTrackToSkeletonMap { BoneTreeIndex = 0 }, new FTrackToSkeletonMap { BoneTreeIndex = 1 } },
        RawAnimationData = new[] {
            new FRawAnimSequenceTrack(new[] { FVector.ZeroVector }, new[] { FQuat.Identity }, new[] { FVector.OneVector }),
            new FRawAnimSequenceTrack(new[] { new FVector(10, 0, 0) }, new[] { FQuat.Identity }, new[] { FVector.OneVector }) }
    };
    // Skeleton has a private setter; use the real FPackageIndex loader path.
    typeof(UAnimationAsset).GetProperty(nameof(UAnimationAsset.Skeleton))!.SetValue(sequence, new FPackageIndex(package, 1));
    if (!ReferenceEquals(sequence.Skeleton!.Load<USkeleton>(), skeleton)) throw new Exception("Skeleton resolution failed");

    var before = sequence.ConvertAnims();
    CheckChild(before, 20);
    var saved = sequence.AdditiveAnimType;
    var after = ConvertAbsoluteSequencerAnimation(sequence);
    CheckChild(after, 10);
    if (sequence.AdditiveAnimType != saved) throw new Exception("Additive enum was not restored");
    if (sequence.RawAnimationData[1].PosKeys[0].X != 10) throw new Exception("Source raw data was mutated");
    var reconverted = sequence.ConvertAnims();
    CheckChild(reconverted, 20);
    var missingSkeleton = new UAnimSequence { AdditiveAnimType = saved };
    var threw = false;
    try { ConvertAbsoluteSequencerAnimation(missingSkeleton); }
    catch (Exception) { threw = true; }
    if (!threw) throw new Exception("Missing skeleton must fail conversion");
    if (missingSkeleton.AdditiveAnimType != saved) throw new Exception("Additive enum was not restored after failure");
    Console.WriteLine(string.Join(",", new[] {
        before.Sequences[0].Tracks[1].KeyPos[0].X.ToString(CultureInfo.InvariantCulture),
        after.Sequences[0].Tracks[1].KeyPos[0].X.ToString(CultureInfo.InvariantCulture),
        (sequence.AdditiveAnimType == saved).ToString(),
        reconverted.Sequences[0].Tracks[1].KeyPos[0].X.ToString(CultureInfo.InvariantCulture),
        sequence.RawAnimationData[1].PosKeys[0].X.ToString(CultureInfo.InvariantCulture),
        threw.ToString(), (missingSkeleton.AdditiveAnimType == saved).ToString()
    }));
    return;

    static void CheckChild(CAnimSet result, float expected) {
        if (result.Sequences.Count != 1 || result.Sequences[0].Tracks.Count != 2) throw new Exception("Unexpected output shape");
        var keys = result.Sequences[0].Tracks[1].KeyPos;
        if (keys.Length == 0 || keys.Any(p => MathF.Abs(p.X - expected) > 0.0001f || p.Y != 0 || p.Z != 0))
            throw new Exception($"Expected every child translation to be ({expected},0,0); got {string.Join(",", keys.Select(p => p.X))}");
    }

}

SequencerKey Key(float value, ERichCurveInterpMode interp, ERichCurveTangentMode tangent = ERichCurveTangentMode.RCTM_Auto, float arrive = 0, float leave = 0, float arriveWeight = 0, float leaveWeight = 0, ERichCurveTangentWeightMode weightMode = ERichCurveTangentWeightMode.RCTWM_WeightedNone) =>
    new(value, arrive, leave, arriveWeight, leaveWeight, interp, tangent, weightMode);
SequencerChannelData Channel(int[] times, SequencerKey[] values, ERichCurveExtrapolation pre = ERichCurveExtrapolation.RCCE_Constant, ERichCurveExtrapolation post = ERichCurveExtrapolation.RCCE_Constant, int tickNumerator = 30, int tickDenominator = 1, bool hasDefault = false, float defaultValue = 0) =>
    new(times, values, pre, post, tickNumerator, tickDenominator, hasDefault, defaultValue);
float Sample(SequencerChannelData channel, double time)
{
    if (!EvaluateSequencerChannel(channel, time, out var value, out var reason)) throw new Exception(reason.Length == 0 ? "channel was not evaluable" : reason);
    return value;
}
FTransform SampleTransform(SequencerChannelData[] translation, SequencerChannelData[] rotation, SequencerChannelData[] scale, int frame, int numberOfKeys, int displayNumerator = 30, int displayDenominator = 1, int sceneNumerator = 30, int sceneDenominator = 1)
{
    if (!SampleSequencerTransform(translation, rotation, scale, frame, numberOfKeys, displayNumerator, displayDenominator, sceneNumerator, sceneDenominator, out var value, out var reason)) throw new Exception(reason);
    return value;
}
var empty = Channel(Array.Empty<int>(), Array.Empty<SequencerKey>());
SequencerChannelData[] Vector(SequencerChannelData x) => new[] { x, empty, empty };
var emptyVector = Vector(empty);
float SampleFrame(SequencerChannelData channel, int frame, int numberOfKeys, int displayNumerator, int displayDenominator, int sceneNumerator = 30, int sceneDenominator = 1) =>
    SampleTransform(Vector(channel), emptyVector, emptyVector, frame, numberOfKeys, displayNumerator, displayDenominator, sceneNumerator, sceneDenominator).Translation.X;

var constant = Channel(new[] { 0, 10 }, new[] { Key(3, ERichCurveInterpMode.RCIM_Constant), Key(7, ERichCurveInterpMode.RCIM_Linear) });
var linear = Channel(new[] { 0, 10 }, new[] { Key(0, ERichCurveInterpMode.RCIM_Linear), Key(10, ERichCurveInterpMode.RCIM_Linear) });
var cubicAuto = Channel(new[] { 0, 10 }, new[] { Key(0, ERichCurveInterpMode.RCIM_Cubic, arrive: 0, leave: 3), Key(10, ERichCurveInterpMode.RCIM_Cubic, tangent: ERichCurveTangentMode.RCTM_Auto, arrive: -1) });
var cubicUser = Channel(new[] { 0, 10 }, new[] { Key(0, ERichCurveInterpMode.RCIM_Cubic, tangent: ERichCurveTangentMode.RCTM_User, leave: 3), Key(10, ERichCurveInterpMode.RCIM_Cubic, tangent: ERichCurveTangentMode.RCTM_User, arrive: -1) });
var cubicBreak = Channel(new[] { 0, 10 }, new[] { Key(0, ERichCurveInterpMode.RCIM_Cubic, tangent: ERichCurveTangentMode.RCTM_Break, leave: 3), Key(10, ERichCurveInterpMode.RCIM_Cubic, tangent: ERichCurveTangentMode.RCTM_Break, arrive: -1) });
var weighted = Channel(new[] { 0, 10 }, new[] { Key(0, ERichCurveInterpMode.RCIM_Cubic, leave: 2, leaveWeight: 0.5f, weightMode: ERichCurveTangentWeightMode.RCTWM_WeightedLeave), Key(10, ERichCurveInterpMode.RCIM_Cubic, arrive: -1, arriveWeight: 0.25f, weightMode: ERichCurveTangentWeightMode.RCTWM_WeightedArrive) });
var extrapolated = Channel(new[] { 0, 10 }, new[] { Key(0, ERichCurveInterpMode.RCIM_Linear), Key(10, ERichCurveInterpMode.RCIM_Linear) }, ERichCurveExtrapolation.RCCE_Linear, ERichCurveExtrapolation.RCCE_Linear);
var defaults = Channel(Array.Empty<int>(), Array.Empty<SequencerKey>(), hasDefault: true, defaultValue: 4);
var defaultAndKeys = Channel(new[] { 0, 1, 2 }, new[] { Key(10, ERichCurveInterpMode.RCIM_Linear), Key(20, ERichCurveInterpMode.RCIM_Linear), Key(30, ERichCurveInterpMode.RCIM_Linear) }, hasDefault: true, defaultValue: 99);
var unequalRates = Channel(new[] { 0, 4 }, new[] { Key(0, ERichCurveInterpMode.RCIM_Linear), Key(10, ERichCurveInterpMode.RCIM_Linear) }, tickNumerator: 48);
if (args.Contains("--scene-rate"))
{
    var stale = Channel(Enumerable.Range(0, 85).ToArray(), Enumerable.Range(0, 85).Select(i => Key(i, ERichCurveInterpMode.RCIM_Linear)).ToArray(), tickNumerator: 24000);
    Console.WriteLine(SampleFrame(stale, 1, 85, 30, 1, 30, 1));
    return;
}
if (args.Contains("--transform"))
{
    void Check(float actual, float expected, string label) {
        if (!float.IsFinite(actual) || MathF.Abs(actual - expected) > 0.00001f) throw new Exception($"{label}: expected {expected}, got {actual}");
    }
    var turn = Channel(new[] { 0, 1 }, new[] { Key(0, ERichCurveInterpMode.RCIM_Linear), Key(90, ERichCurveInterpMode.RCIM_Linear) }, tickNumerator: 24000);
    var transform = SampleTransform(emptyVector, new[] { turn, turn, empty }, emptyVector, 1, 3, 60, 1);
    // CUE Normalize uses approximate InvSqrt; compare orientation independently of its length.
    var q = transform.Rotation;
    q = q * (1f / MathF.Sqrt(q | q));
    Check(q.X, -1f / MathF.Sqrt(12), "fractional roll/pitch quaternion X");
    Check(q.Y, -1f / MathF.Sqrt(12), "fractional roll/pitch quaternion Y");
    Check(q.Z, -1f / MathF.Sqrt(12), "fractional roll/pitch quaternion Z");
    Check(q.W, MathF.Sqrt(3) / 2, "fractional roll/pitch quaternion W");
    var eulerLerp = new FRotator(45, 0, 45).Quaternion();
    if (MathF.Abs(transform.Rotation.Z - eulerLerp.Z) < 0.1f) throw new Exception("Euler interpolation was not distinguished");
    var crossing = Channel(new[] { 0, 1 }, new[] { Key(170, ERichCurveInterpMode.RCIM_Linear), Key(-170, ERichCurveInterpMode.RCIM_Linear) });
    var shortest = SampleTransform(emptyVector, new[] { empty, empty, crossing }, emptyVector, 1, 3, 60, 1);
    var shortestQ = shortest.Rotation;
    shortestQ = shortestQ * (1f / MathF.Sqrt(shortestQ | shortestQ));
    Check(MathF.Abs(shortestQ.Z), 1, "shortest hemisphere");
    Check(shortestQ.W, 0, "shortest hemisphere W");
    var stepped = Channel(new[] { 0, 1 }, new[] { Key(0, ERichCurveInterpMode.RCIM_Constant), Key(10, ERichCurveInterpMode.RCIM_Linear) });
    var whole = SampleTransform(Vector(stepped), emptyVector, Vector(stepped), 1, 3, 60, 1);
    Check(whole.Translation.X, 5, "floor/ceil translation blend");
    Check(whole.Scale3D.X, 5, "floor/ceil scale blend");
    Check(whole.Scale3D.Y, 1, "empty scale stays identity");
    Check(SampleFrame(defaultAndKeys, 1, 3, 30, 1), 20, "integer keyed default");
    Check(SampleFrame(defaultAndKeys, 1, 5, 30, 1), 20, "integer nonuniform keyed default");
    Check(SampleFrame(defaultAndKeys, 1, 3, 60, 1), 99, "fractional keyed default");
    Check(SampleFrame(unequalRates, 1, 3, 24, 1, 48), 5, "unequal scene/display rates");
    Check(SampleFrame(unequalRates, 1, 3, 24, 1, 96, 2), 5, "rational scene rate");
    if (SampleSequencerTransform(emptyVector, emptyVector, emptyVector, 1, 3, 30, 1, 0, 1, out _, out var invalidRate) || !invalidRate.Contains("scene tick 0/1")) throw new Exception("Invalid scene rate was accepted");
    if (SequencerFrameRate(new UObject(), "TickResolution", out _, out _, out var missingRate) || missingRate != "the clip's MovieScene carries no TickResolution") throw new Exception("Missing scene rate must be reported exactly");
    Console.WriteLine("whole-transform sampling passed");
    return;
}
var samples = new[] { Sample(constant, 5), Sample(constant, 10), Sample(linear, 2.5), Sample(cubicAuto, 5), Sample(cubicUser, 5), Sample(cubicBreak, 5), Sample(weighted, 5), Sample(extrapolated, -5), Sample(extrapolated, 15), Sample(defaults, 4), SampleFrame(defaultAndKeys, 1, 3, 30, 1), SampleFrame(defaultAndKeys, 1, 3, 24, 1), SampleFrame(unequalRates, 1, 3, 24, 1, 48) };
Console.WriteLine(string.Join(",", samples.Select(value => value.ToString("R", CultureInfo.InvariantCulture))));
var invalid = Channel(new[] { 0, 10 }, new[] { Key(0, (ERichCurveInterpMode)99), Key(1, ERichCurveInterpMode.RCIM_Linear) });
EvaluateSequencerChannel(invalid, 5, out _, out var invalidReason);
Console.WriteLine(invalidReason);

${declarations}

sealed class SkeletonPackage : AbstractUePackage {
    public SkeletonPackage(USkeleton skeleton) : base("/Synthetic/TwoBones", null) {
        ExportsLazy = new[] { new Lazy<UObject>(() => skeleton) };
        IsFullyLoaded = true;
    }
    public override FPackageFileSummary Summary => default!;
    public override FNameEntrySerialized[] NameMap => [];
    public override int ImportMapLength => 0;
    public override int ExportMapLength => 1;
    public override int GetExportIndex(string name, StringComparison comparisonType = StringComparison.Ordinal)
        => string.Equals(name, ExportsLazy[0].Value.Name, comparisonType) ? 0 : -1;
    public override ResolvedObject? ResolvePackageIndex(FPackageIndex? index)
        => index?.Index == 1 ? new SkeletonExport(this) : null;
}
sealed class SkeletonExport(IPackage package) : ResolvedObject(package, 0) {
    public override FName Name => new("TwoBones");
}
`,
    );
    const projectFile = join(project, "SequencerChannels.csproj");
    sdk = await modernSdkExecutable(process.env);
    try {
      execFileSync(sdk, ["build", projectFile, "-c", "Release", "--nologo", "-nodeReuse:false"], {
        cwd: project,
        env: {
          ...childEnvironment(process.env),
          DOTNET_CLI_HOME: join(root, "home"),
          DOTNET_NOLOGO: "1",
          DOTNET_CLI_TELEMETRY_OPTOUT: "1",
          DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
          MSBUILDDISABLENODEREUSE: "1",
          NUGET_PACKAGES: join(root, "nuget"),
          TMPDIR: join(root, "tmp"),
        },
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch (error) {
      const failure = error as { stdout?: string | Buffer; stderr?: string | Buffer };
      throw new Error(`${failure.stdout ?? ""}${failure.stderr ?? ""}`);
    }
    runner = join(project, "bin", "Release", "net10.0", "SequencerChannels.dll");
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("matches Unreal's constant, linear, cubic, weighted and extrapolated channel formulas", () => {
    const lines = execFileSync(sdk, [runner], { encoding: "utf8" });
    const [valuesLine, invalidReason] = lines.trim().split(/\r?\n/);
    const values = valuesLine!.split(",").map(Number);
    expect(values[0]).toBe(3);
    expect(values[1]).toBe(7);
    expect(values[2]).toBeCloseTo(2.5, 5);
    expect(values[3]).toBeCloseTo(10, 5);
    expect(values[4]).toBeCloseTo(values[3]!, 5);
    expect(values[5]).toBeCloseTo(values[3]!, 5);
    expect(values[6]).toBeCloseTo(5.281128, 5);
    expect(values[7]).toBeCloseTo(-5, 5);
    expect(values[8]).toBeCloseTo(15, 5);
    expect(values[9]).toBe(4);
    expect(values[10]).toBe(20);
    expect(values[11]).toBe(99);
    expect(values[12]).toBeCloseTo(5, 5);
    expect(invalidReason).toMatch(/unsupported interpolation mode 99/);
  });

  it("samples uniform FK keys with the scene rate despite a stale channel rate", () => {
    expect(Number(execFileSync(sdk, [runner, "--scene-rate"], { encoding: "utf8" }).trim())).toBe(1);
  });

  it("blends fractional whole transforms and preserves integer/default sampling", () => {
    expect(execFileSync(sdk, [runner, "--transform"], { encoding: "utf8" }).trim()).toBe("whole-transform sampling passed");
  });

  it("guards the absolute Sequencer export from legacy additive accumulation", () => {
    const values = execFileSync(sdk, [runner, "--additive"], { encoding: "utf8" }).trim().split(",");
    expect(Number(values[0]), "native additive baseline child X").toBe(20);
    expect(Number(values[1]), "shipped absolute helper child X").toBe(10);
    expect(values[2], "additive enum restored after success").toBe("True");
    expect(Number(values[3]), "legacy reconversion still accumulates base pose").toBe(20);
    expect(Number(values[4]), "raw source child X unchanged").toBe(10);
    expect(values[5], "missing skeleton throws").toBe("True");
    expect(values[6], "additive enum restored after failure").toBe("True");
  });
});
