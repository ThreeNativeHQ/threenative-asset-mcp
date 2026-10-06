import { MetadataRequests, readMetadata, type MetadataContext } from "../discovery/metadata.js";

const API_BASE_URL = "https://api.polyhaven.com";
const DEFAULT_TIMEOUT_MS = 20_000;
const ASSETS_TTL_MS = 15 * 60 * 1_000;
const DETAIL_TTL_MS = 60 * 60 * 1_000;

export type PolyHavenAssetType = "hdris" | "textures" | "models";

export interface PolyHavenAsset {
  id: string;
  name: string;
  description?: string;
  type: PolyHavenAssetType;
  category?: string;
  categoryId?: string;
  tags: string[];
  authors: Record<string, string>;
  attributes: Record<string, unknown>;
  thumbnailUrl?: string;
  maxResolution?: number[];
  dimensions?: number[];
  polycount?: number;
  downloadCount?: number;
  publishedAt?: string;
  filesHash?: string;
  donated?: boolean;
  lods?: boolean;
}

export interface PolyHavenFile {
  path: string;
  url: string;
  sizeBytes: number;
  md5: string;
  dependencyOf?: string;
  relativePath?: string;
}

export class PolyHavenClientError extends Error {
  constructor(
    readonly code:
      | "POLYHAVEN_INVALID_INPUT"
      | "POLYHAVEN_NOT_FOUND"
      | "POLYHAVEN_RATE_LIMITED"
      | "POLYHAVEN_UPSTREAM_UNAVAILABLE"
      | "POLYHAVEN_UPSTREAM_CHANGED",
    message: string,
    readonly retryable = false,
    readonly retryAfter?: string,
  ) {
    super(message);
    this.name = "PolyHavenClientError";
  }
}

type FetchLike = typeof fetch;

interface CacheEntry {
  expiresAt: number;
  value: unknown;
  bytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, max = 12_000): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value
    .filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry))
    .slice(0, 3);
  return values.length > 0 ? values : undefined;
}

function assetType(value: unknown): PolyHavenAssetType {
  if (value === 0) return "hdris";
  if (value === 1) return "textures";
  if (value === 2) return "models";
  throw new PolyHavenClientError(
    "POLYHAVEN_UPSTREAM_CHANGED",
    "Poly Haven returned an unknown asset type.",
  );
}

function normalizeAsset(id: string, value: unknown): PolyHavenAsset {
  if (!isRecord(value)) {
    throw new PolyHavenClientError(
      "POLYHAVEN_UPSTREAM_CHANGED",
      "Poly Haven returned invalid asset metadata.",
    );
  }
  const name = stringValue(value.name, 500);
  if (!name) {
    throw new PolyHavenClientError(
      "POLYHAVEN_UPSTREAM_CHANGED",
      "Poly Haven returned an asset without a name.",
    );
  }
  const authors = isRecord(value.authors)
    ? Object.fromEntries(
        Object.entries(value.authors)
          .filter((entry): entry is [string, string] => typeof entry[1] === "string")
          .slice(0, 50),
      )
    : {};
  const tags = Array.isArray(value.tags)
    ? value.tags
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.slice(0, 100))
        .slice(0, 100)
    : [];
  const datePublished = numberValue(value.date_published);
  const description = stringValue(value.description);
  const category = stringValue(value.category, 500);
  const categoryId = stringValue(value.category_id, 100);
  const thumbnailUrl = stringValue(value.thumbnail_url, 2_048);
  const maxResolution = numberArray(value.max_resolution);
  const dimensions = numberArray(value.dimensions);
  const polycount = numberValue(value.polycount);
  const downloadCount = numberValue(value.download_count);
  const filesHash = stringValue(value.files_hash, 100);
  return {
    id,
    name,
    type: assetType(value.type),
    tags,
    authors,
    attributes: isRecord(value.attributes) ? value.attributes : {},
    ...(description ? { description } : {}),
    ...(category ? { category } : {}),
    ...(categoryId ? { categoryId } : {}),
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    ...(maxResolution ? { maxResolution } : {}),
    ...(dimensions ? { dimensions } : {}),
    ...(polycount !== undefined ? { polycount } : {}),
    ...(downloadCount !== undefined ? { downloadCount } : {}),
    ...(datePublished !== undefined
      ? { publishedAt: new Date(datePublished * 1_000).toISOString() }
      : {}),
    ...(filesHash ? { filesHash } : {}),
    ...(typeof value.donated === "boolean" ? { donated: value.donated } : {}),
    ...(typeof value.lods === "boolean" ? { lods: value.lods } : {}),
  };
}

