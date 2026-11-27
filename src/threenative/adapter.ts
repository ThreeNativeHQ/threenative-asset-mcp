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

function assetOf(client: ThreeNativeCatalogClient, item: ThreeNativeItem, rank: number): Asset {
  const nativeId = nativeIdOf(item);
  const builder = isBuilder(item);
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
      const asset = assetOf(client, item, 0);
      const builder = isBuilder(item);
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
