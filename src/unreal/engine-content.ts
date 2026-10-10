import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { ToolchainError } from "./toolchain.js";

export const ENGINE_CONTENT_DIR_ENV = "THREENATIVE_ENGINE_CONTENT_DIR";
export const ENGINE_CONTENT_VERSION_ENV = "THREENATIVE_ENGINE_CONTENT_VERSION";

/** An explicitly configured Engine/Content root, and the Unreal version (`X.Y`) its packages were cooked for. */
export interface EngineContentConfig {
  readonly dir: string;
  readonly version: string;
}

/**
 * The engine content the environment names, or undefined when neither variable is set. The two travel together: a
 * directory without its version (or the reverse) is refused, and the version is never guessed from the directory.
 */
export function engineContentFromEnvironment(environment: NodeJS.ProcessEnv): EngineContentConfig | undefined {
  const dir = environment[ENGINE_CONTENT_DIR_ENV]?.trim() ?? "";
  const version = environment[ENGINE_CONTENT_VERSION_ENV]?.trim() ?? "";
  if (dir === "" && version === "") return undefined;
  if (dir === "" || version === "") {
    throw new ToolchainError(
      "UNREAL_TOOL_UNUSABLE",
      `${ENGINE_CONTENT_DIR_ENV} and ${ENGINE_CONTENT_VERSION_ENV} must be set together; the engine content version is never guessed.`,
    );
  }
  if (!isAbsolute(dir)) {
    throw new ToolchainError("UNREAL_TOOL_UNUSABLE", `${ENGINE_CONTENT_DIR_ENV} must be an absolute path to the Engine/Content directory.`);
  }
  if (!/^\d+\.\d+$/.test(version)) {
    throw new ToolchainError("UNREAL_TOOL_UNUSABLE", `${ENGINE_CONTENT_VERSION_ENV} must be X.Y (for example 5.8), not "${version}".`);
  }
  return { dir, version };
}

/**
 * Refuses a configured engine content root that is not a real directory tree. A link at the root, or any link (file or
 * directory) under it, is an error: the converter reads through links, so skipping one would let the cache key miss bytes
 * the bake reads. Only directory entries are read here, before any content is.
 */
export async function assertEngineContentDirectory(config: EngineContentConfig): Promise<void> {
  // resolve() drops a trailing separator, which would otherwise make lstat follow a linked root.
  const root = resolve(config.dir);
  const info = await lstat(root).catch(() => undefined);
  if (info?.isSymbolicLink()) {
    throw new ToolchainError("UNREAL_TOOL_UNUSABLE", `${ENGINE_CONTENT_DIR_ENV} "${config.dir}" is a symbolic link. Engine content must be a real directory; links are refused, not followed.`);
  }
  if (!info?.isDirectory()) {
    throw new ToolchainError("UNREAL_TOOL_UNUSABLE", `${ENGINE_CONTENT_DIR_ENV} "${config.dir}" is not a readable directory.`);
  }
  await refuseLinksBelow(root);
}

async function refuseLinksBelow(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => {
    throw new ToolchainError("UNREAL_TOOL_UNUSABLE", `Engine content directory "${directory}" could not be read.`);
  });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new ToolchainError("UNREAL_TOOL_UNUSABLE", `Engine content contains a symbolic link at "${path}". Links are refused, not followed or skipped: remove it or copy the target in.`);
    }
    if (entry.isDirectory()) await refuseLinksBelow(path);
  }
}

/** The `X.Y` of an importer engine label (`UE_5.8`) or of a bare version (`5.8`); undefined when neither reads. */
export function engineVersionOf(engine: string | undefined): string | undefined {
  return /^(?:UE_)?(\d+\.\d+)$/.exec(engine?.trim() ?? "")?.[1];
}
