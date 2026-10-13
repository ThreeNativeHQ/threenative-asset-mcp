import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
  UnconfirmedStopError,
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
  /** Test controls: hold a reply, act on a freshly created search task, break /report. */
  replyDelayMs = new Map<string, number>();
  onSearchTask: (task: FakeTask) => void = () => {};
  badReport = false;
  reportStatus = 200;
  cancelStatus = 200;
  cancelIgnored = false;

  async start(): Promise<this> {
    this.server = createServer(async (req, res) => {
      const body = await read(req);
      const path = req.url ?? "/";
      this.requests.push({ path, body });
      const json = (value: unknown) => {
        const send = () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(value));
        };
        const wait = this.replyDelayMs.get(path) ?? 0;
        if (wait) setTimeout(send, wait);
        else send();
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
        this.onSearchTask(created);
        return;
      }
      if (path === "/assets/download")
        return void (await this.onDownload(body, task("asset_download")));
      if (path === "/tools/run") return void (await this.onRun(body, task("run_blender_script")));
      if (path === "/assets/cancel_download") {
        if (this.cancelStatus !== 200) return void res.writeHead(this.cancelStatus).end();
        const cancelled = this.tasks.get(String(body.task_id));
        if (cancelled && !this.cancelIgnored) cancelled.status = "cancelled";
        return void res.end();
      }
      if (path === "/report") {
        if (this.reportStatus !== 200) return void res.writeHead(this.reportStatus).end();
        if (this.badReport) return json({ not: "a list" });
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
    client: new BlendkitClient({
      baseUrl: fake.origin,
      pollIntervalMs: 5,
      cancelConfirmMs: 300,
      addonVersion: "0.11.0",
    }),
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
    // Raw redistribution is refused for every license, CC0 included: Blendkit's Terms apply the
    // project-only rules to CC0 items too, and no independent permission exists.
    for (const license of ["royalty_free", "cc_zero", undefined, "editorial"])
      for (const consent of [true, false])
        expect(() => rightsDecision(license, "redistribution", consent), `${license}`).toThrow(
          expect.objectContaining({ code: "BLENDKIT_LICENSE_DENIED" }),
        );
    expect(() => rightsDecision("royalty_free", "project-use", false)).toThrow(
      /projectUseConsent/u,
    );
    expect(() => rightsDecision("cc_zero", "project-use", false)).toThrow(/projectUseConsent/u);
    expect(rightsDecision("royalty_free", "project-use", true).redistributionAllowed).toBe(false);
    const cc0 = rightsDecision("cc_zero", "project-use", true);
    expect(cc0.redistributionAllowed).toBe(false);
    expect(cc0.restriction).toMatch(/CC0 label does not grant/u);
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
    expect(result.warnings).toEqual([]);
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
      [{ license: "cc_zero" }, { purpose: "redistribution" }, "BLENDKIT_LICENSE_DENIED"],
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

  it("refuses raw redistribution of a CC0 item before contacting the provider", async () => {
    const fake = await new FakeClient().start();
    happyPath(fake);
    fake.searchResults = [item({ license: "cc_zero" })];
    const out = await tempDir();
    const error = await rejection(
      importBlendkitAsset(
        provider(fake),
        importInput(out, { purpose: "redistribution" }),
        AbortSignal.timeout(5000),
        toolOptions,
      ),
    );
    expect(error.code).toBe("BLENDKIT_LICENSE_DENIED");
    expect(fake.requests).toEqual([]);
    expect(await readdir(out)).toEqual([]);
  });

  it("imports a CC0 item for private project use without granting shipping rights", async () => {
    const fake = await new FakeClient().start();
    happyPath(fake);
    fake.searchResults = [item({ license: "cc_zero" })];
    const result = await importBlendkitAsset(
      provider(fake),
      importInput(await tempDir()),
      AbortSignal.timeout(10_000),
      toolOptions,
    );
    expect(result.license.name).toBe("CC0 1.0");
    expect(result.redistribution.redistributionAllowed).toBe(false);
    expect(result.redistribution.restriction).toMatch(/CC0 label does not grant/u);
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

  describe("publishing", () => {
    /** Holds each caller until `count` have arrived, then releases them together. */
    function barrier(count: number) {
      let arrived = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      return async () => {
        if (++arrived === count) release();
        await gate;
      };
    }

    it("lets exactly one of two simultaneous imports of one item publish", async () => {
      const fake = await new FakeClient().start();
      happyPath(fake);
      const out = await tempDir();
      const hold = barrier(2);
      // One provider, as in the server: a second client would share the app id and swallow tasks.
      const shared = provider(fake);
      const settled = await Promise.allSettled(
        [1, 2].map(() =>
          importBlendkitAsset(shared, importInput(out), AbortSignal.timeout(20_000), {
            ...toolOptions,
            hooks: { beforePublish: hold },
          }),
        ),
      );
      expect(settled.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
      const lost = settled.find((result) => result.status === "rejected") as PromiseRejectedResult;
      expect(lost.reason).toMatchObject({ code: "BLENDKIT_OUTPUT_EXISTS" });
      expect((await readdir(out)).sort()).toEqual([
        `blendkit-${ID}.glb`,
        `blendkit-${ID}.provenance.json`,
      ]);
      const provenance = JSON.parse(
        await readFile(join(out, `blendkit-${ID}.provenance.json`), "utf8"),
      );
      const glb = await readFile(join(out, `blendkit-${ID}.glb`));
      expect(provenance.output.sha256).toBe(createHash("sha256").update(glb).digest("hex"));
    });

    it("keeps its published provenance and reports partial output when the GLB name appears", async () => {
      const fake = await new FakeClient().start();
      happyPath(fake);
      const out = await tempDir();
      const error = await rejection(
        importBlendkitAsset(provider(fake), importInput(out), AbortSignal.timeout(10_000), {
          ...toolOptions,
          hooks: { beforePublish: () => writeFile(join(out, `blendkit-${ID}.glb`), "external") },
        }),
      );
      // Nothing is deleted from the shared directory: no inode-conditional unlink exists on POSIX.
      expect(error.code).toBe("BLENDKIT_PARTIAL_OUTPUT");
      expect(error.message).toContain(`blendkit-${ID}.provenance.json`);
      expect((await readdir(out)).sort()).toEqual([
        `blendkit-${ID}.glb`,
        `blendkit-${ID}.provenance.json`,
      ]);
      expect(await readFile(join(out, `blendkit-${ID}.glb`), "utf8")).toBe("external");
    });

    it("reports partial output, not success, when the caller aborts between the two links", async () => {
      const fake = await new FakeClient().start();
      happyPath(fake);
      const out = await tempDir();
      const controller = new AbortController();
      const error = await rejection(
        importBlendkitAsset(provider(fake), importInput(out), controller.signal, {
          ...toolOptions,
          hooks: { afterLink: async () => controller.abort(new Error("cancelled mid-publish")) },
        }),
      );
      expect(error.code).toBe("BLENDKIT_PARTIAL_OUTPUT");
      expect(error.message).toContain("cancelled");
      expect(await readdir(out)).toEqual([`blendkit-${ID}.provenance.json`]);
    });

    it("leaves a provenance file that appears during publishing untouched and creates nothing", async () => {
      const fake = await new FakeClient().start();
      happyPath(fake);
      const out = await tempDir();
      const error = await rejection(
        importBlendkitAsset(provider(fake), importInput(out), AbortSignal.timeout(10_000), {
          ...toolOptions,
          hooks: {
            beforePublish: () => writeFile(join(out, `blendkit-${ID}.provenance.json`), "external"),
          },
        }),
      );
      expect(error.code).toBe("BLENDKIT_OUTPUT_EXISTS");
      expect(await readdir(out)).toEqual([`blendkit-${ID}.provenance.json`]);
      expect(await readFile(join(out, `blendkit-${ID}.provenance.json`), "utf8")).toBe("external");
    });

    it("does not follow a dangling symlink at a destination name", async () => {
      const fake = await new FakeClient().start();
      happyPath(fake);
      const out = await tempDir();
      const victim = join(await tempDir(), "victim.glb");
      await symlink(victim, join(out, `blendkit-${ID}.glb`));
      const error = await rejection(
        importBlendkitAsset(
          provider(fake),
          importInput(out),
          AbortSignal.timeout(10_000),
          toolOptions,
        ),
      );
      expect(error.code).toBe("BLENDKIT_OUTPUT_EXISTS");
      await expect(readFile(victim)).rejects.toThrow();
    });
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

async function waitFor(condition: () => unknown): Promise<void> {
  for (let attempt = 0; attempt < 500 && !condition(); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(condition()).toBeTruthy();
}
const DOWNLOAD = { id: ID, name: "Oak Chair", assetType: "model", files: [] };

describe("Blendkit bridge boundaries", () => {
  it("redacts the configured API key from task text and task type, in plain text", async () => {
    const fake = await new FakeClient().start();
    fake.onDownload = (_body, task) =>
      void Object.assign(task, {
        status: "error",
        task_type: `dl-${SECRET}`,
        message: `rejected key ${SECRET} for this user`,
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
    expect(error.message).not.toContain(SECRET);
    expect(error.message).toContain("<redacted>");
  });

  it("does not accept a completion that was parked for an aborted caller", async () => {
    const fake = await new FakeClient().start();
    const client = new BlendkitClient({ baseUrl: fake.origin, pollIntervalMs: 5 });
    const aborted = new AbortController();
    let started = 0;
    fake.onDownload = (_body, task) => {
      // The first download never finishes and keeps the shared poller running. The second one
      // finishes and aborts its caller while its reply is still held, so the poller parks it.
      if (++started === 2) {
        Object.assign(task, { status: "finished", result: { file_paths: ["/staging/x.blend"] } });
        aborted.abort(new Error("caller aborted"));
      }
    };
    fake.replyDelayMs.set("/assets/download", 0);
    const stop = new AbortController();
    const first = client.download(DOWNLOAD, "/staging", "ORIGINAL", "", stop.signal);
    first.catch(() => undefined);
    await waitFor(() => fake.paths().includes("/assets/download"));
    fake.replyDelayMs.set("/assets/download", 150);
    await expect(
      client.download(DOWNLOAD, "/staging", "ORIGINAL", "", aborted.signal),
    ).rejects.toThrow("caller aborted");
    stop.abort(new Error("stop"));
    await first.catch(() => undefined);
  });

  it("keeps the result of a task someone is waiting for when many others finish at once", async () => {
    const fake = await new FakeClient().start();
    const client = new BlendkitClient({ baseUrl: fake.origin, pollIntervalMs: 5 });
    let held: FakeTask | undefined;
    fake.onDownload = (_body, task) => void (held = task);
    const download = client.download(
      DOWNLOAD,
      "/staging",
      "ORIGINAL",
      "",
      AbortSignal.timeout(10_000),
    );
    await waitFor(() => held);
    for (let index = 0; index < 300; index += 1) {
      const id = randomUUID();
      fake.tasks.set(id, {
        task_id: id,
        task_type: "other",
        status: "finished",
        progress: 100,
        message: "",
        result: null,
        data: {},
      });
    }
    Object.assign(held!, { status: "finished", result: { file_paths: ["/staging/a.blend"] } });
    await expect(download).resolves.toEqual(["/staging/a.blend"]);
  });

  it("asks the official Client to cancel a download that failed for any reason but its own end", async () => {
    const fake = await new FakeClient().start();
    const client = new BlendkitClient({
      baseUrl: fake.origin,
      pollIntervalMs: 5,
      cancelConfirmMs: 200,
    });
    fake.onDownload = () => {};
    fake.badReport = true;
    // Cancel was asked for, but with /report broken nothing confirms the writer stopped.
    await expect(
      client.download(DOWNLOAD, "/staging", "ORIGINAL", "", AbortSignal.timeout(5000)),
    ).rejects.toBeInstanceOf(UnconfirmedStopError);
    const cancel = fake.requests.find((request) => request.path === "/assets/cancel_download");
    expect(typeof cancel?.body.task_id).toBe("string");

    // A task the Client itself reports as failed is already over: nothing to cancel.
    const other = await new FakeClient().start();
    other.onDownload = (_body, task) => void Object.assign(task, { status: "error" });
    await expect(
      new BlendkitClient({ baseUrl: other.origin, pollIntervalMs: 5 }).download(
        DOWNLOAD,
        "/staging",
        "ORIGINAL",
        "",
        AbortSignal.timeout(5000),
      ),
    ).rejects.toMatchObject({ code: "BLENDKIT_TASK_FAILED" });
    expect(other.paths()).not.toContain("/assets/cancel_download");
  });

  it("keeps the staging directory while a recipe the Client cannot cancel may still write", async () => {
    const fake = await new FakeClient().start();
    happyPath(fake);
    fake.onRun = () => {};
    const out = await tempDir();
    const controller = new AbortController();
    const work = importBlendkitAsset(
      provider(fake),
      importInput(out),
      controller.signal,
      toolOptions,
    );
    await waitFor(() => fake.paths().includes("/tools/run"));
    controller.abort(new Error("caller cancelled"));
    const error = await rejection(work);
    expect(error.code).toBe("BLENDKIT_CANCELLED");
    expect(error.message).toContain("caller cancelled");
    expect(error.message).toContain("was kept");
    const entries = await readdir(out);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^\.blendkit-staging-/u);
  });

  it("reports a staging cleanup problem after commit as a warning, not a failure", async () => {
    const fake = await new FakeClient().start();
    happyPath(fake);
    const out = await tempDir();
    const result = await importBlendkitAsset(
      provider(fake),
      importInput(out),
      AbortSignal.timeout(10_000),
      {
        ...toolOptions,
        hooks: {
          removeStaging: () => Promise.reject(Object.assign(new Error("busy"), { code: "EBUSY" })),
        },
      },
    );
    expect(result.warnings).toEqual([expect.stringMatching(/staging directory .*EBUSY/u)]);
    const entries = await readdir(out);
    expect(entries).toContain(`blendkit-${ID}.glb`);
    expect(entries).toContain(`blendkit-${ID}.provenance.json`);
  });

  it("publishes nothing when the caller aborts just before publishing", async () => {
    const fake = await new FakeClient().start();
    happyPath(fake);
    const out = await tempDir();
    const controller = new AbortController();
    await expect(
      importBlendkitAsset(provider(fake), importInput(out), controller.signal, {
        ...toolOptions,
        hooks: { beforePublish: async () => controller.abort(new Error("late abort")) },
      }),
    ).rejects.toThrow("late abort");
    expect(await readdir(out)).toEqual([]);
  });

  it("redacts every accepted API key, including 1-3 character ones, in text and task type", async () => {
    for (const key of ["7", "k9", "abc"]) {
      const fake = await new FakeClient().start();
      fake.onDownload = (_body, task) =>
        void Object.assign(task, {
          status: "error",
          task_type: `dl-${key}`,
          message: `rejected ${key} and again ${key}`,
        });
      const error = await rejection(
        importBlendkitAsset(
          provider(fake, { apiKey: key }),
          importInput(await tempDir()),
          AbortSignal.timeout(5000),
          toolOptions,
        ),
      );
      expect(error.message, key).not.toContain(key);
      expect(error.message, key).toContain("<redacted>");
    }
    expect(safeTaskText("a.b a.b ab", ["a.b", "ab"])).toBe("<redacted> <redacted> <redacted>");
  });

  it("keeps staging when /report fails with HTTP 500: an error response is not an observed task end", async () => {
    const fake = await new FakeClient().start();
    happyPath(fake);
    fake.onRun = () => {};
    const out = await tempDir();
    const work = importBlendkitAsset(
      provider(fake),
      importInput(out),
      AbortSignal.timeout(10_000),
      toolOptions,
    );
    await waitFor(() => fake.paths().includes("/tools/run"));
    fake.reportStatus = 500;
    const error = await rejection(work);
    expect(error.code).toBe("BLENDKIT_STAGING_RETAINED");
    expect(error.message).toContain("was kept");
    const entries = await readdir(out);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(/^\.blendkit-staging-/u);
  });

  it("still asks for the download cancel on HTTP 500 and keeps staging when it cannot be confirmed", async () => {
    const fake = await new FakeClient().start();
    fake.onDownload = (body, task) => {
      void mkdir(join((body.download_dirs as string[])[0]!, "partial"), { recursive: true });
      void task;
    };
    const out = await tempDir();
    const work = importBlendkitAsset(
      provider(fake),
      importInput(out),
      AbortSignal.timeout(10_000),
      toolOptions,
    );
    await waitFor(() => fake.paths().includes("/assets/download"));
    fake.reportStatus = 500;
    const error = await rejection(work);
    expect(error.code).toBe("BLENDKIT_STAGING_RETAINED");
    expect(fake.paths()).toContain("/assets/cancel_download");
    expect((await readdir(out)).length).toBe(1);
  });

  it("keeps staging when the official cancel fails or is ignored", async () => {
    for (const mode of ["fails", "ignored"] as const) {
      const fake = await new FakeClient().start();
      fake.onDownload = () => {};
      if (mode === "fails") fake.cancelStatus = 500;
      else fake.cancelIgnored = true;
      const out = await tempDir();
      const controller = new AbortController();
      const work = importBlendkitAsset(
        provider(fake),
        importInput(out),
        controller.signal,
        toolOptions,
      );
      await waitFor(() => fake.paths().includes("/assets/download"));
      controller.abort(new Error("caller cancelled"));
      const error = await rejection(work);
      expect(error.code, mode).toBe("BLENDKIT_CANCELLED");
      expect(error.message, mode).toContain("was kept");
      expect(await readdir(out), mode).toHaveLength(1);
    }
  });

  it("does not lose a completion that /report delivers while its start response is still held", async () => {
    const fake = await new FakeClient().start();
    const client = new BlendkitClient({ baseUrl: fake.origin, pollIntervalMs: 5 });
    let started = 0;
    fake.onDownload = (_body, task) => {
      // The first download never finishes and keeps the shared poller running. The second one
      // finishes at once, and 300 other tasks finish after it, while its reply is held.
      if (++started === 2) {
        Object.assign(task, {
          status: "finished",
          result: { file_paths: ["/staging/held.blend"] },
        });
        for (let index = 0; index < 300; index += 1) {
          const id = randomUUID();
          fake.tasks.set(id, {
            task_id: id,
            task_type: "other",
            status: "finished",
            progress: 100,
            message: "",
            result: null,
            data: {},
          });
        }
      }
    };
    const stop = new AbortController();
    const first = client.download(DOWNLOAD, "/staging", "ORIGINAL", "", stop.signal);
    first.catch(() => undefined);
    await waitFor(() => fake.paths().includes("/assets/download"));
    fake.replyDelayMs.set("/assets/download", 300);
    await expect(
      client.download(DOWNLOAD, "/staging", "ORIGINAL", "", AbortSignal.timeout(10_000)),
    ).resolves.toEqual(["/staging/held.blend"]);
    stop.abort(new Error("stop"));
    await first.catch(() => undefined);
  });
});
