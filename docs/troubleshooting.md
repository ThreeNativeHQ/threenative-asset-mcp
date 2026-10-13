# Troubleshooting, browser profile and privacy

[← Back to the README](../README.md)

Fixes for common errors, plus what the dedicated browser profile does and does not touch.

## Dedicated browser profile and privacy

When a direct anonymous request receives a Cloudflare challenge, the server may
open Playwright Chromium with a dedicated MCP-owned profile. It never attaches
to, copies, or reads the user's normal Chrome/Edge/Chromium profile, cookie
database, local storage, passwords, or Epic session.

If the tool returns `FAB_BROWSER_ATTENTION_REQUIRED`, run the same MCP command
once with `FAB_BROWSER_HEADLESS=0`. The MCP opens its dedicated Fab homepage at
startup, so complete any visible verification before calling the tool. A tool
call allows an additional `FAB_BROWSER_MANUAL_TIMEOUT_MS` grace period, then
returns `FAB_BROWSER_ATTENTION_REQUIRED` rather than exceeding typical MCP
client timeouts. Close the MCP process after verification and return to headless
mode. The server does not solve or bypass challenges.

Browser process startup is capped at ten seconds. On a host without a working
graphical session, headed mode returns `FAB_UPSTREAM_UNAVAILABLE` instead of
hanging an MCP call; run the manual release gate on a graphical host.

To clear browser-owned Fab state, stop every `threenative-asset-mcp` process and
move only the dedicated directory reported by your configuration out of
service. The default on Linux can be cleared recoverably with:

```bash
mv -- "${XDG_STATE_HOME:-$HOME/.local/state}/threenative-asset-mcp/fab-browser-profile" \
  "${XDG_STATE_HOME:-$HOME/.local/state}/threenative-asset-mcp/fab-browser-profile.cleared"
```

Do not point `FAB_BROWSER_PROFILE_DIR` at a normal browser profile. The server
rejects known normal-profile locations.

The MCP has no analytics or remote telemetry. Application logs are structured
JSON written only to stderr; stdout is reserved for MCP JSON-RPC. Search query
text is omitted from logs unless `FAB_LOG_QUERIES=1`. Raw upstream bodies,
headers, cookies, tokens, stack traces, and browser profile paths are not logged
or returned to the model.

## Troubleshooting

`FAB_CHALLENGE` or `FAB_BROWSER_ATTENTION_REQUIRED`
: Fab asked for browser verification. First check whether a curl-impersonate
wrapper is installed (`FAB_LOG_LEVEL=info` logs `fab_impersonate_enabled`
when active). Otherwise use the headed dedicated-profile step in the section above. If
verification continues to fail, stop; do not copy a signed-in browser
session.

`FAB_RATE_LIMITED`
: Wait for `retryAfterSeconds` when present. The MCP already applied its bounded
retries.

`FAB_UPSTREAM_CHANGED`
: Fab's undocumented response changed. Re-run the sanitized contract probe and
update normalization and fixtures before continuing.

`FAB_UPSTREAM_UNAVAILABLE`
: Fab is unavailable, or a currently unverified discovery contract was
  intentionally disabled.

The MCP host shows no tools
: Build first, confirm the configured path is absolute, and run
`npm run inspect`. Logs belong on stderr; any non-JSON stdout is a bug.
