import { describe, expect, it } from "vitest";
import { resolveMaterial } from "../src/unreal/materials.js";

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
});
