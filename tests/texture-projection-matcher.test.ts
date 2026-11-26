import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { PolyHavenClient } from "../src/polyhaven/client.js";
import { loadTextureProjectionMode } from "../src/config.js";
import {
  extractTextureFeatures,
  isEligibleForTilingPbr,
  matchPolyHavenMaterials,
  matchPolyHavenModels,
  routePropModel,
  routeSurfaceMaterial,
  scorePolyHavenCandidate,
  scorePolyHavenModelCandidate,
} from "../src/texture-projection/polyhaven-matcher.js";
import { createTextureProjectMatchMaterialsHandler } from "../src/tools/texture-projection.js";

const tempDirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((done) => s.close(() => done()))));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeCobblePng(brightnessScale = 1, seedColor: [number, number, number] = [140, 128, 114]): Promise<Buffer> {
  const size = 64;
  const raw = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const mortar = x % 16 === 0 || y % 12 === 0;
      const jitter = ((x * 37 + y * 17) % 19) - 9;
      const base = mortar ? [45, 42, 38] : seedColor;
      const idx = (y * size + x) * 3;
      raw[idx] = Math.max(0, Math.min(255, Math.round((base[0]! + jitter) * brightnessScale)));
      raw[idx + 1] = Math.max(0, Math.min(255, Math.round((base[1]! + jitter) * brightnessScale)));
      raw[idx + 2] = Math.max(0, Math.min(255, Math.round((base[2]! + jitter) * brightnessScale)));
    }
  }
  return sharp(raw, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
}

