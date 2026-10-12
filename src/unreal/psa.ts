import type { Document, Node } from "@gltf-transform/core";

import { canonicalPackagePath } from "./animation-data.js";

const CHUNK_HEADER_BYTES = 32;
const BONE_BYTES = 120;
const ANIMATION_INFO_BYTES = 168;
const KEY_BYTES = 32;
const MAX_BONES = 16_384;
const MAX_ANIMATIONS = 100_000;
const MAX_KEYS = 100_000_000;

export interface PsaBone {
  readonly name: string;
  readonly parentIndex: number;
  readonly translation: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
}

export interface PsaTrack {
  readonly bone: string;
  readonly times: Float32Array<ArrayBuffer>;
  readonly translations: Float32Array<ArrayBuffer>;
  readonly rotations: Float32Array<ArrayBuffer>;
}

export interface PsaSequence {
  readonly name: string;
  readonly rate: number;
  readonly frames: number;
  readonly tracks: readonly PsaTrack[];
  /**
   * The canonical Unreal package the clip came from (`/Game/Dir/Asset`), when the caller that read the
   * artifact knows it. A PSA file itself carries no package, so this is provenance supplied at parse
   * time; it lets a clip be matched to the exact package that produced it rather than to a basename.
   */
  readonly package?: string;
  /** The canonical package path of the skeleton the clip binds to, when known. */
  readonly skeleton?: string;
}

export interface PsaFile {
  readonly bones: readonly PsaBone[];
  readonly sequences: readonly PsaSequence[];
  readonly hasScaleKeys: boolean;
  /** UE Viewer produced both this PSA and the model's embedded clips in the same export. */
  readonly embeddedGlbSource?: boolean;
}

interface Chunk {
  readonly id: string;
  readonly dataSize: number;
  readonly count: number;
  readonly offset: number;
}

function boundedName(bytes: Buffer, offset: number, length: number, label: string): string {
  const end = bytes.indexOf(0, offset);
  const limit = offset + length;
  const actualEnd = end < offset || end > limit ? limit : end;
  const name = bytes.subarray(offset, actualEnd).toString("utf8").trim();
  if (!name || name.length > length || /[\u0000-\u001f]/u.test(name)) {
    throw new Error(`ActorX PSA ${label} is empty or invalid.`);
  }
  return name;
}

function chunkTable(bytes: Buffer): Map<string, Chunk> {
  if (bytes.length < CHUNK_HEADER_BYTES || bytes.length > 2 ** 32 - 1) {
    throw new Error("ActorX PSA file is empty, truncated, or too large.");
  }
  const chunks = new Map<string, Chunk>();
  let offset = 0;
  while (offset < bytes.length) {
    if (bytes.length - offset < CHUNK_HEADER_BYTES) {
      throw new Error(`ActorX PSA has a truncated chunk header at byte ${offset}.`);
    }
    const id = boundedName(bytes, offset, 20, `chunk identifier at byte ${offset}`);
    const dataSize = bytes.readInt32LE(offset + 24);
    const count = bytes.readInt32LE(offset + 28);
    if (dataSize < 0 || count < 0) throw new Error(`ActorX PSA chunk ${id} has negative dimensions.`);
    const payloadBytes = dataSize * count;
    if (!Number.isSafeInteger(payloadBytes) || payloadBytes > bytes.length - offset - CHUNK_HEADER_BYTES) {
      throw new Error(`ActorX PSA chunk ${id} exceeds the file boundary.`);
    }
    if (chunks.has(id)) throw new Error(`ActorX PSA contains duplicate ${id} chunks.`);
    chunks.set(id, { id, dataSize, count, offset: offset + CHUNK_HEADER_BYTES });
    offset += CHUNK_HEADER_BYTES + payloadBytes;
  }
  return chunks;
}

