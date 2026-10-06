import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DirectAssetDownloader } from "../src/download/direct-asset-downloader.js";
import { AssetFederation } from "../src/discovery/federation.js";
import type { Asset, AssetAdapter, AssetDetail } from "../src/discovery/types.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const md5 = (body: string) => createHash("md5").update(body).digest("hex");
function asset(provider = "polyhaven", nativeId = "chair"): Asset {
  return {
    assetId: `${provider}:${nativeId}`,
    provider,
    nativeId,
    title: "Wooden chair",
    sourceUrl: `https://polyhaven.com/a/${nativeId}`,
    type: "3d-model",
    itemKind: "asset",
    free: "yes",
    license: {
      name: "CC0",
      url: "https://creativecommons.org/publicdomain/zero/1.0/",
      evidence: "CC0 public-domain item",
      commercialUse: "yes",
      attributionRequired: "no",
    },
    apiCredit: "Powered by Poly Haven",
    downloadStatus: "direct",
    downloadReason: "Verified complete variant",
    canDownloadNow: true,
    providerRank: 0,
    rankingFactors: [],
  };
}
function detail(): AssetDetail {
  const body = JSON.stringify({
    asset: { version: "2.0" },
    buffers: [{ uri: "mesh.bin", byteLength: 3 }],
    images: [{ uri: "textures/color.png" }],
  });
  return {
    asset: asset(),
    termsText: "CC0 public-domain item",
    selectedVariant: "gltf/2k",
    selectionExplanation: "Complete glTF",
    alternatives: ["gltf"],
    files: [
      {
        id: "main",
        path: "chair.gltf",
        url: "https://dl.polyhaven.org/chair.gltf",
        role: "model",
        sizeBytes: Buffer.byteLength(body),
        md5: md5(body),
      },
      {
        id: "mesh",
        path: "mesh.bin",
        url: "https://dl.polyhaven.org/mesh.bin",
        role: "buffer",
        dependencyOf: "main",
        sizeBytes: 3,
        md5: md5("abc"),
      },
      {
        id: "color",
        path: "textures/color.png",
        url: "https://dl.polyhaven.org/color.png",
        role: "texture",
        dependencyOf: "main",
        sizeBytes: 3,
        md5: md5("png"),
      },
    ],
  };
}
function adapter(id = "polyhaven", value = detail()): AssetAdapter {
  return {
    id,
    search: async () => ({ items: [value.asset], truncated: false }),
    get: async () => structuredClone(value),
  };
}
async function fixture(
  adapters = [adapter()],
  options: {
    providerTimeoutMs?: number;
    searchTimeoutMs?: number;
    concurrency?: number;
    planTtlMs?: number;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "asset-federation-"));
  roots.push(root);
  const gltf = JSON.stringify({
    asset: { version: "2.0" },
    buffers: [{ uri: "mesh.bin", byteLength: 3 }],
    images: [{ uri: "textures/color.png" }],
  });
  const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
    const path = new URL(String(url)).pathname;
    return new Response(path.endsWith(".gltf") ? gltf : path.endsWith(".bin") ? "abc" : "png");
  });
  return {
    root,
    fetch,
    federation: new AssetFederation(
      adapters,
      new DirectAssetDownloader({ downloadDir: root, fetch, maxDownloadBytes: 1024 }),
      { ...options, toolVersion: "test" },
    ),
  };
}

describe("bounded asset federation", () => {
  it("deduplicates identity, preserves same-title different assets and deterministic ranking", async () => {
    const a = adapter();
    a.search = async () => ({
      items: [asset(), asset(), asset("polyhaven", "other")],
      truncated: true,
    });
    const b = adapter("ambientcg");
    b.search = async () => ({ items: [asset("ambientcg")], truncated: false });
    const f = await fixture([b, a]);
    const first = await f.federation.search({
      query: "chair",
      providers: ["polyhaven", "ambientcg"],
    });
    const second = await f.federation.search({
      query: "chair",
      providers: ["ambientcg", "polyhaven"],
    });
    expect(first.results.map((item) => item.assetId)).toEqual(
      second.results.map((item) => item.assetId),
    );
    expect(first.results).toHaveLength(3);
    expect(first.providers.find((item) => item.provider === "polyhaven")?.truncated).toBe(true);
    expect(await readdir(f.root)).toEqual([]);
  });

  it("fails closed on unknown free/license and excludes authenticated-only acquisition", async () => {
    const a = adapter();
    a.search = async () => ({
      items: [
        asset(),
        {
          ...asset("polyhaven", "unknown"),
          free: "unknown",
          license: { ...asset().license, commercialUse: "unknown" },
        },
        { ...asset("polyhaven", "auth"), canDownloadNow: false, downloadStatus: "auth-required" },
      ],
      truncated: false,
    });
    const f = await fixture([a]);
    expect(
      (
        await f.federation.search({
          query: "chair",
          freeOnly: true,
          commercialUse: true,
          downloadableOnly: true,
        })
      ).results.map((item) => item.nativeId),
    ).toEqual(["chair"]);
  });

  it("aborts actual provider operations and retains successes with bounded safe reports", async () => {
    let aborted = false;
    const slow = adapter("ambientcg");
    slow.search = async (_q, _t, _l, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(signal.reason);
          },
          { once: true },
        );
      });
    const f = await fixture([adapter(), slow], {
      providerTimeoutMs: 20,
      searchTimeoutMs: 80,
      concurrency: 1,
    });
    const result = await f.federation.search({ query: "chair" });
    expect(aborted).toBe(true);
    expect(result.partial).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.providers).toContainEqual(
      expect.objectContaining({ provider: "ambientcg", status: "timeout" }),
    );
  });

  it("does not turn all-provider failure or user cancellation into successful empty search", async () => {
    const a = adapter();
    a.search = async () => {
      throw Object.assign(new Error("secret=https://example.com?token=secret"), {
        code: "POLYHAVEN_RATE_LIMITED",
        retryAfter: "60",
      });
    };
    const f = await fixture([a]);
    await expect(f.federation.search({ query: "chair" })).rejects.toThrow(/all selected/i);
    const signal = AbortSignal.abort();
    await expect(f.federation.search({ query: "chair" }, signal)).rejects.toThrow();
  });
});

