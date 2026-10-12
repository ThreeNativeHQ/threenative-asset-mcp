# PRD-599 — UE5 landscape heightfields in levels

**Status:** NOT STARTED
**Priority:** P2 — AC-1..AC-3 open: a UE5 level's terrain is missing from its import; the converter always writes an empty `landscapes` list.
**Complexity:** 3 (LOW) — 1–5 files (`src/unreal/cue4parse-adapter.ts`, `src/unreal/importer.ts`, `src/unreal/scenes.ts`), new module; risk override: none.
**Owner:** unassigned
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

- [ ] AC-1 [local]: A real UE5 level with a landscape imports with a terrain mesh whose height range and footprint match the landscape actor's bounds stored in the package, within 1%. proof: real-pack gate in `tests/fab-feature-corpus.test.ts` — Evidence: pending.
- [ ] AC-2 [local]: A synthetic UE5 heightmap (known BGRA8 and `TSCF_UEDELTA` pixels) decodes to the expected heights. proof: red-to-green test beside `tests/unreal-converter-ue5-sources.test.ts` — Evidence: pending.
- [ ] AC-3 [local]: Before/after terrain sheet attached to the PR and inspected by eye. proof: PR comment link — Evidence: pending.
- [ ] AC-4 [local]: Repository gates pass on the final head. proof: `npm run typecheck`, `npm test`, `npm run test:leaks`, `npx vitest run tests/mcp-smoke.test.ts` — Evidence: pending.

## Blocked on

- A real UE5 pack with a landscape level in the owner's library. None is named in the docs; Medieval Village 5.3 is a candidate to check. Unblocked by finding one in Phase 1 or by João naming one.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| UE5 landscape | `asset_import_unreal` → UE5 level route → CUE4Parse level export `landscapes` (`cue4parse-adapter.ts:3538`) → `scenes.ts` grid | Empty list replaced | AC-1 |

## Execution Phases

#### Phase 1: Pack and height encoding
**Status:** NOT STARTED
**Files:** `scripts/fab-slice.ts` (slice), notes under Decisions.
**Implementation:** Find a UE5 landscape pack; expand the sparse checkout with the Landscape paths; record the UE5 fields and encoding.
**Verification:** slice builds.

#### Phase 2: Converter landscape records
**Status:** NOT STARTED
**Files:** `src/unreal/cue4parse-adapter.ts`, `src/unreal/importer.ts`, tests.
**Implementation:** As in Solution 1. Bump converter tag and `IMPORTER_VERSION`.
**Verification:** AC-1, AC-2.

#### Phase 3: Evidence, ledger and gates
**Status:** NOT STARTED
**Files:** `docs/unreal-format-support.md` row "Landscape, UE5", `README.md` import table.
**Verification:** AC-3, AC-4.
