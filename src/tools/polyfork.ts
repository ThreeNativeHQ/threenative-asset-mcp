import { z } from "zod";

import {
  POLYFORK_CLASSES,
  PolyforkClient,
  PolyforkClientError,
  parsePolyforkIdOrUrl,
  type PolyforkAsset,
  type PolyforkDetail,
} from "../polyfork/client.js";
import { POLYFORK_TERMS, polyforkLicense } from "../polyfork/license.js";

const LicenseSchema = z.object({
  name: z.string().max(200),
  url: z.url().max(2_048).optional(),
  evidence: z.string().max(2_000),
  commercialUse: z.enum(["yes", "no", "unknown"]),
  attributionRequired: z.enum(["yes", "no", "unknown"]),
});
const SizeSchema = z.object({
  x: z.number().nonnegative(),
  y: z.number().nonnegative(),
  z: z.number().nonnegative(),
});
const HdSchema = z.object({
  plan: z.literal("pro"),
  pageUrl: z.url().max(2_048),
  triangles: z.number().int().nonnegative().optional(),
  previewGlbUrl: z.url().max(2_048).optional(),
});
const ClipSchema = z.object({
  name: z.string().max(200),
  seconds: z.number().nonnegative().optional(),
});
const DownloadStatusSchema = z.enum(["direct", "auth-required", "unsupported"]);

const AssetSchema = z.object({
  id: z.string().max(80),
  title: z.string().max(500),
  url: z.url().max(2_048),
  thumbnailUrl: z.url().max(2_048).optional(),
  class: z.enum(POLYFORK_CLASSES),
  kit: z.string().max(80).optional(),
  triangles: z.number().int().nonnegative().optional(),
  free: z.boolean(),
  plan: z.string().max(40).optional(),
  hasRig: z.boolean(),
  hasSkeleton: z.boolean(),
  hasIk: z.boolean(),
  ikType: z.enum(["legs", "arm"]).optional(),
  size: SizeSchema.optional(),
  hd: HdSchema.nullable(),
  downloadStatus: DownloadStatusSchema,
  canDownloadNow: z.boolean(),
  license: LicenseSchema,
});

function downloadStatus(item: PolyforkAsset): z.infer<typeof DownloadStatusSchema> {
  if (item.free && item.download.auth === "none" && item.download.glb) return "direct";
  if (!item.free || item.download.auth !== "none") return "auth-required";
  return "unsupported";
}

function assetOutput(
  item: PolyforkAsset,
  license: z.infer<typeof LicenseSchema>,
): z.infer<typeof AssetSchema> {
  const status = downloadStatus(item);
  return {
    id: item.id,
    title: item.title,
    url: item.pageUrl,
    ...(item.thumbnailUrl ? { thumbnailUrl: item.thumbnailUrl } : {}),
    class: item.assetClass,
    ...(item.kit ? { kit: item.kit } : {}),
    ...(item.triangles !== undefined ? { triangles: item.triangles } : {}),
    free: item.free,
    ...(item.plan ? { plan: item.plan } : {}),
    hasRig: item.hasRig,
    hasSkeleton: item.hasSkeleton,
    hasIk: item.hasIk,
    ...(item.ikType ? { ikType: item.ikType } : {}),
    ...(item.size ? { size: item.size } : {}),
    hd: item.hd
      ? {
          plan: "pro" as const,
          pageUrl: item.hd.pageUrl,
          ...(item.hd.triangles !== undefined ? { triangles: item.hd.triangles } : {}),
          ...(item.hd.previewGlbUrl ? { previewGlbUrl: item.hd.previewGlbUrl } : {}),
        }
      : null,
    downloadStatus: status,
    canDownloadNow: status === "direct",
    license,
  };
}

function errorResult(error: unknown) {
  const safe =
    error instanceof PolyforkClientError
      ? {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}),
        }
      : error instanceof z.ZodError
        ? {
            code: "POLYFORK_INVALID_INPUT",
            message: "The Polyfork request input is invalid.",
            retryable: false,
          }
        : {
            code: "POLYFORK_INTERNAL",
            message: "The Polyfork provider could not complete the request.",
            retryable: false,
          };
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify(safe) }],
  };
}

