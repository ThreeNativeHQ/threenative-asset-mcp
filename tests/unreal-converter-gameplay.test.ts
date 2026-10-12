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
      "static object GpDrive(",
      "static object GpDrives(",
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

${functions.join("\n")}
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
});
