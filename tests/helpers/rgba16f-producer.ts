import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { CUE4PARSE_PROGRAM, CUE4PARSE_SOURCE } from "../../src/unreal/cue4parse-adapter.js";
import { modernSdkExecutable, toolchainCacheDir } from "../../src/unreal/provision.js";

// The RGBA16F producer for tests. The converter's CUE4Parse glue, its pure validation and its writer are extracted from
// the embedded program and compiled against the pinned CUE4Parse, CUE4Parse-Conversion and Newtonsoft assemblies of the
// `modern-converter` prerequisite. Each case goes in as JSON and comes out as the binary and manifest the converter writes.
// A typed case (`extractTexture`) builds a synthetic UTexture2D from the pinned types and runs the production reader,
// ReadRgba16fSourceArt, on it. Only synthetic inputs reach it: nothing from a licensed pack.

/**
 * Extracts one top-level C# declaration (signature line through its matching brace) from the program. The scanner skips string and
 * char literals but not comments, so an apostrophe in a comment inside the declaration would open a char literal that runs on.
 */
export function extractCSharp(program: string, signature: string): string {
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
    }
  }
  throw new Error(`unbalanced braces after ${signature}`);
}

/** A record declaration: its signature line through the first `);`. */
function extractRecord(program: string, signature: string): string {
  const start = program.indexOf(signature);
  if (start < 0) throw new Error(`converter program has no ${signature}`);
  return program.slice(start, program.indexOf(");", start) + 2);
}

const SHARP_BIN = join(toolchainCacheDir(), "modern", "bin");
// Every managed assembly the converter ships except the framework facades, so the compiler sees the same types it does.
const PINNED_ASSEMBLIES = [
  "CUE4Parse", "CUE4Parse-Conversion", "Newtonsoft.Json", "Serilog", "SixLabors.ImageSharp", "SkiaSharp", "SharpGLTF.Core",
  "SharpGLTF.Runtime", "SharpGLTF.Toolkit", "Microsoft.Bcl.Memory", "CommunityToolkit.HighPerformance", "Blake3", "GenericReader",
  "AssetRipper.TextureDecoder", "OodleSharp", "Oodle.NET", "K4os.Compression.LZ4", "BouncyCastle.Cryptography", "IndexRange",
  "FixedMathSharp", "MemoryPack.Core", "OffiUtils", "SevenZip", "SubstreamSharp", "Fmod5Sharp", "NAudio.Core", "OggVorbisEncoder",
  "ZstdSharp", "K4os.Hash.xxHash", "K4os.Compression.LZ4.Streams", "VGAudio",
];

// Mirrors the converter's program usings: the glue names UTexture2D, FStructFallback, FByteBulkData and IPackage. The typed
// extraction below also names the tagged property values and the archives it builds its synthetic texture from.
const USINGS = `using System.Buffers.Binary;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using CUE4Parse.FileProvider;
using CUE4Parse.MappingsProvider;
using CUE4Parse.UE4.Assets;
using CUE4Parse.UE4.Assets.Exports;
using CUE4Parse.UE4.Assets.Exports.Texture;
using CUE4Parse.UE4.Assets.Objects;
using CUE4Parse.UE4.Assets.Objects.Properties;
using CUE4Parse.UE4.Assets.Readers;
using CUE4Parse.UE4.Objects.Core.Misc;
using CUE4Parse.UE4.Objects.UObject;
using CUE4Parse.UE4.Readers;
using CUE4Parse.UE4.Versions;
using CUE4Parse_Conversion;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
`;