function normalizeFiles(value: unknown): PolyHavenFile[] {
  const files: PolyHavenFile[] = [];

  const walk = (
    node: unknown,
    path: string[],
    dependencyOf?: string,
    relativePath?: string,
  ): void => {
    if (path.length > 12 || files.length > 256)
      throw new PolyHavenClientError(
        "POLYHAVEN_UPSTREAM_CHANGED",
        "Poly Haven file metadata exceeds its depth or count limit.",
      );
    if (!isRecord(node)) {
      if (dependencyOf)
        throw new PolyHavenClientError(
          "POLYHAVEN_UPSTREAM_CHANGED",
          "Poly Haven returned an invalid companion file.",
        );
      return;
    }
    const url = stringValue(node.url, 2_048);
    const size = numberValue(node.size);
    const md5 = stringValue(node.md5, 64);
    if (("url" in node || "size" in node || "md5" in node) && (!url || size === undefined || !md5))
      throw new PolyHavenClientError(
        "POLYHAVEN_UPSTREAM_CHANGED",
        "Poly Haven returned incomplete file metadata.",
      );
    if (url && size !== undefined && md5) {
      if (files.length >= 256)
        throw new PolyHavenClientError(
          "POLYHAVEN_UPSTREAM_CHANGED",
          "Poly Haven file metadata exceeds the file count limit.",
        );
      try {
        const parsed = new URL(url);
        if (
          parsed.protocol !== "https:" ||
          parsed.hostname !== "dl.polyhaven.org" ||
          parsed.username ||
          parsed.password ||
          parsed.port ||
          parsed.hash ||
          parsed.search
        ) {
          throw new Error("Unsafe provider file URL.");
        }
      } catch {
        throw new PolyHavenClientError(
          "POLYHAVEN_UPSTREAM_CHANGED",
          "Poly Haven returned an unsafe file URL.",
        );
      }
      if (!Number.isSafeInteger(size) || size < 0 || !/^[a-f0-9]{32}$/i.test(md5))
        throw new PolyHavenClientError(
          "POLYHAVEN_UPSTREAM_CHANGED",
          "Poly Haven returned invalid file size or checksum.",
        );
      files.push({
        path: path.join("/"),
        url,
        sizeBytes: size,
        md5,
        ...(dependencyOf ? { dependencyOf } : {}),
        ...(relativePath ? { relativePath } : {}),
      });
    }
    if (dependencyOf && (!url || size === undefined || !md5))
      throw new PolyHavenClientError(
        "POLYHAVEN_UPSTREAM_CHANGED",
        "Poly Haven returned an incomplete companion file.",
      );
    for (const [key, child] of Object.entries(node)) {
      if (key === "include" && isRecord(child)) {
        if (dependencyOf)
          throw new PolyHavenClientError(
            "POLYHAVEN_UPSTREAM_CHANGED",
            "Nested companion dependencies are unsupported; no files were omitted.",
          );
        const parentPath = path.join("/");
        for (const [includePath, includeValue] of Object.entries(child)) {
          walk(includeValue, [...path, "include", includePath], parentPath, includePath);
        }
      } else if (!["url", "size", "md5"].includes(key)) {
        walk(child, [...path, key], dependencyOf, relativePath);
      }
    }
  };

  walk(value, []);
  return files;
}

