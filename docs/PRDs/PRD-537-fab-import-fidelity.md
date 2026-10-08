# PRD-537 — Fab Unreal imports match their source packs for most of the library

**Status:** IN PROGRESS
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

## Execution Phases

#### Phase 1: Fresh host works, and the corpus has a baseline score
**Status:** IN PROGRESS
**Files:** `src/unreal/provision.ts` (FabCLI archive lookup — done; i386 detection and precise SDL2 error), `src/unreal/cue4parse-adapter.ts` (property-dump mode: mesh bounds/slots, MI overrides, parent chain), `scripts/fab-parity.ts` (new: corpus walk, S1–S4, contact sheet, per-pack cleanup), `package.json` (`parity:fab`), `.gitignore` (`artifacts/parity/`).
**Implementation:** The corpus comes from `fab_list_owned --unrealOnly` with a size cap. The script runs each artifact through the real `fab_import_asset` handler, not `importUnrealDirectory`, so download and selection are exercised. On FabCLI auth/download errors it stops and reports, rather than continuing.
- [x] AC-1 [local]: FabCLI installs on a fresh host from the current release archive. proof: `ensureFabcli` run on this host — installed `~/.cache/threenative-asset-mcp/toolchain/fabcli/fabcli`, `fabcli 0.1.0`; fix in `src/unreal/provision.ts` (`findArchiveEntry`).
- [x] AC-2 [local]: On a 64-bit-only Debian host, UE Viewer either provisions or fails with one error naming the missing package. It skips the i386 prebuilt when no i386 loader exists. proof: `ensureUmodel` run on this host from an empty cache — logged "prebuilt is 32-bit and this host has no i386 loader; building from source", built `Compiled Oct  7 2026 (build 1)`; `npx vitest run tests/unreal-toolchain-hygiene.test.ts` — 7 passed (`umodelBuildFailure` maps `png.h`→`libpng-dev`, `SDL2/SDL.h`→`libsdl2-dev`). 2026-10-07.
- [ ] AC-3 [local]: `npm run parity:fab` scores every corpus pack into `artifacts/parity/scorecard.json`, marking unreadable ones `unverified`. proof: `npm run parity:fab -- --corpus library` — Evidence: pending.
- [ ] AC-7 [local]: Neither `npm test` nor a parity run leaves files in `/tmp` or the Fab download root (only `artifacts/parity/` remains). proof: before/after `ls /tmp ~/.cache/threenative-asset-mcp/fab-downloads` diff — Evidence: test-suite half met (PRD-539 AC-1: isolated `TMPDIR` run left only `node-compile-cache`); parity-run half pending.

**Verification:** the boxes above; record the baseline AC-6 numbers on the PRD.

#### Phase 2: Material instances use their own textures
**Status:** NOT STARTED
**Files:** `src/unreal/materials.ts`, `tests/unreal-import.integration.test.ts` (fixture `.mat`/`.props.txt` pair shaped like `MI_Cave_Rock_Pillar`: parent default in the `.mat`, instance override in `TextureParameterValues`).
**Implementation:** First check what PR #23 already changes: it adds legacy instance flag handling and a tagged-package reader that may already expose `TextureParameterValues`. Build on it rather than adding a parallel path. While walking the parent chain, record each parent's `CollectedTextureParameters` name → texture. A `.mat` slot whose texture equals a parent default for parameter *P*, where the instance overrides *P*, takes the override with `confidence: "exact"`. A packed-mask override still goes through the existing mask detector and is never painted as base colour.
- [ ] AC-4 [local]: Soul Cave scores 0 S3 violations: `MI_Cave_Rock_Pillar` binds `T_Cave_Rock_Pillar_N` and no `T_Cave_Rock_Stalactite_*`. proof: `npm run parity:fab -- --listing 75f42402-40bb-4a1b-b557-18e2c9604273` — Evidence: pending.
- [ ] AC-9 [local]: The committed Soul Cave import in `threenative-sandbox/soul-cave/assets/fab/soul-cave/` is regenerated with the fixed importer, so the game stops shipping the parent-default textures. proof: its `import-report.json` shows `importer.version` ≥ the fix and 0 sections binding `T_Cave_Rock_Stalactite_*` outside the stalactite materials — Evidence: pending.

**Verification:** Fixture test red → green; AC-4 on the live pack; parity rerun shows no S3 regression on other packs.

#### Phase 3: The importer picks the artifact, and the corpus clears the bar
**Status:** NOT STARTED
**Files:** `src/fab/fabcli.ts` (`selectVersion` route preference), `src/tools/import-unreal.ts` (`fab_list_owned` artifact list; report which artifact was chosen and why), `tests/fab-import.integration.test.ts`.
**Implementation:** Route preference comes from the phase-1/2 scorecard. An explicit `engine` still wins, and the choice plus its reason go in `warnings`. Then fix the highest-count remaining S1–S3 failure classes from the scorecard until AC-6 holds. Each fix gets a fixture test and is listed here as it lands.
- [ ] AC-5 [local]: `fab_import_asset` without `engine` imports a multi-route listing through the best-scoring route and reports the choice in `warnings`. proof: `npx vitest run tests/fab-import.integration.test.ts` + live run on European Hornbeam (`c6f917b6-…`) — Evidence: pending.
- [ ] AC-8 [local]: `fab_list_owned` lists each artifact separately with its source engine and decoder route. proof: `npx vitest run tests/fab-import.integration.test.ts` — Evidence: pending.
- [ ] AC-6 [local]: ≥ 85 % of scored corpus packs pass S1–S3 with S4 ≥ 90 %. proof: `artifacts/parity/scorecard.json` summary line — Evidence: baseline pending; final pending.

**Verification:** the boxes above.
