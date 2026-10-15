import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { link, mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, onTestFinished, vi } from "vitest";

import { createUnityListPackagesHandler } from "../src/tools/unity-packages.js";
import { assetStoreCacheRoot } from "../src/unity/cache.js";
import { inventoryUnityAssets, UNITY_KINDS } from "../src/unity/inventory.js";
import {
  openUnityPackage,
  UnityPackageError,
  type UnityAssetDatabase,
} from "../src/unity/package.js";
import {
  guidFor,
  logicalFiles,
  scratchDirectory,
  tarWith,
  writePackageTree,
  writeProjectFolder,
  writeUnityPackage,
  writeUpmTarball,
} from "./helpers/unity-fixtures.js";

async function open(source: string): Promise<UnityAssetDatabase> {
  const database = await openUnityPackage(source);
  onTestFinished(() => database.dispose());
  return database;
}

function flat(database: UnityAssetDatabase): Array<[string, string, string]> {
  return [...database.entries.values()]
    .map((entry): [string, string, string] => [entry.guid, entry.path, entry.metaYaml])
    .sort((a, b) => a[0].localeCompare(b[0]));
}

/** Points os.tmpdir() at an owned directory so staging is observable. */
async function ownedTmp(): Promise<string> {
  const work = await scratchDirectory("unity-owned-");
  const tmp = join(work, "tmp");
  await mkdir(tmp);
  vi.stubEnv("TMPDIR", tmp);
  onTestFinished(() => void vi.unstubAllEnvs());
  return work;
}

