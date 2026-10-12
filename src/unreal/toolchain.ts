import { execFile } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/**
 * External executables the Unreal import flow drives. They are never bundled, linked, or imported.
 * First use may provision them into the MCP-owned cache; nothing runs during `npm install`, and
 * FabCLI authentication remains an explicit user action.
 */
export type ExternalToolName = "umodel" | "fabcli" | "uncooked" | "modern";

export interface ExternalTool {
  readonly name: ExternalToolName;
  readonly path: string;
  readonly version: string;
}

export type ToolchainErrorCode =
  | "UNREAL_TOOL_NOT_FOUND"
  | "UNREAL_TOOL_UNUSABLE"
  | "UNREAL_TOOL_TIMEOUT"
  | "UNREAL_TOOL_FAILED"
  | "UNREAL_HOST_UNSUPPORTED";

export class ToolchainError extends Error {
  constructor(
    readonly code: ToolchainErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ToolchainError";
  }
}

const ENVIRONMENT_OVERRIDE: Record<ExternalToolName, string> = {
  umodel: "THREENATIVE_UMODEL_PATH",
  fabcli: "THREENATIVE_FABCLI_PATH",
  uncooked: "THREENATIVE_UNCOOKED_CONVERTER_PATH",
  modern: "THREENATIVE_MODERN_UNREAL_CONVERTER_PATH",
};

const EXECUTABLE_NAME: Record<ExternalToolName, string> = {
  umodel: "umodel",
  fabcli: "fabcli",
  uncooked: "unreal-assets-to-glb",
  modern: "threenative-cue4parse",
};

/** Hosts UE Viewer publishes and we have executed on. macOS stays unclaimed until run there. */
const SUPPORTED_PLATFORMS = new Set(["linux", "win32"]);

export function assertSupportedHost(platform: string = process.platform): void {
  if (SUPPORTED_PLATFORMS.has(platform)) return;
  throw new ToolchainError(
    "UNREAL_HOST_UNSUPPORTED",
    `Unreal import runs on Linux and Windows only; this host reports "${platform}". Run the import on a supported host and copy the produced GLBs.`,
  );
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const info = await stat(candidate);
    if (!info.isFile()) return false;
    if (process.platform === "win32") return true;
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves one executable from its explicit environment override, else from PATH. Nothing is run
 * through a shell, so a PATH entry with spaces or a name with shell metacharacters is inert.
 */
export async function resolveExecutable(
  name: ExternalToolName,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const override = environment[ENVIRONMENT_OVERRIDE[name]]?.trim();
  if (override) {
    if (!isAbsolute(override)) {
      throw new ToolchainError(
        "UNREAL_TOOL_UNUSABLE",
        `${ENVIRONMENT_OVERRIDE[name]} must be an absolute path to the ${name} executable.`,
      );
    }
    if (!(await isExecutableFile(override))) {
      throw new ToolchainError(
        "UNREAL_TOOL_NOT_FOUND",
        `${ENVIRONMENT_OVERRIDE[name]} points at "${override}", which is not an executable file.`,
      );
    }
    return override;
  }

  const suffixes = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  const executableName = EXECUTABLE_NAME[name];
  for (const directory of (environment.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const suffix of suffixes) {
      const candidate = join(directory, `${executableName}${suffix}`);
      if (await isExecutableFile(candidate)) return candidate;
    }
  }
  throw new ToolchainError(
    "UNREAL_TOOL_NOT_FOUND",
    name === "umodel"
      ? "UE Viewer (umodel) was not found. Install it and set THREENATIVE_UMODEL_PATH, or put `umodel` on PATH. See https://www.gildor.org/en/projects/umodel."
      : name === "fabcli"
        ? "FabCLI was not found. Install it and set THREENATIVE_FABCLI_PATH, or put `fabcli` on PATH. FabCLI is a separate, unofficial GPLv3 tool; installing and authenticating it is your choice."
        : name === "uncooked"
          ? "The uncooked Unreal converter was not found. Install `unreal-assets-to-glb==4.27.2.0` and set THREENATIVE_UNCOOKED_CONVERTER_PATH, or allow toolchain auto-install."
          : "The modern Unreal converter was not found. Set THREENATIVE_MODERN_UNREAL_CONVERTER_PATH, or allow toolchain auto-install.",
  );
}

export interface BoundedRunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface BoundedRunOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly environment?: NodeJS.ProcessEnv;
}

