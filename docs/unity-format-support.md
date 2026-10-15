# Unity format support ledger

Single place to track which Unity asset kinds the Asset Store importer reads, which are verified, and which
are missing. It uses the same rules as `docs/unreal-format-support.md`. Update this file in the same commit
or PR as any change that adds, verifies, removes or regresses support for a kind, a package shape or a
decoder route. Epic: `docs/PRDs/unity-asset-store-import/README.md`.

Last audited: 2026-10-15 (real-pack verification: `UNITY_IMPORTER_VERSION` 7 on the corpus). Package intake (PRD-615), the model,
texture and material conversion (PRD-616, `asset_import_unity`) and the prefab conversion (PRD-618) were run on the
three real packs: `U1` Apocalypse Playground (Built-in), `U2` the free Built-in "Rusty Cars" file and `U3` KUBIKOS Cube World
(Built-in, URP and custom shaders). Rows below say Verified only where one of those packs shows the behaviour.
`U2` holds no HDRP or URP variant and no usable preview, and no Unity Editor `R1` render exists, so those rows stay as they were.

## Hardening limits

Added after the review of 2026-10-15; each is a named constant with a test. A package that exceeds one fails with a
named error, and the rest of the import is unaffected where the limit is per prefab or per texture.

| Limit | Value | Where |
|---|---|---|
| Archive members / declared uncompressed bytes | 200000 / 8 GiB, checked on the listing before `tar` extracts | `MAX_PACKAGE_MEMBERS`, `MAX_PACKAGE_BYTES` in `src/unity/package.ts` |
| Prefab scopes (file plus nested-instance expansions) per prefab import | 50000 | `MAX_SCOPES` in `src/unity/prefab.ts` |
| Array index a prefab modification may address | 4096 (above: reported unresolved) | `MAX_ARRAY_INDEX` |
| Pixels per decoded texture (TGA, PSD, sharp formats) | 2^27 | `MAX_TEXTURE_PIXELS` in `src/unity/textures.ts` |

Also: members stored with mode 000 are made owner-accessible after extraction so staging can be read and removed,
non-finite (`.nan`, `.inf`) material floats and colour channels take their defaults, and Blender runs with
`--disable-autoexec`.

## Verified risks and open ones

- **Y rotation of prefab children and FBX geometry: confirmed and fixed (2026-10-15, `U1`, `U3`).** Measured by a silhouette
  sweep against Unity's own previews: the old output needed about 100 degrees of extra yaw on 12 asymmetric `U1` pieces. Each
  FBX mesh now sits in Unity's mesh space (a half turn about Y, the file's unit scale, the file node's translation, no second
  application of the node's own scale and turn). After it the best yaw is 270-285 degrees on `U1` and 270 on 7 of 11 multi-part `U3`
  prefabs, the difference between Unity's preview camera and ours (predicted 280, from memory of Unity's preview code). Open: no
  `R1` render, so the camera values stay unconfirmed. See PRD 004.
- **Node translation of an FBX mesh (checked 2026-10-15).** The importer adds the file node's translation T to the mesh only
  when T cancels the vertices' offset (a pivot offset: node at T, vertices about -T). Real data: in `U3` six models have a pivot offset;
  with T every one stands at the origin on the ground, without it each is 8-13 m off, and the multi-part prefabs that use them cluster as
  in Unity's previews. In `U1` no model has a node translation and in `U2` it is a few centimetres, so the corpus holds no prefab where a
  GameObject translation and an ordinary node translation are both non-zero: that case (T placing the object, vertices about the origin)
  is covered by a synthetic test only, which keeps T out of the mesh so the part is not placed twice. The Y and Z signs are checked on the
  `U3` numbers (translation on all three axes) in `tests/unity-prefab.test.ts` (`pivot`), not on a Blender-made file.
- **Mesh references of real prefabs.** The 64-bit `m_Mesh` ids of a Unity 2022 pack (`U2`) are in no table and the derived-id
  formula does not reproduce them (MD4, MD5, SHA-1, SHA-256 of `Type:Mesh->name->0` tried with several byte orders). The importer then
  matches the mesh by the GameObject's own name (or, when the prefab has one mesh node only, its root's name), with an UNVERIFIED warning; an ancestor's name never picks a child's mesh. `U1` and `U3` resolve through the name tables.
- **Preview pictures are lit by Unity's own rig.** On `U1` ours is brighter (median lightness ratio 2.62) and more saturated
  (1.46) than the preview, with equal silhouettes (1.04). The judge compensates the measured copy of an `R2` reference with
  two fixed gains (`UNITY_RIG_*` in `src/unity/fidelity.ts`) and the sheet still shows Unity's picture. On `U3` (out of sample, 60 pieces) the lightness
  median falls from 3.30 to 1.36 and the mean score rises from 69.3 to 71.9, while the number of pieces rated ok falls from 30 to 27.

