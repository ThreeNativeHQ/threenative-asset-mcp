import { CUE4PARSE_ENGINE_CONTENT, CUE4PARSE_PROGRAM } from "../../src/unreal/cue4parse-adapter.js";
import { modernSdkExecutable } from "../../src/unreal/provision.js";
import { childEnvironment, runBounded } from "../../src/unreal/toolchain.js";
import { compileProject } from "./material-overrides-harness.js";

// PRD-584 proof helper. It compiles the converter's own Program.cs, which owns the production
// EffectDump serializer, together with this harness. The harness builds synthetic typed values (a
// self cycle, a UObject field, an FPackageIndex and a 32 element array) and calls the production
// serializer, and it calls the production descriptor-path helper for both sources and a null
// reference. Nothing here mirrors production: the compiled methods are the ones the converter ships.
export const EFFECTS_DUMP_HARNESS = String.raw`using System.Globalization;
using CUE4Parse.UE4.Assets.Exports;
using CUE4Parse.UE4.Assets.Objects;
using CUE4Parse.UE4.Assets.Objects.Properties;
using CUE4Parse.UE4.Objects.UObject;
using Newtonsoft.Json;

static class EffectsDumpHarness
{
    public sealed class CyclicNode
    {
        public CyclicNode? Self;
        public FPackageIndex? Package;
        public UObject? Owner;
    }

    public sealed class DeepNode
    {
        public DeepNode? Next;
    }

    static int Main()
    {
        var result = new Dictionary<string, object?>();

        // A typed object whose public field points at itself, beside a UObject and a package reference.
        // The production serializer must not follow the object owner graph and must not recurse forever.
        var node = new CyclicNode();
        node.Self = node;
        node.Package = new FPackageIndex();
        node.Owner = new UObject();
        try
        {
            var reflected = (Dictionary<string, object?>) EffectDump.Reflect(node)!;
            result["self"] = reflected["Self"];
            result["owner"] = reflected["Owner"];
            result["package"] = reflected["Package"];
            result["cycleSize"] = JsonConvert.SerializeObject(reflected).Length;
        }
        catch (Exception error) { result["cycleError"] = error.Message; }

        // More than 16 elements must come out whole: a silent 16 item cap would drop the rest.
        var elements = new List<FPropertyTagType>();
        for (var index = 0; index < 32; index++) elements.Add(new FloatProperty(index));
        var arrayTag = new FPropertyTag { Name = new FName("Values"), PropertyType = new FName("ArrayProperty"), Tag = new ArrayProperty(new UScriptArray(elements, "FloatProperty")) };
        try
        {
            var tag = EffectDump.Tag(arrayTag);
            var value = (Dictionary<string, object?>) tag["value"]!;
            result["arrayCount"] = ((List<object?>) value["elements"]!).Count;
        }
        catch (Exception error) { result["arrayError"] = error.Message; }

        // A chain deeper than the budget must raise an explicit refusal, never a silent truncation.
        var head = new DeepNode();
        var cursor = head;
        for (var index = 0; index < EffectDump.MaxDepth + 5; index++) { cursor.Next = new DeepNode(); cursor = cursor.Next; }
        try
        {
            EffectDump.Reflect(head);
            result["deep"] = "no-error";
        }
        catch (EffectDump.Refusal refusal) { result["deep"] = refusal.Message; }
        catch (Exception error) { result["deep"] = error.GetType().Name + ": " + error.Message; }

        // PRD-584 AC-4: the compiled production descriptor-path helper. The display label must sanitize
        // exactly as the Node writer (effectDescriptorFileName), and the canonical full object path must
        // hash to the same suffix. Two packages with the same basename must differ; a case/mount variant
        // of one package must be the same file; a name that only collides after sanitization must differ;
        // a null canonical path or reference must yield no pointer. The object name and resolved path are
        // read directly; the owner graph is never walked.
        try
        {
            result["pointerCascade"] = EffectDump.EffectDescriptorPath("P fire", "/Game/A/P fire.P fire", false);
            result["pointerNiagara"] = EffectDump.EffectDescriptorPath("P fire", "/Game/A/P fire.P fire", true);
            result["pointerFolderA"] = EffectDump.EffectDescriptorPath("P_effect", "/Game/A/P_effect.P_effect", false);
            result["pointerFolderB"] = EffectDump.EffectDescriptorPath("P_effect", "/Game/B/P_effect.P_effect", false);
            result["pointerCaseVariant"] = EffectDump.EffectDescriptorPath("P_effect", "/Game/a/P_EFFECT.P_effect", false);
            result["pointerUnderscore"] = EffectDump.EffectDescriptorPath("P_fire", "/Game/A/P_fire.P_fire", false);
            result["pointerTraversal"] = EffectDump.EffectDescriptorPath("../../evil", "/Game/A/P_evil.../../evil", false);
            result["pointerEmpty"] = EffectDump.EffectDescriptorPath("", "/Game/A/P_empty.", false);
            result["pointerNull"] = EffectDump.EffectDescriptorPointer(null, "P", false);
            result["pointerNullPath"] = EffectDump.EffectDescriptorPointer("", "P", true);
        }
        catch (Exception error) { result["pointerError"] = error.Message; }

        Console.WriteLine(JsonConvert.SerializeObject(result));
        return 0;
    }
}
`;

export interface EffectsDumpHarnessRun {
  readonly build: { readonly code: number | null; readonly output: string };
  readonly result: Record<string, unknown> | undefined;
}

/**
 * Compiles the converter program and this harness against the pinned assemblies, then runs the
 * harness in an isolated temp directory. The heap is capped and the run is short, so a regression
 * to unbounded traversal fails fast instead of loading the shared host.
 */
export async function runEffectsDumpHarness(directory: string): Promise<EffectsDumpHarnessRun> {
  const build = await compileProject(
    directory,
    "EffectsDumpHarness",
    { "Program.cs": CUE4PARSE_PROGRAM, "EngineContent.cs": CUE4PARSE_ENGINE_CONTENT, "EffectsDumpHarness.cs": EFFECTS_DUMP_HARNESS },
    "EffectsDumpHarness",
  );
  if (build.code !== 0) return { build: { code: build.code, output: build.output }, result: undefined };
  const run = await runBounded(await modernSdkExecutable(process.env), [build.dll], {
    timeoutMs: 30_000,
    maxOutputBytes: 4 * 1024 * 1024,
    environment: { ...childEnvironment(process.env), DOTNET_GCHeapHardLimit: "0x40000000" },
  });
  let result: Record<string, unknown> | undefined;
  for (const line of run.stdout.split("\n")) if (line.startsWith("{")) result = JSON.parse(line) as Record<string, unknown>;
  return { build: { code: run.code, output: `${run.stdout.slice(-2000)}${run.stderr.slice(-2000)}` }, result };
}
