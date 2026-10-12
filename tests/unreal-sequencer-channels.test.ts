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
        `<ItemGroup><Reference Include="CUE4Parse"><HintPath>${join(CUE4PARSE_BIN, "CUE4Parse.dll")}</HintPath></Reference></ItemGroup></Project>`,
    );
    const declarations = [
      extractCSharp(CUE4PARSE_PROGRAM, "static bool EvaluateSequencerChannel("),
      extractCSharp(CUE4PARSE_PROGRAM, "static bool SampleSequencerChannel("),
      extractRecord(CUE4PARSE_PROGRAM, "sealed record SequencerKey("),
      extractRecord(CUE4PARSE_PROGRAM, "sealed record SequencerChannelData("),
    ].join("\n");
    await writeFile(
      join(project, "Program.cs"),
      `using System.Globalization;
using CUE4Parse.UE4.Objects.Engine.Curves;

SequencerKey Key(float value, ERichCurveInterpMode interp, ERichCurveTangentMode tangent = ERichCurveTangentMode.RCTM_Auto, float arrive = 0, float leave = 0, float arriveWeight = 0, float leaveWeight = 0, ERichCurveTangentWeightMode weightMode = ERichCurveTangentWeightMode.RCTWM_WeightedNone) =>
    new(value, arrive, leave, arriveWeight, leaveWeight, interp, tangent, weightMode);
SequencerChannelData Channel(int[] times, SequencerKey[] values, ERichCurveExtrapolation pre = ERichCurveExtrapolation.RCCE_Constant, ERichCurveExtrapolation post = ERichCurveExtrapolation.RCCE_Constant, int tickNumerator = 30, int tickDenominator = 1, bool hasDefault = false, float defaultValue = 0) =>
    new(times, values, pre, post, tickNumerator, tickDenominator, hasDefault, defaultValue);
float Sample(SequencerChannelData channel, double time)
{
    if (!EvaluateSequencerChannel(channel, time, out var value, out var reason)) throw new Exception(reason.Length == 0 ? "channel was not evaluable" : reason);
    return value;
}
float SampleFrame(SequencerChannelData channel, int frame, int numberOfKeys, int displayNumerator, int displayDenominator)
{
    if (!SampleSequencerChannel(channel, frame, numberOfKeys, displayNumerator, displayDenominator, out var value, out var reason)) throw new Exception(reason.Length == 0 ? "channel was not evaluable" : reason);
    return value;
}

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
var samples = new[] { Sample(constant, 5), Sample(constant, 10), Sample(linear, 2.5), Sample(cubicAuto, 5), Sample(cubicUser, 5), Sample(cubicBreak, 5), Sample(weighted, 5), Sample(extrapolated, -5), Sample(extrapolated, 15), Sample(defaults, 4), SampleFrame(defaultAndKeys, 1, 3, 30, 1), SampleFrame(defaultAndKeys, 1, 3, 24, 1), SampleFrame(unequalRates, 1, 3, 24, 1) };
Console.WriteLine(string.Join(",", samples.Select(value => value.ToString("R", CultureInfo.InvariantCulture))));
var invalid = Channel(new[] { 0, 10 }, new[] { Key(0, (ERichCurveInterpMode)99), Key(1, ERichCurveInterpMode.RCIM_Linear) });
EvaluateSequencerChannel(invalid, 5, out _, out var invalidReason);
Console.WriteLine(invalidReason);

${declarations}
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

  it("guards the absolute Sequencer export from legacy additive accumulation", () => {
    expect(CUE4PARSE_PROGRAM).toMatch(/sequencerModel is not null[\s\S]{0,5000}AAT_None/);
  });
});
