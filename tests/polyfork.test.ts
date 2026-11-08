import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  POLYFORK_CLASSES,
  PolyforkClient,
  parsePolyforkIdOrUrl,
} from "../src/polyfork/client.js";
import { POLYFORK_TERMS, polyforkLicense } from "../src/polyfork/license.js";
import {
  POLYFORK_FIXTURE_ID,
  polyforkDetailPayload,
  polyforkRow,
  polyforkSearchPage,
} from "./helpers/polyfork-fixtures.js";

const signal = () => new AbortController().signal;

describe("Polyfork client", () => {
  it("sends the documented search parameters and keeps provider pagination", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json(
        polyforkSearchPage([polyforkRow()], { total: 198, page: 2, per_page: 2 }),
      ),
    );
    const result = await new PolyforkClient(fetchMock).search(
      {
        query: " musician ",
        assetClass: "character",
        free: true,
        sort: "tris",
        page: 2,
        perPage: 2,
      },
      { signal: signal() },
    );
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.origin).toBe("https://polyfork.dev");
    expect(url.pathname).toBe("/api/assets");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      q: "musician",
      class: "character",
      free: "1",
      sort: "tris",
      page: "2",
      per_page: "2",
    });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error",
      headers: { "user-agent": "threenative-asset-mcp/0.15.0" },
    });
    expect(result).toMatchObject({ total: 198, page: 2, perPage: 2 });
    expect(result.items[0]).toMatchObject({
      id: POLYFORK_FIXTURE_ID,
      title: "Cueca Musician",
      assetClass: "character",
      triangles: 4055,
      free: true,
      pageUrl: `https://polyfork.dev/asset/${POLYFORK_FIXTURE_ID}`,
      thumbnailUrl: `https://polyfork.dev/files/${POLYFORK_FIXTURE_ID}/renders/hero.png`,
      hasRig: true,
      hasSkeleton: true,
      hd: null,
      download: {
        auth: "none",
        glb: `https://polyfork.dev/cdn/${POLYFORK_FIXTURE_ID}.glb`,
      },
    });
  });

  it("omits relevance sorting and clamps per-page to the upstream maximum", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json(polyforkSearchPage([polyforkRow()], { per_page: 100 })),
    );
    await new PolyforkClient(fetchMock).search({ perPage: 999 });
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("per_page")).toBe("100");
    expect(url.searchParams.has("sort")).toBe(false);
    expect(url.searchParams.has("q")).toBe(false);
  });

  it("rejects invalid filters locally without contacting the catalogue", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = new PolyforkClient(fetchMock);
    const invalid = [
      { assetClass: "monster" },
      { sort: "newest" },
      { minTriangles: 10, maxTriangles: 5 },
      { kit: "../escape" },
      { page: 0 },
      { page: 1.5 },
      { perPage: 0 },
      { query: "x".repeat(201) },
    ];
    for (const query of invalid) {
      await expect(client.search(query as never)).rejects.toMatchObject({
        code: "POLYFORK_INVALID_INPUT",
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns an honest empty word-match page", async () => {
    const client = new PolyforkClient(async () =>
      Response.json({
        total: 0,
        page: 1,
        per_page: 24,
        assets: [],
        coverage: "none",
        strong_matches: 0,
        coverage_note: "no title or description contains those words",
      }),
    );
    await expect(client.search({ query: "zzzznotathing" })).resolves.toMatchObject({
      total: 0,
      items: [],
      coverage: "none",
      strongMatches: 0,
    });
  });

  it("rejects malformed catalogue pages instead of guessing", async () => {
    const pages = [
      { ...polyforkSearchPage([polyforkRow()]), assets: "no" },
      { ...polyforkSearchPage([polyforkRow()]), page: 3 },
      { ...polyforkSearchPage([polyforkRow(), polyforkRow({ id: "other-base" })], { per_page: 1 }) },
      { ...polyforkSearchPage([polyforkRow()]), total: -1 },
      { ...polyforkSearchPage([polyforkRow({ free: "yes" })]) },
    ];
    for (const payload of pages) {
      await expect(
        new PolyforkClient(async () => Response.json(payload)).search({ page: 1 }),
      ).rejects.toMatchObject({ code: "POLYFORK_UPSTREAM_CHANGED" });
    }
  });

  it("maps full detail metadata, clips, skeleton and the dual licence", async () => {
    const client = new PolyforkClient(async () =>
      Response.json(polyforkDetailPayload()),
    );
    const detail = await client.getAsset(`https://polyfork.dev/asset/${POLYFORK_FIXTURE_ID}`, {
      signal: signal(),
    });
    expect(detail).toMatchObject({
      id: POLYFORK_FIXTURE_ID,
      clips: [{ name: "Walk", seconds: 0.97 }],
      skeleton: { bones: 31, binding: "rigid: one bone per vertex at weight 1" },
      hd: null,
      download: {
        auth: "none",
        glb: `https://polyfork.dev/cdn/${POLYFORK_FIXTURE_ID}.glb`,
      },
    });
    expect(detail.licenseText).toContain("CC BY 4.0");
    expect(detail.credit).toContain("Cueca Musician by Polyfork");
    expect(detail.exportFormats[0]).toMatchObject({ format: "fbx", available: true });
  });

  it("reports the Pro HD edition without treating it as free", async () => {
    const client = new PolyforkClient(async () =>
      Response.json(
        polyforkDetailPayload({
          hd: {
            plan: "pro",
            page: `https://polyfork.dev/asset/${POLYFORK_FIXTURE_ID}?edition=hd`,
            kind: "its own high poly program with pbr materials",
            triangles: 608,
            preview_glb: `https://polyfork.dev/cdn/${POLYFORK_FIXTURE_ID}-hd-preview.glb`,
            files: `https://polyfork.dev/dl/${POLYFORK_FIXTURE_ID}-hd.zip (Pro, with a key)`,
          },
        }),
      ),
    );
    const detail = await client.getAsset(POLYFORK_FIXTURE_ID);
    expect(detail.hd).toMatchObject({
      plan: "pro",
      triangles: 608,
      pageUrl: `https://polyfork.dev/asset/${POLYFORK_FIXTURE_ID}?edition=hd`,
      previewGlbUrl: `https://polyfork.dev/cdn/${POLYFORK_FIXTURE_ID}-hd-preview.glb`,
    });
    expect(detail.free).toBe(true);
  });

  it("drops a full-GLB URL that leaves the exact CDN contract", async () => {
    const forged = polyforkDetailPayload({
      download: {
        glb: "https://evil.example/cdn/cueca-musician-d71a2e.glb",
        mjs: "https://evil.example/cdn/cueca-musician-d71a2e.mjs",
        auth: "none",
      },
    });
    const detail = await new PolyforkClient(async () => Response.json(forged)).getAsset(
      POLYFORK_FIXTURE_ID,
    );
    expect(detail.download.glb).toBeUndefined();
    expect(detail.download.mjs).toBeUndefined();
    expect(detail.download.auth).toBe("none");

    for (const path of [
      `https://polyfork.dev/cdn/${POLYFORK_FIXTURE_ID}-preview.glb`,
      `https://polyfork.dev/dl/${POLYFORK_FIXTURE_ID}.glb`,
      `https://polyfork.dev/cdn/${POLYFORK_FIXTURE_ID}.glb?x=1`,
    ]) {
      const payload = polyforkDetailPayload({
        download: { glb: path, auth: "none" },
      });
      const unverified = await new PolyforkClient(async () => Response.json(payload)).getAsset(
        POLYFORK_FIXTURE_ID,
      );
      expect(unverified.download.glb).toBeUndefined();
    }
  });

  it("rejects a detail row for a different asset", async () => {
    const payload = polyforkDetailPayload({ id: "someone-else-123456" });
    await expect(
      new PolyforkClient(async () => Response.json(payload)).getAsset(POLYFORK_FIXTURE_ID),
    ).rejects.toMatchObject({ code: "POLYFORK_UPSTREAM_CHANGED" });
  });

  it("maps upstream failures to honest, bounded errors", async () => {
    const cases: Array<[Response, string]> = [
      [Response.json({ error: "no such asset" }, { status: 404 }), "POLYFORK_NOT_FOUND"],
      [
        new Response("", { status: 429, headers: { "retry-after": "30" } }),
        "POLYFORK_RATE_LIMITED",
      ],
      [new Response("", { status: 503 }), "POLYFORK_UPSTREAM_UNAVAILABLE"],
      [Response.json({ error: "unknown_class" }, { status: 400 }), "POLYFORK_INVALID_INPUT"],
      [new Response("not json"), "POLYFORK_UPSTREAM_CHANGED"],
      [
        new Response("{}", { headers: { "content-length": String(20 * 1024 * 1024) } }),
        "POLYFORK_UPSTREAM_CHANGED",
      ],
    ];
    for (const [response, code] of cases) {
      await expect(
        new PolyforkClient(async () => response).getAsset(POLYFORK_FIXTURE_ID),
      ).rejects.toMatchObject({ code });
    }
    const limited = new PolyforkClient(
      async () => new Response("", { status: 429, headers: { "retry-after": "30" } }),
    );
    await expect(limited.getAsset(POLYFORK_FIXTURE_ID)).rejects.toMatchObject({
      retryable: true,
      retryAfter: "30",
    });
  });

  it("propagates caller cancellation before any request", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const controller = new AbortController();
    controller.abort();
    await expect(
      new PolyforkClient(fetchMock).search({ query: "chair" }, { signal: controller.signal }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts only canonical ids and model-page URLs", () => {
    expect(POLYFORK_CLASSES).toContain("character");
    for (const value of [
      POLYFORK_FIXTURE_ID,
      "herring-gull-base",
      `https://polyfork.dev/asset/${POLYFORK_FIXTURE_ID}`,
    ]) {
      expect(parsePolyforkIdOrUrl(value)).toBe(
        value.startsWith("https://") ? POLYFORK_FIXTURE_ID : value,
      );
    }
    for (const value of [
      "",
      "../escape",
      `https://evil.example/asset/${POLYFORK_FIXTURE_ID}`,
      `https://polyfork.dev.evil.example/asset/${POLYFORK_FIXTURE_ID}`,
      `https://user:secret@polyfork.dev/asset/${POLYFORK_FIXTURE_ID}`,
      `https://polyfork.dev:8443/asset/${POLYFORK_FIXTURE_ID}`,
      `https://polyfork.dev/asset/${POLYFORK_FIXTURE_ID}#fragment`,
      `https://polyfork.dev/asset/${POLYFORK_FIXTURE_ID}/`,
      `//polyfork.dev/asset/${POLYFORK_FIXTURE_ID}`,
      `https://polyfork.dev/cdn/${POLYFORK_FIXTURE_ID}.glb`,
      `https://polyfork.dev/asset/${POLYFORK_FIXTURE_ID}-preview.glb`,
      "https://polyfork.dev/asset/UPPER-CASE",
      "x".repeat(300),
    ]) {
      expect(() => parsePolyforkIdOrUrl(value)).toThrowError(/Polyfork/i);
    }
  });
});

describe("Polyfork licence alternatives", () => {
  it("scopes the generator restriction to the Polyfork licence and exempts CC BY mesh files", () => {
    // The official /licensing page: the generator ban covers the .mjs/HD/renders and mesh files
    // taken under the Polyfork licence, and "CC BY 4.0 sets no such limit on the free mesh files".
    expect(POLYFORK_TERMS).toContain("redistribution and sale of the mesh are allowed");
    expect(POLYFORK_TERMS).toMatch(
      /under this licence do not use the files to build or train a commercial 3D asset generator/i,
    );
    expect(POLYFORK_TERMS).toMatch(/CC BY 4\.0 sets no limit on building or training/i);
    expect(POLYFORK_TERMS).not.toMatch(/do not use any of it/i);

    const license = polyforkLicense(
      `Cueca Musician by Polyfork (https://polyfork.dev/asset/${POLYFORK_FIXTURE_ID}), CC BY 4.0`,
    );
    expect(license).toMatchObject({
      name: "CC BY 4.0 or Polyfork licence",
      commercialUse: "yes",
      attributionRequired: "yes",
    });
    expect(license.evidence).toContain("CC BY 4.0 credit line: Cueca Musician by Polyfork");
    expect(license.evidence).not.toMatch(/CC0|do not use any of it/i);
  });

  it("documents both licence branches in the provider and tools docs", async () => {
    for (const path of ["../docs/tools.md", "../docs/providers.md"]) {
      const doc = (await readFile(new URL(path, import.meta.url), "utf8")).replace(/\s+/gu, " ");
      expect(doc).toContain("CC BY 4.0");
      expect(doc).toMatch(/CC BY 4\.0 sets no such limit on the free mesh files/i);
      expect(doc).not.toMatch(/using any of it to build or train/i);
    }
  });
});
