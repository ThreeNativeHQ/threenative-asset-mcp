# Unity format support ledger

Single place to track which Unity asset kinds the Asset Store importer reads, which are verified, and which
are missing. It uses the same rules as `docs/unreal-format-support.md`. Update this file in the same commit
or PR as any change that adds, verifies, removes or regresses support for a kind, a package shape or a
decoder route. Epic: `docs/PRDs/unity-asset-store-import/README.md`.

Last audited: 2026-10-14. Only package intake (PRD-615, `src/unity/`) exists. No conversion to GLB exists yet
(PRD-616), so no row is Verified.

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
| Model | `.fbx` `.obj` `.dae` `.3ds` `.blend` `.gltf` `.glb` `.stl` `.ply` `.max` `.ma` `.mb` | Reported | none yet | PRD-616 converts them. `.max`, `.ma` and `.mb` need the DCC application and stay unsupported. |
| Texture | `.png` `.jpg` `.jpeg` `.tga` `.psd` `.tif` `.tiff` `.bmp` `.exr` `.hdr` `.gif` `.dds` | Reported | none yet | PRD-616. PSD and TGA decoding is unchecked. |
| Material | `.mat` | Reported | none yet | The YAML reader parses it (`tests/unity-yaml.test.ts`); material conversion is PRD-616. Binary-serialized materials are refused as not text YAML. |
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
