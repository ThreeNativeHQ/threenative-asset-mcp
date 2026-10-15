# Unity format support ledger

Single place to track which Unity asset kinds the Asset Store importer reads, which are verified, and which
are missing. It uses the same rules as `docs/unreal-format-support.md`. Update this file in the same commit
or PR as any change that adds, verifies, removes or regresses support for a kind, a package shape or a
decoder route. Epic: `docs/PRDs/unity-asset-store-import/README.md`.

Last audited: 2026-10-14. Package intake (PRD-615) and the model, texture and material conversion (PRD-616,
`asset_import_unity`, `UNITY_IMPORTER_VERSION` 1) exist and are tested with synthetic packages. The corpus
packs (`U1`-`U3`) are not on this machine, so no row is Verified.

## Status vocabulary

| Status | Meaning |
|---|---|
| **Verified** | Imported from a real, named pack. The row names the pack, its corpus id and the date. |
| **Implemented** | Code and tests exist (synthetic fixtures). No real pack is named. |
| **Reported** | The intake counts the kind in its inventory and converts nothing. |
| **Missing** | Not detected. |

## Package shapes

| Shape | Status | Evidence or gap |
|---|---|---|
| `.unitypackage` (gzip tar of `<guid>/{asset,asset.meta,pathname,preview.png}`) | Implemented | `tests/unity-intake.test.ts` (`shapes`, `traversal`). No real pack read yet: the corpus (`U1`-`U3`) is not downloaded. |
| UPM tarball (`package/package.json` plus files with sibling `.meta`) | Implemented | `tests/unity-intake.test.ts` (`shapes`). Gap: no corpus pack has a UPM layout. |
| Unity project folder (`Assets/`, `Packages/` with sibling `.meta`) | Implemented | `tests/unity-intake.test.ts` (`shapes`). Fallback if cached Editor packages prove encrypted. |
| Encrypted Asset Store download | **Missing** | Unverified whether Editor-cached packages are encrypted. A non-gzip file is refused with a message that names the project-folder route. The importer never decrypts (Asset Store Terms §3.8(ii)). |

## Asset kinds

"Reported" means the inventory counts the kind (`src/unity/inventory.ts`). Extensions come from the importer's
mapping, so a kind not listed lands in Other.

