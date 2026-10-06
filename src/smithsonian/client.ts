import { MetadataRequests, readMetadata, type MetadataContext } from "../discovery/metadata.js";

const API_BASE = "https://3d-api.si.edu/api/v1.0/content/file/search";

export const SMITHSONIAN_FILE_TYPES = ["jpg", "glb", "ply", "zip"] as const;
export const SMITHSONIAN_MODEL_TYPES = [
  "glb",
  "ply",
  "obj",
  "gltf",
  "f3z",
  "blend",
  "stl",
] as const;
export const SMITHSONIAN_QUALITIES = [
  "Low",
  "Medium",
  "High",
  "Thumb",
  "Low_resolution",
  "Medium_resolution",
  "Full_resolution",
  "Water_tight",
] as const;

export interface SmithsonianFile {
  modelId: string;
  title: string;
  url: string;
  fileType: string;
  modelType?: string;
  quality?: string;
  usage?: string;
  dracoCompressed?: boolean;
  gltfOrientationCompliant?: boolean;
}

export interface SmithsonianSearchResult {
  files: SmithsonianFile[];
  totalFiles: number;
}

export class SmithsonianClientError extends Error {
  constructor(
    readonly code:
      | "SMITHSONIAN_INVALID_INPUT"
      | "SMITHSONIAN_NOT_FOUND"
      | "SMITHSONIAN_RATE_LIMITED"
      | "SMITHSONIAN_UPSTREAM_UNAVAILABLE"
      | "SMITHSONIAN_UPSTREAM_CHANGED",
    message: string,
    readonly retryable = false,
    readonly retryAfter?: string,
  ) {
    super(message);
    this.name = "SmithsonianClientError";
  }
}

type FetchLike = typeof fetch;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown, max = 2_048): string | undefined {
  return typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
}

function normalizeModelId(value: string): string {
  return value.replace(/^3d_package:/, "");
}

function normalizeFile(value: unknown): SmithsonianFile | undefined {
  const row = record(value);
  const content = record(row?.content);
  const title = text(row?.title, 500);
  const modelUrl = text(content?.model_url, 200);
  const url = text(content?.uri);
  const fileType = text(content?.file_type, 30);
  if (!title || !modelUrl || !url || !fileType) return;
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "3d-api.si.edu" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.hash
    ) {
      return;
    }
  } catch {
    return;
  }
  const modelType = text(content?.model_type, 30);
  const quality = text(content?.quality, 50);
  const usage = text(content?.usage, 100);
  return {
    modelId: normalizeModelId(modelUrl),
    title,
    url,
    fileType,
    ...(modelType ? { modelType } : {}),
    ...(quality ? { quality } : {}),
    ...(usage ? { usage } : {}),
    ...(typeof content?.draco_compressed === "boolean"
      ? { dracoCompressed: content.draco_compressed }
      : {}),
    ...(typeof content?.gltf_orientation_compliant === "boolean"
      ? { gltfOrientationCompliant: content.gltf_orientation_compliant }
      : {}),
  };
}

export class SmithsonianClient {
  private readonly requests = new MetadataRequests();
  constructor(private readonly fetchImpl: FetchLike = fetch) {}

  async search(
    params: URLSearchParams,
    context: MetadataContext = {},
  ): Promise<SmithsonianSearchResult> {
    return this.requests.run(params.toString(), context.signal, async (callerSignal) => {
      const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(20_000)]);
      let response: Response;
      try {
        response = await this.fetchImpl(`${API_BASE}?${params}`, {
          headers: {
            accept: "application/json",
            "user-agent": "threenative-asset-mcp/0.4.0",
          },
          signal,
          redirect: "error",
        });
      } catch {
        throw new SmithsonianClientError(
          "SMITHSONIAN_UPSTREAM_UNAVAILABLE",
          "The Smithsonian 3D API could not be reached.",
          true,
        );
      }
      if (!response.ok) await response.body?.cancel();
      if (response.status === 404) {
        return { files: [], totalFiles: 0 };
      }
      if (response.status === 429) {
        throw new SmithsonianClientError(
          "SMITHSONIAN_RATE_LIMITED",
          "The Smithsonian 3D API rate-limited the request.",
          true,
          response.headers.get("retry-after")?.slice(0, 100),
        );
      }
      if (!response.ok) {
        throw new SmithsonianClientError(
          "SMITHSONIAN_UPSTREAM_UNAVAILABLE",
          `The Smithsonian 3D API returned HTTP ${response.status}.`,
          response.status >= 500,
        );
      }
      let payload: Record<string, unknown> | undefined;
      try {
        payload = record(JSON.parse(await readMetadata(response, 16 * 1024 * 1024, signal)));
      } catch {
        payload = undefined;
      }
      const rows = payload?.rows;
      const rowCount = payload?.rowCount;
      if (
        !Array.isArray(rows) ||
        rows.length > 1000 ||
        typeof rowCount !== "number" ||
        !Number.isSafeInteger(rowCount) ||
        rowCount < 0
      ) {
        throw new SmithsonianClientError(
          "SMITHSONIAN_UPSTREAM_CHANGED",
          "The Smithsonian 3D API returned an invalid response.",
        );
      }
      return {
        files: rows
          .map(normalizeFile)
          .filter((file): file is SmithsonianFile => file !== undefined),
        totalFiles: rowCount,
      };
    });
  }

  async listFiles(modelId: string, context: MetadataContext = {}): Promise<SmithsonianFile[]> {
    const params = new URLSearchParams({
      model_url: normalizeModelId(modelId),
      start: "0",
      rows: "1000",
    });
    const result = await this.search(params, context);
    if (result.files.length === 0) {
      throw new SmithsonianClientError(
        "SMITHSONIAN_NOT_FOUND",
        "The Smithsonian 3D model was not found.",
      );
    }
    return result.files;
  }
}
