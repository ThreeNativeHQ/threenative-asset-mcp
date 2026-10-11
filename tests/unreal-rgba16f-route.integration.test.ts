import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ImportUnrealOutputSchema, summarize } from "../src/tools/import-unreal.js";
import { ImportError, importUnrealDirectory, type ImportReport } from "../src/unreal/importer.js";
import { describeWithTools } from "./helpers/require-tool.js";
import { Rgba16fProducer, type ProducerOutcome } from "./helpers/rgba16f-producer.js";

// The RGBA16F route through importUnrealDirectory: a PNG export that cannot encode a texture is retried once on the exact
// `--data-texture` route, on both the legacy UE Viewer path and the modern UE5 path. The binaries and manifests are made by
// the compiled production writer (tests/helpers/rgba16f-producer.ts). The UE Viewer and the modern converter are stand-ins
// with fixed answers, so the full CUE4Parse program is not built here; the synthetic typed extraction is tested separately.

/** Six pixels of stored half-float samples: negative, HDR, subnormal, alpha bits, -0, the largest finite and more. */
const SAMPLES = [
  0xbc00, 0x5b00, 0x0001, 0x0100, 0x8000, 0x7bff, 0x3c00, 0xc200, 0x0200, 0x6400, 0xbbff, 0x0000,
  0x3555, 0x4248, 0x7800, 0x0400, 0xfbff, 0x8001, 0x3800, 0x3000, 0x4900, 0xa000, 0x2e66, 0x0001,
];
/** A 1x1 PNG for the one texture UE Viewer does encode (the RGBA8 control). */
const CONTROL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** The same samples rotated by `shift`: a distinct, finite payload per package. */
function payload(shift: number): Buffer {
  const values = [...SAMPLES.slice(shift), ...SAMPLES.slice(0, shift)];
  const bytes = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => bytes.writeUInt16LE(value, index * 2));
  return bytes;
}

/** A package head with the magic, a legacy version, and a name table. Version -7 is UE4 (UE Viewer); -8 is UE5 (modern). */
function packageHead(legacyVersion: -7 | -8, names: readonly string[]): Buffer {
  const header = Buffer.alloc(24);
  header.writeUInt32LE(0x9e2a83c1, 0);
  header.writeInt32LE(legacyVersion, 4);
  header.writeInt32LE(legacyVersion === -8 ? 864 : 504, 8);
  header.writeInt32LE(522, 12);
  header.writeInt32LE(legacyVersion === -8 ? 1008 : 0, 16);
  header.writeInt32LE(names.length, 20);
  const table = names.map((name) => {
    const bytes = Buffer.from(`${name}\0`, "latin1");
    const length = Buffer.alloc(4);
    length.writeInt32LE(bytes.length, 0);
    return Buffer.concat([length, bytes]);
  });
  return Buffer.concat([header, ...table]);
}

const TEXTURE_NAMES = ["/Script/Engine", "Texture2D", "AssetImportData", "TextureSource"] as const;
const LEGACY_HEAD = packageHead(-7, TEXTURE_NAMES);
const MODERN_HEAD = packageHead(-8, TEXTURE_NAMES);

/**
 * Stands in for UE Viewer, keyed by the whole selector: namesakes share a basename, so a basename key cannot tell a legacy
 * package from a modern one. `listing` gives each package's classes, or `"fail"` for a package UE Viewer cannot list. Only
 * `pngSelectors` export a PNG; every other export exits 0 with nothing written.
 */
