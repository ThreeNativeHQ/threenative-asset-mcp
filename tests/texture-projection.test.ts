import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Document, NodeIO } from "@gltf-transform/core";
import sharp from "sharp";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ATLAS_GUTTER_TEXELS, infillUnpainted } from "../src/texture-projection/atlas-pixels.js";
import {
  STRUCTURE_DEVIATION_LIMIT,
  lowFrequencyLuminance,
  rejectsStructure,
  structureDeviation,
} from "../src/texture-projection/app/core/structure.js";
import { auditCookConfig } from "../src/texture-projection/config-audit.js";
import { cookConfigHint } from "../src/tools/texture-projection.js";
import { markProjectedAtlas, readProjectedAtlasMarker } from "../src/texture-projection/glb-marker.js";
import { MODEL_ALIASES, DEFAULT_MODEL, prompts, resolveModel } from "../src/texture-projection/models.js";
import { loadLevel } from "../src/texture-projection/app/core/scene.js";
import { measureScaleAnchor } from "../src/texture-projection/app/core/scale.js";
import {
  MISSING_API_KEY_CODE,
  forwardChatRequest,
  forwardImageRequest,
} from "../src/texture-projection/openrouter-proxy.js";
import { DEFAULT_VERIFY_MODEL, parseVerifyAnswer, verifyPrompt } from "../src/texture-projection/verify.js";
import {
  MAX_AUTO_ATLAS,
  TextureProjectionError,
  autoAtlasSize,
  paintTextureProjection,
  quoteTextureProjection,
} from "../src/texture-projection/runner.js";
import { UV_STRETCH_LIMIT, measureUvStretch } from "../src/texture-projection/uv-stretch.js";
import type { StoredRun } from "../src/texture-projection/runs.js";
import { startOpenRouterStub as startStub, type OpenRouterStub } from "./helpers/openrouter-stub.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEVEL = join(REPO, "tests", "fixtures", "texture-projection", "courtyard.glb");
const FAKE_KEY = "sk-or-v1-this-is-a-fake-key-that-must-never-leak";
const PLAN = { maxViews: 3, aerial: 0, roofs: 0, holes: 0, spacing: 6 };

const temporaryDirectories: string[] = [];
const stubs: OpenRouterStub[] = [];

