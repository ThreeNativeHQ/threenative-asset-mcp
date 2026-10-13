# Blendkit integration

This MCP reaches Blendkit (formerly BlenderKit) only through the user's own
official **Blendkit-Client**. The Client is a local Go service
([BlenderKit/bk_client](https://github.com/BlenderKit/bk_client),
GPL-2.0-or-later). The MCP calls its documented loopback HTTP API. It does not
bundle, copy or start the Client, and it contains no Client code.

Status on 2026-10-12: **implemented, and verified against the real Client.
Live provider access is off by default** because no documented permission
exists (see [Provider permission](#provider-permission)).

## Sources checked

| Source | Version or date | Used for |
| --- | --- | --- |
| `bk_client` `client/docs/API.md` and `openapi.json` | Client 1.13.6, commit `5ff5292`, 2026-10-06 | Routes, request bodies, task model |
| `bk_client` Go handlers (`main.go`, `download.go`, `run_blender_script.go`, `tools/export_glb.py`) | same commit | Task states, `/report` delivery, cancel, recipe ABI |
| `bk_client` release `v1.13.6`, asset `bk_client.zip` | sha256 `489d5acaff3bed61a7ba19d43c210531e189d2448d53d23f8e9c329fcabd3345`; Linux x86-64 binary `68b6b8133724ae450d84684425caa2ef44d02b5858abaef81e93b2ebac7af438` (matches `manifest.json`) | Live proof |
| `bk_godot` add-on | commit `b9a458c`, 2026-10-12 | Search URL and asset page conventions (reference only) |
| [Terms and Conditions](https://www.blendkit.com/terms-and-conditions-2026/) | effective 2026-06-12, fetched 2026-10-12 | License and use terms |
| [Licenses](https://www.blendkit.com/docs/licenses/) | fetched 2026-10-12 | Royalty Free and CC0 summaries |

## How it works

1. `blendkit_status` calls `GET /addons/list` and `GET /tools/list`. These two
   routes do not register the MCP with the Client and do not reach Blendkit.
2. A search (`asset_search` with Blendkit enabled) sends `POST /assets/search`
   with a search URL that the MCP builds itself. The URL always uses
   `https://www.blendkit.com/api/v1/search/`, `is_free:true` and one
   `asset_type`. The MCP keeps only words from the user query, so the query
   cannot add filters.
3. The Client returns a `task_id`. The MCP polls `POST /report` with one
   shared poller. Each finished, failed or cancelled task arrives there
   once. The MCP reads only the id, status, progress, message and result
   fields of a task. The `data` field echoes the request, including the API
   key, so the MCP ignores it.
4. `blendkit_import_asset` looks up the item again (`asset_id:<uuid>`), applies
   the rights gate, and sends `POST /assets/download` into a new staging
   directory. If the caller cancels, the MCP sends `POST /assets/cancel_download`.
5. The MCP checks that each downloaded path is a regular file inside the
   staging directory. Then it sends `POST /tools/run` with the fixed recipe
   `export_glb` (`yup`, no Draco, modifiers applied). The MCP never sends
   `script_path`.
6. The MCP inspects the GLB (meshes, vertices, triangles, PBR texture slots,
   image data, size in file units) and moves the GLB and
   `blendkit-<id>.provenance.json` into `outputDir`. It then deletes the
   staging directory, which includes the source `.blend`.

## Security constraints

- The Client URL must be a plain-HTTP loopback origin (`127.0.0.1`,
  `localhost`, `[::1]`). Redirects are refused. Each response is capped at
  8 MiB, and each request has a 10 s deadline.
- The Client sends each file's `downloadUrl` with the user's API key. The MCP
  forwards only `blend` and `resolution_*` files whose links are HTTPS on the
  Blendkit API origins and whose path is under `/api/v1/download/`.
  `zip_file` variants are never forwarded, because the Client extracts
  archives without confining entry paths.
- Asset ids must be UUIDs. Provider metadata is untrusted: the MCP reads only
  named fields and bounds each of them. Task text has URLs and control
  characters removed.
- The API key comes only from `BLENDKIT_API_KEY`. It goes only into loopback
  request bodies, never into a command line, log, MCP response or provenance
  file. The MCP never signs in.
- The Client cannot cancel a running recipe. The MCP stops waiting after
  10 minutes.

## Rights gate

Each acquisition applies these rules per item. Unknown values fail closed.

| Item | `purpose: "project-use"` | `purpose: "redistribution"` |
| --- | --- | --- |
| Paid (Full Plan) | refused | refused |
| License unknown or missing | refused | refused |
| Royalty Free | allowed with consent; provenance says redistribution is denied | refused |
| CC0 | allowed with consent | allowed with consent |

`acceptLicense: true` and `projectUseConsent: true` are both required.

Royalty Free terms (Terms art. 5) allow use only inside a project. They forbid
stand-alone redistribution. They also say that software "may not … embed any
open-format 3D model". A GLB in a web game is an open-format model. **Never
commit, publish or ship Royalty Free Blendkit models in game builds, engine
demos or starter kits**, even after conversion. Use them only privately, for
example for blockout or reference, until Blendkit confirms otherwise. Only CC0
items are safe to ship.

## Provider permission

The Terms say that the services may be used through "websites, software
applications, plug-ins, add-ons, APIs and other supported integrations". They
also say that the database "is meant to be used for scene creation in Blender
and other 3D content creation software". They forbid scripts that load the
interface or use it against its purpose. No source that we checked documents
permission for a third-party agent or MCP client. Because of this:

- live search, lookup and import run only when `BLENDKIT_PROVIDER_PERMISSION`
  cites documented permission (the citation is copied into each provenance
  file);
- without it, `asset_search` lists Blendkit as a manual provider, and
  `blendkit_status` points to <https://www.blendkit.com/asset-gallery> and
  the official add-on;
- the MCP never crawls, mirrors the catalog or downloads in bulk. Each import
  is one item that the user selected.

## Setup

1. Download `bk_client.zip` from the
   [official releases](https://github.com/BlenderKit/bk_client/releases).
   Check the sha256 of your platform binary against `manifest.json`. You can
   also use the Blendkit add-on for Blender, which starts the Client.
2. Start the Client. It listens on port 62485 by default. For another port,
   set `BLENDKIT_CLIENT_URL`.
3. Set `BLENDKIT_BLENDER_PATH`, or let the Blendkit add-on register Blender
   with the Client.
4. Optional: sign in with the official add-on and set your own
   `BLENDKIT_API_KEY`.
5. Run `blendkit_status`.

Each request from `blendkit_import_asset` registers the MCP with the Client.
When the last registered application stops polling for 120 s, the Client
exits. This is upstream behavior. Start the Client again if
`blendkit_status` reports it unreachable.

## Verification

| Path | Evidence |
| --- | --- |
| Rights, permission, security, cancel and error paths | `tests/blendkit.test.ts` with a stand-in for the Client; each guard turned off one at a time turns its test red |
| Real Client 1.13.6 + Blender 4.5.14 LTS: status, search through `/report`, download, `export_glb`, GLB inspection, cancellation | `tests/blendkit-live-client.test.ts` (opt-in, see below). The provider API is a local stand-in, and the `.blend` is generated by the test |
| Live Blendkit search and download | **Not run.** This waits for documented provider permission |

```sh
BLENDKIT_CLIENT_BIN=/path/to/bk_client-linux-x86_64 \
BLENDKIT_BLENDER_PATH=/path/to/blender \
npx vitest run tests/blendkit-live-client.test.ts
```

Without both variables, the live suite is skipped. CI does not provision the
Client or Blender.
