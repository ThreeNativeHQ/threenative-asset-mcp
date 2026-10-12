import { Document } from "@gltf-transform/core";
import { describe, expect, it } from "vitest";

import { attachPsaAnimations, parsePsa } from "../src/unreal/psa.js";

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
  record.writeFloatLE(1, 88); // quaternion W
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

function fixture(): Buffer {
  const info = Buffer.alloc(168);
  name(info, 0, "Wave");
  name(info, 64, "None");
  info.writeInt32LE(2, 128);
  info.writeInt32LE(4, 140);
  info.writeFloatLE(2, 148);
  info.writeFloatLE(30, 152);
  info.writeInt32LE(0, 160);
  info.writeInt32LE(2, 164);
  return Buffer.concat([
    chunk("ANIMHEAD", 0, []),
    chunk("BONENAMES", 120, [bone("root", -1, [100, 200, 300]), bone("hand", 0, [0, 10, 20])]),
    chunk("ANIMINFO", 168, [info]),
    chunk("ANIMKEYS", 32, [
      key([0, 0, 0], [0, 0, 0, 1]),
      key([1, 2, 3], [0, 0, 0, 1]),
      key([100, 200, 300], [0, 0, 0, 1]),
      key([4, 5, 6], [0, 0, 0, -1]),
    ]),
    // Current UE Viewer writes this empty compatibility chunk; it is not evidence of scale keys.
    chunk("SCALEKEYS", 16, []),
  ]);
}

/**
 * A rig whose one non-root bone never moves, written the way UE Viewer writes it: BONENAMES raw,
 * ANIMKEYS through its MIRROR_MESH path. Measured on AnimalVarietyPack/Wolf — bone `Wolf_-Neck`
 * holds `Y = +4.578` in BONENAMES and `Y = -4.578` in ANIMKEYS frame 0, and the quaternion the
 * same way with `Y` and `W` negated. A correct reader converts both to the same glTF transform.
 */
function staticPose(): Buffer {
  const info = Buffer.alloc(168);
  name(info, 0, "Stand");
  name(info, 64, "None");
  info.writeInt32LE(2, 128);
  info.writeInt32LE(1, 140);
  info.writeFloatLE(1, 148);
  info.writeFloatLE(30, 152);
  info.writeInt32LE(0, 160);
  info.writeInt32LE(1, 164);
  const neck = Buffer.alloc(120);
  name(neck, 0, "neck");
  neck.writeInt32LE(0, 72);
  [0.5, -0.5, -0.5, -0.5].forEach((value, index) => neck.writeFloatLE(value, 76 + index * 4));
  [26.678, 4.578, 0].forEach((value, index) => neck.writeFloatLE(value, 92 + index * 4));
  return Buffer.concat([
    chunk("ANIMHEAD", 0, []),
    chunk("BONENAMES", 120, [bone("root", -1, [0, 0, 0]), neck]),
    chunk("ANIMINFO", 168, [info]),
    chunk("ANIMKEYS", 32, [
      key([0, 0, 0], [0, 0, 0, 1]),
      key([26.678, -4.578, 0], [0.5, 0.5, -0.5, 0.5]),
    ]),
    chunk("SCALEKEYS", 16, []),
  ]);
}

