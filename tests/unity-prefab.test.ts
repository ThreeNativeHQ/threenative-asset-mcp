import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { getBounds } from "@gltf-transform/functions";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { UNITY_IMPORTER_VERSION, importUnityPackage } from "../src/unity/importer.js";
import { derivedMeshFileId, md4 } from "../src/unity/model-ids.js";
import { fbxMeshFrame, placeMeshFrame } from "../src/unity/prefab-glb.js";
import { toGltfTransform } from "../src/unity/prefab.js";
import { type FixtureFile, scratchDirectory, writeProjectFolder } from "./helpers/unity-fixtures.js";
import { SHADERS, materialYaml } from "./helpers/unity-models.js";
import {
  asset,
  component,
  gameObject,
  local,
  lodGroup,
  meshFilter,
  meshRenderer,
  mirrorZ,
  multiply,
  prefabFile,
  prefabInstance,
  stripped,
  transform,
  unityMatrix,
  writePartsFbx,
} from "./helpers/unity-prefabs.js";
import { describeWithTools } from "./helpers/require-tool.js";

const read = (path: string): Promise<Document> => new NodeIO().registerExtensions(ALL_EXTENSIONS).read(path);
const folders = (...paths: string[]): FixtureFile[] => paths.map((path) => ({ path }));

async function importProject(files: FixtureFile[], options: { assets?: string[] } = {}) {
  const root = await scratchDirectory("unity-prefab-project-");
  await writeProjectFolder(root, files);
  const outputDir = join(await scratchDirectory("unity-prefab-out-"), "import");
  const report = await importUnityPackage({ source: root, outputDir, ...options });
  return { report, outputDir };
}

function nodeNamed(document: Document, name: string) {
  const found = document.getRoot().listNodes().filter((node) => node.getName() === name);
  expect(found, `node ${name}`).toHaveLength(1);
  return found[0]!;
}

/** The node that holds a named GameObject's mesh: the node itself, or its `:mesh` child that carries Unity's mesh frame. */
function meshNode(document: Document, name: string) {
  const node = nodeNamed(document, name);
  return node.getMesh() ? node : (node.listChildren().find((child) => child.getMesh()) ?? node);
}

const near = (actual: readonly number[], expected: readonly number[], digits = 5): void => {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((value, index) => expect(actual[index]).toBeCloseTo(value, digits));
};

const prefabOf = (report: Awaited<ReturnType<typeof importProject>>["report"], source: string) => {
  const prefab = report.prefabs.find((item) => item.source === source);
  expect(prefab, `prefab ${source} in the report`).toBeDefined();
  return prefab!;
};

