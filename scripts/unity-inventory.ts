/**
 * Inventory a Unity package, UPM tarball or project folder, or the local verification corpus.
 *
 *   npx tsx scripts/unity-inventory.ts <package|folder>
 *   npx tsx scripts/unity-inventory.ts --corpus <dir> [--record]
 *
 * The corpus holds one folder per pack id (`U1`, `U2`, `U3`) with that pack's `.unitypackage`.
 * `--record` writes docs/parity/unity-corpus.json: id, listing UID, size, SHA-256, pipelines and counts
 * only, never an asset name. A missing or empty corpus prints a note, writes nothing and exits 0.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { inventoryUnityAssets, unityKind } from "../src/unity/inventory.js";
import { openUnityPackage } from "../src/unity/package.js";
import { parseMeta, parseUnityDocuments } from "../src/unity/yaml.js";

// Public facts from the epic README ("Verification corpus").
const KNOWN_PACKS: Record<string, { listingUid: string; pipelines: string[] }> = {
  U1: { listingUid: "fbc35597-dbcf-4da8-bb29-4fdbf203c46e", pipelines: ["Built-in"] },
  U2: { listingUid: "ed740921-9f30-4444-8c8e-c55db80c7304", pipelines: ["HDRP", "URP", "Built-in"] },
  U3: { listingUid: "7bbf72cf-03bd-458f-9a74-1ab85bd1f2e5", pipelines: ["URP", "Built-in", "custom"] },
};
const RECORD = process.env.UNITY_CORPUS_RECORD ?? fileURLToPath(new URL("../docs/parity/unity-corpus.json", import.meta.url));

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function inspect(source: string) {
  const database = await openUnityPackage(source);
  try {
    let yamlFailures = 0;
    for (const entry of database.entries.values()) {
      try {
        parseMeta(entry.metaYaml);
        const kind = unityKind(entry.path);
        if (entry.assetFile && (kind === "material" || kind === "prefab" || kind === "scene")) {
          parseUnityDocuments(await readFile(entry.assetFile, "utf8"));
        }
      } catch {
        yamlFailures += 1;
      }
    }
    return { shape: database.shape, counts: inventoryUnityAssets(database), yamlFailures };
  } finally {
    await database.dispose();
  }
}

async function corpusPackage(directory: string): Promise<string | undefined> {
  const names = (await readdir(directory).catch(() => [])).filter((name) => name.endsWith(".unitypackage")).sort();
  return names[0] === undefined ? undefined : join(directory, names[0]);
}

async function corpus(root: string, record: boolean): Promise<number> {
  const ids = (await readdir(root, { withFileTypes: true }).catch(() => []))
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name)
    .sort();
  const packs = [];
  for (const id of ids) {
    const file = await corpusPackage(join(root, id));
    if (!file) {
      console.log(`${id}: no .unitypackage found, skipped`);
      continue;
    }
    const result = await inspect(file);
    const known = KNOWN_PACKS[id];
    packs.push({
      id,
      listingUid: known?.listingUid ?? null,
      sizeBytes: (await stat(file)).size,
      sha256: await sha256(file),
      pipelines: known?.pipelines ?? [],
      counts: result.counts,
      yamlFailures: result.yamlFailures,
    });
    console.log(`${id}: ${JSON.stringify(result.counts)} yamlFailures=${result.yamlFailures}`);
  }
  if (packs.length === 0) {
    console.log(`No corpus packs found under ${root}. Nothing inspected, nothing recorded.`);
    return 0;
  }
  if (record) {
    await writeFile(RECORD, `${JSON.stringify({ version: 1, packs }, null, 2)}\n`);
    console.log(`Recorded ${packs.length} pack(s) in ${RECORD}`);
  }
  return packs.some((pack) => pack.yamlFailures > 0) ? 1 : 0;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const corpusAt = args.indexOf("--corpus");
  if (corpusAt >= 0) {
    const root = args[corpusAt + 1];
    if (!root || root.startsWith("--")) {
      console.error("usage: unity-inventory.ts --corpus <dir> [--record]");
      return 2;
    }
    return corpus(resolve(root.replace(/^~(?=\/)/, homedir())), args.includes("--record"));
  }
  const source = args.find((arg) => !arg.startsWith("--"));
  if (!source) {
    console.error("usage: unity-inventory.ts <package|folder> | --corpus <dir> [--record]");
    return 2;
  }
  const result = await inspect(resolve(source));
  console.log(JSON.stringify(result, null, 2));
  return result.yamlFailures > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
