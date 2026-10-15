# PRD-616 — Unity models, textures and materials to GLB

**Status:** IN PROGRESS — AC-1..AC-8 pass on synthetic packages; AC-9 (real-pack evidence) is only partly met (2026-10-15, see its note).
**Priority:** P2 — `asset_import_unity` is the epic's user-facing import.
**Complexity:** 4 (MEDIUM) — 6–10 implementation files (2), new importer module (+2); risk override: none
**Owner:** João
**Depends on:** PRD-615

## Context

Asset Store packages ship source files: FBX (mostly), OBJ and `.blend` models, PNG/JPG/TGA/PSD/TIF textures, and
`.mat` YAML that binds textures to shader properties. Their meaning comes from the `.meta` importer settings:

- `ModelImporter`: `globalScale`, `useFileScale`, `materialImportMode`, `externalObjects` (embedded material
  name → `.mat` ref), and `internalIDToNameTable` / `fileIDToRecycleName` (needed by PRD-618).
- `TextureImporter`: `sRGBTexture`, `textureType` (normal map), `convertToNormalMap`, `alphaIsTransparency`, `maxTextureSize`.

Material mapping, ported from UnityGLTF `ExporterMaterials.cs` (MIT) and the Unity manuals:

| Shader | Identified by | Mapping notes |
|---|---|---|
| Built-in Standard / Standard (Specular setup) | `fileID: 46` / `45`, guid `0000000000000000f000000000000000` (verified on `U1`, `U2`, `U3`) | `_MainTex`·`_Color`; `_MetallicGlossMap` R = metallic, A = smoothness × `_GlossMapScale`, else `_Glossiness`; `_SmoothnessTextureChannel` 1 = albedo alpha; roughness = 1 − smoothness; `_BumpMap`·`_BumpScale`; `_OcclusionMap` (G); `_EmissionMap`·`_EmissionColor`; `_Mode` 1 = cutout (`_Cutoff`), 2/3 = blend |
| URP Lit / SimpleLit / ComplexLit | `933532a4fcc9baf4fa0491de14d08ed7` / `8d2bb70cbf9db8d4da26e15b26e74248` / `ee7e4c9a5f6364b688a332c67fc32cca` | `_BaseMap`·`_BaseColor`, `_Smoothness`, `_WorkflowMode`, `_Surface`, `_AlphaClip` |
| HDRP Lit | `6e4ae4064600d784cac1e41a9e6f2e59` | `_MaskMap`: R metallic, G AO, B detail mask, A smoothness |
| Anything else (Shader Graph, custom) | — | Saved `_BaseColor`/`_Color` and `_BaseMap`/`_MainTex`/`_BaseColorMap`/`_Albedo` when present; else neutral. Recorded as `fallback` with the shader ref |

Specular setup converts to metallic-roughness with `KHR_materials_specular`, which is already supported through
`@gltf-transform/extensions`. Reuse: `@gltf-transform/*` (GLB writing), `sharp` (textures), `sizeMeters`
(`src/gltf-size.ts`), `SummarySchema` and the report shape (`src/tools/import-unreal.ts:23`), the provisioning helpers
(`src/unreal/provision.ts`) and the headless Blender call in `src/tools/blendkit.ts`. Unity's built-in shader source
archive is reported to be MIT. Check its `license.txt` before quoting any formula from it.

## Solution

`src/unity/importer.ts` takes a PRD-615 database. It converts each model with headless Blender
(`blender -b --python-expr`: import FBX/OBJ/`.blend`, export GLB) under `runBounded`, applies the
`ModelImporter` scale, resolves materials through `src/unity/materials.ts`, writes textures through sharp, and
writes `import-report.json` with `UNITY_IMPORTER_VERSION`. Blender resolves from `THREENATIVE_BLENDER`, then
`PATH`, then a pinned, checksummed download in the toolchain cache. `npm run doctor` lists it.

