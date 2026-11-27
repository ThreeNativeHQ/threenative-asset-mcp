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
/** A file, or its manifest or one companion member (0 to 15). */
export const THREENATIVE_FILE_PATH = new RegExp(
  `^/api/assets/(?:public|cache)/${UUID}(?:/manifest|/members/(?:[0-9]|1[0-5]))?$`,
  "u",
);
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;

export type ThreeNativeType = "model" | "texture" | "audio";
/** What a Studio cache download answers. A procedural row is a baked GLB or a legacy builder entry, so the
 * representation is the Worker's own word, never inferred from `origin`. */
export type ThreeNativeFormat = "glb" | "procedural-json" | "wav" | "png";
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
  format?: ThreeNativeFormat;
  /** SHA-256 of the stored main file, when the server names it. */
  contentHash?: string;
  /** `complete` when the Worker recorded the file self-contained with every companion stored; anything
   * else (an older entry, an older Worker) is unknown, and a download checks the file itself. */
  completeness?: "complete" | "unknown";
  /** How many companion files (source textures, reports, license, receipts) travel with it. */
  memberCount?: number;
}

/** One companion file the Worker's manifest lists, and the provenance it keeps. */
export interface ThreeNativeManifest {
  members: { index: number; path: string; role: string; bytes: number; sha256: string }[];
  provenance?: { license?: { name?: string; url?: string } };
}

const completenessOf = (value: unknown): "complete" | "unknown" =>
  value === "complete" ? "complete" : "unknown";
const countOf = (value: unknown): number | undefined => {
  const count = Number(value);
  return value !== null && value !== undefined && Number.isInteger(count) && count >= 0 && count <= 16
    ? count
    : undefined;
};

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
  completeness?: string;
  memberCount?: number;
}
interface StudioItem {
  id: string;
  prompt: string;
  tags: string;
  provider: string;
  hasPreview: boolean;
  type?: ThreeNativeType;
  origin?: "custom" | "procedural";
  format?: ThreeNativeFormat;
  license?: string;
  author?: string;
  contentHash?: string;
  completeness?: string;
  memberCount?: number;
}

const FORMATS: readonly ThreeNativeFormat[] = ["glb", "procedural-json", "wav", "png"];
const formatOf = (value: unknown): ThreeNativeFormat | undefined =>
  FORMATS.find((format) => format === value);

