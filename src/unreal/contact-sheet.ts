import { createServer, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, dirname, extname, join, normalize } from "node:path";

import { chromium } from "playwright";
import sharp, { type OverlayOptions } from "sharp";

import { createBrowserTempDir } from "../browser-temp.js";
import { colourSimilarity, decodeRgba, type RgbaImage } from "./image-diff.js";
import { judgeRender, type JudgeStats, type Verdict } from "./visual-judge.js";

const require = createRequire(import.meta.url);
const THREE_ROOT = dirname(dirname(require.resolve("three")));

const MAX_SHEET_WIDTH = 1800;
const HEADER = 30;
const CAPTION = 84;
const BACKGROUND = { r: 128, g: 128, b: 128 };
const PANEL = { r: 30, g: 31, b: 36 };

export interface ContactSheetOptions {
  /** One imported GLB per entry; the file name (without `.glb`) is the tile label. */
  glbPaths: readonly string[];
  outPath: string;
  title: string;
  subtitle?: string;
  /** The listing's own gallery image (JPEG/PNG/WebP bytes), shown on the left. */
  galleryImage?: Buffer;
  /** Default 12. */
  maxMeshes?: number;
  /** Tile edge in pixels. Default 320. */
  tile?: number;
  /** `largest` (default) takes the biggest by bounding-box volume; `spread` samples the volume ranking evenly. */
  selection?: "largest" | "spread";
  timeoutMs?: number;
  /**
   * Unreal editor thumbnails (PNG/JPEG bytes) keyed by GLB path relative to the output directory, as
   * `findThumbnails` returns them. When given, only pieces with a thumbnail are drawn, each as an
   * ORIGINAL | AFTER IMPORT pair, and the gallery image shrinks to a header reference.
   */
  thumbnails?: ReadonlyMap<string, Buffer>;
  /** GLB keys (same form as `thumbnails`) whose report says they have coloured or textured sections. */
  expectColoured?: ReadonlySet<string>;
}

export interface TileJudgement {
  /** Index of the tile in the sheet, row-major. */
  tile: number;
  glb: string;
  name: string;
  verdict: Verdict;
  reasons: string[];
  /** Pixel statistics the verdict was drawn from; absent for a tile that failed to load. */
  stats?: JudgeStats;
  /** Colour similarity (0..1) to the Unreal thumbnail; absent without a comparable thumbnail. */
  similarity?: number;
  /** Distance between the mean Lab colours of the thumbnail's and the render's object pixels. */
  meanColourDelta?: number;
}

export interface ContactSheetResult {
  outPath: string;
  bytes: number;
  /** Tiles that rendered a model. */
  meshesRendered: number;
  /** GLBs offered, before selection. */
  meshesTotal: number;
  /** Tiles that were attempted and showed "load failed". */
  meshesFailed: number;
  galleryIncluded: boolean;
  /** One entry per drawn tile. */
  judge: TileJudgement[];
  judgeSummary: { ok: number; suspect: number; fail: number };
  /** Pieces drawn with an Unreal thumbnail beside them. */
  thumbnailsShown: number;
}

interface Candidate {
  path: string;
  name: string;
  /** Bounding-box volume with flat extents floored; -1 when the file could not be read. */
  score: number;
  failed: boolean;
  /** The Unreal thumbnail for this piece, when thumbnails were given. */
  thumbnail?: Buffer | undefined;
  expectColoured?: boolean;
}

/** GLB keys whose report entry has a textured or graph-baked section (so the render must not be white). */
export function colouredGlbKeys(report: {
  readonly models: readonly { readonly glb: string; readonly materials: readonly { readonly textured: boolean }[] }[];
}): Set<string> {
  return new Set(report.models.filter((m) => m.materials.some((section) => section.textured)).map((m) => m.glb));
}

/** The value of `map` whose key is `path` or a trailing path segment run of it. */
function lookup<T>(map: ReadonlyMap<string, T> | undefined, path: string): T | undefined {
  if (map === undefined) return undefined;
  const normal = path.split("\\").join("/");
  for (const [key, value] of map) {
    if (normal === key || normal.endsWith(`/${key}`)) return value;
  }
  return undefined;
}

