import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { browserTempEnvironment, createBrowserTempDir } from "../src/browser-temp.js";
import { probeChromium } from "../src/creature/preview.js";

const savedEnv = { TMPDIR: process.env.TMPDIR, PW_CHROMIUM_PATH: process.env.PW_CHROMIUM_PATH };
const roots: string[] = [];

async function scratch(prefix: string): Promise<string> {
  const path = await mkdtemp(join(savedEnv.TMPDIR ?? tmpdir(), prefix));
  roots.push(path);
  return path;
}

function restore(name: keyof typeof savedEnv): void {
  if (savedEnv[name] === undefined) delete process.env[name];
  else process.env[name] = savedEnv[name];
}

beforeEach(() => {
  roots.length = 0;
});

afterEach(async () => {
  restore("TMPDIR");
  restore("PW_CHROMIUM_PATH");
  await Promise.all(roots.map((path) => rm(path, { recursive: true, force: true })));
});

describe("browser temp directory", () => {
  it("maps one path onto every temp variable", () => {
    expect(browserTempEnvironment("/x")).toEqual({ TMPDIR: "/x", TMP: "/x", TEMP: "/x" });
  });

  it("creates a private directory and removes it", async () => {
    const testTmp = await scratch("browser-temp-test-");
    process.env.TMPDIR = testTmp;
    const temp = await createBrowserTempDir();
    expect(dirname(temp.path)).toBe(testTmp);
    expect(basename(temp.path)).toMatch(/^threenative-browser-/u);
    expect(temp.env).toEqual({ TMPDIR: temp.path, TMP: temp.path, TEMP: temp.path });
    await writeFile(join(temp.path, ".org.chromium.Chromium.leak"), "");
    await temp.remove();
    expect(await readdir(testTmp)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("keeps the Chromium shm file out of the caller's TMPDIR", async () => {
    const testTmp = await scratch("browser-temp-test-");
    const fakeDir = await scratch("browser-temp-fake-");
    const log = join(fakeDir, "tmpdirs.log");
    const fake = join(fakeDir, "chromium");
    await writeFile(
      fake,
      `#!/bin/sh\ntouch "$TMPDIR/.org.chromium.Chromium.fake"\necho "$TMPDIR" >> "${log}"\nexit 1\n`,
    );
    await chmod(fake, 0o755);
    process.env.TMPDIR = testTmp;
    process.env.PW_CHROMIUM_PATH = fake;

    const result = await probeChromium();

    expect(result.available).toBe(false);
    const seen = (await readFile(log, "utf8")).trim().split("\n");
    expect(seen).toHaveLength(1);
    expect(dirname(seen[0]!)).toBe(testTmp);
    expect(basename(seen[0]!)).toMatch(/^threenative-browser-/u);
    expect(await readdir(testTmp)).toEqual([]);
  });
});