function fakeUmodel(path: string, listing: Record<string, readonly string[] | "fail">, pngSelectors: readonly string[], pngFile: string): Promise<void> {
  const script = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
if (argv.includes("-version")) { process.stdout.write("UE Viewer (UModel)\\nCompiled fixture\\n"); process.exit(0); }
const selector = argv.filter((entry) => !entry.startsWith("-")).pop();
const listed = ${JSON.stringify(listing)}[selector];
if (argv.includes("-list")) {
  if (listed === undefined || listed === "fail") process.exit(1);
  process.stdout.write("Found 1 game files (0 skipped) in 1 folders\\n");
  listed.forEach((className, index) => process.stdout.write("   " + index + "    1000       10 " + className + " " + path.basename(selector) + "\\n"));
  process.exit(0);
}
if (argv.includes("-export") && ${JSON.stringify(pngSelectors)}.includes(selector)) {
  const destination = path.join("Group", "Package");
  fs.mkdirSync(destination, { recursive: true });
  fs.copyFileSync(${JSON.stringify(pngFile)}, path.join(destination, path.basename(selector) + ".png"));
}
process.exit(0);
`;
  return writeFile(path, script).then(() => chmod(path, 0o755));
}

type RawStep =
  | { readonly kind: "copy"; readonly directory: string }
  | { readonly kind: "tampered"; readonly directory: string }
  | { readonly kind: "silent" }
  | { readonly kind: "refuse"; readonly reason: string }
  | { readonly kind: "crash"; readonly message: string };

interface FixturePlan {
  /**
   * The modern PNG route's answer for each package it is asked for: the source format it found, for the converter's own
   * "no decodable pixel data", or `other` for a failure that is not a PNG encoding failure.
   */
  readonly png: Record<string, string>;
  /** The `--data-texture` answer for each RGBA16F package. */
  readonly raw: Record<string, RawStep>;
}

/** Stands in for the modern converter: answers the PNG route and the `--data-texture` route from the plan, logging each call. */
function fakeModernConverter(path: string, log: string, plan: FixturePlan): Promise<void> {
  const script = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(argv) + "\\n");
if (argv.includes("--version")) { process.stdout.write("threenative-cue4parse fixture 1\\n"); process.exit(0); }
const plan = ${JSON.stringify(plan)};
const fail = (stderr, code) => { process.stderr.write(stderr); process.exit(code); };
const raw = argv.indexOf("--data-texture");
if (raw >= 0) {
  const selector = argv[raw + 1];
  const name = path.basename(selector);
  const step = plan.raw[selector];
  if (step === undefined) fail("Unhandled exception. System.IO.IOException: no fixture for " + selector + "\\n", 1);
  if (step.kind === "refuse") fail("threenative-texture-failure " + name + ": " + step.reason + "\\nUnhandled exception. System.IO.InvalidDataException: " + step.reason + "\\n", 1);
  if (step.kind === "crash") fail("Unhandled exception. System.IO.IOException: " + step.message + "\\n", 1);
  if (step.kind === "silent") process.exit(0);
  const out = argv[argv.indexOf("--export-dir") + 1];
  const directory = path.join(out, "DataTextures");
  fs.mkdirSync(directory, { recursive: true });
  for (const file of fs.readdirSync(step.directory)) fs.copyFileSync(path.join(step.directory, file), path.join(directory, file));
  if (step.kind === "tampered") {
    const binary = path.join(directory, name + ".rgba16f-le");
    const bytes = fs.readFileSync(binary);
    bytes[0] ^= 0xff;
    fs.writeFileSync(binary, bytes);
  }
  process.exit(0);
}
const selector = argv[argv.indexOf("--filter") + 1];
const name = path.basename(selector);
const format = plan.png[selector];
if (format !== undefined && format !== "other") {
  fail("threenative-texture-failure " + name + ": no decodable pixel data; platformFormat=PF_FloatRGBA, mips=1, firstMipBulk=-1, compression=TC_Default, srgb=True, sourceFormat=" + format + ", sourceCompression=TSCF_None, editorPayload=none, exportErrors=[], payload=[]\\n" +
    "Unhandled exception. System.IO.InvalidDataException: No StaticMesh, SkeletalMesh, Texture2D, TextureCube, SoundWave, or structured-data output was produced.\\n", 1);
}
fail("Unhandled exception. System.IO.IOException: the package is truncated\\n", 1);
`;
  return writeFile(path, script).then(() => chmod(path, 0o755));
}

