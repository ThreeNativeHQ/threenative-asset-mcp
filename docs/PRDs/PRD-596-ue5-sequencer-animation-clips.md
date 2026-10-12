# PRD-596 — UE 5.4+ animation clips from the Sequencer data model

**Status:** NOT STARTED
**Priority:** P1 — AC-1..AC-3 open: every clip of Game Animation Sample 5.4 (606 clips) and 5.8 imports as "Reported", so current Fab animation packs give no motion.
**Complexity:** 3 (LOW) — 1–5 files (`src/unreal/cue4parse-adapter.ts`, `src/unreal/importer.ts`, a new evaluator), new module; risk override: none.
**Owner:** unassigned
**Depends on:** None

## Context

An editor-source UE5 `AnimSequence` stores its bone tracks in a data model. The converter reads only the
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
- Engine source for the layout is tracked but not checked out in `/home/joao/projects/UnrealEngine-5.8.3`:
  `Engine/Plugins/Animation/AnimationData/Source/AnimationData/Private/AnimSequencerDataModel.{h,cpp}`,
  `Engine/Plugins/Animation/ControlRig/Source/ControlRig/{Public,Private}/Sequencer/MovieSceneControlRigParameter{Section,Track}.{h,cpp}`,
  `Engine/Source/Runtime/MovieScene/Public/Channels/MovieScene{Float,Double}Channel.h`. Add them to the sparse checkout.
- Real inputs: slices `game-anim-5.8` (required) and `game-anim-5.4` (optional) in `scripts/fab-slice.ts:66,125`.
  The gate `ue5-clips` (`tests/helpers/animation-corpus.ts:176`, assertion at :231) today **requires** a ControlRig
  unsupported reason in both; this PRD inverts that assertion.

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

- [ ] AC-1 [local]: Importing the `game-anim-5.8` slice through `asset_import_unreal` exports its seed clips as GLB animations with moving bones, and the report lists no ControlRig reason for them. proof: `PRD583_ANIMATION_PROOF=1 npx vitest run tests/fab-feature-corpus.test.ts -t ue5-clips` with the gate's ControlRig assertion inverted — Evidence: pending.
- [ ] AC-2 [local]: A Sequencer-model clip matches an independent decode of the same clip within 0.5° per bone per frame. proof: differential gate beside `clip-differential` (`tests/helpers/animation-corpus.ts:236`) — Evidence: pending. Reference source per the Decision rule below.
- [ ] AC-3 [local]: Each channel interpolation mode (constant, linear, cubic auto, cubic user, cubic break, weighted) evaluates to the engine's formula on synthetic keys, and an unsupported mode reports its reason. proof: `npx vitest run tests/unreal-sequencer-channels.test.ts` — Evidence: pending.
- [ ] AC-4 [local]: The `game-anim-5.4` slice imports its seed clip the same way. proof: same gate as AC-1 over `gasp54` — Evidence: pending.
- [ ] AC-5 [local]: Before/after sheet of one 5.8 clip on the mannequin (several frames) is attached to the PR and inspected by eye. proof: PR comment link — Evidence: pending.
- [ ] AC-6 [local]: Repository gates pass on the final head. proof: `npm run typecheck`, `npm test`, `npm run test:leaks`, `npx vitest run tests/mcp-smoke.test.ts` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| UE5 Sequencer-model clips | `asset_import_unreal` → `importUnrealDirectory` → CUE4Parse `ExportClip` (`cue4parse-adapter.ts:3037`) → PSA → `attachPsaAnimations` (`src/unreal/psa.ts:294`) | `UnsupportedReason` stays only for a non-FK model | AC-1, AC-4 |

## Decisions

- 2026-10-12 (Claude): AC-2 reference source. First choice: a Fab listing that ships the same clips in a ≤ 5.1 artifact (conventional model, already Verified) and a ≥ 5.2 artifact (Sequencer model); compare the two exports. If no such pair is in the owner's library, use the engine's own evaluation exported once by the owner from the editor (then AC-2 moves under Blocked on with that owner action). Do not compare the evaluator with itself.
- 2026-10-12 (Claude): bump the converter build tag and `IMPORTER_VERSION`; update the four tests that pin `CUE4PARSE_SOURCE.version` and the ledger rows `AnimSequence` UE5.0–5.5 / UE5.6+ in `docs/unreal-format-support.md`.

## Execution Phases

#### Phase 1: Layout and channel evaluator
**Status:** NOT STARTED
**Files:** new evaluator inside `src/unreal/cue4parse-adapter.ts` (the C# program is embedded there); `tests/unreal-sequencer-channels.test.ts`.
**Implementation:** Expand the sparse checkout with the paths in Context. Record the layout facts under Decisions. Implement channel evaluation and the Euler-to-quaternion step. Find the AC-2 reference pair (owner's library via `fab_list_owned`).
**Verification:** AC-3.

#### Phase 2: Converter and importer route
**Status:** NOT STARTED
**Files:** `src/unreal/cue4parse-adapter.ts` (`ExportClip`, `UnsupportedReason`), `src/unreal/importer.ts` (version), `tests/helpers/animation-corpus.ts` (invert the ControlRig assertion, add the differential gate).
**Implementation:** Route a Sequencer-model clip through the evaluator into `RawAnimationData`. Keep the sidecar. Bump versions.
**Verification:** AC-1, AC-2, AC-4.

#### Phase 3: Evidence and ledger
**Status:** NOT STARTED
**Files:** `docs/unreal-format-support.md`, `README.md` import table.
**Implementation:** Sheets, ledger rows to Verified with pack, engine version, `IMPORTER_VERSION` and date.
**Verification:** AC-5, AC-6.
