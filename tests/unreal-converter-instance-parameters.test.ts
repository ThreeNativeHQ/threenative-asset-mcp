import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { describeWithTools } from "./helpers/require-tool.js";
import {
  buildConverterProgram,
  convertPackages,
  dumpGraphsOfPackages,
  runMaterialOverrideHarness,
  type ConverterBuild,
  type ConverterRun,
  type GraphDumpRun,
  type MaterialOverrideHarnessRun,
} from "./helpers/material-overrides-harness.js";
import { fields, float, materialPackage, parameter, prop, type SourceProperty } from "./helpers/unreal-material-source.js";
import { CUE4PARSE_ENGINE_CONTENT, CUE4PARSE_PROGRAM, CUE4PARSE_SOURCE } from "../src/unreal/cue4parse-adapter.js";
import { parsePropsFile, resolveMaterial } from "../src/unreal/materials.js";

// An editor-saved UE5.3 MaterialInstanceConstant: CUE4Parse's typed `TextureParameterValues` came back empty while the
// tagged property held every override, so the converter wrote an empty `CollectedTextureParameters` block and the
// importer bound the parent's defaults (a flat default normal map) to every Megascans prop of a 5.3 pack.
const PARENT_PROPS = `BlendMode = BLEND_Opaque
TwoSided = false
OpacityMaskClipValue = 0.333
CollectedTextureParameters[2] =
{
    CollectedTextureParameters[0] =
    {
        Texture = Texture2D'T_Default_Gray.T_Default_Gray'
        Name = RMF
        Group = None
    }
    CollectedTextureParameters[1] =
    {
        Texture = Texture2D'T_Default_N.T_Default_N'
        Name = NORMAL
        Group = None
    }
}
`;
const instanceProps = (parameters: readonly (readonly [string, string])[]): string =>
  `Parent = Material'M_Master.M_Master'
BlendMode = BLEND_Opaque
OpacityMaskClipValue = 0.3333
CollectedTextureParameters[${parameters.length}] =
{
${parameters
  .map(
    ([name, texture], index) => `    CollectedTextureParameters[${index}] =
    {
        Texture = Texture2D'${texture}.${texture}'
        Name = ${name}
        Group = None
    }`,
  )
  .join("\n")}
}
`;

function resolveInstance(parameters: readonly (readonly [string, string])[]) {
  const props: Record<string, string> = { MI_Prop: instanceProps(parameters), M_Master: PARENT_PROPS };
  const mat: Record<string, string> = {
    MI_Prop: parameters.map(([, texture], index) => `Other[${index}]=${texture}`).join("\n") + "\n",
    M_Master: "Other[0]=T_Default_Gray\nOther[1]=T_Default_N\n",
  };
  return resolveMaterial({
    name: "MI_Prop",
    readMat: (name) => mat[name],
    readProps: (name) => props[name],
    availableTextures: new Set(["T_Prop_A", "T_Prop_N", "T_Prop_R", "T_Default_Gray", "T_Default_N"]),
  });
}

describe("converter: a material instance's texture overrides", () => {
  it("reads the tagged TextureParameterValues too, not only CUE4Parse's typed array (converter 62)", () => {
    expect(CUE4PARSE_SOURCE.version).toBe("b4e95441+threenative.584.8");
    const exporter = CUE4PARSE_PROGRAM.slice(CUE4PARSE_PROGRAM.indexOf("async Task ExportMaterialAsync"));
    expect(exporter).toContain('instance.GetOrDefault<FStructFallback[]>("TextureParameterValues")');
  });

  it("binds the instance's own normal map once the overrides are written, and the parent's default without them", () => {
    const written = resolveInstance([["ALBEDO", "T_Prop_A"], ["NORMAL", "T_Prop_N"], ["RMF", "T_Prop_R"]]);
    expect(written.bindings.find((binding) => binding.slot === "normal")?.texture).toBe("T_Prop_N");
    const empty = resolveInstance([]);
    expect(empty.bindings.find((binding) => binding.slot === "normal")?.texture).toBe("T_Default_N");
  });
});

