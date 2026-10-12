import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Document, NodeIO } from "@gltf-transform/core";
import sharp from "sharp";
import { describe, expect, it, onTestFinished } from "vitest";

import type { SourceEnvironmentReport, SourceGridReport } from "../src/unreal/contact-sheet.js";
import {
  PICTURE_CONTRACT,
  PREVIEW_REFERENCE_ENV,
  describePicture,
  pictureRecord,
  preparePreviewPicture,
  resumeRefusal,
  sheetsNotDrawnAs,
  type PictureIdentity,
  type PreviewPicture,
} from "../src/unreal/preview-reference-workflow.js";
import { writeFakeFabCli } from "./helpers/unreal-fixture.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
const ENV_WIDTH = 64;
const ENV_HEIGHT = 32;
const GRID_SIZE = 8;
const ENVIRONMENT_SOURCE = {
  reference: "synthetic/sky-longlat",
  engine: "synthetic",
  bytesSha256: "d".repeat(64),
  layout: "ue-source-longlat-rgb-f32",
  radianceDecode: "ue4.19-rgbe",
} as const;
const GRID_SOURCE = { reference: "synthetic/quadrant-grid", engine: "synthetic", bytesSha256: "e".repeat(64) } as const;

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A scratch directory removed when the test ends, so the leak gate sees nothing left behind. */
async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tn-preview-workflow-test-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

interface ReferenceFiles {
  readonly profilePath: string;
  readonly profileSha256: string;
  readonly environmentSha256: string;
  readonly gridSha256: string;
}

/** A profile over generated radiance and Grid. Every value is made here: nothing licensed, nothing fetched. */
async function writeReferenceProfile(directory: string, version = 1): Promise<ReferenceFiles> {
  await mkdir(directory, { recursive: true });
  const radiance = Buffer.alloc(ENV_WIDTH * ENV_HEIGHT * 12);
  for (let pixel = 0; pixel < ENV_WIDTH * ENV_HEIGHT; pixel++) {
    for (let channel = 0; channel < 3; channel++) {
      radiance.writeFloatLE(0.5 + 0.05 * channel + (pixel % ENV_WIDTH) / ENV_WIDTH, (pixel * 3 + channel) * 4);
    }
  }
  const grid = Buffer.alloc(GRID_SIZE * GRID_SIZE * 4);
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      const value = x < GRID_SIZE / 2 === y < GRID_SIZE / 2 ? 40 : 220;
      const at = (y * GRID_SIZE + x) * 4;
      grid[at] = value;
      grid[at + 1] = value;
      grid[at + 2] = value;
      grid[at + 3] = 255;
    }
  }
  const document = {
    version,
    environment: {
      path: "environment.rgb-f32le",
      encoding: "rgb-f32le",
      width: ENV_WIDTH,
      height: ENV_HEIGHT,
      sha256: sha256(radiance),
      source: ENVIRONMENT_SOURCE,
    },
    grid: { path: "grid.rgba8", encoding: "rgba8", width: GRID_SIZE, height: GRID_SIZE, sha256: sha256(grid), source: GRID_SOURCE },
  };
  const text = `${JSON.stringify(document, null, 2)}\n`;
  await writeFile(join(directory, "environment.rgb-f32le"), radiance);
  await writeFile(join(directory, "grid.rgba8"), grid);
  const profilePath = join(directory, "reference.json");
  await writeFile(profilePath, text);
  return { profilePath, profileSha256: sha256(text), environmentSha256: sha256(radiance), gridSha256: sha256(grid) };
}

/** The applied-input reports a renderer returns when it was given exactly these files. */
function appliedFor(files: ReferenceFiles): { sourceEnvironment: SourceEnvironmentReport; sourceGrid: SourceGridReport } {
  return {
    sourceEnvironment: {
      source: { ...ENVIRONMENT_SOURCE },
      width: ENV_WIDTH,
      height: ENV_HEIGHT,
      radianceSha256: files.environmentSha256,
      rotationY: 0,
      intensity: 1,
      limitations: [],
    },
    sourceGrid: { source: { ...GRID_SOURCE }, width: GRID_SIZE, height: GRID_SIZE, rgbaSha256: files.gridSha256, limitations: [] },
  };
}

