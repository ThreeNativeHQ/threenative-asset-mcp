import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { resolveExecutable } from "../src/unreal/toolchain.js";
import { runUmodelExport } from "../src/unreal/umodel-export.js";
import { writeFakeUmodel } from "./helpers/unreal-fixture.js";

const LIMITS = { timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 };
const SELECTOR = "Content/Props/Rock";
/** Package folders UE Viewer appends: under a ~210-character absolute root they overflow its 256-byte buffer. */
const FOLDERS = `Group/${"Vegetation-Conifer-Pines-Mesh-LODs/".repeat(2)}Package`;
/** Too long for UE Viewer even relative to its output root. */
const OVERLONG_FOLDERS = `Group/${"q".repeat(120)}/${"r".repeat(140)}`;

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "umodel-export-unit-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** A UE Viewer stand-in at `umodelPath` that exports three sidecars for Rock under `outputSubdirectory`. */
async function writeStandIn(
  root: string,
  umodelPath: string,
  options: { readonly outputSubdirectory?: string; readonly argvLog?: string } = {},
): Promise<void> {
  const exported = join(root, "exported");
  await mkdir(exported, { recursive: true });
  await writeFile(join(exported, "Rock.mat"), "material");
  await writeFile(join(exported, "Rock.props.txt"), "props");
  await writeFile(join(exported, "Rock.png"), "png");
  await writeFakeUmodel(umodelPath, {
    exportFrom: exported,
    classes: {},
    outputSubdirectory: options.outputSubdirectory ?? FOLDERS,
    ...(options.argvLog === undefined ? {} : { argvLog: options.argvLog }),
    nativeOutputPaths: true,
  });
}

/** Calls runUmodelExport in a process of its own; the tsx CLI loads the TypeScript that process imports. */
const CALLER = fileURLToPath(new URL("./helpers/umodel-export-caller.ts", import.meta.url));
const TSX_CLI = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
const execFileAsync = promisify(execFile);

/** What umodel-export-caller.ts prints: the run's result, or the error it threw. */
type CallerOutcome =
  | { readonly code: number; readonly stdout: string; readonly stderr: string }
  | { readonly error: { readonly code: string; readonly message: string } };

/**
 * Runs runUmodelExport in a process whose working directory is `directory` and whose environment is `environment`. A
 * relative name resolves against `directory`, and this test process never changes directory.
 */
async function exportFromDirectory(
  directory: string,
  environment: NodeJS.ProcessEnv,
  executable: string,
  sourceDir: string,
  outputRoot: string,
): Promise<CallerOutcome> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [TSX_CLI, CALLER, executable, sourceDir, outputRoot, SELECTOR],
    { cwd: directory, env: environment, encoding: "utf8" },
  );
  return JSON.parse(stdout) as CallerOutcome;
}

/**
 * This process's environment with PATH set to `path`, or with no PATH at all when `path` is undefined. TMPDIR is
 * `tempRoot`, so the TypeScript cache tsx leaves for the runner is removed with the test's other temporary files.
 */
function callerEnvironment(path: string | undefined, tempRoot: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, PATH: path, TMPDIR: tempRoot };
  if (path === undefined) delete environment.PATH;
  return environment;
}

/** An executable `/bin/sh` script at `path`. Its interpreter is absolute, so it does not depend on PATH. */
async function writeShellScript(path: string, body: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
}

