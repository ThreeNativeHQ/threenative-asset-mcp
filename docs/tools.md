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
