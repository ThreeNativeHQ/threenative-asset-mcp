import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { buildTextureProjectionApp } from "../scripts/build-texture-projection-app.js";
import { openAppSession, type AppSession } from "../src/texture-projection/session.js";
import { TOKEN_HEADER, startUiServer, type UiServer } from "../src/texture-projection/ui-server.js";
import { startOpenRouterStub, type OpenRouterStub } from "./helpers/openrouter-stub.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEVEL = join(REPO, "tests", "fixtures", "texture-projection", "courtyard.glb");
const APP_DIR = join(REPO, "dist", "texture-projection", "app");
const FAKE_KEY = "sk-or-v1-ui-test-key-that-must-never-reach-the-page";

const temporaryDirectories: string[] = [];
let server: UiServer | undefined;
let app: AppSession | undefined;

/** Status only, with headers node's fetch refuses to forge (such as Host). */
function rawStatus(url: string, method: string, headers: Record<string, string>, body = ""): Promise<number> {
  return new Promise((resolveStatus, reject) => {
    const target = new URL(url);
    const request = httpRequest(
      { host: "127.0.0.1", port: Number(target.port), path: `${target.pathname}${target.search}`, method, headers },
      (response) => {
        response.resume();
        resolveStatus(response.statusCode ?? 0);
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

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

describe("texture-projection UI server request guards", () => {
  it("rejects cross-site POSTs, wrong hosts and a missing token before the proxy runs", async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .png()
      .toBuffer();
    const stub: OpenRouterStub = await startOpenRouterStub(png.toString("base64"));
    const cwd = await scratchDir("ui-guards");
    server = await startUiServer({
      levelPath: LEVEL,
      runRoot: join(cwd, "runs"),
      env: { OPENROUTER_API_KEY: FAKE_KEY, OPENROUTER_BASE_URL: stub.url },
    });
    try {
      const html = await (await fetch(`${server.url}/`)).text();
      const token = /name="texture-projection-token" content="([^"]+)"/.exec(html)?.[1];
      expect(token).toBeTruthy();
      const payload = JSON.stringify({
        model: "black-forest-labs/flux-3-image-klein",
        prompt: "p",
        input_references: [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
      });
      const imagesUrl = `${server.url}/api/openrouter/images`;
      const port = new URL(server.url).port;

      // A CORS "simple request" from any open web page: text/plain needs no preflight.
      expect(
        await rawStatus(imagesUrl, "POST", { host: `127.0.0.1:${port}`, "content-type": "text/plain" }, payload),
      ).toBe(403);
      // DNS rebinding: the request names another host but arrives here.
      expect(
        await rawStatus(imagesUrl, "POST", { host: `evil.example:${port}`, "content-type": "application/json", [TOKEN_HEADER]: token! }, payload),
      ).toBe(403);
      expect((await fetch(imagesUrl, { method: "POST", headers: { "content-type": "application/json" }, body: payload })).status).toBe(403);
      expect(
        await fetch(imagesUrl, {
          method: "POST",
          headers: { "content-type": "application/json", [TOKEN_HEADER]: token!, origin: "http://evil.example" },
          body: payload,
        }).then((response) => response.status),
      ).toBe(403);
      // Writing into a run needs the token too.
      expect(
        await fetch(`${server.url}/api/runs/run-a/view_0_comp.png`, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: new Uint8Array([1, 2, 3]),
        }).then((response) => response.status),
      ).toBe(403);
      expect(existsSync(join(cwd, "runs", "run-a", "view_0_comp.png"))).toBe(false);
      expect(stub.requests).toHaveLength(0);

      const forwarded = await fetch(imagesUrl, {
        method: "POST",
        headers: { "content-type": "application/json", [TOKEN_HEADER]: token!, origin: server.url },
        body: payload,
      });
      expect(forwarded.status).toBe(200);
      expect(stub.requests).toHaveLength(1);
    } finally {
      await stub.close();
    }
  });

  // `npm run build` (also `pretest`) compiles dist; the installed package is exactly this layout.
  it(
    "serves the bundled app from the installed package layout when started from another directory",
    async () => {
      const cwd = await scratchDir("ui-other-cwd");
      const child = spawn(process.execPath, [join(REPO, "dist", "index.js"), "texture-project-ui"], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, OPENROUTER_API_KEY: "" },
      });
      try {
        const url = await new Promise<string>((resolveUrl, reject) => {
          let buffer = "";
          const timer = setTimeout(() => reject(new Error(`no URL printed: ${buffer}`)), 60_000);
          child.stdout.on("data", (chunk: Buffer) => {
            buffer += chunk.toString("utf8");
            const match = /http:\/\/127\.0\.0\.1:\d+/.exec(buffer);
            if (match) {
              clearTimeout(timer);
              resolveUrl(match[0]);
            }
          });
          child.once("exit", (code) => reject(new Error(`the CLI exited with ${code}: ${buffer}`)));
        });
        const page = await fetch(`${url}/`);
        expect(page.status).toBe(200);
        expect(await page.text()).toContain("Texture projection");
        expect((await fetch(`${url}/app.js`)).status).toBe(200);
      } finally {
        child.kill("SIGTERM");
        await new Promise<void>((done) => child.once("exit", () => done()));
      }
    },
    120_000,
  );
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
