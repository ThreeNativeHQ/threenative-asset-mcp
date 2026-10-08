import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/server";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  previewCreature,
  validatePreviewPng,
} from "../src/creature/preview.js";
import type { CreatureRunner } from "../src/creature/runner.js";
import { describeWithTools } from "./helpers/require-tool.js";

const WYVERN_SPEC = {
  name: "ember_crown_wyvern",
  height: 2.56,
  style: "heavy",
  palette: {
    torso_scale: { color: "#26333a", rough: 0.82 },
    throat_scale: { color: "#46545a", rough: 0.76 },
    tail_scale: { color: "#1d292f", rough: 0.84 },
    leg_scale: { color: "#303d42", rough: 0.8 },
    wing_membrane: { color: "#a9422f", rough: 0.72 },
    crown_horn: { color: "#d9b66f", rough: 0.48 },
    jaw_plate: { color: "#714033", rough: 0.7 },
    eye_ember: { color: "#ffb21f", rough: 0.2 },
  },
  shading: {
    pattern: { color: "#66747a", sharpness: 0.62, amount: 0.34, scale: 0.055 },
    ramp: { bottom: "#0d1519", mid: "#34434a", top: "#7b8585", pm: 0.35, wm: 0.09 },
  },
  smooth_angle: 28,
  joints: {
    Pelvis: [0, 1.03, -0.28],
    Midback: { from: "Pelvis", up: 0.19, fwd: 0.23 },
    Breast: { from: "Midback", up: 0.27, fwd: 0.2 },
    Withers: { from: "Breast", up: 0.16, fwd: 0.08 },
    NeckBase: { from: "Withers", up: 0.116, fwd: 0.09 },
    NeckCrest: { from: "NeckBase", up: 0.14, fwd: 0.13 },
    Cranium: { from: "NeckCrest", up: 0.04, fwd: 0.2 },
    Jaw: { from: "Cranium", up: -0.1, fwd: 0.24 },
    Snout: { from: "Jaw", up: 0.015, fwd: 0.3 },
    TailSocket: { from: "Pelvis", up: 0.02, fwd: -0.124 },
    TailA: { from: "TailSocket", up: 0.06, fwd: -0.32 },
    TailB: { from: "TailA", up: 0.03, fwd: -0.38 },
    TailC: { from: "TailB", up: -0.08, fwd: -0.36 },
    TailD: { from: "TailC", up: -0.13, fwd: -0.31 },
    TailBlade: { from: "TailD", up: -0.1, fwd: -0.27 },
    LThigh: { from: "Pelvis", side: 0.135, up: -0.014, fwd: 0.01 },
    LShin: { from: "LThigh", side: 0.04, up: -0.43, fwd: 0.17 },
    LAnkle: { from: "LShin", side: 0.015, up: -0.34, fwd: -0.12 },
    LFoot: { from: "LAnkle", side: 0.01, fwd: 0.24, ground: 0.04 },
  },
  chains: {
    torso: ["Pelvis", "Midback", "Breast", "Withers"],
    neck: ["NeckBase", "NeckCrest", "Cranium", "Jaw", "Snout"],
    tail: ["TailSocket", "TailA", "TailB", "TailC", "TailD", "TailBlade"],
    LLeg: ["LThigh", "LShin", "LAnkle", "LFoot"],
  },
  attach: { neck: "Withers", tail: "Pelvis", LLeg: "Pelvis" },
  mirror: ["LLeg"],
  touch: [["torso", "neck"], ["torso", "tail"]],
  volumes: [
    {
      chain: "torso",
      material: "torso_scale",
      frame: "up",
      sides: 12,
      smooth_angle: 24,
      profile: [[0, 0.3, 0.27], [0.28, 0.31, 0.29], [0.72, 0.36, 0.34], [1, 0.3, 0.28]],
      caps: ["dome", "dome"],
    },
    {
      chain: "neck",
      material: "throat_scale",
      frame: "up",
      sides: 10,
      smooth_angle: 25,
      profile: [[0, 0.2, 0.19], [0.34, 0.17, 0.18], [0.67, 0.25, 0.2], [0.84, 0.18, 0.14], [1, 0.09, 0.075]],
      caps: ["none", "dome"],
    },
    {
      chain: "tail",
      material: "tail_scale",
      sides: 9,
      smooth_angle: 28,
      profile: [[0, 0.18, 0.17], [0.22, 0.155, 0.145], [0.55, 0.11, 0.1], [0.82, 0.065, 0.06], [1, 0.025, 0.022]],
      caps: ["none", "dome"],
    },
    {
      chain: "LLeg",
      material: "leg_scale",
      sides: 9,
      smooth_angle: 28,
      profile: [[0, 0.095, 0.13], [0.38, 0.105, 0.12], [0.74, 0.08, 0.085], [1, 0.055, 0.045]],
      caps: ["none", "dome"],
    },
  ],
  parts: [
    {
      type: "fin",
      name: "swept_wing",
      host: "Withers",
      material: "wing_membrane",
      thickness: 0.035,
      conform: false,
      anchor: { chain: "torso", t: 0.86, around: 62 },
      udir: [0.94, 0.25, -0.22],
      vdir: [-0.12, 0.48, -0.88],
      points: [[-0.05, -0.04], [0.48, 0.08], [1.18, 0.42], [0.92, -0.2], [0.34, -0.38], [0.02, -0.17]],
      mirrored: true,
    },
    {
      type: "curve",
      name: "brow_horn",
      host: "Cranium",
      material: "crown_horn",
      join: "place",
      offset: [0.11, 0.12, 0.015],
      dir: [0.3, 0.72, -0.15],
      sides: 8,
      segments: [{ len: 0.18, r: 0.055, rise: 18 }, { len: 0.16, r: 0.038, behind: 24 }, { len: 0.11, r: 0.018, taper: true }],
      mirrored: true,
    },
    {
      type: "fin",
      name: "lower_jaw_keel",
      host: "Jaw",
      material: "jaw_plate",
      thickness: 0.025,
      conform: false,
      anchor: { chain: "neck", t: 0.77, around: 178 },
      udir: [0, 0, 1],
      vdir: [0, -1, 0],
      points: [[-0.04, 0], [0.28, -0.01], [0.2, -0.15], [0.03, -0.12]],
    },
    {
      type: "eye",
      host: "Cranium",
      material: "eye_ember",
      size: 0.042,
      anchor: { chain: "neck", t: 0.68, around: 62 },
    },
    {
      type: "paw",
      toes: 3,
      host: "LFoot",
      material: "leg_scale",
      size: [0.3, 0.22, 0.12],
      mirrored: true,
    },
  ],
  animations: {
    idle: {
      duration: 2.4,
      loop: true,
      tracks: {
        NeckBase: { rx: [[0, -3], [0.5, 4], [1, -3]] },
        Cranium: { rx: [[0, 2], [0.5, -3], [1, 2]] },
        TailA: { ry: [[0, -8], [0.5, 9], [1, -8]] },
        TailC: { ry: [[0, 7], [0.5, -10], [1, 7]] },
      },
    },
    move: {
      duration: 1.05,
      loop: true,
      mirror_phase: 0.5,
      tracks: {
        LThigh: { rx: [[0, 10], [0.5, -12], [1, 10]] },
        Pelvis: { ty: [[0, 0], [0.25, 0.025], [0.5, 0], [0.75, 0.025], [1, 0]] },
        TailB: { ry: [[0, 6], [0.5, -7], [1, 6]] },
      },
    },
    attack: {
      duration: 0.82,
      loop: false,
      tracks: {
        Pelvis: { tz: [[0, 0], [0.22, -0.16], [0.5, 0.58], [0.78, 0.18], [1, 0]] },
        Breast: { rx: [[0, 0], [0.22, -10], [0.5, 17], [1, 0]] },
        Jaw: { rx: [[0, 0], [0.32, 14], [0.52, -18], [1, 0]] },
        TailA: { ry: [[0, 0], [0.25, 14], [0.55, -11], [1, 0]] },
      },
    },
  },
};

