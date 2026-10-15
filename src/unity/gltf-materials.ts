/** Writes a {@link ResolvedMaterial} into a glTF-Transform material. Pixels come from an {@link ImageSource}. */
import type { Document, Material, Texture } from "@gltf-transform/core";
import { KHRMaterialsEmissiveStrength, KHRMaterialsSpecular, KHRTextureTransform } from "@gltf-transform/extensions";

import type { ResolvedMaterial, TextureSlot } from "./materials.js";
import type { ImageRecipe } from "./textures.js";

export interface StoredImage {
  readonly name: string;
  readonly png: Buffer;
}
/** Renders (once per run) and returns the image a recipe describes. May throw UnityTextureError. */
export type ImageSource = (recipe: ImageRecipe) => Promise<StoredImage>;

function extension<T extends KHRMaterialsEmissiveStrength | KHRMaterialsSpecular | KHRTextureTransform>(
  document: Document,
  type: (new (document: Document) => T) & { EXTENSION_NAME: string },
): T {
  const existing = document.getRoot().listExtensionsUsed().find((candidate) => candidate.extensionName === type.EXTENSION_NAME);
  return (existing as unknown as T | undefined) ?? (document.createExtension(type) as unknown as T);
}

/** A per-document cache, so one image used by two materials becomes one glTF texture. */
export class TextureCache {
  private readonly textures = new Map<string, Texture>();
  constructor(private readonly document: Document) {}

  async get(slot: TextureSlot, source: ImageSource): Promise<Texture> {
    const image = await source(slot.recipe);
    const key = image.name;
    let texture = this.textures.get(key);
    if (!texture) {
      texture = this.document.createTexture(image.name).setImage(new Uint8Array(image.png)).setMimeType("image/png");
      this.textures.set(key, texture);
    }
    return texture;
  }
}

/**
 * Replaces everything Blender wrote on `target` with the resolved Unity material. Returns the warnings of
 * slots whose image could not be built; those slots stay empty and the factors are kept.
 */
export async function applyResolvedMaterial(
  document: Document,
  cache: TextureCache,
  target: Material,
  resolved: ResolvedMaterial,
  source: ImageSource,
): Promise<string[]> {
  const warnings: string[] = [];
  const transformExtension = (): KHRTextureTransform => extension(document, KHRTextureTransform);

  target
    .setBaseColorTexture(null)
    .setMetallicRoughnessTexture(null)
    .setNormalTexture(null)
    .setOcclusionTexture(null)
    .setEmissiveTexture(null)
    .setExtension("KHR_materials_specular", null)
    .setExtension("KHR_materials_emissive_strength", null);

  const bind = async (
    label: string,
    slot: TextureSlot | undefined,
    set: (texture: Texture) => void,
    info: () => { setExtension(name: string, value: unknown): unknown },
  ): Promise<void> => {
    if (!slot) return;
    try {
      set(await cache.get(slot, source));
    } catch (error) {
      warnings.push(`${label}: ${error instanceof Error ? error.message : "texture could not be built"}`);
      return;
    }
    if (slot.transform) {
      info().setExtension(
        "KHR_texture_transform",
        transformExtension().createTransform().setScale([...slot.transform.scale]).setOffset([...slot.transform.offset]),
      );
    }
  };

  target
    .setName(resolved.name)
    .setBaseColorFactor([...resolved.baseColorFactor])
    .setMetallicFactor(resolved.metallicFactor)
    .setRoughnessFactor(resolved.roughnessFactor)
    .setEmissiveFactor([...resolved.emissiveFactor])
    .setAlphaMode(resolved.alphaMode)
    .setDoubleSided(resolved.doubleSided);
  if (resolved.alphaCutoff !== undefined) target.setAlphaCutoff(resolved.alphaCutoff);

  await bind("base colour", resolved.baseColor, (texture) => target.setBaseColorTexture(texture), () => target.getBaseColorTextureInfo()!);
  await bind(
    "metallic-roughness",
    resolved.metallicRoughness,
    (texture) => target.setMetallicRoughnessTexture(texture),
    () => target.getMetallicRoughnessTextureInfo()!,
  );
  await bind(
    "normal",
    resolved.normal,
    (texture) => target.setNormalTexture(texture).setNormalScale(resolved.normal!.scale),
    () => target.getNormalTextureInfo()!,
  );
  await bind(
    "occlusion",
    resolved.occlusion,
    (texture) => target.setOcclusionTexture(texture).setOcclusionStrength(resolved.occlusion!.strength),
    () => target.getOcclusionTextureInfo()!,
  );
  await bind("emissive", resolved.emissive, (texture) => target.setEmissiveTexture(texture), () => target.getEmissiveTextureInfo()!);

  if (resolved.emissiveStrength !== undefined) {
    const strength = extension(document, KHRMaterialsEmissiveStrength);
    target.setExtension("KHR_materials_emissive_strength", strength.createEmissiveStrength().setEmissiveStrength(resolved.emissiveStrength));
  }
  if (resolved.specular) {
    const specular = extension(document, KHRMaterialsSpecular);
    const created = specular.createSpecular().setSpecularColorFactor([...resolved.specular.colorFactor]);
    target.setExtension("KHR_materials_specular", created);
    await bind(
      "specular colour",
      resolved.specular.colorTexture,
      (texture) => created.setSpecularColorTexture(texture),
      () => created.getSpecularColorTextureInfo()!,
    );
  }
  return warnings;
}

/** Disposes textures that no material uses any more (Blender's own, after the materials were replaced). */
export function disposeOrphanTextures(document: Document): void {
  for (const texture of document.getRoot().listTextures()) {
    if (texture.listParents().every((parent) => parent.propertyType === "Root")) texture.dispose();
  }
}