// The converter program itself, compiled against the installed CUE4Parse. Each case feeds synthetic rows to the compiled
// MaterialOverrides.Blocks, and the text it writes is read back through the importer's own props parser.
describeWithTools(["modern-converter"], "material instance overrides, emitted by the compiled converter", () => {
  let directory = "";
  let run: MaterialOverrideHarnessRun | undefined;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "tn-material-overrides-"));
    run = await runMaterialOverrideHarness(CUE4PARSE_PROGRAM, CUE4PARSE_ENGINE_CONTENT, directory);
  }, 900_000);

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  const harness = (): MaterialOverrideHarnessRun => {
    if (!run) throw new Error("the harness did not run");
    return run;
  };
  const emitted = (name: string) => {
    const result = harness().cases[name];
    if (result?.text === undefined) throw new Error(`${name} did not emit text: ${JSON.stringify(result ?? null)}`);
    return parsePropsFile(result.text);
  };
  const refusal = (name: string): string => {
    const result = harness().cases[name];
    if (result?.refused === undefined) throw new Error(`${name} was not refused: ${JSON.stringify(result ?? null)}`);
    return result.refused;
  };

  it("compiles against the installed CUE4Parse assembly", () => {
    expect(harness().build.code, harness().build.output).toBe(0);
  });

  it("keeps scalar zero, negative and exponent values", () => {
    expect(emitted("scalar-values").scalarOverrides).toEqual([
      { name: "Zero", value: 0 },
      { name: "Negative", value: -0.25 },
      { name: "Tiny", value: 0.00001 },
    ]);
  });

  it("keeps vector zero channels", () => {
    expect(emitted("vector-channels").vectorOverrides).toEqual([{ name: "Tint", value: [0, 0.5, 0, 1] }]);
  });

  it("writes numbers with a point, whatever the host culture", () => {
    expect(emitted("invariant-culture").scalarOverrides).toEqual([
      { name: "Half", value: 0.5 },
      { name: "Negative", value: -0.25 },
    ]);
  });

  it("lets a child's override of false beat the parent's true", () => {
    expect(emitted("false-beats-parent").switchOverrides).toEqual([{ name: "UseDetail", value: false }]);
  });

  it("leaves a disabled switch row to inherit, and writes nothing for it", () => {
    expect(emitted("disabled-row-inherits").switchOverrides).toEqual([{ name: "Enabled", value: true }]);
  });

  it("reads StaticParametersRuntime when StaticParameters is absent", () => {
    expect(emitted("runtime-set").switchOverrides).toEqual([{ name: "FromRuntime", value: true }]);
  });

  it("writes no override blocks when the tags are absent and the read completed", () => {
    expect(harness().cases["complete-absent"]?.text).toBe("");
  });

  it("refuses the material when a collection is absent and the read did not complete", () => {
    expect(refusal("failed-read-absent")).toContain("did not read completely");
  });

  it("refuses an absent texture collection the read did not complete for, as the scalar rows are", () => {
    expect(refusal("texture-failed-read-absent")).toMatch(/TextureParameterValues is absent and the material did not read completely/);
  });

  it("writes no texture block for an absent collection the read completed", () => {
    expect(harness().cases["texture-absent-read-completed"]?.text).toBe("");
  });

  it("refuses a declared texture collection it cannot read, though a typed fallback could hold rows", () => {
    expect(refusal("texture-declared-unreadable")).toMatch(/TextureParameterValues is present but its rows cannot be read/);
  });

  it("refuses typed texture rows that have no declared tag to prove their identity", () => {
    expect(refusal("texture-typed-only")).toContain("no declared tag");
  });

  it("refuses a texture row whose layer identity cannot be written as a global one", () => {
    expect(refusal("texture-layer")).toContain("LayerParameter");
  });

  it("refuses a texture row without an association, rather than admitting its name", () => {
    expect(refusal("texture-association-missing")).toContain("no Association tag");
  });

  it("refuses an authored null texture rather than inheriting the parent's without a source proof", () => {
    expect(refusal("texture-authored-null")).toContain("authored null");
  });

  it("refuses the texture rows of a material whose read did not complete, though the rows read", () => {
    expect(refusal("texture-failed-read-present")).toContain("did not read completely");
  });

  it("refuses a scalar row without ParameterValue instead of reading it as 0", () => {
    expect(refusal("scalar-absent")).toContain("no ParameterValue tag");
  });

  it("refuses a ParameterValue that cannot be read instead of reading it as 0", () => {
    expect(refusal("scalar-unreadable")).toContain("cannot be read as");
  });

  it("refuses a switch row without bOverride instead of inheriting it", () => {
    expect(refusal("switch-no-override-flag")).toContain("no bOverride tag");
  });

  it("refuses a non-finite value", () => {
    expect(refusal("non-finite")).toContain("non-finite");
  });

  it("keeps a parameter name that contains commas whole", () => {
    expect(emitted("comma-name").scalarOverrides).toEqual([{ name: "true = leaf, false = trunk", value: 1 }]);
  });

  it("refuses a name the blocks cannot carry", () => {
    expect(refusal("brace-name")).toContain("cannot carry");
  });

  it("refuses a layer parameter rather than collapsing it onto a global name", () => {
    expect(refusal("layer")).toContain("LayerParameter");
  });

  it("refuses a global row that carries a layer index", () => {
    expect(refusal("layer-index")).toContain("index");
  });

  it("reads a legacy ParameterName row as a global name", () => {
    expect(emitted("legacy-name").scalarOverrides).toEqual([{ name: "LegacyName", value: 2 }]);
  });

  it("refuses two rows with one identity", () => {
    expect(refusal("collision")).toContain("collides");
  });

  it("writes each global row's association and index into its block", () => {
    expect(harness().cases["scalar-values"]?.text).toContain("        Association = GlobalParameter\n        Index = -1\n");
  });

  it("writes a tagged row's expression GUID", () => {
    expect(harness().cases["tagged-guid"]?.text).toMatch(/ExpressionGUID = [0-9A-Fa-f-]{32,36}/);
  });

  it("writes a completed binary switch's false value rather than refusing the set", () => {
    expect(emitted("binary-completed-false").switchOverrides).toEqual([{ name: "UseDetail", value: false }]);
  });

  it("leaves a disabled binary switch to inherit, and writes nothing for it", () => {
    expect(harness().cases["binary-disabled-inherits"]?.text).toBe("");
  });

  it("writes a binary row's expression GUID", () => {
    expect(harness().cases["binary-guid"]?.text).toMatch(/ExpressionGUID = [0-9A-Fa-f-]{32,36}/);
  });

  it("refuses binary switches when the material did not read completely", () => {
    const message = refusal("binary-failed-read");
    expect(message).toContain("binary");
    expect(message).toContain("did not read completely");
  });
});

