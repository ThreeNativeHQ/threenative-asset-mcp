import { readFile, realpath } from "node:fs/promises";

import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { z } from "zod";

import { loadRigConfig } from "../config.js";
import { acquireDonor, acquirePinnedSample, type AcquiredSample } from "../rig/acquire.js";
import { RIG_CATALOG_SOURCES, buildAnimationCatalog, type RigClipDescriptor } from "../rig/catalog.js";
import { fitBipedLandmarks, type FittedJoint, type FitOptions } from "../rig/fit.js";
import { publishOutput } from "../rig/publish.js";
import { renderPreview } from "../rig/preview.js";
import { retargetClip } from "../rig/retarget.js";
import { finalizeDocument } from "../rig/export.js";
import { skinDocument } from "../rig/rig.js";
import {
  inspectLocalAsset,
  RIG_LIMITS,
  RigAssetError,
  type InspectedGlb,
  type RigLimits,
} from "../rig/inspect.js";

const PathSchema = z.string().min(1).max(4_096);

const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);

const MeshSchema = z.object({
  name: z.string().max(300),
  primitives: z.number().int().nonnegative(),
  vertices: z.number().int().nonnegative(),
  attributes: z.array(z.string().max(64)).max(64),
  skinned: z.boolean(),
});

const SkinSchema = z.object({
  name: z.string().max(300),
  joints: z.number().int().nonnegative(),
  jointNames: z.array(z.string().max(300)).max(2_048),
  hasInverseBindMatrices: z.boolean(),
});

const AnimationSchema = z.object({
  index: z.number().int().nonnegative(),
  name: z.string().max(300),
  channels: z.number().int().nonnegative(),
  samplers: z.number().int().nonnegative(),
  durationSeconds: z.number().nonnegative().nullable(),
});

const BoneRoleSchema = z.object({
  role: z.string().max(64),
  side: z.enum(["left", "right"]).nullable(),
  joint: z.string().max(300).nullable(),
  candidates: z.array(z.string().max(300)).max(64),
  ambiguous: z.boolean(),
});

const RigReportSchema = z.object({
  meshes: z.array(MeshSchema).max(4_096),
  skins: z.array(SkinSchema).max(64),
  animations: z.array(AnimationSchema).max(1_024),
  materials: z
    .array(
      z.object({
        name: z.string().max(300),
        doubleSided: z.boolean(),
        alphaMode: z.string().max(32),
      }),
    )
    .max(4_096),
  textures: z.number().int().nonnegative(),
  extensionsUsed: z.array(z.string().max(128)).max(256),
  extensionsRequired: z.array(z.string().max(128)).max(256),
  bounds: z.object({ min: Vec3Schema, max: Vec3Schema }).nullable(),
  boneRoles: z.array(BoneRoleSchema).max(128),
  attachmentCandidates: z.array(z.string().max(300)).max(2_048),
});

const InspectedGlbSchema = z.object({
  path: z.string().max(4_096),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  report: RigReportSchema,
});

