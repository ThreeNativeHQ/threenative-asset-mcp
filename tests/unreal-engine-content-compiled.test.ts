import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { describeWithTools } from "./helpers/require-tool.js";
import { CUE4PARSE_ENGINE_CONTENT } from "../src/unreal/cue4parse-adapter.js";
import { dumpMaterialGraphs, type GraphNode, type MaterialGraph } from "../src/unreal/graph-dump.js";
import { modernSdkExecutable, toolchainCacheDir } from "../src/unreal/provision.js";
import { childEnvironment, runBounded } from "../src/unreal/toolchain.js";

// Local-only proof: a licensed pack whose material functions call engine functions, and the Engine/Content root of the
// same engine version. Neither is committed. The decoy test copies one engine file into a temp directory it removes.
const PACK = process.env.THREENATIVE_ENGINE_PROOF_PACK;
const ENGINE_CONTENT = process.env.THREENATIVE_ENGINE_PROOF_CONTENT;
const HEIGHT_LERP_FILE = "Functions/Engine_MaterialFunctions02/Texturing/HeightLerp.uasset";
const HEIGHT_LERP = "/Engine/Functions/Engine_MaterialFunctions02/Texturing/HeightLerp";

// What provisioning installed, resolved directly and only for reading: the licensed tests never call a resolver that can
// install, so this suite cannot build or download into a toolchain cache.
const MODERN_BIN = join(toolchainCacheDir(process.env), "modern", "bin");
const INSTALLED_CONVERTER = join(MODERN_BIN, process.platform === "win32" ? "ThreeNativeConverter.exe" : "ThreeNativeConverter");

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tn-engine-content-compiled-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function heightLerpCalls(graphs: Map<string, MaterialGraph>): GraphNode[] {
  return [...graphs.values()].flatMap((graph) =>
    graph.nodes.filter((node) => node.class === "FunctionCall" && node.function?.startsWith(`${HEIGHT_LERP}.`)),
  );
}

/** The converter is an external process, but AUTOINSTALL=0 keeps the environment consistent with the no-install policy. */
const CONVERTER_ENVIRONMENT: NodeJS.ProcessEnv = {
  ...childEnvironment(process.env),
  THREENATIVE_TOOLCHAIN_AUTOINSTALL: "0",
};

describeWithTools(["modern-converter"], "compiled engine function lookup", () => {
  it.skipIf(!PACK || !ENGINE_CONTENT)("reads a caller's engine body from the configured content with its provenance", async () => {
    const graphs = await dumpMaterialGraphs(PACK!, {
      converterPath: INSTALLED_CONVERTER,
      environment: CONVERTER_ENVIRONMENT,
      engineContent: { dir: ENGINE_CONTENT!, version: "5.8" },
    });
    const calls = heightLerpCalls(graphs);
    expect(calls.length).toBeGreaterThan(0);
    const inlined = calls.filter((node) => node.fn?.engine);
    expect(inlined.length).toBeGreaterThan(0);
    for (const node of inlined) {
      expect(node.fn?.engine).toEqual({ version: "5.8", package: HEIGHT_LERP });
      expect(node.fn?.outputs.some(Boolean)).toBe(true);
    }
  });

  it.skipIf(!PACK || !ENGINE_CONTENT)("does not select a same-named file outside the exact package path", async () => {
    // A basename map would find this copy of HeightLerp under its file name. The exact lookup must refuse it.
    const root = await scratch();
    const decoyDir = join(root, "Content", "Functions", "Decoy");
    await mkdir(decoyDir, { recursive: true });
    await copyFile(join(ENGINE_CONTENT!, HEIGHT_LERP_FILE), join(decoyDir, "HeightLerp.uasset"));
    const graphs = await dumpMaterialGraphs(PACK!, {
      converterPath: INSTALLED_CONVERTER,
      environment: CONVERTER_ENVIRONMENT,
      engineContent: { dir: join(root, "Content"), version: "5.8" },
    });
    const calls = heightLerpCalls(graphs);
    expect(calls.length).toBeGreaterThan(0);
    for (const node of calls) {
      // A refused call keeps an empty `fn` (no outputs) and records the reason; it never takes the decoy's body.
      expect(node.fn?.engine).toBeUndefined();
      expect(node.fn?.outputs.some(Boolean) ?? false).toBe(false);
      expect(node.error).toMatch(/could not be loaded/);
    }
  });
});

