# Spruce branch-texture diagnostic

This comparison is a cache-only diagnostic based on importer97 (c7e50b2), not a new production importer result. Only 68 branch base-colour bindings use prior bark RGB with opaque alpha; importer97 leaf/trunk textures, factors, geometry, UVs and normals remain unchanged. Root viewed the sheet and native review checked the structural proof and interpretation.

Neutral composite fidelity: 58.80 original97 → 59.37 control; both suspect. Hue error: 29.36° → 28.10°. The image footer prints the separate colour-similarity component (0.64), not the composite fidelity score.

Limitations: bark is 4096² versus the replaced 1024² graph bakes, so filtering/resolution also change. Original97 render flags were not retained; matching preset/camera metadata does not prove exact render equivalence. The copied local import report describes original97; a separate local diagnostic manifest records this override. These results do not establish source correctness, leaf causality or visual parity. No baseline updated.

Only the derivative comparison JPEG is published. Source assets, textures, GLBs and metadata remain local.