// The typed test's half of the harness. It builds the UTexture2D the reader is given from pinned CUE4Parse types: a typed
// Source struct among the tagged properties, and SourceArt read through FByteBulkData from an inline bulk header. UTexture
// sets SourceArt and SRGB only while it deserializes, so the test sets those two by reflection. Nothing here is the production
// reader: ReadRgba16fSourceArt and ValidateRgba16fSourceArt are the extracted functions.
const SYNTHETIC_TEXTURE = `
// A tagged property the reader can look up by name. The value's type is the pinned one (IntProperty, EnumProperty, ...).
static FPropertyTag SyntheticTag(string name, string propertyType, FPropertyTagType value) =>
    new FPropertyTag(new FName(name), new FName(propertyType), 0, 0, null, false, null, value);
// A UTexture2D with the Source struct and SourceArt the test describes. Each part is optional, so an absent one stays absent.
static UTexture2D SyntheticTexture(JObject spec)
{
    var texture = new UTexture2D();
    if (spec["source"] is JObject source)
    {
        var fields = new List<FPropertyTag>
        {
            SyntheticTag("Format", "EnumProperty", new EnumProperty(new FName("ETextureSourceFormat::" + (string)source["format"]!))),
            SyntheticTag("SizeX", "IntProperty", new IntProperty((int)source["sizeX"]!)),
            SyntheticTag("SizeY", "IntProperty", new IntProperty((int)source["sizeY"]!)),
            SyntheticTag("NumSlices", "IntProperty", new IntProperty((int)source["numSlices"]!)),
            SyntheticTag("NumMips", "IntProperty", new IntProperty((int)source["numMips"]!)),
            SyntheticTag("bPNGCompressed", "BoolProperty", new BoolProperty((bool?)source["pngCompressed"] ?? false)),
        };
        // A null compression leaves CompressionFormat out, as UE 4.19's Source has no such field. An object stands in for a field of another type.
        if (source["compression"] is JObject wrongType)
            fields.Add(SyntheticTag("CompressionFormat", "IntProperty", new IntProperty((int)wrongType["integer"]!)));
        else if (source["compression"] is { Type: not JTokenType.Null } compression)
            fields.Add(SyntheticTag("CompressionFormat", "EnumProperty", new EnumProperty(new FName("ETextureCompressionFormat::" + (string)compression))));
        texture.Properties.Add(SyntheticTag("Source", "StructProperty", new StructProperty(new FScriptStruct(new FStructFallback(fields)))));
    }
    if (spec["sourceArt"] is JObject art)
    {
        var bulk = SyntheticBulk(Convert.FromBase64String((string)art["payload"]!), (int)art["elementCount"]!, (int)art["sizeOnDisk"]!);
        typeof(UTexture).GetProperty(nameof(UTexture.SourceArt), BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)!
            .GetSetMethod(true)!.Invoke(texture, new object?[] { bulk });
    }
    if ((bool?)spec["srgb"] == true)
        typeof(UTexture).GetProperty(nameof(UTexture.SRGB), BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)!
            .GetSetMethod(true)!.Invoke(texture, new object?[] { true });
    return texture;
}
// The bulk header UE writes for an inline payload: flags, element count, size on disk, and the offset (eight bytes once the
// archive is at large offsets). The owner fix-up flag is set, so no package is needed to read the offset.
static FByteBulkData SyntheticBulk(byte[] payload, int elementCount, int sizeOnDisk)
{
    var versions = new VersionContainer(EGame.GAME_UE4_27);
    using var stream = new MemoryStream();
    using (var writer = new BinaryWriter(stream, Encoding.UTF8, leaveOpen: true))
    {
        writer.Write((uint) (EBulkDataFlags.BULKDATA_ForceInlinePayload | EBulkDataFlags.BULKDATA_NoOffsetFixUp));
        writer.Write(elementCount);
        writer.Write((uint) sizeOnDisk);
        if (versions.Ver >= EUnrealEngineObjectUE4Version.BULKDATA_AT_LARGE_OFFSETS) writer.Write(0L);
        else writer.Write(0);
        writer.Write(payload);
    }
    return new FByteBulkData(new FAssetArchive(new FByteArchive("synthetic SourceArt", stream.ToArray(), versions), null));
}
`;

