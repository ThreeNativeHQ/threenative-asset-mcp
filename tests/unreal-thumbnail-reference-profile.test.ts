import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertThumbnailSourceRadiance } from "../src/unreal/thumbnail-lighting.js";
import { loadThumbnailReferenceProfile, type ThumbnailReferenceProfileHooks } from "../src/unreal/thumbnail-reference-profile.js";

// Synthetic raw bytes only: 4x2 longlat radiance with values above one, and an asymmetric 3x2 RGBA8 grid.
const RADIANCE = [
  0.25, 1.5, 12.5, 0, 0.125, 1, 2, 3.5, 4096, 0.0625, 1.25, 9.75,
  1, 0.5, 2.25, 0.75, 8, 1.25, 3, 0, 64, 0.001, 1.5, 6,
];
const GRID = [
  10, 20, 30, 255, 40, 50, 60, 128, 70, 80, 90, 64,
  1, 2, 3, 0, 4, 5, 6, 200, 7, 8, 9, 100,
];
const SKY = { reference: "synthetic-sky", engine: "5.8", bytesSha256: "a".repeat(64), layout: "ue-source-longlat-rgb-f32", radianceDecode: "ue5.8-rgbe" };
const CARD = { reference: "synthetic-grid", engine: "4.19", bytesSha256: "b".repeat(64) };

type Document = Record<string, any>;
type Edit = (document: Document) => void;

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const f32le = (values: readonly number[]): Buffer => {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
  return bytes;
};

/** Stages a profile directory. Declared digests describe the bytes given; `edit` then changes the JSON before it is written. */
async function stage(options: { environment?: Buffer; grid?: Buffer; edit?: (document: Document, dir: string) => void } = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "thumbnail-reference-profile-"));
  scratch.push(dir);
  const environment = options.environment ?? f32le(RADIANCE);
  const grid = options.grid ?? Buffer.from(GRID);
  const document: Document = {
    version: 1,
    environment: { path: "env/radiance.f32", encoding: "rgb-f32le", width: 4, height: 2, sha256: sha256(environment), source: { ...SKY } },
    grid: { path: "grid/grid.rgba8", encoding: "rgba8", width: 3, height: 2, sha256: sha256(grid), source: { ...CARD } },
  };
  options.edit?.(document, dir);
  await mkdir(join(dir, "env"));
  await mkdir(join(dir, "grid"));
  await writeFile(join(dir, "env", "radiance.f32"), environment);
  await writeFile(join(dir, "grid", "grid.rgba8"), grid);
  await writeFile(join(dir, "profile.json"), JSON.stringify(document, null, 2));
  return join(dir, "profile.json");
}

