import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// node's module compile cache lives in TMPDIR by design; it is not a test leak.
const SHARED_CACHE = "node-compile-cache";
const MAX_LINES = 50;
// Spawning vitest.mjs with node avoids a shell and the npx lookup, which would add a second process.
const VITEST_ENTRY = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));

function usage(message: string): never {
  console.error(`leak-gate: ${message}\nusage: tsx scripts/leak-gate.ts [--dir <path>] -- <command...>`);
  process.exit(2);
}

async function prepareDir(requested: string | undefined): Promise<string> {
  if (requested === undefined) return mkdtemp(join(tmpdir(), "leak-gate-"));
  const target = resolve(requested);
  let existing: string[] = [];
  try {
    existing = await readdir(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Refuse a populated directory: the gate deletes its directory on exit, and that must never be
  // a directory somebody else was using.
  if (existing.length > 0) usage(`--dir ${target} exists and is not empty`);
  await mkdir(target, { recursive: true });
  return target;
}

function runCommand(command: readonly string[], dir: string): Promise<number> {
  const [program = "", ...rest] = command;
  const [file, args] = program === "vitest" ? [process.execPath, [VITEST_ENTRY, ...rest]] : [program, rest];
  return new Promise((done) => {
    const child = spawn(file, args, {
      stdio: "inherit",
      shell: false,
      env: { ...process.env, TMPDIR: dir, TMP: dir, TEMP: dir },
    });
    child.on("error", (error) => {
      console.error(`leak-gate: cannot start ${file}: ${error.message}`);
      done(1);
    });
    child.on("exit", (code) => done(code ?? 1));
  });
}

async function leftovers(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true });
  return entries.filter((entry) => entry.split(sep)[0] !== SHARED_CACHE);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const separator = argv.indexOf("--");
  const options = separator === -1 ? argv : argv.slice(0, separator);
  const command = separator === -1 ? [] : argv.slice(separator + 1);
  if (command.length === 0) usage("missing command after --");
  if (options.length !== 0 && !(options.length === 2 && options[0] === "--dir")) usage("unknown option");

  const dir = await prepareDir(options[1]);
  try {
    const exitCode = await runCommand(command, dir);
    const found = await leftovers(dir);
    const count = new Set(found.map((entry) => entry.split(sep)[0])).size;
    if (count === 0) {
      console.log("leak-gate: clean");
    } else {
      console.log(`leak-gate: ${count} leftover(s):`);
      for (const entry of found.slice(0, MAX_LINES)) console.log(`  ${entry}`);
      if (found.length > MAX_LINES) console.log(`  ... ${found.length - MAX_LINES} more`);
    }
    if (exitCode !== 0) return exitCode;
    return count > 0 ? 1 : 0;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main()
  .then((code) => (process.exitCode = code))
  .catch((error: unknown) => {
    console.error(`leak-gate: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  });
