import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { importUnrealDirectory } from "../src/unreal/importer.js";
import { parseMeshMaterialPackages, parseStaticMeshSections, remapGltfSectionMaterials, type StaticMeshSections } from "../src/unreal/static-mesh-sections.js";
import { writeFakeUmodel } from "./helpers/unreal-fixture.js";
import { staticMeshUasset, writeStaticMeshUasset } from "./helpers/uasset-fixture.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "section-materials-"));
  directories.push(directory);
  return directory;
}

async function asymmetricPng(path: string, seed: number): Promise<void> {
  const size = 16;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const base = 60 + x * 6 + ((y * seed * 37) % 23);
      const o = (y * size + x) * 4;
      pixels[o] = Math.min(255, base + 20);
      pixels[o + 1] = Math.min(255, base + 8);
      pixels[o + 2] = Math.min(255, base - 12);
      pixels[o + 3] = 255;
    }
  }
  await writeFile(path, await sharp(pixels, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer());
}

// Landscape Pro's pines and trees: slots [lod3 card, bark, leafs], SectionInfoMap section 0 -> bark, section 1 -> leafs.
// UE Viewer named the sections by raw index (slot 0 and slot 1), so the trunk got the lod3 atlas and the leaf cards
// got bark (a solid brown tree).
const TREE_SLOTS = ["MI_Lod3", "MI_Bark", "MI_Leafs"];
const TREE_MAP = [[0, 0, 1], [0, 1, 2], [1, 0, 1], [1, 1, 2], [4, 0, 0]] as const;

describe("parseStaticMeshSections", () => {
  it("reads the slot materials and the LOD0 section map of an uncooked 4.18 mesh", () => {
    const sections = parseStaticMeshSections(staticMeshUasset({ slots: TREE_SLOTS, sectionMap: TREE_MAP }));
    expect(sections?.slots).toEqual(TREE_SLOTS);
    expect([...(sections?.lod0 ?? [])]).toEqual([[0, 1], [1, 2]]);
  });

  it("reads a 4.19 package, whose summary carries a LocalizationId string before the gatherable-text fields", () => {
    const sections = parseStaticMeshSections(staticMeshUasset({ slots: TREE_SLOTS, sectionMap: TREE_MAP, ue4Version: 516 }));
    expect(sections?.slots).toEqual(TREE_SLOTS);
    expect([...(sections?.lod0 ?? [])]).toEqual([[0, 1], [1, 2]]);
  });

  it("leaves a 4.22+ package alone (the section remap serves UE Viewer's range only)", () => {
    expect(parseStaticMeshSections(staticMeshUasset({ slots: TREE_SLOTS, sectionMap: TREE_MAP, ue4Version: 522 }))).toBeUndefined();
  });

  it("returns undefined for bytes that are not such a package", () => {
    expect(parseStaticMeshSections(Buffer.alloc(64))).toBeUndefined();
    expect(parseStaticMeshSections(staticMeshUasset({ slots: TREE_SLOTS, sectionMap: TREE_MAP }).subarray(0, 120))).toBeUndefined();
    expect(parseStaticMeshSections(staticMeshUasset({ slots: TREE_SLOTS, sectionMap: [] }))).toBeUndefined();
  });
});