describe("thumbnail reference profile loader", () => {
  it("loads a complete profile into the existing radiance shape, with digests of the bytes read", async () => {
    const profile = await stage();
    const loaded = await loadThumbnailReferenceProfile(profile);
    expect(loaded.sourceEnvironment).toMatchObject({ width: 4, height: 2 });
    expect(loaded.sourceEnvironment.rgb).toEqual(Float32Array.from(RADIANCE));
    expect(loaded.sourceEnvironment.source).toEqual(SKY);
    expect(loaded.sourceGrid).toMatchObject({ width: 3, height: 2 });
    expect(loaded.sourceGrid.rgba).toEqual(Uint8Array.from(GRID));
    expect(loaded.sourceGrid.source).toEqual(CARD);
    expect(() => assertThumbnailSourceRadiance(loaded.sourceEnvironment)).not.toThrow();
    expect(loaded.report).toEqual({
      profileSha256: sha256(await readFile(profile)),
      environmentRadianceSha256: sha256(f32le(RADIANCE)),
      gridRgbaSha256: sha256(Buffer.from(GRID)),
    });
  });

  it("keeps HDR radiance above one, unclamped, and grid rows in file order", async () => {
    const { sourceEnvironment, sourceGrid } = await loadThumbnailReferenceProfile(await stage());
    expect(sourceEnvironment.rgb[2]).toBe(12.5);
    expect(sourceEnvironment.rgb[8]).toBe(4096);
    // Top row first: the first row is bytes 0-11, and the second row starts at byte 12 with [1, 2, 3, 0].
    expect(Array.from(sourceGrid.rgba.subarray(0, 4))).toEqual([10, 20, 30, 255]);
    expect(Array.from(sourceGrid.rgba.subarray(12, 16))).toEqual([1, 2, 3, 0]);
  });

  it("decodes radiance as explicit little-endian float32, independent of host byte order", async () => {
    // 1, 2, 0.5, then 4, 3.5, 0 as little-endian binary32. Read big-endian, 0000803f is a denormal, not 1.
    const environment = Buffer.from("0000803f" + "00000040" + "0000003f" + "00008040" + "00006040" + "00000000", "hex");
    const { sourceEnvironment } = await loadThumbnailReferenceProfile(
      await stage({ environment, edit: (document) => { document.environment.width = 2; document.environment.height = 1; } }),
    );
    expect(sourceEnvironment.rgb).toEqual(Float32Array.from([1, 2, 0.5, 4, 3.5, 0]));
  });

  it("resolves relative binary paths against the profile directory, not the working directory", async () => {
    const profile = await stage();
    // Vitest runs from the project root, which holds neither env/ nor grid/; workers cannot chdir, so none is attempted.
    expect(process.cwd()).not.toBe(dirname(profile));
    const { sourceEnvironment, sourceGrid } = await loadThumbnailReferenceProfile(profile);
    expect(sourceEnvironment.rgb).toEqual(Float32Array.from(RADIANCE));
    expect(sourceGrid.rgba).toEqual(Uint8Array.from(GRID));
  });

  it("never falls back to a same-named file in the working directory", async () => {
    // package.json sits at the project root. Relative to the profile directory it is absent, so the load must refuse.
    const profile = await stage({ edit: (document) => { document.grid.path = "package.json"; } });
    await expect(loadThumbnailReferenceProfile(profile)).rejects.toThrow(join(dirname(profile), "package.json"));
  });

  it("accepts absolute local binary paths", async () => {
    const profile = await stage({
      edit: (document, dir) => {
        document.environment.path = join(dir, "env", "radiance.f32");
        document.grid.path = join(dir, "grid", "grid.rgba8");
      },
    });
    const { sourceEnvironment, sourceGrid } = await loadThumbnailReferenceProfile(profile);
    expect(sourceEnvironment.rgb).toEqual(Float32Array.from(RADIANCE));
    expect(sourceGrid.rgba).toEqual(Uint8Array.from(GRID));
  });

  it.each([
    ["https URL", "https://example.com/radiance.f32"],
    ["file URL", "file:///tmp/radiance.f32"],
    ["backslash UNC share", "\\\\server\\share\\radiance.f32"],
    ["slash UNC share", "//server/share/radiance.f32"],
    ["NUL byte", "env/radiance\u0000.f32"],
    ["empty", ""],
  ])("refuses the %s binary path", async (_label, binaryPath) => {
    const profile = await stage({ edit: (document) => { document.environment.path = binaryPath; } });
    await expect(loadThumbnailReferenceProfile(profile)).rejects.toThrow(/must be a local path|must be a nonempty path/);
  });

  it("refuses a URL as the profile path itself, before reading anything", async () => {
    await expect(loadThumbnailReferenceProfile("https://example.com/profile.json")).rejects.toThrow(/must be a local path/);
  });

  it.each<[string, Edit]>([
    ["root", (document) => { document.exposure = 2; }],
    ["environment", (document) => { document.environment.intensity = 1.5; }],
    ["environment source", (document) => { document.environment.source.orientation = 90; }],
    ["grid", (document) => { document.grid.floor = "checker"; }],
    ["grid source", (document) => { document.grid.source.lights = []; }],
  ])("refuses an unknown field at the %s level, so the profile cannot tune the renderer", async (_label, edit) => {
    await expect(loadThumbnailReferenceProfile(await stage({ edit }))).rejects.toThrow(/has unknown field/);
  });

  it.each<[string, Edit, RegExp]>([
    ["a missing radiance digest", (document) => { delete document.environment.sha256; }, /environment is missing sha256/],
    ["a missing grid", (document) => { delete document.grid; }, /profile is missing grid/],
  ])("refuses a profile with %s", async (_label, edit, message) => {
    await expect(loadThumbnailReferenceProfile(await stage({ edit }))).rejects.toThrow(message);
  });

  it.each<[string, Edit, RegExp]>([
    ["version 2", (document) => { document.version = 2; }, /version must be 1/],
    ["string version", (document) => { document.version = "1"; }, /version must be 1/],
    ["radiance encoding", (document) => { document.environment.encoding = "rgb-f16le"; }, /environment\.encoding/],
    ["grid encoding", (document) => { document.grid.encoding = "rgb-f32le"; }, /grid\.encoding/],
    ["radiance layout", (document) => { document.environment.source.layout = "ue-cube-rgb-f32"; }, /environment\.source\.layout/],
    ["radiance decode", (document) => { document.environment.source.radianceDecode = "ue3-rgbe"; }, /environment\.source\.radianceDecode/],
  ])("refuses %s", async (_label, edit, message) => {
    await expect(loadThumbnailReferenceProfile(await stage({ edit }))).rejects.toThrow(message);
  });

  it.each<[string, Edit, RegExp]>([
    ["zero radiance width", (document) => { document.environment.width = 0; }, /environment\.width must be a whole number/],
    ["negative radiance height", (document) => { document.environment.height = -1; }, /environment\.height must be a whole number/],
    ["fractional radiance width", (document) => { document.environment.width = 1.5; }, /environment\.width must be a whole number/],
    ["string radiance width", (document) => { document.environment.width = "4"; }, /environment\.width must be a whole number/],
    ["null radiance height", (document) => { document.environment.height = null; }, /environment\.height must be a whole number/],
    ["oversized grid width", (document) => { document.grid.width = 16385; }, /grid\.width must be a whole number/],
    ["radiance above the byte cap", (document) => { document.environment.width = 16384; document.environment.height = 16384; }, /above the 512 MiB limit/],
  ])("refuses malformed dimensions: %s", async (_label, edit, message) => {
    await expect(loadThumbnailReferenceProfile(await stage({ edit }))).rejects.toThrow(message);
  });

  it("refuses dimensions that do not match the bytes on disk", async () => {
    await expect(loadThumbnailReferenceProfile(await stage({ edit: (document) => { document.environment.width = 5; } })))
      .rejects.toThrow(/has 96 bytes, expected 120/);
    await expect(loadThumbnailReferenceProfile(await stage({ edit: (document) => { document.grid.width = 2; } })))
      .rejects.toThrow(/has 24 bytes, expected 16/);
  });

  it.each<[string, Edit, RegExp]>([
    ["short radiance digest", (document) => { document.environment.sha256 = "abc"; }, /environment\.sha256 must be a lowercase SHA-256/],
    ["uppercase grid digest", (document) => { document.grid.sha256 = "A".repeat(64); }, /grid\.sha256 must be a lowercase SHA-256/],
    ["non-hex provenance digest", (document) => { document.environment.source.bytesSha256 = "g".repeat(64); }, /environment\.source\.bytesSha256 must be a lowercase SHA-256/],
    ["empty reference", (document) => { document.environment.source.reference = ""; }, /environment\.source\.reference must be/],
    ["blank grid engine", (document) => { document.grid.source.engine = "   "; }, /grid\.source\.engine must be/],
    ["overlong radiance engine", (document) => { document.environment.source.engine = "x".repeat(257); }, /environment\.source\.engine must be/],
  ])("refuses malformed digests and provenance: %s", async (_label, edit, message) => {
    await expect(loadThumbnailReferenceProfile(await stage({ edit }))).rejects.toThrow(message);
  });

  it("refuses bytes that do not match their declared SHA-256", async () => {
    await expect(loadThumbnailReferenceProfile(await stage({ edit: (document) => { document.environment.sha256 = "0".repeat(64); } })))
      .rejects.toThrow(/does not match its declared sha256/);
    await expect(loadThumbnailReferenceProfile(await stage({ edit: (document) => { document.grid.sha256 = "0".repeat(64); } })))
      .rejects.toThrow(/does not match its declared sha256/);
  });

  it("refuses truncated or oversized binaries even when the declared digest matches them", async () => {
    const radiance = f32le(RADIANCE);
    await expect(loadThumbnailReferenceProfile(await stage({ environment: radiance.subarray(0, -4) })))
      .rejects.toThrow(/has 92 bytes, expected 96/);
    await expect(loadThumbnailReferenceProfile(await stage({ environment: Buffer.concat([radiance, Buffer.alloc(4)]) })))
      .rejects.toThrow(/has 100 bytes, expected 96/);
    await expect(loadThumbnailReferenceProfile(await stage({ grid: Buffer.from(GRID).subarray(0, 20) })))
      .rejects.toThrow(/has 20 bytes, expected 24/);
  });

  it.each([NaN, Infinity, -Infinity, -1])("refuses a radiance sample of %s", async (value) => {
    const samples = [...RADIANCE];
    samples[5] = value;
    await expect(loadThumbnailReferenceProfile(await stage({ environment: f32le(samples) })))
      .rejects.toThrow(/sample 5 is .*finite and nonnegative/);
  });

  it("returns owned typed arrays and frozen metadata with no fields beyond the schema", async () => {
    const { sourceEnvironment, sourceGrid, report } = await loadThumbnailReferenceProfile(await stage());
    // Each array owns its whole buffer, so none is a view into a shared or pooled file read.
    expect(sourceEnvironment.rgb.byteOffset).toBe(0);
    expect(sourceEnvironment.rgb.buffer.byteLength).toBe(sourceEnvironment.rgb.byteLength);
    expect(sourceGrid.rgba.byteOffset).toBe(0);
    expect(sourceGrid.rgba.buffer.byteLength).toBe(sourceGrid.rgba.byteLength);
    expect(Object.keys(sourceEnvironment).sort()).toEqual(["height", "rgb", "source", "width"]);
    expect(Object.keys(sourceGrid).sort()).toEqual(["height", "rgba", "source", "width"]);
    expect(Object.keys(sourceEnvironment.source).sort()).toEqual(["bytesSha256", "engine", "layout", "radianceDecode", "reference"]);
    expect(Object.keys(sourceGrid.source).sort()).toEqual(["bytesSha256", "engine", "reference"]);
    expect(Object.keys(report).sort()).toEqual(["environmentRadianceSha256", "gridRgbaSha256", "profileSha256"]);
    for (const metadata of [sourceEnvironment, sourceEnvironment.source, sourceGrid, sourceGrid.source, report]) {
      expect(Object.isFrozen(metadata)).toBe(true);
    }
  });

  it("reports the same digests for the same bytes on every load", async () => {
    const profile = await stage();
    const first = await loadThumbnailReferenceProfile(profile);
    const second = await loadThumbnailReferenceProfile(profile);
    expect(second.report).toEqual(first.report);
    expect(second.sourceEnvironment.rgb).toEqual(first.sourceEnvironment.rgb);
    expect(second.sourceGrid.rgba).toEqual(first.sourceGrid.rgba);
  });

  it("validates the whole document before opening any binary", async () => {
    const profile = await stage({ edit: (document) => { document.environment.encoding = "rgb-f16le"; } });
    await rm(join(dirname(profile), "env"), { recursive: true });
    await expect(loadThumbnailReferenceProfile(profile)).rejects.toThrow(/environment\.encoding/);
  });

  it("rejects a missing profile instead of falling back", async () => {
    const profile = await stage();
    await expect(loadThumbnailReferenceProfile(join(dirname(profile), "absent.json"))).rejects.toThrow(/ENOENT/);
  });

  it("rejects unparseable JSON instead of falling back", async () => {
    const profile = await stage();
    await writeFile(profile, "{ not json");
    await expect(loadThumbnailReferenceProfile(profile)).rejects.toThrow(/invalid thumbnail reference profile/);
  });

  it("rejects a missing binary instead of falling back", async () => {
    const profile = await stage();
    await rm(join(dirname(profile), "grid"), { recursive: true });
    await expect(loadThumbnailReferenceProfile(profile)).rejects.toThrow(/ENOENT/);
  });
});

