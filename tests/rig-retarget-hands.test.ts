import { Document, NodeIO, type Node } from "@gltf-transform/core";
import { Matrix4, Quaternion, Vector3 } from "three";
import { describe, expect, it } from "vitest";

import { mapSkeleton, retargetClip, splitJointSide } from "../src/rig/retarget.js";

const q = (axis: [number, number, number], degrees: number): [number, number, number, number] =>
  new Quaternion().setFromAxisAngle(new Vector3(...axis).normalize(), degrees * Math.PI / 180).toArray();

function makeRig(fingers = false) {
  const document = new Document();
  const buffer = document.createBuffer();
  const scene = document.createScene("Scene");
  const skin = document.createSkin("Rig");
  const nodes = new Map<string, Node>();
  const add = (name: string, parent?: string): Node => {
    const node = document.createNode(name);
    nodes.set(name, node);
    skin.addJoint(node);
    if (parent) nodes.get(parent)!.addChild(node);
    else scene.addChild(node);
    return node;
  };
  add("root");
  add("pelvis", "root").setTranslation([0, 1, 0]);
  add("chest", "pelvis").setTranslation([0, 0.5, 0]);
  add("head", "chest").setTranslation([0, 0.4, 0]);
  for (const side of ["L", "R"]) {
    const sign = side === "L" ? 1 : -1;
    add(`forearm.${side}`, "chest").setTranslation([sign * 0.4, 0, 0]);
    add(`hand.${side}`, `forearm.${side}`).setTranslation([sign * 0.3, 0, 0]);
    if (fingers) {
      add(`thumb.01.${side}`, `hand.${side}`).setTranslation([sign * 0.05, 0, 0.03]).setRotation(q([1, 2, 3], sign * 23));
      add(`thumb.02.${side}`, `thumb.01.${side}`).setTranslation([sign * 0.04, 0, 0]).setRotation(q([2, -1, 1], 17));
      add(`index.01.${side}`, `hand.${side}`).setTranslation([sign * 0.09, 0, -0.02]).setRotation(q([-1, 3, 2], sign * 19));
      add(`index.02.${side}`, `index.01.${side}`).setTranslation([sign * 0.04, 0, 0]).setRotation(q([1, 1, -2], 13));
    }
  }
  // Real inverse bind matrices, rather than the all-zero matrices in older fixtures.
  skin.setInverseBindMatrices(document.createAccessor("ibm").setType("MAT4").setBuffer(buffer)
    .setArray(new Float32Array(skin.listJoints().flatMap(node => new Matrix4().fromArray(node.getWorldMatrix()).invert().toArray()))));
  const primitive = document.createPrimitive()
    .setAttribute("POSITION", document.createAccessor().setType("VEC3").setBuffer(buffer).setArray(new Float32Array([0, 0, 0, 0.1, 0, 0, 0, 0.1, 0])))
    .setAttribute("JOINTS_0", document.createAccessor().setType("VEC4").setBuffer(buffer).setArray(new Uint16Array(12)))
    .setAttribute("WEIGHTS_0", document.createAccessor().setType("VEC4").setBuffer(buffer).setArray(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])));
  scene.addChild(document.createNode("Body").setSkin(skin).setMesh(document.createMesh().addPrimitive(primitive)));
  return { document, nodes };
}

function animate(document: Document, node: Node, end: [number, number, number, number]) {
  const buffer = document.getRoot().listBuffers()[0]!;
  const sampler = document.createAnimationSampler()
    .setInput(document.createAccessor().setType("SCALAR").setBuffer(buffer).setArray(new Float32Array([0, 1])))
    .setOutput(document.createAccessor().setType("VEC4").setBuffer(buffer).setArray(new Float32Array([...node.getRotation(), ...end])))
    .setInterpolation("LINEAR");
  const animation = document.getRoot().listAnimations()[0] ?? document.createAnimation("WristTurn");
  animation.addSampler(sampler).addChannel(document.createAnimationChannel().setSampler(sampler).setTargetNode(node).setTargetPath("rotation"));
}

function lastRotation(document: Document, name: string): Quaternion {
  const channel = document.getRoot().listAnimations().at(-1)!.listChannels()
    .find(entry => entry.getTargetNode()?.getName() === name && entry.getTargetPath() === "rotation")!;
  const values = channel.getSampler()!.getOutput()!.getArray()!;
  const offset = values.length - 4;
  return new Quaternion(Number(values[offset]), Number(values[offset + 1]), Number(values[offset + 2]), Number(values[offset + 3])).normalize();
}

