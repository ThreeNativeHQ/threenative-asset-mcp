# PRD-619 — Import Unity-format Fab listings through FabCLI

**Status:** IN PROGRESS — the route, listing and tests are done against a FabCLI stub. AC-1, AC-4 and AC-5 wait on João (see Blocked on).
**Priority:** P2 — this is the epic's only unattended acquisition route, and AC-1..AC-4 do not exist yet.
**Complexity:** 2 (LOW) — 1–5 implementation files (1), external API integration (+1); risk override: none
**Owner:** João
**Depends on:** PRD-616

## Context

Fab sells Unity-format artifacts beside Unreal ones. The repo already accepts the `unity` format for free direct
downloads (`src/fab/api-download.ts:33`), and `src/fab/fabcli.ts:115` already parses Unity entries in the library
listing. But `fab_list_owned` and `fab_import_asset` only route Unreal artifacts (`src/fab/routes.ts`,
`src/tools/import-unreal.ts`). FabCLI is the user's own signed-in tool, and the Fab license gate
(`requirePermittedLicense`, `src/tools/import-unreal.ts:503`) already covers these listings. So no Unity Asset
Store terms apply to this route.

Probe on 2026-10-14: `fabcli formats` shows that 3 of the owner's 50 Fab listings offer a `unity` format with the
extension `unitypackage` (`versions: null`). Their tech details list the render pipelines Built-in only;
URP + Built-in + custom shaders (458 prefabs by the listing; the file holds 1006 prefab documents); and HDRP + URP + Built-in. Each one is also on the Unity Asset Store
(`isInUnityAssetStore: true`). `fabcli library` lists only Unreal `projectVersions`, so how to download the Unity
artifact is still unknown: FabCLI, or the Fab web download path that `src/fab/api-download.ts` uses for free assets.

### Probe findings (2026-10-14, listing U1 `fbc35597-dbcf-4da8-bb29-4fdbf203c46e`)

- `fabcli formats <uid>` returns a `unity` entry beside the Unreal one: `extensions: ["unitypackage"]`,
  `versions: null`, `renderPipelines`, `unityAssetStoreUrl`, `isInUnityAssetStore`.
- `fabcli library` and `fabcli listing` expose only Unreal `projectVersions` (`artifactId`, `engineVersions`). So
  there are **no Epic catalog coordinates** (artifact id, namespace, asset id) for the Unity artifact.
- `fabcli download <uid>` resolves its coordinates from the library, so it fetches the **Unreal** pack.
- The anonymous Fab web API (`/i/listings/<uid>/asset-formats/unity`) returns a Cloudflare challenge to a plain
  fetch. `download-info` for an owned paid file needs a signed-in Fab web session.
- `fabcli ownership` answers `auth_required` (`claim needs a Fab session`), and `fabcli auth status` shows
  `fab.session_present: false`.

Result: U1 cannot be downloaded unattended today. The shape of the entry fields above is as reported by the
probe; this PRD's code reads them tolerantly (all optional) because no raw payload was recorded.

## Solution

Probe one owned Unity-format artifact. Add a `unity` route to `fab_list_owned`. In `fab_import_asset`, a Unity
artifact (chosen by `format: "unity"` or because it is the only artifact) downloads into the existing
`fab-downloads/<listing>/<artifact>` cache and goes to the PRD-616 importer. Unreal selection is unchanged.

## Acceptance Criteria

- [ ] AC-1 [local]: The probe downloads corpus pack `U1` (the smallest) through FabCLI or the signed-in Fab web path,
  records the artifact layout in this PRD's Context, and PRD-615 accepts that shape.
  proof: download plus `npx tsx scripts/unity-inventory.ts <dir>` — Evidence: pending. **Not met:** no download path
  exists for U1 (see Probe findings and Blocked on).
- [x] AC-2 [local]: `fab_list_owned` reports Unity artifacts with route `unity`, and `unrealOnly: true` still hides
  them. proof: `npx vitest run tests/fab-unity-route.test.ts` (recorded FabCLI output) — Evidence: 17 tests pass, the
  list cases among them. They use the probed shape (`versions: null`) with synthetic UIDs. `unrealOnly` hides the
  Unity artifact and runs no `formats` lookup. This is a stub, not a live FabCLI.
