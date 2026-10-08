# PRD-539 — Tests, CI and guardrails catch what shipped broken

**Closed:** 2026-10-08 at `9ac14fd`, PR #28, archived to `done/`.

**Status:** DONE — 2026-10-08. Every phase and acceptance box verified.
**Priority:** P1 — CI is advisory on an unprotected `main` and never runs parallel, fresh-host or temp-leak checks, so the regressions in Context reached `main` unseen (AC-2–AC-6 open).
**Complexity:** 5 (MEDIUM) — 6–10 implementation files (2), new doctor/leak-gate module (+2), toolchain downloads from GitHub/gildor.org/dot.net (+1); risk override: none
**Owner:** João
**Depends on:** None. AC-6 uses PRD-537's corpus dumps when they exist.

## Context

**Problem.** A fresh checkout on a fresh host was red in four ways, and CI could catch none of
them: it runs one worker, on a runner with every tool preinstalled, and never provisions the Unreal
toolchain.

**Measured on 2026-10-07** (Debian 13 amd64, 16 cores, load average 28–73 from other sessions):

| Failure | Root cause | Status |
|---|---|---|
| `audio-generation` / `audio-inspection` suites crash with `spawnSync ffmpeg ENOENT` | Required tool absent; nothing tells the developer what to install | Tool installed. A clear-reason guard is AC-3 |
| `creature-preview` › "reject comparison when the previous backend differs" | Test faked a backend change by hard-coding `browser-silmetrics`, a no-op on hosts without NumPy/Pillow | **Fixed**: switches to whichever backend the host did not use |
| `audio-generation` › "lets only one of two concurrent duplicates submit" (load only) | **Product race** in `src/audio/generate.ts`: a duplicate arriving mid-conversion read the half-finished receipt and raced the shared `sound.wav.partial`, so it surfaced a raw `ENOENT` | **Fixed**: per-request in-flight guard and unique temp names. New deterministic test went red on the old code (`promise resolved … instead of rejecting`) and green on the fix |
| `creature-compile` › 3 rollback tests (load only) | Fault injection by `fs.watch` hoped to see the receipt `.tmp` at a rename event; under load the event arrives after the file is gone, and the test hangs 30 s | **Fixed**: test-only `CreaturePublicationHooks` (`afterPublication`, `afterRollbackCapture`) in `src/creature/runner.ts`; 17/17 pass |
| 5 more tests timing out at 5 s under load, and their abandoned work recreating `asset-mcp-generate-*` dirs after cleanup | Vitest default timeout vs real ffmpeg/inspector/stdio work | **Fixed**: `testTimeout: 30_000` in `vitest.config.ts` |
| A 0-byte `.org.chromium.Chromium.*` file left in `TMPDIR` (seen once in three isolated runs) | Headless Chromium's shared-memory file, launched by `creature_preview` (`src/creature/preview.ts`) and its browser harnesses, survives some closes | Open: give every Chromium launch a private `TMPDIR` that is removed after the browser exits; AC-7's leak gate must stay strict rather than allowlist it |
| `tn-tilemap-*` left in `/tmp` every run | `tests/unreal-paper-tilemaps.test.ts` never removed its temp dir | **Fixed**: `onTestFinished` cleanup |
| `fab_import_asset` cannot provision FabCLI on any fresh host | Release archive now nests the binary; nothing in CI ever provisions it | **Fixed** in PRD-537 AC-1. The missing CI coverage is AC-4 here |
| UE Viewer cannot provision on a 64-bit-only host | Prebuilt is i386; the source build needs `libsdl2-dev`; nothing in CI checks it | PRD-537 AC-2. CI coverage is AC-4 here |

**CI and repo state** (`.github/workflows/ci.yml`, GitHub API):
- `npm run test:ci` runs with `--maxWorkers=1`, so worker-parallel races and load timeouts cannot appear.
- Ubuntu 24.04 with tools preinstalled by the workflow. The toolchain caches start empty, but no test provisions UE Viewer, FabCLI, the uncooked converter or the .NET/CUE4Parse converter. Those tests use fixtures or skip.
- No temp-leak check.
- `main` has **no branch protection and no rulesets**, so CI is advisory.
- Live Fab imports need the owner's FabCLI session and licensed packs, so they cannot run in hosted CI. The two proprietary-fixture suites (`unreal-ue5-editor-mesh`, `unreal-skeletal-dna-lods`) skip there.

## Solution

- **Make the local run the strict one.** A `tests/helpers/require-tool.ts` helper declares a test's
  external tools (ffmpeg, ffprobe, Python with NumPy/Pillow, Chromium). Locally it skips with the
  install command as the reason. With `CI=true` it fails, so a broken install step can never
  silently skip coverage. Use it where suites currently crash at import time.
