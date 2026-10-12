# PRD-596 — UE 5.4+ animation clips from the Sequencer data model

**Status:** IN PROGRESS
**Priority:** P1 — implementation committed in `b1d6011`; public-import evidence exists, with acceptance proof and parent inspection still pending.
**Complexity:** 3 (LOW) — 1–5 files (`src/unreal/cue4parse-adapter.ts`, `src/unreal/importer.ts`, a new evaluator), new module; risk override: none.
**Owner:** PRD-596 lane; parent owns final gates and sheet inspection
**Depends on:** None

## Context

Before `b1d6011`, an editor-source UE5 `AnimSequence` stored its bone tracks in a data model. The following describes the original gap. The converter read only the
conventional `UAnimDataModel.BoneAnimationTracks` (`PopulateFromDataModel`, `src/unreal/cue4parse-adapter.ts:2902`).
UE 5.2+ saves an `AnimationSequencerDataModel` instead: a `UMovieScene` whose `FKControlRig` parameter section
holds one transform per control as `FMovieSceneFloatChannel` keys. For that model `UnsupportedReason`
(`cue4parse-adapter.ts:3097`) writes "the clip's bone tracks are in a ControlRig/Sequencer MovieScene model the
importer does not evaluate", and the importer lists the clip under `failed` (`src/unreal/importer.ts:5717`) with its
`.clip.json` sidecar only.

Facts already established:
- Pinned CUE4Parse `b4e95441` has no class for `UMovieScene`, `AnimSequencerDataModel` or the ControlRig track and
  section. They load as generic tagged properties. `MovieSceneFloatChannel` and `MovieSceneDoubleChannel` do parse
  natively (`FScriptStruct.cs:138`, `FMovieSceneChannel.cs:11`: `Times`, `Values` with `Value`/`Tangent`/`InterpMode`/
  `TangentMode`, `DefaultValue`, `TickResolution`, pre/post extrapolation).
- Nothing in CUE4Parse evaluates a ControlRig. An `FKControlRig` is a direct per-bone mapping, so evaluating its
  channels is enough; a general Control Rig graph is out of scope.
- Engine source for the layout is now sparsely checked out in `/home/joao/projects/UnrealEngine-5.8.3`:
  `Engine/Plugins/Animation/AnimationData/Source/AnimationData/Private/AnimSequencerDataModel.{h,cpp}`,
  `Engine/Plugins/Animation/ControlRig/Source/ControlRig/{Public,Private}/Sequencer/MovieSceneControlRigParameter{Section,Track}.{h,cpp}`,
  `Engine/Source/Runtime/MovieScene/Public/Channels/MovieScene{Float,Double}Channel.h`. Source facts are recorded under Decisions.
- Real inputs: slices `game-anim-5.8` (required) and `game-anim-5.4` (optional) in `scripts/fab-slice.ts:66,125`.
  The gate `ue5-clips` (`tests/helpers/animation-corpus.ts:176`, assertion at :231) previously **required** a ControlRig
  unsupported reason in both; `b1d6011` inverts that assertion.

## Solution

1. Read the engine source for the exact layout: which section holds bone transforms, the control-name to bone-name
   rule, the channel order (translation, rotation as Euler degrees, scale), the rotation order, and the tick to frame
   conversion. Record each fact with its `path:line` under Decisions.
2. In the converter, when the model is an `AnimationSequencerDataModel`, read the FK parameter section's transform
   channels, evaluate them at every frame of the model's own `FrameRate` and `NumberOfFrames`, and fill
   `RawAnimationData`/`TrackToSkeletonMapTable` exactly as `PopulateFromDataModel` does. The existing PSA writer and
   `attachPsaAnimations` then run unchanged.
3. Channel evaluation follows `FMovieSceneFloatChannel` (constant, linear, cubic with auto/user/break tangents,
   weighted tangents, default value, extrapolation). A key mode or tangent weight the code does not support makes
   the clip Reported with that exact reason. Never write a bind pose as a clip.
4. Keep `UnsupportedReason` for a model that is not FK (a real Control Rig graph with no FK section).

Risk: euler order and tangent semantics give a plausible but wrong pose. The differential in AC-2 catches it.

## Acceptance Criteria

