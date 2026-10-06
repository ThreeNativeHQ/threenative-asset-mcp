import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Document, NodeIO } from "@gltf-transform/core";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from "@zip.js/zip.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

type Json = Record<string, unknown>;
type FixtureRoute = { body: string; status?: number; headers?: Record<string, string> };
type Routes = Record<string, FixtureRoute>;
type Plan = {
  planToken: string;
  files: Array<{ path: string; url?: string; dependencyOf?: string }>;
};
type Download = {
  directory: string;
  receiptPath: string;
  alreadyExisted: boolean;
  requiresExtraction: boolean;
  runtimeReadiness: string;
  totalBytes: number;
  receipt: {
    toolVersion: string;
    files: Array<{ path: string; sizeBytes: number; sha256: string }>;
  };
};

const roots: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();
let packedEntry: string;
let packageVersion: string;

beforeAll(async () => {
  const root = await temporaryDirectory("asset-federated-package-");
  const npmCli = process.env.npm_execpath;
  const packArguments = ["pack", "--ignore-scripts", "--json", "--pack-destination", root];
  const packed = JSON.parse(
    execFileSync(
      npmCli ? process.execPath : "npm",
      npmCli ? [npmCli, ...packArguments] : packArguments,
      { cwd: resolve("."), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ),
  ) as Array<{ filename: string }>;
  if (!packed[0]?.filename) throw new Error("npm pack produced no package");
  execFileSync("tar", ["-xzf", join(root, packed[0].filename), "-C", root]);
  const packageRoot = join(root, "package");
  // Consume only published files, with already lockfile-installed dependencies and no registry call.
  await symlink(resolve("node_modules"), join(packageRoot, "node_modules"), "junction");
  packedEntry = join(packageRoot, "dist", "index.js");
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as {
    version: string;
    bin: Record<string, string>;
  };
  packageVersion = manifest.version;
  expect(manifest.bin["threenative-asset-mcp"]).toBe("dist/index.js");
  expect(await readFile(packedEntry, "utf8")).toMatch(/^#!\/usr\/bin\/env node/u);
}, 30_000);

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  }
  children.clear();
});

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6p1sAAAAASUVORK5CYII=",
  "base64",
);
const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0];
const polyBase = "https://dl.polyhaven.org/file/Models/gltf/2k/";
const signature = "fixture-secret-signature";

