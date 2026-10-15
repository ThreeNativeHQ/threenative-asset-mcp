/**
 * Unity prefab to a resolved node tree. A prefab is a Unity YAML file of GameObjects, Transforms, MeshFilters
 * and MeshRenderers. A nested prefab or a variant is a `PrefabInstance` document: it names its source
 * (`m_SourcePrefab`), a list of property edits (`m_Modifications`), removals and additions, and the objects
 * of the source appear in the file as `stripped` documents that point back through
 * `m_CorrespondingSourceObject`.
 *
 * The instance and modification semantics follow V-Sekai/unidot_importer (MIT, Copyright (c) V-Sekai
 * contributors) `object_adapter.gd` and `convert_scene.gd`, re-written here from the format description.
 * No Unidot code is copied.
 *
 * Transforms stay in Unity's left-handed space here. {@link toGltfTransform} converts one local transform
 * and is applied once per node, by the GLB writer, after the whole tree (nested sources included) is built.
 */
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path/posix";

import { unityKind } from "./inventory.js";
import { firstModelId, meshNameFromMeta, type ModelIdSource } from "./model-ids.js";
import type { UnityAssetDatabase, UnityAssetEntry } from "./package.js";
import { asUnityRef, parseUnityDocuments, resolveRef, type UnityDocument, type UnityRef } from "./yaml.js";

export type Vec3 = readonly [number, number, number];
export type Quat = readonly [number, number, number, number];

export interface PrefabMeshRef {
  readonly ref: UnityRef;
  readonly model: UnityAssetEntry;
  /** Set when a `.meta` table names the mesh. Otherwise the writer matches `ref.fileID` against the model. */
  readonly name?: string;
  readonly via?: ModelIdSource;
}

export interface PrefabNode {
  readonly name: string;
  /** Slash-joined names from the root, for the report. */
  readonly path: string;
  readonly position: Vec3;
  readonly rotation: Quat;
  readonly scale: Vec3;
  readonly mesh?: PrefabMeshRef;
  /** One entry per MeshRenderer slot. Undefined keeps the model's own binding. */
  readonly slots: readonly (UnityAssetEntry | undefined)[];
  /** A `PrefabInstance` of a model: the whole converted model scene goes under this node. */
  readonly model?: UnityAssetEntry;
  readonly children: PrefabNode[];
}

export interface Unresolved {
  readonly kind: "prefab" | "mesh" | "material" | "modification" | "object";
  readonly node?: string;
  readonly reference: string;
  readonly reason: string;
}

export interface ComponentNote {
  readonly node: string;
  readonly component: string;
}

export interface LodNote {
  readonly group: string;
  readonly level: number;
  readonly transitionHeight?: number;
  /** Paths of the nodes whose renderers belong only to this level. They are not imported. */
  readonly nodes: readonly string[];
}

export interface ResolvedPrefab {
  readonly entry: UnityAssetEntry;
  readonly roots: PrefabNode[];
  readonly nodeCount: number;
  readonly colliders: ComponentNote[];
  /** Components that are neither imported nor colliders: scripts, lights, audio, skinned meshes, ... */
  readonly components: ComponentNote[];
  readonly lodLevels: LodNote[];
  /** Inactive GameObjects; they and their children are not imported. */
  readonly inactive: string[];
  readonly unresolved: Unresolved[];
  readonly warnings: string[];
}

export class UnityPrefabError extends Error {
  constructor(
    readonly code: "UNITY_PREFAB_CYCLE" | "UNITY_PREFAB_TOO_DEEP" | "UNITY_PREFAB_TOO_LARGE" | "UNITY_PREFAB_UNREADABLE",
    message: string,
  ) {
    super(message);
    this.name = "UnityPrefabError";
  }
}

/** Unity left-handed (Y up, Z forward) to glTF: position (x, y, -z), rotation (-x, -y, z, w), scale as is. */
export function toGltfTransform(position: Vec3, rotation: Quat, scale: Vec3): { translation: Vec3; rotation: Quat; scale: Vec3 } {
  const [x, y, z, w] = rotation;
  return { translation: [position[0], position[1], -position[2]], rotation: [-x, -y, z, w], scale };
}

