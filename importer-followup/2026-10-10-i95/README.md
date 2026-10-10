# Importer95 comparison sheets

Derivative comparison screenshots for PR #40; no source packs or metadata are included.

## Hornbeam Icon_Arrow_Test, verified uncooked10

The source thumbnail is cyan. The new import is visibly brighter blue than importer93, but remains deeper blue and uses a different camera angle. Parent inspected this sheet after running the visual judge. Judge: **86.8 / ok**, compared with **70.7 / suspect** before. Lightness ratio0.74 and density ratio0.70 remain imperfect; this is a real improvement, not a full-pack or exact-fidelity pass.

Runtime: importer95, modern71, verified uncooked4.27.2.0+threenative.10. Production code6280b95 (docs-only HEAD298fad8 during import). The converter now emits COLOR_0 bytes(0,26,139,0), rather than the stale writer's(0,3,66,0); neutral opaque vertex-colour material residual remains in use.

[New comparison](hornbeam-icon-after-i95-uncooked10.jpg). [Previous comparison](../2026-10-10-i94/hornbeam-icon-after-i93.jpg).
