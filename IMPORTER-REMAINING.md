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
