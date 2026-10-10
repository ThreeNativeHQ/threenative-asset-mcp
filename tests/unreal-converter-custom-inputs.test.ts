import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, expect, it } from "vitest";

import { CUE4PARSE_PROGRAM } from "../src/unreal/cue4parse-adapter.js";
import { toolchainCacheDir } from "../src/unreal/provision.js";
import { describeWithTools } from "./helpers/require-tool.js";

// A `MaterialExpressionCustom` node's `Inputs` array stores each pin as an `FStructFallback` wrapper whose
// `InputName` names the pin and whose `Input` holds the FExpressionInput. CUE4Parse has no FCustomInput type
// at the pinned commit, so the adapter reads the wrapper itself. This compiled test runs the two helpers the dump
// path calls, `GraphCustomInputs` and then `GraphReadInput`, extracted from the embedded program and compiled against
// the real CUE4Parse types from the provisioned modern converter, not stubs. Each pin links through a real pinned
// FPackageIndex, so the expectation reads its Index; the ExpressionName text is set but never read. The link has no
// package owner because GraphReadInput never resolves one. `Pin`, which loads link targets, is not covered here.

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
      // A line comment may hold an apostrophe ("FunctionInput's"), which must not open a char literal.
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
        // An expression-bodied member (`=> x switch { ... };`) ends at the semicolon after the brace.
        const rest = /^\s*;/.exec(program.slice(index + 1));
        return program.slice(start, index + 1 + (rest ? rest[0].length : 0));
      }
    } else if (char === ";" && !opened && depth === 0) {
      // An expression-bodied member with no braces (`=> holder.Properties.FirstOrDefault(...);`) ends here.
      return program.slice(start, index + 1);
    }
  }
  throw new Error(`unbalanced braces after ${signature}`);
}

const DOTNET = join(toolchainCacheDir(), "modern", "dotnet", process.platform === "win32" ? "dotnet.exe" : "dotnet");
const CUE4PARSE_BIN = join(toolchainCacheDir(), "modern", "bin");

