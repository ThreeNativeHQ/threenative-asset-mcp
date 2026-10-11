import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * The external tools this repo's tests and Unreal importers rely on. Tests and `npm run doctor`
 * read the same catalog, so the list of what a host needs lives in one place. No test framework is
 * imported here.
 */

export type PrerequisiteGroup = "test" | "toolchain";

export interface CheckResult {
  ok: boolean;
  detail?: string;
}

export interface Prerequisite {
  id: string;
  label: string;
  group: PrerequisiteGroup;
  /** Synchronous and bounded. Never throws. */
  check(env: NodeJS.ProcessEnv): CheckResult;
  /** The exact fix for the current platform. */
  fix: string;
}

export interface InfoLine {
  label: string;
  detail: string;
}

const PROBE_TIMEOUT_MS = 15_000;
const MIN_NODE = [20, 19, 0] as const;

const isLinux = process.platform === "linux";
const isMac = process.platform === "darwin";

/** Runs a command without a shell. Output is discarded: it may carry secrets. */
function runStatus(command: string, args: readonly string[], env: NodeJS.ProcessEnv): number | undefined {
  const run = spawnSync(command, [...args], {
    env,
    shell: false,
    stdio: "ignore",
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true,
  });
  if (run.error || run.status === null) return undefined;
  return run.status;
}

function runs(command: string, args: readonly string[], env: NodeJS.ProcessEnv): boolean {
  return runStatus(command, args, env) === 0;
}

/**
 * True when `command --version` exits 0 and prints a .NET 10 SDK: the same test `modernSdkExecutable` applies to the
 * host's `dotnet`. The output is read only to test the version and is never printed.
 */
function runsDotnet10(command: string, env: NodeJS.ProcessEnv): boolean {
  const run = spawnSync(command, ["--version"], {
    env,
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true,
  });
  return run.error === undefined && run.status === 0 && /^10\./u.test(run.stdout.trim());
}

function isDebianLike(): boolean {
  if (!isLinux) return false;
  try {
    const text = readFileSync("/etc/os-release", "utf8");
    return /^(ID|ID_LIKE)=.*\b(debian|ubuntu)\b/mu.test(text.replace(/"/gu, ""));
  } catch {
    return false;
  }
}

/** The install command for a system package on this platform. */
function installFix(apt: string, brew: string, other: string): string {
  if (isDebianLike()) return `sudo apt-get install --yes ${apt}`;
  if (isMac) return `brew install ${brew}`;
  return other;
}

function commandPrerequisite(
  id: string,
  group: PrerequisiteGroup,
  args: readonly string[],
  apt: string,
  brew: string,
): Prerequisite {
  return {
    id,
    label: id,
    group,
    check:
      group === "toolchain"
        ? linuxOnly((env) => ({ ok: runs(id, args, env) }))
        : (env) => ({ ok: runs(id, args, env) }),
    fix: installFix(apt, brew, `install ${id} with your package manager`),
  };
}

function versionAtLeast(actual: string, minimum: readonly number[]): boolean {
  const parts = actual.split(".").map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < minimum.length; index += 1) {
    const have = parts[index] ?? 0;
    const need = minimum[index] ?? 0;
    if (have !== need) return have > need;
  }
  return true;
}

function chromiumExecutable(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const { chromium } = require("playwright") as { chromium: { executablePath(): string } };
    const path = chromium.executablePath();
    return path.length > 0 ? path : undefined;
  } catch {
    return undefined;
  }
}

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Toolchain items are only needed on Linux, where UE Viewer is built from source. */
function linuxOnly(check: (env: NodeJS.ProcessEnv) => CheckResult): (env: NodeJS.ProcessEnv) => CheckResult {
  return (env) => (isLinux ? check(env) : { ok: true, detail: `not needed on ${process.platform}` });
}

function headerPrerequisite(
  id: string,
  paths: readonly string[],
  apt: string,
): Prerequisite {
  return {
    id,
    label: `${id} header`,
    group: "toolchain",
    check: linuxOnly(() => ({ ok: paths.some((path) => existsSync(path)) })),
    fix: installFix(apt, apt, `install the ${apt} development package`),
  };
}

// FabCLI is dynamically linked against WebKitGTK; on a fresh Debian host it installs but will not start.
function libraryPrerequisite(id: string, soname: string, apt: string): Prerequisite {
  return {
    id,
    label: `${soname}`,
    group: "toolchain",
    check: linuxOnly(() => {
      const result = spawnSync("ldconfig", ["-p"], { encoding: "utf8", timeout: 5_000, shell: false });
      return { ok: result.status === 0 && result.stdout.includes(soname) };
    }),
    fix: installFix(apt, apt, `install the package that provides ${soname}`),
  };
}

const nodePrerequisite: Prerequisite = {
  id: "node",
  label: "node",
  group: "test",
  check: () => ({
    ok: versionAtLeast(process.versions.node, MIN_NODE),
    detail: process.versions.node,
  }),
  fix: `install Node.js ${MIN_NODE.join(".")} or newer (https://nodejs.org)`,
};

