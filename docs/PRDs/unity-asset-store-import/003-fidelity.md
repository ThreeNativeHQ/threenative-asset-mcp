# PRD-617 — Unity import fidelity: references, visual locks and baseline

**Status:** IN PROGRESS (AC-1 to AC-4 done; AC-5 and AC-6 partly, 2026-10-15; the real `R1` render waits for the Unity licence and a Unity licence)
**Priority:** P2 — without AC-1..AC-6, no Unity import result can be measured on the corpus or locked against regression.
**Complexity:** 3 (LOW) — 1–5 implementation files (1), new comparison path (+2); risk override: none
**Owner:** João
**Depends on:** PRD-616

## Context

For Unreal, `scripts/fidelity-sheet.ts` scores an import against the editor thumbnails stored inside each package
(`src/unreal/render-fidelity.ts`, `judgeRender` in `src/unreal/visual-judge.ts:107`). The epic README defines two
Unity references ("Reference images, strongest first"):

- `R1`: a Unity Editor reference render that the agent runs in batch mode once per pack, from a script this PRD writes.
- `R2`: the `<guid>/preview.png` thumbnails inside a `.unitypackage`.

The judge, the tile renderer (`renderTiles`), `image-diff.ts` and `fidelity-baseline.ts` are engine-neutral.
Unity references use their own lighting and camera, so only the camera-robust scores (hue, saturation, silhouette
fill) count. Check `R2` previews for channel order and gamma before the first comparison, as the UE4 red/blue
thumbnail swap taught.

`R1` is controlled: the same orthographic three-quarter camera, a single directional light, a neutral grey background
and linear colour space for every prefab. Because of that, `R1` can also be checked for size: the script writes each
prefab's world bounds, and the import's `sizeMeters` must match them.

## Solution

1. `scripts/unity/ReferenceRender.cs`: an Editor script (menu item and `-executeMethod`) that walks every prefab
   under `Assets/`, frames it with the fixed camera, renders 512 px PNGs and writes `bounds.json`. The agent imports the
   corpus pack into an empty batch-mode project of the pack's pipeline, runs it, and copies the output into
   `~/.cache/threenative-asset-mcp/unity-corpus/<id>/reference/`. It is our own code, so it may live in the repo.
2. `scripts/fidelity-sheet.ts` takes `--unity-package <file>` and `--unity-reference <dir>`. It uses `R1` when that
   folder exists, and `R2` otherwise. It writes the reference | before | after sheet that the epic's PR evidence
   rule defines.
3. `npm run parity:unity` imports `U1`–`U3` (or `--dir`), writes the sheets, the structural numbers and
   `fidelity.json` for `scripts/fidelity-baseline.ts check`.
4. Unity material fixtures go into a visual regression suite.

## Acceptance Criteria

- [x] AC-1 [local]: `fidelity-sheet` scores a synthetic package's import against its `preview.png`, and a deliberately
  wrong base colour drops the piece below 70 (suspect). proof: `npx vitest run tests/unity-fidelity.test.ts` — Evidence:
  14 tests pass (2026-10-14). Correct pieces score 100 and 100, the wrong-colour piece 66 with verdict `fail`; one test
  runs the real PRD-616 importer (Blender 4.5) on a synthetic package, with the right tint at 75 or more and a wrong
  tint under 70. A hue-only error (red against blue) scores about 72, because hue carries 25 points of the score, while
  its verdict is still `fail` (hue off by more than 45 degrees). The tests therefore use wrong colours that also move
  lightness, as a missing texture does. The judge is unchanged.
- [x] AC-2 [local]: Given a synthetic `R1` folder (PNG plus `bounds.json`), the sheet uses it instead of `R2`, labels
  the column `R1`, and flags a piece whose `sizeMeters` is more than 1 % off its bounds.
  proof: `npx vitest run tests/unity-fidelity.test.ts -t reference` — Evidence: 4 tests pass. The R1 folder
  beats deliberately wrong R2 previews (scores 85 or more with R1, under 70 without), `reference.json` and each piece
  say `R1`, the column header reads "ORIGINAL (R1 Unity Editor render)", a piece 2 % off is flagged while 0.5 % passes,
  a model with no R1 item is listed and not scored, and the script prints the reference line and table.
- [x] AC-3 [local]: Visual regression fixtures lock smoothness inversion, the HDRP mask split and cutout. Reverting
  any one rule in `src/unity/materials.ts` turns the suite red.
  proof: `npx vitest run tests/unity-visual-regression.test.ts` — Evidence: 8 tests and 9 goldens
  (`tests/fixtures/visual-golden/unity-*.png`), fixtures built through the production `.mat` path. Each of ten
  one-line mutations of `src/unity/materials.ts` was applied alone and turned the suite red, then restored:
  roughness `1 - smoothness`; the albedo-alpha smoothness switch; HDRP mask smoothness channel `a`; HDRP mask
  metallic channel `r`; HDRP mask occlusion channel `g`; Standard `_Mode` 1 cut-out; its `_Cutoff` value; URP
  `_AlphaClip`; HDRP `_AlphaCutoffEnable`; the sRGB to linear colour conversion.
