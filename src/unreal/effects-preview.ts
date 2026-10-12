/**
 * PRD-584 AC-7: a minimal, sprite-only preview of a portable effect descriptor.
 *
 * Three.js has no particle runtime, so this module does not simulate anything. It bakes a
 * deterministic approximation: for a descriptor it places sprite-card quads from the stored
 * lifetime/size/velocity/color/alpha/rotation/acceleration/drag values at four documented
 * sample times, and writes one GLB per time. An `overLife.size` channel multiplies the card's
 * `init.size` at the particle's age, so its scale is visible across samples. The production tile
 * renderer (`renderTiles`) and
 * `judgeRender` consume these GLBs later; this module only generates them, in pure Node.
 *
 * Approximation rules (never a claim about Unreal's simulation):
 * - Exactly {@link EFFECT_PREVIEW_SAMPLE_TIMES} normalized ages are sampled, so before/after
 *   sheets share one camera and picture contract. All four GLBs carry one identical invisible
 *   anchor box, so auto-framing is the same for every sample. The anchor is fully transparent,
 *   so it never enters the judge's object mask.
 * - Ranges are sampled deterministically from the particle index (no global random), and a
 *   curve respects its `linear`/`constant`/`curve` tangents.
 * - A missing stored spawn rate yields one annotated exemplar particle, never an invented rate.
 *   A present rate is shown up to {@link EFFECT_PREVIEW_PARTICLE_CAP} particles (a documented
 *   shortcut, not an Unreal count).
 * - `mesh`/`ribbon`/`beam`/`light` renderers are drawn as sprite proxies and labelled as such.
 * - A material with no caller-supplied texture is a labelled neutral card; no texture is faked.
 *
 * Units: the descriptor stores Unreal centimetres. This module converts positions and sizes to
 * metres (`UNREAL_CM_TO_M`) for the renderer. Rotation is the descriptor's portable radians (the
 * builders convert Cascade turns and Niagara degrees), so it feeds `sin(rotation/2)` directly.
 */
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Document, NodeIO, VertexLayout } from "@gltf-transform/core";
import { KHRMaterialsUnlit } from "@gltf-transform/extensions";

import type { CurveKey, EffectChannel, EffectDescriptor, EffectEmitter, EffectValue } from "./effects-schema.js";

/** The four normalized particle ages every preview samples. Documented so a sheet is reproducible. */
export const EFFECT_PREVIEW_SAMPLE_TIMES = Object.freeze([0, 0.25, 0.5, 1] as const);
/** The fixed sprite-card cap per emitter. A documented shortcut, not Unreal's simulated count. */
export const EFFECT_PREVIEW_PARTICLE_CAP = 24;
/** Unreal stores centimetres; the renderer works in metres. */
export const UNREAL_CM_TO_M = 0.01;
/** Card edge in metres when a descriptor carries no size. */
const DEFAULT_CARD_SIZE_M = 0.1;
/** The anchor box's minimum half-extent in metres, so a degenerate effect still has a stable frame. */
const MIN_ANCHOR_HALF_M = 0.5;
/** Fully transparent anchor colour; blend makes it invisible, never part of the judge mask. */
const ANCHOR_COLOR: readonly [number, number, number, number] = [0, 0, 0, 0];
/** A neutral grey card for a material the caller cannot resolve. Never a fabricated texture. */
const NEUTRAL_CARD_COLOR: readonly [number, number, number, number] = [0.5, 0.5, 0.5, 1];

/**
 * The picture inputs a sample was drawn with. `neutral` is the flat light the committed metrics
 * use; the contract revision and camera must match the production renderer for a before/after
 * pair (`contact-sheet.ts`). Kept local so this generator does not import the renderer and
 * create a cycle; a test asserts it equals the renderer's constants.
 */
export interface EffectPreviewIdentity {
  readonly kind: "neutral";
  readonly lighting: "neutral";
  readonly contract: number;
  readonly camera: {
    readonly fov: number;
    readonly direction: readonly [number, number, number];
    readonly fit: number;
  };
}