const FALLBACK: PictureIdentity = { kind: "fallback", contract: PICTURE_CONTRACT };

/** A child's environment: its own scratch directories and the recording Fab CLI, and no reference unless one is given. */
function childEnvironment(root: string, tag: string, fabCli: string, reference?: string): NodeJS.ProcessEnv {
  const tmp = join(root, "tmp", tag);
  mkdirSync(tmp, { recursive: true });
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    TMPDIR: tmp,
    THREENATIVE_FABCLI_PATH: fabCli,
    THREENATIVE_FAB_DOWNLOAD_DIR: join(root, "fab-downloads"),
    THREENATIVE_PARITY_TMP: join(root, "parity-tmp"),
  };
  delete environment[PREVIEW_REFERENCE_ENV];
  if (reference !== undefined) environment[PREVIEW_REFERENCE_ENV] = reference;
  return environment;
}

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs a repository script through tsx in a child process, as the npm scripts do. */
function runScript(script: string, args: readonly string[], environment: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, ["--import", TSX_LOADER, join(ROOT, script), ...args], {
      cwd: ROOT,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => done({ code, stdout, stderr }));
  });
}

/** A Fab CLI stand-in that records every call: the explicit hook for "no listing and no download". */
async function recordingFabCli(root: string): Promise<{ readonly path: string; readonly calls: () => Promise<string[][]> }> {
  const argvLog = join(root, "fabcli-calls.log");
  const path = join(root, "fabcli");
  await writeFakeFabCli(path, { argvLog });
  return {
    path,
    calls: async () => (existsSync(argvLog) ? (await readFile(argvLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]) : []),
  };
}

/** A settled scorecard entry as `--resume` reads it; only the sheet's picture record matters to these tests. */
function settledEntry(sheet?: Record<string, unknown>): Record<string, unknown> {
  return {
    listingId: "listing-1",
    title: "Cube pack",
    artifactId: "artifact-1",
    engines: ["4.27"],
    oldestEngine: "4.27",
    route: "uncooked",
    status: "pass",
    reasons: [],
    classes: [],
    summary: null,
    durationMs: 1,
    ...(sheet === undefined ? {} : { sheet }),
  };
}

/** A synthetic pack with one editor thumbnail and an import output holding one cube. Nothing here is from a licensed pack. */
async function writeSyntheticImport(root: string): Promise<{ readonly source: string; readonly importDir: string }> {
  const source = join(root, "pack");
  const importDir = join(root, "import");
  await mkdir(source, { recursive: true });
  await mkdir(importDir, { recursive: true });
  const image = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 60, b: 30 } } }).png().toBuffer();
  const record = Buffer.alloc(12);
  record.writeInt32LE(64, 0);
  record.writeInt32LE(64, 4);
  record.writeInt32LE(image.length, 8);
  // The layout `extractPackageThumbnail` reads: a package header, the [width, height, size] record, the PNG, then trailing bytes.
  await writeFile(join(source, "Cube.uasset"), Buffer.concat([Buffer.from("C1832A9E", "hex"), randomBytes(300), record, image, randomBytes(64)]));
  await writeCube(join(importDir, "cube.glb"));
  await writeFile(
    join(importDir, "import-report.json"),
    JSON.stringify({ models: [{ name: "Cube", package: "Cube.uasset", glb: "cube.glb", materials: [{ textured: false }] }] }),
  );
  return { source, importDir };
}

