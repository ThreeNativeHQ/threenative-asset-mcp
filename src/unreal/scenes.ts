import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

import { Document, MathUtils, NodeIO, VertexLayout, type Accessor, type mat4, type Mesh, type Node, type vec3, type vec4 } from "@gltf-transform/core";
import { EXTMeshGPUInstancing, KHRLightsPunctual, KHRMaterialsUnlit, type Light } from "@gltf-transform/extensions";
import { copyToDocument, dedup, getBounds, unpartition } from "@gltf-transform/functions";

export interface UnrealVector {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface UnrealRotator {
  readonly pitch: number;
  readonly yaw: number;
  readonly roll: number;
}

export interface UnrealSceneActor {
  readonly name: string;
  readonly meshName: string;
  readonly location: UnrealVector;
  readonly rotation: UnrealRotator;
  readonly scale: UnrealVector;
  readonly parent: string;
}

export interface UnrealSceneInstanceGroup {
  readonly name: string;
  readonly meshName: string;
  /** World-space transforms decoded from an ISM/HISM/foliage component. */
  readonly transforms: readonly Omit<UnrealSceneActor, "name" | "meshName" | "parent">[];
  readonly parent: string;
  readonly sourceClass: string;
}

export interface UnrealSceneLight {
  readonly name: string;
  readonly type: "directional" | "point" | "spot" | "rect";
  readonly location: UnrealVector;
  readonly rotation: UnrealRotator;
  readonly color: readonly [number, number, number];
  readonly intensity: number;
  readonly range: number;
  readonly innerConeAngle: number;
  readonly outerConeAngle: number;
  readonly temperature: number;
  readonly useTemperature: boolean;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
}

export interface UnrealSceneText {
  readonly name: string;
  readonly text: string;
  readonly fontName: string;
  readonly fontPath: string;
  readonly worldSize: number;
  readonly horizontalAlignment: string;
  readonly verticalAlignment: string;
  readonly color: readonly [number, number, number, number];
  readonly location: UnrealVector;
  readonly rotation: UnrealRotator;
  readonly scale: UnrealVector;
  readonly parent: string;
}

export interface UnrealSceneOmission {
  readonly actor: string;
  readonly component: string;
  readonly sourceClass: string;
  readonly reason: string;
  /** PRD-584: the portable effect descriptor this component was exported as, relative to the import
   * output (`Effects/<system>-<hash>.cascade.json` or `.niagara.json`). Absent for non-effect omissions. */
  readonly descriptor?: string;
}

export interface UnrealSceneLandscape {
  readonly name: string;
  readonly materialName: string;
  readonly location: UnrealVector;
  readonly rotation: UnrealRotator;
  readonly scale: UnrealVector;
  readonly sizeQuads: number;
  /** Row-major UE local heights, with (sizeQuads + 1)^2 entries. */
  readonly heights: readonly number[];
  /** Row-major UE local XYZ normals, with three values per height. */
  readonly normals: readonly number[];
}

export interface UnrealSceneSource {
  readonly format: "threenative-unreal-scene-source";
  readonly version: 1;
  readonly mapName: string;
  readonly sourceFile: string;
  readonly actors: readonly UnrealSceneActor[];
  readonly instanceGroups?: readonly UnrealSceneInstanceGroup[];
  readonly landscapes?: readonly UnrealSceneLandscape[];
  readonly lights: readonly UnrealSceneLight[];
  readonly texts?: readonly UnrealSceneText[];
  readonly omittedActors?: readonly UnrealSceneOmission[];
  /** Serialized component templates merged into placed Blueprint instances; bytecode is not run. */
  readonly blueprintComponents: number;
  readonly camera: {
    readonly hasCamera: boolean;
    readonly location: UnrealVector;
    readonly rotation: UnrealRotator;
  };
}

export interface SceneModel {
  readonly name: string;
  readonly glb: string;
  readonly kind?: "static" | "skeletal";
}

export interface ImportedScene {
  readonly name: string;
  readonly package: string;
  readonly glb: string;
  /** Bounding-box size of the assembled level in metres, so a game can place it unopened. Absent
   * when the level reconstructs no geometry to measure. */
  readonly sizeMeters: { readonly x: number; readonly y: number; readonly z: number } | undefined;
  readonly manifest: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly actors: number;
  readonly resolvedActors: number;
  readonly instanceGroups: number;
  readonly instances: number;
  readonly resolvedInstances: number;
  readonly landscapes: number;
  readonly landscapeVertices: number;
  readonly unresolvedMeshes: readonly string[];
  readonly generatedEnginePrimitives: readonly string[];
  readonly lights: number;
  readonly blueprintComponents: number;
  readonly approximatedAreaLights: number;
  readonly omittedActors: readonly UnrealSceneOmission[];
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Scene field ${label} is not a finite number.`);
  }
  return value;
}

function vector(value: unknown, label: string): UnrealVector {
  if (!value || typeof value !== "object") throw new Error(`Scene field ${label} is not a vector.`);
  const object = value as Record<string, unknown>;
  return {
    x: finite(object.x, `${label}.x`),
    y: finite(object.y, `${label}.y`),
    z: finite(object.z, `${label}.z`),
  };
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024) {
    throw new Error(`Scene field ${label} is not a bounded string.`);
  }
  return value;
}

/** Validates the JSON emitted by the isolated Unreal parser before it reaches the promoted output. */
export function parseUnrealSceneSource(json: string): UnrealSceneSource {
  const value = JSON.parse(json) as Record<string, unknown>;
  if (value.format !== "threenative-unreal-scene-source" || value.version !== 1) {
    throw new Error("Unrecognized Unreal scene-source format or version.");
  }
  if (!Array.isArray(value.actors) || value.actors.length > 1_000_000) {
    throw new Error("Unreal scene actor list is missing or unreasonably large.");
  }
  const actors = value.actors.map((raw, index): UnrealSceneActor => {
    if (!raw || typeof raw !== "object") throw new Error(`Scene actor ${index} is invalid.`);
    const actor = raw as Record<string, unknown>;
    const rotation = actor.rotation as Record<string, unknown> | undefined;
    return {
      name: text(actor.name, `actors[${index}].name`),
      meshName: text(actor.meshName, `actors[${index}].meshName`),
      location: vector(actor.location, `actors[${index}].location`),
      rotation: {
        pitch: finite(rotation?.pitch, `actors[${index}].rotation.pitch`),
        yaw: finite(rotation?.yaw, `actors[${index}].rotation.yaw`),
        roll: finite(rotation?.roll, `actors[${index}].rotation.roll`),
      },
      scale: vector(actor.scale, `actors[${index}].scale`),
      parent: typeof actor.parent === "string" ? actor.parent.slice(0, 1_024) : "",
    };
  });
  const rawInstanceGroups = value.instanceGroups ?? [];
  if (!Array.isArray(rawInstanceGroups) || rawInstanceGroups.length > 100_000) {
    throw new Error("Unreal scene instance-group list is invalid or unreasonably large.");
  }
  let instanceCount = 0;
  const instanceGroups = rawInstanceGroups.map((raw, groupIndex): UnrealSceneInstanceGroup => {
    if (!raw || typeof raw !== "object") throw new Error(`Scene instance group ${groupIndex} is invalid.`);
    const group = raw as Record<string, unknown>;
    if (!Array.isArray(group.transforms)) {
      throw new Error(`Scene instance group ${groupIndex} has no transform list.`);
    }
    instanceCount += group.transforms.length;
    if (instanceCount > 1_000_000) throw new Error("Unreal scene has more than 1,000,000 instances.");
    return {
      name: text(group.name, `instanceGroups[${groupIndex}].name`),
      meshName: text(group.meshName, `instanceGroups[${groupIndex}].meshName`),
      transforms: group.transforms.map((rawTransform, transformIndex) => {
        if (!rawTransform || typeof rawTransform !== "object") {
          throw new Error(`Scene instance transform ${groupIndex}:${transformIndex} is invalid.`);
        }
        const transform = rawTransform as Record<string, unknown>;
        const rotation = transform.rotation as Record<string, unknown> | undefined;
        return {
          location: vector(transform.location, `instanceGroups[${groupIndex}].transforms[${transformIndex}].location`),
          rotation: {
            pitch: finite(rotation?.pitch, `instanceGroups[${groupIndex}].transforms[${transformIndex}].rotation.pitch`),
            yaw: finite(rotation?.yaw, `instanceGroups[${groupIndex}].transforms[${transformIndex}].rotation.yaw`),
            roll: finite(rotation?.roll, `instanceGroups[${groupIndex}].transforms[${transformIndex}].rotation.roll`),
          },
          scale: vector(transform.scale, `instanceGroups[${groupIndex}].transforms[${transformIndex}].scale`),
        };
      }),
      parent: typeof group.parent === "string" ? group.parent.slice(0, 1_024) : "",
      sourceClass: text(group.sourceClass, `instanceGroups[${groupIndex}].sourceClass`),
    };
  });
  const rawLights = value.lights ?? [];
  if (!Array.isArray(rawLights) || rawLights.length > 100_000) {
    throw new Error("Unreal scene light list is invalid or unreasonably large.");
  }
  const lights = rawLights.map((raw, index): UnrealSceneLight => {
    if (!raw || typeof raw !== "object") throw new Error(`Scene light ${index} is invalid.`);
    const light = raw as Record<string, unknown>;
    const rotation = light.rotation as Record<string, unknown> | undefined;
    const color = light.color;
    if (
      !Array.isArray(color) ||
      color.length !== 3 ||
      color.some((channel) => typeof channel !== "number" || !Number.isFinite(channel))
    ) {
      throw new Error(`Scene light ${index} color is invalid.`);
    }
    if (!["directional", "point", "spot", "rect"].includes(String(light.type))) {
      throw new Error(`Scene light ${index} type is unsupported.`);
    }
    return {
      name: text(light.name, `lights[${index}].name`),
      type: light.type as UnrealSceneLight["type"],
      location: vector(light.location, `lights[${index}].location`),
      rotation: {
        pitch: finite(rotation?.pitch, `lights[${index}].rotation.pitch`),
        yaw: finite(rotation?.yaw, `lights[${index}].rotation.yaw`),
        roll: finite(rotation?.roll, `lights[${index}].rotation.roll`),
      },
      color: color as unknown as [number, number, number],
      intensity: finite(light.intensity, `lights[${index}].intensity`),
      range: finite(light.range, `lights[${index}].range`),
      innerConeAngle: finite(light.innerConeAngle, `lights[${index}].innerConeAngle`),
      outerConeAngle: finite(light.outerConeAngle, `lights[${index}].outerConeAngle`),
      temperature: finite(light.temperature, `lights[${index}].temperature`),
      useTemperature: light.useTemperature === true,
      sourceWidth: finite(light.sourceWidth, `lights[${index}].sourceWidth`),
      sourceHeight: finite(light.sourceHeight, `lights[${index}].sourceHeight`),
    };
  });
  const rawTexts = value.texts ?? [];
  if (!Array.isArray(rawTexts) || rawTexts.length > 100_000) throw new Error("Unreal scene text list is invalid or unreasonably large.");
  const texts = rawTexts.map((raw, index): UnrealSceneText => {
    const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : undefined;
    if (!item || typeof item.text !== "string" || item.text.length > 1_000_000) throw new Error(`Scene text ${index} is invalid.`);
    const rotation = item.rotation as Record<string, unknown> | undefined;
    const color = item.color;
    if (!Array.isArray(color) || color.length !== 4 || color.some((channel) => typeof channel !== "number" || !Number.isInteger(channel) || channel < 0 || channel > 255)) {
      throw new Error(`Scene text ${index} color is invalid.`);
    }
    return {
      name: text(item.name, `texts[${index}].name`), text: item.text,
      fontName: text(item.fontName, `texts[${index}].fontName`), fontPath: text(item.fontPath, `texts[${index}].fontPath`),
      worldSize: finite(item.worldSize, `texts[${index}].worldSize`),
      horizontalAlignment: text(item.horizontalAlignment, `texts[${index}].horizontalAlignment`),
      verticalAlignment: text(item.verticalAlignment, `texts[${index}].verticalAlignment`),
      color: color as [number, number, number, number],
      location: vector(item.location, `texts[${index}].location`),
      rotation: { pitch: finite(rotation?.pitch, `texts[${index}].rotation.pitch`), yaw: finite(rotation?.yaw, `texts[${index}].rotation.yaw`), roll: finite(rotation?.roll, `texts[${index}].rotation.roll`) },
      scale: vector(item.scale, `texts[${index}].scale`), parent: typeof item.parent === "string" ? item.parent.slice(0, 1_024) : "",
    };
  });
  const rawOmissions = value.omittedActors ?? [];
  if (!Array.isArray(rawOmissions) || rawOmissions.length > 100_000) throw new Error("Unreal scene omission list is invalid or unreasonably large.");
  const omittedActors = rawOmissions.map((raw, index): UnrealSceneOmission => {
    const omission = raw && typeof raw === "object" ? raw as Record<string, unknown> : undefined;
    if (!omission) throw new Error(`Scene omission ${index} is invalid.`);
    const descriptor = typeof omission.descriptor === "string" && omission.descriptor.length > 0
      ? text(omission.descriptor, `omittedActors[${index}].descriptor`)
      : undefined;
    return {
      actor: text(omission.actor, `omittedActors[${index}].actor`),
      component: text(omission.component, `omittedActors[${index}].component`),
      sourceClass: text(omission.sourceClass, `omittedActors[${index}].sourceClass`),
      reason: text(omission.reason, `omittedActors[${index}].reason`),
      ...(descriptor !== undefined ? { descriptor } : {}),
    };
  });
  const rawLandscapes = value.landscapes ?? [];
  if (!Array.isArray(rawLandscapes) || rawLandscapes.length > 100_000) {
    throw new Error("Unreal scene landscape list is invalid or unreasonably large.");
  }
  let landscapeVertices = 0;
  const landscapes = rawLandscapes.map((raw, index): UnrealSceneLandscape => {
    if (!raw || typeof raw !== "object") throw new Error(`Scene landscape ${index} is invalid.`);
    const landscape = raw as Record<string, unknown>;
    const sizeQuads = finite(landscape.sizeQuads, `landscapes[${index}].sizeQuads`);
    if (!Number.isInteger(sizeQuads) || sizeQuads < 1 || sizeQuads > 8_192) {
      throw new Error(`Scene landscape ${index} quad count is invalid.`);
    }
    const vertexCount = (sizeQuads + 1) ** 2;
    landscapeVertices += vertexCount;
    if (landscapeVertices > 4_000_000) throw new Error("Unreal scene has more than 4,000,000 landscape vertices.");
    if (!Array.isArray(landscape.heights) || landscape.heights.length !== vertexCount) {
      throw new Error(`Scene landscape ${index} height count is invalid.`);
    }
    if (!Array.isArray(landscape.normals) || landscape.normals.length !== vertexCount * 3) {
      throw new Error(`Scene landscape ${index} normal count is invalid.`);
    }
    const heights = landscape.heights.map((height, heightIndex) =>
      finite(height, `landscapes[${index}].heights[${heightIndex}]`));
    const normals = landscape.normals.map((normal, normalIndex) =>
      finite(normal, `landscapes[${index}].normals[${normalIndex}]`));
    const rotation = landscape.rotation as Record<string, unknown> | undefined;
    return {
      name: text(landscape.name, `landscapes[${index}].name`),
      materialName: text(landscape.materialName, `landscapes[${index}].materialName`),
      location: vector(landscape.location, `landscapes[${index}].location`),
      rotation: {
        pitch: finite(rotation?.pitch, `landscapes[${index}].rotation.pitch`),
        yaw: finite(rotation?.yaw, `landscapes[${index}].rotation.yaw`),
        roll: finite(rotation?.roll, `landscapes[${index}].rotation.roll`),
      },
      scale: vector(landscape.scale, `landscapes[${index}].scale`),
      sizeQuads,
      heights,
      normals,
    };
  });
  const camera = value.camera as Record<string, unknown> | undefined;
  const cameraRotation = camera?.rotation as Record<string, unknown> | undefined;
  const blueprintComponents = value.blueprintComponents ?? 0;
  if (
    typeof blueprintComponents !== "number" ||
    !Number.isInteger(blueprintComponents) ||
    blueprintComponents < 0 ||
    blueprintComponents > 1_000_000
  ) {
    throw new Error("Unreal scene Blueprint component count is invalid.");
  }
  return {
    format: "threenative-unreal-scene-source",
    version: 1,
    mapName: text(value.mapName, "mapName"),
    sourceFile: text(value.sourceFile, "sourceFile"),
    actors,
    instanceGroups,
    landscapes,
    lights,
    texts,
    omittedActors,
    blueprintComponents,
    camera: {
      hasCamera: camera?.hasCamera === true,
      location: vector(camera?.location ?? { x: 0, y: 0, z: 0 }, "camera.location"),
      rotation: {
        pitch: finite(cameraRotation?.pitch ?? 0, "camera.rotation.pitch"),
        yaw: finite(cameraRotation?.yaw ?? 0, "camera.rotation.yaw"),
        roll: finite(cameraRotation?.roll ?? 0, "camera.rotation.roll"),
      },
    },
  };
}

function srgbToLinear(channel: number): number {
  const clamped = Math.min(1, Math.max(0, channel));
  return clamped <= 0.04045 ? clamped / 12.92 : ((clamped + 0.055) / 1.055) ** 2.4;
}

/** Approximate black-body colour, used only when the Unreal light explicitly enables temperature. */
export function kelvinToLinearRgb(kelvin: number): [number, number, number] {
  const temperature = Math.min(400, Math.max(10, kelvin / 100));
  const red = temperature <= 66 ? 255 : 329.698727446 * (temperature - 60) ** -0.1332047592;
  const green = temperature <= 66
    ? 99.4708025861 * Math.log(temperature) - 161.1195681661
    : 288.1221695283 * (temperature - 60) ** -0.0755148492;
  const blue = temperature >= 66
    ? 255
    : temperature <= 19
      ? 0
      : 138.5177312231 * Math.log(temperature - 10) - 305.0447927307;
  return [red, green, blue].map((channel) => srgbToLinear(channel / 255)) as [number, number, number];
}

function multiply(left: readonly number[], right: readonly number[]): number[] {
  const result = Array<number>(16).fill(0);
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      for (let inner = 0; inner < 4; inner += 1) {
        const index = row * 4 + column;
        result[index] =
          (result[index] ?? 0) +
          (left[row * 4 + inner] ?? 0) * (right[inner * 4 + column] ?? 0);
      }
    }
  }
  return result;
}

/**
 * UE (left-handed, Z-up centimetres) → glTF/Three.js (right-handed, Y-up metres).
 * Returned storage is column-major, accepted directly by glTF and THREE.Matrix4.fromArray().
 */
export function unrealTransformToGltfMatrix(
  location: UnrealVector,
  rotation: UnrealRotator,
  scale: UnrealVector,
): mat4 {
  const pitch = rotation.pitch * Math.PI / 180;
  const yaw = rotation.yaw * Math.PI / 180;
  const roll = rotation.roll * Math.PI / 180;
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cr = Math.cos(roll), sr = Math.sin(roll);
  const ue = [
    cy * cp * scale.x, (cy * sp * sr - sy * cr) * scale.y, (cy * sp * cr + sy * sr) * scale.z, location.x * 0.01,
    sy * cp * scale.x, (sy * sp * sr + cy * cr) * scale.y, (sy * sp * cr - cy * sr) * scale.z, location.y * 0.01,
    -sp * scale.x, cp * sr * scale.y, cp * cr * scale.z, location.z * 0.01,
    0, 0, 0, 1,
  ];
  const conversion = [0, 1, 0, 0, 0, 0, 1, 0, -1, 0, 0, 0, 0, 0, 0, 1];
  const inverse = [0, 0, -1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1];
  const rowMajor = multiply(multiply(conversion, ue), inverse);
  return [
    rowMajor[0]!, rowMajor[4]!, rowMajor[8]!, rowMajor[12]!,
    rowMajor[1]!, rowMajor[5]!, rowMajor[9]!, rowMajor[13]!,
    rowMajor[2]!, rowMajor[6]!, rowMajor[10]!, rowMajor[14]!,
    rowMajor[3]!, rowMajor[7]!, rowMajor[11]!, rowMajor[15]!,
  ] as mat4;
}

export interface AssembleSceneRequest {
  readonly source: UnrealSceneSource;
  readonly package: string;
  readonly outputRoot: string;
  /** Relative path stem used only to disambiguate same-named scenes from different package folders. */
  readonly outputStem?: string;
  readonly models: readonly SceneModel[];
  readonly bitmapFonts?: readonly { readonly name: string; readonly manifest: string }[];
  /**
   * PRD-584 AC-4: the effect descriptors actually written this import, keyed by output path and
   * canonical source package. An omission's `descriptor` is kept only when exactly one written
   * effect matches that full path, so a dangling or basename-colliding pointer is never reported.
   */
  readonly effectDescriptors?: readonly { readonly descriptor: string; readonly package: string }[];
  readonly validate: (
    path: string,
    options?: { readonly allowEmptyScene?: boolean },
  ) => Promise<{ bytes: number; sha256: string }>;
}

async function createBitmapTextMesh(
  document: Document,
  outputRoot: string,
  source: UnrealSceneText,
  font: { readonly name: string; readonly manifest: string },
): Promise<Mesh> {
  const manifestPath = join(outputRoot, font.manifest);
  const raw = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  const common = raw.common as Record<string, unknown> | undefined;
  const pages = raw.pages;
  const chars = raw.chars;
  const lineHeight = common?.lineHeight;
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > 256 || pages.some((page) => typeof page !== "string" || !/^[-A-Za-z0-9_.]+\.png$/i.test(page)) ||
      !Array.isArray(chars) || chars.length > 1_000_000 || typeof lineHeight !== "number" || !Number.isFinite(lineHeight) || lineHeight <= 0) {
    throw new Error(`bitmap font ${font.name} manifest is invalid`);
  }
  type Glyph = { id: number; x: number; y: number; width: number; height: number; xoffset: number; yoffset: number; xadvance: number; page: number };
  const glyphs = new Map<number, Glyph>();
  for (const [index, value] of chars.entries()) {
    if (!value || typeof value !== "object") throw new Error(`bitmap font glyph ${index} is invalid`);
    const glyph = value as Record<string, unknown>;
    const numbers = [glyph.id, glyph.x, glyph.y, glyph.width, glyph.height, glyph.xoffset, glyph.yoffset, glyph.xadvance, glyph.page];
    if (numbers.some((number) => typeof number !== "number" || !Number.isFinite(number))) throw new Error(`bitmap font glyph ${index} is invalid`);
    glyphs.set(glyph.id as number, glyph as unknown as Glyph);
  }
  const lines = source.text.replaceAll("\r\n", "\n").split("\n");
  const lineWidths = lines.map((line) => [...line].reduce((sum, character) => sum + (glyphs.get(character.codePointAt(0)!)?.xadvance ?? 0), 0));
  const height = lines.length * lineHeight;
  const worldScale = source.worldSize * 0.01 / lineHeight;
  const byPage = new Map<number, { positions: number[]; uvs: number[]; indices: number[] }>();
  for (const [lineIndex, line] of lines.entries()) {
    let cursor = source.horizontalAlignment.endsWith("Center") ? -lineWidths[lineIndex]! / 2
      : source.horizontalAlignment.endsWith("Right") ? -lineWidths[lineIndex]! : 0;
    const verticalShift = source.verticalAlignment.endsWith("TextCenter") ? height / 2
      : source.verticalAlignment.endsWith("TextBottom") ? height : 0;
    for (const character of line) {
      const glyph = glyphs.get(character.codePointAt(0)!);
      if (!glyph) continue;
      const page = byPage.get(glyph.page) ?? { positions: [], uvs: [], indices: [] };
      const pageName = pages[glyph.page];
      if (typeof pageName !== "string") throw new Error(`bitmap font glyph references missing page ${glyph.page}`);
      const { default: sharp } = await import("sharp");
      const metadata = await sharp(join(manifestPath, "..", pageName)).metadata();
      if (!metadata.width || !metadata.height) throw new Error(`bitmap font page ${glyph.page} has no dimensions`);
      const x0 = (cursor + glyph.xoffset) * worldScale, x1 = x0 + glyph.width * worldScale;
      const y0 = (verticalShift - lineIndex * lineHeight - glyph.yoffset) * worldScale, y1 = y0 - glyph.height * worldScale;
      const base = page.positions.length / 3;
      page.positions.push(x0,y0,0, x1,y0,0, x1,y1,0, x0,y1,0);
      page.uvs.push(glyph.x/metadata.width,glyph.y/metadata.height, (glyph.x+glyph.width)/metadata.width,glyph.y/metadata.height,
        (glyph.x+glyph.width)/metadata.width,(glyph.y+glyph.height)/metadata.height, glyph.x/metadata.width,(glyph.y+glyph.height)/metadata.height);
      page.indices.push(base,base+1,base+2, base,base+2,base+3);
      byPage.set(glyph.page, page); cursor += glyph.xadvance;
    }
  }
  if ([...byPage.values()].every((page) => page.positions.length === 0)) throw new Error(`text ${source.name} has no glyphs present in ${font.name}`);
  const mesh = document.createMesh(source.name);
  const buffer = document.getRoot().listBuffers()[0] ?? document.createBuffer("Scene text");
  const { default: sharp } = await import("sharp");
  for (const [pageIndex, geometry] of byPage) {
    const pageName = pages[pageIndex] as string;
    const decoded = await sharp(join(manifestPath, "..", pageName)).removeAlpha().extractChannel(0).raw().toBuffer({ resolveWithObject: true });
    const rgba = Buffer.alloc(decoded.info.width * decoded.info.height * 4);
    for (let pixel = 0; pixel < decoded.data.length; pixel++) rgba.set([255,255,255,decoded.data[pixel]!], pixel * 4);
    const image = await sharp(rgba, { raw: { width: decoded.info.width, height: decoded.info.height, channels: 4 } }).png().toBuffer();
    const texture = document.createTexture(`${font.name}/${pageIndex}`).setImage(image).setMimeType("image/png");
    const color = source.color.map((channel) => channel / 255) as [number, number, number, number];
    const material = document.createMaterial(`${source.name}/${pageIndex}`).setBaseColorTexture(texture).setBaseColorFactor(color).setAlphaMode("BLEND").setDoubleSided(true);
    material.setExtension("KHR_materials_unlit", document.createExtension(KHRMaterialsUnlit).createUnlit());
    const IndexArray = geometry.positions.length / 3 > 65_535 ? Uint32Array : Uint16Array;
    mesh.addPrimitive(document.createPrimitive()
      .setAttribute("POSITION", document.createAccessor().setType("VEC3").setArray(new Float32Array(geometry.positions)).setBuffer(buffer))
      .setAttribute("TEXCOORD_0", document.createAccessor().setType("VEC2").setArray(new Float32Array(geometry.uvs)).setBuffer(buffer))
      .setIndices(document.createAccessor().setType("SCALAR").setArray(new IndexArray(geometry.indices)).setBuffer(buffer)).setMaterial(material));
  }
  return mesh;
}

/** Engine BasicShapes are installation content, so marketplace projects reference but do not ship them. */
function createEnginePrimitive(document: Document, name: string): Mesh | undefined {
  if (name !== "Plane") return undefined;
  const buffer = document.getRoot().listBuffers()[0] ?? document.createBuffer("Generated primitives");
  const position = document
    .createAccessor("Plane_POSITION")
    .setType("VEC3")
    .setArray(new Float32Array([-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5]))
    .setBuffer(buffer);
  const normal = document
    .createAccessor("Plane_NORMAL")
    .setType("VEC3")
    .setArray(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]))
    .setBuffer(buffer);
  const uv = document
    .createAccessor("Plane_TEXCOORD_0")
    .setType("VEC2")
    .setArray(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]))
    .setBuffer(buffer);
  const indices = document
    .createAccessor("Plane_INDICES")
    .setType("SCALAR")
    .setArray(new Uint16Array([0, 2, 1, 0, 3, 2]))
    .setBuffer(buffer);
  const material = document
    .createMaterial("UE_Engine_Plane_Default")
    .setBaseColorFactor([0.5, 0.5, 0.5, 1])
    .setRoughnessFactor(1)
    .setDoubleSided(true);
  return document
    .createMesh("UE_Engine_Plane")
    .addPrimitive(
      document
        .createPrimitive()
        .setAttribute("POSITION", position)
        .setAttribute("NORMAL", normal)
        .setAttribute("TEXCOORD_0", uv)
        .setIndices(indices)
        .setMaterial(material),
    );
}

/**
 * `dedup()` merges byte-identical accessors, so a primitive whose lightmap UVs equal its UV0 ends up with both
 * semantics on one accessor. The separate-layout writer gives each accessor one buffer view, so that view would carry
 * two semantics: the interleaved layout the native host rejects. A semantic that shares an accessor with another gets
 * a copy with the same values; the attributes and their data stay, only the sharing goes.
 */
function unshareAttributeAccessors(document: Document): void {
  const semanticByAccessor = new Map<Accessor, string>();
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      for (const semantic of primitive.listSemantics()) {
        const accessor = primitive.getAttribute(semantic);
        if (!accessor) continue;
        const owner = semanticByAccessor.get(accessor);
        if (owner === undefined) semanticByAccessor.set(accessor, semantic);
        else if (owner !== semantic) primitive.setAttribute(semantic, accessor.clone());
      }
    }
  }
}

/**
 * PRD-584 AC-4: reconcile each effect `omittedActors` pointer with the effect descriptors actually
 * written. The pointer is the identity-keyed `Effects/<system>-<hash>.<cascade|niagara>.json`; it is
 * kept only when exactly one written descriptor matches that full path. A missing descriptor, or a
 * path two different source packages collide on, leaves the omission with an explicit reason and no
 * dangling pointer.
 */
function reconcileEffectOmissions(
  omissions: readonly UnrealSceneOmission[],
  effectDescriptors: readonly { readonly descriptor: string; readonly package: string }[] | undefined,
): UnrealSceneOmission[] {
  if (effectDescriptors === undefined) return [...omissions];
  const packagesByDescriptor = new Map<string, Set<string>>();
  for (const effect of effectDescriptors) {
    const packages = packagesByDescriptor.get(effect.descriptor) ?? new Set<string>();
    packages.add(effect.package);
    packagesByDescriptor.set(effect.descriptor, packages);
  }
  return omissions.map((omission) => {
    if (omission.descriptor === undefined) return omission;
    const packages = packagesByDescriptor.get(omission.descriptor);
    if (packages !== undefined && packages.size === 1) return omission;
    const reason = packages === undefined
      ? `particle effect descriptor ${omission.descriptor} was not exported; its simulation is not reconstructed`
      : `particle effect descriptor ${omission.descriptor} is shared by ${packages.size} source packages, so it cannot be resolved; its simulation is not reconstructed`;
    return {
      actor: omission.actor,
      component: omission.component,
      sourceClass: omission.sourceClass,
      reason,
    };
  });
}

/** Creates one ordinary GLB scene whose nodes instance the already-imported unique mesh resources. */

export async function assembleSceneGlb(request: AssembleSceneRequest): Promise<ImportedScene> {
  const io = new NodeIO()
    .registerExtensions([KHRLightsPunctual, EXTMeshGPUInstancing, KHRMaterialsUnlit])
    .setVertexLayout(VertexLayout.SEPARATE);
  const document = new Document();
  document.getRoot().getAsset().generator = "threenative-asset-mcp Unreal scene importer";
  const scene = document.createScene(request.source.mapName);
  const modelByName = new Map(request.models.map((model) => [model.name, model]));
  const meshByName = new Map<string, Mesh>();
  const unresolved = new Set<string>();
  const generatedEnginePrimitives = new Set<string>();
  const omittedActors = reconcileEffectOmissions(request.source.omittedActors ?? [], request.effectDescriptors);
  let resolvedActors = 0;

  const preserveUsedExtensions = (sourceDocument: Document): void => {
    if (sourceDocument.getRoot().listExtensionsUsed().some((extension) => extension.extensionName === "KHR_materials_unlit") &&
        !document.getRoot().listExtensionsUsed().some((extension) => extension.extensionName === "KHR_materials_unlit")) {
      document.createExtension(KHRMaterialsUnlit);
    }
  };

  const addSkeletalActor = async (actor: UnrealSceneActor, model: SceneModel): Promise<boolean> => {
    const sourceDocument = await io.read(join(request.outputRoot, model.glb));
    preserveUsedExtensions(sourceDocument);
    const sourceScene = sourceDocument.getRoot().getDefaultScene() ?? sourceDocument.getRoot().listScenes()[0];
    if (!sourceScene) return false;
    const sourceRoots = sourceScene.listChildren();
    if (sourceRoots.length === 0) return false;
    const copied = copyToDocument(document, sourceDocument, sourceRoots);
    const wrapper = document.createNode(actor.name)
      .setMatrix(unrealTransformToGltfMatrix(actor.location, actor.rotation, actor.scale))
      .setExtras({ unreal: { meshName: actor.meshName, parent: actor.parent, skeletal: true } });
    for (const sourceRoot of sourceRoots) {
      const copiedRoot = copied.get(sourceRoot);
      if (copiedRoot) wrapper.addChild(copiedRoot as Node);
    }
    scene.addChild(wrapper);
    return true;
  };

  const resolveMesh = async (meshName: string): Promise<Mesh | undefined> => {
    let mesh = meshByName.get(meshName);
    if (mesh) return mesh;
    const model = modelByName.get(meshName);
    if (model) {
      const sourceDocument = await io.read(join(request.outputRoot, model.glb));
      // copyToDocument preserves extension properties only when the destination owns them.
      preserveUsedExtensions(sourceDocument);
      const sourceMesh = sourceDocument.getRoot().listMeshes()[0];
      if (sourceMesh) mesh = copyToDocument(document, sourceDocument, [sourceMesh]).get(sourceMesh) as Mesh;
    } else {
      mesh = createEnginePrimitive(document, meshName);
      if (mesh) generatedEnginePrimitives.add(meshName);
    }
    if (!mesh) {
      unresolved.add(meshName);
      return undefined;
    }
    meshByName.set(meshName, mesh);
    return mesh;
  };

  for (const actor of request.source.actors) {
    const sourceModel = modelByName.get(actor.meshName);
    if (sourceModel?.kind === "skeletal") {
      if (await addSkeletalActor(actor, sourceModel)) resolvedActors += 1;
      else unresolved.add(actor.meshName);
      continue;
    }
    const mesh = await resolveMesh(actor.meshName);
    if (!mesh) continue;
    scene.addChild(
      document
        .createNode(actor.name)
        .setMesh(mesh)
        .setMatrix(unrealTransformToGltfMatrix(actor.location, actor.rotation, actor.scale))
        .setExtras({ unreal: { meshName: actor.meshName, parent: actor.parent } }),
    );
    resolvedActors += 1;
  }
  const sourceTexts = request.source.texts ?? [];
  const bitmapFontByName = new Map((request.bitmapFonts ?? []).map((font) => [font.name.toLowerCase(), font]));
  for (const sourceText of sourceTexts) {
    const font = bitmapFontByName.get(sourceText.fontName.toLowerCase());
    if (!font) {
      unresolved.add(`TextFont:${sourceText.fontName}`);
      continue;
    }
    try {
      const mesh = await createBitmapTextMesh(document, request.outputRoot, sourceText, font);
      scene.addChild(document.createNode(sourceText.name).setMesh(mesh)
        .setMatrix(unrealTransformToGltfMatrix(sourceText.location, sourceText.rotation, sourceText.scale))
        .setExtras({ unreal: { fontName: sourceText.fontName, fontPath: sourceText.fontPath, parent: sourceText.parent } }));
      resolvedActors += 1;
    } catch {
      unresolved.add(`TextFont:${sourceText.fontName}`);
    }
  }

  let resolvedInstances = 0;
  const instanceGroups = request.source.instanceGroups ?? [];
  if (instanceGroups.length > 0) {
    const extension = document.createExtension(EXTMeshGPUInstancing).setRequired(true);
    for (const group of instanceGroups) {
      if (group.transforms.length === 0) continue;
      const mesh = await resolveMesh(group.meshName);
      if (!mesh) continue;
      const translations = new Float32Array(group.transforms.length * 3);
      const rotations = new Float32Array(group.transforms.length * 4);
      const scales = new Float32Array(group.transforms.length * 3);
      for (const [index, transform] of group.transforms.entries()) {
        const translation: vec3 = [0, 0, 0];
        const rotation: vec4 = [0, 0, 0, 1];
        const scale: vec3 = [1, 1, 1];
        MathUtils.decompose(
          unrealTransformToGltfMatrix(transform.location, transform.rotation, transform.scale),
          translation,
          rotation,
          scale,
        );
        translations.set(translation, index * 3);
        rotations.set(rotation, index * 4);
        scales.set(scale, index * 3);
      }
      const buffer = document.getRoot().listBuffers()[0] ?? document.createBuffer("Scene instances");
      const batch = extension
        .createInstancedMesh()
        .setAttribute(
          "TRANSLATION",
          document.createAccessor(`${group.name}/TRANSLATION`).setType("VEC3").setArray(translations).setBuffer(buffer),
        )
        .setAttribute(
          "ROTATION",
          document.createAccessor(`${group.name}/ROTATION`).setType("VEC4").setArray(rotations).setBuffer(buffer),
        )
        .setAttribute(
          "SCALE",
          document.createAccessor(`${group.name}/SCALE`).setType("VEC3").setArray(scales).setBuffer(buffer),
        );
      scene.addChild(
        document
          .createNode(group.name)
          .setMesh(mesh)
          .setExtension("EXT_mesh_gpu_instancing", batch)
          .setExtras({
            unreal: {
              meshName: group.meshName,
              parent: group.parent,
              sourceClass: group.sourceClass,
              instanceCount: group.transforms.length,
            },
          }),
      );
      resolvedInstances += group.transforms.length;
    }
  }

  const landscapes = request.source.landscapes ?? [];
  const landscapeMaterials = new Map<string, ReturnType<Document["createMaterial"]>>();
  for (const landscape of landscapes) {
    const side = landscape.sizeQuads + 1;
    const vertexCount = side * side;
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    for (let y = 0; y < side; y += 1) {
      for (let x = 0; x < side; x += 1) {
        const index = y * side + x;
        positions.set([y * 0.01, landscape.heights[index]! * 0.01, -x * 0.01], index * 3);
        const normalIndex = index * 3;
        normals.set([
          landscape.normals[normalIndex + 1]!,
          landscape.normals[normalIndex + 2]!,
          -landscape.normals[normalIndex]!,
        ], normalIndex);
        uvs.set([x / landscape.sizeQuads, y / landscape.sizeQuads], index * 2);
      }
    }
    const indexCount = landscape.sizeQuads * landscape.sizeQuads * 6;
    const indices = vertexCount <= 65_535 ? new Uint16Array(indexCount) : new Uint32Array(indexCount);
    let cursor = 0;
    for (let y = 0; y < landscape.sizeQuads; y += 1) {
      for (let x = 0; x < landscape.sizeQuads; x += 1) {
        const topLeft = y * side + x;
        indices.set([topLeft, topLeft + side + 1, topLeft + 1, topLeft, topLeft + side, topLeft + side + 1], cursor);
        cursor += 6;
      }
    }
    const buffer = document.getRoot().listBuffers()[0] ?? document.createBuffer("Landscape geometry");
    let material = landscapeMaterials.get(landscape.materialName);
    if (!material) {
      material = document.createMaterial(landscape.materialName)
        .setBaseColorFactor([0.35, 0.45, 0.25, 1])
        .setRoughnessFactor(1);
      landscapeMaterials.set(landscape.materialName, material);
    }
    const primitive = document.createPrimitive()
      .setAttribute("POSITION", document.createAccessor(`${landscape.name}/POSITION`).setType("VEC3").setArray(positions).setBuffer(buffer))
      .setAttribute("NORMAL", document.createAccessor(`${landscape.name}/NORMAL`).setType("VEC3").setArray(normals).setBuffer(buffer))
      .setAttribute("TEXCOORD_0", document.createAccessor(`${landscape.name}/TEXCOORD_0`).setType("VEC2").setArray(uvs).setBuffer(buffer))
      .setIndices(document.createAccessor(`${landscape.name}/INDICES`).setType("SCALAR").setArray(indices).setBuffer(buffer))
      .setMaterial(material);
    const mesh = document.createMesh(landscape.name).addPrimitive(primitive);
    scene.addChild(document.createNode(landscape.name)
      .setMesh(mesh)
      .setMatrix(unrealTransformToGltfMatrix(landscape.location, landscape.rotation, landscape.scale))
      .setExtras({ unreal: { sourceClass: "LandscapeComponent", materialName: landscape.materialName } }));
  }

  let approximatedAreaLights = 0;
  if (request.source.lights.length > 0) {
    const extension = document.createExtension(KHRLightsPunctual);
    for (const sourceLight of request.source.lights) {
      const type = sourceLight.type === "rect" ? "point" : sourceLight.type;
      if (sourceLight.type === "rect") approximatedAreaLights += 1;
      const color = sourceLight.useTemperature
        ? kelvinToLinearRgb(sourceLight.temperature)
        : [...sourceLight.color] as [number, number, number];
      const light = extension
        .createLight(sourceLight.name)
        .setType(type)
        .setColor(color)
        .setIntensity(Math.max(0, sourceLight.intensity))
        .setExtras({
          unreal: {
            sourceType: sourceLight.type,
            sourceWidth: sourceLight.sourceWidth,
            sourceHeight: sourceLight.sourceHeight,
            temperature: sourceLight.temperature,
          },
        });
      if (type !== "directional" && sourceLight.range > 0) light.setRange(sourceLight.range);
      if (type === "spot") {
        const outer = Math.min(Math.PI / 2, Math.max(0.001, sourceLight.outerConeAngle * Math.PI / 180));
        const inner = Math.min(outer - 0.0001, Math.max(0, sourceLight.innerConeAngle * Math.PI / 180));
        light.setInnerConeAngle(inner).setOuterConeAngle(outer);
      }
      scene.addChild(
        document
          .createNode(sourceLight.name)
          .setMatrix(
            unrealTransformToGltfMatrix(
              sourceLight.location,
              sourceLight.rotation,
              { x: 1, y: 1, z: 1 },
            ),
          )
          .setExtension("KHR_lights_punctual", light as Light),
      );
    }
  }

  // Marketplace models commonly embed the same 4K texture in many per-model GLBs. Collapse those
  // images before the GLB writer combines binary resources, or an otherwise valid scene can exceed
  // the uint32/typed-array boundary even though its unique resources fit comfortably below it.
  await document.transform(dedup(), unpartition());
  unshareAttributeAccessors(document);
  const outputStem = request.outputStem ?? request.source.mapName;
  if (!outputStem || isAbsolute(outputStem) || outputStem.split(/[\\/]/).includes("..")) {
    throw new Error(`invalid scene output stem ${JSON.stringify(outputStem)}`);
  }
  const glbRelative = `Scenes/${outputStem}.glb`;
  const manifestRelative = `Scenes/${outputStem}.scene.json`;
  const glbPath = join(request.outputRoot, glbRelative);
  await mkdir(dirname(glbPath), { recursive: true });
  await io.write(glbPath, document);
  const validated = await request.validate(glbPath, { allowEmptyScene: true });
  await writeFile(
    join(request.outputRoot, manifestRelative),
    `${JSON.stringify({
      format: "threenative-unreal-scene",
      version: 1,
      name: request.source.mapName,
      glb: `./${basename(glbRelative)}`,
      coordinateSystem: "right-handed-y-up-metres",
      actors: request.source.actors.map((actor) => ({
        ...actor,
        model: modelByName.get(actor.meshName)?.glb ?? null,
        matrix: unrealTransformToGltfMatrix(actor.location, actor.rotation, actor.scale),
      })),
      ...(sourceTexts.length > 0 ? { texts: sourceTexts } : {}),
      ...((omittedActors.length > 0) ? { omittedActors } : {}),
      instanceGroups: instanceGroups.map((group) => ({
        ...group,
        model: modelByName.get(group.meshName)?.glb ?? null,
        matrices: group.transforms.map((transform) =>
          unrealTransformToGltfMatrix(transform.location, transform.rotation, transform.scale)),
      })),
      landscapes,
      lights: request.source.lights,
      blueprintComponents: request.source.blueprintComponents,
      camera: request.source.camera,
      unresolvedMeshes: [...unresolved].sort(),
      generatedEnginePrimitives: [...generatedEnginePrimitives].sort(),
    }, null, 2)}\n`,
  );
  const bounds = getBounds(scene);
  const measured = {
    x: bounds.max[0] - bounds.min[0],
    y: bounds.max[1] - bounds.min[1],
    z: bounds.max[2] - bounds.min[2],
  };
  // A level that reconstructs no mesh at all bounds to -Infinity, which is not a size: report
  // nothing rather than a number the game's own validation would have to reject.
  const sizeMeters = [measured.x, measured.y, measured.z].every(Number.isFinite)
    ? measured
    : undefined;
  return {
    name: request.source.mapName,
    package: request.package,
    glb: glbRelative,
    manifest: manifestRelative,
    sizeMeters,
    bytes: validated.bytes,
    sha256: validated.sha256,
    actors: request.source.actors.length + sourceTexts.length,
    resolvedActors,
    instanceGroups: instanceGroups.length,
    instances: instanceGroups.reduce((sum, group) => sum + group.transforms.length, 0),
    resolvedInstances,
    landscapes: landscapes.length,
    landscapeVertices: landscapes.reduce((sum, landscape) => sum + landscape.heights.length, 0),
    unresolvedMeshes: [...unresolved].sort(),
    generatedEnginePrimitives: [...generatedEnginePrimitives].sort(),
    lights: request.source.lights.length,
    blueprintComponents: request.source.blueprintComponents,
    approximatedAreaLights,
    omittedActors,
  };
}
