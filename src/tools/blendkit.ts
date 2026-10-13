import type { ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";

import { BlendkitError } from "../blendkit/client.js";
import {
  BlendkitImportInputSchema,
  CONVERSION_RECIPE,
  importBlendkitAsset,
  MANUAL_URL,
  type BlendkitImportInput,
  type BlendkitProvider,
} from "../blendkit/provider.js";

export { BlendkitImportInputSchema };
export const BlendkitStatusInputSchema = z.strictObject({});

export const BlendkitStatusOutputSchema = z.object({
  clientUrl: z.string(),
  reachable: z.boolean(),
  clientVersion: z.string().optional(),
  conversionRecipeAvailable: z.boolean(),
  liveAccess: z.enum(["enabled", "disabled"]),
  permissionEvidence: z.string().optional(),
  apiKeyConfigured: z.boolean(),
  blender: z.enum(["configured", "client-stored"]),
  manualUrl: z.string(),
  setup: z.array(z.string()),
});

const InspectionSchema = z.object({
  meshes: z.number().int(),
  vertices: z.number().int(),
  triangles: z.number().int(),
  materials: z.array(
    z.object({
      name: z.string(),
      baseColorTexture: z.boolean(),
      normalTexture: z.boolean(),
      metallicRoughnessTexture: z.boolean(),
    }),
  ),
  textures: z.number().int(),
  sizeMeters: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional(),
  warnings: z.array(z.string()),
});
export const BlendkitImportOutputSchema = z.object({
  glbPath: z.string(),
  provenancePath: z.string(),
  assetId: z.string(),
  sourceUrl: z.string(),
  title: z.string(),
  author: z.string().optional(),
  license: z
    .object({ name: z.string(), url: z.string().optional(), evidence: z.string() })
    .passthrough(),
  purpose: z.enum(["project-use", "redistribution"]),
  redistribution: z.object({ redistributionAllowed: z.literal(false), restriction: z.string() }),
  output: z.object({ file: z.string(), bytes: z.number().int(), sha256: z.string() }),
  inspection: InspectionSchema,
  warnings: z.array(z.string().max(1000)).max(8),
});

function failure(error: unknown) {
  const output =
    error instanceof BlendkitError
      ? { code: error.code, message: error.message.slice(0, 1000) }
      : error instanceof z.ZodError
        ? { code: "BLENDKIT_INVALID_INPUT", message: "Invalid input." }
        : {
            code: "BLENDKIT_REQUEST_FAILED",
            message: "The Blendkit request could not be completed safely.",
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

/** Local-only: reads the Client's version and recipes, never the provider. */
export function createBlendkitStatusHandler(provider: BlendkitProvider) {
  return async (_input: unknown, context?: ServerContext) => {
    const { client, permissionEvidence, apiKey, blenderPath } = provider.options;
    let status: { clientVersion: string; tools: string[] } | undefined;
    try {
      status = await client.status(
        AbortSignal.any([AbortSignal.timeout(5000), ...(context ? [context.mcpReq.signal] : [])]),
      );
    } catch {
      status = undefined;
    }
    const setup = [
      ...(status
        ? []
        : [
            `Start the official Blendkit-Client (https://github.com/BlenderKit/bk_client/releases, GPL-2.0-or-later; check the binary against the sha256 in the release manifest.json), or open Blender with the Blendkit add-on, which starts it. It must listen on ${client.origin}, or set BLENDKIT_CLIENT_URL to its loopback address.`,
          ]),
      ...(status && !status.tools.includes(CONVERSION_RECIPE)
        ? [`This Client has no ${CONVERSION_RECIPE} recipe; update it to v1.13 or later.`]
        : []),
      ...(blenderPath
        ? []
        : [
            "Set BLENDKIT_BLENDER_PATH to a Blender executable, or let the Blendkit add-on register Blender with the Client.",
          ]),
      ...(permissionEvidence
        ? []
        : [
            `Live search and download stay off until BLENDKIT_PROVIDER_PERMISSION cites documented Blendkit permission for this use. Meanwhile browse ${MANUAL_URL}.`,
          ]),
      ...(apiKey
        ? []
        : [
            "Optional: sign in with the official Blendkit add-on and set your own BLENDKIT_API_KEY. This MCP never signs in.",
          ]),
    ];
    return success(
      BlendkitStatusOutputSchema.parse({
        clientUrl: client.origin,
        reachable: Boolean(status),
        ...(status ? { clientVersion: status.clientVersion } : {}),
        conversionRecipeAvailable: Boolean(status?.tools.includes(CONVERSION_RECIPE)),
        liveAccess: permissionEvidence ? "enabled" : "disabled",
        ...(permissionEvidence ? { permissionEvidence } : {}),
        apiKeyConfigured: Boolean(apiKey),
        blender: blenderPath ? "configured" : "client-stored",
        manualUrl: MANUAL_URL,
        setup,
      }),
    );
  };
}

export function createBlendkitImportHandler(provider: BlendkitProvider, toolVersion: string) {
  return async (input: BlendkitImportInput, context?: ServerContext) => {
    const progressToken = context?.mcpReq._meta?.progressToken;
    try {
      const result = await importBlendkitAsset(
        provider,
        input,
        AbortSignal.any([
          AbortSignal.timeout(1_800_000),
          ...(context ? [context.mcpReq.signal] : []),
        ]),
        {
          toolVersion,
          ...(progressToken !== undefined && context
            ? {
                onProgress: ({ progress, message }) =>
                  void context.mcpReq
                    .notify({
                      method: "notifications/progress",
                      params: { progressToken, progress, total: 100, message },
                    })
                    .catch(() => undefined),
              }
            : {}),
        },
      );
      return success(BlendkitImportOutputSchema.parse(result));
    } catch (error) {
      return failure(error);
    }
  };
}
