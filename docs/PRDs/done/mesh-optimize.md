# PRD — `mesh_optimize`: shrink heavy static meshes without a visible change

**Status:** DONE (2026-10-29)
**Priority:** P2 — new feature; every AC below is met and nothing else was blocked on it.
**Complexity:** 3 (LOW) — 1 new module, 4 implementation files; risk override: none.
**Owner:** João Paulo Furtado
**Depends on:** None

## Context

Scans and AI-generated meshes arrive with 500k to 1M+ triangles, where a game wants 2k to 150k.
Smithsonian scans and Sketchfab downloads from this server are often in that range. The server can
find and download such assets, but it cannot make them engine-sized.

Source idea: Nikhil Shahane, "How to shrink a 3D model from a million triangles to 20,000"
(x.com/Bingeljell, 2026-10-28). Points that drive this design:

- QEM simplification keeps the big shape but removes fine, shallow detail (eyes, lips) first.
- A fixed triangle target (AssetFurnace uses 10k/20k/40k) lets that loss happen without a check.
- Simplified meshes have long thin triangles. That is fine for props, bad for meshes that deform.
- Baking a normal map gets the lost detail back, but needs a bake step (out of scope for v1).

Inspected:

- `package.json` — `@gltf-transform/{core,extensions,functions}` 4.4.2, `sharp` 0.35.4, `three`,
  `playwright` are direct dependencies. `meshoptimizer` 1.1.1 is only an indirect one.
- `node_modules/@gltf-transform/functions/dist/index.d.ts:1303` — `simplify({ simplifier, ratio,
  error, lockBorder })`. It stops at the target `ratio` or when `error` (fraction of mesh radius) is
  reached, whichever comes first.
- `src/rig/preview.ts:168` — `renderPreview(modelBytes, { times, angles, width, height })` renders
  a GLB in headless Chromium + three.js and returns one PNG per angle.
- `src/gltf-size.ts` — reads GLBs without Draco or meshopt decoders. Output must stay
  uncompressed so this server can still measure it.
- `src/server.ts` — every tool is a `server.registerTool(...)` call with zod input/output schemas
  and a handler from `src/tools/*`.

## Solution

One new tool, `mesh_optimize`. The caps are on visual change, not on triangle count:

1. **Refuse what v1 cannot keep safe.** A GLB with any skin or morph target returns
   `MESH_OPTIMIZE_UNSUPPORTED` and writes nothing.
2. **Pipeline (gltf-transform):** `dedup` → `weld` → `simplify` (meshoptimizer, `ratio: 0`,
   bounded only by `error`) → `prune` → `textureCompress` to resize textures above
   `maxTextureSize` (default 2048, same format). No Draco or meshopt compression on output.
3. **Error ladder:** try `error` = 0.005, then 0.002, then 0.0005. Flat areas collapse almost
   completely and detailed areas keep their triangles, so each asset finds its own count.
4. **Visual gate:** render original and candidate from 6 angles with `renderPreview`. A candidate
   passes when every view has silhouette IoU ≥ 0.98 and mean grayscale difference ≤ 2%.
   The first passing candidate wins. When no candidate passes, the tool keeps the original,
   writes nothing and reports `kept: "original"`. Phase 3 calibrates both thresholds on real scans.
5. **Output:** `<name>.optimized.glb` next to the input, or `outputPath`. Never overwrites the
   input. The result reports triangles and bytes before/after, every attempt with its error and
   gate metrics, and the before/after PNG paths.

Consumer flow: MCP client → `mesh_optimize { path, outputPath?, maxTextureSize? }` →
`src/tools/mesh-optimize.ts` handler → `src/optimize/mesh.ts` (`optimizeMesh`) → GLB on disk
+ structured result.

Risks:

- ⚠️ `renderPreview` was built for rigged models. Unverified: camera framing from bounds, a usable
  background for a silhouette mask, and render time at 1M triangles. Phase 1 checks all three.
- ⚠️ Simplification across UV seams can tear textures. `weld` first, then the gate catches tears.
- ⚠️ Mean grayscale difference is a cheap stand-in for SSIM.
  `ponytail:` add SSIM only if Phase 3 finds a nerf that passes this gate.

## Acceptance Criteria

