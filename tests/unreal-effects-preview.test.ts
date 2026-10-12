import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Document, NodeIO } from "@gltf-transform/core";
import { KHRMaterialsUnlit } from "@gltf-transform/extensions";
import sharp from "sharp";
import { describe, expect, it, onTestFinished } from "vitest";

import { PICTURE_CAMERA, PICTURE_CONTRACT_REVISION } from "../src/unreal/contact-sheet.js";
import {
  EFFECT_PREVIEW_PARTICLE_CAP,
  EFFECT_PREVIEW_SAMPLE_TIMES,
  sampleEffectChannel,
  writeBlankEffectPreviewGlb,
  writeEffectPreviewGlbs,
} from "../src/unreal/effects-preview.js";
import { validateEffectDescriptor } from "../src/unreal/effects-schema.js";

// Pure-Node tests for the PRD-584 AC-7 sprite preview generator. No Chromium, no pack bytes: the
// GLBs are generated from synthetic descriptors and parsed back with the installed glTF helpers.

const UNLIT = "KHR_materials_unlit";

function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix)).then((root) => {
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    return root;
  });
}

/** A valid sprite emitter carrying the requested channels. */
function emitter(overrides: Record<string, unknown> = {}) {
  return {
    name: "Emitter",
    renderer: "sprite",
    material: null,
    localSpace: false,
    spawn: { rate: null, bursts: [] },
    limitations: [],
    ...overrides,
  };
}

function descriptor(emitters: unknown[]) {
  return validateEffectDescriptor({ system: "P_test", source: "cascade", emitters });
}

async function readDoc(path: string): Promise<Document> {
  return new NodeIO().registerExtensions([KHRMaterialsUnlit]).read(path);
}

/** Particle nodes (everything but the invisible anchor), in file order. */
function particleNodes(document: Document) {
  return document.getRoot().listNodes().filter((node) => node.getName() !== "anchor");
}

function anchorPosition(document: Document): number[] {
  const anchor = document.getRoot().listNodes().find((node) => node.getName() === "anchor");
  const array = anchor?.getMesh()?.listPrimitives()[0]?.getAttribute("POSITION")?.getArray();
  return array == null ? [] : Array.from(array);
}

function materialFactors(document: Document) {
  return document.getRoot().listMaterials().map((material) => material.getBaseColorFactor());
}

function smallPng(colour: readonly [number, number, number, number]): Promise<Buffer> {
  const data = Buffer.alloc(16);
  for (let i = 0; i < 4; i++) data.set([...colour], i * 4);
  return sharp(data, { raw: { width: 2, height: 2, channels: 4 } }).png().toBuffer();
}

describe("sampleEffectChannel", () => {
  const key = (t: number, v: number, interp: "constant" | "linear" | "curve") => ({ t, v, interp });

  it("honours constant, linear and cubic tangents", () => {
    const linear = { kind: "curve" as const, keys: [key(0, 0, "linear"), key(1, 10, "linear")] };
    expect(sampleEffectChannel(linear, 0.5, 0)[0]).toBeCloseTo(5);
    const constant = { kind: "curve" as const, keys: [key(0, 0, "constant"), key(1, 10, "linear")] };
    expect(sampleEffectChannel(constant, 0.99, 0)[0]).toBe(0);
    // A `curve` key blends hermite tangents, so a nonzero leave tangent leaves the linear line.
    const cubic = {
      kind: "curve" as const,
      keys: [
        { t: 0, v: 0, leaveTangent: 1, interp: "curve" as const },
        { t: 1, v: 1, arriveTangent: 0, interp: "curve" as const },
      ],
    };
    expect(sampleEffectChannel(cubic, 0.25, 0)[0]).toBeCloseTo(0.296875, 4);
    expect(sampleEffectChannel(cubic, 0.25, 0)[0]).not.toBeCloseTo(0.25, 2);
  });

  it("samples a range deterministically between the lanes", () => {
    const range = { kind: "range" as const, min: [0, 0, 0] as [number, number, number], max: [4, 8, 12] as [number, number, number] };
    expect(sampleEffectChannel(range, 0, 0)).toEqual([0, 0, 0]);
    expect(sampleEffectChannel(range, 0, 1)).toEqual([4, 8, 12]);
    expect(sampleEffectChannel(range, 0, 0.5)).toEqual([2, 4, 6]);
  });
});

