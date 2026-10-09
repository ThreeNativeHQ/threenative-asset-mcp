import { Document, NodeIO, type Node } from "@gltf-transform/core";
import { Quaternion, Vector3 } from "three";
import { describe, expect, it } from "vitest";

import { mapSkeleton, parseFingerJoint, retargetClip, splitJointSide } from "../src/rig/retarget.js";

/**
 * Synthetic fingered humanoids with the structure of the real rigs the transfer was measured
 * on: a 65-joint Unreal-style mannequin (five fingers x three joints plus a leaf, three spine
 * joints, a rotated root) and the same skeleton under Mixamo names with a `mixamorig:`
 * namespace. Every joint has an authored rest rotation and every joint is animated.
 */
type Naming = "unreal" | "mixamo";
const FINGERS = ["thumb", "index", "middle", "ring", "pinky"] as const;
const SIDES = ["L", "R"] as const;

interface Joint {
  key: string;
  parent: string | null;
  position: [number, number, number];
}

function skeleton(options: { fingers: boolean; segments?: Partial<Record<(typeof FINGERS)[number], number>> }): Joint[] {
  const joints: Joint[] = [
    { key: "root", parent: null, position: [0, 0, 0] },
    { key: "pelvis", parent: "root", position: [0, 1, 0] },
    { key: "spine1", parent: "pelvis", position: [0, 0.1, 0] },
    { key: "spine2", parent: "spine1", position: [0, 0.15, 0] },
    { key: "spine3", parent: "spine2", position: [0, 0.15, 0] },
    { key: "neck", parent: "spine3", position: [0, 0.15, 0] },
    { key: "head", parent: "neck", position: [0, 0.1, 0] },
  ];
  for (const side of SIDES) {
    const sign = side === "L" ? 1 : -1;
    joints.push(
      { key: `clavicle.${side}`, parent: "spine3", position: [sign * 0.05, 0.1, 0] },
      { key: `upperarm.${side}`, parent: `clavicle.${side}`, position: [sign * 0.1, 0, 0] },
      { key: `lowerarm.${side}`, parent: `upperarm.${side}`, position: [sign * 0.25, 0, 0] },
      { key: `hand.${side}`, parent: `lowerarm.${side}`, position: [sign * 0.25, 0, 0] },
      { key: `thigh.${side}`, parent: "pelvis", position: [sign * 0.1, -0.05, 0] },
      { key: `calf.${side}`, parent: `thigh.${side}`, position: [0, -0.45, 0] },
      { key: `foot.${side}`, parent: `calf.${side}`, position: [0, -0.45, 0] },
      { key: `ball.${side}`, parent: `foot.${side}`, position: [0, -0.05, 0.12] },
    );
    if (!options.fingers) continue;
    FINGERS.forEach((finger, index) => {
      // 3 phalanges plus a leaf joint, unless the caller asks for a shorter chain.
      const segments = options.segments?.[finger] ?? 4;
      for (let segment = 1; segment <= segments; segment += 1) {
        joints.push({
          key: `${finger}${segment}.${side}`,
          parent: segment === 1 ? `hand.${side}` : `${finger}${segment - 1}.${side}`,
          position: segment === 1 ? [sign * 0.08, 0, (index - 2) * 0.02] : [sign * 0.03, 0, 0],
        });
      }
    });
  }
  return joints;
}

function jointName(key: string, naming: Naming): string {
  const [base, side] = key.split(".") as [string, "L" | "R" | undefined];
  const finger = /^(thumb|index|middle|ring|pinky)(\d)$/.exec(base);
  if (naming === "unreal") {
    const suffix = side ? `_${side.toLowerCase()}` : "";
    if (finger) return finger[2] === "4" ? `${finger[1]}_04_leaf${suffix}` : `${finger[1]}_0${finger[2]}${suffix}`;
    const names: Record<string, string> = { spine1: "spine_01", spine2: "spine_02", spine3: "spine_03", neck: "neck_01", head: "Head" };
    return `${names[base] ?? base}${suffix}`;
  }
  const prefix = side ? (side === "L" ? "Left" : "Right") : "";
  const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
  if (finger) return `mixamorig:${prefix}Hand${capital(finger[1]!)}${finger[2]}`;
  const names: Record<string, string> = {
    root: "Root", pelvis: "Hips", spine1: "Spine", spine2: "Spine1", spine3: "Spine2", neck: "Neck", head: "Head",
    clavicle: "Shoulder", upperarm: "Arm", lowerarm: "ForeArm", hand: "Hand", thigh: "UpLeg", calf: "Leg", foot: "Foot", ball: "ToeBase",
  };
  return `mixamorig:${prefix}${names[base]}`;
}

