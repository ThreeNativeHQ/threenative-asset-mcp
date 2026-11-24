import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** What the image stub received, so a test can assert what never was sent. */
export interface StubRequest {
  readonly method: string;
  readonly authorization: string | undefined;
  readonly body: Record<string, unknown>;
}

export interface OpenRouterStub {
  readonly url: string;
  readonly requests: StubRequest[];
  /** Opens the gate that holds request `holdAt` (no timers: the test decides when it may answer). */
  release(): void;
  close(): Promise<void>;
}

/**
 * A local stand-in for OpenRouter's `/api/v1/images`: answers every request with one PNG, records
 * what arrived, and can hold one request open so a test can interrupt a run inside its window.
 */
export async function startOpenRouterStub(
  pngBase64: string,
  options: { holdAt?: number } = {},
): Promise<OpenRouterStub> {
  const requests: StubRequest[] = [];
  let open = (): void => {};
  const gate = new Promise<void>((resolveGate) => {
    open = resolveGate;
  });
  let held = false;
  const server: Server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      } catch {
        body = {};
      }
      requests.push({
        method: request.method ?? "",
        authorization: request.headers.authorization,
        body,
      });
      const answer = () => {
        try {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({ id: "stub-image-1", created: 1, data: [{ b64_json: pngBase64, media_type: "image/png" }] }),
          );
        } catch {
          // the browser was closed while this request was held; nothing to answer
        }
      };
      if (options.holdAt !== undefined && !held && requests.length === options.holdAt) {
        held = true;
        void gate.then(answer);
        return;
      }
      answer();
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    release: open,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}
