# Spatial material bake: implementation plan

- **Date and base:** 2026-10-10, HEAD `ff18cbe` on `feat/importer-spatial-context` (clean worktree).
- **Status:** T1 corrected after native review (§3a, applied 2026-10-10). New files only: `src/unreal/spatial-surface.ts` and `tests/unreal-spatial-surface.test.ts`. Tests: 68 of 68 pass (52 original, one of them expanded, plus 16 added). Typecheck is clean. T1 is internal math only: no atlas certificate, no callsite, no lockfile, version, memory write, network, install, subagent, commit or push.
- **Goal:** replace the origin, UV0 and average stand-ins in the graph bake with a validated per-texel spatial context, so a baked base colour follows the mesh it is baked on. This is a full implementation, not a documented limitation.
- **Brief names vs code:** `GraphBakeOptions` is `GraphBakerOptions` (graph-baker.ts:152). There is no `SampleTexture`: sampling is `TextureSample` / `TextureSampleParameter2D` (material-graph.ts:1064-1065, handled by `textureSample` at :1818), with slot type `TextureSlot` (:391).

## 1. Ground truth (6 targeted reads)

| Concern | Location |
|---|---|
| Request fields; lazy pattern (`surface`, `objectRadius`) | graph-baker.ts:47-85 (`surface` :82, `objectRadius` :84) |
| Nearest-wins parameters over the instance chain | graph-baker.ts:129-130 |
| Options: `maxTextureSize` (never above 1024), `exportTexture(name, reference)`; `GraphTextureSource` | graph-baker.ts:160, :170; :145-150 |
| Bake entry, cache, pipeline | graph-baker.ts:394 `createGraphBaker`, :468 `bakes`, :471 `baker`, :549 `pending`, :613 `baked` |
| Evaluator request; UV-set fallback doc (option `allowUvSetFallback`, used at :1680, :1795) | material-graph.ts:63 `BakeRequest`, :73 |
| Header model: minification, UV nodes that compose freely | material-graph.ts:24-29 |
| Per-texel inputs: `texel.u/v` today | material-graph.ts:533 `TexelContext`; :1811-1813, :1856 |
| `WorldPosition` = origin with `world: true`; disclosure text | material-graph.ts:1190-1194; :637 |
| `TextureCoordinate[k>0]` falls back to UV0 | material-graph.ts:1158, :1791-1799 (fallback :1795-1796) |
| Unwired UV = UV0 (`defaultUv`, `uvSource`) | material-graph.ts:1803-1816 |
| Sample: qualified reference, coordinates, `lodFor` | material-graph.ts:1818; reference :1824; `world` :1838; `lodFor` :1843-1849; world = 40 :1845; no scale = 0 :1846 |
| Average stand-in (`#mean`), LOD 40 | material-graph.ts:2614-2620 |
| Mip cache and slot levels | material-graph.ts:2914 `slotKey`; :2927-2936 `levelFor` (key :2928); :2944-2945 |
| Request construction | importer.ts:1776-1799 (`surface` :1790; `objectRadiusOf(root, options.geometryScale)` :1792) |
| BuildScale geometry apply | importer.ts:2612 `meshGeometryScale` |
| UV pruning; report | importer.ts:2320, :2347; report :5341-5343 |
| Version constant | importer.ts:61 `IMPORTER_VERSION = 97` |

Named but not read: `readBuildScale3D`, `surfaceOf`, `objectRadiusOf`, the raster loop that fills `TexelContext`, the `Val` body (material-graph.ts:441), and the code that consumes the bake result after importer.ts:3215.

## 2. Approved architecture

