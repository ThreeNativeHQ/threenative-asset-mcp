import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeIO } from "@gltf-transform/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AmbientCgClient } from "../src/ambientcg/client.js";
import { createAssetAdapters } from "../src/discovery/adapters.js";
import { AssetFederation } from "../src/discovery/federation.js";
import type { AssetDetail } from "../src/discovery/types.js";
import { DirectAssetDownloader } from "../src/download/direct-asset-downloader.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function assetDetail(bytes: Uint8Array, filename = "chair.gltf"): AssetDetail {
  return {
    asset: {
      assetId: "polyhaven:chair",
      provider: "polyhaven",
      nativeId: "chair",
      sourceUrl: "https://polyhaven.com/a/chair",
      title: "Chair",
      type: "3d-model",
      itemKind: "asset",
      free: "yes",
      license: {
        name: "CC0",
        evidence: "Item CC0",
        commercialUse: "yes",
        attributionRequired: "no",
      },
      downloadStatus: "direct",
      downloadReason: "Original source",
      canDownloadNow: true,
      providerRank: 0,
      rankingFactors: [],
    },
    termsText: "Item CC0",
    selectedVariant: "original",
    selectionExplanation: "Original source",
    alternatives: [],
    files: [
      {
        id: "main",
        path: filename,
        url: `https://dl.polyhaven.org/${filename}`,
        role: "main-model",
        sizeBytes: bytes.byteLength,
        md5: createHash("md5").update(bytes).digest("hex"),
      },
    ],
  };
}

async function acquisitionFixture(
  bytes: Uint8Array,
  detail: AssetDetail,
  get: () => Promise<AssetDetail> = async () => structuredClone(detail),
  planTtlMs = 300_000,
  companions: Record<string, Uint8Array> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "asset-review-regression-"));
  roots.push(root);
  const fetchMock = vi.fn<typeof fetch>(
    async (input) => new Response(Uint8Array.from(companions[String(input)] ?? bytes)),
  );
  const federation = new AssetFederation(
    [
      {
        id: "polyhaven",
        search: async () => ({ items: [detail.asset], truncated: false }),
        get,
      },
    ],
    new DirectAssetDownloader({ downloadDir: root, fetch: fetchMock, maxDownloadBytes: 1024 }),
    {
      toolVersion: "review-regression",
      planTtlMs,
    },
  );
  return { federation, fetchMock, root };
}

