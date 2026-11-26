import { assetId, AssetSchema, type Asset, type AssetAdapter, type AssetDetail } from "../discovery/types.js";
import { ThreeNativeCatalogClient, ThreeNativeError, type ThreeNativeItem } from "./client.js";

/** PRD-120. The `threenative` provider of `asset_search` / `asset_get` / `asset_download`: ThreeNative's
 * seeded assets with no configuration, plus the Studio cache inside a Studio container. A public seed's
 * native id is its UUID; a Studio cache row's is `studio-<origin>-<uuid>`, so `asset_get` knows the file
 * kind without another search. */

const STUDIO_ID = /^studio-(custom|procedural)-([0-9a-f-]{36})$/u;
const TERMS_PUBLIC =
  "ThreeNative seeded asset, baked from ThreeNative's MIT procedural generators and released as CC0 1.0.";
const TERMS_STUDIO =
  "ThreeNative Studio asset cache: reusable in your ThreeNative games under the ThreeNative Studio Terms.";

const nativeIdOf = (item: ThreeNativeItem): string =>
  item.tier === "public" ? item.id : `studio-${item.origin}-${item.id}`;

function licenseOf(item: ThreeNativeItem): Asset["license"] {
  if (item.tier === "public" && item.license.toUpperCase().startsWith("CC0"))
    return {
      name: "CC0 1.0",
      url: "https://creativecommons.org/publicdomain/zero/1.0/",
      evidence: TERMS_PUBLIC,
      commercialUse: "yes",
      attributionRequired: "no",
    };
  return {
    name: item.tier === "public" ? item.license : "ThreeNative Studio Terms",
    evidence: item.tier === "public" ? `ThreeNative's catalog records ${item.license}.` : TERMS_STUDIO,
    commercialUse: item.tier === "public" ? "unknown" : "yes",
    attributionRequired: "no",
  };
}

function assetOf(client: ThreeNativeCatalogClient, item: ThreeNativeItem, rank: number): Asset {
  const nativeId = nativeIdOf(item);
  const builder = item.tier === "studio" && item.origin === "procedural";
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
    downloadReason: builder
      ? "A Studio procedural builder: asset_download saves its builder.ts and spec.json as one JSON entry, 0 credits."
      : `A ready GLB from ThreeNative's ${item.tier === "public" ? "public catalog" : "Studio cache"}, 0 credits.`,
    providerRank: rank,
    rankingFactors: [item.tier === "public" ? "ThreeNative seed" : "Studio cache", ...(builder ? [] : ["ready GLB"])],
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
      const item: ThreeNativeItem | undefined = studio
        ? {
            author: "ThreeNative Studio",
            hasPreview: false,
            id: studio[2]!,
            license: "ThreeNative Studio asset cache",
            origin: studio[1] as "custom" | "procedural",
            prompt: nativeId,
            tags: "",
            tier: "studio",
            type: "model",
          }
        : await client.publicItem(nativeId, signal);
      if (!item) throw new ThreeNativeError("This ThreeNative asset is not in the public catalog.");
      if (item.tier === "studio" && !client.gateway)
        throw new ThreeNativeError("A Studio cache asset is reachable only inside a ThreeNative Studio game.");
      const asset = assetOf(client, item, 0);
      const builder = item.tier === "studio" && item.origin === "procedural";
      const name = item.slug ?? item.id;
      return {
        asset,
        files: [
          {
            id: "main",
            path: builder ? `${name}.procedural.json` : `${name}.glb`,
            url: client.fileUrl(item),
            role: builder ? "procedural-builder" : "main-model",
          },
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
