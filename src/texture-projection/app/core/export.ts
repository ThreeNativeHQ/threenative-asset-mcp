import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import {
  aerialPassOnlyHidden,
  downsampleCoverage,
  PAINTED_MASK_DOWNSCALE,
  type PaintFill,
} from '../../atlas-pixels.js';
import { Atlas } from './atlas.js';
import {
  autoAtlasPages,
  buildAtlasPages,
  MAX_PAGE_ATLAS,
  MIN_MULTIPAGE_ATLAS,
} from '../../atlas-pages.js';
import type { Engine } from './engine.js';
import { toCanvas } from './image.js';
import type { Plan } from './planner.js';
import type { Level } from './scene.js';
import { makeCamera, type ViewSpec } from './views.js';

/** The GLB and, for a detail fill, the painted-coverage mask to write beside it (phase 2t). */
export interface ExportedGlb {
  readonly glb: ArrayBuffer;
  /** One byte per mask texel, atlas side / `PAINTED_MASK_DOWNSCALE` square; absent for a debug fill. */
  readonly mask: Uint8Array | undefined;
  readonly atlasPages?: number;
  readonly pageAtlasSize?: number;
  readonly texelsPerMetre?: number;
}

/**
 * The level as one mesh with the painted texture. Painted under overcast light it is albedo, so it goes on a lit
 * material for the engine to light; painted with a sun the lighting is baked in, so it goes on an unlit one
 * (KHR_materials_unlit). `fill: "debug"` bakes the holes hot pink (phase 2r): a verification export, never shipped.
 * The atlas stays opaque either way; the coverage mask travels beside it as its own file (phase 2t).
 */
export async function exportGlb(engine: Engine, fill: PaintFill = 'detail'): Promise<ExportedGlb> {
  const { data, size, inpaint } = engine.atlas.readBytes(fill);
  const tex = new THREE.CanvasTexture(toCanvas(data, size, size)); // rows already in glTF order (first row = v 0)
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  const material = engine.clay.lighting.overcast
    ? new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92, metalness: 0 })
    : new THREE.MeshBasicMaterial({ map: tex });
  const mesh = new THREE.Mesh(engine.level.geometry, material);
  mesh.name = engine.level.name;
  const glb = await new GLTFExporter().parseAsync(mesh, { binary: true, maxTextureSize: size });
  tex.dispose();
  material.dispose();
  const mask = inpaint.mask === undefined ? undefined : downsampleCoverage(inpaint.mask, size, PAINTED_MASK_DOWNSCALE);
  return { glb: glb as ArrayBuffer, mask, atlasPages: 1, pageAtlasSize: size };
}

/**
 * Split a large level into multiple balanced high-density UV atlas pages and bake each page
 * sequentially so peak VRAM matches a single-page atlas while linear texel density multiplies cleanly.
 */