function successResult<T extends Record<string, unknown>>(output: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

const ClassFilterSchema = z.union([z.literal("all"), z.enum(POLYFORK_CLASSES)]).default("all");

export const PolyforkSearchInputSchema = z
  .object({
    query: z.string().trim().max(200).optional(),
    class: ClassFilterSchema,
    kit: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9-]{2,78}[a-z0-9]$/)
      .optional(),
    free: z.boolean().default(true),
    minTriangles: z.number().int().nonnegative().max(50_000_000).optional(),
    maxTriangles: z.number().int().nonnegative().max(50_000_000).optional(),
    sort: z.enum(["relevance", "latest", "tris"]).default("relevance"),
    limit: z.number().int().min(1).max(48).default(24),
    cursor: z.string().regex(/^\d+$/).max(10).optional(),
  })
  .superRefine((input, context) => {
    if (
      input.minTriangles !== undefined &&
      input.maxTriangles !== undefined &&
      input.minTriangles > input.maxTriangles
    )
      context.addIssue({
        code: "custom",
        message: "minTriangles must not exceed maxTriangles",
        path: ["minTriangles"],
      });
  });
export const PolyforkSearchOutputSchema = z.object({
  items: z.array(AssetSchema).max(48),
  total: z.number().int().nonnegative(),
  nextCursor: z.string().max(10).optional(),
  coverage: z.string().max(40).optional(),
  strongMatches: z.number().int().nonnegative().optional(),
  provider: z.literal("Polyfork"),
  license: LicenseSchema,
  notice: z.string().max(1_000),
});

export function createPolyforkSearchHandler(client: PolyforkClient) {
  return async (rawInput: z.input<typeof PolyforkSearchInputSchema>) => {
    try {
      const input = PolyforkSearchInputSchema.parse(rawInput);
      const page = Number(input.cursor ?? 1);
      const result = await client.search({
        ...(input.query ? { query: input.query } : {}),
        ...(input.class === "all" ? {} : { assetClass: input.class }),
        ...(input.kit ? { kit: input.kit } : {}),
        free: input.free,
        ...(input.minTriangles !== undefined ? { minTriangles: input.minTriangles } : {}),
        ...(input.maxTriangles !== undefined ? { maxTriangles: input.maxTriangles } : {}),
        sort: input.sort,
        page,
        perPage: input.limit,
      });
      const license = polyforkLicense();
      const nextCursor =
        result.total > result.page * result.perPage ? String(result.page + 1) : undefined;
      return successResult(
        PolyforkSearchOutputSchema.parse({
          items: result.items.map((item) => assetOutput(item, license)),
          total: result.total,
          ...(nextCursor ? { nextCursor } : {}),
          ...(result.coverage ? { coverage: result.coverage } : {}),
          ...(result.strongMatches !== undefined ? { strongMatches: result.strongMatches } : {}),
          provider: "Polyfork",
          license,
          notice:
            result.items.length === 0 && input.query
              ? "The Polyfork catalogue returned no word match for this query; it matches words, not concepts."
              : "Bounded Polyfork catalogue page, not a full census. Free low-poly GLBs download anonymously; a model's HD edition needs Pro.",
        }),
      );
    } catch (error) {
      return errorResult(error);
    }
  };
}

export const PolyforkModelInputSchema = z.object({
  idOrUrl: z.string().trim().min(1).max(2_048),
});
export { PolyforkModelInputSchema as PolyforkGetModelInputSchema };
export { PolyforkModelInputSchema as PolyforkListFilesInputSchema };

const ExportFormatSchema = z.object({
  format: z.string().max(20),
  url: z.url().max(2_048).optional(),
  for: z.string().max(200).optional(),
  available: z.boolean().optional(),
  note: z.string().max(300).optional(),
});