async function providerFixtures(): Promise<{
  routes: Routes;
  resources: Record<string, Uint8Array>;
  archive: Uint8Array;
}> {
  const document = new Document();
  const buffer = document.createBuffer().setURI("chair.bin");
  const texture = document
    .createTexture("Chair diffuse")
    .setImage(png)
    .setMimeType("image/png")
    .setURI("textures/chair.png");
  const material = document.createMaterial().setBaseColorTexture(texture);
  const primitive = document
    .createPrimitive()
    .setMaterial(material)
    .setAttribute(
      "POSITION",
      document
        .createAccessor()
        .setType("VEC3")
        .setArray(new Float32Array(positions))
        .setBuffer(buffer),
    )
    .setAttribute(
      "TEXCOORD_0",
      document
        .createAccessor()
        .setType("VEC2")
        .setArray(new Float32Array([0, 0, 1, 0, 0, 1]))
        .setBuffer(buffer),
    );
  document
    .createScene()
    .addChild(document.createNode().setMesh(document.createMesh().addPrimitive(primitive)));
  const output = await new NodeIO().writeJSON(document);
  const resources: Record<string, Uint8Array> = {
    "chair.gltf": Buffer.from(JSON.stringify(output.json)),
    ...output.resources,
  };
  const route = (bytes: Uint8Array, headers?: Record<string, string>): FixtureRoute => ({
    body: Buffer.from(bytes).toString("base64"),
    ...(headers ? { headers } : {}),
  });
  const json = (value: unknown): FixtureRoute =>
    route(Buffer.from(JSON.stringify(value)), { "content-type": "application/json" });
  const routes: Routes = {};
  for (const [path, bytes] of Object.entries(resources)) {
    routes[`${polyBase}${path}`] = route(bytes);
  }
  const providerFile = (path: string, bytes = resources[path]!) => ({
    url: `${polyBase}${path}`,
    size: bytes.byteLength,
    md5: createHash("md5").update(bytes).digest("hex"),
  });
  const files = () => ({
    gltf: {
      "2k": {
        gltf: {
          ...providerFile("chair.gltf"),
          include: Object.fromEntries(
            Object.entries(resources)
              .filter(([path]) => path !== "chair.gltf")
              .map(([path, bytes]) => [path, providerFile(path, bytes)]),
          ),
        },
      },
    },
  });
  const metadata = {
    name: "Chair",
    type: 2,
    tags: ["fixture"],
    authors: { "Fixture Author": "all" },
    thumbnail_url: `https://cdn.polyhaven.com/thumbs/chair.png?X-Amz-Signature=${signature}`,
  };
  routes["https://api.polyhaven.com/assets"] = json({ chair: metadata });
  for (const id of [
    "chair",
    "missing",
    "checksum",
    "redirect",
    "credentials",
    "signed",
    "traversal",
  ]) {
    routes[`https://api.polyhaven.com/info/${id}`] = json(metadata);
    const itemFiles = files();
    const main = itemFiles.gltf["2k"].gltf;
    if (id === "missing") delete main.include["textures/chair.png"];
    if (id === "checksum") main.md5 = "0".repeat(32);
    if (id === "redirect") {
      main.url = `${polyBase}redirect.gltf`;
      routes[main.url] = {
        body: "",
        status: 302,
        headers: { location: "http://127.0.0.1/private" },
      };
    }
    if (id === "credentials")
      main.url = "https://user:fixture-password@dl.polyhaven.org/chair.gltf";
    if (id === "signed") main.url = `${polyBase}chair.gltf?X-Amz-Signature=${signature}`;
    if (id === "traversal") main.include["../escape.bin"] = providerFile("chair.bin");
    routes[`https://api.polyhaven.com/files/${id}`] = json(itemFiles);
  }
  const writer = new ZipWriter(new Uint8ArrayWriter());
  for (const [path, bytes] of Object.entries(resources))
    await writer.add(`Models/${path}`, new Uint8ArrayReader(bytes));
  await writer.add(
    "License.txt",
    new Uint8ArrayReader(Buffer.from("Hand-authored test fixture. CC0 1.0.")),
  );
  const archive = await writer.close();
  const listing =
    "<h1>Assets</h1><div class='asset'><h2><a href='/assets/chair-kit'>Chair Kit</a></h2><a href='/assets/category:3D'>3D</a></div>";
  const detail =
    "<h1>Chair Kit</h1><table><tr><td>Category</td><td><a href='/assets/category:3D'>3D</a></td></tr><tr><td>License</td><td><a href='https://creativecommons.org/publicdomain/zero/1.0/'>Creative Commons CC0</a></td></tr></table><p>The game assets you're about to download are available for free.</p><a id='donate-text' href='https://kenney.nl/media/pages/assets/chair-kit/fixture-123/kenney_chair-kit.zip'>Continue without donating...</a>";
  routes["https://kenney.nl/assets?search=chair"] = route(Buffer.from(listing), {
    "content-type": "text/html",
  });
  routes["https://kenney.nl/assets/chair-kit"] = route(Buffer.from(detail), {
    "content-type": "text/html",
  });
  routes["https://kenney.nl/media/pages/assets/chair-kit/fixture-123/kenney_chair-kit.zip"] = route(
    archive,
    { "content-type": "application/zip" },
  );
  return { routes, resources, archive };
}