async function startOpenRouterStub(
  png: string,
  options: { holdAt?: number; paint?: "material" | "arch"; verify?: "ok" | "invented" | "garbage" | "once" } = {},
) {
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

/** A closed room: floor plus four walls, one flat clay surface per face (a deterministic wall to paint). */
async function writeRoomGlb(path: string, half = 10, height = 8): Promise<void> {
  const document = new Document();
  const buffer = document.createBuffer();
  const quad = (name: string, corners: [number, number, number][]) => {
    const position = document
      .createAccessor()
      .setType("VEC3")
      .setArray(new Float32Array(corners.flat()))
      .setBuffer(buffer);
    const uv = document
      .createAccessor()
      .setType("VEC2")
      .setArray(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]))
      .setBuffer(buffer);
    const indices = document
      .createAccessor()
      .setType("SCALAR")
      .setArray(new Uint16Array([0, 1, 2, 0, 2, 3]))
      .setBuffer(buffer);
    const primitive = document
      .createPrimitive()
      .setAttribute("POSITION", position)
      .setAttribute("TEXCOORD_0", uv)
      .setIndices(indices)
      .setMaterial(document.createMaterial(name));
    return document.createMesh(name).addPrimitive(primitive);
  };
  const h = half;
  const meshes = [
    quad("floor", [[-h, 0, -h], [-h, 0, h], [h, 0, h], [h, 0, -h]]),
    quad("north", [[-h, 0, -h], [h, 0, -h], [h, height, -h], [-h, height, -h]]),
    quad("south", [[h, 0, h], [-h, 0, h], [-h, height, h], [h, height, h]]),
    quad("west", [[-h, 0, h], [-h, 0, -h], [-h, height, -h], [-h, height, h]]),
    quad("east", [[h, 0, -h], [h, 0, h], [h, height, h], [h, height, -h]]),
  ];
  const scene = document.createScene("room");
  for (const mesh of meshes) scene.addChild(document.createNode(mesh.getName()).setMesh(mesh));
  await new NodeIO().write(path, document);
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
      // The vision check is on by default, priced in the estimate and cheap enough to be a rounding error
      // next to the images (< $0.002 per view).
      expect(quote.verifyModel).toBe(DEFAULT_VERIFY_MODEL.id);
      expect(quote.estimatedVerifyUsd).toBeGreaterThan(0);
      expect(quote.estimatedVerifyUsd / (quote.views + quote.holes)).toBeLessThan(0.002);
      // The estimate is the painted views at the image model plus the check, rounded to cents.
      expect(quote.estimatedUsd).toBe(
        Math.round(((quote.views + quote.holes) * quote.pricePerView + quote.estimatedVerifyUsd) * 100) / 100,
      );
      expect(stub.requests).toHaveLength(0);
    },
    180_000,
  );

  it(
    "plans no more views than the caller asked for, aerial ring included, and prices them in cents",
    async () => {
      const cwd = await scratchDir("quote-budget");
      const quote = await quoteTextureProjection({
        levelPath: LEVEL,
        cwd,
        env: {},
        plan: { maxViews: 12, aerial: 3, roofs: 0, holes: 4, spacing: 6 },
      });
      // The caller's view budget is the total: 3 aerial views leave at most 9 player views.
      expect(quote.views).toBeLessThanOrEqual(12);
      expect(quote.aerial).toBeLessThanOrEqual(3);
      expect(quote.aerial).toBeGreaterThan(0);
      // One price per image actually painted plus its check, rounded to cents.
      expect(quote.estimatedUsd).toBe(
        Math.round(((quote.views + quote.holes) * quote.pricePerView + quote.estimatedVerifyUsd) * 100) / 100,
      );
      // `verify: false` is the named override: no check, no check cost, and the run reports it.
      const unchecked = await quoteTextureProjection({
        levelPath: LEVEL,
        cwd,
        env: {},
        verify: false,
        plan: { maxViews: 12, aerial: 3, roofs: 0, holes: 4, spacing: 6 },
      });
      expect(unchecked.verifyModel).toBeNull();
      expect(unchecked.estimatedVerifyUsd).toBe(0);
      expect(unchecked.estimatedUsd).toBeLessThan(quote.estimatedUsd);
    },
    180_000,
  );

  it(
    "measures blur against the view image size, not only the atlas",
    async () => {
      const cwd = await scratchDir("quote-viewsize");
      const quoteAt = (viewSize: number) =>
        quoteTextureProjection({
          levelPath: LEVEL,
          cwd,
          env: {},
          atlas: 4096,
          viewSize,
          plan: { maxViews: 4, aerial: 0, roofs: 0, holes: 0, spacing: 6 },
        });
      const small = await quoteAt(256);
      const large = await quoteAt(512);
      expect(small.atlas).toBe(4096);
      expect(large.atlas).toBe(4096);
      // At half the view size one image pixel covers four times the atlas area, so many more texels
      // are magnification-blurred: the measurement has to follow the view size it was given.
      expect(small.estimatedBlurredTexelPercent).toBeGreaterThan(large.estimatedBlurredTexelPercent * 2 + 5);
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
        verify: false,
        runId: "paint-run",
        outputPath,
        onLog: (line) => logged.push(line),
      });

      expect(result.complete).toBe(true);
      expect(result.viewsPainted).toBeGreaterThan(0);
      expect(result.coveragePercent).toBeGreaterThan(0);
      expect(result.verifyModel).toBeNull();
      expect(stub.requests.length).toBe(result.viewsPainted);
      // No chat request either: verify:false buys images and nothing else.
      expect(stub.requests.every((sent) => Array.isArray(sent.body["input_references"]))).toBe(true);
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
    "refuses to paint a view pixel that would cover more than 2x2 atlas texels",
    async () => {
      const cwd = await scratchDir("magnification");
      const stub = await startOpenRouterStub(pngBase64);
      const plan = { maxViews: 3, aerial: 0, roofs: 0, holes: 0, spacing: 6 };
      // An atlas four times finer than the views resolve: without the guard most texels would be painted
      // from one stretched image pixel each.
      const quote = await quoteTextureProjection({
        levelPath: LEVEL,
        cwd,
        env: {},
        atlas: 1024,
        viewSize: 128,
        verify: false,
        plan,
      });
      expect(quote.estimatedBlurredTexelPercent).toBeGreaterThan(10);
      const result = await paintTextureProjection({
        levelPath: LEVEL,
        cwd,
        env: { OPENROUTER_API_KEY: FAKE_KEY, OPENROUTER_BASE_URL: stub.url },
        plan,
        atlas: 1024,
        viewSize: 128,
        verify: false,
        runId: "magnification-run",
        outputPath: join(cwd, "assets", "magnification.glb"),
      });
      // The guard is why the painted atlas has no magnified texel left: they wait for a closer view.
      expect(result.blurredTexelPercent).toBe(0);
      expect(result.magnificationSkippedPercent).toBeGreaterThan(1);
      expect(result.coveragePercent).toBeGreaterThan(0);

      // A bake at an atlas above the measurement cap reports the guard's own rule: blur 0 by
      // construction, the refused texels counted instead.
      const big = await paintTextureProjection({
        levelPath: LEVEL,
        cwd,
        env: { OPENROUTER_API_KEY: FAKE_KEY, OPENROUTER_BASE_URL: stub.url },
        plan,
        atlas: 4096,
        viewSize: 128,
        verify: false,
        runId: "magnification-4k-run",
        outputPath: join(cwd, "assets", "magnification-4k.glb"),
      });
      expect(big.atlas).toBe(4096);
      expect(big.blurredTexelPercent).toBe(0);
      // At 4096 px from 128 px views almost every texel is refused: that is the guard doing its job.
      expect(big.magnificationSkippedPercent).toBeGreaterThan(5);
      expect(existsSync(big.outputPath)).toBe(true);
    },
    300_000,
  );

  it(
    "stops buying after three invented-geometry views and keeps their images for a resume",
    async () => {
      const cwd = await scratchDir("structure");
      // A closed room where the arch the stub paints lands on a wall in every view.
      const room = join(cwd, "room.glb");
      await writeRoomGlb(room);
      const stub = await startOpenRouterStub(pngBase64, { paint: "arch" });
      const outputPath = join(cwd, "assets", "room_textured.glb");
      const error = await rejection(
        paintTextureProjection({
          levelPath: room,
          cwd,
          env: { OPENROUTER_API_KEY: FAKE_KEY, OPENROUTER_BASE_URL: stub.url },
          plan: { maxViews: 6, aerial: 0, roofs: 0, holes: 0, spacing: 4 },
          atlas: 256,
          viewSize: 128,
          runId: "arch-run",
          outputPath,
        }),
      );
      // The check fails closed: three rejected first views stop the run instead of buying six.
      expectTextureProjectionError(error, "TEXTURE_PROJECT_STRUCTURE_REJECTED");
      expect((error as Error).message).toContain("arch-run");
      expect((error as Error).message).toContain("resumeRunId");
      expect(stub.requests).toHaveLength(3);
      const run = JSON.parse(
        await readFile(join(cwd, ".threenative", "texture-projection", "arch-run", "run.json"), "utf8"),
      ) as StoredRun;
      expect(run.complete).toBe(false);
      expect(run.views.filter((view) => view.rejected === "structure")).toHaveLength(3);
      for (const view of run.views) {
        expect(view.structureDeviation).toBeGreaterThan(0.2);
        // Rejected views keep their images for the contact sheet and for a resume, so the reason stays checkable.
        expect(existsSync(join(cwd, ".threenative", "texture-projection", "arch-run", `view_${view.index}_gen.png`))).toBe(true);
      }
      // Nothing was baked, so no GLB was written over the caller's path.
      expect(existsSync(outputPath)).toBe(false);
    },
    240_000,
  );

  it(
    "fails closed with TEXTURE_PROJECT_NO_COVERAGE when no view reaches the atlas",
    async () => {
      const cwd = await scratchDir("no-coverage");
      const room = join(cwd, "room.glb");
      await writeRoomGlb(room);
      const stub = await startOpenRouterStub(pngBase64, { paint: "arch" });
      // One view only: the three-view structure stop cannot fire, so the run ends with nothing projected.
      const error = await rejection(
        paintTextureProjection({
          levelPath: room,
          cwd,
          env: { OPENROUTER_API_KEY: FAKE_KEY, OPENROUTER_BASE_URL: stub.url },
          plan: { maxViews: 1, aerial: 0, roofs: 0, holes: 0, spacing: 4 },
          atlas: 256,
          viewSize: 128,
          runId: "no-coverage-run",
          outputPath: join(cwd, "assets", "room_textured.glb"),
        }),
      );
      expectTextureProjectionError(error, "TEXTURE_PROJECT_NO_COVERAGE");
      expect((error as Error).message).toContain("no-coverage-run");
      expect(stub.requests.length).toBe(1);
      // The paid view is on disk and run.json names it, so a resume can reuse it.
      const run = JSON.parse(
        await readFile(join(cwd, ".threenative", "texture-projection", "no-coverage-run", "run.json"), "utf8"),
      ) as StoredRun;
      expect(run.views).toHaveLength(1);
      expect(existsSync(join(cwd, ".threenative", "texture-projection", "no-coverage-run", "view_0_gen.png"))).toBe(true);
    },
    240_000,
  );

  it(
    "resumes from stored generations alone: no image on disk is ever bought twice",
    async () => {
      const cwd = await scratchDir("resume-reuse");
      const stub = await startOpenRouterStub(pngBase64);
      const env = { OPENROUTER_API_KEY: FAKE_KEY, OPENROUTER_BASE_URL: stub.url };
      const first = await paintTextureProjection({
        levelPath: LEVEL,
        cwd,
        env,
        plan: { ...PLAN, maxViews: 2 },
        atlas: 256,
        viewSize: 128,
        verify: false,
        runId: "reuse-run",
        outputPath: join(cwd, "assets", "first.glb"),
      });
      expect(first.viewsPainted).toBeGreaterThan(0);
      const bought = stub.requests.length;
      expect(bought).toBe(first.viewsPainted);

      // The provider is gone: a resume that would request anything fails here, and the run is bought out.
      await stub.close();
      const resumed = await paintTextureProjection({
        resumeRunId: "reuse-run",
        cwd,
        env,
        outputPath: join(cwd, "assets", "resumed.glb"),
      });
      expect(resumed.viewsPainted).toBe(bought);
      expect(resumed.coveragePercent).toBeGreaterThan(0);
      expect(resumed.viewsRejected.structure).toBe(0);
      // Nothing was bought on the resume, so it reports no spend (the run's own cost is in run.json).
      expect(resumed.estimatedUsd).toBe(0);
      expect(stub.requests).toHaveLength(bought);
      const run = JSON.parse(
        await readFile(join(cwd, ".threenative", "texture-projection", "reuse-run", "run.json"), "utf8"),
      ) as StoredRun;
      expect(run.complete).toBe(true);
      expect(run.views.filter((view) => view.rejected !== undefined)).toHaveLength(0);
      expect(existsSync(join(cwd, "assets", "resumed.glb"))).toBe(true);
    },
    300_000,
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
        verify: false,
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
        // One request per view, so `holdAt: 2` is the second view's image.
        verify: false,
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
      // Exactly one paid request per view still missing: view 0 was kept and reused, not bought again.
      const boughtOnResume = stub.requests.length - beforeResume;
      expect(boughtOnResume).toBe(finished.views.length - 1);
      // "Views painted" counts what reached the atlas: the reused view plus the newly bought ones.
      expect(resumed.viewsPainted).toBe(finished.views.length);
      expect(resumed.estimatedUsd).toBeCloseTo(boughtOnResume * 0.009, 6);
      expect(finished.views[0]?.index).toBe(0);
      expect(boughtOnResume).toBeGreaterThan(0);
    },
    300_000,
  );
});

