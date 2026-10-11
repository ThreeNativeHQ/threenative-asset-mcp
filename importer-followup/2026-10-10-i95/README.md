# Importer95 comparison sheets

Derivative comparison screenshots for PR #40; no source packs or metadata are included.

## Hornbeam Icon_Arrow_Test, verified uncooked10

The source thumbnail is cyan. The new import is visibly brighter blue than importer93, but remains deeper blue and uses a different camera angle. Parent inspected this sheet after running the visual judge. Judge: **86.8 / ok**, compared with **70.7 / suspect** before. Lightness ratio0.74 and density ratio0.70 remain imperfect; this is a real improvement, not a full-pack or exact-fidelity pass.

Runtime: importer95, modern71, verified uncooked4.27.2.0+threenative.10. Production code6280b95 (docs-only HEAD298fad8 during import). The converter now emits COLOR_0 bytes(0,26,139,0), rather than the stale writer's(0,3,66,0); neutral opaque vertex-colour material residual remains in use.

[New comparison](hornbeam-icon-after-i95-uncooked10.jpg). [Previous comparison](../2026-10-10-i94/hornbeam-icon-after-i93.jpg).

## Winter Spruce, opt-in engine bodies

[Source/import comparison](spruce-after-i95-engine71.jpg). **No visual improvement:** importer95/native71 with paired5.8engine content produces the same GLB and sheet as the earlier importer90/native69 attribute run. Judge **64.1 / suspect**; density2.19, mass2.26, lightness0.63. Parent inspected the source/import sheet: pale foliage remains unlike the snowy blue-green reference.

Provenance: source code2426703 extracted read-only; later6280b95 changes uncooked revision resolution, which this UModel route does not use. Native71 verified from the fresh converter. HeightLerp/SmoothThreshold are no longer named unsupported, but26sections remain blocked by If,68by missing TilingNoise05, and94baked sections retain SpeedTreeColorVariation/default-switch heuristics. Engine bodies alone have not closed Spruce parity.

## Winter Spruce, lighting control (Unreal-style approximation)

[Lighting-control comparison](spruce-lighting-control-unreal-style.jpg). Same source GLB (importer95/native71, unchanged) and same camera as the neutral sheet above. New in this sheet: an approximate daylight key, sky fill, checker floor, and cast and self shadows. The original neutral sheet is preserved as [spruce-after-i95-engine71.jpg](spruce-after-i95-engine71.jpg).

Numerical visual judge: **64.1 / suspect**, unchanged. The judge is always measured on the neutral render, so this score does not cover the lighting-control picture. Parent inspected this sheet: the new import still reads darker grey than the snowy reference. No material fix or fidelity pass is claimed.

Rendered with production renderer edded9c (integrated from 189723a).
