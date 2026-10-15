import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { renderTiles } from "../src/unreal/contact-sheet.js";
import { compareImages, decodeRgba, type RgbaImage } from "../src/unreal/image-diff.js";
import { judgeRender } from "../src/unreal/visual-judge.js";
import { type UnityMaterialFixture, pngFromRgba, resolveFixture, writePlainCube, writeUnityMaterialGlb } from "./helpers/unity-fidelity.js";
import { SHADERS, solidPng } from "./helpers/unity-models.js";
import { describeWithTools } from "./helpers/require-tool.js";

// Locks the Unity material rules of src/unity/materials.ts the way tests/unreal-visual-regression.test.ts locks the
// Unreal importer. Every fixture is synthetic: a `.mat` in Unity's text layout goes through the production path
// (readMaterial, resolveMaterial, renderRecipe, applyResolvedMaterial) into a tiny GLB, which the production tile
// renderer draws with its fixed camera. Each rule has numeric invariants on the judge's statistics (tight, host
// independent) and a committed golden (SSIM, loose, catches anything else). Reverting any one rule must turn this red.
// Regenerate goldens with `npm run goldens:update` (never from a licensed pack).

const TILE = 120;
const GOLDEN_DIR = fileURLToPath(new URL("./fixtures/visual-golden/", import.meta.url));
const GOLDEN_SSIM_MIN = 0.9;

/** Horizontal alpha ramp 0..255 over a flat leaf green: the cutoff decides how much of the card survives. */
async function alphaRamp(): Promise<Buffer> {
  const size = 64;
  const data = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) data.set([60, 160, 70, Math.round((x / (size - 1)) * 255)], (y * size + x) * 4);
  return sharp(data, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
}

/** An HDRP mask map: the left half is rough metal (R 255, A 25), the right half glossy non-metal (R 0, A 235). G is full occlusion. */
async function maskSplit(): Promise<Buffer> {
  const size = 64;
  const data = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) data.set(x < size / 2 ? [255, 255, 0, 25] : [0, 255, 0, 235], (y * size + x) * 4);
  return sharp(data, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
}

const TEXTURES = "Assets/Textures";
const picked = { red: [0.85, 0.25, 0.2, 1] } as const;

interface Fixture {
  readonly name: string;
  readonly build: () => Promise<UnityMaterialFixture> | UnityMaterialFixture;
}

