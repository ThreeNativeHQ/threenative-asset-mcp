import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  captureMaterialMetadata,
  type MaterialMetadataDump,
  readMaterialMetadataDumps,
  replayMaterialMetadata,
  writeMaterialMetadataDump,
} from "../src/unreal/material-metadata.js";
import type { ResolveMaterialRequest } from "../src/unreal/materials.js";

const tex = (name: string): string => `Texture2D'Content/Synthetic/Textures/${name}.${name}'`;

const instanceProps = (parent: string, overrides: Array<[string, string]>): string =>
  [
    `Parent = Material3'Content/Synthetic/Materials/${parent}.${parent}'`,
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

const files: Record<string, { mat?: string; props?: string }> = {
  MI_Panel: { mat: "Diffuse=T_Parent_D\n", props: instanceProps("M_Master", [["Diffuse", "T_Instance_D"]]) },
  M_Master: { mat: "Diffuse=T_Parent_D\n", props: masterProps([["Diffuse", "T_Parent_D"]]) },
  M_Plain: { mat: "Diffuse=T_Plain_D\nNormal=T_Plain_N\n" },
};

const request = (name: string, textures: string[] = ["T_Parent_D", "T_Instance_D", "T_Plain_D", "T_Plain_N"]): ResolveMaterialRequest => ({
  name,
  readMat: (material) => files[material]?.mat,
  readProps: (material) => files[material]?.props,
  availableTextures: new Set(textures),
});

const dumpOf = (...names: string[]): MaterialMetadataDump => ({
  version: 1,
  source: "unit-test",
  materials: names.map((name) => captureMaterialMetadata(request(name))),
});

const scratchDir = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "tn-metadata-test-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return directory;
};

describe("captureMaterialMetadata", () => {
  it("records the texts read through the Parent chain and the resolver's answer", () => {
    const entry = captureMaterialMetadata(request("MI_Panel"));
    expect(Object.keys(entry.mat).sort()).toEqual(["MI_Panel", "M_Master"]);
    expect(Object.keys(entry.props).sort()).toEqual(["MI_Panel", "M_Master"]);
    expect(entry.expected.bindings).toEqual([
      expect.objectContaining({ slot: "baseColor", texture: "T_Instance_D", source: "props", confidence: "exact" }),
    ]);
    expect(entry.availableTextures).toEqual(["T_Instance_D", "T_Parent_D", "T_Plain_D", "T_Plain_N"]);
  });

  it("does not record names the resolver found no text for", () => {
    const entry = captureMaterialMetadata(request("M_Plain"));
    expect(entry.mat).toEqual({ M_Plain: "Diffuse=T_Plain_D\nNormal=T_Plain_N\n" });
    expect(entry.props).toEqual({});
  });

  it("keeps sharedGraphMaterialNames only when the request had them", () => {
    expect(captureMaterialMetadata(request("M_Plain")).sharedGraphMaterialNames).toBeUndefined();
    const shared = captureMaterialMetadata({ ...request("M_Plain"), sharedGraphMaterialNames: new Set(["M_Plain", "M_Other"]) });
    expect(shared.sharedGraphMaterialNames).toEqual(["M_Other", "M_Plain"]);
  });
});

describe("replayMaterialMetadata", () => {
  it("replays a captured dump with no mismatches", () => {
    expect(replayMaterialMetadata(dumpOf("MI_Panel", "M_Plain"))).toEqual([]);
  });

  it("reports a binding that the recorded texts no longer produce", () => {
    const dump = dumpOf("M_Plain");
    const [entry] = dump.materials;
    const tampered: MaterialMetadataDump = {
      ...dump,
      materials: [{ ...entry!, expected: { ...entry!.expected, bindings: [{ ...entry!.expected.bindings[0]!, texture: "T_Wrong_D" }, ...entry!.expected.bindings.slice(1)] } }],
    };
    const mismatches = replayMaterialMetadata(tampered);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatch(/^M_Plain: bindings expected \[baseColor=T_Wrong_D/);
    expect(mismatches[0]).toContain("replay gave [baseColor=T_Plain_D");
  });

  it("reports a limitation that appeared or disappeared", () => {
    const dump = dumpOf("M_Plain");
    const [entry] = dump.materials;
    const tampered: MaterialMetadataDump = {
      ...dump,
      materials: [{ ...entry!, expected: { ...entry!.expected, limitations: ["old limitation"] } }],
    };
    const mismatches = replayMaterialMetadata(tampered);
    expect(mismatches).toContain("M_Plain: limitation no longer reported: old limitation");
    expect(mismatches.some((line) => line.startsWith("M_Plain: new limitation"))).toBe(false);
  });

  it("refuses a dump of another version", () => {
    const dump = { ...dumpOf("M_Plain"), version: 2 } as unknown as MaterialMetadataDump;
    expect(replayMaterialMetadata(dump)).toEqual(["unsupported dump version 2; expected 1"]);
  });
});

describe("writeMaterialMetadataDump and readMaterialMetadataDumps", () => {
  it("round-trips dumps through a directory, sorted by file name", async () => {
    const directory = join(await scratchDir(), "nested", "dumps");
    const dump = dumpOf("MI_Panel");
    const path = writeMaterialMetadataDump(directory, "b-listing.json", dump);
    writeMaterialMetadataDump(directory, "a-listing.json", dumpOf("M_Plain"));
    expect(path).toBe(join(directory, "b-listing.json"));
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(dump);
    const read = readMaterialMetadataDumps(directory);
    expect(read.map((item) => item.fileName)).toEqual(["a-listing.json", "b-listing.json"]);
    expect(read[1]!.dump).toEqual(dump);
    expect(replayMaterialMetadata(read[1]!.dump)).toEqual([]);
  });

  it("ignores non-JSON files and rejects a dump of another version", async () => {
    const directory = await scratchDir();
    await writeFile(join(directory, "notes.txt"), "not a dump");
    expect(readMaterialMetadataDumps(directory)).toEqual([]);
    await writeFile(join(directory, "old.json"), JSON.stringify({ version: 0, source: "x", materials: [] }));
    expect(() => readMaterialMetadataDumps(directory)).toThrow(/old\.json: unsupported metadata dump version 0/);
  });

  it("refuses file names that would leave the directory", async () => {
    const directory = await scratchDir();
    expect(() => writeMaterialMetadataDump(directory, "../escape.json", dumpOf("M_Plain"))).toThrow(/bare \*\.json name/);
    expect(() => writeMaterialMetadataDump(directory, "notes.txt", dumpOf("M_Plain"))).toThrow(/bare \*\.json name/);
    expect(await readdir(directory)).toEqual([]);
  });
});