const temporaryDirectories: string[] = [];
let installedCommand = "";

function fakePreviewRunner(
  projectRoot: string,
  payloadRoot: string,
): CreatureRunner {
  return {
    withHeavyOperation: <T>(
      _timeoutMs: number,
      _timeoutMessage: string,
      signal: AbortSignal | undefined,
      operation: (operationSignal: AbortSignal) => Promise<T>,
    ) => operation(signal ?? new AbortController().signal),
    resolveProjectFile: async () => ({
      root: projectRoot,
      absolute: join(projectRoot, "model.glb"),
      relative: "model.glb",
    }),
    createPreviewDirectory: async (previewId: string) => {
      const directory = join(
        projectRoot,
        ".threenative",
        "creatures",
        "previews",
        previewId,
      );
      await mkdir(directory, { recursive: false, mode: 0o700 });
      return {
        root: projectRoot,
        directory,
        relative: `.threenative/creatures/previews/${previewId}`,
      };
    },
    ensurePayload: async () => payloadRoot,
  } as unknown as CreatureRunner;
}

async function createFakePreviewFixture(): Promise<{
  readonly projectRoot: string;
  readonly payloadRoot: string;
}> {
  const projectRoot = await mkdtemp(join(tmpdir(), "creature-preview-unit-project-"));
  const payloadRoot = await mkdtemp(join(tmpdir(), "creature-preview-unit-payload-"));
  temporaryDirectories.push(projectRoot, payloadRoot);
  await mkdir(join(projectRoot, ".threenative", "creatures", "previews"), {
    recursive: true,
  });
  await writeFile(join(projectRoot, "model.glb"), "fixture-glb");
  return { projectRoot, payloadRoot };
}

