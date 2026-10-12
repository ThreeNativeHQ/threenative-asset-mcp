import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { NodeIO, type Document } from "@gltf-transform/core";
import { describe, it } from "vitest";

import {
  canonicalPackagePath, parseAnimationDescriptor, parseAnimationReference,
  type RawAnimationAsset, type NormalizedAnimationAsset, type NormalizedClipSidecar,
} from "../../src/unreal/animation-data.js";
import type { ImportReport, ImportedAnimationLogic, ImportedAnimationClip } from "../../src/unreal/importer.js";
import { parsePsa } from "../../src/unreal/psa.js";
import { angularErrorDegrees, compareAnimationDifferential } from "./animation-differential.js";

const AFTER = ["modern", "asp", "stickmanFull", "gasp58", "gasp54", "rawCurve", "legacyCurve"] as const;
type After = typeof AFTER[number];
interface ConverterProof { path: string; dll: string; version: string; dllHash: string }
/** Paths are relative to the index, unless absolute. No licensed identities belong in this helper. */
export interface AnimationCorpusProof {
  converter: ConverterProof;
  beforeConverter: ConverterProof;
  outputs: Record<After | "aspBefore", string>;
  nativeAspDir: string;
  nativeLogicDirs: Record<After, string>;
  curvePairs: readonly {
    sourcePropertiesJSONL: string;
    property: "RawCurveData" | "LegacyCurveData";
    package: string;
    name: string;
    sidecarPath: string;
    output: After;
  }[];
}
interface Output {
  dir: string;
  report: ImportReport;
  documents: Document[];
  native: RawAnimationAsset[];
  sidecars: Map<string, Sidecar>;
}
type Sidecar = NormalizedClipSidecar & { clip?: string; source?: string };
const run = promisify(execFile);
const key = (pkg: string, name: string): string => `${canonicalPackagePath(pkg).toLowerCase()}\0${name.toLowerCase()}`;
const json = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, "utf8")) as T;
function required(value: unknown, label: string): asserts value is string {
  assert(typeof value === "string" && value.trim().length > 0, `${label} is required`);
}
async function files(dir: string, suffix: string): Promise<string[]> {
  required(dir, "input directory");
  const entries = await readdir(dir, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    assert(!entry.isSymbolicLink(), `input symlink is not supported: ${join(dir, entry.name)}`);
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...await files(path, suffix));
    else if (entry.isFile() && path.endsWith(suffix)) result.push(path);
  }
  return result.sort();
}
function child(dir: string, file: string): string {
  required(file, "public artifact path");
  const path = resolve(dir, file);
  const rel = relative(dir, path);
  assert(!isAbsolute(file) && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`), `artifact escapes output: ${file}`);
  return path;
}
async function artifact<T>(out: Output, row: ImportedAnimationLogic | ImportedAnimationClip): Promise<T> {
  const bytes = await readFile(child(out.dir, row.json));
  assert.equal(bytes.length, row.bytes, `${row.json}: byte count`);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), row.sha256, `${row.json}: digest`);
  return JSON.parse(bytes.toString("utf8")) as T;
}
function matching<T extends { package: string; name: string }>(rows: readonly T[], raw: RawAnimationAsset): T {
  const matches = rows.filter((row) => key(row.package, row.name) === key(raw.package!, raw.name!));
  assert.equal(matches.length, 1, `${raw.package}.${raw.name}: exactly one canonical public row required`);
  return matches[0]!;
}
function animations(out: Output): Set<string> {
  return new Set(out.documents.flatMap((doc) => doc.getRoot().listAnimations().map((clip) => clip.getName())));
}
function issue(out: Output, raw: RawAnimationAsset, reason: string): void {
  required(reason, `${raw.name}: unsupported reason`);
  assert(reason.length > 12 && !/^(unsupported|failed|unknown|no animation)$/i.test(reason), `${raw.name}: imprecise reason`);
  assert(out.report.failed.some((row) => canonicalPackagePath(row.package) === canonicalPackagePath(raw.package!) && row.reason.includes(reason)), `${raw.name}: missing matching package failure: ${reason}`);
}
function reference(out: Output, asset: ImportedAnimationLogic, source: string | undefined, clip: string, unresolved?: string): void {
  required(source, `${asset.name}: native animation reference`);
  const ref = parseAnimationReference(source);
  const sidecars = out.report.animationClips.filter((row) => {
    const samePackage = !ref.package || canonicalPackagePath(row.package).toLowerCase() === ref.package.toLowerCase();
    return samePackage;
  });
  if (unresolved !== undefined) {
    required(unresolved, `${source}: unresolved reason`);
    assert(unresolved.length > 12, `${source}: imprecise issue`);
    assert(asset.unresolvedClips.some((row) => row.clip === clip && row.reason === unresolved), `${source}: missing public unresolved issue`);
  } else {
    assert(animations(out).has(clip), `${source}: no actual GLB animation ${clip}`);
    assert(asset.resolvedClips.includes(clip), `${source}: absent from public resolved clips`);
    assert(sidecars.some((row) => {
      const sidecar = out.sidecars.get(row.json);
      return sidecar?.clip === clip && (sidecar.source ?? sidecar.clip)?.toLowerCase() === ref.name.toLowerCase();
    }), `${source}: resolved clip has no matching canonical source identity`);
  }
}

/** Registers five local licensed-corpus gates; never imports or manufactures proof inputs. */
export function registerAnimationCorpusGates(): void {
  describe("PRD-583 animation corpus", () => {
    let loaded: Promise<{ proof: AnimationCorpusProof; outputs: Record<After | "aspBefore", Output>; path: (value: string) => string }> | undefined;
    const load = () => loaded ??= (async () => {
      required(process.env.PRD583_ANIMATION_PROOF, "PRD583_ANIMATION_PROOF (JSON index path)");
      const indexPath = resolve(process.env.PRD583_ANIMATION_PROOF);
      const proof = await json<AnimationCorpusProof>(indexPath);
      const path = (value: string): string => { required(value, "index path"); return resolve(dirname(indexPath), value); };
      for (const [converter, expected] of [[proof.converter, "89-animation"], [proof.beforeConverter, "86-gameplay"]] as const) {
        assert(converter, `converter ${expected} is required`);
        required(converter.version, "converter version");
        assert.match(converter.version, new RegExp(`threenative\\.${expected}\\b`));
        assert.match(converter.dllHash, /^[a-f0-9]{64}$/);
        const actual = (await run(path(converter.path), ["--version"], { timeout: 30_000, maxBuffer: 1024 * 1024 })).stdout.trim();
        assert.equal(actual, converter.version, `current ${expected} binary --version differs`);
        assert.equal(createHash("sha256").update(await readFile(path(converter.dll))).digest("hex"), converter.dllHash, `${expected}: DLL hash differs`);
      }
      const outputs = {} as Record<After | "aspBefore", Output>;
      for (const id of [...AFTER, "aspBefore"] as const) {
        const dir = path(proof.outputs[id]);
        const report = await json<ImportReport>(join(dir, "import-report.json"));
        assert.equal(report.importer.version, id === "aspBefore" ? 115 : 116, `${id}: importer version`);
        assert.equal(report.reused, false, `${id}: cached proof is forbidden`);
        assert.equal(report.toolchain.modernConverter, (id === "aspBefore" ? proof.beforeConverter : proof.converter).version.replace(/^\S+\s+/, ""), `${id}: converter provenance`);
        assert(id === "legacyCurve" || report.models.length > 0, `${id}: no public models`);
        const documents: Document[] = [];
        for (const model of report.models) documents.push(await new NodeIO().read(child(dir, model.glb)));
        const native: RawAnimationAsset[] = [];
        if (id !== "aspBefore") {
          const paths = await files(path(proof.nativeLogicDirs[id]), ".json");
          assert(paths.length > 0, `${id}: native typed animation JSON is missing`);
          for (const file of paths) {
            const parsed = parseAnimationDescriptor(await json(file));
            assert(parsed.descriptor, `${file}: ${parsed.reason}`);
            native.push(parsed.descriptor);
          }
          assert.equal(new Set(native.map((raw) => key(raw.package!, raw.name!))).size, native.length, `${id}: duplicate native identities`);
        }
        const out: Output = { dir, report, documents, native, sidecars: new Map() };
        if (id !== "aspBefore") {
          for (const row of report.animationClips) out.sidecars.set(row.json, await artifact<Sidecar>(out, row));
        }
        outputs[id] = out;
      }
      assert((await files(path(proof.nativeAspDir), ".psa")).length > 0, "native ASP PSAs missing");
      assert.equal(proof.curvePairs.length, 2, "two independent curve pairs required");
      assert.deepEqual(proof.curvePairs.map((pair) => pair.property).sort(), ["LegacyCurveData", "RawCurveData"]);
      for (const pair of proof.curvePairs) {
        assert(AFTER.includes(pair.output), "curve pair output is invalid");
        assert((await stat(path(pair.sourcePropertiesJSONL))).size > 0, "independent curve properties are empty");
        assert((await stat(path(pair.sidecarPath))).size > 0, "promoted curve sidecar is empty");
      }
      return { proof, outputs, path };
    })();
    const gate = (name: string, test: () => Promise<void>): void => {
      it(name, async (context) => {
        if (!process.env.FAB_FEATURE_CORPUS_DIR?.trim()) {
          context.skip("local licensed inputs require FAB_FEATURE_CORPUS_DIR");
          return;
        }
        await test();
      }, 120_000);
    };

    gate("ue5-clips", async () => {
      const { outputs } = await load();
      let modernClips = 0;
      for (const id of ["modern", "gasp54", "gasp58"] as const) {
        const out = outputs[id];
        const clips = out.native.filter((raw) => raw.kind === "clip" && raw.className === "AnimSequence");
        assert(clips.length > 0, `${id}: native AnimSequences missing`);
        if (id === "modern") assert.equal(clips.length, 2, "UE5.0 selection must contain exactly two clips");
        let movingClips = 0;
        for (const raw of clips) {
          const rows = out.report.animationClips.filter((row) => canonicalPackagePath(row.package) === canonicalPackagePath(raw.package!));
          const failure = out.report.failed.find((row) => canonicalPackagePath(row.package) === canonicalPackagePath(raw.package!));
          assert.equal(rows.length, 1, `${raw.package}: exactly one exported animation sidecar is required; converter reason: ${failure?.reason ?? raw.unsupportedReason ?? "no sidecar"}`);
          const sidecar = await artifact<Sidecar>(out, rows[0]!);
          assert(!sidecar.unsupportedReason, `${raw.package}: converter reported unsupportedReason: ${sidecar.unsupportedReason}`);
          assert.equal(sidecar.source ?? sidecar.clip, raw.name);
          required(sidecar.clip, `${raw.name}: exported clip identity`);
          const matches = out.documents.flatMap((doc) => doc.getRoot().listAnimations().filter((clip) => clip.getName() === sidecar.clip).map((clip) => ({ doc, clip })));
          assert(matches.length > 0, `${raw.name}: metadata-only motion proof`);
          let clipMoving = false;
          for (const { doc, clip } of matches) {
            const bound = doc.getRoot().listNodes().filter((node) => node.getSkin() && node.getMesh()?.listPrimitives().some((p) => (p.getAttribute("POSITION")?.getCount() ?? 0) > 0));
            assert(bound.length > 0, `${raw.name}: no bound skinned geometry`);
            const joints = new Set(bound.flatMap((node) => node.getSkin()!.listJoints()));
            let moving = false;
            let duration = 0;
            let frame = Infinity;
            for (const channel of clip.listChannels()) {
              const sampler = channel.getSampler();
              const times = sampler?.getInput()?.getArray();
              const values = sampler?.getOutput()?.getArray();
              assert(times && values && times.length > 0, `${raw.name}: empty sampler`);
              for (let i = 0; i < times.length; i++) {
                assert(Number.isFinite(times[i]));
                duration = Math.max(duration, times[i]!);
                if (i > 0 && times[i]! > times[i - 1]!) frame = Math.min(frame, times[i]! - times[i - 1]!);
              }
              if (channel.getTargetPath() !== "rotation" || !joints.has(channel.getTargetNode()!)) continue;
              assert.equal(values.length, times.length * 4);
              for (let i = 1; i < times.length; i++) {
                if (angularErrorDegrees([values[0]!, values[1]!, values[2]!, values[3]!], [values[i * 4]!, values[i * 4 + 1]!, values[i * 4 + 2]!, values[i * 4 + 3]!]) > 0.01) moving = true;
              }
            }
            assert(duration > 0 && Number.isFinite(frame), `${raw.name}: finite animation timing required`);
            clipMoving ||= moving;
            // The native clip descriptor reports `timing.duration` for UE5 data models and `animLength` elsewhere.
            const nativeLength = raw.animLength ?? (raw as { timing?: { duration?: number } }).timing?.duration;
            assert(typeof nativeLength === "number" && nativeLength > 0, `${raw.name}: native timing missing`);
            assert(Math.abs(duration - nativeLength) <= frame + 1e-6, `${raw.name}: duration differs by more than one frame`);
          }
          if (clipMoving) movingClips++;
          if (id === "modern") modernClips++;
        }
        if (id === "gasp54" || id === "gasp58") assert(movingClips > 0, `${id}: no selected clip carries genuine bound-bone motion`);
      }
      assert.equal(modernClips, 2, "selected UE5.0 body proof needs two actual walk clips");
    });

    gate("sequencer-differential", async () => {
      const referencePath = process.env.PRD596_SEQUENCER_REFERENCE_PSA?.trim();
      if (!referencePath) throw new Error("AC-2 is blocked: provide an independently decoded PSA at PRD596_SEQUENCER_REFERENCE_PSA");
      const { outputs } = await load();
      const source = parsePsa(await readFile(resolve(referencePath)));
      const out = outputs.gasp58;
      let comparedKeys = 0;
      let maximum = 0;
      for (const sequence of source.sequences) {
        const documents = out.documents.filter((doc) => doc.getRoot().listAnimations().some((clip) => clip.getName() === sequence.name));
        assert.equal(documents.length, 1, `${sequence.name}: exactly one Sequencer GLB is required`);
        const result = compareAnimationDifferential(documents[0]!, { bones: source.bones, sequences: [sequence] }, { toleranceDegrees: 0.5 });
        assert.deepEqual(result.missing, [], `${sequence.name}: missing independent comparisons`);
        assert.deepEqual(result.errors, [], `${sequence.name}: independent angular errors`);
        assert(result.comparedKeys > 0 && result.maxErrorDegrees <= 0.5, `${sequence.name}: no independent keys or error exceeds 0.5 degrees`);
        comparedKeys += result.comparedKeys;
        maximum = Math.max(maximum, result.maxErrorDegrees);
      }
      console.info(`sequencer-differential: ${source.sequences.length} clip(s), ${comparedKeys} keys, max ${maximum.toFixed(6)} deg`);
    });

    gate("clip-differential", async () => {
      const { outputs, proof, path } = await load();
      const out = outputs.aspBefore;
      required(out.report.toolchain.umodel, "before public UE Viewer provenance");
      const sources = await Promise.all((await files(path(proof.nativeAspDir), ".psa")).map(async (file) => parsePsa(await readFile(file))));
      const sequences = sources.flatMap((source) => source.sequences);
      assert.equal(sequences.length, 13);
      assert.equal(new Set(sequences.map((sequence) => sequence.name)).size, 13);
      let keys = 0, bones = 0, maximum = 0;
      for (const source of sources) {
        assert.equal(source.bones.length, 68);
        for (const sequence of source.sequences) {
          assert.equal(sequence.tracks.length, 68);
          const docs = out.documents.filter((doc) => doc.getRoot().listAnimations().some((clip) => clip.getName() === sequence.name));
          assert.equal(docs.length, 1, `${sequence.name}: exactly one before public GLB required`);
          const result = compareAnimationDifferential(docs[0]!, { bones: source.bones, sequences: [sequence] }, { toleranceDegrees: 0.5 });
          assert.deepEqual(result.missing, [], `${sequence.name}: missing comparisons`);
          assert.deepEqual(result.errors, [], `${sequence.name}: angular errors`);
          assert.equal(result.comparedClips, 1);
          assert.equal(result.comparedBones, 68);
          assert.equal(result.comparedKeys, sequence.tracks.reduce((sum, track) => sum + track.times.length, 0));
          assert(result.comparedKeys > 0 && result.maxErrorDegrees <= 0.5);
          keys += result.comparedKeys; bones += result.comparedBones; maximum = Math.max(maximum, result.maxErrorDegrees);
        }
      }
      console.info(`clip-differential: 13 clips, 68 bones (${bones} clip/bone pairs), ${keys} keys, max ${maximum.toFixed(6)} deg`);
    });

    gate("blendspaces", async () => {
      const { outputs } = await load();
      let count = 0, resolved = 0;
      for (const id of AFTER) {
        const out = outputs[id];
        for (const raw of out.native.filter((raw) => raw.kind === "blendSpace")) {
          const row = matching(out.report.animationLogic, raw);
          const value = await artifact<NormalizedAnimationAsset>(out, row);
          assert.equal(value.kind, "blendSpace");
          assert(value.kind === "blendSpace");
          assert.equal(value.type, raw.blendSpaceType ?? "2D");
          assert.deepEqual(value.axes, Array.from({ length: 3 }, (_, i) => ({ name: raw.axes?.[i]?.displayName ?? "", min: raw.axes?.[i]?.min ?? 0, max: raw.axes?.[i]?.max ?? 100, gridNum: raw.axes?.[i]?.gridNum ?? 4, wrap: raw.axes?.[i]?.wrapInput ?? false, snap: raw.axes?.[i]?.snapToGrid ?? false })));
          assert.equal(value.loop, raw.loop ?? true);
          assert.equal(value.additive, raw.additive ?? raw.blendSpaceType === "aimOffset");
          assert((raw.samples?.length ?? 0) > 0, `${raw.name}: empty native space`);
          assert.equal(value.samples.length, raw.samples!.length);
          value.samples.forEach((sample, i) => {
            const native = raw.samples![i]!;
            assert.deepEqual(sample.pos, native.sampleValue ?? [0, 0, 0]);
            assert.equal(sample.mirror, native.mirror ?? false);
            assert.equal(sample.rateScale, native.rateScale ?? 1);
            reference(out, row, native.animation, sample.clip, sample.unresolved);
          });
          if (value.samples.some((sample) => sample.mirror) && !raw.mirrorDataTable) {
            assert(row.unresolvedClips.some((entry) => /MirrorDataTable/.test(entry.reason)), `${raw.name}: missing mirror dependency issue`);
          }
          if (value.additive && value.type !== "aimOffset" && !raw.previewBasePose) {
            assert(row.unresolvedClips.some((entry) => /base pose/.test(entry.reason)), `${raw.name}: missing additive dependency issue`);
          }
          if (value.samples.every((sample) => sample.unresolved === undefined) && row.unresolvedClips.length === 0) resolved++;
          count++;
        }
      }
      assert(count > 0 && resolved > 0, "need a fully resolved real native blend space");
    });

    gate("montages", async () => {
      const { outputs } = await load();
      const supported = outputs.stickmanFull.native.filter((raw) => raw.kind === "montage" && !raw.unsupportedReason);
      assert.equal(supported.length, 6, "full native montage proof requires six supported montages");
      for (const id of AFTER) {
        const out = outputs[id];
        for (const raw of out.native.filter((raw) => raw.kind === "montage")) {
          if (raw.unsupportedReason) { issue(out, raw, raw.unsupportedReason); continue; }
          const row = matching(out.report.animationLogic, raw);
          const value = await artifact<NormalizedAnimationAsset>(out, row);
          assert(value.kind === "montage");
          assert((raw.slots?.length ?? 0) > 0 && (raw.sections?.length ?? 0) > 0, `${raw.name}: native slots/sections missing`);
          assert.equal(value.slots.length, raw.slots!.length);
          value.slots.forEach((slot, i) => {
            const native = raw.slots![i]!;
            assert.equal(slot.name, native.name ?? "DefaultSlot");
            assert((native.segments?.length ?? 0) > 0);
            assert.equal(slot.segments.length, native.segments!.length);
            slot.segments.forEach((segment, j) => {
              const source = native.segments![j]!;
              assert.deepEqual([segment.startPos, segment.clipStart, segment.clipEnd, segment.playRate, segment.loops], [source.startPos ?? 0, source.clipStart ?? 0, source.clipEnd ?? 0, source.playRate ?? 1, source.loopCount ?? 1]);
              if (id === "stickmanFull") assert.equal(segment.unresolved, undefined);
              reference(out, row, source.animation, segment.clip, segment.unresolved);
            });
          });
          assert.deepEqual(value.sections, raw.sections!.map((section) => ({ name: section.name ?? "Default", next: section.next ?? "None", start: section.linkMethod === "Relative" ? (section.segmentBeginTime ?? 0) + (section.linkValue ?? 0) : section.linkMethod === "Proportional" ? (section.segmentBeginTime ?? 0) + (section.linkValue ?? 0) * (section.segmentLength ?? 0) : section.linkValue ?? 0 })));
          assert.deepEqual(value.notifies, (raw.notifies ?? []).map((notify) => ({ name: notify.name || notify.className || "AnimNotify", time: notify.time ?? 0, duration: notify.duration ?? 0, track: notify.track ?? 0, kind: notify.kind || "queued", class: notify.className || "AnimNotify" })));
        }
      }
    });

    gate("clip-curves", async () => {
      const { outputs, proof, path } = await load();
      for (const pair of proof.curvePairs) {
        const rows = (await readFile(path(pair.sourcePropertiesJSONL), "utf8")).split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line) as { export: string; property: string; value: { FloatCurves: { CurveName?: string; Name?: { DisplayName?: string }; FloatCurve: { Keys: { Time: number; Value: number }[] } }[] } });
        const source = rows.filter((row) => row.property === pair.property);
        assert.equal(source.length, 1, "independent source property must be unique");
        assert(pair.property === "LegacyCurveData" || source[0]!.export === pair.name, "independent clip export identity differs");
        const curves = source[0]!.value.FloatCurves?.map((curve) => ({ ...curve, CurveName: curve.CurveName ?? curve.Name?.DisplayName ?? "" }));
        assert(curves && curves.length > 0, `${pair.property}: independent source curves are empty`);
        assert.equal(new Set(curves.map((curve) => curve.CurveName)).size, curves.length);
        const out = outputs[pair.output];
        const candidates = out.report.animationClips.filter((row) => canonicalPackagePath(row.package) === canonicalPackagePath(pair.package) && (out.sidecars.get(row.json)?.source ?? out.sidecars.get(row.json)?.clip) === pair.name);
        assert.equal(candidates.length, 1, "curve source must match one promoted clip identity");
        const publicRow = candidates[0]!;
        assert.equal(path(pair.sidecarPath), child(out.dir, publicRow.json), "curve pair must name the actual promoted clip sidecar");
        const sidecar = await artifact<Sidecar>(out, publicRow);
        assert.equal(sidecar.curves.length, curves.length);
        assert.equal(new Set(sidecar.curves.map((curve) => curve.name)).size, curves.length);
        for (const curve of curves) {
          required(curve.CurveName, "source CurveName");
          assert(curve.FloatCurve.Keys.length > 0, `${curve.CurveName}: independent source has no keys`);
          const target = sidecar.curves.find((candidate) => candidate.name === curve.CurveName);
          assert(target, `${curve.CurveName}: missing production curve`);
          assert.equal(target.keys.length, curve.FloatCurve.Keys.length);
          curve.FloatCurve.Keys.forEach((sourceKey, i) => {
            assert(Number.isFinite(sourceKey.Time) && Number.isFinite(sourceKey.Value), "source curve key must be finite");
            assert.equal(Math.fround(target.keys[i]!.time), Math.fround(sourceKey.Time));
            assert.equal(Math.fround(target.keys[i]!.value), Math.fround(sourceKey.Value));
          });
        }
      }
    });
  });
}
