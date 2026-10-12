import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { describeWithTools } from "./helpers/require-tool.js";
import { buildConverterProgram, convertPackages, type ConverterBuild, type ConverterRun } from "./helpers/material-overrides-harness.js";
import { fields, lz4CompressedBuffer, materialPackage, prop, texturePackage, type RegisteredThumbnail } from "./helpers/unreal-material-source.js";
import { CUE4PARSE_ENGINE_CONTENT, CUE4PARSE_PROGRAM } from "../src/unreal/cue4parse-adapter.js";
import { modernConverterFailureCause } from "../src/unreal/importer.js";

// The editor saves a 256x256 display-gamma preview of every texture inside its package, and registers it in the summary's thumbnail
// table. It is a preview, not source art. The converter used to scan the whole package for the largest PNG, so a package whose only
// inline image was that preview shipped it as the texture's source pixels: a normal map came back gamma-altered and 256 wide.
// Each case below is a Texture2D package beside a material instance that uses it, converted by the compiled production converter
// as the importer runs it. The material route writes `Materials/T_Keep.png` and the standalone route `Textures/T_Keep.png`.

const png = (width: number, height: number, texel: (x: number, y: number) => readonly [number, number, number]): Promise<Buffer> => {
  const raw = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) raw.set([...texel(x, y), 255], (y * width + x) * 4);
  return sharp(raw, { raw: { width, height, channels: 4 } }).png().toBuffer();
};

// The FObjectThumbnail layout (int32 width, int32 height, int32 byte count, then the image). Genuine source bytes can imitate it.
const record = (width: number, height: number, image: Buffer): Buffer => {
  const head = Buffer.alloc(12);
  head.writeInt32LE(width, 0);
  head.writeInt32LE(height, 4);
  head.writeInt32LE(image.length, 8);
  return Buffer.concat([head, image]);
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// How many PNG signatures a raw scan of the package bytes meets.
const signatures = (bytes: Buffer): number => {
  let count = 0;
  for (let at = bytes.indexOf(PNG_SIGNATURE); at >= 0; at = bytes.indexOf(PNG_SIGNATURE, at + 1)) count += 1;
  return count;
};

const info = fields("ParameterInfo", "MaterialParameterInfo", [
  prop("Name", "NameProperty", "Albedo"),
  prop("Association", "ByteProperty", "GlobalParameter", { enum: "EMaterialParameterAssociation" }),
  prop("Index", "IntProperty", -1),
]);
const instance = (): Buffer =>
  materialPackage(
    [
      {
        name: "MI_Use",
        className: "MaterialInstanceConstant",
        properties: [
          prop("TextureParameterValues", "ArrayProperty", [[info, prop("ParameterValue", "ObjectProperty", "/Game/Textures/T_Keep")]], {
            inner: "StructProperty",
            struct: "TextureParameterValue",
          }),
        ],
      },
    ],
    ["/Game/Textures/T_Keep"],
  );
const withInstance = (texture: Buffer): Record<string, Buffer> => ({
  "Game/Materials/MI_Use.uasset": instance(),
  "Game/Textures/T_Keep.uasset": texture,
});

// A shipped image is compared by its size and decoded RGBA texels, not by its encoded bytes, so a harmless re-encoding passes.
const decode = async (bytes: Buffer | undefined): Promise<{ width: number; height: number; rgba: Buffer } | undefined> => {
  if (!bytes) return undefined;
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, rgba: data };
};
const label = async (bytes: Buffer | undefined): Promise<string> => {
  const image = await decode(bytes);
  return image ? `${image.width}x${image.height} rgba sha1 ${createHash("sha1").update(image.rgba).digest("hex")}` : "absent";
};
const texel = (image: { width: number; rgba: Buffer }, x: number, y: number): number[] => [...image.rgba.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];
const shipped = (run: ConverterRun, path: string): Promise<Buffer | undefined> =>
  run.files.includes(path) ? readFile(join(run.output, path)) : Promise.resolve(undefined);