async function withEnvironment<T>(
  values: NodeJS.ProcessEnv,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await operation();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
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

beforeAll(async () => {
  const packageDirectory = await mkdtemp(join(tmpdir(), "creature-preview-package-"));
  temporaryDirectories.push(packageDirectory);
  const packed = JSON.parse(
    npm(["pack", "--json", "--pack-destination", packageDirectory], resolve(".")),
  ) as Array<{ filename: string }>;
  const tarball = join(packageDirectory, packed[0]?.filename ?? "");
  const consumerDirectory = join(packageDirectory, "consumer");
  npm(
    ["install", "--ignore-scripts", "--no-package-lock", "--prefix", consumerDirectory, tarball],
    resolve("."),
  );
  installedCommand = join(consumerDirectory, "node_modules", ".bin", "threenative-asset-mcp");
  expect(existsSync(installedCommand)).toBe(true);
}, 30_000);

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function nextResponse(
  child: ChildProcessWithoutNullStreams,
  id: number,
  timeoutMs = 90_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolveResponse, reject) => {
    let buffer = "";
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for MCP response " + id)),
      timeoutMs,
    );
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
          clearTimeout(timeout);
          child.stdout.off("data", onData);
          reject(new Error("Non-JSON stdout from MCP: " + line));
          return;
        }
        if (message.id === id) {
          clearTimeout(timeout);
          child.stdout.off("data", onData);
          resolveResponse(message);
          return;
        }
      }
    };
    child.stdout.on("data", onData);
  });
}

function send(
  child: ChildProcessWithoutNullStreams,
  message: Record<string, unknown>,
): void {
  child.stdin.write(JSON.stringify(message) + "\n");
}

async function startServer(
  projectRoot: string,
  environment: NodeJS.ProcessEnv = {},
): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(process.execPath, [installedCommand], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ...environment,
      XDG_CACHE_HOME: join(projectRoot, ".cache"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const initialized = nextResponse(child, 1);
  send(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "creature-preview-integration", version: "1.0.0" },
    },
  });
  await initialized;
  send(child, { jsonrpc: "2.0", method: "notifications/initialized" });
  return child;
}

