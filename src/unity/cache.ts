import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";

export interface CachedUnityPackage {
  readonly path: string;
  readonly publisher?: string;
  readonly category?: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly modifiedAt: string;
}

/**
 * Where the Unity Editor caches Asset Store downloads (docs.unity.com, Asset Store packages).
 * `ASSETSTORE_CACHE_PATH` overrides it. Local paths only: nothing here contacts Unity.
 */
export function assetStoreCacheRoot(
  options: { environment?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; home?: string } = {},
): string {
  const environment = options.environment ?? process.env;
  const home = options.home ?? homedir();
  const override = environment.ASSETSTORE_CACHE_PATH;
  if (override) return override;
  switch (options.platform ?? process.platform) {
    case "darwin":
      return join(home, "Library", "Unity", "Asset Store-5.x");
    case "win32":
      return join(environment.APPDATA ?? join(home, "AppData", "Roaming"), "Unity", "Asset Store-5.x");
    default:
      return join(home, ".local", "share", "unity3d", "Asset Store-5.x");
  }
}

async function walk(directory: string, found: string[], depth: number): Promise<void> {
  let dirents;
  try {
    dirents = await readdir(directory, { withFileTypes: true });
  } catch {
    return; // missing or unreadable cache: nothing to list
  }
  for (const dirent of dirents) {
    const full = join(directory, dirent.name);
    if (dirent.isDirectory() && depth < 6) await walk(full, found, depth + 1);
    else if (dirent.isFile() && dirent.name.toLowerCase().endsWith(".unitypackage")) found.push(full);
  }
}

/** Lists `*.unitypackage` files under `root`, sorted by path. A missing root gives an empty list. */
export async function listCachedUnityPackages(root: string): Promise<CachedUnityPackage[]> {
  const files: string[] = [];
  await walk(root, files, 0);
  const packages: CachedUnityPackage[] = [];
  for (const file of files.sort()) {
    const info = await stat(file);
    const parts = relative(root, file).split(sep);
    packages.push({
      path: file,
      ...(parts.length >= 3 && parts[0] ? { publisher: parts[0] } : {}),
      ...(parts.length >= 3 && parts[1] ? { category: parts[1] } : {}),
      name: (parts[parts.length - 1] ?? "").replace(/\.unitypackage$/i, ""),
      sizeBytes: info.size,
      modifiedAt: info.mtime.toISOString(),
    });
  }
  return packages;
}
