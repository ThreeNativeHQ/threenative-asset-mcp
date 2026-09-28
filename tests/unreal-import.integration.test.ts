import { chmod, mkdir, mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Document, NodeIO } from "@gltf-transform/core";
import { EXTMeshGPUInstancing, KHRLightsPunctual, type InstancedMesh } from "@gltf-transform/extensions";
import { afterEach, describe, expect, it } from "vitest";

import {
  packsRoughnessInAlpha,
  parseMatFile,
  parsePropsFile,
  resolveMaterial,
} from "../src/unreal/materials.js";
import {
  applyTextureTransform,
  assertContained,
  classifyAlbedo,
  hashSourceTree,
  ImportError,
  importUnrealDirectory,
  interleavedBufferViews,
  inspectWebAudio,
  parseUmodelList,
  summarizeClasses,
  uncookedMeshRoute,
  validateGlb,
} from "../src/unreal/importer.js";
import { childEnvironment, resolveExecutable, ToolchainError } from "../src/unreal/toolchain.js";
import { patchUncookedPackageVersionGates, UEVIEWER_SOURCE } from "../src/unreal/provision.js";
import { runImportCli } from "../src/cli.js";
import { writeFakeUmodel, writeMeshFixture, writePng, writePsaFixture, writeWavFixture } from "./helpers/unreal-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(prefix = "asset-mcp-unreal-"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeSkinnedGlb(
  path: string,
  name: string,
  options: { readonly vertices?: number; readonly joints?: number; readonly morphs?: readonly string[] } = {},
): Promise<void> {
  const vertexCount = options.vertices ?? 3;
  const jointCount = options.joints ?? 1;
  const document = new Document();
  const buffer = document.createBuffer();
  const positions = new Float32Array(vertexCount * 3);
  for (let index = 0; index < vertexCount; index += 1) positions[index * 3] = index;
  const primitive = document
    .createPrimitive()
    .setAttribute(
      "POSITION",
      document.createAccessor("POSITION").setType("VEC3").setArray(positions).setBuffer(buffer),
    )
    .setAttribute(
      "JOINTS_0",
      document
        .createAccessor("JOINTS_0")
        .setType("VEC4")
        .setArray(new Uint16Array(vertexCount * 4))
        .setBuffer(buffer),
    )
    .setAttribute(
      "WEIGHTS_0",
      document
        .createAccessor("WEIGHTS_0")
        .setType("VEC4")
        .setArray(new Float32Array(vertexCount * 4).fill(0.25))
        .setBuffer(buffer),
    );
  for (const morph of options.morphs ?? []) {
    primitive.addTarget(
      document
        .createPrimitiveTarget(`target_${morph}`)
        .setAttribute(
          "POSITION",
          document
            .createAccessor(`target_${morph}`)
            .setType("VEC3")
            .setArray(new Float32Array(vertexCount * 3).fill(0.5))
            .setBuffer(buffer),
        ),
    );
  }
  if (options.morphs) primitive.setExtras({ targetNames: [...options.morphs] });
  primitive.setMaterial(document.createMaterial("M_Rock"));
  const mesh = document.createMesh(name).addPrimitive(primitive);
  const joints = Array.from({ length: jointCount }, (_, index) =>
    document.createNode(index === 0 ? "root" : `joint_${index}`),
  );
  const inverseBindMatrices = document
    .createAccessor("InverseBindMatrices")
    .setType("MAT4")
    .setArray(new Float32Array(jointCount * 16).fill(0).map((_, index) => (index % 5 === 0 ? 1 : 0)))
    .setBuffer(buffer);
  const skin = document
    .createSkin("Skeleton")
    .setSkeleton(joints[0]!)
    .setInverseBindMatrices(inverseBindMatrices);
  for (const joint of joints) skin.addJoint(joint);
  document
    .createScene()
    .addChild(joints[0]!)
    .addChild(document.createNode(name).setMesh(mesh).setSkin(skin));
  await new NodeIO().write(path, document);
}

/** A package header UE Viewer cannot read, so only the modern converter can classify it. */
async function writeEditorSkeletalMesh(sourceDir: string, name: string): Promise<void> {
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0x9e2a83c1, 0);
  header.writeInt32LE(-8, 4);
  header.writeInt32LE(864, 8);
  header.writeInt32LE(522, 12);
  header.writeInt32LE(1009, 16);
  await writeFile(
    join(sourceDir, `${name}.uasset`),
    Buffer.concat([
      header,
      Buffer.from("AssetImportData\0SkeletalMesh\0SkeletalMeshEditorData\0MeshEditorDataObject\0"),
    ]),
  );
}

/** A stand-in for the real converter: the same --export-dir contract, driven by `body`. */
async function writeModernConverter(
  sourceDir: string,
  name: string,
  body: readonly string[],
): Promise<string> {
  const converter = join(sourceDir, "..", name);
  await writeFile(
    converter,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const at = process.argv.indexOf("--export-dir");',
      "const out = process.argv[at + 1];",
      'fs.mkdirSync(path.join(out, "Meshes"), { recursive: true });',
      ...body,
      "",
    ].join("\n"),
  );
  await chmod(converter, 0o755);
  return converter;
}

const ROCK_MAT = `Diffuse=T_Rock_D_R
Normal=T_Rock_N
Other[0]=T_Rock_Extra
`;
const ROCK_PROPS = `TwoSided = false
BlendMode = BLEND_Opaque (0)
OpacityMaskClipValue = 0.333
`;


const FOLIAGE_MAT = `Normal=T_Leaf_N
SpecPower=T_Leaf_S
Other[0]=T_Leaf_Atlas
`;

const FOLIAGE_PROPS = `TwoSided = true
BlendMode = BLEND_Masked (1)
OpacityMaskClipValue = 0.4
CollectedTextureParameters[2] =
{
    CollectedTextureParameters[0] =
    {
        Texture = Texture2D'Content/Game/T_Leaf_Atlas.T_Leaf_Atlas'
        Name = Diffuse
        Group = None
    }
    CollectedTextureParameters[1] =
    {
        Texture = Texture2D'Content/Game/T_Leaf_N.T_Leaf_N'
        Name = Normal
        Group = None
    }
}
`;

/** Builds a source tree the fake umodel reports on, plus the artifacts it "exports". */
async function unrealWorkspace(options: {
  readonly mat?: string;
  readonly props?: string;
  readonly textures?: readonly string[];
  readonly degenerateTangents?: boolean;
  readonly classes?: Readonly<Record<string, readonly string[]>>;
  readonly listExitCode?: number;
  readonly exportExitCode?: number;
  readonly corruptBuffer?: boolean;
  readonly argvLog?: string;
  readonly emptyExports?: readonly string[];
} = {}): Promise<{
  sourceDir: string;
  outputDir: string;
  umodel: string;
  environment: NodeJS.ProcessEnv;
}> {
  const root = await temporaryDirectory();
  const sourceDir = join(root, "pack", "Content", "Game");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(join(sourceDir, "SM_Rock.uasset"), "not really an unreal package");
  await writeFile(join(sourceDir, "Showcase.umap"), "level");
  await writeFile(join(sourceDir, "BP_Spawner.uasset"), "blueprint");

  const exported = join(root, "exported");
  await writeMeshFixture(exported, {
    name: "SM_Rock",
    materialName: "M_Rock",
    mat: options.mat ?? ROCK_MAT,
    props: options.props ?? ROCK_PROPS,
    textures: options.textures ?? ["T_Rock_D_R", "T_Rock_N", "T_Rock_Extra"],
    ...(options.degenerateTangents === undefined
      ? {}
      : { degenerateTangents: options.degenerateTangents }),
  });

  const umodel = join(root, "umodel");
  await writeFakeUmodel(umodel, {
    exportFrom: exported,
    classes: options.classes ?? {
      SM_Rock: ["StaticMesh", "BodySetup"],
      BP_Spawner: ["Blueprint"],
    },
    outputSubdirectory: "Game",
    ...(options.listExitCode === undefined ? {} : { listExitCode: options.listExitCode }),
    ...(options.exportExitCode === undefined ? {} : { exportExitCode: options.exportExitCode }),
    ...(options.corruptBuffer === undefined ? {} : { corruptBuffer: options.corruptBuffer }),
    ...(options.argvLog === undefined ? {} : { argvLog: options.argvLog }),
    ...(options.emptyExports === undefined ? {} : { emptyExports: options.emptyExports }),
  });

  return {
    sourceDir: join(root, "pack"),
    outputDir: join(root, "game", "assets", "fab", "pack"),
    umodel,
    environment: {
      ...process.env,
      THREENATIVE_UMODEL_PATH: umodel,
      THREENATIVE_UNREAL_CACHE_DIR: join(root, "cache"),
      THREENATIVE_TOOLCHAIN_AUTOINSTALL: "0",
    },
  };
}

/** A modern UE5 converter that fails the way a real one does: several stderr lines, then exit 1. */
async function writeFailingModernConverter(workspace: { sourceDir: string }): Promise<string> {
  const converter = join(workspace.sourceDir, "..", "failing-modern-converter");
  await writeFile(
    converter,
    `#!/usr/bin/env node
process.stderr.write([
  "ThreeNativeConverter 0.2.1",
  "loading /Content/Game/SM_Rock.uasset",
  "warning: FStaticMeshRenderData is absent from the package",
  "loaded export types: UBodySetup, UObject, UStaticMesh",
  "fatal: no geometry to write",
  "",
].join("\\n"));
process.exit(1);
`,
  );
  await chmod(converter, 0o755);
  return converter;
}

describe("UE Viewer material metadata", () => {
  it("reads the named slots and leaves everything else as Other", () => {
    const parsed = parseMatFile(ROCK_MAT);
    expect(parsed.slots.get("Diffuse")).toBe("T_Rock_D_R");
    expect(parsed.slots.get("Normal")).toBe("T_Rock_N");
    expect(parsed.others).toEqual(["T_Rock_Extra"]);
  });

  it("reads blend mode, cutoff, sidedness, and the material's own parameter names", () => {
    const parsed = parsePropsFile(FOLIAGE_PROPS);
    expect(parsed.twoSided).toBe(true);
    expect(parsed.blendMode).toBe("BLEND_Masked");
    expect(parsed.opacityMaskClipValue).toBeCloseTo(0.4);
    expect(parsed.collected).toEqual([
      { name: "Diffuse", texture: "T_Leaf_Atlas" },
      { name: "Normal", texture: "T_Leaf_N" },
    ]);
  });

  it("reads a material instance's own texture overrides and its parent", () => {
    const parsed = parsePropsFile(`Parent = Material3'Content/Game/M_Master.M_Master'
TextureParameterValues[2] =
{
    TextureParameterValues[0] =
    {
        ParameterInfo = { Name=None }
        ParameterValue = Texture2D'Content/Game/T_Pillar_N.T_Pillar_N'
        ParameterName = NRM
    }
    TextureParameterValues[1] =
    {
        ParameterInfo = { Name=None }
        ParameterValue = Texture2D'Content/Game/T_Pillar_M.T_Pillar_M'
        ParameterName = Mask
    }
}
`);
    expect(parsed.parent).toBe("M_Master");
    expect(parsed.overrides).toEqual([
      { name: "NRM", texture: "T_Pillar_N" },
      { name: "Mask", texture: "T_Pillar_M" },
    ]);
  });

  it("reads inline and nested scalar/vector PBR parameters", () => {
    const parsed = parsePropsFile(`CollectedScalarParameters[1] =
{
  CollectedScalarParameters[0] = { Value=0.8, Name=Roughness, Group=None }
}
ScalarParameterValues[0] =
{
  ParameterInfo = { Name=Metallic }
  ParameterValue = 0.65
}
CollectedVectorParameters[0] = { Value={ R=0.1, G=0.2, B=0.3, A=1 }, Name=Emissive }
VectorParameterValues[0] =
{
  ParameterInfo = { Name=Base Color }
  ParameterValue = { R=0.25, G=0.5, B=0.75, A=0.9 }
}
`);
    expect(parsed.scalars).toEqual([{ name: "Roughness", value: 0.8 }]);
    expect(parsed.scalarOverrides).toEqual([{ name: "Metallic", value: 0.65 }]);
    expect(parsed.vectors).toEqual([{ name: "Emissive", value: [0.1, 0.2, 0.3, 1] }]);
    expect(parsed.vectorOverrides).toEqual([{ name: "Base Color", value: [0.25, 0.5, 0.75, 0.9] }]);
  });
});

