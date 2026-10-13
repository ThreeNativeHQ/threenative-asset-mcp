# Unreal import support

[← Back to the README](../README.md)

What the Unreal/Fab importer converts, and how to set it up. The per-class ledger is [unreal-format-support.md](unreal-format-support.md). Loading the results in Three.js is in [unreal-threejs-usage.md](unreal-threejs-usage.md). Per-version importer notes are in [unreal-importer-history.md](unreal-importer-history.md).

The importer writes the same GLB/report layout for cooked and uncooked inputs.
It auto-provisions UE Viewer for package metadata, textures, and cooked render
data. For uncooked UE4 editor meshes it also provisions the separate GPL-3.0+
`unreal-assets-to-glb` CLI in an isolated Python virtual environment and invokes
it out of process. Modern UE5 packages rejected by UE Viewer use a pinned,
out-of-process CUE4Parse adapter. Set `THREENATIVE_TOOLCHAIN_AUTOINSTALL=0` to
require manually installed tools instead.

**Supported, verified and missing formats:** [`docs/unreal-format-support.md`](unreal-format-support.md)
is the tracking ledger for every Unreal 4 and 5 class, with its status, evidence and gaps.

## Fab login for owned packs

`fab_import_asset` and `fab_list_owned` read your Fab library through
[FabCLI](https://github.com/zirklerite/FabCLI), which the importer installs on first
use. The MCP never signs in for you. Log in once; the session is kept in the OS
keyring (Secret Service on Linux) and lasts about 90 days:

```bash
~/.cache/threenative-asset-mcp/toolchain/fabcli/fabcli auth login           # opens a login window
~/.cache/threenative-asset-mcp/toolchain/fabcli/fabcli auth login --manual  # no window: paste a code
~/.cache/threenative-asset-mcp/toolchain/fabcli/fabcli auth status
```

`--manual` reuses the browser where you are already signed in to Epic. FabCLI prints a
`epicgames.com/id/login?redirectUrl=…` link; open it there, copy `authorizationCode` from the
JSON the page shows, and paste it into the prompt within a few minutes. It needs an
interactive terminal. In Claude Code, run it with a `!` prefix. Never paste the code into an
untrusted service: it grants full access to the Epic account.

`fab_list_owned` lists each listing's Unreal artifacts separately (`artifacts[]`: `artifactId`,
`engineVersions`, `oldestEngine`, decoder `route`, `targetPlatforms`). An artifact's format is its
oldest listed engine, and that picks the decoder. When a listing has several artifacts and
`fab_import_asset` gets neither `engine` nor `artifactId`, it takes the best route (CUE4Parse, then
the MeshDescription converter, then UE Viewer; the newest source format breaks a tie) and says so
in the report `warnings`. Pass `artifactId` or `engine` to override.

