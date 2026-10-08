import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { describe, expect, it, onTestFinished } from "vitest";

import { createGraphBaker } from "../src/unreal/graph-baker.js";
import { materialGraphSchema, type MaterialGraph } from "../src/unreal/graph-dump.js";
import { writePng } from "./helpers/unreal-fixture.js";

async function scratch(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

type Raw = Record<string, unknown>;
const pin = (node: string, mask: number[] | null = null) => ({ node, output: 0, mask });
const node = (id: string, cls: string, extra: Raw = {}): Raw => ({ id, class: cls, inputs: {}, constants: {}, ...extra });

// ---------------------------------------------------------------------------------------------------------
// PRD-537 Palms Pack 02: M_Trees_PP2 carries several texture parameters for the same output behind
// StaticSwitchParameters. The instance chain stores no static-switch overrides, so the default
// ("True = Leaves") takes the `Color` sampler, which no bark instance binds.

function treeMaster(): MaterialGraph {
  const nodes: Raw[] = [
    node("leaves", "TextureSampleParameter2D", { parameter: { name: "Color", group: "" }, default: null, texture: null, samplerType: "Color" }),
    node("bark", "TextureSampleParameter2D", { parameter: { name: "Bark_Color_Tex", group: "" }, default: null, texture: null, samplerType: "Color" }),
    node("tint", "Constant3Vector", { constants: { Constant: [1, 1, 1, 1] } }),
    node("leavesTint", "Multiply", { inputs: { A: pin("leaves", [1, 1, 1, 0]), B: pin("tint") } }),
    node("barkTint", "Multiply", { inputs: { A: pin("bark", [1, 1, 1, 0]), B: pin("tint") } }),
    node("switch", "StaticSwitchParameter", {
      parameter: { name: "True = Leaves, False = Bark or Fronds", group: "" },
      default: true,
      switchValue: true,
      inputs: { A: pin("leavesTint"), B: pin("barkTint") },
    }),
  ];
  return materialGraphSchema.parse({
    format: 1,
    material: "M_Trees",
    package: "/Game/Test/M_Trees",
    truncated: false,
    nodeCount: nodes.length,
    outputs: { baseColor: pin("switch"), roughness: null, metallic: null, emissive: null, opacity: null, opacityMask: null, normal: null, materialAttributes: null },
    nodes,
  });
}

const collected = (parent: string | undefined, entries: [string, string][]): string =>
  [
    ...(parent ? [`Parent = Material'${parent}.${parent}'`] : []),
    `CollectedTextureParameters[${entries.length}] =`,
    "{",
    ...entries.flatMap(([name, texture], index) => [
      `    CollectedTextureParameters[${index}] =`,
      "    {",
      `        Texture = Texture2D'/Game/Test/${texture}.${texture}'`,
      `        Name = ${name}`,
      "        Group = None",
      "    }",
    ]),
    "}",
  ].join("\n");

async function treeFixture(instance: [string, string][]) {
  const root = await scratch("palms-bake-");
  const sourceDir = join(root, "source", "Content", "Test");
  await mkdir(sourceDir, { recursive: true });
  for (const name of ["MI_Bark", "M_Trees"]) await writeFile(join(sourceDir, `${name}.uasset`), Buffer.alloc(16));
  await writePng(join(root, "T_Bark.png"), [200, 100, 50, 255], 4);
  await writePng(join(root, "T_Leaf.png"), [10, 220, 10, 255], 4);
  const assets = { png: new Map([["T_Bark", join(root, "T_Bark.png")], ["T_Leaf", join(root, "T_Leaf.png")]]) };
  const props: Record<string, string> = { MI_Bark: collected("M_Trees", instance) };
  return { sourceDir: join(root, "source"), assets, readProps: (name: string) => props[name] };
}

async function firstPixel(png: Buffer | Uint8Array): Promise<number[]> {
  const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return [...data.subarray(0, 3)];
}

describe("static switches the instance chain does not override (PRD-537 Palms Pack 02)", () => {
  const baker = (sourceDir: string) =>
    createGraphBaker({ sourceDir, maxTextureSize: 8, dumpGraphs: async () => new Map([["M_Trees", treeMaster()]]) })!;

  it("takes the branch whose texture parameters the instance binds when the default branch samples an unbound one", async () => {
    const { sourceDir, assets, readProps } = await treeFixture([["Bark_Color_Tex", "T_Bark"]]);
    const outcome = await baker(sourceDir)({ materialName: "MI_Bark_section", lookupName: "MI_Bark", assets, readProps });
    if (outcome.status !== "baked") throw new Error(`expected a bake, got ${JSON.stringify(outcome)}`);
    expect(outcome.texturesUsed).toEqual(["T_Bark"]);
    expect(await firstPixel(outcome.png)).toEqual([200, 100, 50]);
    // Never exact: the flipped switch is a guess made from which textures the instance binds.
    expect(outcome.confidence).toBe("heuristic");
    expect(outcome.approximations.join(" ")).toContain('static switch "True = Leaves, False = Bark or Fronds" taken as false');
  });

  it("keeps the default branch when the instance binds its textures", async () => {
    const { sourceDir, assets, readProps } = await treeFixture([["Color", "T_Leaf"], ["Bark_Color_Tex", "T_Bark"]]);
    const outcome = await baker(sourceDir)({ materialName: "MI_Bark_section", lookupName: "MI_Bark", assets, readProps });
    if (outcome.status !== "baked") throw new Error(`expected a bake, got ${JSON.stringify(outcome)}`);
    expect(outcome.texturesUsed).toEqual(["T_Leaf"]);
    expect(outcome.approximations.join(" ")).not.toContain("taken as");
  });

  it("stays unavailable, naming the unbound parameter, when neither branch is bound", async () => {
    const { sourceDir, assets, readProps } = await treeFixture([]);
    const outcome = await baker(sourceDir)({ materialName: "MI_Bark_section", lookupName: "MI_Bark", assets, readProps });
    expect(outcome.status).toBe("unavailable");
    expect(outcome.status === "unavailable" && outcome.reason).toContain('parameter "Color") has no texture');
  });
});