- **A. `src/unreal/spatial-surface.ts` (new).** T1 exports `PreparedSpatialGeometry` (untrusted atlas) only. T2A certifies layout only. Creating an immutable `ValidatedSpatialContext` additionally requires verified source-route admission. Its intended content is copied triangle data, a compact owner map, geometry/atlas fingerprints and the new UV index. Queries derive barycentrics, ALL original UV sets, UE-composed position and normal, and analytic derivatives J = ∂originalUV/∂atlasUV (constant per triangle); do not materialize every input value per pixel. A refusal carries a named reason; a partial context never escapes.
- **Coordinate proof (pinned UModel commit `a0bfb468d42be831b126632fd8a0ae6b3614f981`, uncooked SourceModels, bCooked 0):** raw CVT identity and export XZY·0.01, so glTF = (UEX, UEZ, UEY)·0.01 and the inverse is (x, z, y)·100, applied once. The UE 5.8.3 checkout is not the axis proof. Accepted: identity node, known positive uniform BuildScale, explicit unrotated fixed origin. Refused: cooked source, unproved route, non-identity or reflected transform, deformation, nonuniform, zero, negative, nonfinite or unknown scale, WorldPosition mode.
- **Scale:** Jungle's actual BuildScale is [1,1,1], so Jungle cannot catch a doubled or missing scale. The context is built from pre-scale arrays: the existing bake runs before the pending BuildScale apply (`meshGeometryScale`, importer.ts:2612), import ordering is unchanged, and the context applies the known uniform scale once and fingerprints it. Tests apply [2,2,2] once and refuse [2,3,4] rather than multiplying it.
- **B. Atlas:** `src/unreal/spatial-atlas.ts` (new, gated, see §4).
- **C. `GraphBakeRequest.spatial?: () => SpatialBakeResult`** beside `surface` (graph-baker.ts:82). Lazy and memoised like `meshRadius` (importer.ts:1791-1794), built only when a graph reads spatial inputs. A refusal is a named `GraphBakeOutcome` failure, never a silent UV0 bake.
- **D. Evaluator reads the context.** `WorldPosition` (:1190) returns the context position. `TextureCoordinate[k]` (:1791) reads original set k and refuses when the mesh lacks it, even with the fallback option on. `defaultUv` (:1803) reads original UV0. The atlas UV never becomes a sample coordinate. Pack-body precedence holds: nearest-wins parameters (graph-baker.ts:130) and qualified references (material-graph.ts:1824, `exportTexture(name, reference)`) are never overridden. No invented defaults: a missing BuildScale, origin, UV set or derivative is a refusal.
- **LOD for validated coordinates only (derivative policy):** s = (u·W, v·H), and ∂s/∂px is the pair of source texel derivative vectors per output pixel (J / outputSize, in source texels). ρ is the largest singular value of that 2×2 matrix, not its largest entry, and mip = clamp(ceil(log2 ρ), 0, available levels − 1), not `round`. The anisotropic footprint is approximated isotropically by ρ; this is disclosed. A rotated or sheared checker must fail under max-entry and round. For diagonal J, ρ = max(|su|, |sv|), so the existing `:1847-1848` special case agrees before rounding; the rounding change applies to validated coordinates only. Unvalidated coordinates keep 40 (:1845, :2617). Affine nodes (material-graph.ts:28-29) propagate J; unknown mixtures invalidate and refuse, with no generic mip zero.
- **E. Bake and commit** (`baker` / `pending` / `baked`, graph-baker.ts:471-613): bake covered texels only. Then fill gutters from the owning chart only, bounded by the measured gutter (≥4 px), never across a chart boundary, colour only, never positions. Commit remapped geometry and the new base colour texture only on success; a failed bake changes nothing. Clone a shared material when contexts differ. Only the new base-colour texture's texCoord changes; other maps and tangents keep their UV; `prunedUvSets` (importer.ts:2320) keeps every referenced set. New sampler: LINEAR min/mag, no mips.
- **F. Cache fingerprint:** geometry, UV, indices, transforms, scale, origin, atlas, resolution, filtering. Add it to the `bakes` key (graph-baker.ts:468-471), the raster key (material-graph.ts:2914, :2944) and the `levelFor` key (:2928). T1's fingerprint covers geometry, all UV sets, indices, the source proof, the scale and the fixed origin; T2 adds the certified atlas, resolution and filter policy.

## 3. Task split: 7 tasks, red test first in each

