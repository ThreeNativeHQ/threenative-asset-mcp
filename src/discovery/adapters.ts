import { AmbientCgClient, type AmbientCgAsset } from "../ambientcg/client.js";
import { ITCH_PACKS } from "../itch/catalog.js";
import { KenneyClient, type KenneyDetail, type KenneyEntry } from "../kenney/client.js";
import { PolyHavenClient, type PolyHavenAsset, type PolyHavenFile } from "../polyhaven/client.js";
import { SketchfabClient, type SketchfabModel } from "../sketchfab/client.js";
import { SmithsonianClient, type SmithsonianFile } from "../smithsonian/client.js";
import { safeRelativePath } from "./acquisition.js";
import {
  assetId,
  AssetSchema,
  type Asset,
  type AssetAdapter,
  type AssetDetail,
  type AssetFile,
  type Selection,
} from "./types.js";

const CC0: Asset["license"] = {
  name: "CC0 1.0",
  url: "https://creativecommons.org/publicdomain/zero/1.0/",
  evidence: "Provider supplies this asset under CC0.",
  commercialUse: "yes",
  attributionRequired: "no",
};
const UNKNOWN: Asset["license"] = {
  name: "Unknown item rights",
  evidence: "No item-specific license permission is available in this provider response.",
  commercialUse: "unknown",
  attributionRequired: "unknown",
};
const typeOf = (type: PolyHavenAsset["type"]): Asset["type"] =>
  type === "models" ? "3d-model" : type === "hdris" ? "hdri" : "texture";

function base(
  provider: string,
  nativeId: string,
  sourceUrl: string,
  title: string,
  type: Asset["type"],
  extra: Partial<Asset>,
): Asset {
  return AssetSchema.parse({
    assetId: assetId(provider, nativeId),
    provider,
    nativeId,
    sourceUrl,
    title,
    type,
    itemKind: "asset",
    free: "unknown",
    license: UNKNOWN,
    downloadStatus: "unknown",
    downloadReason: "Current download capability is unconfirmed.",
    canDownloadNow: false,
    providerRank: 0,
    rankingFactors: [],
    ...extra,
  });
}
function ranked(items: Asset[]): Asset[] {
  return items.map((item, providerRank) => ({ ...item, providerRank }));
}
function matches(query: string, fields: string[]): boolean {
  const text = fields.join(" ").toLowerCase();
  return query
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => text.includes(word));
}
function nativeId(id: string): void {
  if (!/^[a-z0-9][a-z0-9_-]{0,199}$/i.test(id))
    throw new Error("Invalid provider-native asset ID.");
}
function unavailable(
  asset: Asset,
  alternatives: string[],
  explanation: string,
  termsText = asset.license.evidence,
): AssetDetail {
  return {
    asset: {
      ...asset,
      canDownloadNow: false,
      downloadStatus: asset.downloadStatus === "direct" ? "unsupported" : asset.downloadStatus,
      downloadReason: explanation,
    },
    files: [],
    selectedVariant: "none",
    selectionExplanation: explanation,
    alternatives,
    termsText,
  };
}

