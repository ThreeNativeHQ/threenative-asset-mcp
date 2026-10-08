# AGENTS.md — threenative-asset-mcp

Rules and hard-won facts for any agent working here. `README.md` documents what the tools do;
this file covers what you would otherwise relearn the expensive way. Plans live in `docs/PRDs/`
(finished ones in `docs/PRDs/done/`; ones waiting only on an owner action in
`docs/PRDs/BLOCKED/<reason>/`). PRD ids are shared with `threenative-engine`, so check that
repo's branches and PRs before taking a number.

## Verify

```sh
npm run typecheck
npm test                                    # builds first (pretest); runs every suite
npx vitest run tests/mcp-smoke.test.ts      # packed-MCP smoke; CI runs it separately
```

- **Run the suite the way it fails.** The `verify` leg uses `--maxWorkers=1`; the `parallel` leg
  runs default workers and the `leak-gate` leg fails on any temp leftover. Locally, run with
  default workers. To check for temp leaks: `npm run test:leaks` (or
  `TMPDIR=$(mktemp -d) npx vitest run` and look at what is left). Only `node-compile-cache` may
  remain; every Chromium launch gets its own removed `TMPDIR` (`src/browser-temp.ts`), so a
  `.org.chromium.Chromium.*` file is a regression.
- **`npm run doctor`** lists missing prerequisites with their fix (`-- --toolchain` adds the
  Unreal build packages). A test that needs an external tool declares it with
  `describeWithTools` (`tests/helpers/require-tool.ts`): it skips locally and fails under
  `CI=true`.
- **This desktop is often loaded by other sessions** (load average 40–70 seen). A test that only
  fails under the full parallel suite is a timing bug in the test or the product, not noise.
  Reproduce it in isolation, find the window, then fix it deterministically.
- Local prerequisites that CI installs for you: `ffmpeg`/`ffprobe` (audio suites crash with
  `spawnSync ffmpeg ENOENT` without them), Python 3 with NumPy and Pillow (creature preview's
  `python-outline` backend; without them it falls back to `browser-silmetrics`), Playwright
  Chromium.

## Writing tests

- Every `mkdtemp` needs cleanup (`onTestFinished` or an `afterEach` list). A test that leaks into
  `/tmp` is a bug.
- Never inject faults by racing `fs.watch` or timers against the code under test. Under load the
  event arrives after the window has closed and the test hangs. Add an explicit hook instead, as
  `CreaturePublicationHooks` (`src/creature/runner.ts`) does for publication and rollback.
- Do not assert a backend or tool choice that depends on what the host has installed. Derive the
  expectation from the host, or force the choice.
- `testTimeout` is 30 s (`vitest.config.ts`): many tests spawn real ffmpeg, the pinned inspector
  or the packed MCP. A timed-out test's work keeps running and writes into directories its cleanup
  already removed, so a timeout also shows up as a temp leak.
- For a race fix, write a test that holds the first caller inside the window (for example a
  wrapper binary that sleeps) and starts the second one there. Confirm it goes red on the old code
  for the right reason, not a timeout.

## Toolchain provisioning (fresh hosts)

Tools are cached under `~/.cache/threenative-asset-mcp/toolchain/` (`THREENATIVE_TOOLCHAIN_DIR`).
Each of these broke on a clean Debian 13 amd64 host on 2026-10-07:

- **FabCLI**: release archives wrap the binary in `fabcli-<tag>-<platform>/`. Look inside archives
  with `findArchiveEntry`; never assume the root layout.
- **UE Viewer**: the Linux prebuilt from gildor.org is a 32-bit i386 ELF, unrunnable without the
  i386 loader, so 64-bit-only hosts build from source. The build needs `g++`, `perl`, `zlib1g-dev`,
  `libpng-dev` and `libsdl2-dev`. `umodelBuildFailure` reads the compiler output and names the
  missing package; keep that mapping current rather than listing guesses.
- The uncooked converter provisions a Python venv; the modern converter installs a private .NET SDK
  and publishes CUE4Parse. Neither needs root.
- The `Fresh toolchain` workflow provisions all four from an empty cache in `debian:13` (weekly,
  and on changes to the provisioners). Upstream archives change without a commit here, so assume
  provisioning can break between runs. FabCLI also needs `libwebkit2gtk-4.1-0` at runtime.

