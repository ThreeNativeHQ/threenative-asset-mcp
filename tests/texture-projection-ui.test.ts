import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { buildTextureProjectionApp } from "../scripts/build-texture-projection-app.js";
import { openAppSession, type AppSession } from "../src/texture-projection/session.js";
import { startUiServer, type UiServer } from "../src/texture-projection/ui-server.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEVEL = join(REPO, "tests", "fixtures", "texture-projection", "courtyard.glb");
const APP_DIR = join(REPO, "dist", "texture-projection", "app");
const FAKE_KEY = "sk-or-v1-ui-test-key-that-must-never-reach-the-page";

const temporaryDirectories: string[] = [];
let server: UiServer | undefined;
let app: AppSession | undefined;

async function scratchDir(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `threenative-asset-mcp-${name}-`));
  temporaryDirectories.push(directory);
  return directory;
}

// `npx vitest run` alone does not run the npm build, so the app is bundled here when dist is empty.
beforeAll(async () => {
  try {
    await stat(join(APP_DIR, "index.html"));
  } catch {
    await buildTextureProjectionApp();
  }
}, 120_000);

afterEach(async () => {
  await app?.close();
  app = undefined;
  await server?.close();
  server = undefined;
});

afterAll(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("texture-projection UI server", () => {
  it("serves the bundled app on 127.0.0.1 and quotes without an API key", async () => {
    const cwd = await scratchDir("ui-serve");
    server = await startUiServer({
      levelPath: LEVEL,
      runRoot: join(cwd, "runs"),
      env: { OPENROUTER_API_KEY: FAKE_KEY },
    });
    expect(server.url.startsWith("http://127.0.0.1:")).toBe(true);

    const page = await fetch(`${server.url}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const html = await page.text();
    expect(html).toContain("Texture projection");
    expect(html).toContain("app.js");

    const bundle = await fetch(`${server.url}/app.js`);
    expect(bundle.status).toBe(200);
    expect(bundle.headers.get("content-type")).toContain("javascript");
    expect((await bundle.text()).length).toBeGreaterThan(100_000);

    const state = (await (await fetch(`${server.url}/api/state`)).json()) as {
      level?: { name: string };
      runs: unknown[];
    };
    expect(state.level?.name).toBe("courtyard");
    expect(state.runs).toEqual([]);

    const level = await fetch(`${server.url}/api/level`);
    expect(level.status).toBe(200);
    expect((await level.arrayBuffer()).byteLength).toBe((await readFile(LEVEL)).byteLength);
  });
});

describe("texture-projection UI page", () => {
  it("defaults both model selectors to or-klein, can list the paid aliases and never sees the key", async () => {
    const cwd = await scratchDir("ui-page");
    server = await startUiServer({
      levelPath: LEVEL,
      runRoot: join(cwd, "runs"),
      env: { OPENROUTER_API_KEY: FAKE_KEY },
    });
    app = await openAppSession({ url: server.url, headless: false });
    const page = app.page;
    await page.waitForSelector("#first-model");

    const selectors = await page.evaluate(() => {
      const read = (id: string) => {
        const select = document.getElementById(id) as HTMLSelectElement | null;
        return { value: select?.value, options: [...(select?.options ?? [])].map((option) => option.value) };
      };
      return { first: read("first-model"), fill: read("fill-model") };
    });
    expect(selectors.first.value).toBe("or-klein");
    expect(selectors.fill.value).toBe("or-klein");
    expect(selectors.first.options).toEqual(["or-klein", "muse-image", "or-seedream-lite"]);
    expect(selectors.fill.options).toEqual(["or-klein", "muse-image", "or-seedream-lite"]);

    const exposed = await page.evaluate(() => {
      const strings: string[] = [document.documentElement.outerHTML];
      for (const name of Object.getOwnPropertyNames(window)) {
        try {
          const value = (window as unknown as Record<string, unknown>)[name];
          if (typeof value === "string") strings.push(value);
        } catch {
          // accessors that throw are not carrying a key either
        }
      }
      const storage = (store: Storage) => {
        for (let index = 0; index < store.length; index += 1) {
          const key = store.key(index);
          if (key !== null) strings.push(`${key}=${store.getItem(key) ?? ""}`);
        }
      };
      storage(localStorage);
      storage(sessionStorage);
      return strings.join("\n");
    });
    expect(exposed).not.toContain(FAKE_KEY);
    expect(exposed).not.toContain("sk-or-v1");
  });

  it(
    "quotes the sample level on load, before any API call",
    async () => {
      const cwd = await scratchDir("ui-quote");
      server = await startUiServer({
        levelPath: LEVEL,
        runRoot: join(cwd, "runs"),
        env: { OPENROUTER_API_KEY: FAKE_KEY },
      });
      app = await openAppSession({ url: server.url, headless: false });
      const page = app.page;
      await page.waitForFunction(
        () => /views/.test(document.getElementById("quote")?.textContent ?? ""),
        null,
        { timeout: 120_000 },
      );
      const quote = await page.textContent("#quote");
      expect(quote).toMatch(/\d+ views/);
      expect(quote).toContain("$");
      const levelNote = await page.textContent("#level-note");
      expect(levelNote).toContain("courtyard");
      // The quote came from the planner alone: no run directory was written.
      const runs = await fetch(`${server.url}/api/state`).then((response) => response.json() as Promise<{ runs: unknown[] }>);
      expect(runs.runs).toEqual([]);
    },
    240_000,
  );
});
