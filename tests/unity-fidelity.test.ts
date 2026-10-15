import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { swapRedBlue } from "../src/unreal/package-thumbnail.js";
import {
  type R1Bounds,
  type UnityFidelityResult,
  checkSize,
  UNITY_RIG_LIGHTNESS_GAIN,
  UNITY_RIG_SATURATION_GAIN,
  compensatePreviewRig,
  decideChannelOrder,
  inspectPng,
  isMissingShaderPink,
  runUnityFidelity,
  summaryLine,
} from "../src/unity/fidelity.js";
import { importUnityPackage } from "../src/unity/importer.js";
import { srgbToLinear } from "../src/unity/materials.js";
import { type SyntheticPiece, renderPreviewPng, writePlainCube, writeSyntheticImport } from "./helpers/unity-fidelity.js";
import { type FixtureFile, runScript, scratchDirectory, writeUnityPackage } from "./helpers/unity-fixtures.js";
import { SHADERS, materialYaml, modelImporter, writeCubeFbx } from "./helpers/unity-models.js";
import { describeWithTools } from "./helpers/require-tool.js";

const RED = [0.6, 0.05, 0.05] as const;
const GREEN = [0.05, 0.5, 0.1] as const;
const ORANGE = [0.7, 0.25, 0.02] as const;
const BLUE = [0.05, 0.1, 0.7] as const;
const LIME = [0.2, 0.8, 0.2] as const;

/** What the Editor would have shown for each piece: the *correct* colour, rendered. */
async function previews(pieces: readonly SyntheticPiece[]): Promise<Map<string, Buffer>> {
  const scratch = await scratchDirectory("unity-fidelity-preview-");
  const found = new Map<string, Buffer>();
  for (const piece of pieces) {
    const glb = join(scratch, `${piece.name}.glb`);
    await writePlainCube(glb, piece.name, piece.factor, piece.size);
    found.set(piece.name, await renderPreviewPng(glb));
  }
  return found;
}

/** A package whose models carry the given preview pictures, and an import folder for the (possibly wrong) pieces. */
async function setup(imported: readonly SyntheticPiece[], preview: ReadonlyMap<string, Buffer>) {
  const root = await scratchDirectory("unity-fidelity-");
  const packagePath = join(root, "synthetic.unitypackage");
  const files: FixtureFile[] = [
    { path: "Assets/Models" },
    ...imported.map((piece) => ({
      path: piece.source ?? `Assets/Models/${piece.name}.fbx`,
      content: "fake fbx",
      ...(preview.has(piece.name) ? { previewData: preview.get(piece.name)! } : {}),
    })),
  ];
  await writeUnityPackage(packagePath, files);
  const importDir = join(root, "import");
  await writeSyntheticImport(importDir, imported);
  return { root, packagePath, importDir };
}

const scoreOf = (result: UnityFidelityResult, name: string): number => {
  const piece = result.pieces.find((candidate) => candidate.name === name);
  expect(piece?.fidelity?.comparable, `${name} is compared`).toBe(true);
  return piece!.fidelity!.score;
};

describe("size check", () => {
  const unit = { x: 1, y: 2, z: 0.5 };
  it("accepts up to 1 % per axis and flags more", () => {
    expect(checkSize(unit, unit).ok).toBe(true);
    expect(checkSize({ x: 1.009, y: 2, z: 0.5 }, unit).ok).toBe(true);
    const off = checkSize({ x: 1, y: 2.03, z: 0.5 }, unit);
    expect(off.ok).toBe(false);
    expect(off.worst).toBeCloseTo(0.015, 3);
  });
  it("keeps a 1 mm floor so a flat piece does not divide by zero", () => {
    expect(checkSize({ x: 1, y: 1, z: 0.0005 }, { x: 1, y: 1, z: 0 }).ok).toBe(false);
    expect(checkSize({ x: 1, y: 1, z: 0 }, { x: 1, y: 1, z: 0 }).ok).toBe(true);
  });
});

