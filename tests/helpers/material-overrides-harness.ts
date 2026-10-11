import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";

import { modernSdkExecutable, toolchainCacheDir } from "../../src/unreal/provision.js";
import { childEnvironment, runBounded } from "../../src/unreal/toolchain.js";

// Synthetic inputs in the shape CUE4Parse holds them after deserialization. Each case runs the converter's own
// MaterialOverrides.Blocks on one instance and prints one JSON line: the emitted text, or the refusal it raised. Binary rows are
// built by CUE4Parse's own archive constructor from the bytes a 4.18 package holds, so their typed fields are the real reader's.
export const MATERIAL_OVERRIDE_HARNESS = String.raw`using System.Globalization;
using System.Text;
using System.Text.Json;
using CUE4Parse.UE4.Assets.Exports;
using CUE4Parse.UE4.Assets.Exports.Material;
using CUE4Parse.UE4.Assets.Exports.Material.Parameters;
using CUE4Parse.UE4.Assets.Objects;
using CUE4Parse.UE4.Assets.Objects.Properties;
using CUE4Parse.UE4.Objects.Core.Math;
using CUE4Parse.UE4.Objects.Core.Misc;
using CUE4Parse.UE4.Objects.UObject;
using CUE4Parse.UE4.Readers;
using CUE4Parse.UE4.Versions;

static class MaterialOverrideHarness
{
    static readonly Dictionary<string, string> NoFailures = new(StringComparer.OrdinalIgnoreCase);

    static int Main()
    {
        // A decimal comma, as on a German host: the blocks must still write a point.
        var comma = (CultureInfo)CultureInfo.InvariantCulture.Clone();
        comma.NumberFormat.NumberDecimalSeparator = ",";
        CultureInfo.CurrentCulture = comma;
        CultureInfo.DefaultThreadCurrentCulture = comma;

        var failed = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["MI_Test"] = "UMaterialInstanceConstant ParserException: boom" };
        Run("scalar-values", Scalars(Scalar("Zero", 0f), Scalar("Negative", -0.25f), Scalar("Tiny", 1e-5f)));
        Run("vector-channels", Instance(Tag("VectorParameterValues", Rows(Color("Tint", 0f, 0.5f, 0f, 1f)))));
        Run("invariant-culture", Scalars(Scalar("Half", 0.5f), Scalar("Negative", -0.25f)));
        Run("false-beats-parent", Switches("StaticParameters", Switch("UseDetail", true, false)));
        Run("disabled-row-inherits", Switches("StaticParameters", Switch("Disabled", false, true), Switch("Enabled", true, true)));
        Run("runtime-set", Switches("StaticParametersRuntime", Switch("FromRuntime", true, true)));
        Run("complete-absent", Instance());
        Run("failed-read-absent", Instance(), failed);
        Run("scalar-absent", Scalars(Row(Tag("ParameterInfo", Info("Roughness")))));
        Run("scalar-unreadable", Scalars(Row(Tag("ParameterValue", new NameProperty(new FName("oops"))), Tag("ParameterInfo", Info("Roughness")))));
        Run("switch-no-override-flag", Switches("StaticParameters", Row(Tag("Value", new BoolProperty(true)), Tag("ParameterInfo", Info("NoFlag")))));
        Run("non-finite", Scalars(Scalar("Broken", float.NaN)));
        Run("comma-name", Scalars(Scalar("true = leaf, false = trunk", 1f)));
        Run("brace-name", Scalars(Scalar("Bad}Name", 1f)));
        Run("layer", Scalars(Row(Tag("ParameterValue", new FloatProperty(1f)), Tag("ParameterInfo", Info("Layered", "LayerParameter", 0)))));
        Run("layer-index", Scalars(Row(Tag("ParameterValue", new FloatProperty(1f)), Tag("ParameterInfo", Info("Indexed", "GlobalParameter", 3)))));
        Run("legacy-name", Scalars(Row(Tag("ParameterValue", new FloatProperty(2f)), Tag("ParameterName", new NameProperty(new FName("LegacyName"))))));
        Run("collision", Scalars(Scalar("Same", 1f), Scalar("same", 2f)));
        Run("tagged-guid", Scalars(Row(
            Tag("ParameterValue", new FloatProperty(1f)),
            Tag("ParameterInfo", Info("Guided")),
            Tag("ExpressionGUID", new StructProperty(new FScriptStruct(new FGuid(1, 2, 3, 4)))))));
        Run("binary-completed-false", BinaryInstance(Binary("UseDetail", true, false)));
        Run("binary-disabled-inherits", BinaryInstance(Binary("Disabled", false, true)));
        Run("binary-guid", BinaryInstance(Binary("Guided", true, true, new FGuid(1, 2, 3, 4))));
        Run("binary-failed-read", BinaryInstance(Binary("UseDetail", true, false)), failed);
        return 0;
    }

    static void Run(string name, UMaterialInstance instance, IReadOnlyDictionary<string, string>? failures = null)
    {
        var result = new Dictionary<string, string> { ["case"] = name };
        try
        {
            result["text"] = MaterialOverrides.Blocks(instance, "MI_Test", failures ?? NoFailures);
        }
        catch (MaterialOverrides.Refusal refusal)
        {
            result["refused"] = refusal.Message;
        }
        catch (Exception error)
        {
            result["error"] = error.ToString();
        }
        Console.WriteLine(JsonSerializer.Serialize(result));
    }

    static FPropertyTag Tag(string name, FPropertyTagType value) => new() { Name = new FName(name), Tag = value };

    static FStructFallback Row(params FPropertyTag[] tags) => new(tags.ToList());

    static FPropertyTagType Struct(FStructFallback row) => new StructProperty(new FScriptStruct(row));

    static FPropertyTagType Rows(params FStructFallback[] rows) =>
        new ArrayProperty(new UScriptArray(rows.Select(Struct).ToList(), "StructProperty"));

    static FPropertyTagType Info(string name, string association = "GlobalParameter", int index = -1) => Struct(Row(
        Tag("Name", new NameProperty(new FName(name))),
        Tag("Association", new EnumProperty(new FName(association))),
        Tag("Index", new IntProperty(index))));

    static UMaterialInstance Instance(params FPropertyTag[] tags)
    {
        var instance = new UMaterialInstanceConstant();
        instance.Properties.AddRange(tags);
        return instance;
    }

    static UMaterialInstance Scalars(params FStructFallback[] rows) => Instance(Tag("ScalarParameterValues", Rows(rows)));

    static FStructFallback Scalar(string name, float value) =>
        Row(Tag("ParameterValue", new FloatProperty(value)), Tag("ParameterInfo", Info(name)));

    static FStructFallback Color(string name, float r, float g, float b, float a) => Row(
        Tag("ParameterValue", new StructProperty(new FScriptStruct(new FLinearColor(r, g, b, a)))),
        Tag("ParameterInfo", Info(name)));

    static FStructFallback Switch(string name, bool enabled, bool value) => Row(
        Tag("bOverride", new BoolProperty(enabled)),
        Tag("Value", new BoolProperty(value)),
        Tag("ParameterInfo", Info(name)));

    static UMaterialInstance Switches(string field, params FStructFallback[] rows) =>
        Instance(Tag(field, Struct(Row(Tag("StaticSwitchParameters", Rows(rows))))));

    // A legacy binary row, read by CUE4Parse's archive constructor: the name as an FString, then Value and bOverride as 32-bit
    // booleans, then the expression GUID (a 4.18 archive carries it).
    static FStaticSwitchParameter Binary(string name, bool enabled, bool value, FGuid guid = default)
    {
        var bytes = new List<byte>();
        var text = Encoding.ASCII.GetBytes(name + "\0");
        bytes.AddRange(BitConverter.GetBytes(text.Length));
        bytes.AddRange(text);
        bytes.AddRange(BitConverter.GetBytes(value ? 1 : 0));
        bytes.AddRange(BitConverter.GetBytes(enabled ? 1 : 0));
        foreach (var part in new[] { guid.A, guid.B, guid.C, guid.D }) bytes.AddRange(BitConverter.GetBytes(part));
        return new FStaticSwitchParameter(new FByteArchive("binary", bytes.ToArray(), new VersionContainer(EGame.GAME_UE4_18)));
    }

    static UMaterialInstance BinaryInstance(params FStaticSwitchParameter[] rows)
    {
        // Empty scalar and vector arrays are present, so the only collection left to decide is the binary switch set.
        var instance = Instance(Tag("ScalarParameterValues", Rows()), Tag("VectorParameterValues", Rows()));
        var set = new FStaticParameterSet(Row());
        set.StaticSwitchParameters = rows;
        instance.StaticParameters = set;
        return instance;
    }
}
`;

