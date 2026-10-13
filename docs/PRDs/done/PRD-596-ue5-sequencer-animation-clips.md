# PRD-596 — UE 5.4+ animation clips from the Sequencer data model

**Status:** DONE — current-tag independent AC-2 and all four repository gates pass
**Priority:** P1 — selected UE5.4+ FK Sequencer clips import with bound motion; current-build independent comparison passes.
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
  The gate `ue5-clips` (`tests/helpers/animation-corpus.ts:194`) now requires one sidecar and one actual GLB
  animation per selected clip, finite sampler timing, bound skinned geometry, no unsupported reason, and genuine
  motion in both UE5.4 and UE5.8 fixtures; it reports the exact converter failure when a sidecar is absent.

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

- [x] AC-1 [local]: Importing the `game-anim-5.8` slice through `asset_import_unreal` exports its seed clips as GLB animations with moving bones, and the report lists no ControlRig reason for them. proof: `PRD583_ANIMATION_PROOF=/absolute/path/current-prd583-proof.json npx vitest run tests/fab-feature-corpus.test.ts -t ue5-clips` — Evidence: parent strict `ue5-clips` replay passed on implementation `80df0c3`, converter `.584.6.4`, importer119 (3.43s). All seven selected UE5.8 native AnimSequences have public sidecars without unsupported reasons, GLB animations bound to actual skinned geometry, finite timing within one frame, and genuine bound-bone motion across the selection. Consumed local index: `/home/joao/.cache/agent-dumps/prd-596-599/raw/current596-proof.json`; raw gate: `parent596-final64-corpus.log`.
- [x] AC-2 [local]: A Sequencer-model clip matches an independent decode of the same clip within 0.5° per serialized raw bone per frame; only independently declared generated virtual bones are excluded. proof: `sequencer-differential` — Current `c4e0ed1`, release 0.12.0 / importer124 / converter `.584.10.2` passes actual UE5.8.3 full-pose comparison: seven selected clips, eight GLB-document comparisons, 72,233/72,233 keys, zero missing keys or angular failures. Actual current maximum: 0.00026378151666186844°. Gate: `raw/596-102-independent-gate.log`, 1 passed in 9.13s; bounded direct replay of the existing comparison helper independently calculated these current counts and maximum. Only two actual T3D-declared mannequin virtuals are excluded (91/93 raw bones); all 875 face bones are compared in both face documents. The original raw additive-delta oracle remains unchanged.
- [x] AC-3 [local]: Each channel interpolation mode (constant, linear, cubic auto, cubic user, cubic break, weighted) evaluates to the engine's formula on synthetic keys, and an unsupported mode reports its reason. proof: `THREENATIVE_TOOLCHAIN_DIR=/tmp/prd596-toolchain npx vitest run tests/unreal-sequencer-channels.test.ts` — Evidence: metadata repair focused gate passes all six compiled shipped-helper tests on `.584.6.4`, including actual `ExportClip` reported Sequencer sidecar with native tagged notify/curve/sync-marker values; the metadata construction is shared before success/failure selection. Old code failed with empty `notifies` (five existing tests passed); logs: `raw/596-metadata-{red,green}.log`. Combined Sequencer/native metadata gates:13 passed (2.99s); typecheck and `git diff --check` passed. Prior evidence: all five compiled shipped-helper tests pass on `.584.6.3`: constant/linear/cubic/weighted/extrapolated formulas, scene-rate sampling, fractional whole-transform quaternion blend, omitted-denominator defaults with explicit invalid-rate rejection, and additive base-pose protection/restoration on success and failure. Red/green and deliberate Euler-blend mutation logs remain local under `raw/rates596-*` and `raw/parent596-rate-default-*`.
- [x] AC-4 [local]: The `game-anim-5.4` slice imports its seed clip the same way. proof: same gate as AC-1 over `gasp54` — Evidence: the same strict gate passed all325 selected native UE5.4 AnimSequences against325 public sidecars and8 model GLBs, requiring bound geometry, valid timing and genuine motion across the selection. The fresh public replay selected every prior clip and model while excluding unrelated standalone audio promotion; no animation was removed to make the gate pass.
- [x] AC-5 [local]: Before/after sheet of one 5.8 clip on the mannequin (several frames) is attached to the PR and inspected by eye. proof: PR comment link — Evidence: moving and additive-integrity sheets whose after-GLB SHA-256 matches final `.584.6.4` rendered with the production neutral renderer, inspected by the parent and attached in [PR49 comment](https://github.com/ThreeNativeHQ/threenative-asset-mcp/pull/49#issuecomment-6132085569). Before is pre-review `.584.5`, after GLB is byte-identical to final `.584.6.4`, at0.000/0.040/0.050s. The same rest-pose camera is retained; a moving foot can reach its boundary. Inspected PNGs are native GitHub attachments on that PR comment; licensed source packages remain local-only.
- [x] AC-6 [local]: Repository gates pass on the final implementation head `c4e0ed1` / importer124 / converter `.584.10.2`: typecheck passed; default suite 2,752 passed / 18 skipped in 192.84s; leak suite 2,752 passed / 18 skipped in 206.44s with clean temp output; packed MCP smoke 15 passed in 26.27s. Logs remain private under `/home/joao/.cache/agent-dumps/prd-596-599/raw/596-final102-{typecheck,test,leaks,smoke}.log`.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| UE5 Sequencer-model clips | `asset_import_unreal` → `importUnrealDirectory` → CUE4Parse `ExportClip` (`cue4parse-adapter.ts:3512, 3669`) → PSA → `attachPsaAnimations` (`src/unreal/psa.ts:294`) | Non-FK models and invalid rates remain Reported with an exact reason | AC-1, AC-4 |

## Decisions

- 2026-10-12 (current documentation closure): actual current AC-2 passes on `c4e0ed1` / `.584.10.2` / importer124; the independent owner blocker is resolved. Move this original PRD to `done/`; preserve AC-6 as pending until all four parent gates are observed green. Earlier BLOCKED decisions below describe their historical state.

- 2026-10-12 (final parent disposition): second and final independent review requested changes for discarded Sequencer metadata. Commit `80df0c3` repairs the sole finding; parent reviewed the actual diff and reran all four gates plus fresh2/325/7 real native/public clip proof. No third review or independent approval is claimed. Comparison GLB SHA-256 `d6840257fa629a876a6f56ba9ae7f53831d94f3bfcb354152e13fbdddf659090` is identical between the inspected sheet and final `.584.6.4`; local identity JSON records both paths. All internal criteria are complete. Only independent AC-2 remains blocked, so this original PRD moves to `BLOCKED/independent-animation-reference/`.


- 2026-10-12 (metadata repair): Complexity 1 → LOW; risk override none. Scope: `ExportClip`, existing compiled Sequencer harness, converter `.584.6.4` pins, README/format ledger and this PRD; importer119 stays unchanged. Read authored metadata once before the Sequencer early returns, using the actual resolved Sequencer model while retaining exact conventional-model curve discovery and ambiguity reporting. No sampling/additive behavior changes. Parent owns full gates, rebuild, public reimports and sheets; AC-6 reopened. AC-2 alone still requires an independent external reference.

- 2026-10-12 (parent correction): Epic `Engine/Source/Runtime/Core/Public/Misc/FrameRate.h:25-27` initializes `Denominator` to 1. Tagged saves can omit it; pinned CUE4Parse's `FFrameRate(FStructFallback)` fills an absent field with 0. Read the original tagged struct before typed conversion, default only an absent denominator to 1, and reject an explicitly stored zero or negative value. The compiled shipped-helper regression failed with `DisplayRate is invalid (30/0)` before the fix; all five channel/default/transform/additive tests now pass (`raw/parent596-rate-default-{red,green}.log`). Converter `.584.6.3`, importer 119; the final strict real corpus replay passed.


- 2026-10-12 (current corpus replay plan): Complexity 0 → LOW; risk override none. Scope is the shared corpus loader and this PRD. Current `ue5-clips` loads only modern/gasp54/gasp58; `sequencer-differential` loads only gasp58, both using the imported converter/importer versions. Preserve frozen historical loaders, trust/hash/native/artifact checks and clip/motion assertions; cache each scope separately. Generate fresh public imports and separate native CLI descriptors through a local consumed recipe/index under the root cache. Verify with typecheck and actual `ue5-clips`; commit helper/docs only, without pushing. Final manager gates/review and private attachments remain open; only AC-2 requires an independent owner reference.

- 2026-10-12 (sampling repair plan): Complexity 3 → LOW; risk override none. Scope: shipped FK transform sampling, its compiled real-CUE regression harness, converter `.584.6.2` pins and this PRD; importer remains 119. Convert display time with serialized MovieScene TickResolution, preserve integer extraction and channel-rate weighted math, and blend floor/ceil whole transforms for fractional ticks. Missing scene rate reports an exact unsupported reason. Focused red/green only; fresh parent build, actual public proof/index, four gates and final review remain pending.

- 2026-10-12 (Claude): AC-2 reference source. First choice: a Fab listing that ships the same clips in a ≤ 5.1 artifact (conventional model, already Verified) and a ≥ 5.2 artifact (Sequencer model); compare the two exports. If no such pair is in the owner's library, use the engine's own evaluation exported once by the owner from the editor (then AC-2 moves under Blocked on with that owner action). Do not compare the evaluator with itself.
- 2026-10-12 (Claude): bump the converter build tag and `IMPORTER_VERSION`; update the four tests that pin `CUE4PARSE_SOURCE.version` and the ledger rows `AnimSequence` UE5.0–5.5 / UE5.6+ in `docs/unreal-format-support.md`.
- 2026-10-12 (sampling repair): The previous repair incorrectly converted display time with each channel's rate and evaluated fractional Euler components directly. Official `Engine/Plugins/Animation/AnimationData/Source/AnimationData/Private/AnimSequencerDataModel.cpp:1524` uses `MovieScene->GetTickResolution()`. The shipped boundary now reads serialized scene `TickResolution` through `SequencerFrameRate` (`cue4parse-adapter.ts:3333`) and calls `SampleSequencerTransform` (`:3243`) from the FK export loop. Missing scene rate returns exactly "the clip's MovieScene carries no TickResolution"; a missing scene rate is rejected; an omitted denominator preserves Unreal's documented default1. Integer sampling follows engine `:1645–1703` (uniform value index, zero-key default, otherwise evaluation); fractional sampling follows `:1605–1642,1708–1721` (floor/ceil endpoint defaults first, then whole-transform blend). Generic channel-rate weighted formulas are unchanged.
- 2026-10-12 (sampling repair): `Engine/Source/Runtime/Core/Public/Math/TransformNonVectorized.h:372–397` blends translation/scale linearly and rotation with `TQuat::FastLerp` followed by normalize; vectorized equivalent is `TransformVectorized.h:427–463`. `Quat.h:1371–1376` chooses the shortest hemisphere with the dot-product sign. Pinned CUE `FQuat.cs:359–364` implements that same FastLerp; the shipped helper reuses it. Blend endpoint threshold 0.00001 comes from `VectorRegister.h:133`, and integer subframe tolerance from `UnrealMathUtility.h:407`. The test removes CUE's approximate InvSqrt length error before checking analytic orientation; it does not treat Euler lerp as a reference.
- 2026-10-12 (repair): reconstructed Sequencer FK tracks are absolute transforms. Pinned CUE4Parse `AnimConverter.cs:272` would classify an additive sequence and `FPoseBone.cs:27` would add the base translation again, so the shipped `ConvertAbsoluteSequencerAnimation` helper temporarily sets `AdditiveAnimType` to `AAT_None` only around the reconstructed route's `ConvertAnims()` and restores it in `finally`; compressed/non-Sequencer routes retain their additive behavior. The previous reference-clip reconstruction was removed because it was unnecessary for absolute data.

## Recorded source facts

Official local source: `/home/joao/projects/UnrealEngine-5.8.3`, tag `5.8.3-release`,
commit `396c9f059903aed5fec78ecd3d437a40c6415368` (provenance from project instructions).
Paths below are relative to that checkout; exact ranges were inspected for this update.

- `Engine/Plugins/Animation/AnimationData/Source/AnimationData/Private/AnimSequencerDataModel.cpp:148–150,394–396`: transform parameter names map to bone names via `UFKControlRig::GetControlTargetName(..., ERigElementType::Bone)`.
- Same file `:310–342`: frame count derives from MovieScene playback range, keys are frames + 1, and model frame rate is MovieScene display rate. At `:1524`, sampling converts evaluation time to MovieScene tick resolution with `FFrameRate::TransformTime`.
- Same file `:1608–1642,1645–1691,1708–1721`: integer extraction prefers keys; fractional endpoint evaluation prefers defaults and blends floor/ceil whole transforms, otherwise evaluating channels through `EvaluateWithCache`. Translation and scale use XYZ; rotation channels are Roll, Pitch, Yaw and become `Rotator.Quaternion()`.
- `Engine/Plugins/Animation/ControlRig/Source/ControlRig/Private/Sequencer/MovieSceneControlRigParameterSection.cpp:1714–1731`: transform defaults use translation XYZ, rotation Roll/Pitch/Yaw, scale XYZ. These facts do not substitute for independent AC-2 pose proof.

## Historical local evidence and parent handoff (importer119 / converter `.584.6.4`)

The consumed local proof index is `/home/joao/.cache/agent-dumps/prd-596-599/raw/current596-proof.json`.
Fresh public imports and separate actual native CLI exports are under
`/home/joao/.cache/agent-dumps/prd-596-599/raw/current596-64/`:

| Fixture | Public / native directories | Model GLBs | Native clips / public sidecars | Bound motion |
|---|---|---:|---:|---|
| modern | `modern-public` / `modern-native` | 2 | 2 / 2 | both walk clips |
| gasp54 | `gasp54-public` / `gasp54-native` | 8 | 325 / 325 | at least one genuinely moving clip |
| gasp58 | `gasp58-public` / `gasp58-native` | 8 | 7 / 7 | at least one genuinely moving clip |

All reports record importer119, `reused:false`, and converter `b4e95441+threenative.584.6.4`.
Actual executable banner: `threenative-cue4parse b4e95441+threenative.584.6.4`.
Actual converter DLL SHA-256: `761e73d21abc8a66677aa54fcf3342a6980eca94da8b33f44a8fa71e5b0b7c83`.
The strict gate verifies binary identity, DLL digest, report provenance, native descriptors, public artifact
hashes, actual NodeIO animations, bound geometry, finite timing and motion. Current scopes require only their
own fixtures; historical corpus gates retain the frozen previous/before converter requirements.

The final5.4 replay retains all325 clips and8 models from the prior selection, skipping unrelated standalone
audio promotion after the original command was terminated before publishing its report. One unselected
blendspace descriptor is reported outside this clip proof; the whole pack is not claimed error-free.
Recipes and raw logs remain local: `current596-64-recipe.mts`,
`parent596-final64-corpus.log`. Licensed inputs, outputs and renders stay outside the repository.

Final moving and additive comparison sheets are attached directly to
[PR49](https://github.com/ThreeNativeHQ/threenative-asset-mcp/pull/49#issuecomment-6132085569),
rendered from the final GLB bytes and inspected.
Before means pre-review `.584.5`, after was rendered on `.584.6.3` and its GLB bytes match final `.584.6.4`; neither row substitutes a bind pose for the requested
clip. Both use the same neutral renderer and rest-pose camera. A moving foot reaches the camera boundary;
this presentation limit does not change the numeric motion gate. PR attachment is recorded under AC-5.

## Independent reference and current-build evidence

The owner downloaded the official Linux UE5.8.3 ZIP locally, resolving the historical 401.
No authentication bypass or fresh login is required. A selective 6.2GiB runtime exports actual
Unreal poses independently of the importer. The original raw additive-delta oracle
(`retrieve_additive_as_full_pose=false`) remains unchanged. The supplementary full-pose oracle
uses `AnimPoseExtensions.get_anim_pose_at_time`, RAW evaluation, no retargeting, and
`retrieve_additive_as_full_pose=true`. Official `AnimPose.cpp:698–729` applies the additive delta
to the engine base pose and normalizes rotations; this matches the standalone full-pose GLB
consumer context. This is an independent engine evaluation, not importer-generated reference data.

Scope: seven selected Game Animation Sample 5.8 clips, 101 frame samples and 39,109 original
bone-frame poses. For six mannequin clips, 91/93 bones are serialized raw bones; the only two
excluded bones are declared virtuals established by actual Unreal T3D exports. All 875/875
face bones are compared, with zero exclusions. `ReferenceSkeleton.h:106–116,244–254` and
`ReferenceSkeleton.cpp:492–517` distinguish raw bones from appended virtual bones.
No prefix-based exclusion, virtual-bone output support, whole-pack parity or all-version claim is made.
The current `.584.10.2` / importer124 gate passes eight document comparisons and 72,233/72,233 keys,
with zero missing keys or errors above 0.5°. Direct current helper replay calculated the maximum
0.00026378151666186844°; the face clip occurs in two GLBs. The prior frozen pass remains historical evidence.

Private provenance lives under `/home/joao/.cache/threenative-asset-mcp/prd596-independent-reference/`:
`provenance-full.json` and `virtual-bones-provenance.json` record archive, executable,
source package, skeleton and official source identities. SHA-256 digests:

- Official ZIP: `81985a9542e15761fa3cc0d4483a26ebe5fd0b448120faddaa2fe05d94142934`.
- UnrealEditor-Cmd: `7e54a59c2740d66003656e7a8f33d11e7348bb97d33483e98f05fedd0784284a`.
- Original raw poses: `651209382e839d2aac4d09e8155c36ecef05f4d761ddc7682df08a61ac847a78`.
- Supplementary full poses: `0ad36d7d83708676cf9262231dcfe4989456d1854f542694882a785d6a57c436`.
- Declared-virtual receipt: `f7d12c8d21562add0a2d3be8274ec9dad372a20a7576b6c904babf285d2565fc`.

Current checkout: `c4e0ed1`, release 0.12.0, importer124, converter `.584.10.2`; PRDs 597–599 are integrated.
Fresh public imports and separate native CLI exports are indexed by
`/home/joao/.cache/agent-dumps/prd-596-599/raw/current596-102-proof.json`:
modern 2/2 clips and 2 models, UE5.4 325/325 clips and 8 models, UE5.8 7/7 clips and 8 models.
Reports record `reused:false`; actual converter DLL SHA-256 is
`11d7a9a9c4b8686ab0f6376de5e98a58ba5b10f3a1ec6aa447f3cff21bd62792`.
The current independent gate passed in 9.13s (`raw/596-102-independent-gate.log`).
Licensed inputs, poses, GLBs, recipes and receipts remain local-only.

The mixed saved-version bulk fix reads each package's saved version for its UObject preamble,
rather than using the older fallback profile. It restores three control meshes; the compiled
saved-header regression failed before the fix and all seven static-mesh converter tests pass
on `.584.10.2` (`raw/596-bulk-version-{red,final-green}.log`). Current terrain gates pass
2 tests in 25.43s (`raw/current599-102-terrain-gate.log`); the separate combined-scene replay
of 51 terrain components plus 3 mesh actors with zero omissions remains pending observation.
Parent owns AC-6 completion, final diff review, PR49 merge, publication and the engine dependency update.
No third formal review or independent review approval is claimed.

## Execution Phases

#### Phase 1: Layout and channel evaluator
**Status:** DONE — implementation complete; current AC-2 proof and all four repository gates pass
**Files:** new evaluator inside `src/unreal/cue4parse-adapter.ts` (the C# program is embedded there); `tests/unreal-sequencer-channels.test.ts`.
**Implementation:** Expand the sparse checkout with the paths in Context. Record the layout facts under Decisions. Implement channel evaluation and the Euler-to-quaternion step. Find the AC-2 reference pair (owner's library via `fab_list_owned`).
**Verification:** AC-3.

#### Phase 2: Converter and importer route
**Status:** DONE — implementation complete; current AC-2 proof and all four repository gates pass
**Files:** `src/unreal/cue4parse-adapter.ts` (`ExportClip`, `UnsupportedReason`), `src/unreal/importer.ts` (version), `tests/helpers/animation-corpus.ts` (invert the ControlRig assertion, add the differential gate).
**Implementation:** Route a Sequencer-model clip through the evaluator into `RawAnimationData`. Keep the sidecar. Bump versions.
**Verification:** AC-1 and AC-4 selected corpus evidence recorded; AC-2 current-tag replay passed.

#### Phase 3: Evidence and ledger
**Status:** DONE — implementation complete; current AC-2 proof and all four repository gates pass
**Files:** `docs/unreal-format-support.md`, `README.md` import table.
**Implementation:** Sheets, ledger row, and README are updated with importer/converter provenance and local proof paths; historical corpus replay, PR attachment, and `.584.6.4` gates passed; current implementation-head gates pass.
**Verification:** AC-5 historical attachment recorded; AC-6 current implementation-head gates pass.

## Closure decision

The independent-reference blocker is resolved by the actual current `.584.10.2` / importer124
differential. AC-2 is checked and this original PRD moves to `docs/PRDs/done/` as instructed.
AC-6 now passes all four current implementation-head gates. PR49 still requires final current-head CI before merge; publication and the engine dependency update follow the authorized merge.
No source, test or package edits, commit, push or additional review are part of this documentation closure.
