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
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { sizeMeters, type SizeMeters } from "../gltf-size.js";

export type DirectAssetProvider =
  | "polyhaven"
  | "ambientcg"
  | "smithsonian"
  | "game-icons"
  | "kenney"
  | "itch";

export type DirectAssetDownloadErrorCode =
  | "ASSET_DOWNLOAD_URL_REJECTED"
  | "ASSET_DOWNLOAD_TOO_LARGE"
  | "ASSET_DOWNLOAD_UPSTREAM_DENIED"
  | "ASSET_DOWNLOAD_FAILED";

export class DirectAssetDownloadError extends Error {
  constructor(
    public readonly code: DirectAssetDownloadErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "DirectAssetDownloadError";
  }
}

export interface DirectAssetDownloadResult {
  provider: DirectAssetProvider;
  fileName: string;
  path: string;
  sizeBytes: number;
  sha256: string;
  alreadyExisted: boolean;
  sourceUrl: string;
  licenseAcknowledged: true;
  /** Bounding-box size in metres, for a `.glb`/`.gltf` download the reader could open. */
  sizeMeters?: SizeMeters;
}

export interface DirectAssetDownloaderOptions {
  fetch?: typeof globalThis.fetch;
  downloadDir?: string;
  maxDownloadBytes?: number;
  downloadTimeoutMs?: number;
}

const PROVIDER_HOSTS: Record<DirectAssetProvider, ReadonlySet<string>> = {
  polyhaven: new Set(["dl.polyhaven.org"]),
  ambientcg: new Set(["ambientcg.com", "acg-download.struffelproductions.com"]),
  smithsonian: new Set(["3d-api.si.edu"]),
  "game-icons": new Set(["game-icons.net"]),
  kenney: new Set(["kenney.nl"]),
  itch: new Set(),
};

function isAllowedProviderHost(provider: DirectAssetProvider, hostname: string): boolean {
  if (provider === "itch") {
    return /^itchio-mirror\.[0-9a-f]+\.r2\.cloudflarestorage\.com$/i.test(hostname);
  }
  return PROVIDER_HOSTS[provider].has(hostname);
}

function validateInitialUrl(provider: DirectAssetProvider, url: URL): boolean {
  if (url.username || url.password || url.port || url.hash) return false;
  if (url.protocol !== "https:" || !isAllowedProviderHost(provider, url.hostname)) {
    return false;
  }
  if (provider === "ambientcg") {
    return (
      url.hostname === "ambientcg.com" && url.pathname === "/get" && url.searchParams.has("file")
    );
  }
  if (provider === "smithsonian") {
    return (
      url.hostname === "3d-api.si.edu" && url.pathname.startsWith("/content/document/3d_package:")
    );
  }
  if (provider === "game-icons") {
    return (
      url.hostname === "game-icons.net" &&
      /^\/archives\/[0-9a-f]{6}\/(?:[0-9a-f]{6}|transparent)\/game-icons\.net\.(?:svg|png)\.zip$/i.test(
        url.pathname,
      )
    );
  }
  if (provider === "kenney") {
    return /^\/media\/pages\/assets\/[a-z0-9-]+\/[a-z0-9-]+\/kenney_[a-z0-9_.-]+\.zip$/i.test(
      url.pathname,
    );
  }
  if (provider === "itch") {
    return (
      /^\/upload2\/game\/\d+\/\d+$/.test(url.pathname) && url.searchParams.has("X-Amz-Signature")
    );
  }
  return url.hostname === "dl.polyhaven.org";
}

function safeFileName(input: string): string {
  const leaf = basename(input).slice(0, 220);
  const safe = leaf.replace(/[^A-Za-z0-9._ -]/g, "_").trim();
  if (!safe || safe === "." || safe === "..") {
    throw new DirectAssetDownloadError(
      "ASSET_DOWNLOAD_FAILED",
      "The requested filename is unsafe.",
    );
  }
  return safe;
}

function isInside(path: string, parent: string): boolean {
  const child = relative(parent, path);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

async function hashFile(path: string, algorithm: string, signal: AbortSignal): Promise<string> {
  const hash = createHash(algorithm);
  await new Promise<void>((resolveHash, reject) => {
    const stream = createReadStream(path, { signal });
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolveHash);
  });
  return hash.digest("hex");
}