describe("texture-projection UV stretch (A.3)", () => {
  it("measures a uniformly mapped level at 1x and reports it uniform", async () => {
    const report = await measureUvStretch(LEVEL);
    expect(report.triangles).toBeGreaterThan(0);
    expect(report.p95).toBeGreaterThan(0.9);
    expect(report.p95).toBeLessThanOrEqual(UV_STRETCH_LIMIT);
    expect(report.uniform).toBe(true);
  });

  it("reports the material whose texels are coarsest and warns past 4x", async () => {
    const cwd = await scratchDir("uvstretch");
    const path = join(cwd, "stretched.glb");
    await writeStretchedGlb(path);
    const report = await measureUvStretch(path);
    expect(report.worstMaterial).toBe("stretched");
    expect(report.p95).toBeGreaterThan(UV_STRETCH_LIMIT);
    expect(report.uniform).toBe(false);
  });
});

describe("texture-projection structure check (B.2)", () => {
  const SIZE = 256;

  it("accepts the image the model was given", () => {
    const clay = syntheticClay(SIZE);
    expect(structureDeviation(clay, clay, SIZE, SIZE)).toBe(0);
    expect(rejectsStructure(structureDeviation(clay, clay, SIZE, SIZE))).toBe(false);
  });

  it("accepts a painted material and a global lighting change, rejects an invented dark arch", () => {
    const clay = syntheticClay(SIZE);
    // A painted material: bricks and grain over the same shading.
    const material = new Uint8ClampedArray(clay);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const p = 4 * (y * SIZE + x);
        const brick = ((x >> 3) + (y >> 2)) % 2 ? 16 : -14;
        for (let channel = 0; channel < 3; channel++) {
          material[p + channel] = brick > 0 ? material[p + channel]! * 0.9 + 30 : material[p + channel]! * 0.9 + 4;
        }
      }
    }
    const materialDeviation = structureDeviation(material, clay, SIZE, SIZE);
    expect(materialDeviation).toBeLessThan(STRUCTURE_DEVIATION_LIMIT);
    expect(rejectsStructure(materialDeviation)).toBe(false);

    // A darker style or a lighting gradient is a smooth trend, not a shape.
    const ramp = new Uint8ClampedArray(clay);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const p = 4 * (y * SIZE + x);
        const factor = 1 + 0.2 * (x / SIZE - 0.5) + 0.15 * (y / SIZE - 0.5);
        for (let channel = 0; channel < 3; channel++) ramp[p + channel] = Math.min(255, ramp[p + channel]! * factor);
      }
    }
    expect(structureDeviation(ramp, clay, SIZE, SIZE)).toBeLessThan(STRUCTURE_DEVIATION_LIMIT);

    // A big dark arch painted on the flat wall, clear of the floor line: a compact, closed, much
    // darker shape inside one clay surface.
    const arch = new Uint8ClampedArray(clay);
    const cx = SIZE * 0.5;
    const half = SIZE * 0.13;
    const top = SIZE * 0.22;
    const bottom = SIZE * 0.58;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const inside =
          x > cx - half &&
          x < cx + half &&
          y > top &&
          y < bottom &&
          (y > top + half || (x - cx) ** 2 + (y - (top + half)) ** 2 < half ** 2);
        if (!inside) continue;
        const p = 4 * (y * SIZE + x);
        arch[p] = 34;
        arch[p + 1] = 28;
        arch[p + 2] = 26;
      }
    }
    const archDeviation = structureDeviation(arch, clay, SIZE, SIZE);
    expect(archDeviation).toBeGreaterThan(0.2); // the limit is 0.2, the arch is nearly 3x over it
    expect(rejectsStructure(archDeviation)).toBe(true);
    // The grid it compares on is the documented 64 cells.
    expect(lowFrequencyLuminance(clay, SIZE, SIZE)).toHaveLength(64 * 64);
  });
});

