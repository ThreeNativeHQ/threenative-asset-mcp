export interface MetadataContext {
  signal?: AbortSignal;
  fresh?: boolean;
}

/** Stream metadata with a decompressed byte cap, including chunked responses. */
export async function readMetadata(
  response: Response,
  maxBytes = 16 * 1024 * 1024,
  signal?: AbortSignal,
): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maxBytes) {
    await response.body?.cancel();
    throw new Error("Provider metadata exceeds the byte limit.");
  }
  if (!response.body) throw new Error("Provider metadata body is missing.");
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    signal?.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error("Provider metadata exceeds the byte limit.");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, bytes).toString("utf8");
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

type Pending = { controller: AbortController; promise: Promise<unknown>; subscribers: number };

/** Per-client requests share only their own authorization scope. Each caller may cancel independently. */
export class MetadataRequests {
  private readonly pending = new Map<string, Pending>();

  run<T>(
    key: string,
    signal: AbortSignal | undefined,
    request: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    signal?.throwIfAborted();
    let entry = this.pending.get(key);
    if (!entry || entry.controller.signal.aborted) {
      if (this.pending.size >= 64)
        throw new Error("Too many concurrent provider metadata requests.");
      const controller = new AbortController();
      entry = { controller, promise: request(controller.signal), subscribers: 0 };
      const current = entry;
      this.pending.set(key, entry);
      void entry.promise
        .finally(() => {
          if (this.pending.get(key) === current) this.pending.delete(key);
        })
        .catch(() => {});
    }
    const current = entry;
    current.subscribers++;
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      const finish = () => {
        if (finished) return false;
        finished = true;
        signal?.removeEventListener("abort", abort);
        if (--current.subscribers === 0) current.controller.abort();
        return true;
      };
      const abort = () => {
        if (finish()) reject(signal?.reason ?? new Error("Provider request canceled."));
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      void current.promise.then(
        (value) => {
          if (finish()) resolve(value as T);
        },
        (error: unknown) => {
          if (finish()) reject(error);
        },
      );
    });
  }
}
