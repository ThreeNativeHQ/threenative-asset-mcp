/** Synthetic Unity models, materials and textures. Nothing here is real or licensed. */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import sharp from "sharp";

import { ensureBlender } from "../../src/unity/blender.js";
import { runBounded } from "../../src/unreal/toolchain.js";
import { type TextureLookup } from "../../src/unity/materials.js";
import { type TextureSettings } from "../../src/unity/textures.js";
import { guidFor } from "./unity-fixtures.js";

export const BUILTIN = "0000000000000000f000000000000000";
export const SHADERS = {
  standard: { guid: BUILTIN, fileID: "46" },
  standardSpecular: { guid: BUILTIN, fileID: "45" },
  urpLit: { guid: "933532a4fcc9baf4fa0491de14d08ed7", fileID: "4800000" },
  urpSimpleLit: { guid: "8d2bb70cbf9db8d4da26e15b26e74248", fileID: "4800000" },
  urpComplexLit: { guid: "ee7e4c9a5f6364b688a332c67fc32cca", fileID: "4800000" },
  hdrpLit: { guid: "6e4ae4064600d784cac1e41a9e6f2e59", fileID: "4800000" },
} as const;

export interface MaterialSpec {
  readonly name: string;
  readonly shader: { readonly guid: string; readonly fileID: string };
  readonly keywords?: string;
  readonly floats?: Readonly<Record<string, number>>;
  readonly colors?: Readonly<Record<string, readonly [number, number, number, number]>>;
  /** Property to the project path of the texture. */
  readonly textures?: Readonly<Record<string, string | { path: string; scale?: [number, number]; offset?: [number, number] }>>;
}

/** A `.mat` in Unity's own text layout. */
export function materialYaml(spec: MaterialSpec): string {
  const textures = Object.entries(spec.textures ?? {}).map(([name, value]) => {
    const { path, scale = [1, 1], offset = [0, 0] } = typeof value === "string" ? { path: value } : value;
    return `    - ${name}:\n        m_Texture: {fileID: 2800000, guid: ${guidFor(path)}, type: 3}\n        m_Scale: {x: ${scale[0]}, y: ${scale[1]}}\n        m_Offset: {x: ${offset[0]}, y: ${offset[1]}}`;
  });
  const floats = Object.entries(spec.floats ?? {}).map(([name, value]) => `    - ${name}: ${value}`);
  const colors = Object.entries(spec.colors ?? {}).map(
    ([name, [r, g, b, a]]) => `    - ${name}: {r: ${r}, g: ${g}, b: ${b}, a: ${a}}`,
  );
  return [
    "%YAML 1.1",
    "%TAG !u! tag:unity3d.com,2011:",
    "--- !u!21 &2100000",
    "Material:",
    "  serializedVersion: 8",
    "  m_ObjectHideFlags: 0",
    `  m_Name: ${spec.name}`,
    `  m_Shader: {fileID: ${spec.shader.fileID}, guid: ${spec.shader.guid}, type: ${spec.shader.guid === BUILTIN ? 0 : 3}}`,
    `  m_ShaderKeywords: ${spec.keywords ?? ""}`,
    "  m_SavedProperties:",
    "    serializedVersion: 3",
    textures.length > 0 ? `    m_TexEnvs:\n${textures.join("\n")}` : "    m_TexEnvs: []",
    floats.length > 0 ? `    m_Floats:\n${floats.join("\n")}` : "    m_Floats: []",
    colors.length > 0 ? `    m_Colors:\n${colors.join("\n")}` : "    m_Colors: []",
    "",
  ].join("\n");
}

export const DEFAULT_TEXTURE: TextureSettings = {
  srgb: true,
  normalMap: false,
  convertToNormalMap: false,
  flipGreenChannel: false,
};

/** A lookup that knows the listed texture paths. Anything else is "missing". */
export function textureLookup(known: Readonly<Record<string, Partial<TextureSettings>>>): TextureLookup {
  const byGuid = new Map(Object.entries(known).map(([path, settings]) => [guidFor(path), { path, settings: { ...DEFAULT_TEXTURE, ...settings } }]));
  return (ref) => {
    if (!ref?.guid) return undefined;
    const found = byGuid.get(ref.guid);
    return found ? { guid: ref.guid, path: found.path, settings: found.settings } : "missing";
  };
}

