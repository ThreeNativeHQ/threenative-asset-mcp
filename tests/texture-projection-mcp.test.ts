import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";
import { Document, NodeIO } from "@gltf-transform/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readProjectedAtlasMarker } from "../src/texture-projection/glb-marker.js";
import { paintTextureProjection } from "../src/texture-projection/runner.js";
import {
  startOpenRouterStub,
  type OpenRouterStub,
} from "./helpers/openrouter-stub.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEVEL = join(REPO, "tests", "fixtures", "texture-projection", "courtyard.glb");
const FAKE_KEY = "sk-or-v1-mcp-test-key-that-must-never-leak";
const LEVEL_PATH = "assets/levels/courtyard.glb";
/** Small, fast settings: two views and a 256 atlas; paint sends 128 px images. */
const PLAN = { views: 2, aerial: 0, roofs: 0, holes: 0, atlas: 256 };
const PAINT_PLAN = { ...PLAN, viewSize: 128 };

const children = new Set<ChildProcessWithoutNullStreams>();
const temporaryDirectories: string[] = [];
const stubs: OpenRouterStub[] = [];

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit").catch(() => []);
    }
  }
  children.clear();
  await Promise.all(stubs.splice(0).map((stub) => stub.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function send(child: ChildProcessWithoutNullStreams, message: Record<string, unknown>): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

let nextId = 1;

function jsonResponse(child: ChildProcessWithoutNullStreams, id: number, timeoutMs = 300_000): Promise<Record<string, unknown>> {
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
          reject(new Error(`Non-JSON stdout from MCP: ${line.slice(0, 200)}`));
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

interface Server {
  readonly child: ChildProcessWithoutNullStreams;
}

async function startServer(project: string, environment: NodeJS.ProcessEnv): Promise<Server> {
  const profileDir = await mkdtemp(join(tmpdir(), "texture-projection-profile-"));
  temporaryDirectories.push(profileDir);
  const child = spawn(process.execPath, [join(REPO, "dist", "index.js")], {
    cwd: project,
    env: {
      ...process.env,
      OPENROUTER_API_KEY: "",
      FAB_BROWSER_PROFILE_DIR: profileDir,
      FAB_LOG_LEVEL: "error",
      ...environment,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  child.stderr.on("data", () => undefined);
  const initialized = jsonResponse(child, 1);
  send(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "texture-projection-mcp", version: "1.0.0" },
    },
  });
  expect(await initialized).toMatchObject({ result: { serverInfo: { name: "threenative-asset-mcp" } } });
  send(child, { jsonrpc: "2.0", method: "notifications/initialized" });
  return { child };
}

async function stopServer(server: Server): Promise<void> {
  if (server.child.exitCode !== null || server.child.signalCode !== null) return;
  const exited = once(server.child, "exit");
  server.child.kill("SIGTERM");
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error("MCP did not terminate")), 5_000))]);
  children.delete(server.child);
}

async function callTool(
  server: Server,
  name: string,
  arguments_: Record<string, unknown>,
): Promise<{ result: Record<string, unknown> }> {
  const id = (nextId += 1);
  const response = jsonResponse(server.child, id);
  send(server.child, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: arguments_ } });
  return (await response) as { result: Record<string, unknown> };
}

function structured(response: { result: Record<string, unknown> }): Record<string, unknown> {
  return response.result.structuredContent as Record<string, unknown>;
}

function contentText(response: { result: Record<string, unknown> }): string {
  const blocks = response.result.content as { type: string; text?: string }[];
  return blocks.map((block) => block.text ?? "").join("\n");
}

let project: string;
let stub: OpenRouterStub;

beforeEach(async () => {
  stub = await startOpenRouterStub("");
  stubs.push(stub);
  project = await mkdtemp(join(tmpdir(), "texture-projection-project-"));
  temporaryDirectories.push(project);
  await mkdir(join(project, "assets", "levels"), { recursive: true });
  await copyFile(LEVEL, join(project, LEVEL_PATH));
  // A project whose config would blur the bake: 1024 cap and ETC1S for base colour.
  await writeFile(
    join(project, "threenative.config.ts"),
    `export default {\n  assets: {\n    models: {\n      textures: {\n        maxSize: { baseColorTexture: 1024 },\n        overrides: [{ slot: "baseColorTexture", codec: "etc1s" }],\n      },\n    },\n  },\n} as const;\n`,
  );
}, 120_000);

