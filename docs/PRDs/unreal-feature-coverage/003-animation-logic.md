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
| UE 5.0–5.5 (cooked) | `UAnimSequence` compressed path (`RawAnimationData`, `FUECompressedAnimData` or ACL); the editor `UAnimDataModel.BoneAnimationTracks` is stripped when cooked | `UAnimDataModel` in the editor; the compressed curve streams in a cooked package |
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
- [ ] AC-2 [local]: The same sequence exported from two different serializations agrees: the 5.4 and 5.8 artifacts of one Game Animation Sample clip match within 0.5° per joint per sampled frame. If 5.8 tracks are out of reach, the ASP 4.4 UE Viewer clip and its CUE4Parse export match instead, with the decision recorded. proof: `… tests/fab-feature-corpus.test.ts -t clip-differential` — Evidence: ASP 4.4 pair GREEN locally: 13 clips, 68 bones, max 0.265° per bone per sampled frame (antipodal-aware, no basis tuning). Corpus test still pending PRD-581.
- [ ] AC-3 [local]: A synthetic blend space with omitted defaults exports `Min` 0, `Max` 100 and `GridNum` 4 on all three axes, read from the typed fixed array. The test is red with a `Properties`-based read. proof: `npx vitest run tests/unreal-animation-data.test.ts -t blendspace` — Evidence: GREEN locally (tests/unreal-animation-data.test.ts), and a compiled test reads a real 5.8 package (tests/unreal-animation-compiled.test.ts, THREENATIVE_ANIMATION_PROOF_PACK).
- [ ] AC-4 [local]: The 4.4, 4.22 and 5.8 slices export every BlendSpace, BlendSpace1D and aim offset. Axis ranges and sample positions equal the typed values, and every sample `clip` names an exported animation or a reported missing one. proof: `… tests/fab-feature-corpus.test.ts -t blendspaces` — Evidence: pending.
- [ ] AC-5 [local]: The 4.22 and 5.8 slices export every montage, with section starts resolved for each `LinkMethod`, slot segments naming exported clips, and notifies with time, duration and class. proof: `… tests/fab-feature-corpus.test.ts -t montages`, plus a synthetic Relative/Proportional section test in `tests/unreal-animation-data.test.ts` — Evidence: synthetic Relative/Proportional test GREEN locally; corpus proof pending PRD-581.
- [ ] AC-6 [local]: Clip sidecars carry notifies and float curves from both curve layouts (`RawCurveData` on 4.x, `LegacyCurveData` on 5.8), with key counts equal to the source. proof: `… tests/fab-feature-corpus.test.ts -t clip-curves` — Evidence: pending.
- [ ] AC-7 [local]: The ledger rows for UE5 `AnimSequence`, blend spaces, aim offsets, montages and composites move with evidence. Repository gates are green: `npm run typecheck`, `npm run test:leaks` with default workers, and `npx vitest run tests/mcp-smoke.test.ts`. proof: those commands and the ledger diff — Evidence: pending.
- [ ] AC-8 [local]: Every PR attaches before/after sheets per the epic `README.md` evidence rule. For a legacy (UE4) clip the before is the *same clip phase* rendered from the source, a like-for-like control — the six inspected legacy sheets are identical to their after, SSIM 1.0 on all 64 pairs — not a bind pose. After: frames at 0, 25, 50 and 75% of each clip, a blend-space grid of the sample poses, and montage section starts. Judge every frame (no blank, ghost or exploded pose). proof: the PR comment with sheets — Evidence: the six legacy sheets were inspected by the coordinator under `~/.cache/threenative-asset-mcp/prd583-ac8-final-legacy-neutral`; AC-8 stays open until the final fresh-cache screens and assets comment.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| UE5 clip export | `asset_import_unreal` → adapter `UAnimSequence` writer → skinned GLB animations (fill lines) | New. The UE Viewer PSA route stays for UE4. | AC-1, AC-2 |
| Animation logic JSON | same import; files under `Animation/` (fill lines) | New. These classes leave the skipped list. | AC-4, AC-5, AC-6 |

## Decisions

