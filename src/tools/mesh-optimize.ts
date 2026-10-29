import { z } from "zod";

import { optimizeMesh, MeshOptimizeError } from "../optimize/mesh.js";

const PathSchema = z.string().min(1).max(4_096);

const GateViewSchema = z.object({
  angle: z.number().int().nonnegative(),
  iou: z.number().min(0).max(1),
  grayDifference: z.number().min(0).max(1),
  passed: z.boolean(),
});

const GateSchema = z.object({
  passed: z.boolean(),
  iou: z.number().min(0).max(1),
  grayDifference: z.number().min(0).max(1),
  views: z.array(GateViewSchema).min(1).max(12),
});

const MeshFileSchema = z.object({
  path: z.string().max(4_096),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  triangles: z.number().int().nonnegative(),
});

export const MeshOptimizeInputSchema = z.object({
  path: PathSchema.describe("Absolute path to a static GLB (no skin or morph targets)."),
  outputPath: PathSchema.optional().describe(
    "Output .glb path. Defaults to <name>.optimized.glb next to the input; never the input itself.",
  ),
  maxTextureSize: z
    .number()
    .int()
    .min(64)
    .max(8_192)
    .default(2_048)
    .describe("Longest texture side kept; larger textures are downscaled in their own format."),
});

export const MeshOptimizeOutputSchema = z.object({
  kept: z.enum(["optimized", "original"]),
  input: MeshFileSchema,
  output: MeshFileSchema.nullable(),
  attempts: z
    .array(
      z.object({
        error: z.number().positive(),
        triangles: z.number().int().nonnegative(),
        bytes: z.number().int().nonnegative(),
        gate: GateSchema,
      }),
    )
    .max(8),
  gate: GateSchema.nullable(),
  previews: z.object({ before: z.string().max(4_096), after: z.string().max(4_096) }).nullable(),
  maxTextureSize: z.number().int().positive(),
});

export function createMeshOptimizeHandler() {
  return async (raw: z.input<typeof MeshOptimizeInputSchema>) => {
    try {
      const input = MeshOptimizeInputSchema.parse(raw);
      const output = MeshOptimizeOutputSchema.parse(
        await optimizeMesh(input.path, {
          ...(input.outputPath ? { outputPath: input.outputPath } : {}),
          maxTextureSize: input.maxTextureSize,
        }),
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
        structuredContent: output,
      };
    } catch (error) {
      const safe =
        error instanceof MeshOptimizeError
          ? { code: error.code, message: error.message, retryable: error.retryable }
          : error instanceof z.ZodError
            ? {
                code: "MESH_OPTIMIZE_INVALID_INPUT",
                message: "The mesh optimization request is invalid.",
                retryable: false,
              }
            : {
                code: "MESH_OPTIMIZE_INTERNAL",
                message: "The asset MCP could not optimize the mesh.",
                retryable: false,
              };
      return {
        isError: true as const,
        content: [{ type: "text" as const, text: JSON.stringify(safe) }],
      };
    }
  };
}
