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

  it("scales each card by overLife.size as the particle ages", async () => {
    const out = await tempDir("effect-preview-");
    const described = descriptor([
      emitter({
        spawn: { rate: { kind: "range", min: 1, max: 1 }, bursts: [] },
        init: { lifetime: { kind: "range", min: 1, max: 1 }, size: { kind: "range", min: 20, max: 20 } },
        overLife: { size: { kind: "curve", keys: [{ t: 0, v: 1, interp: "linear" }, { t: 1, v: 4, interp: "linear" }] } },
      }),
    ]);
    const result = await writeEffectPreviewGlbs({ system: "P_oversize", descriptor: described, outputDir: out });
    const scalesAt = async (path: string): Promise<number[]> => particleNodes(await readDoc(path)).map((node) => node.getScale()[0]!);
    const first = await scalesAt(result.samples[0]!.path);
    const last = await scalesAt(result.samples[3]!.path);
    // Age 0 is scale 1 and age 1 is scale 4, so every later card is larger than any card at time 0.
    expect(Math.max(...first)).toBeGreaterThan(0);
    expect(Math.min(...last)).toBeGreaterThan(Math.max(...first));
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

  it("turns a stored radian rotation into the matching quaternion (Cascade quarter turn, Niagara 90 degrees)", async () => {
    const out = await tempDir("effect-preview-");
    // A Cascade quarter turn and a Niagara 90-degree angle both normalize to π/2 radians at the builder
    // boundary, so the preview receives the same portable value and must produce the same quaternion.
    const described = descriptor([emitter({ init: { rotation: { kind: "range", min: Math.PI / 2, max: Math.PI / 2 } } })]);
    const result = await writeEffectPreviewGlbs({ system: "P_rot", descriptor: described, outputDir: out });
    const node = particleNodes(await readDoc(result.samples[0]!.path))[0]!;
    const quaternion = node.getRotation();
    expect(quaternion[2]).toBeCloseTo(Math.sin(Math.PI / 4), 6);
    expect(quaternion[3]).toBeCloseTo(Math.cos(Math.PI / 4), 6);
  });

  it("advances rotation by the per-second rate over the particle's life", async () => {
    const out = await tempDir("effect-preview-");
    const described = descriptor([
      emitter({
        spawn: { rate: { kind: "range", min: 1, max: 1 }, bursts: [] },
        init: {
          lifetime: { kind: "range", min: 1, max: 1 },
          rotationRate: { kind: "range", min: Math.PI / 2, max: Math.PI / 2 },
        },
      }),
    ]);
    const result = await writeEffectPreviewGlbs({ system: "P_rate", descriptor: described, outputDir: out });
    // At age 1 with a one-second life, the rate of π/2 rad/s has turned the card a quarter turn.
    // Index 0 is the youngest; the last card is the oldest, at the sampled wall time.
    const nodes = particleNodes(await readDoc(result.samples[3]!.path));
    expect(nodes[nodes.length - 1]!.getRotation()[2]).toBeCloseTo(Math.sin(Math.PI / 4), 6);
  });

  it("links every particle to its own emitter's material when the emitter counts differ", async () => {
    const out = await tempDir("effect-preview-");
    const redPng = await smallPng([255, 0, 0, 255]);
    const bluePng = await smallPng([0, 0, 255, 255]);
    const redPath = join(out, "M_red.png");
    const bluePath = join(out, "M_blue.png");
    await sharp(redPng).toFile(redPath);
    await sharp(bluePng).toFile(bluePath);
    const stored = { red: await readFile(redPath), blue: await readFile(bluePath) };
    const described = descriptor([
      // The first emitter stores no rate: one exemplar red card. The second stores a rate: the full
      // default cap of blue cards. The counts differ, so a flat index across both emitters would hand
      // the second emitter's cards the first emitter's texture; only the per-particle material is right.
      emitter({ name: "First", material: "/Game/Test/M_red" }),
      emitter({ name: "Second", material: "/Game/Test/M_blue", spawn: { rate: { kind: "range", min: 1, max: 1 }, bursts: [] } }),
    ]);
    const result = await writeEffectPreviewGlbs({
      system: "P_materials",
      descriptor: described,
      outputDir: out,
      materialTextures: new Map([["/Game/Test/M_red", redPath], ["/Game/Test/M_blue", bluePath]]),
    });
    for (const sample of result.samples) {
      const nodes = particleNodes(await readDoc(sample.path));
      const images = nodes.map((node) => Array.from(node.getMesh()!.listPrimitives()[0]!.getMaterial()!.getBaseColorTexture()!.getImage()!));
      // Assert the texture each card carries, not the node count: the exemplar is red, every card of
      // the rated emitter is blue.
      expect(images[0]).toEqual([...stored.red]);
      expect(images.length).toBeGreaterThan(1);
      for (const image of images.slice(1)) expect(image).toEqual([...stored.blue]);
    }
  });

  it("names the uniform-square-card approximation when a size channel carries per-axis lanes", async () => {
    const out = await tempDir("effect-preview-");
    const described = descriptor([emitter({ init: { size: { kind: "range", min: [10, 20, 30], max: [10, 20, 30] } } })]);
    const result = await writeEffectPreviewGlbs({ system: "P_sizevec", descriptor: described, outputDir: out });
    expect(result.limitations.some((line) => line.includes("per-axis lanes") && line.includes("first lane"))).toBe(true);
  });
});

describe("writeBlankEffectPreviewGlb", () => {
  it("reuses the descriptor preview's invisible anchor and adds no visible particle", async () => {
    const out = await tempDir("effect-blank-");
    const described = descriptor([
      emitter({
        spawn: { rate: { kind: "range", min: 5, max: 5 }, bursts: [] },
        init: { lifetime: { kind: "range", min: 1, max: 1 }, velocity: { kind: "range", min: [0, 0, 0], max: [50, 20, 0] } },
      }),
    ]);
    const after = await writeEffectPreviewGlbs({ system: "P_base", descriptor: described, outputDir: out });
    const { path, limitation } = await writeBlankEffectPreviewGlb({ system: "P_base", outputDir: out, descriptor: described });
    expect(limitation).toContain("no exported descriptor");
    const before = await readDoc(path);
    // Same camera and frame before/after: the blank carries the identical invisible anchor.
    expect(anchorPosition(before)).toEqual(anchorPosition(await readDoc(after.samples[0]!.path)));
    expect(anchorPosition(before).length).toBeGreaterThan(0);
    // No visible particle: no particle node and every material is the fully transparent anchor.
    expect(particleNodes(before)).toHaveLength(0);
    expect(before.getRoot().listMaterials()).toHaveLength(1);
    for (const material of before.getRoot().listMaterials()) expect(material.getBaseColorFactor()[3]).toBe(0);
  });
});
