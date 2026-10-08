import { describe, expect, it } from "vitest";
import { parsePropsFile, resolveMaterial } from "../src/unreal/materials.js";

const tex = (name: string): string => `Texture2D'Content/Pack/Textures/${name}.${name}'`;

const instanceProps = (parent: string, overrides: Array<[string, string]>): string =>
  [
    `Parent = Material3'Content/Pack/Materials/${parent}.${parent}'`,
    `TextureParameterValues[${overrides.length}] =`,
    "{",
    ...overrides.flatMap(([name, texture], index) => [
      `    TextureParameterValues[${index}] =`,
      "    {",
      "        ParameterInfo = { Name=None }",
      `        ParameterValue = ${tex(texture)}`,
      `        ParameterName = ${name}`,
      "    }",
    ]),
    "}",
  ].join("\n");

const masterProps = (defaults: Array<[string, string]>): string =>
  [
    `CollectedTextureParameters[${defaults.length}] =`,
    "{",
    ...defaults.flatMap(([name, texture], index) => [
      `    CollectedTextureParameters[${index}] =`,
      "    {",
      `        Texture = ${tex(texture)}`,
      `        Name = ${name}`,
      "        Group = Base",
      "    }",
    ]),
    "}",
  ].join("\n");

const resolve = (files: Record<string, { mat?: string; props?: string }>, name: string, textures: string[]) =>
  resolveMaterial({
    name,
    readMat: (material) => files[material]?.mat,
    readProps: (material) => files[material]?.props,
    availableTextures: new Set(textures),
  });

describe("material instance overrides beat parent defaults", () => {
  // Shaped like Soul Cave's MI_Cave_Rock_Pillar: UE Viewer wrote the instance's .mat from the
  // parent's defaults, while the instance's TextureParameterValues name the real textures.
  const soulCave = {
    MI_Rock: {
      mat: "Diffuse=T_Rock_Stalactite_M\nNormal=T_Rock_Large_N\nOther[0]=T_Rock_Pillar_N\nOther[1]=T_Rock_Pillar_M\nOther[2]=T_Rock_Stalactite_N\n",
      props: instanceProps("M_Master", [["NRM", "T_Rock_Pillar_N"], ["MainNormal", "T_Rock_Large_N"], ["Mask", "T_Rock_Pillar_M"]]),
    },
    M_Master: {
      mat: "Diffuse=T_Rock_Stalactite_M\nNormal=T_Rock_Stalactite_N\n",
      props: masterProps([["Mask", "T_Rock_Stalactite_M"], ["NRM", "T_Rock_Stalactite_N"]]),
    },
  };
  const available = ["T_Rock_Stalactite_M", "T_Rock_Stalactite_N", "T_Rock_Large_N", "T_Rock_Pillar_N", "T_Rock_Pillar_M"];

  it("never binds a parent default the instance overrides", () => {
    const resolved = resolve(soulCave, "MI_Rock", available);
    const bound = resolved.bindings.flatMap((b) => [b.texture, b.secondaryTexture ?? []].flat());
    expect(bound.filter((texture) => /Stalactite/.test(texture))).toEqual([]);
  });

  it("does not bind the overriding Mask parameter as an exact base colour", () => {
    const resolved = resolve(soulCave, "MI_Rock", available);
    // `Mask` has no PBR slot, so the override is withheld rather than painted over Diffuse. The
    // last-resort texture-set heuristic may still pick a sibling, but only as a labelled guess.
    const base = resolved.bindings.find((b) => b.slot === "baseColor");
    if (base) expect(base).toMatchObject({ source: "texture-set", confidence: "heuristic" });
    expect(resolved.limitations.join("\n")).toMatch(/T_Rock_Stalactite_M.*overridden/);
  });

  it("takes the override for a slot whose .mat texture is the parent default", () => {
    const resolved = resolve(
      {
        MI_Wall: { mat: "Normal=T_Wall_Default_N\n", props: instanceProps("M_Wall", [["NRM", "T_Wall_Own_N"]]) },
        M_Wall: { mat: "Normal=T_Wall_Default_N\n", props: masterProps([["NRM", "T_Wall_Default_N"]]) },
      },
      "MI_Wall",
      ["T_Wall_Default_N", "T_Wall_Own_N"],
    );
    expect(resolved.bindings.find((b) => b.slot === "normal")).toMatchObject({
      texture: "T_Wall_Own_N",
      source: "props",
      confidence: "exact",
    });
  });

  it("leaves a .mat texture alone when the instance overrides a different parameter", () => {
    const resolved = resolve(
      {
        MI_Wall: { mat: "Normal=T_Wall_Resolved_N\n", props: instanceProps("M_Wall", [["Detail", "T_Wall_Detail_N"]]) },
        M_Wall: { mat: "Normal=T_Wall_Resolved_N\n", props: masterProps([["NRM", "T_Wall_Default_N"]]) },
      },
      "MI_Wall",
      ["T_Wall_Resolved_N", "T_Wall_Default_N", "T_Wall_Detail_N"],
    );
    expect(resolved.bindings.find((b) => b.slot === "normal")).toMatchObject({ texture: "T_Wall_Resolved_N", source: "mat" });
  });

  it("keeps a default the instance re-states unchanged", () => {
    const resolved = resolve(
      {
        MI_Wall: { mat: "Normal=T_Wall_N\n", props: instanceProps("M_Wall", [["NRM", "T_Wall_N"]]) },
        M_Wall: { mat: "Normal=T_Wall_N\n", props: masterProps([["NRM", "T_Wall_N"]]) },
      },
      "MI_Wall",
      ["T_Wall_N"],
    );
    expect(resolved.bindings.find((b) => b.slot === "normal")).toMatchObject({ texture: "T_Wall_N", source: "mat" });
  });

  it("keeps a default that another, un-overridden parameter still uses", () => {
    const resolved = resolve(
      {
        MI_Wall: { mat: "Normal=T_Wall_Shared_N\n", props: instanceProps("M_Wall", [["NRM", "T_Wall_Own_N"]]) },
        M_Wall: { mat: "Normal=T_Wall_Shared_N\n", props: masterProps([["NRM", "T_Wall_Shared_N"], ["Detail", "T_Wall_Shared_N"]]) },
      },
      "MI_Wall",
      ["T_Wall_Shared_N", "T_Wall_Own_N"],
    );
    expect(resolved.bindings.find((b) => b.slot === "normal")).toMatchObject({ texture: "T_Wall_Shared_N", source: "mat" });
  });
});

