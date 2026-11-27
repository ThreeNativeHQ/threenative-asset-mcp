import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DirectAssetDownloader } from "../src/download/direct-asset-downloader.js";
import { threenativeAdapter } from "../src/threenative/adapter.js";
import { ThreeNativeCatalogClient } from "../src/threenative/client.js";

/** The Studio cache names each row's representation and provenance. The adapter takes them from the
 * server: a baked procedural GLB is a `.glb`, a legacy builder is JSON, and a seed keeps its own license
 * and author instead of an assumed CC0 from ThreeNative. */

const BAKED = "44444444-5555-4666-8777-888888888888";
const BUILDER = "55555555-6666-4777-8888-999999999999";
const SEED = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const OLD_SEED = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
const STUDIO_ENV = { GATEWAY_URL: "https://gateway.threenative.com/v1", GATEWAY_TOKEN: "w1.session" };
const signal = () => new AbortController().signal;

/** A real minimal binary glTF 2.0 (header + JSON chunk). */
function glb(): Uint8Array {
  const text = new TextEncoder().encode('{"asset":{"version":"2.0"}} ');
  const out = new Uint8Array(20 + text.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.byteLength, true);
  view.setUint32(12, text.byteLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  return out;
}
const GLB = glb();
const GLB_SHA = createHash("sha256").update(GLB).digest("hex");

const methods: string[] = [];
const head = (format: string, extra: Record<string, string> = {}) =>
  new Response(null, {
    headers: {
      "content-type": format === "glb" ? "model/gltf-binary" : "application/json",
      "x-tn-format": format,
      "x-tn-prompt": encodeURIComponent(format === "glb" ? "an amber gate" : "a builder pine"),
      "x-tn-provider": "procedural",
      ...extra,
    },
  });
const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = init?.method ?? "GET";
  methods.push(`${method} ${url.pathname}`);
  if (url.pathname === "/api/assets/cache/search")
    return Response.json({
      items: [
        { id: BAKED, prompt: "an amber gate", tags: "", provider: "procedural", hasPreview: false, type: "model", origin: "procedural", format: "glb", contentHash: GLB_SHA },
        { id: BUILDER, prompt: "a builder pine", tags: "", provider: "sculpt", hasPreview: false, type: "model", origin: "procedural", format: "procedural-json" },
        { id: SEED, prompt: "a licensed lantern", tags: "", provider: "threenative", hasPreview: false, type: "model", origin: "custom", format: "glb", license: "CC-BY-4.0", author: "Ada Example" },
        { id: OLD_SEED, prompt: "an old wolf", tags: "", provider: "threenative", hasPreview: false, type: "model", origin: "procedural" },
      ],
    });
  if (url.pathname === "/api/assets/public/catalog.json")
    return Response.json({ items: [{ id: OLD_SEED, slug: "old-wolf", prompt: "an old wolf", tags: "", type: "model", origin: "procedural", license: "CC-BY-SA-4.0", author: "Grace Example", hasPreview: false }] });
  if (url.pathname === `/api/assets/cache/${BAKED}`)
    return method === "HEAD" ? head("glb", { "x-tn-sha256": GLB_SHA, "x-tn-license": "CC-BY-4.0", "x-tn-author": encodeURIComponent("Ada Example") }) : new Response(GLB.buffer as ArrayBuffer);
  if (url.pathname === `/api/assets/cache/${BUILDER}`)
    return method === "HEAD" ? head("procedural-json") : Response.json({ builder: "export {}", spec: "{}" });
  if (url.pathname === `/api/assets/cache/${OLD_SEED}` && method === "HEAD")
    return new Response("Method not allowed", { status: 405 });
  return new Response("Not found", { status: 404 });
}) as typeof fetch;

afterEach(() => {
  methods.length = 0;
  vi.unstubAllEnvs();
});

describe("Studio cache representation and provenance", () => {
  const client = () => new ThreeNativeCatalogClient({ env: STUDIO_ENV, fetch: fetchStub });

  it("keeps a seed's own license and author, from the row or from the public catalog", async () => {
    const { items } = await threenativeAdapter(client()).search("lantern", ["3d-model"], 8, signal());
    const seed = items.find((item) => item.nativeId === SEED);
    expect(seed?.author).toBe("Ada Example");
    expect(seed?.license.name).toBe("CC-BY-4.0");
    expect(seed?.license.attributionRequired).toBe("yes");
    const old = items.find((item) => item.nativeId === OLD_SEED);
    expect(old?.author).toBe("Grace Example");
    expect(old?.license.name).toBe("CC-BY-SA-4.0");
    expect(old?.license.attributionRequired).toBe("yes");
    expect(items.map((item) => item.license.name)).not.toContain("CC0 1.0");
  });

  it("answers a baked procedural GLB as a .glb and a builder as JSON, from the Worker's HEAD", async () => {
    const adapter = threenativeAdapter(client());
    const baked = await adapter.get(`studio-procedural-${BAKED}`, {}, signal());
    expect(baked.files).toEqual([
      { id: "main", path: `${BAKED}.glb`, role: "main-model", url: `https://gateway.threenative.com/api/assets/cache/${BAKED}` },
    ]);
    expect(baked.selectedVariant).toBe("glb/original");
    expect(baked.asset).toMatchObject({ author: "Ada Example", title: "an amber gate" });
    expect(baked.asset.license.name).toBe("CC-BY-4.0");
    const builder = await adapter.get(`studio-procedural-${BUILDER}`, {}, signal());
    expect(builder.files[0]).toMatchObject({ path: `${BUILDER}.procedural.json`, role: "procedural-builder" });
    expect(methods).toEqual([`HEAD /api/assets/cache/${BAKED}`, `HEAD /api/assets/cache/${BUILDER}`]);
  });

  it("keeps the old reading when the Worker predates HEAD facts (405)", async () => {
    const adapter = threenativeAdapter(client());
    const builder = await adapter.get(`studio-procedural-${OLD_SEED}`, {}, signal());
    expect(builder.files[0]).toMatchObject({ path: `${OLD_SEED}.procedural.json`, role: "procedural-builder" });
    const custom = await adapter.get(`studio-custom-${OLD_SEED}`, {}, signal());
    expect(custom.files[0]).toMatchObject({ path: `${OLD_SEED}.glb`, role: "main-model" });
    expect(custom.asset.license.name).toBe("ThreeNative Studio Terms");
    expect(methods).toEqual([`HEAD /api/assets/cache/${OLD_SEED}`, `HEAD /api/assets/cache/${OLD_SEED}`]);
  });

  it("downloads the baked GLB under its .glb name, byte for byte", async () => {
    vi.stubEnv("GATEWAY_URL", STUDIO_ENV.GATEWAY_URL);
    vi.stubEnv("GATEWAY_TOKEN", STUDIO_ENV.GATEWAY_TOKEN);
    const dir = await mkdtemp(join(tmpdir(), "tn-formats-"));
    try {
      const detail = await threenativeAdapter(client()).get(`studio-procedural-${BAKED}`, {}, signal());
      const file = detail.files[0]!;
      const saved = await new DirectAssetDownloader({ fetch: fetchStub, downloadDir: dir }).download({
        provider: "threenative",
        url: file.url,
        fileName: file.path,
      });
      const bytes = await readFile(saved.path);
      expect(saved.path.endsWith(".glb")).toBe(true);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(GLB_SHA);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