describe("texture-projection vision check (2c)", () => {
  it("asks for the structures the clay lacks and the real-world size of the detail", () => {
    const prompt = verifyPrompt({ cameraHeightM: 1.65, centreDistanceM: 9.34, kind: "ground" });
    expect(prompt).toContain("1.6 m above the ground");
    expect(prompt).toContain("9.3 m away");
    for (const word of ["pillar", "buttress", "roof tiles", "terracotta", "arch", "doorway", "chimney"]) {
      expect(prompt).toContain(word);
    }
    expect(prompt).toContain('"added"');
    expect(prompt).toContain('"scaleOk"');
  });

  it("anchors every paint prompt to the camera's height and the depth in the middle of the frame", () => {
    const scale = { cameraHeight: 1.65, centreDistance: 9.34 };
    for (const mode of ["first", "fill", "roof"] as const) {
      const text = prompts.view({ look: "ochre plaster", roofLook: "roof tiles", parts: "", mode, floor: false, scale });
      expect(text).toContain("1.6 m above the ground");
      expect(text).toContain("9.3 m away");
      expect(text).toContain("paving stones are 15-25 cm across");
      expect(text).toContain("bricks 20-25 cm long");
    }
    // A caller with no anchor (no level geometry to measure) gets the prompt it had before.
    const unanchored = prompts.view({ look: "ochre plaster", roofLook: "roof tiles", parts: "", mode: "first", floor: false });
    expect(unanchored).not.toContain("true real-world size");
  });

  it("forbids roofs above a flat wall top, except in the roof pass that paints roofs", () => {
    const base = { look: "ochre plaster", roofLook: "roof tiles", parts: "", floor: false };
    const first = prompts.view({ ...base, mode: "first" });
    expect(first).toContain("no roof, roof tiles, tile band, coping or chimney above a wall top");
    expect(first).toContain("every wall top stays the flat edge it is in the clay");
    // The roof pass exists to paint roofs, so it must not be told that a roof is forbidden.
    const roof = prompts.view({ ...base, mode: "roof" });
    expect(roof).not.toContain("no roof, roof tiles");
    expect(roof).toContain("nothing is added on the roofs");
  });

  it("measures the anchor from the level's own geometry, not from the frame", async () => {
    const cwd = await scratchDir("scale-anchor");
    const room = join(cwd, "room.glb");
    await writeRoomGlb(room);
    const bytes = await readFile(room);
    const level = await loadLevel(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      "room",
    );
    // The room is 20 m across with 8 m walls: standing in the middle at 1.65 m, the wall ahead is 10 m away.
    const anchor = measureScaleAnchor(level, { position: [0, 1.65, 0], yaw: 0, pitch: 0, fov: 90 });
    expect(anchor.cameraHeight).toBeCloseTo(1.65, 2);
    expect(anchor.centreDistance).toBeCloseTo(10, 1);
    // Looking up over a wall top: no centre hit, so the nearest surface in the fan stands in.
    const sky = measureScaleAnchor(level, { position: [0, 1.65, 0], yaw: 0, pitch: 1.3, fov: 90 });
    expect(sky.centreDistance).toBeGreaterThan(0);
    expect(sky.centreDistance).toBeLessThan(100);
  });

  it("fails closed: only a well-formed verdict passes, everything else is unparsed", () => {
    expect(parseVerifyAnswer('{"added": [], "scaleOk": true, "reason": "materials only"}')).toMatchObject({
      added: [],
      scaleOk: true,
      verdict: "ok",
    });
    // A fenced answer with an invented pillar and roof tile coping is a rejection naming them.
    const invented = parseVerifyAnswer(
      'Here it is:\n```json\n{"added": [{"what": "a stone pillar on the back wall", "outOfSurface": true}, ' +
        '{"what": "red roof-tile coping along the wall top", "outOfSurface": true}], "scaleOk": true}\n```',
    );
    expect(invented.verdict).toBe("rejected");
    expect(invented.added).toEqual(["a stone pillar on the back wall", "red roof-tile coping along the wall top"]);
    // The model's own "this is flat paint" answer drops the item: a painted material is not added geometry.
    expect(
      parseVerifyAnswer(
        '{"added": [{"what": "cobblestone paving on the ground", "outOfSurface": false}, ' +
          '{"what": "moss on the wall base", "outOfSurface": false}], "scaleOk": true}',
      ),
    ).toMatchObject({ added: [], verdict: "ok" });
    // A chat model sometimes repeats a fragment after the object: the object is still read, strictly.
    expect(
      parseVerifyAnswer(
        '{"added": [{"what": "a ruined stone pillar", "outOfSurface": true}], "scaleOk": true}\nimage"}',
      ).added,
    ).toEqual(["a ruined stone pillar"]);
    // Impossible detail sizes are a rejection on their own.
    expect(parseVerifyAnswer('{"added": [], "scaleOk": false}')).toMatchObject({ verdict: "rejected", scaleOk: false });
    for (const bad of [
      "no json at all",
      '{"scaleOk": true}',
      '{"added": "a pillar", "scaleOk": true}',
      '{"added": [{"what": "a pillar"}], "scaleOk": true}',
      '{"added": ["a pillar"], "scaleOk": true}',
      '{"added": [], "scaleOk": "yes"}',
      "[1, 2, 3]",
      '{"added": []',
    ]) {
      expect(parseVerifyAnswer(bad).verdict).toBe("unparsed");
    }
  });

  it("forwards a chat completion with both images through the server-side key", async () => {
    const stub = await startOpenRouterStub(pngBase64);
    const forwarded = await forwardChatRequest(
      {
        model: DEFAULT_VERIFY_MODEL.id,
        prompt: verifyPrompt({ cameraHeightM: 1.65, centreDistanceM: 4 }),
        images: ["data:image/jpeg;base64,AAAA", "data:image/jpeg;base64,BBBB"],
      },
      { env: { OPENROUTER_API_KEY: FAKE_KEY, OPENROUTER_BASE_URL: stub.url } },
    );
    expect(forwarded.status).toBe(200);
    expect(stub.requests).toHaveLength(1);
    const sent = stub.requests[0]!;
    expect(sent.authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(sent.body["response_format"]).toEqual({ type: "json_object" });
    const content = (sent.body["messages"] as { content: { type: string; image_url?: { url: string } }[] }[])[0]!
      .content;
    expect(content.filter((part) => part.type === "image_url").map((part) => part.image_url?.url)).toEqual([
      "data:image/jpeg;base64,AAAA",
      "data:image/jpeg;base64,BBBB",
    ]);
    expect(content[0]?.type).toBe("text");

    // The key stays server-side: without it nothing is forwarded, and a non-image body is refused.
    const keyless = await forwardChatRequest({ model: "m", prompt: "p", images: ["data:image/png;base64,AA", "data:image/png;base64,AA"] }, { env: {} });
    expect(keyless.status).toBe(500);
    expect(new TextDecoder().decode(keyless.bytes)).toContain(MISSING_API_KEY_CODE);
    const notAnImage = await forwardChatRequest(
      { model: "m", prompt: "p", images: ["data:text/html;base64,AA", "data:image/png;base64,AA"] },
      { env: { OPENROUTER_API_KEY: FAKE_KEY, OPENROUTER_BASE_URL: stub.url } },
    );
    expect(notAnImage.status).toBe(400);
    expect(stub.requests).toHaveLength(1);
  });

  it(
    "rejects an invented pillar or roof tiles, repaints once and leaves the view for the fill pass",
    async () => {
      const cwd = await scratchDir("verify-invented");
      const stub = await startOpenRouterStub(pngBase64, { verify: "invented" });
      const error = await rejection(
        paintTextureProjection({
          levelPath: LEVEL,
          cwd,
          env: { OPENROUTER_API_KEY: FAKE_KEY, OPENROUTER_BASE_URL: stub.url },
          plan: PLAN,
          atlas: 256,
          viewSize: 128,
          runId: "verify-run",
          outputPath: join(cwd, "assets", "verify.glb"),
        }),
      );
      // Every painted view was rejected by the check, so nothing reaches the atlas.
      expectTextureProjectionError(error, "TEXTURE_PROJECT_NO_COVERAGE");
      const run = JSON.parse(
        await readFile(join(cwd, ".threenative", "texture-projection", "verify-run", "run.json"), "utf8"),
      ) as StoredRun;
      expect(run.views.length).toBeGreaterThan(0);
      for (const view of run.views) {
        expect(view.rejected).toBe("verify");
        expect(view.repainted).toBe(true);
        expect(view.verify?.model).toBe(DEFAULT_VERIFY_MODEL.id);
        expect(view.verify?.added.join(" ")).toContain("pillar");
        // The kept generation is the repaint's, and its prompt named the invention as forbidden.
        expect(view.prompt).toContain("do not paint:");
        expect(view.prompt).toContain("pillar");
        expect(view.prompt).toContain("This is a repaint");
      }
      // Two images and two checks per view: the one repaint a rejected view is allowed.
      expect(stub.requests.filter((sent) => Array.isArray(sent.body["input_references"]))).toHaveLength(run.views.length * 2);
    },
    300_000,
  );

  it(
    "accepts a view whose repaint passes the check and counts the repaint",
    async () => {
      const cwd = await scratchDir("verify-once");
      const stub = await startOpenRouterStub(pngBase64, { verify: "once" });
      const result = await paintTextureProjection({
        levelPath: LEVEL,
        cwd,
        env: { OPENROUTER_API_KEY: FAKE_KEY, OPENROUTER_BASE_URL: stub.url },
        plan: PLAN,
        atlas: 256,
        viewSize: 128,
        runId: "verify-once-run",
        outputPath: join(cwd, "assets", "verify-once.glb"),
      });
      expect(result.verifyModel).toBe(DEFAULT_VERIFY_MODEL.id);
      expect(result.viewsRejected.verify).toBe(0);
      expect(result.viewsRepainted).toBe(result.viewsPainted);
      expect(result.coveragePercent).toBeGreaterThan(0);
      expect(result.estimatedUsd).toBeGreaterThan(result.viewsPainted * 0.009 * 2 * 0.99);
      const run = JSON.parse(
        await readFile(join(cwd, ".threenative", "texture-projection", "verify-once-run", "run.json"), "utf8"),
      ) as StoredRun;
      expect(run.views.filter((view) => view.rejected !== undefined)).toHaveLength(0);
      expect(run.views.every((view) => view.verify?.verdict === "ok")).toBe(true);
    },
    300_000,
  );

  it(
    "counts an unreadable answer as its own rejection and buys only the one repaint",
    async () => {
      const cwd = await scratchDir("verify-garbage");
      const stub = await startOpenRouterStub(pngBase64, { verify: "garbage" });
      const error = await rejection(
        paintTextureProjection({
          levelPath: LEVEL,
          cwd,
          env: { OPENROUTER_API_KEY: FAKE_KEY, OPENROUTER_BASE_URL: stub.url },
          plan: { ...PLAN, maxViews: 1 },
          atlas: 256,
          viewSize: 128,
          runId: "verify-garbage-run",
          outputPath: join(cwd, "assets", "verify-garbage.glb"),
        }),
      );
      expectTextureProjectionError(error, "TEXTURE_PROJECT_NO_COVERAGE");
      const run = JSON.parse(
        await readFile(join(cwd, ".threenative", "texture-projection", "verify-garbage-run", "run.json"), "utf8"),
      ) as StoredRun;
      expect(run.views).toHaveLength(1);
      expect(run.views[0]?.rejected).toBe("verify");
      expect(run.views[0]?.verify?.verdict).toBe("unparsed");
      // Fail closed: the unreadable answer never lets an image into the atlas.
      expect(stub.requests.filter((sent) => Array.isArray(sent.body["input_references"]))).toHaveLength(2);
    },
    300_000,
  );
});

describe("texture-projection atlas choice (C.1)", () => {
  it("picks the power of two that matches the measured footprint, without wasting texels", () => {
    // One texel per image pixel already: keep the measurement atlas.
    expect(autoAtlasSize(1024, 1)).toBe(1024);
    // Four texels per pixel (the views resolve half the linear size): a 512 atlas matches.
    expect(autoAtlasSize(1024, 4)).toBe(512);
    // A pixel covers a quarter texel: the views resolve twice the linear size, so 2048 matches.
    expect(autoAtlasSize(1024, 0.25)).toBe(2048);
    expect(autoAtlasSize(1024, 0.0625)).toBe(4096);
    // Never above 8K, never below 512.
    expect(autoAtlasSize(1024, 1e-9)).toBe(4096);
    expect(autoAtlasSize(1024, 1e9)).toBe(512);
    // A 4.2K match must not become an 8K atlas: the nearest power of two, not the next one up.
    expect(autoAtlasSize(1024, 0.0573)).toBe(4096);
  });
});

describe("texture-projection atlas marker (C.3)", () => {
  it("writes extras.threenative.textureProjection on the base-colour image and texture", async () => {
    const cwd = await scratchDir("marker");
    const path = join(cwd, "painted.glb");
    const png = await sharp({ create: { width: 4, height: 4, channels: 4, background: { r: 9, g: 8, b: 7, alpha: 1 } } })
      .png()
      .toBuffer();
    const document = new Document();
    const buffer = document.createBuffer();
    const texture = document.createTexture("atlas").setImage(new Uint8Array(png)).setMimeType("image/png");
    const material = document.createMaterial("painted").setBaseColorTexture(texture);
    const position = document
      .createAccessor()
      .setType("VEC3")
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
      .setBuffer(buffer);
    const uv = document
      .createAccessor()
      .setType("VEC2")
      .setArray(new Float32Array([0, 0, 1, 0, 0, 1]))
      .setBuffer(buffer);
    document
      .createMesh("level")
      .addPrimitive(document.createPrimitive().setAttribute("POSITION", position).setAttribute("TEXCOORD_0", uv).setMaterial(material));
    document.createScene().addChild(document.createNode("level").setMesh(document.getRoot().listMeshes()[0]!));
    await new NodeIO().write(path, document);

    expect(readProjectedAtlasMarker(new Uint8Array(await readFile(path)))).toBeUndefined();
    const marked = markProjectedAtlas(new Uint8Array(await readFile(path)), { atlas: 4096, runId: "courtyard-abc" });
    expect(readProjectedAtlasMarker(marked)).toEqual({ atlas: 4096, runId: "courtyard-abc" });
    // The bytes are still a readable GLB with its texture intact.
    const reread = await new NodeIO().readBinary(marked);
    expect(reread.getRoot().listTextures()).toHaveLength(1);
  });
});

/** A flat gray wall over a floor with soft shading: what the clay render looks like to the check. */
function syntheticClay(size: number): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const p = 4 * (y * size + x);
      const floor = y > size * 0.62;
      const value = (floor ? 148 : 186) + (floor ? (y / size - 0.62) * -40 : (x / size - 0.5) * 18 - (y / size) * 24);
      pixels[p] = value;
      pixels[p + 1] = value;
      pixels[p + 2] = value;
      pixels[p + 3] = 255;
    }
  }
  return pixels;
}

