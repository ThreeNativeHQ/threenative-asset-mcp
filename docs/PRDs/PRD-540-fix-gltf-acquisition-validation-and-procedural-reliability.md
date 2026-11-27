# PRD-540 — Fix glTF Acquisition Validation, Repair Broken Catalog GLBs, and Guarantee Procedural Asset Reliability

**Status:** NOT STARTED
**Priority:** P0 — `asset_download` failed 8/8 (100%) in Claude Fable (`Unsupported glTF required extension`) and 7/15 (47%) in `dsh` (`Missing or incomplete GLB embedded buffer`) on ThreeNative's own `threenative:*` catalog; procedural and catalog assets MUST work instead of being skipped.
**Complexity:** 6 (MEDIUM)
**Owner:** Unassigned
**Depends on:** None

## Context

Trace inspection across 12 recent 30-minute Studio runs (`2026-11-26/27`) exposed severe `asset_download` failures against ThreeNative's own catalog (`threenative:*`), wasting 5–10 turns per `assets` lane and forcing models to fall back to hand-coded placeholders:

1. **100% failure in Claude Fable (`2026-11-27T02-57-21-461Z-racing`, 8/8 calls failed):**
   - `threenative:b8a8db27-...`, `d815cefe-...`, `1bd0277e-...`, `b0ce9eb7-...` all returned `{"code":"ASSET_REQUEST_FAILED","message":"Unsupported glTF required extension."}` from `src/discovery/acquisition.ts:192-207`.
   - `acquisition.ts:197-204` hardcodes an outdated 6-item `extensionsRequired` allowlist (`KHR_materials_unlit`, `KHR_mesh_quantization`, `KHR_texture_transform`, `KHR_materials_pbrSpecularGlossiness`, `KHR_draco_mesh_compression`, `EXT_meshopt_compression`), rejecting modern Khronos PBR extensions (`KHR_materials_clearcoat`, `KHR_materials_ior`, `KHR_materials_specular`, `KHR_materials_emissive_strength`, `KHR_materials_transmission`, `KHR_texture_basisu`, `EXT_texture_webp`, etc.) that Three.js and `@threenative/core` already support!
2. **47% failure in `dsh` (`2026-11-27T02-06-05-945Z-cairn-climb`, `threenative:892e559d-...`, `e3310e2d-...`, `ee2504c4-...`):**
   - Returned `{"code":"ASSET_REQUEST_FAILED","message":"Missing or incomplete GLB embedded buffer."}` from `src/discovery/acquisition.ts:224-230`.
   - `acquisition.ts:227-228` enforces `binaryLength < byteLength || binaryLength > byteLength + 3`, which falsely rejects valid GLBs whose binary chunk carries padding beyond 3 bytes or multi-view alignment, OR misses repair when an external buffer/data URI needs embedding.
3. **Owner directive (João, 2026-11-27):** *"on asset search if its procedural it MUST work instead of skipping stuff, fix it."* Procedural recipes (`src/procedural/catalog.json`, 1,419 lines) and catalog assets returned by `asset_search` (`src/server.ts:322-375`) must **never** be hidden or skipped to make errors disappear — every returned entry must download, validate, and bake reliably end-to-end.

## Solution

1. **Fix glTF extension & GLB binary validation + repair in `src/discovery/acquisition.ts:190-258`:**
   - Expand the `extensionsRequired` allowlist (`lines 197-204`) to include all Three.js / ThreeNative-supported glTF 2.0 extensions (`KHR_materials_clearcoat`, `KHR_materials_ior`, `KHR_materials_specular`, `KHR_materials_emissive_strength`, `KHR_materials_transmission`, `KHR_materials_volume`, `KHR_materials_sheen`, `KHR_materials_iridescence`, `KHR_materials_anisotropy`, `KHR_materials_dispersion`, `KHR_texture_basisu`, `EXT_texture_webp`), and include the offending extension name(s) in `AcquisitionError` diagnostics.
   - Normalize/strip non-essential required extensions cleanly via `@gltf-transform/core` rather than failing valid geometry when an extension has a safe PBR fallback.
   - Fix the GLB embedded binary check (`lines 224-230`) to accept valid padded/aligned binary chunks (`binaryLength >= byteLength`), and automatically re-embed or repair malformed GLB chunk/buffer padding on download when possible (failing closed with exact chunk byte counts only on truly truncated buffers).
2. **Zero-skip procedural catalog bake & validation gate:**
   - Add an automated test suite iterating **every** recipe entry in `src/procedural/catalog.json` (zero skips): verify `asset_search({ providers: ["procedural"] })` resolves its `package` and `bakeCall`, executes the bake, and validates the generated `.glb` through both `acquisition.ts` validation and `gltf-transform validate`, fixing any failing recipe rather than omitting it.