export interface EffectPreviewSample {
  /** Normalized particle age in [0, 1]. */
  readonly time: number;
  /** Written GLB path, absolute or relative to the caller's cwd. */
  readonly path: string;
}

export interface EffectPreviewResult {
  readonly system: string;
  readonly samples: readonly EffectPreviewSample[];
  readonly times: readonly number[];
  readonly limitations: readonly string[];
  readonly identity: EffectPreviewIdentity;
}

export interface EffectPreviewOptions {
  readonly system: string;
  readonly descriptor: EffectDescriptor;
  readonly outputDir: string;
  /**
   * Canonical material path (`Emitter.material`) to an existing exported PNG. A material absent
   * from the map is drawn as a labelled neutral card, never given a fabricated texture.
   */
  readonly materialTextures?: ReadonlyMap<string, string>;
  /** Override the four documented sample times. */
  readonly times?: readonly number[];
}

const IDENTITY: EffectPreviewIdentity = Object.freeze({
  kind: "neutral",
  lighting: "neutral",
  contract: 1,
  camera: Object.freeze({ fov: 40, direction: Object.freeze([1, 0.75, 1.2]) as readonly [number, number, number], fit: 1.05 }),
});

// ---------------------------------------------------------------------------
// Channel sampling.
// ---------------------------------------------------------------------------

function lanes(value: EffectValue): number[] {
  return typeof value === "number" ? [value] : [value[0], value[1], value[2]];
}
function laneCount(a: number[], b: number[]): number {
  return Math.max(a.length, b.length);
}
function mix(a: number[], b: number[], u: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < laneCount(a, b); i++) out.push((a[i] ?? 0) + ((b[i] ?? 0) - (a[i] ?? 0)) * u);
  return out;
}
function hermite(p0: number, t0: number, p1: number, t1: number, a: number): number {
  const a2 = a * a;
  const a3 = a2 * a;
  return (2 * a3 - 3 * a2 + 1) * p0 + (a3 - 2 * a2 + a) * t0 + (-2 * a3 + 3 * a2) * p1 + (a3 - a2) * t1;
}
/** Evaluates an `FInterpCurve`'s keys at `t`, honouring constant/linear/cubic (`curve`) modes. */
function evalKeys(keys: readonly CurveKey[], t: number): number[] {
  if (keys.length === 0) return [0];
  const sorted = [...keys].sort((a, b) => a.t - b.t);
  const first = sorted[0]!;
  if (t <= first.t) return lanes(first.v);
  const last = sorted[sorted.length - 1]!;
  if (t >= last.t) return lanes(last.v);
  let index = 0;
  while (index < sorted.length - 1 && sorted[index + 1]!.t <= t) index++;
  const prev = sorted[index]!;
  const next = sorted[index + 1]!;
  const span = next.t - prev.t;
  const alpha = span <= 0 ? 0 : (t - prev.t) / span;
  const pv = lanes(prev.v);
  const nv = lanes(next.v);
  const out: number[] = [];
  for (let channel = 0; channel < Math.max(pv.length, nv.length); channel++) {
    if (prev.interp === "constant") out.push(pv[channel] ?? 0);
    else if (prev.interp === "curve") {
      const t0 = (lanes(prev.leaveTangent ?? 0)[channel] ?? 0) * span;
      const t1 = (lanes(next.arriveTangent ?? 0)[channel] ?? 0) * span;
      out.push(hermite(pv[channel] ?? 0, t0, nv[channel] ?? 0, t1, alpha));
    } else out.push((pv[channel] ?? 0) + ((nv[channel] ?? 0) - (pv[channel] ?? 0)) * alpha);
  }
  return out;
}
/** Samples a portable channel at normalized age `t`, using `u` in [0,1] to pick within a range. */
export function sampleEffectChannel(channel: EffectChannel, t: number, u: number): number[] {
  switch (channel.kind) {
    case "range":
      return mix(lanes(channel.min), lanes(channel.max), u);
    case "curve":
      return evalKeys(channel.keys, t);
    case "uniform-curve":
      return mix(evalKeys(channel.minKeys, t), evalKeys(channel.maxKeys, t), u);
  }
}
/** The scalar sample of a channel (first lane). */
function scalarAt(channel: EffectChannel | undefined, t: number, u: number, fallback: number): number {
  return channel === undefined ? fallback : (sampleEffectChannel(channel, t, u)[0] ?? fallback);
}
/** The XYZ sample of a channel, replicating a scalar across lanes when needed. */
function vectorAt(channel: EffectChannel | undefined, t: number, u: number): [number, number, number] {
  if (channel === undefined) return [0, 0, 0];
  const value = sampleEffectChannel(channel, t, u);
  return [value[0] ?? 0, value[1] ?? value[0] ?? 0, value[2] ?? value[0] ?? 0];
}

