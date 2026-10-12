import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeIO } from "@gltf-transform/core";
import sharp from "sharp";
import { describe, expect, it, onTestFinished } from "vitest";

import { materialGraphSchema, type MaterialGraph } from "../src/unreal/graph-dump.js";
import { importUnrealDirectory } from "../src/unreal/importer.js";
import { writeMeshFixture, writePng } from "./helpers/unreal-fixture.js";

async function scratch(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

type Raw = Record<string, unknown>;
const pin = (node: string, mask: number[] | null = null) => ({ node, output: 0, mask });
const node = (id: string, cls: string, extra: Raw = {}): Raw => ({ id, class: cls, inputs: {}, constants: {}, ...extra });

/** A texture sampled by the graph: the parameter that samples it (an instance override of that name replaces it). */
interface Sample {
  readonly parameter: string;
  readonly texture: string;
}

/** BaseColor = the sample itself, with a `Color` sampler, so the source's `SRGB` flag decides the baked bytes. */
function colorGraph(material: string, texture: string): MaterialGraph {
  const nodes: Raw[] = [node("sample", "TextureSample", { texture, samplerType: "Color" })];
  return materialGraphSchema.parse({
    format: 1,
    material,
    package: `/Game/Test/${material}`,
    truncated: false,
    nodeCount: nodes.length,
    outputs: { baseColor: pin("sample"), roughness: null, metallic: null, emissive: null, opacity: null, opacityMask: null, normal: null, materialAttributes: null },
    nodes,
  });
}

/**
 * BaseColor = Mask.RGB of one sample x tint(0.5, 0.25, 1); with two samples, their Mask.RGBs multiplied.
 * Every sample is a TextureSampleParameter2D, so an instance override of its parameter applies to it.
 */
function maskGraph(material: string, samples: readonly Sample[]): MaterialGraph {
  const nodes: Raw[] = samples.map((sample, index) =>
    node(`sample${index}`, "TextureSampleParameter2D", {
      parameter: { name: sample.parameter, group: "" },
      default: null,
      texture: sample.texture,
      samplerType: "Masks",
    }),
  );
  if (samples.length === 1) nodes.push(node("tint", "Constant3Vector", { constants: { Constant: [0.5, 0.25, 1, 1] } }));
  nodes.push(node("mul", "Multiply", { inputs: { A: pin("sample0", [1, 1, 1, 0]), B: samples.length === 1 ? pin("tint") : pin("sample1", [1, 1, 1, 0]) } }));
  return materialGraphSchema.parse({
    format: 1,
    material,
    package: `/Game/Test/${material}`,
    truncated: false,
    nodeCount: nodes.length,
    outputs: { baseColor: pin("mul"), roughness: null, metallic: null, emissive: null, opacity: null, opacityMask: null, normal: null, materialAttributes: null },
    nodes,
  });
}

/** BaseColor = the branch of a static switch x tint(0.5, 0.25, 1); the inactive branch is a same-named texture from another package. */
function switchGraph(material: string, branches: readonly [string, string], selectFirst: boolean): MaterialGraph {
  const nodes: Raw[] = [
    node("leaf", "TextureSample", { texture: branches[0], samplerType: "Masks" }),
    node("trunk", "TextureSample", { texture: branches[1], samplerType: "Masks" }),
    node("switch", "StaticSwitchParameter", {
      inputs: { A: pin("leaf", [1, 1, 1, 0]), B: pin("trunk", [1, 1, 1, 0]) },
      parameter: { name: "Branch", group: "" },
      default: selectFirst,
      switchValue: selectFirst,
    }),
    node("tint", "Constant3Vector", { constants: { Constant: [0.5, 0.25, 1, 1] } }),
    node("mul", "Multiply", { inputs: { A: pin("switch", [1, 1, 1, 0]), B: pin("tint") } }),
  ];
  return materialGraphSchema.parse({
    format: 1,
    material,
    package: `/Game/Test/${material}`,
    truncated: false,
    nodeCount: nodes.length,
    outputs: { baseColor: pin("mul"), roughness: null, metallic: null, emissive: null, opacity: null, opacityMask: null, normal: null, materialAttributes: null },
    nodes,
  });
}

/** A converter that only answers `--version` and `--dump-graphs`, and writes the given graphs when dumping. */
async function writeFakeConverter(path: string, graphs: readonly MaterialGraph[]): Promise<void> {
  const files = graphs.map((graph) => [`${graph.material}.graph.json`, JSON.stringify(graph)]);
  await writeFile(
    path,
    `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const { join } = require("node:path");
const argv = process.argv.slice(2);
if (argv.includes("--version")) { process.stdout.write("fake-converter 1\\n"); process.exit(0); }
const at = argv.indexOf("--dump-graphs");
if (at >= 0) {
  for (const [name, text] of ${JSON.stringify(files)}) fs.writeFileSync(join(argv[at + 1], name), text);
}
process.exit(0);
`,
  );
  await chmod(path, 0o755);
}

/** What the fake UE Viewer lists and exports for one package selector (`Content/...`, no extension). */
type FakePackage =
  | { readonly kind: "StaticMesh"; readonly from: string }
  | { readonly kind: "Texture2D"; readonly png: string; readonly props?: string };

/** A fake `umodel`: lists and exports only the packages it is given. `flat` drops a texture's package folders on export. */
async function writeFakeUmodel(path: string, options: { readonly packages: Readonly<Record<string, FakePackage>>; readonly flat: boolean }): Promise<void> {
  await writeFile(
    path,
    `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const { basename, dirname, join } = require("node:path");
const argv = process.argv.slice(2);
const options = ${JSON.stringify(options)};
const selector = argv.filter((entry) => !entry.startsWith("-")).pop() || "";
const spec = options.packages[selector];
if (argv.includes("-version")) { process.stdout.write("UE Viewer (UModel)\\nCompiled Test 2026 (build 1)\\n"); process.exit(0); }
if (argv.includes("-list")) {
  process.stdout.write("Found 1 game files (0 skipped) in 1 folders\\n");
  if (spec) process.stdout.write("   0    1000       10 " + (spec.kind === "StaticMesh" ? "StaticMesh" : "Texture2D") + " " + basename(selector) + "\\n");
  process.exit(0);
}
if (argv.includes("-export") && spec) {
  const out = (argv.find((entry) => entry.indexOf("-out=") === 0) || "").slice("-out=".length);
  if (spec.kind === "StaticMesh") {
    const destination = join(out, "Group", "Package");
    fs.mkdirSync(destination, { recursive: true });
    fs.cpSync(spec.from, destination, { recursive: true });
  } else {
    const target = options.flat ? join(out, basename(selector) + ".png") : join(out, selector + ".png");
    fs.mkdirSync(dirname(target), { recursive: true });
    fs.copyFileSync(spec.png, target);
    // UE Viewer writes the texture's own .props.txt beside the PNG; its SRGB is that package's metadata.
    if (spec.props !== undefined) fs.writeFileSync(join(dirname(target), basename(selector) + ".props.txt"), spec.props);
  }
}
process.exit(0);
`,
  );
  await chmod(path, 0o755);
}

async function firstPixel(png: Buffer | Uint8Array): Promise<number[]> {
  const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return [...data.subarray(0, 3)];
}

const encode = (unit: number): number => {
  const value = Math.min(1, Math.max(0, unit));
  return Math.round((value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055) * 255);
};

/** The baked pixel of a Mask.RGB x tint(0.5, 0.25, 1) when the mask texture's first texel is [r, g, b]. */
const tinted = (rgb: readonly number[]): number[] => [encode((rgb[0]! / 255) * 0.5), encode((rgb[1]! / 255) * 0.25), encode(rgb[2]! / 255)];

/** The instance's props: its parent, and its texture overrides as the engine writes them (`Content/...` references). */
function instanceProps(parent: string, overrides: readonly (readonly [parameter: string, texture: string])[] = []): string {
  const lines = [`Parent = Material3'Content/Test/${parent}.${parent}'`];
  if (overrides.length > 0) {
    lines.push(`TextureParameterValues[${overrides.length}] =`, "{");
    for (const [index, [parameter, texture]] of overrides.entries()) {
      lines.push(
        `    TextureParameterValues[${index}] =`,
        "    {",
        "        ParameterInfo = { Name=None }",
        `        ParameterValue = Texture2D'Content${texture.replace(/^\/Game/, "")}'`,
        `        ParameterName = ${parameter}`,
        "    }",
      );
    }
    lines.push("}");
  }
  return lines.join("\n");
}

interface Section {
  readonly mesh: string;
  readonly instance: string;
  readonly graph: MaterialGraph;
  readonly overrides?: readonly (readonly [parameter: string, texture: string])[];
}

/** A source texture package `<mount>/Content/<folder>/Textures/<name>` whose export is one pixel of `pixel` (RGBA). */
interface Texture {
  readonly folder: string;
  readonly name?: string;
  readonly pixel: readonly number[];
  /** A project wrapper for this package alone (defaults to the sections' `mount`), so two projects can be built. */
  readonly mount?: string;
  /** The package's own `SRGB` property, written into its export sidecar; absent means Unreal's default (true). */
  readonly srgb?: boolean;
}

/**
 * Imports the sections (one mesh each, with its instance and parent graph) against the given texture packages, and
 * returns each section's graph outcome and glTF material. Packages are written under `Content/`, the layout the
 * importer maps to `/Game`; `mount` wraps that in a project folder (`Paragon/Content`), as a Fab staging download
 * does. `meshProps` writes extra `.props.txt` files (a same-named package's metadata) into each mesh export.
 */
async function importSections(options: {
  readonly sections: readonly Section[];
  readonly textures: readonly Texture[];
  readonly flatOutput?: boolean;
  readonly mount?: string;
  readonly meshProps?: readonly (readonly [name: string, text: string])[];
}) {
  const root = await scratch("paragon-dedupe-");
  const sourceDir = join(root, "source");
  const prefix = options.mount ? `${options.mount}/` : "";
  const content = join(sourceDir, ...(options.mount ? [options.mount] : []), "Content", "Test");
  await mkdir(content, { recursive: true });
  const packages: Record<string, FakePackage> = {};
  const onlyPackages = new Set<string>();
  for (const section of options.sections) {
    const exported = join(root, "exported", section.mesh);
    await writeFile(join(content, `${section.mesh}.uasset`), Buffer.alloc(16));
    await writeFile(join(content, `${section.instance}.uasset`), Buffer.alloc(16));
    await writeMeshFixture(exported, {
      name: section.mesh,
      materialName: section.instance,
      mat: "",
      props: instanceProps(section.graph.material, section.overrides),
      textures: [],
    });
    for (const [name, text] of options.meshProps ?? []) await writeFile(join(exported, `${name}.props.txt`), text);
    packages[`${prefix}Content/Test/${section.mesh}`] = { kind: "StaticMesh", from: exported };
    onlyPackages.add(section.mesh);
  }
  for (const texture of options.textures) {
    const name = texture.name ?? "T_Masked";
    const textureMount = texture.mount ?? options.mount;
    const texturePrefix = textureMount ? `${textureMount}/` : "";
    const directory = join(sourceDir, ...(textureMount ? [textureMount] : []), "Content", texture.folder, "Textures");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${name}.uasset`), Buffer.alloc(16));
    const png = join(root, "png", `${texturePrefix.replace(/\//g, "-")}${texture.folder}-${name}.png`);
    await mkdir(join(root, "png"), { recursive: true });
    await writePng(png, texture.pixel, 4);
    packages[`${texturePrefix}Content/${texture.folder}/Textures/${name}`] = {
      kind: "Texture2D",
      png,
      ...(texture.srgb === undefined ? {} : { props: `SRGB = ${texture.srgb}\n` }),
    };
    onlyPackages.add(name);
  }
  const umodel = join(root, "umodel");
  await writeFakeUmodel(umodel, { packages, flat: options.flatOutput === true });
  const converter = join(root, "converter");
  await writeFakeConverter(converter, options.sections.map((section) => section.graph));
  const outputDir = join(root, "output");
  const report = await importUnrealDirectory({
    sourceDir,
    outputDir,
    onlyPackages: [...onlyPackages],
    concurrency: 1,
    freeSpaceBytes: 30_000_000_000,
    umodel: { name: "umodel", path: umodel, version: "fixture" },
    modernConverter: { name: "modern", path: converter, version: "fake-converter 1" },
  });
  const results = [];
  for (const section of options.sections) {
    const model = report.models.find((entry) => entry.name === section.mesh);
    if (!model) throw new Error(`the import report has no model ${section.mesh}`);
    const glb = await new NodeIO().read(join(outputDir, model.glb));
    const materials = glb.getRoot().listMaterials();
    results.push({
      graph: model.materials[0]?.graph,
      material: materials.find((entry) => entry.getName() === section.instance) ?? materials[0]!,
    });
  }
  return results;
}

/** `importSections` for one section, returning its outcome rather than an array element that may be absent. */
async function importOne(options: {
  readonly sections: readonly [Section];
  readonly textures: readonly Texture[];
  readonly flatOutput?: boolean;
  readonly mount?: string;
  readonly meshProps?: readonly (readonly [name: string, text: string])[];
}) {
  const [result] = await importSections(options);
  return result!;
}

const RED = [200, 100, 50, 255];
const BLUE = [10, 220, 30, 255];

describe("graph-hidden textures with same-named source packages", () => {
  it("loads one source when unqualified copies export byte-identical PNGs and share one known SRGB", async () => {
    const { graph, material } = await importOne({
      sections: [{ mesh: "Mesh", instance: "MI_Rock", graph: maskGraph("M_Master", [{ parameter: "Mask", texture: "T_Masked" }]) }],
      textures: [
        { folder: "A", pixel: RED, srgb: true },
        { folder: "B", pixel: RED, srgb: true },
      ],
    });
    expect(graph?.status).toBe("baked");
    expect(graph?.confidence).toBe("exact");
    expect(graph?.approximations?.some((note) => note.includes("ambiguous exported PNG basename"))).toBe(false);
    expect(await firstPixel(material.getBaseColorTexture()!.getImage()!)).toEqual(tinted([200, 100, 50]));
  });

  it("refuses an unqualified reference when byte-identical copies carry different SRGB", async () => {
    // The two PNGs are the very same bytes, but one package stores raw colour and the other sRGB: they sample
    // differently, so no arbitrary first export can stand for both.
    const { graph, material } = await importOne({
      sections: [{ mesh: "Mesh", instance: "MI_Rock", graph: maskGraph("M_Master", [{ parameter: "Mask", texture: "T_Masked" }]) }],
      textures: [
        { folder: "A", pixel: RED, srgb: true },
        { folder: "B", pixel: RED, srgb: false },
      ],
    });
    expect(graph?.status).toBe("unavailable");
    expect(material.getBaseColorTexture()).toBeNull();
  });

  it("refuses an unqualified reference when a byte-identical copy carries no sidecar", async () => {
    // One package has no `.props.txt`: its SRGB flag is unknown, so equality of decoding cannot be proven.
    const { graph, material } = await importOne({
      sections: [{ mesh: "Mesh", instance: "MI_Rock", graph: maskGraph("M_Master", [{ parameter: "Mask", texture: "T_Masked" }]) }],
      textures: [
        { folder: "A", pixel: RED, srgb: true },
        { folder: "B", pixel: RED },
      ],
    });
    expect(graph?.status).toBe("unavailable");
    expect(material.getBaseColorTexture()).toBeNull();
  });

  it("loads the copy a qualified reference names when both copies export identical PNGs", async () => {
    const { graph, material } = await importOne({
      sections: [{ mesh: "Mesh", instance: "MI_Rock", graph: maskGraph("M_Master", [{ parameter: "Mask", texture: "/Game/A/Textures/T_Masked.T_Masked" }]) }],
      textures: [
        { folder: "A", pixel: RED },
        { folder: "B", pixel: RED },
      ],
    });
    expect(graph?.status).toBe("baked");
    expect(graph?.confidence).toBe("exact");
    expect(await firstPixel(material.getBaseColorTexture()!.getImage()!)).toEqual(tinted([200, 100, 50]));
  });

  it("refuses when the copies differ and no package the reference names exists", async () => {
    const { graph, material } = await importOne({
      sections: [{ mesh: "Mesh", instance: "MI_Rock", graph: maskGraph("M_Master", [{ parameter: "Mask", texture: "/Game/Test/Textures/T_Masked.T_Masked" }]) }],
      textures: [
        { folder: "A", pixel: RED },
        { folder: "B", pixel: BLUE },
      ],
    });
    expect(graph?.status).toBe("unavailable");
    expect(graph?.status === "unavailable" && graph.reason).toContain("T_Masked");
    expect(material.getBaseColorTexture()).toBeNull();
  });

  it("loads the copy a qualified reference names when the copies differ", async () => {
    const { graph, material } = await importOne({
      sections: [{ mesh: "Mesh", instance: "MI_Rock", graph: maskGraph("M_Master", [{ parameter: "Mask", texture: "/Game/A/Textures/T_Masked.T_Masked" }]) }],
      textures: [
        { folder: "A", pixel: RED },
        { folder: "B", pixel: BLUE },
      ],
    });
    expect(graph?.status).toBe("baked");
    expect(await firstPixel(material.getBaseColorTexture()!.getImage()!)).toEqual(tinted([200, 100, 50]));
  });

  it("refuses a reference to a package the pack lacks, even when a same-named package exists", async () => {
    // The pack's only T_Masked lives in another folder: a reference to a missing package must not take it.
    const { graph, material } = await importOne({
      sections: [{ mesh: "Mesh", instance: "MI_Rock", graph: maskGraph("M_Master", [{ parameter: "Mask", texture: "/Game/Wrong/Textures/T_Masked.T_Masked" }]) }],
      textures: [{ folder: "Other", pixel: RED }],
    });
    expect(graph?.status).toBe("unavailable");
    expect(material.getBaseColorTexture()).toBeNull();
  });

  it("refuses a reference to a missing package even when identical same-named packages exist", async () => {
    const { graph, material } = await importOne({
      sections: [{ mesh: "Mesh", instance: "MI_Rock", graph: maskGraph("M_Master", [{ parameter: "Mask", texture: "/Game/Wrong/Textures/T_Masked.T_Masked" }]) }],
      textures: [
        { folder: "A", pixel: RED },
        { folder: "B", pixel: RED },
      ],
    });
    expect(graph?.status).toBe("unavailable");
    expect(material.getBaseColorTexture()).toBeNull();
  });

  it("selects the named package from standalone exports that keep no package path", async () => {
    const { graph, material } = await importOne({
      sections: [{ mesh: "Mesh", instance: "MI_Rock", graph: maskGraph("M_Master", [{ parameter: "Mask", texture: "/Game/B/Textures/T_Masked.T_Masked" }]) }],
      textures: [
        { folder: "A", pixel: RED },
        { folder: "B", pixel: BLUE },
      ],
      flatOutput: true,
    });
    expect(graph?.status).toBe("baked");
    expect(await firstPixel(material.getBaseColorTexture()!.getImage()!)).toEqual(tinted([10, 220, 30]));
  });

  it("bakes two demanded samples that name the same object through different packages, combining both", async () => {
    const { graph, material } = await importOne({
      sections: [
        {
          mesh: "Mesh",
          instance: "MI_Rock",
          graph: maskGraph("M_Master", [
            { parameter: "Mask", texture: "/Game/A/Textures/T_Masked.T_Masked" },
            { parameter: "Mask2", texture: "/Game/B/Textures/T_Masked.T_Masked" },
          ]),
        },
      ],
      textures: [
        { folder: "A", pixel: RED },
        { folder: "B", pixel: BLUE },
      ],
    });
    expect(graph?.status).toBe("baked");
    // Each package's pixels survive the multiply: A's Mask.RGB times B's, read as stored, re-encoded to sRGB.
    expect(await firstPixel(material.getBaseColorTexture()!.getImage()!)).toEqual([
      encode((200 / 255) * (10 / 255)),
      encode((100 / 255) * (220 / 255)),
      encode((50 / 255) * (30 / 255)),
    ]);
  });

  it("applies an instance override by package, replacing a same-named default from another package", async () => {
    const { graph, material } = await importOne({
      sections: [
        {
          mesh: "Mesh",
          instance: "MI_Rock",
          graph: maskGraph("M_Master", [{ parameter: "Mask", texture: "/Game/A/Textures/T_Masked.T_Masked" }]),
          overrides: [["Mask", "/Game/B/Textures/T_Masked.T_Masked"]],
        },
      ],
      textures: [
        { folder: "A", pixel: RED },
        { folder: "B", pixel: BLUE },
      ],
    });
    expect(graph?.status).toBe("baked");
    expect(await firstPixel(material.getBaseColorTexture()!.getImage()!)).toEqual(tinted([10, 220, 30]));
  });

  it("bakes an instance override that names the same package as its default", async () => {
    // The props file writes the override as `Content/...`, the graph's default as `/Game/...`: one package, one source.
    const { graph, material } = await importOne({
      sections: [
        {
          mesh: "Mesh",
          instance: "MI_Rock",
          graph: maskGraph("M_Master", [{ parameter: "Mask", texture: "/Game/A/Textures/T_Masked.T_Masked" }]),
          overrides: [["Mask", "/Game/A/Textures/T_Masked.T_Masked"]],
        },
      ],
      textures: [
        { folder: "A", pixel: RED },
        { folder: "B", pixel: BLUE },
      ],
    });
    expect(graph?.status).toBe("baked");
    expect(await firstPixel(material.getBaseColorTexture()!.getImage()!)).toEqual(tinted([200, 100, 50]));
  });

  it("bakes an instance override that names a different texture", async () => {
    const { graph, material } = await importOne({
      sections: [
        {
          mesh: "Mesh",
          instance: "MI_Rock",
          graph: maskGraph("M_Master", [{ parameter: "Mask", texture: "/Game/A/Textures/T_Masked.T_Masked" }]),
          overrides: [["Mask", "/Game/B/Textures/T_Other.T_Other"]],
        },
      ],
      textures: [
        { folder: "A", pixel: RED },
        { folder: "B", name: "T_Other", pixel: BLUE },
      ],
    });
    expect(graph?.status).toBe("baked");
    expect(await firstPixel(material.getBaseColorTexture()!.getImage()!)).toEqual(tinted([10, 220, 30]));
  });

  it("bakes each of two graphs from its own package when both name one texture", async () => {
    const sections = await importSections({
      sections: [
        { mesh: "Mesh", instance: "MI_Rock", graph: maskGraph("M_Master", [{ parameter: "Mask", texture: "/Game/A/Textures/T_Masked.T_Masked" }]) },
        { mesh: "MeshB", instance: "MI_Brick", graph: maskGraph("M_Brick", [{ parameter: "Mask", texture: "/Game/B/Textures/T_Masked.T_Masked" }]) },
      ],
      textures: [
        { folder: "A", pixel: RED },
        { folder: "B", pixel: BLUE },
      ],
    });
    expect(sections.map((section) => section.graph?.status)).toEqual(["baked", "baked"]);
    expect(await firstPixel(sections[0]!.material.getBaseColorTexture()!.getImage()!)).toEqual(tinted([200, 100, 50]));
    expect(await firstPixel(sections[1]!.material.getBaseColorTexture()!.getImage()!)).toEqual(tinted([10, 220, 30]));
  });

  it("bakes the active branch when the inactive branch samples a same-named texture from another package", async () => {
    // The evaluator follows the static switch to one branch, so a dormant sample of the other package is never demanded.
    const { graph, material } = await importOne({
      sections: [{ mesh: "Mesh", instance: "MI_Switch", graph: switchGraph("M_Switch", ["/Game/A/Textures/T_Masked.T_Masked", "/Game/B/Textures/T_Masked.T_Masked"], true) }],
      textures: [
        { folder: "A", pixel: RED },
        { folder: "B", pixel: BLUE },
      ],
    });
    expect(graph?.status).toBe("baked");
    expect(await firstPixel(material.getBaseColorTexture()!.getImage()!)).toEqual(tinted([200, 100, 50]));
  });

  it("bakes the same master differently for two instances whose overrides name different packages", async () => {
    // Same master, same object name, different packages: the finished-bake cache must key on the full reference, not the basename.
    const sections = await importSections({
      sections: [
        {
          mesh: "Mesh",
          instance: "MI_A",
          graph: maskGraph("M_Master", [{ parameter: "Mask", texture: "/Game/A/Textures/T_Masked.T_Masked" }]),
          overrides: [["Mask", "/Game/A/Textures/T_Masked.T_Masked"]],
        },
        {
          mesh: "MeshB",
          instance: "MI_B",
          graph: maskGraph("M_Master", [{ parameter: "Mask", texture: "/Game/A/Textures/T_Masked.T_Masked" }]),
          overrides: [["Mask", "/Game/B/Textures/T_Masked.T_Masked"]],
        },
      ],
      textures: [
        { folder: "A", pixel: RED },
        { folder: "B", pixel: BLUE },
      ],
    });
    expect(sections.map((section) => section.graph?.status)).toEqual(["baked", "baked"]);
    expect(await firstPixel(sections[0]!.material.getBaseColorTexture()!.getImage()!)).toEqual(tinted([200, 100, 50]));
    expect(await firstPixel(sections[1]!.material.getBaseColorTexture()!.getImage()!)).toEqual(tinted([10, 220, 30]));
  });
});

describe("a same-named PNG the mesh export carries", () => {
  /**
   * One section whose graph names `reference` for its Mask texture. The mesh export carries `meshPixels` as
   * `T_Masked.png` files; `source` is the one package the pack holds under that name, when there is one.
   */
  async function importWithMeshPng(options: {
    readonly reference: string;
    readonly source?: { readonly folder: string; readonly pixel: readonly number[] } | undefined;
    readonly meshPixels: readonly (readonly number[])[];
  }) {
    const root = await scratch("paragon-mesh-png-");
    const sourceDir = join(root, "source");
    const content = join(sourceDir, "Content", "Test");
    await mkdir(content, { recursive: true });
    for (const name of ["Mesh", "MI_Rock", "M_Master"]) await writeFile(join(content, `${name}.uasset`), Buffer.alloc(16));
    const exported = join(root, "exported");
    await writeMeshFixture(exported, { name: "Mesh", materialName: "MI_Rock", mat: "", props: instanceProps("M_Master"), textures: [] });
    for (const [index, pixel] of options.meshPixels.entries()) {
      const directory = join(exported, `Wrong${index}`);
      await mkdir(directory, { recursive: true });
      await writePng(join(directory, "T_Masked.png"), pixel, 4);
    }
    const packages: Record<string, FakePackage> = { "Content/Test/Mesh": { kind: "StaticMesh", from: exported } };
    const onlyPackages = ["Mesh"];
    if (options.source) {
      const directory = join(sourceDir, "Content", options.source.folder, "Textures");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "T_Masked.uasset"), Buffer.alloc(16));
      const png = join(root, "source-T_Masked.png");
      await writePng(png, options.source.pixel, 4);
      packages[`Content/${options.source.folder}/Textures/T_Masked`] = { kind: "Texture2D", png };
      onlyPackages.push("T_Masked");
    }
    const umodel = join(root, "umodel");
    await writeFakeUmodel(umodel, { packages, flat: false });
    const converter = join(root, "converter");
    await writeFakeConverter(converter, [maskGraph("M_Master", [{ parameter: "Mask", texture: options.reference }])]);
    const outputDir = join(root, "output");
    const report = await importUnrealDirectory({
      sourceDir,
      outputDir,
      onlyPackages,
      concurrency: 1,
      freeSpaceBytes: 30_000_000_000,
      umodel: { name: "umodel", path: umodel, version: "fixture" },
      modernConverter: { name: "modern", path: converter, version: "fake-converter 1" },
    });
    const model = report.models.find((entry) => entry.name === "Mesh")!;
    const glb = await new NodeIO().read(join(outputDir, model.glb));
    return { graph: model.materials[0]?.graph, material: glb.getRoot().listMaterials()[0]! };
  }

  it("does not let a unique wrong basename PNG in the mesh export override the exact package exporter", async () => {
    const { graph, material } = await importWithMeshPng({
      reference: "/Game/A/Textures/T_Masked.T_Masked",
      source: { folder: "A", pixel: RED },
      meshPixels: [BLUE],
    });
    expect(graph?.status).toBe("baked");
    expect(await firstPixel(material.getBaseColorTexture()!.getImage()!)).toEqual(tinted([200, 100, 50]));
  });

  it("refuses a qualified reference the exporter cannot source, despite a unique same-named PNG in the mesh export", async () => {
    const { graph, material } = await importWithMeshPng({
      reference: "/Game/Wrong/Textures/T_Masked.T_Masked",
      meshPixels: [BLUE],
    });
    expect(graph?.status).toBe("unavailable");
    expect(material.getBaseColorTexture()).toBeNull();
  });

  it("refuses when the mesh export alone carries differing same-named PNGs and no source package is named", async () => {
    const { graph, material } = await importWithMeshPng({
      reference: "/Game/Wrong/Textures/T_Masked.T_Masked",
      meshPixels: [RED, BLUE],
    });
    expect(graph?.status).toBe("unavailable");
    expect(material.getBaseColorTexture()).toBeNull();
  });
});

describe("a source root that wraps the project's Content (Fab staging download)", () => {
  it("resolves a qualified reference when the root wraps one project", async () => {
    // `source/ParagonProps/Content/...`: `Content` is not the root, so a strict <root>/Content check found nothing.
    const { graph, material } = await importOne({
      sections: [{ mesh: "Mesh", instance: "MI_Rock", graph: maskGraph("M_Master", [{ parameter: "Mask", texture: "/Game/A/Textures/T_Masked.T_Masked" }]) }],
      textures: [{ folder: "A", pixel: RED }],
      mount: "ParagonProps",
    });
    expect(graph?.status).toBe("baked");
    expect(await firstPixel(material.getBaseColorTexture()!.getImage()!)).toEqual(tinted([200, 100, 50]));
  });

  it("refuses a qualified reference when the root wraps several Game mounts", async () => {
    // Two projects each mount their Content at /Game, so `/Game/A/Textures/T_Masked` names either, not both.
    const { graph, material } = await importOne({
      sections: [{ mesh: "Mesh", instance: "MI_Rock", graph: maskGraph("M_Master", [{ parameter: "Mask", texture: "/Game/A/Textures/T_Masked.T_Masked" }]) }],
      textures: [
        { folder: "A", pixel: RED, mount: "ProjectA" },
        { folder: "A", pixel: BLUE, mount: "ProjectB" },
      ],
      mount: "ProjectA",
    });
    expect(graph?.status).toBe("unavailable");
    expect(material.getBaseColorTexture()).toBeNull();
  });
});

describe("a source package outside the project's Content mount", () => {
  it("refuses an exact /Game reference that only an off-mount namesake shares a basename with", async () => {
    // The pack's only `T_Masked` sits at `<root>/Derived/A/Textures`, not under `Content`. `Derived/A/Textures`
    // sliced against the `Content` mount would fall through to `A/Textures`, inventing the package `/Game/A/Textures`
    // the reference names; the exact lookup must refuse instead.
    const root = await scratch("paragon-off-mount-");
    const sourceDir = join(root, "source");
    const content = join(sourceDir, "Content", "Test");
    await mkdir(content, { recursive: true });
    for (const name of ["Mesh", "MI_Rock", "M_Master"]) await writeFile(join(content, `${name}.uasset`), Buffer.alloc(16));
    const exported = join(root, "exported");
    await writeMeshFixture(exported, { name: "Mesh", materialName: "MI_Rock", mat: "", props: instanceProps("M_Master"), textures: [] });
    const derived = join(sourceDir, "Derived", "A", "Textures");
    await mkdir(derived, { recursive: true });
    await writeFile(join(derived, "T_Masked.uasset"), Buffer.alloc(16));
    const png = join(root, "derived-T_Masked.png");
    await writePng(png, RED, 4);
    const packages: Record<string, FakePackage> = {
      "Content/Test/Mesh": { kind: "StaticMesh", from: exported },
      "Derived/A/Textures/T_Masked": { kind: "Texture2D", png },
    };
    const umodel = join(root, "umodel");
    await writeFakeUmodel(umodel, { packages, flat: false });
    const converter = join(root, "converter");
    await writeFakeConverter(converter, [maskGraph("M_Master", [{ parameter: "Mask", texture: "/Game/A/Textures/T_Masked.T_Masked" }])]);
    const outputDir = join(root, "output");
    const report = await importUnrealDirectory({
      sourceDir,
      outputDir,
      onlyPackages: ["Mesh", "T_Masked"],
      concurrency: 1,
      freeSpaceBytes: 30_000_000_000,
      umodel: { name: "umodel", path: umodel, version: "fixture" },
      modernConverter: { name: "modern", path: converter, version: "fake-converter 1" },
    });
    const model = report.models.find((entry) => entry.name === "Mesh")!;
    const glb = await new NodeIO().read(join(outputDir, model.glb));
    const material = glb.getRoot().listMaterials()[0]!;
    expect(model.materials[0]?.graph?.status).toBe("unavailable");
    expect(material.getBaseColorTexture()).toBeNull();
  });
});

describe("graph texture metadata comes from the selected package, never a namesake", () => {
  it("decodes each same-named package with its own SRGB, including a wrong-basename props file", async () => {
    // Two packages of `T_Masked` hold the very same PNG bytes but different SRGB flags; the mesh export carries a
    // wrong-basename `T_Masked.props.txt` (A's SRGB=false). Each graph must follow the flag of the package it names.
    const sections = await importSections({
      sections: [
        { mesh: "Mesh", instance: "MI_A", graph: colorGraph("M_ColorA", "/Game/A/Textures/T_Masked.T_Masked") },
        { mesh: "MeshB", instance: "MI_B", graph: colorGraph("M_ColorB", "/Game/B/Textures/T_Masked.T_Masked") },
      ],
      textures: [
        { folder: "A", pixel: RED, srgb: false },
        { folder: "B", pixel: RED, srgb: true },
      ],
      meshProps: [["T_Masked", "SRGB = false\n"]],
    });
    expect(sections.map((section) => section.graph?.status)).toEqual(["baked", "baked"]);
    // A stores raw (SRGB=false), so its bytes are re-encoded; B is sRGB, so its bytes round-trip unchanged.
    expect(await firstPixel(sections[0]!.material.getBaseColorTexture()!.getImage()!)).toEqual([encode(200 / 255), encode(100 / 255), encode(50 / 255)]);
    expect(await firstPixel(sections[1]!.material.getBaseColorTexture()!.getImage()!)).toEqual([200, 100, 50]);
    expect(sections[0]!.graph?.confidence).toBe("exact");
    expect(sections[1]!.graph?.confidence).toBe("exact");
  });
});