- 2026-10-11 (agent): PoseAsset is out of scope. Game Animation Sample uses it for pose search, which a Three.js consumer cannot use without that runtime. It stays Missing in the ledger. Reopen it if a pack uses pose assets for facial or corrective poses.
- 2026-10-11 (agent): no blend-space or montage runtime ships here. JSON plus named clips is the contract, and the playback layer belongs to `threenative-engine`.
- 2026-10-11 (agent): **UE5.6+ (verified on 5.8) clips are Reported, not exported.** A real Game Animation Sample 5.8 clip (`M_Neutral_Stand_Idle_Loop`: `NumFrames` 0, no `RawAnimationData`, no `CompressedDataStructure`) keeps its bone tracks in a `UFKControlRig` MovieScene model. The pinned CUE4Parse reader exposes no such track data, so the adapter reports the reason it finds in the package (a `DataModel` export, a `ControlRig` model, or `NumFrames`) rather than a blanket version claim, and writes no clip.
- 2026-10-11 (agent): **A 5.0–5.5 cooked clip uses `RawAnimationData`, `FUECompressedAnimData` or ACL and converts through the same `ConvertAnims` path as UE4.** Verified against the pinned source: `UAnimSequence.cs` deserialises only those three and `CUE4Parse-Conversion/Legacy/AnimConverter.cs` switches on `RawAnimationData` / `FUECompressedAnimData` / `FACLCompressedAnimData`. The pinned reader has no `UAnimDataModel.BoneAnimationTracks` mapping, so a cooked package's tracks cannot be in that editor model. A clip that reaches the adapter with none of the three is reported with its own evidence, not claimed supported.
- 2026-10-11 (agent): **AC-2 differential uses the ASP 4.4 UE Viewer/CUE4Parse pair when the PRD-581 slices are not yet present**, as AC-2 permits. The 5.4-vs-5.8 pair is added only if a 5.4 slice arrives; the 5.8 side cannot carry bone tracks today.
- 2026-10-11 (agent): **The pinned CUE4Parse animation exporter could not open the real UE4 corpus packages.** On the ASP 4.4 slice it aborted in `CUE4Parse-Conversion/AnimConverter.ConvertSequence` — `Trace.Assert(RawAnimationData.Length == Tracks.Capacity)` fired because the pinned `UAnimSequence` reader never populated the editor raw track map (`TrackToSkeletonMapTable`), so `GetNumTracks()` returned 0 while `RawAnimationData` held the editor tracks. The process died (exit 134) before any package wrote a descriptor, so the AC-2 CUE4Parse-vs-UE-Viewer differential had no data. **Root cause fixed**: the reader reads `BoneTreeIndex` from the tagged `TrackToSkeletonMapTable` struct fallbacks, and `ConvertSequence` maps by bone index for the tracks it carries instead of asserting. All-version logic descriptors and UE4 clips export again.
- 2026-10-11 (agent): **The real 5.4 Game Animation Sample clips use the Sequencer/ControlRig data model, not `UAnimDataModel.BoneAnimationTracks`.** Every one of the 606 clips in Game Animation Sample 5.4 stores its tracks in a `UAnimationSequencerDataModel` (`AnimationSequencerDataModel` export): a `UMovieScene` with a `UMovieSceneControlRigParameterTrack` and an `FKControlRig`. None of the 606 packages names `BoneAnimationTracks`, `RawAnimationData` or `CompressedDataStructure`. So Phase 1's UE5.0–5.5 `UAnimDataModel` mapping has no track data to read in this corpus, exactly as the 5.8 clip has none; the honest disposition is the ControlRig model, not a fabricated clip. A real Phase 1 proof needs a UE5.0–5.5 project saved through the plain `UAnimDataModel` workflow (no ControlRig/Sequencer editing), or a ControlRig evaluation, which stays out of scope.
- 2026-10-11 (agent): **AC-2 differential is real on the ASP 4.4 pair.** 13 clips, 68 bones each, compared at every frame: the CUE4Parse ActorX PSA export and the UE Viewer clips agree within **0.265°** per bone per sampled frame (antipodal-aware quaternion angle, no basis tuning). The earlier 150° gap was the empty track map: with the map read, every bone maps to its track. Local runner `/tmp/prd583-diff.mts` (not committed).
- 2026-10-11 (agent): **AC-8 support.** `renderTiles` gained an optional per-tile `sampling: { clip, timeSeconds }` that poses the model with a Three `AnimationMixer` after the rest-pose camera is fixed; a missing or ambiguous clip, an invalid time or a skinless model fails that tile rather than returning bind pose. A local `/tmp` runner reuses `renderTiles`/`judgeRender`/`preparePreviewPicture`, renders the base import's bind pose beside the head clip frames at 0/25/50/75% and judges each; the sheets for ASP 4.4 and stickman 4.22 are rendered and must be inspected by eye. The runner is local-only and is not committed.
- 2026-10-12 (agent): **The conventional UE5.0–5.5 `UAnimDataModel.BoneAnimationTracks` reader is implemented, source-backed, at converter `b4e95441+threenative.84-animation`.** The reader resolves the *exact* model for a clip — the sequence's `DataModel`/`DataModelInterface` property, or the editor-created export named `AnimDataModel` whose `Outer` is that sequence (`NewObject(this, "AnimDataModel")`) — and never the first export whose type merely contains "DataModel". It maps each `FBoneAnimationTrack` (`InternalTrackData`, `BoneTreeIndex`) into the same bone-indexed `RawAnimationData`/`TrackToSkeletonMapTable` route the UE4 converter already reads, with the model's own rational timing (`FrameRate.Numerator/Denominator`, `NumberOfFrames`; the endpoint is `NumberOfKeys = NumberOfFrames + 1`). `FRawAnimSequenceTrack` is read natively at or after `FUE5ReleaseStreamObjectVersion::RawAnimSequenceTrackSerializer` and as tagged `PosKeys`/`RotKeys`/`ScaleKeys` before it (the pinned `FScriptStruct` mapping is version-gated); the existing float widths (12/16 bytes) are kept. A ControlRig/Sequencer model is never accepted as the conventional model, so it stays explicit unsupported.
- 2026-10-12 (agent): **A malformed or unmapped raw track map is now a precise per-clip failure, not a silent rest pose.** `AnimConverter.ConvertSequence` validates the raw track map (non-empty, one entry per raw track, unique in-range `BoneTreeIndex`), throws `InvalidDataException` with the exact defect, and the adapter catches it per clip, so a bad clip is reported and the run continues. A missing tagged `BoneTreeIndex` is `INDEX_NONE` (`-1`), not bone 0. Legitimately sparse bones keep the rest pose only through a validated unique in-range mapping; no bind-pose PSA is fabricated. `tests/unreal-animation-data-model.test.ts` pins this and the reader in the shipped source; the real native decode is deferred to a serialized arm.
- 2026-10-12 (agent): **The 5.0–5.5 real-corpus proof is still open.** No executable package saved through the plain `UAnimDataModel` editor workflow is available in this checkout (the real 5.4 Game Animation Sample stores every clip in a `UAnimationSequencerDataModel`/`FKControlRig` model). AC-1 and Phase 1's real proof therefore stay open; the reader revision chose 84 to keep the converter revision unique for that later proof.
- 2026-10-12 (agent): **The legacy AC-8 control is the same clip phase, not a bind pose.** The legacy (UE4) before/after sheets compare each rendered clip frame against the *same clip frame* of the source, a like-for-like control: all 64 pairs are identical (SSIM 1.0). The 2026-10-11 note that the before is "the base import's bind pose" is corrected — a bind-pose before is not comparable to a posed after. The six sheets were inspected by the coordinator under `~/.cache/threenative-asset-mcp/prd583-ac8-final-legacy-neutral`; AC-8 stays open until the final fresh-cache screens and assets comment.
- 2026-10-12 (agent): **The 5.0–5.5 real-corpus proof now passes on a real conventional-model package, and it corrected the timing and the quaternion read, at converter `b4e95441+threenative.85-animation`.** A licensed MetaHuman Sample saved in UE 5.0.3 (`MM_Walk_Fwd`, header `-8/522/1004`, an `AnimDataModel` export, no `ControlRig`/`RawAnimationData`) was probed natively: its model reports `NumberOfFrames` 82, `NumberOfKeys` 83 and `PlayLength` 2.7333333 at `30/1`. The reader now sets `NumFrames` to `NumberOfKeys` and `SequenceLength` to `NumFrames / fps`, so the ActorX sampler emits one frame per key, samples the endpoint, and keeps the rate exactly `30/1`; it validates that each track array is 1 or `NumberOfKeys` long, rejects a `NumberOfKeys` that disagrees with `NumberOfFrames + 1`, and rejects a `PlayLength` that disagrees with the rational duration by more than one frame. Two runtime defects the source-only tests could not see were fixed: the tagged `FFrameRate` arrives as an `FScriptStruct`-wrapped `FStructFallback` whose omitted `Denominator` is the default 1 (not the fallback's 0), and both `Quat` and `Quat4f` tagged structs are `FQuat`, so `FQuat[]` is read before `TIntVector4<float>[]` (the old order returned a silently zero-filled array and dropped every rotation). The probe wrote `MM_Walk_Fwd.psa`: 354 bones, 83 frames at 30 fps, 52 bones with a varying rotation (max 0.227 quaternion delta) and varying translations. Limit: `CurveData.FloatCurves` is implemented, but this clip carries no `CurveData` and no `LegacyCurveData`, so the curve layout stays source-only; the AC-1 corpus proof still waits on PRD-581.

## Progress (2026-10-11, PRD-583 branch)

- Adapter (`src/unreal/cue4parse-adapter.ts`): `--animations` mode writes `Animation/<clip>.psa` for decodable clips and `Animation/<asset>.json` for blend spaces, aim offsets, montages and composites, with `FBlendParameter` defaults, `LinkMethod` section fields, notifies, curves and sync markers. Blend-space axes come from the typed `BlendParameters` fixed array (a raw-tag presence check restores only an omitted field); samples keep `bMirror`; `bLoop` defaults from the source; notifies use the resolved class with a `blueprint` kind. A clip with unsupported tracks still writes its sidecar and names the package evidence.
- Importer (`src/unreal/importer.ts`): UE5 clips and all-version logic packages route to CUE4Parse (`hasAnimationLogic`, cooking hints). Clip references resolve **after** the skeletal GLBs exist, against the animations that actually attached; a PSA no mesh accepted is reported for modern and legacy alike. The empty guard no longer trips on a logic-only package. Each modern animation package gets a precise failure when the converter exits nonzero, writes malformed JSON, or writes nothing.
- Pure logic (`src/unreal/animation-data.ts`) and tests (`tests/unreal-animation-data.test.ts`, 16 cases): AC-3, mirror/additive reporting, the unsupported-clip sidecar and the AC-5 synthetic Relative/Proportional proof are green locally.
- Compiled proof (`tests/unreal-animation-blend-axis.test.ts`, `tests/unreal-animation-compiled.test.ts`): the shipped adapter program compiles against the installed CUE4Parse; the axis reader is exercised on constructed typed axes (unequal axes, an omitted `Max`/`GridNum`, an unversioned typed-only axis with no raw tag, a raw tag that disagrees with the typed array), the dynamic `SampleData` array's second element arrives mirrored, and the notify class/kind derivation is exercised on resolved classes.
- Review fixes on this commit: `BlendAxis` restores a default only for a field the raw tag actually omitted, so an unversioned package keeps its typed values; `ExportBlendSpace` reads `bMirror` from the dynamic `SampleData` TArray's own elements rather than a per-`ArrayIndex` read that could never reach element 1; the clip-attachment map is keyed by clip and valued by the accepting mesh, so two rigs that share bone names warn while two LODs of one mesh do not (`tests/unreal-animation-attached-model.test.ts`).
- Root-cause fix (this commit): the pinned `UAnimSequence` reads the tagged `TrackToSkeletonMapTable` fallbacks into bone indices, and `AnimConverter.ConvertSequence` maps raw editor tracks by bone index (`trackIndex < RawAnimationData.Length`) instead of `Trace.Assert`, so the ASP 4.4 conversion no longer aborts the whole run. The converter's mesh empty guard no longer fires in `--animations` mode, so a package whose clips are all unsupported still writes its sidecars and exits 0. The ASP 4.4 pack now exports 13 PSAs + 13 clip sidecars + 2 blend-space descriptors, and the AC-2 differential against UE Viewer is 0.265° max. Trust boundary: `parseAnimationDescriptor` rejects a valid-JSON-but-wrong-shape document with a precise per-package reason before the importer accepts it as produced (`tests/unreal-animation-data.test.ts`, `tests/unreal-animation-import.integration.test.ts`, and the compiled `tests/unreal-animation-compiled.test.ts` reads a real UE4 PSA with non-constant bone quaternions and accepts a real 5.4 ControlRig clip's reported sidecar). Converter `b4e95441+threenative.83-animation`, importer 115.
- Renderer: `renderTiles` supports the per-tile `sampling` above; `tests/unreal-animation-render.test.ts` proves frames differ, a missing clip fails rather than returning bind pose, an unskinned model fails, and the default static render is unchanged (`tests/unreal-visual-regression.test.ts` goldens stay green).
- Pending: AC-1, AC-4, AC-5, AC-6 corpus proof waits on PRD-581's `tests/fab-feature-corpus.test.ts`. The UE5.0–5.5 conventional `UAnimDataModel` track reader is implemented and natively proven at converter `86-animation` on a real UE 5.0.3 MetaHuman Sample clip (`MM_Walk_Fwd`, 354 bones, 83 frames at 30 fps, endpoint sampled); the `CurveData` float-curve layout is implemented but that clip carries no curves, so it stays source-only. AC-8 sheets are rendered but need the parent's by-eye inspection.

