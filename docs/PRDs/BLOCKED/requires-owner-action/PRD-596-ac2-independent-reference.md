# PRD-596 AC-2 — independent Sequencer reference

**Status:** PARTIAL
**Blocker:** João must provide either an independently decoded PSA/editor export of one UE5.4+ FK Sequencer clip with the same skeleton and frame rate, or a ≤5.1 artifact containing the same clip. The local cache has only the 5.4 and 5.8 Sequencer variants; headless Fab ownership lookup failed at the OS keystore/DBus boundary.

The converter, channel evaluator, public 5.4/5.8 imports, synthetic tests, and differential gate are delivered by PRD-596. The remaining proof is intentionally not a self-comparison.

Unblock with:

```sh
PRD583_ANIMATION_PROOF=/absolute/path/current-prd583-proof.json \
PRD596_SEQUENCER_REFERENCE_PSA=/absolute/path/reference.psa \
FAB_FEATURE_CORPUS_DIR=/home/joao/.cache/threenative-asset-mcp/fab-slices \
npx vitest run tests/fab-feature-corpus.test.ts -t sequencer-differential
```

Expected result: every compared bone key is within 0.5° and the test reports the maximum error.
