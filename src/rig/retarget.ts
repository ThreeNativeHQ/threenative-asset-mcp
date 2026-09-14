import { Document, type Node } from "@gltf-transform/core";
import { Quaternion, Vector3 } from "three";

import { RigAssetError } from "./inspect.js";

export type JointSide = "left" | "right" | null;

interface RolePreference {
  role: string;
  sided: boolean;
  prefer: readonly string[];
}

/**
 * Donor and target rigs use different naming, so a role table with ordered
 * spellings maps e.g. target `chest` onto the most distal donor spine segment.
 * AETHER's `.L`/`.R`, `upper_arm` and `shin` names are all recognized.
 */
const ROLE_PREFERENCES: readonly RolePreference[] = [
  { role: "root", sided: false, prefer: ["root"] },
  { role: "hips", sided: false, prefer: ["pelvis", "hips", "hip"] },
  { role: "spine", sided: false, prefer: ["spine01", "spine1", "spine"] },
  { role: "chest", sided: false, prefer: ["chest", "upperchest", "spine04", "spine4", "spine03", "spine3", "spine02", "spine2", "spine"] },
  { role: "neck", sided: false, prefer: ["neck", "neck01", "neck1"] },
  { role: "head", sided: false, prefer: ["head"] },
  { role: "shoulder", sided: true, prefer: ["clavicle", "shoulder"] },
  { role: "upper_arm", sided: true, prefer: ["upperarm", "arm"] },
  { role: "forearm", sided: true, prefer: ["lowerarm", "forearm"] },
  { role: "hand", sided: true, prefer: ["hand", "wrist"] },
  { role: "thigh", sided: true, prefer: ["thigh", "upperleg", "upleg"] },
  { role: "shin", sided: true, prefer: ["calf", "shin", "lowerleg"] },
  { role: "foot", sided: true, prefer: ["foot", "ankle"] },
  { role: "toe", sided: true, prefer: ["ball", "toe", "toes"] },
];

export function splitJointSide(name: string): { base: string; side: JointSide } {
  // Namespaces are not anatomy. A single-letter suffix needs a separator or
  // camel-case boundary: the final r in "shoulder" is not a right-side marker.
  const bare = name.replace(/^.*[:|]/, "");
  const suffix = /[._\-\s](left|right|[lr])$/i.exec(bare)
    ?? /(left|right)$/i.exec(bare)
    ?? /(?<=[a-z0-9])([LR])$/.exec(bare);
  if (suffix) {
    const token = suffix[1]!.toLowerCase();
    return {
      base: normalizeJointName(bare.slice(0, suffix.index)),
      side: token === "l" || token === "left" ? "left" : "right",
    };
  }
  const prefix = /^(left|right)[._\-\s]*/i.exec(bare) ?? /^([lr])[._\-\s]/i.exec(bare);
  if (prefix) {
    const token = prefix[1]!.toLowerCase();
    return {
      base: normalizeJointName(bare.slice(prefix[0].length)),
      side: token === "l" || token === "left" ? "left" : "right",
    };
  }
  return { base: normalizeJointName(bare), side: null };
}

/** Lowercase, strip separators, keep digits so spine_01 and spine_03 stay distinct. */
export function normalizeJointName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export interface SkeletonMapping {
  /** target joint name -> source joint name */
  map: Map<string, string>;
  roles: Array<{ role: string; side: JointSide; target: string; source: string }>;
  requiredMissing: string[];
  omittedTargets: string[];
}

function matchRole(
  name: string,
): { role: string; side: JointSide; rank: number } | null {
  const { base, side } = splitJointSide(name);
  for (const preference of ROLE_PREFERENCES) {
    for (let rank = 0; rank < preference.prefer.length; rank += 1) {
      if (base === preference.prefer[rank]) {
        return { role: preference.role, side: preference.sided ? side : null, rank };
      }
    }
  }
  return null;
}

const REQUIRED_ROLES = ["hips", "chest", "head", "shoulder", "upper_arm", "forearm", "hand", "thigh", "shin", "foot"];

