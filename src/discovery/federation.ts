import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DirectAssetDownloader } from "../download/direct-asset-downloader.js";
import { ASSET_SOURCES } from "../tools/source-directory.js";
import { acquire, detailIdentity, validateFiles } from "./acquisition.js";
import {
  AssetSchema,
  AssetTypeSchema,
  assetId,
  type Asset,
  type AssetAdapter,
  type AssetDetail,
  type Selection,
} from "./types.js";

export const AssetSearchInputSchema = z.strictObject({
  query: z.string().trim().min(1).max(200),
  types: z
    .array(AssetTypeSchema)
    .min(1)
    .max(4)
    .default(["3d-model", "texture", "hdri", "animation"]),
  providers: z
    .array(
      z
        .string()
        .regex(/^[a-z0-9-]+$/u)
        .max(100),
    )
    .min(1)
    .max(20)
    .optional(),
  freeOnly: z.boolean().default(true),
  downloadableOnly: z.boolean().default(false),
  commercialUse: z.boolean().default(false),
  attributionRequired: z.boolean().optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
export const AssetGetInputSchema = z.strictObject({
  assetId: z.string().min(3).max(800),
  format: z
    .string()
    .regex(/^[a-z0-9_-]+$/iu)
    .max(30)
    .optional(),
  resolution: z
    .string()
    .regex(/^\d+k$/iu)
    .max(10)
    .optional(),
  mapRoles: z
    .array(
      z
        .string()
        .regex(/^[a-z0-9_-]+$/iu)
        .max(40),
    )
    .min(1)
    .max(16)
    .optional(),
});
export const AssetDownloadInputSchema = z.strictObject({
  planToken: z.string().min(1).max(100),
  acceptLicense: z.literal(true),
  maxBytes: z.number().int().positive().optional(),
});

export type ProviderReport = {
  provider: string;
  sourceUrl: string;
  status: "ok" | "timeout" | "error" | "rate-limited" | "auth-required" | "manual" | "skipped";
  reason: string;
  truncated: boolean;
  retryAfter?: string;
  continuation?: { tool: string; arguments: Record<string, unknown> };
};
export class FederationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly reports?: ProviderReport[],
  ) {
    super(message);
  }
}
type Plan = {
  detail: AssetDetail;
  selection: Selection;
  adapter: AssetAdapter;
  expiresAt: number;
  identity: string;
};
export type FederationOptions = {
  concurrency?: number;
  providerTimeoutMs?: number;
  searchTimeoutMs?: number;
  planTtlMs?: number;
  toolVersion: string;
};

function bounded(
  value: number | undefined,
  environment: string | undefined,
  fallback: number,
  max: number,
): number {
  const parsed = value ?? (environment ? Number(environment) : fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max)
    throw new Error("Invalid federation resource limit.");
  return parsed;
}

export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}

function publicUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.port) throw new Error("Invalid public provider URL.");
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}
function publicAsset(value: Asset): Asset {
  const asset = AssetSchema.parse(value);
  return {
    ...asset,
    sourceUrl: publicUrl(asset.sourceUrl),
    license: {
      ...asset.license,
      ...(asset.license.url ? { url: publicUrl(asset.license.url) } : {}),
    },
    ...(asset.thumbnailUrl ? { thumbnailUrl: publicUrl(asset.thumbnailUrl) } : {}),
  };
}