describe("ActorX PSA conversion", () => {
  it("undoes UE Viewer's key mirror so a still bone's clip matches its bind pose", () => {
    const parsed = parsePsa(staticPose());
    const track = parsed.sequences[0]!.tracks[1]!;
    // Float32 keys against float64 bind values, so compare to single-precision, not exactly.
    parsed.bones[1]!.translation.forEach((value, axis) => {
      expect(track.translations[axis]).toBeCloseTo(value, 6);
    });
    parsed.bones[1]!.rotation.forEach((value, axis) => {
      expect(track.rotations[axis]).toBeCloseTo(value, 6);
    });
  });

  it("parses frame-major keys with UE-to-glTF coordinates and seconds", () => {
    const parsed = parsePsa(fixture());
    expect(parsed.bones).toHaveLength(2);
    expect(parsed.bones[0]).toMatchObject({ name: "root", translation: [1, 3, 2] });
    expect(parsed.sequences).toHaveLength(1);
    expect(parsed.hasScaleKeys).toBe(false);
    expect(parsed.sequences[0]!.tracks[0]!.times[0]).toBe(0);
    expect(parsed.sequences[0]!.tracks[0]!.times[1]).toBeCloseTo(1 / 30, 7);
    // ANIMKEYS arrive in UE Viewer's mirrored frame, so glTF Z is the negated UE Y: (x, z, -y).
    // BONENAMES above is not mirrored, which is why `bones[0].translation` keeps its +2.
    expect([...parsed.sequences[0]!.tracks[0]!.translations]).toEqual([0, 0, -0, 1, 3, -2]);
    // Quaternion signs are made continuous, so an opposite-sign identity key does not cause a spin.
    const rotations = parsed.sequences[0]!.tracks[1]!.rotations;
    expect([...rotations.slice(4)]).toEqual([...rotations.slice(0, 4)]);
  });

  it("attaches a compatible clip to real skin joints", () => {
    const document = new Document();
    const rootJoint = document.createNode("root");
    const handJoint = document.createNode("hand");
    rootJoint.addChild(handJoint);
    document.createSkin("Rig").addJoint(rootJoint).addJoint(handJoint).setSkeleton(rootJoint);
    document.createScene().addChild(rootJoint);

    expect(attachPsaAnimations(document, [parsePsa(fixture())])).toEqual({
      attached: ["Wave"],
      existing: [],
      incompatible: [],
      clips: [{ name: "Wave", source: "Wave", coverage: 1 }],
    });
    const animation = document.getRoot().listAnimations()[0];
    expect(animation?.getName()).toBe("Wave");
    expect(animation?.listChannels()).toHaveLength(4);
    expect(animation?.getExtras()).toMatchObject({ unreal: { sourceFormat: "ActorX PSA", boneCoverage: 1 } });
  });

  it("rejects truncated data and does not attach to an unrelated skeleton", () => {
    expect(() => parsePsa(fixture().subarray(0, -1))).toThrow(/truncated|exceeds the file boundary/);
    const document = new Document();
    const joint = document.createNode("unrelated");
    document.createSkin().addJoint(joint);
    expect(attachPsaAnimations(document, [parsePsa(fixture())])).toEqual({
      attached: [],
      existing: [],
      incompatible: ["Wave"],
      clips: [],
    });
  });

  it("does not duplicate a clip already attached by UE Viewer", () => {
    const document = new Document();
    const joint = document.createNode("root");
    document.createSkin().addJoint(joint);
    document.createAnimation("wave");
    expect(attachPsaAnimations(document, [parsePsa(fixture())])).toEqual({
      attached: [],
      existing: ["Wave"],
      incompatible: [],
      clips: [{ name: "Wave", source: "Wave", coverage: 1 }],
    });
    expect(document.getRoot().listAnimations()).toHaveLength(1);
  });

  it("rejects duplicate bone names and non-finite key data", () => {
    const duplicate = Buffer.from(fixture());
    const bonesAt = duplicate.indexOf("BONENAMES") + 32;
    duplicate.copy(duplicate, bonesAt + 120, bonesAt, bonesAt + 64);
    expect(() => parsePsa(duplicate)).toThrow(/duplicate bone name root/);

    const nonFinite = Buffer.from(fixture());
    const keysAt = nonFinite.indexOf("ANIMKEYS") + 32;
    nonFinite.writeFloatLE(Number.NaN, keysAt);
    expect(() => parsePsa(nonFinite)).toThrow(/non-finite translation/);
  });

  function withProvenance(file: ReturnType<typeof parsePsa>, packagePath: string, skeleton: string) {
    return { ...file, sequences: file.sequences.map((sequence) => ({ ...sequence, package: packagePath, skeleton })) };
  }

  function rig(): Document {
    const document = new Document();
    const rootJoint = document.createNode("root");
    const handJoint = document.createNode("hand");
    rootJoint.addChild(handJoint);
    document.createSkin("Rig").addJoint(rootJoint).addJoint(handJoint).setSkeleton(rootJoint);
    document.createScene().addChild(rootJoint);
    return document;
  }

  it("does not attach a clip whose skeleton package differs, even when every bone name matches", () => {
    const document = rig();
    const foreign = withProvenance(parsePsa(fixture()), "/Game/B/Walk", "/Game/B/SK_Hero.SK_Hero");
    expect(attachPsaAnimations(document, [foreign], { skeleton: "/Game/A/SK_Hero.SK_Hero" })).toMatchObject({
      attached: [],
      incompatible: ["Wave"],
      clips: [],
    });
    expect(document.getRoot().listAnimations()).toHaveLength(0);
  });

  it("attaches a clip whose skeleton package matches and records its package provenance", () => {
    const document = rig();
    const own = withProvenance(parsePsa(fixture()), "/Game/B/Walk", "/Game/B/SK_Hero.SK_Hero");
    const result = attachPsaAnimations(document, [own], { skeleton: "/Game/B/SK_Hero.SK_Hero" });
    expect(result.attached).toEqual(["Wave"]);
    expect(result.clips).toEqual([{ name: "Wave", source: "Wave", package: "/Game/B/Walk", skeleton: "/Game/B/SK_Hero.SK_Hero", coverage: 1 }]);
    expect(document.getRoot().listAnimations()[0]!.getExtras()).toMatchObject({ unreal: { sourcePackage: "/Game/B/Walk" } });
  });

  it("gives two same-named clips from different packages distinct glTF animation names", () => {
    const document = rig();
    const first = withProvenance(parsePsa(fixture()), "/Game/A/Walk", "/Game/A/SK_Hero.SK_Hero");
    const second = withProvenance(parsePsa(fixture()), "/Game/B/Walk", "/Game/B/SK_Hero.SK_Hero");
    const result = attachPsaAnimations(document, [first, second]);
    expect(result.attached).toEqual(["Wave", "B_Walk_Wave"]);
    expect(result.clips.map((clip) => [clip.name, clip.source, clip.package])).toEqual([
      ["Wave", "Wave", "/Game/A/Walk"],
      ["B_Walk_Wave", "Wave", "/Game/B/Walk"],
    ]);
    expect(document.getRoot().listAnimations().map((animation) => animation.getName())).toEqual(["Wave", "B_Walk_Wave"]);
  });

  it("keeps a legacy clip with no skeleton provenance attaching by bone names alone", () => {
    const document = rig();
    const legacy = parsePsa(fixture());
    expect(attachPsaAnimations(document, [legacy], { skeleton: "/Game/A/SK_Hero.SK_Hero" }).attached).toEqual(["Wave"]);
  });
});
