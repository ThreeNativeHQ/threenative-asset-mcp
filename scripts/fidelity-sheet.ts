/**
 * Measures how close an imported pack looks to Unreal's own thumbnails, without re-importing.
 *
 *   npx tsx scripts/fidelity-sheet.ts --source <pack dir> --import <import output dir> --out <dir> [--max 36]
 *
 * Needs the import output (its import-report.json) and the source pack (for the editor thumbnails). Writes
 * <out>/sheet.jpg, <out>/fidelity.json (per tile: score 0..100, hue EMD, saturation ratio, density ratio,
 * lightness ratio, judge verdict) and <out>/tiles/<n>-<name>.{reference,render}.png. Everything under <out> derives
 * from a licensed pack: local-only, never commit it. Exit 0 always; read the table.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { colouredGlbKeys, renderContactSheet } from "../src/unreal/contact-sheet.js";
import { findThumbnails } from "../src/unreal/package-thumbnail.js";

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
}

const source = arg("--source");
const importDir = arg("--import");
const out = arg("--out");
if (!source || !importDir || !out) {
  console.error("usage: fidelity-sheet.ts --source <pack dir> --import <import output dir> --out <dir> [--max N]");
  process.exit(2);
}
const max = Number(arg("--max") ?? 36);
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
});
writeFileSync(join(out, "fidelity.json"), JSON.stringify(result.judge, null, 1));
const rows = result.judge.map((j) => ({
  name: j.name,
  verdict: j.verdict,
  score: j.fidelity ? Math.round(j.fidelity.score) : "-",
  hueEmd: j.fidelity ? Math.round(j.fidelity.hueEmdDegrees) : "-",
  sat: j.fidelity ? Number(j.fidelity.saturationRatio.toFixed(2)) : "-",
  density: j.fidelity ? Number(j.fidelity.densityRatio.toFixed(2)) : "-",
  light: j.fidelity ? Number(j.fidelity.lightnessRatio.toFixed(2)) : "-",
  oldSim: j.similarity !== undefined ? Number(j.similarity.toFixed(2)) : "-",
}));
console.table(rows);
const scored = result.judge.flatMap((j) => (j.fidelity ? [j.fidelity.score] : []));
console.log(
  `tiles=${result.judge.length} compared=${scored.length} meanScore=${scored.length ? (scored.reduce((a, b) => a + b, 0) / scored.length).toFixed(1) : "-"} ` +
    `ok=${result.judge.filter((j) => j.verdict === "ok").length} suspect=${result.judge.filter((j) => j.verdict === "suspect").length} fail=${result.judge.filter((j) => j.verdict === "fail").length}`,
);