export async function exportMultiPageGlb(
  engine: Engine,
  plan: Plan | undefined,
  views: readonly { spec: ViewSpec; comp: Uint8ClampedArray }[],
  opts: { fill?: PaintFill; targetPages?: number } = {},
): Promise<ExportedGlb> {
  const fill = opts.fill ?? 'detail';
  const targetPages = opts.targetPages ?? autoAtlasPages(engine.level.surfaceArea, engine.options.atlasSize);
  if (targetPages <= 1 || views.length === 0) return exportGlb(engine, fill);

  const pageAtlasSize = Math.min(MAX_PAGE_ATLAS, Math.max(engine.options.atlasSize, MIN_MULTIPAGE_ATLAS));
  const packed = buildAtlasPages(engine.level.geometry, targetPages, pageAtlasSize);
  if (packed.pages.length <= 1) {
    for (const p of packed.pages) p.geometry.dispose();
    return exportGlb(engine, fill);
  }

  // Keep the painted coverage mask in the original single-atlas UV layout while packing per-page GLB textures.
  const { inpaint } = engine.atlas.readBytes(fill);
  const mask =
    inpaint.mask === undefined
      ? undefined
      : downsampleCoverage(inpaint.mask, engine.atlas.size, PAINTED_MASK_DOWNSCALE);

  const viewSize = engine.size;
  const compTexture = new THREE.DataTexture(
    new Uint8Array(viewSize * viewSize * 4),
    viewSize,
    viewSize,
    THREE.RGBAFormat,
    THREE.UnsignedByteType,
  );
  compTexture.minFilter = THREE.LinearFilter;
  compTexture.magFilter = THREE.LinearFilter;
  compTexture.generateMipmaps = false;

  const hasAerialOrRoof = views.some((v) => aerialPassOnlyHidden(v.spec.kind));
  const playerViews = (plan?.views ?? views.map((v) => v.spec)).filter(
    (spec) => spec.kind === undefined || spec.kind === 'ground',
  );

  const group = new THREE.Group();
  group.name = engine.level.name;
  const textures: THREE.Texture[] = [];
  const materials: THREE.Material[] = [];

  try {
    for (const page of packed.pages) {
      const pageLevel: Level = {
        ...engine.level,
        name: `${engine.level.name}_page_${page.index}`,
        geometry: page.geometry,
        triangles: page.triangleCount,
        surfaceArea: page.worldArea,
      };
      const pageAtlas = new Atlas(engine.gpu, pageLevel, packed.pageAtlasSize, {
        useDeriv: true,
        maxFallbackTexelsPerPixel: 24,
      });
      let pagePlayerVisible: THREE.WebGLRenderTarget | undefined;
      try {
        if (hasAerialOrRoof && playerViews.length > 0) {
          pagePlayerVisible = pageAtlas.projectionMask(playerViews.length, (index) => {
            const camera = makeCamera(playerViews[index]!);
            engine.views.renderGeometry(camera);
            return { camera, gPos: engine.views.geometryTarget.textures[0]! };
          });
        }
        for (const v of views) {
          const camera = makeCamera(v.spec);
          // Render geometry against the full level so walls and roofs still occlude properly.
          engine.views.renderGeometry(camera);
          (compTexture.image.data as Uint8Array).set(v.comp);
          compTexture.needsUpdate = true;
          const g = engine.views.geometryTarget.textures;
          const playerMask = aerialPassOnlyHidden(v.spec.kind) ? pagePlayerVisible?.texture : undefined;
          pageAtlas.project(camera, g[0]!, g[3]!, compTexture, engine.options.projectRatio, playerMask, true);
        }
        pageAtlas.pad();
        const { data, size } = pageAtlas.readBytes(fill);
        const tex = new THREE.CanvasTexture(toCanvas(data, size, size));
        tex.flipY = false;
        tex.colorSpace = THREE.SRGBColorSpace;
        textures.push(tex);

        const material = engine.clay.lighting.overcast
          ? new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92, metalness: 0 })
          : new THREE.MeshBasicMaterial({ map: tex });
        material.name = `${engine.level.name}_mat_${page.index}`;
        materials.push(material);

        const mesh = new THREE.Mesh(page.geometry, material);
        mesh.name = `${engine.level.name}_page_${page.index}`;
        group.add(mesh);
      } finally {
        pagePlayerVisible?.dispose();
        pageAtlas.dispose();
      }
    }
    const glb = await new GLTFExporter().parseAsync(group, {
      binary: true,
      maxTextureSize: packed.pageAtlasSize,
    });
    return {
      glb: glb as ArrayBuffer,
      mask,
      atlasPages: packed.pages.length,
      pageAtlasSize: packed.pageAtlasSize,
      texelsPerMetre: Math.round(packed.texelsPerMetre),
    };
  } finally {
    compTexture.dispose();
    for (const tex of textures) tex.dispose();
    for (const mat of materials) mat.dispose();
    for (const page of packed.pages) page.geometry.dispose();
  }
}