## Status vocabulary

| Status | Meaning |
|---|---|
| **Partly verified** | Imported from a real pack and the sheets show the behaviour, but the acceptance criterion is not met in full. The row says which part. |
| **Verified** | Imported from a real, named pack. The row names the pack, its corpus id and the date. |
| **Implemented** | Code and tests exist (synthetic fixtures). No real pack is named. |
| **Reported** | The intake counts the kind in its inventory and converts nothing. |
| **Missing** | Not detected. |

## Package shapes

| Shape | Status | Evidence or gap |
|---|---|---|
| `.unitypackage` (gzip tar of `<guid>/{asset,asset.meta,pathname,preview.png}`) | **Verified** | `tests/unity-intake.test.ts` (`shapes`, `traversal`). Real packs `U1`, `U2`, `U3` read with 0 YAML failures and 0 refused paths, 2026-10-15, importer 7 (`docs/parity/unity-corpus.json`). Old Unity 5 files (`serializedVersion: 19`, `fileIDToRecycleName`) and the Unity 5 `Prefab` container document parse (`U3`). |
| UPM tarball (`package/package.json` plus files with sibling `.meta`) | Implemented | `tests/unity-intake.test.ts` (`shapes`). Gap: no corpus pack has a UPM layout. |
| Unity project folder (`Assets/`, `Packages/` with sibling `.meta`) | Implemented | `tests/unity-intake.test.ts` (`shapes`). Fallback if cached Editor packages prove encrypted. |
| Encrypted Asset Store download | **Missing** | Unverified whether Editor-cached packages are encrypted. A non-gzip file is refused with a message that names the project-folder route. The importer never decrypts (Asset Store Terms §3.8(ii)). |

## Asset kinds

"Reported" means the inventory counts the kind (`src/unity/inventory.ts`). Extensions come from the importer's
mapping, so a kind not listed lands in Other.