MCP tool: `asset_import_unity { source, outputDir, assets?, maxTextureSize?, acceptUnityAssetStoreEula: true }`.
`source` is a package, UPM tarball or project folder. The tool refuses to run without the acknowledgement, and it
returns `SummarySchema`.

## Acceptance Criteria

- [x] AC-1 [local]: A synthetic package with a 1 m FBX cube (made by Blender in the test) and `globalScale: 2`
  imports as a GLB whose `sizeMeters` is 2 ± 0.01 on every axis. proof: `npx vitest run tests/unity-models.test.ts`
  — Evidence: `npx vitest run tests/unity-models.test.ts` — 12 passed, 1 skipped (the on-demand real download). `globalScale` 2 gives 2.00 m on x, y and z; a `.unitypackage` source and a centimetre FBX with `useFileScale` on and off also pass. 2026-10-14.
- [x] AC-2 [local]: With no Blender on `PATH` and an empty toolchain cache, the import provisions the pinned Blender,
  verifies its checksum and succeeds. `THREENATIVE_TOOLCHAIN_AUTOINSTALL=0` gives an error that names the fix.
  proof: `npx vitest run tests/unity-models.test.ts -t provision` — Evidence: `npx vitest run tests/unity-models.test.ts -t provision` — 5 passed, 1 skipped. A local archive served over HTTP covers download, SHA-256 check, extraction, install and reuse; a wrong digest installs nothing; `THREENATIVE_TOOLCHAIN_AUTOINSTALL=0` names `THREENATIVE_BLENDER` and `THREENATIVE_TOOLCHAIN_AUTOINSTALL`. With `THREENATIVE_REAL_BLENDER_PROVISION=1` the same command also provisions the real pinned Blender 4.5.14 (378 MB, SHA-256 `9ba871ff...06da3`) from an empty cache: 6 passed in 13.5 s. 2026-10-14.
- [x] AC-3 [local]: Standard metallic and specular materials (synthetic `.mat` files covering each row above,
  including smoothness from albedo alpha and cutout) resolve to the expected glTF factors and textures.
  proof: `npx vitest run tests/unity-materials.test.ts -t standard` — Evidence: `npx vitest run tests/unity-materials.test.ts -t standard` — 8 passed. 2026-10-14.
- [x] AC-4 [local]: URP Lit/SimpleLit and an HDRP Lit mask map resolve correctly, and the HDRP mask is split into a
  metallic-roughness texture plus occlusion. proof: `npx vitest run tests/unity-materials.test.ts -t pipelines` — Evidence: `npx vitest run tests/unity-materials.test.ts -t pipelines` — 7 passed. 2026-10-14.
- [x] AC-5 [local]: A material on a Shader Graph or unknown shader falls back to its saved colour and texture,
  and the report records `fallback` with the shader ref. proof: `npx vitest run tests/unity-materials.test.ts -t fallback` — Evidence: `npx vitest run tests/unity-materials.test.ts -t fallback` — 2 passed, plus the end-to-end fallback in `tests/unity-models.test.ts`. 2026-10-14.
- [x] AC-6 [local]: The FBX's embedded material slots bind to the `.mat` files named by `externalObjects`, and
  otherwise by name search, with the binding source recorded. proof: `npx vitest run tests/unity-models.test.ts -t slots` — Evidence: `npx vitest run tests/unity-models.test.ts -t slots` — 2 passed. 2026-10-14.
- [x] AC-7 [local]: TGA, PSD and TIF textures decode, normal maps load as linear, `maxTextureSize` is applied, and
  `convertToNormalMap` was reported as unsupported (PRD-620 FR-T1 now converts it). proof: `npx vitest run tests/unity-textures.test.ts` — Evidence: `npx vitest run tests/unity-textures.test.ts` — 13 passed. `sharp` 0.35.4 cannot read TGA or PSD (checked), so TGA has its own decoder and PSD uses `ag-psd` 31.0.3. 2026-10-14.
