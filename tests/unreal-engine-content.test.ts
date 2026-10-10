import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  ENGINE_CONTENT_DIR_ENV,
  ENGINE_CONTENT_VERSION_ENV,
  assertEngineContentDirectory,
  engineContentFromEnvironment,
  engineVersionOf,
} from "../src/unreal/engine-content.js";
import { dumpMaterialGraphs, materialGraphSchema } from "../src/unreal/graph-dump.js";
import { engineContentIdentity, importUnrealDirectory, type ImportReport } from "../src/unreal/importer.js";
import { bakeGraph, type GraphParameters } from "../src/unreal/material-graph.js";
import { writeFakeUmodel, writeMeshFixture, writePng } from "./helpers/unreal-fixture.js";

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tn-engine-content-test-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** An Engine/Content root with one engine body, as a real directory tree (no links). */
async function engineRoot(): Promise<string> {
  const root = await scratch();
  await mkdir(join(root, "Functions", "Engine_MaterialFunctions02", "Texturing"), { recursive: true });
  await writeFile(join(root, "Functions", "Engine_MaterialFunctions02", "Texturing", "HeightLerp.uasset"), "body v1");
  return root;
}

async function fakeConverter(dir: string, body: string): Promise<string> {
  const path = join(dir, "fake-converter.mjs");
  await writeFile(path, `#!/usr/bin/env node\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

const ENGINE_HEIGHT_LERP = "/Engine/Functions/Engine_MaterialFunctions02/Texturing/HeightLerp";

/** A caller graph whose function call is inlined from engine content at `version`. */
function engineCallGraph(provenance: unknown = { version: "5.8", package: ENGINE_HEIGHT_LERP }): Record<string, unknown> {
  return {
    format: 1,
    material: "M_Caller",
    package: "/Game/Pack/M_Caller",
    truncated: false,
    nodeCount: 2,
    outputs: {
      baseColor: { node: "call", output: 0, mask: null },
      roughness: null,
      metallic: null,
      emissive: null,
      opacity: null,
      opacityMask: null,
      normal: null,
      materialAttributes: null,
    },
    nodes: [
      {
        id: "call",
        class: "FunctionCall",
        function: `${ENGINE_HEIGHT_LERP}.HeightLerp`,
        inputs: {},
        constants: {},
        fn: { inputs: {}, outputs: ["body"], output: "body", outputNames: ["Result"], engine: provenance },
      },
      { id: "body", class: "Constant", inputs: {}, constants: { Value: 0.5 } },
    ],
  };
}

describe("engine content configuration", () => {
  it("is absent when neither variable is set, so the default import reads nothing new", () => {
    expect(engineContentFromEnvironment({})).toBeUndefined();
    expect(engineContentFromEnvironment({ [ENGINE_CONTENT_DIR_ENV]: "  ", [ENGINE_CONTENT_VERSION_ENV]: "" })).toBeUndefined();
  });

  it("reads an absolute directory with an explicit X.Y version", () => {
    expect(
      engineContentFromEnvironment({ [ENGINE_CONTENT_DIR_ENV]: "/opt/ue/Engine/Content", [ENGINE_CONTENT_VERSION_ENV]: "5.8" }),
    ).toEqual({ dir: "/opt/ue/Engine/Content", version: "5.8" });
  });

  it("refuses a directory without its version, and a version without a directory", () => {
    expect(() => engineContentFromEnvironment({ [ENGINE_CONTENT_DIR_ENV]: "/opt/ue/Engine/Content" })).toThrow(/set together/);
    expect(() => engineContentFromEnvironment({ [ENGINE_CONTENT_VERSION_ENV]: "5.8" })).toThrow(/set together/);
  });

  it("refuses a relative directory and any version that is not X.Y, and never guesses one", () => {
    const withDir = (dir: string, version: string) => ({ [ENGINE_CONTENT_DIR_ENV]: dir, [ENGINE_CONTENT_VERSION_ENV]: version });
    expect(() => engineContentFromEnvironment(withDir("Engine/Content", "5.8"))).toThrow(/absolute path/);
    for (const version of ["5", "UE_5.8", "5.8.3", "latest"]) {
      expect(() => engineContentFromEnvironment(withDir("/opt/ue/Engine/Content", version))).toThrow(/must be X\.Y/);
    }
  });

  it("reads an importer engine label or a bare version as X.Y", () => {
    expect(engineVersionOf("UE_5.8")).toBe("5.8");
    expect(engineVersionOf("4.27")).toBe("4.27");
    expect(engineVersionOf("junk")).toBeUndefined();
    expect(engineVersionOf(undefined)).toBeUndefined();
  });
});

describe("--engine-content argv threading", () => {
  it("passes the content root and version to the converter after the other options", async () => {
    const dir = await scratch();
    const argvLog = join(dir, "argv.json");
    const converter = await fakeConverter(
      dir,
      `import { writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(argv));`,
    );
    await dumpMaterialGraphs("/some/pack", {
      converterPath: converter,
      engine: "5.8",
      filter: "M_Caller",
      engineContent: { dir: "/opt/ue/Engine/Content", version: "5.8" },
    });
    const argv = JSON.parse(await readFile(argvLog, "utf8")) as string[];
    expect(argv.slice(3)).toEqual([
      "--engine", "5.8", "--filter", "M_Caller", "--engine-content", "/opt/ue/Engine/Content", "--engine-content-version", "5.8",
    ]);
  });

  it("adds no engine-content argument when none is configured", async () => {
    const dir = await scratch();
    const argvLog = join(dir, "argv.json");
    const converter = await fakeConverter(
      dir,
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));`,
    );
    await dumpMaterialGraphs("/some/pack", { converterPath: converter, engine: "4.18" });
    const argv = JSON.parse(await readFile(argvLog, "utf8")) as string[];
    expect(argv).not.toContain("--engine-content");
    expect(argv).not.toContain("--engine-content-version");
  });
});

