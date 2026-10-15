/** Synthetic Unity content for tests. Nothing here is real or licensed. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { onTestFinished } from "vitest";

export interface FixtureFile {
  /** Project path, for example `Assets/Models/crate.fbx`. */
  readonly path: string;
  /** Absent for a folder asset. */
  readonly content?: string;
  /** Binary content, used instead of `content` (images, FBX). */
  readonly data?: Buffer;
  /** The importer block of the `.meta` (for example `ModelImporter:\n  meshes:\n    globalScale: 2`). */
  readonly importer?: string;
  readonly preview?: boolean;
  /** A real `preview.png` (PNG bytes), instead of the placeholder text `preview` writes. */
  readonly previewData?: Buffer;
  /** Path the guid derives from, when it differs from `path` (a UPM tarball stores relative paths). */
  readonly guidPath?: string;
}

export function guidFor(path: string): string {
  return createHash("sha1").update(path).digest("hex").slice(0, 32);
}

export function metaFor(path: string, folder: boolean, importer?: string): string {
  const body = folder ? "folderAsset: yes\n" : importer ? `${importer}\n` : "NativeFormatImporter:\n  externalObjects: {}\n";
  return `fileFormatVersion: 2\nguid: ${guidFor(path)}\n${body}`;
}

const isFolder = (file: FixtureFile): boolean => file.content === undefined && file.data === undefined;

export async function scratchDirectory(prefix = "unity-test-", parent = tmpdir()): Promise<string> {
  const directory = await mkdtemp(join(parent, prefix));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** The same logical content the three shapes below all encode. */
export function logicalFiles(prefix: string): FixtureFile[] {
  return [
    { path: `${prefix}/Models` },
    { path: `${prefix}/Models/crate.fbx`, content: "fake fbx bytes" },
    { path: `${prefix}/Textures` },
    { path: `${prefix}/Textures/crate_albedo.png`, content: "fake png bytes", preview: true },
    { path: `${prefix}/Materials` },
    { path: `${prefix}/Materials/crate.mat`, content: "%YAML 1.1\n" },
    { path: `${prefix}/Prefabs` },
    { path: `${prefix}/Prefabs/crate.prefab`, content: "%YAML 1.1\n" },
    { path: `${prefix}/Shaders` },
    { path: `${prefix}/Shaders/water.shadergraph`, content: "{}" },
    { path: `${prefix}/Scenes` },
    { path: `${prefix}/Scenes/main.unity`, content: "%YAML 1.1\n" },
    { path: `${prefix}/notes.txt`, content: "hello" },
  ];
}

function tar(args: string[], cwd: string): void {
  execFileSync("tar", args, { cwd, stdio: "ignore" });
}

async function put(file: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}

/** A project folder: each file beside a `.meta`. */
export async function writeProjectFolder(root: string, files: readonly FixtureFile[]): Promise<void> {
  for (const file of files) {
    if (isFolder(file)) await mkdir(join(root, file.path), { recursive: true });
    else await put(join(root, file.path), file.data ?? file.content!);
    await put(join(root, `${file.path}.meta`), metaFor(file.guidPath ?? file.path, isFolder(file), file.importer));
  }
}

/** Writes `<guid>/{asset,asset.meta,pathname,preview.png}` folders into `staging`. */
export async function writePackageTree(
  staging: string,
  files: readonly FixtureFile[],
  pathnameOf: (file: FixtureFile) => string = (file) => file.path,
): Promise<string[]> {
  const folders: string[] = [];
  for (const file of files) {
    const guid = guidFor(file.path);
    folders.push(guid);
    if (!isFolder(file)) await put(join(staging, guid, "asset"), file.data ?? file.content!);
    if (file.previewData) await put(join(staging, guid, "preview.png"), file.previewData);
    else if (file.preview) await put(join(staging, guid, "preview.png"), "fake preview");
    await put(join(staging, guid, "asset.meta"), metaFor(file.path, isFolder(file), file.importer));
    await put(join(staging, guid, "pathname"), `${pathnameOf(file)}\n00`);
  }
  return folders;
}

export async function writeUnityPackage(archive: string, files: readonly FixtureFile[]): Promise<void> {
  const staging = await scratchDirectory("unity-stage-");
  const folders = await writePackageTree(staging, files);
  tar(["-czf", archive, ...folders], staging);
}

/** A UPM tarball: `package/package.json` and files with sibling `.meta`, paths relative to the package. */
export async function writeUpmTarball(archive: string, name: string, files: readonly FixtureFile[]): Promise<void> {
  const staging = await scratchDirectory("unity-upm-");
  const prefix = `Packages/${name}/`;
  await writeProjectFolder(
    join(staging, "package"),
    files.map((file) => ({ ...file, guidPath: file.path, path: file.path.slice(prefix.length) })),
  );
  tar(["-czf", archive, "package"], staging);
}

/** Packs hostile members with GNU tar. `-P` keeps `..` and absolute names. */
export function tarWith(archive: string, cwd: string, members: readonly string[], extra: readonly string[] = []): void {
  tar(["-czPf", archive, ...extra, ...members], cwd);
}

/**
 * Runs a repo script through node's tsx loader with a private TMPDIR. tsx writes its transform cache into TMPDIR, which the
 * leak gate counts as a leak, so the child gets a directory of its own that the test removes (as `tests/unity-intake.test.ts` does).
 */
export async function runScript(script: string, args: readonly string[], timeout = 120_000): Promise<{ stdout: string; stderr: string }> {
  const { execFile } = await import("node:child_process");
  const { createRequire } = await import("node:module");
  const { pathToFileURL } = await import("node:url");
  const { promisify } = await import("node:util");
  const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;
  const cache = await scratchDirectory("tsx-cache-");
  return promisify(execFile)(process.execPath, ["--import", loader, script, ...args], { cwd: process.cwd(), timeout, env: { ...process.env, TMPDIR: cache } });
}