/** Bounds from the POSITION accessors' min/max in the GLB's JSON chunk; no geometry is decoded. */
export async function glbBoundsScore(path: string): Promise<number> {
  const buffer = await readFile(path);
  if (buffer.length < 20 || buffer.readUInt32LE(0) !== 0x46546c67) return -1;
  const jsonLength = buffer.readUInt32LE(12);
  if (buffer.readUInt32LE(16) !== 0x4e4f534a || 20 + jsonLength > buffer.length) return -1;
  const json = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString("utf8")) as {
    meshes?: { primitives?: { attributes?: { POSITION?: number } }[] }[];
    accessors?: { min?: number[]; max?: number[] }[];
  };
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      const index = primitive.attributes?.POSITION;
      const accessor = index === undefined ? undefined : json.accessors?.[index];
      if (accessor?.min?.length !== 3 || accessor.max?.length !== 3) continue;
      for (let axis = 0; axis < 3; axis++) {
        lo[axis] = Math.min(lo[axis]!, accessor.min[axis]!);
        hi[axis] = Math.max(hi[axis]!, accessor.max[axis]!);
      }
    }
  }
  const extent = lo.map((value, axis) => hi[axis]! - value);
  const longest = Math.max(...extent);
  if (!Number.isFinite(longest) || longest <= 1e-9) return 0;
  // A textured quad has zero volume but is not degenerate: floor each extent at 1% of the longest.
  return extent.reduce((volume, value) => volume * Math.max(value, longest * 0.01), 1);
}

function select(
  candidates: readonly Candidate[],
  maxMeshes: number,
  selection: "largest" | "spread",
): Candidate[] {
  const valid = candidates.filter((c) => !c.failed && c.score > 0).sort((a, b) => b.score - a.score);
  const failed = candidates.filter((c) => c.failed);
  let picked: Candidate[];
  if (selection === "spread" && valid.length > maxMeshes && maxMeshes > 1) {
    picked = Array.from(
      { length: maxMeshes },
      (_, i) => valid[Math.round((i * (valid.length - 1)) / (maxMeshes - 1))]!,
    );
  } else {
    picked = valid.slice(0, maxMeshes);
  }
  return [...picked, ...failed.slice(0, Math.max(0, maxMeshes - picked.length))];
}

function serve(response: ServerResponse, bytes: Uint8Array, type: string): void {
  response.writeHead(200, { "content-type": type, "content-length": bytes.byteLength });
  response.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
}

function pageHtml(tileSize: number, count: number, columns: number, rows: number): string {
  const payload = JSON.stringify({ tile: tileSize, count, columns, rows });
  return `<!doctype html><html><body>
<script type="importmap">{"imports":{"three":"/three.module.js","three/addons/":"/jsm/"}}</script>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
const options = ${payload};
const size = options.tile;
try {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(size, size);
  renderer.setClearColor(0x808080, 1);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x808080);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2.2));
  const light = new THREE.DirectionalLight(0xffffff, 2.4);
  light.position.set(2, 4, 3);
  scene.add(light);
  const camera = new THREE.PerspectiveCamera(40, 1, 0.001, 100000);
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const sheet = document.createElement('canvas');
  sheet.width = size * options.columns; sheet.height = size * options.rows;
  const context = sheet.getContext('2d');
  context.fillStyle = '#808080'; context.fillRect(0, 0, sheet.width, sheet.height);
  const tiles = [];
  const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
  const dispose = (root) => root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    for (const m of [].concat(o.material || [])) {
      for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
      m.dispose();
    }
  });
  for (let i = 0; i < options.count; i++) {
    try {
      const gltf = await Promise.race([loader.loadAsync('/glb/' + i + '.glb'), timeout(30000)]);
      const model = gltf.scene;
      scene.add(model);
      model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model);
      if (box.isEmpty()) { scene.remove(model); dispose(model); tiles.push({ ok: false, error: 'empty' }); continue; }
      const center = box.getCenter(new THREE.Vector3());
      const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-6);
      const distance = (radius / Math.sin((camera.fov * Math.PI) / 360)) * 1.05;
      const direction = new THREE.Vector3(1, 0.75, 1.2).normalize();
      camera.position.copy(center).addScaledVector(direction, distance);
      camera.near = distance / 100; camera.far = distance * 10; camera.updateProjectionMatrix();
      camera.lookAt(center);
      renderer.render(scene, camera);
      context.drawImage(renderer.domElement, (i % options.columns) * size, Math.floor(i / options.columns) * size);
      scene.remove(model); dispose(model);
      tiles.push({ ok: true });
    } catch (error) {
      tiles.push({ ok: false, error: String(error && error.message || error) });
    }
  }
  window.__result = { ok: true, tiles, dataUrl: sheet.toDataURL('image/png') };
} catch (error) {
  window.__result = { ok: false, error: String(error) };
}
</script></body></html>`;
}

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

