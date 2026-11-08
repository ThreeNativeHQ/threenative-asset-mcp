import { MetadataRequests, readMetadata, type MetadataContext } from "../discovery/metadata.js";

const API_BASE = "https://polyfork.dev/api/assets";
const USER_AGENT = "threenative-asset-mcp/0.15.0";
const TIMEOUT_MS = 20_000;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_TRIANGLES = 50_000_000;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,78}[a-z0-9]$/;

export const POLYFORK_CLASSES = [
  "prop",
  "building",
  "vehicle",
  "character",
  "animal",
  "ultra",
  "attachment",
  "terrain",
  "hand",
] as const;
export type PolyforkClass = (typeof POLYFORK_CLASSES)[number];

export interface PolyforkSize {
  x: number;
  y: number;
  z: number;
}

export interface PolyforkHd {
  plan: "pro";
  pageUrl: string;
  triangles?: number;
  previewGlbUrl?: string;
  filesNote?: string;
}

export interface PolyforkDownload {
  glb?: string;
  mjs?: string;
  auth: "none" | "required" | "unknown";
}

export interface PolyforkAsset {
  id: string;
  title: string;
  assetClass: PolyforkClass;
  triangles?: number;
  previewTriangles?: number;
  kit?: string;
  free: boolean;
  plan?: string;
  pageUrl: string;
  thumbnailUrl?: string;
  previewGlbUrl?: string;
  hasRig: boolean;
  hasSkeleton: boolean;
  hasIk: boolean;
  ikType?: "legs" | "arm";
  size?: PolyforkSize;
  originY?: number;
  massKg?: number;
  hd: PolyforkHd | null;
  download: PolyforkDownload;
}

export interface PolyforkClip {
  name: string;
  seconds?: number;
}

export interface PolyforkSkeleton {
  bones?: number;
  binding?: string;
  naming?: string;
}

export interface PolyforkExportFormat {
  format: string;
  url?: string;
  for?: string;
  available?: boolean;
  note?: string;
}

export interface PolyforkAccess {
  as: string;
  remixesLeftThisHour?: number;
  freeAccountNote?: string;
  proNote?: string;
}

export interface PolyforkDetail extends PolyforkAsset {
  description?: string;
  licenseText?: string;
  credit?: string;
  publishedAt?: string;
  materials?: number;
  drawCalls?: number;
  style?: string;
  clips: PolyforkClip[];
  skeleton?: PolyforkSkeleton;
  renders: string[];
  exportFormats: PolyforkExportFormat[];
  access?: PolyforkAccess;
}

export interface PolyforkSearchQuery {
  query?: string;
  assetClass?: PolyforkClass;
  kit?: string;
  free?: boolean;
  minTriangles?: number;
  maxTriangles?: number;
  sort?: "relevance" | "latest" | "tris";
  page?: number;
  perPage?: number;
}

export interface PolyforkSearchResult {
  items: PolyforkAsset[];
  total: number;
  page: number;
  perPage: number;
  coverage?: string;
  strongMatches?: number;
}

export type PolyforkErrorCode =
  | "POLYFORK_INVALID_INPUT"
  | "POLYFORK_NOT_FOUND"
  | "POLYFORK_RATE_LIMITED"
  | "POLYFORK_UPSTREAM_UNAVAILABLE"
  | "POLYFORK_UPSTREAM_CHANGED";

export class PolyforkClientError extends Error {
  constructor(
    readonly code: PolyforkErrorCode,
    message: string,
    readonly retryable = false,
    readonly retryAfter?: string,
  ) {
    super(message);
    this.name = "PolyforkClientError";
  }
}

type FetchLike = typeof fetch;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown, max = 2_048): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
}

function integer(value: unknown, min: number, max: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : undefined;
}

function coordinate(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10_000
    ? value
    : undefined;
}

function invalid(message: string): never {
  throw new PolyforkClientError("POLYFORK_INVALID_INPUT", message);
}

function changed(message = "The Polyfork catalogue returned an unexpected response."): never {
  throw new PolyforkClientError("POLYFORK_UPSTREAM_CHANGED", message);
}

export function parsePolyforkIdOrUrl(value: string): string {
  const trimmed = value.trim();
  if (ID_PATTERN.test(trimmed)) return trimmed;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return invalid("Use a Polyfork asset id or its canonical https://polyfork.dev/asset/{id} URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "polyfork.dev" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    url.search
  )
    return invalid("Use a Polyfork asset id or its canonical https://polyfork.dev/asset/{id} URL.");
  const match = /^\/asset\/([^/]+)$/.exec(url.pathname);
  if (!match?.[1] || !ID_PATTERN.test(match[1]))
    return invalid("Use a Polyfork asset id or its canonical https://polyfork.dev/asset/{id} URL.");
  return match[1];
}

