import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { chromium, type BrowserContext, type Page } from "playwright";

const FAB_ORIGIN = "https://www.fab.com";
const SEARCH_PATH =
  "/i/listings/search?q=forest&is_free=1&sort_by=-relevance&count=2&currency=USD";
const USER_AGENT = "threenative-asset-mcp-fab-contract-probe/0.4.0";
const TIMEOUT_MS = 30_000;
const MINIMUM_REQUEST_INTERVAL_MS = 750;
const HEADLESS = process.env.FAB_PROBE_HEADED !== "1";

type Classification =
  | "FAB_JSON"
  | "FAB_CHALLENGE"
  | "FAB_ACCESS_DENIED"
  | "FAB_UNEXPECTED_CONTENT"
  | "FAB_UPSTREAM_UNAVAILABLE";

type SafeResult = {
  ok: boolean;
  classification: Classification;
  status?: number;
  contentType?: string;
  resultCount?: number;
  responseKeys?: string[];
  nextCursorPresent?: boolean;
  cursorProbe?: {
    ok: boolean;
    resultCount?: number;
    reusedPageOneIdsExclusively?: boolean;
    classification: Classification;
  };
  detailProbe?: {
    ok: boolean;
    listingIdPresent?: boolean;
    licensesPresent?: boolean;
    formatsPresent?: boolean;
    classification: Classification;
  };
  message: string;
};

function classifyResponse(
  status: number,
  contentType: string,
  challenge: boolean,
): Classification {
  if (challenge) return "FAB_CHALLENGE";
  if (status === 401 || status === 403) return "FAB_ACCESS_DENIED";
  if (status < 200 || status >= 300) return "FAB_UPSTREAM_UNAVAILABLE";
  if (!contentType.toLowerCase().includes("application/json")) {
    return "FAB_UNEXPECTED_CONTENT";
  }
  return "FAB_JSON";
}

async function pace(): Promise<void> {
  await new Promise((resolve) =>
    setTimeout(resolve, MINIMUM_REQUEST_INTERVAL_MS),
  );
}

