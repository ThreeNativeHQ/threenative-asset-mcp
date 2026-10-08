import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { expect, it, onTestFinished } from "vitest";

import { extractPackageThumbnail, findThumbnails } from "../src/unreal/package-thumbnail.js";

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tn-package-thumbnail-test-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function png(width: number, height: number, color = { r: 200, g: 60, b: 30 }): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
}

function record(width: number, height: number, size: number): Buffer {
  const out = Buffer.alloc(12);
  out.writeInt32LE(width, 0);
  out.writeInt32LE(height, 4);
  out.writeInt32LE(size, 8);
  return out;
}

/** A fake package: random header bytes, [record][image], then trailing bytes. */
function fakePackage(image: Buffer, rec: Buffer, trailing = 64): Buffer {
  return Buffer.concat([Buffer.from("C1832A9E", "hex"), randomBytes(300), rec, image, randomBytes(trailing)]);
}

async function write(directory: string, name: string, bytes: Buffer): Promise<string> {
  const path = join(directory, name);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, bytes);
  return path;
}

it("extracts exactly the PNG of a validated thumbnail record", async () => {
  const dir = await scratch();
  const image = await png(16, 8);
  const path = await write(dir, "SM_A.uasset", fakePackage(image, record(16, 8, image.length)));
  const out = await extractPackageThumbnail(path);
  expect(out?.equals(image)).toBe(true);
});

it("accepts a compressedSize larger than the image but not one past the end of the file", async () => {
  const dir = await scratch();
  const image = await png(8, 8);
  const roomy = await write(dir, "roomy.uasset", fakePackage(image, record(8, 8, image.length + 10), 64));
  expect((await extractPackageThumbnail(roomy))?.equals(image)).toBe(true);
  const past = await write(dir, "past.uasset", fakePackage(image, record(8, 8, image.length + 1000), 64));
  expect(await extractPackageThumbnail(past)).toBeUndefined();
});

it("extracts a JPEG thumbnail", async () => {
  const dir = await scratch();
  const jpeg = await sharp({ create: { width: 24, height: 12, channels: 3, background: { r: 10, g: 120, b: 200 } } })
    .jpeg()
    .toBuffer();
  const path = await write(dir, "SM_J.uasset", fakePackage(jpeg, record(24, 12, jpeg.length)));
  expect((await extractPackageThumbnail(path))?.equals(jpeg)).toBe(true);
});

it("rejects a PNG whose record does not match: wrong dimensions, too-small size, no record", async () => {
  const dir = await scratch();
  const image = await png(16, 8);
  expect(await extractPackageThumbnail(await write(dir, "wrongdims.uasset", fakePackage(image, record(8, 16, image.length))))).toBeUndefined();
  expect(await extractPackageThumbnail(await write(dir, "small.uasset", fakePackage(image, record(16, 8, image.length - 1))))).toBeUndefined();
  // An embedded texture: the 12 bytes in front are random, not a record.
  const texture = Buffer.concat([randomBytes(300), randomBytes(12), image, randomBytes(32)]);
  expect(await extractPackageThumbnail(await write(dir, "texture.uasset", texture))).toBeUndefined();
});

it("rejects a truncated PNG and a package with no image", async () => {
  const dir = await scratch();
  const image = await png(16, 8);
  const cut = image.subarray(0, image.length - 6);
  const truncated = Buffer.concat([randomBytes(100), record(16, 8, image.length), cut]);
  expect(await extractPackageThumbnail(await write(dir, "cut.uasset", truncated))).toBeUndefined();
  expect(await extractPackageThumbnail(await write(dir, "none.uasset", randomBytes(2000)))).toBeUndefined();
  expect(await extractPackageThumbnail(join(dir, "missing.uasset"))).toBeUndefined();
});

it("skips an embedded texture PNG and returns the later valid thumbnail", async () => {
  const dir = await scratch();
  const texture = await png(32, 32, { r: 1, g: 2, b: 3 });
  const thumb = await png(16, 16);
  const bytes = Buffer.concat([randomBytes(50), randomBytes(12), texture, randomBytes(20), record(16, 16, thumb.length), thumb, randomBytes(8)]);
  expect((await extractPackageThumbnail(await write(dir, "two.uasset", bytes)))?.equals(thumb)).toBe(true);
});

it("handles .uasset only", async () => {
  const dir = await scratch();
  const image = await png(8, 8);
  const path = await write(dir, "SM_A.uexp", fakePackage(image, record(8, 8, image.length)));
  expect(await extractPackageThumbnail(path)).toBeUndefined();
});

it("maps report models to packages by path, falls back to a unique stem, skips ambiguous ones", async () => {
  const dir = await scratch();
  const a = await png(8, 8, { r: 255, g: 0, b: 0 });
  const b = await png(8, 8, { r: 0, g: 255, b: 0 });
  const c = await png(8, 8, { r: 0, g: 0, b: 255 });
  await write(dir, "Content/P/SM_A.uasset", fakePackage(a, record(8, 8, a.length)));
  await write(dir, "Content/Moved/SM_B.uasset", fakePackage(b, record(8, 8, b.length)));
  await write(dir, "Content/X/SM_Dup.uasset", fakePackage(c, record(8, 8, c.length)));
  await write(dir, "Content/Y/SM_Dup.uasset", fakePackage(c, record(8, 8, c.length)));
  await write(dir, "Content/P/SM_NoThumb.uasset", randomBytes(500));
  const found = await findThumbnails({
    sourceDir: dir,
    report: {
      models: [
        { name: "SM_A", package: "Content/P/SM_A.uasset", glb: "P/SM_A.glb" },
        { name: "SM_B", package: "Content/Old/SM_B.uasset", glb: "P/SM_B.glb" },
        { name: "SM_Dup", package: "Content/Gone/SM_Dup.uasset", glb: "P/SM_Dup.glb" },
        { name: "SM_NoThumb", package: "Content/P/SM_NoThumb.uasset", glb: "P/SM_NoThumb.glb" },
        { name: "SM_Escape", package: "../../etc/passwd", glb: "P/SM_Escape.glb" },
      ],
    },
  });
  expect([...found.keys()].sort()).toEqual(["P/SM_A.glb", "P/SM_B.glb"]);
  expect(found.get("P/SM_A.glb")?.equals(a)).toBe(true);
  expect(found.get("P/SM_B.glb")?.equals(b)).toBe(true);
});
