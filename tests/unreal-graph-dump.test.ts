import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { CUE4PARSE_PROGRAM, CUE4PARSE_SOURCE } from "../src/unreal/cue4parse-adapter.js";
import { dumpMaterialGraphs, materialGraphSchema, readMaterialGraph } from "../src/unreal/graph-dump.js";

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tn-graph-dump-test-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function fakeConverter(dir: string, body: string): Promise<string> {
  const path = join(dir, "fake-converter.mjs");
  await writeFile(path, `#!/usr/bin/env node\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

const pin = (node: string, output = 0, mask: number[] | null = null) => ({ node, output, mask });
const NO_OUTPUTS = {
  baseColor: null,
  roughness: null,
  metallic: null,
  emissive: null,
  opacity: null,
  opacityMask: null,
  normal: null,
  materialAttributes: null,
};

/** Hand-written copy of the node shapes in M_Cave_Rock_MASTER: mask channels weighted by tint vectors. */
function maskTintGraph(material = "M_Mask_Tint") {
  const tints = ["Tint", "Tint1", "RockTint", "DetailRockTint"];
  const nodes: Record<string, unknown>[] = [
    {
      id: "n0",
      class: "TextureSampleParameter2D",
      inputs: {},
      constants: {},
      parameter: { name: "Mask", group: "Base" },
      default: null,
      texture: "/Game/Rock/T_Mask",
      samplerType: "Masks",
      coordinates: null,
    },
  ];
  const channels = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
  const products: string[] = [];
  channels.forEach((channelMask, index) => {
    const mask = `n${1 + index * 3}`;
    const tint = `n${2 + index * 3}`;
    const product = `n${3 + index * 3}`;
    products.push(product);
    nodes.push(
      { id: mask, class: "ComponentMask", inputs: { Input: pin("n0", index + 1) }, constants: {}, channelMask },
      {
        id: tint,
        class: "VectorParameter",
        inputs: {},
        constants: {},
        parameter: { name: tints[index], group: "" },
        default: [1, 1, 1, 1],
      },
      { id: product, class: "Multiply", inputs: { A: pin(mask), B: pin(tint, 0, [1, 1, 1, 0]) }, constants: {} },
    );
  });
  nodes.push(
    { id: "n13", class: "Add", inputs: { A: pin(products[0]!), B: pin(products[1]!) }, constants: {} },
    { id: "n14", class: "Add", inputs: { A: pin(products[2]!), B: pin(products[3]!) }, constants: {} },
    { id: "n15", class: "Add", inputs: { A: pin("n13"), B: pin("n14") }, constants: { ConstB: 0 } },
  );
  return {
    format: 1,
    material,
    package: `/Game/Rock/${material}`,
    truncated: false,
    nodeCount: nodes.length,
    outputs: { ...NO_OUTPUTS, baseColor: pin("n15") },
    outputConstants: {},
    nodes,
  };
}

/** A material that calls a function: the call is a node, its inlined body carries a `<callId>/` prefix. */
function functionCallGraph() {
  return {
    format: 1,
    material: "M_Call",
    package: "/Game/Rock/M_Call",
    truncated: false,
    nodeCount: 4,
    outputs: { ...NO_OUTPUTS, baseColor: pin("n0", 0, [1, 1, 1, 0]) },
    nodes: [
      {
        id: "n0",
        class: "BreakMaterialAttributes",
        inputs: { MaterialAttributes: pin("n1") },
        constants: {},
        outputNames: ["BaseColor", "Metallic"],
      },
      {
        id: "n1",
        class: "FunctionCall",
        inputs: { Tint: pin("n2", 0, [1, 1, 1, 0]) },
        constants: {},
        function: "/Game/Rock/MF_Solid_Color",
        fn: { inputs: { Tint: "n2" }, outputs: ["n1/n3"], output: "n1/n3", outputNames: ["Result"] },
      },
      { id: "n2", class: "VectorParameter", inputs: {}, constants: {}, parameter: { name: "RockTint", group: "" }, default: [1, 1, 1, 1] },
      {
        id: "n1/n3",
        class: "FunctionInput",
        inputs: { Input: pin("n2", 0, [1, 1, 1, 0]), Preview: null },
        constants: { InputName: "Tint" },
      },
    ],
  };
}

describe("--dump-graphs converter mode", () => {
  it("is wired into the embedded program and the converter version is bumped", () => {
    expect(CUE4PARSE_PROGRAM).toContain("--dump-graphs");
    expect(CUE4PARSE_PROGRAM).toContain(".graph.json");
    expect(CUE4PARSE_SOURCE.version).toBe("b4e95441+threenative.60");
    // The embedded program prints the same string `canRun` waits for, so a stale binary is rebuilt.
    expect(CUE4PARSE_PROGRAM).toContain(`threenative-cue4parse ${CUE4PARSE_SOURCE.version}`);
  });

  it("finds a function's inputs and outputs in UE5 EditorOnlyData or the package exports, not only FunctionExpressions", () => {
    // Paladin RPG Set (UE 5.8): MF_RGBA_PatternBlend loaded fine but inlined to nothing because UE5.1+ keeps
    // the expression list in EditorOnlyData.ExpressionCollection and the loader only read FunctionExpressions.
    expect(CUE4PARSE_PROGRAM).toContain("GraphFunctionExpressions(function)");
    expect(CUE4PARSE_PROGRAM).toContain('"ExpressionCollection"');
    expect(CUE4PARSE_PROGRAM).toContain('"Expressions"');
    expect(CUE4PARSE_PROGRAM).toContain("function.Owner");
    expect(CUE4PARSE_PROGRAM).not.toContain('GraphProperty(function, "FunctionExpressions")?.Tag?.GenericValue is UScriptArray expressions');
  });

  it("resolves a pack-local function under any content mount by its file name", () => {
    expect(CUE4PARSE_PROGRAM).toContain("GraphLoadFunction(functionIndex");
    expect(CUE4PARSE_PROGRAM).toContain("graphFunctionKeys");
    expect(CUE4PARSE_PROGRAM).toContain('StartsWith("/Engine/"');
  });

  it("re-reads the tagged inputs nested in a function call and in a function output of a pre-4.12 package", () => {
    // Open World Demo Collection (Kite, saved by UE 4.7): CUE4Parse read the nested FExpressionInput of every
    // FunctionInputs element in the native layout, so an engine function call got a pin on itself with a junk mask
    // (the baker saw a "Cycle" and a PivotPainter node), and a pack function's output pin came back Unresolved.
    expect(CUE4PARSE_PROGRAM).toContain("GraphLegacyFunctionInputs(call)");
    expect(CUE4PARSE_PROGRAM).toContain('tag.Name.Text == "FunctionInputs"');
    expect(CUE4PARSE_PROGRAM).toContain("GraphInputValue(outputExpression, \"A\")");
    expect(CUE4PARSE_PROGRAM).toContain("GraphRawArchive(legacy)");
    // A function package is mounted by the call, not by the dump loop, so its file is found by name.
    expect(CUE4PARSE_PROGRAM).toContain("graphPackageKeys[legacy.Name] = located");
  });

  it("reads a native input whose pin name is an FString because the package records no FFrameworkObjectVersion", () => {
    // Open World Demo Collection, UE 4.21 re-saves: CUE4Parse guesses an FName from --engine, reads every mask four bytes off and
    // drops a connected Color/Scalar input, so five foliage materials came back with no BaseColor output at all.
    expect(CUE4PARSE_PROGRAM).toContain("GraphPinsAsString(");
    expect(CUE4PARSE_PROGRAM).toContain("FFrameworkObjectVersion.Type.PinsStoreFName) archive.ReadFName();");
    expect(CUE4PARSE_PROGRAM).toContain("else archive.ReadFString();");
    expect(CUE4PARSE_PROGRAM).toContain("GraphReadNativeInput(archive, legacy)");
    expect(CUE4PARSE_PROGRAM).toContain("GraphRawInputs(material.Owner)");
  });

  it("emits and accepts the attribute GUIDs of Set/GetMaterialAttributes", () => {
    expect(CUE4PARSE_PROGRAM).toContain('"AttributeSetTypes" or "AttributeGetTypes"');
    expect(CUE4PARSE_PROGRAM).toContain('node["attributeTypes"]');
    const graph = materialGraphSchema.parse({
      ...functionCallGraph(),
      nodes: [
        { id: "n0", class: "SetMaterialAttributes", inputs: { "Inputs[0]": null, "Inputs[1]": null }, constants: {}, attributeTypes: ["69B8D33616ED4D499AA497292F050F7A"] },
        { id: "n1", class: "GetMaterialAttributes", inputs: {}, constants: {}, outputNames: ["MaterialAttributes", "Normal"], attributeTypes: ["0FA2821A200F4A4AB719B789C1259C64"] },
      ],
    });
    expect(graph.nodes.map((node) => node.attributeTypes)).toEqual([["69B8D33616ED4D499AA497292F050F7A"], ["0FA2821A200F4A4AB719B789C1259C64"]]);
  });

  it("accepts a graph shaped like the Cave Rock master and keeps all four tint parameters reachable", () => {
    const graph = materialGraphSchema.parse(maskTintGraph());
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const reachable = new Set<string>();
    const walk = (id: string) => {
      if (reachable.has(id)) return;
      reachable.add(id);
      for (const input of Object.values(byId.get(id)?.inputs ?? ({} as Record<string, { node: string } | null>))) if (input) walk(input.node);
    };
    walk(graph.outputs.baseColor!.node);
    const parameters = [...reachable].map((id) => byId.get(id)?.parameter?.name).filter(Boolean);
    expect(parameters).toEqual(expect.arrayContaining(["Mask", "Tint", "Tint1", "RockTint", "DetailRockTint"]));
    expect(byId.get("n1")?.channelMask).toEqual([1, 0, 0, 0]);
    expect(graph.outputConstants).toEqual({});
  });

  it("accepts a named reroute pair and keeps the declaration reachable through the usage", () => {
    const graph = materialGraphSchema.parse({
      format: 1,
      material: "M_Reroute",
      package: "/Game/Test/M_Reroute",
      truncated: false,
      nodeCount: 3,
      outputs: { ...NO_OUTPUTS, baseColor: pin("n0") },
      nodes: [
        { id: "n0", class: "NamedRerouteUsage", inputs: { Input: pin("n1") }, constants: { DeclarationGuid: "0b0a0e0f-0000-0000-0000-000000000001" } },
        { id: "n1", class: "NamedRerouteDeclaration", inputs: { Input: pin("n2") }, constants: { Name: "Albedo" } },
        { id: "n2", class: "Constant3Vector", inputs: {}, constants: { Constant: [1, 0, 0, 1] } },
        { id: "n3", class: "NamedRerouteUsage", inputs: {}, constants: {}, error: "named reroute declaration could not be found" },
      ],
    });
    expect(graph.nodes[0]?.inputs.Input).toEqual({ node: "n1", output: 0, mask: null });
    expect(graph.nodes[3]?.error).toMatch(/declaration/);
  });

  it("pins the C# named reroute handling in the embedded program", () => {
    expect(CUE4PARSE_PROGRAM).toContain('"NamedRerouteUsage"');
    expect(CUE4PARSE_PROGRAM).toContain('"NamedRerouteDeclaration"');
    expect(CUE4PARSE_PROGRAM).toContain('"Declaration"');
    expect(CUE4PARSE_PROGRAM).toContain('"DeclarationGuid"');
    expect(CUE4PARSE_PROGRAM).toContain("named reroute declaration could not be found");
  });

  it("accepts function calls with inlined nodes and legacy defaults", () => {
    const graph = materialGraphSchema.parse(functionCallGraph());
    expect(graph.nodes.find((node) => node.id === "n1")?.fn?.output).toBe("n1/n3");
    expect(graph.outputConstants).toEqual({});
  });

  it.each([
    ["an unknown format version", (g: Record<string, unknown>) => ({ ...g, format: 2 })],
    ["a node with no class", (g: Record<string, unknown>) => ({ ...g, nodes: [{ id: "n0", inputs: {}, constants: {} }] })],
    [
      "a mask that is not four channels",
      (g: Record<string, unknown>) => ({ ...g, outputs: { ...(g.outputs as object), baseColor: { node: "n15", output: 0, mask: [1, 1, 1] } } }),
    ],
    ["a missing output slot", (g: Record<string, unknown>) => ({ ...g, outputs: { baseColor: null } })],
    ["an unexpected top-level key", (g: Record<string, unknown>) => ({ ...g, surprise: true })],
    [
      "an unexpected node key",
      (g: Record<string, unknown>) => ({ ...g, nodes: [{ id: "n0", class: "Add", inputs: {}, constants: {}, surprise: 1 }] }),
    ],
  ])("rejects %s", (_name, mutate) => {
    expect(materialGraphSchema.safeParse(mutate(maskTintGraph() as unknown as Record<string, unknown>)).success).toBe(false);
  });

  it("returns every graph the converter writes and passes argv through", async () => {
    const dir = await scratch();
    const argvLog = join(dir, "argv.json");
    const second = { ...maskTintGraph("M_Second"), package: "/Game/Other/M_Second" };
    const converter = await fakeConverter(
      dir,
      `import { writeFileSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(argv));
const out = argv[argv.indexOf("--dump-graphs") + 1];
writeFileSync(join(out, "M_First.graph.json"), ${JSON.stringify(JSON.stringify(maskTintGraph("M_First")))});
writeFileSync(join(out, "M_Second.graph.json"), ${JSON.stringify(JSON.stringify(second))});
writeFileSync(join(out, "ignored.txt"), "not a graph");`,
    );
    const graphs = await dumpMaterialGraphs("/some/source", { converterPath: converter, engine: "4.18", filter: "M_First" });
    expect([...graphs.keys()]).toEqual(["M_First", "M_Second"]);
    expect(graphs.get("M_First")?.nodes).toHaveLength(16);
    const argv = JSON.parse(await readFile(argvLog, "utf8")) as string[];
    expect(argv[0]).toBe("/some/source");
    expect(argv[1]).toBe("--dump-graphs");
    expect(argv.slice(3)).toEqual(["--engine", "4.18", "--filter", "M_First"]);
  });

  it("removes its scratch directory and returns an empty map when no material is found", async () => {
    const dir = await scratch();
    const outLog = join(dir, "out-dir.txt");
    const converter = await fakeConverter(
      dir,
      `import { writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
writeFileSync(${JSON.stringify(outLog)}, argv[argv.indexOf("--dump-graphs") + 1]);`,
    );
    const graphs = await dumpMaterialGraphs("/some/source", { converterPath: converter });
    expect(graphs.size).toBe(0);
    const scratchDir = await readFile(outLog, "utf8");
    await expect(readdir(scratchDir)).rejects.toThrow(/ENOENT/);
  });

  it("rejects clearly when the converter exits non-zero", async () => {
    const dir = await scratch();
    const converter = await fakeConverter(dir, `console.error("boom: package unreadable"); process.exit(3);`);
    await expect(dumpMaterialGraphs("/some/source", { converterPath: converter })).rejects.toThrow(/exit 3.*boom/s);
  });

  it("rejects clearly when a graph file is malformed or has the wrong shape", async () => {
    const dir = await scratch();
    const bad = join(dir, "M_Bad.graph.json");
    await writeFile(bad, "{ not json");
    await expect(readMaterialGraph(bad)).rejects.toThrow(/M_Bad\.graph\.json is not valid JSON/);
    await writeFile(bad, JSON.stringify({ format: 1 }));
    await expect(readMaterialGraph(bad)).rejects.toThrow(/unexpected shape/);
  });

  it("accepts every shape the converter can emit, including an unresolved node and string parameter defaults", () => {
    const graph = materialGraphSchema.parse({
      ...maskTintGraph("M_Emitted"),
      nodes: [
        // BuildMaterialGraph's Pin(): an expression that failed to load carries only id, class and error.
        { id: "n0", class: "Unresolved", error: "expression could not be loaded" },
        // GraphValue() can return a string (FName / string DefaultValue), and an input index is whatever the package stores.
        { id: "n1", class: "FontSampleParameter", inputs: { A: { node: "n0", output: -1, mask: null } }, constants: { Name: "x" }, parameter: { name: "F", group: "" }, default: "Roboto" },
        { id: "n2", class: "TextureCoordinate", inputs: {}, constants: {}, tiling: [2, 0.5] },
        { id: "n3", class: "StaticSwitchParameter", inputs: { A: null, B: null }, constants: {}, parameter: { name: "S", group: "" }, default: false, switchValue: true },
        { id: "n4", class: "FunctionCall", inputs: { In: null }, constants: {}, function: null, fn: { inputs: { In: null }, outputs: [null], output: null }, error: "material function could not be loaded" },
      ],
    });
    expect(graph.nodes[0]).toMatchObject({ inputs: {}, constants: {} });
    expect(graph.nodes[1]?.default).toBe("Roboto");
  });

  describe("one bad graph must not lose the others", () => {
    const converterWriting = async (dir: string, files: Record<string, string>): Promise<string> =>
      fakeConverter(
        dir,
        `import { writeFileSync } from "node:fs";
import { join } from "node:path";
const out = process.argv[process.argv.indexOf("--dump-graphs") + 1];
for (const [name, text] of Object.entries(${JSON.stringify(files)})) writeFileSync(join(out, name), text);`,
      );
    const withNullOutput = () => {
      const graph = maskTintGraph("M_Null") as unknown as { nodes: Array<{ inputs: Record<string, unknown> }> };
      // The reported Agora shape: a null where the schema wants a number, deep inside the node list.
      graph.nodes[12]!.inputs.A = { node: "n1", output: null, mask: null };
      return graph;
    };

    it("skips an invalid graph, keeps the good ones, and records a short readable reason", async () => {
      const dir = await scratch();
      const converter = await converterWriting(dir, {
        "M_Good.graph.json": JSON.stringify(maskTintGraph("M_Good")),
        "M_Null.graph.json": JSON.stringify(withNullOutput()),
        "M_Torn.graph.json": "{ not json",
        "M_AlsoGood.graph.json": JSON.stringify(maskTintGraph("M_AlsoGood")),
      });
      const graphs = await dumpMaterialGraphs("/some/source", { converterPath: converter });
      expect([...graphs.keys()]).toEqual(["M_AlsoGood", "M_Good"]);
      expect([...(graphs.invalid ?? new Map()).keys()].sort()).toEqual(["M_Null", "M_Torn"]);
      const reason = graphs.invalid?.get("M_Null") ?? "";
      expect(reason).toMatch(/^nodes\[12\]\.inputs\.A\.output: /);
      expect(reason).toMatch(/number/);
      expect(reason.length).toBeLessThanOrEqual(200);
      expect(graphs.invalid?.get("M_Torn")).toMatch(/not valid JSON/);
      expect((graphs.invalid?.get("M_Torn") ?? "").length).toBeLessThanOrEqual(200);
    });

    it("returns an empty graph map plus every reason when all graphs are invalid", async () => {
      const dir = await scratch();
      const converter = await converterWriting(dir, {
        "M_One.graph.json": JSON.stringify({ format: 1, material: "M_One" }),
        "M_Two.graph.json": JSON.stringify(withNullOutput()),
      });
      const graphs = await dumpMaterialGraphs("/some/source", { converterPath: converter });
      expect(graphs.size).toBe(0);
      expect(graphs.invalid?.size).toBe(2);
    });

    it("readMaterialGraph reports a short reason, not a zod dump", async () => {
      const dir = await scratch();
      const bad = join(dir, "M_Null.graph.json");
      await writeFile(bad, JSON.stringify(withNullOutput()));
      const message = await readMaterialGraph(bad).then(
        () => "",
        (error: Error) => error.message,
      );
      expect(message).toMatch(/unexpected shape: nodes\[12\]\.inputs\.A\.output: /);
      expect(message.length).toBeLessThan(300);
    });
  });
});
