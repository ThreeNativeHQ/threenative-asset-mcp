import { z } from "zod";

import {
  AudioCatalogClient,
  AudioCatalogError,
} from "../audio/client.js";
import { AudioGenerateError, type AudioGenerator } from "../audio/generate.js";
import { AudioInspectError, type AudioInspector } from "../audio/inspect.js";

const AudioSourceIdSchema = z.enum([
  "sonniss",
  "kenney",
  "tallbeard",
  "scott-buckley",
  "itch-io",
  "mixkit",
  "pixabay",
  "freesound",
  "opengameart",
  "abstraction",
]);
const AudioKindSchema = z.enum(["sfx", "music", "mixed"]);

const AudioSourceSchema = z.object({
  id: AudioSourceIdSchema,
  name: z.string().max(200),
  bestFor: z.string().max(1_000),
  kinds: z.array(AudioKindSchema).max(3),
  browseUrls: z.array(z.url().max(2_048)).max(5),
  licenseSummary: z.string().max(1_000),
  commercialUse: z.string().max(1_000),
  attribution: z.string().max(1_000),
  programmaticDownload: z.enum(["curated-direct", "provider-page"]),
  caution: z.string().max(1_000).optional(),
});

const AudioAssetSchema = z.object({
  id: z.string().max(200),
  sourceId: AudioSourceIdSchema,
  name: z.string().max(500),
  description: z.string().max(2_000),
  kind: AudioKindSchema,
  tags: z.array(z.string().max(100)).max(50),
  license: z.string().max(500),
  commercialUse: z.boolean(),
  attributionRequired: z.boolean(),
  attributionText: z.string().max(1_000).optional(),
  sourcePageUrl: z.url().max(2_048),
  downloadUrl: z.url().max(2_048),
  fileName: z.string().max(255),
  sizeBytes: z.number().int().nonnegative().optional(),
  directDownload: z.literal(true),
  redistributionAllowed: z.literal(false),
});

function successResult<T extends Record<string, unknown>>(output: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(output) }],
    structuredContent: output,
  };
}

function errorResult(error: unknown) {
  const safe =
    error instanceof AudioCatalogError ||
    error instanceof AudioInspectError ||
    error instanceof AudioGenerateError
      ? {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
        }
      : error instanceof z.ZodError
        ? {
            code: "AUDIO_INVALID_INPUT",
            message: "The audio tool input is invalid.",
            retryable: false,
          }
        : {
            code: "AUDIO_INTERNAL",
            message: "The asset MCP could not complete the audio request.",
            retryable: false,
          };
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify(safe) }],
  };
}

export const AudioListSourcesInputSchema = z.object({});
export const AudioListSourcesOutputSchema = z.object({
  sources: z.array(AudioSourceSchema).max(20),
  total: z.number().int().nonnegative(),
});

export function createAudioListSourcesHandler(client: AudioCatalogClient) {
  return async (rawInput: z.input<typeof AudioListSourcesInputSchema>) => {
    try {
      AudioListSourcesInputSchema.parse(rawInput);
      const sources = client.listSources();
      return successResult(
        AudioListSourcesOutputSchema.parse({ sources, total: sources.length }),
      );
    } catch (error) {
      return errorResult(error);
    }
  };
}

export const AudioSearchInputSchema = z.object({
  query: z.string().trim().max(200).optional(),
  kind: z.enum(["all", "sfx", "music", "mixed"]).default("all"),
  source: z.union([z.literal("all"), AudioSourceIdSchema]).default("all"),
  limit: z.number().int().min(1).max(100).default(24),
  cursor: z.string().regex(/^\d+$/).max(10).optional(),
});
export const AudioSearchOutputSchema = z.object({
  items: z.array(AudioAssetSchema).max(100),
  nextCursor: z.string().max(10).optional(),
  total: z.number().int().nonnegative(),
});

export function createAudioSearchHandler(client: AudioCatalogClient) {
  return async (rawInput: z.input<typeof AudioSearchInputSchema>) => {
    try {
      const input = AudioSearchInputSchema.parse(rawInput);
      const items = client.searchAssets({
        ...(input.query ? { query: input.query } : {}),
        kind: input.kind,
        source: input.source,
      });
      const offset = Number(input.cursor ?? 0);
      const page = items.slice(offset, offset + input.limit);
      return successResult(
        AudioSearchOutputSchema.parse({
          items: page,
          ...(offset + page.length < items.length
            ? { nextCursor: String(offset + page.length) }
            : {}),
          total: items.length,
        }),
      );
    } catch (error) {
      return errorResult(error);
    }
  };
}

export const AudioDownloadInputSchema = z.object({
  assetId: z.string().trim().regex(/^[a-z0-9-]+$/).max(200),
  acceptLicense: z.literal(true).describe(
    "Required acknowledgement that the caller reviewed and accepts the asset license returned by audio_search_assets.",
  ),
});
export const AudioDownloadOutputSchema = z.object({
  assetId: z.string().max(200),
  sourceId: AudioSourceIdSchema,
  fileName: z.string().max(255),
  path: z.string().max(4_096),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  alreadyExisted: z.boolean(),
  license: z.string().max(500),
  attributionRequired: z.boolean(),
  attributionText: z.string().max(1_000).optional(),
  sourcePageUrl: z.url().max(2_048),
});

