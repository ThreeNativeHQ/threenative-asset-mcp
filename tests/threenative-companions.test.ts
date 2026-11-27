import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { acquire } from "../src/discovery/acquisition.js";
import { DirectAssetDownloader } from "../src/download/direct-asset-downloader.js";
import { threenativeAdapter } from "../src/threenative/adapter.js";
import { ThreeNativeCatalogClient } from "../src/threenative/client.js";

/** A Studio cache row that carries companions (a source texture, the import report, the license document,
 * the original receipt) answers them in `asset_get` and saves them, hash-checked, beside its GLB in
 * `asset_download`. A row whose completeness the Worker never recorded is not called a ready GLB. */

const COMPLETE = "88888888-9999-4aaa-8bbb-cccccccccccc";
const LEGACY = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
const STUDIO_ENV = { GATEWAY_URL: "https://gateway.threenative.com/v1", GATEWAY_TOKEN: "w1.session" };
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const signal = () => AbortSignal.timeout(5000);

/** A binary glTF 2.0 with `json` as its JSON chunk. */
function glb(json: object): Uint8Array {
  const raw = new TextEncoder().encode(JSON.stringify(json));
  const text = new Uint8Array(Math.ceil(raw.byteLength / 4) * 4).fill(0x20);
  text.set(raw);
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
const GLB = glb({ asset: { version: "2.0" } });
/** A legacy row: its GLB names a texture the cache never held. */
const DANGLING = glb({ asset: { version: "2.0" }, images: [{ uri: "tile.png" }] });
const encode = (text: string) => new TextEncoder().encode(text);
const RECEIPT = encode(JSON.stringify({ schemaVersion: 1, provider: "polyhaven", nativeId: "lantern_01" }));
const MEMBERS = [
  { body: encode("source albedo"), path: "textures/source albedo.png", role: "material-source" },
  { body: encode('{"importer":"fixture"}'), path: "import-report.json", role: "import-report" },
  { body: encode("CC-BY-4.0. Lantern by Ada Example.\n"), path: "LICENSE.txt", role: "license" },
  { body: RECEIPT, path: "receipts/asset.acquisition.json", role: "source-receipt" },
];
const MANIFEST = {
  version: 1,
  id: COMPLETE,
  completeness: "complete",
  bundleHash: "e".repeat(64),
  main: { sha256: sha(GLB), bytes: GLB.byteLength },
  members: MEMBERS.map((member, index) => ({
    index,
    path: member.path,
    role: member.role,
    contentType: "application/octet-stream",
    bytes: member.body.byteLength,
    sha256: sha(member.body),
  })),
  provenance: {
    author: "Ada Example",
    license: { name: "CC-BY-4.0", url: "https://creativecommons.org/licenses/by/4.0/" },
    provider: "polyhaven",
    nativeId: "lantern_01",
  },
};

const methods: string[] = [];
const stub = (tamper?: number) =>
  (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init?.method ?? "GET";
    methods.push(`${method} ${url.pathname}`);
    const facts = (id: string, extra: Record<string, string>) => ({
      "content-type": "model/gltf-binary",
      "x-tn-format": "glb",
      "x-tn-prompt": encodeURIComponent(id === COMPLETE ? "a lantern with papers" : "an old lantern"),
      "x-tn-provider": "procedural",
      ...extra,
    });
    if (url.pathname === `/api/assets/cache/${COMPLETE}`) {
      const headers = facts(COMPLETE, {
        "x-tn-sha256": sha(GLB),
        "x-tn-completeness": "complete",
        "x-tn-members": String(MEMBERS.length),
        "x-tn-bundle": MANIFEST.bundleHash,
        "x-tn-license": "CC-BY-4.0",
      });
      return new Response(method === "HEAD" ? null : new Uint8Array(GLB), { headers });
    }
    if (url.pathname === `/api/assets/cache/${COMPLETE}/manifest`) return Response.json(MANIFEST);
    const member = /\/members\/(\d+)$/u.exec(url.pathname);
    if (member) {
      const index = Number(member[1]);
      const body = MEMBERS[index]!.body;
      // Same size, one byte changed: only the hash can tell.
      return new Response(index === tamper ? body.map((byte, at) => (at === 0 ? byte ^ 1 : byte)) : body);
    }
    if (url.pathname === `/api/assets/cache/${LEGACY}`)
      return new Response(method === "HEAD" ? null : new Uint8Array(DANGLING), {
        headers: facts(LEGACY, { "x-tn-sha256": sha(DANGLING) }),
      });
    return new Response("Not found", { status: 404 });
  }) as typeof fetch;

