import { MetadataRequests, readMetadata, type MetadataContext } from "../discovery/metadata.js";

const API_BASE = "https://ambientcg.com/api/v3";
const TIMEOUT_MS = 20_000;

export const AMBIENTCG_TYPES = [
  "material",
  "hdri",
  "substance",
  "decal",
  "atlas",
  "3d-model",
  "plain-image",
  "brush",
  "terrain",
  "hdri-element",
] as const;
export type AmbientCgAssetType = (typeof AMBIENTCG_TYPES)[number];

export interface AmbientCgDownload {
  attributes: string;
  extension: string;
  url: string;
  sizeBytes: number;
}

export interface AmbientCgAsset {
  id: string;
  type: AmbientCgAssetType;
  title: string;
  description?: string;
  url: string;
  tags: string[];
  releaseDate?: string;
  technique?: string;
  dimensions?: { width: number; height: number; depth: number };
  downloadCount?: number;
  thumbnailUrl?: string;
  maps: string[];
  downloads: AmbientCgDownload[];
}

export interface AmbientCgSearchResult {
  assets: AmbientCgAsset[];
  total: number;
  nextOffset?: number;
}

export interface AmbientCgCategory {
  id: string;
  title: string;
  type: AmbientCgAssetType;
  assetCount: number;
}

export class AmbientCgClientError extends Error {
  constructor(
    readonly code:
      | "AMBIENTCG_INVALID_INPUT"
      | "AMBIENTCG_NOT_FOUND"
      | "AMBIENTCG_RATE_LIMITED"
      | "AMBIENTCG_UPSTREAM_UNAVAILABLE"
      | "AMBIENTCG_UPSTREAM_CHANGED",
    message: string,
    readonly retryable = false,
    readonly retryAfter?: string,
  ) {
    super(message);
    this.name = "AmbientCgClientError";
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

function isType(value: unknown): value is AmbientCgAssetType {
  return typeof value === "string" && (AMBIENTCG_TYPES as readonly string[]).includes(value);
}

function normalizeDownload(value: unknown): AmbientCgDownload | undefined {
  const item = record(value);
  const attributes = text(item?.attributes, 100);
  const extension = text(item?.extension, 20);
  const url = text(item?.url, 2_048);
  const sizeBytes = number(item?.size);
  if (
    !attributes ||
    !extension ||
    !url ||
    sizeBytes === undefined ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 0
  ) {
    throw new AmbientCgClientError(
      "AMBIENTCG_UPSTREAM_CHANGED",
      "ambientCG returned invalid download metadata.",
    );
  }
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "ambientcg.com" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.hash
    ) {
      throw new Error("Unsafe provider file URL.");
    }
  } catch {
    throw new AmbientCgClientError(
      "AMBIENTCG_UPSTREAM_CHANGED",
      "ambientCG returned an unsafe download URL.",
    );
  }
  return { attributes, extension, url, sizeBytes };
}

function normalizeAsset(value: unknown): AmbientCgAsset {
  const item = record(value);
  const id = text(item?.id, 200);
  const type = item?.type;
  const title = text(item?.title, 500);
  const url = text(item?.url, 2_048);
  if (!id || !isType(type) || !title || !url) {
    throw new AmbientCgClientError(
      "AMBIENTCG_UPSTREAM_CHANGED",
      "ambientCG returned invalid asset metadata.",
    );
  }
  const descriptions = [text(item?.longDescription), text(item?.shortDescription)];
  const description = descriptions.find((entry) => entry !== undefined);
  const statistics = record(item?.downloadStatistics);
  const dimensions = record(item?.dimensions);
  const thumbnails = record(item?.thumbnails);
  const thumbnailUrl =
    text(thumbnails?.["512-WEBP"], 2_048) ??
    text(thumbnails?.["512-PNG"], 2_048) ??
    text(thumbnails?.["256-WEBP"], 2_048);
  if (Array.isArray(item?.downloads) && item.downloads.length > 500)
    throw new AmbientCgClientError(
      "AMBIENTCG_UPSTREAM_CHANGED",
      "ambientCG download variants exceed the entry limit.",
    );
  const downloads = Array.isArray(item?.downloads)
    ? item.downloads
        .map(normalizeDownload)
        .filter((entry): entry is AmbientCgDownload => entry !== undefined)
        .slice(0, 500)
    : [];
  return {
    id,
    type,
    title,
    url,
    tags: Array.isArray(item?.tags)
      ? item.tags
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.slice(0, 100))
          .slice(0, 100)
      : [],
    maps: Array.isArray(item?.maps)
      ? item.maps
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.slice(0, 100))
          .slice(0, 100)
      : [],
    downloads,
    ...(description ? { description } : {}),
    ...(text(item?.releaseDate, 20) ? { releaseDate: text(item?.releaseDate, 20) as string } : {}),
    ...(text(item?.technique, 100) ? { technique: text(item?.technique, 100) as string } : {}),
    ...(number(statistics?.total) !== undefined
      ? { downloadCount: number(statistics?.total) as number }
      : {}),
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    ...(dimensions &&
    number(dimensions.width) !== undefined &&
    number(dimensions.height) !== undefined &&
    number(dimensions.depth) !== undefined
      ? {
          dimensions: {
            width: number(dimensions.width) as number,
            height: number(dimensions.height) as number,
            depth: number(dimensions.depth) as number,
          },
        }
      : {}),
  };
}