// The converter compiled alone and run on synthetic packages, so a refused override is exercised through the export loop, the
// completion check and the exit status, not only through the blocks writer.
// A ParameterInfo struct as the editor writes it: a name, an association and an index.
const info = (name: string, association = "GlobalParameter", index = -1): SourceProperty =>
  fields("ParameterInfo", "MaterialParameterInfo", [
    prop("Name", "NameProperty", name),
    prop("Association", "ByteProperty", association, { enum: "EMaterialParameterAssociation" }),
    prop("Index", "IntProperty", index),
  ]);
const scalarArray = (rows: SourceProperty[][]): SourceProperty =>
  prop("ScalarParameterValues", "ArrayProperty", rows, { inner: "StructProperty", struct: "ScalarParameterValue" });
const layerInstance = (): Buffer =>
  materialPackage([
    { name: "MI_Layer", className: "MaterialInstanceConstant", properties: [scalarArray([[info("Roughness", "LayerParameter", 0), float("ParameterValue", 0.5)]])] },
  ]);
const validInstance = (): Buffer =>
  materialPackage(
    [
      {
        name: "MI_Valid",
        className: "MaterialInstanceConstant",
        properties: [
          scalarArray([[info("Roughness"), float("ParameterValue", 0.25)]]),
          prop("TextureParameterValues", "ArrayProperty", [[info("Albedo"), prop("ParameterValue", "ObjectProperty", "/Game/Textures/T_Keep")]], {
            inner: "StructProperty",
            struct: "TextureParameterValue",
          }),
          fields("StaticParameters", "StaticParameterSet", [
            prop("StaticSwitchParameters", "ArrayProperty", [parameter("Enabled", true, false)], { inner: "StructProperty", struct: "StaticSwitchParameter" }),
          ]),
        ],
      },
    ],
    ["/Game/Textures/T_Keep"],
  );