/** The golden-ratio low-discrepancy fraction of a particle index: deterministic, no global random. */
const GOLDEN = 0.6180339887498949;
function unitFraction(index: number): number {
  return ((index + 1) * GOLDEN) % 1;
}

// ---------------------------------------------------------------------------
// Particle placement (a descriptor approximation, not a simulation).
// ---------------------------------------------------------------------------

interface PreviewParticle {
  readonly position: readonly [number, number, number];
  readonly sizeM: number;
  /** Rotation in radians, the descriptor's portable unit. */
  readonly rotation: number;
  readonly color: readonly [number, number, number, number];
  /** The source emitter's material path, carried with the particle so its texture never depends on a flat index. */
  readonly material: string | null;
}

/** Whether the descriptor stores any spawn evidence (a rate or a burst); otherwise one exemplar is shown. */
function hasSpawnEvidence(emitter: EffectEmitter): boolean {
  return emitter.spawn?.rate != null || (emitter.spawn?.bursts.length ?? 0) > 0;
}

/** True when any lane of a channel can hold a vector, i.e. a per-axis value the uniform card collapses. */
function channelHasVectorLanes(channel: EffectChannel | undefined): boolean {
  if (channel === undefined) return false;
  const isVector = (value: EffectValue): boolean => typeof value !== "number";
  switch (channel.kind) {
    case "range":
      return isVector(channel.min) || isVector(channel.max);
    case "curve":
      return channel.keys.some((key) => isVector(key.v));
    case "uniform-curve":
      return channel.minKeys.some((key) => isVector(key.v)) || channel.maxKeys.some((key) => isVector(key.v));
  }
}

function emitParticles(emitter: EffectEmitter, time: number): PreviewParticle[] {
  const init = emitter.init ?? {};
  const overLife = emitter.overLife ?? {};
  const forces = emitter.forces ?? {};
  const count = hasSpawnEvidence(emitter) ? EFFECT_PREVIEW_PARTICLE_CAP : 1;
  const particles: PreviewParticle[] = [];
  for (let index = 0; index < count; index++) {
    // Index 0 is the youngest; the oldest is at the sampled wall time. With no stored rate there
    // is exactly one exemplar at the wall time, so no spawn rate is invented.
    const age = count > 1 ? (time * (index + 1)) / count : time;
    const u = unitFraction(index);
    const lifeSeconds = Math.max(0, scalarAt(init.lifetime, age, unitFraction(index + 7), 1));
    const ageSeconds = age * lifeSeconds;
    const velocity = vectorAt(init.velocity, age, u);
    const acceleration = vectorAt(forces.acceleration, age, unitFraction(index + 3));
    const drag = Math.max(0, scalarAt(forces.drag, age, unitFraction(index + 5), 0));
    const decay = ageSeconds > 0 && drag > 0 ? (1 - Math.exp(-drag * ageSeconds)) / (drag * ageSeconds) : 1;
    const displacement: number[] = [];
    for (let axis = 0; axis < 3; axis++) {
      const v = (velocity[axis] ?? 0) * ageSeconds * decay + 0.5 * (acceleration[axis] ?? 0) * ageSeconds * ageSeconds;
      displacement.push(v * UNREAL_CM_TO_M);
    }
    const sizeCm = scalarAt(init.size, age, unitFraction(index + 11), DEFAULT_CARD_SIZE_M / UNREAL_CM_TO_M)
      * scalarAt(overLife.size, age, unitFraction(index + 31), 1);
    const sizeM = Math.max(0, sizeCm * UNREAL_CM_TO_M);
    const rotationRate = scalarAt(init.rotationRate, age, unitFraction(index + 13), 0);
    const rotation = scalarAt(init.rotation, age, unitFraction(index + 17), 0) + rotationRate * ageSeconds;
    const base = vectorAt(init.color, age, unitFraction(index + 19));
    const tint = vectorAt(overLife.color, age, unitFraction(index + 23));
    const alpha = Math.min(1, Math.max(0, scalarAt(overLife.alpha, age, unitFraction(index + 29), 1)));
    particles.push({
      position: [displacement[0] ?? 0, displacement[1] ?? 0, displacement[2] ?? 0],
      sizeM,
      rotation,
      color: [
        Math.min(1, Math.max(0, (base[0] ?? 1) * (tint[0] ?? 1))),
        Math.min(1, Math.max(0, (base[1] ?? 1) * (tint[1] ?? 1))),
        Math.min(1, Math.max(0, (base[2] ?? 1) * (tint[2] ?? 1))),
        alpha,
      ],
      material: emitter.material,
    });
  }
  return particles;
}

