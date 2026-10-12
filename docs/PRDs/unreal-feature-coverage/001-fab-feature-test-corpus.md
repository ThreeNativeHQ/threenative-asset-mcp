# PRD-581 — Small Fab test corpus for gameplay, animation and VFX imports

**Status:** DONE — all six acceptance criteria are proved; PR #43 includes the screenshot comment.
**Priority:** P2 — an indispensable prerequisite of PRD-582 and PRD-583 (both P2): neither can prove its outputs on real packs until AC-2 to AC-5 exist.
**Complexity:** 2 (LOW) — 1–5 implementation files (1), Fab/FabCLI external API (+1); risk override: none
**Owner:** João
**Depends on:** None

## Context

PRD-582 (sockets, collision, physics assets, SoundCue), PRD-583 (blend spaces, montages, UE5 clips) and
PRD-584 (Cascade, Niagara) need real Unreal packages. João set two constraints on 2026-10-11:

- **Small.** A full pack in every edit-run loop makes iteration slow.
- **Not redundant.** Use the fewest packs. One pack covers as many classes as it can. A second pack for the
  same class is justified only by a different serialized layout (engine era or data model).

The decoder route matters less than first assumed: CUE4Parse reads every target class on UE 4.19 and UE 5.8
(verified by a probe on 2026-10-11, see PRD-582 Context). So the corpus spans engine eras, not decoder routes.

### Census (2026-10-11)

The library holds 48 entries (37 Unreal content listings after the two claims below). Each listing's
oldest artifact manifest was read from Epic's CDN without downloading content. Counts from file names are
hints. Counts marked "name table" come from scanning `\0Class\0` in the package headers on disk.

| Listing (UID prefix) | Engine | Download | Classes |
|---|---|---|---|
| Animation Starter Pack, Epic (`98ff449d`, artifact `AnimStarterPack`) | 4.4 | 9 MiB | File names: BlendSpace 2 (`R_*`), PhysicsAsset 1, Skeleton 1, AnimBP 1, 62 sequences. The `Aim_Space_*` files are `AnimSequence` packages, so 4.4 has no `AimOffsetBlendSpace` (recorded gap) |
| ROG Creatures: Stickman (`d36ddd1b`) | 4.22 | 174 MiB | File names: PhysicsAsset 1, BlendSpace 1, Montage 6, AnimBP 1 |
| Soul: Cave (`75f42402`) | 4.18 | 1068 MiB | File names: Cascade 21 (`P_*`, `PGPU_*`), SoundCue 2; static meshes with collision |
| Game Animation Sample (`880e319a`, artifact 5.8 on disk from the parity sweep) | 5.8 | 7.0 GiB on disk | Name table: SoundCue 6, AnimMontage 189, BlendSpace 17, BlendSpace1D 6, PhysicsAsset 41, SkeletalBodySetup 17, PhysicsConstraintTemplate 16, SkeletalMeshSocket 6, PoseAsset 136; no Cascade or Niagara |
| Free Sci-Fi VTOL Dust & Engine Vapor FX (`03152868`) | 5.4 | 4 MiB | File names: Niagara 3 (CPU emitters per the listing) |

Considered and not chosen, to avoid redundancy or size:

- Sci-Fi Creatures (855 MiB, UE5 Cascade 3, SoundCue 2): Cascade has the same class model in UE5, and Game Animation Sample covers UE5 SoundCue.
- Animal Variety Pack (482 MiB, 4.15 physics assets): fallback only, if Animation Starter Pack has no socket.
- The Spruce pack (on disk, 4.19 mannequin): between the 4.4 and 4.22 slices.
- Paragon Agora (14.9 GiB), Downtown West (11 GiB), Medieval Village (21 GiB), City Sample (88 GiB): too large.
- Lyra, Stack O Bot, Paragon: Shinbi, Anime Stars VFX: redundant with the rows above.

## Solution

