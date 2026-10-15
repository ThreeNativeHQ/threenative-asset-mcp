# PRD-620 — REA reference study of Unity import semantics

**Status:** DONE (2026-10-15)
**Decision:** João allowed the study on 2026-10-15: behaviour only, notes in our own words, no copied code, no Asset Store download or Hub code.
**Priority:** P3 — optional accuracy input for PRD-616 and PRD-618. 
**Complexity:** 1 (LOW) — documentation in a private repo, no implementation files here; risk override: none
**Owner:** João
**Depends on:** None

## Context

[REA](https://github.com/morluto/rea) (MIT, npm `rea-agents`) analyzes native binaries, Electron apps and .NET
assemblies. On 2026-10-09 it produced the private `unreal-rea-docs` reference (importer docs, functional
requirements, evidence). Most Unity semantics are documented or open: the manuals, the built-in shader source
archive and the Graphics repo, which may be read but not copied. The gaps are binary-only:

- The native FBX importer: unit scale, axis conversion, normal and tangent import or calculation, material naming,
  and the derived fileID hash (PRD-618 AC-2).
- TextureImporter conversions: `convertToNormalMap` and alpha from greyscale.

Limits:

- REA never analyzes the Asset Store download, decryption or Hub sign-in code (Asset Store Terms §3.8(ii)).
- Run it with a permitted save-tokens model. DeepSeek is excluded.
- The notes stay in a private `unity-rea-docs` repo beside `unreal-rea-docs`, and nothing from Unity binaries
  enters this repository.

## Acceptance Criteria

- [x] AC-1 [local]: `unity-rea-docs` exists with the `unreal-rea-docs` layout (importers, reference, run log), and
  records the analyzed Editor version and its hashes. proof: repo listing — Evidence: private local repo `~/projects/unity-rea-docs`
  (never pushed), with the Editor version, changeset and file hashes. 2026-10-15.
- [x] AC-2 [local]: Each gap above has a functional requirement with its evidence (REA command and excerpt) or the
  status Inferred. proof: `reference/functional-requirements.md` — Evidence: FR-M1..M6 (derived ids), FR-F1..F6 (FBX), FR-T1..T6 (textures),
  FR-S1..S2 (built-in shader ids), FR-X1..X2 (not found). Verified on real data: FR-M1, FR-M2, FR-S1. 2026-10-15.
- [x] AC-3 [local]: Each verified requirement is linked to a test in PRD-616 or PRD-618, or to a new ledger row.
  proof: the links in `reference/functional-requirements.md` — Evidence: FR-M1 and FR-M2 link to `tests/unity-prefab.test.ts`
  (`meshes`, `model root ids`) and two ledger rows. FR-T1 links to `tests/unity-textures.test.ts` and a ledger row. `UNITY_IMPORTER_VERSION` 8.
  `npm run parity:unity -- --ids U2`: 17 of 17 mesh nodes resolve with no UNVERIFIED warning. 2026-10-15.

## Outcome (requirement ids and one-line behaviour only)

- FR-M1: a generated mesh id is the signed XXH64 (seed 0) of `Type:Mesh->` + name + a counter that starts at 0.
- FR-M2: the model root GameObject and Transform ids derive the same way from the paths `//RootNode/root` and `//RootNode/root/Transform`.
- FR-T1: `convertToNormalMap` turns the mean RGB into a height with gain `(w + h) * (10^bumpiness - 1) / 100`, takes a wrapping smooth or Sobel slope, and stores `normalize(-dx, -dy, 1) * 0.5 + 0.5`.
- FR-S2: built-in shader ids other than 45 and 46 are not Standard shaders, so their materials fall back as before.
- Not found: the preview gains of `U1` and the black metallic bottle (FR-X1, FR-X2); child and component ids (FR-M3) are inferred.

## Integration Ledger

Integration: the notes are private. The public repo gets own code and tests for FR-M1, FR-M2 and FR-T1, and ledger rows.

## Execution Phases

#### Phase 1: Study
**Status:** DONE
**Verification:** AC-1, AC-2, AC-3.
