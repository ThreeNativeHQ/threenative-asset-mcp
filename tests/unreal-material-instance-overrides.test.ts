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

// Old West - VOL 5 - Town Props: MM_MasterMaterial_01a declares an `Emissive` texture parameter whose
// default is the neutral TX_Fill_01_ALB, but its UE Viewer `.mat` — the resolved graph — names no
// Emissive output. Binding that default painted every instance with a flat grey emissive that washed
// the dark albedo out to near-white.
describe("a resolved .mat forbids parameter defaults from inventing slots", () => {
  const west = {
    MI_Chair: {
      mat: "Diffuse=TX_Chair_ALB\nNormal=TX_Chair_NRM\nOther[0]=TX_Chair_RMA\nOther[1]=TX_Fill_ALB\nOther[2]=TX_Fill_NRM\nOther[3]=TX_Fill_RMA\n",
      props: instanceProps("MM_Master", [["Albedo", "TX_Chair_ALB"], ["Normal", "TX_Chair_NRM"], ["RMA", "TX_Chair_RMA"]]),
    },
    MM_Master: {
      mat: "Diffuse=TX_Fill_ALB\nNormal=TX_Fill_NRM\nOther[0]=TX_Fill_RMA\n",
      props: masterProps([["Albedo", "TX_Fill_ALB"], ["Emissive", "TX_Fill_ALB"], ["Normal", "TX_Fill_NRM"], ["RMA", "TX_Fill_RMA"]]),
    },
  };
  const available = ["TX_Chair_ALB", "TX_Chair_NRM", "TX_Chair_RMA", "TX_Fill_ALB", "TX_Fill_NRM", "TX_Fill_RMA"];

  it("does not bind a master's Emissive default when the resolved graph names no Emissive slot", () => {
    const resolved = resolve(west, "MI_Chair", available);
    expect(resolved.bindings.find((b) => b.slot === "emissive")).toBeUndefined();
    const bound = resolved.bindings.flatMap((b) => [b.texture, b.secondaryTexture ?? []].flat());
    expect(bound).not.toContain("TX_Fill_ALB");
  });

  it("does not bind a master's Emissive placeholder that is also its replaced Albedo default (modern converter)", () => {
    // The UE5 converter names no slots in the .mat (`Other[n]` only), so the guard above cannot apply.
    // The master fills Albedo and Emissive with one placeholder; the instance replaces Albedo only.
    const resolved = resolve(
      {
        MI_Crate: {
          mat: "Other[0]=TX_Crate_ALB\nOther[1]=TX_Crate_NRM\nOther[2]=TX_Crate_RMA\n",
          props: instanceProps("MM_Master", [["Albedo", "TX_Crate_ALB"], ["Normal", "TX_Crate_NRM"], ["RMA", "TX_Crate_RMA"]]),
        },
        MM_Master: {
          mat: "Other[0]=TX_Fill_NRM\nOther[1]=TX_Fill_ALB\nOther[2]=TX_Fill_ALB\nOther[3]=TX_Fill_RMA\n",
          props: masterProps([["Normal", "TX_Fill_NRM"], ["Albedo", "TX_Fill_ALB"], ["Emissive", "TX_Fill_ALB"], ["RMA", "TX_Fill_RMA"]]),
        },
      },
      "MI_Crate",
      ["TX_Crate_ALB", "TX_Crate_NRM", "TX_Crate_RMA", "TX_Fill_ALB", "TX_Fill_NRM", "TX_Fill_RMA"],
    );
    expect(resolved.bindings.find((b) => b.slot === "emissive")).toBeUndefined();
    expect(resolved.bindings.find((b) => b.slot === "baseColor")).toMatchObject({ texture: "TX_Crate_ALB" });
  });

  it("keeps an Emissive default that no replaced Albedo shares (modern converter)", () => {
    const resolved = resolve(
      {
        MI_Lamp: { mat: "Other[0]=TX_Lamp_ALB\n", props: instanceProps("MM_Master", [["Albedo", "TX_Lamp_ALB"]]) },
        MM_Master: {
          mat: "Other[0]=TX_Fill_ALB\nOther[1]=TX_Glow_E\n",
          props: masterProps([["Albedo", "TX_Fill_ALB"], ["Emissive", "TX_Glow_E"]]),
        },
      },
      "MI_Lamp",
      ["TX_Lamp_ALB", "TX_Fill_ALB", "TX_Glow_E"],
    );
    expect(resolved.bindings.find((b) => b.slot === "emissive")).toMatchObject({ texture: "TX_Glow_E" });
  });

  it("still binds the Emissive the resolved graph actually names", () => {
    const resolved = resolve(
      {
        MI_Lamp: { mat: "Diffuse=TX_Lamp_D\nEmissive=TX_Lamp_E\n", props: masterProps([["Diffuse", "TX_Lamp_D"], ["Emissive", "TX_Lamp_E"]]) },
      },
      "MI_Lamp",
      ["TX_Lamp_D", "TX_Lamp_E"],
    );
    expect(resolved.bindings.find((b) => b.slot === "emissive")).toMatchObject({ texture: "TX_Lamp_E", source: "mat" });
  });

  it("keeps binding a modern-converter material whose .mat names no slot", () => {
    // The UE5 converter writes `Other[n]` references only; props collected is then the sole slot source.
    const resolved = resolve(
      {
        M_UE5: {
          mat: "Other[0]=T_UE5_D\nOther[1]=T_UE5_N\n",
          props: masterProps([["BaseColor", "T_UE5_D"], ["Normal", "T_UE5_N"]]),
        },
      },
      "M_UE5",
      ["T_UE5_D", "T_UE5_N"],
    );
    expect(resolved.bindings.find((b) => b.slot === "baseColor")).toMatchObject({ texture: "T_UE5_D", source: "props" });
    expect(resolved.bindings.find((b) => b.slot === "normal")).toMatchObject({ texture: "T_UE5_N", source: "props" });
  });

  it("still recovers a diffuse the .mat left in Other beside a named slot", () => {
    const resolved = resolve(
      {
        M_Leaf: {
          mat: "Normal=T_Leaf_N\nSpecPower=T_Leaf_S\nOther[0]=T_Leaf_Atlas\n",
          props: masterProps([["Diffuse", "T_Leaf_Atlas"], ["Normal", "T_Leaf_N"]]),
        },
      },
      "M_Leaf",
      ["T_Leaf_Atlas", "T_Leaf_N", "T_Leaf_S"],
    );
    expect(resolved.bindings.find((b) => b.slot === "baseColor")).toMatchObject({ texture: "T_Leaf_Atlas", source: "props" });
  });
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
      { name: "NRM", texture: "T_Wall_Own_N", reference: tex("T_Wall_Own_N") },
      { name: "Color", texture: "T_Wall_Own_D", reference: tex("T_Wall_Own_D") },
    ]);
    expect(parsed.collected).toHaveLength(2);
  });

  it("does not turn a root material's defaults into overrides, nor double count real overrides", () => {
    expect(parsePropsFile(masterProps([["NRM", "T_Wall_Default_N"]])).overrides).toEqual([]);
    const both = `${instanceProps("M_Wall", [["NRM", "T_Wall_Own_N"]])}\n${masterProps([["NRM", "T_Wall_Own_N"]])}`;
    expect(parsePropsFile(both).overrides).toEqual([{ name: "NRM", texture: "T_Wall_Own_N", reference: tex("T_Wall_Own_N") }]);
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

  it("does not take a set's specular or roughness sibling as its colour map", () => {
    // A 5.8 skin instance: its albedo sits behind a parameter with no PBR slot ("Skin Texture"), and the material also
    // references a pore detail set `<stem>_S` / `<stem>_N` / `<stem>_R`. The texture-set fallback bound the pore
    // specular as albedo and painted the head in black spots; leaving base colour unbound lets the graph bake it.
    const resolved = resolve(
      {
        MI_Skin: { mat: "", props: modernInstance("M_Skin", [["Skin Texture", "T_Head_Own_D"]]) },
        M_Skin: { mat: "", props: masterProps([["Skin Texture", "T_Head_Default_D"], ["Pore Spec", "T_Pore__S"], ["Pore Normal", "T_Pore__N"], ["Pore Rough", "T_Pore__R"]]) },
      },
      "MI_Skin",
      ["T_Head_Own_D", "T_Head_Default_D", "T_Pore__S", "T_Pore__N", "T_Pore__R"],
    );
    const base = resolved.bindings.find((b) => b.slot === "baseColor");
    expect(base?.texture).not.toBe("T_Pore__S");
    expect(base?.texture).not.toBe("T_Pore__R");
  });

  it("still completes a texture set whose sibling names no other channel", () => {
    const resolved = resolve(
      { MI_Rock: { mat: "", props: masterProps([["Blend A", "T_Rock_Var"], ["Blend A Normal", "T_Rock_N"]]) } },
      "MI_Rock",
      ["T_Rock_Var", "T_Rock_N"],
    );
    expect(resolved.bindings.find((b) => b.slot === "baseColor")).toMatchObject({ texture: "T_Rock_Var", source: "texture-set" });
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