async function makeFlatStuccoPng(): Promise<Buffer> {
  const size = 64;
  const raw = Buffer.alloc(size * size * 3);
  for (let i = 0; i < size * size; i++) {
    raw[3 * i] = 40;
    raw[3 * i + 1] = 155;
    raw[3 * i + 2] = 175;
  }
  return sharp(raw, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
}

describe("Poly Haven surface material matcher", () => {
  it("keeps repeating structural surfaces eligible and reserves hero shopfronts/murals for AI projection", () => {
    expect(isEligibleForTilingPbr({ name: "road", description: "dark cobblestone street paving" })).toBe(true);
    expect(isEligibleForTilingPbr({ name: "brick_upper", description: "red terracotta brick wall" })).toBe(true);
    expect(isEligibleForTilingPbr({ name: "shopfront_left", description: "painted corner shopfront with awning" })).toBe(
      false,
    );
    expect(isEligibleForTilingPbr({ name: "wall_mural", description: "custom street mural" })).toBe(false);
    expect(isEligibleForTilingPbr({ name: "cobble", description: "cobblestone", homogeneous: false })).toBe(false);
  });

  it("routes candidates across use_polyhaven_pbr, polyhaven_detail_plus_project, and ai_project_only", () => {
    expect(routeSurfaceMaterial(0.84, true)).toBe("use_polyhaven_pbr");
    expect(routeSurfaceMaterial(0.62, true)).toBe("polyhaven_detail_plus_project");
    expect(routeSurfaceMaterial(0.35, true)).toBe("ai_project_only");
    expect(routeSurfaceMaterial(0.95, false)).toBe("ai_project_only");
  });

  it("scores matching darkened cobblestone higher than mismatched turquoise stucco", async () => {
    const refDarkCobble = await makeCobblePng(0.65);
    const polyCobble = await makeCobblePng(1.0);
    const polyTurquoise = await makeFlatStuccoPng();

    const targetF = await extractTextureFeatures(refDarkCobble);
    const cobbleF = await extractTextureFeatures(polyCobble);
    const stuccoF = await extractTextureFeatures(polyTurquoise);

    const good = scorePolyHavenCandidate(
      "cobblestone road paving",
      targetF,
      { id: "cobblestone_floor_01", name: "Cobblestone Floor 01", category: "Floor", tags: ["cobble", "street", "stone"] },
      cobbleF,
    );
    const bad = scorePolyHavenCandidate(
      "cobblestone road paving",
      targetF,
      { id: "teal_plaster", name: "Teal Plaster", category: "Wall", tags: ["plaster", "turquoise"] },
      stuccoF,
    );

    expect(good.score).toBeGreaterThan(0.75);
    expect(bad.score).toBeLessThan(0.5);
    expect(good.labColorShift.dL).toBeLessThan(0);
  });

  it("matches catalog textures end-to-end against thumbnails via HTTP stub", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ph-matcher-"));
    tempDirs.push(dir);
    const refImg = join(dir, "ref.png");
    await writeFile(refImg, await makeCobblePng(0.75));
    const cobbleThumb = await makeCobblePng(1.0);
    const flatThumb = await makeFlatStuccoPng();

    let serverPort = 0;
    const server = createServer((req, res) => {
      if (req.url?.startsWith("/thumb/cobble.png")) {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(cobbleThumb);
        return;
      }
      if (req.url?.startsWith("/thumb/plaster.png")) {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(flatThumb);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    serverPort = (server.address() as AddressInfo).port;

    const assetsJson = {
      cobblestone_street_01: {
        name: "Cobblestone Street 01",
        description: "Irregular stone cobblestone street",
        type: 1,
        category: "Floor",
        tags: ["cobblestone", "street", "paving"],
        authors: { Test: "All" },
        download_count: 5000,
        thumbnail_url: `http://127.0.0.1:${serverPort}/thumb/cobble.png`,
      },
      teal_plaster_01: {
        name: "Teal Plaster 01",
        description: "Smooth teal street plaster",
        type: 1,
        category: "Wall",
        tags: ["plaster", "street"],
        authors: { Test: "All" },
        download_count: 1000,
        thumbnail_url: `http://127.0.0.1:${serverPort}/thumb/plaster.png`,
      },
    };
    const fakeFetch: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("https://api.polyhaven.com/assets")) {
        return new Response(JSON.stringify(assetsJson), { status: 200, headers: { "content-type": "application/json" } });
      }
      return fetch(input);
    };

    const client = new PolyHavenClient(fakeFetch);
    const out = await matchPolyHavenMaterials(
      {
        referenceImagePath: refImg,
        surfaces: [
          { name: "road", query: "cobblestone street paving" },
          { name: "shopfront", query: "custom shopfront display" },
        ],
      },
      { client, fetchImpl: fakeFetch },
    );

    expect(out).toHaveLength(2);
    expect(out[0]?.eligible).toBe(true);
    expect(out[0]?.decision).toBe("use_polyhaven_pbr");
    expect(out[0]?.bestMatch?.id).toBe("cobblestone_street_01");
    expect(out[0]?.referenceHex).toMatch(/^#[0-9a-f]{6}$/u);
    expect(out[1]?.eligible).toBe(false);
    expect(out[1]?.decision).toBe("ai_project_only");
    expect(out[1]?.referenceHex).toMatch(/^#[0-9a-f]{6}$/u);
  });

  it("resolves server texture mode from CLI --mode and THREENATIVE_TEXTURE_MODE", () => {
    expect(loadTextureProjectionMode({}, [])).toBe("detailed");
    expect(loadTextureProjectionMode({ THREENATIVE_TEXTURE_MODE: "lean" }, [])).toBe("lean");
    expect(loadTextureProjectionMode({ THREENATIVE_TEXTURE_MODE: "lean" }, ["--mode", "detailed"])).toBe("detailed");
    expect(loadTextureProjectionMode({}, ["--mode=lean"])).toBe("lean");
    expect(() => loadTextureProjectionMode({ THREENATIVE_TEXTURE_MODE: "bogus" }, [])).toThrow(/Invalid texture projection mode/);
    expect(() => loadTextureProjectionMode({}, ["--mode"])).toThrow(/Missing value for "--mode"/);
    expect(() => loadTextureProjectionMode({}, ["--mode=other"])).toThrow(/Invalid texture projection mode/);
  });

  it("routes surfaces and props in lean mode and extracts referenceHex for procedural fallbacks", async () => {
    expect(routeSurfaceMaterial(0.62, true, "lean")).toBe("use_polyhaven_pbr");
    expect(routeSurfaceMaterial(0.35, true, "lean")).toBe("procedural_tint_fallback");
    expect(routeSurfaceMaterial(0.95, false, "lean")).toBe("procedural_tint_fallback");
    expect(routePropModel(0.6, "detailed")).toBe("use_polyhaven_model");
    expect(routePropModel(0.3, "detailed")).toBe("ai_project_only");
    expect(routePropModel(0.5, "lean")).toBe("use_polyhaven_model");
    expect(routePropModel(0.3, "lean")).toBe("procedural_tint_fallback");

    const yellowChairPng = await makeCobblePng(1.0, [215, 180, 32]);
    const feat = await extractTextureFeatures(yellowChairPng);
    expect(feat.referenceHex).toMatch(/^#[0-9a-f]{6}$/u);
    const modelScore = scorePolyHavenModelCandidate(
      "yellow cafe plastic chair",
      feat,
      {
        id: "plastic_chair_01",
        name: "Plastic Cafe Chair",
        category: "Furniture",
        tags: ["chair", "cafe", "plastic"],
        dimensions: [0.52, 0.82, 0.54],
        polycount: 2400,
      },
      feat,
      { dimensionsMeters: [0.5, 0.8, 0.5], maxPolycount: 5000 },
    );
    expect(modelScore.score).toBeGreaterThan(0.75);
    expect(modelScore.polycount).toBe(2400);
  });

  it("supports lean mode, multi-reference images, and 3D model matching through the handler", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ph-lean-"));
    tempDirs.push(dir);
    const roadRef = join(dir, "ref-road.png");
    const chairRef = join(dir, "ref-chair.png");
    await writeFile(roadRef, await makeCobblePng(0.9));
    await writeFile(chairRef, await makeCobblePng(1.0, [220, 185, 25]));
    const cobbleThumb = await makeCobblePng(1.0);
    const chairThumb = await makeCobblePng(1.0, [220, 185, 25]);

    const server = createServer((req, res) => {
      if (req.url === "/thumb/cobble.png") {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(cobbleThumb);
        return;
      }
      if (req.url === "/thumb/chair.png") {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(chairThumb);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const port = (server.address() as AddressInfo).port;

    const fakeFetch: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("https://api.polyhaven.com/assets?type=textures")) {
        return new Response(
          JSON.stringify({
            cobble_paver_01: {
              name: "Cobble Paver 01",
              description: "Street cobblestone paving",
              type: 1,
              category: "Floor",
              tags: ["cobblestone", "street", "paving"],
              authors: { Test: "All" },
              download_count: 5000,
              thumbnail_url: `http://127.0.0.1:${port}/thumb/cobble.png`,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.startsWith("https://api.polyhaven.com/assets?type=models")) {
        return new Response(
          JSON.stringify({
            yellow_cafe_chair: {
              name: "Yellow Cafe Chair",
              description: "Stackable sidewalk dining chair",
              type: 2,
              category: "Furniture",
              tags: ["chair", "dining", "cafe"],
              authors: { Test: "All" },
              download_count: 2500,
              dimensions: [0.5, 0.82, 0.52],
              polycount: 3200,
              thumbnail_url: `http://127.0.0.1:${port}/thumb/chair.png`,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return fetch(input);
    };

    const client = new PolyHavenClient(fakeFetch);
    const modelMatches = await matchPolyHavenModels(
      {
        mode: "lean",
        referenceImagePaths: [roadRef, chairRef],
        models: [
          { name: "cafe_chair", query: "yellow sidewalk chair", referenceImagePath: chairRef },
          { name: "neon_sign", query: "custom neon dragon sculpture" },
        ],
      },
      { client, fetchImpl: fakeFetch },
    );
    expect(modelMatches[0]?.decision).toBe("use_polyhaven_model");
    expect(modelMatches[0]?.bestMatch?.id).toBe("yellow_cafe_chair");
    expect(modelMatches[1]?.decision).toBe("procedural_tint_fallback");
    expect(modelMatches[1]?.referenceHex).toMatch(/^#[0-9a-f]{6}$/u);

    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      const handler = createTextureProjectMatchMaterialsHandler(client, "lean");
      const leanResponse = await handler({
        referenceImagePaths: ["ref-road.png", "ref-chair.png"],
        surfaces: [
          { name: "road", query: "cobblestone street paving" },
          { name: "shopfront", query: "custom corner shopfront mural" },
        ],
        models: [{ name: "cafe_chair", query: "yellow cafe chair", referenceImagePath: "ref-chair.png" }],
      });
      expect((leanResponse as { isError?: boolean }).isError).toBeUndefined();
      const body = (leanResponse as { structuredContent: Record<string, unknown> }).structuredContent;
      expect(body["mode"]).toBe("lean");
      expect(body["requiresOpenRouterKey"]).toBe(false);
      const surfaceResults = body["results"] as { decision: string; bestMatch: { id: string } | null }[];
      expect(surfaceResults[0]?.decision).toBe("use_polyhaven_pbr");
      expect(surfaceResults[1]?.decision).toBe("procedural_tint_fallback");
      const modelResults = body["modelResults"] as { decision: string; bestMatch: { id: string } | null }[];
      expect(modelResults[0]?.decision).toBe("use_polyhaven_model");
      expect(modelResults[0]?.bestMatch?.id).toBe("yellow_cafe_chair");

      const restricted = await handler({
        mode: "detailed",
        referenceImagePath: "ref-road.png",
        surfaces: [{ name: "road", query: "cobblestone street paving" }],
      });
      expect((restricted as { isError?: boolean }).isError).toBe(true);
      expect((restricted as { content: { text: string }[] }).content[0]?.text).toContain(
        "TEXTURE_PROJECT_MODE_RESTRICTED",
      );
    } finally {
      process.chdir(prevCwd);
    }
  });
});