// Mandatory, and independent of licensed assets: the helper is compiled against the installed CUE4Parse assembly that the
// published converter ships in modern/bin — never the cached source project — and run on real directories, real links and
// the pinned provider's own keys. The build reads that DLL, restores and writes obj/bin only under its own temp directory,
// so the suite never provisions or rebuilds in a toolchain cache. The licensed proof above is only an extra.
const DRIVER_SOURCE = fileURLToPath(new URL("./helpers/engine-content-driver/Driver.cs", import.meta.url));
const DRIVER_ASSEMBLIES = ["CUE4Parse"] as const;

/** XML-escape a value for an MSBuild attribute: an installed path can hold `&`, `<` or a quote. */
function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** An assembly Reference with an escaped HintPath into the installed converter's bin, so the build reads the published DLL. */
function assemblyReference(assembly: string): string {
  const path = join(MODERN_BIN, `${assembly}.dll`);
  return `<Reference Include="${escapeXml(assembly)}"><HintPath>${escapeXml(path)}</HintPath></Reference>`;
}

/** Everything the child needs and nothing shared: restore, obj and bin all land under the test's own temp directory. */
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

const ENGINE_BODIES = [
  "Functions/Engine_MaterialFunctions02/Texturing/HeightLerp.uasset",
  "Functions/Engine_MaterialFunctions01/ImageAdjustment/CheapContrast.uasset",
];
const HEIGHT_LERP_REF = "/Engine/Functions/Engine_MaterialFunctions02/Texturing/HeightLerp.HeightLerp";
const HEIGHT_LERP_KEY = "Content/Functions/Engine_MaterialFunctions02/Texturing/HeightLerp.uasset";
const CHEAP_CONTRAST_PACKAGE = "/Engine/Functions/Engine_MaterialFunctions01/ImageAdjustment/CheapContrast";

type DriverOp = "root" | "mount" | "lookup" | "owner";
interface DriverCase {
  readonly id: string;
  readonly op: DriverOp;
  readonly path?: string;
  readonly reference?: string;
  readonly engine?: string;
  readonly pack?: string;
  readonly owner?: "pack" | "engine" | "none";
  readonly name?: string;
}
interface DriverResult {
  readonly id: string;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string;
}

/** A real Engine/Content tree: named `Content`, so the pinned provider keys its files under `Content/`. */
async function engineTree(parent?: string): Promise<string> {
  const root = join(parent ?? (await scratch()), "Content");
  for (const relative of ENGINE_BODIES) {
    await mkdir(join(root, dirname(relative)), { recursive: true });
    await writeFile(join(root, relative), "placeholder body");
  }
  return root;
}

