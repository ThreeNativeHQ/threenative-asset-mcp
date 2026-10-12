# PRD-critical-texture-regressions — Finish texture regression protection

**Status:** DONE — implementation, real-asset proof, repository checks and required CI pass; PR #41 merged 2026-10-12 as `5715b56`.
**Priority:** P0 — prevent the known chair/crate texture-resolution regression from recurring.
**Complexity:** 3 (LOW) — 1–5 implementation files and the TypeScript/generated .NET boundary; no new subsystem.
**Owner:** João / next coding session
**Depends on:** Existing importer112 checkpoint; does not require PRD-537/538 corpus completion.
**Time box:** 2–3 hours of execution from session restart.
**PR:** https://github.com/ThreeNativeHQ/threenative-asset-mcp/pull/41 (against `main`; PR40 is merged historical evidence).

## Goal and scope

Finish the known editor-thumbnail-as-source texture defect through the real import path, protect it with meaningful regression tests, and show the restored chair/crate textures. This is the user's explicitly narrowed goal (2026-10-11), not completion of the original corpus/material-parity project.

Work in this owning checkout: `/home/joao/projects/threenative/threenative-asset-mcp/.worktrees/nodes` (branch `fix/importer-remaining`). Reuse the existing native repair lane below; do not create another lane for the same task. Use Sonnet5.5high for bounded coding/review if delegation is needed. Haiku's weekly cap was reached; do not retry or bypass it. DeepSeek is authorized only for cleanup, not source work. No polling loops or repeated broad exploration.

## Existing evidence — reuse, do not rediscover

Importer112 commit `8798545` prefers full-resolution standalone exports over inline native previews while preserving ambiguous-name collision behavior. Its production-import tests went red before the fix and green afterward. Existing checkpoint: 2,409 tests passed, five licensed-input skips, typecheck/build and six CI checks passed. Those results apply to that head, not future edits.

Real OldWestV614097b70135V2 chair04a/crate01a proof already exists: same source closure, native78, geometry and render settings; importer110 embedded 256×256 albedo/normal previews, importer112 embeds 4096×4096 source exports. Root visually inspected the restored wood grain/weathering. Full shading parity and normal green convention remain unverified.

- Local licensed source/proof: `/home/joao/.cache/threenative-asset-mcp/crate112-proof-SYtqCKvK` (`src`, `out-base`, `out-new`, `glb-proof.json`, render artifacts).
- Existing screenshot: https://raw.githubusercontent.com/ThreeNativeHQ/threenative-asset-mcp/1be382ed3e11003b4ea00030ae509844a68e2279/importer-followup/2026-10-11-i112-chair-crate/texture-before-after.jpg
- Existing PR progress comment: https://github.com/ThreeNativeHQ/threenative-asset-mcp/pull/40#issuecomment-6114578368

## Solution and integration

Consumer flow: Fab/importUnrealDirectory → native texture extraction in `src/unreal/cue4parse-adapter.ts` → importer texture selection → embedded GLB textures → preview renderer. Exclude only PNG byte ranges proven to be registered package thumbnails. A matching width/height/length prefix or a resolution threshold is insufficient provenance. Keep decoded source-payload scanning unrestricted and preserve genuine small images, albedo pixels and normal data. If authentic source art cannot be recovered, report the failure explicitly.

Affected boundaries: native material/standalone extraction and its sprite/font/sheet callers; importer/cache version pins if changed; fixture helpers and converter/source/import tests. Reuse existing production converter compilation and import fixtures; add no dependencies or broad material features. Native78 and the shared SDK/runtime are read-only inputs; build a changed converter in owned scratch.

#### Phase 1: Complete native source provenance hardening
**Status:** COMPLETE

- [x] Registered editor previews cannot become source art through the compiled production converter. proof: `npx vitest run tests/unreal-native-texture-source.test.ts`; demonstrate red before correction, green afterward; cover thumbnail-only refusal plus authentic compressed-source recovery.
- [x] Genuine small/unregistered source images and normal/albedo pixels survive unchanged. proof: `npx vitest run tests/unreal-native-texture-source.test.ts tests/unreal-texture-resolution.integration.test.ts`; controls include matching-prefix images outside the thumbnail table plus inside decoded payloads.