function polyAsset(item: PolyHavenAsset): Asset {
  return base(
    "polyhaven",
    item.id,
    `https://polyhaven.com/a/${encodeURIComponent(item.id)}`,
    item.name,
    typeOf(item.type),
    {
      free: "yes",
      license: CC0,
      author: Object.keys(item.authors).join(", ").slice(0, 2000),
      apiCredit: "Powered by Poly Haven",
      ...(item.thumbnailUrl ? { thumbnailUrl: item.thumbnailUrl } : {}),
      downloadStatus: "unknown",
      canDownloadNow: false,
      downloadReason:
        "CC0 terms are known; this search candidate's supported files have not yet been checked. asset_get performs that check.",
      rankingFactors: ["known CC0 terms"],
    },
  );
}
function relativePath(path: string): string {
  if (path.split("/").length > 12)
    throw new Error("Provider file path exceeds the dependency depth limit.");
  return safeRelativePath(path);
}
function filename(url: string): string {
  return relativePath(decodeURIComponent(new URL(url).pathname.split("/").at(-1) ?? ""));
}
function extension(url: string): string {
  return filename(url).split(".").at(-1)!.toLowerCase();
}
function resolution(file: PolyHavenFile): string | undefined {
  return file.path
    .split("/")
    .find((part) => /^\d+(?:\.\d+)?k$/i.test(part))
    ?.toLowerCase();
}
function closest(values: string[], preference = "2k"): string | undefined {
  const target = Number.parseFloat(preference);
  return [...new Set(values)].sort(
    (a, b) =>
      Math.abs(Number.parseFloat(a) - target) - Math.abs(Number.parseFloat(b) - target) ||
      Number.parseFloat(a) - Number.parseFloat(b) ||
      a.localeCompare(b),
  )[0];
}
function validatePaths(files: AssetFile[]): void {
  const paths = new Set<string>();
  if (files.length > 128) throw new Error("Provider file plan exceeds the file count limit.");
  for (const file of files) {
    const path = relativePath(file.path).toLowerCase();
    if (
      paths.has(path) ||
      [...paths].some(
        (existing) => existing.startsWith(`${path}/`) || path.startsWith(`${existing}/`),
      )
    )
      throw new Error("Provider file plan contains colliding paths.");
    paths.add(path);
  }
}
function polySelection(asset: Asset, files: PolyHavenFile[], selection: Selection): AssetDetail {
  asset = { ...asset, downloadStatus: "unsupported" };
  const roots = files.filter((file) => !file.dependencyOf);
  const alternatives = [
    ...new Set(roots.map((file) => `${extension(file.url)}/${resolution(file) ?? "original"}`)),
  ].sort();
  let format = selection.format?.toLowerCase().replace(/^\./, "");
  if (format === "jpeg") format = "jpg";
  if (!format)
    format = (
      asset.type === "3d-model"
        ? ["glb", "gltf"]
        : asset.type === "hdri"
          ? ["hdr", "exr"]
          : ["png", "jpg", "exr"]
    ).find((entry) => roots.some((file) => extension(file.url) === entry));
  if (!format)
    return unavailable(asset, alternatives, "No supported original source variant is available.");
  let selected = roots.filter((file) => extension(file.url) === format);
  const resolutions = selected.flatMap((file) => (resolution(file) ? [resolution(file)!] : []));
  const selectedResolution = closest(resolutions, selection.resolution);
  if (
    selection.resolution &&
    resolutions.length &&
    !resolutions.includes(selection.resolution.toLowerCase())
  )
    return unavailable(
      asset,
      alternatives,
      "The requested resolution is unavailable; choose an explicit alternative.",
    );
  selected = selected.filter(
    (file) => !resolution(file) || resolution(file) === selectedResolution,
  );
  if (selection.mapRoles?.length) {
    selected = selected.filter((file) =>
      selection.mapRoles!.some(
        (role) => file.path.split("/")[0]?.toLowerCase() === role.toLowerCase(),
      ),
    );
    if (
      selection.mapRoles.some(
        (role) =>
          !selected.some((file) => file.path.split("/")[0]?.toLowerCase() === role.toLowerCase()),
      )
    )
      return unavailable(
        asset,
        alternatives,
        "At least one explicitly requested map role is unavailable; no partial map set was selected.",
      );
  }
  if (asset.type !== "texture")
    selected = selected
      .sort(
        (a, b) =>
          Number(files.some((file) => file.dependencyOf === b.path)) -
            Number(files.some((file) => file.dependencyOf === a.path)) ||
          a.path.localeCompare(b.path),
      )
      .slice(0, 1);
  if (selected.length === 0)
    return unavailable(
      asset,
      alternatives,
      "The requested format or map roles are unavailable; choose an explicit alternative.",
    );
  const planned: AssetFile[] = [];
  for (const root of selected) {
    const role =
      asset.type === "3d-model"
        ? "main-model"
        : asset.type === "hdri"
          ? "environment"
          : (root.path.split("/")[0] ?? "material");
    planned.push({
      id: root.path,
      path: filename(root.url),
      url: root.url,
      role,
      sizeBytes: root.sizeBytes,
      md5: root.md5,
      ...(asset.type === "texture"
        ? {
            metadata: {
              providerMapRole: role,
              colorSpace: "unknown",
              channel: "unknown",
              normalConvention: "unknown",
            },
          }
        : {}),
    });
    for (const child of files.filter((file) => file.dependencyOf === root.path)) {
      if (!child.relativePath) throw new Error("Provider companion is missing its relative path.");
      planned.push({
        id: child.path,
        path: relativePath(child.relativePath),
        url: child.url,
        role: extension(child.url) === "bin" ? "buffer" : "texture",
        sizeBytes: child.sizeBytes,
        md5: child.md5,
        dependencyOf: root.path,
      });
    }
  }
  validatePaths(planned);
  return {
    asset: {
      ...asset,
      downloadStatus: "direct",
      canDownloadNow: true,
      downloadReason:
        "Selected original files and required companions passed provider metadata checks; acquisition validates the payload before publication.",
    },
    files: planned,
    selectedVariant: `${format}/${selectedResolution ?? "original"}`,
    selectionExplanation: selection.format
      ? "Selected the explicitly requested source format and preserved required companion files."
      : `Preferred ${format.toUpperCase()} original files, then the resolution closest to ${selection.resolution ?? "2k"}; preserved required companions.`,
    alternatives,
    termsText:
      "CC0 1.0 asset license. Poly Haven API requires visible service credit: Powered by Poly Haven.",
  };
}

