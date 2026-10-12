/**
 * PRD-581 Phase 1 census: for every owned Unreal content listing, read its oldest artifact's
 * download manifest from Epic's CDN and report the download size, file count and file-name class
 * hints. It downloads manifest metadata only, never package content, and it writes its report to
 * `--out` (which must be outside the checkout) because the report carries licensed pack names.
 *
 *   npx tsx scripts/fab-census.ts --out <dir>
 *
 * Signed manifest URLs expire and are never stored; they are read into memory only long enough to
 * fetch the manifest body. Credentials are read through the existing `FabCli` client, never here.
 */
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inflateSync } from "node:zlib";

import { FabCli, assertCatalogId, type FabOwnedListing, type FabUnrealVersion } from "../src/fab/fabcli.js";
import { compareEngines, decoderRoute, oldestEngine, type DecoderRoute } from "../src/fab/routes.js";
import { runBounded } from "../src/unreal/toolchain.js";

/** Epic binary manifest magic; the byte order makes this `0x44BEC00C` little-endian. */
export const BINARY_MANIFEST_MAGIC = 0x44bec00c;
const STORED_COMPRESSED = 0b01;
const STORED_ENCRYPTED = 0b10;
const MANIFEST_HEADER_SIZE = 41;
const USER_AGENT = "threenative-asset-mcp-fab-census/0.1";
const CONTENT_METHODS = Object.freeze(["ASSET_PACK", "COMPLETE_PROJECT"]);
const USAGE = "usage: npx tsx scripts/fab-census.ts --out <dir outside the checkout>";

export interface CensusClassHints {
  readonly [className: string]: number;
}

export interface ManifestSummary {
  /** Which of the two Epic manifest encodings was read. */
  readonly format: "json" | "binary";
  /** Files listed by the manifest. */
  readonly fileCount: number;
  /** Sum of the manifest's unique chunk file sizes: the download size, not the install size. */
  readonly downloadBytes: number;
  /** Counts of package names by a best-effort class hint from the file name. */
  readonly classHints: CensusClassHints;
}

export interface CensusEntry {
  readonly listingId: string;
  readonly listingPrefix: string;
  readonly title: string;
  readonly distributionMethod: string;
  readonly artifactId: string;
  readonly oldestEngine: string | undefined;
  readonly route: DecoderRoute | "unknown";
  readonly engines: readonly string[];
  readonly manifest: ManifestSummary | null;
  readonly error?: string;
}

export interface CensusReport {
  readonly generatedAt: string;
  readonly backend: "fabcli-manifest";
  readonly downloadsContent: false;
  readonly out: string;
  readonly listings: readonly CensusEntry[];
  readonly excluded: Readonly<Record<string, number>>;
  readonly totals: {
    readonly listings: number;
    readonly fileCount: number;
    readonly downloadBytes: number;
    readonly downloadMiB: number;
  };
}

// --- byte-blob decoding -------------------------------------------------------------------------

/**
 * Epic's JSON manifest stores integers as the raw little-endian bytes, each byte written as a
 * zero-padded 3-digit decimal group. "000180006000" is bytes [0, 180, 6, 0], the uint32 439296.
 */