function polyforkUrl(value: unknown, pathname: RegExp): string | undefined {
  const raw = text(value, 2_048);
  if (!raw) return;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "polyfork.dev" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !pathname.test(url.pathname)
  )
    return;
  return url.toString();
}

function escapeId(id: string): string {
  return id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function cdnPattern(id: string, suffix: string): RegExp {
  return new RegExp(`^/cdn/${escapeId(id)}${suffix}$`, "u");
}

function expectedUrls(id: string) {
  return {
    page: `https://polyfork.dev/asset/${id}`,
    glb: `https://polyfork.dev/cdn/${id}.glb`,
    mjs: `https://polyfork.dev/cdn/${id}.mjs`,
    pagePattern: new RegExp(`^/asset/${escapeId(id)}$`, "u"),
    thumbnailPattern: new RegExp(`^/files/${escapeId(id)}/renders/[a-z0-9-]+\\.png$`, "iu"),
  };
}

function requirePageUrl(value: unknown, id: string): string {
  const expected = expectedUrls(id).page;
  const url = polyforkUrl(value, expectedUrls(id).pagePattern);
  if (url !== expected) return changed("A Polyfork asset page URL left its canonical form.");
  return url;
}

function normalizeHd(value: unknown, id: string): PolyforkHd | null {
  if (value === null || value === undefined) return null;
  const hd = record(value);
  if (!hd) return changed("Polyfork returned an invalid HD edition.");
  const plan = text(hd.plan, 20);
  const pageUrl = polyforkUrl(hd.page, expectedUrls(id).pagePattern);
  if (plan !== "pro" || !pageUrl) return changed("Polyfork returned an invalid HD edition.");
  const triangles = integer(hd.triangles, 0, MAX_TRIANGLES);
  const previewGlbUrl = polyforkUrl(hd.preview_glb, cdnPattern(id, "-hd-preview\\.glb"));
  const filesNote = text(hd.files, 500);
  return {
    plan: "pro",
    pageUrl,
    ...(triangles !== undefined ? { triangles } : {}),
    ...(previewGlbUrl ? { previewGlbUrl } : {}),
    ...(filesNote ? { filesNote } : {}),
  };
}

function normalizeDownload(value: unknown, id: string): PolyforkDownload {
  const download = record(value);
  if (!download) return changed("Polyfork returned no download choices for an asset.");
  const glb = polyforkUrl(download.glb, cdnPattern(id, "\\.glb"));
  const mjs = polyforkUrl(download.mjs, cdnPattern(id, "\\.mjs"));
  const urls = expectedUrls(id);
  const auth = text(download.auth, 20);
  return {
    ...(glb === urls.glb ? { glb } : {}),
    ...(mjs === urls.mjs ? { mjs } : {}),
    auth: auth === "none" ? "none" : auth ? "required" : "unknown",
  };
}

function normalizeAsset(value: unknown, requestedId?: string): PolyforkAsset {
  const row = record(value);
  if (!row) return changed();
  const id = text(row.id, 80);
  if (!id || !ID_PATTERN.test(id) || (requestedId && id !== requestedId)) return changed();
  const title = text(row.title, 500);
  if (!title) return changed();
  const assetClass = row.class;
  if (!POLYFORK_CLASSES.includes(assetClass as PolyforkClass)) return changed();
  if (typeof row.free !== "boolean" || typeof row.has_rig !== "boolean") return changed();
  const triangles = integer(row.triangles, 0, MAX_TRIANGLES);
  const previewTriangles = integer(row.preview_triangles, 0, MAX_TRIANGLES);
  const kit = text(row.kit, 80);
  if (kit !== undefined && !ID_PATTERN.test(kit)) return changed();
  const plan = text(row.plan, 40);
  const pageUrl = requirePageUrl(row.page, id);
  const thumbnailUrl = polyforkUrl(row.thumbnail, expectedUrls(id).thumbnailPattern);
  const previewGlbUrl = polyforkUrl(row.preview_glb, cdnPattern(id, "-preview\\.glb"));
  const sizeRow = record(row.size_m);
  const x = coordinate(sizeRow?.x);
  const y = coordinate(sizeRow?.y);
  const z = coordinate(sizeRow?.z);
  const size =
    sizeRow && x !== undefined && y !== undefined && z !== undefined ? { x, y, z } : undefined;
  const originY = typeof row.origin_y === "number" && Number.isFinite(row.origin_y) ? row.origin_y : undefined;
  const massKg = coordinate(row.mass_kg);
  const ikType = row.ik_type === "legs" || row.ik_type === "arm" ? row.ik_type : undefined;
  return {
    id,
    title,
    assetClass: assetClass as PolyforkClass,
    ...(triangles !== undefined ? { triangles } : {}),
    ...(previewTriangles !== undefined ? { previewTriangles } : {}),
    ...(kit ? { kit } : {}),
    free: row.free,
    ...(plan ? { plan } : {}),
    pageUrl,
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    ...(previewGlbUrl ? { previewGlbUrl } : {}),
    hasRig: row.has_rig === true,
    hasSkeleton: row.has_skeleton === true,
    hasIk: row.has_ik === true,
    ...(ikType ? { ikType } : {}),
    ...(size ? { size } : {}),
    ...(originY !== undefined ? { originY } : {}),
    ...(massKg !== undefined ? { massKg } : {}),
    hd: normalizeHd(row.hd, id),
    download: normalizeDownload(row.download, id),
  };
}

function normalizeClips(value: unknown): PolyforkClip[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).flatMap((entry) => {
    const clip = record(entry);
    const name = text(clip?.name, 200);
    if (!name) return [];
    const seconds =
      typeof clip?.seconds === "number" && Number.isFinite(clip.seconds) && clip.seconds >= 0
        ? clip.seconds
        : undefined;
    return [{ name, ...(seconds !== undefined ? { seconds } : {}) }];
  });
}

