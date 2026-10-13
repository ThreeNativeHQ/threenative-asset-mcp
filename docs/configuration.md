# Configuration

[← Back to the README](../README.md)

Environment variables read by the server.

| Variable                        | Default                                            | Purpose                                                  |
| ------------------------------- | -------------------------------------------------- | -------------------------------------------------------- |
| `FAB_DIRECT_TIMEOUT_MS`         | `20000`                                            | Direct JSON request timeout.                             |
| `FAB_BROWSER_TIMEOUT_MS`        | `30000`                                            | Dedicated browser request timeout.                       |
| `FAB_BROWSER_MANUAL_TIMEOUT_MS` | `10000`                                            | Headed-mode grace period for visible verification.       |
| `FAB_BROWSER_HEADLESS`          | `true`                                             | Set to `0` temporarily for manual verification.          |
| `FAB_BROWSER_PROFILE_DIR`       | OS state directory under `threenative-asset-mcp/fab-browser-profile` | MCP-owned Fab browser state.                    |
| `FAB_DOWNLOAD_DIR`              | `~/Downloads/threenative-asset-mcp/fab`            | Dedicated directory for Fab free-file downloads.         |
| `FAB_MAX_DOWNLOAD_BYTES`        | `2147483648`                                       | Maximum accepted download size in bytes.                 |
| `FAB_DOWNLOAD_TIMEOUT_MS`       | `600000`                                           | Total timeout for one file download.                     |
| `FAB_CURL_IMPERSONATE`          | auto-detected on `PATH`                            | curl-impersonate wrapper override; `0`/`off` disables.   |
| `FAB_MIN_REQUEST_INTERVAL_MS`   | `1000`                                             | Minimum spacing between direct upstream requests.        |
| `FAB_LOG_LEVEL`                 | `warn`                                             | `debug`, `info`, `warn`, or `error`.                     |
| `FAB_LOG_QUERIES`               | `false`                                            | Set to `1` only if query text may be written to logs.    |
| `SKETCHFAB_API_TOKEN`           | unset                                              | User token for temporary Sketchfab download URLs.        |
| `AUDIO_DOWNLOAD_DIR`            | `~/Downloads/threenative-asset-mcp/audio`          | Dedicated directory for curated audio downloads.         |
| `AUDIO_MAX_DOWNLOAD_BYTES`      | `10737418240`                                      | Maximum accepted bytes per audio archive (10 GiB).       |
| `AUDIO_DOWNLOAD_TIMEOUT_MS`     | `1800000`                                          | Total timeout for one audio download (30 minutes).       |
| `ELEVENLABS_API_KEY`            | unset                                              | **Your own** key; required only by `audio_generate_sound`. Never bundled or logged. |
| `AUDIO_INSPECT_ROOTS`           | the audio dir plus the launch directory            | Extra `:`-separated roots `audio_inspect_asset` may read. |
| `AUDIO_CLAP_PYTHON`             | unset                                              | Interpreter with LAION-CLAP installed; enables `semantic: "clap"`. |
| `AUDIO_CLAP_CHECKPOINT`         | unset                                              | Path to the `630k-audioset-best.pt` checkpoint.          |
| `AUDIO_CLAP_CHECKPOINT_SHA256`  | unset                                              | Optional pin; a mismatched checkpoint is refused.        |
| `ASSET_DOWNLOAD_DIR`            | `~/Downloads/threenative-asset-mcp/assets`         | Dedicated directory for direct provider downloads.       |
| `ASSET_MAX_DOWNLOAD_BYTES`      | `10737418240`                                      | Maximum bytes per direct file or complete generic acquisition (10 GiB).       |
| `ASSET_DOWNLOAD_TIMEOUT_MS`     | `1800000`                                          | Total timeout for one provider download (30 minutes).    |
| `ASSET_ENABLE_KENNEY`           | `1`                                                | Bounded official Kenney 3D-pack discovery; `0` disables it. Other values fail initialization. |
| `ASSET_SEARCH_CONCURRENCY`      | `4`                                                | Concurrent provider operations per search; range 1–4. |
| `ASSET_PROVIDER_TIMEOUT_MS`     | `8000`                                             | Provider deadline; range 1–30000 milliseconds. |
| `ASSET_SEARCH_TIMEOUT_MS`       | `10000`                                            | Aggregate search/metadata deadline including queue time; range 1–60000. |
| `ASSET_PLAN_TTL_MS`             | `300000`                                           | Acquisition-plan TTL; range 1–900000; at most 100 bounded plans. |
| `BLENDKIT_CLIENT_URL`           | `http://127.0.0.1:62485`                           | Loopback address of the user's official Blendkit-Client; other hosts fail. |
| `BLENDKIT_PROVIDER_PERMISSION`  | unset                                              | Citation of documented Blendkit permission for this use. Unset keeps live Blendkit search and import off. |
| `BLENDKIT_API_KEY`              | unset                                              | **Your own** key from the official Blendkit sign-in; sent only to the loopback Client, never logged or returned. |
| `BLENDKIT_BLENDER_PATH`         | Client-stored Blender                              | Absolute path to the Blender that runs the `export_glb` recipe. |
| `THREENATIVE_TOOLCHAIN_AUTOINSTALL` | `1`                                            | Set to `0` to disable first-use external-tool installs.  |
| `THREENATIVE_TOOLCHAIN_DIR`     | OS cache under `threenative-asset-mcp/toolchain`   | UE Viewer, FabCLI, and uncooked-converter cache.          |
| `THREENATIVE_UMODEL_PATH`       | auto-detected/provisioned                           | Absolute path to a UE Viewer executable override.        |
| `THREENATIVE_UNCOOKED_CONVERTER_PATH` | auto-detected/provisioned                     | Absolute path to `unreal-assets-to-glb`.                  |
| `THREENATIVE_FABCLI_PATH`       | auto-detected/provisioned                           | Absolute path to FabCLI; login remains user-controlled.  |

Direct requests are spaced at least `FAB_MIN_REQUEST_INTERVAL_MS` apart. Only
HTTP 429, 502, 503, and 504 are retried, at most twice, with backoff and
`Retry-After` support. Challenges, access denial, invalid input, missing
listings, and schema drift are never retried by the transport; a
curl-impersonate challenge response is additionally retried inside the
impersonation wrapper with longer, jittered waits before the browser fallback
is engaged.