- [ ] AC-1 [local]: Importing the `game-anim-5.8` slice through `asset_import_unreal` exports its seed clips as GLB animations with moving bones, and the report lists no ControlRig reason for them. proof: `PRD583_ANIMATION_PROOF=/absolute/path/current-prd583-proof.json npx vitest run tests/fab-feature-corpus.test.ts -t ue5-clips` with the gate's ControlRig assertion inverted — Evidence: partial; [public 5.8 log](/home/joao/.cache/agent-dumps/prd-596-ue5-sequencer/raw/public-import58.log) records importer 118 / converter `b4e95441+threenative.584.5`, 8 models, 7 animation sidecars and 27 failed entries. Counts alone do not prove moving GLB bones; parent must run the current proof-index corpus gate and inspect failures.
- [ ] AC-2 [local]: A Sequencer-model clip matches an independent decode of the same clip within 0.5° per bone per frame. proof: differential gate beside `clip-differential` (`tests/helpers/animation-corpus.ts:236`) — Evidence: blocked on independent owner reference; authenticated library survey found no transition pair. See the owner-action section below. Remains unchecked.
- [x] AC-3 [local]: Each channel interpolation mode (constant, linear, cubic auto, cubic user, cubic break, weighted) evaluates to the engine's formula on synthetic keys, and an unsupported mode reports its reason. proof: `npx vitest run tests/unreal-sequencer-channels.test.ts` — Evidence: [scoped test log](/home/joao/.cache/agent-dumps/prd-596-ue5-sequencer/raw/sequencer-target-tests.log), exit 0 recorded by the worker: this suite plus compiled-converter and animation-import integration suites, 3 files passed, 9 tests passed / 1 skipped. Baseline-red evidence was not inspected in this bookkeeping pass.
- [ ] AC-4 [local]: The `game-anim-5.4` slice imports its seed clip the same way. proof: same gate as AC-1 over `gasp54` — Evidence: partial; [public 5.4 log](/home/joao/.cache/agent-dumps/prd-596-ue5-sequencer/raw/public-import54.log) records 2 models, 3 animation sidecars and 4 failed entries, same version pins. Parent corpus proof remains pending; sidecar counts alone are insufficient.
- [ ] AC-5 [local]: Before/after sheet of one 5.8 clip on the mannequin (several frames) is attached to the PR and inspected by eye. proof: PR comment link — Evidence: two generated after-only sheets listed below; no before sheet, PR attachment or eye inspection established in this pass. Parent inspection pending.
- [ ] AC-6 [local]: Repository gates pass on the final head. proof: `npm run typecheck`, `npm test`, `npm run test:leaks`, `npx vitest run tests/mcp-smoke.test.ts` — Evidence: parent is running all four gates on the delivery head; no duplicate run or final-head pass claimed here.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| UE5 Sequencer-model clips | `asset_import_unreal` → `importUnrealDirectory` → CUE4Parse `ExportClip` (`cue4parse-adapter.ts:3037`) → PSA → `attachPsaAnimations` (`src/unreal/psa.ts:294`) | `UnsupportedReason` stays only for a non-FK model | AC-1, AC-4 |

## Decisions

- 2026-10-12 (Claude): AC-2 reference source. First choice: a Fab listing that ships the same clips in a ≤ 5.1 artifact (conventional model, already Verified) and a ≥ 5.2 artifact (Sequencer model); compare the two exports. If no such pair is in the owner's library, use the engine's own evaluation exported once by the owner from the editor (then AC-2 moves under Blocked on with that owner action). Do not compare the evaluator with itself.
- 2026-10-12 (Claude): bump the converter build tag and `IMPORTER_VERSION`; update the four tests that pin `CUE4PARSE_SOURCE.version` and the ledger rows `AnimSequence` UE5.0–5.5 / UE5.6+ in `docs/unreal-format-support.md`.

## Recorded source facts

Official local source: `/home/joao/projects/UnrealEngine-5.8.3`, tag `5.8.3-release`,
commit `396c9f059903aed5fec78ecd3d437a40c6415368` (provenance from project instructions).
Paths below are relative to that checkout; exact ranges were inspected for this update.

- `Engine/Plugins/Animation/AnimationData/Source/AnimationData/Private/AnimSequencerDataModel.cpp:148–150,394–396`: transform parameter names map to bone names via `UFKControlRig::GetControlTargetName(..., ERigElementType::Bone)`.
- Same file `:310–342`: frame count derives from MovieScene playback range, keys are frames + 1, and model frame rate is MovieScene display rate. At `:1524`, sampling converts evaluation time to MovieScene tick resolution with `FFrameRate::TransformTime`.
- Same file `:1608–1642`: defaults take precedence in this evaluation path; otherwise channels evaluate through `EvaluateWithCache`. Translation and scale use XYZ; rotation channels are Roll, Pitch, Yaw and become `Rotator.Quaternion()`.
- `Engine/Plugins/Animation/ControlRig/Source/ControlRig/Private/Sequencer/MovieSceneControlRigParameterSection.cpp:1714–1731`: transform defaults use translation XYZ, rotation Roll/Pitch/Yaw, scale XYZ. These facts do not substitute for independent AC-2 pose proof.