const roots: string[] = [];
afterEach(async () => {
  methods.length = 0;
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const adapter = (fetch = stub()) =>
  threenativeAdapter(new ThreeNativeCatalogClient({ env: STUDIO_ENV, fetch }));
async function download(nativeId: string, fetch = stub()) {
  vi.stubEnv("GATEWAY_URL", STUDIO_ENV.GATEWAY_URL);
  vi.stubEnv("GATEWAY_TOKEN", STUDIO_ENV.GATEWAY_TOKEN);
  const root = await mkdtemp(join(tmpdir(), "tn-companions-"));
  roots.push(root);
  const detail = await adapter(fetch).get(nativeId, {}, signal());
  const downloader = new DirectAssetDownloader({ downloadDir: root, maxDownloadBytes: 10_000_000, fetch });
  return { acquired: () => acquire(detail, downloader, 10_000_000, "0.21.2", signal()), detail, root };
}

describe("ThreeNative companions", () => {
  it("lists every member beside the GLB, with the manifest, and reads only HEAD and the manifest", async () => {
    const detail = await adapter().get(`studio-procedural-${COMPLETE}`, {}, signal());
    const base = `https://gateway.threenative.com/api/assets/cache/${COMPLETE}`;
    expect(detail.files.map(({ path, url }) => [path, url])).toEqual([
      [`${COMPLETE}.glb`, base],
      ["companions/manifest.json", `${base}/manifest`],
      ...MEMBERS.map((member, index) => [`companions/${member.path}`, `${base}/members/${index}`]),
    ]);
    expect(detail.files.find((file) => file.path === "companions/LICENSE.txt")?.metadata?.sha256).toBe(
      sha(MEMBERS[2]!.body),
    );
    expect(detail.asset.rankingFactors).toContain("ready GLB");
    expect(detail.asset.downloadReason).toMatch(/complete.*4 companion files/u);
    expect(detail.asset.license).toMatchObject({
      attributionRequired: "yes",
      name: "CC-BY-4.0",
      url: "https://creativecommons.org/licenses/by/4.0/",
    });
    expect(detail.asset.license.evidence).toMatch(/companions\/LICENSE\.txt/u);
    expect(methods).toEqual([`HEAD /api/assets/cache/${COMPLETE}`, `GET /api/assets/cache/${COMPLETE}/manifest`]);
  });

  it("saves every member byte for byte, and keeps the original receipt apart from its own", async () => {
    const { acquired } = await download(`studio-procedural-${COMPLETE}`);
    const result = await acquired();
    for (const member of MEMBERS)
      expect(await readFile(join(result.directory, "companions", member.path))).toEqual(Buffer.from(member.body));
    expect(await readFile(join(result.directory, "companions/receipts/asset.acquisition.json"))).toEqual(
      Buffer.from(RECEIPT),
    );
    const own = JSON.parse(await readFile(join(result.directory, "asset.acquisition.json"), "utf8"));
    expect(own.assetId).toBe(`threenative:studio-procedural-${COMPLETE}`);
    expect(own.files.map((file: { path: string }) => file.path)).toContain("companions/LICENSE.txt");
  });

  it("publishes nothing when one member does not match its hash", async () => {
    const { acquired, root } = await download(`studio-procedural-${COMPLETE}`, stub(2));
    await expect(acquired()).rejects.toThrow(/hash mismatch/u);
    const left = await import("node:fs/promises").then(({ readdir }) =>
      readdir(join(root, "acquisitions")).catch(() => []),
    );
    expect(left.filter((name) => !name.startsWith(".stage-"))).toEqual([]);
  });

  it("does not call a row of unknown completeness a ready GLB, and still refuses it when incomplete", async () => {
    const { acquired, detail } = await download(`studio-custom-${LEGACY}`);
    expect(detail.asset.rankingFactors).not.toContain("ready GLB");
    expect(detail.asset.downloadReason).toMatch(/not recorded/u);
    expect(detail.files).toHaveLength(1);
    await expect(acquired()).rejects.toThrow();
  });
});
