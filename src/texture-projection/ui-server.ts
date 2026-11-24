import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, extname, join, resolve, sep } from "node:path";

import { OPENROUTER_IMAGES_PATH, forwardImageRequest } from "./openrouter-proxy.js";
import { defaultRunRoot, isSafeRunFile, isSafeRunId, listRuns, runDirectory } from "./runs.js";

const DEFAULT_APP_DIR = resolve(process.cwd(), "dist", "texture-projection", "app");
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".glb": "model/gltf-binary",
  ".svg": "image/svg+xml",
};

export interface UiServerOptions {
  /** Directory holding the built app (index.html, app.js, style.css). */
  readonly appDir?: string;
  /** Level GLB served at /api/level and auto-loaded by the page. */
  readonly levelPath?: string;
  /** Style image served at /api/style-image and attached to every request. */
  readonly styleImagePath?: string;
  readonly runRoot?: string;
  /** Fixed port, or 0 (the default) for a random free one. */
  readonly port?: number;
  readonly env?: NodeJS.ProcessEnv;
}

export interface UiServer {
  readonly url: string;
  close(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function send(response: ServerResponse, status: number, contentType: string, body: Uint8Array | string): void {
  response.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  send(response, status, CONTENT_TYPES[".json"]!, JSON.stringify(value));
}

function sendText(response: ServerResponse, status: number, message: string): void {
  send(response, status, "text/plain; charset=utf-8", message);
}

/** A file under `root`, or undefined when the request escapes it. */
function containedPath(root: string, relative: string): string | undefined {
  const rootPath = resolve(root);
  const target = resolve(rootPath, `.${sep}${relative}`);
  return target === rootPath || target.startsWith(`${rootPath}${sep}`) ? target : undefined;
}

/**
 * The local UI server: serves the bundled app on 127.0.0.1, proxies image requests to OpenRouter
 * (the key stays in this process), and stores each run's views under the project's
 * `.threenative/texture-projection/` directory.
 */
export async function startUiServer(options: UiServerOptions = {}): Promise<UiServer> {
  const appDir = options.appDir ?? DEFAULT_APP_DIR;
  const runRoot = options.runRoot ?? defaultRunRoot();
  const levelName = options.levelPath === undefined ? undefined : basename(options.levelPath).replace(/\.\w+$/, "");
  try {
    await access(join(appDir, "index.html"));
  } catch {
    throw new Error(`the texture-projection app is not built: ${join(appDir, "index.html")} is missing (run npm run build)`);
  }

  const levelBytes = options.levelPath === undefined ? undefined : new Uint8Array(await readFile(options.levelPath));
  const styleBytes =
    options.styleImagePath === undefined ? undefined : new Uint8Array(await readFile(options.styleImagePath));
  const styleType = options.styleImagePath === undefined ? undefined : CONTENT_TYPES[extname(options.styleImagePath)] ?? "image/png";

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      sendText(response, 500, error instanceof Error ? error.message : "internal error");
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;

    if (path === OPENROUTER_IMAGES_PATH) {
      if (request.method !== "POST") return sendText(response, 405, "POST only");
      let body: unknown;
      try {
        body = JSON.parse(Buffer.from(await readBody(request)).toString("utf8"));
      } catch {
        return sendText(response, 400, "body must be JSON");
      }
      const forwarded = await forwardImageRequest(body, options.env === undefined ? {} : { env: options.env });
      return send(response, forwarded.status, forwarded.contentType, forwarded.bytes);
    }

    if (path === "/api/state") {
      const level = levelName === undefined ? undefined : { name: levelName };
      const runs = (await listRuns(runRoot)).filter((run) => levelName === undefined || run.level === levelName);
      return sendJson(response, 200, { level, styleImage: styleBytes !== undefined, runs });
    }

    if (path === "/api/level") {
      if (!levelBytes) return sendText(response, 404, "no level was given to this server");
      return send(response, 200, CONTENT_TYPES[".glb"]!, levelBytes);
    }

    if (path === "/api/style-image") {
      if (!styleBytes) return sendText(response, 404, "no style image was given to this server");
      return send(response, 200, styleType!, styleBytes);
    }

    if (path.startsWith("/api/runs/")) {
      const parts = path.slice("/api/runs/".length).split("/").filter(Boolean).map(decodeURIComponent);
      if (parts.length !== 2) return sendText(response, 400, "expected /api/runs/<runId>/<file>");
      const [runId, file] = parts as [string, string];
      if (!isSafeRunId(runId) || !isSafeRunFile(file)) return sendText(response, 400, "bad run path");
      const directory = runDirectory(runRoot, runId);
      const target = join(directory, file);
      if (request.method === "GET") {
        try {
          const bytes = new Uint8Array(await readFile(target));
          return send(response, 200, CONTENT_TYPES[extname(file)] ?? "application/octet-stream", bytes);
        } catch {
          return sendText(response, 404, "not found");
        }
      }
      if (request.method === "POST") {
        const bytes = await readBody(request);
        await mkdir(directory, { recursive: true });
        await writeFile(target, bytes);
        return send(response, 204, CONTENT_TYPES[".json"]!, "");
      }
      return sendText(response, 405, "GET or POST only");
    }

    const relative = path === "/" ? "index.html" : path.replace(/^\/+/, "");
    const file = containedPath(appDir, relative);
    if (!file) return sendText(response, 400, "bad path");
    try {
      const bytes = new Uint8Array(await readFile(file));
      return send(response, 200, CONTENT_TYPES[extname(file)] ?? "application/octet-stream", bytes);
    } catch {
      return sendText(response, 404, "not found");
    }
  }

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
    },
  };
}
