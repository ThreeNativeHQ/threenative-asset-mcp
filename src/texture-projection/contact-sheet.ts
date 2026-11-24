import { readFile } from "node:fs/promises";
import { join } from "node:path";

import sharp from "sharp";

import { runDirectory, type StoredRun } from "./runs.js";

/**
 * The review sheet `texture_project_inspect` returns: one row per view with the clay render, the
 * model's image and the composite actually projected, so a host can judge the bake by eye without a
 * browser. A rejected view is labelled with its reason and shows whatever it saved.
 */
const PANEL = 192;
const GAP = 8;
const LABEL = 18;
const HEADER = 46;
const MAX_ROWS = 9;

const PLACEHOLDER = (): Promise<Buffer> =>
  sharp({ create: { width: PANEL, height: PANEL, channels: 3, background: { r: 34, g: 34, b: 38 } } })
    .png()
    .toBuffer();

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/gu, (character) => `&#${character.charCodeAt(0)};`);
}

/** Which views the sheet shows: every rejected one, then the run's own order up to `MAX_ROWS`. */
function chooseRows(run: StoredRun): StoredRun["views"] {
  const rejected = run.views.filter((view) => view.rejected !== undefined);
  const rest = run.views.filter((view) => view.rejected === undefined);
  return [...rejected, ...rest].slice(0, MAX_ROWS).sort((a, b) => a.index - b.index);
}

export interface ContactSheet {
  readonly png: Buffer;
  readonly path: string;
  readonly views: readonly number[];
}

export async function buildContactSheet(runRoot: string, run: StoredRun, summary: string): Promise<ContactSheet> {
  const rows = chooseRows(run);
  const width = 2 * GAP + 3 * (PANEL + GAP);
  const height = HEADER + rows.length * (PANEL + LABEL + GAP) + GAP;
  const texts: string[] = [
    `<text x="${GAP}" y="24" font-family="Helvetica, Arial, sans-serif" font-size="15" fill="#e8e8ea">${escapeXml(`run ${run.runId} · ${run.level} · atlas ${run.atlas}px · ${summary}`)}</text>`,
  ];
  const layers: { input: Buffer; left: number; top: number }[] = [];
  let imageIndex = 0;
  const placeholder = await PLACEHOLDER();
  for (const [row, view] of rows.entries()) {
    const top = HEADER + row * (PANEL + LABEL + GAP);
    const directory = runDirectory(runRoot, run.runId);
    const rowLabel = `view ${view.index}${view.spec.kind ? ` · ${view.spec.kind}` : ""}${
      view.rejected ? ` · rejected: ${view.rejected}` : ""
    }${view.structureDeviation === undefined ? "" : ` · structure ${view.structureDeviation.toFixed(2)}`}`;
    texts.push(
      `<text x="${GAP}" y="${top + PANEL + 13}" font-family="Helvetica, Arial, sans-serif" font-size="12" fill="${
        view.rejected ? "#ffb4a2" : "#c9c9ce"
      }">${escapeXml(rowLabel)}</text>`,
    );
    for (const [column, file] of ["clay", "gen", "comp"].entries()) {
      const left = GAP + column * (PANEL + GAP);
      let panel = placeholder;
      try {
        panel = await sharp(await readFile(join(directory, `view_${view.index}_${file}.png`)))
          .resize(PANEL, PANEL, { fit: "cover" })
          .png()
          .toBuffer();
      } catch {
        // a rejected view has no images; its placeholder keeps the row aligned
      }
      layers.push({ input: panel, left, top });
      texts.push(
        `<text x="${left + 4}" y="${top + 14}" font-family="Helvetica, Arial, sans-serif" font-size="11" fill="#f2f2f4">${escapeXml(file)}</text>`,
      );
      imageIndex += 1;
    }
  }
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${texts.join("")}</svg>`;
  const png = await sharp({ create: { width, height, channels: 3, background: { r: 22, g: 22, b: 26 } } })
    .composite([...layers, { input: Buffer.from(svg), left: 0, top: 0 }])
    .png()
    .toBuffer();
  const path = join(runDirectory(runRoot, run.runId), "contact_sheet.png");
  await sharp(png).toFile(path);
  return { png, path, views: rows.map((view) => view.index) };
}

/** A projected GLB with no stored run: its painted atlas is the one picture there is to review. */
export async function buildAtlasSheet(image: Uint8Array | undefined, summary: string): Promise<Buffer> {
  const width = 2 * GAP + PANEL + GAP;
  const height = HEADER + PANEL + LABEL + 2 * GAP;
  const layers: { input: Buffer; left: number; top: number }[] = [];
  if (image) {
    layers.push({
      input: await sharp(Buffer.from(image)).resize(PANEL, PANEL, { fit: "cover" }).png().toBuffer(),
      left: GAP,
      top: HEADER,
    });
  }
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <text x="${GAP}" y="24" font-family="Helvetica, Arial, sans-serif" font-size="15" fill="#e8e8ea">${escapeXml(summary)}</text>
    <text x="${GAP}" y="${HEADER + PANEL + 13}" font-family="Helvetica, Arial, sans-serif" font-size="12" fill="#c9c9ce">painted atlas</text>
  </svg>`;
  return sharp({ create: { width, height, channels: 3, background: { r: 22, g: 22, b: 26 } } })
    .composite([...layers, { input: Buffer.from(svg), left: 0, top: 0 }])
    .png()
    .toBuffer();
}
