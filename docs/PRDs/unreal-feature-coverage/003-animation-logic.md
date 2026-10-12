# PRD-583 — Import UE5 clips, blend spaces, aim offsets and montages

**Status:** IN PROGRESS — Phases 1–3 implemented; real-corpus and visual proofs wait on PRD-581 slices.
**Priority:** P2 — planned feature work: AC-1 to AC-7 are open. UE5 packs import skinned meshes with no animation at all, and no engine version exports blend spaces or montages.
**Complexity:** 5 (MEDIUM) — 1–5 implementation files (1), new animation-data module (+2), crosses the .NET converter / Node importer boundary (+2); risk override: none
**Owner:** João
**Depends on:** PRD-581 (corpus slices and `tests/fab-feature-corpus.test.ts`)

## Context

**Clips.** Animation clips export only through UE Viewer as ActorX PSA (`importer.ts:3892–3935`, attached by
`psa.ts`). UE Viewer cannot open UE5 packages, and the CUE4Parse adapter has no `UAnimSequence` code. So
**no UE5 clip is exported today**. The format ledger wrongly listed this as Implemented; it is corrected in
this PRD's first commit.

The 2026-10-11 probe found the UE5 bone-track storage changes across versions:

| Engine | Where bone tracks live | Where curves live |
|---|---|---|
| UE4 up to about UE5.2 | `UAnimSequence` raw data | `RawCurveData.FloatCurves[]` (typed `FRawCurveTracks`) |
| UE 5.0–5.5 | `UAnimDataModel.BoneAnimationTracks` | `UAnimDataModel` |
| UE 5.8 (verified) | an `FKControlRig` MovieScene model, about 322 KB per clip | a separate `AnimationSequencerDataModel` export, `Properties.LegacyCurveData.FloatCurves[]` |

**Logic assets.** Blend spaces, aim offsets and montages are **Missing**. Raw clips are content, and these
assets are the wiring that makes a character playable. Probe findings (verified on Game Animation Sample 5.8 and UE4.19):

- **BlendSpace, BlendSpace1D, AimOffsetBlendSpace.**
  - Everything is tagged. `SampleData[]` holds `{Animation, SampleValue, RateScale, bMirror}`, plus
    `BlendParameters[3]`, `InterpolationParam[3]` and `bLoop`.
  - The dump flattens the fixed array `BlendParameters[3]` into one object and omits defaults
    (`Min` 0, `Max` 100, `GridNum` 4). Read the typed `UBlendSpaceBase.BlendParameters`
    (`UBlendSpaceBase.cs:35`), never `Properties["BlendParameters"]`.
  - `GridSamples` and the UE5 `BlendSpaceData` are derived data: do not export them.
  - The 5.8 aim offset in Game Animation Sample is a plain `BlendSpace` with additive mesh-space samples.
    It is recognised by class name or by `bContainsRotationOffsetMeshSpaceSamples`.
- **AnimMontage, AnimComposite.**
  - Typed fields: `CompositeSections[]`, `SlotAnimTracks[].AnimTrack.AnimSegments[]`, `BlendIn/BlendOut`, `Notifies` (`FAnimNotifyEvent`).
  - A section start depends on `LinkMethod` (Absolute, Relative or Proportional), which needs resolving.
  - Blueprint notifies are identifiable only by class name; their behavior is bytecode.
- **AnimBlueprint** stays **Reported**: CUE4Parse reads it only as graph and bytecode.
- **PoseAsset** stays **Missing** in this PRD (see Decisions).

UE Viewer decodes none of the logic assets. CUE4Parse reads them for every engine version.

## Solution

**Consumer flow.**

1. `asset_import_unreal` → `importUnrealDirectory`.
2. The adapter writes UE5 clips into the skinned GLB as glTF animations, matching the PSA clip naming. It
   also writes `Animation/<asset>.json` for blend spaces, aim offsets, montages and composites, plus
   `<clip>.clip.json` for notifies, curves and sync markers.
3. `import-report.json` lists every asset and every unresolved clip reference.

In Three.js, an `AnimationMixer` plays the clips by name, and a game layer reads the JSON to choose weights,
sections and notifies.

**Outputs.**

| Asset | Shape (in `Animation/`) |
|---|---|
| Blend space | `{type: 1D\|2D\|aimOffset, axes: [{name, min, max, gridNum, wrap, snap}], samples: [{clip, pos, rateScale, mirror}], smoothing, loop, additive}` |
| Montage | `{length, rateScale, blendIn, blendOut, slots: [{name, segments: [{clip, startPos, clipStart, clipEnd, playRate, loops}]}], sections: [{name, start, next}], notifies: [{name, time, duration, track, kind, class}]}` |
| Composite | a montage with one slot and no sections |
| Clip sidecar | `{notifies, curves: [{name, keys: [{time, value, arrive, leave, interp}]}], syncMarkers}` |

