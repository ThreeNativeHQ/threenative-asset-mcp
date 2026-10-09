# src/unreal: import fidelity workflow

Loaded when you work in this directory. The long form (and why) is in the root `AGENTS.md`, sections
"Fab and Unreal imports" and "Measure fidelity, do not eyeball it, and lock every win".

## When an import "looks wrong"

1. **Measure, do not eyeball.** With an import output (what `npm run parity:fab -- --keep` leaves, with its
   `import-report.json`) and the source pack:
   `npx tsx scripts/fidelity-sheet.ts --source <pack dir> --import <import output dir> --out <dir>`.
   It prints a per-piece table (score 0..100, hue EMD, saturation ratio, density ratio, lightness ratio) and writes
   `sheet.jpg` plus the reference/render tile PNGs. Then **look at the sheet** (Read the jpg): numbers and eyes must agree.
   - saturation ratio below ~0.7 (provisional; a correct import sits a little under 1 because the editor tonemaps): greyer than Unreal (dropped tint, wrong channel, missing graph colour).
   - density ratio below ~0.65: sparser (opacity cut-out too harsh); above ~1.6: solid card (cut-out missing).
   - hue EMD above ~25 degrees: wrong colour (swapped channels, wrong texture, wrong tint).
   - no thumbnail (most UE5 packs): the metric cannot compare; compare the render with the albedo the material binds.
2. **Find the cause in the package**, not in the render: material graph (`dump.mts`-style `dumpMaterialGraphs`),
   instance parameters, texture source format. Check `tests/fixtures`/`AGENTS.md` first: thumbnails are red/blue
   swapped in UE4, and a JPEG editor source needs no channel swap.
3. **Fix with a red-to-green test** in the style of `tests/unreal-material-graph.test.ts`; confirm it fails on
   the old code for the right reason. Bump `IMPORTER_VERSION` (`importer.ts`) when output changes, and the
   converter version (`cue4parse-adapter.ts` plus the two tests asserting it) when the C# changes.
4. **Check siblings.** Re-render the other pieces of the pack and a neighbouring pack before and after (a fix once
   broke the curtains in another pack).

## Lock every win (no whack-a-mole)

- A defect you can see gets a fixture in `tests/unreal-visual-regression.test.ts` (synthetic GLBs; regenerate with
  `npm run goldens:update`). Goldens are never derived from a licensed pack.
- A pack at parity gets its numbers recorded: `npx tsx scripts/fidelity-baseline.ts update <sweep out dir>` writes
  `docs/parity/fidelity-baseline.json` (numbers only, ratchets upward). Before merging any importer or judge change run
  `npx tsx scripts/fidelity-baseline.ts check <sweep out dir>`; a regression on any pack blocks the merge.
- Licensed material never enters the repo: no pack files, renders, tiles, metadata dumps or asset names in tests,
  fixtures or the baseline.

## Do not

- Use the old mean-colour `similarity` as a gate; it passed washed-out conifers at 0.5-0.7.
- Touch the shared toolchain cache from an experiment (`cp -a` it and set `THREENATIVE_TOOLCHAIN_DIR`), or a
  running sweep will pick up your rebuilt converter mid-pack.
