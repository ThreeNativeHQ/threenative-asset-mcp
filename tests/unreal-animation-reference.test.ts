import { Document } from "@gltf-transform/core";
import { describe, expect, it } from "vitest";
import type { RawAnimationAsset } from "../src/unreal/animation-data.js";
import { compareAnimationDifferential } from "./helpers/animation-differential.js";
import { parseUnrealAnimationReference, unrealLocalRotation, unrealReferenceSources } from "./helpers/unreal-animation-reference.js";

const digest = "a".repeat(64);
function fixture() {
  return {
    schema: "prd596-real-unreal-local-poses-v1", engineVersion: "5.8.3-58210709+++UE5+Release-5.8",
    evaluation: "AnimPoseExtensions.get_anim_pose_at_time; Raw; should_retarget=false; retrieve_additive_as_full_pose=false",
    quaternionOrder: "xyzw", space: "Unreal local bone", nonidentityMotion: true,
    assets: [{ package: "/Game/Walk", source: "/private/Walk.uasset", sha256: digest, animation: true }, { package: "/Game/Skeleton", source: "/private/Skeleton.uasset", sha256: digest, animation: false }],
    clips: [{ name: "Walk", asset: "/Game/Walk", sourceSHA256: digest, skeleton: "/Game/Skeleton.Skeleton", skeletonSourceSHA256: digest,
      frameRate: { numerator: 1, denominator: 1 }, numFrames: 1, playLength: 1,
      bones: [{ name: "root", parent: null, pathToRoot: ["root"] }],
      samples: [0, 1].map((frame) => ({ frame, time: frame, poses: [{ rotation: frame ? [0.6, 0, 0, 0.8] : [0, 0, 0, 1], translation: [0, 0, 0], scale: [1, 1, 1] }] })),
    }],
  };
}
const native = [{ kind: "clip", className: "AnimSequence", name: "Walk", package: "/Game/Walk", skeleton: "/Game/Skeleton", timing: { frames: 1, keys: 2, rateNumerator: 1, rateDenominator: 1, duration: 1 } }] as unknown as RawAnimationAsset[];

describe("official Unreal local pose reference guard", () => {
  it("uses the fixed reflection for all quaternion axes and antipodal rotations", () => {
    expect(unrealLocalRotation([0.1, 0.2, 0.3, 0.9])).toEqual([-0.1, -0.3, -0.2, 0.9]);
    expect(unrealLocalRotation([-0.1, -0.2, -0.3, -0.9])).toEqual([0.1, 0.3, 0.2, -0.9]);
    // Independent matrix action: B R(q) v must equal R(q') B v for the Y/Z reflection.
    const rotate = ([x, y, z, w]: number[], [a, b, c]: number[]) => [
      (1 - 2 * (y! * y! + z! * z!)) * a! + 2 * (x! * y! - z! * w!) * b! + 2 * (x! * z! + y! * w!) * c!,
      2 * (x! * y! + z! * w!) * a! + (1 - 2 * (x! * x! + z! * z!)) * b! + 2 * (y! * z! - x! * w!) * c!,
      2 * (x! * z! - y! * w!) * a! + 2 * (y! * z! + x! * w!) * b! + (1 - 2 * (x! * x! + y! * y!)) * c!,
    ];
    const q = [0.1, 0.2, 0.3, Math.sqrt(0.86)];
    const [x, y, z] = rotate(q, [2, 3, 5]);
    const actual = rotate(unrealLocalRotation(q), [2, 5, 3]);
    [x!, z!, y!].forEach((expected, axis) => expect(actual[axis]).toBeCloseTo(expected, 12));
  });
  it("rejects nonfinite quaternions, omitted bones/frames and false identity motion", () => {
    const nonfinite = fixture(); nonfinite.clips[0]!.samples[1]!.poses[0]!.rotation[0] = NaN;
    expect(() => parseUnrealAnimationReference(nonfinite)).toThrow();
    const missing = fixture(); missing.clips[0]!.samples[1]!.poses = [];
    expect(() => parseUnrealAnimationReference(missing)).toThrow();
    const frames = fixture(); frames.clips[0]!.samples.pop();
    expect(() => parseUnrealAnimationReference(frames)).toThrow();
    const identity = fixture(); identity.clips[0]!.samples[1]!.poses[0]!.rotation = [0, 0, 0, 1];
    expect(() => parseUnrealAnimationReference(identity)).toThrow("no nonidentity rotation motion");
  });
  it("rejects inconsistent timing, skeletons, sources, names and clip coverage", () => {
    const rate = fixture(); rate.clips[0]!.frameRate.numerator = 2;
    expect(() => parseUnrealAnimationReference(rate)).toThrow("duration/frame-rate mismatch");
    const source = fixture(); source.clips[0]!.sourceSHA256 = "b".repeat(64);
    expect(() => parseUnrealAnimationReference(source)).toThrow("source identity mismatch");
    const ref = parseUnrealAnimationReference(fixture());
    expect(() => unrealReferenceSources(ref, [])).toThrow("clip coverage");
    expect(() => unrealReferenceSources(ref, [{ ...native[0]!, skeleton: "/Game/Other" }])).toThrow("native skeleton mismatch");
    expect(() => unrealReferenceSources(ref, [{ ...native[0]!, name: "Other" }])).toThrow("native name mismatch");
  });
  it("checks every key through the existing sampler and detects a 0.6 degree defect", () => {
    const reference = parseUnrealAnimationReference(fixture());
    const source = unrealReferenceSources(reference, native)[0]!;
    const doc = new Document(); const node = doc.createNode("root"); const buffer = doc.createBuffer();
    const times = doc.createAccessor().setType("SCALAR").setArray(new Float32Array([0, 1])).setBuffer(buffer);
    const values = doc.createAccessor().setType("VEC4").setArray(new Float32Array(source.sequences[0]!.tracks[0]!.rotations)).setBuffer(buffer);
    const sampler = doc.createAnimationSampler().setInput(times).setOutput(values).setInterpolation("LINEAR");
    doc.createAnimation("Walk").addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath("rotation").setSampler(sampler));
    expect(compareAnimationDifferential(doc, source)).toMatchObject({ comparedKeys: 2, errors: [], missing: [] });
    const half = 0.6 * Math.PI / 360;
    values.setArray(new Float32Array([Math.sin(half), 0, 0, Math.cos(half), -0.6, 0, 0, 0.8]));
    expect(compareAnimationDifferential(doc, source).errors[0]).toMatchObject({ bone: "root", key: 0 });
    node.setName("missing");
    // A removed channel on a moving reference bone must be reported, never omitted.
    doc.getRoot().listAnimations()[0]!.listChannels()[0]!.dispose();
    expect(compareAnimationDifferential(doc, source).missing[0]?.reason).toContain("moving bone");
  });
});