async function writeAll(file: FileHandle, value: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < value.byteLength) {
    const { bytesWritten } = await file.write(value, offset, value.byteLength - offset, null);
    if (bytesWritten <= 0) throw new Error("Asset file write made no progress.");
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
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

export class DirectAssetDownloader {
  private readonly fetch: typeof globalThis.fetch;
  private readonly downloadDir: string;
  private readonly maxDownloadBytes: number;
  private readonly downloadTimeoutMs: number;

  constructor(options: DirectAssetDownloaderOptions = {}) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.downloadDir = resolve(
      options.downloadDir ??
        process.env.ASSET_DOWNLOAD_DIR ??
        join(homedir(), "Downloads", "threenative-asset-mcp", "assets"),
    );
    this.maxDownloadBytes =
      options.maxDownloadBytes ??
      positiveIntegerEnvironment(
        process.env.ASSET_MAX_DOWNLOAD_BYTES,
        10_737_418_240,
        53_687_091_200,
      );
    this.downloadTimeoutMs =
      options.downloadTimeoutMs ??
      positiveIntegerEnvironment(process.env.ASSET_DOWNLOAD_TIMEOUT_MS, 1_800_000, 7_200_000);
  }

  /** Keep transfers on the same guarded transport while staging a whole asset. */
  forDirectory(downloadDir: string): DirectAssetDownloader {
    return new DirectAssetDownloader({
      fetch: this.fetch,
      downloadDir,
      maxDownloadBytes: this.maxDownloadBytes,
      downloadTimeoutMs: this.downloadTimeoutMs,
    });
  }

  get storageDirectory(): string {
    return this.downloadDir;
  }
  get byteLimit(): number {
    return this.maxDownloadBytes;
  }

  async download(input: {
    provider: DirectAssetProvider;
    url: string;
    fileName: string;
    identity?: string;
    reportedSourceUrl?: string;
    signal?: AbortSignal;
    maxBytes?: number;
    expectedSize?: number;
    expectedMd5?: string;
  }): Promise<DirectAssetDownloadResult> {
    const maxBytes = input.maxBytes ?? this.maxDownloadBytes;
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > this.maxDownloadBytes ||
      (input.expectedSize !== undefined &&
        (!Number.isSafeInteger(input.expectedSize) || input.expectedSize < 0)) ||
      (input.expectedMd5 !== undefined && !/^[0-9a-f]{32}$/i.test(input.expectedMd5))
    ) {
      throw new DirectAssetDownloadError(
        "ASSET_DOWNLOAD_FAILED",
        "Invalid download budget or integrity metadata.",
      );
    }
    const signal = AbortSignal.any([
      AbortSignal.timeout(this.downloadTimeoutMs),
      ...(input.signal ? [input.signal] : []),
    ]);
    signal.throwIfAborted();
    const verify = async (path: string, size: number, md5?: string) => {
      if (size > maxBytes)
        throw new DirectAssetDownloadError(
          "ASSET_DOWNLOAD_TOO_LARGE",
          "The asset exceeds the selected byte budget.",
        );
      if (
        (input.expectedSize !== undefined && input.expectedSize !== size) ||
        (input.expectedMd5 &&
          input.expectedMd5.toLowerCase() !== (md5 ?? (await hashFile(path, "md5", signal))))
      ) {
        throw new DirectAssetDownloadError(
          "ASSET_DOWNLOAD_FAILED",
          "The selected file failed integrity verification.",
        );
      }
    };
    let initial: URL;
    try {
      initial = new URL(input.url);
    } catch {
      throw new DirectAssetDownloadError(
        "ASSET_DOWNLOAD_URL_REJECTED",
        "The provider download URL is invalid.",
      );
    }
    if (!validateInitialUrl(input.provider, initial)) {
      throw new DirectAssetDownloadError(
        "ASSET_DOWNLOAD_URL_REJECTED",
        "The URL does not match the selected provider's official download contract.",
      );
    }

    const fileName = safeFileName(input.fileName);
    const root = await this.ensureDirectory(this.downloadDir);
    const sourceKey = createHash("sha256")
      .update(input.identity ?? initial.toString())
      .digest("hex");
    const directory = await this.ensureDirectory(join(root, input.provider, sourceKey));
    if (!isInside(directory, root)) {
      throw new DirectAssetDownloadError(
        "ASSET_DOWNLOAD_FAILED",
        "Refused a path outside the configured asset directory.",
      );
    }
    const outputPath = join(directory, fileName);
    const existing = await lstat(outputPath).catch(() => undefined);
    if (existing) {
      if (!existing.isFile() || existing.isSymbolicLink()) {
        throw new DirectAssetDownloadError(
          "ASSET_DOWNLOAD_FAILED",
          "The destination is not a safe regular file.",
        );
      }
      const metadata = await stat(outputPath);
      await verify(outputPath, metadata.size);
      signal.throwIfAborted();
      return this.result(
        input.provider,
        input.reportedSourceUrl ?? initial.toString(),
        fileName,
        outputPath,
        metadata.size,
        await hashFile(outputPath, "sha256", signal),
        true,
      );
    }

    const temporaryPath = join(directory, `.${fileName}.${randomUUID()}.part`);
    try {
      const response = await this.fetchDownload(input.provider, initial, signal);
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        await response.body?.cancel();
        throw new DirectAssetDownloadError(
          "ASSET_DOWNLOAD_TOO_LARGE",
          "The asset exceeds ASSET_MAX_DOWNLOAD_BYTES.",
        );
      }
      if (!response.body) {
        throw new DirectAssetDownloadError(
          "ASSET_DOWNLOAD_FAILED",
          "The provider returned an empty response body.",
          true,
        );
      }

      const file = await open(temporaryPath, "wx", 0o600);
      const hash = createHash("sha256");
      const md5 = createHash("md5");
      let sizeBytes = 0;
      try {
        const reader = response.body.getReader();
        const cancel = () => {
          void reader.cancel().catch(() => undefined);
        };
        signal.addEventListener("abort", cancel, { once: true });
        try {
          while (true) {
            signal.throwIfAborted();
            const { done, value } = await reader.read();
            signal.throwIfAborted();
            if (done) break;
            sizeBytes += value.byteLength;
            if (sizeBytes > maxBytes) {
              await reader.cancel();
              throw new DirectAssetDownloadError(
                "ASSET_DOWNLOAD_TOO_LARGE",
                "The asset exceeds ASSET_MAX_DOWNLOAD_BYTES.",
              );
            }
            hash.update(value);
            md5.update(value);
            await writeAll(file, value);
          }
        } finally {
          signal.removeEventListener("abort", cancel);
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
        await verify(temporaryPath, sizeBytes, md5.digest("hex"));
        await file.sync();
      } finally {
        await file.close();
      }
      signal.throwIfAborted();
      await link(temporaryPath, outputPath);
      return this.result(
        input.provider,
        input.reportedSourceUrl ?? initial.toString(),
        fileName,
        outputPath,
        sizeBytes,
        hash.digest("hex"),
        false,
      );
    } catch (error) {
      if (error instanceof DirectAssetDownloadError) throw error;
      throw new DirectAssetDownloadError(
        "ASSET_DOWNLOAD_FAILED",
        "The asset could not be downloaded or saved safely.",
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

  private async fetchDownload(
    provider: DirectAssetProvider,
    initial: URL,
    signal: AbortSignal,
  ): Promise<Response> {
    let current = initial;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      if (
        current.username ||
        current.password ||
        current.port ||
        current.hash ||
        current.protocol !== "https:" ||
        !isAllowedProviderHost(provider, current.hostname)
      ) {
        throw new DirectAssetDownloadError(
          "ASSET_DOWNLOAD_URL_REJECTED",
          "The provider redirected outside its official download-host allowlist.",
        );
      }
      signal.throwIfAborted();
      const response = await this.fetch(current, {
        redirect: "manual",
        signal,
        headers: { "user-agent": "threenative-asset-mcp/0.4.0" },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) break;
        await response.body?.cancel();
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new DirectAssetDownloadError(
          "ASSET_DOWNLOAD_UPSTREAM_DENIED",
          `The provider refused the download with HTTP ${response.status}.`,
          response.status === 429 || response.status >= 500,
        );
      }
      const contentType = response.headers.get("content-type")?.toLocaleLowerCase();
      if (contentType?.includes("text/html")) {
        await response.body?.cancel();
        throw new DirectAssetDownloadError(
          "ASSET_DOWNLOAD_UPSTREAM_DENIED",
          "The provider returned HTML instead of an asset file.",
        );
      }
      return response;
    }
    throw new DirectAssetDownloadError(
      "ASSET_DOWNLOAD_URL_REJECTED",
      "The provider exceeded the redirect limit.",
    );
  }

  private async result(
    provider: DirectAssetProvider,
    sourceUrl: string,
    fileName: string,
    path: string,
    sizeBytes: number,
    sha256: string,
    alreadyExisted: boolean,
  ): Promise<DirectAssetDownloadResult> {
    const size = await sizeMeters(path);
    return {
      provider,
      fileName,
      path,
      sizeBytes,
      sha256,
      alreadyExisted,
      sourceUrl,
      licenseAcknowledged: true,
      ...(size ? { sizeMeters: size } : {}),
    };
  }
}
