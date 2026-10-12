# PRD-599 — UE5 landscape heightfields in levels

**Status:** IN PROGRESS — review dispatch repair complete; parent fresh gates, independent review and CI pending
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
- [x] AC-2 [local]: A synthetic UE5 heightmap (known BGRA8 and `TSCF_UEDELTA` pixels) decodes to the expected heights. proof: red-to-green test beside `tests/unreal-converter-ue5-sources.test.ts` — Evidence: `.584.9.2` shares `TryDecodeLandscapeSourcePixels` between the actual texture reader and compiled synthetic harness. Raw BGRA8 and encoded UEDELTA both dispatch through it and assert the same known heights, normals, subsection atlas boundaries and mip-0 byte count; the public GLB nonuniform/mirrored normal regression remains. Disabling only its production UEDELTA branch compiles but fails the expected height assertion (-252.64844 vs -18.6953125), while raw passes; restored focused suites pass. Unsupported compression, PNG flag and truncated payload refusals are asserted.
- [x] AC-3 [local]: Before/after terrain sheet attached to the PR and inspected by eye. proof: PR comment link — Evidence: parent inspected actual before/after terrain and attached [PR52 comment](https://github.com/ThreeNativeHQ/threenative-asset-mcp/pull/52#issuecomment-6133268228). Same bounded eight-file stage, .584.8.1 blank terrain before and .584.9.1 public51-component GLB after. Production neutral renderer unchanged; existing fallback material, no layer-weight fidelity claim. Owner-only Drive permissions read back. Recipe and input/output SHA-256: raw/parent599-sheet.{mts,json}.
- [ ] AC-4 [local]: Repository gates pass on the final head. proof: `npm run typecheck`, `npm test`, `npm run test:leaks`, `npx vitest run tests/mcp-smoke.test.ts` — Evidence: parent normal-provisioner rebuild and all four gates pass on implementation7a04068: typecheck0.9s; default suite2,720 passed/17 skipped81.1s; leak gate clean89.6s; packed MCP15/15 in15.4s. Logs raw/parent599-final91-{typecheck,test,leaks,smoke}.log. These remain evidence for the prior implementation; parent must rerun all four and the real gate on `.584.9.2`.

## Decisions

- Height encoding: official LandscapeDataAccess.h:13,31–72; subsection duplicated-edge mapping
  :177–208,314–329; LandscapeDataAccess.cpp:15–17 rounds atlas bias and :140–148 transforms local
  vertices. Component fields are LandscapeComponent.h:437–501. LandscapeProxy.h:477–481 shares
  the landscape GUID across proxies; :527 SectionOffset is not added again because component
  relative location already accounts for it (Landscape.cpp:1387–1398).
- SceneComponent.cpp:120–132 supplies native identity scale and :727–753 defines parent composition.
  Source instances in this bounded proof have template-null components, no absolute flags and zero
  rotations; stored root/component transforms plus native defaults determine their bounds.

- Official engine reference: `5.8.3-release`, commit `396c9f059903aed5fec78ecd3d437a40c6415368`.
  `Engine/Source/Runtime/Landscape/Public/LandscapeDataAccess.h` confirms height decoding and,
  at lines 357–365, documents packed normals as already scaled but not rotated.
  `Engine/Shaders/Private/LandscapeVertexFactory.ush:515,559` transforms those normals with
  `LocalToWorldNoScaling`; `Engine/Source/Runtime/Landscape/Private/LandscapeRender.cpp:2298–2300`
  constructs it using `RemoveScaling()`, retaining mirrored basis signs.
- The UE5 export normalizes packed normals multiplied by absolute composed world scale before
  `scenes.ts` applies its node transform. This cancels glTF inverse scale while retaining mirrored
  signs. Invalid/zero scale explicitly omits the component with a reason. UE4 and heights are unchanged.
- Review repair converter `.584.9.2`; importer remains 122 for this unreleased lane. All executable version pins updated. Compression-tag normalization, exact validation, dispatch and mip-0 slicing now belong to one production helper used by both the actual texture reader and compiled fixtures.
- A bounded private eight-file source stage supplies 51 components. The gate checks both native
  arrays and every public GLB POSITION transformed by its node world matrix against independently
  stored `CachedLocalBox` and source parent chains, within 1%; zero terrain omissions and fresh
  importer/converter provenance are required. Licensed inputs, GLBs and index remain local-only.
- Payload fallback audit found first-match selection by size. Multiple same-size scan candidates now
  refuse explicitly rather than choose one. A unique size-only candidate remains a fallback; this
  is not a cryptographic identity check. No other toolchain cache is mutated.
- Honest red/green: replacing the normal helper with the previous unchanged-normal behavior fails
  the compiled-helper → public GLB world-direction assertion (nonuniform scale), without timeout;
  the compensated implementation passes both positive and mirrored nonuniform scales. The revised
  BGRA8/UEDELTA test reaches shared production dispatch and covers known heights and subsection atlas boundaries. Layer weights remain out of scope.

## Local verification

Prior implementation `.584.9.1` has parent real-gate, sheet and repository evidence; `.584.9.2` repair has focused synthetic and typecheck evidence only. Fresh parent gates, real proof and independent review remain pending. The first two real-gate
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
**Status:** PENDING — parent refresh after `.584.9.2` review repair
**Files:** `docs/unreal-format-support.md` row "Landscape, UE5", `README.md` import table.
**Verification:** AC-3, AC-4.


- Prior `.584.9.1` parent real gate: 2 landscape gates passed (34 total including generic tests; 5.79 s), private index `/home/joao/.cache/threenative-asset-mcp/prd599-real-proof/index91.json`; source files SHA-256 checked before both imports.
- `npm run typecheck`: passed.
- Prior `.584.9.1` focused synthetic suites: 99 passed across converter source decoding, instance parameters and public scene assembly (38.54 s).
- `.584.9.2` review repair: 142 focused tests passed across four suites (41.25 s); typecheck and diff checks passed. Normal provisioner rebuilt only the private PRD-599 cache; the existing launcher outside `modern/bin` reports `.584.9.2`. No build or test process remains active. An initial overlapping rebuild/test launch hit a missing-bin cache window; the final test run followed the completed rebuild.
- Parent completed AC-3 and AC-4 on `.584.9.1`; final `.584.9.2` evidence is pending.
- Review repair logs: `raw/599-review-repair-mutation-red.log`, `raw/599-review-repair-green.log`, `raw/599-review-repair-typecheck.log`, `raw/599-review-repair-native-build.log`. Private `index92.json` preserves the same source hashes and uses fresh output paths; the native/public real gate remains for the parent.
