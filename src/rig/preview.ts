import { createServer } from "node:http";
import { createRequire } from "node:module";
import { basename, dirname, join, normalize } from "node:path";

import { chromium } from "playwright";
import sharp from "sharp";

import { createBrowserTempDir } from "../browser-temp.js";
import { RigAssetError } from "./inspect.js";

const require = createRequire(import.meta.url);
const THREE_ROOT = dirname(dirname(require.resolve("three")));

export interface PreviewPose {
  bone: string;
  axis: "x" | "y" | "z";
  degrees: number;
}

export interface PreviewOptions {
  clipName?: string;
  times: number[];
  /** One explicit bone rotation applied to every frame, for limb-isolation sheets. */
  pose?: PreviewPose;
  angles?: number;
  width?: number;
  height?: number;
  timeoutMs?: number;
}

export interface PreviewImage {
  time: number;
  angle: number;
  png: Uint8Array;
  mean: number;
  std: number;
  nonBlank: boolean;
}

export interface PreviewResult {
  backend: string;
  images: PreviewImage[];
  contactSheet: Uint8Array;
  canvas: { width: number; height: number; columns: number; rows: number };
  bounds: { min: [number, number, number]; max: [number, number, number] } | null;
  animations: string[];
  tracks: number;
  boundTracks: number;
  sampledTimes: number[];
}

function threeFile(relative: string): string {
  return join(THREE_ROOT, relative);
}

function pageHtml(options: PreviewOptions): string {
  const payload = JSON.stringify({
    clipName: options.clipName ?? null,
    times: options.times,
    pose: options.pose ?? null,
    angles: options.angles ?? 3,
    width: options.width ?? 384,
    height: options.height ?? 384,
  });
  return `<!doctype html><html><body>
<script type="importmap">{"imports":{"three":"/three.module.js","three/addons/":"/jsm/"}}</script>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
const options = ${payload};
try {
  const width = options.width, height = options.height;
  const renderer = new THREE.WebGLRenderer({antialias:true, preserveDrawingBuffer:true});
  renderer.setSize(width, height);
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x202830);
  scene.add(new THREE.HemisphereLight(0xffffff,0x333344,4));
  const light = new THREE.DirectionalLight(0xffffff,3); light.position.set(2,5,3); scene.add(light);
  const camera = new THREE.PerspectiveCamera(45,width/height,0.01,1000);
  new GLTFLoader().load('/model.glb', (gltf) => {
    const model = gltf.scene; scene.add(model);
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3()); const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.x,size.y,size.z) || 1;
    const mixer = new THREE.AnimationMixer(model);
    const clips = gltf.animations ?? [];
    const clip = options.clipName ? clips.find(c => c.name === options.clipName) : clips[0];
    let tracks = 0, boundTracks = 0;
    const boneNames = new Set();
    model.traverse(o => { if (o.isBone) boneNames.add(o.name); });
    if (clip) {
      tracks = clip.tracks.length;
      for (const track of clip.tracks) {
        const head = track.name.replace(/\.(quaternion|position|scale|morphTargetInfluences.*)$/, '');
        if (boneNames.has(head) || THREE.PropertyBinding.findNode(model, track.name)) boundTracks += 1;
      }
      mixer.clipAction(clip).play();
    }
    const bones = {};
    // GLTFLoader sanitizes node names, so 'upper_arm.L' in the file is 'upper_armL' in the scene.
    model.traverse(o => { if (o.isBone) bones[o.name] = o; });
    const pose = options.pose;
    const poseBone = pose ? (bones[pose.bone] ?? bones[THREE.PropertyBinding.sanitizeNodeName(pose.bone)]) : null;
    if (pose && !poseBone) {
      window.__result = { ok:false, error: 'pose bone ' + pose.bone + ' is not in the model' };
      return;
    }
    const poseAxis = pose ? new THREE.Vector3(pose.axis === 'x' ? 1 : 0, pose.axis === 'y' ? 1 : 0, pose.axis === 'z' ? 1 : 0) : null;
    const poseRotation = pose ? new THREE.Quaternion().setFromAxisAngle(poseAxis, (pose.degrees * Math.PI) / 180) : null;
    const poseUndo = poseRotation ? poseRotation.clone().invert() : null;
    const gl = renderer.getContext();
    const images = [];
    for (const time of options.times) {
      for (let angle = 0; angle < options.angles; angle++) {
        const azimuth = (angle / options.angles) * Math.PI * 2;
        // Never write the driven bones by hand: AnimationMixer applies a track only when its value
        // differs from the one it last wrote, so an external reset makes it skip every later tile
        // and the whole sheet past the first frame renders the same pose.
        if (clip) { mixer.setTime(time); }
        // On top of the mixer, never before it, or a clip driving this bone overwrites the override.
        if (poseRotation) poseBone.quaternion.multiply(poseRotation);
        model.updateMatrixWorld(true);
        const distance = radius * 1.7;
        camera.position.set(center.x + Math.sin(azimuth)*distance, center.y + size.y*0.12, center.z + Math.cos(azimuth)*distance);
        camera.lookAt(center);
        renderer.render(scene, camera);
        const pixels = new Uint8Array(width*height*4);
        gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
        let sum=0, sum2=0; const n = width*height;
        for (let i=0;i<pixels.length;i+=4){ const v=pixels[i]; sum+=v; sum2+=v*v; }
        const mean = sum/n; const std = Math.sqrt(Math.max(0, sum2/n - mean*mean));
        images.push({ time, angle, dataUrl: renderer.domElement.toDataURL('image/png'), mean, std });
        // Undo the override so the mixer's change detection keeps seeing its own last value.
        if (poseUndo) poseBone.quaternion.multiply(poseUndo);
      }
    }
    window.__result = {
      ok: true,
      backend: 'playwright-chromium ' + gl.getParameter(gl.VERSION),
      images,
      animations: clips.map(c => c.name),
      tracks,
      boundTracks,
      bounds: { min: box.min.toArray(), max: box.max.toArray() },
    };
  }, undefined, (error) => { window.__result = { ok:false, error: 'load ' + String(error) }; });
} catch (error) {
  window.__result = { ok:false, error: 'setup ' + String(error) };
}
</script></body></html>`;
}