async function callTool(
  child: ChildProcessWithoutNullStreams,
  id: number,
  name: string,
  arguments_: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = nextResponse(child, id);
  send(child, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: arguments_ },
  });
  return response;
}

function resultOf(response: Record<string, unknown>): Record<string, unknown> {
  const result = response.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error("MCP response has no result");
  }
  return result as Record<string, unknown>;
}

function structured(response: Record<string, unknown>): Record<string, unknown> {
  const content = resultOf(response).structuredContent;
  if (typeof content !== "object" || content === null || Array.isArray(content)) {
    throw new Error("MCP response has no structuredContent");
  }
  return content as Record<string, unknown>;
}

async function stopServer(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
}

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "creature-preview-project-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, ".threenative", "creatures"), { recursive: true });
  await writeFile(
    join(root, ".threenative", "creatures", "wyvern.json"),
    JSON.stringify(WYVERN_SPEC, null, 2),
  );
  return root;
}

async function compileWyvern(
  child: ChildProcessWithoutNullStreams,
): Promise<Record<string, unknown>> {
  const response = await callTool(child, 2, "creature_compile", {
    specPath: ".threenative/creatures/wyvern.json",
    outputPath: "assets/creatures/wyvern.glb",
  });
  if (resultOf(response).isError) {
    throw new Error(JSON.stringify(response, null, 2));
  }
  return structured(response);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function expectNonblankPng(data: string): Promise<void> {
  const bytes = Buffer.from(data, "base64");
  const image = sharp(bytes).greyscale();
  const metadata = await image.metadata();
  expect(metadata.format).toBe("png");
  expect(metadata.width).toBeGreaterThanOrEqual(240);
  expect(metadata.height).toBeGreaterThanOrEqual(240);
  const pixels = await image.raw().toBuffer();
  let dark = 0;
  let light = 0;
  for (const value of pixels) {
    if (value < 96) dark += 1;
    if (value > 224) light += 1;
  }
  expect(dark).toBeGreaterThan(100);
  expect(light).toBeGreaterThan(100);
}

describe("creature_preview failure boundaries", () => {
  it.skipIf(process.platform === "win32")(
    "should preserve CANCELLED when the Python silhouette process is aborted",
    async () => {
      const { projectRoot, payloadRoot } = await createFakePreviewFixture();
      const python = join(projectRoot, "slow-python");
      await writeFile(python, "#!/bin/sh\nsleep 30\n");
      await chmod(python, 0o755);

      const caller = new AbortController();
      const pending = withEnvironment(
        { THREENATIVE_CREATURE_PYTHON: python },
        () =>
          previewCreature(
            fakePreviewRunner(projectRoot, payloadRoot),
            { glbPath: "model.glb", mode: "silhouettes" },
            caller.signal,
          ),
      );
      const abortTimer = setTimeout(() => caller.abort(), 100);
      try {
        await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
      } finally {
        clearTimeout(abortTimer);
      }
    },
  );

  it(
    "should preserve TIMEOUT when the browser preview process is aborted",
    async () => {
      const { projectRoot, payloadRoot } = await createFakePreviewFixture();
      await mkdir(join(payloadRoot, "harness", "assets"), { recursive: true });
      await writeFile(join(payloadRoot, "harness", "pwlaunch.mjs"), "");
      await writeFile(join(payloadRoot, "harness", "pwprobe.mjs"), "");
      await writeFile(join(payloadRoot, "harness", "silmetrics.mjs"), "");
      await writeFile(
        join(payloadRoot, "harness", "hero.mjs"),
        "setTimeout(() => {}, 30000);\n",
      );
      await writeFile(
        join(payloadRoot, "harness", "assets", "three-bundle.js"),
        "",
      );

      const caller = new AbortController();
      const pending = previewCreature(
        fakePreviewRunner(projectRoot, payloadRoot),
        { glbPath: "model.glb", mode: "hero" },
        caller.signal,
      );
      const abortTimer = setTimeout(
        () => caller.abort({ kind: "timeout" }),
        100,
      );
      try {
        await expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
      } finally {
        clearTimeout(abortTimer);
      }
    },
  );

  it("should require the exact backend camera dimensions for PNGs", async () => {
    const { projectRoot } = await createFakePreviewFixture();
    const path = join(projectRoot, "wrong-size.png");
    await sharp({
      create: {
        width: 320,
        height: 640,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 1 },
      },
    })
      .png()
      .toFile(path);

    await expect(
      validatePreviewPng(path, { width: 640, height: 640 }),
    ).rejects.toMatchObject({
      code: "TOOLCHAIN_UNAVAILABLE",
      detail: {
        expectedWidth: 640,
        expectedHeight: 640,
        actualWidth: 320,
        actualHeight: 640,
      },
    });
  });
});