interface RenderedGrid {
  png: Buffer;
  rendered: boolean[];
}

async function renderGrid(
  selected: readonly Candidate[],
  tile: number,
  columns: number,
  rows: number,
  timeoutMs: number,
): Promise<RenderedGrid> {
  const html = Buffer.from(pageHtml(tile, selected.length, columns, rows), "utf8");
  const server = createServer((request, response) => {
    const url = (request.url ?? "/").split("?")[0]!;
    const glb = /^\/glb\/(\d+)\.glb$/.exec(url);
    const send = (read: Promise<Uint8Array>, type: string) =>
      read.then(
        (bytes) => serve(response, bytes, type),
        () => {
          response.writeHead(404);
          response.end();
        },
      );
    if (url === "/" || url === "/index.html") serve(response, html, "text/html");
    else if (glb && selected[Number(glb[1])]) {
      void send(readFile(selected[Number(glb[1])]!.path), "model/gltf-binary");
    } else if (url.startsWith("/jsm/")) {
      void send(
        readFile(join(THREE_ROOT, "examples", "jsm", normalize(url.slice(5)))),
        "text/javascript",
      );
    } else if (/^\/three[\w.-]*\.js$/.test(url)) {
      void send(readFile(join(THREE_ROOT, "build", basename(url))), "text/javascript");
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let temp: Awaited<ReturnType<typeof createBrowserTempDir>> | undefined;
  try {
    temp = await createBrowserTempDir();
    browser = await chromium.launch({
      headless: true,
      env: { ...process.env, ...temp.env },
      args: [
        "--no-sandbox",
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        "--ignore-gpu-blocklist",
      ],
    });
    const page = await browser.newPage({ viewport: { width: tile, height: tile } });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/`, { timeout: timeoutMs });
    await page.waitForFunction(
      () => Boolean((window as unknown as { __result?: unknown }).__result),
      null,
      { timeout: timeoutMs },
    );
    const raw = (await page.evaluate(
      () => (window as unknown as { __result: unknown }).__result,
    )) as { ok: boolean; error?: string; tiles?: { ok: boolean }[]; dataUrl?: string };
    if (!raw.ok || raw.dataUrl === undefined) {
      throw new Error(`contact sheet render failed: ${raw.error ?? pageErrors.join("; ")}`);
    }
    return {
      png: Buffer.from(raw.dataUrl.split(",")[1] ?? "", "base64"),
      rendered: (raw.tiles ?? []).map((entry) => entry.ok),
    };
  } finally {
    await browser?.close().catch(() => undefined);
    await temp?.remove().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Raw RGBA of one tile cut out of the decoded grid. */
function cutTile(grid: RgbaImage, tile: number, column: number, row: number): RgbaImage {
  const data = new Uint8Array(tile * tile * 4);
  for (let y = 0; y < tile; y++) {
    const from = ((row * tile + y) * grid.width + column * tile) * 4;
    data.set(grid.data.subarray(from, from + tile * 4), y * tile * 4);
  }
  return { width: tile, height: tile, data };
}

const PAIR_CAPTION = 46;
const REFERENCE_BAND = 132;
const VERDICT_COLOUR: Record<Verdict, string> = { ok: "#3ddc84", suspect: "#ffc233", fail: "#ff4d4d" };

/**
 * One comparison sheet. Without thumbnails: the listing's gallery image on the left, neutral three.js
 * renders of the imported GLBs on the right. With thumbnails: for each piece that has one, the Unreal
 * editor thumbnail ("ORIGINAL") immediately beside our render ("AFTER IMPORT"), the gallery image
 * shrunk to a reference in the header, and a colour similarity on each tile. Every rendered tile is
 * also run through the automatic visual judge (`judgeRender`) and wears a verdict dot. Writes a JPEG
 * and reports what it drew.
 */
export async function renderContactSheet(
  options: ContactSheetOptions,
): Promise<ContactSheetResult> {
  const tile = Math.max(64, Math.round(options.tile ?? 320));
  const maxMeshes = Math.max(1, Math.round(options.maxMeshes ?? 12));
  const timeoutMs = options.timeoutMs ?? 180_000;
  const meshesTotal = options.glbPaths.length;
  const withThumbnails = options.thumbnails !== undefined;

  const all: Candidate[] = await Promise.all(
    options.glbPaths.map(async (path) => {
      const name = basename(path, extname(path));
      const thumbnail = lookup(options.thumbnails, path);
      const expectColoured = [...(options.expectColoured ?? [])].some((key) => path.split("\\").join("/").endsWith(`/${key}`) || path === key);
      try {
        const score = await glbBoundsScore(path);
        return { path, name, score, failed: score < 0, thumbnail, expectColoured };
      } catch {
        return { path, name, score: -1, failed: true, thumbnail, expectColoured };
      }
    }),
  );
  const candidates = withThumbnails ? all.filter((c) => c.thumbnail !== undefined) : all;
  const selected = select(candidates, maxMeshes, options.selection ?? "largest");

  const count = selected.length;
  const columns = withThumbnails
    ? count <= 1 ? 1 : count <= 4 ? 2 : 3
    : count <= 1 ? 1 : count <= 4 ? 2 : count <= 9 ? 3 : 4;
  const rows = Math.max(1, Math.ceil(count / columns));
  const cellWidth = withThumbnails ? tile * 2 : tile;
  const gridWidth = count === 0 ? Math.round(tile * 1.2) : columns * cellWidth;
  const bodyHeight = rows * tile;

  let rendered: boolean[] = [];
  let gridPng: Buffer | undefined;
  const loadable = selected.filter((c) => !c.failed);
  if (loadable.length > 0) {
    // Failed candidates are not sent to the browser; keep their cells blank in place.
    const grid = await renderGrid(selected.map((c) => (c.failed ? { ...c, path: "" } : c)), tile, columns, rows, timeoutMs);
    gridPng = grid.png;
    rendered = grid.rendered.map((ok, index) => ok && !selected[index]!.failed);
  }
  const meshesRendered = rendered.filter(Boolean).length;
  const meshesFailed = count - meshesRendered;

  // Judge each rendered tile; with a thumbnail, also measure colour similarity to it.
  const judge: TileJudgement[] = [];
  const thumbnailTiles: (Buffer | undefined)[] = [];
  const decodedGrid: RgbaImage | undefined =
    gridPng === undefined
      ? undefined
      : await sharp(gridPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true }).then(
          ({ data, info }) => ({ width: info.width, height: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) }),
        );
  for (const [index, candidate] of selected.entries()) {
    const glb = candidate.path;
    if (!rendered[index] || decodedGrid === undefined) {
      judge.push({ tile: index, glb, name: candidate.name, verdict: "fail", reasons: ["load failed"] });
      thumbnailTiles.push(undefined);
      continue;
    }
    const pixels = cutTile(decodedGrid, tile, index % columns, Math.floor(index / columns));
    let similarity: number | undefined;
    let meanColourDelta: number | undefined;
    if (candidate.thumbnail !== undefined) {
      try {
        const reference = await decodeRgba(candidate.thumbnail);
        const comparison = colourSimilarity(reference, pixels);
        if (comparison.comparable) {
          similarity = comparison.similarity;
          meanColourDelta = comparison.meanColourDelta;
        }
        thumbnailTiles.push(
          await sharp(candidate.thumbnail).removeAlpha().resize({ width: tile, height: tile, fit: "contain", background: PANEL }).png().toBuffer(),
        );
      } catch {
        thumbnailTiles.push(undefined);
      }
    } else {
      thumbnailTiles.push(undefined);
    }
    const result = judgeRender(pixels, {
      ...(candidate.expectColoured ? { expectColoured: true } : {}),
      ...(similarity !== undefined ? { colourSimilarity: similarity } : {}),
    });
    judge.push({
      tile: index,
      glb,
      name: candidate.name,
      verdict: result.verdict,
      reasons: result.reasons,
      stats: result.stats,
      ...(similarity !== undefined && meanColourDelta !== undefined ? { similarity, meanColourDelta } : {}),
    });
  }
  const judgeSummary = {
    ok: judge.filter((j) => j.verdict === "ok").length,
    suspect: judge.filter((j) => j.verdict === "suspect").length,
    fail: judge.filter((j) => j.verdict === "fail").length,
  };

  // Gallery image: a left panel without thumbnails, a small header reference with them.
  let galleryPanel: Buffer | undefined;
  let galleryWidth = withThumbnails ? 0 : Math.round(tile * 1.5);
  let galleryHeight = withThumbnails ? 0 : bodyHeight;
  if (options.galleryImage !== undefined) {
    try {
      const maxWidth = withThumbnails ? 240 : Math.min(Math.round(tile * 1.7), MAX_SHEET_WIDTH - gridWidth);
      const resized = await sharp(options.galleryImage)
        .rotate()
        .resize({
          width: withThumbnails ? maxWidth : Math.max(160, maxWidth),
          height: withThumbnails ? REFERENCE_BAND - 12 : bodyHeight,
          fit: "inside",
          withoutEnlargement: false,
        })
        .removeAlpha()
        .png()
        .toBuffer({ resolveWithObject: true });
      galleryPanel = resized.data;
      galleryWidth = withThumbnails ? 0 : resized.info.width;
      galleryHeight = resized.info.height;
    } catch {
      galleryPanel = undefined;
    }
  }

  const header = withThumbnails ? REFERENCE_BAND : HEADER;
  const caption = withThumbnails ? CAPTION + 14 : CAPTION;
  const width = Math.max(galleryWidth + gridWidth, withThumbnails ? 760 : 0);
  const height = header + bodyHeight + caption;
  const gridLeft = galleryWidth;
  const text = (x: number, y: number, size: number, fill: string, value: string, extra = "") =>
    `<text x="${x}" y="${y}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${size}" fill="${fill}" ${extra}>${escapeXml(value)}</text>`;
  const svg: string[] = [];
  if (withThumbnails) {
    const referenceLeft = galleryPanel === undefined ? 10 : 10 + 240 + 12;
    svg.push(
      text(referenceLeft, 28, 15, "#e8e8ee", clip(options.title, 70), 'font-weight="bold"'),
      ...(options.subtitle !== undefined ? [text(referenceLeft, 50, 12, "#c8c8d4", clip(options.subtitle, 110))] : []),
      text(referenceLeft, 74, 12, "#9a9aaa", galleryPanel === undefined ? "no gallery image" : "Fab gallery image at left: reference only, a lit full scene"),
      text(referenceLeft, 94, 12, "#9a9aaa", "Each tile: ORIGINAL = Unreal editor thumbnail of that asset | AFTER IMPORT = our GLB, neutral light."),
      text(referenceLeft, 112, 12, "#9a9aaa", "Colour similarity compares object colour only (camera and lighting differ). It is not a match score."),
    );
  } else {
    svg.push(
      text(10, 20, 14, "#e8e8ee", "ORIGINAL (Fab gallery image)", 'font-weight="bold"'),
      text(galleryWidth + 10, 20, 14, "#e8e8ee", `AFTER IMPORT (${meshesRendered}/${meshesTotal} meshes rendered)`, 'font-weight="bold"'),
    );
    if (galleryPanel === undefined) {
      const note = options.galleryImage === undefined ? "no gallery image" : "gallery image unreadable";
      svg.push(text(galleryWidth / 2, header + bodyHeight / 2, 16, "#aab", note, 'text-anchor="middle"'));
    }
  }
  if (count === 0) {
    svg.push(
      text(gridLeft + gridWidth / 2, header + bodyHeight / 2, 18, "#e8e8ee", withThumbnails ? "no pieces with an Unreal thumbnail" : "no meshes", 'text-anchor="middle"'),
    );
  }
  const layers: OverlayOptions[] = [];
  selected.forEach((candidate, index) => {
    const cellX = gridLeft + (index % columns) * cellWidth;
    const y = header + Math.floor(index / columns) * tile;
    const x = withThumbnails ? cellX + tile : cellX; // the render's own tile
    const entry = judge[index]!;
    if (withThumbnails) {
      const thumbnail = thumbnailTiles[index];
      if (thumbnail !== undefined) layers.push({ input: thumbnail, left: cellX, top: y });
      svg.push(
        `<rect x="${cellX}" y="${y}" width="${tile}" height="18" fill="#000" fill-opacity="0.6"/>`,
        text(cellX + 5, y + 13, 11, "#fff", "ORIGINAL (Unreal editor thumbnail)", 'font-weight="bold"'),
        `<rect x="${x}" y="${y}" width="${tile}" height="18" fill="#000" fill-opacity="0.6"/>`,
        text(x + 5, y + 13, 11, "#fff", "AFTER IMPORT", 'font-weight="bold"'),
        `<rect x="${cellX}" y="${y}" width="${tile * 2}" height="${tile}" fill="none" stroke="#000" stroke-width="2"/>`,
      );
    }
    if (!rendered[index]) {
      svg.push(text(x + tile / 2, y + tile / 2, 16, "#fff", "load failed", 'text-anchor="middle"'));
    }
    const strip = withThumbnails ? PAIR_CAPTION : 36;
    svg.push(
      `<rect x="${x}" y="${y + tile - strip}" width="${tile}" height="${strip}" fill="#000" fill-opacity="0.6"/>`,
      text(x + 6, y + tile - strip + 14, 12, "#fff", clip(candidate.name, Math.floor(tile / 7) - 5), 'font-weight="bold"'),
      `<circle cx="${x + tile - 12}" cy="${y + tile - strip + 10}" r="6" fill="${VERDICT_COLOUR[entry.verdict]}" stroke="#000" stroke-width="1"/>`,
    );
    let line = y + tile - strip + 28;
    if (withThumbnails) {
      const similarityText =
        entry.similarity === undefined
          ? "colour similarity n/a"
          : `colour similarity ${entry.similarity.toFixed(2)} (dE ${entry.meanColourDelta!.toFixed(0)})`;
      svg.push(text(x + 6, line, 11, "#dfe6ff", similarityText));
      line += 13;
    }
    const reason = entry.reasons[0];
    svg.push(
      text(x + 6, line, 10, entry.verdict === "ok" ? "#9fe6b8" : "#ffe08a", clip(reason ?? `${entry.verdict}`, Math.floor(tile / 5.6) - 2)),
    );
  });
  const bottom = header + bodyHeight;
  svg.push(
    text(10, bottom + 30, 20, "#ffffff", clip(options.title, Math.floor(width / 11)), 'font-weight="bold"'),
  );
  if (options.subtitle !== undefined) {
    svg.push(text(10, bottom + 56, 14, "#c8c8d4", clip(options.subtitle, Math.floor(width / 7.5))));
  }
  const selectedNote =
    meshesTotal > count
      ? `showing ${count} of ${meshesTotal} meshes (${withThumbnails ? "with an Unreal thumbnail, " : ""}${options.selection ?? "largest"})`
      : `${meshesTotal} meshes`;
  svg.push(text(10, bottom + 76, 12, "#9a9aaa", `${selectedNote}; ${meshesFailed} not rendered`));
  svg.push(
    text(
      10,
      bottom + 92,
      12,
      "#9a9aaa",
      `visual judge: ${judgeSummary.ok} ok, ${judgeSummary.suspect} suspect, ${judgeSummary.fail} fail (green, amber, red dot)`,
    ),
  );

  if (galleryPanel !== undefined) {
    layers.push(
      withThumbnails
        ? { input: galleryPanel, left: 10, top: 6 }
        : { input: galleryPanel, left: 0, top: header + Math.floor((bodyHeight - galleryHeight) / 2) },
    );
  }
  if (gridPng !== undefined) {
    if (withThumbnails) {
      // The browser grid is `columns` tiles wide; move each render beside its thumbnail.
      for (let index = 0; index < count; index++) {
        if (!rendered[index]) continue;
        const input = await sharp(gridPng)
          .extract({ left: (index % columns) * tile, top: Math.floor(index / columns) * tile, width: tile, height: tile })
          .png()
          .toBuffer();
        layers.push({ input, left: gridLeft + (index % columns) * cellWidth + tile, top: header + Math.floor(index / columns) * tile });
      }
    } else {
      layers.push({ input: gridPng, left: gridLeft, top: header });
    }
  } else if (count > 0 && !withThumbnails) {
    layers.push({
      input: await sharp({ create: { width: gridWidth, height: bodyHeight, channels: 3, background: BACKGROUND } }).png().toBuffer(),
      left: gridLeft,
      top: header,
    });
  }
  layers.push({
    input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${svg.join("")}</svg>`),
    left: 0,
    top: 0,
  });
  let image = sharp({ create: { width, height, channels: 3, background: PANEL } }).composite(layers);
  if (width > MAX_SHEET_WIDTH) {
    image = sharp(await image.png().toBuffer()).resize({ width: MAX_SHEET_WIDTH });
  }
  const jpeg = await image.jpeg({ quality: 82 }).toBuffer();
  await mkdir(dirname(options.outPath), { recursive: true });
  await writeFile(options.outPath, jpeg);
  return {
    outPath: options.outPath,
    bytes: jpeg.byteLength,
    meshesRendered,
    meshesTotal,
    meshesFailed,
    galleryIncluded: galleryPanel !== undefined,
    judge,
    judgeSummary,
    thumbnailsShown: thumbnailTiles.filter((t) => t !== undefined).length,
  };
}
