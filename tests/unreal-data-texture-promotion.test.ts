import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_TEXTURE_FORMAT, DATA_TEXTURE_VERSION, parseDataTextureManifest } from "../src/unreal/data-texture.js";
import { packageSetSha256, promoteRgba16fDataTexture } from "../src/unreal/data-texture-promotion.js";

// Promotion takes what the producer wrote (a binary and its manifest in DataTextures/) and moves both into the import
// output under the package's qualified path, or moves neither. These fixtures are written here from the same rules the
// producer follows, with the package-set hash computed independently of the module under test.

const sha = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

function halves(values: readonly number[]): Buffer {
  const bytes = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => bytes.writeUInt16LE(value, index * 2));
  return bytes;
}

const PIXELS = halves([
  0xbc00, 0x5b00, 0x0001, 0x0100, 0x8000, 0x7bff, 0x3c00, 0xc200,
  0x0200, 0x6400, 0xbbff, 0x0000, 0x3555, 0x4248, 0x7800, 0x0400,
  0xfbff, 0x8001, 0x3800, 0x3000, 0x4900, 0xa000, 0x2e66, 0x0001,
]); // 3 x 2 pixels: 48 bytes

const PACKAGE_STEM = "Pack/Content/Probe/T_Probe_PIV";

interface Fixture {
  readonly sourceDir: string;
  readonly converterOutput: string;
  readonly promotionDir: string;
}

async function writeConverterOutput(
  fixture: Fixture,
  options: { readonly stem?: string; readonly data?: Buffer } = {},
): Promise<void> {
  const stem = options.stem ?? PACKAGE_STEM;
  const name = stem.split("/").pop()!;
  const uasset = await readFile(join(fixture.sourceDir, `${stem}.uasset`));
  const uexp = await readFile(join(fixture.sourceDir, `${stem}.uexp`));
  const packageSha = sha(Buffer.concat([Buffer.from(`.uasset ${uasset.byteLength}\n`), uasset, Buffer.from(`.uexp ${uexp.byteLength}\n`), uexp]));
  const data = options.data ?? PIXELS;
  const manifest = {
    format: DATA_TEXTURE_FORMAT,
    version: DATA_TEXTURE_VERSION,
    name,
    source: {
      package: `${stem}.uasset`,
      object: name,
      objectPath: `/Game/Probe/${name}.${name}`,
      class: "Texture2D",
      sourceFormat: "TSF_RGBA16F",
      sha256: packageSha,
    },
    data: {
      file: `${name}.rgba16f-le`,
      format: "RGBA16F",
      layout: "little-endian-half4",
      width: 3,
      height: 2,
      mips: 1,
      slices: 1,
      channels: 4,
      bytesPerPixel: 8,
      bytes: 48,
      sha256: sha(PIXELS),
      srgb: false,
      colorSpace: "none",
    },
    provenance: { converter: "threenative-cue4parse test", unrealSource: "UE 4.19 Texture.cpp raw SourceArt path" },
    limits: ["Raw SourceArt bytes only."],
  };
  await mkdir(join(fixture.converterOutput, "DataTextures"), { recursive: true });
  await writeFile(join(fixture.converterOutput, "DataTextures", `${name}.rgba16f-le`), data);
  await writeFile(join(fixture.converterOutput, "DataTextures", `${name}.rgba16f.json`), `${JSON.stringify(manifest, null, 2)}\n`);
}