/** Deterministic pseudo-random unit axis and angle per joint, so every joint has its own motion. */
function hash(key: string, salt: number): number {
  let value = salt * 2654435761;
  for (const char of key) value = Math.imul(value ^ char.charCodeAt(0), 16777619) >>> 0;
  return (value % 10_000) / 10_000;
}

function deltaFor(key: string, keyframe: number, scale: number): Quaternion {
  const axis = new Vector3(hash(key, 1) - 0.5, hash(key, 2) - 0.5, hash(key, 3) - 0.5 + 0.1).normalize();
  const degrees = keyframe === 0 ? 0 : (10 + 50 * hash(key, 4 + keyframe)) * scale;
  return new Quaternion().setFromAxisAngle(axis, (degrees * Math.PI) / 180);
}

function restFor(key: string): Quaternion {
  const axis = new Vector3(hash(key, 11) - 0.5, hash(key, 12) - 0.5, hash(key, 13) - 0.5 + 0.1).normalize();
  const base = key === "root" ? new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2) : new Quaternion();
  return base.multiply(new Quaternion().setFromAxisAngle(axis, ((key.includes(".") ? 12 + 20 * hash(key, 14) : 4) * Math.PI) / 180));
}

const KEY_TIMES = [0, 0.5, 1];

interface Rig {
  document: Document;
  nodes: Map<string, Node>;
  rest: Map<string, Quaternion>;
}

function buildRig(naming: Naming, options: { fingers: boolean; segments?: Partial<Record<(typeof FINGERS)[number], number>>; animateFingers?: boolean }): Rig {
  const document = new Document();
  const buffer = document.createBuffer();
  const armature = document.createNode("Armature");
  document.createScene("Scene").addChild(armature);
  const skin = document.createSkin("Rig");
  const nodes = new Map<string, Node>();
  const rest = new Map<string, Quaternion>();
  const joints = skeleton(options);
  for (const joint of joints) {
    const orientation = restFor(joint.key);
    const node = document.createNode(jointName(joint.key, naming)).setTranslation(joint.position).setRotation(orientation.toArray());
    (joint.parent ? nodes.get(joint.parent)! : armature).addChild(node);
    nodes.set(joint.key, node);
    rest.set(joint.key, orientation);
    skin.addJoint(node);
  }
  const animation = document.createAnimation("Clip");
  const input = document.createAccessor().setType("SCALAR").setBuffer(buffer).setArray(new Float32Array(KEY_TIMES));
  for (const joint of joints) {
    if (/^(thumb|index|middle|ring|pinky)\d/.test(joint.key) && options.animateFingers === false) continue;
    const values = KEY_TIMES.flatMap((_, keyframe) => restFor(joint.key).multiply(deltaFor(joint.key, keyframe, 1)).toArray());
    const sampler = document.createAnimationSampler().setInterpolation("LINEAR").setInput(input)
      .setOutput(document.createAccessor().setType("VEC4").setBuffer(buffer).setArray(new Float32Array(values)));
    animation.addSampler(sampler).addChannel(document.createAnimationChannel().setSampler(sampler).setTargetNode(nodes.get(joint.key)!).setTargetPath("rotation"));
  }
  return { document, nodes, rest };
}

/** The authored local rotation of a joint at time t, interpolated like a glTF viewer does. */
function authored(key: string, time: number): Quaternion {
  const segment = time <= 0.5 ? 0 : 1;
  const alpha = time <= 0.5 ? time / 0.5 : (time - 0.5) / 0.5;
  const at = (keyframe: number) => restFor(key).multiply(deltaFor(key, keyframe, 1));
  return at(segment).slerp(at(segment + 1), alpha);
}

