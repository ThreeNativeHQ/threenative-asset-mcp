import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeIO } from "@gltf-transform/core";
import { afterEach, describe, expect, it } from "vitest";

import { FabCli, FabCliError, preferredPlatform } from "../src/fab/fabcli.js";
import { classifyLicenses } from "../src/fab/license.js";
import {
  createFabImportAssetHandler,
  createFabListOwnedHandler,
  requirePermittedLicense,
} from "../src/tools/import-unreal.js";
import { writeFakeFabCli, writeFakeUmodel, writeMeshFixture } from "./helpers/unreal-fixture.js";

const LISTING = "75f42402-40bb-4a1b-b557-18e2c9604273";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "asset-mcp-fab-"));
  temporaryDirectories.push(directory);
  return directory;
}

const UNREAL_FORMAT = [
  {
    assetFormatType: { code: "unreal-engine" },
    versions: [
      {
        artifactId: "SoulCave418",
        engineVersions: ["UE_4.18", "UE_5.4"],
        targetPlatforms: ["Windows", "Mac"],
      },
    ],
  },
];

interface Harness {
  readonly handler: ReturnType<typeof createFabImportAssetHandler>;
  readonly environment: NodeJS.ProcessEnv;
  readonly outputDir: string;
  readonly argvLog: string;
  readonly root: string;
  invocations(): Promise<string[][]>;
}

async function harness(options: {
  readonly authStatus?: unknown;
  readonly formats?: unknown;
  readonly downloadExitCode?: number;
  readonly downloadStderr?: string;
  readonly requirePlatform?: boolean;
  readonly licenses?: readonly string[];
  readonly licenseError?: boolean;
  readonly library?: unknown;
  readonly umodelClasses?: Readonly<Record<string, readonly string[]>>;
} = {}): Promise<Harness> {
  const root = await temporaryDirectory();

  // What FabCLI "downloads": a minimal Unreal pack.
  const packSource = join(root, "pack-source", "Content", "Game");
  await mkdir(packSource, { recursive: true });
  await writeFile(join(packSource, "SM_Rock.uasset"), "package");

  const exported = join(root, "exported");
  await writeMeshFixture(exported, {
    name: "SM_Rock",
    materialName: "M_Rock",
    mat: "Diffuse=T_Rock_D\nNormal=T_Rock_N\n",
    props: "TwoSided = false\nBlendMode = BLEND_Opaque (0)\n",
    textures: ["T_Rock_D", "T_Rock_N"],
  });

  const umodel = join(root, "umodel");
  await writeFakeUmodel(umodel, {
    exportFrom: exported,
    classes: options.umodelClasses ?? { SM_Rock: ["StaticMesh"] },
    outputSubdirectory: "Game",
  });

  const argvLog = join(root, "fabcli-argv.log");
  await writeFile(argvLog, "");
  const fabcli = join(root, "fabcli");
  await writeFakeFabCli(fabcli, {
    argvLog,
    authStatus: options.authStatus ?? { authenticated: true, expires_at: "2099-01-01T00:00:00Z" },
    formats: options.formats ?? UNREAL_FORMAT,
    downloadInto: join(root, "pack-source"),
    ...(options.library === undefined ? {} : { library: options.library }),
    ...(options.downloadExitCode === undefined
      ? {}
      : { downloadExitCode: options.downloadExitCode }),
    ...(options.downloadStderr === undefined ? {} : { downloadStderr: options.downloadStderr }),
    ...(options.requirePlatform === undefined ? {} : { requirePlatform: options.requirePlatform }),
  });

  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    THREENATIVE_UMODEL_PATH: umodel,
    THREENATIVE_FABCLI_PATH: fabcli,
    THREENATIVE_UNREAL_CACHE_DIR: join(root, "cache"),
    THREENATIVE_FAB_DOWNLOAD_DIR: join(root, "downloads"),
    THREENATIVE_TOOLCHAIN_AUTOINSTALL: "0",
  };

  return {
    root,
    argvLog,
    environment,
    outputDir: join(root, "game", "assets", "fab", LISTING),
    handler: createFabImportAssetHandler({
      environment,
      readLicenses: async () => {
        if (options.licenseError) throw new Error("network down");
        return options.licenses ?? ["personal", "professional"];
      },
    }),
    async invocations() {
      const text = await readFile(argvLog, "utf8");
      return text
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as string[]);
    },
  };
}

