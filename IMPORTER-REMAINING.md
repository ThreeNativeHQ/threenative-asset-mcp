# What is missing to finish the Fab/Unreal importer (PR #36)

State as of 2026-10-10, branch `fix/graph-view-nodes` (importer 89, local only, not pushed).
AC-6 (every pack passes S1–S4) is **not met**, so PR #36 is not mergeable yet.

## 1. Packs still failing the gate

| Pack | Status | What blocks it |
|---|---|---|
| **Game Animation Sample** (UE 5.8) | S1–S3, S5 pass; **S4 fails (56/62 sections)** | Colour lives in `Custom` HLSL nodes and engine content functions (hair, eye refractive, eyelash cards). The converter exports `Custom` code but no pins, and the engine function bodies are not in the pack. Needs a converter change (export Custom inputs) plus engine function bodies, or a recorded exception. Gate is not relaxed. |
| **Paragon** (UE 4.19) | S4 and S3 fail (2 identity violations) | 9567 sections report "texture could not be loaded"; cause not yet known (S10 keep re-run in progress, read its import-report warnings). `BreakMaterialAttributes.Metallic` on 1262 sections (attributes only carry BaseColor). 2885 sections have no dumped graph (graph-dump node cap truncation, `M_Dawn_Reference` has no props). |
| **Spruce Forest** (UE 4.19) | Passed numerically; eyes showed flattened winter spruces | Fix committed (`cd10db6`), **not yet confirmed on the real pack** (IN2 re-run in progress). |
| **Medieval Village** (5.3 and 4.26) | S1/S2/S3 failures reported earlier | Not re-verified on the merged head. `MaterialIndex` clamp (`MeshLodDto.cs:31`) suspected. |
| **Downtown West** (4.26) | 13 S2 shape violations; mountains black / water drop | Sheet tiles uninspected. |
| **Hornbeam UE4.25 / UE5** | UE4.25: maroon leaves; UE5: white Icon meshes | UE5 mesh writer drops vertex colours. |
| **Asian male** | 12/15 sections | Backdrop uses BoundingBoxBased node; eye occlusion has no BaseColor; no skin material in the pack (MetaHuman). |
| **Common Hazel** | Never run | Size-excluded; re-include with `--no-exclude-size`. |

Known accepted exception candidates: Paladin beard (engine texture not in the pack), GAS S4.

## 2. Open visual defects (eye check)

- Old West curtains (likely a documented limitation).
- Palms `Plant_07`.
- Paladin head / ghost cylinder.
- ModularR `Utility_Box` hue, `Fork` ghost.
- Medieval 4.26 terrain, `WellShingles`, `WhiteEverlasting`.
- P3 known issues: rock AO texture, `SM_waterPlane` white, -65504 half-float UVs on dead-tree bark, `fern_02_04/05` hue off ~30° and 4–7× lighter, foliage two-sided/shadow lighting, Fresnel/DepthFade bakes are approximations.
- Unverified: possible sRGB-flag problem for 16-bit normal maps; `PrecomputedAOMask` 0 vs 1 not compared against thumbnails.

## 3. Verification still to run on the final head

1. Full sharded sweep of every variant on the merged head (3–4 shards, separate out/tmp/toolchain copies).
2. Look at every contact sheet by eye (visual-judge: numbers then eyes, like with like).
3. Metadata-replay sibling check for the importer 89 change (`FAB_METADATA_DIR=<dir> npx vitest run tests/fab-metadata.test.ts`).
4. `npx tsx scripts/fidelity-baseline.ts check <dir>`, then `update` to ratchet.
5. `npm run build`, full suite with default workers, `npm run test:leaks`.
6. Empty-toolchain run (importer changes cause CI-only timeouts from lazy installs).
7. Fresh-eyes review subagent given the diff and the original brief.

## 4. PR and bookkeeping

- Merge `fix/sweep-paragon` and `fix/sweep-identity` unions already done; push fast-forward only to `feat/parity-sweep-licences` (arms never push).
- Publish before/after sheets to the `pr36-assets` orphan branch; update PR body and metrics comment via `gh api -X PATCH` (`gh pr edit` is broken).
- PRD-537/538: tick boxes with evidence or move to "Blocked on"; move to `done/` only if AC-6 is met. Record particle-effect decision. Open: ROUTE_PREFERENCE calibration, AC-5 live Hornbeam run, AC-7, AC-3, PRD-538 AC-4.
- `gh pr ready 36` only if honest; run `ci-wait.sh 36 <repo-dir>`; no CI bypass; do not squash-merge without green.
- Cleanup: `.worktrees/*`, `toolchain-m-*` copies, `parity-m-*`/`parity-tmp`, stale `fab-downloads` (named dirs only), `/tmp/arm-*`.
- Commit the uncommitted `.afk/2026-10-08-fidelity-sweep.md` log decision (or leave local).

## 5. Needs you (not mine to do)