/**
 * UE Viewer writes the two chunks in two different frames, and reading them as one mirrors every
 * clip against the bind pose the same import emits.
 *
 * `Exporters/ExportPsk.cpp` writes ANIMKEYS through its `MIRROR_MESH` path — `Position.Y *= -1`,
 * `Orientation.Y *= -1`, `Orientation.W *= -1` — while the BONENAMES reference pose is written
 * raw, and `Exporters/ExportGLTF.cpp` writes the glTF bind pose raw too. So the mirror is ours to
 * undo on the keys and only on the keys: it is an involution, applied before the Y/Z exchange
 * below. Measured on AnimalVarietyPack/Wolf, bone `Wolf_-Neck`: BONENAMES holds `Y = +4.578`,
 * ANIMKEYS frame 0 holds `Y = -4.578`, and the bone does not move in that clip.
 *
 * Read without it, `@threenative/core`'s loader detects the Z-mirror and repairs all 21 of
 * SK_Wolf's clips at load, logging `TN_ASSETS_MIRRORED_CLIPS_REPAIRED`.
 */
function position(bytes: Buffer, offset: number, mirrored: boolean): [number, number, number] {
  // UE Viewer uses the same conversion in ExportGLTF.cpp: swap Y/Z and centimetres → metres.
  const ueY = bytes.readFloatLE(offset + 4);
  const value: [number, number, number] = [
    bytes.readFloatLE(offset) * 0.01,
    bytes.readFloatLE(offset + 8) * 0.01,
    (mirrored ? -ueY : ueY) * 0.01,
  ];
  if (value.some((component) => !Number.isFinite(component))) {
    throw new Error("ActorX PSA contains a non-finite translation.");
  }
  return value;
}

function rotation(
  bytes: Buffer,
  offset: number,
  root: boolean,
  mirrored: boolean,
): [number, number, number, number] {
  const ueY = bytes.readFloatLE(offset + 4);
  const ueW = bytes.readFloatLE(offset + 12);
  let value: [number, number, number, number] = [
    bytes.readFloatLE(offset),
    bytes.readFloatLE(offset + 8),
    mirrored ? -ueY : ueY,
    mirrored ? -ueW : ueW,
  ];
  // UE Viewer conjugates the first bone's rotation in ExportGLTF.cpp, bind pose and clips alike.
  if (root) value = [-value[0], -value[1], -value[2], value[3]];
  const magnitude = Math.hypot(...value);
  if (!Number.isFinite(magnitude) || magnitude < 1e-8) return [0, 0, 0, 1];
  return value.map((component) => component === 0 ? 0 : component / magnitude) as [
    number,
    number,
    number,
    number,
  ];
}

