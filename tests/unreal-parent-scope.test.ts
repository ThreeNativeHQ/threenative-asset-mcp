import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { importUnrealDirectory, scopeParentChain } from "../src/unreal/importer.js";
import { writeFakeUmodel, writeMeshFixture } from "./helpers/unreal-fixture.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "parent-scope-"));
  directories.push(directory);
  return directory;
}

/** A warm, low-saturation, asymmetric picture (the importer only binds plausible albedos). */
async function writeAlbedo(path: string, seed: number): Promise<void> {
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

const reference = (cls: string, directory: string, name: string): string => `${cls}'Content/Pack/${directory}/${name}.${name}'`;

const overrideProps = (parent: string, parentDirectory: string, diffuse: string): string =>
  [
    `Parent = MaterialInstanceConstant'Content/Pack/${parentDirectory}/${parent}.${parent}'`,
    "TextureParameterValues[1] =",
    "{",
    "    TextureParameterValues[0] =",
    "    {",
    "        ParameterInfo = { Name=None }",
    `        ParameterValue = ${reference("Texture2D", "Textures", diffuse)}`,
    "        ParameterName = Diffuse",
    "    }",
    "}",
  ].join("\n");

describe("a parent material that shares its basename with another package's", () => {
  // Landscape Pro: DeadTrees/MI_dead-tree-leafs_master_Inst overrides Diffuse with the dead leaf, the
  // GreenTrees/ copy of the same name with the green one. A dead tree's lod00 instance names the DeadTrees
  // package in its `Parent =` line, but the basename-keyed index handed it whichever copy was indexed last.
  async function importLeaf() {
    const directory = await scratch();
    const fixture = join(directory, "fixture");
    const sourceDir = join(directory, "source", "Content");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, "Tree.uasset"), Buffer.alloc(16));
    await writeMeshFixture(fixture, {
      name: "Tree",
      materialName: "MI_Leaf_lod00",
      mat: "Diffuse=T_Dead_Leaf\n",
      props: overrideProps("MI_Leaf_Parent", "A_DeadTrees", "T_Dead_Leaf"),
      textures: ["T_Dead_Leaf", "T_Green_Leaf"],
    });
    await writeAlbedo(join(fixture, "T_Dead_Leaf.png"), 1);
    await writeAlbedo(join(fixture, "T_Green_Leaf.png"), 3);
    for (const [folder, texture] of [["A_DeadTrees", "T_Dead_Leaf"], ["Z_GreenTrees", "T_Green_Leaf"]] as const) {
      await mkdir(join(fixture, folder), { recursive: true });
      await writeFile(join(fixture, folder, "MI_Leaf_Parent.mat"), `Diffuse=${texture}\n`);
      await writeFile(join(fixture, folder, "MI_Leaf_Parent.props.txt"), overrideProps("M_Leaf_Master", "Master", texture));
    }
    await writeFile(join(fixture, "M_Leaf_Master.mat"), "Diffuse=T_Dead_Leaf\n");
    await writeFile(
      join(fixture, "M_Leaf_Master.props.txt"),
      ["CollectedTextureParameters[1] =", "{", "    CollectedTextureParameters[0] =", "    {", `        Texture = ${reference("Texture2D", "Textures", "T_Dead_Leaf")}`, "        Name = Diffuse", "        Group = Base", "    }", "}"].join("\n"),
    );
    const tool = join(directory, "umodel");
    await writeFakeUmodel(tool, { exportFrom: fixture, classes: { Tree: ["StaticMesh"] } });
    return importUnrealDirectory({
      sourceDir: join(directory, "source"),
      outputDir: join(directory, "output"),
      concurrency: 1,
      graphBake: false,
      freeSpaceBytes: 30_000_000_000,
      environment: { ...process.env, THREENATIVE_UNREAL_CACHE_DIR: join(directory, "cache") },
      umodel: { name: "umodel", path: tool, version: "fixture" },
    });
  }

  it("binds the texture of the package the Parent line names, not the last-indexed namesake", async () => {
    const report = await importLeaf();
    const section = report.models[0]!.materials[0]!;
    const base = section.bindings.find((binding) => binding.slot === "baseColor");
    expect(base?.texture).toBe("T_Dead_Leaf");
  });
});

