import { MetadataRequests, readMetadata } from "../discovery/metadata.js";

const BASE = "https://kenney.nl";
const PAGE_BYTES = 1024 * 1024;
export interface KenneyEntry {
  id: string;
  title: string;
  category: string;
  thumbnailUrl?: string;
}
export interface KenneyDetail extends KenneyEntry {
  licenseConfirmed: boolean;
  freeConfirmed: boolean;
  termsText: string;
  downloadUrl?: string;
}

export class KenneyClientError extends Error {
  constructor(
    readonly code:
      | "KENNEY_INVALID_INPUT"
      | "KENNEY_UPSTREAM_CHANGED"
      | "KENNEY_RATE_LIMITED"
      | "KENNEY_NOT_FOUND"
      | "KENNEY_UPSTREAM_UNAVAILABLE",
    message: string,
    readonly retryable = false,
    readonly retryAfter?: string,
  ) {
    super(message);
    this.name = "KenneyClientError";
  }
}

function attribute(tag: string, key: string): string | undefined {
  return new RegExp(`\\b${key}\\s*=\\s*(["'])(.*?)\\1`, "i").exec(tag)?.[2];
}
function plain(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&(?:nbsp|bull);/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}
function officialUrl(value: string): URL {
  const url = new URL(value.replace(/&amp;/g, "&"), BASE);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "kenney.nl" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  )
    throw new KenneyClientError(
      "KENNEY_UPSTREAM_CHANGED",
      "Kenney returned an unsafe metadata URL.",
    );
  return url;
}
function checkHtml(html: string): void {
  if (Buffer.byteLength(html) > PAGE_BYTES)
    throw new KenneyClientError(
      "KENNEY_UPSTREAM_CHANGED",
      "Kenney page exceeds the metadata byte limit.",
    );
}
function category(html: string): string {
  for (const link of html.matchAll(/<a\b[^>]*>[^<]*<\/a>/gi)) {
    const href = attribute(link[0], "href");
    if (href && /\/assets(?:\/category:|\?category=)/i.test(href)) return plain(link[0]);
  }
  return "unknown";
}

