import { describe, expect, it } from "vitest";
import sharp from "sharp";

import { applyTextureTransform } from "../src/unreal/importer.js";
import { resolveMaterial } from "../src/unreal/materials.js";
import { blankTileWarnings } from "../src/unreal/parity-run.js";

/** Shaped like the temperate grass library: a masked master, instances with a `Tint` of A=0 and an opacity map. */
const MASTER_PROPS = [
  "BlendMode = BLEND_Masked (1)",
  "OpacityMaskClipValue = 0.333",
  "CollectedVectorParameters[1] =",
  "{",
  "    CollectedVectorParameters[0] =",
  "    {",
  "        Value = { R=1, G=1, B=1, A=0 }",
  "        Name = Tint",
  "        Group = 1 Material Parameters",
  "    }",
  "}",
].join("\n");

const INSTANCE_PROPS = "Parent = Material3'Content/Pack/Materials/MA_Grass.MA_Grass'\nVectorParameterValues[0] = {}\n";

const resolve = (
  mats: Record<string, { mat?: string; props?: string }>,
  textures: string[],
  name = "Grass_Mat",
) =>
  resolveMaterial({
    name,
    readMat: (material) => mats[material]?.mat,
    readProps: (material) => mats[material]?.props,
    availableTextures: new Set(textures),
  });

const grass = (instanceMat: string, masterMat = "Diffuse=Grass_Albedo\n") => ({
  Grass_Mat: { mat: instanceMat, props: INSTANCE_PROPS },
  MA_Grass: { mat: masterMat, props: MASTER_PROPS },
});

describe("a colour parameter's alpha is not opacity", () => {
  it("keeps a masked section drawable when its Tint has A=0", () => {
    const resolved = resolve(grass("Diffuse=Grass_Albedo\n"), ["Grass_Albedo"]);
    expect(resolved.alphaMode).toBe("MASK");
    expect(resolved.baseColorFactor).toEqual([1, 1, 1, 1]);
  });

  it("keeps a partial colour alpha as before", () => {
    const props = INSTANCE_PROPS.replace("VectorParameterValues[0] = {}", "VectorParameterValues[0] = { ParameterInfo={ Name=Tint }, ParameterValue={ R=0.5,G=0.5,B=0.5,A=0.5 } }");
    const resolved = resolve({ ...grass("Diffuse=Grass_Albedo\n"), Grass_Mat: { mat: "Diffuse=Grass_Albedo\n", props } }, ["Grass_Albedo"]);
    expect(resolved.baseColorFactor).toEqual([0.5, 0.5, 0.5, 0.5]);
  });

  it("still honours an opacity scalar parameter", () => {
    const props = [
      INSTANCE_PROPS,
      "ScalarParameterValues[1] =",
      "{",
      "    ScalarParameterValues[0] =",
      "    {",
      "        ParameterInfo = { Name=Opacity }",
      "        ParameterValue = 0.4",
      "    }",
      "}",
    ].join("\n");
    const resolved = resolve({ ...grass("Diffuse=Grass_Albedo\n"), Grass_Mat: { mat: "Diffuse=Grass_Albedo\n", props } }, ["Grass_Albedo"]);
    expect(resolved.baseColorFactor?.[3]).toBeCloseTo(0.4);
  });
});

describe("a separate opacity map becomes the base colour's alpha", () => {
  it("binds an `Other` named *_Opacity_* on a masked material", () => {
    const resolved = resolve(grass("Diffuse=Grass_Albedo\nOther[0]=Grass_Opacity_8k\n"), ["Grass_Albedo", "Grass_Opacity_8k"]);
    expect(resolved.bindings.find((b) => b.slot === "baseColor")).toMatchObject({
      texture: "Grass_Albedo",
      secondaryTexture: "Grass_Opacity_8k",
      transform: "redToBaseColorAlpha",
      confidence: "heuristic",
    });
    expect(resolved.unsupported.map((u) => u.texture)).not.toContain("Grass_Opacity_8k");
  });

  it("binds the `Opacity=` slot of a parent material", () => {
    const resolved = resolve(grass("Diffuse=Grass_Albedo\n", "Diffuse=Grass_Albedo\nOpacity=Grass_Opacity_8k\n"), ["Grass_Albedo", "Grass_Opacity_8k"]);
    expect(resolved.bindings.find((b) => b.slot === "baseColor")).toMatchObject({ secondaryTexture: "Grass_Opacity_8k", transform: "redToBaseColorAlpha" });
  });

  it("leaves an opaque material and an opacity that is the colour texture itself alone", () => {
    const opaque = resolve(
      { Grass_Mat: { mat: "Diffuse=Grass_Albedo\nOther[0]=Grass_Opacity_8k\n", props: "Parent = Material3'Content/Pack/Materials/MA_Plain.MA_Plain'\n" }, MA_Plain: { props: "BlendMode = BLEND_Opaque (0)\n" } },
      ["Grass_Albedo", "Grass_Opacity_8k"],
    );
    expect(opaque.alphaMode).toBe("OPAQUE");
    expect(opaque.bindings.find((b) => b.slot === "baseColor")).toMatchObject({ transform: "none" });
    expect(opaque.bindings.find((b) => b.slot === "baseColor")?.secondaryTexture).toBeUndefined();

    const own = resolve(grass("Diffuse=Grass_Albedo\nOpacity=Grass_Albedo\n"), ["Grass_Albedo"]);
    expect(own.bindings.find((b) => b.slot === "baseColor")?.secondaryTexture).toBeUndefined();
  });

  it("does not bind an opacity map the pack did not export", () => {
    const resolved = resolve(grass("Diffuse=Grass_Albedo\nOther[0]=Grass_Opacity_8k\n"), ["Grass_Albedo"]);
    expect(resolved.bindings.find((b) => b.slot === "baseColor")?.secondaryTexture).toBeUndefined();
  });
});

describe("redToBaseColorAlpha composes opacity maps of another resolution", () => {
  const png = (width: number, height: number, rgb: [number, number, number]) =>
    sharp({ create: { width, height, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toBuffer();

  it("resizes a same-aspect mask to the colour and uses its red channel as alpha", async () => {
    const colour = await png(4, 4, [10, 200, 30]);
    const mask = await png(16, 16, [0, 255, 255]);
    const out = await applyTextureTransform(colour, "redToBaseColorAlpha", undefined, mask);
    const { data, info } = await sharp(out.data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([4, 4]);
    expect([data[0], data[1], data[2], data[3]]).toEqual([10, 200, 30, 0]);
  });

  it("refuses a mask with another aspect ratio", async () => {
    await expect(applyTextureTransform(await png(4, 4, [1, 2, 3]), "redToBaseColorAlpha", undefined, await png(8, 4, [255, 255, 255]))).rejects.toThrow(/dimensions/);
  });
});

describe("blank tiles beside an Unreal thumbnail are recorded as warnings", () => {
  const tile = (name: string, reasons: string[]) => ({ name, reasons });
  it("names the blank pieces when the sheet had thumbnails", () => {
    const warnings = blankTileWarnings([tile("a", ["blank: nothing drawn"]), tile("b", []), tile("c", ["blank: nothing drawn"])], 3);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("2 of 3");
    expect(warnings[0]).toContain("a, c");
  });
  it("stays silent without thumbnails or without blank tiles", () => {
    expect(blankTileWarnings([tile("a", ["blank: nothing drawn"])], 0)).toEqual([]);
    expect(blankTileWarnings([tile("a", ["speck: object covers only 1%"])], 1)).toEqual([]);
  });
});