export const PREREQUISITES: readonly Prerequisite[] = [
  nodePrerequisite,
  commandPrerequisite("ffmpeg", "test", ["-version"], "ffmpeg", "ffmpeg"),
  commandPrerequisite("ffprobe", "test", ["-version"], "ffmpeg", "ffmpeg"),
  {
    id: "python-imaging",
    label: "python3 with NumPy and Pillow",
    group: "test",
    check: (env) => ({ ok: runs("python3", ["-c", "import numpy, PIL"], env) }),
    fix: isDebianLike()
      ? "sudo apt-get install --yes python3-numpy python3-pil"
      : "python3 -m pip install numpy pillow",
  },
  {
    id: "chromium",
    label: "Playwright Chromium",
    group: "test",
    check: (env) => {
      const override = env.PW_CHROMIUM_PATH?.trim();
      if (override) return { ok: fileExists(override), detail: "PW_CHROMIUM_PATH" };
      const executable = chromiumExecutable();
      return { ok: executable !== undefined && existsSync(executable) };
    },
    fix: "npx playwright install chromium",
  },
  {
    id: "python3-venv",
    label: "python3 >= 3.10 with venv and ensurepip",
    group: "toolchain",
    check: linuxOnly((env) => ({
      ok: runs(
        "python3",
        ["-c", "import sys, venv, ensurepip; sys.exit(0 if sys.version_info >= (3, 10) else 1)"],
        env,
      ),
    })),
    fix: installFix("python3 python3-venv", "python", "install Python 3.10 or newer with the venv module"),
  },
  commandPrerequisite("g++", "toolchain", ["--version"], "g++", "gcc"),
  commandPrerequisite("perl", "toolchain", ["-e", "1"], "perl", "perl"),
  headerPrerequisite("zlib", ["/usr/include/zlib.h"], "zlib1g-dev"),
  headerPrerequisite("libpng", ["/usr/include/png.h", "/usr/include/libpng16/png.h"], "libpng-dev"),
  headerPrerequisite("SDL2", ["/usr/include/SDL2/SDL.h"], "libsdl2-dev"),
  libraryPrerequisite("webkit2gtk", "libwebkit2gtk-4.1.so.0", "libwebkit2gtk-4.1-0"),
  commandPrerequisite("git", "toolchain", ["--version"], "git", "git"),
  commandPrerequisite("tar", "toolchain", ["--version"], "tar", "gnu-tar"),
];

/** The SharpGLTF assemblies the modern converter ships beside its executable. */
const SHARPGLTF_ASSEMBLIES = ["SharpGLTF.Core.dll", "SharpGLTF.Runtime.dll", "SharpGLTF.Toolkit.dll"] as const;

/**
 * Test-only entries, kept out of PREREQUISITES so `npm run doctor` never requires them. Suites reach
 * them through prerequisiteById.
 */
const TEST_ONLY_PREREQUISITES: readonly Prerequisite[] = [
  {
    id: "modern-converter",
    label: "modern converter (.NET 10 SDK and SharpGLTF assemblies)",
    group: "toolchain",
    check: (env) => {
      const modern = join(toolchainCacheDir(env), "modern");
      const cachedDotnet = join(modern, "dotnet", process.platform === "win32" ? "dotnet.exe" : "dotnet");
      // The host's dotnet first, as the provisioner orders it; the cached SDK is the fallback.
      const sdk = runsDotnet10("dotnet", env) || runsDotnet10(cachedDotnet, env);
      const assemblies = SHARPGLTF_ASSEMBLIES.map((assembly) => join(modern, "bin", assembly));
      return { ok: sdk && assemblies.every((path) => fileExists(path)) };
    },
    fix: `npx tsx -e 'import { ensureModernConverter } from "./src/unreal/provision.ts"; ensureModernConverter(process.env, console.error).catch(error => { console.error(error); process.exitCode = 1; });'`,
  },
];

export type TestToolId = "node" | "ffmpeg" | "ffprobe" | "python-imaging" | "chromium" | "modern-converter";

export function prerequisiteById(id: string): Prerequisite {
  const found = [...PREREQUISITES, ...TEST_ONLY_PREREQUISITES].find((entry) => entry.id === id);
  if (!found) throw new Error(`Unknown prerequisite: ${id}`);
  return found;
}

/** Looks an executable up on the PATH in `env`. */
export function findOnPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    if (fileExists(candidate)) return candidate;
  }
  return undefined;
}

export function toolchainCacheDir(env: NodeJS.ProcessEnv): string {
  return (
    env.THREENATIVE_TOOLCHAIN_DIR?.trim() ||
    join(
      env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache"),
      "threenative-asset-mcp",
      "toolchain",
    )
  );
}

const CACHED_TOOLS: readonly (readonly [label: string, relative: string])[] = [
  ["UE Viewer", "umodel/umodel"],
  ["FabCLI", "fabcli/fabcli"],
  ["uncooked converter", "uncooked/venv/bin/unreal-assets-to-glb"],
  ["modern converter", "modern/bin/ThreeNativeConverter"],
];

/** Where FabCLI is, by the same precedence the importer uses. */
function findFabcli(env: NodeJS.ProcessEnv, cache: string): string | undefined {
  const override = env.THREENATIVE_FABCLI_PATH?.trim();
  if (override && fileExists(override)) return override;
  return findOnPath("fabcli", env) ?? (fileExists(join(cache, "fabcli", "fabcli")) ? join(cache, "fabcli", "fabcli") : undefined);
}

/** Facts that never fail the check. FabCLI output is discarded: it can hold account details. */
export function infoLines(env: NodeJS.ProcessEnv): InfoLine[] {
  const cache = toolchainCacheDir(env);
  const lines: InfoLine[] = [{ label: "toolchain cache", detail: cache }];
  for (const [label, relative] of CACHED_TOOLS) {
    lines.push({
      label,
      detail: fileExists(join(cache, ...relative.split("/"))) ? `installed (${relative})` : `not installed (${relative})`,
    });
  }
  const fabcli = findFabcli(env, cache);
  if (!fabcli) {
    lines.push({ label: "FabCLI session", detail: "FabCLI not found" });
  } else {
    const status = runStatus(fabcli, ["auth", "status"], env);
    lines.push({
      label: "FabCLI session",
      detail: status === 0 ? "signed in" : "not signed in — run fabcli auth login",
    });
  }
  return lines;
}