const fixtures: Fixture[] = [
  // Smoothness inversion: glTF roughness is 1 - smoothness. A rough metal shows its colour, a smooth one only mirrors the dark.
  { name: "unity-rough-metal", build: () => ({ geometry: "cube", spec: { name: "RoughMetal", shader: SHADERS.standard, floats: { _Metallic: 1, _Glossiness: 0.08 }, colors: { _Color: picked.red } } }) },
  { name: "unity-smooth-metal", build: () => ({ geometry: "cube", spec: { name: "SmoothMetal", shader: SHADERS.standard, floats: { _Metallic: 1, _Glossiness: 0.95 }, colors: { _Color: picked.red } } }) },
  // The same inversion when smoothness comes from the albedo alpha (`_SmoothnessTextureChannel` 1): alpha 0 is rough.
  {
    name: "unity-albedo-alpha-smoothness",
    build: async () => ({
      geometry: "cube",
      spec: {
        name: "AlphaSmooth",
        shader: SHADERS.standard,
        floats: { _Metallic: 1, _Glossiness: 0.95, _GlossMapScale: 1, _SmoothnessTextureChannel: 1 },
        colors: { _Color: [1, 1, 1, 1] },
        textures: { _MainTex: `${TEXTURES}/albedo-alpha0.png` },
      },
      textures: { [`${TEXTURES}/albedo-alpha0.png`]: { png: await solidPng(8, 8, [217, 64, 51, 0]) } },
    }),
  },
  // HDRP mask map: R metallic, G occlusion, A smoothness. Left half rough metal, right half smooth dielectric.
  {
    name: "unity-hdrp-mask-split",
    build: async () => ({
      geometry: "cube",
      spec: {
        name: "HdrpMask",
        shader: SHADERS.hdrpLit,
        floats: { _Metallic: 0, _Smoothness: 0.5 },
        colors: { _BaseColor: picked.red },
        textures: { _MaskMap: `${TEXTURES}/mask.png` },
      },
      textures: { [`${TEXTURES}/mask.png`]: { png: await maskSplit(), settings: { srgb: false } } },
    }),
  },
  // Cut-out: Standard `_Mode` 1, URP `_AlphaClip`, HDRP `_AlphaCutoffEnable`, each with a 0.75 cutoff on an alpha ramp: a quarter survives.
  ...(["standard", "urp", "hdrp"] as const).map((pipeline): Fixture => ({
    name: `unity-cutout-${pipeline}`,
    build: async () => {
      const texture = `${TEXTURES}/ramp.png`;
      const spec =
        pipeline === "standard"
          ? { name: "CutStd", shader: SHADERS.standard, floats: { _Mode: 1, _Cutoff: 0.75 }, textures: { _MainTex: texture } }
          : pipeline === "urp"
            ? { name: "CutUrp", shader: SHADERS.urpLit, floats: { _AlphaClip: 1, _Cutoff: 0.75 }, textures: { _BaseMap: texture } }
            : { name: "CutHdrp", shader: SHADERS.hdrpLit, floats: { _AlphaCutoffEnable: 1, _AlphaCutoff: 0.75 }, textures: { _BaseColorMap: texture } };
      return { geometry: "quad", spec: { ...spec, colors: { [pipeline === "standard" ? "_Color" : "_BaseColor"]: [1, 1, 1, 1] } }, textures: { [texture]: { png: await alphaRamp() } } };
    },
  })),
  // The control for the cut-outs: the same card, opaque.
  {
    name: "unity-opaque-card",
    build: async () => ({
      geometry: "quad",
      spec: { name: "Opaque", shader: SHADERS.standard, floats: { _Mode: 0, _Cutoff: 0.75 }, colors: { _Color: [1, 1, 1, 1] }, textures: { _MainTex: `${TEXTURES}/ramp.png` } },
      textures: { [`${TEXTURES}/ramp.png`]: { png: await alphaRamp() } },
    }),
  },
  // A picked colour is gamma, the project is linear: a mid-grey tint must render darker than a linear 0.5.
  { name: "unity-tint-gamma", build: () => ({ geometry: "cube", spec: { name: "Tint", shader: SHADERS.standard, colors: { _Color: [0.5, 0.5, 0.5, 1] } } }) },
];

const built = new Map<string, UnityMaterialFixture>();
const resolveFixtureFor = (name: string) => resolveFixture(built.get(name)!);