describeWithTools(["modern-converter"], "Custom node named inputs (compiled from the embedded program)", () => {
  let root = "";
  let harness = "";
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

  it("keeps its helper, refusal messages and version in the embedded program", () => {
    expect(CUE4PARSE_PROGRAM).toContain("static List<(string Name, object Value)>? GraphCustomInputs(bool raw, UScriptArray array, out string? error)");
    expect(CUE4PARSE_PROGRAM).toContain('className == "Custom" && name == "Inputs"');
    expect(CUE4PARSE_PROGRAM).toContain("Custom Inputs use a raw layout this converter cannot read");
    expect(CUE4PARSE_PROGRAM).toContain("Custom Inputs has a duplicate pin name");
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "asset-mcp-custom-inputs-"));
    await mkdir(join(root, "tmp"), { recursive: true });
    const project = join(root, "project");
    await mkdir(project, { recursive: true });
    await writeFile(
      join(project, "CustomInputs.csproj"),
      `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework>` +
        `<ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable><UseSharedCompilation>false</UseSharedCompilation></PropertyGroup>` +
        `<ItemGroup><Reference Include="CUE4Parse"><HintPath>${join(CUE4PARSE_BIN, "CUE4Parse.dll")}</HintPath></Reference></ItemGroup>` +
        `</Project>`,
    );
    // The record is a type declaration, so it must follow the top-level statements and local functions (CS8803).
    const functions = [
      "static List<(string Name, object Value)>? GraphCustomInputs(",
      "static (FPackageIndex? Expression, int Output, int[]? Mask, object? Constant, bool UseConstant) GraphReadInput(",
      "static object? GraphValue(",
      "static double DumpNum(",
      "static double[] DumpVec(",
      "static FPropertyTag? GraphProperty(",
      "static string GraphText(",
      "sealed record GraphLegacyInput(",
    ].map((signature) => extractCSharp(CUE4PARSE_PROGRAM, signature));
    await writeFile(
      join(project, "Program.cs"),
      `using System.Runtime.Loader;
using CUE4Parse.UE4.Assets;
using CUE4Parse.UE4.Assets.Exports;
using CUE4Parse.UE4.Assets.Objects;
using CUE4Parse.UE4.Assets.Objects.Properties;
using CUE4Parse.UE4.Objects.Core.Math;
using CUE4Parse.UE4.Objects.Engine;
using CUE4Parse.UE4.Objects.UObject;

var probe = Environment.GetEnvironmentVariable("THREENATIVE_CUE4PARSE_BIN");
if (!string.IsNullOrEmpty(probe))
    AssemblyLoadContext.Default.Resolving += (context, name) =>
    {
        var candidate = Path.Combine(probe, name.Name + ".dll");
        return File.Exists(candidate) ? context.LoadFromAssemblyPath(candidate) : null;
    };

if (args[0] == "custom")
{
    var mode = args[1];
    var array = mode switch
    {
        "ok" => new UScriptArray(new List<FPropertyTagType>
        {
            InputElement("BaseColor", new FExpressionInput { OutputIndex = 2, Mask = 1, MaskR = 1, Expression = Link(3), ExpressionName = new FName("Target/Base") }),
            InputElement("Roughness", new FExpressionInput { OutputIndex = 5, Mask = 4, MaskB = 1, Expression = Link(7), ExpressionName = new FName("Target/Rough") }),
        }, "StructProperty"),
        "blank" => new UScriptArray(new List<FPropertyTagType>
        {
            InputElement("", new FExpressionInput { OutputIndex = 7, Expression = Link(9) }),
        }, "StructProperty"),
        "dup" => new UScriptArray(new List<FPropertyTagType>
        {
            InputElement("Color", new FExpressionInput { OutputIndex = 1 }),
            InputElement("Color", new FExpressionInput { OutputIndex = 2 }),
        }, "StructProperty"),
        "noinput" => new UScriptArray(new List<FPropertyTagType>
        {
            new StructProperty(new FScriptStruct(new FStructFallback(new List<FPropertyTag>
            {
                new(new FName("InputName"), new FName("NameProperty"), 0, 0, null, false, null, new NameProperty(new FName("Color"))),
            }))),
        }, "StructProperty"),
        "raw" => new UScriptArray(new List<FPropertyTagType>(), "StructProperty"),
        _ => throw new ArgumentException(mode),
    };
    var pins = GraphCustomInputs(mode == "raw", array, out var error);
    if (pins is null) { Console.WriteLine("error " + error); return; }
    Console.WriteLine(string.Join(" ", pins.Select(pin =>
    {
        var (expression, output, mask, _, _) = GraphReadInput(pin.Value);
        return $"{pin.Name}:{expression?.Index}:{output}:{(mask is null ? "-" : string.Join(",", mask))}";
    })));
}

static FPropertyTagType InputElement(string name, FExpressionInput input) => new StructProperty(new FScriptStruct(new FStructFallback(new List<FPropertyTag>
{
    new(new FName("InputName"), new FName("NameProperty"), 0, 0, null, false, null, new NameProperty(new FName(name))),
    new(new FName("Input"), new FName("StructProperty"), 0, 0, null, false, null, new StructProperty(new FScriptStruct(input))),
})));

// GraphReadInput reads only Index, never Owner, so a null owner gives a real pinned link without a package.
static FPackageIndex Link(int index) => new((IPackage)null!, index);

${functions.join("\n")}
`,
    );
    try {
      execFileSync(DOTNET, ["build", project, "-c", "Release", "-o", join(root, "bin"), "-nodeReuse:false"], {
        env: environment(),
        stdio: "pipe",
        timeout: 240_000,
      });
    } catch (error) {
      const output = String((error as { stdout?: Buffer }).stdout ?? "");
      throw new Error(`the extracted helper did not compile:\n${output.split("\n").filter((line) => line.includes("error")).slice(0, 10).join("\n")}`);
    }
    harness = join(root, "bin", "CustomInputs.dll");
  }, 300_000);

  const run = (...args: string[]): string =>
    execFileSync(DOTNET, [harness, ...args], { env: environment(), encoding: "utf8", timeout: 60_000 }).trim();

  it("reads each pin's InputName, its real Expression index, output index and mask", () => {
    expect(run("custom", "ok")).toBe("BaseColor:3:2:1,0,0,0 Roughness:7:5:0,0,1,0");
  });

  it("gives an unnamed pin its array index as a deterministic key", () => {
    expect(run("custom", "blank")).toBe("Inputs[0]:9:7:-");
  });

  it("refuses a duplicate pin name without inventing a pin", () => {
    expect(run("custom", "dup")).toMatch(/^error Custom Inputs has a duplicate pin name Color$/);
  });

  it("refuses a wrapper whose Input is unreadable", () => {
    expect(run("custom", "noinput")).toBe("error Custom Input Color has no readable input");
  });

  it("refuses a raw Inputs layout rather than guessing", () => {
    expect(run("custom", "raw")).toBe("error Custom Inputs use a raw layout this converter cannot read");
  });
});
