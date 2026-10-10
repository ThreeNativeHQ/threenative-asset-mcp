# Importer follow-up comparison sheets (2026-10-10, i91–i94)

Assets-only comparison derivatives attached to PR #40. Each JPEG is a contact sheet built from the
owner's licensed Fab packs, kept off `main` on purpose. Comparisons are approximate: the left tile is
Unreal's own editor thumbnail and the right tile is our neutral-GLB render, so camera and lighting
differ between the two. A structural check or an automatic judge verdict alone does not establish
parity.

## Hornbeam icon

- Before (importer 91): [hornbeam-icon-before-i91.jpg](hornbeam-icon-before-i91.jpg)
- After (importer 93): [hornbeam-icon-after-i93.jpg](hornbeam-icon-after-i93.jpg)

Both imports remain dark blue versus the source thumbnail's cyan. Both are rated **suspect** at fidelity **70.7**,
so this is **not an improvement claim** — only a side-by-side record.

## Jungle wall and the three other Paragon meshes

- Before (importer 92, four meshes): [paragon-four-before-i92.jpg](paragon-four-before-i92.jpg)
- After (importer 94, Jungle wall only): [jungle-wall-after-i94.jpg](jungle-wall-after-i94.jpg)

Before, the four meshes fail with a mean fidelity of **24.6** (Jungle wall alone **25.9**). After,
Jungle wall is **suspect** at **64.7**: the white emission is fixed, but the moss variation is still
missing because `WorldAlignedTexture` is averaged out.