Order: T1 first, then T3-T5 (they use a synthetic atlas fixture). T2 runs alongside and gates T6's production path. Then T6, then T7.

- **T1 Coordinate proof and geometry core.** New `src/unreal/spatial-surface.ts` (`prepareSpatialGeometry` → `PreparedSpatialGeometry`, untrusted atlas; the earlier name `validateSpatialSurface` is dropped, since T1 certifies nothing) and `tests/unreal-spatial-surface.test.ts`. T1 boundary: internal math only; no atlas certificate, no `ValidatedSpatialContext`, no runtime integration, LOD, gutters or judge.
  - Red: (a) asymmetric synthetic mesh, UE → glTF → UE is identity and equals (x, z, y)·0.01; (b) uniform BuildScale [2,2,2] applied once, nonuniform [2,3,4] refused, and the normal is normalize(XZY n), with no S⁻¹ term for a positive uniform scale; (c) cooked source, unproved route, non-identity or reflected transform, deformation and bad scale each give a named refusal; (d) interpolated original UV is the barycentric mix of the original corners, not the atlas UV.
  - Winding: the (x, z, y) swap is a reflection, so for one index order the glTF winding normal flips against the mapped UE normal. T1 keeps the index order as given and never takes the declared normal from the face. The converter-output check is not met in T1 (it needs the external converter); it stays open for T2.
  - The UE 5.8.3 checkout is not an axis proof; the proof is the pinned UModel commit. It may be read for background only, with provenance recorded and nothing copied.
  - First step: stub `prepareSpatialGeometry` to refuse everything, so the red tests fail on asserted values, not on a missing module or a type error.
  - Run record, stub stage (2026-10-10): red `/tmp/importer-spatial-core-red.log`, 52 of 52 failing on stub refusals or refusal-code assertions. The first green attempt stopped at the build (TS2322: `derivatives().position` inferred as an array, not a two-tuple).
  - Run record, corrected stage (2026-10-10): the build passes once `position` is annotated `SpatialDerivatives["position"]`. Red `/tmp/importer-spatial-core-corrected-red.log`: 13 of 68 fail, all new defect cases, each for its intended reason. Green `/tmp/importer-spatial-core-corrected-green.log`: 68 of 68 pass. Typecheck `/tmp/importer-spatial-core-corrected-typecheck.log`: clean.
