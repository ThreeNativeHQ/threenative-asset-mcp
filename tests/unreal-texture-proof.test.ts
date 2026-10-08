import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { importUnrealDirectory, type ImportReport } from "../src/unreal/importer.js";
import {
  crossDecodeProof,
  flattenProofSources,
  proveTextures,
  textureIdentityReason,
} from "../src/unreal/texture-proof.js";
import { writeFakeUmodel, writeMeshFixture } from "./helpers/unreal-fixture.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "texture-proof-"));
  directories.push(directory);
  return directory;
}

/** An asymmetric, warm, low-saturation picture (the importer only binds plausible albedos). */
async function writeAsymmetricPng(path: string, size: number, seed = 1): Promise<void> {
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const base = 60 + Math.floor((x * 120) / size) + ((y * seed * 37) % 23) + ((x * y * 7) % 11);
      const o = (y * size + x) * 4;
      pixels[o] = Math.min(255, base + 20);
      pixels[o + 1] = Math.min(255, base + 8);
      pixels[o + 2] = Math.min(255, base - 12);
      pixels[o + 3] = 255;
    }
  }
  await writeFile(path, await sharp(pixels, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer());
}

interface Imported {
  readonly report: ImportReport;
  readonly outputDir: string;
  readonly byGlb: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>;
}

/** Imports a one-mesh pack with an albedo and a normal map; staging is kept so the sources stay readable. */
async function importPack(size: number, maxTextureSize?: number): Promise<Imported> {
  const directory = await scratch();
  const sourceDir = join(directory, "source", "Content");
  const fixture = join(directory, "fixture");
  const outputDir = join(directory, "output");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, "Rock.uasset"), Buffer.alloc(16));
  await writeMeshFixture(fixture, {
    name: "Rock",
    materialName: "M_Rock",
    mat: "Diffuse=T_Rock_D\nNormal=T_Rock_N\n",
    props: "",
    textures: ["T_Rock_D", "T_Rock_N"],
  });
  await writeAsymmetricPng(join(fixture, "T_Rock_D.png"), size, 1);
  await writeAsymmetricPng(join(fixture, "T_Rock_N.png"), size, 3);
  const tool = join(directory, "umodel");
  await writeFakeUmodel(tool, { exportFrom: fixture, classes: { Rock: ["StaticMesh"] } });
  let byGlb: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>> = new Map();
  const report = await importUnrealDirectory({
    sourceDir: join(directory, "source"),
    outputDir,
    concurrency: 1,
    graphBake: false,
    keepStaging: true,
    freeSpaceBytes: 30_000_000_000,
    ...(maxTextureSize === undefined ? {} : { maxTextureSize }),
    environment: { ...process.env, THREENATIVE_UNREAL_CACHE_DIR: join(directory, "cache") },
    umodel: { name: "umodel", path: tool, version: "fixture" },
    proofSources: (sources) => {
      byGlb = new Map([...sources].map(([glb, textures]) => [glb, new Map(textures)]));
    },
  });
  return { report, outputDir, byGlb };
}

async function prove(imported: Imported, maxTextureSize?: number) {
  const flat = await flattenProofSources(imported.byGlb);
  return proveTextures({
    report: imported.report,
    outputDir: imported.outputDir,
    sourceTextures: flat.sourceTextures,
    ambiguous: flat.ambiguous,
    sourcesByGlb: imported.byGlb,
    maxTextureSize,
  });
}

