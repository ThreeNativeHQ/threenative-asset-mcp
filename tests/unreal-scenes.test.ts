import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Document, NodeIO } from "@gltf-transform/core";
import { EXTMeshGPUInstancing, KHRLightsPunctual, KHRMaterialsUnlit, type InstancedMesh } from "@gltf-transform/extensions";
import { afterEach, describe, expect, it } from "vitest";

import {
  assembleSceneGlb,
  parseUnrealSceneSource,
  unrealTransformToGltfMatrix,
  type UnrealSceneSource,
} from "../src/unreal/scenes.js";
import { interleavedBufferViews, validateGlb } from "../src/unreal/importer.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function source(): UnrealSceneSource {
  return {
    format: "threenative-unreal-scene-source",
    version: 1,
    mapName: "DemoMap",
    sourceFile: "Content/Maps/DemoMap.umap",
    actors: [
      {
        name: "Desk_A",
        meshName: "SM_Desk",
        location: { x: 100, y: 200, z: 300 },
        rotation: { pitch: 0, yaw: 0, roll: 0 },
        scale: { x: 1, y: 1, z: 1 },
        parent: "",
      },
      {
        name: "Desk_B",
        meshName: "SM_Desk",
        location: { x: 0, y: 0, z: 0 },
        rotation: { pitch: 0, yaw: 90, roll: 0 },
        scale: { x: 2, y: 1, z: 1 },
        parent: "",
      },
      {
        name: "Missing",
        meshName: "SM_NotImported",
        location: { x: 0, y: 0, z: 0 },
        rotation: { pitch: 0, yaw: 0, roll: 0 },
        scale: { x: 1, y: 1, z: 1 },
        parent: "",
      },
      {
        name: "PreviewGround",
        meshName: "Plane",
        location: { x: 0, y: 0, z: 0 },
        rotation: { pitch: 0, yaw: 0, roll: 0 },
        scale: { x: 10, y: 10, z: 1 },
        parent: "",
      },
      {
        name: "Table_A",
        meshName: "SM_Table",
        location: { x: 0, y: 0, z: 0 },
        rotation: { pitch: 0, yaw: 0, roll: 0 },
        scale: { x: 1, y: 1, z: 1 },
        parent: "",
      },
    ],
    instanceGroups: [
      {
        name: "Foliage/HISM_Grass",
        meshName: "SM_Desk",
        parent: "InstancedFoliageActor_0",
        sourceClass: "FoliageInstancedStaticMeshComponent",
        transforms: [
          {
            location: { x: 100, y: 0, z: 0 },
            rotation: { pitch: 0, yaw: 0, roll: 0 },
            scale: { x: 1, y: 1, z: 1 },
          },
          {
            location: { x: 200, y: 300, z: 400 },
            rotation: { pitch: 0, yaw: 90, roll: 0 },
            scale: { x: 2, y: 2, z: 2 },
          },
        ],
      },
    ],
    landscapes: [
      {
        name: "Landscape_0/Component_0",
        materialName: "Terrain",
        location: { x: 100, y: 200, z: 300 },
        rotation: { pitch: 0, yaw: 0, roll: 0 },
        scale: { x: 100, y: 100, z: 100 },
        sizeQuads: 1,
        heights: [0, 1, 2, 3],
        normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
      },
    ],
    lights: [
      {
        name: "WarmSpot",
        type: "spot",
        location: { x: 0, y: 0, z: 200 },
        rotation: { pitch: -90, yaw: 0, roll: 0 },
        color: [1, 1, 1],
        intensity: 8000,
        range: 20,
        innerConeAngle: 50,
        outerConeAngle: 60,
        temperature: 3600,
        useTemperature: true,
        sourceWidth: 0,
        sourceHeight: 0,
      },
    ],
    blueprintComponents: 0,
    camera: {
      hasCamera: false,
      location: { x: 0, y: 0, z: 0 },
      rotation: { pitch: 0, yaw: 0, roll: 0 },
    },
  };
}

