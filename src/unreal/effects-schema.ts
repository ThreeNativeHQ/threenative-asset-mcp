/**
 * PRD-584: portable descriptors for Unreal Cascade `ParticleSystem` and Niagara
 * `NiagaraSystem`/`NiagaraEmitter`.
 *
 * This module is the one committed definition of the descriptor (AC-5) and the one
 * reference for reading Unreal's baked distribution tables (AC-2). The production
 * converter writes `Effects/<system>-<hash>.cascade.json` and `Effects/<system>-<hash>.niagara.json`
 * through the CUE4Parse adapter; the importer validates them with
 * {@link effectDescriptorSchema}.
 *
 * The table lookup follows `FDistributionLookupTable::GetEntry` and the raw
 * distribution getters in Unreal's `Engine/Source/Runtime/Engine/Private/Distributions.cpp`
 * and `Engine/Source/Runtime/Engine/Public/Distributions.h` (UE 5.8.3, local reference
 * clone). No Epic source or asset is copied here; only the algorithm is reproduced.
 */
import { z } from "zod";

const finite = z.number().finite();
const vector3 = z.tuple([finite, finite, finite]);
/** A value that is a single scalar or an XYZ triple. */
export const effectValueSchema = z.union([finite, vector3]);
export type EffectValue = z.infer<typeof effectValueSchema>;

/** Unreal's `ERichCurveInterpMode` as a portable token. */
export const curveInterpSchema = z.enum(["linear", "constant", "curve", "unknown"]);
export type CurveInterp = z.infer<typeof curveInterpSchema>;

export const curveKeySchema = z.object({
  /** Normalized age in [0, 1]. */
  t: finite,
  v: effectValueSchema,
  arriveTangent: effectValueSchema.optional(),
  leaveTangent: effectValueSchema.optional(),
  interp: curveInterpSchema,
});
export type CurveKey = z.infer<typeof curveKeySchema>;

export const effectCurveSchema = z.object({
  kind: z.literal("curve"),
  keys: z.array(curveKeySchema),
});
export const effectRangeSchema = z.object({
  kind: z.literal("range"),
  min: effectValueSchema,
  max: effectValueSchema,
});
export const effectUniformCurveSchema = z.object({
  kind: z.literal("uniform-curve"),
  minKeys: z.array(curveKeySchema),
  maxKeys: z.array(curveKeySchema),
});
export const effectChannelSchema = z.union([effectCurveSchema, effectRangeSchema, effectUniformCurveSchema]);
export type EffectChannel = z.infer<typeof effectChannelSchema>;

export const effectBurstSchema = z.object({
  /** Seconds after the emitter starts. */
  time: finite,
  count: finite,
  countLow: finite.optional(),
});
export type EffectBurst = z.infer<typeof effectBurstSchema>;

export const effectRendererSchema = z.enum(["sprite", "mesh", "ribbon", "beam", "light"]);

export const effectEmitterSchema = z.object({
  name: z.string(),
  renderer: effectRendererSchema,
  material: z.string().nullable(),
  /** Sprite-sheet grid, when the source names one. */
  subUV: z.object({ columns: finite, rows: finite }).nullable().optional(),
  localSpace: z.boolean(),
  /** Niagara `ENiagaraSimTarget`: `cpu` or `gpu`. A GPU emitter is reproduced as its stored values only. */
  simTarget: z.enum(["cpu", "gpu"]).optional(),
  /** Niagara emitter version GUID, so a runtime can tell which stored version this descriptor came from. */
  version: z.string().optional(),
  /** Source-backed module names the descriptor carries (Niagara only); every other module is a limitation. */
  modules: z.array(z.string()).optional(),
  /**
   * Every decoded `RapidIterationParameters` entry, kept so the raw values are never discarded: the
   * portable name, its byte offset, the width used and whether that width came from the source type
   * or the offset gap, and the little-endian decoded values.
   */
  rapidIteration: z
    .array(
      z.object({
        name: z.string(),
        offset: z.number().int().nonnegative(),
        width: z.number().int().nonnegative(),
        widthSource: z.enum(["type", "offset"]),
        values: z.array(finite),
      }),
    )
    .optional(),
  sort: z.string().optional(),
  duration: finite.optional(),
  loops: finite.optional(),
  delay: finite.optional(),
  spawn: z
    .object({
      rate: effectChannelSchema.nullable(),
      bursts: z.array(effectBurstSchema),
    })
    .optional(),
  init: z
    .object({
      lifetime: effectChannelSchema,
      size: effectChannelSchema,
      velocity: effectChannelSchema,
      color: effectChannelSchema,
      /**
       * Particle/sprite rotation in **radians**. This is the one portable unit; the builders normalize
       * the source units at the boundary. Cascade stores turns (`ParticleModules.cpp:1803`), Niagara
       * stores degrees (`NiagaraSpriteVertexFactory.ush:813`), so both are converted here.
       */
      rotation: effectChannelSchema,
      /** Rotation speed in **radians per second** (`ParticleModules.cpp:1884` converts turns/sec by 2π). */
      rotationRate: effectChannelSchema,
    })
    .partial()
    .optional(),
  overLife: z
    .object({
      color: effectChannelSchema,
      alpha: effectChannelSchema,
      size: effectChannelSchema,
    })
    .partial()
    .optional(),
  forces: z
    .object({
      acceleration: effectChannelSchema,
      drag: effectChannelSchema,
      /** Niagara `SolveForcesAndVelocity` limits, stored as scalars. */
      accelerationLimit: effectChannelSchema,
      speedLimit: effectChannelSchema,
    })
    .partial()
    .optional(),
  /**
   * Named things the descriptor does not carry: unmapped Cascade modules, Niagara
   * data interfaces, GPU emitters and vector fields. Never silently dropped.
   */
  limitations: z.array(z.string()),
});
export type EffectEmitter = z.infer<typeof effectEmitterSchema>;

export const effectBoundsSchema = z.object({
  min: vector3,
  max: vector3,
});
export type EffectBounds = z.infer<typeof effectBoundsSchema>;

export const effectDescriptorSchema = z.object({
  system: z.string(),
  source: z.enum(["cascade", "niagara"]),
  warmup: finite.optional(),
  bounds: effectBoundsSchema.nullable().optional(),
  emitters: z.array(effectEmitterSchema),
});
export type EffectDescriptor = z.infer<typeof effectDescriptorSchema>;

/** Parses a descriptor, throwing the Zod error message so a bad sidecar names its field. */
export function validateEffectDescriptor(value: unknown): EffectDescriptor {
  return effectDescriptorSchema.parse(value);
}

// ---------------------------------------------------------------------------
// Distribution decoding (AC-2).
// ---------------------------------------------------------------------------

/** Unreal `EDistributionLookupTableOp`. */
export const tableOpSchema = z.enum(["none", "extreme", "random"]);
export type TableOp = z.infer<typeof tableOpSchema>;

export const distributionTableSchema = z.object({
  op: tableOpSchema,
  entryCount: z.number().int().nonnegative(),
  entryStride: z.number().int().nonnegative(),
  subEntryStride: z.number().int().nonnegative(),
  timeScale: finite,
  timeBias: finite,
  values: z.array(finite),
});
export type DistributionTable = z.infer<typeof distributionTableSchema>;

export const distributionObjectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("constant"), constant: effectValueSchema }),
  z.object({ kind: z.literal("uniform"), min: effectValueSchema, max: effectValueSchema }),
  z.object({
    kind: z.literal("curve"),
    keys: z.array(curveKeySchema),
    uniform: z.boolean(),
  }),
  /**
   * `Distribution*UniformCurve`: two curves, lane 0 the minimum and lane 1 the maximum
   * at each time (`Distributions.cpp` `GetMinMaxValue`). Collapsing these to one lane
   * loses the random range, so both are carried.
   */
  z.object({
    kind: z.literal("uniform-curve"),
    minKeys: z.array(curveKeySchema),
    maxKeys: z.array(curveKeySchema),
  }),
  /**
   * `Distribution*ParticleParameter` reads a named parameter the descriptor cannot resolve. The
   * serialized `Constant` and the `ParamMode(s)` remap are still carried, so the value Unreal
   * returns with no particle owner is source-backed, never invented.
   */
  z.object({
    kind: z.literal("particle-parameter"),
    parameter: z.string(),
    /** `DistributionFloatParticleParameter` or `...VectorParticleParameter`, which sets the width. */
    paramClass: z.enum(["float", "vector"]).optional(),
    /** The serialized default value the parameter overrides, when the package carries one. */
    constant: effectValueSchema.optional(),
    /** Per-axis `DistributionParamMode` (`Distribution.h:15`); a missing mode is `DPM_Normal`. */
    paramModes: z.array(z.enum(["normal", "abs", "direct"])).optional(),
    /** The remap bounds `Distribution*ParameterBase::GetValue` clamps and scales a non-direct mode to. */
    remap: z
      .object({
        minInput: effectValueSchema,
        maxInput: effectValueSchema,
        minOutput: effectValueSchema,
        maxOutput: effectValueSchema,
      })
      .optional(),
  }),
]);

/** `DistributionParamMode` (`Distribution.h:15`): `false` keeps the enum's numeric order. */
export function distributionParamModeFromRaw(raw: unknown): "normal" | "abs" | "direct" {
  if (typeof raw === "number") return raw === 2 ? "direct" : raw === 1 ? "abs" : "normal";
  const text = String(raw ?? "");
  if (/direct/i.test(text)) return "direct";
  if (/abs/i.test(text)) return "abs";
  return "normal";
}
export type DistributionObject = z.infer<typeof distributionObjectSchema>;

function lerp(a: number, b: number, alpha: number): number {
  return a + (b - a) * alpha;
}

function toVector(value: EffectValue): number[] {
  // A scalar stays one lane; a triple stays three. Lanes are compared lane-for-lane.
  return typeof value === "number" ? [value] : [value[0], value[1], value[2]];
}

/** The number of floats per entry; `EntryStride - SubEntryStride`. */
export function valuesPerEntry(table: DistributionTable): number {
  return table.entryStride - table.subEntryStride;
}

/**
 * A table is usable only when its strides and value count describe its entries. A cooked
 * package can carry a table the reader cannot trust; interpreting one would fabricate
 * zeros, so callers refuse it instead.
 */
export function tableIsValid(table: DistributionTable): boolean {
  if (table.entryCount < 0 || table.entryStride < 0 || table.subEntryStride < 0) return false;
  if (table.entryCount === 0) return true;
  if (table.entryStride < 1 || table.subEntryStride > table.entryStride) return false;
  if (table.values.length < table.entryCount * table.entryStride) return false;
  // A multi-entry table maps normalized time to entry index by multiplying by TimeScale,
  // so a zero or negative scale has no inverse and the table is unusable.
  if (table.entryCount > 1 && !(table.timeScale > 0)) return false;
  return true;
}

