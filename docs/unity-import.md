# Unity import

[← Back to the README](../README.md)

`asset_import_unity` converts the models, textures and materials of a Unity package that you own into
self-contained GLB files. The per-kind ledger is [unity-format-support.md](unity-format-support.md). The
epic and its plans are in `docs/PRDs/unity-asset-store-import/`.

The tool never contacts Unity. It does not sign in, call Asset Store or Hub endpoints, or decrypt a
download. You download the package in your own Unity Editor (Package Manager, My Assets). The Editor
caches it, and `unity_list_packages` lists the cache.

## Call

```json
{
  "source": "/home/you/.local/share/unity3d/Asset Store-5.x/Pub/3d/Pack.unitypackage",
  "outputDir": "/home/you/game/assets/unity/pack",
  "assets": ["Assets/Models/crate.fbx"],
  "maxTextureSize": 2048,
  "acceptUnityAssetStoreEula": true
}
```

- `source`: a `.unitypackage`, a UPM tarball or a Unity project folder.
- `outputDir`: must be new or empty. The tool never overwrites an import.
- `assets`: optional. Model paths, file names or names without an extension. Omit it to convert every model.
- `maxTextureSize`: optional cap on the longest edge of written textures.
- `acceptUnityAssetStoreEula`: required, and it must be `true`. It states that you own the package, accept the
  Asset Store EULA for it and checked any Restricted Asset terms. The tool cannot check them, because the
  Asset Store terms forbid automated access. The call fails without it.

The result lists the models, materials and textures, the slot bindings, skipped and failed assets, warnings,
and every `LICENSE` or `Third-Party Notices` file found in the package. The full record is
`import-report.json` in `outputDir`, with `importerVersion` (`UNITY_IMPORTER_VERSION`).

## Output layout

```text
outputDir/
  import-report.json
  models/<name>.glb        one GLB per model, textures embedded
  textures/<name>.png      the same textures, as files
```

## Models

FBX, OBJ and `.blend` models go through headless Blender, one process per model. Blender is GPL and runs as a
separate process. `.max`, `.ma` and `.mb` models need their authoring application and are reported as skipped.
Other model formats are skipped with a reason.

Blender resolves in this order:

1. `THREENATIVE_BLENDER`, an absolute path to a Blender 3.6 or newer executable.
2. `blender` on `PATH`.
3. A pinned Blender LTS release in the toolchain cache (`THREENATIVE_TOOLCHAIN_DIR`). The tool downloads it
   from `download.blender.org` on first use and checks its SHA-256 against the digest pinned in
   `src/unity/blender.ts`. The download is about 380 MB and is Linux x64 only.

`THREENATIVE_TOOLCHAIN_AUTOINSTALL=0` turns the download off. The error then names the fix. `npm run doctor`
lists the cached Blender and the one in use.

Scale follows the `ModelImporter` settings. The result is `globalScale` times the file unit when
`useFileScale` is on (a centimetre FBX is 0.01 per unit), and `globalScale` times the raw units when it is off.

## Material slots

Each material in the FBX binds to a `.mat` in this order. The report records the source per slot.

1. `externalObjects` in the model's `.meta` (`externalObjects`).
2. A search by name: the `.mat` with the same file name, nearest to the model first (its `Materials` folder,
   its folder, then the folders above). Equal candidates produce a warning.
3. The material Blender read from the FBX (`embedded`).

`materialImportMode: 0` binds nothing (`disabled`).

## Materials

| Shader | Result |
|---|---|
| Built-in Standard | Metallic setup: `_MainTex`, `_Color`, `_MetallicGlossMap` (R metallic, A smoothness times `_GlossMapScale`), smoothness from the albedo alpha, `_BumpMap`, `_OcclusionMap`, `_EmissionMap`, `_Mode` (cutout is `MASK`, fade and transparent are `BLEND`). |
| Built-in Standard (Specular setup) | Metallic 0 plus `KHR_materials_specular` (`specularColor = F0 / 0.04`). |
| URP Lit, SimpleLit, ComplexLit | `_BaseMap`, `_BaseColor`, `_Metallic`, `_Smoothness`, `_WorkflowMode`, `_Surface`, `_AlphaClip`, `_Cull`. SimpleLit becomes a non-metal. Clear coat is reported as unsupported. |
| HDRP Lit | The `_MaskMap` is split into a metallic-roughness image and an occlusion image, with the `_MetallicRemap`, `_SmoothnessRemap` and `_AORemap` ranges applied. |
| Anything else (Shader Graph, custom) | Status `fallback`. The saved `_BaseColor` or `_Color` and `_BaseMap` or `_MainTex` are kept, with the shader reference and the reason in the report. |

Colours are converted from sRGB to linear. The base map's tiling and offset become `KHR_texture_transform` on
every slot. Textures that the mapping does not carry (detail maps, parallax) are listed under `ignored`. A
texture marked `convertToNormalMap` is a height map that Unity turns into normals. The importer does not
convert it. It leaves the slot empty and lists the feature under `unsupported`.

## Textures

PNG, JPEG, TIFF, GIF and WebP are decoded with `sharp`. `sharp` cannot read TGA or PSD, so TGA has its own
decoder and PSD uses `ag-psd` (MIT). PSD needs a flattened composite (Maximize Compatibility on). BMP, DDS, EXR
and HDR are not decoded: the slot stays empty and the material carries a warning.

Normal maps and masks stay linear: their bytes are not changed. A colour texture that Unity samples as linear
(`sRGBTexture: 0`) is re-encoded to sRGB. `flipGreenChannel` is applied to normal maps.

## Measuring fidelity

`npx tsx scripts/fidelity-sheet.ts --unity-package <file> [--unity-reference <R1 dir>] [--import <dir>] --out <dir>` scores
an import against a Unity picture and writes a reference | after sheet with the verdict and score (hue, saturation,
silhouette fill, 0..100) under each render. The reference is `R1` when the folder has a `bounds.json` (rendered by
`scripts/unity/ReferenceRender.cs`, which also gives the sizes the sheet checks to 1 %), else `R2`, the package's
own `preview.png` files. `npm run parity:unity` does the same for the corpus packs `U1` to `U3` and writes the files
`scripts/fidelity-baseline.ts check` reads. `tests/unity-visual-regression.test.ts` locks the material rules.

## Limits

- The corpus packs of the epic (`U1` to `U3`) are not imported yet, so no row is Verified.
- Prefab hierarchies, scenes, animation and LODs are out of scope for this tool (PRD-618 adds prefabs).
- The Standard shader identity (`fileID` 46 and 45 in the built-in extra resources) is from the Unity manuals and
  is unverified on a real pack.
