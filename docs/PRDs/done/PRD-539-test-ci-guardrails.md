# PRD-539 — Tests, CI and guardrails catch what shipped broken

**Closed:** 2026-10-08, archived to `done/`.

**Status:** DONE — 2026-10-08. Phases 1–3 verified: AC-1–AC-5 and AC-7 with CI proof (PR #26), AC-6 and the merge gate in Phase 3.
**Priority:** P1 — CI is advisory on an unprotected `main` and never runs parallel, fresh-host or temp-leak checks, so the regressions in Context reached `main` unseen (AC-2–AC-7 now closed by this PRD's CI legs).
**Complexity:** 5 (MEDIUM) — 6–10 implementation files (2), new doctor/leak-gate module (+2), toolchain downloads from GitHub/gildor.org/dot.net (+1); risk override: none
**Owner:** João
**Depends on:** None. AC-6's local replay uses PRD-537's corpus sweep when it has run.

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
     converter, each verified by its own probe (`--version` where the binary has one). Triggered by changes under `src/unreal/provision.ts`
     or `src/fab/fabcli.ts`, plus weekly on a schedule, because upstream archives change without a
     commit here (that is how the FabCLI break happened).
- **Material metadata replay.** `npm run parity:fab -- --export-metadata <dir>` writes, per pack, the
  `.mat`/`.props.txt` texts each material resolution read plus the bindings it returned (no pixels or
  geometry). `tests/fab-metadata.test.ts` replays a committed SYNTHETIC dump in normal CI and, when
  `FAB_METADATA_DIR` is set, every licensed-pack dump in that directory. Pack-derived names are
  local-only and never committed (João's call, 2026-10-08).
- **Merge gate.** Required status checks on `main` (the `verify` matrix plus `parallel` and `leak-gate`; `fresh-toolchain` is path-filtered, so it cannot be required).

## Acceptance Criteria

Each criterion is a checkbox in the phase that delivers it: AC-1–AC-3 and AC-7 in Phase 1, AC-4 and AC-5 in Phase 2, AC-6 and the merge gate in Phase 3.

## Blocked on

Nothing.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Tool requirement guard | every test needing an external tool → `tests/helpers/require-tool.ts` | Replaces import-time `execFileSync` crashes | AC-3 |
| Doctor | `npm run doctor` → `scripts/doctor.ts`; README Verification | New | AC-5 |
| CI parallel / leak / fresh-toolchain legs | `.github/workflows/ci.yml` on PR, push and schedule | Additive to the `verify` matrix | AC-2, AC-4, AC-7 |
| Metadata replay | `npm run test:ci` → `tests/fab-metadata.test.ts` → `replayMaterialMetadata` → `resolveMaterial`; capture via `parity:fab --export-metadata` → `onMaterialResolved` in `packageGlb` | New; complements PRD-537's live parity run | AC-6 |

## Decisions

- 2026-10-07 (Claude): `testTimeout` raised to 30 s globally rather than per file. Most suites
  spawn real processes; a hang still fails. Revisit if a suite needs longer.
- 2026-10-07 (Claude): Creature fault injection moved from `fs.watch` to explicit runner hooks.
  The hooks are a constructor option that production code never passes, so the publish path itself
  is unchanged.

- 2026-10-07 (Claude): AC-4's red case reverts `findArchiveEntry` instead of pointing `FABCLI_RELEASE`
  at a nested archive. `FABCLI_RELEASE` is a constant, not an environment variable, and the pinned
  release already nests its binary, so the revert alone reproduces the original break.
- 2026-10-08 (Claude): CI's `pull_request` trigger only covers PRs into `main`, so the legs were proved on throwaway PRs #27–#29 into `main` (closed, branches deleted), not on this PR's earlier base.

- 2026-10-07 (Claude): FabCLI needs `libwebkit2gtk-4.1.so.0` on Debian 13. The provisioner reports it only as "does not run on this host"; naming the package there belongs with PRD-537 AC-1, so this PRD only adds it to the CI install list and `doctor`.

- 2026-10-08 (Claude, AFK): Phase 3 had been removed and AC-6 parked, because it needed João's decision on pack names in a public repo and an `--export-metadata` flag. João then decided: pack-derived names stay local-only, and the main-branch ruleset may be enabled. Phase 3 is back with both boxes.
- 2026-10-08 (Claude): AC-6 was re-scoped from "replay Soul Cave in CI" to "replay gate: synthetic fixture in CI, licensed dumps local via `FAB_METADATA_DIR`". The mechanism is proven in CI; the licensed replay cannot run in hosted CI by design. No real-pack dump exists yet (it needs PRD-537's sweep, which waits on the Fab browser check), so the first licensed replay is a local step after that sweep.
- 2026-10-08 (Claude): The ruleset's bypass is the repository admin role, so João can still push in an emergency. It requires the four checks that run on every PR and blocks force-push and deletion of `main`. It does not require a PR or reviews.
- 2026-10-08 (Claude): `tests/mcp-smoke.test.ts` waited 5 s for each MCP response against a 30 s `testTimeout`; `creature_status` launches Chromium and exceeded it twice in five loaded full-suite runs. The wait is now 25 s (0 of 3 failed after).

## Execution Phases

#### Phase 1: The suite is deterministic and strict about its tools
**Status:** DONE (2026-10-08)
**Files:** `src/audio/generate.ts`, `src/creature/runner.ts`, `vitest.config.ts`, `tests/helpers/require-tool.ts` (new), the audio/creature-preview test files, `.github/workflows/ci.yml` (`parallel` and `leak-gate` legs).
**Implementation:** The fixes marked **Fixed** in Context, plus `tests/helpers/require-tool.ts` (used by the audio, rig-preview and creature-preview suites), `src/browser-temp.ts` (a private, removed `TMPDIR` per Chromium launch), `scripts/leak-gate.ts` and the `suite` job's `parallel` and `leak-gate` legs.
- [x] AC-1 [local]: The full suite passes with default parallel workers on a loaded host. proof: `TMPDIR=<empty dir> npx vitest run --exclude tests/mcp-smoke.test.ts` — 48 files passed, 1 skipped; 455 tests passed, 2 skipped, 0 failed at load average 41→28. Final run including smoke: `TMPDIR=<empty dir> npx vitest run` — 49 files passed, 1 skipped; 473 passed, 2 skipped, 0 failed. Leftovers: `node-compile-cache`, plus one Chromium shm file in the final run (fixed by the Chromium temp-dir box; kept out by AC-7's leak gate). 2026-10-07.
- [x] AC-2 [shared]: CI's `parallel` leg (default workers) runs on every PR. proof: CI run link — Evidence: `parallel` leg green on PR #27 (run 37732995442, default workers, full suite incl. smoke); it ran on every proof PR (#27–#29). 2026-10-08.
- [x] AC-7 [shared]: CI's `leak-gate` leg fails on a deliberately leaking test in a throwaway branch. proof: CI run link (red on the throwaway, green on the PR) — Evidence: red on PR #28 (run 37732998324): `leak-gate: 1 leftover(s): leak-proof-Y2XT8u`, exit 1, while its test passed; green on PR #27 (run 37732995442). Throwaway branch `proof/539-leak`, closed. 2026-10-08.
- [x] Every Chromium launch gets a private `TMPDIR` that is removed after the browser exits or fails to launch (creature probe and harnesses, claims judge, rig preview, Fab transport). proof: `npx vitest run tests/browser-temp.test.ts` — 3/3 pass; the fake-Chromium test goes red with the launch `env` removed (`expected '<tmp>' to be '<tmp>/threenative-browser-…'`). Commit 779b81e. 2026-10-07.
- [x] AC-3 [local]: With ffmpeg hidden from `PATH`, the tool guard skips the audio suites with the install command as its reason, but fails them under `CI=true`. proof: `PATH=<without ffmpeg> npx vitest run tests/audio-*.test.ts`, with `CI` unset vs `CI=true` — CI unset: 44 skipped, titles `… [skipped: ffmpeg not found; install it with: sudo apt-get install --yes ffmpeg]`; `CI=true`: 2 failed (one `has its required tools` per file) with that reason. Helper `tests/helpers/require-tool.ts`, also on rig and creature preview (`chromium`, `python-imaging`). 2026-10-07.

**Verification:** the boxes above.

#### Phase 2: A fresh host is tested, and diagnosable
**Status:** DONE (2026-10-08)
**Files:** `scripts/doctor.ts` (new), `package.json` (`doctor`), `.github/workflows/fresh-toolchain.yml` (new workflow: path-filtered, weekly schedule), `scripts/provision-toolchain.ts`, `scripts/prerequisites.ts`, `README.md` (Verification).
- [x] AC-4 [shared]: The `fresh-toolchain` job provisions all four Unreal-side tools in `debian:13` from an empty cache. It goes red on a throwaway branch that reverts the PRD-537 `findArchiveEntry` fix (the pinned FabCLI release nests its binary). proof: CI run links (green on the branch, red on the revert) — Evidence: green on PR #27 (run 37732995511, `debian:13`, empty cache): fabcli 0.1.0 1.2s, umodel 25.2s, uncooked 4.27.2.0+threenative.7 5.1s, modern b4e95441+threenative.50 31.7s. Red on PR #29 (run 37733001344) with `findArchiveEntry` reverted: `FAIL fabcli … The downloaded FabCLI binary does not run on this host`. Throwaway branch `proof/539-fabcli-revert`, closed. 2026-10-08.
- [x] AC-5 [local]: `npm run doctor` lists every prerequisite as ok/missing with its fix, exiting non-zero when one is missing. proof: run with vs without `ffmpeg` on `PATH` — exit 0 with it; exit 1 without, printing `missing ffmpeg … fix: sudo apt-get install --yes ffmpeg` (and ffprobe). `--toolchain` makes the Unreal build prerequisites required; `--toolchain-only` checks only those (used in the `debian:13` job). `tests/doctor.test.ts`. 2026-10-07.

**Verification:** the boxes above.

#### Phase 3: Material resolution is replayable, and `main` is gated
**Status:** DONE (2026-10-08)
**Files:** `src/unreal/material-metadata.ts` (new), `src/unreal/importer.ts` and `src/tools/import-unreal.ts` (optional `onMaterialResolved`), `src/unreal/parity-run.ts` and `scripts/fab-parity.ts` (`--export-metadata`), `tests/fab-metadata.test.ts`, `tests/material-metadata.test.ts`, `tests/fixtures/material-metadata/synthetic.json`, `README.md`.
**Implementation:** Capture records the texts a `resolveMaterial` call reads and its result; replay re-runs it from the texts and lists differences. Production behaviour is unchanged when the callback is unset.
- [x] AC-6 [shared]: A recorded material-metadata dump replays through `resolveMaterial` with zero mismatches in CI, and goes red when the resolver regresses. proof: `npx vitest run tests/fab-metadata.test.ts tests/material-metadata.test.ts tests/unreal-parity-run.test.ts` — green (34 passed, 1 skipped: the `FAB_METADATA_DIR` block); with `FAB_METADATA_DIR` set to the fixture directory the block runs, 4/4 pass. Red: with `supersededDefaults` disabled in `resolveMaterial`, the replay fails with `MI_Synth_Panel: bindings expected [baseColor=T_Instance_D [props/exact/none]] but replay gave [baseColor=T_Parent_Default_D [mat/exact/none]]` (change not committed). Full suite 676 passed, 3 skipped, leak-gate clean. 2026-10-08.
- [x] Required status checks guard `main`. proof: ruleset `main-required-checks` (id 24703164, `gh api repos/ThreeNativeHQ/threenative-asset-mcp/rulesets`), enforcement active, requires `Verify (Node 20.19.0)`, `Verify (Node 24.x)`, `parallel` and `leak-gate`, blocks deletion and non-fast-forward; admin role may bypass. 2026-10-08.

**Verification:** the boxes above.