describe("server-held acquisition plans", () => {
  it("stages a complete dependency set and publishes a verifiable receipt atomically", async () => {
    const f = await fixture();
    const plan = await f.federation.get({ assetId: "polyhaven:chair" });
    expect(JSON.stringify(plan)).not.toContain("dl.polyhaven.org");
    expect(await readdir(f.root)).toEqual([]);
    const output = await f.federation.download({
      planToken: plan.plan!.planToken,
      acceptLicense: true,
    });
    expect(output.files.map((file) => file.path)).toEqual([
      "chair.gltf",
      "mesh.bin",
      "textures/color.png",
    ]);
    expect(output.runtimeReadiness).toBe("unverified");
    expect(output.receipt.apiCredit).toBe("Powered by Poly Haven");
    expect(await readFile(join(output.directory, "mesh.bin"), "utf8")).toBe("abc");
    expect(JSON.parse(await readFile(output.receiptPath, "utf8"))).toEqual(output.receipt);
    expect(JSON.stringify(output)).not.toContain("dl.polyhaven.org");
    const again = await f.federation.download({
      planToken: plan.plan!.planToken,
      acceptLicense: true,
    });
    expect(again.alreadyExisted).toBe(true);
    expect(f.fetch).toHaveBeenCalledTimes(3);
    await writeFile(join(output.directory, "mesh.bin"), "bad");
    await expect(
      f.federation.download({ planToken: plan.plan!.planToken, acceptLicense: true }),
    ).rejects.toThrow(/integrity/i);
  });

  it("rejects invalid/expired plans without transfer and invalidates changed terms", async () => {
    const d = detail();
    const f = await fixture([adapter("polyhaven", d)], { planTtlMs: 20 });
    await expect(
      f.federation.download({ planToken: "invalid", acceptLicense: true }),
    ).rejects.toThrow(/plan/i);
    const plan = await f.federation.get({ assetId: "polyhaven:chair" });
    d.termsText = "Different license terms";
    await expect(
      f.federation.download({ planToken: plan.plan!.planToken, acceptLicense: true }),
    ).rejects.toThrow(/changed/i);
    d.termsText = "CC0 public-domain item";
    const expires = await f.federation.get({ assetId: "polyhaven:chair" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(
      f.federation.download({ planToken: expires.plan!.planToken, acceptLicense: true }),
    ).rejects.toThrow(/expired/i);
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("rejects unsafe paths, collisions, unavailable dependencies and unsupported URLs", async () => {
    for (const path of [
      "../escape",
      "/absolute",
      "C:/escape",
      "textures\\escape",
      "%2e%2e/escape",
      "asset.acquisition.json",
      "mesh.bin/child",
      "Mesh.bin",
    ]) {
      const d = detail();
      d.files[2]!.path = path;
      const f = await fixture([adapter("polyhaven", d)]);
      await expect(f.federation.get({ assetId: "polyhaven:chair" })).rejects.toThrow(
        /path|collision/i,
      );
      expect(f.fetch).not.toHaveBeenCalled();
    }
    const d = detail();
    d.files[1]!.url = "https://localhost/secret";
    const f = await fixture([adapter("polyhaven", d)]);
    await expect(f.federation.get({ assetId: "polyhaven:chair" })).rejects.toThrow(/URL/i);
  });

  it("fails missing companions and whole-asset budgets without publishing a receipt", async () => {
    const d = detail();
    d.files = d.files.slice(0, 2);
    const f = await fixture([adapter("polyhaven", d)]);
    const plan = await f.federation.get({ assetId: "polyhaven:chair" });
    await expect(
      f.federation.download({ planToken: plan.plan!.planToken, acceptLicense: true }),
    ).rejects.toThrow(/textures\/color.png/);
    const directories = await readdir(join(f.root, "acquisitions"));
    expect(directories).toEqual([]);
    const full = await fixture();
    const p = await full.federation.get({ assetId: "polyhaven:chair" });
    await expect(
      full.federation.download({ planToken: p.plan!.planToken, acceptLicense: true, maxBytes: 2 }),
    ).rejects.toThrow(/budget/i);
    expect(full.fetch).not.toHaveBeenCalled();
  });

  it("rejects symlink storage and interrupted transfers without partial publication", async () => {
    const f = await fixture();
    const plan = await f.federation.get({ assetId: "polyhaven:chair" });
    const outside = await mkdtemp(join(tmpdir(), "asset-outside-"));
    roots.push(outside);
    await symlink(outside, join(f.root, "acquisitions"));
    await expect(
      f.federation.download({ planToken: plan.plan!.planToken, acceptLicense: true }),
    ).rejects.toThrow(/symlink/i);
    expect(await readdir(outside)).toEqual([]);
    const interrupted = await fixture();
    interrupted.fetch.mockRejectedValueOnce(new Error("interrupted"));
    const p = await interrupted.federation.get({ assetId: "polyhaven:chair" });
    await expect(
      interrupted.federation.download({ planToken: p.plan!.planToken, acceptLicense: true }),
    ).rejects.toThrow();
    expect(await readdir(join(interrupted.root, "acquisitions"))).toEqual([]);
  });
});
