import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { describeWithTools } from "./helpers/require-tool.js";
import { Rgba16fProducer, type TextureCase } from "./helpers/rgba16f-producer.js";

// The production reader, ReadRgba16fSourceArt, run on a synthetic UTexture2D built from the pinned CUE4Parse types. The
// Source struct is a typed FStructFallback, SourceArt is an FByteBulkData read through an archive, and the enum names keep
// their UE prefix as tagged properties do. Only the two private setters on UTexture are set by reflection.

/** Six pixels of stored half-float samples, the same as the other RGBA16F tests. */
const SAMPLES = [
  0xbc00, 0x5b00, 0x0001, 0x0100, 0x8000, 0x7bff, 0x3c00, 0xc200, 0x0200, 0x6400, 0xbbff, 0x0000,
  0x3555, 0x4248, 0x7800, 0x0400, 0xfbff, 0x8001, 0x3800, 0x3000, 0x4900, 0xa000, 0x2e66, 0x0001,
];

function littleEndian(values: readonly number[]): Buffer {
  const bytes = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => bytes.writeUInt16LE(value, index * 2));
  return bytes;
}

describeWithTools(["modern-converter"], "RGBA16F SourceArt read from a pinned UTexture2D (ReadRgba16fSourceArt)", () => {
  const producer = new Rgba16fProducer();
  const payload = littleEndian(SAMPLES);
  beforeAll(async () => {
    await producer.setup();
  }, 300_000);
  afterAll(async () => {
    await producer.teardown();
  });

  it("extracts the typed Source fields and the SourceArt bytes unchanged, with the enum type prefix stripped", async () => {
    const outcome = await producer.extractTexture({ source: {}, sourceArt: { payload } });
    expect(outcome).toEqual({
      ok: true,
      format: "TSF_RGBA16F",
      sizeX: 3,
      sizeY: 2,
      numSlices: 1,
      numMips: 1,
      pngCompressed: false,
      compression: "TSCF_None",
      srgb: false,
      elementCount: 48,
      payload: payload.toString("base64"),
      width: 3,
      height: 2,
    });
  });

  it("accepts an absent CompressionFormat as uncompressed: UE 4.19's Source has no such field", async () => {
    const outcome = await producer.extractTexture({ source: { compression: null }, sourceArt: { payload } });
    expect(outcome).toEqual({
      ok: true,
      format: "TSF_RGBA16F",
      sizeX: 3,
      sizeY: 2,
      numSlices: 1,
      numMips: 1,
      pngCompressed: false,
      compression: null,
      srgb: false,
      elementCount: 48,
      payload: payload.toString("base64"),
      width: 3,
      height: 2,
    });
  });

  it("refuses a texture with no typed Source struct", async () => {
    const outcome = await producer.extractTexture({ sourceArt: { payload } });
    expect(outcome).toEqual({ ok: false, reason: "the texture has no typed Source struct" });
  });

  it("refuses a texture with no SourceArt bulk data", async () => {
    const outcome = await producer.extractTexture({ source: {} });
    expect(outcome).toEqual({ ok: false, reason: "the texture has no SourceArt bulk data" });
  });

  it("refuses a read whose element count disagrees with the bytes it returns", async () => {
    const outcome = await producer.extractTexture({ source: {}, sourceArt: { payload, elementCount: 47 } });
    expect(outcome).toMatchObject({ ok: false, reason: expect.stringMatching(/SourceArt read is incomplete or not raw: 48 bytes, element count 47/) });
  });

  it("refuses a truncated read: the header declares 48 bytes and the archive yields 46", async () => {
    const outcome = await producer.extractTexture({ source: {}, sourceArt: { payload: payload.subarray(0, 46), elementCount: 48, sizeOnDisk: 46 } });
    expect(outcome).toMatchObject({ ok: false, reason: expect.stringMatching(/SourceArt read is incomplete or not raw: 46 bytes, element count 48/) });
  });

  it("refuses a non-finite sample that the typed read delivers", async () => {
    const infinite = littleEndian([...SAMPLES.slice(0, 9), 0x7c00, ...SAMPLES.slice(10)]);
    const outcome = await producer.extractTexture({ source: {}, sourceArt: { payload: infinite } });
    expect(outcome).toMatchObject({ ok: false, reason: expect.stringMatching(/non-finite half-float sample at sample 9 \(pixel 2, channel 1\)/) });
  });

  it.each<[string, TextureCase, RegExp]>([
    ["an RGBA8 source", { source: { format: "TSF_RGBA8" } }, /source format TSF_RGBA8 is not TSF_RGBA16F/],
    ["a PNG-compressed source", { source: { pngCompressed: true } }, /PNG-compressed/],
    ["a delta-compressed source", { source: { compression: "TSCF_UEDELTA" } }, /compression TSCF_UEDELTA/],
    ["a source with two mips", { source: { numMips: 2 } }, /holds 2 mips/],
    ["an sRGB texture", { source: {}, srgb: true }, /sRGB/],
    ["a zero width", { source: { sizeX: 0 } }, /dimensions 0x2/],
    ["a literal None compression name", { source: { compression: "None" } }, /compression None/],
    ["an unknown compression name", { source: { compression: "TSCF_Mystery" } }, /compression TSCF_Mystery/],
    ["a CompressionFormat of another property type", { source: { compression: { integer: 0 } } }, /CompressionFormat is present but not an enum name/],
    ["a PNG-compressed source with no CompressionFormat", { source: { compression: null, pngCompressed: true } }, /PNG-compressed/],
  ])("refuses %s", async (_label, change, reason) => {
    const outcome = await producer.extractTexture({ ...change, sourceArt: { payload } });
    expect(outcome).toMatchObject({ ok: false, reason: expect.stringMatching(reason) });
  });
});