describeWithTools(["python-imaging"], "creature_preview installed MCP silhouettes", () => {
  it(
    "should return four nonblank silhouette views when the wyvern is compiled",
    async () => {
      const root = await createProject();
      const child = await startServer(root);

      try {
        const compiled = await compileWyvern(child);
        const response = await callTool(child, 3, "creature_preview", {
          glbPath: compiled.outputPath,
          mode: "silhouettes",
        });
        if (resultOf(response).isError) {
          throw new Error(JSON.stringify(response, null, 2));
        }

        const output = structured(response);
        expect(output).toMatchObject({
          operation: "creature_preview",
          mode: "silhouettes",
          glbPath: "assets/creatures/wyvern.glb",
          glbSha256: compiled.outputSha256,
          backend: {
            id: "python-outline",
            nativeViewNames: ["front", "side", "top", "hero"],
            camera: {
              projection: "perspective",
              fovDegrees: 30,
              resolution: { width: 640, height: 640 },
              distanceMultiplier: 2.4,
            },
          },
          visualReview: "notReviewed",
          encodedImageBudgetBytes: 4_194_304,
        });

        const views = output.views as Array<Record<string, unknown>>;
        expect(views.map((view) => view.name)).toEqual([
          "front",
          "side",
          "top",
          "hero",
        ]);
        for (const view of views) {
          expect(view).toMatchObject({
            image: {
              included: true,
              path: expect.stringMatching(/sil_(front|side|top|hero)\.png$/u),
              sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
            },
            thumbnail: {
              included: true,
              path: expect.stringMatching(/_thumb48\.png$/u),
              sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
            },
            measurements: expect.objectContaining({ empty: expect.not.stringMatching(/./u) }),
          });
        }

        const side = views.find((view) => view.name === "side");
        const hero = views.find((view) => view.name === "hero");
        expect(side?.measurements).toMatchObject({
          W_over_H: expect.any(Number),
          protrusions: expect.any(Number),
          thinnest_px48: expect.any(Number),
        });
        expect((side?.measurements as { W_over_H: number }).W_over_H).toBeGreaterThan(1);
        expect((side?.measurements as { protrusions: number }).protrusions).toBeGreaterThanOrEqual(3);
        expect((hero?.measurements as { protrusions: number }).protrusions).toBeGreaterThanOrEqual(3);

        const content = resultOf(response).content as Array<Record<string, unknown>>;
        const images = content.filter((block) => block.type === "image");
        expect(images).toHaveLength(8);
        for (const image of images) {
          expect(image.mimeType).toBe("image/png");
          await expectNonblankPng(image.data as string);
        }

        for (const view of views) {
          const image = view.image as { path: string; sha256: string };
          const thumbnail = view.thumbnail as { path: string; sha256: string };
          expect(sha256(await readFile(join(root, image.path)))).toBe(image.sha256);
          expect(sha256(await readFile(join(root, thumbnail.path)))).toBe(
            thumbnail.sha256,
          );
        }
        const receipt = JSON.parse(
          await readFile(join(root, output.receiptPath as string), "utf8"),
        ) as Record<string, unknown>;
        expect(receipt).toMatchObject({
          previewId: output.previewId,
          glbSha256: compiled.outputSha256,
          backend: output.backend,
          views: output.views,
          visualReview: "notReviewed",
        });
      } finally {
        await stopServer(child);
      }
    },
    120_000,
  );

  it(
    "should reject comparison when the previous backend differs",
    async () => {
      const root = await createProject();
      const child = await startServer(root);
      try {
        const compiled = await compileWyvern(child);
        const first = await callTool(child, 3, "creature_preview", {
          glbPath: compiled.outputPath,
          mode: "silhouettes",
        });
        const firstOutput = structured(first);
        const receiptPath = join(root, firstOutput.receiptPath as string);
        const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
        const backend = receipt.backend as Record<string, unknown>;
        // Switch to whichever silhouette backend this host did not use, so the change is real.
        backend.id = backend.id === "browser-silmetrics" ? "python-outline" : "browser-silmetrics";
        await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

        const second = await callTool(child, 4, "creature_preview", {
          glbPath: compiled.outputPath,
          mode: "silhouettes",
          previousPreviewId: firstOutput.previewId,
        });
        expect(resultOf(second)).toMatchObject({
          isError: true,
          structuredContent: {
            operation: "creature_preview",
            code: "PREVIEW_COMPARISON",
          },
        });
      } finally {
        await stopServer(child);
      }
    },
    120_000,
  );

  it(
    "should reject comparison when a prior artifact hash or byte count is tampered",
    async () => {
      const root = await createProject();
      const child = await startServer(root);
      try {
        const compiled = await compileWyvern(child);
        const first = await callTool(child, 3, "creature_preview", {
          glbPath: compiled.outputPath,
          mode: "silhouettes",
        });
        const firstOutput = structured(first);
        const receiptPath = join(root, firstOutput.receiptPath as string);
        const receipt = JSON.parse(
          await readFile(receiptPath, "utf8"),
        ) as Record<string, unknown>;
        const views = receipt.views as Array<Record<string, unknown>>;
        const image = views[0]?.image as Record<string, unknown>;
        image.sha256 = "0".repeat(64);
        image.bytes = Number(image.bytes) + 1;
        await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

        const second = await callTool(child, 4, "creature_preview", {
          glbPath: compiled.outputPath,
          mode: "silhouettes",
          previousPreviewId: firstOutput.previewId,
        });
        expect(resultOf(second)).toMatchObject({
          isError: true,
          structuredContent: {
            operation: "creature_preview",
            code: "PREVIEW_COMPARISON",
          },
        });
      } finally {
        await stopServer(child);
      }
    },
    120_000,
  );

  it(
    "should reject comparison when a prior artifact file is tampered",
    async () => {
      const root = await createProject();
      const child = await startServer(root);
      try {
        const compiled = await compileWyvern(child);
        const first = await callTool(child, 3, "creature_preview", {
          glbPath: compiled.outputPath,
          mode: "silhouettes",
        });
        const firstOutput = structured(first);
        const receipt = JSON.parse(
          await readFile(join(root, firstOutput.receiptPath as string), "utf8"),
        ) as { views: Array<{ image: { path: string } }> };
        await writeFile(
          join(root, receipt.views[0]?.image.path ?? "missing.png"),
          "tampered preview bytes",
        );

        const second = await callTool(child, 4, "creature_preview", {
          glbPath: compiled.outputPath,
          mode: "silhouettes",
          previousPreviewId: firstOutput.previewId,
        });
        expect(resultOf(second)).toMatchObject({
          isError: true,
          structuredContent: {
            operation: "creature_preview",
            code: "PREVIEW_COMPARISON",
          },
        });
      } finally {
        await stopServer(child);
      }
    },
    120_000,
  );

  it(
    "should reject comparison when a prior receipt uses a path alias or wrong preview id",
    async () => {
      const root = await createProject();
      const child = await startServer(root);
      try {
        const compiled = await compileWyvern(child);
        const first = await callTool(child, 3, "creature_preview", {
          glbPath: compiled.outputPath,
          mode: "silhouettes",
        });
        const firstOutput = structured(first);
        const receiptPath = join(root, firstOutput.receiptPath as string);
        const receipt = JSON.parse(
          await readFile(receiptPath, "utf8"),
        ) as Record<string, unknown>;
        const views = receipt.views as Array<Record<string, unknown>>;
        const image = views[0]?.image as Record<string, unknown>;
        const originalPath = String(image.path);
        image.path = `./${String(image.path)}`;
        await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

        const second = await callTool(child, 4, "creature_preview", {
          glbPath: compiled.outputPath,
          mode: "silhouettes",
          previousPreviewId: firstOutput.previewId,
        });
        expect(resultOf(second)).toMatchObject({
          isError: true,
          structuredContent: {
            operation: "creature_preview",
            code: "PREVIEW_COMPARISON",
          },
        });

        image.path = originalPath;
        receipt.previewId = "different-preview";
        await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

        const third = await callTool(child, 5, "creature_preview", {
          glbPath: compiled.outputPath,
          mode: "silhouettes",
          previousPreviewId: firstOutput.previewId,
        });
        expect(resultOf(third)).toMatchObject({
          isError: true,
          structuredContent: {
            operation: "creature_preview",
            code: "PREVIEW_COMPARISON",
          },
        });
      } finally {
        await stopServer(child);
      }
    },
    120_000,
  );

});

