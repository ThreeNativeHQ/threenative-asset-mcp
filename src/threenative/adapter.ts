import { createHash } from "node:crypto";
import {
  assetId,
  AssetSchema,
  type Asset,
  type AssetAdapter,
  type AssetDetail,
  type AssetFile,
} from "../discovery/types.js";
import {
  ThreeNativeCatalogClient,
  ThreeNativeError,
  type ThreeNativeItem,
  type ThreeNativeManifest,
} from "./client.js";

/** PRD-120. The `threenative` provider of `asset_search` / `asset_get` / `asset_download`: ThreeNative's
 * seeded assets with no configuration, plus the Studio cache inside a Studio container. A public seed's
 * native id is its UUID; a Studio cache row's is `studio-<origin>-<uuid>`, so `asset_get` knows the file
 * kind without another search. */

const STUDIO_ID = /^studio-(custom|procedural)-([0-9a-f-]{36})$/u;
const TERMS_PUBLIC =
  "ThreeNative seeded asset, baked from ThreeNative's MIT procedural generators and released as CC0 1.0.";
const TERMS_STUDIO =
  "ThreeNative Studio asset cache: reusable in your ThreeNative games under the ThreeNative Studio Terms.";

const STUDIO_LICENSE = "ThreeNative Studio asset cache";

const nativeIdOf = (item: ThreeNativeItem): string =>
  item.tier === "public" ? item.id : `studio-${item.origin}-${item.id}`;

/** The license the server recorded. A Studio row with none of its own falls under the Studio Terms. */
function licenseOf(item: ThreeNativeItem): Asset["license"] {
  const recorded = item.tier === "public" || item.license !== STUDIO_LICENSE;
  if (recorded && item.license.toUpperCase().startsWith("CC0"))
    return {
      name: "CC0 1.0",
      url: "https://creativecommons.org/publicdomain/zero/1.0/",
      evidence: TERMS_PUBLIC,
      commercialUse: "yes",
      attributionRequired: "no",
    };
  return {
    name: recorded ? item.license : "ThreeNative Studio Terms",
    evidence: recorded ? `ThreeNative's catalog records ${item.license}.` : TERMS_STUDIO,
    commercialUse: recorded ? "unknown" : "yes",
    // A CC-BY license requires credit; any other recorded license is not read here, so it stays unknown.
    attributionRequired: !recorded ? "no" : /^CC[- ]?BY/iu.test(item.license) ? "yes" : "unknown",
  };
}

/** A legacy builder entry (JSON), only when the server says so. A Worker that predates `format` named no
 * representation: there a Studio `procedural` row keeps the old reading. */
const isBuilder = (item: ThreeNativeItem): boolean =>
  item.format !== undefined
    ? item.format === "procedural-json"
    : item.tier === "studio" && item.origin === "procedural";

/** What `asset_download` saves. Only a row the Worker recorded complete is called a ready GLB; an older one
 * is still checked texture by texture and buffer by buffer before anything is saved. */
function reasonOf(item: ThreeNativeItem, builder: boolean): string {
  const where = item.tier === "public" ? "public catalog" : "Studio cache";
  if (builder)
    return "A Studio procedural builder: asset_download saves its builder.ts and spec.json as one JSON entry, 0 credits.";
  if (item.completeness !== "complete")
    return `A GLB from ThreeNative's ${where} whose completeness ThreeNative has not recorded (an older entry): asset_download checks every texture and buffer it names before it saves it, 0 credits.`;
  const members = item.memberCount ?? 0;
  return `A complete, self-contained GLB from ThreeNative's ${where}${
    members > 0
      ? ` with ${members} companion files (source textures, reports, license and receipts) saved under companions/`
      : ""
  }, 0 credits.`;
}

function assetOf(client: ThreeNativeCatalogClient, item: ThreeNativeItem, rank: number): Asset {
  const nativeId = nativeIdOf(item);
  const builder = isBuilder(item);
  const ready = !builder && item.completeness === "complete";
  return AssetSchema.parse({
    assetId: assetId("threenative", nativeId),
    provider: "threenative",
    nativeId,
    sourceUrl: client.fileUrl(item),
    title: item.prompt.slice(0, 500) || item.id,
    type: "3d-model",
    itemKind: "asset",
    free: "yes",
    license: licenseOf(item),
    author: item.author,
    ...(item.hasPreview ? { thumbnailUrl: `${client.fileUrl(item)}/preview` } : {}),
    downloadStatus: "direct",
    canDownloadNow: true,
    downloadReason: reasonOf(item, builder),
    providerRank: rank,
    rankingFactors: [item.tier === "public" ? "ThreeNative seed" : "Studio cache", ...(ready ? ["ready GLB"] : [])],
  });
}

