import { describe, expect, it } from "vitest";
import * as sourcePackage from "../src/unreal/source-material-package.js";
import * as sourceMaterial from "../src/unreal/source-material.js";
import { bool, fields, float, input, materialPackage, parameter, prop, scalarInput, subsetInstance, subsetMaster } from "./helpers/unreal-material-source.js";
import type { SourceProperty } from "./helpers/unreal-material-source.js";

describe("authored material source subset", () => {
  it("decodes signed exact paths and prunes two switches before reducing AO and scalar roughness", () => {
    const packages = new Map([
      ["/Game/Kit/Master", sourcePackage.decodeMaterialPackage(subsetMaster(), "/Game/Kit/Master")],
      ["/Game/Kit/Instance", sourcePackage.decodeMaterialPackage(subsetInstance(), "/Game/Kit/Instance")],
    ]);
    const result = sourceMaterial.reduceSourceMaterial(packages, "/Game/Kit/Instance.Instance");
    expect(result.channels.Roughness).toEqual({ kind: "scalar", value: 5 });
    expect(result.channels.AmbientOcclusion).toMatchObject({ kind: "texture", path: "/Game/Kit/Packed.Packed", channel: 0, factor: 1 });
    expect(result.limitations.join("\n")).toContain("OpaqueNormal");
    expect(result.limitations.join("\n")).toContain("MSM_TwoSidedFoliage");
    expect(result.limitations.join("\n")).not.toContain("Unselected");
  });

  it("reports unsupported profiles without guessing native inputs", () => {
    expect(sourcePackage.decodeMaterialPackage(materialPackage([{ name: "M", className: "Material", properties: [] }], [], { version: 522 }), "/Game/M")).toMatchObject({ status: "unsupported" });
    expect(sourcePackage.decodeMaterialPackage(materialPackage([{ name: "M", className: "Material", properties: [input("Roughness", 0)] }], [], { core: 1 }), "/Game/M")).toMatchObject({ status: "unsupported" });
    expect(sourcePackage.decodeMaterialPackage(materialPackage([{ name: "M", className: "MaterialInstanceConstant", properties: [prop("Parent", "ObjectProperty", "/Game/Kit/Master")] }], ["/Game/Kit/Master"], { core: 0, framework: 0 }), "/Game/M")).toMatchObject({ status: "decoded" });
  });

  it("retains exact material import classes and paths while keeping mesh bodies opaque", () => {
    const result = sourcePackage.decodeMaterialPackage(materialPackage([{ name: "Mesh", className: "StaticMesh", properties: [float("UninterpretedNativeBody", NaN)] }], ["/Game/Winter/Instance"], { externalClasses: { "/Game/Winter/Instance": "MaterialInstanceConstant" } }), "/Game/Kit/Mesh");
    expect(result.status).toBe("decoded");
    if (result.status !== "decoded") throw new Error("Fixture did not decode");
    expect(result.imports.find((ref) => ref.className === "MaterialInstanceConstant")).toEqual({ index: -2, name: "Instance", className: "MaterialInstanceConstant", path: "/Game/Winter/Instance.Instance" });
    expect(result.exports[0]!.properties).toEqual([]);
  });

  it.each([NaN, Infinity, -Infinity])("rejects nonfinite authored numbers (%s)", (value) => {
    expect(() => sourcePackage.decodeMaterialPackage(materialPackage([{ name: "M", className: "Material", properties: [float("Value", value)] }]), "/Game/M")).toThrow(/finite/);
  });

  it("rejects supported truncated bodies, invalid references and duplicate fields", () => {
    const bytes = subsetMaster();
    expect(() => sourcePackage.decodeMaterialPackage(bytes.subarray(0, bytes.length - 1), "/Game/Kit/Master")).toThrow();
    expect(() => sourcePackage.decodeMaterialPackage(materialPackage([{ name: "M", className: "Material", properties: [input("Roughness", 999)] }]), "/Game/M")).toThrow(/index/);
    expect(() => sourcePackage.decodeMaterialPackage(materialPackage([{ name: "M", className: "Material", properties: [float("R", 1), float("R", 2)] }]), "/Game/M")).toThrow(/duplicate/i);
  });

  it("rejects selected graph cycles and parent namespace misses", () => {
    const bytes = materialPackage([{ name: "M", className: "Material", properties: [input("Roughness", 2)] }, { name: "Cycle", className: "MaterialExpressionReroute", properties: [input("Input", 2)] }]);
    expect(() => sourceMaterial.reduceSourceMaterial(new Map([["/Game/M", sourcePackage.decodeMaterialPackage(bytes, "/Game/M")]]), "/Game/M.M")).toThrow(/cycle/);
    const packages = new Map([["/Game/Other/Master", sourcePackage.decodeMaterialPackage(subsetMaster(), "/Game/Other/Master")], ["/Game/Kit/Instance", sourcePackage.decodeMaterialPackage(subsetInstance(), "/Game/Kit/Instance")]]);
    expect(sourceMaterial.reduceSourceMaterial(packages, "/Game/Kit/Instance.Instance").limitations.join("\n")).toContain("/Game/Kit/Master");
  });

  it("ignores a false static override whose unused Value is not serialized", () => {
    const inactive = parameter("First", false, false).filter((p) => p.name !== "Value");
    const packages = new Map([["/Game/Kit/Master", sourcePackage.decodeMaterialPackage(subsetMaster(), "/Game/Kit/Master")], ["/Game/Kit/Instance", sourcePackage.decodeMaterialPackage(subsetInstance("Instance", 5, "/Game/Kit/Master", [inactive]), "/Game/Kit/Instance")]]);
    expect(sourceMaterial.reduceSourceMaterial(packages, "/Game/Kit/Instance.Instance").channels.Roughness).toEqual({ kind: "scalar", value: 5 });
  });

  it("takes the closest scalar override and only true flagged switch overrides", () => {
    const packages = new Map([["/Game/Kit/Master", sourcePackage.decodeMaterialPackage(subsetMaster(), "/Game/Kit/Master")], ["/Game/Kit/Parent", sourcePackage.decodeMaterialPackage(subsetInstance("Parent", 3), "/Game/Kit/Parent")], ["/Game/Kit/Child", sourcePackage.decodeMaterialPackage(subsetInstance("Child", 0.7, "/Game/Kit/Parent"), "/Game/Kit/Child")]]);
    expect(sourceMaterial.reduceSourceMaterial(packages, "/Game/Kit/Child.Child").channels.Roughness).toEqual({ kind: "scalar", value: expect.closeTo(0.7) });
    packages.set("/Game/Kit/Child", sourcePackage.decodeMaterialPackage(subsetInstance("Child", 0.7, "/Game/Kit/Parent", [parameter("First", false, true)]), "/Game/Kit/Child"));
    const selected = sourceMaterial.reduceSourceMaterial(packages, "/Game/Kit/Child.Child");
    expect(selected.channels.Roughness).toBeUndefined(); expect(selected.limitations.join("\n")).toContain("Unselected");
  });

  it("rejects duplicate object paths and bounds nesting and native nonfinite vector numbers", () => {
    expect(() => sourcePackage.decodeMaterialPackage(materialPackage([{ name: "M", className: "Material", properties: [] }, { name: "M", className: "Material", outer: 0, properties: [] }]), "/Game/M")).toThrow(/duplicate/i);
    let nested = [float("N", 1)]; for (let i = 0; i < 35; i++) nested = [fields("Nested", "MaterialParameterInfo", nested)];
    expect(() => sourcePackage.decodeMaterialPackage(materialPackage([{ name: "M", className: "Material", properties: nested }]), "/Game/M")).toThrow(/depth/i);
    for (const value of [NaN, Infinity, -Infinity]) expect(() => sourcePackage.decodeMaterialPackage(materialPackage([{ name: "M", className: "Material", properties: [prop("V", "StructProperty", [value, 0, 1], { struct: "Vector" })] }]), "/Game/M")).toThrow(/finite/i);
  });

  it("coordinate equality is relative for identical omitted defaults and rejects unresolved descriptors", () => {
    const a = { kind: "implicit" as const, samplerClass: "MaterialExpressionTextureSample" };
    expect(sourceMaterial.sameSourceCoordinates(a, { ...a })).toBe(true);
    expect(sourceMaterial.sameSourceCoordinates(a, { kind: "implicit", samplerClass: "MaterialExpressionTextureSampleParameter2D" })).toBe(false);
    expect(sourceMaterial.sameSourceCoordinates(a, { kind: "explicit", index: 0, u: 1, v: 1 })).toBe(false);
    expect(sourceMaterial.sameSourceCoordinates({ kind: "unresolved", reason: "missing" }, { kind: "unresolved", reason: "missing" })).toBe(false);
  });

  it("active material attributes win and prune stale direct channel cycles", () => {
    const bytes = materialPackage([
      { name: "M", className: "Material", properties: [bool("bUseMaterialAttributes", true), input("MaterialAttributes", 2), input("Roughness", 4)] },
      { name: "Active", className: "MaterialExpressionMakeMaterialAttributes", properties: [input("Roughness", 3)] },
      { name: "Value", className: "MaterialExpressionConstant", properties: [float("R", 0.8)] },
      { name: "InactiveCycle", className: "MaterialExpressionReroute", properties: [input("Input", 4)] },
    ]);
    const result = sourceMaterial.reduceSourceMaterial(new Map([["/Game/M", sourcePackage.decodeMaterialPackage(bytes, "/Game/M")]]), "/Game/M.M");
    expect(result.channels.Roughness).toEqual({ kind: "scalar", value: expect.closeTo(0.8) });
    expect(result.limitations.join("\n")).not.toContain("InactiveCycle");
  });

  it("rejects invalid outputs on supported selected nodes", () => {
    for (const output of [-1, 1, 999]) {
      const bytes = materialPackage([{ name: "M", className: "Material", properties: [input("Roughness", 2, 0, output)] }, { name: "Constant", className: "MaterialExpressionConstant", properties: [float("R", 0.5)] }]);
      expect(() => sourceMaterial.reduceSourceMaterial(new Map([["/Game/M", sourcePackage.decodeMaterialPackage(bytes, "/Game/M")]]), "/Game/M.M")).toThrow(/output/i);
    }
  });

  it("admits the -1 sentinel of a disconnected input (null expression) and retains the raw index with its masks and tag cursor", () => {
    const decoded = sourcePackage.decodeMaterialPackage(materialPackage([{ name: "M", className: "Material", properties: [input("Roughness", 0, 2, -1), float("R", 0.5)] }]), "/Game/M");
    if (decoded.status !== "decoded") throw new Error("Fixture did not decode");
    const [roughness, r] = decoded.exports[0]!.properties;
    expect(roughness).toEqual({ name: "Roughness", type: "StructProperty", arrayIndex: 0, value: { Expression: { index: 0, path: null }, OutputIndex: -1, InputName: "None", Mask: 1, MaskR: 0, MaskG: 0, MaskB: 1, MaskA: 0 } });
    expect(r).toEqual({ name: "R", type: "FloatProperty", arrayIndex: 0, value: 0.5 });
  });

  it("refuses -1 on a connected expression and every other negative index, including -2 on the null expression", () => {
    const constant = { name: "Constant", className: "MaterialExpressionConstant", properties: [float("R", 0.5)] };
    for (const [expression, output] of [[2, -1], [0, -2]] as const) {
      expect(() => sourcePackage.decodeMaterialPackage(materialPackage([{ name: "M", className: "Material", properties: [input("Roughness", expression, undefined, output)] }, constant]), "/Game/M")).toThrow("Invalid source expression output index");
    }
  });

  it("keeps a connected nonnegative output and its masks unchanged", () => {
    const decoded = sourcePackage.decodeMaterialPackage(materialPackage([{ name: "M", className: "Material", properties: [input("Roughness", 2, 0, 0)] }, { name: "Constant", className: "MaterialExpressionConstant", properties: [float("R", 0.5)] }]), "/Game/M");
    if (decoded.status !== "decoded") throw new Error("Fixture did not decode");
    expect(decoded.exports[0]!.properties[0]!.value).toEqual({ Expression: expect.objectContaining({ index: 2, name: "Constant" }), OutputIndex: 0, InputName: "None", Mask: 1, MaskR: 1, MaskG: 0, MaskB: 0, MaskA: 0 });
  });

  it("reduces a disconnected -1 input as unconnected, never as a selected output", () => {
    const bytes = materialPackage([{ name: "M", className: "Material", properties: [input("Roughness", 0, undefined, -1)] }]);
    const result = sourceMaterial.reduceSourceMaterial(new Map([["/Game/M", sourcePackage.decodeMaterialPackage(bytes, "/Game/M")]]), "/Game/M.M");
    expect(result.channels.Roughness).toBeUndefined();
    expect(result.limitations.join("\n")).toContain("Source Roughness: Unconnected source input/class default unresolved");
  });

  it("keeps the constant tail of a disconnected -1 scalar input, which reduces to that constant", () => {
    const bytes = materialPackage([{ name: "M", className: "Material", properties: [scalarInput("Roughness", 0, -1, 0.25)] }]);
    const result = sourceMaterial.reduceSourceMaterial(new Map([["/Game/M", sourcePackage.decodeMaterialPackage(bytes, "/Game/M")]]), "/Game/M.M");
    expect(result.channels.Roughness).toEqual({ kind: "scalar", value: 0.25 });
  });

  it("admits a disconnected -1 function input inside a function call, which reduces as opaque", () => {
    const call = { name: "Call", className: "MaterialExpressionMaterialFunctionCall", properties: [prop("FunctionInputs", "ArrayProperty", [[input("Input", 0, undefined, -1), prop("InputName", "NameProperty", "DamageColor")]], { inner: "StructProperty", struct: "FunctionExpressionInput" })] };
    const bytes = materialPackage([{ name: "M", className: "Material", properties: [input("Roughness", 2)] }, call]);
    const result = sourceMaterial.reduceSourceMaterial(new Map([["/Game/M", sourcePackage.decodeMaterialPackage(bytes, "/Game/M")]]), "/Game/M.M");
    expect(result.channels.Roughness).toBeUndefined();
    expect(result.limitations.join("\n")).toContain("opaque function");
  });

  it("retains valid opaque Break output 24 as unsupported and rejects bad UV outputs", () => {
    const opaque = materialPackage([{ name: "M", className: "Material", properties: [input("PixelDepthOffset", 2, 0, 24)] }, { name: "Break", className: "MaterialExpressionBreakMaterialAttributes", properties: [] }]);
    expect(sourceMaterial.reduceSourceMaterial(new Map([["/Game/M", sourcePackage.decodeMaterialPackage(opaque, "/Game/M")]]), "/Game/M.M").limitations.join("\n")).toContain("output 24");
    const invalid = materialPackage([{ name: "M", className: "Material", properties: [input("AmbientOcclusion", 2, 0, 1)] }, { name: "Sample", className: "MaterialExpressionTextureSample", properties: [prop("Texture", "ObjectProperty", "/Game/Kit/Packed"), input("Coordinates", 3, undefined, 999)] }, { name: "UV", className: "MaterialExpressionTextureCoordinate", properties: [] }], ["/Game/Kit/Packed"]);
    expect(() => sourceMaterial.reduceSourceMaterial(new Map([["/Game/M", sourcePackage.decodeMaterialPackage(invalid, "/Game/M")]]), "/Game/M.M")).toThrow(/output/i);
  });

  describe("a sample's UV set: integer 0..7 where the sample selects it, wired Coordinates first", () => {
    const wired = input("Coordinates", 3);
    const unreadable = (name: string) => prop(name, "StructProperty", [], { struct: "Uninterpreted" });
    /** The UV node (export 3) with CoordinateIndex `index` and its default tiling, minus the property named `omit` when given. */
    const uv = (index: SourceProperty, omit?: string) => [index, prop("UTiling", "FloatProperty", 1), prop("VTiling", "FloatProperty", 1), bool("UnMirrorU", false), bool("UnMirrorV", false)].filter((p) => p.name !== omit);
    /** AmbientOcclusion sampled by the Sample (export 2) with the `sample` pins, reduced from the package. */
    const reduce = (sample: SourceProperty[], uvProperties: SourceProperty[]) =>
      sourceMaterial.reduceSourceMaterial(
        new Map([["/Game/M", sourcePackage.decodeMaterialPackage(materialPackage([
          { name: "M", className: "Material", properties: [input("AmbientOcclusion", 2, 0, 1)] },
          { name: "Sample", className: "MaterialExpressionTextureSample", properties: [prop("Texture", "ObjectProperty", "/Game/Kit/Packed"), ...sample] },
          { name: "UV", className: "MaterialExpressionTextureCoordinate", properties: uvProperties },
        ], ["/Game/Kit/Packed"]), "/Game/M")]]),
        "/Game/M.M",
      );

    it("reads a wired TextureCoordinate's UV sets 0 and 7 as explicit", () => {
      for (const index of [0, 7]) expect(reduce([wired], uv(prop("CoordinateIndex", "IntProperty", index))).channels.AmbientOcclusion).toMatchObject({ coordinates: { kind: "explicit", index, u: 1, v: 1 } });
    });

    it("refuses a wired TextureCoordinate index outside 0..7, as it refuses a negative or fractional one", () => {
      for (const index of [prop("CoordinateIndex", "IntProperty", 8), prop("CoordinateIndex", "IntProperty", -1), prop("CoordinateIndex", "FloatProperty", 1.5)]) {
        expect(() => reduce([wired], uv(index))).toThrow("Invalid source UV index");
      }
    });

    it("keeps an unreadable or incomplete wired TextureCoordinate unresolved", () => {
      expect(reduce([wired], uv(unreadable("CoordinateIndex"))).channels.AmbientOcclusion).toMatchObject({ coordinates: { kind: "unresolved", reason: expect.stringContaining("Source UV defaults unresolved") } });
      expect(reduce([wired], uv(prop("CoordinateIndex", "IntProperty", 2), "UTiling")).channels.AmbientOcclusion).toMatchObject({ coordinates: { kind: "unresolved", reason: expect.stringContaining("Source UV defaults unresolved") } });
    });

    it("never reads a ConstCoordinate that a wired Coordinates ignores, even an unreadable one", () => {
      for (const constant of [unreadable("ConstCoordinate"), prop("ConstCoordinate", "IntProperty", 9)]) {
        expect(reduce([wired, constant], uv(prop("CoordinateIndex", "IntProperty", 2))).channels.AmbientOcclusion).toMatchObject({ coordinates: { kind: "explicit", index: 2, u: 1, v: 1 } });
      }
    });

    it("refuses an unreadable Coordinates pin, whatever its ConstCoordinate says", () => {
      expect(reduce([unreadable("Coordinates"), prop("ConstCoordinate", "IntProperty", 1)], uv(prop("CoordinateIndex", "IntProperty", 0))).channels.AmbientOcclusion).toMatchObject({
        coordinates: { kind: "unresolved", reason: "Source sampler coordinates unsupported" },
      });
    });

    it("reads an unwired sample's ConstCoordinate 7 and refuses 8 or an unreadable one", () => {
      const unwired = (constant: SourceProperty) => reduce([constant], uv(prop("CoordinateIndex", "IntProperty", 0))).channels.AmbientOcclusion;
      expect(unwired(prop("ConstCoordinate", "IntProperty", 7))).toMatchObject({ coordinates: { kind: "explicit", index: 7, u: 1, v: 1 } });
      expect(unwired(prop("ConstCoordinate", "IntProperty", 8))).toMatchObject({ coordinates: { kind: "unresolved" } });
      expect(unwired(unreadable("ConstCoordinate"))).toMatchObject({ coordinates: { kind: "unresolved", reason: "Source sampler coordinates unsupported" } });
    });
  });

  it("refuses a scalar texture output whose mask selects a conflicting channel", () => {
    const bytes = materialPackage([{ name: "M", className: "Material", properties: [input("AmbientOcclusion", 2, 0, 4)] }, { name: "Sample", className: "MaterialExpressionTextureSample", properties: [prop("Texture", "ObjectProperty", "/Game/Kit/Packed")] }], ["/Game/Kit/Packed"]);
    const result = sourceMaterial.reduceSourceMaterial(new Map([["/Game/M", sourcePackage.decodeMaterialPackage(bytes, "/Game/M")]]), "/Game/M.M");
    expect(result.channels.AmbientOcclusion).toBeUndefined(); expect(result.limitations.join("\n")).toContain("output/mask component mismatch");
  });

  it.each([
    [false, "SAMPLERTYPE_LinearColor", "linear"],
    [false, "SAMPLERTYPE_LinearGrayscale", "linear"],
    [false, "SAMPLERTYPE_Masks", "linear"],
    [true, "SAMPLERTYPE_LinearColor", "unresolved"],
    [undefined, "SAMPLERTYPE_LinearColor", "unresolved"],
    [false, undefined, "unresolved"],
    [false, "SAMPLERTYPE_Color", "unresolved"],
  ] as const)("requires explicit linear AO interpretation (SRGB=%s, sampler=%s)", (srgb, samplerType, status) => {
    const bytes = materialPackage([{ name: "M", className: "Material", properties: [input("AmbientOcclusion", 2, 0, 1)] }, { name: "Sample", className: "MaterialExpressionTextureSample", properties: [prop("Texture", "ObjectProperty", "/Game/Kit/Packed"), ...(samplerType ? [prop("SamplerType", "ByteProperty", samplerType, { enum: "EMaterialSamplerType" })] : [])] }], ["/Game/Kit/Packed"]);
    const texture = materialPackage([{ name: "Packed", className: "Texture2D", properties: srgb === undefined ? [] : [bool("SRGB", srgb)] }]);
    const packages = new Map([["/Game/M", sourcePackage.decodeMaterialPackage(bytes, "/Game/M")], ["/Game/Kit/Packed", sourcePackage.decodeMaterialPackage(texture, "/Game/Kit/Packed")]]);
    expect(sourceMaterial.reduceSourceMaterial(packages, "/Game/M.M").channels.AmbientOcclusion).toMatchObject({ kind: "texture", sampling: { status } });
    packages.delete("/Game/Kit/Packed"); packages.set("/Game/Other/Packed", sourcePackage.decodeMaterialPackage(texture, "/Game/Other/Packed"));
    expect(sourceMaterial.reduceSourceMaterial(packages, "/Game/M.M").channels.AmbientOcclusion).toMatchObject({ sampling: { status: "unresolved" } });
  });
});