- [x] AC-1 [local]: An MCP call `mesh_optimize` on a dense static fixture (≥200k triangles, mostly flat with one fine detail) writes a GLB with ≥90% fewer triangles and reports a passed gate. — proof: `npx vitest run tests/mesh-optimize.integration.test.ts` — Evidence: 2026-10-29, 5 tests passed; 207,362-triangle fixture → 1,298 triangles (99.4% fewer), 5,950,740 → 40,080 bytes, gate passed at error 0.005 (worst IoU 0.9985, worst gray difference 0.10%).
- [x] AC-2 [local]: The gate fails a candidate with a visible change (fixture with one detail removed) and passes an identical copy. — proof: `npx vitest run tests/mesh-optimize.integration.test.ts -t gate` — Evidence: 2026-10-29, 1 test passed; changed fixture scored IoU 0.652 / 29.2% gray difference, identical copy scored 1.0 / 0%.
- [x] AC-3 [local]: The input file is unchanged after the call (same SHA-256), and `sizeMeters` reads the output (no Draco or meshopt extensions). — proof: `npx vitest run tests/mesh-optimize.integration.test.ts -t output` — Evidence: 2026-10-29, test passes; input SHA-256 identical before/after, output readable by `sizeMeters`, and neither `KHR_draco_mesh_compression` nor `EXT_meshopt_compression` appears in `extensionsUsed`/`extensionsRequired`.
- [x] AC-4 [local]: A skinned GLB and a GLB with morph targets each return `MESH_OPTIMIZE_UNSUPPORTED`, and no output file is written. — proof: `npx vitest run tests/mesh-optimize.integration.test.ts -t unsupported` — Evidence: 2026-10-29, test passes; both fixtures return `MESH_OPTIMIZE_UNSUPPORTED` and no `.glb`/`.before.png`/`.after.png` output exists.
- [x] AC-5 [local]: A 4096 px texture comes out at `maxTextureSize` (2048), and the gate still passes. — proof: `npx vitest run tests/mesh-optimize.integration.test.ts -t texture` — Evidence: 2026-10-29, test passes; 4096×4096 PNG → 2048×2048 PNG (MIME preserved), gate passed.
- [x] AC-6 [local]: A real scan of ≥500k triangles (Smithsonian 3D through this server) comes out ≥80% smaller with a passed gate. A before/after contact sheet goes to `~/Downloads/mesh-optimize/`, and the agent views it. — proof: `npx tsx scripts/probe-mesh-optimize.ts` — Evidence: 2026-10-29, probe passed. Egg carton scan 150,000 → 26,324 triangles (82.5% smaller), 7,355,816 → 1,976,928 bytes (73.1% smaller; textures dominate the bytes), gate passed at error 0.0005 (worst IoU 0.9965, worst gray difference 1.53%). Contact sheet: `~/Downloads/mesh-optimize/egg-carton-from-muslim-farms-150k-4096-contact-sheet.png` (viewed). No readable Smithsonian GLB reaches 500k triangles: the readable Download3D exports are 150k, and the 2000k-named High variants are Draco-compressed; the densest available class was used per the PRD fallback. Full data: `~/Downloads/mesh-optimize/probe-summary.json`.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Visual-safe mesh optimization | MCP `tools/call mesh_optimize` → `src/server.ts:350` registration → `src/tools/mesh-optimize.ts` → `src/optimize/mesh.ts` | New, nothing replaced | AC-1, AC-3, AC-4, AC-5, AC-6 |

## Execution Phases

#### Phase 1: Core pipeline and visual gate
**Status:** DONE (2026-10-29)
**Files:**
- `src/optimize/mesh.ts` (new) — `optimizeMesh(path, options)`: unsupported check, pipeline, error ladder, gate.
- `package.json` — add `meshoptimizer` 1.1.1 as a direct dependency.
**Implementation:**
- `await MeshoptSimplifier.ready` once per process.
- Gate reuses `renderPreview(bytes, { times: [0], angles: 6 })` from `src/rig/preview.ts`. Build the silhouette mask from the background color, then compute IoU and mean grayscale difference with `sharp` raw pixels.
- First, render one static GLB and look at the PNGs: confirm framing, background and time at 1M triangles. When `renderPreview` cannot serve a static mesh, add the smallest option it needs. Do not fork it.
- Errors use the existing error-envelope style of `src/tools/*`.
**Verification:** `npx vitest run tests/mesh-optimize.integration.test.ts -t gate` — AC-2. The test builds both fixtures in code with gltf-transform (no large binary in Git).

#### Phase 2: MCP tool wiring
**Status:** DONE (2026-10-29)
**Files:**
- `src/tools/mesh-optimize.ts` (new) — zod input/output schemas + handler.
- `src/server.ts` — `registerTool("mesh_optimize", …)` with `readOnlyHint: false`, `destructiveHint: false`, `openWorldHint: false`.
**Implementation:** The handler resolves paths, calls `optimizeMesh` and maps the result to structured content. Tests call the exported handler factory, as `tests/rig-preview.integration.test.ts` does with `createAssetAutoRigHandler`. Fixtures go in a new `tests/helpers/mesh-fixture.ts`, modeled on `tests/helpers/rig-fixture.ts`. `tests/mcp-smoke.test.ts` covers the `server.ts` registration.
**Verification:** `npx vitest run tests/mesh-optimize.integration.test.ts` — AC-1, AC-3, AC-4, AC-5. Then `npm run typecheck`.