describe("R2 channel order decision", () => {
  const swapped = { asDecoded: 40, swapped: 95 };
  const fine = { asDecoded: 92, swapped: 55 };
  it("swaps only on overwhelming, consistent evidence", () => {
    expect(decideChannelOrder([swapped, swapped, swapped]).order).toBe("bgr");
    expect(decideChannelOrder([swapped, swapped, swapped, fine]).order).toBe("bgr");
  });
  it("never swaps on a single wrong piece, too few pieces, or a mostly fine pack", () => {
    expect(decideChannelOrder([swapped]).order).toBe("rgb");
    expect(decideChannelOrder([swapped, swapped]).order).toBe("rgb");
    expect(decideChannelOrder([swapped, fine, fine]).order).toBe("rgb");
    expect(decideChannelOrder([fine, fine, fine]).order).toBe("rgb");
  });
  it("does not rescue a swap that stays imperfect", () => {
    expect(decideChannelOrder(Array(4).fill({ asDecoded: 30, swapped: 55 })).order).toBe("rgb");
  });
});

describe("fidelity sheet against R2 previews", () => {
  const pieces: SyntheticPiece[] = [
    { name: "crate", factor: RED },
    { name: "barrel", factor: GREEN },
    { name: "lamp", factor: ORANGE },
  ];

  it("R2 compensates Unity's dimmer, greyer preview rig by default, and not when asked", async () => {
    // Previews as Unity's rig would draw these pieces: the render, with saturation and lightness taken down by the fixed gains.
    const dimmed = new Map<string, Buffer>();
    for (const [name, png] of await previews(pieces)) {
      dimmed.set(name, await compensatePreviewRig(png, { saturation: 1 / UNITY_RIG_SATURATION_GAIN, lightness: 1 / UNITY_RIG_LIGHTNESS_GAIN }));
    }
    const { packagePath, importDir, root } = await setup(pieces, dimmed);
    const compensated = await runUnityFidelity({ importDir, packagePath, out: join(root, "out"), tile: 160 });
    const raw = await runUnityFidelity({ importDir, packagePath, out: join(root, "out-raw"), tile: 160, compensate: false });
    expect(compensated.summary.meanScore ?? 0).toBeGreaterThanOrEqual(80);
    expect(compensated.summary.meanScore ?? 0).toBeGreaterThan((raw.summary.meanScore ?? 0) + 10);
  }, 120_000);

  it("scores an import against the package preview, and a wrong base colour drops below 70", async () => {
    const correct = await previews(pieces);
    // The lamp imports blue where the Editor preview shows orange.
    const imported = pieces.map((piece) => (piece.name === "lamp" ? { ...piece, factor: BLUE } : piece));
    const { packagePath, importDir, root } = await setup(imported, correct);
    const result = await runUnityFidelity({ importDir, packagePath, out: join(root, "out"), tile: 160, compensate: false });

    expect(result.reference).toBe("R2");
    expect(scoreOf(result, "crate")).toBeGreaterThanOrEqual(85);
    expect(scoreOf(result, "barrel")).toBeGreaterThanOrEqual(85);
    expect(scoreOf(result, "lamp")).toBeLessThan(70);
    expect(result.pieces.find((piece) => piece.name === "lamp")?.verdict).not.toBe("ok");
    expect(result.pieces.find((piece) => piece.name === "crate")?.verdict).toBe("ok");
    expect(result.channelOrder?.order).toBe("rgb");
    expect(result.unmatched).toEqual([]);
    expect((await stat(result.sheet)).size).toBeGreaterThan(2000);
    const written = JSON.parse(await readFile(join(root, "out", "reference.json"), "utf8")) as { reference: string };
    expect(written.reference).toBe("R2");
    expect(result.previewInspection).toHaveLength(3);
    expect(result.previewInspection[0]).toMatchObject({ srgbChunk: false, iccProfile: false });
  }, 120_000);

  it("a package whose previews are stored red/blue swapped is detected from the scores and re-scored", async () => {
    // Orange, red and a second warm piece: every hue moves when red and blue are exchanged (green would not).
    const warm: SyntheticPiece[] = [
      { name: "crate", factor: RED },
      { name: "lamp", factor: ORANGE },
      { name: "rope", factor: [0.5, 0.35, 0.02] },
    ];
    const correct = await previews(warm);
    const stored = new Map<string, Buffer>();
    for (const [name, png] of correct) stored.set(name, await swapRedBlue(png));
    const { packagePath, importDir, root } = await setup(warm, stored);
    const result = await runUnityFidelity({ importDir, packagePath, out: join(root, "out"), tile: 160, compensate: false });

    expect(result.channelOrder?.order).toBe("bgr");
    expect(result.referenceNote).toMatch(/swapped/);
    for (const piece of warm) expect(scoreOf(result, piece.name)).toBeGreaterThanOrEqual(85);
  }, 120_000);

  it("one wrong piece among correct previews is never rescued by a swap", async () => {
    const correct = await previews(pieces);
    const imported = pieces.map((piece) => (piece.name === "crate" ? { ...piece, factor: LIME } : piece));
    const { packagePath, importDir, root } = await setup(imported, correct);
    const result = await runUnityFidelity({ importDir, packagePath, out: join(root, "out"), tile: 160, compensate: false });
    expect(result.channelOrder?.order).toBe("rgb");
    expect(scoreOf(result, "crate")).toBeLessThan(70);
  }, 120_000);

  it("records the PNG's gamma and colour-profile chunks without applying them", () => {
    const png = Buffer.concat([
      Buffer.from("89504e470d0a1a0a", "hex"),
      chunk("IHDR", Buffer.from("0000000200000002080600000000", "hex").subarray(0, 13)),
      chunk("gAMA", Buffer.from([0, 0, 0xb1, 0x8f])),
      chunk("sRGB", Buffer.from([0])),
      chunk("IEND", Buffer.alloc(0)),
    ]);
    expect(inspectPng(png)).toMatchObject({ width: 2, height: 2, bitDepth: 8, colorType: 6, srgbChunk: true, iccProfile: false });
    expect(inspectPng(png)?.gamma).toBeCloseTo(0.45455, 4);
    expect(inspectPng(Buffer.from("not a png at all, just text bytes......"))).toBeUndefined();
  });
});

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, data, Buffer.alloc(4)]);
}

