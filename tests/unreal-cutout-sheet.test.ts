import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Document, NodeIO } from "@gltf-transform/core";
import sharp from "sharp";
import { expect, it, onTestFinished } from "vitest";

import { renderContactSheet } from "../src/unreal/contact-sheet.js";
import { describeWithTools } from "./helpers/require-tool.js";

/** A green quad whose texture is a cut-out: alpha 255 in the left half, 0 in the right half. Synthetic, no pack bytes. */
async function writeCutoutQuad(path: string, baseColorFactor: [number, number, number, number], alphaMode: "MASK" | "BLEND" | "OPAQUE"): Promise<void> {
  const document = new Document();
  const buffer = document.createBuffer();
  const size = 16;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) pixels.set([20, 200, 40, x < size / 2 ? 255 : 0], (y * size + x) * 4);
  }
  const png = await sharp(pixels, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
  const texture = document.createTexture("cutout").setImage(new Uint8Array(png)).setMimeType("image/png");
  const material = document
    .createMaterial("grass")
    .setBaseColorTexture(texture)
    .setBaseColorFactor(baseColorFactor)
    .setAlphaMode(alphaMode)
    .setAlphaCutoff(0.333)
    .setDoubleSided(true)
    .setMetallicFactor(0)
    .setRoughnessFactor(1);
  const primitive = document
    .createPrimitive()
    .setAttribute("POSITION", document.createAccessor().setType("VEC3").setBuffer(buffer).setArray(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0])))
    .setAttribute("NORMAL", document.createAccessor().setType("VEC3").setBuffer(buffer).setArray(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1])))
    .setAttribute("TEXCOORD_0", document.createAccessor().setType("VEC2").setBuffer(buffer).setArray(new Float32Array([0, 1, 1, 1, 1, 0, 0, 0])))
    .setIndices(document.createAccessor().setType("SCALAR").setBuffer(buffer).setArray(new Uint16Array([0, 1, 2, 0, 2, 3])))
    .setMaterial(material);
  const mesh = document.createMesh("quad").addPrimitive(primitive);
  document.createScene().addChild(document.createNode("quad").setMesh(mesh));
  await new NodeIO().write(path, document);
}

describeWithTools(["chromium"], "cut-out materials on the contact sheet", () => {
  it("draws a masked cut-out and judges it present, while a zero-alpha factor (the grass-library bug) is blank", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tn-cutout-sheet-"));
    onTestFinished(() => rm(dir, { recursive: true, force: true }));
    const good = join(dir, "good.glb");
    const clipped = join(dir, "clipped.glb");
    const blend = join(dir, "blend.glb");
    await writeCutoutQuad(good, [1, 1, 1, 1], "MASK");
    await writeCutoutQuad(clipped, [1, 1, 1, 0], "MASK");
    await writeCutoutQuad(blend, [1, 1, 1, 1], "BLEND");

    const result = await renderContactSheet({ glbPaths: [good, clipped, blend], outPath: join(dir, "sheet.jpg"), title: "Cut-outs", subtitle: "synthetic", tile: 160, selection: "spread" });
    const byName = new Map(result.judge.map((tile) => [tile.name, tile]));

    // The renderer draws what glTF says: the green half shows, the cut-away half does not.
    const goodTile = byName.get("good")!;
    expect(goodTile.verdict).not.toBe("fail");
    expect(goodTile.stats!.objectPixels).toBeGreaterThan(0);
    expect(goodTile.stats!.meanSaturation).toBeGreaterThan(0.3);
    expect(byName.get("blend")!.stats!.objectPixels).toBeGreaterThan(0);
    // The previous importer wrote factor alpha 0: nothing survives the alpha test, and the judge says so.
    const clippedTile = byName.get("clipped")!;
    expect(clippedTile.verdict).toBe("fail");
    expect(clippedTile.reasons).toContain("blank: nothing drawn");
  }, 120_000);
});
