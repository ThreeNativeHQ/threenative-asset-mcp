import { stat } from "node:fs/promises";

import { z } from "zod";

import { assetStoreCacheRoot, listCachedUnityPackages } from "../unity/cache.js";

export const UnityListPackagesInputSchema = z.object({});

export const UnityListPackagesOutputSchema = z.object({
  cacheRoot: z.string().max(4_096),
  cacheExists: z.boolean(),
  total: z.number().int().nonnegative(),
  packages: z
    .array(
      z.object({
        path: z.string().max(4_096),
        publisher: z.string().max(500).optional(),
        category: z.string().max(500).optional(),
        name: z.string().max(500),
        sizeBytes: z.number().int().nonnegative(),
        modifiedAt: z.string().max(40),
      }),
    )
    .max(1_000),
});

export function createUnityListPackagesHandler(environment: NodeJS.ProcessEnv = process.env) {
  return async () => {
    try {
      const cacheRoot = assetStoreCacheRoot({ environment });
      const all = await listCachedUnityPackages(cacheRoot);
      const output = UnityListPackagesOutputSchema.parse({
        cacheRoot,
        cacheExists: await stat(cacheRoot).then((info) => info.isDirectory(), () => false),
        total: all.length,
        packages: all.slice(0, 1_000),
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(output) }], structuredContent: output };
    } catch {
      const safe = {
        code: "UNITY_INTERNAL",
        message: "The asset MCP could not list the local Unity package cache.",
        retryable: false,
      };
      return { isError: true as const, content: [{ type: "text" as const, text: JSON.stringify(safe) }] };
    }
  };
}
