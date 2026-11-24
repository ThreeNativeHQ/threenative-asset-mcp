import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import sharp from "sharp";

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
 * What an image model plausibly returns for the view it was given: the same picture, repainted in
 * other materials (a global colour shift and a slight blur, so no pixel is the untouched clay, while
 * the low-frequency structure — the thing the B.2 check protects — is kept).
 */
async function repainted(dataUrl: string | undefined, paint: "material" | "arch"): Promise<string | undefined> {
  const encoded = /^data:image\/[a-z]+;base64,(.+)$/u.exec(dataUrl ?? "")?.[1];
  if (!encoded) return undefined;
  try {
    const source = Buffer.from(encoded, "base64");
    const metadata = await sharp(source).metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    const repainted = await sharp(source).blur(3).modulate({ brightness: 0.85, saturation: 1.35 }).png().toBuffer();
    if (paint === "material" || width === 0 || height === 0) return repainted.toString("base64");
    // B.2's failure mode: a dark arch painted where the clay image has a flat wall.
    const left = width * 0.36;
    const right = width * 0.64;
    const spring = height * 0.4;
    const bottom = height * 0.66;
    const radius = (right - left) / 2;
    const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><path d="M ${left} ${bottom} L ${left} ${spring} A ${radius} ${radius} 0 0 1 ${right} ${spring} L ${right} ${bottom} Z" fill="#221c1a"/></svg>`;
    const arch = await sharp(repainted)
      .composite([{ input: Buffer.from(svg), left: 0, top: 0 }])
      .png()
      .toBuffer();
    return arch.toString("base64");
  } catch {
    return undefined;
  }
}

/**
 * A local stand-in for OpenRouter's `/api/v1/images`: answers every request with the view it was
 * given, repainted (or a flat PNG when the request carries no usable image), records what arrived,
 * and can hold one request open so a test can interrupt a run inside its window.
 */
export async function startOpenRouterStub(
  pngBase64: string,
  options: { holdAt?: number; paint?: "material" | "arch" } = {},
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
      const answer = async () => {
        const reference = (body["input_references"] as { image_url?: { url?: string } }[] | undefined)?.[0]?.image_url?.url;
        const image = (await repainted(reference, options.paint ?? "material")) ?? pngBase64;
        try {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({ id: "stub-image-1", created: 1, data: [{ b64_json: image, media_type: "image/png" }] }),
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