function errorOf(result: unknown): { code: string; message: string } {
  const content = (result as { content?: { text?: string }[] }).content?.[0]?.text;
  if (!content) throw new Error(`expected an error result, got ${JSON.stringify(result)}`);
  return JSON.parse(content) as { code: string; message: string };
}

describe("Fab licence gate", () => {
  it("accepts Fab Standard and CC-BY", () => {
    expect(classifyLicenses(["personal", "professional"]).verdict).toBe("allowed");
    expect(classifyLicenses(["cc-by"]).verdict).toBe("allowed");
    expect(classifyLicenses(["CC_BY_4.0"]).verdict).toBe("allowed");
  });

  it("rejects Unreal-Engine-only and legacy entitlements by name", () => {
    const decision = classifyLicenses(["ue-only-non-commercial"]);
    expect(decision.verdict).toBe("rejected");
    expect(decision.reason).toMatch(/Unreal-Engine-only/);
    expect(classifyLicenses(["legacy-marketplace"]).verdict).toBe("rejected");
  });

  it("treats an unknown or absent licence as a refusal, not a warning", () => {
    expect(classifyLicenses([]).verdict).toBe("unverified");
    expect(classifyLicenses(["mystery-terms"]).verdict).toBe("rejected");
  });

  it("fails closed when the licence cannot be read at all", async () => {
    await expect(
      requirePermittedLicense(LISTING, async () => {
        throw new Error("offline");
      }),
    ).rejects.toThrow(/could not be read/);
  });

  it("refuses a non-permitted listing before FabCLI is touched at all", async () => {
    const test = await harness({ licenses: ["ue-only-non-commercial"] });
    const result = await test.handler({
      listingIdOrUrl: LISTING,
      outputDir: test.outputDir,
      acceptFabEula: true,
    });
    expect(errorOf(result).code).toBe("FABCLI_LICENSE_NOT_PERMITTED");
    expect(await test.invocations()).toEqual([]);
    await expect(stat(test.outputDir)).rejects.toThrow();
  });
});

