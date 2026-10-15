import { extname } from "node:path/posix";

import type { UnityAssetDatabase } from "./package.js";

export const UNITY_KINDS = ["model", "texture", "material", "prefab", "shaderGraph", "scene", "other"] as const;
export type UnityKind = (typeof UNITY_KINDS)[number];

const BY_EXTENSION: Record<string, UnityKind> = {
  ".fbx": "model", ".obj": "model", ".dae": "model", ".3ds": "model", ".blend": "model", ".gltf": "model",
  ".glb": "model", ".stl": "model", ".ply": "model", ".max": "model", ".ma": "model", ".mb": "model",
  ".png": "texture", ".jpg": "texture", ".jpeg": "texture", ".tga": "texture", ".psd": "texture",
  ".tif": "texture", ".tiff": "texture", ".bmp": "texture", ".exr": "texture", ".hdr": "texture",
  ".gif": "texture", ".dds": "texture",
  ".mat": "material",
  ".prefab": "prefab",
  ".shadergraph": "shaderGraph", ".shadersubgraph": "shaderGraph",
  ".unity": "scene",
};

export function unityKind(path: string): UnityKind {
  return BY_EXTENSION[extname(path).toLowerCase()] ?? "other";
}

export type UnityInventory = Record<UnityKind, number> & { readonly previews: number };

/** Counts assets per kind. Folder assets (no content) are not assets and are not counted. */
export function inventoryUnityAssets(database: Pick<UnityAssetDatabase, "entries">): UnityInventory {
  const counts: Record<UnityKind, number> = { model: 0, texture: 0, material: 0, prefab: 0, shaderGraph: 0, scene: 0, other: 0 };
  let previews = 0;
  for (const entry of database.entries.values()) {
    if (entry.assetFile === undefined) continue;
    counts[unityKind(entry.path)] += 1;
    if (entry.previewFile !== undefined) previews += 1;
  }
  return { ...counts, previews };
}