Every `clip` value equals the name of an exported glTF animation, so a consumer never joins on Unreal paths.

**Risks.**

- **The 5.8 clip model.** Bone tracks may need CUE4Parse support for the ControlRig model, or a fallback.
  Phase 1 decides this with evidence before any logic asset depends on UE5 clips.
- Mirrored samples need a `MirrorDataTable`, and additive spaces need the base pose. Export the flags and report them; never guess.
- A referenced sequence that is missing from the import is reported, not dropped.

## Acceptance Criteria

- [ ] AC-1 [local]: Every `AnimSequence` in the Game Animation Sample slice becomes a glTF animation on the matching skinned GLB. Its duration equals `SequenceLength` within one frame, or it is listed in `import-report.json` with the reason (for example, an unsupported 5.6+ data model). proof: `FAB_FEATURE_CORPUS_DIR=… npx vitest run tests/fab-feature-corpus.test.ts -t ue5-clips` — Evidence: pending.
- [ ] AC-2 [local]: The same sequence exported from two different serializations agrees: the 5.4 and 5.8 artifacts of one Game Animation Sample clip match within 0.5° per joint per sampled frame. If 5.8 tracks are out of reach, the ASP 4.4 UE Viewer clip and its CUE4Parse export match instead, with the decision recorded. proof: `… tests/fab-feature-corpus.test.ts -t clip-differential` — Evidence: pending.
- [ ] AC-3 [local]: A synthetic blend space with omitted defaults exports `Min` 0, `Max` 100 and `GridNum` 4 on all three axes, read from the typed fixed array. The test is red with a `Properties`-based read. proof: `npx vitest run tests/unreal-animation-data.test.ts -t blendspace` — Evidence: GREEN locally (tests/unreal-animation-data.test.ts), and a compiled test reads a real 5.8 package (tests/unreal-animation-compiled.test.ts, THREENATIVE_ANIMATION_PROOF_PACK).
- [ ] AC-4 [local]: The 4.4, 4.22 and 5.8 slices export every BlendSpace, BlendSpace1D and aim offset. Axis ranges and sample positions equal the typed values, and every sample `clip` names an exported animation or a reported missing one. proof: `… tests/fab-feature-corpus.test.ts -t blendspaces` — Evidence: pending.
- [ ] AC-5 [local]: The 4.22 and 5.8 slices export every montage, with section starts resolved for each `LinkMethod`, slot segments naming exported clips, and notifies with time, duration and class. proof: `… tests/fab-feature-corpus.test.ts -t montages`, plus a synthetic Relative/Proportional section test in `tests/unreal-animation-data.test.ts` — Evidence: synthetic Relative/Proportional test GREEN locally; corpus proof pending PRD-581.
- [ ] AC-6 [local]: Clip sidecars carry notifies and float curves from both curve layouts (`RawCurveData` on 4.x, `LegacyCurveData` on 5.8), with key counts equal to the source. proof: `… tests/fab-feature-corpus.test.ts -t clip-curves` — Evidence: pending.
- [ ] AC-7 [local]: The ledger rows for UE5 `AnimSequence`, blend spaces, aim offsets, montages and composites move with evidence. Repository gates are green: `npm run typecheck`, `npm run test:leaks` with default workers, and `npx vitest run tests/mcp-smoke.test.ts`. proof: those commands and the ledger diff — Evidence: pending.
- [ ] AC-8 [local]: Every PR attaches before/after sheets per the epic `README.md` evidence rule. Before: UE5 skinned meshes in bind pose. After: frames at 0, 25, 50 and 75% of each clip, a blend-space grid of the sample poses, and montage section starts. Judge every frame (no blank, ghost or exploded pose). proof: the PR comment with sheets — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| UE5 clip export | `asset_import_unreal` → adapter `UAnimSequence` writer → skinned GLB animations (fill lines) | New. The UE Viewer PSA route stays for UE4. | AC-1, AC-2 |
| Animation logic JSON | same import; files under `Animation/` (fill lines) | New. These classes leave the skipped list. | AC-4, AC-5, AC-6 |

## Decisions

