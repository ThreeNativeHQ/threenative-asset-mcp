# PRD-584 — Export Cascade and Niagara effects as portable descriptors

**Status:** IN PROGRESS
**Priority:** P3 — optional: AC-1 to AC-6 give no visible result until `threenative-engine` builds a particle runtime, and João flagged VFX as skippable on 2026-10-11.
**Complexity:** 5 (MEDIUM) — 1–5 implementation files (1), new effects module (+2), crosses the .NET converter / Node importer boundary (+2); risk override: none
**Owner:** João
**Depends on:** PRD-581 (Soul: Cave and VTOL Dust slices)

## Context

Cascade `ParticleSystem` and Niagara `NiagaraSystem`/`NiagaraEmitter` are **Reported** (`UNSUPPORTED_CLASSES`,
`importer.ts:504`). Level components that hold them are listed under `omittedActors` (adapter 2385–2392 and
2514–2525). Effect *materials* already convert (`tests/unreal-effect-materials.test.ts`).

A file-converter cannot make an effect play: Three.js has no particle runtime. This PRD exports a small,
portable **descriptor** that a runtime in `threenative-engine` can consume later. It does not translate
Unreal's simulation. The findings below were read from the source only, because no Cascade or Niagara
package was on disk during the 2026-10-11 probe.

- **Cascade** (`ParticleSystem.h`, `ParticleEmitter.h`, `ParticleLODLevel.h`; the class model is frozen since UE4).
  - All tagged sub-exports: `UParticleSystem.Emitters[]` → `UParticleEmitter.LODLevels[]` → `UParticleLODLevel`
    (`RequiredModule`, `SpawnModule`, `TypeDataModule`, `Modules[]`). `Modules[]` order is the evaluation order.
  - CUE4Parse has no typed classes except `UParticleModuleRequired` and `USubUVAnimation`, so the rest load as
    generic `Properties` (expected to work; unverified).
  - **Values are distributions.** An `FRawDistributionFloat/Vector` holds a baked `Table` (`TimeScale`, `TimeBias`,
    `Values`, `Op`, strides) and an instanced `Distribution` sub-export (`Constant`, `ConstantCurve`, `Uniform`,
    `UniformCurve`, `ParticleParameter`). CUE4Parse has no distribution classes.
  - Cooked data drops `Distribution` and keeps only `Table` (`Distributions.cpp:1060–1090`). Editor packs (Fab)
    should keep both.
  - The `Table` lookup formula is inferred from `ResampleLookupTable` (`Distributions.cpp:610–640`).
- **Niagara** (`NiagaraEmitter.h:268–427`, `NiagaraScript.h:353–440, 883`).
  - **Exportable:** emitter handles; versioned emitter data (`SimTarget`, `bLocalSpace`, bounds); renderer
    properties (sprite, mesh, ribbon, light: material, alignment, facing, sub-image size); user parameters;
    and `RapidIterationParameters`, which holds module input values keyed
    `Constants.<Emitter>.<Module>.<Input>`.
  - **Not feasible:** behavior lives in module graphs and VectorVM bytecode, and translating it needs a Niagara
    interpreter. Emitters may also inherit from engine content that is not in the pack, the same gap
    `engine-content.ts` handles for materials.

## Solution

**Consumer flow.** `asset_import_unreal` → the adapter writes `Effects/<system>.cascade.json` or
`Effects/<system>.niagara.json` → the importer lists each one in `import-report.json`. The class leaves the
skipped list, with `limitations` that name what was not exported. A future engine runtime reads the JSON.

**Descriptor (shared, not Unreal-shaped).**

```text
{ system, source: cascade|niagara, warmup, bounds, emitters: [{
    name, renderer: sprite|mesh|ribbon|beam|light, material, subUV, localSpace, sort,
    duration, loops, delay,
    spawn: {rate: Curve, bursts},
    init: {lifetime, size, velocity, color, rotation, rotationRate}: Curve | Range,
    overLife: {color, alpha, size}: Curve,
    forces: {acceleration, drag},
    limitations: [string] }] }
```

A `Curve` is `{keys: [{t, v, arriveTangent, leaveTangent, interp}]}` and a `Range` is `{min, max}`.