// The loose-tree probe: a real DefaultFileProvider over the root the test names, initialized the way the converter initializes its
// source root. Nothing here parses a file. The helper is a local function, so it precedes the type declarations (see EXPORTLESS_PACKAGE).
const LOOSE_PROBE = `
// Initializes a provider over one loose root and any extra roots the case names.
static DefaultFileProvider LooseProvider(string root, JObject spec)
{
    var extra = ((JArray?)spec["extraDirectories"] ?? new JArray()).Select(item => new DirectoryInfo(Path.GetFullPath((string)item!))).ToArray();
    var provider = new DefaultFileProvider(new DirectoryInfo(root), extra, SearchOption.AllDirectories, new VersionContainer(EGame.GAME_UE4_19), StringComparer.OrdinalIgnoreCase);
    provider.Initialize();
    provider.PostMount();
    return provider;
}
`;

// A package with no exports, for the export boundary to refuse before it reads a texture. It is a type, so it follows the local
// functions and the records: top-level statements and local functions must precede type declarations.
const EXPORTLESS_PACKAGE = `
sealed class ExportlessPackage : IPackage
{
    public string Name { get; set; } = "ExportlessProbe";
    public IFileProvider? Provider => null;
    public TypeMappings? Mappings => null;
    public FPackageFileSummary Summary => throw new NotSupportedException("the probe package has no summary");
    public FNameEntrySerialized[] NameMap => Array.Empty<FNameEntrySerialized>();
    public int ImportMapLength => 0;
    public int ExportMapLength => 0;
    public Lazy<UObject>[] ExportsLazy => Array.Empty<Lazy<UObject>>();
    public bool IsFullyLoaded => true;
    public bool CanDeserialize => false;
    public bool HasFlags(EPackageFlags flags) => false;
    public int GetExportIndex(string name, StringComparison comparisonType = StringComparison.Ordinal) => -1;
    public ResolvedObject? ResolvePackageIndex(FPackageIndex? index) => null;
}
`;

/** A --data-texture selector over a loose root: `root` is the converter's source root, `selector` is root-relative. */
export interface LooseCase {
  readonly root: string;
  readonly selector: string;
  /** Extra provider roots. The converter is never given any, so a case that names one forces a duplicate registration. */
  readonly extraDirectories?: readonly string[];
}