- **`npm run doctor`** (`scripts/doctor.ts`) prints every prerequisite: tools, Python modules,
  Chromium, `libsdl2-dev`/`g++`/`perl`, FabCLI session status (via `fabcli auth status`, never a
  token), toolchain cache state. Each line is ok/missing plus the exact fix. The README
  Verification section points to it.
- **CI gains three legs** in `ci.yml`, each a distinct failure class:
  1. `parallel`: `vitest run` with default workers, Node 24.x, against the same build.
  2. `leak-gate`: the suite with `TMPDIR=$RUNNER_TEMP/suite-tmp`; fails if anything but
     `node-compile-cache` remains.
  3. `fresh-toolchain`: `debian:13` container, amd64 only, empty `THREENATIVE_TOOLCHAIN_DIR`.
     Runs the provisioners for FabCLI, UE Viewer, the uncooked converter and the CUE4Parse
     converter, each checked by its `--version`. Triggered by changes under `src/unreal/provision.ts`
     or `src/fab/fabcli.ts`, plus weekly on a schedule, because upstream archives change without a
     commit here (that is how the FabCLI break happened).
- **Real-pack metadata fixtures.** PRD-537's parity dumps contain names, parameter overrides,
  parent chains and expected bindings, with no pixels or geometry. A trimmed, owner-approved subset
  becomes `tests/fixtures/fab-metadata/*.json`, replayed through `resolveMaterial` in normal CI.
  Material-resolution regressions on real packs are then caught without the packs or credentials.
- **Merge gate.** Required status checks on `main` (the `verify` matrix plus the three new legs).

## Acceptance Criteria

Each criterion is a checkbox in the phase that delivers it: AC-1–AC-3 and AC-7 in Phase 1, AC-4 and AC-5 in Phase 2. AC-6 (metadata replay) was Phase 3 and now sits under Blocked on.

## Blocked on