## Local evidence and parent handoff

Public report JSONs (local licensed evidence; not committed):
[/tmp/prd596-public-import-54/import-report.json](/tmp/prd596-public-import-54/import-report.json) and
[/tmp/prd596-public-import-58/import-report.json](/tmp/prd596-public-import-58/import-report.json).
Their `animationClips` entries describe sidecars; the public logs' animation counts must not be presented as a moving-bone proof.
No current `PRD583_ANIMATION_PROOF` index was located in the bounded task pointers.
The baseline slice log is empty and supplies no before-import proof.

Generated sheets for parent visual inspection:
[/tmp/prd596-animation-sheet.png](/tmp/prd596-animation-sheet.png) (108069 bytes) and
[/tmp/prd596-animation-sheet-left.png](/tmp/prd596-animation-sheet-left.png) (70780 bytes).
Worker render commands in `~/.cache/agent-dumps/prd-596-ue5-sequencer/log.md:41–42` use
`/tmp/prd596-public-import-58/Models/SKM_UEFN_Mannequin.glb`, base and left lean pose clips,
at 0, 0.1, 0.2 and 1/3 seconds. Each corresponding render log reports four successful tiles and no failures.
These are after-only renders; neither sheet was inspected by eye during this document pass.
The parent must establish a before comparison, inspect the pictures, attach the evidence to the PR,
and finish corpus proof and repository gates before relocating this original PRD to `BLOCKED/requires-owner-action/`.

## Owner action remaining for AC-2

The authenticated owner-library survey succeeded; DBus is not the blocker. Matching older paths
in City Sample (383) and MetaHumans (19) were byte-identical across 5.1/5.2, so no independent
conventional-model/Sequencer-model pair was established. `/home/joao/UE58/Engine/Binaries/Linux/UnrealEditor`
exists but lacks core shared libraries (Core, CoreUObject, Engine and others), and the partial installation
cannot export the reference. No full engine setup/build is implied. Discovery is recorded in
`~/.cache/agent-dumps/prd-596-599/STATE.md` and the primary AFK log
`/home/joao/projects/threenative/threenative-asset-mcp/.afk/2026-10-12-prd-596-599.md`.

Owner supplies an independently decoded PSA/editor export of a UE5.4+ FK Sequencer clip with the
same skeleton and frame rate, or a ≤5.1 conventional-model artifact containing that same clip.
Resume with a current proof-index JSON:

```sh
PRD583_ANIMATION_PROOF=/absolute/path/current-prd583-proof.json \
PRD596_SEQUENCER_REFERENCE_PSA=/absolute/path/reference.psa \
FAB_FEATURE_CORPUS_DIR=/home/joao/.cache/threenative-asset-mcp/fab-slices \
THREENATIVE_TOOLCHAIN_DIR=/tmp/prd596-toolchain \
npx vitest run tests/fab-feature-corpus.test.ts -t sequencer-differential
```

Expected result: every compared bone key is within 0.5°; the gate reports maximum error.
Use the private converter recorded above; the worker STATE warns that the shared cache has a stale assembly.
AC-2 remains unchecked until this independent comparison passes.

## Execution Phases

#### Phase 1: Layout and channel evaluator
**Status:** IMPLEMENTED — scoped green test evidence recorded; independent pose proof remains open.
**Files:** new evaluator inside `src/unreal/cue4parse-adapter.ts` (the C# program is embedded there); `tests/unreal-sequencer-channels.test.ts`.
**Implementation:** Expand the sparse checkout with the paths in Context. Record the layout facts under Decisions. Implement channel evaluation and the Euler-to-quaternion step. Find the AC-2 reference pair (owner's library via `fab_list_owned`).
**Verification:** AC-3.

#### Phase 2: Converter and importer route
**Status:** IMPLEMENTED — public import evidence partial; AC-1/AC-4 parent proof pending, AC-2 owner input pending.
**Files:** `src/unreal/cue4parse-adapter.ts` (`ExportClip`, `UnsupportedReason`), `src/unreal/importer.ts` (version), `tests/helpers/animation-corpus.ts` (invert the ControlRig assertion, add the differential gate).
**Implementation:** Route a Sequencer-model clip through the evaluator into `RawAnimationData`. Keep the sidecar. Bump versions.
**Verification:** AC-1, AC-2, AC-4.

#### Phase 3: Evidence and ledger
**Status:** IN PROGRESS — ledger implementation committed; before/after inspection, PR attachment and final-head gates pending.
**Files:** `docs/unreal-format-support.md`, `README.md` import table.
**Implementation:** Sheets, ledger rows to Verified with pack, engine version, `IMPORTER_VERSION` and date.
**Verification:** AC-5, AC-6.
