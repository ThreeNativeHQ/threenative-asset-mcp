# Epic: Unity Asset Store import

**Status:** IN PROGRESS (2026-10-15). PRD-615..619 are built and tested on synthetic packages (PRs #56-#60). The corpus
`U1`-`U3` was imported and swept on 2026-10-15 (importer 7; sheets stay local). Open: the PR comments (no PR yet),
`R1` renders (need a Unity licence), and the three-pipeline `U2` check (the `U2` file holds Built-in only). PRD-620 is blocked
on an owner decision.
**Owner:** João

Import a buyer's own Unity Asset Store packages into GLB, as `fab_import_asset` does for Unreal packs.
The research for this epic was done on 2026-10-14. Its findings and the routes it rejects follow.

| Step | PRD | Scope | Priority |
|---|---|---|---|
| 001 | PRD-615 | Package intake: cache discovery, `.unitypackage`/UPM extraction, Unity YAML and GUID database | P2 |
| 002 | PRD-616 | Models, textures and materials to GLB (`asset_import_unity`) | P2 |
| 003 | PRD-617 | Fidelity measurement against package previews, visual locks, format ledger | P2 |
| 004 | PRD-618 | Prefabs to GLB scenes (hierarchy, nested prefabs, variants, material slots) | P2 |
| 005 | PRD-619 | Unity-format Fab listings through FabCLI (the automated route) | P2 |
| 006 | PRD-620 | REA reference study of Unity import semantics (private notes) | P3 |

Order: 001 → 002 → 003 → 004. Step 005 needs only 002. Step 006 is independent and gated on an owner decision.

## How acquisition differs from Fab

Fab has an official CLI (FabCLI) that lists and downloads a signed-in buyer's library. The Unity Asset Store has
none. A Unity staff member confirmed in 2020 that there is no download API, and nothing official followed.
The experimental `unity` CLI (`assets inspect|export|import`) works on local `.unitypackage` files only.

The Asset Store Terms forbid the routes that would copy the Fab design
([terms, updated 2024-12-04](https://unity.com/legal/as-terms)):

- **§3.3** forbids access "through any automated means (including use of scripts, crawlers or similar technologies)".
- **§3.8(ii)** forbids circumventing "digital rights management or forward-lock functionality".

So this epic **never** signs in to Unity, calls Asset Store or Hub endpoints, reads Hub tokens, or decrypts a
download. The buyer downloads in their own Unity Editor (Package Manager → My Assets). The Editor caches each
`.unitypackage` at a documented path, and we import from there:

| OS | Cache path ([docs](https://docs.unity.com/en-us/asset-store/downloads/asset-store-packages.md)) |
|---|---|
| Linux | `~/.local/share/unity3d/Asset Store-5.x/<publisher>/<category>/<name>.unitypackage` |
| macOS | `~/Library/Unity/Asset Store-5.x/...` |
| Windows | `%APPDATA%\Unity\Asset Store-5.x\...` |

`ASSETSTORE_CACHE_PATH` overrides the location. UPM-format Store packages are not stored there: the tool accepts their
tarball by path.

**The automated route is Fab.** Many Fab listings ship a Unity-format artifact. FabCLI already lists them, and
`src/fab/fabcli.ts:115` already parses Unity entries. PRD-619 sends those artifacts to this importer. That gives
an end-to-end, unattended path for the part of the catalog that is on Fab.

## License

- Unity Support states that Asset Store assets may be used with other engines if the EULA is followed
  ([article, 2025-07-02](https://support.unity.com/hc/en-us/articles/34387186019988-Can-I-use-assets-from-the-Asset-Store-with-other-engines)).
  The EULA grant (§2.2.1) has no Unity-only clause.
- The license is per buyer, and it forbids standalone redistribution and raw extraction by end users.
  The import runs locally for the buyer, and outputs are private. Nothing is hosted, published or committed.
- Restricted Assets (§2.2.2) carry their own terms, and those terms override the EULA. The tool cannot query
  them, because §3.3 forbids automated access to listing pages. It therefore requires an explicit acknowledgement
  (`acceptUnityAssetStoreEula: true`) and reports any `LICENSE`/`Third-Party Notices` file it finds in the package.
- Converting to another format is not addressed by the EULA text. **Blocked on:** João, a legal review before
  a public release. Development and private use can continue.

## Absorb, wrap or write

| Candidate | License | Decision |
|---|---|---|
| [V-Sekai/unidot_importer](https://github.com/V-Sekai/unidot_importer) (Godot, GDScript) | MIT | **Port logic** with attribution: GUID database, prefab and variant resolution, `.meta` handling. It is the only complete Editor-free pipeline. It runs inside the Godot editor, so we cannot depend on it. It covers the Standard shader only. |
| [KhronosGroup/UnityGLTF](https://github.com/KhronosGroup/UnityGLTF) `ExporterMaterials.cs` | MIT | **Port logic**: Standard, Specular setup, URP Lit and SimpleLit to glTF PBR (`_BaseMap`/`_MainTex`, roughness = 1 − smoothness, `_GlossMapScale`, smoothness source). |
| Blender, headless (glTF-Blender-IO, Apache-2.0) | GPL (separate process) | **Provision as a tool** for FBX, `.blend` and `.obj` to glTF. Blendkit already runs headless Blender (`src/tools/blendkit.ts`). The license boundary is the process boundary. |
| [ufbx](https://github.com/ufbx/ufbx) | MIT / public domain | Later option: a small WASM build to drop the Blender dependency for FBX. Not in this epic. |
| `sharp` (already a dependency); ImageMagick | Apache-2.0 | Textures. Check PSD and TGA input support in PRD-616 before adding `ag-psd` (MIT). |
| `yaml` npm package | ISC | New dependency for Unity YAML document bodies. The `--- !u!<classId> &<fileID>` headers are split by our own code. |
| [Cobertos/unitypackage_extractor](https://github.com/Cobertos/unitypackage_extractor), `unityparser` | MIT | Reference only. The format is small enough that a wrapper costs more than it saves. |
| [AssetRipper](https://github.com/AssetRipper/AssetRipper) | GPL-3.0 | **Reject.** It targets built games, and GPL code cannot be vendored. |
| UnityPy | MIT | **Reject.** It reads binary bundles, not source YAML. |
| FBX2glTF | BSD-3 | **Reject.** Abandoned (2019), and the prebuilt binaries bundle the proprietary Autodesk SDK. |
| `UnityCsReference`, `Unity-Technologies/Graphics` | Reference-only / Unity Companion License | **Read, never copy.** Shader GUIDs and property names are facts we may record. |
| Headless Unity Editor + UnityGLTF export | Unity license | **Reject as the product route.** A Personal license has no command-line activation, and every user would need the Editor. Kept as a possible manual gold standard only. |
| `pg7go/UnityAssetstoreDownloader`, Hub token reuse | — | **Reject.** Stale, and it breaches §3.3 and §3.8(ii). |

## REA

[REA](https://github.com/morluto/rea) (MIT, `rea-agents`) reverse engineers native binaries, Electron apps and
.NET assemblies. We used it for the Unreal importers (private `unreal-rea-docs`, 2026-10-09). For Unity it can
document the binary-only import semantics: the native FBX importer (unit scale, axis conversion, normals,
material naming) and the TextureImporter conversions. PRD-620 holds that study. Two limits:

- REA never analyzes the Asset Store download, decryption or Hub sign-in code (§3.8(ii)).
- The Unity Editor's own license may forbid reverse engineering. PRD-620 stays blocked until João decides.

## Shared rules

- Follow the Unreal fidelity workflow in `src/unreal/CLAUDE.md`: measure, fix red to green, lock with a visual
  fixture and a baseline. The visual judge, contact sheets, `fidelity-baseline.ts` and the toolchain helpers are
  generic despite living under `src/unreal/`. Import them; move a module only when a second consumer needs it.
- `docs/unity-format-support.md` (created by PRD-615) is the Unity format ledger. It uses the same rules as
  `docs/unreal-format-support.md`.
- Test fixtures are synthetic packages built by the tests. Licensed packages, their names, previews and
  metadata dumps never enter the repository.
- Every PR follows the evidence rule below.

## Verification corpus

Three listings that João owns on Fab offer a Unity `.unitypackage` (probe, 2026-10-14: `fabcli formats <uid>`).
Together they cover the three render pipelines. They are the epic's real-pack corpus:

| Id | Fab listing (UID) | Asset Store | Pipelines (listing tech details) | Exercises |
|---|---|---|---|---|
| `U1` | Apocalypse: Playground Environment (`fbc35597-dbcf-4da8-bb29-4fdbf203c46e`) | [352674](https://assetstore.unity.com/packages/3d/environments/urban/apocalypse-playground-environment-352674) | Built-in | Standard shader baseline: 31 meshes, 141 textures (512–4096 px), 1 master material with 31 instances, 2 scenes |
| `U2` | Old Abandoned Rusty Cars – Overgrown (`ed740921-9f30-4444-8c8e-c55db80c7304`) | [364602](https://assetstore.unity.com/packages/3d/vehicles/land/abandoned-rusty-vehicles-and-props-3d-game-ready-mini-set-364602) | HDRP, URP, Built-in | The same pieces in three pipelines (HDRP mask maps against URP Lit and Standard); 17 prefabs, about 1.1 M triangles, no LODs |
| `U3` | KUBIKOS - Cube World (`7bbf72cf-03bd-458f-9a74-1ab85bd1f2e5`) | [117341](https://assetstore.unity.com/packages/3d/environments/kubikos-3d-cube-world-117341) | URP, Built-in, custom | Scale and fallbacks: 458 prefabs by the listing (the file holds 1006 prefab documents), custom lava, water, magma, ice and fog shaders (expected `fallback`), minimum Unity 5 (old `.meta` layout) |

**Probe result (2026-10-14).** The automated Fab route cannot download these packs today. `fabcli library` and
`fabcli listing` expose only the Unreal project version, so the Unity file has no Epic catalog coordinates. The Fab
web path is behind a Cloudflare challenge and needs a signed-in Fab session (`fabcli ownership` answers
`auth_required`). **Blocked on:** João runs `fabcli auth login`, or downloads the three `.unitypackage` files into
`~/.cache/threenative-asset-mcp/unity-corpus/<id>/`. Real `R1` renders also need a Unity Personal licence (PRD-617).

Rules:

- **How the packs are acquired.** The first choice is the automated Fab route (PRD-619). If that route cannot
  download them, João downloads the three files from fab.com into
  `~/.cache/threenative-asset-mcp/unity-corpus/<id>/`. The importer reads either location the same way.
- **What stays out of the repository.** Pack contents, previews, sheets and per-asset names never enter `main`,
  tests or fixtures. `docs/parity/unity-corpus.json` records only id, listing UID, file size, SHA-256, pipelines
  and counts per kind, as `docs/parity/feature-corpus.json` does for Unreal. `fidelity-baseline.json` holds numbers only.
- **Slices.** Each PR names the corpus slice it renders: a fixed list of prefab or model paths per pack, kept
  in the local corpus directory, and chosen to exercise the PR's rules. The PR comment lists the slice by count
  and by the feature each piece covers, not by asset name.
- **Gaps.** No corpus pack has a rigged or animated character, UPM layout, Shader Graph material made in the Shader
  Graph editor, or LODs. Record each gap in the ledger. Add a pack when a PRD needs one.

### Reference images, strongest first

1. **`R1`: Unity Editor reference render.** The agent runs a small Editor script (written in PRD-617) once per pack, in batch mode, after João activates a Unity Personal licence once.
   It renders every prefab with a fixed camera, light and background, and writes the PNGs plus each prefab's
   world bounds as JSON. This is the only reference that shows Unity's real shading at full size and gives real
   sizes. It stays local, beside the pack.
2. **`R2`: package previews.** `<guid>/preview.png` inside the `.unitypackage`. These are small Editor thumbnails
   with Unity's preview lighting. Use them when `R1` is absent. They catch wrong colours, missing textures and
   wrong silhouettes, but not fine shading.
3. Fab and Asset Store listing images are marketing renders. **Never** use them as a reference.

## PR evidence rule

Same contract as `done/unreal-feature-coverage/README.md`, adapted to Unity. Numbers alone do not count.

1. **Before and after.** *Before* is the importer at the PR's base commit. *After* is the PR head. Both run on the
   same corpus slice with the same camera, framing and picture contract (`AGENTS.md`, "Comparison preview
   contract"). Never tune lighting or exposure per asset. For PRD-616, the first importer PR, there is no *before*
   import: that column shows the reference image (`R1` or `R2`) with "no importer" as its verdict.
2. **Columns.** Each sheet row is one piece: reference (`R1`, else `R2`) | before | after. The judge verdict and the
   fidelity score (hue, saturation, silhouette fill, overall 0..100) are printed under each render column.
3. **Tools.** Render with the production tile renderer (`renderTiles`, `src/unreal/contact-sheet.ts`). Score with
   `judgeRender` (`src/unreal/visual-judge.ts:107`) and with `scripts/fidelity-sheet.ts` against the reference.
   Under 70 is suspect, and under 50 fails. Also print the structural numbers per pack: prefabs in vs GLBs out,
   bound material slots, resolved textures, and `fallback` materials with their reason.
4. **Look at every sheet by eye** before posting. If the numbers and your eyes disagree, the PR is not ready. Fix
   the judge or the import, and say which in the PR.
5. **Publish** the sheets as a fast-forward commit to the PR's `<branch>-assets` orphan branch, never with a force
   push. Post one PR comment that embeds them through immutable commit-SHA blob URLs. The comment states the base
   and head commits, `UNITY_IMPORTER_VERSION`, the reference kind (`R1`/`R2`) per pack and the slice.
6. **Baseline.** Run `npx tsx scripts/fidelity-baseline.ts check` on the sweep before merging, so a fix for one pack
   cannot silently lower another. Ratchet with `update` only after the sheets are inspected.
7. **Nothing visible changed.** Post the identical before/after sheet with the judge reporting no change.
8. **Licensed content** stays on the assets branch. It never goes into `main`, tests or fixtures.

## Out of scope

- Shader Graph evaluation (`.shadergraph` JSON). There is no parser or published schema. Materials that use a
  custom graph fall back to their saved property values and are reported. Revisit after PRD-617 measures how
  often it matters.
- Scenes (`.unity`), animation controllers, VFX Graph, terrain and audio. Add ledger rows when packs show them.
- `.max`, `.ma` and `.mb` sources. They need the DCC application, so they are reported as unsupported.
