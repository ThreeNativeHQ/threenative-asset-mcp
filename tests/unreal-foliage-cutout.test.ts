import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { KHRMaterialsSpecular } from "@gltf-transform/extensions";
import { afterEach, describe, expect, it } from "vitest";

import { readPackageCooking } from "../src/unreal/cooking.js";
import { packageGlb } from "../src/unreal/importer.js";
import type { SourceMaterial } from "../src/unreal/source-material.js";
import { writeMeshFixture, writePng } from "./helpers/unreal-fixture.js";

/**
 * Temperate conifer pack (PRD-539 follow-up): needle cards are masked foliage whose cut-out is the blue channel of a packed
 * `_AORO` texture authored with no mip chain, on a master with `Specular` 0.1. Both facts were dropped: our sampler
 * mip-averaged the thin mask (sparse, pale needles blended with off-leaf colour) and the default glTF F0 (0.04, five
 * times the authored 0.008) added a pale sheen that greyed the green. These tests are synthetic.
 */
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const MASKED = "BlendMode = BLEND_Masked (1)\nOpacityMaskClipValue = 0.333\n";

async function pack(options: { props?: string; noMipmaps?: readonly string[]; specular?: number; vivid?: boolean; mat?: string }) {
  const directory = await mkdtemp(join(tmpdir(), "foliage-cutout-"));
  directories.push(directory);
  await writeMeshFixture(directory, {
    name: "Mesh",
    materialName: "Leaf",
    mat: options.mat ?? "Diffuse=Leaf_A\nOpacity=Leaf_A\nOther[0]=Leaf_AORO\n",
    props: options.props ?? MASKED,
    textures: ["Leaf_A", "Leaf_AORO"],
  });
  if (options.vivid) {
    // A vivid, uncorrelated atlas: saturated green blades beside red-brown tips, like the Fern Collection's `fern_02_A`.
    const size = 32;
    const pixels = Buffer.alloc(size * size * 3);
    for (let i = 0; i < size * size; i++) pixels.set(i % 3 === 0 ? [200, 30, 20] : [20, 190, 30], i * 3);
    await (await import("sharp")).default(pixels, { raw: { width: size, height: size, channels: 3 } }).png().toFile(join(directory, "Leaf_A.png"));
  } else await writePng(join(directory, "Leaf_A.png"), [110, 120, 50, 255]);
  await writePng(join(directory, "Leaf_AORO.png"), [200, 150, 255, 255]);
  const authored: SourceMaterial | undefined =
    options.specular === undefined
      ? undefined
      : { channels: { Specular: { kind: "scalar", value: options.specular } }, baseColorSamples: [], limitations: [] };
  const png = new Map([["Leaf_A", join(directory, "Leaf_A.png")], ["Leaf_AORO", join(directory, "Leaf_AORO.png")]]);
  const result = await packageGlb({
    gltfPath: join(directory, "Mesh.gltf"),
    glbPath: join(directory, "out.glb"),
    keepAllUvSets: false,
    maxTextureSize: undefined,
    assets: { gltf: new Map(), mat: new Map([["Leaf", join(directory, "Leaf.mat")]]), props: new Map([["Leaf", join(directory, "Leaf.props.txt")]]), png, psa: new Map(), audio: new Map(), dna: new Map() },
    ...(options.noMipmaps ? { noMipmapTextures: new Set(options.noMipmaps) } : {}),
    ...(authored ? { sourceMaterial: () => authored } : {}),
  });
  const document = await new NodeIO().registerExtensions([KHRMaterialsSpecular]).read(join(directory, "out.glb"));
  return { result, material: document.getRoot().listMaterials()[0]! };
}