interface IoRecord {
  readonly handles: FileHandle[];
  readonly reads: Array<{ readonly file: string; readonly offset: number; readonly length: number }>;
  readonly hooks: ThumbnailReferenceProfileHooks;
}

/** Records every descriptor the loader opens and every bounded read it asks for. */
function recordIo(): IoRecord {
  const handles: FileHandle[] = [];
  const reads: IoRecord["reads"] = [];
  return {
    handles,
    reads,
    hooks: {
      opened: (_file, handle) => { handles.push(handle); },
      read: (file, offset, length) => { reads.push({ file, offset, length }); },
    },
  };
}

/** A closed FileHandle reports fd -1: exactly `count` descriptors were opened, and each one is closed. */
function expectClosed(handles: readonly FileHandle[], count: number): void {
  expect(handles.map((handle) => handle.fd)).toEqual(Array.from({ length: count }, () => -1));
}

describe("thumbnail reference profile IO bounds", () => {
  it("keeps reading the descriptor it opened when the radiance path is swapped for an oversized file", async () => {
    const profile = await stage();
    const directory = dirname(profile);
    const environmentFile = join(directory, "env", "radiance.f32");
    let swapped = false;
    const loaded = await loadThumbnailReferenceProfile(profile, {
      checked: async (file) => {
        if (file !== environmentFile) return;
        swapped = true;
        const oversized = join(directory, "env", "oversized.f32");
        await writeFile(oversized, Buffer.alloc(2 * 1024 * 1024));
        await rename(oversized, environmentFile); // replaces the path only, as an editor's atomic save does
      },
    });
    expect(swapped).toBe(true);
    expect(loaded.sourceEnvironment.rgb).toEqual(Float32Array.from(RADIANCE));
    expect(loaded.report.environmentRadianceSha256).toBe(sha256(f32le(RADIANCE)));
  });

  it("rejects a radiance file that grows in place after its size check, and never reads past one byte beyond its size", async () => {
    const profile = await stage();
    const environmentFile = join(dirname(profile), "env", "radiance.f32");
    const io = recordIo();
    await expect(
      loadThumbnailReferenceProfile(profile, {
        ...io.hooks,
        checked: async (file) => {
          if (file === environmentFile) await appendFile(file, Buffer.alloc(1024 * 1024));
        },
      }),
    ).rejects.toThrow(/radiance .* changed size while it was read/);
    const radianceReads = io.reads.filter((request) => request.file === environmentFile);
    expect(radianceReads, "radiance was read through bounded requests").not.toHaveLength(0);
    // 96 bytes plus one excess byte: the furthest request ends at byte 97, so the appended megabyte is never read.
    expect(Math.max(...radianceReads.map((request) => request.offset + request.length))).toBe(97);
  });

  it("rejects an oversized profile from its size, before reading any of it", async () => {
    const profile = await stage();
    // Valid JSON padded with whitespace past the 64 KiB cap: only the size check can refuse it.
    await writeFile(profile, Buffer.concat([await readFile(profile), Buffer.alloc(64 * 1024, 0x20)]));
    const io = recordIo();
    await expect(loadThumbnailReferenceProfile(profile, io.hooks)).rejects.toThrow(/profile .* has \d+ bytes, above the 65536 byte limit/);
    expect(io.reads).toEqual([]);
    expectClosed(io.handles, 1);
  });

  it("rejects a profile path that is not a regular file, before reading any of it", async () => {
    const io = recordIo();
    await expect(loadThumbnailReferenceProfile(dirname(await stage()), io.hooks)).rejects.toThrow(/profile .* is not a regular file/);
    expect(io.reads).toEqual([]);
    expectClosed(io.handles, 1);
  });

  it("rejects a profile that grows past the cap after its size check, and never reads past one byte beyond the cap", async () => {
    const profile = await stage();
    const io = recordIo();
    await expect(
      loadThumbnailReferenceProfile(profile, {
        ...io.hooks,
        checked: async (file) => {
          if (file === profile) await appendFile(file, Buffer.alloc(64 * 1024, 0x20));
        },
      }),
    ).rejects.toThrow(/profile .* changed size while it was read/);
    const profileReads = io.reads.filter((request) => request.file === profile);
    expect(profileReads, "profile was read through bounded requests").not.toHaveLength(0);
    expect(Math.max(...profileReads.map((request) => request.offset + request.length))).toBe(64 * 1024 + 1);
  });

  it("closes every descriptor after a successful load", async () => {
    const io = recordIo();
    await loadThumbnailReferenceProfile(await stage(), io.hooks);
    expectClosed(io.handles, 3);
  });

  it.each<[string, Edit, RegExp, number]>([
    ["a size mismatch", (document) => { document.environment.width = 5; }, /has 96 bytes, expected 120/, 2],
    ["a digest mismatch", (document) => { document.environment.sha256 = "0".repeat(64); }, /does not match its declared sha256/, 2],
    ["a radiance path that is not a regular file", (document) => { document.environment.path = "env"; }, /radiance .* is not a regular file/, 2],
  ])("closes every descriptor when the load fails on %s", async (_label, edit, message, count) => {
    const io = recordIo();
    await expect(loadThumbnailReferenceProfile(await stage({ edit }), io.hooks)).rejects.toThrow(message);
    expectClosed(io.handles, count);
  });

  it("closes the radiance descriptor when a hook throws while it is open", async () => {
    const profile = await stage();
    const environmentFile = join(dirname(profile), "env", "radiance.f32");
    const io = recordIo();
    await expect(
      loadThumbnailReferenceProfile(profile, {
        ...io.hooks,
        checked: (file) => {
          if (file === environmentFile) throw new Error("injected");
        },
      }),
    ).rejects.toThrow("injected");
    expectClosed(io.handles, 2);
  });
});