// ---------------------------------------------------------------------------
// GLB writing.
// ---------------------------------------------------------------------------

/** The union box of every particle across every sample, expanded to a stable minimum size. */
function anchorBounds(samples: readonly PreviewParticle[][]): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const particles of samples) {
    for (const particle of particles) {
      const half = Math.max(particle.sizeM / 2, 0);
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis]!, particle.position[axis]! - half);
        max[axis] = Math.max(max[axis]!, particle.position[axis]! + half);
      }
    }
  }
  for (let axis = 0; axis < 3; axis++) {
    if (!Number.isFinite(min[axis]!) || !Number.isFinite(max[axis]!)) {
      min[axis] = -MIN_ANCHOR_HALF_M;
      max[axis] = MIN_ANCHOR_HALF_M;
      continue;
    }
    const center = (min[axis]! + max[axis]!) / 2;
    const half = Math.max(MIN_ANCHOR_HALF_M, (max[axis]! - min[axis]!) / 2);
    min[axis] = center - half;
    max[axis] = center + half;
  }
  return { min, max };
}

/** The particles every sample places, in source emitter order, so two generators share one framing. */
function particleSamples(descriptor: EffectDescriptor, times: readonly number[]): PreviewParticle[][] {
  const samples: PreviewParticle[][] = times.map(() => []);
  for (const emitter of descriptor.emitters) {
    times.forEach((time, sample) => samples[sample]!.push(...emitParticles(emitter, time)));
  }
  return samples;
}

function quadAccessors(document: Document, buffer: ReturnType<Document["createBuffer"]>) {
  return {
    position: document.createAccessor().setType("VEC3").setArray(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0])).setBuffer(buffer),
    normal: document.createAccessor().setType("VEC3").setArray(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1])).setBuffer(buffer),
    uv: document.createAccessor().setType("VEC2").setArray(new Float32Array([0, 1, 1, 1, 1, 0, 0, 0])).setBuffer(buffer),
    indices: document.createAccessor().setType("SCALAR").setArray(new Uint16Array([0, 1, 2, 0, 2, 3])).setBuffer(buffer),
  };
}

function cubeAccessors(document: Document, buffer: ReturnType<Document["createBuffer"]>, box: { min: [number, number, number]; max: [number, number, number] }) {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let bit = 0; bit < 8; bit++) {
    positions.push(bit & 1 ? box.max[0] : box.min[0], bit & 2 ? box.max[1] : box.min[1], bit & 4 ? box.max[2] : box.min[2]);
  }
  const faces = [
    [0, 2, 3, 0, 3, 1], [4, 5, 7, 4, 7, 6], [0, 1, 5, 0, 5, 4],
    [2, 6, 7, 2, 7, 3], [0, 4, 6, 0, 6, 2], [1, 3, 7, 1, 7, 5],
  ];
  for (const face of faces) indices.push(...face);
  return {
    position: document.createAccessor().setType("VEC3").setArray(new Float32Array(positions)).setBuffer(buffer),
    indices: document.createAccessor().setType("SCALAR").setArray(new Uint16Array(indices)).setBuffer(buffer),
  };
}