/** Sample a retargeted joint at a time, handling constant two-key tracks and dropped tracks. */
function retargeted(document: Document, node: Node, time: number): Quaternion {
  const channel = document.getRoot().listAnimations().at(-1)!.listChannels()
    .find(entry => entry.getTargetNode() === node && entry.getTargetPath() === "rotation");
  if (!channel) return new Quaternion(...node.getRotation());
  const times = channel.getSampler()!.getInput()!.getArray()!;
  const values = channel.getSampler()!.getOutput()!.getArray()!;
  let index = 0;
  while (index < times.length - 2 && times[index + 1]! < time) index += 1;
  const span = times[index + 1]! - times[index]!;
  const alpha = Math.min(1, Math.max(0, span > 0 ? (time - times[index]!) / span : 0));
  const at = (offset: number) => new Quaternion(values[offset * 4]!, values[offset * 4 + 1]!, values[offset * 4 + 2]!, values[offset * 4 + 3]!).normalize();
  return at(index).slerp(at(index + 1), alpha);
}

const degrees = (a: Quaternion, b: Quaternion): number => (a.angleTo(b) * 180) / Math.PI;
const FRAME_TIMES = [0, 5, 10, 15, 20, 25, 30].map(frame => frame / 30);

describe("finger roles in the skeleton mapping", () => {
  it.each([
    ["handindex1", "index", 1, false],
    ["handthumb3", "thumb", 3, false],
    ["handpinky4", "pinky", 4, false],
    ["index01", "index", 1, false],
    ["ring03", "ring", 3, false],
    ["index04leaf", "index", 4, true],
    ["indexmetacarpal", "index", 0, false],
    ["findex02", "index", 2, false],
    ["littlefinger2", null, 0, false],
    ["finger0", "thumb", 1, false],
    ["finger01", "thumb", 2, false],
    ["finger11", "index", 2, false],
    ["finger42", "pinky", 3, false],
  ])("recognizes %s", (base, finger, segment, leaf) => {
    const parsed = parseFingerJoint(base);
    if (finger === null) expect(parsed === null || parsed.finger === "pinky").toBe(true);
    else expect(parsed).toEqual({ finger, segment, leaf });
  });

  it.each(["hand", "handle", "ringleader", "indexer", "thumbnail", "shoulder", "forearm", "spine01"])("does not mistake %s for a finger", base => {
    expect(parseFingerJoint(base)).toBeNull();
  });

  it("parses 3ds Max Biped names with the side in the middle", () => {
    expect(splitJointSide("Bip01 L Finger0")).toEqual({ base: "finger0", side: "left" });
    expect(splitJointSide("Bip01 R Forearm")).toEqual({ base: "forearm", side: "right" });
    expect(splitJointSide("Bip01 Spine1")).toEqual({ base: "spine1", side: null });
    expect(splitJointSide("Bip01")).toEqual({ base: "bip01", side: null });
  });

  it("maps every finger joint between Unreal and Mixamo naming in both directions", () => {
    const unreal = skeleton({ fingers: true }).map(joint => jointName(joint.key, "unreal"));
    const mixamo = skeleton({ fingers: true }).map(joint => jointName(joint.key, "mixamo"));
    for (const [source, target] of [[unreal, mixamo], [mixamo, unreal]] as const) {
      const mapping = mapSkeleton(source, target);
      expect(mapping.requiredMissing).toEqual([]);
      // Every target joint of both skeletons has a donor: nothing is left to guess.
      expect(mapping.omittedTargets).toEqual([]);
      expect(mapping.map.size).toBe(target.length);
    }
    expect(mapSkeleton(unreal, mixamo).map.get("mixamorig:LeftHandIndex2")).toBe("index_02_l");
    expect(mapSkeleton(unreal, mixamo).map.get("mixamorig:RightHandThumb4")).toBe("thumb_04_leaf_r");
  });

  it("maps a Biped donor onto an Unreal target, fingers included", () => {
    const biped = ["Bip01 Pelvis", "Bip01 Spine", "Bip01 Spine1", "Bip01 Spine2", "Bip01 Neck", "Bip01 Head"];
    for (const [side, token] of [["left", "L"], ["right", "R"]] as const) {
      biped.push(`Bip01 ${token} Clavicle`, `Bip01 ${token} UpperArm`, `Bip01 ${token} Forearm`, `Bip01 ${token} Hand`,
        `Bip01 ${token} Thigh`, `Bip01 ${token} Calf`, `Bip01 ${token} Foot`, `Bip01 ${token} Toe0`,
        `Bip01 ${token} Finger0`, `Bip01 ${token} Finger01`, `Bip01 ${token} Finger02`, `Bip01 ${token} Finger1`, `Bip01 ${token} Finger11`);
      void side;
    }
    const target = skeleton({ fingers: true }).map(joint => jointName(joint.key, "unreal"));
    const mapping = mapSkeleton(biped, target);
    expect(mapping.requiredMissing).toEqual([]);
    expect(mapping.map.get("thumb_01_l")).toBe("Bip01 L Finger0");
    expect(mapping.map.get("thumb_03_r")).toBe("Bip01 R Finger02");
    expect(mapping.map.get("index_02_l")).toBe("Bip01 L Finger11");
    expect(mapping.map.get("ball_r")).toBe("Bip01 R Toe0");
    expect(mapping.map.has("middle_01_l")).toBe(false);
  });
});