// A CurveFloat with no keys: a successful structured-data export (Data/*.json), the sibling a refusal must not hide behind.
// No StaticMesh fixture here is one CUE4Parse reads as a mesh, so a data export stands in for the mesh success.
const curveAsset = (): Buffer =>
  materialPackage([
    { name: "Curve", className: "CurveFloat", properties: [prop("FloatCurves", "ArrayProperty", [], { inner: "StructProperty", struct: "RichCurve" })] },
  ]);
// A scalar row whose ParameterValue is a name, which cannot be read as a float.
const unreadableInstance = (): Buffer =>
  materialPackage([
    { name: "MI_Unreadable", className: "MaterialInstanceConstant", properties: [scalarArray([[info("Roughness"), prop("ParameterValue", "NameProperty", "oops")]])] },
  ]);
const EXPORT_CASES: Readonly<Record<string, Readonly<Record<string, Buffer>>>> = {
  "layer-only": { "Game/Materials/MI_Layer.uasset": layerInstance() },
  "valid-and-layer": { "Game/Materials/MI_Valid.uasset": validInstance(), "Game/Materials/MI_Layer.uasset": layerInstance() },
  "data-and-layer": { "Game/Curves/Curve.uasset": curveAsset(), "Game/Materials/MI_Layer.uasset": layerInstance() },
  "data-and-unreadable": { "Game/Curves/Curve.uasset": curveAsset(), "Game/Materials/MI_Unreadable.uasset": unreadableInstance() },
  "valid-only": { "Game/Materials/MI_Valid.uasset": validInstance() },
};

describeWithTools(["modern-converter"], "material export: a refused override fails the conversion", () => {
  let directory = "";
  let build: ConverterBuild | undefined;
  const runs: Record<string, ConverterRun> = {};

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "tn-material-export-"));
    build = await buildConverterProgram(CUE4PARSE_PROGRAM, CUE4PARSE_ENGINE_CONTENT, join(directory, "build"));
    if (build.code !== 0) return;
    for (const [name, packages] of Object.entries(EXPORT_CASES)) runs[name] = await convertPackages(build, join(directory, name), packages);
  }, 900_000);

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  const runFor = (name: string): ConverterRun => {
    const result = runs[name];
    if (!result) throw new Error(`${name} did not run; the build exited ${build?.code}: ${build?.output ?? ""}`);
    return result;
  };

  it("compiles the converter program", () => {
    expect(build?.code, build?.output).toBe(0);
  });

  it("fails the conversion when a material has a layer override", () => {
    const run = runFor("layer-only");
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("/Game/Materials/MI_Layer.MI_Layer");
  });

  it("writes neither sidecar of the refused material", () => {
    const { files } = runFor("layer-only");
    expect(files).not.toContain("Materials/MI_Layer.mat");
    expect(files).not.toContain("Materials/MI_Layer.props.txt");
  });

  it("keeps a valid sibling's output when another material is refused", async () => {
    const run = runFor("valid-and-layer");
    expect(run.code).not.toBe(0);
    expect(run.files).toEqual(expect.arrayContaining(["Materials/MI_Valid.mat", "Materials/MI_Valid.props.txt"]));
    expect(run.files).not.toContain("Materials/MI_Layer.mat");
    expect(run.files).not.toContain("Materials/MI_Layer.props.txt");
    expect(await readFile(join(run.output, "Materials", "MI_Valid.mat"), "utf8")).toContain("Other[0]=T_Keep");
    expect(await readFile(join(run.output, "Materials", "MI_Valid.props.txt"), "utf8")).toContain("Name = Roughness");
  });

  it("fails the conversion when a material has an unreadable override row, beside a successful data export", () => {
    const run = runFor("data-and-unreadable");
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("/Game/Materials/MI_Unreadable.MI_Unreadable");
    expect(run.files).toContain("Data/Curve.json");
    expect(run.files).not.toContain("Materials/MI_Unreadable.mat");
    expect(run.files).not.toContain("Materials/MI_Unreadable.props.txt");
  });

  it("does not let a successful data export hide a refused material", () => {
    const run = runFor("data-and-layer");
    expect(run.code).not.toBe(0);
    expect(run.files).toContain("Data/Curve.json");
    expect(run.files).not.toContain("Materials/MI_Layer.mat");
    expect(run.files).not.toContain("Materials/MI_Layer.props.txt");
    expect(run.stderr).toContain("/Game/Materials/MI_Layer.MI_Layer");
  });

  it("converts a valid instance cleanly, and its disabled switch row inherits", async () => {
    const run = runFor("valid-only");
    expect(run.code, run.stderr).toBe(0);
    expect(run.files).toContain("Materials/MI_Valid.props.txt");
    expect(parsePropsFile(await readFile(join(run.output, "Materials", "MI_Valid.props.txt"), "utf8")).switchOverrides).toEqual([]);
  });
});