describeWithTools(["modern-converter"], "RGBA16F route through importUnrealDirectory", () => {
  const producer = new Rgba16fProducer();
  let root = "";
  let report: ImportReport;
  let argvLog = "";
  let outputDir = "";
  let cacheDir = "";

  const LEGACY_SAME_A = "Pack/Content/LegacyA/T_Same";
  const LEGACY_SAME_B = "Pack/Content/LegacyB/T_Same";
  const LEGACY_REFUSED = "Pack/Content/Legacy/T_Refused";
  const LEGACY_TAMPERED = "Pack/Content/Legacy/T_Tampered";
  const LEGACY_SILENT = "Pack/Content/Legacy/T_Silent";
  const LEGACY_CONTROL = "Pack/Content/Legacy/T_Control";
  const MODERN_SAME_A = "Pack/Content/ModernA/T_Same";
  const MODERN_SAME_B = "Pack/Content/ModernB/T_Same";
  const MODERN_MALFORMED = "Pack/Content/Modern/T_Malformed";
  const MODERN_CRASH = "Pack/Content/Modern/T_Crash";
  const MODERN_BROKEN = "Pack/Content/Modern/T_Broken";
  const MODERN_BGRA8 = "Pack/Content/Modern/T_Bgra8";
  const RAW_SELECTORS = [LEGACY_SAME_A, LEGACY_SAME_B, LEGACY_REFUSED, LEGACY_TAMPERED, LEGACY_SILENT, MODERN_SAME_A, MODERN_SAME_B, MODERN_MALFORMED, MODERN_CRASH];
  const PROMOTED = [LEGACY_SAME_A, LEGACY_SAME_B, MODERN_SAME_A, MODERN_SAME_B];

  /** Writes one package's `.uasset` (the only file of its set) and makes its fixture with the compiled producer. */
  async function fixture(
    selector: string,
    head: Buffer,
    input: { payload: Buffer; pngCompressed?: boolean; elementCount?: number },
    sourceDir = join(root, "source"),
  ): Promise<ProducerOutcome> {
    const name = basename(selector);
    const file = join(sourceDir, `${selector}.uasset`);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, head);
    return producer.produce({
      ...input,
      name,
      packageKey: `${selector}.uasset`,
      objectPath: `/Game/${name}.${name}`,
      packageFiles: [{ extension: ".uasset", bytes: head }],
    });
  }

  beforeAll(async () => {
    await producer.setup();
    root = await mkdtemp(join(tmpdir(), "asset-mcp-rgba16f-route-"));
    const sourceDir = join(root, "source");
    outputDir = join(root, "output", "pack");
    cacheDir = join(root, "cache");
    argvLog = join(root, "converter-calls.log");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(join(root, "png"), { recursive: true });
    await writeFile(join(root, "png", "T_Control.png"), CONTROL_PNG);

    const outcomes = {
      legacySameA: await fixture(LEGACY_SAME_A, LEGACY_HEAD, { payload: payload(0) }),
      legacySameB: await fixture(LEGACY_SAME_B, LEGACY_HEAD, { payload: payload(5) }),
      legacyRefused: await fixture(LEGACY_REFUSED, LEGACY_HEAD, { payload: payload(0), pngCompressed: true }),
      legacyTampered: await fixture(LEGACY_TAMPERED, LEGACY_HEAD, { payload: payload(1) }),
      modernSameA: await fixture(MODERN_SAME_A, MODERN_HEAD, { payload: payload(2) }),
      modernSameB: await fixture(MODERN_SAME_B, MODERN_HEAD, { payload: payload(3) }),
      modernMalformed: await fixture(MODERN_MALFORMED, MODERN_HEAD, { payload: payload(0).subarray(0, 46), elementCount: 48 }),
    };
    // Each must be what the production writer does with it: the accepted ones written, the refused ones refused.
    expect(outcomes.legacySameA.ok, outcomes.legacySameA.reason).toBe(true);
    expect(outcomes.legacyRefused.ok).toBe(false);
    expect(outcomes.modernMalformed.ok).toBe(false);
    // Packages with no fixture: the control (UE Viewer's PNG), a silent converter, and the two modern failures.
    for (const [selector, head] of [[LEGACY_CONTROL, LEGACY_HEAD], [LEGACY_SILENT, LEGACY_HEAD], [MODERN_CRASH, MODERN_HEAD], [MODERN_BROKEN, MODERN_HEAD], [MODERN_BGRA8, MODERN_HEAD]] as const) {
      await mkdir(dirname(join(sourceDir, `${selector}.uasset`)), { recursive: true });
      await writeFile(join(sourceDir, `${selector}.uasset`), head);
    }

    const plan: FixturePlan = {
      png: {
        [MODERN_SAME_A]: "TSF_RGBA16F",
        [MODERN_SAME_B]: "TSF_RGBA16F",
        [MODERN_MALFORMED]: "TSF_RGBA16F",
        [MODERN_CRASH]: "TSF_RGBA16F",
        [MODERN_BGRA8]: "TSF_BGRA8",
        [MODERN_BROKEN]: "other",
      },
      raw: {
        [LEGACY_SAME_A]: { kind: "copy", directory: outcomes.legacySameA.directory },
        [LEGACY_SAME_B]: { kind: "copy", directory: outcomes.legacySameB.directory },
        [LEGACY_REFUSED]: { kind: "refuse", reason: outcomes.legacyRefused.reason ?? "" },
        [LEGACY_TAMPERED]: { kind: "tampered", directory: outcomes.legacyTampered.directory },
        [LEGACY_SILENT]: { kind: "silent" },
        [MODERN_SAME_A]: { kind: "copy", directory: outcomes.modernSameA.directory },
        [MODERN_SAME_B]: { kind: "copy", directory: outcomes.modernSameB.directory },
        [MODERN_MALFORMED]: { kind: "refuse", reason: outcomes.modernMalformed.reason ?? "" },
        [MODERN_CRASH]: { kind: "crash", message: "disk on fire" },
      },
    };
    const legacyListing = ["Texture2D"] as const;
    const umodel = join(root, "umodel");
    await fakeUmodel(
      umodel,
      {
        [LEGACY_SAME_A]: legacyListing, [LEGACY_SAME_B]: legacyListing, [LEGACY_REFUSED]: legacyListing,
        [LEGACY_TAMPERED]: legacyListing, [LEGACY_SILENT]: legacyListing, [LEGACY_CONTROL]: legacyListing,
        [MODERN_SAME_A]: "fail", [MODERN_SAME_B]: "fail", [MODERN_MALFORMED]: "fail", [MODERN_CRASH]: "fail", [MODERN_BROKEN]: "fail", [MODERN_BGRA8]: "fail",
      },
      [LEGACY_CONTROL],
      join(root, "png", "T_Control.png"),
    );
    const modern = join(root, "modern-converter");
    await fakeModernConverter(modern, argvLog, plan);

    report = await importUnrealDirectory({
      sourceDir,
      outputDir,
      concurrency: 1,
      freeSpaceBytes: 30_000_000_000,
      graphBake: false,
      engine: "UE_4.19",
      environment: { ...process.env, THREENATIVE_UNREAL_CACHE_DIR: cacheDir, THREENATIVE_TOOLCHAIN_DIR: join(root, "toolchain") },
      umodel: { name: "umodel", path: umodel, version: "fixture" },
      modernConverter: { name: "modern", path: modern, version: "fake-modern 1" },
    });
  }, 300_000);

  afterAll(async () => {
    await producer.teardown();
    if (root) await rm(root, { recursive: true, force: true });
  });

  /** Every converter call, as its argument list. */
  async function calls(): Promise<string[][]> {
    return (await readFile(argvLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as string[]);
  }

  it("promotes every RGBA16F texture the PNG route could not encode, legacy and modern alike", () => {
    expect(report.dataTextures.map((entry) => entry.package).sort()).toEqual(
      PROMOTED.map((selector) => `${selector}.uasset`).sort(),
    );
  });

  it("keeps distinct qualified namesakes apart, each with its own stored bytes", async () => {
    const byPackage = new Map(report.dataTextures.map((entry) => [entry.package, entry]));
    const expected: Record<string, Buffer> = {
      [`${LEGACY_SAME_A}.uasset`]: payload(0),
      [`${LEGACY_SAME_B}.uasset`]: payload(5),
      [`${MODERN_SAME_A}.uasset`]: payload(2),
      [`${MODERN_SAME_B}.uasset`]: payload(3),
    };
    for (const [package_, bytes] of Object.entries(expected)) {
      const entry = byPackage.get(package_);
      expect(entry, package_).toBeDefined();
      expect(entry!.name).toBe("T_Same");
      expect(entry!.data).toBe(`data-textures/${package_.slice(0, -".uasset".length)}.rgba16f-le`);
      expect((await readFile(join(outputDir, entry!.data))).equals(bytes), package_).toBe(true);
      const manifest = JSON.parse(await readFile(join(outputDir, entry!.manifest), "utf8")) as { source: { package: string } };
      expect(manifest.source.package).toBe(package_);
    }
  });

  it("keeps every refusal, crash, tamper and silent exit a failure with its own cause, and the PNG cause in front of the raw one", () => {
    const reasons = new Map(report.failed.map((entry) => [entry.package, entry.reason]));
    expect(reasons.get(`${LEGACY_REFUSED}.uasset`)).toMatch(
      /UE Viewer recognized Texture2D but produced no PNG\. The raw RGBA16F route refused it: T_Refused: the source is PNG-compressed/,
    );
    expect(reasons.get(`${LEGACY_TAMPERED}.uasset`)).toMatch(/RGBA16F data texture packaging failed \(.*\): payload SHA-256 does not match the manifest/);
    expect(reasons.get(`${LEGACY_SILENT}.uasset`)).toMatch(/RGBA16F data texture packaging failed \(.*\): the converter wrote 0 data-texture manifests/);
    expect(reasons.get(`${MODERN_MALFORMED}.uasset`)).toMatch(
      /^The modern UE5 texture converter exited 1: T_Malformed: no decodable pixel data;.* The raw RGBA16F route refused it: T_Malformed: SourceArt read is incomplete or not raw/,
    );
    expect(reasons.get(`${MODERN_CRASH}.uasset`)).toMatch(/^The modern UE5 texture converter exited 1: T_Crash: no decodable pixel data;.* The raw RGBA16F route refused it: disk on fire$/);
    expect(reasons.get(`${MODERN_BROKEN}.uasset`)).toBe("The modern UE5 texture converter exited 1: the package is truncated");
    // A PNG failure on a non-RGBA16F source is not the raw route's to answer: it stays the converter's own failure.
    expect(reasons.get(`${MODERN_BGRA8}.uasset`)).toBe(
      "The modern UE5 texture converter exited 1: T_Bgra8: no decodable pixel data; platformFormat=PF_FloatRGBA, mips=1, firstMipBulk=-1, compression=TC_Default, srgb=True, sourceFormat=TSF_BGRA8, sourceCompression=TSCF_None, editorPayload=none, exportErrors=[], payload=[]",
    );
    expect(report.failed.map((entry) => entry.package).sort()).toEqual(
      [LEGACY_REFUSED, LEGACY_TAMPERED, LEGACY_SILENT, MODERN_MALFORMED, MODERN_CRASH, MODERN_BROKEN, MODERN_BGRA8].map((selector) => `${selector}.uasset`).sort(),
    );
  });

  it("asks the exact --data-texture route only for an encoding failure, under the selector it was given", async () => {
    const raw = (await calls()).filter((args) => args.includes("--data-texture")).map((args) => args[args.indexOf("--data-texture") + 1]);
    expect([...new Set(raw)].sort()).toEqual([...RAW_SELECTORS].sort());
    expect((await calls()).some((args) => args.includes(`${LEGACY_CONTROL}`) && args.includes("--data-texture"))).toBe(false);
    expect((await calls()).some((args) => args.includes(MODERN_BROKEN) && args.includes("--data-texture"))).toBe(false);
    expect((await calls()).some((args) => args.includes(MODERN_BGRA8) && args.includes("--data-texture"))).toBe(false);
  });

  it("passes the request's engine to the legacy route only, as the UE4 pack names it", async () => {
    const legacyRaw = (await calls()).filter((args) => args.includes("--data-texture") && args[args.indexOf("--data-texture") + 1]?.includes("/Legacy"));
    expect(legacyRaw.length).toBeGreaterThan(0);
    for (const args of legacyRaw) expect(args.slice(args.indexOf("--engine"), args.indexOf("--engine") + 2)).toEqual(["--engine", "4.19"]);
    const modernRaw = (await calls()).filter((args) => args.includes("--data-texture") && args[args.indexOf("--data-texture") + 1]?.includes("/Modern"));
    expect(modernRaw.length).toBeGreaterThan(0);
    for (const args of modernRaw) expect(args.includes("--engine")).toBe(false);
  });

  it("keeps the RGBA8 control and leaves every RGBA16F texture out of the RGBA8 list and the texture stacks", () => {
    expect(report.textures.map((entry) => entry.name)).toEqual(["T_Control"]);
    expect(report.textureStacks).toEqual([]);
    expect(report.dataTextures.some((entry) => entry.name === "T_Control")).toBe(false);
    expect(report.warnings.some((warning) => warning.includes("kept as raw half-float data"))).toBe(true);
  });

  it("maps the report through the MCP output schema with the data textures counted", () => {
    const summary = summarize(report, outputDir);
    expect(summary.counts.dataTextures).toBe(PROMOTED.length);
    expect(summary.dataTextures.map((entry) => entry.package).sort()).toEqual(PROMOTED.map((selector) => `${selector}.uasset`).sort());
    expect(ImportUnrealOutputSchema.safeParse(summary).success).toBe(true);
  });

  it("leaves no staging directory, promotion temporary or partial file behind", async () => {
    const parent = dirname(outputDir);
    expect((await readdir(parent)).filter((name) => name.startsWith(".threenative-import-"))).toEqual([]);
    const cached = await readdir(cacheDir, { recursive: true }).catch(() => [] as string[]);
    expect(cached.filter((name) => basename(name).startsWith("run-"))).toEqual([]);
    const written = await readdir(outputDir, { recursive: true });
    expect(written.filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(written.filter((name) => name.endsWith(".rgba16f-le")).length).toBe(PROMOTED.length);
  });

  describe("a pack whose textures are all RGBA16F", () => {
    // Each pack is imported on its own, with its own source, stand-ins, output and cache, and holds nothing but the textures
    // named here. The shared pack above always carries an RGBA8 control, which is why it never showed an import whose only
    // output is RGBA16F being read as empty.
    const LEGACY_A = "Pack/Content/LegacyA/T_Half";
    const LEGACY_B = "Pack/Content/LegacyB/T_Half";
    const MODERN_A = "Pack/Content/ModernA/T_Half";
    const MODERN_B = "Pack/Content/ModernB/T_Half";
    const REFUSED_LEGACY = "Pack/Content/Refused/T_RefusedLegacy";
    const REFUSED_MODERN = "Pack/Content/Refused/T_RefusedModern";

    /** One RGBA16F texture of a pack: its package, whether it is UE5 (`modern`) or UE4, and the producer input that makes it. */
    interface HalfTexture {
      readonly selector: string;
      readonly modern: boolean;
      readonly input: { readonly payload: Buffer; readonly pngCompressed?: boolean; readonly elementCount?: number };
    }

    /** What one import did: the root it ran in, the report when it promoted or the error it threw, and each texture's producer outcome. */
    interface PackRun {
      readonly packRoot: string;
      readonly outputDir: string;
      readonly report?: ImportReport;
      readonly error?: unknown;
      readonly outcomes: ReadonlyMap<string, ProducerOutcome>;
    }

    const LEGACY_PACK: readonly HalfTexture[] = [
      { selector: LEGACY_A, modern: false, input: { payload: payload(0) } },
      { selector: LEGACY_B, modern: false, input: { payload: payload(5) } },
    ];
    const MODERN_PACK: readonly HalfTexture[] = [
      { selector: MODERN_A, modern: true, input: { payload: payload(2) } },
      { selector: MODERN_B, modern: true, input: { payload: payload(3) } },
    ];
    const REFUSED_PACK: readonly HalfTexture[] = [
      { selector: REFUSED_LEGACY, modern: false, input: { payload: payload(0), pngCompressed: true } },
      { selector: REFUSED_MODERN, modern: true, input: { payload: payload(0).subarray(0, 46), elementCount: 48 } },
    ];

    const packRoots: string[] = [];
    let legacyRun: PackRun;
    let modernRun: PackRun;
    let refusedRun: PackRun;

    /** Imports one pack through `importUnrealDirectory`, with the stand-ins the shared fixture uses, and keeps what it did. */
    async function importPack(name: string, textures: readonly HalfTexture[]): Promise<PackRun> {
      const packRoot = await mkdtemp(join(tmpdir(), `asset-mcp-rgba16f-${name}-`));
      packRoots.push(packRoot);
      const sourceDir = join(packRoot, "source");
      const outputDir = join(packRoot, "output", "pack");
      const cacheDir = join(packRoot, "cache");
      await mkdir(sourceDir, { recursive: true });

      const listing: Record<string, readonly string[] | "fail"> = {};
      const plan: FixturePlan = { png: {}, raw: {} };
      const outcomes = new Map<string, ProducerOutcome>();
      for (const texture of textures) {
        const outcome = await fixture(texture.selector, texture.modern ? MODERN_HEAD : LEGACY_HEAD, texture.input, sourceDir);
        outcomes.set(texture.selector, outcome);
        // UE Viewer lists a UE4 texture and exports no PNG for RGBA16F. UE5 fails its listing, and the modern PNG route refuses
        // RGBA16F as an encoding failure. Both then take the raw route, which answers as the producer did.
        listing[texture.selector] = texture.modern ? "fail" : ["Texture2D"];
        if (texture.modern) plan.png[texture.selector] = "TSF_RGBA16F";
        plan.raw[texture.selector] = outcome.ok
          ? { kind: "copy", directory: outcome.directory }
          : { kind: "refuse", reason: outcome.reason ?? "" };
      }
      const umodel = join(packRoot, "umodel");
      await fakeUmodel(umodel, listing, [], join(root, "png", "T_Control.png"));
      const converter = join(packRoot, "modern-converter");
      await fakeModernConverter(converter, join(packRoot, "converter-calls.log"), plan);
      try {
        const report = await importUnrealDirectory({
          sourceDir,
          outputDir,
          concurrency: 1,
          freeSpaceBytes: 30_000_000_000,
          graphBake: false,
          engine: "UE_4.19",
          environment: { ...process.env, THREENATIVE_UNREAL_CACHE_DIR: cacheDir, THREENATIVE_TOOLCHAIN_DIR: join(packRoot, "toolchain") },
          umodel: { name: "umodel", path: umodel, version: "fixture" },
          modernConverter: { name: "modern", path: converter, version: "fake-modern 1" },
        });
        return { packRoot, outputDir, report, outcomes };
      } catch (error) {
        return { packRoot, outputDir, error, outcomes };
      }
    }

    beforeAll(async () => {
      legacyRun = await importPack("legacy", LEGACY_PACK);
      modernRun = await importPack("modern", MODERN_PACK);
      refusedRun = await importPack("refused", REFUSED_PACK);
    }, 300_000);

    afterAll(async () => {
      for (const packRoot of packRoots) await rm(packRoot, { recursive: true, force: true });
    });

    /** The report of a pack that must promote. A failed import fails the test with the error it threw. */
    function promotedReport(run: PackRun): ImportReport {
      if (run.error !== undefined) throw run.error;
      return run.report!;
    }

    const successes = [
      { kind: "UE4 (legacy)", run: () => legacyRun, textures: LEGACY_PACK },
      { kind: "UE5 (modern)", run: () => modernRun, textures: MODERN_PACK },
    ] as const;
    for (const { kind, run, textures } of successes) {
      describe(`only ${kind} RGBA16F textures`, () => {
        it("imports with no failure, and its only output is the data textures", () => {
          const report = promotedReport(run());
          expect(report.failed).toEqual([]);
          expect(report.counts).toMatchObject({
            exported: 0,
            textures: 0,
            cubemaps: 0,
            materialAssets: 0,
            audio: 0,
            dataAssets: 0,
            textureStacks: 0,
            fonts: 0,
            bitmapFonts: 0,
            sprites: 0,
            flipbooks: 0,
            scenes: 0,
            strands: 0,
            skipped: 0,
            failed: 0,
            dataTextures: textures.length,
          });
          expect(report.dataTextures.map((entry) => entry.package).sort()).toEqual(
            textures.map((texture) => `${texture.selector}.uasset`).sort(),
          );
        });

        it("writes each binary and manifest under its qualified package, beside an import report the schema accepts", async () => {
          const report = promotedReport(run());
          const { outputDir, outcomes } = run();
          for (const texture of textures) {
            const entry = report.dataTextures.find((candidate) => candidate.package === `${texture.selector}.uasset`);
            expect(entry, texture.selector).toBeDefined();
            expect(entry).toMatchObject({
              name: "T_Half",
              data: `data-textures/${texture.selector}.rgba16f-le`,
              manifest: `data-textures/${texture.selector}.rgba16f.json`,
              width: 3,
              height: 2,
              bytes: texture.input.payload.byteLength,
              sha256: createHash("sha256").update(texture.input.payload).digest("hex"),
              sourceSha256: outcomes.get(texture.selector)?.packageSha,
            });
            expect((await readFile(join(outputDir, entry!.data))).equals(texture.input.payload), texture.selector).toBe(true);
            const manifest = JSON.parse(await readFile(join(outputDir, entry!.manifest), "utf8")) as {
              source: { package: string };
              data: { file: string };
            };
            expect(manifest.source.package).toBe(`${texture.selector}.uasset`);
            expect(manifest.data.file).toBe("T_Half.rgba16f-le");
          }
          const written = JSON.parse(await readFile(join(outputDir, "import-report.json"), "utf8")) as ImportReport;
          expect(written.counts.dataTextures).toBe(textures.length);
          expect(written.dataTextures).toEqual(report.dataTextures);
          const summary = summarize(report, outputDir);
          expect(summary.counts.dataTextures).toBe(textures.length);
          expect(ImportUnrealOutputSchema.safeParse(summary).success).toBe(true);
        });

        it("leaves no staging directory, promotion temporary or partial file behind", async () => {
          promotedReport(run());
          const { packRoot, outputDir } = run();
          expect(await readdir(join(packRoot, "output"))).toEqual(["pack"]);
          expect((await readdir(outputDir, { recursive: true })).filter((name) => name.endsWith(".tmp"))).toEqual([]);
          const cached = await readdir(join(packRoot, "cache"), { recursive: true }).catch(() => [] as string[]);
          expect(cached.filter((name) => basename(name).startsWith("run-"))).toEqual([]);
        });
      });
    }

    describe("every RGBA16F texture refused", () => {
      it("still fails UNREAL_EXPORT_EMPTY, with each raw route's cause in the reason", () => {
        expect(refusedRun.error).toBeInstanceOf(ImportError);
        expect(refusedRun.error).toMatchObject({ code: "UNREAL_EXPORT_EMPTY" });
        const message = (refusedRun.error as Error).message;
        expect(message).toContain(
          `${REFUSED_LEGACY}.uasset: UE Viewer recognized Texture2D but produced no PNG. The raw RGBA16F route refused it: T_RefusedLegacy: the source is PNG-compressed`,
        );
        expect(message).toContain(`${REFUSED_MODERN}.uasset: The modern UE5 texture converter exited 1: T_RefusedModern: no decodable pixel data;`);
        expect(message).toContain("The raw RGBA16F route refused it: T_RefusedModern: SourceArt read is incomplete or not raw");
      });

      it("names RGBA16F data textures in the empty reason", () => {
        expect((refusedRun.error as Error).message).toMatch(
          /^No package produced a valid model, texture, RGBA16F data texture, cubemap, .* nothing was promoted\./,
        );
      });

      it("promotes nothing and leaves no staging directory, promotion temporary or partial file behind", async () => {
        const { packRoot, outputDir } = refusedRun;
        expect(await readdir(outputDir).catch(() => undefined)).toBeUndefined();
        expect(await readdir(join(packRoot, "output")).catch(() => [] as string[])).toEqual([]);
        const cached = await readdir(join(packRoot, "cache"), { recursive: true }).catch(() => [] as string[]);
        expect(cached.filter((name) => basename(name).startsWith("run-"))).toEqual([]);
        expect((await readdir(packRoot, { recursive: true })).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      });
    });
  });
});
