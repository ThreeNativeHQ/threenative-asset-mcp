import { copyFile, mkdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const APP_DIR = join(REPO, "src", "texture-projection", "app");
export const APP_BUILD_DIR = join(REPO, "dist", "texture-projection", "app");

/**
 * Bundles the browser app (`src/texture-projection/app`) into one ES module plus the page and
 * stylesheet the local UI server serves. `three` and `three-mesh-bvh` are bundled in: the page has
 * no import map and the browser never loads anything from the network.
 */
export async function buildTextureProjectionApp(outDir = APP_BUILD_DIR): Promise<string> {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await build({
    entryPoints: [join(APP_DIR, "main.ts")],
    outfile: join(outDir, "app.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    sourcemap: false,
    logLevel: "warning",
  });
  for (const file of ["index.html", join("ui", "style.css")]) {
    await copyFile(join(APP_DIR, file), join(outDir, basename(file)));
  }
  return outDir;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outDir = await buildTextureProjectionApp();
  process.stdout.write(`Built the texture-projection app in ${outDir}\n`);
}
