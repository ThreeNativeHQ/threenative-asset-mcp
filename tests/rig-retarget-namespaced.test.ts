import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Document, NodeIO, type Node } from "@gltf-transform/core";
import { Quaternion, Vector3 } from "three";
import { describe, expect, it, onTestFinished } from "vitest";

import { mapSkeleton, retargetClip } from "../src/rig/retarget.js";
import { createAssetRetargetAnimationsHandler } from "../src/tools/rig.js";

/**
 * A namespaced, fingered humanoid with Mixamo bone naming. It reproduces the structure of the
 * real rigs the hand fixes were measured on (a 65-bone fingered mannequin retargeted from donors
 * with a different rest pose): the shin is called `Leg`, fingers hang off the wrist with
 * non-trivial authored curls, and an `Armature` ancestor sits above the skeleton.
 */
const NAMESPACE = "mixamorig:";

const q = (axis: [number, number, number], degrees: number): [number, number, number, number] =>
  new Quaternion().setFromAxisAngle(new Vector3(...axis).normalize(), (degrees * Math.PI) / 180).toArray();

interface Bone {
  name: string;
  parent: string | null;
  position: [number, number, number];
  rotation?: [number, number, number, number];
}

function humanoid(armRestDegrees: number, withFingers: boolean): Bone[] {
  const bones: Bone[] = [
    { name: "Hips", parent: null, position: [0, 1, 0] },
    { name: "Spine", parent: "Hips", position: [0, 0.1, 0] },
    { name: "Spine1", parent: "Spine", position: [0, 0.15, 0] },
    { name: "Spine2", parent: "Spine1", position: [0, 0.15, 0] },
    { name: "Neck", parent: "Spine2", position: [0, 0.15, 0] },
    { name: "Head", parent: "Neck", position: [0, 0.1, 0] },
  ];
  for (const [side, sign] of [["Left", 1], ["Right", -1]] as const) {
    const arm = (sign * armRestDegrees) as number;
    bones.push(
      { name: `${side}Shoulder`, parent: "Spine2", position: [sign * 0.05, 0.1, 0] },
      { name: `${side}Arm`, parent: `${side}Shoulder`, position: [sign * 0.1, 0, 0], rotation: q([0, 0, 1], -arm) },
      { name: `${side}ForeArm`, parent: `${side}Arm`, position: [sign * 0.25, 0, 0] },
      { name: `${side}Hand`, parent: `${side}ForeArm`, position: [sign * 0.25, 0, 0], rotation: q([1, 0, 0], sign * 12) },
    );
    if (withFingers) {
      bones.push(
        { name: `${side}HandThumb1`, parent: `${side}Hand`, position: [sign * 0.03, 0, 0.03], rotation: q([1, 2, 3], sign * 31) },
        { name: `${side}HandThumb2`, parent: `${side}HandThumb1`, position: [sign * 0.03, 0, 0], rotation: q([2, -1, 1], 22) },
        { name: `${side}HandIndex1`, parent: `${side}Hand`, position: [sign * 0.09, 0, -0.02], rotation: q([-1, 3, 2], sign * 27) },
        { name: `${side}HandIndex2`, parent: `${side}HandIndex1`, position: [sign * 0.04, 0, 0], rotation: q([0, 0, 1], -35) },
        { name: `${side}HandIndex3`, parent: `${side}HandIndex2`, position: [sign * 0.03, 0, 0], rotation: q([0, 0, 1], -25) },
      );
    }
    bones.push(
      { name: `${side}UpLeg`, parent: "Hips", position: [sign * 0.1, -0.05, 0] },
      { name: `${side}Leg`, parent: `${side}UpLeg`, position: [0, -0.45, 0] },
      { name: `${side}Foot`, parent: `${side}Leg`, position: [0, -0.45, 0] },
      { name: `${side}ToeBase`, parent: `${side}Foot`, position: [0, -0.05, 0.12] },
    );
  }
  return bones;
}

function buildRig(bones: readonly Bone[]) {
  const document = new Document();
  document.createBuffer();
  const scene = document.createScene("Scene");
  const armature = document.createNode("Armature").setRotation(q([0, 1, 0], 90));
  scene.addChild(armature);
  const skin = document.createSkin("Rig");
  const nodes = new Map<string, Node>();
  for (const bone of bones) {
    const node = document.createNode(`${NAMESPACE}${bone.name}`).setTranslation(bone.position);
    if (bone.rotation) node.setRotation(bone.rotation);
    nodes.set(bone.name, node);
    (bone.parent ? nodes.get(bone.parent)! : armature).addChild(node);
    skin.addJoint(node);
  }
  return { document, nodes };
}