describe("texture projection MCP tools", () => {
  it("should list the three tools with discovery text and their annotations", async () => {
    const server = await startServer(project, { OPENROUTER_BASE_URL: stub.url });
    try {
      const id = (nextId += 1);
      const listed = jsonResponse(server.child, id);
      send(server.child, { jsonrpc: "2.0", id, method: "tools/list", params: {} });
      const tools = ((await listed).result as { tools: { name: string; description: string; annotations: Record<string, unknown> }[] })
        .tools;
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      for (const name of ["texture_project_quote", "texture_project_paint", "texture_project_inspect"]) {
        expect(byName.has(name)).toBe(true);
      }
      expect(byName.get("texture_project_quote")?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
      expect(byName.get("texture_project_inspect")?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
      expect(byName.get("texture_project_paint")?.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
      for (const name of ["texture_project_quote", "texture_project_paint", "texture_project_inspect"]) {
        expect(byName.get(name)?.description ?? "").toMatch(/gray blockout level or environment/u);
      }
    } finally {
      await stopServer(server);
    }
  }, 120_000);

  it("should quote a UV-mapped level with no key and no request, and fail closed without UVs", async () => {
    const uvless = join(project, "assets", "levels", "plate.glb");
    await writeUvless(uvless);
    const server = await startServer(project, { OPENROUTER_BASE_URL: stub.url });
    try {
      const quote = await callTool(server, "texture_project_quote", { ...PLAN, levelPath: LEVEL_PATH });
      const summary = structured(quote);
      expect(summary).toMatchObject({ model: "or-klein", modelId: "black-forest-labs/flux-3-image-klein", atlas: 256 });
      expect(summary["views"]).toBeGreaterThan(0);
      expect(summary["estimatedUsd"]).toBeGreaterThan(0);
      expect(summary["estimatedBlurredTexelPercent"]).toBeTypeOf("number");
      expect(summary["uvStretch"]).toMatchObject({ triangles: expect.any(Number) });

      const missing = await callTool(server, "texture_project_quote", { levelPath: "assets/levels/plate.glb" });
      expect(missing.result.isError).toBe(true);
      expect(contentText(missing)).toContain("TEXTURE_PROJECT_MISSING_UV");
      expect(stub.requests).toHaveLength(0);
    } finally {
      await stopServer(server);
    }
  }, 300_000);

  it("should fail closed with TEXTURE_PROJECT_MISSING_API_KEY before a browser or a request", async () => {
    const server = await startServer(project, { OPENROUTER_BASE_URL: stub.url });
    try {
      const painted = await callTool(server, "texture_project_paint", {
        ...PAINT_PLAN,
        levelPath: LEVEL_PATH,
        outputPath: "assets/painted/courtyard.glb",
      });
      expect(painted.result.isError).toBe(true);
      expect(contentText(painted)).toContain("TEXTURE_PROJECT_MISSING_API_KEY");
      expect(stub.requests).toHaveLength(0);
      expect(existsSync(join(project, "assets", "painted", "courtyard.glb"))).toBe(false);
    } finally {
      await stopServer(server);
    }
  }, 120_000);

  it("should paint, prompt-test, resume an interrupted run and inspect the bake", async () => {
    const server = await startServer(project, { OPENROUTER_BASE_URL: stub.url, OPENROUTER_API_KEY: FAKE_KEY });
    try {
      const painted = await callTool(server, "texture_project_paint", {
        ...PAINT_PLAN,
        levelPath: LEVEL_PATH,
        outputPath: "assets/painted/courtyard.glb",
      });
      const run = structured(painted);
      expect(painted.result.isError).toBeFalsy();
      expect(run).toMatchObject({ atlas: 256, outputPath: expect.stringContaining("assets/painted/courtyard.glb") });
      expect(run["viewsPainted"]).toBeGreaterThan(0);
      expect(run["coveragePercent"]).toBeGreaterThan(0);
      expect(run["blurredTexelPercent"]).toBeTypeOf("number");
      expect(run["cookConfigHint"]).toContain("maxSize: { baseColorTexture: 256 }");
      expect(run["cookConfigHint"]).toContain('codec: "uastc"');
      expect(stub.requests).toHaveLength(run["viewsPainted"] as number);

      // C.3: the painted GLB marks its atlas image with the atlas size and run id.
      const glb = new Uint8Array(await readFile(join(project, "assets", "painted", "courtyard.glb")));
      expect(readProjectedAtlasMarker(glb)).toEqual({ atlas: 256, runId: run["runId"] });

      // promptTestView buys exactly one image and writes a new, incomplete run.
      const requestsBeforePromptTest = stub.requests.length;
      const promptTest = await callTool(server, "texture_project_paint", {
        ...PAINT_PLAN,
        levelPath: LEVEL_PATH,
        outputPath: "assets/painted/prompt-test.glb",
        promptTestView: 0,
      });
      expect(promptTest.result.isError).toBeFalsy();
      expect(stub.requests.length).toBe(requestsBeforePromptTest + 1);
      const promptRun = structured(promptTest);
      expect(promptRun["runId"]).not.toBe(run["runId"]);
      const promptRunState = JSON.parse(
        await readFile(join(project, ".threenative", "texture-projection", String(promptRun["runId"]), "run.json"), "utf8"),
      ) as { complete: boolean };
      expect(promptRunState.complete).toBe(false);

      // Interrupt a run after its first paid view, then resume it through the tool: only the missing
      // views are bought and the run completes.
      const interruptedRunId = "interrupted-run";
      await expect(
        paintTextureProjection({
          levelPath: join(project, LEVEL_PATH),
          cwd: project,
          env: { OPENROUTER_API_KEY: FAKE_KEY, OPENROUTER_BASE_URL: stub.url },
          plan: { maxViews: PLAN.views, aerial: 0, roofs: 0, holes: 0 },
          atlas: PLAN.atlas,
          viewSize: PAINT_PLAN.viewSize,
          runId: interruptedRunId,
          hooks: {
            onViewDone: () => {
              throw new Error("interrupted after the first paid view");
            },
          },
        }),
      ).rejects.toThrow("interrupted after the first paid view");
      const stored = JSON.parse(
        await readFile(join(project, ".threenative", "texture-projection", interruptedRunId, "run.json"), "utf8"),
      ) as { views: unknown[]; complete: boolean };
      expect(stored.complete).toBe(false);
      expect(stored.views).toHaveLength(1);

      const requestsBeforeResume = stub.requests.length;
      const resumed = await callTool(server, "texture_project_paint", {
        levelPath: LEVEL_PATH,
        outputPath: "assets/painted/resumed.glb",
        resumeRunId: interruptedRunId,
      });
      expect(resumed.result.isError).toBeFalsy();
      expect(stub.requests.length - requestsBeforeResume).toBe(structured(resumed)["viewsPainted"]);
      const finished = JSON.parse(
        await readFile(join(project, ".threenative", "texture-projection", interruptedRunId, "run.json"), "utf8"),
      ) as { complete: boolean; views: unknown[] };
      expect(finished.complete).toBe(true);
      expect(finished.views.length).toBeGreaterThan(1);

      // inspect returns the contact sheet as an image block and flags the project's cook settings.
      const inspected = await callTool(server, "texture_project_inspect", { runId: run["runId"] });
      const blocks = inspected.result.content as { type: string; mimeType?: string; data?: string }[];
      expect(blocks[0]).toMatchObject({ type: "image", mimeType: "image/png" });
      expect((blocks[0]?.data ?? "").length).toBeGreaterThan(2_000);
      const audit = structured(inspected);
      expect(audit).toMatchObject({ runId: run["runId"], atlas: 256, views: expect.any(Number) });
      expect(audit["blurredTexelPercent"]).toBeTypeOf("number");
      expect((audit["cookConfig"] as { flagged: boolean }).flagged).toBe(true);
      expect(
        ((audit["cookConfig"] as { findings: string[] }).findings).join(" "),
      ).toMatch(/1024 < the 256 atlas|ETC1S/u);
      expect(existsSync(join(project, String(audit["contactSheetPath"])))).toBe(true);

      // A projected GLB alone resolves its run through the marker.
      const inspectedGlb = await callTool(server, "texture_project_inspect", {
        glbPath: "assets/painted/courtyard.glb",
      });
      expect((inspectedGlb.result.content as { type: string }[])[0]?.type).toBe("image");
      expect(structured(inspectedGlb)["runId"]).toBe(run["runId"]);

      // The key never appears in any tool result.
      const everything = [painted, promptTest, resumed, inspected, inspectedGlb]
        .map((response) => JSON.stringify(response))
        .join("\n");
      expect(everything).not.toContain(FAKE_KEY);
    } finally {
      await stopServer(server);
    }
  }, 900_000);

  it("should refuse an output outside assets/ and an unknown tool argument", async () => {
    const server = await startServer(project, { OPENROUTER_BASE_URL: stub.url, OPENROUTER_API_KEY: FAKE_KEY });
    try {
      const escape = await callTool(server, "texture_project_paint", {
        ...PAINT_PLAN,
        levelPath: LEVEL_PATH,
        outputPath: "../outside.glb",
      });
      expect(escape.result.isError).toBe(true);
      expect(contentText(escape)).toContain("TEXTURE_PROJECT_UNSAFE_PATH");
      // Strict schemas: the MCP layer itself rejects an unknown field before the tool runs.
      const unknown = await callTool(server, "texture_project_quote", { levelPath: LEVEL_PATH, nonsense: true });
      expect(unknown.result.isError).toBe(true);
      expect(contentText(unknown)).toContain("nonsense");
      expect(existsSync(join(project, "..", "outside.glb"))).toBe(false);
      expect(stub.requests).toHaveLength(0);
    } finally {
      await stopServer(server);
    }
  }, 300_000);
});

/** A GLB with one triangle and no TEXCOORD_0. */
async function writeUvless(path: string): Promise<void> {
  const document = new Document();
  const buffer = document.createBuffer();
  const position = document
    .createAccessor()
    .setType("VEC3")
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
    .setBuffer(buffer);
  const primitive = document.createPrimitive().setAttribute("POSITION", position);
  const mesh = document.createMesh("plate").addPrimitive(primitive);
  const node = document.createNode("plate").setMesh(mesh);
  document.createScene().addChild(node);
  await new NodeIO().write(path, document);
}