describe("engine function provenance on a function body", () => {
  it("accepts fn.engine {version, package} on an inlined engine body", () => {
    expect(materialGraphSchema.safeParse(engineCallGraph()).success).toBe(true);
  });

  it("is strict: a provenance field the importer does not know is rejected", () => {
    expect(materialGraphSchema.safeParse(engineCallGraph({ version: "5.8", package: ENGINE_HEIGHT_LERP, file: "x" })).success).toBe(false);
    expect(materialGraphSchema.safeParse(engineCallGraph({ version: "5.8" })).success).toBe(false);
  });

  it("leaves a pack-local body without provenance valid, so the default graph shape is unchanged", () => {
    const local = engineCallGraph();
    const body = (local.nodes as Record<string, unknown>[])[0]!.fn as Record<string, unknown>;
    delete body.engine;
    expect(materialGraphSchema.safeParse(local).success).toBe(true);
  });
});

const NO_PARAMETERS: GraphParameters = { textures: new Map(), vectors: new Map(), scalars: new Map(), switches: new Map() };

/** A caller whose function call is inlined from `provenance` (absent for a pack-local body): its body is a constant. */
function bodyGraph(provenance?: { version: string; package: string }) {
  return materialGraphSchema.parse({
    format: 1,
    material: "M_Caller",
    package: "/Game/Pack/M_Caller",
    truncated: false,
    nodeCount: 2,
    outputs: {
      baseColor: { node: "call", output: 0, mask: null },
      roughness: null,
      metallic: null,
      emissive: null,
      opacity: null,
      opacityMask: null,
      normal: null,
      materialAttributes: null,
    },
    nodes: [
      {
        id: "call",
        class: "FunctionCall",
        function: `${ENGINE_HEIGHT_LERP}.HeightLerp`,
        inputs: {},
        constants: {},
        fn: { inputs: {}, outputs: ["body"], output: "body", outputNames: ["Result"], ...(provenance ? { engine: provenance } : {}) },
      },
      { id: "body", class: "Constant", inputs: {}, constants: { R: 0.5 } },
    ],
  });
}