export class PolyHavenClient {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly requests = new MetadataRequests();
  private cacheBytes = 0;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    options: { timeoutMs?: number; userAgent?: string } = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.userAgent = options.userAgent ?? "threenative-asset-mcp/0.4.0 (MCP asset browser)";
  }

  private async request(
    path: string,
    ttlMs: number,
    context: MetadataContext = {},
  ): Promise<unknown> {
    context.signal?.throwIfAborted();
    const cached = this.cache.get(path);
    if (!context.fresh && cached && cached.expiresAt > Date.now()) return cached.value;
    return this.requests.run(
      `${context.fresh ? "fresh:" : ""}${path}`,
      context.signal,
      async (callerSignal) => {
        const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(this.timeoutMs)]);

        let response: Response;
        try {
          response = await this.fetchImpl(`${API_BASE_URL}${path}`, {
            headers: {
              accept: "application/json",
              "user-agent": this.userAgent,
            },
            signal,
            redirect: "error",
          });
        } catch {
          throw new PolyHavenClientError(
            "POLYHAVEN_UPSTREAM_UNAVAILABLE",
            "Poly Haven could not be reached.",
            true,
          );
        }
        if (!response.ok) await response.body?.cancel();
        if (response.status === 404) {
          throw new PolyHavenClientError(
            "POLYHAVEN_NOT_FOUND",
            "The Poly Haven resource was not found.",
          );
        }
        if (response.status === 429) {
          throw new PolyHavenClientError(
            "POLYHAVEN_RATE_LIMITED",
            "Poly Haven rate-limited the request.",
            true,
            response.headers.get("retry-after")?.slice(0, 100),
          );
        }
        if (!response.ok) {
          throw new PolyHavenClientError(
            "POLYHAVEN_UPSTREAM_UNAVAILABLE",
            `Poly Haven returned HTTP ${response.status}.`,
            response.status >= 500,
          );
        }
        let value: unknown;
        try {
          value = JSON.parse(await readMetadata(response, 16 * 1024 * 1024, signal)) as unknown;
        } catch {
          throw new PolyHavenClientError(
            "POLYHAVEN_UPSTREAM_CHANGED",
            "Poly Haven returned invalid JSON.",
          );
        }
        const bytes = Buffer.byteLength(JSON.stringify(value));
        const previous = this.cache.get(path);
        if (previous) this.cacheBytes -= previous.bytes;
        this.cache.delete(path);
        this.cache.set(path, { value, bytes, expiresAt: Date.now() + ttlMs });
        this.cacheBytes += bytes;
        while (this.cache.size > 64 || this.cacheBytes > 32 * 1024 * 1024) {
          const oldest = this.cache.keys().next().value;
          if (oldest === undefined) break;
          this.cacheBytes -= this.cache.get(oldest)!.bytes;
          this.cache.delete(oldest);
        }
        return value;
      },
    );
  }

  async listAssets(
    type: PolyHavenAssetType | "all",
    context: MetadataContext = {},
  ): Promise<PolyHavenAsset[]> {
    const query = type === "all" ? "" : `?type=${encodeURIComponent(type)}`;
    const value = await this.request(`/assets${query}`, ASSETS_TTL_MS, context);
    if (!isRecord(value)) {
      throw new PolyHavenClientError(
        "POLYHAVEN_UPSTREAM_CHANGED",
        "Poly Haven returned an invalid asset list.",
      );
    }
    if (Object.keys(value).length > 20_000)
      throw new PolyHavenClientError(
        "POLYHAVEN_UPSTREAM_CHANGED",
        "Poly Haven asset list exceeds its entry limit.",
      );
    return Object.entries(value).map(([id, metadata]) => normalizeAsset(id, metadata));
  }

  async getAsset(id: string, context: MetadataContext = {}): Promise<PolyHavenAsset> {
    return normalizeAsset(
      id,
      await this.request(`/info/${encodeURIComponent(id)}`, DETAIL_TTL_MS, context),
    );
  }

  async listFiles(id: string, context: MetadataContext = {}): Promise<PolyHavenFile[]> {
    return normalizeFiles(
      await this.request(`/files/${encodeURIComponent(id)}`, DETAIL_TTL_MS, context),
    );
  }

  async listCategories(
    type: PolyHavenAssetType,
    context: MetadataContext = {},
  ): Promise<Array<{ name: string; assetCount: number }>> {
    const value = await this.request(
      `/categories/${encodeURIComponent(type)}`,
      ASSETS_TTL_MS,
      context,
    );
    if (!isRecord(value)) {
      throw new PolyHavenClientError(
        "POLYHAVEN_UPSTREAM_CHANGED",
        "Poly Haven returned an invalid category list.",
      );
    }
    return Object.entries(value)
      .filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === "number" && Number.isInteger(entry[1]),
      )
      .map(([name, assetCount]) => ({ name, assetCount }))
      .sort((a, b) => b.assetCount - a.assetCount || a.name.localeCompare(b.name));
  }
}
