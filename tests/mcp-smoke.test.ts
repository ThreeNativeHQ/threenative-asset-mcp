import { existsSync, readFileSync } from "node:fs";
import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";
import { Document, NodeIO } from "@gltf-transform/core";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TtlLruCache } from "../src/fab/cache.js";
import { DirectFabTransport } from "../src/fab/direct-transport.js";
import { createStderrLogger } from "../src/fab/errors.js";

const packageVersion = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

const children = new Set<ChildProcessWithoutNullStreams>();
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit").catch(() => []);
    }
  }
  children.clear();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function jsonResponse(
  child: ChildProcessWithoutNullStreams,
  id: number,
  timeoutMs = 5_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolveResponse, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for MCP response ${id}`));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          cleanup();
          reject(new Error(`Non-JSON stdout from MCP: ${line}`));
          return;
        }
        if (message.id === id) {
          cleanup();
          resolveResponse(message);
          return;
        }
      }
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
    };
    child.stdout.on("data", onData);
  });
}

async function rigFixtureGlb(): Promise<Uint8Array> {
  const document = new Document();
  const buffer = document.createBuffer();
  const scene = document.createScene("Scene");
  const hips = document.createNode("Hips");
  const hand = document.createNode("hand.R");
  hips.addChild(hand);
  scene.addChild(hips);
  const skin = document.createSkin("Rig").addJoint(hips).addJoint(hand);
  const inverseBind = new Float32Array(32);
  inverseBind[15] = 1;
  inverseBind[31] = 1;
  skin.setInverseBindMatrices(
    document.createAccessor("ibm").setType("MAT4").setArray(inverseBind).setBuffer(buffer),
  );
  const mesh = document.createMesh("Body").addPrimitive(
    document
      .createPrimitive()
      .setAttribute(
        "POSITION",
        document
          .createAccessor("pos")
          .setType("VEC3")
          .setArray(new Float32Array([0, 0, 0]))
          .setBuffer(buffer),
      )
      .setAttribute(
        "JOINTS_0",
        document
          .createAccessor("j")
          .setType("VEC4")
          .setArray(new Uint16Array([0, 1, 0, 0]))
          .setBuffer(buffer),
      )
      .setAttribute(
        "WEIGHTS_0",
        document
          .createAccessor("w")
          .setType("VEC4")
          .setArray(new Float32Array([1, 1, 0, 0]))
          .setBuffer(buffer),
      ),
  );
  scene.addChild(document.createNode("Body").setMesh(mesh).setSkin(skin));
  const input = document
    .createAccessor("time")
    .setType("SCALAR")
    .setArray(new Float32Array([0, 1]))
    .setBuffer(buffer);
  const output = document
    .createAccessor("translation")
    .setType("VEC3")
    .setArray(new Float32Array([0, 0, 0, 0, 0, 0]))
    .setBuffer(buffer);
  const sampler = document
    .createAnimationSampler()
    .setInput(input)
    .setOutput(output)
    .setInterpolation("LINEAR");
  document
    .createAnimation("Walk_Loop")
    .addSampler(sampler)
    .addChannel(
      document
        .createAnimationChannel()
        .setSampler(sampler)
        .setTargetNode(hips)
        .setTargetPath("translation"),
    );
  return await new NodeIO().writeBinary(document);
}

async function rigLibraryZip(): Promise<Uint8Array> {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add(
    "Universal Animation Library[Standard]/Unreal-Godot/UAL1_Standard.glb",
    new Uint8ArrayReader(await rigFixtureGlb()),
  );
  return writer.close();
}

function send(
  child: ChildProcessWithoutNullStreams,
  message: Record<string, unknown>,
): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function requiredSets(schema: unknown): string[][] {
  const found: string[][] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "required" && Array.isArray(child) && child.every((entry) => typeof entry === "string")) {
        found.push(child as string[]);
      }
      visit(child);
    }
  };
  visit(schema);
  return found;
}

async function startInitializedServer(): Promise<{
  child: ChildProcessWithoutNullStreams;
  stdout: string[];
}>;
async function startInitializedServer(options: {
  readonly command?: string;
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
}): Promise<{
  child: ChildProcessWithoutNullStreams;
  stdout: string[];
}>;
async function startInitializedServer({
  command = resolve("dist/index.js"),
  cwd = resolve("."),
  environment,
}: {
  readonly command?: string;
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
} = {}): Promise<{
  child: ChildProcessWithoutNullStreams;
  stdout: string[];
}> {
  const profileDir = await mkdtemp(
    join(tmpdir(), "threenative-asset-mcp-smoke-"),
  );
  temporaryDirectories.push(profileDir);
  const child = spawn(process.execPath, [command], {
    cwd,
    env: {
      ...process.env,
      ...environment,
      FAB_BROWSER_PROFILE_DIR: profileDir,
      FAB_LOG_LEVEL: "debug",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  const stdout: string[] = [];
  child.stdout.on("data", (chunk: Buffer) => {
    stdout.push(chunk.toString("utf8"));
  });
  const initialized = jsonResponse(child, 1);
  send(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "threenative-asset-mcp-smoke", version: "1.0.0" },
    },
  });
  expect(await initialized).toMatchObject({
    result: {
      serverInfo: {
        name: "threenative-asset-mcp",
        // Read from the manifest rather than pinned here: the server's advertised version and the
        // published version are one fact, and a literal in a test is how they came apart.
        version: packageVersion,
      },
    },
  });
  send(child, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  return { child, stdout };
}

async function stopServer(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("MCP did not terminate")), 5_000),
    ),
  ]);
  children.delete(child);
}

async function callTool(
  child: ChildProcessWithoutNullStreams,
  id: number,
  name: string,
  arguments_: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const response = jsonResponse(child, id);
  send(child, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: arguments_ },
  });
  return response;
}

function npm(args: readonly string[], cwd: string): string {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("npm_execpath is required for packed-package tests");
  return execFileSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function installPackedPackage(): Promise<{
  readonly command: string;
  readonly cwd: string;
}> {
  const packageDirectory = await mkdtemp(
    join(tmpdir(), "threenative-asset-mcp-packed-"),
  );
  temporaryDirectories.push(packageDirectory);
  const packed = JSON.parse(
    npm(
      ["pack", "--json", "--pack-destination", packageDirectory],
      resolve("."),
    ),
  ) as Array<{ filename: string }>;
  const tarball = join(packageDirectory, packed[0]?.filename ?? "");
  if (!existsSync(tarball)) throw new Error("npm pack did not create a tarball");

  const consumerDirectory = join(packageDirectory, "consumer");
  npm(
    [
      "install",
      "--ignore-scripts",
      "--no-package-lock",
      "--prefix",
      consumerDirectory,
      tarball,
    ],
    resolve("."),
  );
  const command = join(
    consumerDirectory,
    "node_modules",
    ".bin",
    "threenative-asset-mcp",
  );
  if (!existsSync(command)) throw new Error("installed package did not expose its bin");
  return { command, cwd: consumerDirectory };
}

describe("Phase 5 reliability", () => {
  it("should respect retry-after", async () => {
    let now = 0;
    const requestTimes: number[] = [];
    const sleep = vi.fn(async (milliseconds: number) => {
      now += milliseconds;
    });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce(async () => {
        requestTimes.push(now);
        return new Response(null, {
          status: 429,
          headers: { "retry-after": "2" },
        });
      })
      .mockImplementationOnce(async () => {
        requestTimes.push(now);
        return Response.json({ results: [], cursors: {} });
      });
    const transport = new DirectFabTransport({
      fetch,
      now: () => now,
      random: () => 0,
      sleep,
    });

    await transport.search(
      new URL("https://www.fab.com/i/listings/search?q=forest"),
    );

    expect(requestTimes).toEqual([0, 2_000]);
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it("should stop after two transient retries", async () => {
    let now = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ error: "unavailable" }, { status: 503 }),
    );
    const transport = new DirectFabTransport({
      fetch,
      now: () => now,
      random: () => 0,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
    });

    await expect(
      transport.search(
        new URL("https://www.fab.com/i/listings/search?q=forest"),
      ),
    ).rejects.toMatchObject({
      code: "FAB_UPSTREAM_UNAVAILABLE",
      retryable: true,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("should evict cache entries at the configured bound", () => {
    const cache = new TtlLruCache<number>({ maxEntries: 999 });
    for (let index = 0; index < 501; index += 1) {
      cache.set(`key-${index}`, index, 60_000);
    }

    expect(cache.size).toBe(500);
    expect(cache.get("key-0")).toBeUndefined();
    expect(cache.get("key-500")).toBe(500);
  });

  it("redacts query text from structured logs by default", () => {
    const lines: string[] = [];
    const logger = createStderrLogger({
      level: "debug",
      logQueries: false,
      write: (line) => lines.push(line),
    });
    logger.log("debug", "search", {
      ...logger.queryFields("private search words"),
    });

    expect(lines.join("")).not.toContain("private search words");
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      queryRedacted: true,
    });
  });
});

describe("built stdio package", () => {
  it("should start from the packaged binary and keep stdout protocol-clean", async () => {
    const { child, stdout } = await startInitializedServer();

    const listed = jsonResponse(child, 2);
    send(child, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    const listResponse = await listed;
    expect(
      (listResponse.result as { tools?: Array<{ name: string }> }).tools?.map(
        (tool) => tool.name,
      ),
    ).toEqual([
      "asset_search",
      "asset_get",
      "asset_download",
      "creature_status",
      "creature_guide",
      "asset_inspect_rig",
      "asset_auto_rig",
      "asset_preview_animation",
      "asset_retarget_animations",
      "fab_search_assets",
      "fab_get_asset",
      "fab_list_filters",
      "fab_list_limited_time_free",
      "fab_download_free_asset",
      "fab_list_owned",
      "asset_import_unreal",
      "fab_import_asset",
      "polyhaven_search_assets",
      "polyhaven_get_asset",
      "polyhaven_list_categories",
      "polyhaven_list_files",
      "ambientcg_search_assets",
      "ambientcg_get_asset",
      "ambientcg_list_categories",
      "ambientcg_list_files",
      "smithsonian_search_assets",
      "smithsonian_get_asset",
      "smithsonian_list_files",
      "sketchfab_search_models",
      "sketchfab_get_model",
      "sketchfab_list_categories",
      "sketchfab_get_downloads",
      "audio_list_sources",
      "audio_search_assets",
      "audio_download_asset",
      "audio_inspect_asset",
      "audio_generate_sound",
      "itch_list_downloads",
      "itch_download_asset",
      "asset_list_bundle_entries",
      "asset_download_bundle_entry",
      "asset_list_bundle_animations",
      "asset_download_bundle_animation",
      "asset_list_sources",
      "asset_search_sources",
      "asset_download_file",
    ]);

    const called = jsonResponse(child, 3);
    send(child, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "fab_list_filters", arguments: {} },
    });
    const callResponse = await called;
    expect(callResponse).toHaveProperty("result.structuredContent.filters");

    await stopServer(child);
    const lines = stdout.join("").split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(() => lines.map((line) => JSON.parse(line))).not.toThrow();
  });

  it("should inspect a rig and its local library over stdio", async () => {
    const { child } = await startInitializedServer();
    const directory = await mkdtemp(join(tmpdir(), "asset-mcp-rig-stdio-"));
    temporaryDirectories.push(directory);
    const target = join(directory, "aether-02.glb");
    await writeFile(target, await rigFixtureGlb());
    const library = join(directory, "UAL1_Standard.zip");
    await writeFile(library, await rigLibraryZip());

    const response = await callTool(child, 3, "asset_inspect_rig", {
      target,
      libraries: [library],
    });

    expect(response).toMatchObject({
      result: {
        structuredContent: {
          target: { report: { skins: [{ joints: 2 }] } },
          catalog: [{ id: "ual1/Walk_Loop", variant: "in_place" }],
        },
      },
    });
    const catalog = (
      response.result as {
        structuredContent: { catalog: Array<{ donor: { url: string | null } }> };
      }
    ).structuredContent.catalog;
    expect(catalog[0]?.donor.url).toContain("animation-assets-v0.8.0");

    await stopServer(child);
  });

  it("should terminate cleanly", async () => {
    const { child } = await startInitializedServer();
    const startedAt = Date.now();

    await stopServer(child);

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(child.exitCode).toBe(0);
  });

  it("should return pinned creature syntax when the client calls creature_guide", async () => {
    const { child } = await startInitializedServer();

    const response = await callTool(child, 3, "creature_guide", {
      section: "syntax",
    });

    expect(response).toMatchObject({
      result: {
        structuredContent: {
          section: "syntax",
          guide: expect.stringContaining("Spec JSON — the whole language on one page"),
          upstream: {
            version: "1.3.1",
            commit: "44e1abc2c7fe083f19f989c8437c44a141adc7f3",
          },
          integrity: {
            archiveSha256: "cc25c9a9c170d43741803d5531f853bc89ebfd58a98d9fdda90834c53822084d",
          },
        },
      },
    });

    await stopServer(child);
  });

  it("should report unavailable tooling when an optional executable is absent", async () => {
    const { child } = await startInitializedServer({
      environment: { PATH: "" },
    });

    const response = await callTool(child, 3, "creature_status");

    expect(response).toMatchObject({
      result: {
        structuredContent: {
          operations: {
            creature_status: { available: true },
            creature_guide: { available: true },
            creature_compile: { available: false },
          },
          tooling: {
            pythonSilhouettes: {
              available: false,
              executable: "python3",
            },
          },
        },
      },
    });

    await stopServer(child);
  });

  if (process.platform !== "win32") {
    it("should not report a non-executable PATH candidate as optional tooling", async () => {
      const executableDirectory = await mkdtemp(
        join(tmpdir(), "threenative-asset-mcp-noexec-"),
      );
      temporaryDirectories.push(executableDirectory);
      const candidate = join(executableDirectory, "python3");
      await writeFile(candidate, "#!/bin/sh\nexit 0\n");
      await chmod(candidate, 0o644);
      const { child } = await startInitializedServer({
        environment: { PATH: executableDirectory },
      });

      const response = await callTool(child, 3, "creature_status");

      expect(response).toMatchObject({
        result: {
          structuredContent: {
            tooling: {
              pythonSilhouettes: {
                available: false,
                executable: "python3",
              },
            },
          },
        },
      });

      await stopServer(child);
    });

    it("should probe NumPy and Pillow instead of trusting an executable bit", async () => {
      const executableDirectory = await mkdtemp(
        join(tmpdir(), "threenative-asset-mcp-python-no-deps-"),
      );
      temporaryDirectories.push(executableDirectory);
      const candidate = join(executableDirectory, "python3");
      await writeFile(
        candidate,
        "#!/bin/sh\nprintf '%s\\n' 'ModuleNotFoundError: No module named numpy' >&2\nexit 1\n",
      );
      await chmod(candidate, 0o755);
      const { child } = await startInitializedServer({
        environment: { PATH: executableDirectory },
      });

      const response = await callTool(child, 3, "creature_status");

      expect(response).toMatchObject({
        result: {
          structuredContent: {
            tooling: {
              pythonSilhouettes: {
                available: false,
                executable: "python3",
                reason: expect.stringMatching(/NumPy|Pillow/u),
              },
            },
          },
        },
      });

      await stopServer(child);
    });

    it("should probe Chromium launch availability in an active creature project", async () => {
      const projectRoot = await mkdtemp(
        join(tmpdir(), "threenative-asset-mcp-no-chromium-"),
      );
      temporaryDirectories.push(projectRoot);
      await mkdir(join(projectRoot, ".threenative"), { recursive: true });
      const emptyHome = join(projectRoot, "empty-home");
      const emptyBrowsers = join(projectRoot, "empty-browsers");
      const cache = join(projectRoot, "cache");
      await mkdir(emptyHome, { recursive: true });
      await mkdir(emptyBrowsers, { recursive: true });
      const { child } = await startInitializedServer({
        cwd: projectRoot,
        environment: {
          HOME: emptyHome,
          XDG_CACHE_HOME: cache,
          PLAYWRIGHT_BROWSERS_PATH: emptyBrowsers,
          PW_CHROMIUM_PATH: join(projectRoot, "missing-chromium"),
        },
      });

      const response = await callTool(child, 3, "creature_status");

      expect(response).toMatchObject({
        result: {
          structuredContent: {
            operations: {
              creature_compile: { available: true },
              creature_preview: { available: true },
            },
            tooling: {
              chromiumRender: {
                available: false,
                reason: expect.stringMatching(/playwright install chromium|Chromium/u),
              },
            },
          },
        },
      });

      await stopServer(child);
    }, 30_000);
  }

  it(
    "should serve creature discovery from the installed package bin",
    async () => {
      const installed = await installPackedPackage();
      const { child } = await startInitializedServer({
        command: installed.command,
        cwd: installed.cwd,
      });

      const status = await callTool(child, 3, "creature_status");
      const guide = await callTool(child, 4, "creature_guide", {
        section: "syntax",
      });

      expect(status).toMatchObject({
        result: {
          structuredContent: {
            operations: {
              creature_status: { available: true },
              creature_guide: { available: true },
              creature_compile: { available: false },
            },
          },
        },
      });
      expect(guide).toMatchObject({
        result: {
          structuredContent: {
            guide: expect.stringContaining("Spec JSON — the whole language on one page"),
          },
        },
      });

      await stopServer(child);
    },
    30_000,
  );

  it(
    "should register creature_preview for an installed package launched from a creature project",
    async () => {
      const installed = await installPackedPackage();
      await mkdir(join(installed.cwd, ".threenative", "creatures"), {
        recursive: true,
      });
      const { child } = await startInitializedServer({
        command: installed.command,
        cwd: installed.cwd,
      });

      const listed = jsonResponse(child, 3);
      send(child, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/list",
        params: {},
      });
      const names = (
        (await listed).result as { tools?: Array<{ name: string }> }
      ).tools?.map((tool) => tool.name);

      expect(names).toContain("creature_compile");
      expect(names).toContain("creature_preview");
      expect(names).toContain("creature_check");
      await stopServer(child);
    },
    30_000,
  );

  it(
    "should expose the check schema and adapted guide from an active creature project",
    async () => {
      const projectRoot = await mkdtemp(
        join(tmpdir(), "threenative-asset-mcp-check-schema-"),
      );
      temporaryDirectories.push(projectRoot);
      await mkdir(join(projectRoot, ".threenative"), { recursive: true });
      const { child } = await startInitializedServer({ cwd: projectRoot });

      try {
        const listed = jsonResponse(child, 3);
        send(child, {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/list",
          params: {},
        });
        const tools = (
          (await listed).result as {
            tools?: Array<{
              name: string;
              inputSchema?: Record<string, unknown>;
              outputSchema?: Record<string, unknown>;
            }>;
          }
        ).tools ?? [];
        const check = tools.find((tool) => tool.name === "creature_check");
        expect(check).toBeDefined();
        expect(JSON.stringify(check?.inputSchema)).toContain("claimsPath");
        expect(JSON.stringify(check?.inputSchema)).toContain("stage");
        expect(check?.outputSchema).toEqual(expect.any(Object));
        const inputRequired = requiredSets(check?.inputSchema);
        expect(inputRequired).toEqual(
          expect.arrayContaining([
            expect.arrayContaining(["glbPath", "mode"]),
            expect.arrayContaining(["glbPath", "mode", "claimsPath", "stage"]),
          ]),
        );
        const outputSchemaText = JSON.stringify(check?.outputSchema);
        expect(outputSchemaText).toContain("claims");
        expect(outputSchemaText).toContain("observations");
        expect(outputSchemaText).toContain("metricsPath");
        expect(requiredSets(check?.outputSchema)).toEqual(
          expect.arrayContaining([
            expect.arrayContaining(["mode", "claims", "observations"]),
          ]),
        );

        const guide = await callTool(child, 4, "creature_guide", {
          section: "overview",
        });
        expect(guide).toMatchObject({
          result: {
            structuredContent: {
              guide: expect.stringMatching(
                /creature_check[\s\S]*glbPath[\s\S]*claimsPath[\s\S]*stage[\s\S]*part_exists[\s\S]*tri_budget[\s\S]*metricsPath[\s\S]*notReviewed/u,
              ),
            },
          },
        });
      } finally {
        await stopServer(child);
      }
    },
    30_000,
  );
});