describe("spine segments map in order when both rigs have the same count", () => {
  it("sends Mixamo Spine/Spine1/Spine2 to spine_01/02/03, not two segments to one bone", () => {
    const unreal = skeleton({ fingers: false }).map(joint => jointName(joint.key, "unreal"));
    const mixamo = skeleton({ fingers: false }).map(joint => jointName(joint.key, "mixamo"));
    const forward = mapSkeleton(unreal, mixamo).map;
    expect([forward.get("mixamorig:Spine"), forward.get("mixamorig:Spine1"), forward.get("mixamorig:Spine2")]).toEqual(["spine_01", "spine_02", "spine_03"]);
    const reverse = mapSkeleton(mixamo, unreal).map;
    expect([reverse.get("spine_01"), reverse.get("spine_02"), reverse.get("spine_03")]).toEqual(["mixamorig:Spine", "mixamorig:Spine1", "mixamorig:Spine2"]);
  });

  it("keeps the role-table mapping when the spine counts differ", () => {
    const unreal = skeleton({ fingers: false }).map(joint => jointName(joint.key, "unreal"));
    const donor = ["root", "hips", "spine", "chest", "head", "upperarm.l", "lowerarm.l", "hand.l", "upperarm.r", "lowerarm.r", "hand.r",
      "upperleg.l", "lowerleg.l", "foot.l", "toes.l", "upperleg.r", "lowerleg.r", "foot.r", "toes.r"];
    const mapping = mapSkeleton(donor, unreal, { clavicle_l: "chest", clavicle_r: "chest" });
    expect(mapping.map.get("spine_01")).toBe("spine");
    expect(mapping.map.get("spine_02")).toBe("chest");
    expect(mapping.map.get("spine_03")).toBe("chest");
  });
});

const unrealOptions = { fingers: true } as const;