describe("material reconstruction", () => {
  const textures = new Set([
    "T_Rock_D_R",
    "T_Rock_N",
    "T_Rock_Extra",
    "T_Leaf_Atlas",
    "T_Leaf_N",
    "T_Leaf_S",
    "T_Pillar_N",
  ]);

  it("binds .mat slots exactly and derives roughness from a packed _D_R alpha", () => {
    const resolved = resolveMaterial({
      name: "M_Rock",
      readMat: (name) => (name === "M_Rock" ? ROCK_MAT : undefined),
      readProps: (name) => (name === "M_Rock" ? ROCK_PROPS : undefined),
      availableTextures: textures,
    });
    expect(packsRoughnessInAlpha("T_Rock_D_R")).toBe(true);
    expect(resolved.bindings).toContainEqual({
      slot: "baseColor",
      texture: "T_Rock_D_R",
      source: "mat",
      confidence: "exact",
      transform: "none",
    });
    expect(resolved.bindings).toContainEqual({
      slot: "metallicRoughness",
      texture: "T_Rock_D_R",
      source: "mat",
      confidence: "heuristic",
      transform: "alphaToRoughness",
    });
    expect(resolved.alphaMode).toBe("OPAQUE");
  });

  it("recovers a diffuse the .mat left in Other from the material's parameter names", () => {
    const resolved = resolveMaterial({
      name: "M_Leaf",
      readMat: () => FOLIAGE_MAT,
      readProps: () => FOLIAGE_PROPS,
      availableTextures: textures,
    });
    const baseColor = resolved.bindings.find((binding) => binding.slot === "baseColor");
    expect(baseColor).toMatchObject({
      texture: "T_Leaf_Atlas",
      source: "props",
      confidence: "heuristic",
    });
    expect(resolved.alphaMode).toBe("MASK");
    expect(resolved.alphaCutoff).toBeCloseTo(0.4);
    expect(resolved.doubleSided).toBe(true);
  });

  it("follows a parent chain and stops on a cycle instead of recursing forever", () => {
    const resolved = resolveMaterial({
      name: "MI_A",
      readMat: (name) => (name === "M_Base" ? "Diffuse=T_Rock_D_R\n" : "Other[0]=T_Rock_Extra\n"),
      readProps: (name) =>
        name === "MI_A"
          ? "Parent = Material'Content/G/M_Base.M_Base'\n"
          : "Parent = Material'Content/G/MI_A.MI_A'\n",
      availableTextures: textures,
    });
    expect(resolved.parents).toEqual(["M_Base"]);
    expect(resolved.bindings.find((binding) => binding.slot === "baseColor")?.texture).toBe(
      "T_Rock_D_R",
    );
  });

  it("lets instance PBR factors override parent defaults", () => {
    const resolved = resolveMaterial({
      name: "MI_PaintedMetal",
      readMat: () => undefined,
      readProps: (name) =>
        name === "MI_PaintedMetal"
          ? `Parent = Material'Content/G/M_Master.M_Master'
ScalarParameterValues[0] = { ParameterInfo={ Name=Roughness }, ParameterValue=0.2 }
VectorParameterValues[0] = { ParameterInfo={ Name=BaseColor }, ParameterValue={ R=0.1,G=0.3,B=0.7,A=0.5 } }
`
          : `CollectedScalarParameters[0] = { Value=0.9, Name=Roughness }
CollectedScalarParameters[1] = { Value=1, Name=Metallic }
CollectedVectorParameters[0] = { Value={ R=1,G=0,B=0,A=1 }, Name=BaseColor }
`,
      availableTextures: new Set(),
    });
    expect(resolved.parents).toEqual(["M_Master"]);
    expect(resolved.roughnessFactor).toBeCloseTo(0.2);
    expect(resolved.metallicFactor).toBe(1);
    expect(resolved.baseColorFactor).toEqual([0.1, 0.3, 0.7, 0.5]);
  });

  it("fills an unresolved slot from an instance override without displacing a .mat slot", () => {
    const resolved = resolveMaterial({
      name: "MI_Pillar",
      readMat: () => "Diffuse=T_Rock_D_R\n",
      readProps: () => `TextureParameterValues[1] =
{
    TextureParameterValues[0] =
    {
        ParameterValue = Texture2D'Content/G/T_Pillar_N.T_Pillar_N'
        ParameterName = NRM
    }
}
`,
      availableTextures: textures,
    });
    expect(resolved.bindings.find((binding) => binding.slot === "normal")).toMatchObject({
      texture: "T_Pillar_N",
      source: "props",
      confidence: "heuristic",
    });
    expect(resolved.bindings.find((binding) => binding.slot === "baseColor")?.texture).toBe(
      "T_Rock_D_R",
    );
  });

  it("completes a texture set when a vertex-paint material resolves no diffuse", () => {
    // The moss and dirt variants of a rock master blend two surfaces by vertex colour, so umodel
    // resolves no single Diffuse and the section would otherwise ship flat grey.
    const resolved = resolveMaterial({
      name: "MI_Rock_Moss",
      readMat: (name) =>
        name === "MI_Rock_Moss"
          ? "Normal=T_Generic_N\nOther[0]=T_Pillar_M\nOther[1]=T_Pillar_N\n"
          : undefined,
      readProps: () => undefined,
      availableTextures: new Set(["T_Generic_N", "T_Pillar_M", "T_Pillar_N"]),
    });
    expect(resolved.bindings.find((binding) => binding.slot === "baseColor")).toMatchObject({
      texture: "T_Pillar_M",
      source: "texture-set",
      confidence: "heuristic",
    });
  });

  it("leaves the base colour unbound when no texture set can be completed", () => {
    const resolved = resolveMaterial({
      name: "MI_Bare",
      readMat: () => "Normal=T_Generic_N\nOther[0]=T_Lonely_M\n",
      readProps: () => undefined,
      availableTextures: new Set(["T_Generic_N", "T_Lonely_M"]),
    });
    expect(resolved.bindings.some((binding) => binding.slot === "baseColor")).toBe(false);
    expect(resolved.unsupported.map((entry) => entry.texture)).toContain("T_Lonely_M");
  });

  it("pairs separate roughness and metalness maps into one glTF binding", () => {
    const resolved = resolveMaterial({
      name: "M_Metal",
      readMat: () => "Other[0]=T_Steel_Roughness\nOther[1]=T_Steel_Metalness\n",
      readProps: () => undefined,
      availableTextures: new Set(["T_Steel_Roughness", "T_Steel_Metalness"]),
    });
    expect(resolved.bindings).toContainEqual({
      slot: "metallicRoughness",
      texture: "T_Steel_Roughness",
      secondaryTexture: "T_Steel_Metalness",
      source: "filename",
      confidence: "heuristic",
      transform: "redRoughnessRedMetalness",
    });
    expect(resolved.unsupported).toEqual([]);
  });

  it("replaces a falsely resolved displacement diffuse with an explicit colour map", () => {
    const resolved = resolveMaterial({
      name: "M_LayeredMarble",
      readMat: () =>
        "Diffuse=T_Marble_4K_Displacement\nOther[0]=T_Marble_4K_Color\nOther[1]=T_Marble_4K_Normal\n",
      readProps: () => undefined,
      availableTextures: new Set([
        "T_Marble_4K_Displacement",
        "T_Marble_4K_Color",
        "T_Marble_4K_Normal",
      ]),
    });
    expect(resolved.bindings.find((binding) => binding.slot === "baseColor")).toMatchObject({
      texture: "T_Marble_4K_Color",
      source: "filename",
      confidence: "heuristic",
    });
    expect(resolved.unsupported.map((entry) => entry.texture)).toContain(
      "T_Marble_4K_Displacement",
    );
  });

  // Modular Building Set (UE4.10): UE Viewer resolved a solid-green gloss map as Diffuse.
  it("swaps a gloss map resolved as Diffuse for the variant colour map beside it", () => {
    const resolved = resolveMaterial({
      name: "brick_wall_grey",
      readMat: () => "Diffuse=brick_wall_tiling_g\nNormal=brick_wall_tiling_n\nOther[0]=brick_wall_tiling_c_grey\n",
      readProps: () => undefined,
      availableTextures: new Set(["brick_wall_tiling_g", "brick_wall_tiling_n", "brick_wall_tiling_c_grey"]),
    });
    expect(resolved.bindings.find((binding) => binding.slot === "baseColor")?.texture).toBe("brick_wall_tiling_c_grey");
  });

  // STF Landscape Pro (UE4.18): a rock's only "Diffuse" is its height/AO/curvature mask, which
  // painted every rock neon green. With no colour image in the graph, neutral is the answer.
  it("leaves base colour neutral when the resolved Diffuse is a data mask with no colour sibling", () => {
    const resolved = resolveMaterial({
      name: "MI_cliffrock01_material_Inst",
      readMat: () => "Diffuse=T_cliffrock01_height_AO_Curvature_TGA\nNormal=T_cliffrock01_normal\n",
      readProps: () => undefined,
      availableTextures: new Set(["T_cliffrock01_height_AO_Curvature_TGA", "T_cliffrock01_normal"]),
    });
    expect(resolved.bindings.find((binding) => binding.slot === "baseColor")).toBeUndefined();
    expect(resolved.unsupported.map((entry) => entry.texture)).toContain("T_cliffrock01_height_AO_Curvature_TGA");
  });

  // UE4.19 fern pack: Diffuse resolved to the AO/roughness pack; the albedo is the `_A` sibling.
  it("takes a trailing _A albedo over an AORO pack, but never a variant-lettered normal map", () => {
    const resolved = resolveMaterial({
      name: "MI_Fern_01_01",
      readMat: () => "Diffuse=fern_01_AORO\nNormal=fern_01_N\nOther[0]=rock_d_n\nOther[1]=fern_01_A\n",
      readProps: () => undefined,
      availableTextures: new Set(["fern_01_AORO", "fern_01_N", "rock_d_n", "fern_01_A"]),
    });
    expect(resolved.bindings.find((binding) => binding.slot === "baseColor")?.texture).toBe("fern_01_A");
  });

  // Megascans European Hornbeam (UE4.27): UE Viewer resolved the Winter set, so leaves came out brown.
  it("prefers a Megascans Summer texture set over the Winter set UE Viewer resolved", () => {
    const resolved = resolveMaterial({
      name: "MI_EuropeanHornbeam_TwoSided",
      readMat: () =>
        "Diffuse=T_EuropeanHornbeam_TwoSided_Winter_Albedo\nNormal=T_EuropeanHornbeam_TwoSided_Winter_Normal\n" +
        "Other[0]=T_EuropeanHornbeam_TwoSided_Summer_Albedo\nOther[1]=T_EuropeanHornbeam_TwoSided_Summer_Normal\n",
      readProps: () => undefined,
      availableTextures: new Set([
        "T_EuropeanHornbeam_TwoSided_Winter_Albedo",
        "T_EuropeanHornbeam_TwoSided_Winter_Normal",
        "T_EuropeanHornbeam_TwoSided_Summer_Albedo",
        "T_EuropeanHornbeam_TwoSided_Summer_Normal",
      ]),
    });
    expect(resolved.bindings.map((binding) => binding.texture).sort()).toEqual([
      "T_EuropeanHornbeam_TwoSided_Summer_Albedo",
      "T_EuropeanHornbeam_TwoSided_Summer_Normal",
    ]);
  });

  it("reports an unmappable texture rather than dropping it", () => {
    const resolved = resolveMaterial({
      name: "M_Odd",
      readMat: () => "Other[0]=T_Mystery_Thing\n",
      readProps: () => undefined,
      availableTextures: new Set(["T_Mystery_Thing"]),
    });
    expect(resolved.bindings).toHaveLength(0);
    expect(resolved.unsupported).toEqual([
      {
        texture: "T_Mystery_Thing",
        reason: "no exact, parameter-name, or filename mapping",
      },
    ]);
  });
});

describe("named channel transforms", () => {
  async function readPixel(data: Buffer): Promise<number[]> {
    const { default: sharp } = await import("sharp");
    const raw = await sharp(data).raw().toBuffer({ resolveWithObject: true });
    return [raw.data[0] ?? 0, raw.data[1] ?? 0, raw.data[2] ?? 0];
  }

  it("moves a packed diffuse alpha into glTF's roughness channel", async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, "packed.png");
    await writePng(source, [10, 20, 30, 200]);
    const result = await applyTextureTransform(await readFile(source), "alphaToRoughness", undefined);
    expect(await readPixel(result.data)).toEqual([255, 200, 0]);
  });

  it("inverts a specular-power map into roughness", async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, "spec.png");
    await writePng(source, [200, 200, 200, 255]);
    const result = await applyTextureTransform(await readFile(source), "specPowerToRoughness", undefined);
    expect(await readPixel(result.data)).toEqual([255, 55, 0]);
  });

  it("moves a red-channel roughness map into green", async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, "rough.png");
    await writePng(source, [77, 0, 0, 255]);
    const result = await applyTextureTransform(await readFile(source), "redToRoughness", undefined);
    expect(await readPixel(result.data)).toEqual([255, 77, 0]);
  });

  it("packs separate red-channel roughness and metalness maps into green and blue", async () => {
    const directory = await temporaryDirectory();
    const roughness = join(directory, "rough.png");
    const metalness = join(directory, "metal.png");
    await writePng(roughness, [64, 0, 0, 255]);
    await writePng(metalness, [192, 0, 0, 255]);
    const result = await applyTextureTransform(
      await readFile(roughness),
      "redRoughnessRedMetalness",
      undefined,
      await readFile(metalness),
    );
    expect(await readPixel(result.data)).toEqual([255, 64, 192]);
  });

  it("returns an untouched image byte-for-byte when nothing has to change", async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, "plain.png");
    await writePng(source, [1, 2, 3, 255]);
    const bytes = await readFile(source);
    const result = await applyTextureTransform(bytes, "none", undefined);
    expect(result.data).toEqual(bytes);
  });
});

describe("base colour image classification", () => {
  it("accepts a saturated solid swatch instead of mistaking it for a packed mask", async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, "red.png");
    await writePng(source, [255, 0, 0, 255]);
    const verdict = await classifyAlbedo(await readFile(source));
    expect(verdict.isAlbedo).toBe(true);
    expect(verdict.spatialVariation).toBeLessThan(0.03);
  });
});