1. **Census script.** Commit the scratch manifest reader as `scripts/fab-census.ts`. For each owned listing,
   it lists the file names and the download size from the Epic manifest, without downloading content.
   - Binary manifests have magic `0x44BEC00C` and zlib data.
   - JSON manifests store sizes as 3-digit decimal byte strings.

   It writes its report to `--out`, never into the repo, because pack names and paths stay local (`AGENTS.md`).
2. **Slices.** Download each chosen artifact once with `fabcli download --into-empty`. Then copy only the
   packages the feature PRDs need into `~/.cache/threenative-asset-mcp/fab-slices/<slice-id>/`. Add their
   dependencies from the package import table, closed under recursion and limited to the pack.
   - A slice keeps the pack's directory layout, so `asset_import_unreal` takes it as an ordinary `sourceDir`.
   - Delete the full download afterwards.
3. **Corpus record.** `docs/parity/feature-corpus.json` holds identifiers and numbers only:
   - slice id, listing UID, artifact id and engine version;
   - target classes with confirmed counts;
   - package count, bytes, and a digest of the sorted package list.

   It holds no asset names.
4. **Corpus test.** `tests/fab-feature-corpus.test.ts` runs `asset_import_unreal` on each slice and checks
   the feature outputs each PRD declares. It skips without `FAB_FEATURE_CORPUS_DIR`, like
   `tests/fab-metadata.test.ts`. PRD-582, PRD-583 and PRD-584 add their assertions to this one file.

## Acceptance Criteria