#### Phase 2: Prove the user's chair and crate on the final head
**Status:** COMPLETE — source-equivalent final production inputs; comparison attached to PR41

- [x] Final-head real chair04a/crate01a GLBs embed authentic full-resolution albedo/normal textures. proof: rerun the existing local canary against `crate112-proof-SYtqCKvK/src`, compare embedded dimensions/raw pixels to source exports and retain unchanged geometry assertions in its GLB proof.
- [x] The new PR shows both assets before/after with identical camera/environment settings and visibly restored texture detail. proof: actual final-head rendered comparisons in the new PR; reuse the published PR40 sheet only if its production/render inputs are unchanged.

#### Phase 3: Integrate and verify
**Status:** COMPLETE — local checks pass; required CI passed on PR #41 head `1707f4e` (2026-10-12).

- [x] The integrated final head passes repository checks. proof: `npm run typecheck`, `npm test` (builds first, default workers), `npm run test:leaks`, and `npx vitest run tests/mcp-smoke.test.ts`; avoid repeating equivalent runs when the existing command already proves the requirement.
- [x] Required CI checks pass on the exact pushed new PR head. proof: new PR checks with matching head SHA. Record results/limits in the existing PR/PRD, without standalone verification reports. Evidence: PR #41 head `1707f4e` passed Verify (Node 20.19.0), Verify (Node 24.x), parallel, leak-gate (run 38199243761) and Provision from an empty cache (Debian 13) (run 38199243762); merged 2026-10-12 as `5715b56`.

## Acceptance criteria

- [x] The user can inspect final-head texture restoration for both named assets. proof: Phase 2 GLB/source assertions and the chair/crate screenshot attached to the new PR.
- [x] Producer and real importer regression tests cover the preview-selection defect without rejecting legitimate small source textures. proof: Phase 1 red/green results, backed by final-head checks from Phase 3.

## Resume the existing lane first

At handoff, Sonnet5.5high worker process3278418 was active in `.worktrees/importer-native-texture-source`, branch `fix/native-texture-source`, based on8798545. Claude session: `4278a16f-22ee-4f32-9fd5-617a2a9400c6`; old tool handle84784 may not survive a fresh session. Revalidate actual process/checkout before continuing; a missing observation handle is not proof the worker stopped. Last observed edits: PRD538 and `tests/helpers/unreal-material-source.ts`; these are unfinished work, not a passing fix.

Brief: `/tmp/importer-native-texture-source-brief.txt`. Result: `/tmp/importer-native-source-result.txt`. Current log: `/tmp/importer-native-source-worker-reviewed.jsonl`. Read the compact result and diff first. The revised design requires the package's actual `ThumbnailTableOffset` entries to establish excluded byte ranges; the earlier guessed 12-byte-prefix filter was rejected.

Protected native78 toolchain: `/home/joao/.cache/threenative-asset-mcp/editorrgba16f78-hQyDpCVI/toolchain`. Reuse its SDK read-only; tests previously needed `THREENATIVE_TOOLCHAIN_DIR` pointing there to avoid unrelated custom-version failures. Revalidate suitability for any newly built converter rather than silently using native78 to claim new producer coverage.

## Decisions and limits

João requested a few-hour, token-conscious replacement scope on2026-10-11. Defer the 86 runnable variants, 24 UIDless variants, paired bake-off, full material/shading parity, historical converter rebuilds and separate Medieval retry/timeout repair. PRD537/538 remain incomplete. The broad sweep and its owned CLI were gracefully interrupted and confirmed stopped; do not restart them. Preserve licensed local evidence; never commit source pack contents.

Do not merge, release, ratchet acceptance baselines, weaken tests or expand scope. At the time-box boundary, leave failing boxes open, name the exact blocker and hand off; importer112's existing fix is a fallback deliverable, not proof this hardening PRD is complete. Do not repeat the failed historical bisect: no good-to-bad boundary was established.

