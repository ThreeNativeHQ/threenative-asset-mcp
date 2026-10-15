/**
 * Writes one glTF document for a resolved prefab. Mesh geometry and the model's own material binding come
 * from the model GLB that the model import already wrote; a MeshRenderer slot that names a `.mat` replaces
 * the model's binding for that slot. Each node's local transform is converted once from Unity's space
 * ({@link toGltfTransform}); the geometry is already glTF space, so it is not touched.
 */
import { Document, Logger, type Material, type Mesh, type Node, PropertyType, type Scene, type mat4 } from "@gltf-transform/core";
import { copyToDocument, createDefaultPropertyResolver, prune, unpartition } from "@gltf-transform/functions";

import { TextureCache, applyResolvedMaterial, type ImageSource } from "./gltf-materials.js";
import type { ResolvedMaterial } from "./materials.js";
import { derivedMeshFileId } from "./model-ids.js";
import type { UnityAssetEntry } from "./package.js";
import { type PrefabMeshRef, type PrefabNode, type ResolvedPrefab, type Unresolved, toGltfTransform } from "./prefab.js";

export interface PrefabGlbHost {
  /** The converted model's GLB, or undefined when the model was not converted. */
  modelDocument(entry: UnityAssetEntry): Promise<Document | undefined>;
  material(entry: UnityAssetEntry): Promise<ResolvedMaterial | undefined>;
  readonly imageSource: ImageSource;
  /** `fbxMeshFrame` of a converted FBX; absent for other model kinds, which keep their own node chain. */
  meshFrame(entry: UnityAssetEntry): readonly number[] | undefined;
}

export interface PrefabGlb {
  readonly document: Document;
  readonly unresolved: Unresolved[];
  readonly warnings: string[];
  readonly meshNodes: number;
  /** MeshRenderer slots that a `.mat` replaced (counted per mesh node), and the distinct `.mat` paths they used. */
  readonly boundSlots: number;
  readonly boundMaterials: string[];
}

interface Source {
  readonly document: Document;
  readonly resolve: ReturnType<typeof createDefaultPropertyResolver>;
  readonly copies: Map<Mesh, Mesh>;
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const isIdentity = (matrix: readonly number[]): boolean => matrix.every((value, index) => Math.abs(value - IDENTITY[index]!) < 1e-6);

/**
 * Unity mirrors X when it imports a model, and a prefab's node chain is converted with a Z flip, so a mesh that
 * Unity places in a prefab needs both: that is a half turn about Y of the model's own conversion. Column-major.
 * MEASURED on a real pack (U1, 2026-10-15): with the prefab chain left alone, every asymmetric piece matched
 * Unity's own preview only after a further 100 degrees of yaw, which is exactly this half turn plus Unity's
 * preview camera (120 degrees about Y in glTF space) against ours (40 degrees).
 */
export const HALF_TURN_Y = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1];

export function multiplyMatrices(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      for (let k = 0; k < 4; k += 1) out[column * 4 + row]! += a[k * 4 + row]! * b[column * 4 + k]!;
    }
  }
  return out;
}

/**
 * Maps a Blender-made model GLB's vertices to where Unity's mesh sub-asset puts them, in glTF space, for an FBX.
 * Blender's importer leaves the FBX's raw vertices in the mesh and the file's own node transforms (and the unit and
 * axis conversion) on the object; its glTF export then rotates the vertices to Y-up, (x, y, z) -> (x, z, -y).
 * Unity's mesh holds the raw vertices times the unit scale, mirrored in X, with the node transforms left to the
 * prefab's own GameObject. So the model's own node chain must not be applied, and the vertices are taken back to
 * raw, scaled, mirrored in X and flipped in Z: (x, y, z) -> s * (-x, -z, -y).
 */
export function fbxMeshFrame(scale: number): number[] {
  return [-scale, 0, 0, 0, 0, 0, -scale, 0, 0, -scale, 0, 0, 0, 0, 0, 1];
}

