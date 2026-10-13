import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

import { canonicalPackagePath, type RawAnimationAsset } from "../../src/unreal/animation-data.js";
import type { PsaFile } from "../../src/unreal/psa.js";
import { angularErrorDegrees } from "./animation-differential.js";

const text = z.string().min(1);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const finite = z.number().finite();
const vector = z.tuple([finite, finite, finite]);
const quaternion = z.tuple([finite, finite, finite, finite]).refine((q) => Math.abs(Math.hypot(...q) - 1) < 1e-4, "unit quaternion required");
const schema = z.object({
  schema: z.literal("prd596-real-unreal-local-poses-v1"),
  engineVersion: z.literal("5.8.3-58210709+++UE5+Release-5.8"),
  evaluation: z.literal("AnimPoseExtensions.get_anim_pose_at_time; Raw; should_retarget=false; retrieve_additive_as_full_pose=false"),
  quaternionOrder: z.literal("xyzw"), space: z.literal("Unreal local bone"), nonidentityMotion: z.literal(true),
  assets: z.array(z.object({ package: text, source: text, sha256: hash, animation: z.boolean() })).min(1),
  clips: z.array(z.object({
    name: text, asset: text, sourceSHA256: hash, skeleton: text, skeletonSourceSHA256: hash,
    frameRate: z.object({ numerator: finite.int().positive(), denominator: finite.int().positive() }),
    numFrames: finite.int().positive(), playLength: finite.positive(),
    bones: z.array(z.object({ name: text, parent: text.nullable(), pathToRoot: z.array(text).min(1) })).min(1),
    samples: z.array(z.object({ frame: finite.int().nonnegative(), time: finite.nonnegative(),
      poses: z.array(z.object({ rotation: quaternion, translation: vector, scale: vector })).min(1),
    })).min(2),
  })).min(1),
});
export type UnrealAnimationReference = z.infer<typeof schema>;

/** A Y/Z reflection transforms quaternion axial vectors by det(B)B; no ActorX key mirroring. */
export function unrealLocalRotation([x, y, z, w]: readonly number[]): [number, number, number, number] {
  return [-x!, -z!, -y!, w!];
}

export function parseUnrealAnimationReference(value: unknown): UnrealAnimationReference {
  const result = schema.parse(value);
  assert.equal(new Set(result.assets.map((a) => a.package)).size, result.assets.length, "duplicate source package");
  assert.equal(new Set(result.clips.map((c) => c.name)).size, result.clips.length, "duplicate clip name");
  let moving = false;
  for (const clip of result.clips) {
    const label = clip.name;
    assert.equal(clip.asset.split("/").at(-1), label, `${label}: asset name mismatch`);
    const asset = result.assets.find((a) => a.package === clip.asset);
    assert(asset?.animation && asset.sha256 === clip.sourceSHA256, `${label}: source identity mismatch`);
    const skeleton = result.assets.find((a) => a.package === canonicalPackagePath(clip.skeleton));
    assert(skeleton && !skeleton.animation && skeleton.sha256 === clip.skeletonSourceSHA256, `${label}: skeleton identity mismatch`);
    assert.equal(new Set(clip.bones.map((b) => b.name.toLowerCase())).size, clip.bones.length, `${label}: duplicate bone`);
    const bones = new Map(clip.bones.map((b) => [b.name, b]));
    assert(clip.bones.some((b) => b.parent === null), `${label}: root required`);
    for (const bone of clip.bones) {
      const chain: string[] = [];
      let cursor: typeof bone | undefined = bone;
      while (cursor) {
        assert(!chain.includes(cursor.name), `${label}/${bone.name}: hierarchy cycle`);
        chain.push(cursor.name);
        if (cursor.parent === null) break;
        assert(bones.has(cursor.parent), `${label}/${bone.name}: missing parent`);
        cursor = bones.get(cursor.parent);
      }
      assert.deepEqual(bone.pathToRoot, chain, `${label}/${bone.name}: pathToRoot mismatch`);
    }
    const rate = clip.frameRate.numerator / clip.frameRate.denominator;
    assert(Math.abs(clip.playLength - clip.numFrames / rate) < 1e-6, `${label}: duration/frame-rate mismatch`);
    assert.equal(clip.samples.length, clip.numFrames + 1, `${label}: missing frame samples`);
    clip.samples.forEach((sample, frame) => {
      assert.equal(sample.frame, frame, `${label}: frame order mismatch`);
      assert(Math.abs(sample.time - frame / rate) < 1e-6, `${label}: frame time mismatch`);
      assert.equal(sample.poses.length, clip.bones.length, `${label}: missing bone poses`);
      moving ||= sample.poses.some((pose, bone) => angularErrorDegrees(pose.rotation, clip.samples[0]!.poses[bone]!.rotation) > 0.01);
    });
  }
  assert(moving, "reference has no nonidentity rotation motion");
  assert.deepEqual(result.assets.filter((a) => a.animation).map((a) => a.package).sort(), result.clips.map((c) => c.asset).sort(), "source animation coverage mismatch");
  return result;
}