describe("writeEffectPreviewGlbs", () => {
  it("writes exactly the four documented samples and an identity that matches the renderer", async () => {
    const out = await tempDir("effect-preview-");
    const result = await writeEffectPreviewGlbs({ system: "P_test", descriptor: descriptor([emitter()]), outputDir: out });
    expect(result.times).toEqual([...EFFECT_PREVIEW_SAMPLE_TIMES]);
    expect(result.samples.map((sample) => sample.time)).toEqual([...EFFECT_PREVIEW_SAMPLE_TIMES]);
    for (const sample of result.samples) await expect(stat(sample.path)).resolves.toBeDefined();
    expect(result.identity.kind).toBe("neutral");
    expect(result.identity.contract).toBe(PICTURE_CONTRACT_REVISION);
    expect(result.identity.camera.direction).toEqual([...PICTURE_CAMERA.direction]);
    expect(result.identity.camera.fov).toBe(PICTURE_CAMERA.fov);
  });

  it("moves particles with velocity and fades alpha over life, so samples differ", async () => {
    const out = await tempDir("effect-preview-");
    const described = descriptor([
      emitter({
        spawn: { rate: { kind: "range", min: 10, max: 10 }, bursts: [] },
        init: {
          lifetime: { kind: "range", min: 1, max: 1 },
          velocity: { kind: "range", min: [0, 0, 0], max: [100, 0, 0] },
          size: { kind: "range", min: 10, max: 10 },
        },
        overLife: { alpha: { kind: "curve", keys: [{ t: 0, v: 1, interp: "linear" }, { t: 1, v: 0, interp: "linear" }] } },
      }),
    ]);
    const result = await writeEffectPreviewGlbs({ system: "P_move", descriptor: described, outputDir: out });
    const first = await readDoc(result.samples[0]!.path);
    const last = await readDoc(result.samples[3]!.path);
    const firstX = particleNodes(first).map((node) => node.getTranslation()[0]!);
    const lastX = particleNodes(last).map((node) => node.getTranslation()[0]!);
    expect(firstX.every((x) => x === 0)).toBe(true);
    expect(Math.max(...lastX)).toBeGreaterThan(0);
    const firstAlpha = materialFactors(first).filter((f) => f[3]! > 0).map((f) => f[3]!);
    const lastAlpha = materialFactors(last).filter((f) => f[3]! > 0).map((f) => f[3]!);
    expect(Math.min(...firstAlpha)).toBeCloseTo(1);
    expect(Math.max(...firstAlpha)).toBeCloseTo(1);
    expect(Math.min(...lastAlpha)).toBeLessThan(0.1);
  });

  it("gives every sample the same invisible anchor so auto-framing is consistent", async () => {
    const out = await tempDir("effect-preview-");
    const described = descriptor([
      emitter({
        spawn: { rate: { kind: "range", min: 5, max: 5 }, bursts: [] },
        init: { lifetime: { kind: "range", min: 1, max: 1 }, velocity: { kind: "range", min: [0, 0, 0], max: [50, 20, 0] } },
      }),
    ]);
    const result = await writeEffectPreviewGlbs({ system: "P_anchor", descriptor: described, outputDir: out });
    const anchors = await Promise.all(result.samples.map(async (sample) => anchorPosition(await readDoc(sample.path))));
    for (const anchor of anchors) expect(anchor).toEqual(anchors[0]);
    expect(anchors[0]!.length).toBeGreaterThan(0);
  });

  it("embeds a supplied material PNG and never fakes a texture", async () => {
    const out = await tempDir("effect-preview-");
    const png = await smallPng([255, 0, 0, 255]);
    const texturePath = join(out, "T_card.png");
    await sharp(png).toFile(texturePath);
    const stored = await readFile(texturePath);
    const described = descriptor([emitter({ material: "/Game/Test/M_card" })]);
    const result = await writeEffectPreviewGlbs({
      system: "P_textured",
      descriptor: described,
      outputDir: out,
      materialTextures: new Map([["/Game/Test/M_card", texturePath]]),
    });
    expect(result.limitations.some((line) => line.includes("unresolved"))).toBe(false);
    const document = await readDoc(result.samples[0]!.path);
    const textures = document.getRoot().listTextures();
    expect(textures).toHaveLength(1);
    expect(Array.from(textures[0]!.getImage() ?? new Uint8Array())).toEqual([...stored]);
  });

  it("draws a labelled neutral card and no texture when a material is unresolved", async () => {
    const out = await tempDir("effect-preview-");
    const described = descriptor([emitter({ material: "/Game/Test/M_missing" })]);
    const result = await writeEffectPreviewGlbs({ system: "P_neutral", descriptor: described, outputDir: out });
    expect(result.limitations.some((line) => line.includes("unresolved"))).toBe(true);
    const document = await readDoc(result.samples[0]!.path);
    expect(document.getRoot().listTextures()).toHaveLength(0);
    for (const material of document.getRoot().listMaterials()) {
      expect(material.getBaseColorTexture()).toBeNull();
      expect(material.getExtension(UNLIT)).toBeTruthy();
    }
  });

  it("labels an unsupported renderer as a sprite proxy but still writes a sample", async () => {
    const out = await tempDir("effect-preview-");
    const described = descriptor([emitter({ renderer: "ribbon" })]);
    const result = await writeEffectPreviewGlbs({ system: "P_ribbon", descriptor: described, outputDir: out });
    expect(result.limitations.some((line) => line.includes("ribbon") && line.includes("sprite proxy"))).toBe(true);
    expect(result.samples).toHaveLength(4);
  });

  it("uses one exemplar when the spawn rate is missing and the cap when it is stored", async () => {
    const out = await tempDir("effect-preview-");
    const missing = await writeEffectPreviewGlbs({ system: "P_norate", descriptor: descriptor([emitter()]), outputDir: out });
    expect(missing.limitations.some((line) => line.includes("no invented spawn rate"))).toBe(true);
    expect(particleNodes(await readDoc(missing.samples[1]!.path))).toHaveLength(1);

    const stored = await writeEffectPreviewGlbs({
      system: "P_rate",
      descriptor: descriptor([emitter({ spawn: { rate: { kind: "range", min: 1, max: 1 }, bursts: [] } })]),
      outputDir: out,
    });
    expect(particleNodes(await readDoc(stored.samples[1]!.path))).toHaveLength(EFFECT_PREVIEW_PARTICLE_CAP);
  });

  it("keeps source emitter order", async () => {
    const out = await tempDir("effect-preview-");
    const described = descriptor([
      emitter({ name: "First", init: { size: { kind: "range", min: 10, max: 10 } } }),
      emitter({ name: "Second", init: { size: { kind: "range", min: 40, max: 40 } } }),
    ]);
    const result = await writeEffectPreviewGlbs({ system: "P_order", descriptor: described, outputDir: out });
    const nodes = particleNodes(await readDoc(result.samples[0]!.path));
    const first = nodes[0]!.getScale()[0]!;
    const second = nodes[1]!.getScale()[0]!;
    expect(first).toBeLessThan(second);
  });
});

describe("writeBlankEffectPreviewGlb", () => {
  it("writes a truly blank GLB labelled as no exported descriptor", async () => {
    const out = await tempDir("effect-blank-");
    const { path, limitation } = await writeBlankEffectPreviewGlb({ system: "P_base", outputDir: out });
    expect(limitation).toContain("no exported descriptor");
    const document = await readDoc(path);
    expect(document.getRoot().listMeshes()).toHaveLength(0);
    expect(document.getRoot().listNodes()).toHaveLength(0);
  });
});
