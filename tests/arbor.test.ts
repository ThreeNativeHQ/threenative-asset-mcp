import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import { createArborAdapter, createVegetationGenerateHandler } from "../src/discovery/arbor.js";
import { AssetFederation } from "../src/discovery/federation.js";
import { DirectAssetDownloader } from "../src/download/direct-asset-downloader.js";

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), "arbor-test-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function gltfOf(bytes: Buffer) {
  expect(bytes.readUInt32LE(0)).toBe(0x46546c67);
  return JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString("utf8")) as {
    materials: { name: string; alphaMode?: string }[];
    meshes: { primitives: { attributes: Record<string, number> }[] }[];
  };
}

describe("arbor provider", () => {
  const federation = new AssetFederation([createArborAdapter()], new DirectAssetDownloader(), {
    toolVersion: "test",
  });

  it("asset_search returns a free, generated, user-owned row for an oak tree", async () => {
    const { results } = await federation.search({ query: "oak tree" });
    const oak = results.find((item) => item.assetId === "arbor:oak");
    expect(oak).toMatchObject({
      provider: "arbor",
      type: "3d-model",
      free: "yes",
      license: { name: "Generated, user-owned", commercialUse: "yes", attributionRequired: "no" },
      canDownloadNow: false,
    });
    expect(oak?.downloadReason).toContain("vegetation_generate");
    expect(results.every((item) => item.provider === "arbor")).toBe(true);
  });

  it("matches latin names and finds nothing for a word that names no preset", async () => {
    expect((await federation.search({ query: "quercus" })).results.map((i) => i.nativeId)).toEqual(["oak"]);
    await expect(federation.search({ query: "spaceship" })).resolves.toMatchObject({ results: [] });
  });

  it("asset_get points at vegetation_generate and grants no download plan", async () => {
    const detail = await federation.get({ assetId: "arbor:oak" });
    expect(detail.plan).toBeNull();
    expect(detail.providerDetails).toMatchObject({ tool: "vegetation_generate", arguments: { preset: "oak" } });
    await expect(federation.get({ assetId: "arbor:nope" })).rejects.toThrow();
  });

  it("vegetation_generate writes a GLB with _WIND, COLOR_0, TEXCOORD_0 and masked leaves", async () => {
    const outDir = await scratch();
    const result = await createVegetationGenerateHandler()({ preset: "oak", seed: 7, lods: [0, 2], outDir });
    expect(result).not.toHaveProperty("isError");
    const files = (result as { structuredContent: { files: { lod: number; path: string; triangles: number; sha256: string }[] } }).structuredContent.files;
    expect(files.map((file) => file.lod)).toEqual([0, 2]);
    expect(files[0]!.triangles).toBeGreaterThan(files[1]!.triangles);
    expect(await readdir(outDir)).toEqual(["oak-7-lod0.glb", "oak-7-lod2.glb"]);
    const gltf = gltfOf(await readFile(files[0]!.path));
    for (const primitive of gltf.meshes[0]!.primitives)
      expect(Object.keys(primitive.attributes)).toEqual(expect.arrayContaining(["_WIND", "COLOR_0", "TEXCOORD_0"]));
    expect(gltf.materials.find((material) => material.name === "foliage")?.alphaMode).toBe("MASK");
    // The same call again writes the same bytes.
    const again = await createVegetationGenerateHandler()({ preset: "oak", seed: 7, lods: [0], outDir });
    expect((again as { structuredContent: { files: { sha256: string }[] } }).structuredContent.files[0]!.sha256).toBe(files[0]!.sha256);
  });

  it("vegetation_generate fails closed: unknown preset, bad seed, relative outDir, missing package", async () => {
    const outDir = await scratch();
    const call = createVegetationGenerateHandler();
    const message = async (input: Parameters<typeof call>[0]) =>
      JSON.parse(((await call(input)) as { content: { text: string }[] }).content[0]!.text) as { code: string; message: string };
    expect((await message({ preset: "okay", outDir })).message).toContain("Unknown Arbor preset");
    expect((await message({ preset: "oak", seed: 1.5, outDir })).code).toBe("VEGETATION_INVALID_INPUT");
    expect((await message({ preset: "oak", outDir: "relative/dir" })).message).toContain("absolute");
    const missing = createVegetationGenerateHandler(async () => {
      throw Object.assign(new Error("x"), { code: "VEGETATION_PACKAGE_MISSING" });
    });
    const result = (await missing({ preset: "oak", outDir })) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(await readdir(outDir)).toEqual([]);
  });
});
