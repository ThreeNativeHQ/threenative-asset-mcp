# PRD-596 — UE 5.4+ animation clips from the Sequencer data model

**Status:** INPROGRESS — fresh current corpus replay exposes a native frame-rate reader defect; manager repair/review, final gates and private PR attachments remain; only AC-2 requires owner input
**Priority:** P1 — current `.584.6.2` corpus replay rejects every GASP clip with an invalid MovieScene DisplayRate; native repair, final repository gates and PR attachment remain manager-owned.
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

- [ ] AC-1 [local]: Importing the `game-anim-5.8` slice through `asset_import_unreal` exports its seed clips as GLB animations with moving bones, and the report lists no ControlRig reason for them. proof: `PRD583_ANIMATION_PROOF=/absolute/path/current-prd583-proof.json npx vitest run tests/fab-feature-corpus.test.ts -t ue5-clips` — Evidence: current-head `ecec375` plus the scoped loader change was freshly replayed with `.584.6.2` / importer 119. The consumed [current index](/home/joao/.cache/agent-dumps/prd-596-599/raw/current596-proof.json) loads successfully, but [strict ue5-clips replay](/home/joao/.cache/agent-dumps/prd-596-599/raw/current596-corpus.log) fails in gasp54 on exactly "the clip's MovieScene DisplayRate is invalid (30/0)". The separate gasp58 native CLI export has 7 AnimSequences, all unsupported (6 at 30/0, 1 at 24/0), and the fresh public GLBs contain no bound animation or motion. This is an internal native defect, not an owner blocker. Earlier `.584.6` motion proof does not establish parity on the current converter.
- [ ] AC-2 [local]: A Sequencer-model clip matches an independent decode of the same clip within 0.5° per bone per frame. proof: differential gate beside `clip-differential` (`tests/helpers/animation-corpus.ts:252`) — Evidence: blocked on independent owner reference; authenticated library survey found no transition pair. See the owner-action section below. Remains unchecked.
- [x] AC-3 [local]: Each channel interpolation mode (constant, linear, cubic auto, cubic user, cubic break, weighted) evaluates to the engine's formula on synthetic keys, and an unsupported mode reports its reason. proof: `THREENATIVE_TOOLCHAIN_DIR=/tmp/prd596-toolchain npx vitest run tests/unreal-sequencer-channels.test.ts` — Evidence: converter `b4e95441+threenative.584.6.2`, importer 119; 4 focused tests passed, exit 0 in [rates596-green.log](/home/joao/.cache/agent-dumps/prd-596-599/raw/rates596-green.log). The harness compiles the current shipped sampling/rate/additive helpers against the pinned actual CUE structs. The pre-fix stale-rate test failed with uniform index 800 outside 85 keys ([rates596-red.log](/home/joao/.cache/agent-dumps/prd-596-599/raw/rates596-red.log)); scene/display 30 with channel 24000 now returns key 1. Tests cover unequal/rational scene/display rates, integer keyed/default precedence, fractional endpoint default precedence, whole-transform translation/scale blend across constant keys, two-axis quaternion blend with analytic expected orientation, shortest hemisphere, and exact missing/invalid scene-rate reasons. A temporary Euler-blend mutation failed the two-axis assertion ([rates596-euler-red.log](/home/joao/.cache/agent-dumps/prd-596-599/raw/rates596-euler-red.log)) and was restored before the final green. Generic interpolation formulas and the native additive 20 → absolute 10 → restored legacy 20, raw X=10 and success/failure enum restoration checks remain intact. This is compiled-helper evidence; the freshly built full converter/public replay is recorded below and exposes a native DisplayRate defect not covered by this harness.
- [ ] AC-4 [local]: The `game-anim-5.4` slice imports its seed clip the same way. proof: same gate as AC-1 over `gasp54` — Evidence: fresh gasp54 output contains 8 model GLBs and 325 clip sidecars, but all 325 actual native AnimSequences report "the clip's MovieScene DisplayRate is invalid (30/0)"; no GLB animation is bound and no clip moves. The strict gate in AC-1 fails on the first selected gasp54 clip. Assertions remain unchanged; native repair and replay are internal work.
- [ ] AC-5 [local]: Before/after sheet of one 5.8 clip on the mannequin (several frames) is attached to the PR and inspected by eye. proof: PR comment link — Evidence: local before/fixed-after sheet [repair596-before-after-moving-58.png](/home/joao/.cache/agent-dumps/prd-596-599/raw/repair596-before-after-moving-58.png) and static additive-integrity sheet [repair596-static-additive-integrity-58.png](/home/joao/.cache/agent-dumps/prd-596-599/raw/repair596-static-additive-integrity-58.png) were rendered with the production renderer and inspected locally. The before side is the pre-fix broken additive output, not a claim that the feature was previously supported; parent must attach and inspect the sheet in the PR.
- [ ] AC-6 [local]: Repository gates pass on the final head. proof: `npm run typecheck`, `npm test`, `npm run test:leaks`, `npx vitest run tests/mcp-smoke.test.ts` — Evidence: all four passed on the prior repair head with the private converter environment; the fresh `.584.6.2` converter was consumed by this replay, while all four final-head gates remain manager-owned: [typecheck](/home/joao/.cache/agent-dumps/prd-596-599/raw/repair596-typecheck.log), [npm test](/home/joao/.cache/agent-dumps/prd-596-599/raw/repair596-npm-test.log), [leak gate](/home/joao/.cache/agent-dumps/prd-596-599/raw/repair596-leaks.log), and [MCP smoke](/home/joao/.cache/agent-dumps/prd-596-599/raw/repair596-smoke.log). Current scoped-loader typecheck passed; the separate strict corpus failure is recorded under AC-1.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| UE5 Sequencer-model clips | `asset_import_unreal` → `importUnrealDirectory` → CUE4Parse `ExportClip` (`cue4parse-adapter.ts:3512, 3669`) → PSA → `attachPsaAnimations` (`src/unreal/psa.ts:294`) | Non-FK models and invalid rates remain Reported with an exact reason | AC-1, AC-4 |

