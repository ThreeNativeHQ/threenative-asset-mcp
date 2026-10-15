/**
 * Unity package intake: turns a `.unitypackage`, a UPM tarball or a project folder into one
 * `UnityAssetDatabase` (guid -> path, `.meta` text, asset file, optional preview).
 *
 * The guid database rules (a package is `<guid>/{asset,asset.meta,pathname,preview.png}`; a project
 * or UPM tree pairs each file with a sibling `.meta`; the guid in the `.meta` names the asset) follow
 * V-Sekai/unidot_importer `asset_database.gd` (MIT, Copyright (c) V-Sekai contributors), re-written
 * here from the format description. No Unidot code is copied.
 *
 * Every archive member name and every `pathname` is untrusted. The archive is listed first, any link
 * member, absolute name, `..` segment or drive letter is refused with the offending entry named, and
 * only then is `tar` run, into a private staging directory that `dispose()` removes.
 */
import { existsSync } from "node:fs";
import { lstat, mkdtemp, open, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";

import { runBounded } from "../unreal/toolchain.js";

export type UnityPackageShape = "unitypackage" | "upm" | "project";

export interface UnityAssetEntry {
  readonly guid: string;
  /** Project path such as `Assets/Models/a.fbx`; UPM content is `Packages/<name>/...`. */
  readonly path: string;
  readonly metaYaml: string;
  /** Absent for a folder asset (a `.meta` and a `pathname` with no content). */
  readonly assetFile?: string;
  readonly previewFile?: string;
}

export interface UnityAssetDatabase {
  readonly shape: UnityPackageShape;
  readonly entries: ReadonlyMap<string, UnityAssetEntry>;
  /** Removes the staging directory. Safe to call more than once; a project folder has none. */
  dispose(): Promise<void>;
}

export type UnityPackageErrorCode =
  | "UNITY_PACKAGE_UNREADABLE"
  | "UNITY_PACKAGE_UNSAFE_ENTRY"
  | "UNITY_PACKAGE_INVALID";

export class UnityPackageError extends Error {
  constructor(
    readonly code: UnityPackageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "UnityPackageError";
  }
}

const GUID = /^[0-9a-f]{32}$/;
const MEMBER_DIRECTORY_OR_FILE = /^([0-9a-f]{32})(?:\/(asset|asset\.meta|pathname|preview\.png))?$/;
const LISTING_BYTES = 128 * 1024 * 1024;

function unsafe(what: string, entry: string): UnityPackageError {
  return new UnityPackageError(
    "UNITY_PACKAGE_UNSAFE_ENTRY",
    `Refused ${what}: ${JSON.stringify(entry)}.`,
  );
}

/** Throws when a path could leave its root: absolute, UNC, drive letter, NUL or a `..` segment. */
export function assertSafeRelativePath(path: string, what: string): void {
  if (
    path.length === 0 ||
    path.includes("\0") ||
    /^[\\/]/.test(path) ||
    /^[A-Za-z]:/.test(path) ||
    path.split(/[\\/]/).includes("..")
  ) {
    throw unsafe(what, path);
  }
}

async function tarNames(archive: string, verbose: boolean): Promise<string[]> {
  const run = await runBounded("tar", [verbose ? "tvzf" : "tzf", archive], {
    timeoutMs: 300_000,
    maxOutputBytes: LISTING_BYTES,
  });
  if (run.code !== 0) {
    throw new UnityPackageError(
      "UNITY_PACKAGE_UNREADABLE",
      `Listing ${archive} failed (tar exit ${run.code}). The file may be corrupt or encrypted.`,
    );
  }
  return run.stdout.split("\n").filter((line) => line.length > 0);
}

/**
 * Lists the members and refuses any that could escape staging or alias another file. The plain and
 * the verbose listing are read in step: the verbose one gives each member's type letter, the plain one
 * gives its exact name.
 */
async function listSafeMembers(archive: string): Promise<string[]> {
  const names = await tarNames(archive, false);
  const verbose = await tarNames(archive, true);
  if (names.length !== verbose.length) {
    throw unsafe("archive member with a line break in its name", archive);
  }
  names.forEach((name, index) => {
    const type = verbose[index]?.[0] ?? "?";
    if (type === "l" || type === "h") throw unsafe(type === "l" ? "symlink member" : "hardlink member", name);
    if (type !== "-" && type !== "d") throw unsafe("special file member", name);
    assertSafeRelativePath(name, "archive member");
  });
  return names.map((name) => name.replace(/^(\.\/)+/, "").replace(/\/$/, "")).filter((name) => name !== "" && name !== ".");
}

async function extract(archive: string, into: string): Promise<void> {
  const run = await runBounded(
    "tar",
    ["xzf", archive, "-C", into, "--no-same-owner", "--no-same-permissions"],
    { timeoutMs: 600_000 },
  );
  if (run.code !== 0) {
    throw new UnityPackageError(
      "UNITY_PACKAGE_UNREADABLE",
      `Extracting ${archive} failed (tar exit ${run.code}).`,
    );
  }
}

async function isGzip(file: string): Promise<boolean> {
  const handle = await open(file, "r");
  try {
    const head = Buffer.alloc(2);
    await handle.read(head, 0, 2, 0);
    return head[0] === 0x1f && head[1] === 0x8b;
  } finally {
    await handle.close();
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** `guid:` of a `.meta`, or undefined. A `.meta` is one plain YAML document, so a line match is enough. */
export function metaGuid(metaYaml: string): string | undefined {
  const match = /^guid:\s*"?([0-9a-fA-F]{32})"?\s*$/m.exec(metaYaml);
  return match?.[1]?.toLowerCase();
}

async function buildFromPackage(staging: string, members: string[]): Promise<Map<string, UnityAssetEntry>> {
  const guids = new Set<string>();
  for (const member of members) {
    const match = MEMBER_DIRECTORY_OR_FILE.exec(member);
    if (match?.[1]) guids.add(match[1]);
    // Anything else (for example the `.icon.png` newer packages carry) is ignored, never read.
  }
  const entries = new Map<string, UnityAssetEntry>();
  for (const guid of [...guids].sort()) {
    const folder = join(staging, guid);
    const pathnameFile = join(folder, "pathname");
    if (!(await exists(pathnameFile)) || !(await exists(join(folder, "asset.meta")))) {
      throw new UnityPackageError("UNITY_PACKAGE_INVALID", `Package entry ${guid} has no pathname or asset.meta.`);
    }
    const pathname = ((await readFile(pathnameFile, "utf8")).split(/\r?\n/)[0] ?? "").trim();
    assertSafeRelativePath(pathname, `pathname of ${guid}`);
    const assetFile = join(folder, "asset");
    const previewFile = join(folder, "preview.png");
    entries.set(guid, {
      guid,
      path: pathname.replace(/\\/g, "/"),
      metaYaml: await readFile(join(folder, "asset.meta"), "utf8"),
      ...((await exists(assetFile)) ? { assetFile } : {}),
      ...((await exists(previewFile)) ? { previewFile } : {}),
    });
  }
  return entries;
}

/** Walks `directory`, pairing each `X.meta` with `X`. Refuses symlinks. Orphan `.meta` files are skipped. */
async function scanMetaTree(
  directory: string,
  projectPath: string,
  into: Map<string, UnityAssetEntry>,
): Promise<void> {
  for (const dirent of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, dirent.name);
    const path = posix.join(projectPath, dirent.name);
    if (dirent.isSymbolicLink()) throw unsafe("symlink in project", path);
    if (dirent.isDirectory()) await scanMetaTree(full, path, into);
    if (!dirent.isFile() || !dirent.name.endsWith(".meta")) continue;
    const assetPath = full.slice(0, -".meta".length);
    const asset = await lstat(assetPath).catch(() => undefined);
    if (!asset) continue;
    if (asset.isSymbolicLink()) throw unsafe("symlink in project", path.slice(0, -".meta".length));
    const metaYaml = await readFile(full, "utf8");
    const guid = metaGuid(metaYaml);
    if (!guid) throw new UnityPackageError("UNITY_PACKAGE_INVALID", `No guid in ${path}.`);
    into.set(guid, {
      guid,
      path: path.slice(0, -".meta".length),
      metaYaml,
      ...(asset.isFile() ? { assetFile: assetPath } : {}),
    });
  }
}

async function packageName(packageJson: string): Promise<string> {
  try {
    const name = (JSON.parse(await readFile(packageJson, "utf8")) as { name?: unknown }).name;
    if (typeof name === "string" && /^[A-Za-z0-9._-]+$/.test(name)) return name;
  } catch {
    // fall through to the generic name
  }
  return "package";
}

async function buildFromProject(root: string): Promise<{ entries: Map<string, UnityAssetEntry>; upm: boolean }> {
  const entries = new Map<string, UnityAssetEntry>();
  if (await exists(join(root, "package.json"))) {
    await scanMetaTree(root, `Packages/${await packageName(join(root, "package.json"))}`, entries);
    return { entries, upm: true };
  }
  const roots = ["Assets", "Packages"].filter((name) => existsSync(join(root, name)));
  if (roots.length === 0) {
    throw new UnityPackageError("UNITY_PACKAGE_INVALID", `${root} has no Assets or Packages folder and no package.json.`);
  }
  for (const name of roots) await scanMetaTree(join(root, name), name, entries);
  return { entries, upm: false };
}

/**
 * Opens a `.unitypackage`, a UPM tarball (`.tgz`) or a project folder. Call `dispose()` when done: for
 * archives it removes the staging directory. The database stays valid until then.
 */
export async function openUnityPackage(source: string): Promise<UnityAssetDatabase> {
  const info = await stat(source).catch(() => undefined);
  if (!info) throw new UnityPackageError("UNITY_PACKAGE_UNREADABLE", `${source} does not exist.`);
  if (info.isDirectory()) {
    const { entries, upm } = await buildFromProject(source);
    return { shape: upm ? "upm" : "project", entries, dispose: async () => {} };
  }
  if (!(await isGzip(source))) {
    throw new UnityPackageError(
      "UNITY_PACKAGE_UNREADABLE",
      `${source} is not a gzip tar. An encrypted Asset Store download cannot be read: use the imported project folder instead.`,
    );
  }
  const members = await listSafeMembers(source);
  const staging = await mkdtemp(join(tmpdir(), "threenative-unity-"));
  const dispose = () => rm(staging, { recursive: true, force: true });
  try {
    await extract(source, staging);
    if (members.includes("package/package.json")) {
      const root = join(staging, "package");
      const entries = new Map<string, UnityAssetEntry>();
      await scanMetaTree(root, `Packages/${await packageName(join(root, "package.json"))}`, entries);
      return { shape: "upm", entries, dispose };
    }
    return { shape: "unitypackage", entries: await buildFromPackage(staging, members), dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
