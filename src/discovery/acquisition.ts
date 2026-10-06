import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  DirectAssetDownloader,
  type DirectAssetProvider,
} from "../download/direct-asset-downloader.js";
import type { AssetDetail, AssetFile } from "./types.js";

export class AcquisitionError extends Error {}

export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function safeRelativePath(path: string): string {
  if (
    path.length > 500 ||
    !path ||
    path.includes("%") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /[:\x00-\x1f<>|?*"]/u.test(path) ||
    path
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[. ]$/u.test(part) ||
          /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/iu.test(part),
      )
  ) {
    throw new AcquisitionError("Unsafe asset file path.");
  }
  return path;
}

export function validateFiles(detail: AssetDetail): void {
  if (detail.files.length < 1 || detail.files.length > 128)
    throw new AcquisitionError("Invalid asset file count.");
  const paths = new Set<string>(["asset.acquisition.json"]);
  const ids = new Set<string>();
  for (const file of detail.files) {
    const path = safeRelativePath(file.path).toLowerCase();
    if (
      paths.has(path) ||
      [...paths].some(
        (existing) => path.startsWith(existing + "/") || existing.startsWith(path + "/"),
      )
    )
      throw new AcquisitionError("Asset file path collision.");
    paths.add(path);
    if (!file.id || ids.has(file.id)) throw new AcquisitionError("Asset file identity collision.");
    ids.add(file.id);
    const url = new URL(file.url);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash)
      throw new AcquisitionError("Unsafe asset file URL.");
    const hosts: Record<string, string[]> = {
      polyhaven: ["dl.polyhaven.org"],
      ambientcg: ["ambientcg.com"],
      kenney: ["kenney.nl"],
    };
    if (!hosts[detail.asset.provider]?.includes(url.hostname))
      throw new AcquisitionError("Unsupported asset file URL.");
    if (
      file.sizeBytes !== undefined &&
      (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0)
    )
      throw new AcquisitionError("Invalid asset file size.");
    if (file.md5 !== undefined && !/^[a-f0-9]{32}$/iu.test(file.md5))
      throw new AcquisitionError("Invalid asset file checksum.");
  }
  for (const file of detail.files) {
    let current: AssetFile | undefined = file;
    const seen = new Set<string>();
    while (current?.dependencyOf) {
      if (seen.has(current.id) || seen.size >= 8)
        throw new AcquisitionError("Invalid asset dependency depth or cycle.");
      seen.add(current.id);
      const parentId: string = current.dependencyOf;
      current = detail.files.find((candidate) => candidate.id === parentId);
      if (!current) throw new AcquisitionError("Missing planned dependency parent.");
    }
  }
}

export function detailIdentity(detail: AssetDetail): string {
  return digest({
    asset: detail.asset,
    termsText: detail.termsText,
    selectedVariant: detail.selectedVariant,
    files: detail.files,
  });
}

async function fileHash(path: string, algorithm: string, signal: AbortSignal): Promise<string> {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  return hash.digest("hex");
}

async function safeDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new AcquisitionError("Refused symlink or invalid acquisition storage.");
  return realpath(path);
}

