/**
 * Headless Blender for Unity model conversion. Blender is GPL and runs as a separate process, so the
 * licence boundary is the process boundary. Resolution order: THREENATIVE_BLENDER, then PATH, then a
 * pinned, checksummed LTS download in the toolchain cache. THREENATIVE_TOOLCHAIN_AUTOINSTALL=0 turns
 * the download off. Blendkit keeps its own, client-stored Blender (`src/tools/blendkit.ts`).
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, constants, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { autoInstallEnabled, toolchainCacheDir, type ProvisionLog } from "../unreal/provision.js";
import { runBounded } from "../unreal/toolchain.js";
import { UnityImportError } from "./errors.js";

export interface BlenderRelease {
  readonly version: string;
  readonly url: string;
  /** From the release's published `blender-<version>.sha256`, fetched 2026-10-14. */
  readonly sha256: string;
}

/** Blender 4.5 LTS, Linux x64. Pinned: changing the URL means changing the digest in the same commit. */
export const BLENDER_RELEASE: BlenderRelease = Object.freeze({
  version: "4.5.14",
  url: "https://download.blender.org/release/Blender4.5/blender-4.5.14-linux-x64.tar.xz",
  sha256: "9ba871ff2ecd36526b77432745980b7e6664ecd0c7ca11c48849073dcfe06da3",
});

/** The oldest Blender whose glTF exporter and `import_scene.fbx` the conversion script uses. */
export const MIN_BLENDER = [3, 6] as const;

export interface BlenderTool {
  readonly path: string;
  readonly version: string;
  readonly source: "THREENATIVE_BLENDER" | "PATH" | "toolchain-cache" | "download";
}

export interface BlenderHooks {
  /** Tests point this at a local archive; production uses {@link BLENDER_RELEASE}. */
  readonly release?: BlenderRelease;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}

const noLog: ProvisionLog = () => {};

export const BLENDER_FIX =
  "Install Blender 3.6 or newer and set THREENATIVE_BLENDER to its executable (or put `blender` on PATH), " +
  "or remove THREENATIVE_TOOLCHAIN_AUTOINSTALL=0 so the importer downloads the pinned release.";

export function blenderCacheDir(environment: NodeJS.ProcessEnv, release: BlenderRelease = BLENDER_RELEASE): string {
  return join(toolchainCacheDir(environment), `blender-${release.version}`);
}

export function blenderCachePath(environment: NodeJS.ProcessEnv, release: BlenderRelease = BLENDER_RELEASE): string {
  return join(blenderCacheDir(environment, release), "blender");
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Runs `blender -b --version` and returns "4.5.14" when it is Blender, else undefined. */
export async function probeBlender(path: string): Promise<string | undefined> {
  try {
    const run = await runBounded(path, ["-b", "--factory-startup", "--disable-autoexec", "--version"], { timeoutMs: 60_000 });
    if (run.code !== 0) return undefined;
    return /^Blender (\d+\.\d+(?:\.\d+)?)/m.exec(run.stdout)?.[1];
  } catch {
    return undefined;
  }
}

function atLeast(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major > MIN_BLENDER[0] || (major === MIN_BLENDER[0] && minor >= MIN_BLENDER[1]);
}

async function findOnPath(environment: NodeJS.ProcessEnv): Promise<string | undefined> {
  for (const directory of (environment.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) {
    if (!directory) continue;
    const candidate = join(directory, process.platform === "win32" ? "blender.exe" : "blender");
    if (await isExecutable(candidate)) return candidate;
  }
  return undefined;
}

async function verified(path: string, source: BlenderTool["source"], pinned?: string): Promise<BlenderTool | undefined> {
  const version = await probeBlender(path);
  if (version === undefined) return undefined;
  if (pinned === undefined ? !atLeast(version) : version !== pinned) return undefined;
  return { path, version, source };
}

/** Streams `url` to `destination` and returns its SHA-256, so a 380 MB archive is never held in memory. */
async function download(url: string, destination: string): Promise<string> {
  const response = await fetch(url, { headers: { "user-agent": "threenative-asset-mcp" }, redirect: "follow" });
  if (!response.ok || response.body === null) {
    throw new UnityImportError(
      "UNITY_BLENDER_UNUSABLE",
      `Downloading Blender from ${url} failed with HTTP ${response.status}. ${BLENDER_FIX}`,
      response.status >= 500,
    );
  }
  const hash = createHash("sha256");
  const digest = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk as Buffer);
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body as never), digest, createWriteStream(destination));
  return hash.digest("hex");
}

