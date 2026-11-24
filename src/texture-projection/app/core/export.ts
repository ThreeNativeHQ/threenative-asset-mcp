import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import type { PaintFill } from '../../atlas-pixels.js';
import type { Engine } from './engine.js';
import { toCanvas } from './image.js';

/**
 * The level as one mesh with the painted texture. Painted under overcast light it is albedo, so it goes on a lit
 * material for the engine to light; painted with a sun the lighting is baked in, so it goes on an unlit one
 * (KHR_materials_unlit). `fill: "debug"` bakes the holes hot pink (phase 2r): a verification export, never shipped.
 */
export async function exportGlb(engine: Engine, fill: PaintFill = 'detail'): Promise<ArrayBuffer> {
  const { data, size } = engine.atlas.readBytes(fill);
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
  return glb as ArrayBuffer;
}