- [x] AC-3 [local]: `fab_import_asset` on a recorded Unity listing downloads through the FabCLI stub and calls the
  Unity importer. An Unreal listing still takes its old route. proof: `npx vitest run tests/fab-unity-route.test.ts -t import` — Evidence: 12 tests pass.
  The stub download uses `--artifact-id --namespace --asset-id` into `fab-downloads/<listing>/<artifact>`, and the
  importer stub gets the `.unitypackage`. A listing with both formats still takes the Unreal route
  (`tests/fab-import.integration.test.ts` still passes). The licence gate runs first. Without coordinates the call
  fails with `FABCLI_UNITY_DOWNLOAD_UNAVAILABLE` and downloads nothing.
- [ ] AC-4 [local]: `fab_import_asset` with `format: "unity"` imports `U1`, `U2` and `U3` end to end through the
  packed MCP. Each downloaded package's SHA-256 matches `docs/parity/unity-corpus.json`, so the Fab route and
  manual intake read the same bytes. proof: three MCP calls plus the hash comparison — Evidence: pending.
- [ ] AC-5 [local]: The PR comment embeds sheets per the epic's PR evidence rule. Before (base) shows the Fab
  route refusing the Unity artifact. After shows the `U1`–`U3` slices imported through `fab_import_asset`, and
  their judge scores equal those of the manual-intake import of the same slice. proof: PR screenshot comment — Evidence: pending.
  **Not met:** it needs AC-4 or the manual intake of U1–U3.

## Blocked on

- **João, on 2026-10-14:** AC-1 and AC-4 need one of two things. Either run `fabcli auth login` yourself to create a
  Fab web session (the server never signs in), after which the probe is repeated and may show coordinates; or place
  the three `.unitypackage` files in `~/.cache/threenative-asset-mcp/unity-corpus/<U1|U2|U3>/` and run
  `asset_import_unity` on them.
- If neither FabCLI nor the signed-in Fab web path can download the owned Unity artifacts, João downloads the three
  `.unitypackage` files from fab.com in his browser into `~/.cache/threenative-asset-mcp/unity-corpus/<id>/`. AC-4 then becomes a manual-intake check, and the automated
  route is recorded as unavailable under Decisions.

## Decisions

- **2026-10-14, route without a download.** The Unity route is built and tested against a FabCLI stub, but it can
  download only when FabCLI reports the Unity artifact's `artifactId` (a non-null `versions` entry) and the library
  reports the listing's `assetId` and `assetNamespace`. The probe shows neither for U1. Without them the call stops
  with `FABCLI_UNITY_DOWNLOAD_UNAVAILABLE`, which names both unblock options and `asset_import_unity`. We do not
  guess an endpoint, drive a browser login, or use the listing-only `fabcli download`, which would fetch the
  Unreal pack.
- **`fab_list_owned` costs one `fabcli formats` call per listing** (four at a time), because the library does not
  say which listings have Unity. `unrealOnly: true` skips them. A failed lookup is a `warnings` entry.
- **Output schema.** `fab_import_asset` now returns the Unreal summary or the `asset_import_unity` summary
  (`anyOf`, root `type: "object"`, so legacy clients get no wrapper). Its callers narrow on `importerVersion`.
- **Licence.** The Fab licence gate applies to this route. `acceptUnityAssetStoreEula` is not asked for: the Unity
  Asset Store terms do not govern a Fab download, and `acceptFabEula` already covers it.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Unity Fab artifacts | `fab_list_owned`, `fab_import_asset` → `src/unity/importer.ts` | Extends the Fab tools; the Unreal route is unchanged | AC-2..AC-4 |

## Execution Phases

#### Phase 1: Probe
**Status:** IN PROGRESS — the FabCLI probe is done and recorded in Context. The download probe (AC-1) is blocked.
**Verification:** AC-1.

#### Phase 2: Route
**Status:** IN PROGRESS — done against the stub (AC-2, AC-3); AC-4 and AC-5 are blocked.
**Files:** `src/fab/fabcli.ts`, `src/tools/import-unreal.ts`, `src/tools/import-fab-unity.ts` (new), `src/cli.ts`, `src/server.ts`, `tests/fab-unity-route.test.ts` (new), `docs/fab-contract.md`
**Verification:** AC-2, AC-3, AC-4, AC-5.