export class AssetFederation {
  private readonly adapters: Map<string, AssetAdapter>;
  private readonly plans = new Map<string, Plan>();
  private readonly acquisitions = new Map<string, Promise<unknown>>();
  private readonly concurrency: number;
  private readonly providerTimeoutMs: number;
  private readonly searchTimeoutMs: number;
  private readonly planTtlMs: number;
  constructor(
    adapters: AssetAdapter[],
    private readonly downloader: DirectAssetDownloader,
    private readonly options: FederationOptions,
  ) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
    if (this.adapters.size !== adapters.length) throw new Error("Duplicate asset adapter.");
    this.concurrency = bounded(options.concurrency, process.env.ASSET_SEARCH_CONCURRENCY, 4, 4);
    this.providerTimeoutMs = bounded(
      options.providerTimeoutMs,
      process.env.ASSET_PROVIDER_TIMEOUT_MS,
      8000,
      30000,
    );
    this.searchTimeoutMs = bounded(
      options.searchTimeoutMs,
      process.env.ASSET_SEARCH_TIMEOUT_MS,
      10000,
      60000,
    );
    this.planTtlMs = bounded(options.planTtlMs, process.env.ASSET_PLAN_TTL_MS, 300000, 900000);
  }

  async search(rawInput: z.input<typeof AssetSearchInputSchema>, callerSignal?: AbortSignal) {
    const input = AssetSearchInputSchema.parse(rawInput);
    const signal = AbortSignal.any([
      AbortSignal.timeout(this.searchTimeoutMs),
      ...(callerSignal ? [callerSignal] : []),
    ]);
    signal.throwIfAborted();
    const selected = [...new Set(input.providers ?? [...this.adapters.keys()])].sort();
    for (const provider of selected)
      if (!ASSET_SOURCES.some((source) => source.id === provider) && !this.adapters.has(provider))
        throw new FederationError("ASSET_INVALID_PROVIDER", "Unknown provider: " + provider);
    const reports: ProviderReport[] = [];
    const found = new Map<string, Asset>();
    let next = 0;
    const worker = async () => {
      while (next < selected.length) {
        const provider = selected[next++]!;
        const source = ASSET_SOURCES.find((item) => item.id === provider);
        const base = {
          provider,
          sourceUrl: source?.browseUrls[0] ?? "https://polyhaven.com/",
          truncated: false,
        };
        const adapter = this.adapters.get(provider);
        if (!adapter) {
          reports.push({
            ...base,
            status: "manual",
            reason:
              "Use the existing specialized provider tools. Generic search will not start authentication or a browser.",
            ...(source?.searchTool
              ? { continuation: { tool: source.searchTool, arguments: { query: input.query } } }
              : {}),
          });
          continue;
        }
        if (signal.aborted) {
          reports.push({
            ...base,
            status: "timeout",
            reason: "The aggregate deadline expired before this provider started.",
          });
          continue;
        }
        const providerSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(this.providerTimeoutMs),
        ]);
        try {
          const result = await abortable(
            adapter.search(input.query, input.types, Math.min(50, input.limit * 2), providerSignal),
            providerSignal,
          );
          if (result.items.length > 100) throw new Error("Provider returned too many candidates.");
          const accepted: Asset[] = [];
          for (const candidate of result.items) {
            const item = publicAsset(candidate);
            if (item.provider !== provider || item.assetId !== assetId(provider, item.nativeId))
              throw new Error("Invalid provider identity.");
            if (
              !input.types.includes(item.type) ||
              (input.freeOnly && item.free !== "yes") ||
              (input.downloadableOnly && !item.canDownloadNow) ||
              (input.commercialUse && item.license.commercialUse !== "yes") ||
              (input.attributionRequired !== undefined &&
                item.license.attributionRequired !== (input.attributionRequired ? "yes" : "no"))
            )
              continue;
            accepted.push(item);
          }
          for (const item of accepted) if (!found.has(item.assetId)) found.set(item.assetId, item);
          reports.push({
            ...base,
            status: "ok",
            reason: "Bounded provider page; provider-local order retained.",
            truncated: result.truncated,
            ...(result.continuation ? { continuation: result.continuation } : {}),
          });
        } catch (error) {
          const code = (error as { code?: unknown })?.code;
          const retry = (error as { retryAfter?: unknown })?.retryAfter;
          const status = providerSignal.aborted
            ? "timeout"
            : typeof code === "string" && /RATE_LIMITED/u.test(code)
              ? "rate-limited"
              : typeof code === "string" && /AUTH_REQUIRED/u.test(code)
                ? "auth-required"
                : "error";
          // Provider messages and signed URLs are untrusted; only bounded codes/Retry-After leave this boundary.
          reports.push({
            ...base,
            status,
            reason:
              status === "timeout"
                ? "Provider request exceeded its deadline."
                : "Provider request failed; retry the existing specialized tool.",
            ...(typeof retry === "string" && /^(?:\d{1,8}|[A-Za-z0-9 :,+-]{1,100})$/u.test(retry)
              ? { retryAfter: retry }
              : {}),
          });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, selected.length) }, worker));
    callerSignal?.throwIfAborted();
    reports.sort((a, b) => a.provider.localeCompare(b.provider));
    if (!reports.some((report) => report.status === "ok"))
      throw new FederationError(
        "ASSET_ALL_PROVIDERS_FAILED",
        "All selected providers failed or require a specialized action.",
        reports,
      );
    const words = input.query.toLowerCase().split(/\s+/u);
    const score = (item: Asset) => {
      const title = item.title.toLowerCase();
      return (
        (title === input.query.toLowerCase() ? 40 : 0) +
        words.filter((word) => title.includes(word)).length * 5 +
        (item.canDownloadNow ? 2 : 0) -
        Math.min(item.providerRank, 100) / 100
      );
    };
    const results = [...found.values()]
      .sort(
        (a, b) =>
          score(b) - score(a) ||
          a.provider.localeCompare(b.provider) ||
          a.nativeId.localeCompare(b.nativeId),
      )
      .slice(0, input.limit)
      .map((item) => ({
        ...item,
        rankingFactors: [
          "Lexical title relevance",
          "Provider-local order " + item.providerRank,
          ...(item.canDownloadNow ? ["Current guarded acquisition capability"] : []),
        ],
      }));
    return {
      results,
      providers: reports,
      partial: reports.some((report) => report.status !== "ok"),
      searchedAt: new Date().toISOString(),
      notice: "A bounded search page, not a catalog census or global pagination cursor.",
    };
  }

  async get(rawInput: z.input<typeof AssetGetInputSchema>, callerSignal?: AbortSignal) {
    const input = AssetGetInputSchema.parse(rawInput);
    const colon = input.assetId.indexOf(":");
    const provider = input.assetId.slice(0, colon);
    let nativeId: string;
    try {
      nativeId = decodeURIComponent(input.assetId.slice(colon + 1));
    } catch {
      throw new FederationError("ASSET_INVALID_ID", "Invalid asset identity.");
    }
    const adapter = this.adapters.get(provider);
    if (
      !adapter ||
      !nativeId ||
      nativeId.length > 200 ||
      assetId(provider, nativeId) !== input.assetId
    )
      throw new FederationError("ASSET_INVALID_ID", "Invalid or unsupported asset identity.");
    const selection: Selection = {
      ...(input.format ? { format: input.format.toLowerCase() } : {}),
      ...(input.resolution ? { resolution: input.resolution.toLowerCase() } : {}),
      ...(input.mapRoles ? { mapRoles: input.mapRoles } : {}),
    };
    const signal = AbortSignal.any([
      AbortSignal.timeout(this.searchTimeoutMs),
      ...(callerSignal ? [callerSignal] : []),
    ]);
    const detail = structuredClone(
      await abortable(adapter.get(nativeId, selection, signal), signal),
    );
    detail.asset = publicAsset(detail.asset);
    if (detail.asset.assetId !== input.assetId || detail.asset.provider !== provider)
      throw new Error("Invalid provider detail identity.");
    const basic = {
      asset: detail.asset,
      selectedVariant: detail.selectedVariant,
      selectionExplanation: detail.selectionExplanation,
      alternatives: detail.alternatives,
      ...(detail.providerDetails ? { providerDetails: detail.providerDetails } : {}),
    };
    if (
      !detail.asset.canDownloadNow ||
      detail.asset.downloadStatus !== "direct" ||
      detail.asset.free !== "yes" ||
      detail.asset.license.name.toLowerCase() === "unknown" ||
      !detail.asset.license.evidence ||
      !detail.files.length
    )
      return { ...basic, plan: null };
    validateFiles(detail);
    if (Buffer.byteLength(JSON.stringify(detail)) > 64 * 1024)
      throw new Error("Asset plan metadata exceeds its byte budget.");
    for (const [token, old] of this.plans)
      if (old.expiresAt <= Date.now()) this.plans.delete(token);
    while (this.plans.size >= 100) this.plans.delete(this.plans.keys().next().value!);
    const planToken = randomUUID();
    const expiresAt = Date.now() + this.planTtlMs;
    this.plans.set(planToken, {
      detail,
      selection,
      adapter,
      expiresAt,
      identity: detailIdentity(detail),
    });
    return {
      ...basic,
      plan: {
        planToken,
        expiresAt: new Date(expiresAt).toISOString(),
        selectedVariant: detail.selectedVariant,
        files: detail.files.map(({ url: _url, ...file }) => file),
        acknowledgement: "Explicitly acknowledge the evidenced item terms; a plan is not consent.",
        maxBytes: this.downloader.byteLimit,
      },
    };
  }

  private currentPlan(token: string): Plan {
    const plan = this.plans.get(token);
    if (!plan || plan.expiresAt <= Date.now()) {
      this.plans.delete(token);
      throw new FederationError(
        "ASSET_PLAN_EXPIRED",
        "Invalid or expired acquisition plan; call asset_get again.",
      );
    }
    return plan;
  }

  async download(rawInput: z.input<typeof AssetDownloadInputSchema>, callerSignal?: AbortSignal) {
    const input = AssetDownloadInputSchema.parse(rawInput);
    const plan = this.currentPlan(input.planToken);
    const maxBytes = input.maxBytes ?? this.downloader.byteLimit;
    if (maxBytes > this.downloader.byteLimit)
      throw new FederationError(
        "ASSET_INVALID_BUDGET",
        "The byte budget may only tighten the configured cap.",
      );
    const signal = AbortSignal.any([
      AbortSignal.timeout(1800000),
      ...(callerSignal ? [callerSignal] : []),
    ]);
    while (this.acquisitions.has(plan.identity))
      await abortable(
        this.acquisitions.get(plan.identity)!.catch(() => undefined),
        signal,
      );
    signal.throwIfAborted();
    this.currentPlan(input.planToken);
    const work = (async () => {
      const metadataSignal = AbortSignal.any([signal, AbortSignal.timeout(this.searchTimeoutMs)]);
      const current = await abortable(
        plan.adapter.get(plan.detail.asset.nativeId, plan.selection, metadataSignal),
        metadataSignal,
      );
      current.asset = publicAsset(current.asset);
      if (
        detailIdentity(current) !== plan.identity ||
        !current.asset.canDownloadNow ||
        current.asset.free !== "yes" ||
        current.asset.downloadStatus !== "direct"
      ) {
        this.plans.delete(input.planToken);
        throw new FederationError(
          "ASSET_PLAN_CHANGED",
          "Asset terms, capability or selected files changed; call asset_get and acknowledge again.",
        );
      }
      this.currentPlan(input.planToken);
      return acquire(plan.detail, this.downloader, maxBytes, this.options.toolVersion, signal);
    })();
    this.acquisitions.set(plan.identity, work);
    try {
      return await work;
    } finally {
      if (this.acquisitions.get(plan.identity) === work) this.acquisitions.delete(plan.identity);
    }
  }
}