describe("Fab session handling", () => {
  /** A FabCLI whose every subcommand fails with the given message, as a keyring refusal looks. */
  async function fabcliSaying(message: string, exitCode = 0): Promise<FabCli> {
    const path = join(await temporaryDirectory(), "fabcli");
    const payload = JSON.stringify({ error: { kind: "auth_required", message } });
    await writeFile(
      path,
      `#!/usr/bin/env node\nprocess.stdout.write(\`${payload}\` + "\\n");\nprocess.exit(${exitCode});\n`,
    );
    await chmod(path, 0o755);
    return new FabCli({ tool: { name: "fabcli", path, version: "0.1.0" } });
  }

  it("blames the missing session bus, not the session, when the keyring is unreachable", async () => {
    const fabcli = await fabcliSaying("DBus error: could not open the OS keystore");
    const error = await fabcli.authStatus().then(
      () => undefined,
      (thrown: unknown) => thrown as FabCliError,
    );
    expect(error?.code).toBe("FABCLI_KEYSTORE_UNREACHABLE");
    expect(error?.message).toMatch(/DBUS_SESSION_BUS_ADDRESS/);
    expect(error?.message).toMatch(/logging in again will not help/);
  });

  it("blames the same missing session bus when the keyring fails a download", async () => {
    const fabcli = await fabcliSaying("failed to unlock secure storage", 1);
    const error = await fabcli
      .download({ listingId: LISTING, outputDir: await temporaryDirectory(), engine: undefined })
      .then(
        () => undefined,
        (thrown: unknown) => thrown as FabCliError,
      );
    expect(error?.code).toBe("FABCLI_KEYSTORE_UNREACHABLE");
    expect(error?.message).toMatch(/DBUS_SESSION_BUS_ADDRESS/);
  });

  it("still says log in when FabCLI reports a genuinely absent session", async () => {
    const fabcli = await fabcliSaying("no Fab session found; run fabcli auth login");
    const error = await fabcli.authStatus().then(
      () => undefined,
      (thrown: unknown) => thrown as FabCliError,
    );
    expect(error?.code).toBe("FABCLI_UNAUTHENTICATED");
  });

  it("downloads nothing and says what to run when there is no session", async () => {
    const test = await harness({ authStatus: { authenticated: false } });
    const result = await test.handler({
      listingIdOrUrl: LISTING,
      outputDir: test.outputDir,
      acceptFabEula: true,
    });
    const error = errorOf(result);
    expect(error.code).toBe("FABCLI_UNAUTHENTICATED");
    expect(error.message).toMatch(/fabcli auth login/);
    const commands = (await test.invocations()).map((argv) => argv.join(" "));
    expect(commands.some((command) => command.startsWith("download"))).toBe(false);
    await expect(stat(test.outputDir)).rejects.toThrow();
  });

  it("treats an expired session as unusable rather than trying the download", async () => {
    const test = await harness({
      authStatus: { authenticated: true, expires_at: "2000-01-01T00:00:00Z" },
    });
    const result = await test.handler({
      listingIdOrUrl: LISTING,
      outputDir: test.outputDir,
      acceptFabEula: true,
    });
    expect(errorOf(result).code).toBe("FABCLI_SESSION_EXPIRED");
    const commands = (await test.invocations()).map((argv) => argv.join(" "));
    expect(commands.some((command) => command.startsWith("download"))).toBe(false);
  });

  it("does not mistake a missing Fab web session for a missing Epic session", async () => {
    // `fab.session_present: false` blocks claim and ownership, never download.
    const test = await harness({
      authStatus: {
        authenticated: true,
        expires_at: "2099-01-01T00:00:00Z",
        fab: { needs_refresh: true, session_present: false },
      },
    });
    const result = await test.handler({
      listingIdOrUrl: LISTING,
      outputDir: test.outputDir,
      engine: "UE_4.18",
      acceptFabEula: true,
    });
    expect("isError" in result).toBe(false);
  });
});

