# PRD-620 — REA reference study of Unity import semantics

**Status:** BLOCKED
**Blocker:** João must decide whether reverse engineering the Unity Editor is permitted under its license.
**Priority:** P3 — optional accuracy input for PRD-616 and PRD-618. AC-1..AC-3 only start after the decision.
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

- [ ] AC-1 [local]: `unity-rea-docs` exists with the `unreal-rea-docs` layout (importers, reference, run log), and
  records the analyzed Editor version and its hashes. proof: repo listing — Evidence: pending.
- [ ] AC-2 [local]: Each gap above has a functional requirement with its evidence (REA command and excerpt) or the
  status Inferred. proof: `reference/functional-requirements.md` — Evidence: pending.
- [ ] AC-3 [local]: Each verified requirement is linked to a test in PRD-616 or PRD-618, or to a new ledger row.
  proof: the links in `reference/functional-requirements.md` — Evidence: pending.

## Blocked on

- João: decide whether the Unity Editor license permits this analysis. If it does not, close this PRD as moot and
  rely on manuals, open sources and the PRD-617 measurements.
- A Unity Editor install on this machine (version chosen by João).

## Integration Ledger

Integration: unchanged — this PRD produces private reference notes only.

## Execution Phases

#### Phase 1: Study
**Status:** NOT STARTED
**Verification:** AC-1, AC-2, AC-3.
