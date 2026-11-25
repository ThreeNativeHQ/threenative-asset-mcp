/**
 * The server injects a per-process token into this page; every POST sends it back. A web page the
 * user has open elsewhere cannot read this document, so it cannot spend the key or write run files.
 */
let cached: string | undefined;

export function postHeaders(contentType: "application/json" | "application/octet-stream"): Record<string, string> {
  cached ??= document.querySelector<HTMLMetaElement>('meta[name="texture-projection-token"]')?.content ?? "";
  return { "content-type": contentType, "x-texture-projection-token": cached };
}
