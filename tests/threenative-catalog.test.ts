import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AudioCatalogClient } from "../src/audio/client.js";
import { createAssetAdapters } from "../src/discovery/adapters.js";
import { DirectAssetDownloader } from "../src/download/direct-asset-downloader.js";
import { threenativeAdapter } from "../src/threenative/adapter.js";
import { ThreeNativeCatalogClient } from "../src/threenative/client.js";
import { createAudioDownloadHandler, createAudioSearchHandler } from "../src/tools/audio.js";

/** PRD-120 AC-3. The `threenative` provider: the public catalog with no configuration, the Studio cache
 * when a Studio container injects its gateway, and the existing `procedural` provider left in place. */

const WOLF = "11111111-2222-4333-8444-555555555555";
const HOWL = "22222222-3333-4444-8555-666666666666";
const SCULPT = "33333333-4444-4555-8666-777777777777";
const CATALOG = {
  version: 1,
  generatedAt: 1,
  items: [
    { id: WOLF, slug: "wolf", prompt: "a low poly grey wolf", tags: "animal quadruped", type: "model", origin: "procedural", license: "CC0-1.0", author: "ThreeNative", byteSize: 8, contentHash: "h", hasPreview: true },
    { id: HOWL, slug: "wolf-howl", prompt: "a wolf howl", tags: "animal", type: "audio", origin: "custom", license: "CC0-1.0", author: "ThreeNative", byteSize: 4, contentHash: "h2", hasPreview: false },
  ],
};
const signal = () => new AbortController().signal;
const STUDIO_ENV = { GATEWAY_URL: "https://gateway.threenative.com/v1", GATEWAY_TOKEN: "w1.session" };
const calls: { url: string; headers: Record<string, string> }[] = [];
const headersOf = (init?: RequestInit): Record<string, string> =>
  Object.fromEntries(new Headers(init?.headers) as unknown as Iterable<[string, string]>);

function fakeFetch(routes: Record<string, () => Response>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    calls.push({ url: url.toString(), headers: headersOf(init) });
    const route = routes[url.pathname];
    return route ? route() : new Response("not found", { status: 404 });
  }) as typeof fetch;
}
const catalogRoute = () =>
  Response.json(CATALOG, { headers: { etag: '"v1"' } });

afterEach(() => {
  calls.length = 0;
  vi.unstubAllEnvs();
});

describe("public tier, zero configuration", () => {
  it("ranks the cached public catalog locally and offers a direct GLB", async () => {
    const client = new ThreeNativeCatalogClient({
      env: {},
      fetch: fakeFetch({ "/api/assets/public/catalog.json": catalogRoute }),
    });
    const { items } = await threenativeAdapter(client).search("grey wolf", ["3d-model"], 5, signal());
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      assetId: `threenative:${WOLF}`,
      provider: "threenative",
      canDownloadNow: true,
      downloadStatus: "direct",
      license: { name: "CC0 1.0", commercialUse: "yes" },
      sourceUrl: `https://gateway.threenative.com/api/assets/public/${WOLF}`,
      thumbnailUrl: `https://gateway.threenative.com/api/assets/public/${WOLF}/preview`,
    });
    expect(calls[0]?.headers.authorization).toBeUndefined();
    await threenativeAdapter(client).search("wolf", ["3d-model"], 5, signal());
    expect(calls).toHaveLength(1);
    const detail = await threenativeAdapter(client).get(WOLF, {}, signal());
    expect(detail.files).toEqual([
      { id: "main", path: "wolf.glb", url: `https://gateway.threenative.com/api/assets/public/${WOLF}`, role: "main-model" },
    ]);
  });

  it("revalidates by ETag after ten minutes and waits out a 429", async () => {
    let now = 0;
    let answer: () => Response = catalogRoute;
    const client = new ThreeNativeCatalogClient({
      env: {},
      fetch: fakeFetch({ "/api/assets/public/catalog.json": () => answer() }),
      now: () => now,
    });
    await client.search("wolf", "model", 5, signal());
    now = 11 * 60_000;
    answer = () => new Response(null, { status: 304 });
    expect(await client.search("wolf", "model", 5, signal())).toHaveLength(1);
    expect(calls[1]?.headers["if-none-match"]).toBe('"v1"');
    now = 22 * 60_000;
    answer = () => new Response("slow down", { status: 429, headers: { "retry-after": "120" } });
    expect(await client.search("wolf", "model", 5, signal())).toHaveLength(1);
    now += 60_000;
    await client.search("wolf", "model", 5, signal());
    expect(calls).toHaveLength(3);
  });

  it("refuses a Studio cache id outside Studio", async () => {
    const client = new ThreeNativeCatalogClient({ env: {}, fetch: fakeFetch({}) });
    await expect(threenativeAdapter(client).get(`studio-custom-${SCULPT}`, {}, signal())).rejects.toThrow(/inside a ThreeNative Studio game/u);
  });
});

