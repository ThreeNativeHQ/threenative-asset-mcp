import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Document, NodeIO } from "@gltf-transform/core";
import sharp from "sharp";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { MODEL_ALIASES, DEFAULT_MODEL, resolveModel } from "../src/texture-projection/models.js";
import { MISSING_API_KEY_CODE, forwardImageRequest } from "../src/texture-projection/openrouter-proxy.js";
import {
  TextureProjectionError,
  paintTextureProjection,
  quoteTextureProjection,
} from "../src/texture-projection/runner.js";
import type { StoredRun } from "../src/texture-projection/runs.js";
import { startOpenRouterStub as startStub, type OpenRouterStub } from "./helpers/openrouter-stub.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEVEL = join(REPO, "tests", "fixtures", "texture-projection", "courtyard.glb");
const FAKE_KEY = "sk-or-v1-this-is-a-fake-key-that-must-never-leak";
const PLAN = { maxViews: 3, aerial: 0, roofs: 0, holes: 0, spacing: 6 };

const temporaryDirectories: string[] = [];
const stubs: OpenRouterStub[] = [];

async function startOpenRouterStub(png: string, options: { holdAt?: number } = {}) {
  const stub = await startStub(png, options);
  stubs.push(stub);
  return stub;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(stubs.splice(0).map((stub) => stub.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function scratchDir(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `threenative-asset-mcp-${name}-`));
  temporaryDirectories.push(directory);
  return directory;
}

let pngBase64 = "";

beforeAll(async () => {
  const png = await sharp({
    create: { width: 16, height: 16, channels: 3, background: { r: 196, g: 120, b: 72 } },
  })
    .png()
    .toBuffer();
  pngBase64 = png.toString("base64");
});

const sampleReference = () => [
  { type: "image_url" as const, image_url: { url: "data:image/png;base64,AAAA" } },
];

/** A GLB with one triangle and no TEXCOORD_0: valid geometry the projection cannot bake into. */
async function writeUvlessGlb(path: string): Promise<void> {
  const document = new Document();
  const buffer = document.createBuffer();
  const position = document
    .createAccessor()
    .setType("VEC3")
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
    .setBuffer(buffer);
  const primitive = document.createPrimitive().setAttribute("POSITION", position);
  const mesh = document.createMesh().setName("plate").addPrimitive(primitive);
  const node = document.createNode().setMesh(mesh);
  document.createScene().addChild(node);
  await new NodeIO().write(path, document);
}

/** The rejection (or undefined when the promise resolved), so a test can assert the error code. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

function expectTextureProjectionError(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(TextureProjectionError);
  expect((error as TextureProjectionError).code).toBe(code);
}

describe("texture-projection model aliases", () => {
  it("defaults to or-klein and lists the documented aliases with their OpenRouter ids and prices", () => {
    expect(DEFAULT_MODEL).toBe("or-klein");
    expect(MODEL_ALIASES.map((model) => model.key)).toEqual(["or-klein", "muse-image", "or-seedream-lite"]);
    expect(resolveModel("or-klein")).toMatchObject({
      id: "black-forest-labs/flux-3-image-klein",
      price: 0.009,
    });
    expect(resolveModel("muse-image")).toMatchObject({ id: "meta/muse-image", price: 0.01 });
    expect(resolveModel("or-seedream-lite")).toMatchObject({
      id: "bytedance-seed/seedream-5-0-lite",
      price: 0.035,
    });
    expect(resolveModel("flux3-klein")).toBeUndefined();
  });

  it("passes any or:<model-id> through, with the image in input_references and never in images", () => {
    const model = resolveModel("or:acme/any-image")!;
    expect(model.id).toBe("acme/any-image");
    const request = model.input({
      imageUrl: "data:image/png;base64,AAAA",
      prompt: { look: "stone walls", roofLook: "tiles", parts: "", mode: "first", floor: false },
      seed: 7,
    });
    expect(request.input_references).toEqual(sampleReference());
    expect(Object.keys(request)).not.toContain("images");
    expect(request.seed).toBe(7);
    expect(request.prompt).toContain("stone walls");
  });
});

describe("texture-projection OpenRouter proxy", () => {
  it("sends input_references with the key in the Authorization header, never an images field", async () => {
    const stub = await startOpenRouterStub(pngBase64);
    const env = { OPENROUTER_API_KEY: FAKE_KEY, OPENROUTER_BASE_URL: stub.url };
    const response = await forwardImageRequest(
      {
        model: "black-forest-labs/flux-3-image-klein",
        prompt: "A photo of stone walls",
        seed: 7,
        aspect_ratio: "1:1",
        input_references: sampleReference(),
      },
      { env },
    );
    expect(response.status).toBe(200);
    expect(Buffer.from(response.bytes).toString("utf8")).toContain(pngBase64);
    expect(stub.requests).toHaveLength(1);
    const sent = stub.requests[0]!;
    expect(sent.method).toBe("POST");
    expect(sent.authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(sent.body["input_references"]).toEqual(sampleReference());
    expect(sent.body).not.toHaveProperty("images");
    expect(sent.body["model"]).toBe("black-forest-labs/flux-3-image-klein");
  });

  it("adds a style image as a second reference with a materials-only instruction", async () => {
    const stub = await startOpenRouterStub(pngBase64);
    const env = { OPENROUTER_API_KEY: FAKE_KEY, OPENROUTER_BASE_URL: stub.url };
    const styleImage = "data:image/png;base64,STYLE";
    const response = await forwardImageRequest(
      {
        model: "black-forest-labs/flux-3-image-klein",
        prompt: "A photo of stone walls",
        input_references: sampleReference(),
        style_image: styleImage,
      },
      { env },
    );
    expect(response.status).toBe(200);
    const sent = stub.requests[0]!;
    const references = sent.body["input_references"] as { image_url: { url: string } }[];
    expect(references).toHaveLength(2);
    expect(references[1]?.image_url.url).toBe(styleImage);
    expect(sent.body["prompt"]).toContain("materials");
    expect(sent.body).not.toHaveProperty("style_image");
  });

  it("fails closed with TEXTURE_PROJECT_MISSING_API_KEY when no key is set", async () => {
    const stub = await startOpenRouterStub(pngBase64);
    const response = await forwardImageRequest(
      { model: "black-forest-labs/flux-3-image-klein", prompt: "p", input_references: sampleReference() },
      { env: { OPENROUTER_BASE_URL: stub.url } },
    );
    expect(response.status).toBe(500);
    const body = JSON.parse(Buffer.from(response.bytes).toString("utf8")) as { error: { code: string } };
    expect(body.error.code).toBe(MISSING_API_KEY_CODE);
    expect(stub.requests).toHaveLength(0);
  });

  it("rejects a body that would smuggle images or has no reference", async () => {
    const stub = await startOpenRouterStub(pngBase64);
    const env = { OPENROUTER_API_KEY: FAKE_KEY, OPENROUTER_BASE_URL: stub.url };
    const response = await forwardImageRequest({ model: "m", prompt: "p", images: ["x"], input_references: [] }, { env });
    expect(response.status).toBe(400);
    expect(stub.requests).toHaveLength(0);
  });
});

describe("texture-projection runner", () => {
  it("fails closed on a level with no TEXCOORD_0", async () => {
    const cwd = await scratchDir("uvless");
    const level = join(cwd, "plate.glb");
    await writeUvlessGlb(level);
    const env = { OPENROUTER_API_KEY: FAKE_KEY };
    expectTextureProjectionError(
      await rejection(paintTextureProjection({ levelPath: level, cwd, env })),
      "TEXTURE_PROJECT_MISSING_UV",
    );
    expectTextureProjectionError(
      await rejection(quoteTextureProjection({ levelPath: level, cwd, env })),
      "TEXTURE_PROJECT_MISSING_UV",
    );
  });

  it("fails closed with TEXTURE_PROJECT_MISSING_API_KEY before painting", async () => {
    const cwd = await scratchDir("nokey");
    expectTextureProjectionError(
      await rejection(paintTextureProjection({ levelPath: LEVEL, cwd, env: {} })),
      "TEXTURE_PROJECT_MISSING_API_KEY",
    );
  });

  it(
    "quotes planned views and a positive estimate with zero API calls",
    async () => {
      const cwd = await scratchDir("quote");
      const stub = await startOpenRouterStub(pngBase64);
      // No OPENROUTER_API_KEY on purpose: planning cameras costs nothing and needs no key.
      const quote = await quoteTextureProjection({
        levelPath: LEVEL,
        cwd,
        env: { OPENROUTER_BASE_URL: stub.url },
        plan: PLAN,
      });
      expect(quote.model).toBe("or-klein");
      expect(quote.views).toBeGreaterThan(0);
      expect(quote.estimatedUsd).toBeGreaterThan(0);
      expect(quote.estimatedUsd).toBeCloseTo((quote.views + quote.holes) * 0.009, 6);
      expect(stub.requests).toHaveLength(0);
    },
    180_000,
  );

  it(
    "paints a small run, writes a GLB atomically and keeps the key out of run.json and the logs",
    async () => {
      const cwd = await scratchDir("paint");
      const stub = await startOpenRouterStub(pngBase64);
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const logged: string[] = [];
      const outputPath = join(cwd, "assets", "courtyard_textured.glb");
      const result = await paintTextureProjection({
        levelPath: LEVEL,
        cwd,
        env: { OPENROUTER_API_KEY: FAKE_KEY, OPENROUTER_BASE_URL: stub.url },
        plan: PLAN,
        atlas: 256,
        viewSize: 128,
        runId: "paint-run",
        outputPath,
        onLog: (line) => logged.push(line),
      });

      expect(result.complete).toBe(true);
      expect(result.viewsPainted).toBeGreaterThan(0);
      expect(result.coveragePercent).toBeGreaterThan(0);
      expect(stub.requests.length).toBe(result.viewsPainted);
      const references = stub.requests[0]?.body["input_references"] as
        | { type: string; image_url: { url: string } }[]
        | undefined;
      expect(references).toHaveLength(1);
      expect(references?.[0]?.type).toBe("image_url");
      expect(references?.[0]?.image_url.url.startsWith("data:image/jpeg;base64,")).toBe(true);
      expect(stub.requests[0]?.body).not.toHaveProperty("images");
      expect(stub.requests[0]?.authorization).toBe(`Bearer ${FAKE_KEY}`);

      const glb = await readFile(outputPath);
      expect(glb.subarray(0, 4).toString("utf8")).toBe("glTF");
      expect(glb.byteLength).toBeGreaterThan(1024);
      // The bake, not just the geometry: the level material carries the projected atlas as its base colour.
      const baked = await new NodeIO().read(outputPath);
      const material = baked.getRoot().listMaterials()[0];
      expect(material?.getBaseColorTexture()).not.toBeNull();
      expect(material?.getBaseColorTexture()?.getSize()).toEqual([256, 256]);

      const runText = await readFile(join(cwd, ".threenative", "texture-projection", result.runId, "run.json"), "utf8");
      const run = JSON.parse(runText) as StoredRun;
      expect(run.complete).toBe(true);
      expect(run.views).toHaveLength(result.viewsPainted);
      for (const view of run.views) {
        for (const file of ["clay", "gen", "comp"]) {
          const image = await readFile(
            join(cwd, ".threenative", "texture-projection", result.runId, `view_${view.index}_${file}.png`),
          );
          expect(image.subarray(1, 4).toString("utf8")).toBe("PNG");
        }
      }

      const everything = [runText, JSON.stringify(result), logged.join("\n"), stdout.mock.calls.flat().join("\n"), stderr.mock.calls.flat().join("\n")].join("\n");
      expect(everything).not.toContain(FAKE_KEY);
    },
    240_000,
  );

  it(
    "paints exactly one view for a prompt test, persists it and leaves the run incomplete",
    async () => {
      const cwd = await scratchDir("prompt-test");
      const stub = await startOpenRouterStub(pngBase64);
      const outputPath = join(cwd, "assets", "courtyard_textured.glb");
      const result = await paintTextureProjection({
        levelPath: LEVEL,
        cwd,
        env: { OPENROUTER_API_KEY: FAKE_KEY, OPENROUTER_BASE_URL: stub.url },
        plan: PLAN,
        atlas: 256,
        viewSize: 128,
        runId: "prompt-test-run",
        outputPath,
        promptTestView: 0,
      });

      // One image bought, for one view only; the level's run is not complete.
      expect(stub.requests).toHaveLength(1);
      expect(result.complete).toBe(false);
      expect(result.viewsPainted).toBe(1);
      expect(existsSync(outputPath)).toBe(true);

      const directory = join(cwd, ".threenative", "texture-projection", "prompt-test-run");
      const run = JSON.parse(await readFile(join(directory, "run.json"), "utf8")) as StoredRun;
      expect(run.complete).toBe(false);
      expect(run.views).toHaveLength(1);
      expect(run.views[0]?.index).toBe(0);
      for (const file of ["clay", "gen", "comp"]) {
        expect(existsSync(join(directory, `view_0_${file}.png`))).toBe(true);
      }
    },
    240_000,
  );

  it(
    "resumes an interrupted run and requests only the views still missing",
    async () => {
      const cwd = await scratchDir("resume");
      // The second view's request is held open, so the first view's completion reaches the runner while
      // the browser is still waiting on the model: closing the browser there interrupts a real run.
      const stub = await startOpenRouterStub(pngBase64, { holdAt: 2 });
      const env = { OPENROUTER_API_KEY: FAKE_KEY, OPENROUTER_BASE_URL: stub.url };
      const interrupted = paintTextureProjection({
        levelPath: LEVEL,
        cwd,
        env,
        plan: PLAN,
        atlas: 256,
        viewSize: 128,
        runId: "resume-run",
        hooks: {
          onViewDone: () => {
            throw new Error("interrupted after the first paid view");
          },
        },
      });
      await expect(interrupted).rejects.toThrow("interrupted after the first paid view");
      stub.release();

      const runPath = join(cwd, ".threenative", "texture-projection", "resume-run", "run.json");
      const partial = JSON.parse(await readFile(runPath, "utf8")) as StoredRun;
      expect(partial.complete).toBe(false);
      expect(partial.views).toHaveLength(1);
      const planned = partial.plan.views.length;
      expect(planned).toBeGreaterThan(1);
      // View 0's image and the view the browser was waiting on when it was closed.
      const beforeResume = stub.requests.length;

      const resumed = await paintTextureProjection({
        resumeRunId: "resume-run",
        cwd,
        env,
        outputPath: join(cwd, "courtyard_textured.glb"),
      });
      expect(resumed.complete).toBe(true);
      const finished = JSON.parse(await readFile(runPath, "utf8")) as StoredRun;
      expect(finished.complete).toBe(true);
      // Exactly one paid request per view the resumed run painted: view 0 was kept, not bought again.
      expect(stub.requests.length - beforeResume).toBe(resumed.viewsPainted);
      expect(finished.views.length).toBe(1 + resumed.viewsPainted);
      expect(finished.views[0]?.index).toBe(0);
      expect(resumed.viewsPainted).toBeGreaterThan(0);
    },
    300_000,
  );
});
