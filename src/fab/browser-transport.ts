import { join, resolve } from "node:path";

import { chromium } from "playwright";

import { createBrowserTempDir } from "../browser-temp.js";
import type { FabConfig } from "../config.js";
import {
  assertAllowedFabApiUrl,
  FabClientError,
  type FabDownloadFormat,
  type FabDownloadRequest,
  type FabDownloadResult,
  type FabTransport,
} from "./direct-transport.js";
import { storeDownload } from "./download-store.js";

const FAB_ORIGIN = "https://www.fab.com";

interface BrowserFetchResult {
  status: number;
  ok: boolean;
  contentType: string;
  cfMitigated: string | null;
  responseOrigin: string | null;
  payload?: unknown;
  invalidJson?: boolean;
  timedOut?: boolean;
}

export interface BrowserLocator {
  count(): Promise<number>;
  click(options?: { timeout?: number }): Promise<unknown>;
  waitFor(options: {
    state: "visible";
    timeout: number;
  }): Promise<unknown>;
}

export interface BrowserDownload {
  suggestedFilename(): string;
  saveAs(path: string): Promise<void>;
  failure(): Promise<string | null>;
}

export interface BrowserPage {
  url(): string;
  goto(
    url: string,
    options: { waitUntil: "domcontentloaded"; timeout: number },
  ): Promise<unknown>;
  // Playwright serializes this callback across the browser boundary. The
  // transport validates every returned shape before using it.
  evaluate(
    callback: (argument: any) => Promise<any> | any,
    argument: any,
  ): Promise<any>;
  getByRole?(
    role: string,
    options: { name: string; exact: boolean },
  ): BrowserLocator;
  waitForEvent?(
    event: "download",
    options: { timeout: number },
  ): Promise<BrowserDownload>;
}

export interface BrowserContextHandle {
  pages(): BrowserPage[];
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
}

export interface BrowserFabTransportOptions {
  timeoutMs: number;
  manualChallengeTimeoutMs?: number;
  headless: boolean;
  profileDir: string;
  downloadDir?: string;
  maxDownloadBytes?: number;
  launchContext?: () => Promise<BrowserContextHandle>;
  sleep?: (milliseconds: number) => Promise<void>;
}

function playwrightContext(
  config: Pick<
    FabConfig,
    | "browserTimeoutMs"
    | "browserHeadless"
    | "browserProfileDir"
  >,
): () => Promise<BrowserContextHandle> {
  return async () => {
    const temp = await createBrowserTempDir();
    let context: BrowserContextHandle;
    try {
      context = (await chromium.launchPersistentContext(config.browserProfileDir, {
        headless: config.browserHeadless,
        acceptDownloads: true,
        serviceWorkers: "block",
        // Keep MCP calls within common client deadlines even when a headed
        // browser cannot start in the host environment.
        timeout: Math.min(config.browserTimeoutMs, 10_000),
        viewport: { width: 1280, height: 900 },
        env: { ...process.env, ...temp.env } as Record<string, string>,
      })) as unknown as BrowserContextHandle;
    } catch (error) {
      await temp.remove();
      throw error;
    }
    return {
      pages: () => context.pages(),
      newPage: () => context.newPage(),
      close: async () => {
        try {
          await context.close();
        } finally {
          await temp.remove();
        }
      },
    };
  };
}

