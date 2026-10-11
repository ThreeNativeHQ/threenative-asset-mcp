import { describe, expect, it } from "vitest";

import { ImportUnrealOutputSchema, summarize } from "../src/tools/import-unreal.js";
import type { ImportedDataTexture, ImportReport } from "../src/unreal/importer.js";

// The import tool's output carries each RGBA16F data texture beside the RGBA8 texture and stack lists, which it leaves unchanged.
// The mapping runs on a report stub with every list empty except the one under test.

const SHA = "b".repeat(64);

const dataTexture: ImportedDataTexture = {
  name: "T_Probe_PIV",
  package: "pack/content/probe/t_probe_piv.uasset",
  data: "data-textures/pack/content/probe/t_probe_piv.rgba16f-le",
  manifest: "data-textures/pack/content/probe/t_probe_piv.rgba16f.json",
  format: "RGBA16F",
  threeTexture: "DataTexture",
  width: 37,
  height: 35,
  bytes: 37 * 35 * 8,
  sha256: SHA,
  sourceSha256: "c".repeat(64),
};

function reportWith(dataTextures: readonly unknown[]): ImportReport {
  const counts = {
    packages: 1, exported: 0, textures: 0, cubemaps: 0, materialAssets: 0, audio: 0, dataAssets: 0, textureStacks: 0,
    dataTextures: dataTextures.length, fonts: 0, bitmapFonts: 0, sprites: 0, flipbooks: 0, scenes: 0, strands: 0, skipped: 0, failed: 0,
  };
  return {
    outputDir: "/unused",
    materials: "complete",
    reused: false,
    durationMs: 1,
    entitlement: {},
    counts,
    materialCoverage: { sections: 0, textured: 0, exact: 0, heuristic: 0, unsupported: 0, unresolved: 0 },
    models: [],
    textures: [],
    cubemaps: [],
    materialAssets: [],
    audio: [],
    dataAssets: [],
    textureStacks: [],
    dataTextures,
    fonts: [],
    bitmapFonts: [],
    sprites: [],
    flipbooks: [],
    scenes: [],
    strands: [],
    skipped: [],
    failed: [],
    warnings: [],
  } as unknown as ImportReport;
}

describe("import tool output for RGBA16F data textures", () => {
  it("maps each data texture beside the existing lists, and the output schema accepts it", () => {
    const summary = summarize(reportWith([dataTexture]), "/out");
    expect(summary.counts.dataTextures).toBe(1);
    expect(summary.textureStacks).toEqual([]);
    expect(summary.dataTextures).toEqual([
      {
        name: "T_Probe_PIV",
        package: "pack/content/probe/t_probe_piv.uasset",
        data: "data-textures/pack/content/probe/t_probe_piv.rgba16f-le",
        manifest: "data-textures/pack/content/probe/t_probe_piv.rgba16f.json",
        format: "RGBA16F",
        threeTexture: "DataTexture",
        width: 37,
        height: 35,
        bytes: 37 * 35 * 8,
        sha256: SHA,
        sourceSha256: "c".repeat(64),
      },
    ]);
    expect(ImportUnrealOutputSchema.safeParse(summary).success).toBe(true);
  });

  it.each([
    ["a hash that is not SHA-256", { sha256: "xyz" }],
    ["a source hash that is not SHA-256", { sourceSha256: "abc" }],
    ["an RGBA8 format", { format: "RGBA8" }],
    ["a non-DataTexture target", { threeTexture: "Data3DTexture" }],
  ] as const)("refuses %s in the output schema", (_label, change) => {
    const summary = summarize(reportWith([dataTexture]), "/out");
    const broken = { ...summary, dataTextures: [{ ...summary.dataTextures[0], ...change }] };
    expect(ImportUnrealOutputSchema.safeParse(broken).success).toBe(false);
  });

  it("reports a zero count when the report holds no data textures", () => {
    const summary = summarize(reportWith([]), "/out");
    expect(summary.counts.dataTextures).toBe(0);
    expect(summary.dataTextures).toEqual([]);
  });
});