## Decisions

- 2026-10-12 (parent correction): Epic `Engine/Source/Runtime/Core/Public/Misc/FrameRate.h:25-27` initializes `Denominator` to 1. Tagged saves can omit it; pinned CUE4Parse's `FFrameRate(FStructFallback)` fills an absent field with 0. Read the original tagged struct before typed conversion, default only an absent denominator to 1, and reject an explicitly stored zero or negative value. The compiled shipped-helper regression failed with `DisplayRate is invalid (30/0)` before the fix; all five channel/default/transform/additive tests now pass (`raw/parent596-rate-default-{red,green}.log`). Converter `.584.6.3`, importer 119; final corpus replay still required.


- 2026-10-12 (current corpus replay plan): Complexity 0 → LOW; risk override none. Scope is the shared corpus loader and this PRD. Current `ue5-clips` loads only modern/gasp54/gasp58; `sequencer-differential` loads only gasp58, both using the imported converter/importer versions. Preserve frozen historical loaders, trust/hash/native/artifact checks and clip/motion assertions; cache each scope separately. Generate fresh public imports and separate native CLI descriptors through a local consumed recipe/index under the root cache. Verify with typecheck and actual `ue5-clips`; commit helper/docs only, without pushing. Final manager gates/review and private attachments remain open; only AC-2 requires an independent owner reference.

- 2026-10-12 (sampling repair plan): Complexity 3 → LOW; risk override none. Scope: shipped FK transform sampling, its compiled real-CUE regression harness, converter `.584.6.2` pins and this PRD; importer remains 119. Convert display time with serialized MovieScene TickResolution, preserve integer extraction and channel-rate weighted math, and blend floor/ceil whole transforms for fractional ticks. Missing scene rate reports an exact unsupported reason. Focused red/green only; fresh parent build, actual public proof/index, four gates and final review remain pending.

- 2026-10-12 (Claude): AC-2 reference source. First choice: a Fab listing that ships the same clips in a ≤ 5.1 artifact (conventional model, already Verified) and a ≥ 5.2 artifact (Sequencer model); compare the two exports. If no such pair is in the owner's library, use the engine's own evaluation exported once by the owner from the editor (then AC-2 moves under Blocked on with that owner action). Do not compare the evaluator with itself.
- 2026-10-12 (Claude): bump the converter build tag and `IMPORTER_VERSION`; update the four tests that pin `CUE4PARSE_SOURCE.version` and the ledger rows `AnimSequence` UE5.0–5.5 / UE5.6+ in `docs/unreal-format-support.md`.
- 2026-10-12 (sampling repair): The previous repair incorrectly converted display time with each channel's rate and evaluated fractional Euler components directly. Official `Engine/Plugins/Animation/AnimationData/Source/AnimationData/Private/AnimSequencerDataModel.cpp:1524` uses `MovieScene->GetTickResolution()`. The shipped boundary now reads serialized scene `TickResolution` through `SequencerFrameRate` (`cue4parse-adapter.ts:3333`) and calls `SampleSequencerTransform` (`:3243`) from the FK export loop. Missing scene rate returns exactly "the clip's MovieScene carries no TickResolution"; no scene rate or missing denominator is invented. Integer sampling follows engine `:1645–1703` (uniform value index, zero-key default, otherwise evaluation); fractional sampling follows `:1605–1642,1708–1721` (floor/ceil endpoint defaults first, then whole-transform blend). Generic channel-rate weighted formulas are unchanged.
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

## Local evidence and parent handoff