| Kind | Extensions | Status | Output | Evidence or gap |
|---|---|---|---|---|
| Model (FBX, OBJ, `.blend`) | **Verified** (FBX) | `models/<name>.glb` | `tests/unity-models.test.ts` (`globalScale`, `slots`) and real FBX on `U1` (31), `U2` (1, 17 meshes, Blender-made, centimetre file) and `U3` (176, Maya, with pivot offsets), 0 failed, 2026-10-15. Headless Blender 4.5 LTS (`src/unity/blender.ts`). Gap: skinned meshes, animation and LODs are untested; OBJ and `.blend` have no real pack. |
| Model (other) | `.dae` `.3ds` `.gltf` `.glb` `.stl` `.ply` | Reported | none | Skipped with a reason in `import-report.json`. |
| Model (authoring files) | `.max` `.ma` `.mb` | **Missing** | none | They need the authoring application. Reported as skipped (`tests/unity-models.test.ts`). |
| Texture (PNG, JPEG, TIFF, GIF, WebP) | `.png` `.jpg` `.jpeg` `.tif` `.tiff` `.gif` | Implemented | `textures/<name>.png` | `tests/unity-textures.test.ts` through `sharp`. 16-bit sources are unverified. |
| Texture (TGA) | `.tga` | Implemented | same | `tests/unity-textures.test.ts`: own decoder (`sharp` cannot read TGA); 24 and 32 bit, RLE, grey, colour-mapped, both origins. |
| Texture (PSD) | `.psd` | Implemented | same | `tests/unity-textures.test.ts` through `ag-psd` 31.0.3 (`sharp` cannot read PSD). Needs a flattened composite. Gap: composite transparency is unverified (an opaque PSD round-trips). |
| Texture (BMP, DDS, EXR, HDR) | `.bmp` `.dds` `.exr` `.hdr` | **Missing** | none | The slot stays empty and the material carries a warning. |
| Texture (importer settings) | `sRGBTexture`, `textureType`, `flipGreenChannel`, `maxTextureSize` | Implemented | n/a | Normal maps and masks stay linear; a colour texture with `sRGBTexture: 0` is re-encoded; the tool's `maxTextureSize` caps the longest edge (`tests/unity-textures.test.ts`). Unity's own per-platform size is only recorded. |
| Texture (`convertToNormalMap`) | `bumpmap.convertToNormalMap` | **Missing** | none | A height map Unity turns into normals. Reported under `unsupported`; the slot stays empty (`tests/unity-materials.test.ts`, `tests/unity-models.test.ts`). |
| Material (Standard (metallic)) | **Partly verified** | glTF PBR | `tests/unity-materials.test.ts` (`standard`) and the real `fileID` 46 in `0000000000000000f000000000000000` on 31 `U1`, 21 `U2` and 13 `U3` materials (importer 7, 2026-10-15): the shader identity and the texture, smoothness and colour mapping show right on the sheets. PRD-002 AC-9 "no Standard piece fails" is NOT met: 11 of 31 `U1` pieces score under 50 (mean 60.7). The causes are named on the sheet and none is a wrong import: Unity's preview rig (compensated by two fitted gains), a fully metallic bottle (metallic 253/255, black in a neutral picture with no environment) and a grey object on a grey background. Cut-out (`_Cutoff` 1 on three `U2` materials) renders thin, as Unity's clip does. |
| Material (Standard (Specular setup)) | **Verified** | glTF PBR + `KHR_materials_specular` | `tests/unity-materials.test.ts` (`standard`) and `fileID` 45 with `_SpecGlossMap`, `_SpecColor` and `_SPECGLOSSMAP` on the 5 `U3` crystal materials (2026-10-15, importer 7). Energy conservation is left to glTF's dielectric model. |
| Material (URP Lit, SimpleLit, ComplexLit) | Implemented | glTF PBR | `tests/unity-materials.test.ts` (`pipelines`) with the URP shader GUIDs. The URP Lit guid `933532a4fcc9baf4fa0491de14d08ed7` is identified and mapped on 13 `U3` materials (importer 7, 2026-10-15), but no URP piece is scored: every `U3` URP preview is Unity's missing-shader pink, so there is no reference. Not Verified for that reason. SimpleLit is approximated as a non-metal; clear coat is unsupported. |
| Material (HDRP Lit) | `.mat` | Implemented | glTF PBR | `tests/unity-materials.test.ts` (`pipelines`): the mask map is split into metallic-roughness and occlusion with the remap ranges. Gap: HDRP emission intensity, material IDs other than standard, detail maps and object-space normals. |
| Material (Shader Graph and custom shaders) | **Verified** | `fallback` | Saved colour and base texture (`_BaseMap`, `_MainTex`, `_BaseColorMap`, `_Albedo`), with the shader reference and reason in the report (`tests/unity-materials.test.ts`, `fallback`). `U3` reports 121 fallback materials: 96 from one custom surface shader (Built-in and URP twins), 22 from other custom shaders (water, lava, ice, cloud and similar effects), 3 from a legacy built-in id (not identified; it keeps its `_MainTex`). `U2` reports 1 (a built-in id, not identified). The `_Albedo` rule came from a `U3` custom shader. The graph itself is not evaluated (out of scope). |
| Material (slot binding) | `ModelImporter.externalObjects`, name search | Implemented | n/a | `tests/unity-models.test.ts` (`slots`): `externalObjects`, then the nearest `.mat` of the same name, with the binding recorded per slot. `materialImportMode: 0` binds nothing. |
| Pack licence files | `LICENSE*` `COPYING*` `NOTICE*` `Third-Party Notices*` | Implemented | `licenseFiles` in the report | `tests/unity-models.test.ts`. Restricted Assets carry their own terms, which the tool cannot query. |
| Prefab (hierarchy, MeshFilter, MeshRenderer) | **Partly verified** | `prefabs/<name>.glb` | `tests/unity-prefab.test.ts` (`hierarchy`, `meshes`) and every prefab of the corpus: `U1` 31/31, `U2` 17/17, `U3` 1006/1006 GLBs, 0 failed (importer 7, 2026-10-15). Multi-part `U3` prefabs sit as in Unity's previews (silhouette IoU 0.62-0.85 at the camera offset). Not verified: sizes against an `R1` render (none exists), and the slot order beyond textured pieces. 14 `U3` prefabs hold no mesh. 8 mesh references of two `U3` prefabs stay unresolved. |
| Prefab (nested prefab, variant) | Implemented | same | `tests/unity-prefab.test.ts` (`nested`, `cycle`): `m_Modifications`, removed components and GameObjects, `m_AddedGameObjects`, `stripped` documents, a variant of a nested prefab, a cycle error that names the chain. The corpus has no nested prefab or variant that resolves (the `U3` Unity 5 container documents are the prefab itself); the combined id (source id XOR instance id) is unverified on a real pack. |
| Prefab (model as source) | `.prefab` | Implemented | node with the model scene | `tests/unity-prefab.test.ts` (`nested`, prefab instance of a model). Only the root GameObject and Transform of the model can be edited; edits of inner objects are reported as unresolved. Unverified on a real pack. |
| LODGroup | `LODGroup` | Implemented | LOD0 only | `tests/unity-prefab.test.ts` (`report`): other levels are listed under `lodLevels`, not imported. |
| Colliders, scripts and other components | `*Collider`, `MonoBehaviour`, `Light`, ... | Reported | none | `tests/unity-prefab.test.ts` (`report`): listed under `colliders` and `components` in the prefab report. |
| Shader Graph | `.shadergraph` `.shadersubgraph` | Reported | none | Out of scope for the epic: no published schema. Materials on a graph fall back to saved properties (PRD-616). |
| Scene | `.unity` | Reported | none | Out of scope for the epic. |
| Other | everything else | Reported | none | Audio, animation, scripts, VFX and terrain are counted here until a pack shows them and earns a row. |

