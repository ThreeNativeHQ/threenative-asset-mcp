import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative } from "node:path";

import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { importUnrealDirectory } from "../src/unreal/importer.js";
import { writeFakeUmodel, writeMeshFixture } from "./helpers/unreal-fixture.js";

// UE Viewer copies an absolute `-out=` into a 256-byte buffer before it appends the package folders, and exits 0 when the
// file cannot be created. The importer exports from inside each output root with `-out=./`, so a long cache root must not
// cost a mesh its sidecars, and a package path that is too long even relative must fail visibly.

/** An uncooked UE4.18 package head whose name table carries `names`. */
function packageHead(names: readonly string[]): Buffer {
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x9e2a83c1, 0);
  header.writeInt32LE(-7, 4);
  header.writeInt32LE(864, 8);
  header.writeInt32LE(514, 12);
  return Buffer.concat([header, ...names.map((name) => Buffer.from(`\0${name}\0`, "latin1"))]);
}

/** Folders the fixture exports under: an absolute staging root plus these overflows UE Viewer's buffer. */
const FOLDERS = `Group/${"Vegetation-Conifer-Pines-Mesh-LODs/".repeat(2)}Package`;
/** Too long for UE Viewer even relative to its output root. */
const OVERLONG_FOLDERS = `Group/${"q".repeat(120)}/${"r".repeat(140)}`;

/** A cache root deep enough that its staging directories overflow the buffer once FOLDERS is appended. */
function deepCacheRoot(base: string): string {
  return join(base, "cache", "a".repeat(40), "b".repeat(40), "c".repeat(40), "d".repeat(40));
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "umodel-export-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** One static mesh, and a UE Viewer stand-in at `umodel` exporting it under `folders` by UE Viewer's output rules. */
async function writeMeshPack(root: string, folders: string, umodel = join(root, "umodel")) {
  const sourceDir = join(root, "source");
  await mkdir(join(sourceDir, "Content", "Props"), { recursive: true });
  await writeFile(join(sourceDir, "Content", "Props", "Mesh.uasset"), packageHead(["StaticMesh", "SourceModels"]));
  const exported = join(root, "exported");
  await writeMeshFixture(exported, { name: "Mesh", materialName: "M_Plain", mat: "", props: "", textures: [] });
  const argvLog = join(root, "umodel.log");
  await writeFakeUmodel(umodel, {
    exportFrom: exported,
    classes: { Mesh: ["StaticMesh"] },
    argvLog,
    outputSubdirectory: folders,
    nativeOutputPaths: true,
  });
  return { sourceDir, umodel, argvLog };
}

function importMeshPack(root: string, pack: { sourceDir: string; umodel: string }, cacheDir: string, umodelPath = pack.umodel) {
  return importUnrealDirectory({
    sourceDir: pack.sourceDir,
    outputDir: join(root, "output"),
    concurrency: 1,
    freeSpaceBytes: 30_000_000_000,
    graphBake: false,
    environment: { ...process.env, THREENATIVE_UNREAL_CACHE_DIR: cacheDir },
    umodel: { name: "umodel", path: umodelPath, version: "fixture" },
  });
}

async function exportInvocations(argvLog: string): Promise<string[][]> {
  const lines = (await readFile(argvLog, "utf8")).trim().split("\n");
  return lines.map((line) => JSON.parse(line) as string[]).filter((argv) => argv.includes("-export"));
}

describe("UE Viewer exports from the importer", () => {
  it("exports from a relative output root, so a long cache root keeps the mesh", async () => {
    const root = await tempRoot();
    const cache = deepCacheRoot(root);
    // The absolute staging root alone is already long enough that the old absolute `-out=` overflowed UE Viewer's buffer.
    expect(cache.length + 1 + FOLDERS.length).toBeGreaterThan(255);
    const pack = await writeMeshPack(root, FOLDERS);
    const report = await importMeshPack(root, pack, cache);
    expect(report.failed).toEqual([]);
    expect(report.models.map((model) => model.name)).toEqual(["Mesh"]);
    const exports = await exportInvocations(pack.argvLog);
    expect(exports.length).toBeGreaterThan(0);
    for (const argv of exports) {
      expect(argv).toContain("-out=./");
      const source = argv.find((entry) => entry.startsWith("-path="))?.slice("-path=".length) ?? "";
      expect(isAbsolute(source)).toBe(true);
    }
  });

  it("reports UE Viewer's 'Error creating file' as the mesh's failure, even though it exits 0", async () => {
    const root = await tempRoot();
    const pack = await writeMeshPack(root, OVERLONG_FOLDERS);
    // Nothing else in the pack promotes, so the import refuses and names the failure, rather than succeeding without the mesh.
    await expect(importMeshPack(root, pack, join(root, "cache"))).rejects.toThrow("Error creating file");
  });

  it("accepts a UE Viewer path relative to the caller's working directory", async () => {
    const root = await tempRoot();
    const pack = await writeMeshPack(root, FOLDERS);
    const report = await importMeshPack(root, pack, join(root, "cache"), relative(process.cwd(), pack.umodel));
    expect(report.failed).toEqual([]);
    expect(report.models.map((model) => model.name)).toEqual(["Mesh"]);
  });
});

describe("UE Viewer named by a bare executable name", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("imports through a bare name that only PATH holds, while the caller's working directory has no such file", async () => {
    const root = await tempRoot();
    const bin = join(root, "bin");
    await mkdir(bin);
    const pack = await writeMeshPack(root, FOLDERS, join(bin, "umodel"));
    vi.stubEnv("PATH", [bin, dirname(process.execPath)].join(delimiter));
    expect(existsSync(join(process.cwd(), "umodel"))).toBe(false);

    const report = await importMeshPack(root, pack, join(root, "cache"), "umodel");

    expect(report.failed).toEqual([]);
    expect(report.models.map((model) => model.name)).toEqual(["Mesh"]);
  });

  it("imports through a bare name whose PATH entry is relative to the caller's working directory", async () => {
    const root = await tempRoot();
    const bin = join(root, "bin");
    await mkdir(bin);
    const pack = await writeMeshPack(root, FOLDERS, join(bin, "umodel"));
    vi.stubEnv("PATH", [relative(process.cwd(), bin), dirname(process.execPath)].join(delimiter));

    const report = await importMeshPack(root, pack, join(root, "cache"), "umodel");

    expect(report.failed).toEqual([]);
    expect(report.models.map((model) => model.name)).toEqual(["Mesh"]);
  });
});