// The modern converter writes an instance's own overrides as `CollectedTextureParameters` (an
// instance has no expression nodes, so the collected block is exactly its overrides).
describe("modern-converter instance props (Parent + CollectedTextureParameters only)", () => {
  const modernInstance = (parent: string, overrides: Array<[string, string]>): string =>
    `Parent = Material'${parent}.${parent}'\n${masterProps(overrides)}`;

  it("parsePropsFile exposes the collected entries of an instance as overrides", () => {
    const parsed = parsePropsFile(modernInstance("M_Wall", [["NRM", "T_Wall_Own_N"], ["Color", "T_Wall_Own_D"]]));
    expect(parsed.overrides).toEqual([
      { name: "NRM", texture: "T_Wall_Own_N" },
      { name: "Color", texture: "T_Wall_Own_D" },
    ]);
    expect(parsed.collected).toHaveLength(2);
  });

  it("does not turn a root material's defaults into overrides, nor double count real overrides", () => {
    expect(parsePropsFile(masterProps([["NRM", "T_Wall_Default_N"]])).overrides).toEqual([]);
    const both = `${instanceProps("M_Wall", [["NRM", "T_Wall_Own_N"]])}\n${masterProps([["NRM", "T_Wall_Own_N"]])}`;
    expect(parsePropsFile(both).overrides).toEqual([{ name: "NRM", texture: "T_Wall_Own_N" }]);
  });

  it("binds the instance's override, not the parent's collected default", () => {
    const resolved = resolve(
      {
        MI_Wall: { mat: "Normal=T_Wall_Default_N\n", props: modernInstance("M_Wall", [["NRM", "T_Wall_Own_N"]]) },
        M_Wall: { mat: "Normal=T_Wall_Default_N\n", props: masterProps([["NRM", "T_Wall_Default_N"]]) },
      },
      "MI_Wall",
      ["T_Wall_Default_N", "T_Wall_Own_N"],
    );
    expect(resolved.bindings.find((b) => b.slot === "normal")).toMatchObject({ texture: "T_Wall_Own_N", source: "props" });
    const bound = resolved.bindings.flatMap((b) => [b.texture, b.secondaryTexture ?? []].flat());
    expect(bound).not.toContain("T_Wall_Default_N");
  });

  it("supersedes the parent default of the same parameter even when the .mat names it", () => {
    const resolved = resolve(
      {
        MI_Wall: { mat: "Diffuse=T_Wall_Default_D\n", props: modernInstance("M_Wall", [["Color", "T_Wall_Own_D"]]) },
        M_Wall: { mat: "Diffuse=T_Wall_Default_D\n", props: masterProps([["Color", "T_Wall_Default_D"]]) },
      },
      "MI_Wall",
      ["T_Wall_Default_D", "T_Wall_Own_D"],
    );
    expect(resolved.bindings.find((b) => b.slot === "baseColor")).toMatchObject({ texture: "T_Wall_Own_D" });
    const bound = resolved.bindings.flatMap((b) => [b.texture, b.secondaryTexture ?? []].flat());
    expect(bound).not.toContain("T_Wall_Default_D");
  });

  it("supersedes a texture an ANCESTOR instance overrides, so the texture-set fallback cannot rebind it", () => {
    // Paragon shape: the leaf instance and its parent instance both override `Mask`; the parent's
    // texture ends up in the leaf's .mat `Other[]` and would otherwise be picked as a base colour.
    const resolved = resolve(
      {
        MI_Leaf: {
          mat: "Normal=T_Leaf_N\nOther[0]=T_Mid_M\nOther[1]=T_Mid_N\n",
          props: instanceProps("MI_Mid", [["Mask", "T_Leaf_M"]]),
        },
        MI_Mid: { mat: "Normal=T_Mid_N\n", props: instanceProps("M_Base", [["Mask", "T_Mid_M"]]) },
        M_Base: { mat: "Normal=T_Base_N\n", props: masterProps([["Mask", "T_Base_M"]]) },
      },
      "MI_Leaf",
      ["T_Leaf_N", "T_Mid_M", "T_Mid_N", "T_Leaf_M", "T_Base_M", "T_Base_N"],
    );
    const bound = resolved.bindings.flatMap((b) => [b.texture, b.secondaryTexture ?? []].flat());
    expect(bound).not.toContain("T_Mid_M");
    expect(bound).not.toContain("T_Base_M");
  });
});