/**
 * Port of `FDistributionLookupTable::GetEntry`: returns the two entry floats arrays and
 * the interpolation alpha for a time. Time is biased, scaled and clamped at zero exactly
 * as Unreal does, so a table with `EntryCount` samples interpolates linearly.
 */
export function lookupTableEntry(
  table: DistributionTable,
  time: number,
): { first: number[]; second: number[]; alpha: number } {
  if (!tableIsValid(table) || table.entryCount === 0) {
    return { first: [], second: [], alpha: 0 };
  }
  let local = (time - table.timeBias) * table.timeScale;
  if (local < 0) local = 0;
  const alpha = local - Math.trunc(local);
  const index = Math.trunc(local);
  const stride = table.entryStride;
  const last = table.entryCount - 1;
  const i1 = Math.min(index, last) * stride;
  const i2 = Math.min(index + 1, last) * stride;
  const first = table.values.slice(i1, i1 + stride);
  const second = table.values.slice(i2, i2 + stride);
  return { first, second, alpha };
}

/**
 * The table's value(s) at `time`. For `none` the two lanes collapse; for `extreme` and
 * `random` lane 0 is the minimum and lane 1 the maximum (the two sub-entries). A random
 * draw is never invented: callers compare the two lanes.
 */
export function evaluateTable(
  table: DistributionTable,
  time: number,
): { first: number[]; last: number[] } {
  if (!tableIsValid(table)) return { first: [], last: [] };
  const { first, second, alpha } = lookupTableEntry(table, time);
  const perEntry = valuesPerEntry(table);
  const lane0: number[] = [];
  const lane1: number[] = [];
  for (let channel = 0; channel < perEntry; channel++) {
    const a0 = first[channel]!;
    const b0 = second[channel]!;
    lane0.push(lerp(a0, b0, alpha));
    if (table.subEntryStride > 0) {
      const a1 = first[channel + table.subEntryStride]!;
      const b1 = second[channel + table.subEntryStride]!;
      lane1.push(lerp(a1, b1, alpha));
    }
  }
  return { first: lane0, last: table.subEntryStride > 0 ? lane1 : lane0 };
}

/**
 * The table's own time domain: entry `i` sits at `TimeBias + i / TimeScale`. A single-entry
 * table is a point at `TimeBias`. This is the interval a cross-check must sample, not [0, 1].
 */
export function tableTimeDomain(table: DistributionTable): [number, number] {
  if (!tableIsValid(table) || table.entryCount <= 1) return [table.timeBias, table.timeBias];
  const span = (table.entryCount - 1) / table.timeScale;
  return [table.timeBias, table.timeBias + span];
}

/** Hermite interpolation between two curve points, matching `FMath::CubicInterp`. */
function cubicInterp(p0: number, t0: number, p1: number, t1: number, alpha: number): number {
  const a2 = alpha * alpha;
  const a3 = a2 * alpha;
  return (
    (2 * a3 - 3 * a2 + 1) * p0 +
    (a3 - 2 * a2 + alpha) * t0 +
    (-2 * a3 + 3 * a2) * p1 +
    (a3 - a2) * t1
  );
}

function evalScalarKeys(keys: readonly CurveKey[], time: number): number[] {
  if (keys.length === 0) return [0];
  const sorted = [...keys].sort((a, b) => a.t - b.t);
  const first = sorted[0]!;
  if (time <= first.t) return toVector(first.v);
  const last = sorted[sorted.length - 1]!;
  if (time >= last.t) return toVector(last.v);
  let index = 0;
  while (index < sorted.length - 1 && sorted[index + 1]!.t <= time) index++;
  const prev = sorted[index]!;
  const next = sorted[index + 1]!;
  const span = next.t - prev.t;
  const alpha = span <= 0 ? 0 : (time - prev.t) / span;
  const prevValue = toVector(prev.v);
  const nextValue = toVector(next.v);
  const channels = prevValue.length;
  const result: number[] = [];
  for (let channel = 0; channel < channels; channel++) {
    // A tangent only exists for `curve`; otherwise the mode's own interpolation applies.
    const mode = prev.interp;
    if (mode === "constant") {
      result.push(prevValue[channel] ?? 0);
    } else if (mode === "curve") {
      // `FInterpCurve::Eval` scales each tangent by the segment's duration before the
      // Hermite blend (`PrevPoint.LeaveTangent * Diff`), not the stored slope itself.
      const t0 = (toVector(prev.leaveTangent ?? 0)[channel] ?? 0) * span;
      const t1 = (toVector(next.arriveTangent ?? 0)[channel] ?? 0) * span;
      result.push(cubicInterp(prevValue[channel] ?? 0, t0, nextValue[channel] ?? 0, t1, alpha));
    } else {
      result.push(lerp(prevValue[channel] ?? 0, nextValue[channel] ?? 0, alpha));
    }
  }
  return result;
}

/**
 * The distribution object's value(s) at a time. For a non-uniform distribution both lanes
 * equal the evaluated value; for a uniform one lane 0 is the minimum and lane 1 the
 * maximum at that time. A particle-parameter distribution is unresolved and yields no lane.
 */
export function evaluateDistributionObject(
  distribution: DistributionObject,
  time: number,
): { first: number[]; last: number[] } | undefined {
  switch (distribution.kind) {
    case "constant": {
      const value = toVector(distribution.constant);
      return { first: value, last: value };
    }
    case "curve": {
      const value = evalScalarKeys(distribution.keys, time);
      return { first: value, last: value };
    }
    case "uniform":
      return { first: toVector(distribution.min), last: toVector(distribution.max) };
    case "uniform-curve":
      return {
        first: evalScalarKeys(distribution.minKeys, time),
        last: evalScalarKeys(distribution.maxKeys, time),
      };
    case "particle-parameter":
      return undefined;
  }
}

/**
 * The value `UDistribution*ParameterBase::GetValue` returns with **no particle owner**
 * (`Distributions.cpp:4259` and `:4298`; `ParticleModules.cpp:4618` and `:4631`). With
 * `Data == nullptr` the `Cast<UParticleSystemComponent>` yields null, so `GetParamValue` returns
 * false and Unreal uses the distribution's own serialized `Constant`, then applies `ParamMode(s)`:
 * `DPM_Direct` returns it unchanged, `DPM_Abs` takes the absolute value, and `DPM_Normal` clamps and
 * scales it through `Min/MaxInput -> Min/MaxOutput`. No external parameter value is invented.
 */
export function evaluateDistributionNoOwnerDefault(
  distribution: DistributionObject,
): { first: number[]; last: number[] } | undefined {
  if (distribution.kind !== "particle-parameter") return evaluateDistributionObject(distribution, 0);
  const isVector = distribution.paramClass === "vector" || Array.isArray(distribution.constant);
  const zero: EffectValue = isVector ? [0, 0, 0] : 0;
  const one: EffectValue = isVector ? [1, 1, 1] : 1;
  const base = toVector(distribution.constant ?? zero);
  const modes = distribution.paramModes ?? [];
  const remap = distribution.remap;
  const minInput = toVector(remap?.minInput ?? zero);
  const maxInput = toVector(remap?.maxInput ?? one);
  const minOutput = toVector(remap?.minOutput ?? zero);
  const maxOutput = toVector(remap?.maxOutput ?? one);
  const channels = isVector ? 3 : 1;
  const result: number[] = [];
  for (let channel = 0; channel < channels; channel++) {
    const mode = modes[channel] ?? "normal";
    let value = base[channel] ?? 0;
    if (mode === "direct") {
      result.push(value);
      continue;
    }
    if (mode === "abs") value = Math.abs(value);
    const minIn = minInput[channel] ?? 0;
    const maxIn = maxInput[channel] ?? 1;
    const minOut = minOutput[channel] ?? 0;
    const maxOut = maxOutput[channel] ?? 1;
    const gradient = maxIn <= minIn ? 0 : (maxOut - minOut) / (maxIn - minIn);
    const clamped = Math.min(Math.max(value, minIn), maxIn);
    result.push(minOut + (clamped - minIn) * gradient);
  }
  return { first: result, last: result };
}

/** The largest relative difference between two lanes, so a wrong table is red. */
function laneError(a: number[], b: number[]): number {
  const length = Math.max(a.length, b.length);
  let worst = 0;
  for (let channel = 0; channel < length; channel++) {
    const left = a[channel] ?? 0;
    const right = b[channel] ?? 0;
    const scale = Math.max(1, Math.abs(left), Math.abs(right));
    worst = Math.max(worst, Math.abs(left - right) / scale);
  }
  return worst;
}

/**
 * The interval a dual-form cross-check samples: the object's own key times when it has
 * any, otherwise the baked table's domain. Sampling [0, 1] regardless of the real domain
 * hides a wrong TimeBias or TimeScale.
 */
export function distributionTimeDomain(
  distribution: DistributionObject,
  table: DistributionTable,
): [number, number] {
  const times: number[] = [];
  if (distribution.kind === "curve") for (const key of distribution.keys) times.push(key.t);
  if (distribution.kind === "uniform-curve") {
    for (const key of distribution.minKeys) times.push(key.t);
    for (const key of distribution.maxKeys) times.push(key.t);
  }
  if (times.length === 0) return tableTimeDomain(table);
  const lo = Math.min(...times);
  const hi = Math.max(...times);
  if (lo === hi) return tableTimeDomain(table);
  return [lo, hi];
}

export interface DistributionCrossCheck {
  /** Cross-checked at 16 sample times across the distribution's own domain. */
  readonly samples: number;
  readonly maxRelativeError: number;
  readonly agreesWithinOnePercent: boolean;
  /** Set when the object form cannot be evaluated (a particle parameter). */
  readonly skipped?: string;
}

/**
 * AC-2: evaluate the `Distribution` object and the baked `Table` at 16 sample times across
 * the distribution's own time domain and report the worst relative error. Only the two
 * lanes are compared, so a random distribution's min/max are checked without inventing a
 * random draw. A table the reader cannot trust is refused, never treated as agreeing.
 */