function normalizeSkeleton(value: unknown): PolyforkSkeleton | undefined {
  const skeleton = record(value);
  if (!skeleton) return;
  const bones = integer(skeleton.bones, 0, 10_000);
  const binding = text(skeleton.binding, 500);
  const naming = text(skeleton.naming, 1_000);
  if (bones === undefined && !binding && !naming) return;
  return {
    ...(bones !== undefined ? { bones } : {}),
    ...(binding ? { binding } : {}),
    ...(naming ? { naming } : {}),
  };
}

function normalizeExportFormats(value: unknown): PolyforkExportFormat[] {
  const formats = record(value);
  if (!formats) return [];
  return Object.entries(formats)
    .slice(0, 8)
    .flatMap(([format, entry]) => {
      const item = record(entry);
      if (!item) return [];
      const url = polyforkUrl(item.url, /^\/dl\/[^/]+$/u);
      const target = text(item.for, 200);
      const note = text(item.also_fetch_note, 300);
      const available = typeof item.available === "boolean" ? item.available : undefined;
      return [
        {
          format: format.slice(0, 20),
          ...(url ? { url } : {}),
          ...(target ? { for: target } : {}),
          ...(available !== undefined ? { available } : {}),
          ...(note ? { note } : {}),
        },
      ];
    });
}

function normalizeAccess(value: unknown): PolyforkAccess | undefined {
  const access = record(value);
  if (!access) return;
  const as = text(access.as, 40);
  if (!as) return;
  const free = record(access.a_free_account_adds);
  const pro = record(access.pro_adds);
  const remixesLeftThisHour = integer(access.remix_bakes_left_this_hour, 0, 1_000_000);
  const freeAccountNote = text(free?.how, 500);
  const proNote = text(pro?.url, 500);
  return {
    as,
    ...(remixesLeftThisHour !== undefined ? { remixesLeftThisHour } : {}),
    ...(freeAccountNote ? { freeAccountNote } : {}),
    ...(proNote ? { proNote } : {}),
  };
}