async function startConsumer(routes: Routes, kenneySetting?: string) {
  const root = await temporaryDirectory("asset-federated-consumer-");
  const fixturePath = join(root, "routes.json");
  const auditPath = join(root, "requests.jsonl");
  await writeFile(fixturePath, JSON.stringify(routes));
  const preload = join(root, "transport.mjs");
  await writeFile(
    preload,
    `import { readFile, appendFile } from 'node:fs/promises';
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  signal?.throwIfAborted();
  await appendFile(process.env.FIXTURE_AUDIT, JSON.stringify({ url, redirect: init?.redirect }) + '\\n');
  const routes = JSON.parse(await readFile(process.env.FIXTURE_ROUTES, 'utf8'));
  const route = routes[url];
  if (!route) throw new Error('No controlled transport fixture for requested URL');
  signal?.throwIfAborted();
  return new Response(Buffer.from(route.body, 'base64'), { status: route.status ?? 200, headers: route.headers });
};
`,
  );
  const storage = join(root, "downloads");
  const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, packedEntry], {
    cwd: root,
    // A consumer test never inherits provider credentials or a normal browser/home profile.
    env: {
      PATH: process.env.PATH ?? "",
      HOME: root,
      TMPDIR: tmpdir(),
      FAB_BROWSER_PROFILE_DIR: join(root, "browser"),
      FAB_BROWSER_HEADLESS: "true",
      ASSET_DOWNLOAD_DIR: storage,
      ASSET_MAX_DOWNLOAD_BYTES: "1048576",
      ...(kenneySetting !== undefined ? { ASSET_ENABLE_KENNEY: kenneySetting } : {}),
      FIXTURE_ROUTES: fixturePath,
      FIXTURE_AUDIT: auditPath,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  const pending = new Map<
    number,
    { resolve: (value: Json) => void; reject: (error: Error) => void }
  >();
  const stdout: string[] = [];
  const stderr: string[] = [];
  let buffer = "";
  let sequence = 0;
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
  child.stdout.on("data", (chunk: Buffer) => {
    stdout.push(chunk.toString("utf8"));
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines.filter(Boolean)) {
      try {
        const message = JSON.parse(line) as Json;
        if (typeof message.id === "number") pending.get(message.id)?.resolve(message);
      } catch {
        for (const item of pending.values()) item.reject(new Error("MCP wrote non-JSON stdout"));
      }
    }
  });
  child.on("exit", () => {
    for (const item of pending.values())
      item.reject(new Error(`MCP exited before replying: ${stderr.join("")}`));
  });
  const request = (method: string, params: Json = {}): Promise<Json> => {
    const id = ++sequence;
    return new Promise((resolveResponse, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP response timed out: ${method}`));
      }, 10_000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          pending.delete(id);
          resolveResponse(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          pending.delete(id);
          reject(error);
        },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };
  const initialized = await request("initialize", {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "packed-federation-consumer", version: "1.0.0" },
  });
  if (initialized.error) {
    throw new Error(`MCP initialization rejected: ${JSON.stringify(initialized.error)}`);
  }
  expect(initialized).toMatchObject({
    result: { serverInfo: { name: "threenative-asset-mcp", version: packageVersion } },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const call = (name: string, arguments_: Json) =>
    request("tools/call", { name, arguments: arguments_ });
  const success = async <T>(name: string, arguments_: Json): Promise<T> => {
    const response = await call(name, arguments_);
    expect(response).not.toHaveProperty("error");
    expect(response).not.toHaveProperty("result.isError", true);
    expect(response).toHaveProperty("result.structuredContent");
    expect(JSON.stringify(response)).not.toContain(signature);
    return (response.result as { structuredContent: T }).structuredContent;
  };
  const failure = async (name: string, arguments_: Json) => {
    const response = await call(name, arguments_);
    const result = response.result as { isError?: boolean } | undefined;
    expect(response.error !== undefined || result?.isError === true).toBe(true);
    expect(response).not.toHaveProperty("result.structuredContent.receipt");
    expect(JSON.stringify(response)).not.toContain(signature);
    expect(JSON.stringify(response)).not.toContain("fixture-password");
    return response;
  };
  const requests = async (): Promise<Array<{ url: string; redirect: string }>> =>
    (await readFile(auditPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { url: string; redirect: string });
  const close = async () => {
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
    children.delete(child);
    expect(child.exitCode).toBe(0);
    for (const line of stdout.join("").split("\n").filter(Boolean))
      expect(() => JSON.parse(line)).not.toThrow();
  };
  return { request, call, success, failure, requests, close, fixturePath, storage };
}

describe("packed federated stdio consumer", () => {
  it("disables generic Kenney explicitly without making provider requests", async () => {
    const fixtures = await providerFixtures();
    const consumer = await startConsumer(fixtures.routes, "0");
    const found = await consumer.success<{ results: Json[]; providers: Json[] }>("asset_search", {
      query: "chair",
      providers: ["polyhaven", "kenney"],
      types: ["3d-model"],
    });
    expect(found.results.map((item) => item.provider)).toEqual(["polyhaven"]);
    expect(found.providers).toContainEqual(
      expect.objectContaining({ provider: "kenney", status: "manual" }),
    );
    await consumer.failure("asset_get", { assetId: "kenney:chair-kit" });
    expect(
      (await consumer.requests()).every((request) => !request.url.startsWith("https://kenney.nl/")),
    ).toBe(true);
    await consumer.close();
  });

  it("rejects malformed Kenney settings during startup", async () => {
    await expect(startConsumer({}, "sometimes")).rejects.toThrow(/MCP initialization rejected/u);
  });
  it("discovers two providers and acquires dependency-complete glTF and an original Kenney archive", async () => {
    const fixtures = await providerFixtures();
    const consumer = await startConsumer(fixtures.routes);
    const listed = await consumer.request("tools/list");
    const tools = (listed.result as { tools: Array<{ name: string }> }).tools.map(
      (tool) => tool.name,
    );
    expect(tools).toEqual(
      expect.arrayContaining([
        "asset_search",
        "asset_get",
        "asset_download",
        "fab_search_assets",
        "polyhaven_get_asset",
        "ambientcg_search_assets",
        "smithsonian_search_assets",
        "sketchfab_search_models",
        "asset_download_file",
      ]),
    );
    const found = await consumer.success<{ results: Json[]; providers: Json[]; partial: boolean }>(
      "asset_search",
      {
        query: "chair",
        providers: ["polyhaven", "kenney"],
        types: ["3d-model"],
        freeOnly: true,
        commercialUse: true,
        downloadableOnly: true,
      },
    );
    expect(found.partial).toBe(false);
    expect(found.providers).toEqual([
      expect.objectContaining({ provider: "kenney", status: "ok" }),
      expect.objectContaining({ provider: "polyhaven", status: "ok" }),
    ]);
    expect(found.results.map((item) => item.assetId).sort()).toEqual([
      "kenney:chair-kit",
      "polyhaven:chair",
    ]);
    for (const item of found.results)
      expect(item).toMatchObject({
        free: "yes",
        canDownloadNow: true,
        downloadStatus: "direct",
        license: { name: "CC0 1.0", commercialUse: "yes", attributionRequired: "no" },
      });

    const details = await consumer.success<{ plan: Plan }>("asset_get", {
      assetId: "polyhaven:chair",
      format: "gltf",
      resolution: "2k",
    });
    expect(details.plan.files.map((file) => file.path).sort()).toEqual(
      Object.keys(fixtures.resources).sort(),
    );
    expect(details.plan.files.every((file) => file.url === undefined)).toBe(true);
    expect(details.plan.files.filter((file) => file.dependencyOf).length).toBe(2);
    const downloaded = await consumer.success<Download>("asset_download", {
      planToken: details.plan.planToken,
      acceptLicense: true,
    });
    expect(downloaded).toMatchObject({
      alreadyExisted: false,
      requiresExtraction: false,
      runtimeReadiness: "unverified",
    });
    expect(downloaded.receipt).toMatchObject({
      schemaVersion: 1,
      assetId: "polyhaven:chair",
      provider: "polyhaven",
      nativeId: "chair",
      sourceUrl: "https://polyhaven.com/a/chair",
      author: "Fixture Author",
      apiCredit: "Powered by Poly Haven",
      selectedVariant: "gltf/2k",
      runtimeReadiness: "unverified",
      acknowledgedTermsDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      planIdentity: expect.stringMatching(/^[a-f0-9]{64}$/u),
      toolVersion: packageVersion,
    });
    expect(JSON.parse(await readFile(downloaded.receiptPath, "utf8"))).toEqual(downloaded.receipt);
    expect(JSON.stringify(downloaded.receipt)).not.toContain("X-Amz");
    expect(downloaded.totalBytes).toBe(
      Object.values(fixtures.resources).reduce((sum, bytes) => sum + bytes.byteLength, 0),
    );
    for (const file of downloaded.receipt.files) {
      const bytes = await readFile(join(downloaded.directory, file.path));
      expect(bytes).toEqual(Buffer.from(fixtures.resources[file.path]!));
      expect(file.sizeBytes).toBe(bytes.byteLength);
      expect(file.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
    // This consumer can read the published source with networking disabled, including the texture and buffer.
    const local = await new NodeIO()
      .setAllowNetwork(false)
      .read(join(downloaded.directory, "chair.gltf"));
    expect(Array.from(local.getRoot().listAccessors()[0]!.getArray()!)).toEqual(positions);
    expect(Buffer.from(local.getRoot().listTextures()[0]!.getImage()!)).toEqual(png);
    const replayed = await consumer.success<Download>("asset_download", {
      planToken: details.plan.planToken,
      acceptLicense: true,
    });
    expect(replayed.alreadyExisted).toBe(true);
    await writeFile(join(downloaded.directory, "textures/chair.png"), "tampered");
    await consumer.failure("asset_download", {
      planToken: details.plan.planToken,
      acceptLicense: true,
    });

    const pack = await consumer.success<{ plan: Plan; asset: Json }>("asset_get", {
      assetId: "kenney:chair-kit",
    });
    expect(pack.asset).toMatchObject({ itemKind: "pack", type: "3d-model" });
    const archived = await consumer.success<Download>("asset_download", {
      planToken: pack.plan.planToken,
      acceptLicense: true,
    });
    expect(archived).toMatchObject({
      requiresExtraction: true,
      runtimeReadiness: "unverified",
      alreadyExisted: false,
    });
    expect(archived.receipt).toMatchObject({
      sourceUrl: "https://kenney.nl/assets/chair-kit",
      selectedVariant: "zip/original-pack",
      author: "Kenney",
    });
    const zipPath = join(archived.directory, "kenney_chair-kit.zip");
    expect(await readFile(zipPath)).toEqual(Buffer.from(fixtures.archive));
    expect((await readdir(archived.directory)).sort()).toEqual([
      "asset.acquisition.json",
      "kenney_chair-kit.zip",
    ]);
    const reader = new ZipReader(new Uint8ArrayReader(await readFile(zipPath)));
    try {
      expect((await reader.getEntries()).map((entry) => entry.filename).sort()).toEqual(
        ["License.txt", ...Object.keys(fixtures.resources).map((path) => `Models/${path}`)].sort(),
      );
    } finally {
      await reader.close();
    }
    expect(
      (
        await consumer.success<Download>("asset_download", {
          planToken: pack.plan.planToken,
          acceptLicense: true,
        })
      ).alreadyExisted,
    ).toBe(true);
    await writeFile(zipPath, "tampered");
    await consumer.failure("asset_download", {
      planToken: pack.plan.planToken,
      acceptLicense: true,
    });
    const unavailable = await consumer.success<{ plan: null; alternatives: string[] }>(
      "asset_get",
      { assetId: "kenney:chair-kit", format: "glb" },
    );
    expect(unavailable.plan).toBeNull();
    expect(unavailable.alternatives).toContain("zip/original-pack");
    expect(
      (await consumer.requests())
        .filter((request) => request.url.includes("dl.polyhaven.org"))
        .every((request) => request.redirect === "manual"),
    ).toBe(true);
    await consumer.close();
  }, 30_000);

  it("fails closed across plan, license, credential, path, checksum, redirect, resource and byte-budget boundaries", async () => {
    const fixtures = await providerFixtures();
    const consumer = await startConsumer(fixtures.routes);
    await consumer.failure("asset_download", { planToken: "unknown-plan", acceptLicense: true });
    const valid = await consumer.success<{ plan: Plan }>("asset_get", {
      assetId: "polyhaven:chair",
    });
    await consumer.failure("asset_download", { planToken: valid.plan.planToken });
    await consumer.failure("asset_download", {
      planToken: valid.plan.planToken,
      acceptLicense: false,
    });
    await consumer.failure("asset_download", {
      planToken: valid.plan.planToken,
      acceptLicense: true,
      url: "https://example.com/arbitrary",
    });
    await consumer.failure("asset_download", {
      planToken: valid.plan.planToken,
      acceptLicense: true,
      outputRoot: consumer.storage,
    });
    expect(
      (await consumer.requests()).filter((request) => request.url.includes("dl.polyhaven.org")),
    ).toHaveLength(0);
    for (const id of ["credentials", "signed", "traversal"])
      await consumer.failure("asset_get", { assetId: `polyhaven:${id}` });
    for (const id of ["missing", "checksum", "redirect"]) {
      const detail = await consumer.success<{ plan: Plan }>("asset_get", {
        assetId: `polyhaven:${id}`,
      });
      const failed = await consumer.failure("asset_download", {
        planToken: detail.plan.planToken,
        acceptLicense: true,
      });
      if (id === "missing")
        expect(JSON.stringify(failed)).toContain("Missing glTF companion: textures/chair.png");
    }
    await consumer.failure("asset_download", {
      planToken: valid.plan.planToken,
      acceptLicense: true,
      maxBytes: 1,
    });
    expect(await readdir(join(consumer.storage, "acquisitions"))).toEqual([]);
    const requested = await consumer.requests();
    expect(requested.some((request) => request.url.startsWith("http:"))).toBe(false);
    expect(requested.some((request) => request.url.includes("fixture-password"))).toBe(false);

    const changedFiles = JSON.parse(
      Buffer.from(
        fixtures.routes["https://api.polyhaven.com/files/chair"]!.body,
        "base64",
      ).toString("utf8"),
    ) as { gltf: { "2k": { gltf: { md5: string } } } };
    changedFiles.gltf["2k"].gltf.md5 = "0".repeat(32);
    fixtures.routes["https://api.polyhaven.com/files/chair"]!.body = Buffer.from(
      JSON.stringify(changedFiles),
    ).toString("base64");
    await writeFile(consumer.fixturePath, JSON.stringify(fixtures.routes));
    const changed = await consumer.failure("asset_download", {
      planToken: valid.plan.planToken,
      acceptLicense: true,
    });
    expect(JSON.stringify(changed)).toContain("ASSET_PLAN_CHANGED");
    expect(
      (await consumer.requests()).filter((request) => request.url.includes("dl.polyhaven.org")),
    ).toHaveLength(requested.filter((request) => request.url.includes("dl.polyhaven.org")).length);
    expect(await readdir(join(consumer.storage, "acquisitions"))).toEqual([]);
    fixtures.routes["https://api.polyhaven.com/assets"]!.status = 503;
    fixtures.routes["https://kenney.nl/assets?search=chair"]!.status = 503;
    await writeFile(consumer.fixturePath, JSON.stringify(fixtures.routes));
    const allFailed = await consumer.failure("asset_search", {
      query: "chair",
      providers: ["polyhaven", "kenney"],
    });
    expect(JSON.stringify(allFailed)).toContain("ASSET_ALL_PROVIDERS_FAILED");
    expect(allFailed).not.toHaveProperty("result.structuredContent.results");
    await consumer.close();
  }, 30_000);
});
