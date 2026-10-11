import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createBrowserTempDir, type BrowserTempDir } from "../src/browser-temp.js";
import { promoteRgba16fDataTexture, type PromotedDataTexture } from "../src/unreal/data-texture-promotion.js";
import { describeWithTools } from "./helpers/require-tool.js";
import {
  PRODUCER_PACKAGE_UASSET,
  PRODUCER_PACKAGE_UEXP,
  Rgba16fProducer,
} from "./helpers/rgba16f-producer.js";

// The shipped loader, in a real browser. The producer writes a binary and manifest, the importer's promotion moves them into
// the output, and headless Chromium loads them through the package's `./data-texture` subpath, which the page resolves from
// package.json. The loader's texture is sampled by the GPU and read back. Readback is raw float32 from a float render target,
// so the stored bits are compared exactly; a declared display range is applied only to a separate 8-bit view.

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DISPLAY_RANGE = { lo: -1, hi: 1 } as const;

/** The samples the producer is given: negative, HDR, subnormal, alpha bits, -0, the largest finite and a smallest normal. */
const SAMPLES = [
  0xbc00, 0x5b00, 0x0001, 0x0100,
  0x8000, 0x7bff, 0x3c00, 0xc200,
  0x0200, 0x6400, 0xbbff, 0x0000,
  0x3555, 0x4248, 0x7800, 0x0400,
  0xfbff, 0x8001, 0x3800, 0x3000,
  0x4900, 0xa000, 0x2e66, 0x0001,
];

/** IEEE 754 binary16 to a JavaScript number, written here independently of the module under test. */
function halfToNumber(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  if (exponent === 31) return fraction === 0 ? sign * Infinity : Number.NaN;
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

const PAGE = `<!doctype html>
<meta charset="utf-8">
<script type="importmap">__IMPORT_MAP__</script>
<script type="module">
import * as THREE from "three";
import { loadRgba16fDataTexture } from "threenative-asset-mcp/data-texture";

const VERTEX = "void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }";
const SAMPLE = "uniform sampler2D map; uniform vec2 size; void main() { gl_FragColor = texture2D(map, (floor(gl_FragCoord.xy) + 0.5) / size); }";
const DISPLAY = "uniform sampler2D map; uniform vec2 size; uniform float lo; uniform float hi; void main() { vec4 raw = texture2D(map, (floor(gl_FragCoord.xy) + 0.5) / size); gl_FragColor = clamp((raw - lo) / (hi - lo), 0.0, 1.0); }";

function target(type, width, height) {
  return new THREE.WebGLRenderTarget(width, height, { type, format: THREE.RGBAFormat, depthBuffer: false, generateMipmaps: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
}
function fullScreen(material) {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
  return scene;
}

window.readback = async (options) => {
  try {
    const { texture, manifest } = await loadRgba16fDataTexture(options.manifestUrl, { expectedSourceSha256: options.expectedSourceSha256 });
    const { width, height } = manifest.data;
    const size = new THREE.Vector2(width, height);
    const renderer = new THREE.WebGLRenderer({ antialias: false });
    try {
      const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      const raw = target(THREE.FloatType, width, height);
      const sample = new THREE.ShaderMaterial({ uniforms: { map: { value: texture }, size: { value: size } }, vertexShader: VERTEX, fragmentShader: SAMPLE });
      renderer.setRenderTarget(raw);
      renderer.render(fullScreen(sample), camera);
      const values = new Float32Array(width * height * 4);
      renderer.readRenderTargetPixels(raw, 0, 0, width, height, values);

      // The declared display range: a separate 8-bit view of the float target. It never feeds the readback above.
      const view = target(THREE.UnsignedByteType, width, height);
      const display = new THREE.ShaderMaterial({
        uniforms: { map: { value: raw.texture }, size: { value: size }, lo: { value: options.displayRange.lo }, hi: { value: options.displayRange.hi } },
        vertexShader: VERTEX,
        fragmentShader: DISPLAY,
      });
      renderer.setRenderTarget(view);
      renderer.render(fullScreen(display), camera);
      const shown = new Uint8Array(width * height * 4);
      renderer.readRenderTargetPixels(view, 0, 0, width, height, shown);
      renderer.setRenderTarget(null);
      return {
        values: Array.from(values),
        shown: Array.from(shown),
        texture: {
          isDataTexture: texture.isDataTexture,
          format: texture.format === THREE.RGBAFormat ? "RGBAFormat" : String(texture.format),
          type: texture.type === THREE.HalfFloatType ? "HalfFloatType" : String(texture.type),
          colorSpace: texture.colorSpace === THREE.NoColorSpace ? "NoColorSpace" : String(texture.colorSpace),
          generateMipmaps: texture.generateMipmaps,
          width: texture.image.width,
          height: texture.image.height,
        },
      };
    } finally {
      renderer.dispose();
    }
  } catch (error) {
    return { error: String(error && error.message ? error.message : error) };
  }
};
window.ready = true;
</script>`;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".rgba16f-le": "application/octet-stream",
};

