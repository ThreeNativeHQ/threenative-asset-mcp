# PRD-598 — UE5 World Partition external actors in levels

**Status:** IN PROGRESS — all local criteria complete; final independent review and CI pending
**Priority:** P2 — real actor placement, mount isolation, sheets and repository gates pass on the repaired implementation.
**Complexity:** 2 (LOW) — importer, adapter, format ledger, and focused real gates; risk override: licensed evidence remains local-only.
**Owner:** lane-598; parent owns final sheet and delivery
**Depends on:** None

## Context

A World Partition level keeps each actor in its own package under `__ExternalActors__/<map path>/…`
(`__ExternalObjects__` for other objects). The importer now associates those packages with the imported map
(`src/unreal/importer.ts:614-634,3892-3894`) and the UE5 level export loads matching runtime `AActor` exports
(`src/unreal/cue4parse-adapter.ts:858-895,3362`). Packages owned by maps outside the import remain skipped with
`WORLD_PARTITION_EXTERNAL_REASON`; matching package-load failures are named in the scene omission list.

The per-actor export (meshes, lights, cameras, Paper2D, Blueprint components; `src/unreal/cue4parse-adapter.ts:3364-3555`)
already exists. The missing actor discovery, exact map association, and failure accounting are now covered by the
compiled converter gate.

## Solution

1. When the converter exports a UE5 level, load external actor packages under the exact
   `__ExternalActors__/<that map's path>/` and pass their `AActor` exports through the same per-actor export.
2. The importer stops skipping external actor packages that belong to a level being imported. It still skips
   (with the same reason) packages whose map is not in the import.
3. Correct the ledger row after the real gate passes; it is now **Verified** in `docs/unreal-format-support.md`.
4. Keep load failures in the native scene JSON as named omissions instead of silently reducing actor coverage.

## Acceptance Criteria

