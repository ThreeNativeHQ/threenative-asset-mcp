/**
 * Unity import fidelity (PRD-617): scores an import against a Unity reference picture with the engine-neutral
 * judge and tile renderer of `src/unreal/`, and writes the reference | after sheet.
 *
 * Two references, strongest first (epic README):
 *  - `R1`: a Unity Editor batch render (`scripts/unity/ReferenceRender.cs`): `bounds.json` plus one PNG per
 *    prefab, fixed camera and light. It also carries each prefab's world size, which `checkSize` compares.
 *  - `R2`: `<guid>/preview.png` inside the `.unitypackage`, the Editor's own thumbnail.
 *
 * Only the camera-robust scores count (hue, saturation, silhouette fill; lightness weakly), as for Unreal.
 *
 * R2 channel order and gamma. A `preview.png` is a PNG file, so unlike Unreal's raw editor thumbnails (stored
 * red/blue swapped in UE4) its channel order is fixed by the format and `sharp` decodes it correctly. Nothing
 * proves that the Editor wrote it that way, and no real preview was available when this was written, so the
 * code does not assume it: after the first pass it re-scores every piece with red and blue exchanged
 * (`decideChannelOrder`) and swaps the whole package only when that is overwhelming evidence. The PNG's own
 * gamma, sRGB and ICC chunks are recorded (`inspectPng`) and not applied, because the judge reads sRGB pixels
 * on both sides. Both points stay UNVERIFIED until a real package preview is measured.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

import { renderContactSheet, type TileJudgement } from "../unreal/contact-sheet.js";
import { decodeRgba } from "../unreal/image-diff.js";
import { swapRedBlue } from "../unreal/package-thumbnail.js";
import { measureFidelity } from "../unreal/render-fidelity.js";
import type { UnityImportReport } from "./importer.js";
import { openUnityPackage } from "./package.js";

export type ReferenceKind = "R1" | "R2";
export const REFERENCE_LABELS: Record<ReferenceKind, string> = { R1: "R1 Unity Editor render", R2: "R2 package preview" };

export interface Size {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** One entry of R1's `bounds.json`, written by `scripts/unity/ReferenceRender.cs`. */
export interface R1Item {
  /** Project path of the rendered prefab (or model). */
  readonly asset: string;
  /** PNG path relative to the reference folder. */
  readonly png: string;
  /** Project paths of the model files the prefab renders (renderers' meshes). */
  readonly models?: readonly string[];
  /** World-space bounds of all renderers, in metres (Unity units). */
  readonly boundsMeters: { readonly size: Size; readonly center?: Size };
}

export interface R1Bounds {
  readonly version: number;
  readonly items: readonly R1Item[];
}

export interface ReferenceImage {
  readonly png: Buffer;
  /** Project path of the asset the picture shows. */
  readonly asset: string;
  readonly bounds?: Size;
}

export interface UnityReferences {
  readonly kind: ReferenceKind;
  /** Keyed by the model's GLB path relative to the import folder, as in the report. */
  readonly images: Map<string, ReferenceImage>;
  /** Models of the report that no reference picture was found for. */
  readonly unmatched: string[];
}

type ReportModelLike = Pick<UnityImportReport["models"][number], "name" | "source" | "glb" | "sizeMeters">;

const stem = (path: string): string => basename(path, extname(path)).toLowerCase();

// ---------------------------------------------------------------- R1

/** R1 item for a model: the one prefab whose only model is it, else the asset of the same name. */
export function matchR1(items: readonly R1Item[], model: ReportModelLike): R1Item | undefined {
  const sorted = [...items].sort((a, b) => (a.asset < b.asset ? -1 : 1));
  return (
    sorted.find((item) => item.models?.length === 1 && item.models[0] === model.source) ??
    sorted.find((item) => stem(item.asset) === model.name.toLowerCase())
  );
}

export async function readR1(directory: string, models: readonly ReportModelLike[]): Promise<UnityReferences> {
  const root = resolve(directory);
  const bounds = JSON.parse(await readFile(join(root, "bounds.json"), "utf8")) as R1Bounds;
  const images = new Map<string, ReferenceImage>();
  const unmatched: string[] = [];
  for (const model of models) {
    const item = matchR1(bounds.items, model);
    if (!item) {
      unmatched.push(model.glb);
      continue;
    }
    images.set(model.glb, { png: await readFile(join(root, item.png)), asset: item.asset, bounds: item.boundsMeters.size });
  }
  return { kind: "R1", images, unmatched };
}

export interface SizeCheck {
  readonly ok: boolean;
  readonly actual: Size;
  readonly expected: Size;
  /** Largest relative error over the axes. */
  readonly worst: number;
}