describe("parseMeshMaterialPackages", () => {
  const WINTER = "/Game/Pack/Winter/Materials";
  it("names the package each slot material is imported from (a Winter tree imports the Winter instances)", () => {
    for (const ue4Version of [514, 516, 522] as const) {
      const bytes = staticMeshUasset({
        slots: ["MI_Trunk", "MI_Leaf"],
        sectionMap: [[0, 0, 0], [0, 1, 1]],
        ue4Version,
        materialPackages: { MI_Trunk: `${WINTER}/MI_Trunk`, MI_Leaf: `${WINTER}/MI_Leaf` },
      });
      expect([...(parseMeshMaterialPackages(bytes) ?? [])]).toEqual([
        ["mi_trunk", `${WINTER}/MI_Trunk`],
        ["mi_leaf", `${WINTER}/MI_Leaf`],
      ]);
    }
  });

  it("keeps one entry for a slot material listed twice, and skips bare class imports", () => {
    const bytes = staticMeshUasset({ slots: ["MI_Trunk", "MI_Trunk", "MI_Leaf"], sectionMap: [[0, 0, 0]], materialPackages: { MI_Trunk: `${WINTER}/MI_Trunk` } });
    expect([...(parseMeshMaterialPackages(bytes) ?? [])]).toEqual([["mi_trunk", `${WINTER}/MI_Trunk`]]);
    expect(parseMeshMaterialPackages(staticMeshUasset({ slots: ["MI_Trunk"], sectionMap: [[0, 0, 0]] }))?.size).toBe(0);
    expect(parseMeshMaterialPackages(Buffer.alloc(64))).toBeUndefined();
  });
});

describe("remapGltfSectionMaterials", () => {
  const sections: StaticMeshSections = { slots: TREE_SLOTS, lod0: new Map([[0, 1], [1, 2]]) };
  const exported = () => ({
    materials: [{ name: "MI_Lod3", pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } }, { name: "MI_Bark", pbrMetallicRoughness: { baseColorFactor: [0, 1, 0, 1] } }],
    meshes: [{ primitives: [{ material: 0 }, { material: 1 }] }],
  });

  it("gives each section the slot the SectionInfoMap names", () => {
    const gltf = exported();
    expect(remapGltfSectionMaterials(gltf, sections)).toBe(2);
    expect(gltf.materials.map((material) => material.name)).toEqual(["MI_Bark", "MI_Leafs"]);
    expect(gltf.meshes[0]!.primitives.map((primitive) => primitive.material)).toEqual([0, 1]);
  });

  it("is idempotent, and leaves a mesh alone when the map is the identity or the shape is not the expected one", () => {
    const gltf = exported();
    remapGltfSectionMaterials(gltf, sections);
    expect(remapGltfSectionMaterials(gltf, sections)).toBe(0);
    expect(remapGltfSectionMaterials(exported(), { slots: TREE_SLOTS, lod0: new Map([[0, 0], [1, 1]]) })).toBe(0);
    expect(remapGltfSectionMaterials(exported(), { slots: TREE_SLOTS, lod0: new Map([[0, 1]]) })).toBe(0);
    const foreign = exported();
    foreign.materials[0]!.name = "Something else";
    expect(remapGltfSectionMaterials(foreign, sections)).toBe(0);
  });

  it("remaps a group mesh with many primitives per material by raw slot, not by primitive order (BoughGroup02: sections swap bark and leafs)", () => {
    const group: StaticMeshSections = { slots: ["MI_Bark", "MI_Leafs"], lod0: new Map([[0, 1], [1, 0]]) };
    const gltf = {
      materials: [{ name: "MI_Bark" }, { name: "MI_Leafs" }],
      meshes: [{ primitives: [{ material: 0 }, { material: 1 }, { material: 0 }, { material: 1 }, { material: 0 }] }],
    };
    expect(remapGltfSectionMaterials(gltf, group)).toBe(5);
    expect(gltf.meshes[0]!.primitives.map((primitive) => gltf.materials[primitive.material]!.name)).toEqual(["MI_Leafs", "MI_Bark", "MI_Leafs", "MI_Bark", "MI_Leafs"]);
    // Run again over its own output: the raw slots no longer read in order, so it is left alone.
    expect(remapGltfSectionMaterials(gltf, group)).toBe(0);
  });

  it("handles a swap and a duplicate slot name (pine05: slots lod3, bark, leafs, bark; sections -> 3, 2)", () => {
    const pine: StaticMeshSections = { slots: ["MI_Lod3", "MI_Bark", "MI_Leafs", "MI_Bark"], lod0: new Map([[0, 3], [1, 2]]) };
    const gltf = exported();
    expect(remapGltfSectionMaterials(gltf, pine)).toBe(2);
    expect(gltf.materials.map((material) => material.name)).toEqual(["MI_Bark", "MI_Leafs"]);
  });
});