## References

| Reference | Status | Evidence or gap |
|---|---|---|
| `{fileID, guid, type}` to a packaged asset | Implemented | `resolveRef` in `src/unity/yaml.ts`; `tests/unity-yaml.test.ts`. |
| Built-in GUIDs `0000000000000000f000000000000000` (extra resources, including the Standard shader, fileID 46) and `0000000000000000e000000000000000` (default resources) | Implemented | Marked `builtin`, never looked up. Same test file. |
| Local reference (no guid) and sub-object of another YAML asset | Implemented | Same test file. |
| `MeshFilter.m_Mesh` to an FBX mesh by `internalIDToNameTable` (2019.1+) | **Verified** | `tests/unity-prefab.test.ts` (`meshes`) and the `U1` prefabs (2026-10-15, importer 7). |
| `MeshFilter.m_Mesh` by `fileIDToRecycleName` (older) | **Verified** | Same test, and the `U3` models (`serializedVersion: 19`), 2026-10-15. |
| `MeshFilter.m_Mesh` by the derived id (no table) | **Refuted on a real pack** | `src/unity/model-ids.ts` (MD4 of `Type:Mesh->{name}->0`) does not reproduce the 64-bit ids of the `U2` prefabs (no table there either; several hashes and byte orders tried). The importer falls back to the GameObject's name, with an UNVERIFIED warning (`tests/unity-prefab.test.ts`), then to the model's only mesh. |

## Fidelity measurement (PRD-617)

| Capability | Status | Evidence or gap |
|---|---|---|
| Reference sheet against `R2` (`<guid>/preview.png`) | **Verified** | `tests/unity-fidelity.test.ts` and the sweeps of `U1` (31 pieces, mean 60.7, in-sample for the rig gains) and `U3` (a fixed slice of 36, every 14th of the 505 sorted non-URP prefab paths: mean 78.3; the unsliced 60-piece run scored 71.9), 2026-10-15, importer 7. Prefab GLBs are scored against prefab previews; a preview shared by 3 or more assets (`U2` 17, `U3` 381) is Unity's generic icon and a preview that is mostly magenta (`U3` 494, URP materials in a Built-in preview) is its missing-shader pink: neither is a reference. The model-level import scores 28.9 (`U1`) and 28.8 (`U3`) against the same previews because models carry no `.mat` binding. |
| `R2` channel order and gamma | **Verified** | Previews are RGB and sRGB-encoded: no swap, no gamma. A texture asset's preview equals the source texture downsampled (mean abs diff 3.2 as decoded against 8.4 swapped; a normal map keeps its blue channel) on `U1`, and `decideChannelOrder` finds 0 of 31 pieces better swapped (mean 49 as decoded, 38 swapped). A lit preview fits `preview ~ albedo^0.47`, so no 2.2 curve is involved. The PNGs carry no gamma, sRGB or ICC chunk. 2026-10-15. |
| Reference sheet against `R1` (Editor render) | Implemented | `tests/unity-fidelity.test.ts` (`reference`): a synthetic R1 folder replaces R2, the column is labelled R1, and a piece whose `sizeMeters` is more than 1 % off its bounds is flagged. |
| `R1` render script `scripts/unity/ReferenceRender.cs` | **Unverified** | Written, never compiled or run: no Unity Editor or licence on this machine. Its `bounds.json` layout is the one the tests write. HDRP light intensity is a guess. |
| Material visual locks (smoothness inversion, HDRP mask split, cut-out, gamma tint) | Implemented | `tests/unity-visual-regression.test.ts` with goldens `tests/fixtures/visual-golden/unity-*.png`. Ten mutations of `src/unity/materials.ts` turn it red (PRD-617, AC-3). Synthetic materials only. |
| Corpus sweep `npm run parity:unity` | **Verified** | `tests/unity-parity.test.ts` on a synthetic corpus and the real sweeps of `U1`, `U2`, `U3` (2026-10-15). `docs/parity/fidelity-baseline.json` holds `U1` and `U3` entries (numbers only); `U2` has no scored piece. `slice.json` picks the sheet's pieces and the whole pack is always imported. |
