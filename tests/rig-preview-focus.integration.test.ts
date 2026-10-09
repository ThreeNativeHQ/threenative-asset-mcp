import { Document, NodeIO } from "@gltf-transform/core";
import sharp from "sharp";
import { Matrix4, Quaternion, Vector3 } from "three";
import { expect, it } from "vitest";

import { renderPreview } from "../src/rig/preview.js";

/**
 * A tall grey body with a small red hand on a wrist bone (two fingertip bones below it). The clip
 * swings the whole rig about the root, so a camera fixed on the model leaves the hand off-centre
 * while a camera focused on the wrist keeps it framed.
 */
async function figure(occluder = false): Promise<Uint8Array> {
  const document = new Document();
  const buffer = document.createBuffer();
  const root = document.createNode("root");
  const wrist = document.createNode("wrist.L").setTranslation([0.9, 1.4, 0]);
  const tip = document.createNode("tip.L").setTranslation([0.2, 0, 0]);
  root.addChild(wrist);
  wrist.addChild(tip);
  const joints = [root, wrist, tip];
  const skin = document.createSkin("Skin");
  for (const joint of joints) skin.addJoint(joint);
  skin.setInverseBindMatrices(document.createAccessor().setType("MAT4").setBuffer(buffer)
    .setArray(new Float32Array(joints.flatMap(joint => new Matrix4().fromArray(joint.getWorldMatrix()).invert().toArray()))));

  const quad = (x0: number, y0: number, x1: number, y1: number, joint: number, color: [number, number, number, number]) => {
    const primitive = document.createPrimitive()
      .setMaterial(document.createMaterial().setBaseColorFactor(color).setDoubleSided(true).setRoughnessFactor(1))
      .setAttribute("POSITION", document.createAccessor().setType("VEC3").setBuffer(buffer)
        .setArray(new Float32Array([x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y0, 0, x1, y1, 0, x0, y1, 0])))
      .setAttribute("NORMAL", document.createAccessor().setType("VEC3").setBuffer(buffer)
        .setArray(new Float32Array(Array.from({ length: 6 }, () => [0, 0, 1]).flat())))
      .setAttribute("JOINTS_0", document.createAccessor().setType("VEC4").setBuffer(buffer)
        .setArray(new Uint16Array(Array.from({ length: 6 }, () => [joint, 0, 0, 0]).flat())))
      .setAttribute("WEIGHTS_0", document.createAccessor().setType("VEC4").setBuffer(buffer)
        .setArray(new Float32Array(Array.from({ length: 6 }, () => [1, 0, 0, 0]).flat())));
    return primitive;
  };
  const mesh = document.createMesh("Body")
    .addPrimitive(quad(-0.3, 0, 0.3, 2, 0, [0.6, 0.6, 0.6, 1]))
    .addPrimitive(quad(0.9, 1.35, 1.05, 1.45, 1, [1, 0, 0, 1]));
  if (occluder) {
    // A wall between the -x camera and the hand: that close-up shows only a flat grey surface.
    mesh.addPrimitive(document.createPrimitive()
      .setMaterial(document.createMaterial().setBaseColorFactor([0.6, 0.6, 0.6, 1]).setDoubleSided(true).setRoughnessFactor(1))
      .setAttribute("POSITION", document.createAccessor().setType("VEC3").setBuffer(buffer)
        .setArray(new Float32Array([0.7, -3, -3, 0.7, -3, 3, 0.7, 4, 3, 0.7, -3, -3, 0.7, 4, 3, 0.7, 4, -3])))
      .setAttribute("NORMAL", document.createAccessor().setType("VEC3").setBuffer(buffer)
        .setArray(new Float32Array(Array.from({ length: 6 }, () => [-1, 0, 0]).flat())))
      .setAttribute("JOINTS_0", document.createAccessor().setType("VEC4").setBuffer(buffer).setArray(new Uint16Array(24)))
      .setAttribute("WEIGHTS_0", document.createAccessor().setType("VEC4").setBuffer(buffer)
        .setArray(new Float32Array(Array.from({ length: 6 }, () => [1, 0, 0, 0]).flat()))));
  }
  const body = document.createNode("Body").setMesh(mesh).setSkin(skin);
  document.createScene().addChild(root).addChild(body);

  const end = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2).toArray();
  const sampler = document.createAnimationSampler().setInterpolation("LINEAR")
    .setInput(document.createAccessor().setType("SCALAR").setBuffer(buffer).setArray(new Float32Array([0, 1])))
    .setOutput(document.createAccessor().setType("VEC4").setBuffer(buffer).setArray(new Float32Array([0, 0, 0, 1, ...end])));
  document.createAnimation("Swing").addSampler(sampler)
    .addChannel(document.createAnimationChannel().setTargetNode(root).setTargetPath("rotation").setSampler(sampler));
  return new NodeIO().writeBinary(document);
}

/** Share of red pixels and their centroid, as fractions of the image. */
async function redHand(png: Uint8Array): Promise<{ share: number; x: number; y: number }> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  let count = 0, sumX = 0, sumY = 0;
  for (let pixel = 0; pixel < info.width * info.height; pixel += 1) {
    const offset = pixel * info.channels;
    if (data[offset]! > 110 && data[offset + 1]! < 70 && data[offset + 2]! < 70) {
      count += 1;
      sumX += pixel % info.width;
      sumY += Math.floor(pixel / info.width);
    }
  }
  return { share: count / (info.width * info.height), x: count ? sumX / count / info.width : -1, y: count ? sumY / count / info.height : -1 };
}

const options = { clipName: "Swing", times: [0, 1], angles: 1, width: 160, height: 160, timeoutMs: 20_000 };

it("frames the wrist and its fingers and keeps them centred as the animation moves them", async () => {
  const bytes = await figure();
  const whole = await renderPreview(bytes, options);
  const close = await renderPreview(bytes, { ...options, focus: { bone: "wrist.L" } });
  for (const index of [0, 1]) {
    const wide = await redHand(whole.images[index]!.png);
    const near = await redHand(close.images[index]!.png);
    expect(near.share, `close-up ${index} hand size`).toBeGreaterThan(Math.max(wide.share * 8, 0.04));
    expect(Math.abs(near.x - 0.5), `close-up ${index} horizontal centring`).toBeLessThan(0.15);
    expect(Math.abs(near.y - 0.5), `close-up ${index} vertical centring`).toBeLessThan(0.2);
  }
  // The whole-model camera does not follow the hand: its centroid moves a long way between frames.
  const first = await redHand(whole.images[0]!.png);
  const last = await redHand(whole.images[1]!.png);
  expect(Math.hypot(first.x - last.x, first.y - last.y)).toBeGreaterThan(0.1);
}, 60_000);

it("rejects a focus bone that is not in the model instead of rendering the whole model", async () => {
  await expect(renderPreview(await figure(), { ...options, focus: { bone: "wrist.X" } }))
    .rejects.toMatchObject({ code: "RIG_PREVIEW_FAILED" });
}, 30_000);

it("accepts a close-up that looks through a solid body at one angle, but not a set of empty close-ups", async () => {
  const result = await renderPreview(await figure(true), { ...options, times: [0], angles: 4, focus: { bone: "wrist.L" } });
  expect(result.images).toHaveLength(4);
  expect(result.images.some(image => !image.nonBlank)).toBe(true);
  expect(result.images.some(image => image.nonBlank)).toBe(true);
}, 30_000);