/** The production resolver's answer: the exact provider key, the manifest's package name, the sidecar keys, and the hash. */
export type ResolveOutcome =
  | {
      readonly ok: true;
      readonly key: string;
      readonly packageKey: string;
      readonly sidecars: Readonly<Record<string, string>>;
      readonly packageSha: string;
      readonly files: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

/** The production export boundary's refusal (it never succeeds here), with the directory the converter would have written into. */
export type ExportOutcome = { readonly ok: boolean; readonly reason?: string; readonly directory: string };

export interface ProducerFile {
  readonly extension: string;
  readonly bytes: Buffer;
}

export interface ProducerCase {
  readonly format?: string;
  readonly sizeX?: number;
  readonly sizeY?: number;
  readonly numSlices?: number;
  readonly numMips?: number;
  readonly pngCompressed?: boolean;
  readonly compression?: string;
  readonly srgb?: boolean;
  readonly elementCount?: number;
  readonly payload: Buffer;
  readonly name?: string;
  readonly packageKey?: string;
  readonly objectPath?: string;
  readonly packageFiles?: readonly ProducerFile[];
}

export interface ProducerOutcome {
  readonly ok: boolean;
  readonly reason?: string;
  readonly manifest?: string;
  readonly packageSha?: string;
  /** The directory the producer wrote its binary and manifest into (absent on refusal). */
  readonly directory: string;
  readonly packageFiles: readonly ProducerFile[];
}

/** A synthetic typed UTexture2D for the production reader. A part left out is absent from the texture. */
export interface TextureCase {
  readonly source?: {
    readonly format?: string;
    readonly sizeX?: number;
    readonly sizeY?: number;
    readonly numSlices?: number;
    readonly numMips?: number;
    readonly pngCompressed?: boolean;
    /**
     * The CompressionFormat field: an enum name, `null` for an absent field (UE 4.19's Source has none), or `{ integer }` for a
     * field of another property type. Omitted, it is TSCF_None.
     */
    readonly compression?: string | null | { readonly integer: number };
  };
  /** The SourceArt bulk: `payload` is the stored bytes, `elementCount` the count the header declares, `sizeOnDisk` what it reads. */
  readonly sourceArt?: { readonly payload: Buffer; readonly elementCount?: number; readonly sizeOnDisk?: number };
  readonly srgb?: boolean;
}

/** What the production reader extracted (`ok`), or refused with its own message, or threw something it does not name. */
export type TextureOutcome =
  | {
      readonly ok: true;
      readonly format: string;
      readonly sizeX: number;
      readonly sizeY: number;
      readonly numSlices: number;
      readonly numMips: number;
      readonly pngCompressed: boolean;
      /** The compression name the reader found, or null when the field is absent. */
      readonly compression: string | null;
      readonly srgb: boolean;
      readonly elementCount: number;
      /** The bytes the reader extracted, base64. */
      readonly payload: string;
      readonly width: number;
      readonly height: number;
    }
  | { readonly ok: false; readonly reason: string; readonly exception?: string };

export const PRODUCER_PACKAGE_UASSET = Buffer.from("synthetic uasset bytes for the package-set hash");
export const PRODUCER_PACKAGE_UEXP = Buffer.from("synthetic uexp bytes");

/** The converter string the producer records, as the converter's `--version` prints it. */
export const PRODUCER_CONVERTER = `threenative-cue4parse ${CUE4PARSE_SOURCE.version}`;

/** A compiled producer for one test file: `setup()` in beforeAll, `teardown()` in afterAll. */
export class Rgba16fProducer {
  private root = "";
  private harness = "";
  private sdk = "";
  private caseIndex = 0;

  async setup(): Promise<void> {
    this.sdk = await modernSdkExecutable(process.env);
    this.root = await mkdtemp(join(tmpdir(), "asset-mcp-rgba16f-producer-"));
    await mkdir(join(this.root, "tmp"), { recursive: true });
    const project = join(this.root, "project");
    await mkdir(project, { recursive: true });
    const references = PINNED_ASSEMBLIES.map((assembly) => `<Reference Include="${assembly}"><HintPath>${join(SHARP_BIN, assembly + ".dll")}</HintPath></Reference>`);
    await writeFile(
      join(project, "Producer.csproj"),
      `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework>` +
        `<ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable><UseSharedCompilation>false</UseSharedCompilation>` +
        `<NoWarn>CS8600;CS8601;CS8602;CS8603;CS8604;CS8618;CS8625;CS8632;CS1998</NoWarn></PropertyGroup>` +
        `<ItemGroup>${references.join("")}</ItemGroup></Project>`,
    );
    // Functions first, then the records: top-level statements must precede type declarations, as they do in the converter.
    const declarations = [
      extractCSharp(CUE4PARSE_PROGRAM, "static Rgba16fSourceArt ReadRgba16fSourceArt("),
      extractCSharp(CUE4PARSE_PROGRAM, "static Rgba16fDataTexture ValidateRgba16fSourceArt("),
      extractCSharp(CUE4PARSE_PROGRAM, "static string PackageSetSha256("),
      extractCSharp(CUE4PARSE_PROGRAM, "static string WriteRgba16fDataTexture("),
      extractCSharp(CUE4PARSE_PROGRAM, "static string? ExactLooseKey("),
      extractCSharp(CUE4PARSE_PROGRAM, "static Rgba16fPackage ResolveRgba16fPackage("),
      extractCSharp(CUE4PARSE_PROGRAM, "static void RequireConsumedPayloads("),
      extractCSharp(CUE4PARSE_PROGRAM, "static List<(string Extension, byte[] Bytes)> ReadRgba16fPackageFiles("),
      extractCSharp(CUE4PARSE_PROGRAM, "static void ExportRgba16fDataTexture("),
      extractCSharp(CUE4PARSE_PROGRAM, "static Exception RefuseRgba16fDataTexture("),
      extractRecord(CUE4PARSE_PROGRAM, "sealed record Rgba16fSourceArt("),
      extractRecord(CUE4PARSE_PROGRAM, "sealed record Rgba16fDataTexture("),
      extractRecord(CUE4PARSE_PROGRAM, "sealed record Rgba16fPackage("),
    ];
    // The harness reads one case as JSON, runs the validate-and-write path the converter runs, and prints the outcome.
    await writeFile(
      join(project, "Program.cs"),
      `${USINGS}
var input = JObject.Parse(File.ReadAllText(args[0]));
var outputDirectory = args[1];
// A typed case: the production reader on a synthetic UTexture2D. It prints what the reader extracted, or why it refused.
if (input["texture"] is JObject typed)
{
    try
    {
        var extracted = ReadRgba16fSourceArt(SyntheticTexture(typed));
        var validated = ValidateRgba16fSourceArt(extracted);
        Console.WriteLine(JsonConvert.SerializeObject(new
        {
            ok = true, format = extracted.Format, sizeX = extracted.SizeX, sizeY = extracted.SizeY, numSlices = extracted.NumSlices,
            numMips = extracted.NumMips, pngCompressed = extracted.PngCompressed, compression = extracted.Compression, srgb = extracted.Srgb,
            elementCount = extracted.ElementCount, payload = Convert.ToBase64String(extracted.Bytes!), width = validated.Width, height = validated.Height,
        }));
    }
    catch (InvalidDataException error)
    {
        Console.WriteLine(JsonConvert.SerializeObject(new { ok = false, reason = error.Message }));
    }
    catch (Exception error)
    {
        Console.WriteLine(JsonConvert.SerializeObject(new { ok = false, reason = error.Message, exception = error.GetType().FullName }));
    }
    return;
}
// The package mapping, run on a real provider over the loose tree the test wrote: the resolver's answer and the package-set hash it
// would write, or the refusal it gives. The export mode runs the production export boundary with a package that has no exports.
if (input["resolve"] is JObject resolve)
{
    var root = Path.GetFullPath((string)resolve["root"]!);
    var provider = LooseProvider(root, resolve);
    try
    {
        var mapping = ResolveRgba16fPackage(provider, root, (string)resolve["selector"]!);
        var files = ReadRgba16fPackageFiles(provider, mapping);
        Console.WriteLine(JsonConvert.SerializeObject(new
        {
            ok = true, key = mapping.Key, packageKey = mapping.PackageKey, sidecars = mapping.Sidecars,
            packageSha = PackageSetSha256(files), files = files.Select(file => file.Extension).ToArray(),
        }));
    }
    catch (InvalidDataException error)
    {
        Console.WriteLine(JsonConvert.SerializeObject(new { ok = false, reason = error.Message }));
    }
    return;
}
if (input["export"] is JObject export)
{
    var root = Path.GetFullPath((string)export["root"]!);
    var selector = (string)export["selector"]!;
    var provider = LooseProvider(root, export);
    try
    {
        var mapping = ResolveRgba16fPackage(provider, root, selector);
        ExportRgba16fDataTexture(new ExportlessPackage(), provider, mapping, Path.GetFullPath(args[1]), selector);
        Console.WriteLine(JsonConvert.SerializeObject(new { ok = true }));
    }
    catch (InvalidDataException error)
    {
        Console.WriteLine(JsonConvert.SerializeObject(new { ok = false, reason = error.Message }));
    }
    return;
}
try
{
    var source = new Rgba16fSourceArt(
        (string)input["format"]!,
        (int)input["sizeX"]!,
        (int)input["sizeY"]!,
        (int)input["numSlices"]!,
        (int)input["numMips"]!,
        (bool?)input["pngCompressed"] ?? false,
        (string?)input["compression"],
        (bool)input["srgb"]!,
        (long)input["elementCount"]!,
        Convert.FromBase64String((string)input["payload"]!));
    var data = ValidateRgba16fSourceArt(source);
    var files = ((JArray)input["packageFiles"]!).Select(item => (Extension: (string)item["extension"]!, Bytes: Convert.FromBase64String((string)item["base64"]!))).ToList();
    var packageSha = PackageSetSha256(files);
    var manifest = WriteRgba16fDataTexture(outputDirectory, (string)input["name"]!, (string)input["packageKey"]!, (string)input["objectPath"]!, packageSha, data, (string)input["converter"]!);
    Console.WriteLine(JsonConvert.SerializeObject(new { ok = true, manifest, packageSha }));
}
catch (InvalidDataException error)
{
    Console.WriteLine(JsonConvert.SerializeObject(new { ok = false, reason = error.Message }));
}
${SYNTHETIC_TEXTURE}
${LOOSE_PROBE}
${declarations.join("\n")}
${EXPORTLESS_PACKAGE}
`,
    );
    try {
      execFileSync(this.sdk, ["build", project, "-c", "Release", "-o", join(this.root, "bin"), "-nodeReuse:false"], {
        env: this.environment(),
        stdio: "pipe",
        timeout: 240_000,
      });
    } catch (error) {
      const output = String((error as { stdout?: Buffer }).stdout ?? "");
      throw new Error(`the extracted RGBA16F producer did not compile:\n${output.split("\n").filter((line) => line.includes(" error ")).slice(0, 10).join("\n")}`);
    }
    this.harness = join(this.root, "bin", "Producer.dll");
  }

  async teardown(): Promise<void> {
    if (this.root) await rm(this.root, { recursive: true, force: true });
  }

  /** Runs the compiled producer on one case. A refusal comes back as `ok: false` with the rule that failed. */
  async produce(input: ProducerCase): Promise<ProducerOutcome> {
    const directory = join(this.root, `case-${this.caseIndex++}`);
    await mkdir(directory, { recursive: true });
    const packageFiles = input.packageFiles ?? [
      { extension: ".uasset", bytes: PRODUCER_PACKAGE_UASSET },
      { extension: ".uexp", bytes: PRODUCER_PACKAGE_UEXP },
    ];
    const json = {
      format: input.format ?? "TSF_RGBA16F",
      sizeX: input.sizeX ?? 3,
      sizeY: input.sizeY ?? 2,
      numSlices: input.numSlices ?? 1,
      numMips: input.numMips ?? 1,
      ...(input.pngCompressed === undefined ? {} : { pngCompressed: input.pngCompressed }),
      ...(input.compression === undefined ? {} : { compression: input.compression }),
      srgb: input.srgb ?? false,
      elementCount: input.elementCount ?? input.payload.byteLength,
      payload: input.payload.toString("base64"),
      name: input.name ?? "T_Probe_PIV",
      packageKey: input.packageKey ?? "Pack/Content/Probe/T_Probe_PIV.uasset",
      objectPath: input.objectPath ?? "/Game/Probe/T_Probe_PIV.T_Probe_PIV",
      packageFiles: packageFiles.map((file) => ({ extension: file.extension, base64: file.bytes.toString("base64") })),
      converter: PRODUCER_CONVERTER,
    };
    const inputPath = join(directory, "input.json");
    await writeFile(inputPath, JSON.stringify(json));
    const output = execFileSync(this.sdk, [this.harness, inputPath, join(directory, "out")], {
      env: this.environment(),
      encoding: "utf8",
      timeout: 60_000,
    });
    const outcome = JSON.parse(output.trim().split("\n").pop() ?? "{}") as { ok: boolean; reason?: string; manifest?: string; packageSha?: string };
    return { ...outcome, ok: outcome.ok, directory: join(directory, "out"), packageFiles };
  }

  /**
   * Runs the production reader on one synthetic typed UTexture2D: the Source struct and the SourceArt bulk the test describes.
   * The reader's answer comes back as it printed it. Omitted source fields take the values a valid RGBA16F source has.
   */
  async extractTexture(input: TextureCase): Promise<TextureOutcome> {
    const directory = join(this.root, `case-${this.caseIndex++}`);
    await mkdir(directory, { recursive: true });
    const source = input.source === undefined ? undefined : {
      format: input.source.format ?? "TSF_RGBA16F",
      sizeX: input.source.sizeX ?? 3,
      sizeY: input.source.sizeY ?? 2,
      numSlices: input.source.numSlices ?? 1,
      numMips: input.source.numMips ?? 1,
      pngCompressed: input.source.pngCompressed ?? false,
      compression: input.source.compression === undefined ? "TSCF_None" : input.source.compression,
    };
    const sourceArt = input.sourceArt === undefined ? undefined : {
      payload: input.sourceArt.payload.toString("base64"),
      elementCount: input.sourceArt.elementCount ?? input.sourceArt.payload.byteLength,
      sizeOnDisk: input.sourceArt.sizeOnDisk ?? input.sourceArt.payload.byteLength,
    };
    const inputPath = join(directory, "input.json");
    await writeFile(inputPath, JSON.stringify({ texture: { source, sourceArt, srgb: input.srgb ?? false } }));
    const output = execFileSync(this.sdk, [this.harness, inputPath, join(directory, "out")], {
      env: this.environment(),
      encoding: "utf8",
      timeout: 60_000,
    });
    return JSON.parse(output.trim().split("\n").pop() ?? "{}") as TextureOutcome;
  }

  /**
   * Writes a loose source tree under this producer's temporary root, which teardown removes, and returns the tree's directory.
   * Each file holds a fake body: the resolver registers files by their paths and never parses them.
   */
  async looseTree(files: readonly string[]): Promise<string> {
    const tree = join(this.root, `tree-${this.caseIndex++}`);
    for (const file of files) {
      await mkdir(dirname(join(tree, file)), { recursive: true });
      await writeFile(join(tree, file), `fake package body of ${file}`);
    }
    return tree;
  }

  /** Whether the host tells names that differ only in case apart. Probed inside this producer's own temporary root. */
  async caseSensitive(): Promise<boolean> {
    const probe = join(this.root, "case-probe");
    await mkdir(probe, { recursive: true });
    await writeFile(join(probe, "Probe.txt"), "");
    return !(await stat(join(probe, "probe.txt")).then(() => true, () => false));
  }

  /** Runs the production resolver on a --data-texture selector, over a real provider initialized on the loose root. */
  async resolveDataTexture(input: LooseCase): Promise<ResolveOutcome> {
    return (await this.runLooseMode("resolve", input)).outcome as ResolveOutcome;
  }

  /** Runs the production export boundary on the same selector, with a package that has no exports, into a fresh directory. */
  async exportDataTexture(input: LooseCase): Promise<ExportOutcome> {
    const { outcome, directory } = await this.runLooseMode("export", input);
    return { ...(outcome as { ok: boolean; reason?: string }), directory };
  }

  private async runLooseMode(mode: "resolve" | "export", input: LooseCase): Promise<{ outcome: unknown; directory: string }> {
    const directory = join(this.root, `case-${this.caseIndex++}`);
    await mkdir(directory, { recursive: true });
    const inputPath = join(directory, "input.json");
    await writeFile(inputPath, JSON.stringify({ [mode]: input }));
    const output = execFileSync(this.sdk, [this.harness, inputPath, join(directory, "out")], {
      env: this.environment(),
      encoding: "utf8",
      timeout: 60_000,
    });
    return { outcome: JSON.parse(output.trim().split("\n").pop() ?? "{}"), directory: join(directory, "out") };
  }

  private environment(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      DOTNET_CLI_HOME: join(this.root, "home"),
      DOTNET_NOLOGO: "1",
      DOTNET_CLI_TELEMETRY_OPTOUT: "1",
      DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
      MSBUILDDISABLENODEREUSE: "1",
      NUGET_PACKAGES: join(this.root, "nuget"),
      TMPDIR: join(this.root, "tmp"),
    };
  }
}

/** Reads the binary and manifest a successful producer case wrote. */
export async function readProducedArtifacts(outcome: ProducerOutcome): Promise<{ readonly binary: Buffer; readonly manifest: unknown }> {
  const binary = await readFile(join(outcome.directory, "T_Probe_PIV.rgba16f-le"));
  const manifest = JSON.parse(await readFile(join(outcome.directory, "T_Probe_PIV.rgba16f.json"), "utf8")) as unknown;
  return { binary, manifest };
}
