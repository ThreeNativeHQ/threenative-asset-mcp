import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { describe, expect, it, onTestFinished } from "vitest";

import { createGraphBaker } from "../src/unreal/graph-baker.js";
import { parsePropsFile, resolveMaterial } from "../src/unreal/materials.js";
import { materialGraphSchema, type MaterialGraph } from "../src/unreal/graph-dump.js";
import { importUnrealDirectory } from "../src/unreal/importer.js";
import type { ImportedMaterialSection, ImportReport } from "../src/unreal/importer.js";
import { scorePack } from "../src/unreal/parity.js";
import type { PropertyDump } from "../src/unreal/property-dump.js";
import { readBuildScale3D } from "../src/unreal/mesh-build-scale.js";
import { writeFakeUmodel, writeMeshFixture, writePng } from "./helpers/unreal-fixture.js";
import { NodeIO } from "@gltf-transform/core";

async function scratch(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

type Raw = Record<string, unknown>;
const pin = (node: string, mask: number[] | null = null) => ({ node, output: 0, mask });
const node = (id: string, cls: string, extra: Raw = {}): Raw => ({ id, class: cls, inputs: {}, constants: {}, ...extra });

// ---------------------------------------------------------------------------------------------------------
// PRD-537 Palms Pack 02: M_Trees_PP2 carries several texture parameters for the same output behind
// StaticSwitchParameters. The instance chain stores no static-switch overrides, so the default
// ("True = Leaves") takes the `Color` sampler, which no bark instance binds.

function treeMaster(): MaterialGraph {
  const nodes: Raw[] = [
    node("leaves", "TextureSampleParameter2D", { parameter: { name: "Color", group: "" }, default: null, texture: null, samplerType: "Color" }),
    node("bark", "TextureSampleParameter2D", { parameter: { name: "Bark_Color_Tex", group: "" }, default: null, texture: null, samplerType: "Color" }),
    node("tint", "Constant3Vector", { constants: { Constant: [1, 1, 1, 1] } }),
    node("leavesTint", "Multiply", { inputs: { A: pin("leaves", [1, 1, 1, 0]), B: pin("tint") } }),
    node("barkTint", "Multiply", { inputs: { A: pin("bark", [1, 1, 1, 0]), B: pin("tint") } }),
    node("switch", "StaticSwitchParameter", {
      parameter: { name: "True = Leaves, False = Bark or Fronds", group: "" },
      default: true,
      switchValue: true,
      inputs: { A: pin("leavesTint"), B: pin("barkTint") },
    }),
  ];
  return materialGraphSchema.parse({
    format: 1,
    material: "M_Trees",
    package: "/Game/Test/M_Trees",
    truncated: false,
    nodeCount: nodes.length,
    outputs: { baseColor: pin("switch"), roughness: null, metallic: null, emissive: null, opacity: null, opacityMask: null, normal: null, materialAttributes: null },
    nodes,
  });
}

const collected = (parent: string | undefined, entries: [string, string][]): string =>
  [
    ...(parent ? [`Parent = Material'${parent}.${parent}'`] : []),
    `CollectedTextureParameters[${entries.length}] =`,
    "{",
    ...entries.flatMap(([name, texture], index) => [
      `    CollectedTextureParameters[${index}] =`,
      "    {",
      `        Texture = Texture2D'/Game/Test/${texture}.${texture}'`,
      `        Name = ${name}`,
      "        Group = None",
      "    }",
    ]),
    "}",
  ].join("\n");

async function treeFixture(instance: [string, string][]) {
  const root = await scratch("palms-bake-");
  const sourceDir = join(root, "source", "Content", "Test");
  await mkdir(sourceDir, { recursive: true });
  for (const name of ["MI_Bark", "M_Trees"]) await writeFile(join(sourceDir, `${name}.uasset`), Buffer.alloc(16));
  await writePng(join(root, "T_Bark.png"), [200, 100, 50, 255], 4);
  await writePng(join(root, "T_Leaf.png"), [10, 220, 10, 255], 4);
  const assets = { png: new Map([["T_Bark", join(root, "T_Bark.png")], ["T_Leaf", join(root, "T_Leaf.png")]]) };
  const props: Record<string, string> = { MI_Bark: collected("M_Trees", instance) };
  return { sourceDir: join(root, "source"), assets, readProps: (name: string) => props[name] };
}

async function firstPixel(png: Buffer | Uint8Array): Promise<number[]> {
  const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return [...data.subarray(0, 3)];
}

describe("static switches the instance chain does not override (PRD-537 Palms Pack 02)", () => {
  const baker = (sourceDir: string) =>
    createGraphBaker({ sourceDir, maxTextureSize: 8, dumpGraphs: async () => new Map([["M_Trees", treeMaster()]]) })!;

  it("takes the branch whose texture parameters the instance binds when the default branch samples an unbound one", async () => {
    const { sourceDir, assets, readProps } = await treeFixture([["Bark_Color_Tex", "T_Bark"]]);
    const outcome = await baker(sourceDir)({ materialName: "MI_Bark_section", lookupName: "MI_Bark", assets, readProps });
    if (outcome.status !== "baked") throw new Error(`expected a bake, got ${JSON.stringify(outcome)}`);
    expect(outcome.texturesUsed).toEqual(["T_Bark"]);
    expect(await firstPixel(outcome.png)).toEqual([200, 100, 50]);
    // Never exact: the flipped switch is a guess made from which textures the instance binds.
    expect(outcome.confidence).toBe("heuristic");
    expect(outcome.approximations.join(" ")).toContain('static switch "True = Leaves, False = Bark or Fronds" taken as false');
  });

  it("keeps the default branch when the instance binds its textures", async () => {
    const { sourceDir, assets, readProps } = await treeFixture([["Color", "T_Leaf"], ["Bark_Color_Tex", "T_Bark"]]);
    const outcome = await baker(sourceDir)({ materialName: "MI_Bark_section", lookupName: "MI_Bark", assets, readProps });
    if (outcome.status !== "baked") throw new Error(`expected a bake, got ${JSON.stringify(outcome)}`);
    expect(outcome.texturesUsed).toEqual(["T_Leaf"]);
    expect(outcome.approximations.join(" ")).not.toContain("taken as");
  });

  it("stays unavailable, naming the unbound parameter, when neither branch is bound", async () => {
    const { sourceDir, assets, readProps } = await treeFixture([]);
    const outcome = await baker(sourceDir)({ materialName: "MI_Bark_section", lookupName: "MI_Bark", assets, readProps });
    expect(outcome.status).toBe("unavailable");
    expect(outcome.status === "unavailable" && outcome.reason).toContain('parameter "Color") has no texture');
  });
});

// ---------------------------------------------------------------------------------------------------------
// PRD-537 Paragon Dusk_Spire_Back: MI_Generic_Metal sets Baked_Normal to an engine texture, which UE Viewer prints as
// `None`, over its parent's T_EvilGate_Piece1_N. UE Viewer still wrote the old default into the leaf's .mat.

describe("an override that points outside the pack supersedes the ancestor default (Paragon MI_Generic_Metal)", () => {
  const instance = (parent: string, entries: [string, string | "None"][]): string =>
    [
      `Parent = MaterialInstanceConstant'Content/Pack/Materials/${parent}.${parent}'`,
      `TextureParameterValues[${entries.length}] =`,
      "{",
      ...entries.flatMap(([name, texture], index) => [
        `    TextureParameterValues[${index}] =`,
        "    {",
        `        ParameterInfo = { Name=${name} }`,
        `        ParameterValue = ${texture === "None" ? "None" : `Texture2D'Content/Pack/Textures/${texture}.${texture}'`}`,
        "        ParameterName = None",
        "    }",
      ]),
      "}",
    ].join("\n");
  const files: Record<string, { mat?: string; props: string }> = {
    MI_Generic_Metal: {
      mat: "Normal=T_EvilGate_Piece1_N\nOther[0]=T_EvilGate_Piece1_M\n",
      props: instance("MI_EvilGate_Piece_1", [["Baked AO/Roughness/Metalness", "None"], ["Baked_Normal", "None"]]),
    },
    MI_EvilGate_Piece_1: {
      props: instance("Referecnce_DarkSide", [["Baked AO/Roughness/Metalness", "T_EvilGate_Piece1_M"], ["Baked_Normal", "T_EvilGate_Piece1_N"]]),
    },
  };
  const available = new Set(["T_EvilGate_Piece1_N", "T_EvilGate_Piece1_M"]);
  const read = (name: string) => ({ name, readMat: (m: string) => files[m]?.mat, readProps: (m: string) => files[m]?.props, availableTextures: available });

  it("parses a None value as an unresolved override, not as a missing entry", () => {
    const props = parsePropsFile(files.MI_Generic_Metal!.props);
    expect(props.overrides).toEqual([]);
    expect(props.unresolvedOverrides).toEqual(["Baked AO/Roughness/Metalness", "Baked_Normal"]);
  });

  it("does not bind the parent's normal map that the leaf replaced", () => {
    const resolved = resolveMaterial(read("MI_Generic_Metal"));
    expect(resolved.bindings.map((binding) => binding.texture)).not.toContain("T_EvilGate_Piece1_N");
    expect(resolved.limitations.join("\n")).toContain("T_EvilGate_Piece1_N is the parent default of \"Baked_Normal\", overridden by an engine texture outside the pack");
  });

  it("still binds the parent's textures for the parent itself", () => {
    const resolved = resolveMaterial(read("MI_EvilGate_Piece_1"));
    expect(resolved.bindings.map((binding) => binding.texture)).toContain("T_EvilGate_Piece1_N");
  });
});

// ---------------------------------------------------------------------------------------------------------
// PRD-537 Paragon SM_Agelsjon02_Cliff: UE Viewer exports the raw source mesh, which Unreal multiplies by the
// source model's BuildScale3D (8, 8, 8 here) when it builds the render data. The GLB came out 8x too small.

/** A UE4.19-shaped package: a real summary up to the name table, then one StaticMesh-like tagged property block. */
function buildPackage(scales: readonly (readonly [number, number, number])[], options: { hasGuid?: boolean; withProperty?: boolean } = {}): Buffer {
  const names = ["None", "StaticMesh", "BuildSettings", "BuildScale3D", "StructProperty", "Vector", "bUseHighPrecisionTangentBasis"];
  const fstring = (text: string): Buffer => {
    const raw = Buffer.from(`${text}\0`, "utf8");
    const length = Buffer.alloc(4);
    length.writeInt32LE(raw.length);
    return Buffer.concat([length, raw]);
  };
  const folder = fstring("/Game/Test");
  const i32 = (value: number): Buffer => {
    const out = Buffer.alloc(4);
    out.writeInt32LE(value);
    return out;
  };
  const summaryLength = 4 + 4 + 4 + 4 + 4 + 4 /* custom versions */ + 4 /* header size */ + folder.length + 4 /* flags */ + 4 + 4;
  const table = Buffer.concat(names.flatMap((name) => [fstring(name), Buffer.alloc(4)]));
  const header = Buffer.concat([
    i32(0x9e2a83c1 | 0), i32(-7), i32(864), i32(516), i32(0), i32(0), i32(summaryLength + table.length), folder, i32(0), i32(names.length), i32(summaryLength),
  ]);
  const name = (text: string): Buffer => Buffer.concat([i32(names.indexOf(text)), i32(0)]);
  const tags = scales.map((scale) =>
    Buffer.concat([
      name("BuildScale3D"), name("StructProperty"), i32(12), i32(0), name("Vector"), Buffer.alloc(16), Buffer.from([options.hasGuid ? 1 : 0]),
      ...(options.hasGuid ? [Buffer.alloc(16, 7)] : []),
      ...scale.map((component) => { const out = Buffer.alloc(4); out.writeFloatLE(component); return out; }),
    ]),
  );
  return Buffer.concat([header, table, ...(options.withProperty === false ? [] : tags)]);
}

describe("BuildScale3D of an uncooked UE4 StaticMesh", () => {
  it("reads the first source model's scale", () => {
    expect(readBuildScale3D(buildPackage([[8, 8, 8], [1, 1, 1]]))).toEqual([8, 8, 8]);
    expect(readBuildScale3D(buildPackage([[2, 3, 4]], { hasGuid: true }))).toEqual([2, 3, 4]);
  });

  it("is undefined when the package has no such property, or is not a UE4 legacy -7 package", () => {
    expect(readBuildScale3D(buildPackage([], { withProperty: false }))).toBeUndefined();
    const ue5 = buildPackage([[8, 8, 8]]);
    ue5.writeInt32LE(-8, 4);
    expect(readBuildScale3D(ue5)).toBeUndefined();
    expect(readBuildScale3D(Buffer.alloc(8))).toBeUndefined();
  });

  it("does not take a non-positive or non-finite scale", () => {
    expect(readBuildScale3D(buildPackage([[0, 1, 1]]))).toBeUndefined();
    expect(readBuildScale3D(buildPackage([[Number.NaN, 1, 1]]))).toBeUndefined();
  });

  async function importMesh(scale: readonly [number, number, number]) {
    const root = await scratch("build-scale-import-");
    const sourceDir = join(root, "source");
    const content = join(sourceDir, "Content", "Test");
    const exported = join(root, "exported");
    await mkdir(content, { recursive: true });
    await writeFile(join(content, "Mesh.uasset"), buildPackage([scale]));
    await writeMeshFixture(exported, { name: "Mesh", materialName: "M_Plain", mat: "", props: "", textures: [] });
    const umodel = join(root, "umodel");
    await writeFakeUmodel(umodel, { exportFrom: exported, classes: { Mesh: ["StaticMesh"] } });
    const report = await importUnrealDirectory({
      sourceDir,
      outputDir: join(root, "output"),
      onlyPackages: ["Mesh"],
      concurrency: 1,
      freeSpaceBytes: 30_000_000_000,
      graphBake: false,
      environment: { ...process.env, THREENATIVE_UNREAL_CACHE_DIR: join(root, "cache") },
      umodel: { name: "umodel", path: umodel, version: "fixture" },
    });
    const glb = await new NodeIO().read(join(root, "output", report.models[0]!.glb));
    const position = glb.getRoot().listMeshes()[0]!.listPrimitives()[0]!.getAttribute("POSITION")!;
    return { report, max: position.getMax([0, 0, 0]) };
  }

  it("scales the exported geometry by it and says so", async () => {
    // The fixture triangle spans 1 x 2 x 0 in glTF axes (UE x, z, y).
    const { report, max } = await importMesh([8, 8, 8]);
    expect(max).toEqual([8, 16, 0]);
    expect(report.models[0]!.boundsMetres).toEqual([8, 16, 0]);
    expect(report.warnings.join("\n")).toContain("BuildScale3D (8, 8, 8)");
  });

  it("maps a non-uniform scale from Unreal's axes onto glTF's", async () => {
    // UE (x, y, z) = (2, 3, 5) -> glTF x * 2, y (up = UE z) * 5, z (= -UE y) * 3.
    const { max, report } = await importMesh([2, 3, 5]);
    expect(max).toEqual([2, 10, 0]);
    expect(report.warnings.join("\n")).toContain("non-uniform");
  });

  it("leaves a mesh without the property exactly as exported", async () => {
    const { max, report } = await importMesh([1, 1, 1]);
    expect(max).toEqual([1, 2, 0]);
    expect(report.warnings.join("\n")).not.toContain("BuildScale3D");
  });
});

// ---------------------------------------------------------------------------------------------------------
// PRD-537 Paragon SternInhibitor2: two slots (Center, and Ring with no material) came out of UE Viewer as 59 sections,
// the 29 unresolved ones each with a `dummy_material_<section>` of their own.

describe("slot count with unresolved sections", () => {
  const section = (name: string, resolved: boolean): ImportedMaterialSection =>
    ({ name, resolved, bindings: [], unsupported: [], limitations: [], textured: false, sidecarTextures: [] }) as unknown as ImportedMaterialSection;
  const score = (sections: ImportedMaterialSection[]) => {
    const dump: PropertyDump = {
      format: 1,
      game: "GAME_UE4_19",
      packages: [
        {
          path: "/Game/P/SternInhibitor2",
          exports: [
            {
              name: "SternInhibitor2",
              class: "StaticMesh",
              slots: [{ name: "Center", material: "/Game/P/MI_Center.MI_Center" }, { name: "Ring", material: null }],
              bounds: null,
            },
          ],
        },
      ],
    };
    const model = { name: "SternInhibitor2", package: "Content/P/SternInhibitor2.uasset", kind: "static", glb: "x.glb", bytes: 1, sha256: "x", vertices: 1, primitives: sections.length, skins: 0, joints: 0, morphTargets: 0, animations: 0, boundsMetres: [1, 1, 1], materials: sections };
    return scorePack(dump, { models: [model], failed: [], skipped: [] } as unknown as ImportReport).shape;
  };

  it("counts every unresolved section as the one slot they stand for", () => {
    const sections = [section("MI_Center", true), ...Array.from({ length: 29 }, (_, index) => section(`SternInhibitor2_unresolved_section_${index * 2 + 1}`, false))];
    expect(score(sections).violations).toEqual([]);
  });

  it("still flags more resolved materials than the mesh has slots", () => {
    const shape = score([section("MI_A", true), section("MI_B", true), section("MI_C", true)]);
    expect(shape.violations).toContainEqual({ kind: "slot-count", model: "SternInhibitor2", expected: 2, actual: 3 });
  });

  it("flags a resolved material plus unresolved sections once they exceed the slots", () => {
    const shape = score([section("MI_A", true), section("MI_B", true), section("S_unresolved_section_1", false)]);
    expect(shape.violations).toContainEqual({ kind: "slot-count", model: "SternInhibitor2", expected: 2, actual: 3 });
  });
});