export function crossCheckDistribution(
  distribution: DistributionObject,
  table: DistributionTable,
  samples = 16,
): DistributionCrossCheck {
  if (distribution.kind === "particle-parameter") {
    // The value comes from a parameter the descriptor cannot resolve: not a silent pass.
    return { samples: 0, maxRelativeError: 0, agreesWithinOnePercent: false, skipped: "particle-parameter" };
  }
  if (!tableIsValid(table)) {
    return { samples: 0, maxRelativeError: Number.POSITIVE_INFINITY, agreesWithinOnePercent: false, skipped: "invalid-table" };
  }
  const [lo, hi] = distributionTimeDomain(distribution, table);
  let worst = 0;
  for (let sample = 0; sample < samples; sample++) {
    const alpha = samples === 1 ? 0 : sample / (samples - 1);
    const time = lo === hi ? lo : lo + (hi - lo) * alpha;
    const objectValue = evaluateDistributionObject(distribution, time)!;
    const tableValue = evaluateTable(table, time);
    worst = Math.max(worst, laneError(objectValue.first, tableValue.first));
    worst = Math.max(worst, laneError(objectValue.last, tableValue.last));
  }
  return { samples, maxRelativeError: worst, agreesWithinOnePercent: worst <= 0.01 };
}

/** AC-2 for a `Distribution*ParticleParameter`: its no-owner default, checked against the table. */
export interface ParticleParameterDefaultCheck {
  readonly samples: number;
  /** The source-backed value with no particle owner. */
  readonly defaultValue: readonly number[];
  /** True only when the raw distribution's `Table` was actually baked (`EntryCount > 0`). */
  readonly tableBaked: boolean;
  /** Set when a baked table exists and the default does not match it. */
  readonly maxRelativeError?: number;
  readonly agreesWithinOnePercent?: boolean;
}

/**
 * AC-2 for a parameter-driven distribution: the external parameter remains unresolved, but the
 * value Unreal returns with no particle owner is source-backed ({@link evaluateDistributionNoOwnerDefault})
 * and compared to the table. A parameter distribution is not bakeable
 * (`DistributionFloatParameterBase::CanBeBaked` returns false), so its `Table` is normally empty;
 * that is reported as `tableBaked: false`, never as an agreement.
 */
export function crossCheckParticleParameterDefault(
  distribution: DistributionObject,
  table: DistributionTable,
  samples = 16,
): ParticleParameterDefaultCheck {
  const evaluated = evaluateDistributionNoOwnerDefault(distribution);
  const defaultValue = evaluated?.first ?? [];
  const tableBaked = tableIsValid(table) && table.entryCount > 0;
  if (evaluated === undefined || !tableBaked) {
    return { samples: 0, defaultValue, tableBaked: false };
  }
  const [lo, hi] = distributionTimeDomain(distribution, table);
  let worst = 0;
  for (let sample = 0; sample < samples; sample++) {
    const alpha = samples === 1 ? 0 : sample / (samples - 1);
    const time = lo === hi ? lo : lo + (hi - lo) * alpha;
    const tableValue = evaluateTable(table, time);
    worst = Math.max(worst, laneError(evaluated.first, tableValue.first));
    worst = Math.max(worst, laneError(evaluated.last, tableValue.last));
  }
  return { samples, defaultValue, tableBaked: true, maxRelativeError: worst, agreesWithinOnePercent: worst <= 0.01 };
}

// ---------------------------------------------------------------------------
// Generic CUE4Parse tagged-property dump reader.
//
// The adapter's `--dump-properties` writer emits tagged properties. Effect packages are
// read through the generic path (CUE4Parse has no typed classes for most modules), so the
// builders below take the same `{name, type, value}` tag shape the adapter emits.
// ---------------------------------------------------------------------------

export interface DumpObjectRef {
  readonly Name: string;
  readonly Index: number;
  readonly IsNull: boolean;
}

export interface DumpStructValue {
  readonly kind: "struct";
  readonly structType?: string;
  readonly fields: readonly DumpTag[] | Record<string, unknown>;
}
export interface DumpArrayValue {
  readonly kind: "array";
  readonly inner?: string;
  readonly count?: number;
  readonly elements?: readonly DumpValue[];
}
export interface DumpObjectValue {
  readonly kind: "object";
  readonly value: DumpObjectRef;
}
export interface DumpPrimitiveValue {
  readonly kind: string;
  readonly value?: unknown;
}
export type DumpValue = DumpStructValue | DumpArrayValue | DumpObjectValue | DumpPrimitiveValue;

function asStruct(value: DumpValue | undefined): DumpStructValue | undefined {
  return value !== undefined && value.kind === "struct" ? (value as DumpStructValue) : undefined;
}
function asArray(value: DumpValue | undefined): DumpArrayValue | undefined {
  return value !== undefined && value.kind === "array" ? (value as DumpArrayValue) : undefined;
}
function asObject(value: DumpValue | undefined): DumpObjectValue | undefined {
  return value !== undefined && value.kind === "object" ? (value as DumpObjectValue) : undefined;
}

export interface DumpTag {
  readonly name: string;
  readonly type: string;
  readonly arrayIndex: number;
  readonly arraySize: number | null;
  readonly value: DumpValue;
}

export interface DumpExport {
  readonly index: number;
  readonly class: string;
  readonly name: string;
  readonly properties?: readonly DumpTag[];
}

export interface DumpPackage {
  readonly key?: string;
  readonly package?: string;
  /** Canonical game path the adapter dumped (`DumpGamePath`), e.g. `/Game/A/P_effect`. */
  readonly path?: string;
  readonly exports: readonly DumpExport[];
}

function tagsOf(tag: DumpTag | undefined): DumpTag[] {
  const struct = asStruct(tag?.value);
  if (struct === undefined) return [];
  return Array.isArray(struct.fields) ? [...struct.fields] : [];
}

function findTag(tags: readonly DumpTag[], name: string): DumpTag | undefined {
  return tags.find((tag) => tag.name === name);
}

function scalar(tag: DumpTag | undefined): number | undefined {
  if (tag === undefined) return undefined;
  const raw = (tag.value as { value?: unknown }).value;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function stringValue(tag: DumpTag | undefined): string | undefined {
  const raw = (tag?.value as { value?: unknown })?.value;
  return typeof raw === "string" ? raw : undefined;
}

function objectRef(tag: DumpTag | undefined): DumpObjectRef | undefined {
  const raw = asObject(tag?.value);
  if (raw === undefined || raw.value.IsNull) return undefined;
  return raw.value;
}

function vectorValue(tag: DumpTag | undefined): [number, number, number] | undefined {
  const struct = asStruct(tag?.value);
  if (struct === undefined) return undefined;
  const fields = struct.fields;
  if (Array.isArray(fields)) {
    const x = scalar(findTag(fields, "X"));
    const y = scalar(findTag(fields, "Y"));
    const z = scalar(findTag(fields, "Z"));
    return x !== undefined && y !== undefined && z !== undefined ? [x, y, z] : undefined;
  }
  const record = fields as Record<string, unknown>;
  const x = Number(record.X);
  const y = Number(record.Y);
  const z = Number(record.Z);
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? [x, y, z] : undefined;
}

/** Reads a `FDistributionLookupTable` tag (`Op`, `EntryCount`, `EntryStride`, ...). */
export function readDistributionTable(tag: DumpTag | undefined): DistributionTable | undefined {
  const fields = tagsOf(tag);
  if (fields.length === 0) return undefined;
  const opTag = findTag(fields, "Op");
  const opRaw = scalar(opTag);
  const op: TableOp = opRaw === 1 ? "extreme" : opRaw === 2 ? "random" : "none";
  const valuesTag = findTag(fields, "Values");
  const values: number[] = [];
  const array = asArray(valuesTag?.value);
  if (array?.elements !== undefined) {
    for (const element of array.elements) {
      const raw = (element as { value?: unknown }).value;
      const parsed = typeof raw === "number" ? raw : Number(raw);
      if (Number.isFinite(parsed)) values.push(parsed);
    }
  }
  const table: DistributionTable = {
    op,
    entryCount: scalar(findTag(fields, "EntryCount")) ?? 0,
    entryStride: scalar(findTag(fields, "EntryStride")) ?? 0,
    subEntryStride: scalar(findTag(fields, "SubEntryStride")) ?? 0,
    timeScale: scalar(findTag(fields, "TimeScale")) ?? 0,
    timeBias: scalar(findTag(fields, "TimeBias")) ?? 0,
    values,
  };
  // A stride that cannot describe its entries would fabricate values, so the table is refused.
  return tableIsValid(table) ? table : undefined;
}

/** The `Table` tag nested in a `FRawDistributionFloat/Vector`, for the cross-check. */
export function rawDistributionTableTag(tag: DumpTag | undefined): DumpTag | undefined {
  return findTag(tagsOf(tag), "Table");
}

const INTERP_MAP: Record<string, CurveInterp> = {
  CIM_Linear: "linear",
  CIM_Constant: "constant",
  CIM_CurveAuto: "curve",
  CIM_CurveUser: "curve",
  CIM_CurveBreak: "curve",
  CIM_CurveAutoClamped: "curve",
};

/** A scalar, or an XYZ triple when the value is a vector struct (tagged fields or a record). */
function readEffectValue(tag: DumpTag | undefined): EffectValue | undefined {
  if (tag === undefined) return undefined;
  if (asStruct(tag.value) !== undefined) return vectorValue(tag);
  return scalar(tag);
}

interface CurvePoint {
  readonly t: number;
  readonly out: EffectValue;
  readonly arrive: EffectValue;
  readonly leave: EffectValue;
  readonly interp: CurveInterp;
}

/** The raw points of an `FInterpCurve`, with tangents and vector values kept, not dropped. */
function readCurvePoints(tag: DumpTag | undefined): CurvePoint[] | undefined {
  const points = asArray(findTag(tagsOf(tag), "Points")?.value);
  if (points?.elements === undefined) return undefined;
  const result: CurvePoint[] = [];
  for (const element of points.elements) {
    const struct = asStruct(element);
    if (struct === undefined || !Array.isArray(struct.fields)) continue;
    const pointFields = struct.fields;
    result.push({
      t: scalar(findTag(pointFields, "InVal")) ?? 0,
      out: readEffectValue(findTag(pointFields, "OutVal")) ?? 0,
      arrive: readEffectValue(findTag(pointFields, "ArriveTangent")) ?? 0,
      leave: readEffectValue(findTag(pointFields, "LeaveTangent")) ?? 0,
      interp: INTERP_MAP[stringValue(findTag(pointFields, "InterpMode")) ?? ""] ?? "unknown",
    });
  }
  return result;
}

/** Reads an `FInterpCurve` (`Points[]` with `InVal`/`OutVal`/tangents/`InterpMode`). */
export function readCurveKeys(tag: DumpTag | undefined): CurveKey[] | undefined {
  const points = readCurvePoints(tag);
  if (points === undefined) return undefined;
  return points.map((point) => ({
    t: point.t,
    v: point.out,
    arriveTangent: point.arrive,
    leaveTangent: point.leave,
    interp: point.interp,
  }));
}

function recordValue(fields: unknown, name: string): unknown {
  if (Array.isArray(fields)) return findTag(fields as DumpTag[], name)?.value;
  if (fields !== null && typeof fields === "object") return (fields as Record<string, unknown>)[name];
  return undefined;
}

function numberOf(raw: unknown): number | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw === "string") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** An `FVector2D` (`X`=min, `Y`=max) or an `FTwoVectors` (`v1`=min, `v2`=max) uniform-curve value. */
function uniformLanes(tag: DumpTag | undefined): [EffectValue, EffectValue] | undefined {
  const struct = asStruct(tag?.value);
  if (struct === undefined) return undefined;
  const x = numberOf((recordValue(struct.fields, "X") as { value?: unknown })?.value ?? recordValue(struct.fields, "X"));
  const y = numberOf((recordValue(struct.fields, "Y") as { value?: unknown })?.value ?? recordValue(struct.fields, "Y"));
  const z = recordValue(struct.fields, "Z");
  if (x !== undefined && y !== undefined && z === undefined) return [x, y];
  const v1 = recordValue(struct.fields, "v1") ?? recordValue(struct.fields, "V1");
  const v2 = recordValue(struct.fields, "v2") ?? recordValue(struct.fields, "V2");
  const minVec = vectorFromRecord(v1);
  const maxVec = vectorFromRecord(v2);
  return minVec !== undefined && maxVec !== undefined ? [minVec, maxVec] : undefined;
}