- `npm publish` of `threenative-asset-mcp` and the engine pin bump in `threenative-engine/packages/core/package.json` (PR to `develop`).
- Epic-source provenance decision: the UE5 `ImageCoreDelta` tile rule was learned from a public third-party fork of EULA-licensed source (nothing copied, byte-exact result).
- Owner forest screenshot (P2): need glTF asset names for the white pine trunk tops.
- Decide whether GAS S4 and Paragon become named exceptions in PRD-537.
- Optional: re-extract `libUnrealEditor-Engine.so` and `Engine/Content/Functions` so engine content functions bake exactly instead of heuristically.

## 6. State at merge time (2026-10-10)

- Everything above landed on `main` via PR #36 (`feat/parity-sweep-licences` fast-forwarded from `fix/graph-view-nodes`); backup bundle at `~/.cache/threenative-asset-mcp/backup-2026-10-10/`.
- Merged **with named exceptions**: GAS S4 and Paragon S4/S3 are failing, not waived (see PRD-537 Decisions, 2026-10-10). AC-6 is still open.
- Not run before merge: Spruce IN2 eye check, Paragon S10 result, metadata-replay sibling check for importer 89, `fidelity-baseline.ts check/update`, empty-toolchain run, fresh-eyes review. These are the first items of the follow-up.

## 7. Follow-up PR checklist (in order)

