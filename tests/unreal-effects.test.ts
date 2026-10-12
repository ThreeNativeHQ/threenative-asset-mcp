import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import { importUnrealDirectory } from "../src/unreal/importer.js";
import { effectDescriptorRelativePath, writeUnrealEffects, type EffectsDump } from "../src/unreal/effects-dump.js";
import { writeFakeUmodel } from "./helpers/unreal-fixture.js";
import {
  buildCascadeDescriptor,
  buildNiagaraDescriptor,
  crossCheckDistribution,
  crossCheckParticleParameterDefault,
  distributionTimeDomain,
  effectDescriptorSchema,
  evaluateDistributionNoOwnerDefault,
  evaluateDistributionObject,
  evaluateTable,
  rawDistributionChannel,
  rawDistributionTableTag,
  readCurveKeys,
  readDistributionObject,
  readDistributionTable,
  tableIsValid,
  validateEffectDescriptor,
  type DistributionObject,
  type DistributionTable,
  type DumpExport,
  type DumpPackage,
  type DumpTag,
} from "../src/unreal/effects-schema.js";

/**
 * Synthetic tagged objects in the exact shape the CUE4Parse adapter emits for one cooked
 * UE4.18 Cascade package: a sprite emitter with required, spawn and a small module list.
 * No pack bytes or licensed names; every system, material and module name is generic.
 */

function scalarTag(name: string, kind: string, value: number | string | boolean): DumpTag {
  return { name, type: kind, arrayIndex: 0, arraySize: null, value: { kind, value: String(value) } };
}

function structTag(name: string, fields: readonly DumpTag[]): DumpTag {
  return {
    name,
    type: "StructProperty",
    arrayIndex: 0,
    arraySize: null,
    value: { kind: "struct", structType: "CUE4Parse.UE4.Assets.Objects.FStructFallback", fields },
  };
}

function objectTag(name: string, ref: string, index: number): DumpTag {
  return {
    name,
    type: "ObjectProperty",
    arrayIndex: 0,
    arraySize: null,
    value: { kind: "object", value: { Name: ref, Index: index, IsNull: false } },
  };
}

function floatArrayTag(name: string, values: readonly number[]): DumpTag {
  return {
    name,
    type: "ArrayProperty",
    arrayIndex: 0,
    arraySize: null,
    value: {
      kind: "array",
      inner: "FloatProperty",
      count: values.length,
      elements: values.map((value) => ({ kind: "FloatProperty", value: String(value) })),
    },
  };
}

function structArrayTag(name: string, elements: readonly (readonly DumpTag[])[]): DumpTag {
  return {
    name,
    type: "ArrayProperty",
    arrayIndex: 0,
    arraySize: null,
    value: {
      kind: "array",
      inner: "StructProperty",
      count: elements.length,
      elements: elements.map((fields) => ({ kind: "struct", structType: "FStructFallback", fields })),
    },
  };
}

function objectArrayTag(name: string, refs: readonly { name: string; index: number }[]): DumpTag {
  return {
    name,
    type: "ArrayProperty",
    arrayIndex: 0,
    arraySize: null,
    value: {
      kind: "array",
      inner: "ObjectProperty",
      count: refs.length,
      elements: refs.map((ref) => ({ kind: "object", value: { Name: ref.name, Index: ref.index, IsNull: false } })),
    },
  };
}

function objectStructTag(name: string, x: number, y: number, z: number): DumpTag {
  return structTag(name, [
    scalarTag("X", "FloatProperty", x),
    scalarTag("Y", "FloatProperty", y),
    scalarTag("Z", "FloatProperty", z),
  ]);
}

/** `ParticleModuleLifetime.Lifetime`: a `FRawDistributionFloat` for a uniform 3..5 range. */
const LIFETIME: DumpTag = structTag("Lifetime", [
  scalarTag("MinValue", "FloatProperty", 3),
  scalarTag("MaxValue", "FloatProperty", 5),
  objectTag("Distribution", "DistributionLifetime", 9),
  structTag("Table", [
    scalarTag("Op", "ByteProperty", 2),
    scalarTag("EntryCount", "ByteProperty", 1),
    scalarTag("EntryStride", "ByteProperty", 2),
    scalarTag("SubEntryStride", "ByteProperty", 1),
    floatArrayTag("Values", [3, 5]),
  ]),
]);

const EXPORTS: readonly DumpExport[] = [
  {
    index: 9,
    class: "DistributionFloatUniform",
    name: "DistributionLifetime",
    properties: [scalarTag("Min", "FloatProperty", 3), scalarTag("Max", "FloatProperty", 5)],
  },
];

const byIndex = (index: number): DumpExport | undefined => EXPORTS.find((e) => e.index === index);

function tableOf(over: Partial<DistributionTable>): DistributionTable {
  return {
    op: "none",
    entryCount: 1,
    entryStride: 1,
    subEntryStride: 0,
    timeScale: 1,
    timeBias: 0,
    values: [0],
    ...over,
  };
}

