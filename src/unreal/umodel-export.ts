import { constants } from "node:fs";
import { access, mkdir, stat } from "node:fs/promises";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";

import { type BoundedRunResult, ToolchainError, childEnvironment, runBounded } from "./toolchain.js";

/** What UE Viewer prints, and then exits 0, when it cannot create an output file. */
const FILE_CREATION_FAILURE = "Error creating file";
/** The suffixes resolveExecutable tries for a bare name: Windows adds its executable extensions, elsewhere none. */
const EXECUTABLE_SUFFIXES = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
/** Where Node's execFile searches a bare name when the child environment has no PATH on Unix (execvpe's default). */
const UNIX_DEFAULT_PATH = "/usr/bin:/bin";

/**
 * Runs one UE Viewer export into `outputRoot`. UE Viewer copies an absolute `-out=` into a 256-byte buffer and then
 * appends the package's folders; past that it drops files and still exits 0. `-out=./` stays relative to the child's
 * working directory, so the child runs inside `outputRoot` with that flag and the buffer holds only the package path.
 * Every relative name is made absolute against the directory this process started in, before the spawn: the source
 * path, the root, the executable and each PATH entry. A relative PATH entry would be read from the child's working
 * directory, the root, so an interpreter such as `#!/usr/bin/env node` would look for node in the output instead. This
 * process never changes directory.
 */
export async function runUmodelExport(
  executable: string,
  sourceDir: string,
  outputRoot: string,
  formatFlags: readonly string[],
  selector: string,
  limits: { readonly timeoutMs: number; readonly maxOutputBytes: number },
): Promise<BoundedRunResult> {
  // Captured first: the child changes into `root`, so every relative name below is the caller's, not the output's.
  const callerDirectory = process.cwd();
  const root = absolutePath(outputRoot, callerDirectory);
  await mkdir(root, { recursive: true });
  // The child runs with this environment. A defined PATH is made absolute here, and the executable is searched for in the
  // same directories, so both see one PATH. An absent PATH stays absent: the child gets none, and the search uses Node's
  // default instead.
  const environment = childEnvironment();
  const directories = searchDirectories(environment.PATH, callerDirectory);
  if (environment.PATH !== undefined) environment.PATH = directories.join(delimiter);
  const program = await resolveProgram(executable, directories, callerDirectory);
  const run = await runBounded(
    program,
    [`-path=${absolutePath(sourceDir, callerDirectory)}`, "-export", ...formatFlags, "-out=./", selector],
    { ...limits, cwd: root, environment },
  );
  // Exit 0 with this line means a file was not written. Throwing, as runBounded does for a timeout, lets each caller's
  // existing catch record the package as failed. Only this diagnostic does: other output stays in the result.
  const diagnostic = `${run.stdout}\n${run.stderr}`.split(/\r?\n/).find((line) => line.includes(FILE_CREATION_FAILURE));
  if (run.code === 0 && diagnostic !== undefined) {
    throw new ToolchainError(
      "UNREAL_TOOL_FAILED",
      `UE Viewer exited 0 but reported "${diagnostic.trim().slice(0, 300)}" while exporting ${selector}.`,
    );
  }
  return run;
}

/**
 * The absolute directories a bare name is searched in, in the order the child searches them. Each entry of a defined
 * PATH is made absolute against `callerDirectory`; an empty entry is that directory, as POSIX reads it. With no PATH in
 * the child environment, Node searches /usr/bin:/bin on Unix and the parent's PATH on Windows.
 */
function searchDirectories(path: string | undefined, callerDirectory: string): string[] {
  const entries = path ?? (process.platform === "win32" ? process.env.PATH : UNIX_DEFAULT_PATH);
  if (entries === undefined) return [];
  return entries
    .split(delimiter)
    .map((directory) => (directory === "" ? callerDirectory : absolutePath(directory, callerDirectory)));
}

/**
 * The program an executable names. A name with a separator is a path and resolves against the caller's directory. A
 * bare name is searched for in `directories`, which are absolute. It is not an ExternalToolName, and it never reads the
 * UE Viewer override: an injected name is the program it names.
 */
async function resolveProgram(
  executable: string,
  directories: readonly string[],
  callerDirectory: string,
): Promise<string> {
  if (basename(executable) !== executable) return absolutePath(executable, callerDirectory);
  for (const directory of directories) {
    for (const suffix of EXECUTABLE_SUFFIXES) {
      const candidate = join(directory, `${executable}${suffix}`);
      if (await isExecutableFile(candidate)) return candidate;
    }
  }
  throw new ToolchainError(
    "UNREAL_TOOL_UNUSABLE",
    `"${executable}" could not be started: no executable of that name is on PATH.`,
  );
}

/** The candidate test resolveExecutable applies in toolchain.ts. */
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

function absolutePath(path: string, base: string): string {
  return isAbsolute(path) ? path : resolve(base, path);
}
