# PRD-598 — UE5 World Partition external actors in levels

**Status:** NOT STARTED
**Priority:** P2 — AC-1..AC-3 open: a World Partition level imports with none of its actors, and PRD-599 (landscape) cannot start without them.
**Complexity:** 2 (LOW) — 1–5 files (`src/unreal/cue4parse-adapter.ts`, `src/unreal/importer.ts`); risk override: none.
**Owner:** unassigned
**Depends on:** None

## Context

A World Partition level keeps each actor in its own package under `__ExternalActors__/<map path>/…`
(`__ExternalObjects__` for other objects). Today the importer skips every such package up front
(`src/unreal/importer.ts:3440-3445`) with `WORLD_PARTITION_EXTERNAL_REASON` (`importer.ts:604`, reported at
:3869). The UE5 level export walks only `world.PersistentLevel.Actors` (`src/unreal/cue4parse-adapter.ts:3313,3324`),
so a WP level comes out with no actors. The ledger row "World Partition external actors — Implemented, merged into
the level" (`docs/unreal-format-support.md`) is wrong; `tests/unreal-external-actors.test.ts:20-50` tests the skip.

The per-actor export (meshes, lights, cameras, Paper2D, Blueprint components; :3328-3344, output :3373-3509) already
exists. Only the actor list is missing.

## Solution

1. When the converter exports a UE5 level, also load the external actor packages under
   `__ExternalActors__/<that map's path>/` and pass their actors through the same per-actor export.
2. The importer stops skipping external actor packages that belong to a level being imported. It still skips
   (with the same reason) packages whose map is not in the import.
3. Correct the ledger row in this PRD's first commit (Reported: skipped), then move it when AC-1 passes.

## Acceptance Criteria

- [ ] AC-1 [local]: A real UE5 World Partition level imports with its external actors placed: the scene GLB holds one node per external actor that carries a supported component, at the transform the package stores. proof: real-pack gate in `tests/fab-feature-corpus.test.ts` on the pack chosen in Phase 1 — Evidence: pending.
- [ ] AC-2 [local]: External actor packages of a map that is not imported stay skipped with `WORLD_PARTITION_EXTERNAL_REASON`. proof: `npx vitest run tests/unreal-external-actors.test.ts` (extended) — Evidence: pending.
- [ ] AC-3 [local]: Before/after level sheet attached to the PR and inspected by eye. proof: PR comment link — Evidence: pending.
- [ ] AC-4 [local]: Repository gates pass on the final head. proof: `npm run typecheck`, `npm test`, `npm run test:leaks`, `npx vitest run tests/mcp-smoke.test.ts` — Evidence: pending.

## Blocked on

- A real UE5 World Partition pack in the owner's library. Phase 1 searches the owned listings (`fab_list_owned`, artifact file lists) for `__ExternalActors__`; if none exists, AC-1 is unreachable — unblocked by João naming or acquiring one.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| WP external actors | `asset_import_unreal` → UE5 level route (`importer.ts:4705-4745`) → CUE4Parse level export (`cue4parse-adapter.ts:3311`) | Up-front skip stays only for maps not imported | AC-1, AC-2 |

## Execution Phases

#### Phase 1: Find the pack and fix the ledger
**Status:** NOT STARTED
**Files:** `docs/unreal-format-support.md`; a slice entry in `scripts/fab-slice.ts`.
**Implementation:** Search the owned listings for a UE5 WP level (prefer a small one). Add a slice. Correct the ledger row.
**Verification:** slice builds with `scripts/fab-slice.ts`.

#### Phase 2: Load external actors with their level
**Status:** NOT STARTED
**Files:** `src/unreal/cue4parse-adapter.ts`, `src/unreal/importer.ts`, `tests/unreal-external-actors.test.ts`.
**Implementation:** As in Solution 1–2. Bump converter tag and `IMPORTER_VERSION`.
**Verification:** AC-1, AC-2.

#### Phase 3: Evidence and gates
**Status:** NOT STARTED
**Verification:** AC-3, AC-4; ledger row to Verified.