export function createAudioDownloadHandler(client: AudioCatalogClient) {
  return async (rawInput: z.input<typeof AudioDownloadInputSchema>) => {
    try {
      const input = AudioDownloadInputSchema.parse(rawInput);
      return successResult(
        AudioDownloadOutputSchema.parse(await client.downloadAsset(input.assetId)),
      );
    } catch (error) {
      return errorResult(error);
    }
  };
}

/** `exactOptionalPropertyTypes` draws a line between "absent" and "present and undefined"; zod's
 * output carries the latter, and the domain types want the former. */
function withoutUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}

const BandBoundSchema = z
  .object({
    min: z.number().min(0).max(100).optional(),
    max: z.number().min(0).max(100).optional(),
  })
  .strict()
  .refine((bound) => bound.min !== undefined || bound.max !== undefined, {
    message: "A band bound that declares neither min nor max asserts nothing.",
  });

const BandsSchema = z
  .object({
    sub: BandBoundSchema.optional(),
    low: BandBoundSchema.optional(),
    mid: BandBoundSchema.optional(),
    high: BandBoundSchema.optional(),
    air: BandBoundSchema.optional(),
  })
  .strict();

const EmotionSchema = z
  .object({
    sourceDescription: z.string().trim().min(1).max(500).describe(
      "What is audibly happening, with no emotional adjective: 'ocean waves washing onto a beach'.",
    ),
    targetMood: z.string().trim().min(1).max(200),
    alternativeMoods: z.array(z.string().trim().min(1).max(200)).min(1).max(5),
  })
  .strict()
  .refine(
    (emotion) =>
      new Set(emotion.alternativeMoods).size === emotion.alternativeMoods.length &&
      !emotion.alternativeMoods.includes(emotion.targetMood),
    { message: "alternativeMoods must be distinct and must not repeat targetMood." },
  );

/** Shared by both tools. Generation supplies path, loop, duration and prompt from its own input. */
const InspectionExpectationShape = {
  expectedPrompt: z.string().trim().min(1).max(2_000).optional(),
  alternativePrompts: z.array(z.string().trim().min(1).max(2_000)).min(1).max(5).optional(),
  emotion: EmotionSchema.optional(),
  bands: BandsSchema.optional(),
  peakMax: z.number().positive().max(10).optional(),
  silenceRms: z.number().positive().max(1).optional(),
  seamMaxRatio: z.number().positive().max(1_000).optional(),
  semantic: z.enum(["off", "clap", "earshot"]).default("off"),
};

/** `semantic: "clap"` must actually ask for something, and a content check needs real distractors. */
function refineSemantics<T extends z.ZodTypeAny>(schema: T, promptSupplied = false) {
  return schema
    .refine(
      (raw) => {
        const input = raw as Record<string, unknown>;
        return (
          input.semantic === "off" ||
          (promptSupplied && input.semantic === "earshot") ||
          input.expectedPrompt !== undefined ||
          input.emotion !== undefined
        );
      },
      {
        message:
          'semantic: "clap" requires a content comparison (expectedPrompt plus alternativePrompts), an emotion object, or both.',
      },
    )
    .refine(
      (raw) => {
        const input = raw as Record<string, unknown>;
        return input.semantic !== "earshot" || input.emotion === undefined;
      },
      { message: 'emotion checking is not available with semantic: "earshot"; use semantic: "clap".' },
    )
    .refine(
      (raw) => {
        const input = raw as Record<string, unknown>;
        return (
          input.expectedPrompt === undefined ||
          input.semantic === "off" ||
          (Array.isArray(input.alternativePrompts) && input.alternativePrompts.length > 0)
        );
      },
      {
        message:
          "A content comparison needs alternativePrompts: 1-5 concrete alternative sound descriptions.",
      },
    )
    .refine(
      (raw) => {
        const input = raw as Record<string, unknown>;
        const alternatives = input.alternativePrompts;
        return (
          !Array.isArray(alternatives) ||
          (new Set(alternatives as string[]).size === alternatives.length &&
            !(alternatives as string[]).includes(input.expectedPrompt as string))
        );
      },
      { message: "alternativePrompts must be distinct and must not repeat expectedPrompt." },
    );
}

export const AudioInspectInputSchema = refineSemantics(
  z
    .object({
      path: z.string().trim().min(1).max(4_096),
      loop: z
        .boolean()
        .describe(
          "Required: it decides whether the loop seam is checked at all, and a default would silently skip it.",
        ),
      expectedDurationSeconds: z.number().positive().max(3_600).optional(),
      ...InspectionExpectationShape,
    })
    .strict(),
);

