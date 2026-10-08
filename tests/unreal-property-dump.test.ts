import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, describe, expect, it } from "vitest";
import { CUE4PARSE_PROGRAM } from "../src/unreal/cue4parse-adapter.js";
import { dumpUnrealProperties } from "../src/unreal/property-dump.js";

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tn-property-dump-test-"));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function fakeConverter(dir: string, body: string): Promise<string> {
  const path = join(dir, "fake-converter.mjs");
  await writeFile(path, `#!/usr/bin/env node\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

const FIXED = {
  format: 1,
  game: "GAME_UE4_18",
  packages: [
    {
      path: "/Game/Rock/MI_Rock",
      importedTextures: ["/Game/Rock/T_Rock"],
      exports: [
        {
          name: "SM_Rock",
          class: "StaticMesh",
          slots: [{ name: "Slot0", material: "/Game/Rock/MI_Rock.MI_Rock" }],
          bounds: {
            origin: [0, 0, 0],
            boxExtent: [1100, 1100, 1100],
            sphereRadius: 1905,
            property: "ExtendedBounds",
            positiveExtension: [1000, 1000, 1000],
            negativeExtension: [1000, 1000, 1000],
          },
        },
        {
          name: "M_Rock_Master",
          class: "Material",
          textures: [],
          functions: ["/Game/Rock/MF_Moss.MF_Moss"],
        },
        {
          name: "MI_Rock",
          class: "MaterialInstanceConstant",
          parent: "/Game/Rock/M_P.M_P",
          textureParameters: [{ name: "Mask", texture: "/Game/Rock/T_Rock.T_Rock" }],
          vectorParameters: [{ name: "Tint", value: [1, 0.5, 0, 1] }],
          scalarParameters: [{ name: "Rough", value: 0.5 }],
        },
      ],
    },
  ],
};

describe("--dump-properties converter mode", () => {
  it("is wired into the embedded program and accepts UE4 versions", () => {
    expect(CUE4PARSE_PROGRAM).toContain("--dump-properties");
    expect(CUE4PARSE_PROGRAM).toContain('"4.18" => EGame.GAME_UE4_18');
    expect(CUE4PARSE_PROGRAM).toContain('"4.0" => EGame.GAME_UE4_0');
    expect(CUE4PARSE_PROGRAM).toContain('"4.27" => EGame.GAME_UE4_27');
    // bounds extension padding and material-function links (PRD parity S2/S3 false positives)
    expect(CUE4PARSE_PROGRAM).toContain('"PositiveBoundsExtension"');
    expect(CUE4PARSE_PROGRAM).toContain('"NegativeBoundsExtension"');
    expect(CUE4PARSE_PROGRAM).toContain('["positiveExtension"]');
    expect(CUE4PARSE_PROGRAM).toContain('["negativeExtension"]');
    expect(CUE4PARSE_PROGRAM).toContain('"MaterialExpressionMaterialFunctionCall"');
    expect(CUE4PARSE_PROGRAM).toContain('"MaterialFunction"');
    expect(CUE4PARSE_PROGRAM).toContain('["functions"]');
  });

  it("returns the converter's JSON and passes argv through", async () => {
    const dir = await scratch();
    const argvLog = join(dir, "argv.json");
    const converter = await fakeConverter(
      dir,
      `import { writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(argv));
writeFileSync(argv[argv.indexOf("--dump-properties") + 1], ${JSON.stringify(JSON.stringify(FIXED))});`,
    );
    const dump = await dumpUnrealProperties("/some/source", { converterPath: converter, engine: "4.18", filter: "MI_Rock" });
    expect(dump).toEqual(FIXED);
    const argv = JSON.parse(await readFile(argvLog, "utf8")) as string[];
    expect(argv[0]).toBe("/some/source");
    expect(argv[1]).toBe("--dump-properties");
    expect(argv.slice(3)).toEqual(["--engine", "4.18", "--filter", "MI_Rock"]);
  });

  it("rejects clearly when the converter writes malformed JSON", async () => {
    const dir = await scratch();
    const converter = await fakeConverter(
      dir,
      `import { writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
writeFileSync(argv[argv.indexOf("--dump-properties") + 1], "{ not json");`,
    );
    await expect(dumpUnrealProperties("/some/source", { converterPath: converter })).rejects.toThrow(/not valid JSON/);
  });
});