/** The import's size against R1's bounds. Relative error per axis, with a 1 mm floor for flat pieces. */
export function checkSize(actual: Size, expected: Size, tolerance = 0.01): SizeCheck {
  const relative = (a: number, e: number): number => Math.abs(a - e) / Math.max(Math.abs(e), 0.001);
  const worst = Math.max(relative(actual.x, expected.x), relative(actual.y, expected.y), relative(actual.z, expected.z));
  return { ok: worst <= tolerance, actual, expected, worst };
}

const metres = (size: Size): string => `${size.x.toFixed(2)}x${size.y.toFixed(2)}x${size.z.toFixed(2)} m`;

// ---------------------------------------------------------------- R2

export interface PngInspection {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colorType: number;
  /** `gAMA` as a gamma value (0.45455 is sRGB's), when the chunk exists. */
  readonly gamma?: number;
  readonly srgbChunk: boolean;
  readonly iccProfile: boolean;
}

/** Header facts of a PNG, for the record. Not applied to the pixels (see the module comment). */
export function inspectPng(png: Buffer): PngInspection | undefined {
  if (png.length < 33 || png.readUInt32BE(0) !== 0x89504e47) return undefined;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let gamma: number | undefined;
  let srgbChunk = false;
  let iccProfile = false;
  for (let at = 8; at + 8 <= png.length; ) {
    const length = png.readUInt32BE(at);
    const type = png.toString("latin1", at + 4, at + 8);
    if (type === "IHDR") {
      width = png.readUInt32BE(at + 8);
      height = png.readUInt32BE(at + 12);
      bitDepth = png[at + 16]!;
      colorType = png[at + 17]!;
    } else if (type === "gAMA") gamma = png.readUInt32BE(at + 8) / 100000;
    else if (type === "sRGB") srgbChunk = true;
    else if (type === "iCCP") iccProfile = true;
    else if (type === "IDAT" || type === "IEND") break;
    at += 12 + length;
  }
  return { width, height, bitDepth, colorType, ...(gamma !== undefined ? { gamma } : {}), srgbChunk, iccProfile };
}

/** Previews of the report's models: the model's own, else the prefab of the same name. */
export async function readR2(packagePath: string, models: readonly ReportModelLike[]): Promise<UnityReferences> {
  const database = await openUnityPackage(packagePath);
  try {
    const byPath = new Map([...database.entries.values()].map((entry) => [entry.path, entry]));
    const prefabs = new Map<string, string>();
    for (const entry of [...database.entries.values()].sort((a, b) => (a.path < b.path ? -1 : 1))) {
      if (entry.previewFile && entry.path.toLowerCase().endsWith(".prefab") && !prefabs.has(stem(entry.path))) prefabs.set(stem(entry.path), entry.path);
    }
    const images = new Map<string, ReferenceImage>();
    const unmatched: string[] = [];
    for (const model of models) {
      const own = byPath.get(model.source);
      const prefabPath = prefabs.get(model.name.toLowerCase());
      const entry = own?.previewFile ? own : prefabPath ? byPath.get(prefabPath) : undefined;
      if (!entry?.previewFile) {
        unmatched.push(model.glb);
        continue;
      }
      images.set(model.glb, { png: await readFile(entry.previewFile), asset: entry.path });
    }
    return { kind: "R2", images, unmatched };
  } finally {
    await database.dispose();
  }
}

export interface ChannelDecision {
  readonly order: "rgb" | "bgr";
  readonly evidence: string;
}

/** A piece needs this many points more with red and blue exchanged, and must then be a near-perfect match. */
export const SWAP_MARGIN = 20;
export const SWAP_MIN_SCORE = 85;
export const SWAP_MIN_PIECES = 3;
export const SWAP_MIN_SHARE = 0.75;

/**
 * Decides, per package, whether R2 previews are stored red/blue swapped. The answer is `bgr` only when at least
 * `SWAP_MIN_PIECES` pieces were compared and at least `SWAP_MIN_SHARE` of them gain `SWAP_MARGIN` points and reach
 * `SWAP_MIN_SCORE` with red and blue exchanged. A hue-only error costs about 25 points (a red piece against a blue one
 * still scores about 72), so this cannot wait for a score under 70; it asks for a near-perfect swapped match instead.
 * One wrong colour, or a pack that is wrong everywhere, never matches that well by a swap. Everything else is `rgb`.
 */
