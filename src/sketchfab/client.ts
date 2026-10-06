import { MetadataRequests, readMetadata, type MetadataContext } from "../discovery/metadata.js";

const API_BASE = "https://api.sketchfab.com/v3";

export interface SketchfabArchive {
  format: string;
  sizeBytes?: number;
  textureCount?: number;
  textureMaxResolution?: number;
  faceCount?: number;
  vertexCount?: number;
  url?: string;
  expiresInSeconds?: number;
}

export interface SketchfabModel {
  id: string;
  name: string;
  description?: string;
  viewerUrl: string;
  embedUrl?: string;
  thumbnailUrl?: string;
  author?: { id?: string; username: string; displayName?: string; profileUrl?: string };
  tags: string[];
  categories: string[];
  license?: {
    label: string;
    slug?: string;
    url?: string;
    requirements?: string;
  };
  downloadable: boolean;
  ageRestricted?: boolean;
  animated: boolean;
  faceCount?: number;
  vertexCount?: number;
  viewCount?: number;
  likeCount?: number;
  downloadCount?: number;
  publishedAt?: string;
  updatedAt?: string;
  archives: SketchfabArchive[];
}

export interface SketchfabSearchResult {
  models: SketchfabModel[];
  nextCursor?: string;
}

export class SketchfabClientError extends Error {
  constructor(
    readonly code:
      | "SKETCHFAB_INVALID_INPUT"
      | "SKETCHFAB_NOT_FOUND"
      | "SKETCHFAB_AUTH_REQUIRED"
      | "SKETCHFAB_ACCESS_DENIED"
      | "SKETCHFAB_RATE_LIMITED"
      | "SKETCHFAB_UPSTREAM_UNAVAILABLE"
      | "SKETCHFAB_UPSTREAM_CHANGED",
    message: string,
    readonly retryable = false,
    readonly retryAfter?: string,
  ) {
    super(message);
    this.name = "SketchfabClientError";
  }
}

type FetchLike = typeof fetch;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown, max = 12_000): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function thumbnail(value: unknown): string | undefined {
  const images = record(value)?.images;
  if (!Array.isArray(images)) return;
  const normalized = images
    .map((image) => record(image))
    .filter((image): image is Record<string, unknown> => !!image)
    .map((image) => ({
      url: text(image.url, 2_048),
      width: number(image.width) ?? 0,
    }))
    .filter((image): image is { url: string; width: number } => !!image.url)
    .sort((a, b) => Math.abs(a.width - 512) - Math.abs(b.width - 512));
  return normalized[0]?.url;
}

function normalizeArchives(value: unknown): SketchfabArchive[] {
  const archives = record(value);
  if (!archives) return [];
  return Object.entries(archives).flatMap(([format, raw]) => {
    const item = record(raw);
    if (!item) return [];
    const sizeBytes = number(item.size);
    const textureCount = number(item.textureCount);
    const textureMaxResolution = number(item.textureMaxResolution);
    const faceCount = number(item.faceCount);
    const vertexCount = number(item.vertexCount);
    return [
      {
        format,
        ...(sizeBytes !== undefined ? { sizeBytes } : {}),
        ...(textureCount !== undefined ? { textureCount } : {}),
        ...(textureMaxResolution !== undefined ? { textureMaxResolution } : {}),
        ...(faceCount !== undefined ? { faceCount } : {}),
        ...(vertexCount !== undefined ? { vertexCount } : {}),
      },
    ];
  });
}

