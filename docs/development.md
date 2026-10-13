# Verification and development

[← Back to the README](../README.md)

How CI checks the package and how to run the same checks locally.

GitHub-hosted CI checks pull requests, pushes to main and manual runs on the
minimum supported Node 20.19 and Node 24. It installs the committed npm lockfile,
runs typecheck/build, deterministic fixtures and actual built/npm-packed stdio
consumers. Reports distinguish intentionally conditional proprietary Unreal
fixtures. No provider live probes, credentials, package publishing or account
changes run in that workflow. Local CI-equivalent commands are:

```bash
npm ci
npm run build
npm run typecheck
npm run test:ci
npm run test:smoke
```

The suite needs Chromium (`npx playwright install --with-deps chromium`),
ffmpeg and Python with NumPy/Pillow for local render/audio fixtures. Live probes
remain separate from deterministic acceptance tests.

Run `npm run doctor` to see which of these your host has. Each missing tool is
listed with its install command. Locally, a suite whose tool is missing is
skipped with that command as the reason. With `CI=true` it fails instead.
Add `--toolchain` to also require what the Unreal importers need on a fresh
Linux host, or `--toolchain-only` to check only that group.


```bash
npm ci
npm run browser:install
npm run typecheck
npm test
npm run build
npm pack --dry-run
npm run inspect
npm run test:providers:live
```

Live checks are opt-in because they contact Fab:

```bash
npm run test:live
```

This runs the real anonymous search, cursor, detail, and dedicated-browser
contract probe. It exits nonzero when Fab challenges the clean browser or the
required contract cannot be verified. Live verification must remain anonymous,
concurrency-one, capped and paced. It must never acquire, purchase, wishlist,
download, or automatically solve a challenge.

`npm run test:providers:live` launches the compiled stdio MCP and exercises live
search, detail, categories, and file discovery for ambientCG, Smithsonian 3D,
and Sketchfab. If `SKETCHFAB_API_TOKEN` is configured it also verifies the
authenticated download endpoint; otherwise it verifies the explicit
authentication-required response.
