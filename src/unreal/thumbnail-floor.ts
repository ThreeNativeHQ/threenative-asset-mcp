import type * as Three from "three";

/** The caller's source record; no engine asset is bundled or fetched by this module. */
export interface ThumbnailGridSource {
  readonly reference: string;
  readonly engine: string;
  readonly bytesSha256: string;
}

/** Decoded RGBA8 pixels of a caller's Grid, row-major with the top row first, and their provenance. Never fetched here. */
export interface ThumbnailSourceGrid {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
  readonly source: ThumbnailGridSource;
}

/** Absolute glTF metres map to UE (X,Y,Z) centimetres as (x,z,y)*100. */
export function thumbnailFloorInputs(x: number, z: number, cameraY: number): { coarse: [number, number]; fine: [number, number]; fade: number } {
  const coarse: [number, number] = [x * 100 / 256, z * 100 / 256];
  return { coarse, fine: [coarse[0] / 0.1, coarse[1] / 0.1], fade: 1 - Math.min(1, Math.max(0, (cameraY * 100 - 512) / 512)) };
}

/** g and h are the already sRGB-decoded, filtered red samples, not display bytes. */
export function thumbnailFloorSurface(g: number, h: number, fade: number): { baseColor: number; roughness: number } {
  const q = (g + h / 4 * fade) * 0.5 + 0.25;
  return {
    baseColor: 0.20000000298023224 * (0.33000001311302185 + (0.6054844260215759 - 0.33000001311302185) * q),
    roughness: 0.4000000059604645 + (0.800000011920929 - 0.4000000059604645) * g,
  };
}

/**
 * Original implementation of the UE 4.19.2 thumbnail floor's numeric graph, recovered from the official release reference.
 * FloorPlaneMaterial SHA-1 783d9d7254ec5da75b885cc081b5c1a0218452e6; Grid SHA-1 e6e5a5077c3c54e99a960282aaa811509017d164.
 * The graph's missing Lerp pins use source class defaults (MaterialExpressions.cpp:2577–2595): A=0, B=1, Alpha=.5.
 * Source Grid SRGB is absent in its complete property parse, so its true class default applies. The coarse period is 256cm;
 * the fine period is 25.6cm and fades between camera heights 512–1024cm. Roughness reads only the coarse grid.
 * This material keeps Three's Standard BRDF and shadow code. Without a supplied licensed Grid, its plain procedural checker
 * is explicitly an approximation: it does not recreate the source's authored edge pixels or mip chain. No engine asset is copied.
 * Self-contained for contact-sheet browser execution via toString(), as with the thumbnail lighting helper.
 */
export function createThumbnailReferenceFloor(
  THREE: typeof Three,
  supplied?: { readonly texture: Three.Texture; readonly source: ThumbnailGridSource },
): { material: Three.MeshStandardMaterial; source?: ThumbnailGridSource; limitations: string[]; dispose: () => void } {
  let provenance: ThumbnailGridSource | undefined;
  if (supplied) {
    // Each field is checked as a string: a one-element array of a digest would pass the regex test by stringifying.
    const { reference, engine, bytesSha256 } = (supplied.source ?? {}) as Partial<ThumbnailGridSource>;
    if (typeof reference !== "string" || !reference || typeof engine !== "string" || !engine || typeof bytesSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(bytesSha256)) {
      throw new Error("source Grid needs a reference, engine and SHA-256 provenance");
    }
    // Only the declared fields: a spread would carry any extra key (an array, say) into the floor's record.
    provenance = { reference, engine, bytesSha256 };
  }
  // A plain two-by-two checker, generated independently; the raster resolution is a portable sampling choice, not source pixels.
  let texture = supplied?.texture;
  if (!texture) {
    const rgba = new Uint8Array(64 * 64 * 4);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      const at = (y * 64 + x) * 4;
      const value = ((x < 32) === (y < 32)) ? 0 : 255;
      rgba[at] = rgba[at + 1] = rgba[at + 2] = value;
      rgba[at + 3] = 255;
    }
    texture = new THREE.DataTexture(rgba, 64, 64, THREE.RGBAFormat);
  }
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.thumbnailGrid = { value: texture };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 thumbnailFloorWorld;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nthumbnailFloorWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 thumbnailFloorWorld;\nuniform sampler2D thumbnailGrid;")
      .replace("#include <color_fragment>", `#include <color_fragment>
        vec2 thumbnailUV = thumbnailFloorWorld.xz * 100.0 / 256.0;
        float thumbnailCoarse = texture2D(thumbnailGrid, thumbnailUV).r;
        float thumbnailFine = texture2D(thumbnailGrid, thumbnailUV / 0.1).r;
        float thumbnailFade = 1.0 - clamp((cameraPosition.y * 100.0 - 512.0) / 512.0, 0.0, 1.0);
        float thumbnailQ = mix(thumbnailCoarse + thumbnailFine / 4.0 * thumbnailFade, 0.5, 0.5);
        diffuseColor.rgb *= 0.20000000298023224 * mix(vec3(0.33000001311302185), vec3(0.6054844260215759), thumbnailQ);`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
        roughnessFactor = mix(0.4000000059604645, 0.800000011920929, thumbnailCoarse);`);
  };
  material.customProgramCacheKey = () => "thumbnail-floor-ue4.19.2/1";
  const limitations = [
    "Three Standard BRDF and primary-only PCF shadows approximate the UE material response",
    "portable linear/repeat filtering and generated mip chain are an approximation of source Grid sampling",
    "floor plane geometry and placement approximate EditorPlane; saved thumbnail editor/config unknown",
    ...(supplied ? [] : ["procedural checker replaces licensed Grid: an approximation without its authored edge pixels"]),
  ];
  material.userData.thumbnailFloor = { engine: "4.19.2", ...(provenance ? { source: { ...provenance } } : {}), limitations };
  return { material, ...(provenance ? { source: { ...provenance } } : {}), limitations, dispose() { material.dispose(); if (!supplied) texture.dispose(); } };
}
