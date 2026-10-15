# PRD-618 — Unity prefabs to GLB scenes

**Status:** IN PROGRESS (AC-1..AC-5 done; AC-6 partly met, AC-7 met 2026-10-15)
**Priority:** P2 — Asset Store packs are used through their prefabs, and AC-1..AC-6 do not exist yet.
**Complexity:** 5 (MEDIUM) — 1–5 implementation files (1), new prefab resolver (+2), complex reference state (+2); risk override: none
**Owner:** João
**Depends on:** PRD-615, PRD-616, PRD-617 (fidelity sweep)

## Context

A prefab is a Unity YAML file of GameObjects, Transforms, MeshFilters and MeshRenderers. The parts that need care
are documented in the [prefab YAML pages](https://docs.unity3d.com/Manual/yaml-prefab-serialization.html) and
implemented in Unidot's `object_adapter.gd` and `convert_scene.gd` (MIT, port with attribution):

- `MeshFilter.m_Mesh` points at a sub-object inside the FBX by fileID. The `.meta` maps it through
  `internalIDToNameTable` (2019.1+) or `fileIDToRecycleName` (older). If neither lists it, Unity derives the ID by
  hashing the type and name. Port Unidot's hash and check it against a real pack.
- `MeshRenderer.m_Materials` assigns a material per submesh slot and overrides the model's own binding.
- Nested prefabs are `PrefabInstance` documents: `m_SourcePrefab`, `m_Modifications` (`target` + `propertyPath` +
  `value`/`objectReference`), `m_RemovedComponents`, `m_RemovedGameObjects`, `m_AddedGameObjects`. Stripped
  documents stand in for objects of the source prefab through `m_CorrespondingSourceObject`.
- Variants are prefabs whose root is a `PrefabInstance`.
- Unity is left-handed (Y up, Z forward). Convert as UnityGLTF does: position `(x, y, −z)`, rotation `(−x, −y, z, w)`, and apply it once at the root.
- `LODGroup`: import LOD0 and report the other levels. Colliders and other components: report them and do not import.

## Solution

`src/unity/prefab.ts` builds a resolved node tree from a prefab (recursing into nested and variant sources, with a
cycle guard), then `src/unity/importer.ts` writes one GLB per prefab that reuses the PRD-616 mesh and material
output. `asset_import_unity` imports prefabs by default when a package has them and lists the unresolved
references in the report.

## Acceptance Criteria

- [x] AC-1 [local]: A synthetic prefab with a three-level hierarchy imports with the right world transforms after the
  handedness conversion (node matrices compared to expected values). proof: `npx vitest run tests/unity-prefab.test.ts -t hierarchy` — Evidence: `tests/unity-prefab.test.ts` (3 tests): the world matrix of each of three nodes equals the mirrored Unity product, and a deliberate removal of the z flip turns it red. 2026-10-14.
- [x] AC-2 [local]: `MeshFilter` refs resolve through `internalIDToNameTable`, `fileIDToRecycleName` and the derived
  hash, and a two-slot `MeshRenderer` assigns its own materials. proof: `npx vitest run tests/unity-prefab.test.ts -t meshes` — Evidence: `tests/unity-prefab.test.ts` (6 tests with `-t meshes`; the resolution test builds one prefab over a name-table FBX, a recycle-table FBX, a table-less FBX and a one-mesh FBX): the two-slot `Body` takes `red` and `green`, an empty slot keeps `Paint`/`Glass`, and ignoring slot overrides turns it red. The derived id is only checked against the importer's own function, so it stays unverified against a real pack. 2026-10-14.
- [x] AC-3 [local]: A nested prefab with a transform modification, a material override and a removed child, and a
  variant of it, both import with the modifications applied. proof: `npx vitest run tests/unity-prefab.test.ts -t nested` — Evidence: `tests/unity-prefab.test.ts` (5 tests): a transform edit, a rename, a removed child (with its collider), an added child under a stripped Transform, a material override on slot 0 (`Wheel` becomes `chrome`), a variant of the nested prefab that edits an inner object by its combined id, and a model used as a source. 2026-10-14.
- [x] AC-4 [local]: A prefab that references itself through a variant chain fails with a cycle error naming the
  chain, not a hang. proof: `npx vitest run tests/unity-prefab.test.ts -t cycle` — Evidence: `tests/unity-prefab.test.ts` (3 tests): a three-prefab chain and a self-reference fail with `Prefab cycle: A -> B -> C -> A` in `failed`, the other prefab still imports, and nesting beyond 32 levels is refused. 2026-10-14.
- [x] AC-5 [local]: `LODGroup` keeps LOD0, and colliders, LOD levels and unknown components are listed in the report.
  proof: `npx vitest run tests/unity-prefab.test.ts -t report` — Evidence: `tests/unity-prefab.test.ts` (5 tests): `LOD0` keeps its mesh, `LOD1` and `LOD2` do not and are listed with their transition heights; `BoxCollider`, `MeshCollider`, `MonoBehaviour` and `Light` are listed; a missing guid, a built-in mesh and a built-in material are `unresolved`. 2026-10-14.
- [ ] AC-6 [local]: On `U1`–`U3`, every prefab gives one GLB (`U3`: 1006 in, 1006 out; the listing says 458, the file holds 505 Built-in and 501 URP prefab documents) or a reported reason. Each
  prefab's size matches its `R1` bounds within 1 % where `R1` exists, and the sweep passes
  `fidelity-baseline.ts check`. proof: `npm run parity:unity` — Evidence: PARTLY MET, NOT TICKED. `npm run parity:unity -- --ids U1,U2 --max 40` and `--ids U3 --max 60` (importer 7, 2026-10-15). Met: every prefab gives a GLB or a reason (`U1` 31/31, `U2` 17/17, `U3` 1006/1006, 0 failed); 14 `U3` prefabs hold no mesh (cameras, particle systems) and still give a node-only GLB; 8 mesh references of two `U3` prefabs stay unresolved with a reason (a Maya mesh that Unity splits into numbered `..._MeshPart` parts). Not met: the `R1` size clause cannot run (no `R1` exists), and the `check` pass is weak evidence because the baseline was written from the same sweep it checks, so it can only show that numbers did not fall since. Defects found on the real packs and fixed, each with a red-to-green test in `tests/unity-prefab.test.ts`: the 64-bit mesh ids of real Unity 2022 prefabs are in no table (matched by GameObject name, UNVERIFIED warning), the Blender-FBX node (scale 100, turn -90 about X) was applied twice (a car 397 m long), a Maya node away from its pivot put parts 12 m apart, and the Unity 5 `Prefab` container document was reported as 502 unresolved instances.
- [x] AC-7 [local]: The PR comment embeds sheets per the epic's PR evidence rule. Before is the model-level import
  from PRD-616, and after is the prefab import, on a slice that covers multi-part prefabs (`U1`), per-slot
  material overrides (`U2`) and modular pieces (`U3`). Each piece is checked by eye. proof: PR screenshot comment — Evidence: https://github.com/ThreeNativeHQ/threenative-asset-mcp/pull/63#issuecomment-6198151490 (U1 before and after, U2 after, U3 before and after, each checked by eye; U2 has no reference picture, so its sheet shows our renders only: van, cars, motorcycle, seat and engine look right by eye; 2026-10-15).

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Prefab import | `asset_import_unity` → `src/unity/prefab.ts` | Extends PRD-616's tool | AC-1..AC-5 |

## Risk: Y rotation of prefab children (measured on U1 and U3, 2026-10-15)

The reviewer's suspicion was right: with the old node chain every asymmetric `U1` piece matched Unity's own preview only
after about 100 degrees of extra yaw (95-105 on 12 pieces). Unity mirrors X when it imports an FBX and the prefab chain flips Z, so
the model's mesh needs a half turn about Y. The fix places each FBX mesh in Unity's mesh space (`fbxMeshFrame`, `HALF_TURN_Y` in
`src/unity/prefab-glb.ts`) and keeps only the file node's translation. After it the best yaw fell to 270-285 degrees on `U1`
and 270 on 7 of 11 multi-part `U3` prefabs (silhouette IoU 0.62-0.85; three more at 300-330, and one thin plant matched nowhere). That
residual is the difference between Unity's preview camera and ours, predicted at 280. Parts of multi-part prefabs (clusters, a lidded box) sit where Unity puts them. Still unverified: the camera values come from memory of Unity's preview
code, and no `R1` render exists.

## Execution Phases

#### Phase 1: Hierarchy and meshes
**Status:** DONE (synthetic packs)
**Files:** `src/unity/prefab.ts` (new), `src/unity/prefab-glb.ts` (new), `src/unity/model-ids.ts` (new), `src/unity/importer.ts`, `tests/unity-prefab.test.ts` (new)
**Verification:** AC-1, AC-2.

#### Phase 2: Nested prefabs and variants
**Status:** DONE (synthetic packs)
**Files:** `src/unity/prefab.ts`, `tests/unity-prefab.test.ts`
**Verification:** AC-3, AC-4, AC-5.

#### Phase 3: Real packs
**Status:** NOT STARTED
**Files:** `docs/unity-format-support.md`, `docs/parity/fidelity-baseline.json`
**Verification:** AC-6, AC-7.