describeWithTools(["modern-converter"], "engine content helper, compiled against the installed CUE4Parse", () => {
  let directory = "";
  let sdk = "";
  let driverDll = "";

  beforeAll(async () => {
    // The installed SDK and assembly, never a provisioner: a missing one fails here rather than installing into a cache.
    sdk = await modernSdkExecutable(process.env);
    directory = await mkdtemp(join(tmpdir(), "tn-engine-content-driver-"));
    await mkdir(join(directory, "tmp"), { recursive: true });
    const project = join(directory, "ThreeNativeEngineContentDriver.csproj");
    await writeFile(join(directory, "EngineContent.cs"), CUE4PARSE_ENGINE_CONTENT);
    await copyFile(DRIVER_SOURCE, join(directory, "Driver.cs"));
    await writeFile(
      project,
      `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <UseSharedCompilation>false</UseSharedCompilation>
  </PropertyGroup>
  <ItemGroup>
    ${DRIVER_ASSEMBLIES.map(assemblyReference).join("")}
  </ItemGroup>
</Project>
`,
    );
    const build = await runBounded(sdk, ["build", project, "-c", "Release", "-o", join(directory, "out"), "--nologo", "-nodeReuse:false"], {
      timeoutMs: 900_000,
      maxOutputBytes: 64 * 1024 * 1024,
      environment: buildEnvironment(directory),
    });
    if (build.code !== 0) {
      throw new Error(`The engine content driver did not compile against the installed CUE4Parse assembly:\n${build.stdout.slice(-4000)}${build.stderr.slice(-4000)}`);
    }
    // Seam: a ProjectReference would build the cached source and mark CUE4Parse as a project library here; an installed
    // assembly reference is recorded as a plain reference. This fails the suite if the build ever reaches a source project.
    const deps = JSON.parse(await readFile(join(directory, "out", "ThreeNativeEngineContentDriver.deps.json"), "utf8")) as {
      libraries: Record<string, { type?: string }>;
    };
    const bound = Object.entries(deps.libraries).find(([name]) => name.startsWith("CUE4Parse/"));
    if (bound?.[1]?.type !== "reference") {
      throw new Error(`The engine content driver did not bind the installed CUE4Parse assembly (came back as ${JSON.stringify(bound?.[1]?.type)}); a project reference would rebuild the cached source.`);
    }
    driverDll = join(directory, "out", "ThreeNativeEngineContentDriver.dll");
  }, 900_000);

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  /** Runs the compiled driver on `cases` and returns each result by case id. */
  async function drive(cases: readonly DriverCase[]): Promise<Map<string, DriverResult>> {
    const work = await scratch();
    const requests = join(work, "cases.json");
    await writeFile(requests, JSON.stringify(cases));
    const run = await runBounded(sdk, [driverDll, requests], { timeoutMs: 120_000, environment: buildEnvironment(directory) });
    if (run.code !== 0) throw new Error(`engine content driver exited ${run.code}: ${run.stderr.slice(-2000)}`);
    return new Map((JSON.parse(run.stdout) as DriverResult[]).map((result) => [result.id, result]));
  }

  describe("roots and mounts", () => {
    it("refuses a linked root, with or without a trailing separator", async () => {
      const root = await engineTree();
      const link = join(await scratch(), "linked-Content");
      await symlink(root, link);
      const results = await drive([
        { id: "bare", op: "root", path: link },
        { id: "slash", op: "root", path: `${link}/` },
      ]);
      for (const id of ["bare", "slash"]) {
        expect(results.get(id)).toMatchObject({ ok: false, error: expect.stringMatching(/link/) });
      }
    });

    it("refuses a linked file under the root, and names it", async () => {
      const root = await engineTree();
      const outside = await scratch();
      await writeFile(join(outside, "Outside.uasset"), "elsewhere");
      await symlink(join(outside, "Outside.uasset"), join(root, "Functions", "Linked.uasset"));
      const results = await drive([{ id: "file", op: "root", path: root }]);
      expect(results.get("file")).toMatchObject({ ok: false, error: expect.stringContaining(join("Functions", "Linked.uasset")) });
    });

    it("refuses a linked directory under the root rather than walking into it, and names it", async () => {
      const root = await engineTree();
      const outside = await scratch();
      await writeFile(join(outside, "Body.uasset"), "elsewhere");
      await symlink(outside, join(root, "Functions", "LinkedDirectory"));
      const results = await drive([{ id: "directory", op: "root", path: root }]);
      expect(results.get("directory")).toMatchObject({ ok: false, error: expect.stringContaining(join("Functions", "LinkedDirectory")) });
    });

    it("refuses a project root, which holds a .uproject and so keys its files under the project's name", async () => {
      const root = await engineTree();
      await writeFile(join(root, "Game.uproject"), "{}");
      const results = await drive([{ id: "project", op: "root", path: root }]);
      expect(results.get("project")).toMatchObject({ ok: false, error: expect.stringMatching(/\.uproject/) });
    });

    it("keys a loose root by its own name, with or without a trailing separator, as the pinned provider does", async () => {
      const root = await engineTree();
      const results = await drive([
        { id: "bare", op: "mount", path: root },
        { id: "slash", op: "mount", path: `${root}/` },
        { id: "lookup", op: "lookup", path: `${root}/`, reference: HEIGHT_LERP_REF },
      ]);
      expect(results.get("bare")).toMatchObject({ ok: true, value: "Content/" });
      expect(results.get("slash")).toMatchObject({ ok: true, value: "Content/" });
      // The key the lookup computes is one the real provider registered for this tree.
      expect(results.get("lookup")).toMatchObject({ ok: true, value: { found: true, key: HEIGHT_LERP_KEY, present: true, objectName: "HeightLerp" } });
    });
  });

  describe("exact qualified lookup", () => {
    it("finds the one package a reference names, under its own key", async () => {
      const root = await engineTree();
      const results = await drive([{ id: "one", op: "lookup", path: root, reference: HEIGHT_LERP_REF }]);
      expect(results.get("one")).toMatchObject({ ok: true, value: { found: true, key: HEIGHT_LERP_KEY, present: true } });
    });

    it.each([
      ["an object name that is not the package's own", "/Engine/Functions/Engine_MaterialFunctions02/Texturing/HeightLerp.Other"],
      ["a reference with no object", "/Engine/Functions/Engine_MaterialFunctions02/Texturing/HeightLerp"],
      ["a trailing path after the object", `${HEIGHT_LERP_REF}/`],
      ["a reference without the leading slash", "Engine/Functions/Engine_MaterialFunctions02/Texturing/HeightLerp.HeightLerp"],
      ["a reference outside /Engine/", "/Game/Functions/Engine_MaterialFunctions02/Texturing/HeightLerp.HeightLerp"],
      ["an empty folder segment", "/Engine/Functions//Texturing/HeightLerp.HeightLerp"],
      ["an empty package name", "/Engine/Functions/Engine_MaterialFunctions02/Texturing/.HeightLerp"],
    ])("refuses %s", async (_label, reference) => {
      const root = await engineTree();
      const results = await drive([{ id: "case", op: "lookup", path: root, reference }]);
      expect(results.get("case")).toMatchObject({ ok: true, value: { found: false, present: false } });
    });

    it.each([
      ["a parent segment", "/Engine/../Engine/Functions/Engine_MaterialFunctions02/Texturing/HeightLerp.HeightLerp"],
      ["a parent segment inside the path", "/Engine/Functions/../Functions/Engine_MaterialFunctions02/Texturing/HeightLerp.HeightLerp"],
      ["a current-directory segment", "/Engine/Functions/./Engine_MaterialFunctions02/Texturing/HeightLerp.HeightLerp"],
      ["a backslash path", "/Engine/Functions\\..\\HeightLerp.HeightLerp"],
      ["a drive-style segment", "/Engine/C:/Functions/HeightLerp.HeightLerp"],
    ])("refuses traversal through %s", async (_label, reference) => {
      const root = await engineTree();
      const results = await drive([{ id: "case", op: "lookup", path: root, reference }]);
      expect(results.get("case")).toMatchObject({ ok: true, value: { found: false, present: false } });
    });

    it("does not select a decoy: a same-named body in another folder is never the body the reference names", async () => {
      const root = join(await scratch(), "Content");
      await mkdir(join(root, "Decoy", "Functions", "Engine_MaterialFunctions02", "Texturing"), { recursive: true });
      await writeFile(join(root, "Decoy", "Functions", "Engine_MaterialFunctions02", "Texturing", "HeightLerp.uasset"), "decoy");
      const results = await drive([{ id: "decoy", op: "lookup", path: root, reference: HEIGHT_LERP_REF }]);
      // The key is computed exactly, so it is absent: the decoy's file is registered but never selected.
      expect(results.get("decoy")).toMatchObject({ ok: true, value: { found: true, key: HEIGHT_LERP_KEY, present: false } });
      expect(results.get("decoy")?.value).toMatchObject({ keys: ["Content/Decoy/Functions/Engine_MaterialFunctions02/Texturing/HeightLerp.uasset"] });
    });
  });

  describe("provenance of a loaded body", () => {
    it("gives a pack-owned body no external provenance, even when its package name sits under the engine mount", async () => {
      // A pack whose own folder is named Content keys its package the same way the engine mount does.
      const pack = await engineTree();
      const engine = await engineTree();
      const results = await drive([
        { id: "pack", op: "owner", engine, pack, owner: "pack", name: "Content/Functions/Engine_MaterialFunctions01/ImageAdjustment/CheapContrast" },
      ]);
      expect(results.get("pack")).toMatchObject({ ok: true, value: null });
    });

    it("names a body the engine provider loaded by its own /Engine/ package path, reached directly or through a nested call", async () => {
      const engine = await engineTree();
      const results = await drive([
        { id: "nested", op: "owner", engine, owner: "engine", name: "Content/Functions/Engine_MaterialFunctions01/ImageAdjustment/CheapContrast" },
        { id: "trailing", op: "owner", engine: `${engine}/`, owner: "engine", name: "Content/Functions/Engine_MaterialFunctions02/Texturing/HeightLerp" },
      ]);
      expect(results.get("nested")).toMatchObject({ ok: true, value: CHEAP_CONTRAST_PACKAGE });
      expect(results.get("trailing")).toMatchObject({ ok: true, value: "/Engine/Functions/Engine_MaterialFunctions02/Texturing/HeightLerp" });
    });

    it("gives no provenance to an unowned body, or to one the engine provider did not load", async () => {
      const engine = await engineTree();
      const results = await drive([
        { id: "unowned", op: "owner", engine, owner: "none", name: "Content/Functions/Engine_MaterialFunctions01/ImageAdjustment/CheapContrast" },
        { id: "outside", op: "owner", engine, owner: "engine", name: "Other/Functions/Engine_MaterialFunctions01/ImageAdjustment/CheapContrast" },
      ]);
      expect(results.get("unowned")).toMatchObject({ ok: true, value: null });
      expect(results.get("outside")).toMatchObject({ ok: true, value: null });
    });
  });
});