export function decideChannelOrder(scores: readonly { readonly asDecoded: number; readonly swapped: number }[]): ChannelDecision {
  if (scores.length < SWAP_MIN_PIECES) return { order: "rgb", evidence: `${scores.length} comparable piece(s): too few to test a swap (need ${SWAP_MIN_PIECES})` };
  const better = scores.filter((s) => s.swapped >= s.asDecoded + SWAP_MARGIN && s.swapped >= SWAP_MIN_SCORE).length;
  const mean = scores.reduce((sum, s) => sum + s.asDecoded, 0) / scores.length;
  const swappedMean = scores.reduce((sum, s) => sum + s.swapped, 0) / scores.length;
  const evidence = `${better}/${scores.length} pieces better swapped; mean ${mean.toFixed(0)} as decoded, ${swappedMean.toFixed(0)} swapped`;
  return { order: better / scores.length >= SWAP_MIN_SHARE ? "bgr" : "rgb", evidence };
}

// ---------------------------------------------------------------- the sheet

export interface UnityPiece extends TileJudgement {
  readonly reference: ReferenceKind;
  readonly sizeCheck?: SizeCheck;
}

export interface UnityFidelityResult {
  readonly reference: ReferenceKind;
  readonly referenceNote: string;
  readonly channelOrder: ChannelDecision | undefined;
  readonly previewInspection: (PngInspection & { readonly asset: string })[];
  readonly unmatched: string[];
  readonly sheet: string;
  readonly pieces: UnityPiece[];
  readonly summary: { readonly compared: number; readonly meanScore: number | undefined; readonly ok: number; readonly suspect: number; readonly fail: number; readonly sizeMismatches: number };
}

export interface UnityFidelityOptions {
  /** An import folder (`models/`, `import-report.json`) made by `importUnityPackage`. */
  readonly importDir: string;
  readonly out: string;
  /** The `.unitypackage` (or folder/UPM) the import came from: the source of R2. */
  readonly packagePath?: string;
  /** R1 folder (`bounds.json` and PNGs). Used instead of R2 when it exists. */
  readonly referenceDir?: string;
  readonly max?: number;
  readonly tile?: number;
}

export async function readImportReport(importDir: string): Promise<UnityImportReport> {
  return JSON.parse(await readFile(join(resolve(importDir), "import-report.json"), "utf8")) as UnityImportReport;
}

/** GLB keys whose bound materials carry a texture (so a flat grey render is wrong). */
function texturedModels(report: UnityImportReport): string[] {
  const textured = new Set(report.materialAssets.filter((material) => material.textures.length > 0).map((material) => material.path));
  return report.models.filter((model) => model.slots.some((slot) => slot.material !== undefined && textured.has(slot.material))).map((model) => model.glb);
}

/** Tile dump names written by `renderContactSheet` (`dumpTilesDir`). */
const dumpStem = (judge: Pick<TileJudgement, "tile" | "name">): string => `${String(judge.tile).padStart(2, "0")}-${judge.name.replace(/[^\w.-]/g, "_")}`;

async function swappedScores(tilesDir: string, judge: readonly TileJudgement[]): Promise<{ asDecoded: number; swapped: number }[]> {
  const found: { asDecoded: number; swapped: number }[] = [];
  for (const piece of judge) {
    if (!piece.fidelity?.comparable) continue;
    const base = join(tilesDir, dumpStem(piece));
    const [reference, render] = await Promise.all([readFile(`${base}.reference.png`), readFile(`${base}.render.png`)]);
    const swapped = measureFidelity(await decodeRgba(await swapRedBlue(reference)), await decodeRgba(render));
    if (swapped.comparable) found.push({ asDecoded: piece.fidelity.score, swapped: swapped.score });
  }
  return found;
}

