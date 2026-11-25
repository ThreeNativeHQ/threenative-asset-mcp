import * as THREE from 'three';
import { ATLAS_GUTTER_TEXELS, inpaintUnpainted, type InpaintReport, type PaintFill } from '../../atlas-pixels.js';
import { byteTarget, floatTarget, passMaterial, type Gpu } from './gpu.js';
import type { Level } from './scene.js';

/**
 * One image pixel may cover at most 2x2 atlas texels, along the worse of its two axes, before the
 * projection refuses it (A.2, PRD-916 phase 2d). The footprint in the geometry buffer is that worse
 * axis (views.ts), so this number is 2, not 4: 4 was the area, which let a floor at a grazing angle
 * through with one axis at 8 texels per pixel and left the stretched streaks beside the steps.
 */
export const MAX_TEXELS_PER_PIXEL = 2;

/** Cells per side of the coarse atlas grid the hole pass scores unpainted clusters on (B, phase 2d). */
export const ATLAS_GAP_CELLS = 128;

/**
 * The texture being painted, in UV space. Each texel stores sRGB colour and the quality it was captured at
 * (cos(view angle) / distance; 0 = not painted). Projection passes rasterise the level in UV space and pull
 * colour from a view's composited image wherever that view sees the texel better than what is stored.
 */
const UV_VERT = /* glsl */ `
out vec3 vWorld;
out vec3 vNormal;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}`;

const PROJECT_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D prev;
uniform sampler2D gPos;
uniform sampler2D gFoot;
uniform sampler2D comp;
uniform mat4 viewProj;
uniform vec3 camPos;
uniform float ratio;
uniform vec2 texel;
uniform float edgeRadius;
uniform float maxTexelsPerPixel;
uniform sampler2D playerVisible;
in vec3 vWorld;
in vec3 vNormal;
layout(location = 0) out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 old = texelFetch(prev, p, 0);
  outColor = old;
  // Aerial and roof passes get the mask of the texels a player-height view sees (phase 2e): a pass that
  // looks down on the level paints wall tops and outer faces, never the ground a player walks on.
  if (texelFetch(playerVisible, p, 0).r > 0.5) return;
  vec4 clip = viewProj * vec4(vWorld, 1.0);
  if (clip.w <= 0.0) return;
  vec3 ndc = clip.xyz / clip.w;
  if (abs(ndc.x) > 0.999 || abs(ndc.y) > 0.999) return;
  vec2 suv = ndc.xy * 0.5 + 0.5;
  vec3 toCam = camPos - vWorld;
  float dist = length(toCam);
  float cosv = dot(normalize(vNormal), toCam / dist);
  if (cosv < 0.35) return;   // was 0.08: steeper views smear one pixel over a wall strip
  vec4 g = texture(gPos, suv);
  bool sky = g.w <= 0.0;
  if (!sky && dist > g.w + 0.02 + 0.01 * dist) return;
  // Magnification guard (A.2): a view pixel that would cover more than 2x2 atlas texels has no
  // detail of its own to give — projected, it stretches one image pixel over many texels. Leave
  // those texels for a closer view or the hole pass instead of painting blur into the atlas.
  if (texture(gFoot, suv).r > maxTexelsPerPixel) return;
  float q = cosv / max(dist, 0.5);
  // Near a silhouette the model's image is least trustworthy (slight misalignment paints the wrong side onto
  // the edge), so capture it at reduced quality: a view that sees it away from an edge will replace it.
  float edge = 0.0;
  for (int k = 0; k < 8; k++) {
    float a = 0.7853982 * float(k);
    vec4 n = texture(gPos, suv + vec2(cos(a), sin(a)) * edgeRadius * texel);
    if (n.w <= 0.0 || abs(n.w - g.w) > 0.04 * g.w) edge = 1.0;
  }
  q *= mix(1.0, 0.3, edge);
  if (old.a > 0.0 && old.a >= ratio * q) return;
  // comp is premultiplied: pixels a view must not project (alpha 0) drop out, also from the filtered edge
  vec4 c = texture(comp, vec2(suv.x, 1.0 - suv.y));
  if (c.a < 0.5) return;
  outColor = vec4(c.rgb / c.a, q);
}`;

const ISLAND_FRAG = /* glsl */ `
layout(location = 0) out vec4 outColor;
void main() { outColor = vec4(1.0); }`;

/**
 * The paint pass without a model image: which view would win each texel, and how many atlas texels
 * that view's image pixel covers there (r = capture quality, g = texels per image pixel). The plan's
 * own footprint, measured before a single image is bought.
 */
const QUALITY_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D prev;
uniform sampler2D gPos;
uniform sampler2D gFoot;
uniform mat4 viewProj;
uniform vec3 camPos;
uniform float ratio;
uniform vec2 texel;
uniform float edgeRadius;
in vec3 vWorld;
in vec3 vNormal;
layout(location = 0) out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 old = texelFetch(prev, p, 0);
  outColor = old;
  vec4 clip = viewProj * vec4(vWorld, 1.0);
  if (clip.w <= 0.0) return;
  vec3 ndc = clip.xyz / clip.w;
  if (abs(ndc.x) > 0.999 || abs(ndc.y) > 0.999) return;
  vec2 suv = ndc.xy * 0.5 + 0.5;
  vec3 toCam = camPos - vWorld;
  float dist = length(toCam);
  float cosv = dot(normalize(vNormal), toCam / dist);
  if (cosv < 0.35) return;
  vec4 g = texture(gPos, suv);
  if (g.w > 0.0 && dist > g.w + 0.02 + 0.01 * dist) return;
  float q = cosv / max(dist, 0.5);
  float edge = 0.0;
  for (int k = 0; k < 8; k++) {
    float a = 0.7853982 * float(k);
    vec4 n = texture(gPos, suv + vec2(cos(a), sin(a)) * edgeRadius * texel);
    if (n.w <= 0.0 || abs(n.w - g.w) > 0.04 * g.w) edge = 1.0;
  }
  q *= mix(1.0, 0.3, edge);
  if (old.r > 0.0 && old.r >= ratio * q) return;
  outColor = vec4(q, texture(gFoot, suv).r, 0.0, 1.0);
}`;