const MAX_DEPTH = 32;
const MAX_OBJECTS = 200_000;
/** Prefab scopes (the file itself plus every nested instance expansion) one prefab import may build. */
export const MAX_SCOPES = 50_000;
/** Highest array index a modification may address; Unity arrays of materials, children and the like are far smaller. */
export const MAX_ARRAY_INDEX = 4096;
const MAX_PREFAB_BYTES = 128 * 1024 * 1024;

const CLASS_GAME_OBJECT = 1;
const CLASS_TRANSFORM = 4;
const CLASS_MESH_RENDERER = 23;
const CLASS_MESH_FILTER = 33;
const CLASS_LOD_GROUP = 205;
const CLASS_RECT_TRANSFORM = 224;
const CLASS_PREFAB_INSTANCE = 1001;

interface Obj {
  readonly owner: Scope;
  readonly classId: number;
  readonly typeName: string;
  readonly fields: Record<string, unknown>;
  removed: boolean;
  /** Set on the synthetic root GameObject of a model scope. */
  readonly model?: UnityAssetEntry;
}

interface InstanceRecord {
  readonly scope: Scope;
  readonly parent?: UnityRef;
  readonly source: string;
}

/** The objects of one prefab file after its nested instances were applied. */
class Scope {
  /** Own objects by fileID, and the nested instances' objects under stripped and combined ids. */
  readonly objects = new Map<string, Obj>();
  readonly instances: InstanceRecord[] = [];
  /** Transform or GameObject fileID of an added object to the source object it was added under. */
  readonly addedUnder = new Map<string, Obj>();
  constructor(readonly path: string) {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const finite = (value: unknown, fallback: number): number => {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : fallback;
};

function vec3(value: unknown, fallback: Vec3): Vec3 {
  if (!isRecord(value)) return fallback;
  return [finite(value.x, fallback[0]), finite(value.y, fallback[1]), finite(value.z, fallback[2])];
}

function quat(value: unknown): Quat {
  if (!isRecord(value)) return [0, 0, 0, 1];
  const q: Quat = [finite(value.x, 0), finite(value.y, 0), finite(value.z, 0), finite(value.w, 1)];
  const length = Math.hypot(...q);
  return length < 1e-9 ? [0, 0, 0, 1] : [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
}

const refText = (ref: UnityRef): string => `${ref.guid ?? "local"}:${ref.fileID}`;

/** `a.b.Array.data[2].c` to tokens `a`, `b`, 2, `c`. */
function pathTokens(path: string): (string | number)[] {
  const tokens: (string | number)[] = [];
  for (const match of path.replace(/\.Array\.data\[(\d+)\]/g, "[$1]").matchAll(/([^.[\]]+)|\[(\d+)\]/g)) {
    tokens.push(match[2] !== undefined ? Number(match[2]) : match[1]!);
  }
  return tokens;
}

const hasHugeIndex = (path: string): boolean => pathTokens(path).some((token) => typeof token === "number" && token > MAX_ARRAY_INDEX);

/** Sets `path` inside `root` the way Unity's `propertyPath` addresses it. Returns false for paths it skips. */
function setProperty(root: Record<string, unknown>, path: string, value: unknown): boolean {
  if (path.endsWith(".Array.size")) return false;
  const tokens = pathTokens(path);
  if (tokens.length === 0 || tokens.some((token) => token === "__proto__" || token === "constructor" || token === "prototype")) return false;
  let cursor: Record<string | number, unknown> = root;
  for (const [index, token] of tokens.entries()) {
    if (index === tokens.length - 1) {
      cursor[token] = value;
      return true;
    }
    let next = cursor[token];
    if (next === null || typeof next !== "object") {
      next = typeof tokens[index + 1] === "number" ? [] : {};
      cursor[token] = next;
    }
    cursor = next as Record<string | number, unknown>;
  }
  return true;
}

/** Unity addresses an object of a nested instance as the source fileID XOR the PrefabInstance fileID. */
function combinedId(sourceId: string, instanceId: string): string | undefined {
  try {
    return BigInt.asIntN(64, BigInt(sourceId) ^ BigInt(instanceId)).toString();
  } catch {
    return undefined;
  }
}

const STRUCTURAL_CLASSES = new Set([CLASS_GAME_OBJECT, CLASS_TRANSFORM, CLASS_RECT_TRANSFORM, CLASS_PREFAB_INSTANCE]);

interface Built {
  readonly go: Obj;
  transform?: Obj;
  readonly components: Obj[];
  readonly children: Built[];
  parent?: Built;
}

export class PrefabResolver {
  private readonly documents = new Map<string, Promise<readonly UnityDocument[]>>();
  private objectCount = 0;
  private scopeCount = 0;

  constructor(private readonly database: Pick<UnityAssetDatabase, "entries">) {}

  private load(entry: UnityAssetEntry): Promise<readonly UnityDocument[]> {
    let pending = this.documents.get(entry.guid);
    if (!pending) {
      pending = (async () => {
        const bytes = await readFile(entry.assetFile!);
        if (bytes.length > MAX_PREFAB_BYTES) throw new UnityPrefabError("UNITY_PREFAB_TOO_LARGE", `${entry.path} is larger than ${MAX_PREFAB_BYTES} bytes`);
        try {
          return parseUnityDocuments(bytes.toString("utf8"));
        } catch (error) {
          throw new UnityPrefabError("UNITY_PREFAB_UNREADABLE", `${entry.path} could not be read: ${error instanceof Error ? error.message : "parse error"}`);
        }
      })();
      this.documents.set(entry.guid, pending);
    }
    return pending;
  }

  private newObject(scope: Scope, classId: number, typeName: string, fields: Record<string, unknown>, extra: { model?: UnityAssetEntry } = {}): Obj {
    this.objectCount += 1;
    if (this.objectCount > MAX_OBJECTS) {
      throw new UnityPrefabError("UNITY_PREFAB_TOO_LARGE", `The prefab expands to more than ${MAX_OBJECTS} objects (nested prefab instances multiply)`);
    }
    return { owner: scope, classId, typeName, fields, removed: false, ...extra };
  }

  async resolve(entry: UnityAssetEntry): Promise<ResolvedPrefab> {
    this.objectCount = 0;
    this.scopeCount = 0;
    const unresolved: Unresolved[] = [];
    const scope = await this.scope(entry, [], unresolved);
    return this.build(entry, scope, unresolved);
  }

  /** Loads `entry` and applies every nested instance. `chain` holds the prefabs being resolved above it. */
  private async scope(entry: UnityAssetEntry, chain: readonly string[], unresolved: Unresolved[]): Promise<Scope> {
    if (chain.includes(entry.path)) {
      throw new UnityPrefabError("UNITY_PREFAB_CYCLE", `Prefab cycle: ${[...chain, entry.path].join(" -> ")}`);
    }
    if (chain.length >= MAX_DEPTH) {
      throw new UnityPrefabError("UNITY_PREFAB_TOO_DEEP", `Prefab nesting is deeper than ${MAX_DEPTH}: ${[...chain, entry.path].slice(0, 6).join(" -> ")} -> ...`);
    }
    this.scopeCount += 1;
    if (this.scopeCount > MAX_SCOPES) {
      throw new UnityPrefabError("UNITY_PREFAB_TOO_LARGE", `The prefab expands to more than ${MAX_SCOPES} nested prefab instances (nested instances multiply)`);
    }
    const documents = await this.load(entry);
    const scope = new Scope(entry.path);
    const stripped = new Map<string, { instance: string; source: UnityRef }>();
    for (const document of documents) {
      if (document.classId === CLASS_PREFAB_INSTANCE) continue;
      if (document.stripped) {
        const instance = asUnityRef(document.fields.m_PrefabInstance);
        const source = asUnityRef(document.fields.m_CorrespondingSourceObject);
        if (instance && source) stripped.set(document.fileId, { instance: instance.fileID, source });
        continue;
      }
      scope.objects.set(document.fileId, this.newObject(scope, document.classId, document.typeName, structuredClone(document.fields)));
    }
    for (const document of documents) {
      if (document.classId === CLASS_PREFAB_INSTANCE && !document.stripped) {
        await this.instance(document, scope, stripped, [...chain, entry.path], unresolved);
      }
    }
    return scope;
  }

  private async instance(
    document: UnityDocument,
    scope: Scope,
    stripped: ReadonlyMap<string, { instance: string; source: UnityRef }>,
    chain: readonly string[],
    unresolved: Unresolved[],
  ): Promise<void> {
    const modification = isRecord(document.fields.m_Modification) ? document.fields.m_Modification : {};
    const sourceRef = asUnityRef(document.fields.m_SourcePrefab) ?? asUnityRef(document.fields.m_ParentPrefab);
    const where = `PrefabInstance ${document.fileId} in ${scope.path}`;
    const target = sourceRef ? resolveRef(sourceRef, { database: this.database }) : undefined;
    if (target?.kind !== "asset") {
      const reason = !sourceRef ? "it has no source prefab" : target?.kind === "missing" ? `the source guid ${target.guid} is not in the package` : "the source is not a packaged asset";
      unresolved.push({ kind: "prefab", reference: where, reason });
      return;
    }
    const source = target.entry;
    const kind = unityKind(source.path);
    let child: Scope;
    if (kind === "prefab") child = await this.scope(source, chain, unresolved);
    else if (kind === "model") child = this.modelScope(source);
    else {
      unresolved.push({ kind: "prefab", reference: where, reason: `the source ${source.path} is a ${kind}, not a prefab or a model` });
      return;
    }

    for (const key of ["m_RemovedComponents", "m_RemovedGameObjects"] as const) {
      for (const item of Array.isArray(modification[key]) ? modification[key] : []) {
        const ref = asUnityRef(item);
        const object = ref ? child.objects.get(ref.fileID) : undefined;
        if (object) object.removed = true;
        else unresolved.push({ kind: "object", reference: `${where}: ${key} ${ref ? refText(ref) : "?"}`, reason: `no such object in ${source.path}` });
      }
    }

    let fatherFromModification: UnityRef | undefined;
    for (const item of Array.isArray(modification.m_Modifications) ? modification.m_Modifications : []) {
      if (!isRecord(item)) continue;
      const path = String(item.propertyPath ?? "");
      const edit = asUnityRef(item.target);
      const objectReference = asUnityRef(item.objectReference);
      if (path === "m_Father") {
        // The root's parent is `m_TransformParent`; older files only say it here.
        if (objectReference && objectReference.fileID !== "0") fatherFromModification = objectReference;
        continue;
      }
      if (path === "m_RootOrder" || path.startsWith("m_Children") || path.startsWith("m_LocalEulerAnglesHint")) continue;
      const object = edit ? child.objects.get(edit.fileID) : undefined;
      if (!object) {
        unresolved.push({
          kind: "modification",
          reference: `${where}: ${path} on ${edit ? refText(edit) : "?"}`,
          reason: kind === "model" ? "only the root of a model can be edited; its inner objects are not addressable" : `no such object in ${source.path}`,
        });
        continue;
      }
      if (hasHugeIndex(path)) {
        unresolved.push({ kind: "modification", reference: `${where}: ${path} on ${edit ? refText(edit) : "?"}`, reason: `an array index is larger than ${MAX_ARRAY_INDEX}` });
        continue;
      }
      setProperty(object.fields, path, objectReference && objectReference.fileID !== "0" ? item.objectReference : item.value);
    }

    for (const [id, object] of child.objects) {
      const combined = combinedId(id, document.fileId);
      if (combined !== undefined && !scope.objects.has(combined)) scope.objects.set(combined, object);
    }
    for (const [id, reference] of stripped) {
      if (reference.instance !== document.fileId) continue;
      const object = child.objects.get(reference.source.fileID);
      if (object) scope.objects.set(id, object);
      else unresolved.push({ kind: "object", reference: `${where}: stripped ${id}`, reason: `the source object ${reference.source.fileID} is not in ${source.path}` });
    }
    for (const item of Array.isArray(modification.m_AddedGameObjects) ? modification.m_AddedGameObjects : []) {
      if (!isRecord(item)) continue;
      const under = asUnityRef(item.targetCorrespondingSourceObject);
      const added = asUnityRef(item.addedObject);
      const object = under ? child.objects.get(under.fileID) ?? scope.objects.get(under.fileID) : undefined;
      if (added && object) scope.addedUnder.set(added.fileID, object);
    }
    const parent = asUnityRef(modification.m_TransformParent) ?? fatherFromModification;
    scope.instances.push({ scope: child, ...(parent ? { parent } : {}), source: source.path });
  }

  /** A model used as a prefab source: one root GameObject and Transform whose edits are applied. */
  private modelScope(model: UnityAssetEntry): Scope {
    const scope = new Scope(model.path);
    const goId = firstModelId(model.metaYaml, 1) ?? "100000";
    const transformId = firstModelId(model.metaYaml, 4) ?? "400000";
    const name = basename(model.path, extname(model.path));
    scope.objects.set(goId, this.newObject(scope, CLASS_GAME_OBJECT, "GameObject", { m_Name: name, m_IsActive: 1 }, { model }));
    scope.objects.set(
      transformId,
      this.newObject(scope, CLASS_TRANSFORM, "Transform", {
        m_GameObject: { fileID: goId },
        m_Father: { fileID: 0 },
        m_LocalPosition: { x: 0, y: 0, z: 0 },
        m_LocalRotation: { x: 0, y: 0, z: 0, w: 1 },
        m_LocalScale: { x: 1, y: 1, z: 1 },
      }),
    );
    return scope;
  }

  // ------------------------------------------------------------ tree

  private build(entry: UnityAssetEntry, top: Scope, unresolved: Unresolved[]): ResolvedPrefab {
    const built = new Map<Obj, Built>();
    const warnings: string[] = [];
    const objectIn = (scope: Scope, ref: unknown): Obj | undefined => {
      const parsed = asUnityRef(ref);
      return parsed && parsed.fileID !== "0" ? scope.objects.get(parsed.fileID) : undefined;
    };
    const goOf = (transform: Obj): Obj | undefined => objectIn(transform.owner, transform.fields.m_GameObject);

    /** Builds `scope` and the scopes below it. Returns the nodes that have no parent yet. */
    const assemble = (scope: Scope): Built[] => {
      const ownGameObjects: Built[] = [];
      for (const object of new Set(scope.objects.values())) {
        if (object.owner !== scope || object.classId !== CLASS_GAME_OBJECT || object.removed) continue;
        const node: Built = { go: object, components: [], children: [] };
        built.set(object, node);
        ownGameObjects.push(node);
      }
      const roots: Built[] = [];
      const keysOf = new Map<Obj, string[]>();
      for (const [key, object] of scope.objects) keysOf.set(object, [...(keysOf.get(object) ?? []), key]);
      for (const object of new Set(scope.objects.values())) {
        if (object.owner !== scope || (object.classId !== CLASS_TRANSFORM && object.classId !== CLASS_RECT_TRANSFORM)) continue;
        const go = goOf(object);
        const node = go ? built.get(go) : undefined;
        if (node) node.transform = object;
      }

      const attach = (child: Built, parentTransform: Obj | undefined, ref: UnityRef | undefined, what: string, addedKeys: string[]): void => {
        let parentObject = parentTransform;
        if (!parentObject && ref === undefined) {
          for (const key of addedKeys) {
            const under = scope.addedUnder.get(key);
            if (under) parentObject = under;
          }
        }
        if (!parentObject) {
          if (ref === undefined) roots.push(child);
          else unresolved.push({ kind: "object", reference: `${what} in ${scope.path}`, reason: `its parent ${refText(ref)} is not in the prefab` });
          return;
        }
        const parentGo = parentObject.classId === CLASS_GAME_OBJECT ? parentObject : goOf(parentObject);
        if (parentGo?.removed) return;
        const parent = parentGo ? built.get(parentGo) : undefined;
        if (!parent) {
          unresolved.push({ kind: "object", reference: `${what} in ${scope.path}`, reason: "its parent GameObject is not in the prefab" });
          return;
        }
        child.parent = parent;
        parent.children.push(child);
      };

      const instanceRoots = scope.instances.map((record) => ({ record, roots: assemble(record.scope) }));
      for (const node of ownGameObjects) {
        const transform = node.transform;
        const father = transform ? asUnityRef(transform.fields.m_Father) : undefined;
        const fatherRef = father && father.fileID !== "0" ? father : undefined;
        const addedKeys = [...(transform ? keysOf.get(transform) ?? [] : []), ...(keysOf.get(node.go) ?? [])];
        attach(node, fatherRef ? scope.objects.get(fatherRef.fileID) : undefined, fatherRef, String(node.go.fields.m_Name ?? "GameObject"), addedKeys);
      }
      for (const { record, roots: childRoots } of instanceRoots) {
        const parentRef = record.parent && record.parent.fileID !== "0" ? record.parent : undefined;
        for (const child of childRoots) attach(child, parentRef ? scope.objects.get(parentRef.fileID) : undefined, parentRef, `instance of ${record.source}`, []);
      }
      for (const object of new Set(scope.objects.values())) {
        if (object.owner !== scope || object.removed || STRUCTURAL_CLASSES.has(object.classId)) continue;
        const go = objectIn(scope, object.fields.m_GameObject);
        const node = go ? built.get(go) : undefined;
        if (node) node.components.push(object);
      }
      return roots;
    };

    const roots = assemble(top);

    // LOD levels above 0 are not imported: collect the renderers that belong only to them.
    const lodDropped = new Set<Obj>();
    const lodGroups: { node: Built; group: Obj; levels: { height?: number; renderers: Obj[] }[] }[] = [];
    for (const node of built.values()) {
      for (const component of node.components) {
        if (component.classId !== CLASS_LOD_GROUP) continue;
        const levels = (Array.isArray(component.fields.m_LODs) ? component.fields.m_LODs : []).map((level) => {
          const record = isRecord(level) ? level : {};
          const renderers = (Array.isArray(record.renderers) ? record.renderers : [])
            .map((item) => objectIn(component.owner, isRecord(item) ? item.renderer : undefined))
            .filter((object): object is Obj => object !== undefined);
          const height = finite(record.screenRelativeTransitionHeight, Number.NaN);
          return { ...(Number.isFinite(height) ? { height } : {}), renderers };
        });
        const keep = new Set(levels[0]?.renderers ?? []);
        for (const level of levels.slice(1)) for (const renderer of level.renderers) if (!keep.has(renderer)) lodDropped.add(renderer);
        lodGroups.push({ node, group: component, levels });
      }
    }

    const colliders: ComponentNote[] = [];
    const components: ComponentNote[] = [];
    const inactive: string[] = [];
    let nodeCount = 0;
    const pathOf = new Map<Built, string>();
    const convert = (node: Built, parentPath: string): PrefabNode | undefined => {
      const name = String(node.go.fields.m_Name ?? "GameObject");
      const path = parentPath ? `${parentPath}/${name}` : name;
      pathOf.set(node, path);
      if (finite(node.go.fields.m_IsActive, 1) === 0) {
        inactive.push(path);
        return undefined;
      }
      nodeCount += 1;
      const transform = node.transform?.fields ?? {};
      const filter = node.components.find((component) => component.classId === CLASS_MESH_FILTER);
      const renderer = node.components.find((component) => component.classId === CLASS_MESH_RENDERER);
      for (const component of node.components) {
        if (component.classId === CLASS_MESH_FILTER || component.classId === CLASS_LOD_GROUP) continue;
        if (component.classId === CLASS_MESH_RENDERER) {
          if (lodDropped.has(component)) continue;
          if (finite(component.fields.m_Enabled, 1) === 0) warnings.push(`${path}: the MeshRenderer is disabled; its mesh is not imported`);
          continue;
        }
        (/Collider/.test(component.typeName) ? colliders : components).push({ node: path, component: component.typeName });
      }
      const result: { -readonly [K in keyof PrefabNode]: PrefabNode[K] } = {
        name,
        path,
        position: vec3(transform.m_LocalPosition, [0, 0, 0]),
        rotation: quat(transform.m_LocalRotation),
        scale: vec3(transform.m_LocalScale, [1, 1, 1]),
        slots: [],
        children: [],
        ...(node.go.model ? { model: node.go.model } : {}),
      };
      if (filter && renderer && !lodDropped.has(renderer) && finite(renderer.fields.m_Enabled, 1) !== 0) {
        const mesh = this.meshOf(filter, path, unresolved);
        if (mesh) {
          result.mesh = mesh;
          result.slots = (Array.isArray(renderer.fields.m_Materials) ? renderer.fields.m_Materials : []).map((item) =>
            this.materialOf(item, path, unresolved),
          );
        }
      } else if (filter && !renderer) {
        warnings.push(`${path}: a MeshFilter without a MeshRenderer is not drawn by Unity; not imported`);
      }
      for (const child of node.children) {
        const converted = convert(child, path);
        if (converted) result.children.push(converted);
      }
      return result;
    };
    const nodes = roots.map((root) => convert(root, "")).filter((node): node is PrefabNode => node !== undefined);

    const lodLevels: LodNote[] = [];
    for (const { node, levels } of lodGroups) {
      levels.forEach((level, index) => {
        if (index === 0) return;
        const owners = [...built.values()]
          .filter((candidate) => candidate.components.some((component) => level.renderers.includes(component) && lodDropped.has(component)))
          .map((candidate) => pathOf.get(candidate))
          .filter((path): path is string => path !== undefined);
        lodLevels.push({ group: pathOf.get(node) ?? String(node.go.fields.m_Name ?? ""), level: index, ...(level.height !== undefined ? { transitionHeight: level.height } : {}), nodes: owners });
      });
    }
    return { entry, roots: nodes, nodeCount, colliders, components, lodLevels, inactive, unresolved, warnings };
  }

  private meshOf(filter: Obj, node: string, unresolved: Unresolved[]): PrefabMeshRef | undefined {
    const ref = asUnityRef(filter.fields.m_Mesh);
    if (!ref || (ref.fileID === "0" && ref.guid === undefined)) return undefined;
    const target = resolveRef(ref, { database: this.database });
    if (target.kind === "null") return undefined;
    const report = (reason: string): undefined => {
      unresolved.push({ kind: "mesh", node, reference: refText(ref), reason });
      return undefined;
    };
    if (target.kind === "builtin") return report("a built-in Unity mesh, not part of the package");
    if (target.kind === "missing") return report(`the guid ${target.guid} is not in the package`);
    if (target.kind === "local") return report("the mesh is inside the prefab file, which is not supported");
    if (unityKind(target.path) !== "model") return report(`${target.path} is not a model file`);
    const named = meshNameFromMeta(target.entry.metaYaml, ref.fileID);
    return { ref, model: target.entry, ...(named ? { name: named.name, via: named.via } : {}) };
  }

  private materialOf(item: unknown, node: string, unresolved: Unresolved[]): UnityAssetEntry | undefined {
    const ref = asUnityRef(item);
    if (!ref) return undefined;
    const target = resolveRef(ref, { database: this.database });
    if (target.kind === "null") return undefined;
    if (target.kind === "asset" && unityKind(target.path) === "material" && target.entry.assetFile !== undefined) return target.entry;
    const reason =
      target.kind === "builtin" ? "a built-in Unity material; the model's own binding is kept"
        : target.kind === "missing" ? `the guid ${target.guid} is not in the package; the model's own binding is kept`
          : target.kind === "asset" ? `${target.path} is not a material; the model's own binding is kept`
            : "the material is inside the prefab file, which is not supported";
    unresolved.push({ kind: "material", node, reference: refText(ref), reason });
    return undefined;
  }
}