export async function writePrefabDocument(prefab: ResolvedPrefab, host: PrefabGlbHost): Promise<PrefabGlb> {
  const document = new Document().setLogger(new Logger(Logger.Verbosity.SILENT));
  document.createBuffer();
  const scene = document.createScene(prefab.entry.path.split("/").pop() ?? "prefab");
  document.getRoot().setDefaultScene(scene);
  const textures = new TextureCache(document);
  const unresolved: Unresolved[] = [];
  const warnings: string[] = [];
  const sources = new Map<string, Source | null>();
  const materials = new Map<string, Material | null>();
  const variants = new Map<string, Mesh>();
  let meshNodes = 0;
  let boundSlots = 0;
  const boundMaterials = new Set<string>();

  const sourceFor = async (model: UnityAssetEntry): Promise<Source | null> => {
    const known = sources.get(model.guid);
    if (known !== undefined) return known;
    const loaded = await host.modelDocument(model);
    let source: Source | null = null;
    if (loaded) {
      for (const extension of loaded.getRoot().listExtensionsUsed()) {
        if (!document.getRoot().listExtensionsUsed().some((used) => used.extensionName === extension.extensionName)) {
          document.createExtension(extension.constructor as never);
        }
      }
      source = { document: loaded, resolve: createDefaultPropertyResolver(document, loaded), copies: new Map() };
    }
    sources.set(model.guid, source);
    return source;
  };

  const copyMesh = (source: Source, mesh: Mesh): Mesh => {
    let copy = source.copies.get(mesh);
    if (!copy) {
      copy = copyToDocument(document, source.document, [mesh], source.resolve).get(mesh) as Mesh;
      source.copies.set(mesh, copy);
    }
    return copy;
  };

  const materialFor = async (entry: UnityAssetEntry, node: string): Promise<Material | undefined> => {
    const known = materials.get(entry.guid);
    if (known !== undefined) return known ?? undefined;
    const resolved = await host.material(entry);
    if (!resolved) {
      unresolved.push({ kind: "material", node, reference: entry.path, reason: "the material could not be read; the model's own binding is kept" });
      materials.set(entry.guid, null);
      return undefined;
    }
    const material = document.createMaterial(resolved.name);
    for (const warning of await applyResolvedMaterial(document, textures, material, resolved, host.imageSource)) warnings.push(`${entry.path}: ${warning}`);
    materials.set(entry.guid, material);
    return material;
  };

  /** Finds the model's mesh for a prefab reference: by name, by derived id, or as the model's only mesh. */
  const pickMesh = (source: Source, reference: PrefabMeshRef, node: string): { mesh: Mesh; owner?: Node } | undefined => {
    const candidates: { name: string; mesh: Mesh; owner?: Node }[] = [];
    for (const owner of source.document.getRoot().listNodes()) {
      const mesh = owner.getMesh();
      if (mesh) candidates.push({ name: owner.getName(), mesh, owner });
    }
    for (const mesh of source.document.getRoot().listMeshes()) {
      if (!candidates.some((candidate) => candidate.mesh === mesh)) candidates.push({ name: mesh.getName(), mesh });
    }
    const byMeshName = candidates.flatMap((candidate) => [{ ...candidate }, { ...candidate, name: candidate.mesh.getName() }]);
    const found =
      (reference.name !== undefined ? byMeshName.find((candidate) => candidate.name === reference.name) : undefined) ??
      (reference.name === undefined ? byMeshName.find((candidate) => derivedMeshFileId(candidate.name) === reference.ref.fileID) : undefined);
    if (found) return found;
    if (reference.name === undefined) {
      // Real packs (Unity 2022, empty `internalIDToNameTable`) use 64-bit ids that the derived-id route does not reproduce.
      // The prefab then usually names its mesh: a GameObject on the path, leaf first, is called like exactly one mesh.
      for (const segment of node.split("/").reverse()) {
        const named = candidates.filter((candidate) => candidate.name === segment || candidate.mesh.getName() === segment);
        if (named.length === 1) {
          warnings.push(`${node}: mesh ${reference.ref.fileID} is not in any table of ${reference.model.path}; matched the mesh named "${segment}" by the GameObject name (UNVERIFIED)`);
          return named[0];
        }
      }
    }
    if (reference.name === undefined && candidates.length === 1) {
      warnings.push(`${node}: mesh ${reference.ref.fileID} is not in any table of ${reference.model.path}; used the model's only mesh`);
      return candidates[0];
    }
    const names = [...new Set(candidates.map((candidate) => candidate.name))].slice(0, 8).join(", ");
    unresolved.push({
      kind: "mesh",
      node,
      reference: `${reference.model.path}:${reference.ref.fileID}`,
      reason: reference.name !== undefined ? `the model has no mesh named "${reference.name}" (it has: ${names})` : `no mesh id matches in the model's tables or by derived id (it has: ${names})`,
    });
    return undefined;
  };

  const buildMesh = async (item: PrefabNode, node: Node): Promise<void> => {
    const reference = item.mesh!;
    const source = await sourceFor(reference.model);
    if (!source) {
      unresolved.push({ kind: "mesh", node: item.path, reference: `${reference.model.path}:${reference.ref.fileID}`, reason: "the model was not converted" });
      return;
    }
    const picked = pickMesh(source, reference, item.path);
    if (!picked) return;
    const base = copyMesh(source, picked.mesh);
    const primitives = base.listPrimitives();
    if (item.slots.length > 0 && item.slots.length !== primitives.length) {
      warnings.push(`${item.path}: the MeshRenderer has ${item.slots.length} material slot(s) and the model mesh ${primitives.length} part(s)`);
    }
    const key = `${reference.model.guid}|${base.getName()}|${primitives.length}|${item.slots.map((slot) => slot?.guid ?? "-").join(",")}`;
    let mesh = item.slots.some((slot) => slot !== undefined) ? variants.get(key) : base;
    if (!mesh) {
      mesh = document.createMesh(base.getName());
      for (const [index, primitive] of primitives.entries()) {
        const copy = primitive.clone();
        const slot = item.slots[index];
        const override = slot ? await materialFor(slot, item.path) : undefined;
        if (override) {
          copy.setMaterial(override);
          boundSlots += 1;
          boundMaterials.add(slot!.path);
        }
        mesh.addPrimitive(copy);
      }
      variants.set(key, mesh);
    }
    meshNodes += 1;
    // The frame is the mesh's place in Unity's space (see `fbxMeshFrame`); other model kinds keep their node chain, turned half about Y.
    const frame = host.meshFrame(reference.model) ?? multiplyMatrices(HALF_TURN_Y, picked.owner?.getWorldMatrix() ?? IDENTITY);
    if (!isIdentity(frame)) {
      node.addChild(document.createNode(`${item.name}:mesh`).setMatrix(frame as mat4).setMesh(mesh));
    } else node.setMesh(mesh);
  };

  const copyModelScene = async (item: PrefabNode, parent: Node): Promise<void> => {
    const model = item.model!;
    const source = await sourceFor(model);
    if (!source) {
      unresolved.push({ kind: "prefab", node: item.path, reference: model.path, reason: "the model was not converted" });
      return;
    }
    const copy = (from: Node, into: Node | Scene, top: boolean): void => {
      const node = document.createNode(from.getName());
      // The model's scene is Blender's, in right-handed space; Unity mirrors it in X, which the Z-flipped chain turns into a half turn about Y.
      if (top) node.setMatrix(multiplyMatrices(HALF_TURN_Y, from.getMatrix()) as mat4);
      else node.setTranslation(from.getTranslation()).setRotation(from.getRotation()).setScale(from.getScale());
      const mesh = from.getMesh();
      if (mesh) {
        node.setMesh(copyMesh(source, mesh));
        meshNodes += 1;
      }
      into.addChild(node);
      for (const child of from.listChildren()) copy(child, node, false);
    };
    const root = source.document.getRoot();
    for (const child of (root.getDefaultScene() ?? root.listScenes()[0])?.listChildren() ?? []) copy(child, parent, true);
  };

  const build = async (item: PrefabNode, parent: Node | Scene): Promise<void> => {
    const local = toGltfTransform(item.position, item.rotation, item.scale);
    const node = document
      .createNode(item.name)
      .setTranslation([...local.translation])
      .setRotation([...local.rotation])
      .setScale([...local.scale]);
    parent.addChild(node);
    if (item.mesh) await buildMesh(item, node);
    if (item.model) await copyModelScene(item, node);
    for (const child of item.children) await build(child, node);
  };

  for (const root of prefab.roots) await build(root, scene);

  // Base copies that only variants use, and the materials and images they carried, are dropped here.
  await document.transform(
    prune({ propertyTypes: [PropertyType.MESH, PropertyType.MATERIAL, PropertyType.ACCESSOR, PropertyType.TEXTURE], keepLeaves: true, keepAttributes: true, keepSolidTextures: true }),
    unpartition(),
  );
  return { document, unresolved, warnings, meshNodes, boundSlots, boundMaterials: [...boundMaterials].sort() };
}
