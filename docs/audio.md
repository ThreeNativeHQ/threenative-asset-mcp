# Game audio

[← Back to the README](../README.md)

Audio source discovery, verified direct downloads, local inspection and ElevenLabs generation.

## Audio tools

Game audio:

- `audio_list_sources` — lists the ten supported audio libraries, best uses,
  official browse pages, license/attribution cautions, and honest download
  capability (`curated-direct` or `provider-page`).
- `audio_search_assets` — searches only the curated packs with stable official
  direct URLs. Results preserve license, commercial-use, attribution, source,
  size (when known), and redistribution metadata.
- `audio_download_asset` — downloads a catalog asset by ID after
  `acceptLicense: true`. It uses an HTTPS host allowlist, validates every
  redirect, streams with a byte cap, writes atomically without overwrite, and
  returns the local path, byte size, and SHA-256.
- `audio_inspect_asset` — measures one local WAV, Ogg, MP3, or FLAC with the
  pinned `@threenative/playtest` inspector: decode integrity, silence floor,
  peak ceiling, DC offset, a five-band spectrum, the loop seam of a **declared**
  loop, and the requested duration, plus a spectrogram PNG. Needs no ElevenLabs
  key and never modifies or repairs the file. Optionally compares prompt and
  emotional tone when local CLAP is provisioned, or prompt fit through the
  [earshot companion](#earshot-companion).
- `audio_generate_sound` — **spends ElevenLabs credits.** Generates one sound
  effect or ambience from a prompt using *your own* `ELEVENLABS_API_KEY`, saves
  the original response plus a PCM16 WAV, and runs the same inspection
  automatically. Reusing a `requestId` returns the saved result instead of
  charging again.

## Generating a sound

The loop is **generate once → inspect → revise the one property that failed →
explicitly generate again.** There is no best-of-N retry: every generation is a
separate billable invocation you ask for on purpose.

Describe source, action, material, distance, and timing. A useful brief:

> One short metal latch closing, close microphone, dry recording, single event
> with natural decay, no speech or music.

These are prompting conventions absorbed from ElevenLabs' own
[sound-effects skill](https://github.com/elevenlabs/skills/blob/9edcbd4b80ed57b8e07a3f86ea520333969fbc3c/sound-effects/SKILL.md)
(MIT, reviewed at commit `9edcbd4b`), which is linked and attributed rather than
installed. They are conventions, not guaranteed exclusion controls.

`audio_generate_sound` requires `ELEVENLABS_API_KEY` in the server environment.
It is never bundled, defaulted, or logged: without your own key the tool fails
with `AUDIO_GENERATE_NO_CREDENTIALS` and an instruction to set one, while the
catalog and inspection tools keep working normally.

What the inspection does and does not tell you:

| It answers | It does not answer |
| --- | --- |
| Is it broken, silent, clipped, DC-offset, or the wrong duration? | Is it a *good* sound? |
| Does a declared loop click at the wrap? | Does it suit this scene? |
| Is the frequency content inside bounds *you* supplied? | Is the mix right? |

`artisticQuality` is always `"unverified"`. There is no `soundsGood` flag and no
single quality score. `recommendation: "audition"` means the technical checks
passed and every requested check completed — it means *go listen to it*, not
*ship it*. A definite technical failure recommends `"reject"`; a warning, a
possible mismatch, or an incomplete requested check recommends `"review"`.

If asset compilation rewrites the bytes, inspect the compiled output before
describing that output as checked.

## Optional local CLAP setup

Prompt fit and emotion fit are **off by default** (`semantic: "off"`) and add no
dependency to `npm install`. To enable them:

```sh
python3 -m venv ~/.venvs/clap
~/.venvs/clap/bin/pip install "laion-clap==1.1.6" "torch==2.4.1" \
    "torchaudio==2.4.1" "librosa==0.10.2.post1" "numpy<2"
# Download 630k-audioset-best.pt from the LAION-AI/CLAP releases and check its hash.
export AUDIO_CLAP_CHECKPOINT=/path/to/630k-audioset-best.pt
export AUDIO_CLAP_PYTHON=~/.venvs/clap/bin/python
```

Nothing is downloaded implicitly and no GPU is required. With `semantic: "clap"`
and no provisioned model, you get the technical result plus an explicit
unavailable semantic result and this instruction — never a semantic pass. A
generation that requests `semantic: "clap"` is refused in preflight, before
spending, when the model is missing.

Scores are cosine similarities used as **supporting evidence**, never
probabilities or quality grades. The emotion check builds otherwise identical
hypotheses — `The sound of {sourceDescription}, with a {mood} emotional tone.` —
so only the mood clause differs, and **this use of CLAP is a proposed heuristic,
not a demonstrated emotion-recognition capability**: mood status stays
`unverified` until the held-out emotion calibration qualifies your domain. Check
the CLAP code and checkpoint licensing separately before redistributing either.

## earshot companion

[earshot](https://github.com/Leonxlnx/earshot) (MIT, CPU) gives agents ears. It is **alpha** (`0.1.0`, created
2026-10-15, one author) and downloads about 1.4 GB of models on first use. Pin an exact commit.
Install it in its own venv. Torch comes from the CPU wheel index. The record below was verified with
`torch 2.14.1+cpu` and `transformers 5.20.1`; upstream leaves both unpinned, so add `==` pins if a new
release breaks it:

```sh
python3 -m venv ~/.venvs/earshot
~/.venvs/earshot/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu
~/.venvs/earshot/bin/pip install "transformers==5.20.1" \
    "git+https://github.com/Leonxlnx/earshot@108763c62648c78dbac14f5bebcd3c61ac7931cd"
~/.venvs/earshot/bin/earshot doctor --load      # must end with "problems: []"
export AUDIO_EARSHOT_BIN=~/.venvs/earshot/bin/earshot
```

Two ways to use it, and neither needs a fork:

1. **Prompt fit backend.** `semantic: "earshot"` with `expectedPrompt` and `alternativePrompts` runs
   `earshot match`. A `strong` or `plausible` verdict is `consistent`. A `weak` or `no match` verdict is
   `possible_mismatch` and `recommendation: "review"`. Unset binary, timeout (180 s) or unreadable output is
   `unverified` with the setup instruction, never a pass. `generation` refuses before spending when the binary
   does not answer. Each call loads both models (20–40 s). `emotion` is not available: use `semantic: "clap"`.
   Scores are the z values of `match`; they are evidence, not quality grades.
2. **Companion MCP server and CLI.** Run `earshot mcp` beside this server (install with the `mcp` extra) for
   `describe`, `match`, `rank`, `ab` and `find`, and use the CLI for `forge`.

The loop: find or download (`audio_download_asset`, then `unzip` the archive: no tool extracts them) →
generate or forge → `audio_inspect_asset` for defects → earshot `match` / `rank` / `ab` to listen → change one
property → repeat.

Custom game recipes (coin, laser, footstep) need no fork. `earshot.forge.forge()` accepts a recipe module with
the same attributes as the shipped ones (`earshot/forge/recipes/pop.py`):

```python
import importlib.util, sys
from earshot.forge import forge
spec = importlib.util.spec_from_file_location("coin", sys.argv[1])
recipe = importlib.util.module_from_spec(spec); spec.loader.exec_module(recipe)
print(forge(recipe, target="a bright coin pickup chime", alts=["a door bell", "a glass clink"]))
```

Limits. earshot's vocabulary is general-purpose: music genre, mood, instrument and voice verdicts are hints.
`forge` optimizes earshot's own models, so a forged sound can please the models and still sound wrong. Judge it
by model-free tone measurements (`earshot measure`) and by listening.