/** Two quads: the "flat" one maps its 1x1 m to 0.5x0.5 UV, the "stretched" one to 0.05x0.05. */
async function writeStretchedGlb(path: string): Promise<void> {
  const document = new Document();
  const buffer = document.createBuffer();
  const quad = (name: string, uvScale: number, offset: number) => {
    const position = document
      .createAccessor()
      .setType("VEC3")
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]))
      .setBuffer(buffer);
    const uv = document
      .createAccessor()
      .setType("VEC2")
      .setArray(
        new Float32Array([
          offset,
          0,
          offset + uvScale,
          0,
          offset + uvScale,
          uvScale,
          offset,
          uvScale,
        ]),
      )
      .setBuffer(buffer);
    const indices = document.createAccessor().setType("SCALAR").setArray(new Uint16Array([0, 1, 2, 0, 2, 3])).setBuffer(buffer);
    const primitive = document
      .createPrimitive()
      .setAttribute("POSITION", position)
      .setAttribute("TEXCOORD_0", uv)
      .setIndices(indices)
      .setMaterial(document.createMaterial(name));
    return document.createMesh(name).addPrimitive(primitive);
  };
  const flat = quad("flat", 0.5, 0);
  const stretched = quad("stretched", 0.05, 0.5);
  const scene = document.createScene("Scene");
  scene.addChild(document.createNode("flat").setMesh(flat));
  scene.addChild(document.createNode("stretched").setMesh(stretched));
  await new NodeIO().write(path, document);
}

