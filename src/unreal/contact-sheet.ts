import { createServer, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, dirname, extname, join, normalize } from "node:path";

import { chromium } from "playwright";
import sharp, { type OverlayOptions } from "sharp";

import { createBrowserTempDir } from "../browser-temp.js";
import { measureFidelity, withoutFloorShadow, type FidelityMetrics } from "./render-fidelity.js";
import { colourSimilarity, decodeRgba, maskFillRatio, objectMask, type RgbaImage } from "./image-diff.js";
import { judgeRender, type JudgeStats, type Verdict } from "./visual-judge.js";

const require = createRequire(import.meta.url);
const THREE_ROOT = dirname(dirname(require.resolve("three")));

const MAX_SHEET_WIDTH = 1800;
const HEADER = 30;
const CAPTION = 84;
const BACKGROUND = { r: 128, g: 128, b: 128 };
const PANEL = { r: 30, g: 31, b: 36 };

/**
 * How the sheet's picture (the "AFTER IMPORT" tile) is lit. `neutral` is the flat three.js light the metrics are
 * measured under. `unreal-like` adds a daylight key, a restrained sky fill and a grey checkered ground that catches a
 * cast shadow, approximating the look of an Unreal editor thumbnail. It is a picture-only approximation: the camera,
 * lighting and ground are not the editor's, so the judge's numbers are always measured on the `neutral` render.
 */
export type PictureLighting = "neutral" | "unreal-like";
/** The fixed camera every render pass shares (so a change of lighting is the only difference between passes). */
export const PICTURE_CAMERA = Object.freeze({ fov: 40, direction: [1, 0.75, 1.2] as const, fit: 1.05 });

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
  /**
   * Writes `<n>-<name>.reference.png` and `<n>-<name>.render.png` per compared tile here, for calibrating the
   * fidelity metric. Derived from licensed packs: local-only, never commit.
   */
  dumpTilesDir?: string;
  /**
   * Lighting of the sheet's picture only. `neutral` (default) keeps every existing caller and golden unchanged.
   * `unreal-like` adds an extra supersampled pass with a daylight key, a sky fill and a grey checkered ground for
   * the picture; the judge's metrics stay on the neutral render.
   */
  pictureLighting?: PictureLighting;
  /**
   * Deterministic test seam: tile indices the `unreal-like` pass must fail, so a tile that rendered in the neutral
   * pass but fails the lit pass is reported instead of silently drawn blank. Never set in production.
   */
  litFailureProbe?: readonly number[];
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
  /** Lighting-robust fidelity to the thumbnail (`render-fidelity.ts`); absent without a comparable thumbnail. */
  fidelity?: FidelityMetrics;
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