describe("hierarchy", () => {
  it("hierarchy: converts one local transform from Unity's left-handed space", () => {
    expect(toGltfTransform([1, 2, 3], [0.1, 0.2, 0.3, 0.9], [2, 3, 4])).toEqual({
      translation: [1, 2, -3],
      rotation: [-0.1, -0.2, 0.3, 0.9],
      scale: [2, 3, 4],
    });
  });

  it("hierarchy: a three-level prefab gets the right world matrices after the handedness conversion", async () => {
    const half = Math.SQRT1_2;
    const levels = [
      { name: "Root", position: [1, 2, 3], rotation: [0, half, 0, half], scale: [2, 2, 2] },
      { name: "Middle", position: [0, 0, 5], rotation: [half, 0, 0, half], scale: [1, 1.5, 1] },
      { name: "Leaf", position: [1, -1, 0.5], rotation: [0.1, 0.2, 0.3, Math.sqrt(1 - 0.14)], scale: [1, 1, 1] },
    ] as const;
    const { report, outputDir } = await importProject([
      ...folders("Assets", "Assets/Prefabs"),
      {
        path: "Assets/Prefabs/tower.prefab",
        content: prefabFile(
          gameObject(10, "Root", { components: [11] }),
          transform(11, 10, { position: levels[0].position, rotation: levels[0].rotation, scale: levels[0].scale }),
          gameObject(20, "Middle", { components: [21] }),
          transform(21, 20, { father: 11, position: levels[1].position, rotation: levels[1].rotation, scale: levels[1].scale }),
          gameObject(30, "Leaf", { components: [31] }),
          transform(31, 30, { father: 21, position: levels[2].position, rotation: levels[2].rotation, scale: levels[2].scale }),
        ),
      },
    ]);
    expect(report).toMatchObject({ importerVersion: UNITY_IMPORTER_VERSION, counts: { prefabs: 1, failed: 0, models: 0 }, blender: { version: "not used" } });
    const prefab = prefabOf(report, "Assets/Prefabs/tower.prefab");
    expect(prefab).toMatchObject({ nodes: 3, glb: "prefabs/tower.glb", meshNodes: 0 });

    const document = await read(join(outputDir, prefab.glb));
    let world = unityMatrix([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
    for (const level of levels) {
      world = multiply(world, unityMatrix(level.position, level.rotation, level.scale));
      near(nodeNamed(document, level.name).getWorldMatrix(), mirrorZ(world), 4);
    }
    // Applied once: a child holds its own converted local transform, not a second conversion of its parent's.
    near(nodeNamed(document, "Middle").getTranslation(), [0, 0, -5]);
    near(nodeNamed(document, "Middle").getRotation(), [-half, 0, 0, half]);
    expect(document.getRoot().getDefaultScene()?.listChildren().map((node) => node.getName())).toEqual(["Root"]);
  }, 60_000);

  it("hierarchy: skips inactive GameObjects with their children and names them in the report", async () => {
    const { report, outputDir } = await importProject([
      ...folders("Assets"),
      {
        path: "Assets/p.prefab",
        content: prefabFile(
          gameObject(10, "Root", { components: [11] }),
          transform(11, 10),
          gameObject(20, "Off", { components: [21], active: false }),
          transform(21, 20, { father: 11 }),
          gameObject(30, "UnderOff", { components: [31] }),
          transform(31, 30, { father: 21 }),
        ),
      },
    ]);
    const prefab = prefabOf(report, "Assets/p.prefab");
    expect(prefab.inactive).toEqual(["Root/Off"]);
    expect((await read(join(outputDir, prefab.glb))).getRoot().listNodes().map((node) => node.getName())).toEqual(["Root"]);
  }, 60_000);

  it("hierarchy: a Unity 5 / 2017 prefab keeps a `Prefab` container document that is the prefab itself, not an instance of another one (real U3 pack)", async () => {
    const container = "--- !u!1001 &100100000\nPrefab:\n  m_Modification:\n    m_TransformParent: {fileID: 0}\n    m_Modifications: []\n    m_RemovedComponents: []\n  m_ParentPrefab: {fileID: 0}\n  m_RootGameObject: {fileID: 10}\n  m_IsPrefabParent: 1\n";
    const { report } = await importProject([
      ...folders("Assets"),
      { path: "Assets/old.prefab", content: prefabFile(container, gameObject(10, "Root", { components: [11] }), transform(11, 10)) },
    ]);
    const prefab = prefabOf(report, "Assets/old.prefab");
    expect(prefab.unresolved).toEqual([]);
    expect(prefab.nodes).toBe(1);
  }, 60_000);
});

describe("pivot offset of a file node", () => {
  // The real U3 shape: a Maya node at T = (12.72, 0.5, 2.13) m with the file's turn about X and scale 0.01, vertices (raw cm) about -T.
  const world = [0.01, 0, 0, 0, 0, 0, 0.01, 0, 0, -0.01, 0, 0, 12.72, 0.5, 2.13, 1];
  const frame = fbxMeshFrame(0.01);

  it("pivot: T is kept on all three axes (a sign error on Y or Z leaves the mesh metres off) when it cancels the vertices' offset", () => {
    const centre = [-1272, -213, 50] as const;
    const placed = placeMeshFrame(frame, world, centre);
    const at = [0, 1, 2].map((row) => placed[row]! * centre[0] + placed[4 + row]! * centre[1] + placed[8 + row]! * centre[2] + placed[12 + row]!);
    near(at, [0, 0, 0], 6);
  });

  it("pivot: an ordinary node (vertices about the origin, T placing the object) keeps no T, so the prefab's GameObject places it once", () => {
    expect(placeMeshFrame(frame, world, [0, 0, 0]).slice(12, 15)).toEqual([0, 0, 0]);
    expect(placeMeshFrame(frame, world, [12, -3, 2]).slice(12, 15)).toEqual([0, 0, 0]);
  });
});

describe("cycle", () => {
  it("cycle: a variant chain that returns to its start fails with the chain named, and does not hang", async () => {
    const variantOf = (id: number, source: string) => prefabFile(prefabInstance(id, { source }));
    const { report } = await importProject([
      ...folders("Assets"),
      { path: "Assets/A.prefab", content: variantOf(100, "Assets/B.prefab") },
      { path: "Assets/B.prefab", content: variantOf(200, "Assets/C.prefab") },
      { path: "Assets/C.prefab", content: variantOf(300, "Assets/A.prefab") },
      { path: "Assets/Self.prefab", content: variantOf(400, "Assets/Self.prefab") },
      { path: "Assets/Fine.prefab", content: prefabFile(gameObject(1, "Fine", { components: [2] }), transform(2, 1)) },
    ]);
    const reasons = new Map(report.failed.map((item) => [item.asset, item.reason]));
    expect(reasons.get("Assets/A.prefab")).toBe("Prefab cycle: Assets/A.prefab -> Assets/B.prefab -> Assets/C.prefab -> Assets/A.prefab");
    expect(reasons.get("Assets/B.prefab")).toBe("Prefab cycle: Assets/B.prefab -> Assets/C.prefab -> Assets/A.prefab -> Assets/B.prefab");
    expect(reasons.get("Assets/Self.prefab")).toBe("Prefab cycle: Assets/Self.prefab -> Assets/Self.prefab");
    expect(report.failed).toHaveLength(4);
    expect(report.prefabs.map((item) => item.source)).toEqual(["Assets/Fine.prefab"]);
    expect(report.counts).toMatchObject({ prefabs: 1, failed: 4 });
  }, 60_000);

  it("cycle: a nesting deeper than the limit is refused", async () => {
    const files: FixtureFile[] = folders("Assets");
    for (let level = 0; level < 40; level += 1) {
      files.push({
        path: `Assets/L${level}.prefab`,
        content: level === 39 ? prefabFile(gameObject(1, "End", { components: [2] }), transform(2, 1)) : prefabFile(prefabInstance(10, { source: `Assets/L${level + 1}.prefab` })),
      });
    }
    const { report } = await importProject(files, { assets: ["L0"] });
    expect(report.failed).toEqual([{ asset: "Assets/L0.prefab", reason: expect.stringMatching(/Prefab nesting is deeper than 32/) }]);
  }, 60_000);
});

describe("budgets", () => {
  it("budgets: an acyclic chain whose every level nests the next twice fails fast instead of resolving 2^22 scopes (the objects cap never sees an empty leaf)", async () => {
    const files: FixtureFile[] = folders("Assets");
    const levels = 22;
    for (let level = 0; level < levels; level += 1) {
      files.push({
        path: `Assets/D${level}.prefab`,
        content:
          level === levels - 1
            ? prefabFile()
            : prefabFile(prefabInstance(10, { source: `Assets/D${level + 1}.prefab` }), prefabInstance(11, { source: `Assets/D${level + 1}.prefab` })),
      });
    }
    const started = Date.now();
    const { report } = await importProject(files, { assets: ["D0"] });
    expect(report.failed).toEqual([{ asset: "Assets/D0.prefab", reason: expect.stringMatching(/more than 50000 nested prefab instances/) }]);
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 60_000);

  it("budgets: a modification of a huge array index is reported unresolved and creates no array", async () => {
    const { report } = await importProject([
      ...folders("Assets"),
      { path: "Assets/Base.prefab", content: prefabFile(gameObject(1, "Root", { components: [2, 3] }), transform(2, 1), meshRenderer(3, 1, [])) },
      {
        path: "Assets/Variant.prefab",
        content: prefabFile(prefabInstance(10, { source: "Assets/Base.prefab", modifications: [{ target: 3, path: "m_Materials.Array.data[4294967294]", reference: asset("Assets/m.mat", 2100000) }] })),
      },
    ]);
    const prefab = prefabOf(report, "Assets/Variant.prefab");
    expect(prefab.unresolved).toEqual([expect.objectContaining({ kind: "modification", reason: expect.stringMatching(/array index is larger than 4096/) })]);
  }, 60_000);
});

describe("nested", () => {
  const car = (): FixtureFile => ({
    path: "Assets/Prefabs/Car.prefab",
    content: prefabFile(
      gameObject(10, "Car", { components: [11] }),
      transform(11, 10, { position: [1, 0, 0] }),
      gameObject(20, "Body", { components: [21] }),
      transform(21, 20, { father: 11, position: [0, 1, 0] }),
      gameObject(30, "Wheel", { components: [31] }),
      transform(31, 30, { father: 11, position: [2, 0, 0] }),
      gameObject(40, "Antenna", { components: [41, 42] }),
      transform(41, 40, { father: 11, position: [0, 3, 0] }),
      component(65, "BoxCollider", 42, 40),
    ),
  });
  const names = (document: Document): string[] => document.getRoot().listNodes().map((node) => node.getName()).sort();

  it("nested: applies a transform edit, a rename, a removed child and an added child, through a stripped Transform", async () => {
    const { report, outputDir } = await importProject([
      ...folders("Assets", "Assets/Prefabs"),
      car(),
      {
        path: "Assets/Prefabs/Garage.prefab",
        content: prefabFile(
          gameObject(1, "Garage", { components: [2] }),
          transform(2, 1, { position: [10, 0, 0] }),
          prefabInstance(1000, {
            source: "Assets/Prefabs/Car.prefab",
            parent: 2,
            modifications: [
              { target: 11, path: "m_LocalPosition.x", value: 3 },
              { target: 11, path: "m_LocalPosition.z", value: 4 },
              { target: 10, path: "m_Name", value: "CarRenamed" },
              { target: 11, path: "m_LocalEulerAnglesHint.x", value: 0 },
            ],
            removedGameObjects: [40],
            removedComponents: [42],
            added: [{ under: 21, added: 6 }],
          }),
          stripped(4, "Transform", 1021, 1000, "Assets/Prefabs/Car.prefab", 21),
          gameObject(5, "Flag", { components: [6] }),
          transform(6, 5, { father: 1021, position: [0, 0.5, 0] }),
        ),
      },
    ]);
    const garage = prefabOf(report, "Assets/Prefabs/Garage.prefab");
    expect(garage.unresolved).toEqual([]);
    const document = await read(join(outputDir, garage.glb));
    expect(names(document)).toEqual(["Body", "CarRenamed", "Flag", "Garage", "Wheel"]);
    near(nodeNamed(document, "CarRenamed").getTranslation(), [3, 0, -4]); // x edited, z edited and mirrored, y kept
    near(nodeNamed(document, "Garage").getTranslation(), [10, 0, 0]);
    expect(nodeNamed(document, "Flag").getParentNode()?.getName()).toBe("Body");
    expect(nodeNamed(document, "Body").getParentNode()?.getName()).toBe("CarRenamed");
    expect(nodeNamed(document, "CarRenamed").getParentNode()?.getName()).toBe("Garage");
    near(nodeNamed(document, "Wheel").getWorldMatrix().slice(12, 15), [15, 0, -4]);

    // The source prefab on its own still has the Antenna, and its collider is listed rather than imported.
    const source = prefabOf(report, "Assets/Prefabs/Car.prefab");
    expect(names(await read(join(outputDir, source.glb)))).toEqual(["Antenna", "Body", "Car", "Wheel"]);
    expect(source.colliders).toEqual([{ node: "Car/Antenna", component: "BoxCollider" }]);
    expect(garage.colliders).toEqual([]);
  }, 60_000);

  it("nested: a variant of a nested prefab keeps the inner edits and applies its own, with ids that combine instance and source", async () => {
    const combined = (BigInt(11) ^ BigInt(1000)).toString();
    const { report, outputDir } = await importProject([
      ...folders("Assets", "Assets/Prefabs"),
      car(),
      {
        path: "Assets/Prefabs/Garage.prefab",
        content: prefabFile(
          gameObject(1, "Garage", { components: [2] }),
          transform(2, 1, { position: [10, 0, 0] }),
          prefabInstance(1000, { source: "Assets/Prefabs/Car.prefab", parent: 2, modifications: [{ target: 10, path: "m_Name", value: "CarRenamed" }] }),
        ),
      },
      {
        path: "Assets/Prefabs/GarageVariant.prefab",
        content: prefabFile(
          prefabInstance(2000, {
            source: "Assets/Prefabs/Garage.prefab",
            modifications: [
              { target: 1, path: "m_Name", value: "VariantRoot" },
              { target: combined, path: "m_LocalPosition.y", value: 7 },
              { target: 999999, path: "m_LocalPosition.y", value: 1 },
            ],
          }),
        ),
      },
    ]);
    const variant = prefabOf(report, "Assets/Prefabs/GarageVariant.prefab");
    const document = await read(join(outputDir, variant.glb));
    expect(document.getRoot().getDefaultScene()?.listChildren().map((node) => node.getName())).toEqual(["VariantRoot"]);
    near(nodeNamed(document, "CarRenamed").getTranslation(), [1, 7, 0]);
    expect(nodeNamed(document, "CarRenamed").getParentNode()?.getName()).toBe("VariantRoot");
    expect(variant.unresolved).toEqual([
      expect.objectContaining({ kind: "modification", reason: expect.stringMatching(/no such object in Assets\/Prefabs\/Garage.prefab/) }),
    ]);
  }, 60_000);

  it("nested: a missing or non-prefab source is reported and the rest of the prefab still imports", async () => {
    const { report } = await importProject([
      ...folders("Assets"),
      { path: "Assets/x.png", content: "x" },
      {
        path: "Assets/p.prefab",
        content: prefabFile(
          gameObject(1, "Root", { components: [2] }),
          transform(2, 1),
          `--- !u!1001 &50\nPrefabInstance:\n  m_Modification:\n    m_TransformParent: ${local(2)}\n    m_Modifications: []\n  m_SourcePrefab: {fileID: 100100000, guid: ${"d".repeat(32)}, type: 3}\n`,
          prefabInstance(51, { source: "Assets/x.png", parent: 2 }),
        ),
      },
    ]);
    const prefab = prefabOf(report, "Assets/p.prefab");
    expect(prefab.nodes).toBe(1);
    expect(prefab.unresolved.map((item) => [item.kind, item.reason])).toEqual([
      ["prefab", expect.stringMatching(/guid d{32} is not in the package/)],
      ["prefab", expect.stringMatching(/Assets\/x.png is a texture/)],
    ]);
  }, 60_000);
});

describe("report", () => {
  it("report: colliders, scripts and unreadable references are listed and nothing else is imported from them", async () => {
    const { report, outputDir } = await importProject([
      ...folders("Assets"),
      {
        path: "Assets/p.prefab",
        content: prefabFile(
          gameObject(10, "Root", { components: [11, 12, 13, 14, 15] }),
          transform(11, 10),
          component(65, "BoxCollider", 12, 10),
          component(64, "MeshCollider", 13, 10),
          component(114, "MonoBehaviour", 14, 10, "  m_Script: {fileID: 11500000, guid: " + "a".repeat(32) + ", type: 3}\n"),
          component(108, "Light", 15, 10),
          gameObject(20, "Ghost", { components: [21, 22, 23] }),
          transform(21, 20, { father: 11 }),
          meshFilter(22, 20, asset("Assets/missing.fbx", 4300000)),
          meshRenderer(23, 20, [asset("Assets/missing.mat", 2100000, 2), "{fileID: 10303, guid: 0000000000000000f000000000000000, type: 0}", "{fileID: 0}"]),
          gameObject(30, "Cube", { components: [31, 32, 33] }),
          transform(31, 30, { father: 11 }),
          meshFilter(32, 30, "{fileID: 10202, guid: 0000000000000000e000000000000000, type: 0}"),
          meshRenderer(33, 30, []),
        ),
      },
    ]);
    const prefab = prefabOf(report, "Assets/p.prefab");
    expect(prefab.colliders).toEqual([
      { node: "Root", component: "BoxCollider" },
      { node: "Root", component: "MeshCollider" },
    ]);
    expect(prefab.components).toEqual([
      { node: "Root", component: "MonoBehaviour" },
      { node: "Root", component: "Light" },
    ]);
    expect(prefab).toMatchObject({ nodes: 3, meshNodes: 0 });
    // Ghost has a mesh ref to a guid that is not in the package, so its materials are not read at all.
    expect(prefab.unresolved).toEqual([
      expect.objectContaining({ kind: "mesh", node: "Root/Ghost", reason: expect.stringMatching(/not in the package/) }),
      expect.objectContaining({ kind: "mesh", node: "Root/Cube", reason: expect.stringMatching(/built-in Unity mesh/) }),
    ]);
    expect((await read(join(outputDir, prefab.glb))).getRoot().listNodes().map((node) => node.getName())).toEqual(["Root", "Ghost", "Cube"]);
  }, 60_000);
});

describe("meshes", () => {
  it("meshes: MD4 matches the RFC 1320 vectors and the derived id is stable", () => {
    const hex = (text: string) => Buffer.from(md4(new TextEncoder().encode(text))).toString("hex");
    expect(hex("")).toBe("31d6cfe0d16ae931b73c59d7e0c089c0");
    expect(hex("abc")).toBe("a448017aaf21d8525fc10ae87aa6729d");
    expect(hex("message digest")).toBe("d9130a8164549fe818874806e1c7014b");
    expect(hex("12345678901234567890123456789012345678901234567890123456789012345678901234567890")).toBe("e33b4ddc9c38f2199c3e7b164fcc0536");
    expect(derivedMeshFileId("Wheel")).toBe(derivedMeshFileId("Wheel"));
    expect(derivedMeshFileId("Wheel")).not.toBe(derivedMeshFileId("Body"));
    expect(derivedMeshFileId("Wheel")).toMatch(/^-?\d+$/);
  });
});

let fbxDirectory = "";
let parts: Buffer;
let single: Buffer;

// These prefabs have identity transforms, so the FBX unit conversion is off to keep their sizes in metres (the real-pack shape is its own test).
const importerWith = (table: string): string => `ModelImporter:\n  serializedVersion: 22200\n${table}  materials:\n    materialImportMode: 2\n    materialSearch: 1\n  meshes:\n    globalScale: 1\n    useFileScale: 0`;
const nameTable = (entries: Record<string, string>): string =>
  `  internalIDToNameTable:\n${Object.entries(entries).map(([id, name]) => `  - first:\n      43: ${id}\n    second: ${name}\n`).join("")}`;
const recycleTable = (entries: Record<string, string>): string =>
  `  fileIDToRecycleName:\n${Object.entries(entries).map(([id, name]) => `    ${id}: ${name}\n`).join("")}`;

const std = (name: string, rgb: readonly [number, number, number], textures: Record<string, string> = {}) =>
  materialYaml({ name, shader: SHADERS.standard, colors: { _Color: [...rgb, 1] }, textures });

describeWithTools(["blender"], "unity prefab meshes through Blender", () => {
  beforeAll(async () => {
    fbxDirectory = await mkdtemp(join(tmpdir(), "unity-prefab-fbx-"));
    await writePartsFbx(join(fbxDirectory, "parts.fbx"), [
      { name: "Body", size: [1, 0.5, 0.25], materials: ["Paint", "Glass"] },
      { name: "Wheel", size: [0.2, 0.2, 0.1], materials: ["Rubber"] },
    ]);
    await writePartsFbx(join(fbxDirectory, "single.fbx"), [{ name: "Lone", size: [1, 1, 1], materials: ["Paint"] }]);
    parts = await readFile(join(fbxDirectory, "parts.fbx"));
    single = await readFile(join(fbxDirectory, "single.fbx"));
  }, 120_000);
  afterAll(async () => {
    if (fbxDirectory) await rm(fbxDirectory, { recursive: true, force: true });
  });

  const baseColor = (document: Document, node: string): number[][] =>
    meshNode(document, node).getMesh()!.listPrimitives().map((primitive) => primitive.getMaterial()!.getBaseColorFactor().slice(0, 3));
  const materialNames = (document: Document, node: string): string[] =>
    meshNode(document, node).getMesh()!.listPrimitives().map((primitive) => primitive.getMaterial()!.getName());
  const size = (document: Document, node: string): number[] => {
    const { min, max } = getBounds(nodeNamed(document, node));
    return max.map((value, index) => value - min[index]!);
  };

  it("meshes: MeshFilter refs resolve through the name table, the recycle table and the derived id, and a two-slot renderer assigns its own materials", async () => {
    const bodyOverrides = [asset("Assets/Mats/red.mat", 2100000, 2), asset("Assets/Mats/green.mat", 2100000, 2)];
    const { report, outputDir } = await importProject([
      ...folders("Assets", "Assets/A", "Assets/B", "Assets/C", "Assets/D", "Assets/Mats", "Assets/Prefabs"),
      { path: "Assets/A/parts.fbx", data: parts, importer: importerWith(nameTable({ 4300000: "Body", 4300002: "Wheel" })) },
      { path: "Assets/B/parts.fbx", data: parts, importer: importerWith(recycleTable({ 100000: "Body", 4300000: "Body", 4300002: "Wheel" })) },
      { path: "Assets/C/parts.fbx", data: parts, importer: importerWith("  internalIDToNameTable: []\n") },
      { path: "Assets/D/single.fbx", data: single, importer: importerWith("  internalIDToNameTable: []\n") },
      { path: "Assets/Mats/red.mat", content: std("red", [1, 0, 0]) },
      { path: "Assets/Mats/green.mat", content: std("green", [0, 1, 0]) },
      {
        path: "Assets/Prefabs/parts.prefab",
        content: prefabFile(
          gameObject(10, "Root", { components: [11] }),
          transform(11, 10),
          gameObject(20, "ByName", { components: [21, 22, 23] }),
          transform(21, 20, { father: 11 }),
          meshFilter(22, 20, asset("Assets/A/parts.fbx", 4300000)),
          meshRenderer(23, 20, bodyOverrides),
          gameObject(30, "ByRecycle", { components: [31, 32, 33] }),
          transform(31, 30, { father: 11 }),
          meshFilter(32, 30, asset("Assets/B/parts.fbx", 4300000)),
          meshRenderer(33, 30, ["{fileID: 0}", "{fileID: 0}"]),
          gameObject(40, "ByDerivedId", { components: [41, 42, 43] }),
          transform(41, 40, { father: 11 }),
          meshFilter(42, 40, asset("Assets/C/parts.fbx", derivedMeshFileId("Wheel"))),
          meshRenderer(43, 40, [asset("Assets/Mats/green.mat", 2100000, 2)]),
          gameObject(50, "OnlyMesh", { components: [51, 52, 53] }),
          transform(51, 50, { father: 11 }),
          meshFilter(52, 50, asset("Assets/D/single.fbx", 4300000)),
          meshRenderer(53, 50, []),
          gameObject(60, "Unlisted", { components: [61, 62, 63] }),
          transform(61, 60, { father: 11 }),
          meshFilter(62, 60, asset("Assets/C/parts.fbx", 4300008)),
          meshRenderer(63, 60, []),
          gameObject(80, "BadSlots", { components: [81, 82, 83] }),
          transform(81, 80, { father: 11 }),
          meshFilter(82, 80, asset("Assets/A/parts.fbx", 4300000)),
          meshRenderer(83, 80, [asset("Assets/Mats/nothere.mat", 2100000, 2), "{fileID: 10303, guid: 0000000000000000f000000000000000, type: 0}"]),
          gameObject(70, "WheelByName", { components: [71, 72, 73] }),
          transform(71, 70, { father: 11 }),
          meshFilter(72, 70, asset("Assets/A/parts.fbx", 4300002)),
          meshRenderer(73, 70, [asset("Assets/Mats/red.mat", 2100000, 2)]),
        ),
      },
    ]);
    const prefab = prefabOf(report, "Assets/Prefabs/parts.prefab");
    const document = await read(join(outputDir, prefab.glb));

    // The two-slot Body: each primitive takes its own slot's material, not Paint and Glass from the FBX.
    expect(materialNames(document, "ByName")).toEqual(["red", "green"]);
    expect(baseColor(document, "ByName")).toEqual([[1, 0, 0], [0, 1, 0]]);
    expect(materialNames(document, "ByRecycle")).toEqual(["Paint", "Glass"]); // null slots keep the model binding
    expect(materialNames(document, "ByDerivedId")).toEqual(["green"]);
    expect(materialNames(document, "WheelByName")).toEqual(["red"]);

    const body = size(document, "ByName");
    const wheel = size(document, "WheelByName");
    near(body, size(document, "ByRecycle"), 5);
    near(wheel, size(document, "ByDerivedId"), 5);
    expect(body[0]).toBeCloseTo(1, 4);
    expect(wheel[0]).toBeCloseTo(0.2, 4);

    expect(prefab.meshNodes).toBe(6); // Unlisted has no mesh
    expect(prefab.unresolved).toEqual([
      expect.objectContaining({ kind: "material", node: "Root/BadSlots", reason: expect.stringMatching(/is not in the package; the model's own binding is kept/) }),
      expect.objectContaining({ kind: "material", node: "Root/BadSlots", reason: expect.stringMatching(/built-in Unity material/) }),
      expect.objectContaining({ kind: "mesh", node: "Root/Unlisted", reference: "Assets/C/parts.fbx:4300008", reason: expect.stringMatching(/no mesh id matches.*\(it has: (Body, Wheel|Wheel, Body)\)/) }),
    ]);
    expect(prefab.warnings.join(" ")).toMatch(/OnlyMesh: mesh 4300000 is not in any table of Assets\/D\/single.fbx; used the model's only mesh/);
    // Prefab materials share the textures and the model GLBs stay as the model import wrote them.
    expect(report.models.map((model) => model.source)).toEqual(["Assets/A/parts.fbx", "Assets/B/parts.fbx", "Assets/C/parts.fbx", "Assets/D/single.fbx"]);
    expect(report.counts).toMatchObject({ models: 4, prefabs: 1, failed: 0 });
    expect(report.materialAssets.map((material) => material.path)).toEqual(["Assets/Mats/green.mat", "Assets/Mats/red.mat"]);
  }, 180_000);

  it("meshes: a Blender-exported FBX (node scale 100, turned -90 about X) under a prefab that repeats that node lands where Unity puts it, not 100 times too large or turned", async () => {
    await writePartsFbx(join(fbxDirectory, "offset.fbx"), [{ name: "Foot", size: [0.4, 0.2, 0.1], materials: ["Paint"], offset: [1, 0.5, 0.25] }]);
    const offset = await readFile(join(fbxDirectory, "offset.fbx"));
    const half = Math.SQRT1_2;
    const { report, outputDir } = await importProject([
      ...folders("Assets", "Assets/Prefabs"),
      { path: "Assets/offset.fbx", data: offset, importer: importerWith("  internalIDToNameTable: []\n").replace("useFileScale: 0", "useFileScale: 1") },
      {
        path: "Assets/Prefabs/Foot.prefab",
        content: prefabFile(
          gameObject(10, "Foot", { components: [11] }),
          transform(11, 10),
          gameObject(20, "Model", { components: [21, 22, 23] }),
          // The node Unity gives a Blender FBX object: scale 100 and a quarter turn about X.
          transform(21, 20, { father: 11, rotation: [-half, 0, 0, half], scale: [100, 100, 100] }),
          meshFilter(22, 20, asset("Assets/offset.fbx", 4300000)),
          meshRenderer(23, 20, []),
        ),
      },
    ]);
    const prefab = prefabOf(report, "Assets/Prefabs/Foot.prefab");
    expect(prefab.unresolved).toEqual([]);
    expect(prefab.sizeMeters.x).toBeCloseTo(0.4, 3);
    // Unity: the mesh holds the raw vertices times 0.01 (centimetre file), mirrored in X; the node scales them back and turns Z up into Y up.
    const unity = multiply(unityMatrix([0, 0, 0], [-half, 0, 0, half], [100, 100, 100]), unityMatrix([0, 0, 0], [0, 0, 0, 1], [-0.01, 0.01, 0.01]));
    const corners: number[][] = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
      const raw = [1 + sx * 0.2, 0.5 + sy * 0.1, 0.25 + sz * 0.05];
      const world = [0, 1, 2].map((row) => unity[row]! * raw[0]! + unity[4 + row]! * raw[1]! + unity[8 + row]! * raw[2]!);
      corners.push([world[0]!, world[1]!, -world[2]!]); // Unity to glTF
    }
    const expected = [0, 1, 2].map((axis) => [Math.min(...corners.map((c) => c[axis]!)), Math.max(...corners.map((c) => c[axis]!))]);
    const document = await read(join(outputDir, prefab.glb));
    const { min, max } = getBounds(document.getRoot().listScenes()[0]!);
    for (const axis of [0, 1, 2]) {
      expect(min[axis], `min ${axis}`).toBeCloseTo(expected[axis]![0]!, 4);
      expect(max[axis], `max ${axis}`).toBeCloseTo(expected[axis]![1]!, 4);
    }
    // Sanity on the expectation itself: the Blender part's Z (up) is the prefab's height, 0.25 m with the part 0.1 m thick.
    expect(expected[1]).toEqual([expect.closeTo(0.2, 4), expect.closeTo(0.3, 4)]);
  }, 180_000);

  it("meshes: a file node that sits away from its pivot (node at T, vertices about -T, as in the real U3 pack) keeps the mesh at its pivot, not T metres off", async () => {
    // Centimetre vertices: a 40 x 20 x 10 cm part whose node sits 300 cm from the origin.
    await writePartsFbx(join(fbxDirectory, "pivot.fbx"), [{ name: "Pivoted", size: [40, 20, 10], materials: ["Paint"], pivot: [300, 0, 0] }]);
    const pivot = await readFile(join(fbxDirectory, "pivot.fbx"));
    const { report, outputDir } = await importProject([
      ...folders("Assets", "Assets/Prefabs"),
      { path: "Assets/pivot.fbx", data: pivot, importer: importerWith("  internalIDToNameTable: []\n").replace("useFileScale: 0", "useFileScale: 1") },
      {
        path: "Assets/Prefabs/Pivoted.prefab",
        content: prefabFile(gameObject(10, "Pivoted", { components: [11, 12, 13] }), transform(11, 10), meshFilter(12, 10, asset("Assets/pivot.fbx", 4300000)), meshRenderer(13, 10, [])),
      },
    ]);
    const prefab = prefabOf(report, "Assets/Prefabs/Pivoted.prefab");
    expect(prefab.unresolved).toEqual([]);
    const { min, max } = getBounds((await read(join(outputDir, prefab.glb))).getRoot().listScenes()[0]!);
    expect((min[0]! + max[0]!) / 2).toBeCloseTo(0, 2);
    expect(max[0]! - min[0]!).toBeCloseTo(0.4, 3);
  }, 180_000);

  it("meshes: an ordinary file node (translation T, vertices about the origin) is placed by the prefab's own GameObject, not by T twice", async () => {
    await writePartsFbx(join(fbxDirectory, "placed.fbx"), [{ name: "Block", size: [40, 20, 10], materials: ["Paint"], nodeAt: [300, 0, 0] }]);
    const placed = await readFile(join(fbxDirectory, "placed.fbx"));
    const { report, outputDir } = await importProject([
      ...folders("Assets", "Assets/Prefabs"),
      { path: "Assets/placed.fbx", data: placed, importer: importerWith("  internalIDToNameTable: []\n").replace("useFileScale: 0", "useFileScale: 1") },
      {
        path: "Assets/Prefabs/Block.prefab",
        // Unity copies the node's translation onto the prefab's GameObject (3 m); the mesh itself is about the origin.
        content: prefabFile(gameObject(10, "Block", { components: [11, 12, 13] }), transform(11, 10, { position: [3, 0, 0] }), meshFilter(12, 10, asset("Assets/placed.fbx", 4300000)), meshRenderer(13, 10, [])),
      },
    ]);
    const prefab = prefabOf(report, "Assets/Prefabs/Block.prefab");
    const { min, max } = getBounds((await read(join(outputDir, prefab.glb))).getRoot().listScenes()[0]!);
    expect((min[0]! + max[0]!) / 2).toBeCloseTo(3, 2);
  }, 180_000);

  it("meshes: a 64-bit id that no table lists and the derivation does not reproduce is matched by the GameObject name, with a warning (real Unity 2022 packs)", async () => {
    const { report, outputDir } = await importProject([
      ...folders("Assets", "Assets/C", "Assets/Prefabs"),
      { path: "Assets/C/parts.fbx", data: parts, importer: importerWith("  internalIDToNameTable: []\n") },
      {
        path: "Assets/Prefabs/Wheel.prefab",
        content: prefabFile(
          gameObject(10, "Wheel", { components: [11] }),
          transform(11, 10),
          gameObject(20, "Model", { components: [21, 22, 23] }),
          transform(21, 20, { father: 11 }),
          meshFilter(22, 20, asset("Assets/C/parts.fbx", "-6579300303780749490")),
          meshRenderer(23, 20, []),
        ),
      },
      {
        path: "Assets/Prefabs/Stranger.prefab",
        content: prefabFile(
          gameObject(10, "Stranger", { components: [11] }),
          transform(11, 10),
          gameObject(20, "Model", { components: [21, 22, 23] }),
          transform(21, 20, { father: 11 }),
          meshFilter(22, 20, asset("Assets/C/parts.fbx", "-6579300303780749490")),
          meshRenderer(23, 20, []),
        ),
      },
    ]);
    const matched = prefabOf(report, "Assets/Prefabs/Wheel.prefab");
    expect(matched.meshNodes).toBe(1);
    expect(matched.unresolved).toEqual([]);
    expect(matched.warnings.join(" ")).toMatch(/matched the mesh named "Wheel" by the GameObject name \(UNVERIFIED\)/);
    const document = await read(join(outputDir, matched.glb));
    expect(size(document, "Model")[0]).toBeCloseTo(0.2, 4);
    // No GameObject on the path is called like a mesh: still unresolved, never guessed.
    const stranger = prefabOf(report, "Assets/Prefabs/Stranger.prefab");
    expect(stranger.meshNodes).toBe(0);
    expect(stranger.unresolved).toEqual([expect.objectContaining({ kind: "mesh", reason: expect.stringMatching(/no mesh id matches/) })]);
  }, 180_000);

  it("meshes: every mesh node counts its bound slots, also when two nodes share one material variant", async () => {
    const red = asset("Assets/Mats/red.mat", 2100000, 2);
    const { report } = await importProject([
      ...folders("Assets", "Assets/A", "Assets/Mats", "Assets/Prefabs"),
      { path: "Assets/A/parts.fbx", data: parts, importer: importerWith(nameTable({ 4300000: "Body", 4300002: "Wheel" })) },
      { path: "Assets/Mats/red.mat", content: std("red", [1, 0, 0]) },
      {
        path: "Assets/Prefabs/wheels.prefab",
        content: prefabFile(
          gameObject(10, "Root", { components: [11] }),
          transform(11, 10),
          gameObject(20, "WheelA", { components: [21, 22, 23] }),
          transform(21, 20, { father: 11 }),
          meshFilter(22, 20, asset("Assets/A/parts.fbx", 4300002)),
          meshRenderer(23, 20, [red]),
          gameObject(30, "WheelB", { components: [31, 32, 33] }),
          transform(31, 30, { father: 11, position: [1, 0, 0] }),
          meshFilter(32, 30, asset("Assets/A/parts.fbx", 4300002)),
          meshRenderer(33, 30, [red]),
        ),
      },
    ]);
    expect(prefabOf(report, "Assets/Prefabs/wheels.prefab").boundSlots).toBe(2);
  }, 180_000);

  it("meshes: an ancestor's name does not pick a child's mesh (a `Body` root must not give its `Door` child the Body mesh)", async () => {
    const { report } = await importProject([
      ...folders("Assets", "Assets/C", "Assets/Prefabs"),
      { path: "Assets/C/parts.fbx", data: parts, importer: importerWith("  internalIDToNameTable: []\n") },
      {
        path: "Assets/Prefabs/Body.prefab",
        content: prefabFile(
          gameObject(10, "Body", { components: [11] }),
          transform(11, 10),
          gameObject(20, "Door", { components: [21, 22, 23] }),
          transform(21, 20, { father: 11 }),
          meshFilter(22, 20, asset("Assets/C/parts.fbx", "-6579300303780749490")),
          meshRenderer(23, 20, []),
          gameObject(30, "Wheel", { components: [31, 32, 33] }),
          transform(31, 30, { father: 11 }),
          meshFilter(32, 30, asset("Assets/C/parts.fbx", "-5429810754378104994")),
          meshRenderer(33, 30, []),
        ),
      },
    ]);
    const prefab = prefabOf(report, "Assets/Prefabs/Body.prefab");
    expect(prefab.meshNodes).toBe(1);
    expect(prefab.unresolved).toEqual([expect.objectContaining({ kind: "mesh", node: "Body/Door" })]);
    expect(prefab.warnings.join(" ")).toMatch(/matched the mesh named "Wheel"/);
    expect(prefab.warnings.join(" ")).not.toMatch(/named "Body"/);
  }, 180_000);

  it("meshes: models only a prefab uses are converted when assets names just the prefab, and a model that cannot be converted is reported", async () => {
    const { report } = await importProject(
      [
        ...folders("Assets"),
        { path: "Assets/a.fbx", data: parts, importer: importerWith(nameTable({ 4300000: "Body" })) },
        { path: "Assets/unused.fbx", data: parts },
        { path: "Assets/old.max", content: "x" },
        {
          path: "Assets/p.prefab",
          content: prefabFile(
            gameObject(1, "Root", { components: [2, 3, 4] }),
            transform(2, 1),
            meshFilter(3, 1, asset("Assets/a.fbx", 4300000)),
            meshRenderer(4, 1, []),
            gameObject(5, "Max", { components: [6, 7, 8] }),
            transform(6, 5, { father: 2 }),
            meshFilter(7, 5, asset("Assets/old.max", 4300000)),
            meshRenderer(8, 5, []),
          ),
        },
      ],
      { assets: ["p"] },
    );
    expect(report.models.map((model) => model.source)).toEqual(["Assets/a.fbx"]);
    expect(report.skipped).toEqual([{ asset: "Assets/old.max", reason: expect.stringMatching(/needs the authoring application/) }]);
    expect(report.prefabs[0]!.unresolved).toEqual([expect.objectContaining({ kind: "mesh", node: "Root/Max", reason: "the model was not converted" })]);
  }, 120_000);

  it("nested: a nested prefab with a material override and a variant of it import with the edits applied", async () => {
    const wheelMaterials = (path: string) => asset(path, 2100000, 2);
    const { report, outputDir } = await importProject([
      ...folders("Assets", "Assets/Mats", "Assets/Prefabs"),
      { path: "Assets/parts.fbx", data: parts, importer: importerWith(nameTable({ 4300000: "Body", 4300002: "Wheel" })) },
      { path: "Assets/Mats/paint.mat", content: std("paint", [0.5, 0.5, 0.5]) },
      { path: "Assets/Mats/glass.mat", content: std("glass", [0.2, 0.2, 0.9]) },
      { path: "Assets/Mats/rubber.mat", content: std("rubber", [0.1, 0.1, 0.1]) },
      { path: "Assets/Mats/chrome.mat", content: std("chrome", [1, 1, 1]) },
      {
        path: "Assets/Prefabs/Car.prefab",
        content: prefabFile(
          gameObject(10, "Car", { components: [11] }),
          transform(11, 10),
          gameObject(20, "Body", { components: [21, 22, 23] }),
          transform(21, 20, { father: 11, position: [0, 1, 0] }),
          meshFilter(22, 20, asset("Assets/parts.fbx", 4300000)),
          meshRenderer(23, 20, [wheelMaterials("Assets/Mats/paint.mat"), wheelMaterials("Assets/Mats/glass.mat")]),
          gameObject(30, "Wheel", { components: [31, 32, 33] }),
          transform(31, 30, { father: 11, position: [2, 0, 0] }),
          meshFilter(32, 30, asset("Assets/parts.fbx", 4300002)),
          meshRenderer(33, 30, [wheelMaterials("Assets/Mats/rubber.mat")]),
          gameObject(40, "Antenna", { components: [41, 42, 43] }),
          transform(41, 40, { father: 11 }),
          meshFilter(42, 40, asset("Assets/parts.fbx", 4300002)),
          meshRenderer(43, 40, []),
        ),
      },
      {
        path: "Assets/Prefabs/Garage.prefab",
        content: prefabFile(
          gameObject(1, "Garage", { components: [2] }),
          transform(2, 1, { position: [10, 0, 0] }),
          prefabInstance(1000, {
            source: "Assets/Prefabs/Car.prefab",
            parent: 2,
            modifications: [
              { target: 11, path: "m_LocalPosition.x", value: 3 },
              { target: 33, path: "m_Materials.Array.data[0]", reference: wheelMaterials("Assets/Mats/chrome.mat") },
            ],
            removedGameObjects: [40],
          }),
        ),
      },
      {
        path: "Assets/Prefabs/GarageVariant.prefab",
        content: prefabFile(
          prefabInstance(2000, {
            source: "Assets/Prefabs/Garage.prefab",
            modifications: [{ target: 2, path: "m_LocalPosition.x", value: -5 }],
          }),
        ),
      },
    ]);
    const car = await read(join(outputDir, prefabOf(report, "Assets/Prefabs/Car.prefab").glb));
    expect(materialNames(car, "Wheel")).toEqual(["rubber"]);
    expect(meshNode(car, "Antenna").getMesh()).not.toBeNull();

    for (const name of ["Garage", "GarageVariant"]) {
      const prefab = prefabOf(report, `Assets/Prefabs/${name}.prefab`);
      expect(prefab.unresolved).toEqual([]);
      expect(prefab.meshNodes).toBe(2); // Antenna was removed
      const document = await read(join(outputDir, prefab.glb));
      expect(document.getRoot().listNodes().map((node) => node.getName()).filter((name) => !name.endsWith(":mesh")).sort()).toEqual(["Body", "Car", "Garage", "Wheel"]);
      expect(materialNames(document, "Wheel")).toEqual(["chrome"]);
      expect(baseColor(document, "Wheel")).toEqual([[1, 1, 1]]);
      expect(materialNames(document, "Body")).toEqual(["paint", "glass"]);
      near(nodeNamed(document, "Car").getTranslation(), [3, 0, 0]);
    }
    const variant = await read(join(outputDir, prefabOf(report, "Assets/Prefabs/GarageVariant.prefab").glb));
    // The variant's root is the nested prefab's root, moved by the variant's own edit of m_LocalPosition.
    near(nodeNamed(variant, "Garage").getTranslation(), [-5, 0, 0]);
    expect(nodeNamed(await read(join(outputDir, prefabOf(report, "Assets/Prefabs/Garage.prefab").glb)), "Garage").getTranslation()[0]).toBeCloseTo(10, 5);
  }, 180_000);

  it("nested: a prefab instance of a model holds the converted model scene, and only its root can be edited", async () => {
    const rootTable = `  internalIDToNameTable:\n  - first:\n      1: 100000\n    second: parts\n  - first:\n      4: 400000\n    second: parts\n`;
    const { report, outputDir } = await importProject([
      ...folders("Assets"),
      { path: "Assets/parts.fbx", data: parts, importer: importerWith(rootTable) },
      {
        path: "Assets/Variant.prefab",
        content: prefabFile(
          prefabInstance(1000, {
            source: "Assets/parts.fbx",
            modifications: [
              { target: 400000, path: "m_LocalPosition.x", value: 4 },
              { target: 100000, path: "m_Name", value: "PartsRoot" },
              { target: 400002, path: "m_LocalPosition.x", value: 1 },
            ],
          }),
        ),
      },
    ]);
    const prefab = prefabOf(report, "Assets/Variant.prefab");
    const document = await read(join(outputDir, prefab.glb));
    near(nodeNamed(document, "PartsRoot").getTranslation(), [4, 0, 0]);
    expect(nodeNamed(document, "Body").getParentNode()?.getName()).toBe("PartsRoot");
    // Unity mirrors X on import and the prefab chain flips Z: the model scene's top nodes carry a half turn about Y.
    const turn = nodeNamed(document, "Body").getRotation();
    expect(Math.abs(turn[1]!)).toBeCloseTo(1, 5);
    expect(Math.abs(turn[3]!)).toBeCloseTo(0, 5);
    expect(meshNode(document, "Wheel").getMesh()).not.toBeNull();
    expect(prefab.meshNodes).toBe(2);
    expect(prefab.unresolved).toEqual([expect.objectContaining({ kind: "modification", reason: expect.stringMatching(/only the root of a model can be edited/) })]);
  }, 120_000);

  it("report: a LODGroup keeps LOD0 and lists the other levels", async () => {
    const { report, outputDir } = await importProject([
      ...folders("Assets"),
      { path: "Assets/parts.fbx", data: parts, importer: importerWith(nameTable({ 4300000: "Body", 4300002: "Wheel" })) },
      {
        path: "Assets/lod.prefab",
        content: prefabFile(
          gameObject(10, "Tree", { components: [11, 12, 13] }),
          transform(11, 10),
          lodGroup(12, 10, [
            { height: 0.6, renderers: [23] },
            { height: 0.2, renderers: [33] },
            { height: 0.05, renderers: [43] },
          ]),
          component(65, "BoxCollider", 13, 10),
          gameObject(20, "LOD0", { components: [21, 22, 23] }),
          transform(21, 20, { father: 11 }),
          meshFilter(22, 20, asset("Assets/parts.fbx", 4300000)),
          meshRenderer(23, 20, []),
          gameObject(30, "LOD1", { components: [31, 32, 33] }),
          transform(31, 30, { father: 11 }),
          meshFilter(32, 30, asset("Assets/parts.fbx", 4300002)),
          meshRenderer(33, 30, []),
          gameObject(40, "LOD2", { components: [41, 42, 43] }),
          transform(41, 40, { father: 11 }),
          meshFilter(42, 40, asset("Assets/parts.fbx", 4300002)),
          meshRenderer(43, 40, []),
        ),
      },
    ]);
    const prefab = prefabOf(report, "Assets/lod.prefab");
    const document = await read(join(outputDir, prefab.glb));
    expect(meshNode(document, "LOD0").getMesh()).not.toBeNull();
    expect(meshNode(document, "LOD1").getMesh()).toBeNull();
    expect(meshNode(document, "LOD2").getMesh()).toBeNull();
    expect(prefab.meshNodes).toBe(1);
    expect(prefab.lodLevels).toEqual([
      { group: "Tree", level: 1, transitionHeight: 0.2, nodes: ["Tree/LOD1"] },
      { group: "Tree", level: 2, transitionHeight: 0.05, nodes: ["Tree/LOD2"] },
    ]);
    expect(prefab.colliders).toEqual([{ node: "Tree", component: "BoxCollider" }]);
  }, 120_000);
});
