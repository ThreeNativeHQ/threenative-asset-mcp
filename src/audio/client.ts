import { resolveKenneyDownload } from "../kenney/download-link.js";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
  AUDIO_ASSETS,
  AUDIO_SOURCES,
  type AudioCatalogAsset,
  type AudioKind,
  type AudioSource,
  type AudioSourceId,
} from "./catalog.js";

export type AudioErrorCode =
  | "AUDIO_ASSET_NOT_FOUND"
  | "AUDIO_DOWNLOAD_FAILED"
  | "AUDIO_DOWNLOAD_TOO_LARGE"
  | "AUDIO_UPSTREAM_DENIED"
  | "AUDIO_UNSAFE_REDIRECT";

export class AudioCatalogError extends Error {
  constructor(
    public readonly code: AudioErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "AudioCatalogError";
  }
}

export interface AudioDownloadResult {
  assetId: string;
  sourceId: AudioSourceId;
  fileName: string;
  path: string;
  sizeBytes: number;
  sha256: string;
  alreadyExisted: boolean;
  license: string;
  attributionRequired: boolean;
  attributionText?: string;
  sourcePageUrl: string;
}

export interface AudioCatalogClientOptions {
  fetch?: typeof globalThis.fetch;
  downloadDir?: string;
  maxDownloadBytes?: number;
  downloadTimeoutMs?: number;
}

function isInside(path: string, parent: string): boolean {
  const child = relative(parent, path);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolveHash, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolveHash);
  });
  return hash.digest("hex");
}

async function writeAll(file: FileHandle, value: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < value.byteLength) {
    const { bytesWritten } = await file.write(
      value,
      offset,
      value.byteLength - offset,
      null,
    );
    if (bytesWritten <= 0) throw new Error("Audio file write made no progress.");
    offset += bytesWritten;
  }
}

function positiveIntegerEnvironment(
  value: string | undefined,
  fallback: number,
  maximum: number,
): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum
    ? parsed
    : fallback;
}

export class AudioCatalogClient {
  private readonly fetch: typeof globalThis.fetch;
  private readonly downloadDir: string;
  private readonly maxDownloadBytes: number;
  private readonly downloadTimeoutMs: number;
  private readonly allowedDownloadHosts = new Set(
    AUDIO_ASSETS.map((asset) => new URL(asset.downloadUrl).hostname),
  );