const ClipSchema = z.object({
  id: z.string().max(400),
  library: z.string().max(64),
  name: z.string().max(300),
  variant: z.enum(["in_place", "root_motion"]),
  entry: z.string().max(4_096),
  entrySha256: z.string().regex(/^[0-9a-f]{64}$/),
  channels: z.number().int().nonnegative(),
  durationSeconds: z.number().nonnegative().nullable(),
  calibration: z.boolean(),
  donor: z.object({
    url: z.url().max(2_048).nullable(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    bytes: z.number().int().nonnegative().nullable(),
  }),
});

const SourceSchema = z.object({
  id: z.string().max(64),
  label: z.string().max(300),
  kind: z.enum(["sample", "library"]),
  license: z.literal("CC0"),
  attributionRequired: z.literal(false),
  sourceUrl: z.url().max(2_048),
  revision: z.string().max(64).nullable(),
  bytes: z.number().int().nonnegative().nullable(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  archives: z
    .array(
      z.object({
        variant: z.enum(["in_place", "root_motion"]),
        archiveEntry: z.string().max(4_096),
      }),
    )
    .max(8),
});

const SampleTargetSchema = z.object({
  sourceId: z.enum(["aether-02", "aether-02-retopo"]).describe("Explicitly acquire a pinned sample into the development cache."),
});

export const AssetInspectRigInputSchema = z.object({
  target: z
    .union([PathSchema, SampleTargetSchema])
    .describe(
      "Absolute path to the humanoid GLB under inspection, or a pinned sample reference to acquire into the development cache.",
    ),
  libraries: z
    .array(PathSchema)
    .max(8)
    .optional()
    .describe("Optional local UAL ZIP archives or GLB libraries used as animation donors."),
});

export const AssetInspectRigOutputSchema = z.object({
  sources: z.array(SourceSchema).max(32),
  target: InspectedGlbSchema,
  acquisition: z
    .object({
      sourceId: z.string().max(64),
      sourceUrl: z.url().max(2_048),
      path: z.string().max(4_096),
      bytes: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      alreadyCached: z.boolean(),
    })
    .nullable(),
  libraries: z
    .array(
      z.object({
        path: z.string().max(4_096),
        bytes: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        entries: z.array(InspectedGlbSchema).max(64),
        clips: z.array(ClipSchema).max(2_048),
      }),
    )
    .max(8),
  catalog: z.array(ClipSchema).max(4_096),
  attachmentCandidates: z.array(z.string().max(300)).max(2_048),
  limits: z.object({
    maxGlbBytes: z.number().int().positive(),
    maxArchiveBytes: z.number().int().positive(),
  }),
});

function sourceOutput(source: (typeof RIG_CATALOG_SOURCES)[number]) {
  return {
    id: source.id,
    label: source.label,
    kind: source.kind,
    license: source.license,
    attributionRequired: source.attributionRequired,
    sourceUrl: source.sourceUrl,
    revision: source.revision ?? null,
    bytes: source.bytes ?? null,
    sha256: source.sha256 ?? null,
    archives: [...(source.archives ?? [])],
  };
}

function libraryIdFor(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const lowered = base.toLowerCase();
  if (lowered.includes("ual1")) return "ual1";
  if (lowered.includes("ual2")) return "ual2";
  return base.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-") || "library";
}

function variantFor(path: string): "in_place" | "root_motion" {
  return /_rm\.(glb|fbx)$/i.test(path) ? "root_motion" : "in_place";
}

export interface AssetInspectRigOptions {
  limits?: RigLimits;
  acquire?: (sourceId: string) => Promise<AcquiredSample>;
}

export function createAssetInspectRigHandler(options: AssetInspectRigOptions = {}) {
  const limits = options.limits ?? RIG_LIMITS;
  const acquire =
    options.acquire ?? ((sourceId: string) => acquirePinnedSample({ sourceId, config: loadRigConfig() }));
  return async (raw: z.input<typeof AssetInspectRigInputSchema>) => {
    try {
      const input = AssetInspectRigInputSchema.parse(raw);
      let targetPath: string;
      let acquisition: {
        sourceId: string;
        sourceUrl: string;
        path: string;
        bytes: number;
        sha256: string;
        alreadyCached: boolean;
      } | null = null;
      if (typeof input.target === "string") {
        targetPath = input.target;
      } else {
        const acquired = await acquire(input.target.sourceId);
        targetPath = acquired.path;
        acquisition = { sourceId: input.target.sourceId, ...acquired };
      }
      const target = await inspectLocalAsset(targetPath, limits);
      if (target.kind !== "glb") {
        throw new RigAssetError(
          "RIG_INVALID_INPUT",
          "The target must be a GLB, not an archive.",
        );
      }

      const libraries: Array<{
        path: string;
        bytes: number;
        sha256: string;
        entries: InspectedGlb[];
        clips: RigClipDescriptor[];
      }> = [];
      const catalog: RigClipDescriptor[] = [];

      for (const libraryPath of input.libraries ?? []) {
        const inspected = await inspectLocalAsset(libraryPath, limits);
        const library =
          inspected.kind === "archive"
            ? inspected.library
            : {
                path: inspected.glb.path,
                bytes: inspected.glb.bytes,
                sha256: inspected.glb.sha256,
                entries: [inspected.glb],
              };
        const clips = library.entries.flatMap((entry) => {
          const variant = variantFor(entry.path);
          return buildAnimationCatalog({
            libraryId: libraryIdFor(entry.path),
            variant,
            entryPath: entry.path,
            entrySha256: entry.sha256,
            animations: entry.report.animations,
          });
        });
        libraries.push({ ...library, clips });
        catalog.push(...clips);
      }

      const output = AssetInspectRigOutputSchema.parse({
        sources: RIG_CATALOG_SOURCES.map(sourceOutput),
        target: {
          path: target.glb.path,
          bytes: target.glb.bytes,
          sha256: target.glb.sha256,
          report: target.glb.report,
        },
        acquisition,
        libraries,
        catalog,
        attachmentCandidates: target.glb.report.attachmentCandidates,
        limits: {
          maxGlbBytes: limits.maxGlbBytes,
          maxArchiveBytes: limits.maxArchiveBytes,
        },
      });

      return {
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
        structuredContent: output,
      };
    } catch (error) {
      const safe =
        error instanceof RigAssetError
          ? { code: error.code, message: error.message, retryable: error.retryable }
          : error instanceof z.ZodError
            ? {
                code: "RIG_INVALID_INPUT",
                message: "The rig inspection request is invalid.",
                retryable: false,
              }
            : {
                code: "RIG_INTERNAL",
                message: "The asset MCP could not complete the rig inspection.",
                retryable: false,
              };
      return {
        isError: true as const,
        content: [{ type: "text" as const, text: JSON.stringify(safe) }],
      };
    }
  };
}

const AxisSchema = z.enum(["x", "y", "z"]);
const JointPositionSchema = z.object({
  name: z.string().max(64),
  parent: z.string().max(64).nullable(),
  position: Vec3Schema,
  inferred: z.boolean(),
  ambiguous: z.boolean(),
});

export const AssetAutoRigInputSchema = z.object({
  target: PathSchema.describe("Absolute path to an unrigged humanoid GLB."),
  output: PathSchema.describe("Output .glb path under projectRoot."),
  projectRoot: PathSchema.describe("Project root that must contain the output."),
  weightMode: z.enum(["smooth", "rigid"]).default("smooth"),
  replaceRig: z.boolean().default(false),
  maxInfluences: z.number().int().min(1).max(4).optional(),
  priorDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  overrides: z.record(z.string().max(64), Vec3Schema).optional(),
  orientation: z
    .object({
      up: AxisSchema.optional(),
      arm: AxisSchema.optional(),
      facing: AxisSchema.optional(),
      facingSign: z.union([z.literal(1), z.literal(-1)]).optional(),
    })
    .optional(),
});

export const AssetAutoRigOutputSchema = z.object({
  status: z.enum(["rigged", "needs-landmarks"]),
  target: z.string().max(4_096),
  output: z.string().max(4_096).nullable(),
  bytes: z.number().int().nonnegative().nullable(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  replaced: z.boolean(),
  alreadyExisted: z.boolean(),
  weightMode: z.enum(["smooth", "rigid"]),
  joints: z.number().int().nonnegative(),
  skinnedVertices: z.number().int().nonnegative(),
  maxInfluences: z.number().int().nonnegative(),
  maxNormalizationError: z.number().nonnegative(),
  diagnostics: z.object({
    finite: z.boolean(),
    nonNegative: z.boolean(),
    validJoints: z.boolean(),
  }),
  ambiguities: z.array(z.string().max(400)).max(32),
  landmarks: z.array(JointPositionSchema).max(64),
  orientation: z.object({
    up: AxisSchema,
    arm: AxisSchema,
    facing: AxisSchema,
    facingSign: z.union([z.literal(1), z.literal(-1)]),
  }),
  measure: z.object({
    height: z.number().nonnegative(),
    armSpan: z.number().nonnegative(),
    facingExtent: z.number().nonnegative(),
    armSpreadRatio: z.number().nonnegative(),
    legSeparationRatio: z.number().nonnegative(),
  }),
});

const autoRigIo = new NodeIO().registerExtensions(ALL_EXTENSIONS);

async function readTargetDocument(path: string, limits: RigLimits): Promise<Document> {
  const resolved = await realpath(path).catch(() => null);
  if (!resolved) throw new RigAssetError("RIG_INVALID_INPUT", `No readable file at ${path}.`);
  const bytes = new Uint8Array(await readFile(resolved));
  if (bytes.byteLength > limits.maxGlbBytes) {
    throw new RigAssetError("RIG_INPUT_TOO_LARGE", `${path} is over the GLB byte limit.`);
  }
  try {
    return await autoRigIo.readBinary(bytes);
  } catch {
    throw new RigAssetError("RIG_INVALID_GLTF", `${path} is not a readable GLB asset.`);
  }
}

function collectPositions(document: Document, limits: RigLimits): Float32Array {
  const chunks: Float32Array[] = [];
  let total = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const array = primitive.getAttribute("POSITION")?.getArray();
      if (!array) continue;
      const positions = array instanceof Float32Array ? array : Float32Array.from(array);
      total += positions.length;
      if (total / 3 > limits.maxVertices) {
        throw new RigAssetError("RIG_LIMIT_EXCEEDED", "The model is over the vertex limit.");
      }
      chunks.push(positions);
    }
  }
  const merged = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

export function createAssetAutoRigHandler(options: { limits?: RigLimits } = {}) {
  const limits = options.limits ?? RIG_LIMITS;
  return async (raw: z.input<typeof AssetAutoRigInputSchema>) => {
    try {
      const input = AssetAutoRigInputSchema.parse(raw);
      const document = await readTargetDocument(input.target, limits);
      if (document.getRoot().listSkins().length > 0 && !input.replaceRig) {
        throw new RigAssetError(
          "RIG_INVALID_INPUT",
          "The target already has a rig; pass replaceRig to replace it.",
        );
      }
      const positions = collectPositions(document, limits);
      const fitOptions: FitOptions = {};
      if (input.orientation?.up) fitOptions.up = input.orientation.up;
      if (input.orientation?.arm) fitOptions.arm = input.orientation.arm;
      if (input.orientation?.facing) fitOptions.facing = input.orientation.facing;
      if (input.orientation?.facingSign) fitOptions.facingSign = input.orientation.facingSign;
      if (input.overrides) {
        fitOptions.overrides = input.overrides as Record<string, [number, number, number]>;
      }
      const fit = fitBipedLandmarks(positions, fitOptions);
      if (fit.ambiguities.length > 0 && !input.overrides) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "needs-landmarks",
                ambiguities: fit.ambiguities,
                landmarks: fit.joints,
              }),
            },
          ],
          structuredContent: AssetAutoRigOutputSchema.parse({
            status: "needs-landmarks",
            target: input.target,
            output: null,
            bytes: null,
            sha256: null,
            replaced: false,
            alreadyExisted: false,
            weightMode: input.weightMode,
            joints: fit.joints.length,
            skinnedVertices: 0,
            maxInfluences: 0,
            maxNormalizationError: 0,
            diagnostics: { finite: true, nonNegative: true, validJoints: true },
            ambiguities: fit.ambiguities,
            landmarks: fit.joints,
            orientation: fit.orientation,
            measure: fit.measure,
          }),
        };
      }

      const diagnostics = skinDocument(document, fit.joints as FittedJoint[], {
        weightMode: input.weightMode,
        ...(input.maxInfluences ? { maxInfluences: input.maxInfluences } : {}),
      });
      const bytes = await autoRigIo.writeBinary(document);
      const published = await publishOutput({
        projectRoot: input.projectRoot,
        outputPath: input.output,
        bytes,
        ...(input.priorDigest ? { priorDigest: input.priorDigest } : {}),
      });

      const output = AssetAutoRigOutputSchema.parse({
        status: "rigged",
        target: input.target,
        output: published.path,
        bytes: published.bytes,
        sha256: published.sha256,
        replaced: published.replaced,
        alreadyExisted: published.alreadyExisted,
        weightMode: diagnostics.weightMode,
        joints: diagnostics.joints,
        skinnedVertices: diagnostics.skinnedVertices,
        maxInfluences: diagnostics.maxInfluences,
        maxNormalizationError: diagnostics.maxNormalizationError,
        diagnostics: {
          finite: diagnostics.finite,
          nonNegative: diagnostics.nonNegative,
          validJoints: diagnostics.validJoints,
        },
        ambiguities: fit.ambiguities,
        landmarks: fit.joints,
        orientation: fit.orientation,
        measure: fit.measure,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
        structuredContent: output,
      };
    } catch (error) {
      const safe =
        error instanceof RigAssetError
          ? { code: error.code, message: error.message, retryable: error.retryable }
          : error instanceof z.ZodError
            ? { code: "RIG_INVALID_INPUT", message: "The auto-rig request is invalid.", retryable: false }
            : { code: "RIG_INTERNAL", message: "The asset MCP could not complete the auto-rig.", retryable: false };
      return {
        isError: true as const,
        content: [{ type: "text" as const, text: JSON.stringify(safe) }],
      };
    }
  };
}