function vectorFromRecord(raw: unknown): [number, number, number] | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (Array.isArray(raw)) {
    const value = vectorValue({ name: "", type: "StructProperty", arrayIndex: 0, arraySize: null, value: { kind: "struct", fields: raw as DumpTag[] } });
    return value;
  }
  if (typeof raw === "object") {
    const tag = raw as { value?: unknown; kind?: string };
    if (typeof tag.kind === "string") {
      const value = asStruct(tag as unknown as DumpValue);
      if (value !== undefined) return vectorValue({ name: "", type: "StructProperty", arrayIndex: 0, arraySize: null, value });
    }
    const record = raw as Record<string, unknown>;
    const x = numberOf(record.X);
    const y = numberOf(record.Y);
    const z = numberOf(record.Z);
    if (x !== undefined && y !== undefined && z !== undefined) return [x, y, z];
  }
  return undefined;
}

/** Reads a `Distribution*UniformCurve`'s `ConstantCurve`, keeping both the min and max lane. */
export function readUniformCurveKeys(
  tag: DumpTag | undefined,
): { minKeys: CurveKey[]; maxKeys: CurveKey[] } | undefined {
  const points = asArray(findTag(tagsOf(tag), "Points")?.value);
  if (points?.elements === undefined) return undefined;
  const minKeys: CurveKey[] = [];
  const maxKeys: CurveKey[] = [];
  for (const element of points.elements) {
    const struct = asStruct(element);
    if (struct === undefined || !Array.isArray(struct.fields)) continue;
    const pointFields = struct.fields;
    const t = scalar(findTag(pointFields, "InVal")) ?? 0;
    const interp = INTERP_MAP[stringValue(findTag(pointFields, "InterpMode")) ?? ""] ?? "unknown";
    const lanes = uniformLanes(findTag(pointFields, "OutVal"));
    if (lanes === undefined) continue;
    const arrive = uniformLanes(findTag(pointFields, "ArriveTangent")) ?? [0, 0];
    const leave = uniformLanes(findTag(pointFields, "LeaveTangent")) ?? [0, 0];
    minKeys.push({ t, v: lanes[0], arriveTangent: arrive[0], leaveTangent: leave[0], interp });
    maxKeys.push({ t, v: lanes[1], arriveTangent: arrive[1], leaveTangent: leave[1], interp });
  }
  return minKeys.length > 0 ? { minKeys, maxKeys } : undefined;
}

/** Reads a `FRawDistributionFloat/Vector`'s instanced `Distribution` object by index. */
export function readDistributionObject(
  tag: DumpTag | undefined,
  byIndex: (index: number) => DumpExport | undefined,
): DistributionObject | undefined {
  const fields = tagsOf(tag);
  if (fields.length === 0) return undefined;
  const ref = objectRef(findTag(fields, "Distribution"));
  if (ref === undefined) return undefined;
  const object = byIndex(ref.Index);
  if (object === undefined) return undefined;
  const props = object.properties ?? [];
  switch (object.class) {
    case "DistributionFloatConstant":
      return { kind: "constant", constant: scalar(findTag(props, "Constant")) ?? 0 };
    case "DistributionVectorConstant": {
      const constant = vectorValue(findTag(props, "Constant"));
      return { kind: "constant", constant: constant ?? [0, 0, 0] };
    }
    case "DistributionFloatUniform":
      return {
        kind: "uniform",
        min: scalar(findTag(props, "Min")) ?? 0,
        max: scalar(findTag(props, "Max")) ?? 0,
      };
    case "DistributionVectorUniform": {
      const min = vectorValue(findTag(props, "Min")) ?? [0, 0, 0];
      const max = vectorValue(findTag(props, "Max")) ?? [0, 0, 0];
      return { kind: "uniform", min, max };
    }
    case "DistributionFloatConstantCurve":
    case "DistributionVectorConstantCurve": {
      const keys = readCurveKeys(findTag(props, "ConstantCurve"));
      return keys === undefined ? undefined : { kind: "curve", keys, uniform: false };
    }
    case "DistributionFloatUniformCurve":
    case "DistributionVectorUniformCurve": {
      const lanes = readUniformCurveKeys(findTag(props, "ConstantCurve"));
      return lanes === undefined ? undefined : { kind: "uniform-curve", ...lanes };
    }
    case "DistributionFloatParticleParameter":
    case "DistributionVectorParticleParameter": {
      // The serialized `Constant` and the `ParamMode(s)` remap are carried so the no-owner value is
      // explicit and source-backed, never fabricated (Distributions.cpp:4259, :4298). Absent fields
      // keep the class defaults: Constant 0 / (0,0,0), ParamMode DPM_Normal, inputs 0..1 outputs 0..1.
      const paramClass = object.class === "DistributionVectorParticleParameter" ? "vector" : "float";
      const constant = readEffectValue(findTag(props, "Constant"));
      const modeNames = paramClass === "vector" ? "ParamModes" : "ParamMode";
      const modeTags = props
        .filter((property) => property.name === modeNames)
        .sort((left, right) => left.arrayIndex - right.arrayIndex);
      const paramModes = modeTags.map((property) =>
        distributionParamModeFromRaw(stringValue(property) ?? scalar(property)),
      );
      const remap = paramClass === "vector"
        ? {
            minInput: vectorValue(findTag(props, "MinInput")) ?? [0, 0, 0],
            maxInput: vectorValue(findTag(props, "MaxInput")) ?? [1, 1, 1],
            minOutput: vectorValue(findTag(props, "MinOutput")) ?? [0, 0, 0],
            maxOutput: vectorValue(findTag(props, "MaxOutput")) ?? [1, 1, 1],
          }
        : {
            minInput: scalar(findTag(props, "MinInput")) ?? 0,
            maxInput: scalar(findTag(props, "MaxInput")) ?? 1,
            minOutput: scalar(findTag(props, "MinOutput")) ?? 0,
            maxOutput: scalar(findTag(props, "MaxOutput")) ?? 1,
          };
      return {
        kind: "particle-parameter",
        parameter: stringValue(findTag(props, "ParameterName")) ?? "",
        paramClass,
        ...(constant !== undefined ? { constant } : {}),
        ...(paramModes.length > 0 ? { paramModes } : {}),
        remap,
      };
    }
    default:
      return undefined;
  }
}

/** The physical time of entry `index`: the inverse of `FDistributionLookupTable::GetEntry`. */
function entryTime(table: DistributionTable, index: number): number {
  if (table.entryCount <= 1) return table.timeBias;
  return table.timeBias + index / table.timeScale;
}

/** A cooked table as a curve (or a two-lane uniform curve), keeping every entry and the time domain. */
function tableChannel(table: DistributionTable): EffectChannel | null {
  if (!tableIsValid(table) || table.entryCount === 0) return null;
  const perEntry = valuesPerEntry(table);
  const sliceValue = (slice: number[]): EffectValue =>
    slice.length === 1 ? slice[0]! : ([slice[0]!, slice[1]!, slice[2]!] as [number, number, number]);
  if (table.subEntryStride > 0) {
    const minKeys: CurveKey[] = [];
    const maxKeys: CurveKey[] = [];
    let constantRange = true;
    const firstMin = sliceValue(table.values.slice(0, perEntry));
    const firstMax = sliceValue(table.values.slice(table.subEntryStride, table.subEntryStride + perEntry));
    for (let entry = 0; entry < table.entryCount; entry++) {
      const base = entry * table.entryStride;
      const min = sliceValue(table.values.slice(base, base + perEntry));
      const max = sliceValue(table.values.slice(base + table.subEntryStride, base + table.subEntryStride + perEntry));
      if (JSON.stringify(min) !== JSON.stringify(firstMin) || JSON.stringify(max) !== JSON.stringify(firstMax)) constantRange = false;
      const t = entryTime(table, entry);
      minKeys.push({ t, v: min, interp: "linear" });
      maxKeys.push({ t, v: max, interp: "linear" });
    }
    // Lanes that never vary are a range; lanes that vary over time are kept as two curves.
    if (constantRange) return { kind: "range", min: firstMin, max: firstMax };
    return { kind: "uniform-curve", minKeys, maxKeys };
  }
  const keys: CurveKey[] = [];
  for (let entry = 0; entry < table.entryCount; entry++) {
    const base = entry * table.entryStride;
    keys.push({ t: entryTime(table, entry), v: sliceValue(table.values.slice(base, base + perEntry)), interp: "linear" });
  }
  return { kind: "curve", keys };
}

/**
 * Turns a raw distribution tag into a portable channel, preferring the distribution
 * object and falling back to the baked table (the cooked case). A particle-parameter
 * distribution is unresolved and returns null, so the caller names it as a limitation.
 */
export function rawDistributionChannel(
  tag: DumpTag | undefined,
  byIndex: (index: number) => DumpExport | undefined,
): EffectChannel | null {
  const object = readDistributionObject(tag, byIndex);
  if (object !== undefined) {
    switch (object.kind) {
      case "constant":
        return { kind: "range", min: object.constant, max: object.constant };
      case "uniform":
        return { kind: "range", min: object.min, max: object.max };
      case "curve":
        return { kind: "curve", keys: object.keys };
      case "uniform-curve":
        return { kind: "uniform-curve", minKeys: object.minKeys, maxKeys: object.maxKeys };
      case "particle-parameter":
        return null;
    }
  }
  const table = readDistributionTable(rawDistributionTableTag(tag));
  return table === undefined ? null : tableChannel(table);
}