export interface HarnessCase {
  readonly text?: string;
  readonly refused?: string;
  readonly error?: string;
}

export interface MaterialOverrideHarnessRun {
  readonly build: { readonly code: number | null; readonly output: string };
  readonly cases: Readonly<Record<string, HarnessCase>>;
}

export interface ConverterBuild {
  readonly code: number;
  readonly output: string;
  readonly dll: string;
}

/** One converter run on a synthetic source tree. `files` are the output's files, relative and sorted, with forward slashes. */
export interface ConverterRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly output: string;
  readonly files: readonly string[];
}

const MODERN_BIN = join(toolchainCacheDir(process.env), "modern", "bin");

/**
 * Compiles `program` (the converter's own C#) together with the harness against the installed CUE4Parse assemblies, then runs
 * it. Everything is written under `directory`, which the caller removes. Nothing is installed, published or written to the
 * toolchain cache.
 */
export async function runMaterialOverrideHarness(
  program: string,
  engineContent: string,
  directory: string,
): Promise<MaterialOverrideHarnessRun> {
  const build = await compileProject(directory, "MaterialOverrideHarness", {
    "Program.cs": program,
    "EngineContent.cs": engineContent,
    "MaterialOverrideHarness.cs": MATERIAL_OVERRIDE_HARNESS,
  }, "MaterialOverrideHarness");
  if (build.code !== 0) return { build: { code: build.code, output: build.output }, cases: {} };
  const run = await runBounded(await modernSdkExecutable(process.env), [build.dll], {
    timeoutMs: 120_000,
    maxOutputBytes: 16 * 1024 * 1024,
    environment: childEnvironment(process.env),
  });
  const cases: Record<string, HarnessCase> = {};
  for (const line of run.stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    const parsed = JSON.parse(line) as HarnessCase & { case: string };
    const { case: name, ...result } = parsed;
    cases[name] = result;
  }
  return { build: { code: run.code, output: `${run.stdout.slice(-4000)}${run.stderr.slice(-4000)}` }, cases };
}