export function decodeByteBlob(value: string): bigint {
  if (value.length === 0 || value.length % 3 !== 0 || !/^\d+$/.test(value)) {
    throw new Error(`"${value}" is not a fixed-width 3-digit decimal byte blob`);
  }
  let result = 0n;
  for (let end = value.length; end > 0; end -= 3) {
    const byte = Number(value.slice(end - 3, end));
    if (byte > 255) throw new Error(`"${value}" has a byte above 255`);
    result = (result << 8n) | BigInt(byte);
  }
  return result;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// --- class hints --------------------------------------------------------------------------------

/**
 * Best-effort class from a package file name. File names are hints only: a `.uasset` name does not
 * carry its class, and a pack that ships inside a `.pak` reveals none at all. The rules are the UE
 * naming conventions the feature PRDs care about; anything unrecognised is counted, not guessed.
 */
export function classifyFileName(fileName: string): string {
  const base = basename(fileName);
  const ext = extname(base).toLowerCase().replace(/^\./, "");
  if (ext === "umap") return "Map";
  if (ext === "pak") return "Pak";
  if (ext !== "uasset") return ext === "" ? "OtherFile" : `Other:${ext}`;
  const stem = base.slice(0, base.length - extname(base).length);
  if (/_Physics(Asset)?$/i.test(stem)) return "PhysicsAsset";
  if (/_Skeleton$/i.test(stem)) return "Skeleton";
  if (/(_AnimBlueprint|_AnimBP)$/i.test(stem)) return "AnimBlueprint";
  if (/(_PoseAsset|_Pose)$/i.test(stem)) return "PoseAsset";
  if (/Montage/i.test(stem)) return "AnimMontage";
  if (/(^Aim_|AimOffset|_Aim$)/i.test(stem)) return "AimOffset";
  if (/BlendSpace|Blend_Space|_BS$/i.test(stem)) return "BlendSpace";
  if (/(^NS_|^NE_|Niagara)/i.test(stem)) return "NiagaraSystem";
  if (/(^P_|^PS_|^PGPU_|ParticleSystem|Cascade)/i.test(stem)) return "ParticleSystem";
  if (/(^SC_|_Cue$|SoundCue)/i.test(stem)) return "SoundCue";
  if (/(^SM_|StaticMesh)/i.test(stem)) return "StaticMesh";
  if (/(^SK_|^SKM_|SkeletalMesh)/i.test(stem)) return "SkeletalMesh";
  if (/^MI_/.test(stem)) return "MaterialInstance";
  if (/^M_/.test(stem)) return "Material";
  if (/^T_/.test(stem)) return "Texture";
  if (/^BP_/.test(stem)) return "Blueprint";
  return "OtherUasset";
}

export function classHintsFor(fileNames: readonly string[]): CensusClassHints {
  const hints: Record<string, number> = {};
  for (const name of fileNames) {
    const key = classifyFileName(name);
    hints[key] = (hints[key] ?? 0) + 1;
  }
  return hints;
}

// --- JSON manifest ------------------------------------------------------------------------------

/** The JSON encoding's file entry: `Filename` and a `FileChunkParts` array. */
function jsonFileNames(list: readonly unknown[]): string[] {
  const names: string[] = [];
  for (const entry of list) {
    const record = asRecord(entry);
    const name = record?.Filename ?? record?.FileName ?? record?.filename;
    if (typeof name === "string" && name.length > 0) names.push(name);
  }
  return names;
}

function jsonChunkParts(entry: unknown): readonly Record<string, unknown>[] {
  const record = asRecord(entry);
  const parts = record?.FileChunkParts ?? record?.SharedFileChunkParts;
  return Array.isArray(parts) ? parts.flatMap((part) => (asRecord(part) ? [asRecord(part)!] : [])) : [];
}

export function parseJsonManifest(root: unknown): ManifestSummary {
  const manifest = asRecord(root);
  if (!manifest) throw new Error("the JSON manifest is not an object");
  const list = Array.isArray(manifest.FileManifestList) ? manifest.FileManifestList : [];
  const names = jsonFileNames(list);
  const sizes = asRecord(manifest.ChunkFilesizeList);
  let downloadBytes = 0;
  if (sizes) {
    const seen = new Set<string>();
    for (const [guid, blob] of Object.entries(sizes)) {
      if (seen.has(guid) || typeof blob !== "string") continue;
      seen.add(guid);
      downloadBytes += Number(decodeByteBlob(blob));
    }
  } else {
    // Older JSON manifests keep no per-chunk size table; the unique chunk parts' sizes are the
    // download, since a file references a byte range of a shared chunk.
    const seen = new Set<string>();
    for (const entry of list) {
      for (const part of jsonChunkParts(entry)) {
        const guid = part.Guid ?? part.guid;
        const size = part.Size ?? part.size;
        if (typeof guid !== "string" || typeof size !== "string" || seen.has(guid)) continue;
        seen.add(guid);
        downloadBytes += Number(decodeByteBlob(size));
      }
    }
  }
  return { format: "json", fileCount: list.length, downloadBytes, classHints: classHintsFor(names) };
}

// --- binary manifest ----------------------------------------------------------------------------

class ByteReader {
  position = 0;
  constructor(readonly buffer: Buffer) {}

  #need(bytes: number): void {
    if (this.position + bytes > this.buffer.length) {
      throw new Error(`the binary manifest ended after ${this.buffer.length} bytes`);
    }
  }

  skip(bytes: number): void {
    this.#need(bytes);
    this.position += bytes;
  }

  seek(position: number): void {
    if (position < 0 || position > this.buffer.length) throw new Error("binary manifest seek out of range");
    this.position = position;
  }

  u8(): number {
    this.#need(1);
    return this.buffer.readUInt8(this.position++);
  }

  i32(): number {
    this.#need(4);
    const value = this.buffer.readInt32LE(this.position);
    this.position += 4;
    return value;
  }

  u32(): number {
    this.#need(4);
    const value = this.buffer.readUInt32LE(this.position);
    this.position += 4;
    return value;
  }

  u64(): bigint {
    this.#need(8);
    const value = this.buffer.readBigUInt64LE(this.position);
    this.position += 8;
    return value;
  }

  /** An FString: a uint32 length that includes the trailing NUL, then the UTF-8 bytes. */
  fstring(): string {
    const length = this.u32();
    if (length === 0) return "";
    this.#need(length);
    const value = this.buffer.toString("utf8", this.position, this.position + length - 1);
    this.position += length;
    return value;
  }

  fstringArray(): string[] {
    const count = this.u32();
    const values: string[] = [];
    for (let index = 0; index < count; index++) values.push(this.fstring());
    return values;
  }
}

