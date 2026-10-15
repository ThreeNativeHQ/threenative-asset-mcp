import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { runUnityParity } from "../src/unity/parity.js";
import { srgbToLinear } from "../src/unity/materials.js";
import { renderPreviewPng, writePlainCube } from "./helpers/unity-fidelity.js";
import { scratchDirectory, writeUnityPackage } from "./helpers/unity-fixtures.js";
import { materialYaml, modelImporter, SHADERS, writeCubeFbx } from "./helpers/unity-models.js";
import { describeWithTools } from "./helpers/require-tool.js";

const run = promisify(execFile);

describe("parity:unity without a corpus", () => {
  it("measures nothing, says so, and succeeds", async () => {
    const corpus = await scratchDirectory("unity-parity-empty-");
    const out = await scratchDirectory("unity-parity-out-");
    const lines: string[] = [];
    const outcomes = await runUnityParity({ corpusDir: corpus, outDir: out, log: (line) => lines.push(line) });
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["absent", "absent", "absent"]);
    expect(lines.join("\n")).toMatch(/No corpus: none of U1, U2, U3 found/);
    expect(await readdir(join(out, "sheets"))).toEqual([]);
  });

  it("the npm script exits 0 with the same note when the directory does not exist", async () => {
    const out = await scratchDirectory("unity-parity-out-");
    const { stdout } = await run("npm", ["run", "-s", "parity:unity", "--", "--dir", join(out, "no-corpus"), "--out", join(out, "sweep")], { cwd: process.cwd(), timeout: 60_000 });
    expect(stdout).toMatch(/No corpus: none of U1, U2, U3 found/);
  }, 90_000);
});

describeWithTools(["blender", "chromium"], "parity:unity on a synthetic corpus", () => {
  it("prints structure per pack, writes fidelity.json that the baseline ratchet accepts, and the ratchet fails a drop", async () => {
    const root = await scratchDirectory("unity-parity-corpus-");
    await writeCubeFbx(join(root, "cube.fbx"), ["Wood"]);
    const fbx = await readFile(join(root, "cube.fbx"));
    const scratch = await scratchDirectory("unity-parity-preview-");
    const preview = async (name: string, picked: readonly [number, number, number]): Promise<Buffer> => {
      const glb = join(scratch, `${name}.glb`);
      await writePlainCube(glb, name, [srgbToLinear(picked[0]), srgbToLinear(picked[1]), srgbToLinear(picked[2])]);
      return renderPreviewPng(glb);
    };
    const pack = (model: string, material: string, previewData: Buffer) => [
      { path: "Assets/Models" },
      { path: `Assets/Models/${model}.fbx`, data: fbx, importer: modelImporter(), previewData },
      { path: "Assets/Materials" },
      { path: "Assets/Materials/Wood.mat", content: material },
      { path: "Assets/Prefabs" },
      { path: `Assets/Prefabs/${model}.prefab`, content: "%YAML 1.1\n" },
      { path: `Assets/Prefabs/${model}-variant.prefab`, content: "%YAML 1.1\n" },
    ];
    // U1: a Standard material, R2 previews. U2: a custom shader (fallback), an R1 folder.
    const red = [0.8, 0.2, 0.2] as const;
    const green = [0.2, 0.6, 0.2] as const;
    await mkdir(join(root, "corpus", "U1"), { recursive: true });
    await mkdir(join(root, "corpus", "U2", "reference"), { recursive: true });
    await writeUnityPackage(join(root, "corpus", "U1", "pack.unitypackage"), pack("crate", materialYaml({ name: "Wood", shader: SHADERS.standard, colors: { _Color: [...red, 1] } }), await preview("crate", red)));
    const custom = { guid: "a".repeat(32), fileID: "4800000" };
    await writeUnityPackage(join(root, "corpus", "U2", "pack.unitypackage"), pack("barrel", materialYaml({ name: "Wood", shader: custom, colors: { _Color: [...green, 1] } }), await preview("barrel", [0.1, 0.1, 0.1])));
    // R1 for U2 is the correct green, so a high score can only come from R1 (the package preview is a wrong dark grey).
    await writeFile(join(root, "corpus", "U2", "reference", "barrel.png"), await preview("barrel-r1", green));
    await writeFile(
      join(root, "corpus", "U2", "reference", "bounds.json"),
      JSON.stringify({ version: 1, items: [{ asset: "Assets/Prefabs/barrel.prefab", png: "barrel.png", models: ["Assets/Models/barrel.fbx"], boundsMeters: { size: { x: 1, y: 1, z: 1 } } }] }),
    );

    const out = join(root, "sweep");
    const lines: string[] = [];
    const outcomes = await runUnityParity({ corpusDir: join(root, "corpus"), outDir: out, log: (line) => lines.push(line) });
    const text = lines.join("\n");
    expect(outcomes.map((outcome) => `${outcome.id}:${outcome.status}:${outcome.reference ?? "-"}`)).toEqual(["U1:measured:R2", "U2:measured:R1", "U3:absent:-"]);
    expect(text).toMatch(/U1: prefabs in 2 vs GLBs out 1 \(models in 1\); bound slots 1, unbound 0; textures resolved 0; materials 1; fallback materials 0/);
    expect(text).toMatch(/U2: .*fallback materials 1/);
    expect(text).toMatch(/U2:\s+fallback x1: shader a{32}\/4800000 is not Standard/);
    expect(text).toMatch(/Next: npx tsx scripts\/fidelity-baseline\.ts check/);
    expect(outcomes[0]!.summary?.meanScore).toBeGreaterThanOrEqual(75);
    expect(outcomes[1]!.summary?.meanScore).toBeGreaterThanOrEqual(75);

    const sheet = JSON.parse(await readFile(join(out, "sheets", "U1.json"), "utf8")) as { judge: { fidelity: { score: number } }[] };
    expect(sheet.judge[0]!.fidelity.score).toBeGreaterThanOrEqual(75);
    expect((await readdir(join(out, "U1"))).sort()).toEqual(expect.arrayContaining(["fidelity.json", "reference.json", "sheet.jpg", "import"]));

    // fidelity-baseline.ts: record, accept the same numbers, and refuse a drop.
    const baseline = join(root, "baseline.json");
    const tool = (mode: string) => run("npx", ["tsx", "scripts/fidelity-baseline.ts", mode, out, baseline], { cwd: process.cwd(), timeout: 60_000 });
    expect((await tool("update")).stdout).toMatch(/2 pack\(s\) recorded/);
    expect((await tool("check")).stdout).toMatch(/2 pack\(s\) checked, 2 with a baseline, 0 regression/);
    const dropped = JSON.parse(await readFile(join(out, "sheets", "U1.json"), "utf8")) as { judge: { fidelity: { score: number } }[] };
    for (const piece of dropped.judge) piece.fidelity.score = 20;
    await writeFile(join(out, "sheets", "U1.json"), JSON.stringify(dropped));
    await expect(tool("check")).rejects.toMatchObject({ code: 1, stdout: expect.stringMatching(/REGRESSION U1: mean fidelity/) });
  }, 300_000);
});