function world(node: Node): Quaternion {
  return new Quaternion(...node.getWorldRotation());
}

function addTrack(document: Document, node: Node, keys: Array<[number, number[]]>): void {
  const buffer = document.getRoot().listBuffers()[0]!;
  const sampler = document.createAnimationSampler().setInterpolation("LINEAR")
    .setInput(document.createAccessor().setType("SCALAR").setBuffer(buffer).setArray(new Float32Array(keys.map(([time]) => time))))
    .setOutput(document.createAccessor().setType("VEC4").setBuffer(buffer).setArray(new Float32Array(keys.flatMap(([, value]) => value))));
  const animation = document.getRoot().listAnimations()[0] ?? document.createAnimation("Clip");
  animation.addSampler(sampler).addChannel(document.createAnimationChannel().setSampler(sampler).setTargetNode(node).setTargetPath("rotation"));
}

/** Pose a document at the final keyframe of its last animation. */
function poseAtEnd(document: Document): void {
  for (const channel of document.getRoot().listAnimations().at(-1)!.listChannels()) {
    if (channel.getTargetPath() !== "rotation") continue;
    const values = channel.getSampler()!.getOutput()!.getArray()!;
    channel.getTargetNode()!.setRotation([...values.slice(values.length - 4)] as [number, number, number, number]);
  }
}

const angleBetween = (a: Quaternion, b: Quaternion): number => (a.angleTo(b) * 180) / Math.PI;

describe("namespaced Mixamo-style fingered rigs", () => {
  it("maps the Mixamo shin (`Leg`) and toe base, with no required bone missing", () => {
    const names = humanoid(0, true).map(bone => `${NAMESPACE}${bone.name}`);
    const mapping = mapSkeleton(names, names);
    expect(mapping.requiredMissing).toEqual([]);
    for (const side of ["Left", "Right"]) {
      expect(mapping.map.get(`${NAMESPACE}${side}Leg`)).toBe(`${NAMESPACE}${side}Leg`);
      expect(mapping.map.get(`${NAMESPACE}${side}ToeBase`)).toBe(`${NAMESPACE}${side}ToeBase`);
      expect(mapping.map.get(`${NAMESPACE}${side}HandIndex1`)).toBe(`${NAMESPACE}${side}HandIndex1`);
    }
  });

  it("maps a Mixamo donor onto an Unreal-style target and an Unreal-style donor onto Mixamo", () => {
    const mixamo = humanoid(0, false).map(bone => `${NAMESPACE}${bone.name}`);
    const unreal = ["root", "pelvis", "spine_01", "spine_02", "spine_03", "neck_01", "Head", "clavicle_l", "upperarm_l", "lowerarm_l", "hand_l", "clavicle_r", "upperarm_r", "lowerarm_r", "hand_r", "thigh_l", "calf_l", "foot_l", "ball_l", "thigh_r", "calf_r", "foot_r", "ball_r"];
    expect(mapSkeleton(mixamo, unreal).requiredMissing).toEqual([]);
    const reverse = mapSkeleton(unreal, mixamo);
    expect(reverse.requiredMissing).toEqual([]);
    expect(reverse.map.get(`${NAMESPACE}LeftLeg`)).toBe("calf_l");
    expect(reverse.map.get(`${NAMESPACE}RightToeBase`)).toBe("ball_r");
  });

  it("bends the knees, follows the wrists and keeps every finger curl through a different donor rest pose", async () => {
    // The donor stands in a T pose, the target in an A pose; the clip bends knees and twists wrists.
    const donor = buildRig(humanoid(0, false));
    const target = buildRig(humanoid(40, true));
    for (const side of ["Left", "Right"]) {
      addTrack(donor.document, donor.nodes.get(`${side}Leg`)!, [[0, [0, 0, 0, 1]], [1, q([1, 0, 0], 70)]]);
      addTrack(donor.document, donor.nodes.get(`${side}Hand`)!, [[0, donor.nodes.get(`${side}Hand`)!.getRotation() as number[]], [1, q([1, -2, 3], 80)]]);
      addTrack(donor.document, donor.nodes.get(`${side}Arm`)!, [[0, donor.nodes.get(`${side}Arm`)!.getRotation() as number[]], [1, q([0, 1, 1], 50)]]);
    }
    const donorRest = new Map([...donor.nodes].map(([name, node]) => [name, world(node)]));
    const targetRest = new Map([...target.nodes].map(([name, node]) => [name, world(node)]));
    const fingerRest = new Map([...target.nodes].filter(([name]) => /HandIndex|HandThumb/.test(name))
      .map(([name, node]) => [name, new Quaternion(...node.getRotation())]));

    const tipInWrist = (side: string): Vector3 => {
      const wrist = target.nodes.get(`${side}Hand`)!;
      return new Vector3(...target.nodes.get(`${side}HandIndex3`)!.getWorldTranslation())
        .sub(new Vector3(...wrist.getWorldTranslation())).applyQuaternion(world(wrist).invert());
    };
    const restTip = new Map(["Left", "Right"].map(side => [side, tipInWrist(side)]));

    const result = await retargetClip(donor.document, target.document, { clipName: "Clip" });
    expect(result.omittedRoles.filter(name => /Hand(Index|Thumb)/.test(name))).toHaveLength(10);
    expect(result.omittedRoles.filter(name => /Leg$|ToeBase$/.test(name))).toEqual([]);

    poseAtEnd(donor.document);
    poseAtEnd(target.document);
    for (const side of ["Left", "Right"]) {
      for (const bone of [`${side}Leg`, `${side}Hand`, `${side}Arm`]) {
        const delta = world(donor.nodes.get(bone)!).multiply(donorRest.get(bone)!.clone().invert());
        const expected = delta.multiply(targetRest.get(bone)!);
        expect(angleBetween(world(target.nodes.get(bone)!), expected), `${side} ${bone} world rotation`).toBeLessThan(0.05);
      }
      for (const [name, rest] of fingerRest) {
        if (!name.startsWith(side)) continue;
        const finger = target.nodes.get(name)!;
        expect(angleBetween(new Quaternion(...finger.getRotation()), rest), `${name} local rotation vs rest`).toBeLessThan(0.05);
      }
      // Fingertips must keep their wrist-relative placement: no counter-rotation, no collapse.
      expect(restTip.get(side)!.length()).toBeGreaterThan(0.1);
      expect(tipInWrist(side).distanceTo(restTip.get(side)!), `${side} fingertip in wrist space`).toBeLessThan(1e-4);
    }
  });
});