describe("Studio tier, injected gateway", () => {
  const studioSearch = () =>
    Response.json({
      items: [
        { id: SCULPT, prompt: "a carved stone fox", tags: "", provider: "sculpt", hasPreview: false, type: "model", origin: "procedural", visibility: "shared", mine: false, quality: "", reuseCount: 0 },
        { id: WOLF, prompt: "a low poly grey wolf", tags: "", provider: "threenative", hasPreview: true, type: "model", origin: "procedural", visibility: "shared", mine: false, quality: "", reuseCount: 0 },
      ],
    });

  it("searches the Studio cache with the token, and keeps seeds on the public URL", async () => {
    const client = new ThreeNativeCatalogClient({
      env: STUDIO_ENV,
      fetch: fakeFetch({ "/api/assets/cache/search": studioSearch }),
    });
    const { items } = await threenativeAdapter(client).search("fox", ["3d-model"], 5, signal());
    expect(calls[0]?.url).toBe("https://gateway.threenative.com/api/assets/cache/search?q=fox&type=model&limit=6");
    expect(calls[0]?.headers.authorization).toBe("Bearer w1.session");
    expect(items.map((item) => item.nativeId)).toEqual([`studio-procedural-${SCULPT}`, WOLF]);
    expect(items[1]?.sourceUrl).toBe(`https://gateway.threenative.com/api/assets/public/${WOLF}`);
    const detail = await threenativeAdapter(client).get(`studio-procedural-${SCULPT}`, {}, signal());
    expect(detail.files[0]).toMatchObject({
      path: `${SCULPT}.procedural.json`,
      role: "procedural-builder",
      url: `https://gateway.threenative.com/api/assets/cache/${SCULPT}`,
    });
  });

  it("falls back to the public catalog when the Studio cache refuses", async () => {
    const client = new ThreeNativeCatalogClient({
      env: STUDIO_ENV,
      fetch: fakeFetch({
        "/api/assets/cache/search": () => Response.json({ error: "TN_TRIAL" }, { status: 402 }),
        "/api/assets/public/catalog.json": catalogRoute,
      }),
    });
    expect((await client.search("wolf", "model", 5, signal())).map((item) => item.id)).toEqual([WOLF]);
  });

  it("downloads with the token only from the gateway's cache route", async () => {
    vi.stubEnv("GATEWAY_URL", STUDIO_ENV.GATEWAY_URL);
    vi.stubEnv("GATEWAY_TOKEN", STUDIO_ENV.GATEWAY_TOKEN);
    const dir = await mkdtemp(join(tmpdir(), "tn-catalog-"));
    try {
      const fetch = fakeFetch({
        [`/api/assets/cache/${SCULPT}`]: () => Response.json({ builder: "export {}", spec: "{}" }),
        [`/api/assets/public/${WOLF}`]: () => new Response(new Uint8Array([1, 2, 3])),
      });
      const downloader = new DirectAssetDownloader({ fetch, downloadDir: dir });
      await downloader.download({ provider: "threenative", url: `https://gateway.threenative.com/api/assets/cache/${SCULPT}`, fileName: "fox.procedural.json" });
      await downloader.download({ provider: "threenative", url: `https://gateway.threenative.com/api/assets/public/${WOLF}`, fileName: "wolf.glb" });
      expect(calls.map((call) => call.headers.authorization)).toEqual(["Bearer w1.session", undefined]);
      await expect(
        downloader.download({ provider: "threenative", url: "https://evil.example/api/assets/public/" + WOLF, fileName: "x.glb" }),
      ).rejects.toThrow(/official download contract/u);
      await expect(
        downloader.download({ provider: "threenative", url: "https://gateway.threenative.com/v1/chat/completions", fileName: "x.glb" }),
      ).rejects.toThrow(/official download contract/u);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("audio and the existing providers", () => {
  it("lists ThreeNative sounds first and downloads one into the audio folder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tn-audio-"));
    try {
      const threenative = new ThreeNativeCatalogClient({
        env: {},
        fetch: fakeFetch({
          "/api/assets/public/catalog.json": catalogRoute,
          [`/api/assets/public/${HOWL}`]: () => new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46])),
        }),
      });
      const audio = new AudioCatalogClient({ downloadDir: dir });
      const found = await createAudioSearchHandler(audio, threenative)({ query: "wolf" });
      const first = ((found as { structuredContent: unknown }).structuredContent as { items: { id: string; sourceId: string }[] }).items[0];
      expect(first).toMatchObject({ id: `threenative-${HOWL}`, sourceId: "threenative" });
      const saved = await createAudioDownloadHandler(audio, threenative)({ assetId: `threenative-${HOWL}`, acceptLicense: true });
      const result = (saved as { structuredContent: unknown }).structuredContent as { path: string; license: string };
      expect(result.license).toBe("CC0-1.0");
      expect([...(await readFile(result.path))]).toEqual([0x52, 0x49, 0x46, 0x46]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the procedural-environment provider beside the new one", () => {
    const ids = createAssetAdapters({ threenative: new ThreeNativeCatalogClient({ env: {}, fetch: fakeFetch({}) }) }).map((entry) => entry.id);
    expect(ids).toEqual(expect.arrayContaining(["threenative", "procedural"]));
  });
});