1. Read Spruce IN2 sheets by eye (trunk, branch and leaf bind their own textures); if wrong, iterate on `chainOverridesSwitch`/probe in `importer.ts`.
2. Read Paragon S10 import-report warnings; fix the 9567 "texture could not be loaded" cause; handle `BreakMaterialAttributes.Metallic`; raise/verify graph node cap (converter bump) and the `M_Dawn_Reference` parent chain.
3. GAS: export `Custom` node inputs from the converter and model the hair/eye/eyelash engine functions, or accept a recorded exception in PRD-537.
4. Re-run Medieval (both), Downtown West, Hornbeam (both), Asian male, Common Hazel on the merged head; fix S1/S2/S3 failures.
5. UE5 mesh writer: carry vertex colours (Hornbeam Icon meshes white).
6. Fidelity baseline: `check`, then `update` (ratchet) after every sweep.
7. Final sharded sweep, sheets read by eye, sheets published to `pr36-assets` and linked from the follow-up PR.
8. `npm run build`, full suite (default workers), `npm run test:leaks`, empty-toolchain run, fresh-eyes review.
9. PRD-537/538 bookkeeping: tick with evidence; move to `done/` only when AC-6 holds. Open: `ROUTE_PREFERENCE` calibration, AC-5 live Hornbeam run, AC-7 parity half, AC-3, PRD-538 AC-4, AC-9 delivery to the sandbox remote.
10. Owner actions: npm publish, engine pin bump (`threenative-engine/packages/core`), Epic-source provenance decision, forest screenshot asset names, Fab licence check (`FAB_BROWSER_HEADLESS=0`) or `--assume-licence` decision.
11. Cleanup: `.worktrees/*` and merged local branches (arm/*, base/*, fix/sweep-*, worktree-agent-*, merge/*), `toolchain-m-*`, `parity-m-*`, `parity-tmp`, named `fab-downloads` dirs, `/tmp/arm-*`; keep `*-assets` branches. Commit or archive the `.afk/2026-10-08-fidelity-sweep.md` log (D-night-1..11).

## 8. Follow-up verification (2026-10-10, restricted session)

- Verified local checkout state: `nodes` is at `15b739c`, importer 89; local `main` is at `29c2f3f`, importer 53. The merge statement above does not establish that the local `main` checkout contains the follow-up work. Checks below ran in `nodes`.
- `npm run typecheck` and `npm run build`: passed.
- Spruce IN2 and Paragon S10: their saved directories contain startup logs and empty `packs/` directories, with no completed reports, metadata or sheets. Neither pending run can count as verification; both need a new completed run.
- Spruce IN metadata replay: 4/4 tests passed. Replay of all 98 cached metadata dumps: 99/101 tests passed (includes the synthetic tests and dump-presence test); the two failing dumps are older Old West captures. Their changes remove the emissive placeholder and add its limitation, matching importer 88 commit `631485e`. Do not rewrite those historical expectations to manufacture a green replay. Log: `/tmp/importer89-metadata-replay.log`.
- Saved `parity-ac6` baseline check: 31 packs checked, 6 with a baseline, 4 regressions (Landscape mean/worst fidelity; KUBIKOS mean fidelity/failing tiles). This is an older sweep, not evidence about importer 89. Baseline was not updated. Log: `/tmp/importer89-baseline.log`.
- Full default-worker suite was attempted, reported integration failures and was interrupted; it is **not a passing gate**. Isolated investigation proved that spawning a generated `/tmp/umodel` fixture returns `EPERM` in this sandbox. The resulting empty listing explains the isolated import failure. Logs: `/tmp/importer89-full-suite.log`, `/tmp/importer89-isolated.log`.
- Focused material/graph/metadata/baseline run: 184 tests passed, 22 effect-material integration tests failed, five files passed and one failed. The importer 89 branch-selection integration checks remain unverified under the same executable restriction. Log: `/tmp/importer89-focused.log`.
- Cheap read worker could not return findings under this session's network restrictions; direct connectivity check failed to resolve `api.anthropic.com`. Worker was interrupted. No implementation changes, gate relaxations, baseline ratchets, publication or cleanup of pack caches were performed.
- Next: restore worker network access and fixture execution, complete IN2/S10, then resume section 7 in order. Build/replay evidence above does not close AC-6 or any final-head sweep/visual gate.

## 9. Follow-up execution (2026-10-10, unrestricted session)

- Working in the existing isolated `nodes` worktree, on follow-up branch `fix/importer-remaining`, starting at `15b739c` (importer 89). GitHub confirms PR #36 merged as `31db1b5`; the root checkout is stale. Integrate `origin/main` before final-head verification, since the PR #4 merge is absent from this starting branch.
- Connectivity to `api.anthropic.com` and Fab works. FabCLI reports authenticated, but its Fab session needs refresh. Read workers returned through `$save-tokens`; implementation and diagnosis remain delegated through that skill for bounded work.
- `npm test` built successfully and completed with default workers: **1191 passed, 3 skipped, 1 failed** across 96 files. Failure: `tests/unreal-parity-run.test.ts:653`, emergency SIGTERM cleanup leaves the shell PID observable as alive. This is not a passing gate. Log: `/tmp/importer-remaining-baseline.log`. A bounded cheap coding worker is investigating the cause; no assertion weakening or timing sleeps authorized.
- **Spruce IN2 has now completed**, superseding section 8's snapshot. Run `20261010T165803-b9d680`, importer 89: S4 fails, **2421/4248 coloured sections**; unsupported `HeightLerp` on 1827 sections and `SmoothThreshold` on 48. Texture proof: 67/67. Local evidence: `~/.cache/threenative-asset-mcp/parity-m-IN2-interactd68b8eae94a6V4/`.
- **Visual judge plus eyes:** inspected `sheets/f8044501-interactd68b8eae94a6V4.jpg` (12 sampled meshes of 43; judge 5 ok / 2 suspect / 5 fail). Winter foliage is brown and forms solid cards, winter small trees have excessive solid coverage, summer full trees retain solid cards, and several branches are pale. Some green-rated summer tiles are visibly wrong. Importer 89's switch-binding change is therefore **not visually verified as fixed**; keep the defects open and investigate the saved report/metadata before another import.
- **Paragon S10 remains live**, verified via PID 2603071 on this session; run `20261010T161322-7f1cf7`, output `~/.cache/threenative-asset-mcp/parity-m-S10-ParagonProps/`. No completed pack report yet. Do not restart or delete its output/downloads merely because the startup log has not advanced. Revalidate the live process before any subsequent wait or restart decision.
- No fidelity baseline ratchet, gate relaxation, publication, pack-cache deletion or release performed. Final sweep, visual fixes and owner actions remain open.
- Spruce IN2 metadata replay: **4/4 passed**, log `/tmp/importer-remaining-spruce-replay.log`. Fidelity check: **1 pack checked, 0 with a baseline, 0 regressions**, log `/tmp/importer-remaining-spruce-baseline.log`; this supplies no regression comparison, so no baseline was ratcheted.
- Inspected the saved Hornbeam UE5 sheet at `parity-m-S2-MS_Hornbeam_UE51_V2/sheets/c6f917b6-MS_Hornbeam_UE51_V2.jpg`: importer **85**, four sampled icon meshes, judge **0 ok / 0 suspect / 4 fail**. Eyes confirm white imports against green/red/blue source thumbnails (`Icon_Base`, `Icon_Arrow`, `Icon_Sock`, `Icon_Arrow_Test`). This is a visual red reference, not final-head verification. A bounded `$save-tokens` coding worker is implementing vertex-colour export in separate worktree `.worktrees/importer-vertex-colours`, based on `origin/main` (`31db1b5`). Review its diff, integrate coherently, then re-import and judge Hornbeam on the final head before claiming a visual fix.
- Integrated `origin/main` locally as `b1a3149`, superseding the starting-branch caveat above. The cleanup regression was a test liveness probe counting exited Linux zombie/dead tasks as live; the worker demonstrated a deterministic red test and corrected the test helper without changing product cleanup or the existing shutdown assertions. Parent reviewed the final diff and verified **1265 passed / 3 skipped** with default workers, typecheck, **leak-gate clean** (also 1265 passed / 3 skipped), and **packed-MCP smoke 15/15 passed**. Logs: `/tmp/importer-remaining-{integrated-suite,typecheck,leaks,smoke}.log`. These prove the cleanup patch on importer 89; rerun appropriate gates after subsequent importer changes. Empty-toolchain verification and final fresh-eyes review remain open.
