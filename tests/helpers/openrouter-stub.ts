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
 * What an image model plausibly returns for the view it was given: the same picture, repainted with
 * a fine colour grain (so no pixel is untouched clay) while its low-frequency luminance — the thing
 * the B.2 check protects — stays within a few levels. With `arch` it also paints the failure mode
 * that check exists for: a dark arch on a flat wall.
 */
async function repainted(dataUrl: string | undefined, paint: "material" | "arch"): Promise<string | undefined> {
  const encoded = /^data:image\/[a-z]+;base64,(.+)$/u.exec(dataUrl ?? "")?.[1];
  if (!encoded) return undefined;
  try {
    const source = Buffer.from(encoded, "base64");
    const metadata = await sharp(source).metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (width === 0 || height === 0) return undefined;
    // Grain in red and blue only: max-channel difference well over the "untouched clay" tolerance,
    // luminance nearly unchanged, and nothing low-frequency.
    const grain = Buffer.alloc(width * height * 3);
    let seed = 1234567;
    const random = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < width * height; i++) {
      grain[i * 3] = 10 + Math.floor(random() * 20);
      grain[i * 3 + 1] = 0;
      grain[i * 3 + 2] = 10 + Math.floor(random() * 20);
    }
    const grained = await sharp(source)
      .composite([{ input: grain, raw: { width, height, channels: 3 }, blend: "add" }])
      .png()
      .toBuffer();
    if (paint === "material") return grained.toString("base64");
    // Put the arch inside one flat run of level geometry, not across the sky or a silhouette: the
    // failure mode is an opening painted on a wall, and a shape hanging over the sky is not inside
    // any clay surface (nothing over the sky is ever projected). The flattest window with the fewest
    // sky pixels wins, nearest the middle of the frame.
    const probe = await sharp(source)
      .greyscale()
      .resize(Math.max(1, Math.round(width / 8)), Math.max(1, Math.round(height / 8)), { fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const cols = probe.info.width;
    const rows = probe.info.height;
    const levels = probe.data;
    const windowCols = Math.max(3, Math.round((0.28 * width * cols) / width));
    const windowRows = Math.max(3, Math.round((0.26 * height * rows) / height));
    let best = { x: 0, y: 0, score: -Infinity };
    for (let y = 0; y + windowRows <= rows; y++) {
      for (let x = 0; x + windowCols <= cols; x++) {
        const values: number[] = [];
        for (let dy = 0; dy < windowRows; dy++) {
          for (let dx = 0; dx < windowCols; dx++) values.push(levels[(y + dy) * cols + x + dx]!);
        }
        values.sort((a, b) => a - b);
        const median = values[values.length >> 1]!;
        // On the clay, a flat surface is one constant gray; the sky is brighter than 179.
        const flat = values.filter((value) => Math.abs(value - median) <= 8).length / values.length;
        const lit = median < 179 ? 1 : 0;
        const offCentre = Math.abs(x + windowCols / 2 - cols / 2) + Math.abs(y + windowRows / 2 - rows / 2);
        const score = lit * 10 + flat - offCentre * 0.01;
        if (score > best.score) best = { x, y, score };
      }
    }
    const archWidth = windowCols * (width / cols);
    const archHeight = windowRows * (height / rows);
    const left = best.x * (width / cols);
    const top = best.y * (height / rows);
    const half = archWidth / 2;
    const right = left + archWidth;
    const spring = top + half;
    const bottom = top + archHeight;
    const radius = (right - left) / 2;
    const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><path d="M ${left} ${bottom} L ${left} ${spring} A ${radius} ${radius} 0 0 1 ${right} ${spring} L ${right} ${bottom} Z" fill="#221c1a"/></svg>`;
    const arch = await sharp(grained)
      .composite([{ input: Buffer.from(svg), left: 0, top: 0 }])
      .png()
      .toBuffer();
    return arch.toString("base64");
  } catch {
    return undefined;
  }
}

/**
 * What the vision check stub answers. "ok" passes every view; "invented" names a pillar and roof
 * tiles on every check (every view rejected); "garbage" answers prose (an unparsed verdict);
 * "once" rejects the first check of a view and passes its repaint, so a run can recover.
 */
export type StubVerify = "ok" | "invented" | "garbage" | "once";

const INVENTED = ["a ruined stone pillar on the back wall", "red roof-tile coping along the wall top"];

function chatAnswer(verify: StubVerify, checks: number): string {
  if (verify === "garbage") return "The painting looks like a courtyard wall, with no inventions that I can see.";
  const reject =
    verify === "invented" ||
    (verify === "once" && checks % 2 === 1);
  return JSON.stringify({
    added: reject ? INVENTED.map((what) => ({ what, outOfSurface: true })) : [],
    scaleOk: !(verify === "invented" && checks % 3 === 0),
    reason: reject ? "the painting adds structure the clay does not have" : "materials only, plausible size",
  });
}

/**
 * A local stand-in for OpenRouter's `/api/v1/images` and `/api/v1/chat/completions`: answers an image
 * request with the view it was given, repainted (or a flat PNG when the request carries no usable
 * image), and a chat request with the vision check's strict JSON answer; records what arrived, and
 * can hold one request open so a test can interrupt a run inside its window.
 */
export async function startOpenRouterStub(
  pngBase64: string,
  options: { holdAt?: number; paint?: "material" | "arch"; verify?: StubVerify } = {},
): Promise<OpenRouterStub> {
  const requests: StubRequest[] = [];
  let open = (): void => {};
  const gate = new Promise<void>((resolveGate) => {
    open = resolveGate;
  });
  let held = false;
  let checks = 0;
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
        if ((request.url ?? "").startsWith("/api/v1/chat/completions")) {
          checks += 1;
          try {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
              JSON.stringify({
                id: `stub-chat-${checks}`,
                choices: [{ message: { role: "assistant", content: chatAnswer(options.verify ?? "ok", checks) } }],
                usage: { prompt_tokens: 2_600, completion_tokens: 90 },
              }),
            );
          } catch {
            // the browser was closed while this request was held; nothing to answer
          }
          return;
        }
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
