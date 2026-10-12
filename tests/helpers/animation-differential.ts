import type { Animation, AnimationChannel, AnimationSampler, Document } from "@gltf-transform/core";

import type { PsaBone, PsaSequence, PsaTrack } from "../../src/unreal/psa.js";

type Quaternion = readonly [number, number, number, number];

/** The PSA side of the comparison. A full `PsaFile` satisfies this shape. */
export interface PsaAnimationSource {
  readonly bones: readonly PsaBone[];
  readonly sequences: readonly PsaSequence[];
}

export interface AnimationDifferentialOptions {
  /**
   * A PSA bone whose per-key quaternion never departs from its first key by more than this many
   * degrees is "constant". A constant bone may have no glTF rotation channel; each of its keys is
   * then compared against the matching glTF node's bind quaternion instead.
   */
  readonly constantBoneToleranceDegrees?: number;
  /** A compared key counts as an error above this many degrees. */
  readonly toleranceDegrees?: number;
}

export interface AnimationDifferentialKeyError {
  readonly clip: string;
  readonly bone: string;
  readonly key: number;
  readonly time: number;
  readonly expected: Quaternion;
  readonly actual: Quaternion;
  readonly errorDegrees: number;
}

/** A clip, bone, or channel the comparison could not check, named precisely. */
export interface AnimationDifferentialMissing {
  readonly clip: string;
  readonly bone: string;
  readonly reason: string;
}

export interface AnimationDifferentialResult {
  readonly comparedClips: number;
  readonly comparedBones: number;
  readonly comparedKeys: number;
  /** Largest antipodal-aware angular error across every compared key, in degrees. */
  readonly maxErrorDegrees: number;
  /** The worst compared key, or `null` when no key was compared. */
  readonly worst: AnimationDifferentialKeyError | null;
  /** Every compared key whose error exceeds the tolerance, worst first. */
  readonly errors: readonly AnimationDifferentialKeyError[];
  /** Precise identities the comparison could not check; never silently dropped. */
  readonly missing: readonly AnimationDifferentialMissing[];
}

const DEFAULT_CONSTANT_BONE_TOLERANCE_DEGREES = 1e-5;
const DEFAULT_TOLERANCE_DEGREES = 0.5;

function normalize(value: Quaternion): Quaternion {
  const magnitude = Math.hypot(value[0], value[1], value[2], value[3]);
  if (!Number.isFinite(magnitude) || magnitude < 1e-8) {
    throw new Error(`animation differential: quaternion [${value.join(", ")}] is not normalizable.`);
  }
  return [value[0] / magnitude, value[1] / magnitude, value[2] / magnitude, value[3] / magnitude];
}