/** A unit cube with normals and one double-sided material, written as a GLB. */
async function writeCube(path: string): Promise<void> {
  const document = new Document();
  const buffer = document.createBuffer();
  const positions = new Float32Array(8 * 3);
  const normals = new Float32Array(8 * 3);
  for (let corner = 0; corner < 8; corner++) {
    const signs = [corner & 1 ? 1 : -1, corner & 2 ? 1 : -1, corner & 4 ? 1 : -1];
    positions.set(signs.map((s) => s * 0.5), corner * 3);
    normals.set(signs.map((s) => s / Math.sqrt(3)), corner * 3);
  }
  const indices = new Uint16Array([0, 1, 3, 0, 3, 2, 4, 5, 7, 4, 7, 6, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 3, 7, 1, 7, 5]);
  const material = document.createMaterial("cube").setBaseColorFactor([0.8, 0.4, 0.2, 1]).setDoubleSided(true);
  const primitive = document
    .createPrimitive()
    .setAttribute("POSITION", document.createAccessor().setType("VEC3").setArray(positions).setBuffer(buffer))
    .setAttribute("NORMAL", document.createAccessor().setType("VEC3").setArray(normals).setBuffer(buffer))
    .setIndices(document.createAccessor().setType("SCALAR").setArray(indices).setBuffer(buffer))
    .setMaterial(material);
  document.createScene().addChild(document.createNode("cube").setMesh(document.createMesh("cube").addPrimitive(primitive)));
  await new NodeIO().write(path, document);
}

function sheetArgs(source: string, importDir: string, out: string): string[] {
  return ["--source", source, "--import", importDir, "--out", out, "--max", "1"];
}

