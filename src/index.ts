#!/usr/bin/env node

import { statSync } from "node:fs";
import { join } from "node:path";

import { serveStdio } from "@modelcontextprotocol/server/stdio";

// `import` and `texture-project-ui` are the only argument forms this bin accepts. No arguments still
// starts the stdio MCP server, which is the contract every generated project's .mcp.json depends on.
if (process.argv[2] === "texture-project-ui") {
  const { runTextureProjectUiCli } = await import("./cli.js");
  let server: Awaited<ReturnType<typeof runTextureProjectUiCli>>;
  try {
    server = await runTextureProjectUiCli(process.argv.slice(3), (message) => {
      process.stderr.write(`${message}\n`);
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
  process.stdout.write(`${server.url}\n`);
  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    void server.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  // The UI is served until the operator stops it; the stdio MCP server must not start here.
  await new Promise<never>(() => {});
}

if (process.argv[2] === "import") {
  const { runImportCli } = await import("./cli.js");
  const result = await runImportCli(process.argv.slice(3), (message) => {
    process.stderr.write(`${message}\n`);
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}

import { AmbientCgClient } from "./ambientcg/client.js";
import { AudioCatalogClient } from "./audio/client.js";
import { BundleAssetClient } from "./bundle/client.js";
import { loadCreatureConfig } from "./config.js";
import type { CreatureRunner } from "./creature/runner.js";
import { DirectAssetDownloader } from "./download/direct-asset-downloader.js";
import { FabClient } from "./fab/client.js";
import { ItchAssetClient } from "./itch/client.js";
import { PolyHavenClient } from "./polyhaven/client.js";
import { SketchfabClient } from "./sketchfab/client.js";
import { createAssetServer } from "./server.js";
import { SmithsonianClient } from "./smithsonian/client.js";
import {
  activateCreatureCompilation,
  registerCreatureCompileTool,
} from "./tools/creature.js";

const fab = new FabClient();
const polyhaven = new PolyHavenClient();
const ambientcg = new AmbientCgClient();
const smithsonian = new SmithsonianClient();
const sketchfab = new SketchfabClient();
const audio = new AudioCatalogClient();
const directDownloader = new DirectAssetDownloader();
const itch = new ItchAssetClient({ downloader: directDownloader });
const bundle = new BundleAssetClient({ itch });
let creatureRunner: CreatureRunner | undefined;
try {
  if (statSync(join(process.cwd(), ".threenative")).isDirectory()) {
    creatureRunner = activateCreatureCompilation(
      loadCreatureConfig(),
      process.cwd(),
    );
  }
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      level: "warn",
      message: "Creature compilation is unavailable in this launch root",
      error: error instanceof Error ? error.name : "UnknownError",
    })}\n`,
  );
}
void fab.prepareBrowser();
const handle = serveStdio(
  () => {
    const server = createAssetServer({
      fab,
      polyhaven,
      ambientcg,
      smithsonian,
      sketchfab,
      audio,
      directDownloader,
      itch,
      bundle,
    });
    if (creatureRunner) registerCreatureCompileTool(server, creatureRunner);
    return server;
  },
  {
  onerror(error) {
    process.stderr.write(
      `${JSON.stringify({
        level: "error",
        message: "MCP transport error",
        error: error.name,
      })}\n`,
    );
  },
  },
);

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  await Promise.allSettled([
    fab.close(),
    handle.close(),
    creatureRunner?.close(),
  ]);
}

process.once("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});
process.once("beforeExit", () => {
  void shutdown();
});
