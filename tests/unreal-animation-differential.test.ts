import { Document } from "@gltf-transform/core";
import { describe, expect, it } from "vitest";

import { parsePsa } from "../src/unreal/psa.js";
import { compareAnimationDifferential } from "./helpers/animation-differential.js";
import type { PsaAnimationSource } from "./helpers/animation-differential.js";

type Quaternion = [number, number, number, number];
const identity: Quaternion = [0, 0, 0, 1];
function turn(degrees: number): Quaternion {
  const half = degrees * Math.PI / 360;
  return [0, 0, Math.sin(half), Math.cos(half)];
}
function unit(q: Quaternion): Quaternion {
  const magnitude = Math.hypot(...q);
  return q.map((value) => value / magnitude) as Quaternion;
}
function source(keys: Quaternion[], times = keys.map((_, index) => index)): PsaAnimationSource {
  return {
    bones: [{ name: "root", parentIndex: -1, translation: [0, 0, 0], rotation: identity }],
    sequences: [{ name: "Walk", rate: 1, frames: keys.length, tracks: [{
      bone: "root", times: new Float32Array(times),
      translations: new Float32Array(keys.length * 3), rotations: new Float32Array(keys.flat()),
    }] }],
  };
}
function channel(
  document: Document, bone: string, times: number[], keys: Quaternion[],
  interpolation: "LINEAR" | "STEP" = "LINEAR",
): void {
  const animation = document.getRoot().listAnimations()[0]!;
  const node = document.getRoot().listNodes().find((entry) => entry.getName() === bone) ?? document.createNode(bone);
  const buffer = document.getRoot().listBuffers()[0] ?? document.createBuffer();
  const input = document.createAccessor().setType("SCALAR").setArray(new Float32Array(times)).setBuffer(buffer);
  const output = document.createAccessor().setType("VEC4").setArray(new Float32Array(keys.flat())).setBuffer(buffer);
  const sampler = document.createAnimationSampler().setInput(input).setOutput(output).setInterpolation(interpolation);
  animation.addSampler(sampler).addChannel(document.createAnimationChannel()
    .setTargetNode(node).setTargetPath("rotation").setSampler(sampler));
}
function document(): Document {
  const result = new Document();
  result.createAnimation("Walk");
  result.createNode("root");
  return result;
}

// ActorX records, supplied independently of the production conversion.
function parsedFixture(): ReturnType<typeof parsePsa> {
  const chunk = (id: string, size: number, records: Buffer[]): Buffer => {
    const header = Buffer.alloc(32);
    header.write(id);
    header.writeInt32LE(size, 24);
    header.writeInt32LE(records.length, 28);
    return Buffer.concat([header, ...records]);
  };
  const bones = ["root", "hand"].map((name, index) => {
    const record = Buffer.alloc(120);
    record.write(name);
    record.writeInt32LE(index - 1, 72);
    [0.2, -0.3, 0.4, 0.5].forEach((value, axis) => record.writeFloatLE(value, 76 + axis * 4));
    return record;
  });
  const info = Buffer.alloc(168);
  info.write("Walk");
  info.writeInt32LE(2, 128);
  info.writeFloatLE(1, 152);
  info.writeInt32LE(2, 164);
  const keys = [
    [0.2, 0.3, 0.4, -0.5], [0.2, 0.3, 0.4, -0.5],
    [-0.1, -0.2, -0.3, 0.9], [-0.1, -0.2, -0.3, 0.9],
  ].map((quaternion) => {
    const record = Buffer.alloc(32);
    quaternion.forEach((value, axis) => record.writeFloatLE(value, 12 + axis * 4));
    return record;
  });
  return parsePsa(Buffer.concat([
    chunk("BONENAMES", 120, bones), chunk("ANIMINFO", 168, [info]), chunk("ANIMKEYS", 32, keys),
  ]));
}