- [x] AC-1 [local]: `npx tsx scripts/fab-census.ts --out <dir>` reports every owned Unreal listing with download MiB and class-hint counts, and downloads no content. proof: run on the owner's library — Evidence: `npx tsx scripts/fab-census.ts --out /tmp/opencode/fabcensus/out` ran on 2026-10-12 over 37 Unreal listings (167,506 files, 195,016.9 MiB) and wrote `/tmp/opencode/fabcensus/out/fab-census.json`; no content downloaded.
- [x] AC-2 [local]: Each coverage-matrix class is either confirmed present in its slice or recorded as a gap in `docs/parity/feature-corpus.json`. The recorded `classCounts` are **package counts from name-table membership (presence), never object or export counts**. proof: `npx tsx scripts/fab-slice.ts verify` — Evidence: all six recorded slices pass strict verification. Full-source scans of Stickman (42 `.uasset` files) and Game Animation Sample (3,890 `.uasset` files) found zero `AimOffsetBlendSpace` and `AimOffsetBlendSpace1D` classes. Both targets and gaps are now explicit for those slices and the public `verify --record` command passes at 230.1 MiB.
- [x] AC-3 [local]: Each slice imports through `asset_import_unreal` with the same per-package result (converted, skipped, failed, with reasons) as its full pack, so slicing drops no dependency. proof: `npx tsx scripts/fab-slice.ts compare-full <slice-id>` for each slice — Evidence: all six public importer-114 comparisons pass using an isolated genuine converter-79 toolchain: `anim-starter-4.4` (20 packages), `stickman-4.22` (15), `soul-cave-4.18` (13), `vtol-5.4` (6), `game-anim-5.8` (137), and optional `game-anim-5.4` (14). All 205 selected package outcomes match, with zero differences or packages absent on both sides. Known source-root names in otherwise identical diagnostic paths are normalized; substantive reasons remain compared.
- [x] AC-4 [local]: All slices together use at most 1 GiB on disk, including each package's `.uexp`/`.ubulk`/`.uptnl` sidecars. proof: `npx tsx scripts/fab-slice.ts verify --record` — Evidence: 241,292,991 bytes (230.1 MiB) across six verified slices. The optional MetaHuman 5.0 experiment was not recorded: its conservative closure exceeds the cap.
- [x] AC-5 [local]: `FAB_FEATURE_CORPUS_DIR=~/.cache/threenative-asset-mcp/fab-slices npx vitest run tests/fab-feature-corpus.test.ts` imports every slice and passes. Without the variable, it skips and reports why. proof: both runs — Evidence: the final six-slice environment-enabled run passes all 33 tests in 183.8 seconds with the isolated converter-79 toolchain. Without the variable, the focused cooking/corpus run passes 66 tests and skips only the licensed corpus test with its stated reason.
- [x] AC-6 [local]: Every PR attaches before/after sheets per the epic `README.md` evidence rule. Each slice's import is rendered beside the full pack's import of the same pieces, and the judge reports identical results, so slicing changes nothing visible. proof: [PR #43 screenshot comment](https://github.com/ThreeNativeHQ/threenative-asset-mcp/pull/43#issuecomment-6120493778) — Evidence: six published PNGs compare baseline `1b64369b`, current slice and current full at implementation `901c1ed`, using production `renderTiles`. All eight shown model rows have identical neutral judge results across all columns; the procedural picture environment is labeled as an approximation. The Niagara-only slice has zero models at this PR and gets an honest status screenshot; its particle preview belongs to PRD-584. Every final PNG was inspected by eye. Earlier stale sheets are excluded.

### Coverage matrix

| Class group | UE4 early (4.4) | UE4 late (4.18–4.22) | UE5 (5.4–5.8) |
|---|---|---|---|
| Sockets | Animation Starter Pack (gap: no socket-bearing mesh) | Stickman (gap: no `SkeletalMeshSocket`) | Game Animation Sample (40 on one skeleton) |
| PhysicsAsset, constraints | Animation Starter Pack | Stickman | Game Animation Sample |
| StaticMesh simple collision | none | Soul: Cave | Game Animation Sample |
| SoundCue | none | Soul: Cave | Game Animation Sample |
| BlendSpace, AimOffset | Animation Starter Pack (BlendSpace; AimOffset gap, `Aim_Space_*` are AnimSequence) | Stickman (BlendSpace/1D; no AimOffset) | Game Animation Sample (BlendSpace/1D; AimOffset gap) |
| Montage, notifies | none | Stickman | Game Animation Sample |
| PoseAsset | none | none | Game Animation Sample |
| Cascade | none | Soul: Cave | gap accepted (same class model as UE4) |
| Niagara | not applicable | gap accepted (no small pack) | VTOL Dust |

An empty cell is a recorded gap, not a hidden one. Fill it only when a small pack appears.

## Decisions

- 2026-10-11 (João): keep the corpus small and free of redundancy. João claimed VTOL Dust and Animation Starter Pack for the Niagara and early-UE4 animation gaps.
- 2026-10-11 (agent): drop Sci-Fi Creatures, Animal Variety and Spruce from the corpus (redundant, see Context). Keep the Game Animation Sample 5.8 artifact already on disk instead of downloading the 5.4 one. PRD-583 may add a small 5.4 clip slice if UE5 clip export needs the 5.0–5.5 data model.
- 2026-10-11 (agent): register the optional sixth slice `game-anim-5.4` (listing `880e319a-a59e-4ed2-b268-b32dac7fa016`, artifact `GameAnimationSample_5.4`, engine `UE_5.4`, full pack at `/home/joao/.cache/threenative-asset-mcp/fab-downloads/prd583-20261011/game-animation-5.4`). Target classes `AnimSequence`, `SkeletalMesh`, `Skeleton`; seed is one aim-offset clip and the two UEFN mannequin meshes, closure kept minimal. It stays optional: strict `verify` still requires only the five matrix slices until it is built and recorded. Built and verified on 2026-10-12, as recorded below.
- 2026-10-11 (agent): selection correctness. A class's representatives are now counted from its **eligible pool** — the exact primary-class matches when any exist, else the name-table members — so a dependency that a closure merely pulls in and that only imports the class can no longer stand in for a representative (`selectSlicePackages`, `covers`). Name-table fallback stays for a UE5 package with no parsed primary class. Test: 3 exact `NiagaraSystem` packages plus a dependency that names the class. Corpus re-sliced: `anim-starter-4.4`, `stickman-4.22`, `soul-cave-4.18` and `game-anim-5.8` reproduce byte-identical slices; `vtol-5.4` rebuilt at `--per-class 3` now holds the pack's three real `NS_*` Niagara systems (the `DustFX.umap` that only names the class is not selected). `game-anim-5.8` full-pack re-scan and the optional `game-anim-5.4` were not rebuilt: a concurrent lane held ~20 GiB and the 7 GiB scan aborted with a native heap error twice; their slices are untouched and their recorded entries unchanged.
- 2026-10-12 (agent): PRD-581 native-abort fix. `gameReferencesInHead` decoded the whole arbitrary-binary header as UTF-8 and twice as UTF-16LE, which aborted Node (`double free or corruption`) on `game-anim-5.8` package 45 `Content/MetaHumans/Common/Face/Face_PostProcess_AnimBP.uasset` — deterministic at 129 MiB RSS, so RAM was not the cause. It now searches the raw bytes for each encoding's `/Game/` prefix (`Buffer.indexOf`, any alignment), decodes only the bounded NUL-terminated candidate, and feeds the existing legal-character path scan; a synthetic long-invalid-binary test pins odd offsets and NUL termination. The full 137-package `game-anim-5.8` scan now completes (exit 0). The optional sixth slice `game-anim-5.4` is built from its existing on-disk pack (`--per-class 1`; 14 packages, 10.8 MiB; `AnimSequence` 4, `SkeletalMesh` 2, `Skeleton` 9) and recorded; the corpus is 6 slices, 230.1 MiB.

- 2026-10-12 (agent): retain the six verified 230.1 MiB slices. PRD-583 Phase 1 step 3 requires a minimal 5.4 differential slice only if 5.8 tracks work; otherwise it permits the ASP differential. The new MetaHuman 5.0 corpus experiment is unlanded and exceeds the cap (441 packages, 1,497.7 MiB). Actual conventional 5.0 clip export and moving-frame screenshots are proved separately in PRD-583 from owned local inputs; no dependency is dropped to force the corpus below its limit.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Feature corpus slices | `asset_import_unreal` with a slice directory as `sourceDir` | New. Full packs stay the parity-sweep input (PRD-537). | AC-3, AC-5 |

## Execution Phases

#### Phase 1: Census
**Status:** DONE
**Files:** `scripts/fab-census.ts` (new).
**Implementation:** `fabcli library`, then `fabcli manifest` for each listing's oldest artifact, then fetch and parse the manifest. Report download MiB, file count and class hints per listing. Signed manifest URLs expire, so never store them.
**Verification:** AC-1.

#### Phase 2: Slices, record and corpus test
**Status:** DONE — all six full comparisons, corpus tests and published screenshot proofs pass.
**Files:** `scripts/fab-slice.ts` (new: `make`, `verify`, `compare-full`), `docs/parity/feature-corpus.json` (new), `tests/fab-feature-corpus.test.ts` (new).
**Implementation:**
- Select packages by confirmed class.
- Close dependencies over the import table, using the existing name-table and `umodel -list` helpers (`src/unreal/cooking.ts`, `parseUmodelList` in `src/unreal/importer.ts`).
- Copy the selection, record its digest, and delete the full download.
- `compare-full` imports both trees and diffs the per-package results in `import-report.json`.

**Verification:** AC-2 to AC-6.

Local delivery check (2026-10-12): all six slices pass the public `verify --record` command at 230.1 MiB. Importer version 114 invalidates results made before the shared UE4 header-reader correction. With an isolated converter-79 toolchain, typecheck/build pass, the default-worker leak gate passes 2,479 tests (6 skipped) with no temporary leftovers, and packed-MCP smoke passes 15 tests. All six full-versus-slice comparisons pass with zero differences across 205 selected packages. The environment-enabled corpus test passes 33 assertions, and the six final screenshots are embedded in the PR #43 comment above. CI run 38221064495 passed at implementation `901c1ed`. The earlier shared-toolchain full run is excluded from proof.
