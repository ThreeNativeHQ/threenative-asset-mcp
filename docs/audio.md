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
  emotional tone when local CLAP is provisioned.
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
