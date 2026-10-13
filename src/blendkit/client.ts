import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

/**
 * HTTP client for the official Blendkit-Client (https://github.com/BlenderKit/bk_client), a
 * GPL-2.0-or-later Go service the user installs and runs. This module only speaks its documented
 * local HTTP API (client/docs/API.md, v1.13.6); it bundles and copies none of its code.
 *
 * Asynchronous work (search, download, tool runs) returns a task_id; the result arrives through
 * POST /report, which also hands each finished or failed task out exactly once.
 */

export type BlendkitErrorCode =
  | "BLENDKIT_INVALID_INPUT"
  | "BLENDKIT_UNSAFE_URL"
  | "BLENDKIT_CLIENT_UNAVAILABLE"
  | "BLENDKIT_INVALID_RESPONSE"
  | "BLENDKIT_TASK_FAILED"
  | "BLENDKIT_TIMEOUT"
  | "BLENDKIT_CANCELLED"
  | "BLENDKIT_PERMISSION_REQUIRED"
  | "BLENDKIT_NOT_FOUND"
  | "BLENDKIT_PAID_DENIED"
  | "BLENDKIT_AUTH_REQUIRED"
  | "BLENDKIT_LICENSE_DENIED"
  | "BLENDKIT_CONSENT_REQUIRED"
  | "BLENDKIT_UNSUPPORTED"
  | "BLENDKIT_CONVERSION_FAILED"
  | "BLENDKIT_OUTPUT_EXISTS"
  | "BLENDKIT_PUBLISH_FAILED"
  | "BLENDKIT_PARTIAL_OUTPUT"
  | "BLENDKIT_CLIENT_ERROR"
  | "BLENDKIT_STAGING_RETAINED";

export class BlendkitError extends Error {
  constructor(
    readonly code: BlendkitErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BlendkitError";
  }
}

export const DEFAULT_CLIENT_URL = "http://127.0.0.1:62485";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The Client is a local service: only plain-HTTP loopback origins are accepted. */
export function loopbackOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlendkitError("BLENDKIT_UNSAFE_URL", "The Blendkit-Client URL is not a valid URL.");
  }
  if (
    url.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  )
    throw new BlendkitError(
      "BLENDKIT_UNSAFE_URL",
      "The Blendkit-Client URL must be a loopback http origin such as http://127.0.0.1:62485.",
    );
  return url.origin;
}

/**
 * Task text comes from the Client and the provider: bounded, single-line, with any configured
 * credential (plain text, not only inside a URL) and every URL, signed or not, removed.
 */
export function safeTaskText(value: unknown, secrets: Iterable<string> = []): string {
  if (typeof value !== "string") return "";
  // URLs go first: a short secret such as ":" would otherwise split "https://" and leave a
  // signed link's token behind. Then one pass over the secrets, longest first.
  const withoutUrls = value.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/giu, "<url>");
  const known = [...secrets].filter(Boolean).sort((a, b) => b.length - a.length);
  const text = known.length
    ? withoutUrls.replace(
        new RegExp(
          known.map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|"),
          "gu",
        ),
        "<redacted>",
      )
    : withoutUrls;
  return text
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .trim()
    .slice(0, 300);
}

/**
 * True only for an OBSERVED terminal task state (the Client's /report said the task failed or was
 * cancelled). A transport error such as HTTP 500 or an unreachable Client proves nothing about
 * whether a Go download or a Blender export is still writing.
 */
export function taskEnded(error: unknown): boolean {
  return (
    error instanceof BlendkitError &&
    (error.code === "BLENDKIT_TASK_FAILED" || error.code === "BLENDKIT_CANCELLED")
  );
}

/** A task failed or was aborted and the Client did not confirm that it stopped writing. */
export class UnconfirmedStopError extends Error {
  constructor(readonly reason: unknown) {
    super(reason instanceof Error ? reason.message : "The Client task was interrupted.");
    this.name = "UnconfirmedStopError";
  }
}

export type BlendkitTask = {
  taskId: string;
  taskType: string;
  status: string;
  progress: number;
  message: string;
  result: unknown;
};
export type TaskProgress = { progress: number; message: string };