describe("fidelity sheet scores prefabs against prefab previews", () => {
  // A model's own Editor preview is a grey default-material render, a prefab's preview carries its materials' colours.
  const grey = [0.2, 0.2, 0.2] as const;
  const pieces: SyntheticPiece[] = [
    { name: "crate", factor: grey, prefabFactor: RED },
    { name: "barrel", factor: grey, prefabFactor: GREEN },
    { name: "lamp", factor: grey, prefabFactor: ORANGE },
  ];

  /** A package whose models preview grey and whose prefabs preview in the colour each piece really has. */
  async function prefabSetup(imported: readonly SyntheticPiece[]) {
    const greyPreviews = await previews(pieces.map((piece) => ({ name: piece.name, factor: grey })));
    const colourPreviews = await previews(pieces.map((piece) => ({ name: piece.name, factor: piece.prefabFactor! })));
    const root = await scratchDirectory("unity-fidelity-prefab-");
    const packagePath = join(root, "synthetic.unitypackage");
    await writeUnityPackage(packagePath, [
      { path: "Assets/Models" },
      { path: "Assets/Prefabs" },
      ...pieces.flatMap((piece) => [
        { path: `Assets/Models/${piece.name}.fbx`, content: "fake fbx", previewData: greyPreviews.get(piece.name)! },
        { path: `Assets/Prefabs/${piece.name}.prefab`, content: "fake prefab", previewData: colourPreviews.get(piece.name)! },
      ]),
    ]);
    const importDir = join(root, "import");
    await writeSyntheticImport(importDir, imported);
    return { root, packagePath, importDir };
  }

  it("a wrong prefab colour is caught: the grey model-level pair cannot hide it", async () => {
    const imported = pieces.map((piece) => (piece.name === "lamp" ? { ...piece, prefabFactor: BLUE } : piece));
    const { root, packagePath, importDir } = await prefabSetup(imported);
    const result = await runUnityFidelity({ importDir, packagePath, out: join(root, "out"), tile: 160, compensate: false });

    expect(result.pieces.map((piece) => piece.glb).sort()).toEqual(["prefabs/barrel.glb", "prefabs/crate.glb", "prefabs/lamp.glb"].map((glb) => expect.stringMatching(glb)));
    expect(scoreOf(result, "crate")).toBeGreaterThanOrEqual(85);
    expect(scoreOf(result, "barrel")).toBeGreaterThanOrEqual(85);
    expect(scoreOf(result, "lamp")).toBeLessThan(70);
    expect(result.unmatched).toEqual([]);
  }, 120_000);

  it("a preview picture shared by three prefabs is Unity's generic icon: those prefabs have no reference and are not scored against it", async () => {
    const four: SyntheticPiece[] = [
      { name: "a", factor: grey, prefabFactor: RED },
      { name: "b", factor: grey, prefabFactor: GREEN },
      { name: "c", factor: grey, prefabFactor: ORANGE },
      { name: "d", factor: grey, prefabFactor: RED },
    ];
    const icon = (await previews([{ name: "icon", factor: BLUE }])).get("icon")!;
    const real = (await previews([{ name: "d", factor: RED }])).get("d")!;
    const root = await scratchDirectory("unity-fidelity-icon-");
    const packagePath = join(root, "synthetic.unitypackage");
    await writeUnityPackage(packagePath, [
      { path: "Assets/Prefabs" },
      ...four.map((piece) => ({ path: `Assets/Prefabs/${piece.name}.prefab`, content: "fake prefab", previewData: piece.name === "d" ? real : icon })),
    ]);
    const importDir = join(root, "import");
    await writeSyntheticImport(importDir, four);
    const result = await runUnityFidelity({ importDir, packagePath, out: join(root, "out"), tile: 160, compensate: false });

    expect(result.genericPreviews).toBe(3);
    expect(result.unmatched.map((glb) => glb.replace(/^.*\//, "")).sort()).toEqual(["a.glb", "b.glb", "c.glb"]);
    expect(result.pieces.map((piece) => piece.name)).toEqual(["d"]);
    expect(scoreOf(result, "d")).toBeGreaterThanOrEqual(85);
    expect(result.referenceNote).toMatch(/3 package previews are Unity's generic icon/);
  }, 120_000);

  it("a preview that is Unity's missing-shader pink is not a reference: that prefab is left out, not scored as a failure", async () => {
    const two: SyntheticPiece[] = [
      { name: "ok", factor: grey, prefabFactor: RED },
      { name: "pink", factor: grey, prefabFactor: GREEN },
    ];
    const pink = (await previews([{ name: "pink", factor: [1, 0, 1] }])).get("pink")!;
    const real = (await previews([{ name: "ok", factor: RED }])).get("ok")!;
    expect(await isMissingShaderPink(pink)).toBe(true);
    expect(await isMissingShaderPink(real)).toBe(false);
    const root = await scratchDirectory("unity-fidelity-pink-");
    const packagePath = join(root, "synthetic.unitypackage");
    await writeUnityPackage(packagePath, [
      { path: "Assets/Prefabs" },
      ...two.map((piece) => ({ path: `Assets/Prefabs/${piece.name}.prefab`, content: "fake prefab", previewData: piece.name === "pink" ? pink : real })),
    ]);
    const importDir = join(root, "import");
    await writeSyntheticImport(importDir, two);
    const result = await runUnityFidelity({ importDir, packagePath, out: join(root, "out"), tile: 160, compensate: false });
    expect(result.errorPreviews).toBe(1);
    expect(result.pieces.map((piece) => piece.name)).toEqual(["ok"]);
    expect(result.referenceNote).toMatch(/1 package previews show Unity's missing-shader pink/);
  }, 120_000);

  it("an unusable preview is not replaced by the preview of a prefab with the same name (twin prefabs in two folders)", async () => {
    const twins: SyntheticPiece[] = [
      { name: "rock", factor: grey, prefabFactor: RED },
      { name: "rock", glbStem: "rock-urp", factor: grey, prefabFactor: RED, prefabSource: "Assets/Urp/rock.prefab" },
    ];
    const pink = (await previews([{ name: "pink", factor: [1, 0, 1] }])).get("pink")!;
    const real = (await previews([{ name: "rock", factor: RED }])).get("rock")!;
    const root = await scratchDirectory("unity-fidelity-twin-");
    const packagePath = join(root, "synthetic.unitypackage");
    await writeUnityPackage(packagePath, [
      { path: "Assets/Prefabs" },
      { path: "Assets/Urp" },
      { path: "Assets/Prefabs/rock.prefab", content: "fake prefab", previewData: real },
      { path: "Assets/Urp/rock.prefab", content: "fake prefab", previewData: pink },
    ]);
    const importDir = join(root, "import");
    await writeSyntheticImport(importDir, twins);
    const result = await runUnityFidelity({ importDir, packagePath, out: join(root, "out"), tile: 160, compensate: false });
    expect(result.pieces.map((piece) => piece.glb.replace(/^.*\//, ""))).toEqual(["rock.glb"]);
    expect(result.unmatched.map((glb) => glb.replace(/^.*\//, ""))).toEqual(["rock-urp.glb"]);
  }, 120_000);

  it("a slice that names models instead of prefabs says so instead of silently emptying the sheet", async () => {
    const { root, packagePath, importDir } = await prefabSetup(pieces);
    const result = await runUnityFidelity({ importDir, packagePath, out: join(root, "out"), tile: 160, compensate: false, slice: ["Assets/Models/crate.fbx", "Assets/Prefabs/barrel.prefab"] });
    expect(result.pieces.map((piece) => piece.name)).toEqual(["barrel"]);
    expect(result.sliceUnmatched).toBe(1);
    expect(result.referenceNote).toMatch(/1 slice entries matched no prefab/);
    expect(summaryLine(result)).toMatch(/sliceUnmatched=1/);
  }, 120_000);

  it("level: models still scores the model-level GLBs (the before column)", async () => {
    const { root, packagePath, importDir } = await prefabSetup(pieces);
    const result = await runUnityFidelity({ importDir, packagePath, out: join(root, "out"), tile: 160, compensate: false, level: "models" });
    expect(result.pieces.every((piece) => piece.glb.includes("/models/"))).toBe(true);
    expect(result.pieces).toHaveLength(3);
  }, 120_000);
});

describe("fidelity sheet reference", () => {
  const pieces: SyntheticPiece[] = [
    { name: "crate", factor: RED, size: 1 },
    { name: "barrel", factor: GREEN, size: 2 },
    { name: "lamp", factor: ORANGE, size: 0.5 },
  ];

  /** An R1 folder as `ReferenceRender.cs` writes it: a PNG per prefab and `bounds.json` in metres. */
  async function writeR1(directory: string, boundsOf: (piece: SyntheticPiece) => number): Promise<void> {
    const correct = await previews(pieces);
    await mkdir(join(directory, "Prefabs"), { recursive: true });
    const items: R1Bounds["items"][number][] = [];
    for (const piece of pieces) {
      await writeFile(join(directory, "Prefabs", `${piece.name}.png`), correct.get(piece.name)!);
      const edge = boundsOf(piece);
      items.push({
        asset: `Assets/Prefabs/${piece.name}.prefab`,
        png: `Prefabs/${piece.name}.png`,
        models: [`Assets/Models/${piece.name}.fbx`],
        boundsMeters: { size: { x: edge, y: edge, z: edge } },
      });
    }
    await writeFile(join(directory, "bounds.json"), JSON.stringify({ version: 1, items } satisfies R1Bounds));
  }

  it("reference: a synthetic R1 folder is used instead of R2, and the column is labelled R1", async () => {
    // The package previews are deliberately wrong (every piece blue): only R1 can give a high score.
    // Different wrong colours: one picture shared by three assets would read as Unity's generic icon, not a reference.
    const wrongColours = { crate: LIME, barrel: BLUE, lamp: [0.6, 0.1, 0.6] as const };
    const wrong = await previews(pieces.map((piece) => ({ ...piece, factor: wrongColours[piece.name as keyof typeof wrongColours] })));
    const { packagePath, importDir, root } = await setup(pieces, wrong);
    const r1 = join(root, "reference");
    await writeR1(r1, (piece) => piece.size ?? 1);

    const viaR1 = await runUnityFidelity({ importDir, packagePath, referenceDir: r1, out: join(root, "out-r1"), tile: 160 });
    expect(viaR1.reference).toBe("R1");
    expect(viaR1.referenceNote).toMatch(/^R1/);
    expect(viaR1.pieces.every((piece) => piece.reference === "R1")).toBe(true);
    for (const piece of pieces) expect(scoreOf(viaR1, piece.name)).toBeGreaterThanOrEqual(85);
    expect(viaR1.summary.sizeMismatches).toBe(0);
    expect(viaR1.channelOrder).toBeUndefined();
    const written = JSON.parse(await readFile(join(root, "out-r1", "reference.json"), "utf8")) as { reference: string };
    expect(written.reference).toBe("R1");

    // Without the R1 folder the wrong R2 previews pull the same import down.
    const viaR2 = await runUnityFidelity({ importDir, packagePath, out: join(root, "out-r2"), tile: 160, compensate: false });
    expect(viaR2.reference).toBe("R2");
    expect(scoreOf(viaR2, "crate")).toBeLessThan(70);
    // A named but missing R1 folder falls back to R2 and says so.
    const missing = await runUnityFidelity({ importDir, packagePath, referenceDir: join(root, "no-such-folder"), out: join(root, "out-missing"), tile: 160 });
    expect(missing.reference).toBe("R2");
    expect(missing.referenceNote).toMatch(/has no bounds\.json/);
  }, 180_000);

  it("reference: flags a piece whose sizeMeters is more than 1 % off its R1 bounds", async () => {
    const { packagePath, importDir, root } = await setup(pieces, new Map());
    const r1 = join(root, "reference");
    // crate: exact; barrel: 0.5 % off (accepted); lamp: 2 % off (flagged).
    await writeR1(r1, (piece) => (piece.name === "barrel" ? 2.01 : piece.name === "lamp" ? 0.51 : 1));
    const result = await runUnityFidelity({ importDir, packagePath, referenceDir: r1, out: join(root, "out"), tile: 160 });

    const check = (name: string) => result.pieces.find((piece) => piece.name === name)?.sizeCheck;
    expect(check("crate")?.ok).toBe(true);
    expect(check("barrel")?.ok).toBe(true);
    expect(check("lamp")?.ok).toBe(false);
    expect(check("lamp")?.worst).toBeCloseTo(0.02, 3);
    expect(result.summary.sizeMismatches).toBe(1);
    const saved = JSON.parse(await readFile(join(root, "out", "fidelity.json"), "utf8")) as { name: string; sizeCheck?: { ok: boolean } }[];
    expect(saved.find((piece) => piece.name === "lamp")?.sizeCheck?.ok).toBe(false);
  }, 120_000);

  it("reference: a model without an R1 item is reported, not scored", async () => {
    const { packagePath, importDir, root } = await setup(pieces, new Map());
    const r1 = join(root, "reference");
    await writeR1(r1, (piece) => piece.size ?? 1);
    const bounds = JSON.parse(await readFile(join(r1, "bounds.json"), "utf8")) as R1Bounds;
    await writeFile(join(r1, "bounds.json"), JSON.stringify({ ...bounds, items: bounds.items.filter((item) => !item.asset.includes("lamp")) }));
    const result = await runUnityFidelity({ importDir, packagePath, referenceDir: r1, out: join(root, "out"), tile: 160 });
    expect(result.unmatched).toEqual(["models/lamp.glb"]);
    expect(result.pieces.map((piece) => piece.name).sort()).toEqual(["barrel", "crate"]);
  }, 120_000);

  it("reference: the script prints the reference column and the table for an existing import", async () => {
    const { packagePath, importDir, root } = await setup(pieces, await previews(pieces));
    const out = join(root, "out");
    const { stdout } = await runScript("scripts/fidelity-sheet.ts", ["--unity-package", packagePath, "--import", importDir, "--out", out, "--max", "3"], 150_000);
    expect(stdout).toMatch(/Reference: R2/);
    expect(stdout).toMatch(/scored=models reference=R2 compared=3/);
    expect((await stat(join(out, "sheet.jpg"))).size).toBeGreaterThan(2000);
  }, 180_000);
});

describeWithTools(["blender", "chromium"], "fidelity of a real importer run", () => {
  it("scores a package imported by the PRD-616 importer against its preview, and a wrong tint falls below 70", async () => {
    const root = await scratchDirectory("unity-fidelity-e2e-");
    await writeCubeFbx(join(root, "crate.fbx"), ["Wood"]);
    const fbx = await readFile(join(root, "crate.fbx"));
    // Unity colours are stored as picked (gamma) and read as linear in the project: the preview is the same cube in that colour.
    const picked = [0.8, 0.2, 0.2] as const;
    const preview = (await previews([{ name: "crate", factor: [srgbToLinear(picked[0]), srgbToLinear(picked[1]), srgbToLinear(picked[2])], size: 1 }])).get("crate")!;

    const build = async (colour: readonly [number, number, number]) => {
      const dir = await scratchDirectory("unity-fidelity-pack-");
      const packagePath = join(dir, "pack.unitypackage");
      await writeUnityPackage(packagePath, [
        { path: "Assets/Models" },
        { path: "Assets/Models/crate.fbx", data: fbx, importer: modelImporter(), previewData: preview },
        { path: "Assets/Materials" },
        { path: "Assets/Materials/Wood.mat", content: materialYaml({ name: "Wood", shader: SHADERS.standard, colors: { _Color: [...colour, 1] } }) },
      ]);
      const importDir = join(dir, "import");
      await importUnityPackage({ source: packagePath, outputDir: importDir });
      return runUnityFidelity({ importDir, packagePath, out: join(dir, "out"), tile: 160, compensate: false });
    };
    const good = await build(picked);
    const bad = await build([0.3, 0.9, 0.3]);
    expect(scoreOf(good, "crate")).toBeGreaterThanOrEqual(75);
    expect(scoreOf(bad, "crate")).toBeLessThan(70);
  }, 240_000);
});

describe("Unity preview rig compensation", () => {
  it("the gains are the constants fitted on U1 (changing them changes every R2 score: refit, re-run the sweeps and update the baseline)", () => {
    expect([UNITY_RIG_SATURATION_GAIN, UNITY_RIG_LIGHTNESS_GAIN]).toEqual([2.0, 1.7]);
  });

  const pixel = async (rgb: readonly [number, number, number]): Promise<Buffer> =>
    sharp(Buffer.from([...rgb, 255]), { raw: { width: 1, height: 1, channels: 4 } }).png().toBuffer();
  const read = async (png: Buffer): Promise<number[]> => [...(await sharp(png).ensureAlpha().raw().toBuffer())];

  it("brightens and saturates by the fixed gains, keeps the hue, clamps, and leaves black and the alpha alone", async () => {
    // A dim, grey-ish brown (hue 30 degrees, saturation 0.25, value 0.4) becomes saturation 0.5, value 0.68 at the same hue.
    const [r, g, b, a] = await read(await compensatePreviewRig(await pixel([102, 90, 76]), { saturation: 2, lightness: 1.7 }));
    expect(a).toBe(255);
    expect((g! - b!) / (r! - b!)).toBeCloseTo((90 - 76) / (102 - 76), 1);
    expect(r).toBe(173);
    expect(1 - b! / r!).toBeCloseTo(0.5, 1);
    expect(await read(await compensatePreviewRig(await pixel([0, 0, 0])))).toEqual([0, 0, 0, 255]);
    expect(await read(await compensatePreviewRig(await pixel([200, 40, 40]), { saturation: 2, lightness: 2 }))).toEqual([255, 0, 0, 255]);
  });
});