- [x] AC-4 [local]: `npm run parity:unity` on `U1`–`U3` prints per pack the prefab count against the GLB count,
  bound slots, resolved textures and `fallback` materials with reasons. Its `fidelity.json` passes
  `fidelity-baseline.ts check`. proof: `npm run parity:unity` — Evidence: `npm run parity:unity -- --ids U1,U2 --max 40` and `--ids U3 --max 60` (importer 6, 2026-10-15). `U1`: prefabs 31 in, 31 GLBs out, prefab bound slots 31, textures 105, materials 30, fallback 0. `U2`: 17 in, 17 out, bound slots 32, textures 10, materials 22, fallback 1 (`builtin/210`). `U3`: 1006 in, 1006 out, prefab bound slots 2304 in 992 prefabs, unresolved refs 8, textures 76, materials 152, fallback 121 with the reasons printed (custom KUBIKOS shaders: Surface, Water, PlaneWater, Lava, PlaneLava, Magma, Ice, Cloud, Sun, WaterGreen, CustomStandardSpecular; and `builtin/10704`). `fidelity-baseline.ts check` on `U1` and `U3`: 0 regressions. `tests/unity-parity.test.ts` runs it on a synthetic corpus.
- [ ] AC-5 [local]: The baseline holds `U1`–`U3` entries (numbers only) after the sheets are inspected. The ledger rows
  that pass on a named pack move to Verified. proof: `npx tsx scripts/fidelity-baseline.ts update` and the ledger diff — Evidence: `U1` (31 pieces, mean 60.7, min 25.2) and `U3` (36 pieces, mean 78.3, min 49.9) recorded after the sheets were looked at piece by piece; the ledger rows that pass moved to Verified. NOT MET for `U2`: its previews are all the generic icon, so it has no scored piece and no baseline entry.
- [ ] AC-6 [local]: The PR comment embeds the `U1`–`U3` sheets per the epic's PR evidence rule (reference | before |
  after, with scores). Before and after are the same importer, so the judge must report no change on the shared
  pieces, and the new value is the reference column and the size check. proof: PR screenshot comment — Evidence: pending.
  NOT MET: no PR comment was posted (sheets stay under `~/.cache/threenative-asset-mcp/unity-parity-*`). Also open: the sheet writes
  reference | after only. The before score is measured with `--level models` (model GLBs, which carry no `.mat` binding: `U1` 28.9, `U3` 28.8), not as a column.

## Blocked on

- `R1` needs an activated Unity Personal licence on this machine. The agent installs the Editor (direct download, no root)
  and runs everything in batch mode under `xvfb-run`. Unblocked by João, once, when he signs in to Unity and activates
  the free Personal licence (Unity Hub needs `sudo apt install unityhub`, or the `unity` CLI `auth login` if it can
  activate Personal). The agent then builds one project per pipeline (`U1` Built-in; `U2` Built-in, URP and HDRP;
  `U3` URP), imports the pack, runs `ReferenceRender.cs` through `-executeMethod` and copies the output. Until then,
  every comparison uses `R2` and says so on the sheet.

## Findings and open points (2026-10-14, synthetic data only)

- **`R2` channel order and gamma are unverified.** A `preview.png` is a PNG file, so unlike Unreal's raw UE4 thumbnails
  its channel order is fixed by the format and `sharp` decodes it as stored. The sheet does not rely on that. After
  the first pass it re-scores every piece with red and blue exchanged, and swaps the whole package only when at least
  3 pieces are compared, at least 75 % of them gain 20 points and reach 85 with the swap (`decideChannelOrder`,
  `src/unity/fidelity.ts`). It then says so on the sheet. A single wrong colour is never rescued. The PNG's `gAMA`,
  `sRGB` and `iCCP` chunks are recorded in `reference.json` and not applied, because the judge reads sRGB pixels on
  both sides. Whether Unity previews are stored as expected, and in which gamma, is settled only by measuring a real
  preview from `U1`: do that before the first comparison.
- **`scripts/unity/ReferenceRender.cs` has never run.** No Unity Editor or licence exists on this machine, so it was
  not even compiled. Its `bounds.json` layout is the one the tests write and `readR1` reads. Expect small API fixes on
  the first run. HDRP light intensity is a guess, and the project must be in the Linear colour space (the script
  refuses otherwise). Until then every comparison uses `R2`, and the sheet says so.
- **`R1` pieces map to GLBs** by the prefab's single model path, else by the same file name. Prefabs with several
  models or a scaled or rotated root will not match or will flag a size difference: that is PRD-618's area.
- **Shared code touched.** `renderContactSheet` takes two opt-in options (`referenceLabel`, `tileNotes`) for the
  reference column title, the score line and the size note. Unreal sheets are unchanged (`tests/unreal-visual-regression.test.ts` passes).
  The judge's reasons still say "than Unreal" (shared wording).

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Unity fidelity sheet | `scripts/fidelity-sheet.ts --unity-package [--unity-reference]` | Extends the existing script | AC-1, AC-2 |
| Unity parity sweep | `npm run parity:unity` → `fidelity-baseline.ts check` | New script; same baseline file | AC-4, AC-5 |
| Reference render | `scripts/unity/ReferenceRender.cs` through `Unity -batchmode -executeMethod` under `xvfb-run` | New; output stays local | Blocked on |

## Execution Phases

#### Phase 1: References
**Status:** IN PROGRESS (code and tests done; `ReferenceRender.cs` never run, no `R1` produced)
**Files:** `scripts/unity/ReferenceRender.cs` (new), `scripts/fidelity-sheet.ts`, `tests/unity-fidelity.test.ts` (new)
**Verification:** AC-1, AC-2. Produce `R1` as soon as this phase lands and the licence is active, so it is ready for Phase 2.

#### Phase 2: Locks and sweep
**Status:** IN PROGRESS (locks done; sweep script done and tested on a synthetic corpus; no real run)
**Files:** `tests/unity-visual-regression.test.ts` (new), `tests/fixtures/visual-golden/unity-*.png`, `scripts/unity-parity.ts` (new), `package.json`, `docs/unity-format-support.md`
**Verification:** AC-3, AC-4, AC-5, AC-6.