describeWithTools(["modern-converter", "chromium"], "RGBA16F data texture loaded in headless Chromium", () => {
  const producer = new Rgba16fProducer();
  let work = "";
  let served = "";
  let server: Server | undefined;
  let origin = "";
  let temp: BrowserTempDir | undefined;
  let browser: Browser | undefined;
  let promoted: PromotedDataTexture | undefined;

  beforeAll(async () => {
    const loader = join(REPO, "dist", "data-texture-loader.js");
    if (!existsSync(loader)) throw new Error(`${loader} is missing: run npm run build before this suite`);
    const pkg = JSON.parse(await readFile(join(REPO, "package.json"), "utf8")) as { exports: Record<string, { import: string }> };
    const subpath = pkg.exports["./data-texture"]?.import;
    if (subpath === undefined) throw new Error("package.json exports no ./data-texture subpath");
    const importMap = JSON.stringify({
      imports: {
        three: "/vendor/three/three.module.js",
        "threenative-asset-mcp/data-texture": `/vendor/repo/${subpath.replace(/^\.\//, "")}`,
      },
    });
    const page = PAGE.replace("__IMPORT_MAP__", importMap);

    work = await mkdtemp(join(tmpdir(), "asset-mcp-data-texture-browser-"));
    served = join(work, "served");
    await mkdir(served, { recursive: true });
    const threeBuild = join(REPO, "node_modules", "three", "build");

    await producer.setup();
    await seedAndPromote();

    server = createServer(async (request, response) => {
      try {
        const path = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
        if (path === "/") return send(response, "text/html; charset=utf-8", page);
        const mounts: [string, string][] = [
          ["/vendor/three/", threeBuild],
          ["/vendor/repo/", REPO],
          ["/data/", served],
        ];
        for (const [prefix, root] of mounts) {
          if (!path.startsWith(prefix)) continue;
          const file = resolve(root, normalize(path.slice(prefix.length)));
          if (relative(root, file).split(sep)[0] === "..") return respond(response, 403, "outside the served root");
          const info = await stat(file).catch(() => undefined);
          if (!info?.isFile()) return respond(response, 404, "not found");
          return send(response, CONTENT_TYPES[extname(file)] ?? "application/octet-stream", await readFile(file));
        }
        return respond(response, 404, "not found");
      } catch (error) {
        respond(response, 500, String(error));
      }
    });
    await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("the test server has no port");
    origin = `http://127.0.0.1:${address.port}`;

    temp = await createBrowserTempDir();
    browser = await chromium.launch({
      headless: true,
      env: temp.env,
      args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    });
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    await temp?.remove();
    await new Promise<void>((done) => {
      if (!server) return done();
      server.close(() => done());
      server.closeAllConnections();
    });
    await producer.teardown();
    if (work) await rm(work, { recursive: true, force: true });
  });

  /**
   * The producer writes the binary and manifest; the importer's promotion moves them under a qualified path. The source
   * files the producer hashed are written to the source root first, so the promotion's source-identity check is real.
   */
  async function seedAndPromote(): Promise<void> {
    const sourceDir = join(work, "source");
    await mkdir(join(sourceDir, "Pack/Content/Probe"), { recursive: true });
    await writeFile(join(sourceDir, "Pack/Content/Probe/T_Probe_PIV.uasset"), PRODUCER_PACKAGE_UASSET);
    await writeFile(join(sourceDir, "Pack/Content/Probe/T_Probe_PIV.uexp"), PRODUCER_PACKAGE_UEXP);
    const payload = Buffer.alloc(SAMPLES.length * 2);
    SAMPLES.forEach((bits, index) => payload.writeUInt16LE(bits, index * 2));
    const outcome = await producer.produce({ payload });
    expect(outcome, outcome.reason).toMatchObject({ ok: true });
    // The converter writes into <export-dir>/DataTextures; the promotion reads from that layout.
    const converterOutput = join(work, "converter");
    await mkdir(converterOutput, { recursive: true });
    await rename(outcome.directory, join(converterOutput, "DataTextures"));
    promoted = await promoteRgba16fDataTexture({
      converterOutput,
      sourceDir,
      selector: "Pack/Content/Probe/T_Probe_PIV",
      promotionDir: served,
      relativeBase: "data-textures/pack/content/probe/t_probe_piv",
      package: "pack/content/probe/t_probe_piv.uasset",
    });
  }

  function manifestUrl(): string {
    return `${origin}/data/${promoted!.manifest}`;
  }

  async function openPage() {
    const page = await browser!.newPage();
    const failures: string[] = [];
    page.on("pageerror", (error) => failures.push(error.message));
    await page.goto(`${origin}/`);
    await page.waitForFunction(() => (window as unknown as { ready?: boolean }).ready === true, undefined, { timeout: 60_000 });
    return { page, failures };
  }

  type Readback = {
    readonly error?: string;
    readonly values?: number[];
    readonly shown?: number[];
    readonly texture?: { isDataTexture: boolean; format: string; type: string; colorSpace: string; generateMipmaps: boolean; width: number; height: number };
  };

  it("samples the promoted binary on the GPU and reads back the stored bits exactly, with a display range that only affects the view", async () => {
    const { page, failures } = await openPage();
    try {
      const result = await page.evaluate(
        (options) => (window as unknown as { readback: (o: unknown) => Promise<unknown> }).readback(options),
        { manifestUrl: manifestUrl(), expectedSourceSha256: promoted!.sourceSha256, displayRange: DISPLAY_RANGE },
      ) as Readback;
      expect(result.error, result.error).toBeUndefined();
      expect(failures).toEqual([]);
      expect(result.texture).toEqual({
        isDataTexture: true, format: "RGBAFormat", type: "HalfFloatType", colorSpace: "NoColorSpace",
        generateMipmaps: false, width: 3, height: 2,
      });
      const values = result.values!;
      expect(values).toHaveLength(SAMPLES.length);
      // Every float32 readback equals the binary16 value the producer stored: negative, HDR, subnormal, alpha and -0 included.
      SAMPLES.forEach((bits, index) => {
        expect(Object.is(values[index], halfToNumber(bits)), `sample ${index}: ${values[index]} vs ${halfToNumber(bits)}`).toBe(true);
      });
      // The declared display range is applied to a separate 8-bit view, clamped to the range, to within one 8-bit step.
      const shown = result.shown!;
      SAMPLES.forEach((bits, index) => {
        const raw = halfToNumber(bits);
        const mapped = Math.min(1, Math.max(0, (raw - DISPLAY_RANGE.lo) / (DISPLAY_RANGE.hi - DISPLAY_RANGE.lo)));
        expect(Math.abs(shown[index]! - mapped * 255), `display ${index}`).toBeLessThanOrEqual(1);
      });
    } finally {
      await page.close();
    }
  }, 120_000);

  it("refuses a load that names no expected source identity", async () => {
    const { page } = await openPage();
    try {
      const result = await page.evaluate(
        (options) => (window as unknown as { readback: (o: unknown) => Promise<unknown> }).readback(options),
        { manifestUrl: manifestUrl(), expectedSourceSha256: "", displayRange: DISPLAY_RANGE },
      ) as Readback;
      expect(result.error).toMatch(/expectedSourceSha256 is required/);
    } finally {
      await page.close();
    }
  }, 120_000);

  it("refuses a load whose expected source identity is another package's", async () => {
    const { page } = await openPage();
    try {
      const result = await page.evaluate(
        (options) => (window as unknown as { readback: (o: unknown) => Promise<unknown> }).readback(options),
        { manifestUrl: manifestUrl(), expectedSourceSha256: "0".repeat(64), displayRange: DISPLAY_RANGE },
      ) as Readback;
      expect(result.error).toMatch(/different source package/);
    } finally {
      await page.close();
    }
  }, 120_000);

  it("refuses a binary that differs from the manifest hash, rather than building a texture from it", async () => {
    const tampered = join(served, "tampered");
    const sourceManifest = join(served, promoted!.manifest);
    const sourceData = join(served, promoted!.data);
    await mkdir(tampered, { recursive: true });
    await writeFile(join(tampered, "t_probe_piv.rgba16f.json"), await readFile(sourceManifest));
    const bytes = Buffer.from(await readFile(sourceData));
    bytes[11]! ^= 0x04;
    await writeFile(join(tampered, "t_probe_piv.rgba16f-le"), bytes);
    const { page } = await openPage();
    try {
      const result = await page.evaluate(
        (options) => (window as unknown as { readback: (o: unknown) => Promise<unknown> }).readback(options),
        { manifestUrl: `${origin}/data/tampered/t_probe_piv.rgba16f.json`, expectedSourceSha256: promoted!.sourceSha256, displayRange: DISPLAY_RANGE },
      ) as Readback;
      expect(result.error).toMatch(/SHA-256 does not match/);
      expect(result.values).toBeUndefined();
    } finally {
      await page.close();
      await rm(tampered, { recursive: true, force: true });
    }
  }, 120_000);

  it("refuses to load when the page has no crypto.subtle, and says why", async () => {
    const { page } = await openPage();
    try {
      await page.evaluate(() => {
        Object.defineProperty(globalThis.crypto, "subtle", { get: () => undefined, configurable: true });
      });
      const result = await page.evaluate(
        (options) => (window as unknown as { readback: (o: unknown) => Promise<unknown> }).readback(options),
        { manifestUrl: manifestUrl(), expectedSourceSha256: promoted!.sourceSha256, displayRange: DISPLAY_RANGE },
      ) as Readback;
      expect(result.error).toMatch(/needs crypto\.subtle/);
      expect(result.values).toBeUndefined();
    } finally {
      await page.close();
    }
  }, 120_000);
});

function send(response: import("node:http").ServerResponse, type: string, body: string | Buffer): void {
  response.writeHead(200, { "content-type": type, "cache-control": "no-store" });
  response.end(body);
}

function respond(response: import("node:http").ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(message);
}