describe("Fab import safety", () => {
  it("never runs a subcommand outside version, auth status, formats, and download", async () => {
    const test = await harness();
    await test.handler({
      listingIdOrUrl: LISTING,
      outputDir: test.outputDir,
      engine: "UE_4.18",
      acceptFabEula: true,
    });
    const verbs = (await test.invocations()).map((argv) =>
      argv[0] === "auth" ? `${argv[0]} ${argv[1]}` : (argv[0] ?? ""),
    );
    expect(new Set(verbs)).toEqual(new Set(["--version", "auth status", "formats", "download"]));
    expect(verbs).not.toContain("claim");
    expect(verbs).not.toContain("claim-batch");
    expect(verbs).not.toContain("auth login");
    expect(verbs).not.toContain("update");
    expect(FabCli.allowedSubcommands).toEqual([
      "--version",
      "auth status",
      "formats",
      "library",
      "download",
    ]);
  });

  it("refuses an engine selector that is not a UE version instead of passing it through", () => {
    expect(() =>
      FabCli.selectVersion(
        [{ artifactId: "A", engineVersions: ["UE_4.18"], targetPlatforms: [] }],
        "; rm -rf /",
      ),
    ).toThrow(FabCliError);
  });

  it("refuses to guess when a listing publishes several Unreal artifacts", () => {
    expect(() =>
      FabCli.selectVersion(
        [
          { artifactId: "A", engineVersions: ["UE_4.18"], targetPlatforms: [] },
          { artifactId: "B", engineVersions: ["UE_5.4"], targetPlatforms: [] },
        ],
        undefined,
      ),
    ).toThrow(/Pass engine to choose one/);
  });

  it("reports a listing with no Unreal artifact rather than importing nothing", async () => {
    const test = await harness({
      formats: [{ assetFormatType: { code: "gltf" }, versions: [] }],
    });
    const result = await test.handler({
      listingIdOrUrl: LISTING,
      outputDir: test.outputDir,
      acceptFabEula: true,
    });
    expect(errorOf(result).code).toBe("FABCLI_NO_UNREAL_FORMAT");
  });

  it("reads past another engine's format whose versions are null", async () => {
    // fabcli returns `versions: null` on a Unity entry; that used to fail the whole parse.
    const test = await harness({
      formats: [{ assetFormatType: { code: "unity" }, versions: null }, ...UNREAL_FORMAT],
      downloadExitCode: 4,
    });
    const result = await test.handler({
      listingIdOrUrl: LISTING,
      outputDir: test.outputDir,
      engine: "UE_4.18",
      acceptFabEula: true,
    });
    expect(errorOf(result).code).toBe("FABCLI_DOWNLOAD_FAILED");
  });

  it("leaves the game's assets untouched when the download fails", async () => {
    const test = await harness({ downloadExitCode: 4 });
    const existing = join(test.root, "game", "assets", "fab", "existing.glb");
    await mkdir(join(test.root, "game", "assets", "fab"), { recursive: true });
    await writeFile(existing, "already here");

    const result = await test.handler({
      listingIdOrUrl: LISTING,
      outputDir: test.outputDir,
      engine: "UE_4.18",
      acceptFabEula: true,
    });
    expect(errorOf(result).code).toBe("FABCLI_DOWNLOAD_FAILED");
    expect(await readFile(existing, "utf8")).toBe("already here");
    await expect(stat(test.outputDir)).rejects.toThrow();
  });

  it("picks a platform once, reports it, and never retries a caller's explicit choice", async () => {
    const test = await harness({ requirePlatform: true });
    const result = await test.handler({
      listingIdOrUrl: LISTING,
      outputDir: test.outputDir,
      engine: "UE_4.18",
      acceptFabEula: true,
    });
    if ("isError" in result) throw new Error(JSON.stringify(errorOf(result)));
    expect(result.structuredContent.warnings.join(" ")).toMatch(/Windows build/);
    const downloads = (await test.invocations()).filter((argv) => argv[0] === "download");
    expect(downloads).toHaveLength(2);
    expect(downloads[1]).toContain("--platform");
    expect(downloads[1]).toContain("Windows");
    expect(preferredPlatform(["Mac", "Windows"])).toBe("Windows");
    expect(preferredPlatform(["Android"])).toBe("Android");
  });

  it("imports an owned listing end to end and records the entitlement without credentials", async () => {
    const test = await harness();
    const result = await test.handler({
      listingIdOrUrl: `https://www.fab.com/listings/${LISTING}`,
      outputDir: test.outputDir,
      engine: "UE_4.18",
      acceptFabEula: true,
    });
    if ("isError" in result) throw new Error(JSON.stringify(errorOf(result)));
    expect(result.structuredContent.counts.exported).toBe(1);
    expect(result.structuredContent.license).toMatchObject({
      verdict: "allowed",
      slugs: ["personal", "professional"],
    });

    const report = JSON.parse(
      await readFile(join(test.outputDir, "import-report.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(report.entitlement).toMatchObject({
      provider: "fab",
      authenticatedDownload: true,
      acquisition: "none",
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toMatch(/token|cookie|Bearer|password|secret/i);

    // The entitlement travels inside the GLB, where a game's asset health check reads it.
    const models = report.models as { glb: string }[];
    const glb = models[0];
    if (!glb) throw new Error("expected one model");
    const document = await new NodeIO().readBinary(
      new Uint8Array(await readFile(join(test.outputDir, glb.glb))),
    );
    expect(document.getRoot().getAsset().copyright).toMatch(/personal, professional/);
    expect(document.getRoot().getAsset().copyright).toMatch(/threenative-asset-mcp/);
  });

  it("reuses an already-downloaded pack instead of fetching it again", async () => {
    const test = await harness();
    const input = {
      listingIdOrUrl: LISTING,
      engine: "UE_4.18",
      acceptFabEula: true as const,
    };
    await test.handler({ ...input, outputDir: join(test.outputDir, "first") });
    await test.handler({ ...input, outputDir: join(test.outputDir, "second") });
    const downloads = (await test.invocations()).filter((argv) => argv[0] === "download");
    expect(downloads).toHaveLength(1);
  });

  describe("artifactId selection", () => {
    const OVERLAPPING = [
      {
        assetFormatType: { code: "unreal-engine" },
        versions: [
          { artifactId: "PackOld", engineVersions: ["UE_4.18", "UE_5.4"], targetPlatforms: ["Windows"] },
          { artifactId: "PackNew", engineVersions: ["UE_5.0", "UE_5.4"], targetPlatforms: ["Windows"] },
        ],
      },
    ];

    it("imports each of two overlapping artifacts by id, downloading through its oldest engine", async () => {
      const test = await harness({ formats: OVERLAPPING });
      for (const [artifactId, oldest] of [
        ["PackOld", "UE_4.18"],
        ["PackNew", "UE_5.0"],
      ] as const) {
        const result = await test.handler({
          listingIdOrUrl: LISTING,
          outputDir: join(test.outputDir, artifactId),
          artifactId,
          acceptFabEula: true,
        });
        expect("isError" in result).toBe(false);
        const download = (await test.invocations())
          .filter((argv) => argv[0] === "download")
          .find((argv) => argv[argv.indexOf("--output") + 1]?.endsWith(`/${artifactId}`));
        expect(download?.[download.indexOf("--engine") + 1]).toBe(oldest);
      }
    });

    it("lets artifactId win over a disagreeing engine and says so", async () => {
      const test = await harness({ formats: OVERLAPPING });
      const result = await test.handler({
        listingIdOrUrl: LISTING,
        outputDir: test.outputDir,
        artifactId: "PackNew",
        engine: "UE_4.18",
        acceptFabEula: true,
      });
      if ("isError" in result) throw new Error(JSON.stringify(result));
      const report = JSON.parse(
        await readFile(join(test.outputDir, "import-report.json"), "utf8"),
      ) as { warnings: string[] };
      expect(report.warnings.join("\n")).toMatch(/UE_4\.18 is not published by artifact PackNew/);
      const download = (await test.invocations()).find((argv) => argv[0] === "download");
      expect(download?.[download.indexOf("--engine") + 1]).toBe("UE_5.0");
    });

    it("names the available artifacts when the id is absent", async () => {
      const test = await harness({ formats: OVERLAPPING });
      const result = await test.handler({
        listingIdOrUrl: LISTING,
        outputDir: test.outputDir,
        artifactId: "Nope",
        acceptFabEula: true,
      });
      const error = errorOf(result);
      expect(error.code).toBe("FABCLI_ENGINE_AMBIGUOUS");
      expect(error.message).toMatch(/PackOld.*PackNew/);
      expect((await test.invocations()).some((argv) => argv[0] === "download")).toBe(false);
    });
  });
});


const LIBRARY = {
  results: [
    {
      title: "Soul: Cave",
      description: "Soul: Cave",
      url: `https://www.fab.com/listings/${LISTING}`,
      distributionMethod: "ASSET_PACK",
      customAttributes: [{ ListingIdentifier: LISTING }],
      categories: [{ name: "Fantasy" }],
      projectVersions: [
        { artifactId: "SoulCave418", engineVersions: ["UE_4.18"], targetPlatforms: ["Windows"] },
      ],
    },
    {
      title: "Unreal Engine",
      description: "Unreal Engine",
      url: "",
      distributionMethod: "ENGINE",
      customAttributes: [],
      categories: [],
      projectVersions: [],
    },
    {
      title: "Quixel Bridge",
      description: "Quixel Bridge",
      url: "",
      distributionMethod: "CODE_PLUGIN",
      customAttributes: [],
      categories: [{ name: "Unreal Engine" }],
      projectVersions: [
        { artifactId: "Bridge", engineVersions: ["UE_5.4"], targetPlatforms: ["Windows"] },
      ],
    },
  ],
};

describe("listing what the account already owns", () => {
  it("returns owned listings with the UID fab_import_asset takes", async () => {
    const test = await harness({ library: LIBRARY });
    const handler = createFabListOwnedHandler({ environment: test.environment });
    const result = await handler({});
    if ("isError" in result) throw new Error(JSON.stringify(errorOf(result)));
    expect(result.structuredContent.total).toBe(3);
    expect(result.structuredContent.listings[0]).toMatchObject({
      listingId: LISTING,
      title: "Soul: Cave",
      hasUnrealArtifact: true,
      engineVersions: ["UE_4.18"],
    });
  });

  it("drops the engine installs and plugins the importer cannot take", async () => {
    const test = await harness({ library: LIBRARY });
    const handler = createFabListOwnedHandler({ environment: test.environment });
    const result = await handler({ unrealOnly: true });
    if ("isError" in result) throw new Error(JSON.stringify(errorOf(result)));
    expect(result.structuredContent.listings.map((entry) => entry.title)).toEqual(["Soul: Cave"]);
  });

  it("filters by title or category without touching the network again", async () => {
    const test = await harness({ library: LIBRARY });
    const handler = createFabListOwnedHandler({ environment: test.environment });
    const byCategory = await handler({ query: "fantasy" });
    if ("isError" in byCategory) throw new Error(JSON.stringify(errorOf(byCategory)));
    expect(byCategory.structuredContent.total).toBe(1);
    const noMatch = await handler({ query: "spaceship" });
    if ("isError" in noMatch) throw new Error(JSON.stringify(errorOf(noMatch)));
    expect(noMatch.structuredContent.total).toBe(0);
  });

  it("refuses to list anything without a session, and never acquires", async () => {
    const test = await harness({ authStatus: { authenticated: false }, library: LIBRARY });
    const handler = createFabListOwnedHandler({ environment: test.environment });
    const result = await handler({});
    expect(errorOf(result).code).toBe("FABCLI_UNAUTHENTICATED");
    const verbs = (await test.invocations()).map((argv) => argv[0]);
    expect(verbs).not.toContain("library");
    expect(verbs).not.toContain("claim");
  });

  it("does not truncate a library larger than a diagnostic message", async () => {
    // A real library is tens of kilobytes. Clipping stdout to an error-sized slice turned a valid
    // answer into "did not return JSON".
    const many = {
      results: Array.from({ length: 120 }, (_, index) => ({
        title: `Pack ${index} ${"x".repeat(200)}`,
        description: "",
        url: "",
        distributionMethod: "ASSET_PACK",
        customAttributes: [{ ListingIdentifier: LISTING }],
        categories: [],
        projectVersions: [
          { artifactId: `A${index}`, engineVersions: ["UE_5.4"], targetPlatforms: ["Windows"] },
        ],
      })),
    };
    const test = await harness({ library: many });
    const handler = createFabListOwnedHandler({ environment: test.environment });
    const result = await handler({ unrealOnly: true });
    if ("isError" in result) throw new Error(JSON.stringify(errorOf(result)));
    expect(result.structuredContent.total).toBe(120);
  });
});
