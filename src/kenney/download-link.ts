/**
 * Kenney stopped serving packs at `/media/pages/assets/<slug>/<hash>/kenney_<slug>.zip` (2026-11: that path
 * now redirects to the asset page). Its page asks `/download-link/<hex("assets/<slug>")>` for a signed,
 * expiring `/download/...` URL instead; the request needs the asset page as `Referer` and nothing else.
 * A legacy archive URL or an asset page URL resolves to that signed URL; any other URL is returned as is.
 */
const ORIGIN = "https://kenney.nl";
const LEGACY_ARCHIVE = /^\/media\/pages\/assets\/([a-z0-9-]+)\/[a-z0-9-]+\/kenney_[a-z0-9_.-]+\.zip$/i;
const ASSET_PAGE = /^\/assets\/([a-z0-9-]+)\/?$/i;

export function kenneyDownloadId(slug: string): string {
  return Buffer.from(`assets/${slug}`, "utf8").toString("hex");
}

export function kenneySlug(url: URL): string | undefined {
  if (url.hostname !== "kenney.nl") return undefined;
  return (LEGACY_ARCHIVE.exec(url.pathname) ?? ASSET_PAGE.exec(url.pathname))?.[1]?.toLowerCase();
}

/** The signed archive URL for a Kenney pack, `url` itself when it is not one, or `undefined` when Kenney
 * did not issue a usable link. */
export async function resolveKenneyDownload(
  url: URL,
  fetch: typeof globalThis.fetch,
  signal?: AbortSignal,
): Promise<URL | undefined> {
  const slug = kenneySlug(url);
  if (!slug) return url;
  const id = kenneyDownloadId(slug);
  const response = await fetch(`${ORIGIN}/download-link/${id}`, {
    redirect: "error",
    ...(signal ? { signal } : {}),
    headers: {
      accept: "application/json",
      referer: `${ORIGIN}/assets/${slug}`,
      "user-agent": "threenative-asset-mcp/0.4.0",
    },
  });
  const text = await response.text();
  if (!response.ok || text.length > 4_096) return undefined;
  let signed: URL;
  try {
    signed = new URL(String((JSON.parse(text) as { url?: unknown }).url));
  } catch {
    return undefined;
  }
  const valid =
    signed.protocol === "https:" &&
    signed.hostname === "kenney.nl" &&
    !signed.port &&
    !signed.username &&
    new RegExp(`^/download/${id}/[0-9a-f]{64}$`).test(signed.pathname) &&
    /^\d+$/.test(signed.searchParams.get("expires") ?? "");
  return valid ? signed : undefined;
}
