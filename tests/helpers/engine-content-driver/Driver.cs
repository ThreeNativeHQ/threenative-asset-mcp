using System.Text.Json;
using CUE4Parse.FileProvider;
using CUE4Parse.MappingsProvider;
using CUE4Parse.UE4.Assets;
using CUE4Parse.UE4.Assets.Exports;
using CUE4Parse.UE4.Objects.UObject;
using CUE4Parse.UE4.Versions;

// Drives EngineContent (EngineContent.cs, compiled beside this file against the pinned CUE4Parse source) for
// tests/unreal-engine-content-compiled.test.ts. Reads a JSON array of cases and prints one JSON result per case. A case that
// throws reports its message; it never stops the run. The providers are real; only IPackage is a stand-in, and only for the
// provenance rule, which reads nothing but a package's name and the provider that loaded it.
var cases = JsonSerializer.Deserialize<List<DriverCase>>(File.ReadAllText(args[0]), new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? [];
var results = cases.Select(Run).ToList();
Console.Write(JsonSerializer.Serialize(results, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase }));

static DriverResult Run(DriverCase c)
{
    try { return new DriverResult(c.Id, true, Execute(c), null); }
    catch (Exception error) { return new DriverResult(c.Id, false, null, error.Message); }
}

static object? Execute(DriverCase c)
{
    switch (c.Op)
    {
        case "root":
            return EngineContent.Root(c.Path!);
        case "mount":
            return EngineContent.MountPrefix(EngineContent.Root(c.Path!));
        case "lookup":
        {
            var root = EngineContent.Root(c.Path!);
            var provider = Provider(root);
            if (!EngineContent.TryExactReference(EngineContent.MountPrefix(root), c.Reference!, out var key, out var objectName))
                return new { found = false, key = (string?) null, present = false, objectName = (string?) null, keys = Array.Empty<string>() };
            return new { found = true, key, present = provider.Files.ContainsKey(key), objectName, keys = provider.Files.Keys.OrderBy(k => k, StringComparer.Ordinal).ToArray() };
        }
        case "owner":
        {
            var engineRoot = EngineContent.Root(c.Engine!);
            var engineProvider = Provider(engineRoot);
            IFileProvider? owner = c.Owner switch
            {
                "engine" => engineProvider,
                "pack" => Provider(EngineContent.Root(c.Pack!)),
                _ => null,
            };
            return EngineContent.PackagePath(new FakePackage(c.Name ?? "", owner), engineProvider, EngineContent.MountPrefix(engineRoot));
        }
        default:
            throw new ArgumentException($"unknown driver op {c.Op}");
    }
}

static DefaultFileProvider Provider(string root)
{
    var provider = new DefaultFileProvider(root, SearchOption.AllDirectories, new VersionContainer(EGame.GAME_UE5_8), StringComparer.OrdinalIgnoreCase);
    provider.Initialize();
    return provider;
}

sealed record DriverCase(string Id, string Op, string? Path = null, string? Reference = null, string? Engine = null, string? Pack = null, string? Owner = null, string? Name = null);

sealed record DriverResult(string Id, bool Ok, object? Value, string? Error);

// An IPackage that answers only what the provenance rule reads: its name and the provider that loaded it.
sealed class FakePackage(string name, IFileProvider? provider) : IPackage
{
    public string Name { get; set; } = name;
    public IFileProvider? Provider { get; } = provider;
    public TypeMappings? Mappings => null;
    public FPackageFileSummary Summary => throw new NotSupportedException();
    public FNameEntrySerialized[] NameMap => throw new NotSupportedException();
    public int ImportMapLength => 0;
    public int ExportMapLength => 0;
    public Lazy<UObject>[] ExportsLazy => [];
    public bool IsFullyLoaded => false;
    public bool CanDeserialize => false;
    public bool HasFlags(EPackageFlags flags) => false;
    public int GetExportIndex(string name, StringComparison comparisonType = StringComparison.Ordinal) => -1;
    public ResolvedObject? ResolvePackageIndex(FPackageIndex? index) => null;
}