/**
 * Reads the sections the census needs from an uncompressed body: skip the metadata, sum the chunk
 * data list's file sizes, then read the file manifest list's names. Sections are length-prefixed by
 * `DataSize`, which counts from just before that field, so each section can be stepped over.
 */
function readBinaryBody(body: Buffer): { fileCount: number; downloadBytes: number; fileNames: string[] } {
  const reader = new ByteReader(body);

  const metaStart = reader.position;
  const metaSize = reader.u32();
  reader.skip(1); // DataVersion
  reader.i32(); // FeatureLevel
  reader.skip(1); // IsFileData
  reader.i32(); // AppID
  reader.fstring(); // AppName
  reader.fstring(); // BuildVersion
  reader.fstring(); // LaunchExe
  reader.fstring(); // LaunchCommand
  reader.fstringArray(); // PrereqIds
  reader.fstring(); // PrereqName
  reader.fstring(); // PrereqPath
  reader.fstring(); // PrereqArgs
  reader.seek(metaStart + metaSize);

  const chunkStart = reader.position;
  const chunkSize = reader.u32();
  reader.skip(1); // DataVersion
  const chunkCount = reader.u32();
  reader.skip(chunkCount * 16); // GUIDs
  reader.skip(chunkCount * 8); // hashes
  reader.skip(chunkCount * 20); // SHA-1s
  reader.skip(chunkCount * 1); // groups
  reader.skip(chunkCount * 4); // window sizes
  let downloadBytes = 0n;
  for (let index = 0; index < chunkCount; index++) downloadBytes += reader.u64();
  reader.seek(chunkStart + chunkSize);

  reader.u32(); // file manifest DataSize
  reader.skip(1); // DataVersion
  const fileCount = reader.u32();
  const fileNames: string[] = [];
  for (let index = 0; index < fileCount; index++) fileNames.push(reader.fstring());

  return { fileCount, downloadBytes: Number(downloadBytes), fileNames };
}

export function parseBinaryManifest(buffer: Buffer): ManifestSummary {
  const reader = new ByteReader(buffer);
  if (reader.u32() !== BINARY_MANIFEST_MAGIC) {
    throw new Error(`not an Epic binary manifest (magic was not 0x${BINARY_MANIFEST_MAGIC.toString(16)})`);
  }
  const headerSize = reader.i32();
  const sizeUncompressed = reader.i32();
  const sizeCompressed = reader.i32();
  reader.skip(20); // SHA-1 of the body
  const storedAs = reader.u8();
  reader.i32(); // feature level
  if (storedAs & STORED_ENCRYPTED) throw new Error("the manifest is encrypted");
  reader.seek(headerSize > 0 ? headerSize : MANIFEST_HEADER_SIZE);
  const compressed = buffer.subarray(reader.position, reader.position + sizeCompressed);
  const body =
    (storedAs & STORED_COMPRESSED) !== 0
      ? inflateSync(compressed, { maxOutputLength: sizeUncompressed + 1 })
      : buffer.subarray(reader.position);
  const parsed = readBinaryBody(body);
  return {
    format: "binary",
    fileCount: parsed.fileCount,
    downloadBytes: parsed.downloadBytes,
    classHints: classHintsFor(parsed.fileNames),
  };
}