async function validateGltf(directory: string, files: AssetFile[]): Promise<void> {
  const paths = new Set(files.map((file) => file.path));
  for (const file of files.filter((file) => /\.(?:gltf|glb)$/iu.test(file.path))) {
    let json: unknown;
    let binaryLength: number | undefined;
    if (/\.glb$/iu.test(file.path)) {
      const handle = await open(join(directory, file.path), "r");
      try {
        const header = Buffer.alloc(20);
        const { bytesRead } = await handle.read(header, 0, 20, 0);
        const info = await handle.stat();
        if (
          bytesRead !== 20 ||
          header.toString("utf8", 0, 4) !== "glTF" ||
          header.readUInt32LE(4) !== 2 ||
          header.readUInt32LE(8) !== info.size ||
          header.readUInt32LE(16) !== 0x4e4f534a
        )
          throw new AcquisitionError("Invalid GLB payload.");
        const length = header.readUInt32LE(12);
        if (length > 16 * 1024 * 1024 || length % 4 || 20 + length > info.size)
          throw new AcquisitionError("Invalid GLB metadata length.");
        const jsonBytes = Buffer.alloc(length);
        let offset = 0;
        while (offset < length) {
          const read = await handle.read(jsonBytes, offset, length - offset, 20 + offset);
          if (!read.bytesRead) throw new AcquisitionError("Truncated GLB metadata.");
          offset += read.bytesRead;
        }
        json = JSON.parse(jsonBytes.toString("utf8"));
        let cursor = 20 + length;
        let chunks = 0;
        while (cursor < info.size) {
          const chunk = Buffer.alloc(8);
          const read = await handle.read(chunk, 0, 8, cursor);
          if (read.bytesRead !== 8 || ++chunks > 128)
            throw new AcquisitionError("Invalid GLB chunk table.");
          const chunkLength = chunk.readUInt32LE(0);
          if (chunkLength % 4 || cursor + 8 + chunkLength > info.size)
            throw new AcquisitionError("Invalid GLB chunk bounds.");
          if (chunk.readUInt32LE(4) === 0x004e4942) {
            if (binaryLength !== undefined || cursor !== 20 + length)
              throw new AcquisitionError("Invalid GLB binary chunk.");
            binaryLength = chunkLength;
          }
          cursor += 8 + chunkLength;
        }
      } finally {
        await handle.close();
      }
    } else {
      const path = join(directory, file.path);
      if ((await lstat(path)).size > 16 * 1024 * 1024)
        throw new AcquisitionError("glTF metadata exceeds the byte budget.");
      const bytes = await readFile(path);
      json = JSON.parse(bytes.toString("utf8"));
    }
    if (!json || typeof json !== "object" || Array.isArray(json))
      throw new AcquisitionError("Invalid glTF document.");
    const doc = json as {
      asset?: { version?: unknown };
      buffers?: unknown;
      images?: unknown;
      bufferViews?: unknown;
      extensionsRequired?: unknown;
    };
    if (doc.asset?.version !== "2.0") throw new AcquisitionError("Unsupported glTF version.");
    // ponytail: standard buffers/images only; extensions with external resources need explicit qualification.
    if (
      doc.extensionsRequired !== undefined &&
      (!Array.isArray(doc.extensionsRequired) ||
        doc.extensionsRequired.some(
          (name) =>
            ![
              "KHR_materials_unlit",
              "KHR_mesh_quantization",
              "KHR_texture_transform",
              "KHR_materials_pbrSpecularGlossiness",
              "KHR_draco_mesh_compression",
              "EXT_meshopt_compression",
            ].includes(String(name)),
        ))
    )
      throw new AcquisitionError("Unsupported glTF required extension.");
    for (const [kind, collection] of [doc.buffers, doc.images].entries()) {
      if (collection === undefined) continue;
      if (!Array.isArray(collection) || collection.length > 128)
        throw new AcquisitionError("Invalid glTF resource list.");
      for (const [index, resource] of collection.entries()) {
        if (!resource || typeof resource !== "object")
          throw new AcquisitionError("Invalid glTF resource.");
        const { uri, byteLength, bufferView } = resource as {
          uri?: unknown;
          byteLength?: unknown;
          bufferView?: unknown;
        };
        if (kind === 0 && (!Number.isSafeInteger(byteLength) || (byteLength as number) < 1))
          throw new AcquisitionError("Invalid glTF buffer length.");
        if (uri === undefined) {
          if (kind === 0) {
            if (
              index !== 0 ||
              binaryLength === undefined ||
              binaryLength < (byteLength as number) ||
              binaryLength > (byteLength as number) + 3
            )
              throw new AcquisitionError("Missing or incomplete GLB embedded buffer.");
          } else if (
            !Number.isSafeInteger(bufferView) ||
            (bufferView as number) < 0 ||
            !Array.isArray(doc.bufferViews) ||
            !doc.bufferViews[bufferView as number]
          ) {
            throw new AcquisitionError("Missing glTF image buffer view.");
          }
          continue;
        }
        if (typeof uri !== "string") throw new AcquisitionError("Invalid glTF resource URI.");
        if (/^data:[a-z0-9/+.-]+;base64,[a-z0-9+/=]*$/iu.test(uri)) {
          if (
            kind === 0 &&
            Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64").length < (byteLength as number)
          )
            throw new AcquisitionError("Incomplete glTF embedded data buffer.");
          continue;
        }
        const path = safeRelativePath(uri);
        const parent = dirname(file.path);
        const local = parent === "." ? path : parent + "/" + path;
        if (!paths.has(local)) throw new AcquisitionError("Missing glTF companion: " + path);
        if (kind === 0 && (await lstat(join(directory, local))).size < (byteLength as number))
          throw new AcquisitionError("Incomplete glTF companion: " + path);
      }
    }
  }
}