## Blocked on

None established. Check the existing worker's actual result before asserting a source-provenance blocker.

## Resume progress (2026-10-11)

Confirmed process3278418 is still running in the original repair lane and reviewed its current diff. The implementation now excludes PNG ranges referenced by the actual package thumbnail table; decoded compressed-payload scanning remains unrestricted. Added compiled-converter cases cover preview-only refusal, source recovery, smaller normal/albedo sources, and unregistered matching-prefix controls. These edits remain uncommitted and unverified; wait for the existing worker's result before integration. No duplicate worker or worktree was started.

The original worker subsequently stopped while its focused test child remained live. That child completed successfully: five files, 146 tests passed using the protected native78 libraries to compile the changed production converter (`/tmp/importer-native-source-green.log`, exit0). The old-converter regression run failed seven tests, with four controls passing (`/tmp/importer-native-source-red.log`, exit1). Resumed the same Sonnet session in the same repair lane with `/tmp/critical-texture-resume-brief.txt`; output `/tmp/critical-texture-resume-worker.jsonl`. Review follow-up covers damaged/large thumbnail tables, ownerless extraction paths and decoded-pixel assertions, then native79 real-asset proof. Integration, full checks, final-head render proof and CI remain pending.

Final source review: native79/importer113 passes 15 compiled-converter source tests, 13 consumer/diagnostic tests and typecheck. Prior focused runs passed 149 converter and 452 importer tests. Genuine LZ4 fixtures contain no raw source PNG signature: removing preview exclusion returns the preview, disabling the decoder returns no source, and the unchanged final adapter recovers exact source pixels. RED logs: `/tmp/importer-native-source-red4.log`, `red5.log`; GREEN: `/tmp/importer-native-source-green5.log`.

Real candidate proof: `/home/joao/.cache/threenative-asset-mcp/native79-iqopBvdy/canary/out2`. Both assets embed 4096×4096 albedo/normal pixels equal to standalone exports, with unchanged geometry. The complete chair GLB SHA256 is `ac8502c97a686e62742b09e643daec6855ce2d0d902ef6fd729d1c35f08cb834`; crate is `ed59194e4d04bd1d98c731abb8ccd2f462fe6d873a1156cf33bbdfa6ec2f5212`. Both exactly match importer112 render inputs, so the published sheet can be reused with its original label explained.

Delivery uses the existing repair lane `.worktrees/importer-native-texture-source`, branch `fix/native-texture-source`. PR40 merged at `3f4c114`; its tree equals the lane's starting `8798545` tree. Rebase only this change onto current `origin/main` for a separate PR. No merge or release authorized. Laptop offload status failed SSH host-key verification; repository checks will run locally. Preserve both current worktrees and licensed proof data while delivery is pending.

Local final code verification at `d6134a9ae9343b583d2c612e4c0337dd0f26a959`: `npm run typecheck` exit0; `npm test` exit0 (build first, default workers: 2,425 passed, five licensed-input skips); `npm run test:leaks` exit0 (same 2,425 passed, five skips; `leak-gate: clean`); `npx vitest run tests/mcp-smoke.test.ts` exit0 (15 passed). Logs: `/tmp/critical-texture-{typecheck,test,leaks,smoke}.log`. Used owned native79 toolchain with auto-install disabled; protected native78 inputs retained. Source/tests unchanged by the subsequent PRD-only evidence commit.

New PR41 contains the published comparison and full-GLB hash justification for reusing it. The repair checkout is retained (14 MB measured, without dereferencing links) and PR41 merged 2026-10-12 (`5715b56`); removing that checkout is a separate step. The original nodes checkout contains the requested PRD and other existing work; no checkout or licensed evidence was deleted. No merge, publish, baseline ratchet, broad corpus sweep or engine-pin change performed. Required CI passed on PR #41 head `1707f4e`; no gate remains open.