export async function pngBytes(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): Promise<Buffer> {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) data.set(pixel(x, y), (y * width + x) * 4);
  }
  return sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
}

export const solidPng = (width: number, height: number, rgba: [number, number, number, number]): Promise<Buffer> =>
  pngBytes(width, height, () => rgba);

/** TextureImporter block for a `.meta`. */
export function textureImporter(options: { srgb?: boolean; normalMap?: boolean; convertToNormalMap?: boolean } = {}): string {
  return [
    "TextureImporter:",
    "  serializedVersion: 12",
    "  bumpmap:",
    `    convertToNormalMap: ${options.convertToNormalMap ? 1 : 0}`,
    `  sRGBTexture: ${options.srgb === false ? 0 : 1}`,
    `  textureType: ${options.normalMap ? 1 : 0}`,
    "  platformSettings:",
    "  - serializedVersion: 3",
    "    buildTarget: DefaultTexturePlatform",
    "    maxTextureSize: 2048",
  ].join("\n");
}

export interface ModelImporterOptions {
  readonly globalScale?: number;
  readonly useFileScale?: boolean;
  readonly materialImportMode?: number;
  /** Embedded material name to the project path of the `.mat`. */
  readonly externalObjects?: Readonly<Record<string, string>>;
  /** Embedded name to a guid that does not exist in the package. */
  readonly externalObjectGuids?: Readonly<Record<string, string>>;
}

/** ModelImporter block for a `.meta`, in the layout current Unity versions write. */
export function modelImporter(options: ModelImporterOptions = {}): string {
  const external = [
    ...Object.entries(options.externalObjects ?? {}).map(([name, path]) => [name, guidFor(path)] as const),
    ...Object.entries(options.externalObjectGuids ?? {}),
  ];
  return [
    "ModelImporter:",
    "  serializedVersion: 22200",
    "  internalIDToNameTable: []",
    external.length > 0 ? "  externalObjects:" : "  externalObjects: {}",
    ...external.flatMap(([name, guid]) => [
      "  - first:",
      "      type: UnityEngine:Material",
      "      assembly: UnityEngine.CoreModule",
      `      name: ${name}`,
      `    second: {fileID: 2100000, guid: ${guid}, type: 2}`,
    ]),
    "  materials:",
    `    materialImportMode: ${options.materialImportMode ?? 2}`,
    "    materialName: 0",
    "    materialSearch: 1",
    "    materialLocation: 1",
    "  meshes:",
    `    globalScale: ${options.globalScale ?? 1}`,
    `    useFileScale: ${options.useFileScale === false ? 0 : 1}`,
  ].join("\n");
}

const CUBE_SCRIPT = String.raw`
import bpy, sys
out, unit, *names = sys.argv[sys.argv.index("--") + 1:]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=1.0)
cube = bpy.context.object
cube.name = "Crate"
for name in names:
    cube.data.materials.append(bpy.data.materials.new(name))
for index, polygon in enumerate(cube.data.polygons):
    polygon.material_index = index % max(1, len(names))
if unit == "cm":
    bpy.context.scene.unit_settings.scale_length = 0.01
    bpy.context.scene.unit_settings.length_unit = "CENTIMETERS"
    cube.scale = (100, 100, 100)
    bpy.ops.object.transform_apply(scale=True)
bpy.ops.export_scene.fbx(filepath=out, apply_unit_scale=(unit == "cm"), global_scale=1.0)
`;

/**
 * Writes an FBX of a 1 m cube whose faces cycle through `materials` (one slot each), made by the same Blender the
 * importer uses. `unit: "cm"` writes a centimetre file: 100 units across, with a file unit of 1 cm.
 */
export async function writeCubeFbx(target: string, materials: readonly string[], unit: "m" | "cm" = "m"): Promise<void> {
  const blender = await ensureBlender(process.env);
  await mkdir(dirname(target), { recursive: true });
  const script = `${target}.py`;
  await writeFile(script, CUBE_SCRIPT);
  const run = await runBounded(blender.path, ["-b", "--factory-startup", "--python-exit-code", "1", "--python", script, "--", target, unit, ...materials], {
    timeoutMs: 120_000,
  });
  if (run.code !== 0) throw new Error(`Blender could not write the test FBX: ${run.stderr.slice(-300)}`);
}