export const PolyforkGetModelOutputSchema = z.object({
  id: z.string().max(80),
  title: z.string().max(500),
  url: z.url().max(2_048),
  class: z.enum(POLYFORK_CLASSES),
  kit: z.string().max(80).optional(),
  triangles: z.number().int().nonnegative().optional(),
  previewTriangles: z.number().int().nonnegative().optional(),
  free: z.boolean(),
  plan: z.string().max(40).optional(),
  publishedAt: z.string().max(100).optional(),
  description: z.string().max(12_000).optional(),
  license: LicenseSchema,
  credit: z.string().max(1_000).optional(),
  thumbnailUrl: z.url().max(2_048).optional(),
  renders: z.array(z.url().max(2_048)).max(40),
  size: SizeSchema.optional(),
  originY: z.number().optional(),
  massKg: z.number().nonnegative().optional(),
  style: z.string().max(500).optional(),
  materials: z.number().int().nonnegative().optional(),
  drawCalls: z.number().int().nonnegative().optional(),
  hasRig: z.boolean(),
  hasSkeleton: z.boolean(),
  hasIk: z.boolean(),
  ikType: z.enum(["legs", "arm"]).optional(),
  clips: z.array(ClipSchema).max(50),
  skeleton: z
    .object({
      bones: z.number().int().nonnegative().optional(),
      binding: z.string().max(500).optional(),
      naming: z.string().max(1_000).optional(),
    })
    .nullable(),
  download: z.object({
    lowPolyGlb: z
      .object({
        url: z.url().max(2_048),
        requiresAuth: z.enum(["none", "required"]),
        variant: z.literal("low-poly/full"),
      })
      .nullable(),
    previewGlb: z
      .object({
        url: z.url().max(2_048),
        preview: z.literal(true),
        requiresAuth: z.literal("none"),
      })
      .nullable(),
    sourceModule: z
      .object({
        url: z.url().max(2_048),
        requiresAuth: z.literal("account"),
        note: z.string().max(300),
      })
      .nullable(),
  }),
  hd: z
    .object({
      plan: z.literal("pro"),
      requiresPlan: z.literal("pro"),
      requiresAuth: z.literal("required"),
      pageUrl: z.url().max(2_048),
      triangles: z.number().int().nonnegative().optional(),
      previewGlbUrl: z.url().max(2_048).optional(),
      filesNote: z.string().max(500).optional(),
    })
    .nullable(),
  exportFormats: z.array(ExportFormatSchema).max(8),
  access: z
    .object({
      as: z.string().max(40),
      remixesLeftThisHour: z.number().int().nonnegative().optional(),
      freeAccountNote: z.string().max(500).optional(),
      proNote: z.string().max(500).optional(),
    })
    .nullable(),
  providerDetails: z.record(z.string(), z.unknown()),
});

export function createPolyforkGetModelHandler(client: PolyforkClient) {
  return async (rawInput: z.input<typeof PolyforkModelInputSchema>) => {
    try {
      const input = PolyforkModelInputSchema.parse(rawInput);
      const id = parsePolyforkIdOrUrl(input.idOrUrl);
      const item = await client.getAsset(id);
      const license = polyforkLicense(item.credit, item.licenseText);
      return successResult(
        PolyforkGetModelOutputSchema.parse({
          id: item.id,
          title: item.title,
          url: item.pageUrl,
          class: item.assetClass,
          ...(item.kit ? { kit: item.kit } : {}),
          ...(item.triangles !== undefined ? { triangles: item.triangles } : {}),
          ...(item.previewTriangles !== undefined
            ? { previewTriangles: item.previewTriangles }
            : {}),
          free: item.free,
          ...(item.plan ? { plan: item.plan } : {}),
          ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
          ...(item.description ? { description: item.description } : {}),
          license,
          ...(item.credit ? { credit: item.credit } : {}),
          ...(item.thumbnailUrl ? { thumbnailUrl: item.thumbnailUrl } : {}),
          renders: item.renders,
          ...(item.size ? { size: item.size } : {}),
          ...(item.originY !== undefined ? { originY: item.originY } : {}),
          ...(item.massKg !== undefined ? { massKg: item.massKg } : {}),
          ...(item.style ? { style: item.style } : {}),
          ...(item.materials !== undefined ? { materials: item.materials } : {}),
          ...(item.drawCalls !== undefined ? { drawCalls: item.drawCalls } : {}),
          hasRig: item.hasRig,
          hasSkeleton: item.hasSkeleton,
          hasIk: item.hasIk,
          ...(item.ikType ? { ikType: item.ikType } : {}),
          clips: item.clips,
          skeleton: item.skeleton ?? null,
          download: {
            lowPolyGlb: item.download.glb
              ? {
                  url: item.download.glb,
                  requiresAuth: item.download.auth === "none" ? "none" : "required",
                  variant: "low-poly/full" as const,
                }
              : null,
            previewGlb: item.previewGlbUrl
              ? {
                  url: item.previewGlbUrl,
                  preview: true as const,
                  requiresAuth: "none" as const,
                }
              : null,
            sourceModule: item.download.mjs
              ? {
                  url: item.download.mjs,
                  requiresAuth: "account" as const,
                  note: "Polyfork's .mjs source program: never fetched or executed by this MCP.",
                }
              : null,
          },
          hd: item.hd
            ? {
                plan: "pro" as const,
                requiresPlan: "pro" as const,
                requiresAuth: "required" as const,
                pageUrl: item.hd.pageUrl,
                ...(item.hd.triangles !== undefined ? { triangles: item.hd.triangles } : {}),
                ...(item.hd.previewGlbUrl ? { previewGlbUrl: item.hd.previewGlbUrl } : {}),
                ...(item.hd.filesNote ? { filesNote: item.hd.filesNote } : {}),
              }
            : null,
          exportFormats: item.exportFormats,
          access: item.access ?? null,
          providerDetails: {
            class: item.assetClass,
            kit: item.kit ?? null,
            triangles: item.triangles ?? null,
            previewTriangles: item.previewTriangles ?? null,
            size: item.size ?? null,
            originY: item.originY ?? null,
            massKg: item.massKg ?? null,
            style: item.style ?? null,
            materials: item.materials ?? null,
            drawCalls: item.drawCalls ?? null,
            publishedAt: item.publishedAt ?? null,
            credit: item.credit ?? null,
            licenseText: item.licenseText ?? null,
            exportFormats: item.exportFormats,
            access: item.access ?? null,
          },
        }),
      );
    } catch (error) {
      return errorResult(error);
    }
  };
}