describe("path and toolchain guards", () => {
  it("refuses an output name that escapes the import directory", () => {
    expect(() => assertContained("/tmp/out", "../escape.glb")).toThrow(ImportError);
    expect(assertContained("/tmp/out", "Group/Mesh.glb")).toBe("/tmp/out/Group/Mesh.glb");
  });

  it("hashes source bytes as well as relative path and size, independent of the root", async () => {
    const leftRoot = await temporaryDirectory("tn-hash-left-");
    const rightRoot = await temporaryDirectory("tn-hash-right-");
    const leftPath = join(leftRoot, "x.uasset");
    const rightPath = join(rightRoot, "x.uasset");
    await writeFile(leftPath, "same-size-a");
    await writeFile(rightPath, "same-size-a");
    const left = await hashSourceTree(leftRoot, [{ path: leftPath, size: 11 }]);
    const right = await hashSourceTree(rightRoot, [{ path: rightPath, size: 11 }]);
    await writeFile(rightPath, "same-size-b");
    const changed = await hashSourceTree(rightRoot, [{ path: rightPath, size: 11 }]);
    expect(left).toBe(right);
    expect(changed).not.toBe(left);
  });

  it("pins automatic UE Viewer source builds to the verified commit", () => {
    expect(UEVIEWER_SOURCE.commit).toBe("a0bfb468d42be831b126632fd8a0ae6b3614f981");
    expect(UEVIEWER_SOURCE.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("parses the class table UE Viewer prints for -list", () => {
    const parsed = parseUmodelList(
      "Found 3 game files\n   0    178AC       99 AssetImportData AssetImportData_6\n   4    17B21     1485 StaticMesh SM_Rock\n",
    );
    expect(parsed.classes).toEqual(["AssetImportData", "StaticMesh"]);
    expect(parsed.objects).toEqual(["AssetImportData_6", "SM_Rock"]);
  });

  it("names a few classes and counts the rest instead of dumping hundreds", () => {
    expect(summarizeClasses(["A", "B", "C", "D", "E", "F"])).toBe("A, B, C, D and 2 more");
  });

  it("hands a child no environment variable that could carry a secret", () => {
    const forwarded = childEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/user",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/bus",
      NPM_TOKEN: "secret",
      AWS_SECRET_ACCESS_KEY: "secret",
      FAB_SESSION: "secret",
    });
    expect(forwarded).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/user",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/bus",
    });
  });

  it("points a session-bus-less host at the bus its runtime directory advertises", async () => {
    // Codex and other MCP hosts start this server with no DBUS_SESSION_BUS_ADDRESS of their own, so
    // FabCLI's keystore read failed with a raw "DBus error" and a user who was very much logged in.
    const runtime = await temporaryDirectory();
    await writeFile(join(runtime, "bus"), "");
    const forwarded = childEnvironment({ PATH: "/usr/bin", XDG_RUNTIME_DIR: runtime });
    expect(forwarded.DBUS_SESSION_BUS_ADDRESS).toBe(`unix:path=${join(runtime, "bus")}`);
  });

  it("finds this user's logind bus when the host strips XDG_RUNTIME_DIR as well", () => {
    // The 2026-09-24 Codex host had neither variable; libdbus then tried X11 autolaunch and failed.
    const bus = `/run/user/${process.getuid?.()}/bus`;
    const forwarded = childEnvironment({ PATH: "/usr/bin" });
    const expected = process.platform === "linux" && existsSync(bus) ? `unix:path=${bus}` : undefined;
    expect(forwarded.DBUS_SESSION_BUS_ADDRESS).toBe(expected);
  });

  it("keeps an explicitly configured bus address", async () => {
    const runtime = await temporaryDirectory();
    await writeFile(join(runtime, "bus"), "");
    const forwarded = childEnvironment({
      XDG_RUNTIME_DIR: runtime,
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/somewhere/else",
    });
    expect(forwarded.DBUS_SESSION_BUS_ADDRESS).toBe("unix:path=/somewhere/else");
  });

  it("invents no bus address when the runtime directory has no bus in it", async () => {
    const forwarded = childEnvironment({ XDG_RUNTIME_DIR: await temporaryDirectory() });
    expect(forwarded).not.toHaveProperty("DBUS_SESSION_BUS_ADDRESS");
  });

  it("refuses a relative executable override rather than searching for it", async () => {
    await expect(
      resolveExecutable("umodel", { THREENATIVE_UMODEL_PATH: "./umodel" }),
    ).rejects.toThrow(ToolchainError);
  });

  it("reports a missing umodel with an actionable message when auto-install is off", async () => {
    await expect(
      resolveExecutable("umodel", { PATH: "/nonexistent" }),
    ).rejects.toThrow(/THREENATIVE_UMODEL_PATH/);
  });
});

describe("GLB validation", () => {
  it("rejects a file that is not a glTF binary container", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "broken.glb");
    await writeFile(path, Buffer.alloc(64));
    await expect(validateGlb(path)).rejects.toThrow(/not a glTF binary container/);
  });

  it("rejects a container whose declared length does not match the file", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "short.glb");
    const bytes = Buffer.alloc(64);
    bytes.writeUInt32LE(0x46546c67, 0);
    bytes.writeUInt32LE(2, 4);
    bytes.writeUInt32LE(9999, 8);
    await writeFile(path, bytes);
    await expect(validateGlb(path)).rejects.toThrow(/declares 9999 bytes/);
  });
});

describe("web audio validation", () => {
  it("reads exact PCM WAV duration, channels, and sample rate", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "sound.wav");
    await writeWavFixture(path, 8_000, 4_000);
    expect(inspectWebAudio(await readFile(path))).toEqual({
      extension: "wav",
      mimeType: "audio/wav",
      durationSeconds: 0.5,
      channels: 1,
      sampleRate: 8_000,
    });
  });

  it("rejects a truncated RIFF instead of promoting corrupt audio", () => {
    const wav = Buffer.alloc(20);
    wav.write("RIFF", 0, "ascii");
    wav.write("WAVE", 8, "ascii");
    expect(inspectWebAudio(wav)).toBeUndefined();
  });
});

