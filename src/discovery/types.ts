import { z } from "zod";

export const AssetTypeSchema = z.enum(["3d-model", "texture", "hdri", "animation"]);
export const AssetSchema = z.object({
  assetId: z.string().min(3).max(800),
  provider: z.string().max(100),
  nativeId: z.string().min(1).max(200),
  sourceUrl: z.url().max(2048),
  title: z.string().min(1).max(500),
  type: AssetTypeSchema,
  itemKind: z.enum(["asset", "pack"]),
  free: z.enum(["yes", "no", "unknown"]),
  license: z.object({
    name: z.string().max(200),
    url: z.url().max(2048).optional(),
    evidence: z.string().max(2000),
    commercialUse: z.enum(["yes", "no", "unknown"]),
    attributionRequired: z.enum(["yes", "no", "unknown"]),
  }),
  author: z.string().max(2000).optional(),
  apiCredit: z.string().max(500).optional(),
  thumbnailUrl: z.url().max(2048).optional(),
  downloadStatus: z.enum(["direct", "auth-required", "manual", "unsupported", "unknown"]),
  downloadReason: z.string().max(1000),
  canDownloadNow: z.boolean(),
  bakeCall: z.string().max(500).optional(),
  providerRank: z.number().int().nonnegative(),
  rankingFactors: z.array(z.string().max(200)).max(8),
});
export type Asset = z.infer<typeof AssetSchema>;
export type Selection = { format?: string; resolution?: string; mapRoles?: string[] };
export type AssetFile = {
  id: string;
  path: string;
  url: string;
  role: string;
  sizeBytes?: number;
  md5?: string;
  dependencyOf?: string;
  metadata?: Record<string, string>;
};
export type AssetDetail = {
  asset: Asset;
  files: AssetFile[];
  selectedVariant: string;
  selectionExplanation: string;
  alternatives: string[];
  termsText: string;
  providerDetails?: Record<string, unknown>;
};
/**
 * A suggestion from a local catalog: a candidate that shares only part of the query (PRD-063).
 * It never goes into `items`/`results`, because a caller reads a result row as proof the query
 * was fully searched and matched.
 */
export type AssetCloseMatch = {
  asset: Asset;
  matchedWords: string[];
  missingWords: string[];
};
/** How many close matches one search answers with, across every provider. */
export const CLOSE_MATCH_LIMIT = 5;
/**
 * How many words one suggestion may carry, and how long each may be. The query is capped at 200
 * characters, and lowercasing can double a code point (U+0130 gains a combining mark), which splits
 * rather than lengthens the word — so a word is at most 200 characters and a query of one-character
 * words holds at most 100 of them. 200 leaves room for both without letting a provider send a page
 * the output schema would reject for every provider at once.
 */
export const CLOSE_WORD_LIMIT = 200;
export const CLOSE_WORD_MAX_LENGTH = 200;
/** What separates words in a query, an id or a title. `cul-de-sac` is three words, not one. */
export const WORD = /[^\p{L}\p{N}]+/u;

export interface AssetAdapter {
  id: string;
  search(
    query: string,
    types: Asset["type"][],
    limit: number,
    signal: AbortSignal,
  ): Promise<{
    items: Asset[];
    truncated: boolean;
    closeItems?: AssetCloseMatch[];
    continuation?: { tool: string; arguments: Record<string, unknown> };
  }>;
  get(nativeId: string, selection: Selection, signal: AbortSignal): Promise<AssetDetail>;
}

export function assetId(provider: string, nativeId: string): string {
  return `${provider}:${encodeURIComponent(nativeId)}`;
}