describe("PSA/glTF rotation differential", () => {
  it.each([1, -2])("compares every key with normalized antipodal outputs (scale %s)", (scale) => {
    const doc = document();
    const keys = [identity, turn(60), turn(120)];
    channel(doc, "root", [0, 1, 2], keys.map((q) => q.map((value) => value * scale) as Quaternion));
    const result = compareAnimationDifferential(doc, source(keys));
    expect(result).toMatchObject({ comparedClips: 1, comparedBones: 1, comparedKeys: 3, errors: [], missing: [] });
    expect(result.maxErrorDegrees).toBeLessThan(0.00001);
  });

  it("reports a one-degree error with the exact clip, bone, key and time", () => {
    const doc = document();
    channel(doc, "root", [0, 1], [identity, turn(61)]);
    const result = compareAnimationDifferential(doc, source([identity, turn(60)]));
    expect(result.errors).toHaveLength(1);
    expect(result.worst).toMatchObject({ clip: "Walk", bone: "root", key: 1, time: 1 });
    expect(result.maxErrorDegrees).toBeCloseTo(1, 4);
  });

  it("samples a real LINEAR channel with shortest-arc SLERP at a PSA midpoint", () => {
    const doc = document();
    channel(doc, "root", [0, 2], [identity, turn(120).map((value) => -value) as Quaternion]);
    const result = compareAnimationDifferential(doc, source([identity, turn(60), turn(120)]));
    expect(result.comparedKeys).toBe(3);
    expect(result.errors).toEqual([]);
    expect(result.maxErrorDegrees).toBeLessThan(0.00001);
  });

  it("samples STEP at the exact interior key and between keys", () => {
    const doc = document();
    channel(doc, "root", [0, 1, 2], [identity, turn(60), turn(120)], "STEP");
    const result = compareAnimationDifferential(doc, source([identity, identity, turn(60), turn(60), turn(120)], [0, 0.5, 1, 1.5, 2]));
    expect(result.errors).toEqual([]);
    expect(result.comparedKeys).toBe(5);
  });

  it("precisely reports a missing moving channel, even for movement below the error tolerance", () => {
    const result = compareAnimationDifferential(document(), source([identity, turn(0.1)]));
    expect(result.comparedKeys).toBe(0);
    expect(result.missing).toEqual([{
      clip: "Walk", bone: "root", reason: 'animation "Walk" has no rotation channel for moving bone "root"',
    }]);
  });

  it("uses the actual glTF bind rotation for a constant bone, exposing a wrong bind", () => {
    const doc = document();
    doc.getRoot().listNodes()[0]!.setRotation(turn(30));
    const psa = source([turn(30), turn(30)]);
    expect(compareAnimationDifferential(doc, psa)).toMatchObject({ comparedKeys: 2, errors: [], missing: [] });
    doc.getRoot().listNodes()[0]!.setRotation(turn(31));
    expect(compareAnimationDifferential(doc, psa).errors).toHaveLength(2);
    doc.getRoot().listNodes()[0]!.dispose();
    expect(compareAnimationDifferential(doc, psa).missing[0]?.reason).toContain("no glTF bind quaternion");
  });

  it("covers actual PSA root conjugation, key mirror, Y/Z exchange and antipodal continuity", () => {
    const psa = parsedFixture();
    const rootKeys = [unit([-0.2, -0.4, 0.3, 0.5]), unit([-0.1, -0.3, 0.2, 0.9])];
    const handKeys = [unit([0.2, 0.4, -0.3, 0.5]), unit([0.1, 0.3, -0.2, 0.9])];
    const doc = document();
    channel(doc, "root", [0, 1], rootKeys);
    channel(doc, "hand", [0, 1], handKeys);
    for (const [bone, expected] of [[0, rootKeys], [1, handKeys]] as const) {
      psa.bones[bone]!.rotation.forEach((value, axis) => expect(value).toBeCloseTo(expected[0]![axis]!, 6));
      psa.sequences[0]!.tracks[bone]!.rotations.forEach((value, index) =>
        expect(value).toBeCloseTo(expected[Math.floor(index / 4)]![index % 4]!, 6));
    }
    expect(compareAnimationDifferential(doc, psa)).toMatchObject({ comparedBones: 2, comparedKeys: 4, errors: [], missing: [] });
    // A child/root mix-up must be visible, rather than calibrated away.
    doc.getRoot().listAnimations()[0]!.listChannels()[1]!.getSampler()!.getOutput()!
      .setArray(new Float32Array(rootKeys.flat()));
    expect(compareAnimationDifferential(doc, psa).errors).toHaveLength(2);
  });

  it("rejects ambiguous animation, node and channel names", () => {
    const psa = source([identity, turn(60)]);
    const duplicateClip = document();
    duplicateClip.createAnimation("Walk");
    expect(() => compareAnimationDifferential(duplicateClip, psa)).toThrow('ambiguous animation name "Walk"');
    const duplicateNode = document();
    channel(duplicateNode, "root", [0, 1], [identity, turn(60)]);
    duplicateNode.createNode("ROOT");
    expect(() => compareAnimationDifferential(duplicateNode, psa)).toThrow('ambiguous glTF bone name "Walk"/"root"');
    const duplicateChannel = document();
    channel(duplicateChannel, "root", [0, 1], [identity, turn(60)]);
    channel(duplicateChannel, "root", [0, 1], [identity, turn(60)]);
    expect(() => compareAnimationDifferential(duplicateChannel, psa)).toThrow('ambiguous rotation channels for "Walk"/"root"');
  });

  it("reports a missing source track instead of silently omitting a bone", () => {
    const psa = source([identity]);
    const result = compareAnimationDifferential(document(), { ...psa, sequences: [{ ...psa.sequences[0]!, tracks: [] }] });
    expect(result.missing[0]).toMatchObject({ clip: "Walk", bone: "root", reason: 'PSA animation "Walk" has no track for bone "root"' });
  });

  it("refuses malformed sampler times and unsupported cubic interpolation", () => {
    const doc = document();
    channel(doc, "root", [0, 0], [identity, turn(60)]);
    const psa = source([identity, turn(60)]);
    expect(() => compareAnimationDifferential(doc, psa)).toThrow("strictly increasing");
    doc.getRoot().listAnimations()[0]!.listSamplers()[0]!.setInterpolation("CUBICSPLINE");
    expect(() => compareAnimationDifferential(doc, psa)).toThrow('CUBICSPLINE interpolation is unsupported');
  });
});
