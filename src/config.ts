import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import { z } from "zod";

const BooleanEnvironmentValue = z
  .enum(["0", "1", "false", "true"])
  .transform((value) => value === "1" || value === "true");

const EnvironmentSchema = z.object({
  FAB_DIRECT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(20_000),
  FAB_BROWSER_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(180_000)
    .default(30_000),
  FAB_BROWSER_MANUAL_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(120_000)
    .default(10_000),
  FAB_BROWSER_HEADLESS: BooleanEnvironmentValue.default(true),
  FAB_BROWSER_PROFILE_DIR: z.string().trim().min(1).optional(),
  FAB_DOWNLOAD_DIR: z.string().trim().min(1).optional(),
  FAB_MAX_DOWNLOAD_BYTES: z.coerce
    .number()
    .int()
    .min(1_048_576)
    .max(21_474_836_480)
    .default(2_147_483_648),
  FAB_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("warn"),
  FAB_LOG_QUERIES: BooleanEnvironmentValue.default(false),
  FAB_CURL_IMPERSONATE: z.string().trim().min(1).optional(),
  FAB_MIN_REQUEST_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(0)
    .max(10_000)
    .default(1_000),
  FAB_DOWNLOAD_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(10_000)
    .max(3_600_000)
    .default(600_000),
});

const CreatureLimitsSchema = z
  .object({
    specBytes: z.number().int().positive(),
    glbBytes: z.number().int().positive(),
    diagnosticsBytes: z.number().int().positive(),
    compileTimeoutMs: z.number().int().positive(),
    maxActiveHeavyOperations: z.number().int().positive(),
  })
  .strict();

export const CREATURE_LIMITS = Object.freeze({
  specBytes: 256 * 1_024,
  glbBytes: 32 * 1_024 * 1_024,
  diagnosticsBytes: 1 * 1_024 * 1_024,
  compileTimeoutMs: 60_000,
  maxActiveHeavyOperations: 1,
});

export interface CreatureLimits {
  specBytes: number;
  glbBytes: number;
  diagnosticsBytes: number;
  compileTimeoutMs: number;
  maxActiveHeavyOperations: number;
}

export interface CreatureConfig {
  cacheDir: string;
  limits: CreatureLimits;
}

export interface FabConfig {
  directTimeoutMs: number;
  browserTimeoutMs: number;
  browserManualTimeoutMs: number;
  browserHeadless: boolean;
  browserProfileDir: string;
  downloadDir: string;
  maxDownloadBytes: number;
  logLevel: "debug" | "info" | "warn" | "error";
  logQueries: boolean;
  /**
   * Explicit curl-impersonate wrapper override; "0"/"off"/"false" disables
   * impersonation. Resolution against PATH happens in the client.
   */
  curlImpersonate?: string;
  minRequestIntervalMs: number;
  downloadTimeoutMs: number;
}

/** True when `path` is `parent` or lives below it (after resolving both). */
export function isInside(path: string, parent: string): boolean {
  const child = relative(parent, path);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

/** Real path of `input`, resolving the longest existing prefix so a missing tail still compares. */
export function canonicalPath(input: string): string {
  let candidate = resolve(input);
  const missingSegments: string[] = [];
  while (true) {
    try {
      return resolve(realpathSync.native(candidate), ...missingSegments);
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) return resolve(input);
      missingSegments.unshift(basename(candidate));
      candidate = parent;
    }
  }
}

function normalBrowserProfileRoots(
  environment: NodeJS.ProcessEnv,
): string[] {
  const userHome = homedir();
  if (process.platform === "darwin") {
    return [
      join(userHome, "Library", "Application Support", "Google", "Chrome"),
      join(userHome, "Library", "Application Support", "Google", "Chrome Beta"),
      join(userHome, "Library", "Application Support", "Google", "Chrome Canary"),
      join(userHome, "Library", "Application Support", "Chromium"),
      join(userHome, "Library", "Application Support", "Microsoft Edge"),
    ];
  }
  if (process.platform === "win32") {
    const localData = environment.LOCALAPPDATA?.trim();
    return localData
      ? [
          join(localData, "Google", "Chrome", "User Data"),
          join(localData, "Google", "Chrome Beta", "User Data"),
          join(localData, "Google", "Chrome SxS", "User Data"),
          join(localData, "Chromium", "User Data"),
          join(localData, "Microsoft", "Edge", "User Data"),
        ]
      : [];
  }
  return [
    join(userHome, ".config", "google-chrome"),
    join(userHome, ".config", "google-chrome-beta"),
    join(userHome, ".config", "google-chrome-unstable"),
    join(userHome, ".config", "chromium"),
    join(userHome, ".config", "microsoft-edge"),
  ];
}

