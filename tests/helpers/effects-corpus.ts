import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { effectDescriptorRelativePath, effectsDumpSchema, type EffectsDump } from "../../src/unreal/effects-dump.js";
import { SLICES } from "../../scripts/fab-slice.js";
import { importUnrealDirectory } from "../../src/unreal/importer.js";
import { CUE4PARSE_SOURCE } from "../../src/unreal/cue4parse-adapter.js";
import { childEnvironment, runBounded } from "../../src/unreal/toolchain.js";
import {
  crossCheckDistribution,
  crossCheckParticleParameterDefault,
  effectDescriptorSchema,
  rawDistributionTableTag,
  readDistributionObject,
  readDistributionTable,
  type DumpExport,
  type DumpPackage,
  type DumpTag,
  type EffectChannel,
  type EffectEmitter,
} from "../../src/unreal/effects-schema.js";

// Licensed slices stay local. Compare public output with raw exports, never rebuilt descriptors.
export function registerEffectsCorpusTests(corpusDir: string | undefined): void {
  const root = corpusDir;
  const suite = root === undefined ? describe.skip : describe;

  suite("PRD-584 real corpus acceptance", () => {
    const soulDir = join(root ?? "", "soul-cave-4.18");
    const vtolDir = join(root ?? "", "vtol-5.4");
    const cleanups: (() => Promise<void>)[] = [];
    const imports = new Map<string, Promise<CorpusImport>>();

    afterAll(async () => {
      for (const cleanup of cleanups) await cleanup();
    });

    const runImport = (sliceDir: string, label: string): Promise<CorpusImport> => {
      const existing = imports.get(sliceDir);
      if (existing !== undefined) return existing;
      const created = importSlice(sliceDir, label, cleanups);
      imports.set(sliceDir, created);
      return created;
    };

    it("cascade (AC-1): raw emitter count, renderer and material match, and every unmapped module is named", async () => {
      const { outputDir, report, dump } = await runImport(soulDir, "soul-cave-4.18");
      const packages = dump.packages as unknown as DumpPackage[];
      const systems = packages.flatMap((pkg) => pkg.exports.filter((entry) => entry.class === "ParticleSystem").map((system) => ({ pkg, system })));
      expect(systems.length, "raw Cascade packages found in the dump").toBeGreaterThanOrEqual(1);

      const cascadeDescriptors = report.effects.filter((effect) => effect.descriptor.endsWith(".cascade.json"));
      expect(cascadeDescriptors.length, "cascade descriptors written").toBe(systems.length);

      for (const { pkg, system } of systems) {
        const relative = effectDescriptorRelativePath({ package: pkg.path!, system: system.name }, "cascade");
        const written = report.effects.find((effect) => effect.descriptor === relative);
        expect(written?.package, "canonical source identity").toBe(pkg.path);
        const parsed = effectDescriptorSchema.parse(JSON.parse(await readFile(join(outputDir, relative), "utf8")));
        expect(parsed.source).toBe("cascade");
        expect(parsed.system).toBe(system.name);
        const byIndex = (index: number): DumpExport | undefined => pkg.exports.find((entry) => entry.index === index - 1);
        const rawEmitters = elementsOf(property(system.properties, "Emitters"))
          .map((element) => objectRefOf(element))
          .map((ref) => (ref === undefined ? undefined : byIndex(ref.Index)))
          .filter((entry): entry is DumpExport => entry !== undefined);
        expect(rawEmitters.length, "raw emitter coverage").toBeGreaterThan(0);
        expect(parsed.emitters.length, `${system.name} raw emitter count`).toBe(rawEmitters.length);

        for (let index = 0; index < rawEmitters.length; index++) {
          const rawEmitter = rawEmitters[index]!;
          const emitter = parsed.emitters[index]!;
          const modules = cascadeModules(rawEmitter, byIndex);
          const typeData = modules.find((module) => module.class.startsWith("ParticleModuleTypeData"));
          const expectedRenderer = typeData !== undefined ? CASCADE_RENDERERS[typeData.class] ?? "sprite" : "sprite";
          expect(emitter.renderer, `${system.name} emitter ${index} renderer`).toBe(expectedRenderer);

          const meshMaterial = liveObjectRefs(modules.find((module) => module.class === "ParticleModuleMeshMaterial"), "MeshMaterials")[0];
          const requiredMaterial = objectRefOf(
            property(modules.find((module) => module.class === "ParticleModuleRequired")?.properties, "Material"),
          );
          const expectedMaterial = meshMaterial?.Name ?? requiredMaterial?.Name ?? null;
          expect(emitter.material, `${system.name} emitter ${index} material`).toBe(expectedMaterial);

          for (const module of modules) {
            if (CASCADE_MAPPED_MODULES.has(module.class)) continue;
            expect(
              emitter.limitations.some((entry) => entry === module.class || entry.includes(module.class)),
              `${system.name} emitter ${index} names unmapped module ${module.class}`,
            ).toBe(true);
          }

          if (emitter.renderer === "sprite") {
            expect(emitter.material, `${system.name} emitter ${index} sprite material`).not.toBeNull();
            expect(emitter.spawn, `${system.name} emitter ${index} sprite spawn`).toBeDefined();
            expect(emitter.init?.lifetime, `${system.name} emitter ${index} sprite lifetime`).toBeDefined();
          }
        }
      }
    }, 180_000);

    it("cascade-distributions (AC-2): every dual Distribution+Table agrees in 16 samples, or is an unbaked particle parameter", async () => {
      const { dump } = await runImport(soulDir, "soul-cave-4.18");
      const packages = dump.packages as unknown as DumpPackage[];
      const duals: { where: string; tag: DumpTag; byIndex: (index: number) => DumpExport | undefined }[] = [];
      for (const pkg of packages) {
        const byIndex = (index: number): DumpExport | undefined => pkg.exports.find((entry) => entry.index === index - 1);
        for (const entry of pkg.exports) {
          for (const raw of entry.properties ?? []) {
            const tag = raw as DumpTag;
            const fields = fieldsOfValue(tag.value);
            if (fields === undefined) continue;
            if (objectRefOf(fieldOf(fields, "Distribution")) === undefined) continue;
            if (fieldOf(fields, "Table") === undefined) continue;
            duals.push({ where: `${entry.class}.${tag.name}`, tag, byIndex });
          }
        }
      }

      expect(duals.length, "dual Distribution+Table tags enumerated").toBe(17);

      let agree = 0;
      let dynamic = 0;
      let worst = 0;
      const failures: string[] = [];
      for (const dual of duals) {
        const object = readDistributionObject(dual.tag, dual.byIndex);
        if (object === undefined) throw new Error(`${dual.where} has an unknown Distribution class`);
        const table = readDistributionTable(rawDistributionTableTag(dual.tag));
        expect(table, `${dual.where} raw Table is readable`).toBeDefined();
        if (object.kind === "particle-parameter") {
          // Unbaked particle parameters are exclusions, never agreements.
          expect(table!.entryCount, `${dual.where} raw Table is empty`).toBe(0);
          expect(table!.values, `${dual.where} raw Table has no values`).toEqual([]);
          const check = crossCheckParticleParameterDefault(object, table!, 16);
          expect(check.tableBaked, `${dual.where} particle-parameter Table is unbaked`).toBe(false);
          expect(check.defaultValue.length, `${dual.where} no-owner default is explicit`).toBeGreaterThan(0);
          dynamic++;
          continue;
        }
        const check = crossCheckDistribution(object, table!, 16);
        expect(check.samples, `${dual.where} sampled 16 times`).toBe(16);
        if (check.agreesWithinOnePercent) agree++;
        else failures.push(`${dual.where} worst relative error ${check.maxRelativeError}`);
        worst = Math.max(worst, check.maxRelativeError);
      }

      expect(failures, "every dual form agrees or is an unbaked particle parameter").toEqual([]);
      expect(agree, "baked dual distributions agreeing within 1%").toBe(14);
      expect(dynamic, "unbaked particle-parameter dual distributions").toBe(3);
      expect(worst, "worst relative error over agreeing dual distributions").toBeLessThanOrEqual(0.01);
    }, 180_000);

    it("niagara (AC-3): exactly three systems, canonical identity, renderer/material/SimTarget and mapped inputs from the raw dump", async () => {
      const { outputDir, report, dump } = await runImport(vtolDir, "vtol-5.4");
      const packages = dump.packages as unknown as DumpPackage[];
      const systems = packages.flatMap((pkg) => pkg.exports.filter((entry) => entry.class === "NiagaraSystem").map((system) => ({ pkg, system })));
      expect(systems.length, "raw Niagara systems in the dump").toBe(3);
      expect(report.effects.filter((effect) => effect.descriptor.endsWith(".niagara.json")).length, "niagara descriptors written").toBe(3);

      for (const { pkg, system } of systems) {
        const relative = effectDescriptorRelativePath({ package: pkg.path!, system: system.name }, "niagara");
        const written = report.effects.find((effect) => effect.descriptor === relative);
        expect(written?.package, "canonical source identity").toBe(pkg.path);
        const parsed = effectDescriptorSchema.parse(JSON.parse(await readFile(join(outputDir, relative), "utf8")));
        expect(parsed.source).toBe("niagara");
        expect(parsed.system).toBe(system.name);
        const byIndex = (index: number): DumpExport | undefined => pkg.exports.find((entry) => entry.index === index - 1);
        const handles = niagaraHandles(system, byIndex);
        expect(handles.length, "raw emitter coverage").toBeGreaterThan(0);
        expect(parsed.emitters.length, `${system.name} raw emitter count`).toBe(handles.length);

        const dataInterfaces = [...new Set(pkg.exports.filter((entry) => entry.class.startsWith("NiagaraDataInterface")).map((entry) => entry.class))];
        for (let index = 0; index < handles.length; index++) {
          const handle = handles[index]!;
          const descriptorEmitter = parsed.emitters[index]!;
          expect(descriptorEmitter.name, `${system.name} emitter ${index} name`).toBe(handle.emitter.name);

          const dataFields = niagaraEmitterData(handle.emitter, handle.versionGuid);
          expect(dataFields, `${system.name} emitter ${index} VersionData`).toBeDefined();
          const simRaw = stringOf(fieldOf(dataFields, "SimTarget")) ?? "";
          const expectedSimTarget = simRaw.toLowerCase().includes("gpu") ? "gpu" : "cpu";
          expect(descriptorEmitter.simTarget, `${system.name} emitter ${index} SimTarget`).toBe(expectedSimTarget);
          expect(descriptorEmitter.localSpace, `${system.name} emitter ${index} localSpace`).toBe(
            boolOf(fieldOf(dataFields, "bLocalSpace")) ?? false,
          );

          const renderers = elementsOf(fieldOf(dataFields, "RendererProperties"))
            .map((element) => objectRefOf(element))
            .map((ref) => (ref === undefined ? undefined : byIndex(ref.Index)))
            .filter((entry): entry is DumpExport => entry !== undefined);
          const primary = renderers[0];
          const expectedRenderer = primary !== undefined ? NIAGARA_RENDERERS[primary.class] ?? "sprite" : "sprite";
          expect(descriptorEmitter.renderer, `${system.name} emitter ${index} renderer`).toBe(expectedRenderer);
          const expectedMaterial = primary !== undefined
            ? objectRefOf(property(primary.properties, "Material"))?.Name ?? null
            : null;
          expect(descriptorEmitter.material, `${system.name} emitter ${index} material`).toBe(expectedMaterial);

          for (const dataInterface of dataInterfaces) {
            expect(
              descriptorEmitter.limitations.includes(`Niagara data interface ${dataInterface} is not exported`),
              `${system.name} emitter ${index} names data interface ${dataInterface}`,
            ).toBe(true);
          }

          const store = rawRipStore(niagaraScripts(dataFields, byIndex));
          const uniqueName = stringOf(property(handle.emitter.properties, "UniqueEmitterName")) ?? handle.emitter.name;
          const prefix = `Constants.${uniqueName}.`;
          const rawModules = new Set<string>();
          for (const name of store.keys()) {
            if (!name.startsWith(prefix)) continue;
            const rest = name.slice(prefix.length);
            const dot = rest.indexOf(".");
            if (dot > 0) rawModules.add(rest.slice(0, dot));
          }
          expect([...(descriptorEmitter.modules ?? [])].sort(), `${system.name} emitter ${index} raw module set`).toEqual(
            [...rawModules].sort(),
          );
          for (const moduleName of rawModules) {
            if (NIAGARA_MAPPED_MODULES.has(moduleName)) continue;
            expect(
              descriptorEmitter.limitations.includes(`Niagara module "${moduleName}" is not exported`),
              `${system.name} emitter ${index} names unmapped module ${moduleName}`,
            ).toBe(true);
          }

          // Decode raw bytes independently, bounded by the next stored offset.
          expect(new Set((descriptorEmitter.rapidIteration ?? []).map((entry) => entry.name)), `${system.name} emitter ${index} raw parameter names`).toEqual(
            new Set(store.keys()),
          );
          for (const entry of descriptorEmitter.rapidIteration ?? []) {
            const raw = store.get(entry.name);
            expect(raw, `${system.name} emitter ${index} raw parameter ${entry.name}`).toBeDefined();
            expect(raw!.offset, `${system.name} emitter ${index} offset of ${entry.name}`).toBe(entry.offset);
            const leaf = entry.name.split(".").at(-1)!;
            // Engine input types fix vector/colour widths; scalar overrides occupy one float.
            const typedWidth = RIP_WIDTHS[leaf];
            const expectedWidth = typedWidth && raw!.width >= typedWidth && raw!.width % typedWidth === 0
              ? typedWidth : raw!.width;
            expect(entry.width, `${entry.name} source type/offset width`).toBe(expectedWidth);
            expect(entry.width, `${entry.name} stays within the raw offset span`).toBeLessThanOrEqual(raw!.width);
            const decoded = rawEntryValues({ ...raw!, width: entry.width });
            expect(decoded.length, `${system.name} emitter ${index} width of ${entry.name}`).toBe(entry.values.length);
            for (let lane = 0; lane < decoded.length; lane++) {
              expect(decoded[lane]!, `${system.name} emitter ${index} ${entry.name}[${lane}]`).toBeCloseTo(entry.values[lane]!, 5);
            }
          }

          assertMappedInputs(descriptorEmitter, store, prefix);
        }
      }
    }, 180_000);
  });
}