// ---------------------------------------------------------------------------
// Cascade mapping (PRD-584 phase 1): tagged dump -> validated portable descriptor.
// ---------------------------------------------------------------------------

function boolValue(tag: DumpTag | undefined): boolean | undefined {
  const raw = (tag?.value as { value?: unknown })?.value;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    const lower = raw.toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;
  }
  return undefined;
}

/** The live object references in an array-of-objects tag, in array order. */
function objectRefs(tags: readonly DumpTag[], name: string): DumpObjectRef[] {
  const array = asArray(findTag(tags, name)?.value);
  if (array?.elements === undefined) return [];
  const refs: DumpObjectRef[] = [];
  for (const element of array.elements) {
    if (element.kind !== "object") continue;
    const ref = (element as DumpObjectValue).value;
    if (ref !== undefined && !ref.IsNull) refs.push(ref);
  }
  return refs;
}

function objectRefOf(tags: readonly DumpTag[], name: string): DumpObjectRef | undefined {
  return objectRef(findTag(tags, name));
}

/** A boolean tag with an Unreal default when the tagged serialization omitted it. */
function boolOrDefault(tag: DumpTag | undefined, fallback: boolean): boolean {
  return boolValue(tag) ?? fallback;
}

/** A scalar float tag with a default when omitted (tagged serialization drops class defaults). */
function floatOrDefault(tag: DumpTag | undefined, fallback: number): number {
  return scalar(tag) ?? fallback;
}

const CASCADE_RENDERERS: Readonly<Record<string, string>> = {
  ParticleModuleTypeDataMesh: "mesh",
  ParticleModuleTypeDataRibbon: "ribbon",
  ParticleModuleTypeDataBeam2: "beam",
  ParticleModuleTypeDataAnimTrail: "ribbon",
  ParticleModuleTypeDataTrail2: "beam",
  ParticleModuleTypeDataSprite: "sprite",
  ParticleModuleTypeDataLight: "light",
};

/** Modules the descriptor maps a type-data renderer for; an unknown type data is never defaulted silently. */
const CASCADE_TYPE_DATA_PREFIX = "ParticleModuleTypeData";

/**
 * Module classes the descriptor carries data from; every other class is listed as a limitation.
 * This set must match the properties `buildCascadeDescriptor` actually reads: a class here with no
 * read would be silently dropped instead of named. `ParticleModuleSizeMultiplyLife` and
 * `ParticleModuleSizeScale` are read into `overLife.size`; a class whose over-life application the
 * schema cannot hold (e.g. `ParticleModuleAccelerationOverLifetime`) stays out and is named.
 */
const CASCADE_MAPPED_MODULES = new Set<string>([
  "ParticleModuleRequired",
  "ParticleModuleSpawn",
  "ParticleModuleLifetime",
  "ParticleModuleSize",
  "ParticleModuleSizeMultiplyLife",
  "ParticleModuleSizeScale",
  "ParticleModuleVelocity",
  "ParticleModuleColor",
  "ParticleModuleColorOverLife",
  "ParticleModuleRotation",
  "ParticleModuleRotationRate",
  "ParticleModuleMeshRotation",
  "ParticleModuleMeshRotationRate",
  "ParticleModuleAcceleration",
  "ParticleModuleDrag",
  "ParticleModuleMeshMaterial",
  "ParticleModuleTypeDataMesh",
  "ParticleModuleTypeDataRibbon",
  "ParticleModuleTypeDataBeam2",
  "ParticleModuleTypeDataAnimTrail",
  "ParticleModuleTypeDataTrail2",
  "ParticleModuleTypeDataSprite",
  "ParticleModuleTypeDataLight",
]);

interface CascadeChannel {
  readonly channel: EffectChannel | null;
  /** The module's channel came from a parameter the descriptor cannot resolve. */
  readonly unresolved: string | undefined;
}

function readChannel(module: DumpExport | undefined, property: string, byIndex: (index: number) => DumpExport | undefined): CascadeChannel {
  const tag = findTag(module?.properties ?? [], property);
  if (tag === undefined) return { channel: null, unresolved: undefined };
  const object = readDistributionObject(tag, byIndex);
  if (object?.kind === "particle-parameter") return { channel: null, unresolved: `${module!.class}.${property} reads parameter "${object.parameter}"` };
  return { channel: rawDistributionChannel(tag, byIndex), unresolved: undefined };
}

function moduleBuckets(lodLevel: DumpExport | undefined, byIndex: (index: number) => DumpExport | undefined): DumpExport[] {
  const modules: DumpExport[] = [];
  const properties = lodLevel?.properties ?? [];
  const push = (ref: DumpObjectRef | undefined): void => {
    const exportObject = ref === undefined ? undefined : byIndex(ref.Index);
    if (exportObject !== undefined) modules.push(exportObject);
  };
  // Evaluation order: Required, Spawn, TypeData, then Modules[] in array order.
  push(objectRefOf(properties, "RequiredModule"));
  push(objectRefOf(properties, "SpawnModule"));
  push(objectRefOf(properties, "TypeDataModule"));
  for (const ref of objectRefs(properties, "Modules")) push(ref);
  return modules;
}

function moduleOf(modules: readonly DumpExport[], ...classes: string[]): DumpExport | undefined {
  return modules.find((module) => classes.includes(module.class));
}

/** Scales a value and every lane by `factor`, so a builder can normalize a source unit to the portable one. */
function scaleEffectValue(value: EffectValue, factor: number): EffectValue {
  return typeof value === "number" ? value * factor : [value[0] * factor, value[1] * factor, value[2] * factor];
}

/**
 * Scales every value and tangent lane of a channel by `factor`. Rotation is the only channel with a
 * source unit that differs from the portable one, so this is the one conversion point: Cascade turns
 * and Niagara degrees both become radians here, and a tangent is scaled with its value.
 */
function scaleChannel(channel: EffectChannel, factor: number): EffectChannel {
  const scaleKeys = (keys: readonly CurveKey[]): CurveKey[] =>
    keys.map((key) => ({
      ...key,
      v: scaleEffectValue(key.v, factor),
      ...(key.arriveTangent !== undefined ? { arriveTangent: scaleEffectValue(key.arriveTangent, factor) } : {}),
      ...(key.leaveTangent !== undefined ? { leaveTangent: scaleEffectValue(key.leaveTangent, factor) } : {}),
    }));
  switch (channel.kind) {
    case "range":
      return { kind: "range", min: scaleEffectValue(channel.min, factor), max: scaleEffectValue(channel.max, factor) };
    case "curve":
      return { kind: "curve", keys: scaleKeys(channel.keys) };
    case "uniform-curve":
      return { kind: "uniform-curve", minKeys: scaleKeys(channel.minKeys), maxKeys: scaleKeys(channel.maxKeys) };
  }
}

/** Cascade stores rotation in turns and rotation rate in turns per second (`ParticleModules.cpp:1803`, `:1884`). */
const CASCADE_TURNS_TO_RADIANS = 2 * Math.PI;
/** Niagara stores sprite rotation in degrees (`NiagaraSpriteVertexFactory.ush:813`). */
const NIAGARA_DEGREES_TO_RADIANS = Math.PI / 180;

/**
 * Maps the tagged export dump of a Cascade package to a portable descriptor. Returns null
 * when the package holds no `ParticleSystem`. Every module the mapper does not carry is
 * named in its emitter's `limitations`, in evaluation order, so nothing is silently dropped.
 */
