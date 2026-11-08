import { z } from "zod";

import {
  DirectAssetDownloader,
  DirectAssetDownloadError,
} from "../download/direct-asset-downloader.js";

const ProviderSchema = z.enum([
  "polyhaven",
  "ambientcg",
  "smithsonian",
  "game-icons",
  "polyfork",
  "kenney",
]);

export const DirectAssetDownloadInputSchema = z.object({
  provider: ProviderSchema,
  url: z.url().max(4_096),
  fileName: z.string().trim().min(1).max(220),
  acceptLicense: z.literal(true).describe(
    "Required acknowledgement that the caller reviewed and accepts the license metadata returned by the provider's search/detail/file tools.",
  ),
});

export const DirectAssetDownloadOutputSchema = z.object({
  provider: ProviderSchema,
  fileName: z.string().max(220),
  path: z.string().max(4_096),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  alreadyExisted: z.boolean(),
  sourceUrl: z.url().max(4_096),
  licenseAcknowledged: z.literal(true),
  sizeMeters: z
    .object({
      x: z.number().nonnegative(),
      y: z.number().nonnegative(),
      z: z.number().nonnegative(),
    })
    .optional(),
});

function errorResult(error: unknown) {
  const safe =
    error instanceof DirectAssetDownloadError
      ? {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
        }
      : error instanceof z.ZodError
        ? {
            code: "ASSET_DOWNLOAD_INVALID_INPUT",
            message: "The direct asset download input is invalid.",
            retryable: false,
          }
        : {
            code: "ASSET_DOWNLOAD_INTERNAL",
            message: "The asset MCP could not complete the direct download.",
            retryable: false,
          };
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify(safe) }],
  };
}

export function createDirectAssetDownloadHandler(
  downloader: DirectAssetDownloader,
) {
  return async (rawInput: z.input<typeof DirectAssetDownloadInputSchema>) => {
    try {
      const input = DirectAssetDownloadInputSchema.parse(rawInput);
      const output = DirectAssetDownloadOutputSchema.parse(
        await downloader.download({
          provider: input.provider,
          url: input.url,
          fileName: input.fileName,
        }),
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
        structuredContent: output,
      };
    } catch (error) {
      return errorResult(error);
    }
  };
}