async function provision(
  environment: NodeJS.ProcessEnv,
  release: BlenderRelease,
  log: ProvisionLog,
): Promise<BlenderTool> {
  const final = blenderCacheDir(environment, release);
  await mkdir(toolchainCacheDir(environment), { recursive: true });
  // Staged beside the destination: /tmp is often a small tmpfs, and the rename stays atomic.
  const staging = await mkdtemp(join(toolchainCacheDir(environment), ".blender-staging-"));
  try {
    log(`Downloading Blender ${release.version} (about 380 MB)...`);
    const archive = join(staging, "blender.tar.xz");
    const actual = await download(release.url, archive);
    if (actual !== release.sha256) {
      throw new UnityImportError(
        "UNITY_BLENDER_UNUSABLE",
        `The Blender download did not match the pinned SHA-256 (expected ${release.sha256}, got ${actual}), so it was discarded. ${BLENDER_FIX}`,
      );
    }
    const unpacked = join(staging, "unpacked");
    await mkdir(unpacked);
    const untar = await runBounded("tar", ["xf", archive, "-C", unpacked, "--strip-components=1", "--no-same-owner"], {
      timeoutMs: 600_000,
    });
    if (untar.code !== 0) {
      throw new UnityImportError(
        "UNITY_BLENDER_UNUSABLE",
        `Extracting Blender failed (tar exit ${untar.code}). The archive is .tar.xz: install xz-utils. ${BLENDER_FIX}`,
      );
    }
    await rm(archive, { force: true });
    const version = await probeBlender(join(unpacked, "blender"));
    if (version !== release.version) {
      throw new UnityImportError(
        "UNITY_BLENDER_UNUSABLE",
        `The downloaded Blender does not start here (reported ${version ?? "nothing"}). It may need system libraries such as libxkbcommon, libxi, libxxf86vm and libgl1. ${BLENDER_FIX}`,
      );
    }
    await rm(final, { recursive: true, force: true });
    await rename(unpacked, final);
    log(`Installed Blender ${version} at ${final}`);
    return { path: join(final, "blender"), version, source: "download" };
  } catch (error) {
    // A concurrent provisioner may have published the same release first.
    const other = await verified(join(final, "blender"), "toolchain-cache", release.version);
    if (other) return other;
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** THREENATIVE_BLENDER, else PATH, else the toolchain cache, else a pinned download. */
export async function ensureBlender(
  environment: NodeJS.ProcessEnv = process.env,
  log: ProvisionLog = noLog,
  hooks: BlenderHooks = {},
): Promise<BlenderTool> {
  const override = environment.THREENATIVE_BLENDER?.trim();
  if (override) {
    if (!isAbsolute(override) || !(await isExecutable(override))) {
      throw new UnityImportError(
        "UNITY_BLENDER_NOT_FOUND",
        `THREENATIVE_BLENDER points at "${override}", which is not an absolute path to an executable file. ${BLENDER_FIX}`,
      );
    }
    const tool = await verified(override, "THREENATIVE_BLENDER");
    if (!tool) {
      throw new UnityImportError(
        "UNITY_BLENDER_UNUSABLE",
        `THREENATIVE_BLENDER ("${override}") does not run as Blender ${MIN_BLENDER.join(".")} or newer. ${BLENDER_FIX}`,
      );
    }
    return tool;
  }
  const onPath = await findOnPath(environment);
  const fromPath = onPath ? await verified(onPath, "PATH") : undefined;
  if (fromPath) return fromPath;

  const release = hooks.release ?? BLENDER_RELEASE;
  const cached = await verified(blenderCachePath(environment, release), "toolchain-cache", release.version);
  if (cached) return cached;

  if (!autoInstallEnabled(environment)) {
    throw new UnityImportError(
      "UNITY_BLENDER_NOT_FOUND",
      `Blender was not found, and THREENATIVE_TOOLCHAIN_AUTOINSTALL=0 forbids downloading it. ${BLENDER_FIX}`,
    );
  }
  const platform = hooks.platform ?? process.platform;
  const arch = hooks.arch ?? process.arch;
  if (platform !== "linux" || arch !== "x64") {
    throw new UnityImportError(
      "UNITY_BLENDER_NOT_FOUND",
      `The importer downloads Blender for Linux x64 only; this host is ${platform} ${arch}. ${BLENDER_FIX}`,
    );
  }
  return provision(environment, release, log);
}
