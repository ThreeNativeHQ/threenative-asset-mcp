import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";

/** PRD-120. ThreeNative's own asset catalog on Cloudflare, in two tiers on one host.
 *
 * With no configuration it reads the public tier: one static manifest of ThreeNative-seeded assets
 * (`/api/assets/public/catalog.json`), cached here for ten minutes and revalidated by ETag, ranked
 * locally, and files fetched with no token. Inside a ThreeNative Studio container, which injects
 * `GATEWAY_URL` and a short-lived `GATEWAY_TOKEN` itself, it searches the Studio cache instead: the public
 * seeds plus the account's shared pool and its own private models, sounds and procedural builders. */

export const PUBLIC_ASSETS_ORIGIN = "https://gateway.threenative.com";
const CATALOG_TTL_MS = 10 * 60_000;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const THREENATIVE_FILE_PATH = new RegExp(`^/api/assets/(?:public|cache)/${UUID}$`, "u");
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;

export type ThreeNativeType = "model" | "texture" | "audio";
export interface ThreeNativeItem {
  id: string;
  prompt: string;
  tags: string;
  type: ThreeNativeType;
  origin: "custom" | "procedural";
  license: string;
  author: string;
  hasPreview: boolean;
  /** `public`: a ThreeNative seed anyone may fetch; `studio`: the Studio cache, fetched with the token. */
  tier: "public" | "studio";
  slug?: string;
}

interface CatalogItem {
  id: string;
  slug: string;
  prompt: string;
  tags: string;
  type: ThreeNativeType;
  origin: "custom" | "procedural";
  license: string;
  author: string;
  hasPreview: boolean;
}
interface StudioItem {
  id: string;
  prompt: string;
  tags: string;
  provider: string;
  hasPreview: boolean;
  type?: ThreeNativeType;
  origin?: "custom" | "procedural";
}

export class ThreeNativeError extends Error {}

const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

export class ThreeNativeCatalogClient {
  private readonly fetch: typeof globalThis.fetch;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;
  private cached?: { etag: string | null; items: CatalogItem[]; at: number };
  private retryAt = 0;