describe("preview reference preflight", () => {
  it("is the approximate fallback when no reference is configured", async () => {
    const picture = await preparePreviewPicture({}, "unreal-like");
    expect(picture.identity).toEqual(FALLBACK);
    expect(picture.inputs).toEqual({});
    expect(describePicture(picture.identity)).toContain("approximate fallback");
  });

  it("lights the picture with a configured profile and records the digests of the bytes it read", async () => {
    const root = await scratch();
    const files = await writeReferenceProfile(join(root, "reference"));
    const picture = await preparePreviewPicture({ [PREVIEW_REFERENCE_ENV]: files.profilePath }, "unreal-like");
    expect(picture.identity).toEqual({
      kind: "local-reference",
      contract: PICTURE_CONTRACT,
      profileSha256: files.profileSha256,
      environmentRadianceSha256: files.environmentSha256,
      gridRgbaSha256: files.gridSha256,
    });
    expect(picture.inputs.sourceEnvironment).toMatchObject({ width: ENV_WIDTH, height: ENV_HEIGHT });
    expect(picture.inputs.sourceGrid).toMatchObject({ width: GRID_SIZE, height: GRID_SIZE });
    expect(describePicture(picture.identity)).toContain(files.profileSha256.slice(0, 12));
  });

  it("keeps the reference out of a neutral picture, which draws no reference light", async () => {
    const root = await scratch();
    const files = await writeReferenceProfile(join(root, "reference"));
    const picture = await preparePreviewPicture({ [PREVIEW_REFERENCE_ENV]: files.profilePath }, "neutral");
    expect(picture).toEqual({ identity: { kind: "neutral" }, inputs: {} });
  });

  it("rejects a configured reference that is missing, malformed or empty, even for a neutral picture", async () => {
    const root = await scratch();
    const wrongVersion = await writeReferenceProfile(join(root, "wrong-version"), 2);
    const cases = [join(root, "missing.json"), wrongVersion.profilePath, "   "];
    for (const configured of cases) {
      for (const lighting of ["unreal-like", "neutral"] as const) {
        await expect(preparePreviewPicture({ [PREVIEW_REFERENCE_ENV]: configured }, lighting)).rejects.toThrow(PREVIEW_REFERENCE_ENV);
      }
    }
  });

  it("stores only the identity and the applied reports: no arrays, no paths", async () => {
    const root = await scratch();
    const files = await writeReferenceProfile(join(root, "reference"));
    const picture = await preparePreviewPicture({ [PREVIEW_REFERENCE_ENV]: files.profilePath }, "unreal-like");
    const record = pictureRecord(picture, appliedFor(files));
    expect(record.identity).toEqual(picture.identity);
    expect(record.sourceEnvironment).toEqual(appliedFor(files).sourceEnvironment);
    expect(record.sourceGrid).toEqual(appliedFor(files).sourceGrid);
    const text = JSON.stringify(record);
    expect(text).not.toContain(root);
    expect(text).not.toMatch(/"(rgb|rgba)":/);
  });

  it("refuses a renderer that applied other inputs than the verified ones", async () => {
    const root = await scratch();
    const files = await writeReferenceProfile(join(root, "reference"));
    const local: PreviewPicture = await preparePreviewPicture({ [PREVIEW_REFERENCE_ENV]: files.profilePath }, "unreal-like");
    const applied = appliedFor(files);
    expect(() => pictureRecord(local, { ...applied, sourceGrid: { ...applied.sourceGrid, rgbaSha256: "0".repeat(64) } })).toThrow(/did not apply/);
    expect(() => pictureRecord(local, {})).toThrow(/did not apply/);
    const fallbackPicture = await preparePreviewPicture({}, "unreal-like");
    expect(() => pictureRecord(fallbackPicture, applied)).toThrow(/applied a reference input to a fallback picture/);
  });

  it("counts stored sheets that were not drawn as the current picture: none, a legacy one, or another picture", () => {
    const other: PictureIdentity = { kind: "local-reference", contract: PICTURE_CONTRACT, profileSha256: "a".repeat(64), environmentRadianceSha256: "b".repeat(64), gridRgbaSha256: "c".repeat(64) };
    const entries = [
      {},
      { sheet: { path: "sheets/legacy.jpg" } },
      { sheet: { picture: FALLBACK } },
      { sheet: { picture: other } },
    ];
    expect(sheetsNotDrawnAs(entries, FALLBACK)).toBe(2);
    expect(sheetsNotDrawnAs([{ sheet: { picture: other } }], other)).toBe(0);
    expect(sheetsNotDrawnAs([{ sheet: { picture: { ...other, gridRgbaSha256: "d".repeat(64) } } }], other)).toBe(1);
  });

  it("names the count, the picture and both ways forward in the resume refusal", () => {
    const text = resumeRefusal(3, FALLBACK);
    expect(text).toContain("refused: 3 sheet(s)");
    expect(text).toContain("approximate fallback");
    expect(text).toContain("new --out");
    expect(text).toContain("--no-sheets");
  });

  it("counts a failed sheet as not drawn, whatever picture it carries, and keeps a sheet drawn as the current picture", () => {
    const failed = { path: "sheets/failed.jpg", rendered: 0, total: 1, thumbnails: 0, judge: { ok: 0, suspect: 0, fail: 0 }, error: "renderer threw" };
    const stamped = { ...failed, picture: FALLBACK };
    const drawn = { path: "sheets/drawn.jpg", picture: FALLBACK };
    expect(sheetsNotDrawnAs([{ sheet: stamped }], FALLBACK)).toBe(1);
    expect(sheetsNotDrawnAs([{ sheet: failed }], FALLBACK)).toBe(1);
    expect(sheetsNotDrawnAs([{ sheet: drawn }], FALLBACK)).toBe(0);
  });

  it("names failed sheets as well as mismatched and unrecorded ones in the resume refusal", () => {
    const text = resumeRefusal(2, FALLBACK);
    expect(text).toContain("could not be made");
    expect(text).toContain("carry no picture record");
  });
});