export function buildCascadeDescriptor(dumpPackage: DumpPackage): EffectDescriptor | null {
  const exports = dumpPackage.exports;
  const system = exports.find((entry) => entry.class === "ParticleSystem");
  if (system === undefined) return null;
  // Unreal object references are 1-based package indices; the dump's `index` is the array
  // position, so a positive ref resolves to the export at `ref.Index - 1`.
  const byIndex = (index: number): DumpExport | undefined => exports.find((entry) => entry.index === index - 1);
  const systemProperties = system.properties ?? [];
  const emitterRefs = objectRefs(systemProperties, "Emitters");
  const emitters: EffectEmitter[] = [];
  for (const ref of emitterRefs) {
    const emitter = byIndex(ref.Index);
    if (emitter === undefined) continue;
    const lodRefs = objectRefs(emitter.properties ?? [], "LODLevels");
    const lodLevel = lodRefs.length > 0 ? byIndex(lodRefs[0]!.Index) : undefined;
    const modules = moduleBuckets(lodLevel, byIndex);
    const required = moduleOf(modules, "ParticleModuleRequired");
    const typeData = modules.find((module) => module.class.startsWith(CASCADE_TYPE_DATA_PREFIX));
    const renderer = (typeData !== undefined ? CASCADE_RENDERERS[typeData.class] : undefined) as EffectEmitter["renderer"] | undefined;
    const requiredProps = required?.properties ?? [];
    const meshMaterial = objectRefs(moduleOf(modules, "ParticleModuleMeshMaterial")?.properties ?? [], "MeshMaterials")[0];
    const material = meshMaterial?.Name ?? objectRefOf(requiredProps, "Material")?.Name ?? null;
    const limitations: string[] = [];
    const unresolvedChannels: string[] = [];

    const spawnModule = moduleOf(modules, "ParticleModuleSpawn");
    const rate = readChannel(spawnModule, "Rate", byIndex);
    if (rate.unresolved !== undefined) unresolvedChannels.push(rate.unresolved);
    const requiredRate = rate.channel === null ? readChannel(required, "SpawnRate", byIndex) : rate;
    if (requiredRate.unresolved !== undefined && !unresolvedChannels.includes(requiredRate.unresolved)) unresolvedChannels.push(requiredRate.unresolved);
    const bursts: EffectBurst[] = [];
    const burstArray = asArray(findTag(spawnModule?.properties ?? [], "BurstList")?.value);
    for (const element of burstArray?.elements ?? []) {
      const fields = asStruct(element)?.fields;
      if (fields === undefined || !Array.isArray(fields)) continue;
      bursts.push({
        time: floatOrDefault(findTag(fields, "Time"), 0),
        count: floatOrDefault(findTag(fields, "Count"), 0),
        ...(findTag(fields, "CountLow") !== undefined ? { countLow: floatOrDefault(findTag(fields, "CountLow"), 0) } : {}),
      });
    }

    const lifetime = readChannel(moduleOf(modules, "ParticleModuleLifetime"), "Lifetime", byIndex);
    // PRD-584 audit: `StartSize` lives only on `ParticleModuleSize`. `ParticleModuleSizeScale.SizeScale`
    // and `ParticleModuleSizeMultiplyLife.LifeMultiplier` are over-life size scales, read into
    // `overLife.size`; reading `StartSize` off them left `init.size` null and the class suppressed.
    const size = readChannel(moduleOf(modules, "ParticleModuleSize"), "StartSize", byIndex);
    const sizeScale = readChannel(moduleOf(modules, "ParticleModuleSizeScale"), "SizeScale", byIndex);
    const lifeMultiplier = readChannel(moduleOf(modules, "ParticleModuleSizeMultiplyLife"), "LifeMultiplier", byIndex);
    const velocity = readChannel(moduleOf(modules, "ParticleModuleVelocity"), "StartVelocity", byIndex);
    const rotation = readChannel(moduleOf(modules, "ParticleModuleRotation", "ParticleModuleMeshRotation"), "StartRotation", byIndex);
    const rotationRate = readChannel(moduleOf(modules, "ParticleModuleRotationRate", "ParticleModuleMeshRotationRate"), "StartRotationRate", byIndex);
    const color = readChannel(moduleOf(modules, "ParticleModuleColor"), "StartColor", byIndex);
    const colorOverLife = readChannel(moduleOf(modules, "ParticleModuleColorOverLife"), "ColorOverLife", byIndex);
    const alphaOverLife = readChannel(moduleOf(modules, "ParticleModuleColorOverLife"), "AlphaOverLife", byIndex);
    // PRD-584: `ParticleModuleAcceleration`/`ParticleModuleDrag` are mapped modules, so their forces
    // are read here; otherwise they would leave `forces` empty and be suppressed from `limitations`.
    const acceleration = readChannel(moduleOf(modules, "ParticleModuleAcceleration"), "Acceleration", byIndex);
    const drag = readChannel(moduleOf(modules, "ParticleModuleDrag"), "Drag", byIndex);
    for (const channel of [lifetime, size, sizeScale, lifeMultiplier, velocity, rotation, rotationRate, color, colorOverLife, alphaOverLife, acceleration, drag]) {
      if (channel.unresolved !== undefined) unresolvedChannels.push(channel.unresolved);
    }

    const init: NonNullable<EffectEmitter["init"]> = {};
    if (lifetime.channel !== null) init.lifetime = lifetime.channel;
    if (size.channel !== null) init.size = size.channel;
    if (velocity.channel !== null) init.velocity = velocity.channel;
    if (color.channel !== null) init.color = color.channel;
    if (rotation.channel !== null) init.rotation = scaleChannel(rotation.channel, CASCADE_TURNS_TO_RADIANS);
    if (rotationRate.channel !== null) init.rotationRate = scaleChannel(rotationRate.channel, CASCADE_TURNS_TO_RADIANS);
    const overLife: NonNullable<EffectEmitter["overLife"]> = {};
    if (colorOverLife.channel !== null) overLife.color = colorOverLife.channel;
    if (alphaOverLife.channel !== null) overLife.alpha = alphaOverLife.channel;
    // `SizeScale` wins when both over-life size modules are present; the other is named below.
    const sizeOverLife = sizeScale.channel !== null ? sizeScale : lifeMultiplier;
    if (sizeOverLife.channel !== null) overLife.size = sizeOverLife.channel;

    const forces: NonNullable<EffectEmitter["forces"]> = {};
    if (acceleration.channel !== null) forces.acceleration = acceleration.channel;
    if (drag.channel !== null) forces.drag = drag.channel;

    // PRD-584: `ParticleModuleRequired` carries the emitter's duration, loops and delay. Absent tags
    // hold the class default (0), which is exported, so the value is never silently lost. When a
    // duration or delay is a range the shared schema cannot express, the high value is carried and
    // the low value is named as an approximation.
    const duration = floatOrDefault(findTag(requiredProps, "EmitterDuration"), 0);
    const durationLow = scalar(findTag(requiredProps, "EmitterDurationLow"));
    const loops = scalar(findTag(requiredProps, "EmitterLoops")) ?? 0;
    const delay = floatOrDefault(findTag(requiredProps, "EmitterDelay"), 0);
    const delayLow = scalar(findTag(requiredProps, "EmitterDelayLow"));

    // A class that is deliberately carried as a bespoke limitation, not the bare default name. The
    // generic loop below names every other unhandled class, so a module can never be mapped and
    // silently dropped.
    const namedByClass = new Map<string, string>();
    if (sizeScale.channel !== null && lifeMultiplier.channel !== null) {
      namedByClass.set("ParticleModuleSizeMultiplyLife", "ParticleModuleSizeMultiplyLife.LifeMultiplier and ParticleModuleSizeScale.SizeScale are both present; the descriptor carries SizeScale");
    }
    if (moduleOf(modules, "ParticleModuleAccelerationOverLifetime") !== undefined) {
      namedByClass.set("ParticleModuleAccelerationOverLifetime", "ParticleModuleAccelerationOverLifetime.AccelerationOverLifetime applies over particle life and is not represented by the descriptor's acceleration field");
    }
    for (const module of modules) {
      if (CASCADE_MAPPED_MODULES.has(module.class)) continue;
      limitations.push(namedByClass.get(module.class) ?? module.class);
    }
    for (const unresolved of unresolvedChannels) limitations.push(unresolved);
    if (boolOrDefault(findTag(requiredProps, "bEmitterDurationUseRange"), false) && durationLow !== undefined && durationLow !== duration) {
      limitations.push(`ParticleModuleRequired.EmitterDurationLow ${durationLow} differs from EmitterDuration ${duration}; the descriptor carries the high value and the range is not represented`);
    }
    if (delayLow !== undefined && delayLow !== delay) {
      limitations.push(`ParticleModuleRequired.EmitterDelayLow ${delayLow} differs from EmitterDelay ${delay}; the descriptor carries the high value and the range is not represented`);
    }
    if (typeData !== undefined && renderer === undefined) {
      limitations.push(`${typeData.class} is not a mapped renderer; the descriptor records the sprite default and does not reproduce it`);
    }

    const descriptor: EffectEmitter = {
      name: emitter.name,
      renderer: renderer ?? "sprite",
      material,
      localSpace: boolOrDefault(findTag(requiredProps, "bUseLocalSpace"), false),
      duration,
      loops,
      delay,
      spawn: { rate: requiredRate.channel, bursts },
      ...(Object.keys(init).length > 0 ? { init } : {}),
      ...(Object.keys(overLife).length > 0 ? { overLife } : {}),
      ...(Object.keys(forces).length > 0 ? { forces } : {}),
      limitations,
    };
    emitters.push(descriptor);
  }
  const bounds = readBounds(systemProperties);
  const warmup = scalar(findTag(systemProperties, "WarmupTime"));
  return validateEffectDescriptor({
    system: system.name,
    source: "cascade",
    ...(warmup !== undefined ? { warmup } : {}),
    ...(bounds !== undefined ? { bounds } : {}),
    emitters,
  });
}

function readBounds(tags: readonly DumpTag[]): EffectBounds | undefined {
  if (!boolOrDefault(findTag(tags, "bUseFixedRelativeBoundingBox"), false)) return undefined;
  const fields = asStruct(findTag(tags, "FixedRelativeBoundingBox")?.value)?.fields;
  if (fields === undefined || !Array.isArray(fields)) return undefined;
  const min = vectorValue(findTag(fields, "Min"));
  const max = vectorValue(findTag(fields, "Max"));
  return min !== undefined && max !== undefined ? { min, max } : undefined;
}

// ---------------------------------------------------------------------------
// Niagara mapping (PRD-584 phase 2): tagged dump -> validated portable descriptor.
//
// The typed path is read from the generic tagged transport: `NiagaraSystem.EmitterHandles[]`
// -> each handle's `VersionedInstance` (`Emitter` object reference + `Version` GUID), then the
// `NiagaraEmitter.VersionData[]` entry whose `Version.VersionGuid` matches (never assuming
// inheritance). Per emitter: `SimTarget`, `bLocalSpace`, `FixedBounds`, `RendererProperties[]`
// and the four script property stores. Each script's `RapidIterationParameters`
// (`SortedParameterOffsets[]` + `ParameterData[]`) is decoded little-endian by the source-backed
// type width, falling back to the offset gap only when the registered type is unknown.
//
// CUE4Parse emits `FStructFallback` values as tagged field arrays and `IUStruct` values (such as
// the reflected `FNiagaraVariableWithOffset` and `FNiagaraTypeDefinition`) as records, so every
// accessor below accepts both shapes.
// ---------------------------------------------------------------------------

/** A struct payload is either a tagged field array (`FStructFallback`) or a reflected record. */
type NiagaraFields = readonly DumpTag[] | Record<string, unknown>;

function fieldsOfValue(value: unknown): NiagaraFields | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "object" && !Array.isArray(value) && "kind" in (value as object)) {
    return asStruct(value as DumpValue)?.fields;
  }
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return undefined;
}

function fieldOf(fields: NiagaraFields | undefined, name: string): unknown {
  if (fields === undefined) return undefined;
  if (Array.isArray(fields)) return findTag(fields, name)?.value;
  return (fields as Record<string, unknown>)[name];
}

function elementsOf(value: unknown): readonly unknown[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "object" && !Array.isArray(value) && "kind" in (value as object)) {
    return asArray(value as DumpValue)?.elements ?? [];
  }
  return Array.isArray(value) ? value : [];
}

function scalarOf(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (value !== null && typeof value === "object" && "value" in (value as object)) {
    return scalarOf((value as { value?: unknown }).value);
  }
  return undefined;
}

function stringOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object" && "value" in (value as object)) {
    const raw = (value as { value?: unknown }).value;
    if (typeof raw === "string") return raw;
  }
  return undefined;
}

function boolOf(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  const text = stringOf(value);
  if (text === undefined) return undefined;
  const lower = text.toLowerCase();
  return lower === "true" ? true : lower === "false" ? false : undefined;
}

function objectRefOfValue(value: unknown): DumpObjectRef | undefined {
  if (value !== null && typeof value === "object" && (value as { kind?: string }).kind === "object") {
    const ref = (value as DumpObjectValue).value;
    return ref !== undefined && !ref.IsNull ? ref : undefined;
  }
  return undefined;
}

function vectorOfValue(value: unknown): [number, number, number] | undefined {
  const fields = fieldsOfValue(value);
  if (fields === undefined) return undefined;
  const x = scalarOf(fieldOf(fields, "X"));
  const y = scalarOf(fieldOf(fields, "Y"));
  const z = scalarOf(fieldOf(fields, "Z"));
  return x !== undefined && y !== undefined && z !== undefined ? [x, y, z] : undefined;
}