#### Phase 3: Real-scan proof, calibration, docs
**Status:** DONE (2026-10-29)
**Files:**
- `scripts/probe-mesh-optimize.ts` (new) — downloads one dense Smithsonian scan with this server's tools, runs `mesh_optimize`, writes the contact sheet.
- `README.md` — `mesh_optimize` section: what it does, the static-only limit, what `kept: "original"` means.
**Implementation:** Run on 2–3 scans. When the gate passes a visible nerf or rejects a clean result, retune the IoU and grayscale thresholds and record the values under `## Decisions`. When no Smithsonian scan reaches 500k triangles, use the densest one available and record that.
**Verification:** `npx tsx scripts/probe-mesh-optimize.ts` + visual check of the contact sheet — AC-6.

## Decisions

### Phase 1 — gate mechanics (2026-10-29)

- **Camera framing.** `renderPreview`'s 1.7×max-dimension camera cropped a 2×2×1 static plate at the near edge
  (the plate touched the frame border in all six angles). Added `fitMargin` to `PreviewOptions` (default 1.7,
  so rig previews are unchanged); the mesh gate passes **2.2**, which leaves a visible margin on every angle.
  A 207k-triangle fixture renders six 384² angles in ~2 s under SwiftShader, so the gate is cheap enough to
  run once per ladder rung.
- **Silhouette mask.** Scene background is `0x202830`. A pixel belongs to the model when the sum of absolute
  RGB differences from that background exceeds **24**, which ignores the flat background exactly while keeping
  antialiased edge pixels.
- **Grayscale metric.** Rec.709 luma per pixel; score is the mean |Δluma| over the union of both silhouettes
  divided by 255. 2% therefore means ~5.1 gray levels. The union excludes background, so a large empty frame
  cannot dilute a real change.
- **Thresholds unchanged in Phase 1:** IoU ≥ 0.98 and gray ≤ 2% as specified. Phase 3 calibrates them on real
  scans.

### Phase 3 — calibration and real scans (2026-10-29)

- **Gate thresholds stay at IoU ≥ 0.98 / gray ≤ 2%.** Ten Smithsonian scans were optimized with the
  default ladder. Accepted-and-clean results measured 0.91–1.53% worst gray difference (Egg carton
  1.53%, Greek Slave 0.98%, Henry trough battery 0.91%, Page induction coil 1.13%); the first
  *visibly* nerfed candidate measured 3.47% (Greek Slave at error 0.005: 4,718 triangles, IoU 0.9731).
  A 3× crop shows the face, hair bun and drapery folds smoothed away, so raising the gray cap to
  ~3.5% would ship that nerf. Two other rejected candidates confirmed the same pattern: Side Chair at
  0.002 (6.14% gray, carved back visibly mushy) and Figure of a Dancer at 0.005 (10.22% gray, face
  lost). No retune.
- **The gate is deliberately conservative.** Assets whose cleanest rung still measures 2.19–2.56%
  (Side Chair, Figure of a Dancer at 0.0005) keep their original. That is the intended failure mode:
  `kept: "original"`, not a quiet degradation.
- **AC-6 density fallback.** All 21,457 Smithsonian GLB rows were inspected. 16,240 are 150k; the
  eight 2000k-named High variants use `KHR_draco_mesh_compression` and this server carries no Draco
  decoder. The readable (Download3D, `Low_resolution`) class tops out at 150k triangles, so per the
  PRD the densest available class was used. The `draco_compressed` flag is absent rather than `false`
  on those exports; the probe filters on flag *and* filename and then verifies by reading the GLB.
- **AC-6 "≥80% smaller" is measured in triangles:** 82.5%. Bytes fall 73.1% because three 2048px
  textures dominate the remaining file; shrinking textures further would be a visible change with a
  different default, not a mesh optimization. This matches the triangle-focused source idea and
  AC-1's wording.
- **`renderPreview` camera depth range now follows the model bounds.** The fixed near/far of
  0.01/1000 went blank on the Side Chair scan (957 units tall → framed camera distance ~2,105).
  `near = radius*0.001`, `far = radius*100` keeps metre-scale rigs visually unchanged and lets
  millimetre-scale scans render. Guarded by a scaled-fixture test.

## Out of scope (next PRDs)

- Normal-map baking from the original onto the simplified mesh (needs Blender or a ray-cast baker).
- Skinned and morph-target meshes (needs weight-aware simplification and a posed gate).
- LOD chains, KTX2 textures, Draco or meshopt output compression.
