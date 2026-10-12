# PRD-598 — UE5 World Partition external actors in levels

**Status:** DONE
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

- Repaired `.584.8.3` fresh World Partition and Hornbeam gates pass. Parent still owns all four final-head repository gates, CI and delivery. Earlier `.584.8.1` and `.584.8.2` repository evidence remains prior-head evidence; there is no external input blocker.

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
- Native output: `/home/joao/.cache/threenative-asset-mcp/prd598-real-proof/final81/native-output/Scenes/` (exact JSON path is in the local proof index).
- Public output: `/home/joao/.cache/threenative-asset-mcp/prd598-real-proof/final81/public-output` (`import-report.json`, scene GLB, scene manifest); report source hash `sha256:9a0bee37c32cff152f8c9634577fd538e47dd51f8e22c561ac10cf91cf31b331`.
- Association output: `/home/joao/.cache/threenative-asset-mcp/prd598-real-proof/final81/association-output/Scenes/` (exact JSON path is in the local proof index); 3 valid actors remain while same-basename/different-prefix and external-object distractors are excluded, and the deliberately corrupt matching package is an `ExternalActorPackage` omission with a named load reason.
- Final real evidence: `PRD598_REAL_WP_PROOF_INDEX=/home/joao/.cache/threenative-asset-mcp/prd598-real-proof/index81.json THREENATIVE_TOOLCHAIN_DIR=/home/joao/.cache/threenative-asset-mcp/prd598-toolchain npx vitest run tests/fab-feature-corpus.test.ts -t 'PRD-598'` → 3 passed, 41 unrelated tests skipped, 21.29s. The compiled/public ownership regression has27 passing checks.
- Parent completed final local repository gates and inspected/attached the sheet. Both allowed reviews completed; this PR’s final CI remains in progress.

## Decisions

- Official reference: `/home/joao/projects/UnrealEngine-5.8.3`, tag `5.8.3-release`, commit `396c9f059903aed5fec78ecd3d437a40c6415368`. `Engine/Source/Runtime/Engine/Private/Level.cpp:4151-4164` constructs the external actor directory from the mount, complete map package path and short name. `:4069-4110` appends two bucket directories and the remaining Base36 name for both Original and Reduced schemes. Matching the complete owning map path before the last three path components follows that layout; same-basename maps elsewhere are excluded. `:4598-4602` discovers on-disk external packages through the map-specific external actor paths. These source snippets were read directly from the official Git blobs; no engine build was required.
- Parent inspected the production neutral comparison: original `.584.4` public scene has0 actors; `.584.8` has3 actual decoded actors. Full-level framing shows widely spaced pieces as small points, so the attached comparison uses crops of the three actual public scene nodes. Global placement is independently checked against the stored source transforms in the real gate. Renderer policy and lighting are unchanged; no fidelity sweep was run.

## Review 1 mount-identity repair

The shipped native matcher previously stripped every prefix before `Content/`, admitting an actor from one plugin into another plugin’s same-path map. Converter `b4e95441+threenative.584.8.1` now preserves the full provider prefix in both ownership comparisons and omission paths; importer stays `121` because only native association changed. The source-extracted compiled production helpers and public TypeScript helper share synthetic ownership cases for root Content, project Content, two plugin mounts, case/separator variants, other map prefixes and external objects. Focused verification: the old compiled matcher failed three cross-mount cases (24 passed), then all 27 passed after repair; `npm run typecheck` and `git diff --check` pass. Private logs: `raw/598-mount-{red,green,typecheck}.log`. The parent completed the final native build, fresh AC-1 proof and all four AC-4 gates.

- Final parent proof: repaired mount matching retains all three actual actors, and the freshly imported scene matches the inspected sheet bytes. All local ACs are complete. The first independent review requested the mount fix;5f9b22b repairs it, with actual compiled old-code failures and27 passing ownership checks. The second and final review found stale documentation only; the command and pending-proof sentence are corrected below.

## Final review disposition

The second independent review requested changes only to the stale proof command and contradictory pending-proof sentence. Both are corrected in this final document, with the actual final21.29s result and index81.json. Its code repair and tests were accepted as correct. No third review or independent APPROVE verdict is claimed; delivery rests on the repaired findings, parent evidence and final CI. All local acceptance criteria are complete, so this original PRD moves to done/.

## Frozen PR-50 integration

Ordinary merge of published PR-50 head `a5908767c4358d07f739254f101d7ad2c27be224` preserves PRD-597 source-model LODs, tagged BuildScale3D and cooked-render no-double-scale behavior alongside PRD-598 external actors and full provider mount ownership. Both original completed PRDs and the other planning PRDs are retained. Converter pin is `b4e95441+threenative.584.8.2` because the `.584.8.1` cache lacks PRD-597 code; importer remains `121`. Build uses only the PRD-598 converter cache with the existing shared SDK. Prior real-pack and repository evidence remains `.584.8.1` evidence; fresh final-tag real proof, all four gates and CI belong to the parent and are pending.