function pageHtml(
  tileSize: number,
  count: number,
  columns: number,
  rows: number,
  supersample: number,
  lighting: PictureLighting,
  shadows: boolean,
  litFailureProbe: readonly number[],
): string {
  const payload = JSON.stringify({ tile: tileSize, count, columns, rows, ss: supersample, lighting, shadows, litFailureProbe });
  return `<!doctype html><html><body>
<script type="importmap">{"imports":{"three":"/three.module.js","three/addons/":"/jsm/"}}</script>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
const options = ${payload};
const size = options.tile;
const lit = options.lighting === 'unreal-like';
const shadows = options.shadows !== false;
// A subtle grey checker like an editor thumbnail's floor: two close greys, never pure white or black.
const makeChecker = () => {
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 64;
  const g = canvas.getContext('2d');
  g.fillStyle = '#c2c2c2'; g.fillRect(0, 0, 64, 64);
  g.fillStyle = '#b0b0b0';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if ((x + y) % 2 === 0) g.fillRect(x * 8, y * 8, 8, 8);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping; texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  return texture;
};
try {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(options.ss);
  renderer.setSize(size, size);
  renderer.setClearColor(0x808080, 1);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x808080);
  let key;
  let checker;
  let groundMaterial;
  if (lit) {
    // Unreal-style approximation: a restrained sky fill and one daylight key that casts a shadow. No hinted engine values.
    // The shadows flag is a deterministic test control (default on); off leaves the fill, key and ground identical.
    scene.add(new THREE.HemisphereLight(0xc2d4ea, 0x3c3c3c, 0.9));
    key = new THREE.DirectionalLight(0xfff3e2, 2.2);
    if (shadows) {
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      key.castShadow = true;
      key.shadow.mapSize.set(1024, 1024);
      key.shadow.bias = -0.0005;
    }
    scene.add(key); scene.add(key.target);
    checker = makeChecker();
    groundMaterial = new THREE.MeshStandardMaterial({ map: checker, roughness: 1, metalness: 0 });
  } else {
    scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2.2));
    const light = new THREE.DirectionalLight(0xffffff, 2.4);
    light.position.set(2, 4, 3);
    scene.add(light);
  }
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
    let ground;
    try {
      if (lit && options.litFailureProbe.includes(i)) throw new Error('lit failure probe');
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
      if (lit) {
        // Ground, key light and shadow camera all scale to this model's bounds; nothing assumes a fixed unit size.
        model.traverse((o) => { if (o.isMesh) { o.castShadow = shadows; o.receiveShadow = true; } });
        // Large enough that its far edge stays outside the framing (a small plane's near edge showed as a triangle).
        const groundSize = radius * 128;
        ground = new THREE.Mesh(new THREE.PlaneGeometry(groundSize, groundSize), groundMaterial);
        ground.rotation.x = -Math.PI / 2;
        ground.position.set(center.x, box.min.y, center.z);
        ground.receiveShadow = true;
        // One checker cell per 4*radius of world space, so enlarging the plane keeps the checker's physical scale.
        const repeat = Math.max(2, Math.round(groundSize / (4 * radius)));
        checker.repeat.set(repeat, repeat);
        scene.add(ground);
        // Daylight key about 40 degrees up, 75 degrees off the camera's azimuth on the other side (negative), so the
        // cast shadow falls to the left, as in the Unreal reference.
        const azimuth = Math.atan2(direction.z, direction.x) - (75 * Math.PI) / 180;
        const elevation = (40 * Math.PI) / 180;
        const toLight = new THREE.Vector3(
          Math.cos(elevation) * Math.cos(azimuth),
          Math.sin(elevation),
          Math.cos(elevation) * Math.sin(azimuth),
        );
        key.position.copy(center).addScaledVector(toLight, radius * 8);
        key.target.position.copy(center);
        key.target.updateMatrixWorld();
        if (shadows) {
          const shadowCamera = key.shadow.camera;
          const half = radius * 3;
          shadowCamera.left = -half; shadowCamera.right = half;
          shadowCamera.top = half; shadowCamera.bottom = -half;
          shadowCamera.near = radius * 0.1; shadowCamera.far = radius * 24;
          shadowCamera.updateProjectionMatrix();
          key.shadow.normalBias = radius * 0.01;
        }
      }
      renderer.render(scene, camera);
      context.drawImage(renderer.domElement, (i % options.columns) * size, Math.floor(i / options.columns) * size, size, size);
      if (ground) { scene.remove(ground); ground.geometry.dispose(); }
      scene.remove(model); dispose(model);
      tiles.push({ ok: true });
    } catch (error) {
      if (ground) { scene.remove(ground); ground.geometry.dispose(); }
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
  /** Render at this multiple of the tile size and box-filter down (1 = the plain alpha-tested render). */
  supersample = 1,
  /** Default `neutral`: the flat light the fidelity metrics are measured under. */
  lighting: PictureLighting = "neutral",
  /** Default true; only meaningful with `unreal-like` (the deterministic shadow control). */
  shadows = true,
  /** Deterministic test seam; tile indices the lit pass must fail. */
  litFailureProbe: readonly number[] = [],
): Promise<RenderedGrid> {
  const html = Buffer.from(pageHtml(tile, selected.length, columns, rows, supersample, lighting, shadows, litFailureProbe), "utf8");
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

export interface RenderedTiles {
  /** The full grid PNG, before any labels or panels are composited. */
  png: Buffer;
  /** One raw tile per input GLB, row-major; a failed tile is the untouched grey background. */
  tiles: RgbaImage[];
  /** Whether each input rendered a model. */
  rendered: boolean[];
}

/**
 * Renders GLBs to a grid of raw tiles with the same production renderer the contact sheet uses (same
 * fixed camera, same lighting, same swiftshader flags). The camera frames each model to fit, so a tile
 * depends only on the model and the renderer, which makes it a stable golden image. The visual
 * regression suite calls this directly rather than going through the JPEG contact sheet.
 */
export async function renderTiles(options: {
  readonly glbPaths: readonly string[];
  /** Tile edge in pixels. Default 160. */
  readonly tile?: number;
  readonly timeoutMs?: number;
  /** Render at this multiple of the tile and box-filter down; default 1. */
  readonly supersample?: number;
  /** Default `neutral`, which is what the committed goldens are. `unreal-like` is a picture-only approximation. */
  readonly lighting?: PictureLighting;
  /** Default true; with `unreal-like`, false keeps the fill, key and ground but drops the cast shadow (a control). */
  readonly shadows?: boolean;
}): Promise<RenderedTiles> {
  const tile = Math.max(16, Math.round(options.tile ?? 160));
  const paths = options.glbPaths;
  const columns = paths.length <= 1 ? 1 : paths.length <= 4 ? 2 : paths.length <= 9 ? 3 : 4;
  const rows = Math.max(1, Math.ceil(paths.length / columns));
  const candidates: Candidate[] = paths.map((path) => ({
    path,
    name: basename(path, extname(path)),
    score: 0,
    failed: false,
  }));
  const grid = await renderGrid(candidates, tile, columns, rows, options.timeoutMs ?? 180_000, options.supersample ?? 1, options.lighting ?? "neutral", options.shadows ?? true);
  const decoded = await decodeRgba(grid.png);
  return {
    png: grid.png,
    rendered: grid.rendered,
    tiles: paths.map((_, index) => cutTile(decoded, tile, index % columns, Math.floor(index / columns))),
  };
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

/** Supersampling of the tile used for silhouette mass and the sheet picture (2x is an exact box filter). */
const SHAPE_SUPERSAMPLE = 2;
const PAIR_CAPTION = 46;
const REFERENCE_BAND = 132;
const VERDICT_COLOUR: Record<Verdict, string> = { ok: "#3ddc84", suspect: "#ffc233", fail: "#ff4d4d" };

/**
 * The piece in an Unreal editor thumbnail: the border-palette object mask minus the floor's cast shadow. Counting the shadow
 * inflates the bounding box, so a correct cut-out render reads as a "solid card" against it (the conifer ground twigs).
 */
export function referenceObjectMask(reference: RgbaImage): Uint8Array {
  return withoutFloorShadow(reference, objectMask(reference));
}

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
  const pictureLighting = options.pictureLighting ?? "neutral";

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
  let shapeGridPng: Buffer | undefined;
  let pictureLightPng: Buffer | undefined;
  const loadable = selected.filter((c) => !c.failed);
  if (loadable.length > 0) {
    // Failed candidates are not sent to the browser; keep their cells blank in place.
    const cells = selected.map((c) => (c.failed ? { ...c, path: "" } : c));
    const grid = await renderGrid(cells, tile, columns, rows, timeoutMs);
    gridPng = grid.png;
    const neutralRendered = grid.rendered.map((ok, index) => ok && !selected[index]!.failed);
    // An alpha-tested cut-out has hard edges at 1x while Unreal's thumbnail is anti-aliased, so thin needles read sparser
    // than they are. The silhouette-mass measure and the sheet picture use a 2x supersampled render; colour stays at 1x.
    if (withThumbnails) {
      const shape = await renderGrid(cells, tile, columns, rows, timeoutMs, SHAPE_SUPERSAMPLE);
      shapeGridPng = shape.png;
    }
    // The lit picture is a separate supersampled pass; it never replaces the neutral pixels the judge measures.
    if (pictureLighting === "unreal-like") {
      const picture = await renderGrid(cells, tile, columns, rows, timeoutMs, SHAPE_SUPERSAMPLE, "unreal-like", true, options.litFailureProbe ?? []);
      pictureLightPng = picture.png;
      // A tile the neutral pass rendered but the lit pass dropped would otherwise be drawn blank while the neutral
      // counts and judge still call it a success. Never substitute the neutral pixels: name the tile and fail.
      const dropped = selected
        .map((candidate, index) => ({ candidate, index }))
        .filter(({ index }) => neutralRendered[index] === true && picture.rendered[index] !== true);
      if (dropped.length > 0) {
        throw new Error(
          `unreal-like picture pass failed for ${dropped.map(({ candidate, index }) => `tile ${index} "${candidate.name}"`).join(", ")} ` +
            "while the neutral render succeeded; refusing to draw a blank AFTER IMPORT tile",
        );
      }
    }
    rendered = neutralRendered;
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
  const decodedShape: RgbaImage | undefined =
    shapeGridPng === undefined
      ? undefined
      : await sharp(shapeGridPng).ensureAlpha().raw().toBuffer({ resolveWithObject: true }).then(
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
    let thumbnailFill: { fillRatio: number; objectPixels: number } | undefined;
    let fidelity: FidelityMetrics | undefined;
    if (candidate.thumbnail !== undefined) {
      try {
        const reference = await decodeRgba(candidate.thumbnail);
        const comparison = colourSimilarity(reference, pixels, referenceObjectMask(reference));
        const shapePixels = decodedShape === undefined ? undefined : cutTile(decodedShape, tile, index % columns, Math.floor(index / columns));
        const measured = measureFidelity(reference, pixels, shapePixels);
        if (measured.comparable) fidelity = measured;
        if (options.dumpTilesDir !== undefined) {
          await mkdir(options.dumpTilesDir, { recursive: true });
          const stem = `${String(index).padStart(2, "0")}-${candidate.name.replace(/[^\w.-]/g, "_")}`;
          const raw = (image: RgbaImage) => ({ raw: { width: image.width, height: image.height, channels: 4 as const } });
          await sharp(Buffer.from(reference.data.buffer, reference.data.byteOffset, reference.data.byteLength), raw(reference)).png().toFile(join(options.dumpTilesDir, `${stem}.reference.png`));
          await sharp(Buffer.from(pixels.data.buffer, pixels.data.byteOffset, pixels.data.byteLength), raw(pixels)).png().toFile(join(options.dumpTilesDir, `${stem}.render.png`));
        }
        if (comparison.comparable) {
          similarity = comparison.similarity;
          meanColourDelta = comparison.meanColourDelta;
        }
        const referenceFill = maskFillRatio(referenceObjectMask(reference), reference.width, reference.height);
        thumbnailFill = { fillRatio: referenceFill.fillRatio, objectPixels: referenceFill.pixels };
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
      ...(fidelity !== undefined ? { fidelity } : {}),
      ...(thumbnailFill !== undefined
        ? { thumbnailFillRatio: thumbnailFill.fillRatio, thumbnailObjectPixels: thumbnailFill.objectPixels }
        : {}),
    });
    judge.push({
      tile: index,
      glb,
      name: candidate.name,
      verdict: result.verdict,
      reasons: result.reasons,
      stats: result.stats,
      ...(similarity !== undefined && meanColourDelta !== undefined ? { similarity, meanColourDelta } : {}),
      ...(fidelity !== undefined ? { fidelity } : {}),
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

  const afterImportLine =
    pictureLighting === "unreal-like"
      ? "Each tile: ORIGINAL = Unreal editor thumbnail | AFTER IMPORT = Unreal-style picture approximation."
      : "Each tile: ORIGINAL = Unreal editor thumbnail of that asset | AFTER IMPORT = our GLB, neutral light.";
  const scoreLine =
    pictureLighting === "unreal-like"
      ? "Camera and lighting differ from the editor; colour scores are measured in the neutral view."
      : "Colour similarity compares object colour only (camera and lighting differ). It is not a match score.";
  const header = withThumbnails ? REFERENCE_BAND : HEADER;
  const caption = (withThumbnails ? CAPTION + 14 : CAPTION) + (!withThumbnails && pictureLighting === "unreal-like" ? 36 : 0);
  const width = Math.max(galleryWidth + gridWidth, withThumbnails ? 760 : 0);
  const height = header + bodyHeight + caption;
  const gridLeft = galleryWidth;
  const text = (x: number, y: number, size: number, fill: string, value: string, extra = "") =>
    `<text x="${x}" y="${y}" font-family="DejaVu Sans, Arial, sans-serif" font-size="${size}" fill="${fill}" ${extra}>${escapeXml(value)}</text>`;
  const svg: string[] = [];
  if (withThumbnails) {
    const referenceLeft = galleryPanel === undefined ? 10 : 10 + 240 + 12;
    const noteWidth = Math.max(40, Math.floor((width - referenceLeft) / 6.6));
    svg.push(
      text(referenceLeft, 28, 15, "#e8e8ee", clip(options.title, 70), 'font-weight="bold"'),
      ...(options.subtitle !== undefined ? [text(referenceLeft, 50, 12, "#c8c8d4", clip(options.subtitle, 110))] : []),
      text(referenceLeft, 74, 12, "#9a9aaa", galleryPanel === undefined ? "no gallery image" : "Fab gallery image at left: reference only, a lit full scene"),
      text(referenceLeft, 94, 12, "#9a9aaa", clip(afterImportLine, noteWidth)),
      text(referenceLeft, 112, 12, "#9a9aaa", clip(scoreLine, noteWidth)),
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
  if (!withThumbnails && pictureLighting === "unreal-like") {
    const noteWidth = Math.floor(width / 6.6);
    svg.push(
      text(10, bottom + 108, 12, "#9a9aaa", clip("AFTER IMPORT = our GLB, an Unreal-style picture approximation.", noteWidth)),
      text(10, bottom + 124, 12, "#9a9aaa", clip("Camera and lighting differ; scores are measured in the neutral view.", noteWidth)),
    );
  }

  if (galleryPanel !== undefined) {
    layers.push(
      withThumbnails
        ? { input: galleryPanel, left: 10, top: 6 }
        : { input: galleryPanel, left: 0, top: header + Math.floor((bodyHeight - galleryHeight) / 2) },
    );
  }
  // The picture shows the supersampled tiles when there are any (the thumbnail beside it is anti-aliased). With
  // unreal-like lighting it shows a separate lit pass; the judge's metrics above stay on the neutral render.
  const pictureGridPng = pictureLightPng ?? shapeGridPng ?? gridPng;
  if (pictureGridPng !== undefined) {
    if (withThumbnails) {
      // The browser grid is `columns` tiles wide; move each render beside its thumbnail.
      for (let index = 0; index < count; index++) {
        if (!rendered[index]) continue;
        const input = await sharp(pictureGridPng)
          .extract({ left: (index % columns) * tile, top: Math.floor(index / columns) * tile, width: tile, height: tile })
          .png()
          .toBuffer();
        layers.push({ input, left: gridLeft + (index % columns) * cellWidth + tile, top: header + Math.floor(index / columns) * tile });
      }
    } else {
      layers.push({ input: pictureGridPng, left: gridLeft, top: header });
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
