# PRD-615 — Unity package intake: cache discovery, extraction and asset database

**Status:** IN PROGRESS — AC-1..AC-8 done (AC-7 and AC-8 on 2026-10-15)
**Priority:** P2 — every later Unity step reads packages through this intake, and none of AC-1..AC-7 exists yet.
**Complexity:** 3 (LOW) — 1–5 implementation files (1), new `src/unity/` module (+2); risk override: untrusted
archive paths cross a trust boundary, so AC-2 gets its own traversal test.
**Owner:** João
**Depends on:** None

## Context

Epic README: `docs/PRDs/unity-asset-store-import/README.md`. The buyer downloads Asset Store packages in their
own Unity Editor. The Editor caches each one at `~/.local/share/unity3d/Asset Store-5.x/<publisher>/<category>/<name>.unitypackage`
(or the `ASSETSTORE_CACHE_PATH` override). Nothing in the repo reads Unity packages today.

Three source shapes reach the importer:

1. **`.unitypackage`**: a gzip tar with one `<guid>/` folder per asset that holds `asset` (the file bytes),
   `asset.meta` (importer settings, YAML), `pathname` (the project path, text) and an optional `preview.png`.
2. **UPM tarball**: `package/package.json` plus files with sibling `.meta` files.
3. **Unity project folder**: `Assets/` with sibling `.meta` files. This covers the case where the buyer has
   already imported the package. It is also the fallback if cached packages turn out to be encrypted (unverified, see Blocked on).

Unity YAML is multi-document: `%YAML 1.1`, `%TAG !u! tag:unity3d.com,2011:`, then `--- !u!<classId> &<fileID>`
headers, optionally followed by `stripped`. References are `{fileID: N, guid: G, type: T}`. The built-in GUIDs
`0000000000000000f000000000000000` (built-in extra resources) and `0000000000000000e000000000000000` (default
resources) point outside the package.

Reusable code: `runBounded` (`src/unreal/toolchain.ts:192`) and `extractTarGz` (`src/unreal/provision.ts:262`,
which shells out to `tar`). Port the GUID database rules from Unidot's `asset_database.gd` (MIT), with attribution.

## Solution

`src/unity/package.ts` turns any of the three shapes into a `UnityAssetDatabase`: guid → `{ path, metaYaml,
assetFile, previewFile? }`. Extraction runs `tar` into a fresh temp dir and treats every `pathname` as untrusted.
It rejects absolute paths, `..` segments, drive letters and symlink or hardlink members, and never writes outside
the staging dir. `src/unity/yaml.ts` splits documents on the `--- !u!` header with our own code and parses each
body with the `yaml` package (ISC, new dependency). `resolveRef(ref)` returns the target asset and object, or a
`builtin` marker.

A new MCP tool, `unity_list_packages`, lists the cached packages: path, publisher, category, name, size and
modification time. It reads only local files. It never contacts Unity.

## Acceptance Criteria

- [x] AC-1 [local]: `unity_list_packages` through the MCP returns every `.unitypackage` under a temp cache set by
  `ASSETSTORE_CACHE_PATH`, with publisher, category and name. Without the override it uses the Linux default path.
  proof: `npx vitest run tests/unity-intake.test.ts` — Evidence: passed 2026-10-14 (handler on a temp `ASSETSTORE_CACHE_PATH`, the Linux default path, and a missing cache; the packed-MCP call is AC-6).
- [x] AC-2 [local]: A synthetic `.unitypackage` whose `pathname` holds `../x`, `/abs` or `C:\x`, or whose tar holds a
  symlink, is refused with the offending entry named, and nothing is written outside staging.
  proof: `npx vitest run tests/unity-intake.test.ts -t traversal` — Evidence: passed 2026-10-14 (8 tests: `../x`, `/abs`, `C:\x`, an embedded `..`, symlink and hardlink members, `..` and absolute member names, a project-folder symlink; staging removed, nothing else written). Mutation check: removing the link and `..` guards turned 4 of them red.
- [x] AC-3 [local]: The same synthetic content as a `.unitypackage`, a UPM tarball and a project folder produces
  equal databases (same guid → path → meta).
  proof: `npx vitest run tests/unity-intake.test.ts -t shapes` — Evidence: passed 2026-10-14 (`.unitypackage` = project folder under `Assets/`; `.unitypackage` = UPM tarball = UPM folder = project folder under `Packages/`).
