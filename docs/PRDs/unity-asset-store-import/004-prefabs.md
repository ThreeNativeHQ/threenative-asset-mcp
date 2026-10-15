# PRD-618 — Unity prefabs to GLB scenes

**Status:** NOT STARTED
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

- [ ] AC-1 [local]: A synthetic prefab with a three-level hierarchy imports with the right world transforms after the
  handedness conversion (node matrices compared to expected values). proof: `npx vitest run tests/unity-prefab.test.ts -t hierarchy` — Evidence: pending.
- [ ] AC-2 [local]: `MeshFilter` refs resolve through `internalIDToNameTable`, `fileIDToRecycleName` and the derived
  hash, and a two-slot `MeshRenderer` assigns its own materials. proof: `npx vitest run tests/unity-prefab.test.ts -t meshes` — Evidence: pending.
- [ ] AC-3 [local]: A nested prefab with a transform modification, a material override and a removed child, and a
  variant of it, both import with the modifications applied. proof: `npx vitest run tests/unity-prefab.test.ts -t nested` — Evidence: pending.
- [ ] AC-4 [local]: A prefab that references itself through a variant chain fails with a cycle error naming the
  chain, not a hang. proof: `npx vitest run tests/unity-prefab.test.ts -t cycle` — Evidence: pending.
- [ ] AC-5 [local]: `LODGroup` keeps LOD0, and colliders, LOD levels and unknown components are listed in the report.
  proof: `npx vitest run tests/unity-prefab.test.ts -t report` — Evidence: pending.
- [ ] AC-6 [local]: On `U1`–`U3`, every prefab gives one GLB (`U3`: 458 in, 458 out) or a reported reason. Each
  prefab's size matches its `R1` bounds within 1 % where `R1` exists, and the sweep passes
  `fidelity-baseline.ts check`. proof: `npm run parity:unity` — Evidence: pending.
- [ ] AC-7 [local]: The PR comment embeds sheets per the epic's PR evidence rule. Before is the model-level import
  from PRD-616, and after is the prefab import, on a slice that covers multi-part prefabs (`U1`), per-slot
  material overrides (`U2`) and modular pieces (`U3`). Each piece is checked by eye. proof: PR screenshot comment — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Prefab import | `asset_import_unity` → `src/unity/prefab.ts` | Extends PRD-616's tool | AC-1..AC-5 |

## Execution Phases

#### Phase 1: Hierarchy and meshes
**Status:** NOT STARTED
**Files:** `src/unity/prefab.ts` (new), `src/unity/importer.ts`, `tests/unity-prefab.test.ts` (new)
**Verification:** AC-1, AC-2.

#### Phase 2: Nested prefabs and variants
**Status:** NOT STARTED
**Files:** `src/unity/prefab.ts`, `tests/unity-prefab.test.ts`
**Verification:** AC-3, AC-4, AC-5.

#### Phase 3: Real packs
**Status:** NOT STARTED
**Files:** `docs/unity-format-support.md`, `docs/parity/fidelity-baseline.json`
**Verification:** AC-6, AC-7.
