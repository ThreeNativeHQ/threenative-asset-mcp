import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import { runDoctor } from "../scripts/doctor.js";
import { PREREQUISITES, prerequisiteById } from "../scripts/prerequisites.js";

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

  it("pass only with the private .NET SDK and all three SharpGLTF assemblies in the toolchain cache", async () => {
    const cache = await mkdtemp(join(tmpdir(), "asset-mcp-modern-prereq-"));
    onTestFinished(() => rm(cache, { recursive: true, force: true }));
    const env = { ...process.env, THREENATIVE_TOOLCHAIN_DIR: cache };
    const modern = prerequisiteById("modern-converter");
    const dotnet = join(cache, "modern", "dotnet", process.platform === "win32" ? "dotnet.exe" : "dotnet");
    const bin = join(cache, "modern", "bin");
    await mkdir(join(cache, "modern", "dotnet"), { recursive: true });
    await mkdir(bin, { recursive: true });
    expect(modern.check(env).ok).toBe(false);
    await writeFile(dotnet, "");
    await writeFile(join(bin, "SharpGLTF.Core.dll"), "");
    await writeFile(join(bin, "SharpGLTF.Runtime.dll"), "");
    expect(modern.check(env).ok).toBe(false);
    await writeFile(join(bin, "SharpGLTF.Toolkit.dll"), "");
    expect(modern.check(env).ok).toBe(true);
  });
});