export const PolyforkListFilesOutputSchema = z.object({
  assetId: z.string().max(80),
  title: z.string().max(500),
  pageUrl: z.url().max(2_048),
  files: z
    .array(
      z.object({
        id: z.string().max(40),
        format: z.literal("glb"),
        role: z.enum(["source", "preview", "hd"]),
        url: z.url().max(2_048).optional(),
        variant: z.string().max(40),
        requiresAuth: z.enum(["none", "required"]),
        requiresPlan: z.enum(["free", "pro"]),
        preview: z.literal(true).optional(),
        note: z.string().max(300).optional(),
      }),
    )
    .max(4),
  license: LicenseSchema,
  credit: z.string().max(1_000).optional(),
  termsText: z.string().max(2_000),
  alternatives: z.array(z.string().max(40)).max(8),
  requirement: z.string().max(500).optional(),
});

export function createPolyforkListFilesHandler(client: PolyforkClient) {
  return async (rawInput: z.input<typeof PolyforkModelInputSchema>) => {
    try {
      const input = PolyforkModelInputSchema.parse(rawInput);
      const item = await client.getAsset(parsePolyforkIdOrUrl(input.idOrUrl));
      return successResult(PolyforkListFilesOutputSchema.parse(listFiles(item)));
    } catch (error) {
      return errorResult(error);
    }
  };
}

function listFiles(item: PolyforkDetail): z.infer<typeof PolyforkListFilesOutputSchema> {
  const gated = !item.free || item.download.auth !== "none";
  const plannable = !gated && !!item.download.glb;
  const unavailableNote = gated
    ? "Polyfork gates this model's full GLB behind an account or Pro plan; no anonymous download is planned."
    : "Polyfork's full-GLB URL did not match its verified /cdn contract; no download is planned.";
  const files: z.infer<typeof PolyforkListFilesOutputSchema>["files"] = [
    {
      id: "low-poly-glb",
      format: "glb",
      role: "source",
      ...(plannable && item.download.glb ? { url: item.download.glb } : {}),
      variant: "low-poly/full",
      requiresAuth: plannable ? "none" : "required",
      requiresPlan: "free",
      note: plannable
        ? "Full low-poly GLB from Polyfork's anonymous /cdn contract."
        : unavailableNote,
    },
  ];
  if (item.previewGlbUrl)
    files.push({
      id: "preview-glb",
      format: "glb",
      role: "preview",
      url: item.previewGlbUrl,
      variant: "low-poly/preview",
      requiresAuth: "none",
      requiresPlan: "free",
      preview: true,
      note: "Preview only: flat-shaded normals are stripped; build with the full GLB instead.",
    });
  if (item.hd)
    files.push({
      id: "hd-glb",
      format: "glb",
      role: "hd",
      variant: "hd/full",
      requiresAuth: "required",
      requiresPlan: "pro",
      note: "The HD edition needs Polyfork Pro; free accounts get its preview only.",
    });
  const alternatives = [
    "glb/low-poly/full",
    ...(item.previewGlbUrl ? ["glb/low-poly/preview"] : []),
    ...(item.hd ? ["hd/full (Polyfork Pro)"] : []),
  ];
  return {
    assetId: item.id,
    title: item.title,
    pageUrl: item.pageUrl,
    files,
    license: polyforkLicense(item.credit, item.licenseText),
    ...(item.credit ? { credit: item.credit } : {}),
    termsText: POLYFORK_TERMS,
    alternatives,
    ...(plannable
      ? {}
      : {
          requirement: gated
            ? "Polyfork requires a free account or Pro for this model; this MCP does not sign in, hold keys or bypass that gate."
            : "Polyfork's full-GLB URL did not match the verified /cdn/<id>.glb contract; no download is planned.",
        }),
  };
}