describe("fab-parity setup", () => {
  it("fails an invalid configured reference before the lock, the Fab CLI or any download", async () => {
    const root = await scratch();
    const invalid = await writeReferenceProfile(join(root, "reference"), 2);
    const fabCli = await recordingFabCli(root);
    const out = join(root, "out");
    const run = await runScript("scripts/fab-parity.ts", ["--out", out], childEnvironment(root, "invalid", fabCli.path, invalid.profilePath));
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(PREVIEW_REFERENCE_ENV);
    expect(run.stderr).toContain("version must be 1");
    expect(existsSync(out)).toBe(false);
    expect(await fabCli.calls()).toEqual([]);
  });

  it("refuses --resume --sheets over a sheet with no picture record before any Fab call, and leaves the scorecard alone", async () => {
    const root = await scratch();
    const fabCli = await recordingFabCli(root);
    const out = join(root, "out");
    mkdirSync(out, { recursive: true });
    const scorecard = join(out, "scorecard.json");
    await writeFile(scorecard, JSON.stringify({ entries: [settledEntry({ path: "sheets/legacy.jpg", rendered: 1, total: 1, thumbnails: 1, judge: { ok: 1, suspect: 0, fail: 0 } })], skipped: [] }));
    const before = await readFile(scorecard, "utf8");
    const run = await runScript("scripts/fab-parity.ts", ["--out", out, "--resume"], childEnvironment(root, "legacy", fabCli.path));
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("--resume --sheets refused: 1 sheet(s)");
    expect(await fabCli.calls()).toEqual([]);
    expect(await readFile(scorecard, "utf8")).toBe(before);
  });

  it("refuses --resume --sheets over a sheet drawn as another picture, before any Fab call", async () => {
    const root = await scratch();
    const files = await writeReferenceProfile(join(root, "reference"));
    const fabCli = await recordingFabCli(root);
    const out = join(root, "out");
    mkdirSync(out, { recursive: true });
    const other = {
      kind: "local-reference",
      contract: PICTURE_CONTRACT,
      profileSha256: files.profileSha256,
      environmentRadianceSha256: files.environmentSha256,
      gridRgbaSha256: "f".repeat(64),
    };
    await writeFile(join(out, "scorecard.json"), JSON.stringify({ entries: [settledEntry({ path: "sheets/other.jpg", picture: other })], skipped: [] }));
    // This run has no reference configured, so its picture is the fallback and the stored one is a different picture.
    const run = await runScript("scripts/fab-parity.ts", ["--out", out, "--resume"], childEnvironment(root, "mismatch", fabCli.path));
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("--resume --sheets refused: 1 sheet(s)");
    expect(await fabCli.calls()).toEqual([]);
  });

  it("refuses --resume --sheets over a failed sheet that carries the current picture, before any Fab call, and leaves the scorecard alone", async () => {
    const root = await scratch();
    const fabCli = await recordingFabCli(root);
    const out = join(root, "out");
    mkdirSync(out, { recursive: true });
    const scorecard = join(out, "scorecard.json");
    // An older producer stamped this run's picture on a sheet whose render threw. Nothing was drawn, so the sheet is not kept.
    const failed = { path: "sheets/failed.jpg", rendered: 0, total: 1, thumbnails: 0, judge: { ok: 0, suspect: 0, fail: 0 }, error: "renderer threw", picture: FALLBACK };
    await writeFile(scorecard, JSON.stringify({ entries: [settledEntry(failed)], skipped: [] }));
    const before = await readFile(scorecard, "utf8");
    // No reference is configured, so this run's picture is the fallback, which the stored sheet claims.
    const run = await runScript("scripts/fab-parity.ts", ["--out", out, "--resume"], childEnvironment(root, "failed", fabCli.path));
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("--resume --sheets refused: 1 sheet(s)");
    expect(run.stderr).toContain("could not be made");
    expect(await fabCli.calls()).toEqual([]);
    expect(await readFile(scorecard, "utf8")).toBe(before);
  });

  it("resumes a matching picture: the run gets past the audit to the Fab CLI, and downloads nothing", async () => {
    const root = await scratch();
    const fabCli = await recordingFabCli(root);
    const out = join(root, "out");
    mkdirSync(out, { recursive: true });
    await writeFile(join(out, "scorecard.json"), JSON.stringify({ entries: [settledEntry({ path: "sheets/kept.jpg", picture: FALLBACK })], skipped: [] }));
    const run = await runScript("scripts/fab-parity.ts", ["--out", out, "--resume"], childEnvironment(root, "matching", fabCli.path));
    expect(run.stderr).not.toContain("refused");
    // The empty library ends the run at the corpus, after the listing and before any selection or download.
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("The corpus is empty");
    const commands = (await fabCli.calls()).map((argv) => argv[0]);
    expect(commands).toContain("library");
    expect(commands).not.toContain("download");
  });
});

