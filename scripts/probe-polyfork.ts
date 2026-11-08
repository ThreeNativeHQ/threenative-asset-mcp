/**
 * Live Polyfork contract probe: search a named character, download its real full
 * low-poly GLB through the production client and downloader, verify the GLB
 * header, read its scene/skin/animation facts and delete the disposable copy.
 *
 *   npx tsx scripts/probe-polyfork.ts [query]
 *
 * Prints one JSON document on stdout; nothing is kept on disk.
 */
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeIO } from "@gltf-transform/core";

import { DirectAssetDownloader } from "../src/download/direct-asset-downloader.js";
import { PolyforkClient } from "../src/polyfork/client.js";

const query = process.argv[2] ?? "musician";

const client = new PolyforkClient();
const search = await client.search({ query, assetClass: "character", perPage: 10 });
const found = search.items[0];
if (!found) throw new Error(`No Polyfork character matched ${JSON.stringify(query)}.`);
const detail = await client.getAsset(found.id);
if (!detail.download.glb) throw new Error("Polyfork returned no anonymous full GLB.");

const directory = await mkdtemp(join(tmpdir(), "polyfork-probe-"));
try {
  const downloader = new DirectAssetDownloader({
    downloadDir: directory,
    maxDownloadBytes: 64 * 1024 * 1024,
  });
  const file = await downloader.download({
    provider: "polyfork",
    url: detail.download.glb,
    fileName: `${detail.id}.glb`,
  });
  const bytes = await readFile(file.path);
  const document = await new NodeIO().readBinary(new Uint8Array(bytes));
  const root = document.getRoot();
  const skins = root.listSkins();
  console.log(
    JSON.stringify(
      {
        query,
        id: detail.id,
        title: detail.title,
        url: detail.pageUrl,
        license: detail.licenseText ?? null,
        credit: detail.credit ?? null,
        hd: detail.hd,
        declaredClips: detail.clips,
        declaredSkeleton: detail.skeleton ?? null,
        file: {
          bytes: bytes.length,
          declaredLength: bytes.readUInt32LE(8),
          magic: bytes.toString("utf8", 0, 4),
          version: bytes.readUInt32LE(4),
          sha256: file.sha256,
          contentLengthMatches: bytes.readUInt32LE(8) === bytes.length,
        },
        glb: {
          scenes: root.listScenes().length,
          meshes: root.listMeshes().length,
          nodes: root.listNodes().length,
          skins: skins.length,
          skinJoints: skins.map((skin) => skin.listJoints().length),
          materials: root.listMaterials().length,
          animations: root.listAnimations().map((animation) => ({
            name: animation.getName(),
            channels: animation.listChannels().length,
          })),
        },
      },
      null,
      2,
    ),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
