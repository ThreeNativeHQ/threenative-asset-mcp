import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FabCli } from "../src/fab/fabcli.js";
import { createFabImportAssetHandler, createFabListOwnedHandler } from "../src/tools/import-unreal.js";
import { UnityImportError } from "../src/unity/errors.js";
import type { UnityImportReport, importUnityPackage } from "../src/unity/importer.js";
import { ImportError } from "../src/unreal/errors.js";
import type { importUnrealDirectory } from "../src/unreal/importer.js";
import { writeFakeFabCli } from "./helpers/unreal-fixture.js";

// Synthetic UIDs and titles. The FabCLI shapes follow the probe of 2026-10-14 (`versions: null` on
// the unity entry, Unreal-only projectVersions in the library); no licensed name appears here.
const UNITY_ONLY = "11111111-aaaa-4bbb-8ccc-000000000001";
const BOTH = "22222222-aaaa-4bbb-8ccc-000000000002";
const UNREAL_ONLY = "33333333-aaaa-4bbb-8ccc-000000000003";
const UNITY_ARTIFACT = "UnityArtifact1";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "asset-mcp-fab-unity-"));
  temporaryDirectories.push(directory);
  return directory;
}

const UNREAL_ENTRY = {
  assetFormatType: { code: "unreal-engine" },
  versions: [{ artifactId: "UnrealArtifact1", engineVersions: ["UE_5.4"], targetPlatforms: ["Windows"] }],
};
const UNITY_ENTRY = {
  assetFormatType: { code: "unity" },
  extensions: ["unitypackage"],
  versions: null,
  renderPipelines: ["Built-in", "URP"],
  unityAssetStoreUrl: "https://assetstore.unity.com/packages/example",
  isInUnityAssetStore: true,
};
const UNITY_ENTRY_WITH_ID = { ...UNITY_ENTRY, versions: [{ artifactId: UNITY_ARTIFACT }] };

function owned(listingId: string, title: string, extra: Record<string, unknown> = {}) {
  return {
    title,
    description: "",
    url: "",
    distributionMethod: "ASSET_PACK",
    customAttributes: [{ ListingIdentifier: listingId }],
    categories: [],
    projectVersions: [] as unknown[],
    ...extra,
  };
}

const LIBRARY = {
  results: [
    owned(UNITY_ONLY, "Synthetic Unity Only", { assetId: "asset-u", assetNamespace: "ns-u" }),
    owned(BOTH, "Synthetic Both Formats", {
      assetId: "asset-b",
      assetNamespace: "ns-b",
      projectVersions: [
        { artifactId: "UnrealArtifact1", engineVersions: ["UE_5.4"], targetPlatforms: ["Windows"] },
      ],
    }),
    owned(UNREAL_ONLY, "Synthetic Unreal Only", {
      projectVersions: [
        { artifactId: "UnrealArtifact2", engineVersions: ["UE_5.1"], targetPlatforms: ["Windows"] },
      ],
    }),
  ],
};

interface Harness {
  readonly environment: NodeJS.ProcessEnv;
  readonly root: string;
  readonly outputDir: string;
  readonly unityCalls: Parameters<typeof importUnityPackage>[0][];
  readonly unrealCalls: Parameters<typeof importUnrealDirectory>[0][];
  readonly list: ReturnType<typeof createFabListOwnedHandler>;
  readonly importAsset: ReturnType<typeof createFabImportAssetHandler>;
  invocations(): Promise<string[][]>;
}

const REPORT: UnityImportReport = {
  importerVersion: 2,
  source: { shape: "unitypackage", name: "Pack" },
  blender: { version: "4.2.0", origin: "path" },
  materials: "complete",
  counts: { models: 0, prefabs: 0, materials: 0, textures: 0, fallbackMaterials: 0, boundSlots: 0, skipped: 0, failed: 0 },
  licenseFiles: [],
  models: [],
  prefabs: [],
  materialAssets: [],
  textures: [],
  skipped: [],
  failed: [],
  warnings: ["from the importer"],
  durationMs: 1,
} as unknown as UnityImportReport;

