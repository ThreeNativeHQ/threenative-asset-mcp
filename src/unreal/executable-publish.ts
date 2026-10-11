import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { ToolchainError, runBounded } from "./toolchain.js";

/**
 * Runs `path` and returns its combined output when it exits 0, or undefined when it cannot start or exits non-zero. A
 * build that prints its banner and markers and then fails has not shown that it works, so an attestation must not read
 * its output. A file that a process (this one included, through a fork) still holds open for writing refuses exec with
 * ETXTBSY until that child execs, so that one error is retried a few times rather than reported as a broken build.
 */
export async function runCandidate(path: string, args: readonly string[]): Promise<string | undefined> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const run = await runBounded(path, args, { timeoutMs: 30_000 });
      return run.code === 0 ? `${run.stdout}\n${run.stderr}` : undefined;
    } catch (error) {
      if (attempt >= 5 || (error as NodeJS.ErrnoException | undefined)?.code !== "ETXTBSY") return undefined;
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
    }
  }
}

/**
 * Publishes the executable at `source` as `destination` without ever writing to `destination`. The copy gets a unique
 * name beside the destination, so it is on the same filesystem and the rename is atomic. It is made executable and must
 * pass `attest` before the rename. A process still running the old file keeps its own inode, so the rename cannot fail
 * with ETXTBSY or corrupt it, and concurrent publishers each leave a complete binary. A failed copy is removed.
 */
export async function publishExecutable(
  source: string,
  destination: string,
  attest: (candidate: string) => Promise<boolean>,
): Promise<void> {
  const directory = dirname(destination);
  await mkdir(directory, { recursive: true });
  const staged = join(directory, `.${basename(destination)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await copyFile(source, staged);
    await chmod(staged, 0o755);
    if (!(await attest(staged))) {
      throw new ToolchainError(
        "UNREAL_TOOL_UNUSABLE",
        `The build for "${destination}" did not pass its attestation, so the installed copy was left unchanged.`,
      );
    }
    await rename(staged, destination);
  } finally {
    await rm(staged, { force: true });
  }
}