// Converter 77. A package saved by UE4 lists every custom version it used, so a UE5 version missing from its list names a field its
// engine never wrote. With --engine 5.1 CUE4Parse guessed both UE5 versions from the game and read the two cached-data bools of every
// such package: the first as 0, the second as the 77 below ("Invalid bool value"). A package that lists them still has both bools.
const UE5_MAIN = [0x697dd581, 0xe64f41ab, 0xaa4a51ec, 0xbeb7b628];
const UE5_RELEASE = [0xd89b5e42, 0x24bd4d46, 0x8412aca8, 0xdf641779];
// The gate values: MaterialSavedCachedData in FUE5MainStreamObjectVersion, MaterialInterfaceSavedCachedData in FUE5ReleaseStreamObjectVersion.
const UE5_LISTED = [{ guid: UE5_MAIN, version: 36 }, { guid: UE5_RELEASE, version: 14 }];
const savedByUe4 = (name: string, roughness: number, listed: boolean, bools: number[]): Buffer =>
  materialPackage(
    [{ name, className: "MaterialInstanceConstant", properties: [scalarArray([[info("Roughness"), float("ParameterValue", roughness)]])], trailing: bools }],
    [],
    { customVersions: listed ? UE5_LISTED : [] },
  );
const absentPackage = (name: string): Buffer => savedByUe4(name, 0.25, false, [0, 77]);
const listedPackage = (name: string): Buffer => savedByUe4(name, 0.75, true, [0, 0]);
// The converter loads packages in the host's directory-listing order, which is not alphabetical. Both cases keep the same two paths in
// the same creation order and swap the packages, so whichever path the host lists first, each load order happens once.
const CUSTOM_VERSION_CASES: Readonly<Record<string, Readonly<Record<string, Buffer>>>> = {
  "absent-at-x": { "Game/Materials/MI_X.uasset": absentPackage("MI_X"), "Game/Materials/MI_Y.uasset": listedPackage("MI_Y") },
  "listed-at-x": { "Game/Materials/MI_X.uasset": listedPackage("MI_X"), "Game/Materials/MI_Y.uasset": absentPackage("MI_Y") },
  "listed-invalid": { "Game/Materials/MI_Listed77.uasset": savedByUe4("MI_Listed77", 0.5, true, [0, 77]) },
};