/** Rewrites one embedded texture with a single pixel changed. */
async function tamper(imported: Imported, textureName: string): Promise<void> {
  const glbPath = join(imported.outputDir, imported.report.models[0]!.glb);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const document = await io.read(glbPath);
  const texture = document.getRoot().listTextures().find((t) => t.getName() === textureName)!;
  const { data, info } = await sharp(Buffer.from(texture.getImage()!)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  data[(3 * info.width + 5) * 4 + 1] = (data[(3 * info.width + 5) * 4 + 1]! + 40) % 256;
  texture.setImage(new Uint8Array(await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer()));
  await io.write(glbPath, document);
}

describe("proveTextures", () => {
  it("finds every exact binding byte-for-byte identical to the exporter's PNG", async () => {
    const imported = await importPack(16);
    expect(imported.report.models[0]!.materials[0]!.bindings.map((b) => b.texture).sort()).toEqual(["T_Rock_D", "T_Rock_N"]);
    const proof = await prove(imported);
    expect(proof).toMatchObject({ compared: 2, identical: 2, minSsim: 1, resized: 0, mismatchCount: 0, sampled: false });
    expect(proof.skipped).toEqual({});
    expect(textureIdentityReason(proof)).toBeUndefined();
  });

  it("names the texture whose embedded pixels were changed", async () => {
    const imported = await importPack(16);
    await tamper(imported, "T_Rock_D");
    const proof = await prove(imported);
    expect(proof.compared).toBe(2);
    expect(proof.identical).toBe(1);
    expect(proof.mismatchCount).toBe(1);
    const [bad] = proof.mismatches;
    expect(bad).toMatchObject({ texture: "T_Rock_D", slot: "baseColor", identical: false, resized: false });
    expect(bad!.ssim).toBeLessThan(1);
    expect(bad!.mse).toBeGreaterThan(0);
    expect(bad!.maxAbs).toBe(40);
    expect(proof.minSsim).toBe(bad!.ssim);
    expect(textureIdentityReason(proof)).toBe("S5 texture identity: 1 of 2 textures differ (T_Rock_D)");
  });

  it("compares a downscaled texture against the source resized by the importer's own function", async () => {
    const imported = await importPack(64, 16);
    const embedded = await prove(imported, 16);
    expect(embedded).toMatchObject({ compared: 2, identical: 2, minSsim: 1, resized: 2, mismatchCount: 0 });
    // Without the resize parameter the same import no longer matches: the size differs from the source.
    const unaware = await prove(imported, undefined);
    expect(unaware.mismatchCount).toBe(2);
    expect(unaware.mismatches[0]!.reason).toMatch(/size 16x16 embedded vs 64x64 expected/);
  });

  it("does not compare a source that is ambiguous or missing, and says why", async () => {
    const imported = await importPack(16);
    const flat = await flattenProofSources(imported.byGlb);
    const proof = await proveTextures({
      report: imported.report,
      outputDir: imported.outputDir,
      sourceTextures: new Map([["T_Rock_D", flat.sourceTextures.get("T_Rock_D")!]]),
      ambiguous: new Set(["T_Rock_D"]),
    });
    expect(proof.compared).toBe(0);
    expect(proof.minSsim).toBeNull();
    expect(proof.skipped).toEqual({ "ambiguous source": 1, "no source png": 1 });
  });

  it("treats byte-identical copies of a texture as one source and differing copies as ambiguous", async () => {
    const directory = await scratch();
    const one = join(directory, "one.png");
    const copy = join(directory, "copy.png");
    const other = join(directory, "other.png");
    await writeAsymmetricPng(one, 16, 1);
    await writeFile(copy, await readFile(one));
    await writeAsymmetricPng(other, 16, 2);
    const flat = await flattenProofSources(
      new Map([
        ["a.glb", new Map([["Same", [one, copy]], ["Differs", [one, other]]])],
        ["b.glb", new Map([["Same", [copy]]])],
      ]),
    );
    expect([...flat.ambiguous]).toEqual(["Differs"]);
    expect(flat.sourceTextures.get("Same")).toBe(copy);
  });

  it("caps the work with an even sample and says so", async () => {
    const imported = await importPack(16);
    const flat = await flattenProofSources(imported.byGlb);
    const proof = await proveTextures({
      report: imported.report,
      outputDir: imported.outputDir,
      sourceTextures: flat.sourceTextures,
      sample: 1,
    });
    expect(proof).toMatchObject({ compared: 1, candidates: 2, sampled: true });
  });

  it("hands the importer's sources out before staging is deleted", async () => {
    const directory = await scratch();
    const sourceDir = join(directory, "source", "Content");
    const fixture = join(directory, "fixture");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "Rock.uasset"), Buffer.alloc(16));
    await writeMeshFixture(fixture, { name: "Rock", materialName: "M_Rock", mat: "Diffuse=T_Rock_D\n", props: "", textures: ["T_Rock_D"] });
    await writeAsymmetricPng(join(fixture, "T_Rock_D.png"), 16);
    const tool = join(directory, "umodel");
    await writeFakeUmodel(tool, { exportFrom: fixture, classes: { Rock: ["StaticMesh"] } });
    const outputDir = join(directory, "output");
    let inHook: Awaited<ReturnType<typeof proveTextures>> | undefined;
    let sourcePath = "";
    await importUnrealDirectory({
      sourceDir: join(directory, "source"),
      outputDir,
      concurrency: 1,
      graphBake: false,
      freeSpaceBytes: 30_000_000_000,
      environment: { ...process.env, THREENATIVE_UNREAL_CACHE_DIR: join(directory, "cache") },
      umodel: { name: "umodel", path: tool, version: "fixture" },
      proofSources: async (sources, report) => {
        const flat = await flattenProofSources(sources);
        sourcePath = flat.sourceTextures.get("T_Rock_D")!;
        inHook = await proveTextures({ report, outputDir, sourceTextures: flat.sourceTextures });
      },
    });
    expect(inHook).toMatchObject({ compared: 1, identical: 1 });
    await expect(readFile(sourcePath)).rejects.toThrow(/ENOENT/);
  });
});

