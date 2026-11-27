import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateGltf } from "../src/discovery/acquisition.js";

// PRD-540: the two 2026-11-27 trace failures of `asset_download` on `threenative:*` assets.

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function glb(document: Record<string, unknown>, binaryLength: number): Buffer {
  const text = JSON.stringify({ asset: { version: "2.0" }, ...document });
  const json = Buffer.from(text + " ".repeat((4 - (text.length % 4)) % 4), "utf8");
  const chunk = (length: number, type: number, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32LE(length, 0);
    head.writeUInt32LE(type, 4);
    return Buffer.concat([head, body]);
  };
  const bin = Buffer.alloc(binaryLength);
  const body = Buffer.concat([chunk(json.length, 0x4e4f534a, json), chunk(bin.length, 0x004e4942, bin)]);
  const header = Buffer.alloc(12);
  header.write("glTF", 0, "latin1");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + body.length, 8);
  return Buffer.concat([header, body]);
}

async function validate(bytes: Buffer): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "gltf-acq-"));
  dirs.push(dir);
  await writeFile(join(dir, "model.glb"), bytes);
  await validateGltf(dir, [{ path: "model.glb" } as never]);
}

describe("glTF required extensions", () => {
  it.each([
    ["Fable: city-barrier / city-lamp", ["EXT_texture_webp"]],
    ["Fable: modern PBR set", ["KHR_materials_clearcoat", "KHR_materials_ior", "KHR_materials_specular", "KHR_materials_emissive_strength", "KHR_materials_transmission", "KHR_materials_dispersion", "KHR_texture_basisu"]],
    ["dsh: toybox-checkpoint", ["EXT_meshopt_compression", "KHR_mesh_quantization"]],
  ])("accepts %s", async (_name, extensionsRequired) => {
    await expect(validate(glb({ extensionsUsed: extensionsRequired, extensionsRequired, buffers: [{ byteLength: 8 }] }, 8))).resolves.toBeUndefined();
  });

  it("names every unsupported extension", async () => {
    await expect(
      validate(glb({ extensionsRequired: ["KHR_materials_clearcoat", "EXT_mystery", "VENDOR_x"], buffers: [{ byteLength: 8 }] }, 8)),
    ).rejects.toThrow("Unsupported glTF required extension: EXT_mystery, VENDOR_x.");
  });
});

describe("GLB embedded binary buffer", () => {
  it("accepts a binary chunk padded by more than three bytes", async () => {
    await expect(validate(glb({ buffers: [{ byteLength: 8 }] }, 16))).resolves.toBeUndefined();
  });

  it("accepts the meshopt fallback buffer that has no uri (dsh: toybox-checkpoint)", async () => {
    const buffers = [{ byteLength: 8 }, { byteLength: 64, extensions: { EXT_meshopt_compression: { fallback: true } } }];
    await expect(validate(glb({ extensionsRequired: ["EXT_meshopt_compression"], buffers }, 8))).resolves.toBeUndefined();
  });

  it("rejects a truncated binary chunk with the exact byte counts", async () => {
    await expect(validate(glb({ buffers: [{ byteLength: 64 }] }, 8))).rejects.toThrow(
      "Missing or incomplete GLB embedded buffer: the binary chunk holds 8 of 64 bytes.",
    );
  });
});