describeWithTools(["modern-converter"], "material export: a UE4 package that lists no UE5 custom version", () => {
  let directory = "";
  let build: ConverterBuild | undefined;
  const runs: Record<string, ConverterRun> = {};

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "tn-custom-versions-"));
    build = await buildConverterProgram(CUE4PARSE_PROGRAM, CUE4PARSE_ENGINE_CONTENT, join(directory, "build"));
    if (build.code !== 0) return;
    for (const [name, packages] of Object.entries(CUSTOM_VERSION_CASES)) runs[name] = await convertPackages(build, join(directory, name), packages, "5.1");
  }, 900_000);

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  const runFor = (name: string): ConverterRun => {
    const result = runs[name];
    if (!result) throw new Error(`${name} did not run; the build exited ${build?.code}: ${build?.output ?? ""}`);
    return result;
  };
  const roughness = async (run: ConverterRun, asset: string) =>
    parsePropsFile(await readFile(join(run.output, "Materials", `${asset}.props.txt`), "utf8")).scalarOverrides;

  it("compiles the converter program", () => {
    expect(build?.code, build?.output).toBe(0);
  });

  it.each([
    ["absent-at-x", "MI_X", "MI_Y"],
    ["listed-at-x", "MI_Y", "MI_X"],
  ])("reads each package by its own custom versions in one root (%s)", async (name, absent, listed) => {
    const run = runFor(name);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stderr + run.stdout).not.toContain("Invalid bool value");
    expect(await roughness(run, absent)).toEqual([{ name: "Roughness", value: 0.25 }]);
    expect(await roughness(run, listed)).toEqual([{ name: "Roughness", value: 0.75 }]);
  });

  it("still reads both bools of a package that lists the versions, so a 77 there is refused", () => {
    const run = runFor("listed-invalid");
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("/Game/Materials/MI_Listed77.MI_Listed77");
    expect(run.stderr).toContain("Invalid bool value (77)");
    expect(run.files).not.toContain("Materials/MI_Listed77.props.txt");
  });
});

// Converter 74: --dump-graphs writes a qualified record for every material instance it loads, beside the Material graphs. A record
// holds the instance's own overrides (MaterialOverrides.Blocks for scalars, vectors and static switches, its own texture overrides by
// qualified package and object) and its qualified parent. A flattened CollectedTextureParameters block never enters a record, and a
// refused instance is recorded as refused with its reason, never dropped.
const chainMaster = (): Buffer => materialPackage([{ name: "M_Master", className: "Material", properties: [] }]);
const chainMid = (): Buffer =>
  materialPackage(
    [
      {
        name: "MI_Mid",
        className: "MaterialInstanceConstant",
        properties: [
          prop("Parent", "ObjectProperty", "/Game/Chain/M_Master"),
          scalarArray([[info("Roughness"), float("ParameterValue", 0)]]),
          prop("VectorParameterValues", "ArrayProperty", [[info("Tint"), prop("ParameterValue", "StructProperty", [0, 0.5, 0, 1], { struct: "LinearColor" })]], {
            inner: "StructProperty",
            struct: "VectorParameterValue",
          }),
          prop("TextureParameterValues", "ArrayProperty", [[info("Albedo"), prop("ParameterValue", "ObjectProperty", "/Game/Textures/T_Keep")]], {
            inner: "StructProperty",
            struct: "TextureParameterValue",
          }),
          fields("StaticParameters", "StaticParameterSet", [
            prop("StaticSwitchParameters", "ArrayProperty", [parameter("UseDetail", false, true), parameter("Disabled", true, false)], {
              inner: "StructProperty",
              struct: "StaticSwitchParameter",
            }),
          ]),
        ],
      },
    ],
    ["/Game/Chain/M_Master", "/Game/Textures/T_Keep"],
    { externalClasses: { "/Game/Chain/M_Master": "Material" } },
  );
const chainChild = (): Buffer =>
  materialPackage(
    [{ name: "MI_Child", className: "MaterialInstanceConstant", properties: [prop("Parent", "ObjectProperty", "/Game/Chain/MI_Mid"), scalarArray([[info("Metal"), float("ParameterValue", 0.5)]])] }],
    ["/Game/Chain/MI_Mid"],
    { externalClasses: { "/Game/Chain/MI_Mid": "MaterialInstanceConstant" } },
  );
const namesakeInstance = (): Buffer =>
  materialPackage([{ name: "MI_Mid", className: "MaterialInstanceConstant", properties: [scalarArray([[info("Metal"), float("ParameterValue", 0.9)]])] }]);
const duplicateInstance = (): Buffer =>
  materialPackage([{ name: "MI_Dup", className: "MaterialInstanceConstant", properties: [scalarArray([[info("Metal"), float("ParameterValue", 0.1)]])] }]);
