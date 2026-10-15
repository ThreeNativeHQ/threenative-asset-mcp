import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";

import { sizeMeters } from "../src/gltf-size.js";
import { BLENDER_RELEASE, type BlenderRelease, ensureBlender } from "../src/unity/blender.js";
import { UnityImportError } from "../src/unity/errors.js";
import { UNITY_IMPORTER_VERSION, importUnityPackage } from "../src/unity/importer.js";
import { type FixtureFile, scratchDirectory, writeProjectFolder, writeUnityPackage } from "./helpers/unity-fixtures.js";
import {
  SHADERS,
  materialYaml,
  modelImporter,
  pngBytes,
  solidPng,
  textureImporter,
  writeCubeFbx,
} from "./helpers/unity-models.js";
import { describeWithTools } from "./helpers/require-tool.js";

async function fakeBlenderServer(): Promise<{ release: BlenderRelease; requests: () => number }> {
  const staging = await scratchDirectory("unity-fake-blender-");
  await mkdir(join(staging, "pack", "blender-fake"), { recursive: true });
  await writeFile(join(staging, "pack", "blender-fake", "blender"), '#!/bin/sh\necho "Blender 9.9.9"\n', { mode: 0o755 });
  const archive = join(staging, "blender.tar.xz");
  execFileSync("tar", ["-cJf", archive, "-C", join(staging, "pack"), "blender-fake"]);
  const body = await readFile(archive);
  let count = 0;
  const server: Server = createServer((_request, response) => {
    count += 1;
    response.writeHead(200, { "content-type": "application/x-xz" });
    response.end(body);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  onTestFinished(() => new Promise<void>((done) => server.close(() => done())));
  const port = (server.address() as AddressInfo).port;
  return {
    release: { version: "9.9.9", url: `http://127.0.0.1:${port}/blender.tar.xz`, sha256: createHash("sha256").update(body).digest("hex") },
    requests: () => count,
  };
}

describe("provision", () => {
  const noBlender = (cache: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    PATH: "/nonexistent",
    THREENATIVE_TOOLCHAIN_DIR: cache,
    ...extra,
  });

  it("pins an official LTS release with its SHA-256", () => {
    expect(BLENDER_RELEASE.url).toMatch(/^https:\/\/download\.blender\.org\/release\/Blender\d+\.\d+\/blender-\d+\.\d+\.\d+-linux-x64\.tar\.xz$/);
    expect(BLENDER_RELEASE.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("downloads into an empty cache, verifies the checksum, installs and then reuses it", async () => {
    const { release, requests } = await fakeBlenderServer();
    const cache = await scratchDirectory("unity-toolchain-");
    const messages: string[] = [];
    const first = await ensureBlender(noBlender(cache), (message) => messages.push(message), { release });
    expect(first).toMatchObject({ version: "9.9.9", source: "download", path: join(cache, "blender-9.9.9", "blender") });
    expect(messages.join(" ")).toMatch(/Downloading Blender 9.9.9/);
    const second = await ensureBlender(noBlender(cache), undefined, { release });
    expect(second).toMatchObject({ source: "toolchain-cache", path: first.path });
    expect(requests()).toBe(1);
    expect((await readdir(cache)).filter((name) => name.startsWith(".blender-staging"))).toEqual([]);
  });

  it("discards a download whose SHA-256 differs and installs nothing", async () => {
    const { release } = await fakeBlenderServer();
    const cache = await scratchDirectory("unity-toolchain-");
    await expect(ensureBlender(noBlender(cache), undefined, { release: { ...release, sha256: "0".repeat(64) } })).rejects.toThrow(/did not match the pinned SHA-256/);
    expect(await readdir(cache)).toEqual([]);
  });

  it("names the fix when THREENATIVE_TOOLCHAIN_AUTOINSTALL=0 forbids the download", async () => {
    const cache = await scratchDirectory("unity-toolchain-");
    const failure = await ensureBlender(noBlender(cache, { THREENATIVE_TOOLCHAIN_AUTOINSTALL: "0" })).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(UnityImportError);
    expect((failure as UnityImportError).code).toBe("UNITY_BLENDER_NOT_FOUND");
    expect((failure as Error).message).toMatch(/THREENATIVE_BLENDER/);
    expect((failure as Error).message).toMatch(/THREENATIVE_TOOLCHAIN_AUTOINSTALL=0/);
    expect(await readdir(cache)).toEqual([]);
  });

  it("rejects a THREENATIVE_BLENDER that is not an executable Blender", async () => {
    const cache = await scratchDirectory("unity-toolchain-");
    const bogus = join(cache, "not-blender");
    await writeFile(bogus, "#!/bin/sh\necho hello\n", { mode: 0o755 });
    await expect(ensureBlender(noBlender(cache, { THREENATIVE_BLENDER: bogus }))).rejects.toThrow(/does not run as Blender/);
    await expect(ensureBlender(noBlender(cache, { THREENATIVE_BLENDER: join(cache, "missing") }))).rejects.toThrow(/not an absolute path to an executable/);
  });

  // 380 MB: run it on demand (THREENATIVE_REAL_BLENDER_PROVISION=1) against a throwaway cache.
  it.skipIf(process.env.THREENATIVE_REAL_BLENDER_PROVISION !== "1")(
    "provisions the real pinned release from an empty cache",
    async () => {
      const cache = await scratchDirectory("unity-toolchain-real-");
      const tool = await ensureBlender(noBlender(cache), console.error);
      expect(tool).toMatchObject({ version: BLENDER_RELEASE.version, source: "download" });
      expect((await stat(tool.path)).isFile()).toBe(true);
    },
    900_000,
  );
});

// ---------------------------------------------------------------- conversion

let fbxDirectory = "";
let cube: Buffer;
let cubeCentimetres: Buffer;

describeWithTools(["blender"], "unity models through Blender", () => {
  beforeAll(async () => {
    fbxDirectory = await mkdtemp(join(tmpdir(), "unity-fbx-"));
    await writeCubeFbx(join(fbxDirectory, "cube.fbx"), ["Wood", "Metal", "Paint", "Glass"]);
    await writeCubeFbx(join(fbxDirectory, "cube-cm.fbx"), ["Wood"], "cm");
    cube = await readFile(join(fbxDirectory, "cube.fbx"));
    cubeCentimetres = await readFile(join(fbxDirectory, "cube-cm.fbx"));
  }, 120_000);
  afterAll(async () => {
    if (fbxDirectory) await rm(fbxDirectory, { recursive: true, force: true });
  });

  async function importProject(files: FixtureFile[], options: { maxTextureSize?: number; assets?: string[] } = {}) {
    const root = await scratchDirectory("unity-project-");
    await writeProjectFolder(root, files);
    const outputDir = join(await scratchDirectory("unity-out-"), "import");
    const report = await importUnityPackage({ source: root, outputDir, ...options });
    return { report, outputDir };
  }

  const read = async (path: string) => new NodeIO().registerExtensions(ALL_EXTENSIONS).read(path);
  const folders = (...paths: string[]): FixtureFile[] => paths.map((path) => ({ path }));

  it("applies globalScale 2 to a 1 m FBX cube: the GLB measures 2 m on every axis", async () => {
    const { report, outputDir } = await importProject([
      ...folders("Assets", "Assets/Models"),
      { path: "Assets/Models/crate.fbx", data: cube, importer: modelImporter({ globalScale: 2 }) },
    ]);
    expect(report).toMatchObject({ importerVersion: UNITY_IMPORTER_VERSION, counts: { models: 1, failed: 0 } });
    const glb = join(outputDir, report.models[0]!.glb);
    const size = (await sizeMeters(glb))!;
    for (const axis of [size.x, size.y, size.z]) expect(axis).toBeCloseTo(2, 2);
    expect(report.models[0]!.sizeMeters.x).toBeCloseTo(2, 2);
    expect(report.models[0]!.scale).toMatchObject({ globalScale: 2, useFileScale: true });
    expect(JSON.parse(await readFile(join(outputDir, "import-report.json"), "utf8")).importerVersion).toBe(UNITY_IMPORTER_VERSION);
  }, 90_000);

  it("leaves no output behind when Blender is missing, so a retry into the same directory succeeds", async () => {
    const root = await scratchDirectory("unity-project-");
    await writeProjectFolder(root, [...folders("Assets", "Assets/Models"), { path: "Assets/Models/crate.fbx", data: cube }]);
    const outputDir = join(await scratchDirectory("unity-out-"), "import");
    const missing = join(await scratchDirectory("unity-no-blender-"), "blender");
    const failure = await importUnityPackage({ source: root, outputDir, environment: { ...process.env, THREENATIVE_BLENDER: missing } }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "UNITY_BLENDER_NOT_FOUND" });
    expect(await stat(outputDir).catch(() => undefined)).toBeUndefined();
    const report = await importUnityPackage({ source: root, outputDir });
    expect(report.counts).toMatchObject({ models: 1, failed: 0 });
  }, 90_000);

  it("starts Blender with --disable-autoexec before any script runs", async () => {
    const root = await scratchDirectory("unity-project-");
    await writeProjectFolder(root, [...folders("Assets", "Assets/Models"), { path: "Assets/Models/crate.fbx", data: cube }]);
    const outputDir = join(await scratchDirectory("unity-out-"), "import");
    const bin = await scratchDirectory("unity-fake-argv-");
    const log = join(bin, "argv.txt");
    const fake = join(bin, "blender");
    await writeFile(fake, `#!/bin/sh\necho "$@" >> ${log}\nexit 1\n`, { mode: 0o755 });
    const report = await importUnityPackage({ source: root, outputDir, blender: { path: fake, version: "9.9.9", source: "PATH" } });
    expect(report.counts.failed).toBe(1);
    expect(await readFile(log, "utf8")).toMatch(/^-b --factory-startup --disable-autoexec --python-exit-code 1 --python /);
  }, 90_000);

  it("converts a .unitypackage the same way", async () => {
    const archiveDirectory = await scratchDirectory("unity-pack-");
    const archive = join(archiveDirectory, "crate.unitypackage");
    await writeUnityPackage(archive, [
      ...folders("Assets", "Assets/Models"),
      { path: "Assets/Models/crate.fbx", data: cube, importer: modelImporter({ globalScale: 0.5 }) },
    ]);
    const outputDir = join(await scratchDirectory("unity-out-"), "import");
    const report = await importUnityPackage({ source: archive, outputDir });
    expect(report.source.shape).toBe("unitypackage");
    expect((await sizeMeters(join(outputDir, report.models[0]!.glb)))!.y).toBeCloseTo(0.5, 2);
  }, 90_000);

  it("reads the file unit: a centimetre FBX is 1 m with useFileScale, and its raw units without", async () => {
    const size = async (useFileScale: boolean) => {
      const { report, outputDir } = await importProject([
        ...folders("Assets", "Assets/Models"),
        { path: "Assets/Models/crate.fbx", data: cubeCentimetres, importer: modelImporter({ useFileScale, globalScale: 1 }) },
      ]);
      expect(report.models[0]!.scale.fileUnitScale).toBe(1);
      return (await sizeMeters(join(outputDir, report.models[0]!.glb)))!.x;
    };
    expect(await size(true)).toBeCloseTo(1, 2);
    expect(await size(false)).toBeCloseTo(100, 1);
  }, 90_000);

  it("slots: binds embedded materials by externalObjects first, then by name nearest the model, and records the source", async () => {
    const mat = (name: string, rgb: [number, number, number]) =>
      materialYaml({ name, shader: SHADERS.standard, colors: { _Color: [...rgb, 1] }, floats: { _Metallic: 0.5 } });
    const { report, outputDir } = await importProject([
      ...folders("Assets", "Assets/Models", "Assets/Models/Materials", "Assets/Shared", "Assets/Far"),
      {
        path: "Assets/Models/crate.fbx",
        data: cube,
        importer: modelImporter({
          externalObjects: { Wood: "Assets/Shared/WoodAlt.mat" },
          externalObjectGuids: { Glass: "f".repeat(32) },
        }),
      },
      { path: "Assets/Shared/WoodAlt.mat", content: mat("WoodAlt", [1, 0, 0]) },
      { path: "Assets/Models/Materials/Wood.mat", content: mat("Wood", [0, 0, 1]) }, // a name match that externalObjects must beat
      { path: "Assets/Models/Materials/Metal.mat", content: mat("Metal", [0, 1, 0]) },
      { path: "Assets/Far/Metal.mat", content: mat("Metal", [0, 0, 1]) }, // farther from the model
    ]);
    const model = report.models[0]!;
    expect(model.slots).toHaveLength(4);
    expect(model.slots).toEqual(
      expect.arrayContaining([
        { embedded: "Wood", binding: "externalObjects", material: "Assets/Shared/WoodAlt.mat", status: "mapped" },
        { embedded: "Metal", binding: "name-search", material: "Assets/Models/Materials/Metal.mat", status: "mapped" },
        { embedded: "Paint", binding: "embedded", status: "embedded" },
        { embedded: "Glass", binding: "embedded", status: "embedded" },
      ]),
    );
    expect(model.warnings.join(" ")).toMatch(/externalObjects maps "Glass" to a material that is not in the package/);
    expect(report.counts.boundSlots).toBe(2);
    expect(report.materials).toBe("degraded");

    const document = await read(join(outputDir, model.glb));
    const materials = new Map(document.getRoot().listMaterials().map((material) => [material.getName(), material]));
    expect(materials.get("WoodAlt")?.getBaseColorFactor().slice(0, 3)).toEqual([1, 0, 0]);
    expect(materials.get("Metal")?.getBaseColorFactor().slice(0, 3)).toEqual([0, 1, 0]);
    expect(materials.get("Metal")?.getMetallicFactor()).toBe(0.5);
    expect(materials.has("Paint") && materials.has("Glass")).toBe(true);
    expect(report.materialAssets.map((entry) => entry.path)).toEqual(["Assets/Models/Materials/Metal.mat", "Assets/Shared/WoodAlt.mat"]);
  }, 90_000);

  it("slots: materialImportMode 0 binds nothing and says so", async () => {
    const { report } = await importProject([
      ...folders("Assets", "Assets/Models", "Assets/Models/Materials"),
      { path: "Assets/Models/crate.fbx", data: cube, importer: modelImporter({ materialImportMode: 0 }) },
      { path: "Assets/Models/Materials/Wood.mat", content: materialYaml({ name: "Wood", shader: SHADERS.standard }) },
    ]);
    expect(report.models[0]!.slots.every((slot) => slot.binding === "disabled" && slot.status === "embedded")).toBe(true);
    expect(report.counts.materials).toBe(0);
  }, 90_000);

  it("writes textures through sharp, applies maxTextureSize and reports fallbacks, unsupported features, notices and skipped models", async () => {
    const { report, outputDir } = await importProject(
      [
        ...folders("Assets", "Assets/Models", "Assets/Materials", "Assets/Textures", "Assets/Shaders"),
        {
          path: "Assets/Models/crate.fbx",
          data: cube,
          importer: modelImporter({
            externalObjects: { Wood: "Assets/Materials/wood.mat", Metal: "Assets/Materials/water.mat", Paint: "Assets/Materials/height.mat" },
          }),
        },
        { path: "Assets/Models/old.max", content: "x" },
        { path: "Assets/Textures/wood.png", data: await pngBytes(8, 8, (x, y) => [x * 30, y * 30, 90, 255]), importer: textureImporter() },
        { path: "Assets/Textures/wood_n.png", data: await solidPng(8, 8, [128, 128, 255, 255]), importer: textureImporter({ normalMap: true }) },
        { path: "Assets/Textures/height.png", data: await solidPng(4, 4, [90, 90, 90, 255]), importer: textureImporter({ convertToNormalMap: true }) },
        { path: "Assets/Shaders/water.shadergraph", content: "{}" },
        { path: "Assets/LICENSE.txt", content: "Pack licence: personal use only.\n" },
        {
          path: "Assets/Materials/wood.mat",
          content: materialYaml({ name: "wood", shader: SHADERS.standard, textures: { _MainTex: "Assets/Textures/wood.png", _BumpMap: "Assets/Textures/wood_n.png" } }),
        },
        {
          path: "Assets/Materials/water.mat",
          content: materialYaml({
            name: "water",
            shader: { guid: (await import("./helpers/unity-fixtures.js")).guidFor("Assets/Shaders/water.shadergraph"), fileID: "-1" },
            colors: { _BaseColor: [0, 0.5, 1, 1] },
          }),
        },
        {
          path: "Assets/Materials/height.mat",
          content: materialYaml({ name: "height", shader: SHADERS.standard, textures: { _BumpMap: "Assets/Textures/height.png" } }),
        },
      ],
      { maxTextureSize: 4 },
    );
    expect(report.skipped).toEqual([{ asset: "Assets/Models/old.max", reason: expect.stringMatching(/needs the authoring application/) }]);
    expect(report.licenseFiles).toMatchObject([{ path: "Assets/LICENSE.txt", bytes: 33, excerpt: "Pack licence: personal use only." }]);
    expect(report.textures.map((texture) => texture.png)).toHaveLength(2);
    for (const texture of report.textures) {
      expect(Math.max(texture.width, texture.height)).toBeLessThanOrEqual(4);
      expect((await stat(join(outputDir, texture.png))).size).toBe(texture.bytes);
    }
    const byPath = new Map(report.materialAssets.map((material) => [material.path, material]));
    expect(byPath.get("Assets/Materials/water.mat")).toMatchObject({
      status: "fallback",
      shader: { ref: expect.stringContaining("/-1"), path: "Assets/Shaders/water.shadergraph" },
      fallbackReason: expect.stringContaining("water.shadergraph"),
    });
    expect(byPath.get("Assets/Materials/height.mat")?.unsupported[0]).toMatch(/convertToNormalMap/);
    expect(byPath.get("Assets/Materials/wood.mat")).toMatchObject({ status: "mapped", pipeline: "standard", textures: ["Assets/Textures/wood.png", "Assets/Textures/wood_n.png"] });
    expect(report.counts.fallbackMaterials).toBe(1);

    const document = await read(join(outputDir, report.models[0]!.glb));
    expect(document.getRoot().listTextures().length).toBe(2); // wood colour and normal; Blender's own were dropped
    const wood = document.getRoot().listMaterials().find((material) => material.getName() === "wood")!;
    expect(wood.getBaseColorTexture()).not.toBeNull();
    expect(wood.getNormalTexture()).not.toBeNull();
  }, 90_000);

  it("only converts the models named in assets, and refuses to overwrite an import", async () => {
    const root = await scratchDirectory("unity-project-");
    await writeProjectFolder(root, [
      ...folders("Assets", "Assets/Models"),
      { path: "Assets/Models/a.fbx", data: cube },
      { path: "Assets/Models/b.fbx", data: cube },
    ]);
    const outputDir = join(await scratchDirectory("unity-out-"), "import");
    const report = await importUnityPackage({ source: root, outputDir, assets: ["b", "nothing"] });
    expect(report.models.map((model) => model.source)).toEqual(["Assets/Models/b.fbx"]);
    expect(report.warnings).toEqual(['assets entry "nothing" matched no model or prefab']);
    await expect(importUnityPackage({ source: root, outputDir })).rejects.toMatchObject({ code: "UNITY_OUTPUT_EXISTS" });
    await expect(importUnityPackage({ source: root, outputDir: join(outputDir, "x"), assets: ["zzz"] })).rejects.toMatchObject({ code: "UNITY_IMPORT_INVALID_INPUT" });
  }, 90_000);
});