describe("RGBA16F data texture promotion", () => {
  let root = "";
  let fixture: Fixture;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "asset-mcp-data-texture-promotion-"));
    fixture = {
      sourceDir: join(root, "source"),
      converterOutput: join(root, "converter"),
      promotionDir: join(root, "promotion"),
    };
    await mkdir(join(fixture.sourceDir, "Pack/Content/Probe"), { recursive: true });
    await mkdir(fixture.promotionDir, { recursive: true });
    await writeFile(join(fixture.sourceDir, `${PACKAGE_STEM}.uasset`), "uasset payload for the probe");
    await writeFile(join(fixture.sourceDir, `${PACKAGE_STEM}.uexp`), "uexp payload for the probe");
  });

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  const promote = (overrides: Partial<Parameters<typeof promoteRgba16fDataTexture>[0]> = {}) =>
    promoteRgba16fDataTexture({
      converterOutput: fixture.converterOutput,
      sourceDir: fixture.sourceDir,
      selector: PACKAGE_STEM,
      promotionDir: fixture.promotionDir,
      relativeBase: "data-textures/pack/content/probe/t_probe_piv",
      package: "pack/content/probe/t_probe_piv",
      ...overrides,
    });

  it("moves the producer's binary and manifest together, byte for byte, under the qualified path", async () => {
    await writeConverterOutput(fixture);
    const promoted = await promote();
    expect(promoted).toEqual({
      name: "T_Probe_PIV",
      package: "pack/content/probe/t_probe_piv",
      data: "data-textures/pack/content/probe/t_probe_piv.rgba16f-le",
      manifest: "data-textures/pack/content/probe/t_probe_piv.rgba16f.json",
      format: "RGBA16F",
      threeTexture: "DataTexture",
      width: 3,
      height: 2,
      bytes: 48,
      sha256: sha(PIXELS),
      sourceSha256: packageSetSha256Of(fixture),
    });
    const binary = await readFile(join(fixture.promotionDir, promoted.data));
    expect(binary.equals(PIXELS)).toBe(true);
    const manifest = parseDataTextureManifest(JSON.parse(await readFile(join(fixture.promotionDir, promoted.manifest), "utf8")));
    expect(manifest.data.file).toBe("t_probe_piv.rgba16f-le");
    expect(manifest.source.package).toBe(`${PACKAGE_STEM}.uasset`);
  });

  it("keeps two packages with the same basename apart by their qualified paths", async () => {
    await writeConverterOutput(fixture);
    const first = await promote();
    // The same package file name under another folder: a different qualified path, so no collision.
    const otherStem = "Pack/Content/Other/T_Probe_PIV";
    await mkdir(join(fixture.sourceDir, "Pack/Content/Other"), { recursive: true });
    await writeFile(join(fixture.sourceDir, `${otherStem}.uasset`), "uasset payload for the other probe");
    await writeFile(join(fixture.sourceDir, `${otherStem}.uexp`), "uexp payload for the other probe");
    await rm(join(fixture.converterOutput, "DataTextures"), { recursive: true, force: true });
    await writeConverterOutput(fixture, { stem: otherStem });
    const second = await promote({
      selector: otherStem,
      relativeBase: "data-textures/pack/content/other/t_probe_piv",
      package: "pack/content/other/t_probe_piv",
    });
    expect(second.data).not.toBe(first.data);
    expect((await readdir(join(fixture.promotionDir, "data-textures/pack/content/probe"))).sort()).toEqual([
      "t_probe_piv.rgba16f-le",
      "t_probe_piv.rgba16f.json",
    ]);
    expect((await readdir(join(fixture.promotionDir, "data-textures/pack/content/other"))).sort()).toEqual([
      "t_probe_piv.rgba16f-le",
      "t_probe_piv.rgba16f.json",
    ]);
  });

  it("refuses a manifest that names another package", async () => {
    await writeConverterOutput(fixture);
    await expect(promote({ selector: "Pack/Content/Probe/Another" })).rejects.toThrow(/names Pack\/Content\/Probe\/T_Probe_PIV\.uasset, not Pack\/Content\/Probe\/Another\.uasset/);
  });

  it("refuses when the source package changed after conversion", async () => {
    await writeConverterOutput(fixture);
    await writeFile(join(fixture.sourceDir, `${PACKAGE_STEM}.uasset`), "uasset payload, tampered after conversion");
    await expect(promote()).rejects.toThrow(/source package changed after conversion/);
    expect(await readdir(fixture.promotionDir)).toEqual([]);
  });

  it("refuses a truncated binary and promotes nothing", async () => {
    await writeConverterOutput(fixture, { data: PIXELS.subarray(0, 46) });
    await expect(promote()).rejects.toThrow(/payload is 46 bytes; expected 48/);
    expect(await readdir(fixture.promotionDir)).toEqual([]);
  });

  it("refuses a binary whose bytes differ from the manifest hash", async () => {
    const tampered = Buffer.from(PIXELS);
    tampered[7]! ^= 0x10;
    await writeConverterOutput(fixture, { data: tampered });
    await expect(promote()).rejects.toThrow(/SHA-256 does not match/);
  });

  it("refuses a non-finite sample even when the manifest hash was recomputed to match", async () => {
    const forged = Buffer.from(PIXELS);
    forged.writeUInt16LE(0x7c00, 18); // +Infinity in sample 9
    await writeConverterOutput(fixture, { data: forged });
    const manifestPath = join(fixture.converterOutput, "DataTextures", "T_Probe_PIV.rgba16f.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { data: Record<string, unknown> };
    manifest.data.sha256 = sha(forged);
    manifest.data.file = "T_Probe_PIV.rgba16f-le";
    manifest.data.bytes = 48;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(promote()).rejects.toThrow(/non-finite half-float sample/);
  });

  it("refuses a manifest that claims an unsupported layout", async () => {
    await writeConverterOutput(fixture);
    const manifestPath = join(fixture.converterOutput, "DataTextures", "T_Probe_PIV.rgba16f.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { data: Record<string, unknown> };
    manifest.data.layout = "png";
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(promote()).rejects.toThrow(/layout is not little-endian-half4/);
  });

  it("refuses a manifest whose data file escapes the converter's directory", async () => {
    await writeConverterOutput(fixture);
    const manifestPath = join(fixture.converterOutput, "DataTextures", "T_Probe_PIV.rgba16f.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { data: Record<string, unknown> };
    manifest.data.file = "../../../../etc/passwd";
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(promote()).rejects.toThrow(/plain basename/);
  });

  it("refuses a promotion target outside the promotion directory", async () => {
    await writeConverterOutput(fixture);
    await expect(promote({ relativeBase: "../escaped/t_probe_piv" })).rejects.toThrow(/outside the promotion directory/);
  });

  it("refuses a qualified path that is already promoted, and leaves the first copy alone", async () => {
    await writeConverterOutput(fixture);
    const first = await promote();
    await expect(promote()).rejects.toThrow(/already promoted/);
    expect((await readFile(join(fixture.promotionDir, first.data))).equals(PIXELS)).toBe(true);
  });

  it("removes the binary when the manifest cannot be committed, so neither file is left without the other", async () => {
    await writeConverterOutput(fixture);
    await expect(promote({ afterBinaryCommit: () => { throw new Error("injected commit failure"); } }))
      .rejects.toThrow("injected commit failure");
    expect(await readdir(join(fixture.promotionDir, "data-textures/pack/content/probe")).catch(() => [])).toEqual([]);
  });

  it("refuses a converter output with no manifest or with two", async () => {
    await mkdir(join(fixture.converterOutput, "DataTextures"), { recursive: true });
    await expect(promote()).rejects.toThrow(/wrote 0 data-texture manifests/);
    await writeConverterOutput(fixture);
    await writeFile(join(fixture.converterOutput, "DataTextures", "Extra.rgba16f.json"), "{}");
    await expect(promote()).rejects.toThrow(/wrote 2 data-texture manifests/);
  });
});

/** The package-set hash of the fixture's source files, computed here without the module under test. */
function packageSetSha256Of(fixture: Fixture): string {
  return sha(Buffer.concat([
    Buffer.from(`.uasset ${Buffer.byteLength("uasset payload for the probe")}\n`), Buffer.from("uasset payload for the probe"),
    Buffer.from(`.uexp ${Buffer.byteLength("uexp payload for the probe")}\n`), Buffer.from("uexp payload for the probe"),
  ]));
}