/** Antipodal-aware angle between two rotations, in degrees: `q` and `-q` are the same rotation. */
export function angularErrorDegrees(a: Quaternion, b: Quaternion): number {
  const left = normalize(a);
  const right = normalize(b);
  const dot = Math.abs(left[0] * right[0] + left[1] * right[1] + left[2] * right[2] + left[3] * right[3]);
  return (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI;
}

/** Shortest-arc spherical interpolation between two unit quaternions. */
export function slerp(a: Quaternion, b: Quaternion, alpha: number): Quaternion {
  const left = normalize(a);
  let right = normalize(b);
  let dot = left[0] * right[0] + left[1] * right[1] + left[2] * right[2] + left[3] * right[3];
  if (dot < 0) {
    right = [-right[0], -right[1], -right[2], -right[3]];
    dot = -dot;
  }
  if (dot > 0.9995) {
    return normalize([
      left[0] + alpha * (right[0] - left[0]),
      left[1] + alpha * (right[1] - left[1]),
      left[2] + alpha * (right[2] - left[2]),
      left[3] + alpha * (right[3] - left[3]),
    ]);
  }
  const theta0 = Math.acos(Math.min(1, dot));
  const theta = theta0 * alpha;
  const sin0 = Math.sin(theta0);
  const s0 = Math.sin(theta0 - theta) / sin0;
  const s1 = Math.sin(theta) / sin0;
  return normalize([
    left[0] * s0 + right[0] * s1,
    left[1] * s0 + right[1] * s1,
    left[2] * s0 + right[2] * s1,
    left[3] * s0 + right[3] * s1,
  ]);
}

function readTrackQuaternions(track: PsaTrack): Quaternion[] {
  const count = track.times.length;
  if (track.rotations.length !== count * 4) {
    throw new Error(
      `animation differential: PSA track "${track.bone}" has ${track.rotations.length} rotation components for ${count} keys.`,
    );
  }
  const keys: Quaternion[] = [];
  for (let index = 0; index < count; index += 1) {
    keys.push([
      track.rotations[index * 4]!,
      track.rotations[index * 4 + 1]!,
      track.rotations[index * 4 + 2]!,
      track.rotations[index * 4 + 3]!,
    ]);
  }
  return keys;
}

function isMoving(keys: readonly Quaternion[], toleranceDegrees: number): boolean {
  const first = keys[0];
  if (first === undefined) return false;
  return keys.some((key) => angularErrorDegrees(first, key) > toleranceDegrees);
}

function sampleQuaternion(
  times: readonly number[],
  values: readonly Quaternion[],
  interpolation: "STEP" | "LINEAR",
  time: number,
): Quaternion {
  const first = times[0];
  if (first === undefined) throw new Error("animation differential: glTF rotation sampler has no keyframes.");
  if (time <= first) return values[0]!;
  const last = times.length - 1;
  if (time >= times[last]!) return values[last]!;
  let upper = 1;
  while (upper < last && times[upper]! < time) upper += 1;
  const lower = upper - 1;
  if (time === times[upper]) return values[upper]!;
  if (interpolation === "STEP") return values[lower]!;
  const span = times[upper]! - times[lower]!;
  const alpha = span <= 0 ? 0 : (time - times[lower]!) / span;
  return slerp(values[lower]!, values[upper]!, alpha);
}

function prepareSampler(
  sampler: AnimationSampler,
  clip: string,
  bone: string,
): (time: number) => Quaternion {
  const input = sampler.getInput();
  const output = sampler.getOutput();
  if (!input || !output) {
    throw new Error(`animation differential: rotation sampler for "${clip}"/"${bone}" has no input or output accessor.`);
  }
  const interpolation = sampler.getInterpolation();
  if (interpolation === "CUBICSPLINE") {
    throw new Error(
      `animation differential: CUBICSPLINE interpolation is unsupported (rotation channel for "${clip}"/"${bone}").`,
    );
  }
  if (interpolation !== "STEP" && interpolation !== "LINEAR") {
    throw new Error(
      `animation differential: unsupported interpolation "${interpolation}" (rotation channel for "${clip}"/"${bone}").`,
    );
  }
  if (input.getType() !== "SCALAR" || output.getType() !== "VEC4") {
    throw new Error(
      `animation differential: rotation channel for "${clip}"/"${bone}" has accessor types ${input.getType()}/${output.getType()}, expected SCALAR/VEC4.`,
    );
  }
  const inputArray = input.getArray();
  const outputArray = output.getArray();
  if (!inputArray || !outputArray) {
    throw new Error(`animation differential: rotation channel for "${clip}"/"${bone}" has an accessor with no array.`);
  }
  const keyCount = input.getCount();
  if (output.getCount() !== keyCount) {
    throw new Error(
      `animation differential: rotation channel for "${clip}"/"${bone}" has ${output.getCount()} output keys for ${keyCount} input times.`,
    );
  }
  const times = Array.from(inputArray);
  if (times.some((time, index) => !Number.isFinite(time) || (index > 0 && time <= times[index - 1]!))) {
    throw new Error(`animation differential: rotation times for "${clip}"/"${bone}" must be finite and strictly increasing.`);
  }
  const values: Quaternion[] = [];
  for (let index = 0; index < keyCount; index += 1) {
    values.push([
      outputArray[index * 4]!,
      outputArray[index * 4 + 1]!,
      outputArray[index * 4 + 2]!,
      outputArray[index * 4 + 3]!,
    ]);
  }
  return (time) => sampleQuaternion(times, values, interpolation, time);
}

function rotationChannels(animation: Animation): Map<string, AnimationChannel> {
  const channels = new Map<string, AnimationChannel>();
  for (const channel of animation.listChannels()) {
    if (channel.getTargetPath() !== "rotation") continue;
    const node = channel.getTargetNode();
    if (node) {
      const key = node.getName().toLowerCase();
      if (channels.has(key)) {
        throw new Error(`animation differential: ambiguous rotation channels for "${animation.getName()}"/"${node.getName()}".`);
      }
      channels.set(key, channel);
    }
  }
  return channels;
}

/**
 * Compares each parsed PSA rotation sequence against the rotation channels of the matching glTF
 * animation in `document`. The PSA quaternions are already in glTF space (the parser performs the
 * same UE-to-glTF conversion `attachPsaAnimations` writes verbatim), so no per-clip transform is
 * applied. Every PSA bone and key is compared; anything that cannot be compared is reported by
 * identity in `missing` rather than skipped.
 */
export function compareAnimationDifferential(
  document: Document,
  source: PsaAnimationSource,
  options: AnimationDifferentialOptions = {},
): AnimationDifferentialResult {
  if (source.sequences.length === 0) {
    throw new Error("animation differential: no PSA sequences to compare; refusing an empty comparison.");
  }
  const constantTolerance = options.constantBoneToleranceDegrees ?? DEFAULT_CONSTANT_BONE_TOLERANCE_DEGREES;
  const tolerance = options.toleranceDegrees ?? DEFAULT_TOLERANCE_DEGREES;
  const animations = new Map<string, Animation>();
  for (const value of [constantTolerance, tolerance]) {
    if (!Number.isFinite(value) || value < 0) throw new Error("animation differential: tolerances must be finite and nonnegative.");
  }
  for (const animation of document.getRoot().listAnimations()) {
    if (animations.has(animation.getName())) {
      throw new Error(`animation differential: ambiguous animation name "${animation.getName()}".`);
    }
    animations.set(animation.getName(), animation);
  }
  const nodesByName = new Map<string, ReturnType<Document["createNode"]>[]>();
  for (const node of document.getRoot().listNodes()) {
    const key = node.getName().toLowerCase();
    nodesByName.set(key, [...(nodesByName.get(key) ?? []), node]);
  }
  const boneNames = new Set<string>();
  for (const bone of source.bones) {
    const key = bone.name.toLowerCase();
    if (boneNames.has(key)) throw new Error(`animation differential: ambiguous PSA bone name "${bone.name}".`);
    boneNames.add(key);
  }
  const sequenceNames = new Set<string>();
  for (const sequence of source.sequences) {
    if (sequenceNames.has(sequence.name)) throw new Error(`animation differential: ambiguous PSA animation name "${sequence.name}".`);
    sequenceNames.add(sequence.name);
  }

  const errors: AnimationDifferentialKeyError[] = [];
  const missing: AnimationDifferentialMissing[] = [];
  let comparedClips = 0;
  let comparedBones = 0;
  let comparedKeys = 0;
  let maxErrorDegrees = 0;
  let worst: AnimationDifferentialKeyError | null = null;

  const pushKey = (
    clip: string,
    bone: string,
    key: number,
    time: number,
    expected: Quaternion,
    actual: Quaternion,
  ): void => {
    const errorDegrees = angularErrorDegrees(expected, actual);
    comparedKeys += 1;
    if (errorDegrees > maxErrorDegrees) maxErrorDegrees = errorDegrees;
    const entry: AnimationDifferentialKeyError = { clip, bone, key, time, expected, actual, errorDegrees };
    if (worst === null || errorDegrees > worst.errorDegrees) worst = entry;
    if (errorDegrees > tolerance) errors.push(entry);
  };

  for (const sequence of source.sequences) {
    const animation = animations.get(sequence.name);
    if (!animation) {
      missing.push({
        clip: sequence.name,
        bone: "*",
        reason: `document has no animation named "${sequence.name}"`,
      });
      continue;
    }
    comparedClips += 1;
    const channels = rotationChannels(animation);
    const trackNames = new Set<string>();
    for (const track of sequence.tracks) {
      const key = track.bone.toLowerCase();
      if (trackNames.has(key)) throw new Error(`animation differential: ambiguous PSA track "${sequence.name}"/"${track.bone}".`);
      trackNames.add(key);
    }
    for (const bone of source.bones) {
      if (!trackNames.has(bone.name.toLowerCase())) {
        missing.push({ clip: sequence.name, bone: bone.name, reason: `PSA animation "${sequence.name}" has no track for bone "${bone.name}"` });
      }
    }
    for (const track of sequence.tracks) {
      const boneKey = track.bone.toLowerCase();
      const channel = channels.get(boneKey);
      const nodes = nodesByName.get(boneKey) ?? [];
      if (nodes.length > 1) throw new Error(`animation differential: ambiguous glTF bone name "${sequence.name}"/"${track.bone}".`);
      const bind = nodes[0]?.getRotation();
      const keys = readTrackQuaternions(track);
      if (keys.length === 0 || track.times.some((time) => !Number.isFinite(time))) {
        throw new Error(`animation differential: PSA track "${sequence.name}"/"${track.bone}" has empty or non-finite key times.`);
      }
      const moving = isMoving(keys, constantTolerance);
      if (!channel) {
        if (moving) {
          missing.push({
            clip: sequence.name,
            bone: track.bone,
            reason: `animation "${sequence.name}" has no rotation channel for moving bone "${track.bone}"`,
          });
          continue;
        }
        if (!bind) {
          missing.push({
            clip: sequence.name,
            bone: track.bone,
            reason: `bone "${track.bone}" is constant but has no glTF bind quaternion to fall back to`,
          });
          continue;
        }
        comparedBones += 1;
        keys.forEach((expected, key) => pushKey(sequence.name, track.bone, key, track.times[key]!, expected, bind));
        continue;
      }
      const sampler = channel.getSampler();
      if (!sampler) {
        missing.push({
          clip: sequence.name,
          bone: track.bone,
          reason: `rotation channel for bone "${track.bone}" in animation "${sequence.name}" has no sampler`,
        });
        continue;
      }
      const sample = prepareSampler(sampler, sequence.name, track.bone);
      comparedBones += 1;
      keys.forEach((expected, key) => pushKey(sequence.name, track.bone, key, track.times[key]!, expected, sample(track.times[key]!)));
    }
  }

  if (comparedKeys === 0 && missing.length === 0) {
    throw new Error("animation differential: compared no keys; refusing an empty comparison.");
  }
  errors.sort((left, right) => right.errorDegrees - left.errorDegrees);
  return { comparedClips, comparedBones, comparedKeys, maxErrorDegrees, worst, errors, missing };
}