describe("Unreal level conversion", () => {
  it("accepts a meshless Unreal level as a scene while keeping model validation strict", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "tn-empty-scene-"));
    temporaryDirectories.push(outputRoot);
    const base = source();
    const imported = await assembleSceneGlb({
      source: { ...base, mapName: "EmptyMap", actors: [], instanceGroups: [], landscapes: [], lights: [] },
      package: "Content/EmptyMap.umap",
      outputRoot,
      models: [],
      validate: validateGlb,
    });
    const output = await new NodeIO().read(join(outputRoot, imported.glb));
    expect(imported).toMatchObject({ actors: 0, resolvedActors: 0, lights: 0 });
    expect(output.getRoot().listScenes()).toHaveLength(1);
    expect(output.getRoot().listMeshes()).toHaveLength(0);
    await expect(validateGlb(join(outputRoot, imported.glb))).rejects.toThrow(/contains no mesh/);
  });

  it("uses a package-relative output stem when same-named scenes need disambiguation", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "tn-scene-collision-"));
    temporaryDirectories.push(outputRoot);
    const base = source();
    const imported = await assembleSceneGlb({
      source: { ...base, mapName: "Shared", actors: [], instanceGroups: [], landscapes: [], lights: [] },
      package: "Content/Office/Shared.umap",
      outputRoot,
      outputStem: "Content/Office/Shared",
      models: [],
      validate: validateGlb,
    });
    expect(imported.glb).toBe("Scenes/Content/Office/Shared.glb");
    expect(imported.manifest).toBe("Scenes/Content/Office/Shared.scene.json");
    expect((await stat(join(outputRoot, imported.glb))).size).toBeGreaterThan(0);
  });

  it("reconstructs TextRender glyphs from a promoted offline UFont atlas", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "tn-scene-text-"));
    temporaryDirectories.push(outputRoot);
    const fontDir = join(outputRoot, "bitmap-fonts/Test");
    await mkdir(fontDir, { recursive: true });
    await writeFile(join(fontDir, "page-00.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
    await writeFile(join(fontDir, "font.json"), JSON.stringify({
      common: { lineHeight: 1, base: 1, scaleW: 1, scaleH: 1, pages: 1 }, pages: ["page-00.png"],
      chars: [{ id: 65, x: 0, y: 0, width: 1, height: 1, xoffset: 0, yoffset: 0, xadvance: 1, page: 0 }],
    }));
    const base = source();
    const imported = await assembleSceneGlb({
      source: { ...base, actors: [], instanceGroups: [], landscapes: [], lights: [], texts: [{
        name: "Label/Text", text: "AA", fontName: "Test", fontPath: "/Game/Test.Test", worldSize: 100,
        horizontalAlignment: "EHTA_Center", verticalAlignment: "EVRTA_TextCenter", color: [10, 20, 30, 255],
        location: { x: 0, y: 0, z: 0 }, rotation: { pitch: 0, yaw: 0, roll: 0 }, scale: { x: 1, y: 1, z: 1 }, parent: "Label",
      }] },
      package: "Content/Text.umap", outputRoot, models: [], bitmapFonts: [{ name: "Test", manifest: "bitmap-fonts/Test/font.json" }], validate: validateGlb,
    });
    const output = await new NodeIO().registerExtensions([KHRMaterialsUnlit]).read(join(outputRoot, imported.glb));
    const textMesh = output.getRoot().listMeshes().find((mesh) => mesh.getName() === "Label/Text");
    expect(imported).toMatchObject({ actors: 1, resolvedActors: 1, unresolvedMeshes: [] });
    expect(textMesh?.listPrimitives()[0]?.getAttribute("POSITION")?.getCount()).toBe(8);
    expect(textMesh?.listPrimitives()[0]?.getMaterial()?.getExtension("KHR_materials_unlit")).not.toBeNull();
  });

  it("preserves KHR_materials_unlit while copying Paper2D meshes into a scene", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "tn-scene-unlit-"));
    temporaryDirectories.push(outputRoot);
    await mkdir(join(outputRoot, "Models"), { recursive: true });
    const model = new Document();
    const buffer = model.createBuffer();
    const primitive = model.createPrimitive().setAttribute("POSITION", model.createAccessor().setType("VEC3")
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buffer));
    const material = model.createMaterial("sprite");
    material.setExtension("KHR_materials_unlit", model.createExtension(KHRMaterialsUnlit).createUnlit());
    primitive.setMaterial(material);
    model.createScene().addChild(model.createNode().setMesh(model.createMesh("Sprite").addPrimitive(primitive)));
    const io = new NodeIO().registerExtensions([KHRMaterialsUnlit]);
    await io.write(join(outputRoot, "Models", "Sprite.glb"), model);
    const sceneSource = source();
    const imported = await assembleSceneGlb({
      source: { ...sceneSource, actors: [{ ...sceneSource.actors[0]!, meshName: "Sprite" }], instanceGroups: [], landscapes: [], lights: [] },
      package: "Content/Map.umap", outputRoot, models: [{ name: "Sprite", glb: "Models/Sprite.glb" }], validate: validateGlb,
    });
    const output = await io.read(join(outputRoot, imported.glb));
    expect(output.getRoot().listMaterials()[0]?.getExtension("KHR_materials_unlit")).not.toBeNull();
  });

  it("preserves skeletal nodes, skin, and joints when instantiating a model in a scene", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "tn-scene-skeletal-"));
    temporaryDirectories.push(outputRoot);
    await mkdir(join(outputRoot, "Models"), { recursive: true });
    const model = new Document();
    const buffer = model.createBuffer();
    const primitive = model.createPrimitive()
      .setAttribute("POSITION", model.createAccessor().setType("VEC3").setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buffer))
      .setAttribute("JOINTS_0", model.createAccessor().setType("VEC4").setArray(new Uint16Array(12)).setBuffer(buffer))
      .setAttribute("WEIGHTS_0", model.createAccessor().setType("VEC4").setArray(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])).setBuffer(buffer));
    const joint = model.createNode("root");
    const skin = model.createSkin("Skin").addJoint(joint).setSkeleton(joint)
      .setInverseBindMatrices(model.createAccessor().setType("MAT4").setArray(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])).setBuffer(buffer));
    model.createScene().addChild(joint).addChild(model.createNode("Character").setMesh(model.createMesh("Character").addPrimitive(primitive)).setSkin(skin));
    await new NodeIO().write(join(outputRoot, "Models", "Character.glb"), model);
    const base = source();
    const imported = await assembleSceneGlb({
      source: { ...base, actors: [{ ...base.actors[0]!, meshName: "Character" }], instanceGroups: [], landscapes: [], lights: [] },
      package: "Content/Character.umap", outputRoot, models: [{ name: "Character", glb: "Models/Character.glb", kind: "skeletal" }], validate: validateGlb,
    });
    const output = await new NodeIO().read(join(outputRoot, imported.glb));
    expect(imported).toMatchObject({ actors: 1, resolvedActors: 1, unresolvedMeshes: [] });
    expect(output.getRoot().listSkins()).toHaveLength(1);
    expect(output.getRoot().listSkins()[0]?.listJoints().map((node) => node.getName())).toEqual(["root"]);
    expect(output.getRoot().listNodes().some((node) => node.getSkin() !== null)).toBe(true);
  });

  it("converts UE centimetres/Z-up into glTF metres/Y-up", () => {
    const matrix = unrealTransformToGltfMatrix(
      { x: 100, y: 200, z: 300 },
      { pitch: 0, yaw: 0, roll: 0 },
      { x: 1, y: 1, z: 1 },
    );
    expect([matrix[12], matrix[13], matrix[14]]).toEqual([2, 3, -1]);
    expect(matrix.slice(0, 12)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
  });

  it("validates external parser output and rejects non-finite fields", () => {
    const parsed = parseUnrealSceneSource(JSON.stringify({ ...source(), omittedActors: [{ actor: "Terrain", component: "Render", sourceClass: "PaperTerrainComponent", reason: "spline geometry unsupported" }] }));
    expect(parsed.actors).toHaveLength(5);
    expect(parsed.instanceGroups?.[0]?.transforms).toHaveLength(2);
    expect(parsed.landscapes?.[0]?.heights).toEqual([0, 1, 2, 3]);
    expect(parsed.omittedActors?.[0]?.sourceClass).toBe("PaperTerrainComponent");
    const invalid = structuredClone(source()) as unknown as { actors: { location: { x: number } }[] };
    invalid.actors[0]!.location.x = Number.NaN;
    expect(() => parseUnrealSceneSource(JSON.stringify(invalid))).toThrow();
  });

  it("writes a directly loadable GLB and instances one mesh across repeated actors", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "tn-scene-"));
    temporaryDirectories.push(outputRoot);
    await mkdir(join(outputRoot, "Models"), { recursive: true });

    const model = new Document();
    const buffer = model.createBuffer();
    const position = model
      .createAccessor("POSITION")
      .setType("VEC3")
      .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]))
      .setBuffer(buffer);
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const texture = model.createTexture("SharedTexture").setImage(png).setMimeType("image/png");
    const material = model.createMaterial("SharedMaterial").setBaseColorTexture(texture);
    const primitive = model.createPrimitive().setAttribute("POSITION", position).setMaterial(material);
    const mesh = model.createMesh("SM_Desk").addPrimitive(primitive);
    model.createScene().addChild(model.createNode("SM_Desk").setMesh(mesh));
    await new NodeIO().write(join(outputRoot, "Models", "SM_Desk.glb"), model);

    const secondModel = new Document();
    const secondBuffer = secondModel.createBuffer();
    const secondPosition = secondModel
      .createAccessor("POSITION")
      .setType("VEC3")
      .setArray(new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]))
      .setBuffer(secondBuffer);
    const secondTexture = secondModel
      .createTexture("SharedTexture")
      .setImage(png)
      .setMimeType("image/png");
    const secondMaterial = secondModel
      .createMaterial("SharedMaterial")
      .setBaseColorTexture(secondTexture);
    const secondMesh = secondModel
      .createMesh("SM_Table")
      .addPrimitive(
        secondModel
          .createPrimitive()
          .setAttribute("POSITION", secondPosition)
          .setMaterial(secondMaterial),
      );
    secondModel.createScene().addChild(secondModel.createNode("SM_Table").setMesh(secondMesh));
    await new NodeIO().write(join(outputRoot, "Models", "SM_Table.glb"), secondModel);

    const imported = await assembleSceneGlb({
      source: source(),
      package: "Content/Maps/DemoMap.umap",
      outputRoot,
      models: [
        { name: "SM_Desk", glb: "Models/SM_Desk.glb" },
        { name: "SM_Table", glb: "Models/SM_Table.glb" },
      ],
      validate: async (path) => {
        const bytes = await readFile(path);
        return {
          bytes: (await stat(path)).size,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      },
    });

    expect(imported).toMatchObject({
      actors: 5,
      resolvedActors: 4,
      instanceGroups: 1,
      instances: 2,
      resolvedInstances: 2,
      landscapes: 1,
      landscapeVertices: 4,
    });
    expect(imported.unresolvedMeshes).toEqual(["SM_NotImported"]);
    expect(imported.generatedEnginePrimitives).toEqual(["Plane"]);
    const scene = await new NodeIO()
      .registerExtensions([KHRLightsPunctual, EXTMeshGPUInstancing])
      .read(join(outputRoot, imported.glb));
    await expect(validateGlb(join(outputRoot, imported.glb))).resolves.toMatchObject({ bytes: imported.bytes });
    expect(scene.getRoot().listMeshes()).toHaveLength(4);
    expect(scene.getRoot().listTextures()).toHaveLength(1);
    expect(scene.getRoot().listNodes()).toHaveLength(7);
    expect(scene.getRoot().listNodes()[0]?.getTranslation()).toEqual([2, 3, -1]);
    expect(imported.lights).toBe(1);
    expect(scene.getRoot().listExtensionsUsed().map((extension) => extension.extensionName)).toContain(
      "KHR_lights_punctual",
    );
    expect(scene.getRoot().listExtensionsRequired().map((extension) => extension.extensionName)).toContain(
      "EXT_mesh_gpu_instancing",
    );
    const instanceNode = scene.getRoot().listNodes().find((node) => node.getName() === "Foliage/HISM_Grass");
    const batch = instanceNode?.getExtension<InstancedMesh>("EXT_mesh_gpu_instancing");
    expect(batch?.getAttribute("TRANSLATION")?.getCount()).toBe(2);
    expect([...batch!.getAttribute("TRANSLATION")!.getArray()!]).toEqual([0, 0, -1, 3, 4, -2]);
    const terrainNode = scene.getRoot().listNodes().find((node) => node.getName() === "Landscape_0/Component_0");
    const terrainPosition = terrainNode?.getMesh()?.listPrimitives()[0]?.getAttribute("POSITION")?.getArray();
    expect([...terrainPosition!].map((value) => Math.abs(value) < 1e-6 ? 0 : Number(value.toFixed(4))))
      .toEqual([0, 0, 0, 0, 0.01, -0.01, 0.01, 0.02, 0, 0.01, 0.03, -0.01]);
    const manifest = JSON.parse(await readFile(join(outputRoot, imported.manifest), "utf8"));
    expect(manifest.coordinateSystem).toBe("right-handed-y-up-metres");
    expect(manifest.actors[0].model).toBe("Models/SM_Desk.glb");
    expect(manifest.instanceGroups[0].matrices).toHaveLength(2);
    expect(manifest.generatedEnginePrimitives).toEqual(["Plane"]);
  });
});