export class PolyforkClient {
  private readonly requests = new MetadataRequests();

  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async search(
    query: PolyforkSearchQuery = {},
    context: MetadataContext = {},
  ): Promise<PolyforkSearchResult> {
    const page = query.page ?? 1;
    if (!Number.isSafeInteger(page) || page < 1 || page > 10_000)
      return invalid("Polyfork pagination must be a positive whole page number.");
    if (
      query.perPage !== undefined &&
      (!Number.isSafeInteger(query.perPage) || query.perPage < 1)
    )
      return invalid("Polyfork page size must be a positive whole number.");
    const perPage = Math.min(100, query.perPage ?? 24);
    const term = query.query?.trim();
    if (term !== undefined && term.length > 200)
      return invalid("Polyfork search text exceeds its length limit.");
    if (query.assetClass !== undefined && !POLYFORK_CLASSES.includes(query.assetClass))
      return invalid("Unknown Polyfork model class.");
    if (
      query.sort !== undefined &&
      !["relevance", "latest", "tris"].includes(query.sort)
    )
      return invalid("Unknown Polyfork sort order.");
    if (query.kit !== undefined && !ID_PATTERN.test(query.kit))
      return invalid("Invalid Polyfork kit id.");
    for (const value of [query.minTriangles, query.maxTriangles])
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0 || value > MAX_TRIANGLES))
        return invalid("Invalid Polyfork triangle bound.");
    if (
      query.minTriangles !== undefined &&
      query.maxTriangles !== undefined &&
      query.minTriangles > query.maxTriangles
    )
      return invalid("The Polyfork triangle range is inverted.");

    const params = new URLSearchParams({ page: String(page), per_page: String(perPage) });
    if (term) params.set("q", term);
    if (query.assetClass) params.set("class", query.assetClass);
    if (query.free !== undefined) params.set("free", query.free ? "1" : "0");
    if (query.kit) params.set("kit", query.kit);
    if (query.minTriangles !== undefined) params.set("min_triangles", String(query.minTriangles));
    if (query.maxTriangles !== undefined) params.set("max_triangles", String(query.maxTriangles));
    if (query.sort && query.sort !== "relevance") params.set("sort", query.sort);

    const payload = record(await this.request("", params, context));
    const assets = payload?.assets;
    const total = integer(payload?.total, 0, 10_000_000);
    const echoedPage = integer(payload?.page, 1, 10_000);
    const echoedPerPage = integer(payload?.per_page, 1, 100);
    if (
      !Array.isArray(assets) ||
      assets.length > perPage ||
      total === undefined ||
      echoedPage !== page ||
      echoedPerPage !== perPage
    )
      return changed();
    const coverage = text(payload?.coverage, 40);
    const strongMatches = integer(payload?.strong_matches, 0, 10_000_000);
    return {
      items: assets.map((asset) => normalizeAsset(asset)),
      total,
      page: echoedPage,
      perPage: echoedPerPage,
      ...(coverage ? { coverage } : {}),
      ...(strongMatches !== undefined ? { strongMatches } : {}),
    };
  }

  async getAsset(idOrUrl: string, context: MetadataContext = {}): Promise<PolyforkDetail> {
    const id = parsePolyforkIdOrUrl(idOrUrl);
    const payload = record(await this.request(`/${id}`, new URLSearchParams(), context));
    if (!payload) return changed();
    const asset = normalizeAsset(payload, id);
    const description = text(payload.description, 12_000);
    const licenseText = text(payload.license, 2_000);
    const credit = text(payload.credit, 1_000);
    const publishedAt = text(payload.published_at, 100);
    const materials = integer(payload.materials, 0, 10_000);
    const drawCalls = integer(payload.draw_calls, 0, 1_000_000);
    const style = text(payload.style, 500);
    const skeleton = normalizeSkeleton(payload.skeleton);
    const renders = Array.isArray(payload.renders)
      ? payload.renders
          .slice(0, 40)
          .map((render) => polyforkUrl(render, expectedUrls(id).thumbnailPattern))
          .filter((render): render is string => render !== undefined)
      : [];
    const access = normalizeAccess(payload.access);
    return {
      ...asset,
      ...(description ? { description } : {}),
      ...(licenseText ? { licenseText } : {}),
      ...(credit ? { credit } : {}),
      ...(publishedAt ? { publishedAt } : {}),
      ...(materials !== undefined ? { materials } : {}),
      ...(drawCalls !== undefined ? { drawCalls } : {}),
      ...(style ? { style } : {}),
      clips: normalizeClips(payload.clips),
      ...(skeleton ? { skeleton } : {}),
      renders,
      exportFormats: normalizeExportFormats(payload.export_formats),
      ...(access ? { access } : {}),
    };
  }

  private async request(
    path: string,
    params: URLSearchParams,
    context: MetadataContext,
  ): Promise<unknown> {
    const target = params.size ? `${API_BASE}${path}?${params}` : `${API_BASE}${path}`;
    return this.requests.run(target, context.signal, async (callerSignal) => {
      const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(TIMEOUT_MS)]);
      let response: Response;
      try {
        response = await this.fetchImpl(target, {
          headers: { accept: "application/json", "user-agent": USER_AGENT },
          signal,
          redirect: "error",
        });
      } catch {
        signal.throwIfAborted();
        throw new PolyforkClientError(
          "POLYFORK_UPSTREAM_UNAVAILABLE",
          "The Polyfork catalogue could not be reached.",
          true,
        );
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 404)
          throw new PolyforkClientError("POLYFORK_NOT_FOUND", "The Polyfork asset was not found.");
        if (response.status === 429)
          throw new PolyforkClientError(
            "POLYFORK_RATE_LIMITED",
            "The Polyfork catalogue rate-limited the request.",
            true,
            response.headers.get("retry-after")?.slice(0, 100),
          );
        if (response.status === 400)
          throw new PolyforkClientError(
            "POLYFORK_INVALID_INPUT",
            "The Polyfork catalogue rejected the query.",
          );
        throw new PolyforkClientError(
          "POLYFORK_UPSTREAM_UNAVAILABLE",
          `The Polyfork catalogue returned HTTP ${response.status}.`,
          response.status >= 500,
        );
      }
      try {
        return JSON.parse(await readMetadata(response, MAX_METADATA_BYTES, signal)) as unknown;
      } catch {
        signal.throwIfAborted();
        throw new PolyforkClientError(
          "POLYFORK_UPSTREAM_CHANGED",
          "The Polyfork catalogue returned an unreadable response.",
        );
      }
    });
  }
}