const AMBIENT_TYPES = ["3d-model", "material", "hdri"];
const AMBIENT_FORMATS = ["zip", "glb", "hdr", "exr", "png", "jpg"];
function ambientAsset(item: AmbientCgAsset): Asset {
  const type: Asset["type"] =
    item.type === "3d-model" ? "3d-model" : item.type === "hdri" ? "hdri" : "texture";
  const supported = item.downloads.some((file) =>
    AMBIENT_FORMATS.includes(file.extension.toLowerCase()),
  );
  return base(
    "ambientcg",
    item.id,
    `https://ambientcg.com/a/${encodeURIComponent(item.id)}`,
    item.title,
    type,
    {
      free: "yes",
      license: CC0,
      ...(item.thumbnailUrl ? { thumbnailUrl: item.thumbnailUrl } : {}),
      downloadStatus: supported ? "direct" : "unsupported",
      canDownloadNow: supported,
      downloadReason: supported
        ? "An official CC0 original download variant is present; archives require extraction by the caller."
        : "No supported original download variant was supplied by the item API.",
      rankingFactors: ["known CC0 terms", ...(supported ? ["original download"] : [])],
    },
  );
}
function smithsonianAsset(item: SmithsonianFile): Asset {
  return base(
    "smithsonian",
    item.modelId,
    `https://3d.si.edu/object/3d/${encodeURIComponent(item.modelId)}`,
    item.title,
    "3d-model",
    {
      downloadStatus: "manual",
      downloadReason:
        "The file API does not establish this item's rights; verify its item rights through the specialized Smithsonian tools.",
      rankingFactors: ["item rights require verification"],
    },
  );
}
function sketchfabAsset(item: SketchfabModel): Asset {
  const slug = item.license?.slug?.toLowerCase();
  const recognized = ["by", "by-sa", "by-nd", "by-nc", "by-nc-sa", "by-nc-nd", "cc0"].includes(
    slug ?? "",
  );
  const license: Asset["license"] = item.license
    ? {
        name: item.license.label,
        ...(item.license.url ? { url: item.license.url } : {}),
        evidence:
          `Item API license: ${item.license.label}. ${item.license.requirements ?? ""}`.slice(
            0,
            2000,
          ),
        commercialUse: recognized ? (slug!.includes("nc") ? "no" : "yes") : "unknown",
        attributionRequired: recognized ? (slug === "cc0" ? "no" : "yes") : "unknown",
      }
    : UNKNOWN;
  return base(
    "sketchfab",
    item.id,
    item.viewerUrl,
    item.name,
    item.animated ? "animation" : "3d-model",
    {
      free: item.downloadable && recognized ? "yes" : "unknown",
      license,
      ...(item.author ? { author: item.author.displayName ?? item.author.username } : {}),
      ...(item.thumbnailUrl ? { thumbnailUrl: item.thumbnailUrl } : {}),
      downloadStatus: item.downloadable ? "auth-required" : "unsupported",
      downloadReason: item.downloadable
        ? "Download URL resolution requires explicit Sketchfab authorization through sketchfab_get_downloads; generic acquisition does not download those authenticated archives."
        : "The item API marks this model non-downloadable.",
      rankingFactors: ["per-item license", "specialized authenticated workflow"],
    },
  );
}
function kenneyAsset(item: KenneyEntry | KenneyDetail): Asset {
  const detail = "licenseConfirmed" in item ? item : undefined;
  return base("kenney", item.id, `https://kenney.nl/assets/${item.id}`, item.title, "3d-model", {
    itemKind: "pack",
    author: "Kenney",
    free: detail?.freeConfirmed ? "yes" : "unknown",
    license: detail?.licenseConfirmed ? { ...CC0, evidence: detail.termsText } : UNKNOWN,
    ...(item.thumbnailUrl ? { thumbnailUrl: item.thumbnailUrl } : {}),
    downloadStatus:
      detail?.downloadUrl && detail.licenseConfirmed && detail.freeConfirmed ? "direct" : "unknown",
    canDownloadNow: !!detail?.downloadUrl && detail.licenseConfirmed && detail.freeConfirmed,
    downloadReason: detail
      ? "Selected pack detail was checked for CC0, explicit free availability and an official ZIP; archive extraction is required."
      : "Listing metadata requires an item detail check before free/license/download capability can be confirmed.",
    rankingFactors: ["official 3D pack", "bounded metadata query"],
  });
}