function serveBuffer(
  res: import("node:http").ServerResponse,
  bytes: Uint8Array,
  type: string,
): void {
  res.writeHead(200, { "content-type": type, "content-length": bytes.byteLength });
  res.end(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
}

export function previewAvailable(): boolean {
  try {
    return chromium.executablePath().length > 0;
  } catch {
    return false;
  }
}

export async function renderPreview(
  modelBytes: Uint8Array,
  options: PreviewOptions,
): Promise<PreviewResult> {
  if (options.times.length === 0) {
    throw new RigAssetError("RIG_INVALID_INPUT", "At least one preview sample time is required.");
  }
  if (!previewAvailable()) {
    throw new RigAssetError(
      "RIG_PREVIEW_UNAVAILABLE",
      "Playwright Chromium is not installed; run `npm run browser:install`.",
    );
  }
  const wide = { ...options, width: options.width ?? 384, height: options.height ?? 384 };
  const html = Buffer.from(pageHtml(wide), "utf8");
  const server = createServer((request, response) => {
    const url = (request.url ?? "/").split("?")[0]!;
    if (url === "/" || url === "/index.html") {
      serveBuffer(response, html, "text/html");
      return;
    }
    if (url === "/model.glb") {
      serveBuffer(response, modelBytes, "model/gltf-binary");
      return;
    }
    if (url.startsWith("/jsm/")) {
      void import("node:fs/promises").then(({ readFile }) =>
        readFile(threeFile(join("examples", "jsm", normalize(url.slice(5)))))
          .then((data) => serveBuffer(response, data, "text/javascript"))
          .catch(() => {
            response.writeHead(404);
            response.end();
          }),
      );
      return;
    }
    if (/^\/three[\w.-]*\.js$/.test(url)) {
      void import("node:fs/promises").then(({ readFile }) =>
        readFile(threeFile(join("build", basename(url))))
          .then((data) => serveBuffer(response, data, "text/javascript"))
          .catch(() => {
            response.writeHead(404);
            response.end();
          }),
      );
      return;
    }
    response.writeHead(404);
    response.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let temp: Awaited<ReturnType<typeof createBrowserTempDir>> | undefined;
  const pageErrors: string[] = [];
  try {
    temp = await createBrowserTempDir();
    browser = await chromium.launch({
      headless: true,
      env: { ...process.env, ...temp.env },
      args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    });
    const page = await browser.newPage({
      viewport: { width: wide.width!, height: wide.height! },
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("requestfailed", (request) =>
      pageErrors.push(`${request.url()} ${request.failure()?.errorText ?? ""}`),
    );
    await page.goto(`http://127.0.0.1:${port}/`, { timeout: options.timeoutMs ?? 30_000 });
    await page.waitForFunction(
      () => Boolean((window as unknown as { __result?: unknown }).__result),
      null,
      { timeout: options.timeoutMs ?? 30_000 },
    );
    const raw = (await page.evaluate(
      () => (window as unknown as { __result: unknown }).__result,
    )) as {
      ok: boolean;
      error?: string;
      backend?: string;
      images?: Array<{ time: number; angle: number; dataUrl: string; mean: number; std: number }>;
      animations?: string[];
      tracks?: number;
      boundTracks?: number;
      bounds?: { min: [number, number, number]; max: [number, number, number] };
    };
    if (!raw.ok) {
      throw new RigAssetError("RIG_PREVIEW_FAILED", raw.error ?? "The preview render failed.");
    }
    const angleCount = options.angles ?? 3;
    const images: PreviewImage[] = (raw.images ?? []).map((image) => ({
      time: image.time,
      angle: image.angle,
      png: Buffer.from(image.dataUrl.split(",")[1] ?? "", "base64"),
      mean: image.mean,
      std: image.std,
      nonBlank: image.std > 1 && image.mean > 1 && image.mean < 254,
    }));
    if (images.length === 0) {
      throw new RigAssetError("RIG_PREVIEW_FAILED", "The preview produced no images.");
    }
    if (images.some((image) => !image.nonBlank)) {
      throw new RigAssetError(
        "RIG_PREVIEW_FAILED",
        "The preview produced a blank frame; the renderer did not draw the model.",
      );
    }
    const rows = options.times.length;
    const columns = angleCount;
    const contactSheet = await sharp({
      create: {
        width: wide.width! * columns,
        height: wide.height! * rows,
        channels: 4,
        background: { r: 20, g: 24, b: 32, alpha: 1 },
      },
    })
      .composite(
        images.map((image, index) => ({
          input: Buffer.from(image.png),
          left: (index % columns) * wide.width!,
          top: Math.floor(index / columns) * wide.height!,
        })),
      )
      .png()
      .toBuffer();

    return {
      backend: raw.backend ?? "playwright-chromium",
      images,
      contactSheet: new Uint8Array(contactSheet),
      canvas: { width: wide.width!, height: wide.height!, columns, rows },
      bounds: raw.bounds ?? null,
      animations: raw.animations ?? [],
      tracks: raw.tracks ?? 0,
      boundTracks: raw.boundTracks ?? 0,
      sampledTimes: options.times,
    };
  } catch (error) {
    if (error instanceof RigAssetError) throw error;
    throw new RigAssetError(
      "RIG_PREVIEW_FAILED",
      `The preview render failed: ${error instanceof Error ? error.message : String(error)}${
        pageErrors.length > 0 ? ` [${pageErrors.slice(0, 3).join("; ")}]` : ""
      }.`,
    );
  } finally {
    await browser?.close().catch(() => undefined);
    await temp?.remove().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
