/**
 * One view in, one edited image out: the browser posts to the local server's OpenRouter proxy,
 * which adds the key from OPENROUTER_API_KEY. The key never reaches this page.
 */
import type { EditInput, EditModel, ImageRequest } from "../models.js";

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
    headers: { "content-type": "application/json" },
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
