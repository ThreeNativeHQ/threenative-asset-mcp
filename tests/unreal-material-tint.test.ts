import { describe, expect, it } from "vitest";
import { resolveMaterial } from "../src/unreal/materials.js";

const vec = (name: string, value: [number, number, number, number]): string[] => [
  "    {",
  `        ParameterInfo = { Name=${name} }`,
  `        ParameterValue = { R=${value[0]}, G=${value[1]}, B=${value[2]}, A=${value[3]} }`,
  "    }",
];

const instanceProps = (parent: string, vectors: Array<[string, [number, number, number, number]]>): string =>
  [
    `Parent = Material3'Content/Pack/Materials/${parent}.${parent}'`,
    `VectorParameterValues[${vectors.length}] =`,
    "{",
    ...vectors.flatMap(([name, value], index) =>
      [`    VectorParameterValues[${index}] =`, ...vec(name, value)],
    ),
    "}",
  ].join("\n");

const masterProps = (vectors: Array<[string, [number, number, number, number]]>): string =>
  [
    `CollectedVectorParameters[${vectors.length}] =`,
    "{",
    ...vectors.flatMap(([name, value], index) =>
      [`    CollectedVectorParameters[${index}] =`, ...vec(name, value)],
    ),
    "}",
  ].join("\n");

const resolve = (files: Record<string, { mat?: string; props?: string }>, name: string, textures: string[]) =>
  resolveMaterial({
    name,
    readMat: (material) => files[material]?.mat,
    readProps: (material) => files[material]?.props,
    availableTextures: new Set(textures),
  });

// Old West - VOL 5 - Town Props: MM_MasterMaterial_01a tints its albedo through a mask. The
// instances override `Albedo Color Tint (Base)` (a bright global multiplier) and `Base Color Tint
// (Mask)` (the dark cloth colour). The resolver's exact parameter names missed both, so every
// curtain kept baseColorFactor [1,1,1] and rendered the untinted light-grey albedo.
describe("an instance's tint vector reaches the base-colour factor", () => {
  it("applies a tint whose name carries extra words", () => {
    const resolved = resolve(
      {
        MI_Cloth: {
          mat: "Diffuse=T_Cloth_ALB\n",
          props: instanceProps("MM_Master", [["Diffuse Tint", [0.2, 0.4, 0.6, 1]]]),
        },
      },
      "MI_Cloth",
      ["T_Cloth_ALB"],
    );
    expect(resolved.baseColorFactor).toEqual([0.2, 0.4, 0.6, 1]);
    expect(resolved.bindings.find((binding) => binding.slot === "baseColor")).toMatchObject({
      texture: "T_Cloth_ALB",
      source: "mat",
    });
  });

  it("prefers the mask tint that shows through over the global base multiplier", () => {
    const resolved = resolve(
      {
        MI_Cloth: {
          mat: "Diffuse=T_Cloth_ALB\n",
          props: instanceProps("MM_Master", [
            ["Albedo Color Tint (Base)", [2, 1.75, 1.5, 1]],
            ["Base Color Tint (Mask)", [0.15, 0.17, 0.22, 1]],
          ]),
        },
      },
      "MI_Cloth",
      ["T_Cloth_ALB"],
    );
    expect(resolved.baseColorFactor).toEqual([0.15, 0.17, 0.22, 1]);
  });

  it("leaves a lone mask tint untinted, and ignores a master's mask-tint default", () => {
    // A mask tint without a global multiplier is not a live tint: the 03a curtain's editor mesh
    // thumbnail is the untinted albedo. A master's red `Base Color Tint (Mask)` default is a
    // placeholder, not a colour, so an un-tinted instance keeps no factor.
    const master = {
      MM_Master: {
        mat: "Diffuse=T_Fill_ALB\n",
        props: masterProps([["Base Color Tint (Mask)", [1, 0, 0, 1]]]),
      },
    };
    const lone = resolve(
      {
        MI_Cloth: {
          mat: "Diffuse=T_Cloth_ALB\n",
          props: instanceProps("MM_Master", [["Base Color Tint (Mask)", [0.42, 0.33, 0.29, 1]]]),
        },
        ...master,
      },
      "MI_Cloth",
      ["T_Cloth_ALB", "T_Fill_ALB"],
    );
    expect(lone.baseColorFactor).toBeUndefined();
    const plain = resolve(
      { MI_Crate: { mat: "Diffuse=T_Crate_ALB\n", props: "Parent = Material3'Content/Pack/Materials/MM_Master.MM_Master'\n" }, ...master },
      "MI_Crate",
      ["T_Crate_ALB", "T_Fill_ALB"],
    );
    expect(plain.baseColorFactor).toBeUndefined();
    // Beside the global multiplier the same mask tint IS the surface colour.
    const pair = resolve(
      {
        MI_Cloth: {
          mat: "Diffuse=T_Cloth_ALB\n",
          props: instanceProps("MM_Master", [
            ["Albedo Color Tint (Base)", [2, 1.75, 1.5, 1]],
            ["Base Color Tint (Mask)", [0.15, 0.17, 0.22, 1]],
          ]),
        },
        ...master,
      },
      "MI_Cloth",
      ["T_Cloth_ALB", "T_Fill_ALB"],
    );
    expect(pair.baseColorFactor).toEqual([0.15, 0.17, 0.22, 1]);
  });

  it("does not let a master's default global tint promote a lone mask-tint override", () => {
    // Old West's MI_Curtain_03a overrides only `Base Color Tint (Mask)`; the master's own default
    // `Color` (white) is not an override, so the nearest global tint (white) stays the factor and
    // the albedo is not painted with the mask colour (SM_Curtains_03c fell from 0.53 to 0.13).
    const resolved = resolve(
      {
        MI_Cloth: {
          mat: "Diffuse=T_Cloth_ALB\n",
          props: instanceProps("MM_Master", [["Base Color Tint (Mask)", [0.42, 0.33, 0.29, 1]]]),
        },
        MM_Master: {
          mat: "Diffuse=T_Fill_ALB\n",
          props: masterProps([
            ["Color", [1, 1, 1, 1]],
            ["Base Color Tint (Mask)", [1, 0, 0, 1]],
          ]),
        },
      },
      "MI_Cloth",
      ["T_Cloth_ALB", "T_Fill_ALB"],
    );
    expect(resolved.baseColorFactor).toEqual([1, 1, 1, 1]);
  });
});