Integration verification: the own-cache converter build passed and reports `.584.8.2`; `npm run typecheck` passed. Focused runs with default workers and `CI=true` passed 337 tests across 11 files (one existing opt-in real-editor test skipped): converter/static mesh, UE5 sources, instance parameters, graph dump, external actors, texture decode, editor mesh/build scale and importer integration/duplicate-package routes. Compiled production cooked bounds and full-mount actor ownership both passed. `git diff --check` passed. No fresh final-tag real-pack gate, full-suite, leak gate, packed-MCP or CI result is claimed here.

## Legacy LOD0 integration repair plan (2026-10-12)

Complexity: 2 → LOW; risk override: none. Repair the integrated static-mesh reader, preserve exact per-LOD identity and cooked scaling, prove synthetic missing-reference/ambiguity behavior and fresh native/public WP counts. Parent owns full repository gates and CI. Actual local source-model dumps show exact LOD0 bulk references on both omitted meshes; their export begins with UObject tagged properties, then flags 0x40, and their legacy TOC has no modern trailer magic. The old reader interpreted the FName index as flags and interpreted the legacy TOC as a modern trailer. Source-backed exact inline references restore three native mesh exports; public and synthetic proof completed below.

## Legacy LOD0 integration repair result

**Integration:** repaired locally; parent final-head repository gates and CI pending.
**Release:** Unreleased — converter `b4e95441+threenative.584.8.3`; importer remains `121`.

The actual 28-file source stage disproves the initial missing-reference hypothesis. Both omitted meshes have separate, exact LOD0 bulk UObject references, with flags `0x40`, nonzero raw payload sizes and inline offsets pointing to valid compressed MeshDescriptions. Their older TOC starts with version/count rather than the modern trailer tag. The old reader read the odd `None` FName index as flags (incorrectly setting the virtualized bit), then returned from modern trailer validation before trying the referenced inline offset. The unaffected mesh uses the modern trailer layout. Private property dumps, exact export bytes, candidate offsets and live triangle counts are in `raw/598-probe{,-bulk}.log`; licensed identifiers remain outside the repository.

The repair deserializes the actual UObject preamble before reading bulk flags and parses a modern trailer only when its source-defined header tag matches. Exact hash/offset selection remains the primary route. A SourceModel without a bulk identity can emit LOD0 only when exactly one readable payload matches a positive cached triangle count; multiple readable payloads are refused regardless of size. Higher generated LODs never receive LOD0 geometry. The older no-SourceModels route also refuses multiple readable payloads. Missing LOD0 is `unreadable` with a reason, and failed scene/prefab mesh components become named omissions. Cooked scaling, requested modern per-LOD selection and external actor association stay intact.

Official reference, same local `5.8.3-release` commit recorded above: `Engine/Source/Runtime/CoreUObject/Private/Serialization/EditorBulkData.cpp:1043-1055` serializes flags, bulk GUID, content identity and size; `Engine/Source/Runtime/CoreUObject/Public/UObject/PackageTrailer.h:502` defines header tag `0xD1C43B2E80A5F697`. `Engine/Source/Runtime/Engine/Private/StaticMeshSourceData.cpp:392-427` separately confirms that genuinely legacy SourceModels may serialize their MeshDescription inline rather than through a bulk UObject. Pinned CUE4Parse `UObject.Deserialize` reads the tagged properties and optional object GUID; the repair uses that shipped parser rather than assuming a preamble length.

Verification on `.584.8.3`:

- Synthetic old-exporter RED: the SourceModels-present/no-reference test fails because no GLB is emitted (asserted success true, actual false), not from a timeout or harness error. Candidate GREEN: all 5 static-mesh tests pass in 6.53s, exercising the shipped exporter, actual compressed-payload/MeshDescription readers, decoded native GLB and public importer relay; ambiguity is named and generated LOD1 emits no copied geometry. The serialized odd-None-index fixture verifies flags `64`. Logs: `raw/598-legacy-red.log`, `raw/598-legacy-final-green.log`.
- Focused default-worker run: 167 tests pass across 6 files in 44.87s (static meshes, UE5 source readers, external actors, instance parameters, graph dump and texture decode). Log: `raw/598-release83-focused.log`. The public legacy assertion added afterward is covered by the final 5-test run above.
- Fresh real WP gate: 3/3 pass in 7.86s, using index `/home/joao/.cache/threenative-asset-mcp/prd598-real-proof/index83.json` and new `final83/` outputs. All 3 native mesh GLBs and all 3 public models/scene nodes are restored; the gate checks every stored actor world transform and exact map ownership. Log: `raw/598-release83-real-wp.log`.
- Modern Hornbeam LOD guard: 1/1 passes in 49.29s, with unchanged triangle counts 115,674 / 41,543 / 15,076 for requested LOD0/1/2. Log: `raw/598-release83-hornbeam.log`. Typecheck, JavaScript build and whitespace checks pass. Converter publish used only the existing PRD-598 source/bin cache and read the shared SDK; no other lane was edited.

No full-suite, leak-gate, packed-MCP or final CI pass is claimed for this repair. Those remain the parent's delivery checks. All lane builds and real runs are finished and released for parent use; this checkout stays available for the active PR-51 delivery.