describe("creature_preview installed MCP when Chromium cannot launch", () => {
  it(
    "should report unavailable hero rendering when Chromium cannot launch",
    async () => {
      const root = await createProject();
      const emptyHome = join(root, "empty-home");
      const emptyBrowsers = join(root, "empty-browsers");
      await mkdir(emptyHome, { recursive: true });
      await mkdir(emptyBrowsers, { recursive: true });
      const child = await startServer(root, {
        HOME: emptyHome,
        PLAYWRIGHT_BROWSERS_PATH: emptyBrowsers,
        PW_CHROMIUM_PATH: join(root, "missing-chromium"),
      });
      try {
        const compiled = await compileWyvern(child);
        const response = await callTool(child, 3, "creature_preview", {
          glbPath: compiled.outputPath,
          mode: "hero",
        });
        expect(resultOf(response)).toMatchObject({
          isError: true,
          structuredContent: {
            operation: "creature_preview",
            code: "TOOLCHAIN_UNAVAILABLE",
          },
        });
      } finally {
        await stopServer(child);
      }
    },
  );

});

describeWithTools(["chromium"], "creature_preview installed MCP hero rendering", () => {
  it(
    "should capture a hero image when Chromium is available",
    async () => {
      const root = await createProject();
      const child = await startServer(root);
      try {
        const compiled = await compileWyvern(child);
        const response = await callTool(child, 3, "creature_preview", {
          glbPath: compiled.outputPath,
          mode: "hero",
        });
        if (resultOf(response).isError) throw new Error(JSON.stringify(response, null, 2));
        const output = structured(response);
        expect(output).toMatchObject({
          operation: "creature_preview",
          mode: "hero",
          backend: {
            id: "browser-hero",
            nativeViewNames: ["hero"],
            camera: {
              fovDegrees: 32,
              resolution: { width: 1024, height: 1024 },
              initialDistanceMultiplier: 2.6,
              fitFraction: 0.83,
            },
          },
          visualReview: "notReviewed",
        });
        const views = output.views as Array<Record<string, unknown>>;
        expect(views).toHaveLength(1);
        expect(views[0]?.name).toBe("hero");
        const content = resultOf(response).content as Array<Record<string, unknown>>;
        expect(content.filter((block) => block.type === "image")).toHaveLength(2);
      } finally {
        await stopServer(child);
      }
    },
    120_000,
  );
});
