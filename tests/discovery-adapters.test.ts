import { describe, expect, it, vi } from "vitest";
import { createAssetAdapters } from "../src/discovery/adapters.js";
import { PolyHavenClient } from "../src/polyhaven/client.js";
import { AmbientCgClient } from "../src/ambientcg/client.js";
import { SmithsonianClient } from "../src/smithsonian/client.js";
import { SketchfabClient } from "../src/sketchfab/client.js";
import { KenneyClient, parseKenneyDetail, parseKenneyListing } from "../src/kenney/client.js";

const signal = () => new AbortController().signal;
const model = { name: "Chair", type: 2, tags: ["wood"], authors: { Artist: "all" } };
const file = (name: string) => ({
  url: `https://dl.polyhaven.org/file/${name}`,
  size: 100,
  md5: "a".repeat(32),
});
const poly = (files: unknown, type = 2) =>
  new PolyHavenClient(
    vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      return Response.json(
        path.startsWith("/files/")
          ? files
          : path === "/assets"
            ? { chair: { ...model, type } }
            : { ...model, type },
      );
    }),
  );
const adapter = (client: PolyHavenClient) =>
  createAssetAdapters({ polyhaven: client }).find((entry) => entry.id === "polyhaven")!;

describe("federated provider adapters", () => {
  it("prefers GLB at 2k and returns an honest unavailable-format alternative", async () => {
    const provider = adapter(
      poly({
        glb: { "1k": { glb: file("chair_1k.glb") }, "2k": { glb: file("chair_2k.glb") } },
        gltf: { "2k": { gltf: file("chair.gltf") } },
      }),
    );
    const detail = await provider.get("chair", {}, signal());
    expect(detail.files.map((entry) => entry.path)).toEqual(["chair_2k.glb"]);
    expect(detail.asset.canDownloadNow).toBe(true);
    const unavailable = await provider.get("chair", { format: "fbx" }, signal());
    expect(unavailable.files).toEqual([]);
    expect(unavailable.asset.canDownloadNow).toBe(false);
    expect(unavailable.alternatives).toContain("glb/2k");
  });

  it("preserves exact glTF companions and rejects unsafe companions rather than silently dropping them", async () => {
    const provider = adapter(
      poly({
        gltf: {
          "2k": {
            gltf: {
              ...file("chair.gltf"),
              include: { "textures/diff.jpg": file("diff.jpg"), "chair.bin": file("chair.bin") },
            },
          },
        },
      }),
    );
    const detail = await provider.get("chair", { format: "gltf" }, signal());
    expect(detail.files.map((entry) => entry.path)).toEqual([
      "chair.gltf",
      "textures/diff.jpg",
      "chair.bin",
    ]);
    expect(detail.files[1]?.dependencyOf).toBe(detail.files[0]?.id);
    for (const path of [
      "../escape.bin",
      "/escape.bin",
      "textures\\escape.bin",
      "%2e%2e/escape.bin",
    ]) {
      await expect(
        adapter(
          poly({
            gltf: {
              "2k": { gltf: { ...file("chair.gltf"), include: { [path]: file("escape.bin") } } },
            },
          }),
        ).get("chair", {}, signal()),
      ).rejects.toThrow();
    }
    await expect(
      adapter(
        poly({
          gltf: {
            "2k": {
              gltf: {
                ...file("chair.gltf"),
                include: {
                  "chair.bin": { ...file("chair.bin"), url: "https://evil.example/secret" },
                },
              },
            },
          },
        }),
      ).get("chair", {}, signal()),
    ).rejects.toThrow();
    await expect(
      adapter(
        poly({
          gltf: {
            "2k": {
              gltf: { ...file("chair.gltf"), include: { "chair.gltf": file("conflict.gltf") } },
            },
          },
        }),
      ).get("chair", {}, signal()),
    ).rejects.toThrow("colliding paths");
  });

  it("requires every explicitly requested material map role", async () => {
    const provider = adapter(poly({ diffuse: { "2k": { png: file("diff.png") } } }, 1));
    const detail = await provider.get("chair", { mapRoles: ["diffuse", "normal"] }, signal());
    expect(detail.files).toEqual([]);
    expect(detail.selectionExplanation).toContain("map role is unavailable");
  });

  it("checks only three Poly Haven search candidates and leaves unchecked capability unknown", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) =>
      new URL(String(input)).pathname === "/assets"
        ? Response.json(
            Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`chair${i}`, model])),
          )
        : Response.json({ glb: { "2k": { glb: file("chair.glb") } } }),
    );
    const result = await adapter(new PolyHavenClient(fetchMock)).search(
      "chair",
      ["3d-model"],
      5,
      signal(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(result.items.slice(0, 3).every((item) => item.canDownloadNow)).toBe(true);
    expect(result.items[3]).toMatchObject({ downloadStatus: "unknown", canDownloadNow: false });
  });

  it("keeps Smithsonian rights unknown and Sketchfab acquisition authenticated", async () => {
    const smithsonian = new SmithsonianClient(async () =>
      Response.json({
        rows: [
          {
            title: "Apollo",
            content: {
              model_url: "3d_package:apollo",
              file_type: "glb",
              uri: "https://3d-api.si.edu/content/document/3d_package:apollo/a.glb",
            },
          },
        ],
        rowCount: 1,
      }),
    );
    const sketchfab = new SketchfabClient(
      async () =>
        Response.json({
          uid: "chair",
          name: "Chair",
          viewerUrl: "https://sketchfab.com/models/chair",
          isDownloadable: true,
          license: {
            label: "CC Attribution",
            slug: "by",
            url: "https://creativecommons.org/licenses/by/4.0/",
          },
        }),
      { token: null },
    );
    const providers = createAssetAdapters({ smithsonian, sketchfab });
    const museum = await providers
      .find((entry) => entry.id === "smithsonian")!
      .get("apollo", {}, signal());
    expect(museum.asset.free).toBe("unknown");
    expect(museum.asset.license.commercialUse).toBe("unknown");
    expect(museum.files).toEqual([]);
    const model = await providers
      .find((entry) => entry.id === "sketchfab")!
      .get("chair", {}, signal());
    expect(model.asset.downloadStatus).toBe("auth-required");
    expect(model.files).toEqual([]);
    expect(model.asset.license.attributionRequired).toBe("yes");
  });

  it("keeps generic Sketchfab metadata anonymous even when an environment token exists", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({
        uid: "chair",
        name: "Chair",
        viewerUrl: "https://sketchfab.com/models/chair",
        isDownloadable: true,
      }),
    );
    vi.stubEnv("SKETCHFAB_API_TOKEN", "private-token");
    vi.stubGlobal("fetch", fetchMock);
    try {
      await createAssetAdapters()
        .find((entry) => entry.id === "sketchfab")!
        .get("chair", {}, signal());
      expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty("authorization");
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("selects ambientCG archives without mislabeling them as GLB", async () => {
    const ambientcg = new AmbientCgClient(async () =>
      Response.json({
        assets: [
          {
            id: "Apple",
            title: "Apple",
            type: "3d-model",
            url: "https://ambientcg.com/a/Apple",
            downloads: [
              {
                attributes: "HQ-2K-PNG",
                extension: "zip",
                size: 100,
                url: "https://ambientcg.com/get?file=Apple_HQ-2K-PNG.zip",
              },
            ],
          },
        ],
        totalResults: 1,
      }),
    );
    const provider = createAssetAdapters({ ambientcg }).find((entry) => entry.id === "ambientcg")!;
    expect((await provider.get("Apple", {}, signal())).files[0]).toMatchObject({
      path: "Apple_HQ-2K-PNG.zip",
      role: "archive",
    });
    expect((await provider.get("Apple", { format: "glb" }, signal())).files).toEqual([]);
  });
});

