# Provider behavior

[← Back to the README](../README.md)

Per-provider rules, caching, licensing and transport details.

## Overview

The audio tools separate **source discovery** from **verified direct downloads**.
All ten sources are described with license caveats and official browse pages;
only packs with stable official URLs and known license metadata appear in the
direct-download catalog. The initial downloadable set is Kenney Interface
Sounds, Kenney Music Jingles, and all five Sonniss GDC 2026 archives.

`fab_search_assets` defaults to free assets. This means Fab reported at least
one free or effectively free license; it does not imply every license tier is
free. Use `fab_get_asset` before making license or price claims.

Poly Haven results are CC0 and explicitly labelled `Powered by Poly Haven`.
`polyhaven_list_files` exposes official download URLs, hashes, sizes, and
dependency relationships with pagination and resolution/format filters.
## Browser-fingerprint TLS (curl-impersonate)

Fab's `/i/*` JSON routes sit behind Cloudflare bot management that challenges
Node's default TLS fingerprint — including plain `fetch` from this MCP and
headless Chromium — while real browser fingerprints pass. When a
[curl-impersonate](https://github.com/lwthiker/curl-impersonate) wrapper (for
example `curl_chrome146`) is available on the host `PATH`, the server performs
all anonymous JSON reads through it and no browser is needed for search,
detail, or download resolution. Set `FAB_CURL_IMPERSONATE=0` to force the old
behavior (plain Node fetch plus the Playwright fallback), or point it at a
specific wrapper binary.

Downloads of free files resolve entirely through the anonymous JSON contract
when possible: listing detail → `asset-formats/{format}` file listing →
`download-info` signed URL → guarded file write. The signed distribution URL
is validated against an exact Epic distribution-host allowlist before use.
Only when the direct path is challenged does the server fall back to the
guarded browser click flow (see [troubleshooting.md](troubleshooting.md#dedicated-browser-profile-and-privacy)).

Process-local cache TTLs are five minutes for search, fifteen minutes for
listing details, six hours for taxonomy data, and ten minutes for promotions.
The shared LRU is capped at 500 entries and is cleared on process exit.

## Poly Haven API behavior

Poly Haven requests go only to `https://api.polyhaven.com`, with the required
`threenative-asset-mcp` User-Agent. Asset lists are cached for 15 minutes and
details, categories, and file trees are cached for up to one hour. Returned file
URLs are accepted only from `https://dl.polyhaven.org`.

The live API is free for personal and commercial use, but use of the API
requires a visible Poly Haven credit. The assets themselves are CC0. This MCP
includes `provider`, `license`, and `attribution` fields so downstream clients
can preserve that distinction. See the
[official API page](https://polyhaven.com/our-api) and
[API documentation](https://api.polyhaven.com/).

## Other provider behavior

ambientCG uses its anonymous, read-only v3 API. Its files are CC0 and its API
exposes searchable metadata, categories, and downloadable variants.

Smithsonian uses the anonymous Smithsonian 3D file-search API. Files exposed by
that API are part of Smithsonian Open Access; the MCP retains direct source
URLs and format/quality metadata.

Sketchfab public search, categories, and model detail do not require a token.
The download endpoint requires a token belonging to the user, configured
through `SKETCHFAB_API_TOKEN`. The token is sent only in the Sketchfab
`Authorization` header, is never logged or persisted, and is not included in
MCP responses. Sketchfab models use different Creative Commons licenses; always
inspect `license.requirements` before use.

Audio direct downloads are catalog-ID based; the MCP does not accept arbitrary
URLs. Official Kenney downloads are restricted to `kenney.nl` and Sonniss GDC
downloads to `downloads.sonniss.com`, including redirect revalidation. Sources
without a stable, verified direct contract remain discoverable as
`provider-page` instead of being falsely presented as one-click downloads.

The generic direct downloader is intentionally narrower than an arbitrary URL
fetcher. It accepts only official Poly Haven, ambientCG, Smithsonian,
Game-icons.net, and curated Kenney URL contracts. The itch.io downloader uses
fresh signed mirror URLs internally but never exposes them. Sketchfab signed
downloads are exposed through `sketchfab_get_downloads` but are not persisted
by the generic downloader because their temporary CDN hosts vary and require
the user's token-backed session. Provider-page-only sources stay provider-page-only until a stable,
license-safe download contract is verified.