async function harness(
  options: {
    readonly formatsByListing?: Record<string, unknown>;
    readonly library?: unknown;
    /** Files FabCLI "downloads" for the Unity artifact, relative to the download directory. */
    readonly unityFiles?: readonly string[];
    readonly licenses?: readonly string[];
    readonly unityImportError?: Error;
  } = {},
): Promise<Harness> {
  const root = await temporaryDirectory();
  const unityPack = join(root, "unity-pack");
  for (const file of options.unityFiles ?? ["Pack/Synthetic.unitypackage"]) {
    await mkdir(join(unityPack, file, ".."), { recursive: true });
    await writeFile(join(unityPack, file), "not a real package");
  }
  const argvLog = join(root, "argv.log");
  await writeFile(argvLog, "");
  const fabcli = join(root, "fabcli");
  await writeFakeFabCli(fabcli, {
    argvLog,
    authStatus: { authenticated: true, expires_at: "2099-01-01T00:00:00Z" },
    formatsByListing: options.formatsByListing ?? {
      [UNITY_ONLY]: [UNITY_ENTRY_WITH_ID],
      [BOTH]: [UNREAL_ENTRY, UNITY_ENTRY_WITH_ID],
      [UNREAL_ONLY]: [UNREAL_ENTRY],
    },
    library: options.library ?? LIBRARY,
    catalog: [
      { artifactId: UNITY_ARTIFACT, engineVersions: [], dir: unityPack },
      { artifactId: "UnrealArtifact1", engineVersions: ["UE_5.4"], dir: join(root, "unreal-pack") },
    ],
  });
  await mkdir(join(root, "unreal-pack", "Content"), { recursive: true });
  await writeFile(join(root, "unreal-pack", "Content", "SM_Thing.uasset"), "package");

  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    THREENATIVE_FABCLI_PATH: fabcli,
    THREENATIVE_FAB_DOWNLOAD_DIR: join(root, "downloads"),
    THREENATIVE_TOOLCHAIN_AUTOINSTALL: "0",
  };
  const unityCalls: Harness["unityCalls"] = [];
  const unrealCalls: Harness["unrealCalls"] = [];
  return {
    root,
    environment,
    outputDir: join(root, "game", "assets"),
    unityCalls,
    unrealCalls,
    list: createFabListOwnedHandler({ environment }),
    importAsset: createFabImportAssetHandler({
      environment,
      readLicenses: async () => options.licenses ?? ["personal", "professional"],
      importUnity: async (request) => {
        unityCalls.push(request);
        if (options.unityImportError) throw options.unityImportError;
        return REPORT;
      },
      importDirectory: async (request) => {
        unrealCalls.push(request);
        throw new ImportError("UNREAL_SOURCE_EMPTY", "stopped after recording the Unreal call");
      },
    }),
    async invocations() {
      return (await readFile(argvLog, "utf8"))
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as string[]);
    },
  };
}

function errorOf(result: unknown): { code: string; message: string } {
  const text = (result as { content?: { text?: string }[] }).content?.[0]?.text;
  if (!text || !(result as { isError?: boolean }).isError) {
    throw new Error(`expected an error result, got ${JSON.stringify(result)}`);
  }
  return JSON.parse(text) as { code: string; message: string };
}

function okOf(result: object) {
  if ("isError" in result) throw new Error(JSON.stringify(errorOf(result)));
  return (result as unknown as { structuredContent: Record<string, any> }).structuredContent;
}

describe("fab_list_owned with Unity-format artifacts", () => {
  it("reports a Unity artifact with route unity, beside the Unreal ones", async () => {
    const test = await harness();
    const { listings, total } = okOf(await test.list({}));
    expect(total).toBe(3);
    const byId = Object.fromEntries(listings.map((listing: any) => [listing.listingId, listing]));

    expect(byId[UNITY_ONLY]).toMatchObject({ hasUnrealArtifact: false, hasUnityArtifact: true });
    expect(byId[UNITY_ONLY].artifacts).toEqual([
      {
        artifactId: UNITY_ARTIFACT,
        engineVersions: [],
        route: "unity",
        targetPlatforms: [],
        unity: {
          extensions: ["unitypackage"],
          renderPipelines: ["Built-in", "URP"],
          unityAssetStoreUrl: "https://assetstore.unity.com/packages/example",
          isInUnityAssetStore: true,
        },
      },
    ]);
    expect(byId[BOTH]).toMatchObject({ hasUnrealArtifact: true, hasUnityArtifact: true });
    expect(byId[BOTH].artifacts.map((artifact: any) => artifact.route)).toEqual(["cue4parse", "unity"]);
    expect(byId[UNREAL_ONLY]).toMatchObject({ hasUnrealArtifact: true, hasUnityArtifact: false });
  });

  it("names the artifact unity when FabCLI lists no id (versions: null, as probed)", async () => {
    const test = await harness({ formatsByListing: { [UNITY_ONLY]: [UNITY_ENTRY] } });
    const { listings } = okOf(await test.list({ query: "unity only" }));
    expect(listings).toHaveLength(1);
    expect(listings[0].artifacts[0]).toMatchObject({ artifactId: "unity", route: "unity" });
  });

  it("unrealOnly hides Unity artifacts and never looks them up", async () => {
    const test = await harness();
    const { listings } = okOf(await test.list({ unrealOnly: true }));
    expect(listings.map((listing: any) => listing.listingId)).toEqual([BOTH, UNREAL_ONLY]);
    for (const listing of listings) {
      expect(listing.hasUnityArtifact).toBe(false);
      expect(listing.artifacts.map((artifact: any) => artifact.route)).not.toContain("unity");
    }
    expect((await test.invocations()).filter((argv) => argv[0] === "formats")).toEqual([]);
  });

  it("keeps listing when one formats lookup fails, and says so", async () => {
    const test = await harness({
      formatsByListing: {
        [UNITY_ONLY]: { error: { kind: "generic", message: "boom" } },
        [BOTH]: [UNREAL_ENTRY, UNITY_ENTRY_WITH_ID],
        [UNREAL_ONLY]: [UNREAL_ENTRY],
      },
    });
    const output = okOf(await test.list({}));
    expect(output.total).toBe(3);
    expect(output.warnings).toHaveLength(1);
    expect(output.warnings[0]).toContain(UNITY_ONLY);
    const both = output.listings.find((listing: any) => listing.listingId === BOTH);
    expect(both.hasUnityArtifact).toBe(true);
  });
});