export class AmbientCgClient {
  private readonly requests = new MetadataRequests();
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  private async request(path: string, context: MetadataContext = {}): Promise<unknown> {
    return this.requests.run(path, context.signal, async (callerSignal) => {
      const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(TIMEOUT_MS)]);
      let response: Response;
      try {
        response = await this.fetchImpl(`${API_BASE}${path}`, {
          headers: {
            accept: "application/json",
            "user-agent": "threenative-asset-mcp/0.4.0",
          },
          signal,
          redirect: "error",
        });
      } catch {
        throw new AmbientCgClientError(
          "AMBIENTCG_UPSTREAM_UNAVAILABLE",
          "ambientCG could not be reached.",
          true,
        );
      }
      if (!response.ok) await response.body?.cancel();
      if (response.status === 429) {
        throw new AmbientCgClientError(
          "AMBIENTCG_RATE_LIMITED",
          "ambientCG rate-limited the request.",
          true,
          response.headers.get("retry-after")?.slice(0, 100),
        );
      }
      if (!response.ok) {
        throw new AmbientCgClientError(
          "AMBIENTCG_UPSTREAM_UNAVAILABLE",
          `ambientCG returned HTTP ${response.status}.`,
          response.status >= 500,
        );
      }
      try {
        return JSON.parse(await readMetadata(response, 16 * 1024 * 1024, signal)) as unknown;
      } catch {
        throw new AmbientCgClientError(
          "AMBIENTCG_UPSTREAM_CHANGED",
          "ambientCG returned invalid JSON.",
        );
      }
    });
  }

  async search(
    input: {
      query?: string;
      type?: AmbientCgAssetType;
      sort: "popular" | "latest" | "downloads" | "oldest" | "random" | "alphabet";
      limit: number;
      offset: number;
      includeDownloads?: boolean;
    },
    context: MetadataContext = {},
  ): Promise<AmbientCgSearchResult> {
    const params = new URLSearchParams({
      sort: input.sort,
      limit: String(input.limit),
      offset: String(input.offset),
      include: [
        "type",
        "releaseDate",
        "shortDescription",
        "title",
        "url",
        "tags",
        "dimensions",
        "downloadStatistics",
        "technique",
        "maps",
        "thumbnails",
        ...(input.includeDownloads ? ["downloads"] : []),
      ].join(","),
    });
    if (input.query) params.set("q", input.query);
    if (input.type) params.set("type", input.type);
    const payload = record(await this.request(`/assets?${params}`, context));
    if (Array.isArray(payload?.assets) && payload.assets.length > 1000)
      throw new AmbientCgClientError(
        "AMBIENTCG_UPSTREAM_CHANGED",
        "ambientCG asset list exceeds its entry limit.",
      );
    const assets = Array.isArray(payload?.assets) ? payload.assets.map(normalizeAsset) : undefined;
    const total = number(payload?.totalResults);
    if (!assets || total === undefined) {
      throw new AmbientCgClientError(
        "AMBIENTCG_UPSTREAM_CHANGED",
        "ambientCG returned an invalid search result.",
      );
    }
    return {
      assets,
      total,
      ...(input.offset + assets.length < total ? { nextOffset: input.offset + assets.length } : {}),
    };
  }

  async getAsset(id: string, context: MetadataContext = {}): Promise<AmbientCgAsset> {
    const params = new URLSearchParams({
      id,
      limit: "1",
      include:
        "type,releaseDate,shortDescription,longDescription,title,url,tags,dimensions,downloadStatistics,downloads,technique,maps,thumbnails",
    });
    const payload = record(await this.request(`/assets?${params}`, context));
    const first = Array.isArray(payload?.assets) ? payload.assets[0] : undefined;
    if (!first) {
      throw new AmbientCgClientError("AMBIENTCG_NOT_FOUND", "The ambientCG asset was not found.");
    }
    return normalizeAsset(first);
  }

  async listCategories(context: MetadataContext = {}): Promise<AmbientCgCategory[]> {
    const payload = await this.request("/categories", context);
    if (!Array.isArray(payload)) {
      throw new AmbientCgClientError(
        "AMBIENTCG_UPSTREAM_CHANGED",
        "ambientCG returned an invalid category list.",
      );
    }
    return payload.flatMap((value) => {
      const item = record(value);
      const id = text(item?.id, 200);
      const title = text(item?.title, 200);
      const type = item?.type;
      const assetCount = number(item?.numberOfAssets);
      return id && title && isType(type) && assetCount !== undefined
        ? [{ id, title, type, assetCount }]
        : [];
    });
  }
}