describe("effect descriptor schema (AC-5)", () => {
  it("accepts a cascade descriptor", () => {
    const descriptor = validateEffectDescriptor({
      system: "P_effect",
      source: "cascade",
      bounds: { min: [-10, -100, -100], max: [550, 100, 120] },
      emitters: [
        {
          name: "ParticleSpriteEmitter_0",
          renderer: "sprite",
          material: "M_effect",
          localSpace: true,
          spawn: { rate: { kind: "range", min: 8, max: 8 }, bursts: [{ time: 0, count: 2 }] },
          init: { lifetime: { kind: "range", min: 3, max: 5 }, size: { kind: "range", min: 10, max: 18 } },
          limitations: ["ParticleModuleMeshRotation"],
        },
      ],
    });
    expect(descriptor.source).toBe("cascade");
    expect(descriptor.emitters[0]?.init?.lifetime).toEqual({ kind: "range", min: 3, max: 5 });
  });

  it("rejects a descriptor with an unknown source", () => {
    const result = effectDescriptorSchema.safeParse({
      system: "X",
      source: "niagara-gpu",
      emitters: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("distribution decoding (AC-2)", () => {
  it("reads the baked table exactly", () => {
    const table = readDistributionTable(rawDistributionTableTag(LIFETIME));
    expect(table).toEqual({
      op: "random",
      entryCount: 1,
      entryStride: 2,
      subEntryStride: 1,
      timeScale: 0,
      timeBias: 0,
      values: [3, 5],
    });
  });

  it("reads the instanced distribution object", () => {
    const object = readDistributionObject(LIFETIME, byIndex);
    expect(object).toEqual({ kind: "uniform", min: 3, max: 5 });
  });

  it("agrees with the baked table at 16 sample times", () => {
    const table = readDistributionTable(rawDistributionTableTag(LIFETIME))!;
    const object: DistributionObject = { kind: "uniform", min: 3, max: 5 };
    const check = crossCheckDistribution(object, table);
    expect(check.samples).toBe(16);
    expect(check.agreesWithinOnePercent).toBe(true);
    expect(check.maxRelativeError).toBeLessThanOrEqual(0.01);
  });

  it("is red when the baked table's two lanes are wrong (formula, not strings)", () => {
    // A table whose stride collapses the two sub-entries into one lane: the object's max
    // (5) then disagrees with the table's max lane (3) by 40%.
    const broken = { ...readDistributionTable(rawDistributionTableTag(LIFETIME))! };
    broken.entryStride = 1;
    broken.subEntryStride = 0;
    const object: DistributionObject = { kind: "uniform", min: 3, max: 5 };
    const check = crossCheckDistribution(object, broken);
    expect(check.agreesWithinOnePercent).toBe(false);
    expect(check.maxRelativeError).toBeGreaterThan(0.01);
  });

  it("keeps a random distribution's min and max as the two lanes", () => {
    const table = readDistributionTable(rawDistributionTableTag(LIFETIME))!;
    const at = evaluateTable(table, 0);
    expect(at.first).toEqual([3]);
    expect(at.last).toEqual([5]);
  });

  it("returns a portable range channel from the raw distribution", () => {
    expect(rawDistributionChannel(LIFETIME, byIndex)).toEqual({ kind: "range", min: 3, max: 5 });
  });
});

describe("distribution proofs (AC-2): a wrong formula must be red", () => {
  /** A scalar constant curve whose points the table resamples: entry `i` at physical time `i/scale + bias`. */
  function curveChannel(scale: number, bias: number, entries: readonly number[]): DumpTag {
    return structTag("Lifetime", [
      objectTag("Distribution", "DistributionCurve", 9),
      structTag("Table", [
        scalarTag("Op", "ByteProperty", 0),
        scalarTag("EntryCount", "ByteProperty", entries.length),
        scalarTag("EntryStride", "ByteProperty", 1),
        scalarTag("SubEntryStride", "ByteProperty", 0),
        scalarTag("TimeScale", "FloatProperty", scale),
        scalarTag("TimeBias", "FloatProperty", bias),
        floatArrayTag("Values", entries),
      ]),
    ]);
  }

  const curveExport = (points: readonly { t: number; v: number }[]): readonly DumpExport[] => [
    {
      index: 9,
      class: "DistributionFloatConstantCurve",
      name: "DistributionCurve",
      properties: [
        structTag("ConstantCurve", [
          structArrayTag(
            "Points",
            points.map((point) => [
              scalarTag("InVal", "FloatProperty", point.t),
              scalarTag("OutVal", "FloatProperty", point.v),
              scalarTag("ArriveTangent", "FloatProperty", 0),
              scalarTag("LeaveTangent", "FloatProperty", 0),
              scalarTag("InterpMode", "ByteProperty", "CIM_Linear"),
            ]),
          ),
        ]),
      ],
    },
  ];

  function pair(tag: DumpTag, points: readonly { t: number; v: number }[]): { object: DistributionObject; table: DistributionTable } {
    const exports = curveExport(points);
    return {
      object: readDistributionObject(tag, (i) => exports.find((e) => e.index === i))!,
      table: readDistributionTable(rawDistributionTableTag(tag))!,
    };
  }

  it("samples the table's own non-unit time domain, not [0, 1]", () => {
    // Entries 0,10,20 sit at times 0,0.5,1 (TimeScale 2): a [0,1] sample would only touch half the table.
    const points = [
      { t: 0, v: 0 },
      { t: 0.5, v: 10 },
      { t: 1, v: 20 },
    ];
    const { object, table } = pair(curveChannel(2, 0, [0, 10, 20]), points);
    expect(distributionTimeDomain(object, table)).toEqual([0, 1]);
    expect(crossCheckDistribution(object, table).agreesWithinOnePercent).toBe(true);
  });

  it("honours a nonzero TimeBias, so both forms agree only when it is applied", () => {
    const points = [
      { t: 5, v: 0 },
      { t: 5.5, v: 10 },
      { t: 6, v: 20 },
    ];
    const { object, table } = pair(curveChannel(2, 5, [0, 10, 20]), points);
    // A zero-bias reader would map time 5 to entry 0..2 of a [5,6] object and disagree.
    expect(distributionTimeDomain(object, table)).toEqual([5, 6]);
    expect(crossCheckDistribution(object, table).agreesWithinOnePercent).toBe(true);
  });

  it("checks table interpolation between entries, not just the nearest sample", () => {
    const table = tableOf({ entryCount: 3, entryStride: 1, subEntryStride: 0, timeScale: 1, timeBias: 0, values: [0, 10, 20] });
    const object: DistributionObject = { kind: "curve", keys: [{ t: 0, v: 0, interp: "linear" }, { t: 1, v: 10, interp: "linear" }, { t: 2, v: 20, interp: "linear" }], uniform: false };
    expect(evaluateTable(table, 0.5).first).toEqual([5]);
    expect(crossCheckDistribution(object, table).maxRelativeError).toBeLessThanOrEqual(0.01);
    // A table read without interpolation would return entry 0 (0) at t=0.5 and fail.
    const nearestOnly = tableOf({ entryCount: 3, entryStride: 1, subEntryStride: 0, timeScale: 1, timeBias: 0, values: [0, 0, 20] });
    expect(crossCheckDistribution(object, nearestOnly).agreesWithinOnePercent).toBe(false);
  });

  it("keeps a varying random table as a two-lane curve, never the first sample", () => {
    // Two lanes that both vary with time: min 1..3, max 5..7.
    const table = tableOf({ op: "random", entryCount: 2, entryStride: 2, subEntryStride: 1, timeScale: 1, timeBias: 0, values: [1, 5, 3, 7] });
    const channel = rawDistributionChannel(
      structTag("Lifetime", [
        structTag("Table", [
          scalarTag("Op", "ByteProperty", 2),
          scalarTag("EntryCount", "ByteProperty", 2),
          scalarTag("EntryStride", "ByteProperty", 2),
          scalarTag("SubEntryStride", "ByteProperty", 1),
          scalarTag("TimeScale", "FloatProperty", 1),
          scalarTag("TimeBias", "FloatProperty", 0),
          floatArrayTag("Values", [1, 5, 3, 7]),
        ]),
      ]),
      () => undefined,
    );
    expect(channel?.kind).toBe("uniform-curve");
    if (channel?.kind !== "uniform-curve") throw new Error("expected a uniform curve");
    expect(channel.minKeys.map((key) => key.v)).toEqual([1, 3]);
    expect(channel.maxKeys.map((key) => key.v)).toEqual([5, 7]);
    // First-sample collapse would only produce [1] / [5].
    const object: DistributionObject = { kind: "uniform-curve", minKeys: channel.minKeys, maxKeys: channel.maxKeys };
    expect(crossCheckDistribution(object, table).agreesWithinOnePercent).toBe(true);
  });

  it("refuses a table whose stride cannot describe its entries rather than fabricating zeros", () => {
    expect(tableIsValid(tableOf({ entryCount: 3, entryStride: 0, subEntryStride: 0, values: [1, 2, 3] }))).toBe(false);
    expect(tableIsValid(tableOf({ entryCount: 3, entryStride: 1, subEntryStride: 0, values: [1] }))).toBe(false);
    expect(tableIsValid(tableOf({ entryCount: 2, entryStride: 2, subEntryStride: 3, values: [1, 2, 3, 4] }))).toBe(false);
    expect(tableIsValid(tableOf({ entryCount: 2, entryStride: 1, subEntryStride: 0, timeScale: 0, values: [1, 2] }))).toBe(false);
    const corrupt = structTag("Lifetime", [
      structTag("Table", [
        scalarTag("EntryCount", "ByteProperty", 3),
        scalarTag("EntryStride", "ByteProperty", 0),
        scalarTag("SubEntryStride", "ByteProperty", 0),
        floatArrayTag("Values", [1, 2, 3]),
      ]),
    ]);
    expect(readDistributionTable(rawDistributionTableTag(corrupt))).toBeUndefined();
    expect(rawDistributionChannel(corrupt, () => undefined)).toBeNull();
  });

  it("treats a particle-parameter distribution as unresolved, never a passing skip", () => {
    const object: DistributionObject = { kind: "particle-parameter", parameter: "Rate", constant: 4 };
    const table = tableOf({ values: [4] });
    const check = crossCheckDistribution(object, table);
    expect(check.skipped).toBe("particle-parameter");
    expect(check.agreesWithinOnePercent).toBe(false);
    // The default the parameter overrides is read explicitly, not dropped.
    const tag = structTag("SpawnRate", [
      objectTag("Distribution", "DistributionParam", 9),
      structTag("Table", [scalarTag("EntryCount", "ByteProperty", 1), scalarTag("EntryStride", "ByteProperty", 1), floatArrayTag("Values", [4])]),
    ]);
    const exports: readonly DumpExport[] = [
      { index: 9, class: "DistributionFloatParticleParameter", name: "DistributionParam", properties: [scalarTag("ParameterName", "NameProperty", "Rate"), scalarTag("Constant", "FloatProperty", 4)] },
    ];
    expect(readDistributionObject(tag, (i) => exports.find((e) => e.index === i))).toEqual({
      kind: "particle-parameter",
      parameter: "Rate",
      paramClass: "float",
      constant: 4,
      remap: { minInput: 0, maxInput: 1, minOutput: 0, maxOutput: 1 },
    });
  });
});

describe("curve tangents and vector values (AC-2)", () => {
  function point(t: number, out: DumpTag, arrive: DumpTag, leave: DumpTag, interp = "CIM_CurveUser"): readonly DumpTag[] {
    return [scalarTag("InVal", "FloatProperty", t), out, arrive, leave, scalarTag("InterpMode", "ByteProperty", interp)];
  }

  it("reads tangents, so a curved segment is Hermite and not linear", () => {
    const tag = structTag("ConstantCurve", [
      structArrayTag("Points", [
        point(0, scalarTag("OutVal", "FloatProperty", 0), scalarTag("ArriveTangent", "FloatProperty", 0), scalarTag("LeaveTangent", "FloatProperty", 1)),
        point(2, scalarTag("OutVal", "FloatProperty", 10), scalarTag("ArriveTangent", "FloatProperty", 2), scalarTag("LeaveTangent", "FloatProperty", 0)),
      ]),
    ]);
    const keys = readCurveKeys(tag)!;
    expect(keys[0]?.leaveTangent).toBe(1);
    expect(keys[1]?.arriveTangent).toBe(2);
    expect(keys[0]?.interp).toBe("curve");
    const object: DistributionObject = { kind: "curve", keys, uniform: false };
    // Hermite at alpha 0.5 with each tangent scaled by the 2s segment: 4.75, not the 4.875
    // an unscaled tangent gives and not the linear 5.
    expect(evaluateDistributionObject(object, 1)).toEqual({ first: [4.75], last: [4.75] });
  });

  it("keeps a vector curve's OutVal instead of dropping it to zero", () => {
    const tag = structTag("ConstantCurve", [
      structArrayTag("Points", [
        point(0, objectStructTag("OutVal", 1, 2, 3), objectStructTag("ArriveTangent", 0, 0, 0), objectStructTag("LeaveTangent", 0, 0, 0), "CIM_Linear"),
        point(1, objectStructTag("OutVal", 4, 5, 6), objectStructTag("ArriveTangent", 0, 0, 0), objectStructTag("LeaveTangent", 0, 0, 0), "CIM_Linear"),
      ]),
    ]);
    const keys = readCurveKeys(tag)!;
    expect(keys[0]?.v).toEqual([1, 2, 3]);
    const object: DistributionObject = { kind: "curve", keys, uniform: false };
    expect(evaluateDistributionObject(object, 0.5)).toEqual({ first: [2.5, 3.5, 4.5], last: [2.5, 3.5, 4.5] });
  });

  it("maps a uniform curve to two lanes, not one", () => {
    const lanes = structTag("OutVal", [scalarTag("X", "FloatProperty", 1), scalarTag("Y", "FloatProperty", 9)]);
    const tag = structTag("ConstantCurve", [structArrayTag("Points", [[scalarTag("InVal", "FloatProperty", 0), lanes, scalarTag("ArriveTangent", "FloatProperty", 0), scalarTag("LeaveTangent", "FloatProperty", 0), scalarTag("InterpMode", "ByteProperty", "CIM_Linear")]])]);
    const exports: readonly DumpExport[] = [
      {
        index: 9,
        class: "DistributionFloatUniformCurve",
        name: "DistributionCurve",
        properties: [tag],
      },
    ];
    const raw = structTag("Lifetime", [objectTag("Distribution", "DistributionCurve", 9)]);
    const object = readDistributionObject(raw, (i) => exports.find((e) => e.index === i))!;
    expect(object.kind).toBe("uniform-curve");
    expect(evaluateDistributionObject(object, 0)).toEqual({ first: [1], last: [9] });
  });
});

describe("particle-parameter no-owner default (AC-2)", () => {
  /** The tagged `Distribution*ParticleParameter` exactly as the adapter dumps it. */
  function particleParameter(float: boolean, properties: readonly DumpTag[]): DistributionObject {
    const exports: readonly DumpExport[] = [{ index: 9, class: float ? "DistributionFloatParticleParameter" : "DistributionVectorParticleParameter", name: "DistributionParam", properties }];
    const tag = structTag("Rate", [objectTag("Distribution", "DistributionParam", 9)]);
    return readDistributionObject(tag, (i) => exports.find((e) => e.index === i))!;
  }

  it("uses the inherited Constant when the mode is DPM_Direct, without an owner", () => {
    const object = particleParameter(true, [scalarTag("ParameterName", "NameProperty", "Rate"), scalarTag("ParamMode", "ByteProperty", "DPM_Direct"), scalarTag("Constant", "FloatProperty", 8)]);
    expect(object.kind).toBe("particle-parameter");
    expect(evaluateDistributionNoOwnerDefault(object)).toEqual({ first: [8], last: [8] });
  });

  it("defaults an absent Constant to zero and an absent mode to DPM_Normal, which remaps", () => {
    // UDistributionFloatConstant::Constant is 0 when unserialized, and ParamMode defaults to DPM_Normal.
    const object = particleParameter(true, [scalarTag("ParameterName", "NameProperty", "Rate")]);
    expect(evaluateDistributionNoOwnerDefault(object)).toEqual({ first: [0], last: [0] });
    const remapped = particleParameter(true, [scalarTag("ParameterName", "NameProperty", "Rate"), scalarTag("Constant", "FloatProperty", 4)]);
    // DPM_Normal clamps 4 into MinInput 0..MaxInput 1, then scales to MinOutput 0..MaxOutput 1.
    expect(evaluateDistributionNoOwnerDefault(remapped)).toEqual({ first: [1], last: [1] });
  });

  it("takes the absolute value for DPM_Abs, matching UDistributionFloatParameterBase::GetValue", () => {
    const object = particleParameter(true, [scalarTag("ParameterName", "NameProperty", "Rate"), scalarTag("ParamMode", "ByteProperty", "DPM_Abs"), scalarTag("Constant", "FloatProperty", -3)]);
    // DPM_Abs: |−3| = 3, then the DPM_Normal-style remap with the default 0..1 inputs -> 1.
    expect(evaluateDistributionNoOwnerDefault(object)).toEqual({ first: [1], last: [1] });
  });

  it("keeps the vector Constant per axis for DPM_Direct", () => {
    const object = particleParameter(false, [
      scalarTag("ParameterName", "NameProperty", "paperColor"),
      scalarTag("ParamModes", "ByteProperty", "DPM_Direct"),
      scalarTag("ParamModes", "ByteProperty", "DPM_Direct"),
      scalarTag("ParamModes", "ByteProperty", "DPM_Direct"),
      objectStructTag("Constant", 1, 0.7, 0.4),
    ]);
    expect(evaluateDistributionNoOwnerDefault(object)).toEqual({ first: [1, 0.7, 0.4], last: [1, 0.7, 0.4] });
  });

  it("reports an unbaked table rather than a false agreement, and a real gap when one exists", () => {
    // A parameter distribution is not bakeable, so its Table is empty (the real Soul corpus case).
    const object = particleParameter(true, [scalarTag("ParameterName", "NameProperty", "Rate"), scalarTag("ParamMode", "ByteProperty", "DPM_Direct"), scalarTag("Constant", "FloatProperty", 8)]);
    const empty = tableOf({ entryCount: 0, entryStride: 0, subEntryStride: 0, timeScale: 0, values: [8] });
    const unbaked = crossCheckParticleParameterDefault(object, empty);
    expect(unbaked.tableBaked).toBe(false);
    expect(unbaked.samples).toBe(0);
    expect(unbaked.defaultValue).toEqual([8]);
    expect(unbaked.agreesWithinOnePercent).toBeUndefined();
    // A baked table that disagrees with the default is a reported gap, never a pass.
    const baked = tableOf({ entryCount: 1, entryStride: 1, subEntryStride: 0, values: [2] });
    const gap = crossCheckParticleParameterDefault(object, baked);
    expect(gap.tableBaked).toBe(true);
    expect(gap.samples).toBe(16);
    expect(gap.agreesWithinOnePercent).toBe(false);
    expect(gap.maxRelativeError).toBeGreaterThan(0.01);
  });
});

/** One sprite emitter: required (material on a mesh-material module), spawn, lifetime and an unmapped module. */
const CASCADE_EXPORTS: readonly DumpExport[] = [
      {
        index: 30,
        class: "ParticleModuleRequired",
        name: "ParticleModuleRequired_0",
        properties: [
          scalarTag("bUseLocalSpace", "BoolProperty", true),
          scalarTag("EmitterDuration", "FloatProperty", 5),
          scalarTag("EmitterDurationLow", "FloatProperty", 2),
          scalarTag("bEmitterDurationUseRange", "BoolProperty", true),
          structTag("SpawnRate", [objectTag("Distribution", "DistributionRate", 8)]),
        ],
      },
      {
        index: 25,
        class: "ParticleModuleLifetime",
        name: "ParticleModuleLifetime_0",
        properties: [LIFETIME],
      },
      {
        index: 24,
        class: "ParticleModuleLocation",
        name: "ParticleModuleLocation_0",
        properties: [structTag("StartLocation", [objectTag("Distribution", "DistributionLocation", 14)])],
      },
      {
        index: 33,
        class: "ParticleModuleSpawn",
        name: "ParticleModuleSpawn_0",
        properties: [
          structTag("Rate", [objectTag("Distribution", "DistributionRate", 8)]),
          structArrayTag("BurstList", [[scalarTag("Count", "IntProperty", 2), scalarTag("CountLow", "IntProperty", 0), scalarTag("Time", "FloatProperty", 0)]]),
        ],
      },
      { index: 26, class: "ParticleModuleMeshMaterial", name: "ParticleModuleMeshMaterial_1", properties: [objectArrayTag("MeshMaterials", [{ name: "M_effect", index: -28 }])] },
      { index: 34, class: "ParticleModuleTypeDataMesh", name: "ParticleModuleTypeDataMesh_0", properties: [objectTag("Mesh", "SM_piece", -34)] },
      {
        index: 21,
        class: "ParticleLODLevel",
        name: "ParticleLODLevel_0",
        properties: [
          objectTag("RequiredModule", "ParticleModuleRequired_0", 31),
          objectTag("SpawnModule", "ParticleModuleSpawn_0", 34),
          objectTag("TypeDataModule", "ParticleModuleTypeDataMesh_0", 35),
          objectArrayTag("Modules", [
            { name: "ParticleModuleLifetime_0", index: 26 },
            { name: "ParticleModuleLocation_0", index: 25 },
            { name: "ParticleModuleMeshMaterial_1", index: 27 },
          ]),
        ],
      },
      { index: 36, class: "ParticleSpriteEmitter", name: "ParticleSpriteEmitter_0", properties: [objectArrayTag("LODLevels", [{ name: "ParticleLODLevel_0", index: 22 }, { name: "ParticleLODLevel_1", index: 23 }])] },
      {
        index: 37,
        class: "ParticleSystem",
        name: "P_effect",
        properties: [
          objectArrayTag("Emitters", [{ name: "ParticleSpriteEmitter_0", index: 37 }]),
          scalarTag("WarmupTime", "FloatProperty", 2),
          scalarTag("bUseFixedRelativeBoundingBox", "BoolProperty", true),
          structTag("FixedRelativeBoundingBox", [objectStructTag("Min", -10, -100, -100), objectStructTag("Max", 550, 100, 120)]),
        ],
      },
      { index: 7, class: "DistributionFloatUniform", name: "DistributionRate", properties: [scalarTag("Min", "FloatProperty", 8), scalarTag("Max", "FloatProperty", 8)] },
      { index: 13, class: "DistributionVectorUniform", name: "DistributionLocation", properties: [objectStructTag("Min", 0, 0, 0), objectStructTag("Max", 0, 50, 0)] },
];

const PACKAGE: DumpPackage = { exports: CASCADE_EXPORTS };

/**
 * A minimal Cascade package for the PRD-584 force/type-data/duration findings: a required-module
 * property list, an optional type-data class and a module list. Export indices are assigned so every
 * object reference resolves against the 1-based `byIndex` mapping.
 */
function cascadeFixture(spec: {
  required?: readonly DumpTag[];
  typeData?: { class: string; properties?: readonly DumpTag[] };
  modules?: readonly { class: string; properties?: readonly DumpTag[] }[];
  system?: readonly DumpTag[];
}): DumpPackage {
  const entries: { class: string; name: string; properties: readonly DumpTag[] }[] = [
    { class: "ParticleModuleRequired", name: "Required_0", properties: spec.required ?? [] },
  ];
  if (spec.typeData) entries.push({ class: spec.typeData.class, name: `${spec.typeData.class}_0`, properties: spec.typeData.properties ?? [] });
  for (const module of spec.modules ?? []) entries.push({ class: module.class, name: `${module.class}_0`, properties: module.properties ?? [] });
  const exports: DumpExport[] = entries.map((entry, index) => ({ index, class: entry.class, name: entry.name, properties: entry.properties }));
  const typeDataOffset = spec.typeData ? 1 : 0;
  const lodIndex = exports.length;
  exports.push({
    index: lodIndex,
    class: "ParticleLODLevel",
    name: "LOD_0",
    properties: [
      objectTag("RequiredModule", entries[0]!.name, 1),
      ...(spec.typeData ? [objectTag("TypeDataModule", entries[1]!.name, 2)] : []),
      objectArrayTag("Modules", (spec.modules ?? []).map((module, index) => ({ name: `${module.class}_0`, index: typeDataOffset + 2 + index }))),
    ],
  });
  const emitterIndex = lodIndex + 1;
  exports.push({ index: emitterIndex, class: "ParticleSpriteEmitter", name: "Emitter_0", properties: [objectArrayTag("LODLevels", [{ name: "LOD_0", index: lodIndex + 1 }])] });
  const systemIndex = emitterIndex + 1;
  exports.push({ index: systemIndex, class: "ParticleSystem", name: "P_sys", properties: [objectArrayTag("Emitters", [{ name: "Emitter_0", index: emitterIndex + 1 }]), ...(spec.system ?? [])] });
  return { exports };
}

/** An `FRawDistribution*` with only its baked `Table`: `values` are one entry with `values.length` lanes. */
function tableDistTag(name: string, values: readonly number[]): DumpTag {
  return structTag(name, [
    structTag("Table", [
      scalarTag("Op", "ByteProperty", 0),
      scalarTag("EntryCount", "ByteProperty", 1),
      scalarTag("EntryStride", "ByteProperty", values.length),
      scalarTag("SubEntryStride", "ByteProperty", 0),
      scalarTag("TimeScale", "FloatProperty", 1),
      scalarTag("TimeBias", "FloatProperty", 0),
      floatArrayTag("Values", values),
    ]),
  ]);
}

describe("Cascade forces and type data (PRD-584 findings 1-2)", () => {
  it("reads Acceleration and Drag into forces instead of suppressing the mapped modules", () => {
    const descriptor = buildCascadeDescriptor(
      cascadeFixture({
        modules: [
          { class: "ParticleModuleAcceleration", properties: [tableDistTag("Acceleration", [0, 0, -10])] },
          { class: "ParticleModuleDrag", properties: [tableDistTag("Drag", [0.5])] },
        ],
      }),
    )!;
    const emitter = descriptor.emitters[0]!;
    expect(emitter.forces?.acceleration).toEqual({ kind: "curve", keys: [{ t: 0, v: [0, 0, -10], interp: "linear" }] });
    expect(emitter.forces?.drag).toEqual({ kind: "curve", keys: [{ t: 0, v: 0.5, interp: "linear" }] });
    expect(emitter.limitations).not.toContain("ParticleModuleAcceleration");
    expect(emitter.limitations).not.toContain("ParticleModuleDrag");
  });

  it("names AccelerationOverLifetime as an unsupported over-life application", () => {
    const descriptor = buildCascadeDescriptor(
      cascadeFixture({ modules: [{ class: "ParticleModuleAccelerationOverLifetime", properties: [tableDistTag("AccelerationOverLifetime", [0, 0, -10])] }] }),
    )!;
    expect(descriptor.emitters[0]!.limitations.some((entry) => entry.includes("ParticleModuleAccelerationOverLifetime"))).toBe(true);
  });

  it("maps TypeDataLight and TypeDataSprite to their renderers", () => {
    const light = buildCascadeDescriptor(cascadeFixture({ typeData: { class: "ParticleModuleTypeDataLight" } }))!;
    expect(light.emitters[0]!.renderer).toBe("light");
    const sprite = buildCascadeDescriptor(cascadeFixture({ typeData: { class: "ParticleModuleTypeDataSprite" } }))!;
    expect(sprite.emitters[0]!.renderer).toBe("sprite");
  });

  it("names an unknown type data and records the sprite default instead of faking it", () => {
    const descriptor = buildCascadeDescriptor(cascadeFixture({ typeData: { class: "ParticleModuleTypeDataFuture" } }))!;
    expect(descriptor.emitters[0]!.renderer).toBe("sprite");
    expect(descriptor.emitters[0]!.limitations.some((entry) => entry.includes("ParticleModuleTypeDataFuture"))).toBe(true);
  });
});

describe("Cascade mapping (AC-1)", () => {
  it("maps the emitter count, material, spawn and lifetime, and names the unmapped module", () => {
    const descriptor = buildCascadeDescriptor(PACKAGE)!;
    expect(descriptor.system).toBe("P_effect");
    expect(descriptor.warmup).toBe(2);
    expect(descriptor.bounds).toEqual({ min: [-10, -100, -100], max: [550, 100, 120] });
    expect(descriptor.emitters).toHaveLength(1);
    const emitter = descriptor.emitters[0]!;
    expect(emitter.renderer).toBe("mesh");
    expect(emitter.material).toBe("M_effect");
    expect(emitter.localSpace).toBe(true);
    expect(emitter.spawn?.rate).toEqual({ kind: "range", min: 8, max: 8 });
    expect(emitter.spawn?.bursts).toEqual([{ time: 0, count: 2, countLow: 0 }]);
    expect(emitter.init?.lifetime).toEqual({ kind: "range", min: 3, max: 5 });
    // PRD-584 finding 4: duration/loops/delay are exported; the variable low is named, not dropped.
    expect(emitter.duration).toBe(5);
    expect(emitter.loops).toBe(0);
    expect(emitter.delay).toBe(0);
    expect(emitter.limitations).toContain("ParticleModuleLocation");
    expect(emitter.limitations.some((entry) => entry.includes("EmitterDurationLow 2"))).toBe(true);
    expect(validateEffectDescriptor(descriptor)).toEqual(descriptor);
  });

  it("returns null for a package with no ParticleSystem", () => {
    expect(buildCascadeDescriptor({ exports: [{ index: 0, class: "StaticMesh", name: "SM_x" }] })).toBeNull();
  });
});

describe("importer: Cascade descriptors (AC-1, AC-4)", () => {
  it("writes Effects/<system>.cascade.json through the public import and clears the skip", async () => {
    const root = await mkdtemp(join(tmpdir(), "effect-import-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const sourceDir = join(root, "source");
    const content = join(sourceDir, "Content", "Test");
    await mkdir(content, { recursive: true });
    await writeFile(join(content, "P_effect.uasset"), Buffer.alloc(16));
    const umodel = join(root, "umodel");
    await writeFakeUmodel(umodel, { classes: { P_effect: ["ParticleSystem"] } });
    const dump = { format: 1, game: "GAME_UE4_18", packages: [{ path: "Content/Test/P_effect", exports: CASCADE_EXPORTS }] };
    const converter = join(root, "converter");
    await writeFile(
      converter,
      `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const argv = process.argv.slice(2);
if (argv.includes("--version")) { process.stdout.write("fake-converter 1\\n"); process.exit(0); }
const at = argv.indexOf("--dump-effects");
if (at >= 0) fs.writeFileSync(argv[at + 1], ${JSON.stringify(JSON.stringify(dump))});
process.exit(0);
`,
    );
    await chmod(converter, 0o755);
    const outputDir = join(root, "output");
    const report = await importUnrealDirectory({
      sourceDir,
      outputDir,
      onlyPackages: ["P_effect"],
      concurrency: 1,
      freeSpaceBytes: 30_000_000_000,
      environment: { ...process.env, THREENATIVE_UNREAL_CACHE_DIR: join(root, "cache") },
      umodel: { name: "umodel", path: umodel, version: "fixture" },
      modernConverter: { name: "modern", path: converter, version: "fake-converter 1" },
    });
    expect(report.effects).toHaveLength(1);
    expect(report.counts.effects).toBe(1);
    expect(report.skipped.some((entry) => entry.package.includes("P_effect"))).toBe(false);
    const descriptor = JSON.parse(await readFile(join(outputDir, "Effects", "P_effect.cascade.json"), "utf8"));
    expect(descriptor.emitters).toHaveLength(1);
    expect(descriptor.emitters[0].material).toBe("M_effect");
  });

  it("writes Effects/<system>.niagara.json through the public import and clears the skip", async () => {
    const root = await mkdtemp(join(tmpdir(), "niagara-import-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const sourceDir = join(root, "source");
    const content = join(sourceDir, "Content", "Test");
    await mkdir(content, { recursive: true });
    await writeFile(join(content, "NS_test.uasset"), Buffer.alloc(16));
    const umodel = join(root, "umodel");
    await writeFakeUmodel(umodel, { classes: { NS_test: ["NiagaraSystem"] } });
    const dump = { format: 1, game: "GAME_UE5_4", packages: [{ path: "Content/Test/NS_test", exports: NIAGARA_EXPORTS }] };
    const converter = join(root, "converter");
    await writeFile(
      converter,
      `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const argv = process.argv.slice(2);
if (argv.includes("--version")) { process.stdout.write("fake-converter 1\\n"); process.exit(0); }
const at = argv.indexOf("--dump-effects");
if (at >= 0) fs.writeFileSync(argv[at + 1], ${JSON.stringify(JSON.stringify(dump))});
process.exit(0);
`,
    );
    await chmod(converter, 0o755);
    const outputDir = join(root, "output");
    const report = await importUnrealDirectory({
      sourceDir,
      outputDir,
      onlyPackages: ["NS_test"],
      concurrency: 1,
      freeSpaceBytes: 30_000_000_000,
      environment: { ...process.env, THREENATIVE_UNREAL_CACHE_DIR: join(root, "cache") },
      umodel: { name: "umodel", path: umodel, version: "fixture" },
      modernConverter: { name: "modern", path: converter, version: "fake-converter 1" },
    });
    expect(report.effects).toHaveLength(1);
    expect(report.counts.effects).toBe(1);
    expect(report.skipped.some((entry) => entry.package.includes("NS_test"))).toBe(false);
    const descriptor = JSON.parse(await readFile(join(outputDir, "Effects", "NS_Test.niagara.json"), "utf8"));
    expect(descriptor.source).toBe("niagara");
    expect(descriptor.emitters[0].material).toBe("M_Smoke");
  });
});

describe("importer: level and Blueprint effect omissions (AC-4)", () => {
  /** A package head: magic, legacy version, UE4 object version, then the name table. */
  function packageHead(names: readonly string[], legacy: number, ue4 = 522): Buffer {
    const header = Buffer.alloc(24);
    header.writeUInt32LE(0x9e2a83c1, 0);
    header.writeInt32LE(legacy, 4);
    header.writeInt32LE(864, 8);
    header.writeInt32LE(ue4, 12);
    header.writeInt32LE(0, 16);
    header.writeInt32LE(names.length, 20);
    const table = names.map((name) => {
      const bytes = Buffer.from(`${name}\0`, "latin1");
      const length = Buffer.alloc(4);
      length.writeInt32LE(bytes.length, 0);
      return Buffer.concat([length, bytes]);
    });
    return Buffer.concat([header, ...table]);
  }

  /** A synthetic level that places one effect component in the level plus one serialized Blueprint, and one whose source was not exportable. */
  const SCENE_SOURCE = {
    format: "threenative-unreal-scene-source",
    version: 1,
    mapName: "TestMap",
    sourceFile: "Content/Test/TestMap.umap",
    actors: [],
    lights: [],
    blueprintComponents: 1,
    camera: { hasCamera: false, location: { x: 0, y: 0, z: 0 }, rotation: { pitch: 0, yaw: 0, roll: 0 } },
    omittedActors: [
      { actor: "TestMap", component: "ParticleSystemComponent_0", sourceClass: "ParticleSystemComponent", descriptor: "Effects/P_effect.cascade.json", reason: "particle effect is exported as a portable descriptor (Effects/P_effect.cascade.json); its simulation is not reconstructed" },
      { actor: "BP_Dust", component: "ParticleSystemComponent_0", sourceClass: "ParticleSystemComponent", descriptor: "Effects/P_effect.cascade.json", reason: "particle effect is exported as a portable descriptor (Effects/P_effect.cascade.json); its simulation is not reconstructed" },
      { actor: "TestMap", component: "ParticleSystemComponent_1", sourceClass: "ParticleSystemComponent", descriptor: "Effects/P_missing.cascade.json", reason: "particle effect is exported as a portable descriptor (Effects/P_missing.cascade.json); its simulation is not reconstructed" },
      { actor: "TestMap", component: "ParticleSystemComponent_2", sourceClass: "ParticleSystemComponent", reason: "particle effect component has no serialized system reference, so no descriptor was exported" },
    ],
  };

  async function run(options: { readonly effectPackage?: string }): Promise<{ report: Awaited<ReturnType<typeof importUnrealDirectory>>; outputDir: string }> {
    const root = await mkdtemp(join(tmpdir(), "effect-level-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const sourceDir = join(root, "source");
    const content = join(sourceDir, "Content", "Test");
    await mkdir(content, { recursive: true });
    await writeFile(join(content, "P_effect.uasset"), Buffer.alloc(16));
    await writeFile(join(content, "TestMap.umap"), packageHead(["/Script/Engine", "PersistentLevel", "WorldSettings", "Level"], -7));
    const umodel = join(root, "umodel");
    await writeFakeUmodel(umodel, { classes: { P_effect: ["ParticleSystem"], TestMap: ["Level"] } });
    const dump = {
      format: 1,
      game: "GAME_UE4_18",
      packages: options.effectPackage === undefined
        ? []
        : [{ path: options.effectPackage, exports: CASCADE_EXPORTS }],
    };
    const modern = join(root, "modern-converter");
    await writeFile(
      modern,
      `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const argv = process.argv.slice(2);
if (argv.includes("--version")) { process.stdout.write("fake-converter 1\\n"); process.exit(0); }
const at = argv.indexOf("--dump-effects");
if (at >= 0) fs.writeFileSync(argv[at + 1], ${JSON.stringify(JSON.stringify(dump))});
process.exit(0);
`,
    );
    await chmod(modern, 0o755);
    const uncooked = join(root, "uncooked-converter");
    await writeFile(
      uncooked,
      `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const { join } = require("node:path");
const argv = process.argv.slice(2);
if (argv.includes("--version")) { process.stdout.write("fake-uncooked 1\\n"); process.exit(0); }
const sceneAt = argv.indexOf("--scene-json-dir");
if (sceneAt >= 0) {
  const directory = argv[sceneAt + 1];
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(join(directory, "TestMap.scene-source.json"), ${JSON.stringify(JSON.stringify(SCENE_SOURCE))});
}
process.exit(0);
`,
    );
    await chmod(uncooked, 0o755);
    const outputDir = join(root, "output");
    const report = await importUnrealDirectory({
      sourceDir,
      outputDir,
      concurrency: 1,
      graphBake: false,
      freeSpaceBytes: 30_000_000_000,
      environment: { ...process.env, THREENATIVE_UNREAL_CACHE_DIR: join(root, "cache") },
      umodel: { name: "umodel", path: umodel, version: "fixture" },
      uncookedConverter: { name: "uncooked", path: uncooked, version: "fake-uncooked 1" },
      modernConverter: { name: "modern", path: modern, version: "fake-converter 1" },
    });
    return { report, outputDir };
  }

  it("keeps a pointer to the written descriptor for a level and a serialized Blueprint placement", async () => {
    const { report, outputDir } = await run({ effectPackage: "/Game/Test/P_effect" });
    expect(report.effects).toHaveLength(1);
    expect(report.effects[0]?.package).toBe("/Game/Test/P_effect");
    const scene = report.scenes.find((entry) => entry.name === "TestMap");
    expect(scene).toBeDefined();
    const omissions = scene!.omittedActors;
    const exported = omissions.filter((entry) => entry.descriptor === "Effects/P_effect.cascade.json");
    // Both the level's component and the Blueprint's serialized component point at the written descriptor.
    expect(exported.map((entry) => entry.actor).sort()).toEqual(["BP_Dust", "TestMap"]);
    // The descriptor the writer produced is on disk.
    const descriptor = JSON.parse(await readFile(join(outputDir, "Effects", "P_effect.cascade.json"), "utf8"));
    expect(descriptor.system).toBe("P_effect");
  });

  it("drops a pointer to an effect descriptor that was not exported, keeping an explicit reason", async () => {
    const { report } = await run({ effectPackage: "/Game/Test/P_effect" });
    const scene = report.scenes.find((entry) => entry.name === "TestMap")!;
    const missing = scene.omittedActors.filter((entry) => entry.component === "ParticleSystemComponent_1");
    expect(missing).toHaveLength(1);
    expect(missing[0]?.descriptor).toBeUndefined();
    expect(missing[0]?.reason).toContain("P_missing.cascade.json");
    expect(missing[0]?.reason).toContain("was not exported");
    // An effect component with no source reference stays an explicit omission with no dangling pointer.
    const noSource = scene.omittedActors.find((entry) => entry.component === "ParticleSystemComponent_2")!;
    expect(noSource.descriptor).toBeUndefined();
    expect(noSource.reason).toContain("no serialized system reference");
  });

  it("drops a pointer when no effect descriptor was written at all", async () => {
    const { report } = await run({});
    const scene = report.scenes.find((entry) => entry.name === "TestMap")!;
    expect(report.effects).toEqual([]);
    expect(scene.omittedActors.some((entry) => entry.descriptor !== undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Niagara mapping (AC-3): synthetic tagged exports in the exact shape the adapter emits.
// The `FStructFallback` values are tag arrays; the reflected `FNiagaraVariableWithOffset`
// entries are records. No pack bytes or licensed names.
// ---------------------------------------------------------------------------

const MATCH_GUID = [11, 22, 33, 44] as const;
const OTHER_GUID = [91, 82, 73, 64] as const;

function reflectedStruct(name: string, fields: Record<string, unknown>): DumpTag {
  return {
    name,
    type: "StructProperty",
    arrayIndex: 0,
    arraySize: null,
    value: { kind: "struct", structType: "reflected", fields },
  };
}

function guidTag(name: string, parts: readonly [number, number, number, number]): DumpTag {
  return reflectedStruct(name, { A: String(parts[0]), B: String(parts[1]), C: String(parts[2]), D: String(parts[3]) });
}

function floatBytes(value: number): number[] {
  const buffer = Buffer.alloc(4);
  buffer.writeFloatLE(value, 0);
  return [...buffer];
}

function intBytes(value: number): number[] {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32LE(value, 0);
  return [...buffer];
}

/** A reflected `FNiagaraVariableWithOffset` record, exactly as the probe reflects it. */
function offsetEntry(offset: number, name: string): unknown {
  return { kind: "struct", structType: "CUE4Parse.UE4.Objects.Niagara.FNiagaraVariableWithOffset", fields: { Offset: String(offset), Name: name, TypeDef: { Properties: [] } } };
}

function reflectedArrayTag(name: string, elements: readonly unknown[]): DumpTag {
  return { name, type: "ArrayProperty", arrayIndex: 0, arraySize: null, value: { kind: "array", inner: "StructProperty", count: elements.length, elements: elements as readonly never[] } };
}

function byteArrayTag(name: string, bytes: readonly number[]): DumpTag {
  return {
    name,
    type: "ArrayProperty",
    arrayIndex: 0,
    arraySize: null,
    value: { kind: "array", inner: "ByteProperty", count: bytes.length, elements: bytes.map((byte) => ({ kind: "ByteProperty", value: String(byte) })) },
  };
}

function rapidIterationTag(offsets: readonly (readonly [number, string])[], bytes: readonly number[]): DumpTag {
  return structTag("RapidIterationParameters", [
    reflectedArrayTag("SortedParameterOffsets", offsets.map(([offset, name]) => offsetEntry(offset, name))),
    byteArrayTag("ParameterData", bytes),
  ]);
}

const RIP_BYTES: readonly number[] = [
  ...floatBytes(0), ...floatBytes(0), ...floatBytes(200),
  ...floatBytes(1.2),
  ...floatBytes(1.75),
  ...floatBytes(0.25),
  ...floatBytes(7),
];

const RIP_OFFSETS: readonly (readonly [number, string])[] = [
  [0, "Constants.SmokeTrail.GravityForce.Gravity"],
  [12, "Constants.SmokeTrail.InitializeParticle.Lifetime Min"],
  [16, "Constants.SmokeTrail.InitializeParticle.Lifetime Max"],
  [20, "Constants.SmokeTrail.Drag.Drag"],
  [24, "Constants.SmokeTrail.AddVelocity.Speed Falloff From Cone Axis"],
];

function versionDataElement(guid: readonly [number, number, number, number], simTarget: string): unknown {
  return {
    kind: "struct",
    structType: "CUE4Parse.UE4.Assets.Objects.FStructFallback",
    fields: [
      structTag("Version", [scalarTag("MajorVersion", "IntProperty", 1), scalarTag("MinorVersion", "IntProperty", 0), guidTag("VersionGuid", guid)]),
      scalarTag("bLocalSpace", "BoolProperty", true),
      scalarTag("SimTarget", "EnumProperty", `ENiagaraSimTarget::${simTarget}`),
      reflectedStruct("FixedBounds", { IsValid: "1", Min: { X: "-100", Y: "-100", Z: "-100" }, Max: { X: "100", Y: "100", Z: "100" } }),
      objectArrayTag("RendererProperties", [{ name: "NiagaraSpriteRendererProperties_0", index: 2 }]),
      structTag("SpawnScriptProps", [objectTag("Script", "SpawnScript", 3)]),
      structTag("UpdateScriptProps", [objectTag("Script", "UpdateScript", 4)]),
      structTag("EmitterSpawnScriptProps", []),
      structTag("EmitterUpdateScriptProps", []),
    ],
  };
}

const NIAGARA_EXPORTS: readonly DumpExport[] = [
  {
    index: 0,
    class: "NiagaraEmitter",
    name: "SmokeTrail_0",
    properties: [
      scalarTag("UniqueEmitterName", "StrProperty", "SmokeTrail"),
      reflectedArrayTag("VersionData", [versionDataElement(OTHER_GUID, "GPU"), versionDataElement(MATCH_GUID, "CPUSim")]),
    ],
  },
  {
    index: 1,
    class: "NiagaraSpriteRendererProperties",
    name: "NiagaraSpriteRendererProperties_0",
    properties: [
      objectTag("Material", "M_Smoke", -34),
      reflectedStruct("SubImageSize", { X: "3", Y: "3" }),
    ],
  },
  { index: 2, class: "NiagaraScript", name: "SpawnScript", properties: [rapidIterationTag(RIP_OFFSETS, RIP_BYTES)] },
  { index: 3, class: "NiagaraScript", name: "UpdateScript", properties: [rapidIterationTag([], [])] },
  {
    index: 4,
    class: "NiagaraSystem",
    name: "NS_Test",
    properties: [
      {
        name: "EmitterHandles",
        type: "ArrayProperty",
        arrayIndex: 0,
        arraySize: null,
        value: {
          kind: "array",
          inner: "StructProperty",
          count: 1,
          elements: [
            {
              kind: "struct",
              structType: "CUE4Parse.UE4.Assets.Objects.FStructFallback",
              fields: [
                scalarTag("Name", "NameProperty", "SmokeTrail"),
                structTag("VersionedInstance", [objectTag("Emitter", "SmokeTrail_0", 1), guidTag("Version", MATCH_GUID)]),
              ],
            },
          ],
        },
      },
    ],
  },
  { index: 5, class: "NiagaraDataInterfaceCurve", name: "NiagaraDataInterfaceCurve_0", properties: [] },
  { index: 6, class: "NiagaraDataInterfaceSpriteRendererInfo", name: "NiagaraDataInterfaceSpriteRendererInfo_0", properties: [] },
];

describe("Niagara mapping (AC-3)", () => {
  it("selects the VersionData whose GUID matches the handle, not the first entry", () => {
    const descriptor = buildNiagaraDescriptor({ exports: NIAGARA_EXPORTS })!;
    expect(descriptor.source).toBe("niagara");
    const emitter = descriptor.emitters[0]!;
    expect(emitter.simTarget).toBe("cpu");
    expect(emitter.version).toBe(MATCH_GUID.join(":"));
  });

  it("carries the renderer type, material, subUV and local space", () => {
    const emitter = buildNiagaraDescriptor({ exports: NIAGARA_EXPORTS })!.emitters[0]!;
    expect(emitter.renderer).toBe("sprite");
    expect(emitter.material).toBe("M_Smoke");
    expect(emitter.subUV).toEqual({ columns: 3, rows: 3 });
    expect(emitter.localSpace).toBe(true);
  });

  it("decodes RapidIterationParameters little-endian by the source-backed width", () => {
    const emitter = buildNiagaraDescriptor({ exports: NIAGARA_EXPORTS })!.emitters[0]!;
    expect(emitter.forces?.acceleration).toEqual({ kind: "range", min: [0, 0, 200], max: [0, 0, 200] });
    expect(emitter.forces?.drag).toEqual({ kind: "range", min: 0.25, max: 0.25 });
    const lifetime = emitter.init?.lifetime as { kind: "range"; min: number; max: number };
    expect(lifetime.kind).toBe("range");
    expect(lifetime.min).toBeCloseTo(1.2, 5);
    expect(lifetime.max).toBeCloseTo(1.75, 5);
    const gravity = emitter.rapidIteration?.find((entry) => entry.name.endsWith("Gravity"));
    expect(gravity).toMatchObject({ offset: 0, width: 12, widthSource: "type", values: [0, 0, 200] });
    const falloff = emitter.rapidIteration?.find((entry) => entry.name.endsWith("Speed Falloff From Cone Axis"));
    expect(falloff?.widthSource).toBe("offset");
  });

  it("names an absent SpawnRate override and every unmapped module and data interface", () => {
    const emitter = buildNiagaraDescriptor({ exports: NIAGARA_EXPORTS })!.emitters[0]!;
    expect(emitter.modules).toContain("AddVelocity");
    expect(emitter.limitations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("SpawnRate has no stored override"),
        expect.stringContaining('Niagara module "AddVelocity" is not exported'),
        expect.stringContaining("Niagara data interface NiagaraDataInterfaceCurve is not exported"),
      ]),
    );
    expect(JSON.stringify(emitter)).not.toContain('"rate":0');
  });

  it("refuses a rapid-iteration entry whose offset lies outside the stored data", () => {
    const malformed: readonly DumpExport[] = [
      {
        index: 0,
        class: "NiagaraEmitter",
        name: "E_0",
        properties: [
          scalarTag("UniqueEmitterName", "StrProperty", "E"),
          reflectedArrayTag("VersionData", [versionDataElement(MATCH_GUID, "CPUSim")]),
        ],
      },
      { index: 1, class: "NiagaraSpriteRendererProperties", name: "R_0", properties: [] },
      {
        index: 2,
        class: "NiagaraScript",
        name: "SpawnScript",
        properties: [rapidIterationTag([[0, "Constants.E.Drag.Drag"], [900, "Constants.E.GravityForce.Gravity"]], floatBytes(0.5))],
      },
      { index: 3, class: "NiagaraScript", name: "UpdateScript", properties: [] },
      { index: 4, class: "NiagaraSystem", name: "NS_Bad", properties: [{ name: "EmitterHandles", type: "ArrayProperty", arrayIndex: 0, arraySize: null, value: { kind: "array", inner: "StructProperty", count: 1, elements: [{ kind: "struct", structType: "fallback", fields: [scalarTag("Name", "NameProperty", "E"), structTag("VersionedInstance", [objectTag("Emitter", "E_0", 1), guidTag("Version", MATCH_GUID)])] }] } }] },
    ];
    const descriptor = buildNiagaraDescriptor({ exports: malformed })!;
    const emitter = descriptor.emitters[0]!;
    expect(emitter.rapidIteration?.some((entry) => entry.offset === 900)).toBe(false);
  });
});

describe("Niagara mapped modules are read or named (PRD-584 finding 3)", () => {
  const emitterHandles = NIAGARA_EXPORTS.find((entry) => entry.class === "NiagaraSystem")!.properties!;

  function niagaraPackage(
    offsets: readonly (readonly [number, string])[],
    bytes: readonly number[],
  ): DumpPackage {
    return {
      exports: [
        {
          index: 0,
          class: "NiagaraEmitter",
          name: "SmokeTrail_0",
          properties: [
            scalarTag("UniqueEmitterName", "StrProperty", "SmokeTrail"),
            reflectedArrayTag("VersionData", [versionDataElement(MATCH_GUID, "CPUSim")]),
          ],
        },
        { index: 1, class: "NiagaraSpriteRendererProperties", name: "NiagaraSpriteRendererProperties_0", properties: [objectTag("Material", "M_Smoke", -34)] },
        { index: 2, class: "NiagaraScript", name: "SpawnScript", properties: [rapidIterationTag(offsets, bytes)] },
        { index: 3, class: "NiagaraScript", name: "UpdateScript", properties: [] },
        { index: 4, class: "NiagaraSystem", name: "NS_Test", properties: [...emitterHandles] },
      ],
    };
  }

  const OFFSETS: readonly (readonly [number, string])[] = [
    [0, "Constants.SmokeTrail.SpawnBurstInstantaneous.Spawn Count"],
    [4, "Constants.SmokeTrail.SpawnBurstInstantaneous.Spawn Time"],
    [8, "Constants.SmokeTrail.SolveForcesAndVelocity.Acceleration Limit"],
    [12, "Constants.SmokeTrail.SolveForcesAndVelocity.Speed Limit"],
    [16, "Constants.SmokeTrail.ColorFromCurve.Scale RGBA"],
    [32, "Constants.SmokeTrail.ScaleSpriteSize.Scale Factor"],
  ];
  const BYTES: readonly number[] = [
    ...intBytes(5),
    ...floatBytes(0.5),
    ...floatBytes(900),
    ...floatBytes(1200),
    ...floatBytes(1), ...floatBytes(0.5), ...floatBytes(0.25), ...floatBytes(1),
    ...floatBytes(2),
  ];

  it("decodes the burst count, burst time and force limits from stored overrides", () => {
    const emitter = buildNiagaraDescriptor(niagaraPackage(OFFSETS, BYTES))!.emitters[0]!;
    // `Spawn Count` is an int; it is decoded as one, never misread as a denormal float.
    expect(emitter.spawn?.bursts).toEqual([{ time: 0.5, count: 5 }]);
    expect(emitter.forces?.accelerationLimit).toEqual({ kind: "range", min: 900, max: 900 });
    expect(emitter.forces?.speedLimit).toEqual({ kind: "range", min: 1200, max: 1200 });
    expect(emitter.limitations.some((entry) => entry.includes("SpawnBurstInstantaneous"))).toBe(false);
  });

  it("names the specific unexported inputs of ColorFromCurve and ScaleSpriteSize", () => {
    const emitter = buildNiagaraDescriptor(niagaraPackage(OFFSETS, BYTES))!.emitters[0]!;
    expect(emitter.modules).toEqual(expect.arrayContaining(["ColorFromCurve", "ScaleSpriteSize"]));
    expect(emitter.limitations.some((entry) => entry.includes("ColorFromCurve") && entry.includes("Scale RGB"))).toBe(true);
    expect(emitter.limitations.some((entry) => entry.includes("ScaleSpriteSize") && entry.includes("Scale Factor"))).toBe(true);
  });

  it("names a present burst module with no stored count instead of silently exporting nothing", () => {
    const offsets: readonly (readonly [number, string])[] = [[0, "Constants.SmokeTrail.SpawnBurstInstantaneous.Spawn Rate"]];
    const emitter = buildNiagaraDescriptor(niagaraPackage(offsets, floatBytes(1)))!.emitters[0]!;
    expect(emitter.spawn?.bursts).toEqual([]);
    expect(emitter.limitations.some((entry) => entry.includes('SpawnBurstInstantaneous is present but "Spawn Count"'))).toBe(true);
  });
});

describe("effect writer isolation and safe names (PRD-584 finding 5)", () => {
  it("exports the valid package and reports the invalid one without aborting", async () => {
    const root = await mkdtemp(join(tmpdir(), "effect-write-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    expect(effectDescriptorRelativePath("P_effect", "cascade")).toBe("Effects/P_effect.cascade.json");
    const dump = {
      format: 1,
      game: "GAME_UE4_18",
      packages: [
        { path: "/Game/Test/P_bad", exports: [{ index: 0, class: "ParticleSystem", name: undefined, properties: [] }] },
        { path: "/Game/Test/P_effect", exports: CASCADE_EXPORTS },
      ],
    } as unknown as EffectsDump;
    const result = await writeUnrealEffects(dump, root);
    expect(result.written).toHaveLength(1);
    expect(result.written[0]?.package).toBe("/Game/Test/P_effect");
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.package).toBe("/Game/Test/P_bad");
    const descriptor = JSON.parse(await readFile(join(root, "Effects", "P_effect.cascade.json"), "utf8"));
    expect(descriptor.system).toBe("P_effect");
  });

  it("refuses a duplicate system name instead of overwriting, and keeps a malicious name under Effects/", async () => {
    const root = await mkdtemp(join(tmpdir(), "effect-name-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const evil = CASCADE_EXPORTS.map((entry) => (entry.class === "ParticleSystem" ? { ...entry, name: "../../evil" } : entry));
    const dump = {
      format: 1,
      game: "GAME_UE4_18",
      packages: [
        { path: "/Game/A/P_effect", exports: CASCADE_EXPORTS },
        { path: "/Game/B/P_effect", exports: CASCADE_EXPORTS },
        { path: "/Game/Evil/P_evil", exports: evil },
      ],
    } as unknown as EffectsDump;
    const result = await writeUnrealEffects(dump, root);
    const evilEffect = result.written.find((effect) => effect.package === "/Game/Evil/P_evil")!;
    expect(evilEffect.descriptor.startsWith("Effects/")).toBe(true);
    expect(evilEffect.descriptor.split("/")).not.toContain("..");
    await readFile(join(root, ...evilEffect.descriptor.split("/")), "utf8");
    // The first `P_effect` wins; the second is refused, never written over the first.
    expect(result.written.filter((effect) => effect.system === "P_effect")).toHaveLength(1);
    expect(result.failures.some((failure) => failure.package === "/Game/B/P_effect" && failure.error.includes("already written"))).toBe(true);
  });

  it("keeps a collided package skipped through the public import while the winner exports", async () => {
    const root = await mkdtemp(join(tmpdir(), "effect-dupe-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const sourceDir = join(root, "source");
    await mkdir(join(sourceDir, "Content", "A"), { recursive: true });
    await mkdir(join(sourceDir, "Content", "B"), { recursive: true });
    await writeFile(join(sourceDir, "Content", "A", "P_effect.uasset"), Buffer.alloc(16));
    await writeFile(join(sourceDir, "Content", "B", "P_effect.uasset"), Buffer.alloc(16));
    const umodel = join(root, "umodel");
    await writeFakeUmodel(umodel, { classes: { P_effect: ["ParticleSystem"] } });
    const dump = {
      format: 1,
      game: "GAME_UE4_18",
      packages: [
        { path: "/Game/A/P_effect", exports: CASCADE_EXPORTS },
        { path: "/Game/B/P_effect", exports: CASCADE_EXPORTS },
      ],
    };
    const converter = join(root, "converter");
    await writeFile(
      converter,
      `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const argv = process.argv.slice(2);
if (argv.includes("--version")) { process.stdout.write("fake-converter 1\\n"); process.exit(0); }
const at = argv.indexOf("--dump-effects");
if (at >= 0) fs.writeFileSync(argv[at + 1], ${JSON.stringify(JSON.stringify(dump))});
process.exit(0);
`,
    );
    await chmod(converter, 0o755);
    const outputDir = join(root, "output");
    const report = await importUnrealDirectory({
      sourceDir,
      outputDir,
      concurrency: 1,
      freeSpaceBytes: 30_000_000_000,
      environment: { ...process.env, THREENATIVE_UNREAL_CACHE_DIR: join(root, "cache") },
      umodel: { name: "umodel", path: umodel, version: "fixture" },
      modernConverter: { name: "modern", path: converter, version: "fake-converter 1" },
    });
    expect(report.effects).toHaveLength(1);
    expect(report.counts.effects).toBe(1);
    // The winner left the skip list by canonical package key; the collided package stays skipped with its reason.
    expect(report.skipped.some((entry) => entry.package.includes("/A/P_effect"))).toBe(false);
    expect(report.skipped.some((entry) => entry.package === "/Game/B/P_effect" && entry.reason.includes("already written"))).toBe(true);
  });
});
