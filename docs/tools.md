# MCP tools

[← Back to the README](../README.md)

Every tool the server exposes, grouped by provider. All discovery tools are read-only. Audio tools are in [audio.md](audio.md).

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
  Cascade `ParticleSystem` and Niagara systems are exported as data-only
  descriptors under `Effects/<system>-<hash>.<cascade|niagara>.json`, one per
  canonical package and object path so two same-basename systems in different
  folders stay distinct. No runtime plays them: each descriptor lists the
  modules and inputs it does not carry, and a placed effect component points at
  its descriptor through `import-report.json`. Effects with no exported
  descriptor stay named in the report; the importer never reconstructs a
  particle simulation.
- `fab_import_asset` — downloads an owned listing through the user's existing
  FabCLI session, then runs the same Unreal importer. It never signs in, claims,
  or purchases an asset. For a Unity-format artifact (`format: "unity"`, or a
  listing that publishes only Unity) it hands the `.unitypackage` to the Unity
  importer, but only when FabCLI reports that artifact's catalog ids. Otherwise
  it fails with `FABCLI_UNITY_DOWNLOAD_UNAVAILABLE` and points to
  `asset_import_unity` on a hand-downloaded package. See
  [docs/fab-contract.md](fab-contract.md).

Unity (the user's own Unity Editor cache; see
[docs/unity-format-support.md](unity-format-support.md)):

- `unity_list_packages` — lists the `.unitypackage` files the Unity Editor cached
  under `ASSETSTORE_CACHE_PATH`, or the OS default
  (`~/.local/share/unity3d/Asset Store-5.x` on Linux), with publisher, category,
  name, size and modification time. It reads local files only and never contacts
  or signs in to Unity. An empty or missing cache returns an empty list. The
  intake that opens a package (`.unitypackage`, UPM tarball or project folder)
  lives in `src/unity/package.ts`; `asset_import_unity` is its consumer.
- `asset_import_unity` — converts the FBX, OBJ and `.blend` models, textures and
  materials of a Unity package the user owns into self-contained GLBs plus
  `import-report.json`. It needs `acceptUnityAssetStoreEula: true`, applies each
  model's import scale, binds material slots (`externalObjects`, then by name) and
  maps Standard, URP Lit/SimpleLit/ComplexLit and HDRP Lit to glTF PBR. Other
  shaders fall back to their saved colour and texture and are reported. It also
  turns each prefab (nested prefabs and variants included) into one scene GLB under
  `prefabs/` and lists colliders, LOD levels and unresolved references. It runs
  headless Blender (`THREENATIVE_BLENDER`, `PATH`, or a pinned download) and never
  contacts Unity. Details: [unity-import.md](unity-import.md).

Blendkit (through the user's own official Blendkit-Client; see
[docs/blendkit-integration.md](blendkit-integration.md)):

- `blendkit_status` — local-only health: whether the Client runs on loopback,
  its version and `export_glb` recipe, whether live access is enabled, and the
  setup steps still missing. It never contacts Blendkit.
- `blendkit_import_asset` — acquires one free Blendkit model through the Client,
  converts it with the Client's bundled `export_glb` recipe under headless
  Blender, inspects the GLB (meshes, triangles, PBR texture slots, size) and
  writes a provenance file. It needs the item's license acknowledgement and
  explicit project-use consent, and it refuses paid items and unknown licenses.
  The output is private use only: the Blendkit Terms forbid open-format models
  such as GLB in software and apply that to CC0-labelled items too. It never
  goes into game builds, demos or starter kits, and `purpose: "redistribution"`
  is always refused. Existing outputs are never overwritten. Live search and
  import stay off until `BLENDKIT_PROVIDER_PERMISSION` is set. With it,
  `asset_search` also searches Blendkit.
  Live provider downloads remain **UNVERIFIED**; local Client verification
  does not establish a successful live download.

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

