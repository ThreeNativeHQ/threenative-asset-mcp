import { mkdtemp, rm } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DirectAssetDownloader } from "../src/download/direct-asset-downloader.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("direct download backpressure", () => {
  // Hosted sandbox, 2026-11-15: the egress answers `Connection: close`, and a body paused while a chunk
  // was on its way to disk left Node's undici parser paused when the socket ended. Its
  // `assert(!this.paused)` killed the MCP server. The read loop must drain the body however slow the disk.
  it("keeps reading the body while a disk write is still pending", async () => {
    const downloadDir = await mkdtemp(join(tmpdir(), "asset-mcp-backpressure-"));
    directories.push(downloadDir);
    let release!: () => void;
    const disk = new Promise<void>((resolve) => {
      release = resolve;
    });
    const actualOpen = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).open;
    vi.mocked(fs.open).mockImplementationOnce(async (...args: Parameters<typeof actualOpen>) => {
      const handle = await actualOpen(...args);
      const write = handle.write.bind(handle) as (...a: unknown[]) => Promise<unknown>;
      (handle as { write: unknown }).write = (...a: unknown[]) => disk.then(() => write(...a));
      return handle;
    });
    const chunks = [new Uint8Array(4).fill(1), new Uint8Array(4).fill(2), new Uint8Array(4).fill(3)];
    let pulls = 0;
    let closed = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          const chunk = chunks.shift();
          if (chunk) controller.enqueue(chunk);
          else {
            closed = true;
            controller.close();
          }
        },
      },
      { highWaterMark: 0 },
    );
    const downloader = new DirectAssetDownloader({
      downloadDir,
      fetch: async () => new Response(body, { headers: { "content-type": "image/jpeg" } }),
    });
    const result = downloader.download({
      provider: "polyhaven",
      url: "https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/x/x_diff_1k.jpg",
      fileName: "x.jpg",
    });
    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 1_000 });
    expect(pulls).toBe(4);
    release();
    await expect(result).resolves.toMatchObject({ sizeBytes: 12 });
  });
});
