/**
 * One view in, one edited image out: the browser posts to the local server's OpenRouter proxy,
 * which adds the key from OPENROUTER_API_KEY. The key never reaches this page.
 */
import type { EditInput, EditModel, ImageRequest } from "../models.js";
import {
  parseVerifyAnswer,
  verifyModelFor,
  verifyUsageUsd,
  type VerifyAnswer,
} from "../verify.js";
import { postHeaders } from "./token.js";

export interface EditResult {
  image: ImageBitmap;
  seconds: number;
  requestId?: string;
  /** What the model says it ran, for debugging prompts. */
  expanded?: unknown;
}

/** Style image (data URL) attached to every request: materials from it, composition from the view. */
let styleImage: string | undefined;

export function setStyleImage(dataUrl: string | undefined) {
  styleImage = dataUrl;
}

export function getStyleImage(): string | undefined {
  return styleImage;
}

export async function runEdit(model: EditModel, input: EditInput, signal?: AbortSignal): Promise<EditResult> {
  const t0 = performance.now();
  const body: ImageRequest = { ...model.input(input), ...(styleImage ? { style_image: styleImage } : {}) };
  const res = await fetch("/api/openrouter/images", {
    method: "POST",
    signal,
    headers: postHeaders("application/json"),
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as {
    data?: { b64_json?: string; media_type?: string }[];
    id?: string;
    error?: { message?: string } | string;
  };
  const first = data.data?.[0];
  if (!res.ok || !first?.b64_json) {
    const reason = typeof data.error === "string" ? data.error : data.error?.message;
    throw new Error(`${model.label} failed: ${res.status} ${reason ?? "no image returned"}`);
  }
  const blob = await (await fetch(`data:${first.media_type ?? "image/png"};base64,${first.b64_json}`)).blob();
  return { image: await createImageBitmap(blob), seconds: (performance.now() - t0) / 1000, requestId: data.id };
}

export interface VerifyResult extends VerifyAnswer {
  /** What the check cost, from the completion's usage. */
  readonly cost: number;
  readonly seconds: number;
}

/**
 * The vision check for one painted view: the clay image the model was given, the painted image, and
 * the strict-JSON question (`verify.ts`). It goes through the same local proxy as the painting call,
 * so the key stays in the server process. A request that fails or answers something unreadable comes
 * back `unparsed`, which the pipeline counts and treats as a rejection (fail closed).
 */
export async function runVerify(
  model: string,
  prompt: string,
  images: readonly [string, string],
  viewSize: number,
  signal?: AbortSignal,
): Promise<VerifyResult> {
  const t0 = performance.now();
  const seconds = () => (performance.now() - t0) / 1000;
  let res: Response;
  try {
    res = await fetch("/api/openrouter/chat", {
      method: "POST",
      signal,
      headers: postHeaders("application/json"),
      body: JSON.stringify({ model, prompt, images }),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    return { added: [], bands: [], scaleOk: false, verdict: "unparsed", reason: "request failed", cost: 0, seconds: seconds() };
  }
  const data = (await res.json().catch(() => ({}))) as {
    choices?: { message?: { content?: unknown } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    error?: { message?: string } | string;
  };
  if (!res.ok) {
    const reason = typeof data.error === "string" ? data.error : data.error?.message;
    return {
      added: [],
      bands: [],
      scaleOk: false,
      verdict: "unparsed",
      reason: reason ?? `status ${res.status}`,
      cost: 0,
      seconds: seconds(),
    };
  }
  const cost = verifyUsageUsd(verifyModelFor(model), data.usage, viewSize);
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    return { added: [], bands: [], scaleOk: false, verdict: "unparsed", reason: "no text answer", cost, seconds: seconds() };
  }
  return { ...parseVerifyAnswer(content), cost, seconds: seconds() };
}