/** Parses either manifest encoding, dispatching on the binary magic. */
export function parseManifest(bytes: Uint8Array): ManifestSummary {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.length >= 4 && buffer.readUInt32LE(0) === BINARY_MANIFEST_MAGIC) {
    return parseBinaryManifest(buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new Error("the manifest is neither the binary magic nor valid JSON");
  }
  return parseJsonManifest(parsed);
}

// --- selection ----------------------------------------------------------------------------------

/** The artifact whose oldest listed engine is the oldest; the first listed wins a tie. */
export function selectOldestArtifact(
  artifacts: readonly FabUnrealVersion[],
): { readonly artifact: FabUnrealVersion; readonly oldestEngine: string | undefined } | undefined {
  let best: { artifact: FabUnrealVersion; oldestEngine: string | undefined } | undefined;
  for (const artifact of artifacts) {
    const oldest = oldestEngine(artifact.engineVersions);
    if (!best) {
      best = { artifact, oldestEngine: oldest };
      continue;
    }
    if (oldest === undefined) continue;
    if (best.oldestEngine === undefined || compareEngines(oldest, best.oldestEngine) < 0) {
      best = { artifact, oldestEngine: oldest };
    }
  }
  return best;
}

// --- manifest fetch -----------------------------------------------------------------------------

interface DistributionPoint {
  readonly manifestUrl: string;
}

/**
 * Runs `fabcli manifest` for one artifact and returns the signed manifest URLs, which live only in
 * memory. Reuses the existing `FabCli` tool resolution and `runBounded`; it adds no new subcommand
 * to the MCP server's allow-list.
 */
async function manifestUrls(
  toolPath: string,
  listing: FabOwnedListing,
  artifact: FabUnrealVersion,
): Promise<DistributionPoint[]> {
  const args = [
    "manifest",
    "--artifact-id",
    assertCatalogId(artifact.artifactId, "artifact id"),
    "--namespace",
    assertCatalogId(listing.assetNamespace ?? "", "asset namespace"),
    "--asset-id",
    assertCatalogId(listing.assetId ?? "", "asset id"),
  ];
  const run = await runBounded(toolPath, args, { timeoutMs: 180_000 });
  if (run.code !== 0) {
    const detail = (run.stderr.trim() || run.stdout.trim()).slice(0, 300);
    throw new Error(`fabcli manifest exited ${run.code}${detail ? `: ${detail}` : ""}`);
  }
  const parsed: unknown = JSON.parse(run.stdout);
  if (!Array.isArray(parsed)) throw new Error("fabcli manifest did not return an array");
  const first = asRecord(parsed[0]);
  const points = first?.distributionPoints;
  if (!Array.isArray(points)) throw new Error("fabcli manifest returned no distribution points");
  return points.flatMap((point) => {
    const url = asRecord(point)?.manifestUrl;
    return typeof url === "string" && url.length > 0 ? [{ manifestUrl: url }] : [];
  });
}

