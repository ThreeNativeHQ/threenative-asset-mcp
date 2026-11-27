import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquire } from "../src/discovery/acquisition.js";
import type { AssetDetail } from "../src/discovery/types.js";
import { DirectAssetDownloader } from "../src/download/direct-asset-downloader.js";
import { createAssetServer } from "../src/server.js";
import {
  STUDIO_PROFILE_TOOLS,
  compactStudioPayload,
  resolveAssetMcpProfile,
} from "../src/studio-profile.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function buildGlb(document: Record<string, unknown>): Buffer {
  const jsonText = JSON.stringify(document);
  const jsonPad = (4 - (Buffer.byteLength(jsonText) % 4)) % 4;
  const jsonBuf = Buffer.from(jsonText + " ".repeat(jsonPad), "utf8");
  const binBuf = Buffer.from([1, 2, 3, 4]);
  const totalLen = 12 + 8 + jsonBuf.length + 8 + binBuf.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(totalLen, 8);
  const jsonChunkHdr = Buffer.alloc(8);
  jsonChunkHdr.writeUInt32LE(jsonBuf.length, 0);
  jsonChunkHdr.writeUInt32LE(0x4e4f534a, 4);
  const binChunkHdr = Buffer.alloc(8);
  binChunkHdr.writeUInt32LE(binBuf.length, 0);
  binChunkHdr.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonChunkHdr, jsonBuf, binChunkHdr, binBuf]);
}

const buildMeshoptGlb = (): Buffer =>
  buildGlb({
    asset: { version: "2.0" },
    extensionsUsed: ["EXT_meshopt_compression"],
    extensionsRequired: ["EXT_meshopt_compression"],
    buffers: [
      { byteLength: 4 },
      { byteLength: 256, extensions: { EXT_meshopt_compression: { fallback: true } } },
    ],
  });

function runAcquireWithBytes(root: string, assetId: string, glb: Buffer) {
  const md5 = createHash("md5").update(glb).digest("hex");
  const nativeId = assetId.replace(/^threenative:/u, "");
  const detail: AssetDetail = {
    asset: {
      assetId,
      provider: "threenative",
      nativeId,
      title: nativeId,
      sourceUrl: `https://gateway.threenative.com/assets/${nativeId}`,
      type: "3d-model",
      itemKind: "asset",
      free: "yes",
      license: {
        name: "CC0",
        url: "https://creativecommons.org/publicdomain/zero/1.0/",
        evidence: "CC0",
        commercialUse: "yes",
        attributionRequired: "no",
      },
      apiCredit: "ThreeNative",
      downloadStatus: "direct",
      downloadReason: "Direct GLB",
      canDownloadNow: true,
      providerRank: 0,
      rankingFactors: [],
    },
    termsText: "CC0",
    selectedVariant: "glb",
    selectionExplanation: "Direct GLB",
    alternatives: [],
    files: [
      {
        id: "glb",
        path: `${nativeId}.glb`,
        url: "https://gateway.threenative.com/api/assets/public/00000000-0000-4000-8000-000000000001",
        role: "model",
        sizeBytes: glb.length,
        md5,
      },
    ],
  };
  const downloader = new DirectAssetDownloader({
    downloadDir: root,
    maxDownloadBytes: 10_000_000,
    fetch: async () => new Response(new Uint8Array(glb)),
  });
  return acquire(detail, downloader, 10_000_000, "0.21.0", AbortSignal.timeout(5000));
}