function normalizeModel(value: unknown): SketchfabModel {
  const item = record(value);
  const id = text(item?.uid, 100);
  const name = text(item?.name, 500);
  const viewerUrl = text(item?.viewerUrl, 2_048);
  if (!id || !name || !viewerUrl) {
    throw new SketchfabClientError(
      "SKETCHFAB_UPSTREAM_CHANGED",
      "Sketchfab returned invalid model metadata.",
    );
  }
  const user = record(item?.user);
  const license = record(item?.license);
  const username = text(user?.username, 200);
  const description = text(item?.description);
  const embedUrl = text(item?.embedUrl, 2_048);
  const thumb = thumbnail(item?.thumbnails);
  const licenseLabel = text(license?.label, 200);
  const licenseSlug = text(license?.slug, 100);
  const licenseUrl = text(license?.url, 2_048);
  const requirements = text(license?.requirements, 2_000);
  return {
    id,
    name,
    viewerUrl,
    tags: Array.isArray(item?.tags)
      ? item.tags
          .map((tag) => text(record(tag)?.name, 100))
          .filter((tag): tag is string => !!tag)
          .slice(0, 100)
      : [],
    categories: Array.isArray(item?.categories)
      ? item.categories
          .map((category) => text(record(category)?.name, 200) ?? text(record(category)?.slug, 200))
          .filter((category): category is string => !!category)
          .slice(0, 50)
      : [],
    downloadable: item?.isDownloadable === true,
    animated: (number(item?.animationCount) ?? 0) > 0,
    archives: normalizeArchives(item?.archives),
    ...(description ? { description } : {}),
    ...(embedUrl ? { embedUrl } : {}),
    ...(thumb ? { thumbnailUrl: thumb } : {}),
    ...(username
      ? {
          author: {
            username,
            ...(text(user?.uid, 100) ? { id: text(user?.uid, 100) as string } : {}),
            ...(text(user?.displayName, 200)
              ? { displayName: text(user?.displayName, 200) as string }
              : {}),
            ...(text(user?.profileUrl, 2_048)
              ? { profileUrl: text(user?.profileUrl, 2_048) as string }
              : {}),
          },
        }
      : {}),
    ...(licenseLabel
      ? {
          license: {
            label: licenseLabel,
            ...(licenseSlug ? { slug: licenseSlug } : {}),
            ...(licenseUrl ? { url: licenseUrl } : {}),
            ...(requirements ? { requirements } : {}),
          },
        }
      : {}),
    ...(typeof item?.isAgeRestricted === "boolean" ? { ageRestricted: item.isAgeRestricted } : {}),
    ...(number(item?.faceCount) !== undefined
      ? { faceCount: number(item?.faceCount) as number }
      : {}),
    ...(number(item?.vertexCount) !== undefined
      ? { vertexCount: number(item?.vertexCount) as number }
      : {}),
    ...(number(item?.viewCount) !== undefined
      ? { viewCount: number(item?.viewCount) as number }
      : {}),
    ...(number(item?.likeCount) !== undefined
      ? { likeCount: number(item?.likeCount) as number }
      : {}),
    ...(number(item?.downloadCount) !== undefined
      ? { downloadCount: number(item?.downloadCount) as number }
      : {}),
    ...(text(item?.publishedAt, 100)
      ? { publishedAt: text(item?.publishedAt, 100) as string }
      : {}),
    ...(text(item?.updatedAt, 100) ? { updatedAt: text(item?.updatedAt, 100) as string } : {}),
  };
}