/** A GUID as its four 32-bit parts, whether stored directly or nested under `VersionGuid`. */
function guidOf(value: unknown): string | undefined {
  const fields = fieldsOfValue(value);
  if (fields === undefined) return undefined;
  const parts = ["A", "B", "C", "D"].map((part) => scalarOf(fieldOf(fields, part)));
  if (parts.every((part) => part !== undefined)) return parts.join(":");
  return guidOf(fieldOf(fields, "VersionGuid"));
}

const NIAGARA_RENDERERS: Readonly<Record<string, EffectEmitter["renderer"]>> = {
  NiagaraSpriteRendererProperties: "sprite",
  NiagaraMeshRendererProperties: "mesh",
  NiagaraRibbonRendererProperties: "ribbon",
  NiagaraLightRendererProperties: "light",
  NiagaraComponentRendererProperties: "mesh",
  NiagaraDecalRendererProperties: "sprite",
};

/** Known modules the descriptor carries. Every other stored module is named as a limitation. */
const NIAGARA_MAPPED_MODULES = new Set<string>([
  "SpawnRate",
  "SpawnBurstInstantaneous",
  "InitializeParticle",
  "ColorFromCurve",
  "ScaleSpriteSize",
  "SolveForcesAndVelocity",
  "GravityForce",
  "DragForce",
  // The stored emitter module is named `Drag`; `DragForce` is its PRD alias. Both are source-backed.
  "Drag",
]);

/**
 * Niagara inputs stored as signed 32-bit integers, so they are not misread as floats (e.g. `Spawn Count`).
 */
const NIAGARA_INT_INPUTS = new Set<string>(["Spawn Count"]);

export interface NiagaraRapidIterationEntry {
  readonly name: string;
  readonly offset: number;
  readonly width: number;
  readonly widthSource: "type" | "offset";
  readonly values: readonly number[];
}

/**
 * The source-backed width of a well-known Niagara input, in bytes. The serialized
 * `UnderlyingType` names only the base type (float), so a composite's width comes from the
 * input's registered type in engine source: a Vector is 12, a Vector2D/Quat 8/16, a LinearColor 16.
 */
function niagaraTypeWidth(leaf: string): number | undefined {
  const table: Readonly<Record<string, number>> = {
    Gravity: 12,
    Position: 12,
    "Position Offset": 12,
    "Rotational Force": 12,
    "Rotational Velocity": 12,
    "Color Minimum": 16,
    "Color Maximum": 16,
    "Initial Sprite Size": 8,
    "Initial Velocity": 12,
    "Mesh Orientation": 16,
    "Scale RGB": 12,
    "Scale RGBA": 16,
    Drag: 4,
    "Rotational Drag": 4,
    "Lifetime Min": 4,
    "Lifetime Max": 4,
    "Mass Min": 4,
    "Mass Max": 4,
    "Uniform Sprite Size Min": 4,
    "Uniform Sprite Size Max": 4,
    "Sprite Rotation Angle Min": 4,
    "Sprite Rotation Angle Max": 4,
    "Acceleration Limit": 4,
    "Speed Limit": 4,
    "Uniform Curve Index": 4,
  };
  return table[leaf];
}

function decodeFloats(bytes: readonly number[], offset: number, width: number): number[] {
  const count = Math.floor(width / 4);
  const values: number[] = [];
  if (count > 0) {
    for (let index = 0; index < count; index++) {
      const base = offset + index * 4;
      const raw = (bytes[base] ?? 0) | ((bytes[base + 1] ?? 0) << 8) | ((bytes[base + 2] ?? 0) << 16) | ((bytes[base + 3] ?? 0) << 24);
      const view = new DataView(new ArrayBuffer(4));
      view.setInt32(0, raw | 0, true);
      const decoded = view.getFloat32(0, true);
      values.push(Number.isFinite(decoded) ? decoded : 0);
    }
  } else if (width > 0) {
    values.push(bytes[offset] ?? 0);
  }
  return values;
}

/** The same bytes read as little-endian signed 32-bit integers, for an int-typed Niagara input. */
function decodeSignedInts(bytes: readonly number[], offset: number, width: number): number[] {
  const count = Math.max(1, Math.floor(width / 4));
  const values: number[] = [];
  for (let index = 0; index < count; index++) {
    const base = offset + index * 4;
    const raw = (bytes[base] ?? 0) | ((bytes[base + 1] ?? 0) << 8) | ((bytes[base + 2] ?? 0) << 16) | ((bytes[base + 3] ?? 0) << 24);
    values.push(raw | 0);
  }
  return values;
}

/** Decodes one script's `FNiagaraParameterStore` into portable entries, refusing out-of-bounds data. */
function readRapidIteration(script: DumpExport): NiagaraRapidIterationEntry[] {
  const store = findTag(script.properties ?? [], "RapidIterationParameters");
  const storeFields = fieldsOfValue(store?.value);
  if (storeFields === undefined) return [];
  const bytes: number[] = [];
  for (const element of elementsOf(fieldOf(storeFields, "ParameterData"))) {
    const value = scalarOf(element);
    if (value !== undefined) bytes.push(value & 0xff);
  }
  const raw: { name: string; offset: number }[] = [];
  for (const element of elementsOf(fieldOf(storeFields, "SortedParameterOffsets"))) {
    const fields = fieldsOfValue(element);
    if (fields === undefined) continue;
    const name = stringOf(fieldOf(fields, "Name"));
    const offset = scalarOf(fieldOf(fields, "Offset"));
    if (name === undefined || offset === undefined) continue;
    raw.push({ name, offset });
  }
  // The store is a byte buffer addressed by offset; sorting makes the gap the next entry's width.
  raw.sort((left, right) => left.offset - right.offset);
  const entries: NiagaraRapidIterationEntry[] = [];
  for (let index = 0; index < raw.length; index++) {
    const current = raw[index]!;
    const nextOffset = index + 1 < raw.length ? raw[index + 1]!.offset : bytes.length;
    const gap = nextOffset - current.offset;
    if (gap < 0) continue;
    const leaf = current.name.split(".").pop() ?? current.name;
    const typeWidth = niagaraTypeWidth(leaf);
    // A source-backed width wins; the offset gap must be a whole multiple of it. Otherwise the
    // gap is the only evidence and the entry is marked as offset-derived, never presented as typed.
    const useType = typeWidth !== undefined && gap >= typeWidth && gap % typeWidth === 0;
    const width = useType ? typeWidth! : gap;
    if (width < 0 || current.offset + width > bytes.length) continue;
    entries.push({
      name: current.name,
      offset: current.offset,
      width,
      widthSource: useType ? "type" : "offset",
      values: NIAGARA_INT_INPUTS.has(leaf) ? decodeSignedInts(bytes, current.offset, width) : decodeFloats(bytes, current.offset, width),
    });
  }
  return entries;
}

function readNiagaraBounds(value: unknown): EffectBounds | undefined {
  const fields = fieldsOfValue(value);
  if (fields === undefined) return undefined;
  if (boolOf(fieldOf(fields, "IsValid")) === false) return undefined;
  const min = vectorOfValue(fieldOf(fields, "Min"));
  const max = vectorOfValue(fieldOf(fields, "Max"));
  return min !== undefined && max !== undefined ? { min, max } : undefined;
}

function readNiagaraSubUV(renderer: DumpExport): EffectEmitter["subUV"] | undefined {
  const fields = fieldsOfValue(findTag(renderer.properties ?? [], "SubImageSize")?.value);
  if (fields === undefined) return undefined;
  const columns = scalarOf(fieldOf(fields, "X"));
  const rows = scalarOf(fieldOf(fields, "Y"));
  return columns !== undefined && rows !== undefined ? { columns, rows } : undefined;
}

function readNiagaraChannel(entry: NiagaraRapidIterationEntry, components: 1 | 3): EffectValue {
  if (components === 1) return entry.values[0] ?? 0;
  return [entry.values[0] ?? 0, entry.values[1] ?? 0, entry.values[2] ?? 0];
}

interface NiagaraHandle {
  readonly emitter: DumpExport;
  readonly versionGuid: string | undefined;
}