describe("independent federation review regressions", () => {
  it("rejects a plan that expires during metadata revalidation before any transfer", async () => {
    let now = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const bytes = Buffer.from(JSON.stringify({ asset: { version: "2.0" } }));
    const detail = assetDetail(bytes);
    let reads = 0;
    const fixture = await acquisitionFixture(
      bytes,
      detail,
      async () => {
        if (++reads > 1) now += 101;
        return structuredClone(detail);
      },
      100,
    );
    const plan = await fixture.federation.get({ assetId: "polyhaven:chair" });
    await expect(
      fixture.federation.download({
        planToken: plan.plan!.planToken,
        acceptLicense: true,
      }),
    ).rejects.toMatchObject({ code: "ASSET_PLAN_EXPIRED" });
    expect(fixture.fetchMock).not.toHaveBeenCalled();
    expect(await readdir(fixture.root)).toEqual([]);
  });

  it("rejects a GLB with a declared embedded buffer but no BIN chunk without publication", async () => {
    let json = JSON.stringify({
      asset: { version: "2.0" },
      buffers: [{ byteLength: 4 }],
      bufferViews: [{ buffer: 0, byteLength: 4 }],
    });
    json += " ".repeat((4 - (Buffer.byteLength(json) % 4)) % 4);
    const header = Buffer.alloc(20);
    header.write("glTF");
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(20 + Buffer.byteLength(json), 8);
    header.writeUInt32LE(Buffer.byteLength(json), 12);
    header.writeUInt32LE(0x4e4f534a, 16);
    const bytes = Buffer.concat([header, Buffer.from(json)]);
    await expect(new NodeIO().setAllowNetwork(false).readBinary(bytes)).rejects.toThrow();
    const fixture = await acquisitionFixture(bytes, assetDetail(bytes, "chair.glb"));
    const plan = await fixture.federation.get({ assetId: "polyhaven:chair" });
    await expect(
      fixture.federation.download({
        planToken: plan.plan!.planToken,
        acceptLicense: true,
      }),
    ).rejects.toThrow();
    expect(await readdir(join(fixture.root, "acquisitions"))).toEqual([]);
  });

  it("returns alternatives for unavailable ambientCG 6k instead of selecting a 16k archive", async () => {
    const ambientcg = new AmbientCgClient(async () =>
      Response.json({
        assets: [
          {
            id: "Chair",
            title: "Chair",
            type: "3d-model",
            url: "https://ambientcg.com/a/Chair",
            downloads: [
              {
                attributes: "HQ-16K-PNG",
                extension: "zip",
                size: 10,
                url: "https://ambientcg.com/get?file=Chair_HQ-16K-PNG.zip",
              },
            ],
          },
        ],
        totalResults: 1,
      }),
    );
    const adapter = createAssetAdapters({ ambientcg }).find((item) => item.id === "ambientcg")!;
    const detail = await adapter.get("Chair", { resolution: "6k" }, new AbortController().signal);
    expect(detail.files).toEqual([]);
    expect(detail.asset.canDownloadNow).toBe(false);
    expect(detail.alternatives).toContain("zip/HQ-16K-PNG");
  });

  it("rejects an external glTF document with a uri-less buffer without publication", async () => {
    const bytes = Buffer.from(
      JSON.stringify({
        asset: { version: "2.0" },
        buffers: [{ byteLength: 4 }],
      }),
    );
    const fixture = await acquisitionFixture(bytes, assetDetail(bytes));
    const plan = await fixture.federation.get({ assetId: "polyhaven:chair" });
    await expect(
      fixture.federation.download({
        planToken: plan.plan!.planToken,
        acceptLicense: true,
      }),
    ).rejects.toThrow(/buffer/iu);
    expect(await readdir(join(fixture.root, "acquisitions"))).toEqual([]);
  });

  it("rejects a companion shorter than the glTF declared buffer length without publication", async () => {
    const bytes = Buffer.from(
      JSON.stringify({
        asset: { version: "2.0" },
        buffers: [{ uri: "chair.bin", byteLength: 4 }],
      }),
    );
    const binary = Buffer.from([1, 2, 3]);
    const detail = assetDetail(bytes);
    detail.files.push({
      id: "buffer",
      path: "chair.bin",
      url: "https://dl.polyhaven.org/chair.bin",
      dependencyOf: "main",
      role: "buffer",
      sizeBytes: binary.length,
      md5: createHash("md5").update(binary).digest("hex"),
    });
    const fixture = await acquisitionFixture(bytes, detail, undefined, 300_000, {
      "https://dl.polyhaven.org/chair.bin": binary,
    });
    const plan = await fixture.federation.get({ assetId: "polyhaven:chair" });
    await expect(
      fixture.federation.download({
        planToken: plan.plan!.planToken,
        acceptLicense: true,
      }),
    ).rejects.toThrow(/Incomplete glTF companion: chair.bin/u);
    expect(await readdir(join(fixture.root, "acquisitions"))).toEqual([]);
  });

  it("accepts a valid embedded BIN chunk and publishes bytes loadable offline", async () => {
    let json = JSON.stringify({
      asset: { version: "2.0" },
      buffers: [{ byteLength: 4 }],
      bufferViews: [{ buffer: 0, byteLength: 4 }],
    });
    json += " ".repeat((4 - (Buffer.byteLength(json) % 4)) % 4);
    const header = Buffer.alloc(20);
    header.write("glTF");
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(20 + Buffer.byteLength(json) + 12, 8);
    header.writeUInt32LE(Buffer.byteLength(json), 12);
    header.writeUInt32LE(0x4e4f534a, 16);
    const binaryHeader = Buffer.alloc(8);
    binaryHeader.writeUInt32LE(4, 0);
    binaryHeader.writeUInt32LE(0x004e4942, 4);
    const bytes = Buffer.concat([
      header,
      Buffer.from(json),
      binaryHeader,
      Buffer.from([1, 2, 3, 4]),
    ]);
    const fixture = await acquisitionFixture(bytes, assetDetail(bytes, "chair.glb"));
    const plan = await fixture.federation.get({ assetId: "polyhaven:chair" });
    const acquired = await fixture.federation.download({
      planToken: plan.plan!.planToken,
      acceptLicense: true,
    });
    expect(await readFile(join(acquired.directory, "chair.glb"))).toEqual(bytes);
    await expect(
      new NodeIO().setAllowNetwork(false).read(join(acquired.directory, "chair.glb")),
    ).resolves.toBeDefined();
  });

  it("replays unchanged originals after a tool upgrade while preserving and validating original provenance", async () => {
    const bytes = Buffer.from(JSON.stringify({ asset: { version: "2.0" } }));
    const detail = assetDetail(bytes);
    const fixture = await acquisitionFixture(bytes, detail);
    const plan = await fixture.federation.get({ assetId: "polyhaven:chair" });
    const acquired = await fixture.federation.download({
      planToken: plan.plan!.planToken,
      acceptLicense: true,
    });
    const nextVersion = new AssetFederation(
      [
        {
          id: "polyhaven",
          search: async () => ({ items: [detail.asset], truncated: false }),
          get: async () => structuredClone(detail),
        },
      ],
      new DirectAssetDownloader({
        downloadDir: fixture.root,
        fetch: fixture.fetchMock,
        maxDownloadBytes: 1024,
      }),
      { toolVersion: "review-next-version" },
    );
    const nextPlan = await nextVersion.get({ assetId: "polyhaven:chair" });
    const replayed = await nextVersion.download({
      planToken: nextPlan.plan!.planToken,
      acceptLicense: true,
    });
    expect(replayed.alreadyExisted).toBe(true);
    expect(replayed.receipt.toolVersion).toBe("review-regression");
    expect(replayed.receipt).toEqual(acquired.receipt);
    expect(fixture.fetchMock).toHaveBeenCalledTimes(1);
    const malformed = { ...replayed.receipt, toolVersion: 123 };
    await writeFile(replayed.receiptPath, JSON.stringify(malformed));
    await expect(
      nextVersion.download({
        planToken: nextPlan.plan!.planToken,
        acceptLicense: true,
      }),
    ).rejects.toThrow(/integrity/iu);
  });
});