const CHAIN_PACKAGES: Readonly<Record<string, Buffer>> = {
  "Content/Chain/M_Master.uasset": chainMaster(),
  "Content/Chain/MI_Mid.uasset": chainMid(),
  "Content/Chain/MI_Child.uasset": chainChild(),
  "Content/Chain/MI_Layer.uasset": layerInstance(),
  "Content/Chain/MI_Unreadable.uasset": unreadableInstance(),
  "Content/Other/MI_Mid.uasset": namesakeInstance(),
  "Content/Chain/MI_Dup.uasset": duplicateInstance(),
  "Mirror/Content/Chain/MI_Dup.uasset": duplicateInstance(),
};

describeWithTools(["modern-converter"], "instance records from --dump-graphs, emitted by the compiled converter", () => {
  let directory = "";
  let build: ConverterBuild | undefined;
  let dump: GraphDumpRun | undefined;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "tn-instance-records-"));
    build = await buildConverterProgram(CUE4PARSE_PROGRAM, CUE4PARSE_ENGINE_CONTENT, join(directory, "build"));
    if (build.code !== 0) return;
    dump = await dumpGraphsOfPackages(build, join(directory, "chain"), CHAIN_PACKAGES);
  }, 900_000);

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  const dumped = (): GraphDumpRun => {
    if (!dump) throw new Error("the converter did not run");
    return dump;
  };
  const records = (): Record<string, unknown>[] =>
    Object.entries(dumped().files)
      .filter(([name]) => name.endsWith(".instance.json"))
      .map(([, text]) => JSON.parse(text) as Record<string, unknown>);
  const recordOf = (object: string, packagePath = `/Game/Chain/${object}`): Record<string, unknown> => {
    const found = records().filter((record) => record.object === object && record.package === packagePath);
    if (found.length !== 1) throw new Error(`expected one record for ${packagePath}.${object}, found ${found.length}`);
    return found[0]!;
  };

  it("compiles the converter program", () => {
    expect(build?.code).toBe(0);
  });

  it("writes the Material graph beside one record for every instance it loads", () => {
    expect(dumped().code).toBe(0);
    expect(dumped().files["M_Master.graph.json"]).toBeDefined();
    expect(records().map((record) => record.object).sort()).toEqual(["MI_Child", "MI_Dup", "MI_Dup", "MI_Layer", "MI_Mid", "MI_Mid", "MI_Unreadable"]);
  });

  it("records an instance's own scalar zero, vector channels and inherited static switch", () => {
    const mid = recordOf("MI_Mid");
    expect(mid).toMatchObject({ kind: "materialInstance", complete: true, parent: { package: "/Game/Chain/M_Master", object: "M_Master" } });
    const props = parsePropsFile(String(mid.props));
    expect(props.scalarOverrides).toEqual([{ name: "Roughness", value: 0 }]);
    expect(props.vectorOverrides).toEqual([{ name: "Tint", value: [0, 0.5, 0, 1] }]);
    // A disabled row (bOverride false) inherits and writes nothing; the enabled false is kept.
    expect(props.switchOverrides).toEqual([{ name: "UseDetail", value: false }]);
  });

  it("qualifies its parent and its own texture override, and never writes a flattened collection", () => {
    const mid = recordOf("MI_Mid");
    expect(String(mid.props)).toContain("Parent = Material'/Game/Chain/M_Master.M_Master'");
    expect(String(mid.props)).not.toContain("CollectedTextureParameters");
    const props = parsePropsFile(String(mid.props));
    expect(props.overrides).toEqual([expect.objectContaining({ name: "Albedo", texture: "T_Keep" })]);
    expect(props.overrides[0]?.reference).toContain("/Game/Textures/T_Keep");
  });

  it("records a child's own override and its qualified intermediate parent, not the parent's values", () => {
    const child = recordOf("MI_Child");
    expect(child).toMatchObject({ complete: true, parent: { package: "/Game/Chain/MI_Mid", object: "MI_Mid" } });
    const props = parsePropsFile(String(child.props));
    expect(props.scalarOverrides).toEqual([{ name: "Metal", value: 0.5 }]);
    expect(props.switchOverrides).toEqual([]);
    expect(props.overrides).toEqual([]);
  });

  it("refuses a layer parameter and an unreadable row, each as a refused record with its reason", () => {
    const layer = recordOf("MI_Layer");
    expect(layer).toMatchObject({ complete: false, props: null });
    expect(String(layer.refusal)).toMatch(/only global parameters/);
    const unreadable = recordOf("MI_Unreadable");
    expect(unreadable).toMatchObject({ complete: false, props: null });
    expect(String(unreadable.refusal).length).toBeGreaterThan(0);
  });

  it("keeps a namesake in another package under its own identity", () => {
    const namesake = recordOf("MI_Mid", "/Game/Other/MI_Mid");
    expect(namesake).toMatchObject({ complete: true, parent: null });
    expect(parsePropsFile(String(namesake.props)).scalarOverrides).toEqual([{ name: "Metal", value: 0.9 }]);
  });

  it("writes both records of a duplicate identity, for the importer to refuse", () => {
    const duplicates = records().filter((record) => record.object === "MI_Dup");
    expect(duplicates).toHaveLength(2);
    expect(duplicates.map((record) => record.package)).toEqual(["/Game/Chain/MI_Dup", "/Game/Chain/MI_Dup"]);
  });
});

