# PRD-619 — Import Unity-format Fab listings through FabCLI

**Status:** NOT STARTED
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
URP + Built-in + custom shaders (458 prefabs); and HDRP + URP + Built-in. Each one is also on the Unity Asset Store
(`isInUnityAssetStore: true`). `fabcli library` lists only Unreal `projectVersions`, so how to download the Unity
artifact is still unknown: FabCLI, or the Fab web download path that `src/fab/api-download.ts` uses for free assets.

## Solution

Probe one owned Unity-format artifact. Add a `unity` route to `fab_list_owned`. In `fab_import_asset`, a Unity
artifact (chosen by `format: "unity"` or because it is the only artifact) downloads into the existing
`fab-downloads/<listing>/<artifact>` cache and goes to the PRD-616 importer. Unreal selection is unchanged.

## Acceptance Criteria

- [ ] AC-1 [local]: The probe downloads corpus pack `U1` (the smallest) through FabCLI or the signed-in Fab web path,
  records the artifact layout in this PRD's Context, and PRD-615 accepts that shape.
  proof: download plus `npx tsx scripts/unity-inventory.ts <dir>` — Evidence: pending.
- [ ] AC-2 [local]: `fab_list_owned` reports Unity artifacts with route `unity`, and `unrealOnly: true` still hides
  them. proof: `npx vitest run tests/fab-unity-route.test.ts` (recorded FabCLI output) — Evidence: pending.
- [ ] AC-3 [local]: `fab_import_asset` on a recorded Unity listing downloads through the FabCLI stub and calls the
  Unity importer. An Unreal listing still takes its old route. proof: `npx vitest run tests/fab-unity-route.test.ts -t import` — Evidence: pending.
- [ ] AC-4 [local]: `fab_import_asset` with `format: "unity"` imports `U1`, `U2` and `U3` end to end through the
  packed MCP. Each downloaded package's SHA-256 matches `docs/parity/unity-corpus.json`, so the Fab route and
  manual intake read the same bytes. proof: three MCP calls plus the hash comparison — Evidence: pending.
- [ ] AC-5 [local]: The PR comment embeds sheets per the epic's PR evidence rule. Before (base) shows the Fab
  route refusing the Unity artifact. After shows the `U1`–`U3` slices imported through `fab_import_asset`, and
  their judge scores equal those of the manual-intake import of the same slice. proof: PR screenshot comment — Evidence: pending.

## Blocked on

- If neither FabCLI nor the signed-in Fab web path can download the owned Unity artifacts, João downloads the three
  `.unitypackage` files from fab.com in his browser into `~/.cache/threenative-asset-mcp/unity-corpus/<id>/`. AC-4 then becomes a manual-intake check, and the automated
  route is recorded as unavailable under Decisions.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Unity Fab artifacts | `fab_list_owned`, `fab_import_asset` → `src/unity/importer.ts` | Extends the Fab tools; the Unreal route is unchanged | AC-2..AC-4 |

## Execution Phases

#### Phase 1: Probe
**Status:** NOT STARTED
**Verification:** AC-1.

#### Phase 2: Route
**Status:** NOT STARTED
**Files:** `src/fab/routes.ts`, `src/tools/import-unreal.ts`, `tests/fab-unity-route.test.ts` (new), `docs/fab-contract.md`
**Verification:** AC-2, AC-3, AC-4, AC-5.
