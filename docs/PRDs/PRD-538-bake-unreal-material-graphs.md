# PRD-538 — Bake common Unreal material graphs into glTF PBR textures

**Status:** ACTIVE — PARTIAL. Phases 1–3 landed (PR #31); AC-1–AC-3 ticked on the live Soul Cave pack. AC-4 is open active work: it needs PRD-537's true corpus baseline, the comparison against it, and the repairs the comparison drives.
**Blocker:** none — the corpus sweep's licence input is recorded (PRD-537 Decisions, 2026-10-10). What AC-4 still needs is a real baseline and the work it shows; see Remaining work.
**Priority:** P2 — follows PRD-537. Sections whose colour exists only in the material graph still import grey (AC-1, AC-2); PRD-537's S4 failures will size how much of the library this affects.
**Complexity:** 5 (MEDIUM) — 1–5 implementation files (1), new graph-evaluation module (+2), crosses the .NET converter / Node importer boundary (+2); risk override: none
**Owner:** João
**Depends on:** PRD-537 (its parity harness and S4 check are the measure of this work)

## Context

**Problem.** Some Unreal materials compute BaseColor in the graph instead of sampling a colour
texture. The importer binds textures to glTF slots, so these sections ship on the neutral fallback
and look nothing like the Fab listing.

**Observed 2026-10-07 on Soul Cave** (`75f42402-40bb-4a1b-b557-18e2c9604273`, UE4.18):
`M_Cave_Rock_MASTER` and `M_Cave_Rock_MASTER_VertexPaint_Moss` contain no colour texture. Their
name tables show `TextureSampleParameter2D` (`Mask`, `MainNormal`), `VectorParameter`
(`Tint`, `Tint1`, `RockTint`, `DetailRockTint`), `Multiply`, `VertexColor`, `StaticBoolParameter`,
`FeatureLevelSwitch`, a `MaterialFunctionCall` to `MF_Solid_Color`, and
`BreakMaterialAttributes`. BaseColor is the mask's R/G/B/A channels weighted by tint vectors.
Instances such as `MI_Cave_Rock_Pillar` override `Mask` and the tints. Of the 21 sections in the
shipped import, 15 used the neutral fallback; most of those are this family.

Editor (uncooked) packages keep the full expression graph. Fab packs are editor packages, so the
graph is available without Unreal Engine.

**Files to inspect first:** `src/unreal/cue4parse-adapter.ts` (`ExportMaterialAsync` already loads
each `UMaterialInterface` and its parent chain), `src/unreal/materials.ts` (`resolveMaterial`,
neutral fallback, mask detector), `src/unreal/importer.ts` (where resolved materials become GLB
materials and `sidecarTextures`).

## Solution

- **Dump:** for each material and its parents, the CUE4Parse adapter writes
  `<Material>.graph.json`: the expressions reachable from BaseColor / Roughness / Metallic /
  Emissive / Opacity(Mask), their constant values, parameter names, and input links. Instance
  overrides are applied by parameter name. Static switches are resolved to the instance's value.
- **Evaluate:** a TypeScript evaluator supports a closed node set: TextureSample(Parameter),
  Vector/Scalar Parameter, Constant 1–4, Multiply, Add, Subtract, Lerp, LinearInterpolate,
  ComponentMask, AppendVector, OneMinus, Saturate/Clamp, Power, TextureCoordinate (scalar tiling),
  StaticSwitch(Parameter), FeatureLevelSwitch (take Default/SM5), and MaterialFunctionCall into
  functions built only from those nodes. The texture-space result is baked at the driving
  texture's resolution with `sharp`.
- **Fall back honestly:** VertexColor, world-space, time, and panner/noise nodes cannot be baked.
  For VertexColor the importer emits `COLOR_0`-dependent output only when the mesh carries vertex
  colours. Any other unsupported node in a slot's path leaves that slot on the PRD-537 path, and
  the report names the node class under `unsupported`, so a partial bake is never presented as exact.
- **Report:** a baked binding is `source: "graph"`, `confidence: "exact"` when every node in its
  path is supported. The node-class histogram of unsupported paths across the corpus goes into the
  parity scorecard, so the next node to support is chosen by count.

## Acceptance Criteria

Each criterion is a checkbox in the phase that delivers it: AC-1 in Phase 1, AC-2 in Phase 2, AC-3 and AC-4 in Phase 3.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Graph dump | `importUnrealDirectory` → CUE4Parse adapter `ExportMaterialAsync` | Additive `.graph.json` beside the `.mat`/`.props.txt` it already writes | AC-1 |
| Graph bake | `importUnrealDirectory` → `resolveMaterial` → new evaluator | Used only when no exact texture binding exists for the slot | AC-2, AC-3 |

## Decisions (appended 2026-10-08, Claude, João asleep; for sign-off)

- **The premise "no colour texture" was wrong for `M_Cave_Rock_MASTER`.** The graph samples colour textures inside material functions: `MF_Cave_Rock01` (RockTint × `T_Cave_Rock_01_D`) and `MF_Cave_Rock02` (DetailRockTint × `T_Cave_Rock_Detail_D`), plus a flat-grey `MF_Solid_Color` layer. `Mask` is a *blend mask*: its R, G and B channels are the alphas of three `MatLayerBlend_Standard` layers. BaseColor is `Diffuse Brightness × wetness-lerp(layer blend)`. So the bake is "blend of tinted colour textures by mask channels", not "mask × tint".
- **Engine content functions are not in the pack** (`MatLayerBlend_Standard/AO/BakedNormal`, `FuzzyShading_JM`, `CheapContrast`, `FlattenNormal`; 84 call nodes across Soul Cave). They stay as named `FunctionCall` nodes. The evaluator implements a small table of them by name. Their bodies were not available to verify, so only `MatLayerBlend_Standard` (per-attribute lerp by alpha) is treated as exact; functions that only touch non-colour attributes (`_AO`, `_BakedNormal`) pass BaseColor through, and view-dependent `FuzzyShading` is ignored. A bake that relies on any of those is `confidence: "heuristic"` and names them in the report's limitations; the PRD's "exact only when every node is supported" is kept for `confidence: "exact"`.
- **UE 4.5-era packages (object version 401) need a raw-property fallback** inside the dumper (16 of 89 Soul Cave materials).

- **`VertexColor` is evaluated as white when no primitive using the material carries `COLOR_0`** (Unreal's default for a mesh without a colour buffer). All 35 Soul Cave moss sections qualify (checked: none of their GLBs has `COLOR_0`; UE Viewer does emit it when present and the importer does not prune it). The bake is `heuristic` and says so, because a level instance could paint differently. A mesh that does carry `COLOR_0` keeps the node unsupported, as the PRD wanted. This moved S4 from 75.6 % to 93.2 %.
- **`TextureCoordinate` with `CoordinateIndex` 2 is read as UV0** (`allowUvSetFallback`; heuristic, named in the report). The importer drops extra UV sets and the graph does not say what set 2 is.
- **Graph-only textures are exported on demand.** The colour textures of a layered master live inside material functions, so UE Viewer never exported them (37 sections failed with "texture could not be loaded" until this). They are exported one at a time into the import's staging directory; UE Viewer silently writes nothing when the output path exceeds ~256 characters, so a long staging path goes through a short temporary symlink.
- **Bug only the real pack could show:** the importer carries the engine as `UE_4.18` but the converter accepts only `4.18`, so every graph dump exited 1 and no section baked. The fake-converter tests could not see it; a test now pins the normalisation, and the real run is the evidence.
- **`Divide` defaults** (`ConstA` 0, `ConstB` 1 when the dump omits them) are not verified against Unreal's class defaults (recalled as 1 and 2). It matters only for an unwired, omitted input.
- **The parity scorer exempts `source: "graph"` bindings from S3's foreign-texture check** (a baked texture is derived from several pack textures); the report does not list the textures the bake read, so S3 cannot check them yet.
- **The section report keeps a mask the PRD-537 path rejected as a base colour next to the graph binding** (`MI_Cave_Rock_Pillar` lists `baseColor=T_Cave_Rock_Pillar_M texture-set` and the graph binding); the GLB carries only the graph one. Pre-existing reporting behaviour, noted rather than changed.
- PRD filing: filed under `docs/PRDs/BLOCKED/requires-owner-action/` as PARTIAL, because AC-4 waits only on an owner action (`AGENTS.md`).
- 2026-10-10 (Claude, status correction): the 2026-10-08 filing reason above is superseded, and the file is refiled to `docs/PRDs/` (active). AC-4 needs a **true baseline** (PRD-537's final scorecard over the 37 runnable listings / 86 variants), a **comparison** against it, and the **repairs** that comparison shows — implementation and corpus validation, not only an owner action. Its licence input is recorded (PRD-537 Decisions, 2026-10-10): the owner's browser verdicts of 2026-10-08, saved as a real verdict file for all 37 runnable listing ids, never assumed via `--assume-licence`. No box is ticked or unticked by the move, no criterion is added or relaxed, and the Soul Cave numbers (S4 misses 97 → 12) remain one pack, not the library.
- 2026-10-10 (Claude, correction, not a history rewrite): the 2026-10-07 "UE source is not reachable" statement in PRD-537 is obsolete — the official source checkout exists at `~/projects/UnrealEngine-5.8.3` (tag `5.8.3-release`, commit `396c9f059903aed5fec78ecd3d437a40c6415368`); 25 content assets were SHA1-verified against it and used as a cross-version heuristic, not as an exact 4.19 verification.

## Remaining work

### Active validation and repairs

Corrected 2026-10-10: the single item here was filed as licence-blocked on 2026-10-08. It is not blocked now, because the owner's licence read is recorded for every runnable listing (PRD-537 Decisions, 2026-10-10). AC-4 needs a true corpus baseline, a real comparison against it, and the repairs that comparison shows.

- **AC-4** S4 failures across the PRD-537 corpus fall by at least half from PRD-537's final baseline. proof: `npm run parity:fab -- --corpus library --baseline <PRD-537 scorecard>`. Needs PRD-537's final corpus sweep — the licence input is recorded, so nothing here waits on the owner (see PRD-537 Remaining work) — and then a true baseline, a `--baseline` comparison against it, and the repairs the delta shows. The tooling is done: the scorecard carries the unsupported-node histogram, S4-miss attribution and `--baseline` delta. On the one pack available, S4 misses fell 97 → 12 (−88 %); the next nodes by count are `MatLayerBlend_Tint` (4 sections) and `DepthFade` (3). AC-4 stays unticked until the corpus proves it.

  Corrected 2026-10-10: the licence input this waited on now exists (the owner's browser read of 2026-10-08, recorded for all 37 runnable listing ids; no licence assumed). What remains is active work — run the full 86-variant sweep for a true baseline, compare against it with `--baseline`, and land the repairs the delta shows. The single-pack −88 % is evidence the bake works, not that AC-4 is met. No criterion is relaxed.

### Blocked on the owner

Owner actions that remain, none of them this PRD's AC-4: AC-9's public sandbox derivative push/merge/decline, `npm publish threenative-asset-mcp`, the engine pin bump in `threenative-engine/packages/core`, the Epic `ImageCoreDelta` source-provenance decision, the forest screenshot asset names, and the pending named-exception decisions. See PRD-537 Remaining work.

## Execution Phases

#### Phase 1: The graph reaches the importer
**Status:** DONE (2026-10-08)
**Files:** `src/unreal/cue4parse-adapter.ts`, `src/unreal/materials.ts` (parse `.graph.json`).
**Implementation:** Dump only expressions reachable from the five outputs; cap at 2,000 nodes per material and report truncation. Function calls are inlined from their `MaterialFunction` packages.
- [x] AC-1 [local]: Importing Soul Cave writes a `M_Cave_Rock_MASTER.graph.json` whose BaseColor path names `Mask` and the tint parameters. proof: `ThreeNativeConverter <pack> --dump-graphs <dir> --engine 4.18 --filter M_Cave_Rock_MASTER` via `dumpMaterialGraphs`, then a traversal from the BaseColor output — Evidence (2026-10-08): 160 nodes, 159 reachable, not truncated; reachable parameters include `Mask` (TextureSampleParameter2D), `RockTint` and `DetailRockTint` (VectorParameter), `Diffuse Brightness`, the wetness/fuzzy switches; reachable textures `T_Cave_Rock_01_D`, `T_Cave_Rock_Detail_D`, `T_Cave_Rock_Stalactite_M`. All 89 materials of the pack dump in ~2 s and pass the strict schema (`tests/unreal-graph-dump.test.ts`, 13 tests). The wording changed from "all four tint parameters": `Tint` and `Tint1` are *input names* of the functions `MF_Cave_Rock01`/`MF_Cave_Rock02`, fed by `RockTint`/`DetailRockTint` (see Decisions). The `parity:fab` command in the original proof is blocked by PRD-537's licence check, so the dump ran through `dumpMaterialGraphs` directly.

**Verification:** the box above.

#### Phase 2: Mask × tint materials bake to base colour
**Status:** DONE (2026-10-08)
**Files:** `src/unreal/material-graph.ts` (new evaluator), `src/unreal/materials.ts`, `tests/unreal-material-graph.test.ts`.
**Implementation:** Evaluate per texel. Fixture graphs are hand-written JSON copying the node shapes above, plus a 4×4 mask PNG with expected output pixels computed by hand.
- [x] AC-2 [local]: `MI_Cave_Rock_Pillar` ships a baked base colour whose mean differs from the neutral fallback, and its binding is `source: "graph"`. proof: parity run on Soul Cave + `npx vitest run tests/unreal-material-graph.test.ts` — Evidence (2026-10-08): full `importUnrealDirectory` on the live Soul Cave pack (importer v53) → section `MI_Cave_Rock_Pillar` has binding `baseColor=MI_Cave_Rock_Pillar_graph_baseColor` `source: graph`, `confidence: heuristic`, `textured: true`; the bake's mean colour is (0.404, 0.369, 0.308) in sRGB against the 0.8 grey fallback; three.js renders show the white rocks becoming cracked brown rock with unchanged geometry and normals. Unit evidence: `tests/unreal-material-graph.test.ts` (21 tests, pixel-exact fixtures with mutation checks on lerp, V orientation, sRGB decode, tiling) and `tests/unreal-graph-bake.integration.test.ts` (9 tests; the importer-level cases failed with the baker disabled). Run through `importUnrealDirectory` directly, because the `parity:fab` command is blocked by PRD-537's licence check (see Blocked on). Confidence is `heuristic`, not `exact`, because the master uses engine functions whose bodies are not in the pack (see Decisions).

**Verification:** the box above.

#### Phase 3: The library measures the gain
**Status:** PARTIAL — AC-3 ticked; AC-4 is active pending a true corpus baseline (see Remaining work)
**Files:** `scripts/fab-parity.ts` (unsupported-node histogram), `src/unreal/material-graph.ts` (the top node classes by count).
- [x] AC-3 [local]: Soul Cave passes S4 (≥ 90 % sections with colour). proof: parity run on Soul Cave — Evidence (2026-10-08): live pack, 203 import sections, 176 expect colour: **164 coloured = 93.2 %** (S4 `ok: true`), up from 79 = 44.9 % before this PRD (misses 97 → 12, −88 %). Graph outcomes: 88 baked (20 exact, 68 heuristic), 10 unsupported (`MatLayerBlend_Tint` 4, `DepthFade` 3, `ParticleColor` 2, one particle material), 33 unavailable (13 no source package, 11 parent graph outside the pack, 4 texture sample without texture, 3 no BaseColor output, 2 other). S3 identity stays at 0 violations over 190 verified sections. Measured with `importUnrealDirectory` + `dumpUnrealProperties` + `scorePack` (the same code `parity:fab` runs), not the CLI.

**Verification:** the boxes above.

### Power Plant107 real-pack checkpoint — 2026-10-11

Isolated candidate ec2ee59 completed the full65-model official import with fresh independent modern76/uncooked11 runtimes and unchanged frozen inputs. The same12samples/picture now score3OK/4suspect/5fail versus106’s3OK/2suspect/7fail: HueShift restores frame/door colour, but visual parity is still unproven. Metadata replay4/4passes; no existing Power Plant visual baseline, no ratchet. Actual reviewed JPEG and full result: [draftPR40 comparison](https://github.com/ThreeNativeHQ/threenative-asset-mcp/pull/40#issuecomment-6113203762). Runtime/source/GLB receipts remain in local `powerplant107-revalidation-vo2osnmf`; candidate’s exact production/test/scripts/config tree is now integrated in the draft PR checkout, with integrated typecheck/build and15/15packed-MCP smoke passing. Existing candidate2362-test default/leak evidence is reused; exact-head CI remains pending. No acceptance checkbox changes.

### Static-switch slice — 2026-10-11 (importer 111; the converter stays at 78)

**Complexity:** 3 → LOW (one importer rule and one test group; the planned native 79 build was not needed). Risk override: none. AC-4 above stays OPEN: the full corpus is not this slice.
**Problem.** A UE5 MaterialInstance whose master picks its BaseColor with `StaticSwitchParameter` nodes (Cloth Fuzzy Shading? → Albedo Map? → Tint By Mask?) shipped the raw native `Diffuse` albedo. The importer kept a bound texture whenever the active BaseColor path sampled it, so the tint-by-mask blend of that texture with a mask never reached the pixels.
**Correction to the earlier probe.** The probe read `--dump-properties`, which never lists switch rows. The converter 78 instance record (`--dump-graphs`) already holds the typed `StaticSwitchParameters` of the exact source instance: `Tint By Mask?` true, `Cloth Fuzzy Shading?` false, `Detail Normal?` true, each with `bOverride` true and an `ExpressionGUID`. `Albedo Map?` is not listed, so it keeps the master default. The UE4.27 "Computer" values are another artifact and are not used here. The converter, its version and its three version pins stay at 78.
**Consumer path.** native instance properties → parameter context (`parameters.switches`) → `material-graph.ts` evaluator (before `unoverriddenSwitch`) → source-qualified graph bake (`graph-baker.ts`, `source: "graph"`) → albedo pixels.
**Version.** `IMPORTER_VERSION` is 111 (it was 110). The new admission rule changes the shipped albedo, and the bump invalidates the reuse cache.

#### Phase 1: The instance's static switches reach the evaluator
**Status:** COMPLETE (satisfied at base `5a2395a`; no code change)
**Files:** none changed. Existing: `src/unreal/cue4parse-adapter.ts` (typed reader), `src/unreal/materials.ts` (`parsePropsFile`), `src/unreal/graph-baker.ts` (`chainParameters`), `src/unreal/material-graph.ts`.
- [x] AC-5 [local]: The 78 native dump of the exact source instance lists each authored static switch with name, value and `bOverride`, through CUE4Parse's typed `FStaticParameterSet`. proof: production `--dump-graphs --filter MI_Curtain_01a` on the source pack: exit 0, the three rows above; SHA-256 of the instance, the master and the 78 binary are equal before and after. — Evidence: local owned root `staticswitch79-uYpG8E07` (not committed; licensed names).
- [x] AC-6 [local]: The evaluator takes the instance value before the unoverridden-switch heuristic. Cases: true, false, absent, `bOverride = false`, child over parent. proof: the six-case group in `tests/unreal-effect-materials.test.ts` (below) plus the existing `chainParameters` and evaluator tests in `tests/unreal-graph-bake.integration.test.ts` and `tests/unreal-material-graph.test.ts`. — Evidence: with the genuine 78-pinned CUE4Parse, the focused run passes 649 of 649 tests in 5 files (Vitest 4.1.10, 83.70 s, log `/tmp/importer-albedo-pinned78-focused-tests.log`). With the default installed library, 602 of 604 tests pass in the four neighboring suites. The 2 failures are `reads each package by its own custom versions in one root (listed-at-x)`. That test compiles the converter against the installed CUE4Parse and fails with `Invalid bool value (77)` before any importer code runs. The same 2 tests fail on base `5a2395a`, and this diff touches no converter code. They pass with the 78-pinned library. The two libraries differ (`4e72e30d` vs `2a0bd9dd`, as recorded by the parent session and not recomputed here).

#### Phase 2: The switch values change the albedo that ships
**Status:** IN PROGRESS (admission done; paired real-pack canary run; independent check of the shipped albedo open)
**Files:** `src/unreal/importer.ts` (admission rule `partial`, next to the stale-base rule), `tests/unreal-effect-materials.test.ts`.
- [x] AC-7 [local]: Through `importUnrealDirectory`, a curtain-shaped master with `Tint By Mask? = true` bakes pixels equal to `lerp(ALB*baseTint, ALB*maskTint, clamp(pow(Mask.R*multi, contrast)))`, computed independently in the test (sRGB decode, linear mask, lerp in linear light, sRGB encode, tolerance 2), and different from the raw albedo. The rule applies only when a switch the instance chain itself overrides picks a branch that samples the bound texture and at least one other texture. A failed bake keeps the raw binding and reports it unverified, as for a stale binding. Absent, `false`, `bOverride = false` and child-over-parent `false` keep the raw binding and add no graph. — Evidence: red on `5a2395a` for the right reason (the two true cases: no bake, `section.graph` undefined, raw `Diffuse` stands); green after the change; 45 of 45 tests in the file pass.
- [ ] AC-8 [local]: One qualified UE5 curtain from the source pack imports through the production entry with the compiled converter and ships the switched albedo. — Evidence: PARTIAL, so the box stays open. The paired canary below shows that the rule fires on the real pack. It does not prove that the shipped pixels equal the switched albedo of the real master. No visual-parity claim is made.
  - Earlier canaries (2026-10-11 16:38–16:40 PDT) set `onlyPackages` to `SM_Curtains_01a`, through `createAssetImportUnrealHandler` → `importUnrealDirectory`. The filter then classified one package. The instance, master and texture packages never reached the modern decode, so no raw `Diffuse` existed and the rule never ran. The section material stayed unresolved (`graphBaked` 0, named PBR fallback). The cause was the request scope, not a wrong source and not a regression. With the full closure present, the same mesh route resolved the material.
  - Source (mixed format): the preserved download marker lists 282 files, and the pack holds 69 `SM_*` meshes, as the corpus expects. The corpus parameter GUIDs and the three switch GUIDs exist in the preserved `MI_Curtain_01a`. `readPackageCooking` reports `SM_Curtains_01a` as legacy -7, UE4 522, with no UE5 version. It reports `MI_Curtain_01a` and `MM_MasterMaterial_01a` as legacy -8, UE5 1004. The UE_5.0 label of the listing does not make the mesh a UE5 package.
  - Route: the mesh has no modern header, so `needsModernConverter` is false. The mesh goes to UE Viewer (exit 1, 0 meshes) and then to the uncooked MeshDescription converter. The materials and textures use the modern converter 78.
  - Paired canary 3, request: the closure has 12 packages (name-table closure, hard links). It holds the mesh, the instance, the master, one material function and eight textures. The canary called `importUnrealDirectory` with the typed request that the Fab handler sends: engine and `formatHint` UE_5.0, `sourceKind` fab-listing, `authenticatedDownload` true, `onlyPackages` and `maxTextureSize` undefined. It used the default `createGraphBaker`, `THREENATIVE_TOOLCHAIN_AUTOINSTALL=0`, and its own TMPDIR, cache and dotnet home. It omitted `licence` and `fabcliVersion` (provenance only) and did not assert `acceptFabEula`. It injected no fake converter, route or model.
  - Paired canary 3, result: the new run (`01f9a53`) and the base run (frozen checkout at `5a2395a`) both exited 0, in 31 s together. A third run that captured the instance properties also exited 0. SHA-256 of the 12 source files, the native 78 `ThreeNativeConverter.dll` and `CUE4Parse.dll`, and the frozen checkout HEAD and status are equal before and after the runs.
  - Raw baseline versus graph candidate: base `5a2395a` ships the raw `TX_Curtains_01a_ALB` (256×256, `source: props`, no graph) with `baseColorFactor` [0.1497, 0.1698, 0.2240]. New `01f9a53` ships `MI_Curtain_01a_graph_baseColor` (1024×1024, `source: graph`, `graphBaked` 1, status baked, `unsupportedNodes` empty). Its limitation says `TX_Curtains_01a_ALB` was dropped as base color because the graph samples `TX_Curtains_01a_ALB` and `TX_Curtains_01a_M`. The parent session read the shipped GLB factors: new [1, 1, 1, 1], base [0.149708, 0.169846, 0.223958, 1]. The tint is not applied twice.
  - Pixels (numbers only): the baked mean RGB is 72.6/72.7/76.7. The baseline effective color (ALB times factor, linear light) is 63.9/66.0/72.5. The mean absolute difference is 6.82 of 255. The luminance correlation is 0.887.
  - Master default (heuristic): the captured instance holds `Tint By Mask?` true, `Cloth Fuzzy Shading?` false and `Detail Normal?` true. Each has `bOverride` true and the same GUID as the 78 dump. `Albedo Map?` is not listed, so the bake takes the master default for it. The graph record has `confidence: heuristic` and the approximation "static switch values taken from the parent's defaults". That note probably comes from `Albedo Map?`. Nobody traced the node.
  - Normal and report: the normal stays "kept, unverified" (node n27 is a `FunctionCall`, and its engine content is absent). The import report still lists the mesh as failed ("UE Viewer export exited 1") although the GLB exists. Read that entry as historical. Both commits still report the authored-material reader refusal and "canonical mesh routing remains unresolved".
  - Exact gap: no render and no independent evaluation of the shipped albedo exist for the real master. AC-7 proves the blend formula only on a synthetic curtain-shaped master. The canary used a 12-package closure and called `importUnrealDirectory`, not the handler on the full pack. Close AC-8 after one of these checks: a render of the new output against the baseline, or an independent evaluation of the master graph.
  - Local evidence (not committed, licensed names): owned root `staticswitch79-uYpG8E07`, directory `replan/`.

**Not in this slice:** the full-pack import, the 86-variant sweep, the baseline ratchet, `FuzzyShading` (engine content, not in the pack), any gamma/mask/UV/vertex/camera default, any pack-name special case. Still open: AC-4, the full corpus, the visual comparison and the bake-off.

**Found, not fixed here:** a mesh-only `onlyPackages` request does not add the material and texture closure of the mesh. The smallest repair adds that closure at the filter, with a test where a mesh-only request must bind textures. The other option refuses a mesh-only request and names the missing materials. The admission rule needs neither.
