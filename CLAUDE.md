@AGENTS.md

## Unreal import fidelity (read before touching `src/unreal/`)

Any change to the Unreal/Fab importer, the material resolver, the graph baker, the CUE4Parse adapter or the
visual judge follows the workflow in `src/unreal/CLAUDE.md`: measure with `scripts/fidelity-sheet.ts`, fix with
a red-to-green test, then lock the result (visual fixture plus `docs/parity/fidelity-baseline.json`).

**Release reminder:** after an importer or converter fix is published, bump the exact `threenative-asset-mcp` pin in `threenative-engine/packages/core/package.json` (PR to `develop`); ask before `npm publish`.