export function mapSkeleton(
  sourceJointNames: readonly string[],
  targetJointNames: readonly string[],
  overrides: Record<string, string> = {},
): SkeletonMapping {
  const map = new Map<string, string>();
  const roles: SkeletonMapping["roles"] = [];
  const requiredMissing: string[] = [];
  const omittedTargets: string[] = [];
  const sourceNames = new Set(sourceJointNames);
  const targetNames = new Set(targetJointNames);
  if (sourceNames.size !== sourceJointNames.length || targetNames.size !== targetJointNames.length) {
    throw new RigAssetError("RIG_INVALID_INPUT", "Duplicate joint names make the skeleton mapping ambiguous.");
  }
  for (const [target, source] of Object.entries(overrides)) {
    if (!targetNames.has(target)) {
      throw new RigAssetError("RIG_INVALID_INPUT", `Mapping override names no target joint: ${target}.`);
    }
    if (!sourceNames.has(source)) {
      throw new RigAssetError("RIG_INVALID_INPUT", `Mapping override ${target} -> ${source} names no source joint.`);
    }
  }

  const key = (role: string, side: JointSide): string => `${role}:${side ?? ""}`;
  const sourceByKey = new Map<string, { name: string; rank: number }>();
  for (const name of sourceJointNames) {
    const match = matchRole(name);
    if (!match) continue;
    const k = key(match.role, match.side);
    const existing = sourceByKey.get(k);
    if (!existing || match.rank < existing.rank) {
      sourceByKey.set(k, { name, rank: match.rank });
    }
  }

  for (const target of targetJointNames) {
    const override = Object.hasOwn(overrides, target) ? overrides[target] : undefined;
    if (override !== undefined) {
      map.set(target, override);
      roles.push({ role: "override", side: null, target, source: override });
      continue;
    }
    const match = matchRole(target);
    if (!match) {
      omittedTargets.push(target);
      continue;
    }
    const source = sourceByKey.get(key(match.role, match.side))?.name;
    if (!source) {
      if (REQUIRED_ROLES.includes(match.role)) {
        requiredMissing.push(`${target} (${match.role}${match.side ? `.${match.side[0]}` : ""})`);
      } else {
        omittedTargets.push(target);
      }
      continue;
    }
    map.set(target, source);
    roles.push({ role: match.role, side: match.side, target, source });
  }

  return { map, roles, requiredMissing, omittedTargets };
}

interface LocalTransform {
  position: Vector3;
  rotation: Quaternion;
}

function readLocal(node: Node): LocalTransform {
  const [x, y, z] = node.getTranslation();
  const [qx, qy, qz, qw] = node.getRotation();
  return { position: new Vector3(x, y, z), rotation: new Quaternion(qx, qy, qz, qw) };
}

function jointParentMap(joints: readonly Node[]): Map<Node, Node | null> {
  const parents = new Map<Node, Node | null>();
  // Skin joint arrays need not contain armature/helper nodes. Those ancestors
  // still contribute to rest and animated world transforms.
  for (const joint of joints) {
    let node: Node | null = joint;
    while (node && !parents.has(node)) {
      const parent: Node | null = node.getParentNode();
      parents.set(node, parent);
      node = parent;
    }
  }
  return parents;
}

function hierarchyOrder(joints: readonly Node[], parents: Map<Node, Node | null>): Node[] {
  const order: Node[] = [];
  const visited = new Set<Node>();
  const visit = (node: Node): void => {
    if (visited.has(node)) return;
    const parent = parents.get(node);
    if (parent && !visited.has(parent)) visit(parent);
    visited.add(node);
    order.push(node);
  };
  for (const joint of joints) visit(joint);
  return order;
}

interface RotationTrack {
  times: Float32Array;
  values: Float32Array;
  timesMax: number;
}