/** Only the observed card schema is supported; no executable page scripts or catalog crawl. */
export function parseKenneyListing(html: string): { entries: KenneyEntry[]; truncated: boolean } {
  checkHtml(html);
  const cards = html
    .split(/<div\b[^>]*\bclass\s*=\s*["'][^"']*\basset\b[^"']*["'][^>]*>/i)
    .slice(1);
  if (cards.length === 0 || cards.length > 100)
    throw new KenneyClientError(
      "KENNEY_UPSTREAM_CHANGED",
      "Kenney listing schema is missing or exceeds its entry limit.",
    );
  const seen = new Set<string>();
  const entries = cards.map((card) => {
    const heading = /<h2\b[^>]*>\s*(<a\b[^>]*>.*?<\/a>)\s*<\/h2>/is.exec(card)?.[1];
    const href = heading && attribute(heading, "href");
    const url = href && officialUrl(href);
    const id = url && /^\/assets\/([a-z0-9][a-z0-9-]{0,199})\/?$/.exec(url.pathname)?.[1];
    const title = heading && plain(heading);
    if (!id || !title || seen.has(id))
      throw new KenneyClientError(
        "KENNEY_UPSTREAM_CHANGED",
        "Kenney returned an invalid or duplicate asset card.",
      );
    seen.add(id);
    const cover = /<div\b[^>]*\bclass\s*=\s*["']cover["'][^>]*>/i.exec(card)?.[0];
    const style = cover && attribute(cover, "style");
    const image = style && /url\(["']?([^"')]+)["']?\)/i.exec(style)?.[1];
    const thumbnailUrl = image ? officialUrl(image).href : undefined;
    return { id, title, category: category(card), ...(thumbnailUrl ? { thumbnailUrl } : {}) };
  });
  return { entries, truncated: /\/assets\/page:[2-9][0-9]*/i.test(html) };
}

export function parseKenneyDetail(html: string, id: string): KenneyDetail {
  if (!/^[a-z0-9][a-z0-9-]{0,199}$/.test(id))
    throw new KenneyClientError("KENNEY_INVALID_INPUT", "Invalid Kenney asset ID.");
  checkHtml(html);
  const title = plain(/<h1\b[^>]*>(.*?)<\/h1>/is.exec(html)?.[1] ?? "");
  const table = /<table\b[^>]*>(.*?)<\/table>/is.exec(html)?.[1];
  if (!title || !table || !/\bCategory\b/i.test(table))
    throw new KenneyClientError("KENNEY_UPSTREAM_CHANGED", "Kenney detail schema is missing.");
  const licenseRow = [...table.matchAll(/<tr\b[^>]*>(.*?)<\/tr>/gis)]
    .map((row) => row[1]!)
    .find((row) => /<td\b[^>]*>\s*License\s*<\/td>/i.test(row));
  const licenseLink = licenseRow && /<a\b[^>]*>.*?<\/a>/is.exec(licenseRow)?.[0];
  const licenseHref = licenseLink && attribute(licenseLink, "href");
  const licenseConfirmed =
    !!licenseHref &&
    /^https:\/\/creativecommons\.org\/publicdomain\/zero\/1\.0\/?$/i.test(licenseHref) &&
    /\bCC0\b/i.test(plain(licenseLink!));
  const downloadTag = [...html.matchAll(/<a\b[^>]*>/gi)]
    .map((match) => match[0])
    .find((tag) => attribute(tag, "id") === "donate-text");
  const downloadHref = downloadTag && attribute(downloadTag, "href");
  let downloadUrl: string | undefined;
  if (downloadHref) {
    const url = officialUrl(downloadHref);
    if (
      !new RegExp(`^/media/pages/assets/${id}/[a-z0-9-]+/kenney_[a-z0-9_.-]+\\.zip$`, "i").test(
        url.pathname,
      ) ||
      url.search
    )
      throw new KenneyClientError(
        "KENNEY_UPSTREAM_CHANGED",
        "Kenney returned an unsupported archive path.",
      );
    downloadUrl = url.href;
  }
  const freeConfirmed = /game assets[^<]{0,150}available for free/i.test(html) && !!downloadUrl;
  return {
    id,
    title,
    category: category(table),
    licenseConfirmed,
    freeConfirmed,
    termsText: `Selected pack ${id}: ${licenseConfirmed ? "Creative Commons CC0 1.0 shown in the item license row." : "Item license is unknown."} ${freeConfirmed ? "Item donation panel explicitly states the assets are available for free." : "Item free availability is unconfirmed."}`,
    ...(downloadUrl ? { downloadUrl } : {}),
  };
}

export class KenneyClient {
  private readonly requests = new MetadataRequests();
  private tail: Promise<unknown> = Promise.resolve();
  private nextRequestAt = 0;
  private readonly minimumIntervalMs: number;

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    options: { minimumIntervalMs?: number } = {},
  ) {
    this.minimumIntervalMs = options.minimumIntervalMs ?? 500;
    if (
      !Number.isInteger(this.minimumIntervalMs) ||
      this.minimumIntervalMs < 0 ||
      this.minimumIntervalMs > 5000
    )
      throw new KenneyClientError("KENNEY_INVALID_INPUT", "Invalid Kenney request interval.");
  }

  private request(path: string, callerSignal: AbortSignal): Promise<string> {
    return this.requests.run(path, callerSignal, async (sharedSignal) => {
      const signal = AbortSignal.any([sharedSignal, AbortSignal.timeout(20_000)]);
      const previous = this.tail;
      let release!: () => void;
      this.tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      try {
        await previous;
        signal.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(signal.reason);
          };
          const timer = setTimeout(
            () => {
              signal.removeEventListener("abort", abort);
              resolve();
            },
            Math.min(2_147_483_647, Math.max(0, this.nextRequestAt - Date.now())),
          );
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
        this.nextRequestAt = Date.now() + this.minimumIntervalMs;
        const response = await this.fetchImpl(`${BASE}${path}`, {
          redirect: "error",
          signal,
          headers: {
            accept: "text/html",
            "user-agent": "threenative-asset-mcp (bounded asset discovery)",
          },
        });
        if (response.status === 429) {
          const retryAfter = response.headers.get("retry-after")?.slice(0, 100);
          const retryAt =
            retryAfter && /^\d{1,7}$/.test(retryAfter)
              ? Date.now() + Number(retryAfter) * 1000
              : retryAfter
                ? Date.parse(retryAfter)
                : Number.NaN;
          if (Number.isFinite(retryAt)) this.nextRequestAt = Math.max(this.nextRequestAt, retryAt);
          await response.body?.cancel();
          throw new KenneyClientError(
            "KENNEY_RATE_LIMITED",
            "Kenney rate-limited metadata requests.",
            true,
            retryAfter,
          );
        }
        if (!response.ok) await response.body?.cancel();
        if (response.status === 404)
          throw new KenneyClientError("KENNEY_NOT_FOUND", "Kenney asset was not found.");
        if (!response.ok || response.redirected)
          throw new KenneyClientError(
            "KENNEY_UPSTREAM_UNAVAILABLE",
            "Kenney metadata request failed.",
            true,
          );
        return await readMetadata(response, PAGE_BYTES, signal);
      } finally {
        release();
      }
    });
  }

  async search(
    query: string,
    signal: AbortSignal,
  ): Promise<{ entries: KenneyEntry[]; truncated: boolean }> {
    const params = new URLSearchParams({ search: query.slice(0, 500) });
    return parseKenneyListing(await this.request(`/assets?${params}`, signal));
  }

  async get(id: string, signal: AbortSignal): Promise<KenneyDetail> {
    if (!/^[a-z0-9][a-z0-9-]{0,199}$/.test(id))
      throw new KenneyClientError("KENNEY_INVALID_INPUT", "Invalid Kenney asset ID.");
    return parseKenneyDetail(await this.request(`/assets/${id}`, signal), id);
  }
}
