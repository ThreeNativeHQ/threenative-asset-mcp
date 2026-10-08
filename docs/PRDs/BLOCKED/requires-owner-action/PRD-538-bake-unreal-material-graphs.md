# PRD-538 — Bake common Unreal material graphs into glTF PBR textures

**Status:** PARTIAL — Phases 1–3 landed (PR #31); AC-1–AC-3 ticked on the live Soul Cave pack.
**Blocker:** AC-4 needs PRD-537's corpus baseline, which needs João to clear Fab's browser verification (or approve `--assume-licence`); see Blocked on.
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

## Blocked on

- **AC-4** S4 failures across the PRD-537 corpus fall by at least half from PRD-537's final baseline. proof: `npm run parity:fab -- --corpus library --baseline <PRD-537 scorecard>`. Needs the corpus sweep, which needs the owner to clear Fab's browser verification (or approve `--assume-licence`); see PRD-537 Blocked on. The tooling is done: the scorecard carries the unsupported-node histogram, S4-miss attribution and `--baseline` delta. On the one pack available, S4 misses fell 97 → 12 (−88 %); the next nodes by count are `MatLayerBlend_Tint` (4 sections) and `DepthFade` (3).

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
**Status:** PARTIAL — AC-3 ticked; AC-4 is under Blocked on
**Files:** `scripts/fab-parity.ts` (unsupported-node histogram), `src/unreal/material-graph.ts` (the top node classes by count).
- [x] AC-3 [local]: Soul Cave passes S4 (≥ 90 % sections with colour). proof: parity run on Soul Cave — Evidence (2026-10-08): live pack, 203 import sections, 176 expect colour: **164 coloured = 93.2 %** (S4 `ok: true`), up from 79 = 44.9 % before this PRD (misses 97 → 12, −88 %). Graph outcomes: 88 baked (20 exact, 68 heuristic), 10 unsupported (`MatLayerBlend_Tint` 4, `DepthFade` 3, `ParticleColor` 2, one particle material), 33 unavailable (13 no source package, 11 parent graph outside the pack, 4 texture sample without texture, 3 no BaseColor output, 2 other). S3 identity stays at 0 violations over 190 verified sections. Measured with `importUnrealDirectory` + `dumpUnrealProperties` + `scorePack` (the same code `parity:fab` runs), not the CLI.

**Verification:** the boxes above.