function mapNiagaraEmitter(handle: NiagaraHandle, byIndex: (index: number) => DumpExport | undefined, dataInterfaces: readonly string[]): EffectEmitter {
  const emitter = handle.emitter;
  const emitterProperties = emitter.properties ?? [];
  const uniqueName = stringOf(findTag(emitterProperties, "UniqueEmitterName")?.value) ?? emitter.name;
  const versionData = elementsOf(findTag(emitterProperties, "VersionData")?.value);
  let dataFields: NiagaraFields | undefined;
  for (const element of versionData) {
    const fields = fieldsOfValue(element);
    if (fields === undefined) continue;
    if (handle.versionGuid !== undefined && guidOf(fieldOf(fields, "Version")) === handle.versionGuid) {
      dataFields = fields;
      break;
    }
  }
  if (dataFields === undefined && versionData.length > 0) dataFields = fieldsOfValue(versionData[versionData.length - 1]!);

  const simRaw = stringOf(fieldOf(dataFields, "SimTarget")) ?? "";
  const simTarget: EffectEmitter["simTarget"] = simRaw.toLowerCase().includes("gpu") ? "gpu" : "cpu";
  const localSpace = boolOf(fieldOf(dataFields, "bLocalSpace")) ?? false;
  const bounds = readNiagaraBounds(fieldOf(dataFields, "FixedBounds"));
  const version = guidOf(fieldOf(dataFields, "Version")) ?? handle.versionGuid;

  const rendererExports: DumpExport[] = [];
  for (const element of elementsOf(fieldOf(dataFields, "RendererProperties"))) {
    const renderer = byIndex(objectRefOfValue(element)?.Index ?? 0);
    if (renderer !== undefined) rendererExports.push(renderer);
  }
  const primary = rendererExports[0];
  const renderer = primary !== undefined ? NIAGARA_RENDERERS[primary.class] ?? "sprite" : "sprite";
  const material = primary !== undefined ? objectRefOfValue(findTag(primary.properties ?? [], "Material")?.value)?.Name ?? null : null;
  const subUV = primary !== undefined ? readNiagaraSubUV(primary) : undefined;

  const scripts: DumpExport[] = [];
  for (const property of ["SpawnScriptProps", "UpdateScriptProps", "EmitterSpawnScriptProps", "EmitterUpdateScriptProps"]) {
    const scriptRef = objectRefOfValue(fieldOf(fieldsOfValue(fieldOf(dataFields, property)), "Script"));
    const script = scriptRef === undefined ? undefined : byIndex(scriptRef.Index);
    if (script !== undefined) scripts.push(script);
  }
  const entries = new Map<string, NiagaraRapidIterationEntry>();
  const rapidIteration: NiagaraRapidIterationEntry[] = [];
  for (const script of scripts) {
    for (const entry of readRapidIteration(script)) {
      if (!entries.has(entry.name)) {
        entries.set(entry.name, entry);
        rapidIteration.push(entry);
      }
    }
  }

  const prefix = `Constants.${uniqueName}.`;
  const modules = new Set<string>();
  // PRD-584 audit: an input counts as consumed only once a portable field actually carries it.
  // Marking at the lookup would hide a half-present pair (for example a stored `Lifetime Min`
  // with no `Lifetime Max`), because the paired assignment never runs. The unused-input scan
  // below then names what a stored value must not silently lose.
  const consumed = new Set<string>();
  const lookup = (module: string, input: string): NiagaraRapidIterationEntry | undefined =>
    entries.get(`${prefix}${module}.${input}`);
  const consume = (...used: readonly (NiagaraRapidIterationEntry | undefined)[]): void => {
    for (const entry of used) {
      if (entry !== undefined) consumed.add(entry.name);
    }
  };
  for (const entry of rapidIteration) {
    if (!entry.name.startsWith(prefix)) continue;
    const rest = entry.name.slice(prefix.length);
    const dot = rest.indexOf(".");
    if (dot > 0) modules.add(rest.slice(0, dot));
  }

  const init: NonNullable<EffectEmitter["init"]> = {};
  const lifetimeMin = lookup("InitializeParticle", "Lifetime Min");
  const lifetimeMax = lookup("InitializeParticle", "Lifetime Max");
  if (lifetimeMin !== undefined && lifetimeMax !== undefined) {
    init.lifetime = { kind: "range", min: readNiagaraChannel(lifetimeMin, 1), max: readNiagaraChannel(lifetimeMax, 1) };
    consume(lifetimeMin, lifetimeMax);
  }
  const sizeMin = lookup("InitializeParticle", "Uniform Sprite Size Min");
  const sizeMax = lookup("InitializeParticle", "Uniform Sprite Size Max");
  if (sizeMin !== undefined && sizeMax !== undefined) {
    init.size = { kind: "range", min: readNiagaraChannel(sizeMin, 1), max: readNiagaraChannel(sizeMax, 1) };
    consume(sizeMin, sizeMax);
  }
  const rotationMin = lookup("InitializeParticle", "Sprite Rotation Angle Min");
  const rotationMax = lookup("InitializeParticle", "Sprite Rotation Angle Max");
  if (rotationMin !== undefined && rotationMax !== undefined) {
    init.rotation = {
      kind: "range",
      min: scaleEffectValue(readNiagaraChannel(rotationMin, 1), NIAGARA_DEGREES_TO_RADIANS),
      max: scaleEffectValue(readNiagaraChannel(rotationMax, 1), NIAGARA_DEGREES_TO_RADIANS),
    };
    consume(rotationMin, rotationMax);
  }
  const colorMin = lookup("InitializeParticle", "Color Minimum");
  const colorMax = lookup("InitializeParticle", "Color Maximum");
  if (colorMin !== undefined && colorMax !== undefined) {
    init.color = { kind: "range", min: readNiagaraChannel(colorMin, 3), max: readNiagaraChannel(colorMax, 3) };
    consume(colorMin, colorMax);
  }
  // PRD-584 fix: a stored `InitializeParticle.Initial Velocity` is the particle start velocity.
  const initialVelocity = lookup("InitializeParticle", "Initial Velocity");
  if (initialVelocity !== undefined) {
    const value = readNiagaraChannel(initialVelocity, 3);
    init.velocity = { kind: "range", min: value, max: value };
    consume(initialVelocity);
  }

  const forces: NonNullable<EffectEmitter["forces"]> = {};
  const gravity = lookup("GravityForce", "Gravity");
  if (gravity !== undefined) {
    const value = readNiagaraChannel(gravity, 3);
    forces.acceleration = { kind: "range", min: value, max: value };
    consume(gravity);
  }
  const drag = lookup("Drag", "Drag") ?? lookup("DragForce", "Drag");
  if (drag !== undefined) {
    const value = readNiagaraChannel(drag, 1);
    forces.drag = { kind: "range", min: value, max: value };
    consume(drag);
  }
  // PRD-584: `SolveForcesAndVelocity` limits are stored scalars, exported so the module is not mapped silently.
  const accelerationLimit = lookup("SolveForcesAndVelocity", "Acceleration Limit");
  if (accelerationLimit !== undefined) {
    const value = readNiagaraChannel(accelerationLimit, 1);
    forces.accelerationLimit = { kind: "range", min: value, max: value };
    consume(accelerationLimit);
  }
  const speedLimit = lookup("SolveForcesAndVelocity", "Speed Limit");
  if (speedLimit !== undefined) {
    const value = readNiagaraChannel(speedLimit, 1);
    forces.speedLimit = { kind: "range", min: value, max: value };
    consume(speedLimit);
  }
  // `SpawnBurstInstantaneous` stores its count and time as inputs; read them so bursts are not dropped.
  const burstCount = lookup("SpawnBurstInstantaneous", "Spawn Count");
  const burstTime = lookup("SpawnBurstInstantaneous", "Spawn Time");
  const bursts: EffectBurst[] = [];
  if (burstCount !== undefined) {
    bursts.push({ time: burstTime !== undefined ? (burstTime.values[0] ?? 0) : 0, count: burstCount.values[0] ?? 0 });
    consume(burstCount, burstTime);
  }
  // PRD-584 fix: the stored `SpawnRate.Spawn Rate` override must reach `spawn.rate`; it was hardcoded null.
  const spawnRate = lookup("SpawnRate", "Spawn Rate") ?? lookup("SpawnRate", "Rate");
  const rate: EffectChannel | null = spawnRate === undefined
    ? null
    : { kind: "range", min: readNiagaraChannel(spawnRate, 1), max: readNiagaraChannel(spawnRate, 1) };
  consume(spawnRate);

  const limitations: string[] = [];
  for (const module of modules) {
    if (!NIAGARA_MAPPED_MODULES.has(module)) limitations.push(`Niagara module "${module}" is not exported`);
  }
  // An absent stored override means the value is wired or default: state it, never write a zero.
  if (spawnRate === undefined) {
    limitations.push("SpawnRate has no stored override; the spawn rate is wired or default and is unresolved (default unavailable)");
  }
  if (modules.has("SpawnBurstInstantaneous")) {
    if (burstCount === undefined) {
      limitations.push('SpawnBurstInstantaneous is present but "Spawn Count" has no stored override; bursts are not exported (default unavailable)');
    }
  } else {
    limitations.push("SpawnBurstInstantaneous is not present; bursts are not exported (default unavailable)");
  }
  // Every stored input of a mapped module the mapper did not consume is named, so a stored value can
  // never disappear silently. Unmapped modules are already named as whole modules above.
  for (const entry of rapidIteration) {
    if (!entry.name.startsWith(prefix)) continue;
    const rest = entry.name.slice(prefix.length);
    const dot = rest.indexOf(".");
    if (dot <= 0) continue;
    const module = rest.slice(0, dot);
    if (!NIAGARA_MAPPED_MODULES.has(module) || consumed.has(entry.name)) continue;
    limitations.push(`Niagara module "${module}" is stored but its input "${rest.slice(dot + 1)}" is not exported`);
  }
  const hasColorFromCurve = modules.has("ColorFromCurve");
  if (!hasColorFromCurve && modules.has("FloatFromCurve")) {
    limitations.push('ColorFromCurve is absent; the source-backed alias "FloatFromCurve" -> "ScaleColor" is carried only in the raw rapid-iteration values');
  }
  if (simTarget === "gpu") limitations.push("GPU simulation is not reproduced; only the stored values are exported");
  for (const dataInterface of dataInterfaces) limitations.push(`Niagara data interface ${dataInterface} is not exported`);

  const descriptor: EffectEmitter = {
    name: handle.emitter.name,
    renderer,
    material,
    ...(subUV !== undefined ? { subUV } : {}),
    localSpace,
    simTarget,
    ...(version !== undefined ? { version } : {}),
    ...(bounds !== undefined ? { bounds } : {}),
    spawn: { rate, bursts },
    ...(Object.keys(init).length > 0 ? { init } : {}),
    ...(Object.keys(forces).length > 0 ? { forces } : {}),
    ...(modules.size > 0 ? { modules: [...modules].sort() } : {}),
    rapidIteration: rapidIteration.map((entry) => ({
      name: entry.name,
      offset: entry.offset,
      width: entry.width,
      widthSource: entry.widthSource,
      values: [...entry.values],
    })),
    limitations,
  };
  return descriptor;
}

/**
 * Maps the tagged export dump of a Niagara package (`NiagaraSystem`, or a standalone
 * `NiagaraEmitter`) to a portable descriptor. Returns null when the package holds neither.
 * Every module the mapper does not carry, every data interface, and every absent stored override
 * is named in the emitter's `limitations`; the raw rapid-iteration values are preserved.
 */
export function buildNiagaraDescriptor(dumpPackage: DumpPackage): EffectDescriptor | null {
  const exports = dumpPackage.exports;
  const system = exports.find((entry) => entry.class === "NiagaraSystem");
  const standalone = exports.find((entry) => entry.class === "NiagaraEmitter");
  if (system === undefined && standalone === undefined) return null;
  const byIndex = (index: number): DumpExport | undefined => exports.find((entry) => entry.index === index - 1);

  const handles: NiagaraHandle[] = [];
  if (system !== undefined) {
    for (const element of elementsOf(findTag(system.properties ?? [], "EmitterHandles")?.value)) {
      const fields = fieldsOfValue(element);
      const versioned = fieldsOfValue(fieldOf(fields, "VersionedInstance"));
      const emitter = byIndex(objectRefOfValue(fieldOf(versioned, "Emitter"))?.Index ?? 0);
      if (emitter === undefined) continue;
      handles.push({ emitter, versionGuid: guidOf(fieldOf(versioned, "Version")) });
    }
  } else if (standalone !== undefined) {
    handles.push({ emitter: standalone, versionGuid: undefined });
  }

  const dataInterfaces = [...new Set(exports.filter((entry) => entry.class.startsWith("NiagaraDataInterface")).map((entry) => entry.class))].sort();
  const emitters = handles.map((handle) => mapNiagaraEmitter(handle, byIndex, dataInterfaces));
  const bounds = system !== undefined ? readNiagaraBounds(fieldOf(system.properties ?? [], "FixedBounds")) : undefined;
  return validateEffectDescriptor({
    system: system?.name ?? standalone!.name,
    source: "niagara",
    ...(bounds !== undefined ? { bounds } : {}),
    emitters,
  });
}