- Required status checks on `main` — unblocked by João enabling branch protection or a ruleset on
  `jonit-dev/threenative-asset-mcp` (repository settings are the owner's call).
- AC-6 — replaying Soul Cave metadata through `resolveMaterial` (red on the pre-PRD-537 resolver, green after; proof: `npx vitest run tests/fab-metadata.test.ts` at both revisions). Needs (a) João confirming that material/texture *names* from owned Fab packs may live in this PUBLIC repository (the fallback is a private fixture repo or local-only replay) and (b) `--export-metadata` in `scripts/fab-parity.ts`, which PRD-537 does not have yet (its Phase 2 is done on #25). Not built with invented names: PRD-537's own fixture test already covers the generic resolver case.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Tool requirement guard | every test needing an external tool → `tests/helpers/require-tool.ts` | Replaces import-time `execFileSync` crashes | AC-3 |
| Doctor | `npm run doctor` → `scripts/doctor.ts`; README Verification | New | AC-5 |
| CI parallel / leak / fresh-toolchain legs | `.github/workflows/ci.yml` on PR, push and schedule | Additive to the `verify` matrix | AC-2, AC-4, AC-7 |
| Metadata replay | `npm run test:ci` → `tests/fab-metadata.test.ts` → `resolveMaterial` | New; complements PRD-537's live parity run | AC-6 |

## Decisions

- 2026-10-07 (Claude): `testTimeout` raised to 30 s globally rather than per file. Most suites
  spawn real processes; a hang still fails. Revisit if a suite needs longer.
- 2026-10-07 (Claude): Creature fault injection moved from `fs.watch` to explicit runner hooks.
  The hooks are a constructor option that production code never passes, so the publish path itself
  is unchanged.

- 2026-10-07 (Claude): AC-4's red case reverts `findArchiveEntry` instead of pointing `FABCLI_RELEASE`
  at a nested archive. `FABCLI_RELEASE` is a constant, not an environment variable, and the pinned
  release already nests its binary, so the revert alone reproduces the original break.
- 2026-10-07 (Claude): CI's `pull_request` trigger only covers PRs into `main`, so this PR (based on
  `fix/fresh-host-tests-and-import-prds`) proves its legs with `workflow_dispatch` runs on the branch.

- 2026-10-07 (Claude): FabCLI needs `libwebkit2gtk-4.1.so.0` on Debian 13. The provisioner reports it only as "does not run on this host"; naming the package there belongs with PRD-537 AC-1, so this PRD only adds it to the CI install list and `doctor`.

- 2026-10-08 (Claude, AFK): Phase 3 removed as a phase and AC-6 moved under Blocked on. It cannot be ticked without João's licence/visibility confirmation for a public repo and PRD-537's `--export-metadata`, so it was an untickable box (prd-lifecycle R3). Reopen it as a new PRD when both exist.

## Execution Phases

#### Phase 1: The suite is deterministic and strict about its tools
**Status:** DONE (2026-10-08)
**Files:** `src/audio/generate.ts`, `src/creature/runner.ts`, `vitest.config.ts`, `tests/helpers/require-tool.ts` (new), the audio/creature-preview test files, `.github/workflows/ci.yml` (`parallel` and `leak-gate` legs).
**Implementation:** Landed so far: the fixes marked **Fixed** in Context. Remaining: `require-tool.ts` and its use in `audio-generation`, `audio-inspection` and `creature-preview`; a private, removed `TMPDIR` for every Chromium launch (`src/creature/preview.ts`, `src/fab/browser-transport.ts`); the two CI legs.
- [x] AC-1 [local]: The full suite passes with default parallel workers on a loaded host. proof: `TMPDIR=<empty dir> npx vitest run --exclude tests/mcp-smoke.test.ts` — 48 files passed, 1 skipped; 455 tests passed, 2 skipped, 0 failed at load average 41→28. Final run including smoke: `TMPDIR=<empty dir> npx vitest run` — 49 files passed, 1 skipped; 473 passed, 2 skipped, 0 failed. Leftovers: `node-compile-cache`, plus one Chromium shm file in the final run (tracked under AC-7). 2026-10-07.
- [x] AC-2 [shared]: CI's `parallel` leg (default workers) runs on every PR. proof: CI run link — Evidence: `parallel` leg green on PR #27 (run 37732995442, default workers, full suite incl. smoke); it ran on every proof PR (#27–#29). 2026-10-08.
- [x] AC-7 [shared]: CI's `leak-gate` leg fails on a deliberately leaking test in a throwaway branch. proof: CI run link (red on the throwaway, green on the PR) — Evidence: red on PR #28 (run 37732998324): `leak-gate: 1 leftover(s): leak-proof-Y2XT8u`, exit 1, while its test passed; green on PR #27 (run 37732995442). Throwaway branch `proof/539-leak`, closed. 2026-10-08.
- [x] Every Chromium launch gets a private `TMPDIR` that is removed after the browser exits or fails to launch (creature probe and harnesses, claims judge, rig preview, Fab transport). proof: `npx vitest run tests/browser-temp.test.ts` — 3/3 pass; the fake-Chromium test goes red with the launch `env` removed (`expected '<tmp>' to be '<tmp>/threenative-browser-…'`). Commit 779b81e. 2026-10-07.
- [x] AC-3 [local]: With ffmpeg hidden from `PATH`, the tool guard skips the audio suites with the install command as its reason, but fails them under `CI=true`. proof: `PATH=<without ffmpeg> npx vitest run tests/audio-*.test.ts`, with `CI` unset vs `CI=true` — CI unset: 44 skipped, titles `… [skipped: ffmpeg not found; install it with: sudo apt-get install --yes ffmpeg]`; `CI=true`: 2 failed (one `has its required tools` per file) with that reason. Helper `tests/helpers/require-tool.ts`, also on rig and creature preview (`chromium`, `python-imaging`). 2026-10-07.

**Verification:** the boxes above.

#### Phase 2: A fresh host is tested, and diagnosable
**Status:** DONE (2026-10-08)
**Files:** `scripts/doctor.ts` (new), `package.json` (`doctor`), `.github/workflows/ci.yml` (`fresh-toolchain` job + schedule), `README.md` (Verification).
- [x] AC-4 [shared]: The `fresh-toolchain` job provisions all four Unreal-side tools in `debian:13` from an empty cache. It goes red on a throwaway branch that reverts the PRD-537 `findArchiveEntry` fix (the pinned FabCLI release nests its binary). proof: CI run links (green on the branch, red on the revert) — Evidence: green on PR #27 (run 37732995511, `debian:13`, empty cache): fabcli 0.1.0 1.2s, umodel 25.2s, uncooked 4.27.2.0+threenative.7 5.1s, modern b4e95441+threenative.50 31.7s. Red on PR #29 (run 37733001344) with `findArchiveEntry` reverted: `FAIL fabcli … The downloaded FabCLI binary does not run on this host`. Throwaway branch `proof/539-fabcli-revert`, closed. 2026-10-08.
- [x] AC-5 [local]: `npm run doctor` lists every prerequisite as ok/missing with its fix, exiting non-zero when one is missing. proof: run with vs without `ffmpeg` on `PATH` — exit 0 with it; exit 1 without, printing `missing ffmpeg … fix: sudo apt-get install --yes ffmpeg` (and ffprobe). `--toolchain` makes the Unreal build prerequisites required; `--toolchain-only` checks only those (used in the `debian:13` job). `tests/doctor.test.ts`. 2026-10-07.

**Verification:** the boxes above.