const TERMINAL = new Set(["finished", "error", "cancelled"]);

export type BlendkitClientOptions = {
  baseUrl?: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  pollIntervalMs?: number;
  /** How long to wait for the Client to report a cancelled download as over. */
  cancelConfirmMs?: number;
  appId?: number;
  addonVersion?: string;
};

export class BlendkitClient {
  readonly origin: string;
  private readonly fetcher: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly pollIntervalMs: number;
  private readonly cancelConfirmMs: number;
  readonly appId: number;
  private readonly addonVersion: string;
  /** Stable scene identity for this client session, forwarded by the Client as scene_uuid. */
  private readonly sceneId = randomUUID();
  /** Terminal tasks /report handed over before their waiter asked; each is delivered once. */
  private readonly done = new Map<string, BlendkitTask>();
  private readonly latest = new Map<string, TaskProgress>();
  /** Tasks someone is waiting for: their parked results are never evicted. */
  private readonly active = new Set<string>();
  /** Start requests in flight: their task id is unknown, so nothing may be evicted meanwhile. */
  private pendingStarts = 0;
  /** API keys seen in requests, redacted from any task text the Client echoes back. */
  private readonly secrets = new Set<string>();
  private polling: Promise<void> | undefined;

  constructor(options: BlendkitClientOptions = {}) {
    this.origin = loopbackOrigin(options.baseUrl ?? DEFAULT_CLIENT_URL);
    this.fetcher = options.fetch ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 8 * 1024 * 1024;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.cancelConfirmMs = options.cancelConfirmMs ?? 5000;
    this.appId = options.appId ?? process.pid;
    this.addonVersion = options.addonVersion ?? "0.0.0";
  }

  private identity() {
    return {
      app_id: this.appId,
      addon_version: this.addonVersion,
      platform_version: `${process.platform}-${process.arch}`,
    };
  }

