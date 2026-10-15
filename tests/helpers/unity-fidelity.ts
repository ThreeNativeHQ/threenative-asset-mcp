/** Synthetic GLBs, previews and import folders for the Unity fidelity tests. Nothing here is real or licensed. */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import sharp from "sharp";

import { renderTiles } from "../../src/unreal/contact-sheet.js";
import type { RgbaImage } from "../../src/unreal/image-diff.js";
import { TextureCache, applyResolvedMaterial } from "../../src/unity/gltf-materials.js";
import type { UnityImportReport } from "../../src/unity/importer.js";
import { identifyShader, readMaterial, resolveMaterial, type ResolvedMaterial } from "../../src/unity/materials.js";
import { type DecodedImage, type TextureSettings, encodePng, recipeKey, renderRecipe } from "../../src/unity/textures.js";
import { parseUnityDocuments } from "../../src/unity/yaml.js";
import { guidFor } from "./unity-fixtures.js";
import { DEFAULT_TEXTURE, type MaterialSpec, materialYaml, textureLookup } from "./unity-models.js";

export type Geometry = "quad" | "cube";

/** Adds an axis-aligned unit cube (half edge 0.5 * `size`) or an XY quad (half edge `size`) with UVs. */
function addGeometry(document: Document, geometry: Geometry, size: number) {
  const buffer = document.createBuffer();
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  if (geometry === "quad") {
    positions.push(-size, -size, 0, size, -size, 0, size, size, 0, -size, size, 0);
    normals.push(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1);
    uvs.push(0, 1, 1, 1, 1, 0, 0, 0);
    indices.push(0, 1, 2, 0, 2, 3);
  } else {
    const faces: [number[], number[]][] = [
      [[1, 0, 0], [0, 1, 0]],
      [[-1, 0, 0], [0, 0, 1]],
      [[0, 1, 0], [0, 0, 1]],
      [[0, -1, 0], [1, 0, 0]],
      [[0, 0, 1], [1, 0, 0]],
      [[0, 0, -1], [0, 1, 0]],
    ];
    for (const [n, u] of faces) {
      const v = [n[1]! * u[2]! - n[2]! * u[1]!, n[2]! * u[0]! - n[0]! * u[2]!, n[0]! * u[1]! - n[1]! * u[0]!];
      const base = positions.length / 3;
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
        for (let axis = 0; axis < 3; axis++) positions.push((n[axis]! + a * u[axis]! + b * v[axis]!) * 0.5 * size);
        normals.push(...n);
        uvs.push((a + 1) / 2, 1 - (b + 1) / 2);
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const accessor = (type: "VEC3" | "VEC2" | "SCALAR", array: Float32Array<ArrayBuffer> | Uint16Array<ArrayBuffer>) =>
    document.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  return document
    .createPrimitive()
    .setAttribute("POSITION", accessor("VEC3", new Float32Array(positions)))
    .setAttribute("NORMAL", accessor("VEC3", new Float32Array(normals)))
    .setAttribute("TEXCOORD_0", accessor("VEC2", new Float32Array(uvs)))
    .setIndices(accessor("SCALAR", new Uint16Array(indices)));
}

async function writeDocument(path: string, document: Document, name: string, primitive: ReturnType<typeof addGeometry>): Promise<void> {
  const mesh = document.createMesh(name).addPrimitive(primitive);
  document.createScene().addChild(document.createNode(name).setMesh(mesh));
  await mkdir(dirname(path), { recursive: true });
  await new NodeIO().registerExtensions(ALL_EXTENSIONS).write(path, document);
}

/** A cube of edge `size` with a plain base-colour factor (linear). */
export async function writePlainCube(path: string, name: string, factor: readonly [number, number, number], size = 1): Promise<void> {
  const document = new Document();
  const primitive = addGeometry(document, "cube", size).setMaterial(
    document.createMaterial(name).setBaseColorFactor([factor[0], factor[1], factor[2], 1]).setMetallicFactor(0).setRoughnessFactor(1),
  );
  await writeDocument(path, document, name, primitive);
}

export interface UnityMaterialFixture {
  readonly geometry: Geometry;
  readonly spec: MaterialSpec;
  /** Project path to PNG bytes (and, optionally, the importer settings the texture's `.meta` would carry). */
  readonly textures?: Readonly<Record<string, { readonly png: Buffer; readonly settings?: Partial<TextureSettings> }>>;
}

/** The resolved material the production resolver makes for a fixture (no glTF written). */
export function resolveFixture(fixture: UnityMaterialFixture): ResolvedMaterial {
  const material = readMaterial(parseUnityDocuments(materialYaml(fixture.spec)), fixture.spec.name);
  if (!material) throw new Error("fixture has no Material document");
  const known = Object.fromEntries(Object.entries(fixture.textures ?? {}).map(([path, texture]) => [path, texture.settings ?? {}]));
  return resolveMaterial(material, identifyShader(material.shader, () => undefined), textureLookup(known));
}

async function decodePng(png: Buffer): Promise<DecodedImage> {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data };
}

/**
 * Writes a GLB whose material goes through the production path: `.mat` YAML, `readMaterial`, `resolveMaterial`,
 * `renderRecipe` for the packed images and `applyResolvedMaterial`. Only Blender and the package are left out, so a
 * change to any rule in `src/unity/materials.ts` changes the file.
 */
export async function writeUnityMaterialGlb(path: string, fixture: UnityMaterialFixture): Promise<ResolvedMaterial> {
  const resolved = resolveFixture(fixture);
  const byGuid = new Map(
    Object.entries(fixture.textures ?? {}).map(([texturePath, texture]) => [guidFor(texturePath), { ...texture, settings: { ...DEFAULT_TEXTURE, ...texture.settings } }]),
  );
  const document = new Document();
  const primitive = addGeometry(document, fixture.geometry, 1);
  const target = document.createMaterial(fixture.spec.name);
  primitive.setMaterial(target);
  await applyResolvedMaterial(document, new TextureCache(document), target, resolved, async (recipe) => {
    const image = await renderRecipe(recipe, {
      load: (guid) => decodePng(byGuid.get(guid)!.png),
      settings: (guid) => byGuid.get(guid)!.settings,
    });
    return { name: `image-${Buffer.from(recipeKey(recipe)).toString("base64url").slice(-12)}`, png: await encodePng(image) };
  });
  await writeDocument(path, document, fixture.spec.name, primitive);
  return resolved;
}

export async function pngFromRgba(image: RgbaImage): Promise<Buffer> {
  return sharp(Buffer.from(image.data), { raw: { width: image.width, height: image.height, channels: 4 } }).png().toBuffer();
}

/** What the Editor would show for a model: the GLB rendered by the production tile renderer, as PNG bytes. */
export async function renderPreviewPng(glbPath: string, tile = 160): Promise<Buffer> {
  const result = await renderTiles({ glbPaths: [glbPath], tile });
  if (!result.rendered[0]) throw new Error(`could not render ${glbPath}`);
  return pngFromRgba(result.tiles[0]!);
}

export interface SyntheticPiece {
  readonly name: string;
  /** Project path of the model, `Assets/Models/<name>.fbx` unless given. */
  readonly source?: string;
  /** Linear base colour of the imported cube. */
  readonly factor: readonly [number, number, number];
  /** Edge of the imported cube in metres. */
  readonly size?: number;
  /** Name of a shared material path to mark the model as textured in the report. */
  readonly textured?: boolean;
  /**
   * Also writes a prefab GLB (`prefabs/<name>.glb`, source `Assets/Prefabs/<name>.prefab`) of this linear colour, with the
   * piece itself then standing for the model-level GLB, which carries no `.mat` binding: that one is neutral grey.
   */
  readonly prefabFactor?: readonly [number, number, number];
}

/** An import folder as `importUnityPackage` leaves it, with cube GLBs standing in for converted models. */
export async function writeSyntheticImport(importDir: string, pieces: readonly SyntheticPiece[]): Promise<UnityImportReport> {
  const models = [];
  const prefabs: UnityImportReport["prefabs"][number][] = [];
  for (const piece of pieces) {
    const size = piece.size ?? 1;
    await writePlainCube(join(importDir, "models", `${piece.name}.glb`), piece.name, piece.prefabFactor ? [0.2, 0.2, 0.2] : piece.factor, size);
    if (piece.prefabFactor) {
      await writePlainCube(join(importDir, "prefabs", `${piece.name}.glb`), piece.name, piece.prefabFactor, size);
      prefabs.push({
        name: piece.name,
        source: `Assets/Prefabs/${piece.name}.prefab`,
        glb: `prefabs/${piece.name}.glb`,
        bytes: 0,
        nodes: 2,
        meshNodes: 1,
        vertices: 24,
        sizeMeters: { x: size, y: size, z: size },
        boundSlots: 1,
        materials: [],
        colliders: [],
        components: [],
        lodLevels: [],
        inactive: [],
        unresolved: [],
        warnings: [],
      });
    }
    models.push({
      name: piece.name,
      source: piece.source ?? `Assets/Models/${piece.name}.fbx`,
      glb: `models/${piece.name}.glb`,
      bytes: 0,
      vertices: 24,
      sizeMeters: { x: size, y: size, z: size },
      scale: { globalScale: 1, useFileScale: true },
      slots: [],
      warnings: [],
    });
  }
  const report: UnityImportReport = {
    importerVersion: 2,
    source: { shape: "unitypackage", name: "synthetic.unitypackage" },
    blender: { version: "not used", origin: "PATH" },
    materials: "complete",
    counts: { models: models.length, prefabs: prefabs.length, materials: 0, textures: 0, fallbackMaterials: 0, boundSlots: 0, skipped: 0, failed: 0 },
    licenseFiles: [],
    models,
    prefabs,
    materialAssets: [],
    textures: [],
    skipped: [],
    failed: [],
    warnings: [],
    durationMs: 0,
  };
  await writeFile(join(importDir, "import-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
