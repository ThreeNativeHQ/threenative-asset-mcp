import { describe, expect, it } from "vitest";

import {
  createAssetListSourcesHandler,
  createAssetSearchSourcesHandler,
} from "../src/tools/source-directory.js";

describe("unified asset source directory", () => {
  it("covers the recommended 3D, texture, animation, VFX, UI, font, audio, and shader stack", async () => {
    const result = await createAssetListSourcesHandler()({ agentReadyOnly: false });
    if ("isError" in result) throw new Error("unexpected error");

    expect(result.structuredContent.total).toBeGreaterThanOrEqual(25);
    expect(result.structuredContent.sources.map((source) => source.id)).toEqual(
      expect.arrayContaining([
        "polyhaven",
        "quaternius",
        "kaykit",
        "kenney",
        "ambientcg",
        "brackeys-vfx",
        "game-icons",
        "google-fonts",
        "sonniss",
        "tallbeard",
        "scott-buckley",
        "threejs-examples",
        "threejs-shader-materials",
        "glslify",
        "three-custom-shader-material",
        "godot-shaders",
        "unity-shader-graph-samples",
        "unity-vfx-graph-samples",
        "unreal-niagara-examples",
        "awesome-cc0",
      ]),
    );
  });

  it("tells agents the exact MCP flow when programmatic search or download exists", async () => {
    const result = await createAssetListSourcesHandler()({});
    if ("isError" in result) throw new Error("unexpected error");

    expect(result.structuredContent.sources.find((source) => source.id === "polyhaven")).toMatchObject({
      access: "mcp-api",
      searchTool: "polyhaven_search_assets",
      filesTool: "polyhaven_list_files",
      downloadSupport: "direct-url",
    });
    expect(result.structuredContent.sources.find((source) => source.id === "sonniss")).toMatchObject({
      access: "mcp-curated",
      searchTool: "audio_search_assets",
      downloadTool: "audio_download_asset",
      downloadSupport: "mcp-managed",
    });
    expect(
      result.structuredContent.sources.every(
        (source) => source.agentReady && Boolean(source.downloadTool),
      ),
    ).toBe(true);
    expect(result.structuredContent.sources.find((source) => source.id === "quaternius")).toMatchObject({
      access: "mcp-curated",
      filesTool: "asset_list_bundle_animations",
      downloadTool: "asset_download_bundle_animation",
      downloadSupport: "mcp-managed",
      agentReady: true,
    });
    expect(
      result.structuredContent.sources.find(
        (source) => source.id === "kenney-particle-pack",
      ),
    ).toMatchObject({
      downloadTool: "asset_download_file",
      downloadArgs: {
        provider: "kenney",
        fileName: "kenney_particle-pack.zip",
        acceptLicense: true,
      },
    });
  });

  it("lists Polyfork as an agent-ready low-poly model source with its licence choice", async () => {
    const result = await createAssetListSourcesHandler()({});
    if ("isError" in result) throw new Error("unexpected error");
    const polyfork = result.structuredContent.sources.find((source) => source.id === "polyfork");
    expect(polyfork).toMatchObject({
      access: "mcp-api",
      downloadSupport: "mcp-managed",
      searchTool: "polyfork_search_models",
      detailTool: "polyfork_get_model",
      filesTool: "polyfork_list_files",
      downloadTool: "asset_download",
      agentReady: true,
      licenseTags: expect.arrayContaining(["cc-by", "per-asset"]),
    });
    expect(polyfork?.categories).toEqual(expect.arrayContaining(["3d-model", "animation"]));
    expect(polyfork?.browseUrls).toContain("https://polyfork.dev/characters");
    expect(polyfork?.licenseSummary).toContain("CC BY 4.0");
    expect(polyfork?.caution).toContain("Pro");
  });

  it("searches sources by category, query, license simplicity, and access mode", async () => {
    const handler = createAssetSearchSourcesHandler();
    const shaders = await handler({
      category: "shader",
      access: "package-manager",
      agentReadyOnly: false,
    });
    const cc0Models = await handler({ query: "model", category: "3d-model", license: "cc0" });

    if ("isError" in shaders || "isError" in cc0Models) {
      throw new Error("unexpected error");
    }
    expect(shaders.structuredContent.sources.map((source) => source.id)).toEqual(
      expect.arrayContaining(["glslify", "three-custom-shader-material"]),
    );
    expect(cc0Models.structuredContent.sources.map((source) => source.id)).toEqual(
      expect.arrayContaining(["polyhaven", "quaternius", "kenney"]),
    );
  });
});