describe("engine body approximation", () => {
  const loadTexture = async (): Promise<never> => {
    throw new Error("this graph samples no texture");
  };
  const provenance = { version: "5.8", package: ENGINE_HEIGHT_LERP };

  it("is exact when the pack was cooked for the engine content's own version", async () => {
    const result = await bakeGraph({ graph: bodyGraph(provenance), output: "baseColor", parameters: NO_PARAMETERS, loadTexture, size: 4, packEngine: "5.8" });
    expect(result.status).toBe("baked");
    expect(result).toMatchObject({ confidence: "exact", approximations: [] });
  });

  it("names the function and both versions when the pack was cooked for another version", async () => {
    const result = await bakeGraph({ graph: bodyGraph(provenance), output: "baseColor", parameters: NO_PARAMETERS, loadTexture, size: 4, packEngine: "4.27" });
    expect(result.status).toBe("baked");
    expect(result).toMatchObject({ confidence: "heuristic" });
    expect((result as { approximations: string[] }).approximations).toEqual([
      `HeightLerp read from engine content 5.8 (${ENGINE_HEIGHT_LERP}); the pack is 4.27`,
    ]);
  });

  it("names the unknown pack version rather than guessing one", async () => {
    const result = await bakeGraph({ graph: bodyGraph(provenance), output: "baseColor", parameters: NO_PARAMETERS, loadTexture, size: 4 });
    expect(result).toMatchObject({ confidence: "heuristic" });
    expect((result as { approximations: string[] }).approximations).toEqual([
      `HeightLerp read from engine content 5.8 (${ENGINE_HEIGHT_LERP}); the pack's Unreal version is unknown`,
    ]);
  });

  it("adds nothing for a pack-local body, which keeps its existing behaviour", async () => {
    const result = await bakeGraph({ graph: bodyGraph(), output: "baseColor", parameters: NO_PARAMETERS, loadTexture, size: 4, packEngine: "4.27" });
    expect(result).toMatchObject({ confidence: "exact", approximations: [] });
  });
});

