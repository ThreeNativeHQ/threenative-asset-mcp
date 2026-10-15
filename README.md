# threenative-asset-mcp

[![npm version](https://img.shields.io/npm/v/threenative-asset-mcp)](https://www.npmjs.com/package/threenative-asset-mcp)
[![Node.js requirement](https://img.shields.io/node/v/threenative-asset-mcp)](package.json)
[![CI](https://img.shields.io/github/actions/workflow/status/ThreeNativeHQ/threenative-asset-mcp/ci.yml?branch=main&label=CI)](https://github.com/ThreeNativeHQ/threenative-asset-mcp/actions/workflows/ci.yml)

A [Model Context Protocol](https://modelcontextprotocol.io/) server that lets AI clients find, inspect and
download game-ready 3D assets, textures, HDRIs, animations and audio. It gives each provider structured
search, metadata and guarded downloads, and it converts owned Unreal/Fab packs and Unity Asset Store packages to GLB.

> **Status: experimental.** Fab's `/i/*` JSON routes are undocumented and can change or restrict automated
> access. Sketchfab licenses vary per model. Review each provider's terms and each asset's license.
> Unreal and Unity support cover specific formats and verified cases; they do not certify whole packs.
> Unity imports are verified on three real packs; real Unity Editor reference renders are not yet available.
> Blendkit is optional and needs documented provider permission. Live Blendkit downloads remain **UNVERIFIED**.

## Contents

| I want to… | Read |
| --- | --- |
| Install it and connect my MCP host | [Install](#install) and [Host configuration](#mcp-host-configuration) below |
| See every tool and how to chain them | [docs/tools.md](docs/tools.md) |
| Generate or inspect game audio | [docs/audio.md](docs/audio.md) |
| Import an Unreal / Fab pack as GLB | [docs/unreal-import.md](docs/unreal-import.md) |
| Import a Unity Asset Store package as GLB | [docs/unity-import.md](docs/unity-import.md) |
| Check which Unreal formats work | [docs/unreal-format-support.md](docs/unreal-format-support.md) |
| Check which Unity formats work | [docs/unity-format-support.md](docs/unity-format-support.md) |
| Load imported assets in Three.js | [docs/unreal-threejs-usage.md](docs/unreal-threejs-usage.md) |
| Read what each importer version changed | [docs/unreal-importer-history.md](docs/unreal-importer-history.md) |
| Set environment variables | [docs/configuration.md](docs/configuration.md) |
| Understand provider rules, caching and TLS | [docs/providers.md](docs/providers.md) |
| Fix an error, or learn what the browser profile touches | [docs/troubleshooting.md](docs/troubleshooting.md) |
| Run the tests and CI checks | [docs/development.md](docs/development.md) |
| Read the Fab API contract notes | [docs/fab-contract.md](docs/fab-contract.md) |
| Use Blendkit (optional, permission required) | [docs/blendkit-integration.md](docs/blendkit-integration.md) |

## Supported providers

| Provider | Content | License | Needs |
| --- | --- | --- | --- |
| [Fab](https://www.fab.com/) | 3D, free-file downloads, owned Unreal packs | Per listing | FabCLI login for owned packs only |
| [Poly Haven](https://polyhaven.com/) | HDRIs, textures, models | CC0 (API use needs a visible credit) | Nothing |
| [ambientCG](https://ambientcg.com/) | Materials, HDRIs, decals, models | CC0 | Nothing |
| [Smithsonian 3D](https://3d.si.edu/) | Open Access scanned models | Open Access | Nothing |
| [Sketchfab](https://sketchfab.com/) | Public models | Varies per model | `SKETCHFAB_API_TOKEN` for downloads only |
| [Kenney](https://kenney.nl/) | 3D packs, audio | CC0 | Nothing |
| [itch.io](https://itch.io/) (curated) | Quaternius animations, KayKit, Brackeys VFX, Tallbeard music | CC0 | Nothing |
| [Blendkit](docs/blendkit-integration.md) (optional) | Free models through your own Blendkit-Client | Private use only, never redistributed | Local Client plus `BLENDKIT_PROVIDER_PERMISSION` |
| Game audio catalog | Sonniss, Kenney, Tallbeard, Scott Buckley, Mixkit, Pixabay, Freesound, OpenGameArt, Abstraction | Per source | `ELEVENLABS_API_KEY` for generation only |

Fab search defaults to free assets, meaning at least one license tier is free. Call `fab_get_asset` before
making license or price claims. More in [docs/providers.md](docs/providers.md).

## Requirements

- Node.js 20.19 or newer
- Playwright Chromium, only when Fab requests browser verification
- FFmpeg and FFprobe on `PATH` for the audio tools
- Unreal imports on Linux also need build packages for older packs. Run `npm run doctor` for the list.
  See [docs/unreal-import.md](docs/unreal-import.md).
- Unity imports need Blender 4.5 LTS to read FBX models. The MCP downloads a pinned copy into its toolchain cache on first use.
  See [docs/unity-import.md](docs/unity-import.md).

No Epic or Fab login is needed for search and free downloads. The MCP never signs in for you.

## Install

An MCP host can launch the published package with:

```bash
npx -y threenative-asset-mcp
```

For a local checkout:

```bash
npm ci
npm run browser:install
npm run build
node dist/index.js
```

## MCP host configuration

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.assets]
command = "npx"
args = ["-y", "threenative-asset-mcp"]
```

Claude Desktop:

```json
{
  "mcpServers": {
    "assets": {
      "command": "npx",
      "args": ["-y", "threenative-asset-mcp"]
    }
  }
}
```

VS Code (`.vscode/mcp.json`):

```json
{
  "servers": {
    "assets": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "threenative-asset-mcp"]
    }
  }
}
```

For a local build, use `command = "node"` and the absolute path to `dist/index.js`. Restart the host after
changing its configuration.

## Tools at a glance

| Group | Tools |
| --- | --- |
| Unified | `asset_search_sources`, `asset_search`, `asset_get`, `asset_download`, `asset_download_file` |
| Fab | `fab_search_assets`, `fab_get_asset`, `fab_download_free_asset`, `fab_list_owned`, `fab_import_asset` |
| Poly Haven | `polyhaven_search_assets`, `polyhaven_get_asset`, `polyhaven_list_files` |
| ambientCG | `ambientcg_search_assets`, `ambientcg_get_asset`, `ambientcg_list_files` |
| Smithsonian 3D | `smithsonian_search_assets`, `smithsonian_get_asset`, `smithsonian_list_files` |
| Sketchfab | `sketchfab_search_models`, `sketchfab_get_model`, `sketchfab_get_downloads` |
| Blendkit | `blendkit_status`, `blendkit_import_asset` |
| Audio | `audio_search_assets`, `audio_download_asset`, `audio_inspect_asset`, `audio_generate_sound` |
| itch.io bundles | `itch_list_downloads`, `asset_list_bundle_entries`, `asset_download_bundle_animation` |
| Unreal | `asset_import_unreal` |
| Unity | `unity_list_packages`, `asset_import_unity` |

Recommended flow: `asset_search_sources` → the returned search tool → the returned files tool → the returned
download tool with `acceptLicense: true`. All discovery tools are read-only. Download tools write only inside
their own directories, and never purchase, sign in or overwrite. Full list: [docs/tools.md](docs/tools.md).

`audio_generate_sound` spends **your own** ElevenLabs credits. Nothing else costs money.

## Unreal / Fab import

`fab_import_asset` and `asset_import_unreal` turn an Unreal pack (UE4 and UE5, cooked or uncooked) into
self-contained GLBs plus an `import-report.json`. Unreal Engine is not required. The importer reports what it
could not convert instead of claiming a full conversion. Setup, login and output types:
[docs/unreal-import.md](docs/unreal-import.md). Per-class status: [docs/unreal-format-support.md](docs/unreal-format-support.md).

## Unity Asset Store import

`asset_import_unity` turns a `.unitypackage`, a UPM tarball or a Unity project folder you already have into
self-contained GLBs (one per model, plus one per prefab with its materials bound) and an `import-report.json`.
`unity_list_packages` lists the packages your Unity Editor cached. `fab_import_asset` hands a Unity-format Fab
artifact to the same importer when FabCLI exposes it. The MCP never signs in to Unity, never calls Unity
services and never decrypts a download. Unity is not required. The importer reports what it could not convert,
such as custom shaders, which keep their saved colour and base texture. Setup and output:
[docs/unity-import.md](docs/unity-import.md). Per-class status: [docs/unity-format-support.md](docs/unity-format-support.md).

## Privacy

No analytics or remote telemetry. Logs go to stderr only and omit query text unless `FAB_LOG_QUERIES=1`. The
dedicated browser profile never reads your normal browser profile or Epic session.
See [docs/troubleshooting.md](docs/troubleshooting.md).

## Development

```bash
npm ci && npm run typecheck && npm test
```

`npm run doctor` lists missing local prerequisites. CI details and live probes: [docs/development.md](docs/development.md).

## Contributing and help

Start with [Troubleshooting](docs/troubleshooting.md) and `npm run doctor`. Report bugs through
[GitHub issues](https://github.com/ThreeNativeHQ/threenative-asset-mcp/issues) with the package version, Node
version, OS, affected tool and sanitized reproduction steps. Never include credentials, signed download URLs or
licensed asset files. Before a pull request, read [AGENTS.md](AGENTS.md) and run the checks in
[docs/development.md](docs/development.md).

## License

The package declares **UNLICENSED** in [package.json](package.json). No open-source license is granted.
Downloaded assets and external tools keep their own licenses and terms. Public availability does not grant
redistribution rights.
