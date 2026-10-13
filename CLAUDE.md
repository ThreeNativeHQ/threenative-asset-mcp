@AGENTS.md

## Unreal import fidelity (read before touching `src/unreal/`)

Any change to the Unreal/Fab importer, the material resolver, the graph baker, the CUE4Parse adapter or the
visual judge follows the workflow in `src/unreal/CLAUDE.md`: measure with `scripts/fidelity-sheet.ts`, fix with
a red-to-green test, then lock the result (visual fixture plus `docs/parity/fidelity-baseline.json`).

## Unreal format support ledger (always keep current)

`docs/unreal-format-support.md` is the single list of supported, verified and missing Unreal 4/5 formats.
Update it in the same commit or PR as any change that adds, verifies, removes or regresses support for a class,
engine version or decoder route:

1. Move the row (Missing → Reported → Implemented → Verified) and fill its evidence: test file, or real pack
   name, engine version, `IMPORTER_VERSION` and date. A row is Verified only with a real, named pack.
2. Add a row when a pack shows a class the ledger does not list.
3. Bump the "Last audited" line. Keep the import table in `docs/unreal-import.md` consistent with the ledger.
4. A PR that changes importer or converter output without touching the ledger is incomplete.

**Release reminder:** after an importer or converter fix is published, bump the exact `threenative-asset-mcp` pin in `threenative-engine/packages/core/package.json` (PR to `develop`); ask before `npm publish`.