- 2026-10-11 (agent): PoseAsset is out of scope. Game Animation Sample uses it for pose search, which a Three.js consumer cannot use without that runtime. It stays Missing in the ledger. Reopen it if a pack uses pose assets for facial or corrective poses.
- 2026-10-11 (agent): no blend-space or montage runtime ships here. JSON plus named clips is the contract, and the playback layer belongs to `threenative-engine`.
- 2026-10-11 (agent): **UE5.6+ (verified on 5.8) clips are Reported, not exported.** A real Game Animation Sample 5.8 clip (`M_Neutral_Stand_Idle_Loop`: `NumFrames` 0, no `RawAnimationData`, no `CompressedDataStructure`) keeps its bone tracks in a `UFKControlRig` MovieScene model. The pinned CUE4Parse reader exposes no such track data, so the adapter reports the exact reason and writes no clip. A 5.0–5.5 clip uses `RawAnimationData`, `FUECompressedAnimData` or ACL and converts through the same `ConvertAnims` path as UE4.
- 2026-10-11 (agent): **AC-2 differential uses the ASP 4.4 UE Viewer/CUE4Parse pair when the PRD-581 slices are not yet present**, as AC-2 permits. The 5.4-vs-5.8 pair is added only if a 5.4 slice arrives; the 5.8 side cannot carry bone tracks today.

## Progress (2026-10-11, PRD-583 branch)

- Adapter (`src/unreal/cue4parse-adapter.ts`): `--animations` mode writes `Animation/<clip>.psa` for decodable clips and `Animation/<asset>.json` for blend spaces, aim offsets, montages and composites, with `FBlendParameter` defaults, `LinkMethod` section fields, notifies and curves. Unsupported clips carry a precise `unsupportedReason`.
- Importer (`src/unreal/importer.ts`): UE5 clips and all-version logic packages route to CUE4Parse (`hasAnimationLogic`, cooking hints); PSAs attach by bone name; normalized JSON and a `Animation/` output plus report fields `animationLogic`/`animationClips`.
- Pure logic (`src/unreal/animation-data.ts`) and tests (`tests/unreal-animation-data.test.ts`, 14 cases): AC-3 and the AC-5 synthetic Relative/Proportional proof are green locally.
- Compiled proof (`tests/unreal-animation-compiled.test.ts`): the shipped adapter program compiles against the installed CUE4Parse and, on a local 5.8 pack, reads typed `BlendParameters` with restored defaults.
- Pending: AC-1, AC-2, AC-4, AC-5 (corpus), AC-6, AC-8 (sheets) wait on the PRD-581 slices.

## Execution Phases

#### Phase 1: UE5 clips (prerequisite)
**Status:** IMPLEMENTED — 5.0–5.5 route via CUE4Parse; 5.6+ Reported. AC-1/AC-2 corpus proof pending PRD-581.
**Files:**
- `src/unreal/cue4parse-adapter.ts`: `UAnimSequence` export through CUE4Parse-Conversion, or the adapter's own track reader.
- `src/unreal/importer.ts`: route UE5 animation packages to CUE4Parse and attach the clips.
- `docs/unreal-format-support.md`: correct the UE5 `AnimSequence` row to Missing now, then move it on evidence.

**Implementation:**
1. Probe whether pinned CUE4Parse-Conversion exports 5.0–5.5 `UAnimDataModel` tracks and 5.8 ControlRig-model tracks.
2. Implement the supported models. Any unsupported model gets a precise report reason.
3. For the AC-2 differential, add a minimal 5.4 clip slice to PRD-581's corpus only if 5.8 tracks work; otherwise use the ASP pair.

**Verification:** AC-1, AC-2.

#### Phase 2: Blend spaces and aim offsets
**Status:** IMPLEMENTED — AC-3 local test green; AC-4 corpus proof pending PRD-581.
**Files:** adapter (blend-space writer), `src/unreal/animation-data.ts` (new: clip-name resolution and report), `tests/unreal-animation-data.test.ts` (new).
**Implementation:** Read the typed `BlendParameters` and `SampleData`, resolve each `Animation` reference to its exported clip name, and classify 1D, 2D or aim offset.
**Verification:** AC-3, AC-4.

#### Phase 3: Montages, composites, clip sidecars, ledger and gates
**Status:** IMPLEMENTED — AC-5 synthetic test green; AC-6 corpus and AC-8 sheets pending PRD-581.
**Files:** adapter (montage and clip-sidecar writers), `animation-data.ts`, ledger, `README.md` import table, tests.
**Implementation:**
- Resolve section starts for each `LinkMethod`.
- Export notifies with their class name, and mark Blueprint notifies as behavior not run.
- Read curves from either layout.

**Verification:** AC-5, AC-6, AC-7, AC-8 (sheets for every phase's PR).
