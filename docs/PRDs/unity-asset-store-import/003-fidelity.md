# PRD-617 — Unity import fidelity: references, visual locks and baseline

**Status:** NOT STARTED
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

- [ ] AC-1 [local]: `fidelity-sheet` scores a synthetic package's import against its `preview.png`, and a deliberately
  wrong base colour drops the piece below 70 (suspect). proof: `npx vitest run tests/unity-fidelity.test.ts` — Evidence: pending.
- [ ] AC-2 [local]: Given a synthetic `R1` folder (PNG plus `bounds.json`), the sheet uses it instead of `R2`, labels
  the column `R1`, and flags a piece whose `sizeMeters` is more than 1 % off its bounds.
  proof: `npx vitest run tests/unity-fidelity.test.ts -t reference` — Evidence: pending.
- [ ] AC-3 [local]: Visual regression fixtures lock smoothness inversion, the HDRP mask split and cutout. Reverting
  any one rule in `src/unity/materials.ts` turns the suite red.
  proof: `npx vitest run tests/unity-visual-regression.test.ts` — Evidence: pending.
- [ ] AC-4 [local]: `npm run parity:unity` on `U1`–`U3` prints per pack the prefab count against the GLB count,
  bound slots, resolved textures and `fallback` materials with reasons. Its `fidelity.json` passes
  `fidelity-baseline.ts check`. proof: `npm run parity:unity` — Evidence: pending.
- [ ] AC-5 [local]: The baseline holds `U1`–`U3` entries (numbers only) after the sheets are inspected. The ledger rows
  that pass on a named pack move to Verified. proof: `npx tsx scripts/fidelity-baseline.ts update` and the ledger diff — Evidence: pending.
- [ ] AC-6 [local]: The PR comment embeds the `U1`–`U3` sheets per the epic's PR evidence rule (reference | before |
  after, with scores). Before and after are the same importer, so the judge must report no change on the shared
  pieces, and the new value is the reference column and the size check. proof: PR screenshot comment — Evidence: pending.

## Blocked on

- `R1` needs an activated Unity Personal licence on this machine. The agent installs the Editor (direct download, no root)
  and runs everything in batch mode under `xvfb-run`. Unblocked by João, once, when he signs in to Unity and activates
  the free Personal licence (Unity Hub needs `sudo apt install unityhub`, or the `unity` CLI `auth login` if it can
  activate Personal). The agent then builds one project per pipeline (`U1` Built-in; `U2` Built-in, URP and HDRP;
  `U3` URP), imports the pack, runs `ReferenceRender.cs` through `-executeMethod` and copies the output. Until then,
  every comparison uses `R2` and says so on the sheet.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Unity fidelity sheet | `scripts/fidelity-sheet.ts --unity-package [--unity-reference]` | Extends the existing script | AC-1, AC-2 |
| Unity parity sweep | `npm run parity:unity` → `fidelity-baseline.ts check` | New script; same baseline file | AC-4, AC-5 |
| Reference render | `scripts/unity/ReferenceRender.cs` through `Unity -batchmode -executeMethod` under `xvfb-run` | New; output stays local | Blocked on |

## Execution Phases

#### Phase 1: References
**Status:** NOT STARTED
**Files:** `scripts/unity/ReferenceRender.cs` (new), `scripts/fidelity-sheet.ts`, `tests/unity-fidelity.test.ts` (new)
**Verification:** AC-1, AC-2. Produce `R1` as soon as this phase lands and the licence is active, so it is ready for Phase 2.

#### Phase 2: Locks and sweep
**Status:** NOT STARTED
**Files:** `tests/unity-visual-regression.test.ts` (new), `tests/fixtures/visual-golden/unity-*.png`, `scripts/unity-parity.ts` (new), `package.json`, `docs/unity-format-support.md`
**Verification:** AC-3, AC-4, AC-5, AC-6.
