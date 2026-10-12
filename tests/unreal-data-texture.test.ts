import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  DATA_TEXTURE_FORMAT,
  DATA_TEXTURE_VERSION,
  DataTextureError,
  decodeRgba16fLittleEndian,
  parseDataTextureManifest,
  verifyRgba16fData,
  type DataTextureManifest,
} from "../src/unreal/data-texture.js";

const sha256Hex = async (bytes: Uint8Array): Promise<string> => createHash("sha256").update(bytes).digest("hex");

// Two pixels of raw TSF_RGBA16F, written as stored: little-endian half R, G, B, A. The values are the ones the
// Spruce proof reports (negative, HDR and alpha near zero) plus a subnormal and the largest finite half.
const HALF = {
  one: 0x3c00, // 1.0
  minusOne: 0xbc00, // -1.0
  hdr: 0x5b00, // 224.0
  alphaTiny: 0x0100, // a small positive alpha, kept as stored
  subnormal: 0x0001, // 2^-24, the smallest subnormal
  maxFinite: 0x7bff, // 65504
};
const PIXELS = [HALF.minusOne, HALF.hdr, HALF.subnormal, HALF.alphaTiny, HALF.one, HALF.maxFinite, HALF.minusOne, HALF.one];

function littleEndian(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 2);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setUint16(index * 2, value, true));
  return bytes;
}

async function validFixture(): Promise<{ manifest: DataTextureManifest; data: Uint8Array }> {
  const data = littleEndian(PIXELS);
  const manifest = {
    format: DATA_TEXTURE_FORMAT,
    version: DATA_TEXTURE_VERSION,
    name: "T_Example_PIV",
    source: {
      package: "Pack/Content/Example/T_Example_PIV.uasset",
      object: "T_Example_PIV",
      objectPath: "/Game/Example/T_Example_PIV.T_Example_PIV",
      class: "Texture2D",
      sourceFormat: "TSF_RGBA16F",
      sha256: "a".repeat(64),
    },
    data: {
      file: "T_Example_PIV.rgba16f-le",
      format: "RGBA16F",
      layout: "little-endian-half4",
      width: 2,
      height: 1,
      mips: 1,
      slices: 1,
      channels: 4,
      bytesPerPixel: 8,
      bytes: data.byteLength,
      sha256: await sha256Hex(data),
      srgb: false,
      colorSpace: "none",
    },
    provenance: { converter: "threenative-cue4parse test", unrealSource: "UE 4.19 Texture.cpp raw SourceArt path" },
    limits: ["Raw SourceArt bytes only; no semantic decoding is applied."],
  } satisfies DataTextureManifest;
  return { manifest, data };
}

describe("RGBA16F data texture manifest", () => {
  it("accepts a manifest the producer would write", async () => {
    const { manifest } = await validFixture();
    expect(parseDataTextureManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
  });

  it.each([
    ["an unknown format", (m: Record<string, any>) => { m.format = "threenative-texture-stack"; }],
    ["an unsupported version", (m: Record<string, any>) => { m.version = 2; }],
    ["a non-raw layout", (m: Record<string, any>) => { m.data.layout = "png"; }],
    ["an RGBA8 payload", (m: Record<string, any>) => { m.data.format = "RGBA8"; m.data.bytesPerPixel = 4; }],
    ["an sRGB texture", (m: Record<string, any>) => { m.data.srgb = true; }],
    ["a mip chain", (m: Record<string, any>) => { m.data.mips = 2; }],
    ["a slice array", (m: Record<string, any>) => { m.data.slices = 2; }],
    ["three channels", (m: Record<string, any>) => { m.data.channels = 3; }],
    ["a byte count that is not width x height x 8", (m: Record<string, any>) => { m.data.bytes = 15; }],
    ["a data file that escapes the directory", (m: Record<string, any>) => { m.data.file = "../T_Example_PIV.rgba16f-le"; }],
    ["a data hash that is not 64 hex digits", (m: Record<string, any>) => { m.data.sha256 = "xyz"; }],
    ["a source hash that is not 64 hex digits", (m: Record<string, any>) => { m.source.sha256 = "abc"; }],
    ["a source format other than RGBA16F", (m: Record<string, any>) => { m.source.sourceFormat = "TSF_RGBA8"; }],
    ["a fractional width", (m: Record<string, any>) => { m.data.width = 1.5; }],
    ["an unexpected extra field", (m: Record<string, any>) => { m.data.compression = "PNG"; }],
  ])("refuses %s", async (_label, mutate) => {
    const { manifest } = await validFixture();
    const copy = JSON.parse(JSON.stringify(manifest)) as Record<string, any>;
    mutate(copy);
    expect(() => parseDataTextureManifest(copy)).toThrow(DataTextureError);
  });
});

describe("RGBA16F data verification", () => {
  it("accepts bytes whose length and SHA-256 match the manifest", async () => {
    const { manifest, data } = await validFixture();
    await expect(verifyRgba16fData(manifest, data, sha256Hex)).resolves.toBeUndefined();
  });

  it("refuses a truncated payload before it hashes anything", async () => {
    const { manifest, data } = await validFixture();
    await expect(verifyRgba16fData(manifest, data.subarray(0, data.byteLength - 2), sha256Hex))
      .rejects.toThrow(/14 bytes; expected 16/);
  });

  it("refuses bytes that differ from the manifest hash by one bit", async () => {
    const { manifest, data } = await validFixture();
    const tampered = data.slice();
    tampered[5]! ^= 0x01;
    await expect(verifyRgba16fData(manifest, tampered, sha256Hex)).rejects.toThrow(/SHA-256/);
  });

  it("refuses a non-finite sample even when the hash matches", async () => {
    const values = [...PIXELS];
    values[3] = 0x7c00; // +Infinity in the alpha channel
    const data = littleEndian(values);
    const { manifest } = await validFixture();
    const forged = { ...manifest, data: { ...manifest.data, bytes: data.byteLength, sha256: await sha256Hex(data) } };
    await expect(verifyRgba16fData(forged, data, sha256Hex)).rejects.toThrow(/non-finite/);
  });
});

describe("RGBA16F little-endian decoding", () => {
  it("reads each sample as a little-endian 16-bit value, keeping negative, HDR, subnormal and alpha bits", () => {
    const decoded = decodeRgba16fLittleEndian(littleEndian(PIXELS));
    expect(Array.from(decoded)).toEqual(PIXELS);
  });

  it("does not byte-swap: the stored bytes 00 3C are 0x3C00 (1.0), not 0x003C", () => {
    expect(Array.from(decodeRgba16fLittleEndian(new Uint8Array([0x00, 0x3c, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])))).toEqual([
      0x3c00, 0, 0, 0,
    ]);
  });

  it("refuses a payload that is not whole pixels", () => {
    expect(() => decodeRgba16fLittleEndian(new Uint8Array(10))).toThrow(DataTextureError);
  });
});