describe("texture-projection atlas infill (C.2)", () => {
  it("fills never-painted texels with the atlas mean colour and keeps at least an 8 px gutter", () => {
    // Two painted texels, two unpainted ones that would otherwise export as clay gray or black.
    const data = new Uint8ClampedArray([
      100, 50, 10, 255,
      200, 150, 110, 255,
      0, 0, 0, 0,
      0, 0, 0, 0,
    ]);
    infillUnpainted(data);
    expect(Array.from(data.subarray(8))).toEqual([150, 100, 60, 255, 150, 100, 60, 255]);
    expect(ATLAS_GUTTER_TEXELS).toBeGreaterThanOrEqual(8);
  });
});

describe("texture-projection cook config hint (C.3)", () => {
  it("documents the override for the atlas the bake actually holds, never above the 4096 cook ceiling", () => {
    const hint = cookConfigHint(MAX_AUTO_ATLAS);
    expect(hint).toContain(`maxSize: { baseColorTexture: ${MAX_AUTO_ATLAS} }`);
    expect(hint).toContain('codec: "uastc"');
    // The engine cook of the release that ships PRD-916 honours the marker; the hint says so.
    expect(hint).toContain("extras.threenative.textureProjection");
    expect(hint).toContain("PRD-916");
    // Nothing the auto atlas can choose asks for a bigger base colour than the cook's KTX2 ceiling.
    expect(MAX_AUTO_ATLAS).toBe(4096);
    expect(autoAtlasSize(1024, 1e-9)).toBeLessThanOrEqual(MAX_AUTO_ATLAS);
    expect(cookConfigHint(autoAtlasSize(1024, 1e-9))).toContain("baseColorTexture: 4096");
  });
});

