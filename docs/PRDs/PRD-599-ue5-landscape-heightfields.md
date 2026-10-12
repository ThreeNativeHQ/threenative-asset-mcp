# PRD-599 — UE5 landscape heightfields in levels

**Status:** IN PROGRESS
**Priority:** P2 — terrain export implemented; parent owns the comparison sheet and final repository gates.
**Complexity:** 3 (LOW) — 1–5 files (`src/unreal/cue4parse-adapter.ts`, `src/unreal/importer.ts`, `src/unreal/scenes.ts`), new module; risk override: none.
**Owner:** PRD-599 repair lane; parent owns orchestration
**Depends on:** PRD-598 (most UE5 levels keep their `LandscapeStreamingProxy` actors as World Partition external actors).

## Context

UE4 4.21–4.27 levels already convert landscapes: the uncooked Python decoder walks each `LandscapeComponent`, reads
its `HeightmapTexture` (mip 0, `TSF_BGRA8`), and decodes height as `((R<<8)|G) − 32768) / 128` with the normal in
B/A (`src/unreal/provision.ts:1017,1228-1298`). `src/unreal/scenes.ts:306-341,802-851` builds the indexed terrain grid
(cap 4M vertices, `sourceClass: "LandscapeComponent"`). Tests are synthetic only (`tests/unreal-scenes.test.ts:94,258,336`).

The UE5 level route has no landscape code: `landscapes = Array.Empty<object>()` at `src/unreal/cue4parse-adapter.ts:3538`
(level) and :3721 (Blueprint prefab); `ALandscape.LandscapeComponents` is never followed. UE5 editor texture sources
already decode, including `TSCF_UEDELTA` `TSF_BGRA8` and `TSF_G16` (`ExtractUeDeltaSourcePng`, :4487; formats :4543), but
only to PNG. Engine headers to confirm the UE5 fields (tracked, not checked out):
`Engine/Source/Runtime/Landscape/Classes/{Landscape,LandscapeComponent,LandscapeProxy,LandscapeStreamingProxy}.h`,
`Engine/Source/Runtime/Landscape/Public/LandscapeDataAccess.h`.

## Solution

1. In the UE5 level export, follow each landscape proxy's components and emit the same landscape record the UE4 path
   gives `scenes.ts` (component size, subsections, `HeightmapScaleBias`, transform, material, heights). Read the
   heightmap from the editor texture source with the existing source decoders, as raw pixels, not PNG.
2. Confirm the height encoding against `LandscapeDataAccess.h` before reuse; record it under Decisions.
3. `scenes.ts` builds the grid unchanged. Layer weights stay out of scope (ledger row stays Missing).

## Acceptance Criteria

- [x] AC-1 [local]: A real UE5 level with a landscape imports with a terrain mesh whose height range and footprint match the landscape actor's bounds stored in the package, within 1%. proof: real-pack gate in `tests/fab-feature-corpus.test.ts` — Evidence: `.584.9.1` / importer 122, 2026-10-12: native and actual public importer GLB gates pass for all 51 components from the same eight-file stage; node-world POSITION bounds within 1%, zero terrain omissions, `reused: false`, pinned provenance.
- [x] AC-2 [local]: A synthetic UE5 heightmap (known BGRA8 and `TSCF_UEDELTA` pixels) decodes to the expected heights. proof: red-to-green test beside `tests/unreal-converter-ue5-sources.test.ts` — Evidence: compiled BGRA8/UEDELTA known-height and public world-normal regression pass on `.584.9.1`; previous normal behavior fails for the expected direction.
- [ ] AC-3 [local]: Before/after terrain sheet attached to the PR and inspected by eye. proof: PR comment link — Evidence: pending.
- [ ] AC-4 [local]: Repository gates pass on the final head. proof: `npm run typecheck`, `npm test`, `npm run test:leaks`, `npx vitest run tests/mcp-smoke.test.ts` — Evidence: pending.

## Decisions

- Official engine reference: `5.8.3-release`, commit `396c9f059903aed5fec78ecd3d437a40c6415368`.
  `Engine/Source/Runtime/Landscape/Public/LandscapeDataAccess.h` confirms height decoding and,
  at lines 357–365, documents packed normals as already scaled but not rotated.
  `Engine/Shaders/Private/LandscapeVertexFactory.ush:515,559` transforms those normals with
  `LocalToWorldNoScaling`; `Engine/Source/Runtime/Landscape/Private/LandscapeRender.cpp:2298–2300`
  constructs it using `RemoveScaling()`, retaining mirrored basis signs.
- The UE5 export normalizes packed normals multiplied by absolute composed world scale before
  `scenes.ts` applies its node transform. This cancels glTF inverse scale while retaining mirrored
  signs. Invalid/zero scale explicitly omits the component with a reason. UE4 and heights are unchanged.
- Converter `.584.9.1`; importer remains 122 for this unreleased lane. All executable version pins updated.
- A bounded private eight-file source stage supplies 51 components. The gate checks both native
  arrays and every public GLB POSITION transformed by its node world matrix against independently
  stored `CachedLocalBox` and source parent chains, within 1%; zero terrain omissions and fresh
  importer/converter provenance are required. Licensed inputs, GLBs and index remain local-only.
- Payload fallback audit found first-match selection by size. Multiple same-size scan candidates now
  refuse explicitly rather than choose one. A unique size-only candidate remains a fallback; this
  is not a cryptographic identity check. No other toolchain cache is mutated.
- Honest red/green: replacing the normal helper with the previous unchanged-normal behavior fails
  the compiled-helper → public GLB world-direction assertion (nonuniform scale), without timeout;
  the compensated implementation passes both positive and mirrored nonuniform scales. The earlier
  BGRA8/UEDELTA test already covers known heights and subsection atlas boundaries. Layer weights remain out of scope.

## Local verification

Repair checks are recorded here; AC-3 and AC-4 remain pending parent delivery. The first two real-gate
launches failed before conversion because the rebuilt apphost could not discover .NET. A private
launcher now executes the converter DLL using the existing read-only SDK directly.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| UE5 landscape | `asset_import_unreal` → UE5 level route → CUE4Parse level export `landscapes` (`cue4parse-adapter.ts:3538`) → `scenes.ts` grid | Empty list replaced | AC-1 |

## Execution Phases

#### Phase 1: Pack and height encoding
**Status:** DONE
**Files:** `scripts/fab-slice.ts` (slice), notes under Decisions.
**Implementation:** Find a UE5 landscape pack; expand the sparse checkout with the Landscape paths; record the UE5 fields and encoding.
**Verification:** slice builds.

#### Phase 2: Converter landscape records
**Status:** DONE
**Files:** `src/unreal/cue4parse-adapter.ts`, `src/unreal/importer.ts`, tests.
**Implementation:** As in Solution 1. Bump converter tag and `IMPORTER_VERSION`.
**Verification:** AC-1, AC-2.

#### Phase 3: Evidence, ledger and gates
**Status:** NOT STARTED
**Files:** `docs/unreal-format-support.md` row "Landscape, UE5", `README.md` import table.
**Verification:** AC-3, AC-4.


- Real gate: 2 passed (23.39 s), private index `/home/joao/.cache/threenative-asset-mcp/prd599-real-proof/index.json`; source files SHA-256 checked before both imports.
- `npm run typecheck`: passed.
- Focused synthetic suites: 99 passed across converter source decoding, instance parameters and public scene assembly (38.54 s).
- Parent still owns AC-3 comparison sheets and AC-4 full repository gates; repair builds and test processes have finished.