| Kind | Extensions | Status | Output | Evidence or gap |
|---|---|---|---|---|
| Model (FBX, OBJ, `.blend`) | `.fbx` `.obj` `.blend` | Implemented | `models/<name>.glb` | `tests/unity-models.test.ts` (`globalScale`, `slots`): a 1 m FBX cube with `globalScale: 2` measures 2 m; a centimetre FBX honours `useFileScale`. Headless Blender 4.5 LTS (`src/unity/blender.ts`). Gap: skinned meshes, animation and LODs are untested; no real pack. |
| Model (other) | `.dae` `.3ds` `.gltf` `.glb` `.stl` `.ply` | Reported | none | Skipped with a reason in `import-report.json`. |
| Model (authoring files) | `.max` `.ma` `.mb` | **Missing** | none | They need the authoring application. Reported as skipped (`tests/unity-models.test.ts`). |
| Texture (PNG, JPEG, TIFF, GIF, WebP) | `.png` `.jpg` `.jpeg` `.tif` `.tiff` `.gif` | Implemented | `textures/<name>.png` | `tests/unity-textures.test.ts` through `sharp`. 16-bit sources are unverified. |
| Texture (TGA) | `.tga` | Implemented | same | `tests/unity-textures.test.ts`: own decoder (`sharp` cannot read TGA); 24 and 32 bit, RLE, grey, colour-mapped, both origins. |
| Texture (PSD) | `.psd` | Implemented | same | `tests/unity-textures.test.ts` through `ag-psd` 31.0.3 (`sharp` cannot read PSD). Needs a flattened composite. Gap: composite transparency is unverified (an opaque PSD round-trips). |
| Texture (BMP, DDS, EXR, HDR) | `.bmp` `.dds` `.exr` `.hdr` | **Missing** | none | The slot stays empty and the material carries a warning. |
| Texture (importer settings) | `sRGBTexture`, `textureType`, `flipGreenChannel`, `maxTextureSize` | Implemented | n/a | Normal maps and masks stay linear; a colour texture with `sRGBTexture: 0` is re-encoded; the tool's `maxTextureSize` caps the longest edge (`tests/unity-textures.test.ts`). Unity's own per-platform size is only recorded. |
| Texture (`convertToNormalMap`) | `bumpmap.convertToNormalMap` | **Missing** | none | A height map Unity turns into normals. Reported under `unsupported`; the slot stays empty (`tests/unity-materials.test.ts`, `tests/unity-models.test.ts`). |
| Material (Standard (metallic)) | `.mat` | Implemented | glTF PBR | `tests/unity-materials.test.ts` (`standard`): factors, metallic map, smoothness from the gloss map or the albedo alpha, `_Mode` cutout and blend, normal, occlusion, emission, tiling. The shader identity (`fileID` 46 in `0000000000000000f000000000000000`) is from the Unity manuals and **unverified on a real pack**. |
| Material (Standard (Specular setup)) | `.mat` | Implemented | glTF PBR + `KHR_materials_specular` | `tests/unity-materials.test.ts` (`standard`). `fileID` 45, unverified on a real pack. Energy conservation is left to glTF's dielectric model. |
| Material (URP Lit, SimpleLit, ComplexLit) | `.mat` | Implemented | glTF PBR | `tests/unity-materials.test.ts` (`pipelines`) with the URP shader GUIDs. SimpleLit is approximated as a non-metal; clear coat is unsupported. No real URP pack. |
| Material (HDRP Lit) | `.mat` | Implemented | glTF PBR | `tests/unity-materials.test.ts` (`pipelines`): the mask map is split into metallic-roughness and occlusion with the remap ranges. Gap: HDRP emission intensity, material IDs other than standard, detail maps and object-space normals. |
| Material (Shader Graph and custom shaders) | `.mat` | Implemented | `fallback` | Saved colour and base texture, with the shader reference and reason in the report (`tests/unity-materials.test.ts`, `fallback`). The graph itself is not evaluated (out of scope). |
| Material (slot binding) | `ModelImporter.externalObjects`, name search | Implemented | n/a | `tests/unity-models.test.ts` (`slots`): `externalObjects`, then the nearest `.mat` of the same name, with the binding recorded per slot. `materialImportMode: 0` binds nothing. |
| Pack licence files | `LICENSE*` `COPYING*` `NOTICE*` `Third-Party Notices*` | Implemented | `licenseFiles` in the report | `tests/unity-models.test.ts`. Restricted Assets carry their own terms, which the tool cannot query. |
| Prefab | `.prefab` | Reported | none yet | The YAML reader parses it, including `stripped` documents and 64-bit fileIDs. Hierarchy conversion is PRD-618. |
| Shader Graph | `.shadergraph` `.shadersubgraph` | Reported | none | Out of scope for the epic: no published schema. Materials on a graph fall back to saved properties (PRD-616). |
| Scene | `.unity` | Reported | none | Out of scope for the epic. |
| Other | everything else | Reported | none | Audio, animation, scripts, VFX and terrain are counted here until a pack shows them and earns a row. |

## References

| Reference | Status | Evidence or gap |
|---|---|---|
| `{fileID, guid, type}` to a packaged asset | Implemented | `resolveRef` in `src/unity/yaml.ts`; `tests/unity-yaml.test.ts`. |
| Built-in GUIDs `0000000000000000f000000000000000` (extra resources, including the Standard shader, fileID 46) and `0000000000000000e000000000000000` (default resources) | Implemented | Marked `builtin`, never looked up. Same test file. |
| Local reference (no guid) and sub-object of another YAML asset | Implemented | Same test file. |