function collectRotationTracks(document: Document): Map<Node, RotationTrack> {
  const tracks = new Map<Node, RotationTrack>();
  for (const animation of document.getRoot().listAnimations()) {
    for (const channel of animation.listChannels()) {
      if (channel.getTargetPath() !== "rotation") continue;
      const node = channel.getTargetNode();
      if (!node) continue;
      const sampler = channel.getSampler();
      const input = sampler?.getInput()?.getArray();
      const output = sampler?.getOutput()?.getArray();
      if (!input || !output || input.length === 0) continue;
      tracks.set(node, {
        times: Float32Array.from(input as ArrayLike<number>),
        values: Float32Array.from(output as ArrayLike<number>),
        timesMax: Number(input[input.length - 1]),
      });
    }
  }
  return tracks;
}

function sampleRotation(track: RotationTrack, time: number): Quaternion {
  const count = track.times.length;
  const last = count - 1;
  if (time <= track.times[0]!) return sampleAt(track, 0);
  if (time >= track.times[last]!) return sampleAt(track, last);
  let index = 0;
  while (index < last && track.times[index + 1]! < time) index += 1;
  const t0 = track.times[index]!;
  const t1 = track.times[index + 1]!;
  const span = t1 - t0;
  const alpha = span > 0 ? (time - t0) / span : 0;
  const first = sampleAt(track, index);
  const second = sampleAt(track, index + 1);
  return first.slerp(second, alpha);
}

function sampleAt(track: RotationTrack, index: number): Quaternion {
  const offset = index * 4;
  return new Quaternion(
    track.values[offset]!,
    track.values[offset + 1]!,
    track.values[offset + 2]!,
    track.values[offset + 3]!,
  ).normalize();
}

export interface RetargetOptions {
  clipName: string;
  sampleRate?: number;
  rootMotion?: boolean;
  targetHeight?: number;
  sourceHeight?: number;
  mapping?: Record<string, string>;
}

export interface RetargetResult {
  clipName: string;
  durationSeconds: number;
  frames: number;
  jointTracks: number;
  omittedRoles: string[];
  mapping: SkeletonMapping["roles"];
  rootDisplacement: number;
}

