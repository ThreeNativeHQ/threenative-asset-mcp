import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Document, NodeIO, type Root } from "@gltf-transform/core";
import { KHRMaterialsSpecular, type Specular } from "@gltf-transform/extensions";
import sharp from "sharp";
import { describe, expect, it, onTestFinished } from "vitest";

import { packageGlb } from "../src/unreal/importer.js";
import type { SourceMaterial } from "../src/unreal/source-material.js";

/**
 * Two isolated source folders each export the same PNG under the same texture name. The importer caches a file-backed
 * texture by its absolute source path, so identical bytes used to be embedded once per folder. These tests are
 * synthetic: they use generated PNGs and invented names, never pack content.
 */

const BARK = [150, 90, 40, 255] as const; // flat, so the albedo check keeps it as a base colour
const OTHER = [60, 140, 90, 255] as const;
const TRUNK = "TrunkMaterial";
const BRANCH = "BranchMaterial";
const TEXTURE = "SyntheticBark";
const OPAQUE = "BlendMode = BLEND_Opaque (0)\n";
const MASKED = "BlendMode = BLEND_Masked (1)\nOpacityMaskClipValue = 0.333\n";
const AUTHORED_SPECULAR: SourceMaterial = { channels: { Specular: { kind: "scalar", value: 0.1 } }, baseColorSamples: [], limitations: [] };

interface IsolatedSource {
  /** glTF material name; also the key of its `.mat` and `.props.txt`. */
  readonly material: string;
  /** The texture the `.mat` binds, and the PNG's basename. */
  readonly texture: string;
  readonly image: Buffer;
  readonly props: string;
}

async function flatPng(colour: readonly [number, number, number, number]): Promise<Buffer> {
  return sharp({
    create: { width: 4, height: 4, channels: 4, background: { r: colour[0], g: colour[1], b: colour[2], alpha: colour[3] / 255 } },
  })
    .png()
    .toBuffer();
}

function sourceAssets(folder: string, material: string, texture: string, png: string) {
  return {
    gltf: new Map<string, string>(),
    mat: new Map([[material, join(folder, `${material}.mat`)]]),
    props: new Map([[material, join(folder, `${material}.props.txt`)]]),
    png: new Map([[texture, png]]),
    psa: new Map<string, string>(),
    audio: new Map<string, string>(),
    dna: new Map<string, string>(),
  };
}

function emptyAssets() {
  return {
    gltf: new Map<string, string>(),
    mat: new Map<string, string>(),
    props: new Map<string, string>(),
    png: new Map<string, string>(),
    psa: new Map<string, string>(),
    audio: new Map<string, string>(),
    dna: new Map<string, string>(),
  };
}

interface Geometry {
  readonly position: Float32Array<ArrayBuffer>;
  readonly normal: Float32Array<ArrayBuffer>;
  readonly uv: Float32Array<ArrayBuffer>;
  readonly indices: Uint16Array<ArrayBuffer>;
}

/** Writes a glTF with one primitive per isolated source, runs the real `packageGlb`, and reads the GLB back. */
async function packIsolated(
  sources: readonly [IsolatedSource, IsolatedSource],
  options: { readonly authoredFor?: string; readonly noMipmaps?: boolean } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "identical-texture-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const gltfPath = join(directory, "Mesh.gltf");
  const glbPath = join(directory, "out.glb");

  const document = new Document();
  const buffer = document.createBuffer();
  const mesh = document.createMesh("Mesh");
  const materialAssets = new Map<string, ReturnType<typeof sourceAssets>>();
  const proofSources = new Map<string, string[]>();
  const expected = new Map<string, Geometry>();

  for (const [index, source] of sources.entries()) {
    // Each source lives in its own folder, as an isolated export does, so the two PNGs have different absolute paths.
    const folder = join(directory, `source-${index}`);
    await mkdir(folder);
    const png = join(folder, `${source.texture}.png`);
    await writeFile(png, source.image);
    await writeFile(join(folder, `${source.material}.mat`), `Diffuse=${source.texture}\n`);
    await writeFile(join(folder, `${source.material}.props.txt`), source.props);
    materialAssets.set(source.material, sourceAssets(folder, source.material, source.texture, png));

    const x = index * 2; // distinct geometry per primitive, so a mix-up would show
    const geometry: Geometry = {
      position: new Float32Array([x, 0, 0, x + 1, 0, 0, x + 1, 1, 0, x, 1, 0]),
      normal: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
      uv: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
    };
    expected.set(source.material, geometry);
    mesh.addPrimitive(
      document
        .createPrimitive()
        .setAttribute("POSITION", document.createAccessor().setType("VEC3").setArray(geometry.position).setBuffer(buffer))
        .setAttribute("NORMAL", document.createAccessor().setType("VEC3").setArray(geometry.normal).setBuffer(buffer))
        .setAttribute("TEXCOORD_0", document.createAccessor().setType("VEC2").setArray(geometry.uv).setBuffer(buffer))
        .setIndices(document.createAccessor().setType("SCALAR").setArray(geometry.indices).setBuffer(buffer))
        .setMaterial(document.createMaterial(source.material)),
    );
  }
  document.createScene("Scene").addChild(document.createNode("Mesh").setMesh(mesh));
  await new NodeIO().write(gltfPath, document);

  const packaged = await packageGlb({
    gltfPath,
    glbPath,
    keepAllUvSets: false,
    maxTextureSize: undefined,
    assets: emptyAssets(),
    materialAssets,
    proofSources,
    ...(options.authoredFor ? { sourceMaterial: (name: string) => (name === options.authoredFor ? AUTHORED_SPECULAR : undefined) } : {}),
    ...(options.noMipmaps ? { noMipmapTextures: new Set([TEXTURE]) } : {}),
  });
  const read = await new NodeIO().registerExtensions([KHRMaterialsSpecular]).read(glbPath);
  return { root: read.getRoot(), packaged, proofSources, expected };
}