3. **Catalog audit & `threenative-release-chain` rollout:**
   - Audit the trace-failing `threenative:*` assets (`threenative:b8a8db27-...`, `d815cefe-...`, `1bd0277e-...`, `b0ce9eb7-...`, `892e559d-...`, `e3310e2d-...`, `ee2504c4-...`) against the updated validator and repair any upstream catalog GLB whose binary chunk is genuinely truncated.
   - Propagate the published `threenative-asset-mcp` bump downstream via `threenative-release-chain` (`threenative-asset-mcp` → `threenative-engine` → `threenative-live-studio`).

## Non-Goals

- Hiding or filtering out broken procedural recipes or catalog models from `asset_search` instead of repairing validation/assets (explicitly prohibited by owner directive).
- Changing paid `tn-model` / Tripo generation pricing or Studio credit caps (`PRD-126`).

## Acceptance Criteria

- [ ] AC-1 [local]: `acquisition.ts` accepts all Three.js/ThreeNative-supported Khronos PBR/texture extensions and valid aligned GLB binary chunks (`binaryLength >= byteLength`), and safely normalizes/repairs recoverable GLB packaging issues — proof: `pnpm test` (new regression fixtures reproducing both 2026-11-27 trace failures) — Evidence: pending.
- [ ] AC-2 [local]: Automated procedural verification iterates **100% of entries** in `src/procedural/catalog.json` (zero entries skipped), confirming `asset_search` (`providers: ["procedural"]`) + `bakeCall` execution produces valid self-contained GLBs — proof: `pnpm test` — Evidence: pending.
- [ ] AC-3 [local]: Every `threenative:*` catalog item observed failing in the 2026-11-27 traces (`b8a8db27-...`, `892e559d-...`, etc.) downloads and passes validation without error — proof: `pnpm test` / catalog audit script — Evidence: pending.
- [ ] AC-4 [shared]: Published `threenative-asset-mcp` version is bumped in `threenative-engine` (`packages/core/package.json`) and `threenative-live-studio` per `threenative-release-chain` — proof: downstream PR / `pnpm check` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| glTF extension allowlist & normalization | `acquisition.ts:192-207` ← `createAssetDownloadHandler` (`src/server.ts:356-370`) | Replaces narrow 6-extension reject with full supported Khronos PBR/texture support + normalization | AC-1 |
| GLB binary chunk alignment & repair | `acquisition.ts:224-230` ← `createAssetDownloadHandler` (`src/server.ts:356-370`) | Replaces strict `byteLength + 3` rejection with `binaryLength >= byteLength` + repair | AC-1 |
| Exhaustive procedural catalog contract | `src/procedural/catalog.json` ← `createAssetSearchHandler` (`src/server.ts:322-336`) | Guarantees every procedural entry bakes & validates with zero skips | AC-2 |
| `threenative:*` catalog repair & npm release | Catalog GLB audit + `packages/core/package.json` (`threenative-engine`) | Fixes failing trace GLBs and propagates npm release to Studio | AC-3, AC-4 |

## Execution Phases

#### Phase 1: Fix `acquisition.ts` Validation, Normalization, and Diagnostics
**Status:** NOT STARTED
**Files:** `src/discovery/acquisition.ts`, `src/discovery/__tests__/`
**Implementation:** Expand `extensionsRequired` allowlist to cover Three.js/ThreeNative PBR & texture extensions; fix `binaryLength >= byteLength` GLB chunk validation; add `@gltf-transform/core` normalization/re-embedding for recoverable GLBs; include exact extension/byte-count diagnostics on true errors; add unit tests for both trace failure classes.
- [ ] Regression tests for `extensionsRequired` and padded GLB binary buffers pass — proof: `pnpm typecheck && pnpm test` — covers AC-1.

#### Phase 2: Exhaustive Procedural Catalog Bake & Validation Gate
**Status:** NOT STARTED
**Files:** `src/procedural/catalog.json`, procedural validation test suite
**Implementation:** Add a test suite iterating every single element in `src/procedural/catalog.json` (zero skips), verifying `asset_search` procedural metadata and executing each `bakeCall` against `@threenative/procedural-environment` to prove every generated GLB passes `acquisition.ts` validation; fix any failing catalog entry or recipe mismatch found.
- [ ] 100% of `src/procedural/catalog.json` entries search, bake, and pass glTF validation with zero skips — proof: `pnpm test` — covers AC-2.

#### Phase 3: Trace-Failing `threenative:*` Catalog Audit and Release Propagation
**Status:** NOT STARTED
**Files:** Catalog audit script / `threenative:*` upload repair, `threenative-engine/packages/core/package.json`
**Implementation:** Verify and repair the 7 `threenative:*` assets from the 2026-11-27 traces against the updated `asset_download` pipeline, then ship npm release and propagate via `threenative-release-chain` (`threenative-asset-mcp` → `threenative-engine` → `threenative-live-studio`).
- [ ] All trace-failing `threenative:*` catalog IDs pass download/validation cleanly — proof: `pnpm test && pnpm build` — covers AC-3.
- [ ] [shared] Downstream `threenative-engine` and `threenative-live-studio` consume updated `threenative-asset-mcp` release — proof: release PR check — covers AC-4.