/** Parses UE Viewer's bounded ActorX PSA output without depending on Unreal Engine. */
export function parsePsa(bytes: Buffer): PsaFile {
  const chunks = chunkTable(bytes);
  const boneChunk = chunks.get("BONENAMES");
  const infoChunk = chunks.get("ANIMINFO");
  const keyChunk = chunks.get("ANIMKEYS");
  if (!boneChunk || !infoChunk || !keyChunk) {
    throw new Error("ActorX PSA is missing BONENAMES, ANIMINFO, or ANIMKEYS.");
  }
  if (boneChunk.dataSize < BONE_BYTES || boneChunk.count === 0 || boneChunk.count > MAX_BONES) {
    throw new Error("ActorX PSA bone table has an unsupported record size or count.");
  }
  if (infoChunk.dataSize < ANIMATION_INFO_BYTES || infoChunk.count > MAX_ANIMATIONS) {
    throw new Error("ActorX PSA animation table has an unsupported record size or count.");
  }
  if (keyChunk.dataSize < KEY_BYTES || keyChunk.count > MAX_KEYS) {
    throw new Error("ActorX PSA key table has an unsupported record size or count.");
  }

  const bones: PsaBone[] = [];
  const boneNames = new Set<string>();
  for (let index = 0; index < boneChunk.count; index += 1) {
    const offset = boneChunk.offset + index * boneChunk.dataSize;
    const parentIndex = bytes.readInt32LE(offset + 72);
    if (parentIndex < -1 || parentIndex >= boneChunk.count) {
      throw new Error(`ActorX PSA bone ${index} has invalid parent ${parentIndex}.`);
    }
    const name = boundedName(bytes, offset, 64, `bone ${index} name`);
    if (boneNames.has(name.toLowerCase())) {
      throw new Error(`ActorX PSA contains duplicate bone name ${name}.`);
    }
    boneNames.add(name.toLowerCase());
    bones.push({
      name,
      parentIndex,
      rotation: rotation(bytes, offset + 76, index === 0, false),
      translation: position(bytes, offset + 92, false),
    });
  }

  const sequences: PsaSequence[] = [];
  for (let sequenceIndex = 0; sequenceIndex < infoChunk.count; sequenceIndex += 1) {
    const offset = infoChunk.offset + sequenceIndex * infoChunk.dataSize;
    const name = boundedName(bytes, offset, 64, `animation ${sequenceIndex} name`);
    const totalBones = bytes.readInt32LE(offset + 128);
    const rate = bytes.readFloatLE(offset + 152);
    const firstFrame = bytes.readInt32LE(offset + 160);
    const frames = bytes.readInt32LE(offset + 164);
    if (totalBones !== bones.length || frames <= 0 || firstFrame < 0 || !Number.isFinite(rate) || rate < 0) {
      throw new Error(`ActorX PSA animation ${name} has invalid bones, frames, or rate.`);
    }
    const finalKey = (firstFrame + frames) * totalBones;
    if (!Number.isSafeInteger(finalKey) || finalKey > keyChunk.count) {
      throw new Error(`ActorX PSA animation ${name} references keys outside ANIMKEYS.`);
    }
    const effectiveRate = rate > 0.001 ? rate : 1;
    const tracks: PsaTrack[] = [];
    for (let boneIndex = 0; boneIndex < totalBones; boneIndex += 1) {
      const times = new Float32Array(frames);
      const translations = new Float32Array(frames * 3);
      const rotations = new Float32Array(frames * 4);
      let previous: [number, number, number, number] | undefined;
      for (let frame = 0; frame < frames; frame += 1) {
        const keyIndex = (firstFrame + frame) * totalBones + boneIndex;
        const keyOffset = keyChunk.offset + keyIndex * keyChunk.dataSize;
        times[frame] = frame / effectiveRate;
        translations.set(position(bytes, keyOffset, true), frame * 3);
        let quaternion = rotation(bytes, keyOffset + 12, boneIndex === 0, true);
        if (previous && previous.reduce((sum, component, axis) => sum + component * quaternion[axis]!, 0) < 0) {
          quaternion = quaternion.map((component) => component === 0 ? 0 : -component) as [
            number,
            number,
            number,
            number,
          ];
        }
        rotations.set(quaternion, frame * 4);
        previous = quaternion;
      }
      tracks.push({ bone: bones[boneIndex]!.name, times, translations, rotations });
    }
    sequences.push({ name, rate, frames, tracks });
  }

  return { bones, sequences, hasScaleKeys: (chunks.get("SCALEKEYS")?.count ?? 0) > 0 };
}

export interface AttachedPsaClip {
  /** The actual glTF animation name, distinct from any other clip already in the document. */
  readonly name: string;
  /** The PSA's own sequence name, which the reference resolver matches on. */
  readonly source: string;
  readonly package?: string;
  readonly skeleton?: string;
  readonly coverage: number;
}

export interface AttachedPsaUnresolved {
  readonly name: string;
  readonly package?: string;
  readonly reason: string;
}

export interface AttachedPsaResult {
  readonly attached: readonly string[];
  readonly existing: readonly string[];
  readonly incompatible: readonly string[];
  /** A clip that must not be attached, with the precise reason (never silently dropped). */
  readonly unresolved: readonly AttachedPsaUnresolved[];
  /** Provenance for every clip the result names, so a caller can build exact exported-clip identities. */
  readonly clips: readonly AttachedPsaClip[];
}

export interface AttachPsaOptions {
  readonly minimumBoneCoverage?: number;
  /**
   * The canonical package path of the target mesh's skeleton. A clip that names a different canonical
   * skeleton package is not attached, so two rigs that share bone names but not a skeleton never receive
   * each other's clips. A clip with no skeleton provenance still attaches by bone names (legacy UE Viewer
   * route), because that route has no package to compare.
   */
  readonly skeleton?: string;
  /**
   * Whether a clip that names a canonical skeleton may attach to a mesh whose own skeleton package is
   * unknown. The importer permits this only when the mesh candidate is unique (the legacy single-mesh
   * route); absent means the modern clip is left unresolved rather than cross-attached by bone name.
   */
  readonly allowUnknownSkeleton?: boolean;
}