async function directJson(
  relativePath: string,
): Promise<{
  result: SafeResult;
  payload?: unknown;
}> {
  const response = await fetch(new URL(relativePath, FAB_ORIGIN), {
    headers: {
      accept: "application/json",
      "user-agent": USER_AGENT,
    },
    redirect: "manual",
    signal: AbortSignal.timeout(20_000),
  });
  const contentType = response.headers.get("content-type") ?? "";
  const challenge =
    response.headers.get("cf-mitigated")?.toLowerCase() === "challenge";
  const classification = classifyResponse(
    response.status,
    contentType,
    challenge,
  );

  if (classification !== "FAB_JSON") {
    await response.body?.cancel();
    return {
      result: {
        ok: classification === "FAB_CHALLENGE",
        classification,
        status: response.status,
        contentType,
        message:
          classification === "FAB_CHALLENGE"
            ? "Direct anonymous request was safely classified as a Cloudflare challenge."
            : "Direct anonymous request did not return an accepted JSON contract.",
      },
    };
  }

  const payload: unknown = await response.json();
  const record = asRecord(payload);
  const results = Array.isArray(record?.results) ? record.results : [];
  const cursors = asRecord(record?.cursors);
  return {
    result: {
      ok: true,
      classification,
      status: response.status,
      contentType,
      resultCount: results.length,
      responseKeys: Object.keys(record ?? {}).sort(),
      nextCursorPresent:
        typeof cursors?.next === "string" && cursors.next.length > 0,
      message: "Direct anonymous request returned JSON.",
    },
    payload,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function listingId(value: unknown): string | undefined {
  const item = asRecord(value);
  for (const key of ["uid", "id", "uuid"]) {
    if (typeof item?.[key] === "string" && item[key].length > 0) {
      return item[key];
    }
  }
  return undefined;
}

function listingFormats(value: Record<string, unknown> | undefined): unknown[] {
  for (const key of ["assetFormats", "asset_formats", "formats"]) {
    if (Array.isArray(value?.[key])) return value[key];
  }
  return [];
}

async function probeDirect(): Promise<SafeResult> {
  const first = await directJson(SEARCH_PATH);
  if (!first.payload) return first.result;

  const firstRecord = asRecord(first.payload);
  const firstResults = Array.isArray(firstRecord?.results)
    ? firstRecord.results
    : [];
  const firstIds = new Set(firstResults.map(listingId).filter(Boolean));
  const next = asRecord(firstRecord?.cursors)?.next;
  let cursorProbe: SafeResult["cursorProbe"];
  if (typeof next === "string" && next.length > 0) {
    await pace();
    const cursorUrl = new URL(SEARCH_PATH, FAB_ORIGIN);
    cursorUrl.searchParams.set("cursor", next);
    const second = await directJson(`${cursorUrl.pathname}${cursorUrl.search}`);
    const secondRecord = asRecord(second.payload);
    const secondResults = Array.isArray(secondRecord?.results)
      ? secondRecord.results
      : [];
    const secondIds = secondResults.map(listingId).filter(Boolean);
    const reusedPageOneIdsExclusively =
      secondIds.length > 0 && secondIds.every((id) => firstIds.has(id));
    cursorProbe = {
      ok: Boolean(second.payload) && !reusedPageOneIdsExclusively,
      classification: second.result.classification,
      ...(second.payload ? { resultCount: secondResults.length } : {}),
      ...(secondIds.length > 0 ? { reusedPageOneIdsExclusively } : {}),
    };
  }

  const id = listingId(firstResults[0]);
  let detailProbe: SafeResult["detailProbe"];
  if (id) {
    await pace();
    const detail = await directJson(
      `/i/listings/${encodeURIComponent(id)}?currency=USD`,
    );
    const detailRecord = asRecord(detail.payload);
    const licensesPresent =
      Array.isArray(detailRecord?.licenses) &&
      detailRecord.licenses.length > 0;
    const formatsPresent = listingFormats(detailRecord).length > 0;
    detailProbe = {
      ok: Boolean(detail.payload) && licensesPresent && formatsPresent,
      classification: detail.result.classification,
      listingIdPresent: listingId(detail.payload) === id,
      licensesPresent,
      formatsPresent,
    };
  }

  return {
    ...first.result,
    ok:
      firstResults.length > 0 &&
      (cursorProbe?.ok ?? true) &&
      (detailProbe?.ok ?? false),
    ...(cursorProbe ? { cursorProbe } : {}),
    ...(detailProbe ? { detailProbe } : {}),
  };
}

async function sameOriginJson(
  page: Page,
  relativeUrl: string,
): Promise<{
  status: number;
  contentType: string;
  challenge: boolean;
  payload?: unknown;
}> {
  return page.evaluate(
    async ({ relativeUrl: url, timeoutMs }) => {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          credentials: "same-origin",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        const contentType = response.headers.get("content-type") ?? "";
        const challenge =
          response.headers.get("cf-mitigated")?.toLowerCase() === "challenge";
        if (!contentType.toLowerCase().includes("application/json")) {
          return {
            status: response.status,
            contentType,
            challenge,
          };
        }
        return {
          status: response.status,
          contentType,
          challenge,
          payload: (await response.json()) as unknown,
        };
      } finally {
        window.clearTimeout(timeout);
      }
    },
    { relativeUrl, timeoutMs: TIMEOUT_MS },
  );
}

async function initializeAnonymousPage(
  context: BrowserContext,
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(FAB_ORIGIN, {
    waitUntil: "domcontentloaded",
    timeout: TIMEOUT_MS,
  });
  return page;
}

async function probeBrowser(): Promise<SafeResult> {
  const profilePath = await mkdtemp(
    path.join(tmpdir(), "threenative-asset-mcp-fab-anonymous-probe-"),
  );
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(profilePath, {
      headless: HEADLESS,
      locale: "en-US",
      serviceWorkers: "block",
      // Chromium's temp files stay inside the profile directory removed below.
      env: { ...process.env, TMPDIR: profilePath, TMP: profilePath, TEMP: profilePath } as Record<string, string>,
    });
    const page = await initializeAnonymousPage(context);
    const response = await sameOriginJson(page, SEARCH_PATH);
    const classification = classifyResponse(
      response.status,
      response.contentType,
      response.challenge,
    );
    if (classification !== "FAB_JSON") {
      return {
        ok: false,
        classification,
        status: response.status,
        contentType: response.contentType,
        message:
          classification === "FAB_CHALLENGE"
            ? "Dedicated anonymous browser encountered a challenge; no bypass was attempted."
            : "Dedicated anonymous browser did not return an accepted JSON contract.",
      };
    }

    const record = asRecord(response.payload);
    const results = Array.isArray(record?.results) ? record.results : [];
    const cursors = asRecord(record?.cursors);
    const firstIds = new Set(results.map(listingId).filter(Boolean));
    const next = cursors?.next;
    let cursorProbe: SafeResult["cursorProbe"];
    if (typeof next === "string" && next.length > 0) {
      await pace();
      const cursorUrl = new URL(SEARCH_PATH, FAB_ORIGIN);
      cursorUrl.searchParams.set("cursor", next);
      const second = await sameOriginJson(
        page,
        `${cursorUrl.pathname}${cursorUrl.search}`,
      );
      const secondClassification = classifyResponse(
        second.status,
        second.contentType,
        second.challenge,
      );
      const secondResults = Array.isArray(asRecord(second.payload)?.results)
        ? (asRecord(second.payload)?.results as unknown[])
        : [];
      const secondIds = secondResults.map(listingId).filter(Boolean);
      const reusedPageOneIdsExclusively =
        secondIds.length > 0 && secondIds.every((id) => firstIds.has(id));
      cursorProbe = {
        ok:
          secondClassification === "FAB_JSON" &&
          !reusedPageOneIdsExclusively,
        classification: secondClassification,
        resultCount: secondResults.length,
        ...(secondIds.length > 0 ? { reusedPageOneIdsExclusively } : {}),
      };
    }

    const id = listingId(results[0]);
    let detailProbe: SafeResult["detailProbe"];
    if (id) {
      await pace();
      const detail = await sameOriginJson(
        page,
        `/i/listings/${encodeURIComponent(id)}?currency=USD`,
      );
      const detailClassification = classifyResponse(
        detail.status,
        detail.contentType,
        detail.challenge,
      );
      const detailRecord = asRecord(detail.payload);
      const licensesPresent =
        Array.isArray(detailRecord?.licenses) &&
        detailRecord.licenses.length > 0;
      const formatsPresent = listingFormats(detailRecord).length > 0;
      detailProbe = {
        ok:
          detailClassification === "FAB_JSON" &&
          licensesPresent &&
          formatsPresent,
        classification: detailClassification,
        listingIdPresent: listingId(detail.payload) === id,
        licensesPresent,
        formatsPresent,
      };
    }

    return {
      ok:
        results.length > 0 &&
        (cursorProbe?.ok ?? true) &&
        (detailProbe?.ok ?? false),
      classification,
      status: response.status,
      contentType: response.contentType,
      resultCount: results.length,
      responseKeys: Object.keys(record ?? {}).sort(),
      nextCursorPresent:
        typeof cursors?.next === "string" && cursors.next.length > 0,
      ...(cursorProbe ? { cursorProbe } : {}),
      ...(detailProbe ? { detailProbe } : {}),
      message:
        results.length > 0
          ? "Dedicated anonymous browser returned public search results."
          : "Dedicated anonymous browser returned JSON without search results.",
    };
  } finally {
    await context?.close();
    await rm(profilePath, { force: true, recursive: true });
  }
}

async function main(): Promise<void> {
  const capturedAt = new Date().toISOString();
  const direct = await probeDirect().catch((error: unknown): SafeResult => ({
    ok: false,
    classification: "FAB_UPSTREAM_UNAVAILABLE",
    message:
      error instanceof Error
        ? `Direct probe failed: ${error.name}`
        : "Direct probe failed.",
  }));
  const browser = await probeBrowser().catch((error: unknown): SafeResult => ({
    ok: false,
    classification: "FAB_UPSTREAM_UNAVAILABLE",
    message:
      error instanceof Error
        ? `Browser probe failed: ${error.name}`
        : "Browser probe failed.",
  }));

  const report = {
    capturedAt,
    publicUrl: new URL(SEARCH_PATH, FAB_ORIGIN).toString(),
    privacy: {
      dedicatedTemporaryProfile: true,
      credentialsMode: "same-origin-dedicated-profile-only",
      importedUserProfile: false,
      inspectedCookiesOrTokens: false,
    },
    direct,
    browser,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  if (!direct.ok || !browser.ok) {
    process.exitCode = 1;
  }
}

await main();