function materialNamed(root: Root, name: string) {
  const material = root.listMaterials().find((candidate) => candidate.getName() === name);
  if (!material) throw new Error(`no material ${name} in the packed GLB`);
  return material;
}

const trunk = (image: Buffer): IsolatedSource => ({ material: TRUNK, texture: TEXTURE, image, props: OPAQUE });
const branch = (image: Buffer, texture = TEXTURE): IsolatedSource => ({ material: BRANCH, texture, image, props: MASKED });

describe("identical textures from isolated sources", () => {
  it("are embedded once when they share a name, a MIME type and bytes", async () => {
    const bark = await flatPng(BARK);
    const { root } = await packIsolated([trunk(bark), branch(bark)]);

    const textures = root.listTextures();
    expect(textures).toHaveLength(1);
    expect(textures[0]!.getName()).toBe(TEXTURE);
    expect(Buffer.from(textures[0]!.getImage()!).equals(bark)).toBe(true);
    expect(materialNamed(root, TRUNK).getBaseColorTexture()).toBe(textures[0]);
    expect(materialNamed(root, BRANCH).getBaseColorTexture()).toBe(textures[0]);
  });

  it("keep both images when the name matches but the bytes differ", async () => {
    const bark = await flatPng(BARK);
    const other = await flatPng(OTHER);
    const { root } = await packIsolated([trunk(bark), branch(other)]);

    const textures = root.listTextures();
    expect(textures.map((texture) => texture.getName())).toEqual([TEXTURE, TEXTURE]);
    expect(textures.map((texture) => Buffer.from(texture.getImage()!).toString("base64")).sort()).toEqual(
      [bark, other].map((image) => image.toString("base64")).sort(),
    );
  });

  it("keep both images when the bytes match but the names differ", async () => {
    const bark = await flatPng(BARK);
    const { root } = await packIsolated([trunk(bark), branch(bark, `${TEXTURE}Alt`)]);

    const textures = root.listTextures();
    expect(textures.map((texture) => texture.getName()).sort()).toEqual([TEXTURE, `${TEXTURE}Alt`]);
    for (const texture of textures) expect(Buffer.from(texture.getImage()!).equals(bark)).toBe(true);
  });

  it("leave each material's sampler, factors, names, slots and source report as they were", async () => {
    const bark = await flatPng(BARK);
    const { root, packaged, proofSources } = await packIsolated([trunk(bark), branch(bark)], { authoredFor: BRANCH, noMipmaps: true });
    const trunkMaterial = materialNamed(root, TRUNK);
    const branchMaterial = materialNamed(root, BRANCH);

    expect([trunkMaterial.getName(), branchMaterial.getName()]).toEqual([TRUNK, BRANCH]);
    expect(trunkMaterial.getAlphaMode()).toBe("OPAQUE");
    expect(branchMaterial.getAlphaMode()).toBe("MASK");
    // Sampler: only the masked material's base colour is unmipmapped; the merged image is shared, its TextureInfo is not.
    expect(trunkMaterial.getBaseColorTextureInfo()!.getMinFilter()).toBeNull();
    expect(branchMaterial.getBaseColorTextureInfo()!.getMinFilter()).toBe(9729);
    expect(branchMaterial.getBaseColorTextureInfo()!.getMagFilter()).toBe(9729);
    expect(trunkMaterial.getBaseColorTextureInfo()!.getTexCoord()).toBe(0);
    expect(branchMaterial.getBaseColorTextureInfo()!.getTexCoord()).toBe(0);
    // Factors: the authored Specular belongs to the branch alone.
    expect(trunkMaterial.getExtension("KHR_materials_specular")).toBeNull();
    expect(branchMaterial.getExtension<Specular>("KHR_materials_specular")!.getSpecularFactor()).toBeCloseTo(0.2, 6);
    // Slots: both bind a base colour and neither gained another texture.
    expect(trunkMaterial.getNormalTexture()).toBeNull();
    expect(branchMaterial.getNormalTexture()).toBeNull();
    // Source binding report: the packer still records both source PNGs against the texture name.
    expect(proofSources.get(TEXTURE)).toHaveLength(2);
    expect(packaged.sections.flatMap((section) => section.limitations).join("\n")).toContain("TMGS_NoMipmaps");
  });

  it("leave the geometry, accessors and raw attributes exactly as the source wrote them", async () => {
    const bark = await flatPng(BARK);
    const { root, expected } = await packIsolated([trunk(bark), branch(bark)]);

    expect(root.listAccessors()).toHaveLength(8);
    const primitives = root.listMeshes()[0]!.listPrimitives();
    expect(primitives).toHaveLength(2);
    for (const primitive of primitives) {
      const want = expected.get(primitive.getMaterial()!.getName())!;
      expect(primitive.listSemantics().sort()).toEqual(["NORMAL", "POSITION", "TEXCOORD_0"]);
      expect(primitive.getAttribute("POSITION")!.getArray()).toEqual(want.position);
      expect(primitive.getAttribute("NORMAL")!.getArray()).toEqual(want.normal);
      expect(primitive.getAttribute("TEXCOORD_0")!.getArray()).toEqual(want.uv);
      expect(primitive.getIndices()!.getArray()).toEqual(want.indices);
    }
  });
});
