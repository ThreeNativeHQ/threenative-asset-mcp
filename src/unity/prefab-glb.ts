/**
 * Writes one glTF document for a resolved prefab. Mesh geometry and the model's own material binding come
 * from the model GLB that the model import already wrote; a MeshRenderer slot that names a `.mat` replaces
 * the model's binding for that slot. Each node's local transform is converted once from Unity's space
 * ({@link toGltfTransform}); the geometry is already glTF space, so it is not touched.
 */
import { Document, Logger, type Material, type Mesh, type Node, PropertyType, type Scene } from "@gltf-transform/core";
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
}

export interface PrefabGlb {
  readonly document: Document;
  readonly unresolved: Unresolved[];
  readonly warnings: string[];
  readonly meshNodes: number;
}

interface Source {
  readonly document: Document;
  readonly resolve: ReturnType<typeof createDefaultPropertyResolver>;
  readonly copies: Map<Mesh, Mesh>;
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const isIdentity = (matrix: readonly number[]): boolean => matrix.every((value, index) => Math.abs(value - IDENTITY[index]!) < 1e-6);

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
        if (override) copy.setMaterial(override);
        mesh.addPrimitive(copy);
      }
      variants.set(key, mesh);
    }
    meshNodes += 1;
    // The model's own node transform (rare for the Blender route) is kept so the part sits as in the model GLB.
    const world = picked.owner?.getWorldMatrix();
    if (world && !isIdentity(world)) {
      node.addChild(document.createNode(`${item.name}:mesh`).setMatrix(world).setMesh(mesh));
    } else node.setMesh(mesh);
  };

  const copyModelScene = async (item: PrefabNode, parent: Node): Promise<void> => {
    const model = item.model!;
    const source = await sourceFor(model);
    if (!source) {
      unresolved.push({ kind: "prefab", node: item.path, reference: model.path, reason: "the model was not converted" });
      return;
    }
    const copy = (from: Node, into: Node | Scene): void => {
      const node = document.createNode(from.getName()).setTranslation(from.getTranslation()).setRotation(from.getRotation()).setScale(from.getScale());
      const mesh = from.getMesh();
      if (mesh) {
        node.setMesh(copyMesh(source, mesh));
        meshNodes += 1;
      }
      into.addChild(node);
      for (const child of from.listChildren()) copy(child, node);
    };
    const root = source.document.getRoot();
    for (const child of (root.getDefaultScene() ?? root.listScenes()[0])?.listChildren() ?? []) copy(child, parent);
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
  return { document, unresolved, warnings, meshNodes };
}
