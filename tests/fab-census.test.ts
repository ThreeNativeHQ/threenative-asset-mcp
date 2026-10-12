import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import { describe, expect, it, onTestFinished } from "vitest";

import {
  BINARY_MANIFEST_MAGIC,
  assertOutsideCheckout,
  classifyFileName,
  decodeByteBlob,
  parseJsonManifest,
  parseManifest,
  selectOldestArtifact,
} from "../scripts/fab-census.js";
import type { FabUnrealVersion } from "../src/fab/fabcli.js";

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "fab-census-test-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Encodes an integer the way Epic's JSON manifests do: LE bytes, each as a 3-digit decimal group. */
function blob(value: number, bytes = 4): string {
  const groups: string[] = [];
  for (let index = 0; index < bytes; index++) {
    groups.push(String((value >>> (8 * index)) & 0xff).padStart(3, "0"));
  }
  return groups.join("");
}

class Writer {
  readonly #chunks: Buffer[] = [];

  u8(value: number): void {
    this.#chunks.push(Buffer.from([value & 0xff]));
  }

  u32(value: number): void {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32LE(value >>> 0);
    this.#chunks.push(buffer);
  }

  i32(value: number): void {
    const buffer = Buffer.alloc(4);
    buffer.writeInt32LE(value);
    this.#chunks.push(buffer);
  }

  u64(value: bigint): void {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64LE(value);
    this.#chunks.push(buffer);
  }

  bytes(value: Uint8Array): void {
    this.#chunks.push(Buffer.from(value));
  }

  fstring(value: string): void {
    const text = Buffer.from(value, "utf8");
    this.u32(text.length + 1);
    this.#chunks.push(text, Buffer.from([0]));
  }

  fstringArray(values: readonly string[]): void {
    this.u32(values.length);
    for (const value of values) this.fstring(value);
  }