export interface AssetAdapterClients {
  polyhaven?: PolyHavenClient;
  ambientcg?: AmbientCgClient;
  smithsonian?: SmithsonianClient;
  sketchfab?: SketchfabClient;
  /** Explicit opt-in: live Kenney catalog queries never run by default. */
  kenney?: KenneyClient;
}

export function createAssetAdapters(clients: AssetAdapterClients = {}): AssetAdapter[] {
  const polyhaven = clients.polyhaven ?? new PolyHavenClient();
  const ambientcg = clients.ambientcg ?? new AmbientCgClient();
  const smithsonian = clients.smithsonian ?? new SmithsonianClient();
  const sketchfab = clients.sketchfab ?? new SketchfabClient(fetch, { token: null });
  const adapters: AssetAdapter[] = [
    {
      id: "polyhaven",
      async search(query, types, limit, signal) {
        if (!types.some((type) => ["3d-model", "texture", "hdri"].includes(type)))
          return { items: [], truncated: false };
        const result = (await polyhaven.listAssets("all", { signal })).filter(
          (item) =>
            types.includes(typeOf(item.type)) &&
            matches(query, [item.id, item.name, ...item.tags, item.category ?? ""]),
        );
        const items = result.slice(0, limit).map(polyAsset);
        for (const item of items.slice(0, 3)) {
          const detail = polySelection(
            item,
            await polyhaven.listFiles(item.nativeId, { signal }),
            {},
          );
          Object.assign(item, detail.asset);
        }
        return {
          items: ranked(items),
          truncated: result.length > limit,
          ...(result.length > limit
            ? {
                continuation: {
                  tool: "polyhaven_search_assets",
                  arguments: {
                    query,
                    type: "all",
                    limit: Math.min(100, limit),
                    cursor: String(limit),
                  },
                },
              }
            : {}),
        };
      },
      async get(id, selection, signal) {
        nativeId(id);
        const context = { signal, fresh: true };
        const [item, files] = await Promise.all([
          polyhaven.getAsset(id, context),
          polyhaven.listFiles(id, context),
        ]);
        return polySelection(polyAsset(item), files, selection);
      },
    },
    {
      id: "ambientcg",
      async search(query, types, limit, signal) {
        if (!types.some((type) => ["3d-model", "texture", "hdri"].includes(type)))
          return { items: [], truncated: false };
        const requestedType =
          types.length === 1
            ? types[0] === "3d-model"
              ? "3d-model"
              : types[0] === "hdri"
                ? "hdri"
                : "material"
            : undefined;
        const result = await ambientcg.search(
          {
            query,
            ...(requestedType ? { type: requestedType } : {}),
            sort: "popular",
            limit,
            offset: 0,
            includeDownloads: true,
          },
          { signal },
        );
        const items = result.assets
          .filter((item) => AMBIENT_TYPES.includes(item.type))
          .map(ambientAsset)
          .filter((item) => types.includes(item.type));
        return {
          items: ranked(items.slice(0, limit)),
          truncated: result.nextOffset !== undefined,
          ...(result.nextOffset !== undefined
            ? {
                continuation: {
                  tool: "ambientcg_search_assets",
                  arguments: {
                    query,
                    ...(requestedType ? { type: requestedType } : {}),
                    limit,
                    cursor: String(result.nextOffset),
                  },
                },
              }
            : {}),
        };
      },
      async get(id, selection, signal) {
        nativeId(id);
        const item = await ambientcg.getAsset(id, { signal, fresh: true });
        if (!AMBIENT_TYPES.includes(item.type))
          throw new Error(
            "This ambientCG type is outside generic model/material/environment discovery; use the specialized ambientCG tools.",
          );
        const asset = ambientAsset(item);
        const alternatives = item.downloads.map((file) => `${file.extension}/${file.attributes}`);
        const requested = selection.format?.toLowerCase().replace(/^\./, "");
        const hasResolution = (attributes: string, resolution: string) =>
          attributes
            .toLowerCase()
            .split(/[^a-z0-9]+/u)
            .includes(resolution.toLowerCase());
        const candidates = item.downloads.filter(
          (file) =>
            AMBIENT_FORMATS.includes(file.extension.toLowerCase()) &&
            (!requested || file.extension.toLowerCase() === requested) &&
            (!selection.resolution || hasResolution(file.attributes, selection.resolution)),
        );
        candidates.sort(
          (a, b) =>
            Number(hasResolution(b.attributes, selection.resolution ?? "2k")) -
              Number(hasResolution(a.attributes, selection.resolution ?? "2k")) ||
            a.sizeBytes - b.sizeBytes ||
            a.attributes.localeCompare(b.attributes),
        );
        const selected = candidates[0];
        if (!selected || selection.mapRoles?.length)
          return unavailable(
            asset,
            alternatives,
            "The requested source format, resolution or individual map selection is unavailable; this provider offers complete archives.",
          );
        const path = relativePath(
          new URL(selected.url).searchParams.get("file") ?? filename(selected.url),
        );
        if (extension(`https://ambientcg.com/${path}`) !== selected.extension.toLowerCase())
          throw new Error("ambientCG archive format does not match its filename.");
        return {
          asset,
          files: [
            {
              id: selected.attributes,
              path,
              url: selected.url,
              role: selected.extension.toLowerCase() === "zip" ? "archive" : "source",
              sizeBytes: selected.sizeBytes,
            },
          ],
          selectedVariant: `${selected.extension}/${selected.attributes}`,
          selectionExplanation:
            "Selected an original provider variant, preferring the requested resolution or 2k and preserving archive status.",
          alternatives,
          termsText:
            "ambientCG supplies assets under CC0 1.0; downloaded archives require extraction.",
        };
      },
    },
    {
      id: "smithsonian",
      async search(query, types, limit, signal) {
        if (!types.includes("3d-model")) return { items: [], truncated: false };
        const result = await smithsonian.search(
          new URLSearchParams({ q: query, rows: String(limit), start: "0", file_type: "glb" }),
          { signal },
        );
        const unique = [...new Map(result.files.map((file) => [file.modelId, file])).values()];
        return {
          items: ranked(unique.slice(0, limit).map(smithsonianAsset)),
          truncated: result.totalFiles > limit,
          ...(result.totalFiles > limit
            ? {
                continuation: {
                  tool: "smithsonian_search_assets",
                  arguments: { query, limit, cursor: String(limit) },
                },
              }
            : {}),
        };
      },
      async get(id, _selection, signal) {
        nativeId(id);
        const files = await smithsonian.listFiles(id, { signal, fresh: true });
        const item = files.find((file) => file.modelId === id.replace(/^3d_package:/, ""));
        if (!item) throw new Error("Smithsonian returned no matching item.");
        return unavailable(
          smithsonianAsset(item),
          [...new Set(files.map((file) => file.fileType))],
          "Item-specific rights must be verified before generic acquisition can be planned.",
        );
      },
    },
    {
      id: "sketchfab",
      async search(query, types, limit, signal) {
        if (!types.some((type) => ["3d-model", "animation"].includes(type)))
          return { items: [], truncated: false };
        const result = await sketchfab.search(
          new URLSearchParams({
            q: query,
            type: "models",
            count: String(limit),
            ...(types.length === 1 && types[0] === "animation" ? { animated: "true" } : {}),
          }),
          { signal },
        );
        const items = result.models
          .map(sketchfabAsset)
          .filter((item) => types.includes(item.type) || types.includes("3d-model"));
        return {
          items: ranked(items.slice(0, limit)),
          truncated: !!result.nextCursor,
          ...(result.nextCursor
            ? {
                continuation: {
                  tool: "sketchfab_search_models",
                  arguments: { query, limit, cursor: result.nextCursor },
                },
              }
            : {}),
        };
      },
      async get(id, _selection, signal) {
        nativeId(id);
        const item = await sketchfab.getModel(id, { signal, fresh: true });
        return unavailable(
          sketchfabAsset(item),
          item.archives.map((archive) => archive.format),
          "Use sketchfab_get_downloads for explicitly authorized URL resolution; generic disk acquisition is unavailable.",
        );
      },
    },
  ];
  for (const provider of ["quaternius", "kaykit"]) {
    const packs = ITCH_PACKS.filter(
      (pack) => pack.sourceId === provider && ["animation", "3d-model"].includes(pack.kind),
    );
    const asAsset = (pack: (typeof packs)[number]) =>
      base(provider, pack.id, pack.pageUrl, pack.name, pack.kind as "animation" | "3d-model", {
        itemKind: "pack",
        license: {
          ...CC0,
          evidence:
            "Curated catalog records CC0; current selected upload terms and free availability must be checked with itch_list_downloads.",
        },
        free: "unknown",
        downloadStatus: "manual",
        downloadReason:
          "Continue through the curated itch pack tool to verify the current upload; generic acquisition is unavailable.",
      });
    adapters.push({
      id: provider,
      async search(query, types, limit, signal) {
        signal.throwIfAborted();
        const items = packs.filter(
          (pack) =>
            types.includes(pack.kind as "animation" | "3d-model") &&
            matches(query, [pack.id, pack.name]),
        );
        return {
          items: ranked(items.slice(0, limit).map(asAsset)),
          truncated: items.length > limit,
          ...(items[0]
            ? { continuation: { tool: "itch_list_downloads", arguments: { packId: items[0].id } } }
            : {}),
        };
      },
      async get(id, _selection, signal) {
        signal.throwIfAborted();
        const pack = packs.find((entry) => entry.id === id);
        if (!pack) throw new Error("Curated pack not found.");
        return unavailable(
          asAsset(pack),
          [],
          `Continue with itch_list_downloads using packId ${id}.`,
        );
      },
    });
  }
  if (clients.kenney) {
    const kenney = clients.kenney;
    adapters.push({
      id: "kenney",
      async search(query, types, limit, signal) {
        if (!types.includes("3d-model")) return { items: [], truncated: false };
        const listing = await kenney.search(query, signal);
        const entries = listing.entries.filter((item) => item.category.toLowerCase() === "3d");
        const items: Asset[] = [];
        // ponytail: at most three item checks per query; no catalog census or parallel crawl.
        for (const entry of entries.slice(0, Math.min(limit, 3)))
          items.push(kenneyAsset(await kenney.get(entry.id, signal)));
        return {
          items: ranked(items),
          truncated: listing.truncated || entries.length > items.length,
        };
      },
      async get(id, selection, signal) {
        const item = await kenney.get(id, signal);
        if (item.category.toLowerCase() !== "3d")
          throw new Error("Kenney discovery currently supports only 3D packs.");
        const asset = kenneyAsset(item);
        if (
          !item.downloadUrl ||
          !asset.canDownloadNow ||
          (selection.format && selection.format.toLowerCase() !== "zip") ||
          selection.resolution ||
          selection.mapRoles?.length
        )
          return unavailable(
            asset,
            item.downloadUrl ? ["zip/original-pack"] : [],
            "A verified CC0, free, official 3D-pack ZIP is required; format/resolution/map substitutions are unsupported.",
            item.termsText,
          );
        return {
          asset,
          files: [
            {
              id: "original-pack",
              path: filename(item.downloadUrl),
              url: item.downloadUrl,
              role: "archive",
            },
          ],
          selectedVariant: "zip/original-pack",
          selectionExplanation:
            "Original official pack archive; extraction and runtime readiness remain unverified.",
          alternatives: ["zip/original-pack"],
          termsText: item.termsText,
        };
      },
    });
  }
  return adapters;
}
