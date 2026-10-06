import type { ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import { DirectAssetDownloadError } from "../download/direct-asset-downloader.js";
import { AcquisitionError } from "../discovery/acquisition.js";
import {
  AssetFederation,
  AssetSearchInputSchema,
  AssetGetInputSchema,
  AssetDownloadInputSchema,
  FederationError,
} from "../discovery/federation.js";
import { AssetSchema } from "../discovery/types.js";
export { AssetSearchInputSchema, AssetGetInputSchema, AssetDownloadInputSchema };

const PublicFileSchema = z.object({
  id: z.string().max(1000),
  path: z.string().max(500),
  role: z.string().max(100),
  sizeBytes: z.number().int().nonnegative().optional(),
  md5: z
    .string()
    .regex(/^[a-f0-9]{32}$/iu)
    .optional(),
  dependencyOf: z.string().max(1000).optional(),
  metadata: z.record(z.string().max(100), z.string().max(2000)).optional(),
});
const ReceiptFileSchema = PublicFileSchema.omit({ id: true, md5: true }).extend({
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
const ProviderReportSchema = z.object({
  provider: z.string().max(100),
  sourceUrl: z.url().max(2048),
  status: z.enum(["ok", "timeout", "error", "rate-limited", "auth-required", "manual", "skipped"]),
  reason: z.string().max(1000),
  truncated: z.boolean(),
  retryAfter: z.string().max(100).optional(),
  continuation: z
    .object({ tool: z.string().max(100), arguments: z.record(z.string(), z.unknown()) })
    .optional(),
});
export const AssetSearchOutputSchema = z.object({
  results: z.array(AssetSchema).max(50),
  providers: z.array(ProviderReportSchema).max(20),
  partial: z.boolean(),
  searchedAt: z.string(),
  notice: z.string().max(1000),
});
export const AssetGetOutputSchema = z.object({
  asset: AssetSchema,
  selectedVariant: z.string().max(200),
  selectionExplanation: z.string().max(2000),
  alternatives: z.array(z.string().max(200)).max(500),
  providerDetails: z.record(z.string(), z.unknown()).optional(),
  plan: z
    .object({
      planToken: z.string().max(100),
      expiresAt: z.string(),
      selectedVariant: z.string().max(200),
      files: z.array(PublicFileSchema).max(128),
      acknowledgement: z.string().max(1000),
      maxBytes: z.number().int().positive(),
    })
    .nullable(),
});
const ReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  assetId: z.string().max(800),
  provider: z.string().max(100),
  nativeId: z.string().max(200),
  sourceUrl: z.url().max(2048),
  license: AssetSchema.shape.license,
  author: z.string().max(2000).optional(),
  apiCredit: z.string().max(500).optional(),
  fetchedAt: z.string(),
  toolVersion: z.string().max(100),
  acknowledgedTermsDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  planIdentity: z.string().regex(/^[a-f0-9]{64}$/u),
  selectedVariant: z.string().max(200),
  runtimeReadiness: z.literal("unverified"),
  requiresExtraction: z.boolean(),
  files: z.array(ReceiptFileSchema).max(128),
});
export const AssetDownloadOutputSchema = z.object({
  directory: z.string(),
  receiptPath: z.string(),
  files: z.array(ReceiptFileSchema).max(128),
  totalBytes: z.number().int().nonnegative(),
  receipt: ReceiptSchema,
  alreadyExisted: z.boolean(),
  runtimeReadiness: z.literal("unverified"),
  requiresExtraction: z.boolean(),
});

function failure(error: unknown) {
  const known =
    error instanceof FederationError ||
    error instanceof AcquisitionError ||
    error instanceof DirectAssetDownloadError;
  const code =
    error instanceof FederationError || error instanceof DirectAssetDownloadError
      ? error.code
      : error instanceof z.ZodError
        ? "ASSET_INVALID_INPUT"
        : "ASSET_REQUEST_FAILED";
  const output = {
    code,
    message: known
      ? error.message.slice(0, 1000)
      : "The asset request could not be completed safely.",
    ...(error instanceof FederationError && error.reports ? { providers: error.reports } : {}),
  };
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify(output) }],
  };
}
function success<T extends Record<string, unknown>>(output: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

export function createAssetSearchHandler(federation: AssetFederation) {
  return async (input: z.input<typeof AssetSearchInputSchema>, context?: ServerContext) => {
    try {
      return success(
        AssetSearchOutputSchema.parse(await federation.search(input, context?.mcpReq.signal)),
      );
    } catch (error) {
      return failure(error);
    }
  };
}
export function createAssetGetHandler(federation: AssetFederation) {
  return async (input: z.input<typeof AssetGetInputSchema>, context?: ServerContext) => {
    try {
      return success(
        AssetGetOutputSchema.parse(await federation.get(input, context?.mcpReq.signal)),
      );
    } catch (error) {
      return failure(error);
    }
  };
}
export function createAssetDownloadHandler(federation: AssetFederation) {
  return async (input: z.input<typeof AssetDownloadInputSchema>, context?: ServerContext) => {
    try {
      return success(
        AssetDownloadOutputSchema.parse(await federation.download(input, context?.mcpReq.signal)),
      );
    } catch (error) {
      return failure(error);
    }
  };
}