export function threenativeAdapter(client = new ThreeNativeCatalogClient()): AssetAdapter {
  return {
    id: "threenative",
    async search(query, types, limit, signal) {
      if (!types.includes("3d-model")) return { items: [], truncated: false };
      const items = await client.search(query, "model", limit + 1, signal);
      return {
        items: items.slice(0, limit).map((item, rank) => assetOf(client, item, rank)),
        truncated: items.length > limit,
      };
    },
    async get(nativeId, _selection, signal): Promise<AssetDetail> {
      const studio = STUDIO_ID.exec(nativeId);
      if (studio && !client.gateway)
        throw new ThreeNativeError("A Studio cache asset is reachable only inside a ThreeNative Studio game.");
      const origin = studio?.[1] as "custom" | "procedural" | undefined;
      // A Studio row's facts come from the Worker (HEAD); a Worker that predates them keeps the old placeholder.
      const item: ThreeNativeItem | undefined = studio
        ? ((await client.studioItem(studio[2]!, origin ?? "custom", signal)) ?? {
            author: "ThreeNative Studio",
            hasPreview: false,
            id: studio[2]!,
            license: STUDIO_LICENSE,
            origin: origin ?? "custom",
            prompt: nativeId,
            tags: "",
            tier: "studio",
            type: "model",
          })
        : await client.publicItem(nativeId, signal);
      if (!item) throw new ThreeNativeError("This ThreeNative asset is not in the public catalog.");
      const builder = isBuilder(item);
      const name = item.slug ?? item.id;
      const companions = builder ? { files: [] } : await companionFiles(client, item, signal);
      const asset = withEvidence(assetOf(client, item, 0), companions);
      return {
        asset,
        files: [
          {
            id: "main",
            path: builder ? `${name}.procedural.json` : `${name}.glb`,
            url: client.fileUrl(item),
            role: builder ? "procedural-builder" : "main-model",
          },
          ...companions.files,
        ],
        selectedVariant: builder ? "json/procedural-builder" : "glb/original",
        selectionExplanation: builder
          ? "The Studio cache answers a procedural row as its builder and spec in one JSON entry."
          : "The one baked GLB ThreeNative stores for this asset.",
        alternatives: [],
        termsText: asset.license.evidence,
      };
    },
  };
}

/** The manifest and every companion member the Worker lists, each saved under `companions/` with its
 * hash, so the download checks it byte for byte. A row that names members it cannot list is refused:
 * a declared file never goes missing quietly. */
async function companionFiles(
  client: ThreeNativeCatalogClient,
  item: ThreeNativeItem,
  signal: AbortSignal,
): Promise<{ files: AssetFile[]; manifest?: ThreeNativeManifest }> {
  if ((item.memberCount ?? 0) === 0) return { files: [] };
  const read = await client.manifest(item, signal);
  if (!read || read.manifest.members.length !== item.memberCount)
    throw new ThreeNativeError("This ThreeNative asset's companion files could not be listed.");
  const base = client.fileUrl(item);
  const sha256 = createHash("sha256").update(read.bytes).digest("hex");
  return {
    files: [
      {
        id: "companion-manifest",
        path: "companions/manifest.json",
        url: `${base}/manifest`,
        role: "companion-manifest",
        sizeBytes: read.bytes.byteLength,
        dependencyOf: "main",
        metadata: { sha256 },
      },
      ...read.manifest.members.map(
        (member): AssetFile => ({
          id: `companion-${member.index}`,
          path: `companions/${member.path}`,
          url: `${base}/members/${member.index}`,
          role: `companion-${member.role}`,
          sizeBytes: member.bytes,
          dependencyOf: "main",
          metadata: { sha256: member.sha256, companionRole: member.role },
        }),
      ),
    ],
    manifest: read.manifest,
  };
}

/** The license as the preserved evidence states it: the source's license URL, and where its own document
 * and original receipt are kept. */
function withEvidence(
  asset: Asset,
  companions: { files: AssetFile[]; manifest?: ThreeNativeManifest },
): Asset {
  const at = (role: string) => companions.files.find((file) => file.metadata?.companionRole === role)?.path;
  const document = at("license");
  const receipt = at("source-receipt");
  const url = companions.manifest?.provenance?.license?.url;
  if (!document && !receipt && !url) return asset;
  const kept = [
    ...(document ? [`the license document at ${document}`] : []),
    ...(receipt ? [`the original acquisition receipt at ${receipt}`] : []),
  ];
  return AssetSchema.parse({
    ...asset,
    license: {
      ...asset.license,
      ...(url ? { url } : {}),
      evidence: `${asset.license.evidence}${kept.length ? ` ThreeNative keeps ${kept.join(" and ")}.` : ""}`.slice(0, 2000),
    },
  });
}