/**
 * The only environment variables a child tool receives. Everything else — tokens, registry
 * credentials, CI secrets — is dropped rather than redacted after the fact, so nothing it could
 * echo back was ever handed to it.
 */
const FORWARDED_ENVIRONMENT = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "USERPROFILE",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "SystemRoot",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  // FabCLI keeps its session in the OS keystore, which on Linux is the Secret Service over DBus.
  // Without the session bus address it cannot read a token that is sitting right there, and
  // reports itself unauthenticated to a user who is very much logged in.
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "GNOME_KEYRING_CONTROL",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  // Python itself reads this switch, so a child skips __pycache__ only if it arrives. Forwarded as the
  // parent set it: CPython 3.13 keeps writing for "" and "0" and stops for "false", which a boolean
  // re-encoding would get wrong.
  "PYTHONDONTWRITEBYTECODE",
] as const;

export function childEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const forwarded: NodeJS.ProcessEnv = {};
  for (const key of FORWARDED_ENVIRONMENT) {
    const value = source[key];
    if (value !== undefined) forwarded[key] = value;
  }
  // An MCP host (Codex, a GUI client) can start this server with no session bus of its own, and
  // FabCLI's child then cannot reach the keyring the very same desktop has open. The runtime
  // directory still advertises that bus, so name it rather than reporting an absent session. Codex
  // strips XDG_RUNTIME_DIR too, so fall back to the systemd-logind default for this user.
  const runtime =
    forwarded.XDG_RUNTIME_DIR ?? (process.platform === "linux" ? `/run/user/${process.getuid?.()}` : undefined);
  if (!forwarded.DBUS_SESSION_BUS_ADDRESS && runtime) {
    const bus = join(runtime, "bus");
    if (existsSync(bus)) forwarded.DBUS_SESSION_BUS_ADDRESS = `unix:path=${bus}`;
  }
  return forwarded;
}

/** Runs an executable with argv passed as an array — never a shell string — under a hard timeout. */
export function runBounded(
  executable: string,
  args: readonly string[],
  options: BoundedRunOptions = {},
): Promise<BoundedRunResult> {
  const timeoutMs = options.timeoutMs ?? 600_000;
  const maxOutputBytes = options.maxOutputBytes ?? 8 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = execFile(
      executable,
      [...args],
      {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        timeout: timeoutMs,
        maxBuffer: maxOutputBytes,
        windowsHide: true,
        shell: false,
        env: options.environment ?? childEnvironment(),
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
          reject(
            new ToolchainError(
              "UNREAL_TOOL_TIMEOUT",
              `"${executable}" exceeded its ${timeoutMs} ms budget and was stopped.`,
              true,
            ),
          );
          return;
        }
        if (error && (error as NodeJS.ErrnoException).code === "ENOBUFS") {
          reject(
            new ToolchainError(
              "UNREAL_TOOL_FAILED",
              `"${executable}" produced more than ${maxOutputBytes} bytes of output.`,
            ),
          );
          return;
        }
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? ((error as { code: number }).code)
            : error
              ? 1
              : 0;
        resolve({ code, stdout, stderr });
      },
    );
    child.on("error", (error) => {
      reject(
        new ToolchainError(
          "UNREAL_TOOL_UNUSABLE",
          `"${executable}" could not be started: ${error.name}.`,
        ),
      );
    });
  });
}

const UMODEL_VERSION = /^UE Viewer.*$\n^(Compiled .*)$/m;

/** Resolves UE Viewer and captures the build stamp that participates in the import cache key. */
export async function resolveUmodel(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<ExternalTool> {
  assertSupportedHost();
  const path = await resolveExecutable("umodel", environment);
  const run = await runBounded(path, ["-version"], { timeoutMs: 30_000 });
  const text = `${run.stdout}\n${run.stderr}`;
  if (!/UE Viewer/i.test(text)) {
    throw new ToolchainError(
      "UNREAL_TOOL_UNUSABLE",
      `"${path}" does not identify itself as UE Viewer (umodel).`,
    );
  }
  const compiled = UMODEL_VERSION.exec(text)?.[1]?.trim();
  return { name: "umodel", path, version: compiled ?? "UE Viewer (unversioned)" };
}
