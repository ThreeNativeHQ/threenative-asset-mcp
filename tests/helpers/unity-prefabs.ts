/** Synthetic Unity prefabs and a multi-part FBX. Nothing here is real or licensed. */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { ensureBlender } from "../../src/unity/blender.js";
import { runBounded } from "../../src/unreal/toolchain.js";
import { guidFor } from "./unity-fixtures.js";

type Vec3 = readonly [number, number, number];
type Quat = readonly [number, number, number, number];

const HEADER = "%YAML 1.1\n%TAG !u! tag:unity3d.com,2011:\n";

const vec = ([x, y, z]: Vec3): string => `{x: ${x}, y: ${y}, z: ${z}}`;
const quat = ([x, y, z, w]: Quat): string => `{x: ${x}, y: ${y}, z: ${z}, w: ${w}}`;
/** A reference to an object of the same file. */
export const local = (id: string | number): string => `{fileID: ${id}}`;
/** A reference to an object of another asset, by project path. */
export const asset = (path: string, fileId: string | number, type = 3): string => `{fileID: ${fileId}, guid: ${guidFor(path)}, type: ${type}}`;

export interface TransformSpec {
  readonly father?: string | number;
  readonly position?: Vec3;
  readonly rotation?: Quat;
  readonly scale?: Vec3;
}

/** A GameObject, plus its Transform (id `go + 1`), when `transform` is given. */
export function gameObject(id: number, name: string, options: { components?: (string | number)[]; active?: boolean } = {}): string {
  const components = (options.components ?? []).map((component) => `  - component: {fileID: ${component}}`);
  return [
    `--- !u!1 &${id}`,
    "GameObject:",
    "  m_ObjectHideFlags: 0",
    `  m_Component:${components.length > 0 ? `\n${components.join("\n")}` : " []"}`,
    `  m_Name: ${name}`,
    `  m_IsActive: ${options.active === false ? 0 : 1}`,
    "",
  ].join("\n");
}

export function transform(id: number, goId: string | number, spec: TransformSpec = {}): string {
  return [
    `--- !u!4 &${id}`,
    "Transform:",
    `  m_GameObject: ${local(goId)}`,
    `  m_LocalRotation: ${quat(spec.rotation ?? [0, 0, 0, 1])}`,
    `  m_LocalPosition: ${vec(spec.position ?? [0, 0, 0])}`,
    `  m_LocalScale: ${vec(spec.scale ?? [1, 1, 1])}`,
    "  m_Children: []",
    `  m_Father: ${local(spec.father ?? 0)}`,
    "",
  ].join("\n");
}

export const meshFilter = (id: number, goId: string | number, mesh: string): string =>
  `--- !u!33 &${id}\nMeshFilter:\n  m_GameObject: ${local(goId)}\n  m_Mesh: ${mesh}\n`;

export const meshRenderer = (id: number, goId: string | number, materials: readonly string[], enabled = true): string =>
  `--- !u!23 &${id}\nMeshRenderer:\n  m_GameObject: ${local(goId)}\n  m_Enabled: ${enabled ? 1 : 0}\n  m_Materials:\n${materials.map((m) => `  - ${m}`).join("\n")}\n`;

/** Any other component: a collider, a script, a light. */
export const component = (classId: number, typeName: string, id: number, goId: string | number, extra = ""): string =>
  `--- !u!${classId} &${id}\n${typeName}:\n  m_GameObject: ${local(goId)}\n${extra}`;

export function lodGroup(id: number, goId: number, levels: readonly { height: number; renderers: readonly (string | number)[] }[]): string {
  const rows = levels.map(
    (level) =>
      `  - screenRelativeTransitionHeight: ${level.height}\n    renderers:\n${level.renderers.map((renderer) => `    - renderer: ${local(renderer)}`).join("\n")}`,
  );
  return `--- !u!205 &${id}\nLODGroup:\n  m_GameObject: ${local(goId)}\n  m_LODs:\n${rows.join("\n")}\n`;
}

export interface Modification {
  /** FileID of the target in the source prefab. */
  readonly target: string | number;
  readonly path: string;
  readonly value?: string | number;
  readonly reference?: string;
}

export interface InstanceSpec {
  /** Project path of the source prefab or model. */
  readonly source: string;
  /** Transform in this file the instance root hangs under. */
  readonly parent?: string | number;
  readonly modifications?: readonly Modification[];
  readonly removedComponents?: readonly (string | number)[];
  readonly removedGameObjects?: readonly (string | number)[];
  readonly added?: readonly { under: string | number; added: string | number }[];
}

export function prefabInstance(id: number, spec: InstanceSpec): string {
  const refs = (ids: readonly (string | number)[] | undefined): string =>
    ids && ids.length > 0 ? `\n${ids.map((item) => `    - ${asset(spec.source, item)}`).join("\n")}` : " []";
  const edits = (spec.modifications ?? []).map(
    (edit) =>
      `    - target: ${asset(spec.source, edit.target)}\n      propertyPath: ${edit.path}\n      value: ${edit.value ?? ""}\n      objectReference: ${edit.reference ?? "{fileID: 0}"}`,
  );
  const added = (spec.added ?? []).map(
    (item) => `    - targetCorrespondingSourceObject: ${asset(spec.source, item.under)}\n      insertIndex: -1\n      addedObject: ${local(item.added)}`,
  );
  return [
    `--- !u!1001 &${id}`,
    "PrefabInstance:",
    "  m_ObjectHideFlags: 0",
    "  serializedVersion: 2",
    "  m_Modification:",
    `    m_TransformParent: ${local(spec.parent ?? 0)}`,
    `    m_Modifications:${edits.length > 0 ? `\n${edits.join("\n")}` : " []"}`,
    `    m_RemovedComponents:${refs(spec.removedComponents)}`,
    `    m_RemovedGameObjects:${refs(spec.removedGameObjects)}`,
    `    m_AddedGameObjects:${added.length > 0 ? `\n${added.join("\n")}` : " []"}`,
    `  m_SourcePrefab: ${asset(spec.source, 100100000)}`,
    "",
  ].join("\n");
}

