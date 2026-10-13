import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Document, NodeIO } from "@gltf-transform/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  BlendkitClient,
  BlendkitError,
  loopbackOrigin,
  safeTaskText,
} from "../src/blendkit/client.js";
import {
  BlendkitProvider,
  blendkitConfig,
  importBlendkitAsset,
  rightsDecision,
  type BlendkitImportInput,
} from "../src/blendkit/provider.js";
import { AssetFederation } from "../src/discovery/federation.js";
import { DirectAssetDownloader } from "../src/download/direct-asset-downloader.js";
import { createBlendkitImportHandler, createBlendkitStatusHandler } from "../src/tools/blendkit.js";

const SECRET = "user-owned-api-key-must-not-leak";
const ID = "0f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b";
const BASE = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "blendkit-test-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A self-authored, rights-clear GLB: one textured triangle. */
async function fixtureGlb(): Promise<Uint8Array> {
  const document = new Document();
  const buffer = document.createBuffer();
  const position = document
    .createAccessor()
    .setType("VEC3")
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
    .setBuffer(buffer);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
    "base64",
  );
  const texture = document.createTexture("albedo").setImage(png).setMimeType("image/png");
  const material = document.createMaterial("Painted").setBaseColorTexture(texture);
  const mesh = document
    .createMesh("Triangle")
    .addPrimitive(
      document.createPrimitive().setAttribute("POSITION", position).setMaterial(material),
    );
  document.createScene().addChild(document.createNode("Triangle").setMesh(mesh));
  return new NodeIO().writeBinary(document);
}

type FakeTask = {
  task_id: string;
  task_type: string;
  status: string;
  progress: number;
  message: string;
  result: unknown;
  data: unknown;
};

type Item = Record<string, unknown>;
function item(overrides: Item = {}): Item {
  return {
    id: ID,
    assetBaseId: BASE,
    name: "Oak Chair",
    assetType: "model",
    isFree: true,
    canDownload: true,
    license: "royalty_free",
    author: { fullName: "Self Author" },
    thumbnailMiddleUrl: "https://thumbs.example/chair.png",
    files: [
      { fileType: "thumbnail", downloadUrl: "https://www.blendkit.com/api/v1/download/thumb" },
      {
        fileType: "blend",
        downloadUrl: "https://www.blendkit.com/api/v1/download/1111",
        fileUploadSize: 100,
      },
      {
        fileType: "resolution_2K",
        downloadUrl: "https://www.blendkit.com/api/v1/download/2222",
        fileUploadSize: 50,
      },
      { fileType: "zip_file", downloadUrl: "https://www.blendkit.com/api/v1/download/3333" },
    ],
    ...overrides,
  };
}

/** Stand-in for the official Client: same routes, task ids and once-only /report hand-out. */
class FakeClient {
  server!: Server;
  origin = "";
  requests: { path: string; body: Record<string, unknown> }[] = [];
  tasks = new Map<string, FakeTask>();
  searchResults: Item[] = [item()];
  onDownload: (body: Record<string, unknown>, task: FakeTask) => Promise<void> | void = () => {};
  onRun: (body: Record<string, unknown>, task: FakeTask) => Promise<void> | void = () => {};
  statusBody = JSON.stringify({ clientVersion: "1.13.6", softwares: null });