const listing = `<h1>Assets</h1><div class='asset'><h2><a href='https://kenney.nl/assets/nature-kit'>Nature Kit</a></h2><a href='/assets/category:3D'>3D</a></div><a href='/assets/page:2'>2</a>`;
const detail = `<h1>Nature Kit</h1><table><tr><td>Category</td><td><a href='/assets/category:3D'>3D</a></td></tr><tr><td>License</td><td><a href='https://creativecommons.org/publicdomain/zero/1.0/'>Creative Commons CC0</a></td></tr></table><p>The game assets you're about to download are available for free.</p><a id='donate-text' href='https://kenney.nl/media/pages/assets/nature-kit/abc-123/kenney_nature-kit.zip'>Continue without donating...</a>`;

describe("bounded Kenney metadata", () => {
  it("parses one listing and item-specific license/free/download evidence", () => {
    expect(parseKenneyListing(listing)).toMatchObject({
      entries: [{ id: "nature-kit", title: "Nature Kit" }],
      truncated: true,
    });
    expect(parseKenneyDetail(detail, "nature-kit")).toMatchObject({
      licenseConfirmed: true,
      freeConfirmed: true,
      downloadUrl: expect.stringContaining("kenney_nature-kit.zip"),
    });
    expect(
      parseKenneyDetail(
        detail
          .replace("Creative Commons CC0", "Unknown terms")
          .replace(
            "https://creativecommons.org/publicdomain/zero/1.0/",
            "https://example.com/terms",
          ),
        "nature-kit",
      ).licenseConfirmed,
    ).toBe(false);
    expect(() =>
      parseKenneyDetail(
        detail.replace("https://kenney.nl/media/", "https://evil.example/media/"),
        "nature-kit",
      ),
    ).toThrow();
    expect(() => parseKenneyListing("<html>Different page layout</html>")).toThrow();
  });
  it("makes one listing request, no catalog crawl, and rejects redirect responses", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(listing));
    await new KenneyClient(fetchMock, { minimumIntervalMs: 0 }).search("nature", signal());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("error");
    await expect(
      new KenneyClient(
        async () =>
          new Response(null, { status: 302, headers: { location: "https://evil.example" } }),
        { minimumIntervalMs: 0 },
      ).search("nature", signal()),
    ).rejects.toThrow();
  });

  it("returns rate-limit evidence and prevents another fetch before Retry-After", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 429, headers: { "retry-after": "60" } }),
    );
    const client = new KenneyClient(fetchMock, { minimumIntervalMs: 0 });
    await expect(client.search("nature", signal())).rejects.toMatchObject({
      code: "KENNEY_RATE_LIMITED",
      retryAfter: "60",
    });
    const controller = new AbortController();
    const next = client.search("tree", controller.signal);
    controller.abort();
    await expect(next).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