describe("unity package cache listing", () => {
  it("lists every .unitypackage under ASSETSTORE_CACHE_PATH with publisher, category and name", async () => {
    const cache = await scratchDirectory("unity-cache-");
    for (const relative of ["Pub One/Environments/Pack A.unitypackage", "Pub Two/Tools/Pack B.unitypackage"]) {
      await mkdir(join(cache, relative, ".."), { recursive: true });
      await writeFile(join(cache, relative), "x".repeat(10));
    }
    await writeFile(join(cache, "Pub One", "readme.txt"), "ignored");
    const result = await createUnityListPackagesHandler({ ASSETSTORE_CACHE_PATH: cache })();
    expect(result).not.toHaveProperty("isError");
    const output = (result as { structuredContent: { packages: unknown[]; total: number; cacheExists: boolean } }).structuredContent;
    expect(output).toMatchObject({ total: 2, cacheExists: true });
    expect(output.packages).toMatchObject([
      { publisher: "Pub One", category: "Environments", name: "Pack A", sizeBytes: 10, path: join(cache, "Pub One/Environments/Pack A.unitypackage") },
      { publisher: "Pub Two", category: "Tools", name: "Pack B" },
    ]);
    expect((output.packages[0] as { modifiedAt: string }).modifiedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it("uses the Linux default path without the override and returns an empty list for a missing cache", async () => {
    expect(assetStoreCacheRoot({ environment: {}, platform: "linux", home: "/home/u" })).toBe(
      "/home/u/.local/share/unity3d/Asset Store-5.x",
    );
    expect(assetStoreCacheRoot({ environment: { ASSETSTORE_CACHE_PATH: "/x" }, platform: "linux", home: "/h" })).toBe("/x");
    const work = await scratchDirectory("unity-cache-");
    const result = await createUnityListPackagesHandler({ ASSETSTORE_CACHE_PATH: join(work, "missing") })();
    expect(result).toMatchObject({ structuredContent: { total: 0, packages: [], cacheExists: false } });
  });
});

describe("unity package traversal", () => {
  it.each([
    ["../x", "../x"],
    ["/abs", "/abs"],
    ["C:\\x", "C:\\x"],
    ["Assets/ok/../../x", "Assets/ok/../../x"],
  ])("refuses pathname %s, names it, and writes nothing outside staging", async (pathname) => {
    const work = await ownedTmp();
    const archive = join(work, "p.unitypackage");
    const files = [{ path: "Assets/a.txt", content: "a" }];
    // Pack with the hostile pathname written into the member.
    const staging = await scratchDirectory("unity-stage-", work);
    await writePackageTree(staging, files, () => pathname);
    tarWith(archive, staging, [guidFor("Assets/a.txt")]);
    const error = await openUnityPackage(archive).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UnityPackageError);
    expect((error as UnityPackageError).code).toBe("UNITY_PACKAGE_UNSAFE_ENTRY");
    expect((error as UnityPackageError).message).toContain(JSON.stringify(pathname));
    // Staging is gone and nothing else was created beside it.
    expect(await readdir(join(work, "tmp"))).toEqual([]);
    expect(existsSync(join(work, "x"))).toBe(false);
  });

  it("refuses symlink and hardlink members and names the entry", async () => {
    const work = await ownedTmp();
    const staging = await scratchDirectory("unity-stage-", work);
    const guid = guidFor("Assets/a.txt");
    await writePackageTree(staging, [{ path: "Assets/a.txt", content: "a" }]);
    await symlink("/etc/passwd", join(staging, guid, "preview.png"));
    const symlinked = join(work, "symlink.unitypackage");
    tarWith(symlinked, staging, [guid]);
    await expect(openUnityPackage(symlinked)).rejects.toThrow(`symlink member: "${guid}/preview.png"`);

    const hardStaging = await scratchDirectory("unity-stage-", work);
    await writePackageTree(hardStaging, [{ path: "Assets/a.txt", content: "a" }]);
    await link(join(hardStaging, guid, "asset"), join(hardStaging, guid, "preview.png"));
    const hardlinked = join(work, "hardlink.unitypackage");
    tarWith(hardlinked, hardStaging, [`${guid}/asset`, `${guid}/preview.png`, `${guid}/asset.meta`, `${guid}/pathname`]);
    await expect(openUnityPackage(hardlinked)).rejects.toThrow(/hardlink member/);
    expect(await readdir(join(work, "tmp"))).toEqual([]);
  });

  it("refuses archive member names that are absolute or climb out", async () => {
    const work = await ownedTmp();
    const source = await scratchDirectory("unity-stage-", work);
    await writeFile(join(source, "payload"), "x");
    for (const [name, member] of [
      ["dotdot", "../escape"],
      ["absolute", "/abs/escape"],
    ] as const) {
      const archive = join(work, `${name}.unitypackage`);
      tarWith(archive, source, ["payload"], ["--transform", `s,^payload$,${member},`]);
      await expect(openUnityPackage(archive)).rejects.toThrow(JSON.stringify(member));
    }
    expect(existsSync(join(work, "escape"))).toBe(false);
    expect(existsSync("/abs/escape")).toBe(false);
    expect(await readdir(join(work, "tmp"))).toEqual([]);
  });

  it("refuses a symlink inside a project folder and reports a non-gzip file as possibly encrypted", async () => {
    const work = await scratchDirectory();
    await writeProjectFolder(work, [{ path: "Assets/a.txt", content: "a" }]);
    await symlink("/etc/passwd", join(work, "Assets", "leak.txt"));
    await expect(openUnityPackage(work)).rejects.toThrow(/symlink in project: "Assets\/leak\.txt"/);

    const encrypted = join(work, "enc.unitypackage");
    await writeFile(encrypted, Buffer.from("not a gzip tar, maybe encrypted"));
    await expect(openUnityPackage(encrypted)).rejects.toThrow(/not a gzip tar.*encrypted/);
  });

  it("refuses an archive over the member or declared-size limit before it extracts anything", async () => {
    const work = await ownedTmp();
    const archive = join(work, "p.unitypackage");
    const staging = await scratchDirectory("unity-stage-", work);
    tarWith(archive, staging, await writePackageTree(staging, [{ path: "Assets/a.txt", content: "a".repeat(100) }]));
    await expect(openUnityPackage(archive, { maxMembers: 3 })).rejects.toMatchObject({ code: "UNITY_PACKAGE_TOO_LARGE", message: expect.stringMatching(/members, more than the limit of 3/) });
    await expect(openUnityPackage(archive, { maxBytes: 99 })).rejects.toMatchObject({ code: "UNITY_PACKAGE_TOO_LARGE", message: expect.stringMatching(/uncompressed bytes, more than the limit of 99/) });
    expect(await readdir(join(work, "tmp"))).toEqual([]);
    const database = await open(archive);
    expect(database.entries.size).toBe(1);
  });

  it("opens a package whose members are stored with mode 000, and cleans staging up on success and on failure", async () => {
    const work = await ownedTmp();
    const staging = await scratchDirectory("unity-stage-", work);
    const files = [{ path: "Assets/a.txt", content: "a" }];
    const archive = join(work, "p.unitypackage");
    tarWith(archive, staging, await writePackageTree(staging, files), ["--mode=a-rwx"]);
    const database = await openUnityPackage(archive);
    expect(readFileSync([...database.entries.values()][0]?.assetFile ?? "", "utf8")).toBe("a");
    await database.dispose();
    expect(await readdir(join(work, "tmp"))).toEqual([]);

    const hostile = await scratchDirectory("unity-stage-", work);
    const hostileArchive = join(work, "h.unitypackage");
    tarWith(hostileArchive, hostile, await writePackageTree(hostile, files, () => "../x"), ["--mode=a-rwx"]);
    await expect(openUnityPackage(hostileArchive)).rejects.toMatchObject({ code: "UNITY_PACKAGE_UNSAFE_ENTRY" });
    expect(await readdir(join(work, "tmp"))).toEqual([]);
  });

  it("removes the staging directory on dispose", async () => {
    const work = await ownedTmp();
    const archive = join(work, "p.unitypackage");
    const staging = await scratchDirectory("unity-stage-", work);
    tarWith(archive, staging, await writePackageTree(staging, [{ path: "Assets/a.txt", content: "a" }]));
    const database = await openUnityPackage(archive);
    expect((await readdir(join(work, "tmp"))).length).toBe(1);
    expect(readFileSync([...database.entries.values()][0]?.assetFile ?? "", "utf8")).toBe("a");
    await database.dispose();
    await database.dispose();
    expect(await readdir(join(work, "tmp"))).toEqual([]);
  });
});

describe("unity package shapes", () => {
  it("builds equal databases from a .unitypackage and a project folder (Assets)", async () => {
    const work = await scratchDirectory();
    const files = logicalFiles("Assets/Pack");
    await writeUnityPackage(join(work, "p.unitypackage"), files);
    await writeProjectFolder(join(work, "project"), files);
    const fromPackage = await open(join(work, "p.unitypackage"));
    const fromProject = await open(join(work, "project"));
    expect(fromPackage.shape).toBe("unitypackage");
    expect(fromProject.shape).toBe("project");
    expect(flat(fromPackage)).toHaveLength(files.length);
    expect(flat(fromPackage)).toEqual(flat(fromProject));
    const crate = fromPackage.entries.get(guidFor("Assets/Pack/Models/crate.fbx"));
    expect(crate?.path).toBe("Assets/Pack/Models/crate.fbx");
    expect(readFileSync(crate?.assetFile ?? "", "utf8")).toBe("fake fbx bytes");
    expect(fromPackage.entries.get(guidFor("Assets/Pack/Textures/crate_albedo.png"))?.previewFile).toBeDefined();
    expect(fromPackage.entries.get(guidFor("Assets/Pack/Models"))?.assetFile).toBeUndefined();
  });

  it("builds equal databases from a .unitypackage, a UPM tarball and a project folder (Packages)", async () => {
    const work = await scratchDirectory();
    const name = "com.test.pack";
    const files = [
      { path: `Packages/${name}/package.json`, content: JSON.stringify({ name }) },
      ...logicalFiles(`Packages/${name}`),
    ];
    await writeUnityPackage(join(work, "p.unitypackage"), files);
    await writeUpmTarball(join(work, "p.tgz"), name, files);
    await writeProjectFolder(join(work, "project"), files);
    // A UPM package folder (package.json at its root) is the unpacked tarball.
    await writeUpmTarball(join(work, "again.tgz"), name, files);
    execFileSync("tar", ["xzf", join(work, "again.tgz"), "-C", work]);
    const upmFolder = join(work, "package");

    const fromPackage = await open(join(work, "p.unitypackage"));
    const fromTarball = await open(join(work, "p.tgz"));
    const fromProject = await open(join(work, "project"));
    const fromFolder = await open(upmFolder);
    expect(fromTarball.shape).toBe("upm");
    expect(fromFolder.shape).toBe("upm");
    expect(flat(fromPackage)).toHaveLength(files.length);
    expect(flat(fromTarball)).toEqual(flat(fromPackage));
    expect(flat(fromProject)).toEqual(flat(fromPackage));
    expect(flat(fromFolder)).toEqual(flat(fromPackage));
  });
});

describe("unity package inventory", () => {
  it("counts assets per kind and previews, ignoring folders", async () => {
    const work = await scratchDirectory();
    await writeUnityPackage(join(work, "p.unitypackage"), logicalFiles("Assets/Pack"));
    const counts = inventoryUnityAssets(await open(join(work, "p.unitypackage")));
    expect(counts).toEqual({
      model: 1,
      texture: 1,
      material: 1,
      prefab: 1,
      shaderGraph: 1,
      scene: 1,
      other: 1,
      previews: 1,
    });
  });

  it("records a corpus without asset names and treats a missing or empty corpus as nothing to do", async () => {
    const work = await scratchDirectory();
    await mkdir(join(work, "tsx-cache"));
    await mkdir(join(work, "corpus", "U1"), { recursive: true });
    await writeUnityPackage(join(work, "corpus", "U1", "pack.unitypackage"), logicalFiles("Assets/SecretName"));
    const run = (corpus: string, record: string) =>
      execFileSync(
        process.execPath,
        ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href, "scripts/unity-inventory.ts", "--corpus", corpus, "--record"],
        { encoding: "utf8", env: { ...process.env, TMPDIR: join(work, "tsx-cache"), UNITY_CORPUS_RECORD: record } },
      );
    expect(run(join(work, "missing"), join(work, "none.json"))).toMatch(/No corpus packs found/);
    expect(run(join(work, "corpus-empty"), join(work, "none.json"))).toMatch(/No corpus packs found/);
    expect(existsSync(join(work, "none.json"))).toBe(false);

    run(join(work, "corpus"), join(work, "record.json"));
    const text = readFileSync(join(work, "record.json"), "utf8");
    expect(text).not.toContain("SecretName");
    expect(text).not.toContain("crate");
    expect(JSON.parse(text)).toMatchObject({
      version: 1,
      packs: [{ id: "U1", listingUid: "fbc35597-dbcf-4da8-bb29-4fdbf203c46e", pipelines: ["Built-in"], yamlFailures: 0, counts: { model: 1, texture: 1, previews: 1 } }],
    });
    expect(JSON.parse(text).packs[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("has a ledger row for every inventory kind", () => {
    const ledger = readFileSync(new URL("../docs/unity-format-support.md", import.meta.url), "utf8");
    expect(ledger).toMatch(/^Last audited: 2026-10-15/m);
    const labels: Record<(typeof UNITY_KINDS)[number], string> = {
      model: "Model",
      texture: "Texture",
      material: "Material",
      prefab: "Prefab",
      shaderGraph: "Shader Graph",
      scene: "Scene",
      other: "Other",
    };
    for (const kind of UNITY_KINDS) expect(ledger, kind).toMatch(new RegExp(`^\\| ${labels[kind]} `, "m"));
  });
});
