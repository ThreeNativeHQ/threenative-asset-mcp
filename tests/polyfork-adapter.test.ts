import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Document, NodeIO } from "@gltf-transform/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAssetAdapters } from "../src/discovery/adapters.js";
import { AssetFederation } from "../src/discovery/federation.js";
import { DirectAssetDownloader } from "../src/download/direct-asset-downloader.js";
import { PolyforkClient } from "../src/polyfork/client.js";
import {
  POLYFORK_FIXTURE_ID,
  polyforkDetailPayload,
  polyforkRow,
  polyforkSearchPage,
} from "./helpers/polyfork-fixtures.js";

const signal = () => new AbortController().signal;
const adapter = (fetchMock: typeof fetch) =>
  createAssetAdapters({ polyfork: new PolyforkClient(fetchMock) }).find(
    (entry) => entry.id === "polyfork",
  )!;
const client = (payload: unknown) =>
  adapter(async () => Response.json(payload));

describe("Polyfork federated adapter", () => {
  it("maps free characters into a bounded page with a provider-local continuation", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json(polyforkSearchPage([polyforkRow()], { total: 198, per_page: 1 })),
    );
    const result = await adapter(fetchMock).search("musician", ["3d-model"], 1, signal());
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      q: "musician",
      page: "1",
      per_page: "1",
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      provider: "polyfork",
      nativeId: POLYFORK_FIXTURE_ID,
      type: "3d-model",
      itemKind: "asset",
      free: "yes",
      sourceUrl: `https://polyfork.dev/asset/${POLYFORK_FIXTURE_ID}`,
      thumbnailUrl: `https://polyfork.dev/files/${POLYFORK_FIXTURE_ID}/renders/hero.png`,
      downloadStatus: "unknown",
      canDownloadNow: false,
      license: {
        name: "CC BY 4.0 or Polyfork licence",
        url: "https://polyfork.dev/licensing",
        commercialUse: "yes",
        attributionRequired: "yes",
      },
    });
    expect(result.truncated).toBe(true);
    expect(result.continuation).toMatchObject({
      tool: "polyfork_search_models",
      arguments: { query: "musician", cursor: "2" },
    });
  });

  it("does not search a catalogue for non-model asset types", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await expect(
      adapter(fetchMock).search("musician", ["texture"], 5, signal()),
    ).resolves.toEqual({ items: [], truncated: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("plans exactly the full low-poly GLB and carries the dual licence", async () => {
    const detail = await client(polyforkDetailPayload()).get(POLYFORK_FIXTURE_ID, {}, signal());
    expect(detail.files).toEqual([
      {
        id: "low-poly-glb",
        path: `${POLYFORK_FIXTURE_ID}.glb`,
        url: `https://polyfork.dev/cdn/${POLYFORK_FIXTURE_ID}.glb`,
        role: "main-model",
      },
    ]);
    expect(detail.asset).toMatchObject({
      downloadStatus: "direct",
      canDownloadNow: true,
      free: "yes",
      license: {
        name: "CC BY 4.0 or Polyfork licence",
        commercialUse: "yes",
        attributionRequired: "yes",
      },
    });
    expect(detail.asset.license.evidence).toContain("Cueca Musician by Polyfork");
    expect(detail.termsText).toContain("CC BY 4.0");
    expect(detail.termsText).toContain("standalone redistribution");
    expect(detail.selectedVariant).toBe("glb/low-poly/full");
    expect(detail.providerDetails).toMatchObject({
      triangles: 4055,
      clips: [{ name: "Walk", seconds: 0.97 }],
      hd: null,
    });
    expect(detail.files.every((file) => !file.url.includes("-preview"))).toBe(true);
  });

  it("refuses a requested source format it cannot plan", async () => {
    const detail = await client(polyforkDetailPayload()).get(
      POLYFORK_FIXTURE_ID,
      { format: "fbx" },
      signal(),
    );
    expect(detail.files).toEqual([]);
    expect(detail.asset.canDownloadNow).toBe(false);
    expect(detail.alternatives).toContain("glb/low-poly/full");
    expect(detail.selectionExplanation).toContain("GLB");
  });

  it("keeps an account-gated GLB honest instead of planning it", async () => {
    const gated = polyforkDetailPayload({
      download: {
        glb: `https://polyfork.dev/cdn/${POLYFORK_FIXTURE_ID}.glb`,
        mjs: `https://polyfork.dev/cdn/${POLYFORK_FIXTURE_ID}.mjs`,
        auth: "account",
      },
    });
    const detail = await client(gated).get(POLYFORK_FIXTURE_ID, {}, signal());
    expect(detail.files).toEqual([]);
    expect(detail.asset.canDownloadNow).toBe(false);
    expect(detail.asset.downloadStatus).toBe("auth-required");
    expect(detail.selectionExplanation).toContain("account");
  });

  it("surfaces the Pro HD edition without blocking the free low-poly plan", async () => {
    const hd = polyforkDetailPayload({
      hd: {
        plan: "pro",
        page: `https://polyfork.dev/asset/${POLYFORK_FIXTURE_ID}?edition=hd`,
        kind: "its own high poly program with pbr materials",
        triangles: 608,
        preview_glb: `https://polyfork.dev/cdn/${POLYFORK_FIXTURE_ID}-hd-preview.glb`,
        files: `https://polyfork.dev/dl/${POLYFORK_FIXTURE_ID}-hd.zip (Pro, with a key)`,
      },
    });
    const detail = await client(hd).get(POLYFORK_FIXTURE_ID, {}, signal());
    expect(detail.asset.canDownloadNow).toBe(true);
    expect(detail.files).toHaveLength(1);
    expect(detail.providerDetails).toMatchObject({
      hd: { plan: "pro", triangles: 608 },
    });
  });

  it("treats a full-GLB URL outside the exact CDN contract as unverified", async () => {
    const forged = polyforkDetailPayload({
      download: {
        glb: `https://polyfork.dev/cdn/${POLYFORK_FIXTURE_ID}-preview.glb`,
        auth: "none",
      },
    });
    const detail = await client(forged).get(POLYFORK_FIXTURE_ID, {}, signal());
    expect(detail.files).toEqual([]);
    expect(detail.asset.canDownloadNow).toBe(false);
    expect(detail.asset.downloadStatus).toBe("unsupported");
  });

  it("rejects a provider-native id outside the catalogue grammar", async () => {
    await expect(client(polyforkDetailPayload()).get("../../escape", {}, signal())).rejects.toThrow(
      /Polyfork/i,
    );
  });
});

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Polyfork federation acquisition", () => {
  it("plans and acquires the real full GLB through the guarded pipeline", async () => {
    const glb = await new NodeIO().writeBinary(new Document());
    const fetchMock = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = new URL(String(input));
      return url.pathname === `/api/assets/${POLYFORK_FIXTURE_ID}`
        ? Response.json(polyforkDetailPayload())
        : new Response(new Uint8Array(glb));
    });
    const directory = await mkdtemp(join(tmpdir(), "polyfork-federation-"));
    temporaryDirectories.push(directory);
    const downloader = new DirectAssetDownloader({ downloadDir: directory, fetch: fetchMock });
    const federation = new AssetFederation(
      createAssetAdapters({ polyfork: new PolyforkClient(fetchMock) }),
      downloader,
      { toolVersion: "0.15.0-test" },
    );

    const detail = await federation.get({ assetId: `polyfork:${POLYFORK_FIXTURE_ID}` });
    expect(detail.plan).not.toBeNull();
    expect(detail.plan?.files).toEqual([
      expect.objectContaining({ path: `${POLYFORK_FIXTURE_ID}.glb`, role: "main-model" }),
    ]);
    expect(detail.asset.license.name).toBe("CC BY 4.0 or Polyfork licence");

    const acquired = await federation.download({
      planToken: detail.plan!.planToken,
      acceptLicense: true,
    });
    expect(acquired.files).toEqual([
      expect.objectContaining({
        path: `${POLYFORK_FIXTURE_ID}.glb`,
        sizeBytes: glb.length,
      }),
    ]);
    expect(acquired.receipt).toMatchObject({
      provider: "polyfork",
      nativeId: POLYFORK_FIXTURE_ID,
      selectedVariant: "glb/low-poly/full",
      requiresExtraction: false,
    });
    expect(acquired.receipt.files[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/cdn/"))).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/dl/"))).toBe(false);
  });
});