describe("studio profile & meshopt acquisition", () => {
  it("resolves studio profile from CLI flag or env and keeps detailed default", () => {
    expect(resolveAssetMcpProfile(["node", "idx.js"], {})).toBe("detailed");
    expect(resolveAssetMcpProfile(["node", "idx.js", "--profile", "studio"], {})).toBe("studio");
    expect(resolveAssetMcpProfile(["node", "idx.js"], { ASSET_MCP_PROFILE: "studio" })).toBe(
      "studio",
    );
  });

  it("compacts search, polyhaven file lists, and download receipts without dropping required keys", () => {
    const search = compactStudioPayload("asset_search", {
      truncated: false,
      warnings: [],
      assets: [
        {
          assetId: "threenative:boulder",
          provider: "threenative",
          nativeId: "uuid-should-strip",
          title: "Boulder",
          sourceUrl: "https://example.com/full",
          thumbnailUrl: "https://example.com/thumb.png",
          license: { name: "CC0", url: "https://cc0", evidence: "ok", commercialUse: "yes" },
          canDownloadNow: true,
        },
      ],
    }) as { truncated?: boolean; warnings?: unknown[]; assets: Record<string, unknown>[] };
    expect(search.truncated).toBeUndefined();
    expect(search.warnings).toBeUndefined();
    expect(search.assets[0]).toEqual({
      assetId: "threenative:boulder",
      provider: "threenative",
      title: "Boulder",
      license: { name: "CC0", commercialUse: "yes" },
      canDownloadNow: true,
    });

    const dl = compactStudioPayload("asset_download", {
      assetId: "threenative:boulder",
      outputDir: "/tmp/out",
      primaryPath: "/tmp/out/boulder.glb",
      files: [{ path: "boulder.glb", bytes: 123, sha256: "abc", url: "https://x" }],
      receipt: { sha256: "huge" },
    }) as Record<string, unknown>;
    expect(dl.receipt).toBeUndefined();
    expect(dl.files).toEqual([{ path: "boulder.glb", bytes: 123 }]);
  });

  it("registers only core STUDIO_PROFILE_TOOLS when profile is studio", () => {
    const detailed = createAssetServer();
    const studio = createAssetServer({ profile: "studio" });
    const studioMap = (studio as unknown as { _registeredTools: Record<string, { outputSchema?: unknown }> })
      ._registeredTools;
    const detailedMap = (detailed as unknown as { _registeredTools: Record<string, unknown> })
      ._registeredTools;
    const studioTools = Object.keys(studioMap);
    expect(Object.keys(detailedMap).length).toBeGreaterThan(50);
    expect(studioTools.length).toBeLessThanOrEqual(STUDIO_PROFILE_TOOLS.size);
    expect(studioTools).not.toContain("asset_import_unreal");
    expect(studioTools).not.toContain("texture_project_paint");
    for (const toolName of studioTools) {
      expect(studioMap[toolName]?.outputSchema).toBeUndefined();
    }
  });

  it("accepts GLB with EXT_meshopt_compression fallback buffer lacking uri", async () => {
    const root = await mkdtemp(join(tmpdir(), "asset-meshopt-"));
    tempDirs.push(root);
    const glb = buildMeshoptGlb();
    const md5 = createHash("md5").update(glb).digest("hex");
    const detail: AssetDetail = {
      asset: {
        assetId: "threenative:stylized-boulder-desert",
        provider: "threenative",
        nativeId: "stylized-boulder-desert",
        title: "Desert Boulder",
        sourceUrl: "https://gateway.threenative.com/assets/stylized-boulder-desert",
        type: "3d-model",
        itemKind: "asset",
        free: "yes",
        license: {
          name: "CC0",
          url: "https://creativecommons.org/publicdomain/zero/1.0/",
          evidence: "CC0",
          commercialUse: "yes",
          attributionRequired: "no",
        },
        apiCredit: "ThreeNative",
        downloadStatus: "direct",
        downloadReason: "Direct GLB",
        canDownloadNow: true,
        providerRank: 0,
        rankingFactors: [],
      },
      termsText: "CC0",
      selectedVariant: "glb",
      selectionExplanation: "Direct GLB",
      alternatives: [],
      files: [
        {
          id: "glb",
          path: "boulder.glb",
          url: "https://gateway.threenative.com/api/assets/public/00000000-0000-4000-8000-000000000001",
          role: "model",
          sizeBytes: glb.length,
          md5,
        },
      ],
    };
    const downloader = new DirectAssetDownloader({
      downloadDir: root,
      maxDownloadBytes: 10_000_000,
      fetch: async () => new Response(new Uint8Array(glb)),
    });
    const acquired = await acquire(
      detail,
      downloader,
      10_000_000,
      "0.21.0",
      AbortSignal.timeout(5000),
    );
    expect(acquired.files).toHaveLength(1);
    expect(acquired.receipt.assetId).toBe("threenative:stylized-boulder-desert");
  });

  it("accepts self-contained EXT_texture_webp GLB and rejects unknown required extensions", async () => {
    const root = await mkdtemp(join(tmpdir(), "tn-webp-"));
    tempDirs.push(root);
    const webpGlb = buildGlb({
      asset: { version: "2.0" },
      extensionsUsed: ["EXT_texture_webp"],
      extensionsRequired: ["EXT_texture_webp"],
      buffers: [{ byteLength: 4 }],
    });
    const acquired = await runAcquireWithBytes(root, "threenative:agave-webp", webpGlb);
    expect(acquired.files).toHaveLength(1);
    expect(acquired.receipt.assetId).toBe("threenative:agave-webp");

    const unknownGlb = buildGlb({
      asset: { version: "2.0" },
      extensionsUsed: ["EXT_unknown_external"],
      extensionsRequired: ["EXT_unknown_external"],
      buffers: [{ byteLength: 4 }],
    });
    await expect(runAcquireWithBytes(root, "threenative:unknown-ext", unknownGlb)).rejects.toThrow(
      "Unsupported glTF required extension: EXT_unknown_external.",
    );
  });
});