describe("importing a local Unreal directory", () => {
  it("routes a UE5 editor SkeletalMesh past UE Viewer and preserves skinning", async () => {
    const workspace = await unrealWorkspace({ classes: {}, listExitCode: 1 });
    const sourceMesh = join(workspace.sourceDir, "Content", "Game", "SM_Rock.uasset");
    const header = Buffer.alloc(32);
    header.writeUInt32LE(0x9e2a83c1, 0);
    header.writeInt32LE(-8, 4);
    header.writeInt32LE(864, 8);
    header.writeInt32LE(522, 12);
    header.writeInt32LE(1009, 16);
    await writeFile(
      sourceMesh,
      Buffer.concat([
        header,
        Buffer.from("AssetImportData\0SkeletalMesh\0SkeletalMeshEditorData\0MeshEditorDataObject\0"),
      ]),
    );

    const converterFixture = join(workspace.sourceDir, "..", "skeletal.glb");
    await writeSkinnedGlb(converterFixture, "SM_Rock");
    const normalFixture = join(workspace.sourceDir, "..", "modern-normal.png");
    await writePng(normalFixture, [128, 128, 255, 255]);
    const converter = join(workspace.sourceDir, "..", "modern-unreal-converter");
    await writeFile(
      converter,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const at = process.argv.indexOf("--export-dir");
const out = process.argv[at + 1];
fs.mkdirSync(path.join(out, "Meshes"), { recursive: true });
fs.copyFileSync(${JSON.stringify(converterFixture)}, path.join(out, "Meshes", "SM_Rock.glb"));
fs.mkdirSync(path.join(out, "Materials"), { recursive: true });
fs.writeFileSync(path.join(out, "Materials", "M_Rock.mat"), "Normal=T_Rock_N\\n");
fs.copyFileSync(${JSON.stringify(normalFixture)}, path.join(out, "Materials", "T_Rock_N.png"));
`,
    );
    await chmod(converter, 0o755);

    const report = await importUnrealDirectory({
      sourceDir: workspace.sourceDir,
      outputDir: workspace.outputDir,
      environment: workspace.environment,
      umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
      modernConverter: { name: "modern", path: converter, version: "Test modern skeletal" },
      onlyPackages: ["SM_Rock"],
    });

    expect(report.counts).toMatchObject({ exported: 1, failed: 0 });
    expect(report.models[0]).toMatchObject({ kind: "skeletal", skins: 1, vertices: 3 });
    expect(report.models[0]?.boundsMetres).toEqual([1, 1, 0]);
    const artifact = await new NodeIO().read(join(workspace.outputDir, report.models[0]!.glb));
    const importedPrimitive = artifact.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
    expect(importedPrimitive.getAttribute("JOINTS_0")).not.toBeNull();
    expect(importedPrimitive.getAttribute("WEIGHTS_0")).not.toBeNull();
    expect(artifact.getRoot().listMaterials()[0]?.getNormalTexture()?.getImage()?.byteLength).toBeGreaterThan(0);
  });

  it("promotes a skeletal mesh's embedded DNA beside the GLB and reports its bytes and hash", async () => {
    const workspace = await unrealWorkspace({ classes: {}, listExitCode: 1 });
    await writeEditorSkeletalMesh(workspace.sourceDir, "SM_Rock");
    // A MetaHuman DNA asset is a byte blob whose stored file name is the authoring machine's
    // Windows path. The converter is what has to land it inside the export tree.
    const dna = Buffer.from("DNA ð Ada", "binary");
    const dnaFixture = join(workspace.sourceDir, "..", "dna", "DNAAsset_7.dna");
    await mkdir(join(workspace.sourceDir, "..", "dna"), { recursive: true });
    await writeFile(dnaFixture, dna);
    const glbFixture = join(workspace.sourceDir, "..", "skeletal-dna.glb");
    await writeSkinnedGlb(glbFixture, "SM_Rock");
    const converter = await writeModernConverter(workspace.sourceDir, "modern-dna-converter", [
      `fs.copyFileSync(${JSON.stringify(glbFixture)}, path.join(out, "Meshes", "SM_Rock.glb"));`,
      `fs.copyFileSync(${JSON.stringify(dnaFixture)}, path.join(out, "Meshes", "SM_Rock.dna"));`,
    ]);

    const report = await importUnrealDirectory({
      sourceDir: workspace.sourceDir,
      outputDir: workspace.outputDir,
      environment: workspace.environment,
      umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
      modernConverter: { name: "modern", path: converter, version: "Test modern dna" },
      onlyPackages: ["SM_Rock"],
    });

    expect(report.models[0]).toMatchObject({ name: "SM_Rock", kind: "skeletal" });
    expect(report.models[0]?.dna).toEqual({
      path: "Models/SM_Rock.dna",
      bytes: dna.byteLength,
      sha256: createHash("sha256").update(dna).digest("hex"),
    });
    // The promoted file is the DNA asset's own bytes, byte for byte.
    expect(await readFile(join(workspace.outputDir, "Models", "SM_Rock.dna"))).toEqual(dna);
  });

  it("keeps a skeletal mesh at LOD0 unless another LOD is requested", async () => {
    const workspace = await unrealWorkspace({ classes: {}, listExitCode: 1 });
    await writeEditorSkeletalMesh(workspace.sourceDir, "SM_Rock");
    const fixtures = join(workspace.sourceDir, "..", "lods");
    await mkdir(fixtures, { recursive: true });
    await writeSkinnedGlb(join(fixtures, "SM_Rock.glb"), "SM_Rock", {
      vertices: 3,
      joints: 2,
      morphs: ["face_browInnerUp", "face_jawOpen"],
    });
    await writeSkinnedGlb(join(fixtures, "SM_Rock_LOD1.glb"), "SM_Rock", {
      vertices: 2,
      joints: 2,
      morphs: ["face_browInnerUp"],
    });
    await writeSkinnedGlb(join(fixtures, "SM_Rock_LOD2.glb"), "SM_Rock", { vertices: 1, joints: 2 });
    const argvLog = join(workspace.sourceDir, "..", "lods-argv.json");
    const converter = await writeModernConverter(workspace.sourceDir, "modern-lods-converter", [
      `fs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));`,
      `for (const name of ["SM_Rock", "SM_Rock_LOD1", "SM_Rock_LOD2"])`,
      `  fs.copyFileSync(path.join(${JSON.stringify(fixtures)}, name + ".glb"), path.join(out, "Meshes", name + ".glb"));`,
    ]);

    const base = {
      sourceDir: workspace.sourceDir,
      outputDir: workspace.outputDir,
      environment: workspace.environment,
      umodel: { name: "umodel" as const, path: workspace.umodel, version: "Test" },
      modernConverter: { name: "modern" as const, path: converter, version: "Test modern lods" },
      onlyPackages: ["SM_Rock"],
    };

    const defaulted = await importUnrealDirectory(base);
    expect(defaulted.models.map((model) => model.glb)).toEqual(["Models/SM_Rock.glb"]);
    expect(JSON.parse(await readFile(argvLog, "utf8"))).not.toContain("--lods");

    const requestedDir = join(workspace.outputDir, "lods");
    const requested = await importUnrealDirectory({ ...base, outputDir: requestedDir, lods: [1, 0] });
    expect(requested.models.map((model) => model.glb)).toEqual([
      "Models/SM_Rock.glb",
      "Models/SM_Rock_LOD1.glb",
    ]);
    expect(JSON.parse(await readFile(argvLog, "utf8"))).toContain("--lods");
    expect(requested.models.map((model) => [model.vertices, model.joints, model.morphTargets])).toEqual([
      [3, 2, 2],
      [2, 2, 1],
    ]);
    // Every LOD keeps the same skeleton and target naming, so a swap needs no rebinding.
    for (const model of requested.models) {
      const lod = await new NodeIO().read(join(requestedDir, model.glb));
      expect(lod.getRoot().listNodes().map((node) => node.getName())).toEqual(["root", "joint_1", "SM_Rock"]);
      const targetNames = lod
        .getRoot()
        .listMeshes()
        .flatMap((mesh) => mesh.listPrimitives())
        .reduce((sum, primitive) => sum + primitive.listTargets().length, 0);
      expect(targetNames).toBe(model.morphTargets);
    }
  });

  it("routes a cooked UE5 StaticMesh rejected by UE Viewer through the modern converter", async () => {
    const workspace = await unrealWorkspace({ classes: {}, listExitCode: 1 });
    const sourceMesh = join(workspace.sourceDir, "Content", "Game", "SM_Rock.uasset");
    const header = Buffer.alloc(32);
    header.writeUInt32LE(0x9e2a83c1, 0);
    header.writeInt32LE(-8, 4);
    header.writeInt32LE(1009, 12);
    await writeFile(
      sourceMesh,
      Buffer.concat([header, Buffer.from("StaticMesh\0Default__StaticMesh\0")]),
    );

    const fixtureGltf = join(workspace.sourceDir, "..", "exported", "SM_Rock.gltf");
    const converterFixture = join(workspace.sourceDir, "..", "modern-static.glb");
    await new NodeIO().write(converterFixture, await new NodeIO().read(fixtureGltf));
    const argvLog = join(workspace.sourceDir, "..", "modern-static-argv.json");
    const converter = join(workspace.sourceDir, "..", "modern-static-converter");
    await writeFile(
      converter,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
fs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));
const at = process.argv.indexOf("--export-dir");
const out = process.argv[at + 1];
fs.mkdirSync(path.join(out, "Meshes"), { recursive: true });
fs.copyFileSync(${JSON.stringify(converterFixture)}, path.join(out, "Meshes", "SM_Rock.glb"));
`,
    );
    await chmod(converter, 0o755);

    const report = await importUnrealDirectory({
      sourceDir: workspace.sourceDir,
      outputDir: workspace.outputDir,
      environment: workspace.environment,
      umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
      modernConverter: { name: "modern", path: converter, version: "Test modern static" },
      onlyPackages: ["SM_Rock"],
    });

    expect(report.counts).toMatchObject({ exported: 1, failed: 0 });
    expect(report.models[0]).toMatchObject({ kind: "static", skins: 0, vertices: 3 });
    expect(report.toolchain.modernConverter).toBe("Test modern static");
    expect(JSON.parse(await readFile(argvLog, "utf8"))).not.toContain("--skip-textures");
  });

  it("retries ambiguous unversioned UE5 packages with isolated engine profiles", async () => {
    const workspace = await unrealWorkspace({ classes: {}, listExitCode: 1 });
    const sourceMesh = join(workspace.sourceDir, "Content", "Game", "SM_Rock.uasset");
    const header = Buffer.alloc(32);
    header.writeUInt32LE(0x9e2a83c1, 0);
    header.writeInt32LE(-9, 4);
    await writeFile(sourceMesh, Buffer.concat([header, Buffer.from("StaticMesh\0Default__StaticMesh\0")]));

    const fixtureGltf = join(workspace.sourceDir, "..", "exported", "SM_Rock.gltf");
    const converterFixture = join(workspace.sourceDir, "..", "fallback-static.glb");
    await new NodeIO().write(converterFixture, await new NodeIO().read(fixtureGltf));
    const attempts = join(workspace.sourceDir, "..", "engine-attempts.txt");
    const converter = join(workspace.sourceDir, "..", "modern-engine-fallback-converter");
    await writeFile(converter, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const engineAt = process.argv.indexOf("--engine");
const engine = engineAt >= 0 ? process.argv[engineAt + 1] : "auto";
fs.appendFileSync(${JSON.stringify(attempts)}, engine + "\\n");
const out = process.argv[process.argv.indexOf("--export-dir") + 1];
fs.mkdirSync(out, { recursive: true });
if (engine !== "5.6") {
  fs.writeFileSync(path.join(out, "partial-output-must-not-promote.txt"), engine);
  console.error(engine === "5.7"
    ? "No StaticMesh, SkeletalMesh, Texture2D, TextureCube, SoundWave, or structured-data output was produced"
    : "ParserException: Invalid FString length while decoding an unversioned package");
  process.exit(1);
}
fs.mkdirSync(path.join(out, "Meshes"), { recursive: true });
fs.copyFileSync(${JSON.stringify(converterFixture)}, path.join(out, "Meshes", "SM_Rock.glb"));
`);
    await chmod(converter, 0o755);

    const report = await importUnrealDirectory({
      sourceDir: workspace.sourceDir,
      outputDir: workspace.outputDir,
      environment: workspace.environment,
      umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
      modernConverter: { name: "modern", path: converter, version: "Test profile fallback" },
      onlyPackages: ["SM_Rock"],
    });

    expect((await readFile(attempts, "utf8")).trim().split("\n")).toEqual(["auto", "5.7", "5.6"]);
    expect(report.failed).toEqual([]);
    expect(report.models[0]).toMatchObject({ name: "SM_Rock", vertices: 3 });
    await expect(stat(join(workspace.outputDir, "partial-output-must-not-promote.txt"))).rejects.toThrow();
  });

  it("keeps the actionable .usmap diagnostic when the modern converter prints a stack trace", async () => {
    const workspace = await unrealWorkspace({ classes: {}, listExitCode: 1 });
    const sourceMesh = join(workspace.sourceDir, "Content", "Game", "SM_Rock.uasset");
    const header = Buffer.alloc(32);
    header.writeUInt32LE(0x9e2a83c1, 0);
    header.writeInt32LE(-8, 4);
    // A UE5-era object version, so this mesh is the modern converter's to lose.
    header.writeUInt32LE(1009, 12);
    await writeFile(
      sourceMesh,
      Buffer.concat([header, Buffer.from("StaticMesh\0Default__StaticMesh\0")]),
    );
    const converter = join(workspace.sourceDir, "..", "modern-static-converter");
    await writeFile(
      converter,
      `#!/usr/bin/env node
console.error("InvalidDataException: Place its game-compatible .usmap mapping file in the imported directory.");
console.error("    at Program.<Main>(String[] args)");
process.exit(1);
`,
    );
    await chmod(converter, 0o755);

    await expect(
      importUnrealDirectory({
        sourceDir: workspace.sourceDir,
        outputDir: workspace.outputDir,
        environment: workspace.environment,
        umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
        modernConverter: { name: "modern", path: converter, version: "Test modern static" },
        onlyPackages: ["SM_Rock"],
      }),
    ).rejects.toThrow(/game-compatible \.usmap/);
  });

  it("trusts UE Viewer's class list over the Texture2D name-table hint for a material instance", async () => {
    // A material instance imports the Texture2D class for its parameters and carries
    // AssetImportData; read as a texture it failed with "no PNG" and its mesh lost every texture.
    const workspace = await unrealWorkspace({
      classes: { SM_Rock: ["StaticMesh", "BodySetup"], MI_Rock: ["MaterialInstanceConstant"] },
      emptyExports: ["MI_Rock"],
    });
    const header = Buffer.alloc(32);
    header.writeUInt32LE(0x9e2a83c1, 0);
    header.writeInt32LE(-7, 4);
    header.writeInt32LE(516, 12);
    await writeFile(
      join(workspace.sourceDir, "Content", "Game", "MI_Rock.uasset"),
      Buffer.concat([header, Buffer.from("AssetImportData\0Texture2D\0MaterialInstanceConstant\0")]),
    );

    const report = await importUnrealDirectory({
      sourceDir: workspace.sourceDir,
      outputDir: workspace.outputDir,
      environment: workspace.environment,
      umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
      onlyPackages: ["SM_Rock", "MI_Rock"],
    });

    expect(report.failed.filter((entry) => entry.package.includes("MI_Rock"))).toEqual([]);
    expect(report.textures.map((texture) => texture.name)).not.toContain("MI_Rock");
  });

  it("routes a modern editor Texture2D rejected by UE Viewer through the modern converter", async () => {
    const workspace = await unrealWorkspace({ classes: {}, listExitCode: 1 });
    const sourceTexture = join(workspace.sourceDir, "Content", "Game", "SM_Rock.uasset");
    const header = Buffer.alloc(32);
    header.writeUInt32LE(0x9e2a83c1, 0);
    header.writeInt32LE(-8, 4);
    await writeFile(
      sourceTexture,
      Buffer.concat([header, Buffer.from("AssetImportData\0Texture2D\0")]),
    );
    const png = join(workspace.sourceDir, "..", "modern-texture.png");
    await writePng(png, [20, 40, 60, 255], 4);
    const converter = join(workspace.sourceDir, "..", "modern-texture-converter");
    await writeFile(
      converter,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const at = process.argv.indexOf("--export-dir");
const out = process.argv[at + 1];
fs.mkdirSync(path.join(out, "Textures"), { recursive: true });
fs.copyFileSync(${JSON.stringify(png)}, path.join(out, "Textures", "SM_Rock.png"));
`,
    );
    await chmod(converter, 0o755);

    const report = await importUnrealDirectory({
      sourceDir: workspace.sourceDir,
      outputDir: workspace.outputDir,
      environment: workspace.environment,
      umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
      modernConverter: { name: "modern", path: converter, version: "Test modern texture" },
      onlyPackages: ["SM_Rock"],
    });

    expect(report.failed).toEqual([]);
    expect(report.counts).toMatchObject({ exported: 0, textures: 1, scenes: 0, failed: 0 });
    expect(report.textures[0]).toMatchObject({ name: "SM_Rock", width: 4, height: 4 });
    expect(report.toolchain.modernConverter).toBe("Test modern texture");
    expect((await stat(join(workspace.outputDir, report.textures[0]!.png))).size).toBeGreaterThan(0);
  });

  // Fab's UE5 Megascans packs ship foliage types, material functions and a parameter collection
  // beside the meshes. UE Viewer cannot list UE5 packages, so these used to read as failures.
  it("reports UE5 editor-only packages UE Viewer cannot list as skipped, not failed", async () => {
    const workspace = await unrealWorkspace({ classes: {}, listExitCode: 1 });
    const header = Buffer.alloc(32);
    header.writeUInt32LE(0x9e2a83c1, 0);
    header.writeInt32LE(-8, 4);
    const game = join(workspace.sourceDir, "Content", "Game");
    await writeFile(join(game, "SM_Rock.uasset"), Buffer.concat([header, Buffer.from("AssetImportData\0Texture2D\0")]));
    await writeFile(join(game, "FT_Rock.uasset"), Buffer.concat([header, Buffer.from("FoliageType_InstancedStaticMesh\0")]));
    await writeFile(join(game, "MF_Blend.uasset"), Buffer.concat([header, Buffer.from("MaterialFunction\0MaterialFunctionEditorOnlyData\0")]));
    // A MaterialFunctionInstance is not a MaterialFunction: only whole name-table entries count.
    await writeFile(join(game, "MFI_Blend.uasset"), Buffer.concat([header, Buffer.from("MaterialFunctionInstance\0")]));
    const png = join(workspace.sourceDir, "..", "modern-texture.png");
    await writePng(png, [20, 40, 60, 255], 4);
    const converter = join(workspace.sourceDir, "..", "modern-texture-converter");
    await writeFile(
      converter,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const out = process.argv[process.argv.indexOf("--export-dir") + 1];
fs.mkdirSync(path.join(out, "Textures"), { recursive: true });
fs.copyFileSync(${JSON.stringify(png)}, path.join(out, "Textures", "SM_Rock.png"));
`,
    );
    await chmod(converter, 0o755);

    const report = await importUnrealDirectory({
      sourceDir: workspace.sourceDir,
      outputDir: workspace.outputDir,
      environment: workspace.environment,
      umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
      modernConverter: { name: "modern", path: converter, version: "Test modern texture" },
      onlyPackages: ["SM_Rock", "FT_Rock", "MF_Blend", "MFI_Blend"],
    });

    const reason = (name: string) => report.skipped.find((entry) => entry.package.includes(name))?.reason;
    expect(reason("FT_Rock")).toBe("unsupported Unreal-only content: foliage placement type");
    expect(reason("MF_Blend")).toMatch(/no directly importable .*MaterialFunction/);
    expect(report.failed.map((entry) => entry.package)).toEqual([expect.stringContaining("MFI_Blend")]);
  });

  // Every Megascans UE5 pack ships BP_GlobalFoliageActor: an event graph with nothing to place.
  it("skips a logic-only Blueprint prefab the converter reports as empty, without a second level failure", async () => {
    const workspace = await unrealWorkspace({ classes: {}, listExitCode: 1 });
    const header = Buffer.alloc(32);
    header.writeUInt32LE(0x9e2a83c1, 0);
    header.writeInt32LE(-8, 4);
    const game = join(workspace.sourceDir, "Content", "Game");
    await writeFile(join(game, "SM_Rock.uasset"), Buffer.concat([header, Buffer.from("AssetImportData\0Texture2D\0")]));
    await writeFile(join(game, "BP_Wind.uasset"), Buffer.concat([header, Buffer.from("BlueprintGeneratedClass\0SimpleConstructionScript\0")]));
    const png = join(workspace.sourceDir, "..", "modern-texture.png");
    await writePng(png, [20, 40, 60, 255], 4);
    const converter = join(workspace.sourceDir, "..", "modern-converter");
    await writeFile(
      converter,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const out = process.argv[process.argv.indexOf("--export-dir") + 1];
if (process.argv.some((arg) => arg.includes("BP_Wind"))) {
  process.stderr.write("Unhandled exception. System.IO.InvalidDataException: No StaticMesh, SkeletalMesh, Texture2D, TextureCube, SoundWave, or structured-data output was produced.\\n");
  process.exit(134);
}
fs.mkdirSync(path.join(out, "Textures"), { recursive: true });
fs.copyFileSync(${JSON.stringify(png)}, path.join(out, "Textures", "SM_Rock.png"));
`,
    );
    await chmod(converter, 0o755);

    const report = await importUnrealDirectory({
      sourceDir: workspace.sourceDir,
      outputDir: workspace.outputDir,
      environment: workspace.environment,
      umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
      modernConverter: { name: "modern", path: converter, version: "Test modern" },
      onlyPackages: ["SM_Rock", "BP_Wind"],
    });

    expect(report.failed).toEqual([]);
    expect(report.skipped.find((entry) => entry.package.includes("BP_Wind"))?.reason).toMatch(/Blueprint class with no mesh or light components/);
  });

  it("decodes TextureCube as collision-safe 2:1 environment PNG and preserves ratio under an odd size cap", async () => {
    const workspace = await unrealWorkspace({ classes: { SM_Rock: ["TextureCube"] } });
    const panorama = join(workspace.sourceDir, "..", "panorama.png");
    const { default: sharp } = await import("sharp");
    await sharp({
      create: { width: 128, height: 64, channels: 3, background: { r: 20, g: 80, b: 140 } },
    }).png().toFile(panorama);
    const converter = join(workspace.sourceDir, "..", "cubemap-converter");
    await writeFile(
      converter,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const at = process.argv.indexOf("--export-dir");
const out = process.argv[at + 1];
fs.mkdirSync(path.join(out, "Cubemaps"), { recursive: true });
fs.copyFileSync(${JSON.stringify(panorama)}, path.join(out, "Cubemaps", "SM_Rock.png"));
`,
    );
    await chmod(converter, 0o755);

    const report = await importUnrealDirectory({
      sourceDir: workspace.sourceDir,
      outputDir: workspace.outputDir,
      environment: workspace.environment,
      umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
      modernConverter: { name: "modern", path: converter, version: "Test cubemap" },
      maxTextureSize: 65,
    });

    expect(report.failed).toEqual([]);
    expect(report.counts).toMatchObject({ exported: 0, textures: 0, cubemaps: 1, failed: 0 });
    expect(report.cubemaps[0]).toMatchObject({
      name: "SM_Rock",
      width: 64,
      height: 32,
      mapping: "EquirectangularReflectionMapping",
    });
    expect((await stat(join(workspace.outputDir, report.cubemaps[0]!.file))).size).toBeGreaterThan(0);
  });

  it("keeps reflection-capture cubes inside MapBuildDataRegistry as baked-lighting skips", async () => {
    const workspace = await unrealWorkspace({
      classes: {
        SM_Rock: ["StaticMesh"],
        BP_Spawner: ["MapBuildDataRegistry", "TextureCube"],
      },
    });
    const converter = join(workspace.sourceDir, "..", "must-not-run-cubemap-converter");
    await writeFile(converter, "#!/usr/bin/env node\nprocess.exit(91);\n");
    await chmod(converter, 0o755);

    const report = await importUnrealDirectory({
      sourceDir: workspace.sourceDir,
      outputDir: workspace.outputDir,
      environment: workspace.environment,
      umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
      modernConverter: { name: "modern", path: converter, version: "must not run" },
    });

    expect(report.counts.cubemaps).toBe(0);
    expect(report.failed).toEqual([]);
    expect(report.skipped).toContainEqual({
      package: "Content/Game/BP_Spawner.uasset",
      reason: "unsupported Unreal-only content: baked level lighting",
    });
  });

  it("packages a VolumeTexture atlas as ordered RGBA slices for Three Data3DTexture", async () => {
    const workspace = await unrealWorkspace({ classes: { SM_Rock: ["VolumeTexture"] } });
    const atlas = join(workspace.sourceDir, "..", "volume-atlas.png");
    const pixels = Buffer.alloc(2 * 2 * 3 * 4);
    for (let layer = 0; layer < 3; layer += 1) {
      for (let pixel = 0; pixel < 4; pixel += 1) {
        const offset = (layer * 4 + pixel) * 4;
        pixels.set([10 + layer * 10, 40, 80, 255], offset);
      }
    }
    const { default: sharp } = await import("sharp");
    await sharp(pixels, { raw: { width: 2, height: 6, channels: 4 } }).png().toFile(atlas);
    const converter = join(workspace.sourceDir, "..", "volume-converter");
    await writeFile(
      converter,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const out = process.argv[process.argv.indexOf("--export-dir") + 1];
const target = path.join(out, "Multidimensional");
fs.mkdirSync(target, { recursive: true });
fs.copyFileSync(${JSON.stringify(atlas)}, path.join(target, "SM_Rock_ATLAS.png"));
fs.writeFileSync(path.join(target, "SM_Rock.texture.json"), JSON.stringify({
  Name: "SM_Rock", Class: "VolumeTexture", Width: 2, Height: 2, Depth: 3,
  Layout: "vertical-atlas", Layers: ["SM_Rock_ATLAS.png"]
}));
`,
    );
    await chmod(converter, 0o755);

    const report = await importUnrealDirectory({
      sourceDir: workspace.sourceDir,
      outputDir: workspace.outputDir,
      environment: workspace.environment,
      umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
      modernConverter: { name: "modern", path: converter, version: "Test volume" },
    });

    expect(report.failed).toEqual([]);
    expect(report.counts).toMatchObject({ exported: 0, textureStacks: 1, failed: 0 });
    expect(report.textureStacks[0]).toMatchObject({
      kind: "volume", threeTexture: "Data3DTexture", width: 2, height: 2, depth: 3, bytes: 48,
    });
    const data = await readFile(join(workspace.outputDir, report.textureStacks[0]!.data));
    expect([data[0], data[16], data[32]]).toEqual([10, 20, 30]);
    const manifest = JSON.parse(await readFile(join(workspace.outputDir, report.textureStacks[0]!.manifest), "utf8"));
    expect(manifest).toMatchObject({ kind: "volume", format: "RGBA8", data: "SM_Rock.rgba" });
  });

  it("rejects a malformed TextureCubeArray depth instead of promoting partial output", async () => {
    const workspace = await unrealWorkspace({ classes: { SM_Rock: ["TextureCubeArray"] } });
    const atlas = join(workspace.sourceDir, "..", "bad-cube-array.png");
    const { default: sharp } = await import("sharp");
    await sharp({ create: { width: 2, height: 10, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 1 } } })
      .png()
      .toFile(atlas);
    const converter = join(workspace.sourceDir, "..", "bad-cube-array-converter");
    await writeFile(
      converter,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const out = process.argv[process.argv.indexOf("--export-dir") + 1];
const target = path.join(out, "Multidimensional");
fs.mkdirSync(target, { recursive: true });
fs.copyFileSync(${JSON.stringify(atlas)}, path.join(target, "SM_Rock_ATLAS.png"));
fs.writeFileSync(path.join(target, "SM_Rock.texture.json"), JSON.stringify({
  Class: "TextureCubeArray", Width: 2, Height: 2, Depth: 5,
  Layout: "vertical-atlas", Layers: ["SM_Rock_ATLAS.png"]
}));
`,
    );
    await chmod(converter, 0o755);

    await expect(importUnrealDirectory({
      sourceDir: workspace.sourceDir,
      outputDir: workspace.outputDir,
      environment: workspace.environment,
      umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
      modernConverter: { name: "modern", path: converter, version: "Test cube array" },
    })).rejects.toThrow(/cube-array depth 5 is not divisible by six faces/);
  });

  it("promotes an embedded Unreal Font as a collision-safe browser FontFace", async () => {
    const workspace = await unrealWorkspace({ classes: { SM_Rock: ["Font", "FontBulkData"] } });
    const sourceFont = await readFile(join(process.cwd(), "node_modules/playwright-core/lib/vite/recorder/assets/codicon-DCmgc-ay.ttf"));
    await writeFile(join(workspace.sourceDir, "Content", "Game", "SM_Rock.uasset"), sourceFont);

    const report = await importUnrealDirectory({
      sourceDir: workspace.sourceDir,
      outputDir: workspace.outputDir,
      environment: workspace.environment,
      umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
    });

    expect(report.failed).toEqual([]);
    expect(report.counts).toMatchObject({ exported: 0, fonts: 1, failed: 0 });
    expect(report.fonts[0]).toMatchObject({
      name: "codicon", family: "codicon", style: "Regular", fontStyle: "normal", weight: 400, mimeType: "font/ttf",
    });
    expect(report.fonts[0]!.file).toMatch(/^fonts\/Content\/Game\/SM_Rock\/01-codicon\.ttf$/);
    expect(await readFile(join(workspace.outputDir, report.fonts[0]!.file))).toEqual(sourceFont);
  });

  it("promotes an offline Unreal Font atlas with BMFont metrics instead of a false Texture2D failure", async () => {
    const workspace = await unrealWorkspace({ classes: { SM_Rock: ["Font", "Texture2D"] } });
    const atlas = join(workspace.sourceDir, "..", "font-atlas.png");
    await writePng(atlas, [255, 255, 255, 255], 16);
    const converter = join(workspace.sourceDir, "..", "offline-font-converter");
    await writeFile(converter, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const out = path.join(process.argv[process.argv.indexOf("--export-dir") + 1], "Fonts");
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(${JSON.stringify(atlas)}, path.join(out, "SM_Rock_page00.png"));
fs.writeFileSync(path.join(out, "SM_Rock.font.json"), JSON.stringify({
  Name: "SM_Rock", PackagePath: "/Game/SM_Rock.SM_Rock", Pages: ["SM_Rock_page00.png"],
  Characters: [{ StartU: 1, StartV: 2, USize: 4, VSize: 5, TextureIndex: 0, VerticalOffset: -1 }],
  CharRemap: { "65": 0 }, IsRemapped: true, Kerning: 1, EmScale: 64, Ascent: 704,
  Descent: 128, Leading: 64, ScalingFactor: 1, IsDistanceField: true, DistanceFieldScaleFactor: 2
}));
`);
    await chmod(converter, 0o755);

    const report = await importUnrealDirectory({
      sourceDir: workspace.sourceDir,
      outputDir: workspace.outputDir,
      environment: workspace.environment,
      umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
      modernConverter: { name: "modern", path: converter, version: "Test offline font" },
    });

    expect(report.failed).toEqual([]);
    expect(report.counts).toMatchObject({ textures: 0, fonts: 0, bitmapFonts: 1, failed: 0 });
    expect(report.bitmapFonts[0]).toMatchObject({ name: "SM_Rock", glyphs: 1, distanceField: true });
    const manifest = JSON.parse(await readFile(join(workspace.outputDir, report.bitmapFonts[0]!.manifest), "utf8"));
    expect(manifest).toMatchObject({ common: { lineHeight: 14, base: 11 }, chars: [{ id: 65, chnl: 4 }] });
    expect(await stat(join(workspace.outputDir, report.bitmapFonts[0]!.pages[0]!))).toMatchObject({ size: expect.any(Number) });
  });

  it("rejects a Font package with no validated face instead of emitting arbitrary bulk bytes", async () => {
    const workspace = await unrealWorkspace({ classes: { SM_Rock: ["Font", "FontBulkData"] } });
    await writeFile(join(workspace.sourceDir, "Content", "Game", "SM_Rock.uasset"), "FontBulkData but not a font");
    await expect(importUnrealDirectory({
      sourceDir: workspace.sourceDir,
      outputDir: workspace.outputDir,
      environment: workspace.environment,
      umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
    })).rejects.toThrow(/no validated embedded TTF\/OTF face or offline glyph atlas was found/);
    await expect(stat(workspace.outputDir)).rejects.toThrow();
  });

  it("promotes duplicate-named structured-data packages as separate validated JSON files", async () => {
    const workspace = await unrealWorkspace({ classes: { DT_Config: ["DataTable"] } });
    await mkdir(join(workspace.sourceDir, "Content", "A"), { recursive: true });
    await mkdir(join(workspace.sourceDir, "Content", "B"), { recursive: true });
    await writeFile(join(workspace.sourceDir, "Content", "A", "DT_Config.uasset"), "table A");
    await writeFile(join(workspace.sourceDir, "Content", "B", "DT_Config.uasset"), "table B");
    const converter = join(workspace.sourceDir, "..", "data-converter");
    await writeFile(
      converter,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const out = process.argv[process.argv.indexOf("--export-dir") + 1];
const filter = process.argv[process.argv.indexOf("--filter") + 1];
fs.mkdirSync(path.join(out, "Data"), { recursive: true });
fs.writeFileSync(path.join(out, "Data", "DT_Config.json"), JSON.stringify({ Type: "DataTable", filter }));
`,
    );
    await chmod(converter, 0o755);

    const report = await importUnrealDirectory({
      sourceDir: workspace.sourceDir,
      outputDir: workspace.outputDir,
      environment: workspace.environment,
      umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
      modernConverter: { name: "modern", path: converter, version: "Test data" },
    });

    expect(report.failed).toEqual([]);
    expect(report.counts.dataAssets).toBe(2);
    expect(new Set(report.dataAssets.map((entry) => entry.json)).size).toBe(2);
    const payloads = await Promise.all(report.dataAssets.map(async (entry) =>
      JSON.parse(await readFile(join(workspace.outputDir, entry.json), "utf8")) as { filter: string },
    ));
    expect(payloads.map((entry) => entry.filter).sort()).toEqual(["Content/A/DT_Config", "Content/B/DT_Config"]);
  });

  it("rejects malformed structured-data JSON without promoting partial output", async () => {
    const workspace = await unrealWorkspace({ classes: { SM_Rock: ["DataTable"] } });
    const converter = join(workspace.sourceDir, "..", "bad-data-converter");
    await writeFile(
      converter,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const out = process.argv[process.argv.indexOf("--export-dir") + 1];
fs.mkdirSync(path.join(out, "Data"), { recursive: true });
fs.writeFileSync(path.join(out, "Data", "SM_Rock.json"), "{not-json");
`,
    );
    await chmod(converter, 0o755);

    await expect(importUnrealDirectory({
      sourceDir: workspace.sourceDir,
      outputDir: workspace.outputDir,
      environment: workspace.environment,
      umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
      modernConverter: { name: "modern", path: converter, version: "Test malformed data" },
    })).rejects.toThrow(/Structured-data packaging failed/);
    await expect(stat(workspace.outputDir)).rejects.toThrow();
  });

  it("routes a modern editor SoundWave rejected by UE Viewer through the modern converter", async () => {
    const workspace = await unrealWorkspace({ classes: {}, listExitCode: 1 });
    const sourceSound = join(workspace.sourceDir, "Content", "Game", "SM_Rock.uasset");
    const header = Buffer.alloc(32);
    header.writeUInt32LE(0x9e2a83c1, 0);
    header.writeInt32LE(-8, 4);
    await writeFile(sourceSound, Buffer.concat([header, Buffer.from("AssetImportData\0SoundWave\0")]));
    const wav = join(workspace.sourceDir, "..", "modern-sound.wav");
    await writeWavFixture(wav, 16_000, 8_000);
    const converter = join(workspace.sourceDir, "..", "modern-sound-converter");
    await writeFile(
      converter,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const at = process.argv.indexOf("--export-dir");
const out = process.argv[at + 1];
fs.mkdirSync(path.join(out, "Audio"), { recursive: true });
fs.copyFileSync(${JSON.stringify(wav)}, path.join(out, "Audio", "SM_Rock.wav"));
`,
    );
    await chmod(converter, 0o755);

    const report = await importUnrealDirectory({
      sourceDir: workspace.sourceDir,
      outputDir: workspace.outputDir,
      environment: workspace.environment,
      umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
      modernConverter: { name: "modern", path: converter, version: "Test modern sound" },
      onlyPackages: ["SM_Rock"],
    });

    expect(report.failed).toEqual([]);
    expect(report.counts).toMatchObject({ exported: 0, audio: 1, failed: 0 });
    expect(report.audio[0]).toMatchObject({
      name: "SM_Rock",
      mimeType: "audio/wav",
      durationSeconds: 0.5,
      channels: 1,
      sampleRate: 16_000,
    });
    expect((await stat(join(workspace.outputDir, report.audio[0]!.file))).size).toBeGreaterThan(44);
  });

  it("promotes a cooked skeletal mesh and attaches standalone ActorX animation", async () => {
    const workspace = await unrealWorkspace({
      classes: {
        SM_Rock: ["StaticMesh", "BodySetup"],
        SK_Character: ["SkeletalMesh", "Skeleton"],
        A_Wave: ["AnimSequence"],
        BP_Spawner: ["Blueprint"],
      },
    });
    await writeFile(join(workspace.sourceDir, "Content", "Game", "SK_Character.uasset"), "cooked skeletal fixture");
    await writeFile(join(workspace.sourceDir, "Content", "Game", "A_Wave.uasset"), "cooked animation fixture");

    const exported = join(workspace.sourceDir, "..", "exported");
    const document = new Document();
    const buffer = document.createBuffer();
    const position = document
      .createAccessor("POSITION")
      .setType("VEC3")
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
      .setBuffer(buffer);
    const joints = document
      .createAccessor("JOINTS_0")
      .setType("VEC4")
      .setArray(new Uint16Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))
      .setBuffer(buffer);
    const weights = document
      .createAccessor("WEIGHTS_0")
      .setType("VEC4")
      .setArray(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]))
      .setBuffer(buffer);
    const primitive = document
      .createPrimitive()
      .setAttribute("POSITION", position)
      .setAttribute("JOINTS_0", joints)
      .setAttribute("WEIGHTS_0", weights);
    const mesh = document.createMesh("SK_Character").addPrimitive(primitive);
    const joint = document.createNode("root");
    const inverseBindMatrices = document
      .createAccessor("InverseBindMatrices")
      .setType("MAT4")
      .setArray(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]))
      .setBuffer(buffer);
    const skin = document
      .createSkin("CharacterSkeleton")
      .addJoint(joint)
      .setSkeleton(joint)
      .setInverseBindMatrices(inverseBindMatrices);
    const skinnedNode = document.createNode("SK_Character").setMesh(mesh).setSkin(skin);
    document.createScene().addChild(joint).addChild(skinnedNode);
    const times = document
      .createAccessor("AnimationTimes")
      .setType("SCALAR")
      .setArray(new Float32Array([0, 1]))
      .setBuffer(buffer);
    const translations = document
      .createAccessor("RootTranslations")
      .setType("VEC3")
      .setArray(new Float32Array([0, 0, 0, 0, 1, 0]))
      .setBuffer(buffer);
    const sampler = document
      .createAnimationSampler()
      .setInput(times)
      .setOutput(translations)
      .setInterpolation("LINEAR");
    document
      .createAnimation("Idle")
      .addSampler(sampler)
      .addChannel(
        document
          .createAnimationChannel()
          .setSampler(sampler)
          .setTargetNode(joint)
          .setTargetPath("translation"),
      );
    await new NodeIO().write(join(exported, "SK_Character.gltf"), document);
    await writePsaFixture(join(exported, "A_Wave.psa"));

    const report = await importUnrealDirectory({
      sourceDir: workspace.sourceDir,
      outputDir: workspace.outputDir,
      environment: workspace.environment,
      umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
    });

    const imported = report.models.find((model) => model.name === "SK_Character");
    expect(imported).toMatchObject({ kind: "skeletal", skins: 1, animations: 2 });
    const artifact = await new NodeIO().read(join(workspace.outputDir, imported!.glb));
    expect(artifact.getRoot().listSkins()).toHaveLength(1);
    expect(artifact.getRoot().listAnimations().map((animation) => animation.getName())).toEqual(["Idle", "Wave"]);
    expect(artifact.getRoot().listAnimations()[1]?.getExtras()).toMatchObject({
      unreal: { sourceFormat: "ActorX PSA", boneCoverage: 1 },
    });
    expect(report.warnings.join(" ")).toMatch(/Attached 1 standalone ActorX animation clip/);
    const importedPrimitive = artifact.getRoot().listMeshes()[0]?.listPrimitives()[0];
    expect(importedPrimitive?.getAttribute("JOINTS_0")).not.toBeNull();
    expect(importedPrimitive?.getAttribute("WEIGHTS_0")).not.toBeNull();
  });

  it("reconstructs a .umap as a directly loadable GLB scene", async () => {
    const workspace = await unrealWorkspace({
      classes: {
        SM_Rock: ["StaticMesh", "BodySetup"],
        Showcase: ["World", "Level", "StaticMeshActor", "StaticMeshComponent"],
        BP_Spawner: ["Blueprint"],
      },
    });
    const map = join(workspace.sourceDir, "Content", "Game", "Showcase.umap");
    const header = Buffer.alloc(32);
    header.writeUInt32LE(0x9e2a83c1, 0);
    header.writeInt32LE(-7, 4);
    header.writeInt32LE(864, 8);
    header.writeInt32LE(522, 12);
    await writeFile(map, header);

    const converter = join(workspace.sourceDir, "..", "unreal-assets-to-glb");
    const sceneSource = {
      format: "threenative-unreal-scene-source",
      version: 1,
      mapName: "Showcase",
      sourceFile: "Content/Game/Showcase.umap",
      actors: [
        {
          name: "Rock_A",
          meshName: "SM_Rock",
          location: { x: 100, y: 200, z: 300 },
          rotation: { pitch: 0, yaw: 0, roll: 0 },
          scale: { x: 1, y: 1, z: 1 },
          parent: "",
        },
        {
          name: "Rock_B",
          meshName: "SM_Rock",
          location: { x: 0, y: 0, z: 0 },
          rotation: { pitch: 0, yaw: 90, roll: 0 },
          scale: { x: 1, y: 1, z: 1 },
          parent: "",
        },
        {
          name: "BP_Lamp/InheritedMesh",
          meshName: "SM_Rock",
          location: { x: 400, y: 500, z: 600 },
          rotation: { pitch: 0, yaw: 0, roll: 0 },
          scale: { x: 1, y: 1, z: 1 },
          parent: "BP_Lamp",
        },
      ],
      instanceGroups: [
        {
          name: "Foliage/HISM_Rocks",
          meshName: "SM_Rock",
          parent: "InstancedFoliageActor_0",
          sourceClass: "FoliageInstancedStaticMeshComponent",
          transforms: [
            {
              location: { x: 100, y: 200, z: 300 },
              rotation: { pitch: 0, yaw: 0, roll: 0 },
              scale: { x: 1, y: 1, z: 1 },
            },
            {
              location: { x: 400, y: 500, z: 600 },
              rotation: { pitch: 0, yaw: 90, roll: 0 },
              scale: { x: 2, y: 2, z: 2 },
            },
          ],
        },
      ],
      lights: [
        {
          name: "BP_Lamp/InheritedSpot",
          type: "spot",
          location: { x: 400, y: 500, z: 700 },
          rotation: { pitch: -90, yaw: 0, roll: 0 },
          color: [1, 1, 1],
          intensity: 8000,
          range: 20,
          innerConeAngle: 50,
          outerConeAngle: 60,
          temperature: 3600,
          useTemperature: true,
          sourceWidth: 0,
          sourceHeight: 0,
        },
      ],
      blueprintComponents: 2,
      camera: {
        hasCamera: false,
        location: { x: 0, y: 0, z: 0 },
        rotation: { pitch: 0, yaw: 0, roll: 0 },
      },
    };
    await writeFile(
      converter,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const at = process.argv.indexOf("--scene-json-dir");
if (at >= 0) {
  const out = process.argv[at + 1];
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "Showcase.scene-source.json"), ${JSON.stringify(JSON.stringify(sceneSource))});
}
`,
    );
    await chmod(converter, 0o755);

    const report = await importUnrealDirectory({
      sourceDir: workspace.sourceDir,
      outputDir: workspace.outputDir,
      environment: workspace.environment,
      umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
      uncookedConverter: { name: "uncooked", path: converter, version: "Test scenes" },
    });

    expect(report.failed).toEqual([]);
    expect(report.counts).toMatchObject({ exported: 1, scenes: 1, failed: 0 });
    expect(report.scenes[0]).toMatchObject({
      actors: 3,
      resolvedActors: 3,
      instanceGroups: 1,
      instances: 2,
      resolvedInstances: 2,
      lights: 1,
      blueprintComponents: 2,
    });
    const scene = await new NodeIO()
      .registerExtensions([KHRLightsPunctual, EXTMeshGPUInstancing])
      .read(join(workspace.outputDir, report.scenes[0]!.glb));
    expect(scene.getRoot().listNodes()).toHaveLength(5);
    expect(scene.getRoot().listMeshes()).toHaveLength(1);
    expect(scene.getRoot().listNodes()[0]?.getTranslation()).toEqual([2, 3, -1]);
    const instanced = scene.getRoot().listNodes()[3]?.getExtension<InstancedMesh>("EXT_mesh_gpu_instancing");
    expect(instanced?.getAttribute("TRANSLATION")?.getCount()).toBe(2);
  });

  it("promotes meshes embedded in a modern map without reporting the map as a failed mesh", async () => {
    const workspace = await unrealWorkspace({
      classes: { Showcase: ["World", "Level", "StaticMesh", "StaticMeshActor", "StaticMeshComponent", "DirectionalLightComponent"] },
    });
    const map = join(workspace.sourceDir, "Content", "Game", "Showcase.umap");
    const header = Buffer.alloc(32);
    header.writeUInt32LE(0x9e2a83c1, 0);
    header.writeInt32LE(-8, 4);
    header.writeInt32LE(1009, 12);
    await writeFile(map, Buffer.concat([header, Buffer.from("World\0Level\0StaticMesh\0")]));

    const fixtureGltf = join(workspace.sourceDir, "..", "exported", "SM_Rock.gltf");
    const fixtureGlb = join(workspace.sourceDir, "..", "map-mesh.glb");
    await new NodeIO().write(fixtureGlb, await new NodeIO().read(fixtureGltf));
    const sceneSource = {
      format: "threenative-unreal-scene-source",
      version: 1,
      mapName: "Showcase",
      sourceFile: "Content/Game/Showcase.umap",
      actors: [{
        name: "Rock_A", meshName: "SM_Rock",
        location: { x: 100, y: 200, z: 300 }, rotation: { pitch: 0, yaw: 0, roll: 0 },
        scale: { x: 1, y: 1, z: 1 }, parent: "",
      }],
      lights: [{
        name: "Sun/LightComponent", type: "directional",
        location: { x: 0, y: 0, z: 0 }, rotation: { pitch: -45, yaw: 0, roll: 0 },
        color: [1, 1, 1], intensity: 6, range: 0,
        innerConeAngle: 0, outerConeAngle: 44, temperature: 6500,
        useTemperature: false, sourceWidth: 0, sourceHeight: 0,
      }],
      blueprintComponents: 0,
      camera: { hasCamera: false, location: { x: 0, y: 0, z: 0 }, rotation: { pitch: 0, yaw: 0, roll: 0 } },
    };
    const converter = join(workspace.sourceDir, "..", "modern-map-converter");
    await writeFile(converter, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const out = process.argv[process.argv.indexOf("--export-dir") + 1];
fs.mkdirSync(path.join(out, "Meshes"), { recursive: true });
fs.mkdirSync(path.join(out, "Scenes"), { recursive: true });
fs.copyFileSync(${JSON.stringify(fixtureGlb)}, path.join(out, "Meshes", "SM_Rock.glb"));
fs.writeFileSync(path.join(out, "Scenes", "Showcase.scene-source.json"), ${JSON.stringify(JSON.stringify(sceneSource))});
`);
    await chmod(converter, 0o755);

    const report = await importUnrealDirectory({
      sourceDir: workspace.sourceDir,
      outputDir: workspace.outputDir,
      environment: workspace.environment,
      umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
      modernConverter: { name: "modern", path: converter, version: "Test modern map" },
      onlyPackages: ["Showcase"],
    });

    expect(report.failed).toEqual([]);
    expect(report.counts).toMatchObject({ exported: 1, scenes: 1, failed: 0 });
    expect(report.models[0]).toMatchObject({ name: "SM_Rock", package: "Content/Game/Showcase.umap#SM_Rock" });
    expect(report.scenes[0]).toMatchObject({ actors: 1, resolvedActors: 1, lights: 1, unresolvedMeshes: [] });
    expect(report.models[0]?.glb).toBe("Models/__maps/Content/Game/Showcase/SM_Rock.glb");
  });

  it("imports serialized modern Blueprint components as a prefab without executing bytecode", async () => {
    const workspace = await unrealWorkspace({ classes: {}, listExitCode: 1 });
    const blueprint = join(workspace.sourceDir, "Content", "Game", "BP_Spawner.uasset");
    const header = Buffer.alloc(32);
    header.writeUInt32LE(0x9e2a83c1, 0);
    header.writeInt32LE(-9, 4);
    await writeFile(blueprint, Buffer.concat([header, Buffer.from("BlueprintGeneratedClass\0SimpleConstructionScript\0SCS_Node\0")]));

    const fixtureGltf = join(workspace.sourceDir, "..", "exported", "SM_Rock.gltf");
    const fixtureGlb = join(workspace.sourceDir, "..", "prefab-mesh.glb");
    await new NodeIO().write(fixtureGlb, await new NodeIO().read(fixtureGltf));
    const prefabSource = {
      format: "threenative-unreal-scene-source", version: 1, mapName: "BP_Spawner",
      sourceFile: "Content/Game/BP_Spawner.uasset",
      actors: [{ name: "BP_Spawner/Mesh", meshName: "SM_Rock", location: { x: 0, y: 0, z: 100 },
        rotation: { pitch: 0, yaw: 90, roll: 0 }, scale: { x: 1, y: 1, z: 1 }, parent: "BP_Spawner" }],
      lights: [], texts: [], instanceGroups: [], landscapes: [], blueprintComponents: 1,
      omittedActors: [{ actor: "BP_Spawner", component: "ExecuteUbergraph_BP_Spawner", sourceClass: "BlueprintGeneratedClass", reason: "Blueprint bytecode is not executed" }],
      camera: { hasCamera: false, location: { x: 0, y: 0, z: 0 }, rotation: { pitch: 0, yaw: 0, roll: 0 } },
    };
    const converter = join(workspace.sourceDir, "..", "modern-prefab-converter");
    await writeFile(converter, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const out = process.argv[process.argv.indexOf("--export-dir") + 1];
fs.mkdirSync(path.join(out, "Meshes"), { recursive: true });
fs.mkdirSync(path.join(out, "Scenes"), { recursive: true });
fs.copyFileSync(${JSON.stringify(fixtureGlb)}, path.join(out, "Meshes", "SM_Rock.glb"));
fs.writeFileSync(path.join(out, "Scenes", "BP_Spawner.prefab-source.json"), ${JSON.stringify(JSON.stringify(prefabSource))});
`);
    await chmod(converter, 0o755);

    const report = await importUnrealDirectory({
      sourceDir: workspace.sourceDir, outputDir: workspace.outputDir, environment: workspace.environment,
      umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
      modernConverter: { name: "modern", path: converter, version: "Test prefab" }, onlyPackages: ["BP_Spawner"],
    });

    expect(report.failed).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(report.models[0]).toMatchObject({ name: "SM_Rock", kind: "static", glb: "Models/__prefabs/Content/Game/BP_Spawner/SM_Rock.glb" });
    expect(report.scenes[0]).toMatchObject({ name: "BP_Spawner", actors: 1, resolvedActors: 1, blueprintComponents: 1 });
    expect(report.scenes[0]?.omittedActors[0]?.reason).toMatch(/bytecode is not executed/);
  });

  it("falls back to MeshDescription for uncooked editor meshes and keeps UE Viewer materials", async () => {
    const workspace = await unrealWorkspace();
    const sourceMesh = join(workspace.sourceDir, "Content", "Game", "SM_Rock.uasset");
    const uncookedHeader = Buffer.alloc(32);
    uncookedHeader.writeUInt32LE(0x9e2a83c1, 0);
    uncookedHeader.writeInt32LE(-7, 4);
    uncookedHeader.writeInt32LE(864, 8);
    uncookedHeader.writeInt32LE(522, 12);
    await writeFile(sourceMesh, Buffer.concat([uncookedHeader, Buffer.from("SourceModels\0AssetImportData\0")]));

    const fixtureGltf = join(workspace.sourceDir, "..", "exported", "SM_Rock.gltf");
    const converterFixture = join(workspace.sourceDir, "..", "uncooked.glb");
    await new NodeIO().write(converterFixture, await new NodeIO().read(fixtureGltf));
    const converter = join(workspace.sourceDir, "..", "unreal-assets-to-glb");
    await writeFile(
      converter,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
if (process.argv.includes("--help")) { console.log("UE 4.27 UAsset Parser"); process.exit(0); }
const at = process.argv.indexOf("--export-dir");
const out = process.argv[at + 1];
fs.mkdirSync(path.join(out, "Meshes"), { recursive: true });
fs.copyFileSync(${JSON.stringify(converterFixture)}, path.join(out, "Meshes", "SM_Rock.glb"));
`,
    );
    await chmod(converter, 0o755);

    const report = await importUnrealDirectory({
      sourceDir: workspace.sourceDir,
      outputDir: workspace.outputDir,
      environment: workspace.environment,
      umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
      uncookedConverter: { name: "uncooked", path: converter, version: "Test MeshDescription" },
    });

    expect(report.counts.exported).toBe(1);
    expect(report.toolchain.uncookedConverter).toBe("Test MeshDescription");
    expect(report.warnings.join(" ")).toMatch(/without Unreal Engine/);
    expect(report.models[0]?.materials[0]?.textured).toBe(true);
    expect(report.models[0]?.boundsMetres[0]).toBeLessThan(0.1);
    const artifact = await new NodeIO().read(join(workspace.outputDir, report.models[0]?.glb ?? ""));
    expect(artifact.getRoot().listMaterials()[0]?.getBaseColorTexture()).not.toBeNull();
  });

  // Object versions of the real FAB packs verified end to end: UE4.0–4.3 (401, 434), 4.15 (510),
  // 4.18 (514), 4.19 (515), and 4.20 (516).
  it.each([401, 434, 510, 514, 515, 516])("accepts a version-%i uncooked package through UE Viewer instead of the MeshDescription path", async (version) => {
    const workspace = await unrealWorkspace();
    const sourceMesh = join(workspace.sourceDir, "Content", "Game", "SM_Rock.uasset");
    const legacyHeader = Buffer.alloc(32);
    legacyHeader.writeUInt32LE(0x9e2a83c1, 0);
    legacyHeader.writeInt32LE(-7, 4);
    legacyHeader.writeInt32LE(864, 8);
    legacyHeader.writeInt32LE(version, 12);
    await writeFile(sourceMesh, Buffer.concat([legacyHeader, Buffer.from("SourceModels\0AssetImportData\0")]));

    const invoked = join(workspace.sourceDir, "..", "uncooked-converter-invoked");
    const converter = join(workspace.sourceDir, "..", "unreal-assets-to-glb");
    await writeFile(
      converter,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(invoked)}, "ran");
process.exit(1);
`,
    );
    await chmod(converter, 0o755);

    const report = await importUnrealDirectory({
      sourceDir: workspace.sourceDir,
      outputDir: workspace.outputDir,
      environment: workspace.environment,
      umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
      uncookedConverter: { name: "uncooked", path: converter, version: "Test MeshDescription" },
    });

    expect(report.failed).toEqual([]);
    expect(report.counts.exported).toBe(1);
    expect(report.toolchain.uncookedConverter).toBeUndefined();
    expect(report.warnings.join(" ")).not.toMatch(/without Unreal Engine/);
    await expect(readFile(invoked, "utf8")).rejects.toThrow();
  });

  it("still refuses an uncooked package newer than the verified 517–522 MeshDescription range", async () => {
    const workspace = await unrealWorkspace();
    const sourceMesh = join(workspace.sourceDir, "Content", "Game", "SM_Rock.uasset");
    const header = Buffer.alloc(32);
    header.writeUInt32LE(0x9e2a83c1, 0);
    header.writeInt32LE(-7, 4);
    header.writeInt32LE(864, 8);
    header.writeInt32LE(523, 12);
    await writeFile(sourceMesh, Buffer.concat([header, Buffer.from("SourceModels\0AssetImportData\0")]));

    await expect(
      importUnrealDirectory({
        sourceDir: workspace.sourceDir,
        outputDir: workspace.outputDir,
        environment: workspace.environment,
        umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
      }),
    ).rejects.toThrow(/version 523/);
  });

  it("converts static meshes, textures the materials, and reports everything it skipped", async () => {
    const workspace = await unrealWorkspace();
    const report = await importUnrealDirectory({
      sourceDir: workspace.sourceDir,
      outputDir: workspace.outputDir,
      environment: workspace.environment,
      umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
    });

    expect(report.counts.exported).toBe(1);
    expect(report.counts.failed).toBe(0);
    expect(report.materials).toBe("complete");
    expect(report.materialCoverage.textured).toBe(1);

    // The level and the Blueprint are named, not silently dropped.
    expect(report.skipped.map((entry) => entry.package)).toEqual(
      expect.arrayContaining([
        "Content/Game/Showcase.umap",
        "Content/Game/BP_Spawner.uasset",
      ]),
    );
    expect(report.skipped.find((entry) => entry.package.endsWith(".umap"))?.reason).toMatch(
      /Unreal level/,
    );

    const model = report.models[0];
    if (!model) throw new Error("expected one model");
    const glb = join(workspace.outputDir, model.glb);
    const document = await new NodeIO().read(glb);
    const material = document.getRoot().listMaterials()[0];
    if (!material) throw new Error("expected a material");

    // Re-read from the written artifact: a report literal would prove nothing.
    expect(material.getBaseColorTexture()?.getImage()?.byteLength).toBeGreaterThan(0);
    expect(material.getNormalTexture()?.getImage()?.byteLength).toBeGreaterThan(0);
    expect(material.getMetallicRoughnessTexture()?.getImage()?.byteLength).toBeGreaterThan(0);
    // UE Viewer's debug colour never survives.
    expect(material.getBaseColorFactor()).toEqual([1, 1, 1, 1]);
  });

  it("promotes duplicate-named standalone Texture2D packages with collision-free paths", async () => {
    const workspace = await unrealWorkspace({
      classes: {
        SM_Rock: ["StaticMesh", "BodySetup"],
        T_Rock_D_R: ["AssetImportData", "Texture2D"],
        BP_Spawner: ["Blueprint"],
      },
    });
    const first = join(workspace.sourceDir, "Content", "Game", "Textures", "Paper_1");
    const second = join(workspace.sourceDir, "Content", "Game", "Textures", "Paper_2");
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    await writeFile(join(first, "T_Rock_D_R.uasset"), "texture one");
    await writeFile(join(second, "T_Rock_D_R.uasset"), "texture two");

    const report = await importUnrealDirectory({
      sourceDir: workspace.sourceDir,
      outputDir: workspace.outputDir,
      environment: workspace.environment,
      maxTextureSize: 64,
      umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
    });

    expect(report.counts).toMatchObject({ exported: 1, textures: 2, failed: 0 });
    expect(report.textures.map((texture) => texture.name)).toEqual(["T_Rock_D_R", "T_Rock_D_R"]);
    expect(new Set(report.textures.map((texture) => texture.png)).size).toBe(2);
    for (const texture of report.textures) {
      expect(texture.png).toMatch(/^textures\/Content\/Game\/Textures\/Paper_[12]\/T_Rock_D_R\.png$/);
      expect((await stat(join(workspace.outputDir, texture.png))).size).toBeGreaterThan(0);
      expect(texture).toMatchObject({ width: 2, height: 2 });
    }
    expect(report.skipped.some((entry) => entry.reason.includes("Texture2D"))).toBe(false);
  });

  it("promotes duplicate-named SoundWave packages with collision-free paths", async () => {
    const workspace = await unrealWorkspace({
      classes: {
        SM_Rock: ["StaticMesh"],
        A_Chime: ["SoundWave", "AssetImportData"],
        BP_Spawner: ["Blueprint"],
      },
    });
    await writeWavFixture(join(workspace.sourceDir, "..", "exported", "A_Chime.wav"), 8_000, 800);
    for (const group of ["UI", "World"]) {
      const directory = join(workspace.sourceDir, "Content", "Game", "Audio", group);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "A_Chime.uasset"), `sound ${group}`);
    }

    const report = await importUnrealDirectory({
      sourceDir: workspace.sourceDir,
      outputDir: workspace.outputDir,
      environment: workspace.environment,
      umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
    });

    expect(report.counts).toMatchObject({ audio: 2, failed: 0 });
    expect(new Set(report.audio.map((entry) => entry.file)).size).toBe(2);
    for (const entry of report.audio) {
      expect(entry.file).toMatch(/^audio\/Content\/Game\/Audio\/(UI|World)\/A_Chime\.wav$/);
      expect(entry).toMatchObject({ durationSeconds: 0.1, channels: 1, sampleRate: 8_000 });
      expect((await stat(join(workspace.outputDir, entry.file))).size).toBeGreaterThan(44);
    }
  });

  it("packages duplicate-named standalone Materials into one directly loadable GLB", async () => {
    const workspace = await unrealWorkspace({
      classes: {
        SM_Rock: ["StaticMesh", "BodySetup"],
        M_Rock: ["Material", "MaterialExpressionTextureSample"],
        BP_Spawner: ["Blueprint"],
      },
    });
    for (const group of ["Stone", "Moss"]) {
      const directory = join(workspace.sourceDir, "Content", "Game", "Materials", group);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "M_Rock.uasset"), `material ${group}`);
    }

    const report = await importUnrealDirectory({
      sourceDir: workspace.sourceDir,
      outputDir: workspace.outputDir,
      environment: workspace.environment,
      maxTextureSize: 64,
      umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
    });

    expect(report.counts).toMatchObject({ materialAssets: 2, failed: 0 });
    expect(new Set(report.materialAssets.map((material) => material.libraryName)).size).toBe(2);
    expect(new Set(report.materialAssets.map((material) => material.glb))).toEqual(
      new Set(["Materials/UnrealMaterialLibrary.glb"]),
    );
    const library = await new NodeIO().read(
      join(workspace.outputDir, "Materials", "UnrealMaterialLibrary.glb"),
    );
    expect(library.getRoot().listMaterials()).toHaveLength(2);
    for (const material of library.getRoot().listMaterials()) {
      expect(material.getName()).toMatch(/Materials\/(Stone|Moss)\/M_Rock$/);
      expect(material.getBaseColorTexture()?.getImage()?.byteLength).toBeGreaterThan(0);
      expect(material.getNormalTexture()?.getImage()?.byteLength).toBeGreaterThan(0);
    }
    expect(report.skipped.some((entry) => entry.reason.includes("Material"))).toBe(false);
  });

  it("keeps a metadata-free glass Material as an explicit reusable fallback", async () => {
    const workspace = await unrealWorkspace({
      classes: {
        SM_Rock: ["StaticMesh"],
        M_Glass: ["Material", "MaterialExpressionScalarParameter"],
        BP_Spawner: ["Blueprint"],
      },
      emptyExports: ["M_Glass"],
    });
    await writeFile(join(workspace.sourceDir, "Content", "Game", "M_Glass.uasset"), "glass");

    const report = await importUnrealDirectory({
      sourceDir: workspace.sourceDir,
      outputDir: workspace.outputDir,
      environment: workspace.environment,
      umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
    });

    expect(report.counts).toMatchObject({ materialAssets: 1, failed: 0 });
    expect(report.materialAssets[0]).toMatchObject({
      name: "M_Glass",
      resolved: false,
      alphaMode: "BLEND",
      textured: false,
    });
    expect(report.materialAssets[0]?.factors.baseColor[3]).toBeCloseTo(0.22);
    expect(report.warnings.join(" ")).toMatch(/no UE Viewer PBR metadata/);
    const library = await new NodeIO().read(
      join(workspace.outputDir, "Materials", "UnrealMaterialLibrary.glb"),
    );
    expect(library.getRoot().listMaterials()[0]?.getAlphaMode()).toBe("BLEND");
  });

  it("writes separate vertex layout, which the native host requires", async () => {
    const workspace = await unrealWorkspace();
    const report = await importUnrealDirectory({
      sourceDir: workspace.sourceDir,
      outputDir: workspace.outputDir,
      environment: workspace.environment,
      umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
    });
    const model = report.models[0];
    if (!model) throw new Error("expected one model");
    // An interleaved buffer view renders on the web and fails createRenderPipeline on native.
    expect(interleavedBufferViews(await readFile(join(workspace.outputDir, model.glb)))).toBe(0);
  });

  it("drops UE Viewer's all-zero tangents and its lightmap UV sets", async () => {
    const workspace = await unrealWorkspace({ degenerateTangents: true });
    const report = await importUnrealDirectory({
      sourceDir: workspace.sourceDir,
      outputDir: workspace.outputDir,
      environment: workspace.environment,
      umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
    });
    expect(report.warnings.join(" ")).toMatch(/zero-length TANGENT/);
    expect(report.warnings.join(" ")).toMatch(/extra UV channels/);

    const model = report.models[0];
    if (!model) throw new Error("expected one model");
    const document = await new NodeIO().read(join(workspace.outputDir, model.glb));
    const primitive = document.getRoot().listMeshes()[0]?.listPrimitives()[0];
    expect(primitive?.getAttribute("TANGENT")).toBeNull();
    expect(primitive?.getAttribute("TEXCOORD_1")).toBeNull();
    expect(primitive?.getAttribute("TEXCOORD_0")).not.toBeNull();
  });

  it("renames a section UE Viewer could not resolve and never calls it textured", async () => {
    const workspace = await unrealWorkspace();
    // The fixture's material is named by the mesh fixture; rewrite it to umodel's placeholder.
    const exported = join(workspace.sourceDir, "..", "exported");
    const gltfPath = join(exported, "SM_Rock.gltf");
    const document = await new NodeIO().read(gltfPath);
    document.getRoot().listMaterials()[0]?.setName("dummy_material_0");
    await new NodeIO().write(gltfPath, document);

    const report = await importUnrealDirectory({
      sourceDir: workspace.sourceDir,
      outputDir: workspace.outputDir,
      environment: workspace.environment,
      umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
    });
    const section = report.models[0]?.materials[0];
    expect(section?.name).toMatch(/_unresolved_section_\d+$/);
    expect(section?.name).not.toMatch(/dummy_material/);
    expect(section?.resolved).toBe(false);
    expect(report.materials).toBe("degraded");
    expect(report.materialCoverage.unresolved).toBe(1);
  });

  it("reuses an identical import and refuses to overwrite a different one", async () => {
    const workspace = await unrealWorkspace();
    const request = {
      sourceDir: workspace.sourceDir,
      outputDir: workspace.outputDir,
      environment: workspace.environment,
      umodel: { name: "umodel" as const, path: workspace.umodel, version: "Test" },
    };
    const first = await importUnrealDirectory(request);
    expect(first.reused).toBe(false);
    const second = await importUnrealDirectory(request);
    expect(second.reused).toBe(true);
    expect(second.cacheKey).toBe(first.cacheKey);

    await expect(
      importUnrealDirectory({ ...request, maxTextureSize: 256 }),
    ).rejects.toThrow(/already holds a different import/);
  });

  it("isolates staging for concurrent imports with the same cache key", async () => {
    const workspace = await unrealWorkspace();
    const secondOutput = join(dirname(workspace.outputDir), "pack-copy");
    const request = {
      sourceDir: workspace.sourceDir,
      environment: workspace.environment,
      umodel: { name: "umodel" as const, path: workspace.umodel, version: "Test" },
    };
    const [first, second] = await Promise.all([
      importUnrealDirectory({ ...request, outputDir: workspace.outputDir }),
      importUnrealDirectory({ ...request, outputDir: secondOutput }),
    ]);
    expect(first.cacheKey).toBe(second.cacheKey);
    expect(first.counts.failed).toBe(0);
    expect(second.counts.failed).toBe(0);
    expect((await stat(join(workspace.outputDir, first.models[0]!.glb))).size).toBeGreaterThan(0);
    expect((await stat(join(secondOutput, second.models[0]!.glb))).size).toBeGreaterThan(0);
  });

  it("fails without promoting anything when UE Viewer exits nonzero", async () => {
    const workspace = await unrealWorkspace({ exportExitCode: 3 });
    await expect(
      importUnrealDirectory({
        sourceDir: workspace.sourceDir,
        outputDir: workspace.outputDir,
        environment: workspace.environment,
        umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
      }),
    ).rejects.toThrow(/No package produced a valid model, texture, cubemap, material, audio, font, bitmap font, sprite, flipbook, data asset, texture stack, or scene/);
    await expect(stat(workspace.outputDir)).rejects.toThrow();
  });

  it("fails without promoting anything when the exported buffer is corrupt", async () => {
    const workspace = await unrealWorkspace({ corruptBuffer: true });
    await expect(
      importUnrealDirectory({
        sourceDir: workspace.sourceDir,
        outputDir: workspace.outputDir,
        environment: workspace.environment,
        umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
      }),
    ).rejects.toThrow(ImportError);
    await expect(stat(workspace.outputDir)).rejects.toThrow();
  });

  it("fails when no package in the directory holds an importable mesh, texture, material, or level", async () => {
    const workspace = await unrealWorkspace({ classes: { SM_Rock: ["DataAsset"] } });
    await expect(
      importUnrealDirectory({
        sourceDir: workspace.sourceDir,
        outputDir: workspace.outputDir,
        environment: workspace.environment,
        umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
      }),
    ).rejects.toThrow(/contains a supported StaticMesh, SkeletalMesh, Texture2D, TextureCube, multidimensional texture, Material, SoundWave, Font, PaperSprite, PaperFlipbook, structured data, or Level/);
  });

  it("refuses a source directory that is not there", async () => {
    const workspace = await unrealWorkspace();
    await expect(
      importUnrealDirectory({
        sourceDir: join(workspace.sourceDir, "missing"),
        outputDir: workspace.outputDir,
        environment: workspace.environment,
        umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
      }),
    ).rejects.toThrow(/not a readable directory/);
  });

  it("sizes only the requested packages in the disk pre-flight", async () => {
    const workspace = await unrealWorkspace();
    // Sparse sidecars: 800 MiB of unrequested bulk data, so the whole tree needs more than the
    // free space below while the one requested mesh fits.
    for (const [name, bytes] of [["SM_Colossus_A", 400], ["SM_Colossus_B", 400]] as const) {
      const sidecar = join(workspace.sourceDir, "Content", "Game", `${name}.uexp`);
      await writeFile(sidecar, "x");
      await truncate(sidecar, bytes * 1024 * 1024);
    }
    const freeSpaceBytes = Math.round(2.25 * 1024 ** 3);

    const report = await importUnrealDirectory({
      sourceDir: workspace.sourceDir,
      outputDir: workspace.outputDir,
      environment: workspace.environment,
      umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
      onlyPackages: ["SM_Rock"],
      freeSpaceBytes,
    });
    expect(report.counts).toMatchObject({ exported: 1, failed: 0 });

    await expect(
      importUnrealDirectory({
        sourceDir: workspace.sourceDir,
        outputDir: join(workspace.outputDir, "whole-tree"),
        environment: workspace.environment,
        umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
        freeSpaceBytes,
      }),
    ).rejects.toMatchObject({ code: "UNREAL_DISK_SPACE" });

    // The converters only take a filter for a single package, so two requested packages convert the
    // whole source tree: sizing only those two would under-count what the import actually reads.
    await expect(
      importUnrealDirectory({
        sourceDir: workspace.sourceDir,
        outputDir: join(workspace.outputDir, "two-packages"),
        environment: workspace.environment,
        umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
        onlyPackages: ["SM_Rock", "BP_Spawner"],
        freeSpaceBytes,
      }),
    ).rejects.toMatchObject({ code: "UNREAL_DISK_SPACE" });
  }, 60_000);

  it("says why the modern converter produced nothing for a static mesh", async () => {
    const workspace = await unrealWorkspace({ classes: {}, listExitCode: 1 });
    const header = Buffer.alloc(32);
    header.writeUInt32LE(0x9e2a83c1, 0);
    header.writeInt32LE(-8, 4);
    header.writeUInt32LE(1009, 12);
    header.writeUInt32LE(1008, 16);
    await writeFile(
      join(workspace.sourceDir, "Content", "Game", "SM_Rock.uasset"),
      Buffer.concat([header, Buffer.from("StaticMesh\0Default__StaticMesh\0")]),
    );
    const converter = await writeFailingModernConverter(workspace);

    const error = await importUnrealDirectory({
      sourceDir: workspace.sourceDir,
      outputDir: workspace.outputDir,
      environment: workspace.environment,
      umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
      modernConverter: { name: "modern", path: converter, version: "Test failing" },
      onlyPackages: ["SM_Rock"],
    }).then(
      () => undefined,
      (reason: unknown) => reason as ToolchainError,
    );

    expect(error?.code).toBe("UNREAL_TOOL_FAILED");
    expect(error?.message).toContain("ThreeNativeConverter 0.2.1");
    // The earlier lines carry the reason; the last line alone only says it stopped.
    expect(error?.message).toContain("warning: FStaticMeshRenderData is absent from the package");
    expect(error?.message).toContain("UE4 object version 1009");
    expect(error?.message).toContain("UE5 object version 1008");
    expect(error?.message).toContain("Nanite: not detected");
  });

  it("retries a static mesh the modern converter cannot read through UE Viewer", async () => {
    const workspace = await unrealWorkspace({ classes: {}, listExitCode: 1 });
    const header = Buffer.alloc(32);
    header.writeUInt32LE(0x9e2a83c1, 0);
    header.writeInt32LE(-8, 4);
    // Below UE4.25, so UE Viewer reads this mesh itself and the modern converter was never needed.
    header.writeUInt32LE(500, 12);
    await writeFile(
      join(workspace.sourceDir, "Content", "Game", "SM_Rock.uasset"),
      Buffer.concat([header, Buffer.from("StaticMesh\0Default__StaticMesh\0NaniteSettings\0")]),
    );
    const converter = await writeFailingModernConverter(workspace);

    const report = await importUnrealDirectory({
      sourceDir: workspace.sourceDir,
      outputDir: workspace.outputDir,
      environment: workspace.environment,
      umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
      modernConverter: { name: "modern", path: converter, version: "Test failing" },
      onlyPackages: ["SM_Rock"],
    });

    expect(report.failed).toEqual([]);
    expect(report.counts).toMatchObject({ exported: 1, failed: 0 });
    expect(report.models[0]).toMatchObject({ name: "SM_Rock", kind: "static" });
  });

  it("promotes nothing when only some modern packages can fall back to UE Viewer", async () => {
    const workspace = await unrealWorkspace({ classes: {}, listExitCode: 1 });
    const readable = Buffer.alloc(32);
    readable.writeUInt32LE(0x9e2a83c1, 0);
    readable.writeInt32LE(-8, 4);
    // Below UE4.25, so UE Viewer reads this mesh itself and the modern converter was never needed.
    readable.writeInt32LE(500, 12);
    await writeFile(
      join(workspace.sourceDir, "Content", "Game", "SM_Rock.uasset"),
      Buffer.concat([readable, Buffer.from("StaticMesh\0Default__StaticMesh\0NaniteSettings\0")]),
    );
    // A UE5-era static mesh that UE Viewer can no longer read: recovering the other one silently
    // would drop this package, so the converter's own diagnostic is the honest answer.
    const unreadable = Buffer.alloc(32);
    unreadable.writeUInt32LE(0x9e2a83c1, 0);
    unreadable.writeInt32LE(-8, 4);
    unreadable.writeInt32LE(1009, 12);
    await writeFile(
      join(workspace.sourceDir, "Content", "Game", "SM_Tree.uasset"),
      Buffer.concat([unreadable, Buffer.from("StaticMesh\0Default__StaticMesh\0")]),
    );
    const converter = await writeFailingModernConverter(workspace);

    const error = await importUnrealDirectory({
      sourceDir: workspace.sourceDir,
      outputDir: workspace.outputDir,
      environment: workspace.environment,
      umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
      modernConverter: { name: "modern", path: converter, version: "Test failing" },
      onlyPackages: ["SM_Rock", "SM_Tree"],
    }).then(
      () => undefined,
      (reason: unknown) => reason as ToolchainError,
    );

    expect(error?.code).toBe("UNREAL_TOOL_FAILED");
    expect(error?.message).toContain("SM_Tree.uasset is UE5 (legacy file version -8), UE4 object version 1009");
    expect(error?.message).toContain("fatal: no geometry to write");
    await expect(stat(workspace.outputDir)).rejects.toThrow();
  });
});