async function fetchManifest(points: readonly DistributionPoint[]): Promise<Uint8Array> {
  let lastError: unknown;
  for (const point of points) {
    try {
      const response = await fetch(point.manifestUrl, {
        headers: { "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error(`the manifest URL returned HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("no manifest URL could be fetched");
}

// --- report -------------------------------------------------------------------------------------

export function censusLine(entry: CensusEntry): string {
  const size = entry.manifest ? `${(entry.manifest.downloadBytes / 1024 / 1024).toFixed(1)} MiB` : "?";
  const files = entry.manifest ? `${entry.manifest.fileCount} files` : entry.error ?? "error";
  const hints = entry.manifest
    ? Object.entries(entry.manifest.classHints)
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => `${name} ${count}`)
        .join(", ")
    : "";
  return `${entry.listingPrefix} ${entry.artifactId} ${entry.oldestEngine ?? "no engine"} ${size} ${files}${hints ? ` | ${hints}` : ""}`;
}

export function buildReport(entries: readonly CensusEntry[], out: string, excluded: Record<string, number>): CensusReport {
  const totals = entries.reduce(
    (sum, entry) => ({
      listings: sum.listings + 1,
      fileCount: sum.fileCount + (entry.manifest?.fileCount ?? 0),
      downloadBytes: sum.downloadBytes + (entry.manifest?.downloadBytes ?? 0),
    }),
    { listings: 0, fileCount: 0, downloadBytes: 0 },
  );
  return {
    generatedAt: new Date().toISOString(),
    backend: "fabcli-manifest",
    downloadsContent: false,
    out,
    listings: entries,
    excluded,
    totals: { ...totals, downloadMiB: Math.round((totals.downloadBytes / 1024 / 1024) * 10) / 10 },
  };
}

// --- CLI ----------------------------------------------------------------------------------------

interface CliOptions {
  readonly out: string;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  const index = argv.indexOf("--out");
  const out = index >= 0 ? argv[index + 1] : undefined;
  if (!out || out.startsWith("--")) throw new Error(`--out <dir> is required\n${USAGE}`);
  return { out: resolve(out) };
}

/** The checkout this script lives in; `--out` must not land under it. */
function checkoutRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

export function assertOutsideCheckout(out: string, root: string = checkoutRoot()): void {
  const absolute = isAbsolute(out) ? out : resolve(out);
  if (absolute === root || absolute.startsWith(root + sep)) {
    throw new Error(`--out must be outside the checkout (${root}); refusing to write the census into the repository`);
  }
}

async function main(): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
    assertOutsideCheckout(options.out);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const fabCli = new FabCli({ environment: process.env, log: (message) => console.error(message) });
  try {
    await fabCli.requireAuthenticatedSession();
  } catch (error) {
    console.error(`Fab session unusable: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const tool = await fabCli.tool();
  const owned = await fabCli.ownedListings();

  const excluded: Record<string, number> = {};
  const content: FabOwnedListing[] = [];
  for (const listing of owned) {
    if (listing.unrealArtifacts.length === 0) continue;
    if (!CONTENT_METHODS.includes(listing.distributionMethod)) {
      excluded[listing.distributionMethod] = (excluded[listing.distributionMethod] ?? 0) + 1;
      continue;
    }
    content.push(listing);
  }

  const entries: CensusEntry[] = [];
  for (const listing of content) {
    const selected = selectOldestArtifact(listing.unrealArtifacts);
    if (!selected) continue;
    const listingId = listing.listingId ?? "";
    const base: Omit<CensusEntry, "manifest" | "error"> = {
      listingId,
      listingPrefix: listingId.slice(0, 8).toLowerCase(),
      title: listing.title,
      distributionMethod: listing.distributionMethod,
      artifactId: selected.artifact.artifactId,
      oldestEngine: selected.oldestEngine,
      route: selected.oldestEngine === undefined ? "unknown" : decoderRoute(selected.oldestEngine),
      engines: selected.artifact.engineVersions,
    };
    try {
      const urls = await manifestUrls(tool.path, listing, selected.artifact);
      const bytes = await fetchManifest(urls);
      const manifest = parseManifest(bytes);
      entries.push({ ...base, manifest });
      console.log(censusLine({ ...base, manifest }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      entries.push({ ...base, manifest: null, error: message });
      console.error(`${base.listingPrefix} ${base.artifactId} FAILED: ${message}`);
    }
  }

  const report = buildReport(entries, options.out, excluded);
  await mkdir(options.out, { recursive: true });
  const reportPath = join(options.out, "fab-census.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `\n${report.totals.listings} listing(s), ${report.totals.fileCount} files, ${report.totals.downloadMiB} MiB download; report at ${reportPath}`,
  );
  const failures = entries.filter((entry) => entry.manifest === null).length;
  return failures > 0 ? 1 : 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error);
      process.exit(1);
    },
  );
}