describeWithTools(["modern-converter"], "native texture source: the editor thumbnail is not the source art", () => {
  let directory = "";
  let build: ConverterBuild | undefined;
  const runs: Record<string, ConverterRun> = {};
  const images: Record<string, Buffer> = {};
  const visibleSignatures: Record<string, number> = {};

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "tn-native-texture-source-"));
    build = await buildConverterProgram(CUE4PARSE_PROGRAM, CUE4PARSE_ENGINE_CONTENT, join(directory, "build"));
    if (build.code !== 0) return;
    images.preview = await png(256, 256, () => [90, 110, 200]);
    // A normal map whose off-centre green (40, 90) fails a swapped channel or a gamma change; an sRGB albedo with one white texel.
    images.normal = await png(128, 128, (x, y) => [128, x === 40 && y === 90 ? 228 : 128, 255]);
    images.albedo = await png(128, 128, (x, y) => (x === 5 && y === 100 ? [255, 255, 255] : [200, 120, 40]));
    images.full = await png(256, 256, (x, y) => [x, y, 77]);
    images.larger = await png(384, 384, (x, y) => [x % 256, y % 256, 9]);
    const registered: RegisteredThumbnail[] = [{ width: 256, height: 256, image: images.preview }];
    const cases: Record<string, Buffer> = {
      "preview-only": texturePackage("T_Keep", { thumbnails: registered }),
      "genuine-256-source": texturePackage("T_Keep", { sourceArt: images.full }),
      "preview-and-smaller-normal": texturePackage("T_Keep", { sourceArt: images.normal, thumbnails: registered }),
      "preview-and-smaller-albedo": texturePackage("T_Keep", { sourceArt: images.albedo, thumbnails: registered }),
      "preview-and-larger-source": texturePackage("T_Keep", { sourceArt: images.larger, thumbnails: registered }),
      // The source is an LZ4 payload whose PNG signature is in no raw byte: the raw scan finds only the preview, so the decoder must run.
      "preview-and-lz4-payload": texturePackage("T_Keep", { sourceArt: lz4CompressedBuffer(images.normal), thumbnails: registered }),
      // Controls: bytes that look like the preview's record, but that no thumbnail table registers, are source art.
      "unregistered-lookalike-source": texturePackage("T_Keep", { sourceArt: record(128, 128, images.normal) }),
      "registered-preview-and-unregistered-twin": texturePackage("T_Keep", { thumbnails: registered, tail: [record(128, 128, images.normal)] }),
      "lookalike-inside-lz4-payload": texturePackage("T_Keep", { sourceArt: lz4CompressedBuffer(record(128, 128, images.normal)), thumbnails: registered }),
      // A table that is damaged after its first entry: the preview read before the damage stays excluded.
      "damaged-table-after-preview": texturePackage("T_Keep", { sourceArt: images.normal, thumbnails: registered, damagedTableEntries: 1 }),
      // A table longer than any fixed cap: the preview is its 4097th entry.
      "preview-after-4096-entries": texturePackage("T_Keep", {
        sourceArt: images.normal,
        thumbnails: [...Array.from({ length: 4096 }, () => ({ width: 1, height: 1, image: Buffer.alloc(1) })), ...registered],
      }),
      // CUE4Parse loads no texture from it (the export is not a texture class), so the converter has only the package bytes.
      "ownerless-package": texturePackage("T_Keep", { className: "NotATexture", sourceArt: images.normal, thumbnails: registered }),
    };
    for (const [name, texture] of Object.entries(cases)) {
      visibleSignatures[name] = signatures(texture);
      runs[name] = await convertPackages(build, join(directory, name), withInstance(texture));
    }
    // The same preview-only texture with nothing else to export: the conversion has to fail, saying why.
    runs["preview-only-alone"] = await convertPackages(build, join(directory, "preview-only-alone"), {
      "Game/Textures/T_Keep.uasset": cases["preview-only"]!,
    });
  }, 900_000);

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  const runFor = (name: string): ConverterRun => {
    const result = runs[name];
    if (!result) throw new Error(`${name} did not run; the build exited ${build?.code}: ${build?.output ?? ""}`);
    return result;
  };
  const expectBothRoutes = async (name: string, expected: string, routes = ["Materials/T_Keep.png", "Textures/T_Keep.png"]): Promise<void> => {
    const run = runFor(name);
    const want = await label(images[expected]);
    for (const route of routes) expect(await label(await shipped(run, route)), `${route} of ${name}: ${run.stderr.slice(-600)}`).toBe(want);
  };

  it("compiles the converter program", () => {
    expect(build?.code, build?.output).toBe(0);
  });

  it("ships no pixels for a texture whose only image is the registered editor thumbnail", () => {
    const { files } = runFor("preview-only");
    expect(files).not.toContain("Materials/T_Keep.png");
    expect(files).not.toContain("Textures/T_Keep.png");
  });

  it("fails the conversion with the texture's name when the thumbnail was the only image", () => {
    const run = runFor("preview-only-alone");
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("threenative-texture-failure T_Keep");
    expect(run.files).not.toContain("Textures/T_Keep.png");
  });

  it("keeps that explanation through the importer's failure cause, which fills failed[] with the reason", () => {
    // The real converter's stderr goes through the production extractor, so the importer states the preview, not a bare exit code.
    const cause = modernConverterFailureCause(runFor("preview-only-alone"));
    expect(cause).toMatch(/^T_Keep: no decodable pixel data/);
    expect(cause).toContain("registers it, so it is a preview, not source art");
  });

  it("accepts a genuine 256x256 source: the size does not decide", async () => {
    await expectBothRoutes("genuine-256-source", "full");
  });

  it("ships the 128x128 normal map when a 256x256 thumbnail sits beside it, texel for texel", async () => {
    await expectBothRoutes("preview-and-smaller-normal", "normal");
    for (const route of ["Materials/T_Keep.png", "Textures/T_Keep.png"]) {
      const image = (await decode(await shipped(runFor("preview-and-smaller-normal"), route)))!;
      expect([image.width, image.height], route).toEqual([128, 128]);
      expect(texel(image, 40, 90), `${route} off-centre green`).toEqual([128, 228, 255, 255]);
      expect(texel(image, 41, 90), `${route} neighbour`).toEqual([128, 128, 255, 255]);
    }
  });

  it("ships the 128x128 sRGB albedo unchanged beside the thumbnail", async () => {
    await expectBothRoutes("preview-and-smaller-albedo", "albedo");
    for (const route of ["Materials/T_Keep.png", "Textures/T_Keep.png"]) {
      const image = (await decode(await shipped(runFor("preview-and-smaller-albedo"), route)))!;
      expect([image.width, image.height], route).toEqual([128, 128]);
      expect(texel(image, 5, 100), `${route} white texel`).toEqual([255, 255, 255, 255]);
      expect(texel(image, 6, 100), `${route} albedo`).toEqual([200, 120, 40, 255]);
    }
  });

  it("ships a larger source beside the thumbnail", async () => {
    await expectBothRoutes("preview-and-larger-source", "larger");
  });

  it("recovers an LZ4 source payload that a raw scan cannot see, beside the header preview", async () => {
    expect(visibleSignatures["preview-and-lz4-payload"], "the registered preview is the only PNG signature in the package bytes").toBe(1);
    await expectBothRoutes("preview-and-lz4-payload", "normal");
  });

  it("accepts a source preceded by an unregistered thumbnail-shaped record", async () => {
    await expectBothRoutes("unregistered-lookalike-source", "normal");
  });

  it("excludes only the registered record: an unregistered twin of the same shape is source", async () => {
    await expectBothRoutes("registered-preview-and-unregistered-twin", "normal");
  });

  it("scans a decoded LZ4 payload without the package's thumbnail table", async () => {
    expect(visibleSignatures["lookalike-inside-lz4-payload"], "the registered preview is the only PNG signature in the package bytes").toBe(1);
    await expectBothRoutes("lookalike-inside-lz4-payload", "normal");
  });

  it("keeps the preview read before a damaged table entry excluded", async () => {
    // CUE4Parse reads the whole table when it loads a package and refuses a damaged one, so the standalone route never lists this
    // texture. The material route reads the texture's bytes by name, and its own parse of the table is the only protection.
    await expectBothRoutes("damaged-table-after-preview", "normal", ["Materials/T_Keep.png"]);
    expect((await decode(await shipped(runFor("damaged-table-after-preview"), "Textures/T_Keep.png")))?.width).not.toBe(256);
  });

  it("registers a preview that is the 4097th table entry", async () => {
    await expectBothRoutes("preview-after-4096-entries", "normal");
  });

  it("excludes the registered preview of a package CUE4Parse loads no texture from", async () => {
    await expectBothRoutes("ownerless-package", "normal", ["Materials/T_Keep.png"]);
  });
});