  async start(): Promise<this> {
    this.server = createServer(async (req, res) => {
      const body = await read(req);
      const path = req.url ?? "/";
      this.requests.push({ path, body });
      const json = (value: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      const task = (type: string): FakeTask => {
        const created: FakeTask = {
          task_id: randomUUID(),
          task_type: type,
          status: "created",
          progress: 0,
          message: "",
          result: null,
          data: body,
        };
        this.tasks.set(created.task_id, created);
        json({ task_id: created.task_id });
        return created;
      };
      if (path === "/addons/list") return void res.end(this.statusBody);
      if (path === "/tools/list")
        return json({ client_version: "1.13.6", tools: [{ id: "export_glb" }] });
      if (path === "/assets/search") {
        const created = task("search");
        Object.assign(created, {
          status: "finished",
          result: { count: 1, results: this.searchResults },
        });
        return;
      }
      if (path === "/assets/download")
        return void (await this.onDownload(body, task("asset_download")));
      if (path === "/tools/run") return void (await this.onRun(body, task("run_blender_script")));
      if (path === "/assets/cancel_download") {
        const cancelled = this.tasks.get(String(body.task_id));
        if (cancelled) cancelled.status = "cancelled";
        return void res.end();
      }
      if (path === "/report") {
        const all = [...this.tasks.values()];
        for (const t of all) if (t.status !== "created") this.tasks.delete(t.task_id);
        return json(all);
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    cleanups.push(() => new Promise((resolve) => this.server.close(resolve)));
    return this;
  }
  paths(): string[] {
    return this.requests.map((request) => request.path);
  }
}

async function read(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString();
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

/** Download writes a placeholder .blend where the real Client would; the run writes the GLB fixture. */
function happyPath(fake: FakeClient): void {
  fake.onDownload = async (body, task) => {
    const dir = join((body.download_dirs as string[])[0]!, `oak-chair_${ID}`);
    await mkdir(dir, { recursive: true });
    const file = join(dir, "oak-chair_2K.blend");
    await writeFile(file, "BLENDER-v405 self-authored placeholder");
    Object.assign(task, {
      status: "finished",
      progress: 100,
      result: { file_paths: [file], url: "https://signed.example/x?sig=1" },
    });
  };
  fake.onRun = async (body, task) => {
    await writeFile(String(body.output_path), await fixtureGlb());
    Object.assign(task, { status: "finished", result: { file_path: body.output_path } });
  };
}

function provider(
  fake: FakeClient,
  overrides: Partial<ConstructorParameters<typeof BlendkitProvider>[0]> = {},
) {
  return new BlendkitProvider({
    client: new BlendkitClient({ baseUrl: fake.origin, pollIntervalMs: 5, addonVersion: "0.11.0" }),
    clientUrl: fake.origin,
    blenderPath: "/opt/blender/blender",
    permissionEvidence: "test: documented permission stand-in",
    apiKey: SECRET,
    ...overrides,
  });
}

function importInput(
  outputDir: string,
  overrides: Partial<BlendkitImportInput> = {},
): BlendkitImportInput {
  return {
    assetId: `blendkit:${ID}`,
    outputDir,
    purpose: "project-use",
    acceptLicense: true,
    projectUseConsent: true,
    ...overrides,
  };
}

async function rejection(work: Promise<unknown>): Promise<BlendkitError> {
  const error = await work.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(BlendkitError);
  return error as BlendkitError;
}

const toolOptions = { toolVersion: "test" };

describe("Blendkit-Client connection", () => {
  it("accepts only plain-HTTP loopback origins", () => {
    for (const good of ["http://127.0.0.1:62485", "http://localhost:1", "http://[::1]:62485/"])
      expect(loopbackOrigin(good)).toMatch(/^http:\/\//u);
    for (const bad of [
      "https://127.0.0.1:62485",
      "http://192.168.1.10:62485",
      "http://example.com:62485",
      "http://user:pw@127.0.0.1:62485",
      "http://127.0.0.1:62485/api",
      "http://127.0.0.1.example.com:62485",
      "file:///etc/passwd",
    ])
      expect(() => loopbackOrigin(bad), bad).toThrow(BlendkitError);
  });

  it("removes URLs and control characters from Client task text", () => {
    expect(safeTaskText("failed https://cdn.example/f.blend?X-Amz-Signature=abc\nnext")).toBe(
      "failed <url> next",
    );
  });

  it("reports health from local endpoints only, without subscribing to /report", async () => {
    const fake = await new FakeClient().start();
    const output = await createBlendkitStatusHandler(provider(fake))({});
    expect(output.structuredContent).toMatchObject({
      reachable: true,
      clientVersion: "1.13.6",
      conversionRecipeAvailable: true,
      liveAccess: "enabled",
      apiKeyConfigured: true,
    });
    expect(fake.paths()).toEqual(["/addons/list", "/tools/list"]);
    expect(JSON.stringify(output)).not.toContain(SECRET);
  });

  it("gives actionable setup when the Client is not running", async () => {
    const fake = await new FakeClient().start();
    const offline = provider(fake, {
      client: new BlendkitClient({ baseUrl: "http://127.0.0.1:9" }),
      permissionEvidence: undefined,
      apiKey: undefined,
    } as never);
    const output = await createBlendkitStatusHandler(offline)({});
    expect(output.structuredContent).toMatchObject({
      reachable: false,
      liveAccess: "disabled",
      apiKeyConfigured: false,
    });
    const setup = output.structuredContent.setup.join(" ");
    expect(setup).toContain("Start the official Blendkit-Client");
    expect(setup).toContain("BLENDKIT_PROVIDER_PERMISSION");
    expect(setup).toContain("https://www.blendkit.com/asset-gallery");
  });

  it("caps Client response size", async () => {
    const fake = await new FakeClient().start();
    fake.statusBody = JSON.stringify({ clientVersion: "1.13.6", pad: "x".repeat(4096) });
    const client = new BlendkitClient({ baseUrl: fake.origin, maxResponseBytes: 1024 });
    expect((await rejection(client.status(AbortSignal.timeout(5000)))).code).toBe(
      "BLENDKIT_INVALID_RESPONSE",
    );
  });

  it("reads configuration from the environment and rejects unusable values", () => {
    expect(blendkitConfig({})).toEqual({ clientUrl: "http://127.0.0.1:62485", blenderPath: "" });
    expect(() => blendkitConfig({ BLENDKIT_PROVIDER_PERMISSION: "yes" })).toThrow();
    expect(() => blendkitConfig({ BLENDKIT_BLENDER_PATH: "blender" })).toThrow();
  });
});

describe("Blendkit permission and rights gates", () => {
  it("keeps live search, lookup and import off without documented permission, sending nothing", async () => {
    const fake = await new FakeClient().start();
    const gated = provider(fake, { permissionEvidence: undefined } as never);
    const out = await tempDir();
    for (const work of [
      gated.search("chair", ["3d-model"], 5, AbortSignal.timeout(5000)),
      gated.get(ID, {}, AbortSignal.timeout(5000)),
      importBlendkitAsset(gated, importInput(out), AbortSignal.timeout(5000), toolOptions),
    ])
      expect((await rejection(work)).code).toBe("BLENDKIT_PERMISSION_REQUIRED");
    expect(fake.requests).toEqual([]);
  });

  it("lists Blendkit as a manual provider in federated search until permission is configured", async () => {
    const federation = new AssetFederation(
      [],
      new DirectAssetDownloader({ downloadDir: await tempDir() }),
      {
        toolVersion: "test",
      },
    );
    await expect(
      federation.search({ query: "chair", providers: ["blendkit"] }),
    ).rejects.toMatchObject({
      reports: [expect.objectContaining({ provider: "blendkit", status: "manual" })],
    });
  });

  it("decides rights per item and fails closed", () => {
    expect(() => rightsDecision(undefined, "project-use", true)).toThrow(/unknown/u);
    expect(() => rightsDecision("editorial", "project-use", true)).toThrow(BlendkitError);
    expect(() => rightsDecision("royalty_free", "redistribution", true)).toThrow(/Royalty Free/u);
    expect(() => rightsDecision("royalty_free", "project-use", false)).toThrow(
      /projectUseConsent/u,
    );
    expect(() => rightsDecision("cc_zero", "redistribution", false)).toThrow(/projectUseConsent/u);
    expect(rightsDecision("royalty_free", "project-use", true).redistributionAllowed).toBe(false);
    expect(rightsDecision("cc_zero", "redistribution", true).redistributionAllowed).toBe(true);
  });
});

describe("Blendkit discovery", () => {
  it("maps provider items to federated assets and keeps query text from adding filters", async () => {
    const fake = await new FakeClient().start();
    const blendkit = provider(fake);
    fake.searchResults = [
      item(),
      item({ id: "not-a-uuid" }),
      item({ id: randomUUID(), assetType: "scene" }),
    ];
    const federation = new AssetFederation(
      [blendkit],
      new DirectAssetDownloader({ downloadDir: await tempDir() }),
      {
        toolVersion: "test",
      },
    );
    const result = await federation.search({
      query: "oak chair asset_type:scene is_free:false",
      providers: ["blendkit"],
      types: ["3d-model"],
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      assetId: `blendkit:${ID}`,
      sourceUrl: `https://www.blendkit.com/asset-gallery-detail/${BASE}/`,
      free: "yes",
      canDownloadNow: false,
      license: { name: "Blendkit Royalty Free", commercialUse: "yes" },
    });
    const search = fake.requests.find((request) => request.path === "/assets/search")!;
    const url = new URL(String(search.body.urlquery));
    expect(url.origin + url.pathname).toBe("https://www.blendkit.com/api/v1/search/");
    expect(url.searchParams.get("query")).toBe(
      "oak chair asset_type scene is_free false asset_type:model is_free:true sexualizedContent:false order:_score",
    );
    // The provider key is sent to the loopback Client only, never back to the caller.
    expect(search.body.api_key).toBe(SECRET);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("returns an honest asset_get detail that points to the consented import tool", async () => {
    const fake = await new FakeClient().start();
    const federation = new AssetFederation(
      [provider(fake)],
      new DirectAssetDownloader({ downloadDir: await tempDir() }),
      {
        toolVersion: "test",
      },
    );
    const detail = await federation.get({ assetId: `blendkit:${ID}` });
    expect(detail.plan).toBeNull();
    expect(detail.providerDetails).toMatchObject({ acquireWith: "blendkit_import_asset" });
    const search = fake.requests.find((request) => request.path === "/assets/search")!;
    expect(new URL(String(search.body.urlquery)).searchParams.get("query")).toBe(`asset_id:${ID}`);
  });

  it("rejects a lookup whose answer is a different item", async () => {
    const fake = await new FakeClient().start();
    fake.searchResults = [item({ id: randomUUID() })];
    expect((await rejection(provider(fake).lookup(ID, AbortSignal.timeout(5000)))).code).toBe(
      "BLENDKIT_NOT_FOUND",
    );
  });
});

describe("Blendkit import", () => {
  it("downloads one consented item through the Client, converts it with export_glb and records provenance", async () => {
    const fake = await new FakeClient().start();
    happyPath(fake);
    const out = await tempDir();
    const progress: number[] = [];
    const result = await importBlendkitAsset(
      provider(fake),
      importInput(out),
      AbortSignal.timeout(10_000),
      {
        toolVersion: "test",
        onProgress: (update) => progress.push(update.progress),
      },
    );
    expect(result.glbPath).toBe(join(out, `blendkit-${ID}.glb`));
    expect(result.inspection).toMatchObject({ meshes: 1, triangles: 1, textures: 1, warnings: [] });
    expect(result.inspection.materials[0]).toMatchObject({ baseColorTexture: true });
    expect(result.redistribution.redistributionAllowed).toBe(false);
    const provenance = JSON.parse(await readFile(result.provenancePath, "utf8"));
    expect(provenance).toMatchObject({
      assetId: `blendkit:${ID}`,
      assetBaseId: BASE,
      sourceUrl: `https://www.blendkit.com/asset-gallery-detail/${BASE}/`,
      license: { name: "Blendkit Royalty Free" },
      purpose: "project-use",
      projectUseConsent: true,
      providerPermissionEvidence: "test: documented permission stand-in",
      conversion: { recipe: "export_glb" },
      source: { file: "oak-chair_2K.blend" },
    });
    expect(provenance.output.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect((await readdir(out)).sort()).toEqual([
      `blendkit-${ID}.glb`,
      `blendkit-${ID}.provenance.json`,
    ]);
    expect(JSON.stringify(provenance) + JSON.stringify(result)).not.toMatch(
      new RegExp(`${SECRET}|signed\\.example`, "u"),
    );

    const download = fake.requests.find((request) => request.path === "/assets/download")!.body;
    const files = (download.asset_data as { files: { fileType: string }[] }).files.map(
      (file) => file.fileType,
    );
    expect(files).toEqual(["blend", "resolution_2K"]);
    const run = fake.requests.find((request) => request.path === "/tools/run")!.body;
    expect(run).toMatchObject({
      script_id: "export_glb",
      blender_exe_path: "/opt/blender/blender",
    });
    expect(run).not.toHaveProperty("script_path");
    expect(progress.length).toBeGreaterThan(0);
  });

  it("refuses paid items, unknown licenses, royalty-free redistribution and missing consent before downloading", async () => {
    const fake = await new FakeClient().start();
    happyPath(fake);
    const out = await tempDir();
    const cases: [Item, Partial<BlendkitImportInput>, string][] = [
      [{ isFree: false }, {}, "BLENDKIT_PAID_DENIED"],
      [{ license: undefined }, {}, "BLENDKIT_LICENSE_DENIED"],
      [{}, { purpose: "redistribution" }, "BLENDKIT_LICENSE_DENIED"],
      [{}, { projectUseConsent: false }, "BLENDKIT_CONSENT_REQUIRED"],
      [
        { canDownload: false, canDownloadError: { type: "anonymous_user" } },
        {},
        "BLENDKIT_AUTH_REQUIRED",
      ],
      [{ assetType: "material" }, {}, "BLENDKIT_UNSUPPORTED"],
    ];
    for (const [overrides, input, code] of cases) {
      fake.searchResults = [item(overrides)];
      const error = await rejection(
        importBlendkitAsset(
          provider(fake),
          importInput(out, input),
          AbortSignal.timeout(5000),
          toolOptions,
        ),
      );
      expect(error.code, code).toBe(code);
    }
    expect(fake.paths()).not.toContain("/assets/download");
  });

  it("accepts a CC0 item for redistribution", async () => {
    const fake = await new FakeClient().start();
    happyPath(fake);
    fake.searchResults = [item({ license: "cc_zero" })];
    const result = await importBlendkitAsset(
      provider(fake),
      importInput(await tempDir(), { purpose: "redistribution" }),
      AbortSignal.timeout(10_000),
      toolOptions,
    );
    expect(result.redistribution.redistributionAllowed).toBe(true);
    expect(result.license.name).toBe("CC0 1.0");
  });

  it("never forwards download links outside the provider API, so the key cannot leave", async () => {
    const fake = await new FakeClient().start();
    happyPath(fake);
    fake.searchResults = [
      item({
        files: [
          { fileType: "blend", downloadUrl: "https://evil.example/api/v1/download/1" },
          { fileType: "blend", downloadUrl: "http://www.blendkit.com/api/v1/download/1" },
          {
            fileType: "blend",
            downloadUrl: "https://www.blendkit.com.evil.example/api/v1/download/1",
          },
          {
            fileType: "blend",
            downloadUrl: "https://www.blendkit.com/redirect?to=https://evil.example",
          },
          { fileType: "zip_file", downloadUrl: "https://www.blendkit.com/api/v1/download/2" },
          {
            fileType: "blend",
            downloadUrl: "https://www.blendkit.com/api/v1/download/3",
            fileUploadSize: 10 ** 12,
          },
        ],
      }),
    ];
    const error = await rejection(
      importBlendkitAsset(
        provider(fake),
        importInput(await tempDir()),
        AbortSignal.timeout(5000),
        toolOptions,
      ),
    );
    expect(error.code).toBe("BLENDKIT_UNSUPPORTED");
    expect(fake.paths()).not.toContain("/assets/download");
  });

  it("rejects a reported file outside its staging directory and leaves nothing behind", async () => {
    const fake = await new FakeClient().start();
    happyPath(fake);
    const elsewhere = join(await tempDir(), "outside.blend");
    await writeFile(elsewhere, "x");
    fake.onDownload = (_body, task) =>
      void Object.assign(task, { status: "finished", result: { file_paths: [elsewhere] } });
    const out = await tempDir();
    const error = await rejection(
      importBlendkitAsset(provider(fake), importInput(out), AbortSignal.timeout(5000), toolOptions),
    );
    expect(error.code).toBe("BLENDKIT_INVALID_RESPONSE");
    expect(await readdir(out)).toEqual([]);
    expect(fake.paths()).not.toContain("/tools/run");
  });

  it("cancels the Client download task when the caller aborts", async () => {
    const fake = await new FakeClient().start();
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    fake.onDownload = (_body, task) => {
      Object.assign(task, { progress: 30, message: "Downloading" });
      started();
    };
    const out = await tempDir();
    const controller = new AbortController();
    const work = importBlendkitAsset(
      provider(fake),
      importInput(out),
      controller.signal,
      toolOptions,
    );
    await running;
    controller.abort(new Error("caller cancelled"));
    await expect(work).rejects.toThrow("caller cancelled");
    const cancel = fake.requests.find((request) => request.path === "/assets/cancel_download");
    const download = fake.requests.find((request) => request.path === "/assets/download");
    expect(cancel?.body).toMatchObject({ app_id: download?.body.app_id });
    expect(typeof cancel?.body.task_id).toBe("string");
    expect(await readdir(out)).toEqual([]);
  });

  it("reports a failed Client task with sanitized text", async () => {
    const fake = await new FakeClient().start();
    fake.onDownload = (_body, task) =>
      void Object.assign(task, {
        status: "error",
        message: "user cannot download https://cdn.example/x.blend?token=abc",
      });
    const error = await rejection(
      importBlendkitAsset(
        provider(fake),
        importInput(await tempDir()),
        AbortSignal.timeout(5000),
        toolOptions,
      ),
    );
    expect(error.code).toBe("BLENDKIT_TASK_FAILED");
    expect(error.message).toContain("user cannot download <url>");
    expect(error.message).not.toContain("token=abc");
  });

  it("turns a recipe failure or an unreadable GLB into a conversion error", async () => {
    const fake = await new FakeClient().start();
    happyPath(fake);
    fake.onRun = (_body, task) =>
      void Object.assign(task, { status: "error", message: "blender exited with error" });
    const out = await tempDir();
    expect(
      (
        await rejection(
          importBlendkitAsset(
            provider(fake),
            importInput(out),
            AbortSignal.timeout(5000),
            toolOptions,
          ),
        )
      ).code,
    ).toBe("BLENDKIT_CONVERSION_FAILED");
    fake.onRun = async (body, task) => {
      await writeFile(String(body.output_path), "not a glb");
      Object.assign(task, { status: "finished", result: { file_path: body.output_path } });
    };
    expect(
      (
        await rejection(
          importBlendkitAsset(
            provider(fake),
            importInput(out),
            AbortSignal.timeout(5000),
            toolOptions,
          ),
        )
      ).code,
    ).toBe("BLENDKIT_CONVERSION_FAILED");
    expect(await readdir(out)).toEqual([]);
  });

  it("never overwrites an existing import", async () => {
    const fake = await new FakeClient().start();
    happyPath(fake);
    const out = await tempDir();
    await writeFile(join(out, `blendkit-${ID}.glb`), "existing");
    expect(
      (
        await rejection(
          importBlendkitAsset(
            provider(fake),
            importInput(out),
            AbortSignal.timeout(5000),
            toolOptions,
          ),
        )
      ).code,
    ).toBe("BLENDKIT_OUTPUT_EXISTS");
    expect(await readFile(join(out, `blendkit-${ID}.glb`), "utf8")).toBe("existing");
  });

  it("validates tool input and returns coded errors without the key", async () => {
    const fake = await new FakeClient().start();
    const handler = createBlendkitImportHandler(provider(fake), "test");
    const out = await tempDir();
    for (const input of [
      { ...importInput(out), acceptLicense: false },
      { ...importInput(out), assetId: "blendkit:../../etc" },
      { ...importInput(out), resolution: "resolution_16K" },
      { ...importInput(out), extra: true },
    ]) {
      const output = await handler(input as never);
      expect(output).toHaveProperty("isError", true);
      expect(JSON.parse(output.content[0]!.text)).toMatchObject({ code: "BLENDKIT_INVALID_INPUT" });
    }
    fake.searchResults = [item({ isFree: false })];
    const paid = await handler(importInput(out));
    expect(JSON.parse(paid.content[0]!.text)).toMatchObject({ code: "BLENDKIT_PAID_DENIED" });
    expect(JSON.stringify(paid)).not.toContain(SECRET);
  });
});
