import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, expect, it } from "vitest";

import { CUE4PARSE_PROGRAM } from "../src/unreal/cue4parse-adapter.js";
import { modernSdkExecutable, toolchainCacheDir } from "../src/unreal/provision.js";
import { childEnvironment } from "../src/unreal/toolchain.js";
import { describeWithTools } from "./helpers/require-tool.js";

// The adapter reads a blend space's axes from the typed `UBlendSpaceBase.BlendParameters` fixed array and
// restores only the fields the serializer omitted. This compiles the shipped `BlendAxis` and
// `NotifyClassNames` helpers, extracted from the embedded program, against the real CUE4Parse types and
// runs them on constructed typed objects, so an unequal axis, an omitted default and a notify's class
// are pinned by the code that ships rather than by a JSON shape.
const CUE4PARSE_BIN = join(toolchainCacheDir(process.env), "modern", "bin");

/** Extracts one top-level C# declaration (signature line through its terminator) from the program. */
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
    if (char === "/" && program[index + 1] === "/") {
      while (index < program.length && program[index] !== "\n") index++;
      continue;
    }
    if (char === "'") {
      for (index++; index < program.length && program[index] !== "'"; index++) if (program[index] === "\\") index++;
      continue;
    }
    if (char === "{") {
      depth++;
      opened = true;
    } else if (char === "}") {
      depth--;
      if (opened && depth === 0) {
        const rest = /^\s*;/.exec(program.slice(index + 1));
        return program.slice(start, index + 1 + (rest ? rest[0].length : 0));
      }
    } else if (char === ";" && !opened && depth === 0) {
      return program.slice(start, index + 1);
    }
  }
  throw new Error(`unbalanced braces after ${signature}`);
}

