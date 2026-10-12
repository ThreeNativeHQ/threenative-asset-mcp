/**
 * Measures how close an imported pack looks to Unreal's own thumbnails, without re-importing.
 *
 *   npx tsx scripts/fidelity-sheet.ts --source <pack dir> --import <import output dir> --out <dir> [--max 36]
 *       [--picture-lighting neutral|unreal-like]
 *
 * Needs the import output (its import-report.json) and the source pack (for the editor thumbnails). Writes
 * <out>/sheet.jpg, <out>/fidelity.json (per tile: score 0..100, hue EMD, saturation ratio, density ratio,
 * lightness ratio, judge verdict), <out>/picture-lighting.json (which preset the picture used) and
 * <out>/tiles/<n>-<name>.{reference,render}.png. The picture defaults to an Unreal-style approximation. With
 * THREENATIVE_UNREAL_PREVIEW_REFERENCE set to a local version-1 profile, it is lit and floored by that reference instead
 * (read once; an invalid profile exits 2). The fidelity numbers are always measured in the neutral view, so they do not
 * change with the picture. picture-lighting.json records which picture was drawn, with digests of the reference and the
 * inputs applied (never pixels or paths). Everything under <out> derives from a licensed pack: local-only, never commit
 * it. Exit 0 once the sheet is written (2 on bad usage or an invalid reference); read the table.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { PICTURE_CAMERA, colouredGlbKeys, renderContactSheet, type PictureLighting } from "../src/unreal/contact-sheet.js";
import { findThumbnails } from "../src/unreal/package-thumbnail.js";
import {
  describePicture,
  pictureRecord,
  preparePreviewPicture,
  type PictureIdentity,
  type PreviewPicture,
} from "../src/unreal/preview-reference-workflow.js";

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
}

/** What the picture was lit with, in words that never call the approximation the reference. */
function pictureNote(identity: PictureIdentity): string {
  if (identity.kind === "neutral") return "flat neutral light";
  if (identity.kind === "fallback") return "unreal-style approximation (hemisphere fill and procedural checker; not the reference environment)";
  return "unreal-style approximation lit by the local reference environment and Grid (camera and renderer differ)";
}

const source = arg("--source");
const importDir = arg("--import");
const out = arg("--out");
if (!source || !importDir || !out) {
  console.error("usage: fidelity-sheet.ts --source <pack dir> --import <import output dir> --out <dir> [--max N]");
  process.exit(2);
}
const max = Number(arg("--max") ?? 36);
// The sheet picture defaults to the Unreal-style approximation; `--picture-lighting neutral` restores the flat view.
const pictureLighting: PictureLighting = arg("--picture-lighting") === "neutral" ? "neutral" : "unreal-like";
// The configured reference is read here, before the output directory or any thumbnail: an invalid one exits 2.
let picture: PreviewPicture;
try {
  picture = await preparePreviewPicture(process.env, pictureLighting);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
console.log(`Picture: ${describePicture(picture.identity)}`);
const report = JSON.parse(readFileSync(join(importDir, "import-report.json"), "utf8"));
mkdirSync(out, { recursive: true });
const thumbnails = await findThumbnails({ sourceDir: resolve(source), report });
const absolute = (key: string): string => join(resolve(importDir), key);
const result = await renderContactSheet({
  glbPaths: report.models.map((m: { glb: string }) => absolute(m.glb)),
  outPath: join(out, "sheet.jpg"),
  title: "fidelity",
  selection: "spread",
  maxMeshes: max,
  thumbnails: new Map([...thumbnails].map(([k, v]) => [absolute(k), v])),
  expectColoured: new Set([...colouredGlbKeys(report)].map(absolute)),
  dumpTilesDir: join(out, "tiles"),
  pictureLighting,
  ...picture.inputs,
});
const record = pictureRecord(picture, result);
writeFileSync(join(out, "fidelity.json"), JSON.stringify(result.judge, null, 1));
// Numbers only: what the picture was lit with, the metric preset it does NOT change, the shared camera, and the reference
// inputs the picture was given (digests and applied reports; never pixels or paths).
writeFileSync(
  join(out, "picture-lighting.json"),
  JSON.stringify(
    {
      preset: pictureLighting,
      picture: pictureNote(record.identity),
      metricsPreset: "neutral",
      camera: { fov: PICTURE_CAMERA.fov, direction: [...PICTURE_CAMERA.direction], fit: PICTURE_CAMERA.fit },
      ...record,
    },
    null,
    1,
  ),
);
const rows = result.judge.map((j) => ({
  name: j.name,
  verdict: j.verdict,
  score: j.fidelity ? Math.round(j.fidelity.score) : "-",
  hueEmd: j.fidelity ? Math.round(j.fidelity.hueEmdDegrees) : "-",
  sat: j.fidelity ? Number(j.fidelity.saturationRatio.toFixed(2)) : "-",
  density: j.fidelity ? Number(j.fidelity.densityRatio.toFixed(2)) : "-",
  mass: j.fidelity ? Number(j.fidelity.massRatio.toFixed(2)) : "-",
  light: j.fidelity ? Number(j.fidelity.lightnessRatio.toFixed(2)) : "-",
  oldSim: j.similarity !== undefined ? Number(j.similarity.toFixed(2)) : "-",
}));
console.table(rows);
const scored = result.judge.flatMap((j) => (j.fidelity ? [j.fidelity.score] : []));
console.log(
  `tiles=${result.judge.length} compared=${scored.length} meanScore=${scored.length ? (scored.reduce((a, b) => a + b, 0) / scored.length).toFixed(1) : "-"} ` +
    `ok=${result.judge.filter((j) => j.verdict === "ok").length} suspect=${result.judge.filter((j) => j.verdict === "suspect").length} fail=${result.judge.filter((j) => j.verdict === "fail").length}`,
);