function worldExtent(positions: Float32Array): number {
  let min = Infinity;
  let max = -Infinity;
  for (let index = 1; index < positions.length; index += 3) {
    const value = positions[index]!;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return Number.isFinite(min) ? max - min : 0;
}

function targetPositions(document: Document, parents: Map<Node, Node | null>, order: Node[]): Float32Array {
  const positions = new Float32Array(order.length * 3);
  const worldPosition = new Map<Node, Vector3>();
  order.forEach((node, index) => {
    const parent = parents.get(node);
    const local = readLocal(node).position;
    const parentPosition = parent ? worldPosition.get(parent)! : new Vector3();
    const world = parentPosition.clone().add(local);
    worldPosition.set(node, world);
    positions.set([world.x, world.y, world.z], index * 3);
  });
  return positions;
}

/**
 * Retarget one donor clip onto the target skeleton with a world-space rest
 * correction: each target joint's world orientation becomes the donor joint's
 * world delta applied to the target's rest world, so differing A/T poses and
 * chain lengths do not leak in. Target segment lengths are untouched.
 */
export async function retargetClip(
  sourceDocument: Document,
  targetDocument: Document,
  options: RetargetOptions,
): Promise<RetargetResult> {
  const sourceSkin = sourceDocument.getRoot().listSkins()[0];
  const targetSkin = targetDocument.getRoot().listSkins()[0];
  if (!sourceSkin || !targetSkin) {
    throw new RigAssetError("RIG_INVALID_INPUT", "Both source and target must carry a skeleton.");
  }
  const sourceJoints = sourceSkin.listJoints();
  const targetJoints = targetSkin.listJoints();
  const mapping = mapSkeleton(
    sourceJoints.map((joint) => joint.getName()),
    targetJoints.map((joint) => joint.getName()),
    options.mapping ?? {},
  );
  if (mapping.requiredMissing.length > 0) {
    throw new RigAssetError(
      "RIG_INVALID_INPUT",
      `The donor does not provide required target bones: ${mapping.requiredMissing.join(", ")}.`,
    );
  }

  const sourceTracks = collectRotationTracks(sourceDocument);
  if (sourceTracks.size === 0) {
    throw new RigAssetError("RIG_INVALID_INPUT", `${options.clipName} has no rotation tracks.`);
  }
  const duration = Math.max(...[...sourceTracks.values()].map((track) => track.timesMax));

  const sourceParents = jointParentMap(sourceJoints);
  const sourceOrder = hierarchyOrder(sourceJoints, sourceParents);
  const targetParents = jointParentMap(targetJoints);
  const targetOrder = hierarchyOrder(targetJoints, targetParents);
  const targetIndex = new Map(targetJoints.map((joint, index) => [joint, index]));

  const targetRestWorld = new Map<Node, Quaternion>();
  for (const node of targetOrder) {
    const parent = targetParents.get(node);
    const parentRotation = parent ? targetRestWorld.get(parent)!.clone() : new Quaternion();
    targetRestWorld.set(node, parentRotation.multiply(readLocal(node).rotation));
  }
  const sourceRestWorld = new Map<Node, Quaternion>();
  for (const node of sourceOrder) {
    const parent = sourceParents.get(node);
    const parentRotation = parent ? sourceRestWorld.get(parent)!.clone() : new Quaternion();
    sourceRestWorld.set(node, parentRotation.multiply(readLocal(node).rotation));
  }

  const sampleRate = options.sampleRate ?? 30;
  const frameCount = Math.max(2, Math.ceil(duration * sampleRate) + 1);
  const times = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    times[frame] = Math.min(duration, frame / sampleRate);
  }
  times[frameCount - 1] = duration;

  const targetRotations = new Map<Node, Float32Array<ArrayBuffer>>();
  for (const joint of targetJoints) targetRotations.set(joint, new Float32Array(frameCount * 4));

  for (let frame = 0; frame < frameCount; frame += 1) {
    const time = times[frame]!;
    const sourceAnimated = new Map<Node, Quaternion>();
    for (const node of sourceOrder) {
      const track = sourceTracks.get(node);
      const local = track ? sampleRotation(track, time) : readLocal(node).rotation;
      const parent = sourceParents.get(node);
      const parentRotation = parent ? sourceAnimated.get(parent)!.clone() : new Quaternion();
      sourceAnimated.set(node, parentRotation.multiply(local));
    }
    const targetAnimated = new Map<Node, Quaternion>();
    for (const node of targetOrder) {
      const sourceName = targetIndex.has(node) ? mapping.map.get(node.getName()) : undefined;
      const sourceNode = sourceName ? sourceJoints.find((joint) => joint.getName() === sourceName) : undefined;
      const rest = targetRestWorld.get(node)!;
      const parent = targetParents.get(node);
      const parentWorld = parent ? targetAnimated.get(parent)! : new Quaternion();
      let world: Quaternion;
      if (!sourceNode) {
        // Optional fingers/helpers follow their animated parent in LOCAL rest
        // space. Pinning world=rest counter-rotates them against the wrist.
        world = parentWorld.clone().multiply(readLocal(node).rotation);
      } else {
        const delta = sourceAnimated.get(sourceNode)!.clone().multiply(sourceRestWorld.get(sourceNode)!.clone().invert());
        world = delta.multiply(rest);
      }
      const local = parentWorld.clone().invert().multiply(world).normalize();
      targetAnimated.set(node, world);
      const output = targetRotations.get(node);
      if (output) output.set([local.x, local.y, local.z, local.w], frame * 4);
    }
  }

  const buffer = targetDocument.getRoot().listBuffers()[0] ?? targetDocument.createBuffer();
  const inputAccessor = targetDocument
    .createAccessor(`${options.clipName}-time`)
    .setType("SCALAR")
    .setArray(times)
    .setBuffer(buffer);
  const animation = targetDocument.createAnimation(options.clipName);
  for (const node of targetJoints) {
    const values = targetRotations.get(node)!;
    const output = targetDocument
      .createAccessor(`${options.clipName}-${node.getName()}-rotation`)
      .setType("VEC4")
      .setArray(values)
      .setBuffer(buffer);
    const sampler = targetDocument.createAnimationSampler().setInput(inputAccessor).setOutput(output).setInterpolation("LINEAR");
    animation
      .addSampler(sampler)
      .addChannel(
        targetDocument
          .createAnimationChannel()
          .setSampler(sampler)
          .setTargetNode(node)
          .setTargetPath("rotation"),
      );
  }

  let rootDisplacement = 0;
  if (options.rootMotion) {
    const targetHeight =
      options.targetHeight ?? worldExtent(targetPositions(targetDocument, targetParents, targetOrder));
    const sourceHeight =
      options.sourceHeight ?? worldExtent(targetPositions(sourceDocument, sourceParents, sourceOrder));
    const scale = sourceHeight > 0 ? targetHeight / sourceHeight : 1;
    const sourceRootName = mapping.map.get(targetJoints[0]!.getName()) ?? sourceJoints[0]!.getName();
    const sourceRoot = sourceJoints.find((joint) => joint.getName() === sourceRootName) ?? sourceJoints[0]!;
    const targetRoot = targetJoints.find((joint) => mapping.map.get(joint.getName()) === sourceRootName) ?? targetJoints[0]!;
    const restRoot = readLocal(targetRoot).position;
    const translation = new Float32Array(frameCount * 3);
    const rootTrack = sourceTracks.get(sourceRoot);
    void rootTrack;
    const sourceRootRest = readLocal(sourceRoot).position;
    const sourceRootTranslation = sourceDocument
      .getRoot()
      .listAnimations()
      .flatMap((entry) => entry.listChannels())
      .find((channel) => channel.getTargetNode() === sourceRoot && channel.getTargetPath() === "translation")?.getSampler();
    for (let frame = 0; frame < frameCount; frame += 1) {
      const time = times[frame]!;
      let delta = new Vector3();
      const input = sourceRootTranslation?.getInput()?.getArray();
      const output = sourceRootTranslation?.getOutput()?.getArray();
      if (input && output && input.length > 0) {
        const lastIndex = input.length - 1;
        const clamped = Math.min(Math.max(time, Number(input[0])), Number(input[lastIndex]));
        let index = 0;
        while (index < lastIndex && Number(input[index + 1]) < clamped) index += 1;
        const t0 = Number(input[index]);
        const t1 = Number(input[Math.min(index + 1, lastIndex)]);
        const alpha = t1 > t0 ? (clamped - t0) / (t1 - t0) : 0;
        const a = new Vector3(Number(output[index * 3]), Number(output[index * 3 + 1]), Number(output[index * 3 + 2]));
        const b = new Vector3(
          Number(output[Math.min(index + 1, lastIndex) * 3]),
          Number(output[Math.min(index + 1, lastIndex) * 3 + 1]),
          Number(output[Math.min(index + 1, lastIndex) * 3 + 2]),
        );
        delta = a.lerp(b, alpha).sub(sourceRootRest);
      }
      translation.set(
        [restRoot.x + delta.x * scale, restRoot.y + delta.y * scale, restRoot.z + delta.z * scale],
        frame * 3,
      );
      rootDisplacement = Math.max(rootDisplacement, delta.length() * scale);
    }
    const output = targetDocument
      .createAccessor(`${options.clipName}-${targetRoot.getName()}-translation`)
      .setType("VEC3")
      .setArray(translation)
      .setBuffer(buffer);
    const sampler = targetDocument.createAnimationSampler().setInput(inputAccessor).setOutput(output).setInterpolation("LINEAR");
    animation
      .addSampler(sampler)
      .addChannel(
        targetDocument
          .createAnimationChannel()
          .setSampler(sampler)
          .setTargetNode(targetRoot)
          .setTargetPath("translation"),
      );
  }

  return {
    clipName: options.clipName,
    durationSeconds: duration,
    frames: frameCount,
    jointTracks: targetJoints.length,
    omittedRoles: mapping.omittedTargets,
    mapping: mapping.roles,
    rootDisplacement,
  };
}