- **T2 Atlas proof (gated, §4).** `src/unreal/spatial-atlas.ts` prototype. Red: a synthetic source with two positive-area overlaps gets a layout with zero exact overlaps; a sliver, a partial overlap and a boundary UV seam are refused; measured gutter ≥4 px. The T2 certifier rejects output atlas overlap and incompatible contacts; original UV overlap is allowed, and each triangle interpolates its own original UVs.
- **T3 Evaluator reads the context** (material-graph.ts:1190-1195, :1791-1799, :1803-1816), in `tests/unreal-material-graph.test.ts`. Red: (a) `WorldPosition` with a context returns it, not origin (:1194); (b) `TextureCoordinate[1]` on a mesh without set 1 is a named refusal with the fallback option on (today :1796 falls back to UV0); (c) with a synthetic atlas that differs from UV0, a sample with no Coordinates pin reads original UV0 (today only `texel.u/v` feeds it, :1856).
- **T4 Derivative LOD** (material-graph.ts:1843-1849; J through affine nodes). Red: a checker texture with known J gives the exact expected LOD under the §2 policy (largest singular value, ceil); a rotated or sheared checker is red under max-entry and round; an unknown mixture is a refusal, not mip 0 (today :1846 returns 0); a validated world-derived coordinate gets a derived LOD, while an unvalidated one keeps 40 (:1845).
- **T5 Cache separation** (graph-baker.ts:468-471; material-graph.ts:2914-2945). Red: same graph, two geometries give two bakes and two cache entries, with no shared hit; checker LOD stays exact after the key change.
- **T6 Bake, gutters, commit** (graph-baker.ts:471-613; the commit point is the code consuming the result after importer.ts:3215, not read this pass). Red: (a) a failed bake leaves geometry and materials byte-identical; (b) corner attributes and other UV sets preserved; (c) gutter texels never cross a chart; (d) new texture has no mip and other textures are unchanged; (e) shared material cloned when contexts differ.
- **T7 Evidence and gates (root).**
  - Jungle selected mesh: verify the retained import output and its source-pack `import-report.json` exist before measuring. Reuse the download under `~/.cache/threenative-asset-mcp/fab-downloads/`; re-fetch only if it is missing.
  - Sheets and checks: `scripts/fidelity-sheet.ts`, structural checks, actual judge, parent eyes, near/far screens. Then siblings and a neighbouring pack (src/unreal/CLAUDE.md step 4), metadata dumps (local only), the full 86+24 manifest, `npx tsx scripts/fidelity-baseline.ts check <sweep out dir>`, and `update` for validated wins only.
  - Retain the named 5.8-engine body-vs-old/unknown-pack heuristic; do not correct its provenance away (provenance at graph-baker.ts:148-149; the heuristic itself was not located this pass).
  - Publish the screens to PR #40 under the saved rule (one comment, immutable-SHA images), via `gh api` because `gh pr edit` is broken.
  - Root bumps the central `IMPORTER_VERSION` once after integration (importer.ts:61, 97 → 98); per-task bumps churn.
  - Gates: `npm run typecheck`; `npm test`; `npx vitest run tests/mcp-smoke.test.ts`; `npm run test:leaks`; Fresh toolchain workflow; CI.
  - Native review: clear every Critical and Important finding. The full goal stays open until the 86+24 sweep is checked.

## 3a. T1 corrections (recorded 2026-10-10, before any T1 code)

- **Ordering:** the existing bake runs before the pending BuildScale apply; import ordering is unchanged. The context is built from pre-scale arrays and never reads post-scale geometry.
- **BuildScale:** a known, positive, uniform tuple only. Nonuniform, negative, zero, nonfinite or unknown refuse by name. The scale is applied once, in the context.
- **Mapping:** UE = (x, z, y)·100 on pre-scale glTF positions, then the uniform scale, then the explicit fixed origin. Normals: normalize(x, z, y); a positive uniform scale does not change their direction.
- **Identities:** the node transform must be identity. The fixed origin is explicit (no default) and unrotated. Both are in the fingerprint.
- **Source proof:** pinned UModel commit `a0bfb468d42be831b126632fd8a0ae6b3614f981`; raw CVT identity; export XZY·0.01; SourceModels; bCooked 0. Not a UE 5 engine proof.
- **Derivative policy for final mips (T2/T4):** ρ = largest singular value of the two source-texel derivative vectors; mip = clamp(ceil(log2 ρ), 0, available levels − 1). Isotropic approximation, disclosed. A rotated or sheared checker must fail under max-entry and round.
- **Atlas (T2):** the certifier rejects output atlas overlap and incompatible contacts. Original UV overlap is allowed; each triangle interpolates its own original UVs. T1 does not certify the atlas.
- **Provenance:** keep the named 5.8-engine body-vs-old/unknown-pack heuristic; do not correct its provenance away.
- **Boundary:** T1 is internal math. Its result is `PreparedSpatialGeometry` (untrusted atlas). T2A certifies layout only; creating `ValidatedSpatialContext` additionally requires verified source-route admission. No certificate or test cast may fabricate that admission. Full T2 atlas, runtime integration, world derivatives, LOD, gutters, near/far judge, eyes/screens and the 86 variants remain required.
- **Tests:** synthetic meshes only; no licensed data, no name fixture, no golden from a pack.
- **Applied corrections (2026-10-10, after native review):**
  - **Origin order:** position derivatives come from the untranslated scaled positions. The fixed origin is added only when a query places a point, so a 1e20 origin leaves the derivatives exactly as at the zero origin (tested). No origin subtraction.
  - **Named finite policy:** `nonfinite` refuses an overflow or NaN in the node-transform determinant, in each composed position (BuildScale × 100 × metres, then origin plus offset), in every triangle edge and cross product, in the atlas determinant, in each UV or position difference and gradient, and in every interpolated or placed value. There is no coordinate limit: a representable 1e100 scale returns finite results.
  - **Huge normals:** normalised by the largest component first, so a declared normal longer than the largest double returns its unit direction. The zero vector still refuses (`degenerate-normal`).
  - **Barycentric shape:** exactly three dense finite numbers, then range and sum. A short, sparse, four-entry, non-indexed or string input refuses as `bad-barycentric`. Weights are never renormalised.
  - **Copies and freezing:** the tests mutate every input after `prepare` (positions, normals, atlas, every original UV set, indices, source proof, BuildScale, origin, transform) and expect unchanged outputs and fingerprint. Every returned tuple is frozen.
  - **Source route proof:** `SourceRouteProof` is a caller-supplied declaration in this stage, not an attested proof (documented on the type). `PreparedSpatialGeometry` keeps `trust: "untrusted-atlas"`. No certificate, no caller wiring, no cast that fakes a proof.
  - **Production prerequisite (receipt):** before any production use, the mesh needs an embedded actual SourceModels route, an owned build-binary manifest, and exact source and output hashes, checked through a route receipt whose implementation is pending and which gates production admission separately. Until then, unattested tools and ordinary imports stay allowed, and spatial geometry is refused.