describe("fidelity-sheet setup and picture", () => {
  it("exits 2 on an invalid configured reference before it creates the output directory", async () => {
    const root = await scratch();
    const invalid = await writeReferenceProfile(join(root, "reference"), 2);
    const { source, importDir } = await writeSyntheticImport(root);
    const out = join(root, "out");
    const run = await runScript("scripts/fidelity-sheet.ts", sheetArgs(source, importDir, out), childEnvironment(root, "invalid", join(root, "unused"), invalid.profilePath));
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(PREVIEW_REFERENCE_ENV);
    expect(existsSync(out)).toBe(false);
  });

  it("lights the picture with the configured reference, records the digests it applied, and leaves the neutral judge unchanged", async () => {
    const root = await scratch();
    const reference = await writeReferenceProfile(join(root, "reference"));
    const { source, importDir } = await writeSyntheticImport(root);
    const lit = join(root, "lit");
    const plain = join(root, "plain");
    const [withReference, withoutReference] = await Promise.all([
      runScript("scripts/fidelity-sheet.ts", sheetArgs(source, importDir, lit), childEnvironment(root, "lit", join(root, "unused"), reference.profilePath)),
      runScript("scripts/fidelity-sheet.ts", sheetArgs(source, importDir, plain), childEnvironment(root, "plain", join(root, "unused"))),
    ]);
    expect(withReference.code).toBe(0);
    expect(withReference.stdout).toContain("Picture: local reference");
    expect(withoutReference.code).toBe(0);
    expect(withoutReference.stdout).toContain("approximate fallback");

    // The judge is measured on the neutral render, so the reference cannot change it. The check is only meaningful with tiles judged.
    const judge = await readFile(join(plain, "fidelity.json"), "utf8");
    expect(JSON.parse(judge)).toHaveLength(1);
    expect(await readFile(join(lit, "fidelity.json"), "utf8")).toBe(judge);

    const litText = await readFile(join(lit, "picture-lighting.json"), "utf8");
    const litRecord = JSON.parse(litText) as { identity: PictureIdentity; sourceEnvironment: SourceEnvironmentReport; sourceGrid: SourceGridReport };
    expect(litRecord.identity).toEqual({
      kind: "local-reference",
      contract: PICTURE_CONTRACT,
      profileSha256: reference.profileSha256,
      environmentRadianceSha256: reference.environmentSha256,
      gridRgbaSha256: reference.gridSha256,
    });
    expect(litRecord.sourceEnvironment.radianceSha256).toBe(reference.environmentSha256);
    expect(litRecord.sourceGrid.rgbaSha256).toBe(reference.gridSha256);
    // Digests and applied reports only: no pixel arrays and no absolute paths.
    expect(litText).not.toContain(root);
    expect(litText).not.toMatch(/"(rgb|rgba)":/);

    const plainRecord = JSON.parse(await readFile(join(plain, "picture-lighting.json"), "utf8")) as Record<string, unknown>;
    expect(plainRecord.identity).toEqual(FALLBACK);
    expect(plainRecord).not.toHaveProperty("sourceEnvironment");
    expect(plainRecord).not.toHaveProperty("sourceGrid");
  });
});