/** The stand-in a prefab keeps for an object of a nested source. */
export const stripped = (classId: number, typeName: string, id: number, instanceId: number, source: string, sourceId: string | number): string =>
  `--- !u!${classId} &${id} stripped\n${typeName}:\n  m_CorrespondingSourceObject: ${asset(source, sourceId)}\n  m_PrefabInstance: ${local(instanceId)}\n`;

export const prefabFile = (...documents: string[]): string => HEADER + documents.join("");

/** Unity multiplies the same way as column-major 4x4 matrices: world = parent * local. T * R * S. */
export function unityMatrix(position: Vec3, [x, y, z, w]: Quat, scale: Vec3): number[] {
  const [sx, sy, sz] = scale;
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    position[0], position[1], position[2], 1,
  ];
}

export function multiply(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      for (let k = 0; k < 4; k += 1) out[column * 4 + row]! += a[k * 4 + row]! * b[column * 4 + k]!;
    }
  }
  return out;
}

/** The expected glTF matrix of a Unity world matrix: the same transform with the Z axis mirrored, S * W * S. */
export function mirrorZ(matrix: readonly number[]): number[] {
  const flip = [1, 1, -1, 1];
  return matrix.map((value, index) => value * flip[Math.floor(index / 4)]! * flip[index % 4]!);
}

const PARTS_SCRIPT = String.raw`
import bpy, sys
out, *specs = sys.argv[sys.argv.index("--") + 1:]
bpy.ops.wm.read_factory_settings(use_empty=True)
for spec in specs:
    name, sx, sy, sz, *materials = spec.split(",")
    offsets = [m for m in materials if m.startswith("@")]
    pivots = [m for m in materials if m.startswith("^")]
    nodes = [m for m in materials if m.startswith("~")]
    materials = [m for m in materials if not m.startswith("@") and not m.startswith("^") and not m.startswith("~")]
    bpy.ops.mesh.primitive_cube_add(size=1.0)
    part = bpy.context.object
    part.name = name
    part.data.name = name
    part.scale = (float(sx), float(sy), float(sz))
    if offsets:
        part.location = tuple(float(v) for v in offsets[0][1:].split(":"))
    if pivots:
        # Maya-style: the node sits at the pivot and the vertices are about its negative.
        pivot = tuple(float(v) for v in pivots[0][1:].split(":"))
        bpy.ops.object.transform_apply(scale=True, location=False)
        for vertex in part.data.vertices:
            vertex.co.x -= pivot[0]; vertex.co.y -= pivot[1]; vertex.co.z -= pivot[2]
        part.location = pivot
    elif nodes:
        # An ordinary node: it stays at its position and the vertices stay about the origin.
        part.location = tuple(float(v) for v in nodes[0][1:].split(":"))
        bpy.ops.object.transform_apply(scale=True, location=False)
    else:
        bpy.ops.object.transform_apply(scale=True, location=True)
    for material in materials:
        part.data.materials.append(bpy.data.materials.new(material))
    for index, polygon in enumerate(part.data.polygons):
        polygon.material_index = index % max(1, len(materials))
bpy.ops.export_scene.fbx(filepath=out, global_scale=1.0)
`;

export interface PartSpec {
  readonly name: string;
  readonly size: Vec3;
  readonly materials: readonly string[];
  /** Blender-space (Z up) centre of the part's geometry, baked into its vertices: the part sits off its pivot. */
  readonly offset?: Vec3;
  /** Blender-space node position kept on the node, with the vertices about its negative (a Maya pivot offset). */
  readonly pivot?: Vec3;
  /** Blender-space node position kept on the node with the vertices left about the origin (an ordinary placed node). */
  readonly nodeAt?: Vec3;
}

/** An FBX of one box per part, all at the origin, each with its own material slots, made by the importer's Blender. */
export async function writePartsFbx(target: string, parts: readonly PartSpec[]): Promise<void> {
  const blender = await ensureBlender(process.env);
  await mkdir(dirname(target), { recursive: true });
  const script = `${target}.py`;
  await writeFile(script, PARTS_SCRIPT);
  const specs = parts.map((part) => [part.name, ...part.size, ...part.materials, ...(part.offset ? [`@${part.offset.join(":")}`] : []), ...(part.pivot ? [`^${part.pivot.join(":")}`] : []), ...(part.nodeAt ? [`~${part.nodeAt.join(":")}`] : [])].join(","));
  const run = await runBounded(blender.path, ["-b", "--factory-startup", "--python-exit-code", "1", "--python", script, "--", target, ...specs], {
    timeoutMs: 120_000,
  });
  if (run.code !== 0) throw new Error(`Blender could not write the test FBX: ${run.stderr.slice(-300)}`);
}