/** Compiles the converter program alone, the program that `ensureModernConverter` ships, so its export path can run on packages. */
export function buildConverterProgram(program: string, engineContent: string, directory: string): Promise<ConverterBuild> {
  return compileProject(directory, "MaterialExportConverter", { "Program.cs": program, "EngineContent.cs": engineContent });
}

/**
 * Runs a built converter on `packages` (relative path under `Game/`, to bytes) under `caseDirectory`, as the importer invokes it:
 * a project's `Content` tree as the source root, `--export-dir`, and the UE 4.19 profile the synthetic packages are written for.
 * Under `Content`, package paths come out as `/Game/...`, the form the material identities and the importer use.
 */
export async function convertPackages(
  build: ConverterBuild,
  caseDirectory: string,
  packages: Readonly<Record<string, Buffer>>,
  engine = "4.19",
): Promise<ConverterRun> {
  const root = join(caseDirectory, "source");
  const output = join(caseDirectory, "output");
  for (const [path, bytes] of Object.entries(packages)) {
    const file = join(root, "Content", path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
  const args = [build.dll, root, "--export-dir", output, "--engine", engine];
  const run = await runBounded(await modernSdkExecutable(process.env), args, {
    timeoutMs: 600_000,
    maxOutputBytes: 64 * 1024 * 1024,
    environment: childEnvironment(process.env),
  });
  return { code: run.code, stdout: run.stdout, stderr: run.stderr, output, files: await listFiles(output) };
}

async function compileProject(
  root: string,
  assembly: string,
  sources: Readonly<Record<string, string>>,
  startupObject?: string,
): Promise<ConverterBuild> {
  const sdk = await modernSdkExecutable(process.env);
  await mkdir(root, { recursive: true });
  for (const [file, text] of Object.entries(sources)) await writeFile(join(root, file), text);
  // Every installed library the program can reach. The runtime's own assemblies come from the SDK, never from the publish folder.
  const libraries = (await readdir(MODERN_BIN)).filter((file) => file.endsWith(".dll") && !/^(?:System\.|Microsoft\.|ThreeNativeConverter\.)/.test(file));
  const project = join(root, `${assembly}.csproj`);
  await writeFile(
    project,
    `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <UseSharedCompilation>false</UseSharedCompilation>
    ${startupObject ? `<StartupObject>${startupObject}</StartupObject>` : ""}
  </PropertyGroup>
  <ItemGroup>
    ${libraries.map((file) => assemblyReference(file.slice(0, -".dll".length))).join("")}
  </ItemGroup>
</Project>
`,
  );
  // MSBuild creates temp subdirectories under TMPDIR and fails with MSB1025 when it is missing.
  for (const sub of ["tmp", "home", "nuget"]) await mkdir(join(root, sub), { recursive: true });
  const output = join(root, "out");
  const build = await runBounded(sdk, ["build", project, "-c", "Release", "-o", output, "--nologo", "-nodeReuse:false"], {
    timeoutMs: 900_000,
    maxOutputBytes: 64 * 1024 * 1024,
    environment: buildEnvironment(root),
  });
  return { code: build.code, output: `${build.stdout.slice(-4000)}${build.stderr.slice(-4000)}`, dll: join(output, `${assembly}.dll`) };
}

async function listFiles(root: string): Promise<string[]> {
  const names = await readdir(root, { recursive: true }).catch(() => [] as string[]);
  const files: string[] = [];
  for (const name of names) if ((await stat(join(root, name))).isFile()) files.push(name.split(sep).join("/"));
  return files.sort();
}

function assemblyReference(assembly: string): string {
  const path = join(MODERN_BIN, `${assembly}.dll`);
  return `<Reference Include="${escapeXml(assembly)}"><HintPath>${escapeXml(path)}</HintPath></Reference>`;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Everything the child build needs and nothing shared: restore, obj and bin all land under the caller's temp directory. */
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
