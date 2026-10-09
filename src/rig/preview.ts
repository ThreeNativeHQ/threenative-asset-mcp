import { existsSync } from "node:fs";
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

export interface PreviewFocus {
  bone: string;
  distance?: number | undefined;
}

export interface PreviewOptions {
  clipName?: string;
  times: number[];
  /** An additive local-axis rotation applied after sampling, for limb-isolation sheets. */
  pose?: PreviewPose;
  /**
   * Frame the camera on one bone and its descendant bones (a hand with its
   * fingers) instead of the whole model, following it through the animation.
   * `distance` overrides the automatic fit, in model units, and centres the camera on the
   * bone itself rather than on its subtree, so the view is independent of the finger pose.
   */
  focus?: PreviewFocus;
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
  // Asset names are data, including names containing an HTML script terminator.
  const payload = JSON.stringify({
    clipName: options.clipName ?? null,
    times: options.times,
    pose: options.pose ?? null,
    focus: options.focus ?? null,
    angles: options.angles ?? 3,
    width: options.width ?? 384,
    height: options.height ?? 384,
  }).replace(/</g, "\\u003c");
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
    try {
      const model = gltf.scene; scene.add(model);
      // A skinned mesh keeps the bounding sphere of its first pose, so a limb that swings away
      // (or a camera framed on one hand) would otherwise be culled and the frame render empty.
      model.traverse(node => { if (node.isMesh) node.frustumCulled = false; });
      model.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3()); const center = box.getCenter(new THREE.Vector3());
      const radius = Math.max(size.x,size.y,size.z) || 1;
      const mixer = new THREE.AnimationMixer(model);
      const clips = gltf.animations ?? [];
      const clip = options.clipName !== null ? clips.find(c => c.name === options.clipName) : clips[0];
      if (options.clipName !== null && !clip) throw new Error('Unknown preview clip: ' + options.clipName);

      // Restore authored local transforms, never Euler zero. Untracked fingers
      // and helper nodes must retain their bind/rest orientation.
      const rest = [];
      const bones = new Map();
      const addBoneAlias = (name, bone) => {
        if (typeof name !== 'string' || !name) return;
        const matches = bones.get(name) ?? new Set();
        matches.add(bone);
        bones.set(name, matches);
      };
      model.traverse(node => {
        rest.push({node, position:node.position.clone(), quaternion:node.quaternion.clone(), scale:node.scale.clone()});
        if (!node.isBone) return;
        addBoneAlias(node.name, node);
        // GLTFLoader sanitizes names for PropertyBinding (hand.L -> handL).
        // The public preview API also accepts the original glTF joint name.
        const index = gltf.parser.associations.get(node)?.nodes;
        if (index !== undefined) addBoneAlias(gltf.parser.json.nodes[index]?.name, node);
      });
      const resolveBone = name => {
        const matches = bones.get(name);
        if (!matches || matches.size !== 1) throw new Error('Unknown or ambiguous preview bone: ' + name);
        return matches.values().next().value;
      };
      const pose = options.pose;
      const poseBone = pose ? resolveBone(pose.bone) : undefined;
      const focusBone = options.focus ? resolveBone(options.focus.bone) : undefined;
      let tracks = 0, boundTracks = 0;
      let action;
      if (clip) {
        tracks = clip.tracks.length;
        for (const track of clip.tracks) {
          const binding = THREE.PropertyBinding.parseTrackName(track.name);
          if (THREE.PropertyBinding.findNode(model, binding.nodeName)) boundTracks += 1;
        }
        action = mixer.clipAction(clip);
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      const gl = renderer.getContext();
      const images = [];
      for (const time of options.times) {
        for (let angle = 0; angle < options.angles; angle++) {
          const azimuth = (angle / options.angles) * Math.PI * 2;
          mixer.stopAllAction();
          for (const entry of rest) {
            entry.node.position.copy(entry.position);
            entry.node.quaternion.copy(entry.quaternion);
            entry.node.scale.copy(entry.scale);
          }
          if (action) {
            action.reset().play();
            mixer.setTime(Math.min(Math.max(time, 0), clip.duration));
          }
          // Apply after sampling so animation cannot erase the requested proof.
          // A local delta preserves the authored orientation and avoids any
          // assumption that a finger's curl axis matches a world-space axis.
          if (poseBone) {
            const axis = new THREE.Vector3(); axis[pose.axis] = 1;
            poseBone.rotateOnAxis(axis, (pose.degrees * Math.PI) / 180);
          }
          model.updateMatrixWorld(true);
          if (focusBone) {
            // Track the bone and its descendant bones; fit the camera to their extent.
            const points = [];
            focusBone.traverse(node => { if (node.isBone) points.push(node.getWorldPosition(new THREE.Vector3())); });
            const focusBox = new THREE.Box3().setFromPoints(points);
            // An explicit distance frames the bone itself, so the camera does not move when the
            // fingers do and two builds of the same clip can be compared with an identical view.
            const focusCenter = options.focus.distance !== undefined && options.focus.distance !== null
              ? focusBone.getWorldPosition(new THREE.Vector3())
              : focusBox.getCenter(new THREE.Vector3());
            const extent = Math.max(focusBox.getSize(new THREE.Vector3()).length(), radius * 0.04);
            const focusDistance = options.focus.distance ?? extent * 2.4;
            camera.position.set(focusCenter.x + Math.sin(azimuth)*focusDistance, focusCenter.y + focusDistance*0.2, focusCenter.z + Math.cos(azimuth)*focusDistance);
            camera.lookAt(focusCenter);
          } else {
            const distance = radius * 1.7;
            camera.position.set(center.x + Math.sin(azimuth)*distance, center.y + size.y*0.12, center.z + Math.cos(azimuth)*distance);
            camera.lookAt(center);
          }
          renderer.render(scene, camera);
          const pixels = new Uint8Array(width*height*4);
          gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
          let sum=0, sum2=0; const n = width*height;
          for (let i=0;i<pixels.length;i+=4){ const v=pixels[i]; sum+=v; sum2+=v*v; }
          const mean = sum/n; const std = Math.sqrt(Math.max(0, sum2/n - mean*mean));
          images.push({ time, angle, dataUrl: renderer.domElement.toDataURL('image/png'), mean, std });
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
      mixer.stopAllAction();
      mixer.uncacheRoot(model);
      renderer.dispose();
    } catch (error) {
      window.__result = { ok:false, error: 'render ' + String(error) };
    }
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
    return existsSync(chromium.executablePath());
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
    // A close-up can legitimately look through a solid body at one azimuth; only an entirely
    // empty set of close-ups means the renderer failed to draw the model.
    const blank = options.focus ? images.every((image) => !image.nonBlank) : images.some((image) => !image.nonBlank);
    if (blank) {
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
