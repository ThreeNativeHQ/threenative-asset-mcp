# Unreal format support ledger

Single place to track which Unreal 4 and Unreal 5 formats the importer supports, which are verified,
and which are missing. `README.md` ("Unreal import support") links here. Update this file in the same
commit as any importer, converter or adapter change that moves a row.

Last audited: 2026-10-12, `IMPORTER_VERSION` 117 (`src/unreal/importer.ts`). Evidence comes from the
README import table, `src/unreal/`, `tests/`, and the engine headers in `~/projects/UnrealEngine-5.8.3`
(tag `5.8.3-release`, `Engine/Source/Runtime/Engine/Classes`, file names only).

## Status vocabulary

| Status | Meaning |
|---|---|
| **Verified** | Imported from a real, named pack. The README or a sweep names the pack. |
| **Implemented** | Code and tests exist (synthetic or hand-authored fixtures). No real pack is named. |
| **Reported** | The importer detects the class, lists it in the report and converts nothing. |
| **Missing** | Not detected. The package is skipped, or it fails with "nothing to convert". |

"Verified" proves the format converts. It does not prove the result looks like Unreal's own render.
Visual parity is tracked in `docs/parity/fidelity-baseline.json` and in
[Visual fidelity](#visual-fidelity-separate-claim).

## Decoder route by engine version

An artifact's format is its oldest listed engine version (see `AGENTS.md`).

| Package version | Decoder |
|---|---|
| UE 4.0–4.20 (object version below 517) | UE Viewer (built from source on Linux) |
| UE 4.21–4.27 (object versions 517–522) | MeshDescription converter (`unreal-assets-to-glb`) |
| UE 5.x | CUE4Parse adapter (pinned, out of process) |
| Mixed packs (UE5 listing with UE4-saved packages) | Both routes in one import |

## 1. Geometry and animation

| Class / format | Engine | Status | Output | Evidence or gap |
|---|---|---|---|---|
| Cooked `StaticMesh` | UE4 | Implemented | GLB, LOD sections | No named pack for the cooked route. |
| Uncooked `StaticMesh` below object version 517 | UE4.0–4.20 | **Verified** | GLB | Modular Building Set (129), STF Landscape Pro 2.0 (61), Power Plant (65), UE4.19 fern pack (38) |
| Uncooked `StaticMesh` (`FMeshDescription`) | UE4.21–4.27 | **Verified** | GLB, cm to m | Office Pack Vol.1 (47 of 47) |
| Uncooked `StaticMesh` editor source (LOD0 only) | UE5.1 | **Verified** | GLB | Megascans Common Hazel and European Hornbeam. Triangle counts match the UE4.27 decoder. |
| Cooked `StaticMesh` | UE5.5 | **Verified** | GLB | README names UE5.5 cooked static geometry. |
| `StaticMesh` LOD1 and higher from editor source | UE5 | **Missing** | none | Only LOD0 is decoded. |
| `StaticMesh` with Nanite data and no fallback mesh | UE5 | Reported | none | Reported honestly, no geometry. |
| `StaticMesh` BuildScale3D | UE5 editor | **Missing** | none | `readBuildScale3D` reads legacy -7 headers only (`AGENTS.md`). |
| `SkeletalMesh`, skinned | UE4.0–4.20 | **Verified** | skinned GLB | Animal Variety Pack (6 rigged animals, 146 clips) |
| `SkeletalMesh`, cooked | UE4 | Implemented | skinned GLB | Joints, weights and inverse-bind matrices preserved. |
| `SkeletalMesh`, editor source | UE5 | **Verified** | skinned GLB | README: "UE5 editor skeletal geometry". |
| `AnimSequence` | UE4 | **Verified** | GLB clips | 146 clips in Animal Variety Pack. The CUE4Parse route now reads the editor raw track map (`TrackToSkeletonMapTable`), so raw/compressed UE4 clips convert to ActorX PSA: the Animation Starter Pack 4.4 CUE4Parse export matches the UE Viewer clips within 0.265° per bone per frame (13 clips, 68 bones). |
| `AnimSequence` | UE5.0–5.5 | Implemented | GLB clips | The conventional `UAnimDataModel.BoneAnimationTracks` editor model converts: the executed native probe (converter `85-animation`) decoded a real UE 5.0.3 MetaHuman Sample `MM_Walk_Fwd` to a 354-bone, 83-frame PSA at 30 fps with the endpoint sampled; converter `86-animation` is source-only pending a fresh public native proof. Timing comes from the model's own `NumberOfFrames`/`NumberOfKeys` (keys = frames + 1) and rational `FrameRate`. A real 5.4 Fab pack (Game Animation Sample 5.4, 606 clips) still stores its tracks in a `UAnimationSequencerDataModel` — a `UMovieScene` with an `FKControlRig` parameter track — not in `BoneAnimationTracks`, and is Reported with that model. A cooked 5.0–5.5 clip that carries `RawAnimationData`/`FUECompressedAnimData`/ACL still converts. |
| `AnimSequence` | UE5.6+ (incl. 5.8) | Reported | none | A clip with no raw or compressed bone data is reported from the package's own evidence (a `ControlRig`/Sequencer model, or `NumFrames`), never with a blanket engine-version claim and never as a bind-pose clip. |
| ActorX `.psa` clips | UE4 | Implemented | attached by bone name | Needs at least 80% of tracks to match. |
| ActorX per-frame bone scale | any | Reported | none | |
| `Skeleton` (standalone) | any | **Missing** | none | Read only as part of a mesh. |
| `BlendSpace`, `BlendSpace1D`, `AimOffsetBlendSpace` | any | Implemented | `Animation/<name>.json` | Axes read from the typed `BlendParameters` fixed array with `FBlendParameter` defaults restored per omitted field, samples resolved to exported clips, `bMirror`, `bLoop` and additive flags preserved, a mirror sample with no `MirrorDataTable` reported. |
| `AnimMontage`, `AnimComposite` | any | Implemented | `Animation/<name>.json` | Section starts resolved per `LinkMethod`, slots and notifies with the resolved class and a `blueprint` kind for a Blueprint notifier. |
| `AnimSequence` notifies, curves and sync markers | any | Implemented | `<clip>.clip.json` | Read from `RawCurveData`, `CompressedCurveData`, `LegacyCurveData` (on the sequence or a referenced `AnimationDataModel` export), or the conventional model's `CurveData.FloatCurves`; a clip with unsupported tracks still keeps its sidecar and reports the reason. |
| `AnimStreamable` | any | **Missing** | none | Not read by the adapter. |
| `PoseAsset` | any | **Missing** | none | Out of scope (PRD-583 decision): a Three.js consumer cannot run pose search. |
| `AnimBlueprint` (`AnimBlueprintGeneratedClass`) | any | Reported | none | CUE4Parse reads it only as graph and bytecode. |
| `SkeletalMeshSocket`, `StaticMeshSocket` | any | Implemented | `socket:<name>` glTF nodes | `src/unreal/gameplay-data.ts`, `tests/unreal-gameplay-data.test.ts`, `tests/unreal-gameplay-import.integration.test.ts`. Skeleton and mesh sockets merge (the mesh wins a clash); a UE4 package that holds a socket class routes to CUE4Parse. Real corpus (converter 84, `tests/fab-feature-corpus.test.ts -t sockets`): the UE5.8 mannequin attaches four skeleton sockets, reports one virtual-bone socket as missing, and a shoe mesh attaches twelve of its own. |
| Static-mesh simple collision (`BodySetup`, `AggGeom`) | any | Implemented | mesh node `extras.unrealCollision` plus `Collision/<package>.json` | Sphere/box/capsule/convex elements in metres, engine scaling rules with the mesh's `BuildScale3D`; `CTF_UseComplexAsSimple` yields no simple shapes. A UE4 mesh whose `BodySetup` UE Viewer cannot decode enters the CUE4Parse run for its sidecar while keeping its UE Viewer geometry. No real pack named yet. |
| `PhysicsAsset` | any | Implemented | `Physics/<asset>.json`, mesh node `extras.unrealPhysicsAsset` | Bodies, constraints (limits, motions, decoded drives), collision-disabled pairs; a body whose bone the mesh lacks is reported, and an unresolved physics-asset reference is warned about rather than dropped. A constraint frame uses Unreal's native identity basis when an axis tag is omitted: primary axis unit X, secondary axis unit Y. Drives convert to glTF: linear position and velocity targets become metres and metres per second, the angular orientation target becomes a quaternion, and the angular velocity target stays in revolutions per second. Body damping keeps FBodyInstance's native linear 0.01 / angular 0 when the whole `DefaultInstance` is omitted. A skeletal mesh resolves its cross-package PhysicsAsset/Skeleton reference through the metadata-only converter run while its geometry stays on UE Viewer. Real corpus (converter 84, `tests/fab-feature-corpus.test.ts -t physics`): UE4.4 23 bodies/22 constraints, UE4.22 14/13, UE5.8 23/22, 6/1 and 2/0; every body bone resolves in the linked GLB skin, every constraint frame is a unit orthogonal basis, and no sub-export is missing. |
| `SplineMeshComponent` | UE4 and UE5 | Reported | none | Deformation is not applied. |
| Geometry Collection and destructibles (Chaos) | UE5 | **Missing** | none | Plugin class, not checked against the headers. |
| Cloth assets (`ClothingAsset`, Chaos Cloth) | any | **Missing** | none | Plugin class, not checked against the headers. |
| Control Rig | UE5 | **Missing** | none | Plugin class, not checked against the headers. |
| `GroomAsset` (hair strands) | UE5 | Implemented | strand geometry | `src/unreal/grooms.ts`, `tests/unreal-grooms.test.ts`. Editor `FHairDescription` only. No real pack named. |
| Alembic, Geometry Cache | UE4 and UE5 | **Missing** | none | Plugin classes. |

## 2. Textures and materials

| Class / format | Engine | Status | Output | Evidence or gap |
|---|---|---|---|---|
| `Texture2D`, cooked | UE4 | Implemented | PNG | |
| `Texture2D` editor source | UE4.0–4.27 | **Verified** | PNG | The UE4.27 artifact is the reference for UE5 colour checks. |
| `Texture2D` editor source, `TSF_BGRA8` and sRGB `TSF_RGBA16` | UE5 | **Verified** | PNG, colour corrected | UE5.3 Oodle texture source art. |
| `Texture2D` `TSCF_UEDELTA` source | UE5.6+ | Implemented | PNG | `tests/unreal-converter-ue5-sources.test.ts` pins the tile rules. Converter 61 and later. |
| `Texture2D` `RGBA16F` source | UE4.19 and UE5.1 | Implemented | raw half-float plus JSON manifest | Hornbeam position-parent texture decoded (importer 110). No material binding or PivotPainter semantics. |
| `TextureCube` | UE4 and UE5 | Implemented | equirectangular PNG or Radiance HDR | |
| `Texture2DArray`, `TextureCubeArray`, `VolumeTexture` | UE4 and UE5 | Implemented | RGBA8 slices plus JSON | Floating-point stacks are rejected. |
| `Material`, `MaterialInstanceConstant` | UE4 and UE5 | **Verified** | `UnrealMaterialLibrary.glb` | Sweep packs: Temperate, KUBIKOS, Kite, Soul Cave, Hornbeam, Paladin. Per-pack parity differs, see below. |
| Material graph colour baking | UE4 and UE5 | Implemented | base-colour PNG (`source: "graph"`) | Closed node set. Fresnel, DepthFade, Time and similar nodes are approximations. |
| `MaterialFunction`, `MaterialFunctionInstance` | any | Implemented | read through the graph | Engine content functions are not in the pack, so such a bake is `heuristic`. |
| `MaterialParameterCollection` | any | **Missing** | none | `CollectionParameter` stays on the neutral fallback. |
| Material nodes the baker cannot evaluate | any | **Missing** | neutral fallback | `ReflectionVectorWS` into a cubemap, `CameraVectorWS`, `Custom` HLSL pins, `SetMaterialAttributes` routing, `BoundingBoxBased`, `TenLayerBlend`. See `IMPORTER-REMAINING.md`. |
| Layered, subsurface, hair and eye shading models | any | Reported | PBR approximation | Section `limitations` name what was dropped. |
| `SubsurfaceProfile` | any | **Missing** | none | |
| `TextureRenderTarget*`, `CanvasRenderTarget2D` | any | **Missing** | none | Runtime targets, usually nothing to export. |
| `LightMapTexture2D`, `ShadowMapTexture2D`, `MapBuildDataRegistry` | any | Reported | none | Baked lighting is dropped on purpose. |
| `TextureLightProfile` (IES) | any | **Missing** | none | |
| Virtual textures (RVT and SVT) | UE5 | **Missing** | none | Not checked against a pack. |
| `MediaTexture` | any | **Missing** | none | Plugin class. |
| `CurveLinearColorAtlas` | any | **Missing** | none | |

## 3. Levels, placement and foliage

| Class / format | Engine | Status | Output | Evidence or gap |
|---|---|---|---|---|
| `.umap` placement, lights, Blueprint component templates | UE4.21–4.27 | Implemented | scene GLB plus manifest | `KHR_lights_punctual`. No real level named. |
| `.umap` | UE5.2 | **Verified** | scene GLB | UE5.2 Paper2D map. |
| Standalone Blueprint prefab (component defaults) | UE5 | Implemented | scene GLB | Bytecode reported, never run. |
| Blueprint graph, construction script, bytecode | any | Reported | none | Never executed. |
| ISM and HISM, painted foliage | UE4 | Implemented | `EXT_mesh_gpu_instancing` | `tests/unreal-foliage-import.integration.test.ts`. |
| `FoliageType_InstancedStaticMesh` as a standalone package | any | Reported | none | |
| `LandscapeComponent` heightfields | UE4 editor | Implemented | indexed terrain mesh | Compressed BGRA8 heightmaps only. |
| Landscape, UE5 | UE5 | **Missing** | none | The importer lists `LandscapeComponent` as unsupported when standalone. Check UE5 levels before changing this row. |
| Landscape layer weights and `LandscapeLayerInfoObject` | any | **Missing** | none | |
| World Partition external actors (`__ExternalActors__`) | UE5 | Implemented | merged into the level | `tests/unreal-external-actors.test.ts`. No real pack named. |
| Level streaming, sublevels, HLOD proxies | any | Implemented | partial | `tests/unreal-hlod-proxy.test.ts`, `tests/unreal-level-gate.test.ts`. |
| `DecalActor` and decal components | any | **Missing** | none | |
| Volumes (post-process, audio, blocking) | any | **Missing** | none | |
| `LevelSequence` and Sequencer | any | **Missing** | none | Plugin class. |
| Camera actors and camera rigs | any | **Missing** | none | |

## 4. Effects

| Class / format | Engine | Status | Output | Evidence or gap |
|---|---|---|---|---|
| `NiagaraSystem`, `NiagaraEmitter` | UE5 | Verified (descriptor) | `Effects/<system>-<hash>.niagara.json` | Real bounded `asset_import_unreal` run over `vtol-5.4` writes all 3 systems (converter current `b4e95441+threenative.584.4`, importer 117; re-run 2026-10-12 against the executed private `.584.4` binary by the corpus gate `PRD-584 real corpus acceptance` > `niagara`, which passed on the VTOL 5.4 pack). `buildNiagaraDescriptor` (`src/unreal/effects-schema.ts`) reads the typed path and decodes `RapidIterationParameters`. The `<hash>` is the first 16 hex digits of SHA-256 over the canonical package-and-object key (`gamePackageKey`), so two same-basename systems in different folders never share a file. UE Viewer cannot list UE5 Niagara packages, so `cooking.ts` `EFFECT_CLASS_HINTS` names the class from the name table. The AC-4 level `omittedActors` pointer remains. |
| Cascade `ParticleSystem` (and `ParticleModule*`) | UE4 | Verified (descriptor) | `Effects/<system>-<hash>.cascade.json` | Real bounded `asset_import_unreal` run over `soul-cave-4.18` writes `Effects/P_flyingPaper-<hash>.cascade.json` (1 emitter, `M_paper`, lifetime 3..5; converter current `b4e95441+threenative.584.4`, re-run 2026-10-12 against the executed private `.584.4` binary by the corpus gates `cascade` and `cascade-distributions` on the Soul: Cave 4.18 pack). AC-2 enumerates 17 dual-form distributions (14 within 1% at 16 samples, 3 particle-parameters reported unresolved). Descriptor is data only; no runtime plays it. The AC-4 level pointer and the AC-6 leak/smoke gates remain. |
| Effect materials (translucent or additive particle materials) | any | Implemented | PBR approximation | `tests/unreal-effect-materials.test.ts`. 40 Paragon particle materials remain unbaked. |

## 5. Audio

| Class / format | Engine | Status | Output | Evidence or gap |
|---|---|---|---|---|
| `SoundWave`, cooked | UE4 and UE5 | Implemented | WAV, Ogg, MP3 or FLAC | Checked through Three.js `AudioLoader`. |
| `SoundWave`, editor source WAV | UE5 | Implemented | WAV | |
| `SoundCue` and `SoundNode*` graphs | any | Implemented | `Audio/<cue>.cue.json` | The graph is walked from `FirstNode`; `Switch`, `Branch`, `ParamCrossFade`, `Mixer` and `Random` parameters are named; every `WavePlayer` leaf is rewritten to its exported audio file or reported as a missing wave. The soft `SoundWaveAssetPtr` path is read, never the bogus native `SoundWave`. Real corpus (converter 84, `tests/fab-feature-corpus.test.ts -t soundcue`): a UE4.18 cue resolves eight `WavePlayer` leaves and a UE5.8 cue four, each to an existing exported audio file. |
| `SoundClass`, `SoundMix`, `SoundAttenuation`, `SoundSubmix`, `ReverbEffect` | any | **Missing** | none | Mixing and spatial settings. |
| `DialogueWave`, `DialogueVoice` | any | **Missing** | none | |
| MetaSound | UE5 | **Missing** | none | Plugin class. |
| `SoundWaveProcedural` | any | **Missing** | none | Runtime generated, no source data. |

## 6. Data, fonts and 2D

| Class / format | Engine | Status | Output | Evidence or gap |
|---|---|---|---|---|
| `DataTable`, `StringTable`, `CurveTable` | UE4 and UE5 | Implemented | JSON under `data/` | |
| `CurveFloat`, `CurveVector`, `CurveLinearColor` | UE4 and UE5 | Implemented | JSON | |
| `CompositeDataTable`, `CompositeCurveTable` | any | **Missing** | none | |
| `DataAsset` (project-specific subclasses) | any | **Missing** | none | Only the table and curve classes above convert. |
| `UserDefinedStruct`, `UserDefinedEnum` | any | **Missing** | none | |
| `Font` (runtime and `FontFace`) | UE4 and UE5 | Implemented | TTF or OTF | |
| `Font` (offline atlas) | UE4 and UE5 | Implemented | PNG pages plus BMFont JSON | |
| `PaperSprite`, `PaperFlipbook` | UE5.2 | **Verified** | unlit GLB, JSON | Real Paper2D project. |
| `PaperTileSet`, `PaperTileMap` | UE5.2 | **Verified** | indexed unlit GLB | Placed tile maps in UE5 levels. |
| Paper2D grouped sprites, `TextRenderActor` | UE5 | Implemented | `EXT_mesh_gpu_instancing`, glyph geometry | |
| Paper Terrain and spline deformation | any | Reported | none | |
| UMG `WidgetBlueprint` and Slate brushes | any | **Missing** | none | |

## 7. Containers and encryption

| Format | Status | Note |
|---|---|---|
| Loose `.uasset`, `.uexp`, `.ubulk`, `.umap` | Implemented | Main path. |
| Pak and IoStore (`.pak`, `.utoc`, `.ucas`), unencrypted | **Missing** | Extract first. The importer reads loose files only. |
| Pak and IoStore, encrypted | **Missing** | Needs user-supplied keys. Never reported as a complete conversion. |
| Cooked UE5 with unversioned properties | Implemented | Needs one matching `.usmap` file beside the tree. |

## Planned work

| PRD | Covers |
|---|---|
| [PRD-581](PRDs/unreal-feature-coverage/001-fab-feature-test-corpus.md) | Small, non-redundant Fab test corpus (slices) for the PRDs below |
| [PRD-582](PRDs/unreal-feature-coverage/002-sockets-collision-soundcue.md) | Sockets, StaticMesh collision, PhysicsAsset, SoundCue |
| [PRD-583](PRDs/unreal-feature-coverage/003-animation-logic.md) | UE5 clips, BlendSpace, AimOffset, AnimMontage, AnimComposite, clip notifies and curves |
| [PRD-584](PRDs/unreal-feature-coverage/004-vfx-descriptors.md) | Cascade and Niagara descriptors (P3) |

CUE4Parse decodes every class in PRD-582 and PRD-583 on UE4 and UE5. UE Viewer decodes none of them.

## Visual fidelity (separate claim)

A format row can be Verified while the picture is still wrong. Current state:

- `docs/parity/fidelity-baseline.json` locks 7 packs. Two Temperate builds and KUBIKOS are at 77–82 mean.
  Landscape, Soul Cave and both Kite builds are at 41–50 mean with 5–8 failing tiles.
- The 2026-10-10 sweep passed 25 of 40 packs. Open packs: Game Animation Sample (UE5.8), Paragon (4.19),
  Medieval Village (5.3 and 4.26), Downtown West (4.26), Hornbeam UE4.25 and UE5, Asian male.
  Full list and causes: `IMPORTER-REMAINING.md`. Those numbers predate converter 77–79, so re-measure.

## Not yet audited

These need a check against a real pack or the engine source before a row can move:

1. Settled 2026-10-11: UE5 `AnimSequence` is Missing (see the row above and PRD-583).
2. Whether UE5 landscapes inside levels convert. The importer marks standalone `LandscapeComponent` unsupported.
3. Which plugin classes (Chaos, Control Rig, MetaSound, Sequencer) exist as Fab content. They are listed from
   general engine knowledge. The sparse checkout holds only part of `Engine/Source/Runtime/Engine`, so the
   plugin sources are absent. Expand the sparse paths to check.
4. UE 5.0–5.8 per-version coverage. Only 5.1, 5.2, 5.3, 5.5 and 5.8 appear in verified packs. 5.0, 5.4, 5.6
   and 5.7 are untested by name.

## How to update this file

1. Move a row to **Verified** only with a real pack name, the engine version, the importer version and the date.
   Never commit pack contents, asset names beyond the pack title, or renders (see `AGENTS.md`).
2. Add a red-to-green test with any move from **Missing** to **Implemented**.
3. Add new engine classes to the right table when a pack shows one. Use the header names under
   `Engine/Source/Runtime/Engine/Classes` as the class source.
4. Bump the "Last audited" line and `IMPORTER_VERSION` at the top.