describe("a mesh whose SectionInfoMap reorders the slots", () => {
  async function importTree(): Promise<{ readonly byPrimitive: (string | undefined)[]; readonly sections: string[] }> {
    const directory = await scratch();
    const fixture = join(directory, "fixture");
    const sourceDir = join(directory, "source");
    await mkdir(fixture, { recursive: true });
    await mkdir(join(sourceDir, "Content", "Pack"), { recursive: true });
    await writeStaticMeshUasset(join(sourceDir, "Content", "Pack", "Tree.uasset"), { slots: TREE_SLOTS, sectionMap: TREE_MAP });
    // The exporter's glTF: two sections, named by raw slot 0 and 1.
    const document = new Document();
    const buffer = document.createBuffer();
    const accessor = (semantic: string, type: "VEC3" | "VEC2", values: number[]) => document.createAccessor(semantic).setType(type).setArray(new Float32Array(values)).setBuffer(buffer);
    const mesh = document.createMesh("Tree");
    for (const name of ["MI_Lod3", "MI_Bark"]) {
      mesh.addPrimitive(
        document
          .createPrimitive()
          .setAttribute("POSITION", accessor("POSITION", "VEC3", [0, 0, 0, 1, 0, 0, 0, 2, 0]))
          .setAttribute("NORMAL", accessor("NORMAL", "VEC3", [0, 0, 1, 0, 0, 1, 0, 0, 1]))
          .setAttribute("TEXCOORD_0", accessor("TEXCOORD_0", "VEC2", [0, 0, 1, 0, 0, 1]))
          .setMaterial(document.createMaterial(name).setBaseColorFactor([0.3, 0.9, 0.3, 1])),
      );
    }
    document.createScene().addChild(document.createNode("Tree").setMesh(mesh));
    await new NodeIO().write(join(fixture, "Tree.gltf"), document);
    for (const [material, texture, seed] of [["MI_Lod3", "T_Atlas", 1], ["MI_Bark", "T_Bark", 3], ["MI_Leafs", "T_Leaf", 5]] as const) {
      await writeFile(join(fixture, `${material}.mat`), `Diffuse=${texture}\n`);
      await writeFile(join(fixture, `${material}.props.txt`), "");
      await asymmetricPng(join(fixture, `${texture}.png`), seed);
    }
    const tool = join(directory, "umodel");
    await writeFakeUmodel(tool, { exportFrom: fixture, outputSubdirectory: "Pack", classes: { Tree: ["StaticMesh"] } });
    const outputDir = join(directory, "output");
    const report = await importUnrealDirectory({
      sourceDir,
      outputDir,
      concurrency: 1,
      graphBake: false,
      freeSpaceBytes: 30_000_000_000,
      environment: { ...process.env, THREENATIVE_UNREAL_CACHE_DIR: join(directory, "cache") },
      umodel: { name: "umodel", path: tool, version: "fixture" },
    });
    const glb = await new NodeIO().registerExtensions(ALL_EXTENSIONS).read(join(outputDir, report.models[0]!.glb));
    const primitives = glb.getRoot().listMeshes().flatMap((m) => m.listPrimitives());
    return {
      byPrimitive: primitives.map((primitive) => primitive.getMaterial()?.getBaseColorTexture()?.getName()),
      sections: report.models[0]!.materials.map((section) => section.name),
    };
  }

  it("paints each section with the material the editor assigned, not the one UE Viewer guessed", async () => {
    const imported = await importTree();
    expect(imported.sections).toEqual(["MI_Bark", "MI_Leafs"]);
    expect(imported.byPrimitive).toEqual(["T_Bark", "T_Leaf"]);
  });
});