- [x] AC-8 [local]: Through the packed MCP, `asset_import_unity` refuses a call without `acceptUnityAssetStoreEula`
  and imports the synthetic package with one. proof: `npx vitest run tests/mcp-smoke.test.ts` — Evidence: `npx vitest run tests/mcp-smoke.test.ts` — 17 passed, including the refusal without `acceptUnityAssetStoreEula` and the import with it. 2026-10-14.
- [ ] AC-9 [local]: Real-pack evidence per the epic's PR evidence rule. The slice is `U1` (Standard) plus the same
  `U2` pieces in each of its three pipelines. The sheet shows reference (`R2` previews, `R1` if available) | "no
  importer" | after, with judge scores. No Standard, URP Lit or HDRP Lit piece fails (score under 50), and each
  suspect piece names its cause. The same `U2` piece scores within 10 points across the three pipelines. Every
  sheet is checked by eye and posted to the PR. proof: PR screenshot comment — Evidence: PARTLY MET, NOT TICKED. `npm run parity:unity -- --ids U1,U2 --max 40` and `--ids U3 --max 60` (importer 7, 2026-10-15). `U1` (Built-in Standard, shader `fileID` 46 on all 31 materials): 31 prefabs, 105 textures resolved, 0 fallback, 0 failed; judge on prefab GLBs against prefab previews (R2): mean 60.7, ok 10, suspect 10, fail 11 (after the Unity preview rig compensation of `src/unity/fidelity.ts`; 48.7 and 15 fails without it). The 11 fails are not import errors: Unity's preview rig, a fully metallic bottle in a neutral picture, and a grey-on-grey mask; each is named on the sheet. `U3` slice of 36: mean 78.3, ok 25, suspect 10, fail 1 (the one fail has the right shape and a colour 21 degrees off). Not met: (1) the `U2` file on this machine is the free Built-in "RustyCarsFree" (1 FBX, 21 Standard and 1 other material); it has no HDRP or URP variants, so "the same piece in three pipelines within 10 points" and the HDRP mask-map and URP Lit checks on real files cannot be run; (2) all 17 `U2` previews are Unity's generic icon, so `U2` has no reference; (3) the "no importer" column does not exist, and no PR comment was posted; (4) 11 of 31 `U1` pieces score under 50 against the `R2` previews.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Unity import | MCP `asset_import_unity` → `src/server.ts` → `src/tools/import-unity.ts` → `src/unity/importer.ts` | New | AC-8 |
| Blender toolchain | `ensureBlender` (`src/unity/blender.ts`); `npm run doctor`; `npm run provision:toolchain` | New; Blendkit keeps its own client-stored Blender | AC-2 |

## Execution Phases

#### Phase 1: Models through Blender
**Status:** DONE
**Files:** `src/unity/blender.ts` (new), `src/unity/importer.ts` (new), provisioning entry, `tests/unity-models.test.ts`
**Implementation:** Resolve or provision Blender. Convert one model per call, apply the scale, and bind the slots.
**Verification:** AC-1, AC-2, AC-6. Tests that need Blender use `describeWithTools`.

#### Phase 2: Materials and textures
**Status:** DONE
**Files:** `src/unity/materials.ts` (new), `src/unity/textures.ts` (new), `tests/unity-materials.test.ts`, `tests/unity-textures.test.ts`
**Implementation:** The mapping table above. Check sharp's PSD and TGA input first, and add `ag-psd` only if sharp fails.
**Verification:** AC-3, AC-4, AC-5, AC-7.

#### Phase 3: Tool and report
**Status:** IN PROGRESS — the tool, report and docs are done; the AC-9 sheet waits for the corpus.
**Files:** `src/tools/import-unity.ts` (new), `src/server.ts`, `docs/unity-import.md` (new), `docs/tools.md`, `docs/unity-format-support.md`
**Implementation:** Wire the tool, write the report, bump the ledger rows to Implemented. Until PRD-617 lands,
build the AC-9 sheet with `renderTiles` and `judgeRender` directly, with `R2` previews in the reference column.
**Verification:** AC-8, AC-9.
