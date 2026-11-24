# Third-party notices

## trompe

`src/texture-projection/app/` is a modified adaptation of **trompe** — "AI texturing for whole game
levels: plan cameras, paint with image models, project and bake" — from
https://github.com/Patch-gg/trompe at commit
`ba9ef76687f57eef157057c7592d26e59c805992`.

License: Apache License, Version 2.0 (the upstream `LICENSE` file is the unmodified Apache-2.0 text;
upstream ships no `NOTICE` file). Copyright belongs to the trompe authors as named in that
repository; the Patch name, mark, wordmark and Patch Pixel typeface are Patch's and are **not**
covered by the license — none of them is included here.

Modified for `threenative-asset-mcp`, as required by Apache-2.0 section 4(b):

- The image providers were replaced. The fal.ai client (`@fal-ai/client`) and its proxy are gone;
  every view is painted through OpenRouter's `/api/v1/images` by way of the local proxy in
  `src/texture-projection/openrouter-proxy.ts`, which keeps `OPENROUTER_API_KEY` server-side. The
  default model is FLUX 3 Klein, with Muse Image and Seedream 5 Lite selectable.
- The model catalogue and prompts moved to `src/texture-projection/models.ts`, shared by the browser
  app and the headless runner.
- The projection rejects grazing angles (`cosv < 0.35`, upstream 0.08) so steep views cannot smear a
  texture strip.
- The pipeline is resumable: each finished view is written out immediately with `run.json` and a run
  can continue from the views it already has. The headless runner, the local UI server, the run
  store, and the `texture-project-ui` command are new.
- Branding was removed: no Patch marks, links, banners, fonts or accent colours, and no sample
  levels from the upstream repository.
- The UI gains a style-image dropzone, a pre-run cost quote and a list of resumable runs.

Every file under `src/texture-projection/app/` carries this provenance in this notice; files that
were kept close to upstream still read like upstream code.

## npm dependencies

Everything else in this package comes from npm under each dependency's own license (`three`,
`three-mesh-bvh`, `playwright`, `@gltf-transform/*`, `sharp`, `zod`, and so on). `esbuild`, used only
to bundle the browser app at build time, is MIT-licensed.