  constructor(options: AudioCatalogClientOptions = {}) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.downloadDir = resolve(
      options.downloadDir ??
        process.env.AUDIO_DOWNLOAD_DIR ??
        join(homedir(), "Downloads", "threenative-asset-mcp", "audio"),
    );
    this.maxDownloadBytes =
      options.maxDownloadBytes ??
      positiveIntegerEnvironment(
        process.env.AUDIO_MAX_DOWNLOAD_BYTES,
        10_737_418_240,
        53_687_091_200,
      );
    this.downloadTimeoutMs =
      options.downloadTimeoutMs ??
      positiveIntegerEnvironment(
        process.env.AUDIO_DOWNLOAD_TIMEOUT_MS,
        1_800_000,
        7_200_000,
      );
  }

  get directory(): string {
    return this.downloadDir;
  }

  listSources(): AudioSource[] {
    return AUDIO_SOURCES.map((source) => ({ ...source, browseUrls: [...source.browseUrls], kinds: [...source.kinds] }));
  }

  searchAssets(input: {
    query?: string;
    kind?: AudioKind | "all";
    source?: AudioSourceId | "all";
  }): AudioCatalogAsset[] {
    const query = input.query?.trim().toLocaleLowerCase();
    return AUDIO_ASSETS.filter((asset) => {
      const haystack = [asset.id, asset.name, asset.description, ...asset.tags]
        .join(" ")
        .toLocaleLowerCase();
      return (
        (!query || haystack.includes(query)) &&
        (!input.kind || input.kind === "all" || asset.kind === input.kind || asset.kind === "mixed") &&
        (!input.source || input.source === "all" || asset.sourceId === input.source)
      );
    }).map((asset) => ({ ...asset, tags: [...asset.tags] }));
  }

  getAsset(assetId: string): AudioCatalogAsset {
    const asset = AUDIO_ASSETS.find((candidate) => candidate.id === assetId);
    if (!asset) {
      throw new AudioCatalogError(
        "AUDIO_ASSET_NOT_FOUND",
        "The requested audio asset is not in the curated direct-download catalog.",
      );
    }
    return asset;
  }

  async downloadAsset(assetId: string): Promise<AudioDownloadResult> {
    const asset = this.getAsset(assetId);
    const root = await this.ensureDirectory(this.downloadDir);
    const directory = await this.ensureDirectory(join(root, asset.sourceId, asset.id));
    if (!isInside(directory, root)) {
      throw new AudioCatalogError(
        "AUDIO_DOWNLOAD_FAILED",
        "Refused an audio download path outside the configured directory.",
      );
    }
    const outputPath = join(directory, asset.fileName);
    const existing = await lstat(outputPath).catch(() => undefined);
    if (existing) {
      if (!existing.isFile() || existing.isSymbolicLink()) {
        throw new AudioCatalogError(
          "AUDIO_DOWNLOAD_FAILED",
          "The audio download destination is not a safe regular file.",
        );
      }
      const metadata = await stat(outputPath);
      return this.result(asset, outputPath, metadata.size, await sha256File(outputPath), true);
    }

    const temporaryPath = join(directory, `.${asset.fileName}.${randomUUID()}.part`);
    try {
      const response = await this.fetchDownload(asset.downloadUrl);
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > this.maxDownloadBytes) {
        throw new AudioCatalogError(
          "AUDIO_DOWNLOAD_TOO_LARGE",
          "The audio archive exceeds AUDIO_MAX_DOWNLOAD_BYTES.",
        );
      }
      if (!response.body) {
        throw new AudioCatalogError(
          "AUDIO_DOWNLOAD_FAILED",
          "The audio provider returned an empty response body.",
          true,
        );
      }

      const file = await open(temporaryPath, "wx", 0o600);
      const hash = createHash("sha256");
      let sizeBytes = 0;
      try {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          sizeBytes += value.byteLength;
          if (sizeBytes > this.maxDownloadBytes) {
            await reader.cancel();
            throw new AudioCatalogError(
              "AUDIO_DOWNLOAD_TOO_LARGE",
              "The audio archive exceeds AUDIO_MAX_DOWNLOAD_BYTES.",
            );
          }
          hash.update(value);
          await writeAll(file, value);
        }
        await file.sync();
      } finally {
        await file.close();
      }
      await link(temporaryPath, outputPath);
      return this.result(asset, outputPath, sizeBytes, hash.digest("hex"), false);
    } catch (error) {
      if (error instanceof AudioCatalogError) throw error;
      throw new AudioCatalogError(
        "AUDIO_DOWNLOAD_FAILED",
        "The audio archive could not be downloaded or saved safely.",
        true,
      );
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  private async ensureDirectory(path: string): Promise<string> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    return realpath(path);
  }

  private async fetchDownload(initialUrl: string): Promise<Response> {
    const resolved = await resolveKenneyDownload(
      new URL(initialUrl),
      this.fetch,
      AbortSignal.timeout(this.downloadTimeoutMs),
    );
    if (!resolved)
      throw new AudioCatalogError(
        "AUDIO_UPSTREAM_DENIED",
        "Kenney did not issue a download link for this pack.",
        true,
      );
    let current = resolved;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      if (current.protocol !== "https:" || !this.allowedDownloadHosts.has(current.hostname)) {
        throw new AudioCatalogError(
          "AUDIO_UNSAFE_REDIRECT",
          "The audio provider redirected to a host outside the curated allowlist.",
        );
      }
      const response = await this.fetch(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(this.downloadTimeoutMs),
        headers: { "user-agent": "threenative-asset-mcp/0.4.0" },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) break;
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) {
        throw new AudioCatalogError(
          "AUDIO_UPSTREAM_DENIED",
          `The audio provider refused the download with HTTP ${response.status}.`,
          response.status === 429 || response.status >= 500,
        );
      }
      const contentType = response.headers.get("content-type")?.toLocaleLowerCase();
      if (contentType?.includes("text/html")) {
        throw new AudioCatalogError(
          "AUDIO_UPSTREAM_DENIED",
          "The audio provider returned an HTML page instead of an asset archive.",
        );
      }
      return response;
    }
    throw new AudioCatalogError(
      "AUDIO_UNSAFE_REDIRECT",
      "The audio provider exceeded the redirect limit.",
    );
  }

  private result(
    asset: AudioCatalogAsset,
    path: string,
    sizeBytes: number,
    sha256: string,
    alreadyExisted: boolean,
  ): AudioDownloadResult {
    return {
      assetId: asset.id,
      sourceId: asset.sourceId,
      fileName: asset.fileName,
      path,
      sizeBytes,
      sha256,
      alreadyExisted,
      license: asset.license,
      attributionRequired: asset.attributionRequired,
      ...(asset.attributionText ? { attributionText: asset.attributionText } : {}),
      sourcePageUrl: asset.sourcePageUrl,
    };
  }
}
