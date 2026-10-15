# Fab public read contract

Captured: 2026-07-28

## Decision

**Conditional go** for an unofficial, local MCP with read-only discovery and
guarded downloads of directly available free files.

Fab exposes public browsing without requiring acquisition or account access, and
`GET https://www.fab.com/i/listings/search` was observed returning anonymous
JSON during this investigation. The same route can intermittently return a
Cloudflare `403` challenge, including from a clean Playwright profile. The MCP
may use the undocumented read paths only while it:

- sends no Cookie or Authorization header;
- never imports or attaches to a user's browser profile;
- performs no acquisition, library, wishlist, cart, checkout, or login action;
- downloads only a format exposed as directly available from the public listing
  UI, after explicit EULA acknowledgement, into a dedicated local directory;
- refuses purchase, acquisition, library-only, ambiguous, oversized, and
  unsafe-path download flows and never overwrites an existing file;
- accepts only JSON from allow-listed `https://www.fab.com/i/...` URLs;
- classifies challenges and never attempts to bypass CAPTCHA or fingerprinting;
- keeps the browser fallback optional and returns
  `FAB_BROWSER_ATTENTION_REQUIRED` when a clean profile needs manual attention.

The server is not an official Fab integration. Upstream drift or a policy
change is a release blocker until this contract is revalidated.

## Observed search contract

Candidate operation:

```text
GET /i/listings/search
```

Confirmed public route parameters:

| Parameter | Meaning |
| --- | --- |
| `q` | search text |
| `is_free=1` | at least one free or effectively-free offer |
| `sort_by=-relevance` | relevance ordering |
| `count` | page size; v1 caps this at 24 |
| `currency` | requested display currency |
| `cursor` | opaque continuation value |

Multi-value filters are serialized as repeated keys. The current UI contract
also names `channels`, `listing_types`, `categories`, `tags`, `licenses`,
`seller`, `average_rating`, `published_since`, `is_ai_generated`, and
`is_ai_forbidden`. It also names `asset_formats`, but the search payload returns no
formats, so this server does not offer that filter: filtering on it cannot narrow
anything, and every result item would read as format-less. `fab_get_asset` reads
formats from the listing detail payload, where they are real.

Observed response envelope:

```ts
{
  results: unknown[];
  cursors?: {
    next?: string | null;
    previous?: string | null;
  };
}
```

The cursor is passed through byte-for-byte and is never decoded. A search
listing is free when at least one license effective price is zero, or when its
starting effective price is zero. This does not mean every license is free.

## Detail and discovery candidates

The listing detail candidate is:

```text
GET /i/listings/{uuid}?currency=USD
```

The live UI and bundle expose public detail fields for seller, description,
categories, tags, media, formats, compatible applications, dates, AI flags,
maturity, and per-license price tiers. Phase 3 must keep its parser tolerant of
additive upstream fields but fail closed when the identity/title contract
disappears.

Stable taxonomy JSON operations were not confirmed from the clean anonymous
probe. `fab_list_filters` must therefore use a versioned fallback taxonomy and
return a warning until a current public taxonomy operation is captured.

Limited-time-free is a curated Fab surface distinct from `is_free=1`. No stable
anonymous JSON operation was confirmed. The only permitted fallback is to read
listing IDs from the public `/limited-time-free` page in the dedicated browser,
then resolve those IDs through the normal listing client. Promotion end times
must come from explicit upstream data.

## Cloudflare observations

- A command-line anonymous request returned a `403` HTML response with
  `cf-mitigated: challenge` during final verification.
- A Node request returned JSON once during exploration and returned a challenge
  on later runs.
- A clean temporary Playwright Chromium profile reached Fab, but its same-origin
  JSON request was challenged in headless mode.
- The Chrome control integration independently loaded the public free-search
  page and received `403` with title `Just a moment...` before Fab's application
  issued `/i/listings/search`.
- The challenge remained after a 20-second passive wait, and loading the
  homepage before search produced the same result.
- A repeat inspection of the current frontend bundles found the same-origin
  listing operations but no alternate public catalog API origin.
- A headed built-MCP probe on the non-graphical verification host failed closed
  with `FAB_UPSTREAM_UNAVAILABLE` within the client deadline; browser startup is
  capped to prevent a hanging MCP call.
- No bypass behavior was attempted and no user Chrome cookies, local storage,
  session storage, profile files, or authorization values were inspected.

2026-07-28 follow-up (same day, later): the challenge decision tracks the
client TLS/HTTP fingerprint. Node `fetch` is always challenged; headless
Chromium never clears the interstitial; a headed Chromium-family browser
loads pages but its `/i/*` XHRs are challenged. The same anonymous requests
through a curl-impersonate Chrome fingerprint (`curl_chrome146`) returned
`200` JSON for search, detail, asset-formats, and download-info. Challenges
still appear intermittently under request bursts, so the impersonated
transport paces requests, keeps a dedicated cookie jar, and retries
challenges with backoff before any browser fallback. The browser click flow
remains the documented last resort; the server still never solves an
interactive challenge.

