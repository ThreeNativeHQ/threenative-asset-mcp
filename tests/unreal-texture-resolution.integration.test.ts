import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeIO } from "@gltf-transform/core";
import sharp from "sharp";
import { afterEach, expect, it } from "vitest";
import { importUnrealDirectory } from "../src/unreal/importer.js";
import { writeFakeModernMaterialConverter, writeFakeUmodel, writeMeshFixture } from "./helpers/unreal-fixture.js";

// Synthetic fixtures only. They mirror a UE4.27 editor pack: the modern converter ships the editor thumbnail of every texture a
// material binds, while UE Viewer exports the same Texture2D packages at the resolution they store.

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

type Rgb = readonly [number, number, number];
const FULL = 64;
const THUMBNAIL = 16;
const WARM: Rgb = [200, 120, 60];
const COOL: Rgb = [30, 90, 150];
const FLAT: Rgb = [128, 128, 255];
const RIDGE: Rgb = [200, 128, 230];
const RIDGE_COLUMN = 21;

function raster(size: number, colour: (x: number, y: number) => Rgb): Buffer {
  const data = Buffer.alloc(size * size * 4, 255);
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) data.set(colour(x, y), (y * size + x) * 4);
  return data;
}

/** What the editor stores: block means of the full image, with `encode` applied to each colour channel. */
function thumbnailOf(full: Buffer, encode: (value: number) => number): Buffer {
  const step = FULL / THUMBNAIL;
  return raster(THUMBNAIL, (tx, ty) => {
    const mean = [0, 0, 0];
    for (let y = 0; y < step; y += 1) for (let x = 0; x < step; x += 1) for (let c = 0; c < 3; c += 1) mean[c]! += full[((ty * step + y) * FULL + tx * step + x) * 4 + c]! / (step * step);
    return [encode(mean[0]!), encode(mean[1]!), encode(mean[2]!)];
  });
}

// A linear 0.5 normal component reads about 0.73 once the editor encodes it for display.
const displayGamma = (value: number): number => Math.round(255 * (value / 255) ** (1 / 2.2));

async function writeRaw(path: string, data: Buffer, size: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, await sharp(data, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer());
}

async function decode(image: Uint8Array | null | undefined) {
  const { data, info } = await sharp(image!).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, at: (x: number, y: number) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 3)] };
}

/**
 * The real consumer path: `importUnrealDirectory` over a pack whose mesh export names its textures and carries none, whose
 * material master reaches the modern converter (which writes the 16 px thumbnails), and whose Texture2D packages UE Viewer
 * exports at 64 px. `collidingNormal` adds an unrelated Texture2D package that shares the normal's basename.
 */
async function importCloth(options: { collidingNormal?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "texture-resolution-")); directories.push(directory);
  const sourceDir = join(directory, "source"); const kit = join(sourceDir, "Content", "Kit");
  const meshExport = join(directory, "mesh-export"); const outputDir = join(directory, "output");
  await mkdir(kit, { recursive: true });
  for (const name of ["Mesh", "Cloth", "M_Cloth", "T_Cloth_D", "T_Cloth_N"]) await writeFile(join(kit, `${name}.uasset`), Buffer.alloc(16));
  if (options.collidingNormal) {
    await mkdir(join(sourceDir, "Content", "Other"), { recursive: true });
    await writeFile(join(sourceDir, "Content", "Other", "T_Cloth_N.uasset"), Buffer.alloc(16));
  }
  await writeMeshFixture(meshExport, { name: "Mesh", materialName: "Cloth", mat: "Diffuse=T_Cloth_D\nNormal=T_Cloth_N\n", props: "", textures: [] });
  const albedo = raster(FULL, (x, y) => ((x + y) % 2 === 0 ? WARM : COOL));
  const normal = raster(FULL, (x) => (x === RIDGE_COLUMN ? RIDGE : FLAT));
  await writeRaw(join(directory, "standalone", "T_Cloth_D", "T_Cloth_D.png"), albedo, FULL);
  await writeRaw(join(directory, "standalone", "T_Cloth_N", "T_Cloth_N.png"), normal, FULL);
  await writeRaw(join(directory, "thumbnails", "T_Cloth_D.png"), thumbnailOf(albedo, Math.round), THUMBNAIL);
  await writeRaw(join(directory, "thumbnails", "T_Cloth_N.png"), thumbnailOf(normal, displayGamma), THUMBNAIL);
  const tool = join(directory, "umodel");
  await writeFakeUmodel(tool, {
    exportFrom: meshExport,
    exportFromByPackage: { T_Cloth_D: join(directory, "standalone", "T_Cloth_D"), T_Cloth_N: join(directory, "standalone", "T_Cloth_N") },
    emptyExports: ["M_Cloth"],
    classes: { Mesh: ["StaticMesh"], Cloth: ["MaterialInstanceConstant"], M_Cloth: ["Material"], T_Cloth_D: ["Texture2D"], T_Cloth_N: ["Texture2D"] },
  });
  const modern = join(directory, "modern-converter");
  await writeFakeModernMaterialConverter(modern, { texturesFrom: join(directory, "thumbnails") });
  const report = await importUnrealDirectory({
    sourceDir, outputDir, concurrency: 1, graphBake: false, freeSpaceBytes: 30_000_000_000,
    environment: { ...process.env, THREENATIVE_UNREAL_CACHE_DIR: join(directory, "cache") },
    umodel: { name: "umodel", path: tool, version: "fixture" },
    modernConverter: { name: "modern", path: modern, version: "fake-converter 1" },
  });
  expect(report.models).toHaveLength(1);
  const material = (await new NodeIO().read(join(outputDir, report.models[0]!.glb))).getRoot().listMaterials()[0]!;
  return { normal: await decode(material.getNormalTexture()?.getImage()), albedo: await decode(material.getBaseColorTexture()?.getImage()), sources: { normal, albedo } };
}

it("embeds the full-resolution Texture2D export, not the editor thumbnail a modern material export ships beside it", async () => {
  const { normal, albedo, sources } = await importCloth();
  // Resolution first: the thumbnail is 16 px, the export 64 px.
  expect([normal.width, normal.height, albedo.width, albedo.height]).toEqual([FULL, FULL, FULL, FULL]);
  // Data: a flat normal stays (128,128,255) with no display gamma, and the one-pixel ridge keeps its edges.
  expect(normal.at(0, 0)).toEqual([...FLAT]);
  expect(normal.at(RIDGE_COLUMN - 1, 7)).toEqual([...FLAT]);
  expect(normal.at(RIDGE_COLUMN, 7)).toEqual([...RIDGE]);
  expect(normal.at(RIDGE_COLUMN + 1, 7)).toEqual([...FLAT]);
  expect(normal.data.equals(sources.normal)).toBe(true);
  // Colour control: the sRGB albedo keeps its one-pixel checker and its exact colours, so no gamma reaches colour data.
  expect(albedo.at(0, 0)).toEqual([...WARM]);
  expect(albedo.at(1, 0)).toEqual([...COOL]);
  expect(albedo.data.equals(sources.albedo)).toBe(true);
});

it("keeps the indexed copy of a texture name that two Texture2D packages share", async () => {
  const { normal, albedo } = await importCloth({ collidingNormal: true });
  // Unrelated packages with one basename are not resolved by picking either export: the normal keeps the copy it had.
  expect([normal.width, normal.height]).toEqual([THUMBNAIL, THUMBNAIL]);
  // The unique albedo still takes its full-resolution export.
  expect([albedo.width, albedo.height]).toEqual([FULL, FULL]);
});