describe("runUmodelExport", () => {
  it("writes the same sidecars under a long output root as under a short one, always with -out=./", async () => {
    const root = await tempRoot();
    const sourceDir = join(root, "source");
    await mkdir(sourceDir);
    const umodel = join(root, "umodel");
    const argvLog = join(root, "argv.log");
    await writeStandIn(root, umodel, { argvLog });
    const long = join(root, "a".repeat(60), "b".repeat(60), "c".repeat(60));
    const short = join(root, "short");
    // An absolute `-out=` of this root would overflow UE Viewer's buffer; the output root was never passed that way.
    expect(join(long, FOLDERS).length).toBeGreaterThan(255);

    await runUmodelExport(umodel, relative(process.cwd(), sourceDir), long, ["-png"], SELECTOR, LIMITS);
    await runUmodelExport(umodel, sourceDir, short, ["-png"], SELECTOR, LIMITS);

    for (const name of ["Rock.mat", "Rock.props.txt", "Rock.png"]) {
      expect(await readFile(join(long, FOLDERS, name))).toEqual(await readFile(join(short, FOLDERS, name)));
    }
    const invocations = (await readFile(argvLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
    expect(invocations).toHaveLength(2);
    for (const argv of invocations) {
      expect(argv).toContain("-out=./");
      expect(argv).toContain(`-path=${sourceDir}`);
    }
  });

  it("fails the export when UE Viewer reports 'Error creating file', even though it exits 0", async () => {
    const root = await tempRoot();
    const sourceDir = join(root, "source");
    await mkdir(sourceDir);
    const umodel = join(root, "umodel");
    await writeStandIn(root, umodel, { outputSubdirectory: OVERLONG_FOLDERS });
    const out = join(root, "out");

    await expect(runUmodelExport(umodel, sourceDir, out, ["-png"], SELECTOR, LIMITS)).rejects.toMatchObject({
      name: "ToolchainError",
      code: "UNREAL_TOOL_FAILED",
      message: expect.stringContaining("Error creating file"),
    });
    expect(existsSync(join(out, OVERLONG_FOLDERS, "Rock.mat"))).toBe(false);
  });

  it("keeps other exit-0 warnings as evidence instead of failing the export", async () => {
    const root = await tempRoot();
    const sourceDir = join(root, "source");
    await mkdir(sourceDir);
    const warner = join(root, "warner");
    await writeFile(warner, "#!/usr/bin/env node\nprocess.stderr.write('Warning: texture Rock was skipped\\n');\n");
    await chmod(warner, 0o755);

    const run = await runUmodelExport(warner, sourceDir, join(root, "out"), ["-png"], SELECTOR, LIMITS);

    expect(run.code).toBe(0);
    expect(run.stderr).toContain("Warning: texture Rock was skipped");
  });

  it("resolves a relative executable and a relative PATH entry against the caller's working directory", async () => {
    const root = await tempRoot();
    const sourceDir = join(root, "source");
    await mkdir(sourceDir);
    const bin = join(root, "bin");
    await mkdir(bin);
    const umodel = join(bin, "umodel");
    await writeStandIn(root, umodel);

    const explicit = join(root, "explicit");
    await runUmodelExport(relative(process.cwd(), umodel), sourceDir, explicit, ["-png"], SELECTOR, LIMITS);
    expect(existsSync(join(explicit, FOLDERS, "Rock.mat"))).toBe(true);

    const found = await resolveExecutable("umodel", { PATH: relative(process.cwd(), bin) });
    expect(resolve(found)).toBe(umodel);
    const viaPath = join(root, "via-path");
    await runUmodelExport(found, sourceDir, viaPath, ["-png"], SELECTOR, LIMITS);
    expect(existsSync(join(viaPath, FOLDERS, "Rock.mat"))).toBe(true);
  });
});

describe("runUmodelExport finds a bare executable on the child's PATH", () => {
  const originalPath = process.env.PATH;

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(() => {
    // Every PATH change in this file is a stub that afterEach removes; none may outlive the file.
    expect(process.env.PATH).toBe(originalPath);
  });

  /** A PATH holding `directories`, then the directory of the node binary the stand-ins start with. */
  function pathWith(...directories: string[]): string {
    return [...directories, dirname(process.execPath)].join(delimiter);
  }

  it("finds a bare name that only PATH holds, while the caller's working directory has no such file", async () => {
    const root = await tempRoot();
    const sourceDir = join(root, "source");
    await mkdir(sourceDir);
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeStandIn(root, join(bin, "umodel"));
    vi.stubEnv("PATH", pathWith(bin));
    expect(existsSync(join(process.cwd(), "umodel"))).toBe(false);

    const out = join(root, "out");
    await runUmodelExport("umodel", sourceDir, out, ["-png"], SELECTOR, LIMITS);

    expect(existsSync(join(out, FOLDERS, "Rock.mat"))).toBe(true);
  });

  it("runs an interpreter that only a relative PATH entry holds, from that entry's directory", async () => {
    const root = await tempRoot();
    const sourceDir = join(root, "source");
    await mkdir(sourceDir);
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeStandIn(root, join(bin, "umodel"));
    // The stand-in starts with `#!/usr/bin/env node` and PATH names no other directory, so node is reachable only
    // through the relative entry. The caller is `root` itself: a path relative to this process's directory can resolve
    // from the output root by accident and would pass.
    await symlink(process.execPath, join(bin, "node"));
    const out = join(root, "out");

    const outcome = await exportFromDirectory(root, callerEnvironment("bin", root), "umodel", sourceDir, out);

    expect(outcome).toMatchObject({ code: 0 });
    expect(existsSync(join(out, FOLDERS, "Rock.mat"))).toBe(true);
  });

  it("runs a bare alias under its own name, never another executable on PATH", async () => {
    const root = await tempRoot();
    const sourceDir = join(root, "source");
    await mkdir(sourceDir);
    const aliases = join(root, "aliases");
    const native = join(root, "native");
    await mkdir(aliases);
    await mkdir(native);
    await writeStandIn(root, join(aliases, "umodel-alias"), { outputSubdirectory: "Alias/Folders" });
    await writeStandIn(root, join(native, "umodel"), { outputSubdirectory: "Native/Folders" });
    vi.stubEnv("PATH", pathWith(native, aliases));

    const out = join(root, "out");
    await runUmodelExport("umodel-alias", sourceDir, out, ["-png"], SELECTOR, LIMITS);

    expect(existsSync(join(out, "Alias/Folders", "Rock.mat"))).toBe(true);
    expect(existsSync(join(out, "Native"))).toBe(false);
  });

  it("runs an absolute executable as given, whatever PATH holds", async () => {
    const root = await tempRoot();
    const sourceDir = join(root, "source");
    await mkdir(sourceDir);
    const umodel = join(root, "umodel");
    await writeStandIn(root, umodel);
    vi.stubEnv("PATH", pathWith());

    const out = join(root, "out");
    await runUmodelExport(umodel, sourceDir, out, ["-png"], SELECTOR, LIMITS);

    expect(existsSync(join(out, FOLDERS, "Rock.mat"))).toBe(true);
  });

  it("does not read the UE Viewer path override for a bare name, so the name is the executable it names", async () => {
    const root = await tempRoot();
    const sourceDir = join(root, "source");
    await mkdir(sourceDir);
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeStandIn(root, join(bin, "umodel"));
    vi.stubEnv("PATH", pathWith(bin));
    // resolveExecutable would reject this override; a bare name injected by a caller never reaches it.
    vi.stubEnv("THREENATIVE_UMODEL_PATH", "not/absolute/umodel");

    const out = join(root, "out");
    await runUmodelExport("umodel", sourceDir, out, ["-png"], SELECTOR, LIMITS);

    expect(existsSync(join(out, FOLDERS, "Rock.mat"))).toBe(true);
  });

  it("runs a bare name that an empty PATH entry holds in the caller's directory, not the output's", async () => {
    const root = await tempRoot();
    const sourceDir = join(root, "source");
    await mkdir(sourceDir);
    const caller = join(root, "caller");
    await mkdir(caller);
    const out = join(root, "out");
    await mkdir(out);
    await writeShellScript(join(caller, "umodel"), "echo from-caller");
    await writeShellScript(join(out, "umodel"), "echo from-output\nexit 9");

    const outcome = await exportFromDirectory(caller, callerEnvironment("", root), "umodel", sourceDir, out);

    expect(outcome).toEqual({ code: 0, stdout: "from-caller\n", stderr: "" });
  });

  it("searches Node's default Unix path when the child has no PATH, never the caller's directory", async () => {
    const root = await tempRoot();
    const sourceDir = join(root, "source");
    await mkdir(sourceDir);
    const caller = join(root, "caller");
    await mkdir(caller);
    // The caller's directory holds a `true` that exits 7, so the outcome shows which `true` ran.
    await writeShellScript(join(caller, "true"), "exit 7");
    const out = join(root, "out");

    const outcome = await exportFromDirectory(caller, callerEnvironment(undefined, root), "true", sourceDir, out);

    expect(outcome).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it("fails to start a bare name that no PATH entry holds, even when the output directory holds it", async () => {
    const root = await tempRoot();
    const sourceDir = join(root, "source");
    await mkdir(sourceDir);
    const out = join(root, "out");
    await mkdir(out);
    await writeStandIn(root, join(out, "umodel"));
    vi.stubEnv("PATH", pathWith());

    await expect(runUmodelExport("umodel", sourceDir, out, ["-png"], SELECTOR, LIMITS)).rejects.toMatchObject({
      name: "ToolchainError",
      code: "UNREAL_TOOL_UNUSABLE",
      message: expect.stringContaining("could not be started"),
    });
    expect(existsSync(join(out, FOLDERS, "Rock.mat"))).toBe(false);
  });
});