  constructor(
    options: { fetch?: typeof globalThis.fetch; env?: NodeJS.ProcessEnv; now?: () => number } = {},
  ) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.env = options.env ?? process.env;
    this.now = options.now ?? Date.now;
  }

  /** The Studio gateway, only when the container injected both values. */
  get gateway(): { origin: string; token: string } | undefined {
    const { GATEWAY_URL: url, GATEWAY_TOKEN: token } = this.env;
    if (!url || !token) return undefined;
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:" ? { origin: parsed.origin, token } : undefined;
    } catch {
      // A malformed GATEWAY_URL is no gateway: the public tier still answers.
      return undefined;
    }
  }

  /** The hosts a ThreeNative file may come from. */
  hosts(): string[] {
    const gateway = this.gateway;
    return [new URL(PUBLIC_ASSETS_ORIGIN).hostname, ...(gateway ? [new URL(gateway.origin).hostname] : [])];
  }

  /** The bearer token for a Studio cache file on the gateway host, and nothing for any other URL. */
  authFor(url: URL): Record<string, string> {
    const gateway = this.gateway;
    if (!gateway || url.origin !== gateway.origin || !url.pathname.startsWith("/api/assets/cache/"))
      return {};
    return { authorization: `Bearer ${gateway.token}` };
  }

  fileUrl(item: ThreeNativeItem): string {
    const gateway = this.gateway;
    return item.tier === "studio" && gateway
      ? `${gateway.origin}/api/assets/cache/${item.id}`
      : `${PUBLIC_ASSETS_ORIGIN}/api/assets/public/${item.id}`;
  }

  async search(query: string, type: ThreeNativeType, limit: number, signal: AbortSignal) {
    const gateway = this.gateway;
    if (gateway) {
      const studio = await this.studioSearch(gateway, query, type, limit, signal);
      if (studio) return studio;
    }
    const wanted = words(query);
    const scored = (await this.catalog(signal))
      .filter((item) => item.type === type)
      .map((item) => {
        const haystack = new Set(words(`${item.slug} ${item.prompt} ${item.tags}`));
        return { item, score: wanted.filter((word) => haystack.has(word)).length };
      })
      .filter((entry) => wanted.length === 0 || entry.score > 0)
      .sort((a, b) => b.score - a.score || a.item.slug.localeCompare(b.item.slug));
    return scored.slice(0, limit).map(({ item }): ThreeNativeItem => ({ ...item, tier: "public" }));
  }

  /** A public seed by id, from the cached manifest. */
  async publicItem(id: string, signal: AbortSignal): Promise<ThreeNativeItem | undefined> {
    const item = (await this.catalog(signal)).find((entry) => entry.id === id);
    return item ? { ...item, tier: "public" } : undefined;
  }

  /** The Studio cache search, or `undefined` when it refuses (a trial, an expired token): then the
   * public tier answers instead. */
  private async studioSearch(
    gateway: { origin: string; token: string },
    query: string,
    type: ThreeNativeType,
    limit: number,
    signal: AbortSignal,
  ): Promise<ThreeNativeItem[] | undefined> {
    const url = new URL("/api/assets/cache/search", gateway.origin);
    url.searchParams.set("q", query);
    url.searchParams.set("type", type);
    url.searchParams.set("limit", String(Math.min(limit, 8)));
    const reply = await this.fetch(url, {
      headers: { authorization: `Bearer ${gateway.token}` },
      signal,
    }).catch(() => undefined);
    if (!reply?.ok) return undefined;
    const { items = [] } = (await reply.json()) as { items?: StudioItem[] };
    return items.map((item) => {
      const seeded = item.provider === "threenative";
      return {
        author: seeded ? "ThreeNative" : "ThreeNative Studio",
        hasPreview: item.hasPreview,
        id: item.id,
        license: seeded ? "CC0-1.0" : "ThreeNative Studio asset cache",
        origin: item.origin ?? "custom",
        prompt: item.prompt,
        tags: item.tags,
        // A seed is fetched from the public tier: no token, and the edge cache answers.
        tier: seeded ? "public" : "studio",
        type: item.type ?? "model",
      };
    });
  }

  /** The public manifest: cached for ten minutes, revalidated by ETag, and kept (or empty) while the
   * server rate-limits this address or cannot be reached. */
  private async catalog(signal: AbortSignal): Promise<CatalogItem[]> {
    const now = this.now();
    if (this.cached && now - this.cached.at < CATALOG_TTL_MS) return this.cached.items;
    if (now < this.retryAt) return this.cached?.items ?? [];
    const reply = await this.fetch(`${PUBLIC_ASSETS_ORIGIN}/api/assets/public/catalog.json`, {
      headers: this.cached?.etag ? { "if-none-match": this.cached.etag } : {},
      signal,
    }).catch(() => undefined);
    if (reply?.status === 304 && this.cached) {
      this.cached.at = now;
      return this.cached.items;
    }
    if (reply?.status === 429) {
      const seconds = Number(reply.headers.get("retry-after"));
      this.retryAt = now + (Number.isFinite(seconds) && seconds > 0 ? seconds : 60) * 1000;
    }
    if (!reply?.ok) return this.cached?.items ?? [];
    const body = (await reply.json()) as { items?: CatalogItem[] };
    this.cached = { at: now, etag: reply.headers.get("etag"), items: body.items ?? [] };
    return this.cached.items;
  }

  /** One sound from either tier into `<directory>/threenative/<id>.wav`; an existing file is kept. */
  async downloadAudio(
    item: ThreeNativeItem,
    directory: string,
  ): Promise<{ path: string; fileName: string; sizeBytes: number; sha256: string; alreadyExisted: boolean }> {
    if (!new RegExp(`^${UUID}$`, "u").test(item.id)) throw new ThreeNativeError("Invalid asset id.");
    await mkdir(join(directory, "threenative"), { recursive: true, mode: 0o700 });
    const folder = await realpath(join(directory, "threenative"));
    const fileName = `${item.id}.wav`;
    const path = join(folder, fileName);
    const existing = await lstat(path).catch(() => undefined);
    if (existing) {
      if (!existing.isFile() || existing.isSymbolicLink())
        throw new ThreeNativeError("The audio destination is not a safe regular file.");
      const bytes = await readFile(path);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      return { alreadyExisted: true, fileName, path, sha256, sizeBytes: bytes.byteLength };
    }
    const url = new URL(this.fileUrl(item));
    const reply = await this.fetch(url, { headers: this.authFor(url), redirect: "error" });
    if (!reply.ok) throw new ThreeNativeError(`The ThreeNative asset answered ${reply.status}.`);
    const bytes = new Uint8Array(await reply.arrayBuffer());
    if (bytes.byteLength > MAX_AUDIO_BYTES) throw new ThreeNativeError("The sound is too large.");
    const temporary = join(folder, `.${fileName}.${randomUUID()}.part`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      await link(temporary, path);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return { alreadyExisted: false, fileName, path, sha256, sizeBytes: bytes.byteLength };
  }
}