/** A URI-encoded header value from the Studio cache, or `undefined`. */
function header(reply: Response, name: string): string | undefined {
  try {
    return decodeURIComponent(reply.headers.get(name) ?? "") || undefined;
  } catch {
    // A malformed escape is no value.
    return undefined;
  }
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
    return scored.slice(0, limit).map(({ item }) => this.publicOf(item));
  }

  private publicOf(item: CatalogItem): ThreeNativeItem {
    const { completeness, memberCount, ...rest } = item;
    const count = countOf(memberCount);
    return {
      ...rest,
      completeness: completenessOf(completeness),
      tier: "public",
      ...(count === undefined ? {} : { memberCount: count }),
    };
  }

  /** A public seed by id, from the cached manifest. */
  async publicItem(id: string, signal: AbortSignal): Promise<ThreeNativeItem | undefined> {
    const item = (await this.catalog(signal)).find((entry) => entry.id === id);
    return item ? this.publicOf(item) : undefined;
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
    // A seed's license and author are the server's facts: the Studio row's own, else the public catalog's.
    // A Worker that names neither leaves them unknown rather than assumed CC0.
    const catalog = items.some((item) => item.provider === "threenative" && item.license === undefined)
      ? await this.catalog(signal)
      : [];
    return items.map((item): ThreeNativeItem => {
      const seeded = item.provider === "threenative";
      const listed = seeded ? catalog.find((entry) => entry.id === item.id) : undefined;
      const format = formatOf(item.format);
      const count = countOf(item.memberCount);
      return {
        completeness: completenessOf(item.completeness),
        ...(count === undefined ? {} : { memberCount: count }),
        author: item.author ?? listed?.author ?? (seeded ? "unknown" : "ThreeNative Studio"),
        hasPreview: item.hasPreview,
        id: item.id,
        license: item.license ?? listed?.license ?? (seeded ? "unknown" : "ThreeNative Studio asset cache"),
        origin: item.origin ?? "custom",
        prompt: item.prompt,
        tags: item.tags,
        // A seed is fetched from the public tier: no token, and the edge cache answers.
        tier: seeded ? "public" : "studio",
        type: item.type ?? "model",
        ...(format === undefined ? {} : { format }),
        ...(item.contentHash === undefined ? {} : { contentHash: item.contentHash }),
        ...(listed?.slug === undefined ? {} : { slug: listed.slug }),
      };
    });
  }

  /** One Studio cache row's facts from `HEAD /api/assets/cache/<id>`: its representation, prompt, license,
   * author, hash and preview, with no body and no reuse counted. `undefined` when the row is not readable
   * (absent, private to another account) or the Worker predates the HEAD answer. */
  async studioItem(id: string, origin: "custom" | "procedural", signal: AbortSignal): Promise<ThreeNativeItem | undefined> {
    const gateway = this.gateway;
    if (!gateway || !new RegExp(`^${UUID}$`, "u").test(id)) return undefined;
    const url = new URL(`/api/assets/cache/${id}`, gateway.origin);
    const reply = await this.fetch(url, {
      headers: { authorization: `Bearer ${gateway.token}` },
      method: "HEAD",
      redirect: "error",
      signal,
    }).catch(() => undefined);
    const format = reply?.ok ? formatOf(reply.headers.get("x-tn-format")) : undefined;
    if (!reply || format === undefined) return undefined;
    const seeded = header(reply, "x-tn-provider") === "threenative";
    const contentHash = reply.headers.get("x-tn-sha256") ?? undefined;
    const count = countOf(reply.headers.get("x-tn-members"));
    return {
      completeness: completenessOf(reply.headers.get("x-tn-completeness")),
      ...(count === undefined ? {} : { memberCount: count }),
      author: header(reply, "x-tn-author") ?? (seeded ? "unknown" : "ThreeNative Studio"),
      format,
      hasPreview: reply.headers.get("x-tn-preview") === "1",
      id,
      license: header(reply, "x-tn-license") ?? (seeded ? "unknown" : "ThreeNative Studio asset cache"),
      origin,
      prompt: header(reply, "x-tn-prompt") ?? id,
      tags: "",
      tier: "studio",
      type: format === "wav" ? "audio" : format === "png" ? "texture" : "model",
      ...(contentHash === undefined ? {} : { contentHash }),
    };
  }

  /** The companion manifest of a file (`<file>/manifest`), with the bytes it was read as, or `undefined`
   * when it cannot be read or is not one. */
  async manifest(
    item: ThreeNativeItem,
    signal: AbortSignal,
  ): Promise<{ manifest: ThreeNativeManifest; bytes: Uint8Array } | undefined> {
    const url = new URL(`${this.fileUrl(item)}/manifest`);
    const reply = await this.fetch(url, { headers: this.authFor(url), redirect: "error", signal }).catch(
      () => undefined,
    );
    if (!reply?.ok) return undefined;
    const bytes = new Uint8Array(await reply.arrayBuffer());
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      // Not JSON: no manifest.
      return undefined;
    }
    const members = (parsed as { members?: unknown })?.members;
    const valid =
      Array.isArray(members) &&
      members.length <= 16 &&
      members.every(
        (member: Record<string, unknown>) =>
          Number.isInteger(member?.index) &&
          typeof member.path === "string" &&
          typeof member.role === "string" &&
          Number.isSafeInteger(member.bytes) &&
          typeof member.sha256 === "string" &&
          /^[0-9a-f]{64}$/u.test(member.sha256),
      );
    return valid ? { bytes, manifest: parsed as ThreeNativeManifest } : undefined;
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