  private async request(
    path: string,
    body: unknown,
    signal: AbortSignal,
    expectJson = true,
  ): Promise<unknown> {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeoutMs)]);
    let response: Response;
    try {
      response = await this.fetcher(new URL(path, this.origin), {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        signal: requestSignal,
        ...(body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
    } catch {
      signal.throwIfAborted();
      throw new BlendkitError(
        "BLENDKIT_CLIENT_UNAVAILABLE",
        `No Blendkit-Client answered at ${this.origin}. Start the official client (see blendkit_status).`,
      );
    }
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > this.maxResponseBytes) {
      await response.body?.cancel();
      throw new BlendkitError(
        "BLENDKIT_INVALID_RESPONSE",
        "Blendkit-Client response is too large.",
      );
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength;
      if (size > this.maxResponseBytes)
        throw new BlendkitError(
          "BLENDKIT_INVALID_RESPONSE",
          "Blendkit-Client response is too large.",
        );
      chunks.push(chunk);
    }
    if (!response.ok)
      throw new BlendkitError(
        response.status === 404 ? "BLENDKIT_UNSUPPORTED" : "BLENDKIT_CLIENT_ERROR",
        `Blendkit-Client ${path} answered HTTP ${response.status}.`,
      );
    if (!expectJson) return undefined;
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new BlendkitError(
        "BLENDKIT_INVALID_RESPONSE",
        `Blendkit-Client ${path} returned no JSON.`,
      );
    }
  }

  /** Local-only health: neither endpoint subscribes this process or contacts the provider. */
  async status(signal: AbortSignal): Promise<{ clientVersion: string; tools: string[] }> {
    const addons = (await this.request("/addons/list", undefined, signal)) as {
      clientVersion?: unknown;
    };
    const listed = (await this.request("/tools/list", undefined, signal)) as { tools?: unknown };
    const clientVersion = String(addons?.clientVersion ?? "");
    if (!/^\d+\.\d+\.\d+$/u.test(clientVersion) || !Array.isArray(listed?.tools))
      throw new BlendkitError(
        "BLENDKIT_INVALID_RESPONSE",
        "Unexpected Blendkit-Client status shape.",
      );
    const tools = listed.tools
      .map((tool) => (tool as { id?: unknown })?.id)
      .filter((id): id is string => typeof id === "string" && /^[a-z0-9_]{1,64}$/u.test(id));
    return { clientVersion, tools };
  }

  /**
   * A start request for work that writes files (download, recipe) can fail after the Client
   * accepted it: the connection may drop or the answer may be malformed, and then there is no task
   * id to cancel or watch. That is not proof that nothing runs, so it never counts as "not started".
   */
  private startWriter(path: string, body: unknown, signal: AbortSignal): Promise<string> {
    return this.startTask(path, body, signal).catch((error: unknown) => {
      throw new UnconfirmedStopError(error);
    });
  }

  private async startTask(path: string, body: unknown, signal: AbortSignal): Promise<string> {
    this.pendingStarts += 1;
    try {
      const started = (await this.request(path, body, signal)) as { task_id?: unknown };
      const taskId = started?.task_id;
      if (typeof taskId !== "string" || !/^[a-f0-9-]{36}$/u.test(taskId))
        throw new BlendkitError(
          "BLENDKIT_INVALID_RESPONSE",
          "Blendkit-Client returned no task id.",
        );
      this.active.add(taskId);
      return taskId;
    } finally {
      this.pendingStarts -= 1;
    }
  }

  /**
   * One /report request at a time, shared by every waiter, so it runs on its own deadline rather
   * than one caller's signal. Terminal tasks are parked until their waiter takes them.
   */
  private poll(): Promise<void> {
    this.polling ??= (async () => {
      try {
        const tasks = await this.request(
          "/report",
          {
            ...this.identity(),
            api_key: "",
            software: "ThreeNative Asset MCP",
            software_version: this.addonVersion,
          },
          AbortSignal.timeout(this.requestTimeoutMs),
        );
        if (!Array.isArray(tasks))
          throw new BlendkitError(
            "BLENDKIT_INVALID_RESPONSE",
            "Blendkit-Client /report is not a list.",
          );
        for (const raw of tasks) {
          // Only these fields are read: a task's `data` echoes its request, API key included.
          const item = raw as Record<string, unknown>;
          if (typeof item?.task_id !== "string" || typeof item.status !== "string") continue;
          const task: BlendkitTask = {
            taskId: item.task_id,
            taskType: safeTaskText(item.task_type, this.secrets).slice(0, 64),
            status: item.status,
            progress: Math.max(0, Math.min(100, Number(item.progress) || 0)),
            message: safeTaskText(item.message, this.secrets),
            result: item.result,
          };
          this.latest.set(task.taskId, { progress: task.progress, message: task.message });
          if (TERMINAL.has(task.status)) this.done.set(task.taskId, task);
        }
        // ponytail: parked results of abandoned waiters are dropped oldest-first past 256.
        for (const map of this.pendingStarts ? [] : [this.done, this.latest])
          for (const id of map.keys()) {
            if (map.size <= 256) break;
            if (!this.active.has(id)) map.delete(id);
          }
      } finally {
        this.polling = undefined;
      }
    })();
    return this.polling;
  }

  private async waitTask(
    taskId: string,
    signal: AbortSignal,
    onProgress?: (progress: TaskProgress) => void,
  ): Promise<BlendkitTask> {
    try {
      for (;;) {
        // Before the parked result: a caller that has aborted never accepts a completion.
        signal.throwIfAborted();
        const finished = this.done.get(taskId);
        if (finished) {
          this.done.delete(taskId);
          if (finished.status === "finished") return finished;
          throw new BlendkitError(
            finished.status === "cancelled" ? "BLENDKIT_CANCELLED" : "BLENDKIT_TASK_FAILED",
            `Blendkit-Client ${finished.taskType || "task"} ${finished.status}: ${finished.message || "no reason given"}`,
          );
        }
        await this.poll();
        const latest = this.latest.get(taskId);
        if (latest && onProgress) onProgress(latest);
        // timers/promises rejects with a generic AbortError; surface the caller's own reason.
        if (!this.done.has(taskId))
          await delay(this.pollIntervalMs, undefined, { signal }).catch(() =>
            signal.throwIfAborted(),
          );
      }
    } finally {
      // A parked completion stays (bounded by eviction): an aborted caller still needs to learn,
      // through cancelDownload, whether the task really ended.
      this.active.delete(taskId);
      this.latest.delete(taskId);
    }
  }

  /** Starts a provider search whose URL the caller built and validated; returns the raw result. */
  async search(urlquery: string, pageSize: number, apiKey: string, signal: AbortSignal) {
    if (apiKey) this.secrets.add(apiKey);
    const taskId = await this.startTask(
      "/assets/search",
      {
        ...this.identity(),
        api_key: apiKey,
        PREFS: { api_key: apiKey },
        urlquery,
        page_size: pageSize,
        asset_type: "",
        tempdir: "",
        get_next: false,
      },
      signal,
    );
    return (await this.waitTask(taskId, signal)).result;
  }

  /** Downloads one asset into downloadDir; a failure that is not an observed task end cancels the Client task. */
  async download(
    assetData: { id: string; name: string; assetType: string; files: unknown[] },
    downloadDir: string,
    resolution: string,
    apiKey: string,
    signal: AbortSignal,
    onProgress?: (progress: TaskProgress) => void,
  ): Promise<string[]> {
    signal.throwIfAborted();
    if (apiKey) this.secrets.add(apiKey);
    // The start request runs to completion so an abort always knows which task to cancel.
    const taskId = await this.startWriter(
      "/assets/download",
      {
        ...this.identity(),
        download_dirs: [downloadDir],
        resolution,
        asset_data: { ...assetData, available_resolutions: [] },
        PREFS: {
          api_key: apiKey,
          scene_id: this.sceneId,
          app_id: this.appId,
          unpack_files: false,
          create_asset_library: false,
          resolution,
        },
      },
      AbortSignal.timeout(this.requestTimeoutMs),
    );
    let task: BlendkitTask;
    try {
      task = await this.waitTask(taskId, signal, onProgress);
    } catch (error) {
      if (taskEnded(error)) throw error;
      // Anything else (abort, timeout, /report failing): ask the official Client to stop the
      // download, then only trust that it did once /report says the task is over.
      throw (await this.cancelDownload(taskId)) ? error : new UnconfirmedStopError(error);
    }
    const paths = (task.result as { file_paths?: unknown })?.file_paths;
    if (!Array.isArray(paths) || !paths.every((path) => typeof path === "string"))
      throw new BlendkitError("BLENDKIT_INVALID_RESPONSE", "Download task returned no file paths.");
    return paths;
  }

  /** True only when the cancelled task was observed in a terminal state within the deadline. */
  private async cancelDownload(taskId: string): Promise<boolean> {
    try {
      await this.request(
        "/assets/cancel_download",
        { task_id: taskId, app_id: this.appId },
        AbortSignal.timeout(this.requestTimeoutMs),
        false,
      );
      this.active.add(taskId);
      await this.waitTask(taskId, AbortSignal.timeout(this.cancelConfirmMs));
      return true;
    } catch (error) {
      return taskEnded(error);
    }
  }

  /** Runs one bundled recipe under the user's headless Blender. The Client cannot cancel a run. */
  async runTool(
    scriptId: string,
    blendPath: string,
    outputPath: string,
    params: Record<string, unknown>,
    blenderExePath: string,
    signal: AbortSignal,
  ): Promise<string> {
    signal.throwIfAborted();
    const taskId = await this.startWriter(
      "/tools/run",
      {
        ...this.identity(),
        script_id: scriptId,
        blender_exe_path: blenderExePath,
        blend_path: blendPath,
        output_path: outputPath,
        params: { ...params, output_path: outputPath },
        software: "ThreeNative Asset MCP",
      },
      signal,
    );
    // The Client cannot cancel a recipe: anything but an observed end leaves Blender possibly writing.
    const task = await this.waitTask(taskId, signal).catch((error: unknown) => {
      throw taskEnded(error) ? error : new UnconfirmedStopError(error);
    });
    const path = (task.result as { file_path?: unknown })?.file_path;
    if (path !== outputPath)
      throw new BlendkitError(
        "BLENDKIT_INVALID_RESPONSE",
        "Tool run reported an unexpected output.",
      );
    return path;
  }
}