function canonical(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = canonicalPackagePath(value).trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

/** A deterministic, collision-free actual animation name for a clip whose bare name another package took. */
function disambiguatedName(packagePath: string | undefined, name: string, used: ReadonlySet<string>): string {
  const relative = (packagePath ?? "").replace(/^\/Game\//i, "").split("/").filter(Boolean).join("_");
  const stem = relative.length > 0 ? `${relative}_${name}` : `${name}_clip`;
  let candidate = stem;
  let counter = 2;
  while (used.has(candidate.toLowerCase())) candidate = `${stem}_${counter++}`;
  return candidate;
}

/** Adds PSA clips to a compatible glTF skin by case-insensitive joint name, ready for AnimationMixer. */
export function attachPsaAnimations(
  document: Document,
  files: readonly PsaFile[],
  options: number | AttachPsaOptions = {},
): AttachedPsaResult {
  const resolved: AttachPsaOptions = typeof options === "number" ? { minimumBoneCoverage: options } : options;
  const minimumBoneCoverage = resolved.minimumBoneCoverage ?? 0.8;
  const targetSkeleton = canonical(resolved.skeleton);
  const root = document.getRoot();
  const joints = new Map<string, Node>();
  for (const skin of root.listSkins()) {
    for (const joint of skin.listJoints()) joints.set(joint.getName().toLowerCase(), joint);
  }
  // A document that already carries a clip of this name (UE Viewer's own GLB animation) keeps it; the
  // name's package is unknown, so it is recorded as undefined and never disambiguated against. An
  // attached clip records the canonical package it came from, so the same package is recognised.
  const used = new Map<string, string | undefined>();
  for (const animation of root.listAnimations()) used.set(animation.getName().toLowerCase(), undefined);
  // Every clip identity already attached or kept, so two identical PSA files for one disambiguated
  // package never produce a repeated `B_Walk_2`.
  const attachedIdentity = new Map<string, AttachedPsaClip>();
  const buffer = root.listBuffers()[0] ?? document.createBuffer("PSA animations");
  const attached: string[] = [];
  const alreadyPresent: string[] = [];
  const incompatible: string[] = [];
  const unresolved: AttachedPsaUnresolved[] = [];
  const clips: AttachedPsaClip[] = [];

  for (const file of files) {
    for (const sequence of file.sequences) {
      // A clip whose own skeleton provenance names a different package than the target's is not this
      // mesh's clip, even when every bone name matches.
      const sequenceSkeleton = canonical(sequence.skeleton);
      if (targetSkeleton !== undefined && sequenceSkeleton !== undefined && sequenceSkeleton !== targetSkeleton) {
        incompatible.push(sequence.name);
        unresolved.push({ name: sequence.name, ...(sequence.package === undefined ? {} : { package: sequence.package }),
          reason: `the clip's skeleton package ${sequenceSkeleton} differs from the mesh's skeleton package ${targetSkeleton}` });
        continue;
      }
      // A clip that names a canonical skeleton must not fall back to bone-name matching against a mesh
      // whose skeleton package is unknown: that is exactly how a modern clip cross-attaches to an
      // arbitrary same-bone rig. Only the caller's single-candidate (legacy) case permits the fallback.
      if (targetSkeleton === undefined && sequenceSkeleton !== undefined && resolved.allowUnknownSkeleton !== true) {
        unresolved.push({
          name: sequence.name,
          ...(sequence.package === undefined ? {} : { package: sequence.package }),
          reason: "the clip names a skeleton package but the target mesh's skeleton is unknown; refusing to cross-attach by bone name",
        });
        continue;
      }
      const sequencePackage = canonical(sequence.package);
      const identity = sequencePackage === undefined ? undefined : `${sequencePackage}\0${sequence.name.toLowerCase()}`;
      const key = sequence.name.toLowerCase();
      const prior = identity === undefined ? undefined : attachedIdentity.get(identity);
      if (prior !== undefined) {
        // The same package's clip reached this mesh twice; keep the one already attached, not a copy.
        alreadyPresent.push(prior.name);
        clips.push(prior);
        continue;
      }
      if (used.has(key)) {
        const holder = used.get(key);
        if (holder === undefined && (sequencePackage === undefined || file.embeddedGlbSource === true)) {
          // A legacy clip with no package provenance matches UE Viewer's own GLB clip by name: keep it.
          alreadyPresent.push(sequence.name);
          const clip = { name: sequence.name, source: sequence.name, ...(sequence.package === undefined ? {} : { package: sequence.package }), ...(sequence.skeleton === undefined ? {} : { skeleton: sequence.skeleton }), coverage: 1 };
          clips.push(clip);
          if (identity !== undefined) attachedIdentity.set(identity, clip);
          used.set(key, sequencePackage);
          continue;
        }
        if (holder !== undefined && holder === sequencePackage) {
          // This exact package's clip is already present, so it is kept rather than duplicated.
          alreadyPresent.push(sequence.name);
          clips.push({ name: sequence.name, source: sequence.name, ...(sequence.package === undefined ? {} : { package: sequence.package }), ...(sequence.skeleton === undefined ? {} : { skeleton: sequence.skeleton }), coverage: 1 });
          if (identity !== undefined) attachedIdentity.set(identity, clips[clips.length - 1]!);
          continue;
        }
        // The name is taken by an unknown existing clip or another package: do not claim that clip.
        // Fall through and attach this package's clip under a disambiguated actual name.
      }
      const mapped = sequence.tracks.filter((track) => joints.has(track.bone.toLowerCase()));
      const coverage = sequence.tracks.length === 0 ? 0 : mapped.length / sequence.tracks.length;
      if (mapped.length === 0 || coverage < minimumBoneCoverage) {
        incompatible.push(sequence.name);
        continue;
      }
      const actual = used.has(key) ? disambiguatedName(sequence.package, sequence.name, new Set(used.keys())) : sequence.name;
      const animation = document
        .createAnimation(actual)
        .setExtras({ unreal: { sourceFormat: "ActorX PSA", boneCoverage: coverage, ...(sequence.package === undefined ? {} : { sourcePackage: sequence.package }) } });
      for (const track of mapped) {
        const target = joints.get(track.bone.toLowerCase())!;
        const input = document
          .createAccessor(`${actual}/${track.bone}/time`)
          .setType("SCALAR")
          .setArray(track.times)
          .setBuffer(buffer);
        const translation = document
          .createAccessor(`${actual}/${track.bone}/translation`)
          .setType("VEC3")
          .setArray(track.translations)
          .setBuffer(buffer);
        const rotationOutput = document
          .createAccessor(`${actual}/${track.bone}/rotation`)
          .setType("VEC4")
          .setArray(track.rotations)
          .setBuffer(buffer);
        const translationSampler = document
          .createAnimationSampler()
          .setInput(input)
          .setOutput(translation)
          .setInterpolation("LINEAR");
        const rotationSampler = document
          .createAnimationSampler()
          .setInput(input)
          .setOutput(rotationOutput)
          .setInterpolation("LINEAR");
        animation
          .addSampler(translationSampler)
          .addSampler(rotationSampler)
          .addChannel(
            document
              .createAnimationChannel()
              .setSampler(translationSampler)
              .setTargetNode(target)
              .setTargetPath("translation"),
          )
          .addChannel(
            document
              .createAnimationChannel()
              .setSampler(rotationSampler)
              .setTargetNode(target)
              .setTargetPath("rotation"),
          );
      }
      used.set(actual.toLowerCase(), sequencePackage);
      attached.push(actual);
      clips.push({ name: actual, source: sequence.name, ...(sequence.package === undefined ? {} : { package: sequence.package }), ...(sequence.skeleton === undefined ? {} : { skeleton: sequence.skeleton }), coverage });
      if (identity !== undefined) attachedIdentity.set(identity, clips[clips.length - 1]!);
    }
  }
  return { attached, existing: alreadyPresent, incompatible, unresolved, clips };
}