describe("texture-projection cook config audit (C.3)", () => {
  it("flags a missing config as the 2048 ETC1S-eligible default", () => {
    const audit = auditCookConfig(undefined, 4096, null);
    expect(audit).toMatchObject({ path: null, baseColorMaxSize: 2048, flagged: true });
    expect(audit.findings.join(" ")).toMatch(/maxSize 2048/u);
  });

  it("reads maxSize and the base-colour codec out of TypeScript, comments and all", () => {
    const good = auditCookConfig(
      [
        "export default {",
        "  // the painted courtyard atlas is 4096",
        "  assets: {",
        "    models: {",
        "      textures: {",
        "        maxSize: { baseColorTexture: 4096, normalTexture: 1024 },",
        '        overrides: [{ slot: "normalTexture", codec: "uastc" }, { slot: "baseColorTexture", codec: "uastc" }],',
        "      },",
        "    },",
        "  },",
        "} as const;",
      ].join("\n"),
      4096,
      "threenative.config.ts",
    );
    expect(good).toMatchObject({ baseColorMaxSize: 4096, baseColorCodec: "uastc", flagged: false });
    expect(good.findings).toEqual([]);

    const downscaled = auditCookConfig(
      "export default { assets: { models: { textures: { maxSize: { baseColorTexture: 1024 }, overrides: [{ slot: \"baseColorTexture\", codec: \"etc1s\" }] } } } };",
      8192,
      "threenative.config.ts",
    );
    expect(downscaled.flagged).toBe(true);
    expect(downscaled.findings.join(" ")).toMatch(/1024 < the 8192 atlas/u);
    expect(downscaled.findings.join(" ")).toMatch(/ETC1S/u);
  });
});