const COPY_FRAG = /* glsl */ `
uniform sampler2D src;
layout(location = 0) out vec4 outColor;
void main() { outColor = texelFetch(src, ivec2(gl_FragCoord.xy), 0); }`;

const DILATE_FRAG = /* glsl */ `
uniform sampler2D src;
uniform sampler2D islands;
layout(location = 0) out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 hi = textureSize(src, 0) - 1;
  vec4 c = texelFetch(src, p, 0);
  if (c.a > 0.0 || texelFetch(islands, p, 0).r > 0.5) { outColor = c; return; }
  vec4 acc = vec4(0.0);
  float n = 0.0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      vec4 s = texelFetch(src, clamp(p + ivec2(dx, dy), ivec2(0), hi), 0);
      if (s.a > 0.0) { acc += s; n += 1.0; }
    }
  }
  outColor = n > 0.0 ? acc / n : c;
}`;

const BYTES_FRAG = /* glsl */ `
uniform sampler2D src;
layout(location = 0) out vec4 outColor;
void main() {
  vec4 c = texelFetch(src, ivec2(gl_FragCoord.xy), 0);
  // alpha keeps "painted" so readBytes can fill the rest on the CPU from the painted texels around it;
  // the exported bytes then go opaque again and the coverage mask ships as its own file (phase 2t)
  outColor = vec4(c.rgb, c.a > 0.0 ? 1.0 : 0.0);
}`;

