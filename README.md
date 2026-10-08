# threenative-asset-mcp

A [Model Context Protocol](https://modelcontextprotocol.io/) server for finding
3D assets across [Fab](https://www.fab.com/),
[Poly Haven](https://polyhaven.com/), [ambientCG](https://ambientcg.com/),
[Smithsonian 3D](https://3d.si.edu/), [Sketchfab](https://sketchfab.com/), and a
curated game-audio catalog spanning Sonniss, Kenney, Tallbeard, Scott Buckley,
itch.io, Mixkit, Pixabay, Freesound, OpenGameArt, and Abstraction. It gives AI clients provider-scoped,
structured search, asset metadata, category/filter discovery, downloadable file
data, and guarded Fab downloads for directly available free files.

The audio tools separate **source discovery** from **verified direct downloads**.
All ten sources are described with license caveats and official browse pages;
only packs with stable official URLs and known license metadata appear in the
direct-download catalog. The initial downloadable set is Kenney Interface
Sounds, Kenney Music Jingles, and all five Sonniss GDC 2026 archives.

`fab_search_assets` defaults to free assets. This means Fab reported at least
one free or effectively free license; it does not imply every license tier is
free. Use `fab_get_asset` before making license or price claims.

Poly Haven results are CC0 and explicitly labelled `Powered by Poly Haven`.
`polyhaven_list_files` exposes official download URLs, hashes, sizes, and
dependency relationships with pagination and resolution/format filters.

> Status: experimental. Fab's `/i/*` JSON routes are undocumented and can
> change or restrict automated access. Poly Haven provides a documented public
> API, but clients must send a unique User-Agent and visibly credit Poly Haven.
> Sketchfab licenses vary per model and download URLs require a user API token.
> Review each provider's terms and each asset's license.

## Requirements

- Node.js 20.19 or newer
- A local environment capable of running Playwright Chromium when Fab requests
  browser verification
- No Epic or Fab login is required or automated for search and free downloads.
  `fab_import_asset` and `fab_list_owned` use your own FabCLI session; see
  [Fab login for owned packs](#fab-login-for-owned-packs)
- **On Linux, `g++`, `perl`, `zlib1g-dev`, `libpng-dev` and `libsdl2-dev`** for Unreal imports
  of UE4.0–4.20 packs. UE Viewer's Linux prebuilt is a 32-bit binary that 64-bit-only
  hosts cannot run, so the importer builds it from source once
- **FFmpeg and FFprobe on `PATH`** for `audio_inspect_asset` and
  `audio_generate_sound`. Without them nothing is decoded, and the tools report
  that they could not check rather than reporting a pass.
- An **ElevenLabs API key of your own** for `audio_generate_sound` only. Every
  other tool, including local audio inspection, works without one.

## Install

An MCP host can launch the published package with:

```bash
npx -y threenative-asset-mcp
```

For a local checkout:

```bash
npm ci
npm run browser:install
npm run typecheck
npm test
npm run build
node dist/index.js
```

Playwright does not download Chromium as part of a normal package install. Run
`npx -p playwright@1.62.0 playwright install chromium` once on the MCP host
before relying on the browser fallback.

## MCP host configuration

### Codex

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.assets]
command = "npx"
args = ["-y", "threenative-asset-mcp"]
```

For a local build:

```toml
[mcp_servers.assets]
command = "node"
args = ["/absolute/path/to/threenative-asset-mcp/dist/index.js"]
```

### Claude Desktop

Add a server entry to the Claude Desktop configuration:

```json
{
  "mcpServers": {
    "assets": {
      "command": "npx",
      "args": ["-y", "threenative-asset-mcp"]
    }
  }
}
```

### VS Code

Create `.vscode/mcp.json`:

```json
{
  "servers": {
    "assets": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "threenative-asset-mcp"]
    }
  }
}
```

Restart the MCP host after changing its configuration.

## MCP tools

Fab:

- `fab_search_assets` — searches public listings. `priceMode` defaults to
  `free`; use `any` or `range` explicitly for paid results. Search payloads
  carry no file formats, so there is no format filter; `fab_get_asset` reports
  a listing's formats.
- `fab_get_asset` — returns normalized public listing details and per-license
  effective prices.
- `fab_list_filters` — returns known public filter labels and slugs, including
  an explicit warning when the versioned fallback is used.
- `fab_list_limited_time_free` — reads only a separately verified curated
  promotion surface. In production it extracts canonical listing UUIDs from
  Fab's public `/limited-time-free` page through the dedicated browser, then
  resolves them through the normal detail client; it never substitutes general
  `is_free=1` search.
- `fab_download_free_asset` — downloads one directly available free file into
  the dedicated download directory after explicit Fab EULA acknowledgement. It
  refuses purchase, acquisition, library-only, ambiguous, and unsafe-path
  flows.
- `asset_import_unreal` — converts an already-downloaded Unreal directory to
  self-contained GLBs plus `import-report.json`; Unreal Engine is not required.
- `fab_import_asset` — downloads an owned listing through the user's existing
  FabCLI session, then runs the same Unreal importer. It never signs in, claims,
  or purchases an asset.

Poly Haven:

- `polyhaven_search_assets` — searches HDRIs, textures, and models by text,
  type, and category, with relevance/popularity/date/name sorting and cursor
  pagination.
- `polyhaven_get_asset` — returns normalized metadata, attributes, authors,
  dimensions, resolution, and CC0 licensing for one asset.
- `polyhaven_list_categories` — returns category labels and counts for one
  asset type.
- `polyhaven_list_files` — returns the official file URLs, sizes, MD5 hashes,
  and dependency relationships. Use `resolution` and `format` to select usable
  variants; follow `nextCursor` until absent to retrieve every matching file.

ambientCG:

- `ambientcg_search_assets` — searches CC0 materials, HDRIs, substances,
  decals, atlases, 3D models, images, brushes, terrains, and HDRI elements.
- `ambientcg_get_asset` — returns metadata, maps, technique, dimensions,
  statistics, and CC0 licensing.
- `ambientcg_list_categories` — lists typed categories and asset counts.
- `ambientcg_list_files` — returns official archives with variant attributes,
  extensions, URLs, and byte sizes.

Smithsonian 3D:

- `smithsonian_search_assets` — searches Open Access models by text, format,
  quality, owning unit, Draco compression, and glTF orientation compliance.
- `smithsonian_get_asset` — groups the file-centric API response into one model
  summary.
- `smithsonian_list_files` — returns direct model files with format, quality,
  compression, and orientation metadata.

Sketchfab:

- `sketchfab_search_models` — anonymously searches public models, defaulting to
  downloadable results, and preserves author, geometry, archive, and license
  metadata.
- `sketchfab_get_model` — returns public detail and explicit Creative Commons
  requirements.
- `sketchfab_list_categories` — lists public category names and slugs.
- `sketchfab_get_downloads` — uses `SKETCHFAB_API_TOKEN` to retrieve temporary
  download URLs. It never stores the token or returns it in tool output.

Game audio:

- `audio_list_sources` — lists the ten supported audio libraries, best uses,
  official browse pages, license/attribution cautions, and honest download
  capability (`curated-direct` or `provider-page`).
- `audio_search_assets` — searches only the curated packs with stable official
  direct URLs. Results preserve license, commercial-use, attribution, source,
  size (when known), and redistribution metadata.
- `audio_download_asset` — downloads a catalog asset by ID after
  `acceptLicense: true`. It uses an HTTPS host allowlist, validates every
  redirect, streams with a byte cap, writes atomically without overwrite, and
  returns the local path, byte size, and SHA-256.
- `audio_inspect_asset` — measures one local WAV, Ogg, MP3, or FLAC with the
  pinned `@threenative/playtest` inspector: decode integrity, silence floor,
  peak ceiling, DC offset, a five-band spectrum, the loop seam of a **declared**
  loop, and the requested duration, plus a spectrogram PNG. Needs no ElevenLabs
  key and never modifies or repairs the file. Optionally compares prompt and
  emotional tone when local CLAP is provisioned.
- `audio_generate_sound` — **spends ElevenLabs credits.** Generates one sound
  effect or ambience from a prompt using *your own* `ELEVENLABS_API_KEY`, saves
  the original response plus a PCM16 WAV, and runs the same inspection
  automatically. Reusing a `requestId` returns the saved result instead of
  charging again.

### Generating a sound

The loop is **generate once → inspect → revise the one property that failed →
explicitly generate again.** There is no best-of-N retry: every generation is a
separate billable invocation you ask for on purpose.

Describe source, action, material, distance, and timing. A useful brief:

> One short metal latch closing, close microphone, dry recording, single event
> with natural decay, no speech or music.

These are prompting conventions absorbed from ElevenLabs' own
[sound-effects skill](https://github.com/elevenlabs/skills/blob/9edcbd4b80ed57b8e07a3f86ea520333969fbc3c/sound-effects/SKILL.md)
(MIT, reviewed at commit `9edcbd4b`), which is linked and attributed rather than
installed. They are conventions, not guaranteed exclusion controls.

`audio_generate_sound` requires `ELEVENLABS_API_KEY` in the server environment.
It is never bundled, defaulted, or logged: without your own key the tool fails
with `AUDIO_GENERATE_NO_CREDENTIALS` and an instruction to set one, while the
catalog and inspection tools keep working normally.

What the inspection does and does not tell you:

| It answers | It does not answer |
| --- | --- |
| Is it broken, silent, clipped, DC-offset, or the wrong duration? | Is it a *good* sound? |
| Does a declared loop click at the wrap? | Does it suit this scene? |
| Is the frequency content inside bounds *you* supplied? | Is the mix right? |

`artisticQuality` is always `"unverified"`. There is no `soundsGood` flag and no
single quality score. `recommendation: "audition"` means the technical checks
passed and every requested check completed — it means *go listen to it*, not
*ship it*. A definite technical failure recommends `"reject"`; a warning, a
possible mismatch, or an incomplete requested check recommends `"review"`.

If asset compilation rewrites the bytes, inspect the compiled output before
describing that output as checked.

### Optional local CLAP setup

Prompt fit and emotion fit are **off by default** (`semantic: "off"`) and add no
dependency to `npm install`. To enable them:

```sh
python3 -m venv ~/.venvs/clap
~/.venvs/clap/bin/pip install "laion-clap==1.1.6" "torch==2.4.1" \
    "torchaudio==2.4.1" "librosa==0.10.2.post1" "numpy<2"
# Download 630k-audioset-best.pt from the LAION-AI/CLAP releases and check its hash.
export AUDIO_CLAP_CHECKPOINT=/path/to/630k-audioset-best.pt
export AUDIO_CLAP_PYTHON=~/.venvs/clap/bin/python
```

Nothing is downloaded implicitly and no GPU is required. With `semantic: "clap"`
and no provisioned model, you get the technical result plus an explicit
unavailable semantic result and this instruction — never a semantic pass. A
generation that requests `semantic: "clap"` is refused in preflight, before
spending, when the model is missing.

Scores are cosine similarities used as **supporting evidence**, never
probabilities or quality grades. The emotion check builds otherwise identical
hypotheses — `The sound of {sourceDescription}, with a {mood} emotional tone.` —
so only the mood clause differs, and **this use of CLAP is a proposed heuristic,
not a demonstrated emotion-recognition capability**: mood status stays
`unverified` until the held-out emotion calibration qualifies your domain. Check
the CLAP code and checkpoint licensing separately before redistributing either.

Curated itch.io packs:

- `itch_list_downloads` — resolves a fresh no-account download page and lists
  upload IDs, filenames, sizes, CC0 terms, and pack-specific cautions without
  exposing the signed page token.
- `itch_download_asset` — resolves a fresh 60-second signed file URL and streams
  the selected upload into guarded storage after `acceptLicense: true`. Signed
  URLs are not returned. The initial catalog covers Tallbeard Music Loop
  Bundle, Quaternius Universal Animation Libraries 1 and 2, Brackeys VFX
  Bundle, and KayKit Platformer.
- `asset_list_bundle_entries` — reads the remote ZIP directory with HTTP byte
  ranges and returns individual paths and sizes without downloading the archive.
- `asset_download_bundle_entry` — range-fetches and extracts one selected file,
  caches it with a SHA-256 sidecar, and never downloads unrelated bundle files.
- `asset_list_bundle_animations` — range-fetches only an aggregate GLB and lists
  its named animation clips. For Quaternius, it automatically prefers the
  standard non-root-motion GLB.
- `asset_download_bundle_animation` — exports one named animation as a valid
  animation-only GLB, removing unrelated clips, meshes, materials, and textures.
  The cached aggregate GLB is reused across requests.

Unified source and download routing:

- `asset_list_sources` — returns only **agent-ready sources by default** across
  3D, textures, HDRIs, animations, VFX, 2D, UI, icons, fonts, and audio. An
  agent-ready source has an MCP download tool and requires no manual browser,
  login, checkout, donation prompt, or paywall. Pass `agentReadyOnly: false` to
  inspect the broader research directory, including package-manager, Git, and
  provider-page sources that are not yet integrated.
- `asset_search_sources` — filters that directory by text, category, access
  mode, and license tag (`cc0`, `cc-by`, `mit`, and others), while preserving
  the same agent-ready-only default.
- `asset_download_file` — streams a direct URL previously returned by
  `polyhaven_list_files`, `ambientcg_list_files`, `smithsonian_list_files`, or
  the Game-icons.net bulk archive or Kenney Particle Pack entry into guarded
  local storage. Provider hosts and URL shapes are allowlisted, redirects are
  revalidated, existing files are never overwritten, and the result includes
  SHA-256.

The additive `asset_search` tool searches individual `3d-model`, `texture`,
`hdri` and `animation` candidates across supported clients. It reports each
provider, bounded results and local continuation actions. Unknown prices fail
`freeOnly`; unknown rights fail explicit commercial-use/attribution filters.
Fab remains a specialized action and generic Sketchfab uses anonymous metadata,
without authenticated acquisition. Existing tools retain their public names.

Use `asset_get` with the returned stable `assetId` to inspect current terms and
available variants. It prefers GLB, then glTF with its supplied dependencies;
explicit unavailable formats return alternatives. The read-only call returns an
expiring `planToken`, required relative files and acknowledgement information.
A plan is not consent. Call `asset_download` with that token and explicit
`acceptLicense: true` only after reviewing the terms. Optional `maxBytes` can
only tighten the configured cap. Changed terms/files invalidate the plan.

Acquisition stages originals under `ASSET_DOWNLOAD_DIR/acquisitions`, verifies
checksums and all glTF buffer/texture references, then atomically publishes a
complete directory with `asset.acquisition.json`. Replays verify cached bytes
and provenance; a corrupt cache fails rather than being silently accepted.
Receipts preserve asset attribution separately from Poly Haven API credit.
No transfer/signed URLs or credentials enter the new public plan or receipt.
Archives stay archives with `requiresExtraction: true`; runtime readiness is
`unverified`. Acquiring originals does not change or adopt assets into a project.

Kenney 3D packs are enabled by default; `ASSET_ENABLE_KENNEY=0` disables the
generic adapter. Each query uses one official listing page and at most three
item detail checks,
paces requests, verifies item CC0/free/official-ZIP evidence and never crawls
or extracts archives. One official Mini Dungeon archive was qualified through
the packed public MCP on 2026-10-06. Broader catalog coverage and runtime import
remain unverified; ordinary tests use hand-authored local fixtures.

Recommended agent flow:

1. Call `asset_search_sources` with the requested category/query. Its default
   result set is guaranteed to contain only agent-ready sources.
2. Call the returned `searchTool` or `detailTool` when present.
3. Resolve variants with the returned `filesTool`.
4. Call the returned `downloadTool` with `acceptLicense: true`.
5. For aggregate Quaternius animation libraries, skip whole-pack download:
   `itch_list_downloads` → `asset_list_bundle_animations` →
   `asset_download_bundle_animation`.

This is intentionally a short MCP tool chain rather than a fake universal URL:
each provider keeps its real search/variant semantics, while source routing and
the no-manual-flow guarantee stay uniform.

All discovery tools are read-only. Download tools write only within their
dedicated local directories and never purchase, add to cart or library,
wishlist, sign in, or overwrite an existing download. Audio packs remain
subject to their source license; raw redistribution is not implied by download.

## Unreal import support

The importer writes the same GLB/report layout for cooked and uncooked inputs.
It auto-provisions UE Viewer for package metadata, textures, and cooked render
data. For uncooked UE4 editor meshes it also provisions the separate GPL-3.0+
`unreal-assets-to-glb` CLI in an isolated Python virtual environment and invokes
it out of process. Modern UE5 packages rejected by UE Viewer use a pinned,
out-of-process CUE4Parse adapter. Set `THREENATIVE_TOOLCHAIN_AUTOINSTALL=0` to
require manually installed tools instead.

### Fab login for owned packs

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
`graph` field names each approximation. Nodes it cannot evaluate (for example `DepthFade`,
`MatLayerBlend_Tint`) leave the neutral fallback and are listed under `graph.unsupportedNodes`.
The first bake installs the CUE4Parse converter and its private .NET SDK (hundreds of MB, once);
pass `graphBake: false` to the importer, or set `THREENATIVE_TOOLCHAIN_AUTOINSTALL=0`, to skip it.
`fab_import_asset` also skips it when its environment has `THREENATIVE_GRAPH_BAKE=0` (the parity
sweep's `--no-graph-bake` uses this to produce a baseline).

| Input | Current result |
| --- | --- |
| Cooked loose UE4 static meshes and textures | GLB geometry, LOD sections, embedded textures, and common PBR reconstruction |
| Cooked loose UE4 skeletal meshes and standalone animation packages | Standard skinned GLB; joints, weights, inverse-bind matrices, and existing clips are preserved; ActorX PSA clips are attached by case-insensitive bone name when at least 80% of tracks match, without duplicating an existing clip name |
| Uncooked UE4 `FMeshDescription` static meshes (object versions 517–522) | GLB geometry with centimetres converted to metres; verified on Fab Office Pack Vol.1 (47/47 meshes) |
| Uncooked UE5 editor static meshes (source models only, no render data) | LOD0 of the `FMeshDescription` source model is decoded from the package trailer's Oodle payloads, with the cooked glTF writer's axes, scale, and material naming. Verified on Fab's Megascans Common Hazel and European Hornbeam UE5.1 artifacts: triangle counts match the UE4.27 decoder of the same scans exactly |
| Uncooked UE4.0–4.20 static and skeletal meshes (object versions below 517) | Exported by UE Viewer from the editor source data, with materials, skins, and ActorX clips like cooked packages. Verified on Fab packs from UE4.10 to UE4.20: Modular Building Set (129 meshes), Animal Variety Pack (6 rigged animals, 146 clips), STF Landscape Pro 2.0 (61), Power Plant (65), and a UE4.19 fern pack (38) |
| Standalone `Texture2D` packages | Collision-free source-relative PNGs under `textures/`; duplicate Unreal basenames are exported independently instead of overwriting one another |
| `TextureCube` environment maps | Collision-free 2:1 equirectangular PNG or lossless Radiance HDR files under `cubemaps/`; CUE4Parse decodes cooked faces, while editor `TSF_BGRE8` source art retains its lighting range without Unreal Engine |
| `Texture2DArray`, `TextureCubeArray`, and `VolumeTexture` | Collision-free RGBA8 slice data plus JSON dimensions under `textures3d/`; use `DataArrayTexture` for arrays and `Data3DTexture` for volumes. Cube-array faces remain ordered in groups of six for custom shaders. Floating-point/HDR stacks are rejected rather than reduced to RGBA8 |
| Standalone `Material` and `MaterialInstanceConstant` packages | One directly loadable `Materials/UnrealMaterialLibrary.glb`; each source-relative swatch name is collision-free, follows parent instances, embeds resolved texture inputs, and applies common base-color/emissive vectors plus roughness/metallic/opacity scalars |
| Standalone `SoundWave` packages | Collision-free WAV/Ogg/MP3/FLAC files under `audio/`; modern UE5 editor source WAVs and cooked formats exposed by CUE4Parse feed the same report path, verified through Three.js `AudioLoader` |
| Runtime `Font` and inline `FontFace` packages | Validated TTF/OTF faces under collision-free `fonts/` paths; direct SFNT and legacy multi-block zlib `FontBulkData` are supported without Unreal Engine, with family/style/weight metadata for the browser `FontFace` API |
| Offline `Font` packages | Pre-baked glyph pages and serialized `FontCharacter` rectangles become collision-safe atlas PNGs plus BMFont-compatible JSON under `bitmap-fonts/`; Unicode remaps, baseline metrics, kerning, page indices, and distance-field metadata are retained for Three.js bitmap/SDF text |
| Paper2D `PaperSprite` and `PaperFlipbook` packages | Each sprite becomes a self-contained, unlit GLB with exact baked triangles and a cropped atlas region; flipbooks become JSON manifests preserving FPS and per-frame run lengths. Verified in Three.js on a real UE5.2 Paper2D project without Unreal Engine |
| Paper2D `PaperTileSet` and `PaperTileMap` packages | Populated layers become indexed, unlit GLB quads with atlas UVs, empty cells omitted, layer order retained, and packed horizontal/vertical/diagonal tile flips decoded. Placed tile maps and inherited Blueprint flipbook components are reconstructed in modern UE5 levels |
| Paper2D grouped sprites and `TextRenderActor` | Grouped sprite instances become `EXT_mesh_gpu_instancing` batches over shared sprite GLBs; text becomes unlit glyph geometry from offline `UFont` atlas pages, preserving alignment, colour, world size, and placement |
| `DataTable`, `StringTable`, `CurveTable`, and float/vector/colour curves | Collision-free, directly fetchable JSON under `data/`; row names, typed fields, localized strings, asset references, and rich-curve keys/tangents are retained |
| Modern UE5 loose static meshes, skeletal meshes, `Texture2D`, Material, and `.umap` packages rejected by UE Viewer | CUE4Parse converts directly to the same output/report pipeline; verified with UE5.5 cooked static geometry, UE5 editor skeletal geometry, Oodle-compressed UE5.3 editor texture source art, and a UE5.2 Paper2D map. Editor source art is restored to display colour: `TSF_BGRA8` sources are stored with red and blue swapped, and sRGB-sampled `TSF_RGBA16` sources are linear, so both are corrected (checked against UE Viewer's export of the same textures from the UE4.27 artifact). Cooked packages using unversioned properties require one matching `.usmap` file beside the imported tree |
| Separate roughness/metalness, solid palette maps, glass, and mirrors | Packed glTF PBR maps or explicit material fallbacks; extra graph inputs remain named sidecars |
| UE4 `.umap` placement, direct lights, and serialized Blueprint component templates (object versions 517–522) | Directly loadable scene GLB plus a transform/source manifest; repeated actors instance shared meshes; inherited mesh/light defaults are merged into placed instances; directional, point, and spot lights use `KHR_lights_punctual` |
| Standalone modern UE5 Blueprint prefabs | Serialized static/skeletal mesh and light component defaults become directly loadable scene GLBs; referenced meshes, transforms, skins, and bone hierarchies are retained, while bytecode is explicitly reported and never executed |
| UE4 ISM/HISM and painted static-mesh foliage placement | Bulk-serialized instance matrices become `EXT_mesh_gpu_instancing`, which Three.js `GLTFLoader` loads as GPU-instanced meshes |
| UE4 editor `LandscapeComponent` heightfields | Package-relative compressed BGRA8 heightmaps become indexed terrain meshes with decoded normals, component transforms, and original material names |
| ActorX per-frame bone scale, dynamic Blueprint bytecode/construction scripts, Paper Terrain/spline deformation, and Nanite-only data without a fallback mesh | Detected or reported honestly; scene-level omissions are listed in `scenes[].omittedActors`, and Blueprint bytecode is never executed by the importer |
| Arbitrary Unreal shader graphs | Recoverable PBR inputs become standard glTF materials. Reports mark materials as degraded when shader connections are unavailable, even if every section has a texture; section `limitations` explain omitted layering, graph UV transforms, subsurface lighting, normal strength, and deformation |
| Encrypted Pak/IoStore | Unsupported without user-supplied keys and archive extraction; never reported as a complete conversion |

Importer version 49 also respects material-instance override flags and modern
parameter names. Contradictory texture samples duplicated across distinct mesh
section families are repaired only when referenced texture families are
unambiguous in the same export namespace. These bindings remain heuristic.
Separate same-resolution opacity maps can supply base-colour alpha without
altering RGB; different source dimensions are currently unsupported. Existing
cached conversions are invalidated. A textured result does not certify the
appearance of the original Unreal shader.

Importer version 51 uses adaptive PNG row filtering for composed opacity maps,
preserving the previous encoder's decoded RGBA and PNG metadata. Untouched textures
retain their original bytes; their profiles, bit depth, and metadata are not
re-encoded for storage savings.

Importer version 56 stops a colour parameter's zero alpha from becoming the base
colour factor's opacity (a `Tint` of `A=0` clipped every pixel of a masked grass
card, so the GLB drew nothing), binds a masked or translucent material's separate
opacity map (`Opacity=` or an `Other` named `*_Opacity*`) as the base colour's alpha
heuristically, and composes an opacity map of another resolution when the aspect
ratio matches. A sweep sheet tile that renders nothing although Unreal has a
thumbnail for it is recorded under the entry's `sheet.warnings`.

Importer version 58 stops a texture-parameter default from inventing a glTF slot from a
texture UE Viewer already named as another output. A parameter can exist without being
wired to its own output, so when its default texture is already the resolved `.mat`'s
Diffuse (or Normal, and so on) it is a shared placeholder, not a second live slot (Old
West - VOL 5 Town Props declared an unused `Emissive` default equal to the Fill albedo,
which painted every dark-wood model with a flat grey emissive wash). Real parameter
overrides and `.mat`-named Emissive slots still bind, a default whose texture the `.mat`
left in `Other[]` still recovers its slot by parameter name, and a `.mat` that names no
slot (the modern converter's `Other[n]` references only) still falls back to the
collected defaults.

Importer version 60 recovers the cut-out of a masked foliage card whose UE Viewer `.mat`
resolves `Opacity=` to the albedo itself, which has no alpha. When the material references a
packed `<stem>_AORO` map (AO / roughness / opacity in R / G / B) beside that albedo, the map's
blue channel becomes the base colour's alpha. Temperate Vegetation: conifer Bushes & Saplings
had every needle card render as a solid rectangle (Pine_GroundTwig_01 as a full quad with the
needle atlas painted inside it) because the mask was never applied. The binding is heuristic
and named in the section's limitations; an opaque material, an unrelated texture stem, or a
map the pack did not export is left alone.

Importer version 59 applies a material instance's base-colour tint vector even when its
parameter name carries extra words. Old West - VOL 5 Town Props overrides both
`Albedo Color Tint (Base)` (a bright global multiplier) and `Base Color Tint (Mask)` (the
dark cloth colour) on a master that tints its albedo through a mask; the exact names missed
both, so every curtain kept `baseColorFactor` [1,1,1] and rendered the untinted light-grey
albedo. When both a global base multiplier and a mask colour are overridden, the mask tint is
the surface colour that shows through. Only an instance's own override is matched broadly, so
a master's placeholder default (the master's red `Base Color Tint (Mask)`) never paints an
un-tinted instance; a lone mask tint with no global multiplier (the 03a curtain, whose editor
mesh thumbnail is the untinted albedo) is left alone, and a `RockTint`-style name with no
colour token beside `Tint` is left to the graph baker.

Importer version 57 gives a mesh the `.mat` / `.props.txt` that sit beside it when two
packages share an object name (a pack with `MI_Rock_Inst` in two folders bound one
folder's normal map to the other's meshes); with none beside the mesh the pick is named
in the section's limitations. The graph bake now evaluates `ObjectScale` (1),
`PerInstanceRandom` (0.5) and `ObjectPositionWS` (origin) as named heuristic
approximations and `SplitComponents` exactly, which lets layered cliff-rock masters bake
their colour texture instead of falling back to neutral grey. The parity S4 check no
longer lets a 90% colour share hide sections whose graph is known to carry colour.

Legacy instance sidecars without override flags retain inherited settings for
ambiguous opaque, false, and zero defaults. Their non-default values retain the
previous behavior; missing flags are reported as a material limitation.

Importer version 50 reads a bounded authored-material subset from tagged UE4
object-version 516 packages (legacy -7, UE3 864, licensee 0). Exact source paths
and closest flagged static overrides select the active branches before reduction.
Mesh-only package selection still loads needed material parents from the source
file inventory without exporting unrelated packages; lookups stay within the same
Content namespace. Mesh import-table material references resolve duplicate source
basenames by exact object path. Multiple matching references refuse source routing;
a unique basename fallback reports its unresolved mesh routing.
Reroutes, scalar constants/parameters and representable multiplication recover
scalar roughness; glTF normalization retains the raw authored value in the report.
An authored scalar replaces any earlier roughness texture contribution while
retaining its packed metallic channel. Source functions, Specular conversion,
foliage shading and unsupported sampling remain explicit limitations.

AO.R is attached only with explicit `Texture2D.SRGB=false`, a serialized linear
sampler mode (`LinearColor`, `LinearGrayscale` or `Masks`), and source coordinates
matching the sampler of the currently bound albedo. Its existing glTF coordinate
mapping is reused only after the selected albedo attaches; an incoming unrelated
base texture cannot establish that reference. Omitted Unreal defaults remain
unresolved. Unknown color
interpretation, ambiguous source paths or exported PNG basenames, nonidentity AO
multipliers and unproved UV transforms withhold AO, including earlier filename
guesses. Texture metadata is
read lazily for the selected AO candidate; unrelated large images are untouched
by the material reader. Other package profiles keep prior reconstruction with a
named source-reader limitation. Cached conversions are invalidated.

The Buffer reader is independently implemented from the tagged package, property
and native-input schemas at [CUE4Parse commit b4e9544](https://github.com/FabianFG/CUE4Parse/tree/b4e95441bcf0c975eb3adb68c0fb44c740c2cf62/CUE4Parse/UE4).
Native expression inputs require verified Core=2 and Framework=33 custom versions;
tagged instances without native inputs do not require these versions. Native
trailers and omitted class defaults are outside its scope. This subset does not
certify original Unreal appearance.

Automatic uncooked conversion needs Python 3 with `venv` and `pip`. A Linux
source build fallback for UE Viewer additionally needs `git`, `g++`, `perl`,
zlib, and SDL2 development headers. Unreal import currently runs on Linux and
Windows; use the path overrides below for preinstalled executables.

Load a reconstructed level with the normal Three.js loader — no Unreal runtime
or custom `.uasset` loader is involved:

```js
new GLTFLoader().load("assets/fab/<listing>/Scenes/DemoMap.glb", ({ scene }) => {
  threeScene.add(scene);
});
```

Standalone materials use that same loader. Find a swatch by the report's
`materialAssets[].libraryName`, then assign its standard Three.js material:

```js
new GLTFLoader().load("assets/fab/<listing>/Materials/UnrealMaterialLibrary.glb", ({ scene }) => {
  const swatch = scene.getObjectByName(materialAsset.libraryName);
  targetMesh.material = swatch.material;
});
```

Sound waves use Three.js directly as well:

```js
const buffer = await new THREE.AudioLoader().loadAsync(audioAsset.file);
sound.setBuffer(buffer);
```

Structured data is ordinary runtime JSON — no Unreal object loader is needed:

```js
const table = await fetch(dataAsset.json).then((response) => response.json());
const defaultAmmo = table.Rows.Default;
```

Fonts can back Three.js canvas textures or text libraries that accept web fonts:

```js
const face = new FontFace(font.family, `url(${font.file})`, {
  style: font.fontStyle,
  weight: String(font.weight),
});
await face.load();
document.fonts.add(face);
// Draw with this family on a canvas, then pass the canvas to THREE.CanvasTexture.
```

Paper2D flipbooks reference ordinary GLBs. Select a frame using the manifest's
`frameRun` and `framesPerSecond`, then show its loaded scene:

```js
const flipbook = await fetch(report.flipbooks[0].manifest).then((response) => response.json());
const frames = await Promise.all(flipbook.frames.map((frame) => loader.loadAsync(frame.glb)));
const tick = Math.floor(elapsedSeconds * flipbook.framesPerSecond) % flipbook.frameCount;
let end = 0;
frames.forEach(({ scene }, index) => {
  end += flipbook.frames[index].frameRun;
  scene.visible = tick < end && tick >= end - flipbook.frames[index].frameRun;
});
```

Cubemaps use the standard Three.js equirectangular environment path:

```js
const loader = cubemapAsset.dynamicRange === "hdr" ? new RGBELoader() : new THREE.TextureLoader();
const environment = await loader.loadAsync(cubemapAsset.file);
environment.mapping = THREE.EquirectangularReflectionMapping;
threeScene.environment = environment;
```

Multidimensional textures use the report's explicit Three.js type:

```js
const metadata = await fetch(textureStack.manifest).then((response) => response.json());
const bytes = new Uint8Array(await fetch(textureStack.data).then((response) => response.arrayBuffer()));
const texture = metadata.threeTexture === "Data3DTexture"
  ? new THREE.Data3DTexture(bytes, metadata.width, metadata.height, metadata.depth)
  : new THREE.DataArrayTexture(bytes, metadata.width, metadata.height, metadata.depth);
texture.format = THREE.RGBAFormat;
texture.type = THREE.UnsignedByteType;
texture.needsUpdate = true;
```

Installation-only Unreal `BasicShapes/Plane` references are generated locally
when the asset pack does not contain that mesh. Rectangular area lights are
preserved in scene metadata and approximated as punctual point lights because
glTF's standard punctual-light extension has no area-light type.

### Parity sweep and material metadata dumps

`npm run parity:fab` imports every owned Fab artifact and scores it against its source package
(`scorecard.json`). `--export-metadata <dir>` also writes one replayable material dump per pack;
replay them with `FAB_METADATA_DIR=<dir> npx vitest run tests/fab-metadata.test.ts`. Dumps hold
licensed pack names and are local-only: never commit them.

## Configuration

| Variable                        | Default                                            | Purpose                                                  |
| ------------------------------- | -------------------------------------------------- | -------------------------------------------------------- |
| `FAB_DIRECT_TIMEOUT_MS`         | `20000`                                            | Direct JSON request timeout.                             |
| `FAB_BROWSER_TIMEOUT_MS`        | `30000`                                            | Dedicated browser request timeout.                       |
| `FAB_BROWSER_MANUAL_TIMEOUT_MS` | `10000`                                            | Headed-mode grace period for visible verification.       |
| `FAB_BROWSER_HEADLESS`          | `true`                                             | Set to `0` temporarily for manual verification.          |
| `FAB_BROWSER_PROFILE_DIR`       | OS state directory under `threenative-asset-mcp/fab-browser-profile` | MCP-owned Fab browser state.                    |
| `FAB_DOWNLOAD_DIR`              | `~/Downloads/threenative-asset-mcp/fab`            | Dedicated directory for Fab free-file downloads.         |
| `FAB_MAX_DOWNLOAD_BYTES`        | `2147483648`                                       | Maximum accepted download size in bytes.                 |
| `FAB_DOWNLOAD_TIMEOUT_MS`       | `600000`                                           | Total timeout for one file download.                     |
| `FAB_CURL_IMPERSONATE`          | auto-detected on `PATH`                            | curl-impersonate wrapper override; `0`/`off` disables.   |
| `FAB_MIN_REQUEST_INTERVAL_MS`   | `1000`                                             | Minimum spacing between direct upstream requests.        |
| `FAB_LOG_LEVEL`                 | `warn`                                             | `debug`, `info`, `warn`, or `error`.                     |
| `FAB_LOG_QUERIES`               | `false`                                            | Set to `1` only if query text may be written to logs.    |
| `SKETCHFAB_API_TOKEN`           | unset                                              | User token for temporary Sketchfab download URLs.        |
| `AUDIO_DOWNLOAD_DIR`            | `~/Downloads/threenative-asset-mcp/audio`          | Dedicated directory for curated audio downloads.         |
| `AUDIO_MAX_DOWNLOAD_BYTES`      | `10737418240`                                      | Maximum accepted bytes per audio archive (10 GiB).       |
| `AUDIO_DOWNLOAD_TIMEOUT_MS`     | `1800000`                                          | Total timeout for one audio download (30 minutes).       |
| `ELEVENLABS_API_KEY`            | unset                                              | **Your own** key; required only by `audio_generate_sound`. Never bundled or logged. |
| `AUDIO_INSPECT_ROOTS`           | the audio dir plus the launch directory            | Extra `:`-separated roots `audio_inspect_asset` may read. |
| `AUDIO_CLAP_PYTHON`             | unset                                              | Interpreter with LAION-CLAP installed; enables `semantic: "clap"`. |
| `AUDIO_CLAP_CHECKPOINT`         | unset                                              | Path to the `630k-audioset-best.pt` checkpoint.          |
| `AUDIO_CLAP_CHECKPOINT_SHA256`  | unset                                              | Optional pin; a mismatched checkpoint is refused.        |
| `ASSET_DOWNLOAD_DIR`            | `~/Downloads/threenative-asset-mcp/assets`         | Dedicated directory for direct provider downloads.       |
| `ASSET_MAX_DOWNLOAD_BYTES`      | `10737418240`                                      | Maximum bytes per direct file or complete generic acquisition (10 GiB).       |
| `ASSET_DOWNLOAD_TIMEOUT_MS`     | `1800000`                                          | Total timeout for one provider download (30 minutes).    |
| `ASSET_ENABLE_KENNEY`           | `1`                                                | Bounded official Kenney 3D-pack discovery; `0` disables it. Other values fail initialization. |
| `ASSET_SEARCH_CONCURRENCY`      | `4`                                                | Concurrent provider operations per search; range 1–4. |
| `ASSET_PROVIDER_TIMEOUT_MS`     | `8000`                                             | Provider deadline; range 1–30000 milliseconds. |
| `ASSET_SEARCH_TIMEOUT_MS`       | `10000`                                            | Aggregate search/metadata deadline including queue time; range 1–60000. |
| `ASSET_PLAN_TTL_MS`             | `300000`                                           | Acquisition-plan TTL; range 1–900000; at most 100 bounded plans. |
| `THREENATIVE_TOOLCHAIN_AUTOINSTALL` | `1`                                            | Set to `0` to disable first-use external-tool installs.  |
| `THREENATIVE_TOOLCHAIN_DIR`     | OS cache under `threenative-asset-mcp/toolchain`   | UE Viewer, FabCLI, and uncooked-converter cache.          |
| `THREENATIVE_UMODEL_PATH`       | auto-detected/provisioned                           | Absolute path to a UE Viewer executable override.        |
| `THREENATIVE_UNCOOKED_CONVERTER_PATH` | auto-detected/provisioned                     | Absolute path to `unreal-assets-to-glb`.                  |
| `THREENATIVE_FABCLI_PATH`       | auto-detected/provisioned                           | Absolute path to FabCLI; login remains user-controlled.  |

Direct requests are spaced at least `FAB_MIN_REQUEST_INTERVAL_MS` apart. Only
HTTP 429, 502, 503, and 504 are retried, at most twice, with backoff and
`Retry-After` support. Challenges, access denial, invalid input, missing
listings, and schema drift are never retried by the transport; a
curl-impersonate challenge response is additionally retried inside the
impersonation wrapper with longer, jittered waits before the browser fallback
is engaged.

## Browser-fingerprint TLS (curl-impersonate)

Fab's `/i/*` JSON routes sit behind Cloudflare bot management that challenges
Node's default TLS fingerprint — including plain `fetch` from this MCP and
headless Chromium — while real browser fingerprints pass. When a
[curl-impersonate](https://github.com/lwthiker/curl-impersonate) wrapper (for
example `curl_chrome146`) is available on the host `PATH`, the server performs
all anonymous JSON reads through it and no browser is needed for search,
detail, or download resolution. Set `FAB_CURL_IMPERSONATE=0` to force the old
behavior (plain Node fetch plus the Playwright fallback), or point it at a
specific wrapper binary.

Downloads of free files resolve entirely through the anonymous JSON contract
when possible: listing detail → `asset-formats/{format}` file listing →
`download-info` signed URL → guarded file write. The signed distribution URL
is validated against an exact Epic distribution-host allowlist before use.
Only when the direct path is challenged does the server fall back to the
guarded browser click flow below.

Process-local cache TTLs are five minutes for search, fifteen minutes for
listing details, six hours for taxonomy data, and ten minutes for promotions.
The shared LRU is capped at 500 entries and is cleared on process exit.

## Poly Haven API behavior

Poly Haven requests go only to `https://api.polyhaven.com`, with the required
`threenative-asset-mcp` User-Agent. Asset lists are cached for 15 minutes and
details, categories, and file trees are cached for up to one hour. Returned file
URLs are accepted only from `https://dl.polyhaven.org`.

The live API is free for personal and commercial use, but use of the API
requires a visible Poly Haven credit. The assets themselves are CC0. This MCP
includes `provider`, `license`, and `attribution` fields so downstream clients
can preserve that distinction. See the
[official API page](https://polyhaven.com/our-api) and
[API documentation](https://api.polyhaven.com/).

## Other provider behavior

ambientCG uses its anonymous, read-only v3 API. Its files are CC0 and its API
exposes searchable metadata, categories, and downloadable variants.

Smithsonian uses the anonymous Smithsonian 3D file-search API. Files exposed by
that API are part of Smithsonian Open Access; the MCP retains direct source
URLs and format/quality metadata.

Sketchfab public search, categories, and model detail do not require a token.
The download endpoint requires a token belonging to the user, configured
through `SKETCHFAB_API_TOKEN`. The token is sent only in the Sketchfab
`Authorization` header, is never logged or persisted, and is not included in
MCP responses. Sketchfab models use different Creative Commons licenses; always
inspect `license.requirements` before use.

Audio direct downloads are catalog-ID based; the MCP does not accept arbitrary
URLs. Official Kenney downloads are restricted to `kenney.nl` and Sonniss GDC
downloads to `downloads.sonniss.com`, including redirect revalidation. Sources
without a stable, verified direct contract remain discoverable as
`provider-page` instead of being falsely presented as one-click downloads.

The generic direct downloader is intentionally narrower than an arbitrary URL
fetcher. It accepts only official Poly Haven, ambientCG, Smithsonian,
Game-icons.net, and curated Kenney URL contracts. The itch.io downloader uses
fresh signed mirror URLs internally but never exposes them. Sketchfab signed
downloads are exposed through `sketchfab_get_downloads` but are not persisted
by the generic downloader because their temporary CDN hosts vary and require
the user's token-backed session. Provider-page-only sources stay provider-page-only until a stable,
license-safe download contract is verified.

## Dedicated browser profile and privacy

When a direct anonymous request receives a Cloudflare challenge, the server may
open Playwright Chromium with a dedicated MCP-owned profile. It never attaches
to, copies, or reads the user's normal Chrome/Edge/Chromium profile, cookie
database, local storage, passwords, or Epic session.

If the tool returns `FAB_BROWSER_ATTENTION_REQUIRED`, run the same MCP command
once with `FAB_BROWSER_HEADLESS=0`. The MCP opens its dedicated Fab homepage at
startup, so complete any visible verification before calling the tool. A tool
call allows an additional `FAB_BROWSER_MANUAL_TIMEOUT_MS` grace period, then
returns `FAB_BROWSER_ATTENTION_REQUIRED` rather than exceeding typical MCP
client timeouts. Close the MCP process after verification and return to headless
mode. The server does not solve or bypass challenges.

Browser process startup is capped at ten seconds. On a host without a working
graphical session, headed mode returns `FAB_UPSTREAM_UNAVAILABLE` instead of
hanging an MCP call; run the manual release gate on a graphical host.

To clear browser-owned Fab state, stop every `threenative-asset-mcp` process and
move only the dedicated directory reported by your configuration out of
service. The default on Linux can be cleared recoverably with:

```bash
mv -- "${XDG_STATE_HOME:-$HOME/.local/state}/threenative-asset-mcp/fab-browser-profile" \
  "${XDG_STATE_HOME:-$HOME/.local/state}/threenative-asset-mcp/fab-browser-profile.cleared"
```

Do not point `FAB_BROWSER_PROFILE_DIR` at a normal browser profile. The server
rejects known normal-profile locations.

The MCP has no analytics or remote telemetry. Application logs are structured
JSON written only to stderr; stdout is reserved for MCP JSON-RPC. Search query
text is omitted from logs unless `FAB_LOG_QUERIES=1`. Raw upstream bodies,
headers, cookies, tokens, stack traces, and browser profile paths are not logged
or returned to the model.

## Troubleshooting

`FAB_CHALLENGE` or `FAB_BROWSER_ATTENTION_REQUIRED`
: Fab asked for browser verification. First check whether a curl-impersonate
wrapper is installed (`FAB_LOG_LEVEL=info` logs `fab_impersonate_enabled`
when active). Otherwise use the headed dedicated-profile step above. If
verification continues to fail, stop; do not copy a signed-in browser
session.

`FAB_RATE_LIMITED`
: Wait for `retryAfterSeconds` when present. The MCP already applied its bounded
retries.

`FAB_UPSTREAM_CHANGED`
: Fab's undocumented response changed. Re-run the sanitized contract probe and
update normalization and fixtures before continuing.

`FAB_UPSTREAM_UNAVAILABLE`
: Fab is unavailable, or a currently unverified discovery contract was
  intentionally disabled.

The MCP host shows no tools
: Build first, confirm the configured path is absolute, and run
`npm run inspect`. Logs belong on stderr; any non-JSON stdout is a bug.

## Verification

GitHub-hosted CI checks pull requests, pushes to main and manual runs on the
minimum supported Node 20.19 and Node 24. It installs the committed npm lockfile,
runs typecheck/build, deterministic fixtures and actual built/npm-packed stdio
consumers. Reports distinguish intentionally conditional proprietary Unreal
fixtures. No provider live probes, credentials, package publishing or account
changes run in that workflow. Local CI-equivalent commands are:

```bash
npm ci
npm run build
npm run typecheck
npm run test:ci
npm run test:smoke
```

The suite needs Chromium (`npx playwright install --with-deps chromium`),
ffmpeg and Python with NumPy/Pillow for local render/audio fixtures. Live probes
remain separate from deterministic acceptance tests.

Run `npm run doctor` to see which of these your host has. Each missing tool is
listed with its install command. Locally, a suite whose tool is missing is
skipped with that command as the reason. With `CI=true` it fails instead.
Add `--toolchain` to also require what the Unreal importers need on a fresh
Linux host, or `--toolchain-only` to check only that group.


```bash
npm ci
npm run browser:install
npm run typecheck
npm test
npm run build
npm pack --dry-run
npm run inspect
npm run test:providers:live
```

Live checks are opt-in because they contact Fab:

```bash
npm run test:live
```

This runs the real anonymous search, cursor, detail, and dedicated-browser
contract probe. It exits nonzero when Fab challenges the clean browser or the
required contract cannot be verified. Live verification must remain anonymous,
concurrency-one, capped and paced. It must never acquire, purchase, wishlist,
download, or automatically solve a challenge.

`npm run test:providers:live` launches the compiled stdio MCP and exercises live
search, detail, categories, and file discovery for ambientCG, Smithsonian 3D,
and Sketchfab. If `SKETCHFAB_API_TOKEN` is configured it also verifies the
authenticated download endpoint; otherwise it verifies the explicit
authentication-required response.