- **Cascade:** export LOD level 0. Map the common modules: `Required`, `Spawn`, `Lifetime`, `Size`,
  `Velocity`, `Color`, `ColorOverLife`, `SizeScale`, `Rotation`, `RotationRate`, `Acceleration`, `SubUV`.
  Any other module goes into `limitations` by class name.
- **Niagara:** fill the same fields from renderer properties and from the `RapidIterationParameters` of
  well-known modules: `SpawnRate`, `SpawnBurstInstantaneous`, `InitializeParticle`, `ColorFromCurve`,
  `ScaleSpriteSize`, `SolveForcesAndVelocity`, `GravityForce`, `DragForce`. Every other module, and every
  data interface, is listed under `limitations`.

**Risks.**

- Distribution decoding is the crux. AC-2 cross-checks the two serializations against each other.
- GPU Cascade emitters (`PGPU_*`) and vector fields are approximations: mark them, never fake them.
- Niagara module identity depends on script paths into engine content that is not in the pack.

## Acceptance Criteria

- [x] AC-1 [local]: Every Cascade system in the Soul: Cave slice becomes a `.cascade.json`. The emitter count equals `Emitters[]`, and each sprite emitter has a material, spawn and lifetime values, and a list of every unmapped module. proof: the real `asset_import_unreal` run over `fab-slices/soul-cave-4.18` (only `P_flyingPaper`) writes `Effects/P_flyingPaper.cascade.json`, 1 emitter, material `M_paper`, lifetime 3..5, spawn bursts and ordered limitations — Evidence: `/home/joao/.cache/threenative-asset-mcp/prd584-proof/after-soul/{import-report.json,Effects/P_flyingPaper.cascade.json}` (importer 117, converter `b4e95441+threenative.584.1`). The class leaves the skipped list.
- [x] AC-2 [local]: For every distribution that has both forms, evaluating the `Distribution` object and the baked `Table` agrees within 1% at 16 sample times. The test is red if the `Table` formula is wrong. proof: synthetic cross-check in `tests/unreal-effects.test.ts` (green on a uniform 3..5 object vs its `Table`, red when the table's two lanes are collapsed), plus the real corpus half below — Evidence: enumerating every dual-form tag in the real Soul dump finds 17 distributions; 14 agree at 16 samples within 1% (worst 5.3e-7), and the 3 `Distribution*ParticleParameter` cases now carry a source-backed **no-owner default** instead of only "unresolved": with `Data == nullptr` the particle-parameter `GetParamValue` returns false (`ParticleModules.cpp:4618`, `:4631`) so `UDistribution*ParameterBase::GetValue` (`Distributions.cpp:4259`, `:4298`) uses the inherited `Constant` and the `ParamMode(s)` remap. The real run reports default `[0]`, `[0]`, `[1,0.7,0.4]` and `tableBaked=false` (a parameter distribution sets `CanBeBaked()==false`, so its `Table` is empty and no false agreement is claimed); `AC2_TOTAL dual=17 agree=14 dynamic=3 failures=0`. The dynamic-parameter limitation stays on the descriptor, and `crossCheckDistribution` still skips a particle parameter rather than passing it. `Distribution` objects and `Table`s are not genuinely different; no decoder change was needed.
- [x] AC-3 [local]: Each of the 3 VTOL Dust systems becomes a `.niagara.json` with the renderer type and material, `SimTarget`, and the mapped module values from `RapidIterationParameters`. Unmapped modules are listed. proof: the real `asset_import_unreal` run over `fab-slices/vtol-5.4` writes all three descriptors — Evidence: `/home/joao/.cache/threenative-asset-mcp/prd584-proof/after-vtol/{import-report.json,Effects/NS_*.niagara.json}`. All 3 leave the skipped list; the run exits 0 with no failures. UE Viewer cannot list these UE5 packages, so `EFFECT_CLASS_HINTS` (`src/unreal/cooking.ts`) names the class from the package name table.
- [x] AC-4 [local]: A level that places a Cascade or Niagara component lists it in `omittedActors` with a pointer to the exported descriptor, instead of "not yet reconstructable". proof: `npx vitest run tests/unreal-effects.test.ts -t level` (synthetic level through the importer) — Evidence: the two adapter `omittedActors` sites (`cue4parse-adapter.ts` level ~2483 and Blueprint ~2621) now emit `descriptor = Effects/<system>.<cascade|niagara>.json` with the honest reason, and keep an explicit "no serialized system reference" omission (no pointer) when the source is missing. `assembleSceneGlb` reconciles every omission against the descriptors actually written (`effectDescriptors`), keeping the pointer only when exactly one written record matches the full path and canonical source package — a missing descriptor or a basename collision leaves an explicit reason and no dangling pointer, for both the level and the Blueprint placement. `tests/unreal-effects.test.ts` drives the public `importUnrealDirectory` with the fake converter: the level and Blueprint placements keep the pointer and the descriptor is on disk; a missing descriptor, a no-source component, and a run that writes no descriptor all stay pointerless with explicit reasons. 34/34 pass.
- [x] AC-5 [local]: The descriptor JSON validates against one committed schema (`src/unreal/effects-schema.ts`) for both sources. proof: `validateEffectDescriptor` accepts all four real descriptors written by the public import (1 cascade, 3 niagara), and the schema tests in `tests/unreal-effects.test.ts` pass — Evidence: 4/4 real descriptors valid; 26/26 `tests/unreal-effects.test.ts` pass.
- [x] AC-6 [local]: The ledger rows for Cascade and Niagara move from Reported to Implemented (descriptor) with evidence. Repository gates are green: `npm run typecheck`, `npm run test:leaks` with default workers, and `npx vitest run tests/mcp-smoke.test.ts`. proof: those commands and the ledger diff — Evidence: GREEN 2026-10-12 on the rebased head (importer 117, executed private converter `b4e95441+threenative.584.4`): ledger rows moved to Verified (descriptor) with the executed corpus run; corpus gates `cascade`, `cascade-distributions` and `niagara` pass on Soul: Cave 4.18 and VTOL 5.4; `npm run typecheck` clean, `npm run test:leaks` (147 files, 2693 tests, leak-gate clean) and `npx vitest run tests/mcp-smoke.test.ts` (15 tests) green.
- [x] AC-7 [local]: Every PR attaches before/after sheets per the epic `README.md` evidence rule. Before: nothing, because the class is skipped. After: a preview sheet of each system at 4 times, drawn by a minimal sprite-only preview in the tile renderer from the descriptor, beside Unreal's editor thumbnail of the system where the package has one. proof: the PR comment with sheets — Evidence: GREEN 2026-10-12: four sheets (1 Cascade, 3 Niagara) inspected by eye, in the PR #46 comment (assets branch `feat/unreal-effects-data-assets`). Before is a blank anchor because the base writes no descriptor; the judge fails every after tile as a speck (0.01% to 0.2% coverage) because the sprite preview draws a few cards, and this is stated in the comment.

## Blocked on

- A Three.js particle runtime that plays these descriptors — unblocked by a separate `threenative-engine` PRD (not filed). Until it exists, the AC-7 sprite preview is the only visual check, and it approximates the effect, not Unreal's simulation.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Effect descriptors | `asset_import_unreal` → adapter effects writer → `Effects/*.json` (fill lines) | Replaces the `UNSUPPORTED_CLASSES` entries for `ParticleSystem`, `NiagaraSystem` and `NiagaraEmitter` | AC-1, AC-3 |
| Level effect placement | adapter `omittedActors` entries (2385–2392, 2514–2525) | Now point to the descriptor | AC-4 |

## Decisions

- 2026-10-11 (agent): export descriptors only. Translating Niagara graphs or bytecode, and building a runtime, are out of scope (see Context).
- 2026-10-11 (agent): no UE5 Cascade slice and no small UE4 Niagara slice. The gaps are recorded in PRD-581's coverage matrix.
- 2026-10-11 (agent): first lane ships the shared schema and distribution decoder only. `src/unreal/effects-schema.ts` holds the Zod descriptor and the `Distributions.cpp`/`Distributions.h` table lookup and cross-check. The converter writer, importer sidecar wiring and `omittedActors` pointer remain. The pinned CUE4Parse patch version moved to `b4e95441+threenative.584` to name this lane's writer when it lands.
- 2026-10-11 (agent): Niagara reads through the same generic tagged transport as Cascade — CUE4Parse's typed path (`FNiagaraVariableWithOffset`, `FNiagaraTypeDefinition`) is reached via the tagged `RapidIterationParameters` store, so no separate typed writer is needed. The registered input's source-declared type sets the width; the offset gap is a fallback only and is marked `widthSource: "offset"`. Every decoded RIP entry is preserved in the descriptor's `rapidIteration`, and an absent stored SpawnRate override is stated as unresolved (default unavailable), never written as a zero. `IMPORTER_VERSION` is 116 (main 113, PRD-582 114, PRD-583 115).
- 2026-10-11 (agent): the shared converter cache holds `b4e95441+threenative.82`, which predates `--dump-effects`; the real VTOL Niagara import needs a `.584` build in an isolated toolchain directory, so it is not run from this working tree. The adapter `--dump-effects` writer now admits `NiagaraSystem`/`NiagaraEmitter` packages.
- 2026-10-12 (agent): the real bounded proof ran. The pinned adapter (`b4e95441+threenative.584.1`) was compiled once through the harness's `compileProject` (Program.cs + EngineContent.cs against the pinned CUE4Parse assemblies) into a private build, and driven by `importUnrealDirectory` with the heap capped at 1 GiB and a private umodel. `IMPORTER_VERSION` is 117 (main 113, PRD-582 114, PRD-583 115, PRD-584 116). UE Viewer cannot list UE5 Niagara packages, so `EFFECT_CLASS_HINTS` in `cooking.ts` names the effect class from the name table; without it the VTOL systems were failed listings, not effects. Proofs are preserved under `/home/joao/.cache/threenative-asset-mcp/prd584-proof/after-{soul,vtol}` (never deleted). AC-4 (level pointer) and the AC-6 leak/smoke gates remain.
- 2026-10-12 (agent): AC-4 landed. The adapter points each level and Blueprint effect component at `Effects/<system>-<hash>.<cascade|niagara>.json` and keeps an explicit no-source omission; the importer reconciles every scene omission against the descriptors actually written, matching the full descriptor path and canonical source package so a basename collision or a failed export never leaves a dangling pointer. AC-2 now also evaluates the source-backed no-owner default of a `Distribution*ParticleParameter` (`Constant` plus `ParamMode(s)` remap) and reports that its `Table` is not baked (`CanBeBaked()==false`); the dynamic-parameter limitation stays on the descriptor.
- 2026-10-12 (agent): five fresh-eyes review findings fixed in the Node core only (`effects-schema.ts`, `effects-dump.ts`, `importer.ts`; `effects-preview.ts` untouched). (1) Cascade `ParticleModuleAcceleration`/`ParticleModuleDrag` now fill `forces`, and `ParticleModuleAccelerationOverLifetime` is named as an unsupported over-life application. (2) `ParticleModuleTypeDataLight`/`Sprite` map to `light`/`sprite`; an unknown type data is named, never defaulted silently. (3) Niagara decodes `SpawnBurstInstantaneous` bursts with an int-aware `Spawn Count`, `SolveForcesAndVelocity` `Acceleration Limit`/`Speed Limit`, and names the unexported inputs of `ColorFromCurve`/`ScaleSpriteSize`, so no mapped module exports nothing silently. (4) `ParticleModuleRequired` `EmitterDuration`/`EmitterDurationLow`, `EmitterLoops`, `EmitterDelay` and system `WarmupTime` are exported; a duration or delay the shared schema cannot hold as a range carries the high value plus an explicit approximation. (5) `writeUnrealEffects` isolates each package (a build or write failure is reported, never aborts the import), sanitizes the descriptor file name, refuses a duplicate system name instead of overwriting, and the importer clears the skip list by canonical package key (`gamePackageKey`), not a raw basename. In that round `IMPORTER_VERSION` stayed 117 and the converter stayed `b4e95441+threenative.584.1` (no C# serialized-shape change). Direct regression tests added to `tests/unreal-effects.test.ts` (44 pass with `npm run typecheck`). The stored real descriptors predate these fields, so the AC-1/AC-3 real proofs must be re-run after this head.
- 2026-10-12 (agent): the final source-review replan, one bounded correction across `effects-schema.ts`, `effects-preview.ts`, `cue4parse-adapter.ts` (C#) and the tests. (1) A stored Niagara `SpawnRate.Spawn Rate` now fills `spawn.rate`; present and absent cases are tested. (2) Cascade `init.size` reads `StartSize` only from `ParticleModuleSize`; `ParticleModuleSizeScale.SizeScale` and `ParticleModuleSizeMultiplyLife.LifeMultiplier` fill `overLife.size`. `ParticleModuleSpawnPerUnit`, `ParticleModuleVelocityOverLifetime`, `ParticleModuleColorScaleOverLife` and `ParticleModuleAccelerationOverLifetime` are no longer marked mapped and are named as limitations; a table-driven regression exercises every supported common module, so a class that stops being read fails the suite. (3) Niagara reads `InitializeParticle.Initial Velocity` into `init.velocity`, and every stored input of a mapped module the mapper did not consume is named, tracked when a portable field is actually assigned rather than at the lookup (so a stored half of a pair, for example `Lifetime Min` with no `Lifetime Max`, cannot disappear) rather than a hand-maintained list (so Mass, Position and similar cannot disappear silently). (4) The sprite preview scales each card by `overLife.size` at the particle's age; a test asserts the GLB node scales differ across sample times. (5) `EffectDump.EffectDescriptorPath` is the one production path helper, called by the level pointer and by the compiled harness; it sanitizes exactly as the Node `effectDescriptorFileName`, so `P fire` gives `Effects/P_fire.cascade.json` for both sources and a null reference gives no pointer. The C# change bumped the converter to `b4e95441+threenative.584.3`; `IMPORTER_VERSION` stays 117. The preserved real Soul/VTOL descriptors were written with `.584.1`, so re-running the AC-1/AC-3 real proofs at `.584.3` is a remaining gate, as are the AC-6 leak/smoke gates.
- 2026-10-12 (agent): rotation units recorded and the preview option removed. `init.rotation` and `init.rotationRate` are portable **radians** and **radians per second**; the builders convert at the boundary. Cascade turns and turns/sec multiply by 2π (`ParticleModules.cpp:1803`, `:1884`), Niagara degrees multiply by π/180 (`NiagaraSpriteVertexFactory.ush:813`), and `tests/unreal-effects-preview.test.ts` pins the radian quaternion. Any value a descriptor channel cannot hold stays as a listed limitation, so a mapped module is never silent. The preview has no caller option for the particle cap: `EFFECT_PREVIEW_PARTICLE_CAP` (24) is the one fixed contract, and `writeBlankEffectPreviewGlb` shares `particleSamples`/`anchorBounds` with the descriptor preview.
- 2026-10-12 (agent): collision-safe canonical descriptor identity, matching blank-preview framing and docs. (1) The descriptor file name is now `<sanitized-system>-<sha256-16>.<cascade|niagara>.json`; the hash is the first 16 hex digits of SHA-256 over the canonical package-and-object key, normalized exactly like `gamePackageKey` (a `Content` prefix and a mount drop, lowercased). Two packages with the same basename in different folders therefore both export, and two names that only collide after sanitization (`P fire` vs `P_fire`) stay unique. The one path helper `effectDescriptorFileName` now requires `{package, system}`, so an absent package is a reported failure, never an ambiguous fallback. (2) The single writer refuses only the same canonical identity written twice; the importer clears both same-basename packages from its skip list by canonical package key. (3) The compiled C# `EffectDump.EffectDescriptorPath(system, canonicalObjectPath, niagara)` mirrors the Node rule and the level pointer passes the typed reference's resolved canonical object path (`DumpPath`), never a raw name or the owner graph; the compiled harness asserts parity for `/Game` paths, whitespace, slashes, Unicode/malicious names, a case/mount variant and NULL. (4) `writeBlankEffectPreviewGlb` now reuses the descriptor preview's own invisible framing anchor (computed by the shared `particleSamples`/`anchorBounds`) with no particle, so a before/after pair shares one camera and box; it is a framing placeholder and never claims the base produced a GLB. The C# change keeps the converter at `b4e95441+threenative.584.3`; `IMPORTER_VERSION` stays 117. Remaining gates: re-run the AC-1/AC-3 real bounded runs at this head and regenerate the AC-7 preview/blank contact sheets by eye.
- 2026-10-12 (agent): PRD-584 final-audit fix, Node only (`effects-schema.ts`, `tests/unreal-effects.test.ts`). The Niagara unused-input scan no longer marks an input consumed at the lookup; it consumes a stored input only when its portable field is assigned. A stored half of a paired input (`Lifetime Min`/`Max`, `Sprite Rotation Angle Min`/`Max`, `Color Minimum`/`Maximum`, `Spawn Time` without `Spawn Count`) previously marked itself consumed at lookup, so it was neither exported nor named. Four regression tests pin the named limitation. `IMPORTER_VERSION` stays 117 and the converter is unchanged.

## Execution Phases

#### Phase 1: Cascade descriptors and distributions
**Status:** IN PROGRESS — shared schema, corrected distribution decoder, Node Cascade builder (`buildCascadeDescriptor`), the adapter `--dump-effects` tagged writer, and the importer wiring (writes `Effects/<system>.cascade.json`, lists it under `effects`) have landed. The real bounded run on the Soul: Cave slice emits one descriptor with the emitter count, material, spawn, lifetime and ordered unmapped-module limitations, and the real-corpus AC-2 enumeration passes (14/17 within 1%; the 3 particle-parameters carry a source-backed no-owner default and an unbaked table). Remaining: the AC-6 leak/smoke gates.
**Files:** `src/unreal/cue4parse-adapter.ts` (Cascade writer, distribution reader), `src/unreal/effects-schema.ts` (new), `src/unreal/effects-dump.ts` (new), `src/unreal/importer.ts` (classification and skip list), `tests/unreal-effects.test.ts` (new).
**Implementation:**
1. Probe a Soul: Cave system with the CUE4Parse generic reader first, to confirm the tagged layout.
2. Read `Distribution` when it is present. Otherwise evaluate `Table`.
3. Map the common modules and list the rest under `limitations`.

**Verification:** AC-1, AC-2, AC-5.

#### Phase 2: Niagara descriptors, levels, ledger and gates
**Status:** IN PROGRESS — the Node Niagara builder (`buildNiagaraDescriptor`), the `.niagara.json` writer, and the importer classification (Niagara packages now leave the skipped list, `IMPORTER_VERSION` 117) have landed. The rebuilt `.584` converter and the real bounded VTOL run write all 3 systems, and the level/Blueprint `omittedActors` pointer with importer reconciliation has landed (AC-4). Remaining: the AC-6 leak/smoke gates and the AC-7 sheets.
**Files:** `src/unreal/effects-schema.ts` (Niagara mapping), `src/unreal/effects-dump.ts` (`.niagara.json`), `src/unreal/cue4parse-adapter.ts` (effect-package admission and `omittedActors` pointer), `src/unreal/importer.ts` (`EFFECT_CLASSES`, effect reconciliation, `IMPORTER_VERSION` 117), `src/unreal/scenes.ts` (`effectDescriptors` reconciliation), `tests/unreal-effects.test.ts`.
**Implementation:** Read the emitter handles and versioned data, the renderer properties, and `RapidIterationParameters`. Map the known modules by script path.
**Verification:** AC-3, AC-4, AC-6, AC-7 (sheets for every phase's PR).

### Bounded source/proof hardening (2026-10-12)

Complexity: 1 → LOW; risk override: none. Scope: the private final/render proof runners and `tests/helpers/effects-corpus.ts`; production renderer and converter unchanged.

1. [local] Compare complete sorted input trees across before/after; reject changed slices before importing.
2. [local] Bind both report pairs and captions to recorded full HEAD, complete source/code digests, native version/hash and live input trees; reject absent or inconsistent identities.
3. [local] Require clean executed checkouts: before source matches the accepted base across all `src`, after tracked/untracked checkout changes are absent; record actual HEAD and code SHA.
4. [local] Require nonempty real RIP stores and the common source inputs verified in all three stored systems before existing raw-field comparisons.
5. [local] Wrap every caption and limitation and size the canvas from actual lines; preserve separate neutral metrics and picture identities.

Checks: repository and both private scripts typecheck clean; existing Node effects/preview suites pass 88/88. Private synthetic self-checks reject dirty/untracked source, added input files, absent identity, wrong mode/SHA/input/native hash; caption layout retains all 12 long limitations with every text baseline inside the canvas; no native build, imports, screenshots or full gates authorized in this correction. Before converter-89 metadata remains pending: accepted source base, full executed HEAD/code digests, converter version/DLL hash and corresponding report paths must be filled after the parent patch; existing converter-88 slots remain deliberately unchanged.