describe("a masked card whose opacity map has no mip chain in Unreal", () => {
  it("keeps an unmipmapped base-colour sampler", async () => {
    const { material, result } = await pack({ noMipmaps: ["Leaf_AORO"] });
    expect(material.getAlphaMode()).toBe("MASK");
    const info = material.getBaseColorTextureInfo()!;
    expect(info.getMinFilter()).toBe(9729);
    expect(info.getMagFilter()).toBe(9729);
    expect(result.sections[0]!.limitations.join("\n")).toContain("TMGS_NoMipmaps");
  });

  it("leaves the default mipmapped sampler when the opacity map has a mip chain", async () => {
    const { material } = await pack({});
    expect(material.getBaseColorTextureInfo()!.getMinFilter()).toBeNull();
  });

  it("leaves an opaque material alone even when its texture has no mip chain", async () => {
    const { material } = await pack({ props: "BlendMode = BLEND_Opaque (0)\n", noMipmaps: ["Leaf_AORO", "Leaf_A"] });
    expect(material.getBaseColorTextureInfo()!.getMinFilter()).toBeNull();
  });
});

describe("a vivid leaf atlas wired to Diffuse and cut out by a packed opacity map", () => {
  it("is the base colour, not rejected as a packed mask (Fern Collection fern_02_A)", async () => {
    const { material, result } = await pack({ vivid: true });
    expect(material.getBaseColorTexture()).not.toBeNull();
    expect(result.sections[0]!.unsupported.map((u) => u.reason).join()).not.toContain("packed mask");
  });

  it("is still rejected when nothing cuts it out (an opaque rock mask resolved into Diffuse)", async () => {
    const { material, result } = await pack({ vivid: true, props: "BlendMode = BLEND_Opaque (0)\n", mat: "Diffuse=Leaf_A\n" });
    expect(material.getBaseColorTexture()).toBeNull();
    expect(result.sections[0]!.unsupported.map((u) => u.reason).join()).toContain("packed mask");
  });
});

describe("an authored constant Specular", () => {
  it("is applied as KHR_materials_specular (F0 = 0.08 x Specular)", async () => {
    const { material } = await pack({ specular: 0.1 });
    const extension = material.getExtension<InstanceType<typeof import("@gltf-transform/extensions").Specular>>("KHR_materials_specular");
    expect(extension?.getSpecularFactor()).toBeCloseTo(0.2, 6);
  });

  it("changes nothing at the engine default of 0.5", async () => {
    const { material } = await pack({ specular: 0.5 });
    expect(material.getExtension("KHR_materials_specular")).toBeNull();
  });
});

describe("the package name table", () => {
  it("reports TMGS_NoMipmaps as an unmipped texture", async () => {
    const directory = await mkdtemp(join(tmpdir(), "foliage-cooking-"));
    directories.push(directory);
    const head = (names: readonly string[]): Buffer => {
      const header = Buffer.alloc(24);
      header.writeUInt32LE(0x9e2a83c1, 0);
      header.writeInt32LE(-7, 4);
      header.writeInt32LE(516, 12);
      header.writeInt32LE(names.length, 20);
      return Buffer.concat([header, ...names.map((name) => { const bytes = Buffer.from(`${name}\0`, "latin1"); const length = Buffer.alloc(4); length.writeInt32LE(bytes.length, 0); return Buffer.concat([length, bytes]); })]);
    };
    await writeFile(join(directory, "Mask.uasset"), head(["AssetImportData", "Texture2D", "MipGenSettings", "TMGS_NoMipmaps"]));
    await writeFile(join(directory, "Colour.uasset"), head(["AssetImportData", "Texture2D", "TextureSource"]));
    await writeFile(join(directory, "NotATexture.uasset"), head(["TMGS_NoMipmaps"]));
    await expect(readPackageCooking(join(directory, "Mask.uasset"))).resolves.toMatchObject({ noMipmapsHint: true });
    await expect(readPackageCooking(join(directory, "Colour.uasset"))).resolves.toMatchObject({ noMipmapsHint: false });
    await expect(readPackageCooking(join(directory, "NotATexture.uasset"))).resolves.toMatchObject({ noMipmapsHint: false });
  });
});
