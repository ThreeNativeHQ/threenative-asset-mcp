import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, join, resolve, sep } from "node:path";

import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { getBounds } from "@gltf-transform/functions";
import { z } from "zod";

import {
  assetId,
  AssetSchema,
  type Asset,
  type AssetAdapter,
  type AssetDetail,
} from "../discovery/types.js";
import {
  BlendkitClient,
  BlendkitError,
  DEFAULT_CLIENT_URL,
  UnconfirmedStopError,
  type TaskProgress,
} from "./client.js";

export const PROVIDER = "blendkit";
export const PRODUCTION_SERVER = "https://www.blendkit.com";
export const MANUAL_URL = "https://www.blendkit.com/asset-gallery";
export const TERMS_URL = "https://www.blendkit.com/terms-and-conditions-2026/";
export const LICENSES_URL = "https://www.blendkit.com/docs/licenses/";
/** The only recipe this MCP asks the Client to run: its bundled .blend -> GLB exporter. */
export const CONVERSION_RECIPE = "export_glb";
const CONVERSION_PARAMS = { yup: true, draco: false, export_apply: true } as const;
const PRODUCTION_ORIGINS = [
  "https://www.blendkit.com",
  "https://blendkit.com",
  "https://www.blenderkit.com",
  "https://blenderkit.com",
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export const RESOLUTIONS = [
  "ORIGINAL",
  "resolution_0_5K",
  "resolution_1K",
  "resolution_2K",
  "resolution_4K",
  "resolution_8K",
] as const;
const TYPES: Record<string, Asset["type"]> = {
  model: "3d-model",
  material: "texture",
  hdr: "hdri",
};

export type BlendkitConfig = {
  /** Documented provider permission for this use; without it live search/download stays off. */
  permissionEvidence?: string;
  /** The user's own API key from the official login flow; sent only to the loopback Client. */
  apiKey?: string;
  clientUrl: string;
  /** Empty: the Client uses the Blender executable an add-on registered with it. */
  blenderPath: string;
};

export function blendkitConfig(env: NodeJS.ProcessEnv = process.env): BlendkitConfig {
  const permission = env.BLENDKIT_PROVIDER_PERMISSION?.trim();
  if (permission && (permission.length < 10 || permission.length > 500))
    throw new Error(
      "BLENDKIT_PROVIDER_PERMISSION must cite the permission evidence in 10-500 characters.",
    );
  const blenderPath = env.BLENDKIT_BLENDER_PATH?.trim() ?? "";
  if (blenderPath && !isAbsolute(blenderPath))
    throw new Error("BLENDKIT_BLENDER_PATH must be an absolute path.");
  return {
    ...(permission ? { permissionEvidence: permission } : {}),
    ...(env.BLENDKIT_API_KEY?.trim() ? { apiKey: env.BLENDKIT_API_KEY.trim() } : {}),
    clientUrl: env.BLENDKIT_CLIENT_URL?.trim() || DEFAULT_CLIENT_URL,
    blenderPath,
  };
}

export function permissionRequired(): BlendkitError {
  return new BlendkitError(
    "BLENDKIT_PERMISSION_REQUIRED",
    "Live Blendkit search and download through this MCP are off: no documented provider permission for " +
      "third-party agent use is configured (BLENDKIT_PROVIDER_PERMISSION). Browse " +
      MANUAL_URL +
      " and use the official Blendkit add-on instead.",
  );
}

const text = (max: number) =>
  z.string().transform((value) =>
    value
      .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
      .trim()
      .slice(0, max),
  );
/** Provider metadata is untrusted: only these fields are read, each bounded. */
const RawAssetSchema = z.object({
  id: z.string().regex(UUID),
  assetBaseId: z.string().regex(UUID),
  name: text(500).pipe(z.string().min(1)),
  assetType: z.string().max(40),
  isFree: z.boolean(),
  canDownload: z.boolean().optional(),
  canDownloadError: z.unknown().optional(),
  license: z.string().max(40).optional(),
  author: z.object({ fullName: text(200).optional() }).nullish(),
  thumbnailMiddleUrl: z.string().max(2048).nullish(),
  files: z
    .array(
      z.object({
        fileType: z.string().max(40),
        downloadUrl: z.string().max(2048).nullish(),
        fileUploadSize: z.number().int().nonnegative().nullish(),
      }),
    )
    .max(64)
    .default([]),
});
export type BlendkitAsset = z.infer<typeof RawAssetSchema>;

export function licenseOf(raw: string | undefined): Asset["license"] {
  if (raw === "cc_zero")
    return {
      name: "CC0 1.0",
      url: "https://creativecommons.org/publicdomain/zero/1.0/",
      evidence:
        `Blendkit item license field "cc_zero"; terms ${TERMS_URL} (effective 2026-06-12) apply the project-only, ` +
        "no-open-format-embedding rules to CC0 items too. The label alone grants no shipping rights.",
      commercialUse: "yes",
      attributionRequired: "no",
    };
  if (raw === "royalty_free")
    return {
      name: "Blendkit Royalty Free",
      url: LICENSES_URL,
      evidence:
        `Blendkit item license field "royalty_free"; terms ${TERMS_URL} (effective 2026-06-12) art. 5: ` +
        "use only incorporated in a project, no stand-alone redistribution, and software may not embed open-format 3D models.",
      commercialUse: "yes",
      attributionRequired: "no",
    };
  return {
    name: "Unknown item rights",
    evidence: "The Blendkit item carries no recognised license type.",
    commercialUse: "unknown",
    attributionRequired: "unknown",
  };
}

export type Purpose = "project-use" | "redistribution";
export type RightsDecision = { redistributionAllowed: false; restriction: string };

/**
 * Raw redistribution is refused for every Blendkit item in this release. A CC0 label is not
 * enough: the Terms' CC0 clause applies the project-only rules "accordingly", and no independent
 * per-asset rights or separate permission is recorded here.
 */
export function redistributionDenied(): BlendkitError {
  return new BlendkitError(
    "BLENDKIT_LICENSE_DENIED",
    "Raw redistribution of Blendkit assets (files, game builds, demos, starter kits) is refused for every " +
      "item, CC0 included: the Blendkit Terms apply their project-only, no-open-format-embedding rules to CC0 " +
      "items too, and no independent rights or separate permission is recorded. Use purpose project-use.",
  );
}

/**
 * Per-asset rights gate. Acquisition always needs the caller's explicit project-use consent, and
 * a download is never redistribution rights, whatever the item's license label says.
 */
export function rightsDecision(
  license: string | undefined,
  purpose: Purpose,
  projectUseConsent: boolean,
): RightsDecision {
  if (purpose === "redistribution") throw redistributionDenied();
  if (license !== "cc_zero" && license !== "royalty_free")
    throw new BlendkitError(
      "BLENDKIT_LICENSE_DENIED",
      "The item's license is unknown, so it cannot be acquired; check it on the provider page.",
    );
  if (!projectUseConsent)
    throw new BlendkitError(
      "BLENDKIT_CONSENT_REQUIRED",
      "Set projectUseConsent: true to confirm this one item is acquired for your own project under its license.",
    );
  return {
    redistributionAllowed: false,
    restriction:
      (license === "cc_zero"
        ? "CC0 label does not grant shipping rights: the Blendkit Terms apply the project-only rules to CC0 items. "
        : "Royalty Free: private use only. ") +
      "The Terms forbid embedding open-format models such as GLB in software, so do not ship this file in a " +
      "game build, commit or publish it, or use it in demos or starter kits without independently verified rights.",
  };
}

export type BlendkitProviderOptions = BlendkitConfig & {
  client: BlendkitClient;
  /** Provider API origin the Client is asked to query. Tests point it at a local stand-in. */
  server?: string;
  addonVersion?: string;
};

export class BlendkitProvider implements AssetAdapter {
  readonly id = PROVIDER;
  readonly server: string;
  private readonly downloadOrigins: Set<string>;
  constructor(readonly options: BlendkitProviderOptions) {
    const server = new URL(options.server ?? PRODUCTION_SERVER);
    const loopback =
      server.protocol === "http:" && ["127.0.0.1", "localhost"].includes(server.hostname);
    if ((server.protocol !== "https:" && !loopback) || server.username || server.password)
      throw new Error("Invalid Blendkit provider server.");
    this.server = server.origin;
    this.downloadOrigins = new Set(
      this.server === PRODUCTION_SERVER ? PRODUCTION_ORIGINS : [this.server],
    );
  }

  private gate(): void {
    if (!this.options.permissionEvidence) throw permissionRequired();
  }

  private searchUrl(query: string, pageSize: number): string {
    return `${this.server}/api/v1/search/?query=${query}&dict_parameters=1&page_size=${pageSize}&addon_version=${encodeURIComponent(this.options.addonVersion ?? "0.0.0")}`;
  }

  private async query(
    url: string,
    pageSize: number,
    signal: AbortSignal,
  ): Promise<BlendkitAsset[]> {
    const result = (await this.options.client.search(
      url,
      pageSize,
      this.options.apiKey ?? "",
      signal,
    )) as {
      results?: unknown;
    };
    if (!Array.isArray(result?.results))
      throw new BlendkitError(
        "BLENDKIT_INVALID_RESPONSE",
        "Blendkit search returned no result list.",
      );
    return result.results.slice(0, pageSize).flatMap((item) => {
      const parsed = RawAssetSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    });
  }

  toAsset(item: BlendkitAsset, rank = 0): Asset | undefined {
    const type = TYPES[item.assetType];
    if (!type) return undefined;
    const thumbnail = item.thumbnailMiddleUrl?.startsWith("https://")
      ? item.thumbnailMiddleUrl
      : undefined;
    return AssetSchema.parse({
      assetId: assetId(PROVIDER, item.id),
      provider: PROVIDER,
      nativeId: item.id,
      sourceUrl: `${PRODUCTION_SERVER}/asset-gallery-detail/${item.assetBaseId}/`,
      title: item.name,
      type,
      itemKind: "asset",
      free: item.isFree ? "yes" : "no",
      license: licenseOf(item.license),
      ...(item.author?.fullName ? { author: item.author.fullName } : {}),
      ...(thumbnail && URL.canParse(thumbnail) ? { thumbnailUrl: thumbnail } : {}),
      downloadStatus: item.isFree ? "manual" : "unsupported",
      downloadReason: item.isFree
        ? "Acquire one item at a time with blendkit_import_asset (explicit license and project-use consent)."
        : "Paid (Full Plan) item: this MCP never acquires paid assets.",
      canDownloadNow: false,
      providerRank: rank,
      rankingFactors: [],
    });
  }

  async search(query: string, types: Asset["type"][], limit: number, signal: AbortSignal) {
    this.gate();
    // Provider query syntax uses ':' filters; keep only words so a query cannot add filters.
    const words = query
      .replace(/[^\p{L}\p{N}\s_-]+/gu, " ")
      .split(/\s+/u)
      .filter(Boolean)
      .map(encodeURIComponent);
    const pageSize = Math.min(limit, 20);
    const items: Asset[] = [];
    for (const [native, type] of Object.entries(TYPES)) {
      if (!types.includes(type)) continue;
      const tokens = [...words, `asset_type:${native}`, "is_free:true"];
      if (native === "model") tokens.push("sexualizedContent:false");
      tokens.push("order:_score");
      for (const item of await this.query(
        this.searchUrl(tokens.join("+"), pageSize),
        pageSize,
        signal,
      )) {
        const asset = this.toAsset(item, items.length);
        if (asset) items.push(asset);
      }
    }
    return { items, truncated: items.length >= pageSize };
  }

  async lookup(nativeId: string, signal: AbortSignal): Promise<BlendkitAsset> {
    this.gate();
    if (!UUID.test(nativeId))
      throw new BlendkitError("BLENDKIT_INVALID_INPUT", "A Blendkit asset id is a lowercase UUID.");
    const [item] = await this.query(this.searchUrl(`asset_id:${nativeId}`, 1), 1, signal);
    if (!item || item.id !== nativeId)
      throw new BlendkitError("BLENDKIT_NOT_FOUND", "No Blendkit asset has that id.");
    return item;
  }

  async get(nativeId: string, _selection: unknown, signal: AbortSignal): Promise<AssetDetail> {
    const item = await this.lookup(nativeId, signal);
    const asset = this.toAsset(item);
    if (!asset) throw new BlendkitError("BLENDKIT_UNSUPPORTED", "Unsupported Blendkit asset type.");
    return {
      asset,
      files: [],
      selectedVariant: "none",
      selectionExplanation: asset.downloadReason,
      alternatives: ["blendkit_import_asset", asset.sourceUrl],
      termsText: asset.license.evidence,
      providerDetails: { license: item.license ?? "unknown", acquireWith: "blendkit_import_asset" },
    };
  }

  /** Only downloadable source variants on the provider's own API, with their download links. */
  eligibleFiles(item: BlendkitAsset, maxBytes: number) {
    return item.files.flatMap((file) => {
      // zip_file is skipped: the Client extracts archives without confining entry paths.
      if (file.fileType !== "blend" && !/^resolution_(0_5|1|2|4|8)K$/u.test(file.fileType))
        return [];
      if (!file.downloadUrl || !URL.canParse(file.downloadUrl)) return [];
      const url = new URL(file.downloadUrl);
      if (
        !this.downloadOrigins.has(url.origin) ||
        !/^\/api\/v1\/downloads?\//u.test(url.pathname) ||
        url.username ||
        url.password ||
        (file.fileUploadSize ?? 0) > maxBytes
      )
        return [];
      return [
        {
          fileType: file.fileType,
          downloadUrl: url.href,
          fileUploadSize: file.fileUploadSize ?? 0,
        },
      ];
    });
  }
}

export const BlendkitImportInputSchema = z.strictObject({
  assetId: z
    .string()
    .regex(/^blendkit:[0-9a-f-]{36}$/u)
    .describe("asset_search/asset_get id, blendkit:<uuid>."),
  outputDir: z
    .string()
    .trim()
    .min(1)
    .max(4096)
    .describe(
      "Private directory for the GLB and its provenance file. Keep the output out of version control and game builds.",
    ),
  purpose: z
    .enum(["project-use", "redistribution"])
    .describe(
      "project-use: your own project, files kept private. redistribution is always refused in this release, for CC0 items too.",
    ),
  acceptLicense: z
    .literal(true)
    .describe("Acknowledge this item's license as reported by asset_get."),
  projectUseConsent: z
    .boolean()
    .describe("true confirms this single item is acquired for your own project. Required."),
  resolution: z.enum(RESOLUTIONS).default("resolution_2K"),
  maxBytes: z
    .number()
    .int()
    .positive()
    .max(4 * 1024 ** 3)
    .default(1024 ** 3),
});
export type BlendkitImportInput = z.input<typeof BlendkitImportInputSchema>;

async function sha256File(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

/** Structure, PBR texture slots, polygon count and size of a written GLB. */
export async function inspectGlb(path: string) {
  const root = (await new NodeIO().registerExtensions(ALL_EXTENSIONS).read(path)).getRoot();
  let triangles = 0;
  let vertices = 0;
  for (const mesh of root.listMeshes())
    for (const primitive of mesh.listPrimitives()) {
      const count =
        primitive.getIndices()?.getCount() ?? primitive.getAttribute("POSITION")?.getCount() ?? 0;
      vertices += primitive.getAttribute("POSITION")?.getCount() ?? 0;
      if (primitive.getMode() === 4) triangles += Math.floor(count / 3);
    }
  const materials = root.listMaterials().map((material) => ({
    name: material.getName().slice(0, 200),
    baseColorTexture: Boolean(material.getBaseColorTexture()),
    normalTexture: Boolean(material.getNormalTexture()),
    metallicRoughnessTexture: Boolean(material.getMetallicRoughnessTexture()),
  }));
  const textures = root.listTextures();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  const bounds = scene ? getBounds(scene) : undefined;
  const size = bounds ? bounds.max.map((max, axis) => max - bounds.min[axis]!) : [];
  const warnings = [
    ...materials
      .filter((m) => !m.baseColorTexture)
      .map((m) => `Material "${m.name}" has no base colour texture.`),
    ...(textures.some((texture) => !texture.getImage()?.byteLength)
      ? ["A texture has no image data."]
      : []),
    ...(size.length === 3 && size.every(Number.isFinite) && Math.max(...size) > 100
      ? ["Largest side exceeds 100 units: check the source scale."]
      : []),
  ];
  return {
    meshes: root.listMeshes().length,
    vertices,
    triangles,
    materials,
    textures: textures.length,
    ...(size.length === 3 && size.every(Number.isFinite)
      ? { sizeMeters: { x: size[0]!, y: size[1]!, z: size[2]! } }
      : {}),
    warnings,
  };
}

async function inside(root: string, path: string): Promise<string> {
  const info = await lstat(path).catch(() => undefined);
  const real = info?.isFile() ? await realpath(path) : undefined;
  if (!real || !real.startsWith(root + sep))
    throw new BlendkitError(
      "BLENDKIT_INVALID_RESPONSE",
      "The Client reported a file outside the staging directory.",
    );
  return real;
}

/**
 * Publishes staged files to their final names without ever replacing something that exists.
 * link(2) fails with EEXIST if the name is taken (a file, or even a dangling symlink) and is
 * atomic across processes, unlike check-then-rename, which POSIX rename(2) would turn into an
 * overwrite. The provenance file goes first and the GLB, the file consumers look for, last.
 *
 * Nothing is ever deleted from the output directory. POSIX has no unlink that is conditional on
 * the file being the one we created, so a rollback in a shared namespace could erase someone
 * else's file. If a later step fails or the caller aborts, the files already published stay, and
 * the error names them as partial output. The abort is checked before every link, so a caller
 * that aborts before the GLB is linked never sees success.
 */
async function publishWithoutOverwrite(
  files: [from: string, to: string][],
  signal: AbortSignal,
  afterLink?: (path: string) => Promise<void>,
): Promise<void> {
  const published: string[] = [];
  const partial = (why: string) =>
    new BlendkitError(
      "BLENDKIT_PARTIAL_OUTPUT",
      `Partial output: ${published.join(", ")} was published and kept, but the import did not complete ` +
        `(${why}). Inspect it and delete it by hand, or re-run after removing the name that blocked the import.`,
    );
  for (const [from, to] of files) {
    if (signal.aborted) {
      if (published.length) throw partial("cancelled before the final file");
      throw signal.reason;
    }
    try {
      await link(from, to);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (published.length)
        throw partial(`${basename(to)} could not be published: ${code ?? "error"}`);
      throw code === "EEXIST"
        ? new BlendkitError(
            "BLENDKIT_OUTPUT_EXISTS",
            `${to} already exists; this tool never overwrites an import.`,
          )
        : new BlendkitError(
            "BLENDKIT_PUBLISH_FAILED",
            `Could not publish ${basename(to)} (${code ?? "unknown error"}); the output directory must support hard links.`,
          );
    }
    published.push(to);
    await afterLink?.(to);
  }
}

/**
 * Acquire one free, explicitly consented Blendkit item through the user's Client, convert it with
 * the Client's bundled export_glb recipe, inspect the GLB and write its provenance.
 */
export async function importBlendkitAsset(
  provider: BlendkitProvider,
  rawInput: BlendkitImportInput,
  signal: AbortSignal,
  options: {
    toolVersion: string;
    onProgress?: (progress: TaskProgress) => void;
    /** Test seam: runs once everything is staged, immediately before the files are published. */
    hooks?: {
      beforePublish?: () => Promise<void>;
      afterLink?: (path: string) => Promise<void>;
      removeStaging?: (path: string) => Promise<void>;
    };
  },
) {
  const input = BlendkitImportInputSchema.parse(rawInput);
  if (input.purpose === "redistribution") throw redistributionDenied();
  const nativeId = input.assetId.slice(PROVIDER.length + 1);
  const outputDir = resolve(input.outputDir);
  const item = await provider.lookup(nativeId, signal);
  if (item.assetType !== "model")
    throw new BlendkitError("BLENDKIT_UNSUPPORTED", "Only Blendkit models convert to GLB.");
  if (!item.isFree)
    throw new BlendkitError(
      "BLENDKIT_PAID_DENIED",
      "This is a paid (Full Plan) item; this MCP never acquires paid assets.",
    );
  const rights = rightsDecision(item.license, input.purpose, input.projectUseConsent);
  if (item.canDownload === false)
    throw new BlendkitError(
      "BLENDKIT_AUTH_REQUIRED",
      "The provider does not allow this download for the current session. Sign in through the official " +
        "Blendkit add-on and set your own BLENDKIT_API_KEY; this MCP never signs in.",
    );
  const files = provider.eligibleFiles(item, input.maxBytes);
  if (!files.length)
    throw new BlendkitError(
      "BLENDKIT_UNSUPPORTED",
      "The item offers no .blend variant on the provider API within the byte budget.",
    );
  const asset = provider.toAsset(item)!;
  const stem = `blendkit-${nativeId}`;
  const glbPath = join(outputDir, `${stem}.glb`);
  const provenancePath = join(outputDir, `${stem}.provenance.json`);
  // Early, cheap refusal before any download; publishing below is what actually guarantees it.
  for (const path of [glbPath, provenancePath])
    if (await lstat(path).catch(() => undefined))
      throw new BlendkitError(
        "BLENDKIT_OUTPUT_EXISTS",
        `${path} already exists; this tool never overwrites an import.`,
      );
  await mkdir(outputDir, { recursive: true });
  const staging = await realpath(await mkdtemp(join(outputDir, ".blendkit-staging-")));
  const removeStaging =
    options.hooks?.removeStaging ?? ((path: string) => rm(path, { recursive: true, force: true }));
  // Staging is deleted only when nothing can still be writing into it. An UnconfirmedStopError
  // (a download not confirmed cancelled, or a recipe the Client cannot cancel) keeps it.
  let outcome;
  try {
    const client = provider.options.client;
    const downloaded = await client.download(
      { id: item.id, name: item.name, assetType: item.assetType, files },
      staging,
      input.resolution,
      provider.options.apiKey ?? "",
      signal,
      options.onProgress,
    );
    const blends = await Promise.all(downloaded.map((path) => inside(staging, path)));
    const blend = blends.find((path) => path.toLowerCase().endsWith(".blend"));
    if (!blend)
      throw new BlendkitError("BLENDKIT_INVALID_RESPONSE", "The download produced no .blend file.");
    const sourceBytes = (await lstat(blend)).size;
    if (sourceBytes > input.maxBytes)
      throw new BlendkitError(
        "BLENDKIT_INVALID_RESPONSE",
        "The downloaded file exceeds the byte budget.",
      );
    const converted = join(staging, `${randomUUID()}.glb`);
    try {
      await client.runTool(
        CONVERSION_RECIPE,
        blend,
        converted,
        CONVERSION_PARAMS,
        provider.options.blenderPath,
        AbortSignal.any([signal, AbortSignal.timeout(600_000)]),
      );
    } catch (error) {
      if (signal.aborted || error instanceof UnconfirmedStopError) throw error;
      throw new BlendkitError(
        "BLENDKIT_CONVERSION_FAILED",
        `The Client's ${CONVERSION_RECIPE} recipe failed: ${error instanceof Error ? error.message : "unknown error"}`.slice(
          0,
          600,
        ),
      );
    }
    await inside(staging, converted);
    const inspection = await inspectGlb(converted).catch(() => {
      throw new BlendkitError(
        "BLENDKIT_CONVERSION_FAILED",
        "The converted file is not a readable GLB.",
      );
    });
    if (!inspection.meshes)
      throw new BlendkitError("BLENDKIT_CONVERSION_FAILED", "The converted GLB contains no mesh.");
    const provenance = {
      schemaVersion: 1,
      provider: PROVIDER,
      assetId: asset.assetId,
      nativeId,
      assetBaseId: item.assetBaseId,
      sourceUrl: asset.sourceUrl,
      title: asset.title,
      ...(asset.author ? { author: asset.author } : {}),
      license: asset.license,
      purpose: input.purpose,
      licenseAcknowledged: true,
      projectUseConsent: true,
      redistribution: rights,
      providerPermissionEvidence: provider.options.permissionEvidence,
      acquiredAt: new Date().toISOString(),
      toolVersion: options.toolVersion,
      acquisition: { route: "official Blendkit-Client", resolution: input.resolution },
      source: {
        file: basename(blend).slice(0, 200),
        bytes: sourceBytes,
        sha256: await sha256File(blend),
      },
      conversion: { recipe: CONVERSION_RECIPE, params: CONVERSION_PARAMS },
      output: {
        file: basename(glbPath),
        bytes: (await lstat(converted)).size,
        sha256: await sha256File(converted),
      },
      inspection,
    };
    const stagedProvenance = join(staging, "provenance.json");
    await writeFile(stagedProvenance, JSON.stringify(provenance, null, 2) + "\n");
    await options.hooks?.beforePublish?.();
    signal.throwIfAborted();
    await publishWithoutOverwrite(
      [
        [stagedProvenance, provenancePath],
        [converted, glbPath],
      ],
      signal,
      options.hooks?.afterLink,
    );
    outcome = { glbPath, provenancePath, ...provenance };
  } catch (error) {
    if (error instanceof UnconfirmedStopError)
      throw new BlendkitError(
        signal.aborted ? "BLENDKIT_CANCELLED" : "BLENDKIT_STAGING_RETAINED",
        `${error.message}. The official Client did not confirm that its task stopped, so ${staging} was ` +
          "kept in case a download or Blender export is still writing. Delete it once that has ended.",
      );
    await removeStaging(staging).catch(() => undefined);
    throw error;
  }
  // The import is committed: a cleanup problem is a warning, never an acquisition failure.
  const warnings: string[] = [];
  await removeStaging(staging).catch((error: NodeJS.ErrnoException) =>
    warnings.push(
      `The import is complete, but the staging directory ${staging} could not be removed (${error.code ?? "unknown error"}). Delete it by hand.`,
    ),
  );
  return { ...outcome, warnings };
}
