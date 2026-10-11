import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishExecutable, runCandidate } from "../src/unreal/executable-publish.js";
import { umodelCorrectedAt } from "../src/unreal/provision.js";
import { runBounded } from "../src/unreal/toolchain.js";
import { describeWithTools } from "./helpers/require-tool.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Prints a ready line, then waits for one line on stdin before it reports the old code. */
const OLD_PROGRAM = `#include <cstdio>
int main()
{
\tstd::puts("publish-test: ready");
\tstd::fflush(stdout);
\tchar line[16];
\tif (!std::fgets(line, sizeof line, stdin)) return 1;
\tstd::puts("publish-test: old");
\treturn 0;
}
`;

const NEW_PROGRAM = `#include <cstdio>
int main()
{
\tstd::puts("publish-test: new");
\treturn 0;
}
`;

async function compile(name: string, source: string, directory: string): Promise<string> {
  const sourcePath = join(directory, `${name}.cpp`);
  const executable = join(directory, name);
  await writeFile(sourcePath, source);
  const compiled = await runBounded("g++", ["-std=c++17", "-O0", "-o", executable, sourcePath], {
    cwd: directory,
    timeoutMs: 120_000,
  });
  if (compiled.code !== 0) throw new Error(`g++ rejected ${name}: ${compiled.stderr}`);
  return executable;
}

/** A cache holding the old binary as its installed copy, and the replacement built apart from the cache. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "umodel-publish-"));
  roots.push(root);
  const build = join(root, "build");
  const cache = join(root, "cache");
  await mkdir(build);
  await mkdir(cache);
  const old = await compile("old", OLD_PROGRAM, build);
  const replacement = await compile("new", NEW_PROGRAM, build);
  const installed = join(cache, "umodel");
  await copyFile(old, installed);
  await chmod(installed, 0o755);
  return { old, replacement, installed, cache };
}

const attestReplacement = async (candidate: string) =>
  (await runCandidate(candidate, []))?.includes("publish-test: new") === true;

describeWithTools(["g++"], "UE Viewer publication (compiled)", () => {
  it("keeps a running old binary on the old code, and the next run on the new code", async () => {
    const { replacement, installed } = await fixture();
    const child = spawn(installed, [], { stdio: ["pipe", "pipe", "ignore"] });
    try {
      let printed = "";
      child.stdout.setEncoding("utf8");
      const ready = new Promise<void>((resolve) => {
        child.stdout.on("data", (chunk: string) => {
          printed += chunk;
          if (printed.includes("publish-test: ready")) resolve();
        });
      });
      const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
      await Promise.race([ready, closed.then(() => Promise.reject(new Error("the old binary exited before ready")))]);

      await publishExecutable(replacement, installed, attestReplacement);

      child.stdin.end("go\n");
      expect(await closed).toBe(0);
      expect(printed).toContain("publish-test: old");
      expect(await runCandidate(installed, [])).toContain("publish-test: new");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  });

  it("lets concurrent publishers finish with one complete binary and no temporary files", async () => {
    const { replacement, installed, cache } = await fixture();
    await Promise.all([1, 2, 3, 4].map(() => publishExecutable(replacement, installed, attestReplacement)));
    expect(await runCandidate(installed, [])).toContain("publish-test: new");
    expect(await readdir(cache)).toEqual(["umodel"]);
  });

  it("leaves the installed copy untouched when the candidate fails attestation, and keeps no temporary file", async () => {
    const { old, replacement, installed, cache } = await fixture();
    await expect(publishExecutable(replacement, installed, async () => false)).rejects.toThrow(/attestation/);
    expect(await readFile(installed)).toEqual(await readFile(old));
    expect(await readdir(cache)).toEqual(["umodel"]);
  });
});

/** The corrected build a cache holds before a new one is published over it. */
const INSTALLED_UMODEL = `#!/bin/sh
printf 'UE Viewer (UModel)\\nThreeNative-UModel-BoolTags-1\\nThreeNative-UModel-NormalPack-1\\n'
`;

/** Prints both fix markers and then fails: its output looks corrected, its exit status says it is not. */
const FAILING_UMODEL = `#!/bin/sh
printf 'UE Viewer (UModel)\\nThreeNative-UModel-BoolTags-1\\nThreeNative-UModel-NormalPack-1\\n'
exit 1
`;

describe("UE Viewer attestation before publication", () => {
  it("does not publish a failing build over an installed corrected copy, and keeps no temporary file", async () => {
    const root = await mkdtemp(join(tmpdir(), "umodel-attest-"));
    roots.push(root);
    const cache = join(root, "cache");
    const installed = join(cache, "umodel");
    const candidate = join(root, "candidate");
    await mkdir(cache);
    await writeFile(installed, INSTALLED_UMODEL);
    await chmod(installed, 0o755);
    await writeFile(candidate, FAILING_UMODEL);
    await chmod(candidate, 0o755);
    await expect(publishExecutable(candidate, installed, umodelCorrectedAt)).rejects.toMatchObject({
      code: "UNREAL_TOOL_UNUSABLE",
    });
    expect(await readFile(installed, "utf8")).toBe(INSTALLED_UMODEL);
    expect(await readdir(cache)).toEqual(["umodel"]);
  });
});
