import { z } from "zod";

import { CONSISTENCY_INSTRUCTION, STYLE_INSTRUCTION } from "./models.js";

/** The proxy the app posts to; the key is read here, server-side, and never handed to the browser. */
export const OPENROUTER_IMAGES_PATH = "/api/openrouter/images";
/** The vision check's proxy: one chat completion, two view images, no browsing side effects. */
export const OPENROUTER_CHAT_PATH = "/api/openrouter/chat";
export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai";
export const MISSING_API_KEY_CODE = "TEXTURE_PROJECT_MISSING_API_KEY";
export const BAD_REQUEST_CODE = "TEXTURE_PROJECT_BAD_REQUEST";

const ReferenceSchema = z.object({
  type: z.literal("image_url"),
  image_url: z.object({ url: z.string().min(1) }),
});

const ImageRequestSchema = z.object({
  model: z.string().min(1),
  prompt: z.string().min(1),
  aspect_ratio: z.string().min(1).optional(),
  seed: z.number().int().optional(),
  resolution: z.string().min(1).optional(),
  output_format: z.enum(["png", "jpeg", "webp"]).optional(),
  input_references: z.array(ReferenceSchema).min(1),
  style_image: z.string().min(1).optional(),
  consistency_image: z.string().min(1).optional(),
});

export type ImageRequestBody = z.infer<typeof ImageRequestSchema>;

const DATA_URL = /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=]+$/;

const ChatRequestSchema = z.object({
  model: z.string().min(1).max(200),
  prompt: z.string().min(1).max(8_000),
  /** The clay (what the model was given) and the painted image, in that order. */
  images: z.array(z.string().regex(DATA_URL)).length(2),
});

export type ChatRequestBody = z.infer<typeof ChatRequestSchema>;

export interface ProxyResponse {
  readonly status: number;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

export interface ProxyOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly fetch?: typeof fetch;
}

function jsonResponse(status: number, code: string, message: string): ProxyResponse {
  const bytes = new TextEncoder().encode(JSON.stringify({ error: { code, message } }));
  return { status, contentType: "application/json", bytes };
}

/**
 * Forwards one image request to OpenRouter's images API with the clay/composite references.
 * OpenRouter drops unknown fields silently, so the input image must travel in `input_references`
 * (never `images`); a style image is appended as a second reference with a materials-only
 * instruction, so the model copies wear and palette without copying its composition.
 */
export async function forwardImageRequest(body: unknown, options: ProxyOptions = {}): Promise<ProxyResponse> {
  const env = options.env ?? process.env;
  const key = env.OPENROUTER_API_KEY?.trim();
  if (!key) {
    return jsonResponse(
      500,
      MISSING_API_KEY_CODE,
      "OPENROUTER_API_KEY is not set; texturing calls OpenRouter image models with your own key.",
    );
  }
  const parsed = ImageRequestSchema.safeParse(body);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ");
    return jsonResponse(400, BAD_REQUEST_CODE, `invalid image request (${detail})`);
  }
  const request = parsed.data;
  const references = [...request.input_references];
  let prompt = request.prompt;
  if (request.style_image !== undefined) {
    if (!/^data:image\/(png|jpeg|jpg|webp);base64,/.test(request.style_image)) {
      return jsonResponse(400, BAD_REQUEST_CODE, "style_image must be a base64 data URL of a PNG or JPEG");
    }
    references.push({ type: "image_url", image_url: { url: request.style_image } });
    prompt += STYLE_INSTRUCTION;
  }
  if (request.consistency_image !== undefined) {
    if (!DATA_URL.test(request.consistency_image)) {
      return jsonResponse(400, BAD_REQUEST_CODE, "consistency_image must be a base64 data URL of a PNG or JPEG");
    }
    references.push({ type: "image_url", image_url: { url: request.consistency_image } });
    prompt += CONSISTENCY_INSTRUCTION;
  }
  const payload = {
    model: request.model,
    prompt,
    input_references: references,
    ...(request.aspect_ratio === undefined ? {} : { aspect_ratio: request.aspect_ratio }),
    ...(request.seed === undefined ? {} : { seed: request.seed }),
    ...(request.resolution === undefined ? {} : { resolution: request.resolution }),
    ...(request.output_format === undefined ? {} : { output_format: request.output_format }),
  };
  return send(key, "/api/v1/images", payload, options);
}

/**
 * Forwards the vision check: one chat completion with the clay and the painted image, strict JSON
 * out. It goes through the same server-side key as the painting proxy — the page never holds the key.
 */
export async function forwardChatRequest(body: unknown, options: ProxyOptions = {}): Promise<ProxyResponse> {
  const env = options.env ?? process.env;
  const key = env.OPENROUTER_API_KEY?.trim();
  if (!key) {
    return jsonResponse(
      500,
      MISSING_API_KEY_CODE,
      "OPENROUTER_API_KEY is not set; the vision check calls an OpenRouter chat model with your own key.",
    );
  }
  const parsed = ChatRequestSchema.safeParse(body);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ");
    return jsonResponse(400, BAD_REQUEST_CODE, `invalid chat request (${detail})`);
  }
  const request = parsed.data;
  const payload = {
    model: request.model,
    temperature: 0,
    // Up to six named structures with a where-clause each: a longer answer is a summary, not a verdict.
    // Room for a reasoning model's own tokens as well: at 800 a reasoning check (gemini-2.5-pro measured
    // on the 2d calibration) spent the whole budget thinking and returned an empty answer, which the
    // parser reads as unparsed and the pipeline as a rejection.
    max_tokens: 2_000,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: request.prompt },
          ...request.images.map((url) => ({ type: "image_url", image_url: { url } })),
        ],
      },
    ],
  };
  return send(key, "/api/v1/chat/completions", payload, options);
}

/** One authenticated POST to OpenRouter; the key stays in this function's caller process. */
async function send(
  key: string,
  path: string,
  payload: unknown,
  options: ProxyOptions,
): Promise<ProxyResponse> {
  const env = options.env ?? process.env;
  const base = (env.OPENROUTER_BASE_URL?.trim() || DEFAULT_OPENROUTER_BASE_URL).replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  try {
    const response = await doFetch(`${base}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "application/json",
      bytes: new Uint8Array(await response.arrayBuffer()),
    };
  } catch (error) {
    // Only the failure reason: the request, and with it the key header, never enters the message.
    const reason = error instanceof Error ? error.name : "UnknownError";
    return jsonResponse(502, "TEXTURE_PROJECT_PROXY_FAILED", `OpenRouter request failed (${reason})`);
  }
}