## Fab and Unreal imports

- **Login is the user's.** The MCP never signs in. For an agent session with no display, run
  `fabcli auth login --manual` under a pseudo-terminal (it refuses a non-TTY stdin). The user opens
  the printed `epicgames.com/id/login?redirectUrl=…` link in the browser where they are already
  signed in and gives you the `authorizationCode`. Codes expire in minutes and grant full account
  access: pass one straight to FabCLI and never write it to a file. The session lives in the OS
  keyring for about 90 days. `fabcli auth status` checks it.
- **An artifact's format is its oldest listed engine.** `SoulCave418` lists UE 4.18–5.8 but is a
  4.18 package. That version picks the decoder: UE Viewer (≤ 4.20), the MeshDescription converter
  (4.21–4.27, object versions 517–522), CUE4Parse (UE5). Of the 35 importable listings in the
  owner's library on 2026-10-07, 15 could only go through UE Viewer, and 9 offered more than one
  route.
- **UE Viewer's `.mat` for a MaterialInstance often shows the parent's defaults** when the
  instance's parameter names are not ones it recognises. The instance's real textures are in
  `TextureParameterValues` in `.props.txt`. Check the package name table (`strings -n 4 X.uasset`)
  before trusting either. PRD-537 tracks the resolver fix.
- **Some colour exists only in the material graph** (layered masters: colour textures blended by
  mask channels and tinted, sampled inside material functions). `.mat`/props texture binding cannot
  reproduce it, so a section with no base colour asks the graph baker (`src/unreal/graph-baker.ts`,
  PRD-538): CUE4Parse dumps the graph, `material-graph.ts` evaluates a closed node set and bakes a
  base-colour PNG (`source: "graph"`). Anything it cannot evaluate (e.g. `DepthFade`,
  `MatLayerBlend_Tint`) stays on the neutral fallback and is named under the section's `graph`.
  Engine content functions are not in the pack, so a bake that relies on them is `heuristic`.
- Fab downloads land in `~/.cache/threenative-asset-mcp/fab-downloads/<listing>/<artifact>`. They
  are licensed, not redistributable: never commit pack contents. Delete what you downloaded when
  you are done; FabCLI fetched Soul Cave (1.2 GB) in 17 s, so re-downloading is cheap.
- **Metadata dumps are local-only.** `npm run parity:fab -- --export-metadata <dir>` records each
  material resolution so `FAB_METADATA_DIR=<dir> npx vitest run tests/fab-metadata.test.ts` can
  replay it. The dumps carry licensed pack names: keep them out of the repo.
- Judge an import against its source package, not a screenshot. PRD-537 defines the structural
  parity checks (coverage, shape, texture identity, colour presence).
- **Editor thumbnails in UE4 packages have red and blue swapped** (`src/unreal/package-thumbnail.ts`
  corrects it for legacy version -7 .. -1). A brown rock showed up as blue-grey, with a tan "floor" that is
  really Unreal's blue-grey checker. Before blaming the import for a colour mismatch against a thumbnail,
  compare the thumbnail of a *texture* package with UE Viewer's export of that texture: the swap shows up
  there with no material graph involved. UE5 packages are returned as stored (order unverified).
- **Visual regressions have their own guards.** `judgeRender` (`src/unreal/visual-judge.ts`) now measures a
  camera-robust *fill ratio* (object pixels over their tight bounding box); when a piece has an Unreal
  thumbnail it flags "solid card: render fill X vs thumbnail fill Y" if the render fills its box
  `SOLID_CARD_FILL_FACTOR` (1.6x) more than the thumbnail's mask does, and both masks have enough pixels —
  the solid-polygon conifer bug the colour and coverage rules missed. `tests/unreal-visual-regression.test.ts`
  builds synthetic GLBs, renders them through the production tile renderer (`renderTiles`) with its fixed
  camera, and asserts per-fixture judge invariants plus SSIM against small committed PNGs in
  `tests/fixtures/visual-golden/` (threshold 0.90, to survive SwiftShader differences between hosts). The
  zero-alpha-tint and emissive fixtures take their factors from the real material resolver, so reverting
  those importer fixes turns the suite red. Regenerate goldens with `npm run goldens:update`; a failing diff
  writes actual and difference PNGs under `artifacts/ci/visual-diff/`, which CI uploads.