describe("engine content identity in the import cache key", () => {
  it("changes when an engine body in the root is mutated", async () => {
    const root = await engineRoot();
    const before = await engineContentIdentity({ dir: root, version: "5.8" });
    await writeFile(join(root, "Functions", "Engine_MaterialFunctions02", "Texturing", "HeightLerp.uasset"), "body v2");
    const after = await engineContentIdentity({ dir: root, version: "5.8" });
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it("changes when an engine body is added under the root", async () => {
    const root = await engineRoot();
    const before = await engineContentIdentity({ dir: root, version: "5.8" });
    await mkdir(join(root, "Functions", "Engine_MaterialFunctions01"), { recursive: true });
    await writeFile(join(root, "Functions", "Engine_MaterialFunctions01", "CheapContrast.uasset"), "closure");
    const after = await engineContentIdentity({ dir: root, version: "5.8" });
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it("changes with the Unreal version and with the root path, and is stable for identical input", async () => {
    const root = await engineRoot();
    const first = await engineContentIdentity({ dir: root, version: "5.8" });
    expect(await engineContentIdentity({ dir: root, version: "5.8" })).toEqual(first);
    expect(await engineContentIdentity({ dir: root, version: "5.7" })).toMatchObject({ fingerprint: first.fingerprint, version: "5.7" });
    const moved = await scratch();
    await mkdir(join(moved, "Functions", "Engine_MaterialFunctions02", "Texturing"), { recursive: true });
    await writeFile(join(moved, "Functions", "Engine_MaterialFunctions02", "Texturing", "HeightLerp.uasset"), "body v1");
    expect(await engineContentIdentity({ dir: moved, version: "5.8" })).toMatchObject({ root: moved, version: "5.8" });
    expect((await engineContentIdentity({ dir: moved, version: "5.8" })).root).not.toBe(first.root);
  });

  it("refuses a configured root that is not a directory", async () => {
    const root = await engineRoot();
    await expect(engineContentIdentity({ dir: join(root, "missing"), version: "5.8" })).rejects.toThrow(/not a readable directory/);
  });
});

describe("linked engine content is refused, never skipped", () => {
  it("refuses a linked root, with or without a trailing separator", async () => {
    const root = await engineRoot();
    const link = join(await scratch(), "linked");
    await symlink(root, link);
    await expect(assertEngineContentDirectory({ dir: link, version: "5.8" })).rejects.toThrow(/is a symbolic link/);
    await expect(assertEngineContentDirectory({ dir: `${link}/`, version: "5.8" })).rejects.toThrow(/is a symbolic link/);
    await expect(engineContentIdentity({ dir: `${link}/`, version: "5.8" })).rejects.toThrow(/is a symbolic link/);
  });

  it("refuses a linked file under the root and names it, for the identity as well", async () => {
    const root = await engineRoot();
    const outside = await scratch();
    await writeFile(join(outside, "Outside.uasset"), "elsewhere");
    await symlink(join(outside, "Outside.uasset"), join(root, "Functions", "Engine_MaterialFunctions02", "Linked.uasset"));
    await expect(assertEngineContentDirectory({ dir: root, version: "5.8" })).rejects.toThrow(/symbolic link at ".*Linked\.uasset"/);
    await expect(engineContentIdentity({ dir: root, version: "5.8" })).rejects.toThrow(/symbolic link at ".*Linked\.uasset"/);
  });

  it("refuses a linked directory under the root rather than walking into it", async () => {
    const root = await engineRoot();
    const outside = await scratch();
    await writeFile(join(outside, "Body.uasset"), "elsewhere");
    await symlink(outside, join(root, "Functions", "Linked"));
    await expect(assertEngineContentDirectory({ dir: root, version: "5.8" })).rejects.toThrow(/symbolic link at ".*Linked"/);
  });

  it("accepts a plain tree given with a trailing separator", async () => {
    const root = await engineRoot();
    await expect(assertEngineContentDirectory({ dir: `${root}/`, version: "5.8" })).resolves.toBeUndefined();
  });
});

/**
 * A one-mesh pack whose import completes with fake tools, so the report carries the cache key the importer itself
 * computed. The engine root is a real tree with one body; the tests link or mutate it.
 */
async function importFixture(): Promise<{ sourceDir: string; fixture: string; tool: string; root: string; engine: string }> {
  const root = await scratch();
  const sourceDir = join(root, "source");
  const fixture = join(root, "fixture");
  await mkdir(join(sourceDir, "Content", "Meshes"), { recursive: true });
  await writeFile(join(sourceDir, "Content", "Meshes", "SM_Car.uasset"), Buffer.alloc(16));
  await writeMeshFixture(fixture, { name: "SM_Car", materialName: "M_Car", mat: "Diffuse=Albedo", props: "", textures: ["Albedo"] });
  await writePng(join(fixture, "Albedo.png"), [120, 110, 100, 255]);
  const tool = join(root, "umodel");
  await writeFakeUmodel(tool, { exportFrom: fixture, classes: { SM_Car: ["StaticMesh"] } });
  return { sourceDir, fixture, tool, root, engine: await engineRoot() };
}

function importEnvironment(root: string, engine?: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "",
    XDG_CACHE_HOME: join(root, "xdg-cache"),
    ...(engine ? { [ENGINE_CONTENT_DIR_ENV]: engine, [ENGINE_CONTENT_VERSION_ENV]: "5.8" } : {}),
  };
}

function runImport(pack: Awaited<ReturnType<typeof importFixture>>, outputDir: string, environment: NodeJS.ProcessEnv, graphBake?: boolean): Promise<ImportReport> {
  return importUnrealDirectory({
    sourceDir: pack.sourceDir,
    outputDir,
    concurrency: 1,
    freeSpaceBytes: 30_000_000_000,
    environment,
    umodel: { name: "umodel", path: pack.tool, version: "fixture" },
    ...(graphBake === false ? { graphBake: false } : {}),
  });
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

describe("importer cache: linked engine content never reaches an import", () => {
  it("refuses a linked engine file before the import writes anything", async () => {
    const pack = await importFixture();
    const outside = join(pack.root, "outside.uasset");
    await writeFile(outside, "elsewhere");
    await symlink(outside, join(pack.engine, "Functions", "Linked.uasset"));
    const outputDir = join(pack.root, "out");
    await expect(runImport(pack, outputDir, importEnvironment(pack.root, pack.engine))).rejects.toThrow(/symbolic link at ".*Linked\.uasset"/);
    expect(await exists(outputDir)).toBe(false);
  });

  it("refuses a linked engine root, given with a trailing separator", async () => {
    const pack = await importFixture();
    const link = join(pack.root, "engine-link");
    await symlink(pack.engine, link);
    const outputDir = join(pack.root, "out");
    await expect(runImport(pack, outputDir, importEnvironment(pack.root, `${link}/`))).rejects.toThrow(/is a symbolic link/);
    expect(await exists(outputDir)).toBe(false);
  });

  it("reuses an import only while the engine content is unchanged, and refuses the stale one after a change", async () => {
    const pack = await importFixture();
    const environment = importEnvironment(pack.root, pack.engine);
    const outputDir = join(pack.root, "out");
    const first = await runImport(pack, outputDir, environment);
    expect(first.reused).toBe(false);
    const again = await runImport(pack, outputDir, environment);
    expect(again.reused).toBe(true);
    expect(again.cacheKey).toBe(first.cacheKey);
    await writeFile(join(pack.engine, "Functions", "Engine_MaterialFunctions02", "Texturing", "HeightLerp.uasset"), "body v2");
    await expect(runImport(pack, outputDir, environment)).rejects.toThrow(/already holds a different import/);
  });

  it("ignores engine configuration entirely when graphBake is false, so a linked root cannot fail that import", async () => {
    const pack = await importFixture();
    const outputDir = join(pack.root, "out");
    const bare = await runImport(pack, outputDir, importEnvironment(pack.root), false);
    const link = join(pack.root, "engine-link");
    await symlink(pack.engine, link);
    const withLink = await runImport(pack, outputDir, { ...importEnvironment(pack.root, link), [ENGINE_CONTENT_VERSION_ENV]: "" }, false);
    expect(withLink.reused).toBe(true);
    expect(withLink.cacheKey).toBe(bare.cacheKey);
  });
});

describe("nested engine bodies", () => {
  const CHEAP_CONTRAST = "/Engine/Functions/Engine_MaterialFunctions01/ImageAdjustment/CheapContrast";

  it("keeps each nested engine body's own provenance, so each one is named", async () => {
    const graph = materialGraphSchema.parse({
      format: 1,
      material: "M_Nested",
      package: "/Game/Pack/M_Nested",
      truncated: false,
      nodeCount: 3,
      outputs: {
        baseColor: { node: "call", output: 0, mask: null },
        roughness: null,
        metallic: null,
        emissive: null,
        opacity: null,
        opacityMask: null,
        normal: null,
        materialAttributes: null,
      },
      nodes: [
        {
          id: "call",
          class: "FunctionCall",
          function: `${ENGINE_HEIGHT_LERP}.HeightLerp`,
          inputs: {},
          constants: {},
          fn: { inputs: {}, outputs: ["inner"], output: "inner", engine: { version: "5.8", package: ENGINE_HEIGHT_LERP } },
        },
        {
          id: "inner",
          class: "FunctionCall",
          function: `${CHEAP_CONTRAST}.CheapContrast`,
          inputs: {},
          constants: {},
          fn: { inputs: {}, outputs: ["body"], output: "body", engine: { version: "5.8", package: CHEAP_CONTRAST } },
        },
        { id: "body", class: "Constant", inputs: {}, constants: { R: 0.5 } },
      ],
    });
    const result = await bakeGraph({
      graph,
      output: "baseColor",
      parameters: NO_PARAMETERS,
      loadTexture: async (): Promise<never> => {
        throw new Error("this graph samples no texture");
      },
      size: 4,
      packEngine: "4.27",
    });
    expect(result).toMatchObject({ status: "baked", confidence: "heuristic" });
    expect((result as { approximations: string[] }).approximations.sort()).toEqual([
      `CheapContrast read from engine content 5.8 (${CHEAP_CONTRAST}); the pack is 4.27`,
      `HeightLerp read from engine content 5.8 (${ENGINE_HEIGHT_LERP}); the pack is 4.27`,
    ]);
  });
});