describe("same-named material instances in two folders", () => {
  // A Summer and an Autumn copy of every instance share each name; the Autumn tree imports the Autumn copies.
  // The copy UE Viewer indexed last (Summer) is not evidence, and neither copy sits beside the mesh.
  async function importAutumnTree(materialPackages: boolean): Promise<{ readonly texture: string | undefined; readonly limitations: readonly string[] }> {
    const directory = await scratch();
    const fixture = join(directory, "fixture");
    const sourceDir = join(directory, "source");
    for (const folder of ["Autumn/Meshes", "Autumn/Materials", "Summer/Materials"]) await mkdir(join(fixture, folder), { recursive: true });
    await mkdir(join(sourceDir, "Content", "Pack", "Autumn", "Meshes"), { recursive: true });
    await writeStaticMeshUasset(join(sourceDir, "Content", "Pack", "Autumn", "Meshes", "AutumnTree.uasset"), {
      slots: ["MI_Trunk"],
      sectionMap: [[0, 0, 0]],
      ue4Version: 516,
      ...(materialPackages ? { materialPackages: { MI_Trunk: "/Game/Pack/Autumn/Materials/MI_Trunk" } } : {}),
    });
    const document = new Document();
    const buffer = document.createBuffer();
    const accessor = (semantic: string, type: "VEC3" | "VEC2", values: number[]) => document.createAccessor(semantic).setType(type).setArray(new Float32Array(values)).setBuffer(buffer);
    const mesh = document.createMesh("AutumnTree").addPrimitive(
      document
        .createPrimitive()
        .setAttribute("POSITION", accessor("POSITION", "VEC3", [0, 0, 0, 1, 0, 0, 0, 2, 0]))
        .setAttribute("NORMAL", accessor("NORMAL", "VEC3", [0, 0, 1, 0, 0, 1, 0, 0, 1]))
        .setAttribute("TEXCOORD_0", accessor("TEXCOORD_0", "VEC2", [0, 0, 1, 0, 0, 1]))
        .setMaterial(document.createMaterial("MI_Trunk")),
    );
    document.createScene().addChild(document.createNode("AutumnTree").setMesh(mesh));
    await new NodeIO().write(join(fixture, "Autumn", "Meshes", "AutumnTree.gltf"), document);
    for (const [season, texture, seed] of [["Autumn", "T_Bark_Autumn", 1], ["Summer", "T_Bark_Summer", 3]] as const) {
      await writeFile(join(fixture, season, "Materials", "MI_Trunk.mat"), `Diffuse=${texture}\n`);
      await writeFile(join(fixture, season, "Materials", "MI_Trunk.props.txt"), "");
      await asymmetricPng(join(fixture, season, "Materials", `${texture}.png`), seed);
    }
    const tool = join(directory, "umodel");
    await writeFakeUmodel(tool, { exportFrom: fixture, outputSubdirectory: "Pack", classes: { AutumnTree: ["StaticMesh"] } });
    const outputDir = join(directory, "output");
    const report = await importUnrealDirectory({
      sourceDir,
      outputDir,
      concurrency: 1,
      graphBake: false,
      freeSpaceBytes: 30_000_000_000,
      environment: { ...process.env, THREENATIVE_UNREAL_CACHE_DIR: join(directory, "cache") },
      umodel: { name: "umodel", path: tool, version: "fixture" },
    });
    const section = report.models[0]!.materials[0]!;
    return { texture: section.bindings.find((binding) => binding.slot === "baseColor")?.texture, limitations: section.limitations };
  }

  it("binds the copy in the package the mesh imports, not the one indexed last", async () => {
    const imported = await importAutumnTree(true);
    expect(imported.texture).toBe("T_Bark_Autumn");
    expect(imported.limitations.join(" ")).not.toMatch(/exported from 2 folders/);
  });

  it("without import evidence keeps the last-indexed copy and says so", async () => {
    const imported = await importAutumnTree(false);
    expect(imported.texture).toBe("T_Bark_Summer");
    expect(imported.limitations.join(" ")).toMatch(/exported from 2 folders/);
  });
});