describe("graph-baked textures", () => {
  /** A GLB with two materials whose base colours are the given PNGs, and the matching report. */
  async function graphPack(images: Record<string, Buffer>): Promise<{ report: ImportReport; outputDir: string }> {
    const outputDir = await scratch();
    const document = new Document();
    document.createBuffer();
    const sections = [];
    for (const [name, png] of Object.entries(images)) {
      const texture = document.createTexture(`${name}_graph_baseColor`).setImage(new Uint8Array(png)).setMimeType("image/png");
      document.createMaterial(name).setBaseColorTexture(texture);
      sections.push({
        name,
        bindings: [{ slot: "baseColor", texture: `${name}_graph_baseColor`, source: "graph", confidence: "exact", transform: "none" }],
        unsupported: [],
      });
    }
    await new NodeIO().write(join(outputDir, "m.glb"), document);
    return { report: { models: [{ glb: "m.glb", materials: sections }], materialAssets: [] } as unknown as ImportReport, outputDir };
  }
  const solid = (rgb: [number, number, number]): Promise<Buffer> =>
    sharp({ create: { width: 8, height: 8, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer();

  it("accepts a varied non-neutral bake and flags constant or neutral ones without calling them identity failures", async () => {
    const varied = await sharp(Buffer.from(Array.from({ length: 8 * 8 * 3 }, (_, i) => (i * 29) % 200)), { raw: { width: 8, height: 8, channels: 3 } }).png().toBuffer();
    const { report, outputDir } = await graphPack({ Good: varied, Flat: await solid([90, 60, 30]), Neutral: await solid([204, 204, 204]) });
    const proof = await proveTextures({ report, outputDir, sourceTextures: new Map() });
    expect(proof).toMatchObject({ compared: 0, mismatchCount: 0 });
    expect(proof.graph.checked).toBe(3);
    expect(proof.graph.ok).toBe(1);
    const failures = Object.fromEntries(proof.graph.failures.map((f) => [f.texture, f]));
    expect(failures.Flat_graph_baseColor).toMatchObject({ nonConstant: false, differsFromNeutral: true });
    expect(failures.Neutral_graph_baseColor).toMatchObject({ nonConstant: false, differsFromNeutral: false });
    expect(textureIdentityReason(proof)).toBeUndefined();
  });
});

describe("crossDecodeProof", () => {
  /** A stand-in for ThreeNativeConverter: writes Textures/<filter>.png from a per-name directory of PNGs. */
  async function fakeConverter(directory: string, pngs: Record<string, string>, failOn: string[] = []): Promise<string> {
    const path = join(directory, "converter");
    await writeFile(
      path,
      `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const { join } = require("node:path");
const argv = process.argv.slice(2);
const pngs = ${JSON.stringify(pngs)};
const failOn = ${JSON.stringify(failOn)};
const flag = (name) => (argv.indexOf(name) < 0 ? undefined : argv[argv.indexOf(name) + 1]);
const filter = flag("--filter");
if (failOn.includes(filter)) { process.stderr.write("boom " + filter + "\\n"); process.exit(3); }
if (!pngs[filter]) process.exit(0);
const out = join(flag("--export-dir"), "Textures");
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(pngs[filter], join(out, filter + ".png"));
`,
    );
    await chmod(path, 0o755);
    return path;
  }

  it("agrees when the second decoder produces the same pixels, and reports the ssim", async () => {
    const directory = await scratch();
    const a = join(directory, "a.png");
    await writeAsymmetricPng(a, 16, 1);
    const converter = await fakeConverter(directory, { A: a, B: a });
    const proof = await crossDecodeProof(directory, ["A", "B"], {
      converterPath: converter,
      engine: "4.18",
      sourceTextures: new Map([["A", a], ["B", a]]),
    });
    expect(proof).toMatchObject({ status: "agree", requested: 2, compared: 2, agreeing: 2, unavailable: 0, minSsim: 1 });
  });

  it("compares at the smaller resolution when the decoders disagree on size, and reports the sizes", async () => {
    const directory = await scratch();
    const width = 64;
    const data = Buffer.alloc(width * width * 4);
    for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) data.set([x * 4, y * 4, 128, 255], (y * width + x) * 4);
    const viewer = join(directory, "viewer.png");
    const half = join(directory, "half.png");
    await writeFile(viewer, await sharp(data, { raw: { width, height: width, channels: 4 } }).png().toBuffer());
    await writeFile(half, await sharp(data, { raw: { width, height: width, channels: 4 } }).resize(32, 32).png().toBuffer());
    const converter = await fakeConverter(directory, { Mip: half });
    const proof = await crossDecodeProof(directory, ["Mip"], { converterPath: converter, sourceTextures: new Map([["Mip", viewer]]) });
    expect(proof).toMatchObject({ status: "agree", sizeMismatches: 1 });
    expect(proof.results[0]).toMatchObject({ width: 32, height: 32, sizeDiffers: true, viewerSize: "64x64", cue4parseSize: "32x32" });
  });

  it("flags a disagreement below the ssim threshold", async () => {
    const directory = await scratch();
    const a = join(directory, "a.png");
    const b = join(directory, "b.png");
    await writeAsymmetricPng(a, 16, 1);
    await writeAsymmetricPng(b, 16, 5);
    const converter = await fakeConverter(directory, { A: b });
    const proof = await crossDecodeProof(directory, ["A"], { converterPath: converter, sourceTextures: new Map([["A", a]]) });
    expect(proof.status).toBe("disagree");
    expect(proof.results[0]).toMatchObject({ texture: "A", status: "disagree" });
    expect(proof.minSsim!).toBeLessThan(0.999);
  });

  it("is unavailable, not failed, when either decoder cannot produce the texture", async () => {
    const directory = await scratch();
    const a = join(directory, "a.png");
    await writeAsymmetricPng(a, 16, 1);
    const converter = await fakeConverter(directory, { Ok: a, Crash: a }, ["Crash"]);
    const proof = await crossDecodeProof(directory, ["Crash", "NoPng", "NoViewer"], {
      converterPath: converter,
      sourceTextures: new Map([["Crash", a], ["NoPng", a]]),
    });
    expect(proof).toMatchObject({ status: "unavailable", compared: 0, unavailable: 3, minSsim: null });
    expect(proof.results.map((r) => r.reason)).toEqual([
      expect.stringContaining("exited 3"),
      expect.stringContaining("wrote no PNG"),
      expect.stringContaining("UE Viewer exported no PNG"),
    ]);
  });

  it("samples evenly and a missing converter binary is unavailable", async () => {
    const directory = await scratch();
    const a = join(directory, "a.png");
    await writeAsymmetricPng(a, 16, 1);
    const names = Array.from({ length: 10 }, (_, i) => `T${i}`);
    const proof = await crossDecodeProof(directory, names, {
      converterPath: join(directory, "missing-converter"),
      sample: 3,
      sourceTextures: new Map(names.map((n) => [n, a])),
    });
    expect(proof).toMatchObject({ requested: 3, status: "unavailable", unavailable: 3 });
  });
});