// Texture overrides as the record writer reads them. Packages of their own, so the chain fixtures above keep their records.
const textureArray = (rows: SourceProperty[][]): SourceProperty =>
  prop("TextureParameterValues", "ArrayProperty", rows, { inner: "StructProperty", struct: "TextureParameterValue" });
const TEXTURE_PACKAGES: Readonly<Record<string, Buffer>> = {
  "Content/Textures/MI_Layered.uasset": materialPackage(
    [{ name: "MI_Layered", className: "MaterialInstanceConstant", properties: [textureArray([[info("Albedo", "LayerParameter", 0), prop("ParameterValue", "ObjectProperty", "/Game/Textures/T_Keep")]])] }],
    ["/Game/Textures/T_Keep"],
  ),
  "Content/Textures/MI_Global.uasset": materialPackage(
    [{ name: "MI_Global", className: "MaterialInstanceConstant", properties: [textureArray([[info("Albedo"), prop("ParameterValue", "ObjectProperty", "/Game/Textures/T_Keep")]])] }],
    ["/Game/Textures/T_Keep"],
  ),
  "Content/Textures/MI_Unreadable.uasset": materialPackage([
    { name: "MI_Unreadable", className: "MaterialInstanceConstant", properties: [prop("TextureParameterValues", "NameProperty", "oops")] },
  ]),
};

describeWithTools(["modern-converter"], "instance texture overrides, from --dump-graphs by the compiled converter", () => {
  let directory = "";
  let dump: GraphDumpRun | undefined;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "tn-instance-textures-"));
    const build = await buildConverterProgram(CUE4PARSE_PROGRAM, CUE4PARSE_ENGINE_CONTENT, join(directory, "build"));
    if (build.code !== 0) return;
    dump = await dumpGraphsOfPackages(build, join(directory, "textures"), TEXTURE_PACKAGES);
  }, 900_000);

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  const recordOf = (object: string): Record<string, unknown> => {
    if (!dump) throw new Error("the converter did not run");
    const found = Object.entries(dump.files)
      .filter(([name]) => name.endsWith(".instance.json"))
      .map(([, text]) => JSON.parse(text) as Record<string, unknown>)
      .filter((record) => record.object === object);
    if (found.length !== 1) throw new Error(`expected one record for ${object}, found ${found.length}`);
    return found[0]!;
  };

  it("keeps a global texture override's qualified texture", () => {
    expect(recordOf("MI_Global")).toMatchObject({ complete: true, props: expect.stringContaining("Texture2D'/Game/Textures/T_Keep.T_Keep'") });
  });

  it("writes a global texture override's association and index into its block", () => {
    expect(recordOf("MI_Global").props).toContain("        Association = GlobalParameter\n        Index = -1\n");
  });

  it("refuses a layered texture override instead of writing it as a global one", () => {
    expect(recordOf("MI_Layered")).toMatchObject({ complete: false, refusal: expect.stringContaining("LayerParameter") });
  });

  it("refuses a declared texture collection it cannot read", () => {
    expect(recordOf("MI_Unreadable")).toMatchObject({ complete: false, refusal: expect.stringContaining("cannot be read") });
  });
});
