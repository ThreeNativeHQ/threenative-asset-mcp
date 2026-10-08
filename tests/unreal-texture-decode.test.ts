import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, onTestFinished } from "vitest";

import { CUE4PARSE_PROGRAM, CUE4PARSE_SOURCE } from "../src/unreal/cue4parse-adapter.js";
import { importUnrealDirectory, modernConverterFailureCause } from "../src/unreal/importer.js";
import { writeFakeUmodel } from "./helpers/unreal-fixture.js";

async function scratch(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** A UE5 package head: the magic, legacy version -8, then a name table. */
function ue5Head(names: readonly string[]): Buffer {
  const header = Buffer.alloc(24);
  header.writeUInt32LE(0x9e2a83c1, 0);
  header.writeInt32LE(-8, 4);
  header.writeInt32LE(864, 8);
  header.writeInt32LE(522, 12);
  header.writeInt32LE(1008, 16);
  header.writeInt32LE(names.length, 20);
  const table = names.map((name) => {
    const bytes = Buffer.from(`${name}\0`, "latin1");
    const length = Buffer.alloc(4);
    length.writeInt32LE(bytes.length, 0);
    return Buffer.concat([length, bytes]);
  });
  return Buffer.concat([header, ...table]);
}

describe("editor texture payload decode (converter program)", () => {
  it("copies a block UE stored verbatim instead of asking the decoder to inflate it", () => {
    // Palms Pack 02 colour textures are PNG source art: nearly every block is incompressible, so
    // UE writes it verbatim (compressed size == raw size). The decoder returns 0 bytes for such a
    // block, which failed the whole payload and left no PNG for a texture that was in the pack.
    expect(CUE4PARSE_PROGRAM).toMatch(
      /if \(compressedSize == rawSize\) payload\.Data\.AsSpan\(inputOffset, rawSize\)\.CopyTo\(output\.AsSpan\(outputOffset, rawSize\)\);\s*\n\s*else Compression\.Decompress\(/,
    );
  });

  it("reports why a texture produced no PNG, and keeps the message the engine fallback keys on", () => {
    expect(CUE4PARSE_PROGRAM).toContain("threenative-texture-failure");
    for (const evidence of ["platformFormat=", "firstMipBulk=", "sourceCompression=", "editorPayload=", "exportErrors=", "payload="]) {
      expect(CUE4PARSE_PROGRAM).toContain(evidence);
    }
    expect(CUE4PARSE_PROGRAM).toContain("pixel data is not in the pack");
    // The causes ride after the generic message so a wrong engine profile still retries.
    expect(CUE4PARSE_PROGRAM).toMatch(/No StaticMesh, SkeletalMesh, Texture2D[^\n]*Loaded export types[^\n]*textureFailures/);
  });

  it("does not fetch a native Oodle runtime at decode time", () => {
    expect(CUE4PARSE_PROGRAM).not.toContain("OodleHelper");
  });

  it("bumps the converter version so a stale binary is rebuilt", () => {
    expect(CUE4PARSE_SOURCE.version).toBe("b4e95441+threenative.58");
    expect(CUE4PARSE_PROGRAM).toContain(`threenative-cue4parse ${CUE4PARSE_SOURCE.version}`);
  });
});

describe("modernConverterFailureCause", () => {
  const explained =
    "threenative-texture-failure T_Palm_Bark_Detail_Color: no decodable pixel data; platformFormat=, mips=0, editorPayload=Oodle/7563078B/offset 10061";

  it("prefers the converter's own texture explanation", () => {
    const stderr = `${explained}\nUnhandled exception. System.IO.InvalidDataException: No StaticMesh output was produced.\n   at Program.<Main>$`;
    expect(modernConverterFailureCause({ stdout: "", stderr })).toBe(explained.slice("threenative-texture-failure ".length));
  });

  it("falls back to the unhandled exception message", () => {
    const stderr = "Unhandled exception. System.IO.InvalidDataException: Place its .usmap mapping file here.\n   at Program";
    expect(modernConverterFailureCause({ stdout: "", stderr })).toBe("Place its .usmap mapping file here.");
  });

  it("returns nothing when stderr says nothing, and bounds a long explanation", () => {
    expect(modernConverterFailureCause({ stdout: "ok", stderr: "" })).toBeUndefined();
    const long = `threenative-texture-failure X: ${"y".repeat(5000)}`;
    expect(modernConverterFailureCause({ stdout: "", stderr: long })!.length).toBeLessThanOrEqual(801);
  });
});

describe("modern texture failure reaches failed[]", () => {
  it("states the converter's cause instead of a bare exit code", async () => {
    const root = await scratch("texture-decode-");
    const sourceDir = join(root, "source");
    const content = join(sourceDir, "Content", "Test");
    await mkdir(content, { recursive: true });
    await writeFile(join(content, "T_Bark_Color.uasset"), ue5Head(["/Script/Engine", "Texture2D", "AssetImportData", "TextureSource"]));

    const umodel = join(root, "umodel");
    await writeFakeUmodel(umodel, { classes: {}, listExitCode: 1 });
    const modern = join(root, "modern-converter");
    await writeFile(
      modern,
      `#!/usr/bin/env node
"use strict";
if (process.argv.includes("--version")) { process.stdout.write("fake-modern 1\\n"); process.exit(0); }
process.stderr.write("threenative-texture-failure T_Bark_Color: no decodable pixel data; editorPayload=none, payload=[the package holds no editor source payload and no cooked mip (pixel data is not in the pack)]\\n");
process.stderr.write("Unhandled exception. System.IO.InvalidDataException: No StaticMesh, SkeletalMesh, Texture2D, TextureCube, SoundWave, or structured-data output was produced.\\n");
process.exit(1);
`,
    );
    await chmod(modern, 0o755);

    // Nothing else imports, so the run ends in ImportError whose message carries failed[].
    const error = await importUnrealDirectory({
      sourceDir,
      outputDir: join(root, "output"),
      concurrency: 1,
      freeSpaceBytes: 30_000_000_000,
      graphBake: false,
      environment: { ...process.env, THREENATIVE_UNREAL_CACHE_DIR: join(root, "cache"), THREENATIVE_TOOLCHAIN_DIR: join(root, "toolchain") },
      umodel: { name: "umodel", path: umodel, version: "fixture" },
      modernConverter: { name: "modern", path: modern, version: "fake-modern 1" },
    }).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );

    expect(error?.message).toMatch(/T_Bark_Color\.uasset: The modern UE5 texture converter exited 1: T_Bark_Color: no decodable pixel data/);
    expect(error?.message).toContain("pixel data is not in the pack");
  }, 60_000);
});