describe("authored UV sets in a reconstructed scene", () => {
  it("keeps every UV set on scene primitives without an interleaved buffer view", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "tn-scene-uv-"));
    temporaryDirectories.push(outputRoot);
    await mkdir(join(outputRoot, "Models"), { recursive: true });
    // Lightmap sets equal to UV0 are valid source data. Deduplication merged those accessors, so one buffer view carried
    // several semantics and the native host rejected the scene.
    const uv0 = [0, 0, 1, 0, 0, 1];
    const sets = {
      TEXCOORD_0: uv0,
      TEXCOORD_1: uv0,
      TEXCOORD_2: [0.5, 0.5, 0.25, 0.75, 0.75, 0.25],
      TEXCOORD_3: uv0,
      TEXCOORD_7: [0.9375, 0.0625, 0.5, 0.875, 0.1875, 0.4375],
    };
    const model = new Document();
    const buffer = model.createBuffer();
    const accessor = (semantic: string, type: "VEC2" | "VEC3", values: number[]) =>
      model.createAccessor(semantic).setType(type).setArray(new Float32Array(values)).setBuffer(buffer);
    const primitive = model.createPrimitive()
      .setAttribute("POSITION", accessor("POSITION", "VEC3", [0, 0, 0, 1, 0, 0, 0, 2, 0]))
      .setAttribute("NORMAL", accessor("NORMAL", "VEC3", [0, 0, 1, 0, 0, 1, 0, 0, 1]));
    for (const [semantic, values] of Object.entries(sets)) primitive.setAttribute(semantic, accessor(semantic, "VEC2", values));
    model.createScene().addChild(model.createNode("SM_Desk").setMesh(model.createMesh("SM_Desk").addPrimitive(primitive)));
    await new NodeIO().write(join(outputRoot, "Models", "SM_Desk.glb"), model);

    const base = source();
    const imported = await assembleSceneGlb({
      source: { ...base, actors: [{ ...base.actors[0]!, meshName: "SM_Desk" }], instanceGroups: [], landscapes: [], lights: [] },
      package: "Content/Maps/DemoMap.umap",
      outputRoot,
      models: [{ name: "SM_Desk", glb: "Models/SM_Desk.glb" }],
      validate: validateGlb,
    });

    const bytes = await readFile(join(outputRoot, imported.glb));
    const scene = await new NodeIO().read(join(outputRoot, imported.glb));
    const scenePrimitive = scene.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
    expect(scenePrimitive.listSemantics().sort()).toEqual(["NORMAL", "POSITION", ...Object.keys(sets)].sort());
    for (const [semantic, values] of Object.entries(sets)) {
      expect(Array.from(scenePrimitive.getAttribute(semantic)!.getArray()!), semantic).toEqual(values);
    }
    expect(interleavedBufferViews(bytes)).toBe(0);
  });
});
