import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Document, NodeIO } from "@gltf-transform/core";
import { AnimationMixer, LoopOnce, Matrix4, Object3D, Quaternion, SkinnedMesh, Vector3 } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { expect, it } from "vitest";

import { createAssetRetargetAnimationsHandler } from "../src/tools/rig.js";

function fixture(side: "L" | "R", fingers: boolean) {
  const document = new Document();
  const buffer = document.createBuffer();
  const root = document.createNode("root");
  const hand = document.createNode(`hand.${side}`).setTranslation([side === "L" ? 0.5 : -0.5, 1, 0]);
  root.addChild(hand);
  const joints = [root, hand];
  let parent = hand;
  if (fingers) {
    for (let index = 0; index < 2; index += 1) {
      const finger = document.createNode(`digit-${index}.${side}`)
        .setTranslation([side === "L" ? 0.07 : -0.07, 0, 0.02])
        .setRotation(new Quaternion().setFromAxisAngle(new Vector3(1, index + 1, -2).normalize(), 0.35).toArray());
      parent.addChild(finger);
      joints.push(finger);
      parent = finger;
    }
  }
  const bind = new Matrix4().fromArray(parent.getWorldMatrix());
  const vertices = [[0.01, 0, 0], [0.03, 0, 0], [0.01, 0.015, 0]]
    .map(point => new Vector3(...point).applyMatrix4(bind));
  const skin = document.createSkin("HandRig");
  for (const joint of joints) skin.addJoint(joint);
  skin.setInverseBindMatrices(document.createAccessor().setType("MAT4").setBuffer(buffer)
    .setArray(new Float32Array(joints.flatMap(joint => new Matrix4().fromArray(joint.getWorldMatrix()).invert().toArray()))));
  const primitive = document.createPrimitive()
    .setAttribute("POSITION", document.createAccessor().setType("VEC3").setBuffer(buffer).setArray(new Float32Array(vertices.flatMap(vertex => vertex.toArray()))))
    .setAttribute("JOINTS_0", document.createAccessor().setType("VEC4").setBuffer(buffer).setArray(new Uint16Array([joints.length - 1, 0, 0, 0, joints.length - 1, 0, 0, 0, joints.length - 1, 0, 0, 0])))
    .setAttribute("WEIGHTS_0", document.createAccessor().setType("VEC4").setBuffer(buffer).setArray(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])));
  document.createScene().addChild(root).addChild(document.createNode("Body").setSkin(skin).setMesh(document.createMesh().addPrimitive(primitive)));
  const end = new Quaternion().setFromAxisAngle(new Vector3(1, -2, 3).normalize(), Math.PI / 2);
  const sampler = document.createAnimationSampler().setInterpolation("LINEAR")
    .setInput(document.createAccessor().setType("SCALAR").setBuffer(buffer).setArray(new Float32Array([0, 1])))
    .setOutput(document.createAccessor().setType("VEC4").setBuffer(buffer)
      .setArray(new Float32Array([0, 0, 0, 1, ...(fingers ? [0, 0, 0, 1] : end.toArray())])));
  document.createAnimation(fingers ? "AuthoredIdle" : "WristTurn").addSampler(sampler)
    .addChannel(document.createAnimationChannel().setTargetNode(hand).setTargetPath("rotation").setSampler(sampler));
  return { document, vertices, handBind: new Matrix4().fromArray(hand.getWorldMatrix()), end };
}

it.each(["L", "R"] as const)("publishes %s fingers that deform with the wrist in real Three.js playback", async side => {
  const directory = await mkdtemp(join(tmpdir(), "asset-mcp-hand-playback-"));
  try {
    const target = fixture(side, true);
    const donor = fixture(side, false);
    const inputPath = join(directory, "target.glb");
    const outputPath = join(directory, "prepared.glb");
    const input = await new NodeIO().writeBinary(target.document);
    await writeFile(inputPath, input);
    const handler = createAssetRetargetAnimationsHandler({ loadDonor: async () => donor.document });
    const result = await handler({
      target: inputPath,
      output: outputPath,
      projectRoot: directory,
      clips: [{ id: "ual1/WristTurn", variant: "in_place" }],
    });
    expect("isError" in result ? result.isError : false).toBe(false);
    expect(Buffer.from(await readFile(inputPath))).toEqual(Buffer.from(input));
    const bytes = await readFile(outputPath);
    const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, "");
    expect(gltf.animations.map(clip => clip.name)).toContain("AuthoredIdle");
    const clip = gltf.animations.find(entry => entry.name === "ual1/WristTurn");
    if (!clip) throw new Error("Published retarget clip is missing.");
    const meshes: SkinnedMesh[] = [];
    gltf.scene.traverse(node => { if (node instanceof SkinnedMesh) meshes.push(node); });
    expect(meshes).toHaveLength(1);
    const mesh = meshes[0]!;
    const wrist = mesh.skeleton.bones.find(bone => bone.name.startsWith("hand"));
    if (!wrist) throw new Error("Loaded hand attachment bone is missing.");
    const attachment = new Object3D();
    attachment.position.set(0.02, -0.01, 0.04);
    wrist.add(attachment);
    const mixer = new AnimationMixer(gltf.scene);
    const action = mixer.clipAction(clip);
    action.clampWhenFinished = true;
    action.setLoop(LoopOnce, 1).play();
    for (const time of [0, 0.25, 0.5, 1]) {
      mixer.setTime(time);
      gltf.scene.updateMatrixWorld(true);
      mesh.skeleton.update();
      const handWorld = new Matrix4().makeRotationFromQuaternion(new Quaternion().slerp(donor.end, time))
        .setPosition(new Vector3().setFromMatrixPosition(target.handBind));
      const delta = handWorld.clone().multiply(target.handBind.clone().invert());
      for (let vertex = 0; vertex < target.vertices.length; vertex += 1) {
        const expected = target.vertices[vertex]!.clone().applyMatrix4(delta);
        const actual = mesh.getVertexPosition(vertex, new Vector3()).applyMatrix4(mesh.matrixWorld);
        expect(actual.distanceTo(expected)).toBeLessThan(1e-5);
      }
      const expectedAttachment = attachment.position.clone().applyMatrix4(handWorld);
      expect(attachment.getWorldPosition(new Vector3()).distanceTo(expectedAttachment)).toBeLessThan(1e-5);
    }
    mixer.stopAllAction();
    mixer.uncacheRoot(gltf.scene);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
