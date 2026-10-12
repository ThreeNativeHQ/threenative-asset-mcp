import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import { runDoctor } from "../scripts/doctor.js";
import { PREREQUISITES, prerequisiteById } from "../scripts/prerequisites.js";
import { modernSdkExecutable } from "../src/unreal/provision.js";

/** A PATH directory holding a symlink to every executable on this PATH except the named ones. */
async function pathWithout(...hidden: string[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "asset-mcp-doctor-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const seen = new Set<string>(hidden);
  for (const source of (process.env.PATH ?? "").split(delimiter)) {
    if (!source) continue;
    let names: string[];
    try {
      names = await readdir(source);
    } catch {
      continue;
    }
    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);
      await symlink(join(source, name), join(directory, name)).catch(() => undefined);
    }
  }
  return directory;
}

/** A fresh temp directory, removed when the test ends. */
async function scratchDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "asset-mcp-modern-prereq-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/**
 * A POSIX stand-in for `dotnet`: `--version` prints `version` and exits with `status`, as an SDK's would. Windows cannot
 * run a shell script, so every test that calls it skips on win32.
 */
async function fakeDotnet(directory: string, version: string, status = 0): Promise<void> {
  const path = join(directory, "dotnet");
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${version}'\nexit ${status}\n`);
  await chmod(path, 0o755);
}

/** The toolchain cache's private SDK, the copy the provisioner installs under `modern/dotnet`. */
async function cachedSdk(cache: string, version: string, status = 0): Promise<void> {
  await mkdir(join(cache, "modern", "dotnet"), { recursive: true });
  await fakeDotnet(join(cache, "modern", "dotnet"), version, status);
}

/** The converter's bin with the three SharpGLTF assemblies; `missing` leaves that one out. */
async function sharpGltfAssemblies(cache: string, missing?: string): Promise<void> {
  const bin = join(cache, "modern", "bin");
  await mkdir(bin, { recursive: true });
  for (const assembly of ["SharpGLTF.Core.dll", "SharpGLTF.Runtime.dll", "SharpGLTF.Toolkit.dll"]) {
    if (assembly !== missing) await writeFile(join(bin, assembly), "");
  }
}

/** PATH holds only `host`, so no SDK installed on this machine can satisfy a case by accident. */
function gateEnvironment(cache: string, host: string): NodeJS.ProcessEnv {
  return { ...process.env, PATH: host, THREENATIVE_TOOLCHAIN_DIR: cache };
}

const hostHasTestTools = PREREQUISITES.filter((entry) => entry.group === "test").every(
  (entry) => entry.check(process.env).ok,
);

describe("npm run doctor", () => {
  it("reports a missing ffmpeg with its fix and exits 1", async () => {
    const PATH = await pathWithout("ffmpeg", "ffprobe");
    const { lines, exitCode } = runDoctor({ env: { ...process.env, PATH } });
    expect(exitCode).toBe(1);
    const line = lines.find((entry) => entry.includes("ffmpeg") && entry.includes("missing"));
    expect(line).toBeDefined();
    expect(line).toContain("fix:");
  });

  it.skipIf(!hostHasTestTools)("exits 0 when every test prerequisite is present", () => {
    expect(runDoctor({ env: process.env }).exitCode).toBe(0);
  });

  it.skipIf(process.platform !== "linux")(
    "--toolchain-only checks the toolchain group alone and fails on a missing toolchain item",
    async () => {
      const PATH = await pathWithout("ffmpeg", "ffprobe", "perl");
      const { lines, exitCode } = runDoctor({
        env: { ...process.env, PATH },
        toolchain: true,
        groups: ["toolchain"],
      });
      expect(exitCode).toBe(1);
      expect(lines.some((entry) => entry.includes("perl") && entry.includes("missing"))).toBe(true);
      expect(lines.some((entry) => entry.includes("ffmpeg"))).toBe(false);
    },
  );

  it("warns, without failing, for a missing toolchain item unless --toolchain is set", () => {
    const { lines } = runDoctor({ env: process.env, groups: ["toolchain"] });
    expect(lines.some((entry) => entry.startsWith("missing"))).toBe(false);
  });
});

describe("test-only prerequisites", () => {
  it("resolve modern-converter by id without putting it in the doctor catalogue", () => {
    expect(prerequisiteById("modern-converter").id).toBe("modern-converter");
    expect(PREREQUISITES.map((entry) => entry.id)).not.toContain("modern-converter");
  });

  it.skipIf(process.platform === "win32")(
    "accept a .NET 10 SDK on the host PATH with all three SharpGLTF assemblies and no cached SDK",
    async () => {
      const host = await scratchDirectory();
      const cache = await scratchDirectory();
      await fakeDotnet(host, "10.0.400");
      await sharpGltfAssemblies(cache);
      expect(prerequisiteById("modern-converter").check(gateEnvironment(cache, host)).ok).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")(
    "resolve that same host SDK in modernSdkExecutable, without installing one",
    async () => {
      const host = await scratchDirectory();
      const cache = await scratchDirectory();
      await fakeDotnet(host, "10.0.400");
      await expect(modernSdkExecutable(gateEnvironment(cache, host))).resolves.toBe("dotnet");
      expect(await readdir(cache)).toEqual([]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "fall back to the cached .NET 10 SDK when the host dotnet is another major",
    async () => {
      const host = await scratchDirectory();
      const cache = await scratchDirectory();
      await fakeDotnet(host, "8.0.408");
      await cachedSdk(cache, "10.0.400");
      await sharpGltfAssemblies(cache);
      expect(prerequisiteById("modern-converter").check(gateEnvironment(cache, host)).ok).toBe(true);
    },
  );

  it("refuse when neither the host nor the cached SDK exists", async () => {
    const host = await scratchDirectory();
    const cache = await scratchDirectory();
    await sharpGltfAssemblies(cache);
    expect(prerequisiteById("modern-converter").check(gateEnvironment(cache, host)).ok).toBe(false);
  });

  // Each row names an SDK as [what --version prints, exit status]. The assemblies are present, so only the SDK can fail.
  it.skipIf(process.platform === "win32").each<[string, { host?: [string, number]; cached?: [string, number] }]>([
    ["a host dotnet of another major", { host: ["8.0.408", 0] }],
    ["a host dotnet that exits nonzero", { host: ["10.0.400", 1] }],
    ["a cached SDK of another major", { cached: ["9.0.100", 0] }],
    ["a cached SDK that exits nonzero", { cached: ["10.0.400", 1] }],
  ])("refuse %s", async (_name, sdks) => {
    const host = await scratchDirectory();
    const cache = await scratchDirectory();
    if (sdks.host) await fakeDotnet(host, ...sdks.host);
    if (sdks.cached) await cachedSdk(cache, ...sdks.cached);
    await sharpGltfAssemblies(cache);
    expect(prerequisiteById("modern-converter").check(gateEnvironment(cache, host)).ok).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "pass only with a .NET 10 SDK and all three SharpGLTF assemblies in the toolchain cache",
    async () => {
      const host = await scratchDirectory();
      const cache = await scratchDirectory();
      const env = gateEnvironment(cache, host);
      const modern = prerequisiteById("modern-converter");
      await cachedSdk(cache, "10.0.400");
      expect(modern.check(env).ok).toBe(false);
      await sharpGltfAssemblies(cache, "SharpGLTF.Toolkit.dll");
      expect(modern.check(env).ok).toBe(false);
      await sharpGltfAssemblies(cache);
      expect(modern.check(env).ok).toBe(true);
    },
  );
});