export const AssetPreviewAnimationInputSchema = z.object({
  prepared: PathSchema.describe("Absolute path to a prepared (rigged or retargeted) GLB."),
  output: PathSchema.describe("Output contact-sheet .png path under projectRoot."),
  projectRoot: PathSchema.describe("Project root that must contain the output."),
  clip: z.string().max(300).optional(),
  times: z.array(z.number().nonnegative()).min(1).max(12).optional(),
  pose: z
    .object({
      bone: z.string().max(64),
      axis: z.enum(["x", "y", "z"]),
      degrees: z.number().min(-360).max(360),
    })
    .optional(),
  focus: z
    .object({
      bone: z.string().max(64),
      distance: z.number().positive().max(1_000).optional(),
    })
    .optional()
    .describe("Frame the camera on this bone and its descendant bones, e.g. a hand with its fingers."),
  angles: z.number().int().min(2).max(6).default(3),
  width: z.number().int().min(64).max(1024).default(384),
  height: z.number().int().min(64).max(1024).default(384),
  priorDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

export const AssetPreviewAnimationOutputSchema = z.object({
  status: z.enum(["rendered", "unavailable"]),
  reason: z.string().max(400).nullable(),
  backend: z.string().max(200).nullable(),
  output: z.string().max(4_096).nullable(),
  contactSheetSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  images: z
    .array(
      z.object({
        time: z.number().nonnegative(),
        angle: z.number().int().nonnegative(),
        nonBlank: z.boolean(),
        mean: z.number(),
        std: z.number(),
      }),
    )
    .max(72),
  canvas: z
    .object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      columns: z.number().int().positive(),
      rows: z.number().int().positive(),
    })
    .nullable(),
  bounds: z.object({ min: Vec3Schema, max: Vec3Schema }).nullable(),
  animations: z.array(z.string().max(300)).max(64),
  tracks: z.number().int().nonnegative(),
  boundTracks: z.number().int().nonnegative(),
  sampledTimes: z.array(z.number().nonnegative()).max(12),
});