export function loadFabConfig(
  environment: NodeJS.ProcessEnv = process.env,
): FabConfig {
  const parsed = EnvironmentSchema.parse(environment);
  const stateRoot =
    environment.XDG_STATE_HOME?.trim() ||
    join(homedir(), ".local", "state");

  const browserProfileDir = canonicalPath(
    parsed.FAB_BROWSER_PROFILE_DIR ??
      join(stateRoot, "threenative-asset-mcp", "fab-browser-profile"),
  );
  if (
    normalBrowserProfileRoots(environment).some((root) =>
      isInside(browserProfileDir, canonicalPath(root)),
    )
  ) {
    throw new Error(
      "FAB_BROWSER_PROFILE_DIR must be an MCP-owned directory, not a normal browser profile.",
    );
  }
  const downloadDir = canonicalPath(
    parsed.FAB_DOWNLOAD_DIR ??
      join(homedir(), "Downloads", "threenative-asset-mcp", "fab"),
  );
  if (
    downloadDir === canonicalPath(homedir()) ||
    dirname(downloadDir) === downloadDir
  ) {
    throw new Error(
      "FAB_DOWNLOAD_DIR must be a dedicated asset directory, not a filesystem or home root.",
    );
  }

  return {
    directTimeoutMs: parsed.FAB_DIRECT_TIMEOUT_MS,
    browserTimeoutMs: parsed.FAB_BROWSER_TIMEOUT_MS,
    browserManualTimeoutMs: parsed.FAB_BROWSER_MANUAL_TIMEOUT_MS,
    browserHeadless: parsed.FAB_BROWSER_HEADLESS,
    browserProfileDir,
    downloadDir,
    maxDownloadBytes: parsed.FAB_MAX_DOWNLOAD_BYTES,
    logLevel: parsed.FAB_LOG_LEVEL,
    logQueries: parsed.FAB_LOG_QUERIES,
    ...(parsed.FAB_CURL_IMPERSONATE
      ? { curlImpersonate: parsed.FAB_CURL_IMPERSONATE }
      : {}),
    minRequestIntervalMs: parsed.FAB_MIN_REQUEST_INTERVAL_MS,
    downloadTimeoutMs: parsed.FAB_DOWNLOAD_TIMEOUT_MS,
  };
}

export function loadCreatureConfig(
  environment: NodeJS.ProcessEnv = process.env,
): CreatureConfig {
  const cacheRoot = canonicalPath(
    environment.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache"),
  );
  const cacheDir = canonicalPath(
    join(cacheRoot, "threenative-asset-mcp", "creature-toolchains"),
  );
  if (
    cacheDir === canonicalPath(homedir()) ||
    dirname(cacheDir) === cacheDir
  ) {
    throw new Error(
      "The creature toolchain cache must be a dedicated directory, not a filesystem or home root.",
    );
  }

  return {
    cacheDir,
    limits: CreatureLimitsSchema.parse(CREATURE_LIMITS),
  };
}

export type TextureProjectionMode = "detailed" | "lean";

function parseTextureProjectionModeValue(raw: string, source: string): TextureProjectionMode {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "detailed" || normalized === "lean") {
    return normalized;
  }
  throw new Error(
    `Invalid texture projection mode "${raw}" from ${source}. Expected "detailed" or "lean".`,
  );
}

/**
 * Resolve the MCP server texture projection workflow mode.
 * Precedence: CLI `--mode <detailed|lean>` (or `--mode=<value>`) > `THREENATIVE_TEXTURE_MODE` > `"detailed"`.
 */
export function loadTextureProjectionMode(
  environment: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = [],
): TextureProjectionMode {
  let cliValue: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === "--") break;
    if (arg === "--mode") {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error('Missing value for "--mode". Expected "detailed" or "lean".');
      }
      cliValue = next;
      index += 1;
      continue;
    }
    if (arg.startsWith("--mode=")) {
      cliValue = arg.slice("--mode=".length);
    }
  }
  if (cliValue !== undefined) {
    return parseTextureProjectionModeValue(cliValue, "--mode");
  }
  const envValue = environment.THREENATIVE_TEXTURE_MODE;
  if (envValue !== undefined && envValue.trim().length > 0) {
    return parseTextureProjectionModeValue(envValue, "THREENATIVE_TEXTURE_MODE");
  }
  return "detailed";
}

export interface RigConfig {
  /** Development cache for explicitly acquired animation sources; never a project asset root. */
  cacheDir: string;
  maxDownloadBytes: number;
  downloadTimeoutMs: number;
}

export function loadRigConfig(
  environment: NodeJS.ProcessEnv = process.env,
): RigConfig {
  const cacheRoot = canonicalPath(
    environment.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache"),
  );
  const cacheDir = canonicalPath(
    join(cacheRoot, "threenative-asset-mcp", "animation-sources"),
  );
  if (
    cacheDir === canonicalPath(homedir()) ||
    dirname(cacheDir) === cacheDir
  ) {
    throw new Error(
      "The animation source cache must be a dedicated directory, not a filesystem or home root.",
    );
  }

  return {
    cacheDir,
    maxDownloadBytes: 256 * 1024 * 1024,
    downloadTimeoutMs: 120_000,
  };
}
