import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AudioCatalogClient } from "../src/audio/client.js";
import {
  createAudioDownloadHandler,
  createAudioListSourcesHandler,
  createAudioSearchHandler,
} from "../src/tools/audio.js";
import { withKenneyLinks } from "./helpers/kenney-links.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "asset-mcp-audio-"));
  temporaryDirectories.push(directory);
  return directory;
}

function outputOf<T>(
  result: { structuredContent: T } | { isError: true; content: unknown[] },
): T {
  if ("structuredContent" in result) return result.structuredContent;
  throw new Error(`Expected MCP success, received ${JSON.stringify(result)}`);
}

describe("audio source catalog", () => {
  it("lists every requested audio source with honest download capabilities", async () => {
    const result = await createAudioListSourcesHandler(new AudioCatalogClient())({});
    const output = outputOf(result);

    expect(output?.sources).toHaveLength(10);
    expect(output?.sources.map((source) => source.id)).toEqual([
      "sonniss",
      "kenney",
      "tallbeard",
      "scott-buckley",
      "itch-io",
      "mixkit",
      "pixabay",
      "freesound",
      "opengameart",
      "abstraction",
    ]);
    expect(output?.sources.find((source) => source.id === "kenney")).toMatchObject({
      licenseSummary: "CC0 (verify the individual pack page)",
      programmaticDownload: "curated-direct",
    });
    expect(output?.sources.find((source) => source.id === "freesound")).toMatchObject({
      licenseSummary: "Per asset; prefer CC0 or CC BY and avoid CC BY-NC for commercial use",
      programmaticDownload: "provider-page",
    });
  });

  it("searches curated directly downloadable packs by text, kind, and source", async () => {
    const handler = createAudioSearchHandler(new AudioCatalogClient());
    const kenney = await handler({ query: "interface", kind: "sfx", source: "kenney" });
    const sonniss = await handler({ query: "GDC 2026", source: "sonniss", limit: 10 });

    const kenneyOutput = outputOf(kenney);
    const sonnissOutput = outputOf(sonniss);
    expect(kenneyOutput.items).toHaveLength(1);
    expect(kenneyOutput.items[0]).toMatchObject({
      id: "kenney-interface-sounds",
      kind: "sfx",
      sourceId: "kenney",
      directDownload: true,
    });
    expect(sonnissOutput.items).toHaveLength(5);
    expect(sonnissOutput.total).toBe(5);
  });
});

describe("audio downloads", () => {
  it("downloads a catalog asset safely and returns integrity and license metadata", async () => {
    const downloadDir = await temporaryDirectory();
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(new Uint8Array([80, 75, 3, 4, 1, 2, 3]), {
        status: 200,
        headers: {
          "content-length": "7",
          "content-type": "application/zip",
        },
      }),
    );
    const client = new AudioCatalogClient({ fetch: withKenneyLinks(fetch), downloadDir, maxDownloadBytes: 1024 });
    const handler = createAudioDownloadHandler(client);

    const result = await handler({
      assetId: "kenney-interface-sounds",
      acceptLicense: true,
    });

    expect("isError" in result).toBe(false);
    const output = outputOf(result);
    expect(output).toMatchObject({
      assetId: "kenney-interface-sounds",
      fileName: "kenney_interface-sounds.zip",
      sizeBytes: 7,
      alreadyExisted: false,
      license: "CC0",
      attributionRequired: false,
    });
    expect(output.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await readFile(output.path)).toEqual(
      Buffer.from([80, 75, 3, 4, 1, 2, 3]),
    );
  });

  it("is idempotent and does not redownload an existing catalog asset", async () => {
    const downloadDir = await temporaryDirectory();
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-length": "3" },
      }),
    );
    const handler = createAudioDownloadHandler(
      new AudioCatalogClient({ fetch: withKenneyLinks(fetch), downloadDir, maxDownloadBytes: 1024 }),
    );

    await handler({ assetId: "kenney-music-jingles", acceptLicense: true });
    const second = await handler({
      assetId: "kenney-music-jingles",
      acceptLicense: true,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(outputOf(second).alreadyExisted).toBe(true);
  });

  it("rejects unknown IDs and oversized downloads without leaving a completed file", async () => {
    const downloadDir = await temporaryDirectory();
    const handler = createAudioDownloadHandler(
      new AudioCatalogClient({
        downloadDir,
        maxDownloadBytes: 4,
        fetch: withKenneyLinks(
          async () =>
            new Response(new Uint8Array([1, 2, 3, 4, 5]), {
              status: 200,
              headers: { "content-length": "5" },
            }),
        ),
      }),
    );

    const unknown = await handler({ assetId: "not-real", acceptLicense: true });
    const oversized = await handler({
      assetId: "kenney-interface-sounds",
      acceptLicense: true,
    });

    expect(JSON.parse(unknown.content[0]?.text ?? "{}")).toMatchObject({
      code: "AUDIO_ASSET_NOT_FOUND",
    });
    expect(JSON.parse(oversized.content[0]?.text ?? "{}")).toMatchObject({
      code: "AUDIO_DOWNLOAD_TOO_LARGE",
    });
    await expect(
      access(
        join(
          downloadDir,
          "kenney",
          "kenney-interface-sounds",
          "kenney_interface-sounds.zip",
        ),
      ),
    ).rejects.toThrow();
  });

  it("rejects redirects outside the curated audio hosts", async () => {
    const handler = createAudioDownloadHandler(
      new AudioCatalogClient({
        downloadDir: await temporaryDirectory(),
        fetch: withKenneyLinks(
          async () =>
            new Response(null, {
              status: 302,
              headers: { location: "https://evil.example/audio.zip" },
            }),
        ),
      }),
    );

    const result = await handler({
      assetId: "kenney-interface-sounds",
      acceptLicense: true,
    });

    expect(JSON.stringify(result)).toContain("AUDIO_UNSAFE_REDIRECT");
  });

  it("requires explicit license acknowledgement", async () => {
    const handler = createAudioDownloadHandler(new AudioCatalogClient());
    const result = await handler({
      assetId: "kenney-interface-sounds",
      acceptLicense: false as never,
    });

    expect("isError" in result && result.isError).toBe(true);
    expect(JSON.parse(result.content[0]?.text ?? "{}")).toMatchObject({
      code: "AUDIO_INVALID_INPUT",
    });
  });
});
