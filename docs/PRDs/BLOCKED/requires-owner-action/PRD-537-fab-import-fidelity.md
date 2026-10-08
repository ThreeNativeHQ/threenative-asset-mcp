# PRD-537 — Fab Unreal imports match their source packs for most of the library

**Status:** PARTIAL — Phases 1–3 code and fixture/fake-FabCLI tests landed (PR #25); the corpus sweep (AC-3, AC-6, live AC-5, parity half of AC-7) has not run.
**Blocker:** João clears Fab's browser verification (run the MCP or `fab-parity` once with `FAB_BROWSER_HEADLESS=0` and solve the challenge in the dedicated profile) or approves an explicit `--assume-licence` flag for local scoring; see Blocked on.
**Priority:** P1 — `fab_import_asset` is the primary Fab path and today fails outright on a fresh host (AC-1, AC-2) and silently binds the wrong textures on UE Viewer packs (AC-4).
**Complexity:** 5 (MEDIUM) — 6–10 implementation files (2), new parity module (+2), Fab/FabCLI integration (+1); risk override: none
**Owner:** João
**Depends on:** PR #23 (draft, `investigate/unreal-spruce-materials`) touches `materials.ts` and adds a UE4.19 tagged-package reader — land or rebase on it before Phase 2. Follow-ups: PRD-538 (graph-only colour), PRD-539 (tests/CI guardrails).

## Context

**Problem.** Fab packs import, but the result is often not what the listing shows, and nothing
measures how often. Every fix so far (PRs #8–#21) was driven by one pack someone looked at.

**Measured on 2026-10-07** (fresh Debian 13 amd64 host, account `jonitbr`, 48 library items):

- **Fresh-host provisioning fails three ways before any import runs.**
  - FabCLI v0.1.0 now ships its binary under `fabcli-v0.1.0-linux64/`. `provisionFabcli` looked
    only at the archive root and threw "does not run on this host". (Fixed in this PRD; see AC-1.)
  - The UE Viewer Linux prebuilt (`gildor.org/down/47`) is an **i386** ELF and cannot execute on a
    64-bit-only host. The source build then failed: first on `libsdl2-dev`, then on `png.h`
    (`libpng-dev`), which the old error message never mentioned. (Fixed; see AC-2.)
  - `tests/unreal-paper-tilemaps.test.ts` leaked a `tn-tilemap-*` dir into `/tmp` on every run (fixed).
  - FabCLI login was undocumented, and the MCP rightly never logs in. README now has "Fab login for
    owned packs", including the `--manual` flow that reuses the browser's Epic session.
- **Material instances bind their parent's defaults (UE Viewer route).** Soul Cave
  (`75f42402-…`, artifact `SoulCave418`, UE4.18): `MI_Cave_Rock_Pillar` overrides `Mask →
  T_Cave_Rock_Pillar_M` and `MainNormal → T_Cave_Rock_Pillar_N`, confirmed in the `.uasset` name
  table. The shipped import (`threenative-sandbox/soul-cave/assets/fab/soul-cave/import-report.json`)
  bound the parent `M_Cave_Rock_MASTER` defaults instead (`T_Cave_Rock_Stalactite_M` as base colour,
  `T_Cave_Rock_Large_N` as normal). `resolveMaterial` (`src/unreal/materials.ts`) lets the instance's
  `TextureParameterValues` fill only slots that the `.mat` left empty: "They never displace a `.mat`
  slot". UE Viewer writes an instance's `.mat` from its parent when the parameter names are not ones
  it recognises, so the instance never wins. Result: **6 of 21 sections textured**, 15 neutral grey.
- **Some colour lives only in the material graph.** `M_Cave_Rock_MASTER` has no colour texture:
  its BaseColor is mask channels × `Tint`/`RockTint`/`DetailRockTint` vectors through
  `MF_Solid_Color`. No texture binding can reproduce that; it needs graph evaluation (out of scope
  here; see Decisions).
- **Which artifact gets imported is left to chance.** 35 library listings carry an importable
  Unreal artifact. An artifact is stored in the format of the *oldest* engine it lists
  (`SoulCave418` covers 4.18–5.8 but is a 4.18 package), and that version picks the decoder:
  | Decoder route (by artifact's oldest engine) | Listings with only this route | Listings that also offer another |
  |---|---|---|
  | UE Viewer (≤ 4.20) | 15 | 1 |
  | MeshDescription (4.21–4.27) | 3 | 9 |
  | CUE4Parse (UE5) | 8 | 8 |

  For the 9 listings with more than one route, `FabCli.selectVersion` refuses to choose and the
  agent picks an engine string blind. `fab_list_owned` flattens every artifact's versions into one
  list, so the agent cannot even see the artifact boundaries.

**Files inspected:** `src/unreal/provision.ts`, `src/unreal/materials.ts`, `src/unreal/importer.ts`
(routing `uncookedMeshRoute`, 517–522 window), `src/unreal/cue4parse-adapter.ts` (material export),
`src/fab/fabcli.ts` (`selectVersion`, `download`), `src/tools/import-unreal.ts`
(`fab_import_asset`, `fab_list_owned`), both sandbox import reports, the FabCLI library payload.

## Solution

### Parity strategy — what "matches Fab" means, and how it is measured without Unreal Engine

The uncooked package is the specification. Fab's packs are editor assets, so each one carries its
own mesh bounds, material slots, material-instance parameter overrides and parent chain as tagged
properties. **A second, independent decoder reads those as the expected values, and the importer's
GLBs plus `import-report.json` are the actual values.** CUE4Parse, already pinned in
`cue4parse-adapter.ts`, reads tagged properties for UE4.0+ and UE5. It never consults UE Viewer's
`.mat` files, which is the source of the current bug. Because the two decoders are separate code,
the comparison does not degenerate into the importer checking itself.

Per pack, four structural checks. A pack **passes** when S1–S3 hold and S4 ≥ 90 %:

| Check | Expected (CUE4Parse property dump) | Actual (import) | Catches |
|---|---|---|---|
| S1 coverage | every StaticMesh/SkeletalMesh package in the artifact | `exported`, `failed`, `skipped` | dropped meshes, decoder refusals |
| S2 shape | material-slot count; `ExtendedBounds` (cm → m), 1 % tolerance | GLB primitive count, `boundsMetres` | missing sections, scale/axis errors |
| S3 identity | each section's effective parameter set: instance overrides ∪ parent defaults not overridden | every texture bound in the GLB | parent-default leakage (the Soul Cave bug), cross-material collisions |
| S4 colour | section has a colour source (non-normal texture or colour vector in its effective set) | section not on the neutral fallback | grey sections; the share failing only on graph-only colour sizes the follow-up PRD |

The parity script also writes a contact sheet per pack: three.js renders of each GLB beside the
listing's Fab gallery image. It is a review aid only, not a pass criterion, because Fab images are
lit Unreal renders and cannot be pixel-compared.

**Corpus.** The 35 importable library listings above, which cover all three decoder routes. Of
these, 33 are under the 20 GB download cap; City Sample and MetaHumans are excluded by size and
named in the scorecard. A listing with several artifacts is scored once per route.

**No junk.** The parity run downloads into a run-scoped directory under the MCP download root and
imports into a run-scoped temp directory. It deletes both per pack once that pack is scored, unless
`--keep` is passed. Only the scorecard JSON and the contact sheets remain, under the gitignored
`artifacts/parity/`. Nothing from a Fab pack is committed: the packs are licensed, not
redistributable.

### Consumer flow

Agent → `fab_list_owned` (now lists artifacts with their source engine and decoder route) →
`fab_import_asset` without `engine` → `FabCli.selectVersion` picks the best-scoring route →
download → `importUnrealDirectory` → `resolveMaterial` applies instance overrides →
GLB + report.

### Reused components

FabCLI wrapper, toolchain provisioning, the CUE4Parse adapter (gains a property-dump mode), and
`@threenative/playtest` for contact-sheet renders. No data/schema changes beyond additive report
fields.

### Risks

- CUE4Parse property coverage for very old UE4 (≤ 4.10) may be partial. A pack whose expected
  values cannot be read is scored `unverified`, never `pass`.
- Fab or FabCLI changes break downloads. The parity run stops on the first auth/download error
  rather than scoring empty packs.

## Acceptance Criteria

Each criterion is a checkbox in the phase that delivers it: AC-1–AC-3 and AC-7 in Phase 1, AC-4 and AC-9 in Phase 2, AC-5, AC-6 and AC-8 in Phase 3. The PRD is done when all nine are ticked.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| FabCLI provisioning | `fab_import_asset` / `fab_list_owned` → `FabCli.tool()` → `ensureFabcli` → `provisionFabcli` (`src/unreal/provision.ts`) | Root-only lookup replaced by `findArchiveEntry` | AC-1 |
| UE Viewer provisioning | `importUnrealDirectory` → `ensureUmodel` → `provisionUmodel` | i386 prebuilt skipped on hosts that cannot load it | AC-2 |
| Instance override resolution | `importUnrealDirectory` → `resolveMaterial` (`src/unreal/materials.ts`) | Overrides replace parent defaults in `.mat` slots, matched by the parent's parameter name | AC-4 |
| Artifact choice | `fab_import_asset` → `FabCli.selectVersion` (`src/fab/fabcli.ts`); `fab_list_owned` | "Refuse when ambiguous" becomes a route preference derived from AC-6 scores; an explicit `engine` still wins | AC-5, AC-8 |
| Parity scoring | `npm run parity:fab` → `scripts/fab-parity.ts` → `fab_import_asset` handler + CUE4Parse property dump | New; no runtime consumer by design (a dev/CI gate) | AC-3, AC-6, AC-7 |

## Decisions

- 2026-10-07 (Claude, pending João's review): The parity oracle is the package's own tagged
  properties read by CUE4Parse, not Unreal Engine. UE is not on this host, UE source is not
  reachable from this GitHub account, and the host has no NVIDIA GPU. A UE glTF-exporter "golden"
  lane would prove the visual side (baked graph colour) and belongs with the follow-up below.
- 2026-10-07 (Claude, pending João's review): Graph-only colour (mask × tint masters like
  `M_Cave_Rock_MASTER`) is out of scope. It becomes a follow-up PRD, "bake common material graphs
  to PBR textures", sized by how many AC-6 S4 failures it accounts for. This keeps this PRD within
  the 3-phase cap.
- 2026-10-07 (Claude): Nine boxes, one over the usual cap. AC-9, regenerating the sandbox's
  committed Soul Cave import, is the consumer that is actually shipping the bug, so it stays here.
  Splitting it into its own PRD would leave the fix unverified where it matters.

- 2026-10-08 (Claude, João asleep; for sign-off): AC-3, AC-6, the parity half of AC-7 and the live half of AC-5 moved from boxes to Blocked on, and AC-5/AC-7 were split into a ticked part with evidence and a blocked part. They cannot be proven without the Fab licence read, which needs João. The PRD is filed under `done/` because only Blocked-on items remain (the goal's rule).
- 2026-10-08 (Claude): `ROUTE_PREFERENCE` is a prior (cue4parse > mesh-description > umodel; newest format breaks ties), because decoder quality per route could not be measured without the sweep. Calibrate it when AC-6 runs.
- 2026-10-08 (Claude): the three.js contact sheet is not part of the sweep. Old-vs-new renders of Soul Cave were reviewed by hand instead: 7 of 32 meshes changed, every rock and the torso gained correct detail normals, nothing regressed, and rocks stay white because their colour exists only in the material graph (PRD-538). The renders stay local under `artifacts/parity/contact/`.

## Blocked on

All of these wait on one owner action: **João clears Fab's browser verification** (run the MCP or `fab-parity` once with `FAB_BROWSER_HEADLESS=0` and solve the challenge in the dedicated profile) **or approves an explicit `--assume-licence` flag for local scoring of owned packs.** `fab_import_asset` reads each listing's licence anonymously before downloading and Fab answers `FAB_BROWSER_ATTENTION_REQUIRED`; FabCLI exposes no licence field, and one headed attempt passed once and then failed on every later call. No fake licence verdict was injected: that would bypass the project's own guard (Decision, Claude, 2026-10-07).

- **AC-3** `npm run parity:fab` scores every corpus pack into `artifacts/parity/scorecard.json`, marking unreadable ones `unverified`. proof: `npm run parity:fab -- --corpus library`. Built and unit-tested (`scripts/fab-parity.ts`, `src/unreal/parity.ts`, `src/unreal/parity-run.ts`, `src/unreal/property-dump.ts`; `--help` exits 0); the sweep itself has not run. Scored on the one pack available locally instead: Soul Cave (see AC-4).
- **AC-7 (parity half)** A sweep leaves nothing in `/tmp` or the Fab download root. proof: the `LEFTOVER` line of the sweep (all zeros) and a before/after `ls /tmp ~/.cache/threenative-asset-mcp/fab-downloads` diff.
- **AC-5 (live half)** Live run on European Hornbeam (`c6f917b6-…`) picks its best-route artifact and says so in `warnings`; then calibrate `ROUTE_PREFERENCE` (`src/fab/routes.ts`, currently a prior) against the baseline scorecard.
- **AC-6** ≥ 85 % of corpus packs pass S1–S3 with S4 ≥ 90 %, judged on the attempted rate. proof: `artifacts/parity/scorecard.json` summary line. The baseline numbers and the failure-class fixes that follow from them (Phase 3's "fix the top classes" step) need the sweep.

## Execution Phases

#### Phase 1: Fresh host works, and the corpus has a baseline score
**Status:** DONE except the baseline sweep (Blocked on)
**Files:** `src/unreal/provision.ts` (FabCLI archive lookup — done; i386 detection and precise SDL2 error), `src/unreal/cue4parse-adapter.ts` (property-dump mode: mesh bounds/slots, MI overrides, parent chain), `scripts/fab-parity.ts` (new: corpus walk, S1–S4, contact sheet, per-pack cleanup), `package.json` (`parity:fab`), `.gitignore` (`artifacts/parity/`).
**Implementation:** The corpus comes from `fab_list_owned --unrealOnly` with a size cap. The script runs each artifact through the real `fab_import_asset` handler, not `importUnrealDirectory`, so download and selection are exercised. On FabCLI auth/download errors it stops and reports, rather than continuing.
- [x] AC-1 [local]: FabCLI installs on a fresh host from the current release archive. proof: `ensureFabcli` run on this host — installed `~/.cache/threenative-asset-mcp/toolchain/fabcli/fabcli`, `fabcli 0.1.0`; fix in `src/unreal/provision.ts` (`findArchiveEntry`).
- [x] AC-2 [local]: On a 64-bit-only Debian host, UE Viewer either provisions or fails with one error naming the missing package. It skips the i386 prebuilt when no i386 loader exists. proof: `ensureUmodel` run on this host from an empty cache — logged "prebuilt is 32-bit and this host has no i386 loader; building from source", built `Compiled Oct  7 2026 (build 1)`; `npx vitest run tests/unreal-toolchain-hygiene.test.ts` — 7 passed (`umodelBuildFailure` maps `png.h`→`libpng-dev`, `SDL2/SDL.h`→`libsdl2-dev`). 2026-10-07.
- [x] AC-7 [local]: `npm test` leaves no files in `/tmp`. proof: `TMPDIR=$(mktemp -d) npx vitest run` then `ls -A $TMPDIR` — Evidence (2026-10-08, rebased branch, default workers): 598 passed, 2 skipped, 0 failed; only `node-compile-cache` left in `TMPDIR`. The parity-run half (a sweep leaves nothing in `/tmp` or the Fab download root) is split out under Blocked on: the sweep cannot run until the licence check clears. Its cleanup code is in place (run-scoped TMPDIR, unreal staging cache and download root, all removed on exit and on SIGINT/SIGTERM; `tests/unreal-parity-run.test.ts`).

**Verification:** the boxes above; the baseline AC-6 numbers are recorded when the sweep runs (Blocked on).

#### Phase 2: Material instances use their own textures
**Status:** DONE (2026-10-07)
**Files:** `src/unreal/materials.ts`, `tests/unreal-import.integration.test.ts` (fixture `.mat`/`.props.txt` pair shaped like `MI_Cave_Rock_Pillar`: parent default in the `.mat`, instance override in `TextureParameterValues`).
**Implementation:** First check what PR #23 already changes: it adds legacy instance flag handling and a tagged-package reader that may already expose `TextureParameterValues`. Build on it rather than adding a parallel path. While walking the parent chain, record each parent's `CollectedTextureParameters` name → texture. A `.mat` slot whose texture equals a parent default for parameter *P*, where the instance overrides *P*, takes the override with `confidence: "exact"`. A packed-mask override still goes through the existing mask detector and is never painted as base colour.
- [x] AC-4 [local]: Soul Cave scores 0 S3 violations: `MI_Cave_Rock_Pillar` binds `T_Cave_Rock_Pillar_N` and no `T_Cave_Rock_Stalactite_*`. proof: `npm run parity:fab -- --listing 75f42402-40bb-4a1b-b557-18e2c9604273` — Evidence (2026-10-07): the CLI path is blocked by the Fab licence check (see Blocked on), so the same code ran directly: live pack downloaded with FabCLI (601 packages, UE4.18), `dumpUnrealProperties` (173 meshes, 78 instances, 0 package errors) → `importUnrealDirectory` (importer v52, 171/173 meshes) → `scorePack`: **S3 0 violations over 190 verified sections** (13 unverified); the same scorer on the committed sandbox import (importer v1) reports 11 (`MI_Cave_Rock_Pillar` and `MI_Soul_Statue_Torso` bind parent defaults). Note on the wording: the real instance overrides `NRM → T_Cave_Rock_Pillar_N` *and* `MainNormal → T_Cave_Rock_Large_N`, so its normal slot is legitimately `Large_N`; the criterion that holds is zero parent-default leakage. Fixture red→green: `tests/unreal-material-instance-overrides.test.ts` (3 of 5 failed before the fix).
- [x] AC-9 [local]: The committed Soul Cave import in `threenative-sandbox/soul-cave/assets/fab/soul-cave/` is regenerated with the fixed importer, so the game stops shipping the parent-default textures. proof: its `import-report.json` shows `importer.version` ≥ the fix and 0 sections binding `T_Cave_Rock_Stalactite_*` outside the stalactite materials — Evidence (2026-10-07): sandbox commit `40773fe` on local branch `reimport/soul-cave-prd537` (worktree `threenative-sandbox/.worktrees/soul-cave-prd537`): `importer.version` 52, same 32 meshes/GLB paths, 19 of 37 sections textured (was 6 of 21), 0 sections binding `Stalactite` outside stalactite materials. The game's `soul` mask moved to `T_Cave_Statue_Torso_M` (the torso's own; the old import had it wearing `T_Soul_Statue_M`), and every `MASKS` path exists. **Not pushed** (public remote). Game build and playtests not run: its dependencies are not installed here.

**Verification:** Fixture test red → green; AC-4 on the live pack; parity rerun shows no S3 regression on other packs (pending the sweep).

#### Phase 3: The importer picks the artifact, and the corpus clears the bar
**Status:** DONE except the corpus bar and live Hornbeam run (Blocked on)
**Files:** `src/fab/fabcli.ts` (`selectVersion` route preference), `src/tools/import-unreal.ts` (`fab_list_owned` artifact list; report which artifact was chosen and why), `tests/fab-import.integration.test.ts`.
**Implementation:** Route preference comes from the phase-1/2 scorecard. An explicit `engine` still wins, and the choice plus its reason go in `warnings`. Then fix the highest-count remaining S1–S3 failure classes from the scorecard until AC-6 holds. Each fix gets a fixture test and is listed here as it lands.
- [x] AC-5 [local]: `fab_import_asset` without `engine` imports a multi-route listing through the best route and reports the choice in `warnings`. proof: `npx vitest run tests/fab-import.integration.test.ts` — Evidence (2026-10-08): 29 integration tests pass against the fake FabCLI, covering route preference (cue4parse > mesh-description > umodel), newest-format tie-break, the reason sentence in `import-report.json` `warnings`, explicit `engine`/`artifactId` still winning, and the chosen artifact being downloaded by `--artifact-id/--namespace/--asset-id` (the red test failed on the old code because argv carried only `--engine`). The live European Hornbeam run and calibrating `ROUTE_PREFERENCE` against the scorecard are split out under Blocked on.
- [x] AC-8 [local]: `fab_list_owned` lists each artifact separately with its source engine and decoder route. proof: `npx vitest run tests/fab-import.integration.test.ts` — Evidence (2026-10-07): 24+ tests pass incl. the new three-artifact listing (`artifacts[]` with `artifactId`, `engineVersions`, `oldestEngine`, `route`, `targetPlatforms`); README and the tool description updated.

**Verification:** the boxes above.
