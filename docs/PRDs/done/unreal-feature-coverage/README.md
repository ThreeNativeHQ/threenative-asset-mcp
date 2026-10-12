# Epic: Unreal feature coverage

**Status:** DONE — all four PRDs (001–004) merged 2026-10-12 (PRs #43–#46).

Imports the Unreal classes that `docs/unreal-format-support.md` lists as Missing or Reported. Each step
updates that ledger.

| Step | PRD | Scope |
|---|---|---|
| 001 | PRD-581 | Small Fab test corpus (slices) |
| 002 | PRD-582 | Sockets, collision, physics assets, SoundCue |
| 003 | PRD-583 | UE5 clips, blend spaces, aim offsets, montages |
| 004 | PRD-584 | Cascade and Niagara descriptors (P3) |

## PR evidence rule (João, 2026-10-11)

Deliver one PR per PRD (four PRs total), with the visual proofs embedded as screenshots in PR comments.

Every PR in this epic attaches **screenshots with a before/after visual-judge comparison**. Numbers alone
do not count. Each PRD has an acceptance criterion that names what its sheets show.

1. **Before** is the importer at the PR's base commit. **After** is the PR head. Both run on the same corpus
   slice, camera, framing and picture contract (`AGENTS.md`, "Comparison preview contract"). Never tune
   lighting or exposure per asset.
2. Render with the production tile renderer (`renderTiles`, `src/unreal/contact-sheet.ts:666`). Score with
   `judgeRender` (`src/unreal/visual-judge.ts:107`) and, where Unreal thumbnails exist, with
   `scripts/fidelity-sheet.ts`. Put the judge verdicts and scores beside each tile.
3. Look at every sheet by eye before posting. Numbers and eyes must agree.
4. Publish the sheets as a fast-forward commit to the PR's `<branch>-assets` orphan branch, never force.
   Post one PR comment that embeds them through immutable commit-SHA blob URLs.
5. Sheets are derived from licensed packs: they go on the assets branch only, never into `main`, tests or
   fixtures.
6. If a PR changes nothing visible, the sheet must still show that: an identical before/after with the judge
   reporting no change.