export class SketchfabClient {
  private readonly requests = new MetadataRequests();
  private readonly token?: string;

  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    options: { token?: string | null } = {},
  ) {
    const token = options.token === undefined ? process.env.SKETCHFAB_API_TOKEN : options.token;
    if (token?.trim()) this.token = token.trim();
  }

  private async request(
    path: string,
    authenticated = false,
    context: MetadataContext = {},
  ): Promise<unknown> {
    if (authenticated && !this.token) {
      throw new SketchfabClientError(
        "SKETCHFAB_AUTH_REQUIRED",
        "Set SKETCHFAB_API_TOKEN to retrieve Sketchfab download URLs.",
      );
    }
    return this.requests.run(path, context.signal, async (callerSignal) => {
      const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(20_000)]);
      let response: Response;
      try {
        response = await this.fetchImpl(`${API_BASE}${path}`, {
          headers: {
            accept: "application/json",
            "user-agent": "threenative-asset-mcp/0.4.0",
            ...(this.token ? { authorization: `Token ${this.token}` } : {}),
          },
          signal,
          redirect: "error",
        });
      } catch {
        throw new SketchfabClientError(
          "SKETCHFAB_UPSTREAM_UNAVAILABLE",
          "Sketchfab could not be reached.",
          true,
        );
      }
      if (!response.ok) await response.body?.cancel();
      if (response.status === 401) {
        throw new SketchfabClientError(
          "SKETCHFAB_AUTH_REQUIRED",
          "Sketchfab authentication is required or the configured token is invalid.",
        );
      }
      if (response.status === 403) {
        throw new SketchfabClientError(
          "SKETCHFAB_ACCESS_DENIED",
          "Sketchfab denied access to this model.",
        );
      }
      if (response.status === 404) {
        throw new SketchfabClientError("SKETCHFAB_NOT_FOUND", "The Sketchfab model was not found.");
      }
      if (response.status === 429) {
        throw new SketchfabClientError(
          "SKETCHFAB_RATE_LIMITED",
          "Sketchfab rate-limited the request.",
          true,
          response.headers.get("retry-after")?.slice(0, 100),
        );
      }
      if (!response.ok) {
        throw new SketchfabClientError(
          "SKETCHFAB_UPSTREAM_UNAVAILABLE",
          `Sketchfab returned HTTP ${response.status}.`,
          response.status >= 500,
        );
      }
      try {
        return JSON.parse(await readMetadata(response, 16 * 1024 * 1024, signal)) as unknown;
      } catch {
        throw new SketchfabClientError(
          "SKETCHFAB_UPSTREAM_CHANGED",
          "Sketchfab returned invalid JSON.",
        );
      }
    });
  }

  async search(
    params: URLSearchParams,
    context: MetadataContext = {},
  ): Promise<SketchfabSearchResult> {
    const payload = record(await this.request(`/search?${params}`, false, context));
    if (!Array.isArray(payload?.results)) {
      throw new SketchfabClientError(
        "SKETCHFAB_UPSTREAM_CHANGED",
        "Sketchfab returned an invalid search response.",
      );
    }
    if (payload.results.length > 1000)
      throw new SketchfabClientError(
        "SKETCHFAB_UPSTREAM_CHANGED",
        "Sketchfab search exceeds its entry limit.",
      );
    const cursors = record(payload.cursors);
    const nextCursor = text(cursors?.next, 500);
    return {
      models: payload.results.map(normalizeModel),
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  async getModel(id: string, context: MetadataContext = {}): Promise<SketchfabModel> {
    return normalizeModel(await this.request(`/models/${encodeURIComponent(id)}`, false, context));
  }

  async getDownloads(id: string, context: MetadataContext = {}): Promise<SketchfabArchive[]> {
    const payload = record(
      await this.request(`/models/${encodeURIComponent(id)}/download`, true, context),
    );
    if (!payload) {
      throw new SketchfabClientError(
        "SKETCHFAB_UPSTREAM_CHANGED",
        "Sketchfab returned invalid download metadata.",
      );
    }
    return Object.entries(payload).flatMap(([format, raw]) => {
      const item = record(raw);
      const url = text(item?.url, 2_048);
      if (!url) return [];
      const expiresInSeconds = number(item?.expires);
      const sizeBytes = number(item?.size);
      return [
        {
          format,
          url,
          ...(expiresInSeconds !== undefined ? { expiresInSeconds } : {}),
          ...(sizeBytes !== undefined ? { sizeBytes } : {}),
        },
      ];
    });
  }

  async listCategories(
    context: MetadataContext = {},
  ): Promise<Array<{ name: string; slug: string }>> {
    const payload = record(await this.request("/categories", false, context));
    if (!Array.isArray(payload?.results)) {
      throw new SketchfabClientError(
        "SKETCHFAB_UPSTREAM_CHANGED",
        "Sketchfab returned an invalid category list.",
      );
    }
    return payload.results.flatMap((raw) => {
      const item = record(raw);
      const name = text(item?.name, 200);
      const slug = text(item?.slug, 200);
      return name && slug ? [{ name, slug }] : [];
    });
  }
}