describe("retarget report on fingered rigs", () => {
  it("reports a rig with more than 64 unmapped joints instead of rejecting it as an invalid request", async () => {
    // Full-body fingered rigs (Unreal Manny with twist bones, Daz, Mixamo plus helpers) carry
    // far more optional joints than the 23 body roles. They are valid targets, not errors.
    const donor = buildRig(humanoid(0, false));
    const target = buildRig(humanoid(40, true));
    for (const side of ["Left", "Right"]) {
      for (let index = 0; index < 45; index += 1) {
        const helper = target.document.createNode(`${NAMESPACE}${side}HandHelper${index}`).setTranslation([0.01 * index, 0, 0]);
        target.nodes.get(`${side}Hand`)!.addChild(helper);
        target.document.getRoot().listSkins()[0]!.addJoint(helper);
      }
    }
    addTrack(donor.document, donor.nodes.get("LeftArm")!, [[0, donor.nodes.get("LeftArm")!.getRotation() as number[]], [1, q([0, 1, 1], 50)]]);

    const directory = await mkdtemp(join(tmpdir(), "asset-mcp-retarget-omitted-"));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const targetPath = join(directory, "target.glb");
    await writeFile(targetPath, await new NodeIO().writeBinary(target.document));
    const handler = createAssetRetargetAnimationsHandler({ loadDonor: async () => donor.document });
    const result = await handler({
      target: targetPath,
      output: join(directory, "out.glb"),
      projectRoot: directory,
      clips: [{ id: "mixamo/Clip", variant: "in_place" }],
    });
    expect("isError" in result ? JSON.stringify(result.content) : "").toBe("");
    const report = (result as { structuredContent: { clips: Array<{ omittedRoles: string[] }> } }).structuredContent;
    expect(report.clips[0]!.omittedRoles.length).toBeGreaterThan(64);
  });
});