## Execution Phases

#### Phase 1: UE5 clips (prerequisite)
**Status:** PARTIAL — cooked UE4/UE5 clips that carry `RawAnimationData`/compressed/ACL convert through CUE4Parse and match UE Viewer (ASP 4.4 differential 0.265°); the real 5.4 and 5.8 sample clips are Reported with package evidence (both use a `UAnimationSequencerDataModel`/ControlRig model, not `UAnimDataModel.BoneAnimationTracks`). The conventional UE5.0–5.5 `UAnimDataModel.BoneAnimationTracks` reader is implemented and natively proven at converter `86-animation`: a real UE 5.0.3 MetaHuman Sample `MM_Walk_Fwd` clip decodes to a 354-bone, 83-frame PSAs at 30 fps with the endpoint sampled (see the 2026-10-12 decision). AC-1 corpus proof pending PRD-581.
**Files:**
- `src/unreal/cue4parse-adapter.ts`: `UAnimSequence` export through CUE4Parse-Conversion, or the adapter's own track reader.
- `src/unreal/importer.ts`: route UE5 animation packages to CUE4Parse and attach the clips.
- `docs/unreal-format-support.md`: correct the UE5 `AnimSequence` row to Missing now, then move it on evidence.

**Implementation:**
1. Probe whether pinned CUE4Parse-Conversion exports 5.0–5.5 tracks and 5.8 ControlRig-model tracks. **Result (source- and corpus-verified):** the reader maps only `RawAnimationData`, `FUECompressedAnimData` and ACL; it has no `UAnimDataModel` mapping. The real Game Animation Sample 5.4 pack stores every clip in a `UAnimationSequencerDataModel` MovieScene/FKControlRig model, so there are no `BoneAnimationTracks`; a cooked clip's tracks are one of the three supported streams.
2. Implement the supported models. Any unsupported model gets a precise report reason drawn from the package's own evidence.
3. For the AC-2 differential, add a minimal 5.4 clip slice to PRD-581's corpus only if 5.8 tracks work; otherwise use the ASP pair. **Result:** 5.4 tracks are the ControlRig model, so the ASP 4.4 pair carries AC-2 (0.265° max).

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
