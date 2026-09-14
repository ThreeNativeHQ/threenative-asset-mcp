import { Document, NodeIO } from "@gltf-transform/core";
import { chromium } from "playwright";
import sharp from "sharp";
import { Matrix4, PropertyBinding, Quaternion, Vector3 } from "three";
import { afterEach, expect, it, vi } from "vitest";

import { previewAvailable, renderPreview } from "../src/rig/preview.js";

afterEach(() => vi.restoreAllMocks());

async function handTriangle(skinned: boolean, clipName?: string): Promise<Uint8Array> {
  const document = new Document();
  const buffer = document.createBuffer();
  const material = document.createMaterial().setDoubleSided(true).setRoughnessFactor(1);
  const primitive = document.createPrimitive().setMaterial(material)
    .setAttribute("POSITION", document.createAccessor().setType("VEC3").setBuffer(buffer)
      .setArray(new Float32Array([-0.5, -0.4, 0, 0.6, -0.4, 0, -0.3, 0.8, 0])))
    .setAttribute("NORMAL", document.createAccessor().setType("VEC3").setBuffer(buffer)
      .setArray(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1])));
  const body = document.createNode("Body").setMesh(document.createMesh().addPrimitive(primitive));
  const scene = document.createScene().addChild(body);
  if (skinned) {
    const rotation = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.8).toArray();
    const hand = document.createNode("hand.L").setRotation(rotation);
    scene.addChild(hand);
    const inverseBind = new Matrix4().fromArray(hand.getWorldMatrix()).invert().toArray();
    const skin = document.createSkin().addJoint(hand)
      .setInverseBindMatrices(document.createAccessor().setType("MAT4").setBuffer(buffer).setArray(new Float32Array(inverseBind)));
    primitive
      .setAttribute("JOINTS_0", document.createAccessor().setType("VEC4").setBuffer(buffer).setArray(new Uint16Array(12)))
      .setAttribute("WEIGHTS_0", document.createAccessor().setType("VEC4").setBuffer(buffer)
        .setArray(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])));
    body.setSkin(skin);
    if (clipName !== undefined) {
      const sampler = document.createAnimationSampler().setInterpolation("LINEAR")
        .setInput(document.createAccessor().setType("SCALAR").setBuffer(buffer).setArray(new Float32Array([0, 1])))
        .setOutput(document.createAccessor().setType("VEC4").setBuffer(buffer).setArray(new Float32Array([...rotation, ...rotation])));
      document.createAnimation(clipName).addSampler(sampler)
        .addChannel(document.createAnimationChannel().setTargetNode(hand).setTargetPath("rotation").setSampler(sampler));
    }
  }
  return new NodeIO().writeBinary(document);
}

const options = { times: [0.5], angles: 2, width: 128, height: 128, timeoutMs: 5_000 };

async function pixelDifference(a: Uint8Array, b: Uint8Array): Promise<number> {
  const first = await sharp(a).raw().toBuffer();
  const second = await sharp(b).raw().toBuffer();
  expect(first.length).toBe(second.length);
  let difference = 0;
  for (let index = 0; index < first.length; index += 1) difference += Math.abs(first[index]! - second[index]!);
  return difference / first.length;
}

it("does not mistake a nonempty browser path for an installed browser", () => {
  vi.spyOn(chromium, "executablePath").mockReturnValue("/missing-pr237-browser/chromium");
  expect(previewAvailable()).toBe(false);
});

it("renders the authored skinned rest pose like its static bind-pose reference", async () => {
  const reference = await renderPreview(await handTriangle(false), options);
  const skinned = await renderPreview(await handTriangle(true), options);
  // Same geometry, materials and camera; skinning at bind must be identity.
  for (let index = 0; index < reference.images.length; index += 1) {
    expect(await pixelDifference(reference.images[index]!.png, skinned.images[index]!.png)).toBeLessThan(0.5);
  }
}, 30_000);

it.each(["hand.L", PropertyBinding.sanitizeNodeName("hand.L")])("applies a requested %s pose after animation sampling", async bone => {
  const bytes = await handTriangle(true, "Hold");
  const base = await renderPreview(bytes, { ...options, clipName: "Hold" });
  const posed = await renderPreview(bytes, { ...options, clipName: "Hold", pose: { bone, axis: "z", degrees: 35 } });
  expect(await pixelDifference(base.images[0]!.png, posed.images[0]!.png)).toBeGreaterThan(2);
}, 30_000);

it("fails an unknown clip instead of approving an unrelated still frame", async () => {
  await expect(renderPreview(await handTriangle(true, "Hold"), { ...options, clipName: "Typo" }))
    .rejects.toMatchObject({ code: "RIG_PREVIEW_FAILED" });
}, 15_000);

it("fails an unknown pose bone instead of silently ignoring the requested proof", async () => {
  await expect(renderPreview(await handTriangle(true), { ...options, pose: { bone: "missing-hand", axis: "z", degrees: 35 } }))
    .rejects.toMatchObject({ code: "RIG_PREVIEW_FAILED" });
}, 15_000);

it("treats HTML-sensitive clip names as data in the preview page", async () => {
  const clipName = "Hold </script> pose";
  const result = await renderPreview(await handTriangle(true, clipName), { ...options, clipName });
  expect(result.animations).toContain(clipName);
  expect(result.images.every(image => image.nonBlank)).toBe(true);
}, 15_000);
