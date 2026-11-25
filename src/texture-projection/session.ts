import { chromium, type Browser, type Page } from "playwright";

import { createBrowserTempDir } from "../browser-temp.js";

/** A `TROMPE {json}` line printed by the app's api, as it reaches the node side. */
export interface AppEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface AppSessionOptions {
  /** Base URL of the UI server serving the bundled app. */
  readonly url: string;
  /** Open the page without its panel (the headless runner's view); the UI tests ask for the panel. */
  readonly headless?: boolean;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly onEvent?: (event: AppEvent) => void;
  readonly onLog?: (line: string) => void;
}

export interface AppSession {
  readonly page: Page;
  /** Calls `window.textureProjection[operation](...args)` and returns its result. */
  call<T>(operation: string, ...args: unknown[]): Promise<T>;
  close(): Promise<void>;
}

/**
 * Headless Chromium with SwiftShader, because the projection pipeline needs a real WebGL2 context
 * and CI has no GPU. Temp files go to a private directory that is removed on close, so no Chromium
 * shm file is left behind.
 */
export async function openAppSession(options: AppSessionOptions): Promise<AppSession> {
  const timeout = options.timeoutMs ?? 120_000;
  const temp = await createBrowserTempDir();
  const pageErrors: string[] = [];
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({
      headless: true,
      env: { ...process.env, ...temp.env, ...options.env },
      args: [
        "--no-sandbox",
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        "--ignore-gpu-blocklist",
        "--mute-audio",
      ],
    });
    const page: Page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on("console", (message) => {
      const text = message.text();
      if (text.startsWith("TROMPE ")) {
        try {
          options.onEvent?.(JSON.parse(text.slice("TROMPE ".length)) as AppEvent);
        } catch {
          options.onLog?.(`unreadable event line: ${text.slice(0, 200)}`);
        }
      } else if (message.type() === "error") {
        options.onLog?.(text);
      }
    });
    page.on("pageerror", (error) => {
      pageErrors.push(error.message);
      options.onLog?.(`page error: ${error.message}`);
    });
    await page.goto(options.headless === false ? `${options.url}/` : `${options.url}/?headless`, { timeout });
    await page.waitForFunction(() => "textureProjection" in window, null, { timeout });
    const failing = pageErrors[0];
    if (failing) throw new Error(`the texture-projection app failed to start: ${failing}`);

    return {
      page,
      async call<T>(operation: string, ...args: unknown[]): Promise<T> {
        try {
          return (await page.evaluate(
            ({ operation: name, args: callArgs }) => {
              const api = (window as unknown as { textureProjection: Record<string, (...a: unknown[]) => unknown> })
                .textureProjection;
              const fn = api[name];
              if (typeof fn !== "function") throw new Error(`the app has no ${name}`);
              return fn.apply(api, callArgs);
            },
            { operation, args },
          )) as T;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const pageError = pageErrors.length ? ` (page error: ${pageErrors[pageErrors.length - 1]})` : "";
          throw new Error(`${operation} failed: ${message}${pageError}`);
        }
      },
      async close() {
        await browser?.close().catch(() => undefined);
        await temp.remove();
      },
    };
  } catch (error) {
    await browser?.close().catch(() => undefined);
    await temp.remove();
    throw error;
  }
}