  buffer(): Buffer {
    return Buffer.concat(this.#chunks);
  }
}

/** A length-prefixed section: `DataSize` counts from just before itself and includes the version byte. */
function section(build: (writer: Writer) => void): Buffer {
  const writer = new Writer();
  build(writer);
  const body = writer.buffer();
  const framed = Buffer.alloc(4 + body.length);
  framed.writeUInt32LE(framed.length, 0);
  body.copy(framed, 4);
  return framed;
}

function binaryManifest(names: readonly string[], chunkSizes: readonly bigint[], compressed: boolean): Buffer {
  const meta = section((writer) => {
    writer.u8(0); // DataVersion
    writer.i32(21); // FeatureLevel
    writer.u8(0); // IsFileData
    writer.i32(0); // AppID
    writer.fstring("SyntheticPack");
    writer.fstring("1.0.0");
    writer.fstring("");
    writer.fstring("");
    writer.fstringArray([]); // PrereqIds
    writer.fstring("");
    writer.fstring("");
    writer.fstring("");
  });
  const chunks = section((writer) => {
    writer.u8(2); // DataVersion
    writer.u32(chunkSizes.length);
    for (let index = 0; index < chunkSizes.length; index++) writer.bytes(Buffer.alloc(16, index + 1)); // GUIDs
    for (let index = 0; index < chunkSizes.length; index++) writer.u64(0n); // hashes
    for (let index = 0; index < chunkSizes.length; index++) writer.bytes(Buffer.alloc(20)); // SHA-1s
    for (let index = 0; index < chunkSizes.length; index++) writer.u8(0); // groups
    for (let index = 0; index < chunkSizes.length; index++) writer.u32(0); // window sizes
    for (const size of chunkSizes) writer.u64(size);
  });
  const files = section((writer) => {
    writer.u8(3); // DataVersion
    writer.u32(names.length);
    for (const name of names) writer.fstring(name);
    for (let index = 0; index < names.length; index++) writer.fstring("");
    for (let index = 0; index < names.length; index++) writer.bytes(Buffer.alloc(20));
    for (let index = 0; index < names.length; index++) writer.u8(0);
    for (let index = 0; index < names.length; index++) writer.fstringArray([]);
    for (let index = 0; index < names.length; index++) writer.u32(0);
  });
  const body = Buffer.concat([meta, chunks, files]);
  const payload = compressed ? deflateSync(body) : body;
  const header = Buffer.alloc(41);
  header.writeUInt32LE(BINARY_MANIFEST_MAGIC, 0);
  header.writeInt32LE(41, 4);
  header.writeInt32LE(body.length, 8);
  header.writeInt32LE(payload.length, 12);
  header.writeUInt8(compressed ? 1 : 0, 36);
  header.writeInt32LE(21, 37);
  return Buffer.concat([header, payload]);
}

describe("fab-census manifest parsing", () => {
  it("reads the JSON encoding's decimal-byte sizes and class hints", () => {
    const manifest = {
      ManifestFileVersion: "008000000000",
      bIsFileData: false,
      FileManifestList: [
        { Filename: "Content/Pack/AimOffset_Example.uasset", FileChunkParts: [{ Guid: "AAA", Offset: "000000000000", Size: "000010000000" }] },
        { Filename: "Content/Pack/Character_Skeleton.uasset", FileChunkParts: [{ Guid: "BBB", Offset: "000000000000", Size: "000020000000" }] },
        { Filename: "Content/Pack/NS_Dust.uasset", FileChunkParts: [{ Guid: "CCC", Offset: "000000000000", Size: "000030000000" }] },
      ],
      ChunkFilesizeList: { GUID_A: blob(1000), GUID_B: blob(2000) },
    };

    const summary = parseManifest(Buffer.from(JSON.stringify(manifest), "utf8"));

    expect(summary.format).toBe("json");
    expect(summary.fileCount).toBe(3);
    expect(summary.downloadBytes).toBe(3000);
    expect(summary.classHints).toMatchObject({ AimOffset: 1, Skeleton: 1, NiagaraSystem: 1 });
    expect(decodeByteBlob(blob(1000))).toBe(1000n);
    expect(classifyFileName("Content/Pack/Example_Clip.uasset")).toBe("OtherUasset");
  });

  it("reads the binary encoding, including zlib-compressed bodies", () => {
    const names = ["Content/Pack/AimOffset_Example.uasset", "Content/Pack/Hero_Physics.uasset"];
    for (const compressed of [false, true]) {
      const summary = parseManifest(binaryManifest(names, [1024n, 2048n], compressed));
      expect(summary.format).toBe("binary");
      expect(summary.fileCount).toBe(2);
      expect(summary.downloadBytes).toBe(3072);
      expect(summary.classHints).toMatchObject({ AimOffset: 1, PhysicsAsset: 1 });
    }
  });

  it("selects the oldest artifact of a listing", () => {
    const artifacts: FabUnrealVersion[] = [
      { artifactId: "Newer", engineVersions: ["UE_5.4", "UE_5.5"], targetPlatforms: [] },
      { artifactId: "Oldest", engineVersions: ["UE_4.4", "UE_4.5"], targetPlatforms: [] },
    ];
    expect(selectOldestArtifact(artifacts)?.artifact.artifactId).toBe("Oldest");
    expect(selectOldestArtifact([{ artifactId: "Only", engineVersions: [], targetPlatforms: [] }])?.oldestEngine).toBeUndefined();
  });
});

describe("fab-census JSON manifest strictness", () => {
  it("rejects a manifest with no FileManifestList array instead of reporting zero files", () => {
    expect(() => parseJsonManifest({ ChunkFilesizeList: {} })).toThrow(/FileManifestList/);
    expect(() => parseJsonManifest({ FileManifestList: "nope", ChunkFilesizeList: {} })).toThrow(/FileManifestList/);
  });

  it("rejects a manifest with no size table instead of guessing from chunk parts", () => {
    const manifest = {
      FileManifestList: [
        { Filename: "Content/Pack/A.uasset", FileChunkParts: [{ Guid: "G", Size: blob(4096) }] },
      ],
    };
    expect(() => parseJsonManifest(manifest)).toThrow(/ChunkFilesizeList/);
    expect(() => parseManifest(Buffer.from(JSON.stringify(manifest), "utf8"))).toThrow(/ChunkFilesizeList/);
  });

  it("accepts a valid empty list with an empty size map", () => {
    const summary = parseJsonManifest({ FileManifestList: [], ChunkFilesizeList: {} });
    expect(summary.format).toBe("json");
    expect(summary.fileCount).toBe(0);
    expect(summary.downloadBytes).toBe(0);
  });

  it("rejects a non-blob size entry", () => {
    expect(() => parseJsonManifest({ FileManifestList: [], ChunkFilesizeList: { GUID_A: 12 } })).toThrow(/size blob/);
  });
});

describe("fab-census output path containment", () => {
  it("rejects a path inside the primary checkout or any repository-local worktree, created or not", () => {
    const primary = tempRoot();
    const linked = join(primary, ".worktrees", "task");
    mkdirSync(linked, { recursive: true });
    for (const candidate of [
      join(primary, "out"),
      join(linked, "out"),
      join(linked, "nested", "not-yet-created"),
    ]) {
      expect(() => assertOutsideCheckout(candidate, [primary, linked])).toThrow(/outside every checkout/);
    }
  });

  it("rejects a symlink that points into a worktree", () => {
    const primary = tempRoot();
    const elsewhere = tempRoot();
    const link = join(elsewhere, "link");
    symlinkSync(primary, link, "dir");
    expect(() => assertOutsideCheckout(join(link, "out"), [primary])).toThrow(/outside every checkout/);
  });

  it("allows a path outside every root", () => {
    const primary = tempRoot();
    const outside = tempRoot();
    expect(() => assertOutsideCheckout(join(outside, "out"), [primary])).not.toThrow();
  });
});
