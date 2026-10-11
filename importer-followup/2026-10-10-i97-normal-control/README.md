# Winter spruce: normal-map diagnostic

These are derivative comparison JPEGs. No source packages, geometry, textures, or metadata are included.

The second render removes only normalTexture from 94 leaf and 68 branch sections; 26 trunk sections and every BIN byte are unchanged. This is a controlled diagnostic, not a fresh importer fix. Leaf source evidence contradicts the retained bark normal; branch removal is included as an experiment, without a completed branch-instance source proof.

Both runs use the same Unreal-style approximation preset and camera. The visual judge remains suspect: composite score 58.80 → 59.15, density ratio 2.216 → 2.184, lightness ratio 0.630 → 0.630. The footer colour similarity is a separate metric. Root inspection still finds the result too dark and dense. Removing these maps does not explain most of the mismatch; no baseline was updated or parity claimed.