Fresh current proof is consumed from
[current596-proof.json](/home/joao/.cache/agent-dumps/prd-596-599/raw/current596-proof.json), generated by
[current596-recipe.mts](/home/joao/.cache/agent-dumps/prd-596-599/raw/current596-recipe.mts).
The recipe uses `importUnrealDirectory` (its animation route invokes `--animations` unconditionally when clips are present),
a fresh unique import-cache/output root, and separate real converter `--animations` CLI exports for native descriptors.
The modern staging contains two actual walk clips, two compatible body meshes and their shared skeleton; texture/material
coverage is outside this animation proof. Licensed inputs and outputs remain local, outside the repository.

All outputs/native directories are under
`/home/joao/.cache/agent-dumps/prd-596-599/raw/current596-2026-10-12T20-05-00-418Z/`:

| Fixture | Public output / separate native directory | Model GLBs | Clip sidecars / native AnimSequences | Moving GLB clip identities |
|---|---|---:|---:|---:|
| modern | `modern-public` / `modern-native` | 2 | 2 / 2 | 2 |
| gasp54 | `gasp54-public` / `gasp54-native` | 8 | 325 / 325 | 0 |
| gasp58 | `gasp58-public` / `gasp58-native` | 8 | 7 / 7 | 0 |

Every fresh report records importer 119 and `reused:false`. Actual executable banner:
`threenative-cue4parse b4e95441+threenative.584.6.2`; actual `ThreeNativeConverter.dll` SHA-256:
`c09a298b9100cff60e0ad5d82a54d8c713d93bd9d3e7c8ac465c63b4627256a0`.
The loader verifies the executable banner, DLL digest, report provenance, typed native descriptors,
public artifact hashes and actual NodeIO GLBs. Current scopes demand no historical before/ASP/curve inputs;
other gates retain their frozen .89/116 loader and cache separately. `npm run typecheck` and `git diff --check`
passed; the required strict corpus command ran and failed for the native reason under AC-1. No full suite was run.
The failure originates at `SequencerFrameRate` (`src/unreal/cue4parse-adapter.ts:3333`, called for DisplayRate at `:3389`): the typed frame-rate read supplies denominator zero. The correct native rate decoding remains manager repair work; no default denominator or unsupported-record filtering was introduced. This is the internal checkpoint; no source fix, passing GASP proof, AC closure or owner blocker is inferred.

Generated local sheets for parent visual inspection:
[repair596-before-after-moving-58.png](/home/joao/.cache/agent-dumps/prd-596-599/raw/repair596-before-after-moving-58.png) and
[repair596-static-additive-integrity-58.png](/home/joao/.cache/agent-dumps/prd-596-599/raw/repair596-static-additive-integrity-58.png).
They use the production renderer at three frames. The first compares the pre-fix `.584.5` output with the fixed `.584.6`
output on one moving 5.8 mannequin clip; the second shows the static/additive regression before and after. Both were locally
inspected; the parent must attach the moving sheet to the PR, repair/replay the current corpus failure and complete final gates.

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
The fresh sampling-tag `b4e95441+threenative.584.6.2` executable was used for the current replay above. Use the indexed private toolchain rather than the stale shared cache; repair the native DisplayRate reader and replay before claiming GASP motion or final-gate completion.
AC-2 remains unchecked until this independent comparison passes.

## Execution Phases

#### Phase 1: Layout and channel evaluator
**Status:** IMPLEMENTED — scoped red-to-green test evidence recorded; independent pose proof remains open.
**Files:** new evaluator inside `src/unreal/cue4parse-adapter.ts` (the C# program is embedded there); `tests/unreal-sequencer-channels.test.ts`.
**Implementation:** Expand the sparse checkout with the paths in Context. Record the layout facts under Decisions. Implement channel evaluation and the Euler-to-quaternion step. Find the AC-2 reference pair (owner's library via `fab_list_owned`).
**Verification:** AC-3.

#### Phase 2: Converter and importer route
**Status:** IMPLEMENTED — older 5.8/5.4 public GLB proofs recorded; fresh current corpus replay failed on native DisplayRate, and AC-2 owner input remains pending.
**Files:** `src/unreal/cue4parse-adapter.ts` (`ExportClip`, `UnsupportedReason`), `src/unreal/importer.ts` (version), `tests/helpers/animation-corpus.ts` (invert the ControlRig assertion, add the differential gate).
**Implementation:** Route a Sequencer-model clip through the evaluator into `RawAnimationData`. Keep the sidecar. Bump versions.
**Verification:** AC-1, AC-2, AC-4.

#### Phase 3: Evidence and ledger
**Status:** IMPLEMENTED — ledger, README, local before/after sheet and additive-integrity sheet updated; PR attachment and final-head gates remain parent-owned.
**Files:** `docs/unreal-format-support.md`, `README.md` import table.
**Implementation:** Sheets, ledger row, and README are updated with importer/converter provenance and local proof paths; formal corpus replay, PR attachment, and final gates remain parent-owned.
**Verification:** AC-5, AC-6.