function applyLastPose(document: Document) {
  for (const channel of document.getRoot().listAnimations().at(-1)!.listChannels()) {
    if (channel.getTargetPath() !== "rotation") continue;
    const node = channel.getTargetNode()!;
    node.setRotation(lastRotation(document, node.getName()).toArray());
  }
}

const expectRotation = (actual: Quaternion, expected: Quaternion) =>
  expect(actual.angleTo(expected)).toBeLessThan(1e-5);

describe("hand retarget regressions", () => {
  it.each(["L", "R"])("keeps unmapped %s fingers in LOCAL rest space through a wrist turn and GLB reload", async side => {
    const source = makeRig();
    const target = makeRig(true);
    target.nodes.get(`hand.${side}`)!.setRotation(q([1, 1, 0], 37));
    const fingerNames = [...target.nodes.keys()].filter(name => /^(thumb|index)/.test(name) && name.endsWith(`.${side}`));
    const rest = new Map(fingerNames.map(name => [name, new Quaternion(...target.nodes.get(name)!.getRotation())]));
    animate(source.document, source.nodes.get(`hand.${side}`)!, q([1, -2, 3], 85));
    const result = await retargetClip(source.document, target.document, { clipName: "WristTurn" });
    const reloaded = await new NodeIO().readBinary(await new NodeIO().writeBinary(target.document));
    for (const name of fingerNames) {
      expect(result.omittedRoles).toContain(name);
      expectRotation(lastRotation(reloaded, name), rest.get(name)!);
    }
    applyLastPose(reloaded);
    const hand = reloaded.getRoot().listNodes().find(node => node.getName() === `hand.${side}`)!;
    const thumb = reloaded.getRoot().listNodes().find(node => node.getName() === `thumb.01.${side}`)!;
    expectRotation(new Quaternion(...thumb.getWorldRotation()), new Quaternion(...hand.getWorldRotation()).multiply(rest.get(thumb.getName())!));
  });

  it("composes animated non-joint ancestors instead of dropping their wrist rotation", async () => {
    const source = makeRig();
    const target = makeRig();
    const forearm = source.nodes.get("forearm.L")!;
    const hand = source.nodes.get("hand.L")!;
    forearm.removeChild(hand);
    const helper = source.document.createNode("hand_control").addChild(hand);
    forearm.addChild(helper);
    animate(source.document, helper, q([1, 2, -1], 60));
    await retargetClip(source.document, target.document, { clipName: "WristTurn" });
    expectRotation(lastRotation(target.document, "hand.L"), new Quaternion(...q([1, 2, -1], 60)));
  });

  it("preserves root rotation rather than silently treating root as an omitted bone", async () => {
    const source = makeRig();
    const target = makeRig();
    animate(source.document, source.nodes.get("root")!, q([0, 1, 0], 90));
    await retargetClip(source.document, target.document, { clipName: "Turn" });
    expectRotation(lastRotation(target.document, "root"), new Quaternion(...q([0, 1, 0], 90)));
  });

  it("still retargets fingers when the caller explicitly supplies their mapping", async () => {
    const source = makeRig(true);
    const target = makeRig(true);
    animate(source.document, source.nodes.get("index.01.L")!, q([1, 2, 3], 51));
    await retargetClip(source.document, target.document, { clipName: "Grip", mapping: { "index.01.L": "index.01.L" } });
    expectRotation(lastRotation(target.document, "index.01.L"), new Quaternion(...q([1, 2, 3], 51)));
    expectRotation(lastRotation(target.document, "index.02.L"), new Quaternion(...target.nodes.get("index.02.L")!.getRotation()));
  });
});

describe("mapping must fail explicitly", () => {
  it.each(["pelvis", "chest", "head"])("reports a missing central %s donor bone", name => {
    const mapping = mapSkeleton(["hand.L"], [name, "hand.L"]);
    expect(mapping.requiredMissing).toContain(`${name} (${name === "pelvis" ? "hips" : name})`);
  });

  it("rejects an override with a misspelled target instead of silently ignoring it", () => {
    expect(() => mapSkeleton(["hand.L"], ["hand.L"], { "hnad.L": "hand.L" })).toThrow(/target/i);
  });

  it("rejects duplicate bone names instead of animating an arbitrary joint", () => {
    expect(() => mapSkeleton(["hand.L", "hand.L"], ["hand.L"])).toThrow(/duplicate|ambiguous/i);
  });

  it.each([
    ["mixamorig:LeftHand", "hand", "left"],
    ["RightForeArm", "forearm", "right"],
    ["hand.L", "hand", "left"],
    ["hand_r", "hand", "right"],
    ["shoulder", "shoulder", null],
  ])("recognizes %s without stripping letters from unsided names", (name, base, side) => {
    expect(splitJointSide(name!)).toEqual({ base, side });
  });
});