export function createAssetPreviewAnimationHandler(options: { limits?: RigLimits } = {}) {
  const limits = options.limits ?? RIG_LIMITS;
  return async (raw: z.input<typeof AssetPreviewAnimationInputSchema>) => {
    try {
      const input = AssetPreviewAnimationInputSchema.parse(raw);
      const resolved = await realpath(input.prepared).catch(() => null);
      if (!resolved) {
        throw new RigAssetError("RIG_INVALID_INPUT", `No readable file at ${input.prepared}.`);
      }
      const bytes = new Uint8Array(await readFile(resolved));
      if (bytes.byteLength > limits.maxGlbBytes) {
        throw new RigAssetError("RIG_INPUT_TOO_LARGE", "The prepared GLB is over the byte limit.");
      }
      const times = input.times ?? [0];
      let preview;
      try {
        preview = await renderPreview(bytes, {
          ...(input.clip ? { clipName: input.clip } : {}),
          times,
          ...(input.pose ? { pose: input.pose } : {}),
          ...(input.focus ? { focus: input.focus } : {}),
          angles: input.angles,
          width: input.width,
          height: input.height,
        });
      } catch (error) {
        if (error instanceof RigAssetError && error.code === "RIG_PREVIEW_UNAVAILABLE") {
          const unavailable = AssetPreviewAnimationOutputSchema.parse({
            status: "unavailable",
            reason: error.message,
            backend: null,
            output: null,
            contactSheetSha256: null,
            images: [],
            canvas: null,
            bounds: null,
            animations: [],
            tracks: 0,
            boundTracks: 0,
            sampledTimes: times,
          });
          return {
            content: [{ type: "text" as const, text: JSON.stringify(unavailable) }],
            structuredContent: unavailable,
          };
        }
        throw error;
      }

      const published = await publishOutput({
        projectRoot: input.projectRoot,
        outputPath: input.output,
        bytes: preview.contactSheet,
        extension: ".png",
        ...(input.priorDigest ? { priorDigest: input.priorDigest } : {}),
      });
      const output = AssetPreviewAnimationOutputSchema.parse({
        status: "rendered",
        reason: null,
        backend: preview.backend,
        output: published.path,
        contactSheetSha256: published.sha256,
        images: preview.images.map((image) => ({
          time: image.time,
          angle: image.angle,
          nonBlank: image.nonBlank,
          mean: image.mean,
          std: image.std,
        })),
        canvas: preview.canvas,
        bounds: preview.bounds,
        animations: preview.animations,
        tracks: preview.tracks,
        boundTracks: preview.boundTracks,
        sampledTimes: preview.sampledTimes,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
        structuredContent: output,
      };
    } catch (error) {
      const safe =
        error instanceof RigAssetError
          ? { code: error.code, message: error.message, retryable: error.retryable }
          : error instanceof z.ZodError
            ? { code: "RIG_INVALID_INPUT", message: "The preview request is invalid.", retryable: false }
            : { code: "RIG_INTERNAL", message: "The asset MCP could not complete the preview.", retryable: false };
      return {
        isError: true as const,
        content: [{ type: "text" as const, text: JSON.stringify(safe) }],
      };
    }
  };
}

const ClipSelectionSchema = z.object({
  id: z.string().min(1).max(300).describe("Pinned donor clip id, e.g. ual1/Walk_Loop."),
  variant: z.enum(["in_place", "root_motion"]).describe("Which donor variant to retarget."),
});

export const AssetRetargetAnimationsInputSchema = z.object({
  target: PathSchema.describe("Absolute path to the prepared target GLB (e.g. the AETHER sample)."),
  output: PathSchema.describe("Output .glb path under projectRoot."),
  projectRoot: PathSchema.describe("Project root that must contain the output."),
  clips: z.array(ClipSelectionSchema).min(1).max(24),
  keepExistingClips: z.boolean().default(true),
  mapping: z.record(z.string().max(64), z.string().max(64)).optional(),
  priorDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

export const AssetRetargetAnimationsOutputSchema = z.object({
  status: z.literal("retargeted"),
  output: z.string().max(4_096),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  replaced: z.boolean(),
  alreadyExisted: z.boolean(),
  keepExistingClips: z.boolean(),
  animationBytes: z.number().int().nonnegative(),
  meshTextureBytes: z.number().int().nonnegative(),
  animationCount: z.number().int().nonnegative(),
  clips: z
    .array(
      z.object({
        id: z.string().max(300),
        variant: z.enum(["in_place", "root_motion"]),
        durationSeconds: z.number().nonnegative(),
        frames: z.number().int().positive(),
        jointTracks: z.number().int().positive(),
        rootDisplacement: z.number().nonnegative(),
        omittedRoles: z.array(z.string().max(120)).max(1_024),
      }),
    )
    .max(24),
  mapping: z
    .array(
      z.object({
        role: z.string().max(64),
        side: z.enum(["left", "right"]).nullable(),
        target: z.string().max(64),
        source: z.string().max(64),
      }),
    )
    .max(128),
});

export interface AssetRetargetOptions {
  limits?: RigLimits;
  config?: ReturnType<typeof loadRigConfig>;
  loadDonor?: (clipId: string, variant: "in_place" | "root_motion") => Promise<Document>;
}

export function createAssetRetargetAnimationsHandler(options: AssetRetargetOptions = {}) {
  const limits = options.limits ?? RIG_LIMITS;
  const loadDonor =
    options.loadDonor ??
    (async (clipId: string, variant: "in_place" | "root_motion") => {
      const acquired = await acquireDonor({
        clipId,
        variant,
        config: options.config ?? loadRigConfig(),
      });
      return autoRigIo.readBinary(new Uint8Array(await readFile(acquired.path)));
    });
  return async (raw: z.input<typeof AssetRetargetAnimationsInputSchema>) => {
    try {
      const input = AssetRetargetAnimationsInputSchema.parse(raw);
      const target = await readTargetDocument(input.target, limits);
      if (target.getRoot().listSkins().length === 0) {
        throw new RigAssetError("RIG_INVALID_INPUT", "The retarget target has no skeleton.");
      }
      const clipReports: Array<{
        id: string;
        variant: "in_place" | "root_motion";
        durationSeconds: number;
        frames: number;
        jointTracks: number;
        rootDisplacement: number;
        omittedRoles: string[];
      }> = [];
      let lastMapping: Awaited<ReturnType<typeof retargetClip>>["mapping"] = [];
      for (const clip of input.clips) {
        const donor = await loadDonor(clip.id, clip.variant);
        const result = await retargetClip(donor, target, {
          clipName: clip.id,
          rootMotion: clip.variant === "root_motion",
          ...(input.mapping ? { mapping: input.mapping } : {}),
        });
        lastMapping = result.mapping;
        clipReports.push({
          id: result.clipName,
          variant: clip.variant,
          durationSeconds: result.durationSeconds,
          frames: result.frames,
          jointTracks: result.jointTracks,
          rootDisplacement: result.rootDisplacement,
          omittedRoles: result.omittedRoles,
        });
      }
      const { bytes, report } = await finalizeDocument(target, {
        keepExistingClips: input.keepExistingClips,
        addedClipNames: input.clips.map((clip) => clip.id),
      });
      const published = await publishOutput({
        projectRoot: input.projectRoot,
        outputPath: input.output,
        bytes,
        ...(input.priorDigest ? { priorDigest: input.priorDigest } : {}),
      });
      const output = AssetRetargetAnimationsOutputSchema.parse({
        status: "retargeted",
        output: published.path,
        bytes: published.bytes,
        sha256: published.sha256,
        replaced: published.replaced,
        alreadyExisted: published.alreadyExisted,
        keepExistingClips: input.keepExistingClips,
        animationBytes: report.animationBytes,
        meshTextureBytes: report.meshTextureBytes,
        animationCount: report.animationCount,
        clips: clipReports,
        mapping: lastMapping,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
        structuredContent: output,
      };
    } catch (error) {
      const safe =
        error instanceof RigAssetError
          ? { code: error.code, message: error.message, retryable: error.retryable }
          : error instanceof z.ZodError
            ? { code: "RIG_INVALID_INPUT", message: "The retarget request is invalid.", retryable: false }
            : { code: "RIG_INTERNAL", message: "The asset MCP could not complete the retarget.", retryable: false };
      return {
        isError: true as const,
        content: [{ type: "text" as const, text: JSON.stringify(safe) }],
      };
    }
  };
}