/** 1 where this view sees the texel at all: the same grazing gate, occlusion and frame test as the projection. */
const VISIBLE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D prev;
uniform sampler2D gPos;
uniform mat4 viewProj;
uniform vec3 camPos;
in vec3 vWorld;
in vec3 vNormal;
layout(location = 0) out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 old = texelFetch(prev, p, 0);
  outColor = old;
  if (old.r > 0.5) return;
  vec4 clip = viewProj * vec4(vWorld, 1.0);
  if (clip.w <= 0.0) return;
  vec3 ndc = clip.xyz / clip.w;
  if (abs(ndc.x) > 0.999 || abs(ndc.y) > 0.999) return;
  vec2 suv = ndc.xy * 0.5 + 0.5;
  vec3 toCam = camPos - vWorld;
  float dist = length(toCam);
  float cosv = dot(normalize(vNormal), toCam / dist);
  if (cosv < 0.35) return;
  vec4 g = texture(gPos, suv);
  if (g.w > 0.0 && dist > g.w + 0.02 + 0.01 * dist) return;
  outColor = vec4(1.0);
}`;

const CELL_FRAG = /* glsl */ `
uniform sampler2D src;
uniform int cell;
layout(location = 0) out vec4 outColor;
void main() {
  ivec2 base = ivec2(gl_FragCoord.xy) * cell;
  float q = 0.0;
  for (int y = 0; y < cell; y++) for (int x = 0; x < cell; x++) q = max(q, texelFetch(src, base + ivec2(x, y), 0).a);
  outColor = vec4(q, 0.0, 0.0, 1.0);
}`;

const STATS_FRAG = /* glsl */ `
uniform sampler2D src;
uniform sampler2D islands;
uniform float step;
layout(location = 0) out vec4 outColor;
void main() {
  ivec2 p = ivec2((gl_FragCoord.xy - 0.5) * step + 0.5 * step);
  float island = texelFetch(islands, p, 0).r;
  float known = texelFetch(src, p, 0).a > 0.0 ? 1.0 : 0.0;
  outColor = vec4(island, known * island, 0.0, 1.0);
}`;

const MASK_FRAG = /* glsl */ `
uniform sampler2D src;
layout(location = 0) out vec4 outColor;
void main() {
  bool painted = texelFetch(src, ivec2(gl_FragCoord.xy), 0).a > 0.0;
  outColor = painted ? vec4(1.0) : vec4(0.0);
}`;

/**
 * Cells of one atlas region: red = texels a view sees, green = of those, painted, blue = the gap.
 * `cell` texels per side, sampled `stride` texels apart (a fixed 4x4 grid whatever the atlas size).
 */
const VISIBLE_STATS_FRAG = /* glsl */ `
uniform sampler2D visible;
uniform sampler2D src;
uniform int cell;
uniform int stride;
layout(location = 0) out vec4 outColor;
void main() {
  ivec2 base = ivec2(gl_FragCoord.xy) * cell;
  float seen = 0.0, painted = 0.0;
  for (int y = 0; y < 4; y++) {
    for (int x = 0; x < 4; x++) {
      ivec2 p = base + ivec2(x, y) * stride;
      if (texelFetch(visible, p, 0).r <= 0.5) continue;
      seen += 1.0;
      if (texelFetch(src, p, 0).a > 0.0) painted += 1.0;
    }
  }
  outColor = vec4(seen, painted, seen - painted, 1.0);
}`;

export class Atlas {
  private a: THREE.WebGLRenderTarget;
  private b: THREE.WebGLRenderTarget;
  /** Padded copy (UV gutters filled) used for display, state renders and export. */
  readonly display: THREE.WebGLRenderTarget;
  private readonly temp: THREE.WebGLRenderTarget;
  readonly islands: THREE.WebGLRenderTarget;
  private readonly uvScene = new THREE.Scene();
  private readonly uvMesh: THREE.Mesh;
  private readonly uvCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly projectMat: THREE.ShaderMaterial;
  /** 1x1 black: the default player-visible mask, so a player-height view projects everywhere it can see. */
  private readonly noPlayerVisible = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  private readonly qualityMat: THREE.ShaderMaterial;
  private readonly visibleMat: THREE.ShaderMaterial;
  private readonly islandMat: THREE.ShaderMaterial;
  /** 1 per texel inside a UV island (what the level's UVs cover), read once: UVs never change. */
  readonly islandMask: Uint8Array;
  private readonly copyMat = passMaterial(COPY_FRAG, { src: { value: null } });
  private readonly dilateMat = passMaterial(DILATE_FRAG, { src: { value: null }, islands: { value: null } });
  private readonly bytesMat = passMaterial(BYTES_FRAG, { src: { value: null } });
  private readonly cellMat = passMaterial(CELL_FRAG, { src: { value: null }, cell: { value: 32 } });
  private readonly statsMat = passMaterial(STATS_FRAG, { src: { value: null }, islands: { value: null }, step: { value: 8 } });
  private readonly visibleStatsMat = passMaterial(VISIBLE_STATS_FRAG, {
    visible: { value: null }, src: { value: null }, cell: { value: 32 }, stride: { value: 8 },
  });

  constructor(private readonly gpu: Gpu, level: Level, readonly size = 4096) {
    this.noPlayerVisible.needsUpdate = true;
    this.a = floatTarget(size, size, { half: true, linear: true });
    this.b = floatTarget(size, size, { half: true, linear: true });
    this.display = floatTarget(size, size, { half: true, linear: true });
    this.temp = floatTarget(size, size, { half: true, linear: true });
    this.islands = byteTarget(size, size, { linear: false });
    this.projectMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: UV_VERT, fragmentShader: PROJECT_FRAG, side: THREE.DoubleSide,
      depthTest: false, depthWrite: false,
      uniforms: { prev: { value: null }, gPos: { value: null }, gFoot: { value: null }, comp: { value: null },
        viewProj: { value: new THREE.Matrix4() },
        camPos: { value: new THREE.Vector3() }, ratio: { value: 0.4 }, texel: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
        edgeRadius: { value: 6 }, maxTexelsPerPixel: { value: MAX_TEXELS_PER_PIXEL }, playerVisible: { value: null } },
    });
    this.islandMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: UV_VERT, fragmentShader: ISLAND_FRAG, side: THREE.DoubleSide,
      depthTest: false, depthWrite: false,
    });
    this.qualityMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: UV_VERT, fragmentShader: QUALITY_FRAG, side: THREE.DoubleSide,
      depthTest: false, depthWrite: false,
      uniforms: { prev: { value: null }, gPos: { value: null }, gFoot: { value: null }, viewProj: { value: new THREE.Matrix4() },
        camPos: { value: new THREE.Vector3() }, ratio: { value: 0.4 }, texel: { value: new THREE.Vector2(1 / 1024, 1 / 1024) },
        edgeRadius: { value: 6 } },
    });
    this.visibleMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: UV_VERT, fragmentShader: VISIBLE_FRAG, side: THREE.DoubleSide,
      depthTest: false, depthWrite: false,
      uniforms: { prev: { value: null }, gPos: { value: null }, viewProj: { value: new THREE.Matrix4() },
        camPos: { value: new THREE.Vector3() } },
    });
    this.uvMesh = new THREE.Mesh(level.geometry, this.islandMat);
    this.uvMesh.frustumCulled = false;
    this.uvScene.add(this.uvMesh);
    this.gpu.draw(this.uvScene, this.uvCam, this.islands, 0x000000, 0);
    const islandPixels = this.gpu.readU8(this.islands, 0, false);
    this.islandMask = new Uint8Array(size * size);
    for (let i = 0; i < this.islandMask.length; i++) this.islandMask[i] = islandPixels[4 * i]! > 127 ? 1 : 0;
    this.reset();
  }

  /** The padded texture to sample (rgb = sRGB colour, a = capture quality, 0 = unpainted). */
  get texture(): THREE.Texture {
    return this.display.texture;
  }

  reset() {
    for (const t of [this.a, this.b, this.display, this.temp]) this.gpu.draw(new THREE.Scene(), this.uvCam, t, 0x000000, 0);
  }

  /**
   * Paint from one view: `gPos` is that view's position/distance buffer, `gFoot` its texels-per-pixel buffer,
   * `comp` its composited image. `playerVisible` (1 per texel a player-height view sees) restricts an aerial or
   * roof pass to the texels no player camera can see; undefined lets the projection's own gates decide.
   */
  project(camera: THREE.Camera, gPos: THREE.Texture, gFoot: THREE.Texture, comp: THREE.Texture, ratio: number, playerVisible?: THREE.Texture) {
    this.copyMat.uniforms.src.value = this.a.texture;
    this.gpu.pass(this.copyMat, this.b);
    const u = this.projectMat.uniforms;
    u.prev.value = this.a.texture;
    u.gPos.value = gPos;
    u.gFoot.value = gFoot;
    u.comp.value = comp;
    u.viewProj.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    u.camPos.value.setFromMatrixPosition(camera.matrixWorld);
    u.ratio.value = ratio;
    const img = gPos.image as { width: number; height: number };
    u.texel.value.set(1 / img.width, 1 / img.height);
    u.edgeRadius.value = (6 * img.width) / 1024;   // same angular band at any view size
    u.playerVisible.value = playerVisible ?? this.noPlayerVisible;
    this.uvMesh.material = this.projectMat;
    this.gpu.draw(this.uvScene, this.uvCam, this.b, null);
    this.uvMesh.material = this.islandMat;
    [this.a, this.b] = [this.b, this.a];
    this.pad();
  }

  /**
   * Fill UV gutters around islands so bilinear sampling never pulls in unpainted texels. Eight
   * 3x3 dilations are eight texels of gutter, the >= 8 px guard C.2 asks for; readBytes then fills
   * what is still empty from the painted texels around it (push-pull).
   */
  pad(iterations = ATLAS_GUTTER_TEXELS) {
    this.copyMat.uniforms.src.value = this.a.texture;
    this.gpu.pass(this.copyMat, this.display);
    this.dilateMat.uniforms.islands.value = this.islands.texture;
    let src = this.display;
    let dst = this.temp;
    for (let i = 0; i < iterations; i++) {
      this.dilateMat.uniforms.src.value = src.texture;
      this.gpu.pass(this.dilateMat, dst);
      [src, dst] = [dst, src];
    }
    if (src !== this.display) {
      this.copyMat.uniforms.src.value = src.texture;
      this.gpu.pass(this.copyMat, this.display);
    }
  }

  /**
   * What the painter would win from these views, texel by texel: r = the winning view's capture quality,
   * g = atlas texels that view's image pixel covers. No model image is involved, so a quote can report
   * the footprint before anything is bought. Targets are transient; the atlas is left untouched.
   */
  measureProjection(
    count: number,
    prepare: (index: number) => { camera: THREE.Camera; gPos: THREE.Texture; foot: THREE.Texture },
    ratio: number,
  ): Float32Array {
    let from = floatTarget(this.size, this.size);
    let into = floatTarget(this.size, this.size);
    try {
      for (const target of [from, into]) this.gpu.draw(new THREE.Scene(), this.uvCam, target, 0x000000, 0);
      for (let index = 0; index < count; index++) {
        // Geometry must be rendered for this view *now*: the buffers are one target, reused per view.
        const view = prepare(index);
        const u = this.qualityMat.uniforms;
        u.prev.value = from.texture;
        u.gPos.value = view.gPos;
        u.gFoot.value = view.foot;
        u.viewProj.value.multiplyMatrices(view.camera.projectionMatrix, view.camera.matrixWorldInverse);
        u.camPos.value.setFromMatrixPosition(view.camera.matrixWorld);
        u.ratio.value = ratio;
        const img = view.gPos.image as { width: number; height: number };
        u.texel.value.set(1 / img.width, 1 / img.height);
        u.edgeRadius.value = (6 * img.width) / 1024;
        this.uvMesh.material = this.qualityMat;
        this.gpu.draw(this.uvScene, this.uvCam, into, null);
        this.uvMesh.material = this.islandMat;
        [from, into] = [into, from];
      }
      return this.gpu.readF32(from, 0, false);
    } finally {
      this.uvMesh.material = this.islandMat;
      from.dispose();
      into.dispose();
    }
  }

  /** 1 where the texture holds any paint at all (alpha > 0), for measuring a finished run. */
  paintedMask(): Uint8Array {
    const rt = byteTarget(this.size, this.size, { linear: false });
    const mat = passMaterial(MASK_FRAG, { src: { value: this.a.texture } });
    this.gpu.pass(mat, rt);
    const px = this.gpu.readU8(rt, 0, false);
    rt.dispose();
    const out = new Uint8Array(this.size * this.size);
    for (let i = 0; i < out.length; i++) out[i] = px[4 * i]! > 127 ? 1 : 0;
    return out;
  }

  /** Share of island texels painted so far (sampled every 8th texel). */
  coverage(): number {
    const n = Math.floor(this.size / 8);
    const rt = byteTarget(n, n, { linear: false });
    this.statsMat.uniforms.src.value = this.a.texture;
    this.statsMat.uniforms.islands.value = this.islands.texture;
    this.gpu.pass(this.statsMat, rt);
    const px = this.gpu.readU8(rt, 0, false);
    rt.dispose();
    let island = 0;
    let known = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] > 127) island++;
      if (px[i + 1] > 127) known++;
    }
    return island ? known / island : 0;
  }

  /** Best capture quality per UV cell (grid x grid, row = v), for planning views that fill what's missing. */
  cellQuality(grid: number): Float32Array {
    const rt = floatTarget(grid, grid);
    this.cellMat.uniforms.src.value = this.a.texture;
    this.cellMat.uniforms.cell.value = Math.floor(this.size / grid);
    this.gpu.pass(this.cellMat, rt);
    const px = this.gpu.readF32(rt, 0, false);
    rt.dispose();
    const q = new Float32Array(grid * grid);
    for (let i = 0; i < q.length; i++) q[i] = px[4 * i];
    return q;
  }

  /**
   * A GPU mask: 1 where at least one of these views sees the texel with the projection's own gates (in
   * frame, the 0.35 grazing gate, not occluded) — the texels a player standing at these cameras can
   * see. It stays on the GPU because a 4096 atlas is 16 M texels; `visibleStats` reads the counters.
   * The caller disposes the target.
   */
  projectionMask(
    count: number,
    prepare: (index: number) => { camera: THREE.Camera; gPos: THREE.Texture },
  ): THREE.WebGLRenderTarget {
    const from = byteTarget(this.size, this.size, { linear: false });
    let into = byteTarget(this.size, this.size, { linear: false });
    let src = from;
    let dst = into;
    try {
      for (const target of [from, into]) this.gpu.draw(new THREE.Scene(), this.uvCam, target, 0x000000, 0);
      for (let index = 0; index < count; index++) {
        // Geometry must be rendered for this view now: the buffers are one target, reused per view.
        const view = prepare(index);
        const u = this.visibleMat.uniforms;
        u.prev.value = src.texture;
        u.gPos.value = view.gPos;
        u.viewProj.value.multiplyMatrices(view.camera.projectionMatrix, view.camera.matrixWorldInverse);
        u.camPos.value.setFromMatrixPosition(view.camera.matrixWorld);
        this.uvMesh.material = this.visibleMat;
        this.gpu.draw(this.uvScene, this.uvCam, dst, null);
        this.uvMesh.material = this.islandMat;
        [src, dst] = [dst, src];
      }
      // One of the two ping-pong targets holds the result for `visibleStats`; the other is done.
      dst.dispose();
      return src;
    } catch (error) {
      from.dispose();
      into.dispose();
      throw error;
    } finally {
      this.uvMesh.material = this.islandMat;
    }
  }

  /**
   * How much of what these views see the atlas has painted, cell by cell: the whole atlas counted for
   * `visibleCoveragePercent`, and the same counts on a coarse grid as the map of the largest unpainted
   * clusters the hole pass aims at (B, phase 2d).
   */
  visibleStats(
    visible: THREE.Texture,
    grid = ATLAS_GAP_CELLS,
  ): { seen: number; painted: number; gapPercent: number; gapCells: Float32Array } {
    const rt = byteTarget(grid, grid, { linear: false });
    this.visibleStatsMat.uniforms.visible.value = visible;
    this.visibleStatsMat.uniforms.src.value = this.a.texture;
    this.visibleStatsMat.uniforms.cell.value = Math.floor(this.size / grid);
    this.visibleStatsMat.uniforms.stride.value = Math.max(1, Math.floor(this.size / grid / 4));
    this.gpu.pass(this.visibleStatsMat, rt);
    const px = this.gpu.readU8(rt, 0, false);
    rt.dispose();
    const gapCells = new Float32Array(grid * grid);
    let seen = 0;
    let painted = 0;
    for (let i = 0; i < gapCells.length; i++) {
      seen += px[4 * i]!;
      painted += px[4 * i + 1]!;
      gapCells[i] = px[4 * i + 2]!;
    }
    return { seen, painted, gapPercent: seen > 0 ? (100 * (seen - painted)) / seen : 0, gapCells };
  }

  /**
   * RGBA8 export of the padded texture in glTF image order (first row = v 0), opaque everywhere. Texels
   * no view painted are filled from the painted texels around them (push-pull, per island), never with
   * one global mean, so a gap continues the material that surrounds it (A, phase 2d); `fill: "debug"`
   * writes them hot pink instead, so a capture can count them (phase 2r). The report also carries the
   * painted-coverage mask at atlas resolution (phase 2t).
   */
  readBytes(fill: PaintFill = 'detail'): { data: Uint8ClampedArray; size: number; inpaint: InpaintReport } {
    const rt = byteTarget(this.size, this.size, { linear: false });
    this.bytesMat.uniforms.src.value = this.display.texture;
    this.gpu.pass(this.bytesMat, rt);
    const data = this.gpu.readU8(rt, 0, false);
    rt.dispose();
    const inpaint = inpaintUnpainted(data, this.islandMask, this.size, undefined, fill);
    return { data, size: this.size, inpaint };
  }

  dispose() {
    for (const t of [this.a, this.b, this.display, this.temp, this.islands]) t.dispose();
  }
}