## 4. Atlas dependency: layout accepted; production integration pending

- `unwrap` 4.4.2 and private `watlas` 1.0.1 are installed locally with no lockfile change. Keep it that way until acceptance.
- Jungle's source UV0 fails the exact check with 2 positive overlaps, so the bake needs a new atlas, not UV0.
- The cache-only per-triangle inset2048 layout passed native review for T2 development. Exact final-byte overlap/contact checks, border 8.287 px, zero radius-four ownership collisions and continuous interior-query bilinear coverage pass; all triangles have at least one covered pixel. Two have fewer than four. Cache certificate: `spatial-atlas-feasibility-47s3OI/per-triangle-atlas/page-inset2048/CERTIFICATE.json`. This accepts layout only: production certification, 2048 plumbing, colour bake, tiny-triangle quality and near/far visual validation remain open. No 1024 downsample, mipmap or anisotropic guarantee.
- Freeze gate (all required): exact BigInt dyadic overlap test on post-float32 UVs with zero overlaps; contacts and source-UV continuity; measured ≥4 px gutter; border gate; acceptance on the 2894-chart Jungle layout with chart and page counts, proof, coverage and density.
- Prior checker, path from the brief and not re-read: `~/.cache/threenative-asset-mcp/jungle-exact-uv-proof-yjvWdi/uv-exact-proof.mjs`. Use only if needed. Licensed data is never copied into the repo.

## 5. Disclosures that ship with the change

- Runtime minification aliasing is approximate: no mips, and glTF core cannot cap LOD. Measure NEAR and FAR. Claim no exact filter or visual error bound.
- Fixed placement: the bake uses the mesh's own frame (identity node, unrotated origin). Level placement is unknown.
- Cross-version: disclosed where it applies. UE5 editor meshes are not yet covered (`readBuildScale3D` reads legacy -7 headers only, per AGENTS.md).
- A candidate certificate is not visual parity. No test counts or gates are claimed here.
- Derivative LOD is isotropic: ρ (the largest singular value) covers the anisotropic footprint, so the minor axis is over-blurred.
- Overflow refuses by name even where the exact result would fit: a derivative whose intermediate product overflows is refused as `nonfinite`, though its quotient might be representable.
- Float64 precision: a placed position at a 1e20 cm origin cannot carry detail below its ulp. The derivatives are unaffected, because they never see the origin.

## 6. Constraints

No DeepSeek model for any dispatch (ARM_MODELS exclusion). Licensed pack data stays out of the repo; goldens come from synthetic GLBs only (src/unreal/CLAUDE.md).