Polyfork (free low-poly models; <https://polyfork.dev/characters>):

- `polyfork_search_models` — searches the catalogue by text and class
  (`character`, `prop`, `animal`, `vehicle`, `building`, `ultra`,
  `attachment`, `terrain`, `hand`), with kit, triangle bounds, free-only,
  sort and a 1-based page cursor. Items carry triangles, rig/skeleton flags
  and the HD-edition marker.
- `polyfork_get_model` — returns one model's canonical page, its per-item
  licence text and CC BY credit line, the clips and skeleton its GLB actually
  carries, the anonymous full-GLB and preview choices, the Pro HD edition, and
  non-GLB export links (manual, account/Pro routes). The `.mjs` source is never
  fetched or executed.
- `polyfork_list_files` — lists the verified anonymous full low-poly GLB (the
  preferred file), the preview-only GLB, and the Pro-gated HD edition. When
  upstream gates a file it returns a structured requirement instead of a plan.

Licences: free low-poly **mesh files** are CC BY 4.0 (keep the asset's `credit`
line, link its model page and say what changed; redistribution and resale are
allowed) or the Polyfork licence (no attribution, no standalone file
redistribution) — the user chooses. The `.mjs` source modules, HD editions,
renders and thumbnails stay under the Polyfork licence only: no redistribution,
and neither they nor mesh files taken under the Polyfork licence may be used to
build or train a commercial 3D asset generator. CC BY 4.0 sets no such limit on
the free mesh files. HD editions need Pro. If your product lets users pick these
models, credit Polyfork there and fetch each model on use rather than the
catalogue in bulk.
See <https://polyfork.dev/licensing>.

Sketchfab:

- `sketchfab_search_models` — anonymously searches public models, defaulting to
  downloadable results, and preserves author, geometry, archive, and license
  metadata.
- `sketchfab_get_model` — returns public detail and explicit Creative Commons
  requirements.
- `sketchfab_list_categories` — lists public category names and slugs.
- `sketchfab_get_downloads` — uses `SKETCHFAB_API_TOKEN` to retrieve temporary
  download URLs. It never stores the token or returns it in tool output.

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

Mesh optimization:

- `mesh_optimize` — simplifies a heavy static GLB (a scan, an AI-generated prop) with meshoptimizer under a
  rendered before/after gate. It refuses a GLB with a skin or a morph target with
  `MESH_OPTIMIZE_UNSUPPORTED` and writes nothing. The ladder tries `error` 0.005, then 0.002, then 0.0005;
  the first candidate that keeps silhouette IoU >= 0.98 and mean grayscale difference <= 2% in all six views
  wins. A texture longer than `maxTextureSize` (default 2048) is downscaled in its own format. Output is
  always uncompressed and never overwrites the input; a passing run also writes `.before.png` and
  `.after.png`. When no candidate passes, the call succeeds with `kept: "original"`, no output file and the
  metrics of every attempt. `scripts/probe-mesh-optimize.ts` runs the real-scan path on Smithsonian GLBs.

Texture projection (gray blockout levels and environments):

- `texture_project_quote` — plans the camera views that would paint a gray blockout level or environment,
  reports planned views, model and price, the atlas the bake would choose, the level's UV stretch and how
  much of that atlas the views would leave blurred. The price is images only by default; an opt-in vision
  check adds its own line (`verifyModel`, `estimatedVerifyUsd`, 0 unless `verify: true`). No network call, no key.
- `texture_project_paint` — buys the views from an OpenRouter image model (FLUX 3 Klein by default) with the
  user's `OPENROUTER_API_KEY`, projects them into the level's UV atlas, and writes the baked GLB atomically
  under the project's `assets/`. Every prompt keeps the clay image's edges, openings and silhouette, names the
  camera's height and the depth of the middle of the frame so material detail is painted at its true real-world
  size, and forbids roofs, tiles or coping above a wall top. A view that shows ground is also told the ground is one
  uniform paving with no pattern, mosaic, motif, inlay, medallion or change of material (the courtyard's aerial views
  turned a blank floor plan into a decorative leaf mosaic), and a pass that looks down on the level — the aerial ring,
  the roof passes — may only paint texels no player-height view sees, so a wall top or an outer face is textured and
  the ground a player walks on never is (`aerialPassOnlyHidden`).
  Each painted view can be checked by a vision model (`verify: true`, off by default; `verifyModel`, default
  `google/gemini-2.5-flash`) that compares the clay with the painting and returns strict JSON: the structures it
  adds ("ruined stone pillar on the wall", "red roof-tile coping along the wall top") and whether the detail's
  real-world size is plausible. It is the reliable check — the cheap pixel check in front of it only catches
  compact dark shapes, while a real invention is often the same tone as the wall. A rejected view
  (`rejected: "verify"`) is repainted once with a new seed and the invented structures named as forbidden; a
  second rejection leaves its texels to the fill pass. An unreadable answer counts as a rejection
  (`verifyUnparsed`). `verify: true` turns the check on by name, for one chat request per view. A view whose
  surface is almost all grazing is rejected before its image is bought, and a view that invents dark geometry
  (a compact, closed, much darker shape inside one clay surface), paints solid surface over the clay's sky, or
  draws a long painted edge the clay has no edge for (a pillar shifted onto the flat wall behind it — the pixels
  would project as a ghost slab) is rejected as `structure`; the last one leaves its edge strip out of the
  projection instead of refusing the view when the strip is a small part of it (`edgeMisalignment` in run.json
  records the share, and `structure.ts` has the calibration). It fails closed and
  stops spending:
  `TEXTURE_PROJECT_STRUCTURE_REJECTED` once the first three painted views all invent geometry, and
  `TEXTURE_PROJECT_NO_COVERAGE` when nothing reaches the atlas. `resumeRunId` re-judges every stored generation
  with the current checks, projects the accepted ones and requests only views that have none, so a view is never
  paid for twice (and a resume that reuses stored images needs no key); `viewsPainted` counts what reached the
  atlas, bought or reused. The agent that calls this tool judges the views itself: `texture_project_inspect` returns
  the contact sheet, and any view that invents an arch, doorway, passage, opening, slab, coping or decorative floor
  is rejected with `{"resumeRunId": ..., "rejectViews": [..]}`. A rejected view is stored as `rejected: "caller"`,
  buys no image, is projected nowhere (the fill pass covers its texels from the images around them), and a later
  resume keeps the rejection. `promptTestView` buys exactly one image. A view pixel that would cover more than
  2x2 atlas texels is never projected (it would only blur the atlas): those texels wait for a closer view or the
  hole pass, and `magnificationSkippedPercent` reports how many. The strip along a view's own clay edges is left out of
  the projection for the same reason: both image models give a wall top a grey coping and an inner corner a lit face
  with a shadow, and the strip is 0.25 m along the wall where the sky or a farther surface is behind the edge
  (`edgeBandMask`; `edgeBandShare` in run.json records what it took). The atlas is then filled per UV island from that
  island's own painted texels (`inpaintUnpainted`), never across the atlas packing, so a gap continues the material
  around it and a masked strip continues the wall; the fill also tiles that island's own largest fully painted square
  (at least 32x32 texels, mirrored, mean subtracted) over the texels it fills, so a filled gap has grain instead of the
  smear a tone-only fill leaves, and an island with no such square borrows the patch of the one nearest it in colour.
  `fill: "debug"` paints never-painted texels hot pink (#FF69B4) instead, so a capture can count bake gaps with
  `scripts/count-debug-pink.ts`; use it for verification, never ship it.
  The atlas image is opaque RGB everywhere, filled texels included, so the cook gives it its UASTC encoding; "a view
  painted this texel" travels as its own file instead, `<name>.painted.png` beside the GLB: an 8-bit grayscale PNG at a
  quarter of the atlas' side (1024 for a 4096 atlas), 255 where an accepted view painted, 0 where the fill made the
  colour up, feathered over six texels inwards from the paint edge and copied out into the UV gutters. A game samples
  it as a linear data texture at the atlas' uv and swaps the atlas for the paint's own swatch exactly where no view
  painted; `extras.threenative.textureProjection.paintedMask` on the GLB names that file, and `paintedMask` in the
  result gives its path. The mask ships beside the atlas, never in its alpha: a lossy alpha on an `alphaMode: OPAQUE`
  material drops the atlas off UASTC, and a canvas premultiplies, so a filled texel's colour would not survive at
  alpha 0. The debug fill writes no mask, and neither does an older GLB (`paintedMask` reads back absent).
  `cookConfigHint` is the
  `threenative.config.ts` `assets.models.textures` snippet that keeps the atlas' size (at most 4096, the engine
  cook's KTX2 ceiling) and UASTC encoding; the engine cook of the release that ships PRD-916 honours the GLB's
  marker on its own. The bake also cuts two true-scale, tileable material swatches from its own stored paint
  (`swatch_wall.png`, `swatch_floor.png`, `swatches.json`): the atlas is the macro variation, and at arm's length
  its texels read as blotches, so a game tiles the swatch in world space for close-range detail. Where the paint
  repeats on a clear period (brick courses, setts, paving) the swatch is cut to whole periods with the wrap inside a
  mortar joint, so it tiles with no blend at all; an axis without a clear period is cross-faded over a narrow band
  instead. Either way `swatches.json` gives the cut swatch's own extent, `metresX` and `metresY` (`metres` repeats the
  width, and a cropped axis is shorter than the patch), beside its view, metres per pixel, incidence and world
  corners, so the tiling is true scale.
- `texture_project_inspect` — returns a contact sheet (clay render, model image and projected composite per
  view, rejected views labelled) with coverage, atlas size, measured blurred-texel share, rejected views by reason
  (the caller's own `rejected: "caller"` verdicts included), the opt-in vision check's verdicts when one ran
  (`verifyRejected`, `viewsRepainted`) and an audit of `threenative.config.ts`: a `maxSize` below the atlas or an
  ETC1S (or missing UASTC) base-colour codec would blur the bake. Read the sheet yourself: the agent that calls the
  tool is the judge; no vision model is called to do it. Only registered in `detailed` mode.
- `texture_project_match_materials` — matches named level surfaces and 3D prop/object queries against Poly Haven
  CC0 PBR textures and 3D models using one or more project-relative reference images (`referenceImagePath`,
  `referenceImagePaths`, or per-item `referenceImagePath` with optional `crop`), CIELAB chroma/contrast invariance,
  and multi-scale gradient energy, plus extracts `referenceHex` (`#rrggbb`) for neutral tinting or procedural
  fallback materials. Registered in both modes:
  - In `detailed` mode (default, `--mode detailed` or `THREENATIVE_TEXTURE_MODE=detailed`): routes surfaces to
    `use_polyhaven_pbr`, `polyhaven_detail_plus_project`, or `ai_project_only`, and prop queries to
    `use_polyhaven_model` or `ai_project_only`, setting `requiresOpenRouterKey: true` whenever any item still
    needs AI projection.
  - In `lean` mode (`--mode lean` or `THREENATIVE_TEXTURE_MODE=lean`): omits `texture_project_quote`,
    `texture_project_paint`, and `texture_project_inspect` from the MCP server completely, refuses explicit
    `mode: "detailed"` calls with `TEXTURE_PROJECT_MODE_RESTRICTED`, and routes every surface and prop to
    `use_polyhaven_pbr`, `use_polyhaven_model`, or `procedural_tint_fallback` (`requiresOpenRouterKey: false`).

`scripts/verify-calibration.ts` replays the vision check over a finished run's stored clay/painted pairs with the
production prompt (`--run <run dir> --out <dir> [--model <id>] [--views 0,1,2]`), so the prompt can be tuned
against real images before a paid run.

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
