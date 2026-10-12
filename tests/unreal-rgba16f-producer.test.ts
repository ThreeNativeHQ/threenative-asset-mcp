import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DataTextureError, parseDataTextureManifest, verifyRgba16fData } from "../src/unreal/data-texture.js";
import { describeWithTools } from "./helpers/require-tool.js";
import {
  PRODUCER_PACKAGE_UASSET,
  PRODUCER_PACKAGE_UEXP,
  Rgba16fProducer,
  readProducedArtifacts,
  type ProducerCase,
} from "./helpers/rgba16f-producer.js";

// The RGBA16F producer, compiled against the pinned libraries and run on synthetic inputs. See tests/helpers/rgba16f-producer.ts.

/** SHA-256 of the package file set, the way the producer and the importer compute it. */
function packageSetSha256(files: readonly { readonly extension: string; readonly bytes: Uint8Array }[]): string {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(`${file.extension} ${file.bytes.byteLength}\n`, "ascii");
    hash.update(file.bytes);
  }
  return hash.digest("hex");
}

/**
 * Six pixels (3x2) of stored half-float R, G, B, A bits: negative, HDR, subnormal, alpha bits, -0, the largest finite,
 * the smallest normal and the smallest subnormal. Each pixel is four samples, so the payload is 48 bytes.
 */
const SAMPLES = [
  0xbc00, 0x5b00, 0x0001, 0x0100,
  0x8000, 0x7bff, 0x3c00, 0xc200,
  0x0200, 0x6400, 0xbbff, 0x0000,
  0x3555, 0x4248, 0x7800, 0x0400,
  0xfbff, 0x8001, 0x3800, 0x3000,
  0x4900, 0xa000, 0x2e66, 0x0001,
];

function littleEndian(values: readonly number[]): Buffer {
  const bytes = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => bytes.writeUInt16LE(value, index * 2));
  return bytes;
}

describeWithTools(["modern-converter"], "RGBA16F data texture producer (compiled from the embedded program)", () => {
  const producer = new Rgba16fProducer();
  beforeAll(async () => {
    await producer.setup();
  }, 300_000);
  afterAll(async () => {
    await producer.teardown();
  });

  it("writes the stored samples unchanged, with a manifest that the shared parser and verifier accept", async () => {
    const payload = littleEndian(SAMPLES);
    const outcome = await producer.produce({ payload });
    expect(outcome, outcome.reason).toMatchObject({ ok: true });
    expect((await readdir(outcome.directory)).sort()).toEqual(["T_Probe_PIV.rgba16f-le", "T_Probe_PIV.rgba16f.json"]);
    const { binary, manifest: raw } = await readProducedArtifacts(outcome);
    expect(binary.equals(payload)).toBe(true);
    const manifest = parseDataTextureManifest(raw);
    expect(manifest.data).toMatchObject({
      file: "T_Probe_PIV.rgba16f-le", format: "RGBA16F", layout: "little-endian-half4", width: 3, height: 2,
      mips: 1, slices: 1, channels: 4, bytesPerPixel: 8, bytes: 48, srgb: false, colorSpace: "none",
    });
    expect(manifest.source).toMatchObject({
      package: "Pack/Content/Probe/T_Probe_PIV.uasset", object: "T_Probe_PIV", objectPath: "/Game/Probe/T_Probe_PIV.T_Probe_PIV",
      class: "Texture2D", sourceFormat: "TSF_RGBA16F",
    });
    expect(manifest.provenance.converter).toMatch(/^threenative-cue4parse /);
    expect(manifest.source.sha256).toBe(packageSetSha256(outcome.packageFiles));
    expect(outcome.packageSha).toBe(manifest.source.sha256);
    await expect(verifyRgba16fData(manifest, new Uint8Array(binary), async (bytes) => createHash("sha256").update(bytes).digest("hex")))
      .resolves.toBeUndefined();
  });

  it("changes the source hash when one byte of the package changes, and not the data hash", async () => {
    const payload = littleEndian(SAMPLES);
    const original = await producer.produce({ payload });
    const tampered = await producer.produce({
      payload,
      packageFiles: [{ extension: ".uasset", bytes: Buffer.concat([PRODUCER_PACKAGE_UASSET, Buffer.from([0x00])]) }, { extension: ".uexp", bytes: PRODUCER_PACKAGE_UEXP }],
    });
    const originalManifest = parseDataTextureManifest((await readProducedArtifacts(original)).manifest);
    const tamperedManifest = parseDataTextureManifest((await readProducedArtifacts(tampered)).manifest);
    expect(tamperedManifest.source.sha256).not.toBe(originalManifest.source.sha256);
    expect(tamperedManifest.data.sha256).toBe(originalManifest.data.sha256);
  });

  it.each([
    ["a PNG-compressed source", { payload: littleEndian(SAMPLES), pngCompressed: true }, /PNG-compressed/],
    // The glue strips the enum's type prefix before the record is built, so the record receives the bare name.
    ["a delta-compressed source", { payload: littleEndian(SAMPLES), compression: "TSCF_UEDELTA" }, /compression TSCF_UEDELTA/],
    ["an RGBA8 source", { payload: littleEndian(SAMPLES), format: "TSF_RGBA8" }, /not TSF_RGBA16F/],
    ["a source with two mips", { payload: littleEndian(SAMPLES), numMips: 2 }, /one mip/],
    ["a source with two slices", { payload: littleEndian(SAMPLES), numSlices: 2 }, /one slice/],
    ["an sRGB texture", { payload: littleEndian(SAMPLES), srgb: true }, /sRGB/],
    ["a truncated read", { payload: littleEndian(SAMPLES).subarray(0, 46), elementCount: 48 }, /incomplete/],
    ["an element count that disagrees with the bytes", { payload: littleEndian(SAMPLES), elementCount: 47 }, /incomplete/],
    ["a zero width", { payload: littleEndian(SAMPLES), sizeX: 0 }, /dimensions/],
    ["a non-finite sample", { payload: littleEndian([...SAMPLES.slice(0, 9), 0x7c00, ...SAMPLES.slice(10)]) }, /non-finite half-float sample at sample 9 \(pixel 2, channel 1\)/],
  ] as const)("refuses %s without writing a file", async (_label, input, reason) => {
    const outcome = await producer.produce(input as ProducerCase);
    expect(outcome).toMatchObject({ ok: false });
    expect(outcome.reason).toMatch(reason);
    await expect(readdir(outcome.directory)).rejects.toThrow();
  });

  it("treats an absent PNG flag as Unreal's default of false", async () => {
    const outcome = await producer.produce({ payload: littleEndian(SAMPLES) });
    expect(outcome).toMatchObject({ ok: true });
  });

  it("refuses a manifest that names a package outside the exact .uasset key form", async () => {
    const outcome = await producer.produce({ payload: littleEndian(SAMPLES) });
    const manifest = JSON.parse(await readFile(join(outcome.directory, "T_Probe_PIV.rgba16f.json"), "utf8")) as Record<string, unknown>;
    (manifest.source as Record<string, unknown>).package = "../escape/T_Probe_PIV.uasset";
    expect(() => parseDataTextureManifest(manifest)).toThrow(DataTextureError);
  });
});
