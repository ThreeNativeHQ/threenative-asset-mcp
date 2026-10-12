import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Document, NodeIO } from "@gltf-transform/core";
import { describe, expect, it, onTestFinished } from "vitest";

import { packageGlb } from "../src/unreal/importer.js";
import { parsePsa } from "../src/unreal/psa.js";

// The packaging route (not the isolated helper): a clip that names a canonical skeleton must match the
// target mesh's skeleton package, and when the target's skeleton is unknown only a unique candidate may
// fall back to bone names. Two same-bone rigs must never receive each other's clips.

function name(target: Buffer, offset: number, value: string): void {
  target.write(value, offset, Math.min(Buffer.byteLength(value), 63), "utf8");
}

function chunk(id: string, dataSize: number, records: readonly Buffer[]): Buffer {
  const header = Buffer.alloc(32);
  name(header, 0, id);
  header.writeUInt32LE(20_100_422, 20);
  header.writeInt32LE(dataSize, 24);
  header.writeInt32LE(records.length, 28);
  return Buffer.concat([header, ...records]);
}

function bone(boneName: string, parentIndex: number, position: readonly number[]): Buffer {
  const record = Buffer.alloc(120);
  name(record, 0, boneName);
  record.writeInt32LE(parentIndex, 72);
  record.writeFloatLE(1, 88);
  position.forEach((value, index) => record.writeFloatLE(value, 92 + index * 4));
  return record;
}

function key(position: readonly number[], quaternion: readonly number[]): Buffer {
  const record = Buffer.alloc(32);
  position.forEach((value, index) => record.writeFloatLE(value, index * 4));
  quaternion.forEach((value, index) => record.writeFloatLE(value, 12 + index * 4));
  record.writeFloatLE(1, 28);
  return record;
}

/** A PSA with one `Wave` clip whose bones are `root` and `hand`, matching the synthetic rig below. */
function psa(packagePath: string, skeleton: string) {
  const info = Buffer.alloc(168);
  name(info, 0, "Wave");
  name(info, 64, "None");
  info.writeInt32LE(2, 128);
  info.writeInt32LE(4, 140);
  info.writeFloatLE(2, 148);
  info.writeFloatLE(30, 152);
  info.writeInt32LE(0, 160);
  info.writeInt32LE(2, 164);
  const file = parsePsa(Buffer.concat([
    chunk("ANIMHEAD", 0, []),
    chunk("BONENAMES", 120, [bone("root", -1, [100, 200, 300]), bone("hand", 0, [0, 10, 20])]),
    chunk("ANIMINFO", 168, [info]),
    chunk("ANIMKEYS", 32, [
      key([0, 0, 0], [0, 0, 0, 1]),
      key([1, 2, 3], [0, 0, 0, 1]),
      key([100, 200, 300], [0, 0, 0, 1]),
      key([4, 5, 6], [0, 0, 0, -1]),
    ]),
    chunk("SCALEKEYS", 16, []),
  ]));
  return { ...file, sequences: file.sequences.map((sequence) => ({ ...sequence, package: packagePath, skeleton })) };
}

async function writeRig(path: string): Promise<void> {
  const document = new Document();
  const rootJoint = document.createNode("root");
  const handJoint = document.createNode("hand");
  rootJoint.addChild(handJoint);
  document.createSkin("Rig").addJoint(rootJoint).addJoint(handJoint).setSkeleton(rootJoint);
  document.createScene().addChild(rootJoint);
  await new NodeIO().write(path, document);
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

async function pack(directory: string, psaFiles: ReturnType<typeof psa>[], options: { skeleton?: string; allowUnknownSkeleton?: boolean }) {
  const gltfPath = join(directory, "Rig.gltf");
  await writeRig(gltfPath);
  return packageGlb({
    gltfPath,
    glbPath: join(directory, "out.glb"),
    keepAllUvSets: false,
    maxTextureSize: undefined,
    assets: emptyAssets(),
    psaFiles,
    ...options,
  });
}

describe("packaging a clip against its skeleton package", () => {
  it("attaches only to the exact skeleton package and keeps the refusals precise", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tn-psa-skeleton-"));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const own = await pack(directory, [psa("/Game/B/Walk", "/Game/B/SK_Hero")], { skeleton: "/Game/B/SK_Hero" });
    expect(own.attachedPsa).toEqual(["Wave"]);
    const foreign = await pack(directory, [psa("/Game/B/Walk", "/Game/B/SK_Hero")], { skeleton: "/Game/A/SK_Hero" });
    expect(foreign.attachedPsa).toEqual([]);
    expect(foreign.incompatiblePsa).toEqual(["Wave"]);
  });

  it("does not cross-attach a canonical-skeleton clip by bone name when the mesh skeleton is unknown and rigs are ambiguous", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tn-psa-ambiguous-"));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const ambiguous = await pack(directory, [psa("/Game/B/Walk", "/Game/B/SK_Hero")], { allowUnknownSkeleton: false });
    expect(ambiguous.attachedPsa).toEqual([]);
    expect(ambiguous.unresolvedPsa.map((entry) => entry.name)).toEqual(["Wave"]);
    const unique = await pack(directory, [psa("/Game/B/Walk", "/Game/B/SK_Hero")], { allowUnknownSkeleton: true });
    expect(unique.attachedPsa).toEqual(["Wave"]);
  });
});