describe("scopeParentChain", () => {
  const assetsOf = (propsAll: Record<string, string[]>, matAll: Record<string, string[]> = {}) => {
    const last = (all: Record<string, string[]>): Map<string, string> => new Map(Object.entries(all).map(([name, paths]) => [name, paths[paths.length - 1]!]));
    return {
      gltf: new Map(),
      psa: new Map(),
      mat: last(matAll),
      props: last(propsAll),
      matAll: new Map(Object.entries(matAll)),
      propsAll: new Map(Object.entries(propsAll)),
      png: new Map(),
      audio: new Map(),
      dna: new Map(),
    };
  };

  it("keeps the same object when nothing is ambiguous, so per-assets caches keep hitting", async () => {
    const unique = assetsOf({ MI_Leaf: ["/raw/MI_Leaf.props.txt"] });
    expect(scopeParentChain(unique, "MI_Leaf")).toBe(unique);
    const { propsAll: _propsAll, matAll: _matAll, ...legacy } = assetsOf({});
    expect(scopeParentChain(legacy, "MI_Leaf")).toBe(legacy);
  });

  async function chainOf(parentLine: string) {
    const root = await scratch();
    const dead = join(root, "raw", "Foliage", "DeadTrees");
    const green = join(root, "raw", "Foliage", "GreenTrees");
    const leaf = join(root, "raw", "Foliage", "DeadTrees", "tree02");
    for (const directory of [dead, green, leaf]) await mkdir(directory, { recursive: true });
    await writeFile(join(leaf, "MI_Leaf.props.txt"), `${parentLine}\n`);
    for (const directory of [dead, green]) {
      await writeFile(join(directory, "MI_Parent.props.txt"), "TwoSided = true\n");
      await writeFile(join(directory, "MI_Parent.mat"), "Diffuse=T\n");
    }
    const matAll = { MI_Parent: [join(dead, "MI_Parent.mat"), join(green, "MI_Parent.mat")], MI_Leaf: [join(leaf, "MI_Leaf.mat")] };
    const propsAll = { MI_Parent: [join(dead, "MI_Parent.props.txt"), join(green, "MI_Parent.props.txt")], MI_Leaf: [join(leaf, "MI_Leaf.props.txt")] };
    return { dead, green, assets: assetsOf(propsAll, matAll) };
  }

  it("points an ambiguous parent at the copy in the package the Parent line names, .mat beside its .props.txt", async () => {
    const { dead, green, assets } = await chainOf("Parent = MaterialInstanceConstant'Content/Pack/Foliage/DeadTrees/MI_Parent.MI_Parent'");
    expect(assets.props.get("MI_Parent")).toBe(join(green, "MI_Parent.props.txt"));
    const scoped = scopeParentChain(assets, "MI_Leaf");
    expect(scoped.props.get("MI_Parent")).toBe(join(dead, "MI_Parent.props.txt"));
    expect(scoped.mat.get("MI_Parent")).toBe(join(dead, "MI_Parent.mat"));
    expect(assets.props.get("MI_Parent")).toBe(join(green, "MI_Parent.props.txt"));
    expect(scopeParentChain(assets, "MI_Leaf")).toBe(scoped);
  });

  it("keeps the existing pick when the Parent line names no directory or a package neither copy is in", async () => {
    const nameOnly = await chainOf("Parent = MI_Parent");
    expect(scopeParentChain(nameOnly.assets, "MI_Leaf")).toBe(nameOnly.assets);
    const elsewhere = await chainOf("Parent = MaterialInstanceConstant'Content/Pack/Other/Place/MI_Parent.MI_Parent'");
    expect(scopeParentChain(elsewhere.assets, "MI_Leaf")).toBe(elsewhere.assets);
  });
});