async function buildSampleGlb(options: {
  path: string;
  particles: readonly PreviewParticle[];
  box: { min: [number, number, number]; max: [number, number, number] };
  textures: ReadonlyMap<string, { png: Uint8Array; name: string }>;
}): Promise<void> {
  const document = new Document();
  const buffer = document.createBuffer();
  const quad = quadAccessors(document, buffer);
  const unlit = KHRMaterialsUnlit;

  const materialCache = new Map<string, ReturnType<Document["createMaterial"]>>();
  const meshCache = new Map<unknown, ReturnType<Document["createMesh"]>>();
  const materialFor = (factor: readonly [number, number, number, number], textureKey: string | null): ReturnType<Document["createMaterial"]> => {
    const key = `${factor.map((v) => v.toFixed(4)).join(",")}|${textureKey ?? ""}`;
    const cached = materialCache.get(key);
    if (cached !== undefined) return cached;
    const material = document.createMaterial("sprite").setBaseColorFactor([...factor]).setAlphaMode("BLEND").setDoubleSided(true).setMetallicFactor(0).setRoughnessFactor(1);
    material.setExtension("KHR_materials_unlit", document.createExtension(unlit).createUnlit());
    const texture = textureKey === null ? undefined : options.textures.get(textureKey);
    if (texture !== undefined) material.setBaseColorTexture(document.createTexture(texture.name).setImage(texture.png).setMimeType("image/png"));
    materialCache.set(key, material);
    return material;
  };
  const meshFor = (material: ReturnType<Document["createMaterial"]>): ReturnType<Document["createMesh"]> => {
    const cached = meshCache.get(material);
    if (cached !== undefined) return cached;
    const primitive = document.createPrimitive()
      .setAttribute("POSITION", quad.position)
      .setAttribute("NORMAL", quad.normal)
      .setAttribute("TEXCOORD_0", quad.uv)
      .setIndices(quad.indices)
      .setMaterial(material);
    const mesh = document.createMesh("cards").addPrimitive(primitive);
    meshCache.set(material, mesh);
    return mesh;
  };

  const scene = document.createScene("preview");
  const anchor = cubeAccessors(document, buffer, options.box);
  const anchorMaterial = document.createMaterial("anchor").setBaseColorFactor([...ANCHOR_COLOR]).setAlphaMode("BLEND").setDoubleSided(true).setMetallicFactor(0).setRoughnessFactor(1);
  anchorMaterial.setExtension("KHR_materials_unlit", document.createExtension(unlit).createUnlit());
  const anchorPrimitive = document.createPrimitive()
    .setAttribute("POSITION", anchor.position)
    .setIndices(anchor.indices)
    .setMaterial(anchorMaterial);
  scene.addChild(document.createNode("anchor").setMesh(document.createMesh("anchor").addPrimitive(anchorPrimitive)));

  options.particles.forEach((particle) => {
    // The material travels on the particle, so its texture never depends on a flat index shared across emitters.
    const textureKey = particle.material;
    const resolved = textureKey !== null && options.textures.has(textureKey) ? textureKey : null;
    // The neutral card keeps the particle's alpha, so an unresolved material still fades; only its colour is neutral.
    const factor: readonly [number, number, number, number] = resolved === null
      ? [NEUTRAL_CARD_COLOR[0], NEUTRAL_CARD_COLOR[1], NEUTRAL_CARD_COLOR[2], particle.color[3]]
      : particle.color;
    const material = materialFor(factor, resolved);
    const node = document.createNode("particle").setMesh(meshFor(material)).setTranslation([...particle.position]);
    const half = particle.rotation / 2;
    node.setRotation([0, 0, Math.sin(half), Math.cos(half)]);
    node.setScale([particle.sizeM, particle.sizeM, particle.sizeM]);
    scene.addChild(node);
  });

  await new NodeIO().registerExtensions([unlit]).setVertexLayout(VertexLayout.SEPARATE).write(options.path, document);
}