- [x] AC-1 [local]: A real UE5 World Partition level imports with its external actors placed: the scene GLB holds one node per external actor that carries a supported component, at the transform the package stores. proof: opt-in real-pack gate in `tests/fab-feature-corpus.test.ts` — Evidence: parent fresh native/public proof on implementation 5f9b22b, converter .584.8.1/importer121, passed3 real gates in21.29s. Index /home/joao/.cache/threenative-asset-mcp/prd598-real-proof/index81.json; fresh outputs reused:false have3 native actors and3 resolved decoded GLB nodes at the stored source transforms. Converter DLL SHA-25649c6033c5c8364f8aba659ccb30940862eb96addcdee9254c04381fb130c6f6e.
- [x] AC-2 [local]: External actor packages of a map that is not imported stay skipped with `WORLD_PARTITION_EXTERNAL_REASON`. proof: `npx vitest run tests/unreal-external-actors.test.ts --maxWorkers=1` (extended) — Evidence: 27 focused tests pass, including source-extracted compiled production helpers and public TypeScript checks for two mount identities, root/project Content keys, case/separator variants, different maps and external objects. The prior real compiled association fixture also rejects same-basename/different-prefix and `__ExternalObjects__` packages.
- [x] AC-3 [local]: Before/after level sheet attached to the PR and inspected by eye. proof: PR comment link — Evidence: parent inspected the actual scene actor crops, attached in [PR51 comment](https://github.com/ThreeNativeHQ/threenative-asset-mcp/pull/51#issuecomment-6132573301). Before is the same bounded level through `.584.4` (0 actors), after is `.584.8` (3 actors); empty before tiles contain no placeholder geometry. The inspected after-GLB is byte-identical to final .584.8.1 (SHA-256 e96609d898710b862b443a6dd76aacfb056957beafa6adf95c0ddaa99c113552); identity is recorded in raw/parent598-final81-sheet-identity.json. Owner-only Drive PNG, local SHA/path metadata `raw/parent598-sheet.json`.
- [x] AC-4 [local]: Repository gates pass on the final head. proof: `npm run typecheck`, `npm test`, `npm run test:leaks`, `npx vitest run tests/mcp-smoke.test.ts` — Evidence: all four parent checks pass on implementation5f9b22b (subsequent edits are prose only): typecheck0.9s; default suite2,718 passed/16 skipped79.9s; clean leak gate83.4s; packed MCP15/15 in10.6s. Logs: /home/joao/.cache/agent-dumps/prd-596-599/raw/parent598-final81-{typecheck,test,leaks,smoke}.log.

## Remaining work

- Final independent review and CI remain in progress; there is no external input blocker.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| WP external actors | `asset_import_unreal` → UE5 level route (`src/unreal/importer.ts:4729-4762`) → CUE4Parse level export (`src/unreal/cue4parse-adapter.ts:3349-3362`) | Up-front skip stays only for maps not imported | AC-1/AC-2 real gate evidence recorded below |

## Execution Phases

#### Phase 1: Find the pack and fix the ledger
**Status:** DONE
**Files:** `docs/unreal-format-support.md`; a slice entry in `scripts/fab-slice.ts`.
**Implementation:** Search the owned listings for a UE5 WP level (prefer a small one). Add a slice. Correct the ledger row.
**Verification:** `npx --no-install tsx scripts/fab-slice.ts list` passed; the selected local artifact is `MedievalGame_5.3` and its exact local real fixture is recorded outside the repository.

#### Phase 2: Load external actors with their level
**Status:** DONE
**Files:** `src/unreal/cue4parse-adapter.ts`, `src/unreal/importer.ts`, `tests/unreal-external-actors.test.ts`, `tests/fab-feature-corpus.test.ts`.
**Implementation:** As in Solution 1–2. Bump converter tag and `IMPORTER_VERSION`.
**Verification:** converter source pin `b4e95441+threenative.584.8.1`, importer `121`; 27 focused tests pass. Final .584.8.1 real native/public gate passed3/3 in21.29s.

#### Phase 3: Evidence and gates
**Status:** DONE
**Verification:** final .584.8.1 real proof, all four repository gates and sheet-byte identity passed. Final review and CI are delivery checks in progress.

## Source-backed implementation facts

- `src/unreal/cue4parse-adapter.ts:2-6` pins the rebuilt converter; `src/unreal/importer.ts:82` records importer version 121.
- `src/unreal/importer.ts:614-634` derives the owning `.umap` from the external-actor path; `:3462-3467` removes external packages from standalone classification; `:3892-3894` retains only unimported-map skips with `WORLD_PARTITION_EXTERNAL_REASON`.
- `src/unreal/cue4parse-adapter.ts:858-876` normalizes separators while preserving provider mount identity and compares the full map path; `:878-895` enumerates `AActor` runtime exports and records named package-load omissions; `:3349-3362` feeds them into level reconstruction.
- `tests/fab-feature-corpus.test.ts:797-840` runs both the direct native converter and public importer; `:842-895` compares all 3 probe records, native JSON transforms, decoded GLB nodes/geometry, and global matrices, with a compiled association fixture.
- `tests/unreal-external-actors.test.ts:24-74,85-128` covers same-basename/different-prefix ownership and the public unimported-map skip reason.

## Local real evidence

- Source stage: `/home/joao/.cache/threenative-asset-mcp/prd598-real-stage-Zt2Wd8` — 28 hashed files: the selected `.umap`, 3 probe-confirmed external actor packages, and the 24-file dependency closure.
- Native output: `/home/joao/.cache/threenative-asset-mcp/prd598-real-proof/native-output/Scenes/` (exact JSON path is in the local proof index).
- Public output: `/home/joao/.cache/threenative-asset-mcp/prd598-real-proof/public-output` (`import-report.json`, scene GLB, scene manifest); report source hash `sha256:9a0bee37c32cff152f8c9634577fd538e47dd51f8e22c561ac10cf91cf31b331`.
- Association output: `/home/joao/.cache/threenative-asset-mcp/prd598-real-proof/association-output/Scenes/` (exact JSON path is in the local proof index); 3 valid actors remain while same-basename/different-prefix and external-object distractors are excluded, and the deliberately corrupt matching package is an `ExternalActorPackage` omission with a named load reason.
- Fresh focused evidence: `PRD598_REAL_WP_PROOF_INDEX=/home/joao/.cache/threenative-asset-mcp/prd598-real-proof/index.json npx vitest run tests/fab-feature-corpus.test.ts --maxWorkers=1` → 35 passed, 9 expected skips; `npx vitest run tests/unreal-external-actors.test.ts --maxWorkers=1` → 3 passed.
- Parent completed the final local repository gates and inspected/attached the sheet; independent review and this PR’s CI remain pending.

## Decisions

- Official reference: `/home/joao/projects/UnrealEngine-5.8.3`, tag `5.8.3-release`, commit `396c9f059903aed5fec78ecd3d437a40c6415368`. `Engine/Source/Runtime/Engine/Private/Level.cpp:4151-4164` constructs the external actor directory from the mount, complete map package path and short name. `:4069-4110` appends two bucket directories and the remaining Base36 name for both Original and Reduced schemes. Matching the complete owning map path before the last three path components follows that layout; same-basename maps elsewhere are excluded. `:4598-4602` discovers on-disk external packages through the map-specific external actor paths. These source snippets were read directly from the official Git blobs; no engine build was required.
- Parent inspected the production neutral comparison: original `.584.4` public scene has0 actors; `.584.8` has3 actual decoded actors. Full-level framing shows widely spaced pieces as small points, so the attached comparison uses crops of the three actual public scene nodes. Global placement is independently checked against the stored source transforms in the real gate. Renderer policy and lighting are unchanged; no fidelity sweep was run.

## Review 1 mount-identity repair

The shipped native matcher previously stripped every prefix before `Content/`, admitting an actor from one plugin into another plugin’s same-path map. Converter `b4e95441+threenative.584.8.1` now preserves the full provider prefix in both ownership comparisons and omission paths; importer stays `121` because only native association changed. The source-extracted compiled production helpers and public TypeScript helper share synthetic ownership cases for root Content, project Content, two plugin mounts, case/separator variants, other map prefixes and external objects. Focused verification: the old compiled matcher failed three cross-mount cases (24 passed), then all 27 passed after repair; `npm run typecheck` and `git diff --check` pass. Private logs: `raw/598-mount-{red,green,typecheck}.log`. final native build and AC-1/AC-4 proof remain the parent’s work.

- Final parent proof: repaired mount matching retains all three actual actors, and the freshly imported scene matches the inspected sheet bytes. All local ACs are complete. The first independent review requested the mount fix;5f9b22b repairs it, with actual compiled old-code failures and27 passing ownership checks. Final independent review remains pending.
