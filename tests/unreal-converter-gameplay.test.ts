import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, expect, it } from "vitest";

import { CUE4PARSE_PROGRAM } from "../src/unreal/cue4parse-adapter.js";
import { modernSdkExecutable, toolchainCacheDir } from "../src/unreal/provision.js";
import { describeWithTools } from "./helpers/require-tool.js";

// PRD-582. The adapter's gameplay-data helpers are extracted from the embedded program and compiled
// against the real CUE4Parse types from the provisioned modern converter, not stubs. `GpShape` runs
// against a real FKBoxElem built from a tagged FStructFallback, and `GpCueNode` runs against a real
// USoundNodeWavePlayer whose native `SoundWave` field is set to a different object than its soft
// `SoundWaveAssetPtr`: a helper that read the bogus native field would report the wrong wave (red).

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

const CUE4PARSE_BIN = join(toolchainCacheDir(), "modern", "bin");

describeWithTools(["modern-converter"], "Converter gameplay-data helpers (compiled from the embedded program)", () => {
  let root = "";
  let harness = "";
  let sdk = "";
  const environment = (): NodeJS.ProcessEnv => ({
    ...process.env,
    DOTNET_CLI_HOME: join(root, "home"),
    DOTNET_NOLOGO: "1",
    DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
    MSBUILDDISABLENODEREUSE: "1",
    NUGET_PACKAGES: join(root, "nuget"),
    TMPDIR: join(root, "tmp"),
    THREENATIVE_CUE4PARSE_BIN: CUE4PARSE_BIN,
  });

  it("reads the SoundCue wave from the soft path, never the bogus native SoundWave field", () => {
    // The one field the PRD names as a defect: a helper that used it would produce a different name.
    expect(CUE4PARSE_PROGRAM).toContain("player.SoundWaveAssetPtr.AssetPathName.Text");
    expect(CUE4PARSE_PROGRAM).not.toMatch(/\.SoundWave\b/);
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  beforeAll(async () => {
    sdk = await modernSdkExecutable(process.env);
    root = await mkdtemp(join(tmpdir(), "asset-mcp-gameplay-"));
    await mkdir(join(root, "tmp"), { recursive: true });
    const project = join(root, "project");
    await mkdir(project, { recursive: true });
    await writeFile(
      join(project, "Gameplay.csproj"),
      `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework>` +
        `<ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable><UseSharedCompilation>false</UseSharedCompilation></PropertyGroup>` +
        `<ItemGroup><Reference Include="CUE4Parse"><HintPath>${join(CUE4PARSE_BIN, "CUE4Parse.dll")}</HintPath></Reference>` +
        `<Reference Include="Newtonsoft.Json"><HintPath>${join(CUE4PARSE_BIN, "Newtonsoft.Json.dll")}</HintPath></Reference></ItemGroup></Project>`,
    );
    const functions = [
      "static object GpVec(",
      "static object GpRot(",
      "static string GpText(",
      "static object? GpShape(",
      "static List<object> GpAggShapes(",
      "static object GpCollision(",
      "static object GpFrame(",
      "static object? GpDamping(",
      "static FConstraintDrive GpDefaultDrive(",
      "static FLinearConstraint GpDefaultLinear(",
      "static FConeConstraint GpDefaultCone(",
      "static FTwistConstraint GpDefaultTwist(",
      "static object GpDrive(",
      "static object GpDrives(",
      "static object GpConstraint(",
      "static FPackageIndex[] GpBodySetups(",
      "static object GpBody(",
      "static object GpPhysics(",
      "static object GpSocket(",
      "static object GpStaticSocket(",
      "static object GpCueNode(",
      "static object GpCue(",
    ].map((signature) => extractCSharp(CUE4PARSE_PROGRAM, signature));
    await writeFile(
      join(project, "Program.cs"),
      `using System.Runtime.Loader;
using CUE4Parse.UE4.Assets;
using CUE4Parse.UE4.Assets.Exports;
using CUE4Parse.UE4.Assets.Exports.SkeletalMesh;
using CUE4Parse.UE4.Assets.Exports.StaticMesh;
using CUE4Parse.UE4.Assets.Exports.Sound;
using CUE4Parse.UE4.Assets.Exports.Sound.Node;
using CUE4Parse.UE4.Assets.Objects;
using CUE4Parse.UE4.Assets.Objects.Properties;
using CUE4Parse.UE4.Objects.Core.Math;
using CUE4Parse.UE4.Objects.UObject;
using CUE4Parse.UE4.Objects.PhysicsEngine;
using Newtonsoft.Json;

var probe = Environment.GetEnvironmentVariable("THREENATIVE_CUE4PARSE_BIN");
if (!string.IsNullOrEmpty(probe))
    AssemblyLoadContext.Default.Resolving += (context, name) =>
    {
        var candidate = Path.Combine(probe, name.Name + ".dll");
        return File.Exists(candidate) ? context.LoadFromAssemblyPath(candidate) : null;
    };

if (args[0] == "shape")
{
    var box = new FKBoxElem(new FStructFallback(new List<FPropertyTag>
    {
        new(new FName("Center"), new FName("StructProperty"), 0, 0, null, false, null, new StructProperty(new FScriptStruct(new FVector(10, 20, 30)))),
        new(new FName("Rotation"), new FName("StructProperty"), 0, 0, null, false, null, new StructProperty(new FScriptStruct(new FRotator(0, 90, 0)))),
        new(new FName("X"), new FName("FloatProperty"), 0, 0, null, false, null, new FloatProperty(100)),
        new(new FName("Y"), new FName("FloatProperty"), 0, 0, null, false, null, new FloatProperty(50)),
        new(new FName("Z"), new FName("FloatProperty"), 0, 0, null, false, null, new FloatProperty(25)),
    }));
    Console.WriteLine(JsonConvert.SerializeObject(GpShape(box)));
}
if (args[0] == "cue")
{
    var player = new USoundNodeWavePlayer();
    player.SoundWaveAssetPtr = new FSoftObjectPath(new FName("/Game/Audio/SW_Footstep.SW_Footstep"), "");
    player.SoundWave = new FPackageIndex((IPackage)null!, 7);
    Console.WriteLine(JsonConvert.SerializeObject(GpCueNode(player, 0)));
}
if (args[0] == "constraint")
{
    // A real FConstraintInstance whose ProfileInstance carries only bDisableCollision: the non-default
    // Value. Unreal omits ConeLimit/TwistLimit/LinearLimit/LinearDrive/AngularDrive because their saved
    // values equal the native defaults, so CUE4Parse's struct fallback leaves them null. The old
    // GpPhysics dereferenced profile.ConeLimit and crashed; the helper must rebuild the native defaults.
    var profile = new FStructFallback(new List<FPropertyTag>
    {
        new(new FName("bDisableCollision"), new FName("BoolProperty"), 0, 0, null, false, null, new BoolProperty(true)),
    });
    var instance = new FConstraintInstance(new FStructFallback(new List<FPropertyTag>
    {
        new(new FName("ConstraintBone1"), new FName("NameProperty"), 0, 0, null, false, null, new NameProperty(new FName("hand_r"))),
        new(new FName("ConstraintBone2"), new FName("NameProperty"), 0, 0, null, false, null, new NameProperty(new FName("lowerarm_r"))),
        new(new FName("ProfileInstance"), new FName("StructProperty"), 0, 0, null, false, null, new StructProperty(new FScriptStruct(profile))),
    }));
    Console.WriteLine(JsonConvert.SerializeObject(GpConstraint(instance)));
}
if (args[0] == "partial")
{
    // Partial structs: a nested struct exists but the tag whose value equals the native default was
    // omitted. The pinned constructors must fill the native default while an explicit saved value (even
    // zero) wins. This is the defect a whole-struct-null fix left behind.
    var drive = new FConstraintDrive(new FStructFallback(new List<FPropertyTag>
    {
        new(new FName("bEnablePositionDrive"), new FName("BoolProperty"), 0, 0, null, false, null, new BoolProperty(true)),
    }));
    var zeroDrive = new FConstraintDrive(new FStructFallback(new List<FPropertyTag>
    {
        new(new FName("Stiffness"), new FName("FloatProperty"), 0, 0, null, false, null, new FloatProperty(0)),
    }));
    var cone = new FConeConstraint(new FStructFallback(new List<FPropertyTag>
    {
        new(new FName("Swing2Motion"), new FName("EnumProperty"), 0, 0, null, false, null, new EnumProperty(new FName("ACM_Locked"))),
    }));
    var zeroCone = new FConeConstraint(new FStructFallback(new List<FPropertyTag>
    {
        new(new FName("Swing1LimitDegrees"), new FName("FloatProperty"), 0, 0, null, false, null, new FloatProperty(0)),
    }));
    var linear = new FLinearConstraint(new FStructFallback(new List<FPropertyTag>
    {
        new(new FName("XMotion"), new FName("EnumProperty"), 0, 0, null, false, null, new EnumProperty(new FName("LCM_Limited"))),
    }));
    Console.WriteLine(JsonConvert.SerializeObject(new
    {
        drive = GpDrive(drive),
        zeroDrive = GpDrive(zeroDrive),
        coneSwing1 = cone.Swing1LimitDegrees,
        coneSwing2 = cone.Swing2Motion.ToString(),
        zeroCone = zeroCone.Swing1LimitDegrees,
        linearLimit = linear.Limit,
        linearX = linear.XMotion.ToString(),
    }));
}
if (args[0] == "damping")
{
    // Body damping follows the same presence policy: an omitted LinearDamping tag is FBodyInstance's
    // native 0.01, an explicit zero stays zero.
    var absent = new TestBody(null, new FStructFallback());
    var explicitZero = new TestBody(null, new FStructFallback(new List<FPropertyTag>
    {
        new(new FName("LinearDamping"), new FName("FloatProperty"), 0, 0, null, false, null, new FloatProperty(0)),
    }));
    Console.WriteLine(JsonConvert.SerializeObject(new { absent = GpDamping(absent), explicitZero = GpDamping(explicitZero) }));
}
if (args[0] == "legacy-body")
{
    // A UE4.4-saved PhysicsAsset names its body array "BodySetup" (renamed "SkeletalBodySetups" later),
    // and each body exports as UBodySetup, not USkeletalBodySetup. Both must decode.
    var asset = new TestPhysicsAsset(2);
    var body = new TestBody("hand_r");
    Console.WriteLine(JsonConvert.SerializeObject(new { bodies = GpBodySetups(asset).Length, body = GpBody(body) }));
}

${functions.join("\n")}

class TestPhysicsAsset : UPhysicsAsset
{
    public TestPhysicsAsset(int count)
    {
        SkeletalBodySetups = Array.Empty<FPackageIndex>();
        ConstraintSetup = Array.Empty<FPackageIndex>();
        var elements = new List<FPropertyTagType>();
        for (var i = 0; i < count; i++) elements.Add(new ObjectProperty(new FPackageIndex((IPackage)null!, i + 1)));
        Properties = new List<FPropertyTag>
        {
            new(new FName("BodySetup"), new FName("ArrayProperty"), 0, 0, null, false, null, new ArrayProperty(new UScriptArray(elements, "ObjectProperty"))),
        };
    }
}

class TestBody : UBodySetup
{
    public TestBody(string? bone, FStructFallback? defaultInstance = null)
    {
        var props = new List<FPropertyTag>();
        if (bone != null) props.Add(new(new FName("BoneName"), new FName("NameProperty"), 0, 0, null, false, null, new NameProperty(new FName(bone))));
        if (defaultInstance != null)
            props.Add(new(new FName("DefaultInstance"), new FName("StructProperty"), 0, 0, null, false, null, new StructProperty(new FScriptStruct(defaultInstance))));
        Properties = props;
    }
}
`,
    );
    try {
      execFileSync(sdk, ["build", project, "-c", "Release", "-o", join(root, "bin"), "-nodeReuse:false"], {
        env: environment(),
        stdio: "pipe",
        timeout: 240_000,
      });
    } catch (error) {
      const output = String((error as { stdout?: Buffer }).stdout ?? "");
      throw new Error(`the extracted gameplay helpers did not compile:\n${output.split("\n").filter((line) => line.includes("error")).slice(0, 10).join("\n")}`);
    }
    harness = join(root, "bin", "Gameplay.dll");
  }, 300_000);

  const run = (...args: string[]): string =>
    execFileSync(sdk, [harness, ...args], { env: environment(), encoding: "utf8", timeout: 60_000 }).trim();

  it("converts a real FKBoxElem's center, rotation and extents", () => {
    const shape = JSON.parse(run("shape")) as Record<string, unknown>;
    expect(shape.type).toBe("box");
    expect(shape.center).toEqual([10, 20, 30]);
    expect(shape.rotation).toEqual([0, 90, 0]);
    expect(shape.x).toBe(100);
    expect(shape.y).toBe(50);
    expect(shape.z).toBe(25);
  });

  it("names the wave player's soft-path wave, ignoring the native SoundWave", () => {
    const node = JSON.parse(run("cue")) as { type: string; params: { wave: string } };
    expect(node.type).toBe("USoundNodeWavePlayer");
    expect(node.params.wave).toBe("/Game/Audio/SW_Footstep.SW_Footstep");
  });

  it("rebuilds Unreal's native constraint defaults when the saved profile omits them", () => {
    const constraint = JSON.parse(run("constraint")) as {
      child: string;
      parent: string;
      swing1Deg: number;
      swing2Deg: number;
      twistDeg: number;
      linearLimit: number;
      motions: { linear: string[]; swing1: string; swing2: string; twist: string };
      drives: { linear: { x: { stiffness: number; damping: number; maxForce: number; positionDrive: boolean } }; angular: { mode: string } };
      disableCollision: boolean;
    };
    // The bones and the one saved non-default value survive.
    expect(constraint.child).toBe("hand_r");
    expect(constraint.parent).toBe("lowerarm_r");
    expect(constraint.disableCollision).toBe(true);
    // FConeConstraint/FTwistConstraint defaults from ConstraintTypes.cpp: 45 degrees, free motion.
    expect(constraint.swing1Deg).toBe(45);
    expect(constraint.swing2Deg).toBe(45);
    expect(constraint.twistDeg).toBe(45);
    expect(constraint.motions.swing1).toBe("ACM_Free");
    expect(constraint.motions.swing2).toBe("ACM_Free");
    expect(constraint.motions.twist).toBe("ACM_Free");
    // FLinearConstraint defaults: a zero limit, all three axes locked.
    expect(constraint.linearLimit).toBe(0);
    expect(constraint.motions.linear).toEqual(["LCM_Locked", "LCM_Locked", "LCM_Locked"]);
    // FConstraintDrive defaults from ConstraintDrives.cpp: stiffness 50, damping 1, drives off.
    expect(constraint.drives.linear.x).toEqual({ stiffness: 50, damping: 1, maxForce: 0, positionDrive: false, velocityDrive: false });
    expect(constraint.drives.angular.mode).toBe("SLERP");
  });

  it("fills a partial struct's native defaults and keeps an explicit zero", () => {
    const partial = JSON.parse(run("partial")) as {
      drive: { stiffness: number; damping: number; positionDrive: boolean };
      zeroDrive: { stiffness: number };
      coneSwing1: number;
      coneSwing2: string;
      zeroCone: number;
      linearLimit: number;
      linearX: string;
    };
    // A drive with only bEnablePositionDrive saved: Stiffness/Damping are the native 50/1, drive on.
    expect(partial.drive).toEqual({ stiffness: 50, damping: 1, maxForce: 0, positionDrive: true, velocityDrive: false });
    // An explicit saved zero is not replaced by the default.
    expect(partial.zeroDrive.stiffness).toBe(0);
    // A cone with only Swing2Motion saved: the omitted swing is 45 degrees, the saved motion survives.
    expect(partial.coneSwing1).toBe(45);
    expect(partial.coneSwing2).toBe("ACM_Locked");
    // An explicit 0-degree cone stays 0, not 45.
    expect(partial.zeroCone).toBe(0);
    // A linear constraint with only XMotion saved: Limit is the native 0, the saved motion survives.
    expect(partial.linearLimit).toBe(0);
    expect(partial.linearX).toBe("LCM_Limited");
  });

  it("reads a legacy BodySetup array and a base UBodySetup export", () => {
    const legacy = JSON.parse(run("legacy-body")) as {
      bodies: number;
      body: { bone: string; physicsType: string; traceFlag: string; shapes: unknown[] };
    };
    // The UE4.4 package names the array "BodySetup"; both entries are read, not zero.
    expect(legacy.bodies).toBe(2);
    // The body is a UBodySetup, not a USkeletalBodySetup: the bone name comes from the tagged property.
    expect(legacy.body.bone).toBe("hand_r");
    expect(legacy.body.shapes).toEqual([]);
  });

  it("keeps body damping presence-based", () => {
    const damping = JSON.parse(run("damping")) as {
      absent: { linear: number; angular: number };
      explicitZero: { linear: number; angular: number };
    };
    // FBodyInstance's native LinearDamping is 0.01 when the tag is omitted...
    expect(damping.absent.linear).toBeCloseTo(0.01, 6);
    // ...but an explicit saved zero stays zero.
    expect(damping.explicitZero.linear).toBe(0);
  });
});