export class BrowserFabTransport implements FabTransport {
  readonly name = "browser" as const;
  private readonly timeoutMs: number;
  private readonly manualChallengeTimeoutMs: number;
  private readonly headless: boolean;
  private readonly downloadDir: string;
  private readonly maxDownloadBytes: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly launchContext: () => Promise<BrowserContextHandle>;
  private contextPromise: Promise<BrowserContextHandle> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: BrowserFabTransportOptions) {
    this.timeoutMs = options.timeoutMs;
    this.manualChallengeTimeoutMs =
      options.manualChallengeTimeoutMs ?? 10_000;
    this.headless = options.headless;
    this.downloadDir = resolve(
      options.downloadDir ?? join(options.profileDir, "downloads"),
    );
    this.maxDownloadBytes = options.maxDownloadBytes ?? 2_147_483_648;
    this.sleep =
      options.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.launchContext =
      options.launchContext ??
      playwrightContext({
        browserTimeoutMs: options.timeoutMs,
        browserHeadless: options.headless,
        browserProfileDir: options.profileDir,
      });
  }

  static fromConfig(config: FabConfig): BrowserFabTransport {
    return new BrowserFabTransport({
      timeoutMs: config.browserTimeoutMs,
      manualChallengeTimeoutMs: config.browserManualTimeoutMs,
      headless: config.browserHeadless,
      profileDir: config.browserProfileDir,
      downloadDir: config.downloadDir,
      maxDownloadBytes: config.maxDownloadBytes,
    });
  }

  async search(url: URL): Promise<unknown> {
    return this.request(url);
  }

  async getListing(id: string, currency: string): Promise<unknown> {
    const url = new URL(`/i/listings/${encodeURIComponent(id)}`, FAB_ORIGIN);
    url.searchParams.set("currency", currency);
    return this.request(url);
  }

  async prepare(): Promise<void> {
    if (this.headless) return;
    await this.serialized(async () => {
      await this.page(false);
    });
  }

  async downloadFreeAsset(
    request: FabDownloadRequest,
  ): Promise<FabDownloadResult> {
    return this.serialized(async () => {
      const page = await this.page(false);
      const listingUrl = `${FAB_ORIGIN}/listings/${request.listingId}`;
      try {
        await page.goto(listingUrl, {
          waitUntil: "domcontentloaded",
          timeout: this.timeoutMs,
        });
      } catch {
        throw new FabClientError(
          "FAB_UPSTREAM_UNAVAILABLE",
          "The dedicated Fab browser could not load the listing download page.",
          true,
        );
      }
      this.assertListingPage(page, request.listingId);
      await this.ensureListingIsUsable(page);
      if (!page.getByRole || !page.waitForEvent) {
        throw new FabClientError(
          "FAB_INTERNAL",
          "The configured Fab browser cannot perform file downloads.",
        );
      }

      const openDownload = page.getByRole("button", {
        name: "Download",
        exact: true,
      });
      if ((await openDownload.count()) !== 1) {
        const buyNow = page.getByRole("button", {
          name: "Buy now",
          exact: true,
        });
        if ((await buyNow.count()) > 0) {
          throw new FabClientError(
            "FAB_ACQUISITION_REQUIRED",
            "This listing requires an acquisition or checkout flow before downloading. The MCP did not start it.",
          );
        }
        const addToLibrary = page.getByRole("button", {
          name: "Add to My Library",
          exact: true,
        });
        if ((await addToLibrary.count()) > 0) {
          throw new FabClientError(
            "FAB_LIBRARY_REQUIRED",
            "This format must be added to an authenticated Fab library and may require Epic Games Launcher or an editor integration.",
          );
        }
        throw new FabClientError(
          "FAB_FORMAT_UNAVAILABLE",
          "Fab does not expose a direct public download for this listing.",
        );
      }
      await openDownload.click({ timeout: this.timeoutMs });

      const formatButton = page.getByRole("button", {
        name: `Download ${downloadFormatLabel(request.format)} asset`,
        exact: true,
      });
      try {
        await formatButton.waitFor({
          state: "visible",
          timeout: this.timeoutMs,
        });
      } catch {
        const dialogState = await this.downloadDialogState(page);
        if (dialogState.eulaVisible) {
          throw new FabClientError(
            "FAB_EULA_REQUIRED",
            "Fab requires visible EULA acknowledgement in the dedicated browser before this file can be downloaded.",
          );
        }
        throw new FabClientError(
          "FAB_FORMAT_UNAVAILABLE",
          `Fab does not expose the requested ${request.format.toUpperCase()} file for this listing.`,
        );
      }
      if ((await formatButton.count()) !== 1) {
        throw new FabClientError(
          "FAB_UPSTREAM_CHANGED",
          "Fab exposed an ambiguous download control.",
        );
      }

      let download: BrowserDownload;
      try {
        const pending = page.waitForEvent("download", {
          timeout: this.timeoutMs,
        });
        await formatButton.click({ timeout: this.timeoutMs });
        download = await pending;
      } catch {
        throw new FabClientError(
          "FAB_DOWNLOAD_FAILED",
          "Fab did not start the requested file download.",
          true,
        );
      }
      const failure = await download.failure().catch(() => null);
      if (failure) {
        throw new FabClientError(
          "FAB_DOWNLOAD_FAILED",
          "Fab could not complete the requested file download.",
          true,
        );
      }
      return this.persistDownload(download, request);
    });
  }

  async getLimitedTimeFreeIds(limit: number): Promise<string[]> {
    return this.serialized(async () => {
      const page = await this.context().then(
        (context) => context.pages()[0] ?? context.newPage(),
      );
      try {
        await page.goto(`${FAB_ORIGIN}/limited-time-free`, {
          waitUntil: "domcontentloaded",
          timeout: this.timeoutMs,
        });
      } catch {
        throw new FabClientError(
          "FAB_UPSTREAM_UNAVAILABLE",
          "The dedicated Fab browser could not load limited-time-free promotions.",
          true,
        );
      }
      try {
        const finalUrl = new URL(page.url());
        if (
          finalUrl.origin !== FAB_ORIGIN ||
          finalUrl.pathname !== "/limited-time-free"
        ) {
          throw new Error("unexpected promotion origin");
        }
      } catch {
        throw new FabClientError(
          "FAB_ACCESS_DENIED",
          "Fab redirected the promotions page outside the approved public route.",
        );
      }

      let ids: string[];
      try {
        ids = await page.evaluate(
          ({ expectedOrigin, maximum }) => {
            const pattern =
              /^\/listings\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:\/)?$/i;
            const values: string[] = [];
            for (const anchor of Array.from(
              document.querySelectorAll<HTMLAnchorElement>(
                'a[href*="/listings/"]',
              ),
            )) {
              let url: URL;
              try {
                url = new URL(anchor.href, expectedOrigin);
              } catch {
                continue;
              }
              if (url.origin !== expectedOrigin) continue;
              const match = pattern.exec(url.pathname);
              if (!match?.[1] || values.includes(match[1].toLowerCase())) {
                continue;
              }
              values.push(match[1].toLowerCase());
              if (values.length >= maximum) break;
            }
            return values;
          },
          { expectedOrigin: FAB_ORIGIN, maximum: limit },
        );
      } catch {
        throw new FabClientError(
          "FAB_UPSTREAM_UNAVAILABLE",
          "The dedicated Fab browser could not read curated promotion IDs.",
          true,
        );
      }
      if (ids.length === 0) {
        throw new FabClientError(
          "FAB_BROWSER_ATTENTION_REQUIRED",
          "Fab did not expose curated promotion IDs in the dedicated browser. Start the MCP once with FAB_BROWSER_HEADLESS=0 to check for manual verification.",
        );
      }
      return ids;
    });
  }

  request(url: URL): Promise<unknown> {
    assertAllowedFabApiUrl(url);
    return this.serialized(() => this.requestInBrowser(url));
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async context(): Promise<BrowserContextHandle> {
    if (this.closed) {
      throw new FabClientError(
        "FAB_INTERNAL",
        "The Fab browser transport is closed.",
      );
    }
    this.contextPromise ??= this.launchContext().catch(() => {
      this.contextPromise = undefined;
      throw new FabClientError(
        "FAB_UPSTREAM_UNAVAILABLE",
        "The dedicated Fab browser could not be started.",
        true,
      );
    });
    return this.contextPromise;
  }

  private async page(waitForVerification = true): Promise<BrowserPage> {
    const context = await this.context();
    const page = context.pages()[0] ?? (await context.newPage());
    let atFabOrigin = false;
    try {
      atFabOrigin = new URL(page.url()).origin === FAB_ORIGIN;
    } catch {
      // about:blank and malformed page URLs are navigated to Fab below.
    }
    if (!atFabOrigin) {
      try {
        await page.goto(`${FAB_ORIGIN}/`, {
          waitUntil: "domcontentloaded",
          timeout: this.timeoutMs,
        });
      } catch {
        throw new FabClientError(
          "FAB_UPSTREAM_UNAVAILABLE",
          "The dedicated Fab browser could not load Fab.",
          true,
        );
      }
    }
    try {
      if (new URL(page.url()).origin !== FAB_ORIGIN) {
        throw new Error("unexpected browser origin");
      }
    } catch {
      throw new FabClientError(
        "FAB_ACCESS_DENIED",
        "The dedicated browser did not remain on Fab.",
      );
    }
    if (!this.headless && waitForVerification) {
      await this.waitForManualVerification(page);
    }
    return page;
  }

  private async waitForManualVerification(page: BrowserPage): Promise<void> {
    const deadline = Date.now() + this.manualChallengeTimeoutMs;
    while (true) {
      let state: { origin: string; challengeVisible: boolean };
      try {
        state = await page.evaluate(
          ({ expectedOrigin }) => ({
            origin: globalThis.location.origin,
            challengeVisible:
              globalThis.location.origin === expectedOrigin &&
              (document.title.toLowerCase().includes("just a moment") ||
                document.querySelector(
                  "#challenge-running, #challenge-stage, .cf-challenge",
                ) !== null),
          }),
          { expectedOrigin: FAB_ORIGIN },
        );
      } catch {
        throw new FabClientError(
          "FAB_UPSTREAM_UNAVAILABLE",
          "The dedicated Fab browser could not inspect the verification page.",
          true,
        );
      }
      if (state.origin !== FAB_ORIGIN) {
        throw new FabClientError(
          "FAB_ACCESS_DENIED",
          "The dedicated browser left Fab during manual verification.",
        );
      }
      if (!state.challengeVisible) return;
      if (Date.now() >= deadline) {
        throw new FabClientError(
          "FAB_BROWSER_ATTENTION_REQUIRED",
          "Fab still requires manual verification in the dedicated MCP browser profile.",
        );
      }
      await this.sleep(1_000);
    }
  }

  private assertListingPage(page: BrowserPage, listingId: string): void {
    try {
      const finalUrl = new URL(page.url());
      if (
        finalUrl.origin !== FAB_ORIGIN ||
        finalUrl.pathname !== `/listings/${listingId}`
      ) {
        throw new Error("unexpected listing route");
      }
    } catch {
      throw new FabClientError(
        "FAB_ACCESS_DENIED",
        "Fab redirected the dedicated browser outside the requested listing.",
      );
    }
  }

  private async ensureListingIsUsable(page: BrowserPage): Promise<void> {
    let state: { origin: string; challengeVisible: boolean };
    try {
      state = await page.evaluate(
        ({ expectedOrigin }) => ({
          origin: globalThis.location.origin,
          challengeVisible:
            globalThis.location.origin === expectedOrigin &&
            (document.title.toLowerCase().includes("just a moment") ||
              document.querySelector(
                "#challenge-running, #challenge-stage, .cf-challenge",
              ) !== null),
        }),
        { expectedOrigin: FAB_ORIGIN },
      );
    } catch {
      throw new FabClientError(
        "FAB_UPSTREAM_UNAVAILABLE",
        "The dedicated browser could not inspect the Fab listing.",
        true,
      );
    }
    if (state.origin !== FAB_ORIGIN) {
      throw new FabClientError(
        "FAB_ACCESS_DENIED",
        "The dedicated browser left Fab while opening the listing.",
      );
    }
    if (state.challengeVisible) {
      if (!this.headless) await this.waitForManualVerification(page);
      else {
        throw new FabClientError(
          "FAB_BROWSER_ATTENTION_REQUIRED",
          "Fab requires manual verification in the dedicated MCP browser profile. Start the MCP once with FAB_BROWSER_HEADLESS=0 to complete it.",
        );
      }
    }
  }

  private async downloadDialogState(
    page: BrowserPage,
  ): Promise<{ eulaVisible: boolean }> {
    try {
      return await page.evaluate(
        () => {
          const dialog = document.querySelector('[role="dialog"]');
          const text = dialog?.textContent?.toLowerCase().slice(0, 4_000) ?? "";
          return {
            eulaVisible:
              text.includes("eula") ||
              text.includes("end user license agreement") ||
              text.includes("read and agree"),
          };
        },
        undefined,
      );
    } catch {
      return { eulaVisible: false };
    }
  }

  private async persistDownload(
    download: BrowserDownload,
    request: FabDownloadRequest,
  ): Promise<FabDownloadResult> {
    return storeDownload({
      downloadDir: this.downloadDir,
      listingId: request.listingId,
      format: request.format,
      fileName: download.suggestedFilename(),
      maxBytes: this.maxDownloadBytes,
      materialize: (temporaryPath) => download.saveAs(temporaryPath),
    });
  }

  private async requestInBrowser(url: URL): Promise<unknown> {
    const page = await this.page();
    let result: BrowserFetchResult;
    try {
      result = await page.evaluate(
        async ({ requestUrl, expectedOrigin, timeoutMs }) => {
          if (globalThis.location.origin !== expectedOrigin) {
            return {
              status: 0,
              ok: false,
              contentType: "",
              cfMitigated: null,
              responseOrigin: globalThis.location.origin,
            };
          }
          const controller = new AbortController();
          const timeout = globalThis.setTimeout(
            () => controller.abort(),
            timeoutMs,
          );
          try {
            let response: Response;
            try {
              response = await fetch(requestUrl, {
                headers: { accept: "application/json" },
                credentials: "same-origin",
                redirect: "error",
                signal: controller.signal,
              });
            } catch (error) {
              if (error instanceof DOMException && error.name === "AbortError") {
                return {
                  status: 0,
                  ok: false,
                  contentType: "",
                  cfMitigated: null,
                  responseOrigin: null,
                  timedOut: true,
                };
              }
              throw error;
            }
            const contentType = response.headers.get("content-type") ?? "";
            const cfMitigated = response.headers.get("cf-mitigated");
            let responseOrigin: string | null = null;
            try {
              responseOrigin = new URL(response.url).origin;
            } catch {
              // The caller classifies a missing response origin safely.
            }
            if (!contentType.toLowerCase().includes("application/json")) {
              return {
                status: response.status,
                ok: response.ok,
                contentType,
                cfMitigated,
                responseOrigin,
              };
            }
            try {
              return {
                status: response.status,
                ok: response.ok,
                contentType,
                cfMitigated,
                responseOrigin,
                payload: await response.json(),
              };
            } catch {
              return {
                status: response.status,
                ok: response.ok,
                contentType,
                cfMitigated,
                responseOrigin,
                invalidJson: true,
              };
            }
          } finally {
            globalThis.clearTimeout(timeout);
          }
        },
        {
          requestUrl: url.toString(),
          expectedOrigin: FAB_ORIGIN,
          timeoutMs: this.timeoutMs,
        },
      );
    } catch {
      throw new FabClientError(
        "FAB_UPSTREAM_UNAVAILABLE",
        "The dedicated Fab browser could not complete the request.",
        true,
      );
    }

    if (result.timedOut) {
      throw new FabClientError(
        "FAB_TIMEOUT",
        "Fab did not respond before the browser request timeout.",
        true,
      );
    }
    const isHtml = result.contentType.toLowerCase().includes("text/html");
    if (
      result.cfMitigated?.toLowerCase() === "challenge" ||
      isHtml ||
      (result.status === 403 && !result.payload)
    ) {
      throw new FabClientError(
        "FAB_BROWSER_ATTENTION_REQUIRED",
        "Fab requires manual verification in the dedicated MCP browser profile. Start the MCP once with FAB_BROWSER_HEADLESS=0 to complete it.",
      );
    }
    if (result.responseOrigin !== FAB_ORIGIN) {
      throw new FabClientError(
        "FAB_ACCESS_DENIED",
        "Fab redirected the anonymous browser request outside Fab.",
      );
    }
    if (result.status === 404) {
      throw new FabClientError("FAB_NOT_FOUND", "The Fab resource was not found.");
    }
    if (result.status === 429) {
      throw new FabClientError(
        "FAB_RATE_LIMITED",
        "Fab rate-limited the request.",
        true,
      );
    }
    if (result.status === 401 || result.status === 403) {
      throw new FabClientError(
        "FAB_ACCESS_DENIED",
        "Fab denied this anonymous public request.",
      );
    }
    if (!result.ok) {
      throw new FabClientError(
        "FAB_UPSTREAM_UNAVAILABLE",
        "Fab returned an unavailable response.",
        result.status >= 500,
      );
    }
    if (!result.contentType.toLowerCase().includes("application/json")) {
      throw new FabClientError(
        "FAB_UPSTREAM_CHANGED",
        "Fab returned an unexpected response format.",
      );
    }
    if (result.invalidJson || result.payload === undefined) {
      throw new FabClientError(
        "FAB_UPSTREAM_CHANGED",
        "Fab returned invalid JSON.",
      );
    }
    return result.payload;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue;
    const context = await this.contextPromise?.catch(() => undefined);
    this.contextPromise = undefined;
    await context?.close().catch(() => undefined);
  }
}

const DOWNLOAD_FORMAT_LABELS: Record<FabDownloadFormat, string> = {
  blender: "Blender",
  fbx: "FBX",
  glb: "GLB",
  gltf: "GLTF",
  maya: "Maya",
  obj: "OBJ",
  unity: "Unity",
};

function downloadFormatLabel(format: FabDownloadFormat): string {
  return DOWNLOAD_FORMAT_LABELS[format];
}