/**
 * Writes the four documented sprite-card samples of `options.descriptor` under `options.outputDir`.
 * Returns the sample paths, times, every limitation and the picture identity, so a local proof
 * script can feed the GLBs to `renderTiles`/`judgeRender` unchanged.
 */
export async function writeEffectPreviewGlbs(options: EffectPreviewOptions): Promise<EffectPreviewResult> {
  const times = options.times ?? EFFECT_PREVIEW_SAMPLE_TIMES;
  await mkdir(options.outputDir, { recursive: true });
  const limitations: string[] = [
    "descriptor preview: sprite cards approximate the stored values, not Unreal's simulation",
    "rotation is applied about the card's Z axis only; a per-axis (Euler) mesh rotation is not reproduced",
  ];

  const textures = new Map<string, { png: Uint8Array; name: string }>();
  const samples = particleSamples(options.descriptor, times);
  for (const emitter of options.descriptor.emitters) {
    const material = emitter.material;
    if (material !== null) {
      const mapped = options.materialTextures?.get(material);
      if (mapped === undefined) limitations.push(`material ${material} is unresolved; a neutral card is shown`);
      else textures.set(material, { png: new Uint8Array(await readFile(mapped)), name: material });
    }
    if (emitter.renderer !== "sprite") limitations.push(`renderer ${emitter.renderer} is shown as a labelled sprite proxy, not Unreal's simulation`);
    if (channelHasVectorLanes(emitter.init?.size) || channelHasVectorLanes(emitter.overLife?.size)) {
      limitations.push(`size for ${emitter.name} carries per-axis lanes; the preview draws a uniform square card using the first lane`);
    }
    if (!hasSpawnEvidence(emitter)) {
      limitations.push(`spawn rate is not stored for ${emitter.name}; one exemplar particle only (no invented spawn rate)`);
    } else {
      limitations.push(`fixed preview cap of ${EFFECT_PREVIEW_PARTICLE_CAP} particles for ${emitter.name}; a shortcut, not Unreal's count`);
    }
  }
  const box = anchorBounds(samples);

  const written: EffectPreviewSample[] = [];
  for (let sample = 0; sample < times.length; sample++) {
    const path = join(options.outputDir, `${options.system}.t${sample}.glb`);
    await buildSampleGlb({ path, particles: samples[sample]!, box, textures });
    written.push({ time: times[sample]!, path });
  }
  return { system: options.descriptor.system, samples: written, times: [...times], limitations: unique(limitations), identity: IDENTITY };
}

/**
 * Writes the blank "before" GLB of a before/after pair for an effect the base importer produced no
 * GLB for. It carries the SAME invisible framing anchor as {@link writeEffectPreviewGlbs} computes for
 * `options.descriptor`, so both sides of the pair share one camera and bounding box, and it adds no
 * particle: every mesh is the fully transparent anchor, so the judge mask stays empty. This is a
 * framing placeholder, not a generated effect: the descriptor's base `import-report.json` skipping the
 * class is the proof. The label says so.
 */
export async function writeBlankEffectPreviewGlb(options: {
  system: string;
  outputDir: string;
  /** The descriptor the "after" preview uses; its particle bounds frame this blank identically. */
  descriptor: EffectDescriptor;
  times?: readonly number[];
}): Promise<{ path: string; limitation: string; identity: EffectPreviewIdentity }> {
  const times = options.times ?? EFFECT_PREVIEW_SAMPLE_TIMES;
  await mkdir(options.outputDir, { recursive: true });
  const box = anchorBounds(particleSamples(options.descriptor, times));
  const path = join(options.outputDir, `${options.system}.blank.glb`);
  await buildSampleGlb({ path, particles: [], box, textures: new Map() });
  return {
    path,
    limitation: `no exported descriptor for ${options.system}: the base importer produced no effect GLB (import-report.json is the proof); this blank reuses the descriptor preview's framing anchor and adds no particles`,
    identity: IDENTITY,
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