describe("FabCli.formats", () => {
  it("parses the unity entry beside a well-formed Unreal one, and never fails Unreal on it", async () => {
    const test = await harness({ formatsByListing: { [BOTH]: [UNITY_ENTRY, UNREAL_ENTRY] } });
    const cli = new FabCli({ environment: test.environment });
    const formats = await cli.formats(BOTH);
    expect(formats.unreal.map((version) => version.artifactId)).toEqual(["UnrealArtifact1"]);
    expect(formats.unity).toMatchObject({ artifactId: undefined, extensions: ["unitypackage"] });
    expect(await cli.unrealVersions(BOTH)).toHaveLength(1);
  });
});

describe("fab_import_asset Unity route (import)", () => {
  it("import: downloads the named Unity artifact into the fab-downloads cache and calls the Unity importer", async () => {
    const test = await harness();
    const output = okOf(
      await test.importAsset({
        listingIdOrUrl: UNITY_ONLY,
        outputDir: test.outputDir,
        format: "unity",
        packages: ["crate"],
        acceptFabEula: true,
      }),
    );

    const download = (await test.invocations()).find((argv) => argv[0] === "download");
    // All three catalog ids name the artifact; the listing-only form would fetch the Unreal pack.
    expect(download).toEqual([
      "download",
      "--artifact-id",
      UNITY_ARTIFACT,
      "--namespace",
      "ns-u",
      "--asset-id",
      "asset-u",
      "--output",
      join(test.root, "downloads", UNITY_ONLY, UNITY_ARTIFACT),
    ]);
    expect(test.unityCalls).toHaveLength(1);
    expect(test.unityCalls[0]).toMatchObject({
      source: join(test.root, "downloads", UNITY_ONLY, UNITY_ARTIFACT, "Pack", "Synthetic.unitypackage"),
      outputDir: test.outputDir,
      assets: ["crate"],
    });
    expect(test.unrealCalls).toEqual([]);
    expect(output.importerVersion).toBe(2);
    expect(output.warnings[0]).toMatch(/Licence check/);
    expect(output.warnings).toContain("from the importer");
  });

  it("import: a listing that publishes only Unity takes the Unity route without a format", async () => {
    const test = await harness();
    okOf(await test.importAsset({ listingIdOrUrl: UNITY_ONLY, outputDir: test.outputDir, acceptFabEula: true }));
    expect(test.unityCalls).toHaveLength(1);
    expect(test.unrealCalls).toEqual([]);
  });

  it("import: reuses the cached download on a second call", async () => {
    const test = await harness();
    const request = { listingIdOrUrl: UNITY_ONLY, outputDir: test.outputDir, format: "unity" as const, acceptFabEula: true as const };
    okOf(await test.importAsset(request));
    okOf(await test.importAsset(request));
    expect((await test.invocations()).filter((argv) => argv[0] === "download")).toHaveLength(1);
    expect(test.unityCalls).toHaveLength(2);
  });

  it("import: a listing with both formats still takes the Unreal route unless asked", async () => {
    const test = await harness();
    const result = await test.importAsset({ listingIdOrUrl: BOTH, outputDir: test.outputDir, engine: "UE_5.4", acceptFabEula: true });
    expect(errorOf(result).code).toBe("UNREAL_SOURCE_EMPTY");
    expect(test.unrealCalls).toHaveLength(1);
    expect(test.unrealCalls[0]?.sourceDir).toBe(join(test.root, "downloads", BOTH, "UnrealArtifact1"));
    expect(test.unityCalls).toEqual([]);
    const download = (await test.invocations()).find((argv) => argv[0] === "download");
    expect(download).not.toContain(UNITY_ARTIFACT);

    // Asking for Unity on the same listing is what switches the route.
    okOf(await test.importAsset({ listingIdOrUrl: BOTH, outputDir: test.outputDir, format: "unity", acceptFabEula: true }));
    expect(test.unityCalls).toHaveLength(1);
  });

  it("import: format unity on a listing with no Unity artifact is refused before any download", async () => {
    const test = await harness();
    const result = await test.importAsset({ listingIdOrUrl: UNREAL_ONLY, outputDir: test.outputDir, format: "unity", acceptFabEula: true });
    expect(errorOf(result).code).toBe("FABCLI_NO_UNITY_FORMAT");
    expect((await test.invocations()).some((argv) => argv[0] === "download")).toBe(false);
  });

  it("import: without catalog coordinates it stops with the two ways forward and downloads nothing", async () => {
    // The probe shape: versions null, so FabCLI names no Unity artifact.
    const test = await harness({ formatsByListing: { [UNITY_ONLY]: [UNITY_ENTRY] } });
    const result = await test.importAsset({ listingIdOrUrl: UNITY_ONLY, outputDir: test.outputDir, format: "unity", acceptFabEula: true });
    const error = errorOf(result);
    expect(error.code).toBe("FABCLI_UNITY_DOWNLOAD_UNAVAILABLE");
    expect(error.message).toContain("asset_import_unity");
    expect(error.message).toContain("fabcli auth login");
    expect(error.message).toContain("fab.com");
    expect((await test.invocations()).some((argv) => argv[0] === "download")).toBe(false);
    expect(test.unityCalls).toEqual([]);
    await expect(stat(test.outputDir)).rejects.toThrow();
    await expect(stat(join(test.root, "downloads"))).rejects.toThrow();
  });

  it("import: a library without the listing's asset id is the same refusal", async () => {
    const library = { results: [owned(UNITY_ONLY, "Synthetic Unity Only")] };
    const test = await harness({ library, formatsByListing: { [UNITY_ONLY]: [UNITY_ENTRY_WITH_ID] } });
    const result = await test.importAsset({ listingIdOrUrl: UNITY_ONLY, outputDir: test.outputDir, acceptFabEula: true });
    expect(errorOf(result).code).toBe("FABCLI_UNITY_DOWNLOAD_UNAVAILABLE");
    expect((await test.invocations()).some((argv) => argv[0] === "download")).toBe(false);
  });

  it("import: the Fab licence gate runs before the Unity route touches FabCLI", async () => {
    const test = await harness({ licenses: ["ue-only-non-commercial"] });
    const result = await test.importAsset({ listingIdOrUrl: UNITY_ONLY, outputDir: test.outputDir, format: "unity", acceptFabEula: true });
    expect(errorOf(result).code).toBe("FABCLI_LICENSE_NOT_PERMITTED");
    expect(await test.invocations()).toEqual([]);
  });

  it("import: refuses an artifact id the listing does not publish", async () => {
    const test = await harness();
    const result = await test.importAsset({ listingIdOrUrl: UNITY_ONLY, outputDir: test.outputDir, format: "unity", artifactId: "Other", acceptFabEula: true });
    expect(errorOf(result).code).toBe("FABCLI_ENGINE_AMBIGUOUS");
    expect((await test.invocations()).some((argv) => argv[0] === "download")).toBe(false);
  });

  it("import: a download without a .unitypackage, or with two, is reported and nothing is imported", async () => {
    const none = await harness({ unityFiles: ["readme.txt"] });
    const noneResult = await none.importAsset({ listingIdOrUrl: UNITY_ONLY, outputDir: none.outputDir, acceptFabEula: true });
    expect(errorOf(noneResult).message).toMatch(/no \.unitypackage/);

    const two = await harness({ unityFiles: ["A.unitypackage", "sub/B.unitypackage"] });
    const twoResult = await two.importAsset({ listingIdOrUrl: UNITY_ONLY, outputDir: two.outputDir, acceptFabEula: true });
    expect(errorOf(twoResult).message).toMatch(/2 \.unitypackage files/);
    expect(none.unityCalls.concat(two.unityCalls)).toEqual([]);
  });

  it("import: keeps the Unity importer's own error code", async () => {
    const test = await harness({
      unityImportError: new UnityImportError("UNITY_BLENDER_NOT_FOUND", "no Blender"),
    });
    const result = await test.importAsset({ listingIdOrUrl: UNITY_ONLY, outputDir: test.outputDir, acceptFabEula: true });
    expect(errorOf(result)).toMatchObject({ code: "UNITY_BLENDER_NOT_FOUND", message: "no Blender" });
  });

  it("import: runs only the allowed FabCLI subcommands", async () => {
    const test = await harness();
    okOf(await test.importAsset({ listingIdOrUrl: UNITY_ONLY, outputDir: test.outputDir, acceptFabEula: true }));
    const verbs = new Set((await test.invocations()).map((argv) => (argv[0] === "auth" ? "auth status" : argv[0])));
    expect(verbs).toEqual(new Set(["--version", "auth status", "formats", "library", "download"]));
  });
});
