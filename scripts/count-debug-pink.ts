/**
 * Count a capture's debug-fill pink: the share of an image that is the hot pink `fill: "debug"` writes in
 * texels no accepted view painted (PRD-916 phase 2r), so a bake's gaps are a number and not an opinion.
 *
 *   npx tsx scripts/count-debug-pink.ts shot.png [more.png ...]
 *
 * One JSON line per image: {"image":"shot.png","pixels":921600,"pink":139,"share":0.000151}. Lighting moves
 * the colour, so the count is a hue/saturation family test (`countDebugPink` in
 * `src/texture-projection/debug-pink.ts`), not a match on #FF69B4: a shadowed pink still counts, a pale wall
 * and the blue sky do not.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import sharp from "sharp";

import { countDebugPink } from "../src/texture-projection/debug-pink.js";

const paths = process.argv.slice(2);
if (paths.length === 0) {
  console.error("usage: tsx scripts/count-debug-pink.ts <png...>");
  process.exit(2);
}
for (const path of paths) {
  // ensureAlpha: a capture may be RGB; the counter reads RGBA and skips transparent pixels.
  const { data, info } = await sharp(await readFile(path))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const count = countDebugPink(data);
  console.log(JSON.stringify({ image: basename(path), width: info.width, height: info.height, ...count }));
}
