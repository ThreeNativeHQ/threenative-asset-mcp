import { describe, expect, it, vi } from "vitest";
import { PolyHavenClient } from "../src/polyhaven/client.js";
import { AmbientCgClient } from "../src/ambientcg/client.js";
import { SmithsonianClient } from "../src/smithsonian/client.js";
import { SketchfabClient } from "../src/sketchfab/client.js";
import { readMetadata } from "../src/discovery/metadata.js";

describe("provider transport resource boundaries", () => {
  it("forwards caller cancellation into the actual provider fetch", async () => {
    for (const provider of ["polyhaven", "ambientcg", "smithsonian", "sketchfab"]) {
      const controller = new AbortController();
      let fetchedSignal: AbortSignal | undefined;
      const fetchMock = vi.fn<typeof fetch>(async (_url, options) => {
        fetchedSignal = options?.signal ?? undefined;
        return await new Promise<Response>((_resolve, reject) =>
          fetchedSignal!.addEventListener("abort", () => reject(fetchedSignal!.reason), {
            once: true,
          }),
        );
      });
      const pending =
        provider === "polyhaven"
          ? new PolyHavenClient(fetchMock).getAsset("chair", { signal: controller.signal })
          : provider === "ambientcg"
            ? new AmbientCgClient(fetchMock).getAsset("chair", { signal: controller.signal })
            : provider === "smithsonian"
              ? new SmithsonianClient(fetchMock).listFiles("chair", { signal: controller.signal })
              : new SketchfabClient(fetchMock, { token: null }).getModel("chair", {
                  signal: controller.signal,
                });
      controller.abort();
      expect(fetchedSignal?.aborted, provider).toBe(true);
      await expect(pending).rejects.toThrow();
    }
  });

  it("bypasses cached metadata when fresh detail is required", async () => {
    let revision = 0;
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ name: `Revision ${++revision}`, type: 2 }),
    );
    const client = new PolyHavenClient(fetchMock);
    await client.getAsset("chair");
    await client.getAsset("chair");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await client.getAsset("chair", { fresh: true })).name).toBe("Revision 2");
  });

  it("coalesces same-scope reads while preserving independent caller cancellation", async () => {
    let fetchedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn<typeof fetch>(async (_url, options) => {
      fetchedSignal = options?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) =>
        fetchedSignal!.addEventListener("abort", () => reject(new Error("Canceled transport")), {
          once: true,
        }),
      );
    });
    const client = new PolyHavenClient(fetchMock);
    const first = new AbortController();
    const second = new AbortController();
    const one = client.getAsset("chair", { signal: first.signal });
    const two = client.getAsset("chair", { signal: second.signal });
    first.abort();
    await expect(one).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchedSignal?.aborted).toBe(false);
    second.abort();
    await expect(two).rejects.toThrow();
    expect(fetchedSignal?.aborted).toBe(true);
  });

  it("evicts metadata beyond the client entry bound", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ name: "Chair", type: 2 }));
    const client = new PolyHavenClient(fetchMock);
    for (let i = 0; i < 65; i++) await client.getAsset(`chair-${i}`);
    await client.getAsset("chair-0");
    expect(fetchMock).toHaveBeenCalledTimes(66);
  });

  it("evicts metadata beyond the aggregate client byte bound", async () => {
    const largeDescription = "x".repeat(11 * 1024 * 1024);
    const fetchMock = vi.fn<typeof fetch>(async () =>
      Response.json({ name: "Chair", type: 2, description: largeDescription }),
    );
    const client = new PolyHavenClient(fetchMock);
    for (let i = 0; i < 3; i++) await client.getAsset(`chair-${i}`);
    await client.getAsset("chair-0");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("caps streamed metadata and cancels error response bodies with Retry-After", async () => {
    let canceled = false;
    const oversized = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(33));
        },
        cancel() {
          canceled = true;
        },
      }),
    );
    await expect(readMetadata(oversized, 32)).rejects.toThrow("byte limit");
    expect(canceled).toBe(true);
    let deniedCanceled = false;
    const client = new PolyHavenClient(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              deniedCanceled = true;
            },
          }),
          { status: 429, headers: { "retry-after": "60" } },
        ),
    );
    await expect(client.getAsset("chair")).rejects.toMatchObject({
      code: "POLYHAVEN_RATE_LIMITED",
      retryAfter: "60",
    });
    expect(deniedCanceled).toBe(true);
  });
});