/** Validate existing private export receipts and both original and Unreal-loaded package bytes. */
export async function loadUnrealAnimationReference(path: string): Promise<UnrealAnimationReference> {
  const bytes = await readFile(path);
  const reference = parseUnrealAnimationReference(JSON.parse(bytes.toString("utf8")));
  const dir = dirname(path);
  const provenance = JSON.parse(await readFile(join(dir, "provenance.json"), "utf8")) as { referenceSHA256: string; engineVersion: string; sourceCommit: string; archiveBinarySHA256: string };
  const digest = (data: Buffer): string => createHash("sha256").update(data).digest("hex");
  assert.equal(digest(bytes), provenance.referenceSHA256, "independent export receipt reference digest mismatch");
  assert.equal(provenance.engineVersion, reference.engineVersion);
  assert.equal(provenance.sourceCommit, "396c9f059903aed5fec78ecd3d437a40c6415368");
  const binary = join(dir, "runtime/Engine/Binaries/Linux/UnrealEditor-Cmd");
  const recordedBinary = provenance.archiveBinarySHA256.split("\n").find((line) => line.endsWith(`  ${binary}`))?.split("  ")[0];
  assert(recordedBinary && /^[a-f0-9]{64}$/.test(recordedBinary), "Unreal binary receipt missing");
  assert.equal(digest(await readFile(binary)), recordedBinary, "official Unreal binary digest mismatch");
  const log = await readFile(join(dir, "project/Saved/Logs/Reference.log"), "utf8");
  assert(log.includes("PRD596_EXPORT_OK") && log.includes("finished execution (result 0)"), "independent Unreal run did not finish successfully");
  for (const clip of reference.clips) assert(log.includes(`PRD596_EXPORTED ${clip.name} ${clip.bones.length} ${clip.samples.length}`), `${clip.name}: Unreal export log missing`);
  for (const asset of reference.assets) {
    assert(asset.package.startsWith("/Game/") && !asset.package.split("/").includes(".."), "source package path invalid");
    assert.equal(digest(await readFile(asset.source)), asset.sha256, `${asset.package}: original source hash mismatch`);
    assert.equal(digest(await readFile(join(dir, "project/Content", `${asset.package.slice(6)}.uasset`))), asset.sha256, `${asset.package}: Unreal-loaded source hash mismatch`);
  }
  return reference;
}

export function unrealReferenceSources(reference: UnrealAnimationReference, native: readonly RawAnimationAsset[]): PsaFile[] {
  const clips = native.filter((a) => a.kind === "clip" && a.className === "AnimSequence");
  assert.deepEqual(reference.clips.map((c) => c.asset).sort(), clips.map((c) => canonicalPackagePath(c.package!)).sort(), "exact native/reference clip coverage required");
  return reference.clips.map((clip) => {
    const raw = clips.find((c) => canonicalPackagePath(c.package!) === clip.asset)!;
    assert.equal(raw.name, clip.name, `${clip.name}: native name mismatch`);
    assert.equal(canonicalPackagePath(raw.skeleton!), canonicalPackagePath(clip.skeleton), `${clip.name}: native skeleton mismatch`);
    const timing = (raw as RawAnimationAsset & { timing?: { frames: number; keys: number; rateNumerator: number; rateDenominator: number; duration: number } }).timing;
    assert(timing, `${clip.name}: native timing missing`);
    assert.equal(timing.frames, clip.numFrames, `${clip.name}: native frame count mismatch`);
    assert.equal(timing.keys, clip.samples.length, `${clip.name}: native key count mismatch`);
    assert.equal(timing.rateNumerator, clip.frameRate.numerator, `${clip.name}: native frame-rate numerator mismatch`);
    assert.equal(timing.rateDenominator, clip.frameRate.denominator, `${clip.name}: native frame-rate denominator mismatch`);
    assert(Math.abs(timing.duration - clip.playLength) < 1e-6, `${clip.name}: native duration mismatch`);
    return {
      hasScaleKeys: true,
      bones: clip.bones.map((bone) => ({ name: bone.name, parentIndex: clip.bones.findIndex((b) => b.name === bone.parent), translation: [0, 0, 0] as const, rotation: [0, 0, 0, 1] as const })),
      sequences: [{ name: clip.name, package: clip.asset, skeleton: canonicalPackagePath(clip.skeleton), rate: clip.frameRate.numerator / clip.frameRate.denominator, frames: clip.samples.length,
        tracks: clip.bones.map((bone, index) => ({ bone: bone.name,
          times: new Float32Array(clip.samples.map((s) => s.time)),
          translations: new Float32Array(clip.samples.flatMap((s) => { const [x, y, z] = s.poses[index]!.translation; return [x * 0.01, z * 0.01, y * 0.01]; })),
          rotations: new Float32Array(clip.samples.flatMap((s) => unrealLocalRotation(s.poses[index]!.rotation))),
        })),
      }],
    };
  });
}
