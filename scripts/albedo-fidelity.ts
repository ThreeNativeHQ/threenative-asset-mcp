/**
 * Measures an import against the package itself, for packs without Unreal thumbnails (UE5).
 *
 *   npx tsx scripts/albedo-fidelity.ts --import <import output dir> [--mask <mask.png>]... [--out <file.json>] [--only <name part>] [--tile <px>]
 *
 * Per model: renders it with the contact-sheet renderer and compares the object's hue and saturation with the
 * alpha-weighted albedo of the textures its materials bind (src/unreal/albedo-fidelity.ts), and audits every
 * translucent or masked material's cut-out: its opaque coverage, and against each --mask texture's own coverage
 * when given (a card whose coverage is 1 under a real mask is a solid rectangle). Output derives from a licensed
 * pack: keep it out of the repo. Exit 0 always; read the table.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { NodeIO } from "@gltf-transform/core";

import { auditCutout, measureAgainstAlbedo, opacityCoverage, uvCoverage, type AlbedoSource } from "../src/unreal/albedo-fidelity.js";
import { renderTiles } from "../src/unreal/contact-sheet.js";
import { decodeRgba } from "../src/unreal/image-diff.js";

const args = process.argv.slice(2);
const values = (name: string): string[] => args.flatMap((arg, i) => (arg === name && args[i + 1] ? [args[i + 1]!] : []));
const importDir = values("--import")[0];
if (!importDir) {
  console.error("usage: albedo-fidelity.ts --import <import output dir> [--mask <mask.png>]... [--out <file.json>] [--only <name part>] [--tile <px>]");
  process.exit(2);
}
const report = JSON.parse(readFileSync(join(importDir, "import-report.json"), "utf8")) as { models: { name: string; glb: string }[] };
const masks = await Promise.all(values("--mask").map(async (path) => ({ path, image: await decodeRgba(readFileSync(path)) })));
const io = new NodeIO();
const only = values("--only")[0];
const models = report.models.filter((model) => !only || model.name.includes(only));
const glbPaths = models.map((model) => join(resolve(importDir), model.glb));
// A bigger tile shrinks the share of antialiased silhouette pixels, which blend the piece with the grey tile.
const { tiles } = await renderTiles({ glbPaths, tile: Number(values("--tile")[0] ?? 512) });

const rows = [];
for (const [index, model] of models.entries()) {
  const document = await io.read(glbPaths[index]!);
  const sources: AlbedoSource[] = [];
  const cutouts = [];
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const material = primitive.getMaterial();
      const bytes = material?.getBaseColorTexture()?.getImage();
      if (!material || !bytes) continue;
      const image = await decodeRgba(bytes);
      const [r, g, b] = material.getBaseColorFactor();
      const uv = primitive.getAttribute("TEXCOORD_0")?.getArray();
      sources.push({
        image,
        weight: (primitive.getIndices()?.getCount() ?? 3) / 3,
        factor: [r, g, b],
        ...(uv ? { coverage: uvCoverage(uv, primitive.getIndices()?.getArray() ?? undefined) } : {}),
      });
      if (material.getAlphaMode() !== "OPAQUE") {
        cutouts.push({
          material: material.getName(),
          alphaMode: material.getAlphaMode(),
          ...auditCutout(image, masks[0]?.image),
          ...(masks.length > 1 ? { maskCoverages: masks.map((mask) => ({ mask: mask.path, coverage: opacityCoverage(mask.image, "red") })) } : {}),
        });
      }
    }
  }
  const colour = measureAgainstAlbedo(sources, tiles[index]!);
  rows.push({ name: model.name, colour, cutouts });
}
console.table(
  rows.map((row) => ({
    name: row.name,
    score: row.colour.comparable ? Math.round(row.colour.score) : "-",
    hueEmd: row.colour.comparable ? Math.round(row.colour.hueEmdDegrees) : "-",
    sat: row.colour.comparable ? Number(row.colour.saturationRatio.toFixed(2)) : "-",
    verdict: row.colour.verdict,
    light: row.colour.comparable ? Number(row.colour.lightnessRatio.toFixed(2)) : "-",
    cards: row.cutouts.length,
    cardCoverage: row.cutouts.length ? Number((row.cutouts.reduce((s, c) => s + c.coverage, 0) / row.cutouts.length).toFixed(2)) : "-",
    solidCards: row.cutouts.filter((c) => c.solidCard).length,
  })),
);
const compared = rows.filter((row) => row.colour.comparable);
console.log(
  `models=${rows.length} compared=${compared.length} meanScore=${compared.length ? (compared.reduce((s, r) => s + r.colour.score, 0) / compared.length).toFixed(1) : "-"} ` +
    `cards=${rows.reduce((s, r) => s + r.cutouts.length, 0)} solidCards=${rows.reduce((s, r) => s + r.cutouts.filter((c) => c.solidCard).length, 0)}`,
);
const out = values("--out")[0];
if (out) writeFileSync(out, JSON.stringify(rows, null, 1));