export async function runUnityFidelity(options: UnityFidelityOptions): Promise<UnityFidelityResult> {
  const importDir = resolve(options.importDir);
  const out = resolve(options.out);
  const report = await readImportReport(importDir);
  const absolute = (key: string): string => join(importDir, key);
  await mkdir(out, { recursive: true });

  let references: UnityReferences;
  let referenceNote: string;
  if (options.referenceDir !== undefined && existsSync(join(resolve(options.referenceDir), "bounds.json"))) {
    references = await readR1(options.referenceDir, report.models);
    referenceNote = "R1: Unity Editor reference render";
  } else if (options.packagePath !== undefined) {
    references = await readR2(options.packagePath, report.models);
    referenceNote =
      options.referenceDir === undefined
        ? "R2: package previews (no R1 folder given)"
        : `R2: package previews (R1 folder ${options.referenceDir} has no bounds.json)`;
  } else {
    throw new Error("A Unity sheet needs a reference: pass the R1 folder with bounds.json, or the package for its R2 previews.");
  }
  const label = REFERENCE_LABELS[references.kind];

  const sizeChecks = new Map<string, SizeCheck>();
  const notes = new Map<string, string>();
  for (const model of report.models) {
    const bounds = references.images.get(model.glb)?.bounds;
    if (!bounds) continue;
    const check = checkSize(model.sizeMeters, bounds);
    sizeChecks.set(model.glb, check);
    if (!check.ok) notes.set(absolute(model.glb), `SIZE ${metres(check.actual)} vs R1 ${metres(check.expected)}`);
  }

  const previewInspection = [...references.images.values()].flatMap((image) => {
    const info = references.kind === "R2" ? inspectPng(image.png) : undefined;
    return info ? [{ asset: image.asset, ...info }] : [];
  });

  const tilesDir = join(out, "tiles");
  const draw = (swapped: ReadonlyMap<string, Buffer> | undefined) =>
    renderContactSheet({
      glbPaths: report.models.map((model) => absolute(model.glb)),
      outPath: join(out, "sheet.jpg"),
      title: `Unity fidelity (${references.kind})`,
      subtitle: `${referenceNote}; ${report.models.length} model(s), importer v${report.importerVersion}`,
      selection: "spread",
      maxMeshes: options.max ?? 36,
      ...(options.tile !== undefined ? { tile: options.tile } : {}),
      thumbnails: new Map([...references.images].map(([glb, image]) => [absolute(glb), swapped?.get(glb) ?? image.png])),
      expectColoured: new Set(texturedModels(report).map(absolute)),
      dumpTilesDir: tilesDir,
      referenceLabel: label,
      tileNotes: notes,
    });
  let result = await draw(undefined);

  let channelOrder: ChannelDecision | undefined;
  if (references.kind === "R2") {
    channelOrder = decideChannelOrder(await swappedScores(tilesDir, result.judge));
    if (channelOrder.order === "bgr") {
      const swapped = new Map<string, Buffer>();
      for (const [glb, image] of references.images) swapped.set(glb, await swapRedBlue(image.png));
      result = await draw(swapped);
      referenceNote += ` (red/blue swapped: ${channelOrder.evidence})`;
    }
  }

  const byGlb = new Map(report.models.map((model) => [absolute(model.glb), model.glb]));
  const pieces: UnityPiece[] = result.judge.map((judge) => {
    const check = sizeChecks.get(byGlb.get(judge.glb) ?? "");
    return { ...judge, reference: references.kind, ...(check ? { sizeCheck: check } : {}) };
  });
  const scores = pieces.flatMap((piece) => (piece.fidelity?.comparable ? [piece.fidelity.score] : []));
  const summary = {
    compared: scores.length,
    meanScore: scores.length > 0 ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : undefined,
    ok: pieces.filter((p) => p.verdict === "ok").length,
    suspect: pieces.filter((p) => p.verdict === "suspect").length,
    fail: pieces.filter((p) => p.verdict === "fail").length,
    sizeMismatches: pieces.filter((p) => p.sizeCheck && !p.sizeCheck.ok).length,
  };
  await writeFile(join(out, "fidelity.json"), `${JSON.stringify(pieces, null, 1)}\n`);
  await writeFile(
    join(out, "reference.json"),
    `${JSON.stringify({ reference: references.kind, note: referenceNote, channelOrder, previewInspection, unmatched: references.unmatched, summary }, null, 1)}\n`,
  );
  return { reference: references.kind, referenceNote, channelOrder, previewInspection, unmatched: references.unmatched, sheet: result.outPath, pieces, summary };
}

/** The per-piece table the PR evidence rule asks for (verdict, score, hue, saturation, fill, size). */
export function unityTable(result: UnityFidelityResult): Record<string, string | number>[] {
  return result.pieces.map((piece) => {
    const f = piece.fidelity?.comparable ? piece.fidelity : undefined;
    return {
      name: piece.name,
      ref: piece.reference,
      verdict: piece.verdict,
      score: f ? Math.round(f.score) : "-",
      hueDeg: f ? Math.round(f.hueEmdDegrees) : "-",
      sat: f ? Number(f.saturationRatio.toFixed(2)) : "-",
      fill: f ? Number(f.densityRatio.toFixed(2)) : "-",
      size: piece.sizeCheck ? (piece.sizeCheck.ok ? "ok" : `OFF ${(piece.sizeCheck.worst * 100).toFixed(1)}%`) : "-",
    };
  });
}

export function summaryLine(result: UnityFidelityResult): string {
  const s = result.summary;
  return (
    `reference=${result.reference} compared=${s.compared} meanScore=${s.meanScore ?? "-"} ok=${s.ok} suspect=${s.suspect} fail=${s.fail}` +
    (result.reference === "R1" ? ` sizeMismatches=${s.sizeMismatches}` : "") +
    (result.unmatched.length > 0 ? ` withoutReference=${result.unmatched.length}` : "")
  );
}