describeWithTools(["chromium"], "unity visual regression goldens", () => {
  let dir: string;
  const byName = new Map<string, RgbaImage>();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "tn-unity-visual-"));
    const names: string[] = [];
    const paths: string[] = [];
    for (const fixture of fixtures) {
      const path = join(dir, `${fixture.name}.glb`);
      const material = await fixture.build();
      built.set(fixture.name, material);
      await writeUnityMaterialGlb(path, material);
      names.push(fixture.name);
      paths.push(path);
    }
    // A plain linear 0.5 grey cube: what an unconverted tint would look like.
    const plain = join(dir, "plain-half-grey.glb");
    await writePlainCube(plain, "PlainHalfGrey", [0.5, 0.5, 0.5]);
    names.push("plain-half-grey");
    paths.push(plain);
    const result = await renderTiles({ glbPaths: paths, tile: TILE });
    expect(result.rendered.every(Boolean)).toBe(true);
    names.forEach((name, index) => byName.set(name, result.tiles[index]!));
  }, 120_000);

  afterAll(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  });

  const stats = (name: string) => judgeRender(byName.get(name)!).stats;

  it("smoothness inverts to roughness: a rough metal shows its colour, a smooth one only mirrors the dark room", () => {
    const rough = stats("unity-rough-metal");
    const smooth = stats("unity-smooth-metal");
    expect(rough.objectPixels).toBeGreaterThan(2000);
    expect(rough.meanLuma).toBeGreaterThan(30);
    expect(rough.meanSaturation).toBeGreaterThan(0.5);
    expect(smooth.meanLuma).toBeLessThan(10);
    expect(rough.meanLuma).toBeGreaterThan(smooth.meanLuma * 5);
  });

  it("smoothness read from the albedo alpha inverts too: alpha 0 is rough", () => {
    const fromAlpha = stats("unity-albedo-alpha-smoothness");
    expect(fromAlpha.meanLuma).toBeGreaterThan(30);
    expect(fromAlpha.meanLuma).toBeGreaterThan(stats("unity-smooth-metal").meanLuma * 5);
    expect(fromAlpha.meanSaturation).toBeGreaterThan(0.5);
  });

  it("the HDRP mask map splits: red is metallic and alpha is smoothness, so the two halves differ", () => {
    const split = stats("unity-hdrp-mask-split");
    // Left half rough metal (dark red), right half glossy dielectric (lit red): a wide spread, and brighter overall than the metal alone.
    expect(split.lumaStdDev).toBeGreaterThan(18);
    expect(split.meanLuma).toBeGreaterThan(stats("unity-rough-metal").meanLuma + 15);
    expect(split.meanSaturation).toBeGreaterThan(0.5);
    expect(resolveFixtureFor("unity-hdrp-mask-split").metallicRoughness?.recipe).toMatchObject({
      kind: "metallicRoughness",
      metallic: { channel: "r" },
      smoothness: { channel: "a" },
    });
    expect(resolveFixtureFor("unity-hdrp-mask-split").occlusion?.recipe).toMatchObject({ kind: "occlusion", read: { channel: "g" } });
  });

  it.each(["standard", "urp", "hdrp"] as const)("cut-out on %s keeps only the part of the card above the cutoff", (pipeline) => {
    const cut = stats(`unity-cutout-${pipeline}`);
    const opaque = stats("unity-opaque-card");
    // The alpha ramp with a 0.75 cutoff leaves a quarter of the card, and the quad stays a ragged, sparse silhouette.
    expect(cut.objectPixels).toBeGreaterThan(opaque.objectPixels * 0.2);
    expect(cut.objectPixels).toBeLessThan(opaque.objectPixels * 0.45);
    expect(cut.fillRatio).toBeLessThan(0.4);
    expect(opaque.fillRatio).toBeGreaterThan(0.6);
    expect(cut.meanSaturation).toBeGreaterThan(0.4);
  });

  it("a picked colour is gamma: a mid-grey tint renders darker than a linear 0.5 grey", () => {
    expect(stats("unity-tint-gamma").meanLuma).toBeLessThan(stats("plain-half-grey").meanLuma * 0.8);
    expect(stats("unity-tint-gamma").meanLuma).toBeGreaterThan(40);
  });

  it("matches every committed golden image", async () => {
    const updating = process.env.UPDATE_GOLDENS !== undefined;
    if (updating) await mkdir(GOLDEN_DIR, { recursive: true });
    for (const [name, actual] of byName) {
      if (name.startsWith("plain-")) continue;
      const goldenPath = join(GOLDEN_DIR, `${name}.png`);
      if (updating) {
        await writeFile(goldenPath, await pngFromRgba(actual));
        continue;
      }
      const comparison = await compareImages(actual, await decodeRgba(await readFile(goldenPath)));
      expect(comparison.ssim, `${name}: SSIM ${comparison.ssim.toFixed(3)} vs golden`).toBeGreaterThanOrEqual(GOLDEN_SSIM_MIN);
    }
  }, 60_000);
});
