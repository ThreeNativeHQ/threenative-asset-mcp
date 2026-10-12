# PRD-582 — Import Unreal sockets, collision, physics assets and SoundCues

**Status:** DONE — AC-1 through AC-8 proved on 2026-10-12. Final source `8ef7c2f`, importer 115 and immutable converter `threenative.86-gameplay` passed the five-slice gameplay gates, default-worker leak gate and packed-MCP smoke. Four inspected before/after sheets are embedded in [PR #44's screenshot comment](https://github.com/ThreeNativeHQ/threenative-asset-mcp/pull/44#issuecomment-6121157154). The PR remains open; no merge is authorized.
**Complexity:** 5 (MEDIUM) — 1–5 implementation files (1), new gameplay-data module (+2), crosses the .NET converter / Node importer boundary (+2); risk override: none
**Owner:** João
**Depends on:** PRD-581 (corpus slices and `tests/fab-feature-corpus.test.ts`)

## Context

`docs/unreal-format-support.md` lists these classes as **Missing**. The Three.js side needs them to attach
weapons and effects (sockets), to build colliders and ragdolls (collision, physics assets), and to play
randomised or layered sounds (SoundCue).

A read-only probe on 2026-10-11 ran the pinned CUE4Parse on real packages (Game Animation Sample 5.8, a
UE 4.19 pack). The full notes are kept locally and are not committed. Findings:

- **CUE4Parse already decodes every class here**, for UE4 and UE5. Typed: `USkeletalMeshSocket`,
  `UStaticMeshSocket`, `UBodySetup`, `USkeletalBodySetup`, `FKAggregateGeom` and its elements,
  `UPhysicsAsset`, `FConstraintInstance`, `USoundCue`. Other fields arrive as tagged `Properties`.
  The repo never extracts any of them.
- **UE Viewer cannot decode them.** `umodel -list` names the classes, but its loader prints `unknown` for
  their properties. So these classes go to the CUE4Parse adapter for **every** engine version. CUE4Parse
  already opens UE4 packages with an `EGame.GAME_UE4_xx` (`olderProvider`, adapter ~1539).
- **Sockets.**
  - Skeletal sockets live mostly on the `USkeleton` (`Skeleton.h:378`), not the mesh. The 2026-10-11 probe
    assumed `SK_TwinBlast` (about 40 sockets) and an empty `SKM_UE4_Mannequin`. Real-corpus verification
    **contradicts that assumption**: `SK_TwinBlast` is absent from the corpus, and the actual Game Animation
    Sample mannequin `SKM_UEFN_Mannequin` has five effective sockets. Four attach (`palm_l_Socket` →
    `hand_l`, `palm_r_Socket` → `hand_r`, `RagdollTrace` → `spine_03`, `prop_01_Socket` → `prop_01`); the
    fifth names the virtual bone `VB hand_r_prop_01`, which the exported skin lacks, so it is reported in
    `import-report.json` `missingBones` and not attached.
  - The mesh adds its own `Sockets` list (`SkeletalMesh.h:2448`). The effective list is skeleton plus mesh,
    and the mesh wins on a name clash (inferred from `GetActiveSocketList`).
  - `UStaticMesh.Sockets` is native (`StaticMesh.cpp:7471`) and has no bone.
  - Default values are omitted from the dump. The typed classes apply them.
- **Collision.**
  - `UStaticMesh.BodySetup` is native (`StaticMesh.cpp:7396`).
  - `AggGeom` holds `SphereElems`, `BoxElems`, `SphylElems`, `ConvexElems` and `TaperedCapsuleElems`.
    Verified: UE5.8 `SM_Cube` has a convex with 8 vertices and 36 indices; a UE4.19 mesh has one capsule.
  - `Sphyl.Length` is the cylinder segment only. Add `Radius` at both ends.
  - Box `X/Y/Z` are probably full extents (inferred; read `BoxElem.h` before locking).
  - `CTF_UseComplexAsSimple` means the render mesh is the collider: emit no simple shapes.
- **PhysicsAsset.**
  - `SkeletalBodySetups[]` and `ConstraintSetup[]` are sub-exports.
  - Bodies link to the mesh only by bone name. The mesh points at the asset through `SkeletalMesh.PhysicsAsset`.
  - `CollisionDisableTable` is native.
  - A constraint's `DefaultInstance.ProfileInstance` and its `ConeLimit`/`TwistLimit`/`LinearLimit`/drive
    sub-structs arrive null: Unreal omits a tag whose value equals the native default, so CUE4Parse's
    struct fallback leaves the field null. The adapter now rebuilds Unreal's native defaults
    (`FLinearConstraint` Limit 0 axes Locked, `FConeConstraint`/`FTwistConstraint` 45° Free, `FConstraintDrive`
    stiffness 50 damping 1 drives off) instead of dereferencing the null (which aborted the whole import).
  - Verified 2026-10-11: UE5.8 `PA_UEFN_Mannequin` (23 bodies, 22 constraints) and UE4.22 `PHYS_Stickman`
    (14 bodies, 13 constraints), both with no missing sub-exports. UE4.4 `HeroTPP_Physics` then decoded its 22
    constraints but reported 0 bodies, because that package stores the body array as `BodySetup`, the name
    renamed to `SkeletalBodySetups` in later engines. The `threenative.84` adapter reads the legacy `BodySetup`
    array too, so on 2026-10-12 `HeroTPP_Physics` reports 23 bodies and 22 constraints, and the gap is closed.
- **SoundCue.**
  - Nodes are tagged sub-exports linked by `ChildNodes`.
  - **CUE4Parse defect (verified):** `USoundNodeWavePlayer.SoundWave` is a bogus native read on UE5.8 editor
    assets. Read the soft path `SoundWaveAssetPtr`, or the tagged `SoundWave`.
  - The 2026-10-11 probe assumed the Game Animation Sample had no SoundCue and Soul: Cave had one. Actual
    verification: the Game Animation Sample slice holds `BackgroundMix` (4 waves); Soul: Cave holds
    `Footstep_Dirt_Cue` (8 waves), all eight resolved to exported audio.

**Repo hooks** (`src/unreal/importer.ts` unless noted):

- `UNSUPPORTED_CLASSES` at 504.
- Per-package classification at 3040–3135. `needsModernConverter` is at 3085–3090: UE4 packages default to
  UE Viewer, so the new flags must force CUE4Parse.
- Skip exemptions at 3528–3540, and the "nothing to convert" gate at 3567–3590.
- Adapter per-package handlers at `cue4parse-adapter.ts:2185–2230`.
- JSON sidecar precedent in the adapter at 2912–2930 (`Data/*.json`) and in `grooms.ts`.
- glTF post-processing through a glTF-Transform `Document` at 1615.
- PSA clips attach to joints by name in `psa.ts:228–237`. A socket finds its parent joint the same way.
- The installed `@gltf-transform/extensions` has no `KHR_physics_rigid_bodies` or `KHR_implicit_shapes`.

## Solution

**Consumer flow.** `asset_import_unreal` / `fab_import_asset` → `importUnrealDirectory` → the CUE4Parse
adapter writes `Gameplay/<package>.json` per package → `src/unreal/gameplay-data.ts` reads these files.
It then attaches socket nodes and collision `extras` to the GLBs, writes the sidecars, and adds counts and
failures to `import-report.json`. In Three.js, `gltf.scene.getObjectByName("socket:Muzzle_R")` returns the
attach point, and a physics layer reads `Physics/*.json`.

**Outputs.**

| Data | Where | Shape |
|---|---|---|
| Skeletal socket | child node of the joint named `BoneName` | `socket:<SocketName>`, TRS converted like bones (cm to m, UE to glTF basis), `extras.unrealSocket {name, bone, source: skeleton\|mesh}` |
| Static socket | child node of the mesh node | same, without bone; carries `Tag` |
| Static simple collision | mesh node `extras.unrealCollision` and `Collision/<mesh>.json` | `{traceFlag, profile, shapes: [{type: sphere\|box\|capsule\|convex, center, rotation (quaternion), size fields, vertices/indices}]}` in metres |
| Physics asset | `Physics/<asset>.json`, referenced from the skinned mesh node `extras.unrealPhysicsAsset` | `{bodies: [{bone, physicsType, damping, shapes}], constraints: [{child, parent, frames, swing1Deg, swing2Deg, twistDeg, motions, drives, disableCollision}], collisionDisabledPairs}` |
| SoundCue | `Audio/<cue>.cue.json` when globally unique; `Audio/<selector>/<cue>.cue.json` for duplicate names | `{volume, pitch, attenuation, root: {type, params, children}}`, where `WavePlayer` leaves name the exported `Audio/<wave>` file |

**Reuse.**

- Joint lookup by name comes from `psa.ts`, and the geometry scale from `mesh-build-scale.ts`.
- The adapter's existing package loop and `Audio`/`Data` output directories are reused.
- The `describeWithTools` compiled-adapter test pattern comes from `tests/unreal-converter-custom-inputs.test.ts`.

**Risks.**

- Rotation order and handedness. Convert `FRotator` (pitch Y, yaw Z, roll X) in UE space first, then change
  basis exactly as the CUE4Parse glTF writer does for bones.
- Constraint frames: `PriAxis` = X, `SecAxis` = Y (inferred). Read `ConstraintInstance.cpp` before locking.
- Physics bodies naming bones the exported skin lacks, for example cloth-collision assets. Report them; never drop them silently.
- Convex `IndexData` can be empty even in the actual Soul Cave editor package used for AC-8. Preserve the
  empty source indices; its debug visualization derives convex hull edges from the real `VertexData` and
  does not claim stored triangles.

## Acceptance Criteria

- [x] AC-1 [local]: A synthetic socket on a known bone, with a non-zero `FRotator` and an offset, lands at the hand-computed glTF position and rotation (≤ 1e-4 m, ≤ 0.01°). The test is red before the fix. proof: `npx vitest run tests/unreal-gameplay-data.test.ts -t socket` — Evidence: green 2026-10-11; a socket with location `[100,200,300]` and 90° yaw lands at `[1,3,2]`, rotation `[0, √½, 0, −√½]`. The scale basis swap and the mesh-wins merge regression are pinned too.
- [x] AC-2 [local]: On the Game Animation Sample slice, `SKM_UEFN_Mannequin` has one `socket:*` node per effective socket (skeleton plus mesh), each parented to the joint its `BoneName` names. Static mesh sockets hang under their mesh node. proof: `FAB_FEATURE_CORPUS_DIR=… npx vitest run tests/fab-feature-corpus.test.ts -t sockets` — Evidence: real corpus 2026-10-12 with the `threenative.86-gameplay` snapshot, the test reads the real GLBs. Five of five effective sockets are accounted for on the mannequin: the GLB holds four `socket:*` nodes (`palm_l_Socket` → `hand_l`, `palm_r_Socket` → `hand_r`, `RagdollTrace` → `spine_03`, `prop_01_Socket` → `prop_01`), each parented to a joint listed in the GLB skin, and the fifth socket, naming the virtual bone `VB hand_r_prop_01` absent from the skin, is reported in `missingBones`. The adapter also decodes the mesh's own socket list: a second mesh carries twelve attached sockets, each under a skin joint. The earlier probe's `SK_TwinBlast`/`SKM_UE4_Mannequin` fixture claim was wrong for this corpus.
- [x] AC-3 [local]: Sphere, box, capsule and convex `AggGeom` elements become metre-scale shapes. Capsule half-height is `Length/2 + Radius`, and `CTF_UseComplexAsSimple` yields no simple shapes. proof: `npx vitest run tests/unreal-gameplay-data.test.ts -t collision` (compiled adapter helpers against real CUE4Parse types) — Evidence: green 2026-10-11; the scaling follows `Engine/Private/PhysicsEngine/BodySetup.cpp` (sphere min-abs axis, box per-abs axis, capsule max cross-section), tapered capsules keep both radii, and the compiled `GpShape` runs against a real `FKBoxElem`. The physical-unit sidecar assertion runs in `tests/unreal-gameplay-import.integration.test.ts`.
- [x] AC-4 [local]: On every slice with a physics asset (4.4, 4.22, 5.8), `Physics/*.json` has one body per `SkeletalBodySetup`, one constraint per `PhysicsConstraintTemplate`, and each named bone resolves to a joint in the skinned GLB or is listed in `import-report.json`. proof: `… tests/fab-feature-corpus.test.ts -t physics` — Evidence: real corpus 2026-10-12 with the `threenative.86-gameplay` snapshot. The test reads the actual `Physics/*.json` sidecars and counts their arrays, checks each sidecar exists and its package is neither failed nor skipped, resolves every body bone against the linked GLB skin (or the reported `missingBones`), and asserts every constraint frame is a non-zero unit orthogonal basis. Counts match the verified source: UE4.4 `HeroTPP_Physics` 23/22 (the legacy `BodySetup` array is read now, closing the earlier 0-body gap), UE4.22 `PHYS_Stickman` 14/13, UE5.8 `PA_UEFN_Mannequin` 23/22, `Face_Archetype_Physics` 6/1, running-shoes 2/0. No missing sub-exports. The two slices with only static or no physics stay empty (Soul: Cave, VTOL).
- [x] AC-5 [local]: On the Soul: Cave and Game Animation Sample slices, every SoundCue becomes a `.cue.json`, and each `WavePlayer` leaf names an exported audio file or a reported missing wave. No leaf uses the bogus `USoundNodeWavePlayer.SoundWave` value. proof: `… tests/fab-feature-corpus.test.ts -t soundcue`, plus a compiled test that is red when the native `SoundWave` is read — Evidence: real corpus 2026-10-12 with the `threenative.86-gameplay` snapshot. The test walks each cue JSON, counts its `WavePlayer` leaves independently of the cue count, and checks each leaf's `waveExport` file exists or the leaf is named in `missingWaves`: Soul: Cave `Footstep_Dirt_Cue` 8 leaves/8 waves, Game Animation Sample `BackgroundMix` 4/4, none missing — contradicting the earlier "no GASP cue" assumption. The compiled test that the native `SoundWave` is never read is green.
- [x] AC-6 [local]: These classes are no longer reported as skipped, and no required gameplay class is excluded. A package of its own (`SkeletalMeshSocket`, `StaticMeshSocket`, `PhysicsAsset`, `SoundCue`) routes to CUE4Parse for geometry and metadata. An ordinary mesh whose only gameplay signal is a `BodySetup`/`SkeletalBodySetup` or a cross-package `PhysicsAsset`/`Skeleton` reference enters the converter input for its metadata only: its geometry keeps the verified UE Viewer / MeshDescription route, and the sidecar is read back for its model. `docs/unreal-format-support.md` moves each row with its evidence. proof: `npx vitest run tests/unreal-gameplay-import.integration.test.ts tests/unreal-import.integration.test.ts` — Evidence: green 2026-10-11; two strict public-API regressions — a UE4 `StaticMesh`+`BodySetup` package that keeps its UE Viewer geometry while gaining metre collision, and a UE4 `SkeletalMesh`+`Skeleton` package with a cross-package `PhysicsAsset` reference (no socket class) that resolves the physics asset — plus a SoundCue-only package that is no longer listed as skipped. Real-corpus proof: the strict socket, physics and SoundCue gates pass on fresh imports with the explicit immutable `threenative.86-gameplay` converter (2026-10-12).
- [x] AC-7 [local]: Repository gates are green: `npm run typecheck`, `npm run test:leaks` with default workers, and `npx vitest run tests/mcp-smoke.test.ts`. proof: those commands — Evidence: 2026-10-12 cumulative source `8ef7c2f` (PR base `aa9d183`, importer 114), importer 115 and immutable converter `threenative.86-gameplay`: typecheck and build green; affected compiled native suites 117/117; default-worker `test:leaks` 2532 passed, 6 skipped, leak gate clean (93.06 s). The strict real-corpus socket, physics and SoundCue gates passed 3/3 against fresh imports from all five required matrix slices (109.98 s), with the executed converter version and importer version asserted. Packed-MCP smoke passed 15/15 (12.51 s).
- [x] AC-8 [local]: Every PR attaches before/after sheets per the epic `README.md` evidence rule. Before: meshes with no attach points or colliders. After: the same camera with socket markers and axes, collision shapes, and physics bodies drawn as wireframe overlays. SoundCue has nothing visible, so the PR also shows its cue graph as a diagram. proof: the PR comment with sheets — Evidence: [four immutable screenshots embedded in PR #44](https://github.com/ThreeNativeHQ/threenative-asset-mcp/pull/44#issuecomment-6121157154), inspected by both delivery and parent agents. Before imports execute PR base `aa9d183`, importer 114 and private converter 79; after imports execute source `8ef7c2f`, importer 115 and private converter `86-gameplay`, from identical local package bytes. Production `renderTiles` uses shared framing, neutral `judgeRender` verdicts/coverage accompany the tiles, and picture lighting is explicitly the `unreal-like/1` fallback approximation. Sheets show four mannequin sockets (one missing virtual bone is reported), actual UE4/UE5 physics-body wireframes, and both real SoundCue graphs with 8/4 resolved WavePlayer leaves. The matrix's static collision shapes are empty: its nonempty proof uses one actual Soul Cave mesh outside the matrix, a 16-package/46 MiB dependency closure, with two convex shapes (62/70 vertices; source indices empty). Display hull edges derive from those vertices. Existing material fidelity failures (37/57/7 scores) remain visible; no improvement is claimed.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Gameplay-data extraction | `asset_import_unreal` → `importUnrealDirectory` (`importer.ts:3793`) → adapter `Gameplay/*.json` (`cue4parse-adapter.ts:3040`) | New. Removes these classes from the skipped list. | AC-2, AC-6 |
| Socket nodes and collision extras in GLBs | importer glTF-Transform post-pass (`importer.ts:2004`, `attachGameplayData`) | New | AC-1, AC-2, AC-3 |
| Physics and SoundCue sidecars | same import; files under `Physics/` and `Audio/` | New | AC-4, AC-5 |

## Decisions

- 2026-10-11 (agent): use `extras` plus JSON sidecars, not `KHR_physics_rigid_bodies` / `KHR_implicit_shapes`. The extensions are not installed, and the physics draft is not ratified. Revisit when the engine side picks a physics runtime.
- 2026-10-11 (agent): extract these classes with CUE4Parse for every engine version, because UE Viewer cannot decode them.
- 2026-10-12 (agent): the 2026-10-11 note that UE4.4 reports 0 bodies is superseded by the `threenative.84` converter, which reads the legacy `BodySetup` array (renamed `SkeletalBodySetups` in later engines); `HeroTPP_Physics` now reports 23 bodies/22 constraints. The final strict gates run on the immutable `~/.cache/threenative-asset-mcp/prd582/converter-86-gameplay` snapshot, never the mutable shared root binary, and import each required slice fresh with importer version 115.
- 2026-10-12 (agent): converter 84 fixes two measured physics defects. The pinned `FConstraintInstance` constructor now applies Unreal's native identity basis (primary axis unit X, secondary axis unit Y) when an axis tag is omitted, at the raw tag-presence boundary, so explicit saved axes are preserved; the real `PA_UEFN_Mannequin` sidecar had two constraints with zero axes and now has none. The importer converts a constraint's drive targets: linear position and velocity become metres and metres per second, the angular orientation target becomes a quaternion, and the angular velocity target keeps its revolutions-per-second unit with only the basis swapped. `GpDamping` keeps the native linear 0.01 / angular 0 when a body's whole `DefaultInstance` is omitted. Importer version stays 115: the modern converter version is part of the reuse cache key, so every gameplay import is invalidated by the 84 bump.
- 2026-10-12 (agent): final converter `86-gameplay` uses the pinned provider's top-level `.uproject` stem as its mount (directory name only when absent), verified by a compiled real-provider fixture. Package selectors retain folder identity for physics and cues. Qualified missing wave paths never fall back to another folder's basename; legacy bare names resolve only when unique, case-insensitively. Public regressions cover duplicate names and root-level/nested cue accounting.

## Execution Phases

#### Phase 1: Sockets and the CUE4Parse route
**Status:** DONE — adapter writer, module, public route and real-corpus sockets proved (AC-1, AC-2).
**Files:**
- `src/unreal/cue4parse-adapter.ts`: a `Gameplay/*.json` writer for skeleton, mesh and static sockets.
- `src/unreal/importer.ts`: classification flags, `needsModernConverter`, skip exemptions.
- `src/unreal/gameplay-data.ts` (new): reads the sidecars, attaches nodes, converts the basis.
- `tests/unreal-gameplay-data.test.ts` (new).

**Implementation:**
- Resolve `SkeletalMesh.Skeleton` across packages.
- Merge the skeleton and mesh socket lists; the mesh wins on a name clash.
- Convert TRS in UE space, then change basis the same way the bone writer does.
- Report sockets whose bone is missing.

**Verification:** AC-1, AC-2.

#### Phase 2: Collision and physics assets
**Status:** DONE — shapes, constraints, drives and sidecars done; `BodySetup`/`SkeletalBodySetup` and cross-package PhysicsAsset/Skeleton metadata enter the converter input while the mesh keeps its UE Viewer / MeshDescription geometry. Real-corpus physics ran 2026-10-12 with the `threenative.86-gameplay` snapshot: the null-profile crash is fixed, constraints decode on every slice, the UE4.4 `BodySetup` gap is closed, every body bone resolves in the linked GLB skin, and no sub-export is missing (AC-3, AC-4).
**Files:** adapter (BodySetup and PhysicsAsset writers), `gameplay-data.ts`, tests.
**Implementation:**
- Shapes go to metres and glTF basis, with `meshGeometryScale` (the mesh's `BuildScale3D`) applied.
- Constraints keep their child and parent frames and their half-angle limits in degrees.
- The skinned node gets `extras.unrealPhysicsAsset`.

**Verification:** AC-3, AC-4.

#### Phase 3: SoundCue, ledger and gates
**Status:** DONE — cue graphs, format ledger, cumulative gates and real-corpus SoundCues proved; the four inspected sheets are embedded in PR #44 (AC-5 through AC-8).
**Files:** adapter (SoundCue writer), `gameplay-data.ts`, `docs/unreal-format-support.md`, `README.md` import table, tests.
**Implementation:**
- Walk the graph from `FirstNode` through `ChildNodes`.
- Resolve waves by soft path to the exported audio file name.
- Export `Switch`, `Branch` and `ParamCrossFade` parameters by name.
- Update the ledger rows.

**Verification:** AC-5, AC-6, AC-7, AC-8 (sheets for every phase's PR).