export type ReceiptFile = {
  path: string;
  role: string;
  sizeBytes: number;
  sha256: string;
  dependencyOf?: string;
  metadata?: Record<string, string>;
};
export type AcquisitionReceipt = {
  schemaVersion: 1;
  assetId: string;
  provider: string;
  nativeId: string;
  sourceUrl: string;
  license: AssetDetail["asset"]["license"];
  author?: string;
  apiCredit?: string;
  fetchedAt: string;
  toolVersion: string;
  acknowledgedTermsDigest: string;
  planIdentity: string;
  selectedVariant: string;
  runtimeReadiness: "unverified";
  requiresExtraction: boolean;
  files: ReceiptFile[];
};

export async function acquire(
  detail: AssetDetail,
  downloader: DirectAssetDownloader,
  maxBytes: number,
  toolVersion: string,
  signal: AbortSignal,
) {
  validateFiles(detail);
  if (detail.files.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0) > maxBytes)
    throw new AcquisitionError("The complete asset exceeds the selected byte budget.");
  signal.throwIfAborted();
  const root = await safeDirectory(downloader.storageDirectory);
  const storage = await safeDirectory(join(root, "acquisitions"));
  const identity = detailIdentity(detail);
  const directory = join(storage, identity);
  const receiptPath = join(directory, "asset.acquisition.json");
  const result = (receipt: AcquisitionReceipt, alreadyExisted: boolean) => ({
    directory,
    receiptPath,
    files: receipt.files,
    totalBytes: receipt.files.reduce((sum, file) => sum + file.sizeBytes, 0),
    receipt,
    alreadyExisted,
    runtimeReadiness: "unverified" as const,
    requiresExtraction: receipt.requiresExtraction,
  });
  const existing = await lstat(directory).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  });
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink())
      throw new AcquisitionError("Acquisition cache integrity failure: unsafe directory.");
    const receiptInfo = await lstat(receiptPath);
    if (!receiptInfo.isFile() || receiptInfo.isSymbolicLink() || receiptInfo.size > 512 * 1024)
      throw new AcquisitionError("Acquisition cache integrity failure: unsafe receipt.");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as AcquisitionReceipt;
    if (
      receipt.schemaVersion !== 1 ||
      receipt.planIdentity !== identity ||
      !Array.isArray(receipt.files) ||
      receipt.files.length !== detail.files.length ||
      receipt.acknowledgedTermsDigest !==
        digest({ license: detail.asset.license, terms: detail.termsText }) ||
      receipt.assetId !== detail.asset.assetId ||
      receipt.provider !== detail.asset.provider ||
      receipt.nativeId !== detail.asset.nativeId ||
      receipt.sourceUrl !== detail.asset.sourceUrl ||
      digest(receipt.license) !== digest(detail.asset.license) ||
      receipt.author !== detail.asset.author ||
      receipt.apiCredit !== detail.asset.apiCredit ||
      receipt.selectedVariant !== detail.selectedVariant ||
      receipt.runtimeReadiness !== "unverified" ||
      receipt.requiresExtraction !== detail.files.some((file) => /\.zip$/iu.test(file.path)) ||
      typeof receipt.fetchedAt !== "string" ||
      !Number.isFinite(Date.parse(receipt.fetchedAt)) ||
      typeof receipt.toolVersion !== "string" ||
      !receipt.toolVersion.trim() ||
      receipt.toolVersion.length > 100
    )
      throw new AcquisitionError("Acquisition cache integrity failure: plan mismatch.");
    let total = 0;
    for (const [index, file] of receipt.files.entries()) {
      const selected = detail.files[index]!;
      if (
        file.path !== selected.path ||
        file.role !== selected.role ||
        file.dependencyOf !== selected.dependencyOf ||
        digest(file.metadata ?? null) !== digest(selected.metadata ?? null) ||
        !Number.isSafeInteger(file.sizeBytes) ||
        file.sizeBytes < 0 ||
        !/^[a-f0-9]{64}$/u.test(file.sha256) ||
        (selected.sizeBytes !== undefined && file.sizeBytes !== selected.sizeBytes)
      )
        throw new AcquisitionError("Acquisition cache integrity failure: file mismatch.");
      let parent = directory;
      for (const segment of file.path.split("/").slice(0, -1)) {
        parent = join(parent, segment);
        const info = await lstat(parent);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new AcquisitionError("Acquisition cache integrity failure: symlink.");
      }
      const path = join(directory, file.path);
      const info = await lstat(path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size !== file.sizeBytes ||
        (await fileHash(path, "sha256", signal)) !== file.sha256 ||
        (selected.md5 && (await fileHash(path, "md5", signal)) !== selected.md5.toLowerCase())
      )
        throw new AcquisitionError("Acquisition cache integrity failure: " + file.path);
      total += info.size;
    }
    if (total > maxBytes)
      throw new AcquisitionError("Cached acquisition exceeds selected byte budget.");
    await validateGltf(directory, detail.files);
    signal.throwIfAborted();
    return result(receipt, true);
  }
  const stage = await mkdtemp(join(storage, ".stage-"));
  try {
    const originals = join(stage, "originals");
    await mkdir(originals, { mode: 0o700 });
    const transfers = downloader.forDirectory(join(stage, "transfers"));
    const files: ReceiptFile[] = [];
    let totalBytes = 0;
    for (const file of detail.files) {
      signal.throwIfAborted();
      if (totalBytes >= maxBytes)
        throw new AcquisitionError("The complete asset exceeds the selected byte budget.");
      const downloaded = await transfers.download({
        provider: detail.asset.provider as DirectAssetProvider,
        url: file.url,
        fileName: "file-" + files.length,
        identity: randomUUID(),
        signal,
        maxBytes: maxBytes - totalBytes,
        ...(file.sizeBytes !== undefined ? { expectedSize: file.sizeBytes } : {}),
        ...(file.md5 ? { expectedMd5: file.md5 } : {}),
      });
      const destination = join(originals, file.path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(downloaded.path, destination, 1);
      totalBytes += downloaded.sizeBytes;
      files.push({
        path: file.path,
        role: file.role,
        sizeBytes: downloaded.sizeBytes,
        sha256: downloaded.sha256,
        ...(file.dependencyOf ? { dependencyOf: file.dependencyOf } : {}),
        ...(file.metadata ? { metadata: file.metadata } : {}),
      });
    }
    await validateGltf(originals, detail.files);
    const receipt: AcquisitionReceipt = {
      schemaVersion: 1,
      assetId: detail.asset.assetId,
      provider: detail.asset.provider,
      nativeId: detail.asset.nativeId,
      sourceUrl: detail.asset.sourceUrl,
      license: detail.asset.license,
      ...(detail.asset.author ? { author: detail.asset.author } : {}),
      ...(detail.asset.apiCredit ? { apiCredit: detail.asset.apiCredit } : {}),
      fetchedAt: new Date().toISOString(),
      toolVersion,
      acknowledgedTermsDigest: digest({ license: detail.asset.license, terms: detail.termsText }),
      planIdentity: identity,
      selectedVariant: detail.selectedVariant,
      runtimeReadiness: "unverified",
      requiresExtraction: detail.files.some((file) => /\.zip$/iu.test(file.path)),
      files,
    };
    const receiptFile = await open(join(originals, "asset.acquisition.json"), "wx", 0o600);
    try {
      await receiptFile.writeFile(JSON.stringify(receipt, null, 2));
      await receiptFile.sync();
    } finally {
      await receiptFile.close();
    }
    signal.throwIfAborted();
    await rename(originals, directory);
    return result(receipt, false);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