describe("uncooked converter provisioning", () => {
  it("aligns the converter's package-owner version gates with Unreal's own", () => {
    const source = "VER_UE4_ADDED_PACKAGE_OWNER = 517\nVER_UE4_NON_OUTER_PACKAGE_IMPORT = 519\n";
    const patched = patchUncookedPackageVersionGates(source);
    expect(patched).toContain("VER_UE4_ADDED_PACKAGE_OWNER = 518");
    expect(patched).toContain("VER_UE4_NON_OUTER_PACKAGE_IMPORT = 520");
    expect(patchUncookedPackageVersionGates(patched)).toBe(patched);
  });
});

describe("the CLI and the MCP tool are one code path", () => {
  it("produces byte-identical GLBs from the same directory", async () => {
    const workspace = await unrealWorkspace();
    const viaLibrary = await importUnrealDirectory({
      sourceDir: workspace.sourceDir,
      outputDir: join(workspace.outputDir, "library"),
      environment: workspace.environment,
      umodel: { name: "umodel", path: workspace.umodel, version: "Test" },
    });

    const previous = process.env.THREENATIVE_UMODEL_PATH;
    const previousCache = process.env.THREENATIVE_UNREAL_CACHE_DIR;
    process.env.THREENATIVE_UMODEL_PATH = workspace.umodel;
    process.env.THREENATIVE_UNREAL_CACHE_DIR = workspace.environment.THREENATIVE_UNREAL_CACHE_DIR ?? "";
    try {
      const result = await runImportCli([
        workspace.sourceDir,
        "--out",
        join(workspace.outputDir, "cli"),
        "--json",
      ]);
      expect(result.exitCode).toBe(0);
      const summary = JSON.parse(result.stdout) as { models: { glb: string }[] };
      const model = viaLibrary.models[0];
      const cliModel = summary.models[0];
      if (!model || !cliModel) throw new Error("expected one model from each path");
      expect(cliModel.glb).toBe(model.glb);
      expect(await readFile(join(workspace.outputDir, "cli", cliModel.glb))).toEqual(
        await readFile(join(workspace.outputDir, "library", model.glb)),
      );
    } finally {
      if (previous === undefined) delete process.env.THREENATIVE_UMODEL_PATH;
      else process.env.THREENATIVE_UMODEL_PATH = previous;
      if (previousCache === undefined) delete process.env.THREENATIVE_UNREAL_CACHE_DIR;
      else process.env.THREENATIVE_UNREAL_CACHE_DIR = previousCache;
    }
  });

  it("prints usage and exits nonzero without an output directory", async () => {
    const result = await runImportCli(["/some/pack"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/--out <directory>/);
  });
});

describe("uncookedMeshRoute", () => {
  it("sends every pre-MeshDescription version to UE Viewer, static and skeletal alike", () => {
    for (const version of [401, 434, 510, 514, 515, 516]) {
      expect(uncookedMeshRoute("static", version)).toBe("umodel");
      expect(uncookedMeshRoute("skeletal", version)).toBe("umodel");
    }
  });

  it("keeps 517–522 static meshes on the converter, newer skeletal on the modern path, and refuses the rest", () => {
    expect(uncookedMeshRoute("static", 517)).toBe("mesh-description");
    expect(uncookedMeshRoute("static", 522)).toBe("mesh-description");
    expect(uncookedMeshRoute("static", 523)).toBeUndefined();
    expect(uncookedMeshRoute("static", undefined)).toBeUndefined();
    expect(uncookedMeshRoute("skeletal", 517)).toBe("modern");
    expect(uncookedMeshRoute("skeletal", undefined)).toBe("modern");
  });
});