describe("finger animation transfer", () => {

  it.each([["unreal"], ["mixamo"]] as const)("retargeting a %s fingered rig onto itself is the identity for every joint", async naming => {
    const donor = buildRig(naming, unrealOptions);
    const target = buildRig(naming, unrealOptions);
    const result = await retargetClip(donor.document, target.document, { clipName: "Self" });
    expect(result.omittedRoles).toEqual([]);
    let worst = 0, total = 0, count = 0, fingers = 0;
    for (const [key, node] of target.nodes) {
      const isFinger = /^(thumb|index|middle|ring|pinky)\d/.test(key);
      if (isFinger) fingers += 1;
      for (const time of FRAME_TIMES) {
        const error = degrees(retargeted(target.document, node, time), authored(key, time));
        worst = Math.max(worst, error);
        total += error;
        count += 1;
      }
    }
    expect(fingers).toBe(40);
    expect(worst).toBeLessThan(0.5);
    expect(total / count).toBeLessThan(0.1);
  });

  it.each([["unreal", "mixamo"], ["mixamo", "unreal"]] as const)("a %s donor drives a %s target with the donor's own joint motion, fingers included", async (from, to) => {
    const donor = buildRig(from, unrealOptions);
    const target = buildRig(to, unrealOptions);
    const result = await retargetClip(donor.document, target.document, { clipName: "Cross" });
    expect(result.omittedRoles).toEqual([]);
    let worstFinger = 0, worstBody = 0;
    for (const [key, node] of target.nodes) {
      for (const time of FRAME_TIMES) {
        const error = degrees(retargeted(target.document, node, time), authored(key, time));
        if (/^(thumb|index|middle|ring|pinky)\d/.test(key)) worstFinger = Math.max(worstFinger, error);
        else worstBody = Math.max(worstBody, error);
      }
    }
    expect(worstFinger).toBeLessThan(2);
    expect(worstBody).toBeLessThan(2);
  });

  it("transfers a donor's fingers across a different wrist rest pose by world delta", async () => {
    const donor = buildRig("unreal", unrealOptions);
    const target = buildRig("mixamo", unrealOptions);
    // Re-orient the target wrists: the donor's finger motion must still read the same in the world.
    for (const side of SIDES) target.nodes.get(`hand.${side}`)!.setRotation(restFor(`hand.${side}`).multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.6)).toArray());
    const donorRest = new Map([...donor.nodes].map(([key, node]) => [key, new Quaternion(...node.getWorldRotation())]));
    const targetRest = new Map([...target.nodes].map(([key, node]) => [key, new Quaternion(...node.getWorldRotation())]));
    await retargetClip(donor.document, target.document, { clipName: "Cross" });
    const pose = (document: Document, nodes: Map<string, Node>, time: number, sampler: (node: Node, time: number) => Quaternion) => {
      for (const [, node] of nodes) node.setRotation(sampler(node, time).toArray());
      void document;
    };
    pose(donor.document, donor.nodes, 1, (node) => {
      const key = [...donor.nodes].find(([, candidate]) => candidate === node)![0];
      return authored(key, 1);
    });
    pose(target.document, target.nodes, 1, (node) => retargeted(target.document, node, 1));
    for (const key of ["index2.L", "thumb3.R", "pinky1.L"]) {
      const delta = new Quaternion(...donor.nodes.get(key)!.getWorldRotation()).multiply(donorRest.get(key)!.clone().invert());
      const expected = delta.multiply(targetRest.get(key)!);
      expect(degrees(new Quaternion(...target.nodes.get(key)!.getWorldRotation()), expected), key).toBeLessThan(0.1);
    }
  });

  it("leaves every finger exactly at its authored rest when the donor has none", async () => {
    const donor = buildRig("unreal", { fingers: false });
    const target = buildRig("mixamo", unrealOptions);
    const result = await retargetClip(donor.document, target.document, { clipName: "Fingerless" });
    expect(result.omittedRoles.filter(name => /Hand(Thumb|Index|Middle|Ring|Pinky)/.test(name))).toHaveLength(40);
    for (const [key, node] of target.nodes) {
      if (!/^(thumb|index|middle|ring|pinky)\d/.test(key)) continue;
      for (const time of FRAME_TIMES) expect(degrees(retargeted(target.document, node, time), target.rest.get(key)!), key).toBeLessThan(1e-3);
    }
  });

  it("maps partial chains by order without inventing motion for the missing joints", async () => {
    // The donor index finger has two joints, the target four.
    const donor = buildRig("unreal", { fingers: true, segments: { index: 2 } });
    const target = buildRig("unreal", unrealOptions);
    await retargetClip(donor.document, target.document, { clipName: "Partial" });
    for (const side of SIDES) {
      for (const segment of [1, 2]) {
        const key = `index${segment}.${side}`;
        for (const time of FRAME_TIMES) expect(degrees(retargeted(target.document, target.nodes.get(key)!, time), authored(key, time)), key).toBeLessThan(0.5);
      }
      for (const segment of [3, 4]) {
        const key = `index${segment}.${side}`;
        for (const time of FRAME_TIMES) expect(degrees(retargeted(target.document, target.nodes.get(key)!, time), target.rest.get(key)!), key).toBeLessThan(1e-3);
      }
    }
  });
});

describe("constant tracks are stored compactly", () => {
  it("writes an unmoving finger as two keys that play back identically, and keeps moving joints per frame", async () => {
    const donor = buildRig("unreal", { fingers: false });
    const target = buildRig("unreal", unrealOptions);
    await retargetClip(donor.document, target.document, { clipName: "Compact" });
    const animation = target.document.getRoot().listAnimations().at(-1)!;
    const channels = new Map(animation.listChannels().map(channel => [channel.getTargetNode()!.getName(), channel]));
    expect(channels.size).toBe(target.nodes.size);
    const keysOf = (name: string) => channels.get(name)!.getSampler()!.getInput()!.getCount();
    expect(keysOf("index_02_l")).toBe(2);
    expect(keysOf("upperarm_l")).toBeGreaterThan(2);
    const reloaded = await new NodeIO().readBinary(await new NodeIO().writeBinary(target.document));
    const finger = reloaded.getRoot().listNodes().find(node => node.getName() === "index_02_l")!;
    for (const time of FRAME_TIMES) expect(degrees(retargeted(reloaded, finger, time), target.rest.get("index2.L")!), "reloaded finger").toBeLessThan(1e-3);
  });
});
