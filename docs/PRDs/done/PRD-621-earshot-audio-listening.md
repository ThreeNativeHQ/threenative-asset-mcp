# PRD-621 — earshot as a companion listener and the prompt-fit backend

**Status:** DONE 2026-10-16
**Priority:** P2 — prompt fit has no qualified model: AUDIO_GENERATION_PRD AC-6 (16/20 holdout) is still open, and AC-1..AC-6 here are open.
**Complexity:** 2 (LOW)
**Owner:** João
**Depends on:** None

Complexity: 2 → LOW; risk override: none. Implementation files 1–5 (+1), external tool integration (+1). The
backend is opt-in and set up by hand, like CLAP, so default installs and CI do not change.

## Context

The audio tools find, download, generate (ElevenLabs, paid per call) and inspect sounds (`docs/audio.md`).
`audio_inspect_asset` sets `recommendation` from technical status plus an optional semantic result
(`src/audio/inspect.ts:509-521`). The only semantic backend is LAION-CLAP through `AUDIO_CLAP_PYTHON`
(`src/audio/semantic.ts`, `scripts/audio-semantic.py`), with `CALIBRATION_ID`
`clap-630k-audioset-best/v1-uncalibrated`. It checks prompt fit (content) and mood (emotion).

The PRD that built these tools, `outputs/AUDIO_GENERATION_PRD.md`, is IN PROGRESS. Two of its open criteria matter here:

- **AC-6** — the frozen opt-in model ranks the intended description above concrete wrong alternatives on at least
  16 of 20 held-out clips (impacts/foley, tonal cues, mechanical, ambience), after 10 tuning clips, and a
  technically clean wrong sound goes down the mismatch path. Blocked since 2026-09-16 on an unprovisioned model.
- **AC-9** — mood, 5 of 6 matches and 5 of 6 mismatches on listener-annotated clips. Mood checking is
  user-confirmed scope and stays with CLAP.

[earshot](https://github.com/Leonxlnx/earshot) (MIT, Python, CPU; CLAP `laion/larger_clap_general` plus the AudioSet
AST tagger, about 1.4 GB of models) gives agents ears. It ships its own MCP server (models stay loaded) with
`describe`, `match`, `rank`, `find`, `compare`, `ab`, `realness`, `timeline`, `sheet` and `critique`. `forge`
(synthesize a click, impact, keypress, pluck, pop or whoosh in code and improve it by listening) is CLI and Python
only. Its `match` verdict (strong / plausible / weak / no match) is a z-score over a 322-description vocabulary
with published held-out results. That is the calibrated prompt-fit check AC-6 asks for.

Facts found on 2026-10-16 that shape the plan:

- earshot was created on 2026-10-15: `0.1.0`, alpha, one author, unpinned `torch>=2.6` / `transformers>=4.40`.
- Each CLI call loads both models (20–40 s on the author's laptop). This desktop often runs at load 40–70.
- This server has no MCP client package and talks to no other MCP server (`package.json:71-82`).
- The engine ships only npm servers launched with `node` (`threenative-engine/packages/core/mcp/servers.mjs:6-45`).
  An external tool the user installs, like Blender, is documented, not wired
  (`packages/create-threenative/agent-docs/references/finding-assets.md:195`).
- Catalog items are ZIP archives and no audio tool extracts them (`src/audio/catalog.ts:175-211`,
  `src/audio/client.ts:212-236`).

## Solution

Two parts, and nothing else:

1. **Companion, no code.** Agents run earshot's own MCP server beside this one, and its CLI for `forge`. The docs
   give the pinned install and the loop: find or download (unzip) → generate or forge → `audio_inspect_asset` for
   defects → earshot `match` / `rank` / `ab` to listen → revise one property → repeat. Custom game recipes (coin,
   laser, footstep) need no fork: `earshot.forge.forge()` accepts a recipe module, so the docs show a short
   Python snippet that loads a recipe file and runs the same search and critic.
2. **`semantic: "earshot"` for prompt fit.** `audio_inspect_asset` and `audio_generate_sound` can ask earshot for
   the content check, so its verdict reaches `recommendation`. CLAP stays the only mood backend.

```
audio_inspect_asset / audio_generate_sound  (semantic: "earshot", expectedPrompt, alternativePrompts)
  → inspect.ts semantics() → semantic.ts
  → execFile($AUDIO_EARSHOT_BIN, ["match", path, expectedPrompt, "--alts", ...alternativePrompts, "--json"])
  → strong | plausible → "consistent";  weak | no match → "possible_mismatch";  any failure → "unverified"
```

- `AUDIO_EARSHOT_BIN` names the `earshot` executable in its venv. Unset, missing, a timeout or unreadable JSON
  returns `unverified` with the setup instruction, never a pass. Generation preflight refuses
  `semantic: "earshot"` before spending when the binary does not answer.
- One process per call, as the CLAP adapter does now. Earshot calls get their own 180 s timeout.
  `// ponytail: cold model load per call; reuse a warm earshot process if inspection latency matters.`
- A request that asks for `emotion` with `semantic: "earshot"` fails schema validation. The message names
  `semantic: "clap"`.
- Results keep the `SemanticContentResult` shape: `ranked` holds the prompt and alternatives with their scores,
  `margin` the z gap, `calibrationId` `earshot-<commit>/match-z`. Scores stay supporting evidence;
  `artisticQuality` stays `"unverified"`.
- Mapping strong and plausible to `consistent` is the frozen policy. It is fixed on the tuning clips before the
  holdout runs and does not change after.

## Acceptance Criteria

- [x] AC-1 [local]: `audio_inspect_asset` with `semantic: "earshot"` returns `promptFit: "consistent"` for a strong
  verdict and `"possible_mismatch"` with `recommendation: "review"` for a weak one, through the tool handler, with a
  fake `earshot` binary that prints JSON recorded from the real CLI — proof: `npx vitest run tests/audio-inspection.test.ts` — Evidence: 2026-10-16, `tests/audio-inspection.test.ts` "semantic: earshot" passes with fixtures recorded from the real CLI at 108763c (`tests/fixtures/earshot/`).
- [x] AC-2 [local]: With `AUDIO_EARSHOT_BIN` unset, a timeout, or unreadable output, inspection returns
  `unverified` plus the setup instruction, and generation refuses before any ElevenLabs request — proof:
  `npx vitest run tests/audio-inspection.test.ts tests/audio-generation.test.ts` — Evidence: 2026-10-16, both suites pass (unset, exit 1 and unreadable output stay `unverified`; generation refuses before any request).
- [x] AC-3 [local]: `emotion` with `semantic: "earshot"` is rejected with a message naming `semantic: "clap"`, and the
  existing CLAP content and mood tests still pass — proof: `npx vitest run tests/audio-inspection.test.ts` — Evidence: 2026-10-16, schema test passes; CLAP tests unchanged and green.
- [x] AC-4 [local]: The real pinned earshot, through `audio_inspect_asset`, ranks the intended description first on
  at least 16 of 20 held-out clips across impacts/foley, tonal cues, mechanical and ambience, and a technically clean
  wrong sound returns `possible_mismatch`; per-clip results are recorded here and on AUDIO_GENERATION_PRD AC-6 —
  proof: `npx tsx scripts/earshot-holdout.ts` — Evidence: 2026-10-16, `npx tsx scripts/earshot-holdout.ts` against the real pinned earshot: 17/20 holdout clips ranked first (5 each across tonal, impacts, mechanical, ambience; tonal 3/5, impacts 4/5, mechanical 5/5, ambience 5/5), and a clean wrong sound returned `possible_mismatch`. Sources differ from the plan because Sonniss answers non-browser clients with a Cloudflare 403: CC0 Kenney packs (interface, impact, rpg, sci-fi) and public-domain Wikimedia Commons field recordings (ambience) stand in. Per-clip names stay out of the repo. Strong/plausible-to-consistent is stricter than rank-first: several ranked-first clips with generic filename descriptions got `possible_mismatch`, which is the safe direction.
- [x] AC-5 [local]: The documented install, run from an empty venv on the laptop, ends with `earshot doctor --load`
  passing at the pinned commit — proof: the commands in `docs/audio.md` "earshot companion" — Evidence: 2026-10-16, empty venv on the desktop (not the laptop: its SSH host key failed verification), torch 2.14.1+cpu, transformers 5.20.1, `earshot doctor --load` printed `problems: []`.
- [x] AC-6 [local]: Typecheck and the full suite are green with no temp leftovers — proof:
  `npm run typecheck && npm run test:leaks` — Evidence: 2026-10-16, typecheck clean; `npm run test:leaks` 2798 passed, "leak-gate: clean" (two failures seen first were a stale `dist/`, green after `npm run build`).

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Calibrated prompt fit | `audio_inspect_asset` / `audio_generate_sound` → `src/audio/inspect.ts` `semantics()` → `src/audio/semantic.ts` | Second content backend beside CLAP; CLAP keeps content and stays the only mood backend (AC-9) | AC-1..AC-4 |
| Listening, ranking, A/B, forge | earshot's own MCP server and CLI, set up from `docs/audio.md` | New, outside this server; no code here | AC-5 |

## Decisions

- 2026-10-16 (Claude, AFK): the holdout uses CC0 Kenney packs and public-domain Commons recordings instead of Sonniss, which blocks non-browser downloads. Reversible: rerun the script with `--sonniss <dir>` to add Sonniss clips.

- 2026-10-16 (João, Claude): earshot runs as a companion server, not proxied through this one, copied in,
  rewritten or published as a renamed package. Its own MCP server keeps the models loaded; proxying needs a new
  MCP client dependency; a renamed package adds a release process and loses upstream fixes while upstream changes
  daily.
- 2026-10-16 (João, Claude): CLAP is not deleted. Mood checking is user-confirmed scope (AUDIO_GENERATION_PRD
  AC-9) and earshot has no mood check.
- 2026-10-16 (João, Claude): no `audio_rank_assets` tool. earshot's MCP `rank` already does it.
- 2026-10-16 (João, Claude): `timeline` and `sheet` (sound-to-picture sync) belong in an engine playtest PRD;
  `critique` and `profile` score launch films and are out of scope.
- 2026-10-16 (Claude): install from the upstream repo at an exact commit SHA. A fork under ThreeNativeHQ would keep
  that commit available if upstream rewrites history; it is visible outside this machine, so it waits for João's
  approval and is not required for closure. If approved, only the install URL changes.

## Execution Phases

#### Phase 1: `semantic: "earshot"` in inspection and generation
**Status:** DONE
**Files:** `src/audio/semantic.ts` (earshot call, verdict mapping, availability), `src/audio/inspect.ts` (route the
backend), `src/tools/audio.ts` (enum value, refine rules), `src/audio/generate.ts` (preflight),
`tests/fixtures/earshot/*.json` (recorded real output).
**Implementation:** Install earshot at the pinned commit in a scratch venv with CPU torch. Record real
`match --json` output for one strong and one weak case as fixtures, so the parser reads the real shape. Add the
backend. Pass every prompt as its own argv item; never use a shell.
**Verification:** AC-1, AC-2, AC-3. Test first: the strong-case test fails until the backend routes.

#### Phase 2: AC-6 holdout with the real model
**Status:** DONE
**Files:** `scripts/earshot-holdout.ts`.
**Implementation:** Download Kenney `interface-sounds` (tonal cues) and one Sonniss GDC 2026 part (impacts/foley,
mechanical, ambience) with `audio_download_asset` into a temp directory and unzip them there. Pick 10 tuning and 20
disjoint holdout clips, 5 per family. Each clip's description comes from the pack's own file name; its
alternatives are concrete sounds from the other families. Add one technically clean wrong sound. Freeze the verdict
mapping on the tuning clips, then score the holdout once through `audio_inspect_asset`. Print every clip's verdict,
z and margin. Delete the downloads. Licensed clips and their names never enter the repo; record numbers only. Run
it on the laptop (`laptop-offload`), since the Sonniss part is large and each clip loads the models.
**Verification:** AC-4. Copy the result to AUDIO_GENERATION_PRD AC-6; if it falls short, AC-6 stays open there too.

#### Phase 3: Companion setup docs
**Status:** DONE
**Files:** `docs/audio.md` (earshot companion: pinned install, constraints for `torch` / `transformers`, the
1.4 GB model download, alpha status, the loop, the custom-recipe snippet, the unzip step),
`docs/configuration.md` (`AUDIO_EARSHOT_BIN`), `docs/tools.md` (`semantic` values).
**Implementation:** Write the install as commands a user can paste. Name what earshot cannot judge (its LIMITS),
and that forge optimizes earshot's own models: judge a forged sound by its model-free tone measurements and by
listening.
**Verification:** AC-5, AC-6.