describeWithTools(["modern-converter"], "converter blend-space axis code (compiled from the embedded program)", () => {
  let root = "";
  let harness = "";
  let sdk = "";
  const environment = (): NodeJS.ProcessEnv => ({
    ...childEnvironment(process.env),
    DOTNET_CLI_HOME: join(root, "home"),
    DOTNET_NOLOGO: "1",
    DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
    MSBUILDDISABLENODEREUSE: "1",
    NUGET_PACKAGES: join(root, "nuget"),
    TMPDIR: join(root, "tmp"),
  });

  it("keeps its axis, typed-array and notify helpers in the embedded program", () => {
    expect(CUE4PARSE_PROGRAM).toContain("static Dictionary<string, object?> BlendAxis(FBlendParameter? typed, FStructFallback? raw)");
    expect(CUE4PARSE_PROGRAM).toContain('["gridNum"] = omitted("GridNum") ? 4 : (typed?.GridNum ?? 0),');
    expect(CUE4PARSE_PROGRAM).toContain("static FStructFallback[] ArrayElements(AbstractPropertyHolder holder, string name)");
    expect(CUE4PARSE_PROGRAM).toContain("static (string ClassName, string Kind) NotifyClassNames(");
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  beforeAll(async () => {
    sdk = await modernSdkExecutable(process.env);
    root = await mkdtemp(join(tmpdir(), "tn-animation-blend-axis-"));
    await mkdir(join(root, "tmp"), { recursive: true });
    const project = join(root, "project");
    await mkdir(project, { recursive: true });
    await writeFile(
      join(project, "BlendAxis.csproj"),
      `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework>` +
        `<ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable><UseSharedCompilation>false</UseSharedCompilation></PropertyGroup>` +
        `<ItemGroup><Reference Include="CUE4Parse"><HintPath>${join(CUE4PARSE_BIN, "CUE4Parse.dll")}</HintPath></Reference></ItemGroup>` +
        `</Project>`,
    );
    const functions = [
      "static Dictionary<string, object?> BlendAxis(FBlendParameter? typed, FStructFallback? raw)",
      "static double DumpNum(float value)",
      "static FRawCurveTracks? SelectAuthoredCurveTracks(FRawCurveTracks? modelLegacy, FRawCurveTracks? sequenceLegacy, FRawCurveTracks? raw, FRawCurveTracks? compressed)",
      "static bool StructBool(FStructFallback? data, string field, out bool value)",
      "static FStructFallback[] ArrayElements(AbstractPropertyHolder holder, string name)",
      "static (string ClassName, string Kind) NotifyClassNames(string? objectClass, string? objectName, string? stateClass)",
    ].map((signature) => extractCSharp(CUE4PARSE_PROGRAM, signature));
    await writeFile(
      join(project, "Program.cs"),
      `using CUE4Parse.UE4.Assets.Exports;
using CUE4Parse.UE4.Assets.Exports.Animation;
using CUE4Parse.UE4.Objects.Engine.Curves;
using CUE4Parse.UE4.Assets.Objects;
using CUE4Parse.UE4.Assets.Objects.Properties;
using CUE4Parse.UE4.Objects.Engine.Animation;
using CUE4Parse.UE4.Objects.UObject;

if (args[0] == "curve-source")
{
    FRawCurveTracks Tracks(int count) => new(new[] { new FFloatCurve { FloatCurve = new FRichCurve { Keys = Enumerable.Range(0, count).Select(i => new FRichCurveKey(i / 60f, 1f)).ToArray() } } });
    var raw = Tracks(2);
    Console.WriteLine(SelectAuthoredCurveTracks(Tracks(602), null, raw, null)?.FloatCurves?[0].FloatCurve.Keys.Length);
    Console.WriteLine(SelectAuthoredCurveTracks(null, null, raw, null)?.FloatCurves?[0].FloatCurve.Keys.Length);
}
if (args[0] == "axis")
{
    // Three axes with unequal values, a middle one whose Max and GridNum the serializer omitted, and an
    // unversioned axis with no raw tag at all whose typed values must survive untouched by any default.
    var a0 = BlendAxis(Typed(Axis("Speed", -90f, 90f, 2, true, true)), Axis("Speed", -90f, 90f, 2, true, true));
    var a1 = BlendAxis(Typed(Axis("Yaw", null, null, null, null, null)), Axis("Yaw", null, null, null, null, null));
    var a2 = BlendAxis(Typed(Axis("Lean", -45f, 45f, 8, true, false)), null);
    Console.WriteLine(string.Join("|", Fmt(a0), Fmt(a1), Fmt(a2)));
}
if (args[0] == "typed-wins")
{
    // The raw tag disagrees with the typed array; the typed fixed array is the source of the values.
    Console.WriteLine(Fmt(BlendAxis(Typed(Axis("Speed", 5f, 5f, 5, false, false)), Axis("Speed", -90f, -90f, 9, true, true))));
}
if (args[0] == "samples")
{
    // A dynamic SampleData TArray: one ArrayProperty at ArrayIndex 0 holding two elements, the second
    // mirrored. The per-ArrayIndex read can never reach element 1; the array-element read does.
    var holder = SampleHolder(false, true);
    var elements = ArrayElements(holder, "SampleData");
    var staleSecond = StaticFixedArrayElement(holder, "SampleData", 1);
    Console.WriteLine($"{elements.Length},{Mirror(elements[0])},{Mirror(elements[1])},{staleSecond is null}");
}
if (args[0] == "notify")
{
    var specs = new (string? objectClass, string? objectName, string? stateClass)[]
    {
        ("AnimNotify_Footstep", "AnimNotify_Footstep_2", null),
        ("BlueprintGeneratedClass", "AnimNotify_FootstepBP_C", null),
        (null, null, "AnimNotifyState_Trail"),
        (null, "AnimNotify_CameraShake", null),
    };
    foreach (var spec in specs)
    {
        var (name, kind) = NotifyClassNames(spec.objectClass, spec.objectName, spec.stateClass);
        Console.WriteLine($"{name}:{kind}");
    }
}

static string Fmt(Dictionary<string, object?> axis) =>
    $"{axis["displayName"]},{axis["min"]},{axis["max"]},{axis["gridNum"]},{axis["snapToGrid"]},{axis["wrapInput"]}";

static FPropertyTag Tag(string name, string type, FPropertyTagType value) =>
    new(new FName(name), new FName(type), 0, 0, null, false, null, value);

static FStructFallback Axis(string displayName, float? min, float? max, int? gridNum, bool? snap, bool? wrap)
{
    var properties = new List<FPropertyTag> { Tag("DisplayName", "StrProperty", new StrProperty(displayName)) };
    if (min is not null) properties.Add(Tag("Min", "FloatProperty", new FloatProperty(min.Value)));
    if (max is not null) properties.Add(Tag("Max", "FloatProperty", new FloatProperty(max.Value)));
    if (gridNum is not null) properties.Add(Tag("GridNum", "IntProperty", new IntProperty(gridNum.Value)));
    if (snap is not null) properties.Add(Tag("bSnapToGrid", "BoolProperty", new BoolProperty(snap.Value)));
    if (wrap is not null) properties.Add(Tag("bWrapInput", "BoolProperty", new BoolProperty(wrap.Value)));
    return new FStructFallback(properties);
}

static FBlendParameter Typed(FStructFallback raw) => new(raw);

static FStructFallback Sample(bool mirror) => new(
    mirror ? new List<FPropertyTag> { Tag("bMirror", "BoolProperty", new BoolProperty(true)) } : new List<FPropertyTag>());

static FStructFallback SampleHolder(bool first, bool second)
{
    var elements = new List<FPropertyTagType>
    {
        new StructProperty(new FScriptStruct(Sample(first))),
        new StructProperty(new FScriptStruct(Sample(second))),
    };
    return new FStructFallback(new List<FPropertyTag>
    {
        Tag("SampleData", "ArrayProperty", new ArrayProperty(new UScriptArray(elements, "StructProperty"))),
    });
}

static bool Mirror(FStructFallback data) => StructBool(data, "bMirror", out var mirror) && mirror;

// The pre-fix read: an element matches by the property's ArrayIndex, which for a dynamic TArray is
// always 0, so element 1 is never reached.
static FStructFallback? StaticFixedArrayElement(AbstractPropertyHolder holder, string name, int index)
{
    foreach (var property in holder.Properties)
        if (property.Name.Text == name && property.ArrayIndex == index)
            return property.Tag?.GetValue(typeof(FStructFallback)) as FStructFallback;
    return null;
}

${functions.join("\n")}
`,
    );
    try {
      execFileSync(sdk, ["build", project, "-c", "Release", "-o", join(root, "bin"), "-nodeReuse:false"], {
        env: environment(),
        stdio: "pipe",
        timeout: 300_000,
      });
    } catch (error) {
      const output = String((error as { stdout?: Buffer }).stdout ?? "");
      throw new Error(`the extracted animation helpers did not compile:\n${output.split("\n").filter((line) => line.includes("error")).slice(0, 12).join("\n")}`);
    }
    harness = join(root, "bin", "BlendAxis.dll");
  }, 360_000);

  const run = (...args: string[]): string =>
    execFileSync(sdk, [harness, ...args], { env: environment(), encoding: "utf8", timeout: 60_000 }).trim();

  it("preserves authored model curve keys ahead of reduced runtime curves and retains the UE4 raw fallback", () => {
    expect(run("curve-source").split("\n")).toEqual(["602", "2"]);
  });

  it("keeps each typed axis separate, restores an omitted Max and GridNum, and keeps a typed-only axis intact", () => {
    expect(run("axis")).toBe("Speed,-90,90,2,True,True|Yaw,0,100,4,False,False|Lean,-45,45,8,True,False");
  });

  it("takes the actual field values from the typed array, not the raw tag", () => {
    expect(run("typed-wins")).toBe("Speed,5,5,5,False,False");
  });

  it("reads a dynamic SampleData array by element so the second element's bMirror survives", () => {
    expect(run("samples")).toBe("2,False,True,True");
  });

  it("derives a notify's class and kind from the resolved class, marking Blueprint behaviour", () => {
    expect(run("notify").split("\n")).toEqual([
      "AnimNotify_Footstep:notify",
      "AnimNotify_FootstepBP:blueprint",
      "AnimNotifyState_Trail:state",
      "AnimNotify_CameraShake:notify",
    ]);
  });
});