interface RawTag {
  readonly name: string;
  readonly value: unknown;
}
type RawFields = readonly RawTag[] | Record<string, unknown>;

function property(properties: readonly unknown[] | undefined, name: string): unknown {
  return (properties as readonly RawTag[] | undefined)?.find((tag) => tag.name === name)?.value;
}

function fieldsOfValue(value: unknown): RawFields | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as { kind?: unknown; fields?: unknown };
  if (typeof record.kind === "string") {
    return record.kind === "struct" ? (record.fields as RawFields) : undefined;
  }
  return value as Record<string, unknown>;
}

function fieldOf(fields: RawFields | undefined, name: string): unknown {
  if (fields === undefined) return undefined;
  if (Array.isArray(fields)) return (fields as readonly RawTag[]).find((tag) => tag.name === name)?.value;
  return (fields as Record<string, unknown>)[name];
}

function elementsOf(value: unknown): readonly unknown[] {
  if (value !== null && typeof value === "object" && (value as { kind?: unknown }).kind === "array") {
    return (value as { elements?: readonly unknown[] }).elements ?? [];
  }
  return Array.isArray(value) ? (value as readonly unknown[]) : [];
}

function scalarOf(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (value !== null && typeof value === "object" && "value" in value) {
    return scalarOf((value as { value?: unknown }).value);
  }
  return undefined;
}

function stringOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object" && typeof (value as { value?: unknown }).value === "string") {
    return (value as { value: string }).value;
  }
  return undefined;
}

function boolOf(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value !== null && typeof value === "object" && "value" in value) return boolOf(value.value);
  const text = stringOf(value);
  if (text === undefined) return undefined;
  const lower = text.toLowerCase();
  return lower === "true" ? true : lower === "false" ? false : undefined;
}

function objectRefOf(value: unknown): { Name: string; Index: number; IsNull: boolean } | undefined {
  if (value !== null && typeof value === "object" && (value as { kind?: unknown }).kind === "object") {
    const ref = (value as { value?: { Name: string; Index: number; IsNull: boolean } }).value;
    return ref !== undefined && !ref.IsNull ? ref : undefined;
  }
  return undefined;
}

function liveObjectRefs(exported: DumpExport | undefined, name: string): { Name: string; Index: number; IsNull: boolean }[] {
  return elementsOf(property(exported?.properties, name))
    .map((element) => objectRefOf(element))
    .filter((ref): ref is { Name: string; Index: number; IsNull: boolean } => ref !== undefined);
}

function guidOf(value: unknown): string | undefined {
  const fields = fieldsOfValue(value);
  if (fields === undefined) return undefined;
  const parts = ["A", "B", "C", "D"].map((part) => scalarOf(fieldOf(fields, part)));
  if (parts.every((part) => part !== undefined)) return parts.join(":");
  return guidOf(fieldOf(fields, "VersionGuid"));
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

const CASCADE_MAPPED_MODULES = new Set([
  "ParticleModuleRequired", "ParticleModuleSpawn", "ParticleModuleLifetime",
  "ParticleModuleSize", "ParticleModuleSizeMultiplyLife", "ParticleModuleSizeScale",
  "ParticleModuleVelocity", "ParticleModuleColor", "ParticleModuleColorOverLife",
  "ParticleModuleRotation", "ParticleModuleRotationRate", "ParticleModuleMeshRotation",
  "ParticleModuleMeshRotationRate", "ParticleModuleAcceleration", "ParticleModuleDrag",
  "ParticleModuleMeshMaterial", "ParticleModuleTypeDataMesh", "ParticleModuleTypeDataRibbon",
  "ParticleModuleTypeDataBeam2", "ParticleModuleTypeDataAnimTrail", "ParticleModuleTypeDataTrail2",
  "ParticleModuleTypeDataSprite", "ParticleModuleTypeDataLight",
]);

function cascadeModules(emitter: DumpExport, byIndex: (index: number) => DumpExport | undefined): DumpExport[] {
  const lodRefs = liveObjectRefs(emitter, "LODLevels");
  const lod = lodRefs[0] !== undefined ? byIndex(lodRefs[0].Index) : undefined;
  const properties = lod?.properties;
  const modules: DumpExport[] = [];
  for (const name of ["RequiredModule", "SpawnModule", "TypeDataModule"]) {
    const ref = objectRefOf(property(properties, name));
    const exported = ref === undefined ? undefined : byIndex(ref.Index);
    if (exported !== undefined) modules.push(exported);
  }
  for (const ref of liveObjectRefs(lod, "Modules")) {
    const exported = byIndex(ref.Index);
    if (exported !== undefined) modules.push(exported);
  }
  return modules;
}

const NIAGARA_RENDERERS: Readonly<Record<string, string>> = {
  NiagaraSpriteRendererProperties: "sprite",
  NiagaraMeshRendererProperties: "mesh",
  NiagaraRibbonRendererProperties: "ribbon",
  NiagaraLightRendererProperties: "light",
  NiagaraComponentRendererProperties: "mesh",
  NiagaraDecalRendererProperties: "sprite",
};

const NIAGARA_MAPPED_MODULES = new Set([
  "SpawnRate", "SpawnBurstInstantaneous", "InitializeParticle",
  "ColorFromCurve", "ScaleSpriteSize", "SolveForcesAndVelocity",
  "GravityForce", "DragForce", "Drag",
]);

function niagaraHandles(
  system: DumpExport,
  byIndex: (index: number) => DumpExport | undefined,
): { emitter: DumpExport; versionGuid: string | undefined }[] {
  const handles: { emitter: DumpExport; versionGuid: string | undefined }[] = [];
  for (const element of elementsOf(property(system.properties, "EmitterHandles"))) {
    const handleFields = fieldsOfValue(element);
    const versioned = fieldsOfValue(fieldOf(handleFields, "VersionedInstance"));
    const emitter = byIndex(objectRefOf(fieldOf(versioned, "Emitter"))?.Index ?? 0);
    if (emitter === undefined) continue;
    handles.push({ emitter, versionGuid: guidOf(fieldOf(versioned, "Version")) });
  }
  return handles;
}

function niagaraEmitterData(emitter: DumpExport, versionGuid: string | undefined): RawFields | undefined {
  const versionData = elementsOf(property(emitter.properties, "VersionData"));
  for (const element of versionData) {
    const fields = fieldsOfValue(element);
    if (fields === undefined) continue;
    if (versionGuid !== undefined && guidOf(fieldOf(fields, "Version")) === versionGuid) return fields;
  }
  const last = versionData[versionData.length - 1];
  return last === undefined ? undefined : fieldsOfValue(last);
}

function niagaraScripts(
  dataFields: RawFields | undefined,
  byIndex: (index: number) => DumpExport | undefined,
): DumpExport[] {
  const scripts: DumpExport[] = [];
  for (const property of ["SpawnScriptProps", "UpdateScriptProps", "EmitterSpawnScriptProps", "EmitterUpdateScriptProps"]) {
    const ref = objectRefOf(fieldOf(fieldsOfValue(fieldOf(dataFields, property)), "Script"));
    const script = ref === undefined ? undefined : byIndex(ref.Index);
    if (script !== undefined) scripts.push(script);
  }
  return scripts;
}

const RIP_WIDTHS: Readonly<Record<string, number>> = {
  Gravity: 12, Position: 12, "Position Offset": 12, "Rotational Force": 12, "Rotational Velocity": 12,
  "Color Minimum": 16, "Color Maximum": 16, "Initial Sprite Size": 8, "Initial Velocity": 12,
  "Mesh Orientation": 16, "Scale RGB": 12, "Scale RGBA": 16,
  Drag: 4, "Rotational Drag": 4, "Lifetime Min": 4, "Lifetime Max": 4, "Mass Min": 4, "Mass Max": 4,
  "Uniform Sprite Size Min": 4, "Uniform Sprite Size Max": 4,
  "Sprite Rotation Angle Min": 4, "Sprite Rotation Angle Max": 4,
  "Acceleration Limit": 4, "Speed Limit": 4, "Uniform Curve Index": 4,
};

interface RawRipEntry {
  readonly name: string;
  readonly offset: number;
  readonly width: number;
  readonly bytes: readonly number[];
}

function rawRapidIteration(script: DumpExport): RawRipEntry[] {
  const store = property(script.properties, "RapidIterationParameters");
  const fields = fieldsOfValue(store);
  if (fields === undefined) return [];
  const bytes: number[] = [];
  for (const element of elementsOf(fieldOf(fields, "ParameterData"))) {
    const value = scalarOf(element);
    if (value !== undefined) bytes.push(value & 0xff);
  }
  const offsets: { name: string; offset: number }[] = [];
  for (const element of elementsOf(fieldOf(fields, "SortedParameterOffsets"))) {
    const entryFields = fieldsOfValue(element);
    if (entryFields === undefined) continue;
    const name = stringOf(fieldOf(entryFields, "Name"));
    const offset = scalarOf(fieldOf(entryFields, "Offset"));
    if (name === undefined || offset === undefined) continue;
    offsets.push({ name, offset });
  }
  offsets.sort((left, right) => left.offset - right.offset);
  const entries: RawRipEntry[] = [];
  for (let index = 0; index < offsets.length; index++) {
    const current = offsets[index]!;
    const nextOffset = index + 1 < offsets.length ? offsets[index + 1]!.offset : bytes.length;
    const width = nextOffset - current.offset;
    if (width < 0 || current.offset + width > bytes.length) continue;
    entries.push({ name: current.name, offset: current.offset, width, bytes });
  }
  return entries;
}

function rawRipStore(scripts: readonly DumpExport[]): Map<string, RawRipEntry> {
  const store = new Map<string, RawRipEntry>();
  for (const script of scripts) {
    for (const entry of rawRapidIteration(script)) {
      if (!store.has(entry.name)) store.set(entry.name, entry);
    }
  }
  return store;
}

function rawEntryValues(entry: RawRipEntry): number[] {
  const bytes = Uint8Array.from(entry.bytes);
  const view = new DataView(bytes.buffer);
  const integer = entry.name.endsWith(".Spawn Count");
  if (entry.width < 4) return entry.width > 0 ? [bytes[entry.offset]!] : [];
  return Array.from({ length: Math.floor(entry.width / 4) }, (_, index) =>
    integer ? view.getInt32(entry.offset + index * 4, true) : view.getFloat32(entry.offset + index * 4, true));
}

function assertMappedInputs(emitter: EffectEmitter, store: Map<string, RawRipEntry>, prefix: string): void {
  const consumed = new Set<string>();
  const input = (suffix: string): RawRipEntry | undefined => store.get(`${prefix}${suffix}`);
  const consume = (...entries: (RawRipEntry | undefined)[]): void => {
    for (const entry of entries) if (entry) consumed.add(entry.name);
  };
  const check = (channel: EffectChannel | undefined | null, min: RawRipEntry | undefined,
    max: RawRipEntry | undefined, components = 1, scale = 1): void => {
    if (!min || !max) {
      expect(channel == null).toBe(true);
      return;
    }
    expect(channel?.kind, min.name).toBe("range");
    if (channel?.kind !== "range") throw new Error(`Expected a range for ${min.name}`);
    for (const [actual, raw] of [[channel.min, min], [channel.max, max]] as const) {
      const expected = rawEntryValues(raw).slice(0, components).map((value) => value * scale);
      const lanes = Array.isArray(actual) ? actual : [actual];
      expect(lanes.length, raw.name).toBe(components);
      expect(expected.length, raw.name).toBe(components);
      lanes.forEach((lane, index) => expect(lane, `${raw.name}[${index}]`).toBeCloseTo(expected[index]!, 5));
    }
    consume(min, max);
  };
  check(emitter.init?.lifetime, input("InitializeParticle.Lifetime Min"), input("InitializeParticle.Lifetime Max"));
  check(emitter.init?.size, input("InitializeParticle.Uniform Sprite Size Min"), input("InitializeParticle.Uniform Sprite Size Max"));
  check(emitter.init?.rotation, input("InitializeParticle.Sprite Rotation Angle Min"), input("InitializeParticle.Sprite Rotation Angle Max"), 1, Math.PI / 180);
  check(emitter.init?.color, input("InitializeParticle.Color Minimum"), input("InitializeParticle.Color Maximum"), 3);
  for (const [channel, suffix, components] of [
    [emitter.init?.velocity, "InitializeParticle.Initial Velocity", 3],
    [emitter.forces?.acceleration, "GravityForce.Gravity", 3],
    [emitter.forces?.accelerationLimit, "SolveForcesAndVelocity.Acceleration Limit", 1],
    [emitter.forces?.speedLimit, "SolveForcesAndVelocity.Speed Limit", 1],
  ] as const) check(channel, input(suffix), input(suffix), components);
  const drag = input("Drag.Drag") ?? input("DragForce.Drag");
  check(emitter.forces?.drag, drag, drag);
  const rate = input("SpawnRate.Spawn Rate") ?? input("SpawnRate.Rate");
  check(emitter.spawn?.rate, rate, rate);
  const count = input("SpawnBurstInstantaneous.Spawn Count");
  const time = input("SpawnBurstInstantaneous.Spawn Time");
  expect(emitter.spawn?.bursts).toEqual(count ? [{
    count: rawEntryValues(count)[0], time: time ? rawEntryValues(time)[0] : 0,
  }] : []);
  if (count) consume(count, time);
  for (const name of store.keys()) {
    if (!name.startsWith(prefix) || consumed.has(name)) continue;
    const rest = name.slice(prefix.length);
    const dot = rest.indexOf(".");
    if (dot <= 0 || !NIAGARA_MAPPED_MODULES.has(rest.slice(0, dot))) continue;
    expect(emitter.limitations).toContain(
      `Niagara module "${rest.slice(0, dot)}" is stored but its input "${rest.slice(dot + 1)}" is not exported`);
  }
}

interface CorpusImport {
  readonly outputDir: string;
  readonly report: Awaited<ReturnType<typeof importUnrealDirectory>>;
  readonly dump: EffectsDump;
}

async function importSlice(sliceDir: string, label: string, cleanups: (() => Promise<void>)[]): Promise<CorpusImport> {
  const info = await stat(sliceDir).catch(() => undefined);
  if (info === undefined || !info.isDirectory()) {
    throw new Error(
      `PRD-584 corpus slice "${label}" is missing at ${sliceDir}; the corpus directory is set but the slice is not present`,
    );
  }
  const converterPath = process.env.THREENATIVE_MODERN_UNREAL_CONVERTER_PATH?.trim();
  if (!converterPath) throw new Error("PRD-584 corpus requires THREENATIVE_MODERN_UNREAL_CONVERTER_PATH pointing to the fresh private 584.4 executable");
  const environment = { ...childEnvironment(process.env), DOTNET_GCHeapHardLimit: "0x40000000" };
  const versionRun = await runBounded(converterPath, ["--version"], { timeoutMs: 30_000, environment });
  expect(versionRun.code, versionRun.stderr).toBe(0);
  const version = versionRun.stdout.trim();
  expect(version, "executed private converter identity").toBe("b4e95441+threenative.584.4");
  expect(version).toBe(CUE4PARSE_SOURCE.version);
  const root = await mkdtemp(join(tmpdir(), `effects-corpus-${label}-`));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const outputDir = join(root, "output");
  const slice = SLICES.find((entry) => entry.id === label)!;
  const report = await importUnrealDirectory({
    sourceDir: sliceDir,
    outputDir,
    engine: slice.engine,
    formatHint: slice.engine,
    graphBake: false,
    modernConverter: { name: "modern", path: converterPath, version },
    concurrency: 1,
    environment: { ...environment, THREENATIVE_UNREAL_CACHE_DIR: join(root, "cache") },
  });
  expect(report.reused, "fresh corpus output").toBe(false);
  expect(report.importer.version, "current public importer").toBe(117);
  expect(report.toolchain.modernConverter, "public import used the executed private converter").toBe(version);
  const dumpPath = join(root, "effects-dump.json");
  const dumped = await runBounded(converterPath, [sliceDir, "--dump-effects", dumpPath, "--engine", slice.engine], {
    cwd: root, timeoutMs: 30_000, maxOutputBytes: 64 * 1024 * 1024, environment,
  });
  expect(dumped.code, `${dumped.stdout}\n${dumped.stderr}`).toBe(0);
  const dump = effectsDumpSchema.parse(JSON.parse(await readFile(dumpPath, "utf8")));
  expect(dump.errors ?? [], "all effect packages decoded").toEqual([]);
  return { outputDir, report, dump };
}
