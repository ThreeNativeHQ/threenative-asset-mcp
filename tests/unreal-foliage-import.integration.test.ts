import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { KHRMaterialsSpecular, type Specular } from "@gltf-transform/extensions";
import { afterEach, describe, expect, it } from "vitest";

import { importUnrealDirectory } from "../src/unreal/importer.js";
import { writeFakeUmodel, writeMeshFixture, writePng } from "./helpers/unreal-fixture.js";
import { float, input, materialPackage, subsetInstance } from "./helpers/unreal-material-source.js";

/**
 * End to end through the real importer (fake umodel only): synthetic uasset bytes -> name-table hint -> classification ->
 * unmipped sampler, and a constant Specular input -> KHR_materials_specular on the exported GLB. The unit tests drive each
 * stage with hand-supplied inputs; these prove the stages are wired together (a mutation of the importer's classification
 * glue left every other test green).
 */
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** A package head the cooking reader accepts: the magic, a UE4 version block, then length-prefixed names. */
function textureHead(names: readonly string[]): Buffer {
  const header = Buffer.alloc(24);
  header.writeUInt32LE(0x9e2a83c1, 0);
  header.writeInt32LE(-7, 4);
  header.writeInt32LE(864, 8);
  header.writeInt32LE(516, 12);
  header.writeInt32LE(names.length, 20);
  return Buffer.concat([
    header,
    ...names.map((name) => {
      const bytes = Buffer.from(`${name}\0`, "latin1");
      const length = Buffer.alloc(4);
      length.writeInt32LE(bytes.length, 0);
      return Buffer.concat([length, bytes, Buffer.alloc(4)]);
    }),
  ]);
}

/** A master whose Specular input is a constant, as the conifer pack's foliage masters have (0.1). */
function specularMaster(value: number): Buffer {
  return materialPackage([
    { name: "Master", className: "Material", properties: [input("Specular", 2)] },
    { name: "SpecularConstant", className: "MaterialExpressionConstant", properties: [float("R", value)] },
  ]);
}

async function importLeaf(options: { aoroTagged: boolean; specular: number }) {
  const directory = await mkdtemp(join(tmpdir(), "foliage-import-"));
  directories.push(directory);
  const sourceDir = join(directory, "source");
  const kit = join(sourceDir, "Content", "Kit");
  const fixture = join(directory, "fixture");
  const outputDir = join(directory, "output");
  await mkdir(kit, { recursive: true });
  await writeFile(join(kit, "Master.uasset"), specularMaster(options.specular));
  await writeFile(join(kit, "Instance.uasset"), subsetInstance());
  await writeFile(join(kit, "Leaf_A.uasset"), textureHead(["AssetImportData", "Texture2D", "TextureSource"]));
  await writeFile(
    join(kit, "Leaf_AORO.uasset"),
    textureHead(options.aoroTagged ? ["AssetImportData", "Texture2D", "MipGenSettings", "TMGS_NoMipmaps"] : ["AssetImportData", "Texture2D"]),
  );
  await writeFile(join(kit, "Mesh.uasset"), Buffer.alloc(16));
  await writeMeshFixture(fixture, {
    name: "Mesh",
    materialName: "Instance",
    mat: "Diffuse=Leaf_A\nOpacity=Leaf_A\nOther[0]=Leaf_AORO\n",
    props: "BlendMode = BLEND_Masked (1)\nOpacityMaskClipValue = 0.333\nTwoSided = true\n",
    textures: [],
  });
  await writePng(join(fixture, "Leaf_A.png"), [110, 120, 50, 255]);
  await writePng(join(fixture, "Leaf_AORO.png"), [200, 150, 255, 255]);
  const tool = join(directory, "umodel");
  await writeFakeUmodel(tool, {
    exportFrom: fixture,
    emptyExports: ["Master"],
    classes: { Mesh: ["StaticMesh"], Master: ["Material"], Instance: ["MaterialInstanceConstant"], Leaf_A: ["Texture2D"], Leaf_AORO: ["Texture2D"] },
  });
  const report = await importUnrealDirectory({ sourceDir, outputDir, concurrency: 1, graphBake: false, freeSpaceBytes: 30_000_000_000, umodel: { name: "umodel", path: tool, version: "fixture" } });
  const document = await new NodeIO().registerExtensions([KHRMaterialsSpecular]).read(join(outputDir, report.models[0]!.glb));
  return { report, material: document.getRoot().listMaterials()[0]! };
}

describe("masked foliage through the real importer", () => {
  it("unmips the base colour sampler when the packed opacity map's package says TMGS_NoMipmaps", async () => {
    const { material, report } = await importLeaf({ aoroTagged: true, specular: 0.1 });
    expect(material.getAlphaMode()).toBe("MASK");
    expect(report.models[0]!.materials[0]!.bindings.find((b) => b.slot === "baseColor")?.secondaryTexture).toBe("Leaf_AORO");
    expect(material.getBaseColorTextureInfo()!.getMinFilter()).toBe(9729);
    expect(material.getBaseColorTextureInfo()!.getMagFilter()).toBe(9729);
  });

  it("keeps the default mipmapped sampler for the same material when the package carries no tag", async () => {
    const { material } = await importLeaf({ aoroTagged: false, specular: 0.1 });
    expect(material.getBaseColorTextureInfo()!.getMinFilter()).toBeNull();
  });

  it("writes an authored constant Specular 0.1 as KHR_materials_specular 0.2, and nothing at the default 0.5", async () => {
    const low = await importLeaf({ aoroTagged: false, specular: 0.1 });
    expect(low.material.getExtension<Specular>("KHR_materials_specular")?.getSpecularFactor()).toBeCloseTo(0.2, 6);
    const normal = await importLeaf({ aoroTagged: false, specular: 0.5 });
    expect(normal.material.getExtension("KHR_materials_specular")).toBeNull();
  });
});