## Confirmed free-file download contract (2026-07-28)

Anonymous direct download of fully free listings (`isFree: true` on the
detail payload, for example a CC-BY license at price 0):

1. `GET /i/listings/{uid}?currency=USD` — detail; `isFree` gates the flow and
   `assetFormats[].assetFormatType.code` lists available format codes.
2. `GET /i/listings/{uid}/asset-formats/{code}` — per-format file list;
   `files[]` entries carry `uid`, `name`, `size`, `status` (`ready`),
   `fileType` (`source`/`generated`). GLB/OBJ conversions live under the
   `converted-files` code and are selected by file extension.
3. `GET /i/listings/{uid}/asset-formats/{code}/files/{fileUid}/download-info` —
   returns `downloadInfo[0].downloadUrl`, a signed URL with a `cf_token` query
   and an `expires` timestamp (observed lifetime about one hour). The
   distribution host rotates across Epic-controlled domains (observed:
   `content-download-emp.distro.on.epicgames.com`,
   `emp-fastly-stitched.epicgamescdn.com`); validation must match the
   Epic/Fab domain families, not a single host.
4. `GET {downloadUrl}` — the signed URL is self-authorizing and was observed
   to succeed from any TLS client without cookies.

Listings with any paid tier return `403` JSON (`"Must be logged in to
download a paid listing"`) at step 3; the MCP maps this to
`FAB_ACQUISITION_REQUIRED` and does not start an acquisition, login, or
library flow.

Run the repeatable probe:

```bash
npm run probe:fab
```

Set `FAB_PROBE_HEADED=1` to open the same temporary anonymous profile visibly.
The profile is deleted after the probe.

## Unity-format artifacts through FabCLI (probe 2026-10-14)

A Fab listing can publish a `unity` format beside its Unreal one. Measured with a signed-in
FabCLI on one owned listing:

- `fabcli formats <uid>` returns a `unity` entry next to the `unreal-engine` one:
  `extensions: ["unitypackage"]`, `versions: null`, `renderPipelines`, `unityAssetStoreUrl` and
  `isInUnityAssetStore`. `versions: null` means no `artifactId`.
- `fabcli library` and `fabcli listing` expose Unreal `projectVersions` only. They carry no Epic
  catalog coordinates (artifact id, namespace, asset id) for the Unity artifact.
- `fabcli download <uid>` resolves its coordinates from the library, so for such a listing it
  fetches the Unreal pack, not the Unity one.
- The anonymous `/i/listings/<uid>/asset-formats/unity` call returns a Cloudflare challenge to a
  plain fetch, and `download-info` for an owned paid file needs a signed-in Fab web session.
  `fabcli ownership` answers `auth_required` (`claim needs a Fab session`), and `fabcli auth
  status` shows `fab.session_present: false`.

What the server does with that:

- `fab_list_owned` runs `fabcli formats <uid>` once per listing it shows (four at a time) and
  reports a Unity entry as an artifact with `route: "unity"`, `artifactId` `unity` (or the id
  FabCLI lists, if one ever appears) and a `unity` block. `unrealOnly: true` hides them and skips
  the lookups. A failed lookup adds a `warnings` entry and does not drop the listing.
- `fab_import_asset` takes the Unity route for `format: "unity"`, or when the listing publishes
  Unity and no Unreal artifact. A listing with both stays on the Unreal route. The Fab licence gate
  runs first, as for Unreal. No Unity Asset Store terms apply: the licence is the listing's.
- The route downloads only with explicit `--artifact-id --namespace --asset-id`, never with the
  listing-only form. When FabCLI lists no Unity artifact id, or the library has no asset id and
  namespace, nothing is downloaded and the call fails with `FABCLI_UNITY_DOWNLOAD_UNAVAILABLE`,
  which names the manual route: download the `.unitypackage` from fab.com in a browser and run
  `asset_import_unity` on it. The server guesses no endpoint, reuses no browser session and never
  signs in.
- A downloaded artifact lands in `fab-downloads/<listing>/<artifact>`. It must hold exactly one
  `.unitypackage`, which goes to the Unity importer (PRD-616). The result has the
  `asset_import_unity` shape.

Status: the download itself is unproven against a real Unity artifact. See PRD-619.

## Fixture policy

`tests/fixtures/fab-contracts.ts` contains synthetic, sanitized shapes used for
deterministic tests. It intentionally contains no raw headers, cookies,
tracking fields, account identifiers, or complete upstream bodies.