- [x] AC-4 [local]: The YAML reader returns classId, fileID, the `stripped` flag and parsed fields for a synthetic
  multi-document prefab and `.mat`. `resolveRef` resolves a material's texture ref to its asset path, and it
  marks the Standard shader ref as `builtin`.
  proof: `npx vitest run tests/unity-yaml.test.ts` — Evidence: passed 2026-10-14 (5 tests, including a 64-bit fileID, digit-only and `e`-containing guids kept as strings, `stripped`, an unknown classId kept raw).
- [x] AC-5 [local]: An inventory reports counts per kind (model, texture, material, prefab, shader graph, scene,
  other), and `docs/unity-format-support.md` exists with those kinds as rows.
  proof: `npx vitest run tests/unity-intake.test.ts -t inventory` — Evidence: passed 2026-10-14 (inventory counts, ledger rows, and the corpus recorder run on a synthetic corpus).
- [x] AC-6 [local]: The packed MCP lists `unity_list_packages`, and a call on an empty cache returns an empty list
  rather than an error.
  proof: `npx vitest run tests/mcp-smoke.test.ts` — Evidence: passed 2026-10-14 (packed server lists the tool; empty cache returns `total: 0`, a populated cache returns publisher, category and name).
- [x] AC-7 [local]: The corpus packs `U1`, `U2` and `U3` (epic README, "Verification corpus") inventory with zero
  YAML parse failures and zero refused paths. `docs/parity/unity-corpus.json` records each pack's id, listing UID,
  size, SHA-256, pipelines and counts per kind, and no asset names.
  proof: `npx tsx scripts/unity-inventory.ts --corpus ~/.cache/threenative-asset-mcp/unity-corpus --record` — Evidence: `docs/parity/unity-corpus.json` (U1 31 prefabs, U2 17, U3 1006; `yamlFailures` 0 on all three). The 2026-10-15 sweeps imported every prefab with `failed 0, skipped 0` on all three packs. The script also records `previews` and `yamlFailures` per pack. The U3 pack mixes Unity 5 `.meta` files (`serializedVersion: 19`, `fileIDToRecycleName`) and the old `Prefab` container document; both parse (see PRD-004 AC-6).
- [x] AC-8 [local]: The PR comment carries the inventory table for `U1`–`U3` (counts per kind, preview count per
  pack, so PRD-617 knows where `R2` exists), following the epic's PR evidence rule. There is no render yet, so there
  is no sheet. proof: PR comment link — Evidence: https://github.com/ThreeNativeHQ/threenative-asset-mcp/pull/63#issuecomment-6198151490 (inventory table for U1-U3 with the preview count per pack, 2026-10-15).

## Blocked on

- Whether Editor-cached Asset Store packages are plain gzip tars or encrypted is unverified. Unblocked by João:
  download one free Asset Store package in a Unity Editor on this machine (or give its path). If it is encrypted,
  the supported Asset Store source becomes the project folder (shape 3), and the README must say so.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| List cached Unity packages | MCP `unity_list_packages` → `src/server.ts` → `src/unity/package.ts` | New | AC-1, AC-6 |
| Package/project to asset database | `asset_import_unity` (PRD-616) | New; PRD-616 is its consumer | AC-3, AC-4 |

## Execution Phases

#### Phase 1: Extraction and database
**Status:** DONE (2026-10-14)
**Files:** `src/unity/package.ts` (new), `tests/unity-intake.test.ts` (new; builds packages with `tar` in a cleaned temp dir)
**Implementation:** Detect the shape. Extract with `runBounded("tar", …)`, list members first (`tar tvzf`) to refuse
links, validate every `pathname`, and build the database. Every temp dir is removed (`onTestFinished`).
**Verification:** AC-2, AC-3.

#### Phase 2: YAML and references
**Status:** DONE (2026-10-14)
**Files:** `src/unity/yaml.ts` (new), `tests/unity-yaml.test.ts` (new), `package.json` (`yaml`)
**Implementation:** Split documents, parse bodies, expose `resolveRef`. Keep unknown classIds as raw objects.
**Verification:** AC-4.

#### Phase 3: Tool, inventory and ledger
**Status:** PARTIAL — tool, inventory and ledger done; the corpus record (`docs/parity/unity-corpus.json`) and AC-7/AC-8 wait for the corpus packs
**Files:** `src/tools/unity-packages.ts` (new), `src/unity/cache.ts` and `src/unity/inventory.ts` (new), `src/server.ts`, `docs/unity-format-support.md` (new), `docs/tools.md`, `scripts/unity-inventory.ts` (new), `docs/parity/unity-corpus.json` (new)
**Implementation:** Register the tool, add the inventory, the corpus record and the ledger.
**Verification:** AC-1, AC-5, AC-6, AC-7, AC-8.