**Graph-only colour.** Some Unreal materials compute BaseColor in the material graph (layered
masters that blend colour textures by mask channels and tint them), so no texture binding can
reproduce them. A section left without a base colour is baked from its graph: the pack's editor
package is read with CUE4Parse, a closed node set is evaluated per texel, and the result is a
base-colour PNG with `source: "graph"` in the section's bindings. The bake is `exact` only when
every node is understood; engine layer functions that are not in the pack, a mesh without vertex
colours standing in white, and a UV set the importer drops make it `heuristic`, and the section's
`graph` field names each approximation. View-dependent nodes (`Fresnel`, `DepthFade`, `TwoSidedSign`)
stand in as a recorded approximation: a bake has no camera, so `Fresnel` is its mean over a sphere's visible
surface, `DepthFade` is fully faded in and `TwoSidedSign` is the front face. Nodes it cannot evaluate (for
example `ReflectionVectorWS` feeding a cubemap lookup, or `Time`) leave the neutral fallback and are listed
under `graph.unsupportedNodes`.
The first bake installs the CUE4Parse converter and its private .NET SDK (hundreds of MB, once);
pass `graphBake: false` to the importer, or set `THREENATIVE_TOOLCHAIN_AUTOINSTALL=0`, to skip it.
`fab_import_asset` also skips it when its environment has `THREENATIVE_GRAPH_BAKE=0` (the parity
sweep's `--no-graph-bake` uses this to produce a baseline).

| Input | Current result |
| --- | --- |
| Cooked loose UE4 static meshes and textures | GLB geometry, LOD sections, embedded textures, and common PBR reconstruction |
| Cooked loose UE4 skeletal meshes and standalone animation packages | Standard skinned GLB; joints, weights, inverse-bind matrices, and existing clips are preserved; ActorX PSA clips are attached by case-insensitive bone name when at least 80% of tracks match, without duplicating an existing clip name |
| UE5 `AnimSequence`, blend spaces, aim offsets, montages and composites | UE5.0–5.5 conventional clips and UE5.4+ FK Sequencer-model clips become glTF animations and attach by bone name; blend spaces, aim offsets, montages and composites become `Animation/<name>.json` with typed axes, mirror flags and resolved section starts, and `<clip>.clip.json` sidecars preserve notifies, curves and sync markers. Current release 0.12.0 / importer124 / converter `.584.10.2` fresh public/native proof retains 325 selected UE5.4 clips and 7 UE5.8 clips. Independent actual UE5.8.3 full-pose comparison passes 7 clips, 8 GLB-document comparisons and 72,233 keys (actual current maximum 0.000264° against 0.5°); scope is serialized raw bones, excluding only 2 independently declared mannequin virtuals and no face bones. Static poses remain intact; non-FK graphs remain reported. Current independent replay and all four local repository gates pass (PRD-596); selected clips do not prove whole-pack or generated-virtual-bone support. |
| Uncooked UE4 `FMeshDescription` static meshes (object versions 517–522) | GLB geometry with centimetres converted to metres; verified on Fab Office Pack Vol.1 (47/47 meshes) |
| Uncooked UE5 editor static meshes (source models only, no render data) | Requested payload-backed `FMeshDescription` source models are decoded from the package trailer's Oodle payloads as `Models/<name>_LOD<n>.glb`; `BuildScale3D` from `SourceModels[0].BuildSettings` is applied on the modern route. Source models Unreal generates at build time are reported as generated and are not faked. Verified on Fab's Megascans European Hornbeam UE5.1 artifact for LOD0/1/2 |
| Uncooked UE4.0–4.20 static and skeletal meshes (object versions below 517) | Exported by UE Viewer from the editor source data, with materials, skins, and ActorX clips like cooked packages. Verified on Fab packs from UE4.10 to UE4.20: Modular Building Set (129 meshes), Animal Variety Pack (6 rigged animals, 146 clips), STF Landscape Pro 2.0 (61), Power Plant (65), and a UE4.19 fern pack (38) |
| Standalone `Texture2D` packages | Collision-free source-relative PNGs under `textures/`; duplicate Unreal basenames are exported independently instead of overwriting one another |
| `Texture2D` with an `RGBA16F` source | Raw little-endian half-float RGBA binaries and a versioned JSON manifest under `data-textures/`, promoted together under the package's qualified path. Values are stored, not decoded: no PivotPainter, classifier, source UV, graph or WPO semantics, and no material binding. The PNG exporters cannot encode the format, so the importer asks the converter for this route after a legacy PNG export fails; a UE 4.x pack needs its `engine` (`UE_4.19`), since the default detector reads every UE4 package as the latest UE4. Loaded in the browser with `threenative-asset-mcp/data-texture` (see [unreal-threejs-usage.md](unreal-threejs-usage.md)) |
| `TextureCube` environment maps | Collision-free 2:1 equirectangular PNG or lossless Radiance HDR files under `cubemaps/`; CUE4Parse decodes cooked faces, while editor `TSF_BGRE8` source art retains its lighting range without Unreal Engine |
| `Texture2DArray`, `TextureCubeArray`, and `VolumeTexture` | Collision-free RGBA8 slice data plus JSON dimensions under `textures3d/`; use `DataArrayTexture` for arrays and `Data3DTexture` for volumes. Cube-array faces remain ordered in groups of six for custom shaders. Floating-point/HDR stacks are rejected rather than reduced to RGBA8 |
| Standalone `Material` and `MaterialInstanceConstant` packages | One directly loadable `Materials/UnrealMaterialLibrary.glb`; each source-relative swatch name is collision-free, follows parent instances, embeds resolved texture inputs, and applies common base-color/emissive vectors plus roughness/metallic/opacity scalars |
| Standalone `SoundWave` packages | Collision-free WAV/Ogg/MP3/FLAC files under `audio/`; modern UE5 editor source WAVs and cooked formats exposed by CUE4Parse feed the same report path, verified through Three.js `AudioLoader` |
| Skeletal and static mesh sockets, static-mesh simple collision, `PhysicsAsset`, and `SoundCue` graphs | Socket nodes (`socket:<name>`) under the joint their bone names (or the mesh node for a static socket); simple collision on the mesh node's `extras.unrealCollision` and in `Collision/<package>.json`; physics bodies, constraints (limits, motions and drives) and collision-disabled pairs in metre-scale `Physics/<asset>.json`, referenced from the skinned mesh node; and each SoundCue graph in `Audio/<cue>.cue.json` with every `WavePlayer` leaf rewritten to the exported audio file or reported as a missing wave. A UE4 package that holds one of these classes routes to the CUE4Parse adapter, which UE Viewer cannot decode; an ordinary UE4 mesh whose only gameplay signal is a `BodySetup` or a cross-package PhysicsAsset/Skeleton reference joins the adapter run for its metadata while keeping its verified UE Viewer geometry route |
| Runtime `Font` and inline `FontFace` packages | Validated TTF/OTF faces under collision-free `fonts/` paths; direct SFNT and legacy multi-block zlib `FontBulkData` are supported without Unreal Engine, with family/style/weight metadata for the browser `FontFace` API |
| Offline `Font` packages | Pre-baked glyph pages and serialized `FontCharacter` rectangles become collision-safe atlas PNGs plus BMFont-compatible JSON under `bitmap-fonts/`; Unicode remaps, baseline metrics, kerning, page indices, and distance-field metadata are retained for Three.js bitmap/SDF text |
| Paper2D `PaperSprite` and `PaperFlipbook` packages | Each sprite becomes a self-contained, unlit GLB with exact baked triangles and a cropped atlas region; flipbooks become JSON manifests preserving FPS and per-frame run lengths. Verified in Three.js on a real UE5.2 Paper2D project without Unreal Engine |
| Paper2D `PaperTileSet` and `PaperTileMap` packages | Populated layers become indexed, unlit GLB quads with atlas UVs, empty cells omitted, layer order retained, and packed horizontal/vertical/diagonal tile flips decoded. Placed tile maps and inherited Blueprint flipbook components are reconstructed in modern UE5 levels |
| Paper2D grouped sprites and `TextRenderActor` | Grouped sprite instances become `EXT_mesh_gpu_instancing` batches over shared sprite GLBs; text becomes unlit glyph geometry from offline `UFont` atlas pages, preserving alignment, colour, world size, and placement |
| `DataTable`, `StringTable`, `CurveTable`, and float/vector/colour curves | Collision-free, directly fetchable JSON under `data/`; row names, typed fields, localized strings, asset references, and rich-curve keys/tangents are retained |
| Modern UE5 loose static meshes, skeletal meshes, `Texture2D`, Material, and `.umap` packages rejected by UE Viewer | CUE4Parse converts directly to the same output/report pipeline; verified with UE5.5 cooked static geometry, UE5 editor skeletal geometry, Oodle-compressed UE5.3 editor texture source art, and a UE5.2 Paper2D map. Editor source art is restored to display colour: `TSF_BGRA8` sources are stored with red and blue swapped, and sRGB-sampled `TSF_RGBA16` sources are linear, so both are corrected (checked against UE Viewer's export of the same textures from the UE4.27 artifact). Cooked packages using unversioned properties require one matching `.usmap` file beside the imported tree |
| Separate roughness/metalness, solid palette maps, glass, and mirrors | Packed glTF PBR maps or explicit material fallbacks; extra graph inputs remain named sidecars |
| UE4 `.umap` placement, direct lights, and serialized Blueprint component templates (object versions 517–522) | Directly loadable scene GLB plus a transform/source manifest; repeated actors instance shared meshes; inherited mesh/light defaults are merged into placed instances; directional, point, and spot lights use `KHR_lights_punctual` |
| UE5 World Partition `.umap` external actors | The selected level export loads `__ExternalActors__` packages with the same provider mount and complete map path into the scene; external actor/object packages belonging to maps outside the import remain reported as skipped. Real-pack verification is tracked by PRD-598 |
| Standalone modern UE5 Blueprint prefabs | Serialized static/skeletal mesh and light component defaults become directly loadable scene GLBs; referenced meshes, transforms, skins, and bone hierarchies are retained, while bytecode is explicitly reported and never executed |
| UE4 ISM/HISM and painted static-mesh foliage placement | Bulk-serialized instance matrices become `EXT_mesh_gpu_instancing`, which Three.js `GLTFLoader` loads as GPU-instanced meshes |
| UE4 editor `LandscapeComponent` heightfields | Package-relative compressed BGRA8 heightmaps become indexed terrain meshes with decoded normals, component transforms, and original material names |
| UE5 level `Landscape` and `LandscapeStreamingProxy` heightfields | CUE4Parse follows every proxy component, restores trailer-backed BGRA8 source pixels, and emits indexed terrain meshes with decoded heights, normals, proxy-root transforms, and material identity |
| ActorX per-frame bone scale, dynamic Blueprint bytecode/construction scripts, Paper Terrain/spline deformation, and Nanite-only data without a fallback mesh | Detected or reported honestly; scene-level omissions are listed in `scenes[].omittedActors`, and Blueprint bytecode is never executed by the importer |
| Arbitrary Unreal shader graphs | Recoverable PBR inputs become standard glTF materials. Reports mark materials as degraded when shader connections are unavailable, even if every section has a texture; section `limitations` explain omitted layering, graph UV transforms, subsurface lighting, normal strength, and deformation |
| Encrypted Pak/IoStore | Unsupported without user-supplied keys and archive extraction; never reported as a complete conversion |

Automatic uncooked conversion needs Python 3 with `venv` and `pip`. A Linux
source build fallback for UE Viewer additionally needs `git`, `g++`, `perl`,
zlib, and SDL2 development headers. Unreal import currently runs on Linux and
Windows; use the path overrides in [configuration.md](configuration.md) for preinstalled executables.
Installation-only Unreal `BasicShapes/Plane` references are generated locally
when the asset pack does not contain that mesh. Rectangular area lights are
preserved in scene metadata and approximated as punctual point lights because
glTF's standard punctual-light extension has no area-light type.

## Parity sweep and material metadata dumps

`npm run parity:fab` imports every owned Fab artifact and scores it against its source package
(`scorecard.json`). `--export-metadata <dir>` also writes one replayable material dump per pack;
replay them with `FAB_METADATA_DIR=<dir> npx vitest run tests/fab-metadata.test.ts`. Dumps hold
licensed pack names and are local-only: never commit them.

Set `THREENATIVE_UNREAL_PREVIEW_REFERENCE=/path/to/reference.json` to light the comparison sheets (`parity:fab` and
`scripts/fidelity-sheet.ts`) with a local version-1 reference profile: radiance and Grid binaries beside the JSON, each
checked by SHA-256. It is read once per command, and an invalid profile stops the run before any download. Unset, the
sheets use the approximation and say so. Each picture records what lit it (`identity` in `picture-lighting.json`,
`sheets/<label>.json` and the scorecard entry). `--resume --sheets` refuses a kept sheet drawn otherwise: resume into a
new `--out`, or add `--no-sheets`. Profiles and binaries derive from licensed packs: keep them local-only, never commit them.