const SemanticScoreSchema = z.object({ text: z.string().max(2_100), score: z.number() });
const WindowsSchema = z
  .array(
    z.object({
      startSeconds: z.number(),
      endSeconds: z.number(),
      ranked: z.array(SemanticScoreSchema).max(10),
    }),
  )
  .max(200)
  .optional();

export const AudioInspectionResultSchema = z.object({
  inputPath: z.string().max(4_096),
  inputSha256: z.string().regex(/^[0-9a-f]{64}$/),
  inputSizeBytes: z.number().int().nonnegative(),
  analysis: z.object({
    inspector: z.string().max(200),
    inspectorVersion: z.string().max(50),
    adapterVersion: z.string().max(50),
  }),
  limits: z.record(z.string(), z.number()),
  effectiveExpectations: z.record(z.string(), z.unknown()),
  measured: z
    .object({
      durationSeconds: z.number(),
      sampleRate: z.number(),
      channels: z.number(),
      peak: z.number(),
      rms: z.number(),
      dc: z.number(),
      bands: z.record(z.string(), z.number()),
      seam: z
        .object({ wrap: z.number(), nearP99: z.number(), ratio: z.number() })
        .optional(),
    })
    .optional(),
  findings: z
    .array(
      z.object({
        name: z.string().max(200),
        severity: z.enum(["error", "warning"]),
        reason: z.string().max(2_000),
        remedy: z.string().max(2_000).optional(),
      }),
    )
    .max(100),
  spectrogramPath: z.string().max(4_096).optional(),
  technicalStatus: z.enum(["pass", "warn", "fail", "unverified"]),
  promptFit: z.enum(["consistent", "possible_mismatch", "unverified"]),
  semantic: z.object({
    requested: z.boolean(),
    status: z.enum(["consistent", "possible_mismatch", "unverified"]),
    reason: z.string().max(1_000),
    ranked: z.array(SemanticScoreSchema).max(10),
    margin: z.number().optional(),
    windows: WindowsSchema,
    calibrationId: z.string().max(200),
  }),
  emotionFit: z.object({
    status: z.enum(["not_requested", "consistent", "possible_mismatch", "unverified"]),
    requestedMood: z.string().max(200).optional(),
    reason: z.string().max(1_000),
    ranked: z.array(SemanticScoreSchema).max(10),
    margin: z.number().optional(),
    windows: WindowsSchema,
    calibrationId: z.string().max(200),
    moodTemplateVersion: z.string().max(50),
  }),
  artisticQuality: z.literal("unverified"),
  recommendation: z.enum(["reject", "review", "audition"]),
  notes: z.array(z.string().max(1_000)).max(20),
  cacheKey: z.string().max(64),
  cached: z.boolean(),
});

export const AudioInspectOutputSchema = AudioInspectionResultSchema;

export function createAudioInspectHandler(inspector: AudioInspector) {
  return async (rawInput: unknown) => {
    try {
      const input = AudioInspectInputSchema.parse(rawInput);
      return successResult(
        AudioInspectOutputSchema.parse(await inspector.inspect(withoutUndefined(input))),
      );
    } catch (error) {
      return errorResult(error);
    }
  };
}

export const AudioGenerateInputSchema = z
  .object({
    requestId: z
      .uuid()
      .describe(
        "A UUID you choose. Reusing it returns the saved result instead of generating and charging again.",
      ),
    prompt: z.string().trim().min(1).max(2_000),
    durationSeconds: z.number().min(0.5).max(30).default(5),
    loop: z.boolean().default(false),
    promptInfluence: z.number().min(0).max(1).default(0.3),
    inspection: refineSemantics(z.object({ ...InspectionExpectationShape }).strict(), true).optional(),
  })
  .strict();

export const AudioGenerateOutputSchema = z.object({
  requestId: z.string().max(64),
  provider: z.literal("elevenlabs"),
  model: z.string().max(100),
  normalizedRequest: z.record(z.string(), z.unknown()),
  generatedAt: z.string().max(40),
  generation: z.literal("saved"),
  sourcePath: z.string().max(4_096),
  sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  sourceSizeBytes: z.number().int().nonnegative(),
  wavPath: z.string().max(4_096),
  wavSha256: z.string().regex(/^[0-9a-f]{64}$/),
  wavSizeBytes: z.number().int().nonnegative(),
  providerRequestId: z.string().max(200).optional(),
  billingUnits: z.string().max(100).optional(),
  commercialUse: z.literal("unverified"),
  providerTermsUrl: z.url().max(2_048),
  receiptPath: z.string().max(4_096),
  replayed: z.boolean(),
  inspection: AudioInspectionResultSchema,
});

export function createAudioGenerateHandler(generator: AudioGenerator) {
  return async (rawInput: unknown) => {
    try {
      const input = AudioGenerateInputSchema.parse(rawInput);
      const request = withoutUndefined(input);
      return successResult(
        AudioGenerateOutputSchema.parse(
          await generator.generate({
            ...request,
            ...(request.inspection === undefined
              ? {}
              : { inspection: withoutUndefined(request.inspection) }),
          }),
        ),
      );
    } catch (error) {
      return errorResult(error);
    }
  };
}
