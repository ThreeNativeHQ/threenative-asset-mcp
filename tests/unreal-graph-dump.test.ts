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
    expect(CUE4PARSE_SOURCE.version).toBe("b4e95441+threenative.54");
    // The embedded program prints the same string `canRun` waits for, so a stale binary is rebuilt.
    expect(CUE4PARSE_PROGRAM).toContain(`threenative-cue4parse ${CUE4PARSE_SOURCE.version}`);
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
});
