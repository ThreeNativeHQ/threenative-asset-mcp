import type { McpServer } from "@modelcontextprotocol/server";

export type AssetMcpProfile = "detailed" | "studio";

export const STUDIO_PROFILE_TOOLS: ReadonlySet<string> = new Set([
  "asset_search",
  "asset_get",
  "asset_download",
  "asset_download_file",
  "asset_list_sources",
  "asset_search_sources",
  "polyhaven_search_assets",
  "polyhaven_get_asset",
  "polyhaven_list_files",
  "ambientcg_search_assets",
  "ambientcg_get_asset",
  "ambientcg_list_files",
  "polyfork_search_models",
  "polyfork_get_model",
  "polyfork_list_files",
  "audio_list_sources",
  "audio_search_assets",
  "audio_download_asset",
  "audio_generate_sound",
  "asset_inspect_rig",
  "asset_auto_rig",
  "asset_retarget_animations",
  "asset_preview_animation",
  "mesh_optimize",
]);

const SEARCH_TOOLS = new Set([
  "asset_search",
  "polyhaven_search_assets",
  "ambientcg_search_assets",
  "polyfork_search_models",
  "audio_search_assets",
]);

const STRIP_SEARCH_ITEM_KEYS = new Set([
  "nativeId",
  "sourceUrl",
  "thumbnailUrl",
  "categoryId",
  "authors",
  "attributes",
  "downloadReason",
  "files",
  "browseUrls",
  "licenseSummary",
  "attribution",
  "hd",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compactLicense(license: unknown): unknown {
  if (!isRecord(license)) return license;
  const { url: _u, evidence: _e, ...rest } = license;
  return rest;
}

function compactSearchItem(item: unknown): unknown {
  if (!isRecord(item)) return item;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) {
    if (STRIP_SEARCH_ITEM_KEYS.has(k)) continue;
    out[k] = k === "license" ? compactLicense(v) : v;
  }
  return out;
}

function compactPolyhavenFiles(data: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(data.files)) return data;
  const compactFiles = data.files
    .filter((entry) => {
      if (!isRecord(entry)) return true;
      const fmt = String(entry.format ?? "");
      return fmt !== "blend" && fmt !== "usd";
    })
    .map((entry) => {
      if (!isRecord(entry)) return entry;
      const { md5: _m, dependencyOf: _d, ...rest } = entry;
      return rest;
    });
  return { ...data, files: compactFiles };
}

function compactDownloadPayload(data: Record<string, unknown>): Record<string, unknown> {
  const { receipt: _r, ...rest } = data;
  if ("license" in rest) rest.license = compactLicense(rest.license);
  if (Array.isArray(rest.files)) {
    rest.files = rest.files.map((f) => {
      if (!isRecord(f)) return f;
      const { sha256: _s, url: _u, ...fileRest } = f;
      return fileRest;
    });
  }
  return rest;
}

export function compactStudioPayload(toolName: string, raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  let data: Record<string, unknown> = { ...raw };

  if (Array.isArray(data.warnings) && data.warnings.length === 0) delete data.warnings;
  if (data.truncated === false) delete data.truncated;
  if ("license" in data) data.license = compactLicense(data.license);

  for (const listKey of ["assets", "models", "results", "sources"] as const) {
    if (Array.isArray(data[listKey])) {
      data[listKey] = (data[listKey] as unknown[]).map(compactSearchItem);
    }
  }

  if (toolName === "polyhaven_list_files" || toolName === "ambientcg_list_files") {
    data = compactPolyhavenFiles(data);
  }
  if (toolName === "asset_download" || toolName === "asset_download_file" || toolName === "audio_download_asset") {
    data = compactDownloadPayload(data);
  }
  if (toolName === "asset_get" && isRecord(data.plan)) {
    const plan = { ...data.plan };
    delete plan.acknowledgement;
    if (Array.isArray(plan.files)) {
      plan.files = plan.files.map((f) => {
        if (!isRecord(f)) return f;
        const { sha256: _s, ...fileRest } = f;
        return fileRest;
      });
    }
    data.plan = plan;
  }

  return data;
}

function clampDescription(description: unknown): string | undefined {
  if (typeof description !== "string") return undefined;
  const flat = description.replace(/\s+/gu, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 157).trimEnd()}...` : flat;
}

export function resolveAssetMcpProfile(argv: readonly string[], env: NodeJS.ProcessEnv): AssetMcpProfile {
  const flagIdx = argv.indexOf("--profile");
  const flagVal = flagIdx >= 0 ? argv[flagIdx + 1] : undefined;
  const modeVal = flagVal ?? env.ASSET_MCP_PROFILE ?? "";
  return modeVal.trim().toLowerCase() === "studio" ? "studio" : "detailed";
}

function hasLimitField(schema: unknown): boolean {
  if (!isRecord(schema)) return false;
  if (isRecord(schema.shape) && "limit" in schema.shape) return true;
  const def = isRecord(schema._def) ? schema._def : undefined;
  return def !== undefined && isRecord(def.shape) && "limit" in def.shape;
}

export function applyStudioProfileFilter(server: McpServer, profile: AssetMcpProfile): void {
  if (profile !== "studio") return;
  const originalRegister = server.registerTool.bind(server);
  server.registerTool = ((name: string, config: Record<string, unknown>, handler: (...args: unknown[]) => Promise<unknown>) => {
    if (!STUDIO_PROFILE_TOOLS.has(name)) {
      return undefined as never;
    }
    const { outputSchema: _ignored, description, ...restConfig } = config;
    const compactConfig = {
      ...restConfig,
      ...(typeof description === "string" ? { description: clampDescription(description) } : {}),
    };
    const acceptsLimit = SEARCH_TOOLS.has(name) && hasLimitField(config.inputSchema);
    const wrappedHandler = async (...args: unknown[]) => {
      const rawInput = args[0];
      if (acceptsLimit && isRecord(rawInput)) {
        const currentLimit = typeof rawInput.limit === "number" ? rawInput.limit : 8;
        args[0] = { ...rawInput, limit: Math.min(currentLimit, 8) };
      }
      const res = await handler(...args);
      if (!isRecord(res) || res.isError === true) return res;
      const sourceObj = res.structuredContent ?? (() => {
        const first = Array.isArray(res.content) ? res.content[0] : undefined;
        if (isRecord(first) && typeof first.text === "string") {
          try {
            return JSON.parse(first.text) as unknown;
          } catch {
            return undefined;
          }
        }
        return undefined;
      })();
      if (sourceObj === undefined) return res;
      const compacted = compactStudioPayload(name, sourceObj);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(compacted) }],
      };
    };
    return originalRegister(name, compactConfig as never, wrappedHandler as never);
  }) as typeof server.registerTool;
}
